// 결정2-3: 인용 파일을 '이 검증 세션에서 다룬 흔적'을 rollout과 대조하는 citedFilesUnseen 회귀 테스트.
// 보수적(노랑·단정 금지): 도구활동 없음/세션 못 찾음 → 판단 보류(빈 배열). CODEX_HOME/CODEX_BRIDGE_HOME을 require 전 임시폴더로.
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ev_unseen_"));
process.env.CODEX_BRIDGE_HOME = home;
process.env.CODEX_HOME = home; // findRolloutById는 CODEX_HOME/sessions를 뒤진다
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ev_ws_"));
fs.writeFileSync(path.join(ws, "foo.ts"), "line1\nline2\n", "utf8"); // 인용 대상(실재)
fs.writeFileSync(path.join(ws, "bar.ts"), "line1\nline2\n", "utf8"); // 인용 대상(실재)

const { citedFilesUnseen, citedResolvedBasenames } = require("../bridge/codex-bridge.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

// rollout 파일 작성 헬퍼: sessions/rollout-<id>.jsonl
const SESS = path.join(home, "sessions");
fs.mkdirSync(SESS, { recursive: true });
const writeRollout = (id, lines) => { fs.writeFileSync(path.join(SESS, `rollout-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"), "utf8"); };
const fc = (cmd) => ({ type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: cmd }) } });
const msg = (txt) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: txt } });

const answer = "확인했습니다. (foo.ts:1) 과 (bar.ts:1) 을 봤습니다.";

console.log("[1] citedResolvedBasenames — 실재 인용 파일 basename 수집");
const bns = citedResolvedBasenames(answer, ws);
ck("foo.ts·bar.ts 둘 다 수집", bns.has("foo.ts") && bns.has("bar.ts") && bns.size === 2);

console.log("[2] foo만 명령에 등장 → bar는 '흔적 미확인'으로 잡힘");
writeRollout("11111111-aaaa", [fc("cat foo.ts"), { type: "response_item", payload: { type: "function_call_output", output: "line1\nline2" } }]);
const unseen = citedFilesUnseen(answer, ws, "11111111-aaaa");
ck("foo.ts는 흔적 있음(미보고)", !unseen.includes("foo.ts"));
ck("bar.ts는 흔적 미확인(보고)", unseen.includes("bar.ts"));
ck("미확인은 bar.ts 하나뿐", unseen.length === 1);

console.log("[3] 둘 다 명령/출력에 등장 → 아무것도 안 잡힘");
writeRollout("22222222-bbbb", [fc("rg -n pattern foo.ts bar.ts")]);
ck("둘 다 흔적 있음 → 빈 배열", citedFilesUnseen(answer, ws, "22222222-bbbb").length === 0);

console.log("[4] 도구활동 없는 세션 → 판단 보류(빈 배열)");
writeRollout("33333333-cccc", [msg("foo.ts와 bar.ts를 봤습니다"), msg("끝")]);
ck("function_call 없음 → 경보 안 함(이전 턴 맥락 가능)", citedFilesUnseen(answer, ws, "33333333-cccc").length === 0);

console.log("[5] 세션 없음/못 찾음 → 빈 배열");
ck("sessionId 빈 문자열 → []", citedFilesUnseen(answer, ws, "").length === 0);
ck("존재하지 않는 세션 → []", citedFilesUnseen(answer, ws, "no-such-session-id").length === 0);

console.log("[6] 모호(실재 안 함) 인용은 대상 아님 → 보고 안 함");
const ansGhost = "(does-not-exist-xyz.ts:1) 참고";
writeRollout("44444444-dddd", [fc("ls")]);
ck("실재 안 하는 인용 파일은 unseen 대상 아님", citedFilesUnseen(ansGhost, ws, "44444444-dddd").length === 0);

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
