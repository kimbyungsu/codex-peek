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
  ok(/const ATTEMPT_KEYS = \[[^\]]*"failureDetail"[^\]]*"parkedReason"[^\]]*\]/.test(src) && src.includes('return "attempt failureDetail"'), "ATTEMPT_KEYS 에 failureDetail · 이형=손상 검사");
  ok(src.includes('{ failureDetail: { kind: "file-cap", have: Number(vr.detail.have), cap: Number(vr.detail.cap), active: Number(vr.detail.active) } }'), "validation 실패 시 상한 사유를 attempt 에 구조로 보존"); }

console.log("[6] 화면 — 상한 실사유 표시·v1 정책 함수 표기·실분류 주석");
{ const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(ext.includes('detail: last9.failureDetail && last9.failureDetail.kind === "file-cap"'), "job payload 에 lastFailure.detail(구조만 · 자유 문자열 비전송)");
  ok(ext.includes('if(lf.detail&&lf.detail.kind==="file-cap") return T("지도 칸이 가득 차 새 파일 칸이 거부됐어요(활성 "'), "화면 문구=실사유(활성 have>cap)");
  const ts = fs.readFileSync(path.join(__dirname, "..", "src", "project-map.ts"), "utf8");
  ok(ts.includes("v1 동결 계층 — 실경로(P2 파이프라인)에서는 호출되지 않는다") && typeof PM.policyTier === "function", "policyTier=v1 동결 표기(삭제 대신 · 시험 계약 유지)");
  const mp = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-pipeline.js"), "utf8");
  ok(mp.includes("이 표가 지도 patch 분류의 '실제' 정책이다"), "DEFAULT_CLASSIFICATION 에 의도 이관 주석"); }

console.log("[7] git 사실 판독 — 삭제·이름변경(--name-status -M -z)");
const { spawnSync } = require("child_process");
const MRot = require("../bridge/map-rotation.js");
const MP = require("../bridge/map-pipeline.js");
const MR = require("../bridge/map-runtime.js");
const MB = require("../bridge/map-bootstrap.js");
const CL = require("../bridge/contract-lib.js");
const g = (repo, args) => spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", windowsHide: true });
function gitRepo(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "map-rot-git-" + tag + "-"));
  g(ws, ["init", "-q"]); g(ws, ["config", "user.email", "t@t"]); g(ws, ["config", "user.name", "t"]); g(ws, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n"); fs.writeFileSync(path.join(ws, "src", "m0.js"), "// m0\nfunction m0(){}\n"); fs.writeFileSync(path.join(ws, "src", "m1.js"), "// m1\n");
  g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "init"]);
  return ws;
}
const headOf = (ws) => g(ws, ["rev-parse", "HEAD"]).stdout.trim();
{ const ws = gitRepo("facts"); const h0 = headOf(ws);
  fs.unlinkSync(path.join(ws, "src", "m0.js")); g(ws, ["mv", "src/m1.js", "src/m1-renamed.js"]); fs.writeFileSync(path.join(ws, "src", "a.js"), "// a2\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "chg"]);
  const h1 = headOf(ws); const f = MRot.gitFactsSince(ws, h0, h1);
  ok(f && f.deleted.length === 1 && f.deleted[0] === "src/m0.js", "삭제 판독: " + JSON.stringify(f && f.deleted));
  ok(f && f.renamed.length === 1 && f.renamed[0].from === "src/m1.js" && f.renamed[0].to === "src/m1-renamed.js", "이름변경 판독(-M): " + JSON.stringify(f && f.renamed));
  ok(f && f.changed.includes("src/a.js") && f.changed.includes("src/m1-renamed.js"), "변경 목록(수정·새 경로)");
  ok(MRot.gitFactsSince(ws, "zz", h1) === null && JSON.stringify(MRot.gitFactsSince(ws, h1, h1)) === JSON.stringify({ deleted: [], renamed: [], changed: [] }), "잘못된 OID=null · 같은 커밋=빈 사실"); }

console.log("[8] 사실 기반 내리기 — 정규 패치(propose→classify→apply)·하네스 표식·git 근거·멱등");
function mapRepo(tag) {
  const ws = gitRepo(tag);
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const r = MR.initTopologyForBootstrap(ws); if (r.st !== "created") throw new Error("init " + r.st);
  ok(MB.ensureQueue(ws, PM) === true, "(전제 " + tag + ") 큐 생성");
  return ws;
}
function addFileNode(ws, relPath, extra) {
  const topo = MR.readTopoExFor(ws).topo;
  const node = { id: ME.detFileNodeId(topo.mapId, relPath), label: path.basename(relPath), entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: relPath }], ...(extra || {}) };
  const b = MRot.buildHarnessPatch(ws, topo, { operation: "add_node", payload: { node }, rationale: "test add", detectedBy: "git-name-status", evidence: [{ kind: "code", ref: relPath }] });
  if (!b.ok) throw new Error("build " + b.error);
  const r = MRot.applyHarnessPatch(ws, b.patch); if (!r.ok) throw new Error("apply " + r.stage + " " + r.error);
  return node.id;
}
const nodeOf = (ws, id) => (MR.readTopoExFor(ws).topo.nodes || []).find((n) => n.id === id);
// 60칸 지도 템플릿(한 번만 구축 — 블록마다 60번 파이프라인을 돌리면 ~4분) → 블록은 복제본을 쓴다(계약·동의·큐는 새 경로로 다시).
let FULL_TEMPLATE = null;
function fullRepo(tag) {
  if (!FULL_TEMPLATE) {
    const ws0 = mapRepo("template");
    const names = Array.from({ length: CAP }, (_, i) => "src/f" + i + ".js");
    for (const n of names) fs.writeFileSync(path.join(ws0, n), "// " + n + "\n");
    const envOld = { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00", GIT_AUTHOR_DATE: "2020-01-01T00:00:00" };
    spawnSync("git", ["-c", "safe.directory=*", "-C", ws0, "add", "-A"], { windowsHide: true });
    spawnSync("git", ["-c", "safe.directory=*", "-C", ws0, "commit", "-q", "-m", "fill", "--date", "2020-01-01T00:00:00"], { env: envOld, windowsHide: true });
    const ids = names.map((n) => addFileNode(ws0, n));
    FULL_TEMPLATE = { dir: ws0, names, ids };
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "map-rot-git-" + tag + "-"));
  fs.cpSync(FULL_TEMPLATE.dir, ws, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  ok(MB.ensureQueue(ws, PM) === true && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP, "(전제 " + tag + ") 60칸 지도 복제·큐 생성");
  return { ws, names: FULL_TEMPLATE.names.slice(), ids: FULL_TEMPLATE.ids.slice() };
}
{ const ws = mapRepo("fact"); const idM0 = addFileNode(ws, "src/m0.js"); const idM1 = addFileNode(ws, "src/m1.js");
  ok(nodeOf(ws, idM0).state.lifecycle === "active", "(전제) file 노드 2개 활성");
  const h0 = headOf(ws);
  fs.unlinkSync(path.join(ws, "src", "m0.js")); g(ws, ["mv", "src/m1.js", "src/m1-renamed.js"]); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "chg"]);
  const h1 = headOf(ws); const facts = MRot.gitFactsSince(ws, h0, h1);
  const r1 = MRot.applyFactTransitions(ws, facts, h1, null);
  ok(r1.ok && r1.applied.length === 2 && r1.failed.length === 0, "삭제·이름변경 2건 → 내리기 적용 2·실패 0: " + JSON.stringify(r1.failed));
  const n0 = nodeOf(ws, idM0), n1 = nodeOf(ws, idM1);
  ok(n0.state.lifecycle === "deprecated" && n1.state.lifecycle === "deprecated", "두 노드 lifecycle=deprecated(배열 잔존 · 기록 보존)");
  const dec0 = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", n0.provenance.decisionId + ".json"), "utf8"));
  ok(dec0.patch.provider === "harness-git" && dec0.patch.detectedBy === "git-name-status" && dec0.patch.rationale.startsWith("file-gone@") && dec0.patch.evidence[0].kind === "git" && dec0.patch.evidence[0].ref === h1, "결정 기록: provider harness-git · detectedBy git-name-status · rationale file-gone@ · git 근거=커밋 OID");
  ok(dec0.actor && typeof dec0.actor === "object" && dec0.actor.kind === "auto", "decision.actor 는 파이프라인 객체 그대로({kind:auto})");
  const dec1 = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", n1.provenance.decisionId + ".json"), "utf8"));
  ok(dec1.patch.rationale.startsWith("renamed-to:src/m1-renamed.js@"), "이름변경 rationale 에 새 경로");
  const r2 = MRot.applyFactTransitions(ws, facts, h1, null);
  ok(r2.ok && r2.applied.length === 0, "같은 사실 재적용=멱등(이미 내려간 노드는 건너뜀)");
  ok(MRot.harnessDeprecationOf(ws, nodeOf(ws, idM0)).rationale.startsWith("file-gone@"), "하네스 통로 판독(harnessDeprecationOf)");
  // 근거 관문: git 근거만 있는데 detectedBy 가 없으면 정본 관문이 거부(모델 출력 우회 불가)
  const topoX = MR.readTopoExFor(ws).topo;
  const bad = MRot.buildHarnessPatch(ws, topoX, { operation: "set_state", targetId: idM0, payload: { to: { lifecycle: "active" }, expect: { lifecycle: "deprecated" } }, rationale: "x", detectedBy: "model-output", evidence: [{ kind: "git", ref: h1 }] });
  ok(bad.ok === false && /code\/test\/config/.test(bad.error), "detectedBy 가 사실 표식이 아니면 git 근거만으로는 관문 거부: " + bad.error);
  const badRef = MRot.buildHarnessPatch(ws, topoX, { operation: "set_state", targetId: idM0, payload: { to: { lifecycle: "active" }, expect: { lifecycle: "deprecated" } }, rationale: "x", detectedBy: "git-name-status", evidence: [{ kind: "git", ref: "notahash" }] });
  ok(badRef.ok === false && /OID|evidence 항목 불량/.test(badRef.error), "git 근거 ref 는 커밋 OID 형식이어야(정본 evidence 검사 거부): " + badRef.error);
  const ghost = MRot.buildHarnessPatch(ws, topoX, { operation: "set_state", targetId: idM0, payload: { to: { lifecycle: "active" }, expect: { lifecycle: "deprecated" } }, rationale: "x", detectedBy: "git-name-status", evidence: [{ kind: "git", ref: "0".repeat(40) }] });
  const ghostR = ghost.ok ? MRot.applyHarnessPatch(ws, ghost.patch) : { ok: false, stage: "build", error: ghost.error };
  ok(ghostR.ok === false && /미실존|hard-reject/.test(String(ghostR.error)), "실존하지 않는 커밋을 근거로 대면 적용기가 거부: " + ghostR.error);
  // 복귀: 삭제 파일 복원(파일 실존) → active
  fs.writeFileSync(path.join(ws, "src", "m0.js"), "// m0 back\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "back"]); const h2 = headOf(ws);
  const rv = MRot.applyRevivals(ws, [], h2, null);
  ok(rv.ok && rv.applied.length === 1 && nodeOf(ws, idM0).state.lifecycle === "active", "복원된 파일의 칸은 active 복귀(revived@) · 이름변경분은 파일 없음이라 그대로");
  const decR = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", nodeOf(ws, idM0).provenance.decisionId + ".json"), "utf8"));
  ok(decR.patch.rationale.startsWith("revived@") && decR.patch.detectedBy === "git-name-status", "복귀 결정 rationale revived@"); }

