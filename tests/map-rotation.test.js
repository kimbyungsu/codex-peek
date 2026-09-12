/*
 * [HARNESS-STRUCTURE-2026-09-11 §B2] 지도 칸 회전 — 1차 묶음 (1)(4)(5).
 *  (1) 상한 계수=활성 file 노드만 + 순증분(add_node·split_node·보강 사전검사) — 내려간 칸은 자리를 차지하지 않음
 *  (4) 요청 계획: 가득이면 add_node 견본 제외+자료 줄 · 상한 거부 사유 구조화(failureDetail) · 화면 실사유
 *  (5) v1 정책 함수 표기(실분류=map-pipeline DEFAULT_CLASSIFICATION)
 */
const fs = require("fs"), os = require("os"), path = require("path");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "map-rot-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const PM = require("../bridge/project-map.js");
const ME = require("../bridge/map-enrich.js");
const EP = require("../bridge/enrich-providers.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ST = (lc) => ({ lifecycle: lc || "active", implementation: "runtime", confidence: "candidate" });
const fileNode = (i, lc) => ({ id: U(1000 + i), label: "m" + i, entityType: "file", roles: [], state: ST(lc), anchors: [{ kind: "code", path: "src/m" + i + ".js" }] });
const mkTopo = (nodes) => ({
  schemaVersion: 2, mapId: U(100), draft: true, project: "p", createdAt: "2026-07-12T00:00:00Z", revision: 3, nodes, edges: [],
  inventory: { scanComplete: true, filesSeen: nodes.length, policyExcluded: [], depthCapped: [], entryCapped: false, unreadable: [], semantic: { supportedLangs: ["js"], scannedSupportedFiles: nodes.length, unsupportedFiles: 0 } },
  freshnessNote: "n/a",
});
const CAP = PM.MAX_FILE_NODES;
const capErr = (v) => !!(v && Array.isArray(v.errors) && v.errors.some((e) => /file 노드 전체 상한/.test(e)));
const addPatch = (topo, lc) => ({ schema: "map-patch-v2", mapId: topo.mapId, operation: "add_node", payload: { node: { id: U(9999), label: "new", entityType: "file", roles: [], state: ST(lc), anchors: [{ kind: "code", path: "src/new.js" }] } }, evidence: [{ kind: "code", ref: "src/new.js" }], rationale: "r" });

console.log("[1] 활성 계수·순증분(순수 함수)");
{ const t = mkTopo([...Array.from({ length: 59 }, (_, i) => fileNode(i, "deprecated")), fileNode(59, "active")]);
  ok(PM.activeFileNodeCount(t) === 1, "deprecated 59 + active 1 → 활성 1");
  ok(PM.isActiveFileNode({ entityType: "file", state: {} }) && PM.isActiveFileNode({ entityType: "file" }) && !PM.isActiveFileNode({ entityType: "module", state: ST("active") }), "lifecycle 부재=active 호환 · file 아님=제외");
  ok(PM.activeFileDelta(t, "add_node", { node: fileNode(70, "active") }) === 1 && PM.activeFileDelta(t, "add_node", { node: fileNode(71, "deprecated") }) === 0 && PM.activeFileDelta(t, "add_edge", {}) === 0, "add_node 순증분: 활성 +1 · 내려간 0 · 그 밖 0");
  ok(PM.activeFileDelta(t, "split_node", { newNodes: [fileNode(80), fileNode(81)] }, U(1000 + 59)) === 1, "활성 원본 분할 → −1+2=+1");
  ok(PM.activeFileDelta(t, "split_node", { newNodes: [fileNode(80), fileNode(81)] }, U(1000 + 0)) === 2, "내려간 원본 분할 → −0+2=+2(2판 blocker)"); }

console.log("[2] 정본 상한 검사 — 활성 기준(semanticValidateV2)");
{ const tFull = mkTopo(Array.from({ length: CAP }, (_, i) => fileNode(i, "active")));
  const tMixed = mkTopo([...Array.from({ length: CAP - 1 }, (_, i) => fileNode(i, "deprecated")), fileNode(CAP - 1, "active")]);
  ok(capErr(PM.semanticValidateV2(tFull, addPatch(tFull, "active"), {})), "활성 60 → add_node(file) 거부(무회귀)");
  ok(!capErr(PM.semanticValidateV2(tMixed, addPatch(tMixed, "active"), {})), "deprecated 59 + active 1 → add_node 허용(내려간 칸은 자리 차지 안 함)");
  ok(!capErr(PM.semanticValidateV2(tFull, addPatch(tFull, "deprecated"), {})), "들어오는 노드가 내려간 상태면 상한 무관(순증분 0)");
  // split: 활성 59 + 내려간 원본 1 을 활성 2개로 분할 → 활성 61 → 거부 / 활성 원본 분할(60 상태) → −1+2=61 → 거부 / 59 상태 활성 원본 → 60 → 허용
  const mkSplit = (topo, srcId) => ({ schema: "map-patch-v2", mapId: topo.mapId, operation: "split_node", targetId: srcId, payload: { newNodes: [fileNode(80), fileNode(81)], anchorAssign: {}, conditionAssign: {}, edgeReroute: [] }, evidence: [{ kind: "code", ref: "src/x.js" }], rationale: "r" });
  const t59d = mkTopo([...Array.from({ length: CAP - 1 }, (_, i) => fileNode(i, "active")), fileNode(CAP - 1, "deprecated")]);
  const vD = PM.semanticValidateV2(t59d, mkSplit(t59d, U(1000 + CAP - 1)), {});
  ok(capErr(vD), "내려간 원본을 활성 2개로 분할해 활성 61 → 거부(2판 blocker · 실제: " + JSON.stringify((vD && vD.errors || []).filter((e) => /상한/.test(e))) + ")");
  const vA = PM.semanticValidateV2(tFull, mkSplit(tFull, U(1000 + 0)), {});
  ok(capErr(vA), "활성 60 상태에서 활성 원본 분할(−1+2) → 61 → 거부");
  const t59a = mkTopo(Array.from({ length: CAP - 1 }, (_, i) => fileNode(i, "active")));
  ok(!capErr(PM.semanticValidateV2(t59a, mkSplit(t59a, U(1000 + 0)), {})), "활성 59 상태에서 활성 원본 분할 → 60 → 상한 사유 없음"); }

console.log("[3] 보강 사전검사 — 활성 기준 + 상한 사유 구조(detail)");
{ const item = (n) => ({ op: "add_node", payload: { node: fileNode(n, "active") }, evidence: [{ file: "src/m" + n + ".js", quote: "q" }] });
  const tFull = mkTopo(Array.from({ length: CAP }, (_, i) => fileNode(i, "active")));
  const vr = ME.validateEnrichResult({ schema: "enrich-result-v1", items: [item(90)] }, tFull, null);
  ok(vr.ok === false && vr.errors.some((e) => /전체 상한 초과 예정/.test(e)), "활성 60 + add_node 1 → 사전검사 거부");
  ok(vr.detail && vr.detail.kind === "file-cap" && vr.detail.have === CAP + 1 && vr.detail.cap === CAP && vr.detail.active === CAP, "거부 사유 구조 {file-cap, have 61, cap 60, active 60}: " + JSON.stringify(vr.detail));
  const tMixed = mkTopo([...Array.from({ length: CAP - 1 }, (_, i) => fileNode(i, "deprecated")), fileNode(CAP - 1, "active")]);
  const vm = ME.validateEnrichResult({ schema: "enrich-result-v1", items: [item(90)] }, tMixed, null);
  ok(!(vm.errors || []).some((e) => /전체 상한 초과 예정/.test(e)) && !vm.detail, "deprecated 59 + active 1 → 상한 사유 없음·detail 없음");
  // [구현 검증 1판 blocker] 활성 60 상태에서 '내려간' 새 노드(lifecycle=deprecated)는 자리를 차지하지 않으므로 사전검사도 상한 사유 없음(정본 activeFileDelta 0 과 동형)
  const itemDep = { op: "add_node", payload: { node: fileNode(91, "deprecated") }, evidence: [{ file: "src/m91.js", quote: "q" }] };
  const vDep = ME.validateEnrichResult({ schema: "enrich-result-v1", items: [itemDep] }, tFull, null);
  ok(!(vDep.errors || []).some((e) => /전체 상한 초과 예정/.test(e)) && !vDep.detail, "활성 60 + 내려간 새 노드 1 → 사전검사 상한 사유 없음(정본과 동형)"); }

console.log("[4] 요청 계획 — 가득이면 add_node 견본 제외 + 자료 줄");
{ const repo = fs.mkdtempSync(path.join(os.tmpdir(), "map-rot-repo-")); fs.writeFileSync(path.join(repo, "app.js"), "// app", "utf8");
  const nodesFull = Array.from({ length: CAP }, (_, i) => ({ ...fileNode(i, "active"), anchors: [{ kind: "code", path: "app.js" }] }));
  const pFull = EP.buildEnrichPrompt({ repo, topo: { nodes: nodesFull, edges: [] }, changed: ["app.js"] });
  ok(!pFull.includes('"op":"add_node"') && pFull.includes("지도 상태: 활성 file 노드 " + CAP + "/" + CAP + " · 빈 칸 0") && !/마라|하라/.test(pFull.split("\n").find((l) => l.includes("지도 상태")) || ""), "활성 60 → add_node 견본 없음 + 상태 자료 줄(지시 문구 없음)");
  const nodesMixed = nodesFull.map((n, i) => (i < CAP - 1 ? { ...n, state: ST("deprecated") } : n));
  const pMixed = EP.buildEnrichPrompt({ repo, topo: { nodes: nodesMixed, edges: [] }, changed: ["app.js"] });
  ok(pMixed.includes('"op":"add_node"') && !pMixed.includes("지도 상태:"), "deprecated 59 + active 1 → add_node 견본 유지");
  const pRot = EP.buildEnrichPrompt({ repo, topo: { nodes: nodesFull, edges: [] }, changed: ["app.js"], rotation: { enabled: true } });
  ok(pRot.includes('"op":"add_node"') && !pRot.includes("지도 상태:"), "회전이 켜지면 가득이어도 add_node 유지(교체가 받음 — §B2 (3) 대비)"); }

console.log("[5] job 스키마 — failureDetail 닫힌 모양(strict)");
{ const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  ok(src.includes('"failureDetail", "parkedReason"') && src.includes('return "attempt failureDetail"'), "ATTEMPT_KEYS 에 failureDetail · 이형=손상 검사");
  ok(src.includes('{ failureDetail: { kind: "file-cap", have: Number(vr.detail.have), cap: Number(vr.detail.cap), active: Number(vr.detail.active) } }'), "validation 실패 시 상한 사유를 attempt 에 구조로 보존"); }

console.log("[6] 화면 — 상한 실사유 표시·v1 정책 함수 표기·실분류 주석");
{ const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(ext.includes('detail: last9.failureDetail && last9.failureDetail.kind === "file-cap"'), "job payload 에 lastFailure.detail(구조만 · 자유 문자열 비전송)");
  ok(ext.includes('if(lf.detail&&lf.detail.kind==="file-cap") return T("지도 칸이 가득 차 새 파일 칸이 거부됐어요(활성 "'), "화면 문구=실사유(활성 have>cap)");
  const ts = fs.readFileSync(path.join(__dirname, "..", "src", "project-map.ts"), "utf8");
  ok(ts.includes("v1 동결 계층 — 실경로(P2 파이프라인)에서는 호출되지 않는다") && typeof PM.policyTier === "function", "policyTier=v1 동결 표기(삭제 대신 · 시험 계약 유지)");
  const mp = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-pipeline.js"), "utf8");
  ok(mp.includes("이 표가 지도 patch 분류의 '실제' 정책이다"), "DEFAULT_CLASSIFICATION 에 의도 이관 주석"); }

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
