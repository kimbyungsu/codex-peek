"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-나-1 §3-1·§3-2] 사용자 말 수집 — 선택지 직접 입력 원문 기록 + 미분류 대기열 + 원문 대조 확장.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입). 훅 결선은 contract-inject.js·verify-guard.js 를 자식 프로세스로 실제 실행.
 * 결속 계약(검증 1·2회차 f-9ee8024b): 답은 수집 시점도 시각도 아니라 대화 기록의 차례 열쇠(promptId)로 세션 차례 기록에서 차례·저장소를 찾는다.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uwords-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NL = String.fromCharCode(10);
const RA = "a".repeat(16), RB = "b".repeat(16);
const T0 = "2026-10-04T10:00:00.000Z", T1 = "2026-10-04T10:05:00.000Z", T2 = "2026-10-04T10:10:00.000Z", T3 = "2026-10-04T10:15:00.000Z";
// 실제 대화 기록과 같은 모양의 선택지 결과 줄
const choiceLine = (toolUseId, qs, answers, ann, ts, pid) => JSON.stringify({ type: "user", promptId: pid || "pid-A", timestamp: ts || T1, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "answered" }] }, toolUseResult: Object.assign({ questions: qs, answers }, ann ? { annotations: ann } : {}) });
const promptLine = (pid, text, ts) => JSON.stringify({ type: "user", promptId: pid, timestamp: ts || T0, origin: { kind: "human" }, message: { role: "user", content: text } });
const Q1 = { question: "분류 상한을 둘까요?", header: "상한", multiSelect: false, options: [{ label: "상한 없음 (Recommended)" }, { label: "하루 50회" }] };
const Q2 = { question: "어느 화면을 쓸까요?", header: "화면", multiSelect: true, options: [{ label: "목록" }, { label: "카드" }, { label: "그림" }] };
let sidSeq = 0;
function session(ws, turns) { // 세션+차례 기록+대화 기록 파일(처음엔 비어 있음 → 첫 수집이 커서를 끝에 세움)
  const sid = "uw-s" + (++sidSeq);
  for (const x of turns || []) UW.recordTurn(sid, Object.assign({ wsKey: CL.wsKeyFor(ws), promptId: "pid-A" }, x));
  const tp = path.join(mk("uw-tx-"), sid + ".jsonl"); fs.writeFileSync(tp, "");
  assert.ok(UW.captureChoiceAnswers(ws, { sessionId: sid, transcriptPath: tp }).ok);
  return { sid, tp, cap: (extra) => UW.captureChoiceAnswers(ws, Object.assign({ sessionId: sid, transcriptPath: tp }, extra || {})) };
}

console.log("[1] 판별(형태만)");
t("보기 이름·복수 선택 조합·Other 단독=직접 입력 아님 / 다른 글=직접 입력 / 보기에 붙인 메모도 사용자 말", () => {
  assert.strictEqual(UW.freeTextOf(Q1, "상한 없음 (Recommended)"), "");
  assert.strictEqual(UW.freeTextOf(Q1, "Other"), "");
  assert.strictEqual(UW.freeTextOf(Q1, ""), "");
  assert.strictEqual(UW.freeTextOf(Q2, "목록, 그림"), "", "복수 선택 조합");
  assert.strictEqual(UW.freeTextOf(Q1, "보관함 방식이 아니야. 사용자가 고르게 해"), "보관함 방식이 아니야. 사용자가 고르게 해");
  assert.strictEqual(UW.freeTextOf(Q2, "목록, 내가 원하는 건 표"), "목록, 내가 원하는 건 표", "조합에 보기 밖 조각이 있으면 직접 입력");
  const xs = UW.choiceAnswersOfLine(JSON.parse(choiceLine("tu-1", [Q1, Q2], { [Q1.question]: "상한 없음 (Recommended)", [Q2.question]: "직접 쓴 답이에요" }, { [Q1.question]: { notes: "이건 꼭 기억해 줘" } })));
  assert.strictEqual(xs.length, 2);
  assert.ok(xs.some((x) => x.kind === "note" && x.text === "이건 꼭 기억해 줘") && xs.some((x) => x.kind === "answer" && x.text === "직접 쓴 답이에요"));
  assert.ok(xs.every((x) => x.toolUseId === "tu-1"), "도구 호출 id 결속");
  assert.strictEqual(UW.choiceAnswersOfLine({ type: "assistant", toolUseResult: { questions: [Q1], answers: {} } }).length, 0, "사용자 줄만");
});
t("보기 이름 안에 쉼표가 있어도 복수 선택 조합을 직접 입력으로 오인하지 않는다(검증 1회차 blocker⑤)", () => {
  const Q3 = { question: "q3", multiSelect: true, options: [{ label: "A, B" }, { label: "C" }, { label: "D,E" }] };
  assert.strictEqual(UW.freeTextOf(Q3, "A, B, C"), "", "쉼표 든 보기+다른 보기");
  assert.strictEqual(UW.freeTextOf(Q3, "C, A, B"), "", "순서 무관");
  assert.strictEqual(UW.freeTextOf(Q3, "D,E, C"), "", "공백 없는 쉼표 보기");
  assert.strictEqual(UW.freeTextOf(Q3, "A, B, 그리고 내 생각"), "A, B, 그리고 내 생각", "보기 밖 조각=직접 입력");
  assert.strictEqual(UW.freeTextOf(Q3, "A"), "A", "보기 일부 조각만=직접 입력");
});

