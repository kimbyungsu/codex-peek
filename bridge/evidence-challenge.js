"use strict";
// 근거 재확인(evidence challenge) — 순수 계층(증분 1). 정본: docs/EVIDENCE-RECONFIRM-DESIGN.md §2·§4·§5.
// 이 파일은 '동결·적격성·상한·장부·응답 대조'만 안다. 발송(resume)·ack 투영·checkpoint·lease는
// 이후 증분의 소관 — 여기서는 어떤 파이프라인 함수도 호출하지 않는다(설계 B의 격리 전제).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { BRIDGE_DIR, wsKeyFor, atomicWrite, withFileLockStrict } = require("./contract-lib.js");

// §2 상한(구현 파라미터 — 설계 문서와 함께 개정)
const CH_MAX_FILE_BYTES = 1024 * 1024;      // 파일별 읽기 상한
const CH_MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 경보당 총 읽기 상한
const CH_MAX_FILES = 8;                     // 경보당 challenge 파일 수 상한
const CH_MAX_RESP_BYTES = 64 * 1024;        // 총 응답 바이트 상한
const CH_SPAN_MIN = 64, CH_SPAN_MAX = 512;  // 구간 길이 범위
const CH_MIN_ELIGIBLE = 16;                 // 이 미만 구간·파일은 항상 부적격(추측 가능 소형 차단)
const CH_RETENTION_DAYS = 90;               // 종결 레코드 감사 보존기간(§5)
const CHALLENGES_DIR = path.join(BRIDGE_DIR, "evidence-challenges");

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function realOf(p) { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } }

// §2 루트 결속: realpath 기준 자손만(Windows 대소문자·구분자 경계는 path.relative가 처리, symlink는
// 양쪽 realpath로 이탈 거부). 루트 자체와 같은 경로는 파일이 아니므로 불인정.
function underRoot(fileReal, rootReal) {
  if (!fileReal || !rootReal) return false;
  const a = process.platform === "win32" ? String(fileReal).toLowerCase() : String(fileReal);
  const b = process.platform === "win32" ? String(rootReal).toLowerCase() : String(rootReal);
  const rel = path.relative(b, a);
  return !!rel && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

// §2 저정보 판정 — 부적격 사유를 돌려준다("" = 적격).
// 완전 반복은 '어떤 주기 p(1≤p≤길이/2)'의 일반 판정(임계 열거 금지 — 설계 [주의] 계보).
function spanIneligible(buf) {
  if (buf.length < CH_MIN_ELIGIBLE) return "too-short";
  if (new Set(buf).size < 8) return "low-info";
  let ws = 0;
  for (const b of buf) if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) ws++;
  if (ws / buf.length >= 0.9) return "low-info";
  for (let p = 1; p <= buf.length >> 1; p++) {
    if (buf.length % p) continue; // 완전 반복 = 길이가 주기의 배수
    let rep = true;
    for (let i = p; i < buf.length; i++) if (buf[i] !== buf[i % p]) { rep = false; break; }
    if (rep) return "low-info";
  }
  return "";
}

// §2 구간 선택: 적격성(기노출 제외+저정보) 선행 → 적격 후보에서 crypto.randomBytes 기반 선택.
// exposedBufs = 원 요청문·답변의 바이트(기노출 구간 제외용). 반환 {off,len} 또는 null(no-safe-span).
function pickSpan(buf, exposedBufs) {
  const exposed = (span) => (exposedBufs || []).some((e) => e && e.includes(span));
  const okAt = (off, len) => {
    const span = buf.slice(off, off + len);
    return !spanIneligible(span) && !exposed(span) ? { off, len } : null;
  };
  if (buf.length < CH_MIN_ELIGIBLE) return null;
  if (buf.length < CH_SPAN_MIN) return okAt(0, buf.length); // 소형 파일=전체, 같은 적격성 검사
  const maxLen = Math.min(CH_SPAN_MAX, buf.length);
  const rnd = crypto.randomBytes(32 * 8);
  for (let i = 0; i < 32; i++) {
    const len = CH_SPAN_MIN + (rnd.readUInt32BE(i * 8) % (maxLen - CH_SPAN_MIN + 1));
    const off = rnd.readUInt32BE(i * 8 + 4) % (buf.length - len + 1);
    const hit = okAt(off, len);
    if (hit) return hit;
  }
  // 결정론 폴백(확인 검증 보완): 무작위 추첨이 빗나가도 격자 스윕이 잡는다. 아래 분리 함수 참조.
  return pickSpanGrid(buf, exposedBufs);
}
// 결정론 격자 스윕(len=64·보폭 32) — 격자 위 적격 후보가 있으면 반드시 발견한다. 오프셋 전수
// (보폭 1)는 아니며(대형 파일 비용), '격자 밖에만 적격 후보가 있는' 병리적 경우는 no-safe-span
// = 경보 유지의 안전한 실패 방향으로 떨어진다(설계 §2에 같은 문구로 명문화 — 발견법 한계 부류).
// pickSpan의 폴백이자, 테스트가 무작위 단계와 무관하게 폴백 자체를 잠그는 지점(분리 export).
function pickSpanGrid(buf, exposedBufs) {
  const exposed = (span) => (exposedBufs || []).some((e) => e && e.includes(span));
  for (let off = 0; off + CH_SPAN_MIN <= buf.length; off += CH_SPAN_MIN >> 1) {
    const span = buf.slice(off, off + CH_SPAN_MIN);
    if (!spanIneligible(span) && !exposed(span)) return { off, len: CH_SPAN_MIN };
  }
  return null;
}

