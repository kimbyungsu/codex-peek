/*
 * P2-A2a 테스트 — ②b semantic validation(1-20·구조화 verdict)·순수 적용기 applyOperationV2(§C-2).
 * 8차 반영: split 배분 보존·merge 재지향 대상 제한·정리 한정·merge_edge 스키마 분리·P 승격 정밀·
 * steward 빈 to·{disposition, errors} 반환.
 */
const PM = require("../bridge/project-map.js");

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");
const BASIS = { kind: "git", ref: { type: "branch", name: "main" }, baseHead: sha("head"), oidFormat: "sha1" };
const T1 = [{ id: U(1), contentHash: sha("t1") }];
const E1 = [{ ref: "src/a.js", contentHash: sha("e1") }];
const A1 = [{ key: "edges", hash: sha("a1") }];
const N1 = [{ kind: "absent", key: "k", fingerprint: sha("n1") }];
const X1 = [{ id: U(1), indexFp: sha("x1") }];
const EV = [{ kind: "code", ref: "src/a.js" }];
const rsFull = { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 };
const rsMerge = { targets: T1, files: E1, adjacency: A1, decisionIndex: X1 };
const rsWN = { targets: T1, files: E1, negative: N1, decisionIndex: X1 };
const errsOf = (v) => v.errors;
const okV = (v) => v.disposition === "ok" && v.errors.length === 0;

function mkTopo() {
  return {
    schemaVersion: 2, mapId: U(100), draft: true, project: "p", createdAt: "2026-07-12T00:00:00Z", revision: 3,
    nodes: [
      { id: U(1), label: "A", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }], conditions: ["c-old"] },
      { id: U(2), label: "B", entityType: "module", roles: ["consumer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/b.js" }] },
      { id: U(3), label: "C", entityType: "store", roles: ["storage"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/c.js" }] },
    ],
    edges: [
      { id: U(11), from: U(1), to: U(2), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } },
      { id: U(12), from: U(2), to: U(3), relation: "stores", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } },
    ],
    inventory: { scanComplete: true, filesSeen: 3, policyExcluded: [], depthCapped: [], entryCapped: false, unreadable: [], semantic: { supportedLangs: ["js"], scannedSupportedFiles: 3, unsupportedFiles: 0, dynamicUnknowns: 0, externalOrAliasSkipped: 0, semanticUnreadable: [], parserNote: "regex" } },
    freshnessNote: "신선도 판정 미지원 — 유도 판정기는 후속(P4)",
  };
}
function mkPatch(op, over) {
  const base = { schema: "map-patch-v2", patchId: U(50), mapId: U(100), basis: BASIS, baseMapHash: sha("m"), baseAuthorityHash: sha("a"), baseDecisionContextHash: sha("c"), baseDirtyFp: "", operation: op, payload: {}, readSet: { targets: T1, files: E1, decisionIndex: X1 }, rationale: "r", evidence: EV, ...over };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
}
const NOCTX = { frontier: [] };
// 배분 보존 split 픽스처: 원본 A(U1)의 anchors 1개·conditions 1개를 A1/A2에 배분(서로소·합집합=원본)
const NN_DIST = [
  { id: U(21), label: "A1", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }] },
  { id: U(22), label: "A2", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [], conditions: ["c-old"] },
];

