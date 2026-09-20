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
 */
const PROVIDER_LABEL = { self: "claude", economy: "deepseek", precision: "codex" };
const ANSWER_STAGES = ["response", "validation", "conversion"];
// 실행기(map-enrich.js)의 자동 재시도 대상 사유와 동형이어야 한다 — tests/enrich-calls.test.js 가 소스 대조로 잠근다.
const AUTO_RETRY_REASONS = ["precision-failed", "economy-failed", "both-failed"];
// 사람 없이 이어지는 호출 규칙(소스가 그대로일 때 · 절대 상한 아님 — 호출 중 편집이 반복되면 source-changed 자기치유가 다시 부른다):
//  기본형=첫 거부 뒤 재개 경로 1회 더 → 2 · 정밀=라우터 1+자동 재시도 1 → 2 · 경제=2(시도당 최대 2요청) · 자동형=경제→정밀 승격 2+자동 재시도 2 → 4.
const UNATTENDED_CALL_RULE = Object.freeze({ self: 2, economy: 2, precision: 2, auto: 4, economyRequestsPerAttempt: 2 });

function emptyProviders() { return { claude: 0, deepseek: 0, codex: 0 }; }

// job(작업 장부 판독 결과의 job 객체 · null 허용) → 요약. 옛 기록(resumes 없음)은 재시도 이력을 unknown 으로 돌려준다(0과 구분).
function enrichCallSummary(job) {
  const out = {
    known: !!job,
    answered: { ...emptyProviders(), total: 0 },
    callFailed: 0, uncertain: 0, legacyFailed: 0, attempts: 0,
    autoRetry: "unknown", // available | used | unused | n/a | unknown
    userRetries: 0, sourceChangedResumes: 0, otherResumes: 0, resumesKnown: false, resumesCoverage: "none", // complete=처음부터 기록 · partial=이전 판 구간 미상(legacy-unknown 표식) · none=기록 없음(옛 작업)
    citation: null,
  };
  if (!job || typeof job !== "object") return out;
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  out.attempts = attempts.length;
  for (const a of attempts) {
    if (!a || typeof a !== "object") continue;
    const lbl = PROVIDER_LABEL[a.provider] || null;
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

module.exports = { enrichCallSummary, callSummaryText, citationText, unattendedRuleText, UNATTENDED_CALL_RULE, AUTO_RETRY_REASONS, ANSWER_STAGES, PROVIDER_LABEL };