// §2 동결: 파일 목록을 받아 challenge 레코드를 만든다. 파일마다 '단일 읽기(한 Buffer)'에서 전체
// SHA-256과 구간 digest를 함께 계산한다(세대 혼합 금지). 부적격·상한 초과·루트 밖은 발송하지 않고
// 사유만 기록(경보 유지 — 안전한 실패 방향). 원문 바이트는 저장하지 않는다(digest·범위만).
// 필수 결속(§5 — 확인 검증 blocker): 원 verifier session·모드/언어 동결·campaign/ask ID가 없으면
// 재확인은 원 검증과 결속될 수 없다 — 결손 시 동결 자체를 거부(fail-closed).
const REQUIRED_BINDINGS = ["verifierSession", "mode", "lang", "campaignId", "askId"];
function freezeChallenge(opts) {
  const { eventId, ws, execCwd, roots, files, exposedTexts, meta } = opts || {};
  // eventId·ws·execCwd도 필수(확인 검증 blocker 재등장): ws가 비면 wsKeyFor("")의 '공용 장부'에
  // 여러 프로젝트가 섞여 격리가 무너진다. 셋 중 하나라도 비면 동결 거부.
  if (!String(eventId || "").trim() || !String(ws || "").trim() || !String(execCwd || "").trim()) return null;
  const bind = {};
  for (const k of REQUIRED_BINDINGS) {
    const v = opts && typeof opts[k] === "string" ? opts[k].trim() : "";
    if (!v) return null; // 결속 결손 — 동결 거부
    bind[k] = v;
  }
  const rootReals = (roots || []).map(realOf).filter(Boolean);
  const exposedBufs = (exposedTexts || []).map((t) => Buffer.from(String(t || ""), "utf8"));
  const readFileFn = (opts && opts.readFile) || ((p) => fs.readFileSync(p)); // 시험 주입 지점(기본=실판독)
  const out = [];
  const usedIds = new Set(); // pathId는 challenge 안에서 고유해야 응답 1줄=파일 1개 결속이 성립
  const newPathId = () => {
    for (;;) { const id = "p" + crypto.randomBytes(8).toString("hex"); if (!usedIds.has(id)) { usedIds.add(id); return id; } }
  };
  let totalRead = 0, n = 0;
  for (const f of files || []) {
    n++;
    const base = { pathId: newPathId(), path: String(f) };
    if (n > CH_MAX_FILES) { out.push({ ...base, status: "skipped", reason: "cap-exceeded" }); continue; }
    const real = realOf(f);
    if (!real) { out.push({ ...base, status: "skipped", reason: "read-fail" }); continue; }
    if (!rootReals.some((r) => underRoot(real, r))) { out.push({ ...base, path: real, status: "skipped", reason: "out-of-root" }); continue; }
    let st = null;
    try { st = fs.statSync(real); } catch { /* 아래 read-fail */ }
    if (!st || !st.isFile()) { out.push({ ...base, path: real, status: "skipped", reason: "read-fail" }); continue; }
    if (st.size > CH_MAX_FILE_BYTES) { out.push({ ...base, path: real, status: "skipped", reason: "too-large" }); continue; }
    if (totalRead + st.size > CH_MAX_TOTAL_BYTES) { out.push({ ...base, path: real, status: "skipped", reason: "cap-exceeded" }); continue; }
    let buf = null;
    try { buf = readFileFn(real); } catch { out.push({ ...base, path: real, status: "skipped", reason: "read-fail" }); continue; }
    // stat 이후 파일이 커졌을 수 있다(확인 검증 blocker) — 실제 읽은 바이트로 상한을 재검사한다.
    if (buf.length > CH_MAX_FILE_BYTES) { out.push({ ...base, path: real, status: "skipped", reason: "too-large" }); continue; }
    if (totalRead + buf.length > CH_MAX_TOTAL_BYTES) { out.push({ ...base, path: real, status: "skipped", reason: "cap-exceeded" }); continue; }
    totalRead += buf.length;
    const span = pickSpan(buf, exposedBufs);
    if (!span) { out.push({ ...base, path: real, status: "skipped", reason: "no-safe-span" }); continue; }
    out.push({
      ...base, path: real, status: "pending",
      fileSha: sha256(buf), off: span.off, len: span.len, spanSha: sha256(buf.slice(span.off, span.off + span.len)),
    });
  }
  return {
    v: 1,
    challengeId: "ch-" + crypto.randomBytes(8).toString("hex"),
    eventId: String(eventId || ""),
    ws: String(ws || ""), execCwd: String(execCwd || ""),
    ...bind,
    meta: meta && typeof meta === "object" ? meta : {},
    createdAt: nowIso(), attempt: 0,
    state: out.some((x) => x.status === "pending") ? "pending" : "no-dispatch",
    files: out,
  };
}

