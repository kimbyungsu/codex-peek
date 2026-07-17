// P-6(설계 v5.1) 회수 영수증 계약 회귀: '검증 결과를 회수하는 도구 호출이 proof를 자기무효화'하던 결함의
// 수정 — job 동결 스냅샷 → proof v2(기록 직전 재검사) → 회수 영수증(결정론 바이트) → Stop 결속 체인.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cvr_"));
process.env.CODEX_BRIDGE_HOME = tmp;
const lib = require("../bridge/contract-lib.js");
const ws = path.join(tmp, "작업 폴더"); fs.mkdirSync(ws, { recursive: true });
const wsKey = lib.normWs(ws);
const sid = "aaaaaaaa-1111-2222-3333-444444444444";
const JOB_ID = "ask-cvr001-00112233aa"; // askJobIdOk 문법(^ask-[a-z0-9]+-[0-9a-f]{10}$)
const turnsDir = path.join(tmp, "codex-turns"); fs.mkdirSync(turnsDir, { recursive: true });

function writeLinks(rev, eventAt, session = sid) {
  fs.writeFileSync(path.join(tmp, "links.json"), JSON.stringify({
    byWorkspace: { [wsKey]: { workspace: ws, implementerSession: session, implementerRevision: rev, implementerEventAt: eventAt } },
    roleRevision: rev,
  }));
}
function writeTurn(turnId, startedAt, workspace = ws) {
  fs.writeFileSync(path.join(turnsDir, sid + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId, workspace, startedAt, lastActionAt: 0, modified: false, permissionMode: "default" }));
}

// ── 1) 동결(freeze): 부재·중간 상태는 전부 거부(fail-closed) ──────────────────────────────
assert.strictEqual(lib.freezeImplementerContext(ws).reason, "no-implementer", "레코드 없음=거부");
writeLinks(3, 0);
assert.strictEqual(lib.freezeImplementerContext(ws).reason, "no-eventAt", "eventAt 부재·0=거부(생략 금지 — 설계 v5.1)");
const T0 = Date.now();
writeLinks(3, T0);
assert.strictEqual(lib.freezeImplementerContext(ws).reason, "turn-missing", "턴 파일 없음=거부");
writeTurn("turn-A", T0 - 5000);
assert.strictEqual(lib.freezeImplementerContext(ws).reason, "turn-before-link", "링크 갱신 후 turn 기록 전의 창=거부");
writeTurn("turn-A", T0 + 10, path.join(tmp, "다른폴더"));
assert.strictEqual(lib.freezeImplementerContext(ws).reason, "turn-workspace", "턴 workspace 불일치=거부(normWs 비교)");
writeTurn("turn-A", T0 + 10);
const fr = lib.freezeImplementerContext(ws);
assert.ok(fr.ok, "정상 동결");
assert.strictEqual(fr.implementerSession, sid);
assert.strictEqual(fr.implementerTurnId, "turn-A");
assert.strictEqual(fr.implementerRevision, 3);

// ── 2) git 4상태 판독기 ─────────────────────────────────────────────────────────
assert.strictEqual(lib.gitHeadState(ws).state, "non-git", "명확한 non-git=null 허용 상태");
assert.strictEqual(lib.gitHeadState(path.join(tmp, "없는폴더")).state, "unreadable", "판독 불가=차단 상태");
const gws = path.join(tmp, "git-ws"); fs.mkdirSync(gws, { recursive: true });
const git = (args) => cp.spawnSync("git", ["-c", "safe.directory=*", "-C", gws, ...args], { encoding: "utf8", timeout: 15000, windowsHide: true });
if (git(["init", "-q"]).status === 0) {
  assert.strictEqual(lib.gitHeadState(gws).state, "no-head", "저장소인데 최초 커밋 전=별도 정상 상태(non-git 아님)");
  fs.writeFileSync(path.join(gws, "a.txt"), "1");
  git(["add", "."]); git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c1"]);
  const h1 = lib.gitHeadState(gws);
  assert.strictEqual(h1.state, "git"); assert.match(h1.oid, /^[0-9a-f]{40}/, "정상 git=HEAD OID");
  fs.writeFileSync(path.join(gws, "a.txt"), "2");
  git(["add", "."]); git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c2"]);
  assert.notStrictEqual(lib.gitHeadState(gws).oid, h1.oid, "커밋이 바뀌면 OID가 바뀐다(같은 초여도 은닉 불가)");
}

