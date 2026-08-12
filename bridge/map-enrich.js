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
const repoKeyFor = (repo) => CL.repoKeyForStats(repo);
const consentFileFor = (repo) => path.join(ENRICH_DIR, "consent-" + repoKeyFor(repo) + ".json");
const jobFileFor = (repo) => path.join(ENRICH_DIR, repoKeyFor(repo) + ".job.json");
const deferredFileFor = (repo) => path.join(ENRICH_DIR, repoKeyFor(repo) + ".deferred.json");
// 소화 기준점(2026-08-04 사용자 결정 — 보강 입력 기준점 교체): 보강 입력이 '미커밋 작업트리 변경'뿐이면
// 턴마다 곧바로 커밋하는 작업 방식에서 커밋된 코드 변경이 영영 입력에 안 보인다(조건부 입력 기아 —
// 보관함 0fb9ce8c). 기준점을 '지도가 마지막으로 소화한 커밋'으로 옮겨, 그 이후의 커밋 변경도 입력에
// 합류시킨다(자동커밋·수동작업 워크플로 무관 — 특수 분기 아님). git 기반 저장소 전용(historyless는
// 인벤토리 내용 비교가 이미 전량 커버). 부속 파일=best-effort: 없거나 손상이면 종전 입력(무회귀).
const consumedFileFor = (repo) => path.join(ENRICH_DIR, repoKeyFor(repo) + ".consumed.json");
function readConsumedBaseline(repo) {
  try {
    const o = JSON.parse(fs.readFileSync(consumedFileFor(repo), "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) && /^[0-9a-f]{40}$/.test(String(o.head || "")) ? o : null;
  } catch { return null; }
}
function writeConsumedBaseline(repo, head, mapId) {
  try {
    if (!/^[0-9a-f]{40}$/.test(String(head || ""))) return false;
    fs.mkdirSync(ENRICH_DIR, { recursive: true });
    fs.writeFileSync(consumedFileFor(repo), JSON.stringify({ head: String(head), mapId: String(mapId || ""), at: new Date().toISOString() }));
    return true;
  } catch { return false; }
}
// 기준점 이후의 커밋된 변경 파일을 입력에 합류(순수 계산은 아님 — git 호출·실패=종전 입력 그대로).
function expandChangedWithConsumedDelta(repo, changed, endHead) {
  if (!Array.isArray(changed)) return changed; // 산출 불가(unknown)는 그대로 — 추측 확장 금지
  // 끝점=호출자가 '한 번' 캡처한 커밋(확인 검증 blocker 재등장): 여기서 HEAD를 다시 조회하면 두 조회
  // 사이에 낀 커밋이 발췌 없이 소화 처리된다. 끝점 부재=확장 안 함(기준점도 그때 안 찍히므로 무손실).
  if (!/^[0-9a-f]{40}$/.test(String(endHead || ""))) return changed;
  const base = readConsumedBaseline(repo);
  if (!base) return changed;
  try {
    const { spawnSync } = require("child_process");
    // -z(NUL 구분·인용 해제 — 검증 blocker): 기본 core.quotePath=true면 비ASCII 경로가 C식 8진수+따옴표로
    // 인코딩돼 확장자 판정·판독이 전부 어긋난다(한글 파일명 .js가 doc으로 세탁). NUL 구분 출력은 원문 경로.
    const g = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "diff", "--name-only", "-z", base.head + ".." + endHead], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (g.status !== 0) return changed; // 기준 커밋 소실(리베이스 등)=종전 입력(보수)
    const extra = String(g.stdout || "").split("\0").filter(Boolean) // trim 금지(확인 보완 — 선행 공백 파일명 원문 보존)
      .filter((f) => !String(f).replace(/\\/g, "/").startsWith("project-map/")); // 자체 산출물 제외(⑦a 필터와 동형)
    return [...new Set([...changed, ...extra])];
  } catch { return changed; }
}

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
// retryFrom: 사용자가 명시로 '다시 시도'한 시점의 시도 개수. 그 앞의 실패는 라우팅 판단에서 제외한다
// (2차 blocker①: 옛 실패 플래그가 남아 명시 재시도가 새 호출 없이 곧바로 같은 보류로 돌아갔다).
const JOB_KEYS = ["schema", "jobKey", "mapId", "authorityHash", "decisionContextHash", "mode", "configWs", "slot", "phase", "startedAt", "finishedAt", "parkedReason", "sourceFp", "retryFrom", "attempts"];
// failureStage/failureCode/failureFile: 실패를 사람이 읽을 수 있게 '구조'로도 남긴다(2026-07-29 설계 상의 결론).
// failReason 자유 문자열만 남기면 화면이 내부 표현을 그대로 노출하거나, 호출 실패와 결과 거부를 구분하지 못한다.
const ATTEMPT_KEYS = ["attemptId", "provider", "consentGen", "phase", "startedAt", "sourceFp", "results", "cursor", "resolutions", "failReason", "failureStage", "failureCode", "failureFile", "parkedReason", "finishedAt"];
// 단계와 코드는 닫힌 열거다(화면이 이 값만 보고 문구를 고른다 — 모르는 값은 화면이 '알 수 없음'으로 표시).
const FAILURE_STAGES = ["call", "response", "validation", "conversion"];
const FAILURE_CODES = ["process-failed", "empty-output", "parse-invalid", "schema-invalid", "evidence-mismatch", "evidence-unreadable", "convert-invalid"];
const CURSOR_KEYS = ["nextIndex", "rev", "currentPatch", "super", "appliedPatchIds", "evExtra", "oosUsed"];
const SUPER_KEYS = ["fromPatchId", "fromOpHash", "toRev", "phase"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FP_RE = /^[0-9a-f]{40}$/;
function unknownKey(obj, allowed) { const k = Object.keys(obj).find((x) => !allowed.includes(x)); return k || null; }
// EnrichItem '형태' strict(3차 f-b74df6a1 — 장부·결과 validator 공용: ID 실존 검사만 제외한 전 규칙).
// 반환 null(정상)|오류 문자열.
function itemShapeError(it) {
  if (!it || typeof it !== "object" || Array.isArray(it)) return "이형";
  const ITEM_KEYS = { target: ["op", "targetId", "payload", "evidence"], add_edge: ["op", "payload", "evidence"], add_node: ["op", "payload", "evidence"], rewrite_label: ["op", "targetId", "payload", "evidence", "claims"] };
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
  if (it.op === "add_node") { // 해상도 설계 v3 §2-2b — 정적 자격(문맥 무관 부분: 장부 재판독도 같은 규칙)
    const n9 = it.payload.node;
    if (!n9 || typeof n9 !== "object" || Array.isArray(n9)) return "payload.node 필수";
    const PM9 = (() => { try { return require(path.join(__dirname, "project-map.js")); } catch { return null; } })();
    if (PM9) { const ne = PM9.validateNode(n9); if (ne.length) return "add_node: node 스키마 위반(" + ne[0] + ")"; }
    if (n9.entityType !== "file") return "add_node: entityType=file만 허용(상위 구조 신설은 보강 권한 밖)";
    if (!Array.isArray(n9.anchors) || n9.anchors.length !== 1) return "add_node: anchors는 정확히 1개";
    const a9 = n9.anchors[0];
    const kindWant = evidenceKindOf(a9.path);
    if (a9.kind !== kindWant) return "add_node: anchor.kind 불일치(kind 세탁 차단 — 실제 분류=" + kindWant + ")";
    if (PM9 && !PM9.CODE_EVIDENCE_KINDS.includes(a9.kind)) return "add_node: 코드 계열 파일만(code/test/config — 문서 파일 노드화 금지)";
    if (!n9.state || n9.state.confidence !== "candidate") return "add_node: confidence=candidate 강제(태생 confirmed 금지)";
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
  if (d.retryFrom !== undefined && (!Number.isInteger(d.retryFrom) || d.retryFrom < 0 || d.retryFrom > d.attempts.length)) return "retryFrom";
  for (let i9 = 0; i9 < d.attempts.length; i9++) { const a9 = d.attempts[i9]; if (!a9 || a9.attemptId !== i9) return "attemptId 순번(" + i9 + ")"; }
  for (const a of d.attempts) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return "attempt 이형";
    { const u = unknownKey(a, ATTEMPT_KEYS); if (u) return "attempt 미지 필드:" + u; }
    if (!Number.isInteger(a.attemptId) || a.attemptId < 0) return "attemptId";
    if (!["self", "economy", "precision"].includes(a.provider)) return "attempt provider";
    if (!Number.isInteger(a.consentGen) || a.consentGen < 1) return "consentGen(>=1 — self도 selfAuto grant 세대 동결 필수: 무과금이어도 AI 호출+전송이라 동의 없는 attempt는 장부 경계에서 차단[8차 ab-7])";
    if (!ATTEMPT_PHASES.includes(a.phase)) return "attempt phase";
    if (typeof a.startedAt !== "string") return "attempt startedAt";
    if (a.sourceFp !== undefined && !FP_RE.test(String(a.sourceFp))) return "attempt sourceFp"; // 호출 시점 소비 지문(5차 — 재개 done이 사후 지문을 도장으로 쓰는 오염 차단)
    if (a.failReason !== undefined && typeof a.failReason !== "string") return "attempt failReason";
    if (a.failureStage !== undefined && !FAILURE_STAGES.includes(a.failureStage)) return "attempt failureStage";
    if (a.failureCode !== undefined && !FAILURE_CODES.includes(a.failureCode)) return "attempt failureCode";
    // 저장소 상대경로만 — 절대경로·상위 탈출은 화면으로 내보낼 값이 아니다.
    if (a.failureFile !== undefined && (typeof a.failureFile !== "string" || !a.failureFile || a.failureFile.length > 260 || /^([a-zA-Z]:|[\\/])/.test(a.failureFile) || a.failureFile.split(/[\\/]/).includes(".."))) return "attempt failureFile";
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
      if (c.evExtra !== undefined && !(Array.isArray(c.evExtra) && c.evExtra.every((f9) => typeof f9 === "string" && !!f9))) return "cursor.evExtra"; // 3b: 범위 밖 인용 확장(문자열 배열)
      if (c.oosUsed !== undefined && typeof c.oosUsed !== "boolean") return "cursor.oosUsed"; // 4차: 범위 밖 재해소 1회 표지(사전 결속 evExtra와 분리)
      if (a.results === undefined) return "cursor↔results(적용 진행은 수신 결과 위에서만 — 3차)"; // results 부재+cursor=오재개 재료
      if (c.nextIndex > a.results.items.length) return "cursor.nextIndex 범위(results 결속)"; // 2차: item 수 초과=오재개
      // 4차 f-b74df6a1(+3b 도장 분리 개정): appliedPatchIds=실제 적용만(reject·N-I 종결은 nextIndex만 전진) —
      // 불변식은 '<=nextIndex'(초과=불가능 상태·미만=비적용 종결 존재).
      if (c.appliedPatchIds.length > c.nextIndex) return "cursor 불변식(appliedPatchIds 수<=nextIndex — 적용 도장은 전진을 초과할 수 없다)";
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
        if (cp.patchId !== detPatchId(jobSeedOf(d.jobKey, d.startedAt), a.attemptId, c.nextIndex, c.rev)) return "currentPatch.patchId 결속(jobSeed[jobKey+startedAt 세대]·attemptId·nextIndex·rev — 3차 blocker④)";
        if (cp.provider !== a.provider) return "currentPatch.provider 결속";
        const it9 = a.results.items[c.nextIndex];
        if (!it9 || cp.operation !== it9.op) return "currentPatch.operation↔item 결속";
        if ((it9.targetId !== undefined || cp.targetId !== undefined) && cp.targetId !== it9.targetId) return "currentPatch.targetId↔item 결속";
        // 해상도 v3: payload 결속은 '결정론 id 재작성 후' 전문 비교 — 변환기와 같은 순수 함수
        // (applyEnrichPayloadIds — 영속 items 기반이라 재개 후에도 같은 값. 감싸개·복제 드리프트 계보).
        try { if (JSON.stringify(cp.payload) !== JSON.stringify(applyEnrichPayloadIds(a.results.items, c.nextIndex, d.mapId))) return "currentPatch.payload↔item 결속"; } catch { return "currentPatch.payload 직렬화"; }
        // 6차(ab-3): {kind, ref} 전문 일치 — ref만 대조하면 doc 근거가 code kind로 세탁돼 P2 관문(코드 근거
        // 최소 1개 — kind 기준 판정 실측)을 통과한다. 기대 전문=변환기 규칙 그대로(evidenceKindOf).
        const extra9 = Array.isArray(c.evExtra) ? c.evExtra : [];
        // 정렬은 'kind:file' 변환 후에(2026-08-04 실사고): 파일명 정렬 뒤 kind를 붙이면 종류가 섞인
        // 집합에서 haveEv('kind:ref' 정렬)와 순서가 갈려 정상 patch를 결속 위반으로 오판한다 — 이전엔
        // 종류 섞인 답이 변환 단계에서 먼저 거부돼 잠복했던 버그.
        const wantEv = [...new Set([...(it9.evidence || []).map((e) => e.file), ...((it9.claims || []).map((x) => x.file)), ...extra9])].map((f9) => evidenceKindOf(f9) + ":" + f9).sort().join("|"); // evExtra(범위 밖 인용 확장)도 결속 집합에 포함
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
// ── 실행 잠금(run-lock) 획득 — runEnrich 본체와 죽은 job-잠금 회수가 '같은' 검증된 절차를 쓴다 ──
// (5차 재확인 종결: 회수용 상호배제를 새로 발명하는 대신, 사망 회수+오탈취 복원+read-back fence까지
//  이미 검증 통과([9] 3반복 경합)한 이 원시를 재사용. 잔존도 이 원시의 사망 회수가 자동 해소하므로
//  '표식 영구 잔존' 계급이 소멸 — 별도 .reclaim 표식 개념은 폐기.)
const HELD_RUN_LOCKS = new Map(); // repoKey → token (같은 프로세스 재진입 판별 — runEnrich 안의 회수는 이미 직렬화됨)
function acquireEnrichRunLock(repo) {
  const rKey = repoKeyFor(repo);
  try { fs.mkdirSync(ENRICH_DIR, { recursive: true }); } catch { /* 잠금이 실패 판정 */ }
  const runLock = path.join(ENRICH_DIR, rKey + ".run.funlock");
  const tok = crypto.randomBytes(8).toString("hex");
  const p10RunId = crypto.randomUUID();
  try { fs.writeFileSync(runLock, JSON.stringify({ pid: process.pid, token: tok, runId: p10RunId }), { flag: "wx" }); }
  catch {
    // 사망 회수(3b 1차 강등분 d2deff57384881b8 즉시 수정 — 두 창이 같은 dead lock을 읽고 한쪽이 새로 취득한
    // 뒤 다른 쪽이 그 새 잠금을 삭제하는 경합): unlink가 아니라 '고유 격리명으로의 원자 rename' — 이동에
    // 성공한 단일 복구자만 재취득하고, 이동해 온 파일이 자기가 판독한 그 잔재(pid·token 동일)인지 재검증.
    // 오탈취(그새 교체된 잠금)면 복원. bootstrap 잔재 회수 문법 동형.
    const held = readJson3(runLock);
    if (!(held.st === "ok" && Number.isInteger(held.data.pid) && typeof held.data.token === "string")) return { ok: false, reason: "run-lock-damaged" }; // 손상=수동 소관(판정 없는 삭제 금지)
    let dead = false;
    try { process.kill(held.data.pid, 0); } catch (e) { dead = !!(e && e.code === "ESRCH"); }
    if (!dead) return { ok: false, reason: "run-lock" };
    const grave = runLock + ".reclaim." + process.pid + "." + tok;
    try { fs.renameSync(runLock, grave); } catch { return { ok: false, reason: "run-lock" }; } // 이동 실패=타 복구자 선점
    const moved = readJson3(grave);
    if (!(moved.st === "ok" && moved.data.pid === held.data.pid && moved.data.token === held.data.token)) {
      // 오탈취(그새 교체된 산 잠금을 옮김) — '복원하지 않는다'(6차 재확인 blocker로 종전 복원 폐기):
      // 복원은 원 소유자가 그 사이 release를 끝냈으면 '주인 없는 산 pid 잠금'을 만들어 영구 정지를
      // 낳는다(살아있는 확장 호스트 pid는 사망 회수 불가). 대신 격리물만 남기고 물러난다 — 원 소유자는
      // 설계된 fence(임계구역 소유 재검증 — 2차 blocker⑧ 계보)가 상실을 감지해 안전 중단하고, 잠금
      // 경로는 비어 다음 획득자가 정상 진행한다(고아 없음·감사 흔적=grave 보존).
      return { ok: false, reason: "run-lock" };
    }
    try { fs.unlinkSync(grave); } catch { /* 격리 잔존 무해 */ }
    try { fs.writeFileSync(runLock, JSON.stringify({ pid: process.pid, token: tok, runId: p10RunId }), { flag: "wx" }); } catch { return { ok: false, reason: "run-lock" }; }
    const rb = readJson3(runLock); // read-back fence
    if (!(rb.st === "ok" && rb.data.token === tok && rb.data.pid === process.pid)) return { ok: false, reason: "run-lock" };
  }
  HELD_RUN_LOCKS.set(rKey, tok);
  return {
    ok: true, runLock, token: tok, p10RunId,
    fence: () => { const h = readJson3(runLock); return h.st === "ok" && h.data.token === tok && h.data.pid === process.pid; },
    release: () => { try { HELD_RUN_LOCKS.delete(rKey); const h = readJson3(runLock); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(runLock); } catch { /* 무해 */ } },
  };
}
// 죽은 job-잠금 회수 — 반드시 run-lock '아래'에서만(기계 전역 단일 회수자 보장): runEnrich 안(이미 보유)
// 이면 그대로, 밖(확장 UI 직접 호출 등)이면 위 검증된 절차로 잠깐 획득 후 회수·해제. 획득 실패=양보
// (다음 tick의 run-lock 사망 회수가 잔존까지 자동 해소 — '영구 잔존' 계급 소멸).
function reclaimDeadJobLock(repo, lp) {
  const rKey = repoKeyFor(repo);
  const doReclaim = () => {
    let tok = null;
    try { tok = fs.readFileSync(lp, "utf8"); } catch { return true; } // 이미 회수됨 → 정상 재획득 루프
    const pid9 = parseInt(String(tok).split("-")[0], 10);
    let alive9 = true;
    try { if (pid9) process.kill(pid9, 0); } catch (ke) { alive9 = !(ke && ke.code === "ESRCH"); }
    if (!pid9 || alive9) return false; // run-lock 아래 재판독=산 잠금(낡은 지식 오탈취 원천 소거)
    const stale9 = lp + ".stale-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    try { fs.renameSync(lp, stale9); } catch { return false; }
    let moved9 = null;
    try { moved9 = fs.readFileSync(stale9, "utf8"); } catch { moved9 = null; }
    return moved9 === tok; // 모델 밖 간섭 불일치=회수 실패 취급(격리물 보존·복원 안 함)
  };
  if (HELD_RUN_LOCKS.has(rKey)) return doReclaim(); // runEnrich 임계구역 안 — 이미 기계 전역 직렬화됨
  const acq = acquireEnrichRunLock(repo);
  if (!acq.ok) return false;
  try { return doReclaim(); } finally { acq.release(); }
}
function withJobLock(repo, fn) {
  try { fs.mkdirSync(ENRICH_DIR, { recursive: true }); } catch { /* 잠금이 실패 판정 */ }
  const lp = jobFileFor(repo) + ".lock";
  // 사망 확정(ESRCH) 잔존 잠금=격리 개명 후 1회 재획득(확인 검증 blocker ab-6): 커서 영속과 잠금 해제
  // '사이'에 프로세스가 죽으면 잔존 잠금이 자동 재개를 영구 차단했다. 전역 잠금(withFileLockStrict)의
  // '죽은 보유자=즉시 실패' 계약은 과거 검증에서 동결(lost-update 차단 — project-map 소관 계약)이라
  // 뒤집지 않고, 자기치유가 계약인 '보강 장부' 경계에서만 회수한다 — 실행 잠금(run-lock) 사망 회수와
  // 같은 관용구: 삭제가 아닌 개명(잔존물 보존)·ESRCH 확정만(EPERM 등=보유 중 취급·pid 재사용=보수).
  for (let i = 0; i < 2; i++) {
    const r = CL.withFileLockStrict(lp, fn);
    if (r.ok || !String(r.error || "").includes("dead-lock-holder")) return r;
    if (!reclaimDeadJobLock(repo, lp)) return r; // 회수 불가·타 회수자 활동 중=종전 실패 그대로(수동 안내 유지)
  }
  return CL.withFileLockStrict(lp, fn);
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
// 자동 보강이 멈춘 사실을 무결성 채널(노랑)에 남긴다 — 대시보드 특정 줄을 열어야만 아는 상태를
// 없애기 위한 통지(2026-08-04 사용자 실보고). 같은 프로젝트의 미확인 동종 경보는 한 잠금·한 쓰기로
// 갈아끼운다(누적 방지+유실 방지). 재개 경로(resumeJob)의 park도 반드시 이 함수를 거쳐야
// '첫 경보를 확인한 뒤 자동 재시도가 다시 실패하면 경보가 사라지는' 창이 생기지 않는다.
function notifyEnrichParked(wsLabel, reason) {
  try {
    const wsLbl = String(wsLabel || "");
    if (!wsLbl) return;
    // 같은 사유의 열린 경보가 이미 있으면 재발행하지 않는다(2026-08-04 사용자 실보고: '다시 시도'를
    // 누를 때마다 같은 멈춤 경보가 새로 떠 반복처럼 보임). 사유가 다르면 종전대로 동종 교체(정확한
    // 최신 사유 1건 유지). 확인(ack)된 경보는 대상 아님 — 상태가 그대로면 조용, 새 사건이면 재발행.
    try {
      const openSame = (CL.readIntegrityEvents() || []).some((e) => e && !e.ack && e.kind === "enrich-parked"
        && e.workspace && CL.normWs(String(e.workspace)) === CL.normWs(wsLbl)
        && String(e.detailKo || e.detail || "").includes(`(사유: ${reason})`));
      if (openSame) return;
    } catch { /* 판독 실패=종전 동작(교체 발행) */ }
    CL.appendIntegrityEvent({
      ts: new Date().toISOString(), workspace: wsLbl, kind: "enrich-parked", severity: "warning",
      detailKo: `지도 자동 보강이 멈췄습니다(사유: ${reason}) — 대시보드의 '자동 보강' 줄에서 원인과 다시 시도를 확인하세요.`,
      detailEn: `Map auto-enrichment stopped (reason: ${reason}) — see the 'Auto-enrich' line in the dashboard for the cause and retry.`,
      detail: `지도 자동 보강이 멈췄습니다(사유: ${reason}) — 대시보드의 '자동 보강' 줄에서 원인과 다시 시도를 확인하세요.`,
    }, { supersedeSameKindWs: true });
  } catch { /* 알림 실패가 실행기를 막지 않는다 */ }
}
function jobKeyOf(mapId, authorityHash, decisionContextHash) {
  return sha1(String(mapId) + "|" + String(authorityHash) + (decisionContextHash ? "|" + decisionContextHash : ""));
}

// ── 검증 확인 대기 장부(enrich-deferred-v1) ────────────────────────────────────
// Project MAP pending은 patch/lifecycle 정본이고, 이 장부는 P8 실행기의 운영 상태만 보존한다. job 파일과 분리해
// 새 source 세대가 와도 확인 대기 사유·호출 세대가 사라지지 않는다. 일반 tick은 이 장부를 읽기만 하며 외부
// verifier 재호출을 열지 않는다.
const DEFERRED_PHASES = ["waiting", "calling", "answered", "uncertain", "settled", "stale"];
const DEFERRED_REASONS = ["no-verifier", "inconclusive", "uncertain-call", "answered", "cas-stale", "settled"];
const DEFERRED_TERMINAL_KEEP_MS = 60 * 24 * 60 * 60 * 1000;
function validateDeferred(d) {
  if (!d || typeof d !== "object" || Array.isArray(d) || d.schema !== "enrich-deferred-v1" || !Array.isArray(d.records)) return "root";
  if (Object.keys(d).some((k) => !["schema", "records"].includes(k))) return "root-key";
  const ids = new Set();
  for (const r of d.records) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return "record";
    const allowed = ["mapId", "patchId", "opHash", "jobKey", "jobRunId", "attemptId", "itemIndex", "framing", "phase", "reason", "retryGeneration", "lastLinkGeneration", "callToken", "callTrigger", "resolution", "terminalOutcome", "history", "createdAt", "updatedAt", "rebasedFrom"];
    if (Object.keys(r).some((k) => !allowed.includes(k))) return "record-key";
    if (!UUID_RE.test(String(r.mapId)) || !UUID_RE.test(String(r.patchId)) || !FP_RE.test(String(r.opHash)) || !FP_RE.test(String(r.jobKey))) return "identity";
    if (ids.has(r.patchId)) return "duplicate"; ids.add(r.patchId);
    if (!Number.isInteger(r.attemptId) || r.attemptId < 0 || !Number.isInteger(r.itemIndex) || r.itemIndex < 0) return "position";
    if (r.jobRunId !== undefined && !FP_RE.test(String(r.jobRunId))) return "job-run-id";
    if (!["resolution", "conflict"].includes(r.framing) || !DEFERRED_PHASES.includes(r.phase) || !DEFERRED_REASONS.includes(r.reason)) return "state";
    if (!Number.isInteger(r.retryGeneration) || r.retryGeneration < 0 || typeof r.createdAt !== "string" || typeof r.updatedAt !== "string") return "meta";
    if (r.lastLinkGeneration !== undefined && typeof r.lastLinkGeneration !== "string") return "link-generation";
    if (r.callToken !== undefined && typeof r.callToken !== "string") return "call-token";
    if (r.callTrigger !== undefined && !["initial", "manual", "link"].includes(r.callTrigger)) return "call-trigger";
    if (r.terminalOutcome !== undefined && (!["applied", "rejected"].includes(r.terminalOutcome) || !["settled", "stale"].includes(r.phase))) return "terminal-outcome";
    if (r.rebasedFrom !== undefined && !UUID_RE.test(String(r.rebasedFrom))) return "rebased-from";
    if (!Array.isArray(r.history) || r.history.length > 40) return "history";
    for (const h of r.history) {
      if (!h || typeof h !== "object" || Array.isArray(h) || Object.keys(h).some((k) => !["generation", "trigger", "outcome", "at"].includes(k))
        || !Number.isInteger(h.generation) || h.generation < 0 || typeof h.trigger !== "string" || typeof h.outcome !== "string" || typeof h.at !== "string") return "history-row";
    }
    if (r.resolution !== undefined) {
      const z = r.resolution;
      if (!z || typeof z !== "object" || Array.isArray(z) || Object.keys(z).some((k) => !["patchId", "opHash", "baseDecisionContextHash", "verdict", "claims"].includes(k))
        || z.patchId !== r.patchId || z.opHash !== r.opHash || !FP_RE.test(String(z.baseDecisionContextHash)) || !["support", "reject"].includes(z.verdict) || !Array.isArray(z.claims)) return "resolution";
      if (z.verdict === "support" && (z.claims.length < 1 || !z.claims.some((c) => c && c.stance === "support"))) return "resolution-support";
      for (const c of z.claims) {
        if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((k) => !["file", "contentHash", "locator", "stance"].includes(k))
          || typeof c.file !== "string" || !c.file || !FP_RE.test(String(c.contentHash)) || typeof c.locator !== "string" || !c.locator || !["support", "rebut"].includes(c.stance)) return "resolution-claim";
      }
    }
  }
  return null;
}
function readDeferred(repo) {
  const r = readJson3(deferredFileFor(repo));
  if (r.st === "absent") return { st: "ok", data: { schema: "enrich-deferred-v1", records: [] } };
  if (r.st !== "ok") return { st: "damaged" };
  const e = validateDeferred(r.data); return e ? { st: "damaged", detail: e } : { st: "ok", data: r.data };
}
function updateDeferred(repo, mut) {
  try { fs.mkdirSync(ENRICH_DIR, { recursive: true }); } catch { /* lock reports failure */ }
  const w = CL.withFileLockStrict(deferredFileFor(repo) + ".lock", () => {
    const cur = readDeferred(repo); if (cur.st !== "ok") return { ok: false, reason: "deferred-damaged" };
    const next = mut(cur.data); if (next === null) return { ok: true, unchanged: true, data: cur.data };
    const cutoff = Date.now() - DEFERRED_TERMINAL_KEEP_MS;
    const compact = { ...next, records: next.records.filter((r) => {
      if (!["settled", "stale"].includes(r.phase)) return true;
      const t = Date.parse(r.updatedAt);
      return !Number.isFinite(t) || t >= cutoff;
    }) };
    const e = validateDeferred(compact); if (e) return { ok: false, reason: "deferred-invalid:" + e };
    return CL.atomicWrite(deferredFileFor(repo), JSON.stringify(compact, null, 1)) ? { ok: true, data: compact } : { ok: false, reason: "write" };
  });
  return w.ok ? w.result : { ok: false, reason: "lock" };
}
function deferredRecord(repo, patchId) {
  const r = readDeferred(repo); return r.st === "ok" ? r.data.records.find((x) => x.patchId === patchId) || null : null;
}
function ensureDeferredWaiting(repo, meta, reason) {
  const now = new Date().toISOString(); let created = false;
  const w = updateDeferred(repo, (d) => {
    if (d.records.some((r) => r.patchId === meta.patchId)) return null;
    created = true;
    return { ...d, records: [...d.records, { ...meta, phase: "waiting", reason: reason || "no-verifier", retryGeneration: 0, history: [], createdAt: now, updatedAt: now }] };
  });
  return w.ok ? { ok: true, created } : { ok: false, reason: w.reason };
}
function recoverDeferredCalls(repo) {
  const now = new Date().toISOString();
  return updateDeferred(repo, (d) => d.records.some((r) => r.phase === "calling") ? ({ ...d, records: d.records.map((r) => r.phase === "calling"
    ? { ...r, phase: "uncertain", reason: "uncertain-call", callToken: undefined, callTrigger: undefined, updatedAt: now, history: [...r.history, { generation: r.retryGeneration, trigger: "recovery", outcome: "uncertain-call", at: now }].slice(-40) }
    : r) }) : null);
}
function beginDeferredCall(repo, meta, trigger, linkGeneration) {
  const now = new Date().toISOString(), token = crypto.randomBytes(8).toString("hex"); let action = "skip", recOut = null;
  const w = updateDeferred(repo, (d) => {
    const i = d.records.findIndex((r) => r.patchId === meta.patchId); let r = i >= 0 ? d.records[i] : null;
    if (r && r.opHash !== meta.opHash) { action = "conflict"; return null; }
    if (r && r.phase === "answered") { action = "answered"; recOut = r; return null; }
    if (r && ["settled", "stale"].includes(r.phase)) { action = "skip"; recOut = r; return null; }
    const manual = trigger === "manual";
    const link = trigger === "link" && (!r || r.reason === "no-verifier") && String(linkGeneration || "") !== String(r && r.lastLinkGeneration || "");
    const initial = trigger === "initial" && (!r || (r.phase === "waiting" && r.history.length === 0));
    if (!(initial || manual || link)) { action = "skip"; recOut = r; return null; }
    const generation = r ? r.retryGeneration + (manual || link ? 1 : 0) : 0;
    const next = r ? { ...r } : { ...meta, phase: "waiting", reason: "no-verifier", retryGeneration: 0, history: [], createdAt: now, updatedAt: now };
    Object.assign(next, { phase: "calling", reason: next.reason || "no-verifier", retryGeneration: generation, callToken: token, callTrigger: trigger, updatedAt: now, ...(link ? { lastLinkGeneration: String(linkGeneration || "") } : {}) });
    const records = [...d.records]; if (i >= 0) records[i] = next; else records.push(next);
    action = "call"; recOut = next; return { ...d, records };
  });
  return w.ok ? { ok: true, action, record: recOut, token } : { ok: false, action: "error", reason: w.reason };
}
function finishDeferredCall(repo, patchId, token, outcome, resolution) {
  const now = new Date().toISOString(); let out = null;
  const w = updateDeferred(repo, (d) => {
    const i = d.records.findIndex((r) => r.patchId === patchId); if (i < 0) return null;
    const r = d.records[i]; if (r.phase !== "calling" || r.callToken !== token) return null;
    const answered = resolution && ["support", "reject"].includes(resolution.verdict);
    const next = { ...r, phase: answered ? "answered" : outcome === "uncertain-call" ? "uncertain" : "waiting", reason: answered ? "answered" : outcome, callToken: undefined, callTrigger: undefined,
      ...(answered ? { resolution } : { resolution: undefined }), updatedAt: now,
      history: [...r.history, { generation: r.retryGeneration, trigger: r.callTrigger || "initial", outcome, at: now }].slice(-40) };
    const records = [...d.records]; records[i] = next; out = next; return { ...d, records };
  });
  return w.ok ? { ok: true, record: out } : { ok: false, reason: w.reason };
}
function settleDeferred(repo, patchId, phase, reason, terminalOutcome) {
  const now = new Date().toISOString();
  return updateDeferred(repo, (d) => d.records.some((r) => r.patchId === patchId) ? ({ ...d, records: d.records.map((r) => r.patchId === patchId
    ? { ...r, phase: phase || "settled", reason: reason || "settled", callToken: undefined, callTrigger: undefined, resolution: undefined,
      ...((terminalOutcome || r.terminalOutcome) ? { terminalOutcome: terminalOutcome || r.terminalOutcome } : {}), updatedAt: now }
    : r) }) : null);
}
function deferredSummary(repo, mapId) {
  const r = readDeferred(repo); if (r.st !== "ok") return { st: r.st, awaiting: null, records: [] };
  const selected = r.data.records.filter((x) => !mapId || x.mapId === mapId);
  const records = selected.filter((x) => ["waiting", "calling", "answered", "uncertain"].includes(x.phase));
  const terminalRecords = selected.filter((x) => ["applied", "rejected"].includes(x.terminalOutcome));
  const unattributedRecords = selected.filter((x) => !x.jobRunId);
  return { st: "ok", awaiting: records.length, records, terminalRecords, unattributed: unattributedRecords.length, unattributedRecords };
}
function enrichOutcomeSummary(job, deferred) {
  if (!job) return { applied: 0, rejected: 0, awaiting: deferred && deferred.st === "ok" ? deferred.awaiting || 0 : null, investigation: 0, otherAwaiting: 0, unattributed: deferred && deferred.st === "ok" ? deferred.unattributed || 0 : null };
  const runId = jobRunIdOf(job);
  const appliedIds = new Set(), rejectedIds = new Set();
  for (const a of job.attempts || []) {
    for (const id of ((a.cursor && a.cursor.appliedPatchIds) || [])) appliedIds.add(id);
    for (const z of (a.resolutions || [])) if (z && z.verdict === "reject" && z.patchId) rejectedIds.add(z.patchId);
  }
  if (deferred && deferred.st === "ok") for (const r of (deferred.terminalRecords || [])) {
    if (r.jobKey !== job.jobKey || !runId || r.jobRunId !== runId) continue;
    if (r.terminalOutcome === "applied") { appliedIds.add(r.patchId); rejectedIds.delete(r.patchId); }
    if (r.terminalOutcome === "rejected") { rejectedIds.add(r.patchId); appliedIds.delete(r.patchId); }
  }
  const awaiting = deferred && deferred.st === "ok" ? (deferred.records || []).filter((r) => r.jobKey === job.jobKey && runId && r.jobRunId === runId).length : null;
  const otherAwaiting = deferred && deferred.st === "ok" ? (deferred.records || []).filter((r) => r.mapId === job.mapId && r.jobRunId && (!runId || r.jobRunId !== runId)).length : 0;
  const last = job.attempts && job.attempts.length ? job.attempts[job.attempts.length - 1] : null;
  const itemCount = last && last.results && Array.isArray(last.results.items) ? last.results.items.length : 0;
  return { applied: appliedIds.size, rejected: rejectedIds.size, awaiting, otherAwaiting, unattributed: deferred && deferred.st === "ok" ? deferred.unattributed || 0 : null,
    investigation: awaiting === null ? null : Math.max(0, itemCount - appliedIds.size - rejectedIds.size - awaiting) };
}

// ── 결정론 patchId(설계 3·6차 — RFC 4122 name-based·rev 세대 포함·재계산 동일·rebase 불변) ──
// 3차 blocker④: patchId에 job '실행 세대'(startedAt — 장부 영속·불변·재계산 가능)를 결속 — v11에서 같은
// jobKey의 새 실행(sourceFp 상이)이 이전 실행의 patchId를 재사용해 P2 잔존 pending과 충돌하는 경로 차단.
function jobSeedOf(jobKey, startedAt) { return sha1(String(jobKey) + "|" + String(startedAt)); }
function jobRunIdOf(job) { return job && job.jobKey && job.startedAt ? jobSeedOf(job.jobKey, job.startedAt) : null; }
function detPatchId(jobKey, attemptId, index, rev) {
  const h = crypto.createHash("sha1").update(jobKey + ":" + attemptId + ":" + index + ":" + rev).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5(name-based)
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const x = b.toString("hex");
  return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
}
// ── 해상도 설계 v3 — file 노드 결정론 id·임시 id 매핑(순수 계층) ─────────────────────
// 경로 정규화=구분자 통일만(§2-2c — case-fold는 Linux 별개 파일을 오합침하므로 금지·원문 case 보존).
function fileNodePathKey(p) { return String(p || "").replace(/\\/g, "/"); }
// 결정론 file 노드 id: 같은 (mapId, 경로)면 언제나 같은 UUID — 경합 라운드의 이중 생성을
// 적용기 "id가 이미 존재" 거부와 이중 방어로 차단(§2-2c).
function detFileNodeId(mapId, anchorPath) {
  const h = crypto.createHash("sha1").update("file-node|" + String(mapId) + "|" + fileNodePathKey(anchorPath)).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
}
// 임시 id→결정론 id 매핑=별도 상태가 아니라 '영속된 결과의 순수 함수'(§2-2a — 2차 설계 blocker):
// items[0..uptoIndex)의 add_node들로부터 매 호출 재계산 — add_node 적용 직후 사망→재개돼도 후속
// add_edge 변환·결속 검증이 같은 매핑을 복원한다(별도 영속·라운드 메모리·재개 전달 전부 불요).
function enrichTempIdMap(items, uptoIndex, mapId) {
  const m = new Map();
  const n = Math.min(Array.isArray(items) ? items.length : 0, uptoIndex);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    if (!it || it.op !== "add_node") continue;
    const node = it.payload && it.payload.node;
    const p = node && Array.isArray(node.anchors) && node.anchors[0] ? node.anchors[0].path : null;
    if (node && typeof node.id === "string" && p) m.set(node.id, detFileNodeId(mapId, p));
  }
  return m;
}
// items[index]의 payload를 결정론 id로 재작성한 사본을 반환(add_node=node.id 교체·add_edge=임시 id
// endpoint 재작성·그 외=원본 그대로). 변환기(toPatchV2)와 cursor 결속 검증이 '같은 함수'를 쓴다
// (복제 금지 — 정렬·선정·판독 단일 경로 계보).
function applyEnrichPayloadIds(items, index, mapId) {
  const it = Array.isArray(items) ? items[index] : null;
  if (!it || !it.payload) return it ? it.payload : null;
  if (it.op === "add_node") {
    const node = it.payload.node;
    const p = node && Array.isArray(node.anchors) && node.anchors[0] ? node.anchors[0].path : null;
    if (!node || !p) return it.payload;
    return { ...it.payload, node: { ...node, id: detFileNodeId(mapId, p) } };
  }
  if (it.op === "add_edge") {
    const m = enrichTempIdMap(items, index, mapId); // 자기보다 앞선 add_node만(순서 제약 §2-2a)
    const e = it.payload.edge;
    if (!e) return it.payload;
    const from = m.has(e.from) ? m.get(e.from) : e.from;
    const to = m.has(e.to) ? m.get(e.to) : e.to;
    if (from === e.from && to === e.to) return it.payload;
    return { ...it.payload, edge: { ...e, from, to } };
  }
  return it.payload;
}

// ── enrich-result-v1 validator(P8-3 — op별 합타입·strict·크기 상한) ─────────────────
const ENRICH_TARGET_OPS = ["add_evidence", "set_state", "add_anchor"];
const RESULT_MAX_ITEMS = 200;
const RESULT_MAX_CHARS = 400000;
// 반환 {ok, items} / {ok:false, kind:"schema"|"id", errors:[...]} — 근거(evidence 실존) 검사는 실행기(파일계 접근)가 수행.
function validateEnrichResult(obj, topo, ctx) {
  // ctx({repo, changed} — 해상도 설계 v3): 응답 검증 시 add_node의 발췌 실림·판독 자격까지 본다.
  // 장부 재판독 등 ctx 없는 호출은 정적 규칙만(과거 결과를 나중 파일 상태로 소급 오판하지 않음).
  const errs = [];
  const ids = new Set([...((topo && topo.nodes) || []).map((n) => n && n.id), ...((topo && topo.edges) || []).map((e) => e && e.id)]);
  const nodeIds = new Set([...((topo && topo.nodes) || []).map((n) => n && n.id)]);
  const pendingNodeIds = new Set(); // §2-2a 가상 topology — 이번 결과에서 '앞서' 생성된 임시 id만 순차 합류
  const existingFilePaths = new Set(((topo && topo.nodes) || []).filter((n) => n && n.entityType === "file")
    .flatMap((n) => (n.anchors || []).map((a) => fileNodePathKey(a && a.path))));
  const excerptSet = ctx ? (() => { try { return new Set(require(path.join(__dirname, "enrich-providers.js")).excerptFilesFor(topo, ctx.changed).map(fileNodePathKey)); } catch { return null; } })() : null;
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
      // §2-2a 가상 topology: 이번 결과에서 '앞서' 생성된 file 노드의 임시 id도 endpoint로 인정
      // (뒤의 add_node를 앞서 참조하면 미실존 — 적용이 cursor 순차라 검증도 같은 순서).
      if (!nodeIds.has(e9.from) && !pendingNodeIds.has(e9.from)) { errs.push(tag + " edge.from 미실존"); idErr = true; return; }
      if (!nodeIds.has(e9.to) && !pendingNodeIds.has(e9.to)) { errs.push(tag + " edge.to 미실존"); idErr = true; return; }
    }
    if (it.op === "add_node") { // 해상도 설계 v3 — 문맥·유일성·중복(정적 자격은 itemShapeError 소관)
      const n9 = it.payload.node;
      const p9 = fileNodePathKey(n9.anchors[0].path);
      if (ids.has(n9.id)) { errs.push(tag + " add_node: 임시 id가 기존 topology id와 충돌"); idErr = true; return; }
      if (pendingNodeIds.has(n9.id)) { errs.push(tag + " add_node: 임시 id가 이번 결과 안에서 중복"); idErr = true; return; }
      if (existingFilePaths.has(p9)) { errs.push(tag + " add_node: 같은 파일의 file 노드 기존재(중복 노드 금지)"); idErr = true; return; }
      if (excerptSet && !excerptSet.has(p9)) { errs.push(tag + " add_node: anchor가 이번 발췌에 없음(발췌 밖 노드화 금지)"); return; }
      if (ctx && ctx.repo) {
        try {
          const rB = require(path.join(__dirname, "enrich-providers.js")).excerptBodyFor(ctx.repo, n9.anchors[0].path);
          if (!rB.ok || !rB.body.trim()) { errs.push(tag + " add_node: anchor 판독 불가·빈 본문(인용 원문 없음)"); return; }
        } catch { errs.push(tag + " add_node: anchor 판독 검사 실패"); return; }
      }
      pendingNodeIds.add(n9.id);
      existingFilePaths.add(p9); // 같은 결과 안 중복 경로도 차단
    }
  });
  { // §2-3 상한 — 라운드당(형태 규칙·fail-closed)+전체(조기 진단 — 권위는 정본 semanticValidateV2의 적용 잠금 안)
    const addN = obj.items.filter((it) => it && it.op === "add_node").length;
    const PM9 = (() => { try { return require(path.join(__dirname, "project-map.js")); } catch { return null; } })();
    if (PM9 && addN > PM9.ENRICH_ADD_NODE_PER_ROUND) errs.push("add_node 라운드 상한 초과(" + addN + ">" + PM9.ENRICH_ADD_NODE_PER_ROUND + ")");
    const existN = ((topo && topo.nodes) || []).filter((n) => n && n.entityType === "file").length;
    if (PM9 && addN && existN + addN > PM9.MAX_FILE_NODES) errs.push("file 노드 전체 상한 초과 예정(" + (existN + addN) + ">" + PM9.MAX_FILE_NODES + " — 조기 진단·권위는 적용 잠금 안 정본)");
  }
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
  // 해상도 설계 v3: ①add_node는 변환 시점에 anchor 판독을 재검사(응답 검증과 적용 사이 파일 소멸 —
  // 재개 경로 포함. conversion 재판독 관례와 동형) ②payload의 임시 id를 결정론 id로 재작성 — 매핑은
  // ctx.items(영속된 결과)의 순수 함수(applyEnrichPayloadIds — cursor 결속 검증과 같은 함수).
  if (item.op === "add_node") {
    const p9 = item.payload && item.payload.node && Array.isArray(item.payload.node.anchors) && item.payload.node.anchors[0] ? item.payload.node.anchors[0].path : null;
    const rB = p9 ? require(path.join(__dirname, "enrich-providers.js")).excerptBodyFor(ctx.repo, p9) : { ok: false, body: "" };
    if (!rB.ok || !rB.body.trim()) return { ok: false, kind: "schema", errors: ["add_node: anchor 판독 불가·빈 본문(변환 시점 재검사 — 인용 원문 없음)"] };
  }
  const payloadEff = Array.isArray(ctx.items) ? applyEnrichPayloadIds(ctx.items, index, ctx.topo.mapId) : item.payload;
  const base = {
    schema: "map-patch-v2", patchId: detPatchId(ctx.jobKey, ctx.attemptId, index, ctx.rev), mapId: ctx.topo.mapId,
    basis: MP.patchBasisFor(ctx.repo, ctx.topo), baseMapHash: PM.mapHashOf(ctx.topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, ctx.pol.pfh),
    baseDirtyFp: "", operation: item.op, payload: payloadEff, readSet: {},
    rationale: "P8 의미 보강(" + ctx.provider + ")", evidence: evFiles.map((f) => ({ kind: evidenceKindOf(f), ref: f })),
    provider: ctx.provider, // 충돌 감지 원천(P8-4 — decision에 patch 전문 영속=조회 가능)
    ...(ENRICH_TARGET_OPS.includes(item.op) || item.op === "rewrite_label" ? { targetId: item.targetId } : {}),
  };
  base.readSet = MP.buildReadSetFor(ctx.topo, base, { idx: ctx.idx, pol: ctx.pol, repoRoot: ctx.repo, fileHashOf: ctx.fileHashOf });
  // canonical 정렬은 '정본 함수'로 한 번에(사용자 실보고 2026-08-04 실사고): 여기서 evidence를 파일
  // 경로만으로 정렬해 두었는데 canonical 규칙은 (kind, ref, note) 순이라, 서로 다른 종류의 파일을
  // 함께 인용한 정상 답변마다 '집합 배열 정렬 위반'으로 거부돼 자동 보강이 사실상 멈췄다.
  // 정렬 규칙을 두 곳에 두면 또 갈라지므로, 조립이 끝난 patch에 canonicalPatchV2를 적용해 자기
  // 동일성을 만든 뒤 검증한다(patchId는 결정론 입력이라 불변).
  const PMx = require(path.join(__dirname, "project-map.js"));
  const canon = PMx.canonicalPatchV2(base);
  const PMv = PMx.validatePatchV2(canon);
  if (PMv.length) return { ok: false, kind: "schema", errors: PMv };
  return { ok: true, patch: canon };
}

