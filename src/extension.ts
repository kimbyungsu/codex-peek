import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";

const HOME = os.homedir();
// 자체 namespace 폴더. CODEX_BRIDGE_HOME으로 override(확장 호스트≠훅 home 환경 대비 — 브릿지·훅과 동일 규칙).
// ★확장의 모든 자체파일 경로는 이 BRIDGE_DIR 한 곳에서만 파생(override 누락 방지).
const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(HOME, ".codex-bridge");
// V11: codex가 실제 쓰는 home. env → 확장이 'codex doctor'로 적어둔 codex-home.txt → ~/.codex 폴백.
// (syncCodexHome이 활성화 때 갱신하므로 let)
const PINNED_HOME = readTextSafe(path.join(BRIDGE_DIR, "codex-home.txt"));
let CODEX_HOME = process.env.CODEX_HOME || (PINNED_HOME && fs.existsSync(PINNED_HOME) ? PINNED_HOME : "") || path.join(HOME, ".codex");
let SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const LINKS_FILE = path.join(BRIDGE_DIR, "links.json");
const CONTRACT_FILE = path.join(BRIDGE_DIR, "contract.json"); // 전역 기본값(상속 시드)
const CONTRACTS_DIR = path.join(BRIDGE_DIR, "contracts"); // 프로젝트별 계약
const INTEGRITY_FILE = path.join(BRIDGE_DIR, "integrity.json"); // 무결성 신호(브릿지 기록 → 상태바 빨강·대시보드로 가시화)
const PHASE_FILE = path.join(BRIDGE_DIR, "phase.json"); // 검증 파이프라인 라이브 단계(훅/브릿지 기록 → 상태바·진행 스트립)
const PHASE_STALE_MS = 15 * 60 * 1000; // 이보다 오래된 phase는 '대기'로 — 코덱스 ask 최대 8분 + 여유
// 원자적 저장: 임시파일에 쓴 뒤 rename으로만 교체 → 읽는 쪽은 옛/새 파일만 보고 반쪽(손상) 파일은 못 본다
// (다중 창 동시쓰기 손상 방지). ⚠ 직접쓰기 폴백 금지 — Windows에선 대상이 동시 읽기로 잠깐 열려 있으면 rename이
// 실패하는데, 그때 직접쓰기로 폴백하면 그게 반쪽파일 손상의 원인이 된다(검증 확인). rename 짧게 재시도, 끝내
// 실패하면 옛 파일(valid) 유지하고 포기(손상 0 우선). 브릿지 contract-lib.atomicWrite와 동일 규칙.
function atomicWrite(file: string, data: string): boolean {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    for (let i = 0; i < 12; i++) {
      try { fs.renameSync(tmp, file); return true; } catch {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* sync backoff best-effort */ }
      }
    }
  } catch { /* mkdir/tmp 쓰기 실패(권한·디스크 등) */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  try { console.error(`[codex-bridge] atomicWrite: 저장 실패(손상 방지로 옛 파일 유지): ${file}`); } catch { /* ignore */ }
  return false;
}
// 프로젝트별 계약 파일. 키=normWs의 sha1 앞16자 — bridge/contract-lib.js의 contractFileFor와 반드시 동일 규칙.
function contractFileFor(ws: string): string {
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  return path.join(CONTRACTS_DIR, key + ".json");
}
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

interface Turn {
  user: string | null;
  assistant: string[];
  verdict?: "pass" | "pass-notes" | "fail" | "inconclusive" | null; // 호스트에서 extractVerdict로 계산(대시보드 표시용)
}
interface Candidate {
  id: string;
  when: string;
  snippet: string;
  linked: boolean;
}
interface BridgeState {
  workspace: string | null;
  linkedId: string | null;
  linkedSnippet: string;
  linkedAt: string | null;
  lastActivity: string | null;
  turns: Turn[];
  candidates: Candidate[];
  hiddenCandidates: Candidate[];
  contract: Contract;
  baseDirective: { verifyBaseline: string; transmit: string; rejudge: string; overridden: boolean };
  baseAvailable: boolean;
  permissionMode: string;
  codexReady: boolean;
  onboardDismissed: boolean;
  modelCurrent: string;   // 연결 세션 rollout 마지막 turn_context의 모델 (보기)
  effortCurrent: string;  // 〃 생각강도 코드(low/medium/high)
  modelPref: string;      // 저장된 선택 모델 ("" = 코덱스 기본값)
  reasoningPref: string;  // 저장된 선택 생각강도 ("" = 기본)
  knownModels: string[];  // 이 세션이 써본 모델들(캐시 없을 때 폴백 추천)
  availModels: AvailModel[]; // 계정 캐시(models_cache.json)의 모델·모델별 생각강도 — 하드코딩 대신 계정 실제 목록
  modelsCacheNote: string;   // 계정 캐시 못 읽을 때 사용자에게 보여줄 이유("" = 정상)
  integrity: IntegrityEvent[]; // 무결성 신호(검증 미완 등) — 미확인 error는 상태바 빨강 + 대시보드 경보
  live: LiveStage | null;      // 검증 파이프라인 라이브 단계(없으면 대기) — 상태바·진행 스트립
  verifyTimeoutMin: number;    // 검증(codex) 대기시간(분) — 저장값 또는 기본 8. 브릿지 verifyTimeoutMin과 같은 규칙.
}

function normWs(p: string): string {
  // NFC: 환경별 유니코드 폼(NFC/NFD) 차이로 같은 경로가 다른 키 되는 것 방지. 브릿지·확장 3카피 '동일 규칙'이어야 함.
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
}

function currentWorkspace(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

// '지금 Claude가 실제 도는 폴더'(훅이 active.json에 기록). 대시보드/상태바는 VS Code 첫 폴더가 아니라
// 이걸 우선해, 보여주는 세션이 검증이 실제 가는 세션과 일치하게 한다. 없으면 VS Code 폴더로 폴백.
function activeWorkspace(): string | null {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR,"active.json"), "utf8"));
    // 신선도 가드: 오래된 active(지난 작업/다른 세션 잔재)는 무시하고 VS Code 폴더로 폴백.
    // 6시간 = 한 작업 세션 동안 유효로 보는 보수적 기본값.
    const ts = o && o.ts ? Date.parse(o.ts) : NaN;
    const fresh = Number.isFinite(ts) && Date.now() - ts < 6 * 60 * 60 * 1000;
    if (fresh && o && typeof o.workspace === "string" && o.workspace.trim()) return o.workspace;
  } catch {
    /* ignore */
  }
  return null;
}

// 지금 Claude가 플랜 모드인지(훅이 active.json에 기록한 permissionMode). 오래된 값은 무시(6h).
function activePermissionMode(ws: string | null): string {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR,"active.json"), "utf8"));
    const ts = o && o.ts ? Date.parse(o.ts) : NaN;
    const fresh = Number.isFinite(ts) && Date.now() - ts < 6 * 60 * 60 * 1000;
    // 이 창의 워크스페이스와 active 기록이 같을 때만 — 다른 창의 플랜 상태가 새어 보이지 않게(창 격리).
    if (fresh && ws && o && typeof o.workspace === "string" && normWs(o.workspace) === normWs(ws) && typeof o.permissionMode === "string") {
      return o.permissionMode;
    }
  } catch {
    /* ignore */
  }
  return "";
}

// 이 대시보드 창이 다룰 워크스페이스. 핵심: 창마다 '자기 폴더'를 봐서 여러 VS Code 창이 안 섞이게 한다.
// 멀티루트(한 창에 폴더 여러 개)일 때만, 활성 Claude 폴더가 이 창의 폴더 중 하나면 그걸 고른다.
function dashboardWorkspace(): string | null {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (!folders.length) return null; // 폴더 없는 빈 창 = 프로젝트 없음 → 아무것도 안 봄(전역 active 누수 차단)
  const active = activeWorkspace();
  if (active && folders.some((f) => normWs(f) === normWs(active))) return active;
  return folders[0];
}

function loadLinks(): { bySession: Record<string, any>; byWorkspace: Record<string, any>; modelPrefs: Record<string, any>; settings: Record<string, any> } {
  try {
    const o = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
    // modelPrefs/settings를 보존해야 대시보드가 저장값(모델·생각강도·검증 대기시간)을 다시 읽어 표시한다.
    return { bySession: o.bySession || {}, byWorkspace: o.byWorkspace || {}, modelPrefs: o.modelPrefs || {}, settings: o.settings || {} };
  } catch {
    return { bySession: {}, byWorkspace: {}, modelPrefs: {}, settings: {} };
  }
}

type VerifyMode = "off" | "code" | "plancode" | "always";
const VERIFY_MODES: VerifyMode[] = ["off", "code", "plancode", "always"];
function normVerifyMode(o: any): VerifyMode {
  if (o && VERIFY_MODES.includes(o.verifyMode)) return o.verifyMode;
  if (o && o.verify === true) return "code"; // 레거시 verify:true → code 마이그레이션
  return "off";
}

// 사용자 계약(Claude 행동규칙) 주입 시점. off=주입 안 함 / plan=Claude Code 플랜 모드일 때만 / always=매 턴.
// 코드모드 없음(코드 변경은 사후 신호라 턴 시작 주입 불가 — verify-guard가 Stop에서 판정). 기본 always=무회귀.
type InjectMode = "off" | "plan" | "always";
const INJECT_MODES: InjectMode[] = ["off", "plan", "always"];
function normInjectMode(o: any): InjectMode {
  if (o && INJECT_MODES.includes(o.claudeInjectMode)) return o.claudeInjectMode;
  return "always";
}

interface Contract {
  claude: string[];
  codex: string[];
  claudeChecklist: boolean;
  codexChecklist: boolean;
  verifyMode: VerifyMode;
  claudeInjectMode: InjectMode;
}

function loadContract(ws?: string | null): Contract {
  const read = (p: string): any | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  // 1) 프로젝트별 계약 → 2) 전역 기본값(상속) → 3) 빈 기본값
  const o = (ws ? read(contractFileFor(ws)) : null) ?? read(CONTRACT_FILE) ?? {};
  return {
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    verifyMode: normVerifyMode(o),
    claudeInjectMode: normInjectMode(o),
  };
}

function saveContract(ws: string | null, c: Contract): boolean {
  // 프로젝트별 파일에 저장(전역 기본값은 다른 미설정 프로젝트의 시드로 보존). ws 없으면 전역에 저장.
  const file = ws ? contractFileFor(ws) : CONTRACT_FILE;
  return atomicWrite(file, JSON.stringify({ ...c, workspace: ws || undefined, updatedAt: new Date().toISOString() }, null, 2));
}

function workspaceLink(links: ReturnType<typeof loadLinks>, ws: string | null): any | null {
  if (!ws) return null;
  const n = normWs(ws);
  for (const k of Object.keys(links.byWorkspace)) {
    if (normWs(k) === n) return links.byWorkspace[k];
  }
  return null;
}

function findRolloutById(uuid: string): string | undefined {
  let found: string | undefined;
  const walk = (d: string, depth: number) => {
    if (found || depth > 6) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (found) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.includes(uuid) && it.name.endsWith(".jsonl")) found = full;
    }
  };
  walk(SESSIONS_DIR, 0);
  return found;
}

function recentRollouts(limit: number): Array<{ id: string; file: string; mtime: number }> {
  const out: Array<{ id: string; file: string; mtime: number }> = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        const m = it.name.match(UUID_RE);
        if (!m) continue;
        let mt = 0;
        try {
          mt = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        out.push({ id: m[1], file: full, mtime: mt });
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function isInjected(t: string): boolean {
  const s = t.trimStart();
  return /^<(environment_context|user_instructions|system)/i.test(s) || s.startsWith("# AGENTS.md");
}

function readMessages(file: string): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type !== "response_item" || o.payload?.type !== "message") continue;
    const role = o.payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = (o.payload.content || []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
    if (!text) continue;
    if (role === "user" && isInjected(text)) continue;
    out.push({ role, text });
  }
  return out;
}

function firstSnippet(file: string): string {
  for (const m of readMessages(file)) {
    if (m.role === "user") return m.text.replace(/\s+/g, " ").slice(0, 70);
  }
  return "(내용 미상)";
}

// rollout의 turn_context에서 '현재(마지막) 모델·생각강도'와 '이 세션이 써본 모델 목록'을 뽑는다.
// readMessages는 turn_context를 버리므로 별도 파서 필요(item4 보기). 마지막 turn_context 값 = 현재값.
function sessionModelMeta(file: string): { model: string; effort: string; models: string[] } {
  const models = new Set<string>();
  let model = "", effort = "";
  let content: string;
  try { content = fs.readFileSync(file, "utf8"); } catch { return { model, effort, models: [] }; }
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let o: any;
    try { o = JSON.parse(s); } catch { continue; }
    if ((o.type || o.payload?.type) !== "turn_context") continue;
    const p = o.payload || o;
    if (p.model) { model = p.model; models.add(p.model); }
    const e = p.effort || p.reasoning_effort;
    if (e) effort = e;
  }
  return { model, effort, models: [...models] };
}

// 코덱스가 '계정별'로 서버에서 받아 캐시하는 모델·생각강도 목록(CODEX_HOME/models_cache.json).
// 계정 등급마다 모델/생각강도(xhigh·pro 등)가 달라 하드코딩 불가 → 이 캐시를 읽어 계정 실제 목록을 쓴다.
// (visibility:"hide"=codex-auto-review 같은 내부용 제외)
interface AvailModel { slug: string; name: string; defaultLevel: string; levels: Array<{ effort: string; description: string }>; }
function readModelsCache(): AvailModel[] {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, "models_cache.json"), "utf8"));
    const models: any[] = Array.isArray(o?.models) ? o.models : [];
    return models
      .filter((m) => m && m.slug && m.visibility !== "hide")
      .map((m) => ({
        slug: String(m.slug),
        name: String(m.display_name || m.slug),
        defaultLevel: String(m.default_reasoning_level || ""),
        levels: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.filter((x: any) => x && x.effort).map((x: any) => ({ effort: String(x.effort), description: String(x.description || "") }))
          : [],
      }));
  } catch {
    return [];
  }
}

