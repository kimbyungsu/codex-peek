"use strict";
/*
 * 결정2-2단계 checkCitedEvidence 테스트 (node tests/evidence.test.js).
 * Codex 답의 인용 (파일:라인)이 실제 파일 줄수 안인지 보수 점검 — 거짓경보(cry-wolf) 회피가 핵심:
 * 범위 내·해석 불가·basename 모호는 '안 띄움', 라인이 줄수를 명백히 초과할 때만 불일치.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev_"));
process.env.CODEX_BRIDGE_HOME = path.join(dir, ".bridge"); // require 전 — 실제 ~/.codex-bridge 오염 방지
const { checkCitedEvidence, flagEvidence } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
const INTEGRITY = path.join(process.env.CODEX_BRIDGE_HOME, "integrity.json");
function unackedWarnings() { try { return (JSON.parse(fs.readFileSync(INTEGRITY, "utf8")).events || []).filter((e) => e.severity === "warning" && !e.ack); } catch { return []; } }

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const fwd = (p) => p.replace(/\\/g, "/");

const ws = path.join(dir, "ws");
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "foo.js"), "1\n2\n3\n4\n5"); // 5줄
const abs = fwd(path.join(ws, "foo.js"));

console.log("[1] 범위 내 인용 → 불일치 없음(노이즈 방지)");
ok(checkCitedEvidence(`근거 [foo](${abs}:5) 확인`, ws).length === 0, "5줄 파일의 :5 = OK");
ok(checkCitedEvidence(`[foo](${abs}:1) [foo](${abs}:3)`, ws).length === 0, ":1·:3 모두 OK");

console.log("[2] 범위 초과 인용 → 불일치(존재하지 않는 줄)");
ok(checkCitedEvidence(`[foo](${abs}:99)`, ws).length === 1, "5줄 파일의 :99 = 불일치");
ok(/99/.test(checkCitedEvidence(`[foo](${abs}:99)`, ws)[0]), "불일치 메시지에 라인 표시");

console.log("[3] 존재하지 않는 파일 → 건너뜀(cry-wolf 방지)");
ok(checkCitedEvidence(`[x](${fwd(path.join(ws, "nope.js"))}:3)`, ws).length === 0, "없는 파일은 안 띄움");

console.log("[4] basename 모호(2개) → 건너뜀");
fs.mkdirSync(path.join(ws, "a")); fs.mkdirSync(path.join(ws, "b"));
fs.writeFileSync(path.join(ws, "a", "bar.js"), "1\n2");
fs.writeFileSync(path.join(ws, "b", "bar.js"), "1\n2\n3");
ok(checkCitedEvidence(`[bar](bar.js:99)`, ws).length === 0, "두 곳에 같은 이름 → 모호 → 안 띄움");

console.log("[5] 비-인용 텍스트는 무시(시간 3:00 등)");
ok(checkCitedEvidence(`회의는 3:00, 버전 1.2:5 참고`, ws).length === 0, "(경로:라인) 패턴 아님 → 무시");

console.log("[6] /mnt/d → 드라이브 매핑(존재하면 평가, 없으면 건너뜀)");
// 실제 /mnt 파일이 없으므로 '건너뜀'만 확인(크래시 없이)
ok(checkCitedEvidence(`[x](/mnt/z/nope/zzz.js:5)`, ws).length === 0, "매핑 후에도 없으면 안 띄움(크래시 없음)");

console.log("[6b] URL은 로컬 파일로 오해석 안 함(같은 basename이 ws에 있어도)");
ok(checkCitedEvidence(`[x](https://example.com/foo.js:99)`, ws).length === 0, "https:// 경로는 건너뜀(cry-wolf 방지)");

console.log("[7] flagEvidence: 불일치 있으면 노랑(warning) 무결성 이벤트 기록");
ok(unackedWarnings().length === 0, "초기 경고 0");
flagEvidence(`[v](${abs}:3) 정상`, ws); // 범위 내 → 이벤트 없음
ok(unackedWarnings().length === 0, "범위 내 인용은 이벤트 없음(노이즈 방지)");
flagEvidence(`[v](${abs}:99) 존재 안 하는 줄`, ws); // 범위 초과 → 경고 1
const w = unackedWarnings();
ok(w.length === 1, "범위 초과 인용 → 경고 1건 기록");
ok(w.length === 1 && /불일치/.test(w[0].detail) && w[0].kind === "evidence-mismatch", "kind=evidence-mismatch·detail에 불일치");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