console.log("[2] 수집(커서 이후만)·차례 결속");
t("처음 보는 세션=현재 끝부터(소급 없음) → 새 줄만 수집 · 재실행 중복 없음 · 쓰는 중인 마지막 줄은 다음에", () => {
  const ws = mk("uw-ws-");
  const sid = "uw-old"; UW.recordTurn(sid, { anchor: "a1", repoKey: RA, wsKey: CL.wsKeyFor(ws), ts: T0, promptId: "pid-A" });
  const tp = path.join(mk("uw-tx-"), "old.jsonl");
  fs.writeFileSync(tp, choiceLine("tu-old", [Q1], { [Q1.question]: "옛날에 직접 쓴 답" }) + NL);
  const r0 = UW.captureChoiceAnswers(ws, { sessionId: sid, transcriptPath: tp });
  assert.ok(r0.ok && r0.captured === 0, "소급 없음 " + JSON.stringify(r0));
  fs.appendFileSync(tp, JSON.stringify({ type: "assistant", message: { content: "x" } }) + NL + choiceLine("tu-2", [Q1], { [Q1.question]: "하루 상한은 없어도 돼" }) + NL);
  const half = choiceLine("tu-3", [Q1], { [Q1.question]: "아직 쓰는 중인 줄" });
  fs.appendFileSync(tp, half.slice(0, 40)); // 줄바꿈 없는 미완성 줄
  const r1 = UW.captureChoiceAnswers(ws, { sessionId: sid, transcriptPath: tp });
  assert.ok(r1.ok && r1.captured === 1, JSON.stringify(r1));
  assert.strictEqual(UW.captureChoiceAnswers(ws, { sessionId: sid, transcriptPath: tp }).captured, 0, "재실행=중복 없음");
  fs.appendFileSync(tp, half.slice(40) + NL);
  assert.strictEqual(UW.captureChoiceAnswers(ws, { sessionId: sid, transcriptPath: tp }).captured, 1, "미완성 줄은 완성된 뒤 수집");
  const st = UW.readUserWordsState(ws);
  assert.deepStrictEqual([...st.words.values()].map((w) => UW.wordText(ws, w)).sort(), ["아직 쓰는 중인 줄", "하루 상한은 없어도 돼"].sort());
  for (const w of st.words.values()) { assert.strictEqual(st.status.get(w.id).status, "queued", "수집=대기열 진입"); assert.ok(!JSON.stringify(w).includes("상한") && !JSON.stringify(w).includes("쓰는 중"), "장부 행엔 원문 없음(지문·길이만)"); }
});
t("늦게 수집된 답도 그 답의 차례 열쇠(promptId)의 차례·저장소에 결속 — 다음 차례·다른 저장소로 새지 않음(검증 1회차 blocker①)", () => {
  const ws = mk("uw-late-");
  const S = session(ws, [{ anchor: "turn-A", repoKey: RA, ts: T0, promptId: "pid-A" }, { anchor: "turn-B", repoKey: RB, ts: T3, promptId: "pid-B" }]);
  const line = choiceLine("tu-late", [Q1], { [Q1.question]: "A 차례에서 직접 쓴 답이에요" }, null, T2, "pid-A");
  fs.appendFileSync(S.tp, line.slice(0, 50)); // A 차례 중 미완성
  assert.strictEqual(S.cap().captured, 0);
  fs.appendFileSync(S.tp, line.slice(50) + NL); // B 차례로 넘어간 뒤 완성·수집
  assert.strictEqual(S.cap().captured, 1);
  const qa = UW.queuedWords(ws, RA), qb = UW.queuedWords(ws, RB);
  assert.ok(qa.length === 1 && qa[0].turnAnchor === "turn-A" && qb.length === 0, "A 저장소·A 차례에 결속 " + JSON.stringify({ a: qa.map((w) => w.turnAnchor), b: qb.length }));
  assert.deepStrictEqual(UW.choiceTextsForTurn(ws, "turn-B", RB), [], "B 차례 원문 대조 재료에 없음");
  assert.deepStrictEqual(UW.choiceTextsForTurn(ws, "turn-A", RA), ["A 차례에서 직접 쓴 답이에요"]);
});
t("차례를 못 찾거나 저장소 표식이 없는 답=어느 대기열에도 없음·출처 불명 보류로 표면(검증 1회차 blocker②)", () => {
  const ws = mk("uw-unk-");
  const S = session(ws, [{ anchor: "turn-X", repoKey: "", ts: T2, promptId: "pid-X" }]);
  fs.appendFileSync(S.tp, choiceLine("tu-u1", [Q1], { [Q1.question]: "차례 기록이 없는 입력의 답" }, null, T1, "pid-none") + NL + choiceLine("tu-u2", [Q1], { [Q1.question]: "표식 없는 차례의 답" }, null, T3, "pid-X") + NL);
  const r = S.cap();
  assert.ok(r.ok && r.captured === 0 && r.held === 2, JSON.stringify(r));
  assert.strictEqual(UW.queuedWords(ws, RA).length + UW.queuedWords(ws, RB).length, 0, "어느 저장소 대기열에도 없음");
  assert.strictEqual(UW.queuedWords(ws, "").length, 0, "빈 표식 조회에도 없음");
  const h = UW.heldWords(ws, RA, { unknown: true });
  assert.deepStrictEqual(h.map((w) => w.heldReason).sort(), ["repo-unknown", "turn-unknown"], "출처 불명 보류=화면 재료");
  assert.strictEqual(UW.heldWords(ws, RA).length, 0, "기본 조회(내 저장소)엔 안 섞임");
  // 이중 방어: 표식 없는 행이 어떤 경로로든 '대기' 상태여도(옛 행·외부 기록) 저장소 대기열에 섞이지 않는다
  fs.appendFileSync(UW.userWordsFileFor(ws), JSON.stringify({ type: "word", id: "c-" + "9".repeat(16), source: "choice", turnAnchor: "t", repoKey: "", textHash: "0", ts: T1 }) + NL + JSON.stringify({ type: "state", id: "c-" + "9".repeat(16), status: "queued", ts: T1 }) + NL);
  assert.ok(!UW.queuedWords(ws, RA).some((w) => w.id === "c-" + "9".repeat(16)) && !UW.queuedWords(ws, RB).some((w) => w.id === "c-" + "9".repeat(16)), "표식 없는 대기 행=어느 저장소에도 없음");
});
t("차례 기록 쓰기가 실패한 차례의 답=이전 차례로 새지 않고 보류 · 시계가 뒤로 가도 차례 열쇠로 정확히 결속(검증 2회차 f-9ee8024b)", () => {
  const ws = mk("uw-tk-");
  // B 차례 기록이 쓰이지 않음(쓰기 실패 재현) — A 차례만 있음
  const S = session(ws, [{ anchor: "turn-A", repoKey: RA, ts: T2, promptId: "pid-A" }]);
  fs.appendFileSync(S.tp, choiceLine("tu-b", [Q1], { [Q1.question]: "B 차례에서 쓴 답인데 차례 기록이 없어요" }, null, T3, "pid-B") + NL);
  const r = S.cap();
  assert.ok(r.ok && r.captured === 0 && r.held === 1, "기록 없는 차례의 답=보류 " + JSON.stringify(r));
  assert.strictEqual(UW.queuedWords(ws, RA).length, 0, "A 대기열로 새지 않음");
  // 시계 역전: B 차례 시작이 A 보다 5초 '앞선' 시각으로 기록돼도 열쇠로 B 결속
  const ws2 = mk("uw-clk-");
  const S2 = session(ws2, [{ anchor: "turn-A", repoKey: RA, ts: "2026-10-04T10:15:00.000Z", promptId: "pid-A" }, { anchor: "turn-B", repoKey: RB, ts: "2026-10-04T10:14:55.000Z", promptId: "pid-B" }]);
  fs.appendFileSync(S2.tp, choiceLine("tu-clk", [Q1], { [Q1.question]: "시계가 뒤로 간 뒤 B 차례에서 쓴 답" }, null, "2026-10-04T10:15:01.000Z", "pid-B") + NL);
  assert.strictEqual(S2.cap().captured, 1);
  assert.ok(UW.queuedWords(ws2, RB).length === 1 && UW.queuedWords(ws2, RA).length === 0, "B 결속");
});
t("열쇠로만 결속 — 열쇠 없는 차례·같은 열쇠 중복·(열쇠 없는 앞 차례+기록 누락된 같은 글 다음 차례)=보류 · 같은 열쇠 재기록=처음만(검증 3·4회차 f-9ee8024b)", () => {
  const P = "Proceed";
  // 3회차 반례: A 차례는 열쇠 판독 실패(promptId "")로 기록, B 차례(같은 글)는 기록 쓰기 실패 → B 답(pid-B)은 A 로 새지 않고 보류
  const ws = mk("uw-key-");
  const S = session(ws, [{ anchor: "turn-A", repoKey: RA, ts: T0, promptId: "", promptHash: UW.promptHashOf(P) }]);
  fs.appendFileSync(S.tp, promptLine("pid-A", P, T0) + NL + promptLine("pid-B", P, T2) + NL + choiceLine("tu-b", [Q1], { [Q1.question]: "B 저장소에서 쓴 답" }, null, T3, "pid-B") + NL + choiceLine("tu-a", [Q1], { [Q1.question]: "A 차례에서 쓴 답" }, null, T1, "pid-A") + NL);
  const r = S.cap();
  assert.ok(r.ok && r.captured === 0 && r.held === 2, "열쇠 없는 차례·기록 없는 차례의 답=모두 보류 " + JSON.stringify(r));
  assert.strictEqual(UW.queuedWords(ws, RA).length, 0, "A 대기열로 새지 않음");
  assert.deepStrictEqual(UW.choiceTextsForTurn(ws, "turn-A", RA), [], "A 차례 원문 대조 재료에도 없음");
  // 같은 열쇠가 두 차례에 있으면(있어선 안 되는 상태) 모호=보류
  const ws2 = mk("uw-dup-");
  const S2 = session(ws2, [{ anchor: "turn-1", repoKey: RA, ts: T0, promptId: "pid-D" }]);
  fs.appendFileSync(UW.turnsFileFor(S2.sid), JSON.stringify({ anchor: "turn-2", repoKey: RB, wsKey: CL.wsKeyFor(ws2), ts: T2, promptId: "pid-D" }) + NL); // 이미 중복된 옛 기록(재기록 거부 이전) 재현
  fs.appendFileSync(S2.tp, choiceLine("tu-d", [Q1], { [Q1.question]: "같은 열쇠 중복 차례의 답" }, null, T3, "pid-D") + NL);
  const r2 = S2.cap();
  assert.ok(r2.captured === 0 && r2.held === 1, "중복 열쇠=보류 " + JSON.stringify(r2));
  // 같은 입력 열쇠의 재기록(훅 재실행)=처음 기록만 인정 — 열쇠가 두 차례로 갈라지지 않는다
  const sidF = "uw-first-1";
  assert.ok(UW.recordTurn(sidF, { anchor: "turn-1", repoKey: RA, wsKey: "w", ts: T0, promptId: "pid-1" }));
  assert.ok(UW.recordTurn(sidF, { anchor: "turn-2", repoKey: RB, wsKey: "w", ts: T2, promptId: "pid-1" }));
  assert.deepStrictEqual(UW.readTurns(sidF).map((x) => x.anchor), ["turn-1"], "처음 기록만");
});
t("커서 판독 오류=수집 중단·커서 무접촉(처음 보는 세션으로 오인 금지) · 커서 손상=상한만큼 다시 읽음(검증 1회차 blocker③)", () => {
  const ws = mk("uw-cur-");
  const S = session(ws, [{ anchor: "turn-C", repoKey: RA, ts: T0 }]);
  fs.appendFileSync(S.tp, choiceLine("tu-c1", [Q1], { [Q1.question]: "커서 오류 동안 쓴 답" }) + NL);
  const cf = UW.cursorFileFor(S.sid), keep = fs.readFileSync(cf, "utf8");
  fs.rmSync(cf); fs.mkdirSync(cf); // 판독 오류 주입(EISDIR — 부재 아님)
  const r = S.cap();
  assert.ok(!r.ok && r.reason === "cursor-unreadable" && r.captured === 0, JSON.stringify(r));
  fs.rmdirSync(cf); fs.writeFileSync(cf, keep);
  assert.strictEqual(S.cap().captured, 1, "오류 해소 뒤 그 구간 수집(건너뛰지 않음)");
  fs.appendFileSync(S.tp, choiceLine("tu-c2", [Q1], { [Q1.question]: "커서가 깨진 뒤에 쓴 답" }) + NL);
  fs.writeFileSync(cf, "{깨짐");
  const r2 = S.cap();
  assert.ok(r2.ok && r2.captured === 1, "손상=다시 읽어 수집(이미 기록된 답은 중복 없음) " + JSON.stringify(r2));
});
t("조각 경계에서 한글이 쪼개져도 깨지지 않음 · 판독량 상한 초과분은 건너뛰고 기록 · 파일이 줄면 처음부터", () => {
  const ws = mk("uw-ws2-");
  const S = session(ws, [{ anchor: "turn-K", repoKey: RA, ts: T0 }]);
  const ko = "가나다라마바사아자차카타파하 한글 경계 시험 문장입니다";
  fs.appendFileSync(S.tp, choiceLine("tu-k", [Q1], { [Q1.question]: ko }) + NL);
  assert.strictEqual(S.cap({ chunk: 17 }).captured, 1);
  assert.strictEqual(UW.wordText(ws, UW.queuedWords(ws, RA)[0]), ko, "글자 그대로");
  const tail9 = choiceLine("tu-k2", [Q1], { [Q1.question]: "끝부분의 직접 입력" }) + NL;
  fs.appendFileSync(S.tp, "x".repeat(2000) + NL + tail9);
  const rg = S.cap({ cap: Buffer.byteLength(tail9) + 10 });
  assert.ok(rg.ok && rg.gap > 0 && rg.captured === 1, "상한 초과=앞부분 건너뜀·뒤 수집 " + JSON.stringify(rg));
  fs.writeFileSync(S.tp, choiceLine("tu-k3", [Q1], { [Q1.question]: "새 파일의 직접 입력" }) + NL); // 파일 교체(작아짐)
  assert.strictEqual(S.cap().captured, 1, "줄어든 파일=처음부터");
});

