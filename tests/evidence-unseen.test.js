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
let callSeq = 0;
const fc = (cmd, id = "call-" + (++callSeq)) => ({ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: id, arguments: JSON.stringify({ command: cmd }) } });
const fo = (id, output, exitCode = 0) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ exit_code: exitCode, output }) } });
const pair = (cmd, output, exitCode = 0) => { const id = "call-" + (++callSeq); return [fc(cmd, id), fo(id, output, exitCode)]; };
const customPair = (cmd, output, exitCode = 0) => {
  const id = "custom-" + (++callSeq);
  const input = `const r = await tools.exec_command({"cmd":${JSON.stringify(cmd)}}); text(r.output);`;
  const result = [{ type: "input_text", text: `Script completed\nOutput:\n${output}` }, { type: "input_text", text: `Exit code: ${exitCode}\nOutput:\n${output}` }];
  return [
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
  ];
};
const msg = (txt) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: txt } });
const userMsg = (txt) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: txt }] } });

const answer = "확인했습니다. (foo.ts:1) 과 (bar.ts:1) 을 봤습니다.";

console.log("[1] citedResolvedBasenames — 실재 인용 파일 basename 수집");
const bns = citedResolvedBasenames(answer, ws);
ck("foo.ts·bar.ts 둘 다 수집", bns.has("foo.ts") && bns.has("bar.ts") && bns.size === 2);
ck("0번 줄·역순 범위·파일 끝 초과 범위는 유효 인용이 아님", citedResolvedBasenames("(foo.ts:0) (bar.ts:2-1) (foo.ts:1-99)", ws).size === 0);
ck("파일 안의 정상 범위 인용은 유효", citedResolvedBasenames("(foo.ts:1-2)", ws).has("foo.ts"));

console.log("[2] 이번 턴에 foo만 등장 → bar는 '흔적 미확인'(checked=true)");
writeRollout("11111111-aaaa", [userMsg("검증 요청"), ...pair("cat foo.ts", "line1\nline2")]);
const r2 = citedFilesUnseen(answer, ws, "11111111-aaaa");
ck("검사 수행됨(checked=true)", r2.checked === true);
ck("foo.ts는 흔적 있음(미보고)", !r2.unseen.includes("foo.ts"));
ck("bar.ts는 흔적 미확인(보고)", r2.unseen.includes("bar.ts") && r2.unseen.length === 1);

console.log("[2-1] 턴 한정(Codex 반례) — '이전 턴'에서 다룬 파일은 이번 턴 근거로 인정 안 됨");
writeRollout("55555555-eeee", [
  userMsg("이전 턴 요청"), ...pair("cat foo.ts bar.ts", "line1\nline2"), // 이전 턴: 둘 다 다룸
  userMsg("이번 턴 요청"), ...pair("cat foo.ts", "line1\nline2"),         // 이번 턴: foo만
]);
const r21 = citedFilesUnseen(answer, ws, "55555555-eeee");
ck("세션 전체가 아니라 마지막 사용자 메시지 이후만 스캔 — bar는 미확인", r21.checked === true && r21.unseen.includes("bar.ts"));

console.log("[3] 이번 턴에 둘 다 등장 → 미확인 없음(checked=true)");
writeRollout("22222222-bbbb", [userMsg("검증 요청"), ...pair('rg -n "alpha|beta" foo.ts bar.ts', "foo.ts:1:line1\nbar.ts:1:line1")]);
const r3 = citedFilesUnseen(answer, ws, "22222222-bbbb");
ck("둘 다 흔적 있음 → checked=true·unseen 빈 배열", r3.checked === true && r3.unseen.length === 0);

console.log("[3-1] 이름 노출과 실제 내용 읽기 분리 — 출력·echo·rg --files는 취급 증거 아님");
writeRollout("abababab-output", [
  userMsg("검증 요청"),
  ...pair("rg --files", "foo.ts\nbar.ts"),
  fc("echo foo.ts bar.ts"),
]);
const r31 = citedFilesUnseen(answer, ws, "abababab-output");
ck("목록 출력·echo에 이름만 등장 → 두 파일 모두 흔적 미확인", r31.checked === true && r31.unseen.includes("foo.ts") && r31.unseen.includes("bar.ts"));

writeRollout("abababab-mixed", [userMsg("검증 요청"), ...pair("cat foo.ts; echo bar.ts", "line1\nbar.ts")]);
const r32 = citedFilesUnseen(answer, ws, "abababab-mixed");
ck("한 호출의 읽기·이름 출력 혼합 → 읽은 foo만 인정하고 echo의 bar는 미확인", r32.checked === true && !r32.unseen.includes("foo.ts") && r32.unseen.includes("bar.ts"));

writeRollout("abababab-echo-command", [userMsg("검증 요청"), fc("echo cat foo.ts; echo git show bar.ts")]);
const r33 = citedFilesUnseen(answer, ws, "abababab-echo-command");
ck("출력할 문자열 안의 cat·git show 글자는 실행된 읽기 명령이 아님", r33.checked === true && r33.unseen.includes("foo.ts") && r33.unseen.includes("bar.ts"));

