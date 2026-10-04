"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-나-2 §3-3·§3-4 — 2026-10-05] 사용자 말 분류 실행(독립).
 * 미분류 대기열(user-words)의 사용자 말을 구현 턴과 같은 회사의 독립 실행(selector-runner 페이지 1회 — 도구·MCP 전면 차단)에 넘겨
 * '앞으로도 계속 지킬 기준'을 사용자가 직접 말한 문장만 골라 세 자리로 나눈다.
 *  · 수칙서 자리(지원 환경·항상 막을 것·범위 밖) → 기존 후보 장부의 사용자 약속 후보(kind user-constraint · origin classifier · axis) — 도장 경로 그대로.
 *  · 사용자 규칙 칸 자리 → 자리 장부(classify/<ws>.seats.jsonl) — 도장 시 사용자 글 그대로 구현 담당 규칙 목록에 덧붙임(해석·요약 없음 — RULE-COMPLIANCE P1).
 *  · 결정 기록 자리 → 자리 장부 — 도장 시 결정 장부에 '답한 결정' 행(열린 질문을 만들지 않음).
 * 원칙: 판단은 LLM(문구 감지·키워드 목록 없음) · 인용은 원문 연속 구절만(작문 차단 — 원문 대조) · 판정을 만드는 검증 입력에 넣지 않음(R2) ·
 *       승인 전 원문은 그 말이 나온 구현 턴과 같은 회사로만(R3 — Claude 차례 말=Claude 1회 호출 · Codex 차례 말=Codex 격리 실행) ·
 *       민감 형태는 입력에서 생략 표시로 바꿈(ab-7) · 실패=영수증+경보·대기열 보존(재시도 상한 뒤 '분류하지 못한 말'로 보류 — 조용한 누락 없음) ·
 *       실행 잠금 1개(ab-6 유계) · 모든 기록 덧붙이기 전용(ab-5) · 작업공간 키·저장소 표식 결속(ab-1).
 * 이 모듈은 도장(승인)을 찍지 않는다 — 승인·안 올림은 사용자 화면 몫이고, 여기의 approve/decline 함수는 그 화면이 부르는 정본이다.
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
const SEATS = [...RULEBOOK_SEATS, "rule", "decision"];
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
// 구현 담당 규칙 목록(사용자 규칙 칸) — 회사별 칸(Claude=claude · Codex=codexImplementer)
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
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); fs.appendFileSync(classifyFileFor(ws), JSON.stringify(rec) + "\n"); return true; } catch { return false; }
}
// ── 자리 장부(사용자 규칙 칸·결정 기록 후보) — 같은 id 의 마지막 유효 행이 이김. 판독 오류=readError(빈 장부로 위장 금지).
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
function appendSeatRows(ws, recs) {
  if (!recs.length) return true;
  const chunk = recs.map((r) => JSON.stringify(Object.assign({ schema: "user-seat-v1", wsKey: CL.wsKeyFor(ws) }, r))).join("\n") + "\n";
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); fs.appendFileSync(seatsFileFor(ws), CL.appendLeadFor(seatsFileFor(ws)) + chunk); } catch { return false; } // 꼬리 보호(줄 중간 끊김 뒤 새 행이 버려지지 않게)
  try { return String(fs.readFileSync(seatsFileFor(ws), "utf8")).endsWith(chunk); } catch { return false; }
}
function seatCandidateId(ws, repoKey, seat, quote) { return sha1("seat:" + seat + "|" + CL.wsKeyFor(ws) + "|" + repoKey + "|" + sha1(qNormOf(quote))).slice(0, 16); }
function userConstraintIdFor(ws, repoKey, quote) { return CL.envelopeCandidateId("user-constraint", CL.wsKeyFor(ws) + "|" + repoKey + "|" + sha1(qNormOf(quote))); } // constraintAdd 와 같은 산식(같은 말=같은 후보)
// 이 저장소의 대기 중 자리 후보(화면·CLI 목록)
function listSeatCandidates(ws, repoKey) {
  const st = readSeatsState(ws);
  if (st.readError) return null;
  return [...st.latest.values()].filter((r) => r.status === "proposed" && r.repoKey === repoKey);
}

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
  if (!q.length) return Object.assign(base, { empty: true, items: [], unavailable: [] });
  const provider = providerOf(q[0]); // 가장 오래된 말의 회사부터(한 실행=한 회사 — R3)
  const items = [], unavailable = [];
  let chars = 0;
  for (const w of q) {
    if (providerOf(w) !== provider) continue;
    if (items.length >= CLASSIFY_BATCH_WORDS) break;
    const t = UW.wordText(ws, w);
    if (t === null) { unavailable.push(w.id); continue; } // 보존 기간 밖·변조·소실=분류 불가(보류로 표면)
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
  const decisions = [];
  try { for (const d of CL.readDecisions(ws, { repoKey }).latest.values()) { const ch = (d.choices || []).find((x) => x && x.key === d.choice); decisions.push(String(d.question || "") + (ch ? " → " + ch.label : "")); } } catch { /* 없음 */ }
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
  try { const ss = readSeatsState(ws); if (!ss.readError) for (const r of ss.latest.values()) { if (r.repoKey !== repoKey || !sameCo(r)) continue; if (r.status === "declined") declined.push(r.quote); else if (r.status === "proposed") pending.push(r.quote); } } catch { /* 없음 */ }
  const existing = { rulebook: cap(rulebook), rules: cap(rules), decisions: cap(decisions), pending: cap(pending), declined: cap(declined) };
  const inputFp = sha1(JSON.stringify({ ids: items.map((x) => x.id), existing }));
  return Object.assign(base, { provider, arm: armForProvider(provider), items, unavailable, existing, inputFp });
}

