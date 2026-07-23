"use strict";
/*
 * P4 증분 3 — 공용 reader API·freshness 판정기·slice 동봉·게이트 준비(설계 동결 v8 P4-1·3·4·5).
 *
 * 계약 요지:
 * - readMapProjection(repoRoot): withMapLock '안'에서는 권위 상태·topology·decision index·policy frontier·
 *   bindings '원문 캡처+canonical 지문 계산'만 — anchor/evidence 실해시·freshness·렌더·캐시 IO는 전부 잠금
 *   밖(writer 기아 방지). 이미 map lock을 보유한 콜백 안에서 이 public reader 호출 금지(재진입 불가).
 *   권위 세대(marker/receipt canonical 지문)는 잠금 진입 전후 캡처·비교 — 달라지면 폐기·재시도 1회 후
 *   {ok:false, source:"error", reason:"authority-flap"}. 잠금 실패={ok:false, source:"error", reason:"lock"}.
 *   반환 discriminated union: ok:true source:"v2"(authorityHash·decisionContextHash·mapId·nodes·edges·
 *   approved·degraded 필수) / "legacy"(v2 해시=null 고정) / "none"(빈 projection) / ok:false
 *   source:"blocked"(권위·legacy 데이터 모두 금지 — 사유만) | "error"(reason: lock|authority-flap).
 *   blocked=legacy 폴백 금지(권위 역행 차단). node·edge 모두 effectiveConfidence+provenance 4검사 탈락분은
 *   degraded로 분리(dangling decision edge가 slice·P8로 새지 않게).
 * - deriveFreshness(repoRoot, projection): 항상 읽기 시점 유도·비저장. fresh=두 축 모두 불변일 때만 —
 *   ⓐanchor축(node만)=현재 내용 지문==로컬 기준선(mfresh a:·basisDecisionId 결속·부재=unknown·reader는
 *   기준선을 절대 쓰지 않음) ⓑevidence축=decision evidenceFps 실대조(HEAD 비교는 단축 아님). 부재 파일은
 *   기준선 훅과 같은 missing sentinel 규약으로 대조(검증 당시 부재였고 지금도 부재=불변). 경계 이탈·판독
 *   불가·provenance 부재=unknown(표시 전용·차단 없음). e: 캐시는 비권위 갱신만(fresh 증명 사용 금지).
 * - buildMapAttach(ws, c, lang): 2트랙 게이트 최선행. source=v2가 아니면(legacy/none/blocked/판독 실패·예외
 *   전부) 기존 buildScoutAttach에 그대로 위임(출력 바이트 동일 — cutover 전 무회귀). v2에서만 slice 렌더 —
 *   envelope은 현행과 동일한 {text, mapItems, couplings}(healthLine 별도 필드 금지).
 * - mapGateAssessFor(repoRoot): P4-5 '비활성 준비' — cutover(P3b) 전 어떤 런타임 경로도 호출하지 않는다.
 *   변환 규칙: 정상 판독+projection 부재=no-map / blocked·authority-flap·판독 불가=unknown(무차단·fail-open) /
 *   변경 파일 판독은 {ok, paths} 분리(실패=unknown 무차단) / 변경 있음·어느 anchor에도 미연결=stale /
 *   clean=관련 effective node와 edge '전체' 집계 / 변경 있음=seed node+인접 edge+evidence 직접 일치 edge 집계.
 *   집계 우선순위: stale>unknown>fresh. edge=anchor축 N/A(evidence축만 — 전 edge unknown 고정 역오류 금지).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const CL = require(path.join(__dirname, "contract-lib.js"));
const MR = require(path.join(__dirname, "map-runtime.js"));
const MP = require(path.join(__dirname, "map-pipeline.js"));
const MB = require(path.join(__dirname, "map-bindings.js"));
const MF = require(path.join(__dirname, "map-freshness.js"));
const PM = MR.PM;

const sha1 = (t) => crypto.createHash("sha1").update(t).digest("hex");
const missingFpOf = (rel) => sha1("__missing__" + rel); // 기준선 훅·evidenceFps와 동일 규약(map-pipeline)

// ── 권위 세대 지문(generation token) — marker 바이트+참조 receipt 바이트의 canonical 지문 ────────────
// authorityStateFor의 st/mapId 비교만으로는 cutover 창(교체 중간)을 못 잡는다(설계 3차 blocker③) —
// 파일 바이트 자체를 지문화해 잠금 전후로 비교한다. 부재·판독 불가도 구분되는 sentinel로.
function authorityGenTokenFor(repo) {
  const tok = [];
  for (const rel of ["authority.json"]) {
    const f = path.join(repo, "project-map", rel);
    try { tok.push(rel + ":" + sha1(fs.readFileSync(f))); }
    catch (e) { tok.push(rel + ":" + (e && e.code === "ENOENT" ? "absent" : "unreadable")); }
  }
  // receipt 디렉터리: 파일 목록+각 바이트 지문(적으므로 전수 — cutover는 일생 소수 회)
  try {
    const dir = path.join(repo, "project-map", "authority-history");
    const files = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort();
    for (const f of files) {
      try { tok.push("h/" + f + ":" + sha1(fs.readFileSync(path.join(dir, f)))); }
      catch { tok.push("h/" + f + ":unreadable"); }
    }
  } catch (e) { tok.push("history:" + (e && e.code === "ENOENT" ? "absent" : "unreadable")); }
  return sha1(tok.join("|"));
}

// ── P4-1 공용 reader ─────────────────────────────────────────────────────────────
// _testHooks(테스트 전용·프로덕션 미사용): { afterCapture(attempt) } — 잠금 해제 직후·세대 재검사 직전 호출
// (authority-flap·캡처 스냅샷 원자성의 실행 반례용 주입점 — 로직 분기 없음).
function readMapProjection(repoRoot, _testHooks) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const genBefore = authorityGenTokenFor(repoRoot);
    // 잠금 안: '원문 바이트 캡처만'(파싱·검증·해시·조립 전부 잠금 밖 — 1차 blocker②: decision 전 파일 파싱이
    // 잠금 안에 있으면 이력이 큰 저장소에서 writer가 40×15ms 재시도 후 timeout하는 기아).
    const lk = MR.withMapLock(repoRoot, () => {
      const cap = { authority: MB.captureAuthorityRaw(repoRoot) };
      try { cap.topoRaw = { st: "ok", raw: fs.readFileSync(path.join(repoRoot, "project-map", "topology.json"), "utf8") }; }
      catch (e) { cap.topoRaw = { st: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
      cap.decisions = MP.captureDirRaw(path.join(repoRoot, "project-map", "decisions"));
      cap.policies = MP.captureDirRaw(path.join(repoRoot, "project-map", "policies"));
      try { cap.bindingsRaw = { st: "ok", raw: fs.readFileSync(MB.bindingsFileFor(repoRoot), "utf8") }; }
      catch (e) { cap.bindingsRaw = { st: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
      return cap;
    });
    if (!lk.ok) return { ok: false, source: "error", reason: "lock", detail: lk.error };
    if (_testHooks && typeof _testHooks.afterCapture === "function") _testHooks.afterCapture(attempt);
    const genAfter = authorityGenTokenFor(repoRoot);
    if (genBefore !== genAfter) { if (attempt === 0) continue; return { ok: false, source: "error", reason: "authority-flap" }; }
    const cap = lk.result;
    // 잠금 밖: 파싱·판정 — 전부 '같은 캡처 세트'에서(marker↔topology mapId 원자 대조 포함: 1차 blocker①.
    // For 계열의 독립 재판독은 두 판독 사이 비협조 편집이 세대 A marker+세대 B projection을 만들 수 있었다).
    let topoParsed;
    if (cap.topoRaw.st !== "ok") topoParsed = { st: cap.topoRaw.st };
    else { try { const t9 = JSON.parse(cap.topoRaw.raw); topoParsed = t9 && typeof t9 === "object" && !Array.isArray(t9) ? { st: "ok", topo: t9 } : { st: "invalid" }; } catch { topoParsed = { st: "invalid" }; } } // 3차 blocker: JSON null·배열·원시값=invalid(권위 대조 전 안전 판정 — 예외 이탈 금지)
    const auth = MB.authorityStateFromCapture(cap.authority, topoParsed);
    if (auth.st === "blocked") return { ok: false, source: "blocked", reason: auth.reason, reasonKey: auth.reasonKey }; // P3b 공통 (f)
    if (auth.st === "legacy") {
      const src = MB.legacySourceFor(repoRoot);
      if (src && src.err) return { ok: false, source: "blocked", reason: src.err, reasonKey: "legacy-source-unreadable" }; // 판독 실패≠부재
      if (!src) return { ok: true, source: "none", mapId: null, authorityHash: null, decisionContextHash: null, nodes: [], edges: [], approved: [], degraded: [], decisions: [] };
      return { ok: true, source: "legacy", mapId: null, authorityHash: null, decisionContextHash: null, nodes: [], edges: [], approved: [], degraded: [], decisions: [] }; // legacy 데이터는 소비처가 기존 경로로(폴백 아님 — 위임)
    }
    const topo = topoParsed.topo;
    { const ve = PM.validateTopology(topo); if (ve.length) return { ok: false, source: "blocked", reason: "topology 스키마 위반: " + ve[0], reasonKey: "topology-invalid" }; } // 2차 blocker①: 손상 정본이 '빈 정상 지도'로 승인되는 경로 차단
    const idx = MP.decisionIndexFromCapture(cap.decisions, topo.mapId);
    const pol = MP.policyStateFromCapture(cap.policies, topo.mapId);
    if (idx.st === "error") return { ok: false, source: "blocked", reason: "decision 색인 판독 실패", reasonKey: "decision-index-unreadable" };
    if (pol.st !== "ok") return { ok: false, source: "blocked", reason: "정책 frontier 판독 실패", reasonKey: "policy-frontier-unreadable" };
    const rb = MB.readBindingsFromRaw(cap.bindingsRaw, topo.mapId);
    if (rb.st !== "ok") return { ok: false, source: "blocked", reason: "bindings.json " + rb.st, reasonKey: "bindings-unreadable" }; // 1차 blocker③: 판독 실패가 빈 approved로 은폐 금지
    const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
    const dch = PM.decisionContextHashOf(ah, pol.pfh);
    // effective 판정(evidence 실해시 포함) — 안전 판독기(경로 경계+심링크 거부) 경유·호출 내 메모
    const memo = new Map();
    const fh = (ref) => {
      if (memo.has(ref)) return memo.get(ref);
      const r = MF.readRepoFileSafe(repoRoot, ref);
      const v = r.ok ? sha1(r.buf) : r.reason === "absent" ? missingFpOf(ref) : null; // 부재=sentinel(evidenceFps 규약)·경계/판독불가=null
      memo.set(ref, v);
      return v;
    };
    const idxForEff = { st: "ok", projections: idx.st === "ok" ? idx.projections : [] };
    const nodes = [], edges = [], degraded = [];
    for (const [list, kind, out] of [[topo.nodes || [], "node", nodes], [topo.edges || [], "edge", edges]]) {
      for (const ent of list) {
        const eff = PM.effectiveConfidenceOf(ent, topo.mapId, idxForEff, fh);
        if (eff.degraded) { degraded.push({ id: ent.id, kind, reason: eff.degraded }); continue; }
        out.push({ ...ent, effectiveConfidence: eff.confidence });
      }
    }
    // approved — 같은 캡처 세트의 bindings 스냅샷에서
    const approved = [];
    for (const b of rb.data.bindings) {
      const k = MB.findTarget(topo, b.targetId);
      const ent = (topo.nodes || []).find((n) => n.id === b.targetId) || (topo.edges || []).find((e) => e.id === b.targetId);
      const lc = ent && ent.state ? ent.state.lifecycle : null;
      for (const o of b.originals) approved.push({ text: o.text, date: o.date, from: o.from, targetId: b.targetId, stale: k === null || k !== b.kind, lifecycle: lc });
    }
    return {
      ok: true, source: "v2", mapId: topo.mapId, authorityHash: ah, decisionContextHash: dch,
      nodes, edges, approved, degraded,
      decisions: idxForEff.projections, // 판정 재료(deriveFreshness — 같은 스냅샷)
    };
  }
  return { ok: false, source: "error", reason: "authority-flap" }; // 도달 불가(위 attempt 루프가 반환) — 방어
}

// ── P4-3 유도 판정기 ─────────────────────────────────────────────────────────────
// 반환: [{id, kind:"node"|"edge", state:"fresh"|"stale"|"unknown", reason}] — 표시 전용·차단 없음.
function deriveFreshness(repoRoot, projection) {
  if (!projection || projection.ok !== true || projection.source !== "v2") return [];
  const store = MF.readFreshnessFor(repoRoot, projection.mapId);
  const byDecision = new Map((projection.decisions || []).map((d) => [d.decisionId, d]));
  const memo = new Map(); // 호출 내 중복 해시 회피(파일당 1회 — '캐시'가 아니라 메모·판정은 항상 실해시)
  const cacheUp = {}; // e:<entityUUID>|<rel> 비권위 캐시 재료(fresh 증명 사용 금지 — 기록만)
  const sizeMt = new Map();
  const NOW_ISO = new Date().toISOString();
  const curFpOf = (rel, entId) => {
    let v;
    if (memo.has(rel)) v = memo.get(rel);
    else {
      const r = MF.readRepoFileSafe(repoRoot, rel);
      if (r.ok) { v = sha1(r.buf); sizeMt.set(rel, { size: r.size, mtimeMs: r.mtimeMs }); }
      else if (r.reason === "absent") v = missingFpOf(rel); // 검증 당시 부재+지금도 부재=불변(sentinel 규약 대조)
      else v = null; // 경계 이탈·symlink·판독 불가=unknown 재료
      memo.set(rel, v);
    }
    if (v !== null && entId) {
      const sm = sizeMt.get(rel);
      cacheUp["e:" + entId + "|" + rel] = { fp: v, seenAt: NOW_ISO, ...(sm ? { size: sm.size, mtimeMs: sm.mtimeMs } : {}) };
    }
    return v;
  };
  const out = [];
  for (const [list, kind] of [[projection.nodes || [], "node"], [projection.edges || [], "edge"]]) {
    for (const ent of list) {
      const prov = ent.provenance;
      if (!prov || !prov.decisionId) { out.push({ id: ent.id, kind, state: "unknown", reason: "provenance 부재(검증 전이 이전)" }); continue; }
      const dec = byDecision.get(prov.decisionId);
      let state = "fresh", reason = "anchor·evidence 두 축 불변";
      // ⓑ evidence축(node·edge 공통): decision evidenceFps 실대조
      const evFps = dec && Array.isArray(dec.evidenceFps) ? dec.evidenceFps : null;
      if (!evFps) { state = "unknown"; reason = "decision evidence 지문 판독 불가"; }
      else {
        for (const e of evFps) {
          const cur = curFpOf(e.ref, ent.id);
          if (cur === null) { if (state !== "stale") { state = "unknown"; reason = "evidence 판독 불가/경계 이탈: " + e.ref; } continue; }
          if (cur !== e.contentHash) { state = "stale"; reason = "evidence 변경: " + e.ref; break; }
        }
      }
      // ⓐ anchor축(node만 — edge는 N/A): 로컬 기준선(a:) 대조. 기준선은 절대 쓰지 않는다(읽기만).
      if (kind === "node" && state !== "stale") {
        const anchors = (ent.anchors || []).filter((a) => a && a.path);
        for (const a of anchors) {
          const base = store.entries["a:" + ent.id + "|" + a.path];
          if (!base || base.basisDecisionId !== prov.decisionId) { if (state !== "stale") { state = "unknown"; reason = "anchor 기준선 부재/세대 불일치: " + a.path; } continue; }
          const cur = curFpOf(a.path, ent.id);
          if (cur === null) { if (state !== "stale") { state = "unknown"; reason = "anchor 판독 불가/경계 이탈: " + a.path; } continue; }
          if (cur !== base.fp) { state = "stale"; reason = "anchor 변경: " + a.path; break; }
        }
      }
      out.push({ id: ent.id, kind, state, reason });
    }
  }
  // e: 캐시 갱신(비권위 writer — mergeWrite가 a:는 swap 없이는 거부·잠금 실패=무해 skip·판정 정확성 불변)
  try { if (Object.keys(cacheUp).length) MF.mergeWrite(repoRoot, projection.mapId, cacheUp, { tries: 1 }); } catch { /* 무해 */ }
  return out;
}