// 답이 원천 불가능한 라운드 판정(2026-08-04 실사고 — 보류 반복의 4번째 원인): 근거 인용은 '전송한
// 발췌' 안에서만 인정되는데, 관문은 code/test/config 계열 증거 최소 1개를 요구한다. 판정 기준은 원시
// 변경 목록이 아니라 '실제로 발송될 발췌 파일'(검증 blocker — 필터·상한 20·앵커 폴백까지 프롬프트와
// 같은 함수 excerptFilesFor로 계산: 상한 밖 코드·민감 경로 코드·문서 앵커 폴백 반례 전부 커버).
// 발췌 0건=인용 가능한 원문 자체가 없음=불가. 판정 실패(예외)만 '답 가능' 취급(보수 — 억제는 확실할 때만).
function answerableInput(repo, topo, changed) {
  try {
    const EP = require(path.join(__dirname, "enrich-providers.js"));
    const files = EP.excerptFilesFor(topo, changed);
    if (!Array.isArray(files) || !files.length) return false;
    const kinds = require(path.join(__dirname, "project-map.js")).CODE_EVIDENCE_KINDS;
    // 이름(확장자)만으로는 부족(확인 검증 blocker): 삭제된 코드 파일은 발췌 본문이 "(판독 불가)"라
    // 인용할 원문이 없다 — 프롬프트와 같은 판독 규칙(excerptBodyFor)으로 '실제 인용 가능한' 코드
    // 계열 발췌가 최소 1개일 때만 답 가능. 빈 본문(0바이트)도 인용 불가라 제외.
    return files.some((f) => {
      if (!kinds.includes(evidenceKindOf(f))) return false;
      const r = EP.excerptBodyFor(repo, f);
      return r.ok && r.body.trim().length > 0;
    });
  } catch { return true; }
}

