#!/usr/bin/env node
"use strict";
// 내구 검증 작업 worker. 호출 도구/IDE 턴이 먼저 닫혀도 이 프로세스가 dashboard의 verifyTimeoutMin까지
// codex-bridge ask를 소유한다. 프롬프트는 명령줄이 아니라 job JSON을 통해 전달한다.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, "utf8");
    for (let i = 0; i < 12; i++) {
      try { fs.renameSync(tmp, file); return true; }
      catch { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* retry */ } }
    }
  } catch { /* 아래 정리 */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return false;
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function patch(file, extra) {
  const cur = read(file);
  return !!cur && atomicWrite(file, JSON.stringify(Object.assign({}, cur, extra)));
}
// primary-complete checkpoint 판정(설계 §6 — bridge/evidence-challenge.js primaryCheckpointValid와
// 같은 규칙·의도적 사본: worker는 의존 최소 원칙이라 contract-lib 연쇄 로드를 피한다. 드리프트는
// tests/evidence-checkpoint.test.js가 API로 만든 checkpoint를 이 worker로 판정시켜 잠근다).
// 유효 조건: 스키마·jobId·workspace + 구현 턴/revision(null 동등 포함 전량 대조) + verifier session
// + proof 실물(BRIDGE_DIR/proofs/<basename> 원문 SHA-256=proofFp·proof.jobId=이 job) + 출력
// 바이트 수·SHA-256 일치. proof는 실제 검증 수락 때만 만들어지므로 위조·stale checkpoint는 여기서 죽는다.
function sha256Hex(buf) { return require("crypto").createHash("sha256").update(buf).digest("hex"); }
function primaryCheckpoint(dir, job, outFile) {
  const c = read(path.join(dir, job.id + ".checkpoint.json"));
  if (!c || c.schema !== "primary-complete-v1" || c.jobId !== job.id) return null;
  if (String(c.workspace || "") !== String(job.workspace || "")) return null;
  const nn = (v) => v === null || v === undefined ? null : String(v);
  if (nn(c.implementerTurnId) !== nn(job.implementerTurnId)) return null;
  const nrev = (v) => v === null || v === undefined ? null : Number(v);
  const cr = nrev(c.implementerRevision), jr = nrev(job.implementerRevision);
  if (cr === null ? jr !== null : !(Number.isFinite(cr) && cr === jr)) return null;
  if (!String(c.verifierSession || "").trim()) return null;
  if (typeof c.proofFile !== "string" || !/^[A-Za-z0-9._-]+\.json$/.test(c.proofFile) || c.proofFile.includes("..")) return null;
  const bridgeDir = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
  let praw; try { praw = fs.readFileSync(path.join(bridgeDir, "proofs", c.proofFile)); } catch { return null; }
  if (sha256Hex(praw) !== c.proofFp) return null;
  // proof '실형식' 결속(evidence-challenge.js proofMatches와 같은 규칙): v2=strictProofV2 전체 규칙,
  // v1=정확 키 9종(부분 필드 의사 proof 거부). 그 위에 검증자 세션·workspace(플랫폼 분기)·job 결속.
  try {
    const p = JSON.parse(praw.toString("utf8"));
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const exact = (o, keys) => { const k = Object.keys(o); return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x)); };
    if (p.v === 2) {
      if (!exact(p, ["v", "implementerSession", "workspace", "ts", "codexSession", "exit", "status", "answerChars", "jobId", "turnId", "implementerRevision", "headState", "headOid"])) return null;
      if (typeof p.implementerSession !== "string" || !p.implementerSession) return null;
      if (typeof p.workspace !== "string" || !p.workspace) return null;
      if (!Number.isFinite(Date.parse(p.ts || ""))) return null;
      if (p.exit !== 0 || p.status !== "success" || !(Number(p.answerChars) > 0)) return null;
      if (!/^ask-[a-z0-9]+-[0-9a-f]{10}$/.test(String(p.jobId || ""))) return null;
      if (typeof p.turnId !== "string" || !p.turnId) return null;
      if (!(Number(p.implementerRevision) > 0)) return null;
      if (!["git", "non-git", "no-head"].includes(p.headState)) return null;
      if (p.headState === "git" ? !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(p.headOid || "")) : p.headOid !== null) return null;
    } else if (p.v === 1) {
      if (!exact(p, ["v", "claudeSession", "implementerSession", "workspace", "ts", "codexSession", "exit", "status", "answerChars"])) return null;
      if (typeof p.claudeSession !== "string" || !p.claudeSession) return null;
      if (p.implementerSession !== "") return null;
      if (typeof p.workspace !== "string" || !p.workspace) return null;
      if (!Number.isFinite(Date.parse(p.ts || ""))) return null;
      if (typeof p.codexSession !== "string" || !p.codexSession) return null;
      if (p.exit !== 0 || p.status !== "success" || !(Number(p.answerChars) > 0)) return null;
    } else return null;
    if (String(p.codexSession || "") !== String(c.verifierSession)) return null;
    // workspace 비교 플랫폼 분기(POSIX에서 \=파일명 문자·대소문자 구별 — 접으면 타 프로젝트 동일시)
    const nws = process.platform === "win32"
      ? (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      : (s) => String(s || "").replace(/\/+$/, "");
    if (!nws(p.workspace) || nws(p.workspace) !== nws(job.workspace)) return null;
    if (p.v === 2) {
      if (p.jobId !== job.id || String(p.turnId || "") !== String(job.implementerTurnId || "")
        || Number(p.implementerRevision) !== Number(job.implementerRevision)) return null;
    } else {
      if (job.implementerTurnId !== null && job.implementerTurnId !== undefined) return null; // C-C에 v1 금지
      const pt = Date.parse(p.ts || ""), jt = Date.parse(job.createdAt || "");
      if (!Number.isFinite(pt) || !Number.isFinite(jt) || pt < jt) return null;
    }
  } catch { return null; }
  if (!c.outSha256 || !Number.isInteger(c.outBytes)) return null;
  let buf; try { buf = fs.readFileSync(outFile); } catch { return null; }
  if (buf.length !== c.outBytes) return null;
  return sha256Hex(buf) === c.outSha256 ? c : null;
}

