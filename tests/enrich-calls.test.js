#!/usr/bin/env node
/**
 * enrich-calls — 호출 횟수·재시도 이력·인용 측정 요약(순수) + 실행기와의 동형 잠금 + 배포·화면 배선 소스 검사.
 * 계획: docs/ENRICH-NEXT-AXES-PLAN-2026-09-20.md §3 (묶음 1 · 관찰 전용).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const EC = require(path.join(ROOT, "bridge", "enrich-calls.js"));

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const att = (provider, phase, extra) => ({ attemptId: 0, provider, consentGen: 1, phase, startedAt: "T", ...(extra || {}) });

console.log("[1] 시도 분류 — 답 받은 호출·호출 실패·불확실·단계 미상");
{
  const job = { phase: "done", attempts: [
    { ...att("precision", "done"), attemptId: 0 },
    { ...att("economy", "failed", { failureStage: "validation" }), attemptId: 1 },
    { ...att("self", "failed", { failureStage: "call" }), attemptId: 2 },
    { ...att("precision", "parked", { parkedReason: "uncertain-call" }), attemptId: 3 },
    { ...att("economy", "running"), attemptId: 4 },
    { ...att("self", "failed", { failReason: "legacy" }), attemptId: 5 },
    { ...att("self", "applying"), attemptId: 6 },
  ], resumes: [] };
  const s = EC.enrichCallSummary(job);
  ok(s.known && s.attempts === 7, "입력 결속(attempts 7)");
  ok(s.answered.codex === 1 && s.answered.deepseek === 1 && s.answered.claude === 1 && s.answered.total === 3, "답 받은 호출=done·답 거부 실패·applying (담당별 " + JSON.stringify(s.answered) + ")");
  ok(s.callFailed === 1, "call 단계 실패=호출 실패");
  ok(s.uncertain === 2, "running 잔존+parked/uncertain-call=불확실 2(복구 뒤 영속 상태 포함)");
  ok(s.legacyFailed === 1, "단계 없는 옛 실패=단계 미상");
  ok(s.autoRetry === "unused" && s.resumesKnown === true && s.resumesCoverage === "complete", "보류 아님+재개 사건 있음(빈 배열)=자동 재시도 없었음·이력 완전");
  const sp = EC.enrichCallSummary({ phase: "done", attempts: [], resumes: [{ kind: "legacy-unknown", at: "T", fromAttempts: 0 }, { kind: "manual", at: "T", fromAttempts: 0 }] });
  ok(sp.resumesCoverage === "partial" && sp.userRetries === 1 && sp.autoRetry === "unknown" && /이전 판 구간 재시도 미상 · 그 뒤: · 자동 재시도 여부 미상 · 사용자 재시도 1회/.test(EC.callSummaryText(sp, "ko")), "옛 작업 재개=부분 이력(legacy-unknown 표식)·자동 재시도 미상(없었음 확정 금지)");
  ok(EC.enrichCallSummary({ phase: "done", attempts: [], resumes: [{ kind: "legacy-unknown", at: "T", fromAttempts: 0 }, { kind: "auto-retry", at: "T", fromAttempts: 0 }] }).autoRetry === "used", "부분 이력이라도 기록된 자동 재시도는 used");
  ok(EC.enrichCallSummary({ phase: "done", attempts: [] }).resumesCoverage === "none", "resumes 없음=none");
}

console.log("[2] 자동 재시도 상태 — 실행기 규칙과 동형(보류 중) · 재개 사건(완료 뒤)");
{
  const rejected = [att("precision", "failed", { failureStage: "validation" })];
  ok(EC.enrichCallSummary({ phase: "parked", parkedReason: "precision-failed", attempts: rejected }).autoRetry === "available", "정밀 실패+답 거부+retryFrom 없음=남음");
  ok(EC.enrichCallSummary({ phase: "parked", parkedReason: "precision-failed", retryFrom: 1, attempts: rejected }).autoRetry === "used", "retryFrom 있음=사용됨");
  ok(EC.enrichCallSummary({ phase: "parked", parkedReason: "precision-failed", attempts: [att("precision", "failed", { failureStage: "call" })] }).autoRetry === "n/a", "call 단계 실패=해당 없음(실행기와 동형)");
  ok(EC.enrichCallSummary({ phase: "parked", parkedReason: "self-failed", attempts: [att("self", "failed", { failureStage: "validation" })] }).autoRetry === "n/a", "self-failed=해당 없음(기본형은 재개 경로 — 실행기와 동형)");
  ok(EC.enrichCallSummary({ phase: "parked", parkedReason: "input-doc-only", attempts: rejected }).autoRetry === "n/a", "입력 사유 보류=해당 없음");
  ok(EC.enrichCallSummary({ phase: "done", attempts: rejected }).autoRetry === "unknown", "옛 기록(resumes 없음)=unknown");
  const s = EC.enrichCallSummary({ phase: "done", attempts: rejected, resumes: [
    { kind: "auto-retry", at: "T", fromAttempts: 1 }, { kind: "manual", at: "T", fromAttempts: 2 }, { kind: "manual", at: "T", fromAttempts: 3 },
    { kind: "source-changed", at: "T", fromAttempts: 3 }, { kind: "input-doc-only", at: "T", fromAttempts: 3 }, { kind: "not-ready", at: "T", fromAttempts: 3 } ] });
  ok(s.autoRetry === "used" && s.userRetries === 2 && s.sourceChangedResumes === 1 && s.otherResumes === 2, "재개 사건 집계(자동 1·수동 2·편집 충돌 1·기타 2)");
  const e0 = EC.enrichCallSummary(null);
  ok(e0.known === false && e0.answered.total === 0 && e0.autoRetry === "unknown" && e0.citation === null, "작업 없음=빈 요약(known false)");
}

console.log("[3] 문구 — ko/en · 요금·상한 미표기 · 인용 문구");
{
  const s = EC.enrichCallSummary({ phase: "done", attempts: [
    { ...att("precision", "done"), attemptId: 0, citation: { total: 3, inExcerpt: 2, outside: 1, filesCited: 2, filesSent: 5 } },
    { ...att("economy", "failed", { failureStage: "call" }), attemptId: 1 },
  ], resumes: [{ kind: "manual", at: "T", fromAttempts: 1 }, { kind: "source-changed", at: "T", fromAttempts: 2 }] });
  const ko = EC.callSummaryText(s, "ko"), en = EC.callSummaryText(s, "en");
  ok(/^이번 작업: 답 받은 호출 1회 \(Codex 1\) · 호출 실패 1회 · 자동 재시도 없었음 · 사용자 재시도 1회 · 편집 중 충돌로 다시 1회$/.test(ko), "ko 문구: " + ko);
  ok(/^This job: answered calls 1 \(Codex 1\) · failed calls 1 · auto retry not needed · user retries 1 · re-asked after edits 1$/.test(en), "en 문구: " + en);
  ok(!/요금|billing|최대|max/i.test(ko + en), "요금·상한 단어 없음");
  ok(EC.citationText(s, "ko") === "마지막 답: 인용 3건 중 보낸 발췌 안 2건 · 인용 파일 2 / 보낸 파일 5", "인용 문구 ko");
  ok(/Last answer: 3 citation\(s\), 2 inside the sent excerpts · cited files 2 \/ sent 5/.test(EC.citationText(s, "en")), "인용 문구 en");
  ok(EC.callSummaryText(EC.enrichCallSummary(null), "ko") === "" && EC.citationText(EC.enrichCallSummary({ phase: "open", attempts: [] }), "ko") === "", "작업·인용 없음=빈 문자열");
  const rule = EC.unattendedRuleText("ko");
  ok(/기본형 2회 · 정밀형 2회 · 경제형 2회\(시도당 최대 2요청\) · 자동형 4회까지/.test(rule) && /편집이 멎은 뒤 그때마다 다시/.test(rule), "안내 규칙 문구=상수에서 계산·절대 상한 아님 표기");
  ok(/Default 2 · Precision 2 · Economy 2 attempts \(up to 2 requests each\) · Auto 4/.test(EC.unattendedRuleText("en")), "안내 규칙 문구 en");
}

console.log("[4] 실행기와의 동형 잠금 + 배포 목록 3사본 + 화면 배선(소스 검사)");
{
  const me = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  const m = me.match(/const AUTO_RETRY_REASONS = \[([^\]]+)\]/);
  const runnerReasons = m ? m[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")) : [];
  ok(JSON.stringify(runnerReasons) === JSON.stringify(EC.AUTO_RETRY_REASONS), "자동 재시도 사유 목록=실행기와 동일(" + runnerReasons.join(",") + ")");
  ok(/const RESUME_KINDS = \["input-doc-only", "not-ready", "source-changed", "auto-retry", "manual", "legacy-unknown"\]/.test(me), "실행기 재개 종류 닫힌 열거 6종(legacy-unknown 포함)");
  ok(/resumes: \[\] \};/.test(me) && !/resumes\.length > 1000/.test(me), "신규 작업 resumes 초기화·길이 상한 없음");
  ok(/preBody\.set\(f, rb && rb\.ok \? rb\.body : null\)/.test(me) && /citationSummaryFor\(acceptedItems, \[\.\.\.preSha\.keys\(\)\], \(f\) => \(preBody\.has\(f\) \? preBody\.get\(f\) : null\)\)/.test(me) && /excerptBodies: preBody/.test(me), "인용 측정=호출 직전 발송 본문 스냅샷 대조·어댑터에도 같은 스냅샷 전달");
  const ep = fs.readFileSync(path.join(ROOT, "bridge", "enrich-providers.js"), "utf8");
  ok(/ctx\.excerptBodies instanceof Map/.test(ep) && /snap && snap\.has\(f\)/.test(ep), "프롬프트 조립이 스냅샷을 소비(없으면 같은 판독 규칙)");
  const kinds = ["input-doc-only", "not-ready", "source-changed", "auto-retry"];
  ok(kinds.every((k) => me.includes('reopenForRetry(jj, "' + k + '")')), "실행기 네 재개 경로가 공통 헬퍼(reopenForRetry)를 쓴다");
  ok(!/const nx = \{ \.\.\.jj, phase: "open", retryFrom: Array\.isArray\(jj\.attempts\)/.test(me), "옛 형태(retryFrom 만 이동) 잔존 0");
  const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");
  const hs = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8");
  const mc = fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8");
  ok(inst.includes('"enrich-calls.js"') && hs.includes('"enrich-calls.js"') && mc.includes('"enrich-calls.js"') && fs.existsSync(path.join(ROOT, "bridge", "enrich-calls.js")), "배포 목록 3사본(install.js·hook-setup.ts·map-cutover.js)+실물");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(ext.includes('ME9.reopenForRetry(jj, "manual")'), "확장 수동 재시도가 재개 사건(manual)을 남긴다");
  ok(ext.includes('require(path.join(BRIDGE_DIR, "enrich-calls.js"))') && ext.includes("EC9.callSummaryText(sum9, lang9)") && ext.includes("EC9.citationText(sum9, lang9)"), "현황 카드에 호출·인용 문구 배선");
  ok(ext.includes("en9.job.calls.line") && ext.includes("en9.job.calls.citation"), "웹뷰 상태 줄에 두 문구 표시");
  ok(ext.includes("EC9.unattendedRuleText(loadLangExt())") && ext.includes("Auto-enrich call counts"), "모드 안내 패널에 규칙 문구(상수 계산)");
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  ok(pkg.includes("node tests/enrich-calls.test.js"), "체인 등록");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
