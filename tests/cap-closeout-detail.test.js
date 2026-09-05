"use strict";
/*
 * [마감 관문 거부 사유 · 2026-09-06 사용자 지적] 종료 훅이 마감문을 거부할 때 "어느 절·몇 번째 줄·어느 칸이 왜"를 그대로 알려준다 —
 * 구현자가 추측 수정을 반복하거나 검사기를 손수 돌려 보지 않아도 1회로 고칠 수 있어야 한다(하네스 몫). 검사기 결과의 detail 문장과
 * 훅 안내문 첫 줄을 고정한다. 기존 승인/거부 판정은 바뀌지 않는다(verify-sequential 핀이 그 무회귀를 잡는다).
 */
const assert = require("assert");
const VH = require("../bridge/verify-cap-handoff.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

const TITLE = "저장한 선택값이 화면 재진입 뒤 사라진다";
const ctx = { evidence: [{ key: "R5-F1", title: TITLE, tag: "blocker" }], alertKind: "verdict-nonclean", source: "ask-x", unavailable: false, verdict: "fail", backlogHealthy: true, backlogItems: [], roundCount: 5, roundBudget: 5 };
const good = `[검증 상한 인계]
상한 5/5 소진.
[수용·처리]
- R5-F1 ${TITLE} — 변경: \`restoreSavedChoice\` 복원 분기를 수정했습니다; 확인: 시험:재진입-회귀에서 선택값 유지 결과를 확인했습니다; 근거: tests/verify-sequential.test.js 재진입 시험 통과
[반박·종결]
없음
[보관함 이관]
없음
[사용자 판단 필요]
없음
[잔여 위험 판단]
다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.
[경고등 의미]
verdict-nonclean 빨강은 마지막 검증이 통과가 아니었음을 남기며 이번 마감은 통과 인증이 아닙니다. 사용자 행동은 필요 없고 나중의 정상 검증 통과 때 해소됩니다.
[권장]
사용자 판단 없이 처리 내용을 유지하고 다음 변경의 정상 검증에서 다시 확인하기를 권장합니다.`;

t("정상 마감=승인·detail 없음", () => {
  const r = VH.validateCapHandoff(good, ctx);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(!("detail" in r) || !r.detail, "승인에는 거부 사유가 붙지 않음");
});
t("식별 근거 없는 칸=거부 사유에 절·줄 번호·칸 이름·필요 조건", () => {
  const bad = good.replace("근거: tests/verify-sequential.test.js 재진입 시험 통과", "근거: 검증자 판정문 인용");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/\[수용·처리\] 1번째 줄\(R5-F1\): '근거' 칸/.test(String(r.detail)) && /파일 경로|백틱|숫자\+단위/.test(String(r.detail)), "detail=" + r.detail);
});
t("세 칸 형식 아님=그 줄·형식 안내", () => {
  const bad = good.replace("변경: `restoreSavedChoice` 복원 분기를 수정했습니다; 확인:", "변경: `restoreSavedChoice` 복원 분기를 수정했습니다. 확인:");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/\[수용·처리\] 1번째 줄\(R5-F1\): "변경: …; 확인: …; 근거: …" 세 칸 형식이 아님/.test(String(r.detail)), "detail=" + r.detail);
});
t("절 제목 누락=누락 절 이름", () => {
  const bad = good.replace("[보관함 이관]\n없음\n", "");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/절 제목 누락: \[보관함 이관\]/.test(String(r.detail)), "detail=" + r.detail);
});
t("행선지 미배정 키=미배정 목록", () => {
  const bad = good.replace(/\[수용·처리\]\n- R5-F1[^\n]*\n/, "[수용·처리]\n없음\n");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/미배정: R5-F1/.test(String(r.detail)), "detail=" + r.detail);
});
t("잔여 위험 절 시작어 위반=그 절 안내", () => {
  const bad = good.replace("다음 캠페인 도장 — 이유:", "나중에 보자 — 이유:");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/\[잔여 위험 판단\]: "즉시 재검증"\/"다음 캠페인 도장"\/"무시 가능"/.test(String(r.detail)), "detail=" + r.detail);
});
t("경고 키 누락=그 절 안내에 키 이름", () => {
  const bad = good.replace("verdict-nonclean 빨강은", "이 빨강은");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/\[경고등 의미\]: 현재 경고 키 "verdict-nonclean"/.test(String(r.detail)), "detail=" + r.detail);
});
t("회차 숫자 불일치=장부 실제값과 함께 명시", () => {
  const bad = good.replace("상한 5/5 소진.", "상한 3/5 소진.");
  const r = VH.validateCapHandoff(bad, ctx);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ["round-figure-mismatch"]);
  assert.ok(/회차 숫자가 장부 실제값\(5\/5\)과 다름/.test(String(r.detail)), "detail=" + r.detail);
});
t("훅 안내문 첫 줄=거부 사유(있을 때만) · 없으면 종전 안내 그대로", () => {
  const withWhy = VH.capHandoffInstruction("ko", "5/5", "실패", ctx, "[수용·처리] 1번째 줄(R5-F1): '근거' 칸 — 스스로 확인 가능한 근거가 필요");
  assert.ok(withWhy.startsWith("[직전 마감문 거부 사유] [수용·처리] 1번째 줄(R5-F1): '근거' 칸"), withWhy.split("\n")[0]);
  assert.ok(withWhy.includes("[잔여 위험 판단]") && withWhy.includes("[검증 모드 · 실제 회차 5/5]"), "종전 안내 본문 유지");
  const without = VH.capHandoffInstruction("ko", "5/5", "실패", ctx);
  assert.ok(!without.includes("[직전 마감문 거부 사유]") && without.trimStart().startsWith("회차 숫자를 쓰면"), "detail 없음=종전 첫 줄");
  const en = VH.capHandoffInstruction("en", "5/5", "fail", ctx, "[Accepted and handled] line 1 (R5-F1): cell \"Evidence\" needs a self-identifying fact");
  assert.ok(en.startsWith("[Why the previous closeout was rejected] [Accepted and handled] line 1"), en.split("\n")[0]);
});
t("영문 스키마도 같은 detail 구조(칸 이름 영문)", () => {
  const goodEn = `[Verification cap closeout]
cap 5/5.
[Accepted and handled]
- R5-F1 ${TITLE} — Change: fixed the \`restoreSavedChoice\` branch; Check: test:reentry-regression confirmed the value persists; Evidence: tests/verify-sequential.test.js passes
[Rebutted and closed]
none
[Parked]
none
[User decision required]
none
[Residual risk call]
Next campaign — reason: the unverified edit is a one-line test wording change covered by regression tests.
[Alert meaning]
verdict-nonclean red alert remains until a later clean pass; this closeout is not a pass certificate and needs no user action.
[Recommendation]
We recommend keeping the handled changes and re-checking in the next normal verification because no user decision is needed.`;
  assert.strictEqual(VH.validateCapHandoff(goodEn, ctx).ok, true);
  const r = VH.validateCapHandoff(goodEn.replace("Evidence: tests/verify-sequential.test.js passes", "Evidence: the verifier said so"), ctx);
  assert.strictEqual(r.ok, false);
  assert.ok(/\[Accepted and handled\] line 1 \(R5-F1\): cell "Evidence"/.test(String(r.detail)), "detail=" + r.detail);
});
console.log(`\n결과: ${n} 통과 / 0 실패`);
