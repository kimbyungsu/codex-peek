"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-나-2 1단계] 사용자 말 분류 실행 — 입력(민감 형태 생략·회사별 묶음·보존 기간)·답 판독(작문 차단)·수칙서 칸 후보·
 * 실패 보존(재시도→보류)·수칙서 칸 갈래(지원 환경·범위 밖=본문 전용)·세대 이월 칸 보존·명령줄 결선.
 * [RULE-SUPPLY-CORRECTION 묶음 1] 옛 규칙 칸·결정 기록 자리 제거 — 그 자리 답=전량 거부 · 승인 함수 부재 · 결정 출처 새로 만들기 implementer 만·읽기 호환 · 옛 자리 장부 무변경.
 * [RULE-SUPPLY-CORRECTION ⑤ 1단계 — 2026-10-10] 분류 담당=성격 판단만(판정 경계·다시 강조·일하는 방식) · 결과는 분류 결과 장부에만(수칙서 후보 장부 무접촉) ·
 *   판정 경계는 판정 영향(bounds) 한 줄 필수 · 다시 강조는 목록 번호 · [6] 은 이 정정 전에 분류 담당이 남긴 옛 후보 행(origin classifier)의 칸 처리 — 그 자료는 계속 다룬다.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입). 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "classify-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sec = (label) => { pending.push([null, label]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const NL = String.fromCharCode(10);
let seq = 0;
function project(tag) {
  const ws = mk("cf-ws-" + tag + "-"), repo = mk("cf-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo) };
}
// 입력창 원문 1건을 대기열에(턴 원문 스냅샷=정본 · 차례 앵커 유일)
function say(P, text, provider) {
  const anc = CL.turnAnchorOf("cf-s", new Date(Date.UTC(2026, 9, 5, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  const r = UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "cf-s", repoKey: P.rk, provider: provider || "claude" });
  assert.ok(r.ok && !r.held, JSON.stringify(r));
  return { anchor: anc, id: "p-" + sha1(CL.wsKeyFor(P.ws) + "|prompt|" + anc).slice(0, 16) };
}
// 선택지 직접 입력 1건
function typed(P, text) {
  const id = "c-" + sha1("cf|" + (++seq)).slice(0, 16);
  const r = UW.recordWord(P.ws, { id, source: "choice", kind: "answer", turnAnchor: "turn-c" + seq, repoKey: P.rk, provider: "claude", textHash: sha1(text), len: text.length, ts: new Date().toISOString() }, text);
  assert.ok(r.ok && !r.held);
  return { id };
}
// 가짜 페이지 실행기 — 받은 팔·프롬프트 기록, 답은 함수가 프롬프트를 보고 만든다
function fakeRunner(answer, calls) {
  return ({ arm, prompt }) => { if (calls) calls.push({ arm, prompt }); const out = typeof answer === "function" ? answer(prompt) : answer; return { promise: Promise.resolve(out && out.ok === false ? out : { ok: true, output: typeof out === "string" ? out : JSON.stringify(out) }), cancel() {} }; };
}
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); assert.ok(from > 0 && i > from, "사용자 말 구획에 원문 없음: " + text.slice(0, 20)); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); }; // 사용자 말 구획 안에서만(이미 있는 것 목록과 혼동 금지)
const statusOf = (P, id) => { const st = UW.readUserWordsState(P.ws); const s = st.status.get(id); return s ? s.status : ""; };

sec("[1] 입력 — 민감 형태 생략·회사별 묶음·상한·보존 기간");
t("민감 형태 생략: 경로·이메일·토큰·긴 덩어리=[생략] · 한글·줄바꿈 보존 · 경계 문자 보존", () => {
  const s = CF.redactSensitiveForms("설정은 C:\\Users\\me\\a.json 에 있고 (/home/me/x) 메일 me@x.com 키 sk-abcdefghijklmn " + "a".repeat(40) + NL + "다음 줄도 그대로");
  assert.ok(!s.includes("Users") && !s.includes("/home/me") && !s.includes("me@x.com") && !s.includes("sk-abc") && !s.includes("aaaaaaaa"), s);
  assert.ok(s.includes("설정은 [생략] 에 있고 ([생략]") && s.includes(NL + "다음 줄도 그대로"), s); // 경로 꼬리의 닫는 괄호까지 가려도 안전한 방향(과잉 생략)
});
t("0세대 프로젝트도 분류 대상 · 가장 오래된 말의 회사로 한 묶음(다른 회사 말은 다음 실행) · 원문 못 읽는 말=보류 대상 · 보여 주기 상한 표식", () => {
  const P = project("in");
  const a = say(P, "앞으로 화면에 보이는 연결 상태와 실제 연결 상태는 언제나 같아야 해");
  const b = say(P, "코덱스 쪽에서 한 말", "codex");
  const c = typed(P, "선택지에서 직접 쓴 말 — 설명은 상황 예시로 해 줘");
  const d = say(P, "이 말은 원문이 변조된다");
  fs.writeFileSync(CL.constraintTurnFileFor(P.ws, d.anchor), "변조");
  const long = say(P, "긴 말 " + "가".repeat(CF.CLASSIFY_WORD_SHOW + 50) + " 끝에 숨은 기준 문장은 여기 있어요");
  const inp = CF.classifyInput(P.ws, P.repo);
  assert.ok(inp.ok && inp.gen === CL.GEN0_HASH && inp.virtual === true && inp.provider === "claude" && inp.arm === "self", JSON.stringify({ ok: inp.ok, gen: inp.gen, p: inp.provider }));
  assert.deepStrictEqual(inp.items.map((x) => x.id), [a.id, c.id, long.id], "오래된 것부터·Claude 말만");
  assert.deepStrictEqual(inp.unavailable, [d.id], "변조 원문=분류 불가");
  const L = inp.items[2];
  assert.ok(L.shown.length < L.text.length && L.shown.includes("[생략](") && !L.shown.includes("숨은 기준"), "보여 주기 상한+표식");
  assert.ok(!inp.items.some((x) => x.id === b.id));
});
t("한 묶음 글자 상한 — 첫 말은 크기와 무관하게 싣고 그다음부터 상한에서 멈춤(나머지는 대기열에 남음)", () => {
  const P = project("cap");
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push(say(P, "말 " + i + " " + "나".repeat(CF.CLASSIFY_WORD_SHOW - 10)).id);
  const inp = CF.classifyInput(P.ws, P.repo);
  const per = CF.CLASSIFY_WORD_SHOW;
  assert.ok(inp.items.length === Math.floor(CF.CLASSIFY_BATCH_CHARS / per) && inp.items.length < 8, "상한에서 멈춤 " + inp.items.length);
});
t("수칙서 파일이 승인 전이면 입력 거절(envelope-inactive) — 실행해도 말은 소모되지 않고 대기열에 남음", async () => {
  const P = project("inact");
  const a = say(P, "승인 전 수칙서 상태에서 한 지속 기준 문장입니다");
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  assert.strictEqual(CF.classifyInput(P.ws, P.repo).reason, "envelope-inactive");
  const calls = [];
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }, calls) });
  assert.ok(r.st === "input-failed" && r.reason === "envelope-inactive" && !calls.length, JSON.stringify(r));
  assert.strictEqual(statusOf(P, a.id), "queued");
});

