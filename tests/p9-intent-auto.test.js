/* P9 증분 2C — 정책 위임 전이 원장과 자동 스윕. */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p9auto_home_"));
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

function setup(tag, scoutOn = true) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p9auto_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: scoutOn ? "on" : "off" }));
  MB.grantConsent(ws, "test");
  if (MR.initTopologyForBootstrap(ws).st !== "created") throw new Error("init 실패");
  return { ws, topo: MR.readTopoExFor(ws).topo };
}

function livePatch(ws, op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const ah = MP.authorityOf(PM.mapHashOf(topo), idx).ah;
  const p = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah,
    baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "",
    operation: op, payload: {}, readSet: {}, rationale: "p9 auto", evidence: [{ kind: "code", ref: "src/a.js" }],
    ...(fields || {}),
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  p.readSet = MP.buildReadSetFor(topo, p, {
    idx, pol, repoRoot: ws,
    fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } },
  });
  return PM.canonicalPatchV2(p);
}

function legacyIntent(ws) {
  const topo = MR.readTopoExFor(ws).topo;
  const node = topo.nodes[0];
  const p = livePatch(ws, "rewrite_label", { targetId: node.id, payload: { to: { label: node.label + "-policy" }, expect: { label: node.label } } });
  MP.proposePatch(ws, p); MP.classifyPatch(ws, topo.mapId, p.patchId);
  const f = path.join(MP.dirsFor(ws, topo.mapId).pending, p.patchId + ".json");
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...rec, classification: "intent-choice" }, null, 1));
  return p;
}

function policy(ws, disposition, suffix) {
  const topo = MR.readTopoExFor(ws).topo;
  const pol = {
    policyId: crypto.randomUUID(), mapId: topo.mapId, scope: "project",
    predicateExpr: { version: 1, kind: "op-class", opClass: "rewrite_label" },
    predicateDescription: "같은 라벨 변경에 " + disposition,
    chosenMeaning: { version: 1, disposition, opClass: "rewrite_label" },
    createdFromDecision: crypto.randomUUID(),
    verification: { kind: "historyless", basisFp: PM.structuralHashOf(topo), inventoryFp: PM.opHashOf(topo.inventory) },
    active: true,
  };
  const cardId = crypto.randomUUID();
  const p = livePatch(ws, "create_intent_policy", { payload: { policy: pol }, evidence: undefined, authorizationRefs: [{ kind: "user-choice", ref: cardId }], rationale: "policy " + suffix });
  const a = MP.proposePatch(ws, p).ok && MP.classifyPatch(ws, topo.mapId, p.patchId).ok
    && MP.applyPatch(ws, topo.mapId, p.patchId, { preCutover: true, resolutionRef: cardId });
  if (!a || !a.ok) throw new Error("policy install 실패: " + JSON.stringify(a));
  return pol;
}

function pending(ws, mapId, patchId) {
  return JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, mapId).pending, patchId + ".json"), "utf8"));
}

console.log("[1] 2트랙 게이트 — 파일·로그·적용 0");
{
  const { ws, topo } = setup("off", false);
  const p = legacyIntent(ws);
  let logs = 0;
  const r = MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true, log: () => logs++ });
  ok(r.outcome === "noop" && r.reason === "two-track", "scoutMode off면 즉시 no-op");
  ok(!fs.existsSync(MI.intentDirFor(ws)) && logs === 0, "2트랙은 선택 서랍·로그 생성 0");
  ok(pending(ws, topo.mapId, p.patchId).lifecycle === "classified", "기존 pending 무변경");
  const direct = MI.resumeDelegation(ws, topo.mapId, p.patchId, { ws, preCutover: true });
  ok(!direct.ok && direct.reason === "two-track" && !fs.existsSync(MI.intentDirFor(ws)),
    "2트랙에서 직접 위임 재개 API도 원장·잠금 생성 0");
}

