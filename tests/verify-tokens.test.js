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
ok(sumClaudeUsage([], NOW, "/ws", normWs).total === 0, "빈 → 0");
const rcl2 = sumClaudeUsage([JSON.stringify({ timestamp: cago(1), cwd: "/ws", message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } } } })], NOW, "/ws", normWs);
ok(rcl2.cacheCreate === 10, "cache_creation ephemeral 5m+1h 폴백");
ok(sumClaudeUsage([JSON.stringify({ timestamp: cago(2), message: { usage: { input_tokens: 777 } } })], NOW, "/ws", normWs).total === 0, "ws 지정 시 cwd 없는 줄은 제외(프로젝트별 누수 차단)");
ok(sumClaudeUsage([JSON.stringify({ timestamp: cago(2), message: { usage: { input_tokens: 5 } } })], NOW, null, normWs).total === 5, "ws=null이면 cwd 없어도 포함");

console.log("[requestId 중복 방어] 한 API 응답이 여러 줄로 쪼개져 같은 usage를 반복해도 1회만 합산");
const dup = [
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", requestId: "req_A", message: { usage: { input_tokens: 100, output_tokens: 10 } } }),
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", requestId: "req_A", message: { usage: { input_tokens: 100, output_tokens: 10 } } }), // 같은 요청 쪼개진 줄(동일 usage)
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", requestId: "req_A", message: { usage: { input_tokens: 100, output_tokens: 12 } } }), // 같은 요청의 갱신된 usage → 마지막 승리
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", requestId: "req_B", message: { usage: { input_tokens: 5, output_tokens: 5 } } }),   // 다른 요청은 별도 합산
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", message: { usage: { input_tokens: 3 } } }),                                          // requestId 없는 줄은 그대로 합산
];
const rdup = sumClaudeUsage(dup, NOW, "/ws", normWs);
ok(rdup.input === 108 && rdup.output === 17, "req_A 1회(마지막 usage)+req_B+무ID줄 = input 100+5+3, output 12+5");

console.log("[턴수] '사용자가 보낸 질문'만 — 도구결과·메타·시스템주입·사이드체인 제외");
const tl = [
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u1", message: { role: "user", content: "질문 1" } }),                                    // 문자열 content = 진짜 질문
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "질문 2" }] } }),          // text 배열도 질문
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", content: "결과" }] } }),  // 도구 결과 반환 줄 제외
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u4", isMeta: true, message: { role: "user", content: "메타 줄" } }),                     // 메타 제외
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u5", origin: { kind: "task-notification" }, message: { role: "user", content: "알림" } }), // 시스템 주입 제외
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u6", isSidechain: true, message: { role: "user", content: "서브에이전트" } }),            // 사이드체인 제외
  JSON.stringify({ timestamp: cago(1), cwd: "/other", type: "user", uuid: "u7", message: { role: "user", content: "다른 폴더" } }),                              // 다른 폴더 제외
  JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "assistant", requestId: "rq", message: { usage: { input_tokens: 1 } } }),                               // 응답 줄은 턴 아님
];
ok(sumClaudeUsage(tl, NOW, "/ws", normWs).turns === 2, "질문 2개만 턴으로(도구결과·메타·주입·사이드체인·타폴더·응답 제외)");
ok(sumClaudeUsage([JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "u8", message: { role: "user", content: "질문" } }).replace('"type":"user"', '"type": "user"')], NOW, "/ws", normWs).turns === 1, '직렬화 공백 변형("type": "user")도 턴 인식(사전 필터가 안 거름)');

console.log("[파일 간 중복(seenReq)] resume/fork로 복사된 줄이 두 파일에 있어도 1회만");
const seen = new Set();
const fileA = [JSON.stringify({ timestamp: cago(1), cwd: "/ws", type: "user", uuid: "uX", message: { role: "user", content: "질문" } }), JSON.stringify({ timestamp: cago(1), cwd: "/ws", requestId: "req_C", message: { usage: { input_tokens: 50, output_tokens: 5 } } })];
const a1 = sumClaudeUsage(fileA, NOW, "/ws", normWs, seen);
const a2 = sumClaudeUsage(fileA, NOW, "/ws", normWs, seen); // 같은 줄이 복사된 두 번째 파일
ok(a1.input === 50 && a1.turns === 1 && a2.input === 0 && a2.turns === 0, "두 번째 파일의 동일 requestId·턴 uuid는 0으로(공유 seen)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
