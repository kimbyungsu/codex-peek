/*
 * computeVerifyStats 검증 — 정본 함수(src/verify-stats.ts → out/verify-stats.js)를 직접 import해 케이스 검증(미러 복제 제거).
 * 기간 정책: 즉각 7일(week) / 추이 14일(twoWeek+daily14) / 흐름 28일(month+heatmap). 깨진 줄 skip, ws 필터, 미래 ts 제외, 세션별 14일내 실패/보류→통과 전환(resolved7).
 * ※ out/verify-stats.js는 npm test의 compile(tsc) 단계 산출물. 이 파일 단독 실행 시 먼저 `npm run compile` 필요.
 */
const path = require("path");
const { computeVerifyStats, computeProjectStats } = require(path.join(__dirname, "..", "out", "verify-stats.js"));
function normWs(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); } // extension.ts와 동일 규칙으로 ws 필터 인자 전달

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const NOW = Date.parse("2026-06-15T12:00:00Z");
const ago = (d) => new Date(NOW - d * 864e5).toISOString(); // d일 전(UTC). 음수면 미래.
const J = (o) => JSON.stringify(o);
const cs = (raw, ws) => computeVerifyStats(raw, NOW, ws, normWs); // 정본 호출 헬퍼(now 고정·normWs 주입)

console.log("[빈 입력] 기록 없음 → 모두 0 + 구조");
let s = cs("", null);
ok(s.week.total === 0 && s.month.total === 0 && s.resolved7 === 0, "빈 → 0");
ok(s.daily14.length === 14 && s.heatmap.length === 7 && s.heatmap[0].length === 24, "구조(14일 / 7요일×24시간)");

console.log("[기간 버킷] 5일전 pass / 10일전 fail / 20일전 inconclusive");
const raw1 = [J({ ts: ago(5), workspace: "/ws", verdict: "pass" }), J({ ts: ago(10), workspace: "/ws", verdict: "fail" }), J({ ts: ago(20), workspace: "/ws", verdict: "inconclusive" })].join("\n");
s = cs(raw1, null);
ok(s.week.total === 1 && s.week.pass === 1, "week=5일전 pass만(7일창)");
ok(s.twoWeek.total === 2 && s.twoWeek.fail === 1, "twoWeek=5·10일전 2건(14일창)");
ok(s.month.total === 3 && s.month.inconclusive === 1, "month=3건(28일창)");

console.log("[ws 필터] 다른 프로젝트 제외 + workspace 없는 줄 처리");
const raw2 = [J({ ts: ago(3), workspace: "/ws", verdict: "pass" }), J({ ts: ago(3), workspace: "/other", verdict: "fail" })].join("\n");
ok(cs(raw2, "/ws").week.total === 1 && cs(raw2, "/ws").week.fail === 0, "내 ws만(1건)");
ok(cs(raw2, null).week.total === 2, "ws=null이면 전체(2건)");
const rawW = [J({ ts: ago(2), workspace: "/ws", verdict: "pass" }), J({ ts: ago(2), verdict: "fail" })].join("\n");
ok(cs(rawW, "/ws").week.total === 1, "ws 지정 시 workspace 없는 줄 제외");
ok(cs(rawW, null).week.total === 2, "ws=null이면 workspace 없는 줄도 포함");

console.log("[깨진 줄] 반쪽 JSON skip(동시 append 대비)");
const raw3 = [J({ ts: ago(2), workspace: "/ws", verdict: "pass" }), '{"ts":"broken', J({ ts: ago(2), workspace: "/ws", verdict: "fail" })].join("\n");
ok(cs(raw3, null).week.total === 2, "깨진 줄 건너뛰고 2건");

console.log("[미래 timestamp] now 이후는 제외");
const rawF = [J({ ts: ago(-3), workspace: "/ws", verdict: "pass" }), J({ ts: ago(2), workspace: "/ws", verdict: "pass" })].join("\n");
ok(cs(rawF, null).week.total === 1, "미래(now+3일)는 빠지고 1건");

