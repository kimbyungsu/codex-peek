/*
 * P3a — writer/reader v2 어댑터+준비 manifest (설계: docs/MAP-P3A-DESIGN.md §E)
 * 함수·테스트만 준비 — 라우팅 무변경(P3a 기간 authorityStateFor=항상 legacy·호출 전환은 P3b 원자 cutover).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CL = require(path.join(__dirname, "contract-lib.js"));
const MR = require(path.join(__dirname, "map-runtime.js"));
const MP = require(path.join(__dirname, "map-pipeline.js"));
const MB = require(path.join(__dirname, "map-bindings.js"));
const PM = MR.PM;

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const PATCH_ID_SEED = "00000000-0000-4000-8000-000000000000"; // generationFp 산출용 '빈 고정값' 자리

// ── R1 대시보드 확정층 뷰(§E — legacy=현행 동치·v2=bindings originals에서 직접) ────
function approvedViewFor(repo) {
  const auth = MB.authorityStateFor(repo);
  if (auth.st === "blocked") return { source: "blocked", approved: [], totalItems: 0, reason: auth.reason }; // 권위 데이터 반환 금지(§B)
  if (auth.st === "legacy") {
    const src = MB.legacySourceFor(repo);
    if (src && src.err) return { source: "blocked", approved: [], totalItems: 0, reason: src.err }; // 판독 실패≠부재(구현 2차 #5)
    if (!src) return { source: "legacy", approved: [], totalItems: 0 };
    const r = MB.parseApprovedCopy(src.text);
    return { source: "legacy", approved: r.approved, totalItems: r.totalItems };
  }
  // v2 — 원문은 bindings.originals 사본에서(1차 #5 — legacy 파일 역참조·label 합성 금지)
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { source: "blocked", approved: [], totalItems: 0, reason: "topology " + rt.st };
  const rb = MB.readBindingsFor(repo, rt.topo.mapId);
  if (rb.st !== "ok") return { source: "blocked", approved: [], totalItems: 0, reason: "bindings.json " + rb.st };
  const approved = [];
  for (const b of rb.data.bindings) { // readBindingsFor가 레코드 정밀 검증을 통과시킨 것만 도달(구현 1차 #3)
    const kind = MB.findTarget(rt.topo, b.targetId); // 같은 세대 소멸 재검사(2차 #5)
    const ent = (rt.topo.nodes || []).find((n) => n.id === b.targetId) || (rt.topo.edges || []).find((e) => e.id === b.targetId);
    const lc = ent && ent.state ? ent.state.lifecycle : null;
    for (const o of b.originals) approved.push({ text: o.text, date: o.date, from: o.from, targetId: b.targetId, stale: kind === null || kind !== b.kind, lifecycle: lc, retired: lc === "tombstoned" || lc === "superseded" }); // lifecycle 표시(설계 §E R1·구현 4차 #5)
  }
  return { source: "v2", approved, totalItems: approved.length };
}

// ── R2 collectCommon 재료(§E — 절단은 소비자 계약 그대로·원문만 반환) ──────────────
function mapContentFor(repo) {
  const auth = MB.authorityStateFor(repo);
  if (auth.st === "blocked") return { source: "blocked", content: null, reason: auth.reason };
  if (auth.st === "legacy") {
    const src = MB.legacySourceFor(repo);
    if (src && src.err) return { source: "blocked", content: null, reason: src.err }; // 판독 실패≠부재(구현 2차 #5)
    return { source: "legacy", content: src ? src.text : null };
  }
  try { return { source: "v2", content: fs.readFileSync(path.join(repo, "project-map", "MAP.md"), "utf8") }; }
  catch (e) { return { source: "blocked", content: null, reason: "project-map/MAP.md " + (e && e.code === "ENOENT" ? "부재(writer는 항상 생성 — 삭제/손상 의심)" : "판독 실패") }; } // 실패≠빈 내용(구현 4차 #5)
}

// ── W writer 어댑터 promoteEntry(§E-W — binding 미기록·durable proposal·6분기 합타입) ─
// entry = {text, from, approvedAt?(live), actionRef?("export"|"approve" — live 필수)}
function promoteEntry(repo, entry, opts) {
  const o = opts || {};
  if (!entry || typeof entry.text !== "string" || !entry.text.trim()) return { st: "rejected", reason: "entry.text 필수" };
  const auth = MB.authorityStateFor(repo);
  if (auth.st === "blocked") return { st: "rejected", reason: "권위 상태 blocked — " + auth.reason };
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { st: "rejected", reason: "topology " + rt.st };
  const topo = rt.topo;
  const bar = MR.pipelineBarrier(repo); // 구현 1차 #1 — barrier가 정본(unreadable fail-closed 내장)
  if (bar.blocked) return { st: "rejected", reason: "활성 pipeline WAL — recoverWal 선행(" + bar.reason + ")" };
  const sig = CL.ledgerSig(entry.text);
  const rb = MB.readBindingsFor(repo, topo.mapId);
  if (rb.st === "stale") return { st: "rejected", reason: "bindings.json이 이전 세대 — 수동 확인 필요" };
  if (rb.st !== "ok") return { st: "rejected", reason: "bindings.json " + rb.st };
  const binding = rb.data.bindings.find((x) => x.sig === sig);

  if (!binding) { // 미결속(매칭 품질 무관 — exact여도 needs-binding: 4차 #3 — 1-24 후보·확정 분리)
    const matched = MB.matchEntry(topo, entry.text);
    const liveIntent = entry.approvedAt !== undefined || entry.actionRef !== undefined; // 어느 하나라도 제시=live 합타입(구현 5차 #2 — 오타가 legacy로 조용히 강등되는 내구성 유실 차단)
    if (liveIntent) {
      if (entry.actionRef !== "export" && entry.actionRef !== "approve") return { st: "rejected", reason: "live 승인은 actionRef=export|approve 필수(받은 값: " + String(entry.actionRef) + ")" };
      if (typeof entry.approvedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(entry.approvedAt)) return { st: "rejected", reason: "live 승인은 approvedAt ISO 8601(UTC) 필수(구현 4차 #3)" };
      const g = MB.upsertLiveCandidate(repo, topo, { text: entry.text, from: entry.from || "", approvedAt: entry.approvedAt, actionRef: entry.actionRef }, matched);
      if (!g.ok) return { st: "rejected", reason: g.error };
      return g.result; // {st:"needs-binding", entry, candidateFp, match} | {st:"rejected", reason(backpressure 등)}
    }
    // legacy 항목 — 공용 판독기 경유(구현 5차 #4·6차 #1: 단순 조회는 재개 판별과 분리된 API)
    const lk = MB.lookupCandidateFpBySig(repo, topo.mapId, sig);
    if (lk.st === "error") return { st: "rejected", reason: lk.error };
    const candidateFp = lk.st === "ok" ? lk.candidateFp : null;
    return { st: "needs-binding", entry: { text: entry.text, from: entry.from || "", approvedAt: null, actionRef: null, sig }, candidateFp, match: matched.match, note: candidateFp ? undefined : "legacy-scan 후 binding-confirm 필요" };
  }

  // binding 존재 — target 생존 재검사(2차 #5·successor 자동 승계 금지)
  const kind = MB.findTarget(topo, binding.targetId);
  if (kind === null || kind !== binding.kind) return { st: "rejected", reason: "binding target 소멸/종류 불일치 — binding-rebind 필요(자동 승계 금지)" };
  const targetId = binding.targetId;
  // already-applied(5차 #5): target entity에 같은 ledger evidence 실존
  const ent = (topo.nodes || []).find((n) => n.id === targetId) || (topo.edges || []).find((e) => e.id === targetId);
  if ((ent.evidence || []).some((e) => e.kind === "ledger" && e.ref === sig)) {
    cleanupBoundLive(repo, topo.mapId, sig); // durable 확인 시 bound 후보 정리(7차 #4)
    return { st: "already-applied", targetId };
  }
  // envelope evidence — 원문 경로의 실존+분류 통과(code/test/config만 — 4차 #6)
  const srcText = (binding.originals && binding.originals[0] && binding.originals[0].text) || entry.text;
  const evRefs = [...new Set(MB.caseAwarePathsFromText(srcText).map(MB.normRelPath).filter((x) => x !== null))]
    .filter((rel) => { try { return fs.statSync(path.join(repo, rel)).isFile(); } catch { return false; } })
    .map((rel) => ({ rel, cat: MB.classifyEvidencePath(rel) }))
    .filter((x) => x.cat === "code" || x.cat === "test" || x.cat === "config");
  if (!evRefs.length) return { st: "rejected", reason: "증거 채택 0(code/test/config 경로 없음 — doc·unsupported·부재는 불가)" };
  // durable proposal — 의미 키 유일성은 proposeUnique(nsLock 임계구역)가 보장(8차 #1)
  const buildPatch = () => {
    // rebind 경합 봉합(구현 2차 #1): 잠금 안에서 bindings를 재판독해 캡처한 (sig→targetId,kind)와 대조하고,
    // '그 판독 바이트'를 readSet의 bindings.json 지문으로 결속(검증 시점=해시 시점 — 이후 rebind는 CAS가 만료)
    const bindRaw = (() => { try { return fs.readFileSync(MB.bindingsFileFor(repo), "utf8"); } catch { return null; } })();
    const rb2 = MB.readBindingsFor(repo, topo.mapId);
    if (rb2.st !== "ok") throw new Error("bindings 재판독 실패(" + rb2.st + ")");
    const b2 = rb2.data.bindings.find((x) => x.sig === sig);
    if (!b2 || b2.targetId !== targetId || b2.kind !== binding.kind) throw new Error("binding이 생성 중 변경됨(rebind 경합) — 재시도 필요");
    const idx = MP.decisionIndexFor(repo, topo.mapId);
    const pol = MP.policyStateFor(repo, topo.mapId);
    if (idx.st === "error" || pol.st === "error") throw new Error("색인/정책 판독 실패");
    const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
    const base = {
      schema: "map-patch-v2", patchId: PATCH_ID_SEED, mapId: topo.mapId,
      basis: MP.patchBasisFor(repo, topo), baseMapHash: PM.mapHashOf(topo),
      baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
      baseDirtyFp: "", operation: "add_evidence", targetId,
      payload: { evidence: { kind: "ledger", ref: sig } }, // 3차 #7 — PAYLOAD_KEYS_V2(evidence)
      readSet: { files: [{ ref: "project-map/bindings.json" }] }, // rebind CAS 결속(7차 #5 — evidence 비오염)
      rationale: "확정층 승인 항목의 증거 연결(P3a promotion — sig=" + sig.slice(0, 24) + ")",
      evidence: evRefs.map((x) => ({ kind: x.cat, ref: x.rel })),
    };
    base.readSet = MP.buildReadSetFor(topo, base, {
      idx, pol, repoRoot: repo,
      fileHashOf: (ref) => {
        if (ref === "project-map/bindings.json") return bindRaw === null ? null : sha1(bindRaw); // 검증한 그 바이트(구현 2차 #1)
        try { return sha1(fs.readFileSync(path.join(repo, ref), "utf8")); } catch { return null; }
      },
    });
    const canon = PM.canonicalPatchV2({ ...base, patchId: PATCH_ID_SEED }); // canonical 정규화(구현 1차 #6 — evidence 등장 순서 무관)
    const genFp = sha1(JSON.stringify(canon)); // 결정론 patchId=generationFp 전체 파생(6차 #1)
    canon.patchId = genFp.slice(0, 8) + "-" + genFp.slice(8, 12) + "-" + genFp.slice(12, 16) + "-" + genFp.slice(16, 20) + "-" + genFp.slice(20, 32);
    return canon;
  };
  const r = MP.proposeUnique(repo, topo.mapId, { targetId, sig }, buildPatch);
  if (r.st === "proposed") { cleanupBoundLive(repo, topo.mapId, sig); return { st: "patch", patchId: r.patchId, patch: r.patch }; } // 기록된 그 patch(구현 2차 #2 — 잠금 밖 재생성 금지)
  if (r.st === "already-pending") { cleanupBoundLive(repo, topo.mapId, sig); return { st: "already-pending", patchId: r.patchId }; }
  if (r.st === "retry-required") return { st: "retry-required", patchId: r.patchId };
  if (r.st === "resolved-exists") return { st: "conflict", reason: "resolved proposal 존재+target evidence 부재 — 진단 대상(자동 완료 판정 금지·5차 #5)", patchId: r.patchId };
  if (r.st === "conflict") return { st: "conflict", reason: r.reason };
  return { st: "rejected", reason: r.reason || "proposeUnique 실패" };
}
// bound live 후보의 durable 확인 후 동반 정리(7차 #4 — 실패해도 무해: pipelineGc·재호출이 재시도)
function cleanupBoundLive(repo, mapId, sig) {
  try {
    MB.withCandGlobalLock(repo, () => {
      const d = MB.bindingsDirFor(repo, mapId);
      const r = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
      const before = (r.items || []).length;
      r.items = (r.items || []).filter((x) => !(x.sig === sig && x.status === "bound"));
      if (r.items.length !== before) CL.atomicWrite(d.liveFile, JSON.stringify(r, null, 1));
      return true;
    });
  } catch { /* 부재·손상=불간섭(정리는 보수) */ }
}