function main() {
  console.log("[1] ②b — verdict 구조·targetId 실존·expect CAS·N");
  {
    const t = mkTopo();
    const hard = PM.semanticValidateV2(t, mkPatch("set_state", { mapId: U(101), targetId: U(1), payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } }), NOCTX);
    ok(hard.disposition === "hard-reject", "mapId 불일치=disposition hard-reject(문자열 파싱 불요 — 8차 #7)");
    const ni = PM.semanticValidateV2(t, mkPatch("set_state", { targetId: U(9), payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } }), NOCTX);
    ok(ni.disposition === "needs-investigation" && ni.errors.some((e) => e.includes("미실존")), "②b 실패=needs-investigation");
    ok(okV(PM.semanticValidateV2(t, mkPatch("set_state", { targetId: U(1), payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } }), NOCTX)), "정합 set_state=ok");
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("set_state", { targetId: U(1), payload: { to: { confidence: "confirmed" }, expect: { confidence: "unknown" } } }), NOCTX)).some((e) => e.includes("불일치")), "expect≠현재=실패");
    const dupEdge = { id: U(19), from: U(1), to: U(2), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } };
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("add_edge", { payload: { edge: dupEdge }, readSet: rsFull }), NOCTX)).some((e) => e.includes("동일")), "동일 (from,to,relation)=실패");
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("add_anchor", { targetId: U(1), payload: { anchor: { kind: "code", path: "src/a.js" } } }), NOCTX)).some((e) => e.includes("기존재")), "동일 anchor=실패");
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("widen", { targetId: U(1), payload: { additions: { conditions: ["c-old"] }, expect: { conditions: ["c-old"] } }, readSet: rsWN }), NOCTX)).some((e) => e.includes("이미 존재")), "widen 추가분 기존재=실패");
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("change_steward", { targetId: U(1), payload: { to: "", expect: "team-a" } }), NOCTX)).some((e) => e.includes("불일치")) === true, "steward 빈 to 허용(스키마)+expect CAS는 여전(8차 #6)");
    ok(PM.validatePatchV2(mkPatch("change_steward", { targetId: U(1), payload: { to: "", expect: "team-a" } })).length === 0, "빈 to inverse patch=스키마 통과(재적용 가능)");
  }

  console.log("[2] ②b — split 배분 보존(8차 #1)·merge 재지향 제한(8차 #2)·P 승격 정밀(8차 #5)");
  {
    const t = mkTopo();
    const spGood = mkPatch("split_node", { targetId: U(1), payload: { newNodes: NN_DIST, edgeReroute: [{ edgeId: U(11), to: U(21) }] }, readSet: rsFull });
    ok(okV(PM.semanticValidateV2(t, spGood, NOCTX)), "배분 보존 split=ok(합집합=원본·서로소)");
    const NN_LOSS = [{ ...NN_DIST[0], anchors: [] }, NN_DIST[1]]; // anchor 소실
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("split_node", { targetId: U(1), payload: { newNodes: NN_LOSS, edgeReroute: [{ edgeId: U(11), to: U(21) }] }, readSet: rsFull }), NOCTX)).some((e) => e.includes("배분이 원본과 불일치")), "구성요소 소실=실패(무검사 소실 차단)");
    const NN_DUP = [NN_DIST[0], { ...NN_DIST[1], anchors: [{ kind: "code", path: "src/a.js" }] }]; // 중복 배분
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("split_node", { targetId: U(1), payload: { newNodes: NN_DUP, edgeReroute: [{ edgeId: U(11), to: U(21) }] }, readSet: rsFull }), NOCTX)).some((e) => e.includes("중복 배분")), "중복 배분=실패(서로소)");
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("split_node", { targetId: U(2), payload: { newNodes: NN_DIST, edgeReroute: [{ edgeId: U(11), to: U(21) }] }, readSet: rsFull }), NOCTX)).some((e) => e.includes("전수") || e.includes("배분")), "인접 누락=실패(전수성)");
    // merge 재지향 대상=absorbed 금지(8차 #2 — TypeError 사망 반례)
    const mgBad = mkPatch("merge_node", { targetIds: [U(1), U(2), U(3)].sort(), payload: { survivorId: U(1), absorbed: [{ id: U(2) }, { id: U(3), anchorsTo: U(2) }] }, readSet: rsMerge });
    ok(errsOf(PM.semanticValidateV2(t, mgBad, NOCTX)).some((e) => e.includes("함께 소멸")), "재지향 대상이 absorbed=실패(사망 경로 차단)");
    // P 승격 정밀(8차 #5): scope·opClass 비교
    const polMergeOnly = { policyId: U(31), mapId: U(100), scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "merge" }, predicateDescription: "d", chosenMeaning: "m", createdFromDecision: U(32), verification: { kind: "git", objectFormat: "sha1", head: sha("h") }, active: true };
    const sp = mkPatch("set_state", { targetId: U(1), payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } });
    ok(okV(PM.semanticValidateV2(t, sp, { frontier: [polMergeOnly] })), "opClass 불일치 정책=set_state에 P 강제 안 함");
    const mg2 = mkPatch("merge_node", { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] }, readSet: rsMerge });
    ok(errsOf(PM.semanticValidateV2(t, mg2, { frontier: [polMergeOnly] })).some((e) => e.includes("policies 필수")), "opClass=merge 정책 존재 시 merge_node에 P 승격");
    const polScoped = { ...polMergeOnly, policyId: U(33), scope: "entity", scopeTarget: [U(9)] };
    ok(okV(PM.semanticValidateV2(t, mg2, { frontier: [polScoped] })), "scope 밖 정책=강제 없음(8차 #5)");
    const polBadKind = { ...polMergeOnly, policyId: U(34), predicateExpr: { version: 1, kind: "unknown" } };
    ok(errsOf(PM.semanticValidateV2(t, mg2, { frontier: [polBadKind] })).some((e) => e.includes("미지원 predicate")), "scope 내 미지원 kind=실패");
    ok(okV(PM.semanticValidateV2(t, sp, { frontier: [{ ...polBadKind, scope: "entity", scopeTarget: [U(9)] }] })), "scope 밖 미지원 kind=무시(선 scope 판정)");
    // 생성물 잠금 감지: policy-ref를 단 add_node
    const lockedNode = { id: U(40), label: "L", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/l.js" }], decisionLocks: [{ kind: "policy-ref", policyId: U(31) }] };
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("add_node", { payload: { node: lockedNode }, readSet: { files: E1, negative: N1 } }), NOCTX)).some((e) => e.includes("policies 필수")), "생성물의 policy-ref 잠금도 P 승격(8차 #5)");
  }

  console.log("[3] 적용기 — 불변·revision·스키마 통과·거부 경로");
  {
    const t = mkTopo();
    const before = JSON.stringify(t);
    const r = PM.applyOperationV2(t, mkPatch("set_state", { targetId: U(1), payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } }));
    ok(JSON.stringify(t) === before, "입력 불변");
    ok(r.topo.revision === 4 && r.topo.nodes.find((n) => n.id === U(1)).state.confidence === "confirmed", "적용+revision +1");
    ok(PM.validateTopology(r.topo).length === 0, "출력 스키마 통과");
    ok(PM.applyOperationV2(t, mkPatch("tombstone_candidate", { targetId: U(1), payload: { expect: { lifecycle: "active" } }, readSet: rsFull })).errors.some((e) => e.includes("proposal-only")), "proposal-only 거부");
    ok(PM.applyOperationV2(t, mkPatch("create_intent_policy", { payload: { policy: {} }, evidence: undefined, authorizationRefs: [{ kind: "user-choice", ref: "c" }], readSet: { negative: N1, policies: { refs: [], frontierHash: sha("f") } } })).errors.some((e) => e.includes("무변경")), "정책 op 거부");
    const r2 = PM.applyOperationV2(t, mkPatch("supersede", { targetId: U(1), payload: { successorId: U(2), expect: { lifecycle: "active" } }, readSet: rsFull }));
    ok(r2.topo.nodes.length === 3 && r2.topo.nodes.find((n) => n.id === U(1)).state.lifecycle === "superseded", "supersede=lifecycle만");
  }

  console.log("[4] 적용기 — split(배분 후 원본 제거)·merge(한정 정리·외부 destination)");
  {
    const t = mkTopo();
    const sp = mkPatch("split_node", { targetId: U(1), payload: { newNodes: NN_DIST, edgeReroute: [{ edgeId: U(11), to: U(21) }] }, readSet: rsFull });
    ok(okV(PM.semanticValidateV2(t, sp, NOCTX)), "(전제) 배분 split ②b 통과");
    const r = PM.applyOperationV2(t, sp);
    ok(!r.topo.nodes.some((n) => n.id === U(1)) && r.topo.nodes.length === 4, "split: 원본 제거+신규 2");
    ok(r.topo.edges.find((e) => e.id === U(11)).from === U(21), "split: 재지향");
    ok(PM.validateTopology(r.topo).length === 0, "split 출력 통과");
    const gotAnchors = r.topo.nodes.filter((n) => [U(21), U(22)].includes(n.id)).flatMap((n) => n.anchors || []);
    ok(gotAnchors.length === 1 && gotAnchors[0].path === "src/a.js", "split: 구성요소 배분 보존(소실 0)");
    // merge: 무관 self·중복 edge는 보존(8차 #3), 재지향 산물만 정리
    const t2 = mkTopo();
    t2.edges.push({ id: U(13), from: U(3), to: U(3), relation: "mirrors", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } }); // 무관 self
    t2.nodes[1].evidence = [{ kind: "code", ref: "src/b.js" }];
    const mg = mkPatch("merge_node", { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] }, readSet: rsMerge });
    const r3 = PM.applyOperationV2(t2, mg);
    ok(!r3.topo.nodes.some((n) => n.id === U(2)), "merge: 흡수 제거");
    ok(!r3.topo.edges.some((e) => e.id === U(11)), "merge: 재지향 산물 self edge 정리(U11: A→B가 A→A로)");
    ok(r3.topo.edges.some((e) => e.id === U(13)), "merge: 무관 self edge 보존(8차 #3 — read-set 밖 불간섭)");
    const e12 = r3.topo.edges.find((e) => e.id === U(12));
    ok(e12 && e12.from === U(1) && e12.to === U(3), "merge: edge 재지향");
    ok(r3.topo.nodes.find((n) => n.id === U(1)).evidence.some((v) => v.ref === "src/b.js"), "merge: 소지품 병합");
    ok(PM.validateTopology(r3.topo).length === 0, "merge 출력 통과");
    // 외부 destination changedIds(8차 #4)
    const mg2 = mkPatch("merge_node", { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2), anchorsTo: U(3) }] }, readSet: rsMerge });
    const r4 = PM.applyOperationV2(mkTopo(), mg2);
    ok(r4.changedIds.includes(U(3)), "외부 anchorsTo 대상이 changedIds에 포함");
    ok(r4.topo.nodes.find((n) => n.id === U(3)).anchors.some((a) => a.path === "src/b.js"), "외부 대상으로 anchors 이동");
    // merge_edge: absorbed={id}만(8차 #4)
    ok(PM.validatePatchV2(mkPatch("merge_edge", { targetIds: [U(11), U(12)], payload: { survivorId: U(11), absorbed: [{ id: U(12), anchorsTo: U(1) }] }, readSet: rsMerge })).some((e) => e.includes("absorbed")), "merge_edge에 재지향 필드=스키마 거부");
  }

  console.log("[5] 적용기 — widen/narrow·rewrite·steward(빈 to)·authority");
  {
    const t = mkTopo();
    const w = PM.applyOperationV2(t, mkPatch("widen", { targetId: U(1), payload: { additions: { conditions: ["c-new"] }, expect: { conditions: ["c-old"] } }, readSet: rsWN }));
    ok(w.topo.nodes[0].conditions.includes("c-new"), "widen 병합");
    const n1 = PM.applyOperationV2(w.topo, mkPatch("narrow", { targetId: U(1), payload: { removals: { conditions: ["c-new", "c-old"] }, expect: { conditions: ["c-new", "c-old"].sort() }, retain: ["c-old"] }, readSet: rsWN }));
    ok(n1.topo.nodes[0].conditions.length === 1 && n1.topo.nodes[0].conditions[0] === "c-old", "narrow retain");
    const cs = PM.applyOperationV2(t, mkPatch("change_steward", { targetId: U(1), payload: { to: "team-b", expect: "" } }));
    ok(cs.topo.nodes[0].steward === "team-b", "change_steward 지정");
    const cs2 = PM.applyOperationV2(cs.topo, mkPatch("change_steward", { targetId: U(1), payload: { to: "", expect: "team-b" } }));
    ok(cs2.topo.nodes[0].steward === undefined && PM.validateTopology(cs2.topo).length === 0, "빈 to=미지정 복원(inverse 재적용 — 8차 #6)");
    const ca = PM.applyOperationV2(t, mkPatch("change_authority", { targetId: U(1), payload: { to: ["authority", "producer"], expect: ["producer"] } }));
    ok(JSON.stringify([...ca.topo.nodes[0].roles].sort()) === JSON.stringify(["authority", "producer"]), "change_authority 교체");
    const rw = PM.applyOperationV2(t, mkPatch("rewrite_label", { targetId: U(11), payload: { to: { notes: "새" }, expect: { notes: "" } } }));
    ok(rw.topo.edges[0].notes === "새", "rewrite_label(edge)");
  }

  console.log("[6] 9차 반례 — 결정론 생존자·동형 판정·frontier 필수·정확 DSL·kind 정합");
  {
    const t = mkTopo();
    const sp = mkPatch("set_state", { targetId: U(1), payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } });
    const vf = PM.semanticValidateV2(t, sp, {});
    ok(vf.disposition === "needs-investigation" && vf.errors.some((e) => e.includes("frontier 미주입")), "frontier 미주입=fail-closed(잠금 무관 — 9차 #3)");
    const mg = mkPatch("merge_node", { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] }, readSet: rsMerge });
    const polV999 = { policyId: U(35), mapId: U(100), scope: "project", predicateExpr: { version: 999, kind: "op-class", opClass: "merge" }, predicateDescription: "d", chosenMeaning: "m", createdFromDecision: U(32), verification: { kind: "git", objectFormat: "sha1", head: sha("h") }, active: true };
    ok(errsOf(PM.semanticValidateV2(t, mg, { frontier: [polV999] })).some((e) => e.includes("미지원 predicate")), "version≠1=자동 해석 금지(9차 #4)");
    const polExtra = { ...polV999, policyId: U(36), predicateExpr: { version: 1, kind: "op-class", opClass: "merge", negate: true } };
    ok(errsOf(PM.semanticValidateV2(t, mg, { frontier: [polExtra] })).some((e) => e.includes("미지원 predicate")), "여분 의미 필드(negate)=자동 해석 금지");
    ok(errsOf(PM.semanticValidateV2(t, mkPatch("supersede", { targetId: U(1), payload: { successorId: U(11), expect: { lifecycle: "active" } }, readSet: rsFull }), NOCTX)).some((e) => e.includes("종류 불일치")), "node→edge 계승=거부(9차 #5)");
    const t3 = mkTopo();
    t3.edges = [
      { id: U(15), from: U(1), to: U(3), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, evidence: [{ kind: "code", ref: "only-a.js" }] },
      { id: U(16), from: U(2), to: U(3), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } },
    ];
    const mgC = mkPatch("merge_node", { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] }, readSet: rsMerge });
    ok(errsOf(PM.semanticValidateV2(t3, mgC, NOCTX)).some((e) => e.includes("비동형")), "비동형 충돌=자동 병합 금지(의미 소실 차단 — 9차 #2)");
    const mkE = (id, from) => ({ id, from, to: U(3), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } });
    const t4 = mkTopo(); t4.edges = [mkE(U(15), U(1)), mkE(U(16), U(2))];
    const t5 = mkTopo(); t5.edges = [mkE(U(16), U(2)), mkE(U(15), U(1))];
    ok(okV(PM.semanticValidateV2(t4, mgC, NOCTX)), "동형 충돌=②b 허용");
    const rA = PM.applyOperationV2(t4, mgC); const rB = PM.applyOperationV2(t5, mgC);
    ok(PM.mapHashOf(rA.topo) === PM.mapHashOf(rB.topo) && rA.topo.edges.some((e) => e.id === U(15)) && !rA.topo.edges.some((e) => e.id === U(16)), "edge 순서 반전에도 동일 mapHash(생존자=최소 id — 9차 #1)");
    const t6 = mkTopo();
    t6.edges = [{ id: U(11), from: U(1), to: U(2), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, evidence: [{ kind: "code", ref: "internal.js" }] }];
    ok(errsOf(PM.semanticValidateV2(t6, mgC, NOCTX)).some((e) => e.includes("자동 폐기 금지")), "의미 보유 내부 edge의 self化=거부(9차 #2)");
    // 10차: 무관 edge의 상태로 유효 merge가 차단되지 않음(②b 대상=관여 edge 한정 — 적용기와 동일 조건)
    const t7 = mkTopo();
    t7.nodes.push({ id: U(4), label: "D", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/d.js" }] });
    t7.edges = [
      { id: U(11), from: U(1), to: U(2), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } },
      { id: U(17), from: U(3), to: U(4), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, evidence: [{ kind: "code", ref: "x.js" }] },
      { id: U(18), from: U(3), to: U(4), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, evidence: [{ kind: "code", ref: "y.js" }] },
      { id: U(13), from: U(3), to: U(3), relation: "mirrors", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, evidence: [{ kind: "code", ref: "self.js" }] },
    ];
    const v10 = PM.semanticValidateV2(t7, mgC, NOCTX);
    ok(v10.disposition === "ok", "무관 비동형 중복·의미 보유 self 존재해도 merge 허용(10차 — 관여 한정)");
    const r10 = PM.applyOperationV2(t7, mgC);
    ok(r10.topo.edges.some((e) => e.id === U(17)) && r10.topo.edges.some((e) => e.id === U(18)) && r10.topo.edges.some((e) => e.id === U(13)), "무관 edge 전부 보존(②b·적용기 정합)");
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main();