// ── 라우팅 로그(P8-5 — append-only·기록 실패=비차단) ─────────────────────────────
const ROUTE_LOG = path.join(BRIDGE_DIR, "stats", "map-route.jsonl");
const ROUTE_LOG_DAYS = 60;
function appendRouteLog(entry) {
  try {
    // P8-5 고정 필드(3b 1차 보완): 부재 필드는 null로 상시 채움 — 감사 행 형태 균일
    const fixed = { ts: null, repoKey: null, mapId: null, mode: null, configWs: null, slot: null, consentGen: null, readinessFp: null, corridor: null, changedCount: null, route: null, reason: null, escalated: null, outcome: null, provider: null, jobKey: null, trigger: null };
    if (!CL.appendLegacyMapRoute({ ...fixed, ...entry })) throw new Error("stats-lock-or-write");
  } catch (e) { try { process.stderr.write("[map-route] 로그 기록 실패(비차단): " + String(e && e.message) + "\n"); } catch { /* 무해 */ } }
}

// ── P10 자동 실행 기록(새 형식) ──────────────────────────────────────────────
function p10Trigger(v) { const s = String(v || ""); return s.startsWith("link:") ? "link" : ["consent", "retry", "probe", "tick", "cli", "link"].includes(s) ? s : "unknown"; }
function p10Provider(v) { return v === "self" ? "claude" : v === "economy" ? "deepseek" : v === "precision" ? "codex" : null; }
function p10Reason(result) {
  const r = String((result && result.reason) || "");
  if (!r && result && (result.outcome === "applied" || result.outcome === "settled")) return "none";
  if (r === "pipeline-wal") return "pipeline-blocked";
  if (r === "map-lock" || r.startsWith("topology-")) return "map-unavailable";
  if (r === "queue-stale") return "queue-stale";
  if (r.includes("deferred-damaged") || r.startsWith("deferred-result")) return "deferred-damaged";
  if (r === "deferred-retry" || r === "legacy-deferred-retry") return "deferred-retry";
  if (r.startsWith("job-damaged") || r === "attempt-state") return "job-damaged";
  if (r === "decision-index" || r === "policy-frontier") return "policy-unavailable";
  if (r === "parked") return "parked-existing";
  if (r === "consent-damaged" || r === "no-consent") return "consent-missing";
  if (r === "consent-stale") return "consent-stale";
  if (r === "invalid-mode") return "mode-invalid";
  if (r === "already-enriched") return "already-enriched";
  if (/^(job|attempt|results|cursor|done)-write/.test(r)) return "state-write-failed";
  if (r === "adapter-missing" || r.startsWith("adapter-missing:")) return "adapter-missing";
  // 실행기가 실패 종류를 이미 판정했으면 그 값을 쓴다(2026-07-29: 재개 경로에서 결과 거부가
  // 'provider-call-failed'로 기록돼, 호출은 됐는데 '못 불렀다'는 감사 기록이 남았다).
  if (result && typeof result._p10Reason === "string" && result._p10Reason) return result._p10Reason;
  if (result && result.outcome === "provider-failed") return "provider-call-failed";
  if (r === "run-lock-lost") return "lock-lost";
  if (r === "retry-exhausted" || r === "rev-exhausted") return "retry-exhausted";
  if (["no-verifier", "inconclusive", "uncertain-call", "resolution-out-of-scope"].includes(r)) return "resolution-pending";
  if (/^(expire|apply)-/.test(r)) return "apply-failed";
  if (result && result.outcome === "parked") return "route-parked";
  return "unknown";
}
function lastP10JobTerminal(repoKey, jobKey, jobRunId) {
  let raw = ""; try { raw = fs.readFileSync(CL.MAP_ROUTE_FILE, "utf8"); } catch { return null; }
  let last = null;
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try { const v = JSON.parse(ln); if (v.event === "enrich-job-terminal" && v.repoKey === repoKey && v.jobKey === jobKey && v.jobRunId === jobRunId && CL.validateMapAutomationV1(v)) last = v; } catch { /* skip */ }
  }
  return last;
}
function p10JobSnapshot(repo, ref, result) {
  const jr = readEnrichJob(repo), dr = readDeferred(repo);
  const current = jr.st === "ok" && jr.job.jobKey === ref.jobKey && jobRunIdOf(jr.job) === ref.jobRunId ? jr.job : null;
  const prior = lastP10JobTerminal(repoKeyFor(repo), ref.jobKey, ref.jobRunId);
  let baselineState = "unavailable", everApplied = null, unresolvedBaseItems = null;
  if (current) {
    baselineState = "current-job";
    const applied = new Set(), rejected = new Set();
    for (const a of current.attempts || []) {
      for (const id of ((a.cursor && a.cursor.appliedPatchIds) || [])) applied.add(id);
      for (const z of (a.resolutions || [])) if (z && z.verdict === "reject" && z.patchId) rejected.add(z.patchId);
    }
    if (dr.st === "ok") for (const d of dr.data.records || []) if (d.jobKey === ref.jobKey && d.jobRunId === ref.jobRunId) {
      if (d.terminalOutcome === "applied") applied.add(d.patchId);
      if (d.terminalOutcome === "rejected") rejected.add(d.patchId);
    }
    everApplied = applied.size > 0 || !!(prior && prior.everApplied === true);
    const last = [...(current.attempts || [])].reverse().find((a) => a.results && Array.isArray(a.results.items));
    if (result && result.jobKey === ref.jobKey && Number.isSafeInteger(result.investigationPending) && result.investigationPending >= 0) unresolvedBaseItems = result.investigationPending;
    else unresolvedBaseItems = last ? Math.max(0, last.results.items.length - applied.size - rejected.size) : 0;
  } else if (prior && (prior.baselineState === "current-job" || prior.baselineState === "prior-terminal")) {
    baselineState = "prior-terminal"; everApplied = prior.everApplied; unresolvedBaseItems = prior.unresolvedBaseItems;
  }
  let activeDeferredItems = null, deferredState = "unknown";
  if (dr.st === "damaged") deferredState = "damaged";
  else if (baselineState !== "unavailable") {
    const active = new Map();
    for (const d of dr.data.records || []) if (d.jobKey === ref.jobKey && d.jobRunId === ref.jobRunId && ["waiting", "calling", "answered", "uncertain"].includes(d.phase)) active.set(String(d.attemptId) + ":" + String(d.itemIndex), d);
    activeDeferredItems = active.size;
    deferredState = (unresolvedBaseItems || 0) + activeDeferredItems > 0 ? "pending" : "clear";
  }
  return { baselineState, everApplied, unresolvedBaseItems, activeDeferredItems, deferredState, _currentPhase: current ? current.phase : null, _provider: (() => {
    if (current && current.attempts && current.attempts.length) return p10Provider(current.attempts[current.attempts.length - 1].provider);
    return prior ? prior.provider : null;
  })() };
}
function appendP10Terminals(repo, ctx, result) {
  const reasonCode = ctx.reasonCode || p10Reason(result);
  const providers = new Set();
  for (const ref of ctx.affected.values()) {
    const s = p10JobSnapshot(repo, ref, result);
    const provider = p10Provider(result && result.provider) || s._provider;
    if (provider) providers.add(provider);
    const completedSummary = s.deferredState === "clear" && (s._currentPhase === "done" || p10Reason(result) === "deferred-retry");
    const outcome = completedSummary ? (s.everApplied ? "applied" : "settled") : result.outcome;
    const { _currentPhase, _provider, ...stored } = s;
    CL.appendMapAutomation({ schema: "map-automation-v1", event: "enrich-job-terminal", ts: new Date().toISOString(), repoKey: ctx.repoKey, runId: ctx.runId, jobKey: ref.jobKey, jobRunId: ref.jobRunId, mapId: ctx.mapId, mode: ctx.mode, trigger: ctx.trigger, outcome, reasonCode, provider, ...stored });
  }
  const directProvider = p10Provider(result && result.provider);
  const provider = directProvider || (providers.size === 1 ? [...providers][0] : null);
  CL.appendMapAutomation({ schema: "map-automation-v1", event: "enrich-run-terminal", ts: new Date().toISOString(), repoKey: ctx.repoKey, runId: ctx.runId, mapId: ctx.mapId, mode: ctx.mode, trigger: ctx.trigger, outcome: result.outcome, reasonCode, provider });
}

