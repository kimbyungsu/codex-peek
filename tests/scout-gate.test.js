"use strict";
/*
 * 로드맵 ⑥(플랜 게이트 실험) 테스트 — scout-gate.js 훅(fail-open·기본 off·상한)·scope-gate CLI·
 * 다중 PreToolUse 병합 회귀(같은 이벤트에 우리 훅 2개 — 둘 다 남아야 함).
 * ⚠ ExitPlanMode가 실제로 PreToolUse에 잡히는지는 이 테스트가 증명 못 함(문서 미명시) — 그건 실세션 관측 로그가 판정.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg_"));
process.env.CODEX_BRIDGE_HOME = dir;

const { contractFileFor } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const HOOK = path.join(__dirname, "..", "bridge", "scout-gate.js");
const ws = path.join(dir, "proj");
fs.mkdirSync(ws, { recursive: true });
const runHook = (payload, session) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === "string" ? payload : JSON.stringify({ tool_name: "ExitPlanMode", tool_input: { plan: "..." }, session_id: session || "sess-1", cwd: ws }),
  encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws },
});

console.log("[1] 기본 off — 게이트 미설정이면 아무것도 막지 않음 + 관측 로그는 남음(실험 근거)");
let r = runHook();
ok(r.status === 0, "scoutGate 미설정 → exit 0(통과)");
const logDir = path.join(dir, "scout-gate-log");
const logFiles = fs.readdirSync(logDir);
const logRaw = fs.readFileSync(path.join(logDir, logFiles[0]), "utf8");
ok(logRaw.includes('"tool":"ExitPlanMode"') && logRaw.includes('"inputKeys":["plan"]'), "관측 로그 — 도구명+입력 키 이름만");
ok(!logRaw.includes('"..."'), "플랜 본문은 기록 안 함(내용이 아니라 형태만)");

console.log("[2] 게이트 on + 지도 없음 → 차단(exit 2) + 지시 문구, 세션당 2회 후 통과");
fs.mkdirSync(path.dirname(contractFileFor(ws)), { recursive: true });
fs.writeFileSync(contractFileFor(ws), JSON.stringify({ scoutMode: "on", scoutGate: "plan" }));
r = runHook(undefined, "sess-A");
ok(r.status === 2 && /영향지도부터/.test(r.stderr) && /scope-scout-self/.test(r.stderr), "1회차 → 차단 + 지도 생성 지시");
ok(/끄기: node scripts\/scope-gate/.test(r.stderr), "우회(끄기) 안내 포함 — 잠금 아님");
r = runHook(undefined, "sess-A");
ok(r.status === 2, "2회차 → 차단(상한 내)");
r = runHook(undefined, "sess-A");
ok(r.status === 0, "3회차 → 통과(세션 상한 — 무한 잠금 방지)");
r = runHook(undefined, "sess-B");
ok(r.status === 2, "다른 세션은 상한 별도(다시 1회차부터)");

console.log("[3] 신선한 지도 → 게이트 on이어도 통과 (fresh는 '근거 파일 기록이 있고 그 후 안 바뀜'이 조건)");
const scoutsDir = path.join(dir, "scouts", logFiles[0].replace(/\.jsonl$/, ""));
fs.mkdirSync(scoutsDir, { recursive: true });
fs.writeFileSync(path.join(ws, "seed-fresh.md"), "근거 파일");
fs.writeFileSync(path.join(scoutsDir, "2026-07-07T00-00-00-000Z-00-self.md"), "지도");
fs.writeFileSync(path.join(scoutsDir, "2026-07-07T00-00-00-000Z-00-self.json"), JSON.stringify({ ts: new Date(Date.now() + 60_000).toISOString(), arm: "self", seedFiles: ["seed-fresh.md"] }));
r = runHook(undefined, "sess-C");
ok(r.status === 0, "fresh 지도 → 통과");

console.log("[3b] 레거시 지도(근거 기록 없음 — 2026-07-08 실사고 잠금) → fresh 오판 없이 차단 + '판정 불가' 정직 문구");
fs.writeFileSync(path.join(scoutsDir, "2026-07-07T00-00-01-000Z-00-self.md"), "구버전 지도");
fs.writeFileSync(path.join(scoutsDir, "2026-07-07T00-00-01-000Z-00-self.json"), JSON.stringify({ ts: new Date().toISOString(), arm: "self" })); // seedFiles 없음
r = runHook(undefined, "sess-L");
ok(r.status === 2 && /구버전 지도/.test(r.stderr) && !/낡았다/.test(r.stderr), "레거시 → 차단하되 '낡음' 거짓 단정 없이 재생성 필요 안내");

console.log("[4] fail-open — 깨진 페이로드·비대상 도구는 절대 안 막음");
ok(runHook("{broken json").status === 0, "깨진 stdin → exit 0");
r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Edit", tool_input: {}, session_id: "s", cwd: ws }), encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws } });
ok(r.status === 0, "다른 도구(Edit) → exit 0(방어적)");

console.log("[5] scope-gate CLI — status/on/off·언어 슬롯 갱신");
const CLI = path.join(__dirname, "..", "scripts", "scope-gate.js");
const runCli = (...a) => spawnSync(process.execPath, [CLI, ws, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(/scoutGate: plan/.test(runCli("status").stdout), "status — 현재 값 표시");
ok(runCli("off").status === 0 && /scoutGate: off/.test(runCli("status").stdout), "off → 반영");
fs.writeFileSync(contractFileFor(ws, "en"), JSON.stringify({ scoutMode: "on" }));
ok(runCli("on").status === 0, "on — 성공");
ok(JSON.parse(fs.readFileSync(contractFileFor(ws, "ko"), "utf8")).scoutGate === "plan" && JSON.parse(fs.readFileSync(contractFileFor(ws, "en"), "utf8")).scoutGate === "plan", "ko·en 두 슬롯 모두 갱신(언어 전환 시 설정 소실 방지)");
ok(runCli("erase").status === 2, "미지 명령 거부");

console.log("[6] 다중 PreToolUse 병합 회귀 — 같은 이벤트의 우리 훅 2개가 둘 다 남는다(설치기·확장 패리티)");
const HS = require(path.join(__dirname, "..", "out", "hook-setup.js"));
const sf = path.join(dir, "settings.json");
fs.writeFileSync(sf, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool.js" }] }] } }));
const res = HS.installHooks(sf, dir, "node");
ok(res.ok === true, "installHooks 성공");
const merged = JSON.parse(fs.readFileSync(sf, "utf8"));
const pre = merged.hooks.PreToolUse;
ok(pre.some((g) => g.hooks.some((e) => e.command.includes("codex-guard.js"))) && pre.some((g) => g.hooks.some((e) => e.command.includes("scout-gate.js"))), "PreToolUse에 codex-guard와 scout-gate 둘 다 존재(둘째가 첫째를 지우던 함정 잠금)");
ok(pre.some((g) => g.hooks.some((e) => e.command === "other-tool.js")), "타인 훅 보존");
ok(pre.filter((g) => g.hooks.some((e) => /codex-guard\.js/.test(e.command))).length === 1, "재설치 중복 없음(우리 옛 엔트리 정리)");
const res2 = HS.installHooks(sf, dir, "node");
const merged2 = JSON.parse(fs.readFileSync(sf, "utf8"));
ok(res2.ok && merged2.hooks.PreToolUse.filter((g) => g.hooks.some((e) => /scout-gate\.js/.test(e.command))).length === 1, "멱등 — 두 번 설치해도 각 1개");
// install.js mergeHooks 패리티(소스 계약): 이벤트 단위 정리 구조가 양쪽에 존재
const instSrc = fs.readFileSync(path.join(__dirname, "..", "install.js"), "utf8");
ok(instSrc.includes("byEvent") && /ExitPlanMode/.test(instSrc), "install.js도 이벤트 단위 병합+scout-gate 등록(패리티)");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
