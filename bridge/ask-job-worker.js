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
