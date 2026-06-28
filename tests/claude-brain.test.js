// Claude 설정 모델 읽기(readClaudeSettingsModel) 규칙 검증.
// ⚠ extension.ts는 vscode 의존 + 고정 경로(~/.claude/settings.json)에 직접 접근하므로, 여기선 동일 규칙(순수 함수)을 검증한다.
// 생각강도(effortLevel/env)는 더 이상 읽지 않는다 — Claude의 실제 런타임 생각강도가 어디에도 기록되지 않아 '설정 vs 실제' 비교가
// 불가능하기 때문(과거 '무효값' 검사는 opus의 max를 오탐해 제거). settings.json은 읽기만 하고 쓰지 않는다(두뇌설정 카드 폐기).
const assert = require("assert");

// readClaudeSettingsModel: settings.json의 model 문자열만 읽음(없거나 비문자열/비객체면 빈 문자열).
function readModel(j) { return j && typeof j === "object" && typeof j.model === "string" ? j.model : ""; }

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(readModel({ model: "opus[1m]" }) === "opus[1m]", "model 문자열 그대로 읽음(별칭/[1m] 보존)");
ok(readModel({ model: "claude-haiku-4-5", effortLevel: "max" }) === "claude-haiku-4-5", "effortLevel(max 포함)은 무시하고 model만 — max 오탐 없음");
ok(readModel({ effortLevel: "high" }) === "", "model 없으면 빈 문자열(effortLevel만으론 모델 모름)");
ok(readModel({ model: 123 }) === "", "model이 문자열 아니면 빈 문자열");
ok(readModel(null) === "" && readModel([1]) === "" && readModel("x") === "", "비객체/배열 → 빈 문자열");

console.log("claude-brain: " + n + " assertions passed");