console.log("[9] 교체 후보(순수) — 보호·점수·결정성");
{ const mk = (i, conf, deg) => ({ id: U(2000 + i), label: "f" + i, entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/f" + i + ".js" }], ...(conf ? { state: { lifecycle: "active", implementation: "runtime", confidence: conf } } : {}) });
  const nodes = [mk(0, "candidate"), mk(1, "confirmed"), mk(2, "candidate"), mk(3, "confirmed"), mk(4, "candidate")];
  const edges = [{ id: U(3001), from: U(2001), to: U(2000), relation: "calls", state: ST("active") }, { id: U(3002), from: U(2001), to: U(2002), relation: "calls", state: ST("active") }, { id: U(3003), from: U(2001), to: U(2004), relation: "calls", state: ST("active") }];
  const topo = { nodes, edges }; const now = 1_800_000_000; const D = 86400;
  const ages = new Map([["src/f0.js", now - 100 * D], ["src/f1.js", now - 200 * D], ["src/f2.js", now - 5 * D], ["src/f3.js", now - 300 * D]]); // f4 시각 미상
  const pol = { enabled: true, protectDays: 14, hubMinDegree: 3 };
  const c = MRot.rotateCandidate(topo, ages, pol, now);
  ok(c && c.id === U(2003), "가장 오래된 비허브(f3: 300일·confirmed·간선 0)가 후보 — 허브 f1(간선 3·confirmed 200일)은 보호: " + (c && c.path));
  ok(MRot.rotateCandidate({ nodes: [mk(2, "candidate")], edges: [] }, ages, pol, now) === null, "최근 변경(5일<14일)만 있으면 후보 없음");
  ok(MRot.rotateCandidate({ nodes: [mk(4, "candidate")], edges: [] }, ages, pol, now) === null, "시각 미상은 보호");
  const same = new Map([["src/f0.js", now - 50 * D], ["src/f2.js", now - 50 * D]]);
  ok(MRot.rotateCandidate({ nodes: [mk(2, "candidate"), mk(0, "candidate")], edges: [] }, same, pol, now).id === U(2000), "동점=id 사전순(결정성)");
  ok(MRot.rotationPolicyFor(path.join(HOME, "no-such-ws")).enabled === true && MRot.rotationPolicyFor(path.join(HOME, "no-such-ws")).protectDays === 14, "정책 기본값=켜기·14일·허브 3(계약 없음)"); }

console.log("[10] 교체 실행 — 방출(정규 패치)·부분 상태 표식·보상·재개 보상");
{ const { ws, names, ids } = fullRepo("rot");
  const ages0 = MRot.gitLastCommitEpochs(ws, names.slice(0, 2), 5000);
  ok(ages0.size === 2 && [...ages0.values()].every((v) => v < 1_600_000_000), "마지막 커밋 시각 판독(과거 시각)");
  const topoFull = MR.readTopoExFor(ws).topo;
  ok(PM.activeFileNodeCount(topoFull) === CAP, "(전제) 활성 file 노드=상한");
  fs.writeFileSync(path.join(ws, "src", "new.js"), "// new\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new"]);
  const newNode = { id: U(9001), label: "new", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new.js" }] };
  const addP = { operation: "add_node", payload: { node: newNode } };
  let jobState = { rotationPartial: null }; const updateJob = (mut) => { jobState = mut(jobState); return { ok: true }; };
  const logs = [];
  const r = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: topoFull, head: headOf(ws), updateJob, log: (e) => logs.push(e) });
  ok(r.rotated === true && ids.includes(r.victimId), "가득 찬 상태의 활성 add_node 앞에서 후보 1개 방출: " + r.victimPath);
  ok(nodeOf(ws, r.victimId).state.lifecycle === "deprecated" && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP - 1, "방출 노드 deprecated · 활성 59");
  const decV = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", nodeOf(ws, r.victimId).provenance.decisionId + ".json"), "utf8"));
  ok(decV.patch.detectedBy === "rotation" && decV.patch.rationale.startsWith("rotated-out@") && decV.patch.rationale.includes("src/new.js"), "방출 결정: detectedBy rotation · rationale rotated-out@ for src/new.js");
  ok(jobState.rotationPartial && jobState.rotationPartial.victimId === r.victimId && ["sha1", "sha256"].includes(jobState.rotationPartial.objectFormat) && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(jobState.rotationPartial.head), "부분 상태 표식이 방출 전에 기록됨(objectFormat·head)");
  ok(logs.some((e) => e.route === "rotation" && e.reason === "rotated-out"), "route 로그 rotation/rotated-out");
  ok(MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null }).rotated === false, "활성 59 → 교체 없음");
  ok(MRot.rotateBeforeAdd(ws, ws, { patch: { operation: "add_node", payload: { node: { ...newNode, state: ST("deprecated") } } }, topo: topoFull, head: headOf(ws), updateJob, log: null }).rotated === false, "들어오는 노드가 내려간 상태면 교체 없음");
  // 보상: 방출을 되돌린다 → active · 멱등
  const comp = MRot.rotationCompensate(ws, r.victimId, headOf(ws));
  ok(comp.ok && nodeOf(ws, r.victimId).state.lifecycle === "active", "보상 패치 → 방출 노드 active 복원(rotation-reverted@)");
  ok(MRot.rotationCompensate(ws, r.victimId, headOf(ws)).ok === true && MRot.rotationCompensate(ws, r.victimId, headOf(ws)).noop === true, "이미 active 면 멱등 성공");
  // 재개 보상: job 에 부분 상태가 남아 있으면 실행 시작 통과가 먼저 되돌린다
  const r2 = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null });
  ok(r2.rotated === true, "(전제) 다시 방출");
  const fp = MRot.factPass(ws, ws, { job: { rotationPartial: jobState.rotationPartial }, baselineHead: null, updateJob, log: null });
  ok(fp.compensated && fp.compensated.ok && nodeOf(ws, r2.victimId).state.lifecycle === "active" && jobState.rotationPartial === null, "실행 시작 통과가 부분 상태를 먼저 보상하고 표식을 지움");
  // 교체 꺼짐 정책
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on", mapRotation: { enabled: false } }));
  ok(MRot.rotationPolicyFor(ws).enabled === false && MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null }).rotated === false, "계약 mapRotation.enabled=false → 교체 없음(종전 거부 경로)"); }

