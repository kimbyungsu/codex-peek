/*
 * P8 — 의미 보강 실행기 저장·순수 계층(정본 MAP-V2-DESIGN 'P8 상세 설계 v10' P8-2·P8-3).
 * 이 파일(3a)은 실행기 본체가 소비하는 프리미티브만: 동의 세대(ws×slot grants·genCounter)·작업 장부
 * (enrich-job-v2 — strict·원자·전용 잠금 RMW·손상=fail-closed)·enrich-result-v1 validator(op별 합타입)·
 * toPatchV2 결정론 변환기(결정론 UUID patchId — rev 세대 포함). 실행기 본체(생명주기·라우터 배선·복구
 * 상태표·provider 호출)는 3b에서 이어진다. LLM 호출·외부 전송 0(순수+로컬 파일).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require(path.join(__dirname, "contract-lib.js"));

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const ENRICH_DIR = path.join(BRIDGE_DIR, "map-enrich");
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const repoKeyFor = (repo) => sha1(CL.normWs(realOf(repo))).slice(0, 16);
const consentFileFor = (repo) => path.join(ENRICH_DIR, "consent-" + repoKeyFor(repo) + ".json");
const jobFileFor = (repo) => path.join(ENRICH_DIR, repoKeyFor(repo) + ".job.json");

function readJson3(f) {
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; }
  try { const d = JSON.parse(raw); return d && typeof d === "object" && !Array.isArray(d) ? { st: "ok", data: d } : { st: "invalid" }; } catch { return { st: "invalid" }; }
}

// ── 동의 세대(P8-2 — 1차 blocker②+2차 f-5cb42200+3차 genCounter) ──────────────────
// grants=(ws,slot)별 독립 레코드(upsert — 타 창 보존[ab-2])·ws 키=normWs 정규화·genCounter=파일 수준 전역
// 단조 증가(grant 삭제에도 잔존 — 재동의가 이전 gen을 재사용하는 경로를 상태로 차단). 기존 bootstrap 동의·
// 기존 mapMode 저장은 자동 실행 자격이 아니다(소급 금지 — 이 파일의 grant만 자격).
function readEnrichConsent(repo) {
  const r = readJson3(consentFileFor(repo));
  if (r.st === "absent") return { st: "ok", genCounter: 0, grants: [] }; // 부재=무동의(정상)
  if (r.st !== "ok") return { st: "damaged" }; // 손상=fail-closed(자동 실행 정지·무동의 위장 금지)
  const d = r.data;
  if (d.schema !== "enrich-consent-v1" || !Number.isInteger(d.genCounter) || d.genCounter < 0 || !Array.isArray(d.grants)) return { st: "damaged" };
  const seen = new Set();
  for (const g of d.grants) {
    if (!g || typeof g !== "object" || typeof g.ws !== "string" || !g.ws || (g.slot !== "ko" && g.slot !== "en")
      || typeof g.selfAuto !== "boolean" || !(g.paidMode === null || ["economy", "precision", "auto"].includes(g.paidMode))
      || !Number.isInteger(g.gen) || g.gen < 1 || g.gen > d.genCounter || typeof g.grantedAt !== "string") return { st: "damaged" };
    const k = CL.normWs(g.ws) + "|" + g.slot;
    if (seen.has(k)) return { st: "damaged" }; // 중복 (ws,slot)=단조 불변식 위반(fail-closed)
    seen.add(k);
  }
  return { st: "ok", genCounter: d.genCounter, grants: d.grants };
}
function withConsentLock(repo, fn) {
  try { fs.mkdirSync(ENRICH_DIR, { recursive: true }); } catch { /* 잠금이 실패 판정 */ }
  return CL.withFileLockStrict(consentFileFor(repo) + ".lock", fn);
}
// upsert — 반환 {ok, gen} / {ok:false, reason}
function grantEnrichConsent(repo, opts) {
  const o = opts || {};
  const ws = CL.normWs(String(o.ws || ""));
  // 3a 검증 1차(ab-2): slot·paidMode는 strict — 이형을 조용히 정규화하면 잘못된 호출이 기존 (ws,slot)
  // 동의를 덮거나 다른 슬롯 자격으로 이어진다. 이형=거부.
  if (o.slot !== "ko" && o.slot !== "en") return { ok: false, reason: "slot-invalid" };
  const slot = o.slot;
  if (!ws) return { ok: false, reason: "ws-required" };
  if (!(o.paidMode === null || ["economy", "precision", "auto"].includes(o.paidMode))) return { ok: false, reason: "paid-mode-invalid" };
  if (typeof o.selfAuto !== "boolean") return { ok: false, reason: "selfauto-invalid" }; // 2차(ab-2): 이형이 false로 정규화돼 기존 동의를 덮는 경로 차단
  const selfAuto = o.selfAuto;
  const paidMode = o.paidMode;
  const w = withConsentLock(repo, () => {
    const cur = readEnrichConsent(repo);
    if (cur.st !== "ok") return { ok: false, reason: "consent-damaged" }; // 손상 위 기록 금지(수동 복구 소관)
    const gen = cur.genCounter + 1;
    const grants = cur.grants.filter((g) => !(CL.normWs(g.ws) === ws && g.slot === slot));
    grants.push({ ws, slot, selfAuto, paidMode, gen, grantedAt: new Date().toISOString() });
    const next = { schema: "enrich-consent-v1", genCounter: gen, grants };
    return CL.atomicWrite(consentFileFor(repo), JSON.stringify(next, null, 1)) ? { ok: true, gen } : { ok: false, reason: "write-failed" };
  });
  if (!w.ok) return { ok: false, reason: "lock" };
  return w.result;
}
function revokeEnrichConsent(repo, wsIn, slotIn) {
  const ws = CL.normWs(String(wsIn || ""));
  if (slotIn !== "ko" && slotIn !== "en") return { ok: false, reason: "slot-invalid" };
  const slot = slotIn;
  const w = withConsentLock(repo, () => {
    const cur = readEnrichConsent(repo);
    if (cur.st !== "ok") return { ok: false, reason: "consent-damaged" };
    const grants = cur.grants.filter((g) => !(CL.normWs(g.ws) === ws && g.slot === slot));
    const next = { schema: "enrich-consent-v1", genCounter: cur.genCounter, grants }; // genCounter 잔존(단조 유지)
    return CL.atomicWrite(consentFileFor(repo), JSON.stringify(next, null, 1)) ? { ok: true } : { ok: false, reason: "write-failed" };
  });
  if (!w.ok) return { ok: false, reason: "lock" };
  return w.result;
}
function findGrant(consent, wsIn, slotIn) {
  if (!consent || consent.st !== "ok") return null;
  if (slotIn !== "ko" && slotIn !== "en") return null; // 이형 slot 조회=무자격(다른 슬롯 grant 반환 금지)
  const ws = CL.normWs(String(wsIn || ""));
  return consent.grants.find((g) => CL.normWs(g.ws) === ws && g.slot === slotIn) || null;
}