function main() {
  const jobFile = path.resolve(process.argv[2] || "");
  const job = read(jobFile);
  if (!job || job.schema !== "ask-job-v1" || !job.id || !job.execCwd) process.exit(2);
  const dir = path.dirname(jobFile);
  const outFile = path.join(dir, job.id + ".out");
  const errFile = path.join(dir, job.id + ".err");
  try{atomicWrite(path.join(dir,job.id+".pid"),String(process.pid));}catch{/* 부모 pid 파일이 보통 먼저 존재 */}
  patch(jobFile, { state: "running", workerPid: process.pid, startedAt: new Date().toISOString() });
  const bridge = process.env.CODEX_BRIDGE_WORKER_BRIDGE || path.join(__dirname, "codex-bridge.js"); // env는 격리 테스트용
  const timeoutMin = Math.max(1, Math.min(60, Math.round(Number(job.timeoutMin) || 8)));
  const deadline=Date.parse(job.deadlineAt||"");
  const remainingMs=Number.isFinite(deadline)?deadline-Date.now():timeoutMin*60*1000;
  if(remainingMs<=0){
    fs.writeFileSync(errFile,"verification deadline elapsed before worker start","utf8");
    patch(jobFile,{state:"failed",exitCode:1,error:"verification deadline elapsed before worker start",finishedAt:new Date().toISOString()});
    process.exit(1);
  }
  let r;
  try {
    r = cp.spawnSync(process.execPath, [bridge, "ask", ...(Array.isArray(job.flags) ? job.flags : []), "--job-prompt"], {
      cwd: job.execCwd,
      env: Object.assign({}, process.env, {
        CODEX_BRIDGE_VERIFY_TIMEOUT_MIN: String(timeoutMin),
        CODEX_BRIDGE_VERIFY_DEADLINE_AT: job.deadlineAt,
        CODEX_BRIDGE_JOB_PROMPT_FILE: jobFile,
        // P-6: 검증된 자기 job 파일의 id를 명시 전달(상속값 불신 — writeProof v2가 파일과 대조).
        CODEX_BRIDGE_ASK_JOB_ID: String(job.id),
      }),
      encoding: "utf8", windowsHide: true,
      // 내부 bridge가 절대 deadline에 Codex 자식을 끊고 결과를 정리할 짧은 여유만 준다.
      timeout: remainingMs + 10000,
      maxBuffer: 1024 * 1024 * 256,
    });
  } catch (e) {
    fs.writeFileSync(errFile, String(e && e.stack || e), "utf8");
    patch(jobFile, { state: "failed", exitCode: 1, error: String(e && e.message || e), finishedAt: new Date().toISOString() });
    process.exit(1);
  }
  // checkpoint 복구(설계 §6): 원 검증이 출력·proof까지 확정한 뒤(challenge 단계에서) 죽었다면,
  // 원 job은 성공이다 — .out 기록 '전'에 판정해야 부분 stdout이 결속본을 덮어쓰지 못한다.
  const ckpt = primaryCheckpoint(dir, job, outFile);
  if (ckpt) {
    try { fs.writeFileSync(errFile, String(r.stderr || ""), "utf8"); } catch { /* ignore */ }
    const realCode = Number.isInteger(r.status) ? r.status : 1;
    // exitCode 0 확정=proof 회수 계약(writeRecoveryReceipt: succeeded+exitCode 0) 보존.
    // 실제 종료코드는 challengeExitCode로 정직 보존 — challenge 쪽 상태 수렴(outcome-unknown)은
    // challenge 장부의 소관(증분 4 배선·§5 복구)이지 원 job의 소관이 아니다.
    patch(jobFile, {
      state: "succeeded", exitCode: 0, challengeExitCode: realCode, checkpointRecovered: realCode !== 0,
      signal: r.signal || null, error: null, finishedAt: new Date().toISOString(),
    });
    process.exit(0);
  }
  try { fs.writeFileSync(outFile, String(r.stdout || ""), "utf8"); } catch { /* status still records failure/success */ }
  try { fs.writeFileSync(errFile, String(r.stderr || ""), "utf8"); } catch { /* ignore */ }
  const code = Number.isInteger(r.status) ? r.status : 1;
  const ok = code === 0 && !r.error;
  patch(jobFile, {
    state: ok ? "succeeded" : "failed", exitCode: code,
    signal: r.signal || null, error: r.error ? String(r.error.message || r.error) : null,
    finishedAt: new Date().toISOString(),
  });
  process.exit(ok ? 0 : code || 1);
}

main();
