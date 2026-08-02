// ── 훅 1클릭 설치(마켓 설치 경로)의 정본 로직 — vscode 의존 없음(테스트가 out/hook-setup.js를 직접 실행) ──
// 레포 한방 설치기 install.js와 '같은 규칙'을 쓴다(훅 4개·명령 표기(node "경로", 슬래시 통일)·우리훅 식별 regex·병합 시 타인 훅 보존).
// 한쪽 규칙을 바꾸면 반드시 같이 바꿀 것: install.js(OUR_HOOKS·isOurHookCmd·hookCommand·mergeHooks) ↔ 이 파일.
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

export const BRIDGE_SCRIPTS = ["contract-lib.js", "verify-cap-handoff.js", "codex-bridge.js", "ask-job-worker.js", "codex-hook.js", "codex-plugin-install.js", "contract-inject.js", "verify-guard.js", "codex-guard.js", "deepseek-bridge.js", "scout-gate.js", "project-map.js", "map-runtime.js", "map-bootstrap.js", "map-pipeline.js", "map-bindings.js", "map-adapters.js", "map-freshness.js", "map-reader.js", "map-retrieval.js", "map-cutover.js", "map-probe.js", "map-router.js", "map-enrich.js", "map-intent.js", "enrich-providers.js"]; // ask-job-worker=내구 검증, codex-hook=Codex 구현자 lifecycle. 뒤 MAP 파일=P0.5/P1/P4/P8/P9 런타임(map-adapters→map-reader→map-freshness require 사슬 — P3b 배포 편입)
export const OUR_HOOKS = [
  { event: "UserPromptSubmit", matcher: "", script: "contract-inject.js" },
  { event: "PreToolUse", matcher: "Bash", script: "codex-guard.js" },
  { event: "PreToolUse", matcher: "ExitPlanMode", script: "scout-gate.js" }, // ⑥ 지도 preflight — 3트랙 기본 켜짐(실효 scoutGate·2026-07-09 승격, 2트랙은 관측만)·fail-open·관측 로그
  { event: "Stop", matcher: "", script: "verify-guard.js" },
];

const fwd = (s: string) => String(s).replace(/\\/g, "/");
const q = (s: string) => '"' + s + '"';

