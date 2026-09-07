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
fs.writeFileSync(path.join(ws, "foo.ts"), "line1\nline2\nfoo-only\n", "utf8"); // 인용 대상(실재) — 10판: 파일마다 고유 줄 하나(출력 소유권 판별)
fs.writeFileSync(path.join(ws, "bar.ts"), "line1\nline2\nbar-only\n", "utf8"); // 인용 대상(실재)

const { citedFilesUnseen, citedFilesUnseenExact, citedResolvedBasenames } = require("../bridge/codex-bridge.js");

// 2026-07-29 CI 실측: 윈도 러너의 임시 폴더는 짧은 이름(RUNNER~1)으로 오고, 인용에서 푼 파일 경로는
// 긴 이름이라 서로 다른 폴더로 계산돼 판독이 전부 미인정됐다. 같은 폴더를 다른 표기로 넘겨도 인정돼야 한다.
const wsAlias = (() => {
  try { const r = fs.realpathSync.native(ws); return r && r !== ws ? r : null; } catch { return null; }
})();

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

writeRollout("abababab-mixed", [userMsg("검증 요청"), ...pair("cat foo.ts; echo bar.ts", "line1\nline2\nfoo-only\nbar.ts")]);
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
// 2026-07-29 축 분리 → 2026-09-07 9판(blocker ab-3) 개정: 경보 축도 **출력에 그 파일의 실제 줄이 하나라도** 있어야 '다뤘다'.
// 07-29에는 '개수·해시만 출력해도 다룬 흔적'으로 봤지만, 성공 코드+비어 있지 않은 출력은 다른 문장의 출력일 수 있어
// (`Get-Content foo -TotalCount 0; Write-Output done`) 파일 내용 없이 경보가 해제됐다. 승격 축은 종전대로 인용 줄 내용이 실재해야 한다.
const r36w = citedFilesUnseen(answer, ws, "abababab-unrelated");
const r36s = citedFilesUnseenExact(answer, ws, "abababab-unrelated");
ck("반환물에 그 파일의 실제 줄이 없으면(unrelated text) 경보 축도 미인정(9판 개정)", r36w.checked === true && r36w.unseen.includes("foo.ts"));
ck("승격 축에도 남는다(인용 내용 대조 실패)", r36s.unseen.some((p) => p.endsWith("foo.ts")));
writeRollout("abababab-anyline", [userMsg("검증 요청"), ...pair("Get-Content foo.ts", "line2", 0)]);
const r36a = citedFilesUnseenExact(answer, ws, "abababab-anyline");
ck("인용 줄(1)이 아니어도 파일의 실제 줄(line2)이 출력에 있으면 경보 축은 인정·승격 축은 미인정", !r36a.unseenWeak.some((p) => p.endsWith("foo.ts")) && r36a.unseen.some((p) => p.endsWith("foo.ts")));
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

console.log("[3-6] 구분자 정규화(2026-08-03 실측) — 중첩 스크립트의 백슬래시 경로도 인정");
{
  // 실사고: 검증자 상시 습관 tools.shell_command({command:"Select-String -Path bridge\codex-bridge.js …"})
  // 에서 스크립트 원문의 \\(JSON 이스케이프)가 인수 정규화로 //가 되어 바늘(bridge/…)과 영원히 불일치
  // → 정직한 판독 회차마다 경보(매턴 반복 실측). 대조기 hit()이 양쪽 구분자를 접어 비교해야 한다.
  const wsDir = path.join(ws, "sub"); fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "deep.ts"), "line1\nline2\n", "utf8");
  const ansDeep = "확인. (sub/deep.ts:1) 참조.";
  // ① 중첩 단일 호출 + 백슬래시 경로(실제 rollout 형태 그대로)
  const idB = "bs-nested-" + (++callSeq);
  const inputB = 'const r = await tools.shell_command({command:"Select-String -Path sub\\\\deep.ts -Pattern \'x\' -Context 0,5 | ForEach-Object { (\'{0}:{1}\' -f $_.LineNumber,$_.Line) }","workdir":' + JSON.stringify(ws).replace(/\//g, "\\\\") + ',"timeout_ms":10000});\ntext(r);\n';
  writeRollout("eeeeeeee-bs-nested", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idB, input: inputB } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idB, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\n1:line1" }] } },
  ]);
  const wb = citedFilesUnseenExact(ansDeep, ws, "eeeeeeee-bs-nested");
  // 플랫폼 분기(확인 검증 blocker): POSIX에서 \는 파일명 문자 — 백슬래시 형태를 접어 인정하면 다른
  // 파일 동일시(과대 인정). win=인정 / POSIX=불인정 잔존이 각각 정답.
  if (process.platform === "win32") {
    ck("win: 중첩 스크립트 백슬래시 경로=약한 흔적 인정(경보 안 붙음)", wb.checked === true && !wb.unseenWeak.some((p) => p.endsWith("deep.ts")));
  } else {
    ck("posix: 백슬래시는 파일명 문자 — 다른 경로라 흔적 불인정 유지", wb.checked === true && wb.unseenWeak.some((p) => p.endsWith("deep.ts")));
  }
  ck("중첩 스크립트는 약한 축만(승격 축 불변)", wb.unseen.some((p) => p.endsWith("deep.ts")));
  // ② 하네스 기록 인수(강한 축)의 백슬래시 경로도 동일 인정
  const idB2 = "bs-direct-" + (++callSeq);
  writeRollout("eeeeeeee-bs-direct", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: idB2, arguments: JSON.stringify({ command: "cat sub\\deep.ts", workdir: ws }) } },
    fo(idB2, "line1"),
  ]);
  const wb2 = citedFilesUnseenExact(ansDeep, ws, "eeeeeeee-bs-direct");
  if (process.platform === "win32") {
    ck("win: 직접 인수 백슬래시 경로=강한 축 인정", wb2.checked === true && !wb2.unseen.some((p) => p.endsWith("deep.ts")));
  } else {
    ck("posix: cat sub\\deep.ts는 sub/deep.ts 판독이 아님 — 강한 축 불인정 유지", wb2.checked === true && wb2.unseen.some((p) => p.endsWith("deep.ts")));
  }
  // ③ 다른 파일을 읽은 경우는 여전히 경보(정규화가 과대 인정으로 새지 않음)
  const idB3 = "bs-other-" + (++callSeq);
  const inputB3 = 'const r = await tools.shell_command({command:"Select-String -Path sub\\\\other.ts -Pattern \'x\'","workdir":' + JSON.stringify(ws).replace(/\//g, "\\\\") + '});\ntext(r);\n';
  writeRollout("eeeeeeee-bs-other", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idB3, input: inputB3 } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idB3, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nok" }] } },
  ]);
  const wb3 = citedFilesUnseenExact(ansDeep, ws, "eeeeeeee-bs-other");
  ck("다른 파일 판독은 여전히 흔적 미확인(과대 인정 없음)", wb3.checked === true && wb3.unseenWeak.some((p) => p.endsWith("deep.ts")));
}

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

console.log("[3-2] 인식 창구의 경계(2026-07-28 확장 시도 3회 철회) — 목록 밖 명령은 인정하지 않는다");
{
  // 검증자 제시 반례: 파일을 전혀 읽지 않고 인용 줄을 합성 출력하면서 인수에만 파일명을 넣는 구성.
  // 최종 관문 3중(성공·비어있지 않음·인용 내용 실재)은 모두 통과하지만 '읽었다'는 증명이 아니다.
  const forge = 'node -e "console.log(' + "'line1'" + ')" foo.ts bar.ts';
  writeRollout("dddddddd-forge-node", [userMsg("검증 요청"), ...pair(forge, "line1")]);
  const rF = citedFilesUnseen(answer, ws, "dddddddd-forge-node");
  ck("임의 코드 실행기의 합성 출력=판독 아님(ab-3 위조 경로 차단)", rF.checked === true && rF.unseen.includes("foo.ts") && rF.unseen.includes("bar.ts"));

  writeRollout("dddddddd-forge-py", [userMsg("검증 요청"), ...pair('python -c "print(' + "'line1'" + ')" foo.ts', "line1")]);
  const rP = citedFilesUnseen(answer, ws, "dddddddd-forge-py");
  ck("python -c 합성 출력=판독 아님", rP.checked === true && rP.unseen.includes("foo.ts"));

  writeRollout("dddddddd-forge-loop", [userMsg("검증 요청"), ...pair('for f in foo.ts; do echo "line1"; done', "line1")]);
  const rL = citedFilesUnseen(answer, ws, "dddddddd-forge-loop");
  ck("제어문으로 감싼 합성 출력=판독 아님", rL.checked === true && rL.unseen.includes("foo.ts"));

  // 2차 반증: awk는 스크립트 인수로 파일을 안 읽고 출력을 만들 수 있어(BEGIN 블록) 목록 밖으로 유지.
  writeRollout("dddddddd-awk-forge", [userMsg("검증 요청"), ...pair("awk 'BEGIN{print \"line1\"}' foo.ts", "line1")]);
  const rAF = citedFilesUnseen(answer, ws, "dddddddd-awk-forge");
  ck("awk BEGIN 합성 출력=판독 아님(스크립트 인수를 받는 명령은 확장 제외)", rAF.checked === true && rAF.unseen.includes("foo.ts"));

  // 목록 확장은 3회 반증 끝에 전면 철회했다(표준 입력+비피연산자 경로 구성이 어떤 목록이든 통과 —
  // 한계는 목록이 아니라 '경로를 실제 입력 피연산자에 결속하지 못하는 판정 방식'. 보관함 b8e15bf229983ddb).
  // 아래는 철회 후에도 유지되는 계약: 목록 밖 명령은 인정하지 않는다.
  writeRollout("dddddddd-nl-out", [userMsg("검증 요청"), ...pair("nl foo.ts", "1	line1")]);
  const rN = citedFilesUnseen(answer, ws, "dddddddd-nl-out");
  ck("목록 밖 명령(nl)=미인정 — 확장 철회 상태 고정", rN.checked === true && rN.unseen.includes("foo.ts"));
}