// ── 작업 장부(enrich-job-v2 — 2층: semantic job+provider attempts. strict·원자·전용 잠금 RMW) ──
const JOB_PHASES = ["open", "done", "parked"];
const ATTEMPT_PHASES = ["running", "applying", "done", "failed", "parked"];
// 3a 검증 1차 blocker①: strict=미지 필드 거부+내용 검증(results·currentPatch·resolutions·UUID 배열)까지 —
// 3b가 이 장부를 재개 정본으로 신뢰하므로 이형이 통과하면 item 건너뜀·오재개·잘못된 patch 재투입.
const JOB_KEYS = ["schema", "jobKey", "mapId", "authorityHash", "decisionContextHash", "mode", "configWs", "slot", "phase", "startedAt", "finishedAt", "parkedReason", "sourceFp", "attempts"];
const ATTEMPT_KEYS = ["attemptId", "provider", "consentGen", "phase", "startedAt", "results", "cursor", "resolutions", "failReason", "parkedReason", "finishedAt"];
const CURSOR_KEYS = ["nextIndex", "rev", "currentPatch", "super", "appliedPatchIds"];
const SUPER_KEYS = ["fromPatchId", "fromOpHash", "toRev", "phase"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FP_RE = /^[0-9a-f]{40}$/;
function unknownKey(obj, allowed) { const k = Object.keys(obj).find((x) => !allowed.includes(x)); return k || null; }
// EnrichItem '형태' strict(3차 f-b74df6a1 — 장부·결과 validator 공용: ID 실존 검사만 제외한 전 규칙).
// 반환 null(정상)|오류 문자열.
function itemShapeError(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return "이형";
  const ITEM_KEYS = { target: ["op", "targetId", "payload", "evidence"], add_edge: ["op", "payload", "evidence"], rewrite_label: ["op", "targetId", "payload", "evidence", "claims"] };
  const allow = ENRICH_TARGET_OPS.includes(it.op) ? ITEM_KEYS.target : ITEM_KEYS[it.op];
  if (!allow) return "미지 op(" + String(it.op) + ")";
  { const u = Object.keys(it).find((k) => !allow.includes(k)); if (u) return "미지 필드(" + u + ")"; }
  const evOk = Array.isArray(it.evidence) && it.evidence.length > 0 && it.evidence.every((e) => e && typeof e === "object" && typeof e.file === "string" && !!e.file && typeof e.quote === "string" && !!e.quote && Object.keys(e).length === 2);
  if (!evOk) return "evidence[{file,quote}] 필수";
  if (!it.payload || typeof it.payload !== "object" || Array.isArray(it.payload)) return "payload 필수";
  const allowP = (() => { try { return require(path.join(__dirname, "project-map.js")).PAYLOAD_KEYS_V2[it.op] || []; } catch { return []; } })();
  if (it.op !== "add_edge" && Object.keys(it.payload).some((k) => !allowP.includes(k))) return "payload 잉여 키";
  if (ENRICH_TARGET_OPS.includes(it.op) || it.op === "rewrite_label") {
    if (typeof it.targetId !== "string" || !it.targetId) return "targetId 필수";
  }
  if (it.op === "add_edge") {
    { const u = Object.keys(it.payload).find((k) => k !== "edge"); if (u) return "payload 미지 필드(" + u + ")"; }
    const e9 = it.payload.edge;
    if (!e9 || typeof e9 !== "object" || Array.isArray(e9)) return "payload.edge 필수";
  }
  if (it.op === "rewrite_label") {
    const cOk = Array.isArray(it.claims) && it.claims.length > 0 && it.claims.every((c) => c && typeof c === "object" && typeof c.file === "string" && !!c.file && typeof c.quote === "string" && !!c.quote && ["support", "rebut"].includes(c.stance) && Object.keys(c).length === 3);
    if (!cOk) return "claims strict 위반";
  }
  return null;
}
function validateJob(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "이형";
  if (d.schema !== "enrich-job-v2") return "schema";
  { const u = unknownKey(d, JOB_KEYS); if (u) return "미지 필드:" + u; }
  for (const k of ["jobKey", "mapId", "authorityHash", "mode", "configWs", "slot", "startedAt"]) if (typeof d[k] !== "string" || !d[k]) return "필드:" + k;
  if (!["self", "economy", "precision", "auto"].includes(d.mode)) return "mode 열거"; // 3차: 미지 열거값 차단
  if (d.slot !== "ko" && d.slot !== "en") return "slot 열거";
  if (!UUID_RE.test(d.mapId)) return "mapId 형식(UUID)"; // 7차 f-b74df6a1
  if (!FP_RE.test(d.authorityHash)) return "authorityHash 형식(sha1)";
  if (d.decisionContextHash !== null && !(typeof d.decisionContextHash === "string" && FP_RE.test(d.decisionContextHash))) return "decisionContextHash";
  if (d.jobKey !== jobKeyOf(d.mapId, d.authorityHash, d.decisionContextHash)) return "jobKey 공식 결속(멱등키=mapId+authorityHash[+dch] — 임의 키는 같은 세대를 다른 job으로 위장해 재과금 재개)"; // 7차
  if (!JOB_PHASES.includes(d.phase)) return "phase";
  if (d.finishedAt !== undefined && typeof d.finishedAt !== "string") return "finishedAt";
  if (d.sourceFp !== undefined && !FP_RE.test(String(d.sourceFp))) return "sourceFp"; // 수렴 장치(3b 1차 blocker⑤ 재설계 — 소스 상태 지문: authority가 아니라 입력에 결속)
  if (d.parkedReason !== undefined && typeof d.parkedReason !== "string") return "parkedReason";
  if (!Array.isArray(d.attempts)) return "attempts";
  // 2차: attemptId=0..n-1 순번 유일(정본 — 중복 id는 유료 attempt 식별 혼선)
  for (let i9 = 0; i9 < d.attempts.length; i9++) { const a9 = d.attempts[i9]; if (!a9 || a9.attemptId !== i9) return "attemptId 순번(" + i9 + ")"; }
  for (const a of d.attempts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return "attempt 이형";
    { const u = unknownKey(a, ATTEMPT_KEYS); if (u) return "attempt 미지 필드:" + u; }
    if (!Number.isInteger(a.attemptId) || a.attemptId < 0) return "attemptId";
    if (!["self", "economy", "precision"].includes(a.provider)) return "attempt provider";
    if (!Number.isInteger(a.consentGen) || a.consentGen < 1) return "consentGen(>=1 — self도 selfAuto grant 세대 동결 필수: 무과금이어도 AI 호출+전송이라 동의 없는 attempt는 장부 경계에서 차단[8차 ab-7])";
    if (!ATTEMPT_PHASES.includes(a.phase)) return "attempt phase";
    if (typeof a.startedAt !== "string") return "attempt startedAt";
    if (a.failReason !== undefined && typeof a.failReason !== "string") return "attempt failReason";
    if (a.parkedReason !== undefined && typeof a.parkedReason !== "string") return "attempt parkedReason";
    if (a.finishedAt !== undefined && typeof a.finishedAt !== "string") return "attempt finishedAt";
    if (a.results !== undefined) { // typed 결과 전문 — EnrichItem 형태 strict 전면(3차 f-b74df6a1: op만 보면 malformed가 수신 완료로 위장)
      const rs9 = a.results;
      if (!rs9 || typeof rs9 !== "object" || Array.isArray(rs9) || rs9.schema !== "enrich-result-v1" || !Array.isArray(rs9.items)) return "attempt results";
      { const u = unknownKey(rs9, ["schema", "items"]); if (u) return "results 미지 필드:" + u; }
      if (rs9.items.length < 1 || rs9.items.length > RESULT_MAX_ITEMS) return "results items 수 상한(1~" + RESULT_MAX_ITEMS + ")"; // 4차: 실 validator와 동형 상한
      try { if (JSON.stringify(rs9).length > RESULT_MAX_CHARS) return "results 크기 상한"; } catch { return "results 직렬화 불가"; }
      for (let k9 = 0; k9 < rs9.items.length; k9++) { const se = itemShapeError(rs9.items[k9]); if (se) return "results.items[" + k9 + "] " + se; }
    }
    if (a.resolutions !== undefined) {
      if (!Array.isArray(a.resolutions)) return "resolutions";
      for (const r9 of a.resolutions) {
        if (!r9 || typeof r9 !== "object" || Array.isArray(r9)) return "resolution 레코드";
        { const u = unknownKey(r9, ["patchId", "opHash", "baseDecisionContextHash", "verdict", "claims"]); if (u) return "resolution 미지 필드:" + u; }
        if (!UUID_RE.test(String(r9.patchId)) || !FP_RE.test(String(r9.opHash)) || !FP_RE.test(String(r9.baseDecisionContextHash)) || !["support", "reject", "inconclusive"].includes(r9.verdict) || !Array.isArray(r9.claims)) return "resolution 레코드";
        if (r9.verdict === "support" && (r9.claims.length < 1 || !r9.claims.some((c) => c && c.stance === "support"))) return "resolution 모순(support는 지지 claim>=1 — P2 적용기 동형·reject/inconclusive는 빈 claims 허용[적용 입력이 아님])";
        for (const c9 of r9.claims) { // 2차: claims 내용 strict — null·미지 필드 승인 차단
          if (!c9 || typeof c9 !== "object" || Array.isArray(c9)) return "resolution claim";
          { const u = unknownKey(c9, ["file", "contentHash", "locator", "stance"]); if (u) return "claim 미지 필드:" + u; }
          if (typeof c9.file !== "string" || !c9.file || !FP_RE.test(String(c9.contentHash)) || typeof c9.locator !== "string" || !c9.locator || !["support", "rebut"].includes(c9.stance)) return "resolution claim";
        }
      }
    }
    if (a.cursor !== undefined) {
      const c = a.cursor;
      if (!c || typeof c !== "object" || Array.isArray(c)) return "cursor";
      { const u = unknownKey(c, CURSOR_KEYS); if (u) return "cursor 미지 필드:" + u; }
      if (!Number.isInteger(c.nextIndex) || c.nextIndex < 0 || !Number.isInteger(c.rev) || c.rev < 0 || !Array.isArray(c.appliedPatchIds)) return "cursor";
      if (!c.appliedPatchIds.every((x) => UUID_RE.test(String(x)))) return "cursor.appliedPatchIds(UUID)";
      if (new Set(c.appliedPatchIds).size !== c.appliedPatchIds.length) return "cursor.appliedPatchIds(중복)"; // 2차: 중복=이중 적용 흔적 오염
      if (a.results === undefined) return "cursor↔results(적용 진행은 수신 결과 위에서만 — 3차)"; // results 부재+cursor=오재개 재료
      if (c.nextIndex > a.results.items.length) return "cursor.nextIndex 범위(results 결속)"; // 2차: item 수 초과=오재개
      // 4차 f-b74df6a1: cursor 전이 불변식(정본 ⓐⓑ 원자 전이의 관측 가능 상태만 승인 — 불가능 재개 상태 차단)
      if (c.appliedPatchIds.length !== c.nextIndex) return "cursor 불변식(appliedPatchIds 수==nextIndex — ⓑ 원자 전이)";
      if (c.rev > 0 && c.currentPatch === undefined && c.super === undefined) return "cursor 불변식(rev>0인데 재제안 흔적 없음)";
      if (c.nextIndex === a.results.items.length && (c.rev !== 0 || c.currentPatch !== undefined || c.super !== undefined)) return "cursor 불변식(전 item 완료인데 진행 흔적 잔존)";
      if (c.super !== undefined && c.super.toRev !== c.rev + 1) return "cursor 불변식(super.toRev==rev+1)";
      if (c.currentPatch !== undefined) {
        const cp = c.currentPatch;
        const pv = (() => { try { return require(path.join(__dirname, "project-map.js")).validatePatchV2(cp); } catch { return ["판독 불가"]; } })();
        if (pv.length) return "cursor.currentPatch(" + pv[0] + ")";
        // 5차 f-b74df6a1: currentPatch를 job·attempt·item·rev에 결속 — 유효하기만 한 '다른' patch를 재개
        // 정본으로 승인하는 경로 차단(정본: currentPatch=해당 item의 결정론 변환 전문).
        if (cp.mapId !== d.mapId) return "currentPatch.mapId 결속";
        if (cp.patchId !== detPatchId(d.jobKey, a.attemptId, c.nextIndex, c.rev)) return "currentPatch.patchId 결속(jobKey·attemptId·nextIndex·rev)";
        if (cp.provider !== a.provider) return "currentPatch.provider 결속";
        const it9 = a.results.items[c.nextIndex];
        if (!it9 || cp.operation !== it9.op) return "currentPatch.operation↔item 결속";
        if ((it9.targetId !== undefined || cp.targetId !== undefined) && cp.targetId !== it9.targetId) return "currentPatch.targetId↔item 결속";
        try { if (JSON.stringify(cp.payload) !== JSON.stringify(it9.payload)) return "currentPatch.payload↔item 결속"; } catch { return "currentPatch.payload 직렬화"; }
        // 6차(ab-3): {kind, ref} 전문 일치 — ref만 대조하면 doc 근거가 code kind로 세탁돼 P2 관문(코드 근거
        // 최소 1개 — kind 기준 판정 실측)을 통과한다. 기대 전문=변환기 규칙 그대로(evidenceKindOf).
        const wantEv = [...new Set([...(it9.evidence || []).map((e) => e.file), ...((it9.claims || []).map((x) => x.file))])].sort().map((f9) => evidenceKindOf(f9) + ":" + f9).join("|");
        const haveEv = [...new Set((cp.evidence || []).map((e) => String(e.kind) + ":" + String(e.ref)))].sort().join("|");
        if (wantEv !== haveEv) return "currentPatch.evidence↔item 결속({kind,ref} 전문 — kind 세탁 차단)";
      }
      if (c.super !== undefined) {
        const sp = c.super;
        if (!sp || typeof sp !== "object" || Array.isArray(sp)) return "cursor.super";
        { const u = unknownKey(sp, SUPER_KEYS); if (u) return "super 미지 필드:" + u; }
        if (!UUID_RE.test(String(sp.fromPatchId)) || !FP_RE.test(String(sp.fromOpHash)) || !Number.isInteger(sp.toRev) || !["marked", "expired"].includes(sp.phase)) return "cursor.super";
      }
    }
  }
  return null;
}
function readEnrichJob(repo) {
  const r = readJson3(jobFileFor(repo));
  if (r.st === "absent") return { st: "absent" };
  if (r.st !== "ok") return { st: "damaged" }; // 손상=fail-closed(자동 실행 전면 정지+표면화·수동 복구만)
  const ve = validateJob(r.data);
  return ve ? { st: "damaged", detail: ve } : { st: "ok", job: r.data };
}
function withJobLock(repo, fn) {
  try { fs.mkdirSync(ENRICH_DIR, { recursive: true }); } catch { /* 잠금이 실패 판정 */ }
  return CL.withFileLockStrict(jobFileFor(repo) + ".lock", fn);
}
// RMW — mut(job|null)→job'(strict 재검증 후 기록·이형 산출=거부)
function updateEnrichJob(repo, mut) {
  const w = withJobLock(repo, () => {
    const cur = readEnrichJob(repo);
    if (cur.st === "damaged") return { ok: false, reason: "job-damaged" };
    const next = mut(cur.st === "ok" ? cur.job : null);
    if (next === null) return { ok: true, unchanged: true };
    const ve = validateJob(next);
    if (ve) return { ok: false, reason: "job-invalid:" + ve }; // 자기 산출도 strict(오염 기록 차단)
    return CL.atomicWrite(jobFileFor(repo), JSON.stringify(next, null, 1)) ? { ok: true, job: next } : { ok: false, reason: "write-failed" };
  });
  if (!w.ok) return { ok: false, reason: "lock" };
  return w.result;
}
function jobKeyOf(mapId, authorityHash, decisionContextHash) {
  return sha1(String(mapId) + "|" + String(authorityHash) + (decisionContextHash ? "|" + decisionContextHash : ""));
}

// ── 결정론 patchId(설계 3·6차 — RFC 4122 name-based·rev 세대 포함·재계산 동일·rebase 불변) ──
function detPatchId(jobKey, attemptId, index, rev) {
  const h = crypto.createHash("sha1").update(jobKey + ":" + attemptId + ":" + index + ":" + rev).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5(name-based)
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const x = b.toString("hex");
  return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
}

// ── enrich-result-v1 validator(P8-3 — op별 합타입·strict·크기 상한) ─────────────────
const ENRICH_TARGET_OPS = ["add_evidence", "set_state", "add_anchor"];
const RESULT_MAX_ITEMS = 200;
const RESULT_MAX_CHARS = 400000;
// 반환 {ok, items} / {ok:false, kind:"schema"|"id", errors:[...]} — 근거(evidence 실존) 검사는 실행기(파일계 접근)가 수행.
function validateEnrichResult(obj, topo) {
  const errs = [];
  const ids = new Set([...((topo && topo.nodes) || []).map((n) => n && n.id), ...((topo && topo.edges) || []).map((e) => e && e.id)]);
  const nodeIds = new Set([...((topo && topo.nodes) || []).map((n) => n && n.id)]);
  try { if (JSON.stringify(obj).length > RESULT_MAX_CHARS) return { ok: false, kind: "schema", errors: ["크기 상한 초과"] }; } catch { return { ok: false, kind: "schema", errors: ["직렬화 불가"] }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj.schema !== "enrich-result-v1" || !Array.isArray(obj.items)) return { ok: false, kind: "schema", errors: ["enrich-result-v1 형식 위반"] };
  { const u = Object.keys(obj).find((k) => !["schema", "items"].includes(k)); if (u) return { ok: false, kind: "schema", errors: ["root 미지 필드(" + u + ")"] }; } // 2차: root strict
  if (obj.items.length === 0 || obj.items.length > RESULT_MAX_ITEMS) return { ok: false, kind: "schema", errors: ["items 수 위반(1~" + RESULT_MAX_ITEMS + ")"] };
  // 4차 보완: 형태 규칙은 itemShapeError '단일 경로'(장부 판독과 공용 — 규칙 이탈 차단). 여기서는 형태 통과
  // 후 ID 실존 검사만 추가한다.
  let idErr = false;
  obj.items.forEach((it, i) => {
    const tag = "items[" + i + "]";
    const se = itemShapeError(it);
    if (se) { errs.push(tag + " " + se); return; }
    if (ENRICH_TARGET_OPS.includes(it.op) || it.op === "rewrite_label") {
      if (!ids.has(it.targetId)) { errs.push(tag + " targetId 미실존(" + it.targetId + ")"); idErr = true; return; }
    }
    if (it.op === "add_edge") {
      const e9 = it.payload.edge;
      if (!nodeIds.has(e9.from)) { errs.push(tag + " edge.from 미실존"); idErr = true; return; }
      if (!nodeIds.has(e9.to)) { errs.push(tag + " edge.to 미실존"); idErr = true; return; }
    }
  });
  if (errs.length) return { ok: false, kind: idErr && errs.every((e) => /미실존|실존 필수/.test(e)) ? "id" : "schema", errors: errs };
  return { ok: true, items: obj.items };
}

// ── toPatchV2 결정론 변환기(P8-3 — 2차 f-71d38d62·5차 순차 변환: '직전 적용 완료 상태' ctx로 호출) ──
// ctx={repo, topo(현재), idx, pol, fileHashOf, jobKey, attemptId, rev, provider}. 반환 {ok, patch} /
// {ok:false, kind, errors}. evidence→P2 evidence(kind code)·claims 파일도 evidence에 사전 결속(P8-4 —
// 해소 근거가 opHash·evidenceFps에 실려 적용 후 근거 변경=기존 freshness 경로 stale).
// evidence kind 결정론 분류(3a 검증 1차 blocker③ ab-3 — 전부 code로 강제하면 문서 단독 근거가 P2의
// 'code/test/config 최소 1개' 관문[자기확인 고리 차단]을 세탁 통과한다): 경로·확장자 기반 — doc/config/
// test/code. P2 관문 판정은 P2가 그대로 수행(doc 단독이면 P2가 거부 — 여기서 관문을 흉내내지 않는다).
function evidenceKindOf(file) {
  const f = String(file).replace(/\\/g, "/").toLowerCase();
  // 2차(ab-3): 판정 순서=확장자 우선(문서는 test 경로에 있어도 문서)·미지·무확장=doc(보수 기본값 —
  // code는 알려진 소스 확장자 화이트리스트만: LICENSE·README류가 code로 세탁돼 P2 관문을 통과하는 경로 차단).
  if (/\.(md|markdown|txt|rst|adoc)$/.test(f)) return "doc";
  if (/\.(json|ya?ml|toml|ini|env|cfg|conf|properties)$/.test(f) || /(^|\/)\.[a-z]+rc$/.test(f)) return "config";
  const codeExt = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|php|sh|bash|ps1|psm1|bat|cmd|sql|vue|svelte|scala|ex|exs|erl|lua|pl|r|m|mm|css|scss|less|html|htm)$/.test(f);
  if (!codeExt) return "doc"; // 무확장(LICENSE·README)·미지 확장자=doc(코드로 세탁 금지)
  if (/(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f)) return "test";
  return "code";
}
function toPatchV2(item, index, ctx) {
  const PM = require(path.join(__dirname, "project-map.js"));
  const MP = require(path.join(__dirname, "map-pipeline.js"));
  const { ah } = MP.authorityOf(PM.mapHashOf(ctx.topo), ctx.idx);
  const evFiles = [...new Set([...(item.evidence || []).map((e) => e.file), ...((item.claims || []).map((c) => c.file))])].sort();
  const base = {
    schema: "map-patch-v2", patchId: detPatchId(ctx.jobKey, ctx.attemptId, index, ctx.rev), mapId: ctx.topo.mapId,
    basis: MP.patchBasisFor(ctx.repo, ctx.topo), baseMapHash: PM.mapHashOf(ctx.topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, ctx.pol.pfh),
    baseDirtyFp: "", operation: item.op, payload: item.payload, readSet: {},
    rationale: "P8 의미 보강(" + ctx.provider + ")", evidence: evFiles.map((f) => ({ kind: evidenceKindOf(f), ref: f })),
    provider: ctx.provider, // 충돌 감지 원천(P8-4 — decision에 patch 전문 영속=조회 가능)
    ...(ENRICH_TARGET_OPS.includes(item.op) || item.op === "rewrite_label" ? { targetId: item.targetId } : {}),
  };
  base.readSet = MP.buildReadSetFor(ctx.topo, base, { idx: ctx.idx, pol: ctx.pol, repoRoot: ctx.repo, fileHashOf: ctx.fileHashOf });
  const PMv = require(path.join(__dirname, "project-map.js")).validatePatchV2(base);
  if (PMv.length) return { ok: false, kind: "schema", errors: PMv };
  return { ok: true, patch: base };
}

