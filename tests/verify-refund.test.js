"use strict";
/*
 * [회차 환급 2026-09-04] 검증자가 답을 한 글자도 내지 못한 호출(스폰·네트워크 실패)은 왕복이 아니다.
 * 계약: 방금 예약한 그 서수(count===n)만 되돌린다 · 캠페인당 VERIFY_REFUND_MAX(2)회 유계 · 캠페인 불일치·옛 서수·손상=거부 · 답이 온 판은 환급 대상 아님(소스 핀).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vrf-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const WS = path.join(HOME, "ws"); fs.mkdirSync(WS, { recursive: true });
const CAMP = "cl:sess:2026-09-04T00:00:00.000Z";
const reserve = () => CL.reserveVerifyCampaign(WS, CAMP, 5, () => true);
const counter = () => JSON.parse(fs.readFileSync(CL.campaignFileFor(WS), "utf8"));

t("예약 2회 뒤 최신 서수(2) 환급=count 1·refunds 1 · 옛 서수(1) 환급=거부(not-latest)", () => {
  assert.strictEqual(reserve().n, 1); assert.strictEqual(reserve().n, 2);
  const r = CL.refundVerifyCampaignRound(WS, CAMP, 2);
  assert.ok(r.ok && r.count === 1 && r.refunds === 1 && r.max === CL.VERIFY_REFUND_MAX && r.budget === 5, JSON.stringify(r));
  assert.strictEqual(counter().count, 1);
  const r2 = CL.refundVerifyCampaignRound(WS, CAMP, 2);
  assert.ok(!r2.ok && r2.reason === "not-latest", JSON.stringify(r2));
  assert.strictEqual(reserve().n, 2, "환급 뒤 다음 예약은 같은 서수를 다시 받는다");
});

t("캠페인 불일치·잘못된 인자=거부 · 환급 상한(2회) 뒤에는 종전처럼 소모", () => {
  assert.strictEqual(CL.refundVerifyCampaignRound(WS, "cl:other:x", 2).reason, "campaign-mismatch");
  assert.strictEqual(CL.refundVerifyCampaignRound(WS, CAMP, 0).reason, "bad-args");
  assert.ok(CL.refundVerifyCampaignRound(WS, CAMP, 2).ok, "2번째 환급");
  assert.strictEqual(reserve().n, 2);
  const r3 = CL.refundVerifyCampaignRound(WS, CAMP, 2);
  assert.ok(!r3.ok && r3.reason === "refund-cap" && r3.refunds === 2, "3번째=거부 " + JSON.stringify(r3));
  assert.strictEqual(counter().count, 2, "거부 시 count 무변");
  assert.strictEqual(counter().refunds, 2);
});

t("상한 소진 뒤 환급=다시 예약 가능(거부 해제) · 손상 카운터=거부", () => {
  assert.strictEqual(reserve().n, 3); assert.strictEqual(reserve().n, 4); assert.strictEqual(reserve().n, 5);
  assert.ok(reserve().rejected, "5/5 소진");
  const WS2 = path.join(HOME, "ws2"); fs.mkdirSync(WS2, { recursive: true });
  const C2 = "cl:sess2:2026-09-04T00:00:00.000Z";
  for (let i = 0; i < 5; i++) CL.reserveVerifyCampaign(WS2, C2, 5, () => true);
  assert.ok(CL.reserveVerifyCampaign(WS2, C2, 5, () => true).rejected);
  assert.ok(CL.refundVerifyCampaignRound(WS2, C2, 5).ok, "소진 직후 답 없는 실패=환급");
  const again = CL.reserveVerifyCampaign(WS2, C2, 5, () => true);
  assert.ok(again.tracked && again.n === 5, "돌려받은 회차로 재시도 가능 " + JSON.stringify(again));
  fs.writeFileSync(CL.campaignFileFor(WS2), "{broken");
  assert.strictEqual(CL.refundVerifyCampaignRound(WS2, C2, 5).reason, "counter-unreadable");
});

t("★A→B→A 교대 복원 — refunds 누계가 history에서 함께 복원돼 캠페인당 상한(2)을 우회하지 못한다(확인검증 blocker f-4f21ad8c 반례)", () => {
  const WS3 = path.join(HOME, "ws3"); fs.mkdirSync(WS3, { recursive: true });
  const A = "cl:sessA:2026-09-04T00:00:00.000Z", B = "cl:sessB:2026-09-04T00:00:00.000Z";
  const rsv = (c) => CL.reserveVerifyCampaign(WS3, c, 5, () => true);
  const cnt = () => JSON.parse(fs.readFileSync(CL.campaignFileFor(WS3), "utf8"));
  assert.strictEqual(rsv(A).n, 1);
  assert.ok(CL.refundVerifyCampaignRound(WS3, A, 1).ok); // A refunds 1
  assert.strictEqual(rsv(B).n, 1, "B 전환 — A는 history로");
  const backA = rsv(A);
  assert.ok(backA.tracked && backA.n === 1, JSON.stringify(backA));
  assert.strictEqual(cnt().refunds, 1, "★복원된 A 카운터에 refunds 누계 승계");
  assert.ok(CL.refundVerifyCampaignRound(WS3, A, 1).ok, "2번째 환급(상한 안)");
  assert.strictEqual(cnt().refunds, 2);
  assert.strictEqual(rsv(B).n, 2); assert.strictEqual(rsv(A).n, 1);
  const r3 = CL.refundVerifyCampaignRound(WS3, A, 1);
  assert.ok(!r3.ok && r3.reason === "refund-cap" && r3.refunds === 2, "★교대를 반복해도 3번째 환급=거부 " + JSON.stringify(r3));
  assert.strictEqual(cnt().refunds, 2);
});

t("소스 핀 — 답 0자 실패(resume 실패 분기)에서만 환급·job 파일 roundRefunded·답이 있으면 환급 없음", () => {
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  const i = cb.indexOf("Codex resume 실패: ");
  const blk = cb.slice(cb.lastIndexOf("if (error || !answer || (typeof status", i), i);
  assert.ok(blk.includes('!String(answer || "").trim() && budgetGate.res && budgetGate.res.tracked === true') && blk.includes("refundVerifyCampaignRound(ws, budgetGate.res.campaignId, budgetGate.res.n)") && blk.includes("roundRefunded: !!rf9.ok"), "환급은 답 0자·집계 중일 때만");
  assert.ok(cb.indexOf("attempt.answered();", i) > i, "답 수신 뒤 경로에는 환급 없음");
  assert.strictEqual((cb.match(/refundVerifyCampaignRound\(/g) || []).length, 1, "환급 호출 지점은 실패 분기 1곳뿐");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