console.log("[3-3] 문맥 보정(2026-07-28 실사고) — 인정 명령은 그대로, 못 알아보던 구문·폴더만 해소");
{
  // 실사고: 검증자가 정직하게 읽었는데도 매번 '근거 의심' 경보가 떴다. 실제 기록을 세어 보니 판독이
  // ①git 전역 설정 앞붙임 ②경로를 변수에 담아 읽기 ③브릿지를 띄운 폴더와 다른 폴더에서 상대경로 읽기
  // 세 형태였고 셋 다 인식에 실패했다. 아래는 그 세 형태의 실물과, 같은 보정으로 위조가 새지 않는다는 반례.
  const wsOther = fs.mkdtempSync(path.join(os.tmpdir(), "ev_other_"));
  const abs = path.join(ws, "foo.ts").replace(/\\/g, "/");
  const answerAbs = `확인했습니다. (${abs}:1) 을 봤습니다.`;
  const fcw = (cmd, workdir, id = "call-" + (++callSeq)) => ({ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: id, arguments: JSON.stringify({ command: cmd, workdir }) } });
  const pairW = (cmd, workdir, output, exitCode = 0) => { const id = "call-" + (++callSeq); return [fcw(cmd, workdir, id), fo(id, output, exitCode)]; };
  const seen = (id) => { const r = citedFilesUnseen(answerAbs, wsOther, id); return r.checked === true && r.unseen.length === 0; };
  const unseen = (id) => { const r = citedFilesUnseen(answerAbs, wsOther, id); return r.checked === true && r.unseen.includes("foo.ts"); };

  writeRollout("cccccccc-git-opts", [userMsg("검증 요청"), ...pairW(`git -c safe.directory=${ws} -C ${ws} show HEAD -- foo.ts`, wsOther, "line1")]);
  ck("git 전역 설정이 앞에 붙어도 판독으로 인정(경로 기준은 -C 로 지정한 저장소)", seen("cccccccc-git-opts"));

  writeRollout("cccccccc-var-read", [userMsg("검증 요청"), ...pairW("$p='foo.ts'; $lines=Get-Content -LiteralPath $p -Encoding utf8; for($i=0;$i -lt 2;$i++){ $lines[$i] }", ws, "line1\nline2")]);
  ck("경로를 변수에 담아 읽어도 인정(대입 접두 제거+같은 호출의 리터럴 대입 복원)", seen("cccccccc-var-read"));

  writeRollout("cccccccc-workdir", [userMsg("검증 요청"), ...pairW("Select-String -LiteralPath 'foo.ts' -Pattern 'line' -Encoding utf8", ws, "foo.ts:1:line1")]);
  ck("호출이 밝힌 작업 폴더 기준으로 상대경로 해석(브릿지를 띄운 폴더와 달라도 인정)", seen("cccccccc-workdir"));

  writeRollout("cccccccc-workdir-other", [userMsg("검증 요청"), ...pairW("Select-String -LiteralPath 'foo.ts' -Pattern 'line' -Encoding utf8", path.join(os.tmpdir(), "no-such-project-dir"), "line1")]);
  ck("무관한 폴더의 같은 이름 상대경로는 오귀속 금지(폴더가 다르면 미인정)", unseen("cccccccc-workdir-other"));

  // 1차 blocker③의 생산 경로 재현: 인용 대상은 A 폴더 파일인데 읽기는 B 폴더에서 일어났다.
  // 두 폴더에 내용이 같은 동명 파일이 있으면 최종 관문(인용 내용 실재)도 통과하므로, 기준 폴더를
  // 둘 다 열어 두면 B에서 읽고 A를 인정하는 오귀속이 생긴다.
  {
    const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ev_projB_"));
    fs.writeFileSync(path.join(wsB, "foo.ts"), "line1\nline2\n", "utf8");
    writeRollout("cccccccc-cross-proj", [userMsg("검증 요청"), ...pairW("Get-Content -LiteralPath foo.ts", wsB, "line1\nline2")]);
    const rX = citedFilesUnseen(answer, ws, "cccccccc-cross-proj"); // 인용은 A(ws) 기준 상대경로
    ck("B 폴더에서 읽은 동명 파일이 A 폴더 파일의 판독으로 둔갑하지 않음(작업 폴더를 밝히면 그 폴더만 기준)", rX.checked === true && rX.unseen.includes("foo.ts"));
  }

  // 1차 blocker①: 뒤에 나온 대입이 앞 문장에 소급되면, 없는 파일을 읽어 실패한 뒤 이름만 나중에
  // 붙여도 '읽었다'가 된다. 실행 순서를 지키는지 확인한다.
  writeRollout("cccccccc-var-late", [userMsg("검증 요청"), ...pairW("$p='does-not-exist'; Get-Content -LiteralPath $p -ErrorAction SilentlyContinue; Write-Output 'line1'; $p='foo.ts'", ws, "line1")]);
  ck("뒤에 나온 대입은 앞 판독 문장에 소급되지 않음(실행 순서 준수)", unseen("cccccccc-var-late"));

  writeRollout("cccccccc-var-overwrite", [userMsg("검증 요청"), ...pairW("$p='foo.ts'; $p=(Get-Random); Get-Content -LiteralPath $p", ws, "line1")]);
  ck("리터럴이 아닌 대입으로 덮이면 옛 값이 남지 않음(덮어쓴 뒤 판독은 미인정)", unseen("cccccccc-var-overwrite"));

  // 1차 blocker②: 주석 자리의 -C 는 경로 기준이 되면 안 된다(읽은 것은 저장소의 다른 파일뿐).
  {
    const wsC = fs.mkdtempSync(path.join(os.tmpdir(), "ev_projC_"));
    fs.writeFileSync(path.join(wsC, "foo.ts"), "line1\nline2\n", "utf8");
    const answerC = `확인했습니다. (${path.join(wsC, "foo.ts").replace(/\\/g, "/")}:1) 을 봤습니다.`; // 인용 대상은 '읽지 않은' 다른 폴더의 파일
    writeRollout("cccccccc-git-comment", [userMsg("검증 요청"), ...pairW(`git -c safe.directory=${ws} -C ${ws} grep -n line HEAD -- bar.ts # -C ${wsC} foo.ts`, wsOther, "line1")]);
    const rC = citedFilesUnseen(answerC, wsOther, "cccccccc-git-comment");
    ck("주석 자리의 -C 는 경로 기준이 되지 않음(옵션 구간에서 소비된 값만 인정)", rC.checked === true && rC.unseen.includes("foo.ts"));
  }

  writeRollout("cccccccc-var-forge", [userMsg("검증 요청"), ...pairW(`$x = node -e "console.log('line1')" foo.ts`, ws, "line1")]);
  ck("대입 오른쪽이 임의 실행기면 여전히 미인정(대입 접두 제거가 창구를 넓히지 않음)", unseen("cccccccc-var-forge"));

  writeRollout("cccccccc-git-exec", [userMsg("검증 요청"), ...pairW(`git -c diff.external=node -C ${ws} show HEAD -- foo.ts`, wsOther, "line1")]);
  ck("외부 프로그램을 부르는 git 설정(-c diff.external)은 미인정 — 허용 목록 밖", unseen("cccccccc-git-exec"));

  writeRollout("cccccccc-var-cmd", [userMsg("검증 요청"), ...pairW("$p=(Get-Random); Get-Content -LiteralPath $p", ws, "line1")]);
  ck("대입값이 리터럴이 아니면 경로로 풀지 않음(명령 결과가 경로로 둔갑 금지)", unseen("cccccccc-var-cmd"));

  writeRollout("cccccccc-stdin-forge", [userMsg("검증 요청"), ...pairW("Write-Output 'line1' | nl # foo.ts", ws, "1\tline1")]);
  ck("표준 입력을 받아 출력하는 목록 밖 명령은 여전히 미인정(3회 철회 계약 유지)", unseen("cccccccc-stdin-forge"));

  // 2차 blocker①: 중첩 셸 호출은 서로 다른 프로세스라 변수가 이어지지 않는다.
  {
    const id = "custom-cross-" + (++callSeq);
    const input = `const a = await tools.exec_command({"cmd":"$p='foo.ts'"}); const b = await tools.exec_command({"cmd":"Get-Content -LiteralPath $p; Write-Output 'line1'"}); text(b.output);`;
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1" }];
    writeRollout("cccccccc-cross-call", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rCC = citedFilesUnseen(answer, ws, "cccccccc-cross-call");
    ck("다른 셸 호출에서 정한 변수는 이어지지 않음(호출 경계 넘는 복원 금지)", rCC.checked === true && rCC.unseen.includes("foo.ts"));
  }

  // 사용자 실보고 2026-07-29: 실제 기록에서 판독이 '한 스크립트 안에 여러 호출을 담고 각 호출이 자기
  // 작업 폴더를 들고 있는' 형태로 왔다. 명령만 뽑고 폴더를 버리면 상대경로를 풀 기준이 없어 전부 미확인이 된다.
  {
    const id = "custom-nested-wd-" + (++callSeq);
    const input = "const calls = [\n  {\n    command: \"Select-String -LiteralPath 'foo.ts' -Pattern 'line' -Encoding utf8\",\n    workdir: " + JSON.stringify(ws) + ",\n    timeout_ms: 10000\n  }\n];\nconst results=await Promise.all(calls.map(c=>tools.shell_command(c)));results.forEach(r=>text(r));";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nfoo.ts:1:line1" }, { type: "input_text", text: "Exit code: 0\nOutput:\nfoo.ts:1:line1" }];
    writeRollout("cccccccc-nested-wd", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rNW = citedFilesUnseen(answerAbs, wsOther, "cccccccc-nested-wd");
    ck("한 스크립트 안 호출이 들고 온 자기 작업 폴더로 상대경로를 품(실보고 형태)", rNW.checked === true && rNW.unseen.length === 0);
  }
  {
    // 폴더가 다른 두 호출이 섞여도 서로의 폴더를 끌어다 쓰지 않는다(오귀속 금지).
    const id = "custom-nested-mix-" + (++callSeq);
    const other = path.join(os.tmpdir(), "no-such-mixed-dir");
    const input = "const calls = [\n  {\n    command: \"Select-String -LiteralPath 'foo.ts' -Pattern 'line'\",\n    workdir: " + JSON.stringify(other) + "\n  },\n  {\n    command: \"Get-Content -LiteralPath bar.ts\",\n    workdir: " + JSON.stringify(ws) + "\n  }\n];\nconst results=await Promise.all(calls.map(c=>tools.shell_command(c)));results.forEach(r=>text(r));";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1" }];
    writeRollout("cccccccc-nested-mix", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rMX = citedFilesUnseen(answerAbs, wsOther, "cccccccc-nested-mix");
    ck("다른 호출의 작업 폴더를 끌어와 인정하지 않음(호출별 폴더 격리)", rMX.checked === true && rMX.unseen.includes("foo.ts"));
  }

  {
    // 검증 1차 blocker①: 명령과 폴더가 **다른 객체**에 있으면 짝지으면 안 된다(글자 순서로만 묶으면
    // 무관한 객체의 폴더가 끌려와, 읽지도 않은 폴더의 동명 파일이 판독으로 집계된다).
    const id = "custom-stray-wd-" + (++callSeq);
    const input = "const real = { command: \"Get-Content -LiteralPath foo.ts\" };\nconst unrelated = { workdir: " + JSON.stringify(ws) + " };\nconst r = await tools.shell_command(real);";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("cccccccc-stray-wd", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rSW = citedFilesUnseen(answerAbs, wsOther, "cccccccc-stray-wd");
    ck("다른 객체에 놓인 폴더는 짝짓지 않음(소속 확인 불가=폴더 없음으로 처리)", rSW.checked === true && rSW.unseen.includes("foo.ts"));
  }

  {
    // 검증 2차 blocker: 주석으로 지운 폴더는 실행에 쓰이지 않는다.
    const id = "custom-cmt-wd-" + (++callSeq);
    const input = "const real = {\n  command: \"Get-Content -LiteralPath foo.ts\",\n  // workdir: " + JSON.stringify(ws) + "\n};\nawait tools.shell_command(real);";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("cccccccc-cmt-wd", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rCW = citedFilesUnseen(answerAbs, wsOther, "cccccccc-cmt-wd");
    ck("주석으로 지운 폴더는 결속하지 않음", rCW.checked === true && rCW.unseen.includes("foo.ts"));
  }
  {
    // 검증 2차 blocker: 같은 객체에 폴더가 둘이면 어느 것이 실제인지 알 수 없다 → 결속 포기.
    const id = "custom-dup-wd-" + (++callSeq);
    const other = path.join(os.tmpdir(), "no-such-dup-dir");
    const input = "const real = {\n  command: \"Get-Content -LiteralPath foo.ts\",\n  workdir: " + JSON.stringify(ws) + ",\n  workdir: " + JSON.stringify(other) + "\n};\nawait tools.shell_command(real);";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("cccccccc-dup-wd", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rDW = citedFilesUnseen(answerAbs, wsOther, "cccccccc-dup-wd");
    ck("같은 객체에 폴더가 둘이면 결속 포기(첫 값을 실제로 가정하지 않음)", rDW.checked === true && rDW.unseen.includes("foo.ts"));
  }
  {
    // 문자열 안에 적힌 글자는 속성이 아니다(명령 본문에 workdir: 이 들어간 형태).
    const id = "custom-str-wd-" + (++callSeq);
    const input = "const real = {\n  command: \"Write-Output 'workdir: " + ws.replace(/\\/g, "/") + "'; Get-Content -LiteralPath foo.ts\"\n};\nawait tools.shell_command(real);";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("cccccccc-str-wd", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rSW2 = citedFilesUnseen(answerAbs, wsOther, "cccccccc-str-wd");
    ck("명령 문자열 안에 적힌 workdir 글자는 속성으로 보지 않음", rSW2.checked === true && rSW2.unseen.includes("foo.ts"));
  }
  {
    // 무회귀: 속성 이름이 따옴표로 감싸인 정상 형태는 그대로 인정한다.
    const id = "custom-quoted-key-" + (++callSeq);
    const input = "const calls = [\n  {\n    \"command\": \"Get-Content -LiteralPath foo.ts\",\n    \"workdir\": " + JSON.stringify(ws) + "\n  }\n];\nconst results=await Promise.all(calls.map(c=>tools.shell_command(c)));results.forEach(r=>text(r));";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("cccccccc-quoted-key", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rQK = citedFilesUnseen(answerAbs, wsOther, "cccccccc-quoted-key");
    ck("따옴표로 감싼 속성 이름도 종전대로 인정(과잉 배제 회귀 방지)", rQK.checked === true && rQK.unseen.length === 0);
  }

  {
    // 검증 3차 blocker: 선언만 하고 쓰지 않은 객체의 명령은 실행된 적이 없다.
    const id = "custom-unused-obj-" + (++callSeq);
    const input = "const unused = {\n  command: \"Get-Content -LiteralPath foo.ts\",\n  workdir: " + JSON.stringify(ws) + "\n};\nconst actual = { command: \"Write-Output line1\" };\nawait tools.shell_command(actual);";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1" }];
    writeRollout("cccccccc-unused-obj", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rUO = citedFilesUnseen(answerAbs, wsOther, "cccccccc-unused-obj");
    ck("선언만 하고 쓰지 않은 객체의 명령은 판독 증거가 아님", rUO.checked === true && rUO.unseen.includes("foo.ts"));
  }
  {
    // 검증 3차 blocker: 정규식 안에 적힌 명령 표기도 실행된 적이 없다(객체 소속 자체가 없음).
    const id = "custom-regex-cmd-" + (++callSeq);
    const input = "const marker = /command: \"Get-Content -LiteralPath foo.ts\"/;\nawait tools.shell_command({ command: \"Write-Output line1\" });";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1" }];
    writeRollout("cccccccc-regex-cmd", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rRC = citedFilesUnseen(answerAbs, wsOther, "cccccccc-regex-cmd");
    ck("정규식 안에 적힌 명령 표기는 판독 증거가 아님", rRC.checked === true && rRC.unseen.includes("foo.ts"));
  }
  {
    // 무회귀: 괄호 바로 안에 놓인 객체(호출 인수)는 그대로 인정한다.
    const id = "custom-direct-arg-" + (++callSeq);
    const input = "await tools.shell_command({ command: \"Get-Content -LiteralPath foo.ts\", workdir: " + JSON.stringify(ws) + " });";
    const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("cccccccc-direct-arg", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
    ]);
    const rDA = citedFilesUnseen(answerAbs, wsOther, "cccccccc-direct-arg");
    ck("호출 인수 자리의 객체는 종전대로 인정(과잉 배제 회귀 방지)", rDA.checked === true && rDA.unseen.length === 0);
  }

  // 2차 blocker②: 주석에 적힌 경로는 그 명령이 읽은 대상일 수 없다(실제로 읽은 것은 미끼 파일뿐).
  fs.writeFileSync(path.join(ws, "decoy.txt"), "line1\nline2\n", "utf8");
  writeRollout("cccccccc-comment-path", [userMsg("검증 요청"), ...pairW("Get-Content -LiteralPath decoy.txt # foo.ts", ws, "line1\nline2")]);
  ck("판독 명령 주석에 적힌 경로는 인정하지 않음(주석은 명령의 일부가 아님)", unseen("cccccccc-comment-path"));
  writeRollout("cccccccc-hash-quoted", [userMsg("검증 요청"), ...pairW("Select-String -LiteralPath 'foo.ts' -Pattern '#해시는주석아님' -Encoding utf8", ws, "line1")]);
  ck("따옴표 안의 #은 주석이 아니라 인정 유지(과잉 절단 회귀 방지)", seen("cccccccc-hash-quoted"));
}

console.log("[3-4] 증거 세기 — 스크립트 글자는 경보를 끄되 신뢰 등급 승격에는 쓰지 않는다");
{
  // 검증 4왕복이 같은 벽에 부딪혀 내린 결론: 검증자가 '쓴' 스크립트 글자로는 어느 줄이 실행됐는지
  // 증명할 수 없다(실행 안 되는 분기·호출 아닌 이름 재사용 등). 그래서 스크립트에서 읽어낸 판독은
  // 경보를 끄는 데만 쓰고, 승격 재료로는 인정하지 않는다. 하네스가 기록한 도구 인수만 승격 가능.
  const id = "custom-weak-" + (++callSeq);
  const input = "const calls = [{ command: \"Get-Content -LiteralPath foo.ts\" }];\nconst r=await Promise.all(calls.map(c=>tools.shell_command(c)));text(r);";
  const result = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
  writeRollout("eeeeeeee-weak", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
  ]);
  const w = citedFilesUnseenExact(answer, ws, "eeeeeeee-weak");
  ck("스크립트에서 읽어낸 판독은 경보를 끈다(다룬 흔적 있음)", w.checked === true && !w.unseenWeak.includes(path.join(ws, "foo.ts")) && !w.unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("그러나 승격 축에는 남지 않는다(스크립트 글자는 실행을 증명하지 못함)", w.unseen.some((p) => p.endsWith("foo.ts")));

  // 하네스가 기록한 도구 인수는 종전대로 강한 증거다(무회귀).
  writeRollout("eeeeeeee-strong", [userMsg("검증 요청"), ...pair("cat foo.ts", "line1\nline2")]);
  const st = citedFilesUnseenExact(answer, ws, "eeeeeeee-strong");
  ck("도구 인수로 기록된 판독은 승격 축에서도 인정(무회귀)", st.checked === true && !st.unseen.some((p) => p.endsWith("foo.ts")) && !st.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 5차 blocker: 같은 세션에서 약한 판독이 **먼저** 오고 강한 판독이 뒤에 와도 강한 축이 확인돼야 한다
  // (경보 집합이 먼저 비었다고 멈추면 뒤의 직접 도구 판독을 잃는다).
  {
    const id2 = "custom-weak-first-" + (++callSeq);
    const input2 = "const calls = [{ command: \"Get-Content -LiteralPath foo.ts\" }];\nconst r=await Promise.all(calls.map(c=>tools.shell_command(c)));text(r);";
    const res2 = [{ type: "input_text", text: "Script completed\nOutput:\nline1\nline2" }, { type: "input_text", text: "Exit code: 0\nOutput:\nline1\nline2" }];
    writeRollout("eeeeeeee-order", [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id2, input: input2 } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id2, output: res2 } },
      ...pair("cat foo.ts", "line1\nline2"),
    ]);
    const od = citedFilesUnseenExact(answer, ws, "eeeeeeee-order");
    ck("약한 판독이 먼저여도 뒤의 직접 도구 판독이 승격 축에서 인정됨(순서 의존 회귀 차단)", od.checked === true && !od.unseen.some((p) => p.endsWith("foo.ts")) && !od.unseenWeak.some((p) => p.endsWith("foo.ts")));
  }
}

console.log("[3-5] 문맥 보정(2026-08-03 실측) — 명령 '문자열 배열' 스크립트의 판독도 약한 축으로 인정");
{
  // 실사고: 검증자가 exec에 const cmds=["git grep … -- 파일", …] 형태(이스케이프 따옴표 포함)로
  // 판독을 싣자, 문장 선두 판정이 스크립트 본문에 안 걸려 정직한 회차마다 '근거 의심'이 붙었다
  // (실측 12/12 오경보). 원시 인수에서 따옴표 리터럴을 풀어 '그 자체로 판독 명령'인 것만 약한 축에
  // 추가한다 — 승격 축은 불변(하네스 기록 인수만).
  const id = "cmds-arr-" + (++callSeq);
  // workdir는 실제 인용 파일이 있는 ws로 결속(가짜 폴더면 결속 검사가 정당하게 미인정 — 아래 반례가 그 케이스)
  const input = 'const cmds=[\n  "git -c safe.directory=D:/x grep -n -B 2 -A 4 \\"패턴 A + B\\" -- foo.ts",\n  "node tools/run.js bar.ts"\n];\nconst rs=await Promise.allSettled(cmds.map(command=>tools.shell_command({command,workdir:' + JSON.stringify(ws) + ',timeout_ms:30000})));';
  const result = [{ type: "input_text", text: "Exit code: 0\nOutput:\nline1\nfoo-only" }]; // 10판: bar.ts가 같은 호출에 지목돼 공통 줄은 근거가 아님 → foo 고유 줄
  writeRollout("eeeeeeee-cmdsarr", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: result } },
  ]);
  const w = citedFilesUnseenExact(answer, ws, "eeeeeeee-cmdsarr");
  ck("배열 리터럴 안 git grep 판독=약한 흔적 인정(이스케이프 따옴표 무해 — 경보 안 붙음)", w.checked === true && !w.unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("승격 축은 불변 — 스크립트 글자는 여전히 승격 불가", w.unseen.some((p) => p.endsWith("foo.ts")));
  ck("리터럴이어도 목록 밖 명령(node …)은 인정 안 함 — bar.ts는 흔적 미확인 유지(과대 인정 차단)", w.unseenWeak.some((p) => p.endsWith("bar.ts")));

  // 재검증 blocker 반례 잠금 ①: 선언만 하고 shell_command와 연결되지 않은 배열은 미인정
  const idU = "cmds-arr-unused-" + (++callSeq);
  const inputU = 'const unusedArr=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nawait tools.shell_command({ command: "Write-Output line1", workdir: ' + JSON.stringify(ws) + ' });';
  writeRollout("eeeeeeee-arr-unused", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idU, input: inputU } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idU, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nline1" }] } },
  ]);
  const wu = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-unused");
  ck("실행 호출과 연결 안 된 배열 리터럴은 미인정 — 경보 유지(미실행 문자열 거짓 해제 차단)", wu.checked === true && wu.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재검증 blocker 반례 잠금 ②: workdir가 다른 폴더면 동명 파일이라도 미인정(교차 프로젝트 오인 차단)
  const idX = "cmds-arr-xwd-" + (++callSeq);
  const inputX = 'const cmds=[\n  "git -c safe.directory=D:/other grep -n \\"p\\" -- foo.ts"\n];\nconst rs=await Promise.allSettled(cmds.map(command=>tools.shell_command({command,workdir:"D:\\\\other-project",timeout_ms:30000})));';
  writeRollout("eeeeeeee-arr-xwd", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idX, input: inputX } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idX, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nfoo" }] } },
  ]);
  const wx = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-xwd");
  ck("타 폴더 workdir에 결속된 배열 판독은 이 프로젝트 동명 파일을 해제하지 못함", wx.checked === true && wx.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재검증 blocker 반례 잠금 ③: 서로 다른 workdir 복수 → 스캔 중단(fail-closed — 경보 유지)
  const idM = "cmds-arr-multiwd-" + (++callSeq);
  const inputM = 'const cmds=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nawait tools.shell_command({command:cmds[0],workdir:' + JSON.stringify(ws) + '});\nawait tools.shell_command({command:"Write-Output hi",workdir:"D:\\\\other"});';
  writeRollout("eeeeeeee-arr-multiwd", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idM, input: inputM } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idM, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nfoo" }] } },
  ]);
  const wm = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-multiwd");
  ck("workdir가 여럿(모호)이면 스캔 중단 — 경보 유지(fail-closed)", wm.checked === true && wm.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재확인 반례 잠금 ④: 키를 따옴표로 쓴 "workdir":"타 폴더"도 결속 대상 — 미인식이면 결속 우회
  const idQ = "cmds-arr-qwd-" + (++callSeq);
  const inputQ = 'const cmds=[\n  "git -c safe.directory=D:/o grep -n \\"p\\" -- foo.ts"\n];\nconst rs=await Promise.allSettled(cmds.map(command=>tools.shell_command({"command":command,"workdir":"D:\\\\other-project"})));';
  writeRollout("eeeeeeee-arr-qwd", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idQ, input: inputQ } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idQ, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nx" }] } },
  ]);
  const wq = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-qwd");
  ck('따옴표 키("workdir")의 타 폴더 결속도 인식 — 이 프로젝트 동명 파일 해제 안 됨', wq.checked === true && wq.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재확인 반례 잠금 ⑤: console.log(이름); 뒤 별개 shell_command 근접은 '사용'이 아님(표현식 연결·인수 참조만)
  const idL = "cmds-arr-log-" + (++callSeq);
  const inputL = 'const cmds=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nconsole.log(cmds);\nawait tools.shell_command({ command: "Write-Output line1", workdir: ' + JSON.stringify(ws) + ' });';
  writeRollout("eeeeeeee-arr-log", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idL, input: inputL } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idL, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nline1" }] } },
  ]);
  const wl = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-log");
  ck("로그 출력 근접은 사용이 아님 — 미실행 배열의 경보 거짓 해제 차단", wl.checked === true && wl.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재확인 반례 잠금 ⑥: 호출이 '끝난 뒤' 로그의 이름 — 고정 창이면 인수로 오인, 괄호 균형이면 탈락
  const idA = "cmds-arr-after-" + (++callSeq);
  const inputA = 'const cmds=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nawait tools.shell_command({ command: "Write-Output line1", workdir: ' + JSON.stringify(ws) + ' });\nconsole.log(cmds);';
  writeRollout("eeeeeeee-arr-after", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idA, input: inputA } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idA, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nline1" }] } },
  ]);
  const wa = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-after");
  ck("호출 종료 뒤 로그의 이름은 인수 참조가 아님(괄호 균형 한정) — 경보 유지", wa.checked === true && wa.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재확인 반례 잠금 ⑦: 변수형 workdir(리터럴로 안 풀림) — 폴백 금지·스캔 중단(fail-closed)
  const idV = "cmds-arr-varwd-" + (++callSeq);
  const inputV = 'const root="D:\\\\other" + suffix;\nconst cmds=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nawait Promise.all(cmds.map(command=>tools.shell_command({ command, workdir: root })));';
  writeRollout("eeeeeeee-arr-varwd", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idV, input: inputV } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idV, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nx" }] } },
  ]);
  const wv = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-varwd");
  ck("workdir 키가 있는데 리터럴로 안 풀리면 요청 폴더로 폴백하지 않음 — 경보 유지(fail-closed)", wv.checked === true && wv.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 재확인 반례 잠금 ⑧: 키와 콜론 사이 공백 변형(workdir : root · "workdir" : root)도 키로 인식
  for (const [suffix, wdExpr] of [["sp", "workdir : root"], ["qsp", '"workdir" : root']]) {
    const idS = "cmds-arr-wdsp-" + suffix + "-" + (++callSeq);
    const inputS = 'const root="D:\\\\other" + suffix;\nconst cmds=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nawait Promise.all(cmds.map(command=>tools.shell_command({ command, ' + wdExpr + ' })));';
    writeRollout("eeeeeeee-arr-wdsp-" + suffix, [
      userMsg("검증 요청"),
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idS, input: inputS } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idS, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nx" }] } },
    ]);
    const wsx = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-wdsp-" + suffix);
    ck("공백 변형(" + wdExpr + ")도 workdir 키로 인식 — 폴백 없이 경보 유지", wsx.checked === true && wsx.unseenWeak.some((p) => p.endsWith("foo.ts")));
  }

  // 재확인 반례 잠금 ⑨: 같은 workdir를 두 호출에 반복 명시한 '정상' 스크립트는 오차단 금지
  const idR = "cmds-arr-samewd-" + (++callSeq);
  const wdJson = JSON.stringify(ws);
  const inputR = 'const cmds=[\n  "git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"\n];\nawait Promise.all(cmds.map(command=>tools.shell_command({ command, workdir: ' + wdJson + ' })));\nawait tools.shell_command({ command: "Write-Output done", workdir: ' + wdJson + ' });';
  writeRollout("eeeeeeee-arr-samewd", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idR, input: inputR } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idR, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nline1" }] } },
  ]);
  const wr = citedFilesUnseenExact(answer, ws, "eeeeeeee-arr-samewd");
  ck("같은 workdir 반복 명시=정상 인정 — foo.ts 판독 흔적 유지(키수 vs 리터럴 매치수 비교)", wr.checked === true && !wr.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // 2026-08-03 실측 잔여: git blame -L은 파일을 읽지 않고는 출력 불가(cat·grep 동일 의미론) — 목록 편입
  writeRollout("eeeeeeee-blame", [userMsg("검증 요청"), ...pair("git -c safe.directory=D:/x blame -L 1,2 HEAD -- foo.ts", "line1\nline2")]);
  const wb = citedFilesUnseenExact(answer, ws, "eeeeeeee-blame");
  ck("git blame 직접 호출=판독 인정(경보 축)", wb.checked === true && !wb.unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("git blame 직접 호출+인용 내용 실재=승격 축도 인정(의미론 기준 확장)", !wb.unseen.some((p) => p.endsWith("foo.ts")));
  // 객체 배열({command:"git blame …",workdir:…}) 형태 — 실제 검증자 관용구(2026-08-03 rollout 실측)
  const idB = "cmds-obj-blame-" + (++callSeq);
  const inputB = 'const cmds=[\n  {command: "git -c safe.directory=D:/x blame -L 1,2 HEAD -- foo.ts", workdir: ' + JSON.stringify(ws) + ', timeout_ms: 10000}\n];\nconst rs=await Promise.all(cmds.map(c=>tools.shell_command(c)));';
  writeRollout("eeeeeeee-obj-blame", [
    userMsg("검증 요청"),
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: idB, input: inputB } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: idB, output: [{ type: "input_text", text: "Exit code: 0\nOutput:\nline1" }] } },
  ]);
  const wob = citedFilesUnseenExact(answer, ws, "eeeeeeee-obj-blame");
  ck("객체 배열 안 git blame도 약한 흔적 인정 — 경보 안 붙음", wob.checked === true && !wob.unseenWeak.some((p) => p.endsWith("foo.ts")));

  // ab-3 반례(확인 검증 2회분): 옵션으로 '대상 경로+임의 내용'을 위조하는 경로 전부 인식 거부(fail-closed)
  const FORGE_CMDS = [
    ["blame-contents", "git -c safe.directory=D:/x blame --contents bar.ts -L 1,1 HEAD -- foo.ts"],
    ["blame-quoted", 'git blame "--contents" bar.ts -L 1,1 HEAD -- foo.ts'],
    ["blame-abbrev", "git blame --conten=bar.ts -L 1,1 HEAD -- foo.ts"],
    ["show-format", 'git show --no-patch --format=format:"line1" abc1234 -- foo.ts'],
    ["diff-lineprefix", 'git diff --line-prefix="line1" HEAD -- foo.ts'],
    ["blame-envvar", "$env:OPT='--contents'; git blame $env:OPT bar.ts -L 1,1 HEAD -- foo.ts"],
    ["blame-subexpr", "git blame $('--contents') bar.ts -L 1,1 HEAD -- foo.ts"],
    ["show-optarray", "$opts=@('--no-patch','--format=format:line1'); git show $opts abc1234 -- foo.ts"],
    ["blame-bareparen", "git blame ('--contents') bar.ts -L 1,1 HEAD -- foo.ts"],
    ["show-castarray", "git show ([string[]]('--no-patch','--format=format:line1')) abc1234 -- foo.ts"],
  ];
  for (const [tag, cmd] of FORGE_CMDS) {
    writeRollout(`eeeeeeee-${tag}`, [userMsg("검증 요청"), ...pair(cmd, "line1")]);
    const wc = citedFilesUnseenExact(answer, ws, `eeeeeeee-${tag}`);
    ck(`${tag}=인식 거부 — 승격 축에 남음(위조 차단)`, wc.unseen.some((p) => p.endsWith("foo.ts")));
    ck(`${tag}=경보 축에도 흔적 불인정`, wc.checked === true && wc.unseenWeak.some((p) => p.endsWith("foo.ts")));
  }
  // 허용목록 안의 정상 형태는 유지: show REV -- path · diff -U0 · grep -n
  const OK_CMDS = [
    ["show-plain", "git show HEAD -- foo.ts"],
    ["diff-u0", "git diff -U0 HEAD -- foo.ts"],
    ["grep-n", 'git grep -n "line1" -- foo.ts'],
  ];
  for (const [tag, cmd] of OK_CMDS) {
    writeRollout(`eeeeeeee-${tag}`, [userMsg("검증 요청"), ...pair(cmd, "line1")]);
    const wk = citedFilesUnseenExact(answer, ws, `eeeeeeee-${tag}`);
    ck(`${tag}=정상 형태 인식 유지 — 경보 안 붙음`, wk.checked === true && !wk.unseenWeak.some((p) => p.endsWith("foo.ts")));
  }
}

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