// §5 권위 장부: ws 결속 디렉터리에 challenge 1건=파일 1개(비절단·50건 절단 이벤트와 별도).
function challengeDirFor(ws) { return path.join(CHALLENGES_DIR, wsKeyFor(ws)); }
function challengeFileFor(ws, challengeId) { return path.join(challengeDirFor(ws), String(challengeId) + ".json"); }
function writeChallenge(rec) {
  if (!rec || !rec.challengeId) return null;
  const dir = challengeDirFor(rec.ws);
  fs.mkdirSync(dir, { recursive: true });
  // create-only 원자 생성(확인 검증 blocker — atomicWrite의 rename은 덮어쓰기라 attempt 리셋 통로):
  // tmp에 완전히 쓴 뒤 linkSync로 결속 — 대상이 이미 있으면 EEXIST로 거부되어 기존 레코드(상태·
  // attempt)는 어떤 경로로도 되돌릴 수 없다. 갱신은 오직 transitionChallenge(잠금+전이 규칙)뿐.
  const file = challengeFileFor(rec.ws, rec.challengeId);
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
    fs.linkSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch { /* 무해 */ } return null; }
  try { fs.unlinkSync(tmp); } catch { /* 무해 */ }
  return rec;
}
function readChallenge(ws, challengeId) {
  try { return JSON.parse(fs.readFileSync(challengeFileFor(ws, challengeId), "utf8")); } catch { return null; }
}
function listChallenges(ws) {
  try {
    return fs.readdirSync(challengeDirFor(ws)).filter((x) => x.endsWith(".json"))
      .map((x) => readChallenge(ws, x.slice(0, -5))).filter(Boolean);
  } catch { return []; }
}

