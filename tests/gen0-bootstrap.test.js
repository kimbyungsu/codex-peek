"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 1] 빈 수칙서(0세대)로 시작 + 첫 도장 — docs/RULE-SUPPLY-REDESIGN-2026-10-04.md §2·§9.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입 — 실행 반례가 1급). 대시보드 카드는 컴파일 산출물(out/extension.js)의
 * readEnvelopeView 를 꺼내 스텁으로 실제 실행한다(소스 문자열 단언은 '반대로 동작하는 구현'을 못 잡는다).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gen0-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const NL = String.fromCharCode(10);
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// 작업공간+대상 저장소 한 쌍(정찰 대상=REPO 결속)
function pair(tag) {
  const ws = mk("gen0-ws-" + tag + "-"), repo = mk("gen0-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo) };
}
const v2 = (rows, verdict) => ["본문", "[지적 목록 v2]", ...rows.map((r) => JSON.stringify(r)), "[지적 목록 끝]", "", "검증: " + verdict].join(NL);

console.log("[1] 0세대 정의 — 지문·판정");
t("GEN0_HASH=작성기와 같은 직렬화로 만든 빈 코어(필수 schema 포함)의 실제 바이트 지문", () => {
  assert.strictEqual(CL.GEN0_TEXT, CL.serializeEnvelopeCore(CL.emptyEnvelopeCore()));
  assert.strictEqual(CL.GEN0_HASH, sha1(Buffer.from(CL.GEN0_TEXT, "utf8")));
  assert.ok(/^[0-9a-f]{40}$/.test(CL.GEN0_HASH), "40자리(동결 판독 형식 통과)");
  const o = JSON.parse(CL.GEN0_TEXT);
  assert.strictEqual(o.schema, "verify-envelope-v1");
  const r = mk("gen0-raw-");
  fs.writeFileSync(path.join(r, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  const ev = CL.readVerifyEnvelope(r);
  assert.ok(ev.st === "ok" && ev.sha1 === CL.GEN0_HASH, "빈 코어를 실제로 저장한 파일의 지문=GEN0_HASH");
});
t("envelopeGenFor — 파일·지문 없음=0세대(virtual) / 승인 전 수기 파일=null / 승인=그 지문 / 계약 손상=null", () => {
  const a = pair("gf");
  const g0 = CL.envelopeGenFor(a.ws);
  assert.ok(g0.gen === CL.GEN0_HASH && g0.virtual === true && g0.st === "gen0", JSON.stringify(g0));
  fs.writeFileSync(path.join(a.repo, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  const gU = CL.envelopeGenFor(a.ws);
  assert.ok(gU.gen === null && gU.st === "unapproved", "파일만 있고 승인 전=0세대 아님(종전 승인 대기 흐름) " + JSON.stringify(gU));
  assert.strictEqual(CL.setEnvelopeHashAllSlots(a.ws, CL.GEN0_HASH), 2);
  const gA = CL.envelopeGenFor(a.ws);
  assert.ok(gA.gen === CL.GEN0_HASH && gA.virtual === false && gA.st === "approved", "빈 코어 정식 승인=같은 지문·virtual 아님");
  const b = pair("gfc");
  fs.writeFileSync(CL.contractFileFor(b.ws, "ko"), "{깨짐");
  assert.strictEqual(CL.envelopeGenFor(b.ws).gen, null, "계약 손상=0세대로 보지 않음(승인 소실 위장 금지)");
});

console.log("[2] 검증 요청 — 0세대 동결·v2 서식");
t("envelopeSliceFor(core) — v2 서식(0세대 변형·범위 확장 줄 없음)·경계 데이터 절 없음·동결=GEN0+virtualGen", () => {
  const a = pair("sl");
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-sl-1";
  const s = CB.envelopeSliceFor(a.ws, "ko", "core", CL.loadContract(a.ws, "ko"));
  assert.strictEqual(s.v2Attached, true, "0세대+core=v2 서식 요구");
  assert.ok(s.v2Static.includes("수칙서 0세대") && !s.v2Static.includes("범위 확장 통로") && !s.v2Static.includes("abId\":\"ab-<n>\" 인용 필수"), "고정 산문=0세대 변형");
  assert.ok(s.envText.includes(s.v2Static) && s.envData === "" && s.baseQual === "" && s.envAxes === null, "승인 경계 데이터·한정 문구 없음");
  const fz = CL.readFrozenEnvelopeRec(a.ws);
  assert.ok(fz && fz.hash === CL.GEN0_HASH && fz.virtualGen === true && fz.askId === "ask-sl-1" && fz.oos === null, "동결=GEN0·virtualGen·제외 칸 없음 " + JSON.stringify(fz));
  const sEn = CB.envelopeSliceFor(a.ws, "en", "core", CL.loadContract(a.ws, "en"));
  assert.ok(sEn.v2Static.includes("rulebook generation 0") && !sEn.v2Static.includes("Scope-expansion"), "en 변형");
  const sI = CB.envelopeSliceFor(a.ws, "ko", "integrity", CL.loadContract(a.ws, "ko"));
  assert.ok(sI.v2Attached === false && sI.envText === "", "integrity=종전 그대로(코어 전용 서식)");
  assert.ok(CL.readFrozenEnvelopeRec(a.ws).virtualGen === true, "integrity 도 0세대 동결(같은 세대 축)");
  // 활성 프로젝트 무회귀 — 승인된 수칙서는 종전 고정 산문·virtualGen 없음
  const b = pair("sla");
  const raw = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: ["s"], alwaysBlocker: ["a"], outOfScope: ["o"] });
  fs.writeFileSync(path.join(b.repo, CL.ENVELOPE_FILE), raw);
  CL.setEnvelopeHashAllSlots(b.ws, sha1(raw));
  const sB = CB.envelopeSliceFor(b.ws, "ko", "core", CL.loadContract(b.ws, "ko"));
  assert.ok(sB.v2Static.includes("검증 경계 활성") && sB.v2Static.includes("범위 확장 통로") && sB.envData.length > 0, "승인 프로젝트=종전 산문");
  const fzB = CL.readFrozenEnvelopeRec(b.ws);
  assert.ok(fzB.hash === sha1(raw) && fzB.virtualGen === false, "승인 동결=virtualGen 아님");
  // 승인 전 수기 파일=0세대 아님(서식 요구·동결 지문 없음 — 종전)
  const c = pair("slu");
  fs.writeFileSync(path.join(c.repo, CL.ENVELOPE_FILE), raw);
  const sC = CB.envelopeSliceFor(c.ws, "ko", "core", CL.loadContract(c.ws, "ko"));
  assert.ok(sC.v2Attached === false && CL.readFrozenEnvelopeRec(c.ws).hash === null, "미승인 파일=종전(v1·동결 null)");
});
t("v2StaticDirective 무회귀 — 인자 없는 호출은 종전 바이트(v2DirectiveFor 와 같은 출처)", () => {
  const before = CB.v2StaticDirective("ko");
  assert.ok(before.startsWith("[지적 서식 v2 — 검증 경계 활성]") && before.includes("[범위 확장 통로]") && before.includes("[MAP 라우팅]"));
  assert.ok(CB.v2StaticDirective("ko", { gen0: true }).includes("[MAP 라우팅]"), "0세대도 지도 라우팅 줄은 유지");
});

console.log("[3] 지적 장부 — 0세대 기록(강등 없음)·관문·해소");
const G = pair("led");
const run = (askId, answer) => { process.env.CODEX_BRIDGE_ASK_JOB_ID = askId; CB.envelopeSliceFor(G.ws, "ko", "core", CL.loadContract(G.ws, "ko")); return CB.machineFindingsLayer(answer, G.ws, "ko", "core", "claude-codex", askId, "no-campaign", G.rk); };
t("1차: v2 blocker 2건=전부 기록·강등 0(입장 심사 미발동)", () => {
  const r = run("ask-g1", v2([{ tag: "blocker", title: "실결함 하나", origin: "baseline" }, { tag: "blocker", title: "실결함 둘", origin: "baseline" }], "실패"));
  assert.ok(r.machine.admission && r.machine.admission.kept === 2 && r.machine.admission.demoted === 0, JSON.stringify(r.machine.admission));
  assert.ok(!r.notice.includes("[경계 세대 변경") && !r.notice.includes("[입장 심사]"), "세대 변경 경고·심사 영수증 없음");
  const op = CL.openFindingsFor(G.ws, "no-campaign", CL.GEN0_HASH);
  assert.strictEqual(op.length, 2, "GEN0 세대 open 2");
});
t("2차: 재지적 인용=occurrence · 후속 신규 blocker=강등 없음(활성 프로젝트라면 late-theory 강등) · 범위확장=보관함(승격 없음)", () => {
  const op1 = CL.openFindingsFor(G.ws, "no-campaign", CL.GEN0_HASH);
  const r = run("ask-g2", v2([{ tag: "blocker", title: "실결함 하나 남음", id: op1[0].id, origin: "baseline" }, { tag: "blocker", title: "새 이론", origin: "baseline" }, { tag: "범위확장", title: "범위 밖 큰 발견", abId: "ab-1" }], "실패"));
  assert.ok(r.machine.admission.kept === 2 && r.machine.admission.demoted === 0, "신규 이론도 유지 " + JSON.stringify(r.machine.admission));
  const rows = CL.readFindingsLedger(G.ws);
  assert.ok(rows.some((x) => x.type === "occurrence" && x.findingId === op1[0].id && x.envelopeHash === CL.GEN0_HASH && x.round === 2), "계보 occurrence 기록(종전 '기록 전용' 갈래엔 없던 것)");
  assert.ok(!rows.some((x) => x.type === "escalation"), "승격 없음(인용할 ab 없음)");
  assert.ok(rows.some((x) => x.type === "finding" && x.titleNorm === CL.normBacklogTitle("범위 밖 큰 발견") && x.tag === "백로그" && x.status === "closed"), "범위확장=보관함 행(조용한 소실 금지)");
  assert.strictEqual(CL.openFindingsFor(G.ws, "no-campaign", CL.GEN0_HASH).length, 3);
});
t("판단 관문 — 0세대 열린 지적도 판단 전 다음 검증 시작 거부", () => {
  const g = CB.findingDispositionGate(G.ws, null, "ko", "no-campaign");
  assert.ok(g.proceed === false && /열린 지적 3건/.test(g.msg), "관문 장전 " + JSON.stringify({ p: g.proceed }));
});
t("3차 통과: 이전 회차 열린 지적=resolved 종결(askId 결속) — 0세대 해소 계보", () => {
  const r = run("ask-g3", v2([], "통과"));
  assert.ok(r.machine.effective === "pass", r.machine.effective);
  const closes = CL.readFindingsLedger(G.ws).filter((x) => x.type === "close" && x.closeReason === "resolved" && x.envelopeHash === CL.GEN0_HASH);
  assert.ok(closes.length === 3 && closes.every((x) => x.askId === "ask-g3"), "resolved 3·askId 결속");
  assert.strictEqual(CL.openFindingsFor(G.ws, "no-campaign", CL.GEN0_HASH).length, 0);
});

console.log("[4] 후보 접수 — 0세대");
let RM = null, UD = null;
t("rule-propose(해소 blocker)·직접 입력 후보=GEN0 세대+virtualGen 으로 접수", () => {
  const f = CL.readFindingsLedger(G.ws).find((x) => x.type === "finding" && x.title === "실결함 둘");
  const r = CL.ruleProposeCandidate(G.ws, G.repo, { findingId: f.findingId, campaignId: "no-campaign", why: "모든 작업에 걸치는 기준이라서" });
  assert.ok(r.ok, JSON.stringify(r));
  RM = r.candidateId;
  const rec = CL.readEnvelopeCandidates(G.ws).latest.get(RM + "@" + CL.GEN0_HASH);
  assert.ok(rec && rec.status === "proposed" && rec.virtualGen === true && rec.repoKey === G.rk);
  const d = CL.directRuleCandidate(G.ws, G.repo, { text: "화면 표시와 실제 연결 상태는 항상 같아야 한다" });
  assert.ok(d.ok, JSON.stringify(d));
  UD = d.candidateId;
  assert.strictEqual(CL.ruleProposeCandidate(G.ws, G.repo, { findingId: f.findingId, campaignId: "no-campaign", why: "모든 작업에 걸치는 기준이라서" }).reason, "duplicate", "같은 세대 중복=거부");
});
t("후보 산출(gen0 옵션)=GEN0 세대 후보 표시 · 옵션 없이(동결 기준)도 0세대 동결이면 같은 세대", () => {
  const c0 = CB.computeEnvelopeCandidatesFor(G.ws, { gen0: true });
  assert.ok(c0.gen === CL.GEN0_HASH && c0.live.some((x) => x.candidateId === RM) && c0.live.some((x) => x.candidateId === UD), JSON.stringify(c0.live.map((x) => x.candidateId)));
  assert.strictEqual(CB.computeEnvelopeCandidatesFor(G.ws).gen, CL.GEN0_HASH, "직전 검증 동결=GEN0");
});
t("reconcile(GEN0) — 0세대에서도 생명주기 정리가 돈다(빈 수칙서가 실물)", () => {
  const r = CL.reconcileMemoryCandidates(G.ws, G.repo, CL.GEN0_HASH);
  assert.ok(r && r.writeFailed === undefined || r.writeFailed === false, JSON.stringify(r));
  assert.strictEqual(CL.readEnvelopeCandidates(G.ws).latest.get(RM + "@" + CL.GEN0_HASH).status, "proposed", "대기 후보 무접촉");
});

console.log("[5] 첫 초안 — 목적지 분기");
t("0세대엔 서고(관련될 때) 초안 거절·빼기 거절·빈 초안은 allowEmpty 만", () => {
  const ra = CL.draftEnvelopeRevision(G.ws, G.repo, { approvedHash: CL.GEN0_HASH, target: "archive", addCandidateIds: [RM] });
  assert.ok(!ra.ok && /첫 수칙서/.test(ra.error), JSON.stringify(ra));
  const re = CL.draftEnvelopeRevision(G.ws, G.repo, { approvedHash: CL.GEN0_HASH, target: "core", addCandidateIds: [] });
  assert.ok(!re.ok, "allowEmpty 없이 빈 초안=거절");
  assert.strictEqual(CL.readEnvelopeProposal(G.ws, G.repo).st, "absent", "거절=제안본 없음");
});
t("draftEnvelopeInitial(항상) — 코어 초안·후보 결속·제안본 결속(baseHash null·candidateGeneration GEN0)", () => {
  const r = CL.draftEnvelopeInitial(G.ws, G.repo, { addCandidateIds: [RM] });
  assert.ok(r.ok && r.initial === true && r.target === "core" && r.adds === 1, JSON.stringify(r));
  const pr = CL.readEnvelopeProposal(G.ws, G.repo);
  assert.ok(pr.st === "ok" && pr.target === "core" && pr.targetBaseHash === null && pr.candidateGeneration === CL.GEN0_HASH && pr.candidateIds.join() === RM, JSON.stringify({ tb: pr.targetBaseHash, cg: pr.candidateGeneration, ids: pr.candidateIds }));
  assert.deepStrictEqual(JSON.parse(pr.proposalText).alwaysBlocker, ["실결함 둘"]);
  assert.strictEqual(CL.readEnvelopeCandidates(G.ws).latest.get(RM + "@" + CL.GEN0_HASH).status, "adopted", "결속=adopted(초안 대기)");
  assert.strictEqual(CL.readEnvelopeCandidates(G.ws).latest.get(UD + "@" + CL.GEN0_HASH).status, "proposed", "서고 쪽 후보는 결속하지 않음");
  const info = CL.gen0OpenFindingsInfo(G.ws, G.repo);
  assert.ok(info && info.open === 0, "열린 지적 0(3차 통과로 해소)");
});

console.log("[6] 대시보드 카드 — 컴파일 산출물 실행");
const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
const b0 = outSrc.indexOf("function readEnvelopeView(ws) {");
const e0 = outSrc.indexOf("\nfunction draftSummaryDetail(", b0);
assert.ok(b0 > 0 && e0 > b0, "readEnvelopeView 추출 경계");
const RV = new Function("path", "fs", "crypto", "require", "BRIDGE_DIR", "loadLangExt", "scoutTargetFor", "tE", outSrc.slice(b0, e0) + "\nreturn readEnvelopeView;");
const viewFor = (p) => RV(path, fs, crypto, require, path.join(ROOT, "bridge"), () => "ko", () => ({ repo: p.repo }), (ko) => ko)(p.ws);
t("0세대+제안본=첫 수칙서 초안 승인 카드(승인·보기·폐기 버튼 · 후보 열람 전용)", () => {
  const v = viewFor(G);
  assert.ok(v && v.gen0 === true && v.proposal === "pending" && v.candsView === "pending-draft" && /첫 수칙서 초안/.test(v.label) && v.btn && v.btn2 && v.btn3, JSON.stringify(v && { l: v.label, p: v.proposal }));
  assert.ok(Array.isArray(v.cands) && v.cands.some((c) => c.id === UD), "남은 후보 열람");
});
t("0세대+후보만=후보 카드(gen=GEN0·wsKey 결속) / 아무것도 없음=카드 없음(종전)", () => {
  const H = pair("card");
  assert.strictEqual(viewFor(H), null, "후보·초안 없음=카드 없음");
  const d = CL.directRuleCandidate(H.ws, H.repo, { text: "사용자 원래 설정은 작업 뒤 반드시 되돌려 둔다" });
  assert.ok(d.ok);
  const v = viewFor(H);
  assert.ok(v && v.gen0 === true && v.gen === CL.GEN0_HASH && v.wsKey === CL.wsKeyFor(H.ws) && v.cands.length === 1 && v.cands[0].id === d.candidateId && v.cands[0].gen === CL.GEN0_HASH && /아직 수칙서가 없어요/.test(v.label) && !v.proposal, JSON.stringify(v && { l: v.label, g: v.gen }));
  fs.writeFileSync(path.join(H.repo, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  const vU = viewFor(H);
  assert.ok(vU && !vU.gen0 && /승인 대기/.test(vU.label), "수기 파일(승인 전)=종전 승인 대기 카드");
});

console.log("[7] 첫 도장 — 세대 전환·이월·두 번째 도장");
let H1 = null;
t("첫 도장(코어 내용 있음) → 파일 생성·계약 지문·결속 후보 applied·서고 쪽 후보는 새 세대 proposed 로 정확히 1회 이월", () => {
  // 0세대 열린 지적 하나를 심어 둔다(같은 캠페인) — 첫 도장 뒤 새 세대 관문에서 빠지고 장부 행은 남는지
  CL.appendFindingsLedger(G.ws, [{ type: "finding", findingId: "f-gen0open", campaignId: "no-campaign", round: 4, tag: "blocker", titleNorm: "남은 문제", title: "남은 문제", envelopeHash: CL.GEN0_HASH, status: "open", ts: "t" }], { repoKey: G.rk });
  const info = CL.gen0OpenFindingsInfo(G.ws, G.repo);
  assert.ok(info.open === 1 && info.unjudged === 1 && info.items[0].id === "f-gen0open", "확인 창 재료=열린 1·미판단 1 " + JSON.stringify(info));
  const before = CL.readFindingsLedger(G.ws).length;
  assert.strictEqual(CB.findingDispositionGate(G.ws, null, "ko", "no-campaign").proceed, false, "첫 도장 전=0세대 미판단 지적이 관문을 막음");
  const tr = CL.applyEnvelopeTransition(G.ws, G.repo, "ko", null);
  assert.ok(tr.ok, JSON.stringify(tr));
  H1 = tr.newHash;
  assert.ok(H1 !== CL.GEN0_HASH && CL.loadContract(G.ws, "ko").envelopeHash === H1 && CL.loadContract(G.ws, "en").envelopeHash === H1, "양 슬롯 지문");
  assert.strictEqual(CL.readVerifyEnvelope(G.repo).sha1, H1, "파일 생성=승인 바이트");
  assert.strictEqual(CL.envelopeTransState(G.ws), "clear", "WAL 정리");
  const lat = CL.readEnvelopeCandidates(G.ws).latest;
  assert.ok(lat.get(RM + "@" + CL.GEN0_HASH).status === "adopted" && lat.get(RM + "@" + CL.GEN0_HASH).applied === H1, "결속 후보=applied 종결");
  assert.ok(lat.get(UD + "@" + H1) && lat.get(UD + "@" + H1).status === "proposed", "서고 쪽 후보=새 세대 proposed(전이 안 이월)");
  assert.ok(!lat.get(RM + "@" + H1), "종결 후보는 이월 안 함");
  assert.strictEqual(CL.readEnvelopeCandidates(G.ws).rows.filter((x) => x.candidateId === UD && x.envelopeHash === H1).length, 1, "이월 정확히 1행");
  CL.reconcileMemoryCandidates(G.ws, G.repo, H1);
  assert.strictEqual(CL.readEnvelopeCandidates(G.ws).rows.filter((x) => x.candidateId === UD && x.envelopeHash === H1).length, 1, "재실행 무중복");
  assert.strictEqual(CL.openFindingsFor(G.ws, "no-campaign", H1).length, 0, "0세대 열린 지적=새 세대 관문에서 빠짐(같은 id 이월 없음)");
  assert.strictEqual(CL.openFindingsFor(G.ws, "no-campaign", CL.GEN0_HASH).length, 1, "0세대 행은 그대로(덧붙이기 전용 이력)");
  assert.strictEqual(CL.readFindingsLedger(G.ws).length, before, "장부 행 삭제·추가 없음");
  assert.strictEqual(CL.envelopeGenFor(G.ws).virtual, false, "이제 정식 승인 세대");
  assert.strictEqual(viewFor(G).gen0, undefined, "카드=종전 활성 카드");
  // [검증 1회차 blocker②] 다음 검증이 새로 동결하기 전에도 관문·지적 판단은 새 세대 — 0세대 열린 지적은 빠진다(직전 동결=0세대 표식)
  assert.strictEqual(CL.readFrozenEnvelopeRec(G.ws).virtualGen, true, "전제: 직전 검증 동결=0세대");
  assert.strictEqual(CB.judgeGenFor(G.ws), H1, "판단 세대=새 승인 지문");
  assert.strictEqual(CB.findingDispositionGate(G.ws, null, "ko", "no-campaign").proceed, true, "첫 도장 뒤 관문=0세대 미판단 지적 제외");
  // [검증 1회차 blocker③] 이월된 후보가 화면에서 바로 이어진다(새 동결 전)
  const vG = viewFor(G);
  assert.ok(vG.cands && vG.cands.some((c) => c.id === UD && c.gen === H1 && (!c.status || c.status === "proposed")), "첫 승인 직후 카드=이월 후보 표시 " + JSON.stringify(vG.cands));
  // 다음 검증 동결=새 세대(virtualGen 아님) — 강등(입장 심사) 재개(서고 도장 전 시점 — 서고가 생기면 선별 결과가 필요한 기존 규칙)
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-g4";
  CB.envelopeSliceFor(G.ws, "ko", "core", CL.loadContract(G.ws, "ko"));
  const fz = CL.readFrozenEnvelopeRec(G.ws);
  assert.ok(fz.hash === H1 && fz.virtualGen === false && Array.isArray(fz.manifest), "새 세대 동결 " + JSON.stringify({ h: fz.hash === H1, v: fz.virtualGen }));
});
t("두 번째 도장 — 이월된 후보로 서고(관련될 때) 초안 성공·적용", () => {
  const r = CL.draftEnvelopeRevision(G.ws, G.repo, { approvedHash: H1, target: "archive", addCandidateIds: [UD], removeItems: [] });
  assert.ok(r.ok && r.target === "archive", JSON.stringify(r));
  const tr = CL.applyEnvelopeTransition(G.ws, G.repo, "ko", null);
  assert.ok(tr.ok, JSON.stringify(tr));
  const ar = CL.readVerifyEnvelopeArchive(G.repo);
  assert.ok(ar.st === "ok" && ar.data.alwaysBlocker.includes("화면 표시와 실제 연결 상태는 항상 같아야 한다") && CL.loadContract(G.ws).archiveHash === ar.sha1);
  assert.strictEqual(CL.readEnvelopeCandidates(G.ws).latest.get(UD + "@" + H1).applied, tr.newHash);
});
t("draftEnvelopeInitial — 0세대가 아니면 거절(기존 개정 경로로)", () => {
  const r = CL.draftEnvelopeInitial(G.ws, G.repo, { allowEmpty: true });
  assert.ok(!r.ok && /첫 수칙서 단계가 아니에요/.test(r.error), JSON.stringify(r));
});

console.log("[8] 빈 코어 첫 도장(관련될 때만 고른 경우) — 세대 불변");
t("빈 첫 초안=GEN0_HASH · 승인 뒤 계약 지문=GEN0(정식) · 후보·열린 지적이 같은 세대로 이어짐 · 서고 초안 성공", () => {
  const E = pair("empty");
  const d = CL.directRuleCandidate(E.ws, E.repo, { text: "설치 위치와 남은 일을 함께 안내한다" });
  assert.ok(d.ok);
  CL.appendFindingsLedger(E.ws, [{ type: "finding", findingId: "f-e0open01", campaignId: "no-campaign", round: 1, tag: "blocker", titleNorm: "열림", title: "열림", envelopeHash: CL.GEN0_HASH, status: "open", ts: "t" }], { repoKey: E.rk });
  const r = CL.draftEnvelopeInitial(E.ws, E.repo, { allowEmpty: true });
  assert.ok(r.ok && r.newHash === CL.GEN0_HASH && r.adds === 0, JSON.stringify(r));
  assert.strictEqual(CL.readEnvelopeProposal(E.ws, E.repo).candidateIds.length, 0, "후보 비결속");
  const tr = CL.applyEnvelopeTransition(E.ws, E.repo, "ko", null);
  assert.ok(tr.ok && tr.newHash === CL.GEN0_HASH, JSON.stringify(tr));
  assert.ok(CL.loadContract(E.ws).envelopeHash === CL.GEN0_HASH && CL.envelopeGenFor(E.ws).virtual === false, "정식 승인(지문 같음)");
  assert.strictEqual(CL.readEnvelopeCandidates(E.ws).latest.get(d.candidateId + "@" + CL.GEN0_HASH).status, "proposed", "같은 세대 대기 유지(이월 불필요)");
  assert.strictEqual(CL.openFindingsFor(E.ws, "no-campaign", CL.GEN0_HASH).length, 1, "열린 지적 같은 세대로 이어짐");
  assert.strictEqual(CL.readFrozenEnvelopeRec(E.ws), null, "전제: 검증 이력 없음(동결 없음)");
  const vE = viewFor(E);
  assert.ok(vE && vE.cands && vE.cands.some((c) => c.id === d.candidateId && c.gen === CL.GEN0_HASH), "빈 코어 승인 뒤 2단계 미완료 후보=카드에 그대로(검증 1회차 blocker③) " + JSON.stringify(vE && vE.cands));
  const r2 = CL.draftEnvelopeRevision(E.ws, E.repo, { approvedHash: CL.GEN0_HASH, target: "archive", addCandidateIds: [d.candidateId], removeItems: [] });
  assert.ok(r2.ok && r2.target === "archive", JSON.stringify(r2));
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e1";
  CB.envelopeSliceFor(E.ws, "ko", "core", CL.loadContract(E.ws, "ko"));
  const fz = CL.readFrozenEnvelopeRec(E.ws);
  assert.ok(fz.hash === CL.GEN0_HASH && fz.virtualGen === false, "정식 승인 동결=virtualGen 아님(쓰기 조건이 virtual 판정과 결속)");
});
t("빈 수칙서와 같은 바이트의 수기 파일(승인 전)=GEN0 지문으로 개정·첫 초안 모두 거절", () => {
  const U = pair("unap");
  fs.writeFileSync(path.join(U.repo, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  const d = CL.draftEnvelopeRevision(U.ws, U.repo, { approvedHash: CL.GEN0_HASH, target: "core", addCandidateIds: ["0123456789abcdef"] });
  assert.ok(!d.ok && /승인 전/.test(d.error), JSON.stringify(d));
  const i = CL.draftEnvelopeInitial(U.ws, U.repo, { allowEmpty: true });
  assert.ok(!i.ok, "첫 초안 단계 아님");
  assert.strictEqual(CL.readEnvelopeProposal(U.ws, U.repo).st, "absent", "제안본 없음");
});
t("가짜 virtualGen 동결 — 승인 지문과 다른 해시에 virtualGen 을 붙여도 판독은 거짓", () => {
  const F = pair("fake");
  assert.ok(CL.writeEnvelopeFreeze(F.ws, "a".repeat(40), "ask-f", { virtualGen: true }));
  const fz = CL.readFrozenEnvelopeRec(F.ws);
  assert.ok(fz.hash === "a".repeat(40) && fz.virtualGen === false, "virtualGen=GEN0 지문과 함께일 때만");
});

console.log("[8b] 검증 1회차 blocker 반례");
t("저장소 파티션(ab-1) — A 에서 승인한 서고 문안이 같은 작업 폴더 B 저장소의 0세대 후보를 정리하지 않는다", () => {
  const W = mk("gen0-ws-part-"), A = mk("gen0-repoA-"), B = mk("gen0-repoB-");
  const setT = (r) => { assert.ok(CL.updateContractPatch(W, "ko", { scoutRepo: r }, { tries: 3 }).ok); assert.ok(CL.updateContractPatch(W, "en", { scoutRepo: r }, { tries: 3 }).ok); };
  const X = "외부 기록 보관 위치를 사용자 승인 없이 바꾸지 않는다";
  setT(B); const dB = CL.directRuleCandidate(W, B, { text: X }); assert.ok(dB.ok, JSON.stringify(dB));
  setT(A); const dA = CL.directRuleCandidate(W, A, { text: X }); assert.ok(dA.ok && dA.candidateId !== dB.candidateId, JSON.stringify(dA));
  assert.ok(CL.draftEnvelopeInitial(W, A, { allowEmpty: true }).ok);
  assert.ok(CL.applyEnvelopeTransition(W, A, "ko", null).ok);
  assert.ok(CL.draftEnvelopeRevision(W, A, { approvedHash: CL.GEN0_HASH, target: "archive", addCandidateIds: [dA.candidateId], removeItems: [] }).ok);
  assert.ok(CL.applyEnvelopeTransition(W, A, "ko", null).ok);
  CL.reconcileMemoryCandidates(W, A, CL.GEN0_HASH);
  const lat = CL.readEnvelopeCandidates(W).latest;
  assert.strictEqual(lat.get(dB.candidateId + "@" + CL.GEN0_HASH).status, "proposed", "B 후보 무접촉(종전=A 서고 문안으로 declined)");
  assert.ok(!CL.readEnvelopeCandidates(W).rows.some((r) => r.candidateId === dB.candidateId && r.status === "declined"), "B 후보 정리 행 없음");
});
t("첫 도장 이월 판독 실패 — 승인 완료로 확정하지 않고(carry-read) WAL·제안본 보존 → 복구 뒤 이월 1회", () => {
  const K = pair("cread");
  const d = CL.directRuleCandidate(K.ws, K.repo, { text: "작업이 끝나면 사용자가 쓰던 원래 설정으로 되돌린다" });
  assert.ok(d.ok);
  const txt = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: ["내 폰 한 대"], alwaysBlocker: [], outOfScope: [] });
  assert.ok(CL.writeEnvelopeProposal(K.ws, K.repo, txt, "시험", { candidateGeneration: CL.GEN0_HASH }).ok);
  assert.strictEqual(CL.readEnvelopeProposal(K.ws, K.repo).candidateGeneration, CL.GEN0_HASH);
  const cf = CL.envelopeCandidatesFileFor(K.ws), keep = cf + ".keep";
  fs.renameSync(cf, keep); fs.mkdirSync(cf); // 판독 오류(EISDIR) 주입 — 부재가 아님
  const tr = CL.applyEnvelopeTransition(K.ws, K.repo, "ko", null);
  assert.ok(!tr.ok && tr.reason === "carry-read", JSON.stringify(tr));
  assert.strictEqual(CL.envelopeTransState(K.ws), "recover-needed", "WAL 보존");
  assert.strictEqual(CL.readEnvelopeProposal(K.ws, K.repo).st, "ok", "제안본 보존");
  fs.rmdirSync(cf); fs.renameSync(keep, cf);
  const rc = CL.recoverEnvelopeTransition(K.ws);
  assert.strictEqual(rc.st, "recovered", JSON.stringify(rc));
  const H = CL.loadContract(K.ws).envelopeHash;
  assert.strictEqual(CL.readEnvelopeCandidates(K.ws).rows.filter((r) => r.candidateId === d.candidateId && r.envelopeHash === H && r.status === "proposed").length, 1, "복구 뒤 이월 정확히 1행");
  assert.strictEqual(CL.envelopeTransState(K.ws), "clear");
});

console.log("[9] 구조 핀");
t("첫 도장 이월은 전이 잠금 안·applied 기록 뒤·제안본 폐기 전(실패=WAL 보존 carry-write)", () => {
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  const fb = lib.indexOf("function applyEnvelopeTransitionLocked("), fe = lib.indexOf("function envelopeApprovedCopyFileFor(", fb);
  const body = lib.slice(fb, fe);
  const iA = body.indexOf("applied: wal.newHash"), iC = body.indexOf("reconcileMemoryCandidatesLocked(ws, repo, wal.newHash)"), iD = body.indexOf("discardEnvelopeProposal(ws);"), iW = body.lastIndexOf("fs.rmSync(walFile");
  assert.ok(iA > 0 && iC > iA && iD > iC && iW > iD, "순서 applied → 이월 → 폐기 → WAL 삭제");
  assert.ok(body.includes('reason: "carry-write"') && body.includes('reason: "carry-read"'), "이월 쓰기·판독 실패=전이 미완(복구 대상)");
});
t("조정 본체는 후보 장부를 정확히 1회 읽고 그 결과로 오류를 구분한다(검증 2회차 — 사전 읽기·실제 읽기 사이 실패 분기 차단)", () => {
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  const fb = lib.indexOf("function reconcileMemoryCandidatesLocked("), fe = lib.indexOf(NL + "function ", fb + 10);
  const body = lib.slice(fb, fe);
  assert.strictEqual((body.match(/readEnvelopeCandidatesState\(ws\)/g) || []).length, 1, "판독 1회");
  assert.ok(!/readEnvelopeCandidates\(ws\)/.test(body) && !body.includes("readFileSync(envelopeCandidatesFileFor"), "다른 판독 경로 없음");
  const W = mk("gen0-rst-");
  const st0 = CL.readEnvelopeCandidatesState(W);
  assert.ok(st0.readError === false && st0.rows.length === 0, "부재=빈 장부(오류 아님)");
  fs.mkdirSync(CL.envelopeCandidatesFileFor(W), { recursive: true });
  const st1 = CL.readEnvelopeCandidatesState(W);
  assert.ok(st1.readError === true && st1.rows.length === 0, "판독 오류=알 수 없음(readError)");
  const r = CL.reconcileMemoryCandidates(W, W, CL.GEN0_HASH);
  assert.ok(r.readFailed === true, "조정=readFailed " + JSON.stringify(r));
  assert.deepStrictEqual(CL.readEnvelopeCandidates(W).rows, [], "종전 판독기 형태(오류=빈 결과) 유지");
});
t("대시보드 [승인] 0세대 분기 — 항상=첫 초안 결속 / 관련될 때=빈 첫 초안 → 승인 뒤 서고 초안 두 번째 창", () => {
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(ext.includes('CLM.draftEnvelopeInitial(wsM, repoM, { addCandidateIds: [m.id] })') && ext.includes('CLM.draftEnvelopeInitial(wsM, repoM, { allowEmpty: true })'));
  assert.ok(/after: \(\) => \{[^]{0,900}target: "archive"/.test(ext) && ext.includes("chain.after()"), "두 번째 승인 창 연결");
  assert.ok(ext.includes('dest: "archive"') && ext.includes('dest: "core"') && ext.includes("관련될 때 적용(추천)"), "칸 선택 버튼(추천=관련될 때)");
});

delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
console.log(`\n결과: ${n}/${n} 통과`);
