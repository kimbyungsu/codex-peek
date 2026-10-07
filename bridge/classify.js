"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-나-2 §3-3·§3-4 — 2026-10-05] 사용자 말 분류 실행(독립).
 * 미분류 대기열(user-words)의 사용자 말을 구현 턴과 같은 회사의 독립 실행(selector-runner 페이지 1회 — 도구·MCP 전면 차단)에 넘겨
 * '앞으로도 계속 지킬 기준'을 사용자가 직접 말한 문장만 골라 수칙서 칸(지원 환경·항상 막을 것·범위 밖)을 붙인다
 * → 기존 후보 장부의 사용자 약속 후보(kind user-constraint · origin classifier · axis) — 도장 경로 그대로.
 * [RULE-SUPPLY-CORRECTION 묶음 1 · §2 D] 옛 '사용자 규칙 칸 자리'·'결정 기록 자리'는 없앴다 — 규칙 칸은 사용자가 직접 쓰는 칸이고(체크박스 대상),
 * 결정 장부의 출처는 구현 담당 판단 하나뿐이다. 그 자리로 답이 오면 답 전체를 거부한다(자리 밖). 옛 자리 장부(classify/<ws>.seats.jsonl)는
 * 지우지도 바꾸지도 않고(덧붙이기 전용·ab-5) 판독만 한다 — 사용자가 안 올린 문장을 '이미 있는 것'으로 싣는 데에만 쓴다(새 행을 쓰는 곳 없음).
 * 원칙: 판단은 LLM(문구 감지·키워드 목록 없음) · 인용은 원문 연속 구절만(작문 차단 — 원문 대조) · 판정을 만드는 검증 입력에 넣지 않음(R2) ·
 *       승인 전 원문은 그 말이 나온 구현 턴과 같은 회사로만(R3 — Claude 차례 말=Claude 1회 호출 · Codex 차례 말=Codex 격리 실행) ·
 *       민감 형태는 입력에서 생략 표시로 바꿈(ab-7) · 실패=영수증+경보·대기열 보존(재시도 상한 뒤 '분류하지 못한 말'로 보류 — 조용한 누락 없음) ·
 *       실행 잠금 1개(ab-6 유계) · 모든 기록 덧붙이기 전용(ab-5) · 작업공간 키·저장소 표식 결속(ab-1).
 * 이 모듈은 도장(승인)을 찍지 않는다 — 수칙서 후보의 승인·안 올림은 기존 수칙 카드(후보 장부) 몫이다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require("./contract-lib.js");
const UW = require("./user-words.js");

const CLASSIFY_DIR = path.join(CL.BRIDGE_DIR, "classify");
const CLASSIFY_BATCH_WORDS = 20;       // 한 번에 넘기는 말 수 상한(나머지는 다음 계기 — 대기열 보존)
const CLASSIFY_BATCH_CHARS = 24000;    // 한 번에 넘기는 글자 수 상한(첫 말은 상한과 무관하게 1건은 싣는다)
const CLASSIFY_WORD_SHOW = 4000;       // 말 1건에서 보여 주는 앞부분 상한(인용 대조는 원문 전체로)
const CLASSIFY_MAX_PER_RUN = 5;        // 실행 1회당 후보 상한(소수 — 초과=답 전체 거부)
const CLASSIFY_RETRY_MAX = 3;          // 같은 말 분류 실패 반복 상한 → 보류(classify-failed)
const CLASSIFY_LIST_MAX = 60;          // '이미 있는 것' 목록 항목 상한(종류별)
const CLASSIFY_LOCK_STALE_MS = 15 * 60 * 1000;
const RULEBOOK_SEATS = ["supportedEnv", "alwaysBlocker", "outOfScope"];
const SEATS = [...RULEBOOK_SEATS]; // [RULE-SUPPLY-CORRECTION 묶음 1] 수칙서 칸만 — 옛 rule·decision 자리는 자리 밖(답 전체 거부)
const SEAT_STATUSES = ["proposed", "approved", "declined"];
const REDACTED = "[생략]";
const sha1 = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const qNormOf = (q) => String(q).normalize("NFC").replace(/\s+/g, " ").trim();
function classifyFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".jsonl"); }
function seatsFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".seats.jsonl"); }
function classifyLockFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".lock"); }
// 팔=그 말이 나온 구현 턴의 회사(R3) — 설정·교차 없음
function armForProvider(provider) { return provider === "codex" ? "codex" : "self"; }
function providerOf(w) { return w && w.provider === "codex" ? "codex" : "claude"; }
// 구현 담당 규칙 목록(사용자가 직접 쓰는 규칙 칸) — 회사별 칸(Claude=claude · Codex=codexImplementer). 분류 입력의 '이미 있는 것'으로만 읽는다(쓰지 않음).
function rulesFieldFor(provider) { return provider === "codex" ? "codexImplementer" : "claude"; }
function normRuleList(v) { return (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean); }