sec("[2] 답 판독 — 작문 차단·형식 거부·성격 3종");
t("손상=전량 거부(JSON 아님·옛 담기 이름·상한 초과·성격 밖·옛 자리·근거·판정 영향·항목 번호 형식) · 울타리 1겹 관용 · 의미 거부=항목 탈락(원문 아님·생략 걸침·민감·모르는 번호)", () => {
  const P = project("parse");
  say(P, "검증할 때 실제 기기 확인은 이번 단계 범위 밖이야. 파일은 C:\\work\\x.txt 에 있어. 보고는 항상 표로 정리해 줘");
  const inp = CF.classifyInput(P.ws, P.repo);
  const W = "지속 기준이라 계속 지켜야 함", BD = "실기기 확인 누락을 결함으로 잡지 않는다";
  const Q = "실제 기기 확인은 이번 단계 범위 밖이야";
  const one = (row) => CF.parseClassifyOutput(JSON.stringify({ results: [row] }), inp);
  assert.strictEqual(CF.parseClassifyOutput("설명 {}", inp).reason, "no-json");
  assert.strictEqual(CF.parseClassifyOutput(JSON.stringify({ candidates: [] }), inp).reason, "no-results-array", "옛 담기 이름(candidates)=전량 거부");
  assert.strictEqual(CF.parseClassifyOutput(JSON.stringify({ results: [], candidates: [{ ref: "u1", seat: "alwaysBlocker", quote: Q, why: W }] }), inp).reason, "unknown-top-key", "★새·옛 담기 이름 혼합=전량 거부(검증 1회차 blocker)");
  assert.strictEqual(CF.parseClassifyOutput(JSON.stringify({ results: [], note: "x" }), inp).reason, "unknown-top-key", "다른 최상위 키=전량 거부");
  assert.strictEqual(CF.parseClassifyOutput(JSON.stringify({ results: Array.from({ length: CF.CLASSIFY_MAX_PER_RUN + 1 }, () => ({ ref: "u1", kind: "style", quote: "x", why: W })) }), inp).reason, "too-many");
  assert.strictEqual(one({ ref: "u1", kind: "rule", quote: Q, why: W }).reason, "bad-kind", "성격 밖");
  assert.strictEqual(one({ ref: "u1", seat: "outOfScope", quote: Q, why: W, bounds: BD }).reason, "bad-kind", "성격 없는 옛 행");
  assert.strictEqual(one({ ref: "u1", kind: "boundary", seat: "core", quote: Q, why: W, bounds: BD }).reason, "bad-seat");
  for (const old of ["rule", "decision"]) assert.strictEqual(one({ ref: "u1", kind: "boundary", seat: old, quote: Q, why: W, bounds: BD }).reason, "bad-seat", "옛 자리=" + old);
  for (const bb of [undefined, "짧음", "여러 줄\n영향입니다 길게", "가".repeat(CF.CLASSIFY_BOUNDS_MAX + 1)]) assert.strictEqual(one({ ref: "u1", kind: "boundary", seat: "outOfScope", quote: Q, why: W, ...(bb === undefined ? {} : { bounds: bb }) }).reason, "bad-bounds", "★판정 영향 한 줄 필수(§3-1 1항) " + bb);
  assert.strictEqual(one({ ref: "u1", kind: "emphasis", quote: Q, why: W, itemRef: "B9" }).reason, "bad-itemref", "목록에 없는 번호");
  for (const bw of ["짧음", "여러 줄\n근거입니다 길게", "가".repeat(CL.CONSTRAINT_WHY_MAX + 1)]) assert.strictEqual(one({ ref: "u1", kind: "style", quote: "보고는 항상 표로 정리해 줘", why: bw }).reason, "bad-why", "근거 형식(검증 1회차 f-25b85198)");
  const ok = CF.parseClassifyOutput("```json\n" + JSON.stringify({ results: [] }) + "\n```", inp);
  assert.ok(ok.ok && ok.items.length === 0);
  const r = CF.parseClassifyOutput(JSON.stringify({ results: [
    { ref: "u1", kind: "boundary", seat: "outOfScope", quote: Q, why: W, bounds: BD },
    { ref: "u1", kind: "style", quote: "보고는 항상 표로 정리해 줘", why: "보고 형식에 대한 지속 요구" },
    { ref: "u1", kind: "boundary", seat: "alwaysBlocker", quote: "실제 기기는 이번 단계에서 빼자", why: W, bounds: BD },
    { ref: "u1", kind: "boundary", seat: "alwaysBlocker", quote: "파일은 [생략] 에 있어", why: W, bounds: BD },
    { ref: "u1", kind: "style", quote: "파일은 C:\\work\\x.txt 에 있어", why: W },
  ] }), inp);
  assert.ok(r.ok && r.items.length === 2 && r.items[0].kind === "boundary" && r.items[0].seat === "outOfScope" && r.items[0].bounds === BD && r.items[1].kind === "style" && !("seat" in r.items[1]), JSON.stringify(r));
  assert.deepStrictEqual(r.dropped.map((x) => x.reason), ["not-in-words", "redacted-span", "sensitive-path"]);
  const ru = one({ ref: "u9", kind: "style", quote: "실제 기기 확인은 이번 단계", why: W });
  assert.ok(ru.ok && !ru.items.length && ru.dropped[0].reason === "unknown-ref", "모르는 번호=항목 탈락 " + JSON.stringify(ru));
  const prk = CF.buildClassifyPrompt(inp, "ko"), pre = CF.buildClassifyPrompt(inp, "en");
  assert.ok(!/rule\|decision|decisionKind|결정 기록/.test(prk) && !/rule\|decision|decisionKind/.test(pre), "프롬프트에 옛 자리 없음");
  assert.ok(prk.includes("boundary") && prk.includes("emphasis") && prk.includes("style") && prk.includes("bounds") && prk.includes("{\"results\":"), "성격 3종·판정 영향·담기 이름");
  assert.ok(prk.includes("[이미 있는 것 — 사용자가 직접 쓰는 규칙 칸]") && prk.includes("[이미 있는 것 — 구현 담당 판단을 기다리는 앞선 결과]") && !prk.includes("[이미 있는 것 — 결정 기록]"), "결정 장부는 분류 입력에 넣지 않음(§2 A)");
});
t("다시 강조 — '이미 있는 것' 항목에 번호(B·R·P·N·W) · itemRef 는 그 번호만 · 결과에 번호와 그 문장을 함께", () => {
  const P = project("emph");
  const R2 = "질문은 항상 선택지 도구로 한 번에 물어봐 줘";
  assert.ok(CL.updateContractPatch(P.ws, CL.loadLang(), { claude: [R2] }, { tries: 3 }).ok);
  say(P, "다시 말하지만 질문은 항상 선택지 도구로 한 번에 물어봐 줘");
  const inp = CF.classifyInput(P.ws, P.repo);
  assert.ok(inp.labels.rules[0] === "R1" && inp.refs.R1.includes("선택지 도구"), JSON.stringify(inp.labels));
  assert.ok(CF.buildClassifyPrompt(inp, "ko").includes("- R1: " + R2), "번호가 붙은 목록");
  const r = CF.parseClassifyOutput(JSON.stringify({ results: [{ ref: "u1", kind: "emphasis", quote: "질문은 항상 선택지 도구로 한 번에 물어봐 줘", itemRef: "R1", why: "이미 있는 규칙 칸 항목을 다시 강조함" }] }), inp);
  assert.ok(r.ok && r.items[0].itemRef === "R1" && r.items[0].itemText.includes("선택지 도구"), JSON.stringify(r));
});