writeRollout("abababab-empty", [userMsg("검증 요청"), ...pair("Get-Content foo.ts -TotalCount 0", "", 0)]);
const r34 = citedFilesUnseen(answer, ws, "abababab-empty");
ck("성공 코드여도 실제 반환 내용이 비면 읽은 증거가 아님", r34.checked === true && r34.unseen.includes("foo.ts"));
writeRollout("abababab-fail", [userMsg("검증 요청"), ...pair("Get-Content foo.ts -Encoding no-such-encoding", "encoding error", 1)]);
const r35 = citedFilesUnseen(answer, ws, "abababab-fail");
ck("오류 출력이 있어도 실패 종료면 읽은 증거가 아님", r35.checked === true && r35.unseen.includes("foo.ts"));
writeRollout("abababab-unrelated", [userMsg("검증 요청"), ...pair("Get-Content foo.ts", "unrelated text", 0)]);
const r36 = citedFilesUnseen(answer, ws, "abababab-unrelated");
ck("성공한 읽기 호출의 반환물이 인용 줄 내용과 무관하면 증거가 아님", r36.checked === true && r36.unseen.includes("foo.ts"));
writeRollout("abababab-custom", [userMsg("검증 요청"), ...customPair("Get-Content foo.ts", "line1\nline2", 0)]);
const r37 = citedFilesUnseen(answer, ws, "abababab-custom");
ck("functions.exec 중첩 명령도 호출 id·성공 출력·인용 내용이 결속되면 실제 읽기로 인정", r37.checked === true && !r37.unseen.includes("foo.ts"));
writeRollout("abababab-no-id", [
  userMsg("검증 요청"),
  { type: "response_item", payload: { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: "Get-Content foo.ts" }) } },
  { type: "response_item", payload: { type: "function_call_output", output: JSON.stringify({ exit_code: 0, output: "line1\nline2" }) } },
]);
const r38 = citedFilesUnseen(answer, ws, "abababab-no-id");
ck("호출 id가 없는 구형·불완전 사건은 순서로 짝짓지 않고 fail-closed", r38.checked === true && r38.unseen.includes("foo.ts"));

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

console.log("[6] 장기 세션 — 파일 전체가 16MiB를 넘어도 최신 턴 경계와 도구 흔적은 판독");
const largeId = "77777777-large";
const largeFile = path.join(SESS, `rollout-${largeId}.jsonl`);
fs.writeFileSync(largeFile, JSON.stringify(userMsg("아주 오래된 턴")) + "\n", "utf8");
fs.truncateSync(largeFile, 17 * 1024 * 1024); // 오래된 세션 본문을 희소 파일로 재현(메모리·디스크 낭비 없이 구형 16MiB 거부를 발동)
fs.appendFileSync(largeFile, "\n" + [userMsg("최신 검증 요청"), ...pair("rg -n pattern foo.ts bar.ts", "foo.ts:1:line1\nbar.ts:1:line1")].map((l) => JSON.stringify(l)).join("\n"), "utf8");
const r6 = citedFilesUnseen(answer, ws, largeId);
ck("오래된 이력 크기와 무관하게 최신 턴은 checked=true", r6.checked === true && r6.unseen.length === 0);

const cutId = "88888888-cut";
const cutFile = path.join(SESS, `rollout-${cutId}.jsonl`);
fs.writeFileSync(cutFile, JSON.stringify(userMsg("꼬리 범위 밖 사용자 경계")) + "\n", "utf8");
fs.truncateSync(cutFile, 17 * 1024 * 1024);
fs.appendFileSync(cutFile, "\n" + JSON.stringify(fc("cat foo.ts bar.ts")), "utf8");
ck("현재 턴 경계가 꼬리 범위 밖이면 과거 도구를 근거로 삼지 않고 checked=false", citedFilesUnseen(answer, ws, cutId).checked === false);

const alignedId = "99999999-aligned";
const alignedFile = path.join(SESS, `rollout-${alignedId}.jsonl`);
const prefix = JSON.stringify(userMsg("오래된 턴")) + "\n";
const alignedTurn = [userMsg("꼬리 시작과 정확히 맞은 최신 검증 요청"), ...pair("rg -n pattern foo.ts bar.ts", "foo.ts:1:line1\nbar.ts:1:line1")].map((l) => JSON.stringify(l)).join("\n") + "\n";
fs.writeFileSync(alignedFile, prefix + alignedTurn, "utf8");
fs.truncateSync(alignedFile, Buffer.byteLength(prefix) + 16 * 1024 * 1024); // tail 시작=최신 user 행 시작, 나머지는 희소 패딩
const aligned = citedFilesUnseen(answer, ws, alignedId);
ck("16MiB 꼬리가 완전한 user 행 시작에 맞으면 첫 행을 보존해 checked=true", aligned.checked === true && aligned.unseen.length === 0);

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
