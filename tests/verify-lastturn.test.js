/*
 * parseLastTurn(bridge/codex-bridge.js) — rollout 끝에서 '마지막 turn 모델 + 그 turn 1회 토큰(last_token_usage)'을 읽는다.
 * 검증 1건의 모델·비용 기록용(verdicts.jsonl의 model/codexTokens). 구조: type==='turn_context'.payload.model, payload.type==='token_count'.info.last_token_usage.
 */
const os = require("os"), path = require("path"), fs = require("fs");
const { parseLastTurn } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lt_"));
const f = path.join(dir, "rollout.jsonl");

console.log("[마지막 turn] 여러 turn 중 마지막 모델 + 마지막 1회 토큰");
fs.writeFileSync(f, [
  JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.1-codex" } }),
  JSON.stringify({ payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50, reasoning_output_tokens: 30, total_tokens: 200 } } } }),
  JSON.stringify({ type: "turn_context", payload: { turn_id: "t2", model: "gpt-5.5-codex" } }),
  JSON.stringify({ payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } } })
].join("\n") + "\n");
let r = parseLastTurn(f);
ok(r.model === "gpt-5.5-codex", "마지막 turn_context 모델(t2)");
ok(r.tokens && r.tokens.total === 15 && r.tokens.input === 10, "마지막 token_count의 1회 사용량(누적 아님)");

console.log("[토큰 없음] turn_context만 있으면 model만, tokens null");
fs.writeFileSync(f, JSON.stringify({ type: "turn_context", payload: { model: "x" } }) + "\n");
r = parseLastTurn(f);
ok(r.model === "x" && r.tokens === null, "token_count 없으면 tokens null");

console.log("[파일 없음] throw 안 하고 빈 결과");
r = parseLastTurn(path.join(dir, "nope.jsonl"));
ok(r.model === "" && r.tokens === null, "없는 파일 → {model:'',tokens:null}");

console.log("[camelCase] last_token_usage camelCase 폴백");
fs.writeFileSync(f, JSON.stringify({ payload: { type: "token_count", info: { last_token_usage: { inputTokens: 7, totalTokens: 70 } } } }) + "\n");
ok(parseLastTurn(f).tokens.total === 70, "camelCase totalTokens 폴백");

console.log("[모델 폴백] collaboration_mode.settings.model");
fs.writeFileSync(f, JSON.stringify({ type: "turn_context", payload: { collaboration_mode: { settings: { model: "gpt-cm" } } } }) + "\n");
ok(parseLastTurn(f).model === "gpt-cm", "collaboration_mode.settings.model 폴백");

console.log("[추론강도 effort] turn_context.effort / collaboration_mode.reasoning_effort");
fs.writeFileSync(f, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5", effort: "xhigh" } }) + "\n");
ok(parseLastTurn(f).effort === "xhigh", "turn_context.effort 수집");
fs.writeFileSync(f, JSON.stringify({ type: "turn_context", payload: { collaboration_mode: { settings: { reasoning_effort: "high" } } } }) + "\n");
ok(parseLastTurn(f).effort === "high", "collaboration_mode.settings.reasoning_effort 폴백");
fs.writeFileSync(f, JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5" } }) + "\n");
ok(parseLastTurn(f).effort === "", "effort 없으면 빈 문자열");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