sec("[3] 실행 — 분류 결과 장부만 · 말 상태·영수증");
t("★결과는 분류 결과 장부에만 — 수칙서 후보 장부·옛 자리 장부 무접촉 · 성격별 필드 · 고르지 않은 말도 전부 classified · 팔=self · 민감 생략 · 영수증", async () => {
  const P = project("run");
  const A = "화면에 보이는 연결 상태와 실제 연결 상태는 언제나 같아야 해";
  const B = "실제 최신폰 확인은 이번 단계 범위 밖이고 내 폰만 기준이야";
  const C = "설명할 때는 기술용어 대신 상황 예시로 말해 줘";
  const D = "화면을 띄우고 단계를 밟아 한 단계씩 진행해 줘";
  const ws = [say(P, "먼저 이거 고쳐 줘. " + A), say(P, B + " 토큰 " + "z".repeat(40)), typed(P, C), say(P, D), say(P, "고마워 잘 됐네")];
  const calls = [];
  const W = "프로젝트 내내 지킬 사용자 기준";
  const ans = (prompt) => ({ results: [
    { ref: refOf(prompt, A), kind: "boundary", seat: "alwaysBlocker", quote: A, why: W, bounds: "화면과 실제 연결 상태가 다르면 언제나 결함으로 본다" },
    { ref: refOf(prompt, "내 폰만 기준이야"), kind: "boundary", seat: "outOfScope", quote: B, why: W, bounds: "최신폰 미확인을 결함으로 잡지 않는다" },
    { ref: refOf(prompt, C), kind: "style", quote: C, why: "설명 방식에 대한 지속 요구" },
    { ref: refOf(prompt, D), kind: "style", quote: D, why: "진행 방식에 대한 요구" },
  ] });
  const candBefore = CL.readEnvelopeCandidates(P.ws).rows.length;
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner(ans, calls) });
  assert.ok(r.st === "ok" && r.words === 5 && r.resultIds.length === 4 && r.counts.boundary === 2 && r.counts.style === 2 && r.counts.emphasis === 0 && !("envIds" in r), JSON.stringify(r));
  assert.ok(calls.length === 1 && calls[0].arm === "self" && !calls[0].prompt.includes("zzzzzzzz") && calls[0].prompt.includes("[생략]"), "팔·민감 생략");
  assert.strictEqual(CL.readEnvelopeCandidates(P.ws).rows.length, candBefore, "★수칙서 후보 장부 무접촉(일하는 방식 말이 수칙서 후보로 가던 길 차단)");
  assert.ok(!fs.existsSync(CF.seatsFileFor(P.ws)), "옛 자리 장부에 쓰지 않음");
  const rs = CF.readClassifyResults(P.ws);
  assert.ok(!rs.readError && rs.latest.size === 4);
  const b1 = rs.latest.get(r.resultIds[0]);
  assert.ok(b1.kind === "boundary" && b1.seat === "alwaysBlocker" && b1.bounds.includes("언제나 결함") && b1.status === "new" && b1.repoKey === P.rk && b1.provider === "claude" && b1.quoteSource === "prompt" && b1.wordId === ws[0].id && b1.gen === CL.GEN0_HASH, JSON.stringify(b1));
  const st1 = [...rs.latest.values()].find((x) => x.quote === D);
  assert.ok(st1 && st1.kind === "style" && !("seat" in st1) && !("bounds" in st1), "일하는 방식=칸·영향 없음 " + JSON.stringify(st1));
  assert.strictEqual(r.resultIds[2], CF.classifyResultIdFor(P.ws, P.rk, "style", C, ws[2].id), "결과 id 산식");
  for (const w of ws) assert.strictEqual(statusOf(P, w.id), "classified", "말 상태");
  const runs = CF.readClassifyRows(P.ws).filter((x) => x.type === "run");
  assert.ok(runs.length === 1 && runs[0].outcome === "results" && runs[0].trigger === "manual" && runs[0].counts.boundary === 2, JSON.stringify(runs[0]));
  const rc = CL.readSelectorUsage().filter((x) => x.purpose === "classify" && x.wsKey === CL.wsKeyFor(P.ws));
  assert.ok(rc.length === 1 && rc[0].selectedIds.length === 4 && rc[0].askId === "", "영수증(검증 선별로 오인되지 않는 표식)");
  const again = await CF.runClassify(P.ws, { pageRunner: fakeRunner(ans, []) });
  assert.strictEqual(again.st, "empty", "분류된 말은 다시 넘기지 않음");
  // 요약·화면 자료
  const sm = CF.classifySummary(P.ws);
  assert.deepStrictEqual(sm.results, { boundary: 2, emphasis: 0, style: 2 });
  const v = CF.userWordsView(P.ws);
  assert.ok(v.results && v.results.boundary.length === 2 && v.results.style.length === 2 && v.results.boundary.every((x) => x.seat && x.bounds) && v.results.style.every((x) => !x.seat), JSON.stringify(v.results));
  // [검증 1회차 blocker] 새·옛 담기 이름이 섞인 답=답 전체 거부 — 말은 분류 완료로 소모되지 않고 재시도 · 결과 장부 무변
  const M = "혼합 담기 이름 반례용 지속 기준 문장은 언제나 지켜야 해";
  const mw = say(P, M);
  const resB0 = fs.readFileSync(CF.resultsFileFor(P.ws), "utf8");
  const mix = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [], candidates: [{ ref: refOf(p, M), seat: "alwaysBlocker", quote: M, why: W }] })) });
  assert.ok(mix.st === "parse-failed" && mix.reason === "unknown-top-key", JSON.stringify(mix));
  assert.ok(statusOf(P, mw.id) === "queued" && UW.queuedWords(P.ws, P.rk)[0].retries === 1 && fs.readFileSync(CF.resultsFileFor(P.ws), "utf8") === resB0, "말 재시도·결과 장부 무변");
  assert.ok((await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }) })).st === "ok" && statusOf(P, mw.id) === "classified", "(정리) 다음 실행에서 처리");
  // 옛 자리·성격 밖 답=답 전체 거부 — 말은 재시도 대상 · 어떤 장부에도 쓰지 않음
  const E = "설명할 때는 항상 상황 예시를 먼저 들어 줘 — 계속 지켜";
  const e = say(P, E);
  const resBytes = fs.readFileSync(CF.resultsFileFor(P.ws), "utf8");
  const bad = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, E), kind: "rule", quote: E, why: W }] })) });
  assert.ok(bad.st === "parse-failed" && bad.reason === "bad-kind", JSON.stringify(bad));
  assert.ok(statusOf(P, e.id) === "queued" && UW.queuedWords(P.ws, P.rk)[0].retries === 1, "재시도 대상으로 남음");
  assert.ok(CL.readEnvelopeCandidates(P.ws).rows.length === candBefore && fs.readFileSync(CF.resultsFileFor(P.ws), "utf8") === resBytes && !fs.existsSync(CF.seatsFileFor(P.ws)), "아무 장부에도 쓰지 않음");
});
t("중복·거절 기억: 이미 후보로 있는 같은 말=탈락 · 사용자가 안 올린 말=탈락(세대 무관) · 같은 인용의 판정 경계 결과가 있으면 탈락 · 재실행 멱등 · '이미 있는 것' 목록(안 올림·규칙 칸·옛 자리 안 올림·판단 대기 결과)", async () => {
  const P = project("dup");
  const A = "검증 단계에서 사용자 원래 설정은 반드시 되돌려 놓아야 해";
  const R = "보고할 때는 설치 위치와 남은 일을 함께 알려 줘";
  const R2 = "질문은 항상 선택지 도구로 한 번에 물어봐 줘";
  const anc = CL.turnAnchorOf("cf-dup", "2026-10-05T01:00:00.000Z");
  const s0 = CL.writeConstraintTurnSnapshot(P.ws, anc, A);
  assert.ok(CL.constraintAdd(P.ws, A, "사용자 기준", "", { ok: true, provider: "claude", sessionId: "cf-dup", turnAnchor: anc, sourceHash: s0.sourceHash, repoKey: P.rk }).ok);
  assert.ok(CL.updateContractPatch(P.ws, CL.loadLang(), { claude: [R2] }, { tries: 3 }).ok);
  say(P, A); say(P, R); say(P, R2);
  const W = "프로젝트 내내 지킬 사용자 기준", BD = "이 기준을 어기면 언제나 결함으로 본다";
  const bnd = (prompt, q) => ({ ref: refOf(prompt, q), kind: "boundary", seat: "alwaysBlocker", quote: q, why: W, bounds: BD });
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [bnd(p, A), bnd(p, R)] })) });
  assert.ok(r.st === "ok" && r.resultIds.length === 1, JSON.stringify(r));
  assert.deepStrictEqual(r.dropped.map((x) => x.reason), ["duplicate"], "이미 후보로 있는 말");
  // 같은 인용을 다른 말에서 또 판정 경계로 냄=탈락(판단 대기 결과가 있음)
  say(P, "다시: " + R);
  const r1 = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, "다시: " + R), kind: "boundary", seat: "alwaysBlocker", quote: R, why: W, bounds: BD }] })) });
  assert.deepStrictEqual(r1.dropped.map((x) => x.reason), ["duplicate-result"], JSON.stringify(r1));
  // 사용자가 안 올림 → 같은 말이 다시 와도 탈락
  const cid = CF.userConstraintIdFor(P.ws, P.rk, A);
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: cid, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: new Date().toISOString() }]));
  say(P, A);
  const r2 = await CF.runClassify(P.ws, { pageRunner: fakeRunner((prompt) => ({ results: [bnd(prompt, A)] })) });
  assert.deepStrictEqual(r2.dropped.map((x) => x.reason), ["user-declined"], JSON.stringify(r2));
  // 옛 자리 장부(이 정정 전 기록) — 안 올린 문장은 '안 올림'으로 싣고, 승인 길이 없어진 대기 제안은 '확인 대기'로 싣지 않는다 · 장부는 바뀌지 않는다
  const OLD_DECL = "옛 자리에서 사용자가 안 올린 문장입니다", OLD_PEND = "옛 자리에서 아직 대기 중이던 문장입니다";
  const legacy = [
    { schema: "user-seat-v1", wsKey: CL.wsKeyFor(P.ws), candidateId: "a".repeat(16), status: "proposed", seat: "rule", repoKey: P.rk, provider: "claude", quote: OLD_DECL, why: "옛 규칙 칸 제안", ts: "2026-10-05T00:00:00.000Z" },
    { schema: "user-seat-v1", wsKey: CL.wsKeyFor(P.ws), candidateId: "a".repeat(16), status: "declined", by: "user", ts: "2026-10-05T00:01:00.000Z" },
    { schema: "user-seat-v1", wsKey: CL.wsKeyFor(P.ws), candidateId: "b".repeat(16), status: "proposed", seat: "decision", repoKey: P.rk, provider: "claude", quote: OLD_PEND, why: "옛 결정 기록 제안", decisionKind: "product", ts: "2026-10-05T00:02:00.000Z" },
  ];
  fs.mkdirSync(CF.CLASSIFY_DIR, { recursive: true });
  fs.writeFileSync(CF.seatsFileFor(P.ws), legacy.map((x) => JSON.stringify(x)).join(NL) + NL);
  const seatBytes = fs.readFileSync(CF.seatsFileFor(P.ws), "utf8");
  say(P, "다음 분류 입력 확인용 말");
  const in3 = CF.classifyInput(P.ws, P.repo);
  assert.ok(in3.existing.declined.some((x) => x.includes("반드시 되돌려")) && in3.existing.declined.some((x) => x.includes(OLD_DECL)) && in3.existing.rules.some((x) => x.includes("선택지 도구")), "안 올린 것·규칙 칸이 '이미 있는 것'으로 동봉");
  assert.ok(in3.existing.waiting.some((x) => x.includes("설치 위치")), "판단 대기 결과가 '이미 있는 것'으로 동봉");
  assert.ok(!in3.existing.pending.some((x) => x.includes(OLD_PEND)) && !("decisions" in in3.existing), "옛 대기 제안·결정 장부는 싣지 않음");
  await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }) });
  assert.strictEqual(fs.readFileSync(CF.seatsFileFor(P.ws), "utf8"), seatBytes, "옛 자리 장부 무변경(ab-5)");
  // 재실행 멱등 — 같은 말 묶음의 커밋을 두 번 해도 결과 행이 늘지 않음
  say(P, "멱등 확인용 일하는 방식 말은 항상 짧게 보고해 줘");
  const inI = CF.classifyInput(P.ws, P.repo);
  const pI = CF.parseClassifyOutput(JSON.stringify({ results: [{ ref: "u1", kind: "style", quote: "일하는 방식 말은 항상 짧게 보고해 줘", why: "보고 방식에 대한 지속 요구" }] }), inI);
  const c1 = CF.commitClassify(P.ws, inI, pI, {}), c2 = CF.commitClassify(P.ws, inI, pI, {});
  assert.ok(c1.ok && c1.resultIds.length === 1 && c2.ok && c2.resultIds.length === 0 && c2.dropped.some((x) => x.reason === "duplicate-result"), JSON.stringify([c1, c2]));
});
t("결과 장부 판독 오류=입력 거절·말 보존(빈 목록으로 줄이지 않음 — 같은 뜻 결과 중복 생성 방지) · 커밋도 거절", async () => {
  const P = project("resbad");
  const a = say(P, "결과 장부 판독 오류 시험용 지속 기준 문장입니다");
  fs.mkdirSync(CF.resultsFileFor(P.ws), { recursive: true }); // 파일 자리에 폴더=판독 오류
  assert.strictEqual(CF.classifyInput(P.ws, P.repo).reason, "results-unreadable");
  const calls = [];
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }, calls) });
  assert.ok(r.st === "input-failed" && r.reason === "results-unreadable" && !calls.length, JSON.stringify(r));
  assert.strictEqual(statusOf(P, a.id), "queued");
  assert.strictEqual(CF.commitClassify(P.ws, { items: [], repoKey: P.rk, gen: CL.GEN0_HASH }, { items: [], dropped: [] }, {}).reason, "results-unreadable");
  assert.strictEqual(CF.userWordsView(P.ws).results, null, "화면 자료=판독 불가(null)");
  fs.rmSync(CF.resultsFileFor(P.ws), { recursive: true, force: true });
});