// ── 3) proof v2: 기록 직전 재검사(stale 차단)와 스냅샷 복사 ─────────────────────────────
const mkJob = (over) => Object.assign({ schema: "ask-job-v1", id: JOB_ID, workspace: ws, harnessMode: "codex-codex", implementerSession: sid, implementerTurnId: "turn-A", implementerRevision: 3, state: "succeeded", exitCode: 0, finishedAt: null }, over || {});
assert.strictEqual(lib.writeDurableProofV2(ws, mkJob({ harnessMode: "claude-codex" }), "x", "v").reason, "job-mode", "C-C 아닌 job=거부");
assert.strictEqual(lib.writeDurableProofV2(ws, mkJob({ implementerTurnId: "" }), "x", "v").reason, "job-turnId", "스냅샷 부재(구버전 job)=거부");
assert.strictEqual(lib.writeDurableProofV2(path.join(tmp, "딴곳"), mkJob(), "x", "v").reason, "job-workspace", "workspace 불일치=거부");
writeLinks(4, T0); // 역할이 한 번 더 갱신됨(revision 3→4) — job 스냅샷은 3
assert.strictEqual(lib.writeDurableProofV2(ws, mkJob(), "x", "v").reason, "stale-role", "완료 시점 역할 세대 변경=stale(기록 없이 실패)");
writeLinks(3, T0);
writeTurn("turn-B", T0 + 20);
assert.strictEqual(lib.writeDurableProofV2(ws, mkJob(), "x", "v").reason, "stale-turn", "완료 시점 턴 이동=stale");
writeTurn("turn-A", T0 + 10);
const pw = lib.writeDurableProofV2(ws, mkJob(), "검증 답변", "verifier-1");
assert.ok(pw.ok, "정상 proof v2: " + (pw.reason || ""));
const proofRaw = fs.readFileSync(lib.proofFileForSession(sid));
const proof = JSON.parse(proofRaw.toString("utf8"));
assert.ok(lib.strictProofV2(proof).ok, "proof v2 정확 스키마");
assert.strictEqual(proof.jobId, JOB_ID); assert.strictEqual(proof.turnId, "turn-A");
assert.strictEqual(proof.implementerRevision, 3); assert.strictEqual(proof.headState, "non-git"); assert.strictEqual(proof.headOid, null);

// ── 4) 회수 영수증: 성공 job만·결정론 바이트·멱등·conflict ────────────────────────────────
assert.strictEqual(lib.writeRecoveryReceipt(mkJob({ state: "failed", exitCode: 1, finishedAt: new Date().toISOString() })).reason, "job-not-succeeded", "실패 job=영수증 없음(실패 회수 불인정)");
assert.strictEqual(lib.writeRecoveryReceipt(mkJob()).reason, "job-finishedAt", "finishedAt 부재(구 스키마)=거부");
const doneJob = mkJob({ finishedAt: new Date(Date.parse(proof.ts) + 1000).toISOString() });
const rw = lib.writeRecoveryReceipt(doneJob);
assert.ok(rw.ok, "정상 영수증: " + (rw.reason || ""));
const receiptFile = lib.recoveryReceiptFileFor(JOB_ID);
const receiptBytes1 = fs.readFileSync(receiptFile, "utf8");
assert.ok(lib.strictReceiptV1(JSON.parse(receiptBytes1)).ok, "영수증 정확 스키마");
const rw2 = lib.writeRecoveryReceipt(doneJob);
assert.ok(rw2.ok, "같은 회수 반복=멱등");
assert.strictEqual(fs.readFileSync(receiptFile, "utf8"), receiptBytes1, "동시·반복 회수는 같은 바이트로 수렴(ts=finishedAt 결정론)");
assert.strictEqual(lib.writeRecoveryReceipt(mkJob({ finishedAt: new Date(Date.parse(proof.ts) + 9000).toISOString() })).reason, "receipt-conflict", "다른 내용 기존 영수증=덮지 않고 conflict");
assert.strictEqual(lib.writeRecoveryReceipt(mkJob({ finishedAt: new Date(Date.parse(proof.ts) - 5000).toISOString() })).reason, "finished-before-proof", "proof보다 앞선 완료 시각=거부(시계 역행 안전 실패)");