const SETTLED = new Set(["resolved", "failed", "indeterminate", "outcome-unknown"]);
// §5 상태 전이는 장부 파일 잠금 아래 원자적으로: pending→dispatched(호출 전 선기록·시도 최대 1),
// dispatched→종결 4종. 그 외 전이는 거부(복구는 재발송이 아니라 outcome-unknown 방향).
function transitionChallenge(ws, challengeId, fn) {
  const file = challengeFileFor(ws, challengeId);
  const held = withFileLockStrict(file + ".lock", () => {
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { ok: false, reason: "not-found" }; }
    const next = fn(rec);
    if (!next || !next.ok) return next || { ok: false, reason: "rejected" };
    if (!atomicWrite(file, JSON.stringify(next.rec, null, 1))) return { ok: false, reason: "write-fail" };
    return { ok: true, rec: next.rec };
  });
  // withFileLockStrict는 {ok, result|error}로 감싼다 — 잠금 실패도 전이 실패로 평탄화
  return held.ok ? held.result : { ok: false, reason: held.error || "lock-fail" };
}
function markDispatched(ws, challengeId) {
  return transitionChallenge(ws, challengeId, (rec) => {
    if (rec.state !== "pending") return { ok: false, reason: "not-pending" };
    if (Number(rec.attempt) !== 0) return { ok: false, reason: "already-attempted" }; // 시도 최대 1
    return { ok: true, rec: { ...rec, state: "dispatched", attempt: 1, dispatchedAt: nowIso() } };
  });
}
function settleChallenge(ws, challengeId, judged) {
  return transitionChallenge(ws, challengeId, (rec) => {
    if (rec.state !== "dispatched") return { ok: false, reason: "not-dispatched" };
    if (!SETTLED.has(judged.overall)) return { ok: false, reason: "bad-state" };
    const byId = new Map((judged.files || []).map((f) => [f.pathId, f.status]));
    const files = rec.files.map((f) => f.status === "pending" && byId.has(f.pathId) ? { ...f, status: byId.get(f.pathId) } : f);
    return { ok: true, rec: { ...rec, state: judged.overall, files, settledAt: nowIso() } };
  });
}
// 강제 종료 복구(§5): dispatched로 남은 레코드는 재발송하지 않고 outcome-unknown으로 수렴.
function markOutcomeUnknown(ws, challengeId) {
  return transitionChallenge(ws, challengeId, (rec) => {
    if (rec.state !== "dispatched") return { ok: false, reason: "not-dispatched" };
    return { ok: true, rec: { ...rec, state: "outcome-unknown", settledAt: nowIso() } };
  });
}
// §5 수명: 미종결 삭제 금지 — 종결 레코드만 보존기간(90일) 지나면 정리.
function cleanupSettled(ws, days = CH_RETENTION_DAYS) {
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  for (const rec of listChallenges(ws)) {
    if (!SETTLED.has(rec.state) && rec.state !== "no-dispatch") continue;
    const t = Date.parse(rec.settledAt || rec.createdAt || "");
    if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(challengeFileFor(ws, rec.challengeId)); removed++; } catch { /* best-effort */ } }
  }
  // create-only 저장의 성공 후 tmp 삭제가 실패했을 수 있다(확인 검증 [주의] — 결속 정보가 정리
  // 대상 밖에 영구 잔존). 1일 넘은 *.tmp를 함께 정리한다(진행 중 저장과의 경합은 1일 여유로 배제).
  try {
    const dir = challengeDirFor(ws);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".tmp")) continue;
      const p = path.join(dir, name);
      try { if (fs.statSync(p).mtimeMs < Date.now() - 86400_000) { fs.unlinkSync(p); removed++; } } catch { /* best-effort */ }
    }
  } catch { /* 폴더 없음 등 — 무해 */ }
  return removed;
}

// §4 응답 파싱: 줄 단위 `CH <challengeId> <pathId> <base64>`. challengeId 불일치·미지 pathId 줄은
// 거부, 중복 pathId는 그 pathId 전체를 응답 누락 처리(어느 줄이 진짜인지 모르면 안 세는 쪽이 안전).
// 총 응답 상한 초과는 전체를 누락 처리(overCap — fail-safe).
function parseChallengeResponse(text, rec) {
  const s = String(text || "");
  if (Buffer.byteLength(s, "utf8") > CH_MAX_RESP_BYTES) return { overCap: true, byPath: new Map() };
  const known = new Set((rec.files || []).map((f) => f.pathId));
  const byPath = new Map(), dup = new Set();
  for (const line of s.split(/\r?\n/)) {
    const m = /^CH\s+(\S+)\s+(\S+)\s+([A-Za-z0-9+/=]+)$/.exec(line.trim());
    if (!m || m[1] !== rec.challengeId || !known.has(m[2])) continue;
    if (byPath.has(m[2])) { dup.add(m[2]); continue; }
    byPath.set(m[2], m[3]);
  }
  for (const d of dup) byPath.delete(d);
  return { overCap: false, byPath };
}

