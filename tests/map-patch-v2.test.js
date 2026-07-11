/*
 * P2 코어(A1) 테스트 — v2 patch 스키마·대상 union·read-set 규칙표·증거 이층·정책/철회·frontier·
 * 이중 해시 결정론·effectiveConfidence(§E 수식·폴백). 설계 정본: docs/MAP-P2-DESIGN.md(9차 확정).
 */
const PM = require("../bridge/project-map.js");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name); }
}
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`; // 결정론 UUID
const FP = (n) => String(n).padStart(40, "0").replace(/[^0-9a-f]/g, "0").slice(0, 40);
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");

const BASIS = { kind: "git", ref: { type: "branch", name: "main" }, baseHead: sha("head"), oidFormat: "sha1" };
const VB = { kind: "git", objectFormat: "sha1", head: sha("head") };
const EV = [{ kind: "code", ref: "src/a.js" }];
const AZ = [{ kind: "user-choice", ref: "card-1" }];

// op별 '유효 최소 patch' 팩토리 — 이 팩토리 자체가 스키마 계약의 실행 가능한 명세
function rs(parts) { return parts; }
const T1 = [{ id: U(1), contentHash: sha("t1") }];
const E1 = [{ ref: "src/a.js", contentHash: sha("e1") }];
const A1 = [{ key: "edges", hash: sha("a1") }];
const N1 = [{ kind: "absent", key: "k", fingerprint: sha("n1") }];
const X1 = [{ id: U(1), indexFp: sha("x1") }];
const NODE = { id: U(9), label: "n", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }] };
const NODE2 = { ...NODE, id: U(8), label: "n2" };
const EDGE = { id: U(7), from: U(1), to: U(2), relation: "calls", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } };
const EDGE2 = { ...EDGE, id: U(6) };
const POLICY = { policyId: U(20), mapId: U(100), scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "merge" }, predicateDescription: "병합 판단 원칙", chosenMeaning: "별개 유지", createdFromDecision: U(21), verification: VB, active: true };
const REVOKE = { revocationId: U(22), targetPolicyId: U(20), reason: "정책 철회", createdFromDecision: U(23) };

function mkPatch(op, over) {
  const base = {
    schema: "map-patch-v2", patchId: U(50), mapId: U(100), basis: BASIS,
    baseMapHash: sha("m"), baseAuthorityHash: sha("a"), baseDecisionContextHash: sha("c"), baseDirtyFp: "",
    operation: op, payload: {}, readSet: {}, rationale: "r", evidence: EV,
  };
  const byOp = {
    add_node: { payload: { node: NODE }, readSet: { files: E1, negative: N1 } },
    add_edge: { payload: { edge: EDGE }, readSet: { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 } },
    set_state: { targetId: U(1), payload: { to: { confidence: "candidate" }, expect: { confidence: "unknown" } }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    add_anchor: { targetId: U(1), payload: { anchor: { kind: "code", path: "src/a.js" } }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    add_evidence: { targetId: U(1), payload: { evidence: { kind: "code", ref: "src/a.js" } }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    add_condition: { targetId: U(1), payload: { condition: "cond" }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    change_relation: { targetId: U(1), payload: { to: "calls", expect: "imports", inverse: "역연산" }, readSet: { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 } },
    tombstone_candidate: { targetId: U(1), payload: { expect: { lifecycle: "active" } }, readSet: { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 } },
    split_node: { targetId: U(1), payload: { newNodes: [NODE2, NODE], edgeReroute: [{ edgeId: U(7), to: U(9) }] }, readSet: { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 } },
    split_edge: { targetId: U(1), payload: { newEdges: [EDGE2, EDGE] }, readSet: { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 } },
    merge_node: { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] }, readSet: { targets: T1, files: E1, adjacency: A1, decisionIndex: X1 } },
    merge_edge: { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] }, readSet: { targets: T1, files: E1, adjacency: A1, decisionIndex: X1 } },
    widen: { targetId: U(1), payload: { additions: { conditions: ["c1"] }, expect: { conditions: [] } }, readSet: { targets: T1, files: E1, negative: N1, decisionIndex: X1 } },
    narrow: { targetId: U(1), payload: { removals: { conditions: ["c1"] }, expect: { conditions: ["c1"] } }, readSet: { targets: T1, files: E1, negative: N1, decisionIndex: X1 } },
    supersede: { targetId: U(1), payload: { successorId: U(2), expect: { lifecycle: "active" } }, readSet: { targets: T1, files: E1, adjacency: A1, negative: N1, decisionIndex: X1 } },
    change_steward: { targetId: U(1), payload: { to: "team-b", expect: "team-a" }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    change_authority: { targetId: U(1), payload: { to: ["authority"], expect: ["gate"] }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    rewrite_label: { targetId: U(1), payload: { to: { label: "새" }, expect: { label: "옛" } }, readSet: { targets: T1, files: E1, decisionIndex: X1 } },
    create_intent_policy: { payload: { policy: POLICY }, readSet: { negative: N1, policies: { refs: [], frontierHash: sha("f") } }, evidence: undefined, authorizationRefs: AZ },
    supersede_intent_policy: { targetPolicyIds: [U(20)], payload: { policy: { ...POLICY, policyId: U(24), supersedesPolicyIds: [U(20)] } }, readSet: { policies: { refs: [{ policyId: U(20), policyFp: sha("pf") }], frontierHash: sha("f"), revocationAbsent: [U(20)] } }, evidence: undefined, authorizationRefs: AZ },
    revoke_intent_policy: { targetPolicyId: U(20), payload: { revocation: REVOKE }, readSet: { policies: { refs: [{ policyId: U(20), policyFp: sha("pf") }], frontierHash: sha("f"), revocationAbsent: [U(20)] } }, evidence: undefined, authorizationRefs: AZ },
  };
  const merged = { ...base, ...byOp[op], ...(over || {}) };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged;
}

function main() {
  console.log("[1] 21 op 유효 최소 patch — 팩토리 전수 통과(스키마 계약의 실행 가능한 명세)");
  for (const op of PM.PATCH_OPS_V2) {
    const errs = PM.validatePatchV2(mkPatch(op));
    ok(errs.length === 0, `${op}: 유효 patch 통과` + (errs.length ? ` — ${errs[0]}` : ""));
  }

  console.log("[2] read-set 규칙표(§D) — 필수 누락·금지 존재를 전 op 자동 반례");
  const CAT_FIELD = { T: ["targets", T1], E: ["files", E1], A: ["adjacency", A1], N: ["negative", N1], P: ["policies", { refs: [], frontierHash: sha("f") }], X: ["decisionIndex", X1] };
  let rsChecked = 0, rsFailed = 0;
  for (const op of PM.PATCH_OPS_V2) {
    const rules = PM.READSET_RULES[op];
    for (const cat of Object.keys(rules)) {
      const [field, sample] = CAT_FIELD[cat];
      const good = mkPatch(op);
      if (rules[cat] === "required") {
        const broken = { ...good, readSet: { ...good.readSet } }; delete broken.readSet[field];
        rsChecked++; if (!PM.validatePatchV2(broken).some((e) => e.includes(field) || e.includes(cat))) { rsFailed++; console.log(`    ✗ ${op}: ${cat} 누락이 통과됨`); }
      }
      if (rules[cat] === "forbidden") {
        const broken = { ...good, readSet: { ...good.readSet, [field]: sample } };
        rsChecked++; if (!PM.validatePatchV2(broken).some((e) => e.includes(field) || e.includes(cat))) { rsFailed++; console.log(`    ✗ ${op}: ${cat} 금지 위반이 통과됨`); }
      }
    }
  }
  ok(rsFailed === 0, `규칙표 자동 반례 ${rsChecked}건 전부 검출(누락/금지)`);

  console.log("[3] 증거 이층(§C-1) — 혼입 우회 차단");
  ok(PM.validatePatchV2(mkPatch("set_state", { authorizationRefs: AZ })).some((e) => e.includes("authorizationRefs 금지")), "topology op에 authz 혼입=거부");
  ok(PM.validatePatchV2(mkPatch("create_intent_policy", { evidence: EV })).some((e) => e.includes("evidence 금지")), "정책 op에 evidence 혼입=거부");
  ok(PM.validatePatchV2(mkPatch("create_intent_policy", { authorizationRefs: [] })).some((e) => e.includes("authorizationRefs")), "정책 op authz 빈 배열=거부");
  ok(PM.validatePatchV2(mkPatch("set_state", { evidence: [{ kind: "doc", ref: "d.md" }] })).some((e) => e.includes("code/test/config")), "doc 단독 증거=거부(자기확인 고리)");

  console.log("[4] 대상 필드 union(§C-1)");
  ok(PM.validatePatchV2(mkPatch("add_node", { targetId: U(1) })).some((e) => e.includes("targetId 금지")), "생성 op에 targetId=거부");
  ok(PM.validatePatchV2(mkPatch("merge_node", { targetIds: [U(1)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] } })).some((e) => e.includes("targetIds")), "merge targetIds 1개=거부(2+ 필요)");
  ok(PM.validatePatchV2(mkPatch("merge_node", { payload: { survivorId: U(3), absorbed: [{ id: U(2) }] } })).some((e) => e.includes("survivorId는 targetIds에")), "survivor가 대상 밖=거부");
  ok(PM.validatePatchV2(mkPatch("supersede", { payload: { successorId: U(1), expect: { lifecycle: "active" } } })).some((e) => e.includes("자기 자신")), "자기 계승=거부");
  ok(PM.validatePatchV2(mkPatch("set_state", { targetIds: [U(1), U(2)] })).some((e) => e.includes("targetIds 금지")), "단일 대상 op에 targetIds=거부");

  console.log("[5] basis 합타입·독성 입력 무사망");
  ok(PM.validatePatchV2(mkPatch("set_state", { basis: { kind: "git", ref: { type: "branch", name: "main" }, baseHead: "abc", oidFormat: "sha1" } })).some((e) => e.includes("baseHead")), "짧은 head=거부(OID 전체 강제)");
  ok(PM.validatePatchV2(mkPatch("set_state", { basis: { kind: "historyless", basisFp: sha("b"), inventoryFp: sha("i") } })).length === 0, "historyless basis 통과");
  ok(Array.isArray(PM.validatePatchV2(null)) && PM.validatePatchV2(null).length > 0, "null patch 무사망");
  ok(PM.validatePatchV2(mkPatch("set_state", { operation: { toString: null } })).some((e) => e.includes("operation")), "독성 operation 무사망");
  ok(PM.validatePatchV2(mkPatch("set_state", { readSet: { targets: T1, files: E1, decisionIndex: X1, extra: 1 } })).some((e) => e.includes("미지 필드")), "readSet 미지 키=거부");

  console.log("[6] 정책·철회·frontier(1-35)");
  ok(PM.validateIntentPolicy({ ...POLICY, scope: "entity" }).some((e) => e.includes("scopeTarget")), "entity scope에 scopeTarget 부재=거부");
  ok(PM.validateIntentPolicy({ ...POLICY, predicateExpr: { kind: "x" } }).some((e) => e.includes("predicateExpr")), "version 없는 predicate=거부(typed 강제)");
  ok(PM.validateIntentPolicy({ ...POLICY, active: false }).some((e) => e.includes("active")), "active=false 파일=거부(철회는 revocation)");
  {
    const pA = POLICY; // U(20)
    const pB = { ...POLICY, policyId: U(24), supersedesPolicyIds: [U(20)] };
    const pC = { ...POLICY, policyId: U(25) };
    const f1 = PM.effectivePolicyFrontier([pA, pB, pC], []);
    ok(f1.length === 2 && !f1.some((p) => p.policyId === U(20)), "supersede된 정책은 frontier 탈락");
    const f2 = PM.effectivePolicyFrontier([pA, pB, pC], [{ ...REVOKE, targetPolicyId: U(24) }]);
    ok(f2.length === 1 && f2[0].policyId === U(25), "successor 철회돼도 옛 정책 부활 없음(supersede는 영구 — 17차)");
    const h1 = PM.policyFrontierHashOf([pA, pC], []);
    const h2 = PM.policyFrontierHashOf([pC, pA], []);
    ok(h1 === h2, "frontier 해시=순서 무관 결정론");
    ok(PM.policyFrontierHashOf([pA], []) !== PM.policyFrontierHashOf([pA], [{ ...REVOKE, targetPolicyId: U(99) }]), "무관 revocation도 pfh 변경(내용 포함 — 변조 캐시 무효화)");
  }

  console.log("[7] decision v2(§C-3) — applied만·결합·정합");
  const goodPatch = mkPatch("set_state");
  const mkDecision = (over) => {
    const d = {
      schema: "map-decision-v2", decisionId: U(60), mapId: U(100), patchId: U(50),
      opHash: PM.opHashV2Of(goodPatch), patch: goodPatch,
      actor: { kind: "auto" }, classification: "auto", resolution: { outcome: "applied", evidenceRef: "auto" },
      preCutover: true, verification: VB, evidenceFps: [{ ref: "src/a.js", contentHash: sha("e1") }],
      audit: { ts: "2026-07-12T00:00:00Z", topologyBeforeHash: sha("tb"), topologyAfterHash: sha("ta"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("ta"), walRef: "wal/x" },
      ...(over || {}),
    };
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
    return d;
  };
  ok(PM.validateDecisionV2(mkDecision()).length === 0, "유효 decision 통과");
  ok(PM.validateDecisionV2(mkDecision({ patch: { ...goodPatch, patchId: U(51) } })).some((e) => e.includes("patchId")), "다른 patch 결합=거부");
  ok(PM.validateDecisionV2(mkDecision({ opHash: sha("위조") })).some((e) => e.includes("opHash")), "임의 opHash=거부(재계산 대조)");
  ok(PM.validateDecisionV2(mkDecision({ resolution: { outcome: "rejected", evidenceRef: "x" } })).some((e) => e.includes("applied")), "rejected는 decisions/에 없다");
  ok(PM.validateDecisionV2(mkDecision({ classification: "verifier-resolved" })).some((e) => e.includes("actor=verifier")), "verifier-resolved인데 actor=auto=거부(해소 증거 결속)");
  ok(PM.validateDecisionV2(mkDecision({ actor: { kind: "user-choice-delegated", policyId: U(20) } })).length === 0, "정책 위임 자동 적용(1-35 ②)=auto 정합");
  {
    const tomb = mkPatch("tombstone_candidate");
    ok(PM.validateDecisionV2(mkDecision({ patch: tomb, opHash: PM.opHashV2Of(tomb) })).some((e) => e.includes("proposal-only")), "tombstone_candidate decision=거부(§C-2)");
    const pol = mkPatch("create_intent_policy", { payload: { policy: { ...POLICY, createdFromDecision: U(60) } } }); // 귀속 결속(5차 #1): 파일=이 decision의 산물
    const pd = mkDecision({ patch: pol, opHash: PM.opHashV2Of(pol), classification: "intent-choice", actor: { kind: "user-choice", cardId: "card-1" }, resolution: { outcome: "applied", evidenceRef: "card-1" }, evidenceFps: [], audit: { ts: "t", topologyBeforeHash: sha("s"), topologyAfterHash: sha("s2"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("s2"), walRef: "w" } });
    ok(PM.validateDecisionV2(pd).some((e) => e.includes("무변경")), "정책 op인데 before≠after=거부(§F-2 불변)");
    const pd2 = mkDecision({ patch: pol, opHash: PM.opHashV2Of(pol), classification: "intent-choice", actor: { kind: "user-choice", cardId: "card-1" }, resolution: { outcome: "applied", evidenceRef: "card-1" }, evidenceFps: [], audit: { ...pd.audit, topologyAfterHash: sha("s"), expectedMapHashAfter: sha("s") } });
    ok(PM.validateDecisionV2(pd2).length === 0, "정책 decision(무변경·evidenceFps 빈 배열) 통과");
  }
  ok(PM.validateDecisionV2(mkDecision({ patch: { ...goodPatch, localOrigin: { kind: "git", worktreeReal: "C:/x", gitCommonReal: "C:/x/.git" } } })).some((e) => e.includes("localOrigin")), "decision.patch에 localOrigin=거부(이식성)");

  console.log("[8] projection·이중 해시(§E) — 순환 차단·도메인 분리·결정론");
  {
    const d = mkDecision();
    const proj = PM.adpOf(d);
    ok(!("audit" in proj) && !("preCutover" in proj), "projection에 감사 필드 없음(순환 차단)");
    ok(proj.classification === "auto" && proj.resolutionOutcome === "applied", "판정 결과 포함(2차 #13)");
    const d2 = mkDecision({ audit: { ...d.audit, mapMdAfterHash: sha("다른MD") } });
    ok(PM.adpHashOf(PM.adpOf(d)) === PM.adpHashOf(PM.adpOf(d2)), "감사 필드 변경은 projection 지문 불변(MAP.md 지문이 색인에 못 들어감)");
    const dih = PM.decisionIndexHashOf([PM.adpHashOf(proj)]);
    const ah = PM.authorityHashOf(sha("map"), dih);
    ok(PM.authorityHashOf(sha("map"), PM.decisionIndexHashOf([])) !== ah, "decision 추가=authorityHash 변화(mapHash 불변이어도)");
    const pfh = PM.policyFrontierHashOf([], []);
    ok(PM.decisionContextHashOf(ah, pfh) !== PM.decisionContextHashOf(ah, PM.policyFrontierHashOf([POLICY], [])), "정책만 변해도 dch 변화(구조 권위 불변)");
    ok(PM.decisionIndexHashOf([sha("a"), sha("b")]) === PM.decisionIndexHashOf([sha("b"), sha("a")]), "색인 순서 무관 결정론");
    ok(PM.adpHashOf(proj) !== PM.opHashOf(proj), "도메인 분리(같은 내용도 다른 도메인=다른 지문)");
  }

  console.log("[9] effectiveConfidence(§E — 정본 수식·폴백)");
  {
    const fileOk = () => sha("e1");
    const mkEnt = (conf, prov) => ({ id: U(1), state: { confidence: conf }, ...(prov ? { provenance: prov } : {}) });
    const d = mkDecision();
    const idxOk = { st: "ok", projections: [PM.adpOf(d)] };
    const provOk = { basis: VB, decisionId: U(60) };
    const fh = (ref) => (ref === "src/a.js" ? sha("e1") : null);
    ok(PM.effectiveConfidenceOf(mkEnt("candidate"), U(100), { st: "error", error: "x" }, fileOk).confidence === "candidate", "candidate는 색인 오류에도 그대로(2차 #14 — 정본 수식)");
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", provOk), U(100), { st: "error", error: "x" }, fileOk).confidence === "unknown", "confirmed+색인 오류=unknown(폴백 금지)");
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", provOk), U(100), { st: "none" }, fileOk).confidence === "unknown", "confirmed+기록 부재=unknown(dangling)");
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", provOk), U(100), idxOk, fh).confidence === "confirmed", "4검사 전부 통과=confirmed 유지");
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", { basis: VB, decisionId: U(61) }), U(100), idxOk, fh).confidence === "unknown", "①decision 미실존=unknown");
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", provOk), U(101), idxOk, fh).confidence === "unknown", "②mapId 불일치=unknown(세대 오염)");
    {
      const ent = { id: U(3), state: { confidence: "confirmed" }, provenance: provOk };
      ok(PM.effectiveConfidenceOf(ent, U(100), idxOk, fh).confidence === "unknown", "③이 entity 미변경=unknown");
    }
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", provOk), U(100), idxOk, () => sha("변조")).confidence === "unknown", "④evidence 지문 불일치=unknown");
    ok(PM.effectiveConfidenceOf(mkEnt("confirmed", { basis: { ...VB, head: sha("다른head") }, decisionId: U(60) }), U(100), idxOk, fh).confidence === "unknown", "basis 불일치=unknown");
    // coverage: draft(none+confirmed 0)=기존 graphCoverage와 동일(바이트 동일 계약의 짝)
    const topo = { schemaVersion: 2, mapId: U(100), draft: true, project: "p", createdAt: "t", revision: 1, nodes: [{ ...NODE }], edges: [], inventory: { scanComplete: true, filesSeen: 1, policyExcluded: [], depthCapped: [], entryCapped: false, unreadable: [], semantic: { supportedLangs: [], scannedSupportedFiles: 0, unsupportedFiles: 0, dynamicUnknowns: 0, externalOrAliasSkipped: 0, semanticUnreadable: [], parserNote: "" } }, freshnessNote: "x" };
    const legacy = PM.graphCoverage(topo);
    const eff = PM.graphCoverageEffective(topo, { st: "none" }, fileOk);
    ok(JSON.stringify(legacy) === JSON.stringify({ nodes: eff.nodes, edges: eff.edges }) && eff.degradedCount === 0, "순수 draft: effective coverage=기존과 동일·degraded 0");
    const topoC = { ...topo, nodes: [{ ...NODE, state: { ...NODE.state, confidence: "confirmed" } }] };
    const effC = PM.graphCoverageEffective(topoC, { st: "none" }, fileOk);
    ok(effC.nodes.unknown === 1 && effC.degradedCount === 1, "stored confirmed+기록 부재=unknown 집계+degraded 표시");
  }

  console.log("[9b] 구현 1차 반례 — 검증 통과 후 해시 사망·projection 누락·canonical 집합");
  {
    // 깊은 정크: 검증기가 통과시키면 opHashOf가 사망하던 반례(1차 #1) — 이제 검증 단계에서 거부
    let deep = "x"; let obj = { v: "x" };
    for (let i = 0; i < 15000; i++) obj = { v: obj };
    const badNote = mkPatch("create_intent_policy", { authorizationRefs: [{ kind: "user-choice", ref: "c", note: obj }] });
    ok(PM.validatePatchV2(badNote).some((e) => e.includes("note")), "authz note에 깊은 객체=검증 거부(해시 사망 차단)");
    const badPred = mkPatch("create_intent_policy", { payload: { policy: { ...POLICY, predicateExpr: { version: 1, kind: "k", junk: obj } } } });
    ok(PM.validatePatchV2(badPred).some((e) => e.includes("깊이") || e.includes("predicateExpr")), "predicateExpr 깊은 정크=거부(deepShapeOk)");
    const badAb = mkPatch("merge_node", { payload: { survivorId: U(1), absorbed: [{ id: U(2), junk: obj }] } });
    ok(PM.validatePatchV2(badAb).some((e) => e.includes("absorbed")), "absorbed 자유 확장 필드=거부(재지향표 화이트리스트)");
    const badEx = mkPatch("widen", { payload: { additions: { conditions: ["c"] }, expect: { junk: obj } } });
    ok(PM.validatePatchV2(badEx).some((e) => e.includes("expect")), "widen expect 자유 구조=거부");
    // split 생성물 projection(1차 #2)
    const sp = mkPatch("split_node");
    const ids = PM.targetIdsOfPatch(sp);
    ok(ids.includes(U(1)) && ids.includes(U(9)) && ids.includes(U(8)) && ids.length === 3, "split_node projection=원본+생성물 전부");
    const se = mkPatch("split_edge");
    const ide = PM.targetIdsOfPatch(se);
    ok(ide.includes(U(1)) && ide.includes(U(7)) && ide.includes(U(6)), "split_edge projection=원본+생성 edge 전부");
    // 집합 배열 canonical(1차 #3)
    ok(PM.validateIntentPolicy({ ...POLICY, scope: "entity", scopeTarget: [U(2), U(1)] }).some((e) => e.includes("정렬")), "scopeTarget 비정렬=거부(파일 canonical 계약)");
    ok(PM.validateIntentPolicy({ ...POLICY, scope: "entity", scopeTarget: [U(1), U(1)] }).some((e) => e.includes("정렬") || e.includes("중복")), "scopeTarget 중복=거부");
    // oidFormat↔detached 결속(1차 #4)
    const badDet = mkPatch("set_state", { basis: { kind: "git", ref: { type: "detached", head: sha("h") }, baseHead: FP(1).replace(/0/g, "a").padEnd(64, "a").slice(0, 64), oidFormat: "sha256" } });
    ok(PM.validatePatchV2(badDet).some((e) => e.includes("detached head")), "sha256 저장소에 40자 detached head=거부");
    // VerificationBasis 엄격(1차 #5)·actor(1차 #6)
    ok(PM.validateIntentPolicy({ ...POLICY, verification: { kind: "git", junk: obj } }).length > 0, "정책 verification 정크=거부(기존 엄격 검증기 재사용)");
    const dBase = mkPatch("set_state");
    const mkD = (over) => ({ schema: "map-decision-v2", decisionId: U(60), mapId: U(100), patchId: U(50), opHash: PM.opHashV2Of(dBase), patch: dBase, actor: { kind: "auto" }, classification: "auto", resolution: { outcome: "applied", evidenceRef: "auto" }, verification: VB, evidenceFps: [{ ref: "src/a.js", contentHash: sha("e1") }], audit: { ts: "t", topologyBeforeHash: sha("tb"), topologyAfterHash: sha("ta"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("ta"), walRef: "w" }, ...over });
    ok(PM.validateDecisionV2(mkD({ classification: "intent-choice", actor: { kind: "user-choice", cardId: {} } })).some((e) => e.includes("cardId")), "cardId 비문자열=거부");
    ok(PM.validateDecisionV2(mkD({ resolution: { outcome: "applied", evidenceRef: "" } })).some((e) => e.includes("resolution")), "빈 evidenceRef=거부");
    ok(PM.validateDecisionV2(mkD({ classification: "verifier-resolved", actor: { kind: "verifier", resultFp: sha("v") }, resolution: { outcome: "applied", evidenceRef: sha("v") } })).some((e) => e.includes("verdictFp")), "verifier인데 verdictFp 미결속=거부(삼중 일치)");
    ok(PM.validateDecisionV2(mkD({ classification: "verifier-resolved", actor: { kind: "verifier", resultFp: sha("v") }, verdictFp: sha("v"), resolution: { outcome: "applied", evidenceRef: sha("v") } })).length === 0, "verifier 삼중 일치=통과");
  }

  console.log("[9c] 구현 2차 반례 — JSON 비호환 원시값·expect 내용·canonical patch·audit 정합");
  {
    ok(PM.validateIntentPolicy({ ...POLICY, predicateExpr: { version: 1, kind: "k", value: 1n } }).some((e) => e.includes("깊이") || e.includes("predicateExpr")), "BigInt predicate=거부(직렬화 사망 차단 — 2차 #1)");
    ok(PM.deepShapeOk({ a: NaN }, 4) === false && PM.deepShapeOk({ a: new Date() }, 4) === false && PM.deepShapeOk({ a: [1, "x", true, null, { b: 2 }] }, 4) === true, "deepShapeOk=JSON 호환 plain 값만");
    ok(PM.validatePatchV2(mkPatch("widen", { payload: { additions: { conditions: ["c"] }, expect: { conditions: [{ not: "strings" }] } } })).some((e) => e.includes("expect")), "expect.conditions 비문자열=거부(2차 #2)");
    ok(PM.validatePatchV2(mkPatch("widen", { payload: { additions: { conditions: ["c"] }, expect: {} } })).some((e) => e.includes("expect")), "빈 expect=거부(최소 1필드)");
    // canonical patch(2차 #3): 순서만 다른 동일 의미 patch가 검증을 통과해 다른 opHash를 갖는 반례 차단
    ok(PM.validatePatchV2(mkPatch("merge_node", { targetIds: [U(2), U(1)], payload: { survivorId: U(1), absorbed: [{ id: U(2) }] } })).some((e) => e.includes("정렬")), "targetIds 비정렬=거부");
    ok(PM.validatePatchV2(mkPatch("set_state", { readSet: { targets: [{ id: U(2), contentHash: sha("t") }, { id: U(1), contentHash: sha("t") }], files: E1, decisionIndex: X1 } })).some((e) => e.includes("T") || e.includes("targets")), "readSet.targets 비정렬=거부");
    ok(PM.validatePatchV2(mkPatch("merge_node", { payload: { survivorId: U(1), absorbed: [{ id: U(3) }, { id: U(2) }], } , targetIds: [U(1), U(2)]})).some((e) => e.includes("absorbed")), "absorbed 비정렬=거부");
    // audit 정합(2차 #4)
    const dBase2 = mkPatch("set_state");
    const mkD2 = (audit) => ({ schema: "map-decision-v2", decisionId: U(60), mapId: U(100), patchId: U(50), opHash: PM.opHashV2Of(dBase2), patch: dBase2, actor: { kind: "auto" }, classification: "auto", resolution: { outcome: "applied", evidenceRef: "auto" }, verification: VB, evidenceFps: [{ ref: "src/a.js", contentHash: sha("e1") }], audit });
    ok(PM.validateDecisionV2(mkD2({ ts: "t", topologyBeforeHash: sha("tb"), topologyAfterHash: sha("ta"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("다른값"), walRef: "w" })).some((e) => e.includes("expectedMapHashAfter")), "topologyAfterHash≠expectedMapHashAfter=거부");
    const polP = mkPatch("create_intent_policy");
    ok(PM.validateDecisionV2({ schema: "map-decision-v2", decisionId: U(60), mapId: U(100), patchId: U(50), opHash: PM.opHashV2Of(polP), patch: polP, actor: { kind: "auto" }, classification: "auto", resolution: { outcome: "applied", evidenceRef: "auto" }, verification: VB, evidenceFps: [], audit: { ts: "t", topologyBeforeHash: sha("s"), topologyAfterHash: sha("s"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("다른"), walRef: "w" } }).some((e) => e.includes("3해시")), "정책 op: expected까지 3해시 동일 강제");
  }

  console.log("[9d] 구현 3차 반례 — evidence 결속·canonical 해시 단일점·envelope 집합 정합");
  {
    // #1 무관 evidenceFps가 ADP에 들어가 권위를 오염하는 반례
    const dp = mkPatch("set_state");
    const mkD3 = (over) => ({ schema: "map-decision-v2", decisionId: U(60), mapId: U(100), patchId: U(50), opHash: PM.opHashV2Of(dp), patch: dp, actor: { kind: "auto" }, classification: "auto", resolution: { outcome: "applied", evidenceRef: "auto" }, verification: VB, evidenceFps: [{ ref: "src/a.js", contentHash: sha("e1") }], audit: { ts: "t", topologyBeforeHash: sha("tb"), topologyAfterHash: sha("ta"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("ta"), walRef: "w" }, ...over });
    ok(PM.validateDecisionV2(mkD3({})).length === 0, "결속 일치 decision 통과");
    ok(PM.validateDecisionV2(mkD3({ evidenceFps: [{ ref: "unrelated.txt", contentHash: sha("x") }] })).some((e) => e.includes("불일치")), "무관 evidenceFps=거부(권위 오염 차단)");
    ok(PM.validateDecisionV2(mkD3({ evidenceFps: [{ ref: "src/a.js", contentHash: sha("1") }, { ref: "src/a.js", contentHash: sha("2") }] })).some((e) => e.includes("중복")), "ref당 지문 2개=거부");
    // #2 canonical 해시 단일점: 집합 배열 순서만 다른 동일 의미 patch → opHashV2Of 동일
    const n1 = { ...NODE, roles: ["producer", "consumer"], anchors: [{ kind: "code", path: "a.js" }, { kind: "code", path: "b.js" }] };
    const n2 = { ...NODE, roles: ["consumer", "producer"], anchors: [{ kind: "code", path: "b.js" }, { kind: "code", path: "a.js" }] };
    const pA = mkPatch("add_node", { payload: { node: n1 }, evidence: [{ kind: "code", ref: "a.js" }, { kind: "test", ref: "t.js" }] });
    const pB = mkPatch("add_node", { payload: { node: n2 }, evidence: [{ kind: "test", ref: "t.js" }, { kind: "code", ref: "a.js" }] });
    ok(PM.opHashV2Of(pA) === PM.opHashV2Of(pB) && PM.opHashOf(pA) !== PM.opHashOf(pB), "순서만 다른 동일 의미 patch=같은 v2 지문(v1 지문은 동결·상이)");
    ok(PM.opHashV2Of(mkPatch("split_node")) === PM.opHashV2Of({ ...mkPatch("split_node"), payload: { newNodes: [NODE2, NODE], edgeReroute: [{ edgeId: U(7), to: U(9) }] } }), "newNodes 순서 무관 v2 지문");
    // #3 envelope 집합 정합
    ok(PM.validatePatchV2(mkPatch("merge_node", { targetIds: [U(1), U(2)], payload: { survivorId: U(1), absorbed: [{ id: U(3) }] } })).some((e) => e.includes("targetIds−survivor") || e.includes("일치")), "absorbed⊄targetIds=거부(A1 판정 — topology 불요)");
    ok(PM.validatePatchV2(mkPatch("merge_node", { targetIds: [U(1), U(2), U(3)].sort(), payload: { survivorId: U(1), absorbed: [{ id: U(2) }] } })).some((e) => e.includes("일치")), "absorbed 부분 집합=거부(전수 일치)");
    ok(PM.validatePatchV2(mkPatch("split_node", { payload: { newNodes: [NODE, NODE2], edgeReroute: [{ edgeId: U(7), to: U(5) }] } })).some((e) => e.includes("newNodes id여야")), "reroute.to가 생성물 밖=거부");
    ok(PM.validatePatchV2(mkPatch("split_node", { payload: { newNodes: [{ ...NODE, id: U(1) }, NODE2], edgeReroute: [] } })).some((e) => e.includes("원본 targetId")), "생성물 id=원본=거부");
  }

  console.log("[9e] 구현 4·5차 전용 회귀 — canonical 거부·중복·정책 귀속·선택 결속");
  {
    const badNode = { ...NODE, roles: ["producer", "consumer"].reverse(), anchors: [{ kind: "code", path: "b.js" }, { kind: "code", path: "a.js" }] };
    const ncp = mkPatch("add_node", { payload: { node: badNode } });
    ok(PM.validatePatchV2(ncp).some((e) => e.includes("canonical")), "비정규 patch(집합 비정렬)=직접 거부(4차 #1)");
    const dupEv = mkPatch("set_state", { evidence: [{ kind: "code", ref: "src/a.js" }, { kind: "code", ref: "src/a.js" }] });
    ok(PM.validatePatchV2(dupEv).some((e) => e.includes("중복")), "evidence 중복=거부(조용한 제거 금지 — 4차 #3)");
    const ca1 = mkPatch("change_authority", { payload: { to: ["authority", "gate"], expect: ["gate"] } });
    const ca2 = mkPatch("change_authority", { payload: { to: ["gate", "authority"], expect: ["gate"] } });
    ok(PM.opHashV2Of(ca1) === PM.opHashV2Of(ca2) && PM.validatePatchV2(ca1).length === 0 && PM.validatePatchV2(ca2).some((e) => e.includes("canonical")), "change_authority 순서 무관 v2 지문+비정규는 거부(4차 #2)");
    // 정책 op decision — auto actor 거부·createdFromDecision 결속·선택 결속(5차)
    const polOk = mkPatch("create_intent_policy", { payload: { policy: { ...POLICY, createdFromDecision: U(60) } } });
    const basePd = { schema: "map-decision-v2", decisionId: U(60), mapId: U(100), patchId: U(50), opHash: PM.opHashV2Of(polOk), patch: polOk, classification: "intent-choice", actor: { kind: "user-choice", cardId: "card-1" }, resolution: { outcome: "applied", evidenceRef: "card-1" }, verification: VB, evidenceFps: [], audit: { ts: "t", topologyBeforeHash: sha("s"), topologyAfterHash: sha("s"), mapMdAfterHash: sha("mm"), authorityHashAfter: sha("ah"), expectedMapHashAfter: sha("s"), walRef: "w" } };
    ok(PM.validateDecisionV2(basePd).length === 0, "정합 정책 decision 통과(귀속·선택 결속 전부 일치)");
    ok(PM.validateDecisionV2({ ...basePd, classification: "auto", actor: { kind: "auto" }, resolution: { outcome: "applied", evidenceRef: "auto" } }).some((e) => e.includes("intent-choice")), "정책 op auto actor=거부(자동 생성 금지 — 4차 #4)");
    const polBad = mkPatch("create_intent_policy"); // createdFromDecision=U(21)≠decisionId
    ok(PM.validateDecisionV2({ ...basePd, patch: polBad, opHash: PM.opHashV2Of(polBad) }).some((e) => e.includes("createdFromDecision")), "artifact 귀속 불일치=거부(5차 #1)");
    ok(PM.validateDecisionV2({ ...basePd, resolution: { outcome: "applied", evidenceRef: "card-C" } }).some((e) => e.includes("선택 결속") || e.includes("cardId")), "선택 참조 불일치(evidenceRef≠cardId)=거부(5차 #2)");
    ok(PM.validateDecisionV2({ ...basePd, actor: { kind: "user-choice", cardId: "card-B" }, resolution: { outcome: "applied", evidenceRef: "card-B" } }).some((e) => e.includes("authorizationRefs")), "authz에 없는 카드=거부(문자열 actor만으로 선택 주장 차단)");
    ok(PM.validateDecisionV2({ ...basePd, actor: { kind: "user-choice" } }).some((e) => e.includes("cardId 필수")), "intent-choice cardId 부재=거부");
  }

  console.log("[10] v1 동결 무회귀 — 기존 API 지문·동작 불변");
  ok(PM.PATCH_OPS.length === 8 && PM.PATCH_OPS.includes("retire_candidate"), "v1 PATCH_OPS 동결(retire_candidate 그대로)");
  ok(typeof PM.validatePatch === "function" && typeof PM.policyTier === "function", "v1 검증기·정책기 존치");
  ok(PM.opHashOf({ a: 1, b: { d: 2, c: 3 } }) === PM.opHashOf({ b: { c: 3, d: 2 }, a: 1 }), "opHashOf 깊은 정렬 동작 불변");

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}
main();