// ── 프롬프트 — 범주 정의만(구체 예시·키워드 없음 — 경직성 금지) ──
function buildClassifyPrompt(input, lang) {
  const en = lang === "en";
  const L = [];
  L.push(en ? "You are an independent classifier of a user's words. Below are things the user said to an AI implementer in one project. Pick ONLY sentences in which the user states a standard that should keep applying from now on, and decide where each belongs. Most messages are one-off requests, questions, confirmations or reactions and belong nowhere — no candidate is better than a weak one. At most " + CLASSIFY_MAX_PER_RUN + "."
    : "당신은 독립 '사용자 말 분류' 담당입니다. 아래는 한 프로젝트에서 사용자가 구현 담당(AI)에게 한 말입니다. 그중 '앞으로도 계속 지켜야 할 기준'을 사용자가 직접 말한 문장만 골라 어느 자리에 둘지 정합니다. 대부분의 말은 이번 작업 요청·질문·확인·감상이라 어디에도 해당하지 않습니다 — 약한 후보보다 무후보가 낫습니다. 최대 " + CLASSIFY_MAX_PER_RUN + "건.");
  L.push(en ? "Seats: supportedEnv (rulebook — the environment/target/range this project is judged against) · alwaysBlocker (rulebook — something that is always a defect when violated) · outOfScope (rulebook — something this stage/project does not cover, so it must not be flagged as a defect) · rule (implementer rule — a lasting rule about how the implementer works or communicates) · decision (decision record — a direction the user chose for the product/design, including what was dropped)."
    : "자리: supportedEnv(수칙서 — 이 프로젝트의 판정 기준이 되는 실행 환경·대상·범위) · alwaysBlocker(수칙서 — 어기면 언제나 결함인 기준) · outOfScope(수칙서 — 지금 단계나 이 프로젝트에서 다루지 않아 결함으로 잡지 말아야 할 것) · rule(구현 담당 규칙 — 구현 담당이 일하거나 소통하는 방식에 대한 지속 규칙) · decision(결정 기록 — 제품·설계 방향에 대해 사용자가 택한 것과 버린 것).");
  L.push(en ? "Rules: quote = an UNCHANGED contiguous passage of that message (12–200 chars, one line) — no summary, translation or stitching; a single changed character is rejected. Never quote a passage containing " + REDACTED + ". why = one line (8–120 chars) on why it should keep applying; no secrets/personal data. Do not propose anything that means the same as an item in the 'already present' lists (including ones the user chose not to adopt). One-off instructions for the current task, questions and feelings are not candidates."
    : "규칙: quote=그 말 원문에서 바꾸지 않은 연속 구절(12~200자·한 줄) — 요약·번역·이어 붙이기 금지, 한 글자라도 다르면 거부됩니다. " + REDACTED + " 표시가 들어간 구절은 쓰지 마세요. why=왜 계속 지킬 기준인지 한 줄(8~120자)·비밀값·개인정보 금지. 아래 '이미 있는 것' 목록과 같은 뜻이면 올리지 마세요(사용자가 안 올린 것 포함). 이번 작업에만 해당하는 지시·질문·감정 표현은 후보가 아닙니다.");
  L.push(en ? "Output exactly one JSON object and nothing else: {\"candidates\":[{\"ref\":\"u1\",\"quote\":\"…\",\"seat\":\"supportedEnv|alwaysBlocker|outOfScope|rule|decision\",\"why\":\"…\",\"recommend\":\"always|related (rulebook seats only)\",\"decisionKind\":\"boundary|product|risk|external (decision only)\"}]} — none: {\"candidates\":[]}."
    : "출력은 JSON 객체 하나뿐(다른 글 금지): {\"candidates\":[{\"ref\":\"u1\",\"quote\":\"…\",\"seat\":\"supportedEnv|alwaysBlocker|outOfScope|rule|decision\",\"why\":\"…\",\"recommend\":\"항상|관련(수칙서 자리만)\",\"decisionKind\":\"boundary|product|risk|external(결정 기록만)\"}]} — 없음은 {\"candidates\":[]}.");
  L.push("");
  const ex = input.existing;
  const dump = (label, arr) => { L.push(label + (arr.length ? "" : (en ? " (none)" : " (없음)"))); for (const x of arr) L.push("- " + x); };
  dump(en ? "[Already present — rulebook]" : "[이미 있는 것 — 수칙서]", ex.rulebook);
  dump(en ? "[Already present — implementer rules]" : "[이미 있는 것 — 구현 담당 규칙]", ex.rules);
  dump(en ? "[Already present — decisions]" : "[이미 있는 것 — 결정 기록]", ex.decisions);
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
    if (!it.text.includes(q)) { drop("not-in-words"); continue; } // 원문 대조(작문 차단) — 보여 준 부분이 아니라 원문 전체
    if (vocab.some((v) => q.includes(v))) { drop("protocol-vocab"); continue; }
    const qs = CL.safeBacklogAutoTitle(q); if (!qs.ok) { drop("sensitive-" + qs.reasonKey); continue; }
    const why = p.why.trim();
    const ws9 = CL.safeBacklogAutoTitle(why); if (!ws9.ok) { drop("why-sensitive-" + ws9.reasonKey); continue; }
    const dk = seat + "|" + qNormOf(q); if (seen.has(dk)) { drop("duplicate-in-run"); continue; } seen.add(dk);
    const rec = (p.recommend === "always" || p.recommend === "항상") ? "항상" : (p.recommend === "related" || p.recommend === "관련") ? "관련" : "";
    const dkind = CL.DECISION_KINDS.includes(String(p.decisionKind || "")) ? String(p.decisionKind) : "product";
    items.push({ ref: p.ref, wordId: it.id, seat, quote: q, why, ...(RULEBOOK_SEATS.includes(seat) && rec ? { recommend: rec } : {}), ...(seat === "decision" ? { decisionKind: dkind } : {}) });
  }
  return { ok: true, items, dropped };
}