console.log("[6-2] 실사용에서 나온 판독 형태(2026-07-29 실측) — 괄호로 감싼 이력 조회");
{
  // 실측: 검증자가 `$t = (git show <판>:<경로>)` 로 과거 내용을 값으로 받아 개수만 출력했다.
  // 괄호 하나 때문에 같은 git 조회가 통째로 안 보였고, 그 파일이 매번 '흔적 미확인'으로 남았다.
  // 9판 개정(blocker ab-3): 괄호 판독은 그대로 인식하되, 개수만 출력한 호출은 내용을 받지 못했으므로 흔적이 아니다 — 내용을 출력하면 인정.
  writeRollout("ffffffff-paren", [userMsg("검증 요청"), ...pair("$t = (git -c safe.directory=" + ws + " -C " + ws + " show HEAD:foo.ts); 'hits=' + $t.Length", "hits=12")]);
  const rp = citedFilesUnseen(answer, ws, "ffffffff-paren");
  ck("괄호로 감싼 이력 조회라도 개수만 출력하면 흔적 아님(9판: 내용 없는 성공 출력=경보 유지)", rp.checked === true && rp.unseen.includes("foo.ts"));
  writeRollout("ffffffff-paren-out", [userMsg("검증 요청"), ...pair("$t = (git -c safe.directory=" + ws + " -C " + ws + " show HEAD:foo.ts); $t", "line1\nline2")]);
  const rpo = citedFilesUnseen(answer, ws, "ffffffff-paren-out");
  ck("괄호로 감싼 이력 조회가 내용을 출력하면 '다룬 흔적'으로 인정(경보 축 — 괄호 인식 무회귀)", rpo.checked === true && !rpo.unseen.includes("foo.ts"));
  // 1차 [보완]: 괄호를 벗기는 자리가 두 곳(판독 판정·기준 폴더 수집)이라 한쪽만 고치면,
  // 실행 폴더가 저장소와 다를 때 -C 로 준 기준이 사라져 경보가 그대로 남는다.
  {
    const other2 = path.join(os.tmpdir(), "no-such-exec-dir");
    const id2 = "call-pc-" + (++callSeq);
    const call2 = { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: id2, arguments: JSON.stringify({ command: "$t = (git -C " + ws + " show HEAD:foo.ts); $t", workdir: other2 }) } };
    writeRollout("ffffffff-paren-c", [userMsg("검증 요청"), call2, fo(id2, "line1\nline2")]);
    const rc2 = citedFilesUnseen(answer, ws, "ffffffff-paren-c");
    ck("괄호 안 git -C 저장소도 경로 기준으로 인정(실행 폴더가 달라도 경보 없음 — 내용 출력 시)", rc2.checked === true && !rc2.unseen.includes("foo.ts"));
  }
  // 압축 파일 안에서 꺼낸 것은 저장소 파일을 읽은 것이 아니므로 종전대로 미인정이어야 한다.
  writeRollout("ffffffff-tar", [userMsg("검증 요청"), ...pair("tar -xOf bundle.zip 'pkg/foo.ts'", "line1\nline2")]);
  const rt = citedFilesUnseen(answer, ws, "ffffffff-tar");
  ck("압축 파일에서 꺼낸 것은 저장소 파일 판독으로 인정하지 않음", rt.checked === true && rt.unseen.includes("foo.ts"));
}