console.log("[11] job 스키마 — rotationPartial 닫힌 모양·배선·배포 편입");
{ const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  ok(src.includes('"attempts", "rotationPartial"]') && src.includes('return "rotationPartial"'), "JOB_KEYS 에 rotationPartial · 이형=손상");
  ok(src.includes("MRot.factPass(repo, o.ws || repo, { job:") && src.indexOf("MRot.factPass(") < src.indexOf("const lk = MR.withMapLock(repo, () => {"), "실행 시작 통과가 topology 캡처 앞");
  ok(src.includes("rot9 = MRot9.rotateBeforeAdd(repo, o.ws || repo, { patch, topo: topoNow.topo") && src.includes('parkedReason: "rotation-partial"'), "add_node 직전 교체 훅·부분 상태 보류");
  const mp = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-pipeline.js"), "utf8");
  ok(mp.includes('e9.kind === "git" && !gitCommitExists(repo, e9.ref)'), "적용기: git 근거 커밋 실존 검사");
  const ts = fs.readFileSync(path.join(__dirname, "..", "src", "project-map.ts"), "utf8");
  ok(ts.includes('"doc", "git"] as const') && ts.includes("FACT_DETECTED_BY.includes(String(p.detectedBy || \"\"))"), "정본: EVIDENCE_KINDS git · 사실 표식 관문");
  ok(fs.readFileSync(path.join(__dirname, "..", "install.js"), "utf8").includes('"map-rotation.js"') && fs.readFileSync(path.join(__dirname, "..", "src", "hook-setup.ts"), "utf8").includes('"map-rotation.js"') && fs.readFileSync(path.join(__dirname, "..", "bridge", "map-cutover.js"), "utf8").includes('"map-rotation.js"'), "배포 목록 3사본 편입");
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(ext.includes('"rotation-failed": [') && ext.includes('"rotation-partial": ['), "화면 보류 사유 문구 2종"); }

