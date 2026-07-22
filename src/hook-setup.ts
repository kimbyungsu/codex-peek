// ── 훅 1클릭 설치(마켓 설치 경로)의 정본 로직 — vscode 의존 없음(테스트가 out/hook-setup.js를 직접 실행) ──
// 레포 한방 설치기 install.js와 '같은 규칙'을 쓴다(훅 4개·명령 표기(node "경로", 슬래시 통일)·우리훅 식별 regex·병합 시 타인 훅 보존).
// 한쪽 규칙을 바꾸면 반드시 같이 바꿀 것: install.js(OUR_HOOKS·isOurHookCmd·hookCommand·mergeHooks) ↔ 이 파일.
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

export const BRIDGE_SCRIPTS = ["contract-lib.js", "codex-bridge.js", "ask-job-worker.js", "codex-hook.js", "codex-plugin-install.js", "contract-inject.js", "verify-guard.js", "codex-guard.js", "deepseek-bridge.js", "scout-gate.js", "project-map.js", "map-runtime.js", "map-bootstrap.js", "map-pipeline.js", "map-bindings.js", "map-adapters.js", "map-freshness.js", "map-reader.js", "map-cutover.js", "map-probe.js"]; // ask-job-worker=내구 검증, codex-hook=Codex 구현자 lifecycle. 뒤 MAP 파일=P0.5/P1/P4 런타임(map-adapters→map-reader→map-freshness require 사슬 — P3b 배포 편입)
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

// settings.json에서 우리 훅 4개가 다 걸려 있는지 감지. 파일 없음=미설치, JSON 깨짐=unreadable(설치 제안은 하되 자동병합은 거부됨).
export interface HooksStatus { installed: boolean; missing: string[]; unreadable: string | null }
export function detectHooks(settingsFile: string): HooksStatus {
  let raw: string | null = null;
  try { raw = fs.readFileSync(settingsFile, "utf8"); } catch { /* 파일 없음 */ }
  if (raw === null) return { installed: false, missing: OUR_HOOKS.map((h) => h.script), unreadable: null };
  let s: any;
  try { s = JSON.parse(raw); } catch { return { installed: false, missing: OUR_HOOKS.map((h) => h.script), unreadable: "settings.json이 올바른 JSON이 아님" }; }
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
export interface InstallResult { ok: boolean; backup?: string; reason?: string }
export function installHooks(settingsFile: string, bridgeDir: string, nodeToken: string): InstallResult {
  let raw: string | null = null;
  try { raw = fs.readFileSync(settingsFile, "utf8"); } catch { /* 파일 없음 → 새로 만듦 */ }
  let settings: any = {};
  if (raw !== null) {
    try { settings = JSON.parse(raw); } catch { return { ok: false, reason: "기존 settings.json이 올바른 JSON이 아닙니다 — 자동 병합을 중단합니다(손상 방지). 파일을 직접 확인해 주세요." }; }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: false, reason: "settings.json 최상위가 객체가 아닙니다 — 중단합니다." };
  }
  const problem = hooksFormatProblem(settings);
  if (problem) return { ok: false, reason: `${problem} — 예상 못한 형식이라 건드리지 않고 중단합니다.` };

  let backup: string | undefined;
  if (raw !== null) {
    backup = `${settingsFile}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { fs.writeFileSync(backup, raw, "utf8"); } catch { return { ok: false, reason: "백업 파일을 만들지 못해 중단합니다(원본 보호)." }; }
  }

  settings.hooks = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};
  // ⚠ 이벤트 단위로 1회만 정리 — 훅별로 정리하면 같은 이벤트(PreToolUse)에 우리 훅이 2개일 때
  // 두 번째 순회가 첫 번째로 추가한 우리 훅을 지운다(scout-gate 추가 때 발견 — install.js mergeHooks와 동일 수정).
  const byEvent = new Map<string, typeof OUR_HOOKS[number][]>();
  for (const h of OUR_HOOKS) { if (!byEvent.has(h.event)) byEvent.set(h.event, []); byEvent.get(h.event)!.push(h); }
  for (const [event, ours] of byEvent) {
    const arr: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned: any[] = [];
    for (const g of arr) {
      if (g && Array.isArray(g.hooks)) {
        const kept = g.hooks.filter((e: any) => !(e && typeof e.command === "string" && isOurHookCmd(e.command)));
        if (kept.length) cleaned.push(Object.assign({}, g, { hooks: kept })); // 우리 것만 있던 그룹은 통째 제거
      } else if (g) cleaned.push(g); // 예상 밖 형식 그룹은 그대로 보존(손실 방지)
    }
    for (const h of ours) cleaned.push({ matcher: h.matcher, hooks: [{ type: "command", command: hookCommand(nodeToken, bridgeDir, h.script) }] });
    settings.hooks[event] = cleaned;
  }
  if (!atomicWriteFile(settingsFile, JSON.stringify(settings, null, 2) + "\n")) return { ok: false, reason: "settings.json 쓰기에 실패했습니다(잠금/권한). 백업은 남아 있습니다.", backup };
  return { ok: true, backup };
}

// 우리 훅만 제거(확장 제거 시 정리용) — 타인 훅·그룹 보존, 우리 것 때문에 빈 그룹만 삭제. 깨진 JSON이면 안 건드리고 중단.
// install.js uninstall(stripOurs)과 같은 의미. 바꿀 게 없으면 파일을 안 건드린다(백업도 안 만듦).
export function removeHooks(settingsFile: string): InstallResult {
  let raw: string;
  try { raw = fs.readFileSync(settingsFile, "utf8"); } catch { return { ok: true }; } // 파일 없음 = 제거할 것 없음
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
