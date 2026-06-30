/*
 * parseSessionTokens(src/verify-stats.ts → out/verify-stats.js) — rollout tail에서 '마지막 token_count의 total_token_usage'를 뽑는다.
 * usage-monitor codexHistory와 같은 구조. 필드명(input_tokens/cached_input_tokens/output_tokens/reasoning_output_tokens/total_tokens)을 이 테스트로 고정(회귀 방지).
 * ※ out/verify-stats.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const { parseSessionTokens, sumClaudeUsage } = require(path.join(__dirname, "..", "out", "verify-stats.js"));
function normWs(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
const NOW = Date.parse("2026-06-15T12:00:00Z");
const cago = (d) => new Date(NOW - d * 864e5).toISOString();
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const tok = (i) => JSON.stringify({ payload: { type: "token_count", info: { total_token_usage: { input_tokens: i, cached_input_tokens: i * 2, output_tokens: i * 3, reasoning_output_tokens: i * 4, total_tokens: i * 10 } } } });

console.log("[마지막 누적] 여러 token_count 중 마지막 total_token_usage 기준");
const r = parseSessionTokens([tok(10), "other line", tok(50)].join("\n"));
ok(r && r.total === 500 && r.input === 50 && r.cachedInput === 100 && r.output === 150 && r.reasoning === 200, "마지막(50) 기준 5필드 매핑");

console.log("[없음] token_count 없으면 null");
ok(parseSessionTokens("no tokens\n{}\n") === null, "token_count 없음 → null");
ok(parseSessionTokens("") === null, "빈 문자열 → null");

console.log("[깨진 줄] JSON 깨진 줄 skip, 마지막 유효");
ok(parseSessionTokens([tok(10), '{"payload":broken', tok(20)].join("\n")).total === 200, "깨진 줄 건너뛰고 마지막 유효(20*10)");

console.log("[잘린 첫 줄] tail 경계로 잘린 첫 줄 skip");
ok(parseSessionTokens(['count":99}}', tok(7)].join("\n")).total === 70, "잘린 첫 줄 무시, 유효 token_count만(7*10)");

console.log("[필드 누락] 일부 필드 없으면 0");
const r2 = parseSessionTokens(JSON.stringify({ payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 } } } }));
ok(r2 && r2.total === 100 && r2.input === 0 && r2.output === 0, "누락 필드는 0으로");

console.log("[camelCase] camelCase 필드도 인식(usage-monitor와 동일 견고함)");
const rc = parseSessionTokens(JSON.stringify({ payload: { type: "token_count", info: { total_token_usage: { inputTokens: 5, outputTokens: 15, totalTokens: 50 } } } }));
ok(rc && rc.total === 50 && rc.input === 5 && rc.output === 15, "camelCase 필드 매핑(snake 없을 때 폴백)");

console.log("[클로드 usage] 28일 + cwd 필터 + 사이드체인 제외, message.usage 합");
const cl = [
  JSON.stringify({ timestamp: cago(3), cwd: "/ws", message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } }),
  JSON.stringify({ timestamp: cago(4), cwd: "/ws", message: { usage: { input_tokens: 200, output_tokens: 80 } } }),
  JSON.stringify({ timestamp: cago(5), cwd: "/other", message: { usage: { input_tokens: 999 } } }), // 다른 폴더 제외
  JSON.stringify({ timestamp: cago(40), cwd: "/ws", message: { usage: { input_tokens: 999 } } }),   // 28일 밖 제외
  JSON.stringify({ timestamp: cago(2), cwd: "/ws", isSidechain: true, message: { usage: { input_tokens: 999 } } }), // 사이드체인 제외
  "broken usage line"
];
const rcl = sumClaudeUsage(cl, NOW, "/ws", normWs);
ok(rcl.input === 300 && rcl.output === 130 && rcl.cacheRead === 20 && rcl.cacheCreate === 10, "이 폴더 28일 메인 usage만 합(다른폴더·28일밖·사이드체인 제외)");
ok(rcl.total === 460, "총 = input+output+cacheRead+cacheCreate");
ok(rcl.turns === 2, "메인 usage 응답 2개 = 2턴(3b, 다른폴더·28일밖·사이드체인 제외)");
ok(sumClaudeUsage([], NOW, "/ws", normWs).total === 0, "빈 → 0");
const rcl2 = sumClaudeUsage([JSON.stringify({ timestamp: cago(1), cwd: "/ws", message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } } } })], NOW, "/ws", normWs);
ok(rcl2.cacheCreate === 10, "cache_creation ephemeral 5m+1h 폴백");
ok(sumClaudeUsage([JSON.stringify({ timestamp: cago(2), message: { usage: { input_tokens: 777 } } })], NOW, "/ws", normWs).total === 0, "ws 지정 시 cwd 없는 줄은 제외(프로젝트별 누수 차단)");
ok(sumClaudeUsage([JSON.stringify({ timestamp: cago(2), message: { usage: { input_tokens: 5 } } })], NOW, null, normWs).total === 5, "ws=null이면 cwd 없어도 포함");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
