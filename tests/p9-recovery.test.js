/* P9 recovery-action — 후보 선택, 복구본 생성, 명시 교체, dead nsLock 회수. */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p9rec_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bootstrap.js");
const MI = require("../bridge/map-intent.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");

function setup(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p9rec_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  if (MR.initTopologyForBootstrap(ws).st !== "created") throw new Error("init 실패");
  return { ws, topo: MR.readTopoExFor(ws).topo };
}

function makeSnapshot(ws) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId), pol = MP.policyStateFor(ws, topo.mapId);
  const ah = MP.authorityOf(PM.mapHashOf(topo), idx).ah;
  const patch = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah,
    baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "",
    operation: "add_condition", targetId: topo.nodes[0].id, payload: { condition: "recovery-source" }, readSet: {},
    rationale: "recovery fixture", evidence: [{ kind: "code", ref: "src/a.js" }],
  };
  patch.readSet = MP.buildReadSetFor(topo, patch, { idx, pol, repoRoot: ws, fileHashOf: (ref) => sha(fs.readFileSync(path.join(ws, ref), "utf8")) });
  MP.proposePatch(ws, patch); MP.classifyPatch(ws, topo.mapId, patch.patchId);
  const applied = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true });
  if (!applied.ok) throw new Error("snapshot apply 실패");
  return applied.decisionId;
}

console.log("[1] 진입 게이트 — 정상/부재는 복구 교체를 열지 않음");
{
  const { ws, topo } = setup("gate");
  const normal = MI.collectRecoveryState(ws);
  ok(normal.ok && !normal.needed && normal.topologyState === "ok", "정상 topology=복구 불필요");
  ok(MI.prepareTopologyRecovery(ws, topo.mapId).reason === "not-corrupt", "정상 상태에서 복구본 생성 거부");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "p9rec_absent_"));
  const absent = MI.collectRecoveryState(empty);
  ok(absent.ok && !absent.needed && absent.reason === "bootstrap-required", "topology 부재=복구가 아니라 bootstrap 안내");
}

console.log("[2] 손상 복구 2단 — 복구본 검증 뒤에만 원본 백업+원자 교체");
{
  const { ws, topo } = setup("replace");
  makeSnapshot(ws);
  const topoFile = path.join(ws, "project-map", "topology.json");
  const corruptRaw = "{\n \"broken\": true\n}\n";
  fs.writeFileSync(topoFile, corruptRaw);
  const state = MI.collectRecoveryState(ws);
  ok(state.ok && state.needed && state.kind === "topology-corruption" && state.candidates.length === 1 && state.mapId === topo.mapId, "decision+snapshot에서 유일 mapId 자동 선택");
  ok(state.candidates[0].sources.includes("decision") && state.candidates[0].sources.includes("snapshot") && state.candidates[0].latestSnapshot.appliedCount >= 0, "후보에 공유 decision·최신 snapshot 근거 표시");
  const made = MI.prepareTopologyRecovery(ws, topo.mapId);
  ok(made.ok && made.stage === "prepared" && fs.existsSync(made.recoveredFile), "1단=별도 topology.recovered.json 생성");
  const plan = MI.readRecoveryPlan(ws);
  ok(plan.st === "ok" && plan.data.planId === made.planId && plan.data.nonce === made.nonce
    && plan.data.originalFp && plan.data.candidateFp && plan.data.recoveredHash === made.recoveredHash,
    "1단 내구 계획=planId·nonce·원본/후보/복구본 지문 결속");
  ok(fs.readFileSync(topoFile, "utf8") === corruptRaw, "1단에서는 손상 원본 바이트 그대로 보존");

  fs.writeFileSync(made.recoveredFile, "{bad");
  const denied = MI.confirmTopologyRecovery(ws, topo.mapId, { planId: made.planId, nonce: made.nonce, recoveredHash: made.recoveredHash });
  ok(!denied.ok && denied.reason === "recovered-changed" && fs.readFileSync(topoFile, "utf8") === corruptRaw, "복구본 변경·검증 실패=교체 0");
  ok(fs.readdirSync(path.join(ws, "project-map")).filter((x) => x.startsWith("topology.corrupt-")).length === 0, "확정 전 백업 파일도 만들지 않음");

  const made2 = MI.prepareTopologyRecovery(ws, topo.mapId);
  const wrongNonce = MI.confirmTopologyRecovery(ws, topo.mapId, { planId: made2.planId, nonce: "0".repeat(32), recoveredHash: made2.recoveredHash });
  ok(!wrongNonce.ok && wrongNonce.reason === "confirmation-mismatch" && fs.readFileSync(topoFile, "utf8") === corruptRaw,
    "낡거나 변조된 plan nonce=원본 교체 0");
  fs.writeFileSync(topoFile, "{\n \"broken\": \"changed-after-prepare\"\n}\n");
  const wrongOriginal = MI.confirmTopologyRecovery(ws, topo.mapId, { planId: made2.planId, nonce: made2.nonce, recoveredHash: made2.recoveredHash });
  ok(!wrongOriginal.ok && wrongOriginal.reason === "original-changed", "준비 뒤 손상 원본이 달라지면 확인 계획 stale 차단");
  fs.writeFileSync(topoFile, corruptRaw);
  const confirmed = MI.confirmTopologyRecovery(ws, topo.mapId, { planId: made2.planId, nonce: made2.nonce, recoveredHash: made2.recoveredHash });
  ok(confirmed.ok && confirmed.stage === "confirmed" && MR.readTopoExFor(ws).st === "ok", "2단 명시 확인=유효 복구본으로 교체");
  ok(fs.existsSync(confirmed.backup) && fs.readFileSync(confirmed.backup, "utf8") === corruptRaw, "손상 원본은 시각 백업명으로 삭제 없이 보존");
  ok(!fs.existsSync(path.join(ws, "project-map", "topology.recovered.json")), "확정된 복구본은 topology 정본으로 원자 이동");
  ok(MI.readRecoveryPlan(ws).st === "absent", "확정 뒤 내구 확인 계획 종결");
}