console.log("[3] 대기열·원문 판독");
t("입력창 원문=턴 스냅샷 지문으로 결속 · 저장소별 대기열 · 상태 전이(분류 완료/보류) · 원문 변조=null", () => {
  const ws = mk("uw-ws3-");
  const anc = CL.turnAnchorOf("s3", "2026-10-04T11:00:00.000Z");
  const P = "이번 단계 목표는 내 폰에서 시험하는 거야";
  const snap = CL.writeConstraintTurnSnapshot(ws, anc, P);
  const e = UW.enqueuePrompt(ws, { anchor: anc, sourceHash: snap.sourceHash, sessionId: "s3", repoKey: RA, provider: "claude" });
  assert.ok(e.ok && !e.existed);
  assert.ok(UW.enqueuePrompt(ws, { anchor: anc, sourceHash: snap.sourceHash, sessionId: "s3", repoKey: RA }).existed, "같은 턴 재등록=중복 없음");
  const q = UW.queuedWords(ws, RA);
  assert.ok(q.length === 1 && q[0].source === "prompt" && UW.wordText(ws, q[0]) === P);
  assert.strictEqual(UW.queuedWords(ws, RB).length, 0, "다른 저장소 대기열에 안 보임(ab-1)");
  assert.ok(UW.setWordStatus(ws, [q[0].id], "held", { reason: "retry-cap" }));
  assert.strictEqual(UW.queuedWords(ws, RA).length, 0);
  assert.strictEqual(UW.heldWords(ws, RA)[0].heldReason, "retry-cap", "보류=화면에 보일 재료");
  fs.writeFileSync(CL.constraintTurnFileFor(ws, anc), P + " 변조");
  assert.strictEqual(UW.wordText(ws, q[0]), null, "원문 변조=null");
  const e2 = UW.enqueuePrompt(ws, { anchor: CL.turnAnchorOf("s3", "2026-10-04T12:00:00.000Z"), sourceHash: "f".repeat(40), sessionId: "s3", repoKey: "" });
  assert.ok(e2.ok && e2.held === true, "표식 없는 입력=보류(어느 대기열에도 없음)");
});

