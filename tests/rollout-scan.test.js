"use strict";
/*
 * P1-① rollout 증분 판독 — 대용량 JSONL 전량 재파싱(후보 합 296MB·소비자별 중복 판독)을
 * '한 번의 통합 스캔+자란 부분만 병합'으로 바꾼 rollout-scan.ts의 행동 계약.
 * Codex 반례 왕복 반영: 턴 경계 상한(메시지 개수 절삭은 recentTurns 계약 파괴)·같은 크기 재작성(mtime)·
 * 머리 256B를 보존한 본문 재작성(경계 지문)·EOF 줄바꿈 없는 완결 줄(구식 파서 동등성).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const RS = require(path.join(__dirname, "..", "out", "rollout-scan.js"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rscan_"));
const F = path.join(dir, "rollout.jsonl");

// 확장과 동형의 실 IO 어댑터(+읽은 바이트 계측 — 증분성 자체를 단언하기 위해)
let bytesRead = 0;
const statInfo = (f) => { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; };
const readSlice = (f, s, e) => {
  const fd = fs.openSync(f, "r");
  try {
    const len = Math.max(0, e - s);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) { const n = fs.readSync(fd, buf, got, len - got, s + got); if (n <= 0) break; got += n; }
    bytesRead += got;
    return got === len ? buf : buf.subarray(0, got);
  } finally { fs.closeSync(fd); }
};

const isInjected = (t) => t.startsWith("[검증 기본 원칙");
const normWs = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
const msgLine = (role, text) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const turnLine = (cwd, model, effort, ts, turnId="turn-"+ts) => JSON.stringify({ timestamp: ts, type: "turn_context", payload: { cwd, model, effort, turn_id:turnId } });
const settingsLine = (cwd, model, effort, ts) => JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { cwd, model, reasoning_effort: effort, collaboration_mode:{settings:{model,reasoning_effort:effort}} } } });
const mk = RS.makeRolloutAcc(isInjected, normWs);
const run = (prev, maxChunk) => RS.catchUp(F, prev, mk.init, mk.merge, statInfo, readSlice, maxChunk);
// mtime 해상도(파일시스템에 따라 ms 이하 절사)가 같은 틱의 재작성을 가리지 않도록 명시적으로 밀어준다
const bumpMtime = () => { const t = new Date(Date.now() + 2000); fs.utimesSync(F, t, t); };

console.log("[1] 증분=전량 동치 — 여러 바이트 문자(한국어)가 조각 경계에 걸려도 무부패(대화+메타 통합 스캔)");
const lines = [
  JSON.stringify({ type: "session_meta", payload: { id: "s1", source: "vscode", thread_source: "user" } }),
  msgLine("user", "[검증 기본 원칙 …] 주입 머리말"),               // isInjected → 제외
  turnLine("D:\\proj\\A", "gpt-5.5", "xhigh", "2026-07-10T01:00:00Z"),
  settingsLine("D:\\proj\\A", "gpt-5.6-sol", "high", "2026-07-10T01:30:00Z"), // 피커 선택 — 실제 turn_context와 분리
  msgLine("user", "첫 실제 요청 — 한국어 다국어 경계 테스트 문장입니다"),
  msgLine("assistant", "답변 한 줄 — 정상 판정과 근거를 담은 문장"),
  turnLine("D:\\proj\\B", "gpt-5.5-mini", "medium", "2026-07-10T02:00:00Z"), // 다른 cwd — byCwd로 분리
  msgLine("assistant", "두 번째 답변 — 조각 경계에 걸릴 만큼 충분히 긴 한국어 문장을 하나 더 둔다"),
];
fs.writeFileSync(F, lines.join("\n") + "\n");
const whole = run(undefined, undefined).acc;
const snap = (a) => JSON.stringify({ m: a.msgs, u: a.userTurns, mo: [...a.models].sort(), c: [...a.byCwd.entries()].sort(), l: a.last, sc:[...a.selectedByCwd.entries()].sort(), sl:a.selectedLast, tc:[...a.turnByCwd.entries()].sort(), tl:a.lastTurn, pc:[...a.promptByCwd.entries()].sort(), lp:a.lastPrompt, src:a.sessionSource, th:a.threadSource });
for (const chunk of [7, 16, 33, 64]) {           // 홀수 포함 — UTF-8 경계가 반드시 문자 중간에 떨어지게
  const st = run(undefined, chunk);
  ok(snap(st.acc) === snap(whole), `조각 ${chunk}B 결과 = 전량 결과(대화 ${st.acc.msgs.length}건·메타 동일)`);
}
ok(whole.msgs.length === 3 && whole.msgs[0].text.startsWith("첫 실제 요청"), "주입 머리말 제외·순서 보존(기존 파서와 동일 규칙)");
ok(whole.byCwd.get(normWs("D:\\proj\\A")).model === "gpt-5.5" && whole.byCwd.get(normWs("D:\\proj\\A")).ts === "2026-07-10T01:00:00Z", "byCwd — 이 폴더(cwd) turn만의 마지막 값(형제 폴더 값 안 샘)");
ok(whole.turnByCwd.get(normWs("D:\\proj\\B")).turnId === "turn-2026-07-10T02:00:00Z", "turn_context turn_id를 cwd별 hook 생존 대조 신호로 보존");
ok(whole.promptByCwd.get(normWs("D:\\proj\\A")).turnId === "turn-2026-07-10T01:00:00Z" && whole.promptByCwd.get(normWs("D:\\proj\\A")).model === "gpt-5.5", "비주입 사용자 프롬프트를 직전 turn_context의 프로젝트·모델에 귀속");
ok(whole.sessionSource === "vscode" && whole.threadSource === "user", "session_meta 출처를 보존해 앱 사용자 대화만 자동고정 가능");
ok(whole.selectedByCwd.get(normWs("D:\\proj\\A")).model === "gpt-5.6-sol" && whole.selectedLast.effort === "high", "thread_settings_applied — 프롬프트 전 모델·추론 피커 현재값을 즉시 별도 보존");
ok(whole.byCwd.get(normWs("D:\\proj\\A")).model === "gpt-5.5", "피커 선택값이 실제 답(turn_context) 표시를 덮지 않음");
ok(whole.last.model === "gpt-5.5-mini" && [...whole.models].sort().join(",") === "gpt-5.5,gpt-5.5-mini,gpt-5.6-sol", "last=필터 없는 마지막 실제값·models=실제+선택 전체 수집(knownModels 표시용)");

console.log("[2] 성장 증분 — 두 번째 호출은 '자란 바이트+정체성 표본(≤320B)'만 읽음");
let st1 = run(undefined, undefined);
bytesRead = 0;
fs.appendFileSync(F, msgLine("user", "추가 질문 — 증분 구간") + "\n");
const grown = fs.statSync(F).size - st1.offset;
let st2 = run(st1, undefined);
ok(bytesRead >= grown && bytesRead <= grown + 320, `읽은 바이트(${bytesRead}) = 자란 바이트(${grown})+머리 표본·경계 지문(≤320B) — 전량 재읽기 아님(P1-① 핵심)`);
ok(st2.acc.msgs.length === 4 && st2.acc.msgs[3].text.startsWith("추가 질문"), "새 메시지가 기존 누적에 병합");
bytesRead = 0;
const st2b = run(st2, undefined);
ok(bytesRead === 0 && st2b.acc.msgs.length === 4, "무변화(크기·mtime 동일) 호출은 읽기 0바이트");

console.log("[3] 부분 줄(쓰는 중인 파일) — 반토막 JSON은 대기, 완성되면 정확히 1회 편입");
const half = msgLine("assistant", "반토막으로 도착하는 줄");
fs.appendFileSync(F, half.slice(0, 20)); // 줄바꿈 없는 미완성 꼬리(JSON 미완결)
let st3 = run(st2b, undefined);
ok(st3.acc.msgs.length === 4, "미완성 꼬리는 메시지로 세지 않음(유령 항목 0)");
fs.appendFileSync(F, half.slice(20) + "\n");
st3 = run(st3, undefined);
ok(st3.acc.msgs.length === 5 && st3.acc.msgs[4].text.startsWith("반토막"), "완성 후 정확히 1회 편입(중복 0)");

console.log("[3-1] EOF의 줄바꿈 없는 '완결' JSON 줄 — 구식 전량 파서가 표시하던 것(Codex 반례) 동등 보장");
{
  fs.appendFileSync(F, msgLine("assistant", "마지막 줄 — 줄바꿈 없이 끝남")); // 완결 JSON, LF 없음
  let st = run(st3, undefined);
  ok(st.acc.msgs.length === 6 && st.acc.msgs[5].text.startsWith("마지막 줄"), "완결 객체는 EOF에서 소비(구식 파서 동등 — 미표시 유실 없음)");
  fs.appendFileSync(F, "\n"); // 작성자가 뒤늦게 LF만 붙이는 경우
  st = run(st, undefined);
  ok(st.acc.msgs.length === 6, "뒤늦은 LF에 중복 편입 없음(정확히 1회)");
}

console.log("[4] 축소/교체(로테이션) — '이전 상태를 전달한 채' 재구축(prev 미전달 검사는 무의미 — Codex 지적)");
{
  let stPrev = run(st3, undefined); // 현 파일 끝까지 따라잡은 실상태
  fs.writeFileSync(F, msgLine("user", "새 파일 첫 메시지") + "\n");
  ok(fs.statSync(F).size < stPrev.offset, "전제: 새 파일이 기존 offset보다 작음(축소 전이 성립)");
  const st4 = run(stPrev, undefined);
  ok(st4.acc.msgs.length === 1 && st4.acc.msgs[0].text === "새 파일 첫 메시지", "size<offset → 처음부터 재구축(옛 메시지 잔존 0)");
}

console.log("[4-1] '같은 크기' 재작성 — size·offset 비교로는 불가시(Codex 반례) → mtime으로 재구축");
{
  fs.writeFileSync(F, msgLine("user", "AAAA 원본 내용") + "\n");
  let st = run(undefined, undefined);
  fs.writeFileSync(F, msgLine("user", "BBBB 같은 길이") + "\n"); // 바이트 수 동일
  bumpMtime();
  ok(fs.statSync(F).size === st.offset, "전제: 재작성 후 크기가 기존 offset과 정확히 동일(반례 조건 성립)");
  st = run(st, undefined);
  ok(st.acc.msgs.length === 1 && st.acc.msgs[0].text === "BBBB 같은 길이", "mtime 변화 감지 → 전체 재구축(낡은 AAAA 반환 안 함)");
}

console.log("[4-2] 머리 256B를 보존한 '커진' 재작성 — anchor만으론 불가시(Codex 반례) → offset 직전 경계 지문으로 재구축");
{
  const meta = JSON.stringify({ type: "session_meta", payload: { id: "keep-head", pad: "x".repeat(300) } }); // 머리 256B 점유(불변)
  fs.writeFileSync(F, [meta, msgLine("user", "AAAA 본문 원본")].join("\n") + "\n");
  let st = run(undefined, undefined);
  // 머리(session_meta)는 그대로 두고 본문만 바꾼 뒤 새 메시지를 덧붙인 '커진 재작성'
  fs.writeFileSync(F, [meta, msgLine("user", "BBBB 본문 교체됨"), msgLine("assistant", "NEW 추가분")].join("\n") + "\n");
  bumpMtime();
  st = run(st, undefined);
  const texts = st.acc.msgs.map((m) => m.text.slice(0, 4)).join(",");
  ok(texts === "BBBB,NEW ", `경계 지문 불일치 → 재구축(결과 [${texts}] — 옛 AAAA 잔존·쓰레기 병합 0)`);
}

console.log("[5] 턴 경계 상한 — 메시지 개수 절삭은 recentTurns 계약 파괴(Codex 실측: 400메시지=57턴·user:null 합성 턴)");
{
  const many = [];
  for (let i = 0; i < RS.TURN_CAP + 30; i++) { many.push(msgLine("user", "질문 " + i)); many.push(msgLine("assistant", "답 " + i + "-1")); many.push(msgLine("assistant", "답 " + i + "-2")); }
  fs.writeFileSync(F, many.join("\n") + "\n");
  const st = run(undefined, undefined);
  ok(st.acc.userTurns === RS.TURN_CAP, `완전한 사용자 턴 ${RS.TURN_CAP}개 보존(개수 아닌 턴 경계 상한)`);
  ok(st.acc.turnsDropped === true && st.acc.firstTurnInnerDropped === false, "턴 통째 제거는 turnsDropped로만 표면화(내부 생략 표지와 분리 — 원인 오표기 방지)");
  ok(st.acc.msgs[0].role === "user" && st.acc.msgs[0].text === "질문 30", "선두는 항상 사용자 메시지(잘린 턴의 assistant 잔재 없음 → user:null 합성 턴 원천 차단)");
  ok(st.acc.msgs.length === RS.TURN_CAP * 3, "보존 턴은 통째로(턴당 user1+assistant2 온전)");
}
{
  // 상한 이내 파일은 절삭 자체가 없어야 함 — 선두 assistant(세션 시작 잔재)도 구식 파서처럼 그대로
  fs.writeFileSync(F, [msgLine("assistant", "선두 잔재"), msgLine("user", "질문"), msgLine("assistant", "답")].join("\n") + "\n");
  const st = run(undefined, undefined);
  ok(st.acc.msgs.length === 3 && st.acc.msgs[0].role === "assistant", "상한 이내에서는 구식 파서와 완전 동일(무절삭·무변형)");
  ok(st.acc.turnsDropped === false && st.acc.firstTurnInnerDropped === false, "무절삭 파일은 두 표지 모두 false(고지 오발동 없음)");
}

console.log("[5-1] 하드 상한(HARD_MSG_CAP)도 턴 불변식 유지 — 원시 개수 절삭은 userTurns 비동기화(Codex 반례 2종)");
{
  // 반례 A: 사용자 1 + assistant HARD+50 — 턴을 통째로 버리면 대화 전체 소멸 → 턴 '내부' 오래된 assistant부터
  const many = [msgLine("user", "유일한 질문")];
  for (let i = 0; i < RS.HARD_MSG_CAP + 50; i++) many.push(msgLine("assistant", "답 " + i));
  fs.writeFileSync(F, many.join("\n") + "\n");
  const st = run(undefined, undefined);
  const users = st.acc.msgs.filter((m) => m.role === "user").length;
  ok(st.acc.msgs.length === RS.HARD_MSG_CAP && users === 1 && st.acc.userTurns === 1 && st.acc.msgs[0].role === "user",
    `단일 거대 턴: 사용자 보존+내부 assistant 절삭(보존 ${st.acc.msgs.length}·userTurns 동기 — 대화 소멸/합성 턴 없음)`);
  ok(st.acc.msgs[st.acc.msgs.length - 1].text === "답 " + (RS.HARD_MSG_CAP + 49), "최신 assistant 우선 보존(오래된 쪽 절삭)");
  ok(st.acc.firstTurnInnerDropped === true && st.acc.turnsDropped === false, "턴 '내부' 생략은 별도 표지 — 창이 차도(recentTurns=1) 침묵하지 않고 정확한 원인으로 고지할 입력(Codex 반례)");
  // 이후 새 턴들이 쌓여 그 거대 턴이 통째로 밀려나면 내부 생략 고지는 낡은 정보 — 리셋돼야 함
  const add = [];
  for (let i = 0; i < RS.TURN_CAP + 5; i++) { add.push(msgLine("user", "후속 " + i)); add.push(msgLine("assistant", "후속답 " + i)); }
  fs.appendFileSync(F, add.join("\n") + "\n");
  const st2 = run(st, undefined);
  ok(st2.acc.firstTurnInnerDropped === false && st2.acc.turnsDropped === true, "내부 생략됐던 선두 턴이 통째로 밀려나면 내부 표지 리셋(낡은 고지 잔존 없음)");
}
{
  // 반례 B: 사용자 160턴 × 턴당 assistant 25개(=4160 msgs > HARD) — 턴 단위로 지워 항상 '완전한 턴'만 남음
  const per = 25, turns = 160;
  const many = [];
  for (let i = 0; i < turns; i++) { many.push(msgLine("user", "질문 " + i)); for (let j = 0; j < per; j++) many.push(msgLine("assistant", "답 " + i + "-" + j)); }
  fs.writeFileSync(F, many.join("\n") + "\n");
  const st = run(undefined, undefined);
  const users = st.acc.msgs.filter((m) => m.role === "user").length;
  ok(st.acc.msgs.length <= RS.HARD_MSG_CAP && st.acc.userTurns === users && st.acc.msgs[0].role === "user",
    `assistant 다량 턴: 하드 상한 이내(${st.acc.msgs.length})·userTurns=실제 사용자 수(${users})·선두 user(합성 턴 차단)`);
  ok(st.acc.msgs.length === users * (per + 1), "보존 턴은 통째로(잘린 턴 잔재 0)");
  ok(st.acc.turnsDropped === true && st.acc.firstTurnInnerDropped === false, "턴 단위 제거만 발생 — 표지도 turnsDropped만(200턴 미만에서의 HARD 절삭이 '창 미달' 고지로 이어지는 경로)");
}

console.log("[6] 스니펫 머리 판독 — 3상태(찾음 / 전체에 없음 확정 / 머리에서 미확정)+절삭 무관 firstUser 폴백");
{
  fs.writeFileSync(F, lines.join("\n") + "\n");
  const t = RS.headFirstUserMessage(F, isInjected, readSlice, statInfo);
  ok(t === "첫 실제 요청 — 한국어 다국어 경계 테스트 문장입니다", "주입 제외 후 첫 사용자 메시지(전량 파싱 없이 머리만)");
  fs.writeFileSync(F, turnLine("D:\\x", "m", "low", "t") + "\n");
  ok(RS.headFirstUserMessage(F, isInjected, readSlice, statInfo) === "", "파일 전체에 사용자 메시지 없음 → ''(확정 — 캐시 가능)");
  const big = [turnLine("D:\\x", "m", "low", "t"), msgLine("user", "머리 밖의 메시지")].join("\n") + "\n";
  fs.writeFileSync(F, big);
  ok(RS.headFirstUserMessage(F, isInjected, readSlice, statInfo, 30) === null, "머리 안에서 못 찾았고 뒤가 더 있음 → null(호출자 폴백 신호)");
}
{
  // Codex 반례: 첫 사용자 'FIRST' 뒤 TURN_CAP+30턴 — readMessages 폴백이면 절삭돼 'FIRST'를 잃는다
  const many = [msgLine("user", "FIRST — 절삭돼도 스니펫은 이걸 가리켜야 함")];
  for (let i = 0; i < RS.TURN_CAP + 30; i++) { many.push(msgLine("user", "Q" + i)); many.push(msgLine("assistant", "A" + i)); }
  fs.writeFileSync(F, many.join("\n") + "\n");
  const st = run(undefined, undefined);
  ok(st.acc.msgs[0].text !== "FIRST — 절삭돼도 스니펫은 이걸 가리켜야 함", "전제: 대화 누적기에서는 첫 메시지가 절삭됨(반례 조건 성립)");
  ok(st.acc.firstUser === "FIRST — 절삭돼도 스니펫은 이걸 가리켜야 함", "firstUser는 절삭 무관 보존 — 스니펫 최후 폴백의 시야 유실 봉합");
}

console.log("[7] 확장 배선 소스 계약 — 전량 파서 잔재 0·통합 스캔·상한 잠금");
{
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(!/readMessagesUncached/.test(ext), "readMessagesUncached(전량 파서) 제거");
  ok(/rolloutAccFor/.test(ext) && !/metaTails/.test(ext) && !/msgTails/.test(ext), "대화·모델메타가 '통합 tail 하나'를 공유(같은 파일 이중 전량 판독 제거 — Codex 실측 904+877ms)");
  ok(/headFirstUserMessage\(file, isInjected/.test(ext) && /snippetMemo/.test(ext), "스니펫=머리 판독+영구 메모(후보 목록 전량 파싱 제거)");
  ok(/rolloutAccFor\(file\)\.firstUser/.test(ext) && !/readMessages\(file\)\.find/.test(ext), "스니펫 최후 폴백=firstUser(절삭 무관 필드 — readMessages 폴백은 절삭된 시야라 금지)");
  ok(/Math\.min\(TURN_CAP, Math\.max\(1,/.test(ext), "recentTurns 코드 상한 = TURN_CAP(수기 편집 방어)");
  ok(/turnsTrimmed = racc\.turnsDropped && allTurns\.length </.test(ext) && /turnsInnerTrimmed = racc\.firstTurnInnerDropped && allTurns\.length <=/.test(ext), "두 표지 분리 배선 — 턴 제거=창 미달 시·내부 생략=선두 턴이 화면에 있을 때(전체≤N)");
  ok(/d\.turnsTrimmed/.test(ext) && /d\.turnsInnerTrimmed/.test(ext) && /턴 '내부'의 오래된 Codex 답변/.test(ext) && /오래된 턴 일부가 보관 상한/.test(ext), "웹뷰 고지 2종 — 서로 다른 원인을 각자 정확한 문구로(단일 문구는 원인 오표기 — Codex 반례)");
  const pkgDesc = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).contributes.configuration.properties["codexBridge.recentTurns"].description;
  ok(/최대/.test(pkgDesc) && /내부의 오래된 답변/.test(pkgDesc), "설정 계약 문구 — '최대 N턴'+턴 내부 생략 가능성 명시");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  ok(pkg.contributes.configuration.properties["codexBridge.recentTurns"].maximum === RS.TURN_CAP, "설정 UI maximum = TURN_CAP(계약 일치 — 표시 못 할 값을 받지 않음)");
  ok(!/content\.split\("\\n"\)/.test(ext.slice(ext.indexOf("function readMessages"), ext.indexOf("function readModelsCache"))), "rollout 소비 구간에 readFileSync 전량 split 잔재 없음");
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