console.log("[2b] 복구 교체 중단 — 첫 rename 뒤 재시작 상태 수집이 같은 계획을 자체 수렴");
{
  const { ws, topo } = setup("crash-converge");
  makeSnapshot(ws);
  const topoFile = path.join(ws, "project-map", "topology.json");
  const corruptRaw = "{\n \"broken\": \"crash-window\"\n}\n";
  fs.writeFileSync(topoFile, corruptRaw);
  const made = MI.prepareTopologyRecovery(ws, topo.mapId);
  const stopped = MI.confirmTopologyRecovery(ws, topo.mapId,
    { planId: made.planId, nonce: made.nonce, recoveredHash: made.recoveredHash }, { stopAfterPhase: "original-backed-up" });
  ok(stopped.ok && stopped.stopped && !fs.existsSync(topoFile) && MI.readRecoveryPlan(ws).data.phase === "replacing",
    "원본 backup 직후 종료=topology 부재여도 replacing 계획·backup 보존");
  const state = MI.collectRecoveryState(ws);
  ok(state.ok && state.topologyState === "ok" && MR.readTopoExFor(ws).topo.mapId === topo.mapId,
    "다음 상태 수집이 복구본 설치를 재개해 유효 topology로 수렴");
  ok(fs.existsSync(stopped.backup) && fs.readFileSync(stopped.backup, "utf8") === corruptRaw && MI.readRecoveryPlan(ws).st === "absent",
    "수렴 뒤 손상 backup 보존·전이 계획 종결");
}
{
  const { ws, topo } = setup("crash-after-install");
  makeSnapshot(ws);
  const topoFile = path.join(ws, "project-map", "topology.json");
  fs.writeFileSync(topoFile, "{\n \"broken\": \"after-install\"\n}\n");
  const made = MI.prepareTopologyRecovery(ws, topo.mapId);
  const stopped = MI.confirmTopologyRecovery(ws, topo.mapId,
    { planId: made.planId, nonce: made.nonce, recoveredHash: made.recoveredHash }, { stopAfterPhase: "topology-installed" });
  ok(stopped.ok && stopped.stopped && MR.readTopoExFor(ws).st === "ok" && MI.readRecoveryPlan(ws).data.phase === "replacing",
    "복구본 설치 직후 종료=유효 topology와 미종결 replacing 계획 보존");
  const state = MI.collectRecoveryState(ws);
  ok(state.ok && state.topologyState === "ok" && MI.readRecoveryPlan(ws).st === "absent" && fs.existsSync(stopped.backup),
    "다음 상태 수집이 설치 완료를 판독해 계획만 안전하게 종결");
}