console.log("[2] 단일 apply 정책 — 전문 선기록→재기반→위임 decision→구 제안 종결");
{
  const { ws, topo } = setup("apply");
  const old = legacyIntent(ws);
  const pol = policy(ws, "apply", "apply");
  const lines = [];
  const r = MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true, log: (line) => lines.push(line) });
  const lr = MI.readDelegationRecord(ws, old.patchId);
  const at = lr.data.attempts[0];
  ok(r.ok && r.applied === 1 && lines.length === 1, "항목 적용 성공·요약 로그 정확히 1줄");
  ok(lr.st === "ok" && at.phase === "done" && at.patchCanonical.patchId === at.replacementPatchId, "위임 원장 전문·done 종결");
  ok(PM.opHashOf(at.patchCanonical) === at.expectedOpHash && at.dchAtStart === at.patchCanonical.baseDecisionContextHash, "replacement 내용 지문·시작 판단 기준 결속");
  ok(at.patchCanonical.readSet.policies.refs.some((x) => x.policyId === pol.policyId && x.policyFp === at.policyFp), "새 read-set에 선택 정책 ID·실제 지문 포함");
  ok(pending(ws, topo.mapId, old.patchId).lifecycle === "expired" && pending(ws, topo.mapId, old.patchId).expireCode === "superseded", "구 pending은 superseded로 보존 종결");
  const dec = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", at.outcome.appliedDecisionId + ".json"), "utf8"));
  ok(dec.classification === "auto" && dec.actor.kind === "user-choice-delegated" && dec.actor.policyId === pol.policyId, "decision=auto+사용자 선택 정책 위임");
  ok(MR.readTopoExFor(ws).topo.nodes[0].label.endsWith("-policy"), "정책이 지지한 변경 실제 반영");
  const again = MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true });
  ok(again.scanned === 0 && MI.readDelegationRecord(ws, old.patchId).data.attempts.length === 1, "재실행=중복 attempt·중복 적용 0");
}

console.log("[3] 단일 decline·동급 충돌 — 자동 적용 없이 정확히 종결/카드화");
{
  const a = setup("decline");
  const old = legacyIntent(a.ws);
  policy(a.ws, "decline", "decline");
  const r = MI.sweepIntentAuto(a.ws, a.topo.mapId, { ws: a.ws, preCutover: true });
  ok(r.declined === 1 && pending(a.ws, a.topo.mapId, old.patchId).expireCode === "policy-declined", "decline 정책=policy-declined 종결");
  ok(!fs.existsSync(MI.delegationFileFor(a.ws, old.patchId)), "거부에는 위임 replacement 원장 0");

  const b = setup("conflict");
  const old2 = legacyIntent(b.ws);
  policy(b.ws, "apply", "a"); policy(b.ws, "decline", "d");
  const r2 = MI.sweepIntentAuto(b.ws, b.topo.mapId, { ws: b.ws, preCutover: true });
  const cards = MI.collectPolicyConflictCards(b.ws, b.topo.mapId, { cardIdFor: () => crypto.randomUUID() });
  ok(r2.conflicts === 1 && cards.ok && cards.cards.length === 1, "같은 특이도 뜻 갈림=충돌 1건·카드 1장");
  ok(pending(b.ws, b.topo.mapId, old2.patchId).lifecycle === "classified" && !fs.existsSync(MI.delegationFileFor(b.ws, old2.patchId)), "충돌이면 자동 적용·원장 생성 0");
}