// ── historyless 변경 산출(P8-1 — 큐 v1 invSnap 대조) ─────────────────────────────
// 반환 string[](변경 상대경로)|null(산출 불가=corridor unknown). 규칙: 삭제=변경/신규=변경/메타 상이=변경
// (지문 생략 빠른 경로)/메타 동일=내용 sha1 대조(동일 메타 교체 검출).
function historylessChanges(repo, invSnap, MR) {
  if (!invSnap || !Array.isArray(invSnap.files)) return null; // 부재·상한 초과=unknown(정직)
  let now;
  try { now = MR.collectInventory(repo); } catch { return null; }
  // 기준선 뒤 현재 스캔도 전수 완료된 경우에만 변경 없음/mapped를 주장한다. 수집기가
  // 항목·깊이 상한에 닿으면 files는 정상 배열이어도 일부 목록이므로 unknown으로 보낸다.
  if (!now || !Array.isArray(now.files) || !now.cov || now.cov.scanComplete !== true) return null;
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
// f-4b69df7e 유물 재기반: 같은 내용(op·targetId·payload·evidence·rationale)을 '현 기준선'으로 재제안+분류+
// legacyReclass 표지(적용 실패 잔류 시 다음 실행 재소비). 유물 한정 — 정식 job 경로는 P8 rev 세대가 담당.
function rebaseLegacyPatch(repo, MP, PM, oldPatch, oldPid, markLegacy = true) {
  try {
    const MRl = require(path.join(__dirname, "map-runtime.js"));
    const rt = MRl.readTopoExFor(repo);
    if (rt.st !== "ok") return { ok: false, reason: "topo" };
    const topo = rt.topo;
    const idx = MP.decisionIndexFor(repo, topo.mapId);
    const pol = MP.policyStateFor(repo, topo.mapId);
    if (idx.st === "error" || pol.st !== "ok") return { ok: false, reason: "ctx" };
    const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
    const np = {
      schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
      basis: MP.patchBasisFor(repo, topo), baseMapHash: PM.mapHashOf(topo),
      baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
      baseDirtyFp: "", operation: oldPatch.operation, payload: oldPatch.payload, readSet: {},
      rationale: oldPatch.rationale || "legacy-rebase", evidence: oldPatch.evidence || [],
      ...(oldPatch.targetId ? { targetId: oldPatch.targetId } : {}), ...(oldPatch.targetIds ? { targetIds: oldPatch.targetIds } : {}),
      ...(oldPatch.provider ? { provider: oldPatch.provider } : {}), ...(oldPatch.detectedBy ? { detectedBy: oldPatch.detectedBy } : {}),
    };
    np.readSet = MP.buildReadSetFor(topo, np, { idx, pol, repoRoot: repo, fileHashOf: (ref) => { try { return sha1(fs.readFileSync(path.join(repo, ref), "utf8")); } catch { return null; } } });
    const pr = MP.proposePatch(repo, np);
    if (!pr.ok) return { ok: false, reason: "propose" };
    const cf = MP.classifyPatch(repo, topo.mapId, np.patchId);
    if (!cf.ok || cf.classification !== "verifier-resolved") return { ok: false, reason: "classify" };
    // 표지+계보(원자·nsLock — pipeline 정본): 신본이 구 유물을 가리키게(rebasedFrom) — 스윕이 구를 재소비에서
    // 제외·만료 재시도하고, 신본은 미해소 잔류 시 다음 실행 재소비(내구 수렴 — 재재재검증 B2).
    if (markLegacy) {
      const mk = MP.markLegacyReclassMark(repo, topo.mapId, np.patchId, oldPid || null);
      if (!mk.ok) return { ok: false, reason: "mark-" + (mk.reason || "failed") };
    }
    return { ok: true, patch: np };
  } catch { return { ok: false, reason: "exception" }; }
}
function transferDeferredRebase(repo, oldRec, patch, PM) {
  const now = new Date().toISOString(), opHash = PM.opHashOf(patch); let made = null;
  const w = updateDeferred(repo, (d) => {
    const oi = d.records.findIndex((x) => x.patchId === oldRec.patchId);
    const ni = d.records.findIndex((x) => x.patchId === patch.patchId);
    if (ni >= 0) { made = d.records[ni]; return null; }
    if (oi < 0) return null;
    const old = d.records[oi];
    const next = { ...old, patchId: patch.patchId, opHash, phase: "waiting", reason: "cas-stale", callToken: undefined, callTrigger: undefined, resolution: undefined, rebasedFrom: old.patchId, createdAt: now, updatedAt: now };
    const records = [...d.records]; records[oi] = { ...old, phase: "stale", reason: "cas-stale", resolution: undefined, callToken: undefined, callTrigger: undefined, updatedAt: now }; records.push(next); made = next;
    return { ...d, records };
  });
  return w.ok && made ? { ok: true, record: made } : { ok: false, reason: w.reason || "transfer" };
}

// deferred 재시도는 일반 tick이 열지 않는다. answered는 외부 호출 없이 적용/폐기만 이어가므로 매 실행에서
// 안전하게 배수하고, waiting/uncertain은 사용자 retry 또는 새 verifier 연결 세대에서만 새 호출을 연다.
function retryDeferredResolutions(repo, o, env, topo, triggerKind, linkGeneration) {
  const { MP, PM } = env; const before = deferredSummary(repo, topo.mapId);
  if (before.st !== "ok") return { handled: 0, applied: 0, settled: 0, awaiting: null, error: "deferred-damaged" };
  let handled = 0, applied = 0, settled = 0;
  for (let rec of before.records) {
    const pf = path.join(MP.dirsFor(repo, topo.mapId).pending, rec.patchId + ".json");
    let pr = null; try { pr = JSON.parse(fs.readFileSync(pf, "utf8")); } catch { continue; }
    if (!pr || !pr.patch || PM.opHashOf(pr.patch) !== rec.opHash) { if (env.p10) env.p10.touch(rec.jobKey, rec.jobRunId); settleDeferred(repo, rec.patchId, "stale", "cas-stale"); continue; }
    if (["resolved", "resolved-noop", "expired"].includes(pr.lifecycle)) {
      if (env.p10) env.p10.touch(rec.jobKey, rec.jobRunId);
      if (pr.lifecycle === "expired" && pr.expireCode === "cas-stale") settleDeferred(repo, rec.patchId, "stale", "cas-stale");
      else settleDeferred(repo, rec.patchId, "settled", "settled", pr.lifecycle === "expired" ? "rejected" : "applied");
      settled++; continue;
    }
    if (pr.lifecycle !== "classified" || pr.classification !== "verifier-resolved") continue;

    // 기준선이 이미 바뀌었으면 구 판정을 받기 전에 신본을 먼저 만든다. 구 판정은 신본에 재사용하지 않는다.
    let patch = pr.patch;
    try {
      const idx = MP.decisionIndexFor(repo, topo.mapId), pol = MP.policyStateFor(repo, topo.mapId);
      if (idx.st === "ok" && pol.st === "ok") {
        const ah = MP.authorityOf(PM.mapHashOf(require(path.join(__dirname, "map-runtime.js")).readTopoExFor(repo).topo), idx).ah;
        const dch = PM.decisionContextHashOf(ah, pol.pfh);
        if (patch.baseDecisionContextHash !== dch) {
          const rb = rebaseLegacyPatch(repo, MP, PM, patch, rec.patchId, false);
          if (!rb.ok) { settleDeferred(repo, rec.patchId, "stale", "cas-stale"); continue; }
          const tr = transferDeferredRebase(repo, rec, rb.patch, PM); if (!tr.ok) continue;
          MP.expirePendingPatch(repo, topo.mapId, rec.patchId, rec.opHash);
          rec = tr.record; patch = rb.patch;
        }
      }
    } catch { continue; }

    let resolution = rec.phase === "answered" ? rec.resolution : null;
    if (!resolution) {
      const selected = triggerKind === "manual" || (triggerKind === "link" && rec.reason === "no-verifier") || (triggerKind === "initial" && rec.history.length === 0);
      if (!selected) continue;
      if (env.p10) env.p10.touch(rec.jobKey, rec.jobRunId);
      const beg = beginDeferredCall(repo, rec, triggerKind, linkGeneration);
      if (!beg.ok || beg.action === "conflict") continue;
      if (beg.action === "answered") resolution = beg.record && beg.record.resolution;
      else if (beg.action !== "call") continue;
      else {
        let raw = null, callThrew = false, existing = null;
        if (rec.framing === "conflict") existing = existingDecisionOf(repo, require(path.join(__dirname, "map-runtime.js")).readTopoExFor(repo).topo, patch.targetId);
        if (typeof o.askVerifier === "function") { try { raw = o.askVerifier({ repo, ws: o.ws, patch, item: null, framing: rec.framing, existing, usageContext: env.p10 ? env.p10.usage(rec.jobKey, rec.jobRunId) : null }); } catch { callThrew = true; raw = null; } }
        const outcome = callThrew ? "uncertain-call" : raw && raw.verdict === "inconclusive" ? "inconclusive" : raw && ["support", "reject"].includes(raw.verdict) ? raw.verdict : "no-verifier";
        const rr = raw && ["support", "reject"].includes(raw.verdict) ? { patchId: patch.patchId, opHash: PM.opHashOf(patch), baseDecisionContextHash: patch.baseDecisionContextHash, verdict: raw.verdict, claims: Array.isArray(raw.claims) ? raw.claims : [] } : null;
        const fin = finishDeferredCall(repo, patch.patchId, beg.token, outcome, rr); handled++;
        if (!fin.ok) return { handled, applied, settled, awaiting: null, error: fin.reason || "deferred-result" };
        if (!rr) continue; resolution = rr;
      }
    }
    if (!resolution) continue;
    if (env.p10) env.p10.touch(rec.jobKey, rec.jobRunId);
    if (resolution.verdict === "reject") {
      const ex = MP.expirePendingPatch(repo, topo.mapId, patch.patchId, PM.opHashOf(patch));
      if (ex.ok || ex.reason === "idempotent" || ex.reason === "already-applied") { settleDeferred(repo, patch.patchId, "settled", "settled", ex.reason === "already-applied" ? "applied" : "rejected"); settled++; }
      continue;
    }
    const ap = MP.applyPatch(repo, topo.mapId, patch.patchId, { preCutover: true, verifierResolution: resolution });
    if (ap.ok || ap.reasonCode === "already-applied") { settleDeferred(repo, patch.patchId, "settled", "settled", "applied"); applied++; settled++; continue; }
    if (ap.reasonCode === "wal-active") { try { MP.recoverWal(repo, topo.mapId); } catch { /* next run drains answered */ } }
    if (ap.reasonCode === "cas-stale") {
      const rb = rebaseLegacyPatch(repo, MP, PM, patch, patch.patchId, false);
      if (rb.ok) { const tr = transferDeferredRebase(repo, rec, rb.patch, PM); if (!tr.ok) settleDeferred(repo, patch.patchId, "stale", "cas-stale"); }
      else settleDeferred(repo, patch.patchId, "stale", "cas-stale");
    }
  }
  const after = deferredSummary(repo, topo.mapId);
  return { handled, applied, settled, awaiting: after.awaiting };
}
// [ab-6 일반화(9차 종결)] 실행 소유권 아래의 '모든' 장부 기록은 잠금 안 재검증을 지나야 한다.
// 지점별 사전 fence는 검사~기록 사이 창이 남는다(8차 계보) — 새 소유자의 유해 기록(park·새 attempt)은
// 전부 같은 job-lock을 지나므로, 잠금 보유 중 재검증이면 그 선행이 반드시 관측된다. 상실=무기록
// (fenceLost — 호출자는 busy 물러남·park 통지 금지). fenceFn 부재(사전 단계)=종전 동작.
function fencedUpdateEnrichJob(repo, fenceFn, mut) {
  let lost = false;
  const w = updateEnrichJob(repo, (j) => { if (typeof fenceFn === "function" && !fenceFn()) { lost = true; return null; } return mut(j); });
  return lost ? { ok: false, reason: "run-lock-lost", fenceLost: true } : w;
}
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
  const fenceBox = { f: null }; // 실행 잠금 획득 후 채워짐 — 사전 단계 park는 종전 동작(잠금 권위 없음)
  const park = (jobMut, reason, extra) => {
    if (fenceBox.f && !fenceBox.f()) return { outcome: "busy", reason: "run-lock-lost" }; // 상실=기록·통지 금지(9차)
    if (jobMut) { const wP = fencedUpdateEnrichJob(repo, fenceBox.f, jobMut); if (wP.fenceLost) return { outcome: "busy", reason: "run-lock-lost" }; }
    log({ route: "park", reason, outcome: "parked", ...(extra || {}) });
    // 사용자 실보고(2026-08-04): 자동 보강이 스스로 멈춰도 상태바·경보 어디에도 안 떠서, 사용자는
    // 대시보드의 특정 줄을 열어보기 전에는 '지도 자동화가 멈춘 것'을 알 방법이 없었다. 스스로 멈춘
    // 사실은 스스로 알려야 한다 — 무결성 채널(노랑)에 1건 기록(같은 ws의 직전 보강 경보는 대체).
    notifyEnrichParked(String(o.ws || repo), reason);
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
  // ② 실행 잠금(repo당 동시 1 — 획득·사망 회수·fence는 acquireEnrichRunLock 단일 경로: 죽은 job-잠금
  //    회수(reclaimDeadJobLock)와 같은 검증된 절차를 공유한다 — 5차 재확인 종결)
  const acq9 = acquireEnrichRunLock(repo);
  if (!acq9.ok) return { outcome: "busy", reason: acq9.reason };
  const p10RunId = acq9.p10RunId;
  const fence = acq9.fence;
  fenceBox.f = fence; // park 경로도 같은 소유 검증을 공유(9차)
  try {
    if (!fence()) return { outcome: "busy", reason: "run-lock-lost" }; // 2차 blocker⑧: 회수 경합 뒤 임계구역 소유 재검증
    const startJob = readEnrichJob(repo);
    const startJobRunId = startJob.st === "ok" ? jobRunIdOf(startJob.job) : null;
    const p10 = {
      repoKey: rKey, runId: p10RunId, mapId: queue.mapId, mode: o.mode, trigger: p10Trigger(o.trigger), affected: new Map(), reasonCode: null,
      touch(jobKey, jobRunId) { if (FP_RE.test(String(jobKey || "")) && FP_RE.test(String(jobRunId || ""))) this.affected.set(jobRunId, { jobKey, jobRunId }); },
      usage(jobKey, jobRunId) { return { repoKey: rKey, runId: p10RunId, jobKey: jobKey || null, jobRunId: jobRunId || null }; },
    };
    CL.appendMapAutomation({ schema: "map-automation-v1", event: "enrich-start", ts: new Date().toISOString(), repoKey: rKey, runId: p10RunId, jobKey: startJobRunId ? startJob.job.jobKey : null, jobRunId: startJobRunId, mapId: queue.mapId, mode: o.mode, trigger: p10.trigger });
    // 이전 프로세스가 verifier 호출 시작을 기록한 뒤 결과를 못 남기고 죽은 경우 자동 재호출하지 않는다.
    const dr9 = recoverDeferredCalls(repo);
    let result;
    if (!dr9.ok) result = { outcome: "parked", reason: dr9.reason || "deferred-damaged" };
    else result = runEnrichLocked(repo, o, { MR, MP, PM, MB, MRt, queue, log, park, fence, p10 });
    // P9: enrich 본체 결과·job 원장은 불변으로 둔 채, 종료 뒤 정책 위임 스윕을 정확히 한 번 후행한다.
    // 실패는 P9 항목별 원장에 남고 P8의 outcome을 바꾸지 않는다. 요약은 기존 route log에 한 줄만 보탠다.
    if (dr9.ok) try {
      const MI = require(path.join(__dirname, "map-intent.js"));
      MI.sweepIntentAuto(repo, queue.mapId, {
        ws: o.ws || repo,
        log: (line, sweep) => log({ route: "intent-auto", reason: line, outcome: sweep && sweep.outcome || "unknown" }),
      });
    } catch (e) {
      log({ route: "intent-auto", reason: "exception:" + String(e && e.message || e).slice(0, 80), outcome: "partial" });
    }
    appendP10Terminals(repo, p10, result);
    return result;
  } finally {
    acq9.release(); // HELD_RUN_LOCKS 정리 포함(자기 토큰 확인 후 해제 — 종전과 동일 규칙)
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
  if (topo.mapId !== queue.mapId) return { outcome: "noop", reason: "queue-stale" }; // 다른 지도 세대의 큐는 사용하지 않음
  // 확인 대기 항목은 보강 작업 파일과 분리해 처리한다. 일반 tick은 저장된 답만 마무리하고
  // 외부 검증을 다시 부르지 않는다. 사용자의 재시도 또는 새 검증 연결 세대만 새 호출을 허용한다.
  const trigger9 = String(o.trigger || "");
  const retryKind9 = trigger9 === "retry" ? "manual" : trigger9.startsWith("link:") ? "link" : null;
  const linkGeneration9 = retryKind9 === "link" ? trigger9.slice(5) : "";
  const deferredRun9 = retryDeferredResolutions(repo, o, env, topo, retryKind9, linkGeneration9);
  if (deferredRun9.error) return park(null, deferredRun9.error);
  if (deferredRun9.handled || deferredRun9.applied || deferredRun9.settled) {
    log({ route: "deferred", reason: retryKind9 || "drain", outcome: deferredRun9.applied ? "applied" : "settled", detail: JSON.stringify(deferredRun9) });
    return { outcome: deferredRun9.applied ? "applied" : "noop", reason: "deferred-retry", ...deferredRun9 };
  }
  if (PM.mapHashOf(topo) !== queue.mapHash) return { outcome: "noop", reason: "queue-stale" }; // 일반 보강은 bootstrap이 큐를 갱신한 뒤 진행
  // P9 v12 개정 ②(ⓒ): 구 기본분류 시절의 '비정책 intent-choice' pending을 재분류+P8 해소 경로로 재결속
  // (재재검증 blocker① ab-6 — 재분류만 하면 cursor가 이미 전진한 유물이라 아무도 재소비하지 않아 영구 잔존).
  // 유물도 같은 확인 대기 장부로 옮긴다. 일반 tick마다 verifier를 다시 부르던 옛 예외는 제거한다.
  let legacyDeferredAdded9 = 0;
  try {
    const sw9 = MP.sweepReclassifyNonPolicyIntentChoice(repo, topo.mapId);
    if (sw9.errors) log({ route: "legacy-reclass", reason: "sweep-errors", outcome: "error", detail: String(sw9.errors) });
    for (const pid9 of sw9.resolveIds || []) {
      let oc9 = "deferred";
      try {
        const pf9 = path.join(MP.dirsFor(repo, topo.mapId).pending, pid9 + ".json");
        const pr9 = JSON.parse(fs.readFileSync(pf9, "utf8"));
        const expiredStale9 = pr9.lifecycle === "expired" && pr9.expireCode === "cas-stale" && pr9.legacyReclass === true;
        if (pr9.lifecycle !== "classified" && !expiredStale9) { oc9 = "already-settled"; }
        else {
          let target9 = { pid: pid9, patch: pr9.patch };
          const rt9 = require(path.join(__dirname, "map-runtime.js")).readTopoExFor(repo);
          const idx9 = rt9.st === "ok" ? MP.decisionIndexFor(repo, rt9.topo.mapId) : { st: "error" };
          const pol9 = rt9.st === "ok" ? MP.policyStateFor(repo, rt9.topo.mapId) : { st: "error" };
          const dch9 = idx9.st === "ok" && pol9.st === "ok" ? PM.decisionContextHashOf(MP.authorityOf(PM.mapHashOf(rt9.topo), idx9).ah, pol9.pfh) : null;
          if (expiredStale9 || (dch9 && pr9.patch.baseDecisionContextHash !== dch9)) {
            const rb9 = rebaseLegacyPatch(repo, MP, PM, pr9.patch, pid9);
            if (!rb9.ok) { oc9 = "rebase-" + (rb9.reason || "failed"); target9 = null; }
            else {
              MP.expirePendingPatch(repo, topo.mapId, pid9, PM.opHashOf(pr9.patch));
              target9 = { pid: rb9.patch.patchId, patch: rb9.patch };
            }
          }
          if (target9) {
            const legacyKey9 = sha1("legacy|" + topo.mapId + "|" + target9.pid);
            const ew9 = ensureDeferredWaiting(repo, { mapId: topo.mapId, patchId: target9.pid, opHash: PM.opHashOf(target9.patch), jobKey: legacyKey9, jobRunId: sha1("legacy-run|" + legacyKey9), attemptId: 0, itemIndex: 0, framing: "resolution" }, "no-verifier");
            if (!ew9.ok) oc9 = "deferred-" + (ew9.reason || "write");
            else { if (ew9.created) legacyDeferredAdded9++; oc9 = "deferred"; }
          }
        }
      } catch { oc9 = "error"; }
      log({ route: "legacy-reclass", reason: "resolve", outcome: oc9, patchId: pid9 });
    }
    if (sw9.reclassified) log({ route: "legacy-reclass", reason: "swept", outcome: "reclassified", detail: sw9.reclassified + "/" + sw9.scanned });
  } catch (eS9) { log({ route: "legacy-reclass", reason: "sweep-failed", outcome: "error", detail: String((eS9 && eS9.message) || eS9).slice(0, 120) }); }
  if (legacyDeferredAdded9) {
    const legacyRetry9 = retryDeferredResolutions(repo, o, env, topo, retryKind9 || "initial", linkGeneration9);
    if (legacyRetry9.error) return park(null, legacyRetry9.error);
    if (legacyRetry9.handled || legacyRetry9.applied || legacyRetry9.settled) return { outcome: legacyRetry9.applied ? "applied" : "noop", reason: "legacy-deferred-retry", ...legacyRetry9 };
  }
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
  // ⑦a 변경 산출·corridor·소스 지문(⑥ 복구보다 먼저 — 3차 blocker⑤: 복구·재개도 라우팅 재료가 필요)
  let changed = null;
  // 입력 계산 시점의 HEAD를 '한 번만' 캡처(검증 blocker 2회차 — 완료 시점 재판독도, 확장 함수의 자체
  // 재조회도 금지): 이 값 하나가 ①커밋 delta의 끝점 ②done의 소화 기준점 기록에 함께 결속된다. 두 조회로
  // 나누면 그 사이에 낀 커밋이 발췌 없이 소화 처리된다.
  let srcHead = null;
  try {
    if (queue.basis && queue.basis.kind === "git") {
      const { spawnSync: spH } = require("child_process");
      const ghH = spH("git", ["-c", "safe.directory=*", "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const hH = ghH.status === 0 ? String(ghH.stdout || "").trim() : "";
      if (/^[0-9a-f]{40}$/.test(hH)) srcHead = hH;
    }
  } catch { /* 캡처 실패=확장·기준점 기록 모두 생략(보수 — 다음 라운드가 다시 먹는다) */ }
  try {
    if (queue.basis && queue.basis.kind === "git") {
      const MRd = require(path.join(__dirname, "map-reader.js"));
      const g9 = MRd.gitChangedEx(repo, { untrackedAll: true }); // 4차 blocker②: -uall — 미추적 디렉터리 내부 파일 열거
      changed = g9 && g9.ok && !g9.truncated ? (g9.paths || []).filter((f) => !String(f).replace(/\\/g, "/").startsWith("project-map/")) : null; // 2차 blocker⑥: paths·truncated=unknown·자체 산출물 제외
      changed = expandChangedWithConsumedDelta(repo, changed, srcHead); // 기준점 교체(2026-08-04): 소화 기준점 이후~srcHead까지의 커밋 변경 합류(끝점 고정)
    } else changed = historylessChanges(repo, queue.invSnap, MR);
  } catch { changed = null; }
  const proj = { ok: true, source: "v2", nodes: topo.nodes || [] }; // corridor 판정 입력(node 소속만 — 같은 캡처 세트)
  const corridor = MRt.corridorOf(proj, changed);
  const srcFp = computeSourceFp(repo, queue, changed, MR);
  // ⑥ 멱등·복구 우선(수렴은 ⑦b — 설계 v11: authority 단독 결속은 자기 재보강/외부 억제 양쪽 실패라 폐기)
  if (jr.st === "ok") {
    const j = jr.job;
    if (j.phase === "open") { if (env.p10) env.p10.touch(j.jobKey, jobRunIdOf(j)); return resumeJob(repo, o, env, j, { topo, idx, pol, ah, corridor, changed, srcFp, srcHead }); } // 미완 복구가 신규보다 항상 우선
    if (j.jobKey === jobKey && j.phase === "parked") {
      // 3차 blocker⑤: consent-stale park는 '새 grant 세대'가 생기면 같은 job의 새 attempt로 자동 재개(v10 P8-2)
      if (j.parkedReason === "consent-stale") {
        const cR = readEnrichConsent(repo);
        const gR = findGrant(cR, j.configWs, j.slot); // 동결 주체 기준(ab-1)
        const lastGen = j.attempts.length ? j.attempts[j.attempts.length - 1].consentGen : 0;
        const eligible = j.mode === "self" ? !!(gR && gR.selfAuto) : !!(gR && gR.paidMode === j.mode);
        if (cR.st === "ok" && eligible && gR.gen > lastGen) {
          const wRe = fencedUpdateEnrichJob(repo, env.fence, (jj) => { if (!jj || jj.phase !== "parked") return null; const nx = { ...jj, phase: "open" }; delete nx.finishedAt; delete nx.parkedReason; return nx; });
          if (wRe.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
          if (wRe.ok && !wRe.unchanged) { if (env.p10) env.p10.touch(wRe.job.jobKey, jobRunIdOf(wRe.job)); return resumeJob(repo, o, env, wRe.job, { topo, idx, pol, ah, corridor, changed, srcFp, srcHead }); }
        }
      }
      // 입력 자기치유(2026-08-04 보류 반복 봉합 — consent-stale 자기 재개와 같은 관용구):
      // ⓐ '문서·산출물뿐' 사유로 멈춘 job은 코드 변경이 생기면 사람 없이 재개하고, 여전히 불가능하면
      //    조용히 대기한다(같은 사유 재경보 없음). ⓑ 답 거부로 멈췄는데 지금 입력이 원천 불가능해졌다면
      //    사유를 정확한 것으로 바꿔 단다(재시도·자동재시도가 과금만 하고 또 실패할 상태 — 알림도 교체).
      if (j.parkedReason === "input-doc-only") {
        if (answerableInput(repo, topo, changed)) {
          // retryFrom 이동=수동 '다시 시도' 버튼과 같은 규칙 — 과거 실패 플래그가 재개 즉시 같은 park로
          // 되돌리는 것 방지(입력이 바뀌었으니 이전 거부는 이 재개의 근거가 아니다).
          const wIn = fencedUpdateEnrichJob(repo, env.fence, (jj) => { if (!jj || jj.phase !== "parked" || jj.parkedReason !== "input-doc-only") return null; const nx = { ...jj, phase: "open", retryFrom: Array.isArray(jj.attempts) ? jj.attempts.length : 0 }; delete nx.finishedAt; delete nx.parkedReason; return nx; });
          if (wIn.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
          if (wIn.ok && !wIn.unchanged) {
            log({ route: "input-heal", reason: "code-changes-arrived", outcome: "resumed", jobKey: j.jobKey });
            if (env.p10) env.p10.touch(wIn.job.jobKey, jobRunIdOf(wIn.job));
            return resumeJob(repo, o, env, wIn.job, { topo, idx, pol, ah, corridor, changed, srcFp, srcHead });
          }
        }
        return { outcome: "noop", reason: "parked", parkedReason: "input-doc-only" };
      }
      // 준비 자기치유(2026-08-12 사용자 실보고 — 자동 재점검 캠페인의 마지막 고리): '담당 미준비'로 멈춘
      // job은 준비가 회복되면(자동 재점검 성공·설정 복귀 이력 복원) 사람 없이 재개한다 — consent-stale
      // 자기 재개와 같은 관용구. 준비 상태는 이 프로세스가 방금 산출한 P7 뷰(o.readiness)로 판정하므로
      // 재개는 실제 준비 회복 사건을 전제한다(여전히 미준비면 조용히 대기 — 재과금 0·재경보 0).
      // retryFrom 이동=수동 '다시 시도'와 같은 규칙(과거 park 표지가 재개를 즉시 같은 park로 되돌리는 것 방지).
      const NOT_READY_REASONS = { "precision-not-ready": "precisionReady", "economy-not-ready": "economyReady", "auto-not-ready": "autoReady" };
      const rdKey = NOT_READY_REASONS[String(j.parkedReason || "")];
      if (rdKey) {
        if (o.readiness && o.readiness[rdKey] === true) {
          const wRd = fencedUpdateEnrichJob(repo, env.fence, (jj) => { if (!jj || jj.phase !== "parked" || !NOT_READY_REASONS[String(jj.parkedReason || "")]) return null; const nx = { ...jj, phase: "open", retryFrom: Array.isArray(jj.attempts) ? jj.attempts.length : 0 }; delete nx.finishedAt; delete nx.parkedReason; return nx; });
          if (wRd.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
          if (wRd.ok && !wRd.unchanged) {
            log({ route: "ready-heal", reason: "readiness-recovered", outcome: "resumed", jobKey: j.jobKey, parkedReason: j.parkedReason || "" });
            if (env.p10) env.p10.touch(wRd.job.jobKey, jobRunIdOf(wRd.job));
            return resumeJob(repo, o, env, wRd.job, { topo, idx, pol, ah, corridor, changed, srcFp, srcHead });
          }
        }
        return { outcome: "noop", reason: "parked", parkedReason: j.parkedReason || "" };
      }
      const ANSWER_REJECTED_REASONS = ["precision-failed", "economy-failed", "both-failed", "self-failed"];
      if (ANSWER_REJECTED_REASONS.includes(String(j.parkedReason || "")) && !answerableInput(repo, topo, changed)) {
        const wTr = fencedUpdateEnrichJob(repo, env.fence, (jj) => { if (!jj || jj.phase !== "parked" || jj.parkedReason === "input-doc-only") return null; return { ...jj, parkedReason: "input-doc-only" }; });
        if (wTr.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
        if (wTr.ok && !wTr.unchanged) {
          log({ route: "input-heal", reason: "rediagnosed-doc-only", outcome: "parked", jobKey: j.jobKey, parkedReason: j.parkedReason || "" });
          notifyEnrichParked(String(j.configWs || o.ws || repo), "input-doc-only");
        }
        return { outcome: "noop", reason: "parked", parkedReason: "input-doc-only" };
      }
      // 자동 재시도 1회(사용자 결정 2026-08-04): 담당이 실제로 답을 냈는데 그 답이 거부돼 멈춘 경우는
      // 다시 물으면 다른 답이 나올 수 있다. 그래서 '같은 입력이라도 딱 한 번'은 스스로 다시 시도한다.
      // 한도 관리는 retryFrom 재사용 — 이 값이 있으면 이미 한 번(자동이든 수동이든) 재시도한 것이므로
      // 자동은 더 이상 걸리지 않는다(무한 재과금 차단). 사용자는 '다시 시도' 버튼으로 언제든 더 할 수 있다.
      // 입력·설정 문제(동의·큐 손상·미준비·어댑터 부재 등)는 다시 물어도 같은 결과라 대상이 아니다.
      // 대상은 '답이 도착했는데 그 답이 거부된' 경우뿐(확인 검증 blocker): 호출 자체가 실패한
      // 경우(failureStage="call" — 프로세스 사망·어댑터 예외)는 다시 불러도 같은 환경 문제일 공산이
      // 크고, 사용자가 정한 범위("답변이 거부돼 멈췄을 때")도 아니다 → 수동 재시도로만.
      const AUTO_RETRY_REASONS = ["precision-failed", "economy-failed", "both-failed"];
      const lastAtt = Array.isArray(j.attempts) && j.attempts.length ? j.attempts[j.attempts.length - 1] : null;
      // 답이 도착한 뒤 거부된 단계 전부: response(형식)·validation(근거 대조)·conversion(변환·근거
      // 재판독). call만 제외한다(확인 검증 blocker — conversion 누락으로 정작 그 경로가 재시도 밖이었다).
      const answerRejected = !!lastAtt && ["response", "validation", "conversion"].includes(String(lastAtt.failureStage || ""));
      if (AUTO_RETRY_REASONS.includes(String(j.parkedReason || "")) && answerRejected && !Number.isInteger(j.retryFrom)) {
        const wAr = fencedUpdateEnrichJob(repo, env.fence, (jj) => {
          if (!jj || jj.phase !== "parked" || Number.isInteger(jj.retryFrom)) return null; // 경합 시 한쪽만 성공
          const nx = { ...jj, phase: "open", retryFrom: Array.isArray(jj.attempts) ? jj.attempts.length : 0 };
          delete nx.finishedAt; delete nx.parkedReason;
          return nx;
        });
        if (wAr.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
        if (wAr.ok && !wAr.unchanged) {
          log({ route: "auto-retry", reason: "parked-once", outcome: "resumed", jobKey: j.jobKey, parkedReason: j.parkedReason || "" });
          if (env.p10) env.p10.touch(wAr.job.jobKey, jobRunIdOf(wAr.job));
          return resumeJob(repo, o, env, wAr.job, { topo, idx, pol, ah, corridor, changed, srcFp, srcHead });
        }
      }
      return { outcome: "noop", reason: "parked", parkedReason: j.parkedReason || "" }; // 그 외=명시 재시도 버튼이 해제
    }
  }
  // ⑦ 동의·라우팅
  const consent = readEnrichConsent(repo);
  if (consent.st !== "ok") return park(null, "consent-damaged");
  const grant = findGrant(consent, o.ws, o.slot);
  const mode = o.mode;
  if (!["self", "economy", "precision", "auto"].includes(mode)) return park(null, "invalid-mode");
  if (mode === "self" ? !(grant && grant.selfAuto) : !(grant && grant.paidMode === mode)) return park(null, grant ? "consent-stale" : "no-consent");
  // ⑦b 수렴(설계 v11): done job의 sourceFp(소비한 소스 상태 지문)와 현재 지문이 같으면 외부 변경 0=
  // 자기 산물 noop. 소스가 바뀌면(파일 내용·집합) 지문이 달라져 재보강 — authority 무관(입력 결속).
  // 설계 v11: done 멱등=(jobKey AND sourceFp) 복합 — 같은 jobKey여도 소스가 바뀌면 재보강·jobKey가 달라도
  // 소스 지문이 같으면(자기 적용 산물) noop. sourceFp 산출 불가(null)=수렴 생략(재실행 허용 쪽 보수).
  if (jr.st === "ok" && jr.job.phase === "done" && srcFp !== null && jr.job.sourceFp === srcFp) return { outcome: "noop", reason: "already-enriched" };
  if (jr.st === "ok" && jr.job.phase === "done" && jr.job.jobKey === jobKey && srcFp === null && jr.job.sourceFp === undefined) return { outcome: "noop", reason: "already-enriched" }; // 폴백은 '둘 다' 산출 불가·기록 부재일 때만(AND — 6차: 한쪽이라도 지문이 있으면 대조 불가=보수적으로 재실행 허용)
  // 답이 원천 불가능한 신규 라운드는 job조차 만들지 않는다(호출 0·park 0·경보 0 — 코드 변경이 오면
  // 다음 tick의 새 라운드가 자연 진행. 위 parked/resume 경로보다 뒤라 기존 job 복구는 방해하지 않음).
  if (!answerableInput(repo, topo, changed)) {
    log({ route: "skip", reason: "input-doc-only", outcome: "noop", changedCount: Array.isArray(changed) ? changed.length : null });
    return { outcome: "noop", reason: "input-doc-only" };
  }
  // ⑧ 신규 job 생성+attempt 루프(라우터 재호출·승격 1회)
  const nowIso = () => new Date().toISOString();
  const mk = fencedUpdateEnrichJob(repo, env.fence, (cur) => {
    if (cur && cur.phase === "open") return null; // 경합 — resume 소관(무변경)
    return { schema: "enrich-job-v2", jobKey, mapId: topo.mapId, authorityHash: ah, decisionContextHash: null, mode, configWs: CL.normWs(o.ws || ""), slot: o.slot === "en" ? "en" : "ko", phase: "open", startedAt: nowIso(), attempts: [] };
  });
  if (!mk.ok) return park(null, "job-write:" + mk.reason);
  if (env.p10 && mk.job) env.p10.touch(mk.job.jobKey, jobRunIdOf(mk.job));
  return driveAttempts(repo, o, env, { topo, idx, pol, ah, jobKey, corridor, changed, srcFp, srcHead, grant, consent });
}

// 소스 상태 지문(blocker⑤ — 수렴 입력): git=head+변경 파일 현재 내용 sha1 / historyless=inventory 전체
// {path, 내용 sha1}. 산출 불가=null(수렴 판정 생략 — 보수: noop이 아니라 재실행 허용 쪽).
function computeSourceFp(repo, queue, changed, MR) {
  try {
    if (queue.basis && queue.basis.kind === "git") {
      const { spawnSync } = require("child_process");
      const g = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const head = g.status === 0 ? String(g.stdout || "").trim() : null;
      if (!head) return null;
      let list = changed;
      if (!Array.isArray(list)) { // 재개 done 등 산출 미보유 경로=여기서 재산출(3차 blocker③ — 지문 소실 방지)
        try { const MRd = require(path.join(__dirname, "map-reader.js")); const g9 = MRd.gitChangedEx(repo, { untrackedAll: true }); list = g9 && g9.ok && !g9.truncated ? (g9.paths || []) : null; } catch { list = null; }
      }
      if (!Array.isArray(list)) return null;
      // 3차 blocker③: 자체 MAP 산출물(project-map/)은 소스가 아니다 — 포함하면 적용 자체가 지문을 바꿔
      // 수렴이 깨진다(historyless는 collectInventory가 이미 project-map 제외 — 대칭 필터).
      const src = list.filter((f) => !String(f).replace(/\\/g, "/").startsWith("project-map/"));
      const parts = src.map((f) => { try { return f + ":" + crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, f))).digest("hex"); } catch { return f + ":gone"; } });
      return sha1("git|" + head + "|" + parts.join(","));
    }
    const inv = MR.collectInventory(repo);
    // historyless 지문도 전수 스캔만 권위가 있다. 부분 목록을 지문으로 만들면 보이지 않는
    // 꼬리 변경이 기존 done 지문과 같아져 corridor=unknown보다 먼저 already-enriched로 끝난다.
    if (!inv || !Array.isArray(inv.files) || !inv.cov || inv.cov.scanComplete !== true) return null;
    const parts = inv.files.map((f) => { try { return f.rel + ":" + crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, f.rel))).digest("hex"); } catch { return f.rel + ":unreadable"; } }).sort();
    return sha1("hist|" + parts.join(","));
  } catch { return null; }
}

// attempt 루프 — decideRoute 재호출(실패 플래그 관측 후)·승격은 표가 결정(라우터 7행=정확 1회)
function driveAttempts(repo, o, env, st) {
  const { MRt, log, park } = env;
  let economyFailed = false, precisionFailed = false, lastP10Failure = null;
  for (let guard = 0; guard < 3; guard++) { // 최대: 최초 route+승격 1회(+both-failed 종결) — 라우터 표가 상한
    if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" }; // 상태 변경 전 소유 재검증(2차 blocker⑧ — bootstrap 문법)
    const d = MRt.decideRoute({ mode: o.mode, ready: o.readiness, corridor: st.corridor, economyFailed, precisionFailed, conflict: false });
    log({ route: d.route, reason: d.reason, corridor: st.corridor, changedCount: Array.isArray(st.changed) ? st.changed.length : null, jobKey: st.jobKey, escalated: economyFailed && d.route === "precision" });
    if (d.route === "park") {
      if (env.p10 && lastP10Failure) env.p10.reasonCode = lastP10Failure;
      return park((j) => j && { ...j, phase: "parked", parkedReason: d.reason, finishedAt: new Date().toISOString() }, d.reason, { jobKey: st.jobKey });
    }
    if (d.route === "adjudicate") return park((j) => j && { ...j, phase: "parked", parkedReason: "adjudicate-unreachable", finishedAt: new Date().toISOString() }, "adjudicate-unreachable", { jobKey: st.jobKey }); // 신규 경로에서 conflict=false — 도달 불가 방어
    const provider = d.route;
    const at = runAttempt(repo, o, env, st, provider);
    if (at.outcome === "applied" || at.outcome === "parked" || at.outcome === "noop") return at;
    if (at.outcome === "provider-failed") {
      lastP10Failure = at._p10Reason || "provider-call-failed";
      if (provider === "economy") economyFailed = true;
      else if (provider === "precision") precisionFailed = true;
      else { if (env.p10) env.p10.reasonCode = lastP10Failure; return park(null, "self-failed", { jobKey: st.jobKey }); }
      continue;
    }
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
  // 호출 직전 최종 관문(수동 '다시 시도'로 재개된 job까지 커버): 답이 원천 불가능한 입력이면 과금
  // 호출 없이 정확한 사유로 세워 둔다 — 코드 변경이 오면 위 parked 자기치유가 사람 없이 재개한다.
  if (!answerableInput(repo, st.topo, st.changed)) return park((j) => j && { ...j, phase: "parked", parkedReason: "input-doc-only", finishedAt: nowIso() }, "input-doc-only", { provider, jobKey: st.jobKey });
  // attempt 생성(phase running — 호출 '전' 기록: uncertain-call 감사 재료)
  let attemptId = -1;
  const mk = fencedUpdateEnrichJob(repo, env.fence, (j) => {
    if (!j || j.phase !== "open") return null;
    attemptId = j.attempts.length;
    return { ...j, attempts: [...j.attempts, { attemptId, provider, consentGen: g2.gen, phase: "running", startedAt: nowIso() }] };
  });
  if (!mk.ok || attemptId < 0) return park(null, "attempt-write");
  // provider 호출(주입 어댑터 — 실 LLM 배선은 3b-2)
  let call;
  const jobForUsage = mk.job || (readEnrichJob(repo).job || null);
  const usageContext = env.p10 ? env.p10.usage(st.jobKey, jobRunIdOf(jobForUsage)) : null;
  try { call = adapter({ repo, topo: st.topo, changed: st.changed, provider, usageContext }); }
  catch (e) { call = { ok: false, detail: "adapter-threw: " + String(e && e.message) }; }
  // provider 반환 직후 소유 재검증(7차 ab-6 변형): 호출 동안 오탈취가 일어나 새 소유자가 이 running
  // 시도를 uncertain-call로 park했다면, 아래 실패·결과 기록이 그 장부를 덮어써 '자동 재시도 대상 밖의
  // 불일치'(parked job+applying attempt)를 만든다 — 상실 시 아무것도 기록하지 않고 물러난다(busy).
  if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" };
  if (!call || call.ok !== true) {
    const failureReason = call && call.failureKind === "result-invalid" ? "provider-result-invalid" : "provider-call-failed";
    // 어댑터가 '답은 왔는데 형태가 아니다'로 알려주면 응답 단계, 그 밖은 호출 단계로 남긴다.
    const fx0 = call && call.failureKind === "result-invalid"
      ? { failureStage: "response", failureCode: "parse-invalid" }
      : { failureStage: "call", failureCode: "process-failed" };
    // 소유 재검증을 '잠금 보유 중'(mutator 안)에서 수행(8차 ab-6 변형): 사전 fence~RMW 사이의 오탈취는
    // 새 소유자의 park(같은 job-lock 경유)와 직렬화되지 않아 덮어쓰기 창이 남는다. 잠금 안 재검증이면
    // park가 선행한 경우 반드시 상실이 관측되고(무기록 물러남), 잠금 중 획득만 된 경우의 기록은 아직
    // park 전이라 무해(이후 소유자가 failed/applying을 정상 재개). null 반환=unchanged=미기록.
    const w0 = fencedUpdateEnrichJob(repo, env.fence, (j) => {
      return j && { ...j, attempts: j.attempts.map((a) => a.attemptId === attemptId ? { ...a, phase: "failed", failReason: String((call && call.detail) || "adapter-failed").slice(0, 200), ...fx0, finishedAt: nowIso() } : a) };
    });
    if (w0.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
    if (!w0.ok) return park(null, "attempt-write:" + w0.reason, { provider, jobKey: st.jobKey });
    log({ route: provider, reason: failureReason, outcome: "error", provider, jobKey: st.jobKey, consentGen: g2.gen });
    return { outcome: "provider-failed", provider, _p10Reason: failureReason };
  }
  // results 검증(strict — 실패 분류 3종은 provider 실패 플래그)+근거 실증(3b 1차 blocker④ ab-3:
  // quote가 실제 파일 내용에 존재하는지 대조 — 허위 인용으로 생성된 의미 변경이 P2 관문을 통과하는 경로 차단)
  let vr = validateEnrichResult(call.result, st.topo, { repo, changed: st.changed }); // 해상도 v3: add_node 발췌·판독 자격까지
  if (vr.ok) {
    for (const it of call.result.items) {
      const cites = [...(it.evidence || []), ...((it.claims || []).map((c) => ({ file: c.file, quote: c.quote })))];
      for (const cv of cites) {
        let body = null;
        try { body = fs.readFileSync(path.join(repo, cv.file), "utf8"); } catch { body = null; }
        // 파일을 못 읽은 것과 인용이 안 맞는 것은 사용자가 할 일이 다르다 — 두 코드로 나눈다(설계 상의 결론).
        if (body === null) { vr = { ok: false, kind: "evidence", code: "evidence-unreadable", file: cv.file, errors: ["근거 실패: " + cv.file + " 판독 불가"] }; break; }
        if (!body.includes(cv.quote)) { vr = { ok: false, kind: "evidence", code: "evidence-mismatch", file: cv.file, errors: ["근거 실패: " + cv.file + " 인용 불일치"] }; break; }
      }
      if (!vr.ok) break;
    }
  }
  // 검증 대조(파일 판독) 동안에도 같은 창이 열린다 — 실패 기록(w1)·결과 영속(wR) 직전 재검증(7차 ab-6 변형).
  if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" };
  if (!vr.ok) {
    const fx1 = vr.kind === "evidence"
      ? { failureStage: "validation", failureCode: vr.code || "evidence-mismatch", ...safeFailureFile(vr.file) }
      : { failureStage: "validation", failureCode: "schema-invalid" };
    // 쓰기 결과를 확인한다(2차 blocker④: 실패 기록이 거부되면 시도가 running으로 남아, 다음 재개가
    // 이를 '호출 여부 불확실'로 해석해 완료된 결과 거부가 uncertain-call로 변질됐다).
    const w1 = fencedUpdateEnrichJob(repo, env.fence, (j) => {
      return j && { ...j, attempts: j.attempts.map((a) => a.attemptId === attemptId ? { ...a, phase: "failed", failReason: (vr.kind + ": " + (vr.errors[0] || "")).slice(0, 200), ...fx1, finishedAt: nowIso() } : a) };
    });
    if (w1.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
    if (!w1.ok) return park(null, "attempt-write:" + w1.reason, { provider, jobKey: st.jobKey });
    log({ route: provider, reason: "result-" + vr.kind, outcome: "error", provider, jobKey: st.jobKey, consentGen: g2.gen });
    return { outcome: "provider-failed", provider, _p10Reason: "provider-result-invalid" };
  }
  // results 영속(수신 즉시 — 이후 재개는 provider 재호출 0)
  const wR = fencedUpdateEnrichJob(repo, env.fence, (j) => {
    return j && { ...j, attempts: j.attempts.map((a) => a.attemptId === attemptId ? { ...a, phase: "applying", results: call.result, ...(st.srcFp ? { sourceFp: st.srcFp } : {}), cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [] } } : a) };
  }); // 호출 시점 지문 영속(5차 blocker — 재개 done의 도장 정본)
  if (wR.fenceLost) return { outcome: "busy", reason: "run-lock-lost" };
  if (!wR.ok) return park(null, "results-write:" + wR.reason, { provider, jobKey: st.jobKey });
  return applyItems(repo, o, env, st, attemptId);
}

// item별 순차 변환·적용(cursor 전이 ⓐⓑ — 설계 v10·3b 2차 재작업). 핵심 계약:
// - currentPatch 존재(super 부재)=재변환 없이 '저장본 재투입'(propose 멱등 — 같은 patchId 다른 opHash 충돌 소멸).
// - super 존재=전이 재개: expire 확인(idempotent) 후 '재변환+rev=toRev+super 소거'를 한 원자 기록으로(ⓒ) —
//   전이 중 rev는 구 값+super.toRev==rev+1이라 strict 불변식과 정합(2차 blocker①).
// - 변환 직전 인용 파일을 한 번 읽어 quote 확인과 해시 결속을 '같은 판독'으로(2차 blocker② TOCTOU).
// - reject·N-I 종결은 nextIndex만 전진(appliedPatchIds 미추가 — 적용 도장 분리·2차 blocker④).
// - 범위 밖 Verifier 인용=cursor.evExtra에 파일 추가 후 rev 전진 규약으로 재제안·재해소 정확 1회(2차 blocker⑤).
function applyItems(repo, o, env, st, attemptId) {
  const { MP, PM, log, park } = env;
  const nowIso = () => new Date().toISOString();
  let retries = 0;
  for (;;) {
    if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" }; // 소유 fence(2차 blocker⑧)
    const jr = readEnrichJob(repo);
    if (jr.st !== "ok") return park(null, "job-damaged-mid");
    const j = jr.job;
    const a = j.attempts.find((x) => x.attemptId === attemptId);
    if (!a || a.phase !== "applying" || !a.results || !a.cursor) return park(null, "attempt-state");
    const items = a.results.items;
    if (a.cursor.nextIndex >= items.length) { // 전 item 종결 → attempt done·job done(+수렴용 sourceFp)
      // 5차 blocker(f-7c453391): done 도장은 '호출 시점에 소비한' 지문만 — 신규 경로=st.srcFp·재개=attempt에
      // 영속된 sourceFp. 사후 재계산은 금지(결과 영속→사망→소스 변경→재개 완료가 변경 후 지문을 도장으로
      // 찍어 실제 변경의 보강을 영구 생략하는 경로). 둘 다 없으면 미기록=다음 실행 허용(보수).
      const srcFp = (st && st.srcFp) ? st.srcFp : (a.sourceFp || null);
      const applied = a.cursor.appliedPatchIds.length;
      const skipped = items.length - applied; // reject·N-I·intent 보존 등 비적용 종결(도장 분리 — 2차 blocker④)
      const ds9 = deferredSummary(repo, j.mapId);
      const runId9 = jobRunIdOf(j);
      const awaitingVerification = ds9.st === "ok" ? ds9.records.filter((x) => x.jobKey === j.jobKey && runId9 && x.jobRunId === runId9).length : null;
      const rejected = (a.resolutions || []).filter((x) => x.verdict === "reject").length;
      const investigationPending = awaitingVerification === null ? null : Math.max(0, skipped - awaitingVerification - rejected);
      const wD = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, phase: "done", finishedAt: nowIso(), ...(srcFp ? { sourceFp: srcFp } : {}), attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, phase: "done", finishedAt: nowIso(), cursor: { nextIndex: x.cursor.nextIndex, rev: 0, appliedPatchIds: x.cursor.appliedPatchIds } } : x) });
      if (!wD.ok) return park(null, "done-write:" + wD.reason);
      // 소화 기준점 갱신(기준점 교체 — done 도장과 함께): 이 완주가 소화한 커밋을 기록해 다음 라운드가
      // '그 이후의 커밋 변경'을 입력으로 받게 한다(historyless 등 캡처 부재=미기록·무해).
      // ⚠ 완료 시점 HEAD 재판독 금지(검증 blocker): 기준점은 '입력을 계산한 시점'의 커밋(st.srcHead)에만
      // 결속한다 — 실행 중 생긴 커밋이 발췌 없이 소화 처리되는 시간 창 차단. 캡처 없는 재개(사망 복구
      // 등)는 미기록=기존 기준점 유지(다음 라운드가 다시 먹는다 — 과다 포함이 안전 방향).
      if (st && st.srcHead) writeConsumedBaseline(repo, st.srcHead, j.mapId);
      // 멈춤을 알렸으면 풀림도 알려야 한다 — 완주 시 그 프로젝트의 '멈춤' 경보를 해소(대체)한다.
      try { CL.supersedeIntegrity(null, "enrich-parked", String(o.ws || repo)); } catch { /* 무해 */ }
      log({ route: a.provider, reason: applied > 0 ? "enriched" : "settled-no-apply", outcome: applied > 0 ? "applied" : "settled", provider: a.provider, jobKey: j.jobKey, consentGen: a.consentGen, awaitingVerification, rejected, investigationPending });
      return { outcome: applied > 0 ? "applied" : "settled", jobKey: j.jobKey, applied, skipped, awaitingVerification, rejected, investigationPending };
    }
    const i = a.cursor.nextIndex;
    const item = items[i];
    let patch = null;
    if (a.cursor.super) {
      // super 전이 재개(ⓑ~ⓒ): expire 확인(멱등) → 재변환(rev=toRev)+rev 전진+super 소거를 한 원자 기록(ⓒ)
      const sup = a.cursor.super;
      const ex = MP.expirePendingPatch(repo, j.mapId, sup.fromPatchId, sup.fromOpHash);
      if (ex.reason === "busy") return park(null, "expire-busy");
      if (ex.reason === "lock") { retries++; if (retries > 5) return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "retry-exhausted", finishedAt: nowIso() }, "retry-exhausted", { jobKey: j.jobKey }); continue; }
      if (ex.reason === "already-applied") { // 그새 적용 완료 — ⓑ 보충(적용 도장 포함)+super 소거
        const wS = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: [...x.cursor.appliedPatchIds, sup.fromPatchId], ...(x.cursor.evExtra ? {} : {}) } } : x) });
        if (!wS.ok) return park(null, "cursor-write:" + wS.reason);
        retries = 0; continue;
      }
      if (!(ex.ok || ex.reason === "idempotent" || ex.reason === "expired" || (ex.reason === "conflict" && /부재/.test(ex.error || "")))) return park(null, "expire-" + ex.reason);
      if (sup.toRev > 2) return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "rev-exhausted", finishedAt: nowIso() }, "rev-exhausted", { jobKey: j.jobKey }); // 상한 2(v10 ⑦ — cas-stale 반복)
      const convS = convertItem(repo, env, j, a, item, i, sup.toRev);
      if (!convS.ok) return failAttempt(repo, env, attemptId, convS, a.provider);
      const itemFilesS = new Set([...(item.evidence || []).map((e) => e.file), ...((item.claims || []).map((c) => c.file))]);
      const extraS = [...new Set([...(a.cursor.evExtra || []), ...((convS.patch.evidence || []).map((e) => e.ref).filter((f) => !itemFilesS.has(f)))])];
      const wC = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex, rev: sup.toRev, appliedPatchIds: x.cursor.appliedPatchIds, currentPatch: convS.patch, ...(extraS.length ? { evExtra: extraS } : {}), ...(x.cursor.oosUsed !== undefined ? { oosUsed: x.cursor.oosUsed } : {}) } } : x) });
      if (!wC.ok) return park(null, "cursor-write:" + wC.reason);
      patch = convS.patch;
    } else if (a.cursor.currentPatch) {
      patch = a.cursor.currentPatch; // 저장본 재투입(2차 blocker① — 재변환하면 같은 patchId 다른 opHash 충돌)
    } else {
      const conv = convertItem(repo, env, j, a, item, i, a.cursor.rev);
      if (!conv.ok) return failAttempt(repo, env, attemptId, conv, a.provider);
      const itemFiles = new Set([...(item.evidence || []).map((e) => e.file), ...((item.claims || []).map((c) => c.file))]);
      const extraNow = [...new Set([...(a.cursor.evExtra || []), ...((conv.patch.evidence || []).map((e) => e.ref).filter((f) => !itemFiles.has(f)))])];
      const wA = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { ...x.cursor, currentPatch: conv.patch, ...(extraNow.length ? { evExtra: extraNow } : {}) } } : x) }); // ⓐ 전이(+사전 결속분 evExtra 영속 — oosUsed는 spread로 보존)
      if (!wA.ok) return park(null, "cursor-write:" + wA.reason);
      patch = conv.patch;
    }
    const topoNow = require(path.join(__dirname, "map-runtime.js")).readTopoExFor(repo);
    if (topoNow.st !== "ok") return park(null, "topology-" + topoNow.st);
    const step = applyOnePatch(repo, o, env, { job: j, attempt: a, attemptId, item, patch, topoNow: topoNow.topo });
    if (step.done) {
      // ⓑ 전이: nextIndex+1+currentPatch·super 소거+rev=0 — 적용된 경우에만 appliedPatchIds 추가(도장 분리)
      const wB = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: step.applied ? [...x.cursor.appliedPatchIds, patch.patchId] : x.cursor.appliedPatchIds } } : x) });
      if (!wB.ok) return park(null, "cursor-write:" + wB.reason);
      retries = 0;
      continue;
    }
    if (step.retry) { // 일시 실패=같은 rev·같은 저장본 재시도(Verifier 재호출 0 — resolutions 재사용)·상한
      retries++;
      if (retries > 5) return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "retry-exhausted", finishedAt: nowIso() }, "retry-exhausted", { jobKey: j.jobKey });
      if (step.recoverFirst) { try { MP.recoverWal(repo, j.mapId); } catch { /* 복구 실패=다음 재시도가 판정 */ } } // wal-active=P2 복구 표면 선행
      continue;
    }
    retries = 0;
    if (step.revUp || step.evExpand) { // cas-stale·범위 밖 인용 — rev 전진 규약(super marked 기록 → 다음 반복이 ⓑⓒ 수행)
      const jrR = readEnrichJob(repo); // 4차 blocker①: 같은 반복 변수 a는 낡을 수 있다 — toRev는 최신 장부 rev 기준
      if (jrR.st !== "ok") return park(null, "job-damaged-mid");
      const aR = jrR.job.attempts.find((x) => x.attemptId === attemptId);
      if (!aR || !aR.cursor) return park(null, "attempt-state");
      if (step.evExpand && aR.cursor.oosUsed === true) return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "resolution-out-of-scope", finishedAt: nowIso() }, "resolution-out-of-scope", { jobKey: j.jobKey }); // 재제안+재해소 정확 1회 — 표지는 전용 필드(4차 blocker④: evExtra는 충돌 사전 결속과 공유돼 오인)
      const sup = { fromPatchId: patch.patchId, fromOpHash: PM.opHashOf(patch), toRev: aR.cursor.rev + 1, phase: "marked" };
      const w1 = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex, rev: x.cursor.rev, appliedPatchIds: x.cursor.appliedPatchIds, super: sup, ...(step.evExpand ? { evExtra: [...new Set([...(x.cursor.evExtra || []), ...step.evExpand])], oosUsed: true } : { ...(x.cursor.evExtra ? { evExtra: x.cursor.evExtra } : {}), ...(x.cursor.oosUsed !== undefined ? { oosUsed: x.cursor.oosUsed } : {}) }) } } : x) });
      if (!w1.ok) return park(null, "cursor-write:" + w1.reason);
      continue; // 다음 반복의 super 경로가 expire→재변환→전진을 원자 수행
    }
    // 영구 park(hard-reject·no-verifier·unknown-outcome 등)
    return park((jj) => jj && { ...jj, phase: "parked", parkedReason: step.parkReason || "apply-failed", finishedAt: nowIso() }, step.parkReason || "apply-failed", { jobKey: j.jobKey });
  }
}

