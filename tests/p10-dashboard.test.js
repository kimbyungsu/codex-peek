"use strict";
/* P10 증분 3 — 3트랙 수집 경계와 한/영 운영 대시보드 계약. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MS = require(path.join(ROOT, "out", "map-stats.js"));
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const now = Date.parse("2026-07-26T02:00:00.000Z");
const ts = "2026-07-26T01:00:00.000Z";
const repoKey = "0123456789abcdef";
const runId = "11111111-1111-4111-8111-111111111111";
const mapId = "22222222-2222-4222-8222-222222222222";
const callId = "33333333-3333-4333-8333-333333333333";
const usage = {
  schema: "scout-usage-v2", ts, callId, scope: "project", repoKey, flow: "map-enrich", provider: "claude", model: "claude-local",
  tokenIn: null, tokenOut: null, charsIn: 120, charsOut: 45, runId, jobKey: null, jobRunId: null,
};
const start = {
  schema: "map-automation-v1", event: "enrich-start", ts, repoKey, runId, jobKey: null, jobRunId: null, mapId, mode: "self", trigger: "tick",
};

console.log("[1] 2트랙 수집 0호출과 actual repo 귀속");
const calls = { key: 0, usage: 0, automation: 0, lock: 0 };
const collectors = {
  repoKeyFor(repo) { calls.key++; calls.repo = repo; return repoKey; },
  readUsage() { calls.usage++; return JSON.stringify(usage); },
  readAutomation() { calls.automation++; return JSON.stringify(start); },
  observeRunLock(key) { calls.lock++; calls.lockKey = key; return { state: "alive", runId }; },
};
let state = MS.collectMapHistoryState(false, "D:/actual-repo", now, (s) => String(s).toLowerCase(), collectors);
ok(state === null && Object.values(calls).filter((v) => typeof v === "number").every((v) => v === 0), "2트랙은 키 계산·두 통계 파일·실행 잠금 모두 0호출");
state = MS.collectMapHistoryState(true, "D:/actual-repo", now, (s) => String(s).toLowerCase(), collectors);
ok(calls.repo === "D:/actual-repo" && calls.lockKey === repoKey && calls.key === 1 && calls.usage === 1 && calls.automation === 1 && calls.lock === 1, "3트랙은 실제 저장소 키로 각 자료를 정확히 한 번 수집");
ok(state.usage.byFlowProvider["map-enrich|claude"].calls === 1 && state.automation.runsByState.running === 1, "목적별 사용량과 살아 있는 같은 실행을 한 상태로 결합");

console.log("[2] 판독 실패 비차단과 정상 no-op 사유 분리");
const tolerant = MS.collectMapHistoryState(true, "D:/actual-repo", now, (s) => s, {
  repoKeyFor() { return repoKey; }, readUsage() { throw new Error("denied"); }, readAutomation() { throw new Error("denied"); }, observeRunLock() { throw new Error("denied"); },
});
ok(tolerant && tolerant.usage.coverage.validV2 === 0 && tolerant.automation.observedRuns === 0
  && tolerant.readStatus.usage === "unreadable" && tolerant.readStatus.automation === "unreadable", "통계 파일·잠금 판독 실패가 제품 상태 수집을 죽이지 않고 0건과 구분됨");
const missing = MS.collectMapHistoryState(true, "D:/actual-repo", now, (s) => s, {
  repoKeyFor() { return repoKey; }, readUsage() { const e = new Error("missing"); e.code = "ENOENT"; throw e; },
  readAutomation() { const e = new Error("missing"); e.code = "ENOENT"; throw e; }, observeRunLock() { return { state: "absent" }; },
});
ok(missing.readStatus.usage === "absent" && missing.readStatus.automation === "absent", "아직 원장이 없는 정상 0건은 판독 실패와 별도 상태");
const noop = {
  schema: "map-automation-v1", event: "enrich-job-terminal", ts, repoKey, runId,
  jobKey: "a".repeat(40), jobRunId: "b".repeat(40), mapId, mode: "self", trigger: "tick",
  outcome: "noop", reasonCode: "already-enriched", provider: "claude", baselineState: "current-job",
  everApplied: false, unresolvedBaseItems: 0, activeDeferredItems: 0, deferredState: "clear",
};
const folded = MS.computeMapAutomationStats(JSON.stringify(noop), now, repoKey, { state: "absent" });
ok(folded.jobsByState.noop === 1 && folded.noopByReason["already-enriched"] === 1 && folded.completion.denominator === 0, "정상 no-op은 완료율에서 빼고 사유별로 보존");

console.log("[3] 호스트 배선 — P8→P9→현재 지도→P10 이력, 2트랙 숨은 판독 차단");
const enrichAt = ext.indexOf("enrich: (() =>");
const intentAt = ext.indexOf("intent: (intentState = collectIntentState())");
const currentAt = ext.indexOf("mapCurrent: collectMapCurrent(intentState)");
const historyAt = ext.indexOf("mapAutomation: (mapHistoryState = collectMapHistory())");
ok(enrichAt >= 0 && intentAt > enrichAt && currentAt > intentAt && historyAt > currentAt, "기존 P8→P9 순서를 보존하고 현재 지도 뒤 P10 이력을 수집");
ok(/collectMapHistoryState\(contract\.scoutMode === "on", mapActualRepo/.test(ext) && /repoKeyForStats\(repo\)/.test(ext), "captured 3트랙 모드·actual repo·익명 저장소 키를 공용 수집기에 전달");
const actualStart = ext.indexOf("function scoutActualText");
const actualGuard = ext.indexOf('loadContract(ws).scoutMode !== "on"', actualStart);
const actualRead = ext.indexOf("readScoutCosts(ws)", actualStart);
ok(actualStart >= 0 && actualGuard > actualStart && actualRead > actualGuard, "기존 탐색자 시각도 2트랙에서 scout-usage 판독 전에 종료");
ok(!/scoutCosts:\s*readScoutCosts\(ws\)/.test(ext), "숨겨진 구형 비용 상태의 무조건 판독 제거");

console.log("[4] 3트랙 카드 5단계와 한/영 동일 의미");
[
  ["1. 현재 지도 상태", "1. Current map state"],
  ["2. 최근 자동 의미 보강", "2. Recent automatic semantic enrichment"],
  ["3. 현재 선택·복구 대기", "3. Current choices and recovery"],
  ["4. 목적별 외부 호출·사용량", "4. External calls and usage by purpose"],
  ["5. 자료 범위와 한계", "5. Data coverage and limits"],
].forEach(([ko, en]) => ok(ext.includes(ko) && ext.includes(en), ko + " — 한/영 문구"));
ok(ext.includes("근거 파일이 바뀌어 갱신 필요") && ext.includes("source files changed — refresh needed")
  && ext.includes("현재 확인할 자료 부족") && ext.includes("not enough evidence to check now")
  && ext.includes("검증 근거가 맞지 않아 임시 제외") && ext.includes("temporarily excluded because verification evidence does not match"), "최신성 세 상태를 단정 없이 한/영 동일 의미로 표현");
ok(ext.includes("종료 기록 없음은 실제 중단 확정이 아니라") && ext.includes("does not prove interruption"), "마지막 통계 누락을 중단으로 오인하지 않게 고지");
ok(ext.includes("판독 불가 — 0건으로 해석하지 않음") && ext.includes("unreadable — not interpreted as zero records"), "원장 판독 실패를 실제 0건과 구분해 한/영 표시");
ok(ext.includes("이번 판독에서는 현재 지도 상태를 확인할 수 없습니다.") && ext.includes("could not be determined in this read")
  && !ext.includes("잠금 경합이나 세대 변동으로 이번 판독에서는 확인할 수 없습니다."), "지도 error는 확인하지 못한 원인을 추측하지 않는 중립 안내");
ok(ext.includes("실제 토큰 확인 ") && ext.includes("real tokens available for ") && ext.includes("토큰 미제공 호출") && ext.includes("calls without tokens"), "실측 토큰 coverage와 토큰 미제공 글자 수를 분리");
ok(ext.includes("최근 28일") && ext.includes("60일 보존") && ext.includes("service bill") && ext.includes("서비스 청구서"), "28일 화면·60일 보존·청구서 아님 한계 고정");

console.log("[5] 검증 통계 무기록과 기존 관찰 신호 무회귀");
ok(/bodyEl\.style\.display=\(vs\.month\.total>0\|\|mapOn\)\?"block":"none"/.test(ext), "검증 기록 0건이어도 3트랙 운영 카드는 표시");
ok(/renderStats\(d\.verifyStats,!!\(d\.contract&&d\.contract\.scoutMode==="on"\)\)/.test(ext) && /renderMapOps\(d\)/.test(ext), "같은 상태 푸시에서 검증 통계와 P10 카드를 독립 렌더");
ok(ext.includes('id="scoutSignals"') && ext.includes('id="siProposed"') && ext.includes('id="siGuard"'), "기존 3트랙 관찰 신호 카드를 그대로 유지");
ok(/statsNoteNode\.insertAdjacentElement\("afterend",mapOpsNode\)/.test(ext), "렌더된 P10 묶음은 기존 검증 결과·토큰·프로필 뒤에 배치");

console.log("[6] 사용자 문서 — 저장 항목·귀속·기간·한계");
const privacy = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
const readmeKo = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const readmeEn = fs.readFileSync(path.join(ROOT, "docs", "README.en.md"), "utf8");
ok(/단방향 16자리 저장소 키/.test(privacy) && /프롬프트·응답·오류 전문은 저장하지/.test(privacy), "PRIVACY — 새 사용량 행은 원 경로·본문·오류 전문을 저장하지 않음");
ok(/시작·실행 종결·고유 작업 세대 종결/.test(privacy) && /“종료 기록 없음”/.test(privacy), "PRIVACY — 자동 실행 기록 종류와 중단 비단정");
ok(/화면은 28일만 집계/.test(readmeKo) && /2트랙에서는 카드뿐 아니라 두 통계 파일과 지도 판독도 실행하지/.test(readmeKo), "README ko — 기간과 2트랙 0판독");
ok(/screen covers 28 days, logs are kept for 60 days/.test(readmeEn) && /two statistics logs and Project MAP reader are not read/.test(readmeEn), "README en — 같은 기간과 2트랙 0판독");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