// ── 라우팅 로그(P8-5 — append-only·기록 실패=비차단) ─────────────────────────────
const ROUTE_LOG = path.join(BRIDGE_DIR, "stats", "map-route.jsonl");
const ROUTE_LOG_DAYS = 60;
function appendRouteLog(entry) {
  try {
    fs.mkdirSync(path.dirname(ROUTE_LOG), { recursive: true });
    // P8-5 고정 필드(3b 1차 보완): 부재 필드는 null로 상시 채움 — 감사 행 형태 균일
    const fixed = { ts: null, repoKey: null, mapId: null, mode: null, configWs: null, slot: null, consentGen: null, readinessFp: null, corridor: null, changedCount: null, route: null, reason: null, escalated: null, outcome: null, provider: null, jobKey: null, trigger: null };
    fs.appendFileSync(ROUTE_LOG, JSON.stringify({ ...fixed, ...entry }) + "\n");
    // 기간 기반 trim(60일 — 행 수 조건 없음: 저빈도 파일이라 매 기록 시 날짜 필터해도 무해)
    const cut = Date.now() - ROUTE_LOG_DAYS * 86400000;
    const lines = fs.readFileSync(ROUTE_LOG, "utf8").split("\n").filter(Boolean);
    const kept = lines.filter((l) => { try { return new Date(JSON.parse(l).ts).getTime() >= cut; } catch { return false; } });
    if (kept.length < lines.length) CL.atomicWrite(ROUTE_LOG, kept.join("\n") + "\n");
  } catch (e) { try { process.stderr.write("[map-route] 로그 기록 실패(비차단): " + String(e && e.message) + "\n"); } catch { /* 무해 */ } }
}

