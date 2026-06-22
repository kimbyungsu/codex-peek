// 검증 대기시간(verifyTimeoutMin) 회귀 테스트.
// P2: 깊은 추론이 기본 8분을 넘을 때 사용자가 늘릴 수 있어야 한다.
// 우선순위(env > links.settings > 기본 8)와 1~60분 클램프를 고정한다.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vt_"));
process.env.CODEX_BRIDGE_HOME = dir;
delete process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN; // 깨끗한 시작
const { updateLinks, verifyTimeoutMin } = require("../bridge/codex-bridge.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };
const setSetting = (v) => updateLinks((o) => { o.settings = o.settings || {}; o.settings.verifyTimeoutMin = v; });

console.log("[1] 기본값 — 설정·환경변수 없으면 8분");
ck("기본 8", verifyTimeoutMin() === 8);

console.log("[2] links.json settings 반영");
setSetting(20);
ck("설정 20 → 20", verifyTimeoutMin() === 20);

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
setSetting(20);
process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN = "15";
ck("env 15 > 설정 20 → 15", verifyTimeoutMin() === 15);
process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN = "100";
ck("env 100 → 60(상한)", verifyTimeoutMin() === 60);
process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN = "0";
ck("env 0(무효) → 설정 20으로 폴백", verifyTimeoutMin() === 20);
delete process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN;

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
