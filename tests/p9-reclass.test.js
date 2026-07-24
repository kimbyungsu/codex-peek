/*
 * P9 증분 1 — ⓒ 확정(v12 소규모 개정) 실행 테스트.
 * 계약: ①비정책 의미 op(change_steward/authority)의 기본 분류=verifier-resolved(카드 폐지 — 검증 담당 판정)
 * ②정책 op 3종=intent-choice 유지(사용자 선택 전용 — ab-3 불가침) ③기존 '비정책 intent-choice' pending은
 * 스윕이 재분류로 전환(classified만·claimed/종결/정책 op=불가침) ④실행기 배선(소스 계약).
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p9rc_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
const MP = require(path.join(ROOT, "bridge", "map-pipeline.js"));
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p9rc_ws_"));
fs.mkdirSync(path.join(ws, "src"), { recursive: true });
fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
const r0 = MR.initTopologyForBootstrap(ws);
if (r0.st !== "created") { console.error("init 실패:", r0.st); process.exit(1); }
const topo0 = MR.readTopoExFor(ws).topo;
const nodeId = topo0.nodes[0].id;

function mkLivePatch(op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const base = {
    schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
    baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "p9 test", evidence: [{ kind: "code", ref: "src/a.js" }],
    ...fields,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  base.readSet = MP.buildReadSetFor(topo, base, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
  return { patch: base, topo };
}

console.log("[1] 기본 분류 개정 — 비정책 의미 op=verifier-resolved(ⓒ)·정책 op=intent-choice 유지");
{
  ok(MP.DEFAULT_CLASSIFICATION.change_steward === "verifier-resolved" && MP.DEFAULT_CLASSIFICATION.change_authority === "verifier-resolved", "change_steward/authority 기본 분류=verifier-resolved(카드 폐지)");
  ok(MP.DEFAULT_CLASSIFICATION.create_intent_policy === "intent-choice" && MP.DEFAULT_CLASSIFICATION.supersede_intent_policy === "intent-choice" && MP.DEFAULT_CLASSIFICATION.revoke_intent_policy === "intent-choice", "정책 op 3종=intent-choice 유지(사용자 선택 전용)");
  // 실경로: 신규 change_steward 제안→분류 실행
  const { patch } = mkLivePatch("change_steward", { targetId: nodeId, payload: { to: "정산팀", expect: "" } });
  const pr = MP.proposePatch(ws, patch);
  ok(pr.ok, "(전제) 제안 저장");
  const cf = MP.classifyPatch(ws, patch.mapId, patch.patchId);
  ok(cf.ok && cf.classification === "verifier-resolved", "신규 담당 변경 제안=verifier-resolved 분류 실측(검증 담당 판정 경로)");
}

console.log("[2] 전환 스윕 — 구형 '비정책 intent-choice' pending 재분류·불가침 3종");
{
  // 구형 상태 재현: change_authority pending을 만들고 파일을 직접 구 분류(intent-choice)로 되돌림
  const { patch } = mkLivePatch("change_authority", { targetId: nodeId, payload: { to: ["gate"], expect: (MR.readTopoExFor(ws).topo.nodes.find((n) => n.id === nodeId) || {}).authority || [] } });
  const pr2 = MP.proposePatch(ws, patch);
  ok(pr2.ok, "(전제) 제안 저장(" + (pr2.error || "ok") + ")");
  const cf2 = MP.classifyPatch(ws, patch.mapId, patch.patchId);
  ok(cf2.ok && cf2.classification === "verifier-resolved", "(전제) 신 기본 분류=verifier-resolved");
  const pf = path.join(MP.dirsFor(ws, patch.mapId).pending, patch.patchId + ".json"); // pending=하네스 로컬 파이프라인 서랍(dirsFor 정본)
  const rec = JSON.parse(fs.readFileSync(pf, "utf8"));
  ok(rec.lifecycle === "classified", "(전제) classified 상태");
  rec.classification = "intent-choice"; // 개정 전 기본 분류로 저장된 구형 pending 재현
  fs.writeFileSync(pf, JSON.stringify(rec, null, 1));
  // 정책 op pending(불가침 대조군)
  const pPolWs9 = null; // (같은 ws)
  const polId = require("crypto").randomUUID();
  const topoNow9 = MR.readTopoExFor(ws).topo;
  const pol9 = { policyId: polId, mapId: patch.mapId, scope: "project", predicateExpr: { version: 1, kind: "op-class", opClass: "merge" }, predicateDescription: "병합 원칙", chosenMeaning: "별개 유지", createdFromDecision: require("crypto").randomUUID(), verification: { kind: "historyless", basisFp: PM.mapHashOf(topoNow9), inventoryFp: sha("inv") }, active: true };
  const { patch: pPol } = mkLivePatch("create_intent_policy", { payload: { policy: pol9 }, evidence: undefined, authorizationRefs: [{ kind: "user-choice", ref: "card-x" }] });
  const prPol = MP.proposePatch(ws, pPol);
  ok(prPol.ok, "(전제) 정책 제안 저장(" + (prPol.error || "ok") + ")");
  MP.classifyPatch(ws, pPol.mapId, pPol.patchId);
  const sw = MP.sweepReclassifyNonPolicyIntentChoice(ws, patch.mapId);
  ok(sw.scanned === 1 && sw.reclassified === 1 && Array.isArray(sw.resolveIds) && sw.resolveIds.includes(patch.patchId), `스윕=비정책 1건 재분류+재소비 목록 반환(scanned ${sw.scanned}·reclassified ${sw.reclassified})`);
  const after = JSON.parse(fs.readFileSync(pf, "utf8"));
  ok(after.classification === "verifier-resolved" && after.lifecycle === "classified" && after.legacyReclass === true, "구형 pending=verifier-resolved 전환+legacyReclass 표지(미해소 잔류도 다음 실행 재소비)");
  const polF = path.join(MP.dirsFor(pPolWs9 || ws, pPol.mapId).pending, pPol.patchId + ".json");
  const polRec = JSON.parse(fs.readFileSync(polF, "utf8"));
  ok(polRec.classification === "intent-choice", "정책 op pending=스윕 불가침(intent-choice 유지 — 사용자 승인 증명 보호)");
  // 재실행=멱등(전환 대상 0)
  const sw2 = MP.sweepReclassifyNonPolicyIntentChoice(ws, patch.mapId);
  ok(sw2.scanned === 0 && sw2.reclassified === 0 && sw2.resolveIds.includes(patch.patchId), "스윕 재실행=재분류 0이지만 미해소 표지 유물은 재소비 목록 유지(영구 잔존 차단)");
}

console.log("[2b] e2e — 구형 pending이 runEnrich 1회로 실제 해소·적용·종결(재재검증 blocker① 인수조건)");
{
  const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
  const MB = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
  const ME = require(path.join(ROOT, "bridge", "map-enrich.js"));
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "p9rc_e2e_"));
  fs.mkdirSync(path.join(ws2, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws2, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws2, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws2, "test");
  const rI = MR.initTopologyForBootstrap(ws2);
  ok(rI.st === "created", "(전제) 지도 생성");
  const topo2 = MR.readTopoExFor(ws2).topo;
  const nid2 = topo2.nodes[0].id;
  ok(MB.ensureQueue(ws2, PM) === true, "(전제) 큐 생성");
  // 구형 유물 재현: change_steward pending을 intent-choice로 저장(어느 job cursor에도 결속 안 된 상태)
  const mk2 = (op, fields) => {
    const topo = MR.readTopoExFor(ws2).topo;
    const idx = MP.decisionIndexFor(ws2, topo.mapId);
    const pol = MP.policyStateFor(ws2, topo.mapId);
    const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
    const b = { schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId, basis: MP.patchBasisFor(ws2, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "legacy", evidence: [{ kind: "code", ref: "src/a.js" }], ...fields };
    b.readSet = MP.buildReadSetFor(topo, b, { idx, pol, repoRoot: ws2, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws2, ref), "utf8")); } catch { return null; } } });
    return b;
  };
  const legacy = mk2("change_steward", { targetId: nid2, payload: { to: "정산팀", expect: "" } });
  MP.proposePatch(ws2, legacy);
  MP.classifyPatch(ws2, legacy.mapId, legacy.patchId);
  const lf = path.join(MP.dirsFor(ws2, legacy.mapId).pending, legacy.patchId + ".json");
  const lrec = JSON.parse(fs.readFileSync(lf, "utf8"));
  lrec.classification = "intent-choice";
  fs.writeFileSync(lf, JSON.stringify(lrec, null, 1));
  // runEnrich 1회 — 가짜 askVerifier(support)·가짜 self 어댑터(항목 0=본 job은 무일거리)
  let vCalls = 0;
  const askV = (req) => { vCalls++; return { verdict: "support", claims: [{ file: "src/a.js", contentHash: sha("// a\n"), locator: "L1", stance: "support" }] }; };
  const emptyAdapter = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } });
  const r2b = ME.runEnrich(ws2, { ws: ws2, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: emptyAdapter }, askVerifier: askV, trigger: "test" });
  ok(vCalls === 1, "유물 해소=verifier 호출 정확 1회(vCalls " + vCalls + ")");
  const lAfter = JSON.parse(fs.readFileSync(lf, "utf8"));
  ok(lAfter.lifecycle === "resolved", "유물 pending=resolved 종결(영구 잔존 소멸 — 실적용 증거)");
  const decDir = path.join(ws2, "project-map", "decisions");
  const decs = fs.readdirSync(decDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(decDir, f), "utf8")));
  const dec = decs.find((d) => d.patchId === legacy.patchId);
  ok(!!dec && dec.classification === "verifier-resolved" && dec.actor && dec.actor.kind === "verifier", "decision 정식 기록(verifier 해소 — P2 계약 그대로)");
  const tAfter = MR.readTopoExFor(ws2).topo;
  ok((tAfter.nodes.find((n) => n.id === nid2) || {}).steward === "정산팀", "topology 실반영(담당 변경 적용)");
  // reject 유물: 폐기 종결
  const legacy2 = mk2("change_steward", { targetId: nid2, payload: { to: "결제팀", expect: "정산팀" } });
  MP.proposePatch(ws2, legacy2);
  MP.classifyPatch(ws2, legacy2.mapId, legacy2.patchId);
  const lf2 = path.join(MP.dirsFor(ws2, legacy2.mapId).pending, legacy2.patchId + ".json");
  const lrec2 = JSON.parse(fs.readFileSync(lf2, "utf8"));
  lrec2.classification = "intent-choice";
  fs.writeFileSync(lf2, JSON.stringify(lrec2, null, 1));
  const askR = () => ({ verdict: "reject", claims: [] });
  const MBx = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
  ok(MBx.ensureQueue(ws2, PM) === true, "(전제) 첫 적용으로 지도가 바뀌어 큐 재생성(mapHash 재결속)");
  ME.runEnrich(ws2, { ws: ws2, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: emptyAdapter }, askVerifier: askR, trigger: "test" });
  const lAfter2 = JSON.parse(fs.readFileSync(lf2, "utf8"));
  ok(lAfter2.lifecycle === "expired", "reject 유물=expired 폐기 종결");
  // f-4b69df7e 반례: 같은 기준선의 복수 support 유물 — 첫 적용이 기준선을 전진시켜도 나머지가 재기반으로 수렴
  const wsm = fs.mkdtempSync(path.join(os.tmpdir(), "p9rc_multi_"));
  fs.mkdirSync(path.join(wsm, "src"), { recursive: true });
  fs.writeFileSync(path.join(wsm, "src", "a.js"), "// a" + String.fromCharCode(10));
  fs.writeFileSync(CL.contractFileFor(wsm, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(wsm, "test");
  ok(MR.initTopologyForBootstrap(wsm).st === "created", "(전제) 지도 생성");
  const topoM = MR.readTopoExFor(wsm).topo;
  const nA = topoM.nodes[0].id; // 같은 노드에 서로 다른 두 변경(담당·권위) — 첫 적용이 기준선을 전진시켜 둘째=cas-stale 재현
  ok(MB.ensureQueue(wsm, PM) === true, "(전제) 큐 생성");
  const mkm = (op9, target, payload9) => {
    const topo = MR.readTopoExFor(wsm).topo;
    const idx = MP.decisionIndexFor(wsm, topo.mapId);
    const pol = MP.policyStateFor(wsm, topo.mapId);
    const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
    const b = { schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId, basis: MP.patchBasisFor(wsm, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: op9, targetId: target, payload: payload9, readSet: {}, rationale: "legacy", evidence: [{ kind: "code", ref: "src/a.js" }] };
    b.readSet = MP.buildReadSetFor(topo, b, { idx, pol, repoRoot: wsm, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(wsm, ref), "utf8")); } catch { return null; } } });
    return b;
  };
  const authNow9 = (topoM.nodes[0].roles || []);
  const g1 = mkm("change_steward", nA, { to: "정산팀", expect: "" }), g2 = mkm("change_authority", nA, { to: ["gate"], expect: authNow9 }); // 같은 기준선·같은 노드(첫 적용 후 둘째=cas-stale 재현)
  for (const g of [g1, g2]) {
    MP.proposePatch(wsm, g); MP.classifyPatch(wsm, g.mapId, g.patchId);
    const f9 = path.join(MP.dirsFor(wsm, g.mapId).pending, g.patchId + ".json");
    const r9 = JSON.parse(fs.readFileSync(f9, "utf8")); r9.classification = "intent-choice"; fs.writeFileSync(f9, JSON.stringify(r9, null, 1));
  }
  let vN = 0;
  const askedIds = new Set(); // B1(ab-3): 검증 요청된 patchId 전수 — 결정 patchId와 결속 검사
  const askM = (req) => { vN++; askedIds.add(req.patch.patchId); return { verdict: "support", claims: [{ file: "src/a.js", contentHash: sha("// a" + String.fromCharCode(10)), locator: "L1", stance: "support" }] }; };
  ME.runEnrich(wsm, { ws: wsm, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: emptyAdapter }, askVerifier: askM, trigger: "test" });
  const tM = MR.readTopoExFor(wsm).topo;
  const nAft = tM.nodes.find((n) => n.id === nA) || {};
  ok(nAft.steward === "정산팀" && JSON.stringify(nAft.roles) === JSON.stringify(["gate"]), "복수 유물=한 실행에서 둘 다 적용(적용 필드=roles·둘째는 cas-stale→재기반 재제안으로 수렴 — 영구 잔존 차단)");
  const pend9 = fs.readdirSync(MP.dirsFor(wsm, tM.mapId).pending).map((f) => JSON.parse(fs.readFileSync(path.join(MP.dirsFor(wsm, tM.mapId).pending, f), "utf8")));
  ok(!pend9.some((r) => r.lifecycle === "classified" && r.legacyReclass), "유물 잔류 0(전부 종결 — resolved/expired)");
  // 재재재검증 B1(ab-3): verifier 결정의 patchId는 전부 '검증 요청된 patchId'여야 — 재기반 신본도 재호출 필수
  {
    const decD = path.join(wsm, "project-map", "decisions");
    const decs9 = fs.readdirSync(decD).map((f) => JSON.parse(fs.readFileSync(path.join(decD, f), "utf8"))).filter((d) => d.actor && d.actor.kind === "verifier");
    ok(decs9.length >= 2 && decs9.every((d) => askedIds.has(d.patchId)), "verifier 결정 " + decs9.length + "건 전부 검증 요청된 patchId(재기반 신본=재호출 — 보지 않은 patch에 결정 기록 0)");
    ok(vN === 2, "호출=적용 대상당 정확 1회(둘째는 stale 예측으로 신본에만 — 구본·신본 이중 호출 없음·" + vN + "회)");
  }
}

console.log("[2c] 재재재검증 B2 — 재제안·표지 실패 시 구 유물 보존·rebasedFrom 매핑");
{
  // 표지 기록(markLegacyReclassMark)은 nsLock 선점 시 실패=ok:false·파일 무변(오류 삼킴 금지)
  const wsc = fs.mkdtempSync(path.join(os.tmpdir(), "p9rc_c_"));
  fs.mkdirSync(path.join(wsc, "src"), { recursive: true });
  fs.writeFileSync(path.join(wsc, "src", "a.js"), "// a" + String.fromCharCode(10));
  ok(MR.initTopologyForBootstrap(wsc).st === "created", "(전제) 지도 생성");
  const topoC = MR.readTopoExFor(wsc).topo;
  const mkc = () => {
    const topo = MR.readTopoExFor(wsc).topo;
    const idx = MP.decisionIndexFor(wsc, topo.mapId);
    const pol = MP.policyStateFor(wsc, topo.mapId);
    const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
    const b = { schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId, basis: MP.patchBasisFor(wsc, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: "change_steward", targetId: topoC.nodes[0].id, payload: { to: "정산팀", expect: "" }, readSet: {}, rationale: "legacy", evidence: [{ kind: "code", ref: "src/a.js" }] };
    b.readSet = MP.buildReadSetFor(topo, b, { idx, pol, repoRoot: wsc, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(wsc, ref), "utf8")); } catch { return null; } } });
    return b;
  };
  const c1 = mkc();
  MP.proposePatch(wsc, c1); MP.classifyPatch(wsc, c1.mapId, c1.patchId);
  const lockF = path.join(MP.dirsFor(wsc, c1.mapId).base, ".nslock");
  fs.writeFileSync(lockF, JSON.stringify({ pid: 999999, token: "t" }), { flag: "wx" });
  const mk1 = MP.markLegacyReclassMark(wsc, c1.mapId, c1.patchId, null);
  ok(mk1.ok === false, "잠금 경합=표지 기록 정직 실패(오류 삼킴 금지)");
  const c1f = path.join(MP.dirsFor(wsc, c1.mapId).pending, c1.patchId + ".json");
  ok(!JSON.parse(fs.readFileSync(c1f, "utf8")).legacyReclass, "실패 시 파일 무변(구 유물 보존 — 유실 0)");
  fs.rmSync(lockF, { force: true });
  ok(MP.markLegacyReclassMark(wsc, c1.mapId, c1.patchId, "f-old-1").ok === true, "잠금 해제 후=표지+rebasedFrom 기록 성공");
  // rebasedFrom 매핑: 신본이 구를 가리키면 스윕이 구를 재소비에서 제외+만료 재시도
  const c2 = mkc(); // '구 유물' 역할
  MP.proposePatch(wsc, c2); MP.classifyPatch(wsc, c2.mapId, c2.patchId);
  const c2f = path.join(MP.dirsFor(wsc, c2.mapId).pending, c2.patchId + ".json");
  const c2r = JSON.parse(fs.readFileSync(c2f, "utf8")); c2r.classification = "verifier-resolved"; c2r.legacyReclass = true; fs.writeFileSync(c2f, JSON.stringify(c2r, null, 1));
  const c1r = JSON.parse(fs.readFileSync(c1f, "utf8")); c1r.rebasedFrom = c2.patchId; fs.writeFileSync(c1f, JSON.stringify(c1r, null, 1)); // 신본(c1)이 구(c2)를 가리킴
  const swc = MP.sweepReclassifyNonPolicyIntentChoice(wsc, c1.mapId);
  ok(!swc.resolveIds.includes(c2.patchId) && swc.resolveIds.includes(c1.patchId), "신본 존재=구 유물 재소비 제외(중복 재기반 차단)·신본은 재소비 유지");
  ok(JSON.parse(fs.readFileSync(c2f, "utf8")).lifecycle === "expired", "구 유물=스윕이 만료 재시도로 정리(expire 실패 잔존 회수)");
  // 실행기 순서 계약(소스): 신본 제안·표지 성공 '후' 구 expire — 제안 실패=구 무변
  const me2 = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  ok(me2.includes("pr9.patch.baseDecisionContextHash !== curDch9") && me2.indexOf("rebaseLegacyPatch(repo, MP, PM, pr9.patch, pid9)") < me2.indexOf("expirePendingPatch(repo, topo.mapId, pid9"), "stale 예측=apply 전 검사(낡은 유물에 apply 금지 — cas-stale 조기 만료 차단)+신본 선행→구 만료 순서");
  ok(me2.includes("markLegacyReclassMark(repo, topo.mapId, np.patchId, oldPid") && me2.includes("o.askVerifier({ repo, ws: o.ws, patch: target9.patch"), "재기반=원자 표지+호출은 '적용할 그 patch'에만(구 verdict 재사용 0 — ab-3)");
  // 실행 반례(f-253b9008 재현 절차): 유물 2건 — 첫 적용 후 둘째의 재기반(propose)이 잠금 경합으로 실패해도
  // 구 pending은 classified+표지로 보존(수정 전=apply cas-stale이 구를 먼저 만료해 소실)·잠금 해제 후 수렴.
  {
    const CLx = require(path.join(ROOT, "bridge", "contract-lib.js"));
    const MBx = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
    const MEx = require(path.join(ROOT, "bridge", "map-enrich.js"));
    const wsl = fs.mkdtempSync(path.join(os.tmpdir(), "p9rc_lock_"));
    fs.mkdirSync(path.join(wsl, "src"), { recursive: true });
    fs.writeFileSync(path.join(wsl, "src", "a.js"), "// a" + String.fromCharCode(10));
    fs.writeFileSync(CLx.contractFileFor(wsl, "ko"), JSON.stringify({ scoutMode: "on" }));
    MBx.grantConsent(wsl, "test");
    ok(MR.initTopologyForBootstrap(wsl).st === "created", "(전제) 지도 생성");
    const topoL = MR.readTopoExFor(wsl).topo;
    const nL = topoL.nodes[0].id;
    ok(MBx.ensureQueue(wsl, PM) === true, "(전제) 큐 생성");
    const mkl = (op9, payload9) => {
      const topo = MR.readTopoExFor(wsl).topo;
      const idx = MP.decisionIndexFor(wsl, topo.mapId);
      const pol = MP.policyStateFor(wsl, topo.mapId);
      const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
      const b = { schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId, basis: MP.patchBasisFor(wsl, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: op9, targetId: nL, payload: payload9, readSet: {}, rationale: "legacy", evidence: [{ kind: "code", ref: "src/a.js" }] };
      b.readSet = MP.buildReadSetFor(topo, b, { idx, pol, repoRoot: wsl, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(wsl, ref), "utf8")); } catch { return null; } } });
      return b;
    };
    const l1 = mkl("change_steward", { to: "정산팀", expect: "" });
    const l2 = mkl("change_authority", { to: ["gate"], expect: (topoL.nodes[0].roles || []) }); // 같은(첫 실행 전) 기준선으로 생성
    for (const g of [l1, l2]) { MP.proposePatch(wsl, g); MP.classifyPatch(wsl, g.mapId, g.patchId); }
    // l1만 구형(intent-choice)으로 — 첫 실행은 l1만 소비(l2는 표지 없는 verifier-resolved=스윕 불침)
    { const f9 = path.join(MP.dirsFor(wsl, l1.mapId).pending, l1.patchId + ".json"); const r9 = JSON.parse(fs.readFileSync(f9, "utf8")); r9.classification = "intent-choice"; fs.writeFileSync(f9, JSON.stringify(r9, null, 1)); }
    const lockL = path.join(MP.dirsFor(wsl, topoL.mapId).base, ".nslock");
    let calls = 0;
    const askL = (req) => { calls++; if (calls === 1) { /* 첫 유물 판정 직후 잠금 선점 — 첫 apply는 위 판정 이후라... apply도 nsLock 필요 */ } return { verdict: "support", claims: [{ file: "src/a.js", contentHash: sha("// a" + String.fromCharCode(10)), locator: "L1", stance: "support" }] }; };
    // 첫 실행: 정상 — 첫 유물 적용·둘째는 stale 예측→재기반 '전에' 잠금을 선점해야 함. 콜백 훅이 apply 이전이라
    // 결정론 주입이 어려우므로, 둘째 유물만 남긴 상태를 직접 구성: 첫 유물을 정상 수렴시킨 뒤(기준선 전진),
    // 잠금 선점 상태에서 재실행 — 둘째의 rebase(propose)가 잠금 실패=구 보존 실측.
    const r1 = MEx.runEnrich(wsl, { ws: wsl, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } }) }, askVerifier: askL, trigger: "test" });
    void r1;
    const l2f = path.join(MP.dirsFor(wsl, topoL.mapId).pending, l2.patchId + ".json");
    // 첫 실행 후(기준선 전진됨) l2를 구형으로 주입 — 이제 l2의 base는 낡음(stale 예측 참)
    { const r9 = JSON.parse(fs.readFileSync(l2f, "utf8")); ok(r9.lifecycle === "classified", "(전제) l2 미소비 잔존"); r9.classification = "intent-choice"; fs.writeFileSync(l2f, JSON.stringify(r9, null, 1)); }
    fs.writeFileSync(lockL, JSON.stringify({ pid: 999999, token: "t" }), { flag: "wx" }); // 재기반(propose)의 잠금 실패 주입
    ok(MBx.ensureQueue(wsl, PM) === true, "(전제) 큐 재생성");
    MEx.runEnrich(wsl, { ws: wsl, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } }) }, askVerifier: askL, trigger: "test" });
    const st2 = JSON.parse(fs.readFileSync(l2f, "utf8"));
    ok(st2.lifecycle === "classified", "잠금 경합 중=구 pending 보존(classified — 전환·재기반 어느 단계가 막혀도 소실 0. 수정 전=apply cas-stale 조기 만료로 expired 소실·" + st2.classification + (st2.legacyReclass ? "+표지" : "") + ")");
    fs.rmSync(lockL, { force: true });
    ok(MBx.ensureQueue(wsl, PM) === true, "(전제) 큐 재생성 2");
    MEx.runEnrich(wsl, { ws: wsl, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } }) }, askVerifier: askL, trigger: "test" });
    const tL = MR.readTopoExFor(wsl).topo;
    const nAftL = tL.nodes.find((n) => n.id === nL) || {};
    ok(nAftL.steward === "정산팀" && JSON.stringify(nAftL.roles) === JSON.stringify(["gate"]), "잠금 해제 후 재실행=양건 수렴(내구 재소비 실증)");
    // 최종 창(판독-적용 사이 외부 전이): verifier 대기 중 다른 유효 patch가 적용돼 대상이 cas-stale로 '만료'되고
    // 직후 잠금으로 재기반도 실패 — 만료 원본+표지가 다음 실행 스윕에 재소비돼 수렴(소실 0)해야 한다.
    const l3 = mkl("change_steward", { to: "결제팀", expect: "정산팀" });
    MP.proposePatch(wsl, l3); MP.classifyPatch(wsl, l3.mapId, l3.patchId);
    const l3f = path.join(MP.dirsFor(wsl, topoL.mapId).pending, l3.patchId + ".json");
    { const r9 = JSON.parse(fs.readFileSync(l3f, "utf8")); r9.classification = "intent-choice"; fs.writeFileSync(l3f, JSON.stringify(r9, null, 1)); }
    ok(MBx.ensureQueue(wsl, PM) === true, "(전제) 큐 재생성 3");
    let hooked = false;
    const askHook = (req) => {
      if (!hooked && req.patch.patchId === l3.patchId) { // verifier '대기 중' 외부 전이+잠금 선점 재현
        hooked = true;
        const ext9 = mkl("add_evidence", undefined); // 유효 외부 patch: add_evidence(auto)
        ext9.operation = "add_evidence"; ext9.targetId = nL; ext9.payload = { evidence: { kind: "code", ref: "src/a.js", note: "ext" } };
        ext9.readSet = MP.buildReadSetFor(MR.readTopoExFor(wsl).topo, ext9, { idx: MP.decisionIndexFor(wsl, topoL.mapId), pol: MP.policyStateFor(wsl, topoL.mapId), repoRoot: wsl, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(wsl, ref), "utf8")); } catch { return null; } } });
        MP.proposePatch(wsl, ext9); MP.classifyPatch(wsl, ext9.mapId, ext9.patchId);
        MP.applyPatch(wsl, topoL.mapId, ext9.patchId, { preCutover: true }); // 기준선 전진(외부 정상 전이)
        fs.writeFileSync(lockL, JSON.stringify({ pid: 999999, token: "t" }), { flag: "wx" }); // 직후 재기반 실패 주입
      }
      return { verdict: "support", claims: [{ file: "src/a.js", contentHash: sha("// a" + String.fromCharCode(10)), locator: "L1", stance: "support" }] };
    };
    MEx.runEnrich(wsl, { ws: wsl, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } }) }, askVerifier: askHook, trigger: "test" });
    const l3st = JSON.parse(fs.readFileSync(l3f, "utf8"));
    // 관측: 잠금이 P2의 terminal expire '영속'까지 막으면 classified+표지 보존(P2 자기 회수 계약),
    // 영속이 성공했다면 expired+cas-stale+표지 — 어느 경로든 '재소비 가능 상태 보존'(소실 0)이 불변식.
    ok(l3st.legacyReclass === true && (l3st.lifecycle === "classified" || (l3st.lifecycle === "expired" && l3st.expireCode === "cas-stale")), "인터리빙 재현 — 소실 0(보존 경로: " + l3st.lifecycle + (l3st.expireCode ? "/" + l3st.expireCode : "") + "+표지)");
    fs.rmSync(lockL, { force: true });
    ok(MBx.ensureQueue(wsl, PM) === true, "(전제) 큐 재생성 4");
    MEx.runEnrich(wsl, { ws: wsl, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } }) }, askVerifier: askHook, trigger: "test" });
    const tL2 = MR.readTopoExFor(wsl).topo;
    ok((tL2.nodes.find((n) => n.id === nL) || {}).steward === "결제팀", "다음 실행=보존 유물이 재기반 신본으로 회수·적용(소실 0 — f-253b9008 종결)");
    // expired+cas-stale+표지 경로 직접 유닛(P2 영속이 성공한 쪽 창): 파일을 그 상태로 구성→스윕 재소비+실행기 회수
    const l4 = mkl("change_steward", { to: "감사팀", expect: "결제팀" });
    MP.proposePatch(wsl, l4); MP.classifyPatch(wsl, l4.mapId, l4.patchId);
    const l4f = path.join(MP.dirsFor(wsl, topoL.mapId).pending, l4.patchId + ".json");
    { const r9 = JSON.parse(fs.readFileSync(l4f, "utf8")); r9.lifecycle = "expired"; r9.expireCode = "cas-stale"; r9.expireReason = "인터리빙 창 재현"; r9.legacyReclass = true; fs.writeFileSync(l4f, JSON.stringify(r9, null, 1)); }
    const swE = MP.sweepReclassifyNonPolicyIntentChoice(wsl, topoL.mapId);
    ok(swE.resolveIds.includes(l4.patchId), "만료(cas-stale)+표지 유물=스윕 재소비 목록 포함(소실 차단의 스윕 축)");
    ok(MBx.ensureQueue(wsl, PM) === true, "(전제) 큐 재생성 5");
    MEx.runEnrich(wsl, { ws: wsl, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [] } }) }, askVerifier: askHook, trigger: "test" });
    const tL3 = MR.readTopoExFor(wsl).topo;
    ok((tL3.nodes.find((n) => n.id === nL) || {}).steward === "감사팀", "만료 표지 유물=재기반 신본으로 회수·적용(expired 경로 실측)");
    ok(JSON.parse(fs.readFileSync(l4f, "utf8")).lifecycle === "expired", "원본 expired 불변(신본이 계보 승계 — 증명 이력 무변조)");
  }
}

console.log("[3] 배선·문서 — 실행기 스윕 1회·v12 개정 부기");
{
  const me = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  ok(me.includes("sweepReclassifyNonPolicyIntentChoice(repo, topo.mapId)") && me.includes('route: "legacy-reclass"'), "실행기가 시작 시 1회 스윕+구조화 로그(route/reason/outcome — 성공·실패 양쪽)");
  ok(me.includes("o.askVerifier({ repo, ws: o.ws, patch: target9.patch") && me.includes("verifierResolution: { patchId: target9.pid") && me.includes("expirePendingPatch(repo, topo.mapId, target9.pid"), "재결속 소비=P8 해소 경로(support=적용·reject=폐기·inconclusive=표지 잔류 재시도)");
  const doc = fs.readFileSync(path.join(ROOT, "docs", "MAP-V2-DESIGN.md"), "utf8");
  ok(doc.includes("P9 v12 소규모 개정") && doc.includes("intent-choice→**verifier-resolved**"), "정본 개정 부기(ⓒ 반영 3건)");
  ok(doc.includes("정책 op\n   3종(create/supersede/revoke_intent_policy)만 intent-choice 유지") || doc.includes("정책 op") && doc.includes("만 intent-choice 유지"), "정책 op 한정 명문");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
