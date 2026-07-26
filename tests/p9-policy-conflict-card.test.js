/* P9 increment 2B — policy-conflict derived cards + durable choice pre-record. */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p9intent_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MI = require("../bridge/map-intent.js");
const MB = require("../bridge/map-bootstrap.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const U = () => crypto.randomUUID();

function setup(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p9intent_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const init = MR.initTopologyForBootstrap(ws);
  if (init.st !== "created") throw new Error("init 실패: " + init.st);
  return { ws, topo: MR.readTopoExFor(ws).topo };
}

function policy(topo, disposition, overrides) {
  const opClass = overrides && overrides.opClass || "rewrite_label";
  const out = {
    policyId: U(), mapId: topo.mapId, scope: "project",
    predicateExpr: { version: 1, kind: "op-class", opClass },
    predicateDescription: disposition === "apply" ? "같은 이름 변경을 적용" : "같은 이름 변경을 거부",
    chosenMeaning: { version: 1, disposition, opClass },
    createdFromDecision: U(),
    verification: { kind: "historyless", basisFp: sha("old-basis-" + disposition), inventoryFp: sha("old-inv-" + disposition) },
    active: true,
    ...(overrides || {}),
  };
  delete out.opClass;
  return out;
}

function writePolicy(ws, p) {
  const dir = path.join(ws, "project-map", "policies");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, p.policyId + ".json"), JSON.stringify(p, null, 1));
}

function livePatch(ws, topo, label) {
  const now = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, now.mapId);
  const pol = MP.policyStateFor(ws, now.mapId);
  const node = now.nodes[0];
  const ah = MP.authorityOf(PM.mapHashOf(now), idx).ah;
  const p = {
    schema: "map-patch-v2", patchId: U(), mapId: now.mapId,
    basis: MP.patchBasisFor(ws, now), baseMapHash: PM.mapHashOf(now), baseAuthorityHash: ah,
    baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "",
    operation: "rewrite_label", targetId: node.id,
    payload: { to: { label }, expect: { label: node.label } }, readSet: {},
    rationale: "정책 충돌 카드 시험", evidence: [{ kind: "code", ref: "src/a.js" }], provider: "self",
  };
  p.readSet = MP.buildReadSetFor(now, p, { idx, pol, repoRoot: ws, fileHashOf: (ref) => sha(fs.readFileSync(path.join(ws, ref), "utf8")) });
  return p;
}

function makeIntentPending(ws, topo, label) {
  const p = livePatch(ws, topo, label);
  const pr = MP.proposePatch(ws, p);
  const cr = pr.ok && MP.classifyPatch(ws, topo.mapId, p.patchId);
  if (!cr || !cr.ok) throw new Error("분류 실패");
  const file = path.join(MP.dirsFor(ws, topo.mapId).pending, p.patchId + ".json");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  rec.classification = "intent-choice"; // v12 충돌 스윕의 명시 입력 형태를 만든다.
  fs.writeFileSync(file, JSON.stringify(rec, null, 1));
  return p;
}

console.log("[1] 파생 카드 — 저장 없이 같은 충돌을 한 장으로 묶음");
{
  const { ws, topo } = setup("card");
  const apply = policy(topo, "apply"), decline = policy(topo, "decline");
  writePolicy(ws, apply); writePolicy(ws, decline);
  const p1 = makeIntentPending(ws, topo, "새 이름 1");
  const p2 = makeIntentPending(ws, topo, "새 이름 2");
  const fixedCard = U();
  const got = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => fixedCard });
  ok(got.ok && got.cards.length === 1, "서로 반대인 같은 범위 정책=충돌 카드 1장");
  const card = got.cards[0];
  const ids = [apply.policyId, decline.policyId].sort();
  ok(card.cardId === fixedCard && card.conflictKey === MI.conflictKeyOf(ids), "카드 세대 UUID·정렬된 head 집합 지문 결속");
  ok(PM.canonicalJsonOf(card.headPolicyIds) === PM.canonicalJsonOf(ids) && card.policies.length === 2, "충돌 head 정책 요지 2건 포함");
  ok(card.affectedPending.length === 2 && card.affectedPending.map((x) => x.patchId).sort().join("|") === [p1.patchId, p2.patchId].sort().join("|"), "같은 충돌의 영향 제안 2건을 단일 카드에 병합");
  ok(card.affectedPending.every((x) => x.targetLabels.length === 1 && x.opHash && x.baseDecisionContextHash), "영향 제안에 대상 표시·내용 지문·선택 당시 기준 포함");
  ok(!fs.existsSync(MI.intentDirFor(ws)), "카드 조회는 선택 서랍을 만들지 않음(파생 뷰)");
  ok(got.frontierHash === card.frontierHash && got.decisionContextHash === card.decisionContextHash, "카드가 현재 정책 묶음·판단 기준에 결속");
}

