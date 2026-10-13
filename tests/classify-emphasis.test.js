"use strict";
/*
 * [RULE-SUPPLY-CORRECTION ⑥ 묶음 3(C) — 2026-10-13] 같은 뜻 반복 = '다시 강조됨'.
 *  ① 입력: 항목 번호마다 가리키는 대상(수칙서 항목=문안 지문·축·번호·세대 / 제안=후보 id / 앞선 결과=결과 id) · '구현 담당 미처리'는 대기 목록에 · '구현 담당이 안 올림'은 따로(S) · 새 조건 분리 지시
 *  ② 커밋: 다시 강조 결과에 대상 기록 · 같은 뜻 반복은 후보를 만들지 않음 · 새 조건은 별도 판정 경계 결과(섞지 않음)
 *  ③ 다시 넘기기: 미처리·안 올린 판정 경계를 다시 강조 → 새로 하신 말로 새 판정 경계 결과(칸·영향 승계 · 옛 결과 무변) · 대기·올림 대상=세기만 · 같은 인용 거절 기억=안 만듦
 *  ④ 전달: 다음 사람의 차례에 '다시 강조(n번째)' 자료 줄 한 번 · 같은 회사만 · 판정 경계 한도와 따로 · 종료 관문 대상 아님
 *  ⑤ 화면: 집계(지문·제안·결과) · 수칙서 세대가 바뀌어도 같은 문장에만(같은 자리의 다른 문장에는 안 붙음) · 후보 집계→자료 변환→카드·수칙 줄 표시(컴파일 산출물)
 *  ⑥ 검증 입력 무포함: 검증 담당에게 가는 수칙서 주입·동적 자료에 다시 강조 인용이 없음 · 검증 쪽 조립부가 분류 결과 장부를 읽지 않음
 * 격리: 임시 CODEX_BRIDGE_HOME. 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cemph-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");
const CB = require("../bridge/codex-bridge.js");

const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const fpOf = (x) => crypto.createHash("sha1").update(CL.normBacklogTitle(String(x)), "utf8").digest("hex"); // 대시보드 수칙 줄 itemFp 와 같은 식
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let seq = 0;
function approve(P, core) {
  const raw = CL.serializeEnvelopeCore(Object.assign({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: [], outOfScope: [] }, core || {}));
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), raw);
  CL.setEnvelopeHashAllSlots(P.ws, sha1(raw));
  P.H = sha1(raw);
}
function project(tag, core) {
  const ws = mk("ce-ws-" + tag + "-"), repo = mk("ce-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  const P = { ws, repo, rk: CL.repoKeyOf(repo), H: CL.GEN0_HASH };
  if (core) approve(P, core);
  return P;
}
function say(P, text, provider) {
  const anc = CL.turnAnchorOf("ce-s", new Date(Date.UTC(2026, 9, 13, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  assert.ok(UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "ce-s", repoKey: P.rk, provider: provider || "claude" }).ok);
}
function turnNow(P, text, provider) {
  const anc = CL.turnAnchorOf("ce-now", new Date(Date.UTC(2026, 9, 13, 1, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text || "다음 단계 진행해 주세요");
  return { ok: true, provider: provider || "claude", sessionId: "ce-now", turnAnchor: anc, sourceHash: s.sourceHash, repoKey: P.rk };
}
function fakeRunner(answer) { return ({ prompt }) => ({ promise: Promise.resolve({ ok: true, output: JSON.stringify(typeof answer === "function" ? answer(prompt) : answer) }), cancel() {} }); }
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); };
// '이미 있는 것' 목록에서 그 문장이 붙은 항목 번호
const labelOf = (prompt, text) => { for (const ln of prompt.split("\n")) { const m = /^- ([A-Z]\d+): (.*)$/.exec(ln); if (m && m[2].includes(text)) return m[1]; } return null; };
let lastPrompt = "";
async function classify(P, words, answerFor, provider) {
  for (const w of words) say(P, w, provider);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => { lastPrompt = p; return { results: answerFor(p) }; }) });
  assert.ok(r.st === "ok", JSON.stringify(r));
  return r;
}
async function boundary(P, quote, seat, provider) {
  const r = await classify(P, [quote], (p) => [{ ref: refOf(p, quote), kind: "boundary", seat, quote, why: "프로젝트 내내 지킬 판정 기준", bounds: "이 기준으로 결함 여부를 판정한다" }], provider);
  return CF.readClassifyResults(P.ws).latest.get(r.resultIds[0]);
}
const resLatest = (P) => CF.readClassifyResults(P.ws).latest;
const rowsOf = (P) => CL.readEnvelopeCandidates(P.ws).rows;

const RB1 = "사용자 원래 설정은 검증이 끝나면 반드시 되돌려 놓는다";
const RB2 = "외부 서버 연동 오류는 이 프로젝트의 검증 대상이 아니다";

t("① 입력 — 항목 번호마다 가리키는 대상(지문·축·번호·세대 / 후보 id / 결과 id) · 미처리=대기 목록 · 안 올림=따로(S) · 새 조건 분리 지시", async () => {
  const RB3 = "README  파일은   언제나 최신 내용으로 유지한다"; // 정규화가 실제로 바꾸는 문장(겹친 띄어쓰기) — 화면 수칙 줄 지문 식과 같아야 함
  assert.notStrictEqual(CL.normBacklogTitle(RB3), RB3, "(전제) 정규화가 바꾸는 문장");
  const P = project("input", { alwaysBlocker: [RB1, RB3], outOfScope: [RB2] });
  const c0 = turnNow(P, "기억해 줘: 보고서 첫머리에는 바뀐 파일 목록을 꼭 넣어 달라고 했지");
  const pid = CL.constraintAdd(P.ws, "보고서 첫머리에는 바뀐 파일 목록을 꼭 넣어 달라고 했지", "판정 경계", "", c0).candidateId;
  const c1 = turnNow(P, "기억해 줘: 배포 전에는 꼭 사용자에게 먼저 물어보라고 했어");
  const did = CL.constraintAdd(P.ws, "배포 전에는 꼭 사용자에게 먼저 물어보라고 했어", "판정 경계", "", c1).candidateId;
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: did, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]));
  const wNew = await boundary(P, "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어", "supportedEnv");
  const wUnh = await boundary(P, "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자", "outOfScope");
  const wSkp = await boundary(P, "로그 파일 크기 제한은 이번 작업에서 따지지 말자고 했어", "outOfScope");
  assert.ok(CF.appendClassifyResults(P.ws, [CF.resultStatusRow(P.ws, wUnh, "unhandled", { by: "harness" }), CF.resultStatusRow(P.ws, wSkp, "skipped", { by: "implementer", note: "이번 단계 판단 기준 아님" })]));
  say(P, "다음 단계 진행해 주세요 그리고 설정 되돌리기는 꼭 지켜");
  const inp = CF.classifyInput(P.ws, P.repo);
  assert.ok(inp.ok && inp.refMeta, JSON.stringify(inp).slice(0, 300));
  const byText = (txt) => { const id = Object.keys(inp.refs).find((k) => inp.refs[k].includes(txt)); return id ? { id, m: inp.refMeta[id] } : null; };
  const b1 = byText(RB1), b2 = byText(RB2);
  assert.ok(b1 && b1.id[0] === "B" && b1.m.type === "core" && b1.m.axis === "alwaysBlocker" && b1.m.index === 0 && b1.m.fp === fpOf(RB1) && b1.m.gen === P.H, "★수칙서 항목=문안 지문·축·번호·세대 " + JSON.stringify(b1));
  assert.ok(b2 && b2.m.axis === "outOfScope" && b2.m.fp === fpOf(RB2));
  const b3 = byText("README");
  assert.ok(b3 && b3.m.fp === fpOf(RB3) && b3.m.fp !== sha1(RB3), "★지문=정규화 문안(화면 수칙 줄 itemFp 와 같은 식) " + JSON.stringify(b3));
  const pp = byText("바뀐 파일 목록을 꼭 넣어"), nn = byText("배포 전에는 꼭 사용자에게");
  assert.ok(pp && pp.id[0] === "P" && pp.m.type === "candidate" && pp.m.candidateId === pid, "대기 제안=후보 id " + JSON.stringify(pp));
  assert.ok(nn && nn.id[0] === "N" && nn.m.type === "declined-candidate" && nn.m.candidateId === did, "안 올린 제안=후보 id " + JSON.stringify(nn));
  const w1 = byText("사용자 본인 폰 한 대"), w2 = byText("실기기 최신폰 확인은"), s1 = byText("로그 파일 크기 제한");
  assert.ok(w1 && w1.id[0] === "W" && w1.m.type === "result" && w1.m.resultId === wNew.resultId, "대기 결과");
  assert.ok(w2 && w2.id[0] === "W" && w2.m.resultId === wUnh.resultId, "★구현 담당 미처리도 대기 목록(다시 강조로 다시 넘김 재료)");
  assert.ok(s1 && s1.id[0] === "S" && s1.m.type === "result" && s1.m.resultId === wSkp.resultId, "★구현 담당이 안 올린 결과=따로(S)");
  const prompt = CF.buildClassifyPrompt(inp, "ko");
  assert.ok(prompt.includes("[이미 있는 것 — 구현 담당이 올리지 않은 앞선 결과]") && prompt.includes("새 조건 구절만 인용한 boundary 하나를 따로"), "지시문 — S 목록·새 조건 분리");
  assert.ok(CF.buildClassifyPrompt(inp, "en").includes("separate boundary that quotes only the new-condition passage"));
});

t("② 커밋 — 다시 강조 결과에 대상 기록 · 같은 뜻 반복은 후보를 만들지 않음 · 새 조건은 별도 판정 경계(섞지 않음)", async () => {
  const P = project("commit", { alwaysBlocker: [RB1] });
  const before = rowsOf(P).length;
  const W1 = "설정 되돌리기는 꼭 지켜 달라고 했잖아 그리고 테스트 기기 설정도 마찬가지로 원래대로 돌려놔";
  const QE = "설정 되돌리기는 꼭 지켜 달라고 했잖아", QN = "테스트 기기 설정도 마찬가지로 원래대로 돌려놔";
  const r = await classify(P, [W1], (p) => [
    { ref: refOf(p, W1), kind: "emphasis", quote: QE, itemRef: labelOf(p, RB1), why: "이미 있는 설정 되돌리기 수칙과 같은 뜻" },
    { ref: refOf(p, W1), kind: "boundary", quote: QN, seat: "alwaysBlocker", why: "새 대상(테스트 기기)이 더해진 조건", bounds: "테스트 기기 설정을 되돌리지 않으면 결함으로 본다" },
  ]);
  assert.strictEqual(r.resultIds.length, 2);
  const L = resLatest(P);
  const e = [...L.values()].find((x) => x.kind === "emphasis"), b = [...L.values()].find((x) => x.kind === "boundary");
  assert.ok(e && e.quote === QE && e.target && e.target.type === "core" && e.target.fp === fpOf(RB1) && e.target.axis === "alwaysBlocker" && e.target.index === 0, "★다시 강조 대상 " + JSON.stringify(e));
  assert.ok(b && b.quote === QN && b.seat === "alwaysBlocker" && !b.target && !b.resumedFrom, "★새 조건=별도 판정 경계 " + JSON.stringify(b));
  assert.ok(!e.seat && !e.bounds, "다시 강조에 판정 경계 칸을 섞지 않음");
  assert.strictEqual(rowsOf(P).length, before, "★같은 뜻 반복은 후보를 만들지 않음(후보 장부 무변)");
});

t("③ 다시 넘기기 — 미처리·안 올린 판정 경계를 다시 강조 → 새로 하신 말로 새 판정 경계 결과 · 옛 결과 무변 · 대기 대상=세기만 · 같은 인용 거절 기억=안 만듦", async () => {
  const P = project("resume", {});
  const U = await boundary(P, "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자", "outOfScope");
  const K = await boundary(P, "로그 파일 크기 제한은 이번 작업에서 따지지 말자고 했어", "outOfScope");
  const N = await boundary(P, "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어", "supportedEnv");
  assert.ok(CF.appendClassifyResults(P.ws, [CF.resultStatusRow(P.ws, U, "unhandled", { by: "harness" }), CF.resultStatusRow(P.ws, K, "skipped", { by: "implementer", note: "이번 단계 판단 기준 아님" })]));
  const EU = "최신폰 실기기 확인은 정말 이번 단계에서 하지 않는다니까", EK = "로그 크기 제한은 진짜로 이번엔 신경 쓰지 말자", EN = "본인 폰 한 대 기준이라는 건 그대로야 잊지 마";
  await classify(P, [EU, EK, EN], (p) => [
    { ref: refOf(p, EU), kind: "emphasis", quote: EU, itemRef: labelOf(p, "실기기 최신폰 확인은"), why: "앞선 판정 경계와 같은 뜻" },
    { ref: refOf(p, EK), kind: "emphasis", quote: EK, itemRef: labelOf(p, "로그 파일 크기 제한"), why: "앞선 판정 경계와 같은 뜻" },
    { ref: refOf(p, EN), kind: "emphasis", quote: EN, itemRef: labelOf(p, "사용자 본인 폰 한 대"), why: "앞선 판정 경계와 같은 뜻" },
  ]);
  const L = resLatest(P);
  const resumed = [...L.values()].filter((x) => x.kind === "boundary" && x.resumedFrom);
  const rU = resumed.find((x) => x.resumedFrom === U.resultId), rK = resumed.find((x) => x.resumedFrom === K.resultId);
  assert.ok(rU && rU.quote === EU && rU.seat === U.seat && rU.bounds === U.bounds && rU.status === "new" && rU.emphasisOf, "★미처리 → 새로 하신 말로 다시 넘김 " + JSON.stringify(rU));
  assert.ok(rK && rK.quote === EK && rK.seat === K.seat && rK.status === "new", "★구현 담당이 안 올림 → 다시 넘김 " + JSON.stringify(rK));
  assert.ok(!resumed.some((x) => x.resumedFrom === N.resultId), "★대기 중인 결과=세기만(새 결과 없음)");
  assert.ok(L.get(U.resultId).status === "unhandled" && L.get(K.resultId).status === "skipped", "★옛 결과 상태 그대로");
  // 다음 사람의 차례 — 다시 넘긴 결과가 판단 대상(전달 1회째)으로, 다시 강조는 자료 줄로
  const now = turnNow(P);
  const pl = CF.planDelivery(P.ws, now);
  const ids = pl.deliver.map((x) => x.resultId);
  assert.ok(ids.includes(rU.resultId) && ids.includes(rK.resultId), "다시 넘긴 결과 전달 " + JSON.stringify(ids));
  const blk = CF.deliveryBlock(pl.deliver, "ko");
  assert.ok(ids.includes(N.resultId), "아직 넘기지 않은 대기 결과도 같은 차례에(종전 흐름)");
  assert.ok(blk.includes("[사용자 말 분류 결과 — 이번 차례 판단 3건]") && blk.includes("전달 1/2회째") && blk.includes("새로 하신 말로 다시 넘김(판단 대상)") && blk.includes("사용자가 앞선 판정 경계 결과를 다시 강조함(1번째)"), blk);
  // 같은 인용을 사용자가 이미 거절한 제안이 있으면 다시 넘기지 않음
  const P2 = project("resume-decl", {});
  const U2 = await boundary(P2, "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자", "outOfScope");
  assert.ok(CF.appendClassifyResults(P2.ws, [CF.resultStatusRow(P2.ws, U2, "unhandled", { by: "harness" })]));
  const E2 = "최신폰 실기기 확인은 정말 이번 단계에서 하지 않는다니까";
  const cD = turnNow(P2, E2);
  const dId = CL.constraintAdd(P2.ws, E2, "같은 말 일반 상신", "", cD).candidateId;
  assert.ok(CL.appendEnvelopeCandidates(P2.ws, [{ candidateId: dId, envelopeHash: P2.H, status: "declined", by: "user", ts: new Date().toISOString() }]));
  approve(P2, { alwaysBlocker: ["이 프로젝트와 무관한 다른 수칙 한 줄"] }); // 새 승인 세대 — 거절한 제안은 지금 세대 행이 없고 거절 기억만 남음
  assert.ok(!CL.readEnvelopeCandidates(P2.ws).latest.get(dId + "@" + P2.H) && CL.userDeclinedCandidate(rowsOf(P2), dId), "(전제) 거절 기억만 남음");
  await classify(P2, [E2], (p) => [{ ref: refOf(p, E2), kind: "emphasis", quote: E2, itemRef: labelOf(p, "실기기 최신폰 확인은"), why: "앞선 판정 경계와 같은 뜻" }]);
  assert.ok(![...resLatest(P2).values()].some((x) => x.resumedFrom), "★같은 인용 거절 기억=다시 넘기지 않음(다시 강조 기록만)");
  assert.ok([...resLatest(P2).values()].some((x) => x.kind === "emphasis"));
});

t("④ 전달 — '다시 강조(n번째)' 자료 줄 한 번 · 같은 회사만 · 판정 경계 한도와 따로 · 종료 관문 대상 아님", async () => {
  const P = project("deliver", { alwaysBlocker: [RB1, RB2] });
  const E1 = "설정 되돌리기는 꼭 지켜 달라고 했잖아 기억하지", E2 = "원래 설정 복구는 다시 말하지만 정말 중요해", E3 = "외부 서버 연동 오류는 정말 다루지 말자";
  await classify(P, [E1, E2, E3], (p) => [
    { ref: refOf(p, E1), kind: "emphasis", quote: E1, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" },
    { ref: refOf(p, E2), kind: "emphasis", quote: E2, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" },
    { ref: refOf(p, E3), kind: "emphasis", quote: E3, itemRef: labelOf(p, RB2), why: "이미 있는 수칙과 같은 뜻" },
  ]);
  const now = turnNow(P);
  // 다른 회사 차례에는 넘기지 않음(R3)
  assert.strictEqual(CF.planDelivery(P.ws, Object.assign({}, now, { provider: "codex" })).deliver.length, 0, "★다른 회사=전달 없음");
  const pl = CF.planDelivery(P.ws, now);
  assert.strictEqual(pl.deliver.length, 3);
  const blk = CF.deliveryBlock(pl.deliver, "ko");
  assert.ok(blk.startsWith("[사용자 말 분류 결과 — 다시 강조 3건 · 자료(판단할 것 없음)]") && !blk.includes("constraint add") && !blk.includes("classify skip"), "★자료 줄만(명령 없음) " + blk);
  assert.ok(blk.includes("사용자가 수칙서 본문 항목을 다시 강조함(1번째)") && blk.includes("사용자가 수칙서 본문 항목을 다시 강조함(2번째)") && blk.includes("하신 말: \"" + E2), "★n번째 " + blk);
  assert.ok(CF.deliveryBlock(pl.deliver, "en").includes("re-emphasised rulebook item (time #2)"));
  assert.ok(CF.markResultsDelivered(P.ws, pl.deliver, now));
  assert.strictEqual(CF.classifyStopGate(P.ws, Object.assign({}, now, { sessionId: "ce-gate" }), { lang: "ko" }), null, "★다시 강조만 넘긴 차례=종료 관문 없음");
  assert.strictEqual(CF.planDelivery(P.ws, turnNow(P)).deliver.length, 0, "★한 번만(다음 차례에 다시 넘기지 않음)");
  // 판정 경계 한도와 따로 — 판정 경계 5건 + 다시 강조 1건이 한 차례에 모두
  const Q = ["첫째 판정 기준 문장은 이것으로 둔다고 했어", "둘째 판정 기준 문장은 저것으로 둔다고 했어", "셋째 판정 기준 문장은 그것으로 둔다고 했어", "넷째 판정 기준 문장은 이렇게 둔다고 했어", "다섯째 판정 기준 문장은 저렇게 둔다고 했어"];
  await classify(P, Q, (p) => Q.map((q) => ({ ref: refOf(p, q), kind: "boundary", seat: "outOfScope", quote: q, why: "프로젝트 내내 지킬 판정 기준", bounds: "이 기준으로 결함 여부를 판정한다" })));
  const E4 = "외부 서버 연동 오류 얘기는 몇 번을 말해도 같아";
  await classify(P, [E4], (p) => [{ ref: refOf(p, E4), kind: "emphasis", quote: E4, itemRef: labelOf(p, RB2), why: "이미 있는 수칙과 같은 뜻" }]);
  const pl2 = CF.planDelivery(P.ws, turnNow(P));
  assert.ok(pl2.deliver.filter((x) => x.kind === "boundary").length === CF.DELIVER_PER_TURN && pl2.deliver.filter((x) => x.kind === "emphasis").length === 1, "★한도 따로 " + pl2.deliver.map((x) => x.kind).join(","));
  assert.ok(CF.deliveryBlock(pl2.deliver, "ko").includes("사용자가 수칙서 본문 항목을 다시 강조함(2번째)"), "RB2 두 번째");
  // [검증 1회차 blocker] 같은 차례에 계획이 다시 돌아도 다시 강조는 그 차례 누적 5건까지 — 나머지는 다음 차례
  const P7 = project("deliver7", { alwaysBlocker: [RB1] });
  const E7 = Array.from({ length: 7 }, (_, k) => "설정 되돌리기는 꼭 지켜 달라고 " + (k + 1) + "번째로 말하는 거야");
  await classify(P7, E7.slice(0, 5), (p) => E7.slice(0, 5).map((q) => ({ ref: refOf(p, q), kind: "emphasis", quote: q, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" }))); // 한 실행 결과 상한 5
  await classify(P7, E7.slice(5), (p) => E7.slice(5).map((q) => ({ ref: refOf(p, q), kind: "emphasis", quote: q, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" })));
  assert.strictEqual([...resLatest(P7).values()].filter((x) => x.kind === "emphasis").length, 7, "(전제) 다시 강조 7건");
  const t7 = turnNow(P7);
  const a7 = CF.planDelivery(P7.ws, t7); assert.ok(CF.markResultsDelivered(P7.ws, a7.deliver, t7));
  const b7 = CF.planDelivery(P7.ws, t7); if (b7.deliver.length) assert.ok(CF.markResultsDelivered(P7.ws, b7.deliver, t7));
  assert.ok(a7.deliver.length === CF.EMPHASIS_PER_TURN && b7.deliver.length === 0, "★같은 차례 누적 한도 " + a7.deliver.length + "+" + b7.deliver.length);
  const c7 = CF.planDelivery(P7.ws, turnNow(P7));
  assert.strictEqual(c7.deliver.length, 2, "나머지는 다음 차례");
});

t("⑤ 화면 — 집계(지문·제안·결과) · 수칙서 세대가 바뀌어도 같은 문장에만 · 후보 집계→자료 변환→카드·수칙 줄 표시", async () => {
  const P = project("view", { alwaysBlocker: [RB1, RB2] });
  const c0 = turnNow(P, "기억해 줘: 보고서 첫머리에는 바뀐 파일 목록을 꼭 넣어 달라고 했지");
  const pid = CL.constraintAdd(P.ws, "보고서 첫머리에는 바뀐 파일 목록을 꼭 넣어 달라고 했지", "판정 경계", "", c0).candidateId;
  const E1 = "설정 되돌리기는 꼭 지켜 달라고 했잖아 기억하지", E2 = "원래 설정 복구는 다시 말하지만 정말 중요해", E3 = "바뀐 파일 목록은 정말 맨 앞에 둬야 해";
  await classify(P, [E1, E2, E3], (p) => [
    { ref: refOf(p, E1), kind: "emphasis", quote: E1, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" },
    { ref: refOf(p, E2), kind: "emphasis", quote: E2, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" },
    { ref: refOf(p, E3), kind: "emphasis", quote: E3, itemRef: labelOf(p, "바뀐 파일 목록을 꼭 넣어"), why: "대기 중인 제안과 같은 뜻" },
  ]);
  const tal = CF.emphasisTally(P.ws, P.rk);
  assert.ok(tal.byFp[fpOf(RB1)] && tal.byFp[fpOf(RB1)].n === 2 && !tal.byFp[fpOf(RB2)] && tal.byCandidate[pid] && tal.byCandidate[pid].n === 1 && tal.byFp[fpOf(RB1)].last, "★집계 " + JSON.stringify(tal));
  assert.strictEqual(CF.emphasisTally(P.ws, "0".repeat(16)).byFp[fpOf(RB1)], undefined, "다른 저장소 결과는 섞지 않음");
  // 세대 변경: RB1 자리에 다른 문장 · RB1 은 뒤로 이동 → 지문으로만 붙음
  const OTHER = "검증 보고는 한국어로만 쓴다";
  approve(P, { alwaysBlocker: [OTHER, RB2, RB1] });
  const rowsNow = P.H && [OTHER, RB2, RB1].map((x, i) => ({ text: x, index: i, itemFp: fpOf(x) }));
  const emphFor = (r) => (CF.emphasisTally(P.ws, P.rk).byFp[r.itemFp] || null);
  assert.strictEqual(emphFor(rowsNow[0]), null, "★옛 1번 자리의 다른 문장에는 붙지 않음");
  assert.ok(emphFor(rowsNow[2]) && emphFor(rowsNow[2]).n === 2, "★같은 문장은 자리가 바뀌어도 따라감");
  approve(P, { alwaysBlocker: [OTHER] });
  assert.strictEqual(emphFor({ itemFp: fpOf(OTHER) }), null, "빠진 문장의 횟수가 남은 문장에 붙지 않음");
  // 대시보드 수칙 줄 연결(소스) — 같은 지문 식·byFp 결속
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(ext.includes("const e = talE9.byFp[r.itemFp];") && ext.includes('crypto.createHash("sha1").update(String(typeof CL9.normBacklogTitle === "function" ? CL9.normBacklogTitle(s) : s), "utf8").digest("hex")'), "수칙 줄=같은 지문 식으로 결속");
  // 후보 집계 → 자료 변환(컴파일 산출물) → 카드
  approve(P, { alwaysBlocker: [RB1, RB2] }); // 제안이 살아 있는 세대로(후보 세대 이월)
  CL.reconcileMemoryCandidates(P.ws, P.repo, P.H);
  CL.writeEnvelopeFreeze(P.ws, P.H, "ask-ce-view");
  const cc9 = CB.computeEnvelopeCandidatesFor(P.ws);
  const live = (cc9.live || []).find((c) => c.candidateId === pid);
  assert.ok(live && live.emph && live.emph.n === 1, "★후보 집계에 다시 강조 횟수 " + JSON.stringify(live));
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const i = outSrc.indexOf("const out9 = (cc9.live || []).map("), j = outSrc.indexOf("\n", i);
  const conv = new Function("cc9", "lat9", "genC9", "CL9", "ws", outSrc.slice(i, j) + "\nreturn out9;")(cc9, CL.readEnvelopeCandidates(P.ws).latest, P.H, CL, P.ws);
  const cv = conv.find((x) => x.id === pid);
  assert.ok(cv && cv.emph && cv.emph.n === 1, "★자료 변환 " + JSON.stringify(cv));
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, remove() {}, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const b2 = outSrc.indexOf('safe(function(){ var ec=$("envCard");'), e2 = outSrc.indexOf('safe(function(){ var uc=$("uwCard");', b2);
  const ec = mkEl("div");
  const rulesData = [RB1, RB2].map((x, k) => ({ target: "core", targetHash: P.H, axis: "alwaysBlocker", index: k, itemFp: fpOf(x), text: x, tag: "always", ...(tal.byFp[fpOf(x)] ? { emph: tal.byFp[fpOf(x)] } : {}) }));
  new Function("document", "$", "T", "d", "vscode", "safe", "var wbGen='', wbAdds=new Set(), wbRemoves=new Set(), candsMoreOpenWeb=false, signalsOpenWeb=false, rulesOpenWeb=false;\n" + outSrc.slice(b2, e2))({ createElement: mkEl, createTextNode: (tx) => ({ tag: "#text", textContent: String(tx), children: [] }) }, (x) => (x === "envCard" ? ec : null), (a) => a, { envelope: { label: "x", gen: P.H, wsKey: cv.wsKey, lang: "ko", gen0: false, cands: conv, rules: rulesData }, lang: "ko" }, { postMessage() {} }, (f) => f());
  const all = []; const w = (x) => { all.push(x); (x.children || []).forEach(w); }; w(ec);
  const emphs = all.filter((x) => x.attrs && x.attrs["data-emph"] === "1").map((x) => x.textContent);
  assert.ok(emphs.some((s) => /^다시 강조됨 2회\(\d+\/\d+\)$/.test(s)), "★수칙 줄 '다시 강조됨 2회(날짜)' " + JSON.stringify(emphs));
  assert.ok(emphs.some((s) => /^다시 강조됨 1회\(최근 \d+\/\d+\)$/.test(s)), "★제안 카드 '다시 강조됨 1회(최근 날짜)' " + JSON.stringify(emphs));
  assert.strictEqual(emphs.length, 2, "RB2 줄에는 없음");
});

t("⑥ 검증 입력 무포함 — 검증 담당에게 가는 수칙서 주입·동적 자료에 다시 강조 인용 없음 · 검증 쪽 조립부가 분류 결과 장부를 읽지 않음", async () => {
  const P = project("verify", { alwaysBlocker: [RB1] });
  const E1 = "설정 되돌리기는 꼭 지켜 달라고 했잖아 기억하지 제발";
  await classify(P, [E1], (p) => [{ ref: refOf(p, E1), kind: "emphasis", quote: E1, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" }]);
  assert.ok([...resLatest(P).values()].some((x) => x.kind === "emphasis" && x.quote === E1), "(전제) 다시 강조 결과 있음");
  const inj = String((CL.envelopeInjectionFor(P.repo, P.H, "ko") || {}).text || "");
  assert.ok(inj.includes(RB1) && !inj.includes(E1), "★수칙서 주입=승인된 문안만 " + inj.slice(0, 200));
  let dyn = ""; try { dyn = String(CB.v2DynamicData(P.ws, "ko") || ""); } catch (e) { dyn = "ERR " + e.message; }
  assert.ok(!dyn.includes(E1) && !dyn.startsWith("ERR"), "★검증 동적 자료에 없음");
  const br = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  const fnSrc = (src, name) => { const a = src.indexOf("function " + name + "("); assert.ok(a >= 0, name); const b = src.indexOf("\nfunction ", a + 10); return src.slice(a, b < 0 ? undefined : b); };
  for (const name of ["v2DynamicData", "v2StaticDirective", "askRequest"]) assert.ok(!/classify\.js|readClassifyResults|emphasisTally/.test(fnSrc(br, name)), "★" + name + " 가 분류 결과를 읽지 않음");
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  assert.ok(!/readClassifyResults|emphasisTally/.test(fnSrc(lib, "envelopeInjectionFor")), "수칙서 주입 함수가 분류 결과를 읽지 않음");
});

t("⑦ 사용자 말 카드 — 다시 강조 줄에 대상 종류 · 다시 넘긴 판정 경계 표시(실제 요약 → 컴파일 산출물 카드)", async () => {
  const P = project("uwcard", { alwaysBlocker: [RB1] });
  const U = await boundary(P, "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자", "outOfScope");
  assert.ok(CF.appendClassifyResults(P.ws, [CF.resultStatusRow(P.ws, U, "unhandled", { by: "harness" })]));
  const EU = "최신폰 실기기 확인은 정말 이번 단계에서 하지 않는다니까", E1 = "설정 되돌리기는 꼭 지켜 달라고 했잖아 기억하지";
  await classify(P, [EU, E1], (p) => [
    { ref: refOf(p, EU), kind: "emphasis", quote: EU, itemRef: labelOf(p, "실기기 최신폰 확인은"), why: "앞선 판정 경계와 같은 뜻" },
    { ref: refOf(p, E1), kind: "emphasis", quote: E1, itemRef: labelOf(p, RB1), why: "이미 있는 수칙과 같은 뜻" },
  ]);
  const view = CF.userWordsView(P.ws);
  assert.ok(view.results.emphasis.some((x) => x.targetType === "core") && view.results.emphasis.some((x) => x.targetType === "result") && view.results.boundary.some((x) => x.resumed === true), "요약 " + JSON.stringify(view.results).slice(0, 400));
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf('safe(function(){ var uc=$("uwCard");'), e = outSrc.indexOf('safe(function(){ var n=$("vBudgetNote");', b);
  assert.ok(b > 0 && e > b);
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, remove() {}, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const uc = mkEl("div");
  new Function("document", "$", "T", "d", "vscode", "safe", outSrc.slice(b, e))({ createElement: mkEl, createTextNode: (tx) => ({ tag: "#text", textContent: String(tx), children: [] }) }, (id) => (id === "uwCard" ? uc : null), (a) => a, { userWords: view }, { postMessage() {} }, (f) => f());
  const all = []; const w = (x) => { all.push(x); (x.children || []).forEach(w); }; w(uc);
  const txt = all.map((x) => x.textContent).join(" | ");
  assert.ok(txt.includes("같은 뜻 (수칙서 본문 항목): alwaysBlocker: " + RB1) && txt.includes("같은 뜻 (앞선 판정 경계 결과): "), "★다시 강조 대상 종류 " + txt.slice(0, 600));
  assert.ok(txt.includes("앞서 판단되지 않았거나 올리지 않은 기준을 다시 말씀하셔서 새로 넘겼어요"), "★다시 넘김 표시");
});

t("⑧ [검증 1회차] 안 올림이 판단 표식에만 남은 결과도 S 목록·다시 넘기기 대상 · 표식 내용을 못 읽으면 판단된 것으로 · 표식 서랍을 못 읽으면 입력 거절(말 보존)", async () => {
  const P = project("claimskip", {});
  const K = await boundary(P, "로그 파일 크기 제한은 이번 작업에서 따지지 말자고 했어", "outOfScope");
  const Z = await boundary(P, "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어", "supportedEnv");
  const now = turnNow(P);
  assert.ok(CF.markResultsDelivered(P.ws, [K, Z], now));
  // 안 올림 판단이 표식에만 남고 결과 장부 기록은 빠진 상태(skipResult 의 pendingRepair 와 같은 모양)
  const cr = CF.claimResult(P.ws, K.resultId, { schema: "classify-claim-v1", resultId: K.resultId, decision: "skipped", resultRow: CF.resultStatusRow(P.ws, K, "skipped", { by: "implementer", note: "이번 단계 판단 기준 아님", turnAnchor: now.turnAnchor }), by: "implementer", turnAnchor: now.turnAnchor, ts: new Date().toISOString() });
  assert.strictEqual(cr, "claimed");
  assert.strictEqual(resLatest(P).get(K.resultId).status, "delivered", "(전제) 장부는 아직 전달 상태");
  // 표식 내용을 못 읽는 결과(판단됨으로 봄)
  fs.writeFileSync(CF.claimFileFor(P.ws, Z.resultId), "{ broken");
  assert.strictEqual(CF.effectiveResultStatus(resLatest(P).get(Z.resultId), new Set(), CF.claimDecisions(P.ws)), "decided-unknown");
  say(P, "다음 단계 진행해 주세요");
  const inp = CF.classifyInput(P.ws, P.repo);
  const where = (txt) => Object.keys(inp.refs).find((k) => inp.refs[k].includes(txt)) || "";
  assert.ok(where("로그 파일 크기 제한")[0] === "S", "★표식에만 남은 안 올림=S " + where("로그 파일 크기 제한"));
  assert.strictEqual(where("사용자 본인 폰 한 대"), "", "★표식 내용을 못 읽음=판단됨(대기 목록에 없음)");
  // 다시 강조 → 새 판정 경계로 다시 넘김
  const EK = "로그 크기 제한은 진짜로 이번엔 신경 쓰지 말자";
  await classify(P, [EK], (p) => [{ ref: refOf(p, EK), kind: "emphasis", quote: EK, itemRef: labelOf(p, "로그 파일 크기 제한"), why: "앞선 판정 경계와 같은 뜻" }]);
  const rK = [...resLatest(P).values()].find((x) => x.resumedFrom === K.resultId);
  assert.ok(rK && rK.quote === EK && rK.status === "new", "★표식에만 남은 안 올림도 다시 넘김 " + JSON.stringify(rK));
  // 표식 서랍을 못 읽으면 입력 거절(말은 대기열에 그대로)
  const dir = path.dirname(CF.claimFileFor(P.ws, "0".repeat(16)));
  say(P, "설정 되돌리기는 꼭 지켜 달라고 했잖아 기억하지");
  const q0 = UW.queuedWords(P.ws, P.rk).length;
  fs.renameSync(dir, dir + ".bak"); fs.writeFileSync(dir, "not a dir");
  let inp2; try { inp2 = CF.classifyInput(P.ws, P.repo); } finally { fs.rmSync(dir, { force: true }); fs.renameSync(dir + ".bak", dir); }
  assert.ok(inp2 && inp2.ok === false && inp2.reason === "claims-unreadable", "★표식 서랍 판독 오류=입력 거절 " + JSON.stringify(inp2 && { ok: inp2.ok, reason: inp2.reason }));
  assert.strictEqual(UW.queuedWords(P.ws, P.rk).length, q0, "말 보존");
});

(async () => {
  let n = 0;
  for (const [name, fn] of pending) {
    try { await fn(); n++; console.log("  ✅ [" + n + "] " + name); }
    catch (e) { console.error("  ❌ " + name); console.error(e); process.exit(1); }
  }
  console.log("\n결과: " + n + "/" + pending.length + " 통과");
})();
