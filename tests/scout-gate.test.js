"use strict";
/*
 * 로드맵 ⑥(플랜 게이트) 테스트 — scout-gate.js 훅(fail-open·상한·2026-07-09 기본 승격: 3트랙 미설정=plan,
 * 2트랙=무조건 off)·scope-gate CLI(실효/저장 구분)·다중 PreToolUse 병합 회귀(같은 이벤트에 우리 훅 2개 — 둘 다 남아야 함).
 * ⚠ ExitPlanMode가 실제로 PreToolUse에 잡히는지는 이 테스트가 증명 못 함(문서 미명시) — 그건 실세션 관측 로그가 판정.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg_"));
process.env.CODEX_BRIDGE_HOME = dir;

const { contractFileFor, ledgerEventsFileFor, normScoutGate } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const HOOK = path.join(__dirname, "..", "bridge", "scout-gate.js");
const ws = path.join(dir, "proj");
fs.mkdirSync(ws, { recursive: true });
const runHook = (payload, session) => spawnSync(process.execPath, [HOOK], {
  input: typeof payload === "string" ? payload : JSON.stringify({ tool_name: "ExitPlanMode", tool_input: { plan: "..." }, session_id: session || "sess-1", cwd: ws }),
  encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws },
});

console.log("[1] 2트랙 무회귀 — 계약 없음/2트랙이면 아무것도 막지 않음 + 관측 로그는 남음");
let r = runHook();
ok(r.status === 0, "계약 없음(2트랙) → exit 0(통과)");
const logDir = path.join(dir, "scout-gate-log");
const logFiles = fs.readdirSync(logDir);
const logRaw = fs.readFileSync(path.join(logDir, logFiles[0]), "utf8");
ok(logRaw.includes('"tool":"ExitPlanMode"') && logRaw.includes('"inputKeys":["plan"]'), "관측 로그 — 도구명+입력 키 이름만");
ok(!logRaw.includes('"..."'), "플랜 본문은 기록 안 함(내용이 아니라 형태만)");
fs.mkdirSync(path.dirname(contractFileFor(ws)), { recursive: true });
// Codex 사전검증 반례 잠금: 2트랙(scoutMode off)에 명시 plan 잔재가 있어도 게이트 비활성(게이트는 지도 전제 — 무회귀)
fs.writeFileSync(contractFileFor(ws), JSON.stringify({ scoutMode: "off", scoutGate: "plan" }));
ok(runHook(undefined, "sess-2t").status === 0, "scoutMode:off + scoutGate:plan 잔재 → 통과(2트랙 무회귀 — Codex 반례 잠금)");
ok(normScoutGate({ scoutMode: "off", scoutGate: "plan" }) === "off" && normScoutGate({}) === "off", "normScoutGate — 2트랙은 명시 plan이어도 실효 off");

console.log("[1b] 기본 승격(2026-07-09) — 3트랙 + 게이트 미설정 = plan(차단) · 명시 off는 존중 · 차단 문구에 관찰 신호 인용");
ok(normScoutGate({ scoutMode: "on" }) === "plan" && normScoutGate({ scoutMode: "on", scoutGate: "off" }) === "off", "normScoutGate — 3트랙 미설정=plan(승격)·명시 off 존중");
fs.writeFileSync(contractFileFor(ws), JSON.stringify({ scoutMode: "on" })); // scoutGate 미설정 — 승격 기본값 경로
fs.mkdirSync(path.dirname(ledgerEventsFileFor(ws)), { recursive: true }); // 관찰 일지(항목 1개 — 표본 부족 줄) 준비
fs.writeFileSync(ledgerEventsFileFor(ws), JSON.stringify({ ts: "t", type: "proposed", sig: "a", text: "src/a.ts ↔ docs/A.md" }) + "\n");
r = runHook(undefined, "sess-P1");
ok(r.status === 2 && /영향지도부터/.test(r.stderr), "3트랙 + 미설정 → 기본 plan으로 차단(승격 동작)");
ok(/후보로만/.test(r.stderr), "차단 문구에 이 프로젝트의 관찰 신호 인용('카드와 한 묶음' 사용자 조건 — 표본 부족이면 부족 줄 그대로)");
fs.writeFileSync(contractFileFor(ws), JSON.stringify({ scoutMode: "on", scoutGate: "off" }));
ok(runHook(undefined, "sess-P2").status === 0, "3트랙 + 명시 off → 통과(사용자 선택 영원히 존중)");
fs.rmSync(ledgerEventsFileFor(ws), { force: true }); // 이후 케이스는 신호 줄 없이(문구 단언 단순화)

console.log("[2] 게이트 on + 지도 없음 → 차단(exit 2) + 지시 문구, 세션당 2회 후 통과");
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
ok(/scoutGate: plan \(명시 plan/.test(runCli("status").stdout), "status — 실효값+저장값(명시) 구분 표시");
ok(runCli("off").status === 0 && /scoutGate: off \(명시 off/.test(runCli("status").stdout), "off → 반영(명시 off로 표시)");
fs.writeFileSync(contractFileFor(ws, "en"), JSON.stringify({ scoutMode: "on", scoutGate: "off" })); // 명시 off — 승격 후에도 반대 슬롯 고지가 뜨는 조합(미설정이면 en도 실효 plan이라 고지 불요가 정상)
ok(runCli("on").status === 0, "on — 성공");
ok(JSON.parse(fs.readFileSync(contractFileFor(ws, "ko"), "utf8")).scoutGate === "plan", "현재 언어(ko) 슬롯 갱신");
ok(JSON.parse(fs.readFileSync(contractFileFor(ws, "en"), "utf8")).scoutGate === "off", "en 슬롯은 안 건드림 — 언어 슬롯 분리(2026-07-09 사용자 결정: 한/영 생활권 분리, API 키만 전역)");
ok(/ⓘ/.test(runCli("on").stdout), "반대 슬롯이 다른 값이면 고지(설정 소실 오해 방지)");
ok(runCli("erase").status === 2, "미지 명령 거부");

console.log("[5b] status 실효/저장 구분(승격 후 — Codex 사전검증 요구): 기본 plan vs 명시 vs 2트랙 비활성");
const ws2 = path.join(dir, "proj2");
fs.mkdirSync(ws2, { recursive: true });
const runCli2 = (...a) => spawnSync(process.execPath, [CLI, ws2, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
fs.writeFileSync(contractFileFor(ws2), JSON.stringify({ scoutMode: "on" }));
let st = runCli2("status").stdout;
ok(/scoutGate: plan \(미설정/.test(st) && /3트랙 기본/.test(st), "3트랙+미설정 → 실효 plan(3트랙 기본)·저장값 미설정으로 구분 표시");
fs.writeFileSync(contractFileFor(ws2), JSON.stringify({ scoutMode: "off", scoutGate: "plan" }));
st = runCli2("status").stdout;
ok(/scoutGate: off \(명시 plan/.test(st) && /비활성\(2트랙/.test(st) && /3트랙을 켜면 적용/.test(st), "2트랙+명시 plan 잔재 → 실효 off·비활성 사유·잔재 거취 고지");
ok(/ⓘ 이 프로젝트는 2트랙/.test(runCli2("on").stdout), "2트랙에서 on → 저장은 되나 비활성임을 고지");

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

console.log("[7] 승격 후 표면 잠금 — 사용자·설치자 표면의 게이트 문맥에 '기본 꺼짐/off' 잔재 0(Codex 3차 반례: SECURITY·COMPATIBILITY·ROADMAP·설치기·훅 정본까지 낡은 정책이 남았었음. HANDOFF는 역사 기록이라 제외)");
for (const f of ["SECURITY.md", "COMPATIBILITY.md", "docs/ROADMAP.md", "README.md", "docs/README.en.md", "PRIVACY.md", "install.js", "src/hook-setup.ts", "bridge/scout-gate.js", "scripts/scope-gate.js"]) {
  const bad = fs.readFileSync(path.join(__dirname, "..", f), "utf8").split(/\r?\n/)
    .filter((ln) => /게이트|scout-gate|ExitPlanMode|[Pp]lan gate/.test(ln) && /기본 꺼짐|기본 off|opt-in, off|default(?::| is)? off/i.test(ln));
  ok(bad.length === 0, f + " — 게이트 문맥 '기본 꺼짐/off' 잔재 0" + (bad.length ? " (발견: " + bad[0].trim().slice(0, 70) + "…)" : ""));
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
