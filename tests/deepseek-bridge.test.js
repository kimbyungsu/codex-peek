/*
 * DeepSeek 탐색 팔(bridge/deepseek-bridge.js) — 순수부(설정 해석·요청 조립) + 보안 소스 계약.
 * 네트워크 호출 자체는 테스트하지 않는다(모의 금지 원칙 — 실연동은 ping 서브커맨드가 라이브 검증).
 */
const path = require("path");
const fs = require("fs");
const { resolveDeepseekConfig, buildMapRequest, DEEPSEEK_DEFAULTS } = require(path.join(__dirname, "..", "bridge", "deepseek-bridge.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[resolveDeepseekConfig] env 우선(D4) · 파일 → 기본값 폴백");
const both = resolveDeepseekConfig({ DEEPSEEK_API_KEY: "sk-fromenv0000000000000000" }, { apiKey: "sk-fromfile000000000000000", model: "custom-m", baseUrl: "https://custom/" });
ok(both.apiKey === "sk-fromenv0000000000000000", "env 키가 파일 키보다 우선");
ok(both.model === "custom-m" && both.baseUrl === "https://custom", "model/baseUrl은 파일값 사용 + 주소 끝 슬래시 제거");
const fileOnly = resolveDeepseekConfig({}, { apiKey: " sk-file00000000000000000 " });
ok(fileOnly.apiKey === "sk-file00000000000000000", "env 없으면 파일 키(공백 trim)");
ok(fileOnly.model === DEEPSEEK_DEFAULTS.model && fileOnly.baseUrl === DEEPSEEK_DEFAULTS.baseUrl, "model/baseUrl 없으면 기본값(deepseek-v4-flash·api.deepseek.com)");
const none = resolveDeepseekConfig({}, null);
ok(none.apiKey === "" && none.model === DEEPSEEK_DEFAULTS.model, "둘 다 없으면 빈 키 + 기본값(호출부가 정직 안내)");

console.log("[buildMapRequest] self 팔과 같은 지시 앞머리 · 결정론 파라미터(A/B 공정성)");
const req = buildMapRequest("# 꾸러미 본문", "deepseek-v4-flash");
ok(req.model === "deepseek-v4-flash" && req.stream === false, "모델 지정 + 스트림 없음(단일 응답)");
ok(req.messages.length === 1 && req.messages[0].role === "user" && /탐색자.*꾸러미가 유일한 근거/.test(req.messages[0].content) && /# 꾸러미 본문/.test(req.messages[0].content), "지시 앞머리 + 꾸러미 전문이 한 user 메시지");
ok(req.temperature === 0 && typeof req.max_tokens === "number", "temperature 0(재현성 — A/B 비교 대상) + 출력 상한");
const selfSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-self.js"), "utf8");
ok(/꾸러미가 유일한 근거다/.test(selfSrc) && /\[탐색자 지시\] 형식을 정확히 따르라/.test(req.messages[0].content), "핵심 지시 문구가 self 팔과 동일 계열(같은 계약)");

console.log("[보안 소스 계약] 실키 리터럴 없음 · 키는 env/파일에서만 · 키 원문 미출력");
const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "deepseek-bridge.js"), "utf8");
ok(!/sk-[A-Za-z0-9]{16,}/.test(src), "소스에 실키 형태 리터럴 없음(유출 사고 재발 방지 규칙)");
ok(/DEEPSEEK_API_KEY/.test(src) && /deepseek\.json/.test(src), "키 출처는 env·브릿지 홈 파일뿐");
ok(!/console\.(log|error)\([^)]*apiKey/.test(src), "키 원문을 로그로 찍는 경로 없음");
const runnerSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-deepseek.js"), "utf8");
ok(/collectPackage/.test(runnerSrc) && /deepseek-bridge\.js/.test(runnerSrc), "러너는 같은 꾸러미 수집기 + 브릿지 map 경유(별도 수집 경로 없음)");

console.log("[배치·문구 계약] 런타임 배치 목록 포함 + '전송 없음' 단정 문구 제거(첫 외부 전송의 정직성 — Codex 검증 지적 잠금)");
const installSrc = fs.readFileSync(path.join(__dirname, "..", "install.js"), "utf8");
const hookSetupSrc = fs.readFileSync(path.join(__dirname, "..", "src", "hook-setup.ts"), "utf8");
ok(/deepseek-bridge\.js/.test(installSrc) && /deepseek-bridge\.js/.test(hookSetupSrc), "BRIDGE_SCRIPTS 양쪽(install.js·hook-setup.ts)에 deepseek-bridge.js 포함(설치 시 브릿지 홈 배치)");
const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(!/아무것도 전송하지 않습니다/.test(extSrc) && !/sends nothing with it/.test(extSrc), "고급설정 문구에서 '전송 없음' 단정 제거(이제 수동 실행 경로가 실재)");
ok(/직접 실행할 때만/.test(extSrc) && /only when you explicitly run/.test(extSrc), "전송 조건(직접 실행 시에만)을 양언어로 명시");
const readmeKo = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const readmeEn = fs.readFileSync(path.join(__dirname, "..", "docs", "README.en.md"), "utf8");
ok(!/\*\*외부 전송 없음\*\*/.test(readmeKo) && /유일한 예외/.test(readmeKo), "README(ko): 절대 표현 제거 + 예외 1건 명시");
ok(/Single exception/.test(readmeEn) && /DeepSeek/.test(readmeEn), "README(en): 예외 1건 명시");
const privacySrc = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
ok(/유일한 예외 — DeepSeek 지도 생성/.test(privacySrc) && /안 보내는 것\(자동 제외\)/.test(privacySrc), "PRIVACY: 전송 내용·자동 제외 목록 명시");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
