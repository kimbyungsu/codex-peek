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
      : (s) => { const t = String(s || "").replace(/\/+$/, ""); return t || (String(s || "").startsWith("/") ? "/" : ""); }; // 루트 / 보존
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

// [3b] 선별 실패의 단일 정착점 — errFile 기록+terminal failed patch(selectorOutcome=사유 키).
// [§4-B ④] 서고 선별 정상 범위 초과 정보 줄 — 자식 stderr 앞에 붙여 .err에 남긴다(경보 아님)
let selectionNote = "";
function failJob(jobFile, errFile, msg, extra) {
  try { fs.writeFileSync(errFile, msg, "utf8"); } catch { /* patch가 사유를 보존 */ }
  patch(jobFile, Object.assign({ state: "failed", exitCode: 1, error: msg, finishedAt: new Date().toISOString() }, extra || {}));
}
// [Envelope Selector v7 §3 — 3b] 선별 단계: queued→selecting(CAS)→페이지 병렬 실행(취소 폴링·예산)→
// strict 판독→합집합 상한→영수증 read-back 관문→selecting→running(CAS·verifierDeadlineAt 확정).
// 의존은 이 분기에서만 lazy 로드(미도입 job=이 함수 미진입·완전 무회귀) — 로드 실패=정직 실패(fail-closed).
async function runSelectionPhase(jobFile, dir, job, errFile) {
  let CL, SR, CB, fakePage = null;
  try {
    CL = require(path.join(__dirname, "contract-lib.js"));
    SR = require(path.join(__dirname, "selector-runner.js"));
    // env는 격리 테스트용 — '페이지 실행기'만 대체(공용 루프 runSelectorPages는 항상 실물이 시험 대상).
    if (process.env.CODEX_BRIDGE_SELECTOR_RUNNER) fakePage = require(process.env.CODEX_BRIDGE_SELECTOR_RUNNER).runSelectorPage;
    CB = require(path.join(__dirname, "codex-bridge.js"));
    if (typeof CB.acquireAskJobLock !== "function" || typeof CL.selectorScopeMaterial !== "function" || typeof SR.runSelectorPages !== "function") throw new Error("runtime too old");
  } catch (e) { failJob(jobFile, errFile, "selector deps unavailable: " + String((e && e.message) || e), { selectorOutcome: "deps" }); return { ok: false }; }
  const sha1 = (s) => require("crypto").createHash("sha1").update(String(s)).digest("hex");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ws = String(job.workspace || "");
  const intentFile = CB.askJobCancelIntentFile(job.id);
  const t0 = Date.now();
  const selDeadline = Date.parse(job.selectorDeadlineAt || "");
  if (!Number.isFinite(selDeadline) || selDeadline <= t0) { failJob(jobFile, errFile, "selector deadline elapsed before worker start", { selectorOutcome: "selector-timeout" }); return { ok: false }; }
  { // ① queued→selecting — 취소 의사 기록과 같은 ws job 잠금 임계구역(전환 경계 TOCTOU 차단)
    const lk = CB.acquireAskJobLock(ws);
    if (!lk.ok) { failJob(jobFile, errFile, "selector: job lock unavailable", { selectorOutcome: "lock" }); return { ok: false }; }
    try {
      const cur = read(jobFile);
      if (!cur || cur.state !== "queued") { failJob(jobFile, errFile, "selector: unexpected state " + String(cur && cur.state), { selectorOutcome: "state" }); return { ok: false }; }
      if (fs.existsSync(intentFile)) { failJob(jobFile, errFile, "cancelled", { selectorOutcome: "cancelled" }); return { ok: false }; }
      if (!patch(jobFile, { state: "selecting", workerPid: process.pid, startedAt: new Date().toISOString() })) { failJob(jobFile, errFile, "selector: state write failed", { selectorOutcome: "state" }); return { ok: false }; }
    } finally { CB.releaseAskJobLock(ws, lk.token); }
  }
  // [4a 1차 blocker② 봉합] 필드 전량 명시 — writePhase는 직전 전역 레코드를 병합하므로, 명시하지 않은 round·
  // session이 '다른 프로젝트의 직전 값'으로 승계돼 이 워크스페이스 표기에 교차 오염된다. round=0(선별은 회차
  // 예약 전 단계 — 실제 회차는 검증 호출 직전 예약이 정함)·session=null.
  try { CL.writePhase("selecting", { workspace: ws, round: 0, session: null }); } catch { /* 진행 표시 best-effort — 실패 시 검증 요청 표기가 잠시 늦을 뿐 */ } // 대시보드 라이브 표기(§3 selecting)
  // ② archiveCtx 동결 — 서고 재판독(생성 시점 지문과 대조·드리프트=중단)+스냅샷 결속 재검증+변경물 꾸러미.
  let target = ws; try { target = CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo; } catch { /* ws 유지 */ }
  const arc = CL.readVerifyEnvelopeArchive(target);
  if (arc.st !== "ok" || arc.sha1 !== job.selector.archiveHash) { failJob(jobFile, errFile, "selector: archive drift (" + String(arc.st === "ok" ? "hash" : arc.st) + ")", { selectorOutcome: "archive-drift" }); return { ok: false }; }
  const ctx = job.constraintCtx;
  if (!ctx || typeof ctx.turnAnchor !== "string" || typeof ctx.sourceHash !== "string") { failJob(jobFile, errFile, "selector: snapshot context missing", { selectorOutcome: "snapshot" }); return { ok: false }; }
  let snapText = null;
  try { snapText = fs.readFileSync(CL.constraintTurnFileFor(ws, ctx.turnAnchor), "utf8"); } catch { snapText = null; }
  if (snapText === null || sha1(snapText) !== ctx.sourceHash) { failJob(jobFile, errFile, "selector: snapshot missing or mismatched", { selectorOutcome: "snapshot" }); return { ok: false }; }
  const scope = CL.selectorScopeMaterial(target);
  // [1차 blocker 봉합] git 판독 실패=중단 — 빈 재료로 축퇴시키면 '코드에만 드러나는 관련 수칙'이 빠진 선별이
  // 같은 빈 지문으로 주입 관문까지 통과한다(비-git 정상 축퇴는 st:"ok"·nonGit로 구분돼 계속 진행).
  if (scope.st !== "ok") { failJob(jobFile, errFile, "selector: scope material failed (" + String(scope.reason) + ")", { selectorOutcome: "selector-scope" }); return { ok: false }; }
  patch(jobFile, { selectorCtx: { archiveHash: arc.sha1, scopePackageHash: scope.hash, head: scope.head, worktreeFp: scope.worktreeFp, snapshotHash: ctx.sourceHash } }); // 감사 가시화(권위는 전이 시 selection 결속)
  // ③ 페이지 병렬 실행(P 상한·취소 폴링·선별 예산 — 검증 예산 무잠식). [4b] 실행 루프는 selector-preview와
  // 공용 함수(SR.runSelectorPages) — 두 경로의 실행 규약이 갈리지 않게 단일 출처.
  const items = arc.data.alwaysBlocker;
  const pages = CL.buildSelectorPages(items);
  const run9 = await SR.runSelectorPages({
    arm: job.selector.arm === "codex" ? "codex" : "self",
    pages,
    buildPrompt: (pg) => CL.buildSelectorPagePrompt({ snapshotText: snapText, changedFiles: scope.files, diffText: scope.diffText, pageItems: pg }),
    timeoutMs: CL.SELECTOR_PAGE_TIMEOUT_MS,
    parallel: CL.SELECTOR_PARALLEL,
    deadlineAt: selDeadline,
    shouldCancel: () => fs.existsSync(intentFile),
    ...(fakePage ? { pageRunner: fakePage } : {}),
  });
  if (run9.st === "cancelled") { failJob(jobFile, errFile, "cancelled", { selectorOutcome: "cancelled" }); return { ok: false }; }
  if (run9.st !== "ok") { failJob(jobFile, errFile, String(run9.msg || run9.st), { selectorOutcome: run9.st }); return { ok: false }; }
  const results = run9.results;
  const idLists = [];
  for (const it of results) { // 완전성: 전 페이지 성공+strict 판독(부분 수용 없음)
    if (!it || !it.r || !it.r.ok) { failJob(jobFile, errFile, "selector: incomplete page results", { selectorOutcome: "selector-page" }); return { ok: false }; }
    const parsed = CL.parseSelectorPageOutput(it.r.output, it.ids);
    if (!parsed.ok) { failJob(jobFile, errFile, "selector output rejected: " + parsed.reason, { selectorOutcome: "selector-output:" + parsed.reason }); return { ok: false }; }
    idLists.push(parsed.ids);
  }
  const un = CL.selectorUnion(idLists, items);
  // [§4-B ④ 2026-08-31] 합집합 초과는 실패가 아니다 — 승인 수칙 전량 동봉(격하: 정상 범위 초과 표시). 손상 반환만 실패.
  if (!un.ok) { failJob(jobFile, errFile, "selector union rejected (" + un.reason + ")", { selectorOutcome: "selector-union" }); return { ok: false }; }
  // 정보 줄은 마지막 .err 기록에 합류(자식 종료 시 .err를 stderr로 덮어쓰므로 여기서 append하면 사라짐 — 시험 [7] 반례)
  if (un.over && (un.over.items || un.over.bytes)) selectionNote = "[archive rules] related items " + un.over.count + " · " + un.over.bytesTotal + " bytes — above the normal range (" + CL.SELECTOR_UNION_MAX + " · " + CL.SELECTOR_UNION_BYTES_MAX + "); all included — none omitted\n";
  const selectedIds = un.selected.map((s) => s.id);
  // ④ 영수증 기록+read-back 선행 관문 — 성공 전 프롬프트 조립 금지(§3)
  const rec = { ts: new Date().toISOString(), wsKey: CL.wsKeyFor(ws), askId: job.id, turnAnchor: String(ctx.turnAnchor || ""), archiveHash: arc.sha1, scopePackageHash: scope.hash, snapshotHash: ctx.sourceHash, itemCount: items.length, pages: pages.length, selectedIds, arm: job.selector.arm, durationMs: Date.now() - t0 }; // turnAnchor=턴 결속(preview 영수증과 동형 — 주입 캐시 자격 대조용)
  const fname = CL.appendSelectorUsage(rec);
  let back = null;
  try { back = fname ? JSON.parse(fs.readFileSync(path.join(CL.SELECTOR_USAGE_DIR, fname), "utf8")) : null; } catch { back = null; }
  if (!back || JSON.stringify(back) !== JSON.stringify(rec)) { failJob(jobFile, errFile, "selector receipt read-back failed", { selectorOutcome: "selector-receipt" }); return { ok: false }; }
  // ⑤ selecting→running — 같은 잠금 안 intent 재확인 후 원자 전이·verifierDeadlineAt=지금+검증 예산(절대 시각 확정)
  const lk2 = CB.acquireAskJobLock(ws);
  if (!lk2.ok) { failJob(jobFile, errFile, "selector: job lock unavailable at transition", { selectorOutcome: "lock" }); return { ok: false }; }
  try {
    const cur = read(jobFile);
    if (!cur || cur.state !== "selecting") { failJob(jobFile, errFile, "selector: unexpected state at transition " + String(cur && cur.state), { selectorOutcome: "state" }); return { ok: false }; }
    if (fs.existsSync(intentFile)) { failJob(jobFile, errFile, "cancelled", { selectorOutcome: "cancelled" }); return { ok: false }; }
    const timeoutMin = Math.max(1, Math.min(60, Math.round(Number(job.timeoutMin) || 8)));
    const verifierDeadlineAt = new Date(Date.now() + timeoutMin * 60 * 1000).toISOString();
    if (!patch(jobFile, { state: "running", verifierDeadlineAt, selection: { archiveHash: arc.sha1, scopePackageHash: scope.hash, snapshotHash: ctx.sourceHash, selectedIds, itemCount: items.length, pages: pages.length, arm: job.selector.arm, receiptFile: fname }, selectorFinishedAt: new Date().toISOString() })) { failJob(jobFile, errFile, "selector: transition write failed", { selectorOutcome: "state" }); return { ok: false }; }
    return { ok: true, verifierDeadlineAt };
  } finally { CB.releaseAskJobLock(ws, lk2.token); }
}