console.log("[12] 확인 검증 1판 — 표식 정산(순수)·부분 적용 실패 표식 유지·상한 시 보상 금지·HEAD 결속·SHA-256 기준점");
{ const pend = { victimId: U(1), head: "a".repeat(40) };
  ok(MRot.settleRotation({ done: true, applied: true }, pend) === "clear" && MRot.settleRotation({ done: true, applied: false, rejected: true }, pend) === "compensate" && MRot.settleRotation({ parkReason: "x" }, pend) === "compensate" && MRot.settleRotation({ retry: true }, pend) === "keep" && MRot.settleRotation({ revUp: true }, pend) === "keep" && MRot.settleRotation({ done: true, applied: true }, null) === "none", "settleRotation: 적용=clear · 거부/보류=compensate · 일시=keep · 표식 없음=none");
  // 부분 적용 실패: 실제로 내려간 뒤 실패를 돌려주는 적용기 → 표식 유지 / 아무것도 안 바꾸고 실패 → 표식 회수
  const { ws, names, ids } = fullRepo("partial");
  fs.writeFileSync(path.join(ws, "src", "new2.js"), "// new2\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new2"]);
  const addP = { operation: "add_node", payload: { node: { id: U(9002), label: "new2", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new2.js" }] } } };
  let jobState = { rotationPartial: null }; const updateJob = (mut) => { jobState = mut(jobState); return { ok: true }; };
  const applyThenFail = (repo, patch) => { const r = MRot.applyHarnessPatch(repo, patch); return { ok: false, stage: "apply", error: "marker 기록 실패(재현)" + (r.ok ? "" : " " + r.error) }; };
  const rA = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, apply: applyThenFail, log: null });
  ok(rA.parkReason === "rotation-failed:apply" && rA.partialKept === true && jobState.rotationPartial && ids.includes(jobState.rotationPartial.victimId), "실물이 내려간 뒤 실패 → 보류 사유 + 표식 유지(다음 실행이 보상)");
  const victimA = jobState.rotationPartial.victimId;
  ok(nodeOf(ws, victimA).state.lifecycle === "deprecated" && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP - 1, "(상태) 방출 노드 deprecated · 활성 59");
  const fp = MRot.factPass(ws, ws, { job: { rotationPartial: jobState.rotationPartial }, baselineHead: null, updateJob, log: null });
  ok(fp.compensated && fp.compensated.ok && nodeOf(ws, victimA).state.lifecycle === "active" && jobState.rotationPartial === null && fp.head === headOf(ws) && fp.ok === true, "다음 실행 시작이 보상하고 표식 회수 · 통과가 본 HEAD 반환·ok");
  const failNoChange = () => ({ ok: false, stage: "propose", error: "재현" });
  const rB = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, apply: failNoChange, log: null });
  ok(rB.parkReason === "rotation-failed:propose" && rB.partialKept === false && jobState.rotationPartial === null && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP, "상태 변화 없는 실패 → 표식 회수·활성 60 유지");
  // 상한 시 보상 금지: 방출 뒤 새 칸이 들어와 활성 60이면 보상은 noop(cap-full) — 되돌리면 61
  const rC = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null });
  ok(rC.rotated === true, "(전제) 정상 방출");
  const idNew = addFileNode(ws, "src/new2.js");
  ok(PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP, "(전제) 새 칸 추가로 활성 60");
  const compC = MRot.rotationCompensate(ws, rC.victimId, headOf(ws));
  ok(compC.ok === true && compC.noop === true && compC.reason === "cap-full" && nodeOf(ws, rC.victimId).state.lifecycle === "deprecated" && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP, "활성 상한이면 보상은 되돌리지 않음(교체 완료로 정산) — 활성 61 경로 차단");
  const fp2 = MRot.factPass(ws, ws, { job: { rotationPartial: jobState.rotationPartial }, baselineHead: null, updateJob, log: null });
  ok(fp2.compensated && fp2.compensated.ok && jobState.rotationPartial === null, "실행 시작 통과도 같은 규칙으로 표식만 정리");
  void idNew;
  // SHA-256 저장소: 기준점·끝점 64자 OID
  const ws256 = fs.mkdtempSync(path.join(os.tmpdir(), "map-rot-sha256-"));
  const init256 = spawnSync("git", ["-c", "safe.directory=*", "-C", ws256, "init", "-q", "--object-format=sha256"], { encoding: "utf8", windowsHide: true });
  if (init256.status === 0) {
    g(ws256, ["config", "user.email", "t@t"]); g(ws256, ["config", "user.name", "t"]); g(ws256, ["config", "commit.gpgsign", "false"]);
    fs.mkdirSync(path.join(ws256, "src")); fs.writeFileSync(path.join(ws256, "src", "x.js"), "// x\n"); g(ws256, ["add", "-A"]); g(ws256, ["commit", "-q", "-m", "i"]);
    const h0 = headOf(ws256); fs.unlinkSync(path.join(ws256, "src", "x.js")); g(ws256, ["add", "-A"]); g(ws256, ["commit", "-q", "-m", "d"]); const h1 = headOf(ws256);
    ok(h0.length === 64 && MRot.OID_RE.test(h0), "sha256 저장소 HEAD=64자");
    const f256 = MRot.gitFactsSince(ws256, h0, h1);
    ok(f256 && f256.deleted[0] === "src/x.js", "64자 OID 로 사실 판독 동작");
  } else { ok(true, "(건너뜀) 이 git 은 --object-format=sha256 미지원: " + String(init256.stderr || "").trim().slice(0, 60)); }
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  ok(src.includes("const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;") && src.includes("OID_RE.test(String(o.head || \"\"))") && src.includes("if (!OID_RE.test(String(head || \"\"))) return false;") && src.includes("if (!OID_RE.test(String(endHead || \"\"))) return changed;") && src.includes("if (OID_RE.test(hH)) srcHead = hH;") && src.includes('if (!srcHead && queue.basis && queue.basis.kind === "git") {'), "map-enrich: 기준점 판독·기록·끝점·srcHead 캡처가 40|64자 OID");
  ok(src.includes("let srcHead = factHead0 || null;") && src.includes("factHead0 = fp0 && fp0.head ? fp0.head : null;"), "사실 전이 통과의 HEAD 가 소화 기준점 끝점(srcHead)에 결속");
  ok(src.includes("if (st && st.srcHead && st.factsOk === true) writeConsumedBaseline(repo, st.srcHead, j.mapId);") && (src.match(/srcFp, srcHead, factsOk: factsOk0/g) || []).length >= 5 && (src.match(/factsOk: st2 \? st2\.factsOk : null/g) || []).length === 2, "사실 전이가 다 붙은 실행에서만 기준점 전진(st.factsOk===true · 복구 경로 2곳도 전달 · 값 없음=전진 금지)");
  ok(src.includes("const pendingRot9 = rot9.rotated ?") && src.includes("const act9 = MRotP.settleRotation(step, pendingRot9);"), "적용 루프 정산=작업에 남은 표식 기준(settleRotation)"); }