// Codex 답에서 '결론(verdict)'을 보수적으로 분류 — bridge/contract-lib.js의 동명 함수와 로직이 반드시 동일해야 한다(한쪽만 고치지 말 것).
// '첫 줄'이 아니라 '검증'이 든 줄을 모두 훑어 마지막 결론 줄로 판정한다 — codex exec 한 턴은 작업 narration이
// 앞에 깔리고 진짜 결론은 마지막 메시지에 오므로, 첫 줄만 보면 거의 빗나간다(그린불 오작동의 근본 원인).
// 반환(4단계): pass(깨끗한 통과) | pass-notes(통과지만 보완·정정·추가의견 있음) | inconclusive(보류·불가·정보부족=통과 못 함) | fail | null.
function extractVerdict(text: string): "pass" | "pass-notes" | "fail" | "inconclusive" | null {
  if (!text) return null;
  let v: "pass" | "pass-notes" | "fail" | "inconclusive" | null = null;
  for (const ln of String(text).split(/\r?\n/)) {
    // '결론 선언 줄'만: '검증'으로 시작 + (콜론이거나 곧바로 결론어). 콜론형("검증: …")은 무조건 선언(정보부족·판단보류 포괄).
    // 서두("검증 요청으로…")·본문("…이 검증에서 실패…","(검증 아님)")은 배제. 우선순위: 실패>보류·불가>통과+보완>통과.
    if (!/^[\s#>*\-]*검증\s*(?:[:：]|통과|실패|불가|보류|판단|조건부|보완|정보)/.test(ln)) continue;
    if (/실패/.test(ln)) v = "fail";
    else if (/불가|보류|정보\s*부족/.test(ln)) v = "inconclusive";
    else if (/통과/.test(ln) && /보완|조건부|정정|추가|미세|단서/.test(ln)) v = "pass-notes";
    else if (/통과/.test(ln)) v = "pass";
  }
  return v;
}
function toTurns(msgs: Array<{ role: string; text: string }>): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of msgs) {
    if (m.role === "user") {
      cur = { user: m.text, assistant: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { user: null, assistant: [] };
        turns.push(cur);
      }
      cur.assistant.push(m.text);
    }
  }
  for (const t of turns) t.verdict = extractVerdict(t.assistant.join("\n\n")); // 첫 줄 추측 아닌 '마지막 결론'으로 판정
  return turns;
}

// 런타임 브릿지 라이브러리(단일 출처)를 불러 기본 지침 기본값/오버라이드 로직을 재사용한다.
// 확장이 자체 복제하지 않고 ~/.codex-bridge/contract-lib.js 를 그대로 쓴다(드리프트 방지).
function bridgeLib(): any | null {
  try {
    return require(path.join(BRIDGE_DIR,"contract-lib.js"));
  } catch {
    return null;
  }
}
function loadBaseDirectiveSafe(): { verifyBaseline: string; transmit: string; rejudge: string; overridden: boolean } {
  try {
    const lib = bridgeLib();
    if (lib && typeof lib.loadBaseDirective === "function") {
      const cur = lib.loadBaseDirective();
      const def = lib.BASE_DEFAULTS || {};
      const overridden =
        cur.verifyBaseline !== def.verifyBaseline || cur.transmit !== def.transmit || cur.rejudge !== def.rejudge;
      return { verifyBaseline: cur.verifyBaseline || "", transmit: cur.transmit || "", rejudge: cur.rejudge || "", overridden };
    }
  } catch {
    /* ignore */
  }
  return { verifyBaseline: "", transmit: "", rejudge: "", overridden: false };
}

// 무결성 신호: 브릿지(verify-guard)가 '검증 미완' 등을 integrity.json에 기록 → 여기서 읽어 상태바/대시보드로 가시화.
// 단순 게이트(차단)로 끝내지 않고 사람에게 보이게 하는 채널의 소비자 쪽. 포맷은 contract-lib과 공유.
interface IntegrityEvent { id: string; ts?: string; kind?: string; severity?: string; detail?: string; ack?: boolean; session?: string; workspace?: string }
function readIntegrity(): IntegrityEvent[] {
  try { const d = JSON.parse(fs.readFileSync(INTEGRITY_FILE, "utf8")); return Array.isArray(d.events) ? d.events : []; } catch { return []; }
}
// 창 격리: integrity.json도 모든 창이 공유하는 한 파일이라, 필터 없이 보이면 '다른 창'의 검증 미완/근거의심
// 경보가 내 상태바·대시보드에 새어 보인다(phase와 같은 누수). 이 창 워크스페이스 것만 보여준다(표시 전용 — ack는
// id로 처리하므로 원본 목록은 안 건드림). 모든 appendIntegrityEvent 기록부가 workspace를 넣음.
function readVisibleIntegrity(ws: string | null): IntegrityEvent[] {
  if (!ws) return []; // 폴더 없는 빈 창 → 전역 경보 누수 차단
  return readIntegrity().filter((e) => !e.workspace || normWs(e.workspace) === normWs(ws));
}
function ackIntegrity(ids: string[] | "all"): boolean {
  const events = readIntegrity();
  const set = ids === "all" ? null : new Set(ids);
  for (const e of events) { if (!set || set.has(e.id)) e.ack = true; }
  return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events }));
}
// 무결성 경보 툴팁: 상태바 '바로 위'에 뜨는 '인터랙티브 호버'(MarkdownString+command 링크) — 마우스를 올려 링크 클릭 가능.
// 평범한 문자열 툴팁과 달리 호버 안으로 진입 가능(VS Code #126753 fixed; 상태바 항목에 command가 있어야 마크다운 호버가 뜸 — 충족).
// isTrusted는 우리 두 커맨드로만 좁힌다(임의 command: 링크 실행 방지). $(icon)은 supportThemeIcons로 렌더.
function alertTooltip(headMd: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    headMd + `\n\n---\n\n[$(check) **확인함** — 이 창 경고 읽음](command:codexBridge.ackHere)\n\n[$(dashboard) **대시보드 열기**](command:codexBridge.openDashboard)`,
  );
  md.isTrusted = { enabledCommands: ["codexBridge.ackHere", "codexBridge.openDashboard"] };
  md.supportThemeIcons = true;
  return md;
}

// 검증 파이프라인 라이브 단계: 훅/브릿지가 phase.json에 기록한 단계 + 코덱스 rollout 성장 + staleness로
// 사용자에게 진행을 보여준다(토큰 스트림 아님, 파일변화 기반). 단계: 대기/Claude작업중/검증요청됨/Codex생성중/반영중/완료/미완.
interface LiveStage { key: string; label: string; icon: string; spin: boolean; round: number; color: string }
function readPhaseRaw(): { phase?: string; round?: number; session?: string; workspace?: string; ts?: string } {
  try { return JSON.parse(fs.readFileSync(PHASE_FILE, "utf8")) || {}; } catch { return {}; }
}
// 연결 세션 rollout이 '최근 쓰인' 상태인가(mtime 최근 N초) → 코덱스가 지금 답을 쓰는 중으로 추정.
// (정확히 size 증가가 아니라 recent-mtime 근사 — 브릿지가 동기로 막혀 있어도 파일 갱신으로 감지하는 게 목적.)
function linkedRolloutRecentlyWritten(linkedId: string | null, withinMs = 12000): boolean {
  if (!linkedId) return false;
  try { const f = findRolloutById(linkedId); if (!f) return false; return Date.now() - fs.statSync(f).mtimeMs < withinMs; } catch { return false; }
}
function computeLiveStage(linkedId: string | null): LiveStage | null {
  const p = readPhaseRaw();
  if (!p.phase) return null;
  // 창 격리: phase.json은 모든 VS Code 창이 공유하는 한 파일이라, 필터 없이 읽으면 '다른 창'의
  // 검증 진행이 이 창에 새어 보인다(대표 UI 신뢰 문제). 이 창의 워크스페이스 것만 보인다.
  // (activePermissionMode의 누수 차단과 같은 normWs 비교 패턴.) 모든 writePhase 기록부가 workspace를 넣음.
  const ws = dashboardWorkspace();
  if (!ws) return null; // 폴더 없는 빈 창 = 프로젝트 없음 → 진행 표시 안 함(전역 누수 차단)
  if (p.workspace && normWs(p.workspace) !== normWs(ws)) return null; // 다른 창의 진행은 숨김
  const ts = Date.parse(p.ts || "");
  if (!Number.isFinite(ts) || Date.now() - ts > PHASE_STALE_MS) return null; // 오래됨 → 대기(표시 안 함)
  const round = Number(p.round) || 0;
  // color = 상태바 '글자색'(status.color, 임의 ThemeColor 가능). 배경색은 VS Code가 error/warning만 허용하므로
  // 단계별 다색은 글자색으로 표현하고, 빨강 배경은 무결성 경보 전용으로 둔다.
  switch (p.phase) {
    case "claude-working": return { key: "claude", label: "Claude 작업중", icon: "$(pencil)", spin: false, round, color: "charts.blue" };
    case "codex-verifying":
      return linkedRolloutRecentlyWritten(linkedId)
        ? { key: "codex-gen", label: "Codex 생성중", icon: "$(sync~spin)", spin: true, round, color: "charts.green" }
        : { key: "codex-req", label: "코덱스에 검증 요청", icon: "$(sync~spin)", spin: true, round, color: "charts.yellow" };
    case "rejudging": return { key: "rejudge", label: "검증 답 반영중", icon: "$(pencil)", spin: false, round, color: "charts.orange" };
    case "done": return { key: "done", label: "검증 완료", icon: "$(check)", spin: false, round, color: "charts.green" };
    case "incomplete": return { key: "incomplete", label: "검증 미완", icon: "$(alert)", spin: false, round, color: "charts.red" };
    default: return null;
  }
}

function computeState(turnsN: number): BridgeState {
  const ws = dashboardWorkspace();
  const links = loadLinks();
  const link = workspaceLink(links, ws);
  const linkedId: string | null = link?.codexSession ?? null;

  let turns: Turn[] = [];
  let lastActivity: string | null = null;
  let modelMeta: { model: string; effort: string; models: string[] } = { model: "", effort: "", models: [] };
  if (linkedId) {
    const file = findRolloutById(linkedId);
    if (file) {
      turns = toTurns(readMessages(file)).slice(-Math.max(1, turnsN));
      modelMeta = sessionModelMeta(file);
      try {
        lastActivity = new Date(fs.statSync(file).mtimeMs).toLocaleString();
      } catch {
        /* ignore */
      }
    }
  }
  const pref: any = links.modelPrefs[normWs(ws || "")] || {};

  const hid = hiddenSessions();
  const mkCand = (r: { id: string; file: string; mtime: number }): Candidate => ({
    id: r.id,
    when: r.mtime ? new Date(r.mtime).toLocaleString() : "",
    snippet: firstSnippet(r.file),
    linked: r.id === linkedId,
  });
  // 전체 스캔 후 '숨김 제외 → 상위 N'. walk()는 limit과 무관하게 이미 전수 순회하므로 limit만 키워도 비용 동일.
  // 이렇게 해야 브릿지(find/ask: 전수→숨김제외→slice)와 일치하고, 오래된 숨김 세션도 복원 목록에 남는다.
  const allRoll = recentRollouts(99999);
  const candidates: Candidate[] = allRoll.filter((r) => !hid.has(r.id)).slice(0, 12).map(mkCand);
  const hiddenCandidates: Candidate[] = allRoll.filter((r) => hid.has(r.id)).slice(0, 50).map(mkCand);

  // 모델·생각강도 옵션은 계정 캐시에서 온다. 못 읽으면 '왜'를 알려줄 진단 문구(빈 문자열=정상).
  const availModels = readModelsCache();
  let modelsCacheNote = "";
  if (!availModels.length) {
    modelsCacheNote = fs.existsSync(path.join(CODEX_HOME, "models_cache.json"))
      ? "계정 모델 목록을 읽었지만 표시할 모델이 없어 기본값으로 보여줘요(코덱스 갱신/버전 확인)."
      : "계정 모델 목록 파일을 못 찾아 기본값으로 보여줘요 — 코덱스가 아직 목록을 안 받았거나 폴더 위치(CODEX_HOME)가 바뀐 경우예요.";
  }

  return {
    workspace: ws,
    linkedId,
    linkedSnippet: linkedId ? (candidates.find((c) => c.id === linkedId)?.snippet ?? hiddenCandidates.find((c) => c.id === linkedId)?.snippet ?? "") : "",
    linkedAt: link?.linkedAt ?? null,
    lastActivity,
    turns,
    candidates,
    hiddenCandidates,
    contract: loadContract(ws),
    baseDirective: loadBaseDirectiveSafe(),
    baseAvailable: bridgeLib() !== null,
    permissionMode: activePermissionMode(ws),
    codexReady: !!resolveCodexPathForBridge(),
    onboardDismissed: fs.existsSync(path.join(BRIDGE_DIR,"onboard-dismissed")),
    modelCurrent: modelMeta.model,
    effortCurrent: modelMeta.effort,
    modelPref: typeof pref.model === "string" ? pref.model : "",
    reasoningPref: typeof pref.reasoning === "string" ? pref.reasoning : "",
    knownModels: modelMeta.models,
    availModels,
    modelsCacheNote,
    integrity: readVisibleIntegrity(ws),
    live: computeLiveStage(linkedId),
    verifyTimeoutMin: clampVerifyTimeout(links.settings?.verifyTimeoutMin),
  };
}

// 검증 대기시간(분) 정규화 — 브릿지 verifyTimeoutMin과 동일 규칙(1~60, 기본 8). 잘못된 값은 기본으로.
const VERIFY_TIMEOUT_DEFAULT = 8;
function clampVerifyTimeout(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return VERIFY_TIMEOUT_DEFAULT;
  return Math.max(1, Math.min(60, Math.round(n)));
}
function setVerifyTimeout(min: number): boolean {
  const v = clampVerifyTimeout(min);
  return updateLinks((o) => { o.settings = o.settings || {}; o.settings.verifyTimeoutMin = v; });
}

// 숨긴 세션 메타(원본 rollout 안 건드림 — §5.1). ~/.codex-bridge/sessions-meta.json (id→{state}).
const SESSIONS_META = path.join(BRIDGE_DIR,"sessions-meta.json");
function hiddenSessions(): Set<string> {
  try {
    const o = JSON.parse(fs.readFileSync(SESSIONS_META, "utf8"));
    return new Set(Object.keys(o).filter((k) => o[k] && (o[k].state === "hidden" || o[k] === "hidden")));
  } catch {
    return new Set();
  }
}
function setSessionHidden(id: string, hidden: boolean): void {
  let o: any = {};
  try { o = JSON.parse(fs.readFileSync(SESSIONS_META, "utf8")); } catch { o = {}; }
  if (hidden) o[id] = { state: "hidden" };
  else delete o[id];
  try {
    fs.mkdirSync(path.dirname(SESSIONS_META), { recursive: true });
    atomicWrite(SESSIONS_META, JSON.stringify(o, null, 2));
  } catch {
    /* ignore */
  }
}
// links.json 쓰기 단일 관문: 모든 쓰기(연결/해제/모델선택/relink)가 이걸 통과한다. 최신본을 읽어 mutate로
// '내 부분'만 바꾸고, 쓰기 직전 파일이 그새 바뀌었으면(다른 창·브릿지가 저장) 최신본으로 다시 적용해 재시도한다
// (낙관적 동시성). atomicWrite(temp+rename)와 합쳐, 마지막 글쓴이가 남의 변경을 통째로 덮어쓰는 lost-update를
// 크게 줄인다. ⚠ 완전한 lock은 아님 — 재읽기↔쓰기 사이 미세 경쟁 창은 남는다(문서화된 한계).
function readLinksRaw(): string { try { return fs.readFileSync(LINKS_FILE, "utf8"); } catch { return ""; } }
function updateLinks(mutate: (o: any) => void, retries = 4): boolean {
  for (let i = 0; i <= retries; i++) {
    const before = readLinksRaw();
    let o: any = {};
    try { o = before ? JSON.parse(before) : {}; } catch { o = {}; }
    o.bySession = o.bySession || {};
    o.byWorkspace = o.byWorkspace || {};
    mutate(o);
    if (readLinksRaw() !== before) continue; // 그새 누가 저장함 → 최신본으로 재적용(재시도)
    return atomicWrite(LINKS_FILE, JSON.stringify(o, null, 2));
  }
  // 재시도 소진(계속 경합) — 최신본에 한 번 더 적용해 best-effort 저장(드롭보다 나음)
  let o: any = {};
  try { o = JSON.parse(readLinksRaw()); } catch { o = {}; }
  o.bySession = o.bySession || {};
  o.byWorkspace = o.byWorkspace || {};
  mutate(o);
  return atomicWrite(LINKS_FILE, JSON.stringify(o, null, 2));
}