sec("[4] 실패 보존 — 재시도·보류·경보");
t("근거 형식 위반 답(짧은 why)=실패 처리 — 말은 분류 완료로 소모되지 않고 queued·재시도 1(검증 1회차 f-25b85198 반례)", async () => {
  const P = project("badwhy");
  const Q = "근거 형식 반례용 지속 기준 문장입니다 계속 지켜 주세요";
  const a = say(P, Q);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, Q), kind: "boundary", seat: "alwaysBlocker", quote: Q, why: "short", bounds: "어기면 언제나 결함으로 본다" }] })) });
  assert.ok(r.st === "parse-failed" && r.reason === "bad-why", JSON.stringify(r));
  assert.strictEqual(statusOf(P, a.id), "queued");
  assert.strictEqual(UW.queuedWords(P.ws, P.rk)[0].retries, 1);
});
t("호출 실패·답 손상=말은 대기열에 남고 재시도 횟수만 증가 · 상한 도달=보류(classify-failed) · 경보 기록", async () => {
  const P = project("fail");
  const a = say(P, "실패 시험용 지속 기준 문장입니다 계속 지켜 주세요");
  for (let i = 1; i < CF.CLASSIFY_RETRY_MAX; i++) {
    const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner(i === 1 ? { ok: false, key: "call-failed" } : "산문 답") });
    assert.ok(r.st === (i === 1 ? "call-failed" : "parse-failed"), JSON.stringify(r));
    assert.strictEqual(statusOf(P, a.id), "queued");
    assert.strictEqual(UW.queuedWords(P.ws, P.rk)[0].retries, i, "재시도 횟수");
  }
  const r3 = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ ok: false, key: "timeout" }) });
  assert.ok(r3.st === "call-failed" && r3.held === 1);
  assert.strictEqual(statusOf(P, a.id), "held");
  const h = UW.heldWords(P.ws, P.rk);
  assert.ok(h.length === 1 && h[0].heldReason === "classify-failed", "화면 '분류하지 못한 말' 재료");
  const ev = CL.readIntegrityEvents().filter((e) => e.kind === "classify-failed" && e.workspace === P.ws);
  assert.ok(ev.length >= 1, "경보");
});
t("[AFTER-0.1.104-FIXES 묶음 A-3] 도우미 모델이 거절하고 다른 모델 재시도로도 못 풀면 — 실패 이유 refused·말은 대기열에 남음·실행 기록과 영수증에 거절 칸·경보는 '안전상 이유로 거절'로 풀어 씀", async () => {
  const P = project("refused");
  const a = say(P, "거절 시험용 지속 기준 문장입니다 계속 지켜 주세요");
  const refusal = { by: "model-a", retryModel: "model-b", retryHow: "default", retry: "refused", used: "model-b" };
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ ok: false, key: "refused", detail: "by=model-a retry=model-b:refused", runner: { tier: "new", version: "9.9.9", how: "t", refusal } }) });
  assert.ok(r.st === "call-failed" && r.reason === "refused", JSON.stringify(r));
  assert.strictEqual(statusOf(P, a.id), "queued", "말은 대기열에 남음");
  const run = CF.readClassifyRows(P.ws).filter((x) => x.type === "run").slice(-1)[0];
  assert.ok(run.reason === "refused" && run.runner && JSON.stringify(run.runner.refusal) === JSON.stringify(refusal), JSON.stringify(run));
  const rc = CL.readSelectorUsage().filter((x) => x.purpose === "classify" && x.wsKey === CL.wsKeyFor(P.ws)).slice(-1)[0];
  assert.ok(rc && rc.outcome === "failed:refused" && rc.runner.refusal.retry === "refused", JSON.stringify(rc));
  const ev = CL.readIntegrityEvents().filter((e) => e.kind === "classify-failed" && e.workspace === P.ws).slice(-1)[0];
  assert.ok(ev && /안전상 이유로 답을 거절/.test(ev.detail) && /그 모델도 거절/.test(ev.detail) && !/\(refused\)/.test(ev.detail), ev && ev.detail);
  // 평소 실패는 종전 문구 그대로
  const r2 = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ ok: false, key: "call-failed" }) });
  assert.ok(r2.st === "call-failed" && r2.reason === "call-failed");
  const ev2 = CL.readIntegrityEvents().filter((e) => e.kind === "classify-failed" && e.workspace === P.ws).slice(-1)[0];
  assert.ok(/분류 실행이 실패했습니다\(call-failed\)/.test(ev2.detail), ev2.detail);
});
t("원문 못 읽는 말=보류(text-unavailable)로 표면 · 나머지만 분류 · 잠금 경합=실행 안 함", async () => {
  const P = project("unav");
  const d = say(P, "곧 원문이 지워질 말입니다 지속 기준 아님");
  const e = say(P, "남아 있는 말입니다 이것도 기준 아님");
  fs.rmSync(CL.constraintTurnFileFor(P.ws, d.anchor));
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }) });
  assert.ok(r.st === "ok" && r.words === 1 && r.unavailable === 1, JSON.stringify(r));
  assert.ok(statusOf(P, d.id) === "held" && UW.heldWords(P.ws, P.rk).find((w) => w.id === d.id).heldReason === "text-unavailable");
  assert.strictEqual(statusOf(P, e.id), "classified");
  say(P, "잠금 시험 말입니다 기준 아님");
  const lk = CF.acquireClassifyLock(P.ws);
  assert.ok(lk.ok);
  const r2 = await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }) });
  assert.ok(r2.st === "locked" && r2.reason === "running");
  CF.releaseClassifyLock(P.ws, lk.token);
});
t("회사별 팔(R3): Codex 차례의 말=Codex 팔 · 섞인 대기열은 오래된 말의 회사부터 한 묶음", async () => {
  const P = project("arm");
  say(P, "코덱스 차례에서 한 말입니다 기준 아님", "codex");
  say(P, "클로드 차례에서 한 말입니다 기준 아님", "claude");
  const calls = [];
  await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }, calls) });
  await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }, calls) });
  assert.deepStrictEqual(calls.map((c) => c.arm), ["codex", "self"]);
  assert.ok(calls[0].prompt.includes("코덱스 차례") && !calls[0].prompt.includes("클로드 차례"), "다른 회사 말은 같은 묶음에 없음");
});