// ── 커밋 — 후보(수칙서 자리=후보 장부 · 나머지=자리 장부) 먼저, 그다음 말 상태(classified). 중간 중단=말이 queued 로 남아 다음 실행이 다시
// 분류하고 후보는 같은 id 라 중복 없이 건너뛴다(멱등). 반환 {ok, envIds, seatIds, dropped, reason?}
function commitClassify(ws, input, parsed, meta) {
  const m = meta || {};
  const runId = String(m.runId || "");
  const byWord = new Map(input.items.map((it) => [it.id, it]));
  const cst = CL.readEnvelopeCandidatesState(ws);
  if (cst.readError) return { ok: false, reason: "candidates-unreadable" };
  const sst = readSeatsState(ws);
  if (sst.readError) return { ok: false, reason: "seats-unreadable" };
  let rulesNow = [];
  try { rulesNow = normRuleList((CL.loadContract(ws) || {})[rulesFieldFor(input.provider)]).map((x) => CL.normBacklogTitle(x)); } catch { rulesNow = []; }
  const env = [], seats = [], dropped = parsed.dropped.slice();
  const ts = new Date().toISOString();
  for (const it of parsed.items) {
    const w = byWord.get(it.wordId);
    if (RULEBOOK_SEATS.includes(it.seat)) {
      const cid = userConstraintIdFor(ws, input.repoKey, it.quote);
      if (CL.userDeclinedCandidate(cst.rows, cid)) { dropped.push({ ref: it.ref, seat: it.seat, reason: "user-declined" }); continue; } // 사용자 거절=세대 무관 기억(2-가)
      const cur = cst.latest.get(cid + "@" + input.gen);
      if (cur) { dropped.push({ ref: it.ref, seat: it.seat, reason: "duplicate" }); continue; } // 이 세대에 이미 있음(대기·채택·정리)
      env.push({ candidateId: cid, envelopeHash: input.gen, ...(input.virtual ? { virtualGen: true } : {}), status: "proposed", kind: "user-constraint", origin: "classifier", axis: it.seat, repoKey: input.repoKey,
        title: it.quote, why: it.why, ...(it.recommend ? { recommend: it.recommend } : {}), provider: input.provider, sessionId: w.sessionId, turnAnchor: w.turnAnchor, sourceHash: w.sourceHash,
        quoteSource: w.source, wordId: w.id, ...(runId ? { runId } : {}), ts });
      continue;
    }
    const sid = seatCandidateId(ws, input.repoKey, it.seat, it.quote);
    if (sst.latest.has(sid)) { dropped.push({ ref: it.ref, seat: it.seat, reason: "duplicate" }); continue; } // 대기·승인·거절 모두 재제안 없음(사용자 거절=기억)
    if (it.seat === "rule" && rulesNow.includes(CL.normBacklogTitle(it.quote))) { dropped.push({ ref: it.ref, seat: it.seat, reason: "already-rule" }); continue; }
    seats.push({ candidateId: sid, status: "proposed", seat: it.seat, repoKey: input.repoKey, provider: input.provider, quote: it.quote, why: it.why, ...(it.decisionKind ? { decisionKind: it.decisionKind } : {}),
      wordId: w.id, quoteSource: w.source, turnAnchor: w.turnAnchor, sessionId: w.sessionId, ...(runId ? { runId } : {}), ts });
  }
  if (env.length && !CL.appendEnvelopeCandidates(ws, env)) return { ok: false, reason: "candidates-write" };
  if (seats.length && !appendSeatRows(ws, seats)) return { ok: false, reason: "seats-write" };
  if (!UW.setWordStatus(ws, input.items.map((x) => x.id), "classified", runId ? { runId } : {})) return { ok: false, reason: "words-write" };
  return { ok: true, envIds: env.map((r) => r.candidateId), seatIds: seats.map((r) => r.candidateId), dropped };
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
  const lk = acquireClassifyLock(ws);
  if (!lk.ok) { row({ repoKey: CL.repoKeyOf(repo), outcome: "locked", reason: lk.reason, durationMs: Date.now() - t0 }); return { st: "locked", reason: lk.reason }; }
  try {
    const input = classifyInput(ws, repo, { contract: c });
    if (!input.ok) {
      row({ repoKey: CL.repoKeyOf(repo), outcome: "input-failed", reason: input.reason, durationMs: Date.now() - t0 });
      if (input.reason !== "envelope-inactive") alarm(ws, "사용자 말 분류 입력을 만들 수 없었습니다(" + input.reason + ") — 모아 둔 말은 그대로 남아 있고 검증에는 영향이 없습니다.", "Could not build the classification input (" + input.reason + ") — the collected words are kept; verification is unaffected.");
      return { st: "input-failed", reason: input.reason };
    }
    if (input.unavailable.length) UW.setWordStatus(ws, input.unavailable, "held", { reason: "text-unavailable" }); // 원문을 읽을 수 없는 말=보류(표면)
    if (!input.items.length) { row({ repoKey: input.repoKey, outcome: "empty", unavailable: input.unavailable.length, durationMs: Date.now() - t0 }); return { st: "empty", unavailable: input.unavailable.length }; }
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
    const proposed = cm.envIds.length + cm.seatIds.length;
    row(Object.assign({ outcome: proposed ? "proposed" : "none", envIds: cm.envIds, seatIds: cm.seatIds, dropped: cm.dropped, durationMs: Date.now() - t0 }, common));
    const rc = writeClassifyReceipt(ws, input, { arm: input.arm, pages: 1, selectedIds: cm.envIds.concat(cm.seatIds), outcome: proposed ? "proposed:" + proposed : "none", durationMs: Date.now() - t0 });
    return { st: "ok", arm: input.arm, words: input.items.length, unavailable: input.unavailable.length, envIds: cm.envIds, seatIds: cm.seatIds, dropped: cm.dropped, receipt: rc.ok, runId };
  } finally { releaseClassifyLock(ws, lk.token); }
}