// 연결 해제(삭제 ≠ 해제): '이 워크스페이스'의 링크만 제거(프로젝트별 분리 — 같은 codex 세션을
// 쓰는 타 워크스페이스 링크는 보존). byWorkspace는 키=normWs, bySession은 .workspace로 스코프. 원본은 안 건드림.
function unlinkSession(id: string, ws: string): boolean {
  const n = normWs(ws);
  if (!n) return false;
  return updateLinks((o) => {
    for (const k of Object.keys(o.bySession)) if (o.bySession[k]?.codexSession === id && normWs(o.bySession[k].workspace || "") === n) delete o.bySession[k];
    for (const k of Object.keys(o.byWorkspace)) if (normWs(k) === n && o.byWorkspace[k]?.codexSession === id) delete o.byWorkspace[k];
  });
}

// 영구 삭제: rollout 원본 파일을 지운다(되돌릴 수 없음). 코덱스 내부 state db의 잔여 항목은 코덱스가 정리한다
// (우리가 코덱스 내부 db를 건드리는 건 위험). 삭제된 세션 resume 시 코덱스가 "no rollout found"로 곱게 실패함을
// 런타임 확인(2026-06-20) — 다른 세션·find 스캔은 안 깨짐.
// 성공여부를 반환: 파일 없음=이미 목표달성(true), 삭제 예외(잠김/권한)=false → 호출부가 메타를 함부로 안 지우게.
function purgeRollout(id: string): boolean {
  try {
    const f = findRolloutById(id);
    if (!f) return true;
    fs.unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}
// 이 codex 세션을 가리키는 워크스페이스 키들(영구삭제 전 '몇 개 프로젝트가 쓰는지' 경고용).
function workspacesLinking(id: string): string[] {
  try {
    const o = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
    return Object.keys(o.byWorkspace || {}).filter((k) => o.byWorkspace[k]?.codexSession === id);
  } catch {
    return [];
  }
}
// 영구삭제용 전역 해제: 파일이 전역으로 사라지므로 이 세션을 가리키는 '모든' 링크를 제거(타 워크스페이스 dangling 방지).
// (hide의 unlinkSession은 워크스페이스 한정 — delete와 정책이 다름.)
function unlinkSessionEverywhere(id: string): boolean {
  return updateLinks((o) => {
    for (const k of Object.keys(o.bySession)) if (o.bySession[k]?.codexSession === id) delete o.bySession[k];
    for (const k of Object.keys(o.byWorkspace)) if (o.byWorkspace[k]?.codexSession === id) delete o.byWorkspace[k];
  });
}

// 모델/생각강도 선택 저장(프로젝트별) — links.json modelPrefs[normWs]={model,reasoning}. 빈 값은 항목 삭제(=코덱스 기본값).
// 브릿지(modelArgs)가 이걸 읽어 매 ask마다 -c로 재적용한다(호출별이라 세션에 안 박힘).
function setModelPref(ws: string, model: string, reasoning: string): boolean {
  const n = normWs(ws);
  if (!n) return false;
  return updateLinks((o) => {
    o.modelPrefs = o.modelPrefs || {};
    const cur: any = {};
    if (model && model.trim()) cur.model = model.trim();
    if (reasoning && reasoning.trim()) cur.reasoning = reasoning.trim();
    if (Object.keys(cur).length) o.modelPrefs[n] = cur;
    else delete o.modelPrefs[n];
  });
}

function relink(id: string): boolean {
  const ws = dashboardWorkspace();
  if (!ws) return false;
  const n = normWs(ws);
  return updateLinks((o) => {
    // 이 워크스페이스의 세션 고정/옛 워크스페이스 키 정리 → UI 선택을 우선시.
    for (const k of Object.keys(o.bySession)) {
      if (o.bySession[k] && normWs(o.bySession[k].workspace || "") === n) delete o.bySession[k];
    }
    for (const k of Object.keys(o.byWorkspace)) {
      if (normWs(k) === n) delete o.byWorkspace[k];
    }
    o.byWorkspace[n] = { codexSession: id, workspace: ws, linkedAt: new Date().toISOString(), via: "ui" };
  });
}

class Dashboard {
  private panel?: vscode.WebviewPanel;
  public onChange?: () => void; // 상태바 등 외부 갱신 콜백(예: 무결성 ack 후 상태바 즉시 새로고침 — watcher 지연에 안 기댐)
  constructor(private readonly uri: vscode.Uri, private readonly turnsN: () => number) {}

  show(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("codexBridge", "Codex Bridge", vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.uri],
      });
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "relink" && m.id) {
          if (!relink(String(m.id))) { vscode.window.showErrorMessage("연결 저장에 실패했어요(파일 잠김/권한?). 잠시 후 다시 시도하세요."); return; }
          this.post();
          vscode.commands.executeCommand("codexBridge.refresh");
        }
        if (m?.type === "hideSession" && m.id) {
          const id = String(m.id);
          const ws = dashboardWorkspace();
          const linked = !!ws && workspaceLink(loadLinks(), ws)?.codexSession === id;
          const warn = linked ? "이 세션은 지금 이 프로젝트에 연결돼 있습니다. 숨기면 이 프로젝트의 연결만 해제됩니다(다른 프로젝트 연결은 유지).\n\n" : "";
          vscode.window
            .showWarningMessage(`${warn}이 Codex 세션을 목록에서 숨길까요?\n(${id.slice(0, 8)}… · 원본 파일은 지우지 않으며 '숨긴 세션 보기'에서 복원 가능)`, { modal: true }, "숨기기")
            .then((pick) => {
              if (pick !== "숨기기") return;
              if (linked && ws && !unlinkSession(id, ws)) { vscode.window.showErrorMessage("연결 해제 저장에 실패했어요(파일 잠김/권한?). 숨김을 보류합니다."); return; }
              setSessionHidden(id, true);
              this.post();
              vscode.commands.executeCommand("codexBridge.refresh");
            });
        }
        if (m?.type === "restoreSession" && m.id) {
          setSessionHidden(String(m.id), false);
          this.post();
        }
        if (m?.type === "purgeSession" && m.id) {
          const id = String(m.id);
          const others = workspacesLinking(id); // 이 세션을 연결한 모든 프로젝트(파일은 전역 자원)
          const warn = others.length > 1
            ? `이 세션은 ${others.length}개 프로젝트에서 연결해 쓰고 있어요. 삭제하면 그 프로젝트들에서도 사라집니다.\n\n`
            : others.length === 1
              ? "이 세션은 한 프로젝트에 연결돼 있어요. 삭제하면 그 연결도 해제됩니다.\n\n"
              : "";
          vscode.window
            .showWarningMessage(`${warn}이 Codex 세션을 영구 삭제할까요?\n(${id.slice(0, 8)}… · 대화 원본 파일이 지워지며 되돌릴 수 없습니다)`, { modal: true }, "영구 삭제")
            .then((pick) => {
              if (pick !== "영구 삭제") return;
              if (!purgeRollout(id)) { // 삭제 실패(잠김/권한) → 메타 그대로 두고 알림(거짓 삭제 방지)
                vscode.window.showErrorMessage("세션 파일을 삭제하지 못했어요(파일 잠김/권한?). 목록은 그대로 둡니다.");
                return;
              }
              // 파일이 전역 삭제됐으니 모든 워크스페이스 링크 제거(dangling 방지). 파일은 이미 사라졌으므로
              // 링크 정리 저장이 실패해도 되돌릴 수 없다 → 경고만 하고 진행(남은 링크는 resume 시 곱게 실패).
              if (!unlinkSessionEverywhere(id)) vscode.window.showWarningMessage("세션은 삭제됐지만 연결 기록 정리에 실패했어요(파일 잠김/권한?). 남은 연결은 다음에 정리됩니다.");
              setSessionHidden(id, false); // 사라진 세션의 숨김 메타 정리
              this.post();
              vscode.commands.executeCommand("codexBridge.refresh");
            });
        }
        if (m?.type === "saveModelPref") {
          const ok = setModelPref(dashboardWorkspace() || "", String(m.model || ""), String(m.reasoning || ""));
          if (!ok) vscode.window.showErrorMessage("두뇌 설정 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 저장해 주세요.");
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "model", ok });
        }
        if (m?.type === "saveVerifyTimeout") {
          const ok = setVerifyTimeout(Number(m.min));
          if (!ok) vscode.window.showErrorMessage("검증 대기시간 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 시도해 주세요.");
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "timeout", ok });
        }
        if (m?.type === "saveContract") {
          const ok = saveContract(dashboardWorkspace(), {
            claude: Array.isArray(m.claude) ? m.claude : [],
            codex: Array.isArray(m.codex) ? m.codex : [],
            claudeChecklist: !!m.claudeChecklist,
            codexChecklist: !!m.codexChecklist,
            verifyMode: normVerifyMode({ verifyMode: m.verifyMode }),
            claudeInjectMode: normInjectMode({ claudeInjectMode: m.claudeInjectMode }),
          });
          if (!ok) vscode.window.showErrorMessage("설정 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 저장해 주세요(기존 설정은 그대로 유지됩니다).");
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "contract", ok });
        }
        if (m?.type === "saveBase") {
          let ok = false;
          try {
            ok = bridgeLib()?.saveBaseDirective?.({ verifyBaseline: m.verifyBaseline, transmit: m.transmit, rejudge: m.rejudge }) === true;
          } catch {
            ok = false;
          }
          if (!ok) vscode.window.showErrorMessage("단계별 기본 원칙 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 시도해 주세요.");
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "base", ok });
        }
        if (m?.type === "baseEditWarn") {
          // 편집 시작(필드 첫 포커스) 시점 informed-consent 경고. 필드별 다른 메시지(합의된 설계):
          //  - verifyBaseline(검증 기본원칙) → Codex 검증 '꼼꼼함' + 결과 표시 둘 다 정함('표시만 영향' 아님)
          //  - transmit/rejudge(전달/재판단) → Claude의 검증 흐름
          // webview는 포커스를 안 건드림(blur/refocus 없음) → 편집/저장 흐름 보존. 숨겨 강제주입 대신 공개·동의.
          const isVerify = m.field === "verify";
          const msg = isVerify
            ? "'검증 기본원칙'은 Codex가 어떻게 검증할지(파일을 직접 열고·빠뜨리지 말고·범위를 넓혀 보라)와 결론을 쓰는 형식을 함께 정합니다.\n\n줄이거나 바꾸면 Codex 검증이 느슨해질 수 있고, 대시보드의 'Codex 검증 대화' 영역에 뜨는 통과/보완/보류/실패 색 표시와 결론·근거 경고가 동작하지 않을 수 있어요.\n\n그래도 변경하시겠습니까?"
            : "이 원칙은 Claude가 검증을 주고받고(전달) 결과를 다시 판단하는(재판단) 흐름에 직접 관여합니다.\n\n줄이거나 바꾸면 검증의 완전한 동작을 보장하지 못할 수 있어요.\n\n그래도 변경하시겠습니까?";
          vscode.window.showWarningMessage(msg, { modal: true }, "변경").then((pick) => {
            this.panel?.webview.postMessage({ type: "baseEditWarnResult", field: m.field, ok: pick === "변경" });
          });
        }
        if (m?.type === "resetBase") {
          let ok = false;
          try {
            ok = bridgeLib()?.resetBaseDirective?.() === true;
          } catch {
            ok = false;
          }
          if (!ok) vscode.window.showErrorMessage("기본값 복원 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 시도해 주세요.");
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "base", ok });
        }
        if (m?.type === "dismissOnboard") {
          try { fs.mkdirSync(BRIDGE_DIR, { recursive: true }); fs.writeFileSync(path.join(BRIDGE_DIR,"onboard-dismissed"), "1", "utf8"); } catch { /* ignore */ }
          this.post();
        }
        if (m?.type === "showOnboard") {
          try { fs.rmSync(path.join(BRIDGE_DIR,"onboard-dismissed"), { force: true }); } catch { /* ignore */ }
          this.post();
        }
        if (m?.type === "openSettings") {
          vscode.commands.executeCommand("workbench.action.openSettings", "codexBridge.codexPath");
        }
        if (m?.type === "ackIntegrity") {
          // 무결성 경보 확인(해제). id 배열이면 그것만, 없으면 전체.
          const ok = ackIntegrity(Array.isArray(m.ids) && m.ids.length ? m.ids : "all");
          if (!ok) vscode.window.showErrorMessage("무결성 경보 확인 저장 실패 — 파일이 잠겨 있을 수 있어요. 잠시 후 다시 시도해 주세요.");
          this.post();
          this.onChange?.(); // 상태바도 즉시 갱신(watcher 지연/누락에 안 기댐) → 빨강 경보 바로 해제
        }
        if (m?.type === "refresh") this.post();
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    this.post();
  }

  post(): void {
    this.panel?.webview.postMessage({ type: "data", data: computeState(this.turnsN()) });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
  .shell{max-width:960px;margin:0 auto;padding:28px 26px 40px}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
  h1{font-size:18px;margin:0;display:flex;align-items:center;gap:9px}
  h1 .sub{font-size:12px;font-weight:400;color:var(--vscode-descriptionForeground)}
  /* 워드마크: 파랑(Claude)→초록(Codex) 그라데이션 사각 — 이모지 대신 */
  .brand{width:20px;height:20px;border-radius:6px;background:linear-gradient(135deg,var(--vscode-charts-blue),var(--vscode-charts-green));flex:none}
  h2{font-size:15px;font-weight:700;margin:34px 0 13px;color:var(--vscode-foreground);display:flex;align-items:center;gap:9px;letter-spacing:.2px}
  h2 .sub2{font-size:11px;font-weight:400;color:var(--vscode-descriptionForeground);letter-spacing:0}
  /* 섹션 경계: 위쪽 구분선으로 '여기서 새 기능 시작'을 한눈에 */
  h2.sec{border-top:1px solid var(--vscode-panel-border);padding-top:20px}
  /* 역할별 섹션 헤더 마커 — 파랑=Claude, 초록=Codex/검증, 회색=기본지침/연결 */
  h2.sec::before{content:"";width:4px;height:17px;border-radius:2px;background:var(--vscode-panel-border);flex:none}
  h2.sec.claude::before{background:var(--vscode-charts-blue)}
  h2.sec.codex::before{background:var(--vscode-charts-green)}
  h2.sec.base::before{background:var(--vscode-descriptionForeground)}
  .hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:4px 0 0 22px;line-height:1.5}
  .hint code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background,var(--vscode-panel-border));padding:0 4px;border-radius:3px}
  .hint .ic{cursor:help;border-bottom:1px dotted currentColor;white-space:nowrap}
  /* 규칙 입력 메타 칩(선택·형식·비움) */
  .rulemeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .rchip{font-size:10px;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border);border-radius:999px;padding:1px 8px;white-space:nowrap}
  .rchip.opt{color:var(--vscode-charts-blue);border-color:var(--vscode-charts-blue);font-weight:700}
  .card{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:17px 18px;background:var(--vscode-sideBar-background);margin-bottom:14px}
  .muted{color:var(--vscode-descriptionForeground);font-size:12px}
  .id{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground);word-break:break-all}
  .role{font-weight:600;font-size:12px;margin:8px 0 3px;color:var(--vscode-descriptionForeground)}
  .text{white-space:pre-wrap;overflow-wrap:anywhere}
  button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:5px;padding:5px 12px;cursor:pointer;font:inherit}
  button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  /* 히어로: Claude ⇄ Codex */
  .hero{display:flex;align-items:stretch;gap:10px;margin-bottom:16px}
  .agent{flex:1;text-align:center;padding:16px 10px;border-radius:10px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}
  .agent .emo{font-size:30px;line-height:1}
  .agent .nm{font-weight:600;margin-top:6px}
  .agent .ro{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
  .agent.claude{border-color:var(--vscode-charts-blue)}
  .agent.codex{border-color:var(--vscode-charts-green)}
  .link{flex:0 0 108px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}
  .link .bar{width:100%;height:3px;border-radius:2px;background:var(--vscode-panel-border)}
  .link .emo{font-size:11px;line-height:1;color:var(--vscode-panel-border)}
  .link .st{font-size:11px;color:var(--vscode-descriptionForeground)}
  .link.on .bar{background:var(--vscode-charts-green)}
  .link.on .emo{color:var(--vscode-charts-green)}
  .link.on .st{color:var(--vscode-charts-green);font-weight:600}
  .statusline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:2px 0 4px;font-size:12px}
  .integrity{border:1px solid var(--vscode-inputValidation-errorBorder,#d44);border-left:4px solid var(--vscode-inputValidation-errorBorder,#d44);background:var(--vscode-inputValidation-errorBackground,rgba(212,68,68,0.12));border-radius:8px;padding:12px 14px;margin:4px 0 14px}
  .integrity.warn{border-color:var(--vscode-inputValidation-warningBorder,#c90);border-left-color:var(--vscode-inputValidation-warningBorder,#c90);background:var(--vscode-inputValidation-warningBackground,rgba(204,153,0,0.12))}
  .integrity .ih{display:flex;align-items:center;justify-content:space-between;gap:10px;font-weight:700}
  .integrity ul{margin:8px 0 0;padding-left:18px}
  .integrity li{font-size:12px;margin:3px 0;color:var(--vscode-foreground)}
  .integrity .when{color:var(--vscode-descriptionForeground);font-size:11px}
  .integrity button{cursor:pointer}
  /* 심각도 색점(이모지 대신) — 빨강=검증미완, 주황=근거의심 */
  .sevdot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle;flex:none}
  .sevdot.err{background:var(--vscode-charts-red)}
  .sevdot.warn{background:var(--vscode-charts-orange)}
  .livestrip{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:11px 14px;margin:4px 0 14px;background:var(--vscode-sideBar-background)}
  .lsflow{display:flex;align-items:center;justify-content:center;gap:12px}
  .lsbox{padding:5px 12px;border-radius:6px;border:1px solid var(--vscode-panel-border);font-weight:700;font-size:12px;opacity:.5;transition:all .25s}
  .lsbox.on{opacity:1;border-color:var(--vscode-focusBorder);background:var(--vscode-inputOption-activeBackground,rgba(80,140,255,.18))}
  .lsarrow{font-weight:800;letter-spacing:1px;color:var(--vscode-descriptionForeground);min-width:64px;text-align:center}
  .lsarrow.tocodex{color:#3a9}.lsarrow.toclaude{color:#a73}
  .lsstage{text-align:center;margin-top:8px;font-size:12px}
  .lschip{display:inline-block;padding:3px 11px;border-radius:999px;font-weight:600;border:1px solid currentColor}
  .lschip.codex-gen,.lschip.codex-req{color:#3a9}.lschip.rejudge{color:#a73}.lschip.claude{color:#58f}.lschip.incomplete{color:#d44}.lschip.done{color:#3a9}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid currentColor}
  .wschip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:6px;font-size:11px;font-weight:600;border:1px solid var(--vscode-charts-orange);color:var(--vscode-charts-orange)}
  .b-off{color:var(--vscode-descriptionForeground)}
  .b-code{color:var(--vscode-charts-blue)}
  .b-plancode{color:var(--vscode-charts-purple)}
  .b-always{color:var(--vscode-charts-orange)}
  /* 계약 블록: 에이전트 색 구분 */
  .cblock{border-left:3px solid var(--vscode-panel-border);padding-left:10px}
  .cblock.claude{border-left-color:var(--vscode-charts-blue)}
  .cblock.codex{border-left-color:var(--vscode-charts-green)}
  .chead{font-weight:700;font-size:13px;display:flex;align-items:center;gap:6px;margin-bottom:3px}
  textarea{width:100%;box-sizing:border-box;margin-top:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:5px;padding:7px;font-family:var(--vscode-editor-font-family);font-size:12px;resize:vertical}
  select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border));border-radius:4px;padding:3px 6px;font:inherit}
  .row{display:flex;align-items:center;gap:10px;margin:12px 0 0}
  label.ck{display:flex;align-items:flex-start;gap:6px;font-size:12px;color:var(--vscode-descriptionForeground);margin-top:6px;cursor:pointer}
  label.ck.verify{margin-top:14px;color:var(--vscode-foreground);border-top:1px solid var(--vscode-panel-border);padding-top:12px;align-items:center;flex-wrap:wrap}
  label.ck input{margin-top:2px}
  .cand{display:flex;gap:8px;align-items:flex-start;justify-content:space-between;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:8px 10px;margin-bottom:6px}
  .cand.linked{border-color:var(--vscode-charts-green);background:var(--vscode-editor-background)}
  .star{color:var(--vscode-charts-green);font-size:12px;font-weight:600}
  .cacts{display:flex;gap:6px;align-items:center;flex-shrink:0}
  button.del{padding:2px 9px;line-height:1.5;opacity:.75}
  button.del:hover{opacity:1}
  .linklike{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;padding:6px 0;font-size:12px;text-align:left}
  .linklike:hover{text-decoration:underline}
  #hiddenList{margin-top:4px}
  /* 모노그램 에이전트(이모지 대신) */
  .mono{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;margin:0 auto 2px;color:#fff;letter-spacing:.5px}
  .mono.c{background:var(--vscode-charts-blue)}
  .mono.x{background:var(--vscode-charts-green)}
  /* 검증 모드 세그먼트 토글 */
  .seg{display:inline-flex;flex-wrap:wrap;max-width:100%;border:1px solid var(--vscode-panel-border);border-radius:7px;overflow:hidden;margin-left:8px;vertical-align:middle}
  .seg button{background:transparent;color:var(--vscode-foreground);border:0;border-right:1px solid var(--vscode-panel-border);padding:5px 11px;font-size:11px;cursor:pointer;border-radius:0;display:inline-flex;flex-direction:column;align-items:center;gap:1px;line-height:1.25}
  .seg button small{font-size:9px;font-weight:400;opacity:.72}
  .seg button:last-child{border-right:0}
  .seg button.on{background:var(--vscode-charts-orange);color:#fff;font-weight:700}
  .seg button.on small{opacity:.92}
  .mcard{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:12px 14px;background:var(--vscode-editor-background)}
  .mrow{display:flex;align-items:center;gap:8px;margin-top:10px}
  .mlbl{min-width:60px;color:var(--vscode-descriptionForeground);font-size:12px}
  #mModel{flex:1;max-width:280px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:5px;padding:5px 8px;font:inherit}
  #segReason{margin-left:0}
  .nowbadge{font-size:10px;font-weight:700;padding:1px 8px;border-radius:999px;border:1px solid var(--vscode-charts-purple);color:var(--vscode-charts-purple)}
  /* 온보딩 배너 */
  .onboard{border:1px solid var(--vscode-charts-orange);border-radius:9px;padding:12px 15px;margin:0 0 18px;background:var(--vscode-editor-background)}
  .onboard.complete{border-color:var(--vscode-charts-green)}
  .onboard.incomplete{animation:obpulse 2.4s ease-in-out infinite}
  @keyframes obpulse{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--vscode-charts-orange) 35%,transparent)}}
  @media (prefers-reduced-motion: reduce){ .onboard.incomplete{animation:none} }
  .obhead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px}
  #obTitle{font-size:12.5px;font-weight:700}
  .obclose{font-size:10.5px;padding:3px 9px}
  .obstep{font-size:11.5px;margin:7px 0;line-height:1.5;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .obstep .k{font-weight:700}
  .obstep.done{color:var(--vscode-charts-green)}
  .obstep .where{color:var(--vscode-descriptionForeground);font-size:10.5px}
  .obgo{font-size:10px;padding:2px 9px;margin-left:2px}
  .obdone{font-size:12px;font-weight:600;color:var(--vscode-charts-green)}
  .obreopen{font-size:11px;background:none;color:var(--vscode-textLink-foreground);border:0;padding:0;cursor:pointer}
  /* 이동 시 대상 강조 */
  .glow{animation:glowpulse 1.8s ease-out}
  @keyframes glowpulse{0%,28%{box-shadow:0 0 0 3px var(--vscode-charts-orange);border-radius:8px}100%{box-shadow:0 0 0 0 transparent}}
  /* 검증 시 적용되는 지침 요약(수신자별) */
  /* 검증 대화: 사용자=오른쪽 말풍선 / Codex=왼쪽 전폭 카드 */
  .turn{margin-bottom:14px}
  .umsg{margin:0 0 7px auto;max-width:82%;width:fit-content;background:var(--vscode-charts-blue);color:#fff;padding:7px 12px;border-radius:13px 13px 4px 13px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
  .vmsg{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-panel-border);border-radius:4px 13px 13px 13px;padding:9px 13px;background:var(--vscode-sideBar-background)}
  .vmsg.pass{border-left-color:var(--vscode-charts-green)}
  .vmsg.notes{border-left-color:var(--vscode-charts-yellow)}
  .vmsg.fail{border-left-color:var(--vscode-charts-red)}
  .vmsg.inconc{border-left-color:var(--vscode-charts-orange)}
  .vhead{display:flex;align-items:center;gap:8px;margin-bottom:5px}
  .vname{font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground)}
  .vchip{font-size:11px;font-weight:700;padding:1px 9px;border-radius:999px;border:1px solid currentColor}
  .vchip.pass{color:var(--vscode-charts-green)}
  .vchip.notes{color:var(--vscode-charts-yellow)}
  .vchip.fail{color:var(--vscode-charts-red)}
  .vchip.inconc{color:var(--vscode-charts-orange)}
  .vbody{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55}
  .vbody.clip{max-height:170px;overflow:hidden;-webkit-mask-image:linear-gradient(180deg,#000 72%,transparent)}
  .more{margin-top:7px;font-size:11px;color:var(--vscode-textLink-foreground);background:none;border:0;padding:0;cursor:pointer}
  .flash{animation:savedflash 1.3s ease-out}
  @keyframes savedflash{0%,15%{color:var(--vscode-charts-green);font-weight:700}100%{color:var(--vscode-descriptionForeground);font-weight:400}}
  button:active{transform:translateY(1px)}
  /* 한눈에 보기: Claude↔Codex 흐름 지도 */
  .flowmap{margin:8px 0 26px}
  .flow{display:flex;align-items:stretch;gap:0;flex-wrap:wrap}
  .fnode{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:1px solid var(--vscode-panel-border);border-radius:9px;padding:9px 13px;background:var(--vscode-editor-background);text-align:center;font-size:11.5px;font-weight:600;min-width:72px}
  .fnode small{font-weight:400;color:var(--vscode-descriptionForeground);font-size:10px}
  .fnode.rule{border-style:dashed}
  .fnode.actor.claude{border-color:var(--vscode-charts-blue)}
  .fnode.actor.codex{border-color:var(--vscode-charts-green)}
  .fnode .mono{width:26px;height:26px;border-radius:7px;font-size:11px;margin:0 0 1px}
  .farrow{flex:1 1 78px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:78px;padding:0 5px 10px}
  .farrow .lbl{font-size:10px;line-height:1.35;text-align:center;color:var(--vscode-foreground);margin-bottom:4px}
  .farrow .ln{width:100%;height:0;border-top:2px solid var(--vscode-charts-orange);position:relative}
  .farrow .ln::after{content:"▶";position:absolute;right:-3px;top:-8px;color:var(--vscode-charts-orange);font-size:10px;line-height:1}
  .farrow.off .lbl{color:var(--vscode-descriptionForeground)}
  .farrow.off .ln{border-top-color:var(--vscode-panel-border);border-top-style:dashed}
  .farrow.off .ln::after{color:var(--vscode-panel-border)}
  /* 흐름 지도를 다른 섹션과 같은 카드로 통일 */
  .flowmap.card{margin:0 0 14px;padding:15px 16px}
  /* 단계별 기본 원칙 = 사용자 규칙과 구별되는 '고정 기준'(좌측 강조 + 옅은 배경 + 배지) */
  .card.baseline{border-left:3px solid var(--vscode-charts-purple);background:var(--vscode-textBlockQuote-background,var(--vscode-sideBar-background))}
  .fixedbadge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;border:1px solid var(--vscode-charts-purple);color:var(--vscode-charts-purple);margin-left:2px;white-space:nowrap}
  /* 카드 수신자 라벨 */
  .to{font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;border:1px solid currentColor}
  .to.claude{color:var(--vscode-charts-blue)}
  .to.codex{color:var(--vscode-charts-green)}
  /* 검증 토글 직하: '단계별 기본 원칙' 연결 패널 */
  .stagebox{margin-top:13px;border-top:1px dashed var(--vscode-panel-border);padding-top:11px}
  .sbhead{font-size:11px;font-weight:600;margin-bottom:9px}
  .sbrow{font-size:11.5px;margin:7px 0;line-height:1.5;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
  .sbrow.off{opacity:.42}
  .sbmark{font-weight:700;width:11px;display:inline-block}
  .sbrow.on .sbmark{color:var(--vscode-charts-green)}
  .sbwhy{font-size:10px;color:var(--vscode-descriptionForeground)}
  .who2{font-size:9.5px;font-weight:700;padding:1px 7px;border-radius:999px;border:1px solid currentColor}
  .who2.claude{color:var(--vscode-charts-blue)}
  .who2.codex{color:var(--vscode-charts-green)}
  .dirtyhint{font-size:11px;color:var(--vscode-charts-orange);font-weight:600;margin-top:9px}
  /* 저장 시 바뀐 지점 펄스(배경 깜빡) */
  .flashpulse{animation:flashpulse 1.5s ease-out}
  @keyframes flashpulse{0%,22%{background:var(--vscode-charts-orange);color:#fff;border-radius:5px}100%{background:transparent}}
</style></head>
<body><main class="shell">
  <section class="onboard" id="onboard" style="display:none">
    <button type="button" id="obReopen" class="obreopen" style="display:none">시작하기 다시 보기</button>
    <div id="obMain">
      <div class="obhead"><span id="obTitle">시작하기</span><button type="button" id="obClose" class="obclose secondary" style="display:none">끄기 ✕</button></div>
      <div id="obSteps">
        <div class="obstep" id="ob1"></div>
        <div class="obstep" id="ob2"></div>
        <div class="obstep" id="ob3"></div>
      </div>
      <div id="obDone" class="obdone" style="display:none">준비 끝 ✓ — 이제 매 턴 자동으로 검증됩니다.</div>
    </div>
  </section>

  <div class="top"><h1><span class="brand"></span>Codex Bridge <span class="sub">Claude ⇄ Codex 자동 연결·검증</span></h1><button id="refresh" class="secondary">↻ 새로고침</button></div>

  <div class="hero">
    <div class="agent claude"><div class="mono c">C</div><div class="nm">Claude</div><div class="ro">구현 · implement</div></div>
    <div class="link" id="linkViz"><div class="bar"></div><div class="emo" id="linkEmo">●</div><div class="st" id="linkState">연결 없음</div></div>
    <div class="agent codex"><div class="mono x">Cx</div><div class="nm">Codex</div><div class="ro">검증 · verify</div></div>
  </div>
  <div id="status" class="statusline"></div>

  <div id="integrityBanner" class="integrity" style="display:none"></div>

  <div id="liveStrip" class="livestrip" style="display:none">
    <div class="lsflow">
      <span class="lsbox claude" id="lsClaude">Claude</span>
      <span class="lsarrow" id="lsArrow">⟷</span>
      <span class="lsbox codex" id="lsCodex">Codex</span>
    </div>
    <div class="lsstage" id="lsStage"></div>
  </div>

  <h2 class="sec claude">Claude 규칙 <span class="to claude">→ Claude에게</span> <span class="sub2">Claude가 지킬 행동규칙 — 검증과 별개</span></h2>
  <div class="card">
    <div class="cblock claude">
      <div class="chead">규칙 <span class="muted" style="font-weight:400">· 기본 원칙 말고, 이 프로젝트에만 필요한 것</span></div>
      <textarea id="cClaude" rows="3" placeholder="예) 이 레포에선 ○○ 라이브러리·패턴 쓰지 마라&#10;예) 보고는 기술용어 빼고 예시로 정리해라&#10;예) 플랜 모드로 쓸 때: 영향받는 호출부·마이그레이션 순서를 플랜에 포함해라"></textarea>
      <div class="rulemeta"><span class="rchip opt">선택</span><span class="rchip">⏎ 한 줄 = 규칙 1개</span><span class="rchip">∅ 비우면 이 칸의 규칙만 안 붙음</span></div>
      <label class="ck"><input type="checkbox" id="ckClaude"> 체크리스트 강제 — 각 규칙마다 [준수/위반+근거] 달게 함</label>
      <div class="hint">☑ 켜짐 → 답변 끝에 <code>[계약점검] 1) 준수 — &lt;근거&gt; / 2) 위반 — &lt;근거&gt;</code> 형식으로 규칙별 자가보고를 강제 · ☐ 꺼짐 → 규칙 텍스트만 주입</div>
    </div>
    <label class="ck verify">넣는 시점 — 이 규칙을 <b>언제</b> Claude에 넣을지 <span id="planNow" class="nowbadge" style="display:none"></span>
      <span class="seg" id="segInject">
        <button type="button" data-im="off">꺼짐<small>안 넣음</small></button><button type="button" data-im="plan">플랜 모드<small>플랜 때만</small></button><button type="button" data-im="always">항상<small>매 턴</small></button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="플랜 모드 = Claude Code에서 shift+Tab으로 켜는 '계획 먼저 세우기' 모드. '플랜 모드'를 고르면 그 모드로 일할 때만 이 규칙이 들어갑니다.">ⓘ 플랜 모드란?</span> · <span class="ic" title="'코드 변경 시'가 없는 이유: 코드 변경은 턴이 끝나야 아는 신호라, 턴 시작에 넣는 이 축에선 못 씁니다. 검증 모드와 무관한 별도 축이에요.">ⓘ '코드 변경 시'가 없는 이유</span></div>
  </div>

  <h2 class="sec codex">검증 <span class="to codex">→ Codex</span> <span class="sub2">Codex에게 검증받기 — 끄면 검증만 안 함(Claude 규칙은 별개)</span></h2>
  <div class="card">
    <div class="cblock codex">
      <div class="chead">Codex 규칙 <span class="muted" style="font-weight:400">· 기본 검증원칙 말고, 이 프로젝트에서 특히 볼 것 · Codex 검증 때마다 붙음</span></div>
      <textarea id="cCodex" rows="3" placeholder="예) 동시성·레이스 컨디션을 중점으로 봐라&#10;예) 결제·정산은 중복 청구·반올림 오차·롤백까지 확인해라&#10;예) 단순 포맷·스타일 지적은 검증에서 빼라"></textarea>
      <div class="rulemeta"><span class="rchip opt">선택</span><span class="rchip">⏎ 한 줄 = 규칙 1개</span><span class="rchip">∅ 비우면 이 칸의 규칙만 안 붙음</span></div>
      <label class="ck"><input type="checkbox" id="ckCodex"> 체크리스트 강제 — 검증 답에 규칙별 [준수/위반+근거] 달게 함</label>
      <div class="hint">☑ 켜짐 → Codex 검증 답에도 규칙별 <code>[계약점검]</code> 자가보고 강제 · ☐ 꺼짐 → 규칙 텍스트만 붙음</div>
    </div>
    <label class="ck verify">검증 모드 — <b>언제</b> Codex 검증→보고를 강제할지
      <span class="seg" id="segVerify">
        <button type="button" data-vm="off">꺼짐<small>강제 안 함</small></button><button type="button" data-vm="code">코드 변경 시<small>편집한 턴</small></button><button type="button" data-vm="plancode">플랜 확정/코드 변경<small>플랜·편집 턴</small></button><button type="button" data-vm="always">모든 턴<small>매 응답</small></button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="플랜 확정 = 플랜 모드(shift+Tab)에서 세운 계획을 확정·제출하는 그 턴(ExitPlanMode). 플랜 모드 '내내'가 아니라 확정하는 '순간'이에요. '플랜 확정/코드 변경'은 이 플랜 확정 턴이거나 파일을 바꾼 턴에 검증을 강제합니다.">ⓘ '플랜 확정'이 뭐야?</span> · <span class="ic" title="검증이 필요한 턴은 선택한 모드가 정해요. 모든 턴=매 답변, 코드 변경 시=파일을 만든/고친 턴, 플랜 확정/코드 변경=플랜을 확정했거나 파일을 고친 턴. 그 턴엔 Codex 검증 결과를 반영해 보고해야 끝낼 수 있어요.">ⓘ 언제 검증되나?</span></div>
    <div class="stagebox" id="stageBox">
      <div class="sbhead">↑ 위 검증을 켜면 <b>흐름 단계마다 '단계별 기본 원칙'</b>이 적용돼요 <span class="muted" style="font-weight:400">· 지금 검증: <b id="sbState">—</b> · 내용은 아래 단계별 기본 원칙에서</span></div>
      <div class="sbrow" id="sbTransmit"><span class="sbmark"></span><b>① Claude→Codex 넘길 때</b> · 전달 원칙 <span class="who2 claude">Claude</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbVerify"><span class="sbmark"></span><b>② Codex가 검증할 때</b> · 검증 기본원칙 + Codex 규칙 <span class="who2 codex">Codex</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbRejudge"><span class="sbmark"></span><b>③ Codex 답을 되짚을 때</b> · 재판단 원칙 <span class="who2 claude">Claude</span> <span class="sbwhy"></span></div>
    </div>
  </div>
  <div class="row"><button id="saveC">저장</button><span id="savedAt" class="muted">· 위 Claude 규칙 · Codex 규칙 · 검증 모드를 함께 저장</span></div>

  <h2 class="sec">한눈에 보기 <span class="sub2">누구에게 · 뭐가 · 언제 들어가나 — 지금 저장된 설정 기준 (저장하면 바뀐 곳이 깜빡여요)</span></h2>
  <section class="flowmap card" id="fmSection">
    <div class="flow">
      <div class="fnode rule">Claude<br>규칙</div>
      <div class="farrow" id="faInject"><span class="lbl">넣는 시점<br><b id="faInjectVal">항상</b></span><span class="ln"></span></div>
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>구현</small></div>
      <div class="farrow off" id="faVerify"><span class="lbl">검증 맡김<br><b id="faVerifyVal">안 함</b></span><span class="ln"></span></div>
      <div class="fnode actor codex"><span class="mono x">Cx</span>Codex<small>검증</small></div>
    </div>
    <div class="dirtyhint" id="dirtyHint" style="display:none">● 토글을 바꿨어요 — <b>저장</b>해야 실제로 적용됩니다</div>
  </section>

  <details class="card baseline" id="baseDetails" style="margin-top:10px">
    <summary style="cursor:pointer;font-weight:600;font-size:13px">단계별 기본 원칙 <span class="fixedbadge">고정 기준 · 기본값 내장</span> <span class="muted" style="font-weight:400">· 검증 흐름 3단계의 기본값 (필요할 때만 편집)</span> <span id="baseOv" class="muted" style="font-weight:400"></span></summary>
    <div class="hint" style="margin:8px 0 0 0">위 <b>Claude·Codex 규칙</b>(네가 쓰는 것)과 달리, 이건 검증이 제대로 굴러가게 하는 <b>흐름 단계별 기본값</b>입니다. 평소엔 손댈 필요 없고, 잘못 고쳐도 <b>기본값 복원</b>으로 되돌아갑니다.</div>
    <div class="chead" style="margin-top:12px">① 전달 원칙 <span class="muted" style="font-weight:400">→ Claude에게 · Claude가 Codex에 넘길 때 · 검증 ON일 때만</span></div>
    <textarea id="bTransmit" rows="4"></textarea>
    <div class="chead" style="margin-top:12px">② 검증 기본원칙 <span class="muted" style="font-weight:400">→ Codex에게 · Codex 검증 때마다</span></div>
    <textarea id="bVerify" rows="5"></textarea>
    <div class="chead" style="margin-top:12px">③ 재판단 원칙 <span class="muted" style="font-weight:400">→ Claude에게 · Codex 답을 되짚을 때 · 검증 ON일 때만</span></div>
    <textarea id="bRejudge" rows="5"></textarea>
    <div class="row"><button id="saveB">단계별 기본 원칙 저장</button><button id="resetB" class="secondary">기본값 복원</button><span id="savedB" class="muted"></span></div>
  </details>
  <h2 class="sec base">코덱스 두뇌 설정 <span class="sub2">이 프로젝트에서 코덱스가 쓰는 모델·생각강도 (진행 중 대화에도 적용)</span></h2>
  <div class="mcard">
    <div class="muted">지금 쓰는 값(최근 기록): <b id="mCur">—</b></div>
    <div id="mCacheWarn" class="hint" style="display:none;margin:6px 0 0 0"></div>
    <div class="mrow"><span class="mlbl">모델</span>
      <select id="mModel" title="이 프로젝트에서 코덱스가 쓸 모델 — 계정에서 받은 목록(없으면 기본값)"></select>
    </div>
    <div class="mrow"><span class="mlbl">생각강도</span>
      <span id="segReason" class="seg"></span>
    </div>
    <div class="row" style="margin-top:10px"><button id="saveModel">두뇌 설정 저장</button><span id="savedModel" class="muted"></span></div>
    <div class="muted" style="margin-top:6px">선택은 <b>다음 코덱스 응답부터</b> 적용 · 비우면 코덱스 기본값 · 코덱스에 말 걸 때마다 자동으로 다시 실어줌</div>
  </div>
  <h2 class="sec base">검증 대기시간 <span class="sub2">코덱스 검증을 기다리는 한도 — 추론이 길면 늘리세요 (전역·모든 프로젝트 공통)</span></h2>
  <div class="mcard">
    <div class="mrow"><span class="mlbl">대기시간</span>
      <input id="vtMin" type="number" min="1" max="60" step="1" style="width:72px" title="코덱스 검증이 이 시간을 넘기면 실패로 처리합니다. 깊은 추론이 길어지면 늘리세요(1~60분).">
      <span class="muted">분 · 기본 8</span>
    </div>
    <div class="row" style="margin-top:10px"><button id="saveVT">대기시간 저장</button><span id="savedVT" class="muted"></span></div>
    <div class="muted" style="margin-top:6px">코덱스가 답하는 데 이 시간보다 오래 걸리면 검증이 실패로 끝나요. 추론이 8분을 넘는 경우가 있으면 늘려 두세요.</div>
  </div>
  <h2 class="sec codex">Codex 검증 대화 <span class="sub2">실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인</span></h2>
  <div id="conv"></div>
  <h2 class="sec base">Codex 세션 연결 <span class="sub2" id="cwsLabel">첫 발화로 식별</span></h2>
  <div id="cands"></div>
  <div id="hiddenWrap"></div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({type:"refresh"}));
  function el(tag, cls, text){ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
  // 폼에서 고른 값(curVM/curIM, 저장 시 전송) vs 저장돼 실제 적용 중인 값(appVM/appIM, 지도·'지금 받는 것'에 표시).
  // 지도/패널은 "저장된 것"만 보여주고(거짓 미리보기 방지), 저장하는 순간 바뀐 곳을 깜빡인다.
  let curVM = "off", curIM = "always";
  let appVM = null, appIM = null;
  let curPerm = "";   // 지금 Claude Code 권한 모드(active.json) — plan 게이트 표시용
  let curRS = "";     // 두뇌 설정 폼에서 고른 생각강도("" = 기본). 모델은 입력칸 값 직접 사용.
  let appRS = null, appModel = null;  // 저장돼 적용 중인 두뇌 설정(미저장 편집 보존용 dirty 비교 기준)
  let AVAIL = [];     // 계정 캐시 모델·모델별 생각강도(서버에서 받은 것 — 하드코딩 아님)
  const RSKO = {minimal:"최소", low:"낮음", medium:"보통", high:"높음", xhigh:"매우높음", pro:"프로"}; // 표시 라벨(없는 값은 원문)
  // 선택한 모델이 지원하는 생각강도만 버튼으로(계정·모델별로 다름). 모델 미선택이면 가능한 값 합집합.
  function renderReasonButtons(slug){
    const seg=$("segReason"); if(!seg) return; seg.replaceChildren();
    let levels=[]; const m=AVAIL.find((x)=>x.slug===slug);
    if(m) levels=m.levels;
    else { const u=new Map(); AVAIL.forEach((x)=>x.levels.forEach((l)=>u.set(l.effort,l.description))); levels=[...u].map(([effort,description])=>({effort,description})); }
    const cacheOk = AVAIL.length>0;
    if(!levels.length) levels=["low","medium","high"].map((e)=>({effort:e,description:""})); // 캐시/레벨 전무 폴백
    // 저장된 선택이 목록에 없을 때: 캐시 정상 & 그 모델이 진짜 안 받으면 기본으로 리셋(모델 전환).
    // 그 외(캐시 실패·커스텀/미매칭 모델)엔 저장값을 raw 버튼으로 보존해 절대 잃지 않게 한다.
    if(curRS && !levels.some((l)=>l.effort===curRS)){
      if(cacheOk && m) curRS="";
      else levels=[...levels,{effort:curRS,description:"저장된 값(현재 목록에 없음)"}];
    }
    const mk=(rs,label,desc)=>{const b=document.createElement("button");b.setAttribute("data-rs",rs);b.textContent=label;if(desc)b.title=desc;return b;};
    seg.appendChild(mk("","기본"));
    levels.forEach((l)=> seg.appendChild(mk(l.effort, RSKO[l.effort]||l.effort, l.description)));
    highlightSeg("segReason","data-rs",curRS);
  }
  let shownVM, shownIM, shownPerm;   // 마지막으로 그린 상태 — watcher 중복 렌더가 진행 중 깜빡임을 지우지 않게
  function lblIM(im){ return im==="off"?"꺼짐":im==="plan"?"플랜 때만":"항상"; }
  function lblVM(vm){ return vm==="off"?"안 함":vm==="code"?"코드 변경 시":vm==="plancode"?"플랜·코드 시":"모든 턴"; }
  function flashNode(n){ if(!n) return; n.classList.remove("flashpulse"); void n.offsetWidth; n.classList.add("flashpulse"); }
  function setStage(node, on, why){ if(!node) return; node.classList.toggle("off", !on); node.classList.toggle("on", on); const m=node.querySelector(".sbmark"); if(m) m.textContent=on?"✓":"✗"; const w=node.querySelector(".sbwhy"); if(w) w.textContent=why; }
  // 저장된 상태(appVM/appIM)로 지도 화살표 + '지금 받는 것'을 그린다. prev와 다른 항목은 깜빡.
  function renderApplied(prevVM, prevIM){
    if(shownVM===appVM && shownIM===appIM && shownPerm===curPerm) return;  // 변화 없으면 DOM 안 건드림 → 진행 중 깜빡임 보존
    shownVM=appVM; shownIM=appIM; shownPerm=curPerm;
    const inj=$("faInject"), ver=$("faVerify");
    if(inj){ inj.className="farrow"+(appIM!=="off"?"":" off"); const v=$("faInjectVal"); if(v) v.textContent=lblIM(appIM); }
    if(ver){ ver.className="farrow"+(appVM!=="off"?"":" off"); const v=$("faVerifyVal"); if(v) v.textContent=lblVM(appVM); }
    // 검증 토글 직하 단계 패널: 검증 ON이면 ①③ 켜짐, ②는 검증할 때. OFF면 ①③ 꺼짐, ②는 수동 ask 때만.
    const von = appVM!=="off";
    const st=$("sbState"); if(st) st.textContent = von ? lblVM(appVM) : "꺼짐";
    setStage($("sbTransmit"), von, von?"검증 켜짐 → 적용":"검증 꺼짐 → 안 들어감");
    setStage($("sbVerify"), von, von?"검증할 때 적용":"자동 검증 없음 (수동 ask 땐 들어감)");
    setStage($("sbRejudge"), von, von?"검증 켜짐 → 적용":"검증 꺼짐 → 안 들어감");
    if(prevIM!=null && prevIM!==appIM){ flashNode(inj); }
    if(prevVM!=null && prevVM!==appVM){ flashNode(ver); flashNode($("sbTransmit")); flashNode($("sbVerify")); flashNode($("sbRejudge")); }
  }
  function highlightSeg(segId, attr, v){ const s=$(segId); if(s) s.querySelectorAll("button").forEach((b)=>b.classList.toggle("on", b.getAttribute(attr)===v)); }
  function markDirty(){ const d=$("dirtyHint"); if(d) d.style.display = ((curVM!==appVM)||(curIM!==appIM)) ? "" : "none"; }
  $("segVerify").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-vm]"); if(b){ curVM=b.getAttribute("data-vm"); highlightSeg("segVerify","data-vm",curVM); markDirty(); } });
  $("segInject").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-im]"); if(b){ curIM=b.getAttribute("data-im"); highlightSeg("segInject","data-im",curIM); markDirty(); } });
  $("segReason").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-rs]"); if(b){ curRS=b.getAttribute("data-rs"); highlightSeg("segReason","data-rs",curRS); } });
  $("mModel").addEventListener("change", ()=> renderReasonButtons($("mModel").value.trim()));  // 모델 바꾸면 그 모델의 생각강도로 버튼 교체(select=change)
  $("saveModel").addEventListener("click", () => {
    pendingSave = {target:"model"};  // 성공 플래시는 saveResult(ok) 받을 때
    vscode.postMessage({type:"saveModelPref", model: $("mModel").value.trim(), reasoning: curRS});
  });
  $("saveVT").addEventListener("click", () => {
    let n = parseInt($("vtMin").value, 10);
    if (!Number.isFinite(n)) n = 8;
    n = Math.max(1, Math.min(60, n));  // 1~60분(브릿지와 같은 규칙) — 잘못된 입력은 보정
    $("vtMin").value = n;
    pendingSave = {target:"timeout"};
    vscode.postMessage({type:"saveVerifyTimeout", min: n});
  });
  function flashSaved(node, msg){ if(!node) return; node.textContent = msg || "저장됨 ✓ (다음 턴부터 적용)"; node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash"); }
  $("cands").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-relink]");
    if (b) { vscode.postMessage({type:"relink", id:b.getAttribute("data-relink")}); return; }
    const x = ev.target.closest("[data-del]");
    if (x) { vscode.postMessage({type:"hideSession", id:x.getAttribute("data-del")}); return; }
  });
  $("hiddenWrap").addEventListener("click", (ev) => {
    const t = ev.target.closest("#hiddenToggle");
    if (t) { const box=$("hiddenList"); const open=box.style.display==="none"; box.style.display=open?"":"none"; t.textContent = open ? "숨긴 세션 접기" : "숨긴 세션 " + box.children.length + "개 보기"; return; }
    const r = ev.target.closest("[data-restore]");
    if (r) { vscode.postMessage({type:"restoreSession", id:r.getAttribute("data-restore")}); return; }
    const p = ev.target.closest("[data-purge]");
    if (p) { vscode.postMessage({type:"purgeSession", id:p.getAttribute("data-purge")}); return; }
    const x = ev.target.closest("[data-del]");
    if (x) { vscode.postMessage({type:"hideSession", id:x.getAttribute("data-del")}); return; }
  });
  // 온보딩: '이동' 버튼=대상 스크롤+강조, 끄기=기억 dismiss, 다시 보기=복원
  $("onboard").addEventListener("click", (ev) => {
    const g = ev.target.closest("[data-go]");
    if (g) { const t=$(g.getAttribute("data-go")); if(t){ clearTimeout(pendingScroll); t.scrollIntoView({behavior:"smooth",block:"center"}); t.classList.remove("glow"); void t.offsetWidth; t.classList.add("glow"); } return; }
    const c = ev.target.closest("[data-cmd]");
    if (c) { vscode.postMessage({type:c.getAttribute("data-cmd")}); return; }
    if (ev.target.closest("#obClose")) { vscode.postMessage({type:"dismissOnboard"}); return; }
    if (ev.target.closest("#obReopen")) { vscode.postMessage({type:"showOnboard"}); return; }
  });
  let pendingScroll;  // 대기 중 스크롤 타이머(연속 저장 시 취소용)
  let pendingSave = null;  // 저장 요청의 의도(성공 시 어떤 피드백을 줄지) — saveResult(ok) 받을 때 사용
  $("saveC").addEventListener("click", () => {
    clearTimeout(pendingScroll);  // 직전 저장의 대기 스크롤 취소
    const toLines = (s) => s.split("\\n").map((x) => x.trim()).filter(Boolean);
    const imCh = curIM!==appIM, vmCh = curVM!==appVM;  // 도안(넣는 시점/검증 모드)에 영향 주는 변경인가 — 성공 시 펄스용
    pendingSave = {target:"contract", imCh, vmCh};
    vscode.postMessage({type:"saveContract",
      claude: toLines($("cClaude").value), codex: toLines($("cCodex").value),
      claudeChecklist: $("ckClaude").checked, codexChecklist: $("ckCodex").checked, verifyMode: curVM, claudeInjectMode: curIM});
    // 성공 플래시·스크롤은 saveResult(ok)에서 (저장 실패 시 거짓 성공 방지)
  });
  $("saveB").addEventListener("click", () => {
    pendingSave = {target:"base"};
    vscode.postMessage({type:"saveBase", verifyBaseline:$("bVerify").value, transmit:$("bTransmit").value, rejudge:$("bRejudge").value});
  });
  $("resetB").addEventListener("click", () => { pendingSave = {target:"base", msg:"기본값으로 복원됨 ✓"}; vscode.postMessage({type:"resetBase"}); });
  // 기본 원칙 편집 '시작'(필드 첫 포커스) 시점 경고 — 필드별 다른 메시지(전달/재판단 vs 검증 기본원칙).
  // ⚠️ textarea 포커스는 절대 안 건드린다: blur()/재focus() 없음. 모달(modal:true)이 편집을 막고 포커스는 자연스럽게 유지되므로,
  // render의 '포커스 중이면 저장값으로 안 덮어씀' 가드(아래)와 충돌하지 않는다 → 편집/저장 보존(0.1.23 blur 버그의 교훈).
  var baseWarned = {}, baseWarnPending = false, baseDirty = {}, contractDirty = {};
  [["bTransmit","transmit"],["bVerify","verify"],["bRejudge","rejudge"]].forEach(function(pr){
    var elx = $(pr[0]); if(!elx) return;
    // 편집 시작 = dirty → 저장 전까지 render가 이 칸을 저장값으로 덮지 않는다(포커스가 잠깐 빠져도 편집 보존). 저장 성공 시 해제.
    elx.addEventListener("input", function(){ baseDirty[pr[1]] = true; });
    elx.addEventListener("focus", function(){
      if(baseWarned[pr[1]] || baseWarnPending) return;
      baseWarnPending = true; // blur 안 함 — 포커스 유지
      vscode.postMessage({type:"baseEditWarn", field:pr[1]});
    });
  });
  [["cClaude","claude"],["cCodex","codex"]].forEach(function(pr){ // 계약 카드도 같은 race → 동일 보호
    var elx = $(pr[0]); if(!elx) return;
    elx.addEventListener("input", function(){ contractDirty[pr[1]] = true; });
  });
  window.addEventListener("message", (ev) => {
    if (ev.data?.type === "baseEditWarnResult") {
      baseWarnPending = false;
      if (ev.data.ok) baseWarned[ev.data.field] = true; // 승인 → 그 필드 재경고 안 함. 포커스/편집값 안 건드림
      return; // 취소면 baseWarned 안 세팅(다음 포커스에 재경고). 포커스/편집값 안 건드림
    }
    if (ev.data?.type === "saveResult") {
      // 저장 성공 피드백은 '확장이 실제 저장에 성공했다고 알려줄 때'만 — 클릭 즉시가 아니라(거짓 성공 방지).
      const ps = pendingSave; pendingSave = null;
      if (!ev.data.ok) return; // 실패: 네이티브 에러 토스트가 알린다. 성공 플래시·스크롤은 하지 않음.
      if (ev.data.target === "base") baseDirty = {}; // 저장 성공 → dirty 해제(저장값=표시값이 됐으니 render 동기화 재개)
      else if (ev.data.target === "contract") contractDirty = {};
      if (ev.data.target === "model") flashSaved($("savedModel"), "저장됨 ✓ (다음 코덱스 응답부터 적용)");
      else if (ev.data.target === "timeout") flashSaved($("savedVT"), "저장됨 ✓ (다음 검증부터 적용)");
      else if (ev.data.target === "base") flashSaved($("savedB"), ps && ps.msg);
      else if (ev.data.target === "contract") {
        flashSaved($("savedAt"));
        if (ps && (ps.imCh || ps.vmCh) && appVM !== null) {  // 넣는시점/검증모드가 바뀐 저장만 도안으로 스크롤+펄스
          clearTimeout(pendingScroll);
          pendingScroll = setTimeout(() => {
            const fm = $("fmSection"); if (fm) fm.scrollIntoView({ behavior: "smooth", block: "center" });
            if (ps.imCh) flashNode($("faInject"));
            if (ps.vmCh) { flashNode($("faVerify")); flashNode($("sbTransmit")); flashNode($("sbVerify")); flashNode($("sbRejudge")); }
          }, 60);
        }
      }
      return;
    }
    if (ev.data?.type !== "data") return;
    const d = ev.data.data;
    curPerm = d.permissionMode || "";   // renderApplied의 plan 게이트 표시에 사용
    if (d.contract){
      if (document.activeElement !== $("cClaude") && !contractDirty.claude) $("cClaude").value = (d.contract.claude||[]).join("\\n");
      if (document.activeElement !== $("cCodex") && !contractDirty.codex) $("cCodex").value = (d.contract.codex||[]).join("\\n");
      $("ckClaude").checked = d.contract.claudeChecklist !== false;
      $("ckCodex").checked = d.contract.codexChecklist !== false;
      const first = (appVM===null);
      const pVM=appVM, pIM=appIM;
      appVM = d.contract.verifyMode || "off";
      appIM = d.contract.claudeInjectMode || "always";
      // 사용자가 저장 안 한 토글 변경을 들고 있으면(dirty) 폼 선택을 보존, 아니면 저장값으로 동기화.
      const dirty = !first && ((curVM!==pVM)||(curIM!==pIM));
      if(first || !dirty){ curVM=appVM; curIM=appIM; highlightSeg("segVerify","data-vm",curVM); highlightSeg("segInject","data-im",curIM); }
      renderApplied(first?undefined:pVM, first?undefined:pIM);  // 저장/변경 반영 후 바뀐 축을 깜빡(첫 렌더는 깜빡 없음)
      markDirty();
    }
    // ④ 플랜 라이브표시: 지금 플랜 모드인가(active.json permissionMode)
    const pn = $("planNow");
    if (pn){
      // 배지는 '넣는 시점=플랜 모드'(저장값)일 때만 표시. 텍스트는 지금 Claude Code가 플랜 모드인지 여부만 알림.
      if((d.contract && d.contract.claudeInjectMode)==="plan"){
        pn.style.display="";
        pn.textContent = d.permissionMode==="plan" ? "지금 플랜 모드예요 ✓" : "지금은 플랜 모드 아니에요";
      } else { pn.style.display="none"; }
    }
    // 온보딩: 미완료=설명 단계(이동 버튼·은은한 펄스) / 완료=축하+끄기 / 끄고 완료=다시보기 링크만.
    // 미완료(연결 끊김·검증 꺼짐)면 끄기 여부와 무관하게 단계가 다시 보여 '고장'을 숨기지 않음.
    (function(){
      const ob=$("onboard"); if(!ob) return;
      const codexReady = !!d.codexReady, linked = !!d.linkedId;
      const vOn = !!(d.contract && d.contract.verifyMode && d.contract.verifyMode!=="off");
      const allDone = linked && vOn;            // codex 준비는 연결로 함의됨
      const dismissed = !!d.onboardDismissed;
      ob.style.display = "";
      if (allDone && dismissed){                // 완료 + 사용자가 끔 → 작은 '다시 보기' 링크만
        ob.className = "onboard"; $("obReopen").style.display = ""; $("obMain").style.display = "none";
        return;
      }
      $("obReopen").style.display = "none"; $("obMain").style.display = "";
      ob.className = "onboard " + (allDone ? "complete" : "incomplete");
      $("obTitle").textContent = allDone ? "준비 끝 ✓" : "시작하기 — 3가지면 매 턴 자동 검증";
      $("obClose").style.display = allDone ? "" : "none";
      $("obSteps").style.display = allDone ? "none" : "";
      $("obDone").style.display = allDone ? "" : "none";
      if (!allDone){
        const step=(id,done,text,btn,where)=>{ const e=$(id); if(!e) return;
          e.className="obstep "+(done?"done":"todo");
          let b="";
          if(!done && btn){ if(btn.go) b=' <button type="button" class="obgo secondary" data-go="'+btn.go+'">이동 ›</button>'; else if(btn.cmd) b=' <button type="button" class="obgo secondary" data-cmd="'+btn.cmd+'">설정 ›</button>'; }
          e.innerHTML='<span class="k">'+(done?"✓":"○")+'</span>'+text+(where?' <span class="where">'+where+'</span>':'')+b; };
        step("ob1", codexReady, codexReady?"Codex 준비됨":"Codex 확장/경로 미확인", {cmd:"openSettings"}, codexReady?"":"설치돼 있으면 보통 자동 · 안 되면 경로 지정");
        step("ob2", linked, linked?"Codex 세션 연결됨":"Codex 세션 미연결", {go:"cands"}, linked?"":"연결할 세션 고르기");
        step("ob3", vOn, vOn?("검증 켜짐 ("+d.contract.verifyMode+")"):"검증 꺼짐", {go:"segVerify"}, vOn?"":"검증 모드 켜고 저장");
      }
    })();
    if (d.baseDirective){
      if (document.activeElement !== $("bVerify") && !baseDirty.verify) $("bVerify").value = d.baseDirective.verifyBaseline||"";
      if (document.activeElement !== $("bTransmit") && !baseDirty.transmit) $("bTransmit").value = d.baseDirective.transmit||"";
      if (document.activeElement !== $("bRejudge") && !baseDirty.rejudge) $("bRejudge").value = d.baseDirective.rejudge||"";
      const ov=$("baseOv"); if(ov) ov.textContent = d.baseDirective.overridden ? "· (수정됨)" : "· (기본값)";
    }
    // 런타임 라이브러리 없으면 저장/복원이 무효 → 거짓 성공 방지: 버튼 비활성 + 경고(점2 수정).
    const baseOk = d.baseAvailable !== false;
    if ($("saveB")) $("saveB").disabled = !baseOk;
    if ($("resetB")) $("resetB").disabled = !baseOk;
    if (!baseOk){ const ov=$("baseOv"); if(ov) ov.textContent = "· ⚠ 런타임 라이브러리를 찾을 수 없어 편집 불가"; const sb=$("savedB"); if(sb) sb.textContent=""; }
    // 히어로 연결 상태 시각화
    const linked = !!d.linkedId;
    $("linkViz").className = "link" + (linked ? " on" : "");
    $("linkEmo").textContent = "●"; // 색은 .link.on .emo가 처리(연결=초록/미연결=회색)
    $("linkState").textContent = linked ? "연결됨" : "연결 없음";
    // statusline: 검증 모드 배지 + 연결 요약
    const st = $("status"); st.replaceChildren();
    const vm = (d.contract && d.contract.verifyMode) || "off";
    const vmTxt = {off:"검증 꺼짐", code:"코드 변경 시 검증", plancode:"플랜+코드 검증", always:"모든 턴 검증"}[vm] || vm;
    st.appendChild(el("span","badge b-"+vm, vmTxt));
    if (d.workspace) st.appendChild(el("span","wschip", d.workspace));
    if (!d.workspace) st.appendChild(el("span","muted","· 워크스페이스가 열려있지 않음"));
    else if (linked) {
      st.appendChild(el("span","muted","· " + (d.linkedSnippet || "(주제 미상)")));
      st.appendChild(el("span","id", d.linkedId));
    } else {
      st.appendChild(el("span","muted","· 아래에서 Codex 세션을 골라 연결 (미연결 시 ask는 보고만)"));
    }
    const cws = $("cwsLabel"); if (cws) cws.textContent = d.workspace ? ("선택 시 → " + d.workspace + " 에 연결") : "열린 워크스페이스 없음";

    // 무결성 경보 배너: 미확인 error 이벤트(예: 검증 미완)를 빨강으로 보이고 '확인함'으로 해제.
    const ib = $("integrityBanner");
    if (ib) {
      const iev = (d.integrity||[]).filter(function(e){return e && !e.ack && (e.severity==="error"||e.severity==="warning");});
      if (!iev.length) { ib.style.display="none"; ib.replaceChildren(); ib.className="integrity"; }
      else {
        const nerr = iev.filter(function(e){return e.severity==="error";}).length;
        const warnEvs = iev.filter(function(e){return e.severity==="warning";});
        const nVerdict = warnEvs.filter(function(e){return e.kind==="verdict-nonclean";}).length;
        const nEvid = warnEvs.length - nVerdict; // 근거(evidence-*) 계열
        const warnParts = [];
        if (nVerdict) warnParts.push("Codex 결론 주의 " + nVerdict + "건"); // 통과 아님(실패/불가/보류)
        if (nEvid) warnParts.push("근거 의심 " + nEvid + "건"); // 인용 근거가 파일/라인과 안 맞음
        const warnStr = warnParts.join(" · ");
        ib.replaceChildren();
        ib.className = "integrity" + (nerr ? " err" : " warn"); // 빨강(미완) 있으면 빨강 테두리, 아니면 노랑
        const ih = el("div","ih");
        const head = nerr ? ("검증 무결성 경보 — 검증 미완 " + nerr + "건" + (warnStr ? " · " + warnStr : ""))
                          : ("검증 무결성 경보 — " + warnStr);
        ih.appendChild(el("span", null, head));
        const ack = el("button","secondary","확인함 ✓");
        ack.addEventListener("click", function(){ vscode.postMessage({type:"ackIntegrity", ids: iev.map(function(e){return e.id;})}); }); // 보이는(이 창) 경보만 확인 — 다른 창 것 안 지움
        ih.appendChild(ack); ib.appendChild(ih);
        const ul = el("ul");
        iev.slice(-6).forEach(function(e){
          const li = el("li");
          li.appendChild(el("span","sevdot " + (e.severity==="error"?"err":"warn")));
          li.appendChild(document.createTextNode(e.detail || e.kind || "무결성 신호"));
          if (e.ts) li.appendChild(el("span","when","  ("+new Date(e.ts).toLocaleString()+")"));
          ul.appendChild(li);
        });
        ib.appendChild(ul); ib.style.display="";
      }
    }

    // 검증 진행 스트립: 라이브 단계가 있으면 [Claude]⟷[Codex] 방향+활성 박스+단계칩. (완료/대기면 숨김)
    const ls = $("liveStrip");
    if (ls) {
      const lv = d.live;
      if (!lv || lv.key === "done") { ls.style.display="none"; }
      else {
        const toCodex = (lv.key === "codex-req" || lv.key === "codex-gen");
        const toClaude = (lv.key === "rejudge");
        $("lsArrow").textContent = toCodex ? "▶▶▶ 검증중" : toClaude ? "반영중 ◀◀◀" : "⟷";
        $("lsArrow").className = "lsarrow " + (toCodex ? "tocodex" : toClaude ? "toclaude" : "");
        $("lsClaude").className = "lsbox claude" + ((lv.key==="claude"||toClaude) ? " on" : "");
        $("lsCodex").className = "lsbox codex" + (toCodex ? " on" : "");
        const sg = $("lsStage"); sg.replaceChildren();
        sg.appendChild(el("span","lschip "+lv.key, lv.label + (lv.round>1 ? " · "+lv.round+"라운드" : "")));
        ls.style.display="";
      }
    }

    const conv = $("conv"); conv.replaceChildren();
    if (!d.linkedId) conv.appendChild(el("div","card muted","아직 연결된 Codex 세션이 없어요. 아래에서 세션을 연결하면, 구현↔검증으로 실제 주고받은 대화가 여기에 그대로 표시됩니다(눈으로 검증 확인)."));
    else if (!d.turns.length) conv.appendChild(el("div","card muted","연결됨 — 아직 주고받은 대화가 없습니다(또는 세션 파일을 못 찾음)."));
    else {
      d.turns.forEach((t) => {
        const wrap = el("div","turn");
        if (t.user) wrap.appendChild(el("div","umsg", t.user));
        let body=null, more=null;
        if (t.assistant.length){
          const txt = t.assistant.join("\\n\\n");
          const vd = t.verdict || null; // 호스트가 extractVerdict로 계산해 넘긴 '마지막 결론'(첫 줄 추측 아님)
          // 4단계: 통과(초록)/통과·보완(노랑)/결론 보류(주황)/실패(빨강). '통과·보완'은 보류와 분리(엄연히 통과).
          const vmap = {"pass":["pass","검증 통과"],"pass-notes":["notes","통과·보완"],"inconclusive":["inconc","결론 보류"],"fail":["fail","검증 실패"]};
          const vinfo = vd ? vmap[vd] : null;
          const v = el("div", "vmsg" + (vinfo ? " " + vinfo[0] : ""));
          const head = el("div","vhead");
          head.appendChild(el("span","vname","Codex"));
          if (vinfo) head.appendChild(el("span","vchip " + vinfo[0], vinfo[1]));
          v.appendChild(head);
          body = el("div","vbody clip", txt);
          v.appendChild(body);
          more = el("button","more","펼치기 ▾");
          more.addEventListener("click", () => { const clipped = body.classList.toggle("clip"); more.textContent = clipped ? "펼치기 ▾" : "접기 ▴"; });
          v.appendChild(more);
          wrap.appendChild(v);
        }
        conv.appendChild(wrap);
        if (body && more && body.scrollHeight <= body.clientHeight + 2){ body.classList.remove("clip"); more.style.display = "none"; }
      });
    }
    const mkRow = (c, hidden) => {
      const row = el("div","cand" + (c.linked?" linked":""));
      const left = el("div");
      const idline = el("div","id", c.id + (c.linked?"  ":""));
      if (c.linked) idline.appendChild(el("span","star","★연결됨"));
      left.appendChild(idline);
      left.appendChild(el("div","muted", c.when + " · " + c.snippet));
      row.appendChild(left);
      const acts = el("div","cacts");
      if (hidden){
        const r=el("button","secondary","복원"); r.setAttribute("data-restore", c.id); acts.appendChild(r);
        const p=el("button","secondary del","삭제"); p.title="영구 삭제 (대화 파일이 지워지며 되돌릴 수 없음)"; p.setAttribute("data-purge", c.id); acts.appendChild(p);
      } else {
        if (!c.linked){ const b=el("button",null,"연결"); b.setAttribute("data-relink", c.id); acts.appendChild(b); }
        const x=el("button","secondary del","숨김"); x.title="목록에서 숨기기 (원본 파일은 보존 · 복원 가능)"; x.setAttribute("data-del", c.id); acts.appendChild(x);
      }
      row.appendChild(acts);
      return row;
    };
    const cs = $("cands"); cs.replaceChildren();
    d.candidates.forEach((c) => cs.appendChild(mkRow(c, false)));
    // 숨긴 세션: 접힌 채로, 개수 토글로 펼침 (원본은 지우지 않음)
    const hw = $("hiddenWrap"); hw.replaceChildren();
    if (d.hiddenCandidates && d.hiddenCandidates.length){
      const n = d.hiddenCandidates.length;
      const tg = el("button","linklike","숨긴 세션 " + n + "개 보기"); tg.id="hiddenToggle";
      const box = el("div"); box.id="hiddenList"; box.style.display="none";
      d.hiddenCandidates.forEach((c) => box.appendChild(mkRow(c, true)));
      hw.appendChild(tg); hw.appendChild(box);
    }
    // 두뇌 설정(모델·생각강도): 현재값 보기 + 저장된 선택 반영(미저장 편집은 보존). 옵션은 계정 캐시 기반.
    AVAIL = d.availModels || [];
    const cw=$("mCacheWarn"); if(cw){ cw.textContent=d.modelsCacheNote||""; cw.style.display=d.modelsCacheNote?"":"none"; }
    const nameOf=(slug)=>{ const m=AVAIL.find((x)=>x.slug===slug); return m?m.name:(slug||""); };
    const effLabel=(e)=>RSKO[e]||(e||"미상");
    $("mCur").textContent = d.linkedId ? ((nameOf(d.modelCurrent)||"미상")+" · 생각강도 "+effLabel(d.effortCurrent)) : "연결된 세션 없음";
    // 모델 선택 = <select> 드롭다운(항상 전체 목록). 옛 <input list=datalist>는 입력값으로 후보를 필터해서
    // 저장된 모델이 채워지면 그 모델만 보이는 버그가 있었음 → select로 교체(전체가 늘 보임).
    const sel=$("mModel");
    const prevModelVal = sel.value; // ★ replaceChildren가 select 값을 ""로 리셋하므로, dirty 비교·복원용으로 먼저 보관
    sel.replaceChildren();
    const addOpt=(v,t)=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; sel.appendChild(o); };
    addOpt("", "(코덱스 기본값)");
    const opts = AVAIL.length ? AVAIL.map((m)=>({v:m.slug,t:m.name})) : (d.knownModels||[]).map((s)=>({v:s,t:s}));
    opts.forEach(({v,t})=> addOpt(v, (t&&t!==v) ? (t+" ("+v+")") : v));
    const savedM = d.modelPref||"";
    if(savedM && !opts.some((o)=>o.v===savedM)) addOpt(savedM, savedM+" (저장된 값 · 현재 목록에 없음)"); // 목록 밖 저장값 보존(조용히 안 바뀌게)
    const firstM=(appModel===null), pRS=appRS, pModel=appModel;
    appRS=d.reasoningPref||""; appModel=d.modelPref||"";
    // dirty 비교는 'replaceChildren 전 값(prevModelVal)'으로 — 안 그러면 select가 ""로 리셋돼 늘 dirty 오판.
    const mDirty=!firstM && ((curRS!==pRS) || (prevModelVal!==(pModel||"")));
    if(firstM || !mDirty){ curRS=appRS; sel.value=appModel; } // 편집 중 아니면 저장값 표시(복원)
    else { sel.value=prevModelVal; } // 편집 중이면 사용자가 고르던 값 되돌림(replaceChildren 리셋 보정)
    renderReasonButtons($("mModel").value.trim());  // 현재 모델 기준 생각강도 버튼(내부에서 curRS 하이라이트/검증)
    const vt=$("vtMin"); if(vt && document.activeElement!==vt) vt.value = d.verifyTimeoutMin || 8; // 편집 중이 아니면 저장값 표시
  });
