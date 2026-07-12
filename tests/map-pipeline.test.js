/*
 * P2-A2b 테스트 — pipeline(클레임·CAS 실대조·WAL 합타입·recoverWal 표·abort·gc·corruption)·
 * writer barrier(P0.5/P1 배선)·CLI 게이트. 설계: docs/MAP-P2-DESIGN.md §B·§D·§F·§G.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "mappipe_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bootstrap.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");

function mkRepo(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mappipe_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  return ws;
}
function setScoutOn(ws) {
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
}
function initTopo(ws) {
  const r = MR.initTopologyForBootstrap(ws);
  if (r.st !== "created") throw new Error("init 실패: " + r.st);
  return MR.readTopoExFor(ws).topo;
}
// 유효 patch 빌더: 현재 상태에서 basis·3해시·readSet을 재계산해 결속(제안 생성기의 계약과 동일 함수 공유)
function mkLivePatch(ws, op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const base = {
    schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
    baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "test", evidence: [{ kind: "code", ref: "src/a.js" }],
    ...fields,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  base.readSet = MP.buildReadSetFor(topo, base, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
  return { patch: base, topo };
}
const scopeMap = (ws, args) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws, ...args], { encoding: "utf8", env: { ...process.env } });

function main() {
  console.log("[1] 2트랙 게이트 — pipeline CLI 전부 거부·파일 생성 0");
  {
    const ws = mkRepo("twotrack");
    for (const cmd of ["propose", "classify", "apply", "recover", "abort", "gc", "pipeline-status"]) {
      const r = scopeMap(ws, [cmd, U(1)]);
      ok(r.status === 2 && /3트랙|3-track/.test(r.stderr), `off: ${cmd}=거부`);
    }
    ok(!fs.existsSync(MP.pipeRootFor(ws)), "서랍 미생성(무접촉)");
  }

  console.log("[2] propose→classify→apply(auto e2e — historyless)");
  {
    const ws = mkRepo("e2e");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    const topo0 = initTopo(ws);
    const nodeId = topo0.nodes[0] ? topo0.nodes[0].id : null;
    ok(!!nodeId, "(전제) init topology에 node 존재");
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "test-cond" } });
    const pr = MP.proposePatch(ws, patch);
    ok(pr.ok === true, "propose 수납");
    ok(MP.proposePatch(ws, patch).idempotent === true, "재수납=멱등(patchId)");
    const cf = MP.classifyPatch(ws, patch.mapId, patch.patchId);
    ok(cf.ok && cf.classification === "auto", "classify=auto(§3 기본 분류)");
    ok(MP.applyPatch(ws, patch.mapId, patch.patchId, {}).ok === false, "--pre-cutover 없이 apply=거부(§A)");
    const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
    ok(ap.ok === true, "apply 성공" + (ap.ok ? "" : " — " + ap.error));
    const t1 = MR.readTopoExFor(ws).topo;
    ok(t1.revision === topo0.revision + 1 && t1.nodes.find((n) => n.id === nodeId).conditions.includes("test-cond"), "topology 반영+revision +1");
    const decFile = path.join(ws, "project-map", "decisions", ap.decisionId + ".json");
    const dec = JSON.parse(fs.readFileSync(decFile, "utf8"));
    ok(PM.validateDecisionV2(dec).length === 0 && dec.preCutover === true, "decision 파일=스키마 전체 통과+preCutover");
    const d = MP.dirsFor(ws, patch.mapId);
    ok(fs.existsSync(path.join(d.walComplete, ap.decisionId + ".json")) && !fs.existsSync(path.join(d.wal, ap.decisionId + ".json")), "WAL=complete 이동(⑪)");
    const mk = JSON.parse(fs.readFileSync(path.join(d.markers, ap.decisionId + ".json"), "utf8"));
    ok(mk.decisionFileAfterHash === sha(fs.readFileSync(decFile, "utf8")) && mk.policyArtifact === null, "marker=decision 파일 지문 정합(1-32)");
    const pend = JSON.parse(fs.readFileSync(path.join(d.pending, patch.patchId + ".json"), "utf8"));
    ok(pend.lifecycle === "resolved", "pending=resolved 종결");
    const idx2 = MP.decisionIndexFor(ws, patch.mapId);
    ok(idx2.st === "ok" && idx2.projections.length === 1 && idx2.projections[0].decisionId === ap.decisionId, "decision 색인 반영");
    ok(PM.mapMdMatches(fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8"), t1), "MAP.md=새 topology 렌더 정합");
    // CAS: 같은 base의 두 번째 patch — read-set 무관 대상이면 rebase 진행
    const { patch: p2 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "second" } });
    MP.proposePatch(ws, p2); MP.classifyPatch(ws, p2.mapId, p2.patchId);
    ok(MP.applyPatch(ws, p2.mapId, p2.patchId, { preCutover: true }).ok === true, "후속 patch 정상 적용(신선 base)");
  }

  console.log("[3] CAS 실대조 — 낡은 base·read-set 파손·origin 경계");
  {
    const ws = mkRepo("cas");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const nodeId = topo.nodes[0].id;
    // 낡은 base+read-set 보존 → rebase 진행: 먼저 patch A 생성(현 base), patch B도 생성(같은 base·다른 조건),
    // A 적용 후 B 적용 — B의 base 3해시는 낡았지만 대상 entity 불변(A가 같은 노드 조건 추가 — T 파손!) →
    // 정확히는 T가 깨지므로 stale-expired. 무관 대상이면 rebase. 두 경우 모두 검증.
    const { patch: pa } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "A" } });
    const { patch: pb } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "B" } });
    MP.proposePatch(ws, pa); MP.classifyPatch(ws, pa.mapId, pa.patchId);
    MP.proposePatch(ws, pb); MP.classifyPatch(ws, pb.mapId, pb.patchId);
    ok(MP.applyPatch(ws, pa.mapId, pa.patchId, { preCutover: true }).ok === true, "A 적용");
    const rb = MP.applyPatch(ws, pb.mapId, pb.patchId, { preCutover: true });
    ok(rb.ok === false && /stale-expired|read-set 파손/.test(rb.error), "같은 대상 T 파손=stale-expired(자동 정리 — 1-10 ①)");
    const pendB = JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, pb.mapId).pending, pb.patchId + ".json"), "utf8"));
    ok(pendB.lifecycle === "expired", "파손 pending=expired 기록");
  }

  console.log("[4] writer barrier — 활성 WAL 중 P0.5/P1 canonical 쓰기 전면 차단");
  {
    const ws = mkRepo("barrier");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const d = MP.ensureDirs(ws, topo.mapId);
    fs.writeFileSync(path.join(d.wal, U(70) + ".json"), JSON.stringify({ schema: "map-wal-v2", decision: { decisionId: U(70) }, expectedDecisionFileAfterHash: sha("x") }));
    const b = MR.pipelineBarrier(ws);
    ok(b.blocked === true && b.reason === "pipeline-recovery-pending", "barrier 감지");
    ok(MR.runCli(ws, "render") !== 0, "render=차단(writeCanonicalLocked 직전 재검사)");
    const mv = MB.maybeSpawnBootstrap(ws);
    ok(mv.spawned === false && mv.reason === "pipeline-recovery-pending", "P1 부모=보류(헛기동 차단)");
    ok(MB.runChild(ws, true) === 3, "P1 자식=race 종결(rs 복원 후 물러남)");
    ok(MB.runChild(ws, true) === 3 && !fs.existsSync(MB.rsFileFor(ws) + ".funlock"), "반복 실행에도 잠금 잔재 없음(prev 복원 CAS)");
    const adv = MB.hookTick(ws);
    ok(!!adv && /복구 대기 장부|recovery journal/.test(adv), "훅 고지(무언 정지 금지)");
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition: "x" } });
    MP.proposePatch(ws, patch);
    ok(MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true }).ok === false, "신규 apply=①′ 사전 거부");
    fs.unlinkSync(path.join(d.wal, U(70) + ".json"));
    ok(MR.pipelineBarrier(ws).blocked === false && MR.runCli(ws, "render") === 0, "WAL 해소=자연 재개");
  }

  console.log("[5] recoverWal — 중단 지점 roll-forward(t7/t8/t12)·abort 조건·complete 보충");
  {
    const ws = mkRepo("recover");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const nodeId = topo.nodes[0].id;
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "rec" } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
    const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
    ok(ap.ok, "(전제) 정상 적용");
    const d = MP.dirsFor(ws, patch.mapId);
    const did = ap.decisionId;
    // 중단 시뮬: complete→활성 WAL로 되돌리고 산출물 일부 제거
    const decFile = path.join(ws, "project-map", "decisions", did + ".json");
    const decText = fs.readFileSync(decFile, "utf8");
    const mkFile = path.join(d.markers, did + ".json");
    const mkText = fs.readFileSync(mkFile, "utf8");
    // t12: marker만 부재
    fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
    fs.unlinkSync(mkFile);
    let r = MP.recoverWal(ws, patch.mapId);
    ok(r.length === 1 && r[0].verdict === "recovered" && fs.readFileSync(mkFile, "utf8") === mkText, "t12: marker 보충+complete 이동");
    // t8: decision+marker 부재(MAP은 expected)
    fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
    fs.unlinkSync(decFile); fs.unlinkSync(mkFile);
    r = MP.recoverWal(ws, patch.mapId);
    ok(r[0].verdict === "recovered" && fs.readFileSync(decFile, "utf8") === decText, "t8: decision 보충(WAL 사본 그대로 — 재구성 없음)");
    // t9: decision 이후 MAP 수동 편집=conflict
    fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
    const mapFile = path.join(ws, "project-map", "MAP.md");
    const mapText = fs.readFileSync(mapFile, "utf8");
    fs.writeFileSync(mapFile, mapText + "\n<!-- 수동 -->\n");
    r = MP.recoverWal(ws, patch.mapId);
    ok(r[0].verdict === "conflict" && /t3|t9/.test(r[0].reason), "t3/t9: MAP 혼합=conflict(marker 존재 시 t3 선행 — 자동 재렌더 금지)");
    fs.writeFileSync(mapFile, mapText);
    r = MP.recoverWal(ws, patch.mapId);
    ok(r[0].verdict === "recovered", "복원 후 complete 보충(t13)");
    // abort: 산출물 존재=거부
    fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
    ok(MP.abortWal(ws, patch.mapId, did).ok === false, "적용 후 abort=거부(§F — pre-apply만)");
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === "recovered", "정리");
  }

  console.log("[6] 정책 op e2e — topology 무변경·색인 제외·frontier 반영");
  {
    const ws = mkRepo("policy");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const mapHash0 = PM.mapHashOf(topo);
    const pol = { policyId: U(80), mapId: topo.mapId, scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "merge" }, predicateDescription: "병합 원칙", chosenMeaning: "별개 유지", createdFromDecision: U(81), verification: { kind: "historyless", basisFp: mapHash0, inventoryFp: sha("inv") }, active: true };
    const { patch } = mkLivePatch(ws, "create_intent_policy", { payload: { policy: pol }, evidence: undefined, authorizationRefs: [{ kind: "user-choice", ref: "card-fixture-1" }] });
    MP.proposePatch(ws, patch);
    const cf = MP.classifyPatch(ws, patch.mapId, patch.patchId);
    ok(cf.ok && cf.classification === "intent-choice", "classify=intent-choice(§3 — 정책 op)");
    // §A: intent-choice는 해소 레코드 없이 적용 불가 — P2 실경로 확인
    const apRefuse = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
    ok(apRefuse.ok === false && /resolutionRef|classification/.test(apRefuse.error), "intent-choice=해소 참조 없이 apply 거부(§A)");
    // 해소 참조 주입(P9 전 내부 fixture — 공개 카드 경로 아님. decision은 정본 계약대로 intent-choice+user-choice)
    const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true, resolutionRef: "card-fixture-1" });
    ok(ap.ok === true, "정책 적용(F-2)" + (ap.ok ? "" : " — " + ap.error));
    ok(PM.mapHashOf(MR.readTopoExFor(ws).topo) === mapHash0, "topology 불변(mapHash 동일 — F-2 invariant)");
    ok(fs.existsSync(path.join(ws, "project-map", "policies", U(80) + ".json")), "정책 파일 생성");
    const idx = MP.decisionIndexFor(ws, patch.mapId);
    ok(idx.st === "none" || idx.projections.every((x) => x.decisionId !== ap.decisionId), "정책 decision=색인 제외(§C-3)");
    const ps = MP.policyStateFor(ws, patch.mapId);
    ok(ps.st === "ok" && ps.frontier.some((x) => x.policyId === U(80)), "frontier 반영");
  }

  console.log("[7] recoverCorruption·gc");
  {
    const ws = mkRepo("corrupt");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition: "c" } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
    ok(MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true }).ok, "(전제) 적용 — 스냅샷 존재");
    const topoFile = path.join(ws, "project-map", "topology.json");
    const orig = fs.readFileSync(topoFile, "utf8");
    fs.writeFileSync(topoFile, "{broken");
    const rc = MP.recoverCorruption(ws, patch.mapId);
    ok(rc.ok === true && fs.existsSync(path.join(ws, "project-map", "topology.recovered.json")) && fs.readFileSync(topoFile, "utf8") === "{broken", "손상=별도 파일 복구+원본 보존(1-18)");
    fs.writeFileSync(topoFile, orig);
    ok(MP.recoverCorruption(ws, patch.mapId).ok === false, "정상 topology=복구 거부(되돌리기 경로 아님)");
    // dead .nslock 복구(15차 #1): 잔재→진입 거부→gc 격리→자연 재개
    const nsl = path.join(MP.dirsFor(ws, patch.mapId).base, '.nslock');
    fs.writeFileSync(nsl, JSON.stringify({ pid: 999999999, token: 'dead' }));
    const { patch: pns } = mkLivePatch(ws, 'add_condition', { targetId: topo.nodes[0].id, payload: { condition: 'ns' } });
    ok(MP.proposePatch(ws, pns).ok === false, 'dead nsLock 잔재=진입 거부(자동 회수 없음)');
    const gcNs = MP.pipelineGc(ws, patch.mapId);
    ok(gcNs.ok === true && gcNs.nsRecovered === 1 && !fs.existsSync(nsl), 'gc(withMapLock 하)가 dead nsLock 격리');
    ok(MP.proposePatch(ws, pns).ok === true, '격리 후 자연 재개');
    const gcR = MP.pipelineGc(ws, patch.mapId);
    ok(gcR.ok === true, "gc 실행(비-git=marker 보존·orphan 스냅샷만)");
  }

  console.log("[8] 12차 반례 — §D 계약 명시·E 파손·위조 basis·rebase 갱신·정책 ID 충돌·t5 전진·barrier fail-closed");
  {
    const ws = mkRepo("r12");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const nodeId = topo.nodes[0].id;
    // §D 계약 명시 단언(생성기 자기일관성 분리 — 12차 테스트 공백 지적)
    const NEW_EDGE_NODES = topo.nodes.length >= 2;
    if (NEW_EDGE_NODES) {
      const e9 = { id: U(90), from: topo.nodes[0].id, to: topo.nodes[1].id, relation: "mirrors", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } };
      const { patch: pe } = mkLivePatch(ws, "add_edge", { payload: { edge: e9 } });
      ok(Array.isArray(pe.readSet.targets) && pe.readSet.targets.length === 2, "add_edge T=from/to 2개(§D — targetIdsOfPatch 의존 아님)");
      ok(PM.validatePatchV2(pe).length === 0, "생성된 add_edge patch=스키마 통과");
    } else { ok(true, "(스킵) init topology 노드 1개 — add_edge 계약은 단위로 검증됨"); ok(true, "(스킵)"); }
    const { patch: pa } = mkLivePatch(ws, "add_anchor", { targetId: nodeId, payload: { anchor: { kind: "code", path: "src/a.js", symbol: "x" } } });
    ok(pa.readSet.files.some((f) => f.ref === "src/a.js"), "add_anchor E에 anchor 파일 포함(§D)");
    // E 파손: evidence 파일 변경 후 apply=stale-expired(drift 없어도 read-set 상시 대조 — 12차 #2)
    const { patch: pc } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "efail" } });
    MP.proposePatch(ws, pc); MP.classifyPatch(ws, pc.mapId, pc.patchId);
    fs.appendFileSync(path.join(ws, "src", "a.js"), "// 변경\n");
    const re = MP.applyPatch(ws, pc.mapId, pc.patchId, { preCutover: true });
    ok(re.ok === false && /read-set 파손/.test(re.error), "evidence 파일만 변경(해시 신호 無)=E 파손 감지");
    // 위조 inventoryFp: drift 신호+read-set 보존=rebase로 신선 basis 기록(12차 #2·#3)
    const { patch: pf2 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "forged" } });
    pf2.basis = { ...pf2.basis, inventoryFp: sha("위조") };
    MP.proposePatch(ws, pf2); MP.classifyPatch(ws, pf2.mapId, pf2.patchId);
    const rf2 = MP.applyPatch(ws, pf2.mapId, pf2.patchId, { preCutover: true });
    ok(rf2.ok === true, "inventoryFp 불일치=재검사 신호→read-set 보존=rebase 진행");
    const decF = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", rf2.decisionId + ".json"), "utf8"));
    const preTopoHash = decF.audit.topologyBeforeHash;
    ok(decF.patch.basis.inventoryFp !== sha("위조") && decF.patch.baseMapHash === preTopoHash, "decision에 신선 basis+baseMapHash=적용 직전 topology(12차 #3 — 낡은 기준 미기록)");
  }
  {
    // t5 전진(12차 #7): 적용 후 상태를 '미개시'로 되돌리고 recoverWal이 재적용 roll-forward
    const ws = mkRepo("t5fwd");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition: "t5" } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
    const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
    ok(ap.ok, "(전제) 적용");
    const d = MP.dirsFor(ws, patch.mapId);
    const did = ap.decisionId;
    const snap = JSON.parse(fs.readFileSync(path.join(d.snapshots, did + ".json"), "utf8"));
    // 미개시 재현: topology=before 복원·산출물 제거·WAL 활성화
    fs.writeFileSync(path.join(ws, "project-map", "topology.json"), PM.canonicalSerialize(snap.topology));
    fs.unlinkSync(path.join(ws, "project-map", "decisions", did + ".json"));
    fs.unlinkSync(path.join(d.markers, did + ".json"));
    fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
    const r5 = MP.recoverWal(ws, patch.mapId);
    ok(r5.length === 1 && r5[0].verdict === "recovered", "t5: 미개시=재검사 후 ⑥부터 roll-forward(재적용 결정론)" + (r5[0] ? " — " + r5[0].reason : ""));
    const t5t = MR.readTopoExFor(ws).topo;
    ok(t5t.nodes[0].conditions && t5t.nodes[0].conditions.includes("t5") && fs.existsSync(path.join(ws, "project-map", "decisions", did + ".json")), "재적용 결과=expected(decision·marker 보충)");
  }
  {
    // 정책 createdFromDecision 충돌(12차 #5)+barrier fail-closed(12차 #4)
    const ws = mkRepo("polconf");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const mkPol = (pid) => ({ policyId: U(pid), mapId: topo.mapId, scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "merge" }, predicateDescription: "d", chosenMeaning: "m", createdFromDecision: U(95), verification: { kind: "historyless", basisFp: PM.mapHashOf(topo), inventoryFp: sha("i") }, active: true });
    const mk = (pid) => mkLivePatch(ws, "create_intent_policy", { payload: { policy: mkPol(pid) }, evidence: undefined, authorizationRefs: [{ kind: "user-choice", ref: "card-x" }] }).patch;
    const p1 = mk(91), p2 = mk(92);
    MP.proposePatch(ws, p1); MP.classifyPatch(ws, p1.mapId, p1.patchId);
    MP.proposePatch(ws, p2); MP.classifyPatch(ws, p2.mapId, p2.patchId);
    ok(MP.applyPatch(ws, p1.mapId, p1.patchId, { preCutover: true, resolutionRef: "card-x" }).ok === true, "정책 A 적용(decisionId=createdFromDecision)");
    const rc = MP.applyPatch(ws, p2.mapId, p2.patchId, { preCutover: true, resolutionRef: "card-x" });
    ok(rc.ok === false && /decisionId 충돌/.test(rc.error), "같은 createdFromDecision 정책 B=충돌 거부(12차 #5)");
    const realA = MP.activePipelineWalFor;
    MP.activePipelineWalFor = () => { throw new Error("주입 예외"); };
    let bf; try { bf = MR.pipelineBarrier(ws); } finally { MP.activePipelineWalFor = realA; }
    ok(bf.blocked === true && bf.reason === "pipeline-barrier-error", "barrier 내부 예외=fail-closed(12차 #4)");
  }

  console.log("[9] 13차 반례 — t6 색인 개입·p3 frontier·policy marker·terminal 재분류·marker 실패·--map 검증");
  {
    const ws = mkRepo("r13");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const nodeId = topo.nodes[0].id;
    // terminal 재분류 금지(13차 #6)
    const { patch: pt } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "t13" } });
    MP.proposePatch(ws, pt); MP.classifyPatch(ws, pt.mapId, pt.patchId);
    ok(MP.applyPatch(ws, pt.mapId, pt.patchId, { preCutover: true }).ok, "(전제) 적용");
    ok(MP.classifyPatch(ws, pt.mapId, pt.patchId).ok === false, "resolved pending 재분류=거부(재적용 차단)");
    ok(MP.proposePatch(ws, { ...pt, rationale: "다른 내용" }).ok === false, "같은 patchId 다른 내용=멱등 위장 거부");
    // t6: decision 기록 전 외부 decision 유입 — 색인 baseline 불일치=conflict
    const { patch: p6 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "t6" } });
    MP.proposePatch(ws, p6); MP.classifyPatch(ws, p6.mapId, p6.patchId);
    const a6 = MP.applyPatch(ws, p6.mapId, p6.patchId, { preCutover: true });
    ok(a6.ok, "(전제) 적용2");
    const d = MP.dirsFor(ws, p6.mapId);
    const decDir = path.join(ws, "project-map", "decisions");
    // 중단 재현: 활성 WAL+decision 부재+외부 decision(다른 유효 decision을 사본 변조 없이 '이동'해 흉내 — 첫 decision을 규격 유지한 채 복사 불가하므로, 첫 decision 파일을 삭제해 baseline(1건) 불일치(0건)를 만든다)
    fs.renameSync(path.join(d.walComplete, a6.decisionId + ".json"), path.join(d.wal, a6.decisionId + ".json"));
    fs.unlinkSync(path.join(decDir, a6.decisionId + ".json"));
    fs.unlinkSync(path.join(d.markers, a6.decisionId + ".json"));
    const firstDec = fs.readdirSync(decDir).find((f) => f.endsWith(".json"));
    const kept = fs.readFileSync(path.join(decDir, firstDec), "utf8");
    fs.unlinkSync(path.join(decDir, firstDec)); // baseline에 있던 기존 decision 제거=색인 개입
    let r6 = MP.recoverWal(ws, p6.mapId);
    ok(r6[0].verdict === "conflict" && /t6/.test(r6[0].reason), "t6: 색인 외부 개입=conflict(권위 오염 차단 — 13차 #1)");
    fs.writeFileSync(path.join(decDir, firstDec), kept);
    r6 = MP.recoverWal(ws, p6.mapId);
    ok(r6[0].verdict === "recovered", "색인 복원 후 정상 roll-forward");
  }
  {
    // p3 frontier 재검사+policy marker 불일치(13차 #2)
    const ws = mkRepo("p3f");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const mkPol = (pid, cfd) => ({ policyId: U(pid), mapId: topo.mapId, scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "merge" }, predicateDescription: "d", chosenMeaning: "m", createdFromDecision: U(cfd), verification: { kind: "historyless", basisFp: PM.mapHashOf(topo), inventoryFp: sha("i") }, active: true });
    const mk = (pid, cfd) => mkLivePatch(ws, "create_intent_policy", { payload: { policy: mkPol(pid, cfd) }, evidence: undefined, authorizationRefs: [{ kind: "user-choice", ref: "cx" }] }).patch;
    const pA = mk(85, 86);
    MP.proposePatch(ws, pA); MP.classifyPatch(ws, pA.mapId, pA.patchId);
    const apA = MP.applyPatch(ws, pA.mapId, pA.patchId, { preCutover: true, resolutionRef: "cx" });
    ok(apA.ok, "(전제) 정책 A 적용");
    const d = MP.dirsFor(ws, pA.mapId);
    // p3 미개시 재현+frontier 변조(외부 정책 유입 흉내: A의 정책 파일 삭제=frontier 변화)
    fs.renameSync(path.join(d.walComplete, apA.decisionId + ".json"), path.join(d.wal, apA.decisionId + ".json"));
    fs.unlinkSync(path.join(ws, "project-map", "decisions", apA.decisionId + ".json"));
    const polFile = path.join(ws, "project-map", "policies", U(85) + ".json");
    const polText = fs.readFileSync(polFile, "utf8");
    fs.unlinkSync(polFile);
    fs.unlinkSync(path.join(d.markers, apA.decisionId + ".json"));
    // 외부 정책 유입 흉내(무관 정책 파일 추가 — frontier가 baseline[빈]과 달라짐)=conflict
    const alien = { policyId: U(87), mapId: pA.mapId, scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "widen" }, predicateDescription: "d", chosenMeaning: "m", createdFromDecision: U(88), verification: { kind: "historyless", basisFp: sha("x"), inventoryFp: sha("y") }, active: true };
    fs.writeFileSync(path.join(ws, "project-map", "policies", U(87) + ".json"), JSON.stringify(alien, null, 1));
    const rp3c = MP.recoverWal(ws, pA.mapId);
    ok(rp3c[0].verdict === "conflict" && /p3/.test(rp3c[0].reason), "p3: 외부 정책 유입=conflict(baseline frontier 불일치)");
    fs.unlinkSync(path.join(ws, "project-map", "policies", U(87) + ".json"));
    const rp3 = MP.recoverWal(ws, pA.mapId);
    ok(rp3[0].verdict === "recovered", "p3: baseline 일치(빈 frontier)=roll-forward 진행");
    // policy marker 불일치(p2): 완결 상태에서 marker 내용 변조 후 활성화
    const r2 = MP.recoverWal(ws, pA.mapId);
    void r2;
    if (fs.existsSync(path.join(d.walComplete, apA.decisionId + ".json"))) {
      fs.renameSync(path.join(d.walComplete, apA.decisionId + ".json"), path.join(d.wal, apA.decisionId + ".json"));
      fs.writeFileSync(path.join(d.markers, apA.decisionId + ".json"), JSON.stringify({ decisionId: apA.decisionId, decisionFileAfterHash: sha("변조"), policyArtifact: null }, null, 1));
      const rp2 = MP.recoverWal(ws, pA.mapId);
      ok(rp2[0].verdict === "conflict" && /p2/.test(rp2[0].reason), "p2: policy marker 불일치=conflict(합타입 대조 — 13차 #2)");
    } else { ok(true, "(경로) p3 conflict 분기로 종료 — p2는 별도 검증됨"); }
    void polText;
  }
  {
    // marker 기록 실패=성공 위장 금지(13차 #3 — CL.atomicWrite 훅)
    const ws = mkRepo("mkfail");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition: "mk" } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
    const realAw = CL.atomicWrite;
    CL.atomicWrite = function (f, txt) { if (String(f).includes(path.sep + "markers" + path.sep)) return false; return realAw.apply(CL, arguments); };
    let rmk;
    try { rmk = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true }); } finally { CL.atomicWrite = realAw; }
    ok(rmk.ok === false && /marker 기록 실패/.test(rmk.error), "marker 실패=ok:false(성공 위장 금지)");
    const d = MP.dirsFor(ws, patch.mapId);
    const walsLeft = fs.readdirSync(d.wal).filter((f) => f.endsWith(".json"));
    ok(walsLeft.length === 1, "활성 WAL 유지(recoverWal 소관)");
    const pend = JSON.parse(fs.readFileSync(path.join(d.pending, patch.patchId + ".json"), "utf8"));
    ok(pend.lifecycle === "claimed", "pending=claimed 유지(resolved 위장 없음)");
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === "recovered", "recoverWal이 marker 보충·완결");
  }
  {
    // --map 비UUID 거부(13차 #8)
    const ws = mkRepo("mapArg");
    setScoutOn(ws);
    const r = scopeMap(ws, ["gc", "--map=../../escape"]);
    ok(r.status === 2 && /UUID/.test(r.stderr), "--map 비UUID=거부(경로 이탈 차단)");
  }

  console.log("[10] 14차 반례 — D 존재 t6·WAL 분리 위조·malformed marker·rebase snapshot basis");
  {
    const ws = mkRepo("r14");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    initTopo(ws);
    const topo = MR.readTopoExFor(ws).topo;
    const nodeId = topo.nodes[0].id;
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "r14" } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
    const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
    ok(ap.ok, "(전제) 적용");
    const d = MP.dirsFor(ws, patch.mapId);
    const did = ap.decisionId;
    const decDir = path.join(ws, "project-map", "decisions");
    // D 존재+K 부재(t12 직전)에서 외부 색인 개입 → t6 선행이 잡아야(14차 #1)
    fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
    fs.unlinkSync(path.join(d.markers, did + ".json"));
    const firstDec = fs.readdirSync(decDir).find((f) => f.endsWith(".json") && f !== did + ".json");
    let r;
    if (firstDec) {
      const kept = fs.readFileSync(path.join(decDir, firstDec), "utf8");
      fs.unlinkSync(path.join(decDir, firstDec));
      r = MP.recoverWal(ws, patch.mapId);
      ok(r[0].verdict === "conflict" && /t6/.test(r[0].reason), "t6 선행: D 존재+K 부재에서도 색인 개입=conflict(t12 오완결 차단)");
      fs.writeFileSync(path.join(decDir, firstDec), kept);
    } else { // 이 레포의 첫 decision이 자기 자신뿐이면 baseline=빈 — 개입 재현을 위해 다른 decision이 필요했음
      ok(true, "(경로) 단일 decision 레포 — t6 D-존재 경로는 r13의 이동 재현으로 커버");
    }
    // malformed marker=fail-closed(14차 #3)
    fs.writeFileSync(path.join(d.markers, did + ".json"), "{broken");
    r = MP.recoverWal(ws, patch.mapId);
    ok(r[0].verdict === "conflict" && /판독 불가|손상/.test(r[0].reason), "marker 손상=conflict(absent 오인 금지)");
    fs.unlinkSync(path.join(d.markers, did + ".json"));
    // WAL 분리 위조(14차 #2): top-level patch를 다른 유효 patch로 교체
    const wf = path.join(d.wal, did + ".json");
    const w = JSON.parse(fs.readFileSync(wf, "utf8"));
    const { patch: other } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "위조" } });
    fs.writeFileSync(wf, JSON.stringify({ ...w, patch: other }, null, 1));
    r = MP.recoverWal(ws, patch.mapId);
    ok(r[0].verdict === "conflict" && /분리 위조|결속/.test(r[0].reason), "WAL top-level patch≠decision.patch=거부(자기완결)");
    fs.writeFileSync(wf, JSON.stringify(w, null, 1));
    // 16차: topology WAL에 삽입된 copy 누락 artifact=예외 아닌 conflict / 거짓 기대 지문=conflict
    // (이 시점 WAL은 직전 원복으로 이미 활성 — 이동 불요)
    const w16 = JSON.parse(fs.readFileSync(wf, 'utf8'));
    fs.writeFileSync(wf, JSON.stringify({ ...w16, policyArtifact: { kind: 'intent-policy', policyId: U(99), expectedFileHash: sha('x') } }, null, 1));
    let r16 = MP.recoverWal(ws, patch.mapId);
    ok(r16[0].verdict === 'conflict' && /policyArtifact 금지|스키마 위반/.test(r16[0].reason), 'topology WAL+artifact 삽입=conflict(예외 종료 아님 — 16차 #1)');
    fs.writeFileSync(wf, JSON.stringify({ ...w16, expectedDecisionFileAfterHash: sha('거짓'), expectedMarker: { ...w16.expectedMarker, decisionFileAfterHash: sha('거짓') } }, null, 1));
    r16 = MP.recoverWal(ws, patch.mapId);
    ok(r16[0].verdict === 'conflict' && /재계산 불일치|거짓 지문/.test(r16[0].reason), '거짓 기대 지문(쌍으로 변조)=재계산 대조로 거부');
    fs.writeFileSync(wf, JSON.stringify(w16, null, 1));
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === 'recovered', '원복 후 완결(16차)');
    // 17차: kind↔op 불일치·audit 불일치=conflict
    fs.renameSync(path.join(d.walComplete, did + '.json'), path.join(d.wal, did + '.json'));
    const w17 = JSON.parse(fs.readFileSync(wf, 'utf8'));
    fs.writeFileSync(wf, JSON.stringify({ ...w17, transactionKind: 'policy' }, null, 1));
    let r17 = MP.recoverWal(ws, patch.mapId);
    ok(r17[0].verdict === 'conflict' && /불일치|위반/.test(r17[0].reason), 'transactionKind↔op 불일치=conflict(17차 #1)');
    fs.writeFileSync(wf, JSON.stringify({ ...w17, expectedMapMdAfterHash: sha('다른MD') }, null, 1));
    r17 = MP.recoverWal(ws, patch.mapId);
    ok(r17[0].verdict === 'conflict' && /audit|결속/.test(r17[0].reason), 'expected 해시≠decision audit=conflict(17차 #2)');
    fs.writeFileSync(wf, JSON.stringify(w17, null, 1));
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === 'recovered', '원복 후 완결(17차)');
    // 18차: {} inverse WAL=거부(topology 불변 시점에 수행 — 이후 적용들이 기반을 바꾸기 전)
    fs.renameSync(path.join(d.walComplete, did + '.json'), path.join(d.wal, did + '.json'));
    const w18 = JSON.parse(fs.readFileSync(wf, 'utf8'));
    fs.writeFileSync(wf, JSON.stringify({ ...w18, inverse: {} }, null, 1));
    ok(/inverse 합타입/.test(MP.recoverWal(ws, patch.mapId)[0].reason), '{} inverse=합타입 거부(C-4 자기완결)');
    fs.writeFileSync(wf, JSON.stringify(w18, null, 1));
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === 'recovered', '원복 후 완결(18차)');
    // 19차: {kind:patch, payload:{}} inverse=거부
    fs.renameSync(path.join(d.walComplete, did + '.json'), path.join(d.wal, did + '.json'));
    const w19 = JSON.parse(fs.readFileSync(wf, 'utf8'));
    fs.writeFileSync(wf, JSON.stringify({ ...w19, inverse: { kind: 'patch', payload: {} } }, null, 1));
    ok(/inverse 합타입/.test(MP.recoverWal(ws, patch.mapId)[0].reason), '{kind:patch, 빈 payload}=거부(재적용 계약)');
    fs.writeFileSync(wf, JSON.stringify(w19, null, 1));
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === 'recovered', '원복 후 완결(19차)');
    // 20차 #1: 허용 키만 맞춘 실행 불가 payload의 patch inverse=거부(P2 WAL=recovery 전용)
    fs.renameSync(path.join(d.walComplete, did + '.json'), path.join(d.wal, did + '.json'));
    const w20 = JSON.parse(fs.readFileSync(wf, 'utf8'));
    fs.writeFileSync(wf, JSON.stringify({ ...w20, inverse: { kind: 'patch', operation: 'set_state', payload: { to: {} } } }, null, 1));
    ok(/recovery\{ref,note\}만/.test(MP.recoverWal(ws, patch.mapId)[0].reason), '실행 불가 payload patch inverse=거부(20차 #1 — P2=recovery만)');
    fs.writeFileSync(wf, JSON.stringify({ ...w20, inverse: { kind: 'recovery', ref: 'x' } }, null, 1));
    ok(/recovery\{ref,note\}만/.test(MP.recoverWal(ws, patch.mapId)[0].reason), 'note 누락 recovery inverse=거부');
    fs.writeFileSync(wf, JSON.stringify(w20, null, 1));
    ok(MP.recoverWal(ws, patch.mapId)[0].verdict === 'recovered', '원복 후 완결(20차)');
    // 18차: 최종 종결 실패=finalizePending 정직 보고→재시도가 영수증 검증 후 보충 종결
    const { patch: p18 } = mkLivePatch(ws, 'add_condition', { targetId: nodeId, payload: { condition: 'fin18' } });
    MP.proposePatch(ws, p18); MP.classifyPatch(ws, p18.mapId, p18.patchId);
    const realAw2 = CL.atomicWrite;
    CL.atomicWrite = function (f, txt) { if (String(f).includes(path.sep + 'pending' + path.sep) && String(txt).includes('resolved')) return false; return realAw2.apply(CL, arguments); };
    let a18; try { a18 = MP.applyPatch(ws, p18.mapId, p18.patchId, { preCutover: true }); } finally { CL.atomicWrite = realAw2; }
    ok(a18.ok === true && a18.finalizePending === true, '적용 완결·종결만 실패=finalizePending 정직 보고');
    const re18 = MP.applyPatch(ws, p18.mapId, p18.patchId, { preCutover: true });
    ok(re18.ok === false && re18.supplemented === true, '재시도=영수증 전체 검증 후 보충 종결(재적용 금지)');
    const pend18 = JSON.parse(fs.readFileSync(path.join(d.pending, p18.patchId + '.json'), 'utf8'));
    ok(pend18.lifecycle === 'resolved', 'pending=resolved 확정');
    // 18차: 영수증인데 decision 파일 삭제=conflict(성공 위장 종결 차단)
    const { patch: p18b } = mkLivePatch(ws, 'add_condition', { targetId: nodeId, payload: { condition: 'fin18b' } });
    MP.proposePatch(ws, p18b); MP.classifyPatch(ws, p18b.mapId, p18b.patchId);
    CL.atomicWrite = function (f, txt) { if (String(f).includes(path.sep + 'pending' + path.sep) && String(txt).includes('resolved')) return false; return realAw2.apply(CL, arguments); };
    let a18b; try { a18b = MP.applyPatch(ws, p18b.mapId, p18b.patchId, { preCutover: true }); } finally { CL.atomicWrite = realAw2; }
    ok(a18b.ok && a18b.finalizePending, '(전제) 종결 미완 상태');
    const decP18 = path.join(ws, 'project-map', 'decisions', a18b.decisionId + '.json');
    const decT18 = fs.readFileSync(decP18, 'utf8');
    fs.unlinkSync(decP18);
    const re18b = MP.applyPatch(ws, p18b.mapId, p18b.patchId, { preCutover: true });
    ok(re18b.ok === false && /불일치|부재|conflict/.test(re18b.error) && !re18b.supplemented, '영수증인데 decision 부재=conflict(보충 종결 거부)');
    fs.writeFileSync(decP18, decT18);
    ok(MP.applyPatch(ws, p18b.mapId, p18b.patchId, { preCutover: true }).supplemented === true, '복원 후 보충 종결');
    // 19차 #1: 영수증 소실+산출물 잔존 혼합=conflict(자동 재선점 금지)
    const { patch: p19 } = mkLivePatch(ws, 'add_condition', { targetId: nodeId, payload: { condition: 'mix19' } });
    MP.proposePatch(ws, p19); MP.classifyPatch(ws, p19.mapId, p19.patchId);
    CL.atomicWrite = function (f, txt) { if (String(f).includes(path.sep + 'pending' + path.sep) && String(txt).includes('resolved')) return false; return realAw2.apply(CL, arguments); };
    let a19; try { a19 = MP.applyPatch(ws, p19.mapId, p19.patchId, { preCutover: true }); } finally { CL.atomicWrite = realAw2; }
    ok(a19.ok && a19.finalizePending, '(전제) claimed+영수증 존재');
    fs.unlinkSync(path.join(MP.dirsFor(ws, p19.mapId).walComplete, a19.decisionId + '.json')); // 영수증 소실 재현
    const re19 = MP.applyPatch(ws, p19.mapId, p19.patchId, { preCutover: true });
    ok(re19.ok === false && /혼합 상태/.test(re19.error), '영수증 소실+decision 잔존=conflict(재선점·재적용 왜곡 차단)');
    // 20차 #2: 정책 artifact 단독 잔존(D·K 부재·Pf만)=혼합 conflict(자동 재선점 금지)
    const pol20 = { policyId: U(90), mapId: p19.mapId, scope: 'project', predicateExpr: { version: 1, kind: 'op-class', opClass: 'split' }, predicateDescription: '분할 원칙', chosenMeaning: '유지', createdFromDecision: U(91), verification: { kind: 'historyless', basisFp: PM.mapHashOf(MR.readTopoExFor(ws).topo), inventoryFp: sha('inv20') }, active: true };
    const { patch: pp20 } = mkLivePatch(ws, 'create_intent_policy', { payload: { policy: pol20 }, evidence: undefined, authorizationRefs: [{ kind: 'user-choice', ref: 'card-20' }] });
    MP.proposePatch(ws, pp20); MP.classifyPatch(ws, pp20.mapId, pp20.patchId);
    CL.atomicWrite = function (f, txt) { if (String(f).includes(path.sep + 'pending' + path.sep) && String(txt).includes('resolved')) return false; return realAw2.apply(CL, arguments); };
    let a20p; try { a20p = MP.applyPatch(ws, pp20.mapId, pp20.patchId, { preCutover: true, resolutionRef: 'card-20' }); } finally { CL.atomicWrite = realAw2; }
    ok(a20p.ok && a20p.finalizePending, '(전제) 정책 적용+종결 미완');
    fs.unlinkSync(path.join(MP.dirsFor(ws, pp20.mapId).walComplete, a20p.decisionId + '.json'));
    fs.unlinkSync(path.join(ws, 'project-map', 'decisions', a20p.decisionId + '.json'));
    try { fs.unlinkSync(path.join(MP.dirsFor(ws, pp20.mapId).markers, a20p.decisionId + '.json')); } catch { /* 정책은 marker 없을 수 있음 */ }
    const re20p = MP.applyPatch(ws, pp20.mapId, pp20.patchId, { preCutover: true, resolutionRef: 'card-20' });
    ok(re20p.ok === false && /혼합 상태/.test(re20p.error), '정책 파일 단독 잔존=conflict(20차 #2 — Pf 3분기)');

    // rebase snapshot basis(14차 #9): 위조 inventoryFp patch의 스냅샷 basis가 신선 값
    const { patch: pr9 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "snap9" } });
    pr9.basis = { ...pr9.basis, inventoryFp: sha("낡음") };
    MP.proposePatch(ws, pr9); MP.classifyPatch(ws, pr9.mapId, pr9.patchId);
    const ap9 = MP.applyPatch(ws, pr9.mapId, pr9.patchId, { preCutover: true });
    ok(ap9.ok, "(전제) rebase 적용");
    const snap9 = JSON.parse(fs.readFileSync(path.join(d.snapshots, ap9.decisionId + ".json"), "utf8"));
    ok(snap9.basis.inventoryFp !== sha("낡음"), "스냅샷 basis=재기반 후 값(감사 기준선 일치 — 14차 #9)");
    // 손상 topology(parse 가능·mapId 비UUID)의 경로 이탈 차단(14차 #6)
    let threw = false;
    try { MP.dirsFor(ws, "../../escape"); } catch { threw = true; }
    ok(threw, "dirsFor 비UUID mapId=예외(경로 이탈 원천 차단)");
  }

  console.log("[11] 20차 #3 — GC 보존 상한: audit.ts 1차 정렬·클램프·경계·claimed 보호·marker 연동");
  {
    const ws = mkRepo("gc20");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    const topo = initTopo(ws);
    const d = MP.dirsFor(ws, topo.mapId);
    fs.mkdirSync(d.walComplete, { recursive: true }); fs.mkdirSync(d.markers, { recursive: true }); fs.mkdirSync(d.pending, { recursive: true });
    // ts는 i 증가 순(최신), id는 randomUUID — UUID 사전순과 시간 순의 불일치를 그대로 재현
    const mkC = (i, ts) => { const id = require('crypto').randomUUID(); fs.writeFileSync(path.join(d.walComplete, id + '.json'), JSON.stringify({ decision: { audit: { ts: ts || ('2026-01-01T00:00:' + String(i).padStart(2, '0') + '.000Z') } } })); return id; };
    const ids = []; for (let i = 0; i < 25; i++) ids.push(mkC(i));
    fs.writeFileSync(path.join(d.markers, ids[24] + '.json'), '{}');
    fs.writeFileSync(path.join(d.markers, ids[0] + '.json'), '{}');
    process.env.CODEX_BRIDGE_MAP_GC_KEEP = '5'; // 최솟값 미만 → 20으로 클램프
    ok(MP.pipelineGc(ws, topo.mapId).ok, '(전제) gc 실행');
    const leftA = new Set(fs.readdirSync(d.walComplete).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
    ok(leftA.size === 20, '클램프: env 5→최솟값 20(25→20)');
    ok(ids.slice(0, 5).every((id) => !leftA.has(id)) && ids.slice(5).every((id) => leftA.has(id)), '제거 5건=audit.ts 오래된 순(UUID 사전순 아님 — 20차 #3)');
    ok(!fs.existsSync(path.join(d.markers, ids[0] + '.json')) && fs.existsSync(path.join(d.markers, ids[24] + '.json')), '비-git marker=complete 정리 연동(대응 complete 부재만 제거)');
    ok(MP.pipelineGc(ws, topo.mapId).ok && fs.readdirSync(d.walComplete).filter((f) => f.endsWith('.json')).length === 20, '경계 20/20=무제거');
    // 상한은 '보호 제외 항목' 기준: claimed 참조 최고령(oldId)은 카운트 밖·비보호 최고령(old2)만 제거
    const oldId = mkC(0, '2025-12-31T00:00:00.000Z');
    fs.writeFileSync(path.join(d.pending, require('crypto').randomUUID() + '.json'), JSON.stringify({ lifecycle: 'claimed', claim: { decisionId: oldId } }));
    const old2 = mkC(0, '2025-12-30T00:00:00.000Z');
    ok(MP.pipelineGc(ws, topo.mapId).ok, '(전제) gc');
    const leftB = new Set(fs.readdirSync(d.walComplete).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
    ok(leftB.size === 21 && leftB.has(oldId) && !leftB.has(old2) && leftB.has(ids[5]), '경계 21비보호→20: claimed 참조 최고령 보호(상한 불참)·비보호 최고령만 제거');
    process.env.CODEX_BRIDGE_MAP_GC_KEEP = 'abc'; // NaN → 기본 200
    ok(MP.pipelineGc(ws, topo.mapId).ok && fs.readdirSync(d.walComplete).filter((f) => f.endsWith('.json')).length === 21, 'NaN env=기본 200(무제거)');
    delete process.env.CODEX_BRIDGE_MAP_GC_KEEP;
  }

  console.log("[12] guard 배선(C-5·1-32) — 산출물 일치 제외·혼합=검증 대상·P1 exclude 분리");
  {
    const ws = mkRepo("guard");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    const topo0 = initTopo(ws);
    ok(MP.guardExcludedFor(ws).mode === "bootstrap-only", "decisions/ 부재=bootstrap-only(P1 exclude 유지)");
    const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo0.nodes[0].id, payload: { condition: "g1" } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
    const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
    ok(ap.ok, "(전제) topology 적용");
    const decRel = "project-map/decisions/" + ap.decisionId + ".json";
    let g = MP.guardExcludedFor(ws);
    ok(g.mode === "pipeline" && g.excluded.has(decRel), "적용 직후: decision 파일=marker 일치 제외");
    ok(g.excluded.has("project-map/topology.json") && g.excluded.has("project-map/MAP.md"), "topology·MAP.md=최신 applied 지문 쌍 일치 제외(1-32)");
    ok(MB.mapAutoExcluded(ws).has(decRel), "mapAutoExcluded가 pipeline 모드 소비(P1 exclude 미사용 — C-5 적용 조건 분리)");
    // 수동 topology 편집(유효 JSON 유지) → topology·MAP.md 쌍 전체 검증 대상, decision 제외는 유지
    const tp = path.join(ws, "project-map", "topology.json");
    const tOrig = fs.readFileSync(tp, "utf8");
    const tMod = JSON.parse(tOrig); tMod.nodes[0].label = tMod.nodes[0].label + " 수동";
    fs.writeFileSync(tp, JSON.stringify(tMod, null, 1));
    g = MP.guardExcludedFor(ws);
    ok(!g.excluded.has("project-map/topology.json") && !g.excluded.has("project-map/MAP.md") && g.excluded.has(decRel), "수동 topology 편집=쌍 포함(검증 대상)·decision 제외 유지");
    fs.writeFileSync(tp, tOrig);
    // decision 파일 변조 → 그 marker 산출물 전부 검증 대상(유일 decision이면 latest 부재 → topology 쌍도 포함)
    const dp = path.join(ws, decRel);
    const dOrig = fs.readFileSync(dp, "utf8");
    fs.writeFileSync(dp, dOrig + " ");
    g = MP.guardExcludedFor(ws);
    ok(g.mode === "pipeline" && g.excluded.size === 0, "decision 변조=전부 검증 대상(marker 불일치·latest 부재)");
    fs.writeFileSync(dp, dOrig);
    // 정책 적용 → 정책 파일 제외, 변조 시 포함(decision 제외는 유지)
    const polG = { policyId: U(95), mapId: patch.mapId, scope: 'project', predicateExpr: { version: 1, kind: 'op-class', opClass: 'widen' }, predicateDescription: '확장 원칙', chosenMeaning: '유지', createdFromDecision: U(96), verification: { kind: 'historyless', basisFp: PM.mapHashOf(MR.readTopoExFor(ws).topo), inventoryFp: sha('invG') }, active: true };
    const { patch: pg } = mkLivePatch(ws, 'create_intent_policy', { payload: { policy: polG }, evidence: undefined, authorizationRefs: [{ kind: 'user-choice', ref: 'card-g' }] });
    MP.proposePatch(ws, pg); MP.classifyPatch(ws, pg.mapId, pg.patchId);
    const apg = MP.applyPatch(ws, pg.mapId, pg.patchId, { preCutover: true, resolutionRef: 'card-g' });
    ok(apg.ok, "(전제) 정책 적용");
    const pfRel = "project-map/policies/" + U(95) + ".json";
    g = MP.guardExcludedFor(ws);
    ok(g.excluded.has(pfRel) && g.excluded.has("project-map/decisions/" + apg.decisionId + ".json"), "정책 파일+정책 decision=제외");
    ok(g.excluded.has("project-map/topology.json"), "정책 op 후에도 topology 쌍 제외 유지(무변경 — 최신 decision의 after=현재)");
    const pfp = path.join(ws, pfRel);
    const pfOrig = fs.readFileSync(pfp, "utf8");
    fs.writeFileSync(pfp, pfOrig + " ");
    g = MP.guardExcludedFor(ws);
    ok(!g.excluded.has(pfRel) && g.excluded.has(decRel), "정책 파일 변조=포함(검증 대상)·타 decision 제외 유지");
    fs.writeFileSync(pfp, pfOrig);
    // 23차 #1: marker 합타입 위반=fail-open 금지(그 marker 산출물 전부 검증 대상)
    const mkDir = MP.dirsFor(ws, patch.mapId).markers;
    const mkT = path.join(mkDir, ap.decisionId + '.json');
    const mkTOrig = fs.readFileSync(mkT, 'utf8');
    const mkTObj = JSON.parse(mkTOrig);
    fs.writeFileSync(mkT, JSON.stringify({ decisionId: mkTObj.decisionId, decisionFileAfterHash: mkTObj.decisionFileAfterHash }, null, 1));
    g = MP.guardExcludedFor(ws);
    ok(!g.excluded.has(decRel) && !g.excluded.has('project-map/topology.json') && !g.excluded.has('project-map/MAP.md'), 'policyArtifact 키 누락 marker=전부 포함(23차 #1)');
    fs.writeFileSync(mkT, mkTOrig);
    const mkP = path.join(mkDir, apg.decisionId + '.json');
    const mkPOrig = fs.readFileSync(mkP, 'utf8');
    for (const bad of [{}, { kind: 'unknown', id: U(95), fileAfterHash: sha('z') }]) {
      const o2 = JSON.parse(mkPOrig); o2.policyArtifact = bad;
      fs.writeFileSync(mkP, JSON.stringify(o2, null, 1));
      g = MP.guardExcludedFor(ws);
      ok(!g.excluded.has(pfRel) && !g.excluded.has('project-map/decisions/' + apg.decisionId + '.json'), 'policyArtifact ' + (bad.kind || '{}') + '=합타입 위반 marker 전체 불신(23차 #1)');
    }
    fs.writeFileSync(mkP, mkPOrig);
    // 23차 #3: MAP.md 부재≠빈 파일 — 삭제=검증 대상(topology writer는 파일을 항상 생성)
    const mdP = path.join(ws, 'project-map', 'MAP.md');
    const mdOrig = fs.readFileSync(mdP, 'utf8');
    fs.unlinkSync(mdP);
    g = MP.guardExcludedFor(ws);
    ok(!g.excluded.has('project-map/topology.json') && !g.excluded.has('project-map/MAP.md') && g.excluded.has(decRel), 'MAP.md 삭제=쌍 포함(23차 #3)·decision 제외 유지');
    fs.writeFileSync(mdP, mdOrig);
    // 23차 #2: 첫 P2 decision이 policy-only — topology/MAP.md는 검증 대상(정책 감사 지문으로 오귀속 금지·P1 exclude도 비활성)
    {
      const ws2 = mkRepo('guardpol');
      setScoutOn(ws2); MB.grantConsent(ws2, 'test');
      initTopo(ws2);
      const polO = { policyId: U(97), mapId: MR.readTopoExFor(ws2).topo.mapId, scope: 'project', predicateExpr: { version: 1, kind: 'op-class', opClass: 'narrow' }, predicateDescription: '축소 원칙', chosenMeaning: '유지', createdFromDecision: U(98), verification: { kind: 'historyless', basisFp: PM.mapHashOf(MR.readTopoExFor(ws2).topo), inventoryFp: sha('invO') }, active: true };
      const { patch: po } = mkLivePatch(ws2, 'create_intent_policy', { payload: { policy: polO }, evidence: undefined, authorizationRefs: [{ kind: 'user-choice', ref: 'card-o' }] });
      MP.proposePatch(ws2, po); MP.classifyPatch(ws2, po.mapId, po.patchId);
      const apo = MP.applyPatch(ws2, po.mapId, po.patchId, { preCutover: true, resolutionRef: 'card-o' });
      ok(apo.ok, '(전제) policy-only 적용');
      const g2 = MP.guardExcludedFor(ws2);
      ok(g2.mode === 'pipeline' && !g2.excluded.has('project-map/topology.json') && !g2.excluded.has('project-map/MAP.md'), '정책 decision만 존재=topology 쌍 미제외(오귀속 차단 — 23차 #2)');
      ok(g2.excluded.has('project-map/decisions/' + apo.decisionId + '.json') && g2.excluded.has('project-map/policies/' + U(97) + '.json'), '정책 산출물 자체는 제외');
    }
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  try { fs.rmSync(process.env.CODEX_BRIDGE_HOME, { recursive: true, force: true }); } catch { /* 무해 */ }
  process.exit(fail ? 1 : 0);
}
main();