// ── P4-4 slice 동봉(scout-attach 표면) ──────────────────────────────────────────
// blocked/error 사유의 ko/en 표(P3b 공통 (f) — reasonKey 번역·미지 키=원문 폴백).
const ATTACH_REASON_KO = { "history-without-marker": "전환 이력 존재+표식 부재", "authority-unreadable": "전환 표식 판독 불가", "authority-format": "전환 표식 형식 위반", "authority-mapid-mismatch": "전환 표식 세대 불일치", "topology-unreadable": "지도 정본 판독 불가", "topology-invalid": "지도 정본 형식 위반", "receipt-unbound": "전환 영수증 부재/손상", "marker-fp-mismatch": "표식 지문 불일치", "legacy-source-unreadable": "확정층 판독 불가", "decision-index-unreadable": "결정 색인 판독 불가", "policy-frontier-unreadable": "정책 판독 불가", "bindings-unreadable": "결속 파일 판독 불가", "bindings-stale": "결속 파일 세대 불일치", lock: "잠금 경합", "authority-flap": "권위 세대 변동", "map-md-absent": "생성 뷰(MAP.md) 부재", "map-md-unreadable": "생성 뷰(MAP.md) 판독 불가", "entry-text-required": "승격 문구 누락", "active-wal": "적용 중 기록(WAL) 존재", "live-actionref-invalid": "승인 출처 표기 오류", "live-approvedat-invalid": "승인 시각 형식 오류", "live-upsert-failed": "승인 후보 기록 실패", "live-rejected": "승인 후보 기록 거부(상한/손상)", "candidate-lookup-failed": "후보 조회 실패", "binding-target-gone": "결속 대상 소멸(재결속 필요)", "no-evidence": "증거 경로 없음(code/test/config)", "resolved-without-evidence": "종결 제안과 증거 불일치(진단 필요)", "propose-conflict": "제안 충돌", "propose-failed": "제안 기록 실패", "trace-unreadable": "전환 흔적 판독 불가(권한 확인 필요)", "runtime-outdated": "MAP 런타임 낡음(node install.js 필요)" };
const ATTACH_REASON_EN = { "history-without-marker": "cutover history exists but marker is missing", "authority-unreadable": "authority marker unreadable", "authority-format": "authority marker malformed", "authority-mapid-mismatch": "authority marker generation mismatch", "topology-unreadable": "topology unreadable", "topology-invalid": "topology schema violation", "receipt-unbound": "cutover receipt missing/corrupt", "marker-fp-mismatch": "marker fingerprint mismatch", "legacy-source-unreadable": "stable ledger unreadable", "decision-index-unreadable": "decision index unreadable", "policy-frontier-unreadable": "policy frontier unreadable", "bindings-unreadable": "bindings file unreadable", "bindings-stale": "bindings file from a previous generation", lock: "lock contention", "authority-flap": "authority generation flapped", "map-md-absent": "generated view (MAP.md) missing", "map-md-unreadable": "generated view (MAP.md) unreadable", "entry-text-required": "promotion text missing", "active-wal": "active write-ahead log present", "live-actionref-invalid": "approval action tag invalid", "live-approvedat-invalid": "approval timestamp invalid", "live-upsert-failed": "failed to store the approval candidate", "live-rejected": "approval candidate refused (cap/corruption)", "candidate-lookup-failed": "candidate lookup failed", "binding-target-gone": "binding target gone (rebind needed)", "no-evidence": "no evidence paths (code/test/config)", "resolved-without-evidence": "resolved proposal without target evidence (needs diagnosis)", "propose-conflict": "proposal conflict", "propose-failed": "failed to record the proposal", "trace-unreadable": "cutover trace unreadable (check permissions)", "runtime-outdated": "MAP runtime outdated (run node install.js)" };
function attachReasonText(key, raw, en) { return (en ? ATTACH_REASON_EN : ATTACH_REASON_KO)[key] || raw || key || (en ? "unknown" : "미상"); }
const reasonTextFor = attachReasonText; // P3b 공통 (f) — CLI·소비 표면 공용 번역기(단일 출처 재수출)
const REASON_KEYS = Object.keys(ATTACH_REASON_KO); // 표 동기화 대조용(테스트가 소비 표면 로컬 표와 집합 대조)
// ── 공통 (a) 원시 3상태 판독기(단일 출처 — 4표면 3카피 제거·구현검증 3차 #2): 판독 오류=unreadable(부재 축소 금지).
// deps 주입=실행 반례용(EACCES 등 — 프로덕션은 기본 fs).
function cutoverTraceStateOf(repo, deps) {
  const st = (deps && deps.statSync) || fs.statSync;
  const rd = (deps && deps.readdirSync) || fs.readdirSync;
  const one = (p) => {
    try {
      const s = st(p);
      if (s.isFile()) return "present";
      if (s.isDirectory()) { try { return rd(p).length > 0 ? "present" : "absent"; } catch { return "unreadable"; } }
      return "absent";
    } catch (e) { return e && e.code === "ENOENT" ? "absent" : "unreadable"; }
  };
  const a = one(path.join(repo, "project-map", "authority.json"));
  const b = one(path.join(repo, "project-map", "authority-history"));
  if (a === "present" || b === "present") return "present";
  if (a === "unreadable" || b === "unreadable") return "unreadable";
  return "absent";
}
function buildMapAttach(ws, c, lang) {
  if (!ws || CL.normScoutMode(c) !== "on") return null; // 2트랙 게이트 최선행(출력 0·reader 미호출)
  let proj = null;
  try { proj = module.exports.readMapProjection(CL.resolveScoutRepo(ws, c).repo); } catch { proj = null; } // exports 경유 — 테스트가 호출 수를 실측(2트랙 미호출 증명)
  // P3b 공통 (b) 개정(설계검증 2차 #2): legacy/none '판정 확인'시에만 기존 동봉 위임(바이트 동일).
  // blocked·error(lock/flap)·예외=marker 세대 판정 불가/차단 — legacy 데이터 공급 금지·고지 attach(무차단).
  if (proj && proj.ok === true && proj.source === "v2") return renderV2Slice(ws, c, lang, proj);
  if (proj && proj.ok === true && (proj.source === "legacy" || proj.source === "none")) return CL.buildScoutAttach(ws, c, lang);
  const en = lang === "en" || (lang !== "ko" && CL.loadLang() === "en");
  const why = attachReasonText(proj && proj.reasonKey, proj && proj.reason, en);
  return {
    text: en
      ? "[Project MAP] Unreadable right now (" + why + ") — no map slice attached this time (advisory only; not a verdict rule)."
      : "[Project MAP] 지금은 판독 불가(" + why + ") — 이번에는 지도 조각을 동봉하지 않습니다(참고 정보일 뿐 판정 기준 아님).",
    mapItems: [], couplings: [],
  };
}
// v2 slice — envelope {text, mapItems, couplings} 승계(healthLine 별도 필드 금지 — text 포함)
function renderV2Slice(ws, c, lang, proj) {
  const target = CL.resolveScoutRepo(ws, c).repo;
  const fresh = new Map(deriveFreshness(target, proj).map((f) => [f.id, f]));
  const changed = new Set(CL.changedFilesFor(target));
  const en = lang === "en" || (lang !== "ko" && CL.loadLang() === "en");
  const label = (id) => { const f = fresh.get(id); return f ? f.state : "unknown"; };
  const items = [];
  for (const nd of proj.nodes) {
    const paths = (nd.anchors || []).map((a) => a && a.path).filter(Boolean);
    const hit = paths.find((p) => changed.has(p));
    if (!hit && items.length >= 8) continue; // 변경 연결 우선·상한 8
    if (paths.length) items.push({ path: hit || paths[0], note: (nd.label || "") + " · " + label(nd.id), _hit: !!hit });
  }
  items.sort((a, b) => (a._hit === b._hit ? 0 : a._hit ? -1 : 1));
  const top = items.slice(0, 8).map(({ path: p, note }) => ({ path: p, note }));
  if (!top.length) return CL.buildScoutAttach(ws, c, lang); // slice가 비면 기존 동봉으로(무손실)
  let couplings = [];
  try { couplings = CL.ledgerCouplingCandidates(target, 3); } catch { couplings = []; }
  // edge 동봉(1차 blocker⑥ — 설계: '연결된 node/edge'): 동봉 node의 인접 edge를 effective만·신선도
  // 라벨과 함께 text에 실음(mapItems 계약 {path,note}는 파일 단위라 edge는 text 라인으로 — envelope 불변).
  const shownIds = new Set(proj.nodes.filter((nd) => (nd.anchors || []).some((a) => a && top.some((t) => t.path === a.path))).map((nd) => nd.id));
  const labelOf = new Map(proj.nodes.map((nd) => [nd.id, nd.label || nd.id.slice(0, 8)]));
  const edgeLines = proj.edges
    .filter((e) => shownIds.has(e.from) || shownIds.has(e.to))
    .slice(0, 6)
    .map((e) => "- [edge] " + (labelOf.get(e.from) || e.from.slice(0, 8)) + " -> " + (labelOf.get(e.to) || e.to.slice(0, 8)) + (e.relation ? " (" + e.relation + ")" : "") + " · " + label(e.id));
  const head = en
    ? "[Project MAP slice · advisory — not a verdict rule] Confirmed-structure nodes/edges connected to this change (freshness per item):"
    : "[Project MAP 조각 · 참고 — 판정 기준 아님] 이번 변경과 연결된 확정 구조 node/edge(항목별 신선도):";
  const health = CL.scoutHealthLine(target, en);
  const text = [head, ...top.map((i) => `- ${i.path}${i.note ? ` — ${i.note}` : ""}`), ...edgeLines, ...(health ? [health] : [])].join("\n");
  return { text, mapItems: top, couplings };
}

