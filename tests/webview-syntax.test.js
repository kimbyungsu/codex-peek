/*
 * 웹뷰 스크립트 '산출물' 문법 검사 — extension.ts의 <script>는 바깥 템플릿 리터럴 안에 있어서,
 * 소스에 쓴 \n 한 겹이 HTML 생성 시 실제 개행으로 변환돼 문자열 리터럴을 중간에서 끊는다 →
 * 웹뷰 JS 전체가 문법 오류로 한 줄도 실행되지 못한다(2026-07-06 실사고: 대시보드 완전 무반응 — 탭·언어·렌더 전멸).
 * 소스 텍스트 검사로는 이 부류를 못 잡으므로(변환 전이라 통과), 템플릿 평가를 재현한 '산출물'을 파스 검사한다.
 */
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const i = src.indexOf("<script");
const open = src.indexOf(">", i) + 1;
const end = src.indexOf("</" + "script>", open);
ok(i > 0 && end > open, "웹뷰 스크립트 블록 존재");
let body = src.slice(open, end);
// ①보간 중화(중첩 1단계) — 값 자리에 1이 들어가도 파스 무해. 남는 ${는 아래 평가에서 드러난다(그 자체가 검출 대상).
body = body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "1");

console.log("[산출물 재현] 바깥 템플릿 리터럴 평가(이스케이프 처리)를 그대로 재현 후 파스");
let evaluated = null, evalErr = null;
try { evaluated = eval("`" + body + "`"); } catch (e) { evalErr = e; } // 실 파이프라인과 동일하게 이스케이프 시퀀스가 처리됨
ok(!evalErr, "템플릿 평가 성공(잔여 backtick/보간 없음)" + (evalErr ? " — " + evalErr.message : ""));

if (evaluated) {
  let parseErr = null;
  try { new Function(evaluated); } catch (e) { parseErr = e; }
  ok(!parseErr, "산출 스크립트 문법 통과(\\n 한 겹 등 이스케이프 사고 검출)" + (parseErr ? " — " + parseErr.message : ""));
  ok(/addEventListener\("message"/.test(evaluated) && /querySelectorAll\(".tabbtn"\)/.test(evaluated), "핵심 배선(메시지 수신·탭)이 산출물에 존재");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