// 명령 하나가 "우리 훅"인가 — install.js isOurHookCmd와 동일 regex(경로 경계 매칭, 부분문자열 오탐 방지).
export function isOurHookCmd(cmd: unknown): boolean {
  return /(^|[\\/\s"'])(contract-inject|codex-guard|verify-guard|scout-gate)\.js(?=$|["'\s;,&|)])/.test(String(cmd || ""));
}

// 훅 명령 문자열 — install.js hookCommand와 동일 표기(node토큰 + "브릿지경로/스크립트", 슬래시 통일).
export function hookCommand(nodeToken: string, bridgeDir: string, script: string): string {
  return nodeToken + " " + q(fwd(path.join(bridgeDir, script)));
}

// node 토큰이 실제 셸에서 실행되는지(훅 러너와 같은 shell:true 경유) — install.js shellRunsNode와 동일.
export function shellRunsNode(nodeToken: string): boolean {
  try {
    const r = spawnSync(nodeToken + ' -e "process.stdout.write(String(6*7))"', { shell: true, encoding: "utf8", timeout: 20000 });
    return r.status === 0 && String(r.stdout || "").trim() === "42";
  } catch { return false; }
}

// P-5 사전검사 보강: Windows에서 shell:true는 cmd 경유라 PowerShell 무효 문자열(따옴표 경로 시작 —
// PS에선 문자열 나열=ParserError 즉사)을 통과시켰다. Codex는 훅을 감지된 기본 셸(대개 PS)로 실행하므로
// Codex 훅용 토큰은 PS에서도 실제 실행돼야 한다(가정 금지·실검증).
export function shellRunsNodePowerShell(nodeToken: string): boolean {
  if (process.platform !== "win32") return true; // PS 검증은 Windows에서만 의미
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", nodeToken + ' -e "process.stdout.write(String(6*7))"'], { encoding: "utf8", timeout: 20000, windowsHide: true });
    return r.status === 0 && String(r.stdout || "").trim() === "42";
  } catch { return false; }
}

// 후보들을 순서대로 셸 검증해 첫 성공 토큰을 고른다. 절대경로는 따옴표+슬래시로 감싼다.
// ★확장 호스트의 process.execPath는 Code.exe(node 아님)라 후보로 쓰면 안 됨 — 호출측이 후보 목록을 만든다(Codex 지적).
export function resolveNodeToken(candidates: Array<string | undefined | null>): { token: string } | null {
  for (const c of candidates) {
    if (!c || !String(c).trim()) continue;
    const raw = String(c).trim();
    const token = raw === "node" || raw.startsWith('"') ? raw : q(fwd(raw));
    if (shellRunsNode(token)) return { token };
  }
  return null;
}

// Codex 훅용 토큰 해석(P-5): cmd와 PowerShell '둘 다' 실행되는 첫 후보만 채택 — 어느 쪽이 기본 셸이어도 훅이 산다.
// 따옴표 절대경로 토큰은 PS 검증에서 자연 탈락하므로 호출측은 bare "node"를 첫 후보로 넣어라.
export function resolveNodeTokenDual(candidates: Array<string | undefined | null>): { token: string } | null {
  for (const c of candidates) {
    if (!c || !String(c).trim()) continue;
    const raw = String(c).trim();
    const token = raw === "node" || raw.startsWith('"') ? raw : q(fwd(raw));
    if (shellRunsNode(token) && shellRunsNodePowerShell(token)) return { token };
  }
  return null;
}

// settings.json에서 우리 훅 4개가 다 걸려 있는지 감지. 파일 없음=미설치(정상 설치 제안 경로),
// 읽지 못함·JSON 깨짐=unreadable. unreadable이면 화면은 설치 제안을 띄우지 않고 '등록 상태 확인 불가'만
// 알린다 — 판독하지 못한 것을 '훅이 없다'로 말하면 사용자가 이미 있는 훅을 다시 설치하려 한다.
// unreadable은 한국어 문장이라 영문 화면에 그대로 넣으면 언어가 섞인다(검증 [보완]).
// kind/code는 언어 중립 값 — 화면이 이걸 보고 자기 언어로 문장을 만든다.
//   kind: "read"=파일을 읽지 못함(권한·잠금 등) / "parse"=내용이 JSON이 아님 / null=판독 성공
export interface HooksStatus { installed: boolean; missing: string[]; unreadable: string | null; kind?: "read" | "parse" | null; code?: string | null }
export function detectHooks(settingsFile: string): HooksStatus {
  let raw: string | null = null;
  // ⚠ 읽기 오류를 '파일 없음'으로 접으면 '훅 미등록'으로 오판해 설치 안내를 띄운다 —
  // 실제로는 설정을 읽지 못한 것이므로 그 사실을 unreadable로 올린다(검증 [주의] 반영).
  try { raw = fs.readFileSync(settingsFile, "utf8"); }
  catch (e: any) {
    if (!(e && e.code === "ENOENT")) return { installed: false, missing: OUR_HOOKS.map((h) => h.script), unreadable: `settings.json을 읽을 수 없음(${(e && e.code) || "알 수 없는 오류"}) — 권한·파일 잠금 확인 필요`, kind: "read", code: (e && e.code) || null };
  }
  if (raw === null) return { installed: false, missing: OUR_HOOKS.map((h) => h.script), unreadable: null };
  let s: any;
  try { s = JSON.parse(raw); } catch { return { installed: false, missing: OUR_HOOKS.map((h) => h.script), unreadable: "settings.json이 올바른 JSON이 아님", kind: "parse", code: null }; }
  const missing: string[] = [];
  for (const h of OUR_HOOKS) {
    const arr = s && s.hooks && Array.isArray(s.hooks[h.event]) ? s.hooks[h.event] : [];
    const found = arr.some((g: any) => g && Array.isArray(g.hooks) && g.hooks.some((e: any) => e && typeof e.command === "string" && e.command.indexOf(h.script) >= 0 && isOurHookCmd(e.command)));
    if (!found) missing.push(h.script);
  }
  return { installed: missing.length === 0, missing, unreadable: null };
}

// settings.hooks 형식이 병합 가능한지 — install.js checkHooksFormat와 동일 정책(이상하면 건드리지 않고 중단).
function hooksFormatProblem(settings: any): string | null {
  if (settings.hooks === undefined) return null;
  if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return "settings.hooks가 객체가 아닙니다";
  for (const h of OUR_HOOKS) {
    if (settings.hooks[h.event] !== undefined && !Array.isArray(settings.hooks[h.event])) return `settings.hooks.${h.event} 가 배열이 아닙니다`;
  }
  return null;
}

// 동시 읽기 중 손상 방지: tmp 작성 후 rename만 — install.js·브릿지와 동일 패턴.
export function atomicWriteFile(file: string, data: string): boolean {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    for (let i = 0; i < 12; i++) {
      try { fs.renameSync(tmp, file); return true; } catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* best-effort */ } }
    }
  } catch { /* mkdir/tmp 실패 */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return false;
}