// ── REQUIRED_SURFACES(고정 집합 — 1차 #7·2차 #8 실호출부)·manifest(자기신고) ────────
const REQUIRED_SURFACES = [
  { id: "dashboard-approved", ownerPhase: "P3a", legacyFile: "src/extension.ts", legacyFn: "readMapLedgerUncached→parseApprovedFromMap", v2: "approvedViewFor" },
  { id: "package-map-content", ownerPhase: "P3a", legacyFile: "scripts/scope-package.js", legacyFn: "collectCommon(mapContent raw embed)", v2: "mapContentFor" },
  { id: "ledger-export", ownerPhase: "P3a", legacyFile: "src/extension.ts", legacyFn: "ledgerAct export→appendApproved", v2: "promoteEntry" },
  { id: "reconcile-approve", ownerPhase: "P3a", legacyFile: "scripts/scope-reconcile.js", legacyFn: "approve→appendApproved", v2: "promoteEntry" },
  // P4 표면(증분 3 — ready='호출 가능 구현' 기준: 활성 여부와 별개. buildMapAttach는 cutover 전 항상
  // 기존 buildScoutAttach로 위임하고, mapGateAssessFor는 어떤 런타임 경로도 아직 호출하지 않는다[비활성 준비]).
  { id: "scout-attach", ownerPhase: "P4", legacyFile: "bridge/contract-lib.js", legacyFn: "buildScoutAttach", v2: "buildMapAttach", activation: "P3b" },
  { id: "gate-map-reader", ownerPhase: "P4", legacyFile: "bridge/scout-gate.js", legacyFn: "scoutMapStatus 소비(플랜 게이트 preflight)", v2: "mapGateAssessFor", activation: "P3b" },
];
const RD = require(path.join(__dirname, "map-reader.js")); // P4 reader(단방향: adapters→reader — 역방향 require 금지)
const V2_FNS = { approvedViewFor, mapContentFor, promoteEntry, buildMapAttach: RD.buildMapAttach, mapGateAssessFor: RD.mapGateAssessFor };
function adapterManifest() {
  return {
    schema: "map-adapter-manifest-v1",
    surfaces: REQUIRED_SURFACES.map((sf) => ({ id: sf.id, ready: !!(sf.v2 && typeof V2_FNS[sf.v2] === "function"), fn: sf.v2, ...(sf.activation ? { activation: sf.activation } : {}) })), // activation=활성 시점(ready와 별개 — manifest 스키마 명시
  };
}

module.exports = { approvedViewFor, mapContentFor, promoteEntry, REQUIRED_SURFACES, adapterManifest, buildMapAttach: RD.buildMapAttach, mapGateAssessFor: RD.mapGateAssessFor }; // P4 표면 재수출(1차 blocker④ — manifest ready=공개 호출 가능과 일치)
