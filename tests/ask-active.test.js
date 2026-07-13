// 워크스페이스 전체 ask 직렬화 — 문구가 다른 요청/두 번째 --allow-new도 진행 중 검증을 추월할 수 없어야 한다.
const fs = require("fs"), os = require("os"), path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ask-active-"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require("../bridge/contract-lib.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const ws = path.join(home, "repo"); fs.mkdirSync(ws);

console.log("[1] ws당 정확히 1개 — prompt hash가 달라도 두 번째 선점 거부");
const a = CL.claimAskActive(ws, "hash-a", "new");
const b = CL.claimAskActive(ws, "hash-b", "new");
ok(a.claimed === true, "첫 요청 선점");
ok(b.claimed === false && b.rec && b.rec.hash === "hash-a", "문구가 다른 둘째 요청도 기존 active로 차단");
ok(CL.askActiveGuard(b.rec, (pid) => pid === process.pid).reason === "parent-alive", "부모 생존 → 진행 중");

console.log("[2] 자식 PID·세션 ID 내구 기록 + 토큰 소유권");
ok(CL.updateAskActive(ws, "wrong", { childPid: 4242 }) === false, "다른 토큰 갱신 거부");
ok(CL.updateAskActive(ws, a.rec.token, { childPid: 4242, sessionId: "11111111-1111-1111-1111-111111111111" }) === true, "소유자가 자식/세션 기록");
const saved = CL.readAskActive(ws);
ok(saved.childPid === 4242 && !!saved.sessionId, "표식에 자식 PID·세션 ID 보존");
ok(CL.askActiveGuard({ ...saved, pid: 9991 }, (pid) => pid === 4242).reason === "child-alive", "부모가 죽어도 자식 생존이면 차단");
ok(CL.askActiveGuard({ ...saved, pid: 9991, childPid: 9992 }, () => false).reason === "abandoned", "둘 다 죽어도 자동 재전송 대신 사용자 확인 대기");

console.log("[3] 해제 — 정상은 자기 토큰, 비정상 잔재는 명시 confirm");
ok(CL.clearAskActive(ws, "wrong") === false && fs.existsSync(CL.askActiveFileFor(ws)), "다른 토큰 정상 해제 거부");
ok(CL.clearAskActive(ws, a.rec.token) === true && !fs.existsSync(CL.askActiveFileFor(ws)), "자기 토큰 정상 해제");
CL.claimAskActive(ws, "hash-c", "resume");
ok(CL.clearAskActive(ws, null, { manual: true }) === false, "수동 해제 confirm 없으면 거부");
ok(CL.clearAskActive(ws, null, { manual: true, confirm: true }) === true, "사용자 확인 경로만 비정상 잔재 해제");

console.log("[4] 브릿지 배선 — ws 가드가 force-resend/hash 가드보다 선행");
const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
ok(src.indexOf("claimAskActive(ws, promptHash") >= 0 && src.indexOf("claimAskActive(ws, promptHash") < src.indexOf("if (forceResend)"), "--force-resend도 ws 전체 active를 우회하지 못함");
ok(/updateAskActive\(ws, activeRec/.test(src) && /childPid/.test(src) && /sessionId/.test(src), "새 세션 자식 PID·즉시 발견 ID 기록 배선");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
