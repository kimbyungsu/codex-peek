/*
 * flagVerdict supersede 테스트 — 새 검증 결과가 같은 세션의 직전 '비-깨끗 결론' 노랑을 대체(누적 cry-wolf 방지).
 * 사용자 시나리오: 실패→수정→재검증 통과면 노랑이 사라져야 한다(무조건 노랑 = 버그였음).
 */
const os = require("os"), path = require("path"), fs = require("fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs_"));
process.env.CODEX_BRIDGE_HOME = path.join(dir, ".bridge"); // require 전 — 실제 ~/.codex-bridge 오염 방지
process.env.CLAUDE_CODE_SESSION_ID = "S1"; // claudeId() 제어 → flagVerdict의 session 고정
const cl = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const { flagVerdict } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
const INTEGRITY = path.join(process.env.CODEX_BRIDGE_HOME, "integrity.json");
function unackedVerdict() { try { return (JSON.parse(fs.readFileSync(INTEGRITY, "utf8")).events || []).filter((e) => e.kind === "verdict-nonclean" && !e.ack); } catch { return []; } }
function resetIg() { fs.mkdirSync(path.dirname(INTEGRITY), { recursive: true }); fs.writeFileSync(INTEGRITY, JSON.stringify({ events: [] })); }

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

resetIg();
console.log("[사용자 시나리오] 실패 → 재검증 통과 = 노랑 사라짐");
flagVerdict("검증: 실패\n\n- 문제 X", "/ws");
ok(unackedVerdict().length === 1, "실패 → verdict-nonclean 1건 뜸");
flagVerdict("검증: 통과\n\n- 다 고침", "/ws");
ok(unackedVerdict().length === 0, "이후 통과 → 직전 실패 노랑이 supersede로 사라짐(cry-wolf 해소)");

console.log("[통과(보완)도 통과라 직전 비-깨끗을 해소]");
flagVerdict("검증: 보류\n\n- 정보부족", "/ws");
ok(unackedVerdict().length === 1, "보류 → 1건");
flagVerdict("검증: 통과(보완)\n\n- 사소한 보완", "/ws");
ok(unackedVerdict().length === 0, "통과(보완)도 통과 → 직전 보류 해소 + 새 노랑 없음");

console.log("[최신만 유지] 연속 실패는 누적 아니라 1건");
resetIg();
flagVerdict("검증: 실패\n\n첫째", "/ws");
flagVerdict("검증: 실패\n\n둘째", "/ws");
ok(unackedVerdict().length === 1, "실패 두 번 → 누적 아니라 최신 1건만");

console.log("[결론 미상(null)은 직전 신호 안 건드림]");
resetIg();
flagVerdict("검증: 실패\n\nX", "/ws");
flagVerdict("코드를 봤습니다(결론 표지 없음)", "/ws"); // null → supersede/추가 안 함
ok(unackedVerdict().length === 1, "결론 못 읽은 답은 직전 실패 노랑을 함부로 지우지 않음");

console.log("[supersedeIntegrity 정밀] 다른 세션·다른 kind·ack된 것은 보존");
fs.writeFileSync(INTEGRITY, JSON.stringify({ events: [
  { id: "x0", ack: true, session: "S1", kind: "verdict-nonclean", ts: "t0", severity: "warning", detail: "acked" },
  { id: "x1", ack: false, session: "S1", kind: "verdict-nonclean", ts: "t1", severity: "warning", detail: "live" },
  { id: "x2", ack: false, session: "S1", kind: "evidence-mismatch", ts: "t2", severity: "warning", detail: "근거" },
  { id: "x3", ack: false, session: "S2", kind: "verdict-nonclean", ts: "t3", severity: "warning", detail: "다른세션" },
] }));
cl.supersedeIntegrity("S1", "verdict-nonclean");
const after = JSON.parse(fs.readFileSync(INTEGRITY, "utf8")).events;
ok(!after.some((e) => e.id === "x1"), "미확인 S1 verdict-nonclean 제거됨");
ok(after.some((e) => e.id === "x0"), "ack된 것은 보존(supersede 대상 아님)");
ok(after.some((e) => e.id === "x2"), "같은 세션 다른 kind(근거) 보존");
ok(after.some((e) => e.id === "x3"), "다른 세션(S2) 보존");
ok(cl.supersedeIntegrity("", "verdict-nonclean") === false, "세션 미상이면 안 건드림(false)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