console.log("[2] 특이도·지원 형식 — 더 구체적인 뜻만 승리");
{
  const { ws, topo } = setup("specific");
  const target = topo.nodes[0].id;
  const pa = policy(topo, "apply"), pd = policy(topo, "decline");
  const entityApply = policy(topo, "apply", { scope: "entity", scopeTarget: [target] });
  writePolicy(ws, pa); writePolicy(ws, pd); writePolicy(ws, entityApply);
  makeIntentPending(ws, topo, "구체 정책 승리");
  ok(MI.collectPolicyConflictCards(ws, topo.mapId).cards.length === 0, "entity 적용 정책이 project 충돌보다 우선=카드 없음");
  const entityDecline = policy(topo, "decline", { scope: "entity", scopeTarget: [target] });
  writePolicy(ws, entityDecline);
  const got = MI.collectPolicyConflictCards(ws, topo.mapId);
  ok(got.cards.length === 1 && got.cards[0].specificity === 3, "같은 entity 특이도에서 뜻이 갈리면 카드 생성");
  ok(got.cards[0].headPolicyIds.join("|") === [entityApply.policyId, entityDecline.policyId].sort().join("|"), "낮은 project 정책은 충돌 head에서 제외");
}
{
  const { ws, topo } = setup("unsupported");
  const a = policy(topo, "apply");
  const d = policy(topo, "decline");
  d.chosenMeaning = "사람만 읽는 옛 형식";
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "옛 뜻 무시");
  ok(MI.collectPolicyConflictCards(ws, topo.mapId).cards.length === 0, "문자열 뜻은 자동 충돌 판정 입력이 아님");
}

