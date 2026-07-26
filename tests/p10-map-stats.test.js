/* P10 증분 1 — strict 기록 계약·구형 호환·순수 run/job fold 반례. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "p10-stats-"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const MS = require(path.join(ROOT, "out", "map-stats.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const now = Date.now(), ts = new Date(now - 1000).toISOString(), future = new Date(now + 86400000).toISOString();
const repoKey = "0123456789abcdef", mapId = "123e4567-e89b-42d3-a456-426614174000";
const jobA = "a".repeat(40), genA = "b".repeat(40), genB = "c".repeat(40);
const run = () => crypto.randomUUID();
const usage = (over) => ({ schema: "scout-usage-v2", ts, callId: crypto.randomUUID(), scope: "project", repoKey, flow: "map-enrich", provider: "deepseek", model: null, tokenIn: 3, tokenOut: 4, charsIn: 20, charsOut: 10, runId: null, jobKey: null, jobRunId: null, ...(over || {}) });
const start = (runId, jobRunId, over) => ({ schema: "map-automation-v1", event: "enrich-start", ts, repoKey, runId, jobKey: jobRunId ? jobA : null, jobRunId: jobRunId || null, mapId, mode: "self", trigger: "tick", ...(over || {}) });
const runTerminal = (runId, outcome, over) => ({ schema: "map-automation-v1", event: "enrich-run-terminal", ts, repoKey, runId, mapId, mode: "self", trigger: "tick", outcome: outcome || "settled", reasonCode: outcome === "provider-failed" ? "provider-call-failed" : "none", provider: "claude", ...(over || {}) });
const jobTerminal = (runId, jobRunId, outcome, over) => ({ schema: "map-automation-v1", event: "enrich-job-terminal", ts, repoKey, runId, jobKey: jobA, jobRunId, mapId, mode: "self", trigger: "tick", outcome: outcome || "settled", reasonCode: "none", provider: "claude", baselineState: "current-job", everApplied: outcome === "applied", unresolvedBaseItems: 0, activeDeferredItems: 0, deferredState: "clear", ...(over || {}) });

console.log("[1] scout-usage-v2 writer — exact 키·잉여 제거·ID/열거·부분 token·미래 보존");
const withExtra = usage({ extraSecret: "저장 금지" });
ok(CL.appendScoutUsage(withExtra) === true, "writer는 유효 입력을 기록");
let stored = fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8").trim().split("\n").map(JSON.parse);
ok(Object.keys(stored[0]).length === 15 && !("extraSecret" in stored[0]), "잉여 필드는 저장하지 않고 정확히 15키");
ok(MS.isScoutUsageV2({ ...stored[0], surplus: 1 }) === false, "parser는 잉여 필드가 있는 새 행 거부");
ok(CL.appendScoutUsage(usage({ repoKey: "BAD" })) === false && CL.appendScoutUsage(usage({ repoKey: "ABCDEF0123456789" })) === false && CL.appendScoutUsage(usage({ flow: "mystery" })) === false && CL.appendScoutUsage(usage({ provider: "self" })) === false, "잘못되거나 대문자인 ID·flow·provider 닫힌 열거 거부");
ok(CL.appendScoutUsage(usage({ ts: "2026-02-31T00:00:00.000Z" })) === false && MS.isScoutUsageV2(usage({ ts: "2026/07/25 12:00:00" })) === false, "비존재 달력 날짜·비정규 ISO 시각 거부");
ok(CL.appendScoutUsage(usage({ tokenIn: 7, tokenOut: null })) === true, "부분 token 응답도 호출 행 자체는 보존");
stored = fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8").trim().split("\n").map(JSON.parse);
ok(stored.at(-1).tokenIn === null && stored.at(-1).tokenOut === null, "부분 token은 둘 다 null로 정규화");
ok(CL.appendScoutUsage(usage({ ts: future })) === true, "미래 시각 행 기록");
CL.trimScoutUsage(60);
ok(fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8").includes(future), "미래 시각은 trim에서 보존");

console.log("[2] map-automation-v1 writer — 사건별 exact 키와 null 행렬");
const r0 = run();
ok(CL.appendMapAutomation({ ...start(r0, genA), ignored: "drop" }) === true, "start writer는 잉여 필드 제거 후 기록");
ok(CL.appendMapAutomation(jobTerminal(r0, genA, "settled", { baselineState: "unavailable", everApplied: null, unresolvedBaseItems: null, activeDeferredItems: null, deferredState: "unknown" })) === true, "unavailable+unknown null 조합 허용");
ok(CL.appendMapAutomation(jobTerminal(r0, genA, "settled", { baselineState: "current-job", everApplied: true, unresolvedBaseItems: 1, activeDeferredItems: null, deferredState: "damaged" })) === true, "유효 기준선+damaged는 기초값 보존·active null 허용");
ok(CL.appendMapAutomation(jobTerminal(r0, genA, "settled", { baselineState: "unavailable", everApplied: false, unresolvedBaseItems: 0, activeDeferredItems: 0, deferredState: "clear" })) === false, "unavailable이 기초값·clear를 가장하는 null 위반 거부");
ok(CL.appendMapAutomation(start("bad-run", genA)) === false && CL.appendMapAutomation(start(r0, "B".repeat(40))) === false && CL.appendMapAutomation(runTerminal(r0, "settled", { outcome: "success" })) === false, "잘못되거나 대문자인 run/job ID·outcome 열거 거부");

console.log("[3] 사용량 순수 집계 — 목적/공급자 분리·구형 귀속·프로젝트 미상·미래 제외");
const uRaw = [
  usage({ callId: run(), flow: "map-enrich", provider: "deepseek" }),
  usage({ callId: run(), scope: "global", repoKey: null, flow: "readiness", provider: "codex", tokenIn: null, tokenOut: null }),
  { ts, workspace: "D:/repo", arm: "self", usageIn: null, usageOut: null, pkgChars: 9, mapChars: 3 },
  { ts, workspace: "", arm: "enrich", usageIn: 4, usageOut: 2 },
  usage({ ts: future, callId: run() }),
  { schema: "scout-usage-v2", ts, callId: run(), scope: "project", repoKey, flow: "map-enrich", provider: "deepseek", model: null, tokenIn: 1, tokenOut: null, charsIn: 1, charsOut: 1, runId: null, jobKey: null, jobRunId: null },
].map(JSON.stringify).join("\n");
const us = MS.computeMapUsageStats(uRaw, now, repoKey, "D:/repo", (s) => String(s).toLowerCase());
ok(us.byFlowProvider["map-enrich|deepseek"].calls === 1 && us.globalReadinessByProvider.codex.calls === 1, "프로젝트 목적별 호출과 전역 readiness를 분리");
ok(us.byFlowProvider["map-scout|claude"].calls === 1 && us.coverage.legacyAttributed === 1, "귀속 가능한 구형 지도 행 호환");
ok(us.coverage.legacyUnknownProject === 1 && us.coverage.future === 1 && us.coverage.excluded === 2, "구형 프로젝트 미상과 미래·부분 token 손상을 coverage로 격리");

console.log("[4] run/job fold — 재개·세대 분리·살아 있음·종료 기록 없음");
const rFail = run(), rResume = run(), rOtherGen = run();
const foldRaw = [
  start(rFail, genA), jobTerminal(rFail, genA, "provider-failed", { reasonCode: "provider-call-failed", everApplied: false }), runTerminal(rFail, "provider-failed"),
  start(rResume, genA),
  start(rOtherGen, genB), jobTerminal(rOtherGen, genB, "settled"), runTerminal(rOtherGen, "settled"),
].map(JSON.stringify).join("\n");
let au = MS.computeMapAutomationStats(foldRaw, now, repoKey, { state: "alive", runId: rResume });
ok(au.observedRuns === 3 && au.jobs === 2, "같은 jobRunId 재개는 job 1, 같은 jobKey의 다른 jobRunId는 별도 job");
ok(au.jobsByState.running === 1 && au.jobsByState.settled === 1 && !au.jobsByState["provider-failed"], "과거 실패 뒤 살아 있는 최신 재개 start가 실패를 덮고 running");
au = MS.computeMapAutomationStats(JSON.stringify(start(r0, genA)), now, repoKey, { state: "absent", runId: null });
ok(au.runsByState["terminal-missing"] === 1 && au.coverage.terminalMissing === 1 && !au.runsByState.interrupted, "잠금 부재만으로 중단 확정하지 않고 '종료 기록 없음'");
au = MS.computeMapAutomationStats(JSON.stringify(start(r0, genA)), now, repoKey, { state: "dead", runId: r0 });
ok(au.runsByState.interrupted === 1 && au.jobsByState.interrupted === 1, "같은 runId 소유자의 ESRCH 확정 사망만 interrupted");
au = MS.computeMapAutomationStats(JSON.stringify(start(r0, genA)), now, repoKey, { state: "owner-unverified", runId: r0 });
ok(au.runsByState["state-unknown"] === 1 && au.coverage.stateUnknown === 1, "owner-unverified는 state-unknown");

console.log("[5] terminal 의미 — pending/damaged/clear와 identity·구형 coverage");
const ra = run(), rb = run(), rc = run();
const statusRaw = [
  start(ra, genA), jobTerminal(ra, genA, "applied", { everApplied: true, activeDeferredItems: 1, deferredState: "pending" }), runTerminal(ra, "applied"),
  jobTerminal(rb, genB, "settled", { activeDeferredItems: null, deferredState: "damaged" }), runTerminal(rb, "settled"),
  jobTerminal(rc, "d".repeat(40), "noop", { reasonCode: "deferred-retry", everApplied: true }), runTerminal(rc, "settled"),
  { ts, repoKey, route: "self", outcome: "applied" },
].map(JSON.stringify).join("\n");
au = MS.computeMapAutomationStats(statusRaw, now, repoKey, { state: "absent" });
ok(au.jobsByState.awaiting === 1 && au.jobsByState.error === 1 && au.jobsByState.applied === 1, "pending=awaiting, damaged=error, clear deferred noop+everApplied=applied");
ok(au.coverage.legacyRows === 1 && au.coverage.startMissing === 2, "구형 route 격리와 terminal-only start 누락 coverage");
const terminalOnly = jobTerminal(run(), "e".repeat(40), "settled");
au = MS.computeMapAutomationStats(JSON.stringify(terminalOnly), now, repoKey, { state: "absent" });
ok(au.coverage.startMissing === 1 && au.jobsByState.settled === 1, "run terminal 없이 job terminal만 남아도 start 누락을 세고 job 결과는 보존");
const noGenerationRun = run();
au = MS.computeMapAutomationStats([start(noGenerationRun, null), runTerminal(noGenerationRun, "settled")].map(JSON.stringify).join("\n"), now, repoKey, { state: "absent" });
ok(au.coverage.jobGenerationUnknown === 1 && au.jobs === 0, "run terminal이 있어도 jobRunId 없는 start는 세대 미상 coverage");
const collision = [jobTerminal(ra, genA, "settled"), jobTerminal(rb, genA, "settled", { jobKey: "e".repeat(40) })].map(JSON.stringify).join("\n");
au = MS.computeMapAutomationStats(collision, now, repoKey, { state: "absent" });
ok(au.jobs === 0 && au.coverage.jobIdentityCollision === 1, "같은 jobRunId-다른 jobKey identity 충돌은 job 통계 제외");

console.log("[6] 표본 경계·동시 append+trim");
const five = [];
for (let i = 0; i < 5; i++) { const rr = run(), gg = (i + 1).toString(16).repeat(40); five.push(jobTerminal(rr, gg, i < 3 ? "settled" : "parked", { jobKey: (i + 6).toString(16).repeat(40), everApplied: false, reasonCode: i < 3 ? "none" : "route-parked" })); }
au = MS.computeMapAutomationStats(five.slice(0, 4).map(JSON.stringify).join("\n"), now, repoKey, { state: "absent" });
ok(au.completion.denominator === 4 && au.completion.ratio === null, "분모 4는 비율 숨김");
au = MS.computeMapAutomationStats(five.map(JSON.stringify).join("\n"), now, repoKey, { state: "absent" });
ok(au.completion.denominator === 5 && au.completion.numerator === 3 && au.completion.ratio === 0.6, "분모 5부터 분자/분모 비율 산출");
const child = path.join(home, "append-child.js");
fs.writeFileSync(child, `process.env.CODEX_BRIDGE_HOME=${JSON.stringify(home)};const C=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});const crypto=require("crypto");for(let i=0;i<12;i++)C.appendScoutUsage({schema:"scout-usage-v2",ts:new Date().toISOString(),callId:crypto.randomUUID(),scope:"project",repoKey:"${repoKey}",flow:"map-scout",provider:"claude",model:null,tokenIn:null,tokenOut:null,charsIn:i,charsOut:i,runId:null,jobKey:null,jobRunId:null});`);
const coordinator = path.join(home, "append-coordinator.js");
fs.writeFileSync(coordinator, `const{spawn}=require("child_process");let left=2,bad=0;for(let i=0;i<2;i++){const c=spawn(process.execPath,[process.argv[2]],{stdio:"ignore"});c.on("close",x=>{if(x)bad=1;if(!--left)process.exit(bad);});}`);
const concurrentRun = spawnSync(process.execPath, [coordinator, child]);
const concurrent = fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8").trim().split("\n").map(JSON.parse).filter((x) => x.schema === "scout-usage-v2" && x.flow === "map-scout");
ok(concurrentRun.status === 0 && concurrent.length === 24 && new Set(concurrent.map((x) => x.callId)).size === 24, "두 생산자의 동시 append+trim에서 고유 callId 유실 없음");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