// ── 민감 형태 생략(ab-7) — 분류 입력에만 적용(원문 파일·인용 대조는 원문 그대로). 범주 규칙(contract-lib 자동 제목 규칙과 같은 범주):
// 드라이브·네트워크·절대 경로 / 이메일 / 알려진 비밀값 머리 / 32자 이상 연속 토큰 덩어리 / 제어 문자(줄바꿈·탭 제외).
const B9 = "(^|[\\s\"'`“”‘’()\\[\\]{}<>=:,;])";
const REDACT_RULES = [
  { re: /[A-Za-z]:[\\/][^\s"'`<>|]*/g, keep: false },
  { re: /\\\\[^\s"'`<>|]*/g, keep: false },
  { re: new RegExp(B9 + "//[^\\s/]+/[^\\s]*", "g"), keep: true },
  { re: new RegExp(B9 + "/[^\\s/]+/[^\\s]*", "g"), keep: true },
  { re: new RegExp(B9 + "~[^\\s]*/[^\\s]*", "g"), keep: true },
  { re: /[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, keep: false },
  { re: /\beyJ[A-Za-z0-9_-]{8,}/g, keep: false },
  { re: /\bAKIA[0-9A-Z]{8,}/g, keep: false },
  { re: /\bghp_[A-Za-z0-9]{8,}/g, keep: false },
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, keep: false },
  { re: /\bxox[a-z]?-[A-Za-z0-9-]{8,}/g, keep: false },
  { re: /[A-Za-z0-9+/=_-]{32,}/g, keep: false },
];
function redactSensitiveForms(text) {
  let s = String(text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const r of REDACT_RULES) s = s.replace(r.re, (m, g1) => (r.keep ? String(g1 || "") : "") + REDACTED);
  return s;
}

// ── 장부(실행 행) ──
function readClassifyRows(ws) {
  try { return String(fs.readFileSync(classifyFileFor(ws), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.schema === "classify-v1" && r.wsKey === CL.wsKeyFor(ws)); } catch { return []; }
}
function appendClassifyRow(ws, row) {
  const rec = Object.assign({ schema: "classify-v1", wsKey: CL.wsKeyFor(ws), ts: new Date().toISOString() }, row);
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); fs.appendFileSync(classifyFileFor(ws), CL.appendLeadFor(classifyFileFor(ws)) + JSON.stringify(rec) + "\n"); return true; } catch { return false; } // 꼬리 보호(끊긴 마지막 줄과 합쳐지지 않게)
}
// ── 옛 자리 장부(없앤 '규칙 칸·결정 기록' 자리 — 판독 전용) — 같은 id 의 마지막 유효 행이 이김. 판독 오류=readError(빈 장부로 위장 금지).
function readSeatsState(ws) {
  let raw;
  try { raw = String(fs.readFileSync(seatsFileFor(ws), "utf8")); } catch (e) { return { rows: [], latest: new Map(), readError: !(e && e.code === "ENOENT") }; }
  const wk = CL.wsKeyFor(ws);
  const rows = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.schema === "user-seat-v1" && r.wsKey === wk && typeof r.candidateId === "string" && /^[0-9a-f]{16}$/.test(r.candidateId) && SEAT_STATUSES.includes(r.status));
  const meta = new Map(), latest = new Map();
  for (const r of rows) { if (!meta.has(r.candidateId) && r.status === "proposed" && r.quote) meta.set(r.candidateId, r); latest.set(r.candidateId, r); }
  for (const [id, r] of latest) latest.set(id, Object.assign({}, meta.get(id) || {}, r)); // 상태 행이 문안을 안 실어도 첫 행에서 회수
  return { rows, latest, readError: false };
}
function userConstraintIdFor(ws, repoKey, quote) { return CL.envelopeCandidateId("user-constraint", CL.wsKeyFor(ws) + "|" + repoKey + "|" + sha1(qNormOf(quote))); } // constraintAdd 와 같은 산식(같은 말=같은 후보)

// ── 입력 집계 ── 반환 {ok, empty?, wsKey, repoKey, gen, virtual, provider, arm, items[], unavailable[], existing{...}, inputFp} | {ok:false, reason}
function classifyInput(ws, repo, opts) {
  const o = opts || {};
  const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!c) return { ok: false, reason: "contract-unreadable" };
  const wsKey = CL.wsKeyFor(ws), repoKey = CL.repoKeyOf(repo);
  let g = null; try { g = CL.envelopeGenFor(ws, repo, c); } catch { g = null; }
  if (!g || !g.gen) return { ok: false, reason: "envelope-inactive", detail: g ? String(g.st || "") : "" }; // 수칙서 승인 전·손상=수칙서 자리 후보를 받을 수 없음 — 대기열 보존(소모 안 함)
  const q = UW.queuedWords(ws, repoKey);
  if (q === null) return { ok: false, reason: "queue-unreadable" };
  const base = { ok: true, wsKey, repoKey, gen: g.gen, virtual: !!g.virtual };
  if (!q.length) return Object.assign(base, { empty: true, items: [], unavailable: [], pastedOnly: [] });
  const provider = providerOf(q[0]); // 가장 오래된 말의 회사부터(한 실행=한 회사 — R3)
  const items = [], unavailable = [], pastedOnly = [];
  let chars = 0;
  for (const w of q) {
    if (providerOf(w) !== provider) continue;
    if (items.length >= CLASSIFY_BATCH_WORDS) break;
    const t = UW.wordText(ws, w);
    if (t === null) { unavailable.push(w.id); continue; } // 보존 기간 밖·변조·소실=분류 불가(보류로 표면)
    if (!t.trim()) { pastedOnly.push(w.id); continue; } // [RULE-SUPPLY-CORRECTION 묶음 5(G)] 사용자가 쓴 부분이 빔(붙여 넣은 글뿐)=분류 담당에게 보내지 않음
    const red = redactSensitiveForms(t);
    const shown = red.length > CLASSIFY_WORD_SHOW ? red.slice(0, CLASSIFY_WORD_SHOW) + "\n" + REDACTED + "(" + (red.length - CLASSIFY_WORD_SHOW) + ")" : red;
    if (items.length && chars + shown.length > CLASSIFY_BATCH_CHARS) break;
    chars += shown.length;
    items.push({ ref: "u" + (items.length + 1), id: w.id, source: w.source, text: t, shown, retries: Number(w.retries) || 0, turnAnchor: String(w.turnAnchor || ""), sessionId: String(w.sessionId || ""), sourceHash: String(w.sourceHash || ""), kind: String(w.kind || "") });
  }
  // '이미 있는 것' — 같은 뜻 재상신 방지 재료(판단은 LLM — 문구 대조 금지 · §3-4b)
  const cap = (arr) => arr.filter(Boolean).slice(0, CLASSIFY_LIST_MAX).map((x) => oneLine(redactSensitiveForms(x), 200));
  const rulebook = [];
  try { const ev = CL.readVerifyEnvelope(repo); if (ev && ev.st === "ok") for (const ax of RULEBOOK_SEATS) for (const x of (ev.data[ax] || [])) rulebook.push(ax + ": " + x); } catch { /* 0세대·판독 실패=빈 목록 */ }
  try { const ah = typeof c.archiveHash === "string" && c.archiveHash ? c.archiveHash : ""; if (ah) { const ar = CL.readVerifyEnvelopeArchive(repo); if (ar.st === "ok" && ar.sha1 === ah) for (const x of ar.data.alwaysBlocker) rulebook.push("alwaysBlocker(관련될 때): " + x); } } catch { /* 서고 없음 */ }
  const rules = normRuleList(c[rulesFieldFor(provider)]);
  // [검증 1회차 f-7ccbb34a · R3] 확인 대기·안 올림 목록의 문장도 '승인 전 사용자 원문'이다 — 이번 실행 회사의 말만 싣는다(회사 표기 없는 옛 행=제외).
  // 승인된 수칙서 문안·결정 기록·그 회사 규칙 칸은 승인 뒤 문장이라 그대로. 다른 회사 거절분의 같은 말은 커밋 단계의 후보 id 거절 기억이 여전히 막는다.
  const sameCo = (r) => String((r && r.provider) || "") === provider;
  const pending = [], declined = [];
  try {
    const cst = CL.readEnvelopeCandidatesState(ws);
    if (!cst.readError) {
      const seen = new Set();
      const firstOf = new Map(); for (const r of cst.rows) if (r && r.candidateId && !firstOf.has(r.candidateId) && r.kind === "user-constraint") firstOf.set(r.candidateId, r); // 상태 행은 회사 표기가 없을 수 있어 첫 행 기준
      for (const r of cst.rows) {
        if (!r || r.kind !== "user-constraint" || r.repoKey !== repoKey || seen.has(r.candidateId)) continue;
        if (!sameCo(firstOf.get(r.candidateId))) continue;
        seen.add(r.candidateId);
        if (CL.userDeclinedCandidate(cst.rows, r.candidateId)) declined.push(r.title);
        else { const cur = cst.latest.get(r.candidateId + "@" + g.gen); if (cur && cur.status === "proposed") pending.push(r.title); }
      }
    }
  } catch { /* 없음 */ }
  // 옛 자리 장부: 사용자가 안 올린 문장만 '안 올림'으로 싣는다(같은 말을 수칙서 후보로 다시 올리지 않게) · 대기 중이던 옛 자리 제안은 승인 길이 없어 싣지 않음(D-d)
  try { const ss = readSeatsState(ws); if (!ss.readError) for (const r of ss.latest.values()) { if (r.repoKey !== repoKey || !sameCo(r)) continue; if (r.status === "declined") declined.push(r.quote); } } catch { /* 없음 */ }
  const existing = { rulebook: cap(rulebook), rules: cap(rules), pending: cap(pending), declined: cap(declined) };
  const inputFp = sha1(JSON.stringify({ ids: items.map((x) => x.id), existing }));
  return Object.assign(base, { provider, arm: armForProvider(provider), items, unavailable, pastedOnly, existing, inputFp });
}

// ── 프롬프트 — 범주 정의만(구체 예시·키워드 없음 — 경직성 금지) ──
function buildClassifyPrompt(input, lang) {
  const en = lang === "en";
  const L = [];
  L.push(en ? "You are an independent classifier of a user's words. Below are things the user said to an AI implementer in one project. Pick ONLY sentences in which the user states a standard for judging this project that should keep applying from now on, and decide which rulebook seat each belongs to. Most messages are one-off requests, questions, confirmations or reactions and belong nowhere — no candidate is better than a weak one. At most " + CLASSIFY_MAX_PER_RUN + "."
    : "당신은 독립 '사용자 말 분류' 담당입니다. 아래는 한 프로젝트에서 사용자가 구현 담당(AI)에게 한 말입니다. 그중 '이 프로젝트를 판정할 때 앞으로도 계속 지켜야 할 기준'을 사용자가 직접 말한 문장만 골라 수칙서의 어느 칸에 둘지 정합니다. 대부분의 말은 이번 작업 요청·질문·확인·감상이라 어디에도 해당하지 않습니다 — 약한 후보보다 무후보가 낫습니다. 최대 " + CLASSIFY_MAX_PER_RUN + "건.");
  L.push(en ? "Seats: supportedEnv (rulebook — the environment/target/range this project is judged against) · alwaysBlocker (rulebook — something that is always a defect when violated) · outOfScope (rulebook — something this stage/project does not cover, so it must not be flagged as a defect). How the implementer should work or talk is not a seat — the user writes that into the rule boxes directly."
    : "자리: supportedEnv(수칙서 — 이 프로젝트의 판정 기준이 되는 실행 환경·대상·범위) · alwaysBlocker(수칙서 — 어기면 언제나 결함인 기준) · outOfScope(수칙서 — 지금 단계나 이 프로젝트에서 다루지 않아 결함으로 잡지 말아야 할 것). 구현 담당이 일하거나 말하는 방식은 자리가 아닙니다 — 그런 말은 사용자가 규칙 칸에 직접 씁니다.");
  L.push(en ? "Rules: quote = an UNCHANGED contiguous passage of that message (12–200 chars, one line) — no summary, translation or stitching; a single changed character is rejected. Never quote a passage containing " + REDACTED + ". why = one line (8–120 chars) on why it should keep applying; no secrets/personal data. Do not propose anything that means the same as an item in the 'already present' lists (including ones the user chose not to adopt). One-off instructions for the current task, questions and feelings are not candidates."
    : "규칙: quote=그 말 원문에서 바꾸지 않은 연속 구절(12~200자·한 줄) — 요약·번역·이어 붙이기 금지, 한 글자라도 다르면 거부됩니다. " + REDACTED + " 표시가 들어간 구절은 쓰지 마세요. why=왜 계속 지킬 기준인지 한 줄(8~120자)·비밀값·개인정보 금지. 아래 '이미 있는 것' 목록과 같은 뜻이면 올리지 마세요(사용자가 안 올린 것 포함). 이번 작업에만 해당하는 지시·질문·감정 표현은 후보가 아닙니다.");
  L.push(en ? "Output exactly one JSON object and nothing else: {\"candidates\":[{\"ref\":\"u1\",\"quote\":\"…\",\"seat\":\"supportedEnv|alwaysBlocker|outOfScope\",\"why\":\"…\",\"recommend\":\"always|related\"}]} — none: {\"candidates\":[]}."
    : "출력은 JSON 객체 하나뿐(다른 글 금지): {\"candidates\":[{\"ref\":\"u1\",\"quote\":\"…\",\"seat\":\"supportedEnv|alwaysBlocker|outOfScope\",\"why\":\"…\",\"recommend\":\"항상|관련\"}]} — 없음은 {\"candidates\":[]}.");
  L.push("");
  const ex = input.existing;
  const dump = (label, arr) => { L.push(label + (arr.length ? "" : (en ? " (none)" : " (없음)"))); for (const x of arr) L.push("- " + x); };
  dump(en ? "[Already present — rulebook]" : "[이미 있는 것 — 수칙서]", ex.rulebook);
  dump(en ? "[Already present — rule box the user writes]" : "[이미 있는 것 — 사용자가 직접 쓰는 규칙 칸]", ex.rules);
  dump(en ? "[Already present — waiting for the user]" : "[이미 있는 것 — 사용자 확인 대기]", ex.pending);
  dump(en ? "[Already present — the user chose not to adopt]" : "[이미 있는 것 — 사용자가 안 올림]", ex.declined);
  L.push("");
  L.push(en ? "[User's words — oldest first]" : "[사용자 말 — 오래된 것부터]");
  for (const it of input.items) {
    const src = it.source === "choice" ? (en ? "typed into a choice prompt" : "선택지에 직접 입력") : (en ? "chat input" : "입력창");
    L.push("<<" + it.ref + " · " + src + ">>");
    L.push(it.shown);
    L.push("<</" + it.ref + ">>");
  }
  return L.join("\n");
}

// ── 파서 — 손상(JSON 아님·배열 아님·상한 초과·자리 밖·필수 형식 위반)=전량 거부(fail-closed). 의미 거부(원문 불일치·민감·형식)=항목 탈락+사유.
function parseClassifyOutput(raw, input) {
  let text = String(raw || "").trim();
  { const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(text); if (m) text = m[1].trim(); } // 코드 울타리 1겹(정리 담당과 같은 관용)
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, reason: "no-json" };
  let o = null; try { o = JSON.parse(text); } catch { return { ok: false, reason: "bad-json" }; }
  if (!o || typeof o !== "object" || !Array.isArray(o.candidates)) return { ok: false, reason: "no-candidates-array" };
  if (o.candidates.length > CLASSIFY_MAX_PER_RUN) return { ok: false, reason: "too-many" };
  const byRef = new Map(input.items.map((it) => [it.ref, it]));
  const vocab = [CL.FINDINGS_MARKERS.ko, CL.FINDINGS_MARKERS.en, CL.FINDINGS_MARKERS_V2.ko, CL.FINDINGS_MARKERS_V2.en].flatMap((m) => [m.start, m.end]);
  const items = [], dropped = [];
  const seen = new Set();
  for (const p of o.candidates) {
    if (!p || typeof p !== "object") return { ok: false, reason: "row-not-object" };
    const seat = String(p.seat || "");
    if (!SEATS.includes(seat)) return { ok: false, reason: "bad-seat" };
    if (typeof p.quote !== "string" || typeof p.why !== "string" || typeof p.ref !== "string") return { ok: false, reason: "bad-row" };
    // [검증 1회차 f-25b85198] why 형식(한 줄·8~120자) 위반=답 손상 — 전량 거부(항목 탈락으로 처리하면 말이 재시도 없이 분류 완료로 소모된다)
    if (/[\r\n\u2028\u2029]/.test(p.why) || p.why.trim().length < 8 || p.why.trim().length > CL.CONSTRAINT_WHY_MAX) return { ok: false, reason: "bad-why" };
    const drop = (reason) => { dropped.push({ ref: p.ref, seat, reason }); };
    const it = byRef.get(p.ref);
    if (!it) { drop("unknown-ref"); continue; }
    const q = p.quote;
    if (q.trim().length < CL.CONSTRAINT_QUOTE_MIN) { drop("too-short"); continue; }
    if (q.length > CL.CONSTRAINT_QUOTE_MAX) { drop("too-long"); continue; }
    if (/[\r\n\u2028\u2029]/.test(q)) { drop("multiline"); continue; }
    if (q.includes(REDACTED)) { drop("redacted-span"); continue; }
    if (!it.text.includes(q)) { drop("not-in-words"); continue; } // 원문 대조(작문 차단) — 보여 준 부분이 아니라 사용자가 쓴 부분 전체(붙여 넣은 구간 제외 — 묶음 5(G))
    if (vocab.some((v) => q.includes(v))) { drop("protocol-vocab"); continue; }
    const qs = CL.safeBacklogAutoTitle(q); if (!qs.ok) { drop("sensitive-" + qs.reasonKey); continue; }
    const why = p.why.trim();
    const ws9 = CL.safeBacklogAutoTitle(why); if (!ws9.ok) { drop("why-sensitive-" + ws9.reasonKey); continue; }
    const dk = seat + "|" + qNormOf(q); if (seen.has(dk)) { drop("duplicate-in-run"); continue; } seen.add(dk);
    const rec = (p.recommend === "always" || p.recommend === "항상") ? "항상" : (p.recommend === "related" || p.recommend === "관련") ? "관련" : "";
    items.push({ ref: p.ref, wordId: it.id, seat, quote: q, why, ...(rec ? { recommend: rec } : {}) });
  }
  return { ok: true, items, dropped };
}

