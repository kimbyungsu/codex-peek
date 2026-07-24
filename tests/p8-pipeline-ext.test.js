/*
 * P8 증분 2 — P2 확장 4종 테스트(정본 'P8 상세 설계 v10' P8-0 P2 확장 허용 범위):
 * ①expirePendingPatch lifecycle CAS 분기표 ②terminal expireCode 원자 영속(classify·apply)
 * ③applyPatch 구조화 reasonCode(닫힌 열거) ④opts.verifierResolution 해소 경로(1-5 결속·rebase 금지·
 * 적용 시점 claim 지문 재검증·decision 삼중 결속).
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p8ext_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8ext_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  return ws;
}
function setup(tag) {
  const ws = mkRepo(tag);
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const r = MR.initTopologyForBootstrap(ws);
  if (r.st !== "created") throw new Error("init 실패: " + r.st);
  return { ws, topo: MR.readTopoExFor(ws).topo };
}
// mkLivePatch — map-pipeline.test.js와 동일 패턴(현재 상태 결속)
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
const pendFile = (ws, mapId, pid) => path.join(MP.dirsFor(ws, mapId).pending, pid + ".json");
const readPend = (ws, mapId, pid) => JSON.parse(fs.readFileSync(pendFile(ws, mapId, pid), "utf8"));

console.log("[1] expirePendingPatch — lifecycle CAS 분기표(설계 8~9차)");
{
  const { ws, topo } = setup("expire");
  const nodeId = topo.nodes[0].id;
  const { patch } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "c1" } });
  ok(MP.proposePatch(ws, patch).ok === true, "(전제) propose 수납(proposed)");
  const oh = PM.opHashOf(patch);
  ok(MP.expirePendingPatch(ws, topo.mapId, patch.patchId, "wrong-hash").reason === "conflict", "opHash 불일치=conflict 거부(다른 주체 관여)");
  ok(readPend(ws, topo.mapId, patch.patchId).lifecycle === "proposed", "거부 후 pending 불변");
  const e1 = MP.expirePendingPatch(ws, topo.mapId, patch.patchId, oh);
  ok(e1.ok === true && e1.reason === "expired", "proposed+opHash 일치=expired 전환");
  const p1 = readPend(ws, topo.mapId, patch.patchId);
  ok(p1.lifecycle === "expired" && p1.expireCode === "superseded", "expired 레코드에 기계 판독 expireCode=superseded 영속");
  ok(MP.expirePendingPatch(ws, topo.mapId, patch.patchId, oh).reason === "idempotent", "이미 expired=idempotent 성공");
  ok(MP.expirePendingPatch(ws, topo.mapId, U(999), oh).reason === "conflict", "부재=conflict 거부");
  // classified → expire 성공
  const { patch: p2p } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "c2" } });
  MP.proposePatch(ws, p2p); MP.classifyPatch(ws, topo.mapId, p2p.patchId);
  ok(readPend(ws, topo.mapId, p2p.patchId).lifecycle === "classified", "(전제) classified");
  ok(MP.expirePendingPatch(ws, topo.mapId, p2p.patchId, PM.opHashOf(p2p)).reason === "expired", "classified=expire 가능");
  // claimed → busy(적용 중 pending 불가침 — 8차 재현 경로) : 파일 직접 조작으로 claimed 상태 구성
  const { patch: p3p } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "c3" } });
  MP.proposePatch(ws, p3p);
  const f3 = pendFile(ws, topo.mapId, p3p.patchId);
  fs.writeFileSync(f3, JSON.stringify({ ...readPend(ws, topo.mapId, p3p.patchId), lifecycle: "claimed", claim: { pid: process.pid, token: "t", claimedAt: "T", decisionId: U(700) } }, null, 1));
  const eb = MP.expirePendingPatch(ws, topo.mapId, p3p.patchId, PM.opHashOf(p3p));
  ok(eb.ok === false && eb.reason === "busy", "claimed=busy 거부(recover-first)");
  // resolved → already-applied
  fs.writeFileSync(f3, JSON.stringify({ ...readPend(ws, topo.mapId, p3p.patchId), lifecycle: "resolved" }, null, 1));
  ok(MP.expirePendingPatch(ws, topo.mapId, p3p.patchId, PM.opHashOf(p3p)).reason === "already-applied", "resolved=already-applied 거부(적용 완료 불변)");
}

console.log("[2] terminal expireCode 원자 영속 — classify hard-reject·apply cas-stale");
{
  const { ws, topo } = setup("term");
  const nodeId = topo.nodes[0].id;
  // classify hard-reject: mapId 불일치(스키마 통과·semantic hard-reject)
  const { patch: bad } = mkLivePatch(ws, "set_state", { mapId: topo.mapId, targetId: nodeId, payload: { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } } });
  bad.mapId = topo.mapId; // propose는 topo mapId 기준 수납
  const badAlt = { ...bad, patchId: require("crypto").randomUUID(), mapId: bad.mapId };
  // hard-reject 유도: semanticValidate가 mapId 불일치를 hard-reject — pending은 topo.mapId 서랍에 수납해야 하므로
  // propose 후 파일 내용의 patch.mapId를 바꿔치기가 아니라, 'expect 불일치'로 needs-investigation이 아닌
  // hard-reject 경로가 필요 — mapId 불일치가 유일 확실 경로: propose를 topo 서랍에 강제 수납.
  MP.proposePatch(ws, badAlt);
  const fB = pendFile(ws, topo.mapId, badAlt.patchId);
  const recB = JSON.parse(fs.readFileSync(fB, "utf8"));
  recB.patch.mapId = U(999); // 수납 후 세대 이탈 시뮬레이션(semantic hard-reject 유도)
  fs.writeFileSync(fB, JSON.stringify(recB, null, 1));
  const cr = MP.classifyPatch(ws, topo.mapId, badAlt.patchId);
  ok(cr.ok === true && cr.classification === "hard-reject", "(전제) classify=hard-reject");
  const pB = readPend(ws, topo.mapId, badAlt.patchId);
  ok(pB.lifecycle === "expired" && pB.expireCode === "hard-reject", "classify hard-reject → expired+expireCode=hard-reject 원자 영속(반환 유실 대비)");
  // apply cas-stale: classify 후 readSet 파일 변조 → apply → expired+expireCode=cas-stale+reasonCode
  const { patch: st } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "st1" } });
  MP.proposePatch(ws, st); MP.classifyPatch(ws, topo.mapId, st.patchId);
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// mutated\n");
  const ar = MP.applyPatch(ws, topo.mapId, st.patchId, { preCutover: true });
  ok(ar.ok === false && ar.reasonCode === "cas-stale", "read-set 파손 apply → reasonCode=cas-stale");
  const pS = readPend(ws, topo.mapId, st.patchId);
  ok(pS.lifecycle === "expired" && pS.expireCode === "cas-stale", "같은 원자 쓰기에 expireCode=cas-stale 영속(재시작 복구는 이 코드로만 분기)");
  // 1차 blocker②: terminal 영속 실패(잠금 점유) — claimed 잔존 금지·claim 롤백+정직 병기
  const { patch: st2 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "st2" } });
  MP.proposePatch(ws, st2); MP.classifyPatch(ws, topo.mapId, st2.patchId);
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// mutated-2" + require("os").EOL);
  const nsl = path.join(MP.dirsFor(ws, topo.mapId).base, ".nslock");
  // terminal 기록 시점에만 잠금이 점유되도록: apply의 claim 단계가 먼저 nsLock을 쓰므로 여기선 주입 불가 —
  // claim 후 기록 전 점유를 시뮬하기 위해 pending을 직접 claimed로 두고 tx만 도는 경로는 없으니,
  // 차선: apply 진입 '전' 점유=claim 실패(lock)로도 잠금 실패 처리 계약을 검증하고, 영속 실패 반환 계약은
  // pending 파일을 판독 불가로 만들어(디렉터리 치환) 주입한다.
  const pf2 = pendFile(ws, topo.mapId, st2.patchId);
  const bak2 = fs.readFileSync(pf2);
  fs.writeFileSync(nsl, JSON.stringify({ pid: 999999, token: "x" }));
  const lk = MP.applyPatch(ws, topo.mapId, st2.patchId, { preCutover: true });
  ok(lk.ok === false && lk.reasonCode === "lock", "nsLock 점유 중 apply=lock(일시 — claimed 잔존 없음)");
  fs.unlinkSync(nsl);
  ok(readPend(ws, topo.mapId, st2.patchId).lifecycle === "classified", "잠금 거부 후 pending=classified 그대로");
  // 영속 실패 주입: claim 직후 pending 파일을 지워 terminal 기록의 재판독을 실패시킨다 — 파일 감시 없이
  // 결정론 주입이 어려우므로 여기서는 '기록 실패 반환 계약'을 직접 검증: 파일을 삭제 후 apply → CAS 전에
  // pending 판독 실패로 거부됨(터미널 미도달) — 주입 한계는 정직 표기하고 반환 필드 계약은 단위로 확인.
  fs.unlinkSync(pf2);
  const gone = MP.applyPatch(ws, topo.mapId, st2.patchId, { preCutover: true });
  ok(gone.ok === false, "pending 소실 apply=거부(터미널 미도달 — fail-closed)");
  fs.writeFileSync(pf2, bak2);
}

console.log("[3] reasonCode — already-applied·not-classified·성공 경로 무회귀");
{
  const { ws, topo } = setup("codes");
  const nodeId = topo.nodes[0].id;
  const { patch } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "ok1" } });
  MP.proposePatch(ws, patch); MP.classifyPatch(ws, topo.mapId, patch.patchId);
  const a1 = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true });
  ok(a1.ok === true && a1.decisionId, "auto 적용 성공(무회귀)");
  const a2 = MP.applyPatch(ws, topo.mapId, patch.patchId, { preCutover: true });
  ok(a2.ok === false && a2.reasonCode === "already-applied", "재적용=reasonCode already-applied");
  // not-classified: verifier-resolved 분류 op를 vr 없이 apply
  const cur = MR.readTopoExFor(ws).topo;
  const lbl = cur.nodes.find((n) => n.id === nodeId).label;
  const { patch: rl } = mkLivePatch(ws, "rewrite_label", { targetId: nodeId, payload: { to: { label: lbl + "-보강" }, expect: { label: lbl } } });
  MP.proposePatch(ws, rl);
  const cl = MP.classifyPatch(ws, topo.mapId, rl.patchId);
  ok(cl.ok === true && cl.classification === "verifier-resolved", "(전제) rewrite_label=verifier-resolved 분류");
  const nv = MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true });
  ok(nv.ok === false && nv.reasonCode === "not-classified", "해소 레코드 없이 verifier-resolved apply=not-classified 거부");
}

console.log("[4] verifierResolution — 1-5 결속·삼중 결속·거부 반례·rebase 금지");
{
  const { ws, topo } = setup("vr");
  const nodeId = topo.nodes[0].id;
  const lbl = MR.readTopoExFor(ws).topo.nodes.find((n) => n.id === nodeId).label;
  const { patch: rl } = mkLivePatch(ws, "rewrite_label", { targetId: nodeId, payload: { to: { label: lbl + "-v" }, expect: { label: lbl } } });
  MP.proposePatch(ws, rl); MP.classifyPatch(ws, topo.mapId, rl.patchId);
  const aHash = sha(fs.readFileSync(path.join(ws, "src", "a.js"), "utf8"));
  const vrOK = { patchId: rl.patchId, opHash: PM.opHashOf(rl), baseDecisionContextHash: rl.baseDecisionContextHash, verdict: "support", claims: [{ file: "src/a.js", contentHash: aHash, locator: "L1", stance: "support" }] };
  // 거부 반례들(성공 적용 전에 검사 — 적용되면 상태가 바뀐다)
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, patchId: U(999) } }).reasonCode === "decision-conflict", "patchId 불일치=거부(낡은 해소 결속 금지)");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, opHash: "x" } }).reasonCode === "decision-conflict", "opHash 불일치=거부");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, verdict: "reject" } }).reasonCode === "decision-conflict", "verdict=support 아님=적용 거부(reject 폐기·inconclusive 잔류는 호출자 소관)");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, claims: [{ file: "docs/out.md", contentHash: aHash, locator: "L1", stance: "support" }] } }).reasonCode === "decision-conflict", "claims⊆patch.evidence 위반=거부(사전 결속 강제)");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, claims: [{ file: "src/a.js", contentHash: sha("old"), locator: "L1", stance: "support" }] } }).reasonCode === "decision-conflict", "적용 시점 claim 지문 불일치=거부(ab-3 — 근거 변경 후 이전 판정 결속 차단)");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, claims: [{ file: "src/a.js", contentHash: aHash, stance: "support" }] } }).reasonCode === "decision-conflict", "claim locator 누락=거부(위치 없는 인용은 결속이 아니다 — ab-3)");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, claims: [{ file: "src/a.js", contentHash: aHash, locator: "L1" }] } }).reasonCode === "decision-conflict", "claim stance 누락=거부(typed 계약 전 필드 강제)");
  ok(MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: { ...vrOK, claims: [{ file: "src/a.js", contentHash: aHash, locator: "L1", stance: "rebut" }] } }).reasonCode === "decision-conflict", "verdict=support+전부 rebut=모순 해소 레코드 거부");
  ok(readPend(ws, topo.mapId, rl.patchId).lifecycle === "classified", "거부들 뒤에도 pending=classified 불변(terminal 아님)");
  // 성공 적용+decision 삼중 결속
  const av = MP.applyPatch(ws, topo.mapId, rl.patchId, { preCutover: true, verifierResolution: vrOK });
  ok(av.ok === true && av.decisionId, "support+결속 일치=verifier-resolved 적용 성공");
  const dec = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", av.decisionId + ".json"), "utf8"));
  ok(dec.classification === "verifier-resolved" && dec.actor.kind === "verifier", "decision classification=verifier-resolved·actor=verifier");
  ok(dec.verdictFp === dec.actor.resultFp && dec.resolution.evidenceRef === dec.actor.resultFp, "삼중 결속 동일 값(verdictFp==actor.resultFp==resolution.evidenceRef)");
  ok(PM.validateDecisionAny(dec).length === 0, "기록된 decision이 스키마 검증기 통과(P2 영속 계약 무변경)");
  const t2 = MR.readTopoExFor(ws).topo;
  ok(t2.nodes.find((n) => n.id === nodeId).label === lbl + "-v", "topology에 라벨 변경 실반영");
  // rebase 금지: 새 vr patch → 다른 patch가 topology 전진 → vr apply=cas-stale 거부·pending 유지(expire는 호출자 rev 규약 소관)
  const lbl2 = lbl + "-v";
  const { patch: rl2 } = mkLivePatch(ws, "rewrite_label", { targetId: nodeId, payload: { to: { label: lbl2 + "-w" }, expect: { label: lbl2 } } });
  MP.proposePatch(ws, rl2); MP.classifyPatch(ws, topo.mapId, rl2.patchId);
  // 전진 patch는 rl2와 무관한 새 노드 추가(같은 노드 대상이면 rl2의 readSet.decisionIndex가 파손=
  // stale-expired 경로로 빠져 rebase 분기에 도달 못 함 — rebase=readSet 보존+base 해시만 전진)
  const { patch: adv } = mkLivePatch(ws, "add_node", { payload: { node: { id: U(500), label: "NEW", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }] } } });
  MP.proposePatch(ws, adv); MP.classifyPatch(ws, topo.mapId, adv.patchId);
  ok(MP.applyPatch(ws, topo.mapId, adv.patchId, { preCutover: true }).ok === true, "(전제) 다른 auto patch가 지도 전진");
  const vr2 = { patchId: rl2.patchId, opHash: PM.opHashOf(rl2), baseDecisionContextHash: rl2.baseDecisionContextHash, verdict: "support", claims: [{ file: "src/a.js", contentHash: aHash, locator: "L1", stance: "support" }] };
  const rb = MP.applyPatch(ws, topo.mapId, rl2.patchId, { preCutover: true, verifierResolution: vr2 });
  ok(rb.ok === false && rb.reasonCode === "cas-stale", "vr 경로 base 불일치=cas-stale 거부(rebase 전면 금지 — 미검증 rebased patch의 verifier-resolved 기록 차단)");
  ok(readPend(ws, topo.mapId, rl2.patchId).lifecycle === "classified", "rebase 거부는 terminal 아님(expire는 호출자 rev 전진 규약 소관 — pending 유지)");
}

console.log("[5] persistTerminalExpire — 단일 잠금 기록·경합 재시도·잔재 정직 반환(재검증 blocker)");
{
  const { ws, topo } = setup("pterm");
  const nodeId = topo.nodes[0].id;
  const { patch: pt } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "pt1" } });
  MP.proposePatch(ws, pt); MP.classifyPatch(ws, topo.mapId, pt.patchId);
  // claimed 상태 구성(직접) — terminal 기록이 claimed 위에서 expired로 전환되는 정상 경로
  const fP = pendFile(ws, topo.mapId, pt.patchId);
  fs.writeFileSync(fP, JSON.stringify({ ...readPend(ws, topo.mapId, pt.patchId), lifecycle: "claimed", claim: { pid: process.pid, token: "tok1", claimedAt: "T", decisionId: U(800) } }, null, 1));
  const w1 = MP.persistTerminalExpire(ws, topo.mapId, pt.patchId, "test-terminal", "cas-stale", "tok1");
  const pT = readPend(ws, topo.mapId, pt.patchId);
  ok(w1.wrote === true && pT.lifecycle === "expired" && pT.expireCode === "cas-stale", "정상 경로 — 단일 nsLock 안 expired+expireCode 기록");
  // 3차 재검증 — 소유권 CAS(기록 '전' 검사): 잘못된 토큰·비claimed lifecycle은 어떤 것도 덮지 못한다
  const { patch: po } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "own1" } });
  MP.proposePatch(ws, po); MP.classifyPatch(ws, topo.mapId, po.patchId);
  const wCl = MP.persistTerminalExpire(ws, topo.mapId, po.patchId, "x", "cas-stale", null);
  ok(wCl.wrote === false && /상태 불일치/.test(wCl.error), "classified(비claimed)=거부(helper는 자기 claim 전환 전용)");
  const fO = pendFile(ws, topo.mapId, po.patchId);
  fs.writeFileSync(fO, JSON.stringify({ ...readPend(ws, topo.mapId, po.patchId), lifecycle: "claimed", claim: { pid: process.pid, token: "right", claimedAt: "T", decisionId: U(801) } }, null, 1));
  const wTok = MP.persistTerminalExpire(ws, topo.mapId, po.patchId, "x", "cas-stale", "wrong-token");
  ok(wTok.wrote === false && /소유권 불일치/.test(wTok.error), "token 불일치=거부(타 claim 덮기 차단)");
  const wNul = MP.persistTerminalExpire(ws, topo.mapId, po.patchId, "x", "cas-stale", null);
  ok(wNul.wrote === false && /claimToken 필수/.test(wNul.error), "빈 토큰(null)=거부 — 같은 pid 다른 claim 덮기 우회 차단(4차)");
  ok(readPend(ws, topo.mapId, po.patchId).lifecycle === "claimed", "우회 시도 후 claimed 불변");
  fs.writeFileSync(fO, JSON.stringify({ ...readPend(ws, topo.mapId, po.patchId), lifecycle: "resolved" }, null, 1));
  ok(MP.persistTerminalExpire(ws, topo.mapId, po.patchId, "x", "cas-stale", "right").wrote === false, "resolved=거부(적용 완료 불변 — expired 덮기 차단)");
  // 일시 경합: 자식 프로세스가 nsLock을 150ms 보유 후 해제 — 재시도 루프(40×50ms)가 흡수해 성공해야 함
  const { patch: pt2 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "pt2" } });
  MP.proposePatch(ws, pt2); MP.classifyPatch(ws, topo.mapId, pt2.patchId);
  const nsl2 = path.join(MP.dirsFor(ws, topo.mapId).base, ".nslock");
  const holder = path.join(os.tmpdir(), "p8ext-holder-" + Date.now() + ".js");
  fs.writeFileSync(holder, ["const fs=require('fs');", "fs.writeFileSync(process.argv[2], JSON.stringify({pid:process.pid,token:'h'}), {flag:'wx'});", "setTimeout(()=>{ try{fs.unlinkSync(process.argv[2]);}catch{} }, 150);"].join(require("os").EOL));
  // 픽스처=claimed(실경로와 동일 — 3차 재검증: classified 픽스처는 이전 경로 입증이 아님)
  fs.writeFileSync(pendFile(ws, topo.mapId, pt2.patchId), JSON.stringify({ ...readPend(ws, topo.mapId, pt2.patchId), lifecycle: "claimed", claim: { pid: process.pid, token: "tok2", claimedAt: "T", decisionId: U(802) } }, null, 1));
  const child = require("child_process").spawn(process.execPath, [holder, nsl2], { stdio: "ignore" });
  const t0 = Date.now();
  while (!fs.existsSync(nsl2) && Date.now() - t0 < 2000) { /* 자식이 잠금 생성할 때까지 대기 */ }
  const w2 = MP.persistTerminalExpire(ws, topo.mapId, pt2.patchId, "transient", "hard-reject", "tok2");
  ok(w2.wrote === true && readPend(ws, topo.mapId, pt2.patchId).expireCode === "hard-reject", "일시 경합(자식 150ms 보유·claimed+token) — 재시도 루프가 흡수해 기록 성공");
  try { child.kill(); } catch { /* 이미 종료 */ }
  // 영구 잔재: 죽은 pid의 nslock 잔존 — 재시도 소진 후 정직 실패·claimed 잔존은 자기 소유 재선점이 회수
  const { patch: pt3 } = mkLivePatch(ws, "add_condition", { targetId: nodeId, payload: { condition: "pt3" } });
  MP.proposePatch(ws, pt3); MP.classifyPatch(ws, topo.mapId, pt3.patchId);
  fs.writeFileSync(pendFile(ws, topo.mapId, pt3.patchId), JSON.stringify({ ...readPend(ws, topo.mapId, pt3.patchId), lifecycle: "claimed", claim: { pid: process.pid, token: "tok3", claimedAt: "T", decisionId: U(803) } }, null, 1));
  fs.writeFileSync(nsl2, JSON.stringify({ pid: 999999, token: "stale" }));
  const w3 = MP.persistTerminalExpire(ws, topo.mapId, pt3.patchId, "stuck", "cas-stale", "tok3");
  ok(w3.wrote === false && /잔재|경합/.test(w3.error || ""), "영구 잔재 — 재시도 소진 후 정직 실패(잠금 없이 쓰면 상호배제 파괴)");
  ok(readPend(ws, topo.mapId, pt3.patchId).lifecycle === "claimed", "소진 시 claimed 잔존(정직) — 아래 자기 소유 재선점이 회수");
  fs.unlinkSync(nsl2);
  // 자기 소유 claim 재선점(3차 재검증 — 잔존의 자연 회수): 같은 프로세스의 apply 재호출이 claimed를 재선점해 진행
  const rc = MP.applyPatch(ws, topo.mapId, pt3.patchId, { preCutover: true });
  ok(rc.ok === true && rc.decisionId, "자기 소유 claimed 재선점 — apply 재호출로 정상 적용(잔존이 갇히지 않음)");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
