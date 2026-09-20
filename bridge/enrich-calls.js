"use strict";
/**
 * enrich-calls — 자동 보강 '호출 횟수·재시도 이력·인용 측정' 요약(순수 계산 · 관찰 전용).
 * 계획: docs/ENRICH-NEXT-AXES-PLAN-2026-09-20.md §3 (묶음 1 · 사용자 결정 D5).
 *
 * 권위 출처는 작업 장부(strict·잠금·fence 아래 기록) 하나다. 비용 장부(scout-usage)·경로 로그·실행 사건은 best-effort
 * (프로세스 기동만 기록·실패 삼킴·60일 정리)라 화면 수치의 재료로 쓰지 않는다. 요금은 각 서비스 명세서가 권위 — 여기서는
 * '요금'을 말하지 않고 '답을 받은 호출'·'호출 실패'·'불확실'만 센다.
 *
 * 시도 분류:
 *  - answered  : 담당의 답이 도착한 시도 = phase applying|done, 또는 failed 이면서 실패 단계가 response|validation|conversion
 *  - callFailed: failed 이면서 실패 단계가 call (답 없음 — 요금 발생 여부 불확실이라 '호출 실패'로만 표기)
 *  - uncertain : running 으로 남았거나(사망 창) 복구가 parked/uncertain-call 로 영속한 시도 — 재시도해도 배열에 남아 사라지지 않는다
 *  - legacyFailed: failed 인데 실패 단계가 없는 옛 기록(단계 미상)
 * 경제형(DeepSeek)은 어댑터 안 형식 교정으로 한 시도에 최대 2요청을 보낸다 — 시도 1로 세고 문구로 병기한다.
 *
 * 묶음 4(사용자 결정 D4 B + D4-2 ㄱ · docs/ENRICH-NEXT-AXES-PLAN-2026-09-20.md §4): 재호출 프롬프트에 '지난 시도가 버려진 이유'를 기계 분류로만
 * 동봉한다. priorRejectionFor(attempts)=새 시도 바로 앞 시도(attempts 의 마지막 원소)가 답 거부 단계(response|validation|conversion)로
 * 실패했을 때의 요약 — 경로(유료 담당 자동 재시도·기본형 재개 재호출·사용자 재시도) 무관하게 같은 장부 사실을 본다. retryFrom 은 보지 않는다.
 * 편집 중 충돌로 빠진 항목(detail.fileChanged===true)은 담당 잘못이 아니라 요약에서 뺀다(전부 그런 경우 요약 없음). 파일 본문·모델 자유문(인용 원문)은
 * 싣지 않는다 — 단계·코드·항목 색인·op·종류(닫힌 어휘)와 형태/id/상한 단계의 검증기 문구(기계 문장)만.
 */
const PROVIDER_LABEL = { self: "claude", economy: "deepseek", precision: "codex" };
const ANSWER_STAGES = ["response", "validation", "conversion"];
const FAILURE_CODES_CLOSED = ["process-failed", "empty-output", "parse-invalid", "schema-invalid", "evidence-mismatch", "evidence-unreadable", "evidence-outside-excerpt", "convert-invalid"]; // map-enrich FAILURE_CODES 와 동형(strict 장부가 이미 이 열거만 승인)
// 실행기(map-enrich.js)의 자동 재시도 대상 사유와 동형이어야 한다 — tests/enrich-calls.test.js 가 소스 대조로 잠근다.
const AUTO_RETRY_REASONS = ["precision-failed", "economy-failed", "both-failed"];
// 사람 없이 이어지는 호출 규칙(소스가 그대로일 때 · 절대 상한 아님 — 호출 중 편집이 반복되면 source-changed 자기치유가 다시 부른다):
//  기본형=첫 거부 뒤 재개 경로 1회 더 → 2 · 정밀=라우터 1+자동 재시도 1 → 2 · 경제=2(시도당 최대 2요청) · 자동형=경제→정밀 승격 2+자동 재시도 2 → 4.
const UNATTENDED_CALL_RULE = Object.freeze({ self: 2, economy: 2, precision: 2, auto: 4, economyRequestsPerAttempt: 2 });