// ── 커밋 — 후보(후보 장부) 먼저, 그다음 말 상태(classified). 중간 중단=말이 queued 로 남아 다음 실행이 다시
// 분류하고 후보는 같은 id 라 중복 없이 건너뛴다(멱등). 반환 {ok, envIds, dropped, reason?}
function commitClassify(ws, input, parsed, meta) {
  const m = meta || {};
  const runId = String(m.runId || "");
  const byWord = new Map(input.items.map((it) => [it.id, it]));
  const cst = CL.readEnvelopeCandidatesState(ws);
  if (cst.readError) return { ok: false, reason: "candidates-unreadable" };
  const env = [], dropped = parsed.dropped.slice();
  const ts = new Date().toISOString();
  for (const it of parsed.items) {
    const w = byWord.get(it.wordId);
    if (!RULEBOOK_SEATS.includes(it.seat)) { dropped.push({ ref: it.ref, seat: it.seat, reason: "bad-seat" }); continue; } // 판독기가 이미 막지만 직접 호출 방어
    const cid = userConstraintIdFor(ws, input.repoKey, it.quote);
    if (CL.userDeclinedCandidate(cst.rows, cid)) { dropped.push({ ref: it.ref, seat: it.seat, reason: "user-declined" }); continue; } // 사용자 거절=세대 무관 기억(2-가)
    const cur = cst.latest.get(cid + "@" + input.gen);
    if (cur) { dropped.push({ ref: it.ref, seat: it.seat, reason: "duplicate" }); continue; } // 이 세대에 이미 있음(대기·채택·정리)
    env.push({ candidateId: cid, envelopeHash: input.gen, ...(input.virtual ? { virtualGen: true } : {}), status: "proposed", kind: "user-constraint", origin: "classifier", axis: it.seat, repoKey: input.repoKey,
      title: it.quote, why: it.why, ...(it.recommend ? { recommend: it.recommend } : {}), provider: input.provider, sessionId: w.sessionId, turnAnchor: w.turnAnchor, sourceHash: w.sourceHash,
      quoteSource: w.source, wordId: w.id, ...(runId ? { runId } : {}), ts });
  }
  if (env.length && !CL.appendEnvelopeCandidates(ws, env)) return { ok: false, reason: "candidates-write" };
  if (!UW.setWordStatus(ws, input.items.map((x) => x.id), "classified", runId ? { runId } : {})) return { ok: false, reason: "words-write" };
  return { ok: true, envIds: env.map((r) => r.candidateId), dropped };
}