// ── 5) Stop 게이트: 결속 체인 전체 성립 시에만 통과 ─────────────────────────────────────
const gate = (over) => lib.durableProofGate(Object.assign({ ws, sid, eventTurnId: "turn-A", stateTurnId: "turn-A", roleRevision: 3, since: T0 }, over || {}));
assert.ok(gate().ok, "정상 체인 통과");
assert.strictEqual(gate({ eventTurnId: "" }).reason, "event-turnId", "이벤트 turn_id 부재=fail-closed");
assert.strictEqual(gate({ stateTurnId: "" }).reason, "state-turnId", "턴 상태 파일 부재=fail-closed");
assert.strictEqual(gate({ eventTurnId: "turn-B", stateTurnId: "turn-B" }).reason, "proof-turn-mismatch", "지연된 이전 턴 Stop이 다른 턴 proof를 승인하지 못함");
assert.strictEqual(gate({ eventTurnId: "turn-B" }).reason, "turn-mismatch", "이벤트 턴≠상태 턴=차단");
assert.strictEqual(gate({ roleRevision: 4 }).reason, "proof-revision-mismatch", "같은 sid로 갔다 돌아온 ABA(revision 증가)=차단");
assert.strictEqual(gate({ since: Date.parse(proof.ts) + 1 }).reason, "proof-stale", "proof 이후 실제 파일 변경(mtime)=차단");
// 영수증 파괴·위조 계열
const savedReceipt = fs.readFileSync(receiptFile, "utf8");
fs.unlinkSync(receiptFile);
assert.strictEqual(gate().reason, "receipt-missing", "영수증 없이 proof만으로는 통과 불가(공식 회수 강제)");
fs.writeFileSync(receiptFile, savedReceipt);
const tampered = JSON.parse(savedReceipt); tampered.ts = new Date(Date.parse(proof.ts) - 1000).toISOString();
fs.writeFileSync(receiptFile, JSON.stringify(tampered));
assert.strictEqual(gate().reason, "receipt-before-proof", "proof보다 앞선 영수증 시각=차단");
fs.writeFileSync(receiptFile, savedReceipt);
// proof 원문 바이트 변조(키 순서·공백 재작성 포함)는 sha 불일치로 차단
fs.writeFileSync(lib.proofFileForSession(sid), JSON.stringify(JSON.parse(proofRaw.toString("utf8")), null, 1));
assert.strictEqual(gate().reason, "receipt-proofSha-mismatch", "proof raw bytes 변경=차단(재직렬화 아님·원문 해시 계약)");
fs.writeFileSync(lib.proofFileForSession(sid), proofRaw);
assert.ok(gate().ok, "원문 복원 후 재통과");
// 커밋 은닉: git 작업폴더에서 proof 이후 커밋이 생기면 HEAD OID 불일치로 차단
if (fs.existsSync(path.join(gws, ".git"))) {
  const links2 = JSON.parse(fs.readFileSync(path.join(tmp, "links.json"), "utf8"));
  links2.byWorkspace[lib.normWs(gws)] = { workspace: gws, implementerSession: sid, implementerRevision: 3, implementerEventAt: T0 };
  fs.writeFileSync(path.join(tmp, "links.json"), JSON.stringify(links2));
  fs.writeFileSync(path.join(turnsDir, sid + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: "turn-G", workspace: gws, startedAt: T0 + 10, lastActionAt: 0, modified: false, permissionMode: "default" }));
  const gjob = mkJob({ id: "ask-cvr002-00112233bb", workspace: gws, implementerTurnId: "turn-G" });
  assert.ok(lib.writeDurableProofV2(gws, gjob, "답", "v").ok);
  const gproofRaw = fs.readFileSync(lib.proofFileForSession(sid));
  gjob.finishedAt = new Date(Date.parse(JSON.parse(gproofRaw.toString("utf8")).ts) + 500).toISOString();
  assert.ok(lib.writeRecoveryReceipt(gjob).ok);
  const ggate = () => lib.durableProofGate({ ws: gws, sid, eventTurnId: "turn-G", stateTurnId: "turn-G", roleRevision: 3, since: T0 });
  assert.ok(ggate().ok, "git 작업폴더 정상 체인 통과");
  fs.writeFileSync(path.join(gws, "b.txt"), "x");
  git(["add", "."]); git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "hidden"]);
  assert.strictEqual(ggate().reason, "head-oid-changed", "proof 이후 커밋(mtime 은닉)=HEAD OID 결속으로 차단");
}

// ── 6) CLI 배선: C-C에서 동결 실패 시 ask-start가 job을 만들지 않고 거부 ──────────────────────
const bridge = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const ws2 = path.join(tmp, "cc-빈방"); fs.mkdirSync(ws2, { recursive: true });
fs.mkdirSync(path.dirname(lib.contractFileFor(ws2, "ko")), { recursive: true });
fs.writeFileSync(lib.contractFileFor(ws2, "ko"), JSON.stringify({ workspace: ws2, harnessMode: "codex-codex", verifyMode: "always" }));
const noRole = cp.spawnSync(process.execPath, [bridge, "ask-start", "--allow-new", "test"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CLAUDE_PROJECT_DIR: ws2 }, timeout: 15000, windowsHide: true });
assert.notStrictEqual(noRole.status, 0, "구현 컨텍스트 없이 C-C ask-start는 실패해야 함");
assert.match(String(noRole.stderr || noRole.stdout), /동결 실패|freeze/i, "동결 실패 사유 안내");
assert.ok(!fs.readdirSync(path.join(tmp, "ask-jobs")).some((f) => { try { return JSON.parse(fs.readFileSync(path.join(tmp, "ask-jobs", f), "utf8")).workspace === ws2; } catch { return false; } }), "거부 시 job 미생성");

