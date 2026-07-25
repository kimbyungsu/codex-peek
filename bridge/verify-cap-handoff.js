"use strict";

const fs = require("fs");
const path = require("path");
const { extractVerdict, askJobIdOk, readBacklog, normBacklogTitle } = require("./contract-lib.js");

// 검증 상한은 검증 호출만 멈춘다. 마지막 검증 지적은 구현자가 먼저 네 갈래로 재판단한다.
// 처리·반박·보관함 항목은 사용자에게 결정을 떠넘기지 않고, 실제 제품 선택만 한 번에 올린다.
const SCHEMAS = [
  {
    lang: "ko",
    head: "[검증 상한 인계]",
    sections: ["[수용·처리]", "[반박·종결]", "[보관함 이관]", "[사용자 판단 필요]", "[경고등 의미]", "[권장]"],
    none: /^(?:없음|해당 없음)(?:[.!。]|\s)*$/i,
  },
  {
    lang: "en",
    head: "[Verification cap closeout]",
    sections: ["[Accepted and handled]", "[Rebutted and closed]", "[Parked]", "[User decision required]", "[Alert meaning]", "[Recommendation]"],
    none: /^(?:none|not applicable)(?:[.!]|\s)*$/i,
  },
];

const ECHO_MARKERS = {
  ko: ["각 근거는 아래 네 절", "수용은 실제로 끝낸", "반박은 측정·재현", "보관함 이관은 먼저", "사용자 판단은 구현자가", "질문을 여러 개로 쪼개지"],
  en: ["put each evidence item in exactly one", "accepted means the work is already done", "a rebuttal needs measured", "parked items require a real", "use user decision required only", "do not split this into several questions"],
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

function verdictFromAnswer(answer) {
  const text = String(answer || "");
  // formatForClaude가 원 선언과 기계 실효 판정을 함께 싣는 경우 대시보드와 같은 실효 판정이 권위다.
  if (/Machine reading:.*verdict demoted to ['"]inconclusive['"]/i.test(text)
      || /기계 판독:.*판정을 ['"]보류['"]로 강등/i.test(text)) return "inconclusive";
  const direct = extractVerdict(text);
  if (direct) return direct;
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:Codex 선언|Codex declared)\s*:\s*(.*)$/i.exec(line.trim());
    if (!m) continue;
    const v = extractVerdict(m[1]);
    if (v) found = v;
  }
  return found;
}

const MAX_CONTEXT_FINDINGS = 64;
function parseFindingEvidence(answer, round) {
  const lines = String(answer || "").split(/\r?\n/);
  let start = -1, end = -1;
  for (const pair of [["[지적 목록 v2]", "[지적 목록 끝]"], ["[findings v2]", "[findings end]"], ["[지적 목록 v1]", "[지적 목록 끝]"], ["[findings v1]", "[findings end]"]]) {
    const s = lines.lastIndexOf(pair[0]);
    if (s < 0) continue;
    const e = lines.indexOf(pair[1], s + 1);
    if (e > s) { start = s; end = e; break; }
  }
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
  } catch { return { evidence: [], alertKind: "verify-handoff-missing", source: "unavailable", unavailable: true, backlogItems, backlogHealthy }; }
  jobs.sort((a, b) => (Number(a.job.verifyRound) || 0) - (Number(b.job.verifyRound) || 0)
    || Date.parse(a.job.finishedAt || a.job.startedAt || 0) - Date.parse(b.job.finishedAt || b.job.startedAt || 0));
  const rec = jobs[jobs.length - 1];
  if (!rec || !askJobIdOk(rec.fileId) || rec.job.id !== rec.fileId) {
    return { evidence: [], alertKind: "verify-handoff-missing", source: rec ? rec.fileId : "unavailable", unavailable: true, backlogItems, backlogHealthy };
  }
  let answer = "";
  try { answer = fs.readFileSync(path.join(dir, rec.fileId + ".out"), "utf8"); }
  catch { return { evidence: [], alertKind: "verify-handoff-missing", source: rec.fileId, unavailable: true, backlogItems, backlogHealthy }; }
  const verdict = verdictFromAnswer(answer);
  const alertKind = verdict === "fail" || verdict === "inconclusive" ? "verdict-nonclean" : "verify-handoff-missing";
  const parsed = parseFindingEvidence(answer, rec.job.verifyRound);
  if (!parsed.ok || !parsed.evidence.length) return { evidence: [], alertKind, source: rec.fileId, unavailable: true, backlogItems, backlogHealthy };
  return { evidence: parsed.evidence, alertKind, source: rec.fileId, unavailable: false, backlogItems, backlogHealthy };
}

function requiredEvidence(context) {
  const evidence = context && Array.isArray(context.evidence) ? context.evidence : [];
  return evidence.length ? evidence : (context && context.unavailable ? [{ key: "EVIDENCE-UNAVAILABLE", title: "" }] : []);
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
function categoryLines(schema, rawBodies, context) {
  const required = requiredEvidence(context);
  const allowed = new Set(required.map((e) => String(e.key).toLowerCase()));
  const byKey = new Map(required.map((e) => [String(e.key).toLowerCase(), e]));
  const seen = new Set();
  for (let lane = 0; lane < 4; lane++) {
    const raw = String(rawBodies[lane] || "").trim();
    if (isNone(schema, raw)) continue;
    const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return false;
    for (const line of lines) {
      const m = /^-\s*(EVIDENCE-UNAVAILABLE|R\d+-F\d+)\b/i.exec(line);
      if (!m) return false;
      const key = m[1].toLowerCase();
      if ((allowed.size && !allowed.has(key)) || seen.has(key)) return false;
      seen.add(key);
      const evidence = byKey.get(key);
      if (evidence && evidence.title && countNeedle(line, evidence.title) !== 1) return false;
      if (context && context.unavailable && key === "evidence-unavailable" && lane !== 3) return false;
      if (lane === 0) {
        const f = schema.lang === "en" ? /\bChange\s*:\s*(.+?)\s*;\s*Check\s*:\s*(.+?)\s*;\s*Evidence\s*:\s*(.+)$/i.exec(line) : /변경\s*:\s*(.+?)\s*;\s*확인\s*:\s*(.+?)\s*;\s*근거\s*:\s*(.+)$/i.exec(line);
        if (!f || !machineEvidence(f[1]) || !machineEvidence(f[2]) || !machineEvidence(f[3])) return false;
      } else if (lane === 1) {
        const f = schema.lang === "en" ? /\bObservation\s*:\s*(.+?)\s*;\s*Reason\s*:\s*(.+?)\s*;\s*Evidence\s*:\s*(.+)$/i.exec(line) : /관측\s*:\s*(.+?)\s*;\s*이유\s*:\s*(.+?)\s*;\s*근거\s*:\s*(.+)$/i.exec(line);
        if (!f || !machineEvidence(f[1]) || !machineEvidence(f[2]) || !machineEvidence(f[3])) return false;
      } else if (lane === 2 && context) {
        if (!context.backlogHealthy) return false;
        const idm = /\b[a-f0-9]{16}\b/i.exec(line);
        const item = idm && Array.isArray(context.backlogItems)
          ? context.backlogItems.find((x) => String(x.id).toLowerCase() === idm[0].toLowerCase()) : null;
        if (!item || !evidence || normBacklogTitle(item.title).toLowerCase() !== normBacklogTitle(evidence.title).toLowerCase()) return false;
      }
    }
  }
  return !allowed.size || seen.size === allowed.size;
}

function meaningfulSections(schema, rawBodies, context) {
  if (!Array.isArray(rawBodies) || rawBodies.length !== 6) return null;
  const b = rawBodies.map(normBody), joined = b.join("\n").toLowerCase();
  const filler = /^(?:placeholder(?: content)?(?: here)?|lorem ipsum|tbd|todo|fill(?: this)?(?: in)?|내용(?:을)?\s*(?:입력|작성)|여기에\s*내용(?:을)?\s*(?:입력|작성))[.!?]*$/i;
  if (b.some((x) => !x || filler.test(x))) return null;
  if (ECHO_MARKERS[schema.lang].some((m) => joined.includes(m))) return null;
  if (!categoryLines(schema, rawBodies, context)) return null;

  const accepted = !isNone(schema, b[0]);
  const rebutted = !isNone(schema, b[1]);
  const parked = !isNone(schema, b[2]);
  const needsUserDecision = !isNone(schema, b[3]);
  if (schema.lang === "en") {
    if (accepted && !(b[0].length >= 28 && /fixed|implemented|changed|removed|completed|handled|tested|confirmed|evidence/i.test(b[0]))) return null;
    if (rebutted && !(b[1].length >= 36 && /because|reason|rebut|counterexample|measured|reproduced|test|evidence|observed/i.test(b[1]))) return null;
    if (parked && !(b[2].length >= 30 && /\b[a-f0-9]{16}\b/i.test(b[2]) && /receipt|park|backlog|caution/i.test(b[2]))) return null;
    if (needsUserDecision && (!(b[3].length >= 60 && /target\s*:/i.test(b[3]) && /scenario\s*:/i.test(b[3]) && /risk\s*:/i.test(b[3]) && /option\s*1\s*:/i.test(b[3]) && /option\s*2\s*:/i.test(b[3]))
      || /target\s*:\s*(?:(?:a|an|the|this|that|some)\s+)?(?:problem|issue|finding|situation|something|risk)\b/i.test(b[3]))) return null;
    if (!/alert|red|yellow/i.test(b[4]) || !/pass|certif|clear|remain|ignore|acknowledge|later/i.test(b[4])) return null;
    if (b[5].length < 20 || !/recommend|recommended|because|reason|therefore|no user decision/i.test(b[5])) return null;
  } else {
    if (accepted && !(b[0].length >= 20 && /수정|구현|변경|제거|완료|처리|시험|테스트|확인|근거/i.test(b[0]))) return null;
    if (rebutted && !(b[1].length >= 24 && /때문|이유|반박|반례|측정|재현|시험|테스트|근거|확인/i.test(b[1]))) return null;
    if (parked && !(b[2].length >= 22 && /\b[a-f0-9]{16}\b/i.test(b[2]) && /영수증|보관함|백로그|주의|이관/i.test(b[2]))) return null;
    if (needsUserDecision && (!(b[3].length >= 45 && /대상\s*:/i.test(b[3]) && /상황\s*:/i.test(b[3]) && /위험\s*:/i.test(b[3]) && /선택\s*1\s*:/i.test(b[3]) && /선택\s*2\s*:/i.test(b[3]))
      || /대상\s*:\s*(?:(?:해당|위|이|그|어떤)\s*)?(?:문제|지적|상황|위험|무언가)(?:\s|[.,;]|$)/i.test(b[3]))) return null;
    if (!/경고|빨강|노랑/i.test(b[4]) || !/통과|인증|해소|남|무시|확인|나중/i.test(b[4])) return null;
    if (b[5].length < 16 || !/권장|추천|때문|이유|따라서|사용자 판단 없/i.test(b[5])) return null;
  }
  if (context && context.alertKind && !b[4].toLowerCase().includes(String(context.alertKind).toLowerCase())) return null;
  return { needsUserDecision, decisionCount: needsUserDecision ? 1 : 0 };
}

function validateCapHandoff(text, context) {
  const s = String(text || "");
  for (const schema of SCHEMAS) {
    const headAt = s.lastIndexOf(schema.head);
    if (headAt < 0) continue;
    const candidate = s.slice(headAt);
    const marks = [schema.head, ...schema.sections];
    const at = marks.map((m) => candidate.indexOf(m));
    if (at.some((n) => n < 0) || at.some((n, i) => i > 0 && n <= at[i - 1])) continue;
    const bodies = [];
    for (let i = 1; i < marks.length; i++) {
      const start = at[i] + marks[i].length;
      const end = i + 1 < marks.length ? at[i + 1] : candidate.length;
      bodies.push(candidate.slice(start, end).trim());
    }
    const result = meaningfulSections(schema, bodies, context);
    if (result) return { ok: true, lang: schema.lang, missing: [], ...result };
  }
  return { ok: false, lang: null, missing: ["cap-closeout-sections"], needsUserDecision: false, decisionCount: 0 };
}

function capHandoffInstruction(lang, round, verdict, context) {
  const ctx = context && typeof context === "object" ? context : { evidence: [], alertKind: "verify-handoff-missing", source: "unavailable", unavailable: true };
  const evidenceLines = Array.isArray(ctx.evidence) ? ctx.evidence.map((e) => `- ${e.key} ${e.title}`) : [];
  if (ctx.unavailable || !evidenceLines.length) evidenceLines.push("- EVIDENCE-UNAVAILABLE (the latest verification findings could not be read completely)");
  const evidence = evidenceLines.join("\n");
  if (lang === "en") return `[Verify mode · actual round ${round}] The verification-call cap is exhausted and there is no pass proof (last verdict: ${verdict || "not-pass"}). Do not start another verification job. Re-judge only the latest findings below and write one closeout using the exact headings. Put each evidence item in exactly one of the first four sections. The Stop hook accepts the closeout only when every item has one destination.\nLatest evidence (${ctx.source || "unavailable"}):\n${evidence}\nExpected dashboard alert key: ${ctx.alertKind || "verify-handoff-missing"}\n\n[Verification cap closeout]\n[Accepted and handled]\nOne item per line: - <key> <exact title> — Change: <specific change containing a file, backticked identifier, test/setting key, or measured value>; Check: <specific result with one of those anchors>; Evidence: <one of those anchors again>. Every field needs its own anchor. Write None if empty.\n[Rebutted and closed]\nOne item per line: - <key> <exact title> — Observation: <counterexample with its own anchor>; Reason: <closing reason with its own anchor>; Evidence: <one anchor again>. Every field needs its own anchor. Write None if empty.\n[Parked]\nOne item per line. Park only after backlog add with the exact finding title; include that open item's real 16-hex receipt id. Write None if empty.\n[User decision required]\nOne item per line beginning with its key. Use this only for a real product-direction, risk-acceptance, or external choice that the implementer cannot decide. For each item give Target:, Scenario:, Risk:, then one combined Option 1: and Option 2:. EVIDENCE-UNAVAILABLE must go here. Write None if empty; do not invent a user question.\n[Alert meaning]\nInclude the expected alert key verbatim. Explain whether the remaining red/yellow alert needs user action and that this closeout is not a verification pass.\n[Recommendation]\nRecommend one next action, or explicitly say no user decision is needed. Do not split this into several questions.`;
  const evidenceKo = evidence.replace("(the latest verification findings could not be read completely)", "(마지막 검증 지적을 완전하게 읽지 못함)");
  return `[검증 모드 · 실제 회차 ${round}] 검증 호출 상한이 소진됐고 결속된 통과 증명이 없습니다(마지막 판정: ${verdict || "통과 아님"}). 새 검증 작업은 만들지 마세요. 아래 마지막 검증 지적만 다시 판단해 정확한 제목으로 마감문 하나를 쓰세요. 각 근거는 아래 네 절 중 정확히 한 곳에만 들어가야 하며, 모든 항목의 행선지가 정해져야 Stop 훅이 인정합니다.\n마지막 검증 근거(${ctx.source || "판독 불가"}):\n${evidenceKo}\n현재 대시보드 경고 키: ${ctx.alertKind || "verify-handoff-missing"}\n\n[검증 상한 인계]\n[수용·처리]\n한 항목을 한 줄로 씁니다: - <키> <정확한 제목> — 변경: <파일·백틱 식별자·시험/설정 키·측정값 중 하나를 포함한 구체 변경>; 확인: <그런 식별 근거를 자체 포함한 구체 결과>; 근거: <식별 근거 하나>. 세 칸 각각 자기 근거가 필요합니다. 없으면 없음.\n[반박·종결]\n한 항목을 한 줄로 씁니다: - <키> <정확한 제목> — 관측: <자기 식별 근거를 포함한 반례>; 이유: <자기 식별 근거를 포함한 종결 이유>; 근거: <식별 근거 하나>. 세 칸 각각 자기 근거가 필요합니다. 없으면 없음.\n[보관함 이관]\n한 항목을 한 줄로 씁니다. 정확한 지적 제목으로 backlog add를 먼저 실행하고 그 열린 항목의 실제 16자리 영수증 id를 씁니다. 없으면 없음.\n[사용자 판단 필요]\n각 항목을 키로 시작하는 한 줄로 씁니다. 구현자가 대신 정할 수 없는 제품 방향·위험 수용·외부 결정만 두고, 각 항목에 대상:, 상황:, 위험:을 쓴 뒤 전체를 묶은 선택 1:, 선택 2:를 제시하세요. EVIDENCE-UNAVAILABLE은 이 절에 둡니다. 없으면 없음이라고 쓰고 사용자 질문을 만들지 마세요.\n[경고등 의미]\n현재 경고 키를 그대로 포함하고, 남은 빨강·노랑에 사용자 행동이 필요한지와 이 마감이 검증 통과는 아니라는 점을 밝히세요.\n[권장]\n다음 행동 하나를 권장하거나 사용자 판단이 필요 없다고 명시하세요. 질문을 여러 개로 쪼개지 마세요.`;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => b && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
}

function claudeAssistantText(lines, lastUser) {
  const out = [];
  for (let i = Math.max(0, Number(lastUser) + 1); i < (lines || []).length; i++) {
    let o = null; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o && o.type === "assistant" && o.message) {
      const s = textOfContent(o.message.content).trim();
      if (s) out.push(s);
    }
  }
  return out.join("\n\n");
}

function injectedCodexUser(text) {
  const s = String(text || "").trim();
  return /^<(environment_context|user_instructions|system|recommended_plugins>|hook_prompt[\s>])/i.test(s) || s.startsWith("# AGENTS.md");
}

function codexAssistantText(file) {
  if (!file) return "";
  let lines = null; try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { return ""; }
  let out = [];
  for (const line of lines) {
    let o = null; try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== "response_item" || o.payload?.type !== "message") continue;
    const role = o.payload.role;
    const s = textOfContent(o.payload.content).trim();
    if (role === "user" && s && !injectedCodexUser(s)) { out = []; continue; }
    if (role === "assistant" && s) out.push(s);
  }
  return out.join("\n\n");
}

module.exports = { validateCapHandoff, capHandoffInstruction, capHandoffContext, findingsFromAnswer, parseFindingEvidence, verdictFromAnswer, claudeAssistantText, codexAssistantText };