console.log("[2c] 2트랙 재확인 — 모달 뒤 전환되면 준비·확정·잠금 쓰기 0");
{
  const { ws, topo } = setup("mode-switch");
  makeSnapshot(ws);
  const topoFile = path.join(ws, "project-map", "topology.json");
  const corruptRaw = "{\n \"broken\": \"mode-switch\"\n}\n";
  fs.writeFileSync(topoFile, corruptRaw);
  const made = MI.prepareTopologyRecovery(ws, topo.mapId);
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "off" }));
  const denied = MI.confirmTopologyRecovery(ws, topo.mapId,
    { planId: made.planId, nonce: made.nonce, recoveredHash: made.recoveredHash });
  ok(!denied.ok && denied.reason === "two-track" && fs.readFileSync(topoFile, "utf8") === corruptRaw,
    "준비 뒤 2트랙 전환=확정 API가 원본·복구본 무변경");
  try { fs.unlinkSync(made.recoveredFile); } catch { /* test cleanup */ }
  const prepareDenied = MI.prepareTopologyRecovery(ws, topo.mapId);
  ok(!prepareDenied.ok && prepareDenied.reason === "two-track" && !fs.existsSync(made.recoveredFile),
    "2트랙에서 복구본 재생성 0");
}

console.log("[2d] 내구 계획 변조 — 후보 스냅샷 결속이 달라지면 확인 거부");
{
  const { ws, topo } = setup("plan-tamper");
  makeSnapshot(ws);
  const topoFile = path.join(ws, "project-map", "topology.json");
  const corruptRaw = "{\n \"broken\": \"plan-tamper\"\n}\n";
  fs.writeFileSync(topoFile, corruptRaw);
  const made = MI.prepareTopologyRecovery(ws, topo.mapId);
  const planFile = MI.recoveryPlanFileFor(ws);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  plan.candidate.sources.push("tampered-source");
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 1));
  const denied = MI.confirmTopologyRecovery(ws, topo.mapId,
    { planId: made.planId, nonce: made.nonce, recoveredHash: made.recoveredHash });
  ok(!denied.ok && denied.reason === "plan-not-prepared" && MI.readRecoveryPlan(ws).st === "invalid"
    && fs.readFileSync(topoFile, "utf8") === corruptRaw,
    "후보 내용과 candidateFp 불일치=원본 교체 0·fail-visible");
}

console.log("[3] 복수/무후보 — 추측 선택 금지");
{
  const a = setup("multi");
  makeSnapshot(a.ws);
  const other = crypto.randomUUID();
  const otherTopo = JSON.parse(JSON.stringify(MR.readTopoExFor(a.ws).topo)); otherTopo.mapId = other;
  const od = MP.dirsFor(a.ws, other); fs.mkdirSync(od.snapshots, { recursive: true });
  const did = crypto.randomUUID();
  fs.writeFileSync(path.join(od.snapshots, did + ".json"), JSON.stringify({ mapId: other, decisionId: did, appliedCountAtSnapshot: 3, topology: otherTopo }));
  fs.writeFileSync(path.join(a.ws, "project-map", "topology.json"), "[]");
  const multi = MI.collectRecoveryState(a.ws);
  ok(multi.candidates.length === 2 && multi.mapId === undefined, "복수 세대=자동 선택 없이 후보 2건 표시");
  ok(MI.prepareTopologyRecovery(a.ws, crypto.randomUUID()).reason === "candidate-stale", "목록 밖 mapId 명시=거부");

  const b = setup("none");
  fs.writeFileSync(path.join(b.ws, "project-map", "topology.json"), "{bad");
  const none = MI.collectRecoveryState(b.ws);
  ok(none.candidates.length === 0 && none.reason === "no-recovery-source", "증거원 0건일 때만 복구 불가 안내");
}

console.log("[4] dead nsLock — 활성·손상 잠금은 건드리지 않고 사망 잔재만 정본 GC로 회수");
{
  const { ws, topo } = setup("lock");
  const d = MP.dirsFor(ws, topo.mapId); fs.mkdirSync(d.base, { recursive: true });
  const lf = path.join(d.base, ".nslock");
  fs.writeFileSync(lf, JSON.stringify({ pid: 999999, token: "dead-lock" }));
  const state = MI.collectRecoveryState(ws);
  ok(state.needed && state.kind === "pipeline-lock" && state.lock.state === "dead", "정상 지도라도 dead nsLock은 복구 행으로 표시");
  const rec = MI.recoverDeadPipelineLock(ws, topo.mapId);
  ok(rec.ok && !fs.existsSync(lf), "dead-valid만 map lock 아래 원자 격리");
  fs.writeFileSync(lf, "not-json");
  const bad = MI.recoverDeadPipelineLock(ws, topo.mapId);
  ok(!bad.ok && bad.reason === "lock-not-dead" && fs.existsSync(lf), "손상 잠금=판단 없는 삭제 금지");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
