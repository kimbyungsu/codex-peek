"use strict";
/*
 * [기억 권위] MEMORY-AUTHORITY-DESIGN v3 — A(공급 조정·draft)·B(프로필 문구)·C(제약 처리 파서·영수증 배선) 시험.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입·모킹 없음 — fs 실행 반례가 1급). 설계 §5 추가 시험 ①~⑥+회귀 핀 일부.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws-"));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo-"));

// ── 픽스처: 승인된 수칙서(병렬 En/Ex 축 포함) ────────────────────────────────
const envObj = {
  schema: "verify-envelope-v1",
  supportedEnv: ["윈도우 로컬 단일 사용자"],
  alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"],
  alwaysBlockerEn: ["No unapproved remote forwarding on local failure"],
  alwaysBlockerEx: ["동네 세탁소가 실패하면 허락 없이 본사로 옷을 보내지 않는다"],
  outOfScope: ["다중 서버 동시 배포"],
};
const envRaw = JSON.stringify(envObj, null, 1);
fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), envRaw);
const HASH = crypto.createHash("sha1").update(envRaw).digest("hex");

// ── 픽스처: findings 장부 — 신행(title·askId)·구행(legacy)·비blocker ─────────
const camp = "cl:test:2026";
const led = [
  { type: "finding", findingId: "f-aaaa0001", campaignId: camp, round: 1, tag: "blocker", titleNorm: "t1", title: "결제 실패 시 카드번호가 평문 로그에 남음", envelopeHash: HASH, status: "open", ts: "t" },
  { type: "close", campaignId: camp, findingId: "f-aaaa0001", closeReason: "resolved", round: 2, envelopeHash: HASH, askId: "ask-test-1", ts: "t" },
  // legacy: title 없음(구행) — 제외 대상
  { type: "finding", findingId: "f-bbbb0002", campaignId: camp, round: 1, tag: "blocker", titleNorm: "t2", envelopeHash: HASH, status: "open", ts: "t" },
  { type: "close", campaignId: camp, findingId: "f-bbbb0002", closeReason: "resolved", round: 2, envelopeHash: HASH, ts: "t" },
  // 비blocker 해소 — 원천 아님
  { type: "finding", findingId: "f-cccc0003", campaignId: camp, round: 1, tag: "보완", titleNorm: "t3", title: "주석 보강", envelopeHash: HASH, status: "open", ts: "t" },
  { type: "close", campaignId: camp, findingId: "f-cccc0003", closeReason: "resolved", round: 2, envelopeHash: HASH, askId: "ask-test-1", ts: "t" },
  // ab축 기등재 문안과 동일 — 정확 일치 억제 대상
  { type: "finding", findingId: "f-dddd0004", campaignId: camp, round: 3, tag: "blocker", titleNorm: "t4", title: "로컬 실패 시 무승인 원격 전달 금지", envelopeHash: HASH, status: "open", ts: "t" },
  { type: "close", campaignId: camp, findingId: "f-dddd0004", closeReason: "resolved", round: 4, envelopeHash: HASH, askId: "ask-test-2", ts: "t" },
];
fs.mkdirSync(path.dirname(CL.findingsLedgerFileFor(WS)), { recursive: true });
fs.writeFileSync(CL.findingsLedgerFileFor(WS), led.map((r) => JSON.stringify(r)).join("\n") + "\n");

// ── [재편 A §2-1] 공급=명시 상신(rule-propose)뿐 — 본 스캔 폐지 반례+자격·결속 ──
t("본 스캔 폐지: 해소 blocker가 자동으로 후보가 되지 않음(헌법 — 이력≠자격)", () => {
  const r = CL.reconcileMemoryCandidates(WS, REPO, HASH);
  assert.strictEqual(r.appended, 0, "자동 공급 0(폐지)");
  assert.strictEqual(r.scanned, 0, "본 스캔 자체가 없음");
  const { latest } = CL.readEnvelopeCandidates(WS);
  assert.strictEqual([...latest.values()].filter((x) => x.status === "proposed").length, 0, "proposed 0");
});
t("rule-propose: resolved 자격+askId 결속+원문 보존+rule-manual 스키마", () => {
  const r = CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "특정 파일을 넘어 반복될 수 있는 로그 유출 부류라 관통 지침", campaignId: camp, approvedHash: HASH });
  assert.strictEqual(r.ok, true, "상신 성공: " + (r.reason || ""));
  const { latest } = CL.readEnvelopeCandidates(WS);
  const rows = [...latest.values()].filter((x) => x.status === "proposed");
  assert.strictEqual(rows.length, 1);
  assert.ok(/^[0-9a-f]{16}$/.test(rows[0].candidateId), "16hex 계약(기존 판독기 호환)");
  assert.strictEqual(rows[0].kind, "rule-manual");
  assert.strictEqual(rows[0].origin, "manual");
  assert.strictEqual(rows[0].policyVersion, 2);
  assert.strictEqual(rows[0].title, "결제 실패 시 카드번호가 평문 로그에 남음", "문안=지적 원문(자동 작문 금지)");
  assert.strictEqual(rows[0].askId, "ask-test-1", "마감 askId 결속");
  assert.ok(rows[0].why && rows[0].why.length <= 120, "why 보존");
});
t("rule-propose 자격 거부: 비blocker=not-blocker·legacy(title 부재)=legacy-unbound·기등재=already-in-envelope", () => {
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-cccc0003", why: "이유", campaignId: camp, approvedHash: HASH }).reason, "not-blocker");
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-bbbb0002", why: "이유", campaignId: camp, approvedHash: HASH }).reason, "legacy-unbound");
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-dddd0004", why: "이유", campaignId: camp, approvedHash: HASH }).reason, "already-in-envelope");
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "이유", campaignId: "cl:other:1", approvedHash: HASH }).reason, "other-campaign");
});
t("rule-propose why 방어: 누락·다행·120자 초과·민감 형태=거부(user-constraint 동형)", () => {
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "", campaignId: camp, approvedHash: HASH }).reason, "why-missing");
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "줄1\n줄2", campaignId: camp, approvedHash: HASH }).reason, "why-format");
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "가".repeat(121), campaignId: camp, approvedHash: HASH }).reason, "why-format");
  assert.ok(String(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "sk-ant-api03-abcdefghijklmnopqrstuvwx 키", campaignId: camp, approvedHash: HASH }).reason).startsWith("why-sensitive-"), "민감 형태 거부");
});
t("rule-propose 멱등: 같은 세대 재상신=duplicate·reconcile 재실행도 중복 없음", () => {
  assert.strictEqual(CL.ruleProposeCandidate(WS, REPO, { findingId: "f-aaaa0001", why: "다시 이유", campaignId: camp, approvedHash: HASH }).reason, "duplicate");
  const r2 = CL.reconcileMemoryCandidates(WS, REPO, HASH);
  assert.strictEqual(r2.appended, 0);
  const { rows } = CL.readEnvelopeCandidates(WS);
  assert.strictEqual(rows.filter((x) => x.status === "proposed").length, 1, "append-only 원장에도 proposed 1건뿐");
});
t("비활성(지문 없음): reconcile 무공급(A-6)+rule-propose envelope-inactive", () => {
  const r3 = CL.reconcileMemoryCandidates(WS, REPO, null);
  assert.strictEqual(r3.appended + r3.scanned, 0);
});
t("rule-propose pending 상한=차단이 아니라 경고(수동 판단 산출·설계 v4 §2-1)", () => {
  const many = [];
  for (let i = 0; i < CL.MEMORY_CANDIDATE_PENDING_MAX; i++) many.push({ candidateId: crypto.createHash("sha1").update("pad" + i).digest("hex").slice(0, 16), envelopeHash: HASH, status: "proposed", ts: "t" });
  CL.appendEnvelopeCandidates(WS, many);
  const extra = [
    { type: "finding", findingId: "f-eeee0005", campaignId: camp, round: 5, tag: "blocker", titleNorm: "t5", title: "새 위험 사례", envelopeHash: HASH, status: "open", ts: "t" },
    { type: "close", campaignId: camp, findingId: "f-eeee0005", closeReason: "resolved", round: 6, envelopeHash: HASH, askId: "ask-test-3", ts: "t" },
  ];
  fs.appendFileSync(CL.findingsLedgerFileFor(WS), extra.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r4 = CL.ruleProposeCandidate(WS, REPO, { findingId: "f-eeee0005", why: "상한 경고 확인용 관통 이유", campaignId: camp, approvedHash: HASH });
  assert.strictEqual(r4.ok, true, "상한이 수동 상신을 막지 않음");
  assert.strictEqual(r4.warn, "pending-cap", "경고 동봉(침묵 금지)");
});

// ── A-4 draft 병합 ───────────────────────────────────────────────────────────
t("draft: 병렬 En/Ex 축 원문 복제로 정본 검사 통과+adopted 전이+편집 필요 플래그", () => {
  const { latest } = CL.readEnvelopeCandidates(WS);
  const cand = [...latest.values()].find((x) => x.status === "proposed" && x.title);
  const r = CL.draftEnvelopeCandidate(WS, REPO, cand.candidateId, HASH);
  assert.strictEqual(r.ok, true, "draft 성공: " + (r.error || ""));
  assert.strictEqual(r.parallelCopied, true);
  const pr = CL.readEnvelopeProposal(WS, REPO);
  assert.strictEqual(pr.st, "ok", "제안본이 strict 판독 통과(길이 일치 정본 검사 포함)");
  const inner = JSON.parse(pr.proposalText);
  assert.strictEqual(inner.alwaysBlocker.length, 2);
  assert.strictEqual(inner.alwaysBlockerEn.length, 2, "En 병렬 축 길이 일치");
  assert.strictEqual(inner.alwaysBlockerEx.length, 2, "Ex 병렬 축 길이 일치");
  assert.strictEqual(inner.alwaysBlockerEn[1], inner.alwaysBlocker[1], "복제=원문 그대로(작문 금지)");
  assert.ok(pr.note.includes("사용자 편집 필요"), "복제 경고가 proposal note에 저장(§5-⑥)");
  assert.strictEqual(pr.baseHash, HASH, "생성 시점 승인 세대 결속");
  const after = CL.readEnvelopeCandidates(WS).latest.get(cand.candidateId + "@" + HASH);
  assert.strictEqual(after.status, "adopted");
  // [2026-08-21 초안 폐기 복원] 제안본에 candidateId 결속 → 복원형 폐기가 채택 후보를 proposed로 되돌림
  assert.strictEqual(pr.candidateId, cand.candidateId, "제안본에 후보 결속(candidateId — 폐기 복원 재료)");
  const rD = CL.discardEnvelopeProposalRestoring(WS);
  assert.strictEqual(rD.ok, true, "복원형 폐기 성공");
  assert.strictEqual(rD.restored, true, "채택 후보 복원 보고");
  assert.strictEqual(CL.readEnvelopeProposal(WS, REPO).st, "absent", "제안본 파일 제거됨(수칙서 원본 무변)");
  const back = CL.readEnvelopeCandidates(WS).latest.get(cand.candidateId + "@" + HASH);
  assert.strictEqual(back.status, "proposed", "★폐기 후 후보=proposed 복원(adopted 고아 반례의 정방향) — 재초안 가능");
  const r2d = CL.draftEnvelopeCandidate(WS, REPO, cand.candidateId, HASH);
  assert.strictEqual(r2d.ok, true, "복원된 후보로 재초안 성공(왕복 완결)");
  // 다음 시험들의 전제(제안본 상태)에 영향 없도록 재폐기·재복원 상태 유지
  CL.discardEnvelopeProposalRestoring(WS);
});
t("복원형 폐기 R2: 다세대 공존 시 '초안의 승인 세대'만 복원(과거 세대 오복원 반례의 정방향)", () => {
  // 검증자 실행 반례 재현: 같은 후보가 H1(과거)·현 세대(HASH) 양쪽에 adopted로 공존 — 초안 baseHash=HASH.
  const { latest } = CL.readEnvelopeCandidates(WS);
  const cand = [...latest.values()].find((x) => x.status === "proposed" && x.title && x.envelopeHash === HASH);
  const H1 = "9".repeat(40);
  CL.appendEnvelopeCandidates(WS, [{ candidateId: cand.candidateId, envelopeHash: H1, status: "proposed", title: cand.title, ts: "t" }]);
  CL.appendEnvelopeCandidates(WS, [{ candidateId: cand.candidateId, envelopeHash: H1, status: "adopted", note: "과거 세대 채택", ts: "t" }]);
  const rDr = CL.draftEnvelopeCandidate(WS, REPO, cand.candidateId, HASH); // 현 세대 초안(baseHash=HASH)
  assert.strictEqual(rDr.ok, true, "현 세대 재초안 성공(전제): " + (rDr.error || ""));
  const rD2 = CL.discardEnvelopeProposalRestoring(WS);
  assert.strictEqual(rD2.ok === true && rD2.restored === true, true, "복원형 폐기 성공");
  const lat2 = CL.readEnvelopeCandidates(WS).latest;
  assert.strictEqual(lat2.get(cand.candidateId + "@" + HASH).status, "proposed", "★현 세대(baseHash)만 proposed 복원");
  assert.strictEqual(lat2.get(cand.candidateId + "@" + H1).status, "adopted", "과거 세대(H1)는 무접촉(오복원 없음)");
  const rDr2 = CL.draftEnvelopeCandidate(WS, REPO, cand.candidateId, HASH);
  assert.strictEqual(rDr2.ok, true, "현 세대 후보로 재초안 가능(왕복 완결)");
  CL.discardEnvelopeProposalRestoring(WS); // 후속 시험 전제 정리
});
t("복원형 폐기 R3: 전이 잠금 직렬화 — 잠금 보유 중엔 폐기·draft 모두 무접촉 실패(경합 창 소멸)", () => {
  // 검증자 인터리빙 반례의 직렬화 증명: 다른 보유자가 잠금을 쥔 동안 폐기는 파일을 지우지 않고,
  // draft는 proposal을 쓰지 않는다 — 두 쓰기가 한 잠금을 공유하므로 '폐기가 읽은 뒤 draft가 끼어드는' 창 자체가 없다.
  const { latest } = CL.readEnvelopeCandidates(WS);
  const cand = [...latest.values()].find((x) => x.status === "proposed" && x.title && x.envelopeHash === HASH);
  const rDr = CL.draftEnvelopeCandidate(WS, REPO, cand.candidateId, HASH);
  assert.strictEqual(rDr.ok, true, "전제: 초안 존재");
  const lk = CL.acquireEnvelopeTransLock(WS);
  assert.strictEqual(lk.ok, true, "전제: 외부 보유자가 잠금 획득");
  try {
    const rD = CL.discardEnvelopeProposalRestoring(WS);
    assert.strictEqual(rD.ok === false && rD.restored === false, true, "★잠금 보유 중 폐기=무접촉 실패(파일·장부 불변)");
    assert.strictEqual(CL.readEnvelopeProposal(WS, REPO).st, "ok", "proposal 파일 보존(삭제 안 됨)");
    const rDr2 = CL.draftEnvelopeCandidate(WS, REPO, cand.candidateId, HASH);
    assert.strictEqual(rDr2.ok, false, "★잠금 보유 중 draft=실패(경합 안내)");
  } finally { CL.releaseEnvelopeTransLock(WS, lk.token); }
  const rD3 = CL.discardEnvelopeProposalRestoring(WS);
  assert.strictEqual(rD3.ok === true && rD3.restored === true, true, "잠금 해제 후 정상 폐기·복원(무회귀)");
});
t("개정판 빌더(작업대 2026-08-22): 올림 N+빼기 M 동시·병렬 축 미러·다건 복원 왕복", () => {
  // R2 보완(f-1c89d722): 다건 결속·복원을 실제 '2건'으로 고정 — 두 번째 후보를 합성 상신
  const cid2x = crypto.createHash("sha1").update("wb-second").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS, [{ candidateId: cid2x, envelopeHash: HASH, status: "proposed", kind: "resolved-blocker", title: "작업대 두 번째 후보 문안 — 다건 복원 고정용", ts: "t" }]);
  const { latest } = CL.readEnvelopeCandidates(WS);
  const cands = [...latest.values()].filter((x) => x.status === "proposed" && x.title && x.envelopeHash === HASH);
  assert.ok(cands.length >= 2, "전제: proposed 후보 2건 이상");
  const two = [cands[0].candidateId, cands.find((c) => c.candidateId !== cands[0].candidateId).candidateId];
  const cur0 = JSON.parse(fs.readFileSync(path.join(REPO, "verify-envelope.json"), "utf8"));
  const seLen0 = cur0.supportedEnv.length, abLen0 = cur0.alwaysBlocker.length;
  assert.ok(seLen0 >= 1, "전제: se축 항목 존재");
  const fpW=(s)=>crypto.createHash("sha1").update(CL.normBacklogTitle(s),"utf8").digest("hex"); // [재편 B] 빼기=행 지문 필수
  const r = CL.draftEnvelopeRevision(WS, REPO, { addCandidateIds: two, removeItems: [{ axis: "supportedEnv", index: 0, itemFp: fpW(cur0.supportedEnv[0]) }], approvedHash: HASH, expectedTargetHash: HASH });
  assert.strictEqual(r.ok, true, "올림 2+빼기 1 동시 성공: " + (r.error || ""));
  const pr = CL.readEnvelopeProposal(WS, REPO);
  assert.strictEqual(pr.st, "ok");
  const inner = JSON.parse(pr.proposalText);
  assert.strictEqual(inner.supportedEnv.length, seLen0 - 1, "se축 1건 제거");
  assert.strictEqual(inner.alwaysBlocker.length, abLen0 + 2, "ab축 2건 추가");
  if (Array.isArray(cur0.supportedEnvEn) && cur0.supportedEnvEn.length === seLen0) assert.strictEqual(inner.supportedEnvEn.length, seLen0 - 1, "병렬 축 같은 index 미러 제거(길이 일치 유지)");
  assert.deepStrictEqual([...pr.candidateIds].sort(), [...two].sort(), "제안본에 다건 결속 필드(candidateIds — 2건)");
  for (const c9 of two) assert.strictEqual(CL.readEnvelopeCandidates(WS).latest.get(c9 + "@" + HASH).status, "adopted", "올림 후보=adopted 기록(" + c9 + ")");
  // 다건 복원 왕복: 폐기 → candidateIds '전량' proposed 복원(R2 보완 — 2건 고정)
  const rD = CL.discardEnvelopeProposalRestoring(WS);
  assert.strictEqual(rD.ok === true && rD.restored === true, true, "폐기·복원 성공");
  for (const c9 of two) assert.strictEqual(CL.readEnvelopeCandidates(WS).latest.get(c9 + "@" + HASH).status, "proposed", "★폐기 후 2건 전량 복원(" + c9 + ")");
});
t("개정판 빌더 반례: 범위 밖 번호·중복 빼기·빈 선택·세대 불일치·잠금 경합=무접촉 거부", () => {
  const cur0 = JSON.parse(fs.readFileSync(path.join(REPO, "verify-envelope.json"), "utf8"));
  const nSe = cur0.supportedEnv.length;
  assert.strictEqual(CL.draftEnvelopeRevision(WS, REPO, { removeItems: [{ axis: "supportedEnv", index: nSe }], approvedHash: HASH }).ok, false, "범위 밖 번호=거부(선점 화면 낡음 안내)");
  assert.strictEqual(CL.draftEnvelopeRevision(WS, REPO, { removeItems: [{ axis: "outOfScope", index: 0 }, { axis: "outOfScope", index: 0 }], approvedHash: HASH }).ok, false, "같은 항목 중복 빼기=거부(의도 모호)");
  assert.strictEqual(CL.draftEnvelopeRevision(WS, REPO, { approvedHash: HASH }).ok, false, "빈 선택=거부");
  assert.strictEqual(CL.draftEnvelopeRevision(WS, REPO, { removeItems: [{ axis: "supportedEnv", index: 0 }], approvedHash: "0".repeat(40) }).ok, false, "세대 불일치=거부(baseHash 결속)");
  const lk = CL.acquireEnvelopeTransLock(WS);
  try { assert.match(String(CL.draftEnvelopeRevision(WS, REPO, { removeItems: [{ axis: "supportedEnv", index: 0 }], approvedHash: HASH }).error || ""), /잠금 경합/, "잠금 보유 중=무접촉 실패(writer 직렬화 합류)"); }
  finally { CL.releaseEnvelopeTransLock(WS, lk.token); }
});
t("승인 지문 언어 공유(2026-08-22): setEnvelopeHashAllSlots=양 슬롯 기록", () => {
  const H9 = "e".repeat(40);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, H9), 2, "ko·en 두 슬롯 모두 성공");
  assert.strictEqual((CL.loadContract(WS, "ko") || {}).envelopeHash, H9, "ko 슬롯 기록");
  assert.strictEqual((CL.loadContract(WS, "en") || {}).envelopeHash, H9, "en 슬롯 기록 — 도장은 문서 전문에 찍히므로 언어 무관(비의도 분리 봉합)");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(src.includes("const upN = setContractHashAllSlots(ws, tgtW.hashField, wal.newHash)"), "전이(도장) 경로도 양 슬롯+대상 필드 표 분기(소스 계약 — v6 target 차원)");
});
t("승인 지문 언어 공유 R2(f-71d4c2a8 반례): 부분 성공(1슬롯)=실패·WAL 보존 → 장애 해소 후 복구 재시도로 2슬롯 수렴", () => {
  const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws3-"));
  const REPO3 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo3-"));
  fs.writeFileSync(path.join(REPO3, CL.ENVELOPE_FILE), envRaw);
  const newObj = JSON.parse(envRaw); newObj.outOfScope = newObj.outOfScope.concat(["부분 실패 반례 항목"]);
  const newText = JSON.stringify(newObj, null, 1);
  const newHash = crypto.createHash("sha1").update(newText).digest("hex");
  const walFile = CL.envelopeTransWalFileFor(WS3);
  fs.mkdirSync(path.dirname(walFile), { recursive: true });
  fs.writeFileSync(walFile, JSON.stringify({ schema: "env-trans-wal-v1", ws: WS3, repo: REPO3, lang: "ko", oldText: envRaw, oldHash: HASH, newText, newHash, ts: "T" }));
  // en 슬롯 장애 주입: 계약 파일 경로를 디렉터리로 점유 → 쓰기 실패(실행 반례 — 모킹 없음)
  const enF = CL.contractFileFor(WS3, "en");
  fs.mkdirSync(enF, { recursive: true });
  const r1 = CL.recoverEnvelopeTransition(WS3);
  assert.strictEqual(r1.st, "failed", "부분 성공=완료 확정 금지(실패 반환)");
  assert.strictEqual(r1.reason, "contract-write-partial", "사유=부분 기록(0슬롯 실패와 구분)");
  assert.ok(fs.existsSync(walFile), "WAL 보존 — 재시도로 수렴할 때까지 정리 금지");
  assert.strictEqual((CL.loadContract(WS3, "ko") || {}).envelopeHash, newHash, "성공 슬롯(ko)은 기록됨(멱등 재시도 전제)");
  assert.notStrictEqual((CL.loadContract(WS3, "en") || {}).envelopeHash, newHash, "장애 슬롯(en)=미기록");
  fs.rmdirSync(enF); // 장애 해소
  const r2 = CL.recoverEnvelopeTransition(WS3);
  assert.strictEqual(r2.st, "recovered", "복구 재시도=완료(원본 교체는 멱등 통과)");
  assert.strictEqual((CL.loadContract(WS3, "en") || {}).envelopeHash, newHash, "en 슬롯 수렴");
  assert.strictEqual((CL.loadContract(WS3, "ko") || {}).envelopeHash, newHash, "ko 슬롯 유지");
  assert.ok(!fs.existsSync(walFile), "완료 후 WAL 정리");
});
t("직접 승인 R3(확인검증 blocker 연속분): stampEnvelopeAllSlots=WAL 경유 트랜잭션 — 부분 실패=WAL 잔존·복구 수렴, 경합 변경=거부", () => {
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws4-"));
  const REPO4 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo4-"));
  fs.writeFileSync(path.join(REPO4, CL.ENVELOPE_FILE), envRaw);
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS4, REPO4, "0".repeat(40)).reason, "sha-drift", "사용자가 본 전문과 다른 지문=거부");
  const r1 = CL.stampEnvelopeAllSlots(WS4, REPO4, HASH);
  assert.strictEqual(r1.ok, true, "정상 도장 성공: " + (r1.reason || ""));
  assert.strictEqual((CL.loadContract(WS4, "ko") || {}).envelopeHash, HASH, "ko 슬롯 기록");
  assert.strictEqual((CL.loadContract(WS4, "en") || {}).envelopeHash, HASH, "en 슬롯 기록");
  assert.strictEqual(CL.envelopeTransState(WS4), "clear", "성공 후 WAL 정리(원본 무변 — 순수 지문 트랜잭션)");
  // 부분 실패: en 계약 경로 디렉터리 점유 + 새 전문으로 재도장 시도
  const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws5-"));
  fs.mkdirSync(CL.contractFileFor(WS5, "en"), { recursive: true });
  const r2 = CL.stampEnvelopeAllSlots(WS5, REPO4, HASH);
  assert.strictEqual(r2.ok, false, "부분 성공=완료 금지");
  assert.strictEqual(r2.reason, "contract-write-partial", "사유=부분 기록");
  assert.strictEqual(CL.envelopeTransState(WS5), "recover-needed", "★WAL 잔존=검증 시작 차단 상태(조용한 반쪽 승인 금지)");
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS5, REPO4, HASH).reason, "recover-needed", "WAL 잔존 중 재도장=거부(복구 우선)");
  fs.rmdirSync(CL.contractFileFor(WS5, "en"));
  assert.strictEqual(CL.recoverEnvelopeTransition(WS5).st, "recovered", "장애 해소 후 복구=수렴");
  assert.strictEqual((CL.loadContract(WS5, "en") || {}).envelopeHash, HASH, "en 슬롯 수렴");
  assert.strictEqual(CL.envelopeTransState(WS5), "clear", "수렴 후 WAL 정리");
});
t("직접 승인 R4(f-6c81a2d4 반례): 도장 정리가 병행 초안을 삭제하지 않음+proposal 존재=도장 거부+한 잠금 계약", () => {
  const WS6 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws6-"));
  const REPO6 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo6-"));
  fs.writeFileSync(path.join(REPO6, CL.ENVELOPE_FILE), envRaw);
  const pObj = JSON.parse(envRaw); pObj.outOfScope = pObj.outOfScope.concat(["병행 초안 항목"]);
  const pText = JSON.stringify(pObj, null, 1);
  // ① proposal 존재=도장 거부(잠금 안 재확인 — 초안 폐기 오발 방지)
  assert.strictEqual(CL.writeEnvelopeProposal(WS6, REPO6, pText, "t", {}).ok, true, "초안 픽스처 기록");
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS6, REPO6, HASH).reason, "proposal-pending", "초안 대기 중 직접 도장=거부");
  CL.discardEnvelopeProposal(WS6);
  // ② 부분 실패로 도장 WAL 잔존 → 그 사이 초안 생성(병행 writer 시나리오) → 복구 완료 후 초안 생존
  fs.mkdirSync(CL.contractFileFor(WS6, "en"), { recursive: true });
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS6, REPO6, HASH).reason, "contract-write-partial", "부분 실패=WAL 잔존");
  assert.strictEqual(CL.writeEnvelopeProposal(WS6, REPO6, pText, "t2", {}).ok, true, "WAL 잔존 창에서 초안 생성(병행 재현)");
  fs.rmdirSync(CL.contractFileFor(WS6, "en"));
  assert.strictEqual(CL.recoverEnvelopeTransition(WS6).st, "recovered", "복구 수렴");
  assert.strictEqual(CL.readEnvelopeProposal(WS6, REPO6).st, "ok", "★도장 WAL(kind:stamp) 정리가 무관한 초안을 삭제하지 않음(채택 후보 고아화 금지)");
  assert.strictEqual((CL.loadContract(WS6, "ko") || {}).envelopeHash, HASH, "ko 수렴");
  assert.strictEqual((CL.loadContract(WS6, "en") || {}).envelopeHash, HASH, "en 수렴");
  // ③ 소스 계약: 확인·WAL·전이=한 전이 잠금 아래(잠금 보유형 본체 직접 호출)·정리=제안본 소비 전이만 폐기
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(/function stampEnvelopeAllSlots\(ws, repo, sha, target\) \{[\s\S]{0,600}acquireEnvelopeTransLock\(ws\)/.test(src) && src.includes("return applyEnvelopeTransitionLocked(ws, repo, null, wal);"), "도장=잠금 보유 구간 안 확인→WAL→전이(target 인자 확장 — v6)");
  assert.ok(src.includes('if (wal.kind !== "stamp") {') && src.includes('pOwn.st === "ok" && pOwn.newHash === wal.newHash'), "정리 분기=도장 WAL 제외+소유(전문 지문) 결속 확인부만 폐기");
});
t("개정 전이 R5(f-9b7c4e21 반례): 소비한 제안본만 폐기 — recover 창에서 생긴 다른 초안은 복구가 삭제하지 않음", () => {
  const WS7 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws7-"));
  const REPO7 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo7-"));
  fs.writeFileSync(path.join(REPO7, CL.ENVELOPE_FILE), envRaw);
  // ① 정상 개정 전이: 자기 제안본(P1)은 종전대로 소비·폐기(소유 결속 일치 경로 무회귀)
  const o1 = JSON.parse(envRaw); o1.outOfScope = o1.outOfScope.concat(["개정 1"]);
  const t1 = JSON.stringify(o1, null, 1);
  assert.strictEqual(CL.writeEnvelopeProposal(WS7, REPO7, t1, "p1", {}).ok, true);
  const rA = CL.applyEnvelopeTransition(WS7, REPO7, "ko", null);
  assert.strictEqual(rA.ok, true, "정상 전이 성공: " + (rA.reason || ""));
  assert.strictEqual(CL.readEnvelopeProposal(WS7, REPO7).st, "absent", "소비한 P1=폐기(무회귀)");
  // ② 개정 WAL 부분 실패 → recover 창에서 '다른' 초안 P3 생성 → 복구 완료 후 P3 생존
  const o2 = JSON.parse(t1); o2.outOfScope = o2.outOfScope.concat(["개정 2"]);
  const t2 = JSON.stringify(o2, null, 1);
  const h1 = crypto.createHash("sha1").update(t1).digest("hex");
  const h2 = crypto.createHash("sha1").update(t2).digest("hex");
  const walFile = CL.envelopeTransWalFileFor(WS7);
  fs.writeFileSync(walFile, JSON.stringify({ schema: "env-trans-wal-v1", ws: WS7, repo: REPO7, lang: "ko", oldText: t1, oldHash: h1, newText: t2, newHash: h2, ts: "T" }));
  // ①의 정상 전이가 en 계약 '파일'을 이미 만들었으므로, 파일 제거 후 경로를 디렉터리로 점유해 쓰기 장애 주입
  fs.rmSync(CL.contractFileFor(WS7, "en"), { force: true });
  fs.mkdirSync(CL.contractFileFor(WS7, "en"), { recursive: true });
  assert.strictEqual(CL.recoverEnvelopeTransition(WS7).reason, "contract-write-partial", "부분 실패=WAL 잔존");
  const o3 = JSON.parse(t2); o3.outOfScope = o3.outOfScope.concat(["개정 3 — 병행 초안"]);
  const t3 = JSON.stringify(o3, null, 1);
  assert.strictEqual(CL.writeEnvelopeProposal(WS7, REPO7, t3, "p3", {}).ok, true, "recover 창에서 다른 초안 생성(병행 재현)");
  fs.rmdirSync(CL.contractFileFor(WS7, "en"));
  assert.strictEqual(CL.recoverEnvelopeTransition(WS7).st, "recovered", "복구 수렴");
  const pAfter = CL.readEnvelopeProposal(WS7, REPO7);
  assert.strictEqual(pAfter.st, "ok", "★소유 불일치 초안=보존(복구가 삭제하지 않음)");
  assert.strictEqual(pAfter.newHash, crypto.createHash("sha1").update(t3).digest("hex"), "생존본=P3 그대로");
  assert.strictEqual((CL.loadContract(WS7, "en") || {}).envelopeHash, h2, "슬롯은 WAL 전이대로 수렴");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(src.includes("pOwn.st === \"ok\" && pOwn.newHash === wal.newHash"), "정리=전문 지문 결속 확인부만 폐기(소스 계약)");
});
t("부품 C R1: user-constraint 세대 이월(carry-forward) — proposed·adopted 미등재 각 1회·이미 등재=정리·멱등", () => {
  const WS8 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws8-"));
  const REPO8 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo8-"));
  fs.writeFileSync(path.join(REPO8, CL.ENVELOPE_FILE), envRaw);
  const H_OLD = "b".repeat(40);
  const uc = (i) => crypto.createHash("sha1").update("uc" + i).digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS8, [
    { candidateId: uc(1), envelopeHash: H_OLD, status: "proposed", kind: "user-constraint", title: "배포 전에는 반드시 백업부터 남겨야 한다", why: "사용자 약속", provider: "claude", ts: "T" },
    { candidateId: uc(2), envelopeHash: H_OLD, status: "adopted", kind: "user-constraint", title: "고객 차단 기록은 지우지 않는다", ts: "T" },
    { candidateId: uc(3), envelopeHash: H_OLD, status: "proposed", kind: "user-constraint", title: envObj.alwaysBlocker[0], ts: "T" },
  ]);
  const r1 = CL.reconcileMemoryCandidates(WS8, REPO8, HASH);
  const { latest } = CL.readEnvelopeCandidates(WS8);
  const g1 = latest.get(uc(1) + "@" + HASH), g2 = latest.get(uc(2) + "@" + HASH), g3 = latest.get(uc(3) + "@" + HASH);
  assert.ok(g1 && g1.status === "proposed" && g1.title === "배포 전에는 반드시 백업부터 남겨야 한다" && g1.why === "사용자 약속", "★구세대 proposed=새 세대 이월(문안·근거 승계 — 소실 금지)");
  assert.ok(g2 && g2.status === "proposed", "★구세대 adopted-but-unstamped=새 세대 proposed 재발급(도장 안 된 채택의 소실 금지)");
  assert.ok(g3 && g3.status === "declined", "이미 수칙서에 등재된 문안=이월 대신 declined 정리");
  const before = CL.readEnvelopeCandidates(WS8).rows.length;
  CL.reconcileMemoryCandidates(WS8, REPO8, HASH);
  assert.strictEqual(CL.readEnvelopeCandidates(WS8).rows.length, before, "★재실행 멱등 — candidateId별 새 세대 정확히 1회(latest.has 규칙)");
  assert.ok(r1, "반환 존재(정보)");
  // [재검증 blocker 반례] 다중 구세대 공존: 같은 후보가 H1·H2 두 구세대 키로 남아 있어도 새 세대 발급은 1회
  const H2 = "c".repeat(40);
  const ucM = crypto.createHash("sha1").update("ucMulti").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS8, [
    { candidateId: ucM, envelopeHash: H_OLD, status: "proposed", kind: "user-constraint", title: "다중 세대 공존 약속", ts: "T" },
    { candidateId: ucM, envelopeHash: H2, status: "proposed", kind: "user-constraint", title: "다중 세대 공존 약속", ts: "T" },
  ]);
  CL.reconcileMemoryCandidates(WS8, REPO8, HASH);
  const dupRows = CL.readEnvelopeCandidates(WS8).rows.filter((r) => r.candidateId === ucM && String(r.envelopeHash || "") === HASH);
  assert.strictEqual(dupRows.length, 1, "★H1·H2 공존 후보=현 세대 재발급 정확히 1행(중복=pending 허위 소진 반례의 정방향)");
});
t("부품 C R2: 같은 세대 adopted 고아 복원 — proposal 미결속만 복원·결속/등재는 무접촉", () => {
  const WS9 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws9-"));
  const REPO9 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo9-"));
  fs.writeFileSync(path.join(REPO9, CL.ENVELOPE_FILE), envRaw);
  const ud = (i) => crypto.createHash("sha1").update("ud" + i).digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS9, [
    { candidateId: ud(4), envelopeHash: HASH, status: "adopted", kind: "user-constraint", title: "복구 시험은 매주 한 번 돌린다", ts: "T" },
    { candidateId: ud(5), envelopeHash: HASH, status: "adopted", kind: "resolved-blocker", title: "초안에 결속된 채택", ts: "T" },
    { candidateId: ud(6), envelopeHash: HASH, status: "adopted", kind: "user-constraint", title: envObj.alwaysBlocker[0], ts: "T" },
  ]);
  const o6 = JSON.parse(envRaw); o6.outOfScope = o6.outOfScope.concat(["초안 픽스처 항목"]);
  assert.strictEqual(CL.writeEnvelopeProposal(WS9, REPO9, JSON.stringify(o6, null, 1), "t", { candidateIds: [ud(5)] }).ok, true, "진행 중 초안(ud5 결속) 픽스처");
  CL.reconcileMemoryCandidates(WS9, REPO9, HASH);
  const { latest: l9 } = CL.readEnvelopeCandidates(WS9);
  assert.strictEqual(l9.get(ud(4) + "@" + HASH).status, "proposed", "★초안 미결속 adopted=proposed 복원(덮어쓰기 고아 봉합 — 재채택 가능)");
  assert.strictEqual(l9.get(ud(5) + "@" + HASH).status, "adopted", "진행 중 초안에 결속된 adopted=무접촉");
  assert.strictEqual(l9.get(ud(6) + "@" + HASH).status, "adopted", "문안이 이미 수칙서에 등재(도장 완료 형상)=무접촉");
});
t("부품 C R3: mark 우회 가드 — draftable adopted=거부·declined 허용·비 draftable 허용", () => {
  const WS10 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-ws10-"));
  const ue = (i) => crypto.createHash("sha1").update("ue" + i).digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS10, [
    { candidateId: ue(1), envelopeHash: HASH, status: "proposed", kind: "user-constraint", title: "t", ts: "T" },
    { candidateId: ue(2), envelopeHash: HASH, status: "proposed", kind: "oos-repeat", ts: "T" },
  ]);
  const gA = CL.envelopeMarkGuard(WS10, ue(1), "adopted");
  assert.ok(!gA.ok && gA.reason === "draftable-adopt-via-draft" && gA.kind === "user-constraint", "★draftable 채택 직접 기록=거부(초안 결속 강제 — §3-3b)");
  assert.strictEqual(CL.envelopeMarkGuard(WS10, ue(1), "declined").ok, true, "declined는 mark 허용");
  assert.strictEqual(CL.envelopeMarkGuard(WS10, ue(2), "adopted").ok, true, "비 draftable kind=기존 계약 유지");
  assert.deepStrictEqual(CL.ENVELOPE_DRAFTABLE_KINDS, ["resolved-blocker", "user-constraint", "rule-manual"], "allowlist 단일 정본(재편 A: rule-manual 편입·legacy 호환 유지)");
});
t("복원형 폐기: candidateId 없는 구형/수동 제안본=복원 없이 폐기만(보수)", () => {
  const cur = JSON.parse(fs.readFileSync(path.join(REPO, "verify-envelope.json"), "utf8"));
  const w = CL.writeEnvelopeProposal(WS, REPO, JSON.stringify(cur, null, 1), "수동 초안"); // meta 없음
  assert.strictEqual(w.ok, true);
  const rD = CL.discardEnvelopeProposalRestoring(WS);
  assert.strictEqual(rD.ok === true && rD.restored === false, true, "결속 없음=복원 없음·폐기만(기존 동작 보존)");
});
t("draft: 수칙서가 승인 세대와 다르면 거부(baseHash 결속·§5-3)", () => {
  const cid = crypto.createHash("sha1").update("x1").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS, [{ candidateId: cid, envelopeHash: "0".repeat(40), status: "proposed", title: "다른 세대 후보", ts: "t" }]);
  const r = CL.draftEnvelopeCandidate(WS, REPO, cid, "0".repeat(40));
  assert.strictEqual(r.ok, false);
  assert.ok(/승인 세대와 다름|판독 실패/.test(r.error));
});
t("draft: ab축 12항 상한=거부(자동 삭제 금지·§5-5)", () => {
  const full = { ...envObj, alwaysBlocker: Array.from({ length: 12 }, (_, i) => "규칙" + i) };
  delete full.alwaysBlockerEn; delete full.alwaysBlockerEx;
  const REPO2 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-repo2-"));
  const raw2 = JSON.stringify(full, null, 1);
  fs.writeFileSync(path.join(REPO2, CL.ENVELOPE_FILE), raw2);
  const H2 = crypto.createHash("sha1").update(raw2).digest("hex");
  const cid2 = crypto.createHash("sha1").update("x2").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS, [{ candidateId: cid2, envelopeHash: H2, status: "proposed", title: "13번째", ts: "t" }]);
  const r = CL.draftEnvelopeCandidate(WS, REPO2, cid2, H2);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes("12항 상한"));
});

// ── C-2 제약 처리 파서 ───────────────────────────────────────────────────────
const carrier = { envelope: { hash: HASH, sup: ["sup-1"], ab: ["ab-1", "ab-2"], oos: ["oos-1"] } };
t("파서: 행 단독 ko/en 표기 파싱+무표기=irrelevant('찾았지만 버림' 구분 재료)", () => {
  const h = CB.parseConstraintHandling("서론\n제약적용 ab-1\nconstraint-superseded ab-2\n본문 제약기각 ab-1 인라인은 무시", carrier);
  assert.deepStrictEqual(h, [{ id: "ab-1", handling: "used" }, { id: "ab-2", handling: "superseded" }]);
});
t("파서: 동봉 밖 abId 무시+상충 표기=conflict(결합확인 규약 동형)", () => {
  const h = CB.parseConstraintHandling("제약적용 ab-9\n제약적용 ab-1\n제약기각 ab-1", carrier);
  assert.strictEqual(h.find((x) => x.id === "ab-1").handling, "conflict");
  assert.ok(!h.some((x) => x.id === "ab-9"));
});
t("파서: ab 동봉 없음=null(분모 오염 방지)", () => {
  assert.strictEqual(CB.parseConstraintHandling("제약적용 ab-1", { envelope: { ab: [] } }), null);
  assert.strictEqual(CB.parseConstraintHandling("제약적용 ab-1", null), null);
});

// ── B-1 프로필 문구+회귀 핀(§5-1·6) ─────────────────────────────────────────
t("프로필 4곳: ab 직접 충돌 조항+처리 표기 지시 존재(core/integrity·ko/en)", () => {
  assert.ok(CL.BASE_CORE.verifyBaseline.includes("⑥경계 ab-* 항목과의 직접 충돌"));
  assert.ok(CL.BASE_CORE.verifyBaseline.includes("제약적용|제약기각|제약대체 ab-N"));
  assert.ok(CL.BASE_CORE_EN.verifyBaseline.includes("constraint-used|constraint-rejected|constraint-superseded ab-N"));
  assert.ok(CL.BASE_DEFAULTS.verifyBaseline.includes("제약적용/제약기각/제약대체 ab-N"));
  assert.ok(CL.BASE_DEFAULTS_EN.verifyBaseline.includes("constraint-used/constraint-rejected/constraint-superseded"));
});
t("문구 한정: '직접 충돌'만 blocker·간접은 기존 세 갈래 유지(§5-6)+코드 증거 우위(superseded 통로·§5-7)", () => {
  assert.ok(CL.BASE_CORE.verifyBaseline.includes("간접 연관=기존 세 갈래"));
  assert.ok(CL.BASE_CORE.verifyBaseline.includes("무효화함을 직접 확인했다면 blocker 대신"));
});
t("회귀 핀: 지도=참고 라벨·scout 태생 candidate 강제 무변경(§5-1·2)", () => {
  const mr = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-reader.js"), "utf8");
  assert.ok(mr.includes("참고 — 판정 기준 아님"), "지도 참고 라벨 유지");
  const me = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  assert.ok(/confidence[^\n]*candidate/.test(me), "add_node candidate 강제 흔적 유지");
});

// ── C-1 배선 소스 계약(같은 파일 결속 — 문자열 핀) ───────────────────────────
t("배선 핀: attach 행 askId+envelope 스냅샷·flagVerdict(askId·carrier)·판정말미 조정 트리거", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(src.includes("appendAttachUsage({ ts: new Date().toISOString(), ws: ws || configWs(), askId: askId9"), "attach 행 askId");
  assert.ok(src.includes("function flagVerdict(answer, ws, codexSession, modeSnapshot, machine, attempt, providerName, askId, attCarrier)"), "판정 행 결속 시그니처");
  assert.ok(src.includes("reconcileMemoryCandidates(ws, resolveScoutRepo(ws, contractSnap || loadContract(ws)).repo"), "판정 말미 트리거");
  assert.ok(src.includes('sub === "draft"'), "draft CLI");
  const cl = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(cl.includes("sha1: ev.sha1, axes"), "envelopeInjectionFor 축 실물 반환");
});


// ── 구현검증 1차 blocker 봉합 실행 반례([15]~) ───────────────────────────────
t("B2 실행: 승인 시점 baseHash 재검사 — draft 후 수칙서 편집=전이 거부(base-drift)·원복=성공", () => {
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-b2-"));
  const rp2 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-b2r-"));
  const eo = { schema: "verify-envelope-v1", supportedEnv: ["로컬"], alwaysBlocker: ["기존 제약"], outOfScope: [] };
  const raw0 = JSON.stringify(eo, null, 1);
  fs.writeFileSync(path.join(rp2, CL.ENVELOPE_FILE), raw0);
  const next = { ...eo, alwaysBlocker: [...eo.alwaysBlocker, "새 제약"] };
  const w = CL.writeEnvelopeProposal(ws2, rp2, JSON.stringify(next, null, 1), "");
  assert.ok(w.ok, "제안 저장");
  fs.writeFileSync(path.join(rp2, CL.ENVELOPE_FILE), JSON.stringify({ ...eo, outOfScope: ["사용자 편집분"] }, null, 1));
  const r1 = CL.applyEnvelopeTransition(ws2, rp2, "ko", null);
  assert.strictEqual(r1.ok, false); assert.strictEqual(r1.reason, "base-drift", "편집 감지=거부(덮어쓰기 차단)");
  fs.writeFileSync(path.join(rp2, CL.ENVELOPE_FILE), raw0);
  const r2 = CL.applyEnvelopeTransition(ws2, rp2, "ko", null);
  assert.ok(r2.ok, "원복 후 전이 성공");
});
t("B3 실행: 200자 초과 title=절단 표식과 함께 병합(무표식 절단 금지)+상한 준수", () => {
  const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-b3-"));
  const rp3 = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-b3r-"));
  const eo3 = { schema: "verify-envelope-v1", supportedEnv: ["로컬"], alwaysBlocker: ["기존"], outOfScope: [] };
  const raw3 = JSON.stringify(eo3, null, 1);
  fs.writeFileSync(path.join(rp3, CL.ENVELOPE_FILE), raw3);
  const h3 = crypto.createHash("sha1").update(raw3).digest("hex");
  const longT = "가".repeat(250);
  const led3 = [
    { type: "finding", findingId: "f-eeee0005", campaignId: "cl:b3", round: 1, tag: "blocker", titleNorm: "tl", title: longT, envelopeHash: h3, status: "open", ts: "t" },
    { type: "close", campaignId: "cl:b3", findingId: "f-eeee0005", closeReason: "resolved", round: 2, envelopeHash: h3, askId: "ask-b3", ts: "t" },
  ];
  fs.mkdirSync(path.dirname(CL.findingsLedgerFileFor(ws3)), { recursive: true });
  fs.writeFileSync(CL.findingsLedgerFileFor(ws3), led3.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rp0 = CL.ruleProposeCandidate(ws3, rp3, { findingId: "f-eeee0005", why: "절단 표식 검사용 관통 이유", campaignId: "cl:b3", approvedHash: h3 });
  assert.strictEqual(rp0.ok, true, "상신 성공: " + (rp0.reason || ""));
  const cid3 = [...CL.readEnvelopeCandidates(ws3).latest.values()].find((x) => x.status === "proposed").candidateId;
  const dr = CL.draftEnvelopeCandidate(ws3, rp3, cid3, h3);
  assert.ok(dr.ok, "draft 성공: " + (dr.error || ""));
  const pr = CL.readEnvelopeProposal(ws3, rp3);
  const merged = JSON.parse(pr.proposalText).alwaysBlocker;
  const last = merged[merged.length - 1];
  assert.ok(last.endsWith("…[절단]"), "절단 표식 보존");
  assert.ok(last.length <= 200, "상한 준수(표식 포함)");
});
t("B4 실행(재편 A): 계산기에 rule-manual 후보 합류(why 동봉)+legacy 자동상신 잔여=정책 개정 declined(§5-3)", () => {
  CL.updateContractPatch(WS, undefined, { envelopeHash: HASH });
  // 계산기 세대=마지막 ask 동결(readFrozenEnvelope) — 시험도 실경로로 동결을 만든다(WS 자체가 정찰 대상·수칙서는 아래 B1 시험과 공유)
  fs.writeFileSync(path.join(WS, CL.ENVELOPE_FILE), envRaw);
  const frozen = CL.freezeEnvelopeForAsk(WS, WS, "ko");
  assert.strictEqual(frozen, HASH, "동결=승인 세대");
  const cc = CB.computeEnvelopeCandidatesFor(WS);
  const rb = (cc.live || []).filter((c) => c.kind === "rule-manual");
  assert.ok(rb.length >= 1, "rule-manual 후보가 live 목록에 합류");
  assert.ok(rb.some((c) => c.titles && c.titles[0] && c.titles[0].includes("카드번호")), "문안=지적 원문");
  assert.ok(rb.some((c) => typeof c.why === "string" && c.why.includes("관통")), "why(왜 관통 지침인지) 화면 전달");
  // legacy 자동 상신 잔여(policyVersion 부재 resolved-blocker proposed) → reconcile이 정책 개정 사유로 정리
  const legacyId = crypto.createHash("sha1").update("legacy-auto-1").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS, [{ candidateId: legacyId, envelopeHash: HASH, status: "proposed", kind: "resolved-blocker", title: "legacy 자동 상신 잔여 문안", findingId: "f-legacy01", ts: "t" }]);
  CL.reconcileMemoryCandidates(WS, REPO, HASH);
  const { latest } = CL.readEnvelopeCandidates(WS);
  const lg = latest.get(legacyId + "@" + HASH);
  assert.ok(lg && lg.status === "declined" && /공급 정책 개정/.test(lg.note || ""), "legacy 한정 declined+사유(재상신 경로 안내)");
  const rm = [...latest.values()].filter((x) => x.status === "proposed" && x.kind === "rule-manual");
  assert.ok(rm.length >= 1, "rule-manual proposed는 무접촉(한정 정리의 경계)");
});
t("B1 실행: withContract askId 전달 → attach 행에 같은 askId+경계 축 id '배열' 기록(개수 아님)", () => {
  fs.writeFileSync(path.join(WS, CL.ENVELOPE_FILE), envRaw);
  CL.updateContractPatch(WS, undefined, { envelopeHash: HASH });
  const carrier = {};
  const askU = "uuid-attach-join-1";
  CB.withContract("경계 결속 시험", WS, "ko", carrier, "core", CL.loadContract(WS), askU);
  assert.ok(carrier.envelope && Array.isArray(carrier.envelope.ab), "carrier에 경계 실물");
  const rows = fs.readFileSync(path.join(HOME, "stats", "attach.jsonl"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const row = rows.reverse().find((r) => r.askId === askU);
  assert.ok(row, "attach 행이 호출자 askId로 기록(verdicts 행과 조인 키 일치)");
  assert.deepStrictEqual(row.envelope.ab, ["ab-1"], "축 id 배열 그대로(개수 축약 금지)");
  assert.deepStrictEqual(row.envelope.oos, ["oos-1"]);
});
t("B5 실행: memReceiptLine — 동봉 ab 처리 요약 1줄(무동봉=빈 문자열)", () => {
  const carrier5 = { envelope: { hash: "h", sup: [], ab: ["ab-1", "ab-2"], oos: [] } };
  const line = CB.memReceiptLine("검토 결과\n제약적용 ab-1\n끝", carrier5, "ko");
  assert.ok(line.includes("[기억 영수증]") && line.includes("적용 1") && line.includes("무표기 1"), "요약 수치: " + line);
  assert.strictEqual(CB.memReceiptLine("답", {}, "ko"), "", "ab 미동봉=출력 없음");
});
t("B4·B5 소스 계약: 출력 합류·대시보드 표면(더 보기·draft 버튼·모달 note·kind 전달)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(src.includes("+ memReceiptLine(answer, attCarrier, langSnap)"), "출력 조립에 영수증 줄 합류");
  assert.ok(src.includes("withContract(prompt, ws, lang, carrier, profile, contractSnap, askId9p)"), "withContract askId 파라미터");
  assert.strictEqual((src.match(/contractSnap, askId\)/g) || []).length, 3, "3개 호출부 전부 askId 전달");
  assert.ok(src.includes("mapAbsent: !attSnap9"), "지도 미동봉에도 경계 영수증 행(경계 실림 시)");
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(!/\(cc9\.live \|\| \[\]\)\.slice\(0, 8\)/.test(ext), "8건 절단 제거(전량 전달)");
  assert.ok(ext.includes("data-candmore"), "웹뷰 더 보기 접힘");
  assert.ok(ext.includes('m.kind === "resolved-blocker"') && ext.includes('CLM.draftEnvelopeRevision(wsM, repoM, { addCandidateIds: [m.id], removeItems: [], approvedHash: genM, target: "archive" })'), "채택 버튼=서고행 revision 초안 실행 표면(재편 B 1차 blocker① — 코어 오유입 봉합)");
  assert.ok(/function draftSummaryDetail[\s\S]{0,1600}pr\.note/.test(ext) && ext.includes("draftSummaryDetail(CLP9, m.repo, prP") && ext.includes("draftSummaryDetail(CLA, tgtA, prA"), "열람·승인 모달 note 노출 — 공용 요약 렌더러 경유(4c UX: 두 모달이 같은 함수로 note+요약+전문)");
  assert.ok(ext.includes("kind: cd.kind"), "candMark에 kind 전달");
});

t("A-5 stale 실행: 승인 세대 변경 → 구세대 pending=자동 declined(사유)+새 세대 재평가 재제안(2차 blocker 반례)", () => {
  const wsS = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-stale-"));
  const rpS = fs.mkdtempSync(path.join(os.tmpdir(), "mem-auth-staler-"));
  const e1 = { schema: "verify-envelope-v1", supportedEnv: ["로컬"], alwaysBlocker: ["기존 규칙"], outOfScope: [] };
  const raw1 = JSON.stringify(e1, null, 1);
  fs.writeFileSync(path.join(rpS, CL.ENVELOPE_FILE), raw1);
  const H1 = crypto.createHash("sha1").update(raw1).digest("hex");
  const ledS = [
    { type: "finding", findingId: "f-ffff0006", campaignId: "cl:st", round: 1, tag: "blocker", titleNorm: "ts", title: "임시 파일을 공유 폴더에 남김", envelopeHash: H1, status: "open", ts: "t" },
    { type: "close", campaignId: "cl:st", findingId: "f-ffff0006", closeReason: "resolved", round: 2, envelopeHash: H1, askId: "ask-st-1", ts: "t" },
  ];
  fs.mkdirSync(path.dirname(CL.findingsLedgerFileFor(wsS)), { recursive: true });
  fs.writeFileSync(CL.findingsLedgerFileFor(wsS), ledS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rp1 = CL.ruleProposeCandidate(wsS, rpS, { findingId: "f-ffff0006", why: "임시 산출물 위치 규율은 파일 하나를 넘는 관통 지침", campaignId: "cl:st", approvedHash: H1 });
  assert.strictEqual(rp1.ok, true, "H1 세대에 rule-manual proposed: " + (rp1.reason || ""));
  // legacy 자동 상신 잔여도 함께 심어 재승인 뒤 두 kind의 운명이 갈리는지 본다(재편 A §2-1·§5-3)
  const legacyS = crypto.createHash("sha1").update("legacy-stale-1").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(wsS, [{ candidateId: legacyS, envelopeHash: H1, status: "proposed", kind: "resolved-blocker", title: "legacy 구세대 자동 상신", ts: "t" }]);
  // 재승인: 무관 항목만 바꿔 새 세대 H2 (검증자 반례 재현)
  const e2 = { ...e1, outOfScope: ["다른 항목"] };
  const raw2 = JSON.stringify(e2, null, 1);
  fs.writeFileSync(path.join(rpS, CL.ENVELOPE_FILE), raw2);
  const H2 = crypto.createHash("sha1").update(raw2).digest("hex");
  CL.reconcileMemoryCandidates(wsS, rpS, H2);
  const { latest } = CL.readEnvelopeCandidates(wsS);
  const cid = [...latest.values()].find((x) => x.status === "proposed" && x.kind === "rule-manual").candidateId;
  assert.strictEqual(latest.get(cid + "@" + H2).status, "proposed", "rule-manual=세대 이월(carry-forward)로 새 세대 유효");
  assert.ok(/이월/.test(latest.get(cid + "@" + H2).note || ""), "이월 사유 기록");
  assert.strictEqual(latest.get(cid + "@" + H2).policyVersion, 2, "이월분도 정책 버전 보존");
  const lgOld = latest.get(legacyS + "@" + H1);
  assert.ok(lgOld && lgOld.status === "declined" && /공급 정책 개정/.test(lgOld.note || ""), "legacy 구세대=정책 개정 declined(재제안 없음)");
  assert.ok(!latest.has(legacyS + "@" + H2), "legacy는 새 세대 재발급 없음(본 스캔 폐지)");
});

t("rule-propose 자격(재검증 blocker① 반례): 인용형 강등 종결(close demoted)도 상신 가능·oosId 없으면 결속 생략", () => {
  const extra2 = [
    { type: "finding", findingId: "f-gggg0007", campaignId: camp, round: 7, tag: "blocker", titleNorm: "t7", title: "범위 밖으로 강등된 지적 문안", envelopeHash: HASH, status: "open", ts: "t" },
    { type: "close", campaignId: camp, findingId: "f-gggg0007", closeReason: "demoted", round: 8, envelopeHash: HASH, ts: "t" },
  ];
  fs.appendFileSync(CL.findingsLedgerFileFor(WS), extra2.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = CL.ruleProposeCandidate(WS, REPO, { findingId: "f-gggg0007", why: "강등돼도 관통 지침 성격이면 상신 가능해야 함", campaignId: camp, approvedHash: HASH });
  assert.strictEqual(r.ok, true, "인용형 강등 종결=자격 인정: " + (r.reason || ""));
  const rec7 = CL.readEnvelopeCandidates(WS).latest.get(r.candidateId + "@" + HASH);
  assert.strictEqual(rec7.kind, "rule-manual");
  assert.ok(!("askId" in rec7) && !("oosId" in rec7), "인용형 close에는 askId·oos 결속 실물이 없음 — 허위 결속 금지");
});

t("CLI 배선: rule-propose 인자 없음=사용법+exit 2(dispatch 실재)", () => {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "rule-propose"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: HOME } });
  assert.strictEqual(r.status, 2, "exit 2: " + (r.stdout || "") + (r.stderr || ""));
  assert.ok(/rule-propose/.test(r.stdout + r.stderr), "usage 출력");
});

console.log(`\n결과: ${n}/${n} 통과`);
