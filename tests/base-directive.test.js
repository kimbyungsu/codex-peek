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

console.log("[전달 원칙 — 응답 축약 금지] 축약 요청('N문장 이내로' 류)이 판정 표지누락 경보를 오염시킨 실사고(2026-07-08) 재발 방지 계약");
ok(/받을 답변도 축약하도록 지시하지 마라/.test(def.transmit) && /판정 표지누락 유도 방지/.test(def.transmit), "ko: 답변 축약 '지시' 금지 + '유도 방지' 목적 부연(사용자 v3 문안 — 결과형 '유도'만이면 극성 오독 잔여 위험)");
ok(/do not instruct the verifier to abbreviate its reply/.test(cl.BASE_DEFAULTS_EN.transmit) && /to avoid inducing verdict-line omission/.test(cl.BASE_DEFAULTS_EN.transmit), "en: 동등 품질 대응(축약 지시 금지 + 목적 부연)");

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

console.log("[프로필 축 — 편집 개방 2026-08-05] core 전용 슬롯 분리·격리·하위호환");
ok(cl.BASE_PROFILE_AXIS === true, "capability 표지(BASE_PROFILE_AXIS) 노출 — 확장이 편집 개방 여부를 이걸로 판별");
const fs2 = require("fs");
ok(/base-directive\.core\.json$/.test(cl.baseDirectiveFileFor("ko", "core")) && /base-directive\.core\.en\.json$/.test(cl.baseDirectiveFileFor("en", "core")), "core 전용 파일명(기존 base-directive*.json=무결성 그대로 — 하위호환)");
ok(cl.baseDirectiveFileFor("ko") === cl.baseDirectiveFileFor("ko", "integrity"), "프로필 미지정=무결성(기존 호출 전부 무회귀)");
const coreDef = cl.baseDefaultsFor("ko", "core");
ok(cl.saveBaseDirective({ verifyBaseline: "코어 커스텀 원칙", transmit: coreDef.transmit, rejudge: coreDef.rejudge }, "ko", "core") === true, "core 저장 성공(편집 개방)");
ok(cl.loadBaseDirective("ko", "core").verifyBaseline === "코어 커스텀 원칙", "core 오버라이드 반영");
ok(cl.loadBaseDirective("ko").verifyBaseline === def.verifyBaseline, "무결성 슬롯 무침투(프로필 격리 — 서로의 오버라이드를 덮지 않음)");
ok(!fs2.existsSync(cl.baseDirectiveFileFor("ko", "integrity")) || JSON.stringify(cl.loadBaseDirective("ko")) === JSON.stringify({ verifyBaseline: def.verifyBaseline, transmit: def.transmit, rejudge: def.rejudge }), "무결성 파일 바이트 불변(core 저장이 건드리지 않음)");
console.log("[기계 서식 분리] 문안을 어떻게 바꿔도 판정·지적 블록 서식은 전달본에 항상 동봉");
const vbC = cl.verifierBaselineFor("ko", "core");
ok(vbC.startsWith("코어 커스텀 원칙") && vbC.includes("[응답 서식") && vbC.includes("[지적 목록 v1]") && /맨 마지막 한 줄/.test(vbC), "서식 문구를 전부 지운 오버라이드에도 코드 고정 서식이 뒤에 동봉(판독 불파괴)");
ok(cl.verifierBaselineFor("en", "integrity").includes("[findings v1]"), "영문·무결성도 동일(프로필·언어 무관 단일 계약)");
ok(cl.resetBaseDirective("ko", "core") === true && cl.loadBaseDirective("ko", "core").verifyBaseline === coreDef.verifyBaseline, "core 복원=core 파일만(무결성 오버라이드 보존)");
{ // 실전달 배선: codex-bridge 조립부가 verifierBaselineFor를 쓰는지(소스 계약 — 우회 조립 재발 차단)
  const cbSrc = fs2.readFileSync(require("path").join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ok(cbSrc.includes("verifierBaselineFor(lang, profile)") && !cbSrc.includes("loadBaseDirective(lang, profile).verifyBaseline"), "withContract 조립=verifierBaselineFor 경유(서식 동봉이 전달 경로에 실재)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
