"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { extractVerdict, authoritativeVerdict, findingsBlockRange, askJobIdOk, readBacklog, normBacklogTitle, readDecisions, renderDecisionBlock, decisionTemplateLabels, repoKeyNow,
  BRIDGE_DIR, wsKeyFor, appendLeadFor, verifyCampaignProgress, claudeCampaignAnchor, freezeImplementerContext, effectiveVerifyBudget, gitHeadState } = require("./contract-lib.js");

// 검증 상한은 검증 호출만 멈춘다. 마지막 검증 지적은 구현자가 먼저 네 갈래로 재판단한다.
// 처리·반박·보관함 항목은 사용자에게 결정을 떠넘기지 않고, 실제 제품 선택만 한 번에 올린다.
const SCHEMAS = [
  {
    lang: "ko",
    head: "[검증 상한 인계]",
    sections: ["[수용·처리]", "[반박·종결]", "[보관함 이관]", "[사용자 판단 필요]", "[잔여 위험 판단]", "[경고등 의미]", "[권장]"],
    none: /^(?:없음|해당 없음)(?:[.!。]|\s)*$/i,
  },
  {
    lang: "en",
    head: "[Verification cap closeout]",
    sections: ["[Accepted and handled]", "[Rebutted and closed]", "[Parked]", "[User decision required]", "[Residual risk call]", "[Alert meaning]", "[Recommendation]"],
    none: /^(?:none|not applicable)(?:[.!]|\s)*$/i,
  },
];

const ECHO_MARKERS = {
  ko: ["각 근거는 아래 네 절", "수용은 실제로 끝낸", "반박은 측정·재현", "보관함 이관은 먼저", "사용자 판단은 구현자가", "질문을 여러 개로 쪼개지", "셋 중 하나로 시작하고 이유를"],
  en: ["put each evidence item in exactly one", "accepted means the work is already done", "a rebuttal needs measured", "parked items require a real", "use user decision required only", "do not split this into several questions", "start with exactly one of these three"],
};

