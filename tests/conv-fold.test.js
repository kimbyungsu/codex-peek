/*
 * 검증 대화 '주입 지침 접기'(2026-07-23 사용자 결정 — 판단 검증 3왕복 귀결: 내부화·경로표시는 감쇠·미이행
 * 위험으로 기각, 표시 접기=전송 불변·비용 0·이행성 0 영향) 계약 테스트.
 * 핵심 계약: ①분리 함수는 구분자 '첫' 출현 기준(본문이 구분자를 인용해도 본문 오분류 없음 — marker 충돌 반례)
 * ②복원 계약: head+marker+body === 원문(펼침 원문+본문=전송 원문 전체) ③표시 전용 — 전송 경로(withContract)
 * 무접촉 ④textContent만(HTML 주입 없음) ⑤펼침 상태는 openPanels로 재렌더에도 유지.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 분리 함수 실행(컴파일 산출물에서 추출 — 문자열 단언만으로는 marker 충돌 반례를 못 잡음)");
const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
// 함수 전체를 중괄호 짝 맞추기로 추출(본문 앵커 문자열 의존 금지 — 함수가 개정돼도 추출이 안 깨지게)
function extractFn(src, name) {
  const st = src.indexOf("function " + name + "(");
  if (st < 0) return "";
  let i = src.indexOf("{", st), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(st, i + 1); }
  }
  return "";
}
const fnTxt = extractFn(outSrc, "splitInjectedHead");
ok(!!fnTxt, "(전제) 산출물에서 분리 함수 추출");
// 산출물 계층에선 구분자가 "\\n"(이중 이스케이프 — 웹뷰 HTML 생성 시 한 겹 벗겨져 실개행이 됨)이라,
// 여기서 직접 평가하려면 한 겹을 미리 벗겨 '웹뷰가 실제 실행하는 형태'로 만든다(2026-07-06 실사고 각주와 동일 구조).
const split = new Function("return (" + fnTxt.replace(/\\\\n/g, "\\n") + ");")();
const M = "\n---\n[작업 요청]\n";
const ME = "\n---\n[Work Request]\n";
const r1 = split("HEAD규약" + M + "BODY본문");
ok(r1 && r1.head === "HEAD규약" && r1.body === "BODY본문" && r1.marker === M, "기본 분리(유일 출현 — 흔한 정상 케이스) — head/body/marker");
ok(r1.head + r1.marker + r1.body === "HEAD규약" + M + "BODY본문", "복원 계약 — head+marker+body=원문(바이트 동일)");
ok(split("HEAD" + M + "본문이 구분자를 인용: " + M + " 이후 내용") === null, "본문이 구분자 인용(2출현) → 접기 생략(본문이 접힘에 먹히는 오분류 대신 원문 그대로 — fail-safe)");
ok(split("머리에 인용: " + M + " 규약 계속" + M + "실제 본문") === null, "주입 머리가 구분자 인용(2출현) → 접기 생략(보일러플레이트가 본문으로 새는 오분류 차단 — 1차 blocker① 잠금)");
ok(split("구분자 없는 일반 대화") === null, "구분자 없음(비-브릿지 세션) → null(원문 그대로 표시)");
ok(split(M + "본문") === null, "구분자가 맨 앞(접을 head 없음) → null(접기 생략)");
const r3 = split("H" + ME + "B");
ok(r3 && r3.marker === ME && r3.head + r3.marker + r3.body === "H" + ME + "B", "영어 구분자 변형 지원+복원 계약");
ok(split("H" + ME + "mid" + M + "tail") === null, "한/영 구분자 공존(2출현) → 접기 생략(애매=안 접음)");

console.log("[1b] 펼침 키 안정성(1차 blocker② 잠금) — 답변이 자라도 키 불변");
const kTxt = extractFn(outSrc, "injKeyOf");
ok(!!kTxt, "(전제) 산출물에서 키 함수 추출");
const injKeyOf = new Function("return (" + kTxt + ");")();
ok(injKeyOf("같은 요청") === injKeyOf("같은 요청") && /^inj-?\d+$/.test(injKeyOf("같은 요청")), "같은 사용자 본문=같은 키(입력이 사용자 본문뿐 — 답변 배열과 구조적 무관)");
ok(injKeyOf("요청A") !== injKeyOf("요청B"), "다른 본문=다른 키");

console.log("[2] 배선 소스 계약 — 표시 전용·textContent·펼침 유지·전송 무접촉");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(ext.includes("wrap.appendChild(userBubble(t, (d.turnsStart||0)+tIdx9))") && !/el\("div","umsg", t\.user\)/.test(ext), "사용자 말풍선=접힘 렌더로 교체(직결 렌더 잔재 0)");
ok(ext.includes('keyedDetails(injKeyOf(t.user)+":"+turnIdx') && !ext.includes('keyedDetails("inj:"+convKey(t)'), "펼침 키=사용자 본문 해시+턴 순번(답변 성장에 불변·동일 요청 반복 턴끼리 상태 공유 안 함 — 2차 보완)");
// 3차 blocker 잠금 — 키 순번은 '전체 대화 기준': 최근 N턴 창이 [A..E]→[B..F]로 밀려도 B의 전역 순번은 불변.
// host 산식과 소비를 함께 고정하고, 창 이동 반례를 산식으로 직접 실행한다.
ok(ext.includes("turnsStart = Math.max(0, allTurns.length - Math.max(1, turnsN))") && ext.includes("turnsStart: number;"), "host가 슬라이스 시작의 전역 순번을 계산·전달(turnsStart)");
{
  const startOf = (total, n) => Math.max(0, total - Math.max(1, n)); // host 산식 사본(위 단언으로 원본과 결속)
  const keyAt = (total, n, sliceIdx) => startOf(total, n) + sliceIdx;
  ok(keyAt(5, 5, 1) === 1 && keyAt(6, 5, 0) === 1, "창 이동 반례 — [A..E]의 B(전역 1)가 F 추가 후 [B..F]의 첫 칸이 돼도 키 순번 1 유지(펼침 유지)");
  ok(keyAt(3, 5, 2) === 2, "대화가 창보다 짧으면 전역 순번=슬라이스 순번(무회귀)");
}
ok(ext.includes("occ.length!==1") && ext.includes("afdd6850b4ea2030"), "유일 출현 규칙+전송측 경계 프레이밍 백로그 참조 명문");
ok(ext.includes("pre.textContent=sp.head+sp.marker") && ext.includes("b.textContent=sp.body"), "textContent만(HTML 주입 없음)+구분자 포함 복원 계약");
ok(ext.includes("하네스 주입 지침 ") && ext.includes("harness-injected directives"), "접힘 칩 라벨 ko/en");
const bridgeSrc = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
ok(/\[작업 요청\]/.test(bridgeSrc), "(전제) 브릿지 구분자 실재 — 전송 조립은 이번 변경에서 무접촉(표시 전용의 근거)");
ok(!/splitInjectedHead|userBubble/.test(bridgeSrc), "브릿지(전송 경로)에 접기 코드 없음 — 모델 입력 불변 잠금");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