</script></body></html>`;
  }
}

function getNonce(): string {
  const p = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  for (let i = 0; i < 32; i++) t += p.charAt(Math.floor(Math.random() * p.length));
  return t;
}

function readTextSafe(f: string): string {
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    return "";
  }
}

// '사용자가 실제 쓰는 codex' 실행파일 경로를 정한다.
//  1) 설정 codexBridge.codexPath (직접 지정) — 최우선
//  2) 설치된 Codex 제공 확장(openai.chatgpt 등) 내부의 codex 실행파일 — vscode API로 위치 확인
//     (포터블/설치형·버전 폴더 변경에 안 깨짐). 우리 확장(codex-bridge/usage)은 제외.
// 못 찾으면 undefined → 브릿지가 PATH 의 codex 로 폴백.
function resolveCodexPathForBridge(): string | undefined {
  const configured = vscode.workspace.getConfiguration("codexBridge").get<string>("codexPath", "").trim();
  if (configured && fs.existsSync(configured)) return configured;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  for (const ext of vscode.extensions.all) {
    const id = ext.id.toLowerCase();
    if (!/chatgpt|codex/.test(id) || /codex-bridge|codex-usage/.test(id)) continue; // 형제 codex만
    const binRoot = path.join(ext.extensionPath, "bin");
    try {
      for (const plat of fs.readdirSync(binRoot)) {
        const cand = path.join(binRoot, plat, exe);
        if (fs.existsSync(cand)) return cand;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// 위 결과를 ~/.codex-bridge/codex-bin.txt 에 기록(브릿지 훅이 읽음). 확장 활성화·설정변경마다 갱신.
// → 자동추적: 버전업/포터블↔설치형 전환에도 항상 현재 위치. 못 찾으면 파일을 지워 PATH 폴백.
function syncCodexBin(): void {
  const f = path.join(BRIDGE_DIR,"codex-bin.txt");
  const found = resolveCodexPathForBridge();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (found) {
      if (readTextSafe(f) !== found) atomicWrite(f, found);
    } else if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
    }
  } catch {
    /* ignore */
  }
}

// V11: codex가 실제 쓰는 home을 'codex doctor'로 1회 탐지 → codex-home.txt 기록 + 메모리 SESSIONS_DIR 갱신.
// 브릿지(codex-home.txt 읽음)와 대시보드가 같은 세션 폴더를 보게 한다. 못 찾으면(또는 PATH-only codex) 스킵·폴백.
function syncCodexHome(onDone: (changed: boolean) => void): void {
  let done = false;
  const finish = (c: boolean) => { if (done) return; done = true; onDone(c); };
  const codex = resolveCodexPathForBridge();
  if (!codex) { finish(false); return; }
  // .js codex는 node 래핑 필요. 확장은 electron이라 process.execPath가 node가 아님(Code.exe) →
  // ELECTRON_RUN_AS_NODE=1로 electron을 node처럼 띄워 codex.js doctor 실행(VS Code 확장 표준 기법, node PATH 불요).
  const isJs = /\.js$/i.test(codex);
  const useShell = !isJs && /\.(cmd|bat)$/i.test(codex);
  const file = isJs ? process.execPath : codex;
  const args = isJs ? [codex, "doctor"] : ["doctor"];
  const opts: any = { windowsHide: true, shell: useShell };
  if (isJs) opts.env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  let out = "";
  try {
    const cp = spawn(file, args, opts);
    cp.stdout?.on("data", (d) => (out += d.toString()));
    cp.stderr?.on("data", (d) => (out += d.toString()));
    cp.on("error", () => finish(false));
    cp.on("close", () => {
      // ⚠ 세션찾기 고장 시 1순위 점검: codex 업데이트로 'codex doctor' 출력 형식이 바뀌면 이 파싱이 깨진다.
      const m = out.match(/^\s*CODEX_HOME\s+([^\r\n]+?)\s*\(dir\)\s*$/m);
      const home = m ? m[1].trim() : "";
      let changed = false;
      try {
        if (home && fs.existsSync(home)) {
          const f = path.join(BRIDGE_DIR,"codex-home.txt");
          // 파일이 이미 같거나(=공유 상태 일치) 새로 쓰기 성공한 경우에만 메모리 home 갱신. 쓰기 실패 시
          // 메모리만 새 home으로 바꾸면 확장은 새 home·브릿지는 옛 home을 봐 '확장·브릿지 일치'가 깨진다 → 갱신 보류.
          const persisted = readTextSafe(f) === home || atomicWrite(f, home);
          if (persisted) {
            if (CODEX_HOME !== home) { CODEX_HOME = home; SESSIONS_DIR = path.join(home, "sessions"); changed = true; }
          } else {
            console.error("[codex-bridge] codex-home.txt 기록 실패 — home 갱신 보류(확장·브릿지 일치 유지, 다음 활성화 때 재시도).");
          }
        }
      } catch {
        /* ignore */
      }
      finish(changed);
    });
  } catch {
    finish(false);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  syncCodexBin(); // 브릿지가 쓸 codex 경로를 최신 확장 기준으로 기록
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codexBridge.codexPath")) syncCodexBin();
    }),
  );
  const turnsN = () => Math.max(1, vscode.workspace.getConfiguration("codexBridge").get<number>("recentTurns", 5));
  const dashboard = new Dashboard(context.extensionUri, turnsN);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 950);
  status.command = "codexBridge.openDashboard"; // 클릭=대시보드. 확인/대시보드 선택은 호버 툴팁의 클릭 링크로(상태바 '바로 위')
  status.name = "Codex Bridge";

  // 검증 진행 '흐름' = [🧑Claude] ▶▶검증중 [🔍Codex] 를 인접한 3개 항목으로 표현. 상태바 항목 1개는 색이 1개뿐이라,
  // 박스별 색을 주려면 항목을 나눠야 한다(우선순위 953>952>951이라 왼→오 인접 배치). 진행 중에만 보이고 평소 숨김.
  // 배경 '채움색'은 VS Code가 error/warning만 허용 → 단계 구분은 '글자색'으로(빨강 배경은 무결성 경보 전용).
  const fClaude = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 953);
  const fArrow = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 952);
  const fCodex = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 951);
  for (const it of [fClaude, fArrow, fCodex]) { it.command = "codexBridge.openDashboard"; it.name = "Codex Bridge 검증 진행"; }
  const flowHide = () => { fClaude.hide(); fArrow.hide(); fCodex.hide(); };
  context.subscriptions.push(fClaude, fArrow, fCodex);

  // 무결성 경보 펄스: 새 error 이벤트가 '늘었을 때만' 잠깐(6회 ~3초) 빨강↔주황 토글 후 빨강 지속.
  // 끝없는 점멸(피로) 대신 '신규 시 짧은 펄스 + 미확인 동안 지속 빨강'. 확인(ack)하면 사라짐.
  let lastErrCount = 0;
  let pulseTimer: NodeJS.Timeout | undefined;
  const pulseIfNew = (count: number) => {
    if (count <= lastErrCount) { lastErrCount = count; return; }
    lastErrCount = count;
    let n = 0;
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = setInterval(() => {
      status.backgroundColor = new vscode.ThemeColor(n % 2 ? "statusBarItem.warningBackground" : "statusBarItem.errorBackground");
      if (++n >= 6) { if (pulseTimer) clearInterval(pulseTimer); pulseTimer = undefined; status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground"); }
    }, 500);
  };

  const render = () => {
    const ws = dashboardWorkspace();
    const link = workspaceLink(loadLinks(), ws);
    if (!ws) {
      status.text = "$(plug) Codex";
      status.tooltip = "워크스페이스 없음";
      status.backgroundColor = undefined; // 무결성 빨강 등 이전 색 잔존 방지(아래 무결성 분기가 다시 칠할 수 있음)
    } else if (link?.codexSession) {
      const file = findRolloutById(link.codexSession);
      const snip = file ? firstSnippet(file) : "";
      status.text = `$(link) Codex: ${(snip || link.codexSession).slice(0, 14)}`;
      status.tooltip = new vscode.MarkdownString(
        `**Codex Bridge — 연결됨**\n\n` +
          `세션: \`${link.codexSession}\`\n\n` +
          `주제: ${snip || "-"}\n\n` +
          `연결: ${link.linkedAt ? new Date(link.linkedAt).toLocaleString() : "-"}\n\n` +
          (file ? "" : "⚠️ 세션 파일을 찾을 수 없음\n\n") +
          `클릭 → 대시보드`,
      );
      status.backgroundColor = file ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      status.text = "$(plug) Codex: 미연결";
      status.tooltip = "연결된 Codex 세션 없음 · 클릭 → 대시보드에서 연결";
      status.backgroundColor = undefined;
    }

    // 검증 진행 흐름: 진행 중이면 메인 항목을 숨기고 [🧑Claude] ▶▶검증중 [🔍Codex] 3개 항목으로 단계별(글자)색을 보인다.
    const live = computeLiveStage(link?.codexSession ?? null);
    const allIg = readVisibleIntegrity(dashboardWorkspace());
    const errs = allIg.filter((e) => !e.ack && e.severity === "error");
    const warns = allIg.filter((e) => !e.ack && e.severity === "warning");
    // 우선순위 error > warning > flow: 미확인 경보(빨강/노랑)가 있으면 상태바는 그걸 보인다(무결성 가시화 우선).
    // 진행 flow는 대시보드 스트립엔 계속 보이므로 상태바에서 양보해도 사용자가 진행을 못 보는 건 아님.
    const flowActive = !!live && !errs.length && !warns.length && ["claude", "codex-req", "codex-gen", "rejudge"].includes(live.key);
    if (flowActive && live) {
      if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = undefined; } lastErrCount = 0;
      status.hide(); // 흐름 표시 중엔 메인 1줄 대신 3박스
      const toCodex = live.key === "codex-req" || live.key === "codex-gen";
      const toClaude = live.key === "rejudge";
      const c = new vscode.ThemeColor(live.color);
      fClaude.text = "$(person) Claude";
      fClaude.color = (toClaude || live.key === "claude") ? c : undefined; // 활성 쪽만 색
      fCodex.text = "$(search) Codex";
      fCodex.color = toCodex ? c : undefined;
      fArrow.text = (toCodex ? "$(arrow-right) 검증중 $(arrow-right)" : toClaude ? "$(arrow-left) 반영중 $(arrow-left)" : "$(sync~spin) 작업중") + (live.round > 1 ? ` ·${live.round}R` : "");
      fArrow.color = c;
      fArrow.tooltip = new vscode.MarkdownString(`**검증 진행 — ${live.label}**${live.round ? ` (라운드 ${live.round})` : ""}\n\n클릭 → 대시보드`);
      fClaude.show(); fArrow.show(); fCodex.show();
      return; // 흐름은 미확인 경보(error/warning)가 없을 때만 — 아래 메인/무결성 분기 스킵
    }
    flowHide();
    status.color = undefined; // 메인 항목 글자색 잔존 방지

    // 무결성 경보: error(검증 미완)=빨강 우선, 없으면 warning(근거 의심=결정2-2)=노랑. 확인하면 사라짐. (errs·warns는 위에서 계산)
    if (errs.length) {
      status.text = `$(alert) Codex 검증 미완 ${errs.length}`;
      status.tooltip = alertTooltip(
        `**⚠️ 검증 무결성 경보 — 미확인 ${errs.length}건**\n\n` +
          errs.slice(-3).map((e) => `- ${e.detail || e.kind || "검증 미완"}`).join("\n\n") +
          `\n\n이 턴 결과가 '검증 없이' 종료됐을 수 있어요.`,
      );
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      pulseIfNew(errs.length);
    } else if (warns.length) {
      // 노랑 경고 2종: verdict-nonclean(Codex 결론이 통과 아님) + evidence-*(인용 근거 의심). 빨강(미완)보다 약함, 펄스 없음.
      if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = undefined; }
      lastErrCount = 0;
      const nVerdict = warns.filter((e) => e.kind === "verdict-nonclean").length;
      const nEvid = warns.length - nVerdict;
      const label = nVerdict && nEvid ? "Codex 주의" : nVerdict ? "Codex 결론 주의" : "Codex 근거 의심";
      const tipHead = nVerdict && nEvid ? `결론 주의 ${nVerdict}건 · 근거 의심 ${nEvid}건`
                    : nVerdict ? `Codex 결론이 통과가 아님 — ${nVerdict}건`
                    : `검증 근거 의심 — ${nEvid}건`;
      status.text = `$(warning) ${label} ${warns.length}`;
      status.tooltip = alertTooltip(
        `**🟡 ${tipHead}**\n\n` +
          warns.slice(-3).map((e) => `- ${e.detail || e.kind || "주의"}`).join("\n\n"),
      );
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      // 경보 없음(확인됨/해결) → 펄스 타이머도 정리해야 빨강이 다시 칠해지지 않음(ack 즉시 해제).
      if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = undefined; }
      lastErrCount = 0;
    }
    status.show();
  };

  let debounce: NodeJS.Timeout | undefined;
  const scheduleRender = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      render();
      dashboard.post();
    }, 800);
  };
  dashboard.onChange = render; // 대시보드 변경(예: 무결성 ack) 시 상태바를 즉시 render(디바운스 없이 바로 반영, watcher 비의존)

  const watchers: fs.FSWatcher[] = [];
  try {
    fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
    watchers.push(fs.watch(path.dirname(LINKS_FILE), () => scheduleRender()));
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(SESSIONS_DIR)) watchers.push(fs.watch(SESSIONS_DIR, { recursive: true }, () => scheduleRender()));
  } catch {
    /* ignore */
  }

  // V11: 활성화 시 codex home 1회 자동탐지 → 세션 폴더 갱신. 폴더가 바뀌었으면 그 폴더도 감시 추가 + 새로고침.
  syncCodexHome((changed) => {
    if (changed) {
      try { if (fs.existsSync(SESSIONS_DIR)) watchers.push(fs.watch(SESSIONS_DIR, { recursive: true }, () => scheduleRender())); } catch { /* ignore */ }
    }
    scheduleRender();
  });

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("codexBridge.openDashboard", () => dashboard.show()),
    // 상태바 '확인함' — 호버 툴팁의 클릭 링크(command:codexBridge.ackHere)에서 호출. 이 창에 보이는 미확인 경보만 읽음 처리.
    // ★ 호출 '시점'에 경보 재읽기(렌더 시점 값 재사용 금지) ★ 이 창 id만(다른 창 보존) ★ 실패 정직 보고 ★ 직후 즉시 갱신.
    vscode.commands.registerCommand("codexBridge.ackHere", () => {
      const unacked = readVisibleIntegrity(dashboardWorkspace()).filter(
        (e) => !e.ack && (e.severity === "error" || e.severity === "warning"),
      );
      if (!unacked.length) return; // 이미 확인됨/없음(다른 데서 ack) → 무동작
      const ok = ackIntegrity(unacked.map((e) => e.id));
      if (!ok) { vscode.window.showErrorMessage("경고 확인 처리 저장 실패(파일 잠김/권한?) — 잠시 후 다시 시도하세요."); return; }
      render();
      dashboard.post();
    }),
    vscode.commands.registerCommand("codexBridge.refresh", () => {
      render();
      dashboard.post();
    }),
    { dispose: () => { watchers.forEach((w) => w.close()); if (debounce) clearTimeout(debounce); if (pulseTimer) clearInterval(pulseTimer); } },
  );

  render();
}

export function deactivate(): void {}