// ── historyless 변경 산출(P8-1 — 큐 v1 invSnap 대조) ─────────────────────────────
// 반환 string[](변경 상대경로)|null(산출 불가=corridor unknown). 규칙: 삭제=변경/신규=변경/메타 상이=변경
// (지문 생략 빠른 경로)/메타 동일=내용 sha1 대조(동일 메타 교체 검출).
function historylessChanges(repo, invSnap, MR) {
  if (!invSnap || !Array.isArray(invSnap.files)) return null; // 부재·상한 초과=unknown(정직)
  let now;
  try { now = MR.collectInventory(repo); } catch { return null; }
  if (!now || !Array.isArray(now.files)) return null;
  const changed = new Set();
  const snapBy = new Map(invSnap.files.map((f) => [f.path, f]));
  const nowSet = new Set(now.files.map((f) => f.rel));
  for (const f of invSnap.files) if (!nowSet.has(f.path)) changed.add(f.path); // 삭제=변경
  for (const f of now.files) {
    const sp = snapBy.get(f.rel);
    if (!sp) { changed.add(f.rel); continue; } // 신규=변경
    let st9 = null;
    try { st9 = fs.statSync(path.join(repo, f.rel)); } catch { changed.add(f.rel); continue; }
    if (sp.fp === null || st9.mtimeMs !== sp.mtimeMs || st9.size !== sp.size) {
      if (st9.mtimeMs !== sp.mtimeMs || st9.size !== sp.size) { changed.add(f.rel); continue; }
      changed.add(f.rel); continue; // fp null=검증 불가=변경 취급
    }
    // 메타 동일 — 내용 지문 대조(동일 메타 교체 위장 봉합)
    let fp9 = null;
    try { fp9 = crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, f.rel))).digest("hex"); } catch { changed.add(f.rel); continue; }
    if (fp9 !== sp.fp) changed.add(f.rel);
  }
  return [...changed].sort();
}

