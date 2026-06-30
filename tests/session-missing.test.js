/*
 * session-missing reconcile + ack 제외 + 정상/막힘(blocked) 분기 테스트.
 * 연결된 Codex 세션이 없으면 빨강(error) 경보. 자동 생성이 막힌 상태(autoNewFailed)면 '막힘' 안내(sig 다름)로 갱신.
 * ★ack로는 안 닫히고 '연결'로만 해소. 상태가 정상↔막힘으로 바뀌면 detail이 갱신된다.
 * extension.ts syncSessionMissing / ackHere 핵심 로직 복제(vscode 의존이라 직접 require 불가 — brain-drift.test.js와 동일 방식).
 */
const KIND = "session-missing";
const normWs = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
const NORMAL = "session-missing:normal", BLOCKED = "session-missing:blocked";

// syncSessionMissing 로직 복제 — extension.ts와 동일해야 한다(한쪽만 고치지 말 것).
function reconcile(events, ws, hasLink, blocked) {
  const wsMatch = (e) => !e.workspace || normWs(e.workspace) === normWs(ws);
  const sig = blocked ? BLOCKED : NORMAL;
  const detail = blocked ? "현재 연결된 Codex 세션이 없고, 자동 생성이 멈춰 있습니다…" : "현재 연결된 Codex 세션이 없습니다… 자동으로 시도합니다.";
  // 연결 있으면 전부 제거. 없으면 '현재 sig + 미확인'만 보존(옛 sig·ack된 건 제거 → 아래서 새 detail로 재생성).
  const kept = events.filter((e) => e.kind !== KIND || !wsMatch(e) || (!hasLink && e.sig === sig && !e.ack));
  const present = kept.some((e) => e.kind === KIND && wsMatch(e));
  if (!hasLink && !present) {
    kept.push({ id: "new_" + kept.length, ack: false, ts: "t", session: "", workspace: ws, kind: KIND, severity: "error", detail, sig });
  }
  return kept;
}
// ackHere/배너 '확인함' 대상 필터 복제 — session-missing 제외가 핵심.
function ackTargets(events) {
  return events.filter((e) => !e.ack && (e.severity === "error" || e.severity === "warning") && e.kind !== KIND);
}
const sm = (evs, ws) => evs.filter((e) => e.kind === KIND && (!e.workspace || normWs(e.workspace) === normWs(ws)));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[연결 없음·정상] 없으면 1건 추가(빨강 error, sig=normal)");
let evs = reconcile([], "W", false, false);
ok(sm(evs, "W").length === 1, "연결 없음 → session-missing 1건");
ok(sm(evs, "W")[0].severity === "error", "severity=error(빨강)");
ok(sm(evs, "W")[0].sig === NORMAL, "정상 상태 → sig=normal");

console.log("[연결 없음·이미 있음·같은 sig] 재발행 안 함(id 보존)");
const existing = [{ id: "x1", ack: false, kind: KIND, workspace: "W", severity: "error", ts: "t", detail: "d", sig: NORMAL }];
evs = reconcile(existing, "W", false, false);
ok(sm(evs, "W").length === 1, "같은 sig면 중복 추가 안 함");
ok(sm(evs, "W")[0].id === "x1", "기존 id 보존(깜빡임 없음)");

console.log("[연결 생김] session-missing 제거(빨강 사라짐)");
evs = reconcile(existing, "W", true, false);
ok(sm(evs, "W").length === 0, "연결되면 제거");

console.log("[막힘 상태] autoNewFailed면 sig=blocked + 막힘 detail");
evs = reconcile([], "W", false, true);
ok(sm(evs, "W").length === 1 && sm(evs, "W")[0].sig === BLOCKED, "막힘 → sig=blocked 1건");
ok(/멈춰/.test(sm(evs, "W")[0].detail), "막힘 detail(자동 생성이 멈춤)");

console.log("[정상→막힘 전환] 옛 정상 이벤트 제거 + 막힘 detail로 갱신");
const normalExisting = [{ id: "n1", ack: false, kind: KIND, workspace: "W", severity: "error", ts: "t", detail: "정상", sig: NORMAL }];
evs = reconcile(normalExisting, "W", false, true); // 이제 막힘 상태
ok(sm(evs, "W").length === 1, "전환 후에도 1건(누적 아님)");
ok(sm(evs, "W")[0].sig === BLOCKED, "옛 normal 제거 → blocked로 갱신");
ok(!evs.some((e) => e.id === "n1"), "옛 정상 이벤트 제거됨(detail 갱신)");

console.log("[타 kind 보존] 연결돼도 verify-incomplete 등 다른 빨강은 안 지움");
const mixed = [
  { id: "s1", ack: false, kind: KIND, workspace: "W", severity: "error", ts: "t", detail: "d", sig: NORMAL },
  { id: "vi", ack: false, kind: "verify-incomplete", workspace: "W", severity: "error", ts: "t", detail: "미완" },
];
evs = reconcile(mixed, "W", true, false);
ok(sm(evs, "W").length === 0, "연결 → session-missing만 제거");
ok(evs.some((e) => e.kind === "verify-incomplete"), "verify-incomplete(다른 빨강) 보존");

console.log("[타 ws 보존] 다른 폴더의 session-missing은 안 건드림");
const otherWs = [{ id: "o1", ack: false, kind: KIND, workspace: "OTHER", severity: "error", ts: "t", detail: "d", sig: NORMAL }];
evs = reconcile(otherWs, "W", true, false);
ok(evs.some((e) => e.workspace === "OTHER" && e.kind === KIND), "다른 ws session-missing 보존");

console.log("[ack 제외] '확인함'이 session-missing은 안 끈다 — 다른 빨강·노랑은 끈다");
const forAck = [
  { id: "sm", ack: false, kind: KIND, severity: "error", sig: NORMAL },
  { id: "vf", ack: false, kind: "verdict-nonclean", severity: "error" },
  { id: "dr", ack: false, kind: "brain-drift", severity: "warning" },
];
const targets = ackTargets(forAck);
ok(!targets.some((e) => e.id === "sm"), "session-missing은 ack 대상 제외");
ok(targets.some((e) => e.id === "vf"), "verdict-nonclean(다른 빨강) ack 대상 유지");
ok(targets.some((e) => e.id === "dr"), "brain-drift(노랑) ack 대상 유지");

console.log("[ack 무력화] ack된 session-missing은 연결 없으면 unacked로 되살아남");
const acked = [{ id: "a1", ack: true, kind: KIND, workspace: "W", severity: "error", ts: "t", detail: "d", sig: NORMAL }];
evs = reconcile(acked, "W", false, false);
ok(sm(evs, "W").length === 1, "ack됐어도 연결 없으면 1건 유지");
ok(sm(evs, "W")[0].ack === false, "그 1건은 unacked(다시 빨강)");

console.log("[빈 ids는 all로 변질 안 됨] 배너가 session-missing만 빼 []를 보내도 전체 ack 안 됨");
const ackHandler = (ids) => (Array.isArray(ids) ? ids : "all");
ok(Array.isArray(ackHandler([])) && ackHandler([]).length === 0, "빈 배열 []→no-op");
ok(ackHandler(undefined) === "all", "ids 없으면 'all'(다른 호출처 호환)");
ok(JSON.stringify(ackHandler(["x"])) === '["x"]', "정상 ids 그대로");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