// 실패 처리 — 이번 묶음의 말은 queued 로 남기고 재시도 횟수만 올린다. 상한 도달=보류(classify-failed · 화면 '분류하지 못한 사용자 말').
function bumpRetries(ws, items, reason) {
  const back = [], held = [];
  for (const it of items) { const n = (Number(it.retries) || 0) + 1; if (n >= CLASSIFY_RETRY_MAX) held.push(it.id); else back.push({ id: it.id, n }); }
  for (const b of back) UW.setWordStatus(ws, [b.id], "queued", { retries: b.n, lastFail: String(reason || "") });
  if (held.length) UW.setWordStatus(ws, held, "held", { reason: "classify-failed", lastFail: String(reason || "") });
  return { retried: back.length, held: held.length };
}

function writeClassifyReceipt(ws, input, fields) {
  const rec = Object.assign({ ts: new Date().toISOString(), wsKey: CL.wsKeyFor(ws), repoKey: input ? input.repoKey : "", askId: "", purpose: "classify", turnAnchor: input ? String(input.inputFp || "") : "", archiveHash: "", envelopeHash: input ? String(input.gen || "") : "", itemCount: input && input.items ? input.items.length : 0, pages: 0, selectedIds: [], arm: "", durationMs: 0 }, fields || {});
  const name = CL.appendSelectorUsage(rec);
  return { ok: !!name, name };
}
function alarm(ws, ko, en) {
  try { CL.appendIntegrityEvent({ ts: new Date().toISOString(), session: "", workspace: ws, kind: "classify-failed", severity: "warning", detail: ko, detailKo: ko, detailEn: en }, { supersedeSameKindWs: true }); } catch { /* best-effort */ }
}

// ── 잠금(정리 담당과 같은 구조) ──
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } }
function acquireClassifyLock(ws) {
  const f = classifyLockFileFor(ws);
  const token = crypto.randomBytes(8).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token, host: os.hostname() });
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); } catch { /* wx 가 판정 */ }
  for (let k = 0; k < 2; k++) {
    try { fs.writeFileSync(f, payload, { flag: "wx" }); return { ok: true, token }; }
    catch (e) {
      if (!(e && e.code === "EEXIST")) return { ok: false, reason: "lock-io" };
      let cur = null; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { cur = null; }
      const age = cur && cur.ts ? Date.now() - Date.parse(cur.ts) : Infinity;
      const dead = !cur || !pidAlive(Number(cur.pid)) || !(age < CLASSIFY_LOCK_STALE_MS);
      if (!dead) return { ok: false, reason: "running", holder: cur };
      try { fs.renameSync(f, f + ".stale-" + Date.now()); } catch { return { ok: false, reason: "reclaim-failed" }; }
    }
  }
  return { ok: false, reason: "lock-contended" };
}
function releaseClassifyLock(ws, token) {
  const f = classifyLockFileFor(ws);
  try { const cur = JSON.parse(fs.readFileSync(f, "utf8")); if (cur && cur.token === token) fs.rmSync(f, { force: true }); } catch { /* 이미 없음·타인 소유 */ }
}