// 변환(순차 — 현재 상태 결속)+인용 실증을 '같은 판독'으로(2차 blocker② TOCTOU): 인용 파일을 한 번 읽어
// quote 확인과 sha1을 같은 body에서 산출 — 확인과 결속 사이 편집 창 제거. evExtra(범위 밖 인용 확장) 합류.
function convertItem(repo, env, j, a, item, index, rev) {
  const { MP } = env;
  const MRr = require(path.join(__dirname, "map-runtime.js"));
  const topoNow = MRr.readTopoExFor(repo);
  if (topoNow.st !== "ok") return { ok: false, kind: "state", errors: ["topology-" + topoNow.st] };
  const idxNow = MP.decisionIndexFor(repo, topoNow.topo.mapId);
  const polNow = MP.policyStateFor(repo, topoNow.topo.mapId);
  if (idxNow.st === "error" || polNow.st !== "ok") return { ok: false, kind: "state", errors: ["state-read"] };
  const bodyCache = new Map(); // file → {sha, body}
  const readOnce = (ref) => {
    if (bodyCache.has(ref)) return bodyCache.get(ref);
    let rec = null;
    try { const b = fs.readFileSync(path.join(repo, ref)); rec = { sha: crypto.createHash("sha1").update(b).digest("hex"), body: b.toString("utf8") }; } catch { rec = null; }
    bodyCache.set(ref, rec);
    return rec;
  };
  const cites = [...(item.evidence || []), ...((item.claims || []).map((c) => ({ file: c.file, quote: c.quote })))];
  for (const cv of cites) {
    const rec = readOnce(cv.file);
    if (!rec) return { ok: false, kind: "evidence", code: "evidence-unreadable", file: cv.file, errors: ["근거 실패(변환 시점 재실증): " + cv.file + " 판독 불가"] };
    if (!rec.body.includes(cv.quote)) return { ok: false, kind: "evidence", code: "evidence-mismatch", file: cv.file, errors: ["근거 실패(변환 시점 재실증): " + cv.file + " 인용 불일치"] };
  }
  const fileHashOf = (ref) => { const rec = readOnce(ref); return rec ? rec.sha : null; }; // 같은 판독의 sha가 P2 결속에 실림
  let evExtra = a.cursor && Array.isArray(a.cursor.evExtra) ? [...a.cursor.evExtra] : [];
  // 3차 blocker②(사전 결속): 격하 제안이 타 provider의 confirmed를 겨누면 기존 측 근거 파일을 Verifier 호출
  // '전'에 patch.evidence에 결속(설계 P8-4 — 해소 근거가 opHash·evidenceFps에 실려 freshness 자동)
  if (isDemotion(item)) {
    const info9 = existingDecisionOf(repo, topoNow.topo, item.targetId);
    if (info9 && info9.provider !== null && info9.provider !== a.provider) {
      for (const e9 of info9.evidence) if (e9 && e9.ref && !evExtra.includes(e9.ref)) evExtra.push(e9.ref);
    }
  }
  const itemEff = evExtra.length ? { ...item, evidence: [...(item.evidence || []), ...evExtra.filter((f) => !(item.evidence || []).some((e) => e.file === f)).map((f) => { const rec = readOnce(f); return { file: f, quote: rec && rec.body ? rec.body.slice(0, 80) : "" }; })] } : item;
  return toPatchV2(itemEff, index, { repo, topo: topoNow.topo, idx: idxNow, pol: polNow, fileHashOf, jobKey: jobSeedOf(j.jobKey, j.startedAt), attemptId: a.attemptId, rev, provider: a.provider, items: a.results.items }); // items=임시 id 매핑의 순수 입력(해상도 v3)
}
function failAttempt(repo, env, attemptId, conv, provider) {
  // 변환 단계 거부도 '호출은 됐고 답이 버려진 것'이다 — 구조 필드와 P10 사유를 함께 남긴다
  // (2차 blocker②③: 이 경로만 자유 문자열이라 화면이 못 갈랐고 감사 기록도 '못 불렀다'가 됐다).
  const fx = conv && conv.kind === "evidence"
    ? { failureStage: "conversion", failureCode: conv.code || "evidence-mismatch", ...safeFailureFile(conv.file) }
    : { failureStage: "conversion", failureCode: "convert-invalid" };
  const w = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, phase: "failed", failReason: ("convert-" + conv.kind + ": " + (conv.errors[0] || "")).slice(0, 200), ...fx, finishedAt: new Date().toISOString() } : x) });
  if (!w.ok) return env.park(null, "attempt-write:" + w.reason, { provider, jobKey: null }); // 실패 기록을 못 남기면 running 잔존 — 조용히 넘기지 않는다(2차 blocker④)
  return { outcome: "provider-failed", provider, _p10Reason: "provider-result-invalid" };
}
// 화면으로 나갈 수 있는 파일 표기만 통과시킨다. 저장소 상대경로 형태가 아니면 파일 자체를 생략한다
// (2차 blocker④: 거부되는 값을 그대로 쓰면 기록 저장이 통째로 실패해 시도가 running으로 남았다.
//  2차 [보완]: 제어문자·여러 줄 문자열이 파일명 자리에 섞이는 것도 여기서 막는다).
function safeFailureFile(v) {
  const s = String(v == null ? "" : v).replace(/\\/g, "/");
  if (!s || s.length > 260) return {};
  if (/[\x00-\x1f\x7f<>:"|?*]/.test(s)) return {}; // 제어문자·여러 줄·윈도 금지문자
  if (/^([a-zA-Z]:|\/)/.test(s)) return {};
  if (s.split("/").includes("..")) return {};
  return { failureFile: s };
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
// 대상 entity의 기존 결정 자료 조회(P8-4 — decisionId 경유 strict·2차 blocker③: 충돌 해소는 양측 제시).
// 반환 {provider|null, decisionId, evidence, rationale}|null(귀속 부재·판독 실패).
function existingDecisionOf(repo, topo, targetId) {
  try {
    const ent = [...(topo.nodes || []), ...(topo.edges || [])].find((x) => x && x.id === targetId);
    const did = ent && ent.provenance && ent.provenance.decisionId;
    if (!did) return null;
    const dec = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "decisions", did + ".json"), "utf8"));
    if (!dec || !dec.patch) return null;
    // claims=기존 결정의 근거 결속(evidenceFps — 파일+내용 지문: 3차 blocker② '양측 claims 제시' 재료)
    return { provider: typeof dec.patch.provider === "string" ? dec.patch.provider : null, decisionId: did, evidence: dec.patch.evidence || [], claims: Array.isArray(dec.evidenceFps) ? dec.evidenceFps : [], rationale: dec.patch.rationale || "" };
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
  // 별도 확인 대기 장부가 먼저 결론을 적용한 뒤 원 작업이 복구돼도 같은 패치를 다시 판단하지 않는다.
  let pending9 = null;
  try { pending9 = JSON.parse(fs.readFileSync(path.join(MP.dirsFor(repo, job.mapId).pending, patch.patchId + ".json"), "utf8")); } catch { pending9 = null; }
  if (pending9 && ["resolved", "resolved-noop"].includes(pending9.lifecycle)) { settleDeferred(repo, patch.patchId, "settled", "settled", "applied"); return { done: true, applied: true }; }
  if (pending9 && pending9.lifecycle === "expired") {
    settleDeferred(repo, patch.patchId, pending9.expireCode === "cas-stale" ? "stale" : "settled", pending9.expireCode === "cas-stale" ? "cas-stale" : "settled", pending9.expireCode === "cas-stale" ? undefined : "rejected");
    return pending9.expireCode === "cas-stale" ? { revUp: true } : { done: true, applied: false, rejected: true };
  }
  const cl = pending9 && pending9.lifecycle === "classified"
    ? { ok: true, classification: pending9.classification }
    : MP.classifyPatch(repo, job.mapId, patch.patchId);
  if (!cl.ok) return { retry: true }; // 판독·잠금성 실패=일시(상한은 호출자)
  if (cl.classification === "hard-reject") return { parkReason: "hard-reject" };
  if (cl.classification === "needs-investigation" || cl.classification === "intent-choice") return { done: true, applied: false, pendingOnly: true }; // 제안 보존(P9 소관)=이 item 종결·적용 도장 없음(2차 blocker④)
  // 충돌·해소 회부 판정(blocker①): 격하 제안은 자동 적용 금지 — 타 provider 격하=conflict 프레이밍(1-34 모드 무관)·
  // 같은 provider=자기 갱신도 의미 판단이라 해소 경로(설계: set_state 하향은 auto 분류여도 실행기가 회부)·귀속 부재=해소 회부.
  const demotion = isDemotion(item);
  let framing = "resolution";
  let existing = null; // 충돌 시 기존 측 자료(2차 blocker③ — 양측 제시)
  let demotionEscalate = false;
  if (demotion) {
    const info = existingDecisionOf(repo, ctx.topoNow || {}, item.targetId);
    // 3차 blocker② 정정: 같은 provider=자기 갱신(정본 — 일반 분류·과승격 금지). 타 provider=conflict(양측 제시)·
    // 귀속 부재·조회 실패=해소 회부(자동 적용 금지 — 의미 판단).
    if (info && info.provider !== null && info.provider === patch.provider) { demotionEscalate = false; }
    else if (info && info.provider !== null) { framing = "conflict"; existing = info; demotionEscalate = true; }
    else demotionEscalate = true; // 귀속 부재
  }
  const needVerifier = cl.classification === "verifier-resolved" || demotionEscalate;
  let vrRes = null;
  if (needVerifier) {
    // support/reject만 attempt의 최종 판정으로 재사용한다. inconclusive는 별도 deferred 세대 이력으로
    // 보존해 명시 재시도가 과거 inconclusive를 답처럼 재사용하지 않게 한다.
    const opH = PMx.opHashOf(patch);
    const jr9 = readEnrichJob(repo);
    const at9 = jr9.st === "ok" ? jr9.job.attempts.find((x) => x.attemptId === attemptId) : null;
    const saved = at9 && Array.isArray(at9.resolutions) ? at9.resolutions.find((r) => r.patchId === patch.patchId && r.opHash === opH) : null;
    const priorDeferred = deferredRecord(repo, patch.patchId);
    let res = saved || (priorDeferred && priorDeferred.phase === "answered" ? priorDeferred.resolution : null) || null;
    if (!res) {
      const meta = { mapId: job.mapId, patchId: patch.patchId, opHash: opH, jobKey: job.jobKey, jobRunId: jobRunIdOf(job), attemptId, itemIndex: at9 && at9.cursor ? at9.cursor.nextIndex : 0, framing };
      const beg = beginDeferredCall(repo, meta, "initial", "");
      if (!beg.ok) return { parkReason: "deferred-" + (beg.reason || "write") };
      if (beg.action === "answered") res = beg.record && beg.record.resolution;
      else if (beg.action !== "call") return { done: true, applied: false, pendingOnly: true, deferred: true, deferredReason: (beg.record && beg.record.reason) || "no-verifier" };
      else {
        let raw = null, callThrew = false;
        if (typeof o.askVerifier === "function") {
          try { raw = o.askVerifier({ repo, ws: job.configWs, patch, item, framing, existing, usageContext: env.p10 ? env.p10.usage(job.jobKey, jobRunIdOf(job)) : null }); } catch { callThrew = true; raw = null; }
        }
        const outcome = callThrew ? "uncertain-call" : raw && raw.verdict === "inconclusive" ? "inconclusive" : raw && ["support", "reject"].includes(raw.verdict) ? raw.verdict : "no-verifier";
        const rec9 = raw && ["support", "reject"].includes(raw.verdict)
          ? { patchId: patch.patchId, opHash: opH, baseDecisionContextHash: patch.baseDecisionContextHash, verdict: raw.verdict, claims: Array.isArray(raw.claims) ? raw.claims : [] }
          : null;
        const fin = finishDeferredCall(repo, patch.patchId, beg.token, outcome, rec9);
        if (!fin.ok) return { parkReason: "deferred-result-" + (fin.reason || "write") };
        if (!rec9) return { done: true, applied: false, pendingOnly: true, deferred: true, deferredReason: outcome };
        res = rec9;
      }
      // 같은 실행의 적용 일시 실패는 이 support/reject를 재사용하고 verifier를 다시 부르지 않는다.
      const rec9 = res;
      const wS = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === attemptId ? { ...x, resolutions: [...(x.resolutions || []), rec9] } : x) });
      if (!wS.ok) return { parkReason: "resolution-persist:" + wS.reason }; // 영속 실패=적용 진행 금지(재호출 멱등 깨짐)
    }
    if (res.verdict === "reject") {
      const ex = MP.expirePendingPatch(repo, job.mapId, patch.patchId, opH);
      if (ex.ok || ex.reason === "idempotent" || ex.reason === "expired") { settleDeferred(repo, patch.patchId, "settled", "settled", "rejected"); if (framing === "conflict" && log) log({ route: "adjudicate", reason: "conflict-rejected", outcome: "adjudicated", provider: patch.provider, jobKey: job.jobKey, consentGen: ctx.attempt ? ctx.attempt.consentGen : null }); return { done: true, applied: false, rejected: true }; } // 폐기 확정=종결(적용 도장 없음 — 2차 blocker④)
      if (ex.reason === "already-applied") { settleDeferred(repo, patch.patchId, "settled", "settled", "applied"); return { done: true, applied: true }; } // 이미 적용 완료(경합) — 종결 보충
      if (ex.reason === "busy" || ex.reason === "lock") return { retry: true }; // 일시 — 만료 재시도(재호출 0: 영속 레코드 재사용)
      return { parkReason: "reject-expire:" + ex.reason }; // conflict 등=표면화(폐기 미확정 상태로 전진 금지)
    }
    vrRes = res;
  }
  const ap = MP.applyPatch(repo, job.mapId, patch.patchId, { preCutover: true, ...(vrRes ? { verifierResolution: vrRes } : {}) });
  if (ap.ok) { settleDeferred(repo, patch.patchId, "settled", "settled", "applied"); if (framing === "conflict" && log) log({ route: "adjudicate", reason: "conflict-resolved", outcome: "adjudicated", provider: patch.provider, jobKey: job.jobKey, consentGen: ctx.attempt ? ctx.attempt.consentGen : null }); return { done: true, applied: true }; }
  const rc = ap.reasonCode;
  // 2차 blocker⑤: 범위 밖 Verifier 인용 — vr 경로의 decision-conflict 중 '사전 결속 위반'은 evidence 확장+
  // rev 재제안+재해소 정확 1회(v10 P8-4). 식별=claims 중 patch.evidence 밖 파일.
  if (vrRes && rc === "decision-conflict") {
    const evSet = new Set((patch.evidence || []).map((e) => e.ref));
    const outside = [...new Set((vrRes.claims || []).map((c) => c && c.file).filter((f) => f && !evSet.has(f)))];
    if (outside.length) return { evExpand: outside };
  }
  if (rc === "wal-active") return { retry: true, recoverFirst: true }; // P2 복구 표면 선행(blocker②)
  if (["lock", "write-failed", "claim-busy"].includes(rc)) return { retry: true }; // 일시=같은 rev 재시도(상한은 호출자)
  if (rc === "cas-stale") return { revUp: true };
  if (rc === "already-applied") { settleDeferred(repo, patch.patchId, "settled", "settled", "applied"); return { done: true, applied: true }; }
  if (rc === "hard-reject") return { parkReason: "hard-reject" };
  return { parkReason: "unknown-outcome:" + String(rc || "none") }; // 미지·미부여=fail-closed park
}