console.log("[3] 선택 선기록 — 전체 정책 교체 patch를 먼저 보존하고 pipeline은 아직 무변경");
{
  const { ws, topo } = setup("choice");
  const apply = policy(topo, "apply", { predicateDescription: "승계할 적용 원칙" });
  const decline = policy(topo, "decline");
  writePolicy(ws, apply); writePolicy(ws, decline); makeIntentPending(ws, topo, "선택 기록");
  const cardId = U();
  const view = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => cardId });
  const beforePolicyFiles = fs.readdirSync(path.join(ws, "project-map", "policies")).length;
  const picked = MI.recordPolicyConflictChoice(ws, topo.mapId, { card: view.cards[0], decision: "decline", inheritancePolicyId: apply.policyId });
  ok(picked.ok && picked.record.phase === "chosen", "사용자 선택을 chosen 단계로 기록");
  const rec = picked.record, patch = rec.patchCanonical, newPol = patch.payload.policy;
  ok(fs.existsSync(MI.conflictChoiceFileFor(ws, rec.conflictKey, cardId)), "파일 키=충돌키+cardId 세대로 보존");
  ok(PM.validatePatchV2(patch).length === 0 && PM.opHashOf(patch) === rec.expectedOpHash && patch.patchId === rec.supersedePatchId, "재시작 가능한 정책 교체 전문·내용 지문·ID 선기록");
  ok(patch.authorizationRefs[0].ref === cardId && patch.readSet.policies.frontierHash === view.cards[0].frontierHash, "사용자 카드와 선택 시점 정책 묶음을 patch에 결속");
  ok(newPol.scope === apply.scope && PM.canonicalJsonOf(newPol.predicateExpr) === PM.canonicalJsonOf(apply.predicateExpr) && newPol.chosenMeaning.disposition === "decline", "승계 head의 범위·조건을 복사하고 뜻만 사용자 선택으로 교체");
  ok(newPol.verification.basisFp !== apply.verification.basisFp && newPol.predicateDescription.includes("정책 충돌 선택"), "옛 증명을 복사하지 않고 선택 시점 증명·선택 주석 기록");
  ok(newPol.supersedesPolicyIds.join("|") === [apply.policyId, decline.policyId].sort().join("|"), "충돌 head 전부를 한 번에 교체 대상으로 기록");
  ok(fs.readdirSync(path.join(ws, "project-map", "policies")).length === beforePolicyFiles, "선기록 단계에서는 새 정책 파일 0");
  ok(!fs.existsSync(path.join(MP.dirsFor(ws, topo.mapId).pending, patch.patchId + ".json")), "선기록 단계에서는 정책 pending도 0");
  const reread = MI.readConflictChoices(ws);
  ok(reread.st === "ok" && reread.records.length === 1 && MI.validateConflictChoiceRecord(reread.records[0], MI.conflictChoiceFileFor(ws, rec.conflictKey, cardId)) === null, "재시작 판독 strict 왕복");
  const again = MI.recordPolicyConflictChoice(ws, topo.mapId, { card: view.cards[0], decision: "decline", inheritancePolicyId: apply.policyId });
  ok(again.ok && again.idempotent && fs.readdirSync(MI.intentDirFor(ws)).filter((x) => x.endsWith(".json")).length === 1, "같은 카드 재호출=같은 기록 반환·중복 0");
  const changed = MI.recordPolicyConflictChoice(ws, topo.mapId, { card: view.cards[0], decision: "apply", inheritancePolicyId: apply.policyId });
  ok(!changed.ok && changed.reason === "choice-conflict", "같은 cardId로 다른 뜻 덮어쓰기 거부");
  const secondView = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => U() });
  const concurrent = MI.recordPolicyConflictChoice(ws, topo.mapId, { card: secondView.cards[0], decision: "apply", inheritancePolicyId: decline.policyId });
  ok(!concurrent.ok && concurrent.reason === "choice-in-progress", "미완 선택이 있으면 다른 세대 동시 선택 차단");
  const recordFile = MI.conflictChoiceFileFor(ws, rec.conflictKey, cardId);
  fs.writeFileSync(recordFile, JSON.stringify({ ...rec, phase: "parked", parkedReason: "시험 park" }, null, 1));
  const parkedView = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => U() });
  const parkedRetry = MI.recordPolicyConflictChoice(ws, topo.mapId, { card: parkedView.cards[0], decision: "apply", inheritancePolicyId: decline.policyId });
  ok(!parkedRetry.ok && parkedRetry.reason === "parked-retry-not-available", "parked 뒤 새 세대 자동 생성 금지");
  const explicit = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true, explicitRetry: true });
  ok(explicit.ok && MI.readConflictChoices(ws).records.find((x) => x.cardId === cardId).phase === "done",
    "원래 canonical 선택은 명시 재시도에서만 unpark·적용 완료");
}