console.log("[13] 확인 검증 2판 — 정본 set_state 상한(잠금 안 권위)·강등 소유 결속·HEAD 없음=전진 금지·중간 재판독 실패=실패 기록·복구 경로 factsOk");
{ // (1) 순증분·정본 검사: 내려간 file 노드를 active 로 올리는 set_state=+1 → 활성 60 이면 거부 / 활성 노드를 내리는 set_state=0
  const tFull1 = mkTopo([...Array.from({ length: CAP }, (_, i) => fileNode(i, "active")), fileNode(CAP, "deprecated")]);
  const upP = { schema: "map-patch-v2", mapId: tFull1.mapId, operation: "set_state", targetId: U(1000 + CAP), payload: { to: { lifecycle: "active" }, expect: { lifecycle: "deprecated" } }, evidence: [{ kind: "code", ref: "src/f.js" }], rationale: "up", provider: "t", basis: {}, baseMapHash: "", baseAuthorityHash: "", baseDecisionContextHash: "" };
  const downP = { ...upP, targetId: U(1000 + 0), payload: { to: { lifecycle: "deprecated" }, expect: { lifecycle: "active" } } };
  ok(PM.activeFileDelta(tFull1, "set_state", upP.payload, upP.targetId) === 1 && PM.activeFileDelta(tFull1, "set_state", downP.payload, downP.targetId) === 0 && PM.activeFileDelta(tFull1, "set_state", upP.payload, U(424242)) === 0, "set_state 순증분: 내려간→active +1 · active→내려감 0 · 대상 없음 0");
  const vUp = PM.semanticValidateV2(tFull1, upP, {});
  ok(capErr(vUp) && (vUp.errors || []).some((e) => /^set_state: file 노드 전체 상한/.test(e)), "활성 60 에서 내려간 칸을 active 로 올리는 set_state → 정본 거부(적용 잠금 안 권위)");
  ok(!capErr(PM.semanticValidateV2(tFull1, downP, {})), "활성 칸을 내리는 set_state 는 상한 무관");
  const t59u = mkTopo([...Array.from({ length: CAP - 1 }, (_, i) => fileNode(i, "active")), fileNode(CAP - 1, "deprecated")]);
  ok(!capErr(PM.semanticValidateV2(t59u, { ...upP, mapId: t59u.mapId, targetId: U(1000 + CAP - 1) }, {})), "활성 59 → 올리기 허용(60)");
  // (2) 실행: 활성 60 + 회전으로 내려간 칸 → 파이프라인이 복귀 patch 를 거부하고, 되돌리기는 cap-full 로 정산(실물 재판독)
  const { ws, names, ids } = fullRepo("own");
  fs.writeFileSync(path.join(ws, "src", "new3.js"), "// new3\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new3"]);
  const addP = { operation: "add_node", payload: { node: { id: U(9003), label: "new3", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new3.js" }] } } };
  let jobState = { rotationPartial: null }; const updateJob = (mut) => { jobState = mut(jobState); return { ok: true }; };
  const r1 = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null });
  ok(r1.rotated === true && ids.includes(r1.victimId), "(전제) 방출 1");
  const info1 = MRot.harnessDeprecationOf(ws, nodeOf(ws, r1.victimId));
  ok(MRot.rotationOwns(info1, r1.head) === true && MRot.rotationOwns(info1, "f".repeat(40)) === false && MRot.rotationOwns(null, r1.head) === false, "rotationOwns: 결정 기록 detectedBy=rotation + rationale 커밋 표기(head)로 결속 · 다른 head/기록 없음=아님");
  addFileNode(ws, "src/new3.js"); // 새 칸 → 활성 60
  const topo60 = MR.readTopoExFor(ws).topo; const vic = topo60.nodes.find((n) => n.id === r1.victimId);
  const bUp = MRot.buildHarnessPatch(ws, topo60, { operation: "set_state", targetId: vic.id, payload: { to: { lifecycle: "active" }, expect: { lifecycle: "deprecated" } }, rationale: "rotation-reverted@" + r1.head.slice(0, 7), detectedBy: "rotation-revert", evidence: [{ kind: "git", ref: r1.head }] });
  ok(bUp.ok, "(전제) 복귀 patch 조립");
  const aUp = MRot.applyHarnessPatch(ws, bUp.patch);
  ok(aUp.ok === false && /file 노드 전체 상한/.test(String(aUp.error)) && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP, "활성 60 에서 복귀 patch 는 파이프라인(정본 검사)이 거부 — 활성 61 경로는 잠금 안에서 닫힘");
  const c60 = MRot.rotationCompensate(ws, r1.victimId, r1.head);
  ok(c60.ok === true && c60.noop === true && c60.reason === "cap-full", "되돌리기=cap-full 정산(표식 정리 대상)");
  // (3) 남의 강등: 회전이 아닌 결정(git-name-status file-gone)으로 내려간 칸은 되돌리지 않는다 / 방출 적용 실패 뒤 실물이 '남의 강등'이면 표식 회수
  jobState = { rotationPartial: null };
  const topoA = MR.readTopoExFor(ws).topo; const other = topoA.nodes.find((n) => n.id === ids[5]);
  const bGone = MRot.buildHarnessPatch(ws, topoA, { operation: "set_state", targetId: other.id, payload: { to: { lifecycle: "deprecated" }, expect: { lifecycle: "active" } }, rationale: "file-gone@" + headOf(ws).slice(0, 7), detectedBy: "git-name-status", evidence: [{ kind: "git", ref: headOf(ws) }] });
  ok(bGone.ok && MRot.applyHarnessPatch(ws, bGone.patch).ok, "(전제) 다른 결정(사실 전이)으로 칸 하나 내려감 → 활성 59");
  const cOther = MRot.rotationCompensate(ws, other.id, headOf(ws));
  ok(cOther.ok === true && cOther.noop === true && cOther.reason === "not-this-rotation" && nodeOf(ws, other.id).state.lifecycle === "deprecated", "회전이 아닌 강등은 되돌리지 않음(남의 결정 보존)");
  // 방출 적용 주입: 우리 patch 대신 '남의' 강등을 적용하고 실패를 돌려줌 → 실물은 deprecated 지만 소유가 아니므로 표식 회수
  addFileNode(ws, "src/o5b.js"); // 활성 60 복원(다른 파일)
  fs.writeFileSync(path.join(ws, "src", "new4.js"), "// new4\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new4"]);
  const addP4 = { operation: "add_node", payload: { node: { id: U(9004), label: "new4", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new4.js" }] } } };
  const foreignThenFail = (repo, patch) => { const t = MR.readTopoExFor(repo).topo; const n = t.nodes.find((x) => x.id === patch.targetId); const bF = MRot.buildHarnessPatch(repo, t, { operation: "set_state", targetId: n.id, payload: { to: { lifecycle: "deprecated" }, expect: { lifecycle: "active" } }, rationale: "file-gone@" + headOf(repo).slice(0, 7), detectedBy: "git-name-status", evidence: [{ kind: "git", ref: headOf(repo) }] }); const rF = MRot.applyHarnessPatch(repo, bF.patch); return { ok: false, stage: "apply", error: "재현(남의 강등 뒤 실패)" + (rF.ok ? "" : " " + rF.error) }; };
  const r4 = MRot.rotateBeforeAdd(ws, ws, { patch: addP4, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, apply: foreignThenFail, log: null });
  ok(r4.parkReason === "rotation-failed:apply" && r4.partialKept === false && jobState.rotationPartial === null, "실물이 내려갔어도 '남의 강등'이면 표식 회수(되돌리면 남의 결정을 뒤집으므로)");
  // (4) HEAD 없음(비git 폴더) → head null · ok=false(기준점 전진 금지)
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "map-rot-nogit-"));
  const fpN = MRot.factPass(noGit, noGit, { job: null, baselineHead: null, updateJob, log: null });
  ok(fpN.head === null && fpN.ok === false, "HEAD 판독 실패=ok:false(뒤의 별도 판독이 성공해도 기준점 전진 금지)");
  // (5) 소스 결속: 중간 topology 재판독 실패=failed 기록 · 복구 경로 2곳 factsOk 전달 · 완료 관문 === true
  const rsrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-rotation.js"), "utf8");
  ok(rsrc.includes('failed.push({ id: null, path: null, stage: "topology", error: "topology-unreadable (remaining transitions skipped)" }); break;') && rsrc.includes('failed.push({ id: n.id, path: p, stage: "topology", error: "topology-unreadable (remaining revivals skipped)" }); break;'), "사실 전이·복귀 중간 재판독 실패=failed 기록(ok:true·failed:[] 로 성공 위장 금지)");
  ok(rsrc.includes('if (!head) { out.ok = false; return out; }'), "factPass: HEAD 없음=ok:false");
  const esrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  ok((esrc.match(/factsOk: st2 \? st2\.factsOk : null/g) || []).length === 2 && esrc.includes("if (st && st.srcHead && st.factsOk === true) writeConsumedBaseline(repo, st.srcHead, j.mapId);"), "resumeJob 복구 경로 2곳 factsOk 전달 · 완료 관문은 === true(값 없음=전진 금지)");
  const pmsrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "project-map.js"), "utf8");
  ok(pmsrc.includes('if (operation === "set_state") {') && /set_state: file 노드 전체 상한/.test(pmsrc), "bridge 사본(project-map.js)에 set_state 상한 검사 동기"); }
