/*
 * computeVerifyStats — extension.ts readVerifyStats의 집계 로직을 검증한다.
 * extension.ts는 vscode 의존이라 직접 require 불가 → 동일 알고리즘을 여기에 미러로 두고 케이스 검증(정본: src/extension.ts readVerifyStats).
 * 기간 정책: 즉각 7일(week) / 추이 14일(twoWeek+daily14) / 흐름 28일(month+heatmap). 깨진 줄 skip, ws 필터, 미래 ts 제외, 세션별 실패/보류→통과 전환(resolved7).
 */
// ── 아래 emptyVB/bumpVB/computeVerifyStats는 src/extension.ts와 동일 로직(미러). 한쪽 수정 시 같이 고칠 것 ──
function emptyVB() { return { pass: 0, passNotes: 0, inconclusive: 0, fail: 0, unparsed: 0, total: 0 }; }
function bumpVB(b, v) { b.total++; if (v === "pass") b.pass++; else if (v === "pass-notes") b.passNotes++; else if (v === "inconclusive") b.inconclusive++; else if (v === "fail") b.fail++; else b.unparsed++; }
function normWs(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
function computeVerifyStats(raw, now, ws) {
  const DAY = 864e5, d7 = now - 7 * DAY, d14 = now - 14 * DAY, d28 = now - 28 * DAY;
  const out = { week: emptyVB(), twoWeek: emptyVB(), month: emptyVB(), daily14: Array.from({ length: 14 }, () => emptyVB()), heatmap: Array.from({ length: 7 }, () => new Array(24).fill(0)), resolved7: 0 };
  const events = [];
  let seq = 0;
  for (const ln of String(raw).split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (ws && (!o.workspace || normWs(o.workspace) !== normWs(ws))) continue;
    const ts = Date.parse(o.ts); if (!Number.isFinite(ts) || ts > now) continue;
    const session = String(o.claudeSession || o.codexSession || ("__u" + seq));
    events.push({ ts, v: String(o.verdict || "unparsed"), session });
    seq++;
  }
  events.sort((a, b) => a.ts - b.ts);
  const prevUncleanTsBySession = {};
  for (const e of events) {
    if (e.ts >= d7) bumpVB(out.week, e.v);
    if (e.ts >= d14) { bumpVB(out.twoWeek, e.v); const i = Math.floor((e.ts - d14) / DAY); if (i >= 0 && i < 14) bumpVB(out.daily14[i], e.v); }
    if (e.ts >= d28) { bumpVB(out.month, e.v); const dt = new Date(e.ts); out.heatmap[(dt.getDay() + 6) % 7][dt.getHours()]++; }
    const pts = prevUncleanTsBySession[e.session] || 0;
    if (e.ts >= d7 && (e.v === "pass" || e.v === "pass-notes") && pts && (e.ts - pts) <= 14 * DAY) out.resolved7++;
    prevUncleanTsBySession[e.session] = (e.v === "fail" || e.v === "inconclusive") ? e.ts : 0;
  }
  return out;
}

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const NOW = Date.parse("2026-06-15T12:00:00Z");
const ago = (d) => new Date(NOW - d * 864e5).toISOString(); // d일 전(UTC). 음수면 미래.
const J = (o) => JSON.stringify(o);

console.log("[빈 입력] 기록 없음 → 모두 0 + 구조");
let s = computeVerifyStats("", NOW, null);
ok(s.week.total === 0 && s.month.total === 0 && s.resolved7 === 0, "빈 → 0");
ok(s.daily14.length === 14 && s.heatmap.length === 7 && s.heatmap[0].length === 24, "구조(14일 / 7요일×24시간)");

console.log("[기간 버킷] 5일전 pass / 10일전 fail / 20일전 inconclusive");
const raw1 = [J({ ts: ago(5), workspace: "/ws", verdict: "pass" }), J({ ts: ago(10), workspace: "/ws", verdict: "fail" }), J({ ts: ago(20), workspace: "/ws", verdict: "inconclusive" })].join("\n");
s = computeVerifyStats(raw1, NOW, null);
ok(s.week.total === 1 && s.week.pass === 1, "week=5일전 pass만(7일창)");
ok(s.twoWeek.total === 2 && s.twoWeek.fail === 1, "twoWeek=5·10일전 2건(14일창)");
ok(s.month.total === 3 && s.month.inconclusive === 1, "month=3건(28일창)");

console.log("[ws 필터] 다른 프로젝트 제외 + workspace 없는 줄 처리");
const raw2 = [J({ ts: ago(3), workspace: "/ws", verdict: "pass" }), J({ ts: ago(3), workspace: "/other", verdict: "fail" })].join("\n");
ok(computeVerifyStats(raw2, NOW, "/ws").week.total === 1 && computeVerifyStats(raw2, NOW, "/ws").week.fail === 0, "내 ws만(1건)");
ok(computeVerifyStats(raw2, NOW, null).week.total === 2, "ws=null이면 전체(2건)");
const rawW = [J({ ts: ago(2), workspace: "/ws", verdict: "pass" }), J({ ts: ago(2), verdict: "fail" })].join("\n");
ok(computeVerifyStats(rawW, NOW, "/ws").week.total === 1, "ws 지정 시 workspace 없는 줄 제외");
ok(computeVerifyStats(rawW, NOW, null).week.total === 2, "ws=null이면 workspace 없는 줄도 포함");

console.log("[깨진 줄] 반쪽 JSON skip(동시 append 대비)");
const raw3 = [J({ ts: ago(2), workspace: "/ws", verdict: "pass" }), '{"ts":"broken', J({ ts: ago(2), workspace: "/ws", verdict: "fail" })].join("\n");
ok(computeVerifyStats(raw3, NOW, null).week.total === 2, "깨진 줄 건너뛰고 2건");

console.log("[미래 timestamp] now 이후는 제외");
const rawF = [J({ ts: ago(-3), workspace: "/ws", verdict: "pass" }), J({ ts: ago(2), workspace: "/ws", verdict: "pass" })].join("\n");
ok(computeVerifyStats(rawF, NOW, null).week.total === 1, "미래(now+3일)는 빠지고 1건");

console.log("[전환] 실패/보류 → 통과 = resolved7(같은 세션 안에서만)");
const raw4 = [J({ ts: ago(6), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass", claudeSession: "A" }), J({ ts: ago(4), workspace: "/ws", verdict: "inconclusive", claudeSession: "A" }), J({ ts: ago(3), workspace: "/ws", verdict: "pass-notes", claudeSession: "A" })].join("\n");
ok(computeVerifyStats(raw4, NOW, null).resolved7 === 2, "같은 세션 fail→pass, inconclusive→pass-notes 2건 전환");
const raw5 = [J({ ts: ago(5), workspace: "/ws", verdict: "pass", claudeSession: "A" }), J({ ts: ago(4), workspace: "/ws", verdict: "pass", claudeSession: "A" })].join("\n");
ok(computeVerifyStats(raw5, NOW, null).resolved7 === 0, "연속 통과는 전환 아님");
const rawS = [J({ ts: ago(6), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass", claudeSession: "B" })].join("\n");
ok(computeVerifyStats(rawS, NOW, null).resolved7 === 0, "다른 세션의 fail→pass는 전환 아님(과대계상 방지)");
const rawCx = [J({ ts: ago(6), workspace: "/ws", verdict: "fail", codexSession: "X" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass", codexSession: "X" })].join("\n");
ok(computeVerifyStats(rawCx, NOW, null).resolved7 === 1, "claude 세션 없어도 codex 세션으로 그룹화 → 전환 1");
const rawEmpty = [J({ ts: ago(6), workspace: "/ws", verdict: "fail" }), J({ ts: ago(5), workspace: "/ws", verdict: "pass" })].join("\n");
ok(computeVerifyStats(rawEmpty, NOW, null).resolved7 === 0, "세션 둘 다 없으면 고유 그룹이라 전환 안 묶임");
const rawOld = [J({ ts: ago(20), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(3), workspace: "/ws", verdict: "pass", claudeSession: "A" })].join("\n");
ok(computeVerifyStats(rawOld, NOW, null).resolved7 === 0, "20일전 fail→3일전 pass는 14일 초과로 전환 아님");
const rawNear = [J({ ts: ago(10), workspace: "/ws", verdict: "fail", claudeSession: "A" }), J({ ts: ago(3), workspace: "/ws", verdict: "pass", claudeSession: "A" })].join("\n");
ok(computeVerifyStats(rawNear, NOW, null).resolved7 === 1, "10일전 fail→3일전 pass는 14일내 전환 1");

console.log("[unparsed] verdict 없음/표지없음 → unparsed");
const raw6 = [J({ ts: ago(2), workspace: "/ws" }), J({ ts: ago(2), workspace: "/ws", verdict: "unparsed" })].join("\n");
ok(computeVerifyStats(raw6, NOW, null).week.unparsed === 2, "verdict 누락·unparsed 2건");

console.log("[히트맵] 28일내만 + 요일×시간 셀");
const dt = new Date(NOW - 3 * 864e5);
s = computeVerifyStats(J({ ts: dt.toISOString(), workspace: "/ws", verdict: "pass" }), NOW, null);
ok(s.heatmap[(dt.getDay() + 6) % 7][dt.getHours()] === 1, "해당 요일×시간 셀=1");
ok(computeVerifyStats(J({ ts: ago(40), workspace: "/ws", verdict: "pass" }), NOW, null).month.total === 0, "40일전은 28일 흐름서 제외");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