// ── 실행기 — 검증 무관·유계. opts: {pageRunner(시험 주입), lang, contract, timeoutMs, trigger}
async function runClassify(ws, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const trigger = o.trigger === "auto" || o.trigger === "button" ? o.trigger : "manual";
  const runId = sha1(CL.wsKeyFor(ws) + "|" + t0 + "|" + process.pid + "|" + Math.random()).slice(0, 12);
  const row = (r) => appendClassifyRow(ws, Object.assign({ type: "run", runId, trigger }, r));
  const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!c) { row({ outcome: "contract-unreadable", durationMs: Date.now() - t0 }); alarm(ws, "사용자 말 분류를 시작하지 못했습니다(설정 판독 실패) — 검증에는 영향이 없습니다.", "Classifying the user's words could not start (contract unreadable) — verification is unaffected."); return { st: "contract-unreadable" }; }
  let repo; try { repo = CL.resolveScoutRepo(ws, c).repo; } catch { repo = null; }
  if (!repo) { row({ outcome: "repo-unresolved", durationMs: Date.now() - t0 }); return { st: "repo-unresolved" }; }
  const borrowed = typeof o.lockToken === "string" && lockHeldBy(ws, o.lockToken); // 자동 계기 자식이 잡은 잠금을 이어 씀(판정·소비·실행이 한 잠금 안)
  const lk = borrowed ? { ok: true, token: o.lockToken } : acquireClassifyLock(ws);
  if (!lk.ok) { row({ repoKey: CL.repoKeyOf(repo), outcome: "locked", reason: lk.reason, durationMs: Date.now() - t0 }); return { st: "locked", reason: lk.reason }; }
  try {
    const input = classifyInput(ws, repo, { contract: c });
    if (!input.ok) {
      row({ repoKey: CL.repoKeyOf(repo), outcome: "input-failed", reason: input.reason, durationMs: Date.now() - t0 });
      if (input.reason !== "envelope-inactive") alarm(ws, "사용자 말 분류 입력을 만들 수 없었습니다(" + input.reason + ") — 모아 둔 말은 그대로 남아 있고 검증에는 영향이 없습니다.", "Could not build the classification input (" + input.reason + ") — the collected words are kept; verification is unaffected.");
      return { st: "input-failed", reason: input.reason };
    }
    if (input.unavailable.length) UW.setWordStatus(ws, input.unavailable, "held", { reason: "text-unavailable" }); // 원문을 읽을 수 없는 말=보류(표면)
    if (input.pastedOnly && input.pastedOnly.length) UW.setWordStatus(ws, input.pastedOnly, "classified", { skipped: "pasted-only" }); // [묶음 5(G)] 붙여 넣은 글뿐인 말=분류 대상 아님(처리됨)
    if (!input.items.length) { row({ repoKey: input.repoKey, outcome: "empty", unavailable: input.unavailable.length, pastedOnly: (input.pastedOnly || []).length, durationMs: Date.now() - t0 }); return { st: "empty", unavailable: input.unavailable.length, pastedOnly: (input.pastedOnly || []).length }; }
    const lang = o.lang || CL.loadLang();
    const runner = typeof o.pageRunner === "function" ? o.pageRunner : require("./selector-runner.js").runSelectorPage;
    const h = runner({ arm: input.arm, prompt: buildClassifyPrompt(input, lang), timeoutMs: Number(o.timeoutMs) || CL.SELECTOR_PAGE_TIMEOUT_MS });
    const r = await h.promise;
    const common = { repoKey: input.repoKey, gen: input.gen, arm: input.arm, words: input.items.length, inputFp: input.inputFp };
    if (!r || !r.ok) {
      const key = (r && r.key) || "call-failed";
      const b = bumpRetries(ws, input.items, key);
      row(Object.assign({ outcome: "failed", reason: key, retried: b.retried, held: b.held, durationMs: Date.now() - t0 }, common));
      writeClassifyReceipt(ws, input, { arm: input.arm, pages: 1, outcome: "failed:" + key, durationMs: Date.now() - t0 });
      alarm(ws, "사용자 말 분류 실행이 실패했습니다(" + key + ") — 모아 둔 말은 남아 있고 다음 실행에서 다시 시도합니다(검증 무영향).", "Classifying the user's words failed (" + key + ") — the words are kept and retried next time (verification unaffected).");
      return { st: "call-failed", reason: key, arm: input.arm, retried: b.retried, held: b.held };
    }
    const parsed = parseClassifyOutput(r.output, input);
    if (!parsed.ok) {
      const b = bumpRetries(ws, input.items, "parse:" + parsed.reason);
      row(Object.assign({ outcome: "failed", reason: "parse:" + parsed.reason, retried: b.retried, held: b.held, durationMs: Date.now() - t0 }, common));
      writeClassifyReceipt(ws, input, { arm: input.arm, pages: 1, outcome: "parse-failed:" + parsed.reason, durationMs: Date.now() - t0 });
      alarm(ws, "사용자 말 분류 답을 읽을 수 없어 전량 거부했습니다(" + parsed.reason + ") — 다음 실행에서 다시 분류합니다.", "The classification answer was unreadable and rejected as a whole (" + parsed.reason + ") — reclassified next time.");
      return { st: "parse-failed", reason: parsed.reason, arm: input.arm };
    }
    const cm = commitClassify(ws, input, parsed, { runId });
    if (!cm.ok) {
      const b = bumpRetries(ws, input.items, "commit:" + cm.reason);
      row(Object.assign({ outcome: "failed", reason: "commit:" + cm.reason, retried: b.retried, held: b.held, durationMs: Date.now() - t0 }, common));
      writeClassifyReceipt(ws, input, { arm: input.arm, pages: 1, outcome: "commit-failed:" + cm.reason, durationMs: Date.now() - t0 });
      alarm(ws, "사용자 말 분류 기록이 중단됐습니다(" + cm.reason + ") — 다음 실행이 다시 시도합니다.", "Classification commit aborted (" + cm.reason + ") — the next run retries.");
      return { st: "commit-failed", reason: cm.reason, arm: input.arm };
    }
    const proposed = cm.envIds.length;
    row(Object.assign({ outcome: proposed ? "proposed" : "none", envIds: cm.envIds, dropped: cm.dropped, durationMs: Date.now() - t0 }, common));
    const rc = writeClassifyReceipt(ws, input, { arm: input.arm, pages: 1, selectedIds: cm.envIds.slice(), outcome: proposed ? "proposed:" + proposed : "none", durationMs: Date.now() - t0 });
    return { st: "ok", arm: input.arm, words: input.items.length, unavailable: input.unavailable.length, envIds: cm.envIds, dropped: cm.dropped, receipt: rc.ok, runId };
  } finally { if (!borrowed) releaseClassifyLock(ws, lk.token); }
}

function currentRepoKey(ws) { try { return CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo); } catch { return ""; } }
// ── 요약(CLI·화면) — 현재 저장소 기준: 대기열 수·보류 수(이 저장소+출처 불명)·마지막 실행
function classifySummary(ws) {
  let repoKey = "";
  try { repoKey = CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo); } catch { repoKey = ""; }
  const q = repoKey ? UW.queuedWords(ws, repoKey) : null;
  const held = repoKey ? UW.heldWords(ws, repoKey, { unknown: true }) : null;
  const runs = readClassifyRows(ws).filter((r) => r.type === "run" && (!repoKey || !r.repoKey || r.repoKey === repoKey));
  const last = runs.length ? runs[runs.length - 1] : null;
  return { repoKey, queued: q ? q.length : null, held: held ? held.length : null, heldReasons: held ? held.reduce((a, w) => { const k = w.heldReason || "?"; a[k] = (a[k] || 0) + 1; return a; }, {}) : {},
    lastTs: last ? String(last.ts || "") : "", lastOutcome: last ? String(last.outcome || "") : "", lastReason: last ? String(last.reason || "") : "", runs: runs.length };
}