console.log("[4] 낡음·손상 차단");
{
  const { ws, topo } = setup("stale");
  const a = policy(topo, "apply"), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "낡은 카드");
  const view = MI.collectPolicyConflictCards(ws, topo.mapId);
  const staleCard = { ...view.cards[0], frontierHash: sha("not-current") };
  const stale = MI.recordPolicyConflictChoice(ws, topo.mapId, { card: staleCard, decision: "apply", inheritancePolicyId: a.policyId });
  ok(!stale.ok && stale.reason === "stale-conflict", "화면 뒤 정책 묶음이 달라진 선택=기록 없이 stale");
  ok(fs.readdirSync(MI.intentDirFor(ws)).filter((x) => x.endsWith(".json")).length === 0, "낡은 선택 거부 시 증명 파일 0");
}
{
  const { ws, topo } = setup("damaged");
  fs.mkdirSync(MI.intentDirFor(ws), { recursive: true });
  fs.writeFileSync(path.join(MI.intentDirFor(ws), sha("conflict") + "-" + U() + ".json"), "{");
  const r = MI.readConflictChoices(ws);
  ok(r.st === "damaged", "손상 선택 레코드=조용히 건너뛰지 않고 서랍 전체 정지");
  ok(MI.collectPolicyConflictCards(ws, topo.mapId).ok, "선택 서랍 손상은 읽기 전용 frontier 카드 계산을 오염시키지 않음");
}

console.log("[5] 선택 재개 — 저장한 정책 전문 그대로 제안·분류·적용");
{
  const { ws, topo } = setup("resume");
  const a = policy(topo, "apply", { predicateDescription: "재개 기반" }), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "재개 대상");
  const cardId = U();
  const card = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => cardId }).cards[0];
  const picked = MI.recordPolicyConflictChoice(ws, topo.mapId, { card, decision: "apply", inheritancePolicyId: a.policyId });
  const step1 = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true, stopAfterPhase: "patch-proposed" });
  const p1 = JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, topo.mapId).pending, picked.record.supersedePatchId + ".json"), "utf8"));
  ok(step1.ok && step1.stopped && p1.lifecycle === "proposed" && PM.opHashOf(p1.patch) === picked.record.expectedOpHash, "chosen 재개=선기록 전문 그대로 정책 pending 제안");
  const step2 = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true, stopAfterPhase: "classified" });
  const p2 = JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, topo.mapId).pending, picked.record.supersedePatchId + ".json"), "utf8"));
  ok(step2.ok && step2.stopped && p2.lifecycle === "classified" && p2.classification === "intent-choice", "제안 뒤 종료 재개=정책 분류까지 전진");
  const done = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true });
  const rr = MI.readConflictChoices(ws).records[0];
  const newPolicy = picked.record.patchCanonical.payload.policy;
  ok(done.ok && rr.phase === "done" && rr.outcome.appliedDecisionId === newPolicy.createdFromDecision, "분류 뒤 재개=정책 적용·선택 레코드 종결");
  ok(fs.existsSync(path.join(ws, "project-map", "policies", newPolicy.policyId + ".json")) && fs.existsSync(path.join(ws, "project-map", "decisions", newPolicy.createdFromDecision + ".json")), "새 정책·사용자 선택 decision 실제 생성");
  ok(MI.collectPolicyConflictCards(ws, topo.mapId).cards.length === 0, "충돌 head 전부 교체 뒤 충돌 카드 자연 소멸");
  const again = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true });
  ok(again.ok && again.idempotent, "완료 선택 재개=재적용 없이 멱등");
}
{
  const { ws, topo } = setup("resume-after-apply");
  const a = policy(topo, "apply"), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "적용 직후 종료");
  const cardId = U();
  const card = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => cardId }).cards[0];
  const picked = MI.recordPolicyConflictChoice(ws, topo.mapId, { card, decision: "decline", inheritancePolicyId: d.policyId });
  MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true, stopAfterPhase: "classified" });
  const applied = MP.applyPatch(ws, topo.mapId, picked.record.supersedePatchId, { preCutover: true, resolutionRef: cardId });
  ok(applied.ok, "전제: 정책 적용 직후 선택 레코드 갱신 전 종료 재현");
  const resumed = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true });
  ok(resumed.ok && MI.readConflictChoices(ws).records[0].phase === "done", "decision+정책 산출물 재판독으로 outcome만 보충(중복 적용 0)");
}
{
  const { ws, topo } = setup("resume-prewal");
  const a = policy(topo, "apply"), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "claim 뒤 종료");
  const cardId = U();
  const card = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => cardId }).cards[0];
  const picked = MI.recordPolicyConflictChoice(ws, topo.mapId, { card, decision: "apply", inheritancePolicyId: a.policyId });
  MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true, stopAfterPhase: "classified" });
  const pf = path.join(MP.dirsFor(ws, topo.mapId).pending, picked.record.supersedePatchId + ".json");
  const pr = JSON.parse(fs.readFileSync(pf, "utf8"));
  pr.lifecycle = "claimed";
  pr.claim = { pid: process.pid, token: "prewal-test", claimedAt: new Date().toISOString(), decisionId: picked.record.patchCanonical.payload.policy.createdFromDecision };
  fs.writeFileSync(pf, JSON.stringify(pr, null, 1));
  const resumed = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true });
  ok(resumed.ok && MI.readConflictChoices(ws).records[0].phase === "done", "claimed+WAL 없음(pre-WAL 종료)=안전 재선점 후 적용 완료");
}

