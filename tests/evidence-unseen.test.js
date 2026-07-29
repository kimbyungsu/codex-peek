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

const { citedFilesUnseen, citedFilesUnseenExact, citedResolvedBasenames } = require("../bridge/codex-bridge.js");

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

// 실패했을 때만 내부 상태를 찍는다(2026-07-29: 이 파일이 CI 윈도에서만 무더기로 실패했는데
// 로컬 윈도·LF 체크아웃·Node 20 어디서도 재현되지 않아, 실행 환경의 무엇이 다른지 실측이 필요하다).
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

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
