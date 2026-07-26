/* P10 증분 2 — 현재 지도 건강도·P9 스냅샷·호스트 수집 경계. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MS = require(path.join(ROOT, "out", "map-stats.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const projection = (nodes, edges, degraded) => ({ ok: true, source: "v2", nodes, edges, degraded: degraded || [] });
const node = (id) => ({ id }), edge = (id) => ({ id });
const intent = (over) => ({
  recovery: { needed: false },
  dashboard: {
    conflictCards: [{}, {}], information: [{}, {}, {}],
    attention: { parkedChoices: 2, parkedDelegations: 1, damaged: false },
  },
  ...(over || {}),
});

console.log("[1] node+edge 분모, degraded 분리, stale/unknown 보수 접기");
let state = MS.computeCurrentMapState(
  projection([node("n1"), node("n2"), node("n3")], [edge("e1"), edge("e2")], [{ id: "bad1" }, { id: "bad2" }]),
  [
    { kind: "node", id: "n1", state: "fresh" },
    { kind: "node", id: "n2", state: "fresh" },
    { kind: "node", id: "n3", state: "stale" },
    { kind: "edge", id: "e1", state: "unknown" },
    { kind: "node", id: "foreign", state: "stale" },
  ], intent());
ok(state.source === "v2" && state.health.total === 5 && state.health.degraded === 2, "유효 node 3+edge 2만 분모, degraded 2는 별도");
ok(state.health.fresh === 2 && state.health.stale === 1 && state.health.unknown === 2, "누락 freshness는 unknown, 외부 항목은 제외");
ok(state.health.ratios.fresh === 0.4 && state.health.ratios.stale === 0.2 && state.health.ratios.unknown === 0.4, "분모 5부터 세 비율 산출");
state = MS.computeCurrentMapState(projection([node("n1")], [], []), [
  { kind: "node", id: "n1", state: "fresh" }, { kind: "node", id: "n1", state: "stale" },
], intent());
ok(state.health.stale === 1 && state.health.fresh === 0, "중복 관찰은 stale>unknown>fresh 순으로 보수 접기");

console.log("[2] 작은 표본과 비-v2·손상 입력");
state = MS.computeCurrentMapState(projection([node("a"), node("b")], [edge("c"), edge("d")], []), [], intent());
ok(state.health.total === 4 && Object.values(state.health.ratios).every((x) => x === null), "유효 항목 4개는 건수만 두고 비율 숨김");
ok(MS.computeCurrentMapState({ ok: true, source: "none" }, [], intent()).health === null, "none은 거짓 비율 없이 미전환 상태 보존");
ok(MS.computeCurrentMapState({ ok: true, source: "legacy" }, [], intent()).source === "legacy", "legacy 상태 보존");
ok(MS.computeCurrentMapState({ ok: false, source: "blocked", reasonKey: "topology-invalid", reason: "detail" }, [], intent()).reasonKey === "topology-invalid", "blocked의 구조화 reasonKey 소비");
ok(MS.computeCurrentMapState({ ok: false, source: "error", reason: "authority-flap" }, [], intent()).reasonKey === "authority-flap", "error의 안정 사유 소비");
ok(MS.computeCurrentMapState(null, [], intent()).reasonKey === "projection-invalid"
  && MS.computeCurrentMapState({ ok: true, source: "v2", nodes: [], edges: [] }, [], intent()).source === "error", "reader 이형도 예외 없이 error 상태");
ok(MS.computeCurrentMapState({ ok: false, source: "blocked", reason: "D:/private/path detail" }, [], intent()).reasonKey === "map-blocked"
  && MS.computeCurrentMapState(projection([node("dup"), node("dup")], [], []), [], intent()).reasonKey === "projection-invalid", "오류 전문은 내보내지 않고 중복 유효 ID도 손상으로 격리");

console.log("[3] 이미 계산된 P9 현재 상태만 수치화");
state = MS.computeCurrentMapState({ ok: true, source: "none" }, [], intent({ recovery: { needed: true } }));
ok(state.intent.state === "ok" && state.intent.choicePending === 2 && state.intent.retryPending === 3
  && state.intent.recoveryNeeded === true && state.intent.investigations === 3, "선택·명시 재시도·복구·조사 현재 수치 결합");
state = MS.computeCurrentMapState({ ok: true, source: "none" }, [], intent({ dashboard: {
  conflictCards: [], information: [], attention: { parkedChoices: 1, parkedDelegations: 2, damaged: true },
} }));
ok(state.intent.state === "damaged" && state.intent.retryPending === null, "손상 attention은 재시도 건수를 추측하지 않음");
ok(MS.computeCurrentMapState({ ok: true, source: "none" }, [], null).intent.state === "unavailable", "P9 뷰 부재는 unavailable");

console.log("[4] 2트랙 0호출, actual repo 1회 판독, 실패 무사망");
let reads = 0, freshness = 0, seenRepo = "";
const collectors = {
  readProjection(repo) { reads++; seenRepo = repo; return projection([node("n")], [], []); },
  deriveFreshness(repo) { freshness++; seenRepo = repo; return [{ kind: "node", id: "n", state: "fresh" }]; },
};
ok(MS.collectCurrentMapState(false, "D:/actual-repo", intent(), collectors) === null && reads === 0 && freshness === 0, "2트랙은 projection/freshness 호출 0");
state = MS.collectCurrentMapState(true, "D:/actual-repo", intent(), collectors);
ok(reads === 1 && freshness === 1 && seenRepo === "D:/actual-repo" && state.health.total === 1, "작업 폴더 대신 전달된 actual repo만 각 1회 판독");
reads = 0; freshness = 0;
state = MS.collectCurrentMapState(true, "D:/actual-repo", intent(), {
  readProjection() { reads++; throw new Error("disk detail"); }, deriveFreshness() { freshness++; return []; },
});
ok(state.source === "error" && state.reasonKey === "reader-exception" && reads === 1 && freshness === 0, "projection 예외는 무사망·freshness 미호출");
state = MS.collectCurrentMapState(true, "D:/actual-repo", intent(), {
  readProjection() { return projection([], [], []); }, deriveFreshness() { throw new Error("race detail"); },
});
ok(state.source === "error" && state.reasonKey === "freshness-exception", "freshness 예외도 무사망");
freshness = 0;
MS.collectCurrentMapState(true, "D:/actual-repo", intent(), {
  readProjection() { return { ok: false, source: "blocked", reasonKey: "bindings-unreadable" }; },
  deriveFreshness() { freshness++; return []; },
});
ok(freshness === 0, "비-v2 projection은 freshness를 호출하지 않음");

console.log("[5] 호스트 배선 — 실제 저장소 1회 해석·P9 결과 재사용");
// .ts는 Windows 체크아웃에서 CRLF가 될 수 있다. 아래 호스트 배선 검사는 줄바꿈 모양이 아니라
// 실행 순서를 확인하는 것이므로, OS와 무관하게 같은 LF 문자열로 맞춘 뒤 범위를 자른다.
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8").replace(/\r\n?/g, "\n");
const setupStart = ext.indexOf("const mapActualRepo =");
const setup = ext.slice(setupStart, ext.indexOf("\n  return {\n    workspace:", setupStart));
ok(setup.includes("resolveScoutRepo(ws, contract)") && setup.includes("collectCurrentMapState(contract.scoutMode === \"on\", mapActualRepo, currentIntent"), "captured contract의 actual repo와 intentState를 collector에 전달");
ok((setup.match(/sweepIntentAuto\(/g) || []).length === 1 && setup.indexOf("sweepIntentAuto(") < setup.indexOf("collectCurrentMapState("), "기존 P9 sweep 1회 뒤 결과만 수집기에 전달");
const enrichAt = ext.indexOf("enrich: (() =>");
const intentAt = ext.indexOf("intent: (intentState = collectIntentState())");
const currentAt = ext.indexOf("mapCurrent: collectMapCurrent(intentState)");
ok(enrichAt >= 0 && intentAt > enrichAt && currentAt > intentAt, "기존 P8→P9 실행 순서를 보존하고 바로 뒤에서 P10 스냅샷 수집");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
