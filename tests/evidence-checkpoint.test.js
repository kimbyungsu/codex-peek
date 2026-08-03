// primary-complete checkpoint(설계 §6·증분 2) — API 단위 + 실제 ask-job-worker e2e 실행 반례.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "evck_home_"));
process.env.CODEX_BRIDGE_HOME = home;

const ch = require("../bridge/evidence-challenge.js");
const WORKER = path.resolve(__dirname, "../bridge/ask-job-worker.js");
const ECH = path.resolve(__dirname, "../bridge/evidence-challenge.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

// ── 가짜 브릿지(worker가 spawn하는 자식): STUB_MODE로 4경로 재현 ─────────────────────
const stub = path.join(home, "stub-bridge.js");
fs.writeFileSync(stub, `
const fs=require("fs"),path=require("path");
const mode=process.env.STUB_MODE||"plain-ok";
const jobFile=process.env.CODEX_BRIDGE_JOB_PROMPT_FILE;
const job=JSON.parse(fs.readFileSync(jobFile,"utf8"));
const dir=path.dirname(jobFile);
if(mode==="ckpt-crash"||mode==="ckpt-tamper"){
  const ech=require(process.env.STUB_ECH);
  const ok=ech.writePrimaryComplete(dir,job,"정답 본문 결속판 "+"x".repeat(200),{verifierSession:"vs-e2e",proofFp:"pf-e2e"});
  if(!ok){process.stdout.write("CKPT-FAIL");process.exit(9);}
  if(mode==="ckpt-tamper") fs.appendFileSync(path.join(dir,job.id+".out"),"변조");
  process.stdout.write("PARTIAL-STDOUT");
  process.exit(7);
}
if(mode==="plain-crash"){process.stdout.write("PARTIAL");process.exit(7);}
process.stdout.write("전체 정답 출력");process.exit(0);
`, "utf8");

let seq = 0;
function runWorker(mode) {
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "evck_jobs_"));
  const id = "ask-ck" + (++seq);
  const job = {
    schema: "ask-job-v1", id, execCwd: jobs, workspace: "D:/evck-ws",
    implementerTurnId: "turn-1", implementerRevision: 3,
    timeoutMin: 1, deadlineAt: new Date(Date.now() + 60_000).toISOString(), flags: [],
  };
  const jobFile = path.join(jobs, id + ".json");
  fs.writeFileSync(jobFile, JSON.stringify(job), "utf8");
  const r = cp.spawnSync(process.execPath, [WORKER, jobFile], {
    env: Object.assign({}, process.env, { CODEX_BRIDGE_WORKER_BRIDGE: stub, STUB_MODE: mode, STUB_ECH: ECH }),
    encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  return { jobs, id, exit: r.status, job: JSON.parse(fs.readFileSync(jobFile, "utf8")), out: (() => { try { return fs.readFileSync(path.join(jobs, id + ".out"), "utf8"); } catch { return null; } })() };
}

console.log("[1] API 단위 — 결속·read-back·유효성");
{
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "evck_api_"));
  const job = { id: "ask-a1", workspace: "D:/w", implementerTurnId: "t1", implementerRevision: 2 };
  const bind = { verifierSession: "vs1", proofFp: "pf1" };
  const ckpt = ch.writePrimaryComplete(jobs, job, "판정 본문입니다. 근거와 결론.", bind);
  ck("정상 생성(스키마·결속 필드)", !!ckpt && ckpt.schema === ch.CKPT_SCHEMA && ckpt.jobId === "ask-a1" && ckpt.implementerRevision === 2 && ckpt.verifierSession === "vs1" && ckpt.proofFp === "pf1");
  const outBuf = fs.readFileSync(path.join(jobs, "ask-a1.out"));
  ck("출력 파일=원문 그대로·지문 일치", outBuf.toString("utf8") === "판정 본문입니다. 근거와 결론." && ckpt.outSha256 === sha(outBuf) && ckpt.outBytes === outBuf.length);
  ck("유효성 판정 통과", !!ch.primaryCheckpointValid(jobs, job));
  ck("빈 출력=생성 거부", ch.writePrimaryComplete(jobs, { ...job, id: "ask-a2" }, "", bind) === null);
  ck("결속 결손(turnId)=거부", ch.writePrimaryComplete(jobs, { ...job, id: "ask-a3", implementerTurnId: "" }, "x답변", bind) === null);
  ck("결속 결손(proofFp)=거부", ch.writePrimaryComplete(jobs, { ...job, id: "ask-a4" }, "x답변", { verifierSession: "vs1", proofFp: "" }) === null);
  ck("revision 비수치=거부", ch.writePrimaryComplete(jobs, { ...job, id: "ask-a5", implementerRevision: "많이" }, "x답변", bind) === null);
  // 변조·결속 불일치=무효
  fs.appendFileSync(path.join(jobs, "ask-a1.out"), "변조");
  ck("출력 변조=유효성 무효", ch.primaryCheckpointValid(jobs, job) === null);
  ck("workspace 불일치=무효", (() => {
    const j2 = { id: "ask-b1", workspace: "D:/w", implementerTurnId: "t1", implementerRevision: 1 };
    ch.writePrimaryComplete(jobs, j2, "본문 바이트", bind);
    return ch.primaryCheckpointValid(jobs, { ...j2, workspace: "D:/딴곳" }) === null;
  })());
}

console.log("[2] worker e2e — checkpoint 복구(§6: challenge 크래시에도 원 job 성공 확정)");
{
  const r = runWorker("ckpt-crash");
  ck("job=succeeded·exitCode 0(회수 계약 보존)", r.job.state === "succeeded" && r.job.exitCode === 0);
  ck("실제 종료코드는 challengeExitCode로 정직 보존", r.job.challengeExitCode === 7 && r.job.checkpointRecovered === true);
  ck("worker 자체도 성공 종료", r.exit === 0);
  ck("출력 파일=결속본 유지(부분 stdout으로 덮어쓰지 않음)", typeof r.out === "string" && r.out.includes("정답 본문 결속판") && !r.out.includes("PARTIAL-STDOUT"));
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

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