// ── 실행기 본체(P8-2 생명주기 ①~⑧·복구 상태표 — 3b) ────────────────────────────
// 주입 계약(테스트·배선 공용): opts={ws, slot, mode(실효 mapMode — 호출자가 mapModeView로 산출),
// readiness({selfReady,economyReady,precisionReady,autoReady} — 호출자가 P7 뷰로 산출),
// adapters:{self?,economy?,precision?}((ctx{repo,topo,changed})=>({ok:true,result}|{ok:false,detail})),
// askVerifier?((req{patch,claims,framing})=>해소 레코드|null — 1-4 별도 진입점·null=no-verifier),
// trigger(로그용), _testHooks?}. 반환 {outcome, reason?, jobKey?, applied?, parked?}.
// 이 함수는 LLM을 직접 호출하지 않는다 — adapters·askVerifier 주입이 유일한 외부 경로(무주입=park).
function runEnrich(repo, opts) {
  const o = opts || {};
  const MR = require(path.join(__dirname, "map-runtime.js"));
  const MP = require(path.join(__dirname, "map-pipeline.js"));
  const PM = require(path.join(__dirname, "project-map.js"));
  const MB = require(path.join(__dirname, "map-bootstrap.js"));
  const MRt = require(path.join(__dirname, "map-router.js"));
  const rKey = repoKeyFor(repo);
  const logBase = { repoKey: rKey, mode: o.mode, configWs: o.ws || "", slot: o.slot || "", trigger: o.trigger || "", readinessFp: (() => { try { return sha1(JSON.stringify(o.readiness || null)); } catch { return null; } })() };
  const log = (e) => appendRouteLog({ ts: new Date().toISOString(), ...logBase, ...e });
  const park = (jobMut, reason, extra) => {
    if (jobMut) updateEnrichJob(repo, jobMut);
    log({ route: "park", reason, outcome: "parked", ...(extra || {}) });
    return { outcome: "parked", reason };
  };
  // ⓪ 게이트 최선행: 3트랙 OFF=완전 무동작(파일 생성·로그 0)
  let scoutOn = false;
  try { scoutOn = CL.normScoutMode(CL.loadContract(o.ws)) === "on"; } catch { scoutOn = false; }
  if (!scoutOn) return { outcome: "noop", reason: "two-track" };
  // ① 큐 판독(읽기 전용 — 쓰기 주체=bootstrap)
  const q3 = readJson3(MB.queueFileFor(repo));
  if (q3.st === "absent") return { outcome: "noop", reason: "no-queue" };
  if (q3.st !== "ok" || !["enrich-queue-v0", "enrich-queue-v1"].includes(q3.data.schema) || typeof q3.data.mapId !== "string") return park(null, "queue-damaged");
  const queue = q3.data;
  logBase.mapId = queue.mapId;
  // ② 실행 잠금(repo당 동시 1 — bootstrap funlock 문법)
  try { fs.mkdirSync(ENRICH_DIR, { recursive: true }); } catch { /* 잠금이 실패 판정 */ }
  const runLock = path.join(ENRICH_DIR, rKey + ".run.funlock");
  const tok = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(runLock, JSON.stringify({ pid: process.pid, token: tok }), { flag: "wx" }); }
  catch {
    // 사망 회수(3b 1차 강등분 d2deff57384881b8 즉시 수정 — 두 창이 같은 dead lock을 읽고 한쪽이 새로 취득한
    // 뒤 다른 쪽이 그 새 잠금을 삭제하는 경합): unlink가 아니라 '고유 격리명으로의 원자 rename' — 이동에
    // 성공한 단일 복구자만 재취득하고, 이동해 온 파일이 자기가 판독한 그 잔재(pid·token 동일)인지 재검증.
    // 오탈취(그새 교체된 잠금)면 복원. bootstrap 잔재 회수 문법 동형.
    const held = readJson3(runLock);
    if (!(held.st === "ok" && Number.isInteger(held.data.pid) && typeof held.data.token === "string")) return { outcome: "busy", reason: "run-lock-damaged" }; // 손상=수동 소관(판정 없는 삭제 금지)
    let dead = false;
    try { process.kill(held.data.pid, 0); } catch (e) { dead = !!(e && e.code === "ESRCH"); }
    if (!dead) return { outcome: "busy", reason: "run-lock" };
    const grave = runLock + ".reclaim." + process.pid + "." + tok;
    try { fs.renameSync(runLock, grave); } catch { return { outcome: "busy", reason: "run-lock" }; } // 이동 실패=타 복구자 선점
    const moved = readJson3(grave);
    if (!(moved.st === "ok" && moved.data.pid === held.data.pid && moved.data.token === held.data.token)) {
      try { fs.renameSync(grave, runLock); } catch { /* 복원 실패=격리 잔존(감사 흔적) */ }
      return { outcome: "busy", reason: "run-lock" }; // 오탈취(교체된 잠금) — 복원 후 물러남
    }
    try { fs.unlinkSync(grave); } catch { /* 격리 잔존 무해 */ }
    try { fs.writeFileSync(runLock, JSON.stringify({ pid: process.pid, token: tok }), { flag: "wx" }); } catch { return { outcome: "busy", reason: "run-lock" }; }
    const rb = readJson3(runLock); // read-back fence
    if (!(rb.st === "ok" && rb.data.token === tok && rb.data.pid === process.pid)) return { outcome: "busy", reason: "run-lock" };
  }
  try {
    return runEnrichLocked(repo, o, { MR, MP, PM, MB, MRt, queue, log, park });
  } finally {
    try { const h = readJson3(runLock); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(runLock); } catch { /* 무해 */ }
  }
}

function runEnrichLocked(repo, o, env) {
  const { MR, MP, PM, MB, MRt, queue, log, park } = env;
  // ③ pipelineBarrier·topology 재대조(잠금 안 캡처만 — 판정·해시는 밖)
  const bar = MR.pipelineBarrier(repo);
  if (bar.blocked) return park(null, "pipeline-wal");
  const lk = MR.withMapLock(repo, () => {
    try { return { raw: fs.readFileSync(path.join(repo, "project-map", "topology.json"), "utf8") }; }
    catch (e) { return { err: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
  });
  if (!lk.ok) return park(null, "map-lock");
  if (lk.result.err) return park(null, "topology-" + lk.result.err);
  let topo;
  try { topo = JSON.parse(lk.result.raw); } catch { return park(null, "topology-invalid"); }
  if (PM.validateTopology(topo).length) return park(null, "topology-invalid");
  if (topo.mapId !== queue.mapId || PM.mapHashOf(topo) !== queue.mapHash) return { outcome: "noop", reason: "queue-stale" }; // 큐 재작성=bootstrap 소관
  // ④ 장부 판독(strict — damaged=전면 정지)
  const jr = readEnrichJob(repo);
  if (jr.st === "damaged") return park(null, "job-damaged", { detail: jr.detail || "" });
  // ⑤ jobKey(시작 시점 동결값 산출)
  const idx = MP.decisionIndexFor(repo, topo.mapId);
  if (idx.st === "error") return park(null, "decision-index");
  const pol = MP.policyStateFor(repo, topo.mapId);
  if (pol.st !== "ok") return park(null, "policy-frontier");
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const jobKey = jobKeyOf(topo.mapId, ah, null); // v1 보강은 정책 비참조(dch 미포함 — 설계 jobKey 규칙)
  // ⑥ 멱등·복구 우선(수렴은 변경 산출 뒤 ⑦b에서 — 3b 1차 blocker⑤: authority 결속은 authority 불변인
  // 실제 소스 변경까지 영구 억제하므로 폐기·소스 상태 지문으로 재설계)
  if (jr.st === "ok") {
    const j = jr.job;
    if (j.phase === "done" && j.jobKey === jobKey) return { outcome: "noop", reason: "already-enriched" }; // 같은 세대=진짜 멱등
    if (j.phase === "open") return resumeJob(repo, o, env, j, { topo, idx, pol, ah }); // 미완 복구가 신규보다 항상 우선
    if (j.jobKey === jobKey && j.phase === "parked") return { outcome: "noop", reason: "parked", parkedReason: j.parkedReason || "" }; // 재시도=명시 버튼(새 attempt)이 해제
  }
  // ⑦ 동의·라우팅
  const consent = readEnrichConsent(repo);
  if (consent.st !== "ok") return park(null, "consent-damaged");
  const grant = findGrant(consent, o.ws, o.slot);
  const mode = o.mode;
  if (!["self", "economy", "precision", "auto"].includes(mode)) return park(null, "invalid-mode");
  if (mode === "self" ? !(grant && grant.selfAuto) : !(grant && grant.paidMode === mode)) return park(null, grant ? "consent-stale" : "no-consent");
  // 변경 산출 → corridor
  let changed = null;
  const gx = MR.PM ? null : null; // (자리 표기 없음 — git 경로는 map-reader gitChangedEx)
  try {
    const MRd = require(path.join(__dirname, "map-reader.js"));
    const g9 = MRd.gitChangedEx(repo, queue.basis);
    if (g9 && g9.ok) changed = g9.files || [];
    else if (queue.basis && queue.basis.kind === "historyless") changed = historylessChanges(repo, queue.invSnap, MR);
  } catch { changed = queue.basis && queue.basis.kind === "historyless" ? historylessChanges(repo, queue.invSnap, MR) : null; }
  const proj = { ok: true, source: "v2", nodes: topo.nodes || [] }; // corridor 판정 입력(node 소속만 사용 — 같은 캡처 세트)
  const corridor = MRt.corridorOf(proj, changed);
  // ⑦b 수렴(blocker⑤ 재설계): done job의 sourceFp(소비한 소스 상태 지문)와 현재 지문이 같으면 외부 변경 0=
  // 자기 산물 noop. 소스가 바뀌면(파일 내용·집합) 지문이 달라져 재보강 — authority 무관(입력 결속).
  const srcFp = computeSourceFp(repo, queue, changed, MR);
  if (jr.st === "ok" && jr.job.phase === "done" && srcFp !== null && jr.job.sourceFp === srcFp) return { outcome: "noop", reason: "already-enriched" };
  // ⑧ 신규 job 생성+attempt 루프(라우터 재호출·승격 1회)
  const nowIso = () => new Date().toISOString();
  const mk = updateEnrichJob(repo, (cur) => {
    if (cur && cur.phase === "open") return null; // 경합 — resume 소관(무변경)
    return { schema: "enrich-job-v2", jobKey, mapId: topo.mapId, authorityHash: ah, decisionContextHash: null, mode, configWs: CL.normWs(o.ws || ""), slot: o.slot === "en" ? "en" : "ko", phase: "open", startedAt: nowIso(), attempts: [] };
  });
  if (!mk.ok) return park(null, "job-write:" + mk.reason);
  return driveAttempts(repo, o, env, { topo, idx, pol, ah, jobKey, corridor, changed, srcFp, grant, consent });
}

// 소스 상태 지문(blocker⑤ — 수렴 입력): git=head+변경 파일 현재 내용 sha1 / historyless=inventory 전체
// {path, 내용 sha1}. 산출 불가=null(수렴 판정 생략 — 보수: noop이 아니라 재실행 허용 쪽).
function computeSourceFp(repo, queue, changed, MR) {
  try {
    if (queue.basis && queue.basis.kind === "git") {
      const { spawnSync } = require("child_process");
      const g = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const head = g.status === 0 ? String(g.stdout || "").trim() : null;
      if (!head || !Array.isArray(changed)) return null;
      const parts = changed.map((f) => { try { return f + ":" + crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, f))).digest("hex"); } catch { return f + ":gone"; } });
      return sha1("git|" + head + "|" + parts.join(","));
    }
    const inv = MR.collectInventory(repo);
    if (!inv || !Array.isArray(inv.files)) return null;
    const parts = inv.files.map((f) => { try { return f.rel + ":" + crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, f.rel))).digest("hex"); } catch { return f.rel + ":unreadable"; } }).sort();
    return sha1("hist|" + parts.join(","));
  } catch { return null; }
}

