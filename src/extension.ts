import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { computeVerifyStats, VerifyStats, CodexTokens, parseSessionTokens, ClaudeTokens, sumClaudeUsage, computeProjectStats, ProjectStat, computeScoutCosts, ScoutCosts } from "./verify-stats";
import * as hookSetup from "./hook-setup";
import { localizeIntegrityDetail } from "./integrity-i18n";
import { parseLastModelCommand, parseLastAssistantModel, parseSessionStartTs, resolveCcIntent, modelFamily, shouldAttributeSettingsChange, pruneIntentMap, ageLabel } from "./brain-intent";
import { parseGitLog, suggest as scopeSuggest, ScopeSuggestion } from "./scope-ledger";
import { maskKey, isPlausibleKey, mergeDeepseekConfig } from "./deepseek-config";
import { appendApproved, parseApprovedFromMap, normSig } from "./map-ledger";
import { parseEventsJsonl, deriveLedger, computeScoutHealth, HEALTH_MIN_SAMPLE } from "./ledger-events";
import { catchUp, TailState, makeRolloutAcc, headFirstUserMessage, Msg, RolloutAcc, TURN_CAP } from "./rollout-scan";
import { scoutDirectiveText, scoutLedgerNotes } from "./scope-package";

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
const CONTRACT_FILE = path.join(BRIDGE_DIR, "contract.json"); // 레거시 전역 계약(상속 안 함 · ws=null 저장 폴백만)
const CONTRACTS_DIR = path.join(BRIDGE_DIR, "contracts"); // 프로젝트별 계약
const INTEGRITY_FILE = path.join(BRIDGE_DIR, "integrity.json"); // 무결성 신호(브릿지 기록 → 상태바 빨강·대시보드로 가시화)
// integrity 동시 쓰기 잠금 — bridge/contract-lib.js withIntegrityLock과 동형(P1-②, 감사 2026-07-10: 3주체
// read-modify-write가 겹치면 먼저 추가된 경고가 통째로 유실). 잠금 실패=무잠금 진행(fail-open — 악화 아님).
const INTEGRITY_LOCK = INTEGRITY_FILE + ".lock";
// v2 — bridge withIntegrityLock과 동형: stale 자동 삭제 없음(이중 진입 TOCTOU — Codex 반례)·토큰 소유권 해제·
// 잔존 시: 보유 pid 사망=즉시, 생존/판독불가=최대 ~600ms 후 무잠금 진행(정상 경합에서의 유실 방지가 목적이지 완전 해결 아님 — 정직 주장 하향).
function withIntegrityLockExt<T>(fn: () => T): T {
  const token = process.pid + "-" + Math.random().toString(36).slice(2, 8);
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) {
    try { fs.writeFileSync(INTEGRITY_LOCK, token, { flag: "wx" }); locked = true; }
    catch {
      // 보유자 pid 사망 시 대기 없이 즉시 무잠금 진행(degraded) — 잔존 잠금이 렌더당 ~1.2초(2회 호출) 확장 호스트
      // 지연을 만들던 성능 회귀 차단(Codex 반례). 삭제는 안 함(상호 삭제 TOCTOU) — bridge와 동형.
      try { const pid = parseInt(String(fs.readFileSync(INTEGRITY_LOCK, "utf8")).split("-")[0], 10); if (pid) { try { process.kill(pid, 0); } catch { break; } } } catch { /* 판독 불가 — 재시도 */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* 즉시 재시도 */ }
    }
  }
  try { return fn(); }
  finally {
    if (locked) { try { if (fs.readFileSync(INTEGRITY_LOCK, "utf8") === token) fs.unlinkSync(INTEGRITY_LOCK); } catch { /* 무해 */ } }
  }
}
const PHASE_FILE = path.join(BRIDGE_DIR, "phase.json"); // 검증 파이프라인 라이브 단계(훅/브릿지 기록 → 상태바·진행 스트립)
const VERDICTS_FILE = path.join(BRIDGE_DIR, "stats", "verdicts.jsonl"); // 검증 통계 누적(append-only, 브릿지가 flagVerdict에서 기록) → 탭2 집계 소스.
const PHASE_STALE_MS = 15 * 60 * 1000; // 이보다 오래된 phase는 '대기'로 — 코덱스 ask 최대 8분 + 여유
// 두뇌 drift '최근 실제값' 신선도(7일). 이보다 오래된 답/세션은 stale로 보고 경고 안 함 — 옛 모델 기록(예: 몇 주 전 다른 모델 사용)이 거짓 drift 내는 것 방지.
// 24h→7일 확장(사용자 결정 2026-07-05): 여러 프로젝트 병행 개발에선 3일+ 텀이 일상이라, 24h는 하루만 쉬어도 모든 프로젝트의
// 즉시 경고를 전멸시키는 과잉 억제였다(실측: 마지막 답 32~34h 시점에 cc·cx 경고 전부 침묵). 원래 차단 대상이던 19일급 옛 기록은 7일 창에서도 여전히 제외.
const DRIFT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
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
// ── 전역 언어(ko/en) — bridge/contract-lib.js의 loadLang/saveLang과 동일 규칙(같은 language.json 공유) ──
// 언어는 전역 하나(프로젝트/창 바뀌어도 유지). ko 기본 = 기존 사용자 무회귀. 브릿지가 구버전이어도 확장 자체 리더로 동작.
const LANG_FILE = path.join(BRIDGE_DIR, "language.json");
const LANGS = ["ko", "en"] as const;
type Lang = (typeof LANGS)[number];
function loadLangExt(): Lang {
  try {
    const o = JSON.parse(fs.readFileSync(LANG_FILE, "utf8"));
    if (o && (LANGS as readonly string[]).includes(o.lang)) return o.lang as Lang;
  } catch { /* 없음/손상 → ko */ }
  return "ko";
}
function saveLangExt(lang: Lang): boolean {
  if (!(LANGS as readonly string[]).includes(lang)) return false;
  return atomicWrite(LANG_FILE, JSON.stringify({ lang }));
}
// 확장 호스트(상태바·라이브 라벨·무결성 detail 등)용 — 호출 시점 전역 언어. (웹뷰는 생성 시 고정된 T()를 씀.)
function tE(ko: string, en: string): string {
  return loadLangExt() === "en" ? en : ko;
}
// 첫 실행 초기화: language.json이 없으면 VS Code UI 언어로 정해 '저장'까지 한다(auto를 동적으로 계속 해석하지 않고
// 첫 실행 값 고정 — 프로젝트/창 이동 시 예측 가능, Codex 검증 권고). 이미 있으면 손대지 않음.
function ensureLangInitialized(): void {
  try {
    if (fs.existsSync(LANG_FILE)) return;
    const uiLang = String(vscode.env.language || "").toLowerCase();
    saveLangExt(uiLang.startsWith("ko") ? "ko" : "en");
  } catch { /* best-effort — 실패 시 loadLangExt 기본 ko */ }
}

// 프로젝트별 계약 파일. 키=normWs의 sha1 앞16자 — bridge/contract-lib.js의 contractFileFor와 반드시 동일 규칙.
// 언어 슬롯: ko=레거시 <키>.json 그대로(기존 규칙 무회귀·비파괴) / en=<키>.en.json. 브릿지와 동일.
function contractFileFor(ws: string, lang?: Lang): string {
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  const l = lang || loadLangExt();
  return path.join(CONTRACTS_DIR, key + (l === "ko" ? "" : "." + l) + ".json");
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
  turnsTrimmed: boolean;      // 오래된 턴 '통째' 제거로 요청한 recentTurns를 못 채울 때만 true — 조용한 축소 금지(고지)
  turnsInnerTrimmed: boolean; // 화면에 있는 '선두 턴 내부'의 오래된 답변이 생략됐을 때 true — 원인이 다르므로 별도 고지(Codex 반례)
  candidates: Candidate[];
  hiddenCandidates: Candidate[];
  contract: Contract;
  lang: Lang;              // 전역 언어(ko/en)
  otherSlotRules: boolean; // 반대 언어 슬롯에만 규칙 있음(빈칸 안내)
  baseDirective: { verifyBaseline: string; transmit: string; rejudge: string; overridden: boolean };
  scoutPrompt: { baseline: string; overridden: boolean; directive: string; notes: string[]; version: string } | null; // §6-11 — 3트랙에서만(null=2트랙/판독 불가)
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
  sessionDiag: { home: string; source: string; sessionsDir: string; sessionsExists: boolean; codexBin: string } | null; // 세션 후보 0개일 때만 진단(지금 어디를 보는지·codex·출처). null=세션 있음(정상)
  integrity: IntegrityEvent[]; // 무결성 신호(검증 미완 등) — 미확인 error는 상태바 빨강 + 대시보드 경보
  live: LiveStage | null;      // 검증 파이프라인 라이브 단계(없으면 대기) — 상태바·진행 스트립
  verifyTimeoutMin: number;    // 검증(codex) 대기시간(분) — 저장값 또는 기본 8. 브릿지 verifyTimeoutMin과 같은 규칙.
  verifyStats: VerifyStats;    // 탭2 검증 통계(기간별 분포·전환·히트맵) — verify-stats.ts computeVerifyStats 결과
  scoutCosts: ScoutCosts;      // 정찰(3트랙) 비용 28일 합계 — scout-usage.jsonl(지도 프루닝과 무관 · 60일 보존)
  codexTokens: CodexTokens | null; // 연결 코덱스 세션 누적 토큰(없으면 null) — 검증 비용 카드
  claudeTokens: ClaudeTokens;      // 이 폴더 클로드 대화기록 28일 토큰 + 턴수 — 작업 비용(코덱스 검증 비용과 분리)
  projectStats: Record<string, ProjectStat>; // 프로젝트별 비교(3c) — 모든 폴더 28일 검증 분포(전체 group-by, 이 폴더 통계와 별개)
  scope: ScopeState | null; // 범위 장부(L0) 후보 — scoutMode=on(3트랙)일 때만 계산(advisory·로컬 git만·외부전송 0). null=2트랙
  scoutMaps: ScoutMapsView | null; // 영향지도 게시판 — 러너가 브릿지 홈 scouts/에 보관한 지도 목록+최신 본문(3트랙에서만). null=2트랙
  scoutMapStale: number | null;    // 낡은 지도 배지 — 지도 이후 변경 신호 수(seed 변경+새 커밋+작업트리 — 브릿지 scoutMapStatus 정합·판단 불가면 null·경고 아님)
  scoutLive: { arm: string; startedAt: string } | null; // 지도 생성중(러너 실행 동안만 — TTL로 잔존 걸러냄)
  deepseek: { hasKey: boolean; masked: string; model: string }; // 고급설정 탭 표시용 — 키 원문은 절대 웹뷰로 안 보냄(마스킹만)
  scoutTarget: { repo: string; differs: boolean; invalid: boolean; configured: boolean; inherited: boolean; drift: { repo: string; sample: number; agree: number } | null } | null; // P1 정찰 대상 + 어긋남 자기진단(2026-07-10). null=2트랙
  scoutGate: { eff: string; raw: string | null } | null; // 실효 플랜 게이트(표시 전용 — 3트랙에서만, 계약에 저장 안 함). null=2트랙/ws 없음
  mapLedger: MapLedgerView | null; // MAP 장부(stable 2층) — 대기 제안·승인/기각 이력·확정층 요약(3트랙에서만). null=2트랙
  // 두뇌설정(Claude settings.json·Codex pref) drift는 state로 노출하지 않는다 — syncBrainDriftFor가 integrity로 직접 동기화(상태바/배너).
  brainActual: { cc: string; cx: string; scout: string }; // 두뇌 '실제 답'(대화 기록 실측) 표시 문구 — 경고 아닌 평시 정보(피커 표시 결함 실사고 2026-07-08). 기록 없으면 '기록 없음' 문구. scout=마지막 정찰 실행(비용 장부 lastTs — 감사 일치 2026-07-10)
  hasTestsDir: boolean; // 표준 테스트 폴더(tests|test) '감지' 여부 — 성격 프로필용(미감지≠없음, 관행 밖은 못 봄)
}

function normWs(p: string): string {
  // NFC: 환경별 유니코드 폼(NFC/NFD) 차이로 같은 경로가 다른 키 되는 것 방지. 브릿지·확장 3카피 '동일 규칙'이어야 함.
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
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

function loadLinks(): { bySession: Record<string, any>; byWorkspace: Record<string, any>; modelPrefs: Record<string, any>; settings: Record<string, any>; autoNewFailed: Record<string, any> } {
  try {
    const o = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
    // modelPrefs/settings를 보존해야 대시보드가 저장값(모델·생각강도·검증 대기시간)을 다시 읽어 표시한다.
    // autoNewFailed = 자동 새 세션 생성이 막힌 폴더(연속 실패 폭증방지) — session-missing 안내를 '시도' vs '멈춤'으로 분기하는 데 쓴다.
    return { bySession: o.bySession || {}, byWorkspace: o.byWorkspace || {}, modelPrefs: o.modelPrefs || {}, settings: o.settings || {}, autoNewFailed: o.autoNewFailed || {} };
  } catch {
    return { bySession: {}, byWorkspace: {}, modelPrefs: {}, settings: {}, autoNewFailed: {} };
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

// 트랙: off=2트랙(구현↔검증, 기본) / on=3트랙(탐색 leg — 범위 장부 advisory, SCOPE-LEDGER.md).
// 프로젝트별 계약 파일에 저장(검증 모드와 동일 철학: 프로젝트별 분리·고정). 브릿지 contract-lib과 normalize 동형.
type ScoutMode = "off" | "on";
const SCOUT_MODES: ScoutMode[] = ["off", "on"];
function normScoutMode(o: any): ScoutMode {
  if (o && SCOUT_MODES.includes(o.scoutMode)) return o.scoutMode;
  return "off"; // 기본=2트랙(무회귀)
}

interface Contract {
  claude: string[];
  codex: string[];
  claudeChecklist: boolean;
  codexChecklist: boolean;
  verifyMode: VerifyMode;
  claudeInjectMode: InjectMode;
  scoutMode: ScoutMode;
  scoutRepo?: string; // 정찰 대상 레포(P1 — 세션 폴더≠개발 레포 해소). 빈 값/부재=ws 그대로.
  // ⚠ 대시보드 저장 페이로드는 이 필드를 만들지 않는다 — saveContract의 보존 병합(keep)이 CLI 설정값을 지킨다.
}

// 정찰 대상 해석 — ⚠ bridge/contract-lib.js resolveScoutRepo와 반드시 동일 규칙(3카피 규약 — 어긋나면 확장 카드와
// 훅·러너가 서로 다른 서랍을 본다. tests/scout-target.test.js 패리티 단언이 고정). 검증·연결·계약 앵커는 불변.
function scoutTargetFor(ws: string): { repo: string; source: string } {
  try {
    let raw = loadContract(ws).scoutRepo || "";
    let source = "contract";
    if (!raw) {
      // 반대 언어 슬롯 폴백(P1-④) — scoutRepo는 언어 내용이 아니라 사실(개발 레포 위치). 현재 슬롯 명시값 우선,
      // 비었을 때만 반대 슬롯을 빌림. bridge resolveScoutRepo와 동형(3카피 규약 — scout-target 패리티가 고정).
      try {
        const other: Lang = loadLangExt() === "en" ? "ko" : "en";
        const oo = JSON.parse(fs.readFileSync(contractFileFor(ws, other), "utf8"));
        if (oo && typeof oo.scoutRepo === "string" && oo.scoutRepo.trim()) { raw = oo.scoutRepo.trim(); source = "contract-other-lang"; }
      } catch { /* 반대 슬롯 없음 */ }
    }
    if (!raw) return { repo: ws, source: "ws" };
    if (!path.isAbsolute(raw)) return { repo: ws, source: "ws-fallback-invalid" }; // 상대경로 금지 — contract-lib과 동일 규칙
    const abs = path.resolve(raw);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { repo: abs, source };
    return { repo: ws, source: "ws-fallback-invalid" };
  } catch { return { repo: ws, source: "ws" }; }
}

// 정찰 대상 어긋남 자기진단 — bridge/contract-lib.js detectScoutTargetDrift와 동일 규칙(동형 규약 — 어긋나면
// 지시 채널과 대시보드가 다른 답을 말한다. tests/scout-drift.test.js 소스 계약이 고정). 증거는 브릿지가 검증
// 인용에서 수집한 파일을 읽기만 한다(수집 시 git root 검증됨 — 여기선 실존만 재확인).
const DRIFT_MIN_OBS = 3, DRIFT_SHARE = 0.7;
function scoutEvidenceFileExt(ws: string): string {
  return path.join(BRIDGE_DIR, "scout-target-evidence", crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16) + ".json");
}
function detectScoutTargetDriftExt(target: string, ws: string): { drift: boolean; repo?: string; sample?: number; agree?: number } {
  try {
    const o = JSON.parse(fs.readFileSync(scoutEvidenceFileExt(ws), "utf8"));
    const obs = (o && Array.isArray(o.obs) ? o.obs : []).filter((x: any) => x && Array.isArray(x.repos) && x.repos.length)
      .filter((x: any) => { // 유일한 최다 레포가 있는 관측만(동률=모호 → 제외 — 정본 동형, Codex 반례 2026-07-10)
        const s2 = x.repos.slice().sort((a: any, b: any) => ((b && b.n) | 0) - ((a && a.n) | 0));
        return s2.length === 1 || ((s2[0] && s2[0].n) | 0) > ((s2[1] && s2[1].n) | 0);
      });
    if (obs.length < DRIFT_MIN_OBS) return { drift: false };
    const tally = new Map<string, { n: number; display: string }>();
    for (const ob of obs) {
      const top = ob.repos.slice().sort((a: any, b: any) => ((b && b.n) | 0) - ((a && a.n) | 0))[0];
      if (!top || typeof top.repo !== "string" || !top.repo) continue;
      const k = normWs(top.repo);
      const cur = tally.get(k) || { n: 0, display: top.repo };
      cur.n++; tally.set(k, cur);
    }
    let bestK: string | null = null; let best: { n: number; display: string } | null = null;
    for (const [k, v] of tally) if (!best || v.n > best.n) { bestK = k; best = v; }
    if (!best || best.n / obs.length < DRIFT_SHARE) return { drift: false };
    // git 정체성 비교(정본 동형 — Codex 반례: 대상=worktree 하위 폴더/모노레포 중첩 저장소 오탐):
    // 대상의 git root와 같으면 일치, 대상 저장소 '안'의 중첩 저장소면 자동 교정 금지.
    let tRoot: string | null = null;
    try {
      const rg = require("child_process").spawnSync("git", ["-c", "safe.directory=*", "-C", target, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      tRoot = rg.status === 0 && String(rg.stdout).trim() ? String(rg.stdout).trim() : null;
    } catch { tRoot = null; }
    if (bestK === normWs(target) || (tRoot && bestK === normWs(tRoot))) return { drift: false };
    if (tRoot && bestK && (bestK + path.sep).startsWith(normWs(tRoot) + path.sep)) return { drift: false };
    try { if (!fs.existsSync(best.display) || !fs.statSync(best.display).isDirectory()) return { drift: false }; } catch { return { drift: false }; }
    return { drift: true, repo: best.display, sample: obs.length, agree: best.n };
  } catch { return { drift: false }; }
}

function loadContract(ws?: string | null, lang?: Lang): Contract {
  const read = (p: string): any | null => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  // 계약은 프로젝트 전용 — 실제 ws는 그 프로젝트 파일만 읽는다(★전역 상속 없음★, 없으면 빈 계약·주입 0).
  // ws=null(폴더 없는 창)만 레거시 전역(CONTRACT_FILE)을 '그 창의 저장소'로 읽음(saveContract(null)과 대칭 — '저장했는데 사라짐' 방지). 프로젝트엔 절대 상속 안 됨(프로젝트는 항상 ws 있음).
  // lang: 언어 슬롯(ko=레거시 파일). 미지정 시 전역 언어.
  const o = (ws ? read(contractFileFor(ws, lang)) : read(CONTRACT_FILE)) ?? {};
  return {
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    verifyMode: normVerifyMode(o),
    claudeInjectMode: normInjectMode(o),
    scoutMode: normScoutMode(o),
    scoutRepo: typeof o.scoutRepo === "string" ? o.scoutRepo.trim() : "",
  };
}

// 실효 플랜 게이트 — bridge/contract-lib.js normScoutGate와 반드시 동일 규칙(동형 규약 — 어긋나면 훅과 대시보드가
// 다른 답을 말한다. tests/scout-gate.test.js 소스 계약이 고정): ①scoutMode≠on→off(2트랙 무회귀) ②3트랙 명시값 존중
// ③3트랙 미설정→plan(2026-07-09 기본 승격 — 재실측 70.5%>60%). ⚠ Contract 스키마에는 넣지 않는다: saveContract가
// 기본값을 파일에 실값으로 굳히면 '사용자가 명시한 적 없는 plan'이 명시값이 돼 이후 기본 변경이 안 먹는다(보존 병합만).
function effectiveScoutGate(ws: string): { eff: "off" | "plan"; raw: "off" | "plan" | null } {
  let o: any = {};
  try { o = JSON.parse(fs.readFileSync(contractFileFor(ws, loadLangExt()), "utf8")) || {}; } catch { /* 계약 없음 — 기본 규칙만 */ }
  const raw: "off" | "plan" | null = o.scoutGate === "off" || o.scoutGate === "plan" ? o.scoutGate : null;
  if (normScoutMode(o) !== "on") return { eff: "off", raw };
  return { eff: raw ?? "plan", raw };
}

// 정찰 대상 지정(대시보드 원클릭·전환 모달 공용) — scripts/scope-target.js set과 동일 효과: 현재 언어 슬롯의
// 프로젝트 계약 파일에 scoutRepo만 보존 병합(⚠ saveContract 재사용 금지 — 대시보드 저장 페이로드는 scoutRepo를
// 모르는 스키마라 섞으면 오염, Codex 설계검증 2026-07-10). 반대 슬롯이 다른 값이면 고지(언어 슬롯 분리 원칙).
async function setScoutTargetFromUi(ws: string | null, repo: string, slotLang?: Lang): Promise<void> {
  if (!ws) { vscode.window.showWarningMessage(tE("폴더가 열려 있지 않아 설정할 수 없어요.", "No folder is open, so this cannot be set.")); return; }
  try {
    const abs = path.resolve(String(repo || "").trim());
    if (!path.isAbsolute(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      vscode.window.showWarningMessage(tE("정찰 대상 폴더를 찾을 수 없어요: " + abs, "Scout target folder not found: " + abs)); return;
    }
    const lang: Lang = slotLang || loadLangExt(); // 호출측 렌더 슬롯 우선(저장 도중 언어 전환 경계에서 3트랙과 scoutRepo가 다른 슬롯에 갈리는 것 방지 — Codex 반례)
    const file = contractFileFor(ws, lang);
    let keep: any = {};
    try { const prev = JSON.parse(fs.readFileSync(file, "utf8")); if (prev && typeof prev === "object" && !Array.isArray(prev)) keep = prev; } catch { /* 슬롯 파일 신설 */ }
    if (!atomicWrite(file, JSON.stringify({ ...keep, scoutRepo: abs, workspace: ws, updatedAt: new Date().toISOString() }, null, 2))) {
      vscode.window.showErrorMessage(tE("저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요.", "Save failed — file locked or inaccessible.")); return;
    }
    mapLedgerBump++;
    let otherNote = "";
    try {
      const other: Lang = lang === "ko" ? "en" : "ko";
      let ov = ""; // 반대 슬롯 파일이 없어도 '미설정'으로 취급해 고지(파일 부재=고지 생략이던 구멍 — Codex 반례: 신규 사용자가 가장 알아야 함)
      try { const oo = JSON.parse(fs.readFileSync(contractFileFor(ws, other), "utf8")); ov = typeof oo?.scoutRepo === "string" ? oo.scoutRepo.trim() : ""; } catch { /* 미설정 */ }
      if (ov && normWs(ov) !== normWs(abs)) otherNote = tE(" (ⓘ " + other + " 언어 모드에는 다른 명시값이 있어 그대로 유지: " + ov + ")", " (ⓘ the " + other + "-language mode keeps its own explicit value: " + ov + ")"); // 미설정이면 상속 — 본문 고지가 담당(모순 문구 제거, Codex 반례)
    } catch { /* 고지 실패 무해 */ }
    vscode.window.showInformationMessage(tE("정찰 대상을 지정했어요: " + abs + " — 다음 지도·일지·확인신호부터 이 레포 기준으로 쌓입니다. 기존 일지는 이 폴더 서랍에 보존됩니다(관찰 일지 카드의 안내 참조). ⓘ 다른 언어 모드는 별도 지정이 없으면 이 값을 상속합니다." + otherNote, "Scout target set: " + abs + " — maps, journal and confirms accrue for this repo from now on. The existing journal stays preserved in this folder's drawer (see the note on the journal card). ⓘ The other language mode inherits this value unless it sets its own." + otherNote));
  } catch (e) {
    vscode.window.showErrorMessage(tE("정찰 대상 설정 실패: ", "Failed to set scout target: ") + String((e as Error)?.message || e));
  }
}

function saveContract(ws: string | null, c: Contract, lang?: Lang): boolean {
  // 프로젝트별 파일에 저장(계약은 프로젝트 전용·상속 없음). ws 없으면(폴더 없는 창) 레거시 전역 파일에 저장.
  // lang: 언어 슬롯 — 현재 언어의 파일에만 저장(다른 언어 슬롯 안 건드림).
  const file = ws ? contractFileFor(ws, lang) : CONTRACT_FILE;
  // 대시보드가 모르는 확장 필드(scoutGate 등 — CLI/훅이 쓰는 실험 설정)는 보존 병합: 고정 스키마로 덮어쓰면
  // 대시보드 저장 한 번에 게이트 설정이 지워진다(scoutGate 추가 때 발견 — 기존 파일 값 위에 c를 얹는다).
  let keep: any = {};
  try { const prev = JSON.parse(fs.readFileSync(file, "utf8")); if (prev && typeof prev === "object" && !Array.isArray(prev)) keep = prev; } catch { /* 새 파일 */ }
  return atomicWrite(file, JSON.stringify({ ...keep, ...c, workspace: ws || undefined, updatedAt: new Date().toISOString() }, null, 2));
}

// '다른 언어 슬롯에만 규칙이 있음' 안내용 — 현재 슬롯이 비었는데 반대 슬롯에 규칙이 있으면 그 사실을 알려
// "언어 바꿨더니 규칙이 사라졌다" 오해를 막는다(Codex 검증 권고). 규칙 유무만 본다(verifyMode 기본값은 무시).
function otherSlotHasRules(ws: string | null): boolean {
  if (!ws) return false;
  const cur = loadLangExt();
  const other: Lang = cur === "ko" ? "en" : "ko";
  try {
    const o = JSON.parse(fs.readFileSync(contractFileFor(ws, other), "utf8"));
    return (Array.isArray(o.claude) && o.claude.length > 0) || (Array.isArray(o.codex) && o.codex.length > 0);
  } catch {
    return false;
  }
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
  // recommended_plugins: Codex '실행 런타임/호스트 계층'이 끼워 넣는 플러그인 추천 블록(우리 하네스가 보낸 게
  // 아님 — CLI/레지스트리/상위 오케스트레이터 중 어느 부품인지는 rollout만으로 특정 불가). 목록에 없어 사용자
  // 말풍선처럼 노출됐던 실사고(사용자 발견 2026-07-10). 닫는 '>'까지 요구해 <recommended_plugins_custom> 같은
  // 정상 사용자 문자열은 보존(Codex 보완). bridge/codex-bridge.js 필터와 동형 유지.
  return /^<(environment_context|user_instructions|system|recommended_plugins>)/i.test(s) || s.startsWith("# AGENTS.md");
}

// ── 판독 캐시 — 상태 계산(computeState)이 워처 폭주(검증 턴마다 브릿지 파일 변경)와 결합해 확장 호스트를 포화시키는 것 방지.
// 실측(2026-07-06): 이 폴더의 Claude 대화기록·연결 Codex rollout이 커지자 상태 계산 1회가 5.2s 동기 블로킹 —
// 브릿지 파일이 5s보다 자주 바뀌는 활성 세션에선 호스트가 상시 포화돼 대시보드가 데이터를 영영 못 받았다(사용자 실측 '아무 반응 없음').
// 전략: 무거운 '파일 전체 판독'은 mtime+size 키 메모(정확 무효화 — 저장 직후 낡은 화면 없음), 28일 집계만 짧은 TTL.
const readCache = new Map<string, { at: number; val: any }>();
function cachedRead<T>(key: string, ttlMs: number, fn: () => T): T {
  const now = Date.now();
  const hit = readCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.val as T;
  const val = fn();
  readCache.set(key, { at: now, val });
  if (readCache.size > 300) {
    const cut = now - 10 * 60 * 1000;
    for (const [k, v] of readCache) if (v.at < cut) readCache.delete(k);
    // 전부 최근이어도 상한은 지킨다 — mtime+size가 키에 박혀 파일이 자랄 때마다 새 키가 쌓이는 구조라
    // '10분 미만' 항목만으로 300을 넘을 수 있음(교차 감사 지적). 가장 오래된 것부터 절삭.
    if (readCache.size > 300) {
      const byAge = [...readCache.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < byAge.length - 300; i++) readCache.delete(byAge[i][0]);
    }
  }
  return val;
}
function fileCacheKey(file: string): string {
  try { const st = fs.statSync(file); return file + "|" + st.mtimeMs + "|" + st.size; } catch { return file + "|na"; }
}

// ── rollout 증분 판독(P1-①) — 전량 재파싱(181MB 실측 ~1s) 대신 자란 부분만 병합. 로직은 rollout-scan.ts(테스트 가능).
function statInfoOf(file: string): { size: number; mtimeMs: number } { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs }; }
function readSliceOf(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.max(0, end - start);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } finally { fs.closeSync(fd); }
}
// 통합 tail: 대화+모델 메타를 '한 번의 스캔'으로(소비자별 tail을 따로 들면 같은 파일을 두 번 전량
// 판독 — Codex 실측 190MB에서 904+877ms). cwd별 값(byCwd)을 다 들고 있어 어떤 ws 질의도 추가 스캔 없음.
// 연결 세션은 보통 1~2개라 맵이 작지만, 세션 교체가 쌓이면 무한 성장하므로 상한.
const rolloutTails = new Map<string, TailState<RolloutAcc>>();
const rolloutMk = makeRolloutAcc(isInjected, normWs);
function rolloutAccFor(file: string): RolloutAcc {
  // 반환 acc는 다음 호출에서 제자리 병합되는 살아있는 참조 — 동기 소비 전용(현재 소비처 전부 즉시 slice/순회).
  try {
    const st = catchUp(file, rolloutTails.get(file), rolloutMk.init, rolloutMk.merge, statInfoOf, readSliceOf);
    rolloutTails.set(file, st);
    if (rolloutTails.size > 20) { for (const k of rolloutTails.keys()) { if (k !== file) { rolloutTails.delete(k); break; } } }
    return st.acc;
  } catch {
    rolloutTails.delete(file);
    return rolloutMk.init();
  }
}
function readMessages(file: string): Msg[] {
  return rolloutAccFor(file).msgs;
}

// 주제 추출용: 브릿지(withContract)가 매 ask 앞에 붙이는 지침 보일러플레이트를 걷어내고 '실제 요청 본문'만 남긴다.
// 안 걷으면 상태바/호버/후보 목록의 '주제'가 항상 "[검증 기본 원칙 …" 머리말로 보인다(사용자 실측). 마커가 없으면(비-브릿지
// 세션·일반 대화) 원문 그대로. lastIndexOf = 지침 텍스트 내부에 우연히 같은 문구가 있어도 마지막(실제 구분자)을 취함.
function stripInjectedPreamble(text: string): string {
  for (const marker of ["\n---\n[작업 요청]\n", "\n---\n[Work Request]\n"]) {
    const i = text.lastIndexOf(marker);
    if (i >= 0) return text.slice(i + marker.length);
  }
  return text;
}
// 첫 사용자 메시지는 파일 '머리'에 있고 불변 — 전량 파싱이 후보 목록(12+50개 합산 수백 MB)을 잡아먹던
// 최대 비용 지점(교차 감사 실측 1.6s). 머리 조각(512KB→8MB)에서 찾고, 그래도 미확정이면 통합 누적기의
// firstUser 폴백(절삭 무관 보존 필드 — 8MB 밖 첫 메시지도 유실 없음. 라이브 상위 12파일은 전부 512KB 안).
// 찾은 값은 경로별 영구 메모(이후 stat조차 없음). 못 찾은 경우만 mtime 키 캐시 — 새 세션에 첫 메시지가
// 나중에 붙는 경우를 놓치지 않게.
const snippetMemo = new Map<string, string>();
function firstSnippet(file: string): string {
  const hit = snippetMemo.get(file);
  if (hit !== undefined) return hit;
  return cachedRead("snip|" + fileCacheKey(file), 5 * 60 * 1000, () => {
    let t = headFirstUserMessage(file, isInjected, readSliceOf, statInfoOf);
    if (t === null) t = headFirstUserMessage(file, isInjected, readSliceOf, statInfoOf, 8 * 1024 * 1024); // 희귀: 머리 512KB가 전부 비메시지 기록
    if (t === null) t = rolloutAccFor(file).firstUser ?? ""; // 최후 폴백 — firstUser는 턴 절삭과 무관하게 보존되는 필드(readMessages 폴백은 절삭된 시야라 부정확 — Codex 반례)
    if (t) {
      const out = stripInjectedPreamble(t).replace(/\s+/g, " ").trim().slice(0, 70);
      if (out) { snippetMemo.set(file, out); if (snippetMemo.size > 500) { const k = snippetMemo.keys().next().value; if (k !== undefined) snippetMemo.delete(k); } return out; }
    }
    return tE("(내용 미상)", "(content unknown)");
  });
}

// rollout의 turn_context에서 '현재(마지막) 모델·생각강도'와 '이 세션이 써본 모델 목록'을 뽑는다.
// readMessages는 turn_context를 버리므로 별도 파서 필요(item4 보기). 마지막 turn_context 값 = 현재값.
// ★wsFilter: 한 코덱스 세션이 여러 워크스페이스에 공유될 수 있고(폴더마다 다른 모델/생각강도 pref), turn_context엔
//   그 ask가 돈 폴더(cwd)가 기록된다. wsFilter를 주면 '그 폴더에서 나온 turn'만으로 현재 model/effort를 잡는다 →
//   형제 폴더 ask가 만든 값과 비교돼 거짓 두뇌-drift가 뜨는 것을 막는다. 일치 turn 0개면 model/effort=""(호출측 가드가 경고 억제).
//   단 models(이 세션이 써본 모델 목록·knownModels 표시용)는 필터와 무관하게 전부 모은다.
function sessionModelMeta(file: string, wsFilter?: string | null): { model: string; effort: string; models: string[]; ts: string } {
  // mtime+size 키 메모 — 파일이 바뀌면 즉시 새로 계산(밑은 증분 판독이라 미스여도 자란 부분만 읽음).
  // 키에 verdict 장부 상태 포함 — 아래 귀속 보정의 입력이 바뀌면 캐시도 즉시 무효(감사 지적 2026-07-10).
  return cachedRead("smm|" + (wsFilter ? normWs(wsFilter) : "") + "|" + fileCacheKey(file) + "|" + fileCacheKey(path.join(BRIDGE_DIR, "stats", "verdicts.jsonl")), 5 * 60 * 1000, () => sessionModelMetaUncached(file, wsFilter));
}
// 검증 장부(stats/verdicts.jsonl — 브릿지가 ask마다 '연 폴더' 귀속으로 model·effort·ts를 기록)에서
// 이 ws×이 세션의 최신 실측. 실사고(2026-07-10, 두 감사 일치): rollout turn의 cwd는 'ask가 돈 폴더'라
// 세션 폴더≠작업 폴더면 turn 필터가 전멸해 검증 카드·drift·현재값이 11시간 전 값에 동결됐다 — 장부의
// workspace는 브릿지가 이미 올바르게 귀속한 값이라, 공유 세션(한 codex 세션을 두 프로젝트가 씀 — 실존 3쌍)에서도
// 형제 프로젝트 값이 새지 않는다. cwd 무필터 완화는 그래서 금지(거짓 drift 재발) — 이 장부 병용이 절충.
function verdictActualFor(ws: string, codexSession: string): { model: string; effort: string; ts: string } | null {
  try {
    const raw = fs.readFileSync(path.join(BRIDGE_DIR, "stats", "verdicts.jsonl"), "utf8");
    const want = normWs(ws);
    let best: { model: string; effort: string; ts: string } | null = null;
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      let o: any; try { o = JSON.parse(ln); } catch { continue; }
      if (!o || !o.model || normWs(String(o.workspace || "")) !== want) continue;
      if (codexSession && String(o.codexSession || "") !== codexSession) continue;
      const cand = { model: String(o.model), effort: String(o.effort || ""), ts: String(o.ts || "") };
      if (!best || (Date.parse(cand.ts) || 0) >= (Date.parse(best.ts) || 0)) best = cand; // 최대 ts 선택 — 줄 순서 가정 없음(Codex 보완)
    }
    return best;
  } catch { return null; }
}
function sessionModelMetaUncached(file: string, wsFilter?: string | null): { model: string; effort: string; models: string[]; ts: string } {
  // 통합 tail(rolloutAccFor)에서 답한다 — 규칙(cwd 필터·마지막 값·models 전체 수집)은 기존 파서와 동형.
  const want = wsFilter ? normWs(wsFilter) : null;
  const acc = rolloutAccFor(file);
  const v = want ? (acc.byCwd.get(want) || { model: "", effort: "", ts: "" }) : acc.last;
  let model = v.model, effort = v.effort, ts = v.ts; // 이 폴더(cwd) 마지막 turn — drift 신선도(파일 mtime보다 엄밀)
  const models = [...acc.models];
  // 귀속 보정(2026-07-10, 두 감사 일치): 이 ws 소유로 기록된 검증 장부 항목이 turn 기반 값보다 새로우면 그걸 채택 —
  // ask가 다른 폴더에서 돌아도(rollout cwd 어긋남) 검증 카드·drift·현재값이 실제 최신을 따라간다.
  // 세 소비처(brainActual·syncBrainDriftFor·modelCurrent)가 전부 이 함수를 지나므로 한 곳 보정으로 함께 해소.
  if (wsFilter) {
    try {
      const m = String(path.basename(file)).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const vd = verdictActualFor(wsFilter, m ? m[1] : "");
      if (vd && (Date.parse(vd.ts || "") || 0) > (Date.parse(ts || "") || 0)) { model = vd.model; effort = vd.effort || effort; ts = vd.ts; }
    } catch { /* 보정 실패 — turn 기반 값 유지(무회귀) */ }
  }
  return { model, effort, models, ts };
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
  type V = "pass" | "pass-notes" | "fail" | "inconclusive" | null;
  let v: V = null;
  // 분류는 '그 줄이 매칭된 언어의 단어들로만'(교차 오염 방지 — 한국어 판정줄 속 fail-safe·minor 등 우연한 영단어가 오분류 못 내게).
  const ko = (ln: string): V => {
    if (/실패/.test(ln)) return "fail";
    if (/불가|보류|정보\s*부족/.test(ln)) return "inconclusive";
    if (/통과/.test(ln) && /보완|조건부|정정|추가|미세|단서/.test(ln)) return "pass-notes";
    if (/통과/.test(ln)) return "pass";
    return null;
  };
  // 영어: 'Verdict:' 콜론형만 + '콜론 뒤 선언값' 앵커(단어 스캔 금지 — "Verdict: pass - no tests fail"의 뒤쪽 fail이
  // 선언값 pass를 덮어쓰지 못하게. 'Verification passed…' 설명문은 선언으로 안 봄). 브릿지 classifyVerdictEn과 동일.
  const en = (ln: string): V => {
    const m = /^[\s#>*\-]*verdict\s*[:：]\s*(pass(?:ed|es)?|fail(?:ed|s)?|inconclusive)\b(.*)$/i.exec(ln);
    if (!m) return null;
    const declared = m[1].toLowerCase();
    if (declared.startsWith("fail")) return "fail";
    if (declared === "inconclusive") return "inconclusive";
    if (/\bnotes?\b|\bcaveats?\b|\bminor\b|\bconditional\b|\breservations?\b|\bremarks?\b|\bsupplements?\b/i.test(m[2] || "")) return "pass-notes";
    return "pass";
  };
  for (const ln of String(text).split(/\r?\n/)) {
    // '결론 선언 줄'만: 한국어='검증'+콜론/결론어(기존 그대로), 영어='Verdict:' 콜론형(영문 기본지침 형식과 일치).
    // 서두·본문 부연은 배제. KO 우선순위: 실패>보류·불가>통과+보완>통과. 마지막 선언이 이김. 판독은 언어 설정과 무관하게 항상 양언어.
    let r: V = null;
    if (/^[\s#>*\-]*검증\s*(?:[:：]|통과|실패|불가|보류|판단|조건부|보완|정보)/.test(ln)) r = ko(ln);
    else r = en(ln);
    if (r) v = r;
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
      // '수정됨' 배지 비교 기준도 현재 전역 언어의 기본값이어야 한다 — en 모드에서 한국어 기본값과 비교하면
      // 오버라이드가 없어도 전부 '수정됨'으로 오탐(Codex 검증 반영). 구 런타임(lang 이전)엔 baseDefaultsFor가 없어 폴백.
      const def = (typeof lib.baseDefaultsFor === "function" ? lib.baseDefaultsFor() : lib.BASE_DEFAULTS) || {};
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
interface IntegrityEvent { id: string; ts?: string; kind?: string; severity?: string; detail?: string; detailKo?: string; detailEn?: string; ack?: boolean; session?: string; workspace?: string; sig?: string }
function readIntegrity(): IntegrityEvent[] {
  try { const d = JSON.parse(fs.readFileSync(INTEGRITY_FILE, "utf8")); return Array.isArray(d.events) ? d.events : []; } catch { return []; }
}
// 창 격리: integrity.json도 모든 창이 공유하는 한 파일이라, 필터 없이 보이면 '다른 창'의 검증 미완/근거의심
// 경보가 내 상태바·대시보드에 새어 보인다(phase와 같은 누수). 이 창 워크스페이스 것만 보여준다(표시 전용 — ack는
// id로 처리하므로 원본 목록은 안 건드림). 모든 appendIntegrityEvent 기록부가 workspace를 넣음.
function readVisibleIntegrity(ws: string | null): IntegrityEvent[] {
  if (!ws) return []; // 폴더 없는 빈 창 → 전역 경보 누수 차단
  // detail은 '기록 시점 언어'로 저장된 데이터 — 표시 소비자(상태바 툴팁·대시보드 배너)가 모두 이 함수를 거치므로,
  // 여기 한 곳에서 현재 언어로 현지화한 '복사본'을 준다(원본 integrity.json은 안 건드림 — ack는 id로 처리라 무관).
  const en = loadLangExt() === "en";
  return readIntegrity()
    .filter((e) => !e.workspace || normWs(e.workspace) === normWs(ws))
    .map((e) => ({ ...e, detail: localizeIntegrityDetail(e, en) }));
}

// ── 탭2 검증 통계: verdicts.jsonl(append-only)을 읽어 기간별 분포·전환·히트맵으로 집계 ──
// 순수 집계는 verify-stats.ts의 computeVerifyStats로 분리(extension·테스트가 '같은 함수'를 쓴다 — 미러 복제 제거). 여기선 파일을 읽어 넘기기만 한다.
function readVerifyStats(ws: string | null, now = Date.now()) {
  if (!ws) return computeVerifyStats("", now, ws, normWs); // 폴더 없는 빈 창 → 다른 폴더 통계 누수 차단(readVisibleIntegrity와 같은 정책 — 프로젝트별 원칙)
  let raw = "";
  try { raw = fs.readFileSync(VERDICTS_FILE, "utf8"); } catch { /* 아직 검증 기록 없음 → 빈 통계 */ }
  return computeVerifyStats(raw, now, ws, normWs);
}
// 정찰(3트랙) 비용 판독 — scout-usage.jsonl(러너·ping이 append) → 28일 정찰 방식별 합계. 프로젝트별 원칙 동일.
function readScoutCosts(ws: string | null, now = Date.now()): ScoutCosts {
  if (!ws) return computeScoutCosts("", now, "", normWs);
  let raw = "";
  try { raw = fs.readFileSync(path.join(BRIDGE_DIR, "stats", "scout-usage.jsonl"), "utf8"); } catch { /* 아직 기록 없음 */ }
  // P1: 지도 기록의 workspace는 '정찰 대상' — 세션 폴더가 아니라 대상 레포 기준으로 걸러야 실측과 일치
  return computeScoutCosts(raw, now, scoutTargetFor(ws).repo, normWs);
}
function ackIntegrity(ids: string[] | "all"): boolean {
  return withIntegrityLockExt(() => {
  const events = readIntegrity();
  const set = ids === "all" ? null : new Set(ids);
  for (const e of events) { if (!set || set.has(e.id)) e.ack = true; }
  return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events }));
  });
}
// 모델 '계열' 판정(modelFamily)은 brain-intent.ts로 이동 — 확장·intent 격자·테스트가 같은 정본을 import(사본 드리프트 방지).
// 두뇌 drift(모델 계열/추론 어긋남)를 integrity 채널에 reconcile → 기존 상태바·배너·확인(ack) 파이프라인 재사용.
// 안정 sig로 같은 drift는 재발행 안 함(확인 후 sig 안 바뀌면 안 다시 뜸), 해소된 미확인 신호는 제거. kind="brain-drift".
function syncBrainDrift(ws: string | null, drifts: { sig: string; detail: string; detailKo?: string; detailEn?: string }[]): void {
  withIntegrityLockExt(() => { // P1-② — read~write 한 임계(브릿지·훅과 겹칠 때 경고 유실 방지)
  if (!ws) return;
  const KIND = "brain-drift";
  const events = readIntegrity() as any[];
  const wsMatch = (e: any) => !e.workspace || normWs(e.workspace) === normWs(ws);
  const curSigs = new Set(drifts.map((d) => d.sig));
  // 이 ws의 brain-drift 중 '현재도 유효한 sig'만 보존(ack·id 유지) → 해소/구식 제거. 타 kind·타 ws는 보존.
  const kept = events.filter((e) => e.kind !== KIND || !wsMatch(e) || curSigs.has(e.sig));
  const present = new Set(kept.filter((e) => e.kind === KIND && wsMatch(e)).map((e) => e.sig));
  for (const d of drifts) {
    if (present.has(d.sig)) continue; // 이미 기록됨(ack 유지) → 재발행 안 함
    kept.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ack: false, ts: new Date().toISOString(), session: "", workspace: ws, kind: KIND, severity: "warning", detail: d.detail, detailKo: d.detailKo, detailEn: d.detailEn, sig: d.sig });
  }
  if (kept.length !== events.length || kept.some((e, i) => e !== events[i])) atomicWrite(INTEGRITY_FILE, JSON.stringify({ events: kept.slice(-50) }));
  });
}
let lastDriftSync = 0;
// 두뇌 drift 계산 + integrity 동기화 — computeState(대시보드)·상태바 render() 양쪽에서 호출(대시보드를 안 열어도 상태바에 뜨게).
// 잦은 render에서 트랜스크립트 과다 read를 막기 위해 1.5s throttle. (Claude=모델 어긋남만 / Codex=모델·생각강도)
function syncBrainDriftFor(ws: string | null): void {
  if (!ws) return;
  const now = Date.now();
  if (now - lastDriftSync < 1500) return;
  lastDriftSync = now;
  try {
    // 두뇌 drift는 '의도한 값 vs 최근 실제값' 불일치만 본다. ⚠ Claude의 실제 런타임 '생각강도'는 어디에도 기록되지 않아 비교가 불가능 →
    // Claude는 '모델' 어긋남만 본다(생각강도는 탐지 안 함). 생각강도 비교는 그 값이 rollout에 기록되는 Codex에서만 한다.
    // ★프로젝트별 의도(intent): Claude Code의 /model은 '전역' settings.json에 저장돼, 다른 프로젝트 창의 /model이 이 폴더의
    //  '설정값'을 바꿔버린다(P1=fable·P2=opus 동시 사용 시 P2에 구조적 거짓경고 — 사용자 실측 2026-07-04). 그래서 설정 파일이 아니라
    //  '이 폴더의 현재 대화 자신이 기록한 마지막 /model'을 의도로 삼고, 없으면 '대화 시작 전에 정해져 있던 설정'만 인정한다
    //  (대화 도중 바뀐 전역 설정은 다른 창 소행일 수 있어 비교 skip — 과소경고는 허용, 거짓경고는 불허).
    // ★워크스페이스 격리(cwd 필터): intent·actual 모두 '이 폴더의 같은 대화'에서 읽는다(형제 폴더의 답/선택이 새지 않게).
    const ccT = ws ? currentTranscriptForWs(ws) : null;      // 이 폴더의 현재(또는 최근) 대화 transcript
    let claudeCur = "", cbModel = "";                        // 실제 답 모델 / 이 폴더 기준 '의도한' 모델
    if (ccT) {
      const scan = scanCcTranscript(ccT, ws);                // 증분 스캔 — 이 대화의 /model 기록 + 실제 답 모델(둘 다 cwd strict)
      claudeCur = scan.actual && Date.now() - scan.actual.ts < DRIFT_FRESH_MS ? scan.actual.model : ""; // 신선한 답만(옛 답 거짓 drift 차단)
      const attr = readCcIntentFor(ws);                      // 이 프로젝트에 '포커스 귀속'된 선택(UI 피커 포함) — cmd와 최신 ts 승리
      let settingsMtime: number | null = null, sessionStart: number | null = null;
      if (!scan.cmd && !attr) {                              // 폴백 재료: '대화 시작 전 설정'인지 판정(후보가 전무할 때만 필요)
        try { settingsMtime = fs.statSync(claudeSettingsFile()).mtimeMs; } catch { settingsMtime = null; }
        try { sessionStart = parseSessionStartTs(readHead(ccT, 65536)); } catch { sessionStart = null; }
      }
      const intent = resolveCcIntent(
        scan.cmd ? scan.cmd.model : null, scan.cmd ? scan.cmd.ts : null,
        attr ? attr.model : null, attr ? attr.ts : null,
        readClaudeSettingsModel(), settingsMtime, sessionStart,
      );
      cbModel = intent ? intent.model : "";                  // 의도 산출 불가 → 빈값 → 아래 cf&&cfc 가드로 비교 skip
    }
    const links = loadLinks();
    const pref: any = links.modelPrefs[normWs(ws)] || {};
    const link = workspaceLink(links, ws);
    let mModel = "", mEffort = "";
    // 연결된 코덱스 rollout의 '이 폴더 마지막 turn'이 오래됐으면(stale) 비교하지 않는다 — 옛 세션의 마지막 모델/생각강도가
    // 거짓 drift를 내는 것 방지(cc의 신선도 정책과 대칭). 신선도는 파일 mtime이 아니라 rollout 내부 turn 시각(sm.ts)으로 판정
    // → 파일이 외부 요인으로 touch돼도 stale 세션이 fresh처럼 보이지 않음. 지금 검증에 쓰는 세션이면 turn이 신선해 정상 비교.
    if (link && link.codexSession) {
      const f = findRolloutById(link.codexSession);
      if (f) {
        const sm = sessionModelMeta(f, ws); // ws 필터=이 폴더 turn의 최근값만
        const t = Date.parse(sm.ts || "");
        if (Number.isFinite(t) && Date.now() - t < DRIFT_FRESH_MS) { mModel = sm.model; mEffort = sm.effort; }
      }
    }
    // detailKo/detailEn 동시 저장 — 표시(readVisibleIntegrity)가 '그때그때 현재 언어'를 고른다(기록 시점 언어 고정 방지). detail은 구버전 판독 폴백.
    const bd: { sig: string; detail: string; detailKo: string; detailEn: string }[] = [];
    const bothD = (sig: string, ko: string, en: string) => bd.push({ sig, detail: tE(ko, en), detailKo: ko, detailEn: en });
    // Claude: 별칭(opus)↔정식ID(claude-opus-4-8)는 namespace가 달라 modelFamily 계열로 비교(둘 다 알 때만 → 빈값 오탐 방지).
    const cf = modelFamily(cbModel), cfc = modelFamily(claudeCur);
    if (cf && cfc && cf !== cfc) bothD(`cc-model:${cf}!${cfc}`, `Claude: 설정한 모델은 '${cf}'인데 최근 답한 모델은 '${cfc}'예요. 고른 모델이 아직 안 먹었을 수 있어요(앱에서 모델을 다시 선택).`, `Claude: configured model is '${cf}' but the latest answer used '${cfc}'. Your selection may not have taken effect yet (re-select the model in the app).`);
    // Codex: pref와 rollout이 같은 slug 어휘라 정규화 raw 비교(modelFamily는 Claude 계열 전용이라 gpt-*를 ""로 떨궈 영영 못 잡음).
    const xm = (pref.model || "").trim().toLowerCase(), xmc = (mModel || "").trim().toLowerCase();
    if (xm && xmc && xm !== xmc) bothD(`cx-model:${xm}!${xmc}`, `코덱스: 설정한 모델은 '${pref.model}'인데 최근 답한 모델은 '${mModel}'예요. 바꾼 게 다음 답부터 반영될 수 있어요.`, `Codex: configured model is '${pref.model}' but the latest answer used '${mModel}'. The change may apply from the next answer.`);
    if (pref.reasoning && mEffort && pref.reasoning !== mEffort) bothD(`cx-effort:${pref.reasoning}!${mEffort}`, `코덱스: 설정한 생각강도는 '${pref.reasoning}'인데 최근 답은 '${mEffort}'였어요. 바꾼 게 다음 답부터 반영될 수 있어요.`, `Codex: configured reasoning is '${pref.reasoning}' but the latest answer used '${mEffort}'. The change may apply from the next answer.`);
    syncBrainDrift(ws, bd);
  } catch { /* best-effort */ }
}
// 정찰 구조 안내 — 대시보드와 별개 viewType의 '정적' 새탭(사용자 요청 2026-07-08: 색상 카드 구조도+상세 설명).
// enableScripts:false + 좁은 CSP(스크립트 원천 차단 — 안내문에 동적 상태 없음·닫으면 끝·직렬화 불요).
function openReconGuide(): void {
  const panel = vscode.window.createWebviewPanel("codexBridgeReconGuide", tE("정찰 구조 안내", "Recon Structure Guide"), vscode.ViewColumn.Beside, { enableScripts: false });
  const card = (color: string, badge: string, nameKo: string, nameEn: string, rows: [string, string][]) =>
    `<div class="card" style="border-top:3px solid ${color}"><div class="cbadge" style="color:${color}">${badge}</div><h2>${tE(nameKo, nameEn)}</h2>${rows.map(([k, v]) => `<div class="crow"><b>${k}</b><span>${v}</span></div>`).join("")}</div>`;
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px;max-width:980px}
h1{font-size:16px} h2{font-size:13px;margin:6px 0} .sub{color:var(--vscode-descriptionForeground);font-size:12px}
.flow{display:grid;grid-template-columns:1fr 22px 1fr 22px 1fr 22px 1fr;gap:4px;align-items:stretch;margin:14px 0}
.card{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;font-size:12px}
.cbadge{font-size:15px} .crow{display:flex;gap:6px;margin:3px 0;font-size:11.5px} .crow b{min-width:52px;color:var(--vscode-descriptionForeground);font-weight:600}
.arrow{align-self:center;text-align:center;color:var(--vscode-descriptionForeground);font-size:15px}
.faq{margin-top:16px;border-top:1px dashed var(--vscode-panel-border);padding-top:10px;font-size:12px}
.faq b{display:block;margin-top:8px}
.vrel{margin-top:14px;padding:10px;border:1px dashed var(--vscode-panel-border);border-radius:6px;font-size:12px}
</style></head><body>
<h1>${tE("정찰(3트랙) — 구조와 흐름", "Recon (3-track) — structure & flow")}</h1>
<div class="sub">${tE("구현↔검증(2트랙)에 더해지는 세 번째 축. 아래 4단계는 왼쪽에서 오른쪽으로 흐르고, 승인 없이도 전부 자동으로 굴러갑니다 — 👤 단계만 '원할 때' 쓰는 선택입니다.", "The third axis added to implement↔verify (2-track). The 4 steps flow left to right and run automatically without approvals — only the 👤 step is optional, used when you want it.")}</div>
<div class="flow">
${card("#3ca89a", "⚙", "변경 감지", "Change sensing", [[tE("무엇", "what"), tE("지금 고치는 파일 + 예전에 같이 바뀌던 파일 힌트", "files you're editing + hints of files that changed together before")],[tE("누가", "who"), tE("기계(확장) — 자동", "machine (extension) — automatic")], [tE("비용", "cost"), tE("0 · LLM 없음 · 전부 로컬", "0 · no LLM · all local")], [tE("저장", "store"), tE("표시만(대시보드)", "display only (dashboard)")]])}
<div class="arrow">→</div>
${card("#9a6cdc", "⚡", "영향지도", "Impact map", [[tE("무엇", "what"), tE("이 변경이 어디까지 번질지 미리보기(확인 목록)", "a preview/checklist of how far the change reaches")], [tE("누가", "who"), tE("정찰 LLM — 직접 또는 자동 지시로 실행", "scout LLM — run directly or via auto-directive")], [tE("비용", "cost"), tE("기본 정찰(Claude)=별도 과금 없음(쓰시던 Claude 사용량 범위) · DeepSeek 정찰은 키 등록 시(=동의)", "default scout (Claude) = no separate billing (within the Claude usage you already have) · DeepSeek scout only with a key (=consent)")], [tE("저장", "store"), tE("보관함(최근 10장) → 영향지도 카드", "archive (last 10) → impact-map card")]])}
<div class="arrow">→</div>
${card("#3ca89a", "⚙", "관찰 일지", "Field journal", [[tE("무엇", "what"), tE("지도의 제안이 검증을 지나며 맞음/틀림으로 자동 분류", "map suggestions auto-classified right/wrong through verification")], [tE("누가", "who"), tE("자동 — 검증 대화에 편승(추가 LLM 호출 0)", "automatic — rides the verify chat (0 extra LLM calls)")], [tE("신분", "states"), tE("미검증 → 신뢰(검증 확인) / 틀림 판명 — 단 반박 뒤 재확인(사람 1회·검증 2회)이 쌓이면 복권", "unverified → trusted (confirmed) / disputed — rehabilitated if re-confirmed after (1 human / 2 verify)")], [tE("개입", "override"), tE("선택: 고정·차단·내보내기", "optional: pin · ban · export")]])}
<div class="arrow">→</div>
${card("#d9a441", "👤", "확정 교범", "Field manual", [[tE("무엇", "what"), tE("도장 찍은 결합만 저장소 문서(docs/MAP.md)로", "only stamped couplings become repo docs (docs/MAP.md)")], [tE("누가", "who"), tE("사람 — 원할 때만(선택)", "human — only when you want (optional)")], [tE("효과", "effect"), tE("다음 정찰·검증의 확정 지식 입력", "trusted input for future recon & verification")], [tE("없으면?", "if absent"), tE("아무 문제 없음 — ①~③은 그대로 자동", "totally fine — ①–③ keep running automatically")]])}
</div>
<div class="vrel">${tE("<b>검증(2트랙)과의 관계</b> — 구현 Claude가 코드를 바꾸면 Codex가 검증합니다(기존 2트랙). 정찰은 그 앞뒤에 붙습니다: 바꾸기 전 ②가 '어디를 확인해야 하나'를 주고, 검증이 끝나면 그 결과가 ③에 자동으로 쌓여 다음 ②가 더 똑똑해집니다.", "<b>Relation to verification (2-track)</b> — Claude implements, Codex verifies (the existing 2 tracks). Recon wraps around it: before a change, ② tells you what to check; after verification, results accrue into ③ so the next ② gets smarter.")}</div>
<h1 style="margin-top:20px">${tE("전체 배선도 — 무엇이 무엇을 만들고, 사람은 어디서 개입하나", "Full wiring diagram — what produces what, and where humans step in")}</h1>
<div class="sub">${tE("실선=자동 흐름 · 점선=피드백(다음 정찰이 더 똑똑해지는 경로) · ⚙ 자동(AI 없음) · ⚡ AI 호출 · 👤 사람 선택", "solid = automatic flow · dashed = feedback (how the next recon gets smarter) · ⚙ auto (no AI) · ⚡ AI call · 👤 human optional")}</div>
<svg viewBox="0 0 960 470" style="width:100%;max-width:960px;border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editorWidget-background);margin:8px 0" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
  <style>text{font-family:inherit;fill:var(--vscode-foreground)} .bx{fill:var(--vscode-editor-background);stroke-width:1.6;rx:8} .t1{font-size:12px;font-weight:700} .t2{font-size:10px;opacity:.8} .lb{font-size:9.5px;opacity:.75} .ln{stroke:var(--vscode-descriptionForeground);stroke-width:1.4;fill:none;color:var(--vscode-descriptionForeground)} .fb{stroke-dasharray:5 4}</style>
  <rect class="bx" x="14" y="30" width="120" height="52" stroke="#7f8c9b"/><text class="t1" x="26" y="50">${tE("👨‍💻 작업", "👨‍💻 Your work")}</text><text class="t2" x="26" y="66">${tE("파일 수정·플랜", "edits · plans")}</text>
  <rect class="bx" x="170" y="30" width="140" height="52" stroke="#3ca89a"/><text class="t1" x="182" y="50">${tE("⚙ ① 변경 감지", "⚙ ① Sensing")}</text><text class="t2" x="182" y="66">${tE("확장이 자동 관찰", "extension watches")}</text>
  <rect class="bx" x="346" y="18" width="160" height="76" stroke="#3ca89a"/><text class="t1" x="358" y="38">${tE("📦 증거 꾸러미", "📦 Evidence pack")}</text><text class="t2" x="358" y="54">${tE("바뀐 내용·참조·과거 힌트", "diff · refs · history hints")}</text><text class="t2" x="358" y="68">${tE("+ 일지 신뢰분 + 교범", "+ trusted journal + manual")}</text><text class="t2" x="358" y="82">${tE("(자동 조립·민감정보 제외)", "(auto-built · secrets excluded)")}</text>
  <rect class="bx" x="542" y="30" width="150" height="52" stroke="#9a6cdc"/><text class="t1" x="554" y="50">${tE("⚡ ② 정찰 AI", "⚡ ② Scout AI")}</text><text class="t2" x="554" y="66">${tE("기본=Claude · 키 시 DeepSeek", "default=Claude · DeepSeek w/ key")}</text>
  <rect class="bx" x="728" y="30" width="120" height="52" stroke="#9a6cdc"/><text class="t1" x="740" y="50">${tE("🗺 영향지도", "🗺 Impact map")}</text><text class="t2" x="740" y="66">${tE("어디까지 번지나", "how far it reaches")}</text>
  <line class="ln" x1="134" y1="56" x2="166" y2="56" marker-end="url(#ah)"/><line class="ln" x1="310" y1="56" x2="342" y2="56" marker-end="url(#ah)"/><line class="ln" x1="506" y1="56" x2="538" y2="56" marker-end="url(#ah)"/><line class="ln" x1="692" y1="56" x2="724" y2="56" marker-end="url(#ah)"/>
  <rect class="bx" x="728" y="120" width="120" height="44" stroke="#7f8c9b"/><text class="t1" x="740" y="138">${tE("👁 게시판", "👁 Board")}</text><text class="t2" x="740" y="153">${tE("사람 열람 전용", "read-only for you")}</text>
  <line class="ln" x1="788" y1="82" x2="788" y2="116" marker-end="url(#ah)"/>
  <rect class="bx" x="366" y="150" width="230" height="56" stroke="#2f6fb3"/><text class="t1" x="378" y="170">${tE("🔍 Codex 검증 ⚡ (기존 2트랙)", "🔍 Codex verify ⚡ (2-track)")}</text><text class="t2" x="378" y="186">${tE("지도 high 항목이 검증 요청에 자동 동봉", "map's high items auto-attach to verify asks")}</text><text class="t2" x="378" y="199">${tE("통과+실제 파일 인용 → 지식 '확인' 신호", "pass + real file citations → 'confirm' signal")}</text>
  <path class="ln" d="M 728 70 C 640 100 620 130 600 150" marker-end="url(#ah)"/><text class="lb" x="618" y="120">${tE("동봉", "attach")}</text>
  <rect class="bx" x="80" y="150" width="200" height="56" stroke="#d97a7a"/><text class="t1" x="92" y="170">${tE("🚧 플랜 게이트 (3트랙 기본 켜짐·끌 수 있음)", "🚧 Plan gate (on by default in 3-track, can be turned off)")}</text><text class="t2" x="92" y="186">${tE("플랜 확정 전 지도 신선한지 확인", "checks map freshness before plan exit")}</text><text class="t2" x="92" y="199">${tE("낡으면 '지도부터' 안내(세션 2회 상한)", "if stale: 'map first' (max 2/session)")}</text>
  <path class="ln" d="M 74 82 C 74 110 80 130 110 150" marker-end="url(#ah)"/>
  <rect class="bx" x="250" y="250" width="420" height="88" stroke="#3ca89a"/><text class="t1" x="262" y="270">${tE("📔 ③ 관찰 일지 — 자동 기억(이 PC)", "📔 ③ Field journal — auto memory (this PC)")}</text>
  <text class="t2" x="262" y="288">${tE("✚ 제안(지도가 발견) ▶ 동봉(자료에 실림) ✔ 확인(검증이 인정) ✖ 반박(틀림 판명)", "✚ proposed (map finds) ▶ attached (packed) ✔ confirmed (verify agrees) ✖ disputed")}</text>
  <text class="t2" x="262" y="304">${tE("신분: 미검증(참고) → 신뢰(자동 반영) / 틀림 판명(제외 — 반박 뒤 재확인 쌓이면 복권)", "states: unverified (reference) → trusted (auto-fed) / disputed (excluded — rehabilitated on later re-confirms)")}</text>
  <text class="t2" x="262" y="320">${tE("👤 개입(선택): 고정=신뢰 강제 · 차단=제외 — 안 눌러도 굴러감", "👤 optional: pin = force-trust · ban = exclude — runs fine untouched")}</text>
  <path class="ln" d="M 800 82 C 860 140 820 220 670 268" marker-end="url(#ah)"/><text class="lb" x="812" y="180">${tE("발견을 제안으로", "findings → proposals")}</text>
  <path class="ln" d="M 481 206 L 481 246" marker-end="url(#ah)"/><text class="lb" x="489" y="232">${tE("확인/반박", "confirm/refute")}</text>
  <rect class="bx" x="80" y="266" width="120" height="52" stroke="#7f8c9b"/><text class="t1" x="92" y="286">${tE("🗣 당신의 말", "🗣 Your words")}</text><text class="t2" x="92" y="302">${tE("'그건 아니야' =", "'that's wrong' =")}</text><text class="t2" x="92" y="314">${tE("정정 근거로 기록", "recorded as dispute")}</text>
  <line class="ln" x1="200" y1="292" x2="246" y2="292" marker-end="url(#ah)"/>
  <rect class="bx" x="728" y="380" width="200" height="60" stroke="#d9a441"/><text class="t1" x="740" y="400">${tE("📕 ④ 확정 교범 👤", "📕 ④ Field manual 👤")}</text><text class="t2" x="740" y="416">${tE("도장 찍은 항목만 저장소 문서로", "only stamped items → repo doc")}</text><text class="t2" x="740" y="430">${tE("팀·다른 PC 공유 · 자동 주입 없음", "shared via repo · never auto-injected")}</text>
  <path class="ln" d="M 670 310 C 720 330 740 350 780 376" marker-end="url(#ah)"/><text class="lb" x="700" y="348">${tE("👤 도장(선택)", "👤 stamp (optional)")}</text>
  <path class="ln fb" d="M 250 300 C 120 340 150 120 342 80" marker-end="url(#ah)"/><text class="lb" x="128" y="238">${tE("신뢰분이 다음 꾸러미로", "trusted feeds next pack")}</text>
  <path class="ln fb" d="M 728 400 C 300 460 240 200 350 96" marker-end="url(#ah)"/><text class="lb" x="300" y="430">${tE("교범도 다음 꾸러미의 확정 사실로", "manual feeds next pack as settled fact")}</text>
</svg>
<div class="sub">${tE("한눈 요약: 지도(⚡ 1회)가 발견을 내고 → 검증이 그 발견을 채점하고 → 일지가 스스로 기억하고(틀림도 반박 뒤 재확인이 쌓이면 복권) → 확실해진 것만 당신이 도장 찍어 문서로 남깁니다. 사람 개입 지점은 👤 세 곳(고정·차단·도장)과 게이트 스위치, 그리고 원하면 '단계별 기본 원칙' ④칸의 정찰 태도 편집 — 전부 선택입니다.", "In one line: the map (one ⚡ call) makes findings → verification grades them → the journal remembers by itself (even 'wrong' entries rehabilitate on later re-confirms) → you stamp only what's proven into a doc. Human touchpoints are the three 👤 spots (pin · ban · stamp), the gate switch, and optionally editing the scout attitude in Stage Baselines slot ④ — all optional.")}</div>
<h1 style="margin-top:20px">${tE("프로젝트 유형별 — 기대할 수 있는 실효성", "By project type — what to realistically expect")}</h1>
<div class="sub">${tE("유형은 구조로 판단하세요(이름이 아니라). '참고 실측'은 이 도구를 만들며 그 유형에서 실제 운용해 확인한 사례입니다.", "Judge by structure, not by name. 'Reference run' notes where this tool was actually operated on that shape during development.")}</div>
<div class="types" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin:12px 0">
${card("#c95f6e", "🕸", "대형 서비스(그물형)", "Large service (web-like)", [[tE("구조", "shape"), tE("수많은 부품이 신경망처럼 얽혀 변경 하나가 멀리 번짐", "many parts intertwined — one change ripples far")], [tE("기대", "expect"), tE("최대 효과 — 번짐 예측(②)·과거 힌트(①)의 가치가 가장 큼", "highest value — ripple preview (②) & history hints (①) shine")], [tE("참고 실측", "reference run"), tE("대형 Python 챗봇 서비스에서 지도 생성·씨앗 추출 확인", "map generation & seeding verified on a large Python chat service")]])}
${card("#5b8dd9", "🧩", "라이브러리·모듈형", "Library / modular", [[tE("구조", "shape"), tE("부품 경계가 뚜렷 — 영향이 대체로 국소적", "clear part boundaries — impact mostly local")], [tE("기대", "expect"), tE("중간~높음 — '한쪽이 쓰고 다른 쪽이 읽는' 파일 짝·사본 동기화 놓침을 잘 잡음", "medium-high — catches writer/reader file pairs & copy-sync misses well")], [tE("참고 실측", "reference run"), tE("이 도구 자신(확장+브릿지+스크립트)이 이 형태로 상시 운용 중", "this tool itself (extension+bridge+scripts) runs on this shape daily")]])}
${card("#3ca89a", "📝", "문서·메모 폴더", "Docs / notes folder", [[tE("구조", "shape"), tE("변경 기록(버전 관리) 없음", "no change history (version control)")], [tE("기대", "expect"), tE("제한적 — 과거 힌트(①) 불가, 최근 수정 기준 지도(②)와 일지(③)만", "limited — no history hints (①); maps from recent edits (②) + journal (③) only")], [tE("참고 실측", "reference run"), tE("메모 폴더에서 무이력 지도 생성 확인", "historyless maps verified on a notes folder")]])}
${card("#d9a441", "🌱", "신생 프로젝트", "Young project", [[tE("구조", "shape"), tE("기록이 아직 얕음", "history still shallow")], [tE("기대", "expect"), tE("점증 — 처음엔 ①이 조용하고(표본 부족) ②③부터 가치, 기록이 쌓일수록 상승", "grows over time — ① quiet at first (few samples); value starts at ②③ and rises as records accrue")], [tE("참고 실측", "reference run"), tE("아직 별도 실증 없음(원리상 위 유형들의 초기 상태와 동일)", "no separate run yet (in principle the early state of the types above)")]])}
</div>
<div class="sub">${tE("공통 한계(정직): 처음 생기는 결합은 어떤 기록에도 없어 못 봅니다 · 실행해봐야 드러나는 동작(타이밍·권한·OS 차이)은 안 담깁니다 · AI 정찰(⚡)을 한 번도 실행하지 않으면 ②③④는 비어 있습니다.", "Honest common limits: first-ever couplings exist in no record and can't be seen · behaviors only running reveals (timing, permissions, OS differences) aren't captured · if AI recon (⚡) never runs, ②③④ stay empty.")}</div>
<div class="faq">
<b>${tE("Q. 내가 일일이 승인해야 하나요?", "Q. Do I have to approve things one by one?")}</b>
${tE("아니요. 적재·승격·강등은 전부 자동입니다. 👤 단계(확정 교범 내보내기)와 고정/차단만 선택 개입이고, 안 써도 아무것도 멈추지 않습니다.", "No. Accrual, promotion and demotion are fully automatic. Only the 👤 step (exporting to the manual) and pin/ban are optional — skipping them stops nothing.")}
<b>${tE("Q. 언제 비용(LLM 호출)이 나가나요?", "Q. When does an LLM call (cost) happen?")}</b>
${tE("⚡ 단계(영향지도 생성)뿐입니다 — 기본 정찰은 별도 과금 없이 쓰시던 Claude로 실행되고(Claude 사용량 범위), DeepSeek 정찰은 키를 등록했을 때만. ⚙ 단계들은 LLM 없이 돌고, 상태바 호버에 '지금 실행 중인 LLM 호출' 여부가 항상 표시됩니다.", "Only the ⚡ step (map generation) — the default scout adds no separate billing and runs on the Claude you already use (within your Claude usage); the DeepSeek scout only with a registered key. ⚙ steps run without LLM, and the status-bar hover always shows whether an LLM call is running.")}
<b>${tE("Q. AI 정찰(⚡)을 한 번도 실행하지 않으면 어떻게 되나요?", "Q. What if the AI recon (⚡) never runs?")}</b>
${tE("①(변경 감지)의 힌트만 동작하고, ②③④는 계속 비어 있습니다 — 이 축의 실질 성과는 AI 정찰 실행에서 나옵니다. 즉 3트랙을 켜기만 하고 정찰을 안 돌리면 얻는 것이 거의 없습니다.", "Only ①'s hints work; ②③④ stay empty — this axis delivers real value through AI recon runs. Turning 3-track on without ever running recon yields very little.")}
<b>${tE("Q. 데이터는 어디로 가나요?", "Q. Where does data go?")}</b>
${tE("전부 이 컴퓨터의 브릿지 홈에 남습니다. 외부로 나가는 경로는 두 갈래 — ⑴ DeepSeek 키 등록 시: ① DeepSeek 정찰 '실행 순간'의 증거 꾸러미(민감 범주 파일은 내용도 이름도 가려짐) ② 3트랙을 켤 때 연결 점검 요청 1회(꾸러미 아님) ⑵ 기본 정찰 실행 시: 같은 꾸러미가 쓰시던 Claude CLI를 통해 Claude 서비스로 전달(별도 결제 없음 — 검증이 Codex로 가는 것과 같은 성격). 상세는 PRIVACY.md.", "Everything stays in the bridge home on this machine. Data leaves via two routes — ⑴ with a DeepSeek key: ① the evidence package at the moment the DeepSeek scout runs (sensitive-category files excluded by content and by name) ② a single connection check when you switch on 3-track (not a package) ⑵ when the default scout runs: the same package travels through your existing Claude CLI to the Claude service (no separate billing — same nature as verification going to Codex). Details in PRIVACY.md.")}
</div>
</body></html>`;
}

// 정찰 건강 리포트 — 대시보드 포화 대응(사용자 지시 2026-07-09): 관찰 신호의 확장판은 현황에 더 얹지 않고 새탭으로.
// openReconGuide와 같은 안전 패턴(enableScripts:false + default-src 'none' — 스크립트 원천 차단·닫으면 끝)이되,
// 여기는 '동적 데이터'(경로·타임라인 원문)를 HTML에 굽으므로 esc() 이스케이프가 전면 필수(Codex 사전검증 지적).
// 데이터는 열 때 readMapLedgerUncached로 베이크(5초 캐시 우회 — '열 때 기준' 문구를 거짓말로 안 만듦). 새로 열면 최신.
function openScoutHealthReport(ws: string | null): void {
  if (!ws) { vscode.window.showInformationMessage(tE("폴더가 열려 있지 않아 리포트를 만들 수 없어요.", "No folder is open, so the report cannot be built.")); return; }
  let ml: MapLedgerView; let gate: { eff: string; raw: string | null };
  try { ml = readMapLedgerUncached(ws); gate = effectiveScoutGate(ws); }
  catch { vscode.window.showWarningMessage(tE("관찰 일지 판독에 실패했어요 — 잠시 후 다시 시도하세요.", "Failed to read the field journal — try again shortly.")); return; }
  const target = scoutTargetFor(ws).repo;
  const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
  const h = ml.health;
  const panel = vscode.window.createWebviewPanel("codexBridgeScoutHealth", tE("정찰 건강 리포트", "Scout health report"), vscode.ViewColumn.Beside, { enableScripts: false });
  const stat = (n: number | string, ko: string, en: string, color: string, subKo?: string, subEn?: string) =>
    `<div class="card" style="border-top:3px solid ${color}"><div class="num" style="color:${color}">${esc(n)}</div><div class="lbl">${tE(ko, en)}</div>${subKo ? `<div class="sub2">${tE(subKo, subEn || "")}</div>` : ""}</div>`;
  const small = h.entries < HEALTH_MIN_SAMPLE; // 표본 게이트 — ask 동봉·대시보드 줄과 같은 기준(항목<5면 비율 무주장)
  const cards = small
    ? `<div class="notice">${tE(`관찰 일지가 아직 작아요(항목 ${h.entries}건 &lt; ${HEALTH_MIN_SAMPLE}건) — 비율은 표시하지 않습니다(과신 방지). 지도는 후보 목록으로만 쓰세요. 정찰·검증이 돌수록 이 리포트가 채워집니다.`, `The field journal is still small (${h.entries} item(s) &lt; ${HEALTH_MIN_SAMPLE}) — ratios are withheld to avoid overconfidence. Treat maps as candidate lists only. This report fills in as recon & verification run.`)}</div>`
    : `<div class="grid">
${stat(h.entries, "관찰 항목", "observed items", "#3ca89a", "일지에 쌓인 결합 항목 수(이벤트 반복은 1항목)", "coupling items in the journal (repeated events count once)")}
${stat(`${h.verified}/${h.entries}`, "확인 항목", "confirmed items", "#4a9e57", "검증을 통과해 신뢰로 승격된 항목", "items promoted to trusted via verification")}
${stat(h.reusedDen >= HEALTH_MIN_SAMPLE ? `${h.reusedNum}/${h.reusedDen}` : "—", "재사용 항목 중 확인 이력", "reused items with a confirm", "#9a6cdc", h.reusedDen >= HEALTH_MIN_SAMPLE ? "지도에 다시 동봉된 항목 중 확인 기록이 있는 것(선후 무주장)" : `재사용 표본이 ${HEALTH_MIN_SAMPLE}건 미만이라 보류`, h.reusedDen >= HEALTH_MIN_SAMPLE ? "re-attached items that have a confirm on record (no order claim)" : `withheld — fewer than ${HEALTH_MIN_SAMPLE} reused samples`)}
${stat(h.disputedEntries, "반박 이력", "disputed", "#d9a441", "수동 기록 기준 — 자동 반박 추출은 아직 없음", "manually recorded — no automatic dispute extraction yet")}
${stat(h.rehabilitated, "복권", "rehabilitated", "#4a9e57", "반박 뒤 재확인(사람 1회/검증 2회)으로 신뢰 복귀", "back to trusted after re-confirms (1 human / 2 verify)")}
</div>`;
  const gateLine = gate.eff === "plan"
    ? (gate.raw === "plan" ? tE("켜짐(직접 설정)", "on (set by you)") : tE("켜짐(3트랙 기본 — 2026-07-09 승격: 재실측 70.5% &gt; 합격선 60%)", "on (3-track default — promoted 2026-07-09: re-measured 70.5% &gt; the 60% bar)"))
    : tE("꺼짐(직접 끄심)", "off (turned off by you)");
  const tl = ml.timeline.slice(0, 12).map((it) => {
    const when = it.ts ? new Date(it.ts).toLocaleString() : "?";
    return `<tr><td class="ts">${esc(when)}</td><td class="ty">${esc(it.type)}</td><td>${esc(it.text)}</td></tr>`;
  }).join("");
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:18px;max-width:900px}
h1{font-size:16px} h2{font-size:13px;margin:16px 0 6px} .sub{color:var(--vscode-descriptionForeground);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:10px 0}
.card{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px}
.num{font-size:20px;font-weight:700} .lbl{font-size:12px;margin-top:2px} .sub2{font-size:10.5px;color:var(--vscode-descriptionForeground);margin-top:4px}
.notice{border:1px dashed var(--vscode-panel-border);border-radius:6px;padding:10px;font-size:12px;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:11.5px} td{border-bottom:1px solid var(--vscode-panel-border);padding:4px 6px;vertical-align:top}
.ts{white-space:nowrap;color:var(--vscode-descriptionForeground)} .ty{white-space:nowrap;font-weight:600}
.limits{margin-top:14px;padding:10px;border-left:3px solid #d9a441;background:var(--vscode-editorWidget-background);font-size:12px}
</style></head><body>
<h1>${tE("정찰 건강 리포트 — 이 프로젝트의 관찰 신호", "Scout health report — this project's observation signals")}</h1>
<div class="sub">${tE("열 때 기준", "as of opening")}: ${esc(new Date().toLocaleString())} · ${tE("정찰 대상", "scout target")}: ${esc(target)}${normWs(target) !== normWs(ws) ? tE(" (세션 폴더와 다름 — 계약 지정 대상 기준 집계)", " (differs from the session folder — figures accrue for the contract-set target)") : ""}</div>
<div class="sub">${tE("전역 임계값 대신 '이 프로젝트의 관찰 일지'가 신뢰 판단 재료입니다(프로젝트별·advisory — 아무것도 자동 강제하지 않음). 닫았다 다시 열면 최신으로 다시 계산돼요.", "Instead of a global threshold, this project's own field journal is the trust evidence (per-project · advisory — nothing is auto-enforced). Close and reopen for a fresh computation.")}</div>
${cards}
<h2>${tE("플랜 게이트", "Plan gate")}</h2>
<div class="sub">${gateLine} — ${tE("지도가 없거나 낡으면 플랜 확정 전에 먼저 지도를 요청(세션당 2회까지·이후 통과·fail-open). 차단 안내에는 위 관찰 신호가 함께 실립니다 — 전역 수치가 아니라 이 프로젝트의 장부가 근거. 켜고 끄기: node scripts/scope-gate.js &lt;프로젝트&gt; on|off (현재 언어 슬롯에만 저장 — 한/영 모드는 별도 설정)", "if the map is missing/stale, a map is requested before plan confirmation (up to 2×/session, then passes · fail-open). The block notice carries the observation signals above — this project's journal is the evidence, not a global number. Toggle: node scripts/scope-gate.js &lt;repo&gt; on|off (saved to the current language slot only — ko/en modes are configured separately)")}</div>
<h2>${tE("이 신호는 어디서 생기고 어디에 반영되나 — 관찰 신호의 역할", "Where these signals come from and where they act — the role of observation signals")}</h2>
<div class="grid">
${stat("⚙", "1. 감지 (자동)", "1. Sensing (automatic)", "#3ca89a", "검증 대화의 확인·지도 재동봉·당신이 확정 어조로 기록한 정정/확인이 사건(제안·동봉·확인·반박)으로 잡혀요 — 추가 AI 호출 0", "confirms from verification chats, map re-attachments, and corrections you record with certainty become events (proposed·attached·confirmed·disputed) — zero extra AI calls")}
${stat("📔", "2. 기록 (관찰 일지)", "2. Recording (field journal)", "#3ca89a", "이 프로젝트(정찰 대상) 전용 장부에 덧붙이기만 — 반박 이력도 지우지 않고 보존, 반박 뒤 재확인이 쌓이면 복권", "append-only, per project (scout target) — dispute history is never erased; re-confirms after a dispute can rehabilitate")}
${stat("🩺", "3. 해석 (관찰 신호)", "3. Interpretation (observation signals)", "#9a6cdc", "장부를 항목 단위로 보수 집계 — 위 카드의 수치. 모든 프로젝트에 같은 합격선을 들이대는 전역 임계값이 없어요", "the journal is conservatively counted per item — the cards above. No global threshold that judges every project by the same bar")}
${stat("📤", "4. 반영 (4곳)", "4. Application (4 places)", "#d9a441", "정찰 AI에게 보내는 지도 자료 꼬리 · 플랜 게이트 차단 안내 · 이 리포트(셋은 그 순간 장부에서 새로 계산) · 대시보드 관찰 일지 카드 1줄(몇 초 안의 짧은 캐시로 따라잡음)", "the tail of map material sent to the scout AI · the plan-gate block notice · this report (these three recompute from the journal at that moment) · the one-line dashboard signal (catches up within a few seconds via a short cache)")}
</div>
<div class="notice">${tE("<b>차별점 — 고정값이 아니라 따라가는 값</b>: 어떤 프로젝트는 파일이 촘촘히 얽혀 있고 어떤 프로젝트는 독립적이라, 하나의 합격 숫자를 박아두면 어딘가에선 반드시 틀립니다. 그래서 이 시스템은 숫자를 고정하지 않고, 그 프로젝트의 관찰 일지에서 매번 다시 계산합니다. 다만 정직하게: 이것은 '스스로 학습해 최적값을 찾아가는 제어 장치'가 아니라 **관측치**입니다 — 무엇도 자동 조정하지 않고(advisory), 플랜 게이트조차 이 신호를 '근거 인용'으로만 실으며, 수치의 품질은 결국 정찰·검증이 실제로 돌고 사람이 반박·차단으로 정정해 주는 만큼만 좋아집니다.", "<b>What makes this different — a tracking value, not a fixed one</b>: some projects are tightly coupled, others independent, so any single hard-coded pass number is wrong somewhere. This system fixes no number — it recomputes from that project's own field journal every time. Honestly though: this is an **observation**, not a self-tuning controller — nothing is auto-adjusted (advisory), even the plan gate only quotes these signals as evidence, and the numbers are only as good as the recon/verification runs and the human dispute/ban corrections behind them.")}</div>
<h2>${tE("최근 사건 흐름(최신 12건)", "Recent events (latest 12)")}</h2>
${tl ? `<table>${tl}</table>` : `<div class="sub">${tE("아직 기록된 사건이 없어요 — 정찰 지도가 결합을 제안하면 자동으로 쌓입니다.", "No events recorded yet — they accrue automatically once scout maps propose couplings.")}</div>`}
${ml.dropped ? `<div class="sub">${tE(`ⓘ 판독 불가 기록 ${ml.dropped}줄은 건너뜀(집계에 안 섞임)`, `ⓘ ${ml.dropped} unreadable record line(s) skipped (not counted)`)}</div>` : ""}
<div class="limits">${tE("<b>읽는 법(한계 고지)</b> — 이 수치는 관측치이고 편향은 양방향일 수 있어요: 자동 반박 추출이 없어 반박은 적게 잡히고, 지도에 실려 검증자에게 노출된 항목은 확인이 잘 잡힙니다(검증이 안 돌면 확인 기회 자체가 없음). '재사용 항목 중 확인 이력'은 선후 인과를 주장하지 않습니다. 지도는 후보 목록이지 안전 보장이 아니에요 — 지도 밖 독립 확인을 유지하세요.", "<b>How to read this (limits)</b> — these are observations and the bias can go both ways: with no automatic dispute extraction, disputes are undercounted; items exposed to the verifier via map attachment get confirmed more easily (and without verification runs there is no chance to confirm at all). 'Reused items with a confirm' makes no order/causality claim. Maps are candidate lists, not safety guarantees — keep independent checks beyond the map.")}</div>
</body></html>`;
}

// 두뇌 '실제 답' 평시 정보 문구 — 결정 실험(2026-07-08)의 산물: 앱 UI 두 곳(빠른메뉴 줄 라벨 vs 모델 피커 체크마크)이
// 서로 다르게 보이는 표시 결함이 실측됐고, 그때 사용자가 믿을 정본은 '답변마다 대화 기록에 찍히는 실제 모델'이었다.
// 그 정본을 경고가 아닌 상시 정보로 노출한다(어긋남 판정은 기존 drift 경고가 담당 — 여기는 판정 없이 사실만).
// 소스는 drift 계산과 동일(scanCcTranscript/sessionModelMeta — cwd 필터·증분 캐시)이라 경고와 값이 어긋날 수 없다.
function brainActualTexts(ws: string | null): { cc: string; cx: string; sig: string } {
  const none = tE("기록 없음", "no record");
  let cc = none, cx = none, sig = "|";
  if (!ws) return { cc, cx, sig };
  try {
    const ccT = currentTranscriptForWs(ws);
    const a = ccT ? scanCcTranscript(ccT, ws).actual : null;
    if (a && a.model) {
      cc = `${modelFamily(a.model) || a.model} · ${ageLabel(Date.now() - a.ts, loadLangExt() === "en")}`;
      sig = a.model + sig;
    }
  } catch { /* best-effort — 정보 표시라 실패는 '기록 없음'으로 */ }
  try {
    const link = workspaceLink(loadLinks(), ws);
    const f = link?.codexSession ? findRolloutById(link.codexSession) : undefined;
    if (f) {
      const sm = sessionModelMeta(f, ws);
      const t = Date.parse(sm.ts || "");
      if (sm.model && Number.isFinite(t)) {
        cx = `${sm.model}${sm.effort ? `(${sm.effort})` : ""} · ${ageLabel(Date.now() - t, loadLangExt() === "en")}`;
        sig = sig + sm.model + "|" + (sm.effort || "");
      }
    }
  } catch { /* best-effort */ }
  return { cc, cx, sig };
}
// 탐색자 카드 '마지막 정찰 실행' 문구 — 비용 장부(scout-usage)의 정찰 방식별 lastTs 기준(지도 10장 프루닝과 무관).
// ping(연결 점검)은 정찰이 아니므로 제외. 3트랙이 아닐 땐 카드 자체가 숨겨져 호출 결과 무의미.
function scoutActualText(ws: string | null): string {
  if (!ws) return "";
  try {
    const sc = readScoutCosts(ws);
    const en = loadLangExt() === "en";
    let best: { arm: string; ts: number } | null = null;
    for (const [arm, v] of Object.entries(sc.byArm || {})) {
      if (arm === "ping") continue;
      const t = Date.parse((v as { lastTs?: string }).lastTs || "");
      if (Number.isFinite(t) && (!best || t > best.ts)) best = { arm, ts: t };
    }
    if (!best) return en ? "no scout run in the last 28 days" : "최근 28일 정찰 실행 없음";
    const armLabel = best.arm === "deepseek" ? (en ? "DeepSeek scout" : "DeepSeek 정찰") : (en ? "default scout (Claude)" : "기본 정찰(Claude)");
    return (en ? "last map: " : "마지막 지도: ") + armLabel + " · " + ageLabel(Date.now() - best.ts, en);
  } catch { return ""; }
}

// '연결된 Codex 세션 없음'을 빨강(error) 무결성 경보로 reconcile한다. brain-drift와 같은 '상태 reconcile' 패턴(sig 없는 단일 kind):
// 연결 없으면 1건 유지(없으면 추가), 연결 생기면 제거. ★다른 빨강(verify-incomplete 등)과 달리 ack로는 안 사라진다 —
// ackHere/배너 '확인함'이 이 kind를 제외하므로, 오직 '연결'(수동 link 또는 자동 새 세션 생성·연결)로만 해소된다.
// 이 함수는 session-missing만 건드린다(타 kind·타 ws 보존) → 기존 빨강의 ack 동작은 그대로.
function syncSessionMissing(ws: string | null): void {
  if (!ws) return;
  try {
    withIntegrityLockExt(() => { // P1-② — read~write 한 임계(경고 유실 방지)
    const KIND = "session-missing";
    const events = readIntegrity() as any[];
    const wsMatch = (e: any) => !e.workspace || normWs(e.workspace) === normWs(ws);
    const links = loadLinks();
    const hasLink = !!(workspaceLink(links, ws) || {}).codexSession; // 이 폴더에 연결 고정된 Codex 세션이 있나
    const blocked = !hasLink && !!(links.autoNewFailed || {})[normWs(ws)]; // 자동 새 세션 생성이 막힌 상태(연속 실패 폭증방지) → '시도' 대신 '멈춤' 안내
    const sig = blocked ? "session-missing:blocked" : "session-missing:normal";
    // detailKo/detailEn 동시 저장(표시는 readVisibleIntegrity가 현재 언어 선택) — 문구는 integrity-i18n.ts STATIC과 자구 일치 유지.
    const dKo = blocked
      ? "현재 연결된 Codex 세션이 없고, 자동 생성이 멈춰 있습니다. 'Codex 세션 연결'에서 수동으로 연결하세요. 계속되면 개발자에게 문의해 주세요."
      : "현재 연결된 Codex 세션이 없습니다. 'Codex 세션 연결'에서 수동으로 연결하거나, 검증을 계속 진행하면 새 세션 생성·연결을 자동으로 시도합니다.";
    const dEn = blocked
      ? "No Codex session is linked and auto-creation is paused. Link one manually under 'Codex Session Link'. If this persists, please report it."
      : "No Codex session is linked. Link one manually under 'Codex Session Link', or keep verifying and a new session will be created and linked automatically.";
    const detail = tE(dKo, dEn);
    // 연결 있으면 이 ws의 session-missing 전부 제거. 없으면 '현재 sig + 미확인'만 보존(상태가 정상↔막힘으로 바뀌어 sig가 다르거나 ack된 건 제거 → 아래서 새 detail로 재생성).
    // ★ack된 것·옛 sig를 제거+재생성하므로 (1)외부 ack-all로 ack돼도 (2)정상↔막힘 전환에도 연결 없는 한 항상 '최신 detail의 빨강'이 유지된다('연결로만 해소' + detail 자동 갱신).
    const kept = events.filter((e) => e.kind !== KIND || !wsMatch(e) || (!hasLink && e.sig === sig && !e.ack));
    const present = kept.some((e) => e.kind === KIND && wsMatch(e)); // 살아남은(현재 sig·미확인) session-missing이 있나
    if (!hasLink && !present) {
      kept.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ack: false, ts: new Date().toISOString(), session: "", workspace: ws, kind: KIND, severity: "error", detail, detailKo: dKo, detailEn: dEn, sig });
    }
    if (kept.length !== events.length || kept.some((e, i) => e !== events[i])) atomicWrite(INTEGRITY_FILE, JSON.stringify({ events: kept.slice(-50) }));
    });
  } catch { /* best-effort */ }
}
// 무결성 경보 툴팁: 상태바 '바로 위'에 뜨는 '인터랙티브 호버'(MarkdownString+command 링크) — 마우스를 올려 링크 클릭 가능.
// 평범한 문자열 툴팁과 달리 호버 안으로 진입 가능(VS Code #126753 fixed; 상태바 항목에 command가 있어야 마크다운 호버가 뜸 — 충족).
// isTrusted는 우리 두 커맨드로만 좁힌다(임의 command: 링크 실행 방지). $(icon)은 supportThemeIcons로 렌더.
function alertTooltip(headMd: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(
    headMd + tE(`\n\n---\n\n[$(check) **확인함** — 이 창 경고 읽음](command:codexBridge.ackHere)\n\n[$(dashboard) **대시보드 열기**]`,`\n\n---\n\n[$(check) **Acknowledge** — read this window's alerts](command:codexBridge.ackHere)\n\n[$(dashboard) **Open dashboard**]`) + `(command:codexBridge.openDashboard)`,
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
    case "claude-working": return { key: "claude", label: tE("Claude 작업중","Claude working"), icon: "$(pencil)", spin: false, round, color: "charts.blue" };
    case "codex-verifying":
      return linkedRolloutRecentlyWritten(linkedId)
        ? { key: "codex-gen", label: tE("Codex 생성중","Codex generating"), icon: "$(sync~spin)", spin: true, round, color: "charts.green" }
        : { key: "codex-req", label: tE("코덱스에 검증 요청","verify requested to Codex"), icon: "$(sync~spin)", spin: true, round, color: "charts.yellow" };
    case "rejudging": return { key: "rejudge", label: tE("검증 답 반영중","applying verify answer"), icon: "$(pencil)", spin: false, round, color: "charts.orange" };
    case "done": return { key: "done", label: tE("검증 완료","verify done"), icon: "$(check)", spin: false, round, color: "charts.green" };
    case "incomplete": return { key: "incomplete", label: tE("검증 미완","unverified"), icon: "$(alert)", spin: false, round, color: "charts.red" };
    default: return null;
  }
}

// 연결 코덱스 세션 rollout에서 누적 토큰(마지막 token_count의 total_token_usage)을 읽는다. usage-monitor와 같은 token_count 구조.
// 파일 끝 256KB만 읽어(rollout 끝에 최신 token_count가 있음) 마지막 total_token_usage를 잡는다. 한 세션 누적값 — 그 세션이 여러 폴더를 오갔다면 합산이다(폴더별 정밀 분해는 turn별 delta+cwd 필요, 다음 정밀화).
// rollout 파일 끝 일부(bytes)만 읽어 문자열로 — token_count는 끝 근처라 전체를 안 읽는다(대용량 rollout 대비).
function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const sz = fs.fstatSync(fd).size;
    const start = Math.max(0, sz - bytes);
    const len = Math.min(sz, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}
// 파일 머리 일부만 — transcript '대화 시작 시각'(첫 timestamp) 산출용(readTail의 대칭).
function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const sz = fs.fstatSync(fd).size;
    const len = Math.min(sz, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}
function readSessionTokens(file: string): CodexTokens | null {
  try {
    let tk = parseSessionTokens(readTail(file, 256 * 1024));
    if (!tk) tk = parseSessionTokens(readTail(file, 2 * 1024 * 1024)); // 끝 256KB에 token_count 없으면(뒤에 큰 메시지가 쌓인 경우) 더 크게 재시도
    return tk;
  } catch { return null; }
}
function computeState(turnsN: number): BridgeState {
  const ws = dashboardWorkspace();
  const links = loadLinks();
  const link = workspaceLink(links, ws);
  const linkedId: string | null = link?.codexSession ?? null;

  let turns: Turn[] = [];
  let turnsTrimmed = false;
  let turnsInnerTrimmed = false;
  let lastActivity: string | null = null;
  let modelMeta: { model: string; effort: string; models: string[] } = { model: "", effort: "", models: [] };
  let codexTokens: CodexTokens | null = null;
  if (linkedId) {
    const file = findRolloutById(linkedId);
    if (file) {
      const racc = rolloutAccFor(file);
      const allTurns = toTurns(racc.msgs);
      turns = allTurns.slice(-Math.max(1, turnsN));
      // 두 원인을 구분 고지(단일 표지는 원인 오표기·창 찼을 때 침묵 — Codex 반례): ①턴 통째 제거는 요청 창을
      // 못 채울 때만 ②선두 턴 내부 생략은 그 턴이 화면에 있을 때(표시=마지막 N턴이므로 전체≤N일 때 선두가 보임).
      turnsTrimmed = racc.turnsDropped && allTurns.length < Math.max(1, turnsN);
      turnsInnerTrimmed = racc.firstTurnInnerDropped && allTurns.length <= Math.max(1, turnsN);
      modelMeta = sessionModelMeta(file, ws); // '지금 쓰는 값' 표시도 이 폴더(cwd) 기준 — drift 경고와 일관(공유 세션서 형제 폴더 값 안 새게)
      codexTokens = readSessionTokens(file); // 연결 세션 누적 토큰(검증 비용 카드)
      try {
        lastActivity = new Date(fs.statSync(file).mtimeMs).toLocaleString();
      } catch {
        /* ignore */
      }
    }
  }
  const pref: any = links.modelPrefs[normWs(ws || "")] || {};
  const scope = readScopeState(ws);       // 3트랙 변경 감지(내부에서 scoutMode 확인·캐시)
  const scoutMaps = readScoutMaps(ws);    // 3트랙 지도 게시판(읽기 전용)

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
      ? tE("계정 모델 목록을 읽었지만 표시할 모델이 없어 기본값으로 보여줘요(코덱스 갱신/버전 확인).","Read the account model list but found none to show — falling back to defaults (check Codex update/version).")
      : tE("계정 모델 목록 파일을 못 찾아 기본값으로 보여줘요 — 코덱스가 아직 목록을 안 받았거나 폴더 위치(CODEX_HOME)가 바뀐 경우예요.","Model list file not found — showing defaults. Codex may not have fetched it yet, or CODEX_HOME moved.");
  }

  // 세션 후보가 0개(연결할 세션이 안 뜸)면 '지금 어느 home/sessions를 보는지·codex·출처'를 노출 → 침묵 실패를 자가진단 가능하게.
  let sessionDiag: BridgeState["sessionDiag"] = null;
  if (!candidates.length && !hiddenCandidates.length) {
    let sessionsExists = false;
    try { sessionsExists = fs.existsSync(SESSIONS_DIR); } catch { /* ignore */ }
    const envHome = (process.env.CODEX_HOME || "").trim();
    const fileHome = readTextSafe(path.join(BRIDGE_DIR, "codex-home.txt")).trim();
    const source = envHome && envHome === CODEX_HOME ? tE("환경변수 CODEX_HOME","env CODEX_HOME")
      : fileHome && fileHome === CODEX_HOME ? tE("자동탐지(codex-home.txt)","auto-detected (codex-home.txt)")
      : tE("기본값 ~/.codex","default ~/.codex");
    sessionDiag = { home: CODEX_HOME, source, sessionsDir: SESSIONS_DIR, sessionsExists, codexBin: resolveCodexPathForBridge() || tE("설정·형제확장에서 못 찾음 → PATH의 codex 시도", "not found via setting/sibling extension → trying codex on PATH") };
  }

  // 두뇌 drift를 integrity로 동기화(상태바/배너) — syncBrainDriftFor가 settings/transcript/rollout을 직접 읽어 계산한다.
  // 대시보드(computeState)·상태바 render() 양쪽에서 같은 함수를 호출하므로, 대시보드를 안 열어도 상태바에 drift가 뜬다.
  syncBrainDriftFor(ws);
  syncSessionMissing(ws);

  return {
    workspace: ws,
    linkedId,
    linkedSnippet: linkedId ? (candidates.find((c) => c.id === linkedId)?.snippet ?? hiddenCandidates.find((c) => c.id === linkedId)?.snippet ?? "") : "",
    linkedAt: link?.linkedAt ?? null,
    lastActivity,
    turns,
    turnsTrimmed,
    turnsInnerTrimmed,
    candidates,
    hiddenCandidates,
    contract: loadContract(ws),
    lang: loadLangExt(),                 // 전역 언어(ko/en) — 탭바 토글 상태 + UI 문자열 선택
    otherSlotRules: otherSlotHasRules(ws), // 반대 언어 슬롯에만 규칙 있음 → '사라진 게 아님' 안내
    baseDirective: loadBaseDirectiveSafe(),
    // 정찰 프롬프트(§6-11): 태도층(편집 가능 슬롯)+형식층(잠금 — 지도를 읽는 기계 배선이라 읽기 전용 노출)
    scoutPrompt: (() => {
      try {
        if (!ws) return null; // 트랙 무관 계산 — ④칸 표시 여부는 웹뷰가 저장된 트랙으로 결정(전환 직후 빈 칸 방지)
        const lib = bridgeLib();
        const b = lib?.loadScoutBaseline?.();
        if (!b || typeof b.text !== "string") return null;
        const lang = loadLangExt();
        const notes = scoutLedgerNotes(lang);
        return { baseline: b.text, overridden: !!b.overridden, directive: scoutDirectiveText(lang), notes: [notes.header, notes.trusted, notes.reference, notes.disputed], version: String(lib?.SCOUT_FORMAT_VERSION || "f1") };
      } catch { return null; }
    })(),
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
    sessionDiag,
    // scope·scoutMaps는 낡은 지도 계산이 함께 쓰므로 위에서 상수로 뽑는다(아래 scoutMapStale 참조)
    integrity: readVisibleIntegrity(ws),
    live: computeLiveStage(linkedId),
    verifyTimeoutMin: clampVerifyTimeout(links.settings?.verifyTimeoutMin),
    verifyStats: readVerifyStats(ws), // 탭2 검증 통계(기간별 분포·전환·히트맵) — 이 폴더(ws) 기준
    scoutCosts: readScoutCosts(ws),   // 정찰 비용(28일 · 정찰 방식별) — 사용자 비용 추정용 투명 기록(2026-07-09)
    codexTokens,                      // 연결 코덱스 세션 누적 토큰(검증 비용 카드)
    claudeTokens: readClaudeTokens(ws), // 이 폴더 클로드 작업 토큰(28일) — 코덱스와 분리
    projectStats: readProjectStats(),   // 프로젝트별 비교(전체 폴더 28일)
    scope,                              // 범위 장부 후보(3트랙에서만 — 내부에서 scoutMode 확인·캐시)
    scoutMaps,                          // 영향지도 게시판(3트랙에서만 — 러너가 보관한 지도 읽기 전용)
    scoutMapStale: computeScoutMapStale(ws, scope, scoutMaps), // 낡은 지도 배지 — 최신 지도 생성 후 더 바뀐 seed 파일 수(경고 아님·게시판 표기)
    scoutLive: readScoutLive(ws),       // 지도 생성중 신호(러너 실행 동안만 — 카드 '지금:'과 상태바 라벨)
    scoutTarget: (() => { if (!ws) return null; try { if (loadContract(ws).scoutMode !== "on") return null; const r = scoutTargetFor(ws); const dr = detectScoutTargetDriftExt(r.repo, ws); return { repo: r.repo, differs: normWs(r.repo) !== normWs(ws), invalid: r.source === "ws-fallback-invalid", configured: r.source === "contract" || r.source === "contract-other-lang", inherited: r.source === "contract-other-lang", drift: dr.drift ? { repo: dr.repo as string, sample: dr.sample || 0, agree: dr.agree || 0 } : null }; } catch { return null; } })(),
    scoutGate: (() => { if (!ws) return null; try { if (loadContract(ws).scoutMode !== "on") return null; return effectiveScoutGate(ws); } catch { return null; } })(),
    mapLedger: readMapLedger(ws),       // MAP 장부(stable 2층) — 대기 제안·승인/기각 이력·확정층 요약(3트랙에서만)
    deepseek: readDeepseekView(),       // 고급설정 탭 — 키 유무·마스킹(원문 미노출)
    brainActual: (({ cc, cx }) => ({ cc, cx, scout: scoutActualText(ws) }))(brainActualTexts(ws)), // 두뇌 '실제 답' 정보 문구(히어로) — sig는 상태바 전용이라 제외
    // 표준 테스트 폴더 '감지' 여부(성격 프로필용) — 외부 전송·LLM 없는 가벼운 로컬 판독. '테스트 없음' 단정이 아니라
    // '표준 폴더 미감지'(src/tests·언어별 관행은 못 볼 수 있음 — scope-package 비재귀 한계 고지와 같은 축).
    hasTestsDir: !!ws && (fs.existsSync(path.join(ws, "tests")) || fs.existsSync(path.join(ws, "test"))),
  };
}

// 최신 지도가 '지금 변경 중인 파일들'보다 오래됐는지 — 지도 생성 시각과 seed 파일 수정 시각의 단순 비교(≤8개 stat, 저비용).
// seed 출처: git 프로젝트=지금 작업트리 변경(scope.seeds) / 무이력(비-git)=그 지도가 근거로 삼았던 파일(지도 메타 seedFiles —
// 멀티 세션에서 남의 작업을 내 지도가 덮은 걸로 오인하지 않게 지도 자신의 근거만 검사. Codex 보완).
// advisory 철학(D3): 막거나 경고 승격하지 않고 게시판에 신선도만 정직 표기. 판단 불가(시각 없음 등)면 null=표기 안 함.
// bridge/contract-lib.js scoutMapStatus의 신호 3종과 정합(2026-07-10 — 게이트·자동지시는 새 커밋 때문에 stale이라는데
// 대시보드만 침묵하던 불일치를 Codex가 잡음): ①seed 변경(삭제=변경) ②메타 head 이후 새 커밋 ③seed 밖 dirty(mtime>지도).
function computeScoutMapStale(ws: string | null, scope: ScopeState | null, maps: ScoutMapsView | null): number | null {
  try {
    if (!ws || !maps?.latest?.ts) return null;
    const t = scoutTargetFor(ws).repo; // P1: seed 경로는 정찰 대상 기준(지도가 대상 레포에서 생성됨)
    // seed 기준은 항상 '지도 메타의 seedFiles'(정본 scoutMapStatus 동형) — 현재 작업트리 seeds로 대체하면
    // seedMissing 기준선이 다른 경로 집합에 적용돼 브릿지=fresh·대시보드=stale로 갈릴 수 있음(Codex 반례).
    // 현재 작업트리 변경은 아래 dirty 단계가 담당. scope 인자는 서명 유지용(미사용).
    void scope;
    const seeds = (maps.latest.seedFiles || []).slice(0, 8);
    const mapAt = Date.parse((maps.latest as { basisTs?: string }).basisTs || maps.latest.ts); // basisTs=꾸러미 수집 시점(정본 동형)
    if (!Number.isFinite(mapAt)) return null;
    let n = 0;
    const seedSet = new Set<string>();
    const missingAtMap = new Set(((maps.latest as { seedMissing?: string[] }).seedMissing) || []);
    const hasBaseline = Array.isArray((maps.latest as { seedMissing?: string[] }).seedMissing);
    for (const s of seeds) {
      try { seedSet.add(normWs(path.join(t, s))); if (fs.statSync(path.join(t, s)).mtimeMs > mapAt) n++; }
      catch { if (hasBaseline && !missingAtMap.has(s)) n++; /* 신형 메타만 '당시 존재 seed 소실'=변경(브릿지 정합 — 구형은 무회귀) */ }
    }
    const sp = (args: string[]) => require("child_process").spawnSync("git", ["-c", "safe.directory=" + String(t).replace(/\\/g, "/"), "-C", t, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true });
    const head = (maps.latest as { head?: string }).head;
    if (typeof head === "string" && /^[0-9a-f]{7,40}$/i.test(head)) {
      try { const r = sp(["rev-list", "--count", head + "..HEAD"]); if (r.status === 0) n += Math.min(parseInt(String(r.stdout).trim(), 10) || 0, 999); } catch { /* 신호 0 */ }
    }
    try {
      const r = sp(["status", "--porcelain", "-z"]);
      if (r.status === 0) {
        const toks = String(r.stdout || "").split("\0");
        let seen = 0;
        for (let i = 0; i < toks.length && seen < 200; i++) {
          const tok = toks[i];
          if (!tok || tok.length < 4) continue;
          seen++;
          const code = tok.slice(0, 2); const rel = tok.slice(3);
          if (/[RC]/.test(code)) i++; // 양쪽 열 다 검사(정본 동형 — worktree rename " R" 반례)
          const abs = path.join(t, rel);
          if (seedSet.has(normWs(abs))) continue;
          if (/D/.test(code)) { n++; continue; }
          try { if (fs.statSync(abs).mtimeMs > mapAt) n++; } catch { n++; }
        }
      }
    } catch { /* 신호 0 */ }
    return n;
  } catch { return null; }
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

// ── Claude Code 설정 모델 읽기 — Claude 설정 폴더(기본 ~/.claude, 공식 env CLAUDE_CONFIG_DIR로 이전 가능) ──
// 모델 어긋남 경고(cc-model)에만 쓴다. 생각강도(effortLevel/env)는 읽지 않는다 — Claude의 '실제' 런타임 생각강도가
// 어디에도 기록되지 않아 '설정 vs 실제' 비교가 불가능하기 때문(예전 '무효값' 검사는 opus의 max를 오탐해 제거).
// settings.json은 '읽기만' 한다 — 두뇌설정 카드를 없앤 뒤로 이 확장은 사용자의 model/effort를 절대 쓰지 않는다(앱 /model·/effort가 담당).
// 환경 적응(이슈#1의 CODEX_HOME 자동탐지와 '동일하게'): Claude 설정/세션 폴더는 공식 env CLAUDE_CONFIG_DIR로 옮길 수 있다.
//   공식 env-vars 문서상 이 값은 'Config directory' 전체(= settings.json + projects)이며 기본값이 ~/.claude다.
//   ★확장 호스트가 CLAUDE_CONFIG_DIR을 못 볼 수 있어(특히 *nix GUI 실행) env에만 의존하지 않는다 — contract-inject 훅이 Claude
//    프로세스에서 받은 실제 transcript_path로 도출해 적어둔 claude-home.txt(codex-home.txt 대칭)를 신뢰 폴백 소스로 쓴다.
//   해석 순서: env CLAUDE_CONFIG_DIR → claude-home.txt(훅 자동탐지) → ~/.claude. env·훅 둘 다 없으면 ~/.claude(무회귀).
//   못 찾으면 settings 읽기가 ""→cc-model 비교 스킵(조용히 off·오탐 0). 옛 위치 stale을 억지로 읽지 않는다(false drift 회피).
// ★매 호출 재해석(런타임 적응): 확장 시작 뒤 contract-inject 훅이 claude-home.txt를 처음 기록해도 다음 render부터 즉시 반영(reload 불필요).
//   BRIDGE_DIR는 이미 watch되어(links.json과 같은 폴더) claude-home.txt가 써지면 render가 돌고, 아래 reads가 claudeHome()을 새로 읽는다.
//   Codex의 syncCodexHome 런타임 갱신과 같은 목적 — 정적 const였으면 활성화 시점 값에 고정되는 갭(Codex 지적)을 피한다.
function claudeHome(): string {
  const pinned = readTextSafe(path.join(BRIDGE_DIR, "claude-home.txt"));
  return process.env.CLAUDE_CONFIG_DIR || (pinned && fs.existsSync(pinned) ? pinned : "") || path.join(HOME, ".claude");
}
function claudeSettingsFile(): string { return path.join(claudeHome(), "settings.json"); }

function readClaudeSettingsModel(): string {
  try {
    const j = JSON.parse(fs.readFileSync(claudeSettingsFile(), "utf8"));
    return j && typeof j === "object" && typeof j.model === "string" ? j.model : "";
  } catch { return ""; }
}

// Claude 모델은 코덱스 models_cache 같은 목록 소스가 없다. 대신 Claude 설정폴더/projects 트랜스크립트의 assistant
// message.model에서 '실제 쓰인 모델'을 읽는다(codex-usage-monitor와 동일 방식 — 하드코딩 없음·업데이트 자동반영).
// 성능: 최근 수정 파일 일부만, 각 파일의 마지막 128KB(tail)만 읽어 마지막 모델을 뽑는다(전체 동기 파싱 회피).
// 트랜스크립트도 CLAUDE_CONFIG_DIR로 이동되므로 claudeHome()에서 파생(이전 환경에서도 '최근 응답 모델'을 찾는다·매 호출 재해석).
function claudeProjectsDir(): string { return path.join(claudeHome(), "projects"); }
// wsFilter 지정 시: cwd가 그 워크스페이스인 entry의 모델만 본다(Claude 대화기록도 entry마다 cwd 기록).
// → cc-model 어긋남이 '다른 프로젝트의 최근 답'과 비교돼 교차-프로젝트 거짓경고 나는 것을 막는다.
// strict: cwd가 없거나 안 맞으면 배제(sessionModelMeta와 동일 규칙) — 거짓경고 0이 목표라, cwd 없는 entry가 타 프로젝트
//   파일에서 새어드는 누수를 막는다(현재 Claude 기록은 응답 entry 전부 cwd 보유 → 무손실). "<synthetic>"(합성 메시지)은 스킵.
// maxAgeMs 지정 시: 마지막 모델 entry의 timestamp가 그보다 오래됐으면 stale로 보고 빈값 반환
//   (옛 답의 모델이 '최근 답'으로 잡혀 거짓 drift 내는 것 방지). timestamp 없는 entry는 검사 불가라 그대로 인정(과잉 억제 회피).
function lastModelInFile(f: string, wsFilter?: string | null, maxAgeMs?: number): string {
  const want = wsFilter ? normWs(wsFilter) : null;
  const now = Date.now();
  try {
    const size = fs.statSync(f).size;
    const len = Math.min(size, 131072); // 마지막 128KB
    const fd = fs.openSync(f, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i]; if (!s || s[0] !== "{") continue;
      let o: any; try { o = JSON.parse(s); } catch { continue; }
      if (want && normWs((o && o.cwd) || "") !== want) continue; // 이 폴더 entry만(cwd 없거나 불일치 배제=strict)
      const m = o && o.message && o.message.model;
      if (typeof m === "string" && m && m !== "<synthetic>") {
        if (maxAgeMs) { const ts = Date.parse((o && o.timestamp) || ""); if (Number.isFinite(ts) && now - ts > maxAgeMs) return ""; } // 마지막 답이 오래됨 → stale
        return m;
      }
    }
  } catch { /* ignore */ }
  return "";
}
// 세션 id(=transcript 파일명)로 그 대화의 .jsonl 경로를 찾는다 — cc-model 1순위('지금 이 대화'의 실제 모델)용. 못 찾으면 undefined.
function findTranscriptBySession(sid: string): string | undefined {
  const target = sid + ".jsonl";
  let found: string | undefined;
  const walk = (d: string, depth: number) => {
    if (found || depth > 4) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (found) break;
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name === target) found = full;
    }
  };
  try { walk(claudeProjectsDir(), 0); } catch { /* ignore */ }
  return found;
}
// 이 ws의 '현재(또는 가장 최근) 대화' transcript 파일을 찾는다 — cc-model drift의 intent/actual을 '같은 대화'에서 읽기 위한 단일 소스.
// 1순위: 세션별 active(BRIDGE_DIR/active/<sid>.json — 여러 창 동시 사용 대비) + 레거시 active.json 중
//   workspace==ws && 신선(DRIFT_FRESH_MS)한 것들에서 '가장 최근' 세션 → 그 transcript. (기존 전역 active.json 단독 1순위는
//   다른 창이 마지막에 덮어쓰면 이 ws의 현재 대화를 놓쳤다 — 세션별 파일 스캔으로 보강, Codex 보완 수용.)
// 2순위(폴백): 이 ws(cwd)의 최근 답이 있는(신선) 최근 수정 transcript.
function currentTranscriptForWs(ws: string): string | null {
  const want = normWs(ws);
  let bestSid = "", bestTs = 0;
  const consider = (a: any) => {
    if (!a || typeof a.claudeSession !== "string" || !a.claudeSession) return;
    if (normWs(String(a.workspace || "")) !== want) return;
    const ts = Date.parse(a.ts || "");
    if (!Number.isFinite(ts) || Date.now() - ts >= DRIFT_FRESH_MS) return; // stale active로 옛 대화를 읽지 않게
    if (ts > bestTs) { bestTs = ts; bestSid = a.claudeSession; }
  };
  try { consider(JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "active.json"), "utf8"))); } catch { /* 없음/파싱 실패 */ }
  try {
    for (const n of fs.readdirSync(path.join(BRIDGE_DIR, "active"))) {
      if (!n.endsWith(".json")) continue;
      try { consider(JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "active", n), "utf8"))); } catch { /* 개별 파일 무시 */ }
    }
  } catch { /* active/ 폴더 없음 */ }
  if (bestSid) {
    const cur = findTranscriptBySession(bestSid);
    if (cur) return cur;
  }
  // 폴백: 이 ws의 최근 transcript(마지막 답이 신선한 것만 — lastModelInFile의 cwd strict+신선도 재사용)
  const files: { f: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.endsWith(".jsonl") && !it.name.startsWith("agent-")) {
        try { files.push({ f: full, m: fs.statSync(full).mtimeMs }); } catch { /* ignore */ }
      }
    }
  };
  try { walk(claudeProjectsDir(), 0); } catch { /* ignore */ }
  files.sort((a, b) => b.m - a.m);
  for (const fl of files.slice(0, 40)) { // bounded: 최근 40개(이 프로젝트 파일이 창 밖으로 밀릴 여지 줄임)
    if (lastModelInFile(fl.f, ws, DRIFT_FRESH_MS)) return fl.f;
  }
  return null;
}
// ── cc-drift용 transcript 증분 스캐너 — 이 대화의 '마지막 /model 확정 기록'과 '마지막 실제 답 모델'을 함께 추적 ──
// 왜 증분인가(실측): 활성 세션 transcript는 100MB+로 자라고 대형 도구 출력이 꼬리를 채워, 고정 꼬리창(4MB·128KB)으로는
// 몇 시간 전 /model이나 직전 답 모델도 창 밖으로 밀린다(과소경고 과다). transcript는 append-only이므로:
// 첫 스캔은 꼬리 INITIAL_BACKFILL만 백필하고, 이후엔 '자란 부분만' 읽어 이전 지식과 병합(새 조각에서 찾으면 갱신, 없으면 유지).
// 한계(정직): 첫 스캔 시점에 이미 백필 창 밖이던 /model은 못 본다 → settings 폴백은 '대화 시작 전 설정'만 인정하므로
// 거짓경고 없이 과소경고로 수렴. 파일 교체/축소(resume 새 파일 등)는 size 감소로 감지해 전체 재백필.
const CC_SCAN_BACKFILL = 16 * 1024 * 1024; // 첫 스캔 백필 꼬리(1회성)
let ccScanCache: { file: string; size: number; cmd: { model: string; ts: number } | null; actual: { model: string; ts: number } | null } | null = null;
function readRange(file: string, from: number, to: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.max(0, to - from);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}
// ── 포커스 귀속 상태·기록(cc-intent.json) — 'UI 피커/터미널로 이 창에서 고른 모델'을 프로젝트 단위로 영속 ──
// 각 창의 확장은 자기 포커스 구간만 알면 된다: 설정 변경 시각이 내 포커스 구간 안이면 내 프로젝트의 선택(양쪽 창이
// 같은 변경 이벤트를 받아도 포커스였던 창만 기록 → 자연 배타). 판정 자체는 brain-intent.shouldAttributeSettingsChange(순수).
const CC_INTENT_FILE = path.join(BRIDGE_DIR, "cc-intent.json");
let focusStartMs: number | null = null; // 이 창이 포커스를 얻은 시각(비포커스로 시작했으면 null)
let focusEndMs: number | null = null;   // 포커스를 잃은 시각(null=지금 포커스 중이거나 이력 없음)
let lastSeenSettingsModel = "";         // 직전 관찰한 설정 모델(활성화 시 초기화 — 초기값 자체는 귀속하지 않음)
function readCcIntentFor(ws: string): { model: string; ts: number } | null {
  try {
    const j = JSON.parse(fs.readFileSync(CC_INTENT_FILE, "utf8"));
    const v = j && j.byWorkspace && j.byWorkspace[normWs(ws)];
    if (!(v && typeof v.model === "string" && v.model && typeof v.ts === "number")) return null;
    // TTL을 읽기에서도 적용(쓰기 때만 prune하면 이후 write가 없는 프로젝트의 낡은 귀속이 영구히 의도로 남아
    // 장기 거짓경고가 됨 — Codex 지적). 판정은 pruneIntentMap과 동일 기준(단일 정본) — 만료면 없는 것으로.
    const kept = pruneIntentMap({ v: { model: v.model, ts: v.ts } }, Date.now());
    return kept.v ? { model: kept.v.model, ts: kept.v.ts } : null;
  } catch { return null; }
}
function writeCcIntentFor(ws: string, model: string): void {
  let map: Record<string, { model: string; ts: number }> = {};
  try { const j = JSON.parse(fs.readFileSync(CC_INTENT_FILE, "utf8")); if (j && j.byWorkspace) map = j.byWorkspace; } catch { /* 첫 기록 */ }
  map[normWs(ws)] = { model, ts: Date.now() };
  atomicWrite(CC_INTENT_FILE, JSON.stringify({ byWorkspace: pruneIntentMap(map, Date.now()) })); // 30일 지난 프로젝트 귀속 정리
}
// settings.json 변경 이벤트에서 호출 — 모델이 실제로 바뀌었고 변경 시각이 내 포커스 구간 안이면 이 프로젝트의 선택으로 기록.
function maybeAttributeSettingsChange(): void {
  const cur = readClaudeSettingsModel();
  const prev = lastSeenSettingsModel;
  lastSeenSettingsModel = cur; // 귀속 여부와 무관하게 관찰값은 갱신(중복 이벤트 재귀속 방지)
  if (!cur || cur === prev) return;
  let mtime = Date.now();
  try { mtime = fs.statSync(claudeSettingsFile()).mtimeMs; } catch { /* 이벤트 시각으로 대체 */ }
  const ws = dashboardWorkspace();
  if (!ws) return; // 폴더 없는 빈 창 — 귀속할 프로젝트가 없음
  if (shouldAttributeSettingsChange(mtime, focusStartMs, focusEndMs, Date.now(), prev, cur)) {
    writeCcIntentFor(ws, cur);
    lastDriftSync = 0; // drift 1.5s throttle 해제 — 다음 render(디바운스 ~0.8s)에서 즉시 재계산 = '전환 몇 초 내 경고' 보장(Codex 지적 수용)
  }
}

function scanCcTranscript(f: string, ws: string): { cmd: { model: string; ts: number } | null; actual: { model: string; ts: number } | null } {
  try {
    const st = fs.statSync(f);
    let base = ccScanCache && ccScanCache.file === f && st.size >= ccScanCache.size ? ccScanCache : null;
    if (base && st.size === base.size) return { cmd: base.cmd, actual: base.actual }; // 무변화 — 재스캔 없음
    // ★갭 상한(Codex 보완 수용): 오래 잠든 창이 깨어나 델타가 백필 창보다 크면, 건너뛴 구간에 더 새로운 /model·답이
    // 있을 수 있어 '이전 지식'을 최신으로 오인하면 거짓경고가 된다 → 지식을 버리고 꼬리 백필로 재시작(+큰 Buffer 방지 겸용).
    if (base && st.size - base.size > CC_SCAN_BACKFILL) base = null;
    const from = base ? base.size : Math.max(0, st.size - CC_SCAN_BACKFILL);
    const chunk = readRange(f, from, st.size); // 경계에 걸린 첫 줄은 JSON.parse 실패로 자연 skip(파서가 처리)
    const cmd = parseLastModelCommand(chunk, ws, normWs) || (base ? base.cmd : null);       // 새 조각 우선, 없으면 이전 지식(갭 없음 보장 하에서만 유효)
    const actual = parseLastAssistantModel(chunk, ws, normWs) || (base ? base.actual : null);
    ccScanCache = { file: f, size: st.size, cmd, actual };
    return { cmd, actual };
  } catch { return { cmd: null, actual: null }; }
}

// ── 범위 장부(L0) 상태 — scoutMode=on(3트랙)일 때만, 이 프로젝트 git 이력에서 '함께 변경' 후보를 채굴(SCOPE-LEDGER.md S1 advisory) ──
// 전부 로컬 git 조회(외부 전송 0). seed=지금 작업트리의 변경 파일(git status). 비-git 폴더·git 실패는 정직하게 사유 표시.
// 캐시: ws+HEAD+변경목록이 같으면 재채굴 안 함(렌더마다 git log 300커밋을 다시 읽지 않게).
type ScopeState = { seeds: string[]; suggestion: ScopeSuggestion | null; note: "" | "no-git" | "no-changes" | "error"; checkedAt: string; logCount: number }; // checkedAt/logCount: '지금 뭘 확인했나' 상태 요약용(침묵을 상태로 번역 — 사용자 지적)
let scopeCache: { key: string; val: ScopeState } | null = null;
let lastScopeCheck = 0; // 시간 스로틀 — 렌더 경로에서 동기 git(rev-parse/status)조차 5s에 1회만(Codex 보완: 큰 repo·느린 git 호스트 블로킹 방지)
function runGit(ws: string, args: string[]): { ok: boolean; out: string } {
  try {
    // safe.directory: 소유자 불일치 환경(공유 폴더·다른 계정 소유 저장소)에서 git의 dubious ownership 거부로
    // 범위 장부가 통째로 'no-git' 오판되는 것 방지 — 이 저장소에 한해 신뢰 지시(전역 설정 무접촉).
    const r = require("child_process").spawnSync("git", ["-c", "safe.directory=" + String(ws).replace(/\\/g, "/"), "-C", ws, ...args], { encoding: "utf8", timeout: 15000, windowsHide: true });
    return { ok: r.status === 0 && !r.error, out: String(r.stdout || "") };
  } catch { return { ok: false, out: "" }; }
}
function readScopeState(ws: string | null): ScopeState | null {
  if (!ws) return null;
  try {
    if (loadContract(ws).scoutMode !== "on") return null; // 2트랙(기본) — 계산 자체를 안 함(무회귀·비용 0)
    const t = scoutTargetFor(ws).repo; // P1: 변경 감지·통계는 정찰 대상 기준(세션 폴더가 비-git 부모여도 레포를 봄)
    const now = Date.now();
    // 5s 스로틀 — 단 캐시가 '같은 프로젝트(대상)' 것일 때만 재사용(다른 프로젝트의 후보를 보여주는 오도 차단 — Codex 실패 지적).
    // 시간 내 대상이 다르면 스로틀을 무시하고 새로 계산한다(프로젝트별 분리가 지연보다 우선).
    const sameWs = !!(scopeCache && scopeCache.key.startsWith(normWs(t) + "|"));
    if (now - lastScopeCheck < 5000 && sameWs) return scopeCache!.val;
    lastScopeCheck = now;
    const checkedAt = new Date(now).toISOString(); // 이번 채굴 시각 — 캐시 반환 시엔 원래 값 유지(='최근 채굴')
    const head = runGit(t, ["rev-parse", "HEAD"]);
    if (!head.ok) { return { seeds: [], suggestion: null, note: "no-git", checkedAt, logCount: 0 }; }
    // -z: NUL 구분 — 공백·한글·따옴표 경로가 C-quote로 감싸져 깨지는 것 방지. rename/copy는 "XY new\0old\0" — old 토큰은 소비만.
    const st = runGit(t, ["status", "--porcelain", "-z"]);
    if (!st.ok) return { seeds: [], suggestion: null, note: "error", checkedAt, logCount: 0 }; // 실패를 '변경 없음'으로 오도하지 않음(Codex 지적)
    const toks = st.out.split("\0").filter(Boolean);
    const seeds: string[] = [];
    for (let i = 0; i < toks.length && seeds.length < 8; i++) { // seed 상한 — 대량 변경 시 상위 일부만(후보 폭발 방지)
      const t = toks[i];
      const status = t.slice(0, 2);
      const p = t.slice(3);
      if (/[RC]/.test(status)) i++; // R/C가 어느 자리(index/worktree)에 있든 다음 토큰=옛 경로 — 소비만(Codex 지적: status[0]만 보면 불완전)
      if (p && !/\/$/.test(p)) seeds.push(p);
    }
    const key = `${normWs(t)}|${head.out.trim()}|${seeds.join(",")}`;
    if (scopeCache && scopeCache.key === key) return scopeCache.val;
    let val: ScopeState;
    if (!seeds.length) {
      val = { seeds: [], suggestion: null, note: "no-changes", checkedAt, logCount: 0 }; // 변경 없음 — seed가 없으니 지도도 없음(정직)
    } else {
      const log = runGit(t, ["log", "--no-merges", "--first-parent", "--pretty=format:%H|%ct|%s", "--name-only", "-n", "300"]);
      if (log.ok) {
        const commits = parseGitLog(log.out);
        val = { seeds, suggestion: scopeSuggest(commits, seeds), note: "", checkedAt, logCount: commits.length };
      } else {
        val = { seeds, suggestion: null, note: "error", checkedAt, logCount: 0 };
      }
    }
    scopeCache = { key, val };
    return val;
  } catch { return { seeds: [], suggestion: null, note: "error", checkedAt: new Date().toISOString(), logCount: 0 }; }
}

// ── 영향지도 게시판(3트랙) — 러너(scope-scout-self/-deepseek)가 브릿지 홈 scouts/<wsKey>/에 보관한 지도를 읽는다 ──
// wsKey = sha1(normWs) 앞 16자(계약 키·scripts/scout-store.js와 동일 규칙 — 한쪽만 바꾸면 게시판이 빈다).
// 읽기 전용 표시일 뿐 — 확장은 지도를 생성·전송하지 않는다(생성은 사용자의 수동 스크립트 실행. PRIVACY와 일치).
type ScoutMapItem = { ts: string | null; arm: string; model: string | null; usageIn: number | null; usageOut: number | null };
type ScoutMapsView = { count: number; items: ScoutMapItem[]; latest: { arm: string; ts: string | null; text: string; truncated: boolean; seedFiles: string[]; head?: string; seedMissing?: string[]; basisTs?: string } | null };
const SCOUT_MAP_TEXT_CAP = 12000; // 웹뷰로 보내는 최신 지도 본문 상한(게시판은 열람용 — 전문은 scouts/ 파일)
let scoutMapsCache: { key: string; at: number; val: ScoutMapsView | null } | null = null;
function readScoutMaps(ws: string | null): ScoutMapsView | null {
  if (!ws) return null;
  try {
    if (loadContract(ws).scoutMode !== "on") return null; // 2트랙 — 게시판 자체를 안 보임(무회귀)
    const t = scoutTargetFor(ws).repo; // P1: 게시판도 정찰 대상 서랍을 읽음
    const now = Date.now();
    if (scoutMapsCache && scoutMapsCache.key === normWs(t) && now - scoutMapsCache.at < 5000) return scoutMapsCache.val;
    const dir = path.join(BRIDGE_DIR, "scouts", crypto.createHash("sha1").update(normWs(t)).digest("hex").slice(0, 16));
    let bases: string[] = [];
    try { bases = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().reverse(); } catch { /* 지도 없음 */ }
    const items: ScoutMapItem[] = bases.slice(0, 5).map((b) => {
      let m: any = {};
      try { m = JSON.parse(fs.readFileSync(path.join(dir, b + ".json"), "utf8")); } catch { /* 메타 없음 — 지도는 그대로 노출 */ }
      return { ts: typeof m.ts === "string" ? m.ts : null, arm: typeof m.arm === "string" ? m.arm : (b.split("-").pop() || "?"), model: typeof m.model === "string" ? m.model : null, usageIn: Number.isFinite(m.usageIn) ? m.usageIn : null, usageOut: Number.isFinite(m.usageOut) ? m.usageOut : null };
    });
    let latest: ScoutMapsView["latest"] = null;
    if (bases.length) {
      try {
        const raw = fs.readFileSync(path.join(dir, bases[0] + ".md"), "utf8");
        let seedFiles: string[] = [];
        let head = "";
        let seedMissing: string[] | undefined;
        let basisTs = "";
        try {
          const m0 = JSON.parse(fs.readFileSync(path.join(dir, bases[0] + ".json"), "utf8"));
          if (Array.isArray(m0.seedFiles)) seedFiles = m0.seedFiles.filter((s: any) => typeof s === "string");
          if (typeof m0.head === "string") head = m0.head; // 신선도 '새 커밋' 신호 재료(브릿지 정합 2026-07-10)
          if (Array.isArray(m0.seedMissing)) seedMissing = m0.seedMissing.filter((x: any) => typeof x === "string");
          if (typeof m0.basisTs === "string") basisTs = m0.basisTs;
        } catch { /* 메타 없음 — 낡음 배지만 비활성 */ }
        latest = { arm: items[0]?.arm || "?", ts: items[0]?.ts || null, text: raw.slice(0, SCOUT_MAP_TEXT_CAP), truncated: raw.length > SCOUT_MAP_TEXT_CAP, seedFiles, head, seedMissing, basisTs };
      } catch { /* 방금 지워졌을 수 있음 — 목록만 */ }
    }
    const val: ScoutMapsView = { count: bases.length, items, latest };
    scoutMapsCache = { key: normWs(t), at: now, val };
    return val;
  } catch { return null; }
}

// ── MAP 장부 판독(⑤ 역할 전환) — 관측 장부(이벤트→유도)가 1차 재료: 무엇이 쌓였고(제안)·반영됐고(동봉/확인)·
// 정정됐는지(반박/차단)를 타임라인+신분으로 보여준다. 사람 개입(고정/차단/내보내기)은 선택 — 승인 큐 아님.
// 유도·형식은 out(ledger-events·map-ledger) 공유 모듈 — 여기는 파일 읽기+조립만.
type ObservedEntry = {
  sig: string; text: string; status: string; pinned: boolean; lane: string; from: string; lastTs: string;
  rehabilitated?: boolean; // 반박 이후 재확인으로 복권됨 — verified와 구분 표기(왜 반박 수가 있는데 검증됨인지 즉답)
  n: { proposed: number; attached: number; confirmed: number; disputed: number }; // 사건 요약(무엇을 근거로 이 신분인가)
  inMap: boolean; // 확정 장부(MAP.md)에 이미 내보내졌나(중복 내보내기 방지)
};
type LedgerTimelineItem = { ts: string; type: string; text: string; from: string };
type MapLedgerView = {
  entries: ObservedEntry[];        // 최신순 상위 N — 신분 배지·개입 버튼 재료
  timeline: LedgerTimelineItem[];  // 최근 사건 흐름(최신 먼저)
  counts: { trusted: number; reference: number; disputed: number; excluded: number };
  impact: { proposed: number; attached: number; confirmed: number; disputedEv: number; rehabilitated: number; verifiedEntries: number }; // 3트랙 기여 관찰 신호(이벤트 합계 — 검증 통계 탭 카드 재료)
  health: import("./ledger-events").ScoutHealth; // 프로젝트별 관찰 신호(entry 단위 — 전역 임계값 대체·advisory 전용, 사용자 결정 2026-07-09)
  prevDrawer: { entries: number; trusted: number; migrateCmd: string } | null; // 정찰 대상 전환 시 '이 폴더 자체 서랍'의 잔존 요약 — 침묵 전환이 '데이터 삭제'로 보이던 실사고(2026-07-10) 고지 재료. 전환 없으면 null
  dropped: number;                 // 깨진/미지 이벤트 줄 수(침묵 삼킴 금지 — 정직 표기)
  mapRel: string; mapExists: boolean; mapApproved: number; mapTotalItems: number;
  mapText: string; mapTruncated: boolean;
};
const MAP_LEDGER_TEXT_CAP = 8000;
const LEDGER_ENTRIES_CAP_UI = 12;  // 카드에 보이는 항목 상한(전체는 이벤트 파일이 원본)
const LEDGER_TIMELINE_CAP_UI = 20; // 타임라인 상한
let mapLedgerBump = 0; // 개입(고정/차단/내보내기) 직후 캐시 즉시 무효화(키에 포함 — TTL만으론 버튼 반응이 최대 5초 늦음)
function ledgerEventsFileExt(ws: string): string { // contract-lib ledgerEventsFileFor와 동일 규칙(wsKey 3카피 규약). P1: 대상 기준
  return path.join(BRIDGE_DIR, "map-ledger-events", crypto.createHash("sha1").update(normWs(scoutTargetFor(ws).repo)).digest("hex").slice(0, 16) + ".jsonl");
}
function mapLedgerFile(ws: string): string { // CLI mapFile()과 동일 순서. P1: 확정층(MAP.md)은 정찰 대상 레포의 파일
  const t = scoutTargetFor(ws).repo;
  for (const c of ["docs/MAP.md", "MAP.md"]) { if (fs.existsSync(path.join(t, c))) return path.join(t, c); }
  return path.join(t, "docs", "MAP.md");
}
function readMapLedgerUncached(ws: string): MapLedgerView {
  let raw = "";
  try { raw = fs.readFileSync(ledgerEventsFileExt(ws), "utf8"); } catch { /* 장부 아직 없음 */ }
  const parsed = parseEventsJsonl(raw);
  const derived = deriveLedger(parsed.events);
  const mapF = mapLedgerFile(ws);
  let mapMd = ""; let mapExists = false;
  try { mapMd = fs.readFileSync(mapF, "utf8"); mapExists = true; } catch { /* 확정층 아직 없음 */ }
  const mapNow = normSig(mapMd);
  const entries: ObservedEntry[] = derived.slice(0, LEDGER_ENTRIES_CAP_UI).map((e) => ({
    sig: e.sig, text: e.text || e.sig, status: e.status, pinned: e.pinned, lane: e.lane, from: e.from, lastTs: e.lastTs,
    rehabilitated: !!(e as { rehabilitated?: boolean }).rehabilitated,
    n: {
      proposed: e.counts.proposed || 0, attached: e.counts.attached || 0,
      confirmed: (e.counts.confirmed || 0) + (e.counts.user_confirm || 0),
      disputed: (e.counts.refuted || 0) + (e.counts.user_dispute || 0),
    },
    inMap: !!(mapNow && mapNow.includes(e.sig)),
  }));
  const textOf = new Map(derived.map((e) => [e.sig, e.text || e.sig]));
  const timeline: LedgerTimelineItem[] = parsed.events.slice(-LEDGER_TIMELINE_CAP_UI).reverse()
    .map((ev) => ({ ts: ev.ts || "", type: ev.type, text: (textOf.get(ev.sig) || ev.text || ev.sig).slice(0, 90), from: (ev.from || "").slice(0, 80) }));
  const counts = { trusted: 0, reference: 0, disputed: 0, excluded: 0 };
  const impact = { proposed: 0, attached: 0, confirmed: 0, disputedEv: 0, rehabilitated: 0, verifiedEntries: 0 };
  for (const e of derived) {
    impact.proposed += e.counts.proposed || 0;
    impact.attached += e.counts.attached || 0;
    impact.confirmed += (e.counts.confirmed || 0) + (e.counts.user_confirm || 0);
    impact.disputedEv += (e.counts.refuted || 0) + (e.counts.user_dispute || 0);
    if ((e as { rehabilitated?: boolean }).rehabilitated) impact.rehabilitated++;
    if (e.status === "verified") impact.verifiedEntries++;
    if (e.lane === "trusted") counts.trusted++;
    else if (e.lane === "reference") counts.reference++;
    if (e.status === "disputed") counts.disputed++;
    if (e.status === "banned" || e.status === "superseded" || e.status === "tombstone") counts.excluded++;
  }
  const mp = parseApprovedFromMap(mapMd);
  // 서랍 전환 고지 재료(2026-07-10 실사고: scoutRepo 설정 순간 카드가 대상 서랍으로 바뀌며 '신뢰 2→0' —
  // 사용자는 삭제로 오인. 실제로는 이 폴더 자체 서랍에 그대로 보존): 대상≠ws일 때만 이전 서랍을 요약.
  let prevDrawer: { entries: number; trusted: number; migrateCmd: string } | null = null;
  try {
    if (normWs(scoutTargetFor(ws).repo) !== normWs(ws)) {
      const pf = path.join(BRIDGE_DIR, "map-ledger-events", crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16) + ".jsonl");
      let praw = ""; try { praw = fs.readFileSync(pf, "utf8"); } catch { /* 이전 서랍 없음 */ }
      if (praw.trim()) {
        const pd = deriveLedger(parseEventsJsonl(praw).events);
        if (pd.length) prevDrawer = { entries: pd.length, trusted: pd.filter((e) => e.lane === "trusted").length, migrateCmd: `node scripts/scope-ledger-migrate.js "${ws}" "${scoutTargetFor(ws).repo}" --dry` }; // 실행 가능한 전체 인수(Codex 지적: 인수 없는 안내는 usage 오류로 끝남)
      }
    }
  } catch { /* 고지 재료 실패 — 카드 본체 불침 */ }
  return {
    entries, timeline, counts, impact, health: computeScoutHealth(derived), dropped: parsed.dropped, prevDrawer,
    mapRel: path.relative(ws, mapF).replace(/\\/g, "/"), mapExists,
    mapApproved: mp.approved.length, mapTotalItems: mp.totalItems,
    mapText: mapMd.slice(0, MAP_LEDGER_TEXT_CAP), mapTruncated: mapMd.length > MAP_LEDGER_TEXT_CAP,
  };
}
function readMapLedger(ws: string | null): MapLedgerView | null {
  if (!ws) return null;
  try {
    if (loadContract(ws).scoutMode !== "on") return null; // 2트랙 — 카드 자체를 안 보임(무회귀)
    return cachedRead("mled|" + normWs(ws) + "|" + normWs(scoutTargetFor(ws).repo) + "|" + mapLedgerBump, 5000, () => readMapLedgerUncached(ws)); // 키에 실효 대상 포함 — 언어 슬롯 전환으로 대상이 바뀌면 즉시 새 서랍(Codex 반례)
  } catch { return null; }
}

// ── '지도 생성중' 라이브 신호 판독 — 러너가 탐색자 호출 동안만 scout-live/<wsKey>.json을 남긴다(scripts/scout-store.js).
// TTL 10분: 러너 자체 타임아웃(self 8분)에서 유도한 상한+여유 — 비정상 종료로 파일이 잔존해도 영구 '생성중' 거짓 방지.
const SCOUT_LIVE_TTL_MS = 10 * 60 * 1000;
function readScoutLive(ws: string | null): { arm: string; startedAt: string } | null {
  if (!ws) return null;
  try {
    const f = path.join(BRIDGE_DIR, "scout-live", crypto.createHash("sha1").update(normWs(scoutTargetFor(ws).repo)).digest("hex").slice(0, 16) + ".json"); // P1: 러너가 대상 경로로 신호를 남김
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const at = Date.parse(j.startedAt || "") || 0;
    if (!at || Date.now() - at > SCOUT_LIVE_TTL_MS) return null;
    return { arm: typeof j.arm === "string" ? j.arm : "?", startedAt: j.startedAt };
  } catch { return null; }
}

// ── DeepSeek 설정(고급 탐색 키) — 런타임 홈 deepseek.json. 웹뷰에는 마스킹만, 원문은 절대 안 보냄 ──
const DEEPSEEK_FILE = path.join(BRIDGE_DIR, "deepseek.json");
function readDeepseekRaw(): any { try { return JSON.parse(fs.readFileSync(DEEPSEEK_FILE, "utf8")); } catch { return {}; } }
function readDeepseekView(): { hasKey: boolean; masked: string; model: string } {
  const j = readDeepseekRaw();
  const key = typeof j.apiKey === "string" ? j.apiKey : "";
  return { hasKey: !!key.trim(), masked: maskKey(key), model: typeof j.model === "string" && j.model ? j.model : "deepseek-v4-flash" };
}

// 이 폴더(ws)의 클로드 대화기록에서 최근 28일 토큰을 합한다 — 코덱스 토큰(검증 비용)과 분리한 '작업 비용'. cwd 필터(다른 폴더 제외)·사이드체인 제외는 sumClaudeUsage가 담당. !ws면 빈(프로젝트별 원칙).
// 60s TTL: 28일 통계라 초 단위 신선도가 무의미한데, 대화기록이 커지면 이 집계 혼자 1s+를 먹어(실측 34%)
// 워처 폭주 시 호스트 포화의 주범이 된다. TTL 안에서는 마지막 값 재사용.
function readClaudeTokens(ws: string | null, now = Date.now()): ClaudeTokens {
  return cachedRead("cctok|" + (ws ? normWs(ws) : ""), 60 * 1000, () => readClaudeTokensUncached(ws, now));
}
function readClaudeTokensUncached(ws: string | null, now = Date.now()): ClaudeTokens {
  const acc: ClaudeTokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, turns: 0 };
  if (!ws) return acc;
  const files: { f: string; m: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.endsWith(".jsonl") && !it.name.startsWith("agent-")) {
        try { files.push({ f: full, m: fs.statSync(full).mtimeMs }); } catch { /* ignore */ }
      }
    }
  };
  try { walk(claudeProjectsDir(), 0); } catch { /* ignore */ }
  const cutoff = now - 28 * 24 * 60 * 60 * 1000;
  const seenReq = new Set<string>(); // 파일 간 공유 — resume/fork로 복사된 줄의 requestId/턴 uuid 중복 합산 방지
  for (const fl of files.sort((a, b) => b.m - a.m).slice(0, 120)) { // 최근 수정 120개로 bounded(다른 프로젝트가 최근목록을 채워 이 폴더 transcript가 밀릴 여지 줄임)
    if (fl.m < cutoff) continue; // 28일 안에 수정된 transcript만(오래된 파일 스캔 회피)
    let raw: string; try { raw = fs.readFileSync(fl.f, "utf8"); } catch { continue; }
    const t = sumClaudeUsage(raw.split(/\n/), now, ws, normWs, seenReq);
    acc.input += t.input; acc.output += t.output; acc.cacheRead += t.cacheRead; acc.cacheCreate += t.cacheCreate; acc.total += t.total; acc.turns += t.turns;
  }
  return acc;
}

// 프로젝트별 비교(3c) — ws 필터 없이 모든 폴더의 28일 검증 분포. '이 폴더 통계'와 별개 섹션. 연 폴더 규칙과 무관(전체 group-by가 목적).
function readProjectStats(now = Date.now()): Record<string, ProjectStat> {
  let raw = "";
  try { raw = fs.readFileSync(VERDICTS_FILE, "utf8"); } catch { /* 아직 검증 기록 없음 */ }
  return computeProjectStats(raw, now, normWs);
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

  // 창 리로드로 복원된 웹뷰 탭 되살리기(activate의 serializer가 호출). 되살림이 없으면 복원 탭은 스크립트/데이터가
  // 없는 영구 빈 화면으로 남는다(사용자 실측 2026-07-06 — "리로드 후 아무 반응 없음"). 이미 산 패널이 있으면 복원 탭은 닫음.

  show(col?: vscode.ViewColumn): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("codexBridge", "Codex Bridge", col ?? vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.uri],
      });
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "ready") { this.post(); return; } // 웹뷰 부팅 핸드셰이크 — 초기 push 유실 방지(양 감사 합의)
        if (m?.type === "setLang" && (m.lang === "ko" || m.lang === "en")) {
          // 전역 언어 저장(language.json) — 브릿지·훅·다른 창이 같은 파일을 읽는다(BRIDGE_DIR watch로 자동 재렌더).
          if (!saveLangExt(m.lang)) { vscode.window.showErrorMessage(tE("언어 설정 저장에 실패했어요(파일 잠김/권한?).","Failed to save language setting (file locked/permission?).")); return; }
          this.post();
          vscode.commands.executeCommand("codexBridge.refresh");
        }
        if (m?.type === "relink" && m.id) {
          if (!relink(String(m.id))) { vscode.window.showErrorMessage(tE("연결 저장에 실패했어요(파일 잠김/권한?). 잠시 후 다시 시도하세요.","Failed to save the link (file locked/permission?). Try again shortly.")); return; }
          this.post();
          vscode.commands.executeCommand("codexBridge.refresh");
        }
        if (m?.type === "openReconGuide") openReconGuide(); // 정찰 구조 안내 — 대시보드와 별개의 정적 새탭(스크립트 없음)
        if (m?.type === "openScoutHealthReport") openScoutHealthReport(dashboardWorkspace()); // 건강 리포트 — 포화 대응 새탭(열 때 베이크·스크립트 없음)
        if (m?.type === "setScoutTarget" && typeof m.repo === "string") setScoutTargetFromUi(dashboardWorkspace(), m.repo, m.lang === "ko" || m.lang === "en" ? m.lang : undefined).then(() => this.post());
        if (m?.type === "hideSession" && m.id) {
          const id = String(m.id);
          const ws = dashboardWorkspace();
          const linked = !!ws && workspaceLink(loadLinks(), ws)?.codexSession === id;
          const warn = linked ? tE("이 세션은 지금 이 프로젝트에 연결돼 있습니다. 숨기면 이 프로젝트의 연결만 해제됩니다(다른 프로젝트 연결은 유지).\n\n","This session is linked to this project. Hiding it only unlinks it here (links in other projects are kept).\n\n") : "";
          vscode.window
            .showWarningMessage(warn + tE(`이 Codex 세션을 목록에서 숨길까요?\n`,`Hide this Codex session from the list?\n`) + `(${id.slice(0, 8)}…` + tE(` · 원본 파일은 지우지 않으며 '숨긴 세션 보기'에서 복원 가능)`,` · file is kept; restorable under hidden sessions)`), { modal: true }, tE("숨기기","Hide"))
            .then((pick) => {
              if (pick !== tE("숨기기","Hide")) return;
              if (linked && ws && !unlinkSession(id, ws)) { vscode.window.showErrorMessage(tE("연결 해제 저장에 실패했어요(파일 잠김/권한?). 숨김을 보류합니다.","Failed to save the unlink (file locked/permission?). Hide postponed.")); return; }
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
            ? tE(`이 세션은 ${others.length}개 프로젝트에서 연결해 쓰고 있어요. 삭제하면 그 프로젝트들에서도 사라집니다.\n\n`,`This session is linked in ${others.length} projects. Deleting removes it from those too.\n\n`)
            : others.length === 1
              ? tE("이 세션은 한 프로젝트에 연결돼 있어요. 삭제하면 그 연결도 해제됩니다.\n\n","This session is linked in one project. Deleting also unlinks it.\n\n")
              : "";
          vscode.window
            .showWarningMessage(warn + tE(`이 Codex 세션을 영구 삭제할까요?\n`,`Permanently delete this Codex session?\n`) + `(${id.slice(0, 8)}…` + tE(` · 대화 원본 파일이 지워지며 되돌릴 수 없습니다)`,` · the conversation file is removed; this cannot be undone)`), { modal: true }, tE("영구 삭제","Delete permanently"))
            .then((pick) => {
              if (pick !== tE("영구 삭제","Delete permanently")) return;
              if (!purgeRollout(id)) { // 삭제 실패(잠김/권한) → 메타 그대로 두고 알림(거짓 삭제 방지)
                vscode.window.showErrorMessage(tE("세션 파일을 삭제하지 못했어요(파일 잠김/권한?). 목록은 그대로 둡니다.","Could not delete the session file (locked/permission?). The list is unchanged."));
                return;
              }
              // 파일이 전역 삭제됐으니 모든 워크스페이스 링크 제거(dangling 방지). 파일은 이미 사라졌으므로
              // 링크 정리 저장이 실패해도 되돌릴 수 없다 → 경고만 하고 진행(남은 링크는 resume 시 곱게 실패).
              if (!unlinkSessionEverywhere(id)) vscode.window.showWarningMessage(tE("세션은 삭제됐지만 연결 기록 정리에 실패했어요(파일 잠김/권한?). 남은 연결은 다음에 정리됩니다.","Session deleted, but link records could not be cleaned (locked/permission?). Remaining links will be cleaned later."));
              setSessionHidden(id, false); // 사라진 세션의 숨김 메타 정리
              this.post();
              vscode.commands.executeCommand("codexBridge.refresh");
            });
        }
        if (m?.type === "saveModelPref") {
          const ok = setModelPref(dashboardWorkspace() || "", String(m.model || ""), String(m.reasoning || ""));
          if (!ok) vscode.window.showErrorMessage(tE("두뇌 설정 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 저장해 주세요.","Failed to save brain settings — file locked or inaccessible. Try again shortly."));
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "model", ok });
        }
        if (m?.type === "saveVerifyTimeout") {
          const ok = setVerifyTimeout(Number(m.min));
          if (!ok) vscode.window.showErrorMessage(tE("검증 대기시간 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 시도해 주세요.","Failed to save verify timeout — file locked or inaccessible. Try again shortly."));
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "timeout", ok });
        }
        if (m?.type === "saveContract") {
          // lang = 웹뷰가 '화면에 렌더했던 언어'(보던 슬롯) — 저장 도중 전역 언어가 바뀌었어도 보던 슬롯에 저장(오염 방지).
          const slotLang: Lang | undefined = m.lang === "ko" || m.lang === "en" ? m.lang : undefined;
          // 저장 전 상태 — 3트랙 안내·연결 점검(ping)은 '꺼짐→켜짐 전환'에만(라벨 '켤 때 1회'와 실동작 일치.
          // 2026-07-09 실측: 켜진 상태의 매 저장마다 ping이 나가 장부에 중복 기록 — 전환 게이트로 교정).
          const prevScoutOn = (() => { try { return loadContract(dashboardWorkspace(), slotLang).scoutMode === "on"; } catch { return false; } })();
          const ok = saveContract(dashboardWorkspace(), {
            claude: Array.isArray(m.claude) ? m.claude : [],
            codex: Array.isArray(m.codex) ? m.codex : [],
            claudeChecklist: !!m.claudeChecklist,
            codexChecklist: !!m.codexChecklist,
            verifyMode: normVerifyMode({ verifyMode: m.verifyMode }),
            claudeInjectMode: normInjectMode({ claudeInjectMode: m.claudeInjectMode }),
            scoutMode: normScoutMode({ scoutMode: m.scoutMode }),
          }, slotLang);
          if (!ok) vscode.window.showErrorMessage(tE("설정 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 저장해 주세요(기존 설정은 그대로 유지됩니다).","Failed to save settings — file locked or inaccessible. Try again shortly (existing settings are kept)."));
          // 3트랙 선택 시 API 안내(2026-07-09 사용자 요청 — 기본원칙 경고와 같은 모달 형태):
          //  키 없음 → 경고 모달 + [등록하러 가기(고급설정 이동)] / [알겠습니다]
          //  키 있음 → 실제 연결 점검(ping 1회 — PRIVACY에 전송 지점으로 명시) 후 정상/실패를 사실대로.
          // ⚠ 문구 정직성: 실측(D5)상 '키 없음=효과 미비'가 아니라 '정찰 미실행=효과 미비'가 사실 — 경고문은 그 사실 기준.
          if (ok && normScoutMode({ scoutMode: m.scoutMode }) === "on" && !prevScoutOn) {
            // 대상 확인 스텝(2026-07-10 구조 해법 — 발원지 차단): 세션 폴더가 git이 아니고 대상 미지정이면,
            // '정찰이 이 폴더만 본다'는 사실을 켜는 순간에 확인시키고 원클릭 지정 경로를 준다(고지-only 아님).
            void (async () => {
              const ws2 = dashboardWorkspace();
              if (!ws2) return;
              const modalLang: Lang = slotLang || loadLangExt(); // 방금 저장한 슬롯과 동일 기준(경계 갈림 방지 — Codex 반례)
              const hasRepoSet = (() => { try { return !!String(JSON.parse(fs.readFileSync(contractFileFor(ws2, modalLang), "utf8"))?.scoutRepo || "").trim(); } catch { return false; } })();
              // .git 폴더 존재가 아니라 rev-parse로 판독 — 하위 폴더를 연 진짜 git을 '기록 없음'으로 오보하거나
              // 빈 .git을 정상으로 오인하던 실사고 계열(scope-target.js와 동일 정본 — Codex 반례 2026-07-10)
              const wsIsGit = (() => { try { return require("child_process").spawnSync("git", ["-c", "safe.directory=*", "-C", ws2, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true }).status === 0; } catch { return false; } })();
              if (hasRepoSet || wsIsGit) return;
              const pickBtn = tE("다른 폴더 지정…", "Choose another folder…");
              const pick = await vscode.window.showWarningMessage(tE(
                "정찰 대상 확인 — 이 폴더(" + ws2 + ")는 변경 기록(git)이 없어요.\n\n실제 개발이 다른 폴더(git 저장소)에서 이뤄진다면 그 폴더를 정찰 대상으로 지정해야 지도·일지·확인신호가 그 개발을 따라갑니다. 이 폴더에서 문서 작업만 한다면 그대로 두셔도 돼요(나중에 어긋남이 감지되면 설정 카드가 뜹니다).",
                "Confirm scout target — this folder (" + ws2 + ") has no change history (git).\n\nIf development actually happens in another folder (a git repo), set it as the scout target so maps, journal and confirms follow that work. If you only edit documents here, leaving it is fine (a setup card appears later if a mismatch is detected)."),
                { modal: true }, pickBtn, tE("이 폴더 그대로", "Keep this folder"));
              if (pick === pickBtn) {
                const sel = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: tE("정찰 대상으로 지정", "Set as scout target") });
                if (sel && sel[0]) { await setScoutTargetFromUi(ws2, sel[0].fsPath, modalLang); this.post(); }
              }
            })().catch(() => { /* 확인 스텝 실패가 저장 흐름을 못 막음 */ });
            if (!readDeepseekView().hasKey) {
              const go = tE("등록하러 가기", "Register key");
              vscode.window.showWarningMessage(tE(
                "3트랙(정찰)이 켜졌지만 등록된 DeepSeek API 키가 없어요.\n\n키 없이도 기본 정찰(쓰시던 Claude가 겸임 — 별도 결제 없음)은 전부 동작하지만, '비교용 두 번째 정찰(DeepSeek)'은 잠겨 있어요. 그리고 어느 쪽이든 정찰이 한 번도 실행되지 않으면 3트랙의 효과가 미비할 수 있어요.\n\n상세는 정찰 카드의 '정찰 구조 자세히 보기 (새탭)'에서 확인하세요.",
                "3-track (recon) is on, but no DeepSeek API key is registered.\n\nWithout a key the default recon (your existing Claude doubles as scout — no separate billing) fully works, but the second comparison scout (DeepSeek) stays locked. And with either scout, if recon never actually runs, 3-track delivers little.\n\nSee 'Recon structure in detail (new tab)' on the recon card."),
                { modal: true }, go, tE("알겠습니다", "Got it")).then((pick) => {
                if (pick === go) this.panel?.webview.postMessage({ type: "switchTab", tab: "adv" });
              });
            } else {
              // 연결 점검 — 배포된 브릿지의 ping을 실제 실행(전송 1회·키 원문은 헤더로만). 결과는 사실대로.
              vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: tE("DeepSeek 연결 점검 중…", "Checking DeepSeek connection…") }, () => new Promise<void>((resolve) => {
                try {
                  const tok = hookSetup.resolveNodeToken(nodeTokenCandidates());
                  if (!tok) { vscode.window.showWarningMessage(tE("연결 점검을 실행할 node를 찾지 못했어요 — 키는 등록돼 있고, 기본 정찰(Claude 겸임)은 계속 동작합니다.", "Couldn't find node to run the check — the key is registered and default recon (Claude) keeps working.")); resolve(); return; }
                  const p = spawn(tok.token + " " + JSON.stringify(path.join(BRIDGE_DIR, "deepseek-bridge.js").replace(/\\/g, "/")) + " ping", { shell: true, timeout: 45000 });
                  let out = "", err = "";
                  p.stdout?.on("data", (d) => { out += d; });
                  p.stderr?.on("data", (d) => { err += d; });
                  p.on("close", (code) => {
                    if (code === 0 && /^ok/m.test(out)) vscode.window.showInformationMessage(tE("API 등록과 정상 연결이 확인되었습니다 — 3트랙이 정상 운용됩니다(DeepSeek 비교 정찰 사용 가능).", "API key verified and connection OK — 3-track is fully operational (DeepSeek comparison scout available)."));
                    else vscode.window.showWarningMessage(tE("키는 등록돼 있지만 연결 점검에 실패했어요(" + (err || out || "응답 없음").trim().slice(0, 120) + "). 기본 정찰(Claude 겸임)은 계속 동작합니다 — 키/네트워크를 확인하세요(⚙️ 고급설정).", "The key is registered but the connection check failed (" + (err || out || "no response").trim().slice(0, 120) + "). Default recon (Claude) keeps working — check the key/network (⚙️ Advanced)."));
                    resolve();
                  });
                  p.on("error", () => { vscode.window.showWarningMessage(tE("연결 점검 실행 실패 — 키는 등록돼 있고, 기본 정찰은 계속 동작합니다.", "Failed to run the check — the key is registered and default recon keeps working.")); resolve(); });
                } catch { resolve(); }
              }));
            }
          }
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "contract", ok });
        }
        if (m?.type === "ledgerAct" && m.sig) {
          // MAP 장부 개입(⑤ 역할 전환) — 승인 큐가 아니라 선택적 오버라이드: 고정/차단(+해제)은 관측 장부 이벤트로,
          // 내보내기는 확정 장부(MAP.md) 명시 기록으로. sig 기준이라 목록 갱신·번호 밀림 오작동이 원천적으로 없다.
          // 이벤트 적재는 배포 런타임(contract-lib)의 appendLedgerEvent 재사용 — 형식 단일 출처(복사 없음).
          const ws = dashboardWorkspace();
          if (!ws) return;
          const act = String(m.act || "");
          const lib = bridgeLib();
          if (typeof lib?.appendLedgerEvent !== "function") { vscode.window.showErrorMessage(tE("브릿지 런타임이 낡아 장부 개입을 기록할 수 없어요 — 저장소에서 node install.js 실행 후 창을 리로드하세요.","Bridge runtime is outdated for ledger actions — run node install.js in the repo, then reload the window.")); return; }
          const cur = readMapLedgerUncached(ws);
          const item = cur.entries.find((p) => p.sig === String(m.sig));
          if (!item) { vscode.window.showWarningMessage(tE("그 항목을 장부에서 찾지 못했어요 — 목록을 새로고침합니다.","Could not find that entry in the ledger — refreshing.")); mapLedgerBump++; this.post(); return; }
          const record = (type: string, fromNote: string, failMsg?: string): boolean => {
            // failMsg: 경로별 정확한 사실 고지 — export처럼 '이미 다른 파일은 변경된 뒤'의 실패는 기본 문구("아무것도
            // 반영 안 됨")가 거짓이 되므로 호출부가 실제 상태를 말하는 문구를 넘긴다(Codex 반례 반영).
            const okA = lib.appendLedgerEvent(scoutTargetFor(ws).repo, { ts: new Date().toISOString(), type, sig: item.sig, text: item.text, from: fromNote }) === true; // P1: 대상 장부에 기록
            if (!okA) vscode.window.showErrorMessage(failMsg || tE("장부 기록에 실패했어요(권한/디스크?) — 아무것도 반영되지 않았습니다.","Failed to write the ledger (permission/disk?) — nothing was applied."));
            return okA;
          };
          const done = () => { mapLedgerBump++; this.post(); };
          if (act === "pin" || act === "unpin" || act === "unban") {
            // 가역·장부 내부 기록만 → 모달 없이 즉시(작업 흐름 방해 최소화)
            if (record(act === "pin" ? "pinned" : act === "unpin" ? "unpinned" : "unbanned", tE("대시보드 개입","dashboard action"))) done();
            return;
          }
          if (act === "ban") {
            vscode.window.showWarningMessage(tE(`이 지식을 차단할까요? 탐색 자료에서 제외됩니다(기록은 지워지지 않고 남습니다 — 해제 가능).\n\n"${item.text}"`,`Ban this knowledge? It will be excluded from scout packages (the record is kept, not deleted — reversible).\n\n"${item.text}"`), { modal: true }, tE("차단","Ban")).then((pick) => {
              if (pick !== tE("차단","Ban")) return;
              if (record("banned", tE("대시보드 차단","dashboard ban"))) done();
            });
            return;
          }
          if (act === "export") {
            if (item.lane !== "trusted") { vscode.window.showWarningMessage(tE("내보내기는 신뢰 차선(검증됨/고정) 항목만 가능해요.","Only trusted-lane entries (verified/pinned) can be exported.")); return; }
            if (item.inMap) { vscode.window.showInformationMessage(tE("이미 확정 장부에 같은 문구가 있어요 — 중복 기록하지 않았습니다.","The stable ledger already contains this text — no duplicate written.")); return; }
            vscode.window.showWarningMessage(tE(`이 지식을 확정 장부(${cur.mapRel})에 기록할까요? 저장소 파일이 변경됩니다.\n\n"${item.text}"`,`Export this knowledge to the stable ledger (${cur.mapRel})? A repository file will be modified.\n\n"${item.text}"`), { modal: true }, tE("내보내기","Export")).then((pick) => {
              if (pick !== tE("내보내기","Export")) return;
              const now = new Date().toISOString();
              const f = mapLedgerFile(ws);
              let md = "";
              try { md = fs.readFileSync(f, "utf8"); } catch { /* 없으면 공유 모듈이 뼈대 생성 */ }
              try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* atomicWrite가 재시도 */ }
              if (!atomicWrite(f, appendApproved(md, [{ text: item.text, from: item.from || tE("관측 장부","observed ledger") }], now))) { vscode.window.showErrorMessage(tE("확정 장부 기록에 실패했어요(파일 잠김/권한?) — 아무것도 변경되지 않았습니다.","Failed to write the stable ledger (locked/permission?) — nothing was changed.")); return; }
              record("exported", tE("대시보드 내보내기 → ","dashboard export → ") + cur.mapRel,
                tE("확정 장부 파일에는 기록됐지만 관측 이벤트 적재는 실패했어요(권한/디스크?) — 재내보내기는 확정 장부 중복 대조가 막아줍니다.","Written to the stable ledger file, but recording the observed event failed (permission/disk?) — duplicate export is still prevented by the ledger text match."));
              done();
            });
            return;
          }
        }
        if (m?.type === "saveDeepseekKey") {
          // 키 저장/삭제 — 원문은 이 핸들러에서 파일로만 가고, 상태(post)로는 마스킹만 나감. 빈 입력=키 삭제(모델·주소 설정은 보존).
          const key = typeof m.key === "string" ? m.key.trim() : "";
          let ok = false;
          try { ok = atomicWrite(DEEPSEEK_FILE, JSON.stringify(mergeDeepseekConfig(readDeepseekRaw(), key), null, 2)); } catch { ok = false; }
          if (!ok) vscode.window.showErrorMessage(tE("DeepSeek 키 저장 실패 — 파일 접근이 막혔어요. 잠시 후 다시 시도하세요.","Failed to save the DeepSeek key — file inaccessible. Try again shortly."));
          else if (key && !isPlausibleKey(key)) vscode.window.showWarningMessage(tE("저장은 됐지만 키 형식이 일반적이지 않아요(sk-…). 오타가 아닌지 확인하세요.","Saved, but the key format looks unusual (sk-…). Double-check for typos."));
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "deepseek", ok });
        }
        if (m?.type === "saveBase") {
          let ok = false;
          try {
            // lang = 보던 슬롯(계약 저장과 동일 원리). 구 런타임 lib은 2번째 인자를 무시(=기존 동작·무해).
            const slotLang = m.lang === "ko" || m.lang === "en" ? m.lang : undefined;
            ok = bridgeLib()?.saveBaseDirective?.({ verifyBaseline: m.verifyBaseline, transmit: m.transmit, rejudge: m.rejudge }, slotLang) === true;
            if (ok && typeof m.scoutBaseline === "string") ok = bridgeLib()?.saveScoutBaseline?.(m.scoutBaseline, slotLang) === true; // ④ 정찰 칸(같은 패널 한 버튼 — 사용자 단순화 요청 2026-07-09)
          } catch {
            ok = false;
          }
          if (!ok) vscode.window.showErrorMessage(tE("단계별 기본 원칙 저장 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 시도해 주세요.","Failed to save stage baselines — file locked or inaccessible. Try again shortly."));
          this.post();
          this.panel?.webview.postMessage({ type: "saveResult", target: "base", ok });
        }
        if (m?.type === "baseEditWarn") {
          // 편집 시작(필드 첫 포커스) 시점 informed-consent 경고. 필드별 다른 메시지(합의된 설계):
          //  - verifyBaseline(검증 기본원칙) → Codex 검증 '꼼꼼함' + 결과 표시 둘 다 정함('표시만 영향' 아님)
          //  - transmit/rejudge(전달/재판단) → Claude의 검증 흐름
          // webview는 포커스를 안 건드림(blur/refocus 없음) → 편집/저장 흐름 보존. 숨겨 강제주입 대신 공개·동의.
          const isVerify = m.field === "verify";
          const isScout = m.field === "scout";
          const msg = isScout
            ? tE("'정찰 기본 원칙'은 정찰 AI가 영향지도를 그릴 때의 태도(자료 밖 추측 금지 등)를 정합니다 — 검증 흐름(전달·재판단)과는 별개예요.\n\n수정하면 이후 지도 기록에 '기본 프롬프트 아님' 서명이 남아, 나중에 명중률을 잴 때 기본 프롬프트 지도와 구분됩니다(자동으로 뭘 빼거나 막지는 않음). 지도 형식(①~⑥·high)은 여기서 못 바꿉니다 — 아래 잠금 구획 참조.\n\n그래도 변경하시겠습니까?","The scout baseline sets the scout AI's attitude when drawing impact maps (no guessing beyond the material, etc.) — separate from the verification flow.\n\nEditing marks later map records as 'non-default prompt' so future hit-rate measurements can keep them apart (nothing is auto-excluded or blocked). The map format (①~⑥ · high) cannot be changed here — see the locked section below.\n\nChange it anyway?")
            : isVerify
            ? tE("'검증 기본원칙'은 Codex가 어떻게 검증할지(파일을 직접 열고·빠뜨리지 말고·범위를 넓혀 보라)와 결론을 쓰는 형식을 함께 정합니다.\n\n줄이거나 바꾸면 Codex 검증이 느슨해질 수 있고, 대시보드의 'Codex 검증 대화' 영역에 뜨는 통과/보완/보류/실패 색 표시와 결론·근거 경고가 동작하지 않을 수 있어요.\n\n그래도 변경하시겠습니까?","The verification baseline defines how Codex verifies (open files, skip nothing, widen scope) AND the verdict format.\n\nWeakening it can loosen verification, and the pass/notes/hold/fail chips and evidence alerts in the dashboard may stop working.\n\nChange it anyway?")
            : tE("이 원칙은 Claude가 검증을 주고받고(전달) 결과를 다시 판단하는(재판단) 흐름에 직접 관여합니다.\n\n줄이거나 바꾸면 검증의 완전한 동작을 보장하지 못할 수 있어요.\n\n그래도 변경하시겠습니까?","This principle directly drives how Claude hands off verification (transmission) and re-judges the result.\n\nWeakening it may break the full verification behavior.\n\nChange it anyway?");
          vscode.window.showWarningMessage(msg, { modal: true }, tE("변경","Change")).then((pick) => {
            this.panel?.webview.postMessage({ type: "baseEditWarnResult", field: m.field, ok: pick === tE("변경","Change") });
          });
        }
        if (m?.type === "resetBase") {
          let ok = false;
          try {
            // lang = 보던 슬롯 — 그 언어의 오버라이드만 기본값 복원(다른 언어 오버라이드 보존).
            const slotLang = m.lang === "ko" || m.lang === "en" ? m.lang : undefined;
            ok = bridgeLib()?.resetBaseDirective?.(slotLang) === true;
            // ④ 정찰 칸은 '화면에 보였을 때만' 함께 복원 — 2트랙에선 안 보이는 정찰 설정을 조용히 지우지 않는다(Codex 반례 2026-07-09)
            if (ok && m.scout === true) ok = bridgeLib()?.resetScoutBaseline?.(slotLang) !== false;
          } catch {
            ok = false;
          }
          if (!ok) vscode.window.showErrorMessage(tE("기본값 복원 실패 — 파일이 잠겨 있거나 접근이 막혔어요. 잠시 후 다시 시도해 주세요.","Failed to restore defaults — file locked or inaccessible. Try again shortly."));
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
          const ok = ackIntegrity(Array.isArray(m.ids) ? m.ids : "all"); // 빈 배열([])은 그대로 → no-op. 배너가 session-missing만 빼 []를 보낼 때 'all'로 변질돼 전체(다른 빨강 포함)가 ack되던 회귀 방지.
          if (!ok) vscode.window.showErrorMessage(tE("무결성 경보 확인 저장 실패 — 파일이 잠겨 있을 수 있어요. 잠시 후 다시 시도해 주세요.","Failed to save alert acknowledgement — the file may be locked. Try again shortly."));
          this.post();
          this.onChange?.(); // 상태바도 즉시 갱신(watcher 지연/누락에 안 기댐) → 빨강 경보 바로 해제
        }
        if (m?.type === "refresh") this.post();
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
      // 재표시 즉시 최신화 — 컨텍스트 미유지 복원 패널이 가려졌다 돌아올 때 15s poll을 기다리지 않게(조사 합의 보강).
      this.panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) this.post(); });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside);
    }
    this.post();
  }

  post(): void {
    // 언어가 바뀌었으면(이 창 토글이든 다른 창이든 — BRIDGE_DIR watch로 post가 불림) 웹뷰 HTML을 새 언어로 재생성.
    // 정적 라벨은 html() 생성 시 t(ko,en)로 박히므로 재생성이 전환 방법이다(전환은 드묾 — 펼침 상태 리셋 수용).
    // 언어 전환 시 HTML 재생성도 격리 — post()는 어떤 경로에서도 호출자(저장 핸들러 등)의 흐름을 끊지 않는다.
    try { if (this.panel && this.htmlLang !== loadLangExt()) this.panel.webview.html = this.html(this.panel.webview); } catch (e) { console.warn("codex-bridge: dashboard html regen failed", e); }
    // 상태 계산 예외가 호출자(저장 핸들러 등)의 후속 처리 — 특히 saveResult(성공 플래시) — 를 중단시키지 않게 격리.
    // (Codex 지적: 저장 성공 후 post가 던지면 '저장됐는데 피드백 없음' — 사용자에겐 누락으로 보임)
    let state: BridgeState;
    try { state = computeState(this.turnsN()); } catch (e) { console.warn("codex-bridge: state compute failed — dashboard push skipped", e); return; }
    // 전달 실패 관측(fire-and-forget 보완): postMessage가 false(미배달 — 웹뷰 파괴/숨김)를 돌려주면 로그로 남긴다.
    (state as unknown as { postedAt: number }).postedAt = Date.now(); // 신선도 스탬프 — 웹뷰가 '마지막 갱신'을 상시 표시(침묵 실패 가시화, 양 감사 합의)
    if (!this.panel) { console.warn("codex-bridge: dashboard push skipped — no panel (orphan/닫힘)"); return; } // 관측 공백 보완(감사 지적: optional chaining이 이 분기를 삼켰음)
    const sent = this.panel.webview.postMessage({ type: "data", data: state });
    if (sent && typeof (sent as Thenable<boolean>).then === "function") (sent as Thenable<boolean>).then((ok) => { if (!ok) console.warn("codex-bridge: dashboard data post dropped (webview hidden/destroyed)"); });
  }
  private htmlLang: Lang | null = null; // 현재 웹뷰 HTML이 렌더된 언어(재생성 판단)

  private html(webview: vscode.Webview): string {
    // UI 언어: 정적 라벨은 t(ko,en)으로 생성 시 결정, 동적(JS) 라벨은 주입되는 EN 상수+t()로 동일 언어 유지.
    const uiLang = loadLangExt();
    this.htmlLang = uiLang;
    const EN = uiLang === "en";
    const t = (ko: string, en: string): string => (EN ? en : ko);
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
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid var(--vscode-panel-border)}
  h1{font-size:20px;font-weight:800;margin:0;display:flex;align-items:center;gap:11px;letter-spacing:.2px}
  h1 .sub{font-size:12px;font-weight:400;color:var(--vscode-descriptionForeground)}
  /* 워드마크: 파랑(Claude)→초록(Codex) 그라데이션 사각 — 이모지 대신 */
  .brand{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--vscode-charts-blue),var(--vscode-charts-green));flex:none;box-shadow:0 2px 8px color-mix(in srgb,var(--vscode-charts-blue) 32%,transparent)}
  h2{font-size:15.5px;font-weight:800;margin:28px 0 11px;color:var(--vscode-foreground);display:flex;align-items:center;gap:9px;letter-spacing:.2px}
  h2 .sub2{font-size:11px;font-weight:400;color:var(--vscode-descriptionForeground);letter-spacing:0}
  /* 섹션 헤더: 의미색 틴트 배경 + 두꺼운 좌측 악센트로 또렷하게(파랑=Claude · 초록=Codex/검증 · 보라=공통/기본). */
  h2.sec{--accent:var(--vscode-charts-purple);margin:34px 0 12px;padding:11px 16px;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--vscode-panel-border));border-left:5px solid var(--accent);border-radius:10px;background:color-mix(in srgb,var(--accent) 11%,var(--vscode-sideBar-background));box-shadow:0 1px 2px rgba(0,0,0,.06);flex-wrap:wrap}
  h2.sec.claude{--accent:var(--vscode-charts-blue)}
  h2.sec.codex{--accent:var(--vscode-charts-green)}
  h2.sec.base{--accent:var(--vscode-charts-purple)}
  /* 제목 카드색을 섹션마다 '서로 다르게' — 같은 색이 반복(겹침)되지 않게. 단 한눈에 보기↔단계별 기본원칙만 같은 보라 허용. 차분한 7색(파랑·초록·보라·주황·청록·노랑·로즈). */
  h2.sec.accent-orange{--accent:var(--vscode-charts-orange)}
  h2.sec.accent-yellow{--accent:var(--vscode-charts-yellow,#d7ba7d)}
  h2.sec.accent-teal{--accent:#4ec9b0}
  h2.sec.accent-rose{--accent:#d18fb0}
  h2.sec::before{display:none}
  .hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:4px 0 0 22px;line-height:1.5}
  .hint code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background,var(--vscode-panel-border));padding:0 4px;border-radius:3px}
  .hint .ic{cursor:help;border-bottom:1px dotted currentColor;white-space:nowrap}
  /* 규칙 입력 메타 칩(선택·형식·비움) */
  .rulemeta{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .rchip{font-size:10px;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border);border-radius:999px;padding:1px 8px;white-space:nowrap}
  .rchip.opt{color:var(--vscode-charts-blue);border-color:var(--vscode-charts-blue);font-weight:700}
  .card{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:16px 18px;background:var(--vscode-sideBar-background);margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
  .muted{color:var(--vscode-descriptionForeground);font-size:12px}
  .tabbar{display:flex;align-items:center;gap:3px;margin:4px 0 18px;padding:3px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:10px}
  .langseg{margin-left:auto;display:inline-flex;gap:2px;padding:2px;border:1px solid var(--vscode-panel-border);border-radius:8px}
  .langbtn{background:none;border:none;color:var(--vscode-descriptionForeground);padding:5px 12px;cursor:pointer;font-size:12px;border-radius:6px;font-weight:600}
  .langbtn:hover{color:var(--vscode-foreground)}
  .langbtn.on{color:#fff;background:var(--vscode-charts-purple)}
  .tabbtn{background:none;border:none;color:var(--vscode-descriptionForeground);padding:8px 18px;cursor:pointer;font-size:13px;border-radius:7px;font-weight:600;display:flex;align-items:center;gap:6px;transition:background .12s}
  .tabbtn:hover{color:var(--vscode-foreground)}
  .tabbtn.active{color:#fff;background:var(--vscode-charts-blue);box-shadow:0 1px 5px color-mix(in srgb,var(--vscode-charts-blue) 45%,transparent)}
  .tab-panel{display:none}
  .tab-panel.active{display:block}
  .stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:6px 0 14px}
  .stat-card{border:1px solid var(--vscode-panel-border);border-left:5px solid var(--accent,var(--vscode-charts-blue));border-radius:10px;padding:14px 16px;background:color-mix(in srgb,var(--accent,var(--vscode-charts-blue)) 7%,var(--vscode-editor-background))}
  .stat-card.s-blue{--accent:var(--vscode-charts-blue)}
  .stat-card.s-green{--accent:var(--vscode-charts-green)}
  .stat-card.s-orange{--accent:var(--vscode-charts-orange)}
  .stat-card.s-purple{--accent:var(--vscode-charts-purple)}
  .stat-num{font-size:26px;font-weight:800;color:var(--accent,var(--vscode-charts-blue));line-height:1.1}
  .stat-lbl{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:5px}
  .stat-chart{display:flex;gap:22px;align-items:center;flex-wrap:wrap;margin:10px 0 14px;padding:14px 16px;border:1px solid var(--vscode-panel-border);border-radius:10px;background:var(--vscode-editor-background)}
  .chart-h{font-size:14px;font-weight:800;color:var(--vscode-foreground);margin:4px 0 14px;padding:6px 12px 6px 13px;border-left:4px solid var(--vscode-charts-blue);background:color-mix(in srgb,var(--vscode-charts-blue) 9%,var(--vscode-editorWidget-background));border-radius:0 7px 7px 0;line-height:1.45}
  .chart-h .muted{font-weight:400;font-size:11px}
  .donut-wrap{position:relative;width:140px;height:140px}
  .donut-center{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;color:var(--vscode-foreground);pointer-events:none}
  .legend{display:flex;flex-direction:column;gap:7px}
  .leg-item{font-size:12px;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:8px}
  .leg-dot{width:11px;height:11px;border-radius:3px;flex:none}
  .leg-item b{color:var(--vscode-foreground);font-variant-numeric:tabular-nums}
  .chart-box.wide{flex:1 1 100%;min-width:240px}
  .trend-bars{display:flex;gap:3px;align-items:flex-end;height:84px;margin-top:4px}
  .tbar{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
  .tbar-stack{width:100%;max-width:22px;height:66px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--vscode-editorWidget-background);border-radius:3px;overflow:hidden}
  .tseg{width:100%}
  .tseg.tpass{background:var(--vscode-charts-green)}
  .tseg.tfail{background:var(--vscode-charts-orange)}
  .tbar-lbl{font-size:9px;color:var(--vscode-descriptionForeground);white-space:nowrap}
  .heatmap{display:flex;flex-direction:column;gap:2px;margin-top:4px}
  .heat-row{display:flex;gap:2px;align-items:center}
  .heat-day{font-size:10px;color:var(--vscode-descriptionForeground);width:18px;flex:none;text-align:center}
  .heat-cell{flex:1;aspect-ratio:1;border-radius:2px;min-width:0;border:1px solid color-mix(in srgb,var(--vscode-panel-border) 50%,transparent)}
  .heat-legend{display:flex;align-items:center;gap:4px;margin-top:9px;font-size:10px;color:var(--vscode-descriptionForeground)}
  .heat-legend .hl{width:15px;height:15px;border-radius:3px;border:1px solid color-mix(in srgb,var(--vscode-panel-border) 50%,transparent)}
  .heat-legend .hl-t{margin:0 4px}
  .heat-head{margin-bottom:3px}
  .heat-hh{flex:1;min-width:0;font-size:9px;color:var(--vscode-descriptionForeground);text-align:left;line-height:1}
  #donutLegend{flex:1;min-width:210px}
  .vrow{display:flex;align-items:center;gap:8px;font-size:12px;margin:6px 0}
  .vlbl{width:78px;flex:none;color:var(--vscode-foreground)}
  .vbar{flex:1;height:15px;background:var(--vscode-editorWidget-background);border-radius:4px;overflow:hidden}
  .vbar-fill{display:block;height:100%;border-radius:4px}
  .vnum{width:62px;text-align:right;flex:none;font-variant-numeric:tabular-nums;color:var(--vscode-foreground);font-weight:600;white-space:nowrap}
  .vmiss{margin-top:8px;padding-top:8px;border-top:1px dashed var(--vscode-panel-border)}
  .vmiss-note{flex:1;font-size:11px;color:var(--vscode-descriptionForeground)}
  .vlbl-wide{width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vnum-wide{width:auto;min-width:86px;padding-left:8px;white-space:nowrap}
  .id{font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-descriptionForeground);word-break:break-all}
  .role{font-weight:600;font-size:12px;margin:8px 0 3px;color:var(--vscode-descriptionForeground)}
  .text{white-space:pre-wrap;overflow-wrap:anywhere}
  button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:5px;padding:5px 12px;cursor:pointer;font:inherit}
  button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  /* 히어로: Claude ⇄ Codex */
  .hero{display:flex;align-items:stretch;gap:10px;margin-bottom:16px}
  .agent{flex:1;text-align:center;padding:16px 10px;border-radius:11px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);box-shadow:0 1px 3px rgba(0,0,0,.07)}
  .agent .emo{font-size:30px;line-height:1}
  .agent .nm{font-weight:700;margin-top:6px}
  .agent .ro{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
  .agent.claude{border-color:var(--vscode-charts-blue);background:color-mix(in srgb,var(--vscode-charts-blue) 6%,var(--vscode-editor-background))}
  .agent.codex{border-color:var(--vscode-charts-green);background:color-mix(in srgb,var(--vscode-charts-green) 6%,var(--vscode-editor-background))}
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
  .mono.s{background:var(--vscode-charts-purple)} /* 탐색자(3트랙) */
  .agent.scout{border-color:var(--vscode-charts-purple);background:color-mix(in srgb,var(--vscode-charts-purple) 6%,var(--vscode-editor-background));flex:0 0 auto;padding:16px 14px}
  /* 검증 모드 세그먼트 토글 */
  .seg{display:inline-flex;flex-wrap:wrap;max-width:100%;border:1px solid var(--vscode-panel-border);border-radius:7px;overflow:hidden;margin-left:8px;vertical-align:middle}
  .seg button{background:transparent;color:var(--vscode-foreground);border:0;border-right:1px solid var(--vscode-panel-border);padding:5px 11px;font-size:11px;cursor:pointer;border-radius:0;display:inline-flex;flex-direction:column;align-items:center;gap:1px;line-height:1.25}
  .seg button small{font-size:9px;font-weight:400;opacity:.72}
  .seg button:last-child{border-right:0}
  .seg button.on{background:var(--vscode-charts-orange);color:#fff;font-weight:700}
  .seg button.on small{opacity:.92}
  /* MAP 장부(확정 지식층) 카드 — 대기 있음=주황 테두리(눈에 띄게), 없음=초록(안정) */
  .mled{margin-top:10px;border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-charts-orange);border-radius:6px;padding:10px 12px}
  .mled.calm{border-left-color:var(--vscode-charts-green)}
  .mledchips{display:flex;gap:8px;margin:6px 0 8px;flex-wrap:wrap}
  .mchip{display:flex;flex-direction:column;align-items:center;min-width:64px;padding:5px 10px;border-radius:6px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border)}
  .mchip b{font-size:16px;line-height:1.2}
  .mchip span{font-size:10px;opacity:.75}
  .mchip.hot{border-color:var(--vscode-charts-orange)} .mchip.hot b{color:var(--vscode-charts-orange)}
  .mchip.ok b{color:var(--vscode-charts-green)} .mchip.no b{opacity:.65}
  .mlrow{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-top:1px dashed var(--vscode-panel-border)} /* ⚠ 'mrow'는 기존 설정 카드가 쓰는 전역 클래스 — 반드시 별도 이름(mlrow) */
  .mlrow .mltxt{flex:1;min-width:0} .mlrow .mltxt .t{font-size:12px;word-break:break-all} .mlrow .mltxt .f{font-size:10px;opacity:.6;margin-top:2px}
  .mlrow button{padding:3px 10px;font-size:11px;flex-shrink:0}
  .mhist{font-size:11px;padding:3px 0;word-break:break-all} .mhist .w{opacity:.6;font-size:10px}
  /* 정찰 한눈 도해 — 위쪽 검증 파이프라인과 같은 시각 문법(색 박스+화살표). 첫 화면=그림, 텍스트=접힘 원칙 */
  .rflow{display:flex;align-items:stretch;gap:6px;flex-wrap:wrap;margin:8px 0 6px}
  .rnode{flex:1;min-width:118px;border:1.5px solid var(--vscode-panel-border);border-radius:8px;padding:7px 9px;background:var(--vscode-editorWidget-background)}
  .rnode b{display:block;font-size:12px}
  .rbdg{display:inline-block;font-size:9px;font-weight:700;padding:0 6px;border-radius:7px;border:1px solid;margin:3px 0}
  .rmini{font-size:10.5px;opacity:.8;line-height:1.35}
  .rarw{align-self:center;font-size:10px;opacity:.65;white-space:nowrap}
  .rlife{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:2px 0 8px}
  .rlchip{font-size:10.5px;font-weight:700;border:1px solid var(--vscode-panel-border);border-radius:8px;padding:1px 8px;background:var(--vscode-editorWidget-background);cursor:help} /* ⚠ .rchip은 기존 규칙 메타 칩 전역 클래스 — 반드시 별도 이름(.mrow 충돌과 동일 유형 재발 방지) */
  .rapi{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
  .rapibox{flex:1;min-width:230px;border:1.5px solid;border-radius:8px;padding:7px 10px;background:var(--vscode-editorWidget-background)}
  .rapibox b{display:block;font-size:11.5px;margin-bottom:2px}
  .rsec{border:1px solid var(--vscode-panel-border);border-radius:8px;padding:8px 11px;margin:10px 0;background:var(--vscode-editorWidget-background)}
  .rsec>details{margin:6px 0}
  .mlb{display:inline-block;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:700;border:1px solid var(--vscode-panel-border);vertical-align:middle}
  .mlb.ok{color:var(--vscode-charts-green);border-color:var(--vscode-charts-green)}
  .mlb.hot{color:var(--vscode-charts-orange);border-color:var(--vscode-charts-orange)}
  .mlb.no{opacity:.6}
  .mcard{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:14px 16px;background:var(--vscode-editor-background);box-shadow:0 1px 3px rgba(0,0,0,.07)}
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
  .fnode.actor.scout{border-color:var(--vscode-charts-purple)} /* 탐색자(3트랙) — 켜졌을 때만 표시 */
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
  <nav class="tabbar">
    <button type="button" class="tabbtn active" data-tab="main">${t("📋 현황", "📋 Status")}</button>
    <button type="button" class="tabbtn" data-tab="stats">${t("📊 검증 통계", "📊 Verify Stats")}</button>
    <button type="button" class="tabbtn" data-tab="adv">${t("⚙️ 고급설정", "⚙️ Advanced")}</button>
    <span class="langseg" title="${t("전역 언어 — UI·주입 지침·규칙 슬롯의 언어(모든 프로젝트 공통)", "Global language — UI · injected directives · rule slots (shared by all projects)")}">
      <button type="button" class="langbtn" id="langKo" data-lang="ko">한국어</button>
      <button type="button" class="langbtn" id="langEn" data-lang="en">English</button>
    </span>
  </nav>
  <div id="tab-main" class="tab-panel active">
  <section class="onboard" id="onboard" style="display:none">
    <button type="button" id="obReopen" class="obreopen" style="display:none">${t("시작하기 다시 보기", "Show Getting Started again")}</button>
    <div id="obMain">
      <div class="obhead"><span id="obTitle">${t("시작하기", "Getting started")}</span><button type="button" id="obClose" class="obclose secondary" style="display:none">${t("끄기 ✕", "Dismiss ✕")}</button></div>
      <div id="obSteps">
        <div class="obstep" id="ob1"></div>
        <div class="obstep" id="ob2"></div>
        <div class="obstep" id="ob3"></div>
      </div>
      <div id="obDone" class="obdone" style="display:none">${t("준비 끝 ✓ — 이제 매 턴 자동으로 검증됩니다.", "All set ✓ — every turn is now verified automatically.")}</div>
    </div>
  </section>

  <div class="top"><h1><span class="brand"></span>Codex Bridge <span class="sub">${t("Claude ⇄ Codex 자동 연결·검증", "Claude ⇄ Codex auto link & verify")}</span></h1><button id="refresh" class="secondary">${t("↻ 새로고침", "↻ Refresh")}</button></div>

  <div class="hero">
    <div class="agent claude"><div class="mono c">C</div><div class="nm">Claude</div><div class="ro">${t("구현 · implement", "implement")}</div><div class="ro" id="ccActualRo" title="${t("대화 기록에 답변마다 찍히는 실제 모델 — 앱 표기(피커 체크 등)가 어긋나 보여도 이것이 정본", "the model stamped on each answer in the conversation log — trust this even when app UI labels disagree")}"></div></div>
    <div class="link" id="linkViz"><div class="bar"></div><div class="emo" id="linkEmo">●</div><div class="st" id="linkState">${t("연결 없음", "Not linked")}</div></div>
    <div class="agent codex"><div class="mono x">Cx</div><div class="nm">Codex</div><div class="ro">${t("검증 · verify", "verify")}</div><div class="ro" id="cxActualRo" title="${t("연결된 검증 세션 기록의 최근 실제 모델·생각강도", "latest actual model & effort from the linked verify session log")}"></div></div>
    <div class="agent scout" id="heroScout" style="display:none"><div class="mono s">S</div><div class="nm">${t("탐색자", "Scout")}</div><div class="ro">${t("영향지도 · 3트랙", "impact map · 3-track")}</div><div class="ro" id="scoutActualRo" title="${t("마지막 정찰 실행(지도 생성) — 비용 장부 기준(지도 보관 10장 정리와 무관)", "last scout run (map generation) — from the usage ledger (independent of map pruning)")}"></div></div>
  </div>
  <div id="status" class="statusline"></div>
  <div id="freshNote" style="font-size:10px;color:var(--vscode-descriptionForeground);margin:2px 0 4px">${t("데이터 불러오는 중… (몇 초가 지나도 안 바뀌면 이 창을 닫고 상태바에서 다시 여세요)", "Loading… (if this doesn't change within seconds, close this tab and reopen from the status bar)")}</div>

  <div id="integrityBanner" class="integrity" style="display:none"></div>

  <div id="liveStrip" class="livestrip" style="display:none">
    <div class="lsflow">
      <span class="lsbox claude" id="lsClaude">Claude</span>
      <span class="lsarrow" id="lsArrow">⟷</span>
      <span class="lsbox codex" id="lsCodex">Codex</span>
    </div>
    <div class="lsstage" id="lsStage"></div>
  </div>

  <h2 class="sec claude">${t("Claude 규칙", "Claude Rules")} <span class="to claude">${t("→ Claude에게", "→ to Claude")}</span> <span class="sub2">${t("Claude가 지킬 행동규칙 — 검증과 별개", "Behavior rules Claude must follow — separate from verification")}</span></h2>
  <div class="card">
    <div class="hint" id="slotNote" style="display:none;border-left:3px solid var(--vscode-charts-purple);padding-left:10px"></div>
    <div class="cblock claude">
      <div class="chead">${t("규칙", "Rules")} <span class="muted" style="font-weight:400">${t("· 기본 원칙 말고, 이 프로젝트에만 필요한 것", "· not the baseline — only what this project needs")}</span></div>
      <textarea id="cClaude" rows="3" placeholder="${t("예) 이 레포에선 ○○ 라이브러리·패턴 쓰지 마라&#10;예) 보고는 기술용어 빼고 예시로 정리해라&#10;예) 플랜 모드로 쓸 때: 영향받는 호출부·마이그레이션 순서를 플랜에 포함해라", "e.g.) Do not use the ○○ library/pattern in this repo&#10;e.g.) Report with examples, not jargon&#10;e.g.) In plan mode: include affected call sites & migration order in the plan")}"></textarea>
      <div class="rulemeta"><span class="rchip opt">${t("선택", "optional")}</span><span class="rchip">${t("⏎ 한 줄 = 규칙 1개", "⏎ one line = one rule")}</span><span class="rchip">${t("∅ 비우면 이 칸의 규칙만 안 붙음", "∅ empty = this box injects nothing")}</span></div>
      <label class="ck"><input type="checkbox" id="ckClaude"> ${t("체크리스트 강제 — 각 규칙마다 [준수/위반+근거] 달게 함", "Enforce checklist — require [complies/violated + reason] per rule")}</label>
      <div class="hint">${t("☑ 켜짐 → 답변 끝에 <code>[계약점검] 1) 준수 — &lt;근거&gt; / 2) 위반 — &lt;근거&gt;</code> 형식으로 규칙별 자가보고를 강제 · ☐ 꺼짐 → 규칙 텍스트만 주입", "☑ on → forces a per-rule self-report block <code>[Contract Check] 1) complies — &lt;reason&gt;</code> at the end of each answer · ☐ off → injects rule text only")}</div>
    </div>
    <label class="ck verify">${t("넣는 시점 — 이 규칙을 <b>언제</b> Claude에 넣을지", "Injection timing — <b>when</b> to inject these rules into Claude")} <span id="planNow" class="nowbadge" style="display:none"></span>
      <span class="seg" id="segInject">
        <button type="button" data-im="off">${t("꺼짐<small>안 넣음</small>", "Off<small>never</small>")}</button><button type="button" data-im="plan">${t("플랜 모드<small>플랜 때만</small>", "Plan mode<small>plan only</small>")}</button><button type="button" data-im="always">${t("항상<small>매 턴</small>", "Always<small>every turn</small>")}</button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="${t("플랜 모드 = Claude Code에서 shift+Tab으로 켜는 '계획 먼저 세우기' 모드. '플랜 모드'를 고르면 그 모드로 일할 때만 이 규칙이 들어갑니다.", "Plan mode = Claude Code's plan-first mode (shift+Tab). Choosing 'Plan mode' injects these rules only while working in that mode.")}">ⓘ ${t("플랜 모드란?", "What is plan mode?")}</span> · <span class="ic" title="${t("'코드 변경 시'가 없는 이유: 코드 변경은 턴이 끝나야 아는 신호라, 턴 시작에 넣는 이 축에선 못 씁니다. 검증 모드와 무관한 별도 축이에요.", "Why no 'on code change' here: code changes are only known when a turn ends, so a turn-start injection can't use it. This axis is independent of verify mode.")}">ⓘ ${t("'코드 변경 시'가 없는 이유", "Why no 'on code change'?")}</span></div>
  </div>

  <h2 class="sec codex">${t("검증", "Verification")} <span class="to codex">→ Codex</span> <span class="sub2">${t("Codex에게 검증받기 — 끄면 검증만 안 함(Claude 규칙은 별개)", "Get verified by Codex — turning this off only disables verification (Claude rules are separate)")}</span></h2>
  <div class="card">
    <div class="cblock codex">
      <div class="chead">${t("Codex 규칙", "Codex Rules")} <span class="muted" style="font-weight:400">${t("· 기본 검증원칙 말고, 이 프로젝트에서 특히 볼 것 · Codex 검증 때마다 붙음", "· not the baseline — what to focus on in this project · attached to every Codex verification")}</span></div>
      <textarea id="cCodex" rows="3" placeholder="${t("예) 동시성·레이스 컨디션을 중점으로 봐라&#10;예) 결제·정산은 중복 청구·반올림 오차·롤백까지 확인해라&#10;예) 단순 포맷·스타일 지적은 검증에서 빼라", "e.g.) Focus on concurrency & race conditions&#10;e.g.) For payments: check double-charging, rounding, rollback&#10;e.g.) Exclude pure formatting/style nits from verification")}"></textarea>
      <div class="rulemeta"><span class="rchip opt">${t("선택", "optional")}</span><span class="rchip">${t("⏎ 한 줄 = 규칙 1개", "⏎ one line = one rule")}</span><span class="rchip">${t("∅ 비우면 이 칸의 규칙만 안 붙음", "∅ empty = this box injects nothing")}</span></div>
      <label class="ck"><input type="checkbox" id="ckCodex"> ${t("체크리스트 강제 — 검증 답에 규칙별 [준수/위반+근거] 달게 함", "Enforce checklist — require [complies/violated + reason] per rule in verification answers")}</label>
      <div class="hint">${t("☑ 켜짐 → Codex 검증 답에도 규칙별 <code>[계약점검]</code> 자가보고 강제 · ☐ 꺼짐 → 규칙 텍스트만 붙음", "☑ on → Codex answers must include a per-rule <code>[Contract Check]</code> self-report · ☐ off → rule text only")}</div>
    </div>
    <label class="ck verify">${t("검증 모드 — <b>언제</b> Codex 검증→보고를 강제할지", "Verify mode — <b>when</b> to force the Codex verify→report loop")}
      <span class="seg" id="segVerify">
        <button type="button" data-vm="off">${t("꺼짐<small>강제 안 함</small>", "Off<small>not forced</small>")}</button><button type="button" data-vm="code">${t("코드 변경 시<small>편집한 턴</small>", "On code change<small>edited turns</small>")}</button><button type="button" data-vm="plancode">${t("플랜 확정/코드 변경<small>플랜·편집 턴</small>", "Plan confirm/code<small>plan·edit turns</small>")}</button><button type="button" data-vm="always">${t("모든 턴<small>매 응답</small>", "Every turn<small>all replies</small>")}</button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="${t("플랜 확정 = 플랜 모드(shift+Tab)에서 세운 계획을 확정·제출하는 그 턴(ExitPlanMode). 플랜 모드 '내내'가 아니라 확정하는 '순간'이에요. '플랜 확정/코드 변경'은 이 플랜 확정 턴이거나 파일을 바꾼 턴에 검증을 강제합니다.", "Plan confirm = the turn that submits the plan (ExitPlanMode) — the moment of confirming, not the whole plan mode. 'Plan confirm/code' forces verification on that turn or on file-changing turns.")}">ⓘ ${t("'플랜 확정'이 뭐야?", "What is 'plan confirm'?")}</span> · <span class="ic" title="${t("검증이 필요한 턴은 선택한 모드가 정해요. 모든 턴=매 답변, 코드 변경 시=파일을 만든/고친 턴, 플랜 확정/코드 변경=플랜을 확정했거나 파일을 고친 턴. 그 턴엔 Codex 검증 결과를 반영해 보고해야 끝낼 수 있어요.", "The selected mode decides which turns require verification. Every turn = all replies; on code change = turns that create/modify files; plan confirm/code = plan-confirm or file-changing turns. Those turns can only finish after reporting with Codex verification.")}">ⓘ ${t("언제 검증되나?", "When is it verified?")}</span></div>
    <label class="ck verify">${t("트랙 — 구현·검증 흐름에 <b>정찰(영향 미리보기·관찰 일지)</b>을 더할지", "Track — add <b>recon (impact preview · field journal)</b> to the implement·verify flow")}
      <span class="seg" id="segScout">
        <button type="button" data-sm="off">${t("2트랙<small>구현↔검증 (기본)</small>", "2-track<small>implement↔verify (default)</small>")}</button><button type="button" data-sm="on">${t("3트랙<small>+정찰 (관찰)</small>", "3-track<small>+recon (advisory)</small>")}</button>
      </span>
    </label>
    <div class="hint"><span class="ic" title="${t("정찰(3트랙) = 4단계 흐름 — ①변경 감지(기계·AI 없음): 지금 고치는 파일+예전에 같이 바뀌던 파일 힌트 ②영향지도(정찰 AI 호출): 이 변경이 어디까지 번질지 미리보기 ③관찰 일지(자동·추가 LLM 없음): 검증을 지나며 맞은 것/틀린 것이 저절로 쌓임 ④확정 교범(👤 선택): 원할 때만 도장 찍어 저장소 문서로 — 안 써도 ①~③은 자동. 관찰(advisory) 중심 — 단 하나의 예외는 플랜 게이트(3트랙 기본 켜짐): 지도가 없거나 낡으면 플랜 확정 전에 먼저 지도를 요청(세션당 2회까지·이후 통과·언제든 끌 수 있음), 그 외에는 아무것도 막거나 강제하지 않음. 외부로 나가는 경로는 두 갈래 — DeepSeek 키 등록 시(②의 꾸러미+연결 점검 1회, 키 등록=동의) / 기본 정찰 실행 시(같은 꾸러미가 쓰시던 Claude CLI 경유 — 별도 결제 없음). 이 설정은 프로젝트별 저장.", "Recon (3-track) = a 4-step flow — ① change sensing (machine, no AI): files you're editing + hints of files that changed together before ② impact map (scout AI call): preview how far this change reaches ③ field journal (auto, no extra LLM): right/wrong accrues by itself through verification ④ field manual (👤 optional): stamp items into repo docs only when you want — ①–③ run without it. Advisory-centred — the one exception is the plan gate (on by default in 3-track): if the map is missing/stale it asks for a map before plan confirmation (up to 2×/session, then passes · can be turned off anytime); everything else blocks/forces nothing. Data leaves via two routes — with a DeepSeek key (②'s package plus one connection check; key registration = consent) / when the default scout runs (the same package via your existing Claude CLI — no separate billing). Saved per project.")}">ⓘ ${t("정찰이란? (4단계 흐름)", "What is recon? (the 4-step flow)")}</span></div>
    <div id="scoutApiLine" class="muted" style="display:none;font-size:11.5px;margin:4px 0 0 2px"></div>
    <div id="scoutBox" class="stagebox" style="display:none"></div>
    <div class="stagebox" id="stageBox">
      <div class="sbhead">${t("↑ 위 검증을 켜면 <b>흐름 단계마다 '단계별 기본 원칙'</b>이 적용돼요", "↑ With verification on, the <b>stage baselines</b> apply at each step of the flow")} <span class="muted" style="font-weight:400">${t("· 지금 검증:", "· verify now:")} <b id="sbState">—</b> ${t("· 내용은 아래 단계별 기본 원칙에서", "· see Stage Baselines below for the text")}</span></div>
      <div class="sbrow" id="sbTransmit"><span class="sbmark"></span><b>${t("① Claude→Codex 넘길 때", "① When Claude hands off to Codex")}</b> ${t("· 전달 원칙", "· transmission principles")} <span class="who2 claude">Claude</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbVerify"><span class="sbmark"></span><b>${t("② Codex가 검증할 때", "② When Codex verifies")}</b> ${t("· 검증 기본원칙 + Codex 규칙", "· verification baseline + Codex rules")} <span class="who2 codex">Codex</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbRejudge"><span class="sbmark"></span><b>${t("③ Codex 답을 되짚을 때", "③ When re-judging Codex's answer")}</b> ${t("· 재판단 원칙", "· re-judgment principles")} <span class="who2 claude">Claude</span> <span class="sbwhy"></span></div>
      <div class="sbrow" id="sbScout" style="display:none"><span class="sbmark"></span><b>${t("④ 정찰이 지도를 그릴 때", "④ When the scout draws a map")}</b> ${t("· 정찰 기본 원칙 (3트랙)", "· scout baseline (3-track)")} <span class="sbwhy"></span></div>
    </div>
  </div>
  <div class="row"><button id="saveC">${t("저장", "Save")}</button><span id="savedAt" class="muted">${t("· 위 Claude 규칙 · Codex 규칙 · 검증 모드를 함께 저장", "· saves the Claude rules, Codex rules and verify mode together")}</span></div>

  <h2 class="sec">${t("한눈에 보기", "At a Glance")} <span class="sub2">${t("누구에게 · 뭐가 · 언제 들어가나 — 지금 저장된 설정 기준 (저장하면 바뀐 곳이 깜빡여요)", "who gets what, and when — based on saved settings (changes flash on save)")}</span></h2>
  <section class="flowmap card" id="fmSection">
    <div class="flow">
      <div class="fnode rule">${t("Claude<br>규칙", "Claude<br>rules")}</div>
      <div class="farrow" id="faInject"><span class="lbl">${t("넣는 시점", "inject when")}<br><b id="faInjectVal">${t("항상", "always")}</b></span><span class="ln"></span></div>
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>${t("구현", "implement")}</small></div>
      <div class="farrow off" id="faVerify"><span class="lbl">${t("검증 맡김", "verify when")}<br><b id="faVerifyVal">${t("안 함", "off")}</b></span><span class="ln"></span></div>
      <div class="fnode actor codex"><span class="mono x">Cx</span>Codex<small>${t("검증", "verify")}</small></div>
    </div>
    <!-- 탐색(3트랙) 줄 — 검증 흐름과 별개 축이라 둘째 줄로 분리(일렬로 붙이면 '검증 후 탐색'으로 오독 — 사용자 지적).
         실제 흐름: Claude(하네스)가 증거 봉투를 꾸려 탐색자에게 보내고, 지도가 게시판(과 Claude)으로 돌아온다. -->
    <div class="flow" id="scoutFlow" style="display:none;margin-top:9px;border-top:1px dashed var(--vscode-panel-border);padding-top:9px">
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>${t("증거 봉투 꾸림", "packs evidence")}</small></div>
      <div class="farrow" id="faScout"><span class="lbl">${t("정찰(3트랙)", "recon (3-track)")}<br><b id="faScoutVal">${t("직접/자동 지시 실행 시", "on direct/auto-directive runs")}</b></span><span class="ln"></span></div>
      <div class="fnode actor scout" id="fnScout"><span class="mono s">S</span>${t("정찰자", "Scout")}<small>${t("영향지도 ⚡LLM", "impact map ⚡LLM")}</small></div>
      <div class="farrow"><span class="lbl">${t("지도 반환", "returns map")}<br><b>${t("게시판+Claude", "board + Claude")}</b></span><span class="ln"></span></div>
      <div class="fnode rule">${t("영향지도<br>게시판", "impact-map<br>board")}</div>
    </div>
    <div class="dirtyhint" id="dirtyHint" style="display:none">${t("● 토글을 바꿨어요 — <b>저장</b>해야 실제로 적용됩니다", "● Toggles changed — press <b>Save</b> to actually apply")}</div>
  </section>

  <details class="card baseline" id="baseDetails" style="margin-top:10px">
    <summary style="cursor:pointer;font-weight:600;font-size:13px">${t("단계별 기본 원칙", "Stage Baselines")} <span class="fixedbadge">${t("고정 기준 · 기본값 내장", "fixed baseline · defaults built-in")}</span> <span class="muted" style="font-weight:400">${t("· 검증 흐름 3단계의 기본값 (필요할 때만 편집)", "· defaults for the 3 verification stages (edit only if needed)")}</span> <span id="baseOv" class="muted" style="font-weight:400"></span></summary>
    <div style="margin:8px 0 0 0;font-size:12px;line-height:1.55;border-left:3px solid var(--vscode-inputValidation-warningBorder,#c90);background:var(--vscode-inputValidation-warningBackground,rgba(204,153,0,0.12));border-radius:6px;padding:9px 12px">${t("⚠ <b>전역 공통값입니다.</b> 위 <b>Claude·Codex 규칙</b>(프로젝트마다 따로 적용)과 달리, 이건 하네스의 기본 동작을 보장하는 <b>전역 기준</b>이라 <b>여기서 고쳐 저장하면 모든 프로젝트에 공통으로 적용</b>됩니다. 평소엔 손댈 필요 없고, 잘못 고쳐도 아래 <b>기본값 복원</b>으로 되돌아갑니다.", "⚠ <b>This is a global value.</b> Unlike the <b>Claude/Codex rules</b> above (per-project), this is the <b>global baseline</b> that guarantees the harness's core behavior — <b>editing and saving here applies to every project</b>. Normally you never need to touch it, and <b>Restore defaults</b> below always brings it back.")}</div>
    <div class="chead" style="margin-top:12px">${t("① 전달 원칙", "① Transmission principles")} <span class="muted" style="font-weight:400">${t("→ Claude에게 · Claude가 Codex에 넘길 때 · 검증 ON일 때만", "→ to Claude · when handing off to Codex · only while verify is ON")}</span></div>
    <textarea id="bTransmit" rows="4"></textarea>
    <div class="chead" style="margin-top:12px">${t("② 검증 기본원칙", "② Verification baseline")} <span class="muted" style="font-weight:400">${t("→ Codex에게 · Codex 검증 때마다", "→ to Codex · on every Codex verification")}</span></div>
    <textarea id="bVerify" rows="5"></textarea>
    <div class="chead" style="margin-top:12px">${t("③ 재판단 원칙", "③ Re-judgment principles")} <span class="muted" style="font-weight:400">${t("→ Claude에게 · Codex 답을 되짚을 때 · 검증 ON일 때만", "→ to Claude · when re-judging Codex's answer · only while verify is ON")}</span></div>
    <textarea id="bRejudge" rows="5"></textarea>
    <div id="bScoutWrap" style="display:none">
      <div class="chead" style="margin-top:12px">${t("④ 정찰 기본 원칙", "④ Scout baseline")} <span class="muted" style="font-weight:400">${t("→ 정찰 AI에게 · 지도를 그리기 직전 · 3트랙일 때만 (기본 정찰·DeepSeek 정찰 공통)", "→ to the scout AI · right before drawing a map · 3-track only (both scouts)")}</span> <span id="bScoutOv" class="muted" style="font-weight:400"></span></div>
      <textarea id="bScout" rows="3"></textarea>
      <div class="muted" style="margin-top:2px">${t("수정하면 이후 지도 기록에 '기본 프롬프트 아님' 서명이 남아요 — 나중에 명중률을 잴 때 기본 프롬프트 지도와 섞이지 않게 구분하는 표시입니다(자동으로 뭘 빼거나 막지는 않아요).", "Editing marks later map records as 'non-default prompt' — a marker so future hit-rate measurements can keep them apart from default-prompt maps (nothing is auto-excluded or blocked).")}</div>
      <div class="chead" style="margin-top:8px">${t("④-형식 계약", "④ Format contract")} <span class="fixedbadge">${t("잠금", "locked")}</span> <span class="muted" style="font-weight:400">${t("· 지도의 ①~⑥ 구획·high 표기는 기계가 그대로 읽는 배선이라 수정 불가 — 내용은 공개", "· the map's ①~⑥ sections and 'high' tags are machine-read wiring — not editable, shown for transparency")}</span></div>
      <div id="bScoutFmt" class="muted" style="white-space:pre-wrap;font-size:11px;border:1px dashed var(--vscode-panel-border);padding:6px;border-radius:4px"></div>
    </div>
    <div class="row"><button id="saveB">${t("단계별 기본 원칙 저장", "Save stage baselines")}</button><button id="resetB" class="secondary">${t("기본값 복원", "Restore defaults")}</button><span id="savedB" class="muted"></span></div>
  </details>
  <h2 class="sec base accent-orange">${t("코덱스 두뇌 설정", "Codex Brain Settings")} <span class="sub2">${t("이 프로젝트에서 코덱스가 쓰는 모델·생각강도 (진행 중 대화에도 적용)", "model & reasoning effort Codex uses in this project (applies to the ongoing session too)")}</span></h2>
  <div class="mcard">
    <div class="muted">${t("지금 쓰는 값(최근 기록):", "Current values (latest record):")} <b id="mCur">—</b></div>
    <div id="mCacheWarn" class="hint" style="display:none;margin:6px 0 0 0"></div>
    <!-- 코덱스 모델/생각강도 어긋남 인라인 경고(#mDrift) 제거: 두뇌 drift는 무결성 채널(상태바/배너+확인) 단일 경로로 일원화. (ack 불가·정책상이 중복 해소) -->
    <div class="mrow"><span class="mlbl">${t("모델", "Model")}</span>
      <select id="mModel" title="${t("이 프로젝트에서 코덱스가 쓸 모델 — 계정에서 받은 목록(없으면 기본값)", "Model Codex uses in this project — list comes from your account (default if empty)")}"></select>
    </div>
    <div class="mrow"><span class="mlbl">${t("생각강도", "Reasoning")}</span>
      <span id="segReason" class="seg"></span>
    </div>
    <div class="row" style="margin-top:10px"><button id="saveModel">${t("두뇌 설정 저장", "Save brain settings")}</button><span id="savedModel" class="muted"></span></div>
    <div class="muted" style="margin-top:6px">${t("선택은 <b>다음 코덱스 응답부터</b> 적용 · 비우면 코덱스 기본값 · 코덱스에 말 걸 때마다 자동으로 다시 실어줌", "Applies from the <b>next Codex response</b> · empty = Codex default · re-sent automatically on every Codex call")}</div>
  </div>
  <!-- Claude Code 두뇌 관리 카드 제거: 앱 /model·/effort가 이미 settings.json에 영속하고 모델별 effort도 정확히 다룬다(카드는 중복·충돌·effort표 부정확이었음). 모델 계열/추론 어긋남은 상태바 drift 경고로 표시(computeState의 syncBrainDrift). -->
  <h2 class="sec base accent-teal">${t("검증 대기시간", "Verify Timeout")} <span class="sub2">${t("코덱스 검증을 기다리는 한도 — 추론이 길면 늘리세요 (전역·모든 프로젝트 공통)", "how long to wait for Codex verification — raise it for long reasoning (global, all projects)")}</span></h2>
  <div class="mcard">
    <div class="mrow"><span class="mlbl">${t("대기시간", "Timeout")}</span>
      <input id="vtMin" type="number" min="1" max="60" step="1" style="width:72px" title="${t("코덱스 검증이 이 시간을 넘기면 실패로 처리합니다. 깊은 추론이 길어지면 늘리세요(1~60분).", "Verification longer than this is treated as failed. Raise it for deep reasoning (1–60 min).")}">
      <span class="muted">${t("분 · 기본 8", "min · default 8")}</span>
    </div>
    <div class="row" style="margin-top:10px"><button id="saveVT">${t("대기시간 저장", "Save timeout")}</button><span id="savedVT" class="muted"></span></div>
    <div class="muted" style="margin-top:6px">${t("코덱스가 답하는 데 이 시간보다 오래 걸리면 검증이 실패로 끝나요. 추론이 8분을 넘는 경우가 있으면 늘려 두세요.", "If Codex takes longer than this, the verification ends as failed. Raise it if reasoning ever exceeds 8 minutes.")}</div>
  </div>
  <h2 class="sec base accent-yellow">${t("Codex 검증 대화", "Codex Verify Conversation")} <span class="sub2">${t("실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인", "the actual exchange — see for yourself that verification really happened")}</span></h2>
  <div id="conv"></div>
  <h2 class="sec base accent-rose">${t("Codex 세션 연결", "Codex Session Link")} <span class="sub2" id="cwsLabel">${t("첫 발화로 식별", "identified by first message")}</span></h2>
  <div id="cands"></div>
  <div id="hiddenWrap"></div>
  </div><!-- /tab-main -->
  <section id="tab-stats" class="tab-panel">
    <h2 class="sec base accent-yellow">${t("검증 통계", "Verify Stats")} <span class="sub2">${t("이 폴더에서 코덱스 검증이 어떻게 흘러왔는지 — 최근 흐름·통과율·막고 풀린 전환", "how Codex verification has gone in this folder — recent flow · pass rate · fail→pass turnarounds")}</span></h2>
    <div id="statsEmpty" class="muted" style="display:none">${t("아직 이 폴더에 검증 기록이 없어요. 검증이 쌓이면 여기에 통계가 보여요.", "No verification records in this folder yet. Stats appear here as verifications accumulate.")}</div>
    <div id="statsBody" class="card" style="display:none">
      <div class="stat-cards">
        <div class="stat-card s-blue"><div class="stat-num" id="st7total">–</div><div class="stat-lbl">${t("최근 7일 검증", "verifications (7d)")}</div></div>
        <div class="stat-card s-green"><div class="stat-num" id="st7pass">–</div><div class="stat-lbl">${t("완전통과율 (7일)", "clean pass rate (7d)")}</div></div>
        <div class="stat-card s-orange"><div class="stat-num" id="st7touch">–</div><div class="stat-lbl">${t("보완이상 비율 (7일)", "notes-or-worse (7d)")}</div></div>
        <div class="stat-card s-purple"><div class="stat-num" id="st7res">–</div><div class="stat-lbl">${t("실패·보류→통과 전환 (7일)", "fail/hold→pass turnarounds (7d)")}</div></div>
      </div>
      <div id="scoutImpact" style="display:none">
        <h3 class="chart-h" style="margin-top:12px">${t("3트랙 기여 — 정찰이 검증에 실제로 보탠 것 (관찰 신호 · 누적)", "3-track contribution — what recon actually fed into verification (observed signals · cumulative)")}</h3>
        <div class="stat-cards">
          <div class="stat-card s-blue"><div class="stat-num" id="siProposed">–</div><div class="stat-lbl">${t("지도가 발견해 기억에 올린 결합", "couplings maps discovered & remembered")}</div></div>
          <div class="stat-card s-orange"><div class="stat-num" id="siAttached">–</div><div class="stat-lbl">${t("다음 지도 자료에 실려 재사용된 횟수", "times re-fed into the next map's material")}</div></div>
          <div class="stat-card s-green"><div class="stat-num" id="siConfirmed">–</div><div class="stat-lbl">${t("검증·사용자가 실제 확인(신뢰 승격 재료)", "actually confirmed by verify/user")}</div></div>
          <div class="stat-card s-purple"><div class="stat-num" id="siGuard">–</div><div class="stat-lbl">${t("틀림 판명(재실수 방지 각주행) · 복권", "judged wrong (mistake guard) · rehabilitated")}</div></div>
        </div>
        <div class="muted" style="font-size:11px">${t("ⓘ 정직 고지: 이건 '2트랙이었다면 놓쳤을 것'의 증명이 아니라, 정찰→검증→기억 루프가 실제로 돌았는지의 관찰 신호예요. '검증 지적이 동봉 지도를 짚었는지' 대조와 '게이트 차단→플랜 수정' 추적은 기록을 새로 심어야 해서 후속입니다.", "ⓘ Honest note: this doesn't prove 'what 2-track would have missed' — it observes whether the recon→verify→memory loop actually ran. Matching verify findings against attached maps, and gate-block→plan-change tracking, need new recording and come later.")}</div>
        <h3 class="chart-h" style="margin-top:12px">${t("정찰(3트랙) 비용 — 최근 28일 표시 (장부는 60일 보존 · 지도 10장 보관과 무관)", "Recon (3-track) cost — last 28 days shown (log kept 60 days · independent of map pruning)")}</h3>
        <div id="scoutCostRows"></div>
        <div class="muted" style="font-size:11px">${t("ⓘ DeepSeek 정찰·연결 점검은 응답이 알려준 실측 토큰(입력/출력)이고, 기본 정찰(Claude)은 쓰시던 구독으로 돌아 별도 결제가 없으며 도구가 토큰 수를 알려주지 않아 자료·지도 '글자 수'만 기록해요(토큰 아님 — 대략 추정용).", "ⓘ The DeepSeek scout & connection checks show real tokens (in/out) from the API response; the default scout (Claude) runs on your existing subscription (no separate billing) and the tool doesn't report tokens, so only character counts of package/map are recorded (not tokens — rough estimation only).")}</div>
      </div>
      <div class="stat-chart">
        <div class="chart-box">
          <h3 class="chart-h">${t("최근 28일 검증 결과 분포", "Verdict distribution (28d)")}</h3>
          <div class="donut-wrap"><svg id="donut" viewBox="0 0 120 120" width="140" height="140" aria-label="${t("검증 결과 분포", "verdict distribution")}"></svg><div id="donutTotal" class="donut-center"></div></div>
        </div>
        <div id="donutLegend" class="legend"></div>
      </div>
      <div class="stat-chart">
        <div class="chart-box wide">
          <h3 class="chart-h">${t("최근 14일 검증 추이", "14-day trend")} <span class="muted">${t("(아래부터 완전통과·통과보완·보류·실패·표지누락 5색, 높이=24시간 구간별 검증량)", "(bottom-up: pass·pass(notes)·hold·fail·no-verdict, height = verifications per 24h window)")}</span></h3>
          <div id="trendBars" class="trend-bars"></div>
        </div>
      </div>
      <div class="stat-chart">
        <div class="chart-box wide">
          <h3 class="chart-h">${t("검증 활동", "Verification activity")} <span class="muted">${t("(최근 4주 · 세로 요일 / 가로 0~23시 · 색이 진할수록 그 시간대 검증이 많음 — 아래 범례)", "(last 4 weeks · rows = weekday, columns = hour 0–23 · darker = more verifications — legend below)")}</span></h3>
          <div id="heat" class="heatmap"></div>
        </div>
      </div>
      <div class="stat-chart">
        <div class="chart-box wide">
          <h3 class="chart-h">${t("연결된 코덱스 세션 토큰", "Linked Codex session tokens")} <span class="muted">${t("(이 검증 대화 세션의 누적 사용량 · 참고)", "(cumulative usage of the linked verify session · reference)")}</span></h3>
          <div id="tokCards" class="stat-cards"></div>
          <p class="muted" id="tokNote"></p>
        </div>
        <div class="chart-box wide">
          <h3 class="chart-h">${t("클로드 작업 토큰", "Claude work tokens")} <span class="muted">${t("(이 폴더 · 최근 28일 · 검증과 별개인 작업 비용)", "(this folder · last 28d · work cost, separate from verification)")}</span></h3>
          <div id="claudeTokCards" class="stat-cards"></div>
          <p class="muted" id="claudeTokNote"></p>
        </div>
      </div>
      <div class="stat-chart">
        <div class="chart-box wide">
          <h3 class="chart-h">${t("모델·추론강도별 검증 토큰", "Verify tokens by model·effort")} <span class="muted">${t("(최근 28일 · 이 검증 1회분 합 · rollout 마지막 턴 기준 근사)", "(28d · per-verification token sums · approx. from last rollout turn)")}</span></h3>
          <div id="byModelBars"></div>
        </div>
        <div class="chart-box wide">
          <h3 class="chart-h">${t("검증모드별", "By verify mode")} <span class="muted">${t("(최근 28일 · 검증을 띄운 모드 플랜/코드/올웨이즈)", "(28d · which mode triggered the verification)")}</span></h3>
          <div id="byModeBars"></div>
        </div>
      </div>
      <div class="stat-chart">
        <div class="chart-box wide">
          <h3 class="chart-h">${t("프로젝트별 검증 비교", "Per-project comparison")} <span class="muted">${t("(최근 28일 · 모든 폴더 · 이 폴더 통계와 별개 · 막대=검증 건수, 완전통과율 병기)", "(28d · all folders · separate from this folder's stats · bar = count, clean-pass % alongside)")}</span></h3>
          <div id="projectBars"></div>
        </div>
      </div>
      <p class="muted" id="statsNote"></p>
    </div>
  </section>
  <section id="tab-adv" class="tab-panel">
    <h2 class="sec base accent-yellow">${t("고급설정", "Advanced Settings")} <span class="sub2">${t("정찰(3트랙) 고급 단계용 — 전역 설정(모든 프로젝트 공통)", "for the advanced recon stage (3-track) — global (shared by all projects)")}</span></h2>
    <div class="card">
      <div class="chead">${t("DeepSeek API 키", "DeepSeek API key")} <span class="muted" style="font-weight:400">${t("· 3트랙의 'DeepSeek 비교 정찰'(두 번째 정찰자)에만 필요 — 키 없이도 변경 감지와 기본 정찰(Claude) 영향지도(별도 과금 없음)는 동작해요", "· only needed for 3-track's DeepSeek comparison scout (the second scout) — change sensing and default-scout (Claude) impact maps (no separate billing) work without it")}</span></div>
      <div class="hint">${t("키는 이 컴퓨터의 브릿지 홈(<code>~/.codex-bridge/deepseek.json</code>)에만 저장되고 저장소(GitHub)에는 절대 들어가지 않아요. 자료 꾸러미 전송은 <b>지도 생성이 실행될 때만</b> 일어나요 — 당신이 직접 실행하거나, <b>키 등록=동의 모델</b>에 따라 3트랙 자동 지시를 받은 Claude가 실행(조건: 지도가 없거나 낡았을 때 그 상태에 1회 지시 — 확장·훅 자체는 전송하지 않음). 그 외 외부 요청은 3트랙을 켤 때의 <b>연결 점검 1회</b>(꾸러미 아님 — 접속 확인용)뿐이에요. 대시보드를 보는 것만으로는 전송 없음. 발동 조건과 전송·제외 내용은 PRIVACY에 명시돼 있어요.", "The key is stored only in this machine's bridge home (<code>~/.codex-bridge/deepseek.json</code>) and never enters the repo (GitHub). The evidence package is sent <b>only when map generation runs</b> — you run it directly, or under the <b>key-registration=consent model</b> Claude runs it on the 3-track auto-directive (issued once per missing/stale-map state — the extension/hooks themselves never transmit). The only other external request is a single <b>connection check</b> when 3-track is switched on (not a package — reachability only). Viewing the dashboard sends nothing. Trigger conditions and what is sent/excluded are documented in PRIVACY.")}</div>
      <div class="row" style="margin-top:8px">
        <input type="password" id="dsKey" placeholder="sk-..." style="flex:1;min-width:220px" autocomplete="off" />
        <button id="dsSave">${t("저장", "Save")}</button>
        <button id="dsClear" class="secondary">${t("키 삭제", "Remove key")}</button>
      </div>
      <div class="hint" id="dsState" style="margin-top:6px"></div>
    </div>
  </section>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // 펼친 Codex 답변 키 모음 — postMessage 재렌더(작업/검증/반영 상태·파일·주기 변화)에도 펼침을 유지한다.
  // 모듈 레벨이라 이 webview가 사는 동안 유지되고, 대시보드를 닫았다 다시 열면 새 webview라 리셋(=기본 접힘).
  const expandedConv = new Set();
  // 펼친 정찰 구역 패널 키 모음(정찰 흐름·최신 지도) — 매 재렌더가 #scoutBox를 통째 재생성해 details 펼침이
  // 저절로 접히던 실버그(사용자 실측 2026-07-08 — 검증 대화에서 고친 것과 같은 부류)의 동형 해법.
  const openPanels = new Set();
  function keyedDetails(key, summaryText){ var det=document.createElement("details"); if(openPanels.has(key)) det.open=true; det.addEventListener("toggle", function(){ if(det.open) openPanels.add(key); else openPanels.delete(key); }); var s=document.createElement("summary"); s.textContent=summaryText; det.appendChild(s); return det; }
  function convKey(t){ var s=(t.user||"")+"|||"+((t.assistant||[]).join("~")); var h=0; for(var i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return "c"+h; }
  const $ = (id) => document.getElementById(id);
  // UI 언어(웹뷰 생성 시 고정 — 전환 시 확장이 HTML을 재생성). 동적 문자열은 T(ko,en)으로 정적 라벨과 같은 언어 유지.
  const UI_EN = ${EN};
  function T(ko, en){ return UI_EN ? en : ko; }
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({type:"refresh"}));
  function el(tag, cls, text){ const e=document.createElement(tag); if(cls)e.className=cls; if(text!=null)e.textContent=text; return e; }
  // 폼에서 고른 값(curVM/curIM, 저장 시 전송) vs 저장돼 실제 적용 중인 값(appVM/appIM, 지도·'지금 받는 것'에 표시).
  // 지도/패널은 "저장된 것"만 보여주고(거짓 미리보기 방지), 저장하는 순간 바뀐 곳을 깜빡인다.
  let curVM = "off", curIM = "always", curSM = "off";
  let appVM = null, appIM = null, appSM = null;
  let appCkC = null, appCkX = null; // 체크박스 '마지막 적용값'(hold 판정용 — 미저장 체크 변경이 언어 전환에 덮이지 않게)
  let curPerm = "";   // 지금 Claude Code 권한 모드(active.json) — plan 게이트 표시용
  let curRS = "";     // 두뇌 설정 폼에서 고른 생각강도("" = 기본). 모델은 입력칸 값 직접 사용.
  let appRS = null, appModel = null;  // 저장돼 적용 중인 두뇌 설정(미저장 편집 보존용 dirty 비교 기준)
  // (Claude 두뇌 카드 관련 webview 변수·헬퍼 제거됨 — 카드 폐기. 어긋남은 상태바 drift 경고로.)
  let AVAIL = [];     // 계정 캐시 모델·모델별 생각강도(서버에서 받은 것 — 하드코딩 아님)
  const RSKO = UI_EN ? {} : {minimal:"최소", low:"낮음", medium:"보통", high:"높음", xhigh:"매우높음", pro:"프로"}; // 표시 라벨(코덱스 카드 전용·없는 값은 원문). Claude 카드는 영문 원값 사용(아래 별도)
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
      else levels=[...levels,{effort:curRS,description:T("저장된 값(현재 목록에 없음)","saved value (not in current list)")}];
    }
    const mk=(rs,label,desc)=>{const b=document.createElement("button");b.setAttribute("data-rs",rs);b.textContent=label;if(desc)b.title=desc;return b;};
    seg.appendChild(mk("",T("기본","default")));
    levels.forEach((l)=> seg.appendChild(mk(l.effort, RSKO[l.effort]||l.effort, l.description)));
    highlightSeg("segReason","data-rs",curRS);
  }
  let shownVM, shownIM, shownPerm, shownSM;   // 마지막으로 그린 상태 — watcher 중복 렌더가 진행 중 깜빡임을 지우지 않게
  function lblIM(im){ return im==="off"?T("꺼짐","off"):im==="plan"?T("플랜 때만","plan only"):T("항상","always"); }
  function lblVM(vm){ return vm==="off"?T("안 함","off"):vm==="code"?T("코드 변경 시","on code change"):vm==="plancode"?T("플랜·코드 시","plan·code"):T("모든 턴","every turn"); }
  function flashNode(n){ if(!n) return; n.classList.remove("flashpulse"); void n.offsetWidth; n.classList.add("flashpulse"); }
  function setStage(node, on, why){ if(!node) return; node.classList.toggle("off", !on); node.classList.toggle("on", on); const m=node.querySelector(".sbmark"); if(m) m.textContent=on?"✓":"✗"; const w=node.querySelector(".sbwhy"); if(w) w.textContent=why; }
  // 저장된 상태(appVM/appIM)로 지도 화살표 + '지금 받는 것'을 그린다. prev와 다른 항목은 깜빡.
  function renderApplied(prevVM, prevIM){
    if(shownVM===appVM && shownIM===appIM && shownPerm===curPerm && shownSM===appSM) return;  // 변화 없으면 DOM 안 건드림 → 진행 중 깜빡임 보존
    shownVM=appVM; shownIM=appIM; shownPerm=curPerm; shownSM=appSM;
    const inj=$("faInject"), ver=$("faVerify");
    if(inj){ inj.className="farrow"+(appIM!=="off"?"":" off"); const v=$("faInjectVal"); if(v) v.textContent=lblIM(appIM); }
    if(ver){ ver.className="farrow"+(appVM!=="off"?"":" off"); const v=$("faVerifyVal"); if(v) v.textContent=lblVM(appVM); }
    // 정찰(3트랙) 둘째 줄 + 상단 히어로 정찰자 카드 — 켜졌을 때만 등장(2트랙=기존 모습 그대로).
    // 검증 흐름과 별개 축이라 별도 줄(일렬이면 '검증 후 정찰' 오독 — 사용자 지적 반영). 라벨은 실행 경로를 정직 표기(직접/자동 지시).
    const son = appSM==="on";
    const sf=$("scoutFlow"); if(sf) sf.style.display = son?"":"none";
    const hs=$("heroScout"); if(hs) hs.style.display = son?"":"none";
    const sv=$("faScoutVal"); if(sv) sv.textContent = son?T("켜짐 · 지도는 직접/자동 지시 실행","on · maps run directly or via auto-directive"):T("꺼짐","off");
    // 검증 토글 직하 단계 패널: 검증 ON이면 ①③ 켜짐, ②는 검증할 때. OFF면 ①③ 꺼짐, ②는 수동 ask 때만.
    const von = appVM!=="off";
    const st=$("sbState"); if(st) st.textContent = von ? lblVM(appVM) : T("꺼짐","off");
    setStage($("sbTransmit"), von, von?T("검증 켜짐 → 적용","verify on → applied"):T("검증 꺼짐 → 안 들어감","verify off → not injected"));
    setStage($("sbVerify"), von, von?T("검증할 때 적용","applied when verifying"):T("자동 검증 없음 (수동 ask 땐 들어감)","no auto verify (still applied on manual ask)"));
    setStage($("sbRejudge"), von, von?T("검증 켜짐 → 적용","verify on → applied"):T("검증 꺼짐 → 안 들어감","verify off → not injected"));
    if(prevIM!=null && prevIM!==appIM){ flashNode(inj); }
    if(prevVM!=null && prevVM!==appVM){ flashNode(ver); flashNode($("sbTransmit")); flashNode($("sbVerify")); flashNode($("sbRejudge")); }
  }
  function highlightSeg(segId, attr, v){ const s=$(segId); if(s) s.querySelectorAll("button").forEach((b)=>b.classList.toggle("on", b.getAttribute(attr)===v)); }
  function markDirty(){ const d=$("dirtyHint"); if(d) d.style.display = ((curVM!==appVM)||(curIM!==appIM)||(curSM!==appSM)) ? "" : "none"; }
  $("segVerify").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-vm]"); if(b){ curVM=b.getAttribute("data-vm"); highlightSeg("segVerify","data-vm",curVM); markDirty(); } });
  $("segScout").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-sm]"); if(b){ curSM=b.getAttribute("data-sm"); highlightSeg("segScout","data-sm",curSM); markDirty(); } });
  $("segInject").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-im]"); if(b){ curIM=b.getAttribute("data-im"); highlightSeg("segInject","data-im",curIM); markDirty(); } });
  $("segReason").addEventListener("click", (ev)=>{ const b=ev.target.closest("[data-rs]"); if(b){ curRS=b.getAttribute("data-rs"); highlightSeg("segReason","data-rs",curRS); } });
  $("mModel").addEventListener("change", ()=> renderReasonButtons($("mModel").value.trim()));  // 모델 바꾸면 그 모델의 생각강도로 버튼 교체(select=change)
  $("saveModel").addEventListener("click", () => {
    pendingSave = {target:"model"};  // 성공 플래시는 saveResult(ok) 받을 때
    vscode.postMessage({type:"saveModelPref", model: $("mModel").value.trim(), reasoning: curRS});
  });
  // (Claude 두뇌 관리 카드 제거됨 — effort 버튼·모델 select 핸들러 삭제. 모델/추론 어긋남은 상태바 drift 경고로.)
  $("saveVT").addEventListener("click", () => {
    let n = parseInt($("vtMin").value, 10);
    if (!Number.isFinite(n)) n = 8;
    n = Math.max(1, Math.min(60, n));  // 1~60분(브릿지와 같은 규칙) — 잘못된 입력은 보정
    $("vtMin").value = n;
    pendingSave = {target:"timeout"};
    vscode.postMessage({type:"saveVerifyTimeout", min: n});
  });
  function flashSaved(node, msg){ if(!node) return; node.textContent = msg || T("저장됨 ✓ (다음 턴부터 적용)","Saved ✓ (applies from next turn)"); node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash"); }
  $("cands").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-relink]");
    if (b) { vscode.postMessage({type:"relink", id:b.getAttribute("data-relink")}); return; }
    const x = ev.target.closest("[data-del]");
    if (x) { vscode.postMessage({type:"hideSession", id:x.getAttribute("data-del")}); return; }
  });
  $("hiddenWrap").addEventListener("click", (ev) => {
    const t = ev.target.closest("#hiddenToggle");
    if (t) { const box=$("hiddenList"); const open=box.style.display==="none"; box.style.display=open?"":"none"; t.textContent = open ? T("숨긴 세션 접기","Hide hidden sessions") : T("숨긴 세션 "+box.children.length+"개 보기", "Show "+box.children.length+" hidden sessions"); return; }
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
  // '화면에 렌더된 언어' 추적 — 저장은 항상 '보던 슬롯'으로 간다(전역 언어가 그 사이 바뀌어도, 이 창이든 다른 창이든).
  // 편집 중(dirty) 언어가 바뀌면 그 카드는 옛 언어 화면 그대로 '동결'(hold)되고, 저장하면 옛(보던) 슬롯에 저장된다
  // → 한국어 편집분이 영어 칸에 저장되는 슬롯 오염 차단(Codex 검증 반례 반영).
  let renderedLangC = null, renderedLangB = null;
  $("saveC").addEventListener("click", () => {
    clearTimeout(pendingScroll);  // 직전 저장의 대기 스크롤 취소
    const toLines = (s) => s.split("\\n").map((x) => x.trim()).filter(Boolean);
    const imCh = curIM!==appIM, vmCh = curVM!==appVM;  // 도안(넣는 시점/검증 모드)에 영향 주는 변경인가 — 성공 시 펄스용
    pendingSave = {target:"contract", imCh, vmCh};
    vscode.postMessage({type:"saveContract", lang: renderedLangC || undefined,
      claude: toLines($("cClaude").value), codex: toLines($("cCodex").value),
      claudeChecklist: $("ckClaude").checked, codexChecklist: $("ckCodex").checked, verifyMode: curVM, claudeInjectMode: curIM, scoutMode: curSM});
    // 성공 플래시·스크롤은 saveResult(ok)에서 (저장 실패 시 거짓 성공 방지)
  });
  $("saveB").addEventListener("click", () => {
    pendingSave = {target:"base"};
    var spVisible = $("bScoutWrap") && $("bScoutWrap").style.display !== "none";
    vscode.postMessage({type:"saveBase", lang: renderedLangB || undefined, verifyBaseline:$("bVerify").value, transmit:$("bTransmit").value, rejudge:$("bRejudge").value, scoutBaseline: (spVisible && $("bScout")) ? $("bScout").value : null});
  });
  $("resetB").addEventListener("click", () => { pendingSave = {target:"base", msg:T("기본값으로 복원됨 ✓","Restored to defaults ✓")}; vscode.postMessage({type:"resetBase", lang: renderedLangB || undefined, scout: !!($("bScoutWrap") && $("bScoutWrap").style.display !== "none")}); });
  // 탭 토글(현황 / 검증 통계) — 클릭한 버튼·패널만 active
  document.querySelectorAll(".tabbtn").forEach(function(b){
    b.addEventListener("click", function(){
      var t = b.getAttribute("data-tab");
      document.querySelectorAll(".tabbtn").forEach(function(x){ x.classList.toggle("active", x===b); });
      document.querySelectorAll(".tab-panel").forEach(function(p){ p.classList.toggle("active", p.id===("tab-"+t)); });
    });
  });
  // 고급설정: DeepSeek 키 저장/삭제 — 원문은 저장 메시지로만 나가고, 표시는 state의 마스킹만.
  $("dsSave").addEventListener("click", ()=>{ const v=$("dsKey").value.trim(); if(!v){ return; } pendingSave={target:"deepseek", msg:T("키 저장됨 ✓","Key saved ✓")}; vscode.postMessage({type:"saveDeepseekKey", key:v}); $("dsKey").value=""; });
  $("dsClear").addEventListener("click", ()=>{ pendingSave={target:"deepseek", msg:T("키 삭제됨 ✓","Key removed ✓")}; vscode.postMessage({type:"saveDeepseekKey", key:""}); $("dsKey").value=""; });
  // 언어 토글(전역 ko/en) — 저장은 확장이 language.json에(모든 창이 파일 watch로 따라옴). 표시는 state로 되돌아와 확정.
  document.querySelectorAll(".langbtn").forEach(function(b){
    b.addEventListener("click", function(){ vscode.postMessage({type:"setLang", lang: b.getAttribute("data-lang")}); });
  });
  // 탭2 통계 렌더 — 빈 기록이면 안내, 아니면 KPI 카드 + 도넛(28일 분포) + 추이 막대(14일·24h 슬롯) + 히트맵(4주 요일×시간)
  function fmtTok(n){ return n>=1000 ? (n/1000).toFixed(1)+"k" : String(n); }
  function modeLabel(m){ if(m==="(unknown)") return T("(미상)","(unknown)"); return (UI_EN ? {off:"off", code:"on code change", plancode:"plan·code", always:"every turn"} : {off:"꺼짐", code:"코드 변경 시", plancode:"플랜·코드 변경", always:"모든 턴"})[m] || m; } // 검증모드 코드→한국어(미상 등은 원본)
  // 모델별·검증모드별 토큰 막대 — 이름이 외부 데이터(rollout 모델명 등)라 createElement/textContent로만 조립(XSS 안전). 길이=토큰÷최대.
  function renderBars(wrapId, obj, labelFn){
    var wrap = $(wrapId); if(!wrap) return;
    while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
    var entries = Object.keys(obj||{}).map(function(k){ return { k:k, count:obj[k].count, tokens:obj[k].tokens }; });
    entries.sort(function(a,b){ var au=a.k.indexOf("(unknown)")>=0?1:0, bu=b.k.indexOf("(unknown)")>=0?1:0; if(au!==bu) return au-bu; return b.tokens-a.tokens || b.count-a.count; }); // (미상)은 맨 아래(설명은 없이 정렬만)
    if(!entries.length){ var d=document.createElement("div"); d.className="muted"; d.textContent=T("아직 기록이 없어요 — 검증이 더 쌓이면 보여요.","No records yet — they appear as verifications accumulate."); wrap.appendChild(d); return; }
    var maxT=1; entries.forEach(function(e){ if(e.tokens>maxT) maxT=e.tokens; });
    entries.forEach(function(e){
      var row=document.createElement("div"); row.className="vrow";
      var lbl=document.createElement("span"); lbl.className="vlbl vlbl-wide"; lbl.title=e.k; var shown=labelFn ? labelFn(e.k) : e.k; if(shown.indexOf("(unknown)")>=0) shown=shown.split("(unknown)").join(T("(미상)","(unknown)")); lbl.textContent=shown;
      var bar=document.createElement("span"); bar.className="vbar";
      var fill=document.createElement("span"); fill.className="vbar-fill";
      if(e.tokens>0){ fill.style.width=Math.round(e.tokens/maxT*100)+"%"; fill.style.minWidth="3px"; fill.style.background="var(--vscode-charts-blue)"; }
      bar.appendChild(fill);
      var num=document.createElement("b"); num.className="vnum vnum-wide"; num.textContent=fmtTok(e.tokens)+" · "+e.count+T("건","");
      row.appendChild(lbl); row.appendChild(bar); row.appendChild(num); wrap.appendChild(row);
    });
  }
  function renderStats(vs){
    if(!vs) return;
    var emptyEl = $("statsEmpty"), bodyEl = $("statsBody");
    if(!emptyEl || !bodyEl) return;
    if(vs.month.total === 0){ emptyEl.style.display="block"; bodyEl.style.display="none"; return; }
    emptyEl.style.display="none"; bodyEl.style.display="block";
    // ② KPI — 통과(보완)을 통과와 분리. 분모 jw = 판정 표지 있는 것만(표지없음 제외)
    var w = vs.week, jw = w.pass + w.passNotes + w.inconclusive + w.fail;
    var pct = function(n,d){ return d>0 ? Math.round(n/d*100)+"%" : "–"; };
    $("st7total").textContent = w.total;
    $("st7pass").textContent = pct(w.pass, jw);                                 // 완전통과율(깨끗한 통과만)
    $("st7touch").textContent = pct(w.passNotes + w.inconclusive + w.fail, jw); // 보완이상 비율(검증이 그냥 통과시키지 않은 비율)
    $("st7res").textContent = vs.resolved7;
    // ③ 도넛(최근 28일, 판정 표지 있는 것만) + 우측 가로막대. 색 계약: 통과=초록/보완=노랑/보류=주황/실패=빨강
    var m = vs.month, R=50, CX=60, CY=60, C=2*Math.PI*R;
    var segs = [
      {n:m.pass, c:"var(--vscode-charts-green)", lbl:T("완전통과","pass")},
      {n:m.passNotes, c:"var(--vscode-charts-yellow,#d7ba7d)", lbl:T("통과(보완)","pass (notes)")},
      {n:m.inconclusive, c:"var(--vscode-charts-orange)", lbl:T("보류","hold")},
      {n:m.fail, c:"var(--vscode-charts-red)", lbl:T("실패","fail")}
    ];
    var judged = m.pass + m.passNotes + m.inconclusive + m.fail; // 도넛 분모 = 표지 있는 것만(표지없음 제외)
    var svg="", off=0;
    if(judged>0){
      segs.forEach(function(s){
        if(s.n<=0) return;
        var frac=s.n/judged;
        if(frac>=0.999){ svg += '<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="none" stroke="'+s.c+'" stroke-width="16"/>'; }
        else { svg += '<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="none" stroke="'+s.c+'" stroke-width="16" stroke-dasharray="'+(frac*C).toFixed(2)+' '+C.toFixed(2)+'" stroke-dashoffset="'+(-off*C).toFixed(2)+'" transform="rotate(-90 '+CX+' '+CY+')"/>'; }
        off += frac;
      });
    } else { svg = '<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="none" stroke="var(--vscode-panel-border)" stroke-width="16"/>'; }
    $("donut").innerHTML = svg;
    $("donutTotal").textContent = judged;
    // 우측 가로막대(범례 겸) — 도넛 좌측 쏠림 해소. 길이 = 전체 판정 대비 비율(도넛과 같은 judged 분모, 상대량 아님). 0건은 색 막대 안 그림.
    var bars = segs.map(function(s){
      var wp = judged>0 ? Math.round(s.n/judged*100) : 0;
      var fill = s.n>0 ? 'width:'+wp+'%;min-width:3px;background:'+s.c : 'width:0';
      var pctTxt = judged>0 ? (s.n>0 && wp===0 ? ' · <1%' : ' · '+wp+'%') : ''; // 1건이 0%로 반올림되면 <1%로 정직 표기
      return '<div class="vrow"><span class="leg-dot" style="background:'+s.c+'"></span><span class="vlbl">'+s.lbl+'</span><span class="vbar"><span class="vbar-fill" style="'+fill+'"></span></span><b class="vnum">'+s.n+pctTxt+'</b></div>';
    }).join("");
    if(m.unparsed>0){ // 표지없음 = 판정표지 누락(형식). 도넛/분모서 빼고 따로 설명
      bars += '<div class="vrow vmiss"><span class="leg-dot" style="background:var(--vscode-descriptionForeground)"></span><span class="vlbl">'+T("판정표지 누락","no verdict line")+'</span><span class="vmiss-note">'+T("코덱스가 답은 했지만 \\'통과/실패\\' 결론 줄을 안 적은 답 — 통과율 계산엔 안 넣어요","Codex answered but wrote no verdict line — excluded from pass-rate math")+'</span><b class="vnum">'+m.unparsed+'</b></div>'; }
    $("donutLegend").innerHTML = bars;
    // ④ 추이 막대 — 최근 14일, verdict 5색 세분 스택(아래부터 통과→보완→보류→실패→표지없음). 값은 전부 숫자·내부 상수라 innerHTML 안전
    var d14 = vs.daily14, maxd = 1;
    d14.forEach(function(b){ if(b.total>maxd) maxd=b.total; });
    var sc = [["pass","var(--vscode-charts-green)"],["passNotes","var(--vscode-charts-yellow,#d7ba7d)"],["inconclusive","var(--vscode-charts-orange)"],["fail","var(--vscode-charts-red)"],["unparsed","var(--vscode-descriptionForeground)"]];
    $("trendBars").innerHTML = d14.map(function(b,i){
      var ago=13-i, lbl=ago===0?T("최근","now"):(ago+"d");
      var tt=ago===0?T("최근 24시간","last 24h"):(ago+T("일 전 24시간 구간","d ago, 24h window"));
      var stack = sc.map(function(x){ var h=b[x[0]]?(b[x[0]]/maxd*100):0; return h>0?'<div class="tseg" style="height:'+h.toFixed(1)+'%;background:'+x[1]+'"></div>':""; }).reverse().join("");
      return '<div class="tbar" title="'+tt+T(' · 검증 '+b.total+'건(통과 '+b.pass+'/보완 '+b.passNotes+'/보류 '+b.inconclusive+'/실패 '+b.fail+'/표지없음 '+b.unparsed+')', ' · '+b.total+' verifications (pass '+b.pass+'/notes '+b.passNotes+'/hold '+b.inconclusive+'/fail '+b.fail+'/no-verdict '+b.unparsed+')')+'">'+
        '<div class="tbar-stack">'+stack+'</div><div class="tbar-lbl">'+(ago%2===0?lbl:"")+'</div></div>';
    }).join("");
    // ⑤ 히트맵 — 시간 헤더(0~23, 6시간마다 숫자) + 요일×시간 농도
    var hm = vs.heatmap, maxh=1;
    hm.forEach(function(r){ r.forEach(function(v){ if(v>maxh) maxh=v; }); });
    var days=UI_EN?["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]:["월","화","수","목","금","토","일"];
    // 적음→많음 5단계 색(0=없음, 1~4=비율 구간). usage-monitor식 농도 단계 + 범례로 '뭐가 많은지' 명확히.
    var heatColors=['var(--vscode-editorWidget-background)','color-mix(in srgb,var(--vscode-charts-blue) 22%,var(--vscode-editor-background))','color-mix(in srgb,var(--vscode-charts-blue) 45%,var(--vscode-editor-background))','color-mix(in srgb,var(--vscode-charts-blue) 68%,var(--vscode-editor-background))','color-mix(in srgb,var(--vscode-charts-blue) 92%,var(--vscode-editor-background))'];
    function heatLv(v){ if(v<=0) return 0; var r=v/maxh; return r<=0.25?1:(r<=0.5?2:(r<=0.75?3:4)); }
    var head='<div class="heat-row heat-head"><span class="heat-day"></span>';
    for(var hh=0; hh<24; hh++){ head += '<span class="heat-hh">'+(hh%6===0?hh+T("시",""):"")+'</span>'; }
    head += '</div>';
    var hhtml=head;
    for(var dd=0; dd<7; dd++){
      hhtml += '<div class="heat-row"><span class="heat-day">'+days[dd]+'</span>';
      for(var hx=0; hx<24; hx++){
        var v=hm[dd][hx];
        hhtml += '<span class="heat-cell" style="background:'+heatColors[heatLv(v)]+'" title="'+T(days[dd]+'요일 '+hx+'시 · '+v+'건', days[dd]+' '+hx+':00 · '+v)+'"></span>';
      }
      hhtml += '</div>';
    }
    var leg='<div class="heat-legend"><span class="hl-t">'+T("적음","less")+'</span>';
    for(var li=0; li<5; li++){ leg += '<span class="hl" style="background:'+heatColors[li]+'"></span>'; }
    leg += '<span class="hl-t">'+T("많음","more")+'</span></div>';
    $("heat").innerHTML = hhtml + leg;
    $("statsNote").textContent = T("완전통과=깨끗이 통과 · 통과(보완)=통과지만 보완의견(재판단 적용 잦음) · 보류=판단 보류 · 실패=수정 필요 · 판정표지 누락=코덱스가 답은 했지만 '통과/실패' 결론 줄을 안 적은 경우(통과율 계산에선 빼요). 보완이상 비율=검증이 그냥 통과시키지 않은 비율. 도넛·가로막대=28일, 막대=14일, 히트맵=4주.", "pass = clean pass · pass (notes) = passed with supplements (often re-judged) · hold = no conclusion · fail = fix required · no verdict line = Codex answered without a verdict line (excluded from pass rate). notes-or-worse = share not passed cleanly. Donut/bars = 28d, trend = 14d, heatmap = 4 weeks.");
    renderBars("byModelBars", vs.byModel); // 모델별 28일 토큰(외부 모델명 textContent 안전)
    renderBars("byModeBars", vs.byMode, modeLabel); // 검증모드별 28일 토큰(모드 코드→한국어 라벨)
  }
  // 토큰 카드 — 연결 코덱스 세션 누적(외부 데이터가 들어와도 안전하게 createElement/textContent로만 조립)
  function renderTokens(tk){
    var wrap = $("tokCards"), note = $("tokNote");
    if(!wrap) return;
    while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
    if(!tk || !tk.total){ if(note) note.textContent = T("연결된 코덱스 세션이 없거나 토큰 기록을 아직 못 읽었어요.","No linked Codex session, or token records could not be read yet."); return; }
    var fmt = function(n){ return n>=1000 ? (n/1000).toFixed(1)+"k" : String(n); };
    [[T("총 토큰","total"),tk.total,"s-blue"],[T("입력","input"),tk.input,"s-green"],[T("출력","output"),tk.output,"s-orange"],[T("캐시 입력(재사용)","cached input (reused)"),tk.cachedInput,"s-purple"]].forEach(function(c){
      var card=document.createElement("div"); card.className="stat-card "+c[2];
      var num=document.createElement("div"); num.className="stat-num"; num.textContent=fmt(c[1]);
      var lbl=document.createElement("div"); lbl.className="stat-lbl"; lbl.textContent=c[0];
      card.appendChild(num); card.appendChild(lbl); wrap.appendChild(card);
    });
    if(note) note.textContent = T("이 폴더에 연결된 코덱스 세션이 지금까지 쓴 누적 토큰. 그 세션이 여러 폴더를 오갔다면 합산값이에요. '입력'에는 캐시 재사용분이 포함돼요(별도 카드는 그중 캐시 몫).","Cumulative tokens used by the Codex session linked to this folder. If the session moved across folders, this is the combined total. 'input' includes cached reuse (the separate card shows the cached share of it).");
  }
  // 클로드 작업 토큰 — 이 폴더 28일(코덱스 검증 비용과 분리). 숫자만이라 안전하나 토큰 패턴 통일로 createElement/textContent.
  // 캐시 읽기/생성을 카드로 노출 — '총 토큰' 대부분이 캐시 재사용이라, 안 보이면 총량이 비정상으로 커 보인다(실측 사용자 오해).
  function renderClaudeTokens(ct){
    var wrap = $("claudeTokCards"), note = $("claudeTokNote"); if(!wrap) return;
    while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
    if(!ct || !ct.total){ var d=document.createElement("div"); d.className="muted"; d.textContent=T("이 폴더의 최근 28일 클로드 토큰 기록이 없어요.","No Claude token records for this folder in the last 28 days."); wrap.appendChild(d); if(note) note.textContent=""; return; }
    [[T("사용자 턴수","user turns"),ct.turns,"s-blue",true],[T("총 토큰","total"),ct.total,"s-green",false],[T("입력","input"),ct.input,"s-orange",false],[T("출력","output"),ct.output,"s-purple",false],[T("캐시 읽기(재사용)","cache read (reused)"),ct.cacheRead,"s-blue",false],[T("캐시 생성","cache write"),ct.cacheCreate,"s-green",false]].forEach(function(c){
      var card=document.createElement("div"); card.className="stat-card "+c[2];
      var num=document.createElement("div"); num.className="stat-num"; num.textContent=c[3]?String(c[1]):fmtTok(c[1]); // 턴수는 그대로, 토큰은 k 단위
      var lbl=document.createElement("div"); lbl.className="stat-lbl"; lbl.textContent=c[0];
      card.appendChild(num); card.appendChild(lbl); wrap.appendChild(card);
    });
    if(note) note.textContent = T("턴수는 사용자가 보낸 질문 수예요(도구 왕복·시스템 줄은 안 셈). 총 토큰 = 입력+출력+캐시 — 대부분은 매 응답마다 이전 맥락을 다시 읽는 '캐시 읽기'라 실제 비용 체감보다 커 보여요(캐시는 단가가 훨씬 낮음).","Turns = questions you sent (tool round-trips and system lines are not counted). Total = input + output + cache — mostly 'cache read' (prior context re-read on every response), so it looks larger than the felt cost (cached tokens are much cheaper).");
  }
  // 프로젝트별 비교(3c) — 폴더명(basename)·검증건수 막대·완전통과율 병기. 폴더명은 외부 데이터라 textContent.
  function renderProjects(ps){
    var wrap = $("projectBars"); if(!wrap) return;
    while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
    var rows = Object.keys(ps||{}).map(function(k){ var p=ps[k]; var judged=p.pass+p.passNotes+p.inconclusive+p.fail; return { k:k, count:p.count, judged:judged, passRate: judged? Math.round(p.pass/judged*100):0 }; });
    rows.sort(function(a,b){ return b.count-a.count; });
    if(!rows.length){ var d=document.createElement("div"); d.className="muted"; d.textContent=T("아직 검증 기록이 없어요.","No verification records yet."); wrap.appendChild(d); return; }
    var maxC=1; rows.forEach(function(r){ if(r.count>maxC) maxC=r.count; });
    rows.forEach(function(r){
      var name = String(r.k).replace(/\\\\/g, "/").split("/").filter(Boolean).pop() || r.k; if(name==="(unknown)") name=T("(미상)","(unknown)"); // backslash(Windows)도 slash로 바꿔 폴더명만
      var row=document.createElement("div"); row.className="vrow";
      var lbl=document.createElement("span"); lbl.className="vlbl vlbl-wide"; lbl.title=r.k; lbl.textContent=name;
      var bar=document.createElement("span"); bar.className="vbar";
      var fill=document.createElement("span"); fill.className="vbar-fill"; if(r.count>0){ fill.style.width=Math.round(r.count/maxC*100)+"%"; fill.style.minWidth="3px"; fill.style.background="var(--vscode-charts-green)"; }
      bar.appendChild(fill);
      var num=document.createElement("b"); num.className="vnum vnum-wide"; num.textContent=T(r.count+"건 · 완전통과 "+(r.judged? r.passRate+"%":"–"), r.count+" · clean pass "+(r.judged? r.passRate+"%":"–")); // 판정표지 있는 게 없으면 비율 대신 –
      row.appendChild(lbl); row.appendChild(bar); row.appendChild(num); wrap.appendChild(row);
    });
  }
  // 기본 원칙 편집 '시작'(필드 첫 포커스) 시점 경고 — 필드별 다른 메시지(전달/재판단 vs 검증 기본원칙).
  // ⚠️ textarea 포커스는 절대 안 건드린다: blur()/재focus() 없음. 모달(modal:true)이 편집을 막고 포커스는 자연스럽게 유지되므로,
  // render의 '포커스 중이면 저장값으로 안 덮어씀' 가드(아래)와 충돌하지 않는다 → 편집/저장 보존(0.1.23 blur 버그의 교훈).
  var baseWarned = {}, baseWarnPending = false, baseDirty = {}, contractDirty = {};
  [["bTransmit","transmit"],["bVerify","verify"],["bRejudge","rejudge"],["bScout","scout"]].forEach(function(pr){
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
  var lastDataAt = 0;
  var safeTop = function(fn){ try{ fn(); }catch(e){} };
  // 45초(15초 폴의 3배) 동안 push가 없으면 '갱신 끊김' 배지 — 낡은 화면이 실값처럼 보이는 것을 차단(양 감사 합의).
  setInterval(function(){ safeTop(function(){
    if (!lastDataAt || Date.now() - lastDataAt < 45000) return;
    var fn=$("freshNote"); if(!fn) return;
    fn.style.color="var(--vscode-errorForeground)";
    fn.textContent = T("⚠ 갱신 끊김(45초+) — 이 화면은 낡았을 수 있어요. 창을 닫고 상태바에서 다시 여세요.","⚠ Updates stopped (45s+) — this view may be stale. Close this tab and reopen from the status bar.");
  }); }, 10000);
  // ready 핸드셰이크(양 감사 합의 2026-07-10): 리스너 '등록 직전' 위치라 등록 직후 첫 매크로태스크에서 전송 —
  // 부팅 refresh(스크립트 꼬리)는 상부 런타임 예외와 함께 죽지만, 이 지점은 스크립트 앞부분이라 생존성이 높다.
  setTimeout(function(){ try { vscode.postMessage({type:"ready"}); } catch(e){} }, 0);
  window.addEventListener("message", (ev) => {
    if (ev.data?.type === "baseEditWarnResult") {
      baseWarnPending = false;
      if (ev.data.ok) baseWarned[ev.data.field] = true; // 승인 → 그 필드 재경고 안 함. 포커스/편집값 안 건드림
      return; // 취소면 baseWarned 안 세팅(다음 포커스에 재경고). 포커스/편집값 안 건드림
    }
    if (ev.data?.type === "switchTab" && ev.data.tab) {
      // 확장 → 웹뷰 탭 전환(예: 3트랙 경고의 '등록하러 가기' → 고급설정) — 기존 탭 버튼 클릭과 동일 경로 재사용
      safe(function(){ const btn=document.querySelector('.tabbtn[data-tab="'+ev.data.tab+'"]'); if(btn) btn.click(); });
      return;
    }
    if (ev.data?.type === "saveResult") {
      // 저장 성공 피드백은 '확장이 실제 저장에 성공했다고 알려줄 때'만 — 클릭 즉시가 아니라(거짓 성공 방지).
      const ps = pendingSave; pendingSave = null;
      if (!ev.data.ok) return; // 실패: 네이티브 에러 토스트가 알린다. 성공 플래시·스크롤은 하지 않음.
      if (ev.data.target === "base") baseDirty = {}; // 저장 성공 → dirty 해제(저장값=표시값이 됐으니 render 동기화 재개)
      else if (ev.data.target === "contract") contractDirty = {};
      if (ev.data.target === "deepseek") flashSaved($("dsState"), ps && ps.msg);
      else if (ev.data.target === "model") flashSaved($("savedModel"), T("저장됨 ✓ (다음 코덱스 응답부터 적용)","Saved ✓ (from next Codex response)"));
      else if (ev.data.target === "timeout") flashSaved($("savedVT"), T("저장됨 ✓ (다음 검증부터 적용)","Saved ✓ (from next verification)"));
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
    // 신선도 스탬프(양 감사 합의 2026-07-10) — '마지막 갱신'을 상시 표시해 침묵 실패(낡은 화면)를 즉시 가시화.
    safeTop(function(){ lastDataAt = Date.now(); var fn=$("freshNote"); if(fn){ fn.style.color=""; fn.textContent = T("마지막 갱신 ","last update ") + new Date(d.postedAt || Date.now()).toLocaleTimeString(); } });
    // 구획 격리(safe): 렌더 구획 하나가 특정 데이터 형상에서 예외를 던져도 아래 구획(특히 연결·대화)이 계속
    // 갱신되게 한다 — '한 구획 예외 → 이후 전 구획 영구 미갱신'이 복원 탭 낡음의 유력 경로(3요원 조사 합의).
    const safe=(fn)=>{ try{ fn(); }catch(e){ /* 구획 실패는 그 구획만 — 다음 push에서 재시도됨 */ } };
    safe(()=>renderStats(d.verifyStats));          // 탭2 검증 통계 갱신(현황 탭과 같은 data 푸시에 함께 반영)
    safe(function(){ // 3트랙 기여(관찰 신호) — 일지 이벤트 합계(2026-07-09 사용자 요청 · §6-10 (b) 즉시분)
      const el=$("scoutImpact"); if(!el) return;
      const im=d.mapLedger && d.mapLedger.impact;
      const on = !!(d.contract && d.contract.scoutMode === "on");
      el.style.display = (on && im) ? "" : "none";
      if(!on || !im) return;
      $("siProposed").textContent=String(im.proposed);
      $("siAttached").textContent=String(im.attached);
      $("siConfirmed").textContent=String(im.confirmed);
      $("siGuard").textContent=String(im.disputedEv)+" · "+String(im.rehabilitated);
      // 정찰 비용 행(28일 · 정찰 방식별) — 사용자 비용 추정용(2026-07-09). fmtTok는 renderStats 내부라 여기선 천단위 구분만.
      const rows=$("scoutCostRows"); if(!rows) return;
      while(rows.firstChild) rows.removeChild(rows.firstChild);
      const sc=d.scoutCosts && d.scoutCosts.byArm ? d.scoutCosts.byArm : {};
      const nf=function(n){ return Number(n||0).toLocaleString(); };
      const addRow=function(label,val){ const r=document.createElement("div"); r.className="muted"; r.style.margin="2px 0"; r.textContent=label+" — "+val; rows.appendChild(r); };
      const ds=sc["deepseek"];
      addRow(T("DeepSeek 지도","DeepSeek maps"), ds ? T(ds.count+"건 · 입력 "+nf(ds.usageIn)+" tok · 출력 "+nf(ds.usageOut)+" tok", ds.count+" run(s) · in "+nf(ds.usageIn)+" tok · out "+nf(ds.usageOut)+" tok") : T("0건","0 runs"));
      const pg=sc["ping"];
      addRow(T("연결 점검(3트랙 켤 때 1회·전역)","Connection checks (once per 3-track enable · global)"), pg ? T(pg.count+"건 · 입력 "+nf(pg.usageIn)+" tok · 출력 "+nf(pg.usageOut)+" tok", pg.count+" check(s) · in "+nf(pg.usageIn)+" tok · out "+nf(pg.usageOut)+" tok") : T("0건","0 checks"));
      const sf=sc["self"];
      addRow(T("기본 정찰(Claude) 지도 — 별도 결제 없음","Default-scout (Claude) maps — no separate billing"), sf ? T(sf.count+"건 · 자료 "+nf(sf.pkgChars)+"자 · 지도 "+nf(sf.mapChars)+"자(토큰 아님)", sf.count+" run(s) · package "+nf(sf.pkgChars)+" chars · map "+nf(sf.mapChars)+" chars (not tokens)") : T("0건","0 runs"));
    });
    safe(()=>renderTokens(d.codexTokens));         // 토큰 카드 갱신(연결 코덱스 세션 누적)
    safe(()=>renderClaudeTokens(d.claudeTokens));  // 클로드 작업 토큰+턴수(이 폴더 28일)
    safe(()=>renderProjects(d.projectStats));      // 프로젝트별 비교(전체 폴더 28일)
    curPerm = d.permissionMode || "";   // renderApplied의 plan 게이트 표시에 사용
    // 언어 토글 표시(전역 ko/en) + '반대 슬롯에만 규칙 있음' 안내(언어 바꿨더니 규칙 사라졌다는 오해 방지)
    if (d.lang){
      var lk=$("langKo"), le=$("langEn");
      if (lk && le){ lk.classList.toggle("on", d.lang==="ko"); le.classList.toggle("on", d.lang==="en"); }
      var sn=$("slotNote");
      if (sn){
        if (d.otherSlotRules){
          sn.style.display="block";
          sn.textContent = d.lang==="en"
            ? "This project has rules saved in the Korean slot only — the English slot is empty (nothing was lost; switch back to 한국어 to see them)."
            : "이 프로젝트엔 English 슬롯에만 규칙이 있어요 — 한국어 슬롯은 비어 있습니다(사라진 게 아니에요. English로 바꾸면 보입니다).";
        } else sn.style.display="none";
      }
    }
    // 언어 전환 hold: 계약 카드가 편집 중(dirty·포커스)인데 렌더 언어와 전역 언어가 갈리면, 카드 갱신을 통째로
    // 멈춰 '보던 슬롯' 화면을 유지한다(부분 갱신으로 ko 편집분+en 저장값이 섞여 저장되는 혼합 오염 방지).
    // 저장하면 renderedLangC(보던 슬롯)로 저장되고, state 왕복 후 dirty가 풀리며 새 언어 슬롯으로 자연 전환.
    const langChangedC = renderedLangC !== null && d.lang && d.lang !== renderedLangC;
    // '카드에 저장 안 한 변경'은 textarea(dirty·포커스)만이 아니라 세그(curVM/curIM≠app*)·체크박스(appCk*와 다름)도 포함
    // — 세그만 바꾸고 언어 전환→저장 시 en 슬롯에 ko 화면의 모드가 저장되는 잔여 오염 차단(Codex 검증 반례 반영).
    const segDirtyC = (appVM!==null && curVM!==appVM) || (appIM!==null && curIM!==appIM) || (appSM!==null && curSM!==appSM);
    const ckDirtyC = (appCkC!==null && $("ckClaude").checked!==appCkC) || (appCkX!==null && $("ckCodex").checked!==appCkX);
    const holdC = langChangedC && (contractDirty.claude || contractDirty.codex || segDirtyC || ckDirtyC ||
      document.activeElement === $("cClaude") || document.activeElement === $("cCodex"));
    safe(function(){
    if (d.contract && !holdC){
      if (d.lang) renderedLangC = d.lang; // 이 푸시로 카드가 이 언어 슬롯 값으로 렌더됨
      if (document.activeElement !== $("cClaude") && !contractDirty.claude) $("cClaude").value = (d.contract.claude||[]).join("\\n");
      if (document.activeElement !== $("cCodex") && !contractDirty.codex) $("cCodex").value = (d.contract.codex||[]).join("\\n");
      $("ckClaude").checked = d.contract.claudeChecklist !== false;
      $("ckCodex").checked = d.contract.codexChecklist !== false;
      appCkC = $("ckClaude").checked; appCkX = $("ckCodex").checked; // 체크박스 '마지막 적용값'(appVM 패턴) — hold 판정 기준
      const first = (appVM===null);
      const pVM=appVM, pIM=appIM, pSM=appSM;
      appVM = d.contract.verifyMode || "off";
      appIM = d.contract.claudeInjectMode || "always";
      appSM = d.contract.scoutMode || "off";
      // 사용자가 저장 안 한 토글 변경을 들고 있으면(dirty) 폼 선택을 보존, 아니면 저장값으로 동기화.
      const dirty = !first && ((curVM!==pVM)||(curIM!==pIM)||(curSM!==pSM));
      if(first || !dirty){ curVM=appVM; curIM=appIM; curSM=appSM; highlightSeg("segVerify","data-vm",curVM); highlightSeg("segInject","data-im",curIM); highlightSeg("segScout","data-sm",curSM); }
      renderApplied(first?undefined:pVM, first?undefined:pIM);  // 저장/변경 반영 후 바뀐 축을 깜빡(첫 렌더는 깜빡 없음)
      markDirty();
    }
    });
    // ④ 플랜 라이브표시: 지금 플랜 모드인가(active.json permissionMode)
    const pn = $("planNow");
    if (pn){
      // 배지는 '넣는 시점=플랜 모드'(저장값)일 때만 표시. 텍스트는 지금 Claude Code가 플랜 모드인지 여부만 알림.
      // hold 중엔 새 언어 슬롯 값 대신 화면 기준(appIM)으로 — 카드 동결과 파생 표시의 일관 유지(Codex 보완 반영).
      if((holdC ? appIM : (d.contract && d.contract.claudeInjectMode))==="plan"){
        pn.style.display="";
        pn.textContent = d.permissionMode==="plan" ? T("지금 플랜 모드예요 ✓","Plan mode is on now ✓") : T("지금은 플랜 모드 아니에요","Not in plan mode right now");
      } else { pn.style.display="none"; }
    }
    // ⑤ 범위 장부 카드(3트랙 advisory) — 저장값 기준 표시. '데이터 없음/비-git/변경 없음'을 추측 없이 정직 표기(필수 안전장치).
    safe(function(){
      const box=$("scoutBox"); if(!box) return;
      const on = (holdC ? appSM : (d.contract && d.contract.scoutMode)) === "on";
      // 세그먼트 바로 아래 DeepSeek 연결 줄(사용자 요청) — 키 등록 여부 + '실제로 동작했다'는 증거(마지막 DeepSeek 정찰 성공 기록).
      // 확장이 직접 신호를 쏘지 않는 원칙 유지 — 표시 근거는 게시판 메타(그 시점 통신 성공의 증거)뿐.
      (function(){
        const api=$("scoutApiLine"); if(!api) return;
        if(!on){ api.style.display="none"; return; }
        api.style.display="";
        if(d.deepseek && d.deepseek.hasKey){
          const ds=((d.scoutMaps&&d.scoutMaps.items)||[]).find(x=>x&&x.arm==="deepseek"&&x.ts);
          api.textContent=T("DeepSeek 비교 정찰: 키 등록됨("+d.deepseek.masked+")","DeepSeek comparison scout: key registered ("+d.deepseek.masked+")")
            + (ds? T(" · 마지막 성공 통신 "+new Date(ds.ts).toLocaleString()," · last successful call "+new Date(ds.ts).toLocaleString())
                 : T(" · 이 프로젝트에선 아직 실행 기록 없음"," · no runs recorded in this project yet"));
        } else {
          api.textContent=T("DeepSeek 비교 정찰: 키 없음 — 변경 감지와 기본 정찰(Claude) 지도(별도 과금 없음)만 동작해요(⚙️ 고급설정에서 등록 가능).","DeepSeek comparison scout: no key — change sensing & default-scout maps (no separate billing) only (register in ⚙️ Advanced).");
        }
        // 비-git 폴더면 기준을 명시(아래 상태 요약과 일관): 통계만 불가, 지도는 무이력 모드로 가능.
        if(d.scope && d.scope.note==="no-git") api.textContent += T(" ※ 이 폴더는 변경 기록(버전 관리)이 없어 '같이 바뀌던 파일' 힌트만 불가 — 지도는 최근 수정 기준으로 가능해요."," ※ This folder has no change history (version control), so only 'changed-together' hints are unavailable — maps still work from recent edits.");
      })();
      if(!on){ box.style.display="none"; return; }
      box.style.display="";
      while(box.firstChild) box.removeChild(box.firstChild);
      const add=(txt,cls)=>{const el=document.createElement("div"); el.className=cls||"sbrow"; el.textContent=txt; box.appendChild(el); return el;};
      // ── 정찰 한눈 도해(항상 노출 — 2026-07-08 사용자 지적: 좋은 시각물이 접혀 있고 텍스트 벽이 첫 화면을 점령) ──
      // 위쪽 검증 파이프라인 도해와 같은 시각 문법: 색 박스+화살표. 텍스트 상세는 전부 아래 접힘으로 강등.
      safe(function(){
        const sm=d.scoutMaps, ml=d.mapLedger, c=ml&&ml.counts;
        const flow=document.createElement("div"); flow.className="rflow";
        const node=(color,icon,name,badge,line,tip)=>{const n=document.createElement("div"); n.className="rnode"; n.style.borderColor=color; if(tip){n.title=tip; n.style.cursor="help";}
          const t1=document.createElement("b"); t1.textContent=icon+" "+name; t1.style.color=color;
          const b=document.createElement("span"); b.className="rbdg"; b.textContent=badge; b.style.borderColor=color; b.style.color=color;
          const t2=document.createElement("div"); t2.className="rmini"; t2.textContent=line;
          n.appendChild(t1); n.appendChild(b); n.appendChild(t2); flow.appendChild(n); return n;};
        const arw=(label)=>{const a=document.createElement("div"); a.className="rarw"; a.textContent=label+" →"; flow.appendChild(a);};
        node("#3ca89a","⚙",T("변경 감지","Sensing"),T("자동 · AI 없음","auto · no AI"),T("고치는 파일을 지켜봄","watches what you edit"));
        arw(T("파일이 바뀌면","files change"));
        node("#9a6cdc","⚡",T("영향지도","Impact map"),T("AI 1회","1 AI call"),(sm&&sm.count?T("지도 "+sm.count+"장","maps: "+sm.count):T("어디까지 번질지 보고서","'how far it reaches' report")));
        arw(T("검증을 지나며","through verify"));
        node("#3ca89a","⚙",T("관찰 일지","Journal"),T("자동 누적","auto-accrues"),(c&&(c.trusted+c.reference+c.disputed)>0?T("신뢰 "+c.trusted+"·미검증 "+c.reference+"·틀림 "+c.disputed,"✔"+c.trusted+"·?"+c.reference+"·✖"+c.disputed):T("맞은 예측이 지식으로","right predictions become knowledge")));
        arw(T("원할 때만","when you want"));
        node("#d9a441","👤",T("확정 교범","Manual"),T("선택","optional"),(ml&&ml.mapExists?T("도장 "+(ml.mapApproved||0)+"건","stamped: "+(ml.mapApproved||0)):T("도장 찍은 것만 문서로","stamped items → repo doc")),T("확실해진 지식에 도장을 찍어 저장소 문서로 박제 — 팀·다른 PC와 공유되고, 다음 정찰이 확정 사실로 참고. 자동 주입 아님(누른 항목만 1회). 상세는 아래 관찰 일지 카드의 📕 설명","Stamp settled knowledge into a repo doc — shared with teammates/other PCs and treated as fact by future recon. Not auto-injection (only what you click, once). See 📕 in the journal card"));
        box.appendChild(flow);
        // 수명주기 한 줄 — 지식이 언제 신설/승격/교체/폐기되는지(커뮤니티 질문 1: '언제 뭘 반영하나')
        const life=document.createElement("div"); life.className="rlife";
        [["✚",T("신설","new"),T("정찰이 발견하면","scout finds it")],["✔",T("승격","promote"),T("검증이 맞다고 확인하면","verify confirms it")],["↷",T("교체","replace"),T("새 발견이 옛것을 대신하면","newer finding supersedes")],["✖",T("폐기","retire"),T("틀렸다고 판명/차단하면","disputed or banned")]].forEach(function(p){
          const ch=document.createElement("span"); ch.className="rlchip"; ch.textContent=p[0]+" "+p[1];
          ch.title=p[2]; ch.setAttribute("aria-label", p[1]+": "+p[2]); life.appendChild(ch); // title은 hover 한정 — aria-label 병기(접근성 보완)
        });
        const lt=document.createElement("span"); lt.className="muted"; lt.style.fontSize="10.5px";
        lt.textContent=T("— 전부 자동 · 사람 개입(고정/차단/도장)은 선택","— all automatic · human touch (pin/ban/stamp) optional");
        life.appendChild(lt); box.appendChild(life);
        // API 한눈 비교(커뮤니티 질문 2: 'DeepSeek 없인 못 쓰나?') — 두 박스, 답이 첫 줄에.
        const api=document.createElement("div"); api.className="rapi";
        const apiBox=(color,head,lines)=>{const bx=document.createElement("div"); bx.className="rapibox"; bx.style.borderColor=color;
          const h=document.createElement("b"); h.textContent=head; h.style.color=color; bx.appendChild(h);
          lines.forEach(function(s){const dv=document.createElement("div"); dv.className="rmini"; dv.textContent=s; bx.appendChild(dv);});
          api.appendChild(bx); return bx;};
        apiBox("#3ca89a",
          T("지금 이대로(키 없음) = 기본 흐름 전부 동작","As-is (no key) = the entire default flow works"),
          [T("정찰 AI = 쓰시던 Claude가 겸임(별도 결제 없음)","scout AI = your existing Claude (no separate billing)"),
           T("지도·일지·교범·자동 승격 전부 이 상태로 됩니다","maps, journal, manual, auto-promotion — all included")]);
        apiBox("#9a6cdc",
          T("DeepSeek 키를 넣으면(선택) = 정찰만 분업","Add a DeepSeek key (optional) = split the scouting"),
          [T("정찰을 다른 AI에게 맡겨 관점 비교·Claude 사용량 절약","a second AI scouts — perspective compare · saves Claude usage"),
           d.deepseek&&d.deepseek.hasKey?T("현재: 등록됨 — 비교 정찰 사용 가능","now: registered — comparison scout ready"):T("실측(2026-07)에선 기본(Claude)이 더 정확했어요 — 필수 아님","in our 2026-07 test the default (Claude) was more accurate — not required")]);
        box.appendChild(api);
      });
      // (2026-07-09 사용자 지시) '정찰 흐름 펼쳐보기' 접힘 그룹 폐기 — 위 한눈 도해와 내용 중복.
      // 살릴 것만 밖으로: ①환경 안내 1줄(옛 '성격 프로필'을 사람 말로 재작성) ②LLM 필수성 정직 고지(짧게)
      // ③'정찰 구조 자세히 보기' 버튼을 주 버튼으로 승격(경고 모달이 이 버튼을 참조 — 눈에 띄어야 함).
      safe(function(){
        const sc=d.scope;
        // 환경 안내 — "이 폴더에서 정찰이 얼마나 힘을 쓰나"를 한 문장으로(전문용어·괄호 겹침 제거)
        let envLine;
        if(sc && sc.note==="no-git") envLine=T("🏠 이 폴더는 과거 변경 기록이 없어요 — '예전에 같이 바뀌던 파일' 힌트는 못 쓰지만, 지도와 일지는 최근 수정 기준으로 잘 돌아가요.","🏠 This folder has no change history — 'changed-together' hints are unavailable, but maps & the journal work fine from recent edits.");
        else if(sc && typeof sc.logCount==="number" && sc.logCount>=100) envLine=T("🏠 이 폴더는 변경 기록이 풍부해요 — 정찰이 제 성능을 낼 수 있는 환경입니다.","🏠 This folder has a rich change history — recon can perform at full strength here.");
        else envLine=T("🏠 이 폴더는 기록이 아직 얕아요 — 과거 힌트는 조용할 수 있고, 지도부터 가치가 나옵니다.","🏠 This folder's history is still shallow — past hints may stay quiet; maps deliver value first.");
        if(d.hasTestsDir===false) envLine += T(" (tests 폴더가 안 보여서 지도의 '확인할 테스트' 칸은 비어 나올 수 있어요.)"," (No tests/ folder found, so the map's 'tests to check' section may come back empty.)");
        const env=add(envLine,"muted"); env.style.margin="0 0 6px";
        // LLM 필수성 — 한 줄로 압축(정직 고지 유지)
        add(T("⚡ 실질 효과는 '정찰 실행'에서 나와요 — 한 번도 안 돌리면 지도·일지·교범은 비어 있습니다(기본 정찰은 별도 과금 없음).","⚡ Real value comes from recon actually running — if it never runs, maps/journal/manual stay empty (the default scout adds no separate billing)."),"muted");
        // 자세히 보기 — 주 버튼 승격(경고 모달·API 박스가 이 버튼을 참조)
        const gb=document.createElement("button"); gb.style.cssText="margin:8px 0 10px;font-weight:700;padding:7px 16px";
        gb.textContent=T("📖 정찰 구조 자세히 보기 (새탭)","📖 Recon structure in detail (new tab)");
        gb.addEventListener("click", function(){ vscode.postMessage({type:"openReconGuide"}); });
        box.appendChild(gb);
      });
      (function(){ const h=add(T("변경 감지 ⚙ 자동·AI 호출 없음 — 지금 고치는 파일 + 예전에 같이 바뀌곤 했던 파일 힌트","Change sensing ⚙ auto · no AI calls — files you're editing + hints that used to change with them"),"sbhead"); h.style.cssText="border-left:3px solid #3ca89a;padding-left:8px"; })();
      // 탐색 상태 요약 1줄(사용자 지적: 침묵을 상태로 번역) — 지금 무엇이 돌고/안 돌고 있고, 다음 행동이 뭔지.
      (function(){
        const sc=d.scope; let line;
        if(d.scoutLive) line=T("지금: 지도 생성 중… ("+(d.scoutLive.arm==="deepseek"?"DeepSeek 정찰":"기본 정찰 Claude")+" — 끝나면 아래 게시판에 도착)","Now: generating a map… ("+(d.scoutLive.arm==="deepseek"?"DeepSeek scout":"default scout (Claude)")+" — lands on the board below when done)");
        else if(!sc) line=T("지금: 계산 대기 — 3트랙 저장 직후 자동 시작돼요.","Now: pending — starts right after saving 3-track.");
        else if(sc.note==="no-git") line=T("지금: 이 폴더엔 변경 기록(버전 관리)이 없어요 — '같이 바뀌던 파일' 힌트는 계산 불가 · 지도는 최근 수정 파일 기준으로 직접/자동 지시 실행 시 생성돼요.","Now: this folder has no change history (version control) — 'changed-together' hints can't be computed · maps are generated from recent edits on direct/auto-directive runs.");
        else if(sc.note==="error") line=T("지금: 변경 기록을 읽지 못했어요 — 잠시 후 자동 재시도돼요.","Now: couldn't read the change history — retries shortly.");
        else if(sc.note==="no-changes") line=T("지금: 대기 — 작업트리에 변경이 없어요. 파일이 바뀌면 변경 감지가 자동으로 후보를 찾고, 지도는 직접/자동 지시 실행으로 만들어져요.","Now: idle — no working-tree changes. Change sensing finds candidates automatically once files change; maps are made on direct/auto-directive runs.");
        else {
          const when = sc.checkedAt ? new Date(sc.checkedAt).toLocaleTimeString() : "?";
          const cand = (sc.suggestion && sc.suggestion.candidates) ? sc.suggestion.candidates.length : 0;
          line=T("지금: 변경 감지 동작 중 — 마지막 확인 "+when+" (과거 변경 "+sc.logCount+"건 검토 · 후보 "+cand+"개) · 지도는 직접/자동 지시 실행 대기.","Now: change sensing active — last checked "+when+" ("+sc.logCount+" past changes reviewed · "+cand+" candidates) · maps await a direct/auto-directive run.");
        }
        const el=add(line,"muted"); el.style.fontWeight="600";
      })();
      // 상세(후보 목록·키 안내·한계 고지)는 접힘으로 — 첫 화면은 위 도해+상태 1줄(2026-07-08 시안성 개편)
      safe(function(){
        const det=keyedDetails("senseDetail", T("자세히 — 후보 목록·키 안내·한계","Details — candidates · key note · limits"));
        const addD=(txt,cls)=>{const el=document.createElement("div"); el.className=cls||"sbrow"; el.textContent=txt; det.appendChild(el); return el;};
        if(d.deepseek && !d.deepseek.hasKey){
          addD(T("ⓘ 키 없이도 변경 감지 + 기본 정찰(Claude) 지도(별도 과금 없음 — 쓰시던 Claude로 실행)까지 가능해요 — DeepSeek API 키는 '비교용 두 번째 정찰'만 엽니다(⚙️ 고급설정 탭).","ⓘ Without any key you get change sensing plus default-scout maps (no separate billing — runs on the Claude you already use) — a DeepSeek API key only unlocks the second, comparison scout (⚙️ Advanced tab)."),"muted");
        }
        const sc=d.scope;
        if(!sc){ addD(T("계산 대기 — 3트랙 저장 후 자동 갱신됩니다.","Pending — refreshes automatically after saving 3-track."),"muted"); }
        else if(sc.note==="no-git"){ addD(T("이 폴더엔 변경 기록(버전 관리·git)이 없어서 '예전에 같이 바뀌던 파일' 힌트를 만들 수 없어요.","This folder has no change history (version control / git), so 'changed together before' hints can't be built."),"muted"); }
        else if(sc.note==="no-changes"){ addD(T("지금 작업트리에 변경이 없어요 — 파일을 바꾸면 여기에 후보가 떠요.","No working-tree changes yet — candidates appear once files change."),"muted"); }
        else if(sc.note==="error"||!sc.suggestion){ addD(T("변경 기록을 읽지 못했어요 — 잠시 후 다시 시도돼요.","Couldn't read the change history — will retry shortly."),"muted"); }
        else {
          addD(T("지금 고치는 중: ","Editing now: ")+sc.seeds.join(", "),"muted");
          const s=sc.suggestion;
          if(s.sparse){
            addD(T("데이터 없음 — 이 파일들은 과거에 바뀐 기록이 아직 적어서("+s.seedObservations+"회 < 3) 추측 대신 조용히 있어요. 새로 만든 영역이면 정상이에요.","No data — these files have too few past-change records ("+s.seedObservations+"× < 3), so we stay quiet instead of guessing. Normal for new areas."));
          } else if(!s.candidates.length){
            addD(T("문턱(함께 변경 3회)을 넘는 후보가 없어요.","No candidates above the threshold (co-changed 3×)."));
          } else {
            s.candidates.forEach(c=>{ addD("• "+c.file+"  ("+T("예전에 같이 바뀜 ","changed together before ")+c.n+T("회","×")+")"); });
          }
        }
        addD(T("⚠ 이 장부가 못 보는 것: 처음 생기는 결합·실행해봐야 아는 동작·의미적 연쇄 — 후보가 없다고 영향이 없는 게 아니에요. (이 힌트 자체는 관찰 전용: 막지 않음 — 막는 건 플랜 게이트뿐[영향지도 칸 참조] · 전부 로컬 git, 외부 전송 없음)","⚠ What this ledger cannot see: first-time couplings, behaviors only running reveals, semantic chains — no candidates ≠ no impact. (These hints are advisory: they block nothing — only the plan gate blocks [see the impact-map section] · all local git, nothing sent anywhere)"),"muted");
        box.appendChild(det);
      });
    });
    // ⑤-2 영향지도 게시판(3트랙 LLM 탐색 결과) — 러너가 보관한 지도를 읽기 전용으로 게시(사용자 결정 2026-07-06:
    // AI 역할의 시각적 확인). 확장은 지도를 생성·전송하지 않는다 — 빈 게시판엔 생성 명령을 정직하게 안내.
    safe(function(){
      const box=$("scoutBox"); if(!box || box.style.display==="none") return; // 3트랙 카드가 보일 때만 이어붙임
      const sec=document.createElement("div"); sec.className="rsec"; sec.style.borderLeft="3px solid #9a6cdc"; box.appendChild(sec); // 섹션 카드(디자인 분리 — 2026-07-09 지적 4)
      const add=(txt,cls)=>{const el=document.createElement("div"); el.className=cls||"sbrow"; el.textContent=txt; sec.appendChild(el); return el;};
      (function(){ const h=add(T("영향지도(정찰 보고) ⚡ AI 호출 — 정찰 AI가 보낸 최근 지도","Impact maps (recon reports) ⚡ AI call — recent maps from the scout AI"),"sbhead"); })();
      safe(function(){
        const det=keyedDetails("mapInfo", T("ⓘ 영향지도가 뭐예요?","ⓘ What is an impact map?"));
        const p=document.createElement("div"); p.className="muted";
        p.textContent=T("ⓘ 영향지도 = 지금 바꾸는 것이 어디까지 영향을 주는지 탐색 AI가 정리한 확인 목록(직접·간접 영향 후보, 확인할 테스트, 범위 밖으로 봐도 되는 것). 생성되면 이 게시판에 도착해요.","ⓘ Impact map = a checklist from the scout AI of how far your current change reaches (direct/indirect impact candidates, tests to check, safely out-of-scope). New maps land on this board.");
        det.appendChild(p); sec.appendChild(det);
      });
      // 플랜 게이트 상태 — informed consent(기본 승격 2026-07-09): 지도 없음/낡음이면 플랜 확정 전에 훅이 먼저 지도를
      // 요청한다는 사실을 '지도 게시판'에서 상시 고지. 지도가 0장이어도 보여야 하므로 아래 조기 return보다 앞.
      safe(function(){
        const g=d.scoutGate; if(!g) return;
        const gl=document.createElement("div"); gl.className="muted"; gl.style.margin="2px 0 6px";
        gl.textContent = g.eff==="plan"
          ? (g.raw==="plan"
            ? T("🚧 플랜 게이트: 켜짐(직접 설정) — 지도가 없거나 낡으면 플랜 확정 전에 먼저 지도를 요청해요(세션당 2회까지·이후 통과) · 끄기: node scripts/scope-gate.js <이 폴더> off","🚧 Plan gate: on (set by you) — if the map is missing/stale, a map is requested before plan confirmation (up to 2×/session, then passes) · turn off: node scripts/scope-gate.js <this folder> off")
            : T("🚧 플랜 게이트: 켜짐(3트랙 기본) — 지도가 없거나 낡으면 플랜 확정 전에 먼저 지도를 요청해요(세션당 2회까지·이후 통과 · 안내에는 이 프로젝트의 관찰 신호가 함께 실림) · 끄기: node scripts/scope-gate.js <이 폴더> off","🚧 Plan gate: on (3-track default) — if the map is missing/stale, a map is requested before plan confirmation (up to 2×/session, then passes · the notice carries this project's observation signal) · turn off: node scripts/scope-gate.js <this folder> off"))
          : T("플랜 게이트: 꺼짐(직접 끄심) — 켜기: node scripts/scope-gate.js <이 폴더> on","Plan gate: off (turned off by you) — turn on: node scripts/scope-gate.js <this folder> on");
        sec.appendChild(gl);
      });
      const sm=d.scoutMaps;
      if(!sm || !sm.count){
        const nonGit = d.scope && d.scope.note==="no-git";
        add(nonGit
          ? T("AI 정찰 보고서(영향지도)가 아직 없어요 — 변경 기록이 없는 폴더는 '최근 수정 파일 기준'(전후 비교 없음)으로 지도를 만들어요. 생성은 codex-peek 소스 저장소 폴더의 터미널에서: node scripts/scope-scout-self.js <이 폴더 경로>. 생성되면 몇 초 뒤 여기 자동으로 떠요.","No AI recon report (impact map) yet — folders without change history build maps from recently modified files (no before/after diff). Generate from a terminal in the codex-peek source repo: node scripts/scope-scout-self.js <this folder>. New maps appear here a few seconds after generation.")
          : T("AI 정찰 보고서(영향지도)가 아직 없어요 — 생성은 codex-peek 소스 저장소 폴더의 터미널에서: node scripts/scope-scout-self.js <프로젝트경로> (별도 과금 없음 — 쓰시던 Claude로 실행) 또는 scope-scout-deepseek.js (DeepSeek 정찰). 마켓 설치본에는 이 스크립트가 안 들어 있어요(현 단계는 수동·개발자 플로우). 생성되면 몇 초 뒤 여기 자동으로 떠요.","No AI recon report (impact map) yet — generate from a terminal in the codex-peek source repo: node scripts/scope-scout-self.js <repo> (no separate billing — runs on the Claude you already use) or scope-scout-deepseek.js (DeepSeek scout). These scripts are not bundled in the marketplace build (manual/developer flow for now). New maps appear here a few seconds after generation."),"muted");
        return;
      }
      // 낡은 지도 배지(신선도 — 경고 아님): 최신 지도 생성 이후 지금 변경 중인 파일이 더 바뀌었으면 정직 표기.
      if(typeof d.scoutMapStale==="number" && d.scoutMapStale>0){
        add(T("⏳ 최신 지도 이후 변경 신호 "+d.scoutMapStale+"건(파일 변경·새 커밋·작업트리) — 지도가 지금 상태보다 낡았을 수 있어요(재생성은 아래 명령 그대로).","⏳ "+d.scoutMapStale+" change signal(s) since the latest map (file edits · new commits · working tree) — it may be older than your current state (regenerate with the same command)."),"muted");
      }
      sm.items.forEach(it=>{
        const when = it.ts ? new Date(it.ts).toLocaleString() : "?";
        const usage = (it.usageIn!=null && it.usageOut!=null) ? T(" · 보냄 "," · sent ")+it.usageIn+T("·받음 ","·got ")+it.usageOut+T("토큰"," tokens") : "";
        add("• ["+when+"] "+(it.arm==="deepseek"?T("DeepSeek 정찰","DeepSeek scout"):T("기본 정찰(Claude)","default scout (Claude)"))+(it.model?" ("+it.model+")":"")+usage,"muted");
      });
      if(sm.latest){
        // 펼침 유지 키는 지도 시각 기반 — 새 지도가 오면 기본 접힘(옛 지도에서 연 상태가 새 지도로 새지 않게 — Codex 보완)
        const det=keyedDetails("map:"+(sm.latest.ts||"?"), T("최신 지도 펼쳐보기 ("+(sm.latest.arm==="deepseek"?"DeepSeek 정찰":"기본 정찰")+")","Open latest map ("+(sm.latest.arm==="deepseek"?"DeepSeek scout":"default scout")+")"));
        const pre=document.createElement("pre");
        pre.style.cssText="white-space:pre-wrap;max-height:340px;overflow:auto;font-size:11px";
        pre.textContent=sm.latest.text + (sm.latest.truncated?T("\\n… (길어서 접힘 — 전문은 브릿지 홈 scouts 폴더 파일)","\\n… (truncated — full text in the bridge home scouts folder)"):""); // ★백슬래시 두 겹 필수: 이 스크립트는 바깥 템플릿 안이라 한 겹이면 HTML 생성 시 실제 개행으로 변환돼 웹뷰 JS 전체가 문법 오류로 죽는다(2026-07-06 실사고 — tests/webview-syntax가 검출)
        det.appendChild(pre); sec.appendChild(det);
      }
      add(T("ⓘ 이 게시판은 열람 전용(보는 것만으로는 아무것도 전송 안 됨) — 지도 생성·전송은 명령이 실행될 때만: 당신이 직접, 또는 3트랙 자동 지시를 받은 Claude가(같은 상태엔 1회 지시). 프로젝트별 최근 10장 보관.","ⓘ Read-only board (viewing sends nothing) — maps are generated/sent only when the command runs: by you directly, or by Claude on the 3-track auto-directive (issued once per state). Last 10 kept per project."),"muted");
    });
    // ⑤-3 MAP 장부(자동 관측 기억 — 역할 전환 2026-07-07) — 승인 큐가 아니라 관측 패널:
    // 무엇을 봤고(제안)·반영했고(동봉/확인)·정정했는지(반박/차단)를 신분·타임라인으로 보여주고,
    // 사람 개입(고정/차단/내보내기)은 선택. 버튼은 서명(sig)을 그대로 보냄 — 번호 밀림류 오작동 원천 차단.
    safe(function(){
      const box=$("scoutBox"); if(!box || box.style.display==="none") return;
      const ml=d.mapLedger; if(!ml) return;
      const card=document.createElement("div");
      card.className="mled"+(ml.counts.disputed?"":" calm"); // 틀림판명이 쌓이면 주황(살펴볼 것), 평시 초록
      const h=document.createElement("div"); h.className="sbhead";
      h.textContent=T("관찰 일지(자동 기억) ⚙ 추가 LLM 없음 — 개입은 선택","Field journal (auto memory) ⚙ no extra LLM — intervention optional");
      card.appendChild(h);
      const info=document.createElement("div"); info.className="muted";
      info.textContent=T("영향지도의 발견이 자동으로 쌓이고, 검증이 확인하면 신뢰로 승격되고, 반박되면 스스로 강등됩니다 — 클릭 없이 굴러갑니다. 원하실 때만 고정(신뢰 강제)/차단(제외)/'확정 교범("+ml.mapRel+")'으로 내보내기(승격)로 개입하세요.","Impact-map findings accumulate automatically, get promoted on verification and demoted on dispute — no clicking required. Intervene only when you want: pin (force-trust), ban (exclude), or export (promote) into the 'field manual ("+ml.mapRel+")'.");
      card.appendChild(info);
      // 정찰 대상 — '상시' 표시(2026-07-10 구조 해법: 미지정=세션 폴더 폴백이 조용히 축을 눈 감기던 실사고 —
      // differs/invalid일 때만 보이던 것을 항상 보이게. 어긋남 의심이면 문구가 아니라 '행동 카드'로).
      if(d.scoutTarget){
        const tg=document.createElement("div"); tg.className="muted";
        tg.textContent = d.scoutTarget.invalid
          ? T("⚠ 계약에 지정된 정찰 대상 폴더를 찾을 수 없어 이 폴더 기준으로 동작 중 — node scripts/scope-target.js로 재지정하세요.","⚠ The configured scout target folder was not found — falling back to this folder. Re-set it via node scripts/scope-target.js.")
          : d.scoutTarget.configured
          ? T("정찰 대상: "+d.scoutTarget.repo+(d.scoutTarget.inherited?" (반대 언어 슬롯에서 상속 — 지도·일지·확인신호가 이 레포 기준)":" (계약 지정 — 지도·일지·확인신호가 이 레포 기준으로 쌓임)"),"Scout target: "+d.scoutTarget.repo+(d.scoutTarget.inherited?" (inherited from the other language slot — maps, journal and confirms accrue for this repo)":" (set in contract — maps, journal and confirms accrue for this repo)"))
          : T("정찰 대상: (미지정 — 이 폴더 기준) 실제 개발이 다른 폴더에서 이뤄지면 지도·일지가 그걸 못 봅니다. 어긋남이 감지되면 아래에 설정 카드가 떠요.","Scout target: (not set — this folder) If development actually happens in another folder, maps & journal won't see it. A setup card appears below when a mismatch is detected.");
        card.appendChild(tg);
      }
      // 서랍 전환 고지(2026-07-10 실사고: '신뢰 2→0'을 삭제로 오인) — 대상 전환 후 이전 서랍이 남아 있으면 상시 안내.
      safe(function(){
        const pv = ml.prevDrawer; if(!pv) return;
        const n=document.createElement("div"); n.className="muted";
        n.textContent = T("ⓘ 이 일지는 '정찰 대상' 서랍입니다 — 이전(이 폴더) 서랍에 "+pv.entries+"건(신뢰 "+pv.trusted+")이 그대로 보존돼 있어요(삭제 아님). ⚠ 이관은 '같은 프로젝트의 과거 기록'일 때만 — 이 폴더 서랍이 다른 작업(문서 등)의 결합이면 옮기면 대상 장부가 오염됩니다. 확인 후: "+pv.migrateCmd+" (미리보기 — 확정은 --dry 제거) · 확정 교범 위치·관찰 신호도 대상 기준으로 바뀐 상태","ⓘ This journal is the scout-target drawer — the previous (this-folder) drawer still holds "+pv.entries+" item(s) ("+pv.trusted+" trusted); nothing was deleted. ⚠ Migrate only if this drawer really is this project's own past record — if it holds couplings from other work (docs etc.), migrating would pollute the target ledger. After checking: "+pv.migrateCmd+" (preview — drop --dry to commit) · the field-manual location and observation signals also follow the target now");
        card.appendChild(n);
      });
      safe(function(){ // 대상 어긋남 자기진단 카드 — 고지가 아니라 원클릭 행동(2026-07-10 구조 해법)
        const dr=d.scoutTarget && d.scoutTarget.drift; if(!dr) return;
        const box2=document.createElement("div");
        box2.style.cssText="margin:6px 0;padding:8px;border:1px solid var(--vscode-inputValidation-warningBorder,#d9a441);border-radius:6px";
        const t1=document.createElement("div"); t1.style.fontWeight="600";
        t1.textContent=T("⚠ 정찰이 보는 곳과 개발이 일어나는 곳이 다른 것 같아요","⚠ Recon seems to be watching a different place than where development happens");
        const t2=document.createElement("div"); t2.className="muted";
        t2.textContent=T("최근 검증 "+dr.sample+"회 중 "+dr.agree+"회가 주로 이 레포의 파일을 인용했어요: "+dr.repo+" — 정찰 대상을 이 레포로 지정하면 지도·일지·확인신호가 실제 개발을 따라갑니다.","In "+dr.agree+" of the last "+dr.sample+" verifications, citations mostly lived under: "+dr.repo+" — set it as the scout target so maps, journal and confirms follow the real development.");
        const b=document.createElement("button"); b.style.cssText="margin-top:6px;font-weight:700";
        b.textContent=T("정찰 대상을 이 레포로 설정","Set scout target to this repo");
        b.addEventListener("click", function(){ vscode.postMessage({type:"setScoutTarget", repo: dr.repo, lang: d.lang}); });
        box2.appendChild(t1); box2.appendChild(t2); box2.appendChild(b); card.appendChild(box2);
      });
      const chips=document.createElement("div"); chips.className="mledchips";
      const chip=(n,label,cls)=>{const c=document.createElement("div");c.className="mchip "+(cls||"");const b=document.createElement("b");b.textContent=String(n);const s=document.createElement("span");s.textContent=label;c.appendChild(b);c.appendChild(s);chips.appendChild(c);};
      chip(ml.counts.trusted,T("신뢰(자동 반영)","trusted"),"ok");
      chip(ml.counts.reference,T("미검증(참고)","unverified"),"");
      chip(ml.counts.disputed,T("틀림 판명","disputed"),ml.counts.disputed?"hot":"no");
      if(ml.counts.excluded) chip(ml.counts.excluded,T("제외(차단·대체)","excluded"),"no");
      card.appendChild(chips);
      // 프로젝트별 관찰 신호 1줄 — 전역 임계값 대신 '이 폴더의 장부'가 신뢰 판단 재료(advisory·사용자 결정 2026-07-09).
      safe(function(){
        const h=ml.health; if(!h||!h.entries) return;
        const line=document.createElement("div"); line.className="muted";
        line.textContent = h.entries<5
          ? T("관찰 신호: 표본 아직 작음(항목 "+h.entries+"건) — 비율 표시는 보류(과신 방지)","Observation signal: sample still small ("+h.entries+" items) — ratios withheld (avoids overconfidence)")
          : T("관찰 신호(이 프로젝트): 확인 "+h.verified+"/"+h.entries+(h.reusedDen>=5?" · 재사용 항목 중 확인 이력 "+h.reusedNum+"/"+h.reusedDen:"")+" · 반박 "+h.disputedEntries+"건(수동 기록 기준) · 복권 "+h.rehabilitated+"건 — 관측치이며 편향은 양방향일 수 있어요(자동 반박 없음=반박 과소·지도 동봉 노출=확인 과대)","Observation signal (this project): confirmed "+h.verified+"/"+h.entries+(h.reusedDen>=5?" · reused items with a confirm "+h.reusedNum+"/"+h.reusedDen:"")+" · disputed "+h.disputedEntries+" (manually recorded) · rehabilitated "+h.rehabilitated+" — observational; bias can go both ways (no auto-dispute = disputes undercounted · map-attached exposure = confirms overcounted)");
        card.appendChild(line);
      });
      // 건강 리포트 새탭 — 현황이 포화라 확장판(수치 뜻·게이트·타임라인)은 대시보드에 더 얹지 않고 새탭으로(2026-07-09).
      safe(function(){
        const rb=document.createElement("button"); rb.style.cssText="margin:4px 0 2px";
        rb.textContent=T("🩺 건강 리포트 (새탭) — 신호의 역할·수치의 뜻·게이트·사건 흐름","🩺 Health report (new tab) — role of the signals · what the numbers mean · gate · event flow");
        rb.addEventListener("click", function(){ vscode.postMessage({type:"openScoutHealthReport"}); });
        card.appendChild(rb);
      });
      if(ml.dropped) { const w=document.createElement("div"); w.className="muted"; w.textContent=T("ⓘ 판독 불가 기록 "+ml.dropped+"줄은 건너뜀(집계에 안 섞임)","ⓘ "+ml.dropped+" unreadable record line(s) skipped (not counted)"); card.appendChild(w); }
      // 확정 교범 설명(2026-07-09 지적 5: '이게 뭔지 모르겠다') — 왜 도장을 찍나·차이·자동 주입 아님을 평문으로
      safe(function(){
        const det=keyedDetails("manualInfo", T("📕 '확정 교범'이 뭐예요? — 도장 찍은 지식만 문서로","📕 What is the 'field manual'? — only stamped knowledge becomes a doc"));
        const lines=[
          T("일지(위 목록)는 이 컴퓨터에만 있는 자동 기억이에요. 그중 '이건 확실하다' 싶은 항목에 [교범에 기록] 도장을 찍으면 저장소 문서("+ml.mapRel+")에 한 줄로 박제됩니다.","The journal above is auto-memory on this PC only. Stamp an entry with [Export] and it gets engraved as one line in a repo doc ("+ml.mapRel+")."),
          T("차이점: 일지=이 PC 전용·자동으로 변함 / 교범=저장소와 함께 이동(팀원·다른 PC 공유)·당신이 지우기 전엔 안 변함. 정찰 AI는 다음 지도를 그릴 때 교범을 '확정 사실'로 참고해요.","Difference: journal = this PC only, changes automatically / manual = travels with the repo (teammates, other PCs), never changes unless you edit it. The scout AI treats the manual as settled facts when drawing the next map."),
          T("자동 주입 아니에요: 버튼을 누른 그 항목만, 누른 그 순간 1회 기록됩니다 — 뭔가가 계속 무단으로 쌓이지 않아요. 안 써도 나머지 단계는 그대로 동작합니다.","Not auto-injection: only the entry you click, once, at that moment — nothing keeps piling up on its own. Skip it entirely and everything else still works."),
        ];
        lines.forEach(function(tx){const p=document.createElement("div"); p.className="muted"; p.style.margin="4px 0"; p.textContent=tx; det.appendChild(p);});
        card.appendChild(det);
      });
      if(!ml.entries.length){
        const e=document.createElement("div"); e.className="muted";
        e.textContent=T("장부가 비어 있어요 — 정찰 지도가 '기억할 결합'(⑥)을 제안하면 자동으로 쌓입니다.","The ledger is empty — it fills automatically when scout maps propose section-⑥ couplings.");
        card.appendChild(e);
      }
      const STATUS_LABEL={inferred:[T("추정","inferred"),""],verified:[T("검증됨","verified"),"ok"],disputed:[T("틀림판명","disputed"),"hot"],banned:[T("차단됨","banned"),"no"],superseded:[T("대체됨","superseded"),"no"],tombstone:[T("소멸","gone"),"no"]};
      ml.entries.forEach(p=>{
        const row=document.createElement("div"); row.className="mlrow";
        const tx=document.createElement("div"); tx.className="mltxt";
        const t1=document.createElement("div"); t1.className="t";
        const badge=document.createElement("span"); const sl=STATUS_LABEL[p.status]||[p.status,""];
        badge.className="mlb "+sl[1]; badge.textContent=(p.rehabilitated?T("복권됨","rehabilitated"):sl[0])+(p.pinned?T("·고정","·pinned"):"");
        if(p.rehabilitated) badge.title=T("반박된 적 있으나 그 뒤 재확인이 쌓여 신뢰로 복귀(반박 이력은 사건 수에 남음)","was disputed, later re-confirmed back to trusted (dispute history stays in counts)");
        t1.appendChild(badge); t1.appendChild(document.createTextNode(" "+p.text));
        const t2=document.createElement("div"); t2.className="f";
        t2.textContent=T("제안 "+p.n.proposed+" · 동봉 "+p.n.attached+" · 확인 "+p.n.confirmed+" · 반박 "+p.n.disputed+(p.from?" · 출처: "+p.from:""),"proposed "+p.n.proposed+" · attached "+p.n.attached+" · confirmed "+p.n.confirmed+" · disputed "+p.n.disputed+(p.from?" · from: "+p.from:""));
        tx.appendChild(t1); tx.appendChild(t2); row.appendChild(tx);
        const btn=(label,act,cls)=>{const b=document.createElement("button"); if(cls)b.className=cls; b.textContent=label; b.onclick=function(){ vscode.postMessage({type:"ledgerAct",act:act,sig:p.sig}); }; row.appendChild(b);};
        if(p.status==="banned"){ btn(T("차단 해제","Unban"),"unban","secondary"); }
        else {
          btn(p.pinned?T("고정 해제","Unpin"):T("고정","Pin"),p.pinned?"unpin":"pin","secondary");
          btn(T("차단","Ban"),"ban","secondary");
          if(p.lane==="trusted"&&!p.inMap) btn(T("장부로","Export"),"export","");
        }
        card.appendChild(row);
      });
      if(ml.timeline.length){
        const det=document.createElement("details"); const s=document.createElement("summary");
        s.textContent=T("최근 사건 타임라인 ("+ml.timeline.length+")","Recent events ("+ml.timeline.length+")");
        det.appendChild(s);
        const ICON={proposed:"✚",attached:"▶",confirmed:"✔",user_confirm:"✔",refuted:"✖",user_dispute:"✖",pinned:"📌",unpinned:"📌",banned:"🚫",unbanned:"🚫",superseded:"↷",tombstone:"†",exported:"📤"};
        const NAME={proposed:T("정찰 제안","proposed"),attached:T("자료에 동봉","attached to package"),confirmed:T("검증이 확인","verified confirm"),user_confirm:T("사용자 확인","user confirm"),refuted:T("검증이 반박","verify refute"),user_dispute:T("사용자 정정","user dispute"),pinned:T("고정","pinned"),unpinned:T("고정 해제","unpinned"),banned:T("차단","banned"),unbanned:T("차단 해제","unbanned"),superseded:T("대체됨","superseded"),tombstone:T("소멸","gone"),exported:T("장부로 내보냄","exported")};
        ml.timeline.forEach(e=>{const r=document.createElement("div"); r.className="mhist";
          r.textContent=(ICON[e.type]||"·")+" "+(NAME[e.type]||e.type)+" — "+e.text;
          const w=document.createElement("div"); w.className="w";
          w.textContent=(e.ts?new Date(e.ts).toLocaleString():"?")+(e.from?" · "+e.from:"");
          r.appendChild(w); det.appendChild(r);});
        card.appendChild(det);
      }
      if(ml.mapExists){
        const det=document.createElement("details"); const s=document.createElement("summary");
        s.textContent=T("확정 장부 열람 ("+ml.mapRel+" · 승인 "+ml.mapApproved+"건/전체 항목 "+ml.mapTotalItems+"건)","Open ledger ("+ml.mapRel+" · "+ml.mapApproved+" approved / "+ml.mapTotalItems+" items)");
        const pre=document.createElement("pre"); pre.style.cssText="white-space:pre-wrap;max-height:260px;overflow:auto;font-size:11px";
        pre.textContent=ml.mapText+(ml.mapTruncated?T("\\n… (길어서 접힘 — 전문은 파일)","\\n… (truncated — full text in the file)"):""); // ★백슬래시 두 겹 — 웹뷰 JS 개행 지뢰(webview-syntax.test.js 검출)
        det.appendChild(s); det.appendChild(pre); card.appendChild(det);
      }
      box.appendChild(card);
    });
    // ⑥ 고급설정 탭 — DeepSeek 키 상태(마스킹만 수신·원문 없음). 저장 직후엔 saveResult 플래시가 먼저 보이고,
    // 다음 상태 푸시(post)가 이 최신 상태 문구로 자연 교체한다(둘 다 같은 노드 — 경합 무해).
    safe(function(){
      const st=$("dsState"); if(!st) return;
      st.textContent = d.deepseek && d.deepseek.hasKey
        ? T("등록됨: ","Registered: ") + d.deepseek.masked + T(" · 모델: "," · model: ") + d.deepseek.model
        : T("등록된 키 없음 — 잠기는 건 DeepSeek 비교 정찰뿐(변경 감지·기본 정찰 지도[별도 과금 없음]는 키 없이 동작).","No key registered — only the DeepSeek comparison scout is locked (change sensing and default-scout maps [no separate billing] work without it).");
    });
    // 온보딩: 미완료=설명 단계(이동 버튼·은은한 펄스) / 완료=축하+끄기 / 끄고 완료=다시보기 링크만.
    // 미완료(연결 끊김·검증 꺼짐)면 끄기 여부와 무관하게 단계가 다시 보여 '고장'을 숨기지 않음.
    safe(function(){
      const ob=$("onboard"); if(!ob) return;
      const codexReady = !!d.codexReady, linked = !!d.linkedId;
      const vOn = holdC ? !!(appVM && appVM!=="off") : !!(d.contract && d.contract.verifyMode && d.contract.verifyMode!=="off"); // hold 중엔 화면 기준(appVM) — 파생 표시 일관
      const allDone = linked && vOn;            // codex 준비는 연결로 함의됨
      const dismissed = !!d.onboardDismissed;
      ob.style.display = "";
      if (allDone && dismissed){                // 완료 + 사용자가 끔 → 작은 '다시 보기' 링크만
        ob.className = "onboard"; $("obReopen").style.display = ""; $("obMain").style.display = "none";
        return;
      }
      $("obReopen").style.display = "none"; $("obMain").style.display = "";
      ob.className = "onboard " + (allDone ? "complete" : "incomplete");
      $("obTitle").textContent = allDone ? T("준비 끝 ✓","All set ✓") : T("시작하기 — 3가지면 매 턴 자동 검증","Getting started — 3 steps to auto-verify every turn");
      $("obClose").style.display = allDone ? "" : "none";
      $("obSteps").style.display = allDone ? "none" : "";
      $("obDone").style.display = allDone ? "" : "none";
      if (!allDone){
        const step=(id,done,text,btn,where)=>{ const e=$(id); if(!e) return;
          e.className="obstep "+(done?"done":"todo");
          let b="";
          if(!done && btn){ if(btn.go) b=' <button type="button" class="obgo secondary" data-go="'+btn.go+'">'+T("이동 ›","Go ›")+'</button>'; else if(btn.cmd) b=' <button type="button" class="obgo secondary" data-cmd="'+btn.cmd+'">'+T("설정 ›","Settings ›")+'</button>'; }
          e.innerHTML='<span class="k">'+(done?"✓":"○")+'</span>'+text+(where?' <span class="where">'+where+'</span>':'')+b; };
        step("ob1", codexReady, codexReady?T("Codex 준비됨","Codex ready"):T("Codex 경로 미고정 — PATH의 codex로 시도","Codex path not pinned — trying codex on PATH"), {cmd:"openSettings"}, codexReady?"":T("openai.chatgpt 확장이 있으면 보통 자동 · standalone CLI면 PATH로 동작(안 뜨면 codexBridge.codexPath 지정)","usually automatic with the openai.chatgpt extension · standalone CLI works via PATH (set codexBridge.codexPath if not detected)"));
        step("ob2", linked, linked?T("Codex 세션 연결됨","Codex session linked"):T("Codex 세션 미연결","No Codex session linked"), {go:"cands"}, linked?"":T("연결할 세션 고르기","pick a session to link"));
        step("ob3", vOn, vOn?(T("검증 켜짐 (","verify on (")+((d.contract&&d.contract.verifyMode)||appVM)+")"):T("검증 꺼짐","verify off"), {go:"segVerify"}, vOn?"":T("검증 모드 켜고 저장","turn on a verify mode and save"));
      }
    });
    // 기본지침도 언어 전환 hold(계약 카드와 동일 원리) — 편집 중 언어가 바뀌면 보던 언어 화면 유지, 저장은 보던 슬롯으로.
    safe(function(){
    const langChangedB = renderedLangB !== null && d.lang && d.lang !== renderedLangB;
    const holdB = langChangedB && (baseDirty.verify || baseDirty.transmit || baseDirty.rejudge || baseDirty.scout ||
      document.activeElement === $("bVerify") || document.activeElement === $("bTransmit") || document.activeElement === $("bRejudge") || document.activeElement === $("bScout"));
    if (d.baseDirective && !holdB){
      if (d.lang) renderedLangB = d.lang;
      if (document.activeElement !== $("bVerify") && !baseDirty.verify) $("bVerify").value = d.baseDirective.verifyBaseline||"";
      if (document.activeElement !== $("bTransmit") && !baseDirty.transmit) $("bTransmit").value = d.baseDirective.transmit||"";
      if (document.activeElement !== $("bRejudge") && !baseDirty.rejudge) $("bRejudge").value = d.baseDirective.rejudge||"";
      const ov=$("baseOv"); if(ov) ov.textContent = d.baseDirective.overridden ? T("· (수정됨)","· (modified)") : T("· (기본값)","· (defaults)");
    }
    // ④ 정찰 칸 — 3트랙(저장된 트랙)일 때만 등장. 사용자 단순화 요청(2026-07-09): 트랙에 따라 이 패널이 늘어난다.
    safe(function(){
      const wrap=$("bScoutWrap"), row=$("sbScout"); if(!wrap) return;
      const on = !!(d.contract && d.contract.scoutMode === "on");
      wrap.style.display = on ? "" : "none";
      if (row) row.style.display = on ? "" : "none";
      // ①~③처럼 ✓ 표시(2026-07-09 사용자 지적: ④만 마크가 빈칸이었음 — setStage 미호출 누락).
      // 이 줄은 3트랙일 때만 보이므로 보이는 순간 = 적용 중(정찰 기본 원칙은 검증 모드와 무관하게 지도 그릴 때 주입).
      if (on) setStage(row, true, T("3트랙 켜짐 → 지도 그릴 때 적용(검증 모드와 무관)","3-track on → applied when maps are drawn (independent of verify mode)"));
      const sp=d.scoutPrompt; if(!sp) return;
      if (!holdB && document.activeElement !== $("bScout") && !baseDirty.scout) $("bScout").value = sp.baseline||"";
      const sov=$("bScoutOv"); if(sov) sov.textContent = sp.overridden ? T("· (수정됨 — 이후 지도는 실측과 비교 불가 표시)","· (modified — later maps marked incomparable to the measurement)") : T("· (기본값)","· (default)");
      const fmt=$("bScoutFmt"); if(fmt) fmt.textContent = "["+T("형식 버전 ","format version ")+sp.version+"]\\n"+sp.directive+"\\n\\n"+(sp.notes||[]).join("\\n");
    });
    // 런타임 라이브러리 없으면 저장/복원이 무효 → 거짓 성공 방지: 버튼 비활성 + 경고(점2 수정).
    const baseOk = d.baseAvailable !== false;
    if ($("saveB")) $("saveB").disabled = !baseOk;
    if ($("resetB")) $("resetB").disabled = !baseOk;
    if (!baseOk){ const ov=$("baseOv"); if(ov) ov.textContent = T("· ⚠ 런타임 라이브러리를 찾을 수 없어 편집 불가","· ⚠ runtime library not found — editing disabled"); const sb=$("savedB"); if(sb) sb.textContent=""; }
    });
    // 히어로 연결 상태 시각화
    const linked = !!d.linkedId;
    $("linkViz").className = "link" + (linked ? " on" : "");
    $("linkEmo").textContent = "●"; // 색은 .link.on .emo가 처리(연결=초록/미연결=회색)
    $("linkState").textContent = linked ? T("연결됨","Linked") : T("연결 없음","Not linked");
    // 두뇌 '실제 답' 정보 줄 — 표시 문구는 확장이 완성해 보냄(웹뷰는 그대로 게시). 없어도 렌더는 계속(널 가드).
    var baCc = $("ccActualRo"), baCx = $("cxActualRo"), baSc = $("scoutActualRo"), baD = d.brainActual || {};
    if (baSc) baSc.textContent = baD.scout || "";
    if (baCc) baCc.textContent = baD.cc ? T("실제 답: ","actual: ") + baD.cc : "";
    if (baCx) baCx.textContent = baD.cx ? T("실제 답: ","actual: ") + baD.cx : "";
    // statusline: 검증 모드 배지 + 연결 요약
    const st = $("status"); st.replaceChildren();
    const vm = (d.contract && d.contract.verifyMode) || "off";
    const vmTxt = (UI_EN ? {off:"verify off", code:"verify on code change", plancode:"verify on plan+code", always:"verify every turn"} : {off:"검증 꺼짐", code:"코드 변경 시 검증", plancode:"플랜+코드 검증", always:"모든 턴 검증"})[vm] || vm;
    st.appendChild(el("span","badge b-"+vm, vmTxt));
    if (d.workspace) st.appendChild(el("span","wschip", d.workspace));
    if (!d.workspace) st.appendChild(el("span","muted",T("· 워크스페이스가 열려있지 않음","· no workspace open")));
    else if (linked) {
      st.appendChild(el("span","muted","· " + (d.linkedSnippet || T("(주제 미상)","(topic unknown)"))));
      st.appendChild(el("span","id", d.linkedId));
    } else {
      st.appendChild(el("span","muted",T("· 아래에서 Codex 세션을 골라 연결 (미연결 시 ask는 보고만)","· pick a Codex session below to link (unlinked ask only reports)")));
    }
    const cws = $("cwsLabel"); if (cws) cws.textContent = d.workspace ? (T("선택 시 → ","on select → links to ") + d.workspace + T(" 에 연결","")) : T("열린 워크스페이스 없음","no workspace open");

    // 무결성 경보 배너: 미확인 error 이벤트(예: 검증 미완)를 빨강으로 보이고 '확인함'으로 해제.
    safe(function(){
    const ib = $("integrityBanner");
    if (ib) {
      const iev = (d.integrity||[]).filter(function(e){return e && !e.ack && (e.severity==="error"||e.severity==="warning");});
      if (!iev.length) { ib.style.display="none"; ib.replaceChildren(); ib.className="integrity"; }
      else {
        const errEvs = iev.filter(function(e){return e.severity==="error";});
        const nFail = errEvs.filter(function(e){return e.kind==="verdict-nonclean";}).length; // Codex 결론 '실패' = 빨강(대시보드 칩과 일치)
        const nSession = errEvs.filter(function(e){return e.kind==="session-missing";}).length; // 연결 세션 없음 = 빨강(ack 아닌 '연결'로만 해소)
        const nIncomplete = errEvs.length - nFail - nSession; // 검증 미완 — 검증 자체가 안 일어난 미검증 턴(빨강·ack 필요)
        const warnEvs = iev.filter(function(e){return e.severity==="warning";});
        const nVerdict = warnEvs.filter(function(e){return e.kind==="verdict-nonclean";}).length; // 보류·불가(실패는 빨강으로 분리)
        const nMissing = warnEvs.filter(function(e){return e.kind==="verdict-missing";}).length; // 판정 표지 누락(통과 아님과 구분)
        const nDrift = warnEvs.filter(function(e){return e.kind==="brain-drift";}).length; // 두뇌 설정(모델/추론) 어긋남 — 검증과 별개 라벨
        const nEvid = warnEvs.length - nVerdict - nMissing - nDrift; // 근거(evidence-*) 계열
        const errParts = [];
        if (nFail) errParts.push(T("검증 실패 "+nFail+"건","verify failed "+nFail)); // 빨강 — Codex 결론이 통과 아님(실패)
        if (nSession) errParts.push(T("Codex 세션 없음 "+nSession+"건","no Codex session "+nSession)); // 빨강 — 연결된 세션 없음(연결되면 자동 사라짐·확인함으론 안 사라짐)
        if (nIncomplete) errParts.push(T("검증 미완 "+nIncomplete+"건","unverified "+nIncomplete)); // 빨강 — 검증 자체가 안 일어남
        const warnParts = [];
        if (nVerdict) warnParts.push(T("Codex 보류·불가 "+nVerdict+"건","Codex hold/unable "+nVerdict)); // 노랑 — 통과도 실패도 아닌 보류/불가/정보부족
        if (nMissing) warnParts.push(T("판정 표지 없음 "+nMissing+"건","no verdict line "+nMissing)); // 마지막 '검증:' 줄 없음 → 색 표시 빔
        if (nEvid) warnParts.push(T("근거 의심 "+nEvid+"건","evidence doubt "+nEvid)); // 인용 근거가 파일/라인과 안 맞음
        if (nDrift) warnParts.push(T("두뇌 설정 어긋남 "+nDrift+"건","brain setting drift "+nDrift)); // 모델/추론 계열 불일치(설정 미적용 가능 — 검증과 무관)
        const errStr = errParts.join(" · ");
        const warnStr = warnParts.join(" · ");
        ib.replaceChildren();
        ib.className = "integrity" + (errEvs.length ? " err" : " warn"); // 빨강(실패/미완) 있으면 빨강 테두리, 아니면 노랑
        const ih = el("div","ih");
        const head = T("검증 무결성 경보 — ","Verification integrity alert — ") + [errStr, warnStr].filter(Boolean).join(" · "); // 빨강·노랑 라벨을 순서대로(빨강 먼저)
        ih.appendChild(el("span", null, head));
        const ackable = iev.filter(function(e){return e.kind!=="session-missing";}); // session-missing은 ack 대상 아님 — '연결'로만 해소
        if (ackable.length) {
          const ack = el("button","secondary",T("확인함 ✓","Acknowledged ✓"));
          ack.addEventListener("click", function(){ vscode.postMessage({type:"ackIntegrity", ids: ackable.map(function(e){return e.id;})}); }); // 보이는(이 창) ack 가능 경보만 확인 — 다른 창 것 안 지움
          ih.appendChild(ack);
        } else {
          ih.appendChild(el("span","muted",T("연결하면 사라져요 (확인으론 안 닫혀요)","clears when you link (cannot be dismissed)"))); // session-missing만 — '확인함'은 무효라 버튼 대신 안내 문구
        }
        if (iev.some(function(e){return e.sig==="session-missing:blocked";})) { // 자동 생성이 멈춤 → GitHub 이슈로 안내(클릭 시 외부 브라우저)
          const gh = el("a","muted",T("🔗 GitHub에 문제 신고","🔗 Report on GitHub"));
          gh.setAttribute("href","https://github.com/kimbyungsu/codex-peek/issues");
          gh.style.marginLeft = "8px";
          ih.appendChild(gh);
        }
        ib.appendChild(ih);
        const ul = el("ul");
        iev.slice(-6).forEach(function(e){
          const li = el("li");
          li.appendChild(el("span","sevdot " + (e.severity==="error"?"err":"warn")));
          li.appendChild(document.createTextNode(e.detail || e.kind || T("무결성 신호","integrity signal")));
          if (e.ts) li.appendChild(el("span","when","  ("+new Date(e.ts).toLocaleString()+")"));
          ul.appendChild(li);
        });
        ib.appendChild(ul); ib.style.display="";
      }
    }
    });

    // 검증 진행 스트립: 라이브 단계가 있으면 [Claude]⟷[Codex] 방향+활성 박스+단계칩. (완료/대기면 숨김)
    safe(function(){
    const ls = $("liveStrip");
    if (ls) {
      const lv = d.live;
      if (!lv || lv.key === "done") { ls.style.display="none"; }
      else {
        const toCodex = (lv.key === "codex-req" || lv.key === "codex-gen");
        const toClaude = (lv.key === "rejudge");
        $("lsArrow").textContent = toCodex ? T("▶▶▶ 검증중","▶▶▶ verifying") : toClaude ? T("반영중 ◀◀◀","applying ◀◀◀") : "⟷";
        $("lsArrow").className = "lsarrow " + (toCodex ? "tocodex" : toClaude ? "toclaude" : "");
        $("lsClaude").className = "lsbox claude" + ((lv.key==="claude"||toClaude) ? " on" : "");
        $("lsCodex").className = "lsbox codex" + (toCodex ? " on" : "");
        const sg = $("lsStage"); sg.replaceChildren();
        sg.appendChild(el("span","lschip "+lv.key, lv.label + (lv.round>1 ? T(" · "+lv.round+"라운드"," · round "+lv.round) : "")));
        ls.style.display="";
      }
    }
    });

    const conv = $("conv"); conv.replaceChildren();
    if (!d.linkedId) conv.appendChild(el("div","card muted",T("아직 연결된 Codex 세션이 없어요. 아래에서 세션을 연결하면, 구현↔검증으로 실제 주고받은 대화가 여기에 그대로 표시됩니다(눈으로 검증 확인).","No Codex session linked yet. Link one below and the actual implement↔verify exchange shows here (verify with your own eyes).")));
    else if (!d.turns.length) conv.appendChild(el("div","card muted",T("연결됨 — 아직 주고받은 대화가 없습니다(또는 세션 파일을 못 찾음).","Linked — no exchange yet (or the session file was not found).")));
    else {
      if (d.turnsTrimmed) conv.appendChild(el("div","card muted",T("대화가 매우 길어 오래된 턴 일부가 보관 상한(메시지 4,000개)으로 절삭됐습니다 — 설정한 턴 수보다 적게 보일 수 있고, 보존된 최근 턴은 아래에 전부 표시됩니다.","This conversation is very long, so some oldest turns were dropped by the retention cap (4,000 messages) — fewer turns than configured may appear; everything retained is shown below.")));
      if (d.turnsInnerTrimmed) conv.appendChild(el("div","card muted",T("가장 오래된 표시 턴이 매우 길어, 그 턴 '내부'의 오래된 Codex 답변 일부가 보관 상한으로 생략됐습니다(사용자 메시지와 최신 답변은 보존).","The oldest visible turn is very long, so some of the oldest Codex replies inside that turn were omitted by the retention cap (the user message and latest replies are kept).")));
      d.turns.forEach((t) => {
        const wrap = el("div","turn");
        if (t.user) wrap.appendChild(el("div","umsg", t.user));
        let body=null, more=null, ckey=null;
        if (t.assistant.length){
          const txt = t.assistant.join("\\n\\n");
          const vd = t.verdict || null; // 호스트가 extractVerdict로 계산해 넘긴 '마지막 결론'(첫 줄 추측 아님)
          // 4단계: 통과(초록)/통과·보완(노랑)/결론 보류(주황)/실패(빨강). '통과·보완'은 보류와 분리(엄연히 통과).
          const vmap = UI_EN ? {"pass":["pass","verified: pass"],"pass-notes":["notes","pass (notes)"],"inconclusive":["inconc","inconclusive"],"fail":["fail","verify failed"]} : {"pass":["pass","검증 통과"],"pass-notes":["notes","통과·보완"],"inconclusive":["inconc","결론 보류"],"fail":["fail","검증 실패"]};
          const vinfo = vd ? vmap[vd] : null;
          const v = el("div", "vmsg" + (vinfo ? " " + vinfo[0] : ""));
          const head = el("div","vhead");
          head.appendChild(el("span","vname","Codex"));
          if (vinfo) head.appendChild(el("span","vchip " + vinfo[0], vinfo[1]));
          v.appendChild(head);
          ckey = convKey(t); // 내용 기반 안정 키(완료된 답변은 내용 불변 → 재렌더돼도 같은 키로 매칭)
          body = el("div","vbody clip", txt);
          v.appendChild(body);
          more = el("button","more",T("펼치기 ▾","Expand ▾"));
          more.addEventListener("click", () => {
            const clipped = body.classList.toggle("clip");
            more.textContent = clipped ? T("펼치기 ▾","Expand ▾") : T("접기 ▴","Collapse ▴");
            if (clipped) expandedConv.delete(ckey); else expandedConv.add(ckey); // 펼침/접힘을 기억(다시 접기 전까지 유지)
          });
          v.appendChild(more);
          wrap.appendChild(v);
        }
        conv.appendChild(wrap);
        if (body && more && body.scrollHeight <= body.clientHeight + 2){ body.classList.remove("clip"); more.style.display = "none"; }
        else if (body && more && expandedConv.has(ckey)){ body.classList.remove("clip"); more.textContent = T("접기 ▴","Collapse ▴"); } // 사용자가 펼쳐둔 긴 답변은 재렌더 후에도 펼친 채 유지
      });
    }
    const mkRow = (c, hidden) => {
      const row = el("div","cand" + (c.linked?" linked":""));
      const left = el("div");
      const idline = el("div","id", c.id + (c.linked?"  ":""));
      if (c.linked) idline.appendChild(el("span","star",T("★연결됨","★linked")));
      left.appendChild(idline);
      left.appendChild(el("div","muted", c.when + " · " + c.snippet));
      row.appendChild(left);
      const acts = el("div","cacts");
      if (hidden){
        const r=el("button","secondary",T("복원","Restore")); r.setAttribute("data-restore", c.id); acts.appendChild(r);
        const p=el("button","secondary del",T("삭제","Delete")); p.title=T("영구 삭제 (대화 파일이 지워지며 되돌릴 수 없음)","Permanently delete (removes the conversation file · irreversible)"); p.setAttribute("data-purge", c.id); acts.appendChild(p);
      } else {
        if (!c.linked){ const b=el("button",null,T("연결","Link")); b.setAttribute("data-relink", c.id); acts.appendChild(b); }
        const x=el("button","secondary del",T("숨김","Hide")); x.title=T("목록에서 숨기기 (원본 파일은 보존 · 복원 가능)","Hide from list (file preserved · restorable)"); x.setAttribute("data-del", c.id); acts.appendChild(x);
      }
      row.appendChild(acts);
      return row;
    };
    const cs = $("cands"); cs.replaceChildren();
    d.candidates.forEach((c) => cs.appendChild(mkRow(c, false)));
    if (!d.candidates.length && d.sessionDiag) {
      const g = d.sessionDiag;
      const box = el("div","card");
      box.style.cssText = "border-left:3px solid var(--vscode-inputValidation-warningBorder,#c90);background:var(--vscode-inputValidation-warningBackground,rgba(204,153,0,0.12));font-size:12px;line-height:1.7";
      box.appendChild(el("div","", T("⚠ 찾은 Codex 세션이 없습니다 — 지금 이 위치를 보고 있어요:","⚠ No Codex sessions found — currently looking at:")));
      const line = (label,val,note) => { const r=el("div"); r.appendChild(el("span","muted",label)); r.appendChild(el("code","",val)); if(note) r.appendChild(el("span","muted"," "+note)); box.appendChild(r); };
      line(T("세션 폴더: ","sessions dir: "), g.sessionsDir, g.sessionsExists ? T("(있음·비어있음)","(exists · empty)") : T("(폴더 없음)","(missing)"));
      line("Codex home: ", g.home, T("(출처: ","(source: ")+g.source+")");
      line(T("codex 실행파일: ","codex binary: "), g.codexBin, "");
      box.appendChild(el("div","muted",T("여기에 당신의 Codex 대화가 없다면, codex가 세션을 다른 곳에 저장하는 것입니다. 터미널에서 'codex doctor'의 CODEX_HOME과 위 경로를 비교해, 다르면 설정 codexBridge.codexPath(또는 환경변수 CODEX_HOME)로 맞춰 주세요.","If your Codex conversations are not here, codex stores sessions elsewhere. Compare CODEX_HOME from codex doctor in a terminal with the path above; if different, set codexBridge.codexPath (or the CODEX_HOME env var).")));
      cs.appendChild(box);
    }
    // 숨긴 세션: 접힌 채로, 개수 토글로 펼침 (원본은 지우지 않음)
    const hw = $("hiddenWrap"); hw.replaceChildren();
    if (d.hiddenCandidates && d.hiddenCandidates.length){
      const n = d.hiddenCandidates.length;
      const tg = el("button","linklike",T("숨긴 세션 "+n+"개 보기","Show "+n+" hidden sessions")); tg.id="hiddenToggle";
      const box = el("div"); box.id="hiddenList"; box.style.display="none";
      d.hiddenCandidates.forEach((c) => box.appendChild(mkRow(c, true)));
      hw.appendChild(tg); hw.appendChild(box);
    }
    // 두뇌 설정(모델·생각강도): 현재값 보기 + 저장된 선택 반영(미저장 편집은 보존). 옵션은 계정 캐시 기반.
    AVAIL = d.availModels || [];
    const cw=$("mCacheWarn"); if(cw){ cw.textContent=d.modelsCacheNote||""; cw.style.display=d.modelsCacheNote?"":"none"; }
    const nameOf=(slug)=>{ const m=AVAIL.find((x)=>x.slug===slug); return m?m.name:(slug||""); };
    const effLabel=(e)=>RSKO[e]||(e||T("미상","unknown"));
    $("mCur").textContent = d.linkedId ? ((nameOf(d.modelCurrent)||T("미상","unknown"))+T(" · 생각강도 "," · reasoning ")+effLabel(d.effortCurrent)) : T("연결된 세션 없음","no linked session");
    // 모델 선택 = <select> 드롭다운(항상 전체 목록). 옛 <input list=datalist>는 입력값으로 후보를 필터해서
    // 저장된 모델이 채워지면 그 모델만 보이는 버그가 있었음 → select로 교체(전체가 늘 보임).
    const sel=$("mModel");
    const prevModelVal = sel.value; // ★ replaceChildren가 select 값을 ""로 리셋하므로, dirty 비교·복원용으로 먼저 보관
    sel.replaceChildren();
    const addOpt=(v,t)=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; sel.appendChild(o); };
    addOpt("", T("(코덱스 기본값)","(Codex default)"));
    const opts = AVAIL.length ? AVAIL.map((m)=>({v:m.slug,t:m.name})) : (d.knownModels||[]).map((s)=>({v:s,t:s}));
    opts.forEach(({v,t})=> addOpt(v, (t&&t!==v) ? (t+" ("+v+")") : v));
    const savedM = d.modelPref||"";
    if(savedM && !opts.some((o)=>o.v===savedM)) addOpt(savedM, savedM+T(" (저장된 값 · 현재 목록에 없음)"," (saved · not in current list)")); // 목록 밖 저장값 보존(조용히 안 바뀌게)
    const firstM=(appModel===null), pRS=appRS, pModel=appModel;
    appRS=d.reasoningPref||""; appModel=d.modelPref||"";
    // dirty 비교는 'replaceChildren 전 값(prevModelVal)'으로 — 안 그러면 select가 ""로 리셋돼 늘 dirty 오판.
    const mDirty=!firstM && ((curRS!==pRS) || (prevModelVal!==(pModel||"")));
    if(firstM || !mDirty){ curRS=appRS; sel.value=appModel; } // 편집 중 아니면 저장값 표시(복원)
    else { sel.value=prevModelVal; } // 편집 중이면 사용자가 고르던 값 되돌림(replaceChildren 리셋 보정)
    renderReasonButtons($("mModel").value.trim());  // 현재 모델 기준 생각강도 버튼(내부에서 curRS 하이라이트/검증)
    const vt=$("vtMin"); if(vt && document.activeElement!==vt) vt.value = d.verifyTimeoutMin || 8; // 편집 중이 아니면 저장값 표시
    // (코덱스 드리프트 인라인 경고 제거됨 — 모델/생각강도 어긋남은 상태바/배너 무결성 경고(brain-drift, 확인 가능)로 일원화. computeState의 syncBrainDriftFor가 cx-model/cx-effort 계산.)
    // (Claude 두뇌 카드 렌더도 제거됨 — 동일하게 상태바 drift(무결성 채널)로 이동.)
  });
  // 부팅 자가 치유(3요원 조사 합의): 이 화면은 원래 스스로 데이터를 요청하지 않아(push 전용), 초기 post가 어떤 이유로든
  // 유실되면 다음 poll까지 빈/낡은 화면이 남았다. 로드 직후 1회 refresh를 보내 어떤 경로로 살아난 패널이든 즉시 당겨온다.
  vscode.postMessage({type:"refresh"});
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
  // [갭 수정] 설정·형제확장에서 codex를 못 찾아도 PATH의 codex로 doctor 시도(브릿지 resolveCodex의 PATH 폴백과 대칭).
  // → standalone codex CLI(확장 없이 PATH 설치) 사용자도 home(세션폴더)을 자동 탐지한다. PATH에도 없으면 spawn 실패→finish(false).
  const usePath = !codex;
  // .js codex는 node 래핑 필요. 확장은 electron이라 process.execPath가 node가 아님(Code.exe) →
  // ELECTRON_RUN_AS_NODE=1로 electron을 node처럼 띄워 codex.js doctor 실행(VS Code 확장 표준 기법, node PATH 불요).
  const isJs = !usePath && /\.js$/i.test(codex);
  const useShell = usePath || (!isJs && /\.(cmd|bat)$/i.test(codex)); // PATH codex는 win .cmd/PATHEXT 해석 위해 shell 경유
  const file = usePath ? "codex" : (isJs ? process.execPath : codex);
  const args = !usePath && isJs ? [codex, "doctor"] : ["doctor"];
  const opts: any = { windowsHide: true, shell: useShell };
  if (!usePath && isJs) opts.env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  let out = "";
  try {
    const cp = spawn(file, args, opts);
    // [보완] timeout/kill — PATH의 임의 codex doctor가 멈춰도 finish가 불려 렌더가 지연되지 않게(브릿지 detectCodexHome 30초와 대칭).
    const killer = setTimeout(() => { try { cp.kill(); } catch { /* ignore */ } finish(false); }, 30000);
    cp.stdout?.on("data", (d) => (out += d.toString()));
    cp.stderr?.on("data", (d) => (out += d.toString()));
    cp.on("error", () => { clearTimeout(killer); finish(false); });
    cp.on("close", () => {
      clearTimeout(killer);
      if (done) return; // timeout이 먼저 finish(false)했으면 close 본문(파싱·home 기록·watcher 갱신)은 건너뜀(경합 방어 — finish의 done 가드 밖이라 별도 필요)
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

// ── 마켓 설치 경로: 브릿지 엔진 자동 배치 + 훅 1클릭 설치(설치 → 첫 알림 1클릭 → 완결) ──
// 브릿지 배치 stamp: 확장이 배치했다는 표식. 레포 install.js(수동/개발 흐름)는 이 stamp를 지워 '수동 모드'로 표시 →
// 확장이 개발자의 최신 수동본을 옛 번들본으로 덮지 않는다. stamp가 있으면 확장 버전이 바뀔 때만 재배치(업그레이드).
const BRIDGE_STAMP = path.join(BRIDGE_DIR, ".bridge-deployed-by.json");
function deployBridgeRuntime(context: vscode.ExtensionContext): boolean {
  try {
    const src = path.join(context.extensionPath, "bridge");
    if (!fs.existsSync(src)) return false; // 번들에 bridge 없음(구버전 vsix) → 아무것도 안 함
    const ver = String((context.extension.packageJSON as any)?.version || "");
    const absent = hookSetup.BRIDGE_SCRIPTS.filter((f) => !fs.existsSync(path.join(BRIDGE_DIR, f)));
    let stamp: any = null;
    try { stamp = JSON.parse(fs.readFileSync(BRIDGE_STAMP, "utf8")); } catch { /* 없음/깨짐 = 수동 or 최초 */ }
    // 흐름 구분(Codex 실패 반영): ①stamp 있음=확장 관리 모드 → 버전 다르거나 파일 누락 시 전체 재배치.
    // ②stamp 없음+전부 없음=마켓 fresh → 전체 배치+관리 모드 전환. ③stamp 없음+일부만 없음=손상된 수동 설치 →
    //   누락분만 채우고 stamp는 안 씀(수동 모드 유지 — 개발자가 고친 나머지 파일을 번들로 덮지 않음).
    // ④stamp 없음+전부 있음=정상 수동 설치 → 절대 안 덮음.
    let targets: string[];
    let writeStamp: boolean;
    if (stamp) {
      if (absent.length === 0 && stamp.version === ver) return false; // 같은 버전 배치됨 → 스킵
      targets = hookSetup.BRIDGE_SCRIPTS; writeStamp = true;          // 업그레이드/복구: 전체 재배치
    } else if (absent.length === hookSetup.BRIDGE_SCRIPTS.length) {
      targets = hookSetup.BRIDGE_SCRIPTS; writeStamp = true;          // 마켓 fresh 설치
    } else if (absent.length > 0) {
      targets = absent; writeStamp = false;                            // 손상 수동 설치: 누락분만 보충(수동 모드 유지)
    } else {
      return false;                                                    // 정상 수동 설치 존중
    }
    let allOk = true;
    for (const f of targets) {
      const body = fs.readFileSync(path.join(src, f), "utf8");
      if (!hookSetup.atomicWriteFile(path.join(BRIDGE_DIR, f), body)) allOk = false; // 실행 중 훅과의 충돌 최소화(tmp+rename)
    }
    // stamp는 '전부 성공'일 때만 — 일부 실패 상태를 최신으로 표시하면 다음 활성화가 스킵해 낡은 런타임이 방치됨(Codex 지적).
    // stamp 쓰기 자체도 실패하면 false 반환(관리 모드 표식 없이 파일만 있는 상태 = 다음 활성화가 '수동'으로 오인 — 드물지만 성공으로 위장하지 않음).
    if (writeStamp && allOk) {
      if (!hookSetup.atomicWriteFile(BRIDGE_STAMP, JSON.stringify({ version: ver, ts: new Date().toISOString() }) + "\n")) return false;
    }
    return allOk;
  } catch { return false; } // best-effort — 배치 실패가 확장 활성화를 막지 않음
}

// 훅이 쓸 node 실행 파일 후보: env → 기존 우리 훅의 토큰(이미 동작 중인 표기 재사용) → PATH의 node(where/which로 절대경로) → 관례형 "node".
// ★확장 호스트 process.execPath는 Code.exe라 후보에 넣지 않는다(Codex 지적).
function nodeTokenCandidates(): Array<string | undefined> {
  const cands: Array<string | undefined> = [process.env.CODEX_BRIDGE_NODE];
  try { // 기존 settings.json에 우리 훅이 하나라도 있으면 그 명령의 node 토큰을 재사용(이미 그 환경에서 동작 중인 표기)
    const s = JSON.parse(fs.readFileSync(claudeSettingsFile(), "utf8"));
    for (const ev of Object.keys(s.hooks || {})) {
      const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      for (const g of arr) for (const e of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
        if (e && typeof e.command === "string" && hookSetup.isOurHookCmd(e.command)) {
          const m = e.command.match(/^("[^"]+"|\S+)/); if (m) cands.push(m[1]);
        }
      }
    }
  } catch { /* settings 없음/깨짐 → 다음 후보 */ }
  try { // PATH의 node 절대경로(where/which)
    const cmd = process.platform === "win32" ? "where node" : "which node";
    const r = spawn_sync_where(cmd);
    if (r) cands.push(r);
  } catch { /* ignore */ }
  cands.push("node");
  return cands;
}
function spawn_sync_where(cmd: string): string | undefined {
  try {
    const r = require("child_process").spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 15000 });
    const first = String(r.stdout || "").split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean)[0];
    return r.status === 0 && first ? first : undefined;
  } catch { return undefined; }
}

// 훅 설치 흐름(동의 1클릭): 무엇을 바꾸는지·백업 위치·훅 4줄을 보여주고, [설치]를 눌러야만 병합한다.
async function runHookInstallFlow(): Promise<void> {
  const settingsFile = claudeSettingsFile();
  let tok = hookSetup.resolveNodeToken(nodeTokenCandidates());
  if (!tok) {
    const input = await vscode.window.showInputBox({
      prompt: tE("훅을 실행할 node 실행 파일 경로를 입력하세요 (예: C:\\Program Files\\nodejs\\node.exe)", "Enter the path to the node executable for hooks (e.g. /usr/local/bin/node)"),
      ignoreFocusOut: true,
    });
    if (!input) return;
    tok = hookSetup.resolveNodeToken([input]);
    if (!tok) { void vscode.window.showErrorMessage(tE("그 경로의 node를 셸에서 실행하지 못했습니다 — 경로를 확인해 주세요.", "Could not run node at that path from a shell — please check the path.")); return; }
  }
  const cmds = hookSetup.OUR_HOOKS.map((h) => "· " + hookSetup.hookCommand(tok!.token, BRIDGE_DIR, h.script)).join("\n");
  const detail = tE(
    `바꾸는 파일: ${settingsFile}\n(수정 전 같은 폴더에 settings.json.bak.<시각> 백업을 먼저 만듭니다. 기존 다른 훅은 보존됩니다.)\n\n등록되는 훅 4줄(검증 3 + 탐색 게이트 1 — 게이트는 3트랙 프로젝트에서 기본 켜짐: 지도가 없거나 낡으면 플랜 확정 전 세션당 2회까지 안내 후 통과·오류 시 절대 안 막음·끄기는 scope-gate CLI. 2트랙 프로젝트에선 관측 기록만):\n${cmds}\n\n설치 후 Claude Code 새 세션부터 적용됩니다.`,
    `File to change: ${settingsFile}\n(A settings.json.bak.<time> backup is created first. Other existing hooks are preserved.)\n\nHooks to register (3 verification + 1 recon gate — the gate is on by default in 3-track projects: if the map is missing/stale it prompts before plan confirmation up to 2×/session then passes, never blocks on errors, turn off via the scope-gate CLI. In 2-track projects it only logs observations):\n${cmds}\n\nTakes effect from the next Claude Code session.`,
  );
  const yes = tE("설치", "Install");
  const pick = await vscode.window.showInformationMessage(tE("Claude Code 검증 훅 설치", "Install Claude Code verification hooks"), { modal: true, detail }, yes);
  if (pick !== yes) return;
  const res = hookSetup.installHooks(settingsFile, BRIDGE_DIR, tok.token);
  if (res.ok) {
    // '확장이 설치했다' 표식 — 확장 제거(vscode:uninstall) 시 이 표식이 있을 때만 훅을 자동 정리(레포 install.js 설치분은 안 건드림).
    try { fs.writeFileSync(path.join(BRIDGE_DIR, "hooks-installed-by-extension"), new Date().toISOString(), "utf8"); } catch { /* best-effort */ }
    void vscode.window.showInformationMessage(tE(`검증 훅 설치 완료 — Claude Code 새 세션부터 적용됩니다.${res.backup ? ` (백업: ${res.backup})` : ""}`, `Hooks installed — takes effect from the next Claude Code session.${res.backup ? ` (backup: ${res.backup})` : ""}`));
  } else {
    void vscode.window.showErrorMessage(tE(`검증 훅 설치 실패: ${res.reason || "알 수 없는 이유"}`, `Hook install failed: ${res.reason || "unknown reason"}`));
  }
}

// 활성화 시: 훅 미등록이면 알림 1회(다시 묻지 않음 선택 가능). 명령 codexBridge.installHooks로 언제든 다시 실행 가능.
const HOOKS_PROMPT_DISMISSED = path.join(BRIDGE_DIR, "hooks-prompt-dismissed");
async function maybeOfferHookSetup(): Promise<void> {
  try {
    const st = hookSetup.detectHooks(claudeSettingsFile());
    if (st.installed) return;
    if (fs.existsSync(HOOKS_PROMPT_DISMISSED)) return;
    const review = tE("설치 내용 보기", "Review & install");
    const never = tE("다시 묻지 않음", "Don't ask again");
    const pick = await vscode.window.showInformationMessage(
      tE("Codex Bridge: 검증 훅이 아직 등록되지 않았습니다 — Claude Code가 검증을 부르려면 훅 4개가 필요합니다.", "Codex Bridge: verification hooks are not registered yet — Claude Code needs 4 hooks to run verification."),
      review, never,
    );
    if (pick === never) { try { fs.writeFileSync(HOOKS_PROMPT_DISMISSED, new Date().toISOString(), "utf8"); } catch { /* ignore */ } return; }
    if (pick === review) await runHookInstallFlow();
  } catch { /* best-effort — 제안 실패가 활성화를 막지 않음 */ }
}

export function activate(context: vscode.ExtensionContext): void {
  deployBridgeRuntime(context); // 마켓 설치: 번들 브릿지를 ~/.codex-bridge에 자동 배치(레포 수동 설치는 stamp 없음 → 존중)
  syncCodexBin(); // 브릿지가 쓸 codex 경로를 최신 확장 기준으로 기록
  ensureLangInitialized(); // 첫 실행: language.json 없으면 VS Code UI 언어로 초기값 저장(이후엔 대시보드 토글이 정본)
  // ★포커스 귀속 초기화: 지금 포커스 상태와 현재 설정 모델을 관찰값으로만 기록(활성화 시점 값 자체는 귀속하지 않음 —
  //   '변경' 이벤트에서만 귀속). 이후 포커스 변화를 추적해 '설정 변경이 내 포커스 구간에서 일어났나'를 판정한다.
  if (vscode.window.state.focused) { focusStartMs = Date.now(); focusEndMs = null; }
  lastSeenSettingsModel = readClaudeSettingsModel();
  context.subscriptions.push(vscode.window.onDidChangeWindowState((e) => {
    if (e.focused) { focusStartMs = Date.now(); focusEndMs = null; }
    else if (focusStartMs !== null && focusEndMs === null) focusEndMs = Date.now();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("codexBridge.installHooks", () => { void runHookInstallFlow(); }));
  void maybeOfferHookSetup(); // 훅 미등록 감지 → 동의 1클릭 설치 제안(비동기, 활성화 안 막음)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codexBridge.codexPath")) syncCodexBin();
    }),
  );
  // 상한 TURN_CAP: 증분 판독이 보존하는 '완전한 턴' 수 — 초과 표시 요청은 잘린 턴(user:null 합성)을 만들므로 잠금(설정 UI maximum과 동치·수기 편집 방어).
  const turnsN = () => Math.min(TURN_CAP, Math.max(1, vscode.workspace.getConfiguration("codexBridge").get<number>("recentTurns", 5)));
  const dashboard = new Dashboard(context.extensionUri, turnsN);
  // 창 리로드로 복원되는 대시보드 탭 되살리기 — 미등록이면 복원 탭이 스크립트 없는 영구 빈 화면(사용자 실측 2026-07-06).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("codexBridge", {
      deserializeWebviewPanel: async (panel) => {
        // 복원 패널 '입양'은 새 생성 경로와 다른 길이라 잔여 변수(직렬화 시점 옵션·이중 리로드·ext host 재시작
        // 비대칭)가 '낡은 화면' 반복 증상의 온상이었다(양 감사 합의 2026-07-10) — 복원 탭은 즉시 닫고,
        // 검증된 새 생성 경로로 같은 자리(viewColumn)에 다시 연다(재열기=항상 정상이라는 사용자 실측과 동일 보장).
        const col = panel.viewColumn;
        try { panel.dispose(); } catch { /* 이미 닫힘 */ }
        try { dashboard.show(col); } catch (e) {
          vscode.window.showWarningMessage(tE("대시보드 복원에 실패했어요 — 상태바에서 새로 열어주세요.", "Failed to restore the dashboard — open it again from the status bar."));
        }
      },
    }),
    // 정적 새탭 2종도 리로드 후 죽은 탭으로 남지 않게 — 정적 내용이라 재베이크 비용 0(감사 지적 2026-07-10).
    vscode.window.registerWebviewPanelSerializer("codexBridgeReconGuide", {
      deserializeWebviewPanel: async (panel) => { try { panel.dispose(); } catch { /* 무해 */ } try { openReconGuide(); } catch { /* 무해 */ } },
    }),
    vscode.window.registerWebviewPanelSerializer("codexBridgeScoutHealth", {
      // 재베이크 금지(Codex 반례: 스크립트 없는 정적 패널이라 원래 ws를 저장할 수 없어, 그 순간의 활성 폴더로
      // 다시 구우면 다중 루트에서 '다른 프로젝트 리포트'가 됨) — 리포트는 '열 때 기준' 문서이므로 죽은 탭만 정리.
      deserializeWebviewPanel: async (panel) => { try { panel.dispose(); } catch { /* 무해 */ } },
    }),
  );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 950);
  status.command = "codexBridge.openDashboard"; // 클릭=대시보드. 확인/대시보드 선택은 호버 툴팁의 클릭 링크로(상태바 '바로 위')
  status.name = "Codex Bridge";

  // 검증 진행 '흐름' = [🧑Claude] ▶▶검증중 [🔍Codex] 를 인접한 3개 항목으로 표현. 상태바 항목 1개는 색이 1개뿐이라,
  // 박스별 색을 주려면 항목을 나눠야 한다(우선순위 953>952>951이라 왼→오 인접 배치). 진행 중에만 보이고 평소 숨김.
  // 배경 '채움색'은 VS Code가 error/warning만 허용 → 단계 구분은 '글자색'으로(빨강 배경은 무결성 경보 전용).
  const fClaude = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 953);
  const fArrow = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 952);
  const fCodex = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 951);
  for (const it of [fClaude, fArrow, fCodex]) { it.command = "codexBridge.openDashboard"; it.name = tE("Codex Bridge 검증 진행","Codex Bridge verify progress"); }
  const flowHide = () => { fClaude.hide(); fArrow.hide(); fCodex.hide(); };
  context.subscriptions.push(fClaude, fArrow, fCodex);

  // 무결성 경보: 미확인 동안 '지속 빨강', 확인(ack)하면 사라짐. (새 경보 직후 점멸은 그 반복 setter가 호버를 닫는 부작용이 있어 제거했다 —
  // 아래 pulseIfNew/pulseTimer/lastErrCount는 호환용으로 남았으나 점멸하지 않는다.)
  let lastErrCount = 0;
  let lastRenderKey = ""; // 멱등 가드: 직전 '최종 표시 모델' 키. 같으면 render가 상태바/flow setter를 한 번도 안 불러 $setEntry RPC가 안 나가고 호버가 닫히지 않는다.
  let pulseTimer: NodeJS.Timeout | undefined;
  // pulse(새 경보 직후 500ms 간격 backgroundColor 점멸)는 제거했다 — 그 반복 setter가 render 멱등 가드를 '우회'해 $setEntry RPC를 일으켜,
  // 새 경보가 막 떴을 때 호버를 읽으려 하면 금세 닫히던 원인이었다(Codex 검증). 빨강 배경은 error 분기에서 '단일'로 설정(점멸 없이도 미확인 동안 지속 빨강).
  const pulseIfNew = (count: number) => { lastErrCount = count; };

  const render = () => {
    const ws = dashboardWorkspace();
    const link = workspaceLink(loadLinks(), ws);
    const file = link?.codexSession ? findRolloutById(link.codexSession) : null;
    const snip = file ? firstSnippet(file) : "";
    // 검증 진행 흐름: 진행 중이면 메인 항목을 숨기고 [🧑Claude] ▶▶검증중 [🔍Codex] 3개 항목으로 단계별(글자)색을 보인다.
    const live = computeLiveStage(link?.codexSession ?? null);
    // 두뇌 drift/세션없음을 상태바 갱신 경로에서도 계산(부수효과 — 항상 수행) → 대시보드를 안 열어도 경고가 상태바에 뜬다. 그 뒤 integrity를 읽는다.
    syncBrainDriftFor(ws);
    syncSessionMissing(ws);
    const allIg = readVisibleIntegrity(ws);
    const errs = allIg.filter((e) => !e.ack && e.severity === "error");
    const warns = allIg.filter((e) => !e.ack && e.severity === "warning");
    // 우선순위 error > warning > flow: 미확인 경보(빨강/노랑)가 있으면 상태바는 그걸 보인다(무결성 가시화 우선). 진행 flow는 대시보드 스트립엔 계속 보임.
    const flowActive = !!live && !errs.length && !warns.length && ["claude", "codex-req", "codex-gen", "rejudge"].includes(live.key);

    // ★멱등 가드: 상태바/flow에 '실제로 반영될 최종 표시 모델'이 직전과 같으면 setter를 한 번도 호출하지 않는다 → VS Code $setEntry RPC가 안 나가
    // 호버가 닫히지 않는다(render는 BRIDGE_DIR watch·15초 poll로 자주 돌지만 표시가 같으면 무시).
    // ★키는 '입력 상태 전부'가 아니라 '지금 상태바를 잡는 mode의 표시 요소'만 담는다. 예: 경보(error/warning)가 떠 있으면 연결/스니펫/flow는
    //   화면에 안 보이므로 키에서 제외 → 경보 툴팁을 읽는 중 phase.json(live)·링크 변화로 호버가 닫히지 않는다. pulse(별도 타이머)는 키 밖.
    const mode = (flowActive && live) ? "flow" : errs.length ? "error" : warns.length ? "warning" : !ws ? "noWs" : link?.codexSession ? "linked" : "unlinked";
    // 탐색(3트랙) 상태 줄 — 상태바만으로 '지금 어떤 흐름이 돌고 탐색 타이밍인지' 판단 가능해야(사용자 요청 2026-07-06).
    // 2트랙이면 빈 문자열(기존 표시 무변화=무회귀). 내부 리더는 전부 5s 캐시 재사용 — 렌더 경로 비용 최소.
    const scoutSb = (() => {
      if (!ws || (mode !== "linked" && mode !== "unlinked")) return "";
      try {
        if (loadContract(ws).scoutMode !== "on") return "";
        const live = readScoutLive(ws);
        if (live) return tE(`정찰(3트랙): 지도 생성중… (${live.arm === "deepseek" ? "DeepSeek 정찰" : "기본 정찰 Claude"} · ${new Date(live.startedAt).toLocaleTimeString()} 시작)`, `recon (3-track): generating map… (${live.arm === "deepseek" ? "DeepSeek scout" : "default scout (Claude)"} · started ${new Date(live.startedAt).toLocaleTimeString()})`);
        const sc = readScopeState(ws);
        const maps = readScoutMaps(ws);
        const stale = computeScoutMapStale(ws, sc, maps);
        const scout = !sc ? tE("대기", "idle")
          : sc.note === "no-git" ? tE("변경 기록 없음 — 힌트 불가 · 지도는 최근 수정 기준(직접/자동 지시 실행)", "no change history — hints unavailable · maps from recent edits (direct/auto-directive runs)")
          : sc.note === "no-changes" ? tE("대기(변경 없음)", "idle (no changes)")
          : sc.note === "error" ? tE("변경 기록 읽기 실패", "couldn't read change history")
          : tE(`변경 감지 동작 중 — 후보 ${sc.suggestion?.candidates.length ?? 0}개`, `change sensing active — ${sc.suggestion?.candidates.length ?? 0} candidate(s)`);
        const n = maps?.count ?? 0;
        const last = maps?.latest?.ts ? new Date(maps.latest.ts).toLocaleString() : "";
        const mapsTxt = n
          ? tE(` · 지도 ${n}장(마지막 ${last || "?"}${stale ? ` · 이후 파일 ${stale}개 더 바뀜 = 지도 낡음` : ""})`, ` · ${n} map(s) (last ${last || "?"}${stale ? `, ${stale} file(s) changed since = map stale` : ""})`)
          : tE(" · 지도 없음 — 직접/자동 지시 실행으로 생성", " · no maps — generated on direct/auto-directive runs");
        return tE("정찰(3트랙): ", "recon (3-track): ") + scout + mapsTxt;
      } catch { return ""; }
    })();
    // 두뇌 '실제 답' 정보 줄(연결/미연결 툴팁 공용) — 앱 UI 표기가 서로 어긋나도 믿을 정본(대화 기록 실측).
    const ba = (mode === "linked" || mode === "unlinked") ? brainActualTexts(ws) : { cc: "", cx: "", sig: "" };
    const baLine = (mode === "linked" || mode === "unlinked")
      ? tE(`두뇌 실제 답 — Claude: ${ba.cc} · Codex: ${ba.cx}`, `actual answers — Claude: ${ba.cc} · Codex: ${ba.cx}`)
      : "";
    // LLM 호출 여부 상시 줄(사용자 요청 2026-07-08: 대시보드 안 열어도 상태바에서 판단) — '지금 실행 중' live 신호만
    // 말한다(다음 턴 지시·예약까지 단정 금지 — Codex 보완).
    // 게이트(감사 2026-07-09): 3트랙(scoutMode=on)일 때만 라이브를 읽는다 — 2트랙에서 잔존/수동 live 파일이
    // 정찰 문구를 노출하는 비대칭 차단. flow 모드에서도 읽는 이유: 자동 지시 경로(Claude 턴 안 러너 실행)가
    // 정찰의 '주 실행 경로'인데 그 동안 상태바가 flow 3박스로 바뀌어 표시가 전멸하던 실구멍(감사 B-A) — 3박스 툴팁에 병기.
    const scoutOn = !!ws && (() => { try { return loadContract(ws).scoutMode === "on"; } catch { return false; } })();
    const scoutLiveNow = scoutOn && ws && (mode === "linked" || mode === "unlinked" || mode === "flow") ? readScoutLive(ws) : null;
    const llmLine = (mode === "linked" || mode === "unlinked")
      ? (scoutLiveNow
        ? tE(`⚡ LLM 호출 중: 정찰 지도 생성(${scoutLiveNow.arm === "deepseek" ? "DeepSeek 정찰" : "기본 정찰 Claude"})`, `⚡ LLM call in flight: recon map (${scoutLiveNow.arm === "deepseek" ? "DeepSeek scout" : "default scout (Claude)"})`)
        : scoutOn
        ? tE("지금 실행 중인 LLM 호출 없음 — 변경 감지는 LLM 없이 자동 · 관찰 일지는 추가 LLM 없이 자동 누적", "no LLM call running now — change sensing runs without LLM · the field journal accrues with no extra LLM")
        : tE("지금 실행 중인 LLM 호출 없음", "no LLM call running now")) // 2트랙: 정찰 기능(변경 감지·일지) 설명은 사실이 아니므로 뗌(감사 B-D)
      : "";
    const key = JSON.stringify({
      mode,
      // ★언어도 표시 요소다 — 없으면 언어 전환 후 상태바가 '표시 동일'로 오판돼 갱신을 스킵, 옛 언어 텍스트가 잔존한다(사용자 실측 버그).
      lang: loadLangExt(),
      // error/warning mode: 실제 tooltip 줄은 [...errs,...warns].slice(-4), label은 kind 집합으로 결정 → 그 표시 요소만 담는다.
      alert: (mode === "error" || mode === "warning")
        // 실제 노출 줄에 맞춘다: error 분기 tooltip은 [...errs,...warns].slice(-4), warning 분기 tooltip은 warns.slice(-3).
        ? { l: (mode === "error" ? [...errs, ...warns].slice(-4) : warns.slice(-3)).map((x) => `${x.severity}|${x.kind}|${x.detail || ""}|${x.sig || ""}`),
            ne: errs.length, nw: warns.length,
            ek: errs.map((x) => x.kind).sort().join(","), wk: warns.map((x) => x.kind).sort().join(","),
            blocked: errs.some((x) => x.sig === "session-missing:blocked") }
        : null,
      flow: (mode === "flow" && live) ? `${live.key}|${live.round}|${live.label}|${live.color}` : null,
      link: mode === "linked" ? `${link?.codexSession || ""}|${link?.linkedAt || ""}|${!!file}|${snip}` : null,
      scout: scoutSb || null, // 3트랙 상태·지도 수도 표시 요소 — 빠지면 지도 추가 후 툴팁이 낡은 수를 유지
      // 실제 답은 '모델 정체'만 키에 담는다(sig) — 경과 시간까지 담으면 매분 키가 바뀌어 열려 있는 호버가 분마다 닫힌다
      // (멱등 가드의 존재 이유). 대가: 툴팁의 '분 전' 표기는 다른 상태 변화가 있을 때 갱신(모델이 바뀌면 항상 즉시 갱신).
      ba: ba.sig || null,
      llm: scoutLiveNow ? scoutLiveNow.arm : "none", // LLM 상시 줄+flow 병기의 정찰 라이브 상태 — 켜짐/꺼짐 전환 시 즉시 갱신
    });
    if (key === lastRenderKey) return; // 표시 동일 → status/flow 갱신 전체 skip(불필요 RPC·호버 닫힘 방지)
    lastRenderKey = key;

    if (!ws) {
      status.text = "$(plug) Codex";
      status.tooltip = tE("워크스페이스 없음","no workspace");
      status.backgroundColor = undefined; // 무결성 빨강 등 이전 색 잔존 방지(아래 무결성 분기가 다시 칠할 수 있음)
    } else if (link?.codexSession) {
      // $(telescope) 접미 = 3트랙 탐색 켜짐 신호 — 대시보드를 안 열어도 상태바만으로 인지(툴팁에 상세 흐름).
      // 지도 생성이 실제 도는 동안만 '탐색중' 라벨(회전 아이콘) — 평시엔 아이콘만(거짓 신호 방지: 늑대소년 회피).
      const scoutBusy = scoutSb.includes(tE("지도 생성중…", "generating map…"));
      status.text = `$(link) Codex: ${(snip || link.codexSession).slice(0, 14)}` + (scoutBusy ? " $(sync~spin) " + tE("탐색중", "scouting") + (scoutLiveNow && scoutLiveNow.arm === "deepseek" ? "·DeepSeek" : "") : scoutSb ? " $(telescope)" : "");
      status.tooltip = new vscode.MarkdownString(
        tE(`**Codex Bridge — 연결됨**\n\n`,`**Codex Bridge — linked**\n\n`) +
          tE(`세션: `,`session: `) + `\`${link.codexSession}\`\n\n` +
          tE(`주제: `,`topic: `) + `${snip || "-"}\n\n` +
          tE(`연결: `,`linked: `) + `${link.linkedAt ? new Date(link.linkedAt).toLocaleString() : "-"}\n\n` +
          (file ? "" : tE("⚠️ 세션 파일을 찾을 수 없음\n\n","⚠️ session file not found\n\n")) +
          (scoutSb ? scoutSb + "\n\n" : "") +
          (baLine ? baLine + "\n\n" : "") +
          (llmLine ? llmLine + "\n\n" : "") +
          tE(`클릭 → 대시보드`,`click → dashboard`),
      );
      status.backgroundColor = file ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      status.text = "$(plug) " + tE("Codex: 미연결","Codex: not linked") + (scoutSb.includes(tE("지도 생성중…", "generating map…")) ? " $(sync~spin) " + tE("탐색중", "scouting") + (scoutLiveNow && scoutLiveNow.arm === "deepseek" ? "·DeepSeek" : "") : scoutSb ? " $(telescope)" : "");
      status.tooltip = tE("연결된 Codex 세션 없음 · 클릭 → 대시보드에서 연결","No linked Codex session · click → link in dashboard") + (scoutSb ? " · " + scoutSb : "") + (baLine ? " · " + baLine : "") + (llmLine ? " · " + llmLine : "");
      status.backgroundColor = undefined;
    }
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
      // 정찰 라이브는 '글자'로 병기(2026-07-09 사용자 정정: 아이콘·툴팁만으론 2트랙의 작업중/검증중 같은 시각 신호가 아님)
      fArrow.text = (toCodex ? "$(arrow-right) " + tE("검증중","verifying") + " $(arrow-right)" : toClaude ? "$(arrow-left) " + tE("반영중","applying") + " $(arrow-left)" : "$(sync~spin) " + tE("작업중","working")) + (live.round > 1 ? ` ·${live.round}R` : "") + (scoutLiveNow ? " $(telescope) " + tE("탐색중","scouting") + (scoutLiveNow.arm === "deepseek" ? "·DeepSeek" : "") : "");
      fArrow.color = c;
      // LLM 문구는 단계별 사실만(감사 B-B: 전 단계 'Codex 검증' 단정은 claude/rejudge 단계에서 거짓): Codex 호출
      // 단계만 검증 LLM, claude/rejudge는 Claude 작업/반영. 정찰 러너가 이 턴 안에서 돌면(자동 지시 주 경로) 병기(감사 B-A).
      const flowLlm = toCodex
        ? tE(`\n\n⚡ LLM 호출 중: Codex 검증`,`\n\n⚡ LLM call in flight: Codex verification`)
        : toClaude
        ? tE(`\n\nClaude가 검증 답을 반영 중`,`\n\nClaude is applying the verdict`)
        : tE(`\n\nClaude 작업 중`,`\n\nClaude working`);
      const flowScout = scoutLiveNow
        ? tE(`\n\n⚡ 정찰 지도 생성 중(${scoutLiveNow.arm === "deepseek" ? "DeepSeek 정찰" : "기본 정찰 Claude"}) — 이 턴 안에서 실행`,`\n\n⚡ recon map generating (${scoutLiveNow.arm === "deepseek" ? "DeepSeek scout" : "default scout (Claude)"}) — running inside this turn`)
        : "";
      fArrow.tooltip = new vscode.MarkdownString(tE(`**검증 진행 — `,`**verify progress — `) + `${live.label}**` + `${live.round ? tE(` (라운드 ${live.round})`,` (round ${live.round})`) : ""}` + flowLlm + flowScout + tE(`\n\n클릭 → 대시보드`,`\n\nclick → dashboard`));
      fClaude.show(); fArrow.show(); fCodex.show();
      return; // 흐름은 미확인 경보(error/warning)가 없을 때만 — 아래 메인/무결성 분기 스킵
    }
    flowHide();
    status.color = undefined; // 메인 항목 글자색 잔존 방지

    // 무결성 경보: error(검증 실패=verdict-nonclean / 검증 미완=verify-incomplete)=빨강 우선. 빨강이 있어도 함께 있는 노랑 건수를 같이 보여 '둘 다' 인지되게 한다.
    if (errs.length) {
      const nFail = errs.filter((e) => e.kind === "verdict-nonclean").length; // Codex 결론 '실패'(빨강·재검증 통과 시 자동 해소)
      const nSession = errs.filter((e) => e.kind === "session-missing").length; // 연결 세션 없음(빨강·연결되면 자동 해소, ack 아님)
      const nIncomplete = errs.length - nFail - nSession;                       // 검증 미완(검증 자체가 안 일어남·ack 필요)
      const ekinds = [nFail > 0, nSession > 0, nIncomplete > 0].filter(Boolean).length;
      const label = ekinds > 1 ? tE("Codex 검증 문제","Codex verify issues")
                  : nFail ? tE("Codex 검증 실패","Codex verify failed")
                  : nSession ? tE("Codex 세션 없음","no Codex session")
                  : tE("Codex 검증 미완","Codex verify incomplete");
      const warnTail = warns.length ? ` · 🟡${warns.length}` : ""; // 같이 뜬 노랑(두뇌 어긋남·근거 의심 등)도 건수로 노출
      status.text = `$(alert) ${label} ${errs.length}${warnTail}`;
      const lines = [...errs, ...warns].slice(-4).map((e) => `- ${e.severity === "error" ? "🔴" : "🟡"} ${e.detail || e.kind || tE("경보","alert")}`);
      status.tooltip = alertTooltip(
        tE(`**🔴 빨강 ${errs.length}건${warns.length ? " · 🟡 노랑 " + warns.length + "건" : ""}**\n\n`, `**🔴 red ${errs.length}${warns.length ? " · 🟡 yellow " + warns.length : ""}**\n\n`) +
          lines.join("\n\n") +
          (nFail ? tE(`\n\n검증 실패: 고쳐서 다시 검증해 통과하면 빨강이 사라집니다.`,`\n\nVerify failed: fix, re-verify to pass, and the red clears.`) : ``) +
          (nSession ? tE(`\n\nCodex 세션 없음: 'Codex 세션 연결'에서 수동 연결하거나, 검증을 계속 진행하면 자동 연결을 시도해요(연결되면 사라짐 · '확인함'으론 안 닫힘).`,`\n\nNo Codex session: link manually under 'Codex Session Link', or keep verifying for auto-link (clears when linked · cannot be dismissed).`) : ``) +
          (errs.some((e) => e.sig === "session-missing:blocked") ? tE(`\n\n자동 생성이 멈춰 있어요 — 계속되면 `,`\n\nAuto-creation is paused — if it persists, `) + `[${tE("GitHub에 문제 신고","report on GitHub")}](https://github.com/kimbyungsu/codex-peek/issues)` : ``) +
          (nIncomplete ? tE(`\n\n검증 미완: 이 턴이 '검증 없이' 종료됐을 수 있어요(확인 필요).`,`\n\nUnverified: this turn may have ended WITHOUT verification (needs review).`) : ``),
      );
      status.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      pulseIfNew(errs.length);
    } else if (warns.length) {
      // 노랑 경고: verdict-nonclean(보류·불가 — 실패는 빨강으로 분리됨) + verdict-missing(판정 표지 없음) + evidence-*(인용 근거 의심) + brain-drift(두뇌 어긋남). 빨강(실패/미완)보다 약함, 펄스 없음.
      if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = undefined; }
      lastErrCount = 0;
      const nVerdict = warns.filter((e) => e.kind === "verdict-nonclean").length;
      const nMissing = warns.filter((e) => e.kind === "verdict-missing").length; // 표지 누락 — '통과 아님'과 다름
      const nDrift = warns.filter((e) => e.kind === "brain-drift").length; // 두뇌 설정 어긋남 — 검증 근거와 무관(배너와 동일 분리)
      const nEvid = warns.length - nVerdict - nMissing - nDrift;
      const kinds = [nVerdict > 0, nMissing > 0, nEvid > 0, nDrift > 0].filter(Boolean).length;
      const label = kinds > 1 ? tE("Codex 주의","Codex warnings")
                  : nVerdict ? tE("Codex 보류·불가","Codex hold/unable")
                  : nMissing ? tE("Codex 표지 없음","Codex no verdict line")
                  : nDrift ? tE("두뇌 설정 어긋남","brain setting drift")
                  : tE("Codex 근거 의심","Codex evidence doubt");
      const parts: string[] = [];
      if (nVerdict) parts.push(tE(`보류·불가 ${nVerdict}건`,`hold/unable ${nVerdict}`));
      if (nMissing) parts.push(tE(`판정 표지 없음 ${nMissing}건`,`no verdict line ${nMissing}`));
      if (nEvid) parts.push(tE(`근거 의심 ${nEvid}건`,`evidence doubt ${nEvid}`));
      if (nDrift) parts.push(tE(`두뇌 설정 어긋남 ${nDrift}건`,`brain drift ${nDrift}`));
      const tipHead = parts.join(" · ");
      status.text = `$(warning) ${label} ${warns.length}`;
      status.tooltip = alertTooltip(
        `**🟡 ${tipHead}**\n\n` +
          warns.slice(-3).map((e) => `- ${e.detail || e.kind || tE("주의","warning")}`).join("\n\n"),
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
      // render(상태바)와 post(대시보드 전송)를 예외 격리 — render 후반부가 던지면 '상태바엔 새 경고가 떴는데
      // 대시보드만 조용히 영구 미갱신'이 된다(사용자 실측 2026-07-07: 두뇌 경고가 상태바에만 뜸). 한쪽 실패가 다른쪽을 못 막게.
      try { render(); } catch (e) { console.warn("codex-bridge: status render failed", e); }
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
  // 정찰 라이브 감시: scout-live/ 하위는 BRIDGE_DIR 비재귀 watch가 못 잡음 — '지도 생성중' 등장·해제가 15초 폴에
  // 묶이던 지연 해소(감사 B-E). 폴더는 러너가 만들지만 워처 등록을 위해 선생성(무해).
  try {
    const liveDir = path.join(BRIDGE_DIR, "scout-live");
    fs.mkdirSync(liveDir, { recursive: true });
    watchers.push(fs.watch(liveDir, () => scheduleRender()));
  } catch { /* 감시 실패 → 15초 폴 폴백(기존 동작) */ }
  // 검증 통계 감시: BRIDGE_DIR 비재귀 watch는 하위 stats/를 못 잡으므로 별도. verdicts.jsonl 변경(검증 추가·리텐션) 시 통계 탭 즉시 갱신.
  try {
    const statsDir = path.dirname(VERDICTS_FILE); // BRIDGE_DIR/stats
    fs.mkdirSync(statsDir, { recursive: true });
    watchers.push(fs.watch(statsDir, () => scheduleRender()));
  } catch {
    /* ignore */
  }
  // 두뇌 drift 입력원 감시 ①: Claude settings.json — 앱 /model·/effort가 즉시 다시 쓰므로, 바뀌면 즉시 render로 drift 반영.
  // 상위 폴더(CLAUDE_HOME = CLAUDE_CONFIG_DIR 또는 ~/.claude) 비재귀 watch + 파일명 필터: 원자적 rename 교체에도 견딤(파일 직접 watch는 교체 후 끊긴다). Codex 소스(links/rollout)는 위 watch가 이미 담당.
  // ★포커스 귀속: 모델 값이 실제로 바뀐 변경이 '이 창 포커스 구간'에서 일어났으면 이 프로젝트의 선택으로 기록(cc-intent.json)
  //   → 이 창에선 몇 초 내 즉시 경고(구버전 UX 복원), 타 창엔 영향 없음. 기록 후 render가 새 intent로 재계산.
  try {
    watchers.push(fs.watch(path.dirname(claudeSettingsFile()), (_e, fn) => {
      if (fn && fn !== "settings.json") return;
      try { maybeAttributeSettingsChange(); } catch { /* 귀속 실패가 render를 막지 않음 */ }
      scheduleRender();
    }));
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

  // 두뇌 drift 입력원 감시 ②: 트랜스크립트(CLAUDE_HOME/projects/**/*.jsonl, CLAUDE_CONFIG_DIR일 수 있음)는 응답마다 잦게 append돼 재귀 watch가 과하다 →
  // 15s 주기 폴링으로 '최근 응답 모델' 변화와 drift 해소(적용되면 사라짐)를 따라잡는다. render는 syncBrainDriftFor 1.5s throttle로 비용 한정(폴링 1회=최대 drift 1회).
  const driftPoll = setInterval(() => { try { render(); } catch (e) { console.warn("codex-bridge: status render failed", e); } dashboard.post(); }, 15000); // render 예외가 post를 못 막게 격리(위 scheduleRender와 동일 원칙)

  context.subscriptions.push(
    status,
    { dispose: () => clearInterval(driftPoll) },
    vscode.commands.registerCommand("codexBridge.openDashboard", () => dashboard.show()),
    // 상태바 '확인함' — 호버 툴팁의 클릭 링크(command:codexBridge.ackHere)에서 호출. 이 창에 보이는 미확인 경보만 읽음 처리.
    // ★ 호출 '시점'에 경보 재읽기(렌더 시점 값 재사용 금지) ★ 이 창 id만(다른 창 보존) ★ 실패 정직 보고 ★ 직후 즉시 갱신.
    vscode.commands.registerCommand("codexBridge.ackHere", () => {
      const unacked = readVisibleIntegrity(dashboardWorkspace()).filter(
        (e) => !e.ack && (e.severity === "error" || e.severity === "warning") && e.kind !== "session-missing", // session-missing은 ack 제외 — '연결'로만 해소
      );
      if (!unacked.length) return; // 이미 확인됨/없음(다른 데서 ack) → 무동작
      const ok = ackIntegrity(unacked.map((e) => e.id));
      if (!ok) { vscode.window.showErrorMessage(tE("경고 확인 처리 저장 실패(파일 잠김/권한?) — 잠시 후 다시 시도하세요.","Failed to save acknowledgement (file locked/permission?) — try again shortly.")); return; }
      try { render(); } catch (e) { console.warn("codex-bridge: status render failed", e); }
      dashboard.post();
    }),
    vscode.commands.registerCommand("codexBridge.refresh", () => {
      try { render(); } catch (e) { console.warn("codex-bridge: status render failed", e); }
      dashboard.post();
    }),
    { dispose: () => { watchers.forEach((w) => w.close()); if (debounce) clearTimeout(debounce); if (pulseTimer) clearInterval(pulseTimer); } },
  );

  render();
}

export function deactivate(): void {}
