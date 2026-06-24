/*
 * saveBaseDirective/loadBaseDirective 영속 테스트 — '단계별 기본 원칙 편집 저장이 안 먹힌다' 증상의 브릿지 측 격리 검증.
 * 실제 버그는 webview의 focus 조작(blur)이 render의 '포커스 중이면 안 덮어씀' 가드와 충돌해 편집값이 저장 전에 사라진 것.
 * 브릿지의 저장 영속은 정상임을 증명한다(증상이 브릿지 탓이 아님). 수정은 webview에서 포커스 조작을 제거함.
 */
const os = require("os"), path = require("path"), fs = require("fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd_"));
process.env.CODEX_BRIDGE_HOME = path.join(dir, ".bridge"); // require 전 — 실제 ~/.codex-bridge 오염 방지
const cl = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const def = cl.BASE_DEFAULTS;
console.log("[기본값] 오버라이드 없으면 기본값 로드");
ok(cl.loadBaseDirective().verifyBaseline === def.verifyBaseline, "오버라이드 없음 → 기본 verifyBaseline");

console.log("[저장 영속] 바꾼 verifyBaseline이 실제로 저장·로드됨 (증상이 브릿지 탓 아님 증명)");
const CUSTOM = "검증 기본원칙 커스텀: 내 규칙대로 검증하라";
ok(cl.saveBaseDirective({ verifyBaseline: CUSTOM, transmit: def.transmit, rejudge: def.rejudge }) === true, "saveBaseDirective 반환 true");
ok(cl.loadBaseDirective().verifyBaseline === CUSTOM, "로드 시 커스텀 verifyBaseline 반영(영속 정상)");
ok(cl.loadBaseDirective().transmit === def.transmit, "기본값과 같은 transmit은 오버라이드 안 됨(기본값 유지)");

console.log("[빈 칸 = 기본값] 원칙을 비우고 저장하면 기본값 복원 (사용자 '삭제 후 원복'은 버그 아닌 의도된 동작)");
ok(cl.saveBaseDirective({ verifyBaseline: CUSTOM, transmit: def.transmit, rejudge: def.rejudge }) === true, "먼저 커스텀 저장");
ok(cl.loadBaseDirective().verifyBaseline === CUSTOM, "커스텀 반영 확인");
cl.saveBaseDirective({ verifyBaseline: "", transmit: def.transmit, rejudge: def.rejudge }); // verifyBaseline 비움(삭제)
ok(cl.loadBaseDirective().verifyBaseline === def.verifyBaseline, "빈 칸 저장 → 기본값 복원(빈 원칙은 의미 없음 → '사용 기본값'). 저장을 확인하려면 비우지 말고 다른 내용으로 바꿔 테스트");

console.log("[복원] resetBaseDirective → 기본값");
ok(cl.resetBaseDirective() === true, "resetBaseDirective 반환 true");
ok(cl.loadBaseDirective().verifyBaseline === def.verifyBaseline, "복원 후 기본 verifyBaseline");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