// 훅 4개를 settings.json에 병합 — install.js mergeHooks와 동일 의미(우리 옛 엔트리 제거→새로 추가, 타인 훅·그룹 보존).
// 백업: 기존 파일이 있으면 settings.json.bak.<시각> 사본을 먼저 남긴다(README·install.js와 동일 관례).
// 훅 등록이 '실제로' 바뀌었는지 — install.js hooksCanon과 같은 규칙(엔트리 통째 비교, 나열 순서만 흡수).
// command·matcher만 보면 timeout·async·type 변경을 놓치므로 엔트리 전체를 정규화한다.
function canonVal(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canonVal).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonVal(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
export function hooksCanon(hooks: any): string {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "";
  const out: Record<string, string[]> = {};
  for (const ev of Object.keys(hooks).sort()) {
    const arr: any[] = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    out[ev] = arr.map((g) => (g && typeof g === "object" && Array.isArray(g.hooks)
      ? canonVal(Object.assign({}, g, { hooks: g.hooks.map(canonVal).sort() }))
      : canonVal(g))).sort();
  }
  return JSON.stringify(out);
}

export interface InstallResult { ok: boolean; backup?: string; reason?: string; settingsExisted?: boolean; registrationChanged?: boolean }

// 설치 뒤 "언제 적용되나" 안내 — install.js와 대시보드가 같은 문장을 쓰도록 여기서만 만든다.
// 실측 근거(Claude Code 2.0.22 cli.js): 설정 파일을 chokidar로 감시하다가 바뀌면 다시 읽는다
// ("Watching for changes in setting files …" → change 이벤트 → 구독자 재계산). 감시 목록은 세션이
// 시작될 때 '실제로 존재하는 파일'만 담는다(statSync(...).isFile() 통과분). 그래서 세 갈래다:
//   ① 훅 등록 그대로(스크립트 내용만 교체) → 등록된 명령이 매 프롬프트 새 프로세스로 실행되므로 즉시.
//   ② 등록이 바뀌었고 설정 파일은 원래 있었음 → 감시가 잡아 현재 세션에도 반영된다.
//   ③ 설정 파일을 이번에 새로 만듦 → 이미 돌던 세션의 감시 목록에 없으므로 새 세션이 필요하다.
// 항상 "새 세션부터"라고 적으면 ①②에서 틀린 안내가 된다(2026-07-30 사용자 실사고).
// ⚠ 설치기는 '지금 이 파일이 있는가'만 알 뿐, '현재 Claude 세션이 시작될 때 있었는가'는 알 수 없다.
// 그래서 ①②는 단정 뒤에 예외를 덧대지 않고 '조건을 먼저' 써서 두 경우를 함께 밝힌다(읽는 순서 꼬임 방지).
// 설정 파일이 아예 없던 상태에서 시작한 세션은 그 파일을 감시하지 않아 등록이 그대로여도 훅 자체를 모른다.
export function claudeHookApplyNote(opts: { registrationChanged: boolean; settingsExisted: boolean }, en: boolean): string {
  if (!opts.registrationChanged) {
    return en
      ? "Claude hooks: registration is unchanged. A session that started with this settings file present picks up the new scripts from its next prompt; a session that started when the file did not exist needs a restart."
      : "Claude 훅은 등록이 그대로입니다. 이 설정 파일을 가지고 시작한 세션이면 새 스크립트가 다음 프롬프트부터 바로 적용되고, 파일이 아예 없던 상태에서 시작한 세션이면 새 세션이 필요합니다.";
  }
  if (opts.settingsExisted) {
    return en
      ? "Claude hook registration changed. Claude Code watches the settings file, so a session that started with this file picks the change up without restarting; a session that started when the file did not exist needs a restart."
      : "Claude 훅 등록이 바뀌었습니다. Claude Code가 설정 파일 변경을 감시하므로, 이 파일을 가지고 시작한 세션이면 재시작 없이 반영되고 파일이 없던 상태에서 시작한 세션이면 새 세션이 필요합니다.";
  }
  return en
    ? "Claude hooks: the settings file was created just now, so sessions already running are not watching it — start a new Claude Code session."
    : "Claude 훅은 설정 파일을 이번에 새로 만들었습니다. 이미 실행 중인 세션은 그 파일을 감시하고 있지 않으니 새 Claude Code 세션에서 적용됩니다.";
}
// 설정 판독 + 병합 가능 여부 검사 — 미리보기와 실제 설치가 '같은 입력 검증'을 쓰도록 한 곳에 둔다.
// (한쪽만 거부 규칙을 가지면 미리보기가 "등록이 바뀝니다"라고 안내한 뒤 실제 설치가 거부되는
//  어긋남이 생긴다 — 검증 blocker 반례로 실제 4경우에서 재현됐다.)
// raw를 함께 돌려준다 — 파싱·백업·병합이 '한 번 읽은 같은 원문'을 쓰게 하려는 것이다.
// 두 번 읽으면 그 사이 다른 창의 저장이나 일시적 잠금으로 두 번째가 실패해, 백업 없이 첫 스냅샷으로
// 덮어쓰는 경로가 생긴다(검증 blocker 반례로 실제 재현: backupWrites=0).
// raw === null 은 '파일이 정말 없음(ENOENT)'만 뜻한다 — 그 외 읽기 오류는 부재로 축소하지 않는다.
type ReadSettings = { ok: true; settings: any; raw: string | null } | { ok: false; reason: string; kind: "read" | "parse"; code: string | null };
function readSettingsForMerge(settingsFile: string): ReadSettings {
  let raw: string | null = null;
  try { raw = fs.readFileSync(settingsFile, "utf8"); }
  catch (e: any) {
    // ⚠ 모든 예외를 '파일 없음'으로 보면 EACCES·잠금 상태에서 빈 설정으로 병합해 사용자 설정을
    // 백업 없이 지운다(검증 blocker 반례). ENOENT만 부재로 인정하고 나머지는 중단한다.
    if (e && e.code === "ENOENT") return { ok: true, settings: {}, raw: null };
    return { ok: false, reason: `settings.json을 읽을 수 없습니다(${(e && e.code) || "알 수 없는 오류"}) — 덮어쓰지 않고 중단합니다. 권한과 파일 잠금을 확인해 주세요.`, kind: "read", code: (e && e.code) || null };
  }
  let settings: any;
  try { settings = JSON.parse(raw); } catch { return { ok: false, reason: "기존 settings.json이 올바른 JSON이 아닙니다 — 자동 병합을 중단합니다(손상 방지). 파일을 직접 확인해 주세요.", kind: "parse", code: null }; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: false, reason: "settings.json 최상위가 객체가 아닙니다 — 중단합니다.", kind: "parse", code: null };
  const problem = hooksFormatProblem(settings);
  if (problem) return { ok: false, reason: `${problem} — 예상 못한 형식이라 건드리지 않고 중단합니다.`, kind: "parse", code: null };
  return { ok: true, settings, raw };
}

// 설치 '전'에 이 병합이 등록을 실제로 바꿀지 미리 재본다 — 파일을 건드리지 않는다.
// 반환은 세 값: "changed" | "unchanged" | "invalid"(설치가 거부될 입력). boolean으로 뭉개면
// 거부될 입력을 '변경됨'으로 안내하게 된다.
export type RegistrationPreview = "changed" | "unchanged" | "invalid";
// 미리보기 판정과 '거부 원인'을 한 판독에서 함께 낸다 — 나눠 읽으면 그 사이 잠금이 풀렸다 걸렸다 하면서
// 미리보기와 원인 안내가 서로 다른 순간을 말한다(검증 [주의] 반영).
export interface RegistrationPreviewDetail { state: RegistrationPreview; kind: "read" | "parse" | null; code: string | null }
export function previewRegistrationDetailed(settingsFile: string, bridgeDir: string, nodeToken: string): RegistrationPreviewDetail {
  const r = readSettingsForMerge(settingsFile);
  if (!r.ok) return { state: "invalid", kind: r.kind, code: r.code };
  const before0 = hooksCanon(r.settings.hooks);
  const copy0 = JSON.parse(JSON.stringify(r.settings.hooks && typeof r.settings.hooks === "object" && !Array.isArray(r.settings.hooks) ? r.settings.hooks : {}));
  mergeOurHooksInto(copy0, bridgeDir, nodeToken);
  return { state: before0 !== hooksCanon(copy0) ? "changed" : "unchanged", kind: null, code: null };
}
export function previewRegistration(settingsFile: string, bridgeDir: string, nodeToken: string): RegistrationPreview {
  const r = readSettingsForMerge(settingsFile);
  if (!r.ok) return "invalid";
  const before = hooksCanon(r.settings.hooks);
  const copy = JSON.parse(JSON.stringify(r.settings.hooks && typeof r.settings.hooks === "object" && !Array.isArray(r.settings.hooks) ? r.settings.hooks : {}));
  mergeOurHooksInto(copy, bridgeDir, nodeToken);
  return before !== hooksCanon(copy) ? "changed" : "unchanged";
}

// 훅 병합 본체(제자리 수정) — installHooks와 previewRegistration/previewRegistrationDetailed가
// 같은 규칙을 쓰도록 한 곳에 둔다(미리보기와 실제 설치의 판정이 갈리지 않게).
function mergeOurHooksInto(hooks: any, bridgeDir: string, nodeToken: string): void {
  // ⚠ 이벤트 단위로 1회만 정리 — 훅별로 정리하면 같은 이벤트(PreToolUse)에 우리 훅이 2개일 때
  // 두 번째 순회가 첫 번째로 추가한 우리 훅을 지운다(scout-gate 추가 때 발견 — install.js mergeHooks와 동일 수정).
  const byEvent = new Map<string, typeof OUR_HOOKS[number][]>();
  for (const h of OUR_HOOKS) { if (!byEvent.has(h.event)) byEvent.set(h.event, []); byEvent.get(h.event)!.push(h); }
  for (const [event, ours] of byEvent) {
    const arr: any[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned: any[] = [];
    for (const g of arr) {
      if (g && Array.isArray(g.hooks)) {
        const kept = g.hooks.filter((e: any) => !(e && typeof e.command === "string" && isOurHookCmd(e.command)));
        if (kept.length) cleaned.push(Object.assign({}, g, { hooks: kept })); // 우리 것만 있던 그룹은 통째 제거
      } else if (g) cleaned.push(g); // 예상 밖 형식 그룹은 그대로 보존(손실 방지)
    }
    for (const h of ours) cleaned.push({ matcher: h.matcher, hooks: [{ type: "command", command: hookCommand(nodeToken, bridgeDir, h.script) }] });
    hooks[event] = cleaned;
  }
}

export function installHooks(settingsFile: string, bridgeDir: string, nodeToken: string): InstallResult {
  // 입력 판독·검증은 미리보기와 공유한다(어긋남 방지). 원문도 그 판독에서 받은 것을 그대로 쓴다 —
  // 다시 읽으면 두 스냅샷이 생겨 '백업 없이 덮어쓰기'가 가능해진다(검증 blocker 반례).
  const rd = readSettingsForMerge(settingsFile);
  if (!rd.ok) return { ok: false, reason: rd.reason };
  const settings: any = rd.settings;
  const raw: string | null = rd.raw;

  let backup: string | undefined;
  if (raw !== null) {
    backup = `${settingsFile}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { fs.writeFileSync(backup, raw, "utf8"); } catch { return { ok: false, reason: "백업 파일을 만들지 못해 중단합니다(원본 보호)." }; }
  }

  // 병합 전 스냅샷 — 아래에서 settings.hooks를 그 자리에서 고치므로 먼저 떠 둔다(install.js와 같은 함정).
  const hooksBefore = hooksCanon(settings.hooks);
  settings.hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
  mergeOurHooksInto(settings.hooks, bridgeDir, nodeToken);
  if (!atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2) + "\n")) return { ok: false, reason: "settings.json 쓰기에 실패했습니다(잠금/권한). 백업은 남아 있습니다.", backup };
  return { ok: true, backup, settingsExisted: raw !== null, registrationChanged: hooksBefore !== hooksCanon(settings.hooks) };
}

// 우리 훅만 제거(확장 제거 시 정리용) — 타인 훅·그룹 보존, 우리 것 때문에 빈 그룹만 삭제. 깨진 JSON이면 안 건드리고 중단.
// install.js uninstall(stripOurs)과 같은 의미. 바꿀 게 없으면 파일을 안 건드린다(백업도 안 만듦).
export function removeHooks(settingsFile: string): InstallResult {
  let raw: string;
  // ⚠ ENOENT만 '제거할 것 없음'이다. 권한 오류·잠금을 성공으로 돌리면 설정에 훅이 남은 채
  // 호출부(uninstall)가 관리 표식을 지우고 브릿지까지 삭제해 '훅은 남고 실행 스크립트는 없는' 상태가 된다.
  try { raw = fs.readFileSync(settingsFile, "utf8"); }
  catch (e: any) {
    if (e && e.code === "ENOENT") return { ok: true }; // 파일 없음 = 제거할 것 없음
    return { ok: false, reason: `settings.json을 읽을 수 없습니다(${(e && e.code) || "알 수 없는 오류"}) — 훅을 지우지 못했습니다. 권한과 파일 잠금을 확인해 주세요.` };
  }
  let settings: any;
  try { settings = JSON.parse(raw); } catch { return { ok: false, reason: "settings.json이 올바른 JSON이 아님 — 건드리지 않음" }; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings) || !settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return { ok: true };
  let changed = false;
  for (const ev of Object.keys(settings.hooks)) {
    const arr = settings.hooks[ev];
    if (!Array.isArray(arr)) continue;
    const cleaned: any[] = [];
    for (const g of arr) {
      if (g && Array.isArray(g.hooks)) {
        const kept = g.hooks.filter((e: any) => !(e && typeof e.command === "string" && isOurHookCmd(e.command)));
        const hadOurs = kept.length !== g.hooks.length;
        if (hadOurs) changed = true;
        if (kept.length) cleaned.push(Object.assign({}, g, { hooks: kept }));
        else if (!hadOurs) cleaned.push(g); // 원래 비어 있던 그룹은 보존(우리와 무관)
      } else if (g) cleaned.push(g);
    }
    if (cleaned.length) settings.hooks[ev] = cleaned; else delete settings.hooks[ev];
  }
  if (!changed) return { ok: true }; // 우리 훅 없음 → 무변경
  const backup = `${settingsFile}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try { fs.writeFileSync(backup, raw, "utf8"); } catch { return { ok: false, reason: "백업 파일을 만들지 못해 중단합니다(원본 보호)." }; }
  if (!atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2) + "\n")) return { ok: false, reason: "settings.json 쓰기에 실패했습니다.", backup };
  return { ok: true, backup };
}