t("회사 경계(R3)는 '이미 있는 것' 목록에도 — 다른 회사 차례의 확인 대기·안 올림 후보와 판단 대기 결과 원문은 이 회사 분류 입력에 실리지 않음(검증 1회차 f-7ccbb34a 반례)", async () => {
  const P = project("r3list");
  const W = "프로젝트 내내 지킬 사용자 기준", BD = "이 기준을 어기면 언제나 결함으로 본다";
  const CP = "클로드 차례 대기 후보 문장 비밀스러운 내용 하나", CD = "클로드 차례 거절 후보 문장 비밀스러운 내용 둘", CS = "클로드 차례 판단 대기 결과 비밀스러운 내용 셋";
  const XP = "코덱스 차례 대기 후보 문장 공개 가능한 내용", XW = "코덱스 차례 판단 대기 결과 공개 가능한 내용";
  const cand = (q, provider) => ({ candidateId: CF.userConstraintIdFor(P.ws, P.rk, q), envelopeHash: CL.GEN0_HASH, virtualGen: true, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: q, why: W, provider, ts: new Date().toISOString() });
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [cand(CP, "claude"), cand(CD, "claude"), cand(XP, "codex")]));
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: CF.userConstraintIdFor(P.ws, P.rk, CD), envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: new Date().toISOString() }]));
  say(P, CS); say(P, XW, "codex");
  const r1 = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, CS), kind: "boundary", seat: "outOfScope", quote: CS, why: W, bounds: BD }] })) });
  assert.ok(r1.arm === "self" && r1.resultIds.length === 1, JSON.stringify(r1));
  const r2 = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, XW), kind: "boundary", seat: "outOfScope", quote: XW, why: W, bounds: BD }] })) });
  assert.ok(r2.arm === "codex" && r2.resultIds.length === 1, JSON.stringify(r2));
  say(P, "코덱스 차례 다음 말 기준 아님", "codex");
  const inX = CF.classifyInput(P.ws, P.repo);
  const prX = CF.buildClassifyPrompt(inX, "ko");
  assert.ok(inX.arm === "codex" && !prX.includes("비밀스러운"), "Claude 승인 전 원문 미동봉(대기·안 올림·판단 대기 결과 모두)");
  assert.ok(inX.existing.pending.some((x) => x.includes("공개 가능한")) && inX.existing.waiting.some((x) => x.includes("판단 대기 결과 공개")), "같은 회사 것은 동봉");
  await CF.runClassify(P.ws, { pageRunner: fakeRunner({ results: [] }) });
  say(P, "클로드 차례 다음 말 기준 아님", "claude");
  const inC = CF.classifyInput(P.ws, P.repo);
  const prC = CF.buildClassifyPrompt(inC, "ko");
  assert.ok(inC.arm === "self" && prC.includes("비밀스러운 내용 하나") && prC.includes("비밀스러운 내용 둘") && prC.includes("비밀스러운 내용 셋") && !prC.includes("공개 가능한"), "회사별 대칭");
});
sec("[5] 옛 자리 정리(RULE-SUPPLY-CORRECTION 묶음 1) — 승인 함수 부재·결정 출처 새로 만들기 implementer 만·읽기 호환");
t("규칙 칸·결정 기록 승인 함수가 없다 · 분류 실행 모듈은 결정 장부·규칙 칸에 쓰지 않는다(소스)", () => {
  for (const k of ["approveSeatCandidate", "declineSeatCandidate", "listSeatCandidates", "appendSeatRows", "seatCandidateId"]) assert.strictEqual(typeof CF[k], "undefined", k);
  const src = fs.readFileSync(path.join(ROOT, "bridge", "classify.js"), "utf8");
  assert.ok(!/appendDecisionRows\(|openDecision\(|updateContractPatch\(|appendFileSync\(seatsFileFor/.test(src), "결정 장부·규칙 칸·자리 장부 쓰기 호출 없음");
  // ★[⑤] 분류 담당(분류 실행·결과 기록 경로)은 수칙서 후보 장부에 쓰지 않는다 — 이 모듈의 유일한 후보 쓰기는 '구현 담당이 올림으로 판단한 표식'의 빠진 기록 채우기(repairClaims) 하나뿐
  const fnBody = (name) => { const i = src.indexOf("function " + name + "("); const j = src.indexOf("\nfunction ", i + 10); const k = src.indexOf("\nasync function ", i + 10); const e = [j, k].filter((x) => x > i).sort((a, b) => a - b)[0] || src.length; return src.slice(i, e); };
  for (const fn of ["commitClassify", "runClassify", "classifyInput", "parseClassifyOutput", "classifyTick"]) assert.ok(!/appendEnvelopeCandidates\(/.test(fnBody(fn)), "★[⑤] 분류 실행 경로에 후보 장부 쓰기 없음: " + fn);
  const uses = src.split("appendEnvelopeCandidates(").length - 1;
  assert.ok(uses === 1 && /if \(claim\.decision === "raised" && claim\.candidateRow && !cst\.rows\.some\(\(r\) => r && r\.fromResult === resultId\)\) \{ if \(CL\.appendEnvelopeCandidates\(ws, \[Object\.assign\(\{\}, claim\.candidateRow, \{ repaired: true/.test(fnBody("repairClaims")), "★[⑤] 유일한 후보 쓰기=구현 담당 올림 표식의 빠진 기록 채우기 " + uses);
});
t("결정 출처: 새 열린 행은 implementer 만(openDecision·appendDecisionRows 둘 다) · 과거 user-words 열린+답한 행은 계속 판독", () => {
  const P = project("decorigin");
  assert.deepStrictEqual(CL.DECISION_CREATE_ORIGINS, ["implementer"]);
  assert.ok(CL.DECISION_ORIGINS.includes("user-words") && CL.DECISION_ORIGINS.includes("implementer"), "읽기 호환 목록");
  const spec = { origin: "user-words", kind: "product", noDefault: "사용자가 직접 말한 결정이라 구현자가 정할 항목 아님", campaignId: "", sourceAsk: "", targetFp: "user-words:x", question: "앱 하나로 간다", why: "제품 방향", choices: [{ key: "stated", label: "앱 하나로 간다" }], recommend: "stated", repoKey: P.rk };
  assert.strictEqual(CL.openDecision(P.ws, spec).reason, "origin-not-allowed", "openDecision 거부");
  const id = CL.decisionIdFor(P.ws, "", "user-words", "", CL.decisionIdKeyFor("user-words:x", "앱 하나로 간다"), P.rk);
  const open = { schema: "decision-v1", decisionId: id, status: "open", wsKey: CL.wsKeyFor(P.ws), repoKey: P.rk, origin: "user-words", kind: "product", noDefault: spec.noDefault, campaignId: "", sourceAsk: "", targetFp: "user-words:x", question: "앱 하나로 간다", why: "제품 방향", choices: spec.choices, recommend: "stated", ts: "2026-10-05T00:00:00.000Z" };
  const done = { schema: "decision-v1", decisionId: id, status: "chosen", wsKey: CL.wsKeyFor(P.ws), repoKey: P.rk, choice: "stated", by: "user", ts: "2026-10-05T00:00:01.000Z" };
  const r = CL.appendDecisionRows(P.ws, [open, done]);
  assert.ok(!r.ok && r.reason === "origin-not-allowed", "appendDecisionRows 도 새 user-words 열린 행 거부 " + JSON.stringify(r));
  assert.strictEqual(CL.readDecisions(P.ws, { repoKey: P.rk }).latest.size, 0, "거부 시 무기록");
  // 과거에 정상 기록된 user-words 두 행(이 정정 전 도장) — 판독 유지
  fs.mkdirSync(path.dirname(CL.decisionsFileFor(P.ws)), { recursive: true });
  fs.appendFileSync(CL.decisionsFileFor(P.ws), JSON.stringify(open) + NL + JSON.stringify(done) + NL);
  const d = CL.readDecisions(P.ws, { repoKey: P.rk }).latest.get(id);
  assert.ok(d && d.origin === "user-words" && d.status === "chosen" && d.question === "앱 하나로 간다", "과거 행 판독 " + JSON.stringify(d));
  // 결과 행(chosen)은 출처와 무관하게 기존 계약 그대로 · implementer 새 열린 행은 그대로 허용
  const ok = CL.openDecision(P.ws, Object.assign({}, spec, { origin: "implementer", targetFp: "impl:y", question: "구현자가 못 정하는 방향 질문" }));
  assert.ok(ok.ok && !ok.existed, JSON.stringify(ok));
});

sec("[6] 수칙서 칸 갈래 — 지원 환경·범위 밖=본문 전용 · 세대 이월·복원 칸 보존");
// 이 정정 전 분류 담당이 후보 장부에 직접 남긴 옛 후보 행(origin classifier · 칸) — 그 자료는 계속 다룬다(사용자가 처리)
async function classified(P, axis, quote) {
  const w = say(P, quote);
  let gen = CL.GEN0_HASH, virt = true; try { const g = CL.envelopeGenFor(P.ws, P.repo, CL.loadContract(P.ws)); if (g && g.gen) { gen = g.gen; virt = !!g.virtual; } } catch { /* 0세대 */ }
  const id = CF.userConstraintIdFor(P.ws, P.rk, quote);
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: gen, ...(virt ? { virtualGen: true } : {}), status: "proposed", kind: "user-constraint", origin: "classifier", axis, repoKey: P.rk, title: quote, why: "프로젝트 내내 지킬 판정 기준", provider: "claude", quoteSource: "prompt", wordId: w.id, ts: new Date().toISOString() }]));
  return id;
}
t("0세대 첫 초안: 범위 밖 후보를 본문(항상)으로 → 제외 칸에 들어감 · 관련될 때(서고)로는 거부 · 한꺼번에 올리기는 본문일 때만 묶음", async () => {
  const P = project("g0ax");
  const O = "실기기 최신폰 확인은 이번 단계 범위 밖으로 둔다";
  const id = await classified(P, "outOfScope", O);
  const plan = CL.candidateBatchPlan({ live: [{ candidateId: id, kind: "user-constraint", axis: "outOfScope" }], ids: [id], gen0: true, dest: "archive" });
  assert.ok(plan.take.length === 0 && plan.excluded[0].why === "axis-core-only", JSON.stringify(plan));
  const plan2 = CL.candidateBatchPlan({ live: [{ candidateId: id, kind: "user-constraint", axis: "outOfScope" }], ids: [id], gen0: true, dest: "core" });
  assert.deepStrictEqual(plan2.take, [id]);
  const d = CL.draftEnvelopeInitial(P.ws, P.repo, { addCandidateIds: [id] });
  assert.ok(d.ok, JSON.stringify(d));
  const pr = CL.readEnvelopeProposal(P.ws, P.repo);
  const o = JSON.parse(pr.proposalText);
  assert.ok(o.outOfScope.includes(O) && !o.alwaysBlocker.includes(O), "제외 칸에 등재");
});
t("승인 세대: 범위 밖·지원 환경 후보를 서고로 올리면 거부(잘못된 칸 차단) · 본문 개정으로는 그 칸에 · 항상 막을 것 후보는 종전대로 서고 가능", async () => {
  const P = project("apax");
  const raw = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: [], outOfScope: [] });
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), raw);
  CL.setEnvelopeHashAllSlots(P.ws, sha1(raw));
  const H = sha1(raw);
  const S = "판정 기준 기기는 사용자 본인 폰 한 대로 한다";
  const idS = await classified(P, "supportedEnv", S);
  const bad = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [idS], removeItems: [], approvedHash: H, target: "archive" });
  assert.ok(!bad.ok && bad.error.includes("지원 환경") && bad.error.includes("본문"), JSON.stringify(bad));
  const good = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [idS], removeItems: [], approvedHash: H, target: "core" });
  assert.ok(good.ok, JSON.stringify(good));
  assert.ok(JSON.parse(CL.readEnvelopeProposal(P.ws, P.repo).proposalText).supportedEnv.includes(S));
  CL.discardEnvelopeProposal(P.ws);
  const A = "사용자 원래 설정을 되돌리지 않으면 언제나 결함이다";
  const idA = await classified(P, "alwaysBlocker", A);
  const arc = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [idA], removeItems: [], approvedHash: H, target: "archive" });
  assert.ok(arc.ok, "항상 막을 것=서고 가능 " + JSON.stringify(arc));
});
t("세대 이월: 수칙서가 새로 승인되면 남은 분류 후보가 칸·출처를 그대로 가지고 새 세대로 · 채택 고아 복원 줄도 저장소 표식·칸 보존", async () => {
  const P = project("carry");
  const raw1 = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: [], outOfScope: [] });
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), raw1);
  CL.setEnvelopeHashAllSlots(P.ws, sha1(raw1));
  const O = "외부 서버 연동 문제는 이번 프로젝트 범위 밖이다";
  const id = await classified(P, "outOfScope", O);
  const raw2 = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: ["s"], alwaysBlocker: [], outOfScope: [] });
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), raw2);
  CL.setEnvelopeHashAllSlots(P.ws, sha1(raw2));
  CL.reconcileMemoryCandidates(P.ws, P.repo, sha1(raw2));
  const c2 = CL.readEnvelopeCandidates(P.ws).latest.get(id + "@" + sha1(raw2));
  assert.ok(c2 && c2.status === "proposed" && c2.axis === "outOfScope" && c2.origin === "classifier" && c2.wordId && !c2.virtualGen, "이월 행 칸·출처 보존 " + JSON.stringify(c2));
  // 같은 세대 채택 고아(초안에 결속 안 됨) → 복원 행에 저장소 표식·칸
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: sha1(raw2), status: "adopted", note: "draft x", ts: new Date().toISOString() }]));
  CL.reconcileMemoryCandidates(P.ws, P.repo, sha1(raw2));
  const c3 = CL.readEnvelopeCandidates(P.ws).latest.get(id + "@" + sha1(raw2));
  assert.ok(c3.status === "proposed" && c3.repoKey === P.rk && c3.axis === "outOfScope", "복원 행 " + JSON.stringify(c3));
  const d = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: sha1(raw2), target: "core" });
  assert.ok(d.ok && JSON.parse(CL.readEnvelopeProposal(P.ws, P.repo).proposalText).outOfScope.includes(O), "복원 후 다시 올릴 수 있음 " + JSON.stringify(d));
});
t("단건 승인 목적지(순수 정본) — 정리 제안=작업 종류 · 지원 환경·범위 밖 칸=본문 고정(0세대 '관련될 때' 눌러도) · 그 밖 0세대=고른 칸·승인 세대=서고", () => {
  const D = CL.candidateSingleDest;
  assert.strictEqual(D({ kind: "curator", operation: "oos-add", gen0: true, dest: "archive" }), "core");
  assert.strictEqual(D({ kind: "curator", operation: "add", gen0: false }), "archive");
  assert.strictEqual(D({ kind: "curator", operation: "remove", gen0: true }), "");
  for (const g0 of [true, false]) for (const dest of ["archive", "core", ""]) {
    assert.strictEqual(D({ kind: "user-constraint", axis: "outOfScope", gen0: g0, dest }), "core", "범위 밖=본문");
    assert.strictEqual(D({ kind: "user-constraint", axis: "supportedEnv", gen0: g0, dest }), "core", "지원 환경=본문");
  }
  assert.strictEqual(D({ kind: "user-constraint", axis: "bogus", gen0: true, dest: "core" }), "", "모르는 칸=적용 불가");
  assert.strictEqual(D({ kind: "user-constraint", axis: "alwaysBlocker", gen0: true, dest: "core" }), "core");
  assert.strictEqual(D({ kind: "user-constraint", axis: "alwaysBlocker", gen0: true, dest: "archive" }), "archive");
  assert.strictEqual(D({ kind: "user-constraint", gen0: false, dest: "core" }), "archive", "승인 세대 단건=서고(종전)");
  assert.strictEqual(D({ kind: "rule-manual", gen0: true }), "archive", "0세대 기본=관련될 때");
});
t("대시보드 단건 승인 처리기(컴파일 산출물)의 목적지 조각을 실제 호출 — 정본 함수를 쓰고, 옛 설치본(함수 없음)이면 종전 규칙", () => {
  const src = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const i = src.indexOf("const destOf = (g0) =>");
  assert.ok(i > 0, "처리기 조각 존재");
  const end = src.indexOf(";", src.indexOf("\n", src.indexOf(": (m.kind === \"curator\"", i)) - 1);
  const body = src.slice(i, end + 1);
  const mkDest = (CLM, m, axM, opM) => new Function("CLM", "m", "axM", "opM", body + " return destOf;")(CLM, m, axM, opM);
  const real = mkDest(CL, { kind: "user-constraint", dest: "archive" }, "outOfScope", "");
  assert.strictEqual(real(true), "core", "0세대에서 '관련될 때'를 눌러도 범위 밖 칸은 본문");
  assert.strictEqual(real(false), "core", "승인 세대 단건도 본문");
  assert.strictEqual(mkDest(CL, { kind: "user-constraint", dest: "archive" }, "", "")(false), "archive", "칸 없는 후보=서고(종전)");
  const old = mkDest({}, { kind: "curator", dest: "" }, "", "oos-add");
  assert.strictEqual(old(true), "core", "옛 설치본 폴백=종전 규칙");
  const oldUc = mkDest({}, { kind: "user-constraint", dest: "core" }, "", "");
  assert.ok(oldUc(true) === "core" && oldUc(false) === "archive", "옛 설치본 폴백");
  assert.ok(src.includes('target: destOf(false) === "core" ? "core" : "archive"'), "승인 세대 단건이 이 조각을 씀");
});
t("분류 후보는 구현 담당의 턴당 상신 상한(2)에 세지 않음", async () => {
  const P = project("tcap");
  const anc = CL.turnAnchorOf("cf-tc", "2026-10-05T02:00:00.000Z");
  const T = "첫째 기준 문장은 이것이고 둘째 기준 문장은 저것이며 셋째 기준 문장은 그것이다";
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, T);
  // 같은 차례 앵커를 가진 분류 후보 2건을 장부에 직접(분류 실행이 그 차례의 말을 분류한 경우)
  const rows = ["분류가 올린 기준 하나입니다", "분류가 올린 기준 둘입니다"].map((q) => ({ candidateId: CF.userConstraintIdFor(P.ws, P.rk, q), envelopeHash: CL.GEN0_HASH, virtualGen: true, status: "proposed", kind: "user-constraint", origin: "classifier", repoKey: P.rk, title: q, why: "근거 한 줄입니다", turnAnchor: anc, ts: new Date().toISOString() }));
  assert.ok(CL.appendEnvelopeCandidates(P.ws, rows));
  const ctx = { ok: true, provider: "claude", sessionId: "cf-tc", turnAnchor: anc, sourceHash: s.sourceHash, repoKey: P.rk };
  assert.ok(CL.constraintAdd(P.ws, "첫째 기준 문장은 이것이고", "구현 담당 상신", "", ctx).ok);
  assert.ok(CL.constraintAdd(P.ws, "둘째 기준 문장은 저것이며", "구현 담당 상신", "", ctx).ok);
  assert.strictEqual(CL.constraintAdd(P.ws, "셋째 기준 문장은 그것이다", "구현 담당 상신", "", ctx).reason, "turn-cap", "구현 담당 자기 상신만 셈");
});