console.log("[14] 확인 검증 3판 — 강등 결정 조회는 provenance 덮어쓰기에 견딤·기준점 없는 통과의 복귀 실패=전진 금지·HEAD 재조회 없음");
{ // (1) 회전 강등 뒤 같은 노드에 비상태 결정(add_evidence)이 적용돼 provenance 가 바뀌어도 강등 결정은 회전 것으로 판독 → 보상이 되돌린다
  const { ws, names, ids } = fullRepo("prov");
  fs.writeFileSync(path.join(ws, "src", "new5.js"), "// new5\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new5"]);
  const addP = { operation: "add_node", payload: { node: { id: U(9005), label: "new5", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new5.js" }] } } };
  let jobState = { rotationPartial: null }; const updateJob = (mut) => { jobState = mut(jobState); return { ok: true }; };
  const r = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null });
  ok(r.rotated === true && ids.includes(r.victimId), "(전제) 방출");
  const t1 = MR.readTopoExFor(ws).topo; const vic = t1.nodes.find((n) => n.id === r.victimId); const provBefore = vic.provenance && vic.provenance.decisionId;
  const bEv = MRot.buildHarnessPatch(ws, t1, { operation: "add_evidence", targetId: vic.id, payload: { evidence: { kind: "code", ref: names[(ids.indexOf(vic.id) + 1) % CAP], note: "other decision" } }, rationale: "다른 정상 구성요소의 근거 추가", evidence: [{ kind: "code", ref: names[(ids.indexOf(vic.id) + 1) % CAP] }] });
  ok(bEv.ok, "(전제) 비상태 결정(add_evidence) 조립: " + (bEv.ok ? "ok" : bEv.error));
  const aEv = bEv.ok ? MRot.applyHarnessPatch(ws, bEv.patch) : { ok: false };
  const vic2 = nodeOf(ws, vic.id);
  ok(aEv.ok && vic2.state.lifecycle === "deprecated" && vic2.provenance && vic2.provenance.decisionId !== provBefore, "(전제) 적용 뒤 lifecycle 은 그대로 deprecated · provenance.decisionId 는 새 결정으로 덮임: " + (aEv.ok ? "ok" : aEv.error));
  const dem = MRot.demotionDecisionOf(ws, vic2, MR.readTopoExFor(ws).topo);
  ok(dem && dem.decisionId === provBefore && dem.detectedBy === "rotation", "강등 결정 조회=색인에서 이 노드를 겨냥한 최근 set_state(→deprecated)=회전 결정(provenance 무관)");
  const info = MRot.harnessDeprecationOf(ws, vic2, MR.readTopoExFor(ws).topo);
  ok(MRot.rotationOwns(info, r.head) === true, "rotationOwns 가 여전히 참(3판 blocker: 비상태 결정이 덮어써도 소유 유지)");
  const comp = MRot.rotationCompensate(ws, r.victimId, r.head);
  ok(comp.ok === true && !comp.noop && nodeOf(ws, r.victimId).state.lifecycle === "active", "보상이 되돌린다(not-this-rotation 오판 없음) · 활성 60 복원");
  // provenance 만으로는(mapId 없이) 못 찾는다는 대조 — 색인 경로가 실제 동작임을 입증
  const provOnly = MRot.harnessDeprecationOf(ws, vic2, null);
  ok(provOnly === null, "(대조) 세대 없이 provenance 경로만이면 못 찾음 → 색인 경로가 판독 주체");
  // (2) 기준점 없는 실행 시작 통과: topology 를 읽을 수 없으면 복귀 실패 → ok:false(기준점 전진 금지)
  const ws2 = mapRepo("nobase");
  fs.writeFileSync(path.join(ws2, "project-map", "topology.json"), "{ not json");
  const fp2 = MRot.factPass(ws2, ws2, { job: null, baselineHead: null, updateJob, log: null });
  ok(fp2.head === headOf(ws2) && fp2.revived && fp2.revived.ok === false && fp2.ok === false, "기준점 없음 + topology 판독 실패 → 복귀 실패가 ok:false 에 반영(전진 금지)");
  // (3) 소스 결속: factPass 가 HEAD 를 봤으면 실행기는 rev-parse 를 다시 부르지 않는다
  const esrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  ok(esrc.includes('if (!srcHead && queue.basis && queue.basis.kind === "git") {') && !esrc.includes("if (!srcHead && OID_RE.test(hH)) srcHead = hH;"), "HEAD 판독은 하나 — srcHead 가 이미 있으면 rev-parse 생략(문서 §B2 ③ 과 일치)"); }