function normBody(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function localNormWs(p) { return path.normalize(String(p || "")).replace(/[\\/]+$/, "").toLowerCase().normalize("NFC"); }
function compactTitle(s) { return normBody(s).slice(0, 200); }
function isNone(schema, body) { return schema.none.test(normBody(body)); }
function countNeedle(body, needle) {
  const hay = normBody(body).toLowerCase();
  const n = normBody(needle).toLowerCase();
  if (!n) return 0;
  let count = 0, at = 0;
  while ((at = hay.indexOf(n, at)) >= 0) { count++; at += n.length; }
  return count;
}

// 정본은 contract-lib으로 옮겼다(확인 검증 blocker①): footer에 붙는 재판단 문안의 '오염 여부'를 판정하는
// 차단기와, 여기서 판정을 읽는 판독기가 서로 다른 규칙을 쓰면 어느 한쪽만 고쳐져 우회로가 생긴다.
// 이 이름은 기존 소비처를 위해 그대로 유지하되 알맹이는 한 곳에서 온다.
const verdictFromAnswer = authoritativeVerdict;

const MAX_CONTEXT_FINDINGS = 64;
function parseFindingEvidence(answer, round) {
  const lines = String(answer || "").split(/\r?\n/);
  // 블록 경계 탐색은 contract-lib이 정본(확인 검증 blocker① — 차단기와 판독기 단일 출처).
  const { start, end } = findingsBlockRange(lines);
  if (start < 0 || end < 0) return { ok: false, evidence: [], reason: "block-missing" };
  const out = [];
  for (let i = start + 1; i < end; i++) {
    if (!String(lines[i] || "").trim()) continue;
    let o = null; try { o = JSON.parse(lines[i]); } catch { return { ok: false, evidence: [], reason: "line-corrupt" }; }
    const title = compactTitle(o && o.title);
    if (!o || typeof o !== "object" || Array.isArray(o) || !title || typeof o.tag !== "string" || !o.tag.trim()) return { ok: false, evidence: [], reason: "line-invalid" };
    if (out.length >= MAX_CONTEXT_FINDINGS) return { ok: false, evidence: [], reason: "finding-overflow" };
    out.push({ key: `R${Number(round) || 0}-F${out.length + 1}`, title, tag: compactTitle(o.tag) });
  }
  return { ok: true, evidence: out, reason: "" };
}
function findingsFromAnswer(answer, round) { return parseFindingEvidence(answer, round).evidence; }

// 상한 시점의 열린 쟁점은 마지막 검증 출력이 권위다. 앞 회차를 합치면 이미 고친 지적이 부활해
// 사용자 질문 폭탄으로 돌아오므로, 마지막 성공 job 하나만 읽고 손상이면 과거 결과로 은폐하지 않는다.
function capHandoffContext(bridgeDir, ws, campaignId) {
  const dir = path.join(String(bridgeDir || ""), "ask-jobs");
  const jobs = [];
  let backlogItems = [], backlogHealthy = false;
  // [개선 2 · 마감문 사용자 판단 절 2026-08-30] 결정 장부의 열린 항목만 사용자 판단으로 인정 — 구현자 산문 질문 차단(스크립트 출력 강제)
  let decisions = [];
  // [저장소 분할 단일 규칙 · 3판 blocker(ab-1)] 마감문에 동봉·대조하는 결정도 현재 정찰 대상 저장소의 항목만(타 저장소의 사용자 질문이 이 마감문에 나타나지 않게).
  try { const rkD = (typeof repoKeyNow === "function") ? repoKeyNow(ws) : ""; decisions = readDecisions(ws, rkD ? { repoKey: rkD } : undefined).open.map((d) => ({ id: String(d.decisionId), question: String(d.question || ""), renderKo: renderDecisionBlock(d, false), renderEn: renderDecisionBlock(d, true) })); } catch { decisions = []; }
  try {
    const backlog = readBacklog(ws);
    backlogHealthy = !backlog.readError && Number(backlog.corrupt || 0) === 0;
    backlogItems = backlog.items.filter((x) => x && x.status === "open")
      .map((x) => ({ id: x.id, title: x.title, file: x.file, status: x.status }));
  } catch { /* 마감은 검증 근거 판독을 우선하되 보관함 자동 종결은 금지 */ }
  try {
    for (const name of fs.readdirSync(dir)) {
      const fm = /^(ask-[0-9a-z-]+)\.json$/i.exec(name);
      if (!fm) continue;
      let j = null; try { j = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
      if (!j || j.state !== "succeeded" || j.campaignId !== campaignId || localNormWs(j.workspace) !== localNormWs(ws)) continue;
      jobs.push({ job: j, fileId: fm[1] });
    }
  } catch { return { evidence: [], alertKind: "verify-handoff-missing", source: "unavailable", unavailable: true, backlogItems, backlogHealthy, decisions }; }
  jobs.sort((a, b) => (Number(a.job.verifyRound) || 0) - (Number(b.job.verifyRound) || 0)
    || Date.parse(a.job.finishedAt || a.job.startedAt || 0) - Date.parse(b.job.finishedAt || b.job.startedAt || 0));
  const rec = jobs[jobs.length - 1];
  if (!rec || !askJobIdOk(rec.fileId) || rec.job.id !== rec.fileId) {
    return { evidence: [], alertKind: "verify-handoff-missing", source: rec ? rec.fileId : "unavailable", unavailable: true, backlogItems, backlogHealthy, decisions };
  }
  let answer = "";
  try { answer = fs.readFileSync(path.join(dir, rec.fileId + ".out"), "utf8"); }
  catch { return { evidence: [], alertKind: "verify-handoff-missing", source: rec.fileId, unavailable: true, backlogItems, backlogHealthy, decisions }; }
  const verdict = verdictFromAnswer(answer);
  // 판정을 문맥에 '동봉'한다(2026-08-05 사용자 실보고 — 이중 실패 봉합): 종전에는 여기서 판정을 계산해
  // alertKind에만 쓰고 버려, 인계문이 하드코딩 "not-pass"로 거짓 전달됐고, 마지막 판정이 '통과'라 지적이
  // 0건인 정상 상태를 "읽지 못함(EVIDENCE-UNAVAILABLE)"으로 조작 표기했다(판정 표지 무손실 원칙 위반).
  const passLike = verdict === "pass" || verdict === "pass-notes";
  const parsed = parseFindingEvidence(answer, rec.job.verifyRound);
  // 손상(파싱 실패)은 통과여도 '판독 불가'다(재확인 blocker①): 승격 조건은 '정상 파싱+빈 목록'뿐.
  // 경고 키도 같은 조건을 따른다(확인 검증 보완): verify-incomplete는 '깨끗한 통과·지적 0'에만 —
  // 통과 선언+블록 손상까지 verify-incomplete로 안내하면 실제 Stop 경보(verify-handoff-missing)와 어긋난다.
  const cleanPass = passLike && parsed.ok && parsed.evidence.length === 0;
  const alertKind = verdict === "fail" || verdict === "inconclusive" ? "verdict-nonclean" : (cleanPass ? "verify-incomplete" : "verify-handoff-missing");
  if (cleanPass) {
    // 통과·열린 지적 0 = 판독 실패가 아니라 정상 — '통과 이후 수정만 미검증' 사례로 정직 표기(보류 계열 경고)
    return { evidence: [], alertKind, source: rec.fileId, unavailable: false, passNoFindings: true, verdict, backlogItems, backlogHealthy, decisions };
  }
  if (!parsed.ok || !parsed.evidence.length) return { evidence: [], alertKind, source: rec.fileId, unavailable: true, verdict, backlogItems, backlogHealthy, decisions };
  return { evidence: parsed.evidence, alertKind, source: rec.fileId, unavailable: false, verdict, backlogItems, backlogHealthy, decisions };
}

function requiredEvidence(context) {
  // EVIDENCE-UNAVAILABLE(검증자 답 판독 불가)은 더 이상 '사용자 판단' 항목이 아니다 — [잔여 위험 판단] 절에서 재검증 판단으로 다룬다(P5②).
  return context && Array.isArray(context.evidence) ? context.evidence : [];
}

// [사용자 판단 필요] 절 = 결정 장부에서 렌더한 블록만("- 결정 <id>: 질문" + 왜/구현자가 못 정하는 이유/선택 1·2/답하기). 산문 질문·근거 키 나열은 거부.
// context.decisions(열린 장부 항목)가 있으면 id 실존·질문 일치까지 결속. 블록 안에 인용된 지적 키(R5-F1)는 그 지적의 유일한 행선지로 센다.
function decisionBlocksOk(schema, body, context) {
  // 머리말·라벨은 코드 상수가 아니라 편집 가능한 결정 블록 서식에서 온다(사용자가 낱말을 고치면 렌더와 검사가 함께 따라감)
  let LB; try { LB = decisionTemplateLabels(schema.lang); } catch { LB = null; }
  if (!LB) return { ok: false };
  const head = LB.header.re, headOrder = LB.header.order;
  const blocks = []; let cur = null;
  for (const raw of String(body || "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const m = head.exec(line);
    if (m) { const idAt = headOrder.indexOf("id") + 1, qAt = headOrder.indexOf("question") + 1; cur = { id: String(m[idAt] || "").toLowerCase(), question: String(m[qAt] || "").trim(), header: line, body: "" }; blocks.push(cur); continue; }
    if (!cur) return { ok: false };
    cur.body += "\n" + line;
  }
  if (!blocks.length) return { ok: false };
  const need = [LB.why.re, LB.noDefault.re, LB.choice.re, LB.recommend.re, LB.answer.re]; // 서식 줄 정규식 — 본문의 어느 줄이든 하나가 맞으면 충족
  const known = context && Array.isArray(context.decisions) ? new Map(context.decisions.map((d) => [String(d.id).toLowerCase(), d])) : null;
  const ids = new Set();
  for (const b of blocks) {
    if (ids.has(b.id)) return { ok: false };
    ids.add(b.id);
    const bodyLines = b.body.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!need.every((re) => bodyLines.some((ln) => re.test(ln)))) return { ok: false };
    if (known) {
      const d = known.get(b.id);
      if (!d) return { ok: false };
      // 정본 렌더와 글자 단위 대조(공백 정규화) — 질문·이유·선택지·권장·답하기 어느 하나라도 장부와 다르면 위조(1회차 blocker·ab-3).
      const canon = normBody(schema.lang === "en" ? d.renderEn : d.renderKo);
      if (!canon || normBody(b.header + " " + b.body) !== canon) return { ok: false };
    }
  }
  return { ok: true, count: blocks.length };
}

function machineEvidence(value) {
  const s = normBody(value);
  if (/\b(?:some|any|generic)[\s_-]+evidence\b|\b(?:none|unknown|proof)\b|어떤[\s_-]*근거|일반[\s_-]*근거|근거\s*(?:없음|미상)|placeholder|lorem|\btbd\b|\btodo\b/i.test(s)) return false;
  const ticks = [...s.matchAll(/`([^\s`]{2,80})`/gu)];
  if (ticks.some((m) => /[\p{L}\p{N}]/u.test(m[1]))) return true;
  if (/(?:^|\s)(?:[\w.-]+[\\/])*[\w.-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|jsonl|md|yml|yaml|toml|ini|log)(?::\d+)?(?:\s|$)/i.test(s)) return true;
  if (/\d+(?:\.\d+)?\s*(?:회|건|개|초|분|ms|s|%|번|times?|cases?|items?|seconds?|minutes?)/i.test(s)) return true;
  const keyed = /(?:테스트|시험|설정|기능|심볼|test|spec|setting|config|symbol)\s*[:=]\s*([^\s,;]{2,})/i.exec(s);
  return !!(keyed && /[\p{L}\p{N}]/u.test(keyed[1]));
}

// 첫 네 절은 한 항목=한 줄이다. 최신 집합 밖 키나 키 없는 임의 질문을 덧붙여 held를 만드는 우회를
// 막고, 수용·반박의 근거 필드 및 보관함 영수증을 해당 지적과 같은 줄에 결속한다.
// [마감 관문 거부 사유 · 2026-09-06 확인검증 보완(사용자 지적)] 검사기는 첫 실패 지점을 문장으로 남긴다 — 종료 훅 거부문이 어느 절·몇 번째 줄·어느 칸이
// 왜 실패했는지 그대로 전달해, 구현자가 추측 수정을 반복하거나 검사기를 직접 돌려 보지 않아도 1회로 고칠 수 있게 한다(하네스 몫 — 구현자 기억에 기대지 않음).
// 단일 스레드 동기 검사라 모듈 변수 하나로 충분하며 validateCapHandoff가 스키마 시도마다 비운다.
let lastWhy = "";
function failWhy(msg) { if (!lastWhy) lastWhy = String(msg || ""); return false; }
function categoryLines(schema, rawBodies, context) {
  const required = requiredEvidence(context);
  const allowed = new Set(required.map((e) => String(e.key).toLowerCase()));
  const byKey = new Map(required.map((e) => [String(e.key).toLowerCase(), e]));
  const seen = new Set();
  const en = schema.lang === "en";
  const S = schema.sections;
  const cellNames = en ? [["Change", "Check", "Evidence"], ["Observation", "Reason", "Evidence"]] : [["변경", "확인", "근거"], ["관측", "이유", "근거"]];
  const evidenceHint = en
    ? "needs a self-identifying fact (a file path with extension, a `backtick` identifier, a number with a unit, or a test:/config:/symbol: key)"
    : "스스로 확인 가능한 근거가 필요(확장자 있는 파일 경로·`백틱` 식별자·숫자+단위·시험:/설정:/심볼: 키 중 하나)";
  for (let lane = 0; lane < 3; lane++) {
    const raw = String(rawBodies[lane] || "").trim();
    if (isNone(schema, raw)) continue;
    const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return failWhy(en ? `${S[lane]} is empty (write items or "none")` : `${S[lane]} 절이 비었음(항목을 쓰거나 "없음")`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const where = en ? `${S[lane]} line ${i + 1}` : `${S[lane]} ${i + 1}번째 줄`;
      const m = /^-\s*(EVIDENCE-UNAVAILABLE|R\d+-F\d+)\b/i.exec(line);
      if (!m) return failWhy(en ? `${where}: must start with "- <key>" (R<n>-F<m>)` : `${where}: "- <키>"(R<n>-F<m>)로 시작해야 함`);
      const key = m[1].toLowerCase();
      // 문맥이 '있는데' 허용 목록이 비면(요구 근거 0 — passNoFindings) 어떤 키도 인정하지 않는다
      // (재확인 blocker②: 빈 목록=무사통과가 허구 지적·가짜 사용자 판단을 승인하던 구멍).
      // 문맥 없는 호출(형식 전용 검사)은 종전대로 키 목록을 강제하지 않는다(기존 계약 무회귀).
      if (context ? (!allowed.size || !allowed.has(key)) : false) return failWhy(en ? `${where}: key ${m[1]} is not in the latest evidence list` : `${where}: 키 ${m[1]}가 이번 근거 목록에 없음`);
      if (seen.has(key)) return failWhy(en ? `${where}: key ${m[1]} is assigned in more than one place` : `${where}: 키 ${m[1]}가 두 곳 이상에 배정됨`);
      seen.add(key);
      const evidence = byKey.get(key);
      if (evidence && evidence.title && countNeedle(line, evidence.title) !== 1) return failWhy(en ? `${where}: the exact finding title must appear once (${m[1]})` : `${where}: 지적 제목 원문이 정확히 1회 있어야 함(${m[1]})`);
      if (lane === 0 || lane === 1) {
        const f = lane === 0
          ? (en ? /\bChange\s*:\s*(.+?)\s*;\s*Check\s*:\s*(.+?)\s*;\s*Evidence\s*:\s*(.+)$/i.exec(line) : /변경\s*:\s*(.+?)\s*;\s*확인\s*:\s*(.+?)\s*;\s*근거\s*:\s*(.+)$/i.exec(line))
          : (en ? /\bObservation\s*:\s*(.+?)\s*;\s*Reason\s*:\s*(.+?)\s*;\s*Evidence\s*:\s*(.+)$/i.exec(line) : /관측\s*:\s*(.+?)\s*;\s*이유\s*:\s*(.+?)\s*;\s*근거\s*:\s*(.+)$/i.exec(line));
        const names = cellNames[lane];
        if (!f) return failWhy(en ? `${where} (${m[1]}): not in the "${names[0]}: …; ${names[1]}: …; ${names[2]}: …" three-cell form` : `${where}(${m[1]}): "${names[0]}: …; ${names[1]}: …; ${names[2]}: …" 세 칸 형식이 아님`);
        for (let c = 0; c < 3; c++) if (!machineEvidence(f[c + 1])) return failWhy(en ? `${where} (${m[1]}): cell "${names[c]}" ${evidenceHint}` : `${where}(${m[1]}): '${names[c]}' 칸 — ${evidenceHint}`);
      } else if (lane === 2 && context) {
        if (!context.backlogHealthy) return failWhy(en ? `${where}: the backlog ledger is unreadable, so parking cannot be accepted` : `${where}: 보관함 장부를 읽을 수 없어 이관을 인정할 수 없음`);
        const idm = /\b[a-f0-9]{16}\b/i.exec(line);
        const item = idm && Array.isArray(context.backlogItems)
          ? context.backlogItems.find((x) => String(x.id).toLowerCase() === idm[0].toLowerCase()) : null;
        if (!item || !evidence || normBacklogTitle(item.title).toLowerCase() !== normBacklogTitle(evidence.title).toLowerCase()) return failWhy(en ? `${where}: needs the real 16-hex receipt id of an open backlog item whose title equals this finding (run backlog add first)` : `${where}: 이 지적과 같은 제목으로 열린 보관함 항목의 실제 16자리 영수증 id가 필요(먼저 backlog add)`);
      }
    }
  }
  // 네 번째 절(결정 블록) 안에 인용된 지적 키 = 그 지적의 행선지(escalate). 최신 집합 밖 키·중복은 거부.
  for (const m of String(rawBodies[3] || "").matchAll(/\b(R\d+-F\d+)\b/g)) {
    const key = m[1].toLowerCase();
    if (context ? (!allowed.size || !allowed.has(key)) : false) return failWhy(en ? `${S[3]}: key ${m[1]} is not in the latest evidence list` : `${S[3]}: 키 ${m[1]}가 이번 근거 목록에 없음`);
    if (seen.has(key)) return failWhy(en ? `${S[3]}: key ${m[1]} is already assigned in another section` : `${S[3]}: 키 ${m[1]}가 다른 절에 이미 배정됨`);
    seen.add(key);
  }
  if (allowed.size && seen.size !== allowed.size) {
    const missing = required.filter((e) => !seen.has(String(e.key).toLowerCase())).map((e) => e.key);
    return failWhy(en ? `every evidence key needs exactly one destination — unassigned: ${missing.join(", ")}` : `모든 지적 키에 행선지가 정해져야 함 — 미배정: ${missing.join(", ")}`);
  }
  return true;
}

function meaningfulSections(schema, rawBodies, context) {
  if (!Array.isArray(rawBodies) || rawBodies.length !== 7) return null;
  const en = schema.lang === "en";
  const S = schema.sections;
  const b = rawBodies.map(normBody), joined = b.join("\n").toLowerCase();
  const filler = /^(?:placeholder(?: content)?(?: here)?|lorem ipsum|tbd|todo|fill(?: this)?(?: in)?|내용(?:을)?\s*(?:입력|작성)|여기에\s*내용(?:을)?\s*(?:입력|작성))[.!?]*$/i;
  for (let i = 0; i < b.length; i++) if (!b[i] || filler.test(b[i])) { failWhy(en ? `${S[i]} is empty or placeholder text` : `${S[i]} 절이 비었거나 자리표시자 문구`); return null; }
  if (ECHO_MARKERS[schema.lang].some((m) => joined.includes(m))) { failWhy(en ? "the closeout repeats the hook's instruction text instead of giving a judgment" : "마감문이 훅 안내문을 되풀이함(판단이 아님)"); return null; }
  if (!categoryLines(schema, rawBodies, context)) return null;

  const accepted = !isNone(schema, b[0]);
  const rebutted = !isNone(schema, b[1]);
  const parked = !isNone(schema, b[2]);
  const needsUserDecision = !isNone(schema, b[3]);
  if (en) {
    if (accepted && !(b[0].length >= 28 && /fixed|implemented|changed|removed|completed|handled|tested|confirmed|evidence/i.test(b[0]))) { failWhy(`${S[0]}: too short or lacks a completion verb (fixed/changed/tested/confirmed…)`); return null; }
    if (rebutted && !(b[1].length >= 36 && /because|reason|rebut|counterexample|measured|reproduced|test|evidence|observed/i.test(b[1]))) { failWhy(`${S[1]}: too short or lacks reason/counterexample/measurement wording`); return null; }
    if (parked && !(b[2].length >= 30 && /\b[a-f0-9]{16}\b/i.test(b[2]) && /receipt|park|backlog|caution/i.test(b[2]))) { failWhy(`${S[2]}: needs a 16-hex receipt id and receipt/backlog wording`); return null; }
    if (needsUserDecision && !decisionBlocksOk(schema, rawBodies[3], context).ok) { failWhy(`${S[3]}: only rendered decision-ledger blocks are accepted (decisions render output verbatim) — prose questions are refused`); return null; }
    if (!/alert|red|yellow/i.test(b[5]) || !/pass|certif|clear|remain|ignore|acknowledge|later/i.test(b[5])) { failWhy(`${S[5]}: must mention the alert/colour and whether it is a pass/cleared/remains`); return null; }
    if (b[6].length < 20 || !/recommend|recommended|because|reason|therefore|no user decision/i.test(b[6])) { failWhy(`${S[6]}: needs a recommendation with a reason (20+ chars)`); return null; }
  } else {
    if (accepted && !(b[0].length >= 20 && /수정|구현|변경|제거|완료|처리|시험|테스트|확인|근거/i.test(b[0]))) { failWhy(`${S[0]}: 20자 이상·처리 동사(수정·변경·시험·확인 등)가 필요`); return null; }
    if (rebutted && !(b[1].length >= 24 && /때문|이유|반박|반례|측정|재현|시험|테스트|근거|확인/i.test(b[1]))) { failWhy(`${S[1]}: 24자 이상·반례·이유·측정 등 근거 어휘가 필요`); return null; }
    if (parked && !(b[2].length >= 22 && /\b[a-f0-9]{16}\b/i.test(b[2]) && /영수증|보관함|백로그|주의|이관/i.test(b[2]))) { failWhy(`${S[2]}: 16자리 영수증 id와 영수증/보관함/백로그 어휘가 필요`); return null; }
    if (needsUserDecision && !decisionBlocksOk(schema, rawBodies[3], context).ok) { failWhy(`${S[3]}: 결정 장부 렌더 블록만 인정(decisions render 출력 그대로) — 산문 질문은 거부`); return null; }
    if (!/경고|빨강|노랑/i.test(b[5]) || !/통과|인증|해소|남|무시|확인|나중/i.test(b[5])) { failWhy(`${S[5]}: 경고 키·색 언급과 '통과 아님/해소/남음' 표현이 필요`); return null; }
    if (b[6].length < 16 || !/권장|추천|때문|이유|따라서|사용자 판단 없/i.test(b[6])) { failWhy(`${S[6]}: 16자 이상·권장과 이유 표현이 필요`); return null; }
  }
  // [잔여 위험 판단 2026-08-29] 상한 소진 뒤 "검증자가 못 본 마지막 수정분"을 어떻게 볼지는 구현자가 판단해야 한다(사용자 실보고:
  // 사실 적시만 있고 판단이 없었음 = 하네스 구조 결함). 절은 셋 중 하나로 시작하고 이유를 달아야 한다:
  //   즉시 재검증 — 미검증분이 경계·무결성·데이터에 닿아 지금 새 캠페인으로 검증 시작(권장 절도 새 검증을 말해야 함)
  //   다음 캠페인 도장 — 미검증분이 국소·회귀 시험으로 덮여 다음 작업의 첫 검증에 동승
  //   무시 가능 — 미검증 수정이 없거나 문구·주석뿐(이유에 그 사실)
  const rr = b[4];
  const rrKind = en
    ? (/^verify now\b/i.test(rr) ? "now" : /^next campaign\b/i.test(rr) ? "next" : /^ignorable\b/i.test(rr) ? "ignore" : null)
    : (/^즉시 재검증/.test(rr) ? "now" : /^다음 캠페인 도장/.test(rr) ? "next" : /^무시 가능/.test(rr) ? "ignore" : null);
  if (!rrKind) { failWhy(en ? `${S[4]}: must start with "Verify now" / "Next campaign" / "Ignorable"` : `${S[4]}: "즉시 재검증"/"다음 캠페인 도장"/"무시 가능" 중 하나로 시작해야 함`); return null; }
  if (en ? !(rr.length >= 30 && /reason\s*:/i.test(rr)) : !(rr.length >= 20 && /이유\s*:/.test(rr))) { failWhy(en ? `${S[4]}: needs "reason:" and 30+ chars` : `${S[4]}: "이유:"와 20자 이상이 필요`); return null; }
  if (rrKind === "now" && (en ? !/verif/i.test(b[6]) : !/검증/.test(b[6]))) { failWhy(en ? `${S[6]}: "Verify now" requires the recommendation to name a new verification` : `${S[6]}: 즉시 재검증이면 권장 절도 새 검증을 말해야 함`); return null; } // 즉시 재검증이면 권장도 새 검증을 말해야 한다
  // 검증자 답을 읽지 못한 마감(P5②): 사용자 판단이 아니라 재검증 판단 — 잔여 위험 절이 그 사실(EVIDENCE-UNAVAILABLE)을 담고 '무시 가능'일 수 없다.
  if (context && context.unavailable && (rrKind === "ignore" || !/EVIDENCE-UNAVAILABLE/.test(rr))) { failWhy(en ? `${S[4]}: when the verifier answer could not be read, write "Verify now — reason: EVIDENCE-UNAVAILABLE …"` : `${S[4]}: 검증자 답을 읽지 못한 마감은 "즉시 재검증 — 이유: EVIDENCE-UNAVAILABLE …"로 써야 함`); return null; }
  if (context && context.alertKind && !b[5].toLowerCase().includes(String(context.alertKind).toLowerCase())) { failWhy(en ? `${S[5]}: must contain the current alert key "${context.alertKind}" verbatim` : `${S[5]}: 현재 경고 키 "${context.alertKind}"를 그대로 포함해야 함`); return null; }
  const dcount = needsUserDecision ? (decisionBlocksOk(schema, rawBodies[3], context).count || 0) : 0;
  return { needsUserDecision, decisionCount: dcount, residualRisk: rrKind };
}

// [P10 2026-09-01 · 확인 검증 1회차 blocker 반영] 마감문의 회차 숫자 "N/M"은 캠페인 장부와 같아야 한다 — 산문이 장부를 덮어쓰지 못함(다르면 마감 미수락).
// 검사 범위=마감 머리부터 끝까지(일곱 절 본문만 보면 머리와 첫 절 사이의 숫자를 놓침). 회차 표기=키워드(회차·round·상한·cap)가 숫자 앞 6자 이내이거나
// 숫자 뒤 3자 이내에 '회차/round'가 오는 꼴 — 조사·콜론·굵게 표시("회차는 3/5입니다"·"round is 3/5"·"회차 **3/5**")는 회차 문구다. 영문 키워드는 단어 경계
// 필수(\w 기준 — recap·background·roundtrip·pre_cap·round_trip 안의 cap/round는 키워드가 아님). "성공 확률 3/4"처럼 키워드가 떨어진 일반 분수는 회차가 아니다. 숫자를 안 쓰면 검사 없음.
const ROUND_FIGURE_RE = /(?:회차|상한|(?<!\w)(?:round|cap)(?!\w))[^\d\n\/]{0,6}(\d{1,3})\s*\/\s*(\d{1,3})|(\d{1,3})\s*\/\s*(\d{1,3})[^\d\n\/]{0,3}(?:회차|(?<!\w)round(?!\w))/gi;
function roundFigureMismatch(text, context) {
  if (!(context && Number.isInteger(context.roundCount) && Number.isInteger(context.roundBudget) && context.roundBudget >= 1)) return false;
  const src = String(text || "");
  const re = new RegExp(ROUND_FIGURE_RE.source, "gi");
  let m;
  while ((m = re.exec(src))) {
    const n = Number(m[1] != null ? m[1] : m[3]), d = Number(m[2] != null ? m[2] : m[4]);
    if (n !== context.roundCount || d !== context.roundBudget) return true;
  }
  return false;
}

// 마감 글을 절 본문 일곱 개로 나눈다 — 검사기(validateCapHandoff)와 화면 집계(closeoutLaneCounts)가 같은 경계 규칙 하나를 쓴다.
// 머리=마지막 출현 · 절 제목은 정해진 순서로 모두 있어야 한다.
function splitCloseout(s, schema) {
  const headAt = s.lastIndexOf(schema.head);
  if (headAt < 0) return { ok: false, absent: true, missing: [] };
  const candidate = s.slice(headAt);
  const marks = [schema.head, ...schema.sections];
  const at = marks.map((m) => candidate.indexOf(m));
  if (at.some((n) => n < 0) || at.some((n, i) => i > 0 && n <= at[i - 1])) return { ok: false, absent: false, missing: marks.filter((m, i) => at[i] < 0) };
  const bodies = [];
  for (let i = 1; i < marks.length; i++) {
    const start = at[i] + marks[i].length;
    const end = i + 1 < marks.length ? at[i + 1] : candidate.length;
    bodies.push(candidate.slice(start, end).trim());
  }
  return { ok: true, absent: false, candidate, bodies, missing: [] };
}
function validateCapHandoff(text, context) {
  const s = String(text || "");
  let detail = "";
  for (const schema of SCHEMAS) {
    const sp = splitCloseout(s, schema);
    if (sp.absent) continue;
    if (!sp.ok) {
      if (!detail) detail = schema.lang === "en"
        ? (sp.missing.length ? `section title missing: ${sp.missing.join(" ")}` : "section titles are out of order")
        : (sp.missing.length ? `절 제목 누락: ${sp.missing.join(" ")}` : "절 제목 순서가 틀림");
      continue;
    }
    const candidate = sp.candidate, bodies = sp.bodies;
    lastWhy = "";
    const result = meaningfulSections(schema, bodies, context);
    if (result && roundFigureMismatch(candidate, context)) return { ok: false, lang: schema.lang, missing: ["round-figure-mismatch"], needsUserDecision: false, decisionCount: 0, detail: schema.lang === "en" ? `a round figure in the closeout differs from the ledger's actual value (${context.roundCount}/${context.roundBudget})` : `마감문의 회차 숫자가 장부 실제값(${context.roundCount}/${context.roundBudget})과 다름` }; // [P10] 머리 포함 전체
    if (result) return { ok: true, lang: schema.lang, missing: [], ...result };
    if (lastWhy) detail = lastWhy;
  }
  return { ok: false, lang: null, missing: ["cap-closeout-sections"], needsUserDecision: false, decisionCount: 0, ...(detail ? { detail } : {}) };
}

function capHandoffInstruction(lang, round, verdict, context, detail) {
  const ctx = context && typeof context === "object" ? context : { evidence: [], alertKind: "verify-handoff-missing", source: "unavailable", unavailable: true };
  // 실제 판정 우선(2026-08-05 이중 실패 봉합): 호출자가 넘긴 값보다 문맥에 동봉된 판독 결과가 정본 —
  // 하드코딩 "not-pass"가 통과를 덮어쓰던 거짓 전달 차단. 라벨은 판정 표지 어휘 그대로.
  const effVerdict = (ctx && ctx.verdict) || verdict || null;
  const vKo = effVerdict === "pass" ? "통과" : effVerdict === "pass-notes" ? "통과(보완)" : effVerdict === "inconclusive" ? "보류" : effVerdict === "fail" ? "실패" : "통과 아님";
  const vEn = effVerdict === "pass" ? "pass" : effVerdict === "pass-notes" ? "pass-with-notes" : effVerdict === "inconclusive" ? "inconclusive" : effVerdict === "fail" ? "fail" : "not-pass";
  const evidenceLines = Array.isArray(ctx.evidence) ? ctx.evidence.map((e) => `- ${e.key} ${e.title}`) : [];
  if (ctx.passNoFindings) evidenceLines.push(lang === "en"
    ? "- PASS-NO-FINDINGS (last verdict passed with no open findings — only the edits made after that pass are unverified)"
    : "- PASS-NO-FINDINGS (마지막 판정 통과 — 열린 지적 없음·통과 이후의 수정만 미검증)");
  else if (ctx.unavailable || !evidenceLines.length) evidenceLines.push("- EVIDENCE-UNAVAILABLE (the latest verification findings could not be read completely)");
  const evidence = evidenceLines.join("\n");
  const roundNote = lang === "en" ? ` If you quote a round figure, it must be the ledger's actual value (${round}).` : ` 회차 숫자를 쓰면 장부 실제값(${round}) 그대로여야 합니다.`;
  // [거부 사유 명시 · 2026-09-06] 직전 마감문이 검사에서 왜 거부됐는지(절·줄·칸·이유)를 첫 줄에 — 검사기(validateCapHandoff)의 detail 그대로. 없으면 종전과 같은 안내.
  const whyLine = (typeof detail === "string" && detail.trim()) ? (lang === "en" ? `[Why the closeout record was not accepted] ${detail.trim()}\n` : `[직전 마감 기록 거부 사유] ${detail.trim()}\n`) : "";
  // [RULE-SUPPLY 묶음 3 §4] 마감 기록은 답 본문이 아니라 명령으로 제출한다 — 형식이 틀려도 명령 결과로만 되돌아오고 사용자에게 보이는 답은 되풀이되지 않는다.
  const cmd = require(path.join(__dirname, "contract-lib.js")).bridgeCmd("codex-bridge.js");
  if (lang === "en") return whyLine + roundNote + "\n" + `[Verify mode · actual round ${round}] The verification-call cap is exhausted and there is no pass proof bound to this turn (last verdict: ${vEn}). Do not start another verification job. Re-judge only the latest findings below and write one closeout record using the exact headings, save it to a temporary file outside the project, and submit it with \`${cmd} closing submit --file <that file>\` — the command checks it immediately and returns the reason if it is refused, so fix and resubmit (template again: \`${cmd} closing template\`). When you finish, the submitted record is checked again against the current state (resubmit if you edit files after submitting or the backlog/decision ledger changes). Do not paste the record into the reply the user sees — give a plain summary plus one line "Closeout record submitted (dashboard)". Put each evidence item in exactly one of the first four sections. The record is accepted only when every item has one destination.\nLatest evidence (${ctx.source || "unavailable"}):\n${evidence}\nExpected dashboard alert key: ${ctx.alertKind || "verify-handoff-missing"}\n\n[Verification cap closeout]\n[Accepted and handled]\nOne item per line: - <key> <exact title> — Change: <specific change containing a file, backticked identifier, test/setting key, or measured value>; Check: <specific result with one of those anchors>; Evidence: <one of those anchors again>. Every field needs its own anchor. Write None if empty.\n[Rebutted and closed]\nOne item per line: - <key> <exact title> — Observation: <counterexample with its own anchor>; Reason: <closing reason with its own anchor>; Evidence: <one anchor again>. Every field needs its own anchor. Write None if empty.\n[Parked]\nOne item per line. Park only after backlog add with the exact finding title; include that open item's real 16-hex receipt id. Write None if empty.\n[User decision required]\nOnly open items of the decision ledger, pasted from \`${require(path.join(__dirname, "contract-lib.js")).bridgeCmd("codex-bridge.js")} decisions render\` (block: - Decision <id>: <question> / Why: / Why the implementer cannot decide: / Option 1 (key): … — if chosen: … / Option 2 … / Recommended: / Answer: …). Use user decision required only for a boundary, product-direction, risk-acceptance, or external choice the implementer cannot decide — create it first with decisions raise and record it with finding-judge/round-judge escalate --decision <id>; a finding escalated this way is cited inside its block by key. Prose questions are rejected. If the only evidence line above is PASS-NO-FINDINGS, write None in all four sections. Write None if empty; do not invent a user question. EVIDENCE-UNAVAILABLE (the verifier's answer could not be read) is NOT a user decision — put it in [Residual risk call] as "Verify now — Reason: EVIDENCE-UNAVAILABLE …" (request the findings format again).\n[Residual risk call]\nOne line that starts with exactly one of these three, then Reason: — "Verify now" (the unverified edits touch a boundary, integrity, or data: start a new verification campaign in this turn and say so in Recommendation), "Next campaign" (local edits covered by regression tests: stamp them in the next campaign's first verification), "Ignorable" (no unverified code change, wording only).\n[Alert meaning]\nInclude the expected alert key verbatim. Explain whether the remaining red/yellow alert needs user action and that this closeout is not a verification pass.\n[Recommendation]\nRecommend one next action, or explicitly say no user decision is needed. Do not split this into several questions.`;
  const evidenceKo = evidence.replace("(the latest verification findings could not be read completely)", "(마지막 검증 지적을 완전하게 읽지 못함)");
  return whyLine + roundNote + "\n" + `[검증 모드 · 실제 회차 ${round}] 검증 호출 상한이 소진됐고 결속된 통과 증명이 없습니다(마지막 판정: ${vKo}). 새 검증 작업은 만들지 마세요. 아래 마지막 검증 지적만 다시 판단해 정확한 제목으로 마감 기록 하나를 쓰고, 프로젝트 밖 임시 파일에 저장해 \`${cmd} closing submit --file <그 파일>\` 로 제출하세요 — 명령이 바로 검사해 거부 사유를 돌려주므로 고쳐서 다시 제출하면 됩니다(양식 다시 보기: \`${cmd} closing template\`). 응답을 마칠 때 제출된 기록을 지금 상태로 다시 검사합니다(제출 뒤 파일을 고치거나 보관함·결정 장부가 바뀌면 다시 제출). 사용자에게 보이는 답에는 이 기록을 붙이지 말고, 평이한 요약과 "마감 기록 제출됨(대시보드)" 한 줄만 쓰세요. 각 근거는 아래 네 절 중 정확히 한 곳에만 들어가야 하며, 모든 항목의 행선지가 정해져야 인정됩니다.\n마지막 검증 근거(${ctx.source || "판독 불가"}):\n${evidenceKo}\n현재 대시보드 경고 키: ${ctx.alertKind || "verify-handoff-missing"}\n\n[검증 상한 인계]\n[수용·처리]\n한 항목을 한 줄로 씁니다: - <키> <정확한 제목> — 변경: <파일·백틱 식별자·시험/설정 키·측정값 중 하나를 포함한 구체 변경>; 확인: <그런 식별 근거를 자체 포함한 구체 결과>; 근거: <식별 근거 하나>. 세 칸 각각 자기 근거가 필요합니다. 없으면 없음.\n[반박·종결]\n한 항목을 한 줄로 씁니다: - <키> <정확한 제목> — 관측: <자기 식별 근거를 포함한 반례>; 이유: <자기 식별 근거를 포함한 종결 이유>; 근거: <식별 근거 하나>. 세 칸 각각 자기 근거가 필요합니다. 없으면 없음.\n[보관함 이관]\n한 항목을 한 줄로 씁니다. 정확한 지적 제목으로 backlog add를 먼저 실행하고 그 열린 항목의 실제 16자리 영수증 id를 씁니다. 없으면 없음.\n[사용자 판단 필요]\n결정 장부의 열린 항목만, \`${require(path.join(__dirname, "contract-lib.js")).bridgeCmd("codex-bridge.js")} decisions render\` 출력을 그대로 붙입니다(블록: - 결정 <id>: <질문> / 왜: / 구현자가 못 정하는 이유: / 선택 1 (키): … — 고르면: … / 선택 2 … / 권장: / 답하기: …). 사용자 판단은 구현자가 대신 정할 수 없는 범위표·제품 방향·위험 수용·외부 결정만 — 먼저 decisions raise 로 항목을 만들고 finding-judge/round-judge escalate --decision <id> 로 기록하며, 그렇게 올린 지적은 블록 안에 키로 인용합니다. 산문 질문은 거부됩니다. 위 근거가 PASS-NO-FINDINGS뿐이면 네 절을 모두 없음으로 쓰면 됩니다. 없으면 없음이라고 쓰고 사용자 질문을 만들지 마세요. EVIDENCE-UNAVAILABLE(검증자 답을 읽지 못함)은 사용자 판단이 아니라 [잔여 위험 판단]에 "즉시 재검증 — 이유: EVIDENCE-UNAVAILABLE …"로 씁니다(서식 재발급 요청).\n[잔여 위험 판단]\n검증자가 못 본 마지막 수정분을 어떻게 볼지 한 줄로 판단합니다. 셋 중 하나로 시작하고 이유를 답니다: "즉시 재검증"(경계·무결성·데이터에 닿는 수정 — 이 턴에서 새 검증 캠페인을 시작하고 권장 절에도 그렇게 씀) / "다음 캠페인 도장"(국소 수정·회귀 시험으로 덮임 — 다음 작업 첫 검증에 동승) / "무시 가능"(미검증 코드 수정 없음·문구뿐). 이유: 를 반드시 포함.\n[경고등 의미]\n현재 경고 키를 그대로 포함하고, 남은 빨강·노랑에 사용자 행동이 필요한지와 이 마감이 검증 통과는 아니라는 점을 밝히세요.\n[권장]\n다음 행동 하나를 권장하거나 사용자 판단이 필요 없다고 명시하세요. 질문을 여러 개로 쪼개지 마세요.`;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => b && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
}

function injectedCodexUser(text) {
  const s = String(text || "").trim();
  return /^<(environment_context|user_instructions|system|recommended_plugins>|hook_prompt[\s>])/i.test(s) || s.startsWith("# AGENTS.md");
}

// [RULE-SUPPLY 묶음 3] 상한 마감 글을 답 본문에서 모으던 claudeAssistantText·codexAssistantText 는 폐지 — 종료 관문은 제출된 마감 기록(stopCloseoutCheck)만 본다.


// ── (연혁) 2026-09-01 개선 3 '보고 양식 경비원'(세 칸 제목 존재 검사)이 여기 있었다 — 2026-09-03 폐지. ──
// [RULE-COMPLIANCE §3 E 2026-09-03] 보고 세 칸 상수(REPORT_SECTIONS)·reportShapeCheck·reportShapeInstruction 폐지 — 특정 사용자 선호의 전역 고정이었다.
// 대체=사용자 규칙 칸+[계약점검] 구조 검사(contract-lib ruleCheckVerdict). 마지막 답 추출기는 그 검사가 재사용한다.
// 마지막 답 1개(사람 발화 뒤의 마지막 assistant 텍스트) — 경비원은 '마지막 답'만 본다
function lastAssistantText(lines, lastUser) {
  let last = "";
  for (let i = Math.max(0, Number(lastUser) + 1); i < (lines || []).length; i++) {
    let o = null; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o && o.type === "assistant" && o.message) { const s = textOfContent(o.message.content).trim(); if (s) last = s; }
  }
  return last;
}
function lastCodexAssistantText(file) {
  if (!file) return "";
  let lines = null; try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { return ""; }
  let last = "";
  for (const line of lines) {
    let o = null; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== "response_item" || o.payload?.type !== "message") continue;
    const role = o.payload.role; const s = textOfContent(o.payload.content).trim();
    if (role === "user" && s && !injectedCodexUser(s)) { last = ""; continue; }
    if (role === "assistant" && s) last = s;
  }
  return last;
}
// ── [RULE-SUPPLY 묶음 3 §4 · 2026-10-05] 마감 기록 — 답 본문 파싱 대신 명령으로 제출해 캠페인에 결속하고, 종료 관문이 현재 문맥으로 다시 검사한다 ──
// 장부=작업공간별 덧붙이기(closeouts/<wsKey>.jsonl · 꼬리 보호). 캠페인마다 마지막 행이 권위. 기록은 검증 통과 증명이 아니다(종료 조건의 다른 축과 AND).
const CLOSEOUT_SCHEMA = "closeout-v1";
const CLOSEOUT_TEXT_MAX = 64 * 1024; // 한 기록 상한(바이트) — 마지막 지적 64건 한 줄씩이어도 넉넉
const CLOSEOUT_VIEW_MAX = 10; // 화면에 보이는 최근 기록 수
const CLOSEOUT_VIEW_TAIL = 512 * 1024; // 화면 판독은 장부 꼬리만(갱신 때마다 전체를 읽지 않음)
const CLOSEOUT_RISKS = ["now", "next", "ignore"];
function closeoutsDir() { return path.join(BRIDGE_DIR, "closeouts"); }
function closeoutFileFor(ws) { return path.join(closeoutsDir(), wsKeyFor(ws) + ".jsonl"); }
function sha1Hex(s) { return crypto.createHash("sha1").update(String(s)).digest("hex"); }
function closeoutRowValid(o) {
  return !!(o && typeof o === "object" && o.schema === CLOSEOUT_SCHEMA && /^co-[0-9a-f]{16}$/.test(String(o.id || ""))
    && Number.isFinite(Date.parse(o.ts)) && typeof o.campaignId === "string" && o.campaignId
    && typeof o.text === "string" && (o.host === "claude" || o.host === "codex") && CLOSEOUT_RISKS.includes(o.residualRisk));
}
function closeoutRowsOf(raw, wk) {
  const rows = []; let corrupt = 0;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o = null; try { o = JSON.parse(line); } catch { corrupt++; continue; }
    if (closeoutRowValid(o) && o.wsKey === wk) rows.push(o); else corrupt++;
  }
  return { rows, corrupt };
}
// 판독: 부재=기록 없음 · 그 밖의 판독 오류=readError(없음으로 줄이지 않는다 — 종료 관문은 미인정 쪽)
function readCloseouts(ws) {
  let raw = "";
  try { raw = fs.readFileSync(closeoutFileFor(ws), "utf8"); }
  catch (e) { return { rows: [], corrupt: 0, readError: !(e && e.code === "ENOENT") }; }
  return Object.assign({ readError: false }, closeoutRowsOf(raw, wsKeyFor(ws)));
}
// repoKey(선택)=그 저장소 기록만(표식 없음=""과 같은 것으로 본다 — 제출 때와 같은 계산 repoKeyNow) — [구현 검증 1회차 f-f318a260] 다른 저장소 기록으로 종료하지 않는다(ab-1)
function latestCloseoutFor(ws, campaignId, repoKey) {
  const r = readCloseouts(ws);
  if (r.readError) return { row: null, readError: true };
  let row = null;
  for (const o of r.rows) if (o.campaignId === campaignId && (repoKey === undefined || String(o.repoKey || "") === String(repoKey || ""))) row = o;
  return { row, readError: false };
}
function currentRepoKey(ws) { try { return repoKeyNow(ws) || ""; } catch { return ""; } }
// [구현 검증 1회차 f-62c0d942] 제출 때 저장소 상태(마지막 커밋+바뀐 파일 목록 지문)를 기록에 묶는다 — 제출 뒤 고친 것을 커밋해 작업 트리가 깨끗해져도
// 상태가 달라졌음을 안다. 지도 자동 생성물(project-map/)은 지문에서 뺀다(종료 관문의 변경 시각 판독과 같은 예외). 판독 불가=ok:false(미인정 쪽).
function closeoutRepoState(ws) {
  let head = null;
  try { head = gitHeadState(ws); } catch { head = null; }
  if (head && head.state === "non-git") return { ok: true, head: "non-git", statusFp: "" };
  if (!head || (head.state !== "git" && head.state !== "no-head")) return { ok: false };
  let r = null;
  try { r = require("child_process").spawnSync("git", ["-c", "safe.directory=*", "-C", ws, "--no-optional-locks", "-c", "core.quotepath=false", "status", "--porcelain"], { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }); }
  catch { return { ok: false }; }
  if (!r || r.status !== 0 || typeof r.stdout !== "string") return { ok: false };
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim()).filter((l) => {
    let p = l.slice(3); const arrow = p.indexOf(" -> "); if (arrow >= 0) p = p.slice(arrow + 4);
    const q = p.replace(/^"|"$/g, "").replace(/\\/g, "/");
    return !(q === "project-map/" || q.startsWith("project-map/"));
  }).sort();
  return { ok: true, head: head.state === "git" ? String(head.oid) : "no-head", statusFp: sha1Hex(lines.join("\n")) };
}
// 지금 이 구현 대화의 캠페인 — 종료 관문이 쓰는 것과 같은 원천(Claude=세션 앵커 · Codex=구현 대화 링크+턴 기록)
function closeoutTargetFor(ws, c, env) {
  const e = env || process.env;
  const host = c && c.harnessMode === "codex-codex" ? "codex" : "claude";
  const off = host === "codex" ? (c && c.codexVerifyMode === "off") : (c && c.verifyMode === "off");
  let campaignId = "", session = "", reason = "";
  if (host === "claude") {
    const sid = String(e.CLAUDE_CODE_SESSION_ID || "");
    const an = sid ? claudeCampaignAnchor(sid) : { ok: false, reason: "no-session-env" };
    if (an.ok) { campaignId = an.campaignId; session = sid; } else reason = an.reason;
  } else {
    // [구현 검증 1회차 f-923705bc] 호출한 Codex 대화(CODEX_THREAD_ID)가 지금 연결된 구현 대화일 때만 — 다른 대화가 그 캠페인의 마감을 대신 기록하지 않는다(ab-1)
    const caller = String(e.CODEX_THREAD_ID || "");
    const fr = freezeImplementerContext(ws);
    if (!caller) reason = "no-session-env";
    else if (!fr.ok) reason = fr.reason;
    else if (fr.implementerSession !== caller) reason = "caller-not-implementer";
    else { campaignId = "cc:" + fr.implementerSession + ":" + fr.implementerTurnId; session = fr.implementerSession; }
  }
  if (!campaignId) return { ok: false, host, off: !!off, reason: reason || "no-campaign" };
  const progress = verifyCampaignProgress(ws, campaignId, effectiveVerifyBudget(c || {}));
  const capReached = !off && progress.tracked && progress.budget >= 1 && progress.count >= progress.budget;
  return { ok: true, host, off: !!off, campaignId, session, progress, capReached };
}
function closeoutContextFor(ws, campaignId, progress) {
  return Object.assign(capHandoffContext(BRIDGE_DIR, ws, campaignId), { roundCount: progress.count, roundBudget: progress.budget });
}
// 제출: 상한에 닿은 캠페인만 · 제출 시점의 현재 문맥으로 같은 검사기 · 통과하면 덧붙이고 다시 읽어 확인(확인 실패=미제출)
function submitCloseout(ws, opts) {
  const o = opts || {}, tg = o.target;
  if (!tg || !tg.ok) return { ok: false, reason: "no-campaign", detail: (tg && tg.reason) || "" };
  if (tg.off) return { ok: false, reason: "verify-off" };
  if (!tg.capReached) return { ok: false, reason: "not-at-cap", progress: tg.progress };
  const text = String(o.text == null ? "" : o.text).replace(/^\uFEFF/, "");
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (Buffer.byteLength(text, "utf8") > CLOSEOUT_TEXT_MAX) return { ok: false, reason: "too-large" };
  const ctx = closeoutContextFor(ws, tg.campaignId, tg.progress);
  const v = validateCapHandoff(text, ctx);
  if (!v.ok) return { ok: false, reason: "invalid", detail: v.detail || (v.missing || []).join(", ") };
  const repoState = closeoutRepoState(ws);
  if (!repoState.ok) return { ok: false, reason: "repo-unreadable" };
  const ts = new Date(Number.isFinite(o.now) ? o.now : Date.now()).toISOString();
  const wk = wsKeyFor(ws), textHash = sha1Hex(text);
  const id = "co-" + sha1Hex(wk + "|" + tg.campaignId + "|" + ts + "|" + textHash).slice(0, 16);
  const rk = currentRepoKey(ws);
  const row = { schema: CLOSEOUT_SCHEMA, id, ts, wsKey: wk, workspace: ws, ...(rk ? { repoKey: rk } : {}), host: tg.host, session: tg.session, campaignId: tg.campaignId,
    round: { count: tg.progress.count, budget: tg.progress.budget }, sourceAsk: String(ctx.source || ""), alertKind: String(ctx.alertKind || ""), verdict: ctx.verdict || null,
    lang: v.lang, needsUserDecision: !!v.needsUserDecision, decisionCount: Number(v.decisionCount) || 0, residualRisk: v.residualRisk, repoState: { head: repoState.head, statusFp: repoState.statusFp }, textHash, text };
  const file = closeoutFileFor(ws);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, appendLeadFor(file) + JSON.stringify(row) + "\n"); }
  catch { return { ok: false, reason: "write-failed" }; }
  const back = latestCloseoutFor(ws, tg.campaignId, rk);
  if (back.readError || !back.row || back.row.id !== id) return { ok: false, reason: "write-unconfirmed" };
  return { ok: true, id, row, result: v };
}
// 종료 관문: 결속된 마지막 기록을 읽어 ①마지막 변경(도구·파일) 뒤에 제출됐는지 ②종료 시점 현재 문맥으로 같은 검사기를 다시 통과하는지
function stopCloseoutCheck(ws, campaignId, context, sinceTs, lang) {
  const en = lang === "en";
  const r = latestCloseoutFor(ws, campaignId, currentRepoKey(ws)); // 지금 정찰 대상 저장소의 기록만(다른 저장소 기록=없음)
  if (r.readError) return { ok: false, why: "unreadable", detail: en ? "the closeout record ledger could not be read (check the disk/permissions) — submit the record again" : "마감 기록 장부를 읽지 못했습니다(디스크·권한 확인) — 다시 제출하세요" };
  if (!r.row) return { ok: false, why: "missing", detail: "" };
  const at = Date.parse(r.row.ts);
  if (Number.isFinite(sinceTs) && sinceTs > 0 && !(at >= sinceTs)) return { ok: false, why: "stale", row: r.row, detail: en
    ? `files changed after the closeout record was submitted (${r.row.ts}) — re-judge the residual risk including the last edit and submit again`
    : `마감 기록 제출(${r.row.ts}) 뒤에 파일이 바뀌었습니다 — 마지막 수정까지 반영해 잔여 위험 판단을 다시 하고 다시 제출하세요` };
  const rs = closeoutRepoState(ws), saved = r.row.repoState || null;
  if (!rs.ok) return { ok: false, why: "repo-unreadable", row: r.row, detail: en ? "the repository state (last commit and changed-file list) could not be read — check git and submit again" : "저장소 상태(마지막 커밋·바뀐 파일 목록)를 읽지 못했습니다 — git 상태를 확인하고 다시 제출하세요" };
  if (!saved || saved.head !== rs.head || saved.statusFp !== rs.statusFp) return { ok: false, why: "stale", row: r.row, detail: en
    ? `the repository changed after the closeout record was submitted (${r.row.ts}) — a commit, a revert, or a changed-file list differs; re-judge the residual risk and submit again`
    : `마감 기록 제출(${r.row.ts}) 뒤에 저장소 상태가 바뀌었습니다(커밋·되돌리기·바뀐 파일 목록 변화) — 잔여 위험 판단을 다시 하고 다시 제출하세요` };
  const v = validateCapHandoff(r.row.text, context);
  if (!v.ok) return { ok: false, why: "revalidate", row: r.row, detail: (en
    ? "the submitted record no longer passes the check against the current state (the backlog, decision ledger, or last verification changed after submitting): "
    : "제출한 기록이 지금 상태로 다시 검사해 맞지 않습니다(제출 뒤 보관함·결정 장부·마지막 검증 결과가 바뀜): ") + (v.detail || (v.missing || []).join(", ")) };
  return { ok: true, why: "", row: r.row, lang: v.lang, needsUserDecision: !!v.needsUserDecision, decisionCount: Number(v.decisionCount) || 0, residualRisk: v.residualRisk, detail: "" };
}
// 화면 집계: 앞 세 절의 항목 줄 수(없음=0) — 검사기와 같은 절 경계
function closeoutLaneCounts(text) {
  const s = String(text || "");
  for (const schema of SCHEMAS) {
    const sp = splitCloseout(s, schema);
    if (!sp.ok) continue;
    const n = (i) => (isNone(schema, sp.bodies[i]) ? 0 : sp.bodies[i].split(/\r?\n/).filter((l) => /^\s*-\s*\S/.test(l)).length);
    return { accepted: n(0), rebutted: n(1), parked: n(2) };
  }
  return null;
}
// 화면 자료(읽기 전용): 장부 꼬리만 판독 · 현재 정찰 대상 저장소의 기록만(표식 없는 옛 행은 함께 — 결정 장부와 같은 규칙) · 최근 순
function closeoutView(ws) {
  const file = closeoutFileFor(ws);
  let raw = "", truncated = false, fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { readError: true, total: 0, items: [], truncated: false }; // 파일 자리에 폴더 등=판독 실패(빈 목록으로 줄이지 않음)
    const len = Math.min(st.size, CLOSEOUT_VIEW_TAIL);
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    let got = 0; while (got < len) { const n = fs.readSync(fd, buf, got, len - got, st.size - len + got); if (n <= 0) break; got += n; }
    if (got !== len) return { readError: true, total: 0, items: [], truncated: false };
    raw = buf.toString("utf8");
    if (st.size > len) { truncated = true; const nl = raw.indexOf("\n"); raw = nl >= 0 ? raw.slice(nl + 1) : ""; } // 잘린 첫 줄은 버린다
  } catch (e) { if (e && e.code === "ENOENT") return { readError: false, total: 0, items: [], truncated: false }; return { readError: true, total: 0, items: [], truncated: false }; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 무해 */ } } }
  let cur = ""; try { cur = repoKeyNow(ws) || ""; } catch { cur = ""; }
  const rows = closeoutRowsOf(raw, wsKeyFor(ws)).rows.filter((r) => !cur || !r.repoKey || r.repoKey === cur);
  const items = rows.slice(-CLOSEOUT_VIEW_MAX).reverse().map((r) => ({ id: r.id, ts: r.ts, host: r.host, round: r.round || null, residualRisk: r.residualRisk,
    needsUserDecision: !!r.needsUserDecision, decisionCount: Number(r.decisionCount) || 0, alertKind: String(r.alertKind || ""), verdict: r.verdict || null,
    counts: closeoutLaneCounts(r.text), text: r.text }));
  return { readError: false, total: rows.length, items, truncated };
}
module.exports = {
  roundFigureMismatch, validateCapHandoff, capHandoffInstruction, capHandoffContext, findingsFromAnswer, parseFindingEvidence, verdictFromAnswer, lastAssistantText, lastCodexAssistantText,
  CLOSEOUT_SCHEMA, CLOSEOUT_TEXT_MAX, CLOSEOUT_VIEW_MAX, closeoutFileFor, readCloseouts, latestCloseoutFor, closeoutTargetFor, closeoutContextFor, submitCloseout, stopCloseoutCheck, closeoutLaneCounts, closeoutView };
