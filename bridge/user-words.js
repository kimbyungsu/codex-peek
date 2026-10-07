"use strict";
// [RULE-SUPPLY-REDESIGN 묶음 2-나 §3-1·§3-2] 사용자 말 수집 — 선택지 직접 입력 원문 기록 + 미분류 대기열.
//  · 원문 인정 범위 확장(§3-1): 선택지 도구에 사용자가 보기 이름과 다른 글을 쓴 답(그리고 보기에 붙인 메모)을 그 차례의 '별도 원문 기록'으로 남긴다.
//    판별=형태(답 글이 그 질문의 보기 label 이나 label 조합과 같은가) — 내용 해석 없음. 문자열 "Other" 단독은 제외.
//    턴 원문 파일(constraint-turns)은 고치지 않는다 — 검증 작업이 그 지문을 시작 때 동결하기 때문(설계 §3-1).
//  · 수집 경로(§3-1 ②): 대화 기록(transcript) 파일을 '어디까지 읽었는지' 표시(세션별 커서) 이후만 읽는다 — 수백 MB 파일 전체 판독 금지.
//    훅 시점(다음 입력 제출·종료)과 약속 상신 명령 직전에 부른다. 처음 보는 세션=현재 끝에서 시작(과거 소급 없음).
//  · 차례 결속(검증 1~4회차 f-9ee8024b): 답은 수집 시점도 시각도 원문 지문도 아니라 '차례 열쇠(promptId)'로만 차례를 찾는다 — 같은 차례의
//    입력 줄과 선택지 답 줄은 같은 promptId 를 가지며, 입력 제출 훅은 그 값을 입력(prompt_id — Claude Code 2.1.196+)으로 직접 받는다
//    (대화 기록 꼬리 추측 금지 — 직전 같은 글의 열쇠를 읽는 오결속 차단). 훅이 세션별 차례 기록(turns/<세션>.jsonl)을 남기고, 수집기는 그
//    열쇠를 가진 차례가 정확히 하나일 때만 결속한다. 열쇠가 없는 입력(옛 버전)·기록 쓰기 실패·열쇠 중복은 어느 대기열에도 넣지 않고 '보류(출처 불명)'.
//  · 미분류 대기열(§3-2): 모든 사용자 말(턴 원문 + 직접 입력 기록)은 수집되는 순간 대기열에 들어간다(덧붙이기 전용 상태 행: queued → classified | held).
//    원문 텍스트는 턴 원문과 같은 7일 보존(민감 최소화 — contract-lib cleanupOldState 가 user-words/text 를 청소). 장부 행에는 지문·길이만.
//    원문은 자르지 않는다(검증 1회차 blocker④ — 절단 표식 같은 합성 글자가 '사용자 원문'으로 인정되면 안 됨).
//  · 전송: 이 모듈은 아무 데도 보내지 않는다. 분류 실행(§3-3 — 묶음 2-나-2)만 구현 턴과 같은 회사의 독립 실행에 넘긴다(R3).
//  · [RULE-SUPPLY-CORRECTION 묶음 5(G) · D-f] 붙여 넣은 글은 사용자 말이 아니다 — 원문 판독(wordText)은 붙여 넣은 구간을 뺀 '사용자가 쓴 부분'을
//    돌려준다(분류 입력·약속 상신 원문 대조가 모두 이 판독을 쓴다 · 판별=bridge/pasted-text.js 구조 표지). 원문 파일·지문은 그대로(대조 시점 계산).
//    메시지 전체가 붙여 넣은 글이면 대기열에 넣지 않는다. 원문 그대로가 필요한 곳(거부 사유 구분)만 opts.raw.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CL = require("./contract-lib.js");
const PT = require("./pasted-text.js");

const USER_WORDS_DIR = path.join(CL.BRIDGE_DIR, "user-words");
const TEXT_DIR = path.join(USER_WORDS_DIR, "text");
const CURSOR_DIR = path.join(USER_WORDS_DIR, "cursor");
const TURNS_DIR = path.join(USER_WORDS_DIR, "turns");
const READ_CHUNK = 4 * 1024 * 1024;       // 한 번에 읽는 조각
const READ_CAP = 64 * 1024 * 1024;        // 한 번의 수집에서 읽는 최대량(초과분은 건너뛰고 '빈 구간' 기록 — 훅 시간 예산·정직 표기)
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const safeKey = (s) => String(s || "").replace(/[^0-9a-zA-Z_-]/g, "");