function seatStatusNow(ws, id) { const st = readSeatsState(ws); if (st.readError) return ""; const r = st.latest.get(id); return r ? String(r.status || "") : ""; }
function currentRepoKey(ws) { try { return CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo); } catch { return ""; } }
// ── 도장(사용자 화면이 부르는 정본) — 사용자 규칙 칸·결정 기록 자리. 수칙서 자리는 기존 후보 도장 경로(초안→승인)를 탄다.
// approveSeatCandidate: 규칙=사용자 글 그대로 그 회사 구현 담당 규칙 목록 끝에 덧붙임(같은 문안이 이미 있으면 덧붙이지 않고 승인만 기록) ·
// 결정=결정 장부에 열린 행+답한 행을 한 묶음으로 기록(열린 질문만 남는 중간 상태 없음 — 결정 출처 user-words).
function approveSeatCandidate(ws, candidateId, opts) {
  const o = opts || {};
  const st = readSeatsState(ws);
  if (st.readError) return { ok: false, reason: "seats-unreadable" };
  const cur = st.latest.get(String(candidateId || ""));
  if (!cur) return { ok: false, reason: "not-found" };
  if (cur.status !== "proposed") return { ok: false, reason: "not-proposed", status: cur.status };
  // [검증 1회차 f-aab41e49 · ab-1] 현재 저장소는 이 함수가 직접 판독한다(호출자가 넘긴 값 신뢰 금지) — 다른 저장소에서 나온 말은 이 저장소 규칙·결정에 적지 않음
  if (!cur.repoKey || cur.repoKey !== currentRepoKey(ws)) return { ok: false, reason: "repo-mismatch" };
  const ts = new Date().toISOString();
  let applied = "";
  if (cur.seat === "rule") {
    const field = rulesFieldFor(cur.provider);
    const lang = o.lang || CL.loadLang();
    let added = false;
    const r = CL.updateContractPatch(ws, lang, (next) => {
      // 잠금 안에서 방금 읽은 계약으로 저장소를 다시 대조(앞선 대조와 쓰기 사이 대상 변경 경합 — 다르면 예외로 쓰기 중단)
      let rkIn = ""; try { rkIn = CL.repoKeyOf(CL.resolveScoutRepo(ws, next).repo); } catch { rkIn = ""; }
      if (rkIn !== cur.repoKey) throw new Error("classify-repo-changed");
      const list = Array.isArray(next[field]) ? next[field].map((x) => String(x)) : [];
      if (!list.some((x) => CL.normBacklogTitle(x) === CL.normBacklogTitle(cur.quote))) { list.push(cur.quote); added = true; }
      next[field] = list;
    }, { tries: 3 });
    if (!r.ok) return { ok: false, reason: /classify-repo-changed/.test(String(r.error || "")) ? "repo-mismatch" : "contract-write", detail: String(r.error || r.state || "") };
    applied = added ? "rule-appended:" + field : "rule-already:" + field;
  } else if (cur.seat === "decision") {
    const kind = CL.DECISION_KINDS.includes(cur.decisionKind) ? cur.decisionKind : "product";
    const targetFp = "user-words:" + cur.candidateId;
    const id = CL.decisionIdFor(ws, "", "user-words", "", CL.decisionIdKeyFor(targetFp, cur.quote), cur.repoKey);
    const have = CL.readDecisions(ws, { repoKey: cur.repoKey }).latest.get(id);
    const doneRow = () => ({ schema: "decision-v1", decisionId: id, status: "chosen", wsKey: CL.wsKeyFor(ws), repoKey: cur.repoKey, choice: "stated", by: "user", ts });
    if (have && have.status === "open") { // [검증 1회차 f-717b5498] 앞선 기록이 열린 행만 남기고 실패 — 답한 행만 이어 적어 완료(열린 질문이 남지 않게)
      const w9 = CL.appendDecisionRows(ws, [doneRow()]);
      if (!w9.ok) return { ok: false, reason: "decision-write", detail: String(w9.reason || "") };
    } else if (have && have.status !== "chosen") return { ok: false, reason: "decision-conflict", status: String(have.status || "") };
    if (!have) {
      const open = { schema: "decision-v1", decisionId: id, status: "open", wsKey: CL.wsKeyFor(ws), repoKey: cur.repoKey, origin: "user-words", kind,
        noDefault: "사용자가 직접 말한 결정 — 분류 실행이 찾고 사용자가 확인함(구현자가 정할 항목 아님)", campaignId: "", sourceAsk: "", targetFp,
        question: cur.quote, why: String(cur.why || ""), choices: [{ key: "stated", label: cur.quote }], recommend: "stated", ts };
      const w = CL.appendDecisionRows(ws, [open, doneRow()]);
      if (!w.ok) return { ok: false, reason: "decision-write", detail: String(w.reason || "") };
    }
    const fin = CL.readDecisions(ws, { repoKey: cur.repoKey }).latest.get(id);
    if (!fin || fin.status !== "chosen") return { ok: false, reason: "decision-unsettled" }; // [검증 2회차 f-717b5498] 쓰기 성공 보고와 무관하게 판독 결과가 '답함'이어야 완료
    applied = "decision:" + id;
  } else return { ok: false, reason: "bad-seat" };
  if (!module.exports.appendSeatRows(ws, [{ candidateId: cur.candidateId, status: "approved", by: "user", applied, ts }])) return { ok: false, reason: "seats-write", applied }; // 모듈 경유(시험이 '보고는 성공·판독은 미반영'을 재현할 수 있게)
  if (seatStatusNow(ws, cur.candidateId) !== "approved") return { ok: false, reason: "seats-unsettled", applied }; // 판독 결과로 완료 확인
  return { ok: true, applied };
}
function declineSeatCandidate(ws, candidateId) {
  const st = readSeatsState(ws);
  if (st.readError) return { ok: false, reason: "seats-unreadable" };
  const cur = st.latest.get(String(candidateId || ""));
  if (!cur) return { ok: false, reason: "not-found" };
  if (cur.status !== "proposed") return { ok: false, reason: "not-proposed", status: cur.status };
  if (!cur.repoKey || cur.repoKey !== currentRepoKey(ws)) return { ok: false, reason: "repo-mismatch" }; // [검증 1회차 f-aab41e49] 거절도 지금 대상 저장소의 후보만
  if (!module.exports.appendSeatRows(ws, [{ candidateId: cur.candidateId, status: "declined", by: "user", ts: new Date().toISOString() }])) return { ok: false, reason: "seats-write" };
  if (seatStatusNow(ws, cur.candidateId) !== "declined") return { ok: false, reason: "seats-unsettled" };
  return { ok: true };
}