// ── P4-5 게이트 준비(비활성 — cutover 전 어떤 런타임 경로도 호출하지 않는다) ────────────────
// 변경 파일 판독을 {ok, paths}로 분리 — git 실패·timeout이 clean으로 위장되지 않게(설계 3차 blocker②).
function gitChangedEx(repo, opts) {
  try {
    // opts.untrackedAll(P8 3b 4차): 미추적 디렉터리를 dir/ 하나로 축약하지 않고 내부 파일까지 열거(-uall) —
    // 소스 지문(sourceFp)이 디렉터리 내부 변경을 식별해야 하는 소비처 전용. 기본 동작 불변(무회귀).
    const args = ["-c", "safe.directory=" + String(repo).replace(/\\/g, "/"), "-C", repo, "status", "--porcelain"];
    if (opts && opts.untrackedAll) args.push("-uall");
    args.push("-z");
    const r = spawnSync("git", args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (r.status !== 0 || r.error) return { ok: false, paths: [], truncated: false };
    const toks = String(r.stdout || "").split("\0");
    const paths = [];
    let truncated = false;
    const CAP = 1000;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t || t.length < 4) continue;
      if (paths.length >= CAP) { truncated = true; break; } // 1차 blocker⑤: 초과분을 성공(전수)으로 위장하지 않는다
      paths.push(t.slice(3));
      if (/[RC]/.test(t.slice(0, 2))) i++;
    }
    return { ok: true, paths, truncated };
  } catch { return { ok: false, paths: [], truncated: false }; }
}
function mapGateAssessFor(repoRoot) {
  let proj = null;
  try { proj = readMapProjection(repoRoot); } catch { proj = null; }
  if (!proj) return gateResult("unknown", "reader 예외(무차단)", false);
  // P3b(설계검증 2차 #6): blocked를 unknown으로 뭉개지 않고 별도 state — 소비처가 구분 소비(여전히 무차단).
  if (proj.ok !== true && proj.source === "blocked") return gateResult("blocked", "권위 판독 차단(" + (proj.reason || "") + ") — 무차단", false, proj.reasonKey);
  if (proj.ok !== true) return gateResult("unknown", "판독 불가/" + proj.source + "(" + (proj.reason || "") + ") — 무차단", false, proj.reasonKey); // flap·lock=fail-open
  if (proj.source === "none" || proj.source === "legacy") return gateResult("no-map", "Project MAP projection 부재(" + proj.source + ")", false);
  const ch = module.exports.gitChangedEx(repoRoot); // exports 경유 — 절단 반례 테스트가 스텁 주입 가능
  if (!ch.ok) return gateResult("unknown", "변경 파일 판독 실패(무차단)", true);
  const fresh = deriveFreshness(repoRoot, proj);
  const stateOf = new Map(fresh.map((f) => [f.id, f.state]));
  const agg = (ids) => { // 집계 우선순위: stale>unknown>fresh
    let hasUnknown = false;
    for (const id of ids) { const s = stateOf.get(id) || "unknown"; if (s === "stale") return "stale"; if (s === "unknown") hasUnknown = true; }
    return hasUnknown ? "unknown" : "fresh";
  };
  const withCap = (st9, why9) => (ch.truncated && st9 === "fresh" ? gateResult("unknown", "변경 목록 절단(전수 아님) — fresh 주장 금지·무차단", true) : gateResult(st9, why9 + (ch.truncated ? " · 변경 목록 절단(부분)" : ""), true)); // 1차 blocker⑤: 절단 시 false-fresh 차단
  if (ch.paths.length === 0) return withCap(agg([...proj.nodes.map((n) => n.id), ...proj.edges.map((e) => e.id)]), "clean — 관련 effective node·edge 전체 집계");
  // 변경 있음: seed node(anchor가 변경 파일과 일치)+인접 edge+evidence 직접 일치 edge
  const changed = new Set(ch.paths);
  const seed = proj.nodes.filter((n) => (n.anchors || []).some((a) => a && changed.has(a.path)));
  if (!seed.length) return withCap("stale", "변경 파일이 어느 anchor에도 미연결 — 지도가 이 변경을 모름(갱신 유도)");
  const seedIds = new Set(seed.map((n) => n.id));
  const evOf = new Map((proj.decisions || []).map((d) => [d.decisionId, d.evidenceFps || []]));
  const edges = proj.edges.filter((e) => seedIds.has(e.from) || seedIds.has(e.to)
    || (e.provenance && (evOf.get(e.provenance.decisionId) || []).some((x) => changed.has(x.ref))));
  return withCap(agg([...seedIds, ...edges.map((e) => e.id)]), "변경 연결 부분 집계(seed " + seed.length + "·edge " + edges.length + ")");
}
function gateResult(state, why, active, reasonKey) {
  return {
    prepared: true, active: active === true, state, why, ...(reasonKey ? { reasonKey } : {}), // P3b: active=v2 projection 확인 시에만 true(자기신고 고정값 폐기 — 설계검증 1차 #6)
    notice: {
      ko: state === "stale" ? "플랜 확정 전에 Project MAP부터 — 지도가 이 변경을 아직 모릅니다. `node scripts/scope-map.js <저장소> refresh` 후 계속하세요."
        : state === "no-map" ? "이 프로젝트에 Project MAP projection이 아직 없습니다 — `node scripts/scope-map.js <저장소> bootstrap`으로 시작할 수 있어요."
        : "Project MAP 기준 진행 가능(" + state + ").",
      en: state === "stale" ? "Map first, before finalizing the plan — the Project MAP does not know this change yet. Run `node scripts/scope-map.js <repo> refresh`, then continue."
        : state === "no-map" ? "This project has no Project MAP projection yet — start with `node scripts/scope-map.js <repo> bootstrap`."
        : "OK to proceed on the Project MAP basis (" + state + ").",
    },
  };
}

module.exports = { readMapProjection, deriveFreshness, buildMapAttach, renderV2Slice, mapGateAssessFor, gitChangedEx, authorityGenTokenFor, reasonTextFor, REASON_KEYS, cutoverTraceStateOf };
