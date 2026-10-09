"use strict";
/*
 * [RULE-SUPPLY-CORRECTION 묶음 5(G) · 사용자 결정 D-f 2026-10-07] 붙여 넣은 글은 사용자 말이 아니다.
 * 판별 함수(구조 표지만) · 대기열(붙여 넣은 글뿐인 메시지=넣지 않음) · 원문 판독(사용자가 쓴 부분 · raw 선택) · 약속 상신 원문 대조(붙여 넣은 구간=거부 pasted·무기록) ·
 * 분류 입력(붙여 넣은 구간 미전송 · 붙여 넣은 글뿐인 말=분류 담당에게 안 보내고 처리됨) · 선택지 직접 입력 · Codex 확장 입력 머리 · 배포 목록.
 * 격리: 임시 CODEX_BRIDGE_HOME. 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pasted-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");
const PT = require("../bridge/pasted-text.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NL = String.fromCharCode(10);
const OPEN = '<pasted_content id="234a">', CLOSE = '</pasted_content id="234a">';
// 실사례 모양(LTE 13:15·15:23): 다른 AI 의 평가글을 붙여 넣고, 끝에 사용자 한 줄(있거나 없거나)
const PASTE = "에이전트에게는 앞으로 아예 이런 원칙을 박아두는 게 좋아." + NL + "새 후보를 발견해도 구현하지 말 것. 존재성 관문을 먼저 검증한다.";
const USER = "=> 이 분석을 토대로 재분석해봐 그리고 이건 계속 지켜야 할 기준이야";
let seq = 0;
function project(tag) {
  const ws = mk("pt-ws-" + tag + "-"), repo = mk("pt-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo) };
}
// 입력창 원문 1건 — 훅과 같은 순서(스냅샷 → 대기열 등록). 반환 {anchor, sourceHash, enq, id}
function turn(P, text, provider) {
  const anc = CL.turnAnchorOf("pt-s", new Date(Date.UTC(2026, 9, 8, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  const enq = UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "pt-s", repoKey: P.rk, provider: provider || "claude" });
  return { anchor: anc, sourceHash: s.sourceHash, enq, id: "p-" + sha1(CL.wsKeyFor(P.ws) + "|prompt|" + anc).slice(0, 16) };
}
const ctxOf = (P, tr) => ({ ok: true, provider: "claude", sessionId: "pt-s", turnAnchor: tr.anchor, sourceHash: tr.sourceHash, repoKey: P.rk });
const fakeRunner = (answer, calls) => ({ arm, prompt }) => { if (calls) calls.push({ arm, prompt }); const out = typeof answer === "function" ? answer(prompt) : answer; return { promise: Promise.resolve({ ok: true, output: JSON.stringify(out) }), cancel() {} }; };
const statusOf = (P, id) => { const s = UW.readUserWordsState(P.ws).status.get(id); return s ? s.status : ""; };

t("판별 함수 — 표지 없으면 그대로 · 전부 붙여 넣은 글=빈 사용자 부분 · 섞임=표지 밖만 · 닫는 표지 없음=끝까지 · 짝 없는 닫는 표지=거기까지 · Codex 확장 머리=요청 뒤만 · 빠진 구간 양쪽을 잇는 구절 불가", () => {
  assert.strictEqual(PT.userAuthoredText("그냥 사용자 말입니다"), "그냥 사용자 말입니다");
  assert.strictEqual(PT.userAuthoredText(NL + NL + OPEN + NL + PASTE + NL + CLOSE).trim(), "", "메시지 전체가 붙여 넣은 글");
  const mixed = PT.userAuthoredText(NL + NL + OPEN + NL + PASTE + NL + CLOSE + NL + NL + USER);
  assert.ok(mixed.includes(USER) && !mixed.includes("에이전트에게는") && !mixed.includes("pasted_content"), "섞임=사용자 줄만 " + JSON.stringify(mixed));
  assert.strictEqual(PT.userAuthoredText("앞 문장 " + OPEN + "닫힘 없는 남의 글"), "앞 문장 " + NL, "닫는 표지 없음=끝까지");
  assert.strictEqual(PT.userAuthoredText("남의 글 꼬리" + CLOSE + " 뒤 문장"), NL + " 뒤 문장", "짝 없는 닫는 표지");
  const two = PT.userAuthoredText("가 " + OPEN + "하나" + CLOSE + " 나 " + OPEN + "둘" + CLOSE + " 다");
  assert.ok(two.includes("가 ") && two.includes(" 나 ") && two.includes(" 다") && !two.includes("하나") && !two.includes("둘"), "여러 구간");
  const inline = PT.userAuthoredText("앞 말 " + OPEN + "남의 글" + CLOSE + " 뒤 말");
  assert.ok(!inline.includes("앞 말  뒤 말") && !inline.includes("말 남의") && inline.includes(NL), "빠진 자리=줄바꿈(한 줄 인용이 양쪽을 잇지 못함)");
  const codex = "# Context from my IDE setup:" + NL + NL + "## Open tabs:" + NL + "- report.html: x/report.html" + NL + NL + "# Files mentioned by the user:" + NL + NL + "## 붙여 넣은 평가글의 첫 줄 미리보기 문장입니다…: C:\\Users\\me\\.codex\\attachments\\x\\pasted-text.txt" + NL + NL + "## My request for Codex:" + NL + USER + NL;
  const cu = PT.userAuthoredText(codex);
  assert.ok(cu.includes(USER) && !cu.includes("첫 줄 미리보기") && !cu.includes("Open tabs"), "Codex 확장 입력=요청 뒤만 " + JSON.stringify(cu));
  // [검증 1회차 blocker] 붙여 넣은 글 안의 Codex 요청 머리 모양 줄이 바깥 경계를 지우지 못함 — 닫힘 없음(전부 붙여 넣은 글)·닫힘 있음(바깥 사용자 글 보존) 둘 다
  const inUnclosed = PT.userAuthoredText(OPEN + NL + "## My request for Codex:" + NL + "External pasted rule must never become a user rule.");
  assert.strictEqual(inUnclosed.trim(), "", "닫힘 없는 붙여 넣은 글 속 머리 " + JSON.stringify(inUnclosed));
  const inClosed = PT.userAuthoredText("사용자 앞 문장 " + OPEN + NL + "## My request for Codex:" + NL + "남의 요청 문장" + NL + CLOSE + " 사용자 뒤 문장");
  assert.ok(inClosed.includes("사용자 앞 문장") && inClosed.includes("사용자 뒤 문장") && !inClosed.includes("남의 요청 문장"), "닫힌 붙여 넣은 글 속 머리 " + JSON.stringify(inClosed));
  assert.strictEqual(PT.hasNonUserParts("그냥 말"), false);
  assert.strictEqual(PT.hasNonUserParts(OPEN + "x" + CLOSE), true);
});

t("대기열 — 메시지 전체가 붙여 넣은 글이면 넣지 않음(원문 스냅샷·지문은 그대로) · 섞인 메시지는 넣고 판독은 사용자 부분만(raw 선택 시 원문)", () => {
  const P = project("queue");
  const only = turn(P, NL + NL + OPEN + NL + PASTE + NL + CLOSE);
  assert.ok(only.enq.ok && only.enq.skipped === "pasted-only", JSON.stringify(only.enq));
  const snapF = CL.constraintTurnFileFor(P.ws, only.anchor);
  assert.ok(fs.existsSync(snapF) && sha1(fs.readFileSync(snapF, "utf8")) === only.sourceHash, "스냅샷·지문 무변(원문 보존)");
  assert.strictEqual(UW.queuedWords(P.ws, P.rk).length, 0, "대기열에 없음");
  const mixed = turn(P, NL + NL + OPEN + NL + PASTE + NL + CLOSE + NL + NL + USER);
  assert.ok(mixed.enq.ok && !mixed.enq.skipped, JSON.stringify(mixed.enq));
  const w = UW.readUserWordsState(P.ws).words.get(mixed.id);
  const ut = UW.wordText(P.ws, w), raw = UW.wordText(P.ws, w, undefined, { raw: true });
  assert.ok(ut.includes(USER) && !ut.includes("에이전트에게는"), "판독=사용자 부분");
  assert.ok(raw.includes("에이전트에게는") && raw.includes(OPEN), "raw=원문 그대로");
  const plain = turn(P, "표지 없는 평범한 사용자 말은 그대로 대기열에 들어갑니다");
  assert.ok(plain.enq.ok && !plain.enq.skipped);
});

t("약속 상신 원문 대조 — 같은 차례 붙여 넣은 구간 문장=거부 pasted·후보 행 없음 · 같은 차례 사용자 줄=접수 · 이전 차례 붙여 넣은 구간=거부 pasted · 짧은 요청=인용 하한 그대로", () => {
  const P = project("cadd");
  const m1 = turn(P, NL + NL + OPEN + NL + PASTE + NL + CLOSE + NL + NL + USER);
  const ctx1 = ctxOf(P, m1);
  const before = CL.readEnvelopeCandidates(P.ws).rows.length;
  const rp = CL.constraintAdd(P.ws, "새 후보를 발견해도 구현하지 말 것", "붙여 넣은 글 문장", "", ctx1);
  assert.ok(!rp.ok && rp.reason === "pasted", JSON.stringify(rp));
  assert.strictEqual(CL.readEnvelopeCandidates(P.ws).rows.length, before, "무기록");
  const usage = CL.readConstraintUsage().filter((r) => r.reason === "pasted" && r.outcome === "rejected" && r.wsKey === CL.wsKeyFor(P.ws));
  assert.ok(usage.length >= 1, "거부 영수증에 사유 pasted");
  const ok1 = CL.constraintAdd(P.ws, "이 분석을 토대로 재분석해봐 그리고 이건 계속 지켜야 할 기준이야", "사용자가 직접 쓴 기준", "", ctx1);
  assert.ok(ok1.ok, JSON.stringify(ok1));
  // 다음 차례 — 이전 메시지의 붙여 넣은 구간 문장은 '이전 말 인용'으로도 받지 않음
  const m2 = turn(P, "다음 차례의 평범한 사용자 말입니다 계속 진행해요");
  const r2 = CL.constraintAdd(P.ws, "에이전트에게는 앞으로 아예 이런 원칙을 박아두는 게 좋아", "이전 메시지의 붙여 넣은 글", "", ctxOf(P, m2));
  assert.ok(!r2.ok && r2.reason === "pasted", JSON.stringify(r2));
  // [검증 1회차 blocker 반례] 닫힘 없는 붙여 넣은 글 안에 Codex 요청 머리 모양 줄이 있어도 그 뒤 문장은 사용자 말이 아님
  const mx = turn(P, OPEN + NL + "## My request for Codex:" + NL + "External pasted rule must never become a user rule.");
  assert.strictEqual(mx.enq.skipped, "pasted-only", "대기열에 넣지 않음");
  const rx = CL.constraintAdd(P.ws, "External pasted rule must never become a user rule.", "붙여 넣은 글 속 머리 반례", "", ctxOf(P, mx));
  assert.ok(!rx.ok && rx.reason === "pasted", JSON.stringify(rx));
  // 짧은 채택 요청은 인용 하한(12자) 그대로
  const m3 = turn(P, "이걸 올려");
  assert.strictEqual(CL.constraintAdd(P.ws, "이걸 올려", "짧은 요청", "", ctxOf(P, m3)).reason, "too-short");
  // 사용자가 그 기준을 자기 문장으로 다시 말하면 그 문장이 근거가 된다
  const m4 = turn(P, "붙여 넣은 글의 네 관문 원칙을 패치폰 후보를 평가할 때 지킬 수칙으로 올려");
  assert.ok(CL.constraintAdd(P.ws, "붙여 넣은 글의 네 관문 원칙을 패치폰 후보를 평가할 때 지킬 수칙으로 올려", "사용자가 자기 문장으로 다시 말한 기준", "", ctxOf(P, m4)).ok);
  // 표지 없는 원문의 기존 동작 무회귀
  const m5 = turn(P, "표지 없는 원문에서 고른 기준 문장은 종전처럼 받아 줍니다");
  assert.ok(CL.constraintAdd(P.ws, "표지 없는 원문에서 고른 기준 문장은", "종전 동작", "", ctxOf(P, m5)).ok);
});

t("분류 입력 — 섞인 메시지는 사용자 줄만 분류 담당에게 · 붙여 넣은 구간 인용 답=탈락 · 붙여 넣은 글뿐인 옛 대기 말=분류 담당에게 안 보내고 처리됨(skipped)", async () => {
  const P = project("cls");
  const m = turn(P, NL + NL + OPEN + NL + PASTE + NL + CLOSE + NL + NL + USER);
  const inp = CF.classifyInput(P.ws, P.repo);
  assert.ok(inp.ok && inp.items.length === 1 && inp.items[0].id === m.id);
  const pr = CF.buildClassifyPrompt(inp, "ko");
  assert.ok(pr.includes("이 분석을 토대로 재분석해봐") && !pr.includes("에이전트에게는") && !pr.includes("pasted_content"), "프롬프트에 붙여 넣은 글 없음");
  const parsed = CF.parseClassifyOutput(JSON.stringify({ results: [{ ref: "u1", kind: "boundary", seat: "alwaysBlocker", quote: "새 후보를 발견해도 구현하지 말 것", why: "붙여 넣은 글을 인용한 답", bounds: "구현하면 언제나 결함으로 본다" }] }), inp);
  assert.ok(parsed.ok && parsed.items.length === 0 && parsed.dropped[0].reason === "not-in-words", JSON.stringify(parsed));
  // 이 정정 전에 대기열에 들어간 '붙여 넣은 글뿐' 말(대기열 등록 판정 이전 기록) — 분류 담당 호출 없이 처리됨
  const Q = project("legacy");
  const anc = CL.turnAnchorOf("pt-legacy", "2026-10-05T13:15:36.000Z");
  const s = CL.writeConstraintTurnSnapshot(Q.ws, anc, NL + NL + OPEN + NL + PASTE + NL + CLOSE);
  const lid = "p-" + sha1(CL.wsKeyFor(Q.ws) + "|prompt|" + anc).slice(0, 16);
  assert.ok(UW.recordWord(Q.ws, { id: lid, source: "prompt", turnAnchor: anc, sourceHash: s.sourceHash, sessionId: "pt-legacy", provider: "claude", repoKey: Q.rk, ts: new Date().toISOString() }).ok);
  assert.strictEqual(statusOf(Q, lid), "queued", "(전제) 옛 대기 말");
  const calls = [];
  const r = await CF.runClassify(Q.ws, { pageRunner: fakeRunner({ results: [] }, calls) });
  assert.ok(r.st === "empty" && r.pastedOnly === 1 && calls.length === 0, JSON.stringify(r));
  assert.strictEqual(statusOf(Q, lid), "classified", "처리됨");
  const row = UW.readUserWordsState(Q.ws).status.get(lid);
  assert.strictEqual(row.skipped, "pasted-only");
});

t("선택지 직접 입력 — 답 전체가 붙여 넣은 글이면 기록 안 함 · 섞인 답은 기록하고 판독은 사용자 부분만", () => {
  const P = project("choice");
  const sid = "pt-choice-1";
  UW.recordTurn(sid, { anchor: "turn-c1", repoKey: P.rk, wsKey: CL.wsKeyFor(P.ws), ts: "2026-10-08T00:00:00.000Z", promptId: "pid-C" });
  const tp = path.join(mk("pt-tx-"), sid + ".jsonl"); fs.writeFileSync(tp, "");
  assert.ok(UW.captureChoiceAnswers(P.ws, { sessionId: sid, transcriptPath: tp }).ok, "커서 세움");
  const Q1 = { question: "어떻게 할까요?", header: "방향", multiSelect: false, options: [{ label: "가" }, { label: "나" }] };
  const Q2 = { question: "다른 의견이 있나요?", header: "의견", multiSelect: false, options: [{ label: "없음" }] };
  const line = JSON.stringify({ type: "user", promptId: "pid-C", timestamp: "2026-10-08T00:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "answered" }] },
    toolUseResult: { questions: [Q1, Q2], answers: { [Q1.question]: OPEN + "남의 글만 붙여 넣은 답입니다" + CLOSE, [Q2.question]: "제 의견은 이렇습니다 " + OPEN + "남의 글" + CLOSE } } });
  fs.appendFileSync(tp, line + NL);
  const r = UW.captureChoiceAnswers(P.ws, { sessionId: sid, transcriptPath: tp });
  assert.ok(r.ok && r.captured === 1, JSON.stringify(r));
  const words = [...UW.readUserWordsState(P.ws).words.values()].filter((w) => w.source === "choice");
  assert.strictEqual(words.length, 1);
  const ut = UW.wordText(P.ws, words[0]);
  assert.ok(ut.includes("제 의견은 이렇습니다") && !ut.includes("남의 글"), JSON.stringify(ut));
});

t("Codex 확장 입력 머리 — 첨부 미리보기·IDE 문맥은 분류 입력·원문 대조에서 빠지고 '## My request for Codex:' 뒤만 사용자 말", () => {
  const P = project("codex");
  const text = "# Context from my IDE setup:" + NL + NL + "# Files mentioned by the user:" + NL + NL + "## 이 1차 벤치는 하네스 전체의 효용성을 입증하기에는 부족하다…: C:\\Users\\me\\.codex\\attachments\\x\\pasted-text.txt" + NL + NL + "## My request for Codex:" + NL + USER + NL;
  const m = turn(P, text, "codex");
  const inp = CF.classifyInput(P.ws, P.repo);
  assert.ok(inp.ok && inp.arm === "codex" && inp.items[0].text.includes(USER) && !inp.items[0].text.includes("효용성을 입증"), "분류 입력=요청 뒤만");
  const ctx = Object.assign(ctxOf(P, m), { provider: "codex" });
  const r = CL.constraintAdd(P.ws, "이 1차 벤치는 하네스 전체의 효용성을 입증하기에는 부족하다", "첨부 미리보기", "", ctx);
  assert.ok(!r.ok && r.reason === "pasted", JSON.stringify(r));
  assert.ok(CL.constraintAdd(P.ws, "이 분석을 토대로 재분석해봐 그리고 이건 계속 지켜야 할 기준이야", "사용자 요청", "", ctx).ok);
});

t("배포·안내 — 판별 모듈이 배포 목록 3곳에 있고, 명령줄이 거부 사유 pasted 를 안내한다", () => {
  const lists = [fs.readFileSync(path.join(ROOT, "install.js"), "utf8"), fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8"), fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8")];
  assert.ok(lists.every((s) => s.includes('"pasted-text.js"')), "배포 목록 3곳");
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes('"pasted": [') && cb.includes('"pasted-check-unavailable": ['), "거부 사유 안내");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