// ── 7) CLI 배선: ask-wait의 succeeded C-C job은 영수증 성공 후에만 출력 반환 ──────────────────
const jobDir = path.join(tmp, "ask-jobs"); fs.mkdirSync(jobDir, { recursive: true });
const wjobId = "ask-cvr003-00112233cc";
fs.writeFileSync(lib.proofFileForSession(sid), proofRaw); // turn-A proof 복원
fs.writeFileSync(path.join(turnsDir, sid + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: "turn-A", workspace: ws, startedAt: T0 + 10, lastActionAt: 0, modified: false, permissionMode: "default" }));
writeLinks(3, T0);
const wjobBase = { schema: "ask-job-v1", id: wjobId, state: "succeeded", workspace: ws, execCwd: ws, timeoutMin: 7, deadlineAt: new Date(Date.now() + 60000).toISOString(), exitCode: 0, harnessMode: "codex-codex", implementerSession: sid, implementerTurnId: "turn-A", implementerRevision: 3, finishedAt: new Date(Date.parse(proof.ts) + 800).toISOString() };
// proof.jobId(JOB_ID)와 job id(wjobId)가 어긋나면: 출력 반환 금지 + 비0 종료 + 영수증 미생성
fs.writeFileSync(path.join(jobDir, wjobId + ".json"), JSON.stringify(wjobBase));
fs.writeFileSync(path.join(jobDir, wjobId + ".out"), "검증-결과-본문\n");
let wr = cp.spawnSync(process.execPath, [bridge, "ask-wait", wjobId], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
assert.notStrictEqual(wr.status, 0, "결속 불일치면 회수 실패");
assert.ok(!wr.stdout.includes("검증-결과-본문"), "영수증 실패 시 검증 출력 미반환");
assert.ok(!fs.existsSync(lib.recoveryReceiptFileFor(wjobId)), "실패 시 영수증 미생성");
// 정합한 job이면: 영수증 성공(기존 동일 영수증=멱등) + 출력 반환. finishedAt은 기존 영수증(ts=doneJob.finishedAt)과
// 같아야 같은 바이트로 수렴한다(다르면 conflict가 정답 — 위 4절에서 검증).
const wjob2 = Object.assign({}, wjobBase, { id: JOB_ID, finishedAt: doneJob.finishedAt });
fs.writeFileSync(path.join(jobDir, JOB_ID + ".json"), JSON.stringify(wjob2));
fs.writeFileSync(path.join(jobDir, JOB_ID + ".out"), "검증-결과-본문\n");
fs.writeFileSync(receiptFile, savedReceipt); // 기존 동일 영수증 존재 → 멱등 통과 경로
wr = cp.spawnSync(process.execPath, [bridge, "ask-wait", JOB_ID], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
assert.strictEqual(wr.status, 0, wr.stderr);
assert.match(wr.stdout, /검증-결과-본문/, "영수증 성공 후 출력 반환");
assert.ok(fs.existsSync(receiptFile), "영수증 존재");
fs.unlinkSync(path.join(jobDir, wjobId + ".json")); // 결속 불일치 job은 영구 미회수 — 이후 절의 '미회수 차단'에 안 걸리게 정리

// ── 8) Stop fail-closed: links 손상·턴 상태 부재는 검증 없이 통과하는 통로가 아니다(구현 검증 1차 지적 1·2) ──
const hook = path.join(__dirname, "..", "bridge", "codex-hook.js");
const hookEnv = { ...process.env, CODEX_BRIDGE_HOME: tmp };
function runHook(input) { return cp.spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8", env: hookEnv, timeout: 15000, windowsHide: true }); }
const sidH = "bbbbbbbb-1111-2222-3333-444444444444";
fs.mkdirSync(path.dirname(lib.contractFileFor(ws, "ko")), { recursive: true });
fs.writeFileSync(lib.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, harnessMode: "codex-codex", verifyMode: "always" }));
writeLinks(3, T0, sidH);
fs.unlinkSync(path.join(turnsDir, sid + ".json")); // sidH의 턴 파일은 원래 없음(부재 상태)
let hr = runHook({ hook_event_name: "Stop", session_id: sidH, turn_id: "tH", cwd: ws, permission_mode: "default" });
assert.match(hr.stdout, /"decision":"block"/, "구현 세션의 턴 상태 부재=차단(fail-closed)");
assert.match(hr.stdout, /turn-missing/, "차단 사유에 턴 부재 명시");
fs.writeFileSync(path.join(tmp, "links.json"), "{broken json!!", "utf8");
hr = runHook({ hook_event_name: "Stop", session_id: sidH, turn_id: "tH", cwd: ws, permission_mode: "default" });
assert.match(hr.stdout, /"decision":"block"/, "links.json 손상=차단(구현자 아님으로 축소 금지)");
assert.match(hr.stdout, /links-corrupt/, "차단 사유에 손상 명시");
writeLinks(3, T0); writeTurn("turn-A", T0 + 10); // 복원(sid·turn-A)

// ── 9) 모드 전환 stale: C-C로 시작한 job은 완료 시점 계약이 달라지면 v1로 새지 않고 실패한다(지적 3) ──
const bridgeMod = JSON.stringify(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
const wsSwitch = path.join(tmp, "모드전환"); fs.mkdirSync(wsSwitch, { recursive: true }); // 계약 없음=기본 claude-codex
const swJobId = "ask-cvr005-00112233ee";
const swJobFile = path.join(tmp, "ask-jobs", swJobId + ".json");
fs.writeFileSync(swJobFile, JSON.stringify({ schema: "ask-job-v1", id: swJobId, workspace: wsSwitch, harnessMode: "codex-codex", implementerSession: sid, implementerTurnId: "turn-S", implementerRevision: 3, state: "running", deadlineAt: new Date(Date.now() + 7 * 60 * 1000).toISOString() })); // P-4 심화: 진행형 job은 deadline 필수(의미 검증) — 픽스처도 정본 형태
const swRun = cp.spawnSync(process.execPath, ["-e", `const b=require(${bridgeMod});b.writeProof("v","답",${JSON.stringify(wsSwitch)});`], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CODEX_BRIDGE_JOB_PROMPT_FILE: swJobFile, CODEX_BRIDGE_ASK_JOB_ID: swJobId }, timeout: 15000, windowsHide: true });
assert.notStrictEqual(swRun.status, 0, "모드 전환 stale=비정상 종료(worker가 failed로 기록할 신호)");
assert.match(String(swRun.stderr || swRun.stdout), /stale/i, "stale 사유 안내");
assert.ok(!fs.existsSync(lib.proofFileForSession(sid)) || JSON.parse(fs.readFileSync(lib.proofFileForSession(sid), "utf8")).jobId !== swJobId, "stale에서 v1/v2 어느 쪽 proof도 기록되지 않음");