// attempt 루프 — decideRoute 재호출(실패 플래그 관측 후)·승격은 표가 결정(라우터 7행=정확 1회)
function driveAttempts(repo, o, env, st) {
  const { MRt, log, park } = env;
  let economyFailed = false, precisionFailed = false;
  for (let guard = 0; guard < 3; guard++) { // 최대: 최초 route+승격 1회(+both-failed 종결) — 라우터 표가 상한
    const d = MRt.decideRoute({ mode: o.mode, ready: o.readiness, corridor: st.corridor, economyFailed, precisionFailed, conflict: false });
    log({ route: d.route, reason: d.reason, corridor: st.corridor, changedCount: Array.isArray(st.changed) ? st.changed.length : null, jobKey: st.jobKey, escalated: economyFailed && d.route === "precision" });
    if (d.route === "park") return park((j) => j && { ...j, phase: "parked", parkedReason: d.reason, finishedAt: new Date().toISOString() }, d.reason, { jobKey: st.jobKey });
    if (d.route === "adjudicate") return park((j) => j && { ...j, phase: "parked", parkedReason: "adjudicate-unreachable", finishedAt: new Date().toISOString() }, "adjudicate-unreachable", { jobKey: st.jobKey }); // 신규 경로에서 conflict=false — 도달 불가 방어
    const provider = d.route;
    const at = runAttempt(repo, o, env, st, provider);
    if (at.outcome === "applied" || at.outcome === "parked" || at.outcome === "noop") return at;
    if (at.outcome === "provider-failed") { if (provider === "economy") economyFailed = true; else if (provider === "precision") precisionFailed = true; else return park(null, "self-failed", { jobKey: st.jobKey }); continue; }
    return at;
  }
  return park((j) => j && { ...j, phase: "parked", parkedReason: "route-loop-guard", finishedAt: new Date().toISOString() }, "route-loop-guard");
}

function runAttempt(repo, o, env, st, provider) {
  const { log, park } = env;
  const nowIso = () => new Date().toISOString();
  // 동의 재대조(유료 호출 '직전' — 철회 TOCTOU. self는 selfAuto 재확인)
  const c2 = readEnrichConsent(repo);
  const g2 = findGrant(c2, o.ws, o.slot);
  const consentOk = provider === "self" ? !!(g2 && g2.selfAuto) : !!(g2 && g2.paidMode === o.mode);
  if (c2.st !== "ok" || !consentOk) return park((j) => j && { ...j, phase: "parked", parkedReason: "consent-stale", finishedAt: nowIso() }, "consent-stale", { provider, jobKey: st.jobKey });
  const adapter = (o.adapters || {})[provider];
  if (typeof adapter !== "function") return park((j) => j && { ...j, phase: "parked", parkedReason: "adapter-missing:" + provider, finishedAt: nowIso() }, "adapter-missing", { provider, jobKey: st.jobKey });
  // attempt 생성(phase running — 호출 '전' 기록: uncertain-call 감사 재료)
  let attemptId = -1;
  const mk = updateEnrichJob(repo, (j) => {
    if (!j || j.phase !== "open") return null;
    attemptId = j.attempts.length;
    return { ...j, attempts: [...j.attempts, { attemptId, provider, consentGen: g2.gen, phase: "running", startedAt: nowIso() }] };
  });
  if (!mk.ok || attemptId < 0) return park(null, "attempt-write");
  // provider 호출(주입 어댑터 — 실 LLM 배선은 3b-2)
  let call;
  try { call = adapter({ repo, topo: st.topo, changed: st.changed, provider }); }
  catch (e) { call = { ok: false, detail: "adapter-threw: " + String(e && e.message) }; }
  if (!call || call.ok !== true) {
    updateEnrichJob(repo, (j) => j && { ...j, attempts: j.attempts.map((a) => a.attemptId === attemptId ? { ...a, phase: "failed", failReason: String((call && call.detail) || "adapter-failed").slice(0, 200), finishedAt: nowIso() } : a) });
    log({ route: provider, reason: "provider-call-failed", outcome: "error", provider, jobKey: st.jobKey });
    return { outcome: "provider-failed", provider };
  }
  // results 검증(strict — 실패 분류 3종은 provider 실패 플래그)+근거 실증(3b 1차 blocker④ ab-3:
  // quote가 실제 파일 내용에 존재하는지 대조 — 허위 인용으로 생성된 의미 변경이 P2 관문을 통과하는 경로 차단)
  let vr = validateEnrichResult(call.result, st.topo);
  if (vr.ok) {
    for (const it of call.result.items) {
      const cites = [...(it.evidence || []), ...((it.claims || []).map((c) => ({ file: c.file, quote: c.quote })))];
      for (const cv of cites) {
        let body = null;
        try { body = fs.readFileSync(path.join(repo, cv.file), "utf8"); } catch { body = null; }
        if (body === null || !body.includes(cv.quote)) { vr = { ok: false, kind: "evidence", errors: ["근거 실패: " + cv.file + " 인용 불일치/판독 불가"] }; break; }
      }
      if (!vr.ok) break;
    }
  }
  if (!vr.ok) {
    updateEnrichJob(repo, (j) => j && { ...j, attempts: j.attempts.map((a) => a.attemptId === attemptId ? { ...a, phase: "failed", failReason: (vr.kind + ": " + (vr.errors[0] || "")).slice(0, 200), finishedAt: nowIso() } : a) });
    log({ route: provider, reason: "result-" + vr.kind, outcome: "error", provider, jobKey: st.jobKey });
    return { outcome: "provider-failed", provider };
  }
  // results 영속(수신 즉시 — 이후 재개는 provider 재호출 0)
  const wR = updateEnrichJob(repo, (j) => j && { ...j, attempts: j.attempts.map((a) => a.attemptId === attemptId ? { ...a, phase: "applying", results: call.result, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [] } } : a) });
  if (!wR.ok) return park(null, "results-write:" + wR.reason, { provider, jobKey: st.jobKey });
  return applyItems(repo, o, env, st, attemptId);
}

