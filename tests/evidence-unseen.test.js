// 결정2-3(L1-A 개정): 인용 파일을 '이번 턴(마지막 사용자 메시지 이후)에 다룬 흔적'과 대조하는 citedFilesUnseen.
// 삼상태 계약: {checked:true, unseen:[...]}=검사 수행 / {checked:false}=판단 불가(세션 미식별·경계 미발견·도구활동 0 등)
// — 판단 불가를 '미확인 없음'과 구분(빈 배열 단일 반환은 소비자가 확인 성공으로 오독해 승격으로 흐름 — Codex 설계검증).
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
const userMsg = (txt) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: txt }] } });

const answer = "확인했습니다. (foo.ts:1) 과 (bar.ts:1) 을 봤습니다.";

console.log("[1] citedResolvedBasenames — 실재 인용 파일 basename 수집");
const bns = citedResolvedBasenames(answer, ws);
ck("foo.ts·bar.ts 둘 다 수집", bns.has("foo.ts") && bns.has("bar.ts") && bns.size === 2);

console.log("[2] 이번 턴에 foo만 등장 → bar는 '흔적 미확인'(checked=true)");
writeRollout("11111111-aaaa", [userMsg("검증 요청"), fc("cat foo.ts"), { type: "response_item", payload: { type: "function_call_output", output: "line1\nline2" } }]);
const r2 = citedFilesUnseen(answer, ws, "11111111-aaaa");
ck("검사 수행됨(checked=true)", r2.checked === true);
ck("foo.ts는 흔적 있음(미보고)", !r2.unseen.includes("foo.ts"));
ck("bar.ts는 흔적 미확인(보고)", r2.unseen.includes("bar.ts") && r2.unseen.length === 1);

console.log("[2-1] 턴 한정(Codex 반례) — '이전 턴'에서 다룬 파일은 이번 턴 근거로 인정 안 됨");
writeRollout("55555555-eeee", [
  userMsg("이전 턴 요청"), fc("cat foo.ts bar.ts"),          // 이전 턴: 둘 다 다룸
  userMsg("이번 턴 요청"), fc("cat foo.ts"),                  // 이번 턴: foo만
]);
const r21 = citedFilesUnseen(answer, ws, "55555555-eeee");
ck("세션 전체가 아니라 마지막 사용자 메시지 이후만 스캔 — bar는 미확인", r21.checked === true && r21.unseen.includes("bar.ts"));

console.log("[3] 이번 턴에 둘 다 등장 → 미확인 없음(checked=true)");
writeRollout("22222222-bbbb", [userMsg("검증 요청"), fc("rg -n pattern foo.ts bar.ts")]);
const r3 = citedFilesUnseen(answer, ws, "22222222-bbbb");
ck("둘 다 흔적 있음 → checked=true·unseen 빈 배열", r3.checked === true && r3.unseen.length === 0);

console.log("[4] 판단 불가 사유들 → checked=false(경보·승격 재료 아님)");
writeRollout("33333333-cccc", [userMsg("요청"), msg("foo.ts와 bar.ts를 봤습니다"), msg("끝")]);
ck("이번 턴 도구활동 없음 → checked=false", citedFilesUnseen(answer, ws, "33333333-cccc").checked === false);
writeRollout("66666666-ffff", [fc("cat foo.ts")]); // 사용자 메시지가 아예 없음 — 턴 경계 미발견
ck("턴 경계(사용자 메시지) 미발견 → checked=false(세션 전체를 근거로 안 씀)", citedFilesUnseen(answer, ws, "66666666-ffff").checked === false);
ck("sessionId 빈 문자열 → checked=false", citedFilesUnseen(answer, ws, "").checked === false);
ck("존재하지 않는 세션 → checked=false", citedFilesUnseen(answer, ws, "no-such-session-id").checked === false);

console.log("[5] 모호(실재 안 함) 인용은 대상 아님 → 미확인 없음");
const ansGhost = "(does-not-exist-xyz.ts:1) 참고";
writeRollout("44444444-dddd", [userMsg("요청"), fc("ls")]);
const r5 = citedFilesUnseen(ansGhost, ws, "44444444-dddd");
ck("실재 안 하는 인용 파일은 unseen 대상 아님", r5.checked === true && r5.unseen.length === 0);

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