function emptyProviders() { return { claude: 0, deepseek: 0, codex: 0 }; }

// 제외 항목 한 건 → 기계 분류 {index, op, stage, kind, sent?, note?} — 모든 값이 닫힌 어휘다(검증 1판 blocker: 검증기 문구에는 모델이 보낸 op·미지 필드명 같은
// 원문이 보간돼 있어 그대로 옮기면 모델 자유문이 재호출 자료 절로 되돌아간다). op 는 허용 연산 열거 밖이면 "unknown-op", 단계·종류는 닫힌 목록 밖이면
// "other", note 는 형태/id/상한 단계의 검증기 문구를 '첫 여는 괄호 앞'(보간 값은 전부 괄호 안)까지 잘라 고정 문구 목록에 있을 때만 싣고 그 밖은 "기타".
// 근거·변환 단계는 경로·인용을 싣지 않는다.
const DROP_NOTE_STAGES = ["shape", "id", "cap"];
const DROP_STAGES_CLOSED = ["shape", "id", "evidence", "cap", "convert"]; // map-enrich DROP_STAGES 와 동형
const ENRICH_OPS_CLOSED = ["add_evidence", "set_state", "add_anchor", "add_edge", "rewrite_label", "add_node"]; // 출력 계약의 연산 열거
const DROP_KINDS_CLOSED = ["evidence-mismatch", "evidence-outside", "evidence-unreadable", "evidence-outside-excerpt", "convert-invalid", "schema-invalid", "parse-invalid"]; // 근거·변환 단계의 종류(FAILURE_CODES·detail.kind 어휘)
// 형태/id/상한 단계 검증기의 고정 문구(보간 부분을 뺀 머리) — map-enrich itemShapeError·validateEnrichResult 의 문장과 동형. 목록 밖=기타(새 문구가 생겨도 원문이 새지 않는다).
const SHAPE_NOTES_CLOSED = ["이형", "미지 op", "미지 필드", "evidence[{file,quote}] 필수", "payload 필수", "payload 잉여 키", "targetId 필수", "payload 미지 필드", "payload.edge 필수", "payload.node 필수",
  "add_node: node 스키마 위반", "add_node: entityType=file만 허용", "add_node: anchors는 정확히 1개", "add_node: anchor.kind 불일치", "add_node: 코드 계열 파일만", "add_node: confidence=candidate 강제", "claims strict 위반",
  "targetId 미실존", "edge.from 미실존", "edge.to 미실존", "add_node: 임시 id가 기존 topology id와 충돌", "add_node: 임시 id가 이번 결과 안에서 중복", "add_node: 같은 파일의 file 노드 기존재",
  "add_node: anchor가 이번 발췌에 없음", "add_node: anchor 판독 불가·빈 본문", "add_node: anchor 판독 검사 실패", "add_node 라운드 상한 초과", "file 노드 전체 상한 초과"];