sec("[7] 명령줄·배포");
t("classify run/status/list --json(가짜 실행기 모듈) · 도움말에 constraint·classify · 배포 목록 3곳 · 도장 명령 없음", () => {
  const P = project("cli");
  const Q = "명령줄 시험용 지속 기준 문장은 언제나 지켜야 한다";
  say(P, Q);
  const fakeMod = path.join(HOME, "fake-classify-runner.js");
  fs.writeFileSync(fakeMod, "module.exports = { runSelectorPage: ({ prompt }) => { const i = prompt.indexOf(" + JSON.stringify(Q) + "); const h = prompt.lastIndexOf('<<u', i); const ref = prompt.slice(h + 2, prompt.indexOf(' ', h)); return { promise: Promise.resolve({ ok: true, output: JSON.stringify({ results: [{ ref, kind: 'boundary', seat: 'alwaysBlocker', quote: " + JSON.stringify(Q) + ", why: '프로젝트 내내 지킬 규칙', bounds: '어기면 언제나 결함으로 본다' }] }) }), cancel() {} }; } };");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CODEX_BRIDGE_SELECTOR_RUNNER: fakeMod });
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const r = cp.spawnSync(process.execPath, [cli, "classify", "run", "--json"], { env, encoding: "utf8", cwd: P.ws });
  const o = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.ok(r.status === 0 && o.st === "ok" && o.resultIds.length === 1 && o.counts.boundary === 1 && !("seatIds" in o) && !("envIds" in o), r.stdout + r.stderr);
  const st = JSON.parse(cp.spawnSync(process.execPath, [cli, "classify", "status", "--json"], { env, encoding: "utf8", cwd: P.ws }).stdout);
  assert.ok(st.queued === 0 && !("seatsPending" in st) && st.lastOutcome === "results" && st.results && st.results.boundary === 1, JSON.stringify(st));
  const rTxt = cp.spawnSync(process.execPath, [cli, "classify", "run"], { env, encoding: "utf8", cwd: P.ws }).stdout;
  assert.ok(/분류할 말이 없습니다|nothing waiting/.test(rTxt), "두 번째 실행=대기 없음 " + rTxt);
  const stTxt = cp.spawnSync(process.execPath, [cli, "classify", "status"], { env, encoding: "utf8", cwd: P.ws }).stdout;
  assert.ok(!/규칙·결정 자리|rule\/decision/.test(stTxt), "상태 줄에 옛 자리 없음 " + stTxt);
  const ls = JSON.parse(cp.spawnSync(process.execPath, [cli, "classify", "list", "--json"], { env, encoding: "utf8", cwd: P.ws }).stdout);
  assert.ok(Array.isArray(ls.held) && !("seats" in ls), JSON.stringify(ls));
  const bad = cp.spawnSync(process.execPath, [cli, "classify", "approve", "a".repeat(16)], { env, encoding: "utf8", cwd: P.ws });
  assert.ok(bad.status === 2 && /사용법|usage/.test(bad.stdout), "도장 명령 없음(사용법 안내)");
  const help = cp.spawnSync(process.execPath, [cli, "no-such-cmd"], { env, encoding: "utf8", cwd: P.ws }).stdout;
  assert.ok(help.includes("classify [run|status|list|skip <결과 id> --note") && help.includes("constraint add --quote") && help.includes("[--axis <칸>] [--from <분류 결과 id>]"), "도움말 목록([⑤ 2단계] 안 올림·칸·분류 결과)");
  const lists = [fs.readFileSync(path.join(ROOT, "install.js"), "utf8"), fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8"), fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8")];
  assert.ok(lists.every((s) => s.includes('"classify.js"')), "배포 목록 3곳");
});

(async () => {
  for (const [name, fn] of pending) { if (name === null) { console.log(fn); continue; } n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.filter((x) => x[0] !== null).length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
