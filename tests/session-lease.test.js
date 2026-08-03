// verifier 세션 전역 lease(설계 §7·증분 3) — 저장소 단위 + 사망 회수 + exit 훅 해제 e2e.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lease_home_"));
process.env.CODEX_BRIDGE_HOME = home;

const cl = require("../bridge/contract-lib.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] 획득·busy·해제 — 전역 1키(ws 무관)");
{
  const a = cl.acquireSessionLease("sess-A", { ws: "D:/p1", mode: "claude-codex", jobId: "j1", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("첫 획득 성공(token 발급)", a.ok === true && typeof a.token === "string" && a.token.length === 16);
  const b = cl.acquireSessionLease("sess-A", { ws: "D:/p2", mode: "claude-codex", jobId: "j2", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("다른 ws의 같은 세션=busy(보유자 정보 포함)", b.ok === false && b.reason === "busy" && b.holder && b.holder.ws === "D:/p1");
  const c = cl.acquireSessionLease("sess-B", { ws: "D:/p2", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("다른 세션은 독립 획득", c.ok === true);
  ck("틀린 token 해제=거부", cl.releaseSessionLease("sess-A", "0".repeat(16)) === false);
  ck("보유자 불변(거부 후에도 busy)", cl.acquireSessionLease("sess-A", { ws: "D:/p3" }).ok === false);
  ck("맞는 token 해제=성공", cl.releaseSessionLease("sess-A", a.token) === true);
  const d = cl.acquireSessionLease("sess-A", { ws: "D:/p3", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("해제 후 재획득 가능", d.ok === true);
  cl.releaseSessionLease("sess-A", d.token);
  cl.releaseSessionLease("sess-B", c.token);
}

console.log("[2] child PID 기록 — token 결속");
{
  const a = cl.acquireSessionLease("sess-C", { ws: "D:/p1", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("틀린 token으로 child 기록=거부", cl.setSessionLeaseChild("sess-C", "0".repeat(16), 12345) === false);
  ck("맞는 token으로 child 기록=성공", cl.setSessionLeaseChild("sess-C", a.token, process.pid) === true);
  ck("기록 확인", cl.readSessionLease("sess-C").childPid === process.pid);
  cl.releaseSessionLease("sess-C", a.token);
}

console.log("[3] 사망 회수 — owner 죽음+childPid 규칙");
{
  // 죽은 pid 확보: 즉시 종료하는 자식
  const deadPid = cp.spawnSync(process.execPath, ["-e", "0"], { windowsHide: true }).pid;
  const file = cl.sessionLeaseFileFor("sess-D");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mk = (extra) => fs.writeFileSync(file, JSON.stringify(Object.assign({ v: 1, session: "sess-D", token: "t".repeat(16), ownerPid: deadPid, childPid: null, ws: "D:/dead", mode: "", jobId: "", deadlineAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString() }, extra)), "utf8");
  mk({});
  const r1 = cl.acquireSessionLease("sess-D", { ws: "D:/new", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("owner 죽음+deadline 경과(child 미기록)=회수 성공", r1.ok === true && r1.reclaimedFrom && r1.reclaimedFrom.ws === "D:/dead");
  cl.releaseSessionLease("sess-D", r1.token);
  // deadline 미래 + child 미기록 → 회수 거부(동기 spawn 아이가 아직 살아있을 수 있음)
  mk({ deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("owner 죽음이라도 deadline 전(child 미기록)=거부", cl.acquireSessionLease("sess-D", { ws: "D:/new" }).ok === false);
  // childPid 살아 있음 → deadline 지나도 거부
  mk({ deadlineAt: new Date(Date.now() - 1000).toISOString(), childPid: process.pid });
  ck("child 생존=회수 거부(동시 resume 차단)", cl.acquireSessionLease("sess-D", { ws: "D:/new" }).ok === false);
  // childPid 죽음 → 즉시 회수(deadline 무관)
  mk({ deadlineAt: new Date(Date.now() + 60_000).toISOString(), childPid: deadPid });
  const r2 = cl.acquireSessionLease("sess-D", { ws: "D:/new2", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("owner·child 모두 죽음=deadline 전이라도 회수", r2.ok === true);
  cl.releaseSessionLease("sess-D", r2.token);
}

console.log("[4] exit 훅 해제 e2e — 프로세스 종료 시 자기 lease만 정리");
{
  const script = path.join(home, "lease-exit.js");
  fs.writeFileSync(script, `
const cl=require(${JSON.stringify(path.resolve(__dirname, "../bridge/contract-lib.js"))});
const a=cl.acquireSessionLease("sess-E",{ws:"D:/e2e",deadlineAt:new Date(Date.now()+60000).toISOString()});
if(!a.ok)process.exit(9);
process.on("exit",()=>{try{cl.releaseSessionLease("sess-E",a.token);}catch{}});
process.exit(0);
`, "utf8");
  const r = cp.spawnSync(process.execPath, [script], { env: Object.assign({}, process.env), windowsHide: true, encoding: "utf8" });
  ck("자식이 획득 후 정상 종료", r.status === 0);
  ck("exit 훅이 lease 해제(파일 소멸)", cl.readSessionLease("sess-E") === null);
}

console.log("[5] cmdAsk 배선 — lease가 예산 게이트보다 먼저(소스 순서 잠금)");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../bridge/codex-bridge.js"), "utf8");
  const iLease = src.indexOf("acquireSessionLease(link.codexSession");
  const iGate = src.indexOf("reserveVerifyBudgetGate(ws, durableEnv", iLease); // 정의부가 아니라 lease 뒤의 '호출' 지점
  const iResume = src.indexOf('runCodex(["resume", link.codexSession');
  ck("배선 실재", iLease > 0 && iGate > 0 && iResume > 0);
  ck("순서: lease → 예산 게이트 → resume", iLease < iGate && iGate < iResume);
  ck("busy 거부는 exit 3(왕복 미소모 경로)", /acquireSessionLease\(link\.codexSession[\s\S]{0,900}?die\(tB\([\s\S]{0,700}?\), 3\)/.test(src));
  ck("해제 exit 훅 등록", src.includes('process.on("exit", () => { try { releaseSessionLease(link.codexSession, lease.token); }'));
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
