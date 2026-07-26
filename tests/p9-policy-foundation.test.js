/*
 * P9 잔여 증분 2A — 정책 자동 재사용의 바닥 계약.
 * ① chosenMeaning typed v1 ② user/policy decline 종결 코드 ③ policyDelegation의 frontier+fp 재검증
 * ④ 위임 decision은 auto+user-choice-delegated로 기록 ⑤ 정책 op 자체의 위임 적용 금지.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p9pol_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bootstrap.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");

function setup(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p9pol_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const init = MR.initTopologyForBootstrap(ws);
  if (init.st !== "created") throw new Error("init 실패: " + init.st);
  return { ws, topo: MR.readTopoExFor(ws).topo };
}

function mkLivePatch(ws, op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const patch = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah,
    baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "",
    operation: op, payload: {}, readSet: {}, rationale: "p9 foundation", evidence: [{ kind: "code", ref: "src/a.js" }],
    ...fields,
  };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  patch.readSet = MP.buildReadSetFor(topo, patch, {
    idx, pol, repoRoot: ws,
    fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } },
  });
  return patch;
}

function policyOf(topo, overrides) {
  const opClass = (overrides && overrides.opClass) || "rewrite_label";
  const base = {
    policyId: crypto.randomUUID(), mapId: topo.mapId, scope: "project",
    predicateExpr: { version: 1, kind: "op-class", opClass }, predicateDescription: "같은 종류의 제안을 적용",
    chosenMeaning: { version: 1, disposition: "apply", opClass }, createdFromDecision: crypto.randomUUID(),
    verification: { kind: "historyless", basisFp: PM.mapHashOf(topo), inventoryFp: sha("inventory") }, active: true,
  };
  delete (overrides || {}).opClass;
  return { ...base, ...(overrides || {}) };
}

function installPolicy(ws, topo, pol, cardId) {
  const patch = mkLivePatch(ws, "create_intent_policy", {
    payload: { policy: pol }, evidence: undefined,
    authorizationRefs: [{ kind: "user-choice", ref: cardId }],
  });
  const p = MP.proposePatch(ws, patch);
  const c = p.ok && MP.classifyPatch(ws, topo.mapId, patch.patchId);
  const a = c && c.ok && MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true, resolutionRef: cardId });
  return { patch, proposed: p, classified: c, applied: a };
}

function applyAuto(ws, patch) {
  const p = MP.proposePatch(ws, patch);
  const c = p.ok && MP.classifyPatch(ws, patch.mapId, patch.patchId);
  const a = c && c.ok && MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
  return { proposed: p, classified: c, applied: a };
}

const pend = (ws, mapId, patchId) => JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, mapId).pending, patchId + ".json"), "utf8"));

console.log("[1] chosenMeaning typed v1 — 정확 키·뜻/조건 일치");
{
  const { topo } = setup("shape");
  const good = policyOf(topo);
  ok(PM.validateIntentPolicy(good).length === 0, "typed v1 apply 정책=유효");
  ok(PM.validateIntentPolicy({ ...good, chosenMeaning: "사람이 읽는 기존 뜻" }).length === 0, "기존 문자열 정책=판독 호환 유지(자동 매칭 입력은 아님)");
  ok(PM.validateIntentPolicy({ ...good, chosenMeaning: { ...good.chosenMeaning, extra: true } }).some((e) => e.includes("정확 키")), "미지 키 혼입=거부");
  ok(PM.validateIntentPolicy({ ...good, chosenMeaning: { version: 2, disposition: "apply", opClass: "rewrite_label" } }).some((e) => e.includes("version")), "미지원 version=거부");
  ok(PM.validateIntentPolicy({ ...good, chosenMeaning: { version: 1, disposition: "maybe", opClass: "rewrite_label" } }).some((e) => e.includes("disposition")), "미지 disposition=거부");
  ok(PM.validateIntentPolicy({ ...good, chosenMeaning: { version: 1, disposition: "apply", opClass: "change_authority" } }).some((e) => e.includes("predicateExpr.opClass")), "조건 opClass와 뜻 opClass 불일치=거부");
  const unsupportedPredicate = { ...good, predicateExpr: { version: 2, kind: "other", opClass: "rewrite_label" } };
  ok(PM.validateIntentPolicy(unsupportedPredicate).some((e) => e.includes("predicateExpr v1 op-class")), "지원 밖 predicate에 typed 뜻 결속=정본에서 거부");
  ok(PM.validateIntentPolicy({ ...unsupportedPredicate, chosenMeaning: { ...good.chosenMeaning, opClass: "merge_node" } }).some((e) => e.includes("predicateExpr v1 op-class")), "지원 밖 predicate와 엇갈린 typed 뜻도 거부(검증 반례)");
  const extraPredicate = { ...good, predicateExpr: { ...good.predicateExpr, negate: false } };
  ok(PM.validateIntentPolicy(extraPredicate).some((e) => e.includes("정확 형식")), "typed 뜻의 predicate 여분 키=정본 단계 거부");
  const fakePatch = { operation: "rewrite_label", targetId: topo.nodes[0].id, payload: {} };
  ok(MP.policyAppliesToPatch(good, fakePatch, "apply").ok === true, "typed apply 정책과 같은 op/scope=위임 가능");
  ok(MP.policyAppliesToPatch({ ...good, chosenMeaning: "사람용" }, fakePatch, "apply").reason === "meaning-mismatch", "기존 문자열 뜻=자동 위임 불가");
  ok(MP.policyAppliesToPatch({ ...good, chosenMeaning: { version: 1, disposition: "decline", opClass: "rewrite_label" } }, fakePatch, "apply").reason === "meaning-mismatch", "거부 정책으로 적용 위임 불가");
  ok(MP.policyAppliesToPatch(extraPredicate, fakePatch, "apply").reason === "predicate-unsupported", "predicate 여분 의미를 자동 위임에서 해석하지 않음");
}

console.log("[1b] 정책 범위 — 실제 바깥 목적지까지 전부 승인 범위여야");
{
  const { topo } = setup("scope");
  const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID();
  const mergePatch = {
    operation: "merge_node", targetIds: [a, b].sort(),
    payload: { survivorId: a, absorbed: [{ id: b, anchorsTo: c, evidenceTo: c, rerouteEdgesTo: c }] },
  };
  const base = policyOf(topo, { opClass: "merge", scope: "entity", scopeTarget: [a, b].sort(), exclusions: [c] });
  ok(MP.policyAppliesToPatch(base, mergePatch, "apply").reason === "excluded", "merge 외부 목적지가 제외 대상이면 위임 거부");
  const noExclusion = { ...base }; delete noExclusion.exclusions;
  ok(MP.policyAppliesToPatch(noExclusion, mergePatch, "apply").reason === "scope", "대상 일부만 범위에 걸친 교차 변경=위임 거부");
  const fullScope = { ...noExclusion, scopeTarget: [a, b, c].sort() };
  ok(MP.policyAppliesToPatch(fullScope, mergePatch, "apply").ok === true, "명시 대상·외부 목적지가 모두 범위 안이면 위임 가능");
  const n1 = crypto.randomUUID(), n2 = crypto.randomUUID(), edgeId = crypto.randomUUID();
  const splitPatch = {
    operation: "split_node", targetId: a,
    payload: { newNodes: [{ id: n1 }, { id: n2 }], edgeReroute: [{ edgeId, to: n1 }] },
  };
  const splitPolicy = policyOf(topo, { opClass: "split", scope: "subgraph", scopeTarget: [a, n1, n2].sort(), exclusions: [edgeId] });
  ok(MP.policyAppliesToPatch(splitPolicy, splitPatch, "apply").reason === "excluded", "split_node가 옮기는 기존 edge도 제외 대상 검사");
  const splitNoExclusion = { ...splitPolicy }; delete splitNoExclusion.exclusions;
  ok(MP.policyAppliesToPatch(splitNoExclusion, splitPatch, "apply").reason === "scope", "split edge가 범위 밖이면 위임 거부");
  ok(MP.policyAppliesToPatch({ ...splitNoExclusion, scopeTarget: [a, n1, n2, edgeId].sort() }, splitPatch, "apply").ok === true, "split edge까지 범위 안이면 위임 가능");
}

console.log("[2] expirePendingPatch — 사용자/정책 거부 코드와 기본값 무회귀");
{
  const { ws, topo } = setup("expire");
  const mk = (condition) => mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition } });
  const a = mk("a"); MP.proposePatch(ws, a);
  ok(MP.expirePendingPatch(ws, topo.mapId, a.patchId, PM.opHashOf(a), "user-declined").ok === true, "사용자 거부 종결 성공");
  ok(pend(ws, topo.mapId, a.patchId).expireCode === "user-declined", "user-declined 영구 기록");
  const b = mk("b"); MP.proposePatch(ws, b);
  ok(MP.expirePendingPatch(ws, topo.mapId, b.patchId, PM.opHashOf(b), "policy-declined").ok === true, "정책 거부 종결 성공");
  ok(pend(ws, topo.mapId, b.patchId).expireCode === "policy-declined", "policy-declined 영구 기록");
  const c = mk("c"); MP.proposePatch(ws, c);
  ok(MP.expirePendingPatch(ws, topo.mapId, c.patchId, PM.opHashOf(c)).ok === true && pend(ws, topo.mapId, c.patchId).expireCode === "superseded", "기존 호출 기본값=superseded 유지");
  const d = mk("d"); MP.proposePatch(ws, d);
  const bad = MP.expirePendingPatch(ws, topo.mapId, d.patchId, PM.opHashOf(d), "other");
  ok(bad.ok === false && bad.reason === "invalid-code" && pend(ws, topo.mapId, d.patchId).lifecycle === "proposed", "미지 코드=파일 무변 거부");
}

console.log("[3] policyDelegation — 유효 leaf+지문 결속·위임 decision 기록");
{
  const { ws, topo } = setup("delegate");
  const pol = policyOf(topo);
  const pi = installPolicy(ws, topo, pol, "card-policy-1");
  ok(pi.applied && pi.applied.ok === true, "전제: typed 정책을 사용자 선택 결속으로 생성");
  const ps = MP.policyStateFor(ws, topo.mapId);
  const stored = ps.policies.find((x) => x.rec.policyId === pol.policyId);
  ok(ps.frontier.some((x) => x.policyId === pol.policyId) && stored && stored.fp, "전제: 정책이 유효 frontier leaf이며 지문 존재");

  const now = MR.readTopoExFor(ws).topo;
  const node = now.nodes[0];
  const patch = mkLivePatch(ws, "rewrite_label", { targetId: node.id, payload: { to: { label: node.label + "-정책" }, expect: { label: node.label } } });
  MP.proposePatch(ws, patch);
  const classified = MP.classifyPatch(ws, topo.mapId, patch.patchId);
  ok(classified.classification === "verifier-resolved", "비정책 의미 변경은 개정대로 verifier-resolved 분류");
  const malformed = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true, policyDelegation: { policyId: pol.policyId } });
  ok(malformed.reasonCode === "decision-conflict" && pend(ws, topo.mapId, patch.patchId).lifecycle === "classified", "위임 인자 이형=claim 전 거부·pending 불변");
  const wrongFp = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true, policyDelegation: { policyId: pol.policyId, policyFp: sha("wrong") } });
  ok(wrongFp.reasonCode === "decision-conflict" && pend(ws, topo.mapId, patch.patchId).lifecycle === "classified", "정책 지문 불일치=잠금 안 재검증 거부·claim 롤백");

  const unrelated = mkLivePatch(ws, "add_condition", { targetId: node.id, payload: { condition: "정책 범위 밖" } });
  MP.proposePatch(ws, unrelated); MP.classifyPatch(ws, topo.mapId, unrelated.patchId);
  const wrongMeaning = MP.applyPatch(ws, topo.mapId, unrelated.patchId, { preCutover: true, policyDelegation: { policyId: pol.policyId, policyFp: stored.fp } });
  ok(wrongMeaning.reasonCode === "decision-conflict" && pend(ws, topo.mapId, unrelated.patchId).lifecycle === "classified", "다른 op 종류에 정책 지문만 재사용=거부(뜻 결속)");

  const applied = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true, policyDelegation: { policyId: pol.policyId, policyFp: stored.fp } });
  ok(applied.ok === true && applied.decisionId, "유효 정책 위임=비정책 pending 적용 성공");
  const dec = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", applied.decisionId + ".json"), "utf8"));
  ok(dec.classification === "auto" && dec.actor.kind === "user-choice-delegated" && dec.actor.policyId === pol.policyId, "decision=auto+user-choice-delegated(검증 담당 판정으로 위장하지 않음)");
  ok(dec.resolution.evidenceRef === pol.policyId && PM.validateDecisionAny(dec).length === 0, "위임 근거=policyId·decision 스키마 통과");
  ok(MR.readTopoExFor(ws).topo.nodes.find((x) => x.id === node.id).label === node.label + "-정책", "지도 변경 실반영");
}

console.log("[3b] policyDelegation — 교차 범위 merge는 실제 적용 경로에서도 거부");
{
  const { ws, topo } = setup("delegate-scope");
  fs.writeFileSync(path.join(ws, "src", "b.js"), "// b\n");
  fs.writeFileSync(path.join(ws, "src", "c.js"), "// c\n");
  const nodeOf = (id, label, rel) => ({
    id, entityType: "module", label, roles: [], anchors: [{ kind: "code", path: rel }],
    state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" },
  });
  const a = topo.nodes[0].id, b = crypto.randomUUID(), c = crypto.randomUUID();
  const addB = applyAuto(ws, mkLivePatch(ws, "add_node", { payload: { node: nodeOf(b, "B", "src/b.js") } }));
  ok(addB.applied && addB.applied.ok, "전제: 범위 안 B 노드 생성");
  const addC = applyAuto(ws, mkLivePatch(ws, "add_node", { payload: { node: nodeOf(c, "C", "src/c.js") } }));
  ok(addC.applied && addC.applied.ok, "전제: 범위 밖 C 노드 생성");
  const edgeId = crypto.randomUUID();
  const edge = {
    id: edgeId, from: b, to: c, relation: "calls",
    state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" },
  };
  const addEdge = applyAuto(ws, mkLivePatch(ws, "add_edge", { payload: { edge } }));
  ok(addEdge.applied && addEdge.applied.ok, "전제: B에서 C로 이어진 edge 생성");

  const beforePolicy = MR.readTopoExFor(ws).topo;
  const pol = policyOf(beforePolicy, { opClass: "merge", scope: "entity", scopeTarget: [a, b].sort(), exclusions: [c] });
  const pi = installPolicy(ws, beforePolicy, pol, "card-scope-policy");
  ok(pi.applied && pi.applied.ok, "전제: A·B 범위 정책 생성");
  const stored = MP.policyStateFor(ws, beforePolicy.mapId).policies.find((x) => x.rec.policyId === pol.policyId);
  ok(!!stored && !!stored.fp, "전제: 범위 정책 지문 존재");

  const merge = mkLivePatch(ws, "merge_node", {
    targetIds: [a, b].sort(), payload: { survivorId: a, absorbed: [{ id: b, anchorsTo: c }] },
  });
  MP.proposePatch(ws, merge);
  const classified = MP.classifyPatch(ws, beforePolicy.mapId, merge.patchId);
  ok(classified.classification === "verifier-resolved", "전제: merge 제안 classified");
  const denied = MP.applyPatch(ws, beforePolicy.mapId, merge.patchId, {
    preCutover: true, policyDelegation: { policyId: pol.policyId, policyFp: stored.fp },
  });
  ok(denied.ok === false && denied.reasonCode === "decision-conflict" && pend(ws, beforePolicy.mapId, merge.patchId).lifecycle === "classified", "범위 밖·제외 C로 옮기는 위임=잠금 안 거부");
  const after = MR.readTopoExFor(ws).topo;
  ok(after.nodes.some((x) => x.id === b) && after.nodes.find((x) => x.id === c).anchors.length === 1, "거부 뒤 B·C 지도 무변경");

  const edgePolicy = policyOf(after, { opClass: "merge", exclusions: [edgeId] });
  const epi = installPolicy(ws, after, edgePolicy, "card-edge-policy");
  ok(epi.applied && epi.applied.ok, "전제: 기존 edge 제외 project 정책 생성");
  const edgeStored = MP.policyStateFor(ws, after.mapId).policies.find((x) => x.rec.policyId === edgePolicy.policyId);
  ok(!!edgeStored && !!edgeStored.fp, "전제: edge 제외 정책 지문 존재");
  const implicitEdgeMerge = mkLivePatch(ws, "merge_node", {
    targetIds: [a, b].sort(), payload: { survivorId: a, absorbed: [{ id: b }] },
  });
  MP.proposePatch(ws, implicitEdgeMerge);
  const edgeClassified = MP.classifyPatch(ws, after.mapId, implicitEdgeMerge.patchId);
  ok(edgeClassified.classification === "verifier-resolved", "전제: incident edge를 바꿀 merge 제안 classified");
  const edgeDenied = MP.applyPatch(ws, after.mapId, implicitEdgeMerge.patchId, {
    preCutover: true, policyDelegation: { policyId: edgePolicy.policyId, policyFp: edgeStored.fp },
  });
  ok(edgeDenied.ok === false && edgeDenied.reasonCode === "decision-conflict", "적용 미리보기에서 드러난 제외 edge 변경=거부");
  const finalTopo = MR.readTopoExFor(ws).topo;
  ok(finalTopo.nodes.some((x) => x.id === b) && finalTopo.edges.find((x) => x.id === edgeId).from === b, "실제 changedIds 거부 뒤 node·edge 무변경");
}

console.log("[4] 정책 op 불가침 — 기존 정책이 새 정책 생성을 대신 승인할 수 없음");
{
  const { ws, topo } = setup("no-policy-delegation");
  const first = policyOf(topo);
  const a = installPolicy(ws, topo, first, "card-first");
  ok(a.applied && a.applied.ok, "전제: 첫 정책 생성");
  const ps = MP.policyStateFor(ws, topo.mapId);
  const fp = ps.policies.find((x) => x.rec.policyId === first.policyId).fp;
  const second = policyOf(MR.readTopoExFor(ws).topo, { opClass: "change_authority" });
  const patch = mkLivePatch(ws, "create_intent_policy", {
    payload: { policy: second }, evidence: undefined,
    authorizationRefs: [{ kind: "user-choice", ref: "card-second" }],
  });
  MP.proposePatch(ws, patch); MP.classifyPatch(ws, topo.mapId, patch.patchId);
  const r = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true, resolutionRef: "card-second", policyDelegation: { policyId: first.policyId, policyFp: fp } });
  ok(r.ok === false && r.reasonCode === "decision-conflict" && pend(ws, topo.mapId, patch.patchId).lifecycle === "classified", "정책 op에 policyDelegation=거부(새 정책은 사용자 선택 전용)");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