// item별 순차 변환·적용(cursor 전이 ⓐⓑ — 설계 v10)·verifier-resolved=해소 경로·완료=job done
function applyItems(repo, o, env, st, attemptId) {
  const { MP, PM, log, park } = env;
  const nowIso = () => new Date().toISOString();
  const sha1f = (ref) => { try { return crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, ref))).digest("hex"); } catch { return null; } };
  let retries = 0;
  for (;;) {
    const jr = readEnrichJob(repo);
    if (jr.st !== "ok") return park(null, "job-damaged-mid");
    const j = jr.job;
    const a = j.attempts.find((x) => x.attemptId === attemptId);
    if (!a || a.phase !== "applying" || !a.results || !a.cursor) return park(null, "attempt-state");
    const items = a.results.items;
    if (a.cursor.nextIndex >= items.length) { // 전 item 완료 → attempt done·job done(+수렴용 sourceFp)
      let srcFp = st && st.srcFp ? st.srcFp : null;
      if (!srcFp) { try { srcFp = computeSourceFp(repo, env.queue, null, require(path.join(__dirname, "map-runtime.js"))); } catch { srcFp = null; } } // 재개 경로=재계산(null=수렴 생략·재실행 허용 쪽 보수)
      const wD = updateEnrichJob(repo, (jj) => jj && { ...jj, phase: "done", finishedAt: nowIso(), ...(srcFp ? { sourceFp: srcFp } : {}), attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, phase: "done", finishedAt: nowIso(), cursor: { ...x.cursor, rev: 0 } } : x) });
      if (!wD.ok) return park(null, "done-write:" + wD.reason);
      log({ route: a.provider, reason: "enriched", outcome: "applied", provider: a.provider, jobKey: j.jobKey, applied: a.cursor.appliedPatchIds.length });
      return { outcome: "applied", jobKey: j.jobKey, applied: a.cursor.appliedPatchIds.length };
    }
    const i = a.cursor.nextIndex;
    const item = items[i];
    // 현재 상태에서 변환(순차 — readSet 항상 신선)
    const topoNow = require(path.join(__dirname, "map-runtime.js")).readTopoExFor(repo);
    if (topoNow.st !== "ok") return park(null, "topology-" + topoNow.st);
    const idxNow = MP.decisionIndexFor(repo, topoNow.topo.mapId);
    const polNow = MP.policyStateFor(repo, topoNow.topo.mapId);
    if (idxNow.st === "error" || polNow.st !== "ok") return park(null, "state-read");
    const conv = toPatchV2(item, i, { repo, topo: topoNow.topo, idx: idxNow, pol: polNow, fileHashOf: sha1f, jobKey: j.jobKey, attemptId, rev: a.cursor.rev, provider: a.provider });
    if (!conv.ok) { // 변환 실패=item 수준 실패 — attempt 실패 처리(provider 실패 분류)
      updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, phase: "failed", failReason: ("convert-" + conv.kind + ": " + (conv.errors[0] || "")).slice(0, 200), finishedAt: nowIso() } : x) });
      return { outcome: "provider-failed", provider: a.provider };
    }
    const patch = conv.patch;
    // ⓐ 전이: currentPatch 기록(적용 직전)
    const wA = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { ...x.cursor, currentPatch: patch } } : x) });
    if (!wA.ok) return park(null, "cursor-write:" + wA.reason);
    const step = applyOnePatch(repo, o, env, { job: j, attempt: a, attemptId, item, patch, topoNow: topoNow.topo });
    if (step.done) {
      // ⓑ 전이: applied 추가+nextIndex+1+currentPatch 소거+rev=0(원자)
      const wB = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: [...x.cursor.appliedPatchIds, patch.patchId] } } : x) });
      if (!wB.ok) return park(null, "cursor-write:" + wB.reason);
      retries = 0;
      continue;
    }
    if (step.retry) { // 일시 실패(같은 rev·같은 patch 재시도) — cursor 불변·상한(3b 1차 blocker② — 무한 루프 차단)
      retries++;
      if (retries > 5) return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "retry-exhausted", finishedAt: nowIso() }, "retry-exhausted", { jobKey: j.jobKey });
      if (step.recoverFirst) { try { MP.recoverWal(repo, j.mapId); } catch { /* 복구 실패=다음 재시도가 판정 */ } } // wal-active=P2 복구 표면 선행
      continue;
    }
    retries = 0;
    if (step.revUp) { // cas-stale — rev 전진 규약(super 전이 ⓐⓑⓒ)
      const sup = { fromPatchId: patch.patchId, fromOpHash: PM.opHashOf(patch), toRev: a.cursor.rev + 1, phase: "marked" };
      const w1 = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { ...x.cursor, super: sup } } : x) });
      if (!w1.ok) return park(null, "cursor-write:" + w1.reason);
      const ex = MP.expirePendingPatch(repo, j.mapId, patch.patchId, sup.fromOpHash);
      if (ex.reason === "already-applied") { // 경합: 그새 적용 완료 — ⓑ 보충으로 종결(rev 전진 아님·3b 1차 blocker②)
        const wSup = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: [...x.cursor.appliedPatchIds, patch.patchId] } } : x) });
        if (!wSup.ok) return park(null, "cursor-write:" + wSup.reason);
        retries = 0; continue;
      }
      if (ex.reason === "busy") return park(null, "expire-busy"); // 타 주체 적용 중 — 표면화(자동 대기 금지)
      if (ex.reason === "lock") { retries++; if (retries > 5) return park(null, "retry-exhausted"); continue; } // 일시 잠금=재시도(super marked 상태 재개 안전)
      if (ex.ok === false && ex.reason === "conflict" && !/부재/.test(ex.error || "")) return park(null, "ledger-conflict");
      if (a.cursor.rev + 1 > 2) { // rev 상한 2회(cas-stale 반복 — v10 상태표 ⑦)
        return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "rev-exhausted", finishedAt: nowIso() }, "rev-exhausted", { jobKey: j.jobKey });
      }
      const w2 = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex, rev: x.cursor.rev + 1, appliedPatchIds: x.cursor.appliedPatchIds } } : x) });
      if (!w2.ok) return park(null, "cursor-write:" + w2.reason);
      continue;
    }
    // 영구 park(hard-reject·no-verifier·unknown-outcome 등)
    return park((jj) => jj && { ...jj, phase: "parked", parkedReason: step.parkReason || "apply-failed", finishedAt: nowIso() }, step.parkReason || "apply-failed", { jobKey: j.jobKey });
  }
}

// 격하 판정(설계 P8-4 결정론 열거 — 3b 1차 blocker① 충돌 감지 재료): set_state의 confidence 하향·lifecycle 강등
const CONF_RANK = { unknown: 0, candidate: 1, confirmed: 2 };
const LIFE_RANK = { tombstoned: 0, superseded: 1, deprecated: 2, active: 3 };
function isDemotion(item) {
  if (!item || item.op !== "set_state" || !item.payload) return false;
  const to = item.payload.to || {}, ex = item.payload.expect || {};
  if (to.confidence && ex.confidence && CONF_RANK[to.confidence] < CONF_RANK[ex.confidence]) return true;
  if (to.lifecycle && ex.lifecycle && LIFE_RANK[to.lifecycle] < LIFE_RANK[ex.lifecycle]) return true;
  return false;
}
// 대상 entity의 provenance provider 조회(P8-4 — decisionId 경유 strict): 반환 provider 문자열|null(귀속 부재·판독 실패)
function providerOfTarget(repo, topo, targetId) {
  try {
    const ent = [...(topo.nodes || []), ...(topo.edges || [])].find((x) => x && x.id === targetId);
    const did = ent && ent.provenance && ent.provenance.decisionId;
    if (!did) return null;
    const dec = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "decisions", did + ".json"), "utf8"));
    return (dec && dec.patch && typeof dec.patch.provider === "string") ? dec.patch.provider : null;
  } catch { return null; }
}
// 단일 patch 적용 — propose→classify→분류별 경로. 반환 {done}|{retry[,recoverFirst]}|{revUp}|{parkReason}.
// 3b 1차 blocker①③ 반영: 격하 제안은 auto 분류여도 verifier 해소 경로로 회부(타 provider 격하=충돌 프레이밍)·
// 해소 레코드는 attempt.resolutions에 영속(사망·일시 실패 재시도에서 Verifier 재호출 0)·reject expire 결과 확인.
function applyOnePatch(repo, o, env, ctx) {
  const { MP, log } = env;
  const { job, patch, item, attemptId } = ctx;
  const PMx = require(path.join(__dirname, "project-map.js"));
  const pr = MP.proposePatch(repo, patch);
  if (!pr.ok && pr.stage !== "conflict") return { parkReason: "propose-" + (pr.stage || "failed") };
  if (!pr.ok && pr.stage === "conflict") return { parkReason: "ledger-conflict" }; // 같은 ID 다른 내용=다른 주체(표면화)
  const cl = MP.classifyPatch(repo, job.mapId, patch.patchId);
  if (!cl.ok) return { retry: true }; // 판독·잠금성 실패=일시(상한은 호출자)
  if (cl.classification === "hard-reject") return { parkReason: "hard-reject" };
  if (cl.classification === "needs-investigation" || cl.classification === "intent-choice") return { done: true, pendingOnly: true }; // 제안 보존(P9 소관)=이 item 종결(P8은 생성만)
  // 충돌·해소 회부 판정(blocker①): 격하 제안은 자동 적용 금지 — 타 provider 격하=conflict 프레이밍(1-34 모드 무관)·
  // 같은 provider=자기 갱신도 의미 판단이라 해소 경로(설계: set_state 하향은 auto 분류여도 실행기가 회부)·귀속 부재=해소 회부.
  const demotion = isDemotion(item);
  let framing = "resolution";
  if (demotion) {
    const tp = providerOfTarget(repo, ctx.topoNow || {}, item.targetId);
    if (tp !== null && tp !== patch.provider) { framing = "conflict"; if (log) log({ route: "adjudicate", reason: "provider-conflict", outcome: "adjudicated", provider: patch.provider, jobKey: job.jobKey }); }
  }
  const needVerifier = cl.classification === "verifier-resolved" || demotion;
  let vrRes = null;
  if (needVerifier) {
    // 영속 해소 재사용(blocker③): 같은 patchId+opHash 레코드가 장부에 있으면 재호출 0
    const opH = PMx.opHashOf(patch);
    const jr9 = readEnrichJob(repo);
    const at9 = jr9.st === "ok" ? jr9.job.attempts.find((x) => x.attemptId === attemptId) : null;
    const saved = at9 && Array.isArray(at9.resolutions) ? at9.resolutions.find((r) => r.patchId === patch.patchId && r.opHash === opH) : null;
    let res = saved || null;
    if (!res) {
      if (typeof o.askVerifier !== "function") return { parkReason: "no-verifier" };
      try { res = o.askVerifier({ repo, patch, item, framing }); } catch { res = null; }
      if (!res || !["support", "reject", "inconclusive"].includes(res.verdict)) return { parkReason: "no-verifier" };
      // 영속(수신 즉시 — verdict 무관: 사망 후 재개도 재호출 0). strict 스키마에 맞는 레코드만(이형=park)
      const rec9 = { patchId: patch.patchId, opHash: opH, baseDecisionContextHash: patch.baseDecisionContextHash, verdict: res.verdict, claims: Array.isArray(res.claims) ? res.claims : [] };
      const wS = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, resolutions: [...(x.resolutions || []), rec9] } : x) });
      if (!wS.ok) return { parkReason: "resolution-persist:" + wS.reason }; // 영속 실패=적용 진행 금지(재호출 멱등 깨짐)
      res = rec9;
    }
    if (res.verdict === "reject") {
      const ex = MP.expirePendingPatch(repo, job.mapId, patch.patchId, opH);
      if (ex.ok || ex.reason === "idempotent" || ex.reason === "expired") return { done: true, rejected: true }; // 폐기 확정=종결
      if (ex.reason === "already-applied") return { done: true }; // 이미 적용 완료(경합) — 종결 보충
      if (ex.reason === "busy" || ex.reason === "lock") return { retry: true }; // 일시 — 만료 재시도(재호출 0: 영속 레코드 재사용)
      return { parkReason: "reject-expire:" + ex.reason }; // conflict 등=표면화(폐기 미확정 상태로 전진 금지)
    }
    if (res.verdict !== "support") return { parkReason: "resolution-inconclusive" };
    vrRes = res;
  }
  const ap = MP.applyPatch(repo, job.mapId, patch.patchId, { preCutover: true, ...(vrRes ? { verifierResolution: vrRes } : {}) });
  if (ap.ok) return { done: true };
  const rc = ap.reasonCode;
  if (rc === "wal-active") return { retry: true, recoverFirst: true }; // P2 복구 표면 선행(blocker②)
  if (["lock", "write-failed", "claim-busy"].includes(rc)) return { retry: true }; // 일시=같은 rev 재시도(상한은 호출자)
  if (rc === "cas-stale") return { revUp: true };
  if (rc === "already-applied") return { done: true };
  if (rc === "hard-reject") return { parkReason: "hard-reject" };
  return { parkReason: "unknown-outcome:" + String(rc || "none") }; // 미지·미부여=fail-closed park
}