const closedOr = (v, list, fallback) => (list.includes(v) ? v : fallback);
function fixedNoteOf(reason) {
  const head = String(reason || "").split("(")[0].trim(); // 보간 값(모델 op·필드명·id·수치)은 전부 첫 여는 괄호 뒤에 있다
  return SHAPE_NOTES_CLOSED.includes(head) ? head : "기타";
}
function classifyDrop(d) {
  if (!d || typeof d !== "object") return null;
  const stage = closedOr(String(d.stage || ""), DROP_STAGES_CLOSED, "other");
  const out = { index: Number.isInteger(d.index) ? d.index : -1, op: closedOr(String(d.op || ""), ENRICH_OPS_CLOSED, "unknown-op"), stage, kind: stage };
  const det = d.detail && typeof d.detail === "object" ? d.detail : null;
  if (stage === "evidence") {
    out.kind = closedOr(det && typeof det.kind === "string" ? det.kind : String(d.reason || "").split(":")[0].trim(), DROP_KINDS_CLOSED, "other");
    if (det && typeof det.sent === "boolean") out.sent = det.sent;
  } else if (stage === "convert") {
    out.kind = closedOr(String(d.reason || "").split(":")[0].trim(), DROP_KINDS_CLOSED, "other");
  } else if (DROP_NOTE_STAGES.includes(stage)) {
    out.note = fixedNoteOf(d.reason);
  }
  return out;
}
// 새 시도 바로 앞 시도의 답 거부 요약(없으면 null). attempts=작업 장부의 attempts 배열(새 시도 생성 직전 상태).
function priorRejectionFor(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const last = list.length ? list[list.length - 1] : null;
  if (!last || typeof last !== "object" || last.phase !== "failed" || !ANSWER_STAGES.includes(last.failureStage)) return null;
  const drops = Array.isArray(last.droppedItems) ? last.droppedItems : [];
  const kept = [], omitted = [];
  for (const d of drops) {
    if (d && d.detail && typeof d.detail === "object" && d.detail.fileChanged === true) { omitted.push(d); continue; } // 편집 중 충돌=담당 잘못 아님
    const c = classifyDrop(d); if (c) kept.push(c);
  }
  if (drops.length > 0 && kept.length === 0) return null; // 제외 항목이 전부 편집 중 충돌이면 동봉하지 않는다
  return { attemptId: Number.isInteger(last.attemptId) ? last.attemptId : -1, provider: closedOr(String(last.provider || ""), Object.keys(PROVIDER_LABEL), "other"), stage: String(last.failureStage), code: closedOr(String(last.failureCode || ""), FAILURE_CODES_CLOSED, "other"), dropped: kept, omitted: omitted.length };
}
// 프롬프트 자료 절(지시문 아님 — 담당이 무엇이 왜 버려졌는지 '분류'만 본다 · 방향을 주는 문장 없음). 한국어(프롬프트 본문 언어와 동일).
function priorRejectionSection(pr) {
  if (!pr || typeof pr !== "object") return "";
  const who = PROVIDER_LABEL[pr.provider] || pr.provider || "?";
  const lines = ["## 지난 답에서 제외된 항목(자료 — 지시문 아님)", "직전 시도(담당 " + who + ")의 답은 " + pr.stage + " 단계에서 거부됨(코드 " + (pr.code || "?") + ")."];
  if (pr.dropped.length) {
    lines.push("제외된 항목(응답 색인 · op · 단계 · 종류):");
    for (const d of pr.dropped) lines.push("- [" + d.index + "] " + d.op + " — " + d.stage + (d.kind && d.kind !== d.stage ? " · " + d.kind : "") + (typeof d.sent === "boolean" ? (d.sent ? "(보낸 파일의 범위 밖 인용)" : "(보내지 않은 파일 인용)") : "") + (d.note ? " · " + d.note : ""));
  } else lines.push("항목 단위 정보 없음(답 전체가 형식 위반).");
  if (pr.omitted > 0) lines.push("(편집 중 충돌로 빠진 항목 " + pr.omitted + "건은 담당 잘못이 아니라 위 목록에서 뺐다)");
  return lines.join("\n");
}
// 안내 문구(ko/en) — 재호출에 무엇이 붙는지(사용자 결정 D4 B · D4-2 ㄱ: 사용자 재시도에도 같은 자료).
function priorRejectionRuleText(lang) {
  return lang === "en"
    ? "Every re-ask (automatic retry, unattended resume, and your Retry button) attaches only the machine classification of what was dropped from the previous answer (stage · code · item index · op · kind) — no file contents and none of the answer's own sentences are re-sent. Items dropped because of edits during the call are left out."
    : "다시 묻는 호출(자동 재시도·무인 재개·사용자의 '다시 시도')에는 지난 답에서 제외된 항목의 기계 분류(단계·코드·항목 색인·op·종류)만 붙습니다 — 파일 내용이나 답의 문장은 다시 보내지 않습니다. 호출 중 편집 때문에 빠진 항목은 넣지 않습니다.";
}