// 장부·원문 파일은 작업공간 키로 찾는다(차례 기록의 작업공간 키로 바로 쓸 수 있게 — 수집 호출 시점의 작업공간과 무관)
function userWordsFileForKey(wsKey) { return path.join(USER_WORDS_DIR, safeKey(wsKey) + ".jsonl"); }
function textFileForKey(wsKey, id) { return path.join(TEXT_DIR, safeKey(wsKey) + "-" + safeKey(id) + ".txt"); }
function userWordsFileFor(ws) { return userWordsFileForKey(CL.wsKeyFor(ws)); }
function textFileFor(ws, id) { return textFileForKey(CL.wsKeyFor(ws), id); }
function cursorFileFor(sessionId) { return path.join(CURSOR_DIR, safeKey(sessionId) + ".json"); }
function turnsFileFor(sessionId) { return path.join(TURNS_DIR, safeKey(sessionId) + ".jsonl"); }

// ── 판별(순수) ── 질문 1개의 답에서 '사용자가 직접 쓴 글'만 고른다. 보기 이름(또는 복수 선택의 이름 조합)·"Other" 단독=없음.
// 복수 선택 조합은 쉼표로 쪼개지 않고 '보기 이름을 ", " 로 이어 붙여 답 전체를 정확히 만들 수 있는가'로 본다(검증 1회차 blocker⑤ —
// 보기 이름 안에 쉼표가 있어도 오판 없음). 순서·구분자 공백 차이는 관용(", " 또는 ",").
function isLabelCombination(a, labels) {
  const L = [...labels].sort((x, y) => y.length - x.length);
  const memo = new Map();
  const ok = (i) => {
    if (i === a.length) return true;
    if (memo.has(i)) return memo.get(i);
    let r = false;
    for (const lb of L) {
      if (!a.startsWith(lb, i)) continue;
      let j = i + lb.length;
      if (j === a.length) { r = true; break; }
      if (a[j] !== ",") continue;
      j++; while (j < a.length && a[j] === " ") j++;
      if (j < a.length && ok(j)) { r = true; break; }
    }
    memo.set(i, r);
    return r;
  };
  return ok(0);
}
function freeTextOf(question, answer) {
  const a = typeof answer === "string" ? answer.trim() : "";
  if (!a || a === "Other") return "";
  const labels = new Set(((question && Array.isArray(question.options)) ? question.options : []).map((o) => String((o && o.label) || "").trim()).filter(Boolean));
  if (labels.has(a)) return "";
  if (question && question.multiSelect && labels.size && isLabelCombination(a, labels)) return "";
  return a;
}
// 대화 기록 한 줄(파싱된 객체)에서 직접 입력 답들 — [{toolUseId, question, text, kind}] (kind: answer=직접 쓴 답 · note=보기에 붙인 메모)
function choiceAnswersOfLine(o) {
  const out = [];
  if (!o || o.type !== "user") return out;
  const r = o.toolUseResult;
  if (!r || typeof r !== "object" || !Array.isArray(r.questions) || !r.answers || typeof r.answers !== "object") return out;
  let toolUseId = "";
  try { const c = o.message && Array.isArray(o.message.content) ? o.message.content : []; for (const x of c) if (x && x.type === "tool_result" && typeof x.tool_use_id === "string") { toolUseId = x.tool_use_id; break; } } catch { toolUseId = ""; }
  const promptId = typeof o.promptId === "string" ? o.promptId : "";
  for (const q of r.questions) {
    const qt = String((q && q.question) || "");
    if (!qt) continue;
    const ft = freeTextOf(q, r.answers[qt]);
    if (ft) out.push({ toolUseId, promptId, question: qt, text: ft, kind: "answer" });
    const ann = r.annotations && typeof r.annotations === "object" ? r.annotations[qt] : null;
    const note = ann && typeof ann.notes === "string" ? ann.notes.trim() : "";
    if (note) out.push({ toolUseId, promptId, question: qt, text: note, kind: "note" });
  }
  return out;
}