// ── 요약(CLI·화면) — 현재 저장소 기준: 대기열 수·보류 수(이 저장소+출처 불명)·자리 후보 대기·마지막 실행
function classifySummary(ws) {
  let repoKey = "";
  try { repoKey = CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo); } catch { repoKey = ""; }
  const q = repoKey ? UW.queuedWords(ws, repoKey) : null;
  const held = repoKey ? UW.heldWords(ws, repoKey, { unknown: true }) : null;
  const seats = repoKey ? listSeatCandidates(ws, repoKey) : null;
  const runs = readClassifyRows(ws).filter((r) => r.type === "run" && (!repoKey || !r.repoKey || r.repoKey === repoKey));
  const last = runs.length ? runs[runs.length - 1] : null;
  return { repoKey, queued: q ? q.length : null, held: held ? held.length : null, heldReasons: held ? held.reduce((a, w) => { const k = w.heldReason || "?"; a[k] = (a[k] || 0) + 1; return a; }, {}) : {}, seatsPending: seats ? seats.length : null,
    lastTs: last ? String(last.ts || "") : "", lastOutcome: last ? String(last.outcome || "") : "", lastReason: last ? String(last.reason || "") : "", runs: runs.length };
}

module.exports = {
  CLASSIFY_DIR, CLASSIFY_BATCH_WORDS, CLASSIFY_BATCH_CHARS, CLASSIFY_WORD_SHOW, CLASSIFY_MAX_PER_RUN, CLASSIFY_RETRY_MAX, RULEBOOK_SEATS, SEATS, REDACTED,
  classifyFileFor, seatsFileFor, classifyLockFileFor, armForProvider, rulesFieldFor, redactSensitiveForms,
  readClassifyRows, readSeatsState, appendSeatRows, seatCandidateId, userConstraintIdFor, listSeatCandidates,
  classifyInput, buildClassifyPrompt, parseClassifyOutput, commitClassify, bumpRetries, acquireClassifyLock, releaseClassifyLock,
  runClassify, approveSeatCandidate, declineSeatCandidate, classifySummary,
};