// job(작업 장부 판독 결과의 job 객체 · null 허용) → 요약. 옛 기록(resumes 없음)은 재시도 이력을 unknown 으로 돌려준다(0과 구분).
function enrichCallSummary(job) {
  const out = {
    known: !!job,
    answered: { ...emptyProviders(), total: 0 },
    callFailed: 0, uncertain: 0, legacyFailed: 0, attempts: 0,
    autoRetry: "unknown", // available | used | unused | n/a | unknown
    userRetries: 0, sourceChangedResumes: 0, otherResumes: 0, resumesKnown: false, resumesCoverage: "none", // complete=처음부터 기록 · partial=이전 판 구간 미상(legacy-unknown 표식) · none=기록 없음(옛 작업)
    citation: null,
    priorAttached: 0, // 묶음 4: 지난 답의 제외 이유를 붙여 다시 물은 시도 수(시도 기록 priorAttached=true)
  };
  if (!job || typeof job !== "object") return out;
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  out.attempts = attempts.length;
  for (const a of attempts) {
    if (!a || typeof a !== "object") continue;
    const lbl = PROVIDER_LABEL[a.provider] || null;
    if (a.priorAttached === true) out.priorAttached++;
    if (a.phase === "applying" || a.phase === "done" || (a.phase === "failed" && ANSWER_STAGES.includes(a.failureStage))) {
      out.answered.total++; if (lbl) out.answered[lbl]++;
    } else if (a.phase === "failed" && a.failureStage === "call") out.callFailed++;
    else if (a.phase === "running" || (a.phase === "parked" && a.parkedReason === "uncertain-call")) out.uncertain++;
    else if (a.phase === "failed") out.legacyFailed++;
  }
  const last = attempts.length ? attempts[attempts.length - 1] : null;
  const resumes = Array.isArray(job.resumes) ? job.resumes : null;
  out.resumesKnown = resumes !== null;
  if (resumes) {
    out.resumesCoverage = resumes.some((r) => r && r.kind === "legacy-unknown") ? "partial" : "complete";
    for (const r of resumes) {
      if (!r || typeof r !== "object") continue;
      if (r.kind === "manual") out.userRetries++;
      else if (r.kind === "source-changed") out.sourceChangedResumes++;
      else if (r.kind === "input-doc-only" || r.kind === "not-ready") out.otherResumes++;
    }
  }
  if (job.phase === "parked") {
    const answerRejected = !!last && last.phase === "failed" && ANSWER_STAGES.includes(last.failureStage);
    if (AUTO_RETRY_REASONS.includes(String(job.parkedReason || "")) && answerRejected) out.autoRetry = Number.isInteger(job.retryFrom) ? "used" : "available";
    else out.autoRetry = "n/a";
  } else if (resumes) {
    // 부분 이력(이전 판 구간 미상)에서 기록된 자동 재시도가 없다고 '없었음'을 확정하지 않는다(확인 검증 blocker) — 기록이 있으면 used, 없으면 unknown.
    if (resumes.some((r) => r && r.kind === "auto-retry")) out.autoRetry = "used";
    else out.autoRetry = out.resumesCoverage === "complete" ? "unused" : "unknown";
  } else out.autoRetry = "unknown";
  for (let i = attempts.length - 1; i >= 0; i--) { const c = attempts[i] && attempts[i].citation; if (c && typeof c === "object") { out.citation = { ...c }; break; } } // 마지막 "답"의 인용(뒤에 답 없는 시도가 있어도 사라지지 않음)
  return out;
}