// §4 판정: 대조는 동결 스냅샷 기준(현재 파일 아님). 일치=resolved / 불일치·누락은 현재 파일을 다시
// 읽어 전체 SHA가 동결값과 다르면 indeterminate(file-changed — 태만 아님), 같으면 failed(태만).
// 읽기 실패(소멸 포함)=indeterminate. overall: 하나라도 failed→failed, 아니고 하나라도
// indeterminate→indeterminate, 발송분 전부 resolved→resolved.
function judgeChallenge(rec, parsed, readFile) {
  const read = readFile || ((p) => fs.readFileSync(p));
  const files = [];
  for (const f of rec.files || []) {
    if (f.status !== "pending") continue; // skipped는 판정 대상 아님(사유 유지)
    const b64 = parsed && parsed.byPath ? parsed.byPath.get(f.pathId) : undefined;
    if (b64 !== undefined) {
      const buf = Buffer.from(b64, "base64");
      if (buf.length === f.len && sha256(buf) === f.spanSha) { files.push({ pathId: f.pathId, status: "resolved" }); continue; }
    }
    let cur = null;
    try { cur = read(f.path); } catch { files.push({ pathId: f.pathId, status: "indeterminate" }); continue; }
    files.push({ pathId: f.pathId, status: sha256(cur) !== f.fileSha ? "indeterminate" : "failed" });
  }
  const overall = files.some((f) => f.status === "failed") ? "failed"
    : files.some((f) => f.status === "indeterminate") ? "indeterminate"
    : files.length ? "resolved" : "indeterminate";
  return { overall, files };
}

// §5 이벤트 전체 해소 조건: 레코드의 '모든' 파일이 resolved여야 원 이벤트를 ack할 수 있다
// (skipped가 하나라도 있으면 불충족 — 경보 유지). ack 투영 자체는 배선 증분(§9-4)의 소관.
function eventFullyResolved(rec) {
  return rec && rec.state === "resolved" && (rec.files || []).length > 0 && rec.files.every((f) => f.status === "resolved");
}