function main() {
  const jobFile = path.resolve(process.argv[2] || "");
  const job = read(jobFile);
  if (!job || job.schema !== "ask-job-v1" || !job.id || !job.execCwd) process.exit(2);
  const dir = path.dirname(jobFile);
  const outFile = path.join(dir, job.id + ".out");
  const errFile = path.join(dir, job.id + ".err");
  try{atomicWrite(path.join(dir,job.id+".pid"),String(process.pid));}catch{/* 부모 pid 파일이 보통 먼저 존재 */}
  // [3b] 선별 판이면 selection phase가 running 전이를 소유한다(verifierDeadlineAt=전이 시점 확정) —
  // 미도입 job은 아래 legacy 경로 그대로(무회귀).
  if (job.selector && typeof job.selector === "object" && !Array.isArray(job.selector) && job.selector.archiveHash) {
    const resetPhase = () => { try { const CL0 = require(path.join(__dirname, "contract-lib.js")); CL0.writePhase("claude-working", { workspace: String(job.workspace || ""), round: 0, session: null }); } catch { /* 표시 best-effort */ } }; // [4a] 선별 실패 시 진행 표기 잔존(selecting) 방지 — 필드 전량 명시(직전 전역 round·session 승계 오염 차단, blocker②)
    runSelectionPhase(jobFile, dir, job, errFile)
      .then((res) => { if (!res.ok) { resetPhase(); process.exit(1); } runVerification(jobFile, dir, job, outFile, errFile, res.verifierDeadlineAt); })
      .catch((e) => { failJob(jobFile, errFile, "selector crashed: " + String((e && e.message) || e), { selectorOutcome: "crash" }); resetPhase(); process.exit(1); });
    return;
  }
  patch(jobFile, { state: "running", workerPid: process.pid, startedAt: new Date().toISOString() });
  runVerification(jobFile, dir, job, outFile, errFile, job.deadlineAt);
}
function runVerification(jobFile, dir, job, outFile, errFile, deadlineAtIso) {
  const bridge = process.env.CODEX_BRIDGE_WORKER_BRIDGE || path.join(__dirname, "codex-bridge.js"); // env는 격리 테스트용
  const timeoutMin = Math.max(1, Math.min(60, Math.round(Number(job.timeoutMin) || 8)));
  const deadline=Date.parse(deadlineAtIso||"");
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
        // [3b] 선별 판=전이 시점 확정된 verifierDeadlineAt(검증 예산 전액)·legacy=job.deadlineAt(기존 그대로)
        CODEX_BRIDGE_VERIFY_DEADLINE_AT: deadlineAtIso,
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
    try { fs.writeFileSync(errFile, selectionNote + String(r.stderr || ""), "utf8"); } catch { /* ignore */ }
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
  try { fs.writeFileSync(errFile, selectionNote + String(r.stderr || ""), "utf8"); } catch { /* ignore */ }
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
