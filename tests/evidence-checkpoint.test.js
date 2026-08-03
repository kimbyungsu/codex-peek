// primary-complete checkpoint(설계 §6·증분 2) — API 단위 + 실제 ask-job-worker e2e 실행 반례.
// 결속 계약: jobId·workspace·구현 턴/revision(null 동등)·verifier session·proof 실형식(v1/v2)·출력 지문.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "evck_home_"));
process.env.CODEX_BRIDGE_HOME = home;
fs.mkdirSync(path.join(home, "proofs"), { recursive: true });

const ch = require("../bridge/evidence-challenge.js");
const WORKER = path.resolve(__dirname, "../bridge/ask-job-worker.js");
const ECH = path.resolve(__dirname, "../bridge/evidence-challenge.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

// proof 실형식 생성기 — writeDurableProofV2(v2)·writeProof(v1)가 만드는 실제 필드 그대로 모사
let pseq = 0;
function putProof(obj) {
  const name = "proof-" + (++pseq) + ".json";
  const raw = JSON.stringify(obj);
  fs.writeFileSync(path.join(home, "proofs", name), raw, "utf8");
  return { proofFile: name, proofFp: sha(Buffer.from(raw, "utf8")) };
}
function proofV2(job, codexSession, over) {
  return putProof(Object.assign({
    v: 2, implementerSession: "impl-1", workspace: job.workspace, ts: new Date().toISOString(),
    codexSession, exit: 0, status: "success", answerChars: 120,
    jobId: job.id, turnId: job.implementerTurnId, implementerRevision: job.implementerRevision,
    headState: "non-git", headOid: null,
  }, over || {}));
}
function proofV1(job, codexSession, over) {
  return putProof(Object.assign({
    v: 1, claudeSession: "cl-1", implementerSession: "", workspace: job.workspace,
    ts: new Date().toISOString(), codexSession, exit: 0, status: "success", answerChars: 120,
  }, over || {}));
}

console.log("[1] API 단위 — proof 실형식 결속(v2)·read-back·유효성");
{
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "evck_api_"));
  const job = { id: "ask-a1-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: "t1", implementerRevision: 2, createdAt: new Date(Date.now() - 60_000).toISOString() };
  const bind = { verifierSession: "vs1", ...proofV2(job, "vs1") };
  const ckpt = ch.writePrimaryComplete(jobs, job, "판정 본문입니다. 근거와 결론.", bind);
  ck("정상 생성(스키마·결속 필드)", !!ckpt && ckpt.schema === ch.CKPT_SCHEMA && ckpt.jobId === "ask-a1-aaaaaaaaaa" && ckpt.implementerRevision === 2 && ckpt.verifierSession === "vs1");
  const outBuf = fs.readFileSync(path.join(jobs, "ask-a1-aaaaaaaaaa.out"));
  ck("출력 파일=원문 그대로·지문 일치", outBuf.toString("utf8") === "판정 본문입니다. 근거와 결론." && ckpt.outSha256 === sha(outBuf) && ckpt.outBytes === outBuf.length);
  ck("유효성 판정 통과", !!ch.primaryCheckpointValid(jobs, job));
  ck("빈 출력=생성 거부", (() => { const j = { ...job, id: "ask-a2-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "", { verifierSession: "vs1", ...proofV2(j, "vs1") }) === null; })());
  ck("proof 없는 지문=생성 거부", ch.writePrimaryComplete(jobs, { ...job, id: "ask-a3-aaaaaaaaaa" }, "x답변", { verifierSession: "vs1", proofFile: "no-such.json", proofFp: "f".repeat(64) }) === null);
  ck("proof jobId 불일치=생성 거부", (() => { const j = { ...job, id: "ask-a4-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV2({ ...j, id: "ask-xx-aaaaaaaaaa" }, "vs1") }) === null; })());
  ck("proof 검증자 세션 불일치=생성 거부", (() => { const j = { ...job, id: "ask-a5-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV2(j, "verifier-B") }) === null; })());
  ck("실패 proof(exit!=0)=생성 거부", (() => { const j = { ...job, id: "ask-a6-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV2(j, "vs1", { exit: 1, status: "fail" }) }) === null; })());
  ck("proof workspace 불일치=생성 거부", (() => { const j = { ...job, id: "ask-a7-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV2({ ...j, workspace: "D:/딴곳" }, "vs1") }) === null; })());
  ck("proof turnId 불일치=생성 거부", (() => { const j = { ...job, id: "ask-a8-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV2({ ...j, implementerTurnId: "t9" }, "vs1") }) === null; })());
  ck("proofFile 경로 이탈 표기=거부", ch.writePrimaryComplete(jobs, { ...job, id: "ask-a9-aaaaaaaaaa" }, "x답변", { verifierSession: "vs1", proofFile: "..\\..\\evil.json", proofFp: "f".repeat(64) }) === null);

  console.log("[1-1] CL-C 실형태 — v1 proof(jobId 없음)·null 턴/revision");
  const clc = { id: "ask-clc1-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: null, implementerRevision: null, createdAt: new Date(Date.now() - 60_000).toISOString() };
  const ckc = ch.writePrimaryComplete(jobs, clc, "CL-C 판정 본문", { verifierSession: "vs1", ...proofV1(clc, "vs1") });
  ck("CL-C(v1 proof·null 턴)=생성 성공", !!ckc && ckc.implementerTurnId === null && ckc.implementerRevision === null);
  ck("CL-C 유효성 판정 통과(null 동등)", !!ch.primaryCheckpointValid(jobs, clc));
  ck("null checkpoint를 실값 job에 재사용=무효", ch.primaryCheckpointValid(jobs, { ...clc, implementerTurnId: "t9", implementerRevision: 1 }) === null);
  ck("stale v1 proof(ts<job.createdAt)=거부", (() => { const j = { ...clc, id: "ask-clc2-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV1(j, "vs1", { ts: new Date(Date.now() - 3600_000).toISOString() }) }) === null; })());
  ck("C-C job에 v1 proof=거부", (() => { const j = { ...job, id: "ask-ccv1-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV1(j, "vs1") }) === null; })());
  ck("v1 검증자 세션 불일치=거부", (() => { const j = { ...clc, id: "ask-clc3-aaaaaaaaaa" }; return ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...proofV1(j, "verifier-B") }) === null; })());

  console.log("[1-1b] 부분 필드 의사 proof=실형식 강제로 거부(정확 키 집합)");
  {
    // v1 최소 객체(claudeSession·implementerSession 삭제) — 종전엔 통과했던 반례를 잠근다
    const j = { id: "ask-p1-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: null, implementerRevision: null, createdAt: new Date(Date.now() - 60_000).toISOString() };
    const partial = putProof({ v: 1, workspace: j.workspace, ts: new Date().toISOString(), codexSession: "vs1", exit: 0, status: "success", answerChars: 99 });
    ck("v1 필수 키 삭제(claudeSession 등)=거부", ch.writePrimaryComplete(jobs, j, "x답변", { verifierSession: "vs1", ...partial }) === null);
    const extra = putProof({ v: 1, claudeSession: "cl-1", implementerSession: "", workspace: j.workspace, ts: new Date().toISOString(), codexSession: "vs1", exit: 0, status: "success", answerChars: 99, 몰래추가: 1 });
    ck("v1 여분 키 추가=거부(정확 집합)", ch.writePrimaryComplete(jobs, { ...j, id: "ask-p2-aaaaaaaaaa" }, "x답변", { verifierSession: "vs1", ...extra }) === null);
    const j2 = { id: "ask-p3-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: "t1", implementerRevision: 2, createdAt: j.createdAt };
    const v2partial = putProof({ v: 2, implementerSession: "impl-1", workspace: j2.workspace, ts: new Date().toISOString(), codexSession: "vs1", exit: 0, status: "success", answerChars: 99, jobId: j2.id, turnId: "t1", implementerRevision: 2 });
    ck("v2 필수 키 삭제(headState 등)=거부(strictProofV2)", ch.writePrimaryComplete(jobs, j2, "x답변", { verifierSession: "vs1", ...v2partial }) === null);
  }

  console.log("[1-1c] workspace 비교 플랫폼 규칙");
  if (process.platform === "win32") {
    const jw = { id: "ask-w1-aaaaaaaaaa", workspace: "D:/W", implementerTurnId: null, implementerRevision: null, createdAt: new Date(Date.now() - 60_000).toISOString() };
    const pw = proofV1({ ...jw, workspace: "d:\\w" }, "vs1");
    ck("win: 대소문자·구분자 표기 차이=같은 폴더로 인정", ch.writePrimaryComplete(jobs, jw, "x답변", { verifierSession: "vs1", ...pw }) !== null);
  } else {
    const jw = { id: "ask-w1-aaaaaaaaaa", workspace: "/tmp/a/b", implementerTurnId: null, implementerRevision: null, createdAt: new Date(Date.now() - 60_000).toISOString() };
    const pw = proofV1({ ...jw, workspace: "/tmp/a\\b" }, "vs1");
    ck("posix: 백슬래시=파일명 문자 — 다른 폴더로 거부", ch.writePrimaryComplete(jobs, jw, "x답변", { verifierSession: "vs1", ...pw }) === null);
    const pw2 = proofV1({ ...jw, workspace: "/tmp/A/B" }, "vs1");
    ck("posix: 대소문자 차이=다른 폴더로 거부", ch.writePrimaryComplete(jobs, { ...jw, id: "ask-w2-aaaaaaaaaa" }, "x답변", { verifierSession: "vs1", ...pw2 }) === null);
    // 확인 검증 보완: 루트 workspace "/"는 꼬리 제거로 빈 문자열이 되면 안 된다(동일 workspace 오거부)
    const jr = { id: "ask-w3-aaaaaaaaaa", workspace: "/", implementerTurnId: null, implementerRevision: null, createdAt: new Date(Date.now() - 60_000).toISOString() };
    const pr = proofV1(jr, "vs1");
    ck("posix: 루트 / 동일 workspace=인정(빈 문자열 오거부 해소)", ch.writePrimaryComplete(jobs, jr, "루트 답변 본문", { verifierSession: "vs1", ...pr }) !== null);
  }

  console.log("[1-2] 사후 변조·결속 불일치=무효");
  fs.appendFileSync(path.join(jobs, "ask-a1-aaaaaaaaaa.out"), "변조");
  ck("출력 변조=유효성 무효", ch.primaryCheckpointValid(jobs, job) === null);
  ck("턴 불일치=무효", (() => {
    const j2 = { id: "ask-b1-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: "t1", implementerRevision: 1, createdAt: job.createdAt };
    ch.writePrimaryComplete(jobs, j2, "본문 바이트", { verifierSession: "vs1", ...proofV2(j2, "vs1") });
    return ch.primaryCheckpointValid(jobs, { ...j2, implementerTurnId: "t2" }) === null;
  })());
  ck("workspace 불일치=무효", (() => {
    const j3 = { id: "ask-b2-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: "t1", implementerRevision: 1, createdAt: job.createdAt };
    ch.writePrimaryComplete(jobs, j3, "본문 바이트", { verifierSession: "vs1", ...proofV2(j3, "vs1") });
    return ch.primaryCheckpointValid(jobs, { ...j3, workspace: "D:/딴곳" }) === null;
  })());
  ck("proof 사후 변조=무효", (() => {
    const j4 = { id: "ask-b3-aaaaaaaaaa", workspace: "D:/w", implementerTurnId: null, implementerRevision: null, createdAt: job.createdAt };
    const p4 = proofV1(j4, "vs1");
    ch.writePrimaryComplete(jobs, j4, "본문 바이트", { verifierSession: "vs1", ...p4 });
    fs.appendFileSync(path.join(home, "proofs", p4.proofFile), " ");
    return ch.primaryCheckpointValid(jobs, j4) === null;
  })());
}

// ── 가짜 브릿지(worker가 spawn하는 자식): STUB_MODE로 경로 재현. checkpoint 모드는 실형식 proof도 만든다 ──
const stub = path.join(home, "stub-bridge.js");
fs.writeFileSync(stub, `
const fs=require("fs"),path=require("path");
const mode=process.env.STUB_MODE||"plain-ok";
const jobFile=process.env.CODEX_BRIDGE_JOB_PROMPT_FILE;
const job=JSON.parse(fs.readFileSync(jobFile,"utf8"));
const dir=path.dirname(jobFile);
if(mode==="ckpt-crash"||mode==="ckpt-tamper"){
  const ech=require(process.env.STUB_ECH);
  const crypto=require("crypto");
  const home=process.env.CODEX_BRIDGE_HOME;
  const clc=(job.implementerTurnId===null||job.implementerTurnId===undefined);
  const proof=clc
    ?{v:1,claudeSession:"cl-1",implementerSession:"",workspace:job.workspace,ts:new Date().toISOString(),codexSession:"vs-e2e",exit:0,status:"success",answerChars:99}
    :{v:2,implementerSession:"impl-1",workspace:job.workspace,ts:new Date().toISOString(),codexSession:"vs-e2e",exit:0,status:"success",answerChars:99,jobId:job.id,turnId:job.implementerTurnId,implementerRevision:job.implementerRevision,headState:"non-git",headOid:null};
  const pname="proof-e2e-"+job.id+".json";
  const raw=JSON.stringify(proof);
  fs.mkdirSync(path.join(home,"proofs"),{recursive:true});
  fs.writeFileSync(path.join(home,"proofs",pname),raw,"utf8");
  const fp=crypto.createHash("sha256").update(Buffer.from(raw,"utf8")).digest("hex");
  const ok=ech.writePrimaryComplete(dir,job,"정답 본문 결속판 "+"x".repeat(200),{verifierSession:"vs-e2e",proofFile:pname,proofFp:fp});
  if(!ok){process.stdout.write("CKPT-FAIL");process.exit(9);}
  if(mode==="ckpt-tamper") fs.appendFileSync(path.join(dir,job.id+".out"),"변조");
  process.stdout.write("PARTIAL-STDOUT");
  process.exit(7);
}
if(mode==="plain-crash"){process.stdout.write("PARTIAL");process.exit(7);}
process.stdout.write("전체 정답 출력");process.exit(0);
`, "utf8");

let seq = 0;
function runWorker(mode, jobExtra) {
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "evck_jobs_"));
  const id = "ask-ck" + (++seq) + "-aaaaaaaaaa";
  const job = Object.assign({
    schema: "ask-job-v1", id, execCwd: jobs, workspace: "D:/evck-ws",
    implementerTurnId: "turn-1", implementerRevision: 3,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    timeoutMin: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(), flags: [],
  }, jobExtra || {});
  const jobFile = path.join(jobs, id + ".json");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  const r = cp.spawnSync(process.execPath, [WORKER, jobFile], {
    env: Object.assign({}, process.env, { CODEX_BRIDGE_WORKER_BRIDGE: stub, STUB_MODE: mode, STUB_ECH: ECH }),
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  return { jobs, id, exit: r.status, job: JSON.parse(fs.readFileSync(jobFile, "utf8")), out: (() => { try { return fs.readFileSync(path.join(jobs, id + ".out"), "utf8"); } catch { return null; } })() };
}

console.log("[2] worker e2e — checkpoint 복구(§6: challenge 크래시에도 원 job 성공 확정 · C-C v2 proof)");
{
  const r = runWorker("ckpt-crash");
  ck("job=succeeded·exitCode 0(회수 계약 보존)", r.job.state === "succeeded" && r.job.exitCode === 0);
  ck("실제 종료코드는 challengeExitCode로 정직 보존", r.job.challengeExitCode === 7 && r.job.checkpointRecovered === true);
  ck("worker 자체도 성공 종료", r.exit === 0);
  ck("출력 파일=결속본 유지(부분 stdout으로 덮어쓰지 않음)", typeof r.out === "string" && r.out.includes("정답 본문 결속판") && !r.out.includes("PARTIAL-STDOUT"));
}

console.log("[2-1] worker e2e — CL-C(null 턴·v1 proof)도 checkpoint 복구 도달");
{
  const r = runWorker("ckpt-crash", { implementerSession: null, implementerTurnId: null, implementerRevision: null });
  ck("CL-C job=succeeded·exitCode 0", r.job.state === "succeeded" && r.job.exitCode === 0 && r.job.challengeExitCode === 7);
  ck("CL-C 출력=결속본 유지", typeof r.out === "string" && r.out.includes("정답 본문 결속판"));
}

console.log("[3] worker e2e — checkpoint 없는 크래시=기존 실패 경로(무회귀)");
{
  const r = runWorker("plain-crash");
  ck("job=failed·실제 종료코드", r.job.state === "failed" && r.job.exitCode === 7);
  ck("출력=부분 stdout(기존 동작)", r.out === "PARTIAL");
}

console.log("[4] worker e2e — 정상 성공 경로 무회귀");
{
  const r = runWorker("plain-ok");
  ck("job=succeeded·exitCode 0", r.job.state === "succeeded" && r.job.exitCode === 0 && r.job.challengeExitCode === undefined);
  ck("출력=전체 stdout(기존 동작)", r.out === "전체 정답 출력");
}

console.log("[5] worker e2e — checkpoint 후 출력 변조=복구 거부(안전 방향)");
{
  const r = runWorker("ckpt-tamper");
  ck("변조된 결속본=복구 안 함·기존 실패 경로", r.job.state === "failed" && r.job.exitCode === 7);
  ck("출력은 일반 경로대로 stdout으로 대체", r.out === "PARTIAL-STDOUT");
}

console.log("[6] worker e2e — proof 소멸=복구 거부(위조·stale 차단)");
{
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "evck_jobs_"));
  const id = "ask-cknp-aaaaaaaaaa";
  const job = { schema: "ask-job-v1", id, execCwd: jobs, workspace: "D:/evck-ws", implementerTurnId: null, implementerRevision: null, createdAt: new Date(Date.now() - 60_000).toISOString(), timeoutMin: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(), flags: [] };
  const jobFile = path.join(jobs, id + ".json");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  const pr = proofV1(job, "vs1");
  ch.writePrimaryComplete(jobs, job, "결속 본문", { verifierSession: "vs1", ...pr });
  fs.unlinkSync(path.join(home, "proofs", pr.proofFile)); // proof 소멸
  const r = cp.spawnSync(process.execPath, [WORKER, jobFile], {
    env: Object.assign({}, process.env, { CODEX_BRIDGE_WORKER_BRIDGE: stub, STUB_MODE: "plain-crash", STUB_ECH: ECH }),
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  const j = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  ck("proof 실물 없는 checkpoint=복구 거부(failed)", r.status !== 0 && j.state === "failed");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