// ── 10) C-C 직접 ask는 외부 검증 실행 '전에' 거부된다(지적 5 — 답 받고 버리는 과도 동작 제거) ──
const direct = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask", "질문"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CLAUDE_PROJECT_DIR: ws2 }, timeout: 15000, windowsHide: true });
assert.notStrictEqual(direct.status, 0, "C-C 직접 ask=실행 전 거부");
assert.match(String(direct.stderr || direct.stdout), /ask-start/, "내구 경로 안내");

// ── 11) 회수 전 두 번째 job: 같은 턴의 미회수 성공 job이 있으면 새 ask-start 거부(지적 4) ──
const pendId = "ask-cvr004-00112233dd";
fs.writeFileSync(path.join(tmp, "ask-jobs", pendId + ".json"), JSON.stringify({ schema: "ask-job-v1", id: pendId, workspace: ws, harnessMode: "codex-codex", implementerSession: sid, implementerTurnId: "turn-A", implementerRevision: 3, state: "succeeded", exitCode: 0, finishedAt: new Date().toISOString() }));
const second = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-start", "--allow-new", "둘째"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CLAUDE_PROJECT_DIR: ws }, timeout: 15000, windowsHide: true });
assert.notStrictEqual(second.status, 0, "미회수 성공 job 존재 시 새 시작 거부");
assert.match(String(second.stderr || second.stdout), new RegExp(pendId), "회수할 job id 안내");
fs.unlinkSync(path.join(tmp, "ask-jobs", pendId + ".json"));