// ── 차례 기록(세션별·덧붙이기 전용) ── 입력 제출 훅이 사람 발화 차례마다 1행: {anchor, repoKey, wsKey, ts, promptId, promptHash}.
// 스냅샷 기록 성공과 무관하게 남긴다(앵커·표식은 스냅샷 전에 확정되는 값). promptId=입력 제출 훅 입력의 prompt_id(없으면 "" — 그 차례의 선택지 답은 보류).
function promptHashOf(text) { return sha1(String(text || "").trim()); }
function recordTurn(sessionId, t) {
  const sid = safeKey(sessionId);
  if (!sid || !t || !t.anchor || !t.ts) return false;
  if (t.promptId && readTurns(sid).some((x) => x.promptId === t.promptId)) return true; // 같은 입력 열쇠의 재기록(훅 재실행)=처음 기록만 인정
  try { fs.mkdirSync(TURNS_DIR, { recursive: true }); fs.appendFileSync(turnsFileFor(sid), JSON.stringify({ anchor: String(t.anchor), repoKey: String(t.repoKey || ""), wsKey: String(t.wsKey || ""), ts: String(t.ts), promptId: String(t.promptId || ""), promptHash: String(t.promptHash || "") }) + "\n"); return true; } catch { return false; }
}
function readTurns(sessionId) { // 기록 순서 그대로(시각 정렬 없음 — 시계 역전 무관)
  try { return String(fs.readFileSync(turnsFileFor(sessionId), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.anchor); } catch { return []; }
}
// 차례 찾기 — 같은 promptId 를 가진 차례가 정확히 하나일 때만. 그 외(없음·중복·열쇠 없는 답)=null(보류).
function turnForPrompt(turns, promptId) {
  if (!promptId) return null;
  const cands = turns.filter((x) => x.promptId === promptId);
  return cands.length === 1 ? cands[0] : null;
}

// ── 장부(덧붙이기 전용) ──
function appendRowsKey(wsKey, rows) {
  if (!rows.length) return true;
  try { fs.mkdirSync(USER_WORDS_DIR, { recursive: true }); fs.appendFileSync(userWordsFileForKey(wsKey), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return true; } catch { return false; }
}
// 판독 — 같은 판독 1회로 부재(빈 장부)와 오류를 구분(readError=true 면 '알 수 없음').
function readUserWordsStateKey(wsKey) {
  let raw;
  try { raw = String(fs.readFileSync(userWordsFileForKey(wsKey), "utf8")); } catch (e) { return { rows: [], words: new Map(), status: new Map(), readError: !(e && e.code === "ENOENT") }; }
  const rows = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === "object");
  const words = new Map(), status = new Map();
  for (const r of rows) {
    if (r.type === "word" && typeof r.id === "string" && !words.has(r.id)) words.set(r.id, r);
    else if (r.type === "state" && typeof r.id === "string" && ["queued", "classified", "held"].includes(r.status)) status.set(r.id, r);
  }
  return { rows, words, status, readError: false };
}
function readUserWordsState(ws) { return readUserWordsStateKey(CL.wsKeyFor(ws)); }
// 기록 1건 — 저장소 표식·차례가 없으면 대기열이 아니라 '보류(출처 불명)'로(어느 저장소 대기열에도 안 들어감 · 검증 1회차 blocker②)
function recordWordKey(wsKey, rec, text) {
  const st = readUserWordsStateKey(wsKey);
  if (st.readError) return { ok: false, reason: "read-error" };
  if (st.words.has(rec.id)) return { ok: true, existed: true };
  if (typeof text === "string") { // 직접 입력 원문=별도 파일(7일 보존) — 장부엔 지문·길이만
    try { fs.mkdirSync(TEXT_DIR, { recursive: true }); } catch { /* atomicWrite 가 판정 */ }
    if (!CL.atomicWrite(textFileForKey(wsKey, rec.id), text)) return { ok: false, reason: "text-write" };
  }
  const unknown = !rec.repoKey || !rec.turnAnchor;
  const state = unknown ? { type: "state", id: rec.id, status: "held", reason: !rec.turnAnchor ? "turn-unknown" : "repo-unknown", ts: rec.ts } : { type: "state", id: rec.id, status: "queued", ts: rec.ts };
  const ok = appendRowsKey(wsKey, [Object.assign({ type: "word" }, rec), state]);
  return ok ? { ok: true, existed: false, held: unknown } : { ok: false, reason: "ledger-write" };
}
function recordWord(ws, rec, text) { return recordWordKey(CL.wsKeyFor(ws), rec, text); }
// 턴 원문(입력창 프롬프트) → 대기열. 원문은 constraint-turns 스냅샷이 정본(같은 7일) — 여기선 지문으로 결속만.
function enqueuePrompt(ws, o) {
  const a = o || {};
  if (!a.anchor || !a.sourceHash) return { ok: false, reason: "no-anchor" };
  // [묶음 5(G)] 메시지 전체가 붙여 넣은 글이면(사용자가 쓴 부분이 비면) 대기열에 넣지 않는다. 원문 판독 실패=종전대로 넣는다(뒤 판독이 다시 가른다).
  try { const t0 = fs.readFileSync(CL.constraintTurnFileFor(ws, String(a.anchor)), "utf8"); if (sha1(t0) === String(a.sourceHash) && !PT.userAuthoredText(t0).trim()) return { ok: true, skipped: "pasted-only" }; } catch { /* 종전 */ }
  const id = "p-" + sha1(CL.wsKeyFor(ws) + "|prompt|" + a.anchor).slice(0, 16);
  return recordWord(ws, { id, source: "prompt", turnAnchor: String(a.anchor), sourceHash: String(a.sourceHash), sessionId: String(a.sessionId || ""), provider: String(a.provider || ""), repoKey: String(a.repoKey || ""), ts: new Date().toISOString() });
}

// ── 수집(커서 이후만) ── 반환 {ok, captured, held, scanned, gap}
// 커서: 부재(ENOENT)=처음 보는 세션(현재 끝부터 — 소급 없음) / 판독 오류=수집 중단(커서 무접촉 — 검증 1회차 blocker③) /
// 손상(형식 이상)=상한만큼 뒤로 물러나 다시 읽음(이미 기록된 답은 id 로 중복 없음).
function captureChoiceAnswers(ws, o) {
  const a = o || {};
  const sid = String(a.sessionId || "");
  const tp = String(a.transcriptPath || "");
  const out = { ok: false, captured: 0, held: 0, scanned: 0, gap: 0 };
  if (!sid || !tp) { out.reason = "no-session"; return out; }
  const cap9 = Number.isFinite(a.cap) && a.cap > 0 ? a.cap : READ_CAP, chunk9 = Number.isFinite(a.chunk) && a.chunk >= 16 ? a.chunk : READ_CHUNK; // 시험용 축소만 허용(기본=상수)
  let fd = null;
  try {
    let size;
    try { fd = fs.openSync(tp, "r"); size = fs.fstatSync(fd).size; } catch { out.reason = "transcript-unreadable"; return out; }
    const cf = cursorFileFor(sid);
    let raw = null, cur = null, missing = false;
    try { raw = fs.readFileSync(cf, "utf8"); } catch (e) { if (e && e.code === "ENOENT") missing = true; else { out.reason = "cursor-unreadable"; return out; } }
    if (!missing) { try { cur = JSON.parse(raw); } catch { cur = null; } }
    let offset;
    if (missing) offset = a.fromStart === true ? 0 : size; // 처음 보는 세션=현재 끝부터(소급 없음 · 시험만 fromStart)
    else if (!cur || typeof cur !== "object" || !Number.isFinite(cur.offset) || typeof cur.path !== "string") offset = Math.max(0, size - cap9); // 손상=상한만큼 다시 읽음
    else if (cur.path !== tp) offset = 0; // 같은 세션의 다른 대화 기록 파일=처음부터(아래 상한이 판독량을 묶음)
    else offset = cur.offset > size ? 0 : cur.offset; // 파일이 줄었으면(교체) 처음부터
    if (size - offset > cap9) { out.gap = size - offset - cap9; offset = size - cap9; } // 너무 많이 쌓였으면 앞부분은 건너뛰고 기록(정직 표기)
    // 줄 경계는 '바이트'로 자른다(줄바꿈 0x0A 는 UTF-8 다바이트 글자 안에 나오지 않음) — 조각 경계에서 한글이 쪼개져 깨지는 것 방지.
    let pos = offset, carryBuf = Buffer.alloc(0);
    const found = [];
    while (pos < size) {
      const len = Math.min(chunk9, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      pos += len;
      const data = carryBuf.length ? Buffer.concat([carryBuf, buf]) : buf;
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl < 0) { carryBuf = data; continue; }
      carryBuf = data.subarray(lastNl + 1); // 끝이 줄바꿈이 아니면 다음 조각과 이어 붙임(쓰는 중인 마지막 줄 포함)
      for (const l of data.subarray(0, lastNl).toString("utf8").split("\n")) {
        out.scanned++;
        if (l.indexOf('"toolUseResult"') < 0 || l.indexOf('"answers"') < 0) continue; // 싼 선별 — 선택지 결과 줄만 파싱
        let obj; try { obj = JSON.parse(l); } catch { continue; }
        for (const x of choiceAnswersOfLine(obj)) found.push(Object.assign(x, { ts: String(obj.timestamp || "") }));
      }
    }
    const endOffset = size - carryBuf.length; // 미완성 마지막 줄은 다음 수집에서 다시 읽음
    const turns = found.length ? readTurns(sid) : [];
    for (const x of found) {
      if (!PT.userAuthoredText(x.text).trim()) continue; // [묶음 5(G)] 직접 입력 답 전체가 붙여 넣은 글=사용자 말 아님(기록 안 함)
      const turn = turnForPrompt(turns, x.promptId); // 차례 열쇠 기준(수집 시점·시각·원문 지문 아님)
      const wsKey = turn && turn.wsKey ? turn.wsKey : CL.wsKeyFor(ws);
      const id = "c-" + sha1(wsKey + "|" + sid + "|" + x.toolUseId + "|" + x.question + "|" + x.kind).slice(0, 16);
      const r = recordWordKey(wsKey, { id, source: "choice", kind: x.kind, turnAnchor: turn ? String(turn.anchor) : "", promptId: x.promptId, sessionId: sid, provider: String(a.provider || "claude"), repoKey: turn ? String(turn.repoKey || "") : "", textHash: sha1(x.text), len: x.text.length, questionFp: sha1(x.question).slice(0, 16), answeredAt: x.ts, ts: new Date().toISOString() }, x.text);
      if (r.ok && !r.existed) { if (r.held) out.held++; else out.captured++; }
      if (!r.ok) { out.reason = r.reason; return out; } // 기록 실패=커서 전진 금지(다음 수집이 다시 읽음 — 분실 없음)
    }
    try { fs.mkdirSync(CURSOR_DIR, { recursive: true }); } catch { /* atomicWrite 가 판정 */ }
    CL.atomicWrite(cf, JSON.stringify({ path: tp, offset: endOffset, ts: new Date().toISOString(), ...(out.gap ? { lastGap: out.gap } : {}) }));
    out.ok = true;
    return out;
  } catch { out.reason = "exception"; return out; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 무해 */ } } }
}
// 이 세션 수집(종료 훅·약속 상신 명령용). transcriptPath 미지정=입력 제출 훅이 앵커에 남긴 경로.
function captureForActiveTurn(ws, sessionId, transcriptPath) {
  const sid = String(sessionId || "");
  if (!sid) return { ok: false, reason: "no-session" };
  let tp = String(transcriptPath || "");
  if (!tp) { try { const a = JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, safeKey(sid) + ".json"), "utf8")); if (a && a.claudeSession === sid) tp = String(a.transcriptPath || ""); } catch { tp = ""; } }
  return captureChoiceAnswers(ws, { sessionId: sid, transcriptPath: tp, provider: "claude" });
}
// ── 원문 판독 ── 단어 1건의 원문(만료·변조=null). prompt=턴 스냅샷(지문 대조) · choice=직접 입력 파일(지문 대조)
// 보존 기간(7일)은 읽는 시점에 기록 행 시각으로 직접 판정한다 — 청소는 하루 1회라 기간이 지난 파일이 다음 청소까지 남을 수 있음(검증 5회차 blocker:
// 청소 전 남은 만료 원문이 이전 말 인용으로 접수됨). 시각 판독 불가=만료(fail-closed). now=시험 주입점.
// [묶음 5(G)] 돌려주는 글=사용자가 쓴 부분(붙여 넣은 구간 제외 — pasted-text.userAuthoredText). opts.raw=원문 그대로(거부 사유 구분용).
function wordExpired(w, now) {
  const t = Date.parse(String((w && w.ts) || ""));
  return !Number.isFinite(t) || (Number.isFinite(now) ? now : Date.now()) - t > CL.ATTEMPTS_TTL_MS;
}
function wordText(ws, w, now, opts) {
  if (!w) return null;
  if (wordExpired(w, now)) return null;
  const raw = !!(opts && opts.raw);
  const out = (t) => (raw ? t : PT.userAuthoredText(t));
  try {
    if (w.source === "prompt") { const t = fs.readFileSync(CL.constraintTurnFileFor(ws, w.turnAnchor), "utf8"); return sha1(t) === w.sourceHash ? out(t) : null; }
    if (w.source === "choice") { const t = fs.readFileSync(textFileFor(ws, w.id), "utf8"); return sha1(t) === w.textHash ? out(t) : null; }
  } catch { return null; }
  return null;
}
// 같은 차례의 직접 입력 원문들(약속 상신 원문 대조 확장 — §3-1). 저장소 표식이 주어지면 같은 표식만(차례·저장소 이중 결속).
function choiceTextsForTurn(ws, turnAnchor, repoKey, opts) {
  if (!turnAnchor) return [];
  const st = readUserWordsState(ws);
  const out = [];
  for (const w of st.words.values()) {
    if (w.source !== "choice" || w.turnAnchor !== turnAnchor) continue;
    if (repoKey && w.repoKey !== repoKey) continue;
    const t = wordText(ws, w, undefined, opts); if (t) out.push(t);
  }
  return out;
}
// [사용자 결정 2026-10-04 '기회만 열어 두기'] 약속 상신 원문 대조의 마지막 단계 — 같은 작업공간·같은 저장소(표식 정확 일치)의 최근 사용자 말
// (입력창 원문·직접 입력, 상태 무관 · 원문 보존 7일 안 · 지문 대조로 읽은 원문만)에서 연속 구절을 찾는다. 새 지시문 없음 — 구현 담당이 올리려 할 때
// 이전 메시지라는 이유로 거절하지 않을 뿐. 반환 {source, turnAnchor} | null.
function findQuoteInRecentWords(ws, repoKey, quote, now, opts) {
  if (!repoKey || !quote) return null;
  const st = readUserWordsState(ws);
  if (st.readError) return null;
  const ws9 = [...st.words.values()].filter((w) => w.repoKey === repoKey).sort((x, y) => String(y.ts).localeCompare(String(x.ts))); // 최근 것부터
  for (const w of ws9) { const t = wordText(ws, w, now, opts); if (t && t.includes(quote)) return { source: w.source, turnAnchor: String(w.turnAnchor || "") }; } // 보존 기간 밖=wordText 가 null
  return null;
}
// 미분류 대기열 — 이 저장소(repoKey 정확 일치)의 queued 항목(오래된 것부터). 표식 없는 행은 어떤 저장소에도 안 보임(검증 1회차 blocker②).
// 판독 오류=null(알 수 없음 — 호출자가 빈 대기열로 위장하지 않게)
function queuedWords(ws, repoKey) {
  const st = readUserWordsState(ws);
  if (st.readError) return null;
  const out = [];
  for (const w of st.words.values()) {
    if (!w.repoKey || w.repoKey !== repoKey) continue;
    const s = st.status.get(w.id);
    if (s && s.status !== "queued") continue;
    out.push(Object.assign({}, w, { retries: s && Number.isFinite(s.retries) ? s.retries : 0 }));
  }
  out.sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  return out;
}
function setWordStatus(ws, ids, status, extra) {
  if (!["queued", "classified", "held"].includes(status)) return false;
  const ts = new Date().toISOString();
  return appendRowsKey(CL.wsKeyFor(ws), (ids || []).map((id) => Object.assign({ type: "state", id, status, ts }, extra || {})));
}
// 보류 목록 — 이 저장소 것(정확 일치) + unknown=true 면 출처 불명(표식 없음) 보류도 함께(화면이 '조용한 누락' 없이 보여 줄 재료)
function heldWords(ws, repoKey, opts) {
  const st = readUserWordsState(ws);
  if (st.readError) return null;
  const withUnknown = !!(opts && opts.unknown);
  const out = [];
  for (const w of st.words.values()) {
    const mine = !!w.repoKey && w.repoKey === repoKey;
    if (!mine && !(withUnknown && !w.repoKey)) continue;
    const s = st.status.get(w.id);
    if (s && s.status === "held") out.push(Object.assign({}, w, { heldReason: String(s.reason || "") }));
  }
  return out;
}

module.exports = { USER_WORDS_DIR, TEXT_DIR, CURSOR_DIR, TURNS_DIR, READ_CAP, userWordsFileFor, userWordsFileForKey, textFileFor, cursorFileFor, turnsFileFor, freeTextOf, isLabelCombination, choiceAnswersOfLine, promptHashOf, recordTurn, readTurns, turnForPrompt, findQuoteInRecentWords, readUserWordsState, recordWord, enqueuePrompt, captureChoiceAnswers, captureForActiveTurn, wordExpired, wordText, choiceTextsForTurn, queuedWords, setWordStatus, heldWords };
