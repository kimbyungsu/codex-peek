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
  // childPid 미기록=자동 회수 금지(고아 codex 생존 가능 — 확인 검증 blocker): deadline 지나도 거부.
  mk({});
  const r1 = cl.acquireSessionLease("sess-D", { ws: "D:/new", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("owner 죽음+child 미기록=자동 회수 안 함(deadline 무관 busy)", r1.ok === false && r1.staleOwner === true);
  ck("수동 clear 후에만 재획득", (() => {
    const old = cl.clearSessionLease("sess-D");
    if (!old || old.ws !== "D:/dead") return false;
    const r = cl.acquireSessionLease("sess-D", { ws: "D:/new", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    if (!r.ok) return false;
    cl.releaseSessionLease("sess-D", r.token);
    return true;
  })());
  // childPid 살아 있음 → 거부
  mk({ deadlineAt: new Date(Date.now() - 1000).toISOString(), childPid: process.pid });
  ck("child 생존=회수 거부(동시 resume 차단)", cl.acquireSessionLease("sess-D", { ws: "D:/new" }).ok === false);
  // childPid 기록+owner·child 모두 죽음 → 자동 회수(비동기 runner 경로 — 증분 4)
  mk({ deadlineAt: new Date(Date.now() + 60_000).toISOString(), childPid: deadPid });
  const r2 = cl.acquireSessionLease("sess-D", { ws: "D:/new2", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("owner·child 모두 죽음(child 기록됨)=자동 회수", r2.ok === true && r2.reclaimedFrom && r2.reclaimedFrom.ws === "D:/dead");
  cl.releaseSessionLease("sess-D", r2.token);
}

console.log("[3-1] 잠금 잔재는 자동으로 부수지 않음(교리) — 해소는 clear 단일 경로");
{
  const deadPid = cp.spawnSync(process.execPath, ["-e", "0"], { windowsHide: true }).pid;
  const file = cl.sessionLeaseFileFor("sess-F");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 죽은 pid의 lease + 죽은 pid의 reclaim.lock 잔재를 함께 심는다(강제 종료 재현)
  fs.writeFileSync(file, JSON.stringify({ v: 1, session: "sess-F", token: "t".repeat(16), ownerPid: deadPid, childPid: deadPid, ws: "D:/dead", deadlineAt: "", createdAt: new Date().toISOString() }), "utf8");
  fs.writeFileSync(file + ".reclaim.lock", deadPid + "-zzzzzz", "utf8");
  const r = cl.acquireSessionLease("sess-F", { ws: "D:/new", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("자동 경로는 잠금 잔재에서 busy(안전 방향 — 파기 없음)", r.ok === false);
  ck("잠금 파일은 자동으로 안 부숨", fs.existsSync(file + ".reclaim.lock"));
  const cleared = cl.clearSessionLease("sess-F");
  ck("clear가 죽은 잠금+죽은 lease를 함께 정리", cleared && cleared.ws === "D:/dead" && !fs.existsSync(file) && !fs.existsSync(file + ".reclaim.lock"));
  const r2 = cl.acquireSessionLease("sess-F", { ws: "D:/new", deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  ck("clear 후 재획득 가능", r2.ok === true);
  cl.releaseSessionLease("sess-F", r2.token);
}

console.log("[3-1b] clear 안전장치 — 생존 거부·경합 복원");
{
  const file = cl.sessionLeaseFileFor("sess-H");
  // owner가 살아 있는 lease(=이 프로세스) → clear 거부
  fs.writeFileSync(file, JSON.stringify({ v: 1, session: "sess-H", token: "u".repeat(16), ownerPid: process.pid, childPid: null, ws: "D:/live", deadlineAt: "", createdAt: new Date().toISOString() }), "utf8");
  const b1 = cl.clearSessionLease("sess-H");
  ck("owner 생존=clear 거부(lease 보존)", b1 && b1.blocked === "alive" && cl.readSessionLease("sess-H") !== null);
  fs.unlinkSync(file);
  // child가 살아 있는 lease → 거부
  const deadPid = cp.spawnSync(process.execPath, ["-e", "0"], { windowsHide: true }).pid;
  fs.writeFileSync(file, JSON.stringify({ v: 1, session: "sess-H", token: "u".repeat(16), ownerPid: deadPid, childPid: process.pid, ws: "D:/live", deadlineAt: "", createdAt: new Date().toISOString() }), "utf8");
  const b2 = cl.clearSessionLease("sess-H");
  ck("child 생존=clear 거부", b2 && b2.blocked === "alive");
  fs.unlinkSync(file);
}

console.log("[3-2] 수동 정리 CLI — session-lease show/clear(--confirm 필수)");
{
  const BRIDGE = path.resolve(__dirname, "../bridge/codex-bridge.js");
  const deadPid = cp.spawnSync(process.execPath, ["-e", "0"], { windowsHide: true }).pid;
  const file = cl.sessionLeaseFileFor("sess-G");
  fs.writeFileSync(file, JSON.stringify({ v: 1, session: "sess-G", token: "t".repeat(16), ownerPid: deadPid, childPid: null, ws: "D:/dead", deadlineAt: "", createdAt: new Date().toISOString() }), "utf8");
  const run = (args) => cp.spawnSync(process.execPath, [BRIDGE, ...args], { env: Object.assign({}, process.env), windowsHide: true, encoding: "utf8" });
  const noConfirm = run(["session-lease", "clear", "sess-G"]);
  ck("--confirm 없이 clear=거부(lease 보존)", noConfirm.status !== 0 && cl.readSessionLease("sess-G") !== null);
  const show = run(["session-lease", "show", "sess-G"]);
  ck("show=보유자 표시", show.status === 0 && show.stdout.includes("D:/dead"));
  const yes = run(["session-lease", "clear", "sess-G", "--confirm"]);
  ck("--confirm clear=정리 성공", yes.status === 0 && cl.readSessionLease("sess-G") === null);
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
  ck("busy 거부는 exit 3(왕복 미소모 경로)", src.includes("+ staleHint, 3);"));
  ck("죽은 보유자 안내에 수동 clear 명령 포함", src.includes("session-lease clear ${link.codexSession} --confirm"));
  ck("해제 exit 훅 등록", src.includes('process.on("exit", () => { try { releaseSessionLease(link.codexSession, lease.token); }'));
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