console.log("[4] 원문 대조 확장(약속 상신)");
t("같은 차례의 선택지 직접 입력에서 인용=접수(quoteSource choice) · 다른 차례 답 인용=거부 · 긴 답은 자르지 않아 끝부분 인용도 접수·합성 표식은 원문 아님(검증 1회차 blocker④)", () => {
  const ws = mk("uw-ws4-"), repo = mk("uw-repo4-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  const rk = CL.repoKeyOf(repo);
  const ancA = CL.turnAnchorOf("s4", T0), ancB = CL.turnAnchorOf("s4", T3);
  const sA = CL.writeConstraintTurnSnapshot(ws, ancA, "진행해"), sB = CL.writeConstraintTurnSnapshot(ws, ancB, "다음");
  const S = session(ws, [{ anchor: ancA, repoKey: rk, ts: T0, promptId: "pid-A" }, { anchor: ancB, repoKey: rk, ts: T3, promptId: "pid-B" }]);
  const ANS = "제한없이 쌓이고 보여지고 사용자가 한꺼번에 올릴지 선택해서 올릴지 결정하는 구조";
  const LONG = "가".repeat(2000) + " 그리고 마지막에 꼭 지켜야 할 기준을 하나 덧붙인다";
  fs.appendFileSync(S.tp, choiceLine("tu-4", [Q1], { [Q1.question]: ANS }, null, T1) + NL + choiceLine("tu-5", [Q2], { [Q2.question]: LONG }, null, T2) + NL);
  assert.strictEqual(S.cap().captured, 2);
  const ctxA = { ok: true, provider: "claude", sessionId: "s4", turnAnchor: ancA, sourceHash: sA.sourceHash, repoKey: rk };
  const r = CL.constraintAdd(ws, "사용자가 한꺼번에 올릴지 선택해서 올릴지 결정하는 구조", "사용자가 정한 처리 구조", "", ctxA);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual([...CL.readEnvelopeCandidates(ws).latest.values()].find((x) => x.candidateId === r.candidateId).quoteSource, "choice");
  assert.ok(CL.constraintAdd(ws, "그리고 마지막에 꼭 지켜야 할 기준을 하나 덧붙인다", "긴 답의 끝", "", ctxA).ok, "긴 답 끝부분 인용=접수(절단 없음)");
  assert.strictEqual(CL.constraintAdd(ws, "가가가가가가가가가가…[절단]", "합성 표식", "", ctxA).reason, "not-in-prompt", "합성 표식=원문 아님");
  const ctxB = { ok: true, provider: "claude", sessionId: "s4", turnAnchor: ancB, sourceHash: sB.sourceHash, repoKey: rk };
  assert.strictEqual(CL.constraintAdd(ws, "선택해서 올릴지 결정하는 구조라는 말", "다른 차례", "", ctxB).reason, "not-in-prompt", "다른 차례 답 인용=거부");
  assert.strictEqual(CL.constraintAdd(ws, "선택해서 올릴지 결정하는 구조", "다른 저장소 표식", "", { ...ctxA, repoKey: "e".repeat(16) }).reason, "not-in-prompt", "같은 차례라도 다른 저장소 표식=거부");
});

t("이전 메시지의 사용자 말도 원문 그대로면 약속 상신 접수(사용자 결정 2026-10-04 '기회만 열어 두기') — 같은 저장소만·보관 만료·변조 원문은 거부·작문 거부", () => {
  const ws = mk("uw-earlier-"), repo = mk("uw-repo-e-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  const rk = CL.repoKeyOf(repo);
  const ancOld = CL.turnAnchorOf("s-e", "2026-10-04T09:00:00.000Z"), ancNow = CL.turnAnchorOf("s-e", "2026-10-04T10:00:00.000Z");
  const OLD = "앞으로 검증자와 구현자가 같은 문제로 핑퐁하면 세 번째에는 나에게 물어봐";
  const sOld = CL.writeConstraintTurnSnapshot(ws, ancOld, OLD);
  assert.ok(UW.enqueuePrompt(ws, { anchor: ancOld, sourceHash: sOld.sourceHash, sessionId: "s-e", repoKey: rk }).ok);
  const sNow = CL.writeConstraintTurnSnapshot(ws, ancNow, "왜 그걸 수칙서에 안 올렸어?");
  const ctx = { ok: true, provider: "claude", sessionId: "s-e", turnAnchor: ancNow, sourceHash: sNow.sourceHash, repoKey: rk };
  const r = CL.constraintAdd(ws, "같은 문제로 핑퐁하면 세 번째에는 나에게 물어봐", "사용자가 지적한 관통 기준", "", ctx);
  assert.ok(r.ok, "이전 메시지 인용=접수 " + JSON.stringify(r));
  const rec = [...CL.readEnvelopeCandidates(ws).latest.values()].find((x) => x.candidateId === r.candidateId);
  assert.ok(rec.quoteSource === "earlier-prompt" && rec.quoteFromAnchor === ancOld && rec.turnAnchor === ancNow, "출처 차례 기록·상신 차례 그대로");
  assert.strictEqual(CL.constraintAdd(ws, "핑퐁이 생기면 바로 수칙서에 올려라", "작문", "", ctx).reason, "not-in-prompt", "작문=거부");
  assert.strictEqual(CL.constraintAdd(ws, "세 번째에는 나에게 물어봐", "다른 저장소", "", { ...ctx, repoKey: "e".repeat(16) }).reason, "not-in-prompt", "다른 저장소 표식=거부");
  fs.writeFileSync(CL.constraintTurnFileFor(ws, ancOld), OLD + " 변조");
  assert.strictEqual(CL.constraintAdd(ws, "검증자와 구현자가 같은 문제로 핑퐁하면", "변조", "", ctx).reason, "not-in-prompt", "원문 변조(지문 불일치)=거부");
  fs.rmSync(CL.constraintTurnFileFor(ws, ancOld));
  assert.strictEqual(CL.constraintAdd(ws, "검증자와 구현자가 같은 문제로", "만료", "", ctx).reason, "not-in-prompt", "보관 만료(원문 없음)=거부");
  // 보존 기간은 읽는 시점에 기록 시각으로 판정 — 청소(하루 1회) 전에 파일이 남아 있어도 7일 지난 말은 거부(검증 5회차 blocker)
  const ws2 = mk("uw-earlier2-");
  assert.ok(CL.updateContractPatch(ws2, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  const H = 3600 * 1000, NOW = Date.now(), iso = (ms) => new Date(NOW - ms).toISOString();
  const sOld2 = CL.writeConstraintTurnSnapshot(ws2, ancOld, OLD);
  assert.ok(UW.enqueuePrompt(ws2, { anchor: ancOld, sourceHash: sOld2.sourceHash, sessionId: "s-e", repoKey: rk }).ok);
  const backdate = (ms) => { const f = UW.userWordsFileFor(ws2); const rows = fs.readFileSync(f, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l)); fs.writeFileSync(f, rows.map((x) => JSON.stringify(Object.assign(x, { ts: iso(ms) }))).join(NL) + NL); };
  const sNow2 = CL.writeConstraintTurnSnapshot(ws2, ancNow, "왜 그걸 수칙서에 안 올렸어?");
  const ctx2 = { ...ctx, sourceHash: sNow2.sourceHash };
  const CH = "후보는 제한 없이 쌓이고 내가 골라서 올리게 해 줘";
  backdate(7 * 24 * H + 6 * H); // 7일 6시간
  const idOld = "c-" + "e".repeat(16);
  assert.ok(UW.recordWord(ws2, { id: idOld, source: "choice", turnAnchor: ancOld, repoKey: rk, textHash: sha1(CH), len: CH.length, ts: iso(7 * 24 * H + 6 * H) }, CH).ok);
  assert.ok(fs.existsSync(CL.constraintTurnFileFor(ws2, ancOld)) && fs.existsSync(UW.textFileFor(ws2, idOld)), "전제: 원문 파일 둘 다 남아 있음(청소 전)");
  assert.strictEqual(CL.constraintAdd(ws2, "같은 문제로 핑퐁하면 세 번째에는 나에게 물어봐", "만료 뒤 입력창", "", ctx2).reason, "not-in-prompt", "7일 지난 입력창 원문(청소 전)=거부");
  assert.strictEqual(CL.constraintAdd(ws2, "제한 없이 쌓이고 내가 골라서 올리게", "만료 뒤 직접 입력", "", ctx2).reason, "not-in-prompt", "7일 지난 직접 입력(청소 전)=거부");
  assert.ok(UW.findQuoteInRecentWords(ws2, rk, "세 번째에는 나에게 물어봐", NOW - 12 * H), "같은 행을 12시간 전 시점(6일 18시간)으로 읽으면 보존 안 — 판정 기준=기록 시각");
  backdate(6 * 24 * H + 18 * H); // 6일 18시간=보존 안(직접 입력 행도 함께 당겨짐)
  const rIn = CL.constraintAdd(ws2, "같은 문제로 핑퐁하면 세 번째에는 나에게 물어봐", "보존 안 입력창", "", ctx2);
  assert.ok(rIn.ok, "보존 안 입력창 원문=접수 " + JSON.stringify(rIn));
  const rCh = CL.constraintAdd(ws2, "제한 없이 쌓이고 내가 골라서 올리게", "보존 안 직접 입력", "", ctx2);
  assert.ok(rCh.ok, "보존 안 직접 입력=접수 " + JSON.stringify(rCh));
  assert.ok(UW.wordExpired({ ts: "" }) && UW.wordExpired({ ts: "not-a-date" }), "시각 판독 불가=만료(fail-closed)");
  assert.ok(!UW.wordExpired({ ts: iso(H) }) && UW.wordExpired({ ts: iso(H) }, NOW + CL.ATTEMPTS_TTL_MS), "시각 주입 경계");
});

console.log("[5] 훅 결선(실제 실행)");
t("입력 제출 훅: 차례 기록(훅 입력 prompt_id)·이번 입력=대기열 · 다음 입력 때 직전 차례 답을 그 열쇠의 차례에 결속 · 종료 훅도 이번 차례 답을 수집 · prompt_id 없는 훅=보류", () => {
  const ws = mk("uw-ws5-"), repo = mk("uw-repo5-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  const rk = CL.repoKeyOf(repo);
  const SID = "uw-hook-session-01";
  const tp = path.join(mk("uw-tx5-"), SID + ".jsonl"); fs.writeFileSync(tp, "");
  const INJECT = path.join(ROOT, "bridge", "contract-inject.js");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws, CLAUDE_CODE_SESSION_ID: SID });
  const run = (prompt, promptId) => { const r = cp.spawnSync(process.execPath, [INJECT], { input: JSON.stringify(Object.assign({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: ws, prompt, transcript_path: tp, permission_mode: "default" }, promptId ? { prompt_id: promptId } : {})), encoding: "utf8", env, cwd: ws }); assert.strictEqual(r.status, 0, r.stderr); };
  const P1h = "첫 번째 요청이야 — 이번엔 내 폰으로 시험하는 게 목표", P2h = "다음 진행해";
  fs.appendFileSync(tp, promptLine("pid-h1", P1h, new Date().toISOString()) + NL);
  run(P1h, "pid-h1"); // 차례 열쇠=훅 입력의 prompt_id(대화 기록 꼬리 추측 없음)
  const a1 = JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, SID + ".json"), "utf8"));
  assert.ok(a1.constraintAnchor && a1.transcriptPath === tp, "앵커에 대화 기록 위치");
  assert.ok(UW.readTurns(SID).some((x) => x.anchor === a1.constraintAnchor && x.repoKey === rk && x.promptId === "pid-h1"), "차례 기록(열쇠 포함)");
  let q = UW.queuedWords(ws, rk);
  assert.ok(q.length === 1 && q[0].source === "prompt" && q[0].turnAnchor === a1.constraintAnchor, "입력=대기열");
  const wait = () => cp.spawnSync(process.execPath, ["-e", "setTimeout(()=>{},30)"]);
  wait();
  fs.appendFileSync(tp, choiceLine("tu-5", [Q1], { [Q1.question]: "상한 없이 하고 대신 화면에서 골라 올리게 해 줘" }, null, new Date().toISOString(), "pid-h1") + NL);
  wait();
  fs.appendFileSync(tp, promptLine("pid-h2", P2h, new Date().toISOString()) + NL);
  run(P2h, "pid-h2");
  q = UW.queuedWords(ws, rk);
  const ch = q.find((w) => w.source === "choice");
  assert.ok(ch && ch.turnAnchor === a1.constraintAnchor && UW.wordText(ws, ch) === "상한 없이 하고 대신 화면에서 골라 올리게 해 줘", "직전 차례 답=직전 차례 결속 " + JSON.stringify(q.map((w) => [w.source, w.turnAnchor])));
  assert.strictEqual(q.filter((w) => w.source === "prompt").length, 2, "두 번째 입력도 대기열");
  const a2 = JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, SID + ".json"), "utf8"));
  wait();
  fs.appendFileSync(tp, choiceLine("tu-6", [Q1], { [Q1.question]: "이번 차례에 직접 쓴 두 번째 답" }, null, new Date().toISOString(), "pid-h2") + NL);
  const GUARD = path.join(ROOT, "bridge", "verify-guard.js");
  cp.spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ hook_event_name: "Stop", session_id: SID, cwd: ws, transcript_path: tp, stop_hook_active: false }), encoding: "utf8", env, cwd: ws });
  const ch2 = UW.queuedWords(ws, rk).find((w) => w.source === "choice" && UW.wordText(ws, w) === "이번 차례에 직접 쓴 두 번째 답");
  assert.ok(ch2 && ch2.turnAnchor === a2.constraintAnchor, "종료 훅 수집=이번 차례 결속");
  // 훅 입력에 prompt_id 가 없으면(옛 버전) 그 차례의 답은 보류 — 꼬리에 같은 글의 앞 입력 줄이 있어도 그 열쇠를 가져다 쓰지 않는다
  wait();
  fs.appendFileSync(tp, promptLine("pid-h3", P2h, new Date().toISOString()) + NL);
  run(P2h); // prompt_id 없음
  assert.strictEqual(UW.readTurns(SID).slice(-1)[0].promptId, "", "열쇠 없음 기록(꼬리 추측 금지)");
  fs.appendFileSync(tp, choiceLine("tu-7", [Q1], { [Q1.question]: "열쇠 없는 차례의 직접 입력" }, null, new Date().toISOString(), "pid-h3") + NL);
  const r7 = UW.captureForActiveTurn(ws, SID, tp);
  assert.ok(r7.ok && r7.held === 1 && r7.captured === 0, "열쇠 없는 차례 답=보류 " + JSON.stringify(r7));
});

console.log("[6] 청소·배포");
t("직접 입력 원문 파일은 7일 뒤 청소(장부는 남음) · 배포 목록 3곳에 user-words.js", () => {
  const ws = mk("uw-ws6-");
  const r = UW.recordWord(ws, { id: "c-" + "d".repeat(16), source: "choice", turnAnchor: "x", repoKey: RA, textHash: sha1("오래된 답"), len: 5, ts: "T" }, "오래된 답");
  assert.ok(r.ok);
  const f = UW.textFileFor(ws, "c-" + "d".repeat(16));
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); fs.utimesSync(f, past, past);
  CL.cleanupOldState(Date.now());
  assert.ok(!fs.existsSync(f), "8일 지난 원문 삭제");
  assert.ok(UW.readUserWordsState(ws).words.has("c-" + "d".repeat(16)), "장부 행은 유지(원문 없음=분류 때 보류로 표면화)");
  const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8"), hs = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8"), mc = fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8");
  assert.ok(inst.includes('"user-words.js"') && hs.includes('"user-words.js"') && mc.includes('"user-words.js"'));
});

console.log(`\n결과: ${n}/${n} 통과`);