// 복구(미완 job — 상태표): 마지막 attempt 기준. running 유료=uncertain-call park(재호출 0)·self=재실행 허용·
// applying=cursor 복구(decision patchId 실존=ⓑ 보충 → applyItems 재진입).
function resumeJob(repo, oIn, env, j, st2) {
  const nowIso = () => new Date().toISOString();
  // 2차 blocker⑨(ab-1): 재개는 job에 동결된 결정 주체(configWs·slot·mode)로 — 현재 호출자의 계약·동의를
  // 쓰면 다른 창 재개가 타 워크스페이스 grant 세대의 attempt를 이 장부에 섞는다.
  const o = { ...oIn, ws: j.configWs, slot: j.slot, mode: j.mode };
  // 3~4차 [주의](f-cc94df4f): 감사 로그·park도 동결 주체로 — 구조분해는 래핑 '후'(적용 주체와 감사 행 일치)
  const baseLog = env.log;
  const wrappedLog = (e) => baseLog({ configWs: CL.normWs(j.configWs), slot: j.slot, mode: j.mode, ...e });
  const wrappedPark = (jobMut, reason, extra) => {
    if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" }; // 상실=기록·통지 금지(9차 — stale parkR 봉인)
    if (jobMut) { const wP = fencedUpdateEnrichJob(repo, env.fence, jobMut); if (wP.fenceLost) return { outcome: "busy", reason: "run-lock-lost" }; }
    wrappedLog({ route: "park", reason, outcome: "parked", ...(extra || {}) }); notifyEnrichParked(String(j.configWs || oIn.ws || repo), reason); return { outcome: "parked", reason };
  };
  env = { ...env, log: wrappedLog, park: wrappedPark };
  const { MP, log, park } = env;
  const a = j.attempts[j.attempts.length - 1];
  if (!a) { // 4차 blocker③: attempt 생성 전 park(consent-stale 등)에서 복원된 open — 신규 attempt 경로로
    const d0 = env.MRt.decideRoute({ mode: j.mode, ready: o.readiness, corridor: st2 && st2.corridor ? st2.corridor : "unknown", economyFailed: false, precisionFailed: false, conflict: false });
    if (d0.route === "park" || d0.route === "adjudicate") return park((jj) => jj && { ...jj, phase: "parked", parkedReason: d0.reason, finishedAt: nowIso() }, d0.reason, { jobKey: j.jobKey });
    return runAttempt(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey, corridor: st2 ? st2.corridor : "unknown", changed: st2 ? st2.changed : null, srcFp: st2 ? st2.srcFp : null, srcHead: st2 ? st2.srcHead : null }, d0.route);
  }
  if (a.phase === "running") {
    if (a.provider !== "self") { // 유료=자동 재호출 금지(호출 여부 확인 불가)
      return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "uncertain-call", attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, phase: "parked", parkedReason: "uncertain-call", finishedAt: nowIso() } : x), finishedAt: nowIso() }, "uncertain-call", { provider: a.provider, jobKey: j.jobKey });
    }
    // self=무과금 — attempt를 failed로 접고 '같은 실행에서' 신규 attempt 재진입(3b 1차 blocker② —
    // parked로 닫으면 이후 실행이 parked noop이라 self 자동 재실행 계약 위반)
    const wF = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, phase: "failed", failReason: "interrupted(self — 재실행 허용)", finishedAt: nowIso() } : x) });
    if (!wF.ok) return park(null, "attempt-write:" + wF.reason);
    log({ route: "self", reason: "self-interrupted-rerun", outcome: "routed", jobKey: j.jobKey });
    return runAttempt(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey, corridor: "mapped", changed: null }, "self");
  }
  if (a.phase === "applying") {
    // super 전이 재개=applyItems 위임(3차 blocker① — 여기서 rev만 전진 기록하면 currentPatch·super 부재의
    // rev>0 상태가 strict 장부에 거부된다: applyItems의 super 경로가 expire→재변환→전진을 '한 원자 기록'으로 수행).
    // cursor 복구: currentPatch 존재+decision에 patchId 실존=ⓑ 보충
    if (a.cursor && !a.cursor.super && a.cursor.currentPatch) {
      const idxR = MP.decisionIndexFor(repo, j.mapId);
      const seen9 = idxR.st === "ok" && (idxR.projections || []).some((d9) => d9.patchId === a.cursor.currentPatch.patchId);
      if (seen9) {
        const wB = fencedUpdateEnrichJob(repo, env.fence, (jj) => jj && { ...jj, attempts: jj.attempts.map((x) => x.attemptId === a.attemptId ? { ...x, cursor: { nextIndex: x.cursor.nextIndex + 1, rev: 0, appliedPatchIds: [...x.cursor.appliedPatchIds, x.cursor.currentPatch.patchId] } } : x) });
        if (!wB.ok) return park(null, "cursor-write:" + wB.reason);
      }
      // 미실존=applyItems가 저장본 재투입(propose 멱등)→상태표대로 진행
    }
    return applyItems(repo, o, env, { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey }, a.attemptId);
  }
  // failed(승격 판단 중 사망)=driveAttempts 재진입 — 실패 플래그 복원
  if (a.phase === "failed") {
    // 명시 재시도 이후의 실패만 라우팅 입력으로 쓴다 — 지난 세대의 실패가 남아 새 호출을 막지 않게(2차 blocker①).
    const from9 = Number.isInteger(j.retryFrom) ? j.retryFrom : 0;
    const eF = j.attempts.some((x) => x.attemptId >= from9 && x.provider === "economy" && x.phase === "failed");
    const pF = j.attempts.some((x) => x.attemptId >= from9 && x.provider === "precision" && x.phase === "failed");
    const cor = st2 && st2.corridor ? st2.corridor : "unknown"; // ⑦a 산출값(3차 — 재개도 라우팅 재료 보유)
    const d = env.MRt.decideRoute({ mode: j.mode, ready: o.readiness, corridor: cor, economyFailed: eF, precisionFailed: pF, conflict: false });
    if (d.route === "park") return park((jj) => jj && { ...jj, phase: "parked", parkedReason: d.reason, finishedAt: nowIso() }, d.reason, { jobKey: j.jobKey });
    // 재개에서 새 시도까지 실패하면 **라우터를 다시 태워** 종결한다.
    //  · 그냥 돌려주면 작업이 open으로 남아 화면이 '진행 중'이라 말한다(3차 blocker①).
    //  · 그렇다고 곧바로 park하면 자동형의 '경제형 실패 → 정밀형 승격'이 막힌다(4차 blocker①).
    // 그래서 driveAttempts와 같은 규칙으로 다음 담당을 정하고, park일 때만 멈춘다.
    let eF2 = eF, pF2 = pF, route2 = d.route, lastP10R = null;
    const stR = { topo: st2.topo, idx: st2.idx, pol: st2.pol, ah: st2.ah, jobKey: j.jobKey, corridor: cor, changed: st2 ? st2.changed : null, srcFp: st2 ? st2.srcFp : null, srcHead: st2 ? st2.srcHead : null };
    const parkR = (rn, prov) => {
      if (env.p10 && lastP10R) env.p10.reasonCode = lastP10R; // 성공하면 실패 사유를 남기지 않는다(5차 blocker①)
      return park((jj) => jj && { ...jj, phase: "parked", parkedReason: rn, finishedAt: nowIso() }, rn, { jobKey: j.jobKey, provider: prov });
    };
    for (let guard = 0; guard < 4; guard++) {
      // 상태를 바꾸기 전에 실행 잠금 소유를 다시 확인한다(5차 blocker② — 기존 루프와 같은 불변식).
      if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" };
      const at2 = runAttempt(repo, o, env, stR, route2);
      if (!at2 || at2.outcome !== "provider-failed") return at2;
      if (at2._p10Reason) lastP10R = at2._p10Reason; // park할 때만 반영
      if (route2 === "economy") eF2 = true;
      else if (route2 === "precision") pF2 = true;
      else return parkR("self-failed", route2);
      if (env.fence && !env.fence()) return { outcome: "busy", reason: "run-lock-lost" };
      const dn = env.MRt.decideRoute({ mode: j.mode, ready: o.readiness, corridor: cor, economyFailed: eF2, precisionFailed: pF2, conflict: false });
      // 승격을 고른 이유도 감사에 남긴다(5차 [보완] — 기존 루프와 같은 형태).
      log({ route: dn.route, reason: dn.reason, corridor: cor, changedCount: Array.isArray(stR.changed) ? stR.changed.length : null, jobKey: j.jobKey, escalated: eF2 && dn.route === "precision" });
      if (dn.route === "park" || dn.route === "adjudicate") return parkR(dn.route === "park" ? dn.reason : "adjudicate-unreachable", route2);
      route2 = dn.route;
    }
    return parkR("route-loop-guard", route2);
  }
  return park((jj) => jj && { ...jj, phase: "parked", parkedReason: "attempt-state:" + a.phase, finishedAt: nowIso() }, "attempt-state");
}