console.log("[4] 중단·재시작 — attempt 선기록과 applied 영수증에서 각각 수렴");
{
  const a = setup("resume-record");
  const old = legacyIntent(a.ws); policy(a.ws, "apply", "resume");
  const s1 = MI.sweepIntentAuto(a.ws, a.topo.mapId, { ws: a.ws, preCutover: true, stopAfterPhase: "attempt-recorded" });
  let lr = MI.readDelegationRecord(a.ws, old.patchId);
  ok(s1.results.some((x) => x.stopped) && lr.data.attempts[0].phase === "proposed", "pipeline 산출물보다 attempt 전문을 먼저 기록");
  ok(!fs.existsSync(path.join(MP.dirsFor(a.ws, a.topo.mapId).pending, lr.data.attempts[0].replacementPatchId + ".json")), "선기록 직후에는 replacement pending 0");
  const s2 = MI.sweepIntentAuto(a.ws, a.topo.mapId, { ws: a.ws, preCutover: true });
  lr = MI.readDelegationRecord(a.ws, old.patchId);
  ok(s2.ok && lr.data.attempts[0].phase === "done" && lr.data.attempts.length === 1, "저장 전문 그대로 재개·중복 없이 완료");

  const b = setup("resume-applied");
  const old2 = legacyIntent(b.ws); policy(b.ws, "apply", "resume2");
  MI.sweepIntentAuto(b.ws, b.topo.mapId, { ws: b.ws, preCutover: true, stopAfterPhase: "applied" });
  let lr2 = MI.readDelegationRecord(b.ws, old2.patchId);
  ok(lr2.data.attempts[0].phase === "applied" && pending(b.ws, b.topo.mapId, old2.patchId).lifecycle === "classified", "적용 decision 뒤 구 pending 종결 전 종료 재현");
  const s3 = MI.sweepIntentAuto(b.ws, b.topo.mapId, { ws: b.ws, preCutover: true });
  lr2 = MI.readDelegationRecord(b.ws, old2.patchId);
  ok(s3.ok && lr2.data.attempts[0].phase === "done" && pending(b.ws, b.topo.mapId, old2.patchId).expireCode === "superseded", "decision 실존으로 종결만 보충");
}

console.log("[5] 전이 잠금 — 사망 잔재만 토큰 확인 후 회수");
{
  const { ws, topo } = setup("dead-lock");
  const old = legacyIntent(ws); policy(ws, "apply", "lock");
  MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true, stopAfterPhase: "attempt-recorded" });
  const lf = MI.delegationFileFor(ws, old.patchId).replace(/\.json$/, ".lock");
  fs.writeFileSync(lf, JSON.stringify({ pid: 999999, token: "dead-owner" }));
  const r = MI.resumeDelegation(ws, topo.mapId, old.patchId, { preCutover: true });
  ok(r.ok && MI.readDelegationRecord(ws, old.patchId).data.attempts[0].phase === "done", "dead pid 잠금을 원자 격리·재취득 후 완료");
  ok(!fs.existsSync(lf), "자기 토큰 잠금만 종료 시 삭제");
}

console.log("[6] parked 재시도 — 자동 반복 0·명시 재시도만 새 attempt");
{
  const { ws, topo } = setup("parked-retry");
  const old = legacyIntent(ws); policy(ws, "apply", "parked");
  MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true, stopAfterPhase: "attempt-recorded" });
  const ledgerFile = MI.delegationFileFor(ws, old.patchId);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.attempts[0] = { ...ledger.attempts[0], phase: "parked", parkedReason: "test-only parked transition" };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1));
  const once = MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true });
  const twice = MI.sweepIntentAuto(ws, topo.mapId, { ws, preCutover: true });
  ok(once.applied === 0 && twice.applied === 0 && MI.readDelegationRecord(ws, old.patchId).data.attempts.length === 1,
    "parked는 재시작·자동 sweep에서 복구/append를 반복하지 않음");
  const attention = MI.collectIntentDashboard(ws, topo.mapId).attention;
  ok(attention.parkedDelegations === 1 && attention.parkedDelegationItems[0].oldPatchId === old.patchId,
    "대시보드가 사용자가 다시 시도할 parked 위임 ID를 노출");
  const explicit = MI.retryDelegation(ws, topo.mapId, old.patchId, { ws, preCutover: true });
  const after = MI.readDelegationRecord(ws, old.patchId).data;
  ok(explicit.ok && after.attempts.length === 2 && after.attempts[1].phase === "done",
    "명시 재시도에서만 새 attempt를 선기록하고 실제 적용 완료");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
