/*
 * DeepSeek 설정(src/deepseek-config.ts → out/deepseek-config.js) — 고급설정 탭의 키 저장 로직.
 * 보안 계약: 마스킹은 원문 길이도 숨김 · 병합은 키만 교체(모델/주소 보존) · 빈 키=삭제 · 웹뷰 원문 미노출은 소스 계약으로 잠금.
 */
const path = require("path");
const fs = require("fs");
const { maskKey, isPlausibleKey, mergeDeepseekConfig, DEEPSEEK_DEFAULTS } = require(path.join(__dirname, "..", "out", "deepseek-config.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[maskKey] 앞 3·끝 4만 — 원문 길이 은닉(고정 불릿)");
ok(maskKey("sk-fake00fixture00fixture00fake9z") === "sk-••••ke9z", "표준 키 마스킹");
ok(maskKey("sk-abcdefghijklmnop") === "sk-••••mnop" && maskKey("sk-" + "x".repeat(60)).length === maskKey("sk-abcdefghijklmnop").length, "길이가 달라도 마스킹 길이 동일(길이 정보 은닉)");
ok(maskKey("") === "" && maskKey("short") === "••••", "빈 값·초단문 처리");

console.log("[isPlausibleKey] 형식 경고용(저장은 안 막음)");
ok(isPlausibleKey("sk-fake00fixture00fixture00fake9z") === true, "정상 형식");
ok(isPlausibleKey("api_key_123") === false && isPlausibleKey("sk-short") === false, "비관례 형식은 경고 대상");

console.log("[mergeDeepseekConfig] 키만 교체 — 모델·주소 보존, 빈 키=삭제, 기본값 채움");
const merged = mergeDeepseekConfig({ model: "custom-model", baseUrl: "https://x", extra: 1 }, "sk-newkey1234567890abcd");
ok(merged.apiKey === "sk-newkey1234567890abcd" && merged.model === "custom-model" && merged.baseUrl === "https://x" && merged.extra === 1, "기존 설정 보존 + 키 교체");
const cleared = mergeDeepseekConfig({ apiKey: "sk-old", model: "m" }, "");
ok(!("apiKey" in cleared) && cleared.model === "m", "빈 키 = 키만 삭제(모델 유지)");
const fresh = mergeDeepseekConfig(null, "sk-abc1234567890abcdef");
ok(fresh.model === DEEPSEEK_DEFAULTS.model && fresh.baseUrl === DEEPSEEK_DEFAULTS.baseUrl, "설정 없던 경우 기본값(deepseek-v4-flash·api.deepseek.com) 채움");

console.log("[보안 소스 계약] 웹뷰로 키 원문이 나가지 않음 + 안내 배선(소스 검사)");
const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/deepseek: readDeepseekView\(\)/.test(src) && /hasKey: boolean; masked: string/.test(src), "상태에는 hasKey·masked만(원문 필드 없음)");
ok(!/apiKey[^\n]*postMessage|postMessage[^\n]*apiKey/.test(src), "postMessage 경로에 apiKey 원문 없음");
ok(/saveDeepseekKey/.test(src) && /mergeDeepseekConfig\(readDeepseekRaw\(\), key\)/.test(src), "저장 핸들러가 병합 정본 사용");
ok(/scoutMode: m\.scoutMode \}\) === "on" && !readDeepseekView\(\)\.hasKey/.test(src), "3트랙 저장+키 없음 → 안내 토스트(차단 아님)");
ok(/키 없이도 변경 감지 \+ self 팔 지도\(별도 과금 없음/.test(src), "scoutBox 상시 고지(키 없을 때 기대치 — '무료' 단독 표기 금지·쓰던 Claude 사용량 범위 명시)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
