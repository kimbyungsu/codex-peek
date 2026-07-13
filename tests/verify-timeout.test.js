// 검증 대기시간(verifyTimeoutMin) 회귀 테스트.
// P2: 깊은 추론이 기본 8분을 넘을 때 사용자가 늘릴 수 있어야 한다.
// 우선순위(env > links.settings > 기본 8)와 1~60분 클램프를 고정한다.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vt_"));
process.env.CODEX_BRIDGE_HOME = dir;
delete process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN; // 깨끗한 시작
const { updateLinks, verifyTimeoutMin, minimumCallerTimeoutMs } = require("../bridge/codex-bridge.js");
const { buildVerifyDirective } = require("../bridge/contract-lib.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };
const setSetting = (v) => updateLinks((o) => { o.settings = o.settings || {}; o.settings.verifyTimeoutMin = v; });

console.log("[1] 기본값 — 설정·환경변수 없으면 8분");
ck("기본 8", verifyTimeoutMin() === 8);

console.log("[2] links.json settings의 임의 값이 모든 대기 경계에 반영");
setSetting(7);
ck("설정 7 → 7", verifyTimeoutMin() === 7);
ck("직접 호출 timeout도 같은 7분", minimumCallerTimeoutMs() === 7 * 60 * 1000);
let directive = buildVerifyDirective("code", "ko");
ck("구현자 지시에도 현재 7분 표시", directive.includes("검증 대기시간(7분)"));
ck("외부 호출창과 분리된 ask-start/ask-wait 사용", directive.includes("ask-start") && directive.includes("ask-wait"));
setSetting(23);
ck("설정 23 → 23", verifyTimeoutMin() === 23);
ck("직접 호출 timeout도 같은 23분", minimumCallerTimeoutMs() === 23 * 60 * 1000);
directive = buildVerifyDirective("always", "en");
ck("영문 구현자 지시에도 현재 23 min 표시", directive.includes("verification wait (23 min)"));
process.env.CODEX_BRIDGE_VERIFY_DEADLINE_AT = new Date(Date.now()+2500).toISOString();
const remaining=minimumCallerTimeoutMs();
ck("내구 job 절대 deadline이 분 설정값보다 우선", remaining>0&&remaining<=2500);
delete process.env.CODEX_BRIDGE_VERIFY_DEADLINE_AT;

console.log("[3] 클램프(1~60) — 설정값");
setSetting(100);
ck("100 → 60(상한)", verifyTimeoutMin() === 60);
setSetting(0);
ck("0(>0 아님) → 기본 8", verifyTimeoutMin() === 8);
setSetting("abc");
ck("숫자 아님 → 기본 8", verifyTimeoutMin() === 8);
setSetting(0.5);
ck("0.5 → 1(하한)", verifyTimeoutMin() === 1);
setSetting(2.6);
ck("2.6 → 3(정수 반올림)", verifyTimeoutMin() === 3);

console.log("[4] 환경변수가 settings보다 우선");
setSetting(23);
process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN = "15";
ck("env 15 > 설정 23 → 15", verifyTimeoutMin() === 15);
process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN = "100";
ck("env 100 → 60(상한)", verifyTimeoutMin() === 60);
process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN = "0";
ck("env 0(무효) → 설정 23으로 폴백", verifyTimeoutMin() === 23);
delete process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN;

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
