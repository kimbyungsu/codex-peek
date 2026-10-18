"use strict";
/*
 * [RULE-SUPPLY-CORRECTION ⑤ 2단계-가 — 2026-10-10] 분류 결과 판단 명령과 칸 계약.
 *  ① --axis(닫힌 목록)·실제 상신 행(submitted)·유효 칸 단일 함수(마지막 실제 상신 행 — 장부 순서 · 자동 전이 행은 권위 아님 · 옛 후보=칸 있는 첫 행)
 *  ② 소비처: 초안 관문·후보 목록·단건 목적지·한꺼번에 올리기·자동 전이 행 표시값(ucKeepFields)
 *  ③ --from: 이번 차례에 전달받은 미판단 결과만 · 결과 인용 안의 구절만 · 자체 상신 한도 밖 · 원문 대조 면제 없음 · 다른 차례·다른 회사·이미 판단=거부(무기록)
 *  ④ 안 올림(classify skip): 이유 한 줄 · 전달받은 미판단 결과만 · 한도 무관 · 화면 상태
 *  ⑤ 명령줄(constraint add --axis --from · classify skip) · 대시보드 표시(후보 카드 출처 줄·사용자 말 카드 상태)
 * 격리: 임시 CODEX_BRIDGE_HOME. 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cjudge-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");
const CB = require("../bridge/codex-bridge.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let seq = 0;
function project(tag, approved) {
  const ws = mk("cj-ws-" + tag + "-"), repo = mk("cj-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  let H = CL.GEN0_HASH;
  if (approved) { const raw = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: [], outOfScope: [] }); fs.writeFileSync(path.join(repo, CL.ENVELOPE_FILE), raw); CL.setEnvelopeHashAllSlots(ws, sha1(raw)); H = sha1(raw); }
  return { ws, repo, rk: CL.repoKeyOf(repo), H };
}
// 사용자 말 1건(입력창) — 대기열 등록 + 그 차례 문맥
function say(P, text, provider) {
  const anc = CL.turnAnchorOf("cj-s", new Date(Date.UTC(2026, 9, 10, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  const r = UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "cj-s", repoKey: P.rk, provider: provider || "claude" });
  assert.ok(r.ok && !r.held, JSON.stringify(r));
  return { anchor: anc, ctx: { ok: true, provider: provider || "claude", sessionId: "cj-s", turnAnchor: anc, sourceHash: s.sourceHash, repoKey: P.rk } };
}
// 지금 차례(구현 담당이 판단하는 차례) 문맥 — 원문은 일반 요청
function turnNow(P, text, provider) {
  const anc = CL.turnAnchorOf("cj-now", new Date(Date.UTC(2026, 9, 10, 1, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text || "다음 단계 진행해 주세요");
  return { ok: true, provider: provider || "claude", sessionId: "cj-now", turnAnchor: anc, sourceHash: s.sourceHash, repoKey: P.rk };
}
function fakeRunner(answer) { return ({ prompt }) => ({ promise: Promise.resolve({ ok: true, output: JSON.stringify(typeof answer === "function" ? answer(prompt) : answer) }), cancel() {} }); }
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); };
// 판정 경계 결과 하나 만들기(분류 실행 — 결과 장부만)
async function boundary(P, quote, seat, provider) {
  say(P, quote, provider);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, quote), kind: "boundary", seat, quote, why: "프로젝트 내내 지킬 판정 기준", bounds: "이 기준으로 결함 여부를 판정한다" }] })) });
  assert.ok(r.st === "ok" && r.resultIds.length === 1, JSON.stringify(r));
  return CF.readClassifyResults(P.ws).latest.get(r.resultIds[0]);
}
const latestOf = (P, id) => CL.readEnvelopeCandidates(P.ws).latest.get(id + "@" + P.H);
const rowsOf = (P) => CL.readEnvelopeCandidates(P.ws).rows;
const resStatus = (P, id) => CF.readClassifyResults(P.ws).latest.get(id).status;

t("① --axis 닫힌 목록 · 성공 행=실제 상신 행(submitted) · 칸 없음=항상 막을 것(종전) · 거부=무기록", () => {
  const P = project("axis");
  const Q = "실기기 최신폰 확인은 이번 단계 범위 밖으로 둔다";
  const c = turnNow(P, "기억해: " + Q);
  const before = rowsOf(P).length;
  assert.strictEqual(CL.constraintAdd(P.ws, Q, "판정 경계 기준", "", c, { axis: "core" }).reason, "axis-invalid");
  assert.strictEqual(rowsOf(P).length, before, "거부=무기록");
  const r = CL.constraintAdd(P.ws, Q, "판정 경계 기준", "", c, { axis: "outOfScope" });
  assert.ok(r.ok && r.axis === "outOfScope", JSON.stringify(r));
  const row = rowsOf(P).filter((x) => x.candidateId === r.candidateId).pop();
  assert.ok(row.submitted === true && typeof row.submittedAt === "string" && row.axis === "outOfScope", JSON.stringify(row));
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), r.candidateId), "outOfScope");
  const Q2 = "사용자 원래 설정은 언제나 되돌려 놓아야 한다고 했어";
  const c2 = turnNow(P, Q2);
  const r2 = CL.constraintAdd(P.ws, Q2, "판정 경계 기준", "", c2);
  assert.ok(r2.ok && !r2.axis && !("axis" in rowsOf(P).filter((x) => x.candidateId === r2.candidateId).pop()), "칸 없음");
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), r2.candidateId), "", "칸 없음=항상 막을 것(종전)");
});

t("② 유효 칸=마지막 실제 상신 행(장부 순서) — 안 올림 뒤 재요청 재상신 칸 · 자동 복원·이월 행은 권위 아님 · 같은 시각·시계 역전에도 나중 상신 · 옛 후보=칸 있는 첫 행", () => {
  const P = project("eff", true);
  const Q = "판정 기준 기기는 사용자 본인 폰 한 대로 한다고 정했어";
  const c1 = turnNow(P, Q);
  const r1 = CL.constraintAdd(P.ws, Q, "판정 경계 기준", "", c1, { axis: "alwaysBlocker" });
  assert.ok(r1.ok);
  const id = r1.candidateId;
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]));
  const c2 = turnNow(P, "다시 올려 줘: " + Q);
  const r2 = CL.constraintAdd(P.ws, Q, "판정 경계 기준(재요청)", "", Object.assign({}, c2, { again: true }), { axis: "supportedEnv" });
  assert.ok(r2.ok && r2.candidateId === id, JSON.stringify(r2));
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), id), "supportedEnv", "재상신 칸");
  // 자동 상태 전이 행(옛 칸을 실어도 submitted 없음)=권위 아님
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "proposed", kind: "user-constraint", axis: "alwaysBlocker", repoKey: P.rk, title: Q, ts: new Date().toISOString() }]));
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), id), "supportedEnv", "자동 복원 행은 칸을 바꾸지 못함");
  // 같은 시각·시계 역전 — 장부 순서가 이김(순수 함수)
  const T0 = "2026-10-10T00:00:00.000Z";
  const rowsS = [{ candidateId: "x", submitted: true, axis: "outOfScope", submittedAt: T0, ts: T0 }, { candidateId: "x", submitted: true, axis: "supportedEnv", submittedAt: T0, ts: T0 }];
  assert.strictEqual(CL.effectiveCandidateAxis(rowsS, "x"), "supportedEnv", "같은 시각=나중 행");
  const rowsK = [{ candidateId: "x", submitted: true, axis: "outOfScope", ts: "2026-10-10T00:00:05.000Z" }, { candidateId: "x", submitted: true, axis: "alwaysBlocker", ts: "2026-10-10T00:00:01.000Z" }];
  assert.strictEqual(CL.effectiveCandidateAxis(rowsK, "x"), "alwaysBlocker", "시계 역전=장부 순서");
  // 옛 후보(실제 상신 표식 없음)=칸 있는 첫 행 · 칸 없으면 ""
  assert.strictEqual(CL.effectiveCandidateAxis([{ candidateId: "o", origin: "classifier", axis: "outOfScope" }, { candidateId: "o", status: "adopted" }, { candidateId: "o", axis: "alwaysBlocker" }], "o"), "outOfScope", "옛 분류 후보");
  assert.strictEqual(CL.effectiveCandidateAxis([{ candidateId: "p", title: "옛 구현 담당 상신" }], "p"), "");
  // ucKeepFields(자동 전이 표시값)=유효 칸
  assert.strictEqual(CL.ucKeepFields({ candidateId: id, axis: "alwaysBlocker" }, {}, rowsOf(P)).axis, "supportedEnv");
});

t("② 소비처 — 재상신 칸 변경 → 초안 → 폐기(복원) → 재작성 ⇒ 본문 지원 환경 · 채택 고아 복원 뒤에도 목록·단건·한꺼번에 계획·초안 관문 모두 같은 칸", () => {
  const P = project("cons", true);
  const Q = "판정 대상 기기는 사용자 본인 폰 한 대로만 본다고 했어";
  const id = CL.constraintAdd(P.ws, Q, "판정 경계 기준", "", turnNow(P, Q), { axis: "alwaysBlocker" }).candidateId;
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]));
  assert.ok(CL.constraintAdd(P.ws, Q, "판정 경계 기준(재요청)", "", Object.assign({}, turnNow(P, Q), { again: true }), { axis: "supportedEnv" }).ok);
  const bad = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "archive" });
  assert.ok(!bad.ok && bad.error.includes("지원 환경"), "서고로는 거부 " + JSON.stringify(bad));
  const d1 = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "core" });
  assert.ok(d1.ok, JSON.stringify(d1));
  assert.ok(JSON.parse(CL.readEnvelopeProposal(P.ws, P.repo).proposalText).supportedEnv.includes(Q));
  const dis = CL.discardEnvelopeProposalRestoring(P.ws);
  assert.ok(dis && dis.ok !== false, "폐기(복원) " + JSON.stringify(dis));
  const d2 = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "core" });
  assert.ok(d2.ok && JSON.parse(CL.readEnvelopeProposal(P.ws, P.repo).proposalText).supportedEnv.includes(Q), "재작성=본문 지원 환경 " + JSON.stringify(d2));
  CL.discardEnvelopeProposal(P.ws);
  // 채택 고아(초안 결속 없음) → 조정이 proposed 로 복원(자동 전이 행 — 칸 표시값=유효 칸)
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "adopted", note: "draft x", ts: new Date().toISOString() }]));
  CL.reconcileMemoryCandidates(P.ws, P.repo, P.H);
  const lt = latestOf(P, id);
  assert.ok(lt && lt.status === "proposed" && lt.axis === "supportedEnv" && lt.submitted !== true, "복원 행=칸 표시값·실제 상신 아님 " + JSON.stringify(lt));
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), id), "supportedEnv");
  CL.writeEnvelopeFreeze(P.ws, P.H, "ask-cj-1");
  const cc = CB.computeEnvelopeCandidatesFor(P.ws);
  const mine = (cc.live || []).find((x) => x.candidateId === id);
  assert.ok(mine && mine.axis === "supportedEnv", "목록 칸 " + JSON.stringify(mine));
  assert.strictEqual(CL.candidateSingleDest({ kind: "user-constraint", axis: mine.axis, dest: "archive", gen0: false }), "core", "단건 목적지=본문");
  const plan = CL.candidateBatchPlan({ live: [{ candidateId: id, kind: "user-constraint", axis: mine.axis }], ids: [id], gen0: false, dest: "archive" });
  assert.ok(plan.take.length === 0 && plan.excluded[0].why === "axis-core-only", "한꺼번에(서고)=제외 " + JSON.stringify(plan));
  assert.ok(CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "core" }).ok, "초안 관문=본문");
  // 소스: 소비처가 유효 칸 함수를 쓴다
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8"), br = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  assert.ok(/const ax9 = effectiveCandidateAxis\(candRowsAll9, cid\);/.test(lib) && /axis: require\("\.\/contract-lib\.js"\)\.effectiveCandidateAxis\(candRows9, rec\.candidateId\)/.test(br) && (lib.match(/ucKeepFields\(rec, meta, candRows\)/g) || []).length === 2, "초안 관문·목록·자동 전이 행이 같은 함수");
});

t("③ --from — 이번 차례 전달 결과만 · 결과 칸 사용(--axis 우선·제안 칸 기록) · 자체 상신 한도 밖 · 결과=올림 · 다시 올림=거부", async () => {
  const P = project("from");
  const A = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
  const B = "검증할 때 외부 서버 연동 오류는 이번 프로젝트에서 다루지 않아";
  const C = "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 해";
  const rA = await boundary(P, A, "outOfScope"), rB = await boundary(P, B, "outOfScope"), rC = await boundary(P, C, "alwaysBlocker");
  const now = turnNow(P, "다음 단계 진행해 주세요 첫째 기준 문장은 이것이고 둘째 기준 문장은 저것이다");
  assert.ok(CF.markResultsDelivered(P.ws, [rA, rB, rC], now));
  assert.deepStrictEqual(CF.deliveredUndecided(P.ws, now).map((x) => x.resultId).sort(), [rA.resultId, rB.resultId, rC.resultId].sort());
  // 자체 상신 2건으로 한도를 채움
  assert.ok(CL.constraintAdd(P.ws, "첫째 기준 문장은 이것이고", "구현 담당 자체 상신", "", now).ok);
  assert.ok(CL.constraintAdd(P.ws, "둘째 기준 문장은 저것이다", "구현 담당 자체 상신", "", now).ok);
  assert.strictEqual(CL.constraintAdd(P.ws, "다음 단계 진행해 주세요", "구현 담당 자체 상신", "", now).reason, "turn-cap", "(전제) 자체 상신 한도");
  // 전달 결과 3건은 한도와 무관하게 모두 올릴 수 있음
  const fA = CL.constraintAdd(P.ws, A, "분류 결과를 보고 판단", "", now, { from: rA.resultId });
  assert.ok(fA.ok && fA.axis === "outOfScope" && fA.fromResult === rA.resultId && fA.resultMarked === true, JSON.stringify(fA));
  const fB = CL.constraintAdd(P.ws, B, "분류 결과를 보고 판단", "", now, { from: rB.resultId, axis: "alwaysBlocker" });
  assert.ok(fB.ok && fB.axis === "alwaysBlocker", JSON.stringify(fB));
  const rowB = rowsOf(P).filter((x) => x.candidateId === fB.candidateId).pop();
  assert.ok(rowB.axisSuggested === "outOfScope" && rowB.fromResult === rB.resultId && rowB.submitted === true, "--axis 우선·제안 칸 기록 " + JSON.stringify(rowB));
  const fC = CL.constraintAdd(P.ws, "사용자 원래 설정은 검증 뒤 언제나 되돌려", "분류 결과 일부 구절", "", now, { from: rC.resultId });
  assert.ok(fC.ok, "결과 인용 안의 구절=통과 " + JSON.stringify(fC));
  assert.ok(resStatus(P, rA.resultId) === "raised" && resStatus(P, rC.resultId) === "raised", "결과=올림");
  assert.strictEqual(CF.deliveredUndecided(P.ws, now).length, 0, "판단 끝");
  assert.strictEqual(CL.constraintAdd(P.ws, A, "다시", "", now, { from: rA.resultId }).reason, "from-not-delivered", "이미 판단한 결과=거부");
  // 결과 장부에 올림 행이 없어도 후보 장부의 fromResult 로 판단된 것으로 봄
  const rD = await boundary(P, "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다", "supportedEnv");
  const now2 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rD], now2);
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: "f".repeat(16), envelopeHash: P.H, virtualGen: true, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: "x", fromResult: rD.resultId, ts: new Date().toISOString() }]));
  assert.strictEqual(CF.deliveredUndecided(P.ws, now2).length, 0, "후보 장부 fromResult=판단됨");
});

t("③ --from 반례 — 교차 문장(결과 A id+다른 문장 B)=거부·무기록·A 미소비·자체 한도 미소비 · 전달 전/다른 차례/다른 회사=거부 · 원문 대조 면제 없음", async () => {
  const P = project("fromneg");
  const A = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
  const B = "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어";
  const rA = await boundary(P, A, "outOfScope");
  say(P, B);
  const now = turnNow(P, "다음 단계 진행해 주세요 자체 상신 문장은 이것으로 한다");
  const before = rowsOf(P).length;
  assert.strictEqual(CL.constraintAdd(P.ws, B, "교차", "", now, { from: rA.resultId }).reason, "from-not-delivered", "전달 전=거부");
  CF.markResultsDelivered(P.ws, [rA], now);
  assert.strictEqual(CL.constraintAdd(P.ws, B, "교차 문장", "", now, { from: rA.resultId }).reason, "from-quote-mismatch", "★교차 문장=거부");
  assert.strictEqual(rowsOf(P).length, before, "무기록");
  assert.strictEqual(CF.deliveredUndecided(P.ws, now).length, 1, "A 미소비");
  assert.ok(CL.constraintAdd(P.ws, "자체 상신 문장은 이것으로 한다", "자체", "", now).ok && CL.constraintAdd(P.ws, B, "자체", "", now).ok, "자체 한도 2건 그대로 남음");
  assert.strictEqual(CL.constraintAdd(P.ws, A, "다른 차례", "", turnNow(P), { from: rA.resultId }).reason, "from-not-delivered", "다른 차례=거부");
  assert.strictEqual(CL.constraintAdd(P.ws, A, "다른 회사", "", Object.assign({}, now, { provider: "codex" }), { from: rA.resultId }).reason, "from-not-delivered", "다른 회사(R3)=거부");
  assert.strictEqual(CL.constraintAdd(P.ws, A, "저장소 없음", "", Object.assign({}, now, { repoKey: null }), { from: rA.resultId }).reason, "from-not-delivered", "저장소 표식 없음=거부");
  // 원문 대조 면제 없음 — 사용자 말에 없는 인용의 결과(장부에 직접)를 전달해도 작문 거부
  const fake = { schema: "classify-result-v1", wsKey: CL.wsKeyFor(P.ws), repoKey: P.rk, resultId: "e".repeat(16), status: "new", kind: "boundary", quote: "사용자가 한 적 없는 지어낸 기준 문장입니다", why: "지어낸 결과", seat: "alwaysBlocker", bounds: "판정 영향", provider: "claude", ts: new Date().toISOString() };
  assert.ok(CF.appendClassifyResults(P.ws, [fake]));
  const now2 = turnNow(P);
  CF.markResultsDelivered(P.ws, [CF.readClassifyResults(P.ws).latest.get(fake.resultId)], now2);
  assert.strictEqual(CL.constraintAdd(P.ws, fake.quote, "지어냄", "", now2, { from: fake.resultId }).reason, "not-in-prompt", "★--from 도 원문 대조");
});

t("④ 안 올림(classify skip) — 이유 한 줄(형식·민감 형태) · 전달받은 미판단만 · 결과=안 올림+이유 · 자체 한도 무관 · 요약·화면 상태", async () => {
  const P = project("skip");
  const A = "검증 결과 보고는 매번 표 형식으로 정리해 줘야 해";
  const rA = await boundary(P, A, "alwaysBlocker");
  const now = turnNow(P);
  assert.strictEqual(CF.skipResult(P.ws, rA.resultId, "판정 경계 아님 일하는 방식", now).reason, "not-delivered", "전달 전=거부");
  CF.markResultsDelivered(P.ws, [rA], now);
  for (const bad of ["짧음", "여러 줄\n이유입니다 길게", "가".repeat(CL.CONSTRAINT_WHY_MAX + 1)]) assert.strictEqual(CF.skipResult(P.ws, rA.resultId, bad, now).reason, "note-format", JSON.stringify(bad));
  assert.ok(/^note-sensitive-/.test(CF.skipResult(P.ws, rA.resultId, "이유 C:\\work\\secret.txt 참고", now).reason), "민감 형태");
  assert.strictEqual(CF.skipResult(P.ws, rA.resultId, "보고 형식 요구라 판정 경계가 아님", { ok: false, reason: "no-session" }).reason, "no-session");
  const sk = CF.skipResult(P.ws, rA.resultId, "보고 형식 요구라 판정 경계가 아님", now);
  assert.ok(sk.ok, JSON.stringify(sk));
  const lr = CF.readClassifyResults(P.ws).latest.get(rA.resultId);
  assert.ok(lr.status === "skipped" && lr.note === "보고 형식 요구라 판정 경계가 아님" && lr.by === "implementer", JSON.stringify(lr));
  assert.strictEqual(CF.skipResult(P.ws, rA.resultId, "보고 형식 요구라 판정 경계가 아님", now).reason, "not-delivered", "이미 판단=거부");
  assert.ok(CL.constraintAdd(P.ws, "다음 단계 진행해 주세요", "자체", "", now).ok, "자체 한도 무관");
  const sm = CF.classifySummary(P.ws);
  assert.ok(sm.boundaryStatus && sm.boundaryStatus.skipped === 1 && sm.boundaryStatus.waiting === 0, JSON.stringify(sm.boundaryStatus));
  const v = CF.userWordsView(P.ws).results.boundary.find((x) => x.id === rA.resultId);
  assert.ok(v.status === "skipped" && v.note.includes("판정 경계가 아님"), JSON.stringify(v));
});

t("⑤ 명령줄 — constraint add --axis --from · classify skip --note (실제 실행 · 세션 차례 앵커)", async () => {
  const P = project("cli");
  const A = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
  const B = "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어";
  const rA = await boundary(P, A, "outOfScope"), rB = await boundary(P, B, "outOfScope");
  const SESS = "cj-cli-session";
  const now = turnNow(P);
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: P.ws, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: now.turnAnchor, constraintSourceHash: now.sourceHash, constraintRepoKey: P.rk }));
  CF.markResultsDelivered(P.ws, [rA, rB], Object.assign({}, now, { sessionId: SESS }));
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SESS });
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const run = (args) => cp.spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: P.ws });
  const bad = run(["constraint", "add", "--quote", A, "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "분류 결과를 보고 판단", "--axis", "nowhere"]);
  assert.ok(bad.status === 2 && /axis-invalid/.test(bad.stderr), bad.stderr);
  const ok = run(["constraint", "add", "--quote", A, "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "분류 결과를 보고 판단", "--from", rA.resultId]);
  assert.ok(ok.status === 0 && /칸 outOfScope/.test(ok.stdout) && new RegExp("분류 결과 " + rA.resultId).test(ok.stdout), ok.stdout + ok.stderr);
  const sk0 = run(["classify", "skip", rB.resultId, "--note", "짧음"]);
  assert.ok(sk0.status === 2 && /note-format/.test(sk0.stderr), sk0.stderr);
  const sk = run(["classify", "skip", rB.resultId, "--note", "이미 같은 뜻의 수칙이 있어", "안 올림"]);
  assert.ok(sk.status === 0 && /안 올림/.test(sk.stdout), sk.stdout + sk.stderr);
  assert.strictEqual(CF.readClassifyResults(P.ws).latest.get(rB.resultId).note, "이미 같은 뜻의 수칙이 있어 안 올림");
  const us = run(["classify", "nope"]);
  assert.ok(/skip <결과 id> --note|skip <result id> --note/.test(us.stdout), "사용법에 안 올림 " + us.stdout);
});

t("⑤ 대시보드 — 후보 카드 출처 줄(분류 결과에서 올림·칸) · 사용자 말 카드 판정 경계 상태(대기·올림·안 올림 이유·미처리·만료) — 컴파일 산출물 실제 실행", () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, remove() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const walk = (root) => { const all = []; const w = (x) => { all.push(x); (x.children || []).forEach(w); }; w(root); return all; };
  // 사용자 말 카드
  const b = outSrc.indexOf('safe(function(){ var uc=$("uwCard");'), e = outSrc.indexOf('safe(function(){ var n=$("vBudgetNote");', b);
  assert.ok(b > 0 && e > b);
  const uc = mkEl("div");
  const item = (id, status, extra) => Object.assign({ id: id.repeat(16), status, quote: "인용 " + id, why: "근거", seat: "outOfScope", bounds: "영향", ts: "2026-10-10T00:00:00.000Z" }, extra || {});
  const d = { userWords: { wsKey: "w", repoKey: "rk", summary: { queued: 0, lastTs: "", repoKey: "rk", results: { boundary: 5, emphasis: 0, style: 0 }, boundaryStatus: { waiting: 1, raised: 1, skipped: 1, unhandled: 1, expired: 1 } },
    results: { boundary: [item("1", "delivered"), item("2", "raised"), item("3", "skipped", { note: "보고 형식 요구라 판정 경계 아님" }), item("4", "unhandled"), item("5", "expired")], emphasis: [], style: [] }, held: [] } };
  new Function("document", "$", "T", "d", "vscode", "safe", require("./_rf-prelude.js").RFP + outSrc.slice(b, e))({ createElement: mkEl }, (id) => (id === "uwCard" ? uc : null), (a) => a, d, { postMessage() {} }, (f) => f());
  const txt = walk(uc).map((x) => x.textContent).join(" | ");
  assert.ok(txt.includes("판정 경계 — 구현 담당 판단 대기 1 · 올림 1 · 안 올림 1 · 구현 담당 미처리 1 · 원문 만료 1"), "상태 요약 " + txt.slice(0, 300));
  for (const k of ["구현 담당 판단 대기", "구현 담당이 올림 — 위 '수칙' 카드에서 승인", "구현 담당이 안 올림 — 이유: 보고 형식 요구라 판정 경계 아님", "두 번 넘겨받고도 판단하지 않았어요", "원문 보관 기간(7일)이 지나"]) assert.ok(txt.includes(k), "상태 줄: " + k);
  assert.strictEqual(walk(uc).filter((x) => x.tag === "button").length, 0, "버튼 없음");
  // 후보 카드 출처 줄
  const b2 = outSrc.indexOf('safe(function(){ var ec=$("envCard");'), e2 = outSrc.indexOf('safe(function(){ var uc=$("uwCard");', b2);
  assert.ok(b2 > 0 && e2 > b2);
  const ec = mkEl("div");
  const body = "var wbGen='', wbAdds=new Set(), wbRemoves=new Set(), candsMoreOpenWeb=false, signalsOpenWeb=false, rulesOpenWeb=false;\n" + outSrc.slice(b2, e2);
  const cand = { id: "a".repeat(16), kind: "user-constraint", n: 1, title: "실기기 확인은 범위 밖", status: "proposed", gen: "g", wsKey: "wk", ts: "2026-10-10T00:00:00.000Z", axis: "outOfScope", fromResult: true, why: "분류 결과를 보고 판단" };
  new Function("document", "$", "T", "d", "vscode", "safe", require("./_rf-prelude.js").RFP + body)({ createElement: mkEl }, (id) => (id === "envCard" ? ec : null), (a) => a, { envelope: { label: "x", gen: "g", wsKey: "wk", lang: "ko", gen0: false, cands: [cand] }, lang: "ko" }, { postMessage() {} }, (f) => f());
  const t2 = walk(ec).map((x) => x.textContent).join(" | ");
  assert.ok(t2.includes("분류 담당이 판정 경계로 고르고, 구현 담당이 판단해 올렸어요 — 수칙서 '범위 밖' 칸") && t2.includes("어디로: 수칙서 본문 '범위 밖' 칸"), "출처 줄 " + t2.slice(0, 400));
});

// ── [검증 1회차 blocker 3건] ──
t("★결과 판단 표식(검증 1~3회차) — 같은 결과로 여러 상신이 동시에 와도 후보는 하나(실제 프로세스 4개 동시 실행) · 미판단 확인 뒤 다른 판단이 끼어들면(올림·안 올림 각각) 늦은 쪽은 무기록 거부 · 표식만 남고 기록이 빠지면 다음 판단 때 채움 · 표식 판독 불가=판단됨", async () => {
  const P = project("claim");
  const A = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자 그렇게 하자";
  const rA = await boundary(P, A, "outOfScope");
  const SESS = "cj-claim-session";
  const now = turnNow(P);
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: P.ws, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: now.turnAnchor, constraintSourceHash: now.sourceHash, constraintRepoKey: P.rk }));
  CF.markResultsDelivered(P.ws, [rA], Object.assign({}, now, { sessionId: SESS }));
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SESS });
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const quotes = [A, "실기기 최신폰 확인은 이번 단계 범위 밖이라고", "최신폰 확인은 이번 단계 범위 밖이라고 계속 보자", "이번 단계 범위 밖이라고 계속 보자 그렇게"];
  const runs = await Promise.all(quotes.map((q) => new Promise((res) => { const ch = cp.spawn(process.execPath, [cli, "constraint", "add", "--quote", q, "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "분류 결과를 보고 판단", "--from", rA.resultId], { env, cwd: P.ws, windowsHide: true }); let so = "", se = ""; ch.stdout.on("data", (d) => { so += d; }); ch.stderr.on("data", (d) => { se += d; }); ch.on("close", (code) => res({ code, so, se })); })));
  const okN = runs.filter((r) => r.code === 0).length;
  const withFrom = rowsOf(P).filter((x) => x.fromResult === rA.resultId);
  assert.ok(okN === 1 && new Set(withFrom.map((x) => x.candidateId)).size === 1, "★결과 하나=후보 하나 " + JSON.stringify(runs.map((r) => [r.code, (r.so + r.se).slice(0, 90)])));
  assert.ok(runs.filter((r) => r.code !== 0).every((r) => /from-not-delivered/.test(r.se)), "나머지=무기록 거부");
  assert.ok(fs.existsSync(CF.claimFileFor(P.ws, rA.resultId)), "판단 표식");
  // 끼어들기(올림): 미판단 확인을 마친 뒤 표식을 만들기 직전에 다른 실행이 같은 결과를 다른 구절로 올림 → 늦은 쪽은 거부·무기록
  const B = "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어 그렇게 보자";
  const rB = await boundary(P, B, "outOfScope");
  const now2 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rB], now2);
  let inner = null;
  const late = CL.constraintAdd(P.ws, B, "늦은 쪽", "", now2, { from: rB.resultId, __testBeforeClaim() { inner = CL.constraintAdd(P.ws, "외부 서버 연동 오류는 이번 프로젝트에서", "먼저 판단한 쪽", "", now2, { from: rB.resultId }); } });
  assert.ok(inner && inner.ok && !late.ok && late.reason === "from-not-delivered", "★끼어든 판단이 이김·늦은 쪽 거부 " + JSON.stringify([inner, late]));
  assert.strictEqual(new Set(rowsOf(P).filter((x) => x.fromResult === rB.resultId).map((x) => x.candidateId)).size, 1, "★후보 하나");
  // 끼어들기(안 올림 vs 올림)
  const C = "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어";
  const rC = await boundary(P, C, "supportedEnv");
  const now3 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rC], now3);
  let innerC = null;
  const lateSkip = CF.skipResult(P.ws, rC.resultId, "끼어들기 시험용 안 올림 이유", now3, { beforeClaim() { innerC = CL.constraintAdd(P.ws, C, "먼저 올린 쪽", "", now3, { from: rC.resultId }); } });
  assert.ok(innerC && innerC.ok && !lateSkip.ok && lateSkip.reason === "not-delivered", "★안 올림이 늦으면 거부 " + JSON.stringify([innerC, lateSkip]));
  assert.notStrictEqual(CF.readClassifyResults(P.ws).latest.get(rC.resultId).status, "skipped", "안 올림 기록 없음");
  // 표식만 남고 기록이 빠짐(표식 뒤 꺼짐) → 그 결과는 이미 판단됨 · 다음 판단(쓰기 경로) 때 빠진 기록을 채움
  const D = "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 한다고 했어";
  const rD = await boundary(P, D, "alwaysBlocker");
  const now4 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rD], now4);
  const candRow = { candidateId: "c".repeat(16), envelopeHash: CL.GEN0_HASH, virtualGen: true, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: D, why: "표식 뒤 꺼진 판단", submitted: true, axis: "alwaysBlocker", fromResult: rD.resultId, ts: new Date().toISOString() };
  const resRow = CF.resultStatusRow(P.ws, CF.readClassifyResults(P.ws).latest.get(rD.resultId), "raised", { candidateId: candRow.candidateId, by: "implementer", turnAnchor: now4.turnAnchor });
  assert.strictEqual(CF.claimResult(P.ws, rD.resultId, { schema: "classify-claim-v1", resultId: rD.resultId, decision: "raised", candidateId: candRow.candidateId, candidateRow: candRow, resultRow: resRow }), "claimed");
  assert.strictEqual(CF.claimResult(P.ws, rD.resultId, { decision: "raised" }), "taken", "두 번째 표식=불가");
  assert.strictEqual(CF.deliveredUndecided(P.ws, now4).length, 0, "표식만 있어도 판단됨");
  assert.ok(!rowsOf(P).some((x) => x.fromResult === rD.resultId), "(전제) 후보 기록 빠짐");
  const rE = await boundary(P, "검증 보고는 매번 바뀐 파일 목록을 함께 남겨야 한다고 했어", "alwaysBlocker");
  const now5 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rE], now5); // 쓰기 경로 — 빠진 기록 채움
  assert.ok(rowsOf(P).some((x) => x.fromResult === rD.resultId && x.candidateId === candRow.candidateId), "★후보 기록 채움");
  assert.strictEqual(CF.readClassifyResults(P.ws).latest.get(rD.resultId).status, "raised", "★결과 기록 채움");
  const before = rowsOf(P).length; CF.repairClaims(P.ws); assert.strictEqual(rowsOf(P).length, before, "채움은 멱등");
  // 표식 판독 불가=판단된 것으로(fail-closed) — 손상된 표식 파일
  fs.writeFileSync(CF.claimFileFor(P.ws, rE.resultId), "{ 손상");
  assert.strictEqual(CF.deliveredUndecided(P.ws, now5).length, 0, "손상 표식=판단됨");
  assert.strictEqual(CF.skipResult(P.ws, rE.resultId, "손상 표식 뒤 안 올림 시도", now5).reason, "not-delivered");
  // 소스: 후보 기록은 표식을 만든 뒤에만(올림) · 안 올림도 같은 표식
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  assert.ok(/const cr9 = CFc\.claimResult\(ws, fromRes\.resultId,[^\n]*\n\s*if \(cr9 === "taken"\) return reject\("from-not-delivered"\);[^\n]*\n\s*if \(cr9 !== "claimed"\) return reject\("from-claim-io"\);\s*\n\s*\}\s*\n\s*if \(!appendEnvelopeCandidates\(ws, \[rec\]\)\)/.test(lib), "올림=표식 뒤 기록");
  assert.ok(!/withJudgeLock|__stillMine/.test(lib + fs.readFileSync(path.join(ROOT, "bridge", "classify.js"), "utf8")), "잠금 방식 잔재 없음");
});

t("★값 없는 --from=거부(일반 상신으로 바꾸지 않음 · 무기록 · 자체 한도 미소비) — 함수·명령줄", async () => {
  const P = project("fromempty");
  const now = turnNow(P, "첫째 기준 문장은 이것이고 둘째 기준 문장은 저것이다 셋째도 있다");
  const before = rowsOf(P).length;
  for (const v of ["", "   ", null, undefined]) assert.strictEqual(CL.constraintAdd(P.ws, "첫째 기준 문장은 이것이고", "판단", "", now, { from: v }).reason, "from-missing", "from=" + JSON.stringify(v));
  assert.strictEqual(rowsOf(P).length, before, "무기록");
  assert.ok(CL.constraintAdd(P.ws, "첫째 기준 문장은 이것이고", "자체", "", now).ok && CL.constraintAdd(P.ws, "둘째 기준 문장은 저것이다", "자체", "", now).ok, "자체 한도 2건 그대로");
  const SESS = "cj-empty-session";
  const now2 = turnNow(P, "명령줄 확인용 기준 문장은 이것으로 한다");
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: P.ws, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: now2.turnAnchor, constraintSourceHash: now2.sourceHash, constraintRepoKey: P.rk }));
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SESS });
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "constraint", "add", "--quote", "명령줄 확인용 기준 문장은 이것으로 한다", "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "판단", "--from"], { env, encoding: "utf8", cwd: P.ws });
  assert.ok(r.status === 2 && /from-missing/.test(r.stderr), r.stdout + r.stderr);
  assert.strictEqual(rowsOf(P).length, before + 2, "명령줄도 무기록");
});

t("★화면 자료 변환까지 — 실제 후보 집계(computeEnvelopeCandidatesFor) → 대시보드 자료 변환(컴파일 산출물) → 후보 카드 출처 줄", async () => {
  const P = project("viewchain");
  const A = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
  const rA = await boundary(P, A, "outOfScope");
  const now = turnNow(P);
  CF.markResultsDelivered(P.ws, [rA], now);
  const id = CL.constraintAdd(P.ws, A, "분류 결과를 보고 판단", "", now, { from: rA.resultId }).candidateId;
  CL.writeEnvelopeFreeze(P.ws, CL.GEN0_HASH, "ask-cj-view");
  const cc9 = CB.computeEnvelopeCandidatesFor(P.ws);
  assert.ok((cc9.live || []).some((c) => c.candidateId === id && c.fromResult === true && c.axis === "outOfScope"), "집계 " + JSON.stringify(cc9.live));
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const i = outSrc.indexOf("const out9 = (cc9.live || []).map(");
  const j = outSrc.indexOf("\n", i);
  assert.ok(i > 0 && j > i, "변환 조각");
  const conv = new Function("cc9", "lat9", "genC9", "CL9", "ws", outSrc.slice(i, j) + "\nreturn out9;")(cc9, CL.readEnvelopeCandidates(P.ws).latest, CL.GEN0_HASH, CL, P.ws);
  const mine = conv.find((x) => x.id === id);
  assert.ok(mine && mine.fromResult === true && mine.axis === "outOfScope", "★변환 뒤에도 출처 표시 " + JSON.stringify(mine));
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, remove() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const b2 = outSrc.indexOf('safe(function(){ var ec=$("envCard");'), e2 = outSrc.indexOf('safe(function(){ var uc=$("uwCard");', b2);
  const ec = mkEl("div");
  new Function("document", "$", "T", "d", "vscode", "safe", require("./_rf-prelude.js").RFP + "var wbGen='', wbAdds=new Set(), wbRemoves=new Set(), candsMoreOpenWeb=false, signalsOpenWeb=false, rulesOpenWeb=false;\n" + outSrc.slice(b2, e2))({ createElement: mkEl }, (x) => (x === "envCard" ? ec : null), (a) => a, { envelope: { label: "x", gen: CL.GEN0_HASH, wsKey: mine.wsKey, lang: "ko", gen0: true, cands: conv }, lang: "ko" }, { postMessage() {} }, (f) => f());
  const all = []; const w = (x) => { all.push(x); (x.children || []).forEach(w); }; w(ec);
  assert.ok(all.map((x) => x.textContent).join(" | ").includes("구현 담당이 판단해 올렸어요 — 수칙서 '범위 밖' 칸"), "카드 출처 줄");
});

// ── [검증 4회차 blocker 2건·보완 1건] ──
t("★표식은 내용을 다 쓴 뒤에만 생김(쓰는 도중 꺼져도 빈 표식 없음) · 같은 결과의 늦은 중복 행은 거절·재상신을 되돌리지 못함 · 모든 상신은 지난 판단 기록부터 채움 · 기록 실패 시 명령줄 안내=표식만 저장", async () => {
  const P = project("claim4");
  // (가) 표식 쓰는 도중 꺼짐 재현 — 파일은 생겼는데 내용을 쓰기 전에 실패
  const A = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
  const rA = await boundary(P, A, "outOfScope");
  const now = turnNow(P);
  CF.markResultsDelivered(P.ws, [rA], now);
  const fin = CF.claimFileFor(P.ws, rA.resultId), dir = path.dirname(fin);
  const realW = fs.writeFileSync, realL = fs.linkSync;
  let cr;
  fs.writeFileSync = function (f, d, o) { if (String(f).startsWith(dir)) { realW(f, "", o); const e = new Error("꺼짐 재현"); e.code = "EIO"; throw e; } return realW.apply(fs, arguments); };
  try { cr = CF.claimResult(P.ws, rA.resultId, { decision: "skipped" }); } finally { fs.writeFileSync = realW; }
  assert.strictEqual(cr, "io");
  assert.ok(!fs.existsSync(fin), "★빈 표식 없음");
  assert.ok(!fs.readdirSync(dir).some((x) => x.endsWith(".tmp")), "임시 파일 정리");
  assert.strictEqual(CF.deliveredUndecided(P.ws, now).length, 1, "★결과는 미판단 그대로(다시 판단 가능)");
  fs.linkSync = () => { const e = new Error("연결 실패 재현"); e.code = "EIO"; throw e; };
  try { cr = CF.claimResult(P.ws, rA.resultId, { decision: "skipped" }); } finally { fs.linkSync = realL; }
  assert.ok(cr === "io" && !fs.existsSync(fin) && !fs.readdirSync(dir).some((x) => x.endsWith(".tmp")), "연결 실패=io·표식 없음");
  // 임시 파일까지 쓰고 연결 전에 꺼짐(정리도 못 함) → 판단 안 된 것 · 정상 판단 가능 · 오래된 임시 파일만 다음 채우기 때 정리
  const stray = fin + ".999.abcdef.tmp", fresh = fin + ".998.abcdef.tmp";
  realW(stray, JSON.stringify({ decision: "raised" }));
  assert.strictEqual(CF.deliveredUndecided(P.ws, now).length, 1, "임시 파일만=판단 안 됨");
  const sk = CF.skipResult(P.ws, rA.resultId, "꺼짐 재현 뒤 정상 안 올림", now);
  assert.ok(sk.ok && !sk.pendingRepair && resStatus(P, rA.resultId) === "skipped", JSON.stringify(sk));
  const old = new Date(Date.now() - 2 * 3600 * 1000); fs.utimesSync(stray, old, old); realW(fresh, "x");
  CF.repairClaims(P.ws);
  assert.ok(!fs.existsSync(stray) && fs.existsSync(fresh), "오래된 임시 파일만 정리");
  fs.rmSync(fresh);
  const cls = fs.readFileSync(path.join(ROOT, "bridge", "classify.js"), "utf8");
  const body = cls.slice(cls.indexOf("function claimResult("), cls.indexOf("function readClaims("));
  assert.ok(/fs\.linkSync\(tmp, fin\)/.test(body) && !/writeFileSync\(fin/.test(body) && !/writeFileSync\(claimFileFor/.test(body), "소스: 표식 자리는 연결로만 생김");

  // (나) 후보 장부 기록 실패(표식만 남음) — 명령줄 안내
  const B = "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어";
  const rB = await boundary(P, B, "outOfScope");
  const SESS = "cj-claim4-session";
  const now2 = turnNow(P);
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: P.ws, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: now2.turnAnchor, constraintSourceHash: now2.sourceHash, constraintRepoKey: P.rk }));
  CF.markResultsDelivered(P.ws, [rB], Object.assign({}, now2, { sessionId: SESS }));
  const candF = CL.envelopeCandidatesFileFor(P.ws);
  fs.mkdirSync(path.dirname(candF), { recursive: true }); if (!fs.existsSync(candF)) fs.writeFileSync(candF, "");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SESS });
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  let out;
  fs.chmodSync(candF, 0o444);
  try { out = cp.spawnSync(process.execPath, [cli, "constraint", "add", "--quote", B, "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "분류 결과를 보고 판단", "--from", rB.resultId], { env, encoding: "utf8", cwd: P.ws }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(out.status === 0 && /판단 저장됨\(표식만\)/.test(out.stdout) && /장부 반영은 다음 판단 때 채워집니다/.test(out.stdout) && !/후보 장부에 기록됐습니다/.test(out.stdout), "★표식만 저장 안내 " + out.stdout + out.stderr);
  const claimB = JSON.parse(fs.readFileSync(CF.claimFileFor(P.ws, rB.resultId), "utf8"));
  const cid = claimB.candidateId;
  assert.ok(!rowsOf(P).some((x) => x.fromResult === rB.resultId), "(전제) 후보 기록 빠짐");

  // (다) 겹친 채우기·늦은 원래 작성자 — 채우기 B → 사용자 거절 → 대화로 다시 요청해 다른 칸으로 재상신 → 옛 판독의 채우기 A·원래 작성자가 늦게 덧붙임
  CF.repairClaims(P.ws);
  const filled = rowsOf(P).filter((x) => x.fromResult === rB.resultId);
  assert.ok(filled.length === 1 && filled[0].repaired === true && filled[0].axis === "outOfScope" && latestOf(P, cid).status === "proposed", JSON.stringify(filled));
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: cid, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]);
  const re = CL.constraintAdd(P.ws, B, "사용자가 다시 요청해 칸을 바꿔 재상신", "", Object.assign(turnNow(P), { again: true }), { axis: "supportedEnv" });
  assert.ok(re.ok && re.candidateId === cid, JSON.stringify(re));
  CL.appendEnvelopeCandidates(P.ws, [Object.assign({}, claimB.candidateRow, { repaired: true })]); // 겹친 채우기 A(옛 판독)
  CL.appendEnvelopeCandidates(P.ws, [claimB.candidateRow]); // 원래 작성자가 늦게 깨어남
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), cid), "supportedEnv", "★늦은 중복 행이 재상신 칸을 되돌리지 못함");
  assert.ok(latestOf(P, cid).axis === "supportedEnv" && latestOf(P, cid).status === "proposed" && latestOf(P, cid).reraised === true, JSON.stringify(latestOf(P, cid)));
  assert.strictEqual(rowsOf(P).filter((x) => x.fromResult === rB.resultId && x.submitted === true).length, 1, "같은 결과의 상신 행은 첫 행 하나만 유효");
  assert.strictEqual(fs.readFileSync(candF, "utf8").split("\n").filter((l) => l.includes(rB.resultId) && l.includes('"submitted":true')).length, 3, "장부 원본은 그대로 보존");
  // 채우기 뒤 사용자 거절 → 늦은 중복 행(재요청 표지 포함)이 거절·거절 기억을 되돌리지 못함
  const C = "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어";
  const rC = await boundary(P, C, "supportedEnv");
  const now4 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rC], now4);
  let rc;
  fs.chmodSync(candF, 0o444);
  try { rc = CL.constraintAdd(P.ws, C, "표식만 남는 상신", "", Object.assign({}, now4, { again: true }), { from: rC.resultId }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(rc.ok && rc.pendingRepair === true, JSON.stringify(rc));
  const claimC = JSON.parse(fs.readFileSync(CF.claimFileFor(P.ws, rC.resultId), "utf8"));
  assert.strictEqual(claimC.candidateRow.reraised, true, "(전제) 재요청 표지 실린 행");
  CF.repairClaims(P.ws);
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: claimC.candidateId, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]);
  CL.appendEnvelopeCandidates(P.ws, [Object.assign({}, claimC.candidateRow, { repaired: true })]);
  assert.strictEqual(latestOf(P, claimC.candidateId).status, "declined", "★늦은 중복 행이 사용자 거절을 되돌리지 못함");
  assert.ok(CL.userDeclinedCandidate(rowsOf(P), claimC.candidateId), "★거절 기억 유지");

  // (라) 표식만 남은 지난 판단은 다음 일반 상신이 먼저 장부에 채운 뒤 새 상신을 판정(같은 말=이미 올라 있음)
  const D = "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 한다고 했어";
  const rD = await boundary(P, D, "alwaysBlocker");
  const now5 = turnNow(P);
  CF.markResultsDelivered(P.ws, [rD], now5);
  let rd;
  fs.chmodSync(candF, 0o444);
  try { rd = CL.constraintAdd(P.ws, D, "표식만 남는 상신", "", now5, { from: rD.resultId }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(rd.ok && rd.pendingRepair === true, JSON.stringify(rd));
  const n0 = fs.readFileSync(candF, "utf8");
  assert.strictEqual(CL.constraintAdd(P.ws, D, "형식 거부 확인", "", turnNow(P), { axis: "nowhere" }).reason, "axis-invalid");
  assert.strictEqual(CL.constraintAdd(P.ws, "이 문장은 원문 어디에도 없는 기준 문장입니다", "원문 대조 거부 확인", "", turnNow(P)).reason, "not-in-prompt");
  assert.strictEqual(fs.readFileSync(candF, "utf8"), n0, "★형식·원문 대조 거부=아무것도 쓰지 않음(지난 판단 채우기도 안 함)");
  const plain = CL.constraintAdd(P.ws, D, "같은 말을 일반 상신으로 다시", "", turnNow(P), { axis: "outOfScope" });
  assert.strictEqual(plain.reason, "duplicate", "★지난 판단이 먼저 장부에 반영된 뒤 새 상신을 판정 " + JSON.stringify(plain));
  assert.ok(rowsOf(P).some((x) => x.fromResult === rD.resultId && x.repaired === true), "채움 행");
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), rd.candidateId), "alwaysBlocker");
});

// ── [검증 5회차 blocker] ──
t("★채우기가 실패해 같은 문장의 지난 판단이 장부에 없으면 새 상신을 받지 않음(무기록) — 다시 시도하면 채운 뒤 판정 · 다른 문장의 미반영 판단은 막지 않음", async () => {
  const P = project("claim5");
  const E = "검증 보고는 매번 바뀐 파일 목록을 함께 남겨야 한다고 했어";
  const rE = await boundary(P, E, "outOfScope");
  const now = turnNow(P);
  CF.markResultsDelivered(P.ws, [rE], now);
  const candF = CL.envelopeCandidatesFileFor(P.ws);
  fs.mkdirSync(path.dirname(candF), { recursive: true }); if (!fs.existsSync(candF)) fs.writeFileSync(candF, "");
  let rd;
  fs.chmodSync(candF, 0o444);
  try { rd = CL.constraintAdd(P.ws, E, "표식만 남는 상신", "", now, { from: rE.resultId }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(rd.ok && rd.pendingRepair === true && rd.axis === "outOfScope", JSON.stringify(rd));
  // 채우기 덧붙이기가 한 번 실패(그 뒤 회복) — 그 사이 같은 문장을 다른 칸으로 일반 상신
  const realA = CL.appendEnvelopeCandidates;
  let failN = 1;
  CL.appendEnvelopeCandidates = function (ws, recs) { if (failN > 0 && (recs || []).some((r) => r && r.repaired === true)) { failN--; return false; } return realA.apply(this, arguments); };
  const before = fs.readFileSync(candF, "utf8");
  let r1;
  try { r1 = CL.constraintAdd(P.ws, E, "같은 말을 다른 칸으로 일반 상신", "", turnNow(P), { axis: "supportedEnv" }); } finally { CL.appendEnvelopeCandidates = realA; }
  assert.strictEqual(r1.reason, "prior-decision-pending", "★지난 판단 미반영=새 상신 거부 " + JSON.stringify(r1));
  assert.strictEqual(fs.readFileSync(candF, "utf8"), before, "무기록");
  // 다시 시도 → 지난 판단부터 채움 → 같은 말은 이미 올라 있음
  const r2 = CL.constraintAdd(P.ws, E, "같은 말을 다른 칸으로 일반 상신", "", turnNow(P), { axis: "supportedEnv" });
  assert.strictEqual(r2.reason, "duplicate", JSON.stringify(r2));
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), rd.candidateId), "outOfScope", "지난 판단 반영");
  // 사용자가 거절 뒤 대화로 다시 요청 → 다른 칸 재상신 → 그 칸이 유지(늦게 덮일 옛 행 없음)
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: rd.candidateId, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]);
  const r3 = CL.constraintAdd(P.ws, E, "사용자 재요청 재상신", "", Object.assign(turnNow(P), { again: true }), { axis: "supportedEnv" });
  assert.ok(r3.ok && r3.candidateId === rd.candidateId, JSON.stringify(r3));
  CF.repairClaims(P.ws);
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), rd.candidateId), "supportedEnv", "★재상신 칸 유지");
  // 다른 문장의 미반영 판단(채우기가 계속 실패)은 이 문장의 상신을 막지 않음
  const F = "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어";
  const rF = await boundary(P, F, "outOfScope");
  const nowF = turnNow(P);
  CF.markResultsDelivered(P.ws, [rF], nowF);
  let rf;
  fs.chmodSync(candF, 0o444);
  try { rf = CL.constraintAdd(P.ws, F, "표식만 남는 상신", "", nowF, { from: rF.resultId }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(rf.ok && rf.pendingRepair === true, JSON.stringify(rf));
  const G = "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 한다고 했어";
  CL.appendEnvelopeCandidates = function (ws, recs) { if ((recs || []).some((r) => r && r.repaired === true)) return false; return realA.apply(this, arguments); };
  let rg;
  try { rg = CL.constraintAdd(P.ws, G, "다른 문장 일반 상신", "", turnNow(P, "기억해: " + G)); } finally { CL.appendEnvelopeCandidates = realA; }
  assert.ok(rg.ok, "★다른 문장은 막지 않음 " + JSON.stringify(rg));
  assert.strictEqual(CF.unfilledRaisedClaims(P.ws, rf.candidateId).length, 1, "(전제) F 는 아직 미반영");
  // 명령줄 — 장부를 쓸 수 없어 F 채우기가 실패하는 동안 F 와 같은 문장 일반 상신=거부 안내(무기록)
  const SESS = "cj-claim5-session";
  const nowC = turnNow(P);
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: P.ws, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: nowC.turnAnchor, constraintSourceHash: nowC.sourceHash, constraintRepoKey: P.rk }));
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SESS });
  let o;
  fs.chmodSync(candF, 0o444);
  try { o = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "constraint", "add", "--quote", F, "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "같은 말 일반 상신"], { env, encoding: "utf8", cwd: P.ws }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(o.status !== 0 && /prior-decision-pending/.test(o.stderr) && /지난 판단부터 채운 뒤 판정/.test(o.stderr), "★명령줄 거부 안내 " + o.stdout + o.stderr);
});

// ── [검증 6회차 blocker] ──
t("★지난 판단 표식을 잠시 읽지 못하면(파일·폴더 판독 오류) 새 상신을 받지 않음(무기록) — 회복 뒤 채운 다음 판정 · 내용 형식이 불량한 표식은 다른 문장을 막지 않음", async () => {
  const P = project("claim6");
  const H = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
  const rH = await boundary(P, H, "outOfScope");
  const now = turnNow(P);
  CF.markResultsDelivered(P.ws, [rH], now);
  const candF = CL.envelopeCandidatesFileFor(P.ws);
  fs.mkdirSync(path.dirname(candF), { recursive: true }); if (!fs.existsSync(candF)) fs.writeFileSync(candF, "");
  let rh;
  fs.chmodSync(candF, 0o444);
  try { rh = CL.constraintAdd(P.ws, H, "표식만 남는 상신", "", now, { from: rH.resultId }); } finally { fs.chmodSync(candF, 0o666); }
  assert.ok(rh.ok && rh.pendingRepair === true && rh.axis === "outOfScope", JSON.stringify(rh));
  const claimF = CF.claimFileFor(P.ws, rH.resultId), claimD = path.dirname(claimF);
  const eacces = () => { const e = new Error("일시적 판독 실패 재현"); e.code = "EACCES"; return e; };
  const before = fs.readFileSync(candF, "utf8");
  // (가) 표식 파일을 잠시 읽지 못함
  const realR = fs.readFileSync, realD = fs.readdirSync;
  fs.readFileSync = function (f) { if (String(f) === claimF) throw eacces(); return realR.apply(fs, arguments); };
  let r1; try { r1 = CL.constraintAdd(P.ws, H, "판독 실패 중 같은 말 일반 상신", "", turnNow(P), { axis: "supportedEnv" }); } finally { fs.readFileSync = realR; }
  assert.strictEqual(r1.reason, "prior-decision-unreadable", "★표식 파일 판독 실패=새 상신 거부 " + JSON.stringify(r1));
  // (나) 표식 폴더 목록을 잠시 읽지 못함
  fs.readdirSync = function (d) { if (String(d) === claimD) throw eacces(); return realD.apply(fs, arguments); };
  let r2; try { r2 = CL.constraintAdd(P.ws, H, "판독 실패 중 같은 말 일반 상신", "", turnNow(P), { axis: "supportedEnv" }); } finally { fs.readdirSync = realD; }
  assert.strictEqual(r2.reason, "prior-decision-unreadable", "★표식 폴더 판독 실패=새 상신 거부 " + JSON.stringify(r2));
  assert.strictEqual(fs.readFileSync(candF, "utf8"), before, "무기록");
  assert.strictEqual(CF.readClaimsState(P.ws).readError, false, "(전제) 회복");
  // 회복 뒤 다시 시도 → 지난 판단부터 채움 → 같은 말은 이미 올라 있음 · 칸은 지난 판단 그대로
  const r3 = CL.constraintAdd(P.ws, H, "회복 뒤 같은 말 일반 상신", "", turnNow(P), { axis: "supportedEnv" });
  assert.strictEqual(r3.reason, "duplicate", JSON.stringify(r3));
  assert.strictEqual(CL.effectiveCandidateAxis(rowsOf(P), rh.candidateId), "outOfScope");
  // 폴더 없음(표식 한 번도 없음)=판독 오류 아님
  const P2 = project("claim6b");
  assert.deepStrictEqual(CF.readClaimsState(P2.ws), { claims: [], readError: false });
  const Q2 = "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어";
  assert.ok(CL.constraintAdd(P2.ws, Q2, "표식 없는 프로젝트 일반 상신", "", turnNow(P2, "기억해: " + Q2)).ok, "표식 폴더 없음=정상 상신");
  // 내용 형식이 불량한 표식(영구 — 채울 내용 없음)은 다른 문장 상신을 막지 않음
  fs.writeFileSync(path.join(claimD, "f".repeat(16) + ".json"), "{ 손상");
  const st = CF.readClaimsState(P.ws);
  assert.ok(!st.readError && st.claims.some((c) => c.resultId === "f".repeat(16) && c.claim === null), JSON.stringify(st));
  const Q3 = "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 한다고 했어";
  assert.ok(CL.constraintAdd(P.ws, Q3, "불량 표식이 있어도 다른 문장 상신", "", turnNow(P, "기억해: " + Q3)).ok, "★형식 불량 표식은 막지 않음");
  // 명령줄 사유 문구
  const cbSrc = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  assert.ok(/"prior-decision-unreadable": \[en \? "earlier decision marks[^\n]*확인할 수 없습니다 — 아무것도 올리지 않았습니다/.test(cbSrc), "명령줄 사유 문구");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