// ── 12) 동시 회수 barrier: 두 프로세스가 같은 영수증을 동시에 써도 같은 바이트로 수렴(지적 6) ──
fs.unlinkSync(receiptFile);
const libMod = JSON.stringify(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const barrier = path.join(tmp, "barrier.flag");
const childSrc = `const fs=require("fs");const lib=require(${libMod});const job=JSON.parse(process.env.CVR_JOB);
while(!fs.existsSync(${JSON.stringify(barrier)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
const r=lib.writeRecoveryReceipt(job);process.stdout.write(JSON.stringify(r));process.exit(r.ok?0:7);`;
const childEnv = { ...process.env, CODEX_BRIDGE_HOME: tmp, CVR_JOB: JSON.stringify(doneJob) };
const kids = [1, 2].map(() => cp.spawn(process.execPath, ["-e", childSrc], { env: childEnv, windowsHide: true }));
const outs = kids.map(() => ({ out: "" }));
kids.forEach((k, i) => k.stdout.on("data", (d) => outs[i].out += d));
const codes = [];
const doneAll = Promise.all(kids.map((k) => new Promise((res) => k.on("close", (code) => { codes.push(code); res(); }))));
fs.writeFileSync(barrier, "go");
const waitStart = Date.now();
require("child_process").execSync ? null : null; // no-op
(async () => {
  await doneAll;
  assert.deepStrictEqual(codes.sort(), [0, 0], "동시 회수 둘 다 성공: " + JSON.stringify(outs));
  assert.strictEqual(fs.readFileSync(receiptFile, "utf8"), receiptBytes1, "동시 기록도 결정론 바이트로 수렴");
  assert.ok(Date.now() - waitStart < 30000);

  // ── 13) 공식 전체 체인: ask-start(실CLI·동결) → worker(실물) → proof v2 → ask-wait(실CLI·영수증) → Stop 통과 ──
  const wsChain = path.join(tmp, "체인-작업장"); fs.mkdirSync(wsChain, { recursive: true });
  fs.mkdirSync(path.dirname(lib.contractFileFor(wsChain, "ko")), { recursive: true });
  fs.writeFileSync(lib.contractFileFor(wsChain, "ko"), JSON.stringify({ workspace: wsChain, harnessMode: "codex-codex", verifyMode: "always" }));
  const sidC = "cccccccc-1111-2222-3333-444444444444";
  const linksAll = JSON.parse(fs.readFileSync(path.join(tmp, "links.json"), "utf8"));
  linksAll.byWorkspace[lib.normWs(wsChain)] = { workspace: wsChain, implementerSession: sidC, implementerRevision: 5, implementerEventAt: Date.now() - 50 };
  fs.writeFileSync(path.join(tmp, "links.json"), JSON.stringify(linksAll));
  fs.writeFileSync(path.join(turnsDir, sidC + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: "turn-C", workspace: wsChain, startedAt: Date.now() - 20, lastActionAt: 0, modified: false, permissionMode: "default" }));
  // Codex 실행만 모사하고 proof 기록은 '실제 writeProof'(env 라우팅·모드 검사 포함)를 경유한다 —
  // fake가 lib을 직접 부르면 C-C env 분기(codex-bridge.js writeProof)가 통합 체인에서 우회된다(2차 지적 6).
  const fake = path.join(tmp, "fake-cc-bridge.js");
  fs.writeFileSync(fake, `const fs=require("fs");const b=require(${bridgeMod});
const job=JSON.parse(fs.readFileSync(process.env.CODEX_BRIDGE_JOB_PROMPT_FILE,"utf8"));
if(process.env.CODEX_BRIDGE_ASK_JOB_ID!==job.id){console.error("env-id-mismatch");process.exit(9);}
b.writeProof("verifier-x","체인 검증 응답 본문",job.workspace);
process.stdout.write("체인-검증-응답");`);
  const chainEnv = { ...process.env, CODEX_BRIDGE_HOME: tmp, CLAUDE_PROJECT_DIR: wsChain, CODEX_BRIDGE_WORKER_BRIDGE: fake, CODEX_BRIDGE_VERIFY_TIMEOUT_MIN: "1", CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" };
  const st = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-start", "--allow-new", "체인 검증"], { encoding: "utf8", env: chainEnv, timeout: 20000, windowsHide: true });
  assert.strictEqual(st.status, 0, st.stderr);
  const chainId = JSON.parse(st.stdout).jobId;
  assert.ok(lib.askJobIdOk(chainId));
  const chainJobFile = path.join(tmp, "ask-jobs", chainId + ".json");
  let cj = null;
  for (let i = 0; i < 100; i++) { cj = JSON.parse(fs.readFileSync(chainJobFile, "utf8")); if (["succeeded", "failed"].includes(cj.state)) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  assert.strictEqual(cj.state, "succeeded", "worker 완주: " + JSON.stringify(cj));
  assert.strictEqual(cj.implementerTurnId, "turn-C", "job에 턴 동결");
  const wchain = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-wait", chainId], { encoding: "utf8", env: chainEnv, timeout: 20000, windowsHide: true });
  assert.strictEqual(wchain.status, 0, wchain.stderr);
  assert.match(wchain.stdout, /체인-검증-응답/, "회수 성공 시 출력 반환");
  assert.ok(fs.existsSync(lib.recoveryReceiptFileFor(chainId)), "영수증 생성");
  let sr = runHook({ hook_event_name: "Stop", session_id: sidC, turn_id: "turn-C", cwd: wsChain, permission_mode: "default" });
  assert.strictEqual(sr.stdout, "", "공식 체인 후 Stop 통과: " + sr.stdout);
  // 회수 후 추가 도구 호출(lastActionAt 갱신)에도 proof 유지 — P-6 핵심 회귀(실 CLI 경유판)
  runHook({ hook_event_name: "PostToolUse", session_id: sidC, turn_id: "turn-C", cwd: wsChain, tool_name: "Bash", permission_mode: "default" });
  sr = runHook({ hook_event_name: "Stop", session_id: sidC, turn_id: "turn-C", cwd: wsChain, permission_mode: "default" });
  assert.strictEqual(sr.stdout, "", "회수 도구 호출이 proof를 자기무효화하지 않음(전체 체인판)");

  // ── 14) 2차 반례: 계약 손상·의미 손상 턴·손상 영수증·가짜 내구 env·Stop 예외 방벽 ───────────────
  // 계약 파일이 '존재하는데 손상'이면 Stop 차단(모드 권위 판정 불가 — 조용한 C-C 비활성 금지)
  const contractBak = fs.readFileSync(lib.contractFileFor(wsChain, "ko"), "utf8");
  fs.writeFileSync(lib.contractFileFor(wsChain, "ko"), "{corrupt!!");
  sr = runHook({ hook_event_name: "Stop", session_id: sidC, turn_id: "turn-C", cwd: wsChain, permission_mode: "default" });
  assert.match(sr.stdout, /"decision":"block"/, "계약 손상=Stop 차단(조용한 비활성 금지)");
  fs.writeFileSync(lib.contractFileFor(wsChain, "ko"), contractBak);
  // 의미상 손상된 턴 파일(modified 키 누락)=차단 — needed 게이트 우회 통로 봉쇄
  const turnCFile = path.join(turnsDir, sidC + ".json");
  const turnCBak = fs.readFileSync(turnCFile, "utf8");
  const turnCObj = JSON.parse(turnCBak); delete turnCObj.modified;
  fs.writeFileSync(turnCFile, JSON.stringify(turnCObj));
  sr = runHook({ hook_event_name: "Stop", session_id: sidC, turn_id: "turn-C", cwd: wsChain, permission_mode: "default" });
  assert.match(sr.stdout, /"decision":"block"/, "필수 키 누락 턴 상태=차단(turn-fields)");
  fs.writeFileSync(turnCFile, turnCBak);
  // 손상(빈 파일) 영수증은 회수 완료가 아니다 — 같은 턴 새 ask-start 거부(이전 proof 보호)
  const chainReceipt = lib.recoveryReceiptFileFor(chainId);
  const chainReceiptBak = fs.readFileSync(chainReceipt, "utf8");
  fs.writeFileSync(chainReceipt, "");
  const secondChain = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-start", "--allow-new", "둘째"], { encoding: "utf8", env: chainEnv, timeout: 15000, windowsHide: true });
  assert.notStrictEqual(secondChain.status, 0, "손상 영수증=미회수로 간주해 새 시작 거부");
  assert.match(String(secondChain.stderr || secondChain.stdout), new RegExp(chainId), "회수(해결)할 job id 안내");
  fs.writeFileSync(chainReceipt, chainReceiptBak);
  // 가짜 내구 env(임의 문자열)로는 C-C 직접 ask의 사전 차단을 우회할 수 없다
  const fakeEnvAsk = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask", "질문"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CLAUDE_PROJECT_DIR: wsChain, CODEX_BRIDGE_JOB_PROMPT_FILE: "없는파일", CODEX_BRIDGE_ASK_JOB_ID: "ask-fake" }, timeout: 15000, windowsHide: true });
  assert.notStrictEqual(fakeEnvAsk.status, 0, "가짜 env=여전히 실행 전 거부");
  assert.match(String(fakeEnvAsk.stderr || fakeEnvAsk.stdout), /ask-start/);
  // Stop dispatch 예외 방벽(소스 계약): 미지 예외도 block으로 — sReal 무음 통과 실사고 재발 방지
  const hookSrc2 = fs.readFileSync(hook, "utf8");
  assert.match(hookSrc2, /if\(ev==="Stop"\)\{\s*[\s\S]{0,220}try\{return onStop\(j,ws,sid,c\);\}\s*catch/, "Stop dispatch 전체가 try/catch로 감싸여 미지 예외=block");
  assert.match(hookSrc2, /internal-error/, "미지 예외 사유 코드 노출");
  // 전처리 방벽(최외곽): 소스 계약으로 고정 — Stop이면 전처리 미지 예외도 block으로 변환.
  // (실측: cwd 비문자열 페이로드는 예외가 아니라 세션 앵커 폴백으로 정상 판정됨 — 현재 페이로드로 도달
  // 가능한 전처리 throw는 없고, 이 방벽은 sReal류 회귀에 대한 보험이다.)
  assert.match(hookSrc2, /catch\(e\)\{[\s\S]{0,700}hook_event_name[\s\S]{0,400}"decision":"block"|catch\(e\)\{[\s\S]{0,700}ev==="Stop"[\s\S]{0,500}jsonOut\(\{decision:"block"/, "최외곽 처리기가 Stop 미지 예외를 block으로 변환");
  // cwd 비문자열 Stop은 침묵 성공(exit 0·무판정)이 아니라 '판정된 결과'(차단 또는 정당 통과)여야 한다.
  sr = runHook({ hook_event_name: "Stop", session_id: sidC, turn_id: "turn-C", cwd: {}, permission_mode: "default" });
  assert.ok(sr.status === 0 && (sr.stdout === "" || /"decision":"block"/.test(sr.stdout)), "비문자열 cwd=앵커 폴백으로 정상 판정(예외 아님)");

  // ── 15) 3차 반례: 위조 영수증 지문·정본 경로 우회·id 손상 job conflict ─────────────────────
  // 위조 영수증(스키마·5필드는 결속, proofTs/proofSha만 가짜) — proof가 아직 그 job의 것이면 지문 사슬로 거부
  const cjNow = JSON.parse(fs.readFileSync(chainJobFile, "utf8"));
  const forged = { schema: "cbx-recovery-v1", jobId: cjNow.id, implementerSession: cjNow.implementerSession, turnId: cjNow.implementerTurnId, implementerRevision: cjNow.implementerRevision, workspace: cjNow.workspace, ts: cjNow.finishedAt, proofTs: "1999-01-01T00:00:00.000Z", proofSha: "0".repeat(64) };
  fs.writeFileSync(chainReceipt, JSON.stringify(forged));
  assert.strictEqual(lib.receiptSettled(cjNow), false, "위조 지문 영수증=미결제(새 시작으로 proof를 덮는 공격 차단)");
  const forgedStart = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-start", "--allow-new", "셋째"], { encoding: "utf8", env: chainEnv, timeout: 15000, windowsHide: true });
  assert.notStrictEqual(forgedStart.status, 0, "위조 영수증으로는 새 시작 불가");
  fs.writeFileSync(chainReceipt, chainReceiptBak);
  assert.strictEqual(lib.receiptSettled(JSON.parse(fs.readFileSync(chainJobFile, "utf8"))), true, "정상 영수증=결제(복원)");
  // 정본 경로 우회: 유효 문법 id+정합 필드의 조작 JSON을 '임의 경로'에 두고 env로 지정 — 여전히 실행 전 거부
  const rogue = path.join(tmp, "rogue-job.json");
  const rogueId = "ask-cvr006-00112233ff";
  fs.writeFileSync(rogue, JSON.stringify({ schema: "ask-job-v1", id: rogueId, workspace: wsChain, harnessMode: "codex-codex", implementerSession: sidC, implementerTurnId: "turn-C", implementerRevision: 5, state: "running" }));
  const rogueAsk = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask", "질문"], { encoding: "utf8", env: { ...chainEnv, CODEX_BRIDGE_JOB_PROMPT_FILE: rogue, CODEX_BRIDGE_ASK_JOB_ID: rogueId }, timeout: 15000, windowsHide: true });
  assert.notStrictEqual(rogueAsk.status, 0, "정본 경로(ask-jobs/<id>.json) 밖 조작 job=직접 ask 여전히 거부");
  assert.match(String(rogueAsk.stderr || rogueAsk.stdout), /ask-start/);
  // 귀속 가능한 id 손상 job(현재 턴 결속인데 id 누락)=파일명 id로 conflict 차단
  const brokenId = "ask-cvr007-0011223300";
  const brokenJob = { schema: "ask-job-v1", workspace: wsChain, harnessMode: "codex-codex", implementerSession: sidC, implementerTurnId: "turn-C", implementerRevision: 5, state: "succeeded", exitCode: 0, finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(tmp, "ask-jobs", brokenId + ".json"), JSON.stringify(brokenJob));
  const brokenStart = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-start", "--allow-new", "넷째"], { encoding: "utf8", env: chainEnv, timeout: 15000, windowsHide: true });
  assert.notStrictEqual(brokenStart.status, 0, "id 손상이지만 현재 턴에 귀속되는 job=차단");
  assert.match(String(brokenStart.stderr || brokenStart.stdout), new RegExp(brokenId), "파일명 id로 conflict 안내");
  fs.unlinkSync(path.join(tmp, "ask-jobs", brokenId + ".json"));

  // ── 16) receiptSettled 사례 분리 회귀(4차 보완): 역사적 결제·proof 부재 인정 + 자체 불변식 ─────────
  const chainJobNow = JSON.parse(fs.readFileSync(chainJobFile, "utf8"));
  assert.strictEqual(lib.receiptSettled(chainJobNow), true, "사례 ①: 현재 proof=이 job → 전체 지문 사슬 성립");
  const proofFileC = lib.proofFileForSession(sidC);
  const proofBakC = fs.readFileSync(proofFileC);
  // 사례 ②: 후속 합법 검증이 proof를 덮은 상태(다른 jobId의 유효 proof) — 이전 영수증은 역사적 결제
  const laterProof = JSON.parse(proofBakC.toString("utf8")); laterProof.jobId = "ask-cvr008-0011223311"; laterProof.ts = new Date(Date.parse(laterProof.ts) + 5000).toISOString();
  fs.writeFileSync(proofFileC, JSON.stringify(laterProof));
  assert.strictEqual(lib.receiptSettled(chainJobNow), true, "사례 ②: proof가 후속 job의 것 → 역사적 결제 인정(순차 다중 검증 보존)");
  // 사례 ③: proof 부재 — 보호 대상 없음 → 결속 영수증만으로 결제 인정(영구 잠금 방지)
  fs.unlinkSync(proofFileC);
  assert.strictEqual(lib.receiptSettled(chainJobNow), true, "사례 ③: proof 부재 → 결속 영수증만으로 결제");
  // 자체 불변식은 역사적 분기에서도 적용: 실패 job·시각 역전 영수증은 어떤 분기에서도 결제 불가
  assert.strictEqual(lib.receiptSettled(Object.assign({}, chainJobNow, { exitCode: 1 })), false, "불변식: exitCode!==0=미결제(역사 분기 포함)");
  fs.writeFileSync(proofFileC, proofBakC);

  console.log("codex-verify-recovery ✅");
})().catch((e) => { console.error(e); process.exit(1); });