console.log("[전환] 실패/보류 → 통과 = resolved7(같은 세션·14일내)");
const raw4 = [J({ ts: ago(6), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass", claudeSession: "A" }), J({ ts: ago(4), workspace: "/ws", verdict: "inconclusive", claudeSession: "A" }), J({ ts: ago(3), workspace: "/ws", verdict: "pass-notes", claudeSession: "A" })].join("\n");
ok(cs(raw4, null).resolved7 === 2, "같은 세션 fail→pass, inconclusive→pass-notes 2건 전환");
const raw5 = [J({ ts: ago(5), workspace: "/ws", verdict: "pass", claudeSession: "A" }), J({ ts: ago(4), workspace: "/ws", verdict: "pass", claudeSession: "A" })].join("\n");
ok(cs(raw5, null).resolved7 === 0, "연속 통과는 전환 아님");
const rawS = [J({ ts: ago(6), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass", claudeSession: "B" })].join("\n");
ok(cs(rawS, null).resolved7 === 0, "다른 세션의 fail→pass는 전환 아님(과대계상 방지)");
const rawCx = [J({ ts: ago(6), workspace: "/ws", verdict: "fail", codexSession: "X" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass", codexSession: "X" })].join("\n");
ok(cs(rawCx, null).resolved7 === 1, "claude 세션 없어도 codex 세션으로 그룹화 → 전환 1");
const rawEmpty = [J({ ts: ago(6), workspace: "/ws", verdict: "fail" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass" })].join("\n");
ok(cs(rawEmpty, null).resolved7 === 0, "세션 둘 다 없으면 고유 그룹이라 전환 안 묶임");
const rawOld = [J({ ts: ago(20), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(3), workspace: "/ws", verdict: "pass", claudeSession: "A" })].join("\n");
ok(cs(rawOld, null).resolved7 === 0, "20일전 fail→3일전 pass는 14일 초과로 전환 아님");
const rawNear = [J({ ts: ago(10), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(3), workspace: "/ws", verdict: "pass", claudeSession: "A" })].join("\n");
ok(cs(rawNear, null).resolved7 === 1, "10일전 fail→3일전 pass는 14일내 전환 1");

console.log("[unparsed] verdict 없음/표지없음 → unparsed");
const raw6 = [J({ ts: ago(2), workspace: "/ws" }), J({ ts: ago(2), workspace: "/ws", verdict: "unparsed" })].join("\n");
ok(cs(raw6, null).week.unparsed === 2, "verdict 누락·unparsed 2건");

console.log("[히트맵] 28일내만 + 요일×시간 셀");
const dt = new Date(NOW - 3 * 864e5);
s = cs(J({ ts: dt.toISOString(), workspace: "/ws", verdict: "pass" }), null);
ok(s.heatmap[(dt.getDay() + 6) % 7][dt.getHours()] === 1, "해당 요일×시간 셀=1");
ok(cs(J({ ts: ago(40), workspace: "/ws", verdict: "pass" }), null).month.total === 0, "40일전은 28일 흐름서 제외");

console.log("[모델·검증모드별] 28일 model/mode별 건수·토큰 집계(2순위-B)");
const rawM = [
  J({ ts: ago(3), workspace: "/ws", verdict: "pass", model: "gpt-5.5", mode: "always", codexTokens: { total: 100 } }),
  J({ ts: ago(4), workspace: "/ws", verdict: "fail", model: "gpt-5.5", mode: "always", codexTokens: { total: 50 } }),
  J({ ts: ago(5), workspace: "/ws", verdict: "pass", model: "gpt-5.1", mode: "plan", codexTokens: { total: 30 } })
].join("\n");
let sm = cs(rawM, null);
ok(sm.byModel["gpt-5.5"].count === 2 && sm.byModel["gpt-5.5"].tokens === 150, "모델별: gpt-5.5 2건·150토큰 합");
ok(sm.byModel["gpt-5.1"].count === 1 && sm.byModel["gpt-5.1"].tokens === 30, "모델별: gpt-5.1 1건·30토큰");
ok(sm.byMode["always"].count === 2 && sm.byMode["always"].tokens === 150, "검증모드별: always 2건·150토큰");
ok(sm.byMode["plan"].count === 1 && sm.byMode["plan"].tokens === 30, "검증모드별: plan 1건·30토큰");
ok(cs(J({ ts: ago(3), workspace: "/ws", verdict: "pass" }), null).byModel["(미상)"].count === 1, "model/mode 없는 과거 기록은 (미상)");
ok(cs(J({ ts: ago(40), workspace: "/ws", verdict: "pass", model: "gpt-5.5", codexTokens: { total: 9 } }), null).byModel["gpt-5.5"] === undefined, "28일 밖은 모델집계서 제외");
const rawEf = [
  J({ ts: ago(3), workspace: "/ws", verdict: "pass", model: "gpt-5.5", effort: "xhigh", codexTokens: { total: 100 } }),
  J({ ts: ago(4), workspace: "/ws", verdict: "pass", model: "gpt-5.5", effort: "medium", codexTokens: { total: 40 } })
].join("\n");
const se = cs(rawEf, null);
ok(se.byModel["gpt-5.5 · xhigh"].tokens === 100 && se.byModel["gpt-5.5 · medium"].tokens === 40, "모델+추론강도별 분리 키(gpt-5.5 · xhigh / · medium)");
ok(cs(J({ ts: ago(3), workspace: "/ws", verdict: "pass", model: "gpt-5.5" }), null).byModel["gpt-5.5"].count === 1, "effort 없으면 모델명만 키");

console.log("[프로젝트별 비교] workspace group-by(3c) — ws 필터 없이 모든 폴더, 28일");
const rawP = [
  J({ ts: ago(3), workspace: "/ws1", verdict: "pass" }),
  J({ ts: ago(4), workspace: "/ws1", verdict: "fail" }),
  J({ ts: ago(5), workspace: "/ws2", verdict: "pass" }),
  J({ ts: ago(40), workspace: "/ws1", verdict: "pass" }) // 28일 밖 제외
].join("\n");
const pp = computeProjectStats(rawP, NOW, normWs);
ok(pp["/ws1"].count === 2 && pp["/ws1"].pass === 1 && pp["/ws1"].fail === 1, "ws1=2건(pass1/fail1), 28일밖 제외");
ok(pp["/ws2"].count === 1 && pp["/ws2"].pass === 1, "ws2=1건");
ok(computeProjectStats(J({ ts: ago(3), verdict: "pass" }), NOW, normWs)["(미상)"].count === 1, "workspace 없으면 (미상) 그룹");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
