"use strict";
/*
 * verify-guard.js 검증 증명(proof) 판정 테스트 (프레임워크 없음 — node tests/verify-guard.test.js).
 * V1 수정 검증: '명령 문자열을 쳤는가'가 아니라 '브릿지가 실제 성공 응답을 기록한 proof가 이번 턴에 있는가'.
 * 임시 폴더에 CODEX_BRIDGE_HOME(계약·proof)·가짜 transcript를 만들어 verify-guard에 stdin으로 먹인다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const GUARD = path.join(__dirname, "..", "bridge", "verify-guard.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const T0 = "2026-06-21T10:00:00.000Z";   // 사용자 발화(이번 턴 시작)
const TWRITE = "2026-06-21T10:00:01.000Z"; // 그 뒤 파일 수정
const TMID = "2026-06-21T10:00:03.000Z";   // 검증 시점(중간)
const TFRESH = "2026-06-21T10:00:05.000Z"; // 이번 턴 안의 성공 검증
const TLATE = "2026-06-21T10:00:10.000Z";  // 검증 후의 추가 수정
const TSTALE = "2026-06-21T09:00:00.000Z"; // 이전 턴(발화 이전)의 검증

function setup(name, verifyMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vg_" + name + "_"));
  const bridgeDir = path.join(dir, ".codex-bridge");
  const ws = path.join(dir, "ws");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "contract.json"), JSON.stringify({ verifyMode }));
  return { dir, bridgeDir, ws, session: "sess-" + name, transcriptPath: path.join(dir, "tx.jsonl") };
}
const human = (ts, sid) => ({ type: "user", sessionId: sid, timestamp: ts, message: { content: [{ type: "text", text: "해줘" }] } });
const tool = (ts, sid, name) => ({ type: "assistant", sessionId: sid, timestamp: ts, message: { content: [{ type: "tool_use", name, input: {} }] } });
const bash = (ts, sid, cmd) => ({ type: "assistant", sessionId: sid, timestamp: ts, message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } });
function putTx(sb, entries) { fs.writeFileSync(sb.transcriptPath, entries.map((e) => JSON.stringify(e)).join("\n")); }
function putProof(sb, { ts, ws, status = "success", exit = 0, sessionKey, answerChars = 120 } = {}) {
  const dir = path.join(sb.bridgeDir, "proofs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, (sessionKey || sb.session) + ".json"),
    JSON.stringify({ v: 1, claudeSession: sb.session, workspace: ws || sb.ws, ts, codexSession: "x", exit, status, answerChars }));
}
function runGuard(sb, over = {}) {
  const stdin = Object.assign({ transcript_path: sb.transcriptPath, cwd: sb.ws, session_id: sb.session, stop_hook_active: false }, over);
  return cp.spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(stdin), encoding: "utf8", timeout: 30000,
    env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir, CLAUDE_CODE_SESSION_ID: sb.session, CLAUDE_PROJECT_DIR: sb.ws }),
  });
}
function blocked(r) { try { return JSON.parse((r.stdout || "").trim()).decision === "block"; } catch { return false; } }
// env에 CLAUDE_CODE_SESSION_ID를 주지 않는 변형 — reader의 폴백(j.session_id→transcript sessionId) 검증용.
function runGuardNoEnvSession(sb, over = {}) {
  const stdin = Object.assign({ transcript_path: sb.transcriptPath, cwd: sb.ws, session_id: sb.session, stop_hook_active: false }, over);
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir, CLAUDE_PROJECT_DIR: sb.ws });
  delete env.CLAUDE_CODE_SESSION_ID;
  return cp.spawnSync(process.execPath, [GUARD], { input: JSON.stringify(stdin), encoding: "utf8", timeout: 30000, env });
}
function clean(sb) { try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch {} }

// 1) 검증 모드 off → 절대 차단 안 함
(function () {
  console.log("[1] off 모드");
  const sb = setup("off", "off");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  ok(!blocked(runGuard(sb)), "off=통과(차단 안 함)");
  clean(sb);
})();

// 2) always + 수정 + proof 없음 → 차단
(function () {
  console.log("[2] always + proof 없음");
  const sb = setup("noproof", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  ok(blocked(runGuard(sb)), "proof 없으면 차단");
  clean(sb);
})();

// 3) always + 수정 + 신선한 성공 proof → 통과
(function () {
  console.log("[3] always + 신선한 성공 proof");
  const sb = setup("fresh", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TFRESH });
  ok(!blocked(runGuard(sb)), "신선 proof면 통과");
  clean(sb);
})();

// 4) always + 수정 + 이전 턴 proof(발화 이전) → 차단 (V1 핵심)
(function () {
  console.log("[4] 이전 턴 proof는 거름 (V1)");
  const sb = setup("stale", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TSTALE });
  ok(blocked(runGuard(sb)), "stale proof는 인정 안 함→차단");
  clean(sb);
})();

// 5) always + 수정 + 기록된 workspace가 달라도 같은 세션·턴이면 인정 → 통과
//    (브릿지 cwd vs 훅 env 차이로 workspace가 어긋날 수 있어 게이트에서 제외 — 격리는 세션 키가 보장)
(function () {
  console.log("[5] workspace 달라도 같은 세션·턴이면 인정(게이트 아님)");
  const sb = setup("wsmiss", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TFRESH, ws: path.join(sb.dir, "other-ws") });
  ok(!blocked(runGuard(sb)), "ws 기록이 달라도 같은 세션·턴이면 통과");
  clean(sb);
})();

// 6) always + 수정 + status=fail proof → 차단
(function () {
  console.log("[6] 실패 proof는 거름");
  const sb = setup("failp", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TFRESH, status: "fail", exit: 1 });
  ok(blocked(runGuard(sb)), "status!=success 차단");
  clean(sb);
})();

// 7) always + proof 없음 + stop_hook_active → 통과(무한루프 방지)
(function () {
  console.log("[7] stop_hook_active 재진입");
  const sb = setup("reentry", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  ok(!blocked(runGuard(sb, { stop_hook_active: true })), "재진입은 통과");
  clean(sb);
})();

// 8) V1 핵심: 가짜 'echo codex-bridge ask' 명령 + proof 없음 → 차단 (옛 코드는 통과시켰음)
(function () {
  console.log("[8] 가짜 echo codex-bridge ask + proof 없음 (V1 핵심)");
  const sb = setup("fake", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write"), bash(TWRITE, sb.session, "echo codex-bridge ask hi")]);
  ok(blocked(runGuard(sb)), "명령 문자열만으론 인정 안 함→차단");
  clean(sb);
})();

// 9) code 모드 + Write + proof 유무
(function () {
  console.log("[9] code 모드");
  const a = setup("code1", "code");
  putTx(a, [human(T0, a.session), tool(TWRITE, a.session, "Write")]);
  ok(blocked(runGuard(a)), "code+수정+proof없음=차단");
  clean(a);
  const b = setup("code2", "code");
  putTx(b, [human(T0, b.session), tool(TWRITE, b.session, "Write")]);
  putProof(b, { ts: TFRESH });
  ok(!blocked(runGuard(b)), "code+수정+신선proof=통과");
  clean(b);
})();

// 10) plancode 모드 + ExitPlanMode + proof 유무
(function () {
  console.log("[10] plancode 모드(플랜 확정)");
  const a = setup("plan1", "plancode");
  putTx(a, [human(T0, a.session), tool(TWRITE, a.session, "ExitPlanMode")]);
  ok(blocked(runGuard(a)), "plancode+플랜확정+proof없음=차단");
  clean(a);
  const b = setup("plan2", "plancode");
  putTx(b, [human(T0, b.session), tool(TWRITE, b.session, "ExitPlanMode")]);
  putProof(b, { ts: TFRESH });
  ok(!blocked(runGuard(b)), "plancode+플랜확정+신선proof=통과");
  clean(b);
})();

// 11) always + 수정 없음 → 그래도 차단(모든 턴 검증), 신선 proof면 통과
(function () {
  console.log("[11] always는 수정 없어도 검증 필요");
  const a = setup("alw1", "always");
  putTx(a, [human(T0, a.session)]); // 아무 도구도 안 씀
  ok(blocked(runGuard(a)), "always+무수정+proof없음=차단");
  clean(a);
  const b = setup("alw2", "always");
  putTx(b, [human(T0, b.session)]);
  putProof(b, { ts: TFRESH });
  ok(!blocked(runGuard(b)), "always+무수정+신선proof=통과");
  clean(b);
})();

// 12) proof가 '다른 세션' 것만 있음 → 이 세션엔 없음 → 차단
(function () {
  console.log("[12] 다른 세션 proof만 존재");
  const sb = setup("othersess", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TFRESH, sessionKey: "someone-else" });
  ok(blocked(runGuard(sb)), "다른 세션 proof는 이 세션 검증 아님→차단");
  clean(sb);
})();

// 13) 빈 응답 proof(answerChars=0) → 차단 (F3: 응답 존재 증명)
(function () {
  console.log("[13] 빈 응답 proof는 거름 (F3)");
  const sb = setup("emptyans", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TFRESH, answerChars: 0 });
  ok(blocked(runGuard(sb)), "answerChars=0 차단");
  clean(sb);
})();

// 14) 검증 후 또 수정 → 재검증 강제 (F4: 검증=최종상태)
(function () {
  console.log("[14] 검증 후 추가 수정은 재검증 강제 (F4)");
  const a = setup("editafter", "always");
  putTx(a, [human(T0, a.session), tool(TWRITE, a.session, "Write"), tool(TLATE, a.session, "Write")]); // 마지막 수정=TLATE
  putProof(a, { ts: TMID }); // 검증은 마지막 수정 이전
  ok(blocked(runGuard(a)), "마지막 수정 이전 proof는 인정 안 함→차단");
  clean(a);
  const b = setup("editafter2", "always");
  putTx(b, [human(T0, b.session), tool(TWRITE, b.session, "Write"), tool(TLATE, b.session, "Write")]);
  putProof(b, { ts: "2026-06-21T10:00:20.000Z" }); // 마지막 수정 이후
  ok(!blocked(runGuard(b)), "마지막 수정 이후 proof면 통과");
  clean(b);
})();

// 15) 사용자 발화·수정 모두 timestamp 없음 → 턴 경계 불명 → 보수적 차단 (F6)
(function () {
  console.log("[15] timestamp 전무 → 보수적 차단 (F6)");
  const sb = setup("nots", "always");
  fs.writeFileSync(sb.transcriptPath, [
    JSON.stringify({ type: "user", sessionId: sb.session, message: { content: [{ type: "text", text: "해줘" }] } }),
    JSON.stringify({ type: "assistant", sessionId: sb.session, message: { content: [{ type: "tool_use", name: "Write", input: {} }] } }),
  ].join("\n"));
  putProof(sb, { ts: TFRESH }); // proof는 있으나 턴 경계를 못 잡음
  ok(blocked(runGuard(sb)), "timestamp 전무면 stale 오인 막으려 차단");
  clean(sb);
})();

// 16) env에 CLAUDE_CODE_SESSION_ID 없음 → j.session_id 폴백으로 proof 찾음 (D)
(function () {
  console.log("[16] env 세션 없음 → j.session_id 폴백");
  const sb = setup("jsess", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]);
  putProof(sb, { ts: TFRESH });
  ok(!blocked(runGuardNoEnvSession(sb)), "env 없어도 j.session_id로 proof 찾아 통과");
  clean(sb);
})();

// 17) env·j.session_id 둘 다 없음 → transcript sessionId 폴백 (D)
(function () {
  console.log("[17] env·j.session_id 없음 → transcript sessionId 폴백");
  const sb = setup("txsess", "always");
  putTx(sb, [human(T0, sb.session), tool(TWRITE, sb.session, "Write")]); // 줄마다 sessionId=sb.session
  putProof(sb, { ts: TFRESH });
  ok(!blocked(runGuardNoEnvSession(sb, { session_id: undefined })), "transcript sessionId로 proof 찾아 통과");
  clean(sb);
})();

// ── V2: git 저장소에서 Bash 경유(도구 아님) 파일 변경도 감지 ──
let GIT_OK = true;
try { cp.execSync("git --version", { stdio: "ignore" }); } catch { GIT_OK = false; }
function gitSetup(name, verifyMode) {
  const sb = setup(name, verifyMode);
  cp.execSync("git init", { cwd: sb.ws, stdio: "ignore" });
  cp.execSync("git config user.email t@t.t", { cwd: sb.ws, stdio: "ignore" });
  cp.execSync("git config user.name t", { cwd: sb.ws, stdio: "ignore" });
  return sb;
}
const NOW = Date.now();
const T_USER = new Date(NOW - 3600_000).toISOString(); // 1시간 전(이번 턴 시작)
const T_OLD = new Date(NOW - 7200_000);                 // 2시간 전(이전 턴 변경)
const T_PROOF_OK = new Date(NOW + 5000).toISOString();  // 변경 직후(검증)

if (GIT_OK) {
  // 18) code 모드 + 도구 편집 없음 + Bash로 새 파일(이번 턴) → 차단 (V2 핵심: 옛 코드는 통과시켰음)
  (function () {
    console.log("[18] code 모드 + Bash 변경(도구 아님) → 차단 (V2)");
    const sb = gitSetup("v2mod", "code");
    putTx(sb, [human(T_USER, sb.session)]); // Write/Edit 도구 tool_use 없음
    fs.writeFileSync(path.join(sb.ws, "f.txt"), "bash가 만든 변경"); // mtime≈now > T_USER
    ok(blocked(runGuard(sb)), "Bash 변경이 검증 트리거 → proof 없으면 차단");
    clean(sb);
  })();

  // 19) code 모드 + 이전 턴부터 더럽던 파일(이번 턴 변경 없음) → 차단 안 함(오탐 방지)
  (function () {
    console.log("[19] 이전 턴부터 더럽던 파일은 이번 턴 변경 아님 → 통과");
    const sb = gitSetup("v2old", "code");
    putTx(sb, [human(T_USER, sb.session)]);
    const f = path.join(sb.ws, "old.txt");
    fs.writeFileSync(f, "old");
    fs.utimesSync(f, T_OLD, T_OLD); // mtime을 발화 이전으로
    ok(!blocked(runGuard(sb)), "이번 턴에 안 바뀐 파일은 트리거 안 함");
    clean(sb);
  })();

  // 20) code 모드 + Bash 변경 + 변경 이후 성공 proof → 통과
  (function () {
    console.log("[20] Bash 변경 + 변경 이후 proof → 통과");
    const sb = gitSetup("v2proof", "code");
    putTx(sb, [human(T_USER, sb.session)]);
    fs.writeFileSync(path.join(sb.ws, "f.txt"), "변경");
    putProof(sb, { ts: T_PROOF_OK });
    ok(!blocked(runGuard(sb)), "변경 이후 성공 proof면 통과");
    clean(sb);
  })();

  // 21) code 모드 + Bash 변경 + 변경 '이전' proof → 차단 (검증 후 Bash 재수정 = 재검증 강제)
  (function () {
    console.log("[21] Bash 변경 후의 proof 아니면 차단(검증 후 재수정)");
    const sb = gitSetup("v2stale", "code");
    putTx(sb, [human(T_USER, sb.session)]);
    fs.writeFileSync(path.join(sb.ws, "f.txt"), "변경"); // mtime≈now
    putProof(sb, { ts: new Date(NOW - 1800_000).toISOString() }); // 30분 전(변경보다 이전)
    ok(blocked(runGuard(sb)), "변경 이전 proof는 인정 안 함→차단");
    clean(sb);
  })();
  // 22) Bash 삭제(추적 파일 rm)도 감지 — 부모 dir mtime (V2 삭제 보강)
  (function () {
    console.log("[22] Bash 삭제도 감지 (V2 삭제 보강)");
    const sb = gitSetup("v2del", "code");
    const f = path.join(sb.ws, "tracked.txt");
    fs.writeFileSync(f, "x");
    cp.execSync("git add -A", { cwd: sb.ws, stdio: "ignore" });
    cp.execSync("git commit -m init", { cwd: sb.ws, stdio: "ignore" }); // 추적·클린 상태
    fs.utimesSync(sb.ws, T_OLD, T_OLD); // 이번 턴 전에는 dir가 오래됐다고 가정
    fs.unlinkSync(f); // 이번 턴 삭제 → 부모(ws) dir mtime → now
    putTx(sb, [human(T_USER, sb.session)]); // 도구 tool_use 없음
    ok(blocked(runGuard(sb)), "추적 파일 삭제도 트리거→proof 없으면 차단");
    clean(sb);
  })();

  // 23) 대조: 클린 상태(이번 턴 변경 전혀 없음) → 차단 안 함
  (function () {
    console.log("[23] 클린 상태(변경 없음)는 차단 안 함");
    const sb = gitSetup("v2clean", "code");
    const f = path.join(sb.ws, "tracked.txt");
    fs.writeFileSync(f, "x");
    cp.execSync("git add -A", { cwd: sb.ws, stdio: "ignore" });
    cp.execSync("git commit -m init", { cwd: sb.ws, stdio: "ignore" });
    fs.utimesSync(sb.ws, T_OLD, T_OLD); // dir도 오래됨, 작업트리 클린
    putTx(sb, [human(T_USER, sb.session)]);
    ok(!blocked(runGuard(sb)), "변경 없으면 code 모드에서 통과");
    clean(sb);
  })();

  // 24) rm -r dir: 부모 폴더째 삭제 → 존재하는 조상(ws) mtime으로 감지
  (function () {
    console.log("[24] rm -r 폴더째 삭제도 감지 (조상 dir 탐색)");
    const sb = gitSetup("v2rmr", "code");
    const sub = path.join(sb.ws, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "inner.txt"), "x");
    cp.execSync("git add -A", { cwd: sb.ws, stdio: "ignore" });
    cp.execSync("git commit -m init", { cwd: sb.ws, stdio: "ignore" });
    fs.utimesSync(sb.ws, T_OLD, T_OLD);
    fs.rmSync(sub, { recursive: true, force: true }); // sub 폴더째 삭제 → ws mtime now
    putTx(sb, [human(T_USER, sb.session)]);
    ok(blocked(runGuard(sb)), "폴더째 삭제도 조상 dir mtime으로 트리거→차단");
    clean(sb);
  })();
} else {
  console.log("[18-23] git 없음 → V2 테스트 건너뜀");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
