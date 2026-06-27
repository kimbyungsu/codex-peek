"use strict";
/*
 * withContract(prompt, ws) 워크스페이스 명시 로드 테스트 (V9) — node tests/withcontract.test.js.
 * cmdAsk가 넘기는 ws에 따라 'Codex 계약'이 그 프로젝트 것으로 로드되는지(cwd 암묵 의존이 아니라) 확인.
 * CODEX_BRIDGE_HOME을 require 전에 임시폴더로 지정 → 브릿지/계약 파일을 임시폴더에서 읽게 한다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc_"));
process.env.CODEX_BRIDGE_HOME = dir; // require 전에 설정해야 BRIDGE_DIR이 임시폴더로 잡힘
delete process.env.CLAUDE_PROJECT_DIR; // 명시 ws만으로 검증(폴백은 별도 케이스에서)

const { contractFileFor } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const { withContract } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js")); // require.main 가드라 CLI 안 돎

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const wsA = path.join(dir, "projA");
const wsB = path.join(dir, "projB");
fs.mkdirSync(path.dirname(contractFileFor(wsA)), { recursive: true }); // contracts 디렉터리
fs.writeFileSync(contractFileFor(wsA), JSON.stringify({ codex: ["V9_MARKER_A"], verifyMode: "off" }));
fs.writeFileSync(contractFileFor(wsB), JSON.stringify({ codex: ["V9_MARKER_B"], verifyMode: "off" }));

console.log("[1] 명시 ws에 따라 그 프로젝트 Codex 계약 로드");
const outA = withContract("MY_PROMPT", wsA);
const outB = withContract("MY_PROMPT", wsB);
ok(outA.includes("V9_MARKER_A") && !outA.includes("V9_MARKER_B"), "wsA → wsA 계약(MARKER_A)만");
ok(outB.includes("V9_MARKER_B") && !outB.includes("V9_MARKER_A"), "wsB → wsB 계약(MARKER_B)만");
ok(outA.includes("MY_PROMPT"), "프롬프트가 본문에 포함");

console.log("[2] ws 생략 시 workspace()(CLAUDE_PROJECT_DIR)로 폴백");
process.env.CLAUDE_PROJECT_DIR = wsB;
const outDefault = withContract("MY_PROMPT");
ok(outDefault.includes("V9_MARKER_B"), "ws 생략 → workspace()=wsB 계약 로드");
delete process.env.CLAUDE_PROJECT_DIR;

console.log("[3] 계약 없는 ws는 안전(빈 주입, 크래시 없음)");
const wsNone = path.join(dir, "projNone");
const outNone = withContract("MY_PROMPT", wsNone);
ok(typeof outNone === "string" && outNone.includes("MY_PROMPT"), "계약 없어도 baseline+프롬프트 반환");
ok(!outNone.includes("V9_MARKER_A") && !outNone.includes("V9_MARKER_B"), "다른 프로젝트 계약이 새지 않음");

console.log("[4] 전역 contract.json이 있어도 미설정 ws엔 상속 안 됨(계약=프로젝트 전용)");
fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify({ codex: ["GLOBAL_LEAK_MARKER"], verifyMode: "always" }));
const wsFresh = path.join(dir, "projFresh");
const outFresh = withContract("MY_PROMPT", wsFresh);
ok(!outFresh.includes("GLOBAL_LEAK_MARKER"), "전역 계약 규칙이 미설정 프로젝트에 새지 않음(상속 제거)");

console.log("[5] 빈 칸 프로젝트는 규칙 0·규칙 있는 프로젝트는 자기 규칙 — 프로젝트별 독립(A빈칸/B규칙 분리)");
const wsEmpty = path.join(dir, "projEmpty");
fs.writeFileSync(contractFileFor(wsEmpty), JSON.stringify({ codex: [], verifyMode: "off" }));
const outEmpty = withContract("MY_PROMPT", wsEmpty);
ok(!outEmpty.includes("V9_MARKER_") && !outEmpty.includes("GLOBAL_LEAK_MARKER"), "빈 계약 프로젝트 → 사용자 codex 규칙 0(baseline만)");
ok(withContract("MY_PROMPT", wsB).includes("V9_MARKER_B"), "동시에 wsB(규칙 있음)는 자기 규칙 그대로 주입 — A빈칸·B규칙 독립 적용");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