console.log("[7] 같은 폴더의 다른 표기(짧은 이름 등)로 기준을 줘도 판독을 인정한다");
{
  // 기준 폴더 표기가 인용 경로 표기와 달라도 실제로 같은 폴더면 인정해야 한다.
  writeRollout("ffffffff-alias", [userMsg("검증 요청"), ...pair("cat foo.ts", "line1\nline2")]);
  const viaSelf = citedFilesUnseen(answer, ws, "ffffffff-alias");
  ck("기본 표기로는 종전대로 인정", viaSelf.checked === true && !viaSelf.unseen.includes("foo.ts"));
  if (wsAlias) {
    const viaAlias = citedFilesUnseen(answer, wsAlias, "ffffffff-alias");
    ck("다른 표기(실제 경로)로 줘도 인정 — CI 윈도 짧은 이름 실사고 차단", viaAlias.checked === true && !viaAlias.unseen.includes("foo.ts"));
  } else {
    ck("(이 환경은 폴더의 다른 표기가 없어 건너뜀 — CI 윈도에서 실측됨)", true);
  }
}

// 실패했을 때만 내부 상태를 찍는다. 2026-07-29에 이 파일이 CI 윈도에서만 무더기로 실패했는데 로컬
// 어디서도 재현되지 않아 이 출력으로 원인(임시 폴더의 짧은 이름 표기)을 찾았다. 같은 부류의 환경 차이가
// 다시 생길 수 있어 남겨 둔다 — 통과할 때는 아무것도 찍지 않는다.
if (fail > 0) {
  try {
    const B = require("../bridge/codex-bridge.js");
    console.log("[진단] platform=" + process.platform + " node=" + process.version);
    console.log("[진단] ws=" + JSON.stringify(ws) + " home=" + JSON.stringify(home));
    console.log("[진단] tmpdir=" + JSON.stringify(os.tmpdir()) + " cwd=" + JSON.stringify(process.cwd()));
    console.log("[진단] foo 내용=" + JSON.stringify(fs.readFileSync(path.join(ws, "foo.ts"), "utf8")));
    console.log("[진단] basenames=" + JSON.stringify([...B.citedResolvedBasenames(answer, ws)]));
    console.log("[진단] exact=" + JSON.stringify(B.citedFilesUnseenExact(answer, ws, "11111111-aaaa")));
    console.log("[진단] 세션파일=" + JSON.stringify(fs.readdirSync(SESS)));
  } catch (e) { console.log("[진단] 실패: " + (e && e.message)); }
}

console.log("[6] 반복 억제 술어(2026-08-21) — 같은 세션 미ack 동일 사유 경보의 재발행 금지");
{
  const { shouldSuppressUnseenRepeat } = require("../bridge/codex-bridge.js");
  const S = "impl-1", W = "d:/ws-a";
  const evOpen = { kind: "evidence-unseen", ack: false, implId: S, session: "legacy-x", workspace: W, files: ["a.js", "b.js", "c.js"] };
  ck("미ack 경보가 새 집합을 전부 덮음=억제", shouldSuppressUnseenRepeat([evOpen], S, W, ["a.js", "b.js"]) === true);
  ck("새 파일 포함=억제 안 함(새 사유)", shouldSuppressUnseenRepeat([evOpen], S, W, ["a.js", "z.js"]) === false);
  ck("ack된 경보=대상 아님(재발생은 새 경보 정당)", shouldSuppressUnseenRepeat([{ ...evOpen, ack: true }], S, W, ["a.js"]) === false);
  ck("타 신원 경보=대상 아님", shouldSuppressUnseenRepeat([{ ...evOpen, implId: "impl-other" }], S, W, ["a.js"]) === false);
  ck("files 없는 구형 이벤트=비교 불가·억제 안 함(보수)", shouldSuppressUnseenRepeat([{ kind: "evidence-unseen", ack: false, implId: S, workspace: W }], S, W, ["a.js"]) === false);
  ck("빈 집합=억제 판단 자체 없음", shouldSuppressUnseenRepeat([evOpen], S, W, []) === false);
  // R2 blocker(f-7f21c6a4): 신원 미상·전역 장부 반례 — C-C 경로에서 빈 세션끼리 매칭돼 타 창 경보가 가리던 오억제
  ck("★빈 신원(미상)=억제 금지(빈 문자열끼리 매칭 오억제 반례의 정방향)", shouldSuppressUnseenRepeat([{ ...evOpen, implId: "" }], "", W, ["a.js"]) === false);
  // R3 blocker: 억제 키=implId 전용 — legacy session이 stale Claude 세션으로 남아 일치해도(C-C 전환 반례)
  // implId가 다르면 억제하지 않는다.
  ck("★legacy session 일치+implId 불일치=억제 금지(stale Claude 세션 오인 반례의 정방향)", shouldSuppressUnseenRepeat([{ ...evOpen, session: "stale-claude", implId: "impl-old" }], "impl-new", W, ["a.js"]) === false);
  ck("implId 없는 구형 이벤트=session이 일치해도 억제 안 함(보수)", shouldSuppressUnseenRepeat([{ kind: "evidence-unseen", ack: false, session: "impl-1", workspace: W, files: ["a.js"] }], "impl-1", W, ["a.js"]) === false);
  ck("★타 workspace 경보=대상 아님(전역 장부 교차 억제 차단)", shouldSuppressUnseenRepeat([{ ...evOpen, workspace: "d:/ws-b" }], S, W, ["a.js"]) === false);
  ck("빈 workspace=억제 금지(결속 불가)", shouldSuppressUnseenRepeat([evOpen], S, "", ["a.js"]) === false);
}

console.log("[7] 지문 결속 재발행 억제 술어(2026-08-27) — resolved 재확인 결속·실경로 지문(1차 검증 blocker①② 반례 포함)");
{
  const { shouldSuppressUnseenAcked } = require("../bridge/codex-bridge.js");
  const S = "impl-1", W = "d:/ws-a";
  const PA = "d:/ws-a/src/a.js", PB = "d:/ws-a/lib/b.js";
  const acked = { id: "ev-1", kind: "evidence-unseen", ack: true, implId: S, workspace: W, files: ["a.js", "b.js"], filesFp: { [PA]: "fp-a", [PB]: "fp-b" } };
  const R = new Set(["ev-1"]); // 재확인이 resolved로 끝난 이벤트 집합
  ck("resolved 결속 ack+전 경로 지문 일치=억제", shouldSuppressUnseenAcked([acked], S, W, { [PA]: "fp-a", [PB]: "fp-b" }, R) === true);
  ck("부분집합(현 의심이 더 적음)도 지문 일치면 억제", shouldSuppressUnseenAcked([acked], S, W, { [PA]: "fp-a" }, R) === true);
  ck("★blocker① 반례: 일반 확인 ack(resolved 집합 밖)=억제 금지", shouldSuppressUnseenAcked([acked], S, W, { [PA]: "fp-a" }, new Set()) === false);
  ck("★blocker② 반례: 타 경로 동명·동내용 파일=억제 금지(실경로 키)", shouldSuppressUnseenAcked([acked], S, W, { "d:/ws-a/tests/a.js": "fp-a" }, R) === false);
  ck("★지문 하나라도 다르면(파일 변경) 억제 금지=새 경보 정당", shouldSuppressUnseenAcked([acked], S, W, { [PA]: "fp-a", [PB]: "fp-CHANGED" }, R) === false);
  ck("미ack 경보=이 술어 대상 아님(기존 미ack 억제가 별도 담당)", shouldSuppressUnseenAcked([{ ...acked, ack: false }], S, W, { [PA]: "fp-a" }, R) === false);
  ck("id 없는 구형 이벤트=resolved 결속 불가·억제 안 함(보수)", shouldSuppressUnseenAcked([{ ...acked, id: undefined }], S, W, { [PA]: "fp-a" }, R) === false);
  ck("filesFp 없는 구형 ack 이벤트=비교 불가·억제 안 함(보수)", shouldSuppressUnseenAcked([{ ...acked, filesFp: undefined }], S, W, { [PA]: "fp-a" }, R) === false);
  ck("현 지문 결손(빈 값 포함)=억제 금지(범위 밖·판독 실패 보수)", shouldSuppressUnseenAcked([acked], S, W, { [PA]: "" }, R) === false);
  ck("타 신원=억제 금지", shouldSuppressUnseenAcked([acked], "impl-other", W, { [PA]: "fp-a" }, R) === false);
  ck("타 workspace=억제 금지", shouldSuppressUnseenAcked([acked], S, "d:/ws-b", { [PA]: "fp-a" }, R) === false);
  ck("빈 신원·빈 ws=억제 금지", shouldSuppressUnseenAcked([acked], "", "", { [PA]: "fp-a" }, R) === false);
  ck("빈 지도=판단 없음", shouldSuppressUnseenAcked([acked], S, W, {}, R) === false);
  ck("resolved 집합 미전달=억제 금지(보수 기본값)", shouldSuppressUnseenAcked([acked], S, W, { [PA]: "fp-a" }) === false);
}