// 화면 문구(ko/en) — 카드 한 줄. 숫자는 요약에서만, 상한·요금은 적지 않는다.
function callSummaryText(sum, lang) {
  const en = lang === "en";
  if (!sum || !sum.known) return "";
  const parts = [];
  const byP = [];
  if (sum.answered.codex) byP.push("Codex " + sum.answered.codex);
  if (sum.answered.deepseek) byP.push("DeepSeek " + sum.answered.deepseek);
  if (sum.answered.claude) byP.push("Claude " + sum.answered.claude);
  parts.push((en ? "answered calls " : "답 받은 호출 ") + sum.answered.total + (en ? "" : "회") + (byP.length ? " (" + byP.join(" · ") + ")" : ""));
  if (sum.callFailed) parts.push((en ? "failed calls " : "호출 실패 ") + sum.callFailed + (en ? "" : "회"));
  if (sum.uncertain) parts.push((en ? "uncertain " : "불확실 ") + sum.uncertain + (en ? "" : "회"));
  if (sum.legacyFailed) parts.push((en ? "stage unknown " : "단계 미상 실패 ") + sum.legacyFailed + (en ? "" : "회"));
  const partial = sum.resumesKnown && sum.resumesCoverage === "partial";
  if (partial) parts.push(en ? "earlier retries unknown (older record) · since then:" : "이전 판 구간 재시도 미상 · 그 뒤:"); // 미상 안내가 뒤따르는 집계 전부를 한정한다
  const ar = { available: en ? "auto retry available" : "자동 재시도 남음", used: en ? "auto retry used" : "자동 재시도 사용됨", unused: en ? "auto retry not needed" : "자동 재시도 없었음", "n/a": en ? "auto retry n/a" : "자동 재시도 해당 없음",
    unknown: partial ? (en ? "auto retry unknown" : "자동 재시도 여부 미상") : (en ? "retry history unknown (older record)" : "재시도 이력 없음(이전 판 기록)") };
  parts.push(ar[sum.autoRetry] || ar.unknown);
  if (sum.resumesKnown) {
    if (sum.userRetries) parts.push((en ? "user retries " : "사용자 재시도 ") + sum.userRetries + (en ? "" : "회"));
    if (sum.sourceChangedResumes) parts.push((en ? "re-asked after edits " : "편집 중 충돌로 다시 ") + sum.sourceChangedResumes + (en ? "" : "회"));
    if (sum.otherResumes) parts.push((en ? "auto resumes " : "자동 재개 ") + sum.otherResumes + (en ? "" : "회"));
  }
  if (sum.priorAttached) parts.push((en ? "re-asked with prior exclusion reasons " : "지난 제외 이유 붙여 다시 물음 ") + sum.priorAttached + (en ? "" : "회"));
  return (en ? "This job: " : "이번 작업: ") + parts.join(" · ");
}
function citationText(sum, lang) {
  const en = lang === "en";
  const c = sum && sum.citation;
  if (!c) return "";
  return en
    ? "Last answer: " + c.total + " citation(s), " + c.inExcerpt + " inside the sent excerpts · cited files " + c.filesCited + " / sent " + c.filesSent
    : "마지막 답: 인용 " + c.total + "건 중 보낸 발췌 안 " + c.inExcerpt + "건 · 인용 파일 " + c.filesCited + " / 보낸 파일 " + c.filesSent;
}
// 안내 문구용 규칙(숫자는 상수에서) — "소스가 그대로면 사람 없이 …까지, 호출 중 편집이 있으면 그때마다 다시"
function unattendedRuleText(lang) {
  const r = UNATTENDED_CALL_RULE;
  return lang === "en"
    ? "While the source stays unchanged, unattended calls stop at: Default " + r.self + " · Precision " + r.precision + " · Economy " + r.economy + " attempts (up to " + r.economyRequestsPerAttempt + " requests each) · Auto " + r.auto + ". If files are edited during a call, it asks again after the edit settles."
    : "소스가 그대로면 사람 없이 이어지는 호출은 기본형 " + r.self + "회 · 정밀형 " + r.precision + "회 · 경제형 " + r.economy + "회(시도당 최대 " + r.economyRequestsPerAttempt + "요청) · 자동형 " + r.auto + "회까지입니다. 호출 중에 파일을 고치면 편집이 멎은 뒤 그때마다 다시 묻습니다.";
}

module.exports = { enrichCallSummary, callSummaryText, citationText, unattendedRuleText, priorRejectionFor, priorRejectionSection, priorRejectionRuleText, classifyDrop, fixedNoteOf, DROP_NOTE_STAGES, DROP_STAGES_CLOSED, ENRICH_OPS_CLOSED, DROP_KINDS_CLOSED, SHAPE_NOTES_CLOSED, FAILURE_CODES_CLOSED, UNATTENDED_CALL_RULE, AUTO_RETRY_REASONS, ANSWER_STAGES, PROVIDER_LABEL };