// ── [묶음 2-나-2 2단계] 자동 계기(설계 §3-3 R4·§7 D2) — 캠페인 마감(검증 통과 마감 또는 상한 소진 마감) 때 대기열에 말이 있으면 실행.
// 두 층(정리 담당과 같은 구조 — ab-6): ⓐ 훅(classifyHookTick)=계약·잠금·tick 상태 파일만 보고 최소 간격(10분)이 지났으면 `classify tick` 을 detach
// ⓑ 자식(classifyTick)=분류 실행 잠금을 먼저 잡고(죽은 소유자는 회수) 그 안에서 판정·마감 소비·실행을 차례로 한다 — 두 자식이 같은 상태를 읽고
//   같은 마감으로 두 번 실행하는 교차를 막는다(구현 검증 1회차 blocker: 판정과 실행권 확보 분리).
// 마감 사건(검증 1회차 blocker: 회차 번호는 수칙서 세대마다 다시 1부터라 상한과 비교할 수 없음):
//   · 통과 마감=판정 행(type round · 기록 시점 저장소 표식 일치) 결과 pass·pass-notes — 열쇠 pass:캠페인:세대:회차:시각
//   · 상한 소진 마감=캠페인 카운터·이력 기록(저장소 표식 일치)의 누적 횟수(count)가 왕복 상한(budget ≥1)에 닿음 — 열쇠 cap:캠페인
// 새 마감 판별은 시각 크기가 아니라 '본 적 있는 열쇠'로(검증 1회차 blocker: 시계가 조금 뒤로 가면 새 마감을 영구 누락). 본 열쇠=지금 보이는 사건 열쇠 전부(꼬리 판독이라 유계).
// 하루 상한 없음(D2 확정 — 자동 실행 수 ≤ 마감 수). 첫 판정=기준선(설치 이전 마감은 세지 않음 — 다른 어떤 조건보다 먼저). 같은 마감은 한 번만.
const CLASSIFY_TICK_MIN_GAP_MS = 10 * 60 * 1000;
const TICK_TAIL_BYTES = 256 * 1024;
const SEEN_KEYS_MAX = 2000; // 본 마감 열쇠 기억 상한(마감 1건=1개 — 하루 수~수십 건 기준 수개월분)
function classifyTickFileFor(ws, repoKey) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + "." + String(repoKey || "norepo") + ".tick.json"); }
// 본 마감 기억 판독 — 부재=null(처음) / 판독 오류={unreadable:true}(검증 3회차: 판독 실패를 처음 상태로 보면 기준선을 다시 잡아 새 마감을 실행 없이 소비 —
// 호출자는 이때 아무것도 쓰지 않는다) / 형식 깨짐·다른 저장소 기록: 기본은 판독 전용({unreadable:true, corrupt:true} — 아무것도 바꾸지 않음),
// opts.quarantine=true(분류 실행 잠금을 쥔 판정만)일 때만 격리(.corrupt-시각) 후 null(처음 — 그동안의 마감을 건너뛸 수는 있어도 두 번 실행하지는 않는 방향).
// (검증 4회차: 격리가 판독 함수에 있으면 잠금 없는 훅이 읽기만 해도 파일을 옮겨, 자식이 잠금 안에서 막 복구한 정상 기억까지 치울 수 있었다)
function readClassifyTick(ws, repoKey, opts) {
  const f = classifyTickFileFor(ws, repoKey);
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? null : { unreadable: true, repoKey: String(repoKey || ""), seeded: false, seenKeys: [], judgedAt: "", ranAt: "", reason: "" }; }
  let o = null; try { o = JSON.parse(raw); } catch { o = null; }
  if (o && typeof o === "object" && String(o.repoKey || "") === String(repoKey || "")) {
    const seen = Array.isArray(o.seenKeys) ? o.seenKeys.map(String) : null;
    return { repoKey: String(repoKey || ""), seeded: o.seeded === true && seen !== null, seenKeys: seen || [], judgedAt: String(o.judgedAt || ""), ranAt: String(o.ranAt || ""), reason: String(o.reason || "") };
  }
  if (!(opts && opts.quarantine === true)) return { unreadable: true, corrupt: true, repoKey: String(repoKey || ""), seeded: false, seenKeys: [], judgedAt: "", ranAt: "", reason: "" }; // 판독 전용 — 격리는 잠금 안 판정만
  try { fs.renameSync(f, f + ".corrupt-" + Date.now()); } catch { return { unreadable: true, repoKey: String(repoKey || ""), seeded: false, seenKeys: [], judgedAt: "", ranAt: "", reason: "" }; } // 격리 실패=판독 오류와 같게(덮어쓰지 않음)
  return null;
}
function writeClassifyTick(ws, repoKey, st) { try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); return CL.atomicWrite(classifyTickFileFor(ws, repoKey), JSON.stringify(Object.assign({}, st, { repoKey: String(repoKey || "") }))); } catch { return false; } }
// 꼬리 판독 — 부재(ENOENT)·빈 파일=[] / 판독 오류=null(검증 2회차: 오류를 빈 목록으로 줄이면 본 마감 기억이 지워져 같은 마감을 다시 실행)
function readTailJson(file, maxBytes) {
  let fd = null;
  try {
    try { fd = fs.openSync(file, "r"); } catch (e) { return e && e.code === "ENOENT" ? [] : null; }
    const st = fs.fstatSync(fd); // 연 파일 기준(검증 3회차: 경로로 크기를 잰 뒤 열기 전에 원자 교체로 줄면 이전 크기로 EOF 너머를 읽어 빈 목록이 됨)
    if (!st.isFile()) return null;
    if (!st.size) return [];
    const len = Math.min(st.size, maxBytes); const buf = Buffer.alloc(len);
    let got = 0; while (got < len) { const n = fs.readSync(fd, buf, got, len - got, st.size - len + got); if (!n) break; got += n; }
    if (got !== len) return null; // 짧은 읽기=판독 오류(빈 목록으로 확정 금지)
    let s = buf.toString("utf8"); if (len < st.size) { const nl = s.indexOf("\n"); s = nl >= 0 ? s.slice(nl + 1) : ""; }
    return s.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 무해 */ } } }
}
// 이 저장소의 마감 사건 — [{key, ts, campaignId, kind:"pass"|"cap"}] (열쇠 중복 없음) · 어느 출처든 판독 오류면 null(빈 목록으로 줄이지 않음).
// 저장소 표식 없는 옛 행·기록=불산입(ab-1).
function closeEventsFor(ws, repoKey) {
  const out = [], keys = new Set();
  const add = (e) => { if (!keys.has(e.key)) { keys.add(e.key); out.push(e); } };
  const led = readTailJson(CL.findingsLedgerFileFor(ws), TICK_TAIL_BYTES);
  if (led === null) return null;
  for (const r of led) {
    if (!(r && r.type === "round" && r.repoKey === repoKey && typeof r.ts === "string")) continue;
    if (r.verdict === "pass" || r.verdict === "pass-notes") add({ key: "pass:" + String(r.campaignId || "") + ":" + String(r.envelopeHash || "") + ":" + String(r.round) + ":" + r.ts, ts: r.ts, campaignId: String(r.campaignId || ""), kind: "pass" });
  }
  const recs = readTailJson(CL.campaignHistoryFileFor(ws), 64 * 1024);
  if (recs === null) return null;
  { let raw = null; try { raw = fs.readFileSync(CL.campaignFileFor(ws), "utf8"); } catch (e) { if (!(e && e.code === "ENOENT")) return null; }
    if (raw !== null) { let o = null; try { o = JSON.parse(raw); } catch { return null; } recs.push(o); } } // 현재 캠페인 기록 판독·형식 오류=알 수 없음(빈 것으로 줄이지 않음)
  for (const o of recs) {
    if (!(o && typeof o.campaignId === "string" && o.campaignId && o.repoKey === repoKey)) continue;
    if (Number.isInteger(o.budget) && o.budget >= 1 && Number.isInteger(o.count) && o.count >= o.budget) add({ key: "cap:" + o.campaignId, ts: String(o.updatedAt || ""), campaignId: o.campaignId, kind: "cap" });
  }
  return out;
}
function classifyLockAlive(ws) {
  let cur = null; try { cur = JSON.parse(fs.readFileSync(classifyLockFileFor(ws), "utf8")); } catch { return false; }
  const age = cur && cur.ts ? Date.now() - Date.parse(cur.ts) : Infinity;
  return !!(cur && pidAlive(Number(cur.pid)) && age < CLASSIFY_LOCK_STALE_MS);
}
function lockHeldBy(ws, token) { try { const cur = JSON.parse(fs.readFileSync(classifyLockFileFor(ws), "utf8")); return !!(cur && token && cur.token === token); } catch { return false; } }
// 판정 — 반환 {spawn, reason, kind?}. opts.lockToken=호출자가 잡은 분류 실행 잠금(있어야 '실행 중' 판정을 건너뛰고 소비를 확정한다).
// 마감 소비 기록이 실패하면 실행하지 않는다(state-write — 같은 마감 재실행 방지가 기록에 기대므로).
function classifyTickJudge(ws, c, opts) {
  const o = opts || {};
  const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!cc) return { spawn: false, reason: "contract-unreadable" };
  let repo; try { repo = CL.resolveScoutRepo(ws, cc).repo; } catch { return { spawn: false, reason: "repo-unresolved" }; }
  const repoKey = CL.repoKeyOf(repo);
  let g = null; try { g = CL.envelopeGenFor(ws, repo, cc); } catch { g = null; }
  if (!g || !g.gen) return { spawn: false, reason: "envelope-inactive" }; // 승인 전·손상=말 소모 없이 대기(수동 실행과 같은 태도)
  const held = typeof o.lockToken === "string" && lockHeldBy(ws, o.lockToken);
  if (!held) return { spawn: false, reason: classifyLockAlive(ws) ? "running" : "lock-required" }; // 판정(=본 마감 기록 갱신)은 분류 실행 잠금을 쥔 경우에만 — 모든 소비 분기 보호(검증 2회차)
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const st0 = readClassifyTick(ws, repoKey, { quarantine: true }); // 잠금 보유 판정만 격리 가능(위 held 확인 뒤)
  if (st0 && st0.unreadable) return { spawn: false, reason: "state-unreadable" }; // 기억 판독 실패=아무것도 쓰지 않음(검증 3회차 — 처음 상태로 보지 않는다)
  const persist = (extra) => writeClassifyTick(ws, repoKey, Object.assign({ seeded: true, seenKeys: st0 ? st0.seenKeys : [], ranAt: st0 ? st0.ranAt : "" }, extra || {}, { judgedAt: new Date(now).toISOString() }));
  const ev = closeEventsFor(ws, repoKey);
  if (ev === null) { persist({ seeded: !!(st0 && st0.seeded), reason: "events-unreadable" }); return { spawn: false, reason: "events-unreadable" }; } // 판독 오류=본 마감 기억 보존·판정 보류(첫 판정이면 기준선도 미뤄 둠 — 다음 판정 재시도)
  // 본 마감 기억=이전 기억∪지금 보이는 열쇠(지우지 않고 더함 · 오래된 것부터 상한 밖으로) — 일부만 읽히는 판독이 기억을 줄이지 않게
  // 순서=지금 안 보이는 옛 기억 → 지금 보이는 열쇠(상한으로 잘릴 때 보이는 열쇠가 먼저 버려져 '새 마감'으로 되살아나지 않게 — 보이는 열쇠 수는 꼬리 판독이라 상한보다 훨씬 작음)
  const evKeys = ev.map((e) => e.key), evSet = new Set(evKeys);
  const visible = [...new Set([...(st0 ? st0.seenKeys : []).filter((k) => !evSet.has(k)), ...evKeys])].slice(-SEEN_KEYS_MAX);
  if (!st0 || !st0.seeded) { persist({ seenKeys: visible, reason: "baseline" }); return { spawn: false, reason: "baseline" }; } // 기준선이 다른 어떤 조건보다 먼저(검증 1회차 blocker)
  const seen = new Set(st0.seenKeys);
  const fresh = ev.filter((e) => !seen.has(e.key));
  // 최근 실행(최소 간격 10분) — 실행 기록 판독 오류는 '이력 없음'이 아니라 알 수 없음(간격 약속을 깨는 실행 금지 · 마감은 소비하지 않고 남김)
  let runsRaw = null, runsExist = false; try { runsRaw = fs.readFileSync(classifyFileFor(ws), "utf8"); runsExist = true; } catch (e) { if (!(e && e.code === "ENOENT")) { persist({ reason: "runs-unreadable" }); return { spawn: false, reason: "runs-unreadable" }; } runsRaw = ""; }
  const wk9 = CL.wsKeyFor(ws);
  const runs = String(runsRaw).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.schema === "classify-v1" && r.wsKey === wk9 && r.type === "run" && r.repoKey === repoKey);
  // 최근 실행 시각=읽힌 마지막 실행 행 시각과 실행 기록 파일의 마지막 변경 시각 중 늦은 쪽 — 실행 기록은 분류 실행만 쓰므로 파일 변경=실행 활동이며,
  // 마지막 행이 쓰다 끊겨 버려져도 간격 약속(10분)이 지켜진다(검증 5회차: 끊긴 최신 행을 버려 간격 안에서 다시 실행)
  // 빈 파일도 '있음'으로 변경 시각 반영(만든 직후 첫 글자 전에 끊긴 경우 — 검증 새 캠페인 1회차)
  let mtime9 = NaN; if (runsExist) { try { mtime9 = fs.statSync(classifyFileFor(ws)).mtimeMs; } catch (e) { if (!(e && e.code === "ENOENT")) { persist({ reason: "runs-unreadable" }); return { spawn: false, reason: "runs-unreadable" }; } } }
  const lastParsed = runs.length ? Date.parse(String(runs[runs.length - 1].ts || "")) : NaN;
  const lastRun = Math.max(Number.isFinite(lastParsed) ? lastParsed : -Infinity, Number.isFinite(mtime9) ? mtime9 : -Infinity);
  if (Number.isFinite(lastRun) && now - lastRun < CLASSIFY_TICK_MIN_GAP_MS) { persist({ reason: "recent" }); return { spawn: false, reason: "recent" }; } // 새 마감은 소비하지 않고 남김
  if (!fresh.length) { persist({ seenKeys: visible, reason: "no-close" }); return { spawn: false, reason: "no-close" }; }
  const q = UW.queuedWords(ws, repoKey);
  if (q === null) { persist({ reason: "queue-unreadable" }); return { spawn: false, reason: "queue-unreadable" }; } // 판독 오류=마감 사건을 소모하지 않음(다음 판정 재시도)
  if (!q.length) { persist({ seenKeys: visible, reason: "queue-empty" }); return { spawn: false, reason: "queue-empty" }; }
  const kind = fresh[fresh.length - 1].kind;
  if (!persist({ seenKeys: visible, reason: "close:" + kind })) return { spawn: false, reason: "state-write" }; // 소비 기록 실패=실행 안 함(같은 마감 재실행 방지가 이 기록에 기댐)
  return { spawn: true, reason: "close:" + kind, kind };
}
function markClassifyRan(ws, repoKey) { const st = readClassifyTick(ws, repoKey); if (st && st.unreadable) return false; return writeClassifyTick(ws, repoKey, Object.assign({ seeded: false, seenKeys: [], judgedAt: "" }, st || {}, { ranAt: new Date().toISOString() })); } // 판독 실패=기억을 덮어쓰지 않음
// 자식 진입점 — 분류 실행 잠금(죽은 소유자 회수) → 판정(잠금 보유) → 실행(같은 잠금 이어 사용) → 해제. 반환 {st, judge, ...runClassify 결과}
async function classifyTick(ws, opts) {
  const o = opts || {};
  const lk = acquireClassifyLock(ws);
  if (!lk.ok) return { st: "no-run", judge: { spawn: false, reason: lk.reason === "running" ? "running" : "lock-" + lk.reason } };
  try {
    const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
    const j = classifyTickJudge(ws, c, { now: o.now, lockToken: lk.token });
    if (!j.spawn) return { st: "no-run", judge: j };
    const r = await runClassify(ws, Object.assign({}, o, { trigger: "auto", contract: c, lockToken: lk.token }));
    try { markClassifyRan(ws, CL.repoKeyOf(CL.resolveScoutRepo(ws, c).repo)); } catch { /* 기록 실패=다음 훅 간격만 짧아짐 */ }
    return Object.assign({ judge: j }, r);
  } finally { releaseClassifyLock(ws, lk.token); }
}
function hookStampFileFor(ws, repoKey) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + "." + String(repoKey || "norepo") + ".hook.json"); }
function readHookStamp(ws, repoKey) { try { const o = JSON.parse(fs.readFileSync(hookStampFileFor(ws, repoKey), "utf8")); return { spawnedAt: String((o && o.spawnedAt) || "") }; } catch { return { spawnedAt: "" }; } }
function writeHookStamp(ws, repoKey, iso) { try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); return CL.atomicWrite(hookStampFileFor(ws, repoKey), JSON.stringify({ spawnedAt: iso, repoKey: String(repoKey || "") })); } catch { return false; } }
// 훅 층 — 전수 판독 0(계약 전달·잠금 파일·tick 상태 파일·수칙서 지문 1회). 최소 간격이 지났으면 `classify tick` 을 detach. 반환=null(무고지).
function classifyHookTick(ws, c, opts) {
  const o = opts || {};
  try {
    const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
    if (!cc) return null;
    let repoKey; try { repoKey = CL.repoKeyOf(CL.resolveScoutRepo(ws, cc).repo); } catch { return null; }
    const st = readClassifyTick(ws, repoKey);
    const hs = readHookStamp(ws, repoKey);
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const lastAct = Math.max(st ? (Date.parse(st.judgedAt || "") || 0) : 0, st ? (Date.parse(st.ranAt || "") || 0) : 0, Date.parse(hs.spawnedAt || "") || 0);
    if (lastAct && now - lastAct < CLASSIFY_TICK_MIN_GAP_MS) return null; // 간격 먼저(가장 싼 판정 — 대부분의 턴은 여기서 끝)
    if (classifyLockAlive(ws)) return null;
    let g = null; try { g = CL.envelopeGenFor(ws, null, cc); } catch { g = null; }
    if (!g || !g.gen) return null;
    // detach 전에 '띄운 시각'을 훅 전용 파일에 찍어 같은 간격 안의 다음 훅이 또 띄우지 않게 — 자식이 쓰는 판정 상태 파일(본 마감 목록)은 건드리지 않는다
    // (검증 1회차: 훅이 판정 상태를 다시 쓰면 자식이 방금 기록한 마감 소비를 옛 값으로 덮어 같은 마감을 다시 실행할 틈이 생김)
    if (!writeHookStamp(ws, repoKey, new Date(now).toISOString())) return null;
    const args = [path.join(__dirname, "codex-bridge.js"), "classify", "tick"];
    const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: String(ws) });
    const sp = typeof o.spawnFn === "function" ? o.spawnFn : require("child_process").spawn;
    const child = sp(process.execPath, args, { cwd: String(ws), detached: true, stdio: "ignore", windowsHide: true, env });
    if (child && typeof child.unref === "function") child.unref();
  } catch { return null; }
  return null;
}