console.log("[8] 발행 정책 실행(2026-08-27 매 턴 반복 경고 봉합) — 지문 저장·전량 범위 밖 자동 확인");
{
  const B = require("../bridge/codex-bridge.js");
  const crypto = require("crypto");
  const INTEG = path.join(home, "integrity.json");
  const readEvs = () => { try { return JSON.parse(fs.readFileSync(INTEG, "utf8")).events || []; } catch { return []; } };
  // 동결의 안전 구간 선택은 최소 크기(CH_MIN_ELIGIBLE) 미만 파일을 no-safe-span으로 건너뛴다 —
  // 소형 foo.ts(12B)로는 pending 지문이 안 생기므로, 이 그룹은 충분히 큰 별도 파일로 검사한다.
  const ws8 = fs.mkdtempSync(path.join(os.tmpdir(), "ev_ws8_"));
  const big = (seed) => Array.from({ length: 40 }, (_, i) => `const ${seed}_v${i} = compute_${seed}(${i}, "payload-${seed}-${i}");`).join("\n") + "\n";
  fs.writeFileSync(path.join(ws8, "foo8.ts"), big("foo"), "utf8");
  fs.writeFileSync(path.join(ws8, "bar8.ts"), big("bar"), "utf8");
  const answer8 = "확인했습니다. (foo8.ts:1) 과 (bar8.ts:1) 을 봤습니다.";
  const chCtx = { roots: [ws8], promptText: "검증 프롬프트", mode: "claude-codex", lang: "ko", campaignId: "cl:test", askId: "ask-test-1" };
  // A) 정상 경보: 인용 파일이 이번 턴 기록에 없음 → 경보 생성 + filesFp(내용 sha256) 저장 + 미ack
  writeRollout("88888888-fp", [userMsg("검증 요청"), ...pair("echo hi", "hi")]);
  const rA = B.flagEvidence(answer8, ws8, "88888888-fp", ws8, chCtx);
  ck("A: 경보 생성(eventId)", !!(rA && rA.eventId));
  const evA = readEvs().find((e) => e.id === (rA && rA.eventId));
  ck("A: 미ack(배너 대상)", !!evA && evA.ack !== true);
  const shaFoo = crypto.createHash("sha256").update(fs.readFileSync(path.join(ws8, "foo8.ts"))).digest("hex");
  const fpKeys = evA && evA.filesFp ? Object.keys(evA.filesFp) : [];
  const keyFoo = fpKeys.find((k) => /foo8\.ts$/.test(k)), keyBar = fpKeys.find((k) => /bar8\.ts$/.test(k));
  ck("A: filesFp 키=실경로(basename 아님)+내용 지문 저장(동결 fileSha와 동형)", !!evA && !!keyFoo && !!keyBar && keyFoo !== "foo8.ts" && evA.filesFp[keyFoo] === shaFoo);
  // A-2) 저장 지문×술어 왕복(스키마 드리프트 잠금): resolved 결속 ack=억제 / 같은 이벤트라도 일반 확인
  //   ack(resolved 집합 밖)=억제 금지(blocker① 실행 반례). implId는 이벤트 실물 값으로 왕복.
  const implA = String((evA && evA.implId) || "") || "impl-x";
  const evAforPred = { ...evA, ack: true, implId: implA, workspace: ws8 };
  const RA = new Set([evA && evA.id]);
  ck("A-2: resolved 결속 ack=억제", B.shouldSuppressUnseenAcked([evAforPred], implA, ws8, evA.filesFp, RA) === true);
  ck("A-2b: ★일반 확인 ack(resolved 밖)=억제 금지(blocker① 반례)", B.shouldSuppressUnseenAcked([evAforPred], implA, ws8, evA.filesFp, new Set()) === false);
  // A-3) 파일 변경=지문 불일치 → 억제 금지(파일이 바뀌면 새 의심 정당)
  const fpChanged = { ...evA.filesFp, [keyFoo]: crypto.createHash("sha256").update("changed").digest("hex") };
  ck("A-3: 지문 변경=억제 금지", B.shouldSuppressUnseenAcked([evAforPred], implA, ws8, fpChanged, RA) === false);
  // D) 전량 범위 밖(roots가 다른 폴더) → 자동 확인 기록(ack 사전 설정·배너 제외·행동 불필요 문구)
  //   A가 남긴 미ack 경보의 기존 반복 억제(같은 ws·같은 파일 집합)에 걸리지 않게 별도 ws로 검사한다.
  const ws9 = fs.mkdtempSync(path.join(os.tmpdir(), "ev_ws9_"));
  fs.writeFileSync(path.join(ws9, "foo9.ts"), big("nine"), "utf8");
  const answer9 = "확인했습니다. (foo9.ts:1) 을 봤습니다.";
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ev_other_"));
  writeRollout("99999999-nd", [userMsg("검증 요청"), ...pair("echo hi", "hi")]);
  const rD = B.flagEvidence(answer9, ws9, "99999999-nd", ws9, { ...chCtx, roots: [otherRoot], askId: "ask-test-2" });
  ck("D: 이벤트는 남되(기록 보존) 반환에 autoAcked", !!(rD && rD.eventId && rD.autoAcked === true));
  const evD = readEvs().find((e) => e.id === (rD && rD.eventId));
  ck("D: ack 사전 설정=배너 제외", !!evD && evD.ack === true && evD.autoAcked === "no-dispatch");
  ck("D: 문구에 '행동 불필요' 명시(ko/en)", !!evD && /행동 불필요/.test(evD.detailKo || "") && /no action needed/.test(evD.detailEn || ""));
  // D-2) ★blocker③ 반례: 지원 범위인데 판독 못 한 no-dispatch(no-safe-span 등)는 자동 확인 금지=배너 유지
  const ws9b = fs.mkdtempSync(path.join(os.tmpdir(), "ev_ws9b_"));
  fs.writeFileSync(path.join(ws9b, "tiny.ts"), "line1\n", "utf8"); // 최소 크기 미만 → no-safe-span
  writeRollout("aaaaaaaa-ns", [userMsg("검증 요청"), ...pair("echo hi", "hi")]);
  const rD2 = B.flagEvidence("확인. (tiny.ts:1) 봤습니다.", ws9b, "aaaaaaaa-ns", ws9b, { ...chCtx, roots: [ws9b], askId: "ask-test-3" });
  const evD2 = readEvs().find((e) => e.id === (rD2 && rD2.eventId));
  ck("D-2: ★in-root 판독 불가(no-safe-span)=자동 확인 금지·배너 유지(blocker③ 반례)", !!evD2 && evD2.ack !== true && !(rD2 && rD2.autoAcked));
  // 배선 핀: 동결 계산이 이벤트 기록보다 앞·사전 ack는 out-of-root 전원일 때만·억제는 resolved 집합 결속
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ck("배선: 동결 선행 후 지문 지도·no-dispatch 판정", /frozen = ech0\.freezeChallenge\(/.test(src) && /frozen\.state === "no-dispatch"/.test(src));
  ck("배선: 사전 ack 조건=skipped 전원 out-of-root", /frozen\.files\.every\(\(f\) => f && f\.status === "skipped" && f\.reason === "out-of-root"\)/.test(src));
  ck("배선: 지문 억제는 noDispatch 아닐 때+전 파일 지문 보유 시만", /if \(!noDispatch && fpMap && Object\.keys\(fpMap\)\.length === unseen\.length\)/.test(src));
  ck("배선: 억제 전 resolved 챌린지 eventId 집합을 실장부에서 수집", /rc\.state === "resolved" && echS\.eventFullyResolved\(rc\) && rc\.eventId/.test(src));
}

console.log("[3-7] 판독 형태 드리프트 봉합(2026-09-06 실측 — D-2026-09-06-evidence-read-form-drift) — 실행 호출=계약 형태·PowerShell 리터럴 배열 foreach");
{
  const B7 = require("../bridge/codex-bridge.js");
  const exec7 = (input, output = "Exit code: 0\nOutput:\nline1") => { const id = "drift-" + (++callSeq); return [
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: output }] } },
  ]; };
  const GREP_FOO = '"git -c safe.directory=D:/x grep -n \\"p\\" -- foo.ts"';
  // (a) 실측 형태 ⓐ: const cmds=[…]; for (const cmd of cmds) { await tools.exec_command({cmd,workdir}) } — 개명된 함수 이름·단축 속성
  writeRollout("d7a", [userMsg("검증 요청"), ...exec7('const cmds = [\n  ' + GREP_FOO + '\n];\nfor (const cmd of cmds) {\n  const r=await tools.exec_command({cmd,workdir:' + JSON.stringify(ws) + ',yield_time_ms:10000,max_output_tokens:9000,login:false});\n  text(JSON.stringify(r));\n}')]);
  const wa = citedFilesUnseenExact(answer, ws, "d7a");
  ck("(a) exec_command+for-of 단축 속성 {cmd,…}: 배열 판독=약한 흔적 인정(경보 안 붙음)", wa.checked === true && !wa.unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("(a) 승격 축 불변 — 스크립트 글자는 여전히 승격 불가", wa.unseen.some((p) => p.endsWith("foo.ts")));
  ck("(a) 배열에 없는 bar.ts는 그대로 미확인", wa.unseenWeak.some((p) => p.endsWith("bar.ts")));
  // (b) cmds.map(c => tools.exec_command({cmd: c, workdir})) — 표현식 연결
  writeRollout("d7b", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nconst rs=await Promise.all(cmds.map(c=>tools.exec_command({cmd:c,workdir:' + JSON.stringify(ws) + '})));')]);
  const wb = citedFilesUnseenExact(answer, ws, "d7b");
  ck("(b) exec_command 표현식 연결도 인정", wb.checked === true && !wb.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (c) 반례: 명령 키 없는 호출(helper(cmds))은 실행 호출이 아님 — 별개 실행 호출이 근접해도 미인정
  writeRollout("d7c", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nhelper(cmds);\nawait tools.exec_command({cmd:"Write-Output line1",workdir:' + JSON.stringify(ws) + '});')]);
  const wc = citedFilesUnseenExact(answer, ws, "d7c");
  ck("(c) 명령 키 없는 호출에 넘긴 배열은 미인정 — 경보 유지(거짓 해제 차단)", wc.checked === true && wc.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (d) 반례: 개명 뒤에도 console.log(cmds); 근접은 사용이 아님(기존 ⑤ 계약 유지)
  writeRollout("d7d", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nconsole.log(cmds);\nawait tools.exec_command({cmd:"Write-Output line1",workdir:' + JSON.stringify(ws) + '});')]);
  const wd = citedFilesUnseenExact(answer, ws, "d7d");
  ck("(d) console.log(cmds); 근접은 사용 아님 — 경보 유지", wd.checked === true && wd.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (e) 실측 형태 ⓑ: PowerShell 해시 배열 + foreach + Get-Content -LiteralPath $t.p
  const ps1 = "$targets = @(\n  @{p='foo.ts'; a=1; b=2}\n)\nforeach ($t in $targets) {\n  Write-Output (\"@@ \" + $t.p + \":\" + $t.a)\n  $i=0; Get-Content -LiteralPath $t.p | ForEach-Object { $i++; if($i -ge $t.a -and $i -le $t.b){ \"${i}:$_\" } }\n}";
  writeRollout("d7e", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps1) + ', workdir: ' + JSON.stringify(ws) + ', yield_time_ms: 30000});\ntext(r.output);')]);
  const we = citedFilesUnseenExact(answer, ws, "d7e");
  ck("(e) PowerShell 해시 배열 foreach의 Get-Content $t.p=약한 흔적 인정", we.checked === true && !we.unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("(e) 승격 축 불변(전개 변형은 약한 축)", we.unseen.some((p) => p.endsWith("foo.ts")));
  // (f) PowerShell 문자열 배열 foreach — 두 파일 모두(구역 표시 줄 `@@ 파일명` 뒤 본문 — 10판 출력 소유권: 내용이 같은 두 파일은 이름 표시로 갈린다)
  const ps2 = "$files = @('foo.ts','bar.ts'); foreach ($f in $files) { \"@@ $f\"; Get-Content -LiteralPath $f }";
  writeRollout("d7f", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps2) + ', workdir: ' + JSON.stringify(ws) + '});\ntext(r.output);', "Exit code: 0\nOutput:\n@@ foo.ts\nline1\nline2\n@@ bar.ts\nline1\nline2")]);
  const wf = citedFilesUnseenExact(answer, ws, "d7f");
  ck("(f) PowerShell 문자열 배열 foreach=두 파일 모두 약한 흔적 인정(구역 표시 줄로 소유 판별)", wf.checked === true && wf.unseenWeak.length === 0);
  writeRollout("d7f2", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify("$files = @('foo.ts','bar.ts'); foreach ($f in $files) { Get-Content -LiteralPath $f }") + ', workdir: ' + JSON.stringify(ws) + '});\ntext(r.output);', "Exit code: 0\nOutput:\nline1\nline2\nline1\nline2")]);
  const wf2 = citedFilesUnseenExact(answer, ws, "d7f2");
  ck("(f2) 이름 표시 없이 한 호출에서 읽고 출력에 공통 줄만 있으면 둘 다 흔적 아님(10판 경계)", wf2.checked === true && wf2.unseenWeak.length === 2);
  // (g) 반례: 비리터럴 배열($files = Get-ChildItem …)은 값 불명 — 미인정
  const ps3 = "$files = Get-ChildItem *.ts; foreach ($f in $files) { Get-Content -LiteralPath $f }";
  writeRollout("d7g", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps3) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wg = citedFilesUnseenExact(answer, ws, "d7g");
  ck("(g) 비리터럴 배열 foreach는 미인정 — 경보 유지", wg.checked === true && wg.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (h) 반례: 배열 대입이 foreach 뒤에 있으면(실행 순서 위반) 미인정
  const ps4 = "foreach ($f in $files) { Get-Content -LiteralPath $f }; $files = @('foo.ts')";
  writeRollout("d7h", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps4) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wh = citedFilesUnseenExact(answer, ws, "d7h");
  ck("(h) foreach 뒤의 배열 대입은 소급 안 됨 — 경보 유지", wh.checked === true && wh.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (i) 반례: 배열 원소에 변수가 섞이면 배열 전체 미인정
  const ps5 = "$x='foo.ts'; $files = @($x,'bar.ts'); foreach ($f in $files) { Get-Content -LiteralPath $f }";
  writeRollout("d7i", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps5) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wi = citedFilesUnseenExact(answer, ws, "d7i");
  ck("(i) 비리터럴 원소가 섞인 배열은 전체 미인정(옛 값 소급 없음)", wi.checked === true && wi.unseenWeak.some((p) => p.endsWith("foo.ts")) && wi.unseenWeak.some((p) => p.endsWith("bar.ts")));
  // (k) 실측 (e) 반례에서 드러난 별개 결함: 인라인 cmd 문자열에 이스케이프 따옴표(\")가 있으면 정규화본(백슬래시→/)에서 JSON 경계가 깨져
  //     명령 전체가 사라졌다 → 중첩 추출은 원시 인수에서. rg -n "패턴" 파일 같은 가장 흔한 판독이 이 경우였다.
  writeRollout("d7k", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "git -c safe.directory=D:/x grep -n \\"p q\\" -- foo.ts", workdir: ' + JSON.stringify(ws) + '});')]);
  const wk = citedFilesUnseenExact(answer, ws, "d7k");
  ck("(k) 이스케이프 따옴표가 든 인라인 cmd 판독도 인정(원시 인수에서 추출)", wk.checked === true && !wk.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (l) ★1판 blocker ab-3 반례: 명령 키만 있고 도구 이름공간이 아닌 사용자 함수(stash({cmd:cmds}))는 실행 호출이 아니다
  writeRollout("d7l", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nfunction stash(x){}\nstash({cmd:cmds});\nawait tools.exec_command({cmd:"Write-Output done",workdir:' + JSON.stringify(ws) + '});')]);
  const wl = citedFilesUnseenExact(answer, ws, "d7l");
  ck("(l) ★명령 키를 가진 임의 함수(stash({cmd:cmds}))는 흔적이 아님 — 경보 유지(ab-3 반례)", wl.checked === true && wl.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (m) ★1판 blocker ab-3 반례: 리터럴 배열 뒤 재대입($files=$null)은 값 불명 → foreach 전개 없음
  const ps6 = "$files=@('foo.ts','bar.ts'); $files=$null; foreach($f in $files){}; Get-Content -LiteralPath $f; Write-Output done";
  writeRollout("d7m", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps6) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wm = citedFilesUnseenExact(answer, ws, "d7m");
  ck("(m) ★리터럴 배열 뒤 재대입($null)=값 불명 — 두 파일 모두 경보 유지(ab-3 반례)", wm.checked === true && wm.unseenWeak.some((p) => p.endsWith("foo.ts")) && wm.unseenWeak.some((p) => p.endsWith("bar.ts")));
  // (n) ★치환은 foreach 본문 안에서만 — 루프 밖 Get-Content $f 는 리터럴로 둔갑하지 않는다
  const ps7 = "$files=@('foo.ts'); foreach($f in $files){ Write-Output $f }; Get-Content -LiteralPath $f";
  writeRollout("d7n", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps7) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wn = citedFilesUnseenExact(answer, ws, "d7n");
  ck("(n) ★foreach 본문 밖의 $f 는 치환되지 않음 — 경보 유지(ab-3 반례)", wn.checked === true && wn.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (o) 본문 안 판독은 여전히 인정(재대입이 foreach 뒤에 오면 무관)
  const ps8 = "$files=@('foo.ts'); foreach($f in $files){ Get-Content -LiteralPath $f }; $files=$null";
  writeRollout("d7o", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps8) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wo = citedFilesUnseenExact(answer, ws, "d7o");
  ck("(o) foreach 뒤의 재대입은 앞 루프에 영향 없음 — 본문 안 판독 인정", wo.checked === true && !wo.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (p) ★2판 blocker ab-3 반례: 명령 값과 무관한 자리(max_output_tokens:1000+cmds.length)의 배열 참조는 사용이 아님
  writeRollout("d7p", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd:"Write-Output done",workdir:' + JSON.stringify(ws) + ',max_output_tokens:1000+cmds.length});')]);
  const wp = citedFilesUnseenExact(answer, ws, "d7p");
  ck("(p) ★명령 값이 아닌 인수의 배열 참조=미인정 — 경보 유지(ab-3 반례)", wp.checked === true && wp.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (p-2) 명령 값이 배열 원소를 직접 참조하면 인정(cmds[0])
  writeRollout("d7p2", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});')]);
  ck("(p-2) 명령 값=cmds[0] 직접 참조는 인정", !citedFilesUnseenExact(answer, ws, "d7p2").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (p-3) 반복 변수가 루프 밖에서 쓰이면 미인정(끝난 루프의 이름)
  writeRollout("d7p3", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nlet cmd="Write-Output done";\nfor (const c of cmds) { }\nawait tools.exec_command({cmd,workdir:' + JSON.stringify(ws) + '});')]);
  ck("(p-3) 루프 밖 단축 속성 cmd는 배열에서 묶인 변수가 아님 — 경보 유지", citedFilesUnseenExact(answer, ws, "d7p3").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (q) ★2판 blocker ab-3 반례: 주석 속 배열 대입은 실행이 아님(`# …` · `<# … #>`)
  const ps9 = "# $files=@('foo.ts'); \nforeach($f in $files){ Get-Content -LiteralPath $f }; Write-Output done";
  writeRollout("d7q", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps9) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(q) ★줄 주석 속 대입=미인정 — 경보 유지(ab-3 반례)", citedFilesUnseenExact(answer, ws, "d7q").unseenWeak.some((p) => p.endsWith("foo.ts")));
  const ps9b = "<# $files=@('foo.ts') #> foreach($f in $files){ Get-Content -LiteralPath $f }";
  writeRollout("d7q2", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps9b) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(q-2) 블록 주석 속 대입=미인정", citedFilesUnseenExact(answer, ws, "d7q2").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (r) ★미실행 분기 안 대입(if($false){ … })=값 불명 — 최상위 대입만 인정
  const ps10 = "if($false){ $files=@('foo.ts') }; foreach($f in $files){ Get-Content -LiteralPath $f }";
  writeRollout("d7r", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps10) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(r) ★블록 안 대입=값 불명 — 경보 유지(ab-3 반례)", citedFilesUnseenExact(answer, ws, "d7r").unseenWeak.some((p) => p.endsWith("foo.ts")));
  const ps10b = "$files=@('foo.ts'); if($false){ $files=$null }; foreach($f in $files){ Get-Content -LiteralPath $f }";
  writeRollout("d7r2", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps10b) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(r-2) 블록 안 재대입은 값 불명으로 앞선 리터럴을 무효화(보수) — 경보 유지", citedFilesUnseenExact(answer, ws, "d7r2").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (s) [보완] PowerShell 변수명 대소문자 무시: $Files 대입 → $files 반복
  const ps11 = "$Files=@('foo.ts'); foreach($f in $files){ Get-Content -LiteralPath $F -TotalCount 1 }";
  writeRollout("d7s", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps11) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(s) 변수명 대소문자 무시($Files/$files·$f/$F)=인정", !citedFilesUnseenExact(answer, ws, "d7s").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (t) ★3판 blocker ab-3 반례: 명령 값 식에 이름이 '등장'만 하는 죽은 조건식(false?cmds[0]:'…')은 미인정 — 값 식은 ARR[첨자] 또는 반복 변수 그 자체만
  writeRollout("d7t", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd:false?cmds[0]:"Write-Output done",workdir:' + JSON.stringify(ws) + '});')]);
  ck("(t) ★죽은 조건식 속 배열 참조=미인정 — 경보 유지(ab-3 반례)", citedFilesUnseenExact(answer, ws, "d7t").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (t-2) reduce의 첫 매개변수는 누산기 — 원소 아님
  writeRollout("d7t2", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nawait cmds.reduce(async (acc, item) => { await acc; return tools.exec_command({cmd: acc, workdir: ' + JSON.stringify(ws) + '}); }, "Write-Output done");')]);
  ck("(t-2) ★reduce 누산기=배열 원소 아님 — 경보 유지(ab-3 반례)", citedFilesUnseenExact(answer, ws, "d7t2").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (t-3) 반복 변수를 호출 전에 재대입하면 더는 배열 원소가 아님
  writeRollout("d7t3", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nfor (let c of cmds) { c = "Write-Output done"; await tools.exec_command({cmd:c,workdir:' + JSON.stringify(ws) + '}); }')]);
  ck("(t-3) ★호출 전 재대입된 반복 변수=미결속 — 경보 유지(ab-3 반례)", citedFilesUnseenExact(answer, ws, "d7t3").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (t-4) 정상 형태는 그대로 인정: for-of 반복 변수 그 자체 · map 콜백 매개변수 · cmds[i]
  writeRollout("d7t4", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd: cmds[0], workdir:' + JSON.stringify(ws) + '});')]);
  ck("(t-4) cmds[0] 상수 첨자 참조는 인정", !citedFilesUnseenExact(answer, ws, "d7t4").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7t4b", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nfor (let i = 0; i < cmds.length; i++) { await tools.exec_command({cmd: cmds[i], workdir:' + JSON.stringify(ws) + '}); }')]);
  ck("(t-4b) 변수 첨자 cmds[i]는 범위를 글자로 알 수 없어 미인정(5판 fail-closed)", citedFilesUnseenExact(answer, ws, "d7t4b").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (u) ★3판 blocker ab-3 반례: 문자열 안의 대입 문구(Write-Output "$files = @('…')")는 대입이 아님
  const ps12 = "Write-Output \"$files = @('foo.ts')\"; foreach($f in $files){ Get-Content -LiteralPath $f }; Write-Output done";
  writeRollout("d7u", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps12) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(u) ★문자열 속 대입 문구=미인정 — 경보 유지(ab-3 반례)", citedFilesUnseenExact(answer, ws, "d7u").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (u-2) 문자열이 섞여도 진짜 대입은 그대로 인정
  const ps13 = "$files=@('foo.ts'); Write-Output \"list: $files\"; foreach($f in $files){ Get-Content -LiteralPath $f }";
  writeRollout("d7u2", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps13) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  ck("(u-2) 문자열 출력이 섞여도 최상위 리터럴 대입은 인정", !citedFilesUnseenExact(answer, ws, "d7u2").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (v) ★4판 blocker: 지역 tools 그림자(const tools={exec_command:…})=실행 호출 계약 불성립 — 스크립트의 배열 경로 전체 미인정
  writeRollout("d7v", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\n{ const tools={exec_command:()=>({})}; tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '}); }\ntext("done");')]);
  ck("(v) ★지역 tools 그림자=미인정 — 경보 유지", citedFilesUnseenExact(answer, ws, "d7v").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (w) ★4판 blocker: 배열 재대입·원소 덮어쓰기·변이 메서드·별칭이 하나라도 있으면 미인정
  for (const [tag, code] of [
    ["w", 'let cmds=[' + GREP_FOO + '];\ncmds=["Write-Output done"];\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});'],
    ["w2", 'const cmds=[' + GREP_FOO + '];\ncmds[0]="Write-Output done";\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});'],
    ["w3", 'const cmds=[' + GREP_FOO + '];\nconst a=cmds; a[0]="Write-Output done";\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});'],
    ["w4", 'const cmds=[' + GREP_FOO + '];\ncmds.push("x"); cmds.shift();\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});'],
  ]) {
    writeRollout("d7" + tag, [userMsg("검증 요청"), ...exec7(code)]);
    ck("(" + tag + ") ★배열 쓰기/별칭/변이=미인정 — 경보 유지", citedFilesUnseenExact(answer, ws, "d7" + tag).unseenWeak.some((p) => p.endsWith("foo.ts")));
  }
  // (x) ★4판 blocker: 중복 cmd 키(마지막이 실행값)=그 호출 미인정
  writeRollout("d7x", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd:cmds[0],cmd:"Write-Output done",workdir:' + JSON.stringify(ws) + '});')]);
  ck("(x) ★중복 cmd 키=미인정 — 경보 유지", citedFilesUnseenExact(answer, ws, "d7x").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (y) ★4판 blocker: 주석·문자열 속 가짜 선언은 코드가 아님
  writeRollout("d7y", [userMsg("검증 요청"), ...exec7('let cmds=["Write-Output done"];\n/* const cmds=[' + GREP_FOO.replace(/"/g, "'") + ']; */\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});')]);
  ck("(y) ★블록 주석 속 선언=미인정 — 경보 유지", citedFilesUnseenExact(answer, ws, "d7y").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7y2", [userMsg("검증 요청"), ...exec7('const cmds=["Write-Output done"];\nconst note = "const cmds=[\\"git -c safe.directory=D:/x grep -n p -- foo.ts\\"];";\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});')]);
  ck("(y-2) ★문자열 속 선언=미인정 — 경보 유지", citedFilesUnseenExact(answer, ws, "d7y2").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (y-3) 정상 형태(실측: const cmds=[…]; for (const cmd of cmds) { … })는 그대로 인정 — 회귀 확인
  writeRollout("d7y3", [userMsg("검증 요청"), ...exec7('const cmds = [\n  ' + GREP_FOO + '\n];\nfor (const cmd of cmds) {\n  const r=await tools.exec_command({cmd,workdir:' + JSON.stringify(ws) + ',yield_time_ms:10000});\n  text(JSON.stringify(r)); // cmds 처리 로그\n}')]);
  ck("(y-3) 실측 형태(주석에 이름 등장 포함)는 인정", !citedFilesUnseenExact(answer, ws, "d7y3").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (z) ★5판 blocker 반례 6종
  for (const [tag, code, why] of [
    ["z1", 'const cmds=[' + GREP_FOO + '];\ncmds[0] &&= "Write-Output done";\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});', "논리 복합대입(&&=)"],
    ["z1b", 'const cmds=[' + GREP_FOO + '];\n[cmds[0]] = ["Write-Output done"];\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});', "구조 분해 대입"],
    ["z2", 'const cmds=[' + GREP_FOO + '];\ntools.exec_command &&= async()=>({output:"LOCAL_FAKE"});\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});', "tools 멤버 논리 대입"],
    ["z3", 'const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd:cmds[0],["cmd"]:"Write-Output done",workdir:' + JSON.stringify(ws) + '});', "계산된 cmd 키"],
    ["z4", 'const cmds=[/* ' + GREP_FOO + ', */ "Write-Output done"];\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});', "배열 안 주석 처리된 원소"],
    ["z4b", 'const cmds=[{note:' + GREP_FOO + '}, "Write-Output done"];\nawait tools.exec_command({cmd:cmds[1],workdir:' + JSON.stringify(ws) + '});', "객체 속성 문자열"],
    ["z5", 'const cmds=[' + GREP_FOO + ', "Write-Output done"];\nawait tools.exec_command({cmd:cmds[1],workdir:' + JSON.stringify(ws) + '});', "상수 첨자 1만 실행"],
    ["z6", 'const cmds=[' + GREP_FOO + '];\nawait Promise.all(cmds.map(c=>{ async function invoke(c){ return tools.exec_command({cmd:c,workdir:' + JSON.stringify(ws) + '}); } return invoke("Write-Output done"); }));', "콜백 안 동명 매개변수 그림자"],
    ["z6b", 'const cmds=[' + GREP_FOO + '];\nfor (const c of cmds) { const run = (c) => tools.exec_command({cmd:c,workdir:' + JSON.stringify(ws) + '}); await run("Write-Output done"); }', "화살표 매개변수 그림자"],
  ]) {
    writeRollout("d7" + tag, [userMsg("검증 요청"), ...exec7(code)]);
    ck("(" + tag + ") ★" + why + "=미인정 — 경보 유지(5판 반례)", citedFilesUnseenExact(answer, ws, "d7" + tag).unseenWeak.some((p) => p.endsWith("foo.ts")));
  }
  // (z5b) 상수 첨자 0은 그 원소만 인정(다른 원소는 미실행)
  writeRollout("d7z5b", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + ', "git -c safe.directory=D:/x grep -n \\"p\\" -- bar.ts"];\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});')]);
  const wz5 = citedFilesUnseenExact(answer, ws, "d7z5b");
  ck("(z5b) 상수 첨자 0=첫 원소만 인정(foo 인정·bar 미인정)", !wz5.unseenWeak.some((p) => p.endsWith("foo.ts")) && wz5.unseenWeak.some((p) => p.endsWith("bar.ts")));
  // (tp) ★6판 blocker + 정형 일치 반례(사용자 결정 73edb5984bc045e8): 정형 밖 글자가 하나라도 있으면 통째로 미인정
  for (const [tag, code, why] of [
    ["tp1", 'const \\u0074ools={exec_command:async()=>({output:"LOCAL",exit_code:0})};\nconst cmds=[' + GREP_FOO + '];\nconst r=await tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});', "유니코드 철자 지역 tools"],
    ["tp2", 'const cmds=[' + GREP_FOO + '];\nawait tools.exec_command({cmd:cmds[0],"\\u0063md":"Write-Output no-read",workdir:' + JSON.stringify(ws) + '});', "유니코드 철자 중복 키"],
    ["tp3", 'const cmds=[`git -c safe.directory=D:/x grep -n p -- ${"foo.ts"}`];\nawait tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});', "템플릿 문자열 원소"],
    ["tp4", 'const cmds=[' + GREP_FOO + '];\nawait Promise.all(cmds.map(c=>({m(c){return tools.exec_command({cmd:c,workdir:' + JSON.stringify(ws) + '})}}).m("Write-Output no-read")));', "메서드 매개변수 그림자"],
    ["tp5", 'const cmds=["Write-Output no-read",' + GREP_FOO + '];\nlet p; cmds.some(c=>{p=tools.exec_command({cmd:c,workdir:' + JSON.stringify(ws) + '}); return true;}); await p;', "some 조기 종료"],
    ["tp6", 'const cmds=[' + GREP_FOO + '];\nfor (const cmd of cmds) { const r=await tools.exec_command({cmd,workdir:' + JSON.stringify(ws) + '}); text(JSON.stringify(r)); }\nconst extra = 1;', "정형 뒤 여분 문장"],
    ["tp7", 'const cmds=[' + GREP_FOO + '];\nfor (const cmd of cmds) { const r=await tools.exec_command({cmd,workdir:' + JSON.stringify(ws) + ',extra_key:"x"}); }', "정형 밖 옵션 키"],
  ]) {
    writeRollout("d7" + tag, [userMsg("검증 요청"), ...exec7(code)]);
    ck("(" + tag + ") ★" + why + "=정형 아님 → 미인정(경보 유지)", citedFilesUnseenExact(answer, ws, "d7" + tag).unseenWeak.some((p) => p.endsWith("foo.ts")));
  }
  // (tp11) ★7판 blocker: 상속 속성 tools.constructor는 도구가 아님 — 정형 함수명 2종 밖
  writeRollout("d7tp11", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nconst r=await tools.constructor({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  ck("(tp11) ★tools.constructor=정형 아님 → 미인정(경보 유지)", citedFilesUnseenExact(answer, ws, "d7tp11").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (tp12) ★7판 blocker: S0 원소의 JS 이스케이프(\\u0023·\\n)는 실행값이 달라짐 → 배열 미인정 · 허용 이스케이프(\\")는 그대로 인정
  writeRollout("d7tp12", [userMsg("검증 요청"), ...exec7('const cmds=["git -c safe.directory=D:/x grep -n \\u0023 p -- foo.ts \\nWrite-Output done"];\nconst r=await tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  ck("(tp12) ★JS 이스케이프(\\u0023·\\n)를 실행 의미대로 복원하면 판독 아님(# 주석 절단·개행=문장 경계) — 경보 유지", citedFilesUnseenExact(answer, ws, "d7tp12").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp12b", [userMsg("검증 요청"), ...exec7('const cmds=[' + GREP_FOO + '];\nconst r=await tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  ck("(tp12b) 허용 이스케이프(\\\")만 든 원소는 인정", !citedFilesUnseenExact(answer, ws, "d7tp12b").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (tp8) PowerShell '' 이스케이프=한 문자열(6판 blocker) — 존재하지 않는 경로 하나 → 미인정
  const ps14 = "$files=@('bar.ts''foo.ts'); foreach($f in $files){ Get-Content -LiteralPath $f -TotalCount 1 }; Write-Output done";
  writeRollout("d7tp8", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: ' + JSON.stringify(ps14) + ', workdir: ' + JSON.stringify(ws) + '});')]);
  const wtp8 = citedFilesUnseenExact(answer, ws, "d7tp8");
  ck("(tp8) ★PowerShell '' 는 따옴표 한 글자 — 두 원소로 갈라 읽지 않음(둘 다 경보 유지)", wtp8.unseenWeak.some((p) => p.endsWith("foo.ts")) && wtp8.unseenWeak.some((p) => p.endsWith("bar.ts")));
  // (tp9) 정형 3종 양성 통제: 따옴표 키·allSettled·정수 옵션·text(r.output)
  writeRollout("d7tp9", [userMsg("검증 요청"), ...exec7('let cmds = [' + GREP_FOO + '];\nconst rs = await Promise.allSettled(cmds.map((c) => tools.exec_command({"cmd": c, "workdir": ' + JSON.stringify(ws) + ', timeout_ms: 30000, login: false})));\ntext(JSON.stringify(rs));')]);
  ck("(tp9) 정형 S2(allSettled·따옴표 키·정수/불리언 옵션)=인정", !citedFilesUnseenExact(answer, ws, "d7tp9").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp10", [userMsg("검증 요청"), ...exec7('const cmds = [' + GREP_FOO + ', "git -c safe.directory=D:/x grep -n \\"p\\" -- bar.ts"];\nconst a = await tools.exec_command({cmd: cmds[1], workdir: ' + JSON.stringify(ws) + '});\ntext(a.output);\nconst b = await tools.exec_command({cmd: cmds[1], workdir: ' + JSON.stringify(ws) + '});')]);
  const wtp10 = citedFilesUnseenExact(answer, ws, "d7tp10");
  ck("(tp10) 정형 S3 여러 번=그 정수 원소만(bar 인정·foo 미인정)", !wtp10.unseenWeak.some((p) => p.endsWith("bar.ts")) && wtp10.unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (tp13) ★8판 blocker(ab-3): 정형 밖 스크립트(S0+S3 뒤 유니코드 철자 중복 키 호출)는 인라인 리터럴 경로로도 흔적을 만들지 않는다 — 옛 nestedShellCalls가 첫 cmd를 되살리던 통로
  writeRollout("d7tp13", [userMsg("검증 요청"), ...exec7('const cmds=["Write-Output seed"];\nconst a=await tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(a));\nconst r=await tools.exec_command({cmd:' + GREP_FOO + ',"\\u0063md":"Write-Output done",workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  ck("(tp13) ★정형 밖 스크립트의 인라인 리터럴=미인정(경보 유지)", citedFilesUnseenExact(answer, ws, "d7tp13").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp13b", [userMsg("검증 요청"), ...exec7('const tools={exec_command:async(o)=>o};\nconst r=await tools.exec_command({cmd:' + GREP_FOO + ',workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  ck("(tp13b) ★지역 tools 그림자 선언+리터럴 명령=미인정", citedFilesUnseenExact(answer, ws, "d7tp13b").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp13c", [userMsg("검증 요청"), ...exec7('const r=await tools.exec_command({cmd:' + GREP_FOO + ',workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));\nconst extra=1;')]);
  ck("(tp13c) 정형 뒤 여분 글자=S4 리터럴도 미인정(인라인 경로 폐지)", citedFilesUnseenExact(answer, ws, "d7tp13c").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp13d", [userMsg("검증 요청"), ...exec7('const r=await tools.exec_command({cmd:' + GREP_FOO + ',workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  ck("(tp13d) 정형 S4 단독(배열 없음)=인정", !citedFilesUnseenExact(answer, ws, "d7tp13d").unseenWeak.some((p) => p.endsWith("foo.ts")));
  // (tp14) ★8판 blocker: `\\` 이스케이프 쌍(Windows 경로)은 허용 이스케이프 — 7판 검사가 두 번째 백슬래시를 다시 봐 정상 경로를 거부했다
  writeRollout("d7tp14", [userMsg("검증 요청"), ...exec7('const cmds=["git -c safe.directory=D:/x grep -n \\"p\\" -- .\\\\foo.ts"];\nconst r=await tools.exec_command({cmd:cmds[0],workdir:' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));')]);
  if (process.platform === "win32") ck("(tp14) win: `\\\\` 쌍 든 원소=인정(정상 Windows 경로)", !citedFilesUnseenExact(answer, ws, "d7tp14").unseenWeak.some((p) => p.endsWith("foo.ts")));
  else ck("(tp14) posix: 백슬래시는 파일명 문자 — 다른 경로라 흔적 불인정 유지", citedFilesUnseenExact(answer, ws, "d7tp14").unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("(tp14u) 정형 일치기 단위: `\\\\` 쌍=원문 a\\b로 복원", (B7.templateScriptCommands('const cmds=["a\\\\b"];\nawait tools.exec_command({cmd:cmds[0]});')[0] || {}).command === "a\\b");
  ck("(tp14u2) JS 이스케이프=실행 의미 그대로 복원(\\n→개행·\\u0023→#·\\x41→A) · 알 수 없는/8진/홀수 백슬래시 이스케이프=미인정", (B7.templateScriptCommands('const cmds=["a\\nb"];\nawait tools.exec_command({cmd:cmds[0]});')[0] || {}).command === "a\nb" && (B7.templateScriptCommands('const cmds=["a\\u0023b \\x41"];\nawait tools.exec_command({cmd:cmds[0]});')[0] || {}).command === "a#b A" && B7.templateScriptCommands('const cmds=["a\\qb"];\nawait tools.exec_command({cmd:cmds[0]});').length === 0 && B7.templateScriptCommands('const cmds=["a\\1b"];\nawait tools.exec_command({cmd:cmds[0]});').length === 0);
  ck("(tp14u4) 서로 다른 workdir 리터럴 2개=통째 미인정(잠금 ③ 승계) · 같은 폴더 반복 명시=정상", B7.templateScriptCommands('const cmds=["cat a.ts"];\nawait tools.exec_command({cmd:cmds[0],workdir:"D:/a"});\nawait tools.exec_command({cmd:"cat b.ts",workdir:"D:/b"});').length === 0 && B7.templateScriptCommands('const cmds=["cat a.ts"];\nawait tools.exec_command({cmd:cmds[0],workdir:"D:/a"});\nawait tools.exec_command({cmd:"cat b.ts",workdir:"D:/a"});').length === 2);
  ck("(tp14u3) 옵션 키 반복(workdir 2회)=미인정 · text(R)·R.forEach(x=>text(x)) 마무리=허용", B7.templateScriptCommands('const r=await tools.exec_command({cmd:"cat a.ts",workdir:"D:/a",workdir:"D:/b"});').length === 0 && B7.templateScriptCommands('const r=await tools.exec_command({cmd:"cat a.ts",workdir:"D:/a"});\ntext(r);').length === 1 && B7.templateScriptCommands('const calls=[{command:"cat a.ts",workdir:"D:/a"}];\nconst rs=await Promise.all(calls.map(c=>tools.shell_command(c)));rs.forEach(x=>text(x));')[0].workdir === "D:/a");
  // (tp15) ★9판 blocker(ab-3): 정형 S4라도 출력에 그 파일의 실제 줄이 없으면(-TotalCount 0; Write-Output done) 약한 축 유지
  writeRollout("d7tp15", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo.ts -TotalCount 0; Write-Output done", workdir: ' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));', "Exit code: 0\nOutput:\ndone")]);
  ck("(tp15) ★내용 없는 성공 출력(done)=약한 흔적 미인정(경보 유지)", citedFilesUnseenExact(answer, ws, "d7tp15").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp15b", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo.ts", workdir: ' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));', "Exit code: 0\nOutput:\nline1\nline2")]);
  ck("(tp15b) 실제 줄이 출력에 있으면 약한 흔적 인정", !citedFilesUnseenExact(answer, ws, "d7tp15b").unseenWeak.some((p) => p.endsWith("foo.ts")));
  writeRollout("d7tp15c", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo.ts | Measure-Object", workdir: ' + JSON.stringify(ws) + '});\ntext(JSON.stringify(r));', "Exit code: 0\nOutput:\nCount : 2")]);
  ck("(tp15c) 개수만 출력(내용 없음)=약한 흔적 미인정 — 9판 경계(모델이 내용을 받지 못한 판독은 인용 근거가 아님)", citedFilesUnseenExact(answer, ws, "d7tp15c").unseenWeak.some((p) => p.endsWith("foo.ts")));
  ck("(tp15u) 출력 줄 대조: 경로:번호: · 번호: · git blame 머리 접두 벗기기 · 부분 문자열 · 내용 없는 출력=거짓", B7.outputContainsFileLine("foo.ts:1:line1", ["line1", "line2"]) && B7.outputContainsFileLine("12:  line2", ["line1", "line2"]) && B7.outputContainsFileLine("abc1234 (me 2026-01-01 00:00:00 +0900 1) line1", ["line1"]) && B7.outputContainsFileLine("[\"@@ line1\"]", ["line1"]) && !B7.outputContainsFileLine("done", ["line1", "line2"]) && !B7.outputContainsFileLine("Count : 2", ["line1"]) && !B7.outputContainsFileLine("x", ["  ", ""]));
  // (tp16) ★10판 blocker(ab-3): 같은 외부 호출 안 다른 파일의 출력이 대상 파일의 흔적으로 오귀속되지 않는다 — 검증자 재현(foo2: 인용 줄+공통 줄 · bar2: 공통 줄만)
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "ev_ws2_"));
  fs.writeFileSync(path.join(ws2, "foo2.ts"), "target-exclusive-cited-line\nconst shared = true;\n", "utf8");
  fs.writeFileSync(path.join(ws2, "bar2.ts"), "const shared = true;\nbar2-only-line\n", "utf8");
  const answer2 = "확인. (foo2.ts:1) 과 (bar2.ts:1) 참조.";
  const wd2 = JSON.stringify(ws2);
  writeRollout("d7tp16", [userMsg("검증 요청"), ...exec7('const a = await tools.exec_command({cmd: "Get-Content -LiteralPath foo2.ts -TotalCount 0", workdir: ' + wd2 + '});\ntext(a.output);\nconst b = await tools.exec_command({cmd: "Get-Content -LiteralPath bar2.ts", workdir: ' + wd2 + '});\ntext(b.output);', "Exit code: 0\nOutput:\nconst shared = true;\nbar2-only-line")]);
  const w16 = citedFilesUnseenExact(answer2, ws2, "d7tp16");
  ck("(tp16) ★두 내부 호출 — foo2는 내용 없음·bar2만 출력(공통 줄) → foo2 약한 축 유지·bar2 인정", w16.unseenWeak.some((p) => p.endsWith("foo2.ts")) && !w16.unseenWeak.some((p) => p.endsWith("bar2.ts")));
  writeRollout("d7tp16b", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo2.ts -TotalCount 0; Get-Content -LiteralPath bar2.ts", workdir: ' + wd2 + '});\ntext(r.output);', "Exit code: 0\nOutput:\nconst shared = true;\nbar2-only-line")]);
  const w16b = citedFilesUnseenExact(answer2, ws2, "d7tp16b");
  ck("(tp16b) 한 명령 문자열 안 두 문장도 동일 — foo2 유지·bar2 인정", w16b.unseenWeak.some((p) => p.endsWith("foo2.ts")) && !w16b.unseenWeak.some((p) => p.endsWith("bar2.ts")));
  writeRollout("d7tp16c", [userMsg("검증 요청"), ...exec7('const a = await tools.exec_command({cmd: "Get-Content -LiteralPath foo2.ts", workdir: ' + wd2 + '});\ntext(a.output);\nconst b = await tools.exec_command({cmd: "Get-Content -LiteralPath bar2.ts", workdir: ' + wd2 + '});\ntext(b.output);', "Exit code: 0\nOutput:\ntarget-exclusive-cited-line\nconst shared = true;\nconst shared = true;\nbar2-only-line")]);
  const w16c = citedFilesUnseenExact(answer2, ws2, "d7tp16c");
  ck("(tp16c) 정직한 두 파일 판독(foo2 고유 줄 출력)=둘 다 인정", w16c.unseenWeak.length === 0);
  writeRollout("d7tp16d", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "rg -n shared -- foo2.ts bar2.ts", workdir: ' + wd2 + '});\ntext(r.output);', "Exit code: 0\nOutput:\nfoo2.ts:2:const shared = true;\nbar2.ts:1:const shared = true;")]);
  const w16d = citedFilesUnseenExact(answer2, ws2, "d7tp16d");
  ck("(tp16d) 공통 줄이라도 출력 줄에 파일명 접두가 있으면 그 파일 소유=둘 다 인정", w16d.unseenWeak.length === 0);
  writeRollout("d7tp16e", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo2.ts -TotalCount 0; [IO.File]::ReadAllText((Join-Path (Get-Location) \'bar2.ts\'))", workdir: ' + wd2 + '});\ntext(r.output);', "Exit code: 0\nOutput:\nconst shared = true;")]);
  const w16e = citedFilesUnseenExact(answer2, ws2, "d7tp16e");
  ck("(tp16e) 인식 밖 판독 형태로 지목한 파일도 제외 집합에 든다(명령 글자의 경로 토큰) → foo2 유지", w16e.unseenWeak.some((p) => p.endsWith("foo2.ts")));
  ck("(tp16u) 소유권 단위: 제외 집합의 줄은 근거 아님 · 파일명 접두/구역 표시 줄은 예외", !B7.outputContainsFileLine("const shared = true;", ["x-line-1", "const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo2.ts", others: ["bar2.ts"] }) && B7.outputContainsFileLine("foo2.ts:2:const shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo2.ts", others: ["bar2.ts"] }) && B7.outputContainsFileLine("@@ foo2.ts\nconst shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo2.ts", others: ["bar2.ts"] }) && !B7.outputContainsFileLine("@@ bar2.ts\nconst shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo2.ts", others: ["bar2.ts"] }));
  const men = B7.callMentionedFiles({ type: "custom_tool_call", name: "exec", call_id: "m", input: 'const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo2.ts -TotalCount 0; [IO.File]::ReadAllText(\'bar2.ts\'); git show HEAD:foo2.ts", workdir: ' + wd2 + '});\ntext(r.output);' }, ws2);
  ck("(tp16m) 호출이 지목한 실재 파일 열거: foo2·bar2(경로 토큰·rev:경로)", [...men.keys()].some((k) => k.endsWith("foo2.ts")) && [...men.keys()].some((k) => k.endsWith("bar2.ts")) && men.size === 2);
  // (tp17) ★실측 형태(2026-09-07 오늘 9/52): Promise.all([ tools.exec_command({cmd:"…"}), … ]); outputs.forEach((r)=>text(r.output));
  writeRollout("d7tp17", [userMsg("검증 요청"), ...exec7('const outputs = await Promise.all([\n  tools.exec_command({cmd:' + GREP_FOO + ',"workdir":' + JSON.stringify(ws) + ',"yield_time_ms":10000,"max_output_tokens":8000}),\n  tools.exec_command({cmd:"git -c safe.directory=D:/x grep -n \\"p\\" -- bar.ts","workdir":' + JSON.stringify(ws) + ',"yield_time_ms":10000,"max_output_tokens":4000})\n]); outputs.forEach((r)=>text(r.output));', "Exit code: 0\nOutput:\nfoo.ts:1:line1\nbar.ts:1:line1")]);
  const w17 = citedFilesUnseenExact(answer, ws, "d7tp17");
  ck("(tp17) ★S5 Promise.all([리터럴 호출…])+forEach(r=>text(r.output))=인정(두 파일)", w17.checked === true && w17.unseenWeak.length === 0);
  ck("(tp17u) S5 원소마다 자기 workdir · 정형 밖 원소(변수 명령)면 통째 미인정", B7.templateScriptCommands('const o = await Promise.all([tools.exec_command({cmd:"cat a.ts",workdir:"D:/a"}), tools.exec_command({cmd:"cat b.ts",workdir:"D:/a"})]); o.forEach((r)=>text(r.output));').length === 2 && B7.templateScriptCommands('const c="cat a.ts"; const o = await Promise.all([tools.exec_command({cmd:c})]);').length === 0);
  // (tp18) ★11판 실측 마무리 형태(오늘 미인식 11건의 원인) — 출력 전용 마무리는 모양과 무관하게 인정
  const T18 = (tail) => B7.templateScriptCommands('const r = await tools.exec_command({cmd:"cat a.ts","workdir":"D:\\\\x","yield_time_ms":30000,"max_output_tokens":3000}); ' + tail).length;
  ck("(tp18a) text(r.output); text(`EXIT ${r.exit_code}`)", T18('text(r.output); text(`EXIT ${r.exit_code}`);') === 1);
  ck("(tp18b) if (r.session_id) text(`SESSION ${r.session_id}`)", T18('text(r.output); if (r.session_id) text(`SESSION ${r.session_id}`); text(`EXIT ${r.exit_code}`);') === 1);
  ck("(tp18c) text(JSON.stringify({runtimeCommand:cmds[0],exit_code:r.exit_code,output:r.output})) — 선언 배열 상수 첨자 읽기", B7.templateScriptCommands('const cmds=["cat a.ts"];\nconst r=await tools.exec_command({cmd:cmds[0],workdir:"D:\\\\x"});\ntext(JSON.stringify({runtimeCommand:cmds[0],exit_code:r.exit_code,output:r.output}));').length === 1);
  ck("(tp18d) for (const r of results) text(JSON.stringify({…})) — S5 뒤 for-of 마무리", B7.templateScriptCommands('const results=await Promise.all([\n  tools.exec_command({cmd:"cat a.ts","workdir":"D:\\\\x"}),\n  tools.exec_command({cmd:"cat b.ts","workdir":"D:\\\\x"})\n]);\nfor(const r of results) text(JSON.stringify({exit_code:r.exit_code,output:r.output}));\n').length === 2);
  ck("(tp18e) outputs.forEach((r)=>{text(r.output); if(r.exit_code!==undefined)text(`EXIT ${r.exit_code}`)})", B7.templateScriptCommands('const outputs = await Promise.all([\n  tools.exec_command({cmd:"cat a.ts","workdir":"D:\\\\x"})\n]); outputs.forEach((r)=>{text(r.output); if(r.exit_code!==undefined)text(`EXIT ${r.exit_code}`)});').length === 1);
  ck("(tp18f) ★마무리에 도구 호출·대입·선언 배열 변경이 있으면 통째 미인정", T18('text((await tools.exec_command({cmd:"cat b.ts"})).output);') === 0 && T18('text(r.output); r.output = "x";') === 0 && B7.templateScriptCommands('const cmds=["cat a.ts"];\ntext(cmds.push("cat b.ts"));\nconst r=await tools.exec_command({cmd:cmds[1]});').length === 0 && T18('text(`${tools.exec_command({cmd:"cat b.ts"})}`);') === 0 && T18('text(r.output); const x = 1;') === 0 && T18('text(r.output); helper(r);') === 0);
  ck("(tp18g) 마무리 안 tools 글자는 문자열이어도 미인정(fail-closed)·화살표 매개변수 그림자 금지", T18('text("tools");') === 0 && T18('text(r.output); [1].forEach((r)=>text(r));') === 0);
  ck("(tp18h) ★임의 코드 실행 사슬(constructor·Function·문자열 첨자·복합 대입)=미인정", T18('text(r.constructor.constructor("return 1")());') === 0 && T18('text(r["output"]);') === 0 && T18('text(r.output); r.output ??= "x";') === 0 && T18('text(r.output); r.output += "x";') === 0 && T18('text(String.prototype.trim.call(r.output));') === 0 && T18('text(`${r["output"]}`);') === 0 && T18('text(r.output.split("\\n")[0]);') === 1);
  // (tp19) ★11판 D blocker(ab-3): 읽지 않고(-TotalCount 0) 파일 실제 줄을 text() 리터럴로 찍어 출력을 위조 → 약한 축 유지(스크립트가 타이핑한 줄은 근거 아님)
  const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), "ev_ws3_"));
  fs.writeFileSync(path.join(ws3, "foo3.ts"), "target-exclusive-cited-line\nconst shared = true;\n", "utf8");
  const answer3 = "확인. (foo3.ts:1) 참조.";
  writeRollout("d7tp19", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo3.ts -TotalCount 0", workdir: ' + JSON.stringify(ws3) + '});\ntext("target-exclusive-cited-line");', "Exit code: 0\nOutput:\ntarget-exclusive-cited-line")]);
  ck("(tp19) ★text() 리터럴로 찍은 줄=위조 → foo3 약한 축 유지(경보 유지)", citedFilesUnseenExact(answer3, ws3, "d7tp19").unseenWeak.some((p) => p.endsWith("foo3.ts")));
  writeRollout("d7tp19b", [userMsg("검증 요청"), ...exec7('const r = await tools.exec_command({cmd: "Get-Content -LiteralPath foo3.ts", workdir: ' + JSON.stringify(ws3) + '});\ntext(r.output);', "Exit code: 0\nOutput:\ntarget-exclusive-cited-line\nconst shared = true;")]);
  ck("(tp19b) 정직한 판독(text(r.output))=인정(무회귀)", !citedFilesUnseenExact(answer3, ws3, "d7tp19b").unseenWeak.some((p) => p.endsWith("foo3.ts")));
  ck("(tp19u) scriptLiteralLines: 문자열 리터럴 줄 수집(명령·내용 리터럴)·결과 변수 표현은 미수집", (() => { const S = B7.scriptLiteralLines({ input: 'const r=await tools.exec_command({cmd:"cat foo3.ts"});\ntext("target-exclusive-cited-line");\ntext(r.output);' }); return S.has("target-exclusive-cited-line") && S.has("cat foo3.ts") && !S.has("r.output"); })());
  // (tp20) ★11판 확인검증 blocker: 마무리에서 Object.defineProperty/assign로 선언 명령을 변이하는 문장은 통째 미인정(정형 밖)
  ck("(tp20a) ★Object.defineProperty(cmds[0],…) 변이 문장=미인정([])", B7.templateScriptCommands('const cmds=[{cmd:"cat foo.ts",workdir:"D:/x"}];\nObject.defineProperty(cmds[0],"cmd",{value:"x"});\nconst r=await tools.exec_command(cmds[0]);\ntext(r.output);').length === 0);
  ck("(tp20b) ★Object.assign(cmds[0],…) 변이 문장=미인정([])", B7.templateScriptCommands('const cmds=[{cmd:"cat foo.ts",workdir:"D:/x"}];\nObject.assign(cmds[0],{cmd:"x"});\nconst r=await tools.exec_command(cmds[0]);\ntext(r.output);').length === 0);
  ck("(tp20c) 변이 없는 객체 배열 상수 첨자 호출=정상 인정(무회귀)", B7.templateScriptCommands('const cmds=[{cmd:"cat foo.ts",workdir:"D:/x"}];\nconst r=await tools.exec_command(cmds[0]);\ntext(r.output);').length === 1);
  ck("(tp20d) 마무리에 Object.keys 등 Object 사용=미인정(순수 판독만 허용)", B7.templateScriptCommands('const r=await tools.exec_command({cmd:"cat foo.ts",workdir:"D:/x"});\ntext(JSON.stringify(Object.keys(r)));').length === 0);
  // (tp21) ★11판 확인검증 blocker: 파일명이 출력 줄 본문 임의 위치에 있어도 소유로 보지 않는다(접두/구역 표시만 예외)
  ck("(tp21a) ★본문에 이름만 스친 공통 줄=소유 아님(제외 유지)", !B7.outputContainsFileLine("see foo.ts reference", ["see foo.ts reference"], { exclude: new Set(["see foo.ts reference"]), name: "foo.ts", others: ["bar.ts"] }));
  ck("(tp21b) rg 경로 접두(foo.ts:2:…)=소유 인정(무회귀)", B7.outputContainsFileLine("foo.ts:2:const shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo.ts", others: ["bar.ts"] }));
  ck("(tp21c) 경로 있는 rg 접두(sub/foo.ts:2:…)=소유 인정", B7.outputContainsFileLine("sub/foo.ts:2:const shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo.ts", others: ["bar.ts"] }));
  ck("(tp21d) @@ 구역 표시=소유 인정 · @@ 다른 파일=소유 아님(무회귀)", B7.outputContainsFileLine("@@ foo.ts\nconst shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo.ts", others: ["bar.ts"] }) && !B7.outputContainsFileLine("@@ bar.ts\nconst shared = true;", ["const shared = true;"], { exclude: new Set(["const shared = true;"]), name: "foo.ts", others: ["bar.ts"] }));
  // (j) 소스 핀: 정형 일치기·중첩 추출=원시 인수·임의 실행기 제외
  const src7 = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ck("(j) 실행 스크립트=정형 문장 일치기(templateScriptCommands)만 — 옛 결속 헬퍼(execLikeCalls·arrayUsageAllowed·arrayBoundIdents)·인라인 추출기(nestedShellCalls)·templateArrayReads 제거", src7.includes("function templateScriptCommands(") && src7.includes("? templateScriptCommands(script).map((c) => ({ command: c.command, workdir: c.workdir || \"\", weak: true }))") && !src7.includes("function nestedShellCalls(") && !src7.includes("function templateArrayReads(") && !src7.includes("function execLikeCalls(") && !src7.includes("function arrayUsageAllowed(") && !src7.includes("function arrayBoundIdents(") && !/shell_command\\\\s\*/.test(src7));
  ck("(j) PowerShell foreach 전개는 약한 축 결속(weak9 = !!source.weak || variant.expanded)", /function psLiteralForeachVariants\(/.test(src7) && /const weak9 = !!source\.weak \|\| variant\.expanded;/.test(src7));
  ck("(j) 스크립트는 원시 입력 글자(p.input)에서만 읽고 정규화본 폴백 없음 — 함수 호출 인수는 강한 축 유지", /const script = \(p && typeof p\.input === "string"\) \? p\.input : null;/.test(src7) && /: values\.map\(\(v\) => \(\{ command: v, workdir: "", weak: false \}\)\);/.test(src7));
  ck("(j) 임의 실행기 제외는 불변(node -e 미인정 — 허용목록 그대로)", /^(cat\|type\|more\|less\|head\|tail\|sed\|grep\|rg\|ripgrep\|select-string\|get-content\|gc)/m.test(src7.replace(/\\/g, "")) || /\(cat\|type\|more\|less\|head\|tail\|sed\|grep\|rg\|ripgrep\|select-string\|get-content\|gc\)/.test(src7));
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