console.log("[6] 재개 직전 낡음 — 고아 정책을 만들지 않고 stale 종결");
{
  const { ws, topo } = setup("resume-stale");
  const a = policy(topo, "apply"), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "재개 전 정책 변화");
  const cardId = U();
  const card = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => cardId }).cards[0];
  const picked = MI.recordPolicyConflictChoice(ws, topo.mapId, { card, decision: "apply", inheritancePolicyId: a.policyId });
  writePolicy(ws, policy(topo, "apply", { opClass: "add_condition" })); // 무관 정책도 frontier 세대를 전진시킨다.
  const stale = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true });
  const rr = MI.readConflictChoices(ws).records[0];
  ok(!stale.ok && rr.phase === "stale", "선택 뒤 frontier 변화=낡은 선택으로 종결");
  ok(!fs.existsSync(path.join(MP.dirsFor(ws, topo.mapId).pending, picked.record.supersedePatchId + ".json")) && !fs.existsSync(path.join(ws, "project-map", "policies", picked.record.patchCanonical.payload.policy.policyId + ".json")), "낡음은 정책 pending·정책 파일 0");
}

console.log("[7] 2트랙 재확인 — 카드 표시 뒤 모드 전환 시 core API 쓰기 0");
{
  const { ws, topo } = setup("mode-switch-record");
  const a = policy(topo, "apply"), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "모드 전환 기록");
  const card = MI.collectPolicyConflictCards(ws, topo.mapId).cards[0];
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "off" }));
  const denied = MI.recordPolicyConflictChoice(ws, topo.mapId, { card, decision: "apply", inheritancePolicyId: a.policyId });
  ok(!denied.ok && denied.reason === "two-track" && !fs.existsSync(MI.intentDirFor(ws)),
    "카드 표시 뒤 2트랙 전환=선택 서랍 생성 0");
}
{
  const { ws, topo } = setup("mode-switch-resume");
  const a = policy(topo, "apply"), d = policy(topo, "decline");
  writePolicy(ws, a); writePolicy(ws, d); makeIntentPending(ws, topo, "모드 전환 재개");
  const cardId = U();
  const card = MI.collectPolicyConflictCards(ws, topo.mapId, { cardIdFor: () => cardId }).cards[0];
  const picked = MI.recordPolicyConflictChoice(ws, topo.mapId, { card, decision: "apply", inheritancePolicyId: a.policyId });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "off" }));
  const denied = MI.resumePolicyConflictChoice(ws, topo.mapId, cardId, { preCutover: true });
  ok(!denied.ok && denied.reason === "two-track"
    && !fs.existsSync(path.join(MP.dirsFor(ws, topo.mapId).pending, picked.record.supersedePatchId + ".json")),
    "선택 선기록 뒤 2트랙 전환=제안·정책 적용 0");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