// [RULE-SUPPLY-CORRECTION 묶음 2(I) · D-e] 구현 담당 주입문에 넣던 '[사용자 확인 대기] n건' 한 줄(pendingNoticeFor·pendingUserWordIds·noticeFileFor)은 없앴다 —
// 수칙서 후보의 대기 표시는 대시보드 수칙 카드·개요 '지금 정할 것'에만 있다(대화에 후보 이야기를 끌어들이지 않음).

// ── 분류하지 못한 말 — 사용자 처리(화면): 다시 분류(대기열로 · 재시도 0) / 버리기(분류 대상에서 제외). 이 저장소 말만 다시 분류 가능(출처 불명 말은 버리기만).
function heldWordAction(ws, id, action) {
  const st = UW.readUserWordsState(ws);
  if (st.readError) return { ok: false, reason: "words-unreadable" };
  const w = st.words.get(String(id || ""));
  if (!w) return { ok: false, reason: "not-found" };
  const s = st.status.get(w.id);
  if (!s || s.status !== "held") return { ok: false, reason: "not-held" };
  const rk = currentRepoKey(ws);
  const mine = !!w.repoKey && w.repoKey === rk;
  if (action === "requeue") {
    if (!mine) return { ok: false, reason: w.repoKey ? "repo-mismatch" : "origin-unknown" };
    if (!UW.setWordStatus(ws, [w.id], "queued", { retries: 0, by: "user" })) return { ok: false, reason: "words-write" };
  } else if (action === "dismiss") {
    if (w.repoKey && !mine) return { ok: false, reason: "repo-mismatch" };
    if (!UW.setWordStatus(ws, [w.id], "classified", { dismissed: true, by: "user" })) return { ok: false, reason: "words-write" };
  } else return { ok: false, reason: "bad-action" };
  const after = UW.readUserWordsState(ws).status.get(w.id);
  const want = action === "requeue" ? "queued" : "classified";
  if (!after || after.status !== want) return { ok: false, reason: "words-unsettled" };
  return { ok: true };
}

