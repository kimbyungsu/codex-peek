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
const JOB_KEYS = ["schema", "jobKey", "mapId", "authorityHash", "decisionContextHash", "mode", "configWs", "slot", "phase", "startedAt", "finishedAt", "parkedReason", "attempts"];
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
        if (!UUID_RE.test(String(r9.patchId)) || !FP_RE.test(String(r9.opHash)) || !FP_RE.test(String(r9.baseDecisionContextHash)) || !["support", "reject", "inconclusive"].includes(r9.verdict) || !Array.isArray(r9.claims) || r9.claims.length < 1) return "resolution 레코드"; // 3차: 빈 claims=P2 적용기와 동형 거부
        if (r9.verdict === "support" && !r9.claims.some((c) => c && c.stance === "support")) return "resolution 모순(support+지지 claim 0 — P2 동형)";
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

module.exports = { ENRICH_DIR, repoKeyFor, consentFileFor, jobFileFor, readEnrichConsent, grantEnrichConsent, revokeEnrichConsent, findGrant, readEnrichJob, updateEnrichJob, jobKeyOf, detPatchId, validateEnrichResult, toPatchV2, evidenceKindOf, JOB_PHASES, ATTEMPT_PHASES, ENRICH_TARGET_OPS };