console.log("[15] 확인 검증 4판 — 같은 밀리초 강등 결정 둘: 순서는 시각이 아니라 topology 해시 사슬로");
{ // 회전 강등 → 되돌림 → 다른 결정(사실 전이)의 강등 → 비상태 결정으로 provenance 덮임 → 두 강등 결정의 audit.ts 를 같은 값으로 맞춘 뒤 조회
  const ws = mapRepo("chain");
  fs.writeFileSync(path.join(ws, "src", "c0.js"), "// c0\n"); fs.writeFileSync(path.join(ws, "src", "c1.js"), "// c1\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "c"]);
  const idC0 = addFileNode(ws, "src/c0.js"); addFileNode(ws, "src/c1.js");
  const h = headOf(ws);
  const lc = (to, expect, rationale, detectedBy) => { const t = MR.readTopoExFor(ws).topo; const n = t.nodes.find((x) => x.id === idC0); const b = MRot.buildHarnessPatch(ws, t, { operation: "set_state", targetId: n.id, payload: { to: { lifecycle: to }, expect: { lifecycle: expect } }, rationale, detectedBy, evidence: [{ kind: "git", ref: h }] }); if (!b.ok) throw new Error(b.error); const r = MRot.applyHarnessPatch(ws, b.patch); if (!r.ok) throw new Error(r.error); return r.decisionId; };
  const dRot = lc("deprecated", "active", "rotated-out@" + h.slice(0, 7) + " for src/x.js", "rotation");
  lc("active", "deprecated", "rotation-reverted@" + h.slice(0, 7), "rotation-revert");
  const dOther = lc("deprecated", "active", "file-gone@" + h.slice(0, 7), "git-name-status");
  const tE = MR.readTopoExFor(ws).topo;
  const bEv = MRot.buildHarnessPatch(ws, tE, { operation: "add_evidence", targetId: idC0, payload: { evidence: { kind: "code", ref: "src/c1.js", note: "x" } }, rationale: "근거 추가", evidence: [{ kind: "code", ref: "src/c1.js" }] });
  ok(bEv.ok && MRot.applyHarnessPatch(ws, bEv.patch).ok, "(전제) 비상태 결정으로 provenance 덮임");
  const decFile = (id) => path.join(ws, "project-map", "decisions", id + ".json");
  const same = "2026-01-01T00:00:00.000Z";
  for (const id of [dRot, dOther]) { const d = JSON.parse(fs.readFileSync(decFile(id), "utf8")); d.audit.ts = same; fs.writeFileSync(decFile(id), JSON.stringify(d, null, 1)); }
  const tNow = MR.readTopoExFor(ws).topo; const nC0 = tNow.nodes.find((x) => x.id === idC0);
  ok(nC0.state.lifecycle === "deprecated" && nC0.provenance.decisionId !== dOther && nC0.provenance.decisionId !== dRot, "(전제) 지금 deprecated · provenance 는 두 강등 결정 어느 쪽도 아님 · 두 강등의 audit.ts 동일");
  const dem = MRot.demotionDecisionOf(ws, nC0, tNow);
  ok(dem && dem.decisionId === dOther && dem.detectedBy === "git-name-status", "사슬 순서: 현재 강등의 원인=뒤의 사실 전이 결정(시각 동률·디렉터리 순서와 무관)");
  const chain = MRot.orderByChain(ws, tNow, [{ decisionId: dRot }, { decisionId: dOther }]);
  ok(chain.ok && chain.decision.decisionId === dOther, "orderByChain: 끝(현재 mapHashOf)에서 거슬러 처음 만나는 후보");
  ok(MRot.rotationOwns(MRot.harnessDeprecationOf(ws, nC0, tNow), h) === false, "회전 소유 아님 → 되돌리지 않음");
  const comp = MRot.rotationCompensate(ws, idC0, h);
  ok(comp.ok && comp.noop && comp.reason === "not-this-rotation" && nodeOf(ws, idC0).state.lifecycle === "deprecated", "보상=noop(not-this-rotation) · 남의 강등 보존");
  ok(MRot.demotionDecisionOf(ws, nC0, tNow.mapId) === null, "(대조) topology 없이 mapId 만이면 후보 둘=순서 불명=null(소유 아님 쪽)");
  // 사슬 모호(끊김) → null: 현재 topology 해시가 어떤 결정의 결과도 아니게 만들면(임의 복제 topology) 순서 판정 포기
  const fake = JSON.parse(JSON.stringify(tNow)); fake.nodes.push({ ...fake.nodes[0], id: U(777777), label: "ghost" });
  ok(MRot.orderByChain(ws, fake, [{ decisionId: dRot }, { decisionId: dOther }]).ok === false && MRot.demotionDecisionOf(ws, nC0, fake) === null, "사슬 끊김(현재 해시 미등록) → 순서 불명=null"); }
console.log("[16] 3차 — 꽉 찬 지도에서 내려간 파일이 다시 바뀌면: 되살리기=내보내기 동반 · 후보 없음/교체 꺼짐=미룸(기준점 전진) · 되살리기 실패=즉시 되돌림");
{ const { ws, names, ids } = fullRepo("revive");
  let jobState = { rotationPartial: null }; const updateJob = (mut) => { jobState = mut(jobState); return { ok: true }; };
  // (전제) 새 파일로 한 칸 교체 → 활성 60 + 내려간 칸 1
  fs.writeFileSync(path.join(ws, "src", "new6.js"), "// new6\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new6"]);
  const addP = { operation: "add_node", payload: { node: { id: U(9006), label: "new6", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new6.js" }] } } };
  const r0 = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null });
  ok(r0.rotated === true, "(전제) 방출 1");
  addFileNode(ws, "src/new6.js");
  const h1 = headOf(ws);
  ok(PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP && nodeOf(ws, r0.victimId).state.lifecycle === "deprecated", "(전제) 활성 60 · 내려간 칸 1");
  // 내려간 파일을 다시 바꿔 커밋 → 실행 시작 통과(기준점 h1) → 되살리기가 다른 칸 하나를 내보내고 들어온다 · ok(기준점 전진 가능)
  fs.appendFileSync(path.join(ws, r0.victimPath), "// touched again\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "touch"]);
  const h2 = headOf(ws);
  const logs = [];
  const fp = MRot.factPass(ws, ws, { job: null, baselineHead: h1, updateJob, log: (e) => logs.push(e) });
  const rv = fp.revived && fp.revived.applied.find((a) => a.id === r0.victimId);
  ok(fp.ok === true && rv && rv.evictedId && ids.includes(rv.evictedId) && rv.evictedId !== r0.victimId, "되살리기 적용 + 다른 칸 내보냄(evictedId) · factPass ok=true(기준점 전진)");
  ok(nodeOf(ws, r0.victimId).state.lifecycle === "active" && nodeOf(ws, rv.evictedId).state.lifecycle === "deprecated" && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP, "되살아난 칸 active · 내보낸 칸 deprecated · 활성 60 유지(61 없음)");
  ok(MRot.rotationOwns(MRot.harnessDeprecationOf(ws, nodeOf(ws, rv.evictedId), MR.readTopoExFor(ws).topo), h2) === true, "내보낸 칸의 강등 결정은 이 통과(head h2)의 회전 소유");
  ok(logs.some((e) => e.route === "rotation" && e.reason === "rotated-out" && /revive/.test(String(e.detail))) && logs.some((e) => e.route === "fact-transition" && e.reason === "revived"), "route 로그: rotation/rotated-out(revive) + fact-transition/revived");
  // 미룸 ①: 후보 없음(보호 기간을 크게) — 내보낸 칸(rotated-out)을 다시 바꿔도 되살리지 못하고 '미룸'·ok=true·활성 60·deprecated 유지
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on", mapRotation: { enabled: true, protectDays: 100000, hubMinDegree: 3 } }));
  fs.appendFileSync(path.join(ws, rv.evictedPath), "// touched\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "touch2"]);
  const logs2 = [];
  const fp2 = MRot.factPass(ws, ws, { job: null, baselineHead: h2, updateJob, log: (e) => logs2.push(e) });
  ok(fp2.ok === true && fp2.revived.deferred.length === 1 && fp2.revived.deferred[0].id === rv.evictedId && fp2.revived.deferred[0].reason === "no-candidate" && fp2.revived.failed.length === 0, "후보 없음 → deferred(no-candidate) · failed 0 · ok=true(기준점 정체 없음)");
  ok(nodeOf(ws, rv.evictedId).state.lifecycle === "deprecated" && PM.activeFileNodeCount(MR.readTopoExFor(ws).topo) === CAP && logs2.some((e) => e.reason === "revive-deferred"), "미룬 칸은 deprecated 유지 · 활성 60 · 로그 revive-deferred");
  // 미룸 ②: 교체 꺼짐
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on", mapRotation: { enabled: false } }));
  const h3 = headOf(ws);
  fs.appendFileSync(path.join(ws, rv.evictedPath), "// touched3\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "touch3"]);
  const fp3 = MRot.factPass(ws, ws, { job: null, baselineHead: h3, updateJob, log: null });
  ok(fp3.ok === true && fp3.revived.deferred.length === 1 && fp3.revived.deferred[0].reason === "disabled" && nodeOf(ws, rv.evictedId).state.lifecycle === "deprecated", "교체 꺼짐 → deferred(disabled) · 되살리지 않음 · ok=true");
  // 활성 59 면 내보내기 없이 그냥 되살아남(기존 경로 무회귀)
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  // 먼저 다른 결정으로 칸 하나를 내려 활성 59 를 만든 뒤, 내보낸 칸을 다시 바꾸면 내보내기 없이 되살아난다
  const tA = MR.readTopoExFor(ws).topo; const some = tA.nodes.find((x) => PM.isActiveFileNode(x) && x.id !== r0.victimId && ids.includes(x.id));
  const bD = MRot.buildHarnessPatch(ws, tA, { operation: "set_state", targetId: some.id, payload: { to: { lifecycle: "deprecated" }, expect: { lifecycle: "active" } }, rationale: "file-gone@" + headOf(ws).slice(0, 7), detectedBy: "git-name-status", evidence: [{ kind: "git", ref: headOf(ws) }] });
  ok(bD.ok && MRot.applyHarnessPatch(ws, bD.patch).ok, "(전제) 다른 결정으로 칸 하나 내려감");
  fs.unlinkSync(path.join(ws, some.anchors[0].path)); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "gone"]); // 실제로 지워 복귀(파일 실존) 대상이 되지 않게
  const before59 = PM.activeFileNodeCount(MR.readTopoExFor(ws).topo);
  const h4 = headOf(ws);
  fs.appendFileSync(path.join(ws, rv.evictedPath), "// touched4\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "touch4"]);
  const fp4 = MRot.factPass(ws, ws, { job: null, baselineHead: h4, updateJob, log: null });
  const rv4 = fp4.revived.applied.find((a) => a.id === rv.evictedId);
  ok(before59 < CAP && fp4.ok === true && rv4 && !rv4.evictedId && nodeOf(ws, rv.evictedId).state.lifecycle === "active", "자리가 있으면 내보내기 없이 되살아남(무회귀)"); }
console.log("[17] 3차 확인 — 내보낸 뒤 되살리기 실패 → 즉시 되돌림(피해 칸 복원·활성 60·failed 기록)");
{ const { ws, ids } = fullRepo("revfail");
  let jobState = { rotationPartial: null }; const updateJob = (mut) => { jobState = mut(jobState); return { ok: true }; };
  fs.writeFileSync(path.join(ws, "src", "new7.js"), "// new7\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "new7"]);
  const addP = { operation: "add_node", payload: { node: { id: U(9007), label: "new7", entityType: "file", roles: [], state: ST("active"), anchors: [{ kind: "code", path: "src/new7.js" }] } } };
  const r0 = MRot.rotateBeforeAdd(ws, ws, { patch: addP, topo: MR.readTopoExFor(ws).topo, head: headOf(ws), updateJob, log: null });
  ok(r0.rotated === true, "(전제) 방출 1");
  addFileNode(ws, "src/new7.js");
  fs.appendFileSync(path.join(ws, r0.victimPath), "// touched\n"); g(ws, ["add", "-A"]); g(ws, ["commit", "-q", "-m", "touch"]);
  const h = headOf(ws);
  const activeBefore = (MR.readTopoExFor(ws).topo.nodes || []).filter((x) => PM.isActiveFileNode(x)).map((x) => x.id).sort();
  const logs = [];
  const seen = [];
  const applyRevive = (repo, patch) => { seen.push(patch); return { ok: false, stage: "apply", error: "되살리기 적용 실패(재현)" }; };
  const rv = MRot.applyRevivals(ws, [r0.victimPath], h, (e) => logs.push(e), ws, { applyRevive });
  ok(seen.length === 1 && seen[0].operation === "set_state" && seen[0].targetId === r0.victimId, "(전제) 되살리기 patch 1건이 주입 적용기에서 실패");
  ok(rv.ok === true && rv.applied.length === 0 && rv.deferred.length === 0 && rv.failed.length === 1 && rv.failed[0].id === r0.victimId && rv.failed[0].stage === "apply", "failed 1(되살리기 apply) · applied 0 · deferred 0 → factPass 가 기준점을 잡아 둔다");
  const activeAfter = (MR.readTopoExFor(ws).topo.nodes || []).filter((x) => PM.isActiveFileNode(x)).map((x) => x.id).sort();
  ok(JSON.stringify(activeAfter) === JSON.stringify(activeBefore) && activeAfter.length === CAP, "내보냈던 칸이 되돌아와 활성 집합이 되살리기 전과 동일(활성 60 · 빈자리 없음)");
  ok(nodeOf(ws, r0.victimId).state.lifecycle === "deprecated", "되살리기 대상은 여전히 deprecated(다음 실행이 다시 시도)");
  const evLog = logs.find((e) => e.route === "rotation" && e.reason === "rotated-out");
  const rvLog = logs.find((e) => e.route === "rotation" && e.reason === "reverted");
  ok(!!evLog && !!rvLog, "route 로그: rotated-out(revive) 뒤 reverted");
  const t = MR.readTopoExFor(ws).topo; const evictedPath = evLog ? String(evLog.detail).split(" -> ")[0] : "";
  const evictedNode = t.nodes.find((x) => x.anchors && x.anchors[0] && x.anchors[0].path === evictedPath);
  ok(!!evictedNode && PM.isActiveFileNode(evictedNode) && ids.includes(evictedNode.id), "내보냈던 칸(" + evictedPath + ")이 active 로 되돌아옴");
  ok(fs.readdirSync(path.join(ws, "project-map", "decisions")).filter((f) => f.endsWith(".json")).length >= 2, "결정 기록은 지워지지 않고 남는다"); }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