// ── CLI 진입점(증분 4 — 발동 3지점이 공용으로 spawn하는 실행 표면) ────────────────
// node bridge/map-enrich.js run <repo> [--ws <ws>] [--slot ko|en] [--trigger <t>]
// 어댑터·Verifier 진입점은 bridge/enrich-providers.js에서 로드한다(설치본에도 함께 배포되므로 마켓
// 설치본에서도 실행된다 — 옛 주석의 'scripts/ 전용·비배포' 설명은 P8에서 이동하며 무효가 됐다).
// 파일이 없으면 adapter-missing park(설치가 온전하지 않다는 뜻). mode·readiness는 P7 뷰로 산출.
function cliMain(argv) {
  const cmd = argv[2];
  if (cmd !== "run" || !argv[3]) { process.stderr.write("사용: node bridge/map-enrich.js run <repo> [--ws <ws>] [--slot ko|en] [--trigger <t>]\n"); return 2; }
  const repo = argv[3];
  const arg = (k, d) => { const i = argv.indexOf(k); return i > 0 && argv[i + 1] ? argv[i + 1] : d; };
  const ws = arg("--ws", repo);
  const slot = arg("--slot", "ko") === "en" ? "en" : "ko";
  const trigger = arg("--trigger", "cli");
  // mode·readiness(P7 뷰 — precision 지문은 실행 해석 보유 시 주입·self는 기록 상태만[보수])
  const mode = CL.mapModeView(ws).mode;
  let precisionFpNow;
  try { const inv = require(path.join(__dirname, "codex-bridge.js")).resolveCodex(); precisionFpNow = CL.precisionExecFp(inv); } catch { precisionFpNow = undefined; }
  const rv = CL.mapReadinessView({ precisionFpNow });
  const readiness = { selfReady: rv.self.ok === true, economyReady: rv.economy.ok === true, precisionReady: rv.precision.ok === true, autoReady: rv.auto.ok === true };
  // 어댑터·verifier 로드(repo 실행 전용 — 부재는 실행기가 adapter-missing park로 정직 처리)
  let adapters = {}, askVerifier;
  try {
    const EP = require(path.join(__dirname, "enrich-providers.js")); // bridge 계층(설치본 실존 — 증분 4 1차 blocker⑤)
    adapters = EP.ENRICH_ADAPTERS;
    askVerifier = EP.askVerifierResolution;
  } catch { adapters = {}; askVerifier = undefined; }
  const r = runEnrich(repo, { ws, slot, mode, readiness, adapters, askVerifier, trigger });
  process.stdout.write(JSON.stringify(r) + "\n");
  return r.outcome === "applied" || r.outcome === "settled" || r.outcome === "noop" ? 0 : r.outcome === "busy" ? 3 : 1;
}

module.exports = { ENRICH_DIR, answerableInput, detFileNodeId, enrichTempIdMap, applyEnrichPayloadIds, fileNodePathKey, readConsumedBaseline, writeConsumedBaseline, expandChangedWithConsumedDelta, consumedFileFor, repoKeyFor, consentFileFor, jobFileFor, deferredFileFor, readEnrichConsent, grantEnrichConsent, revokeEnrichConsent, findGrant, readEnrichJob, updateEnrichJob, readDeferred, deferredSummary, enrichOutcomeSummary, recoverDeferredCalls, beginDeferredCall, finishDeferredCall, retryDeferredResolutions, jobKeyOf, jobSeedOf, jobRunIdOf, detPatchId, validateEnrichResult, toPatchV2, evidenceKindOf, appendRouteLog, historylessChanges, computeSourceFp, runEnrich, cliMain, ROUTE_LOG, JOB_PHASES, ATTEMPT_PHASES, ENRICH_TARGET_OPS };

if (require.main === module) process.exit(cliMain(process.argv));