// ── 화면 자료 — 자리 후보(전달처 표시 재료 포함)·분류하지 못한 말(원문 일부)·요약. 판독 불가=null 칸(화면이 '판독 불가'로 표기).
const HELD_TEXT_SHOW = 400;
function userWordsView(ws) {
  const sm = classifySummary(ws);
  const rk = sm.repoKey;
  const held = rk ? UW.heldWords(ws, rk, { unknown: true }) : null;
  return {
    wsKey: CL.wsKeyFor(ws), repoKey: rk, summary: sm,
    held: held === null ? null : held.map((w) => { const t = UW.wordText(ws, w); return { id: w.id, source: w.source, reason: String(w.heldReason || ""), ts: String(w.ts || ""), text: t === null ? "" : (t.length > HELD_TEXT_SHOW ? t.slice(0, HELD_TEXT_SHOW) + "…" : t), canRequeue: !!w.repoKey && w.repoKey === rk }; }),
  };
}

module.exports = {
  CLASSIFY_TICK_MIN_GAP_MS, classifyTickFileFor, readClassifyTick, writeClassifyTick, closeEventsFor, classifyTickJudge, markClassifyRan, classifyTick, classifyHookTick, classifyLockAlive, readHookStamp, hookStampFileFor,
  heldWordAction, userWordsView,
  CLASSIFY_DIR, CLASSIFY_BATCH_WORDS, CLASSIFY_BATCH_CHARS, CLASSIFY_WORD_SHOW, CLASSIFY_MAX_PER_RUN, CLASSIFY_RETRY_MAX, RULEBOOK_SEATS, SEATS, REDACTED,
  classifyFileFor, seatsFileFor, classifyLockFileFor, armForProvider, rulesFieldFor, redactSensitiveForms,
  readClassifyRows, readSeatsState, userConstraintIdFor,
  classifyInput, buildClassifyPrompt, parseClassifyOutput, commitClassify, bumpRetries, acquireClassifyLock, releaseClassifyLock,
  runClassify, classifySummary,
};