// ── §6 primary-complete checkpoint (증분 2) ─────────────────────────────────────────────
// 원 검증 성공의 3요소(proof·회수 가능한 원 출력·세션 소유권) 중 '원 출력'을 내구 확정한다.
// 출력 파일(<jobId>.out)을 원자 기록하고 read-back으로 확인한 뒤에만 checkpoint를 만든다 — 이후
// challenge 중 강제 종료가 나도 worker(ask-job-worker.js)는 checkpoint가 유효하면 원 job을
// succeeded(exitCode 0 — writeRecoveryReceipt의 회수 계약 보존·실제 종료코드는 challengeExitCode에
// 보존)로 확정하고, 부분 stdout으로 그 출력 파일을 덮어쓰지 않는다(checkpoint 결속본이 권위).
const CKPT_SCHEMA = "primary-complete-v1";
function checkpointFileFor(jobsDir, jobId) { return path.join(String(jobsDir), String(jobId) + ".checkpoint.json"); }
// proof 실물 대조(확인 검증 blocker — 지문 문자열만 믿으면 실패 child·stale checkpoint가 성공으로
// 승격된다): checkpoint는 proof 파일의 basename을 저장하고, 쓰기·판정 양쪽에서 그 파일을 실제로
// 읽어 ①원문 SHA-256 == proofFp ②proof.jobId == 이 job 을 요구한다. proof는 실제 검증 수락 때만
// writeProof v2가 만들므로, proof 없는 checkpoint는 어느 시점에도 유효해질 수 없다.
function proofBasenameOk(name) { return typeof name === "string" && /^[A-Za-z0-9._-]+\.json$/.test(name) && !name.includes(".."); }
function proofMatches(proofFile, proofFp, jobId) {
  if (!proofBasenameOk(proofFile) || !String(proofFp || "").trim()) return false;
  let raw = null;
  try { raw = fs.readFileSync(path.join(BRIDGE_DIR, "proofs", proofFile)); } catch { return false; }
  if (sha256(raw) !== proofFp) return false;
  try { const p = JSON.parse(raw.toString("utf8")); return !!p && p.jobId === jobId; } catch { return false; }
}
// 구현 턴/revision 결속은 'job에 실재하는 값 그대로'(확인 검증 blocker — CL-C는 null이 정상값):
// null은 null과만 같고, 실값은 실값과 정확히 일치해야 한다. 빈 문자열로 눙치는 우회는 없다.
function turnBindEq(a, b) { return (a === null || a === undefined ? null : String(a)) === (b === null || b === undefined ? null : String(b)); }
function revBindEq(a, b) {
  const na = a === null || a === undefined ? null : Number(a);
  const nb = b === null || b === undefined ? null : Number(b);
  return na === null ? nb === null : Number.isFinite(na) && na === nb;
}
function writePrimaryComplete(jobsDir, job, answerText, bind) {
  if (!job || !String(job.id || "").trim() || !String(job.workspace || "").trim()) return null;
  if (!bind || !String(bind.verifierSession || "").trim()) return null;
  // 턴/revision은 job 값 그대로 동결(CL-C=null·null 허용, C-C=실값). revision이 실값이면 수치여야 한다.
  const turnId = job.implementerTurnId === null || job.implementerTurnId === undefined ? null : String(job.implementerTurnId);
  const rev = job.implementerRevision === null || job.implementerRevision === undefined ? null : Number(job.implementerRevision);
  if (rev !== null && !Number.isFinite(rev)) return null;
  if (!proofMatches(bind.proofFile, bind.proofFp, job.id)) return null; // proof 실물 결속 — 쓰기 시점부터 강제
  const data = Buffer.from(String(answerText || ""), "utf8");
  if (!data.length) return null; // 빈 출력에 checkpoint 금지(성공 job이 빈 판정 본문으로 회수되는 상태 차단)
  const outFile = path.join(String(jobsDir), job.id + ".out");
  if (!atomicWrite(outFile, data.toString("utf8"))) return null;
  let back = null;
  try { back = fs.readFileSync(outFile); } catch { return null; }
  if (back.length !== data.length || sha256(back) !== sha256(data)) return null; // read-back 불일치=생성 거부
  const ck = {
    schema: CKPT_SCHEMA, jobId: job.id, workspace: job.workspace,
    implementerTurnId: turnId, implementerRevision: rev,
    verifierSession: String(bind.verifierSession), proofFp: String(bind.proofFp), proofFile: String(bind.proofFile),
    outBytes: back.length, outSha256: sha256(back), createdAt: nowIso(),
  };
  return atomicWrite(checkpointFileFor(jobsDir, job.id), JSON.stringify(ck, null, 1)) ? ck : null;
}
function readPrimaryCheckpoint(jobsDir, jobId) {
  try { return JSON.parse(fs.readFileSync(checkpointFileFor(jobsDir, jobId), "utf8")); } catch { return null; }
}
// worker와 같은 판정(테스트가 양쪽 드리프트를 잠근다): 스키마·jobId·workspace + 구현 턴/revision
// (null 동등 포함 전량 대조) + verifier session + proof 실물(지문·jobId) + 출력 바이트·SHA 일치.
// 하나라도 어긋나면 무효(기존 실패 경로 — 안전 방향).
function primaryCheckpointValid(jobsDir, job) {
  const c = readPrimaryCheckpoint(jobsDir, job && job.id);
  if (!c || c.schema !== CKPT_SCHEMA || c.jobId !== job.id) return null;
  if (String(c.workspace || "") !== String(job.workspace || "")) return null;
  if (!turnBindEq(c.implementerTurnId, job.implementerTurnId) || !revBindEq(c.implementerRevision, job.implementerRevision)) return null;
  if (!String(c.verifierSession || "").trim()) return null;
  if (!proofMatches(c.proofFile, c.proofFp, job.id)) return null;
  if (!c.outSha256 || !Number.isInteger(c.outBytes)) return null;
  let buf = null;
  try { buf = fs.readFileSync(path.join(String(jobsDir), job.id + ".out")); } catch { return null; }
  if (buf.length !== c.outBytes || sha256(buf) !== c.outSha256) return null;
  return c;
}

module.exports = {
  CH_MAX_FILE_BYTES, CH_MAX_TOTAL_BYTES, CH_MAX_FILES, CH_MAX_RESP_BYTES,
  CH_SPAN_MIN, CH_SPAN_MAX, CH_MIN_ELIGIBLE, CH_RETENTION_DAYS, CHALLENGES_DIR,
  underRoot, spanIneligible, pickSpan, pickSpanGrid, freezeChallenge,
  challengeDirFor, challengeFileFor, writeChallenge, readChallenge, listChallenges,
  markDispatched, settleChallenge, markOutcomeUnknown, cleanupSettled,
  parseChallengeResponse, judgeChallenge, eventFullyResolved,
  CKPT_SCHEMA, checkpointFileFor, writePrimaryComplete, readPrimaryCheckpoint, primaryCheckpointValid,
};