// 복구(미완 job — 상태표): 마지막 attempt 기준. running 유료=uncertain-call park(재호출 0)·self=재실행 허용·
// applying=cursor 복구(decision patchId 실존=ⓑ 보충 → applyItems 재진입).
function resumeJob(repo, o, env, j, st2) {
  const { MP, log, park } = env;
  const nowIso = () => new Date().toISOString();
  const a = j.attempts[j.attempts.length - 1];
  if (!a) return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "empty-open-job", finishedAt: nowIso() }, "empty-open-job");
  if (a.phase === "running") {
    if (a.provider !== "self") { // 유료=자동 재호출 금지(호출 여부 확인 불가)
      return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "uncertain-call", attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, phase: "parked", parkedReason: "uncertain-call", finishedAt: nowIso() } : x), finishedAt: nowIso() }, "uncertain-call", { provider: a.provider, jobKey: j.jobKey });
    }
    // self=무과금 — attempt를 failed로 접고 '같은 실행에서' 신규 attempt 재진입(3b 1차 blocker② —
    // parked로 닫으면 이후 실행이 parked noop이라 self 자동 재실행 계약 위반)
    const wF = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, phase: "failed", failReason: "interrupted(self — 재실행 허용)", finishedAt: nowIso() } : x) });
    if (!wF.ok) return park(null, "attempt-write:" + wF.reason);
    log({ route: "self", reason: "self-interrupted-rerun", outcome: "routed", jobKey: j.jobKey });
    return runAttempt(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey, corridor: "mapped", changed: null }, "self");
  }
  if (a.phase === "applying") {
    // super 전이 재개(3b 1차 blocker② — marked=expire 재시도부터·완료=rev 전진 마무리)
    if (a.cursor && a.cursor.super) {
      const sup = a.cursor.super;
      const ex = MP.expirePendingPatch(repo, j.mapId, sup.fromPatchId, sup.fromOpHash);
      if (ex.reason === "busy") return park(null, "expire-busy");
      if (!(ex.ok || ex.reason === "idempotent" || ex.reason === "expired" || (ex.reason === "conflict" && /부재/.test(ex.error || "")) || ex.reason === "already-applied")) return park(null, "expire-" + ex.reason);
      if (ex.reason === "already-applied") { // 그새 적용 완료 — ⓑ 보충(전진·super 소거)
        const wS2 = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: [...x.cursor.appliedPatchIds, sup.fromPatchId] } } : x) });
        if (!wS2.ok) return park(null, "cursor-write:" + wS2.reason);
      } else if (sup.toRev > 2) {
        return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "rev-exhausted", finishedAt: nowIso() }, "rev-exhausted", { jobKey: j.jobKey });
      } else { // ⓒ: rev=toRev·super 소거(currentPatch도 폐기 — 새 rev에서 재변환)
        const wS3 = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex, rev: sup.toRev, appliedPatchIds: x.cursor.appliedPatchIds } } : x) });
        if (!wS3.ok) return park(null, "cursor-write:" + wS3.reason);
      }
      return applyItems(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey }, a.attemptId);
    }
    // cursor 복구: currentPatch 존재+decision에 patchId 실존=ⓑ 보충
    if (a.cursor && a.cursor.currentPatch) {
      const idxR = MP.decisionIndexFor(repo, j.mapId);
      const seen9 = idxR.st === "ok" && (idxR.projections || []).some((d9) => d9.patchId === a.cursor.currentPatch.patchId);
      if (seen9) {
        const wB = updateEnrichJob(repo, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: [...x.cursor.appliedPatchIds, x.cursor.currentPatch.patchId] } } : x) });
        if (!wB.ok) return park(null, "cursor-write:" + wB.reason);
      }
      // 미실존=applyItems가 저장본 재투입(propose 멱등)→상태표대로 진행
    }
    return applyItems(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey }, a.attemptId);
  }
  // failed(승격 판단 중 사망)=driveAttempts 재진입 — 실패 플래그 복원
  if (a.phase === "failed") {
    const eF = j.attempts.some((x) => x.provider === "economy" && x.phase === "failed");
    const pF = j.attempts.some((x) => x.provider === "precision" && x.phase === "failed");
    const corridor = "unknown"; // 재개 시 재산출은 driveAttempts 밖 — 보수: 신규 경로로 회귀시키지 않고 표의 실패 분기로
    const d = env.MRt.decideRoute({ mode: j.mode, ready: o.readiness, corridor: st2 && st2.corridor ? st2.corridor : corridor, economyFailed: eF, precisionFailed: pF, conflict: false });
    if (d.route === "park") return park((jj) => jj && { ...jj, phase: "parked", parkedReason: d.reason, finishedAt: nowIso() }, d.reason, { jobKey: j.jobKey });
    return runAttempt(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey, corridor: st2 ? st2.corridor : corridor, changed: null }, d.route);
  }
  return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "attempt-state:" + a.phase, finishedAt: nowIso() }, "attempt-state");
}

module.exports = { ENRICH_DIR, repoKeyFor, consentFileFor, jobFileFor, readEnrichConsent, grantEnrichConsent, revokeEnrichConsent, findGrant, readEnrichJob, updateEnrichJob, jobKeyOf, detPatchId, validateEnrichResult, toPatchV2, evidenceKindOf, appendRouteLog, historylessChanges, runEnrich, ROUTE_LOG, JOB_PHASES, ATTEMPT_PHASES, ENRICH_TARGET_OPS };
