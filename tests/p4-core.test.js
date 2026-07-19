"use strict";
/*
 * P4 증분 1 — P2 확장 계층(설계 동결 v8: MAP-V2-DESIGN.md 'P4 상세 설계').
 * 계약: structuralHashOf(provenance 제외·주입 전후 동일·provenance만의 변경에 불변) /
 * map-decision-v3(affectedIds 필수·정렬·중복 제거·policy=금지)+validateDecisionAny dual reader /
 * adpOf v2 projection 해시 불변 5단언(affectedIds 키 부재·adpHash·dih·ah 동일) /
 * effectiveConfidenceOf: v2 historyless=unknown 강등·v2 git=targetIds 유지·v3=targetIds∪affectedIds /
 * apply 파이프라인: provenance 주입(생존 changedIds·{basis,decisionId})·historyless basisFp=structural·
 * v3 기록·WAL roll-forward 재적용 결정론(map-pipeline t5가 잠금) / read-set에 대상 node 전 anchor 포함.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const PM = require(path.join(ROOT, "bridge", "project-map.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

console.log("[1] structuralHashOf — provenance 제외·불변식");
{
  const topo = {
    schemaVersion: 2, mapId: U(1), revision: 1, generatedAt: "2026-07-19T00:00:00.000Z",
    nodes: [{ id: U(10), kind: "module", label: "A", anchors: [{ kind: "file", path: "src/a.js" }], state: { lifecycle: "active", confidence: "candidate", implementation: "implemented" } }],
    edges: [],
    inventory: { basis: "listing", files: ["src/a.js"], depthCapped: [], unreadable: [] },
  };
  const s1 = PM.structuralHashOf(topo);
  const withProv = JSON.parse(JSON.stringify(topo));
  withProv.nodes[0].provenance = { basis: { kind: "historyless", basisFp: "a".repeat(40), inventoryFp: "b".repeat(40) }, decisionId: U(99) };
  const s2 = PM.structuralHashOf(withProv);
  ok(s1 === s2, "provenance만의 변경에 structural hash 불변(자기참조 해소의 핵심 성질)");
  ok(PM.mapHashOf(topo) !== PM.mapHashOf(withProv), "mapHashOf(full)는 provenance 변경을 반영(dual basis 불변식 — CAS·audit 축 현행 유지)");
  ok(s1 !== PM.mapHashOf(withProv), "structural ≠ full(provenance 포함 시) — 두 축이 실제로 분리됨");
  const structChanged = JSON.parse(JSON.stringify(topo)); structChanged.nodes[0].label = "B";
  ok(PM.structuralHashOf(structChanged) !== s1, "구조 변경은 structural hash에 반영(민감성 유지)");
}

console.log("[2] map-decision-v3 검증기 + dual reader");
{
  // 실제 유효 v2 decision을 만들기는 무겁다 — 검증기 계약 중 v3 고유 분기(affectedIds·schema)를 직접 반례로.
  const bad = { schema: "map-decision-v3" };
  ok(PM.validateDecisionV3(bad).length > 0, "빈 v3 — 거부(v2 본문 검사 상속)");
  ok(PM.validateDecisionAny({ schema: "map-decision-v3" }).length > 0 && PM.validateDecisionAny({ schema: "map-decision-v2" }).length > 0, "dual reader — 스키마별 dispatch(둘 다 본문 검사 도달)");
  ok(PM.validateDecisionAny({ schema: "map-decision-v9" }).length > 0, "미지 스키마 — v2 경로에서 schema 오류로 거부(침묵 수용 없음)");
  // affectedIds canonical 검사(topology op 가정의 순수 분기): 정렬·중복
  const errsOf = (aff) => {
    const d = { schema: "map-decision-v3", patch: { operation: "set_state" }, affectedIds: aff };
    return PM.validateDecisionV3(d).filter((e) => e.includes("affectedIds") || e.includes("canonical"));
  };
  ok(errsOf(undefined).length === 1, "v3 topology decision — affectedIds 부재=오류");
  ok(errsOf([U(2), U(1)]).length === 1, "미정렬 affectedIds — canonical 위반");
  ok(errsOf([U(1), U(1)]).length === 1, "중복 affectedIds — canonical 위반");
  ok(errsOf(["not-a-uuid"]).length === 1, "비UUID 원소 — entity UUID 강제(1차 blocker① 부속)");
  ok(errsOf([U(1), U(2)]).length === 0, "정렬·유일·UUID — affectedIds 축 통과(다른 필드 오류는 별도)");
  const pol = { schema: "map-decision-v3", patch: { operation: "create_intent_policy" }, affectedIds: [U(1)] };
  ok(PM.validateDecisionV3(pol).some((e) => e.includes("affectedIds 금지")), "정책 op v3 — affectedIds 금지");
}

console.log("[3] adpOf — v2 projection 해시 불변 5단언(8차 [보완])");
{
  const mkD = (schema, extra) => ({
    schema, decisionId: U(20), mapId: U(1), patchId: U(21), opHash: "c".repeat(40),
    patch: { operation: "set_state", targetId: U(10), evidence: [] },
    verification: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) },
    evidenceFps: [], classification: "auto", resolution: { outcome: "applied", evidenceRef: "auto" },
    ...extra,
  });
  const v2 = mkD("map-decision-v2", {});
  const p2 = PM.adpOf(v2);
  ok(!("affectedIds" in p2), "①v2 projection에 affectedIds 키 자체가 없음");
  const h1 = PM.adpHashOf(p2);
  // 1차 [보완]: 자기 비교가 아니라 '구현 전' 고정 리터럴과 대조(회귀 잠금) — P4 이전 HEAD 사본
  // (git show HEAD:bridge/project-map.js)의 adpHashOf(adpOf(같은 fixture)) 실측값과 동일함을 확인하고 박음.
  ok(h1 === "e0602effb3d447874b62fdf52b19b85502a065cb", "①b v2 adpHash=P4 이전 고정 리터럴(회귀 잠금)");
  const p2again = PM.adpOf(mkD("map-decision-v2", {}));
  ok(PM.adpHashOf(p2again) === h1, "②동일 v2 fixture의 adpHashOf 전후 동일(dual reader 도입 무영향)");
  ok(PM.decisionIndexHashOf([h1]) === PM.decisionIndexHashOf([PM.adpHashOf(p2again)]), "③v2-only decisionIndexHash 동일");
  const mh = "e".repeat(40);
  ok(PM.authorityHashOf(mh, PM.decisionIndexHashOf([h1])) === PM.authorityHashOf(mh, PM.decisionIndexHashOf([PM.adpHashOf(p2again)])), "④같은 topology+v2 index의 authorityHash 동일");
  const v3 = mkD("map-decision-v3", { affectedIds: [U(11), U(10)].sort() });
  const p3 = PM.adpOf(v3);
  ok(Array.isArray(p3.affectedIds) && JSON.stringify(p3.affectedIds) === JSON.stringify([...p3.affectedIds].sort()), "⑤v3 projection에만 정렬된 affectedIds 존재");
  ok(PM.adpHashOf(p3) !== h1, "v3 projection 해시는 v2와 구분(affectedIds 결속)");
}

console.log("[4] effectiveConfidenceOf — v2 historyless 강등·v2 git 유지·v3 union");
{
  const ent = (id) => ({ id, state: { confidence: "confirmed" }, provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: U(20) } });
  const baseProj = {
    decisionId: U(20), mapId: U(1), patchId: U(21), opHash: "c".repeat(40), operation: "set_state",
    targetIds: [U(10)], verification: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) },
    evidenceFps: [], classification: "auto", resolutionOutcome: "applied",
  };
  const idxOf = (proj) => ({ st: "ok", projections: [proj] });
  const fh = () => "f".repeat(40);
  ok(PM.effectiveConfidenceOf(ent(U(10)), U(1), idxOf(baseProj), fh).confidence === "confirmed", "v2 git+targetIds 포함 — 기존 검사 유지(confirmed)");
  const rerouted = PM.effectiveConfidenceOf(ent(U(11)), U(1), idxOf(baseProj), fh);
  ok(rerouted.confidence === "unknown" && /변경하지 않음/.test(rerouted.degraded), "v2 — targetIds 밖 entity=기존대로 강등");
  const v3proj = { ...baseProj, affectedIds: [U(10), U(11)].sort() };
  ok(PM.effectiveConfidenceOf(ent(U(11)), U(1), idxOf(v3proj), fh).confidence === "confirmed", "v3 — affectedIds 합집합으로 rerouted edge/destination node 통과(6차 blocker② 봉합)");
  const hlProj = { ...baseProj, verification: { kind: "historyless", basisFp: "a".repeat(40), inventoryFp: "b".repeat(40) } };
  const hlEnt = { id: U(10), state: { confidence: "confirmed" }, provenance: { basis: { kind: "historyless", basisFp: "a".repeat(40), inventoryFp: "b".repeat(40) }, decisionId: U(20) } };
  const hl = PM.effectiveConfidenceOf(hlEnt, U(1), idxOf(hlProj), fh);
  ok(hl.confidence === "unknown" && /구\(v2\) historyless/.test(hl.degraded), "구(v2) historyless — structural 재검증 불가=정직 강등");
  const hlV3 = { ...hlProj, affectedIds: [U(10)] };
  ok(PM.effectiveConfidenceOf(hlEnt, U(1), idxOf(hlV3), fh).confidence === "confirmed", "v3 historyless(structural 의미) — 강등 없이 기존 4검사 경로");
}

// ── e2e 공용 헬퍼([5]~[7]) — map-pipeline.test.js의 mkLivePatch 계약과 동일 함수 공유 ──
process.env.CODEX_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "p4core_home_"));
const MP = require(path.join(ROOT, "bridge", "map-pipeline.js"));
const MB = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const crypto = require("crypto");
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");
function mkWs(tag, files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p4core_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  for (const [rel, txt] of Object.entries(files)) fs.writeFileSync(path.join(ws, rel), txt);
  fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const init = MR.initTopologyForBootstrap(ws);
  if (init.st !== "created") throw new Error("init 실패: " + init.st);
  return ws;
}
function mkLive(ws, op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const base = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
    baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "test", evidence: [{ kind: "code", ref: "src/a.js" }],
    ...fields,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  base.readSet = MP.buildReadSetFor(topo, base, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
  return { patch: base, topo };
}
function applyLive(ws, op, fields, opts) {
  const { patch } = mkLive(ws, op, fields);
  const pr = MP.proposePatch(ws, patch);
  if (!pr.ok) return { ok: false, error: "propose: " + JSON.stringify(pr.errors || pr.error), patch };
  const cf = MP.classifyPatch(ws, patch.mapId, patch.patchId);
  if (!cf.ok) return { ok: false, error: "classify: " + cf.error, patch };
  if (opts && opts.forceAuto) {
    // P2 실경로는 auto만 apply 도달(verifier/intent 해소는 P5+/P9). 검증 대상 계약(생존 필터·주입·read-set)은
    // apply 내부에 있으므로 테스트 하네스가 분류만 auto로 승격해 도달시킨다(해소 경로의 대역 — 제품 코드 무변경).
    const pf = path.join(MP.dirsFor(ws, patch.mapId).pending, patch.patchId + ".json");
    const rec = JSON.parse(fs.readFileSync(pf, "utf8"));
    fs.writeFileSync(pf, JSON.stringify({ ...rec, classification: "auto" }, null, 1), "utf8");
  }
  const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
  return { ...ap, patch };
}
const readDec = (ws, decisionId) => JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", decisionId + ".json"), "utf8"));
const mkNode = (id, label, anchorPath) => ({ id, entityType: "module", label, roles: [], anchors: [{ kind: "code", path: anchorPath }], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } });

console.log("[5] apply 파이프라인 — provenance 주입·structural basisFp·v3 기록(e2e)");
{
  const ws = mkWs("e2e", { "src/a.js": "console.log(1);\n" });
  const topo = MR.readTopoExFor(ws).topo;
  const nid = topo.nodes[0].id;
  const ap = applyLive(ws, "add_condition", { targetId: nid, payload: { condition: "p4-e2e" } });
  ok(ap.ok === true, "(전제) 적용 성공: " + (ap.error || ""));
  const dec = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", ap.decisionId + ".json"), "utf8"));
  ok(dec.schema === "map-decision-v3" && Array.isArray(dec.affectedIds) && dec.affectedIds.includes(nid), "신규 기록=v3+affectedIds(생존 changedIds)");
  const after = MR.readTopoExFor(ws).topo;
  const entAfter = after.nodes.find((x) => x.id === nid);
  ok(entAfter.provenance && entAfter.provenance.decisionId === ap.decisionId, "생존 changedIds entity에 {basis, decisionId} 주입");
  ok(dec.verification.kind === "historyless" ? dec.verification.basisFp === PM.structuralHashOf(after) : true, "historyless basisFp=structuralHashOf(주입 후에도 동일값 — provenance 제외 성질)");
  ok(dec.audit.topologyAfterHash === PM.mapHashOf(after), "mapHashAfter=full 해시(provenance 포함) — audit 축 현행 유지");
  // 4검사 실통과: 주입된 provenance가 자기 decision으로 confirmed 유지되는가(6차 blocker② 실증)
  const idx = { st: "ok", projections: [PM.adpOf(dec)] };
  const fh = (ref) => { try { return require("crypto").createHash("sha1").update(fs.readFileSync(path.isAbsolute(ref) ? ref : path.join(ws, ref))).digest("hex"); } catch { return null; } };
  const effTarget = PM.effectiveConfidenceOf({ ...entAfter, state: { confidence: "confirmed" } }, after.mapId, idx, fh);
  ok(effTarget.confidence === "confirmed", "주입 직후 자기 provenance가 4검사 통과(v3 union+structural basis): " + (effTarget.degraded || ""));
  // read-set에 대상 node anchor 포함(⑤ — 기준선 지문의 출처)
  const anchorPath = (topo.nodes[0].anchors[0] || {}).path;
  ok(!anchorPath || (dec.patch.readSet.files || []).some((f) => f.ref === anchorPath), "read-set에 대상 node anchor 포함(기준선 출처 확장)");
}

console.log("[6] merge/split e2e — affectedIds=생존만·외부 destination anchor read-set(1차 blocker①③)");
{
  const ws = mkWs("merge", { "src/a.js": "// a\n", "src/b.js": "// b\n", "src/c.js": "// c\n" });
  const aid = MR.readTopoExFor(ws).topo.nodes[0].id;
  const nb = crypto.randomUUID(), nc = crypto.randomUUID();
  const apB = applyLive(ws, "add_node", { targetId: undefined, payload: { node: mkNode(nb, "B", "src/b.js") } });
  ok(apB.ok === true, "(전제) add_node B: " + (apB.error || ""));
  const apC = applyLive(ws, "add_node", { targetId: undefined, payload: { node: mkNode(nc, "C", "src/c.js") } });
  ok(apC.ok === true, "(전제) add_node C: " + (apC.error || ""));
  // merge: B를 흡수하되 anchor는 '외부 destination' C로 — targetIds에는 survivor+absorbed만(destination 밖).
  const apM = applyLive(ws, "merge_node", { targetId: undefined, targetIds: [aid, nb].sort(), payload: { survivorId: aid, absorbed: [{ id: nb, anchorsTo: nc }] } }, { forceAuto: true });
  ok(apM.ok === true, "(전제) merge 적용: " + (apM.error || ""));
  if (apM.ok) {
    const decM = readDec(ws, apM.decisionId);
    ok(!decM.affectedIds.includes(nb), "affectedIds에 삭제된(흡수) entity 없음 — 생존 changedIds만(blocker①)");
    ok(decM.affectedIds.includes(nc), "외부 destination(C)은 변경·생존 — affectedIds 포함");
    ok((decM.patch.readSet.files || []).some((f) => f.ref === "src/c.js"), "read-set에 외부 destination의 기존 anchor(src/c.js) 포함(blocker③ — 기준선 지문의 출처)");
    const after = MR.readTopoExFor(ws).topo;
    ok(!after.nodes.find((n) => n.id === nb), "(정합) B는 실제로 삭제됨");
    const cNode = after.nodes.find((n) => n.id === nc);
    ok(cNode.provenance && cNode.provenance.decisionId === apM.decisionId, "destination C에 provenance 주입(생존 집합과 주입 집합 동일)");
    ok((cNode.anchors || []).some((a) => a.path === "src/b.js"), "(정합) B의 anchor가 C로 이동");
    // split: C(anchor 2개)를 두 노드로 — 원본 ID는 삭제되어 affectedIds에서 제외되어야
    const [d1, d2] = [crypto.randomUUID(), crypto.randomUUID()].sort(); // canonical: 집합 배열은 id 정렬(C-3)
    const apS = applyLive(ws, "split_node", { targetId: nc, payload: { newNodes: [mkNode(d1, "C1", "src/c.js"), mkNode(d2, "C2", "src/b.js")], edgeReroute: [] } }, { forceAuto: true });
    ok(apS.ok === true, "(전제) split 적용: " + (apS.error || ""));
    if (apS.ok) {
      const decS = readDec(ws, apS.decisionId);
      ok(!decS.affectedIds.includes(nc), "split — 삭제된 원본 ID는 affectedIds에서 제외(blocker①)");
      ok(decS.affectedIds.includes(d1) && decS.affectedIds.includes(d2), "split — 신규 두 노드는 affectedIds 포함");
      ok(PM.validateDecisionAny(decS).length === 0, "split decision v3 전체 스키마 통과(UUID affectedIds 포함)");
      const t2 = MR.readTopoExFor(ws).topo;
      ok([d1, d2].every((x) => { const n = t2.nodes.find((y) => y.id === x); return n && n.provenance && n.provenance.decisionId === apS.decisionId; }), "신규 노드 둘 다 provenance 주입");
    }
    // 2차 [보완]②: 같은 디렉터리 anchor 2개 add_node — dir-inventory 중복이 dedupe되어 유효 patch가 통과해야
    const nd = crypto.randomUUID();
    const { patch: pDup } = mkLive(ws, "add_node", { targetId: undefined, payload: { node: { ...mkNode(nd, "D", "src/a.js"), anchors: [{ kind: "code", path: "src/a.js" }, { kind: "code", path: "src/b.js" }] } } });
    ok(PM.validatePatchV2(pDup).length === 0, "동일 dir 복수 anchor add_node — read-set canonical 통과(중복 negative dedupe): " + (PM.validatePatchV2(pDup)[0] || ""));
    ok((pDup.readSet.negative || []).filter((x) => x.kind === "dir-inventory").length === 1, "dir-inventory 항목 1개로 dedupe(같은 dir 2 anchor)");
  }
}

console.log("[7] 구 v2 WAL t5 복구 — provenance 미주입 재적용 의미 보존(1차 blocker②)");
{
  const ws = mkWs("v2wal", { "src/a.js": "console.log(1);\n" });
  const topo = MR.readTopoExFor(ws).topo;
  const nid = topo.nodes[0].id;
  const { patch } = mkLive(ws, "add_condition", { targetId: nid, payload: { condition: "v2-era" } });
  // 업그레이드 직전 중단 시나리오: 구(P4 이전) 코드가 기록한 WAL을 그 시절 공식 그대로 수동 구성 —
  // decision=map-decision-v2(affectedIds 없음)·verification basisFp=mapHashOf(full)·expected 해시=주입 없는 적용 결과.
  const apOld = PM.applyOperationV2(topo, patch);
  ok(apOld.errors.length === 0, "(전제) 순수 재적용 성공");
  const outTopo = apOld.topo;
  const before = PM.mapHashOf(topo), after = PM.mapHashOf(outTopo);
  const mdBefore = sha(fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8"));
  const mdAfter = sha(PM.renderMapMd(outTopo));
  const did = crypto.randomUUID();
  const verification = { kind: "historyless", basisFp: after, inventoryFp: PM.opHashOf(outTopo.inventory) };
  const evidenceFps = (patch.evidence || []).map((e) => ({ ref: e.ref, contentHash: sha(fs.readFileSync(path.join(ws, e.ref), "utf8")) })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const decision = {
    schema: "map-decision-v2", decisionId: did, mapId: topo.mapId, patchId: patch.patchId, opHash: PM.opHashOf(patch),
    patch, actor: { kind: "auto" }, classification: "auto",
    resolution: { outcome: "applied", evidenceRef: "auto" }, preCutover: true, verification, evidenceFps,
    audit: { ts: new Date().toISOString(), topologyBeforeHash: before, topologyAfterHash: after, mapMdAfterHash: mdAfter, authorityHashAfter: "", expectedMapHashAfter: after, walRef: "wal/" + did + ".json" },
  };
  const dihAfter = PM.decisionIndexHashOf([PM.adpHashOf(PM.adpOf(decision))]);
  const ahAfter = PM.authorityHashOf(after, dihAfter);
  decision.audit.authorityHashAfter = ahAfter;
  ok(PM.validateDecisionAny(decision).length === 0, "(전제) 구 v2 decision이 dual reader 통과: " + (PM.validateDecisionAny(decision)[0] || ""));
  const decisionText = JSON.stringify(decision, null, 1);
  const dfh = sha(decisionText);
  const d = MP.ensureDirs(ws, topo.mapId);
  const snapText = JSON.stringify({ mapId: topo.mapId, decisionId: did, topologyBeforeHash: before, basis: patch.basis, appliedCountAtSnapshot: 0, topology: topo }, null, 1);
  const snapFile = path.join(d.snapshots, did + ".json");
  fs.writeFileSync(snapFile, snapText, "utf8");
  const wal = {
    schema: "map-wal-v2", transactionKind: "topology", localOrigin: MP.localOriginFor(ws),
    patch, patchId: patch.patchId, opHash: decision.opHash, basis: patch.basis, readSet: patch.readSet,
    inverse: { kind: "recovery", ref: snapFile, note: "P2 inverse 재료" },
    decision, expectedDecisionFileAfterHash: dfh,
    baselineDecisionIndexHash: PM.decisionIndexHashOf([]),
    expectedDecisionIndexHashAfter: dihAfter, expectedAuthorityHashAfter: ahAfter,
    expectedMarker: { decisionId: did, decisionFileAfterHash: dfh, policyArtifact: null },
    topologyBeforeHash: before, mapMdBeforeHash: mdBefore, snapshotRef: { path: snapFile, contentHash: sha(snapText) },
    expectedTopologyAfterHash: after, expectedMapMdAfterHash: mdAfter,
  };
  fs.writeFileSync(path.join(d.wal, did + ".json"), JSON.stringify(wal, null, 1), "utf8");
  const out = MP.recoverWal(ws, topo.mapId);
  ok(out.length === 1 && out[0].verdict === "recovered", "구 v2 WAL t5 — roll-forward 완결(주입 gating): " + JSON.stringify(out));
  const rec = MR.readTopoExFor(ws).topo;
  ok(PM.mapHashOf(rec) === after, "복구 topology=구 v2 expected 해시(재적용 의미 보존)");
  ok(!rec.nodes.find((n) => n.id === nid).provenance, "v2 복구 결과에 provenance 없음(v3만 주입 — blocker② 봉합)");
  const decOnDisk = readDec(ws, did);
  ok(decOnDisk.schema === "map-decision-v2" && !("affectedIds" in decOnDisk), "복구 기록=구 v2 decision 그대로(재작성 금지)");
  // 대조 반례: 주입했다면 expected와 달랐음(gating 제거 회귀 시 이 지점이 conflict가 되는 근거)
  const inj = JSON.parse(JSON.stringify(outTopo));
  inj.nodes.find((n) => n.id === nid).provenance = { basis: verification, decisionId: did };
  ok(PM.mapHashOf(inj) !== after, "(대조) 주입 시 해시 불일치 — v2에 주입하면 정상 WAL이 conflict로 오판됨");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
