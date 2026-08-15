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

// ── A-3 조정 스캔 ────────────────────────────────────────────────────────────
t("조정 스캔: 신행 blocker 해소 계보만 후보화(비blocker·기등재 제외)+legacy-unbound 기록", () => {
  const r = CL.reconcileMemoryCandidates(WS, REPO, HASH);
  assert.strictEqual(r.appended, 1, "신행 1건만 append");
  assert.strictEqual(r.legacyUnbound, 1, "구행(title/askId 부재) 제외 기록");
  assert.ok(r.suppressed.some((s) => s.why === "already-in-envelope"), "ab축 정확 일치 억제");
  const { latest } = CL.readEnvelopeCandidates(WS);
  const rows = [...latest.values()].filter((x) => x.status === "proposed");
  assert.strictEqual(rows.length, 1);
  assert.ok(/^[0-9a-f]{16}$/.test(rows[0].candidateId), "16hex 계약(기존 판독기 호환)");
  assert.strictEqual(rows[0].title, "결제 실패 시 카드번호가 평문 로그에 남음", "문안=지적 원문(자동 작문 금지)");
  assert.strictEqual(rows[0].askId, "ask-test-1", "마감 askId 결속");
});
t("조정 스캔 멱등: 재실행(중단 복구 트리거 동형)이 중복 후보를 만들지 않음", () => {
  const r2 = CL.reconcileMemoryCandidates(WS, REPO, HASH);
  assert.strictEqual(r2.appended, 0);
  const { rows } = CL.readEnvelopeCandidates(WS);
  assert.strictEqual(rows.filter((x) => x.status === "proposed").length, 1, "append-only 원장에도 proposed 1건뿐");
});
t("조정 스캔: Envelope 비활성(지문 없음)=무공급(A-6 경계)", () => {
  const r3 = CL.reconcileMemoryCandidates(WS, REPO, null);
  assert.strictEqual(r3.appended + r3.scanned, 0);
});
t("조정 스캔: pending 상한 초과=신규 억제+사유 기록(승인 남발 방지 §5-9)", () => {
  const many = [];
  for (let i = 0; i < CL.MEMORY_CANDIDATE_PENDING_MAX; i++) many.push({ candidateId: crypto.createHash("sha1").update("pad" + i).digest("hex").slice(0, 16), envelopeHash: HASH, status: "proposed", ts: "t" });
  CL.appendEnvelopeCandidates(WS, many);
  const extra = [
    { type: "finding", findingId: "f-eeee0005", campaignId: camp, round: 5, tag: "blocker", titleNorm: "t5", title: "새 위험 사례", envelopeHash: HASH, status: "open", ts: "t" },
    { type: "close", campaignId: camp, findingId: "f-eeee0005", closeReason: "resolved", round: 6, envelopeHash: HASH, askId: "ask-test-3", ts: "t" },
  ];
  fs.appendFileSync(CL.findingsLedgerFileFor(WS), extra.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r4 = CL.reconcileMemoryCandidates(WS, REPO, HASH);
  assert.strictEqual(r4.appended, 0);
  assert.ok(r4.suppressed.some((s) => s.why === "pending-cap"), "억제 사유 반환(침묵 누락 금지)");
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
  const rc = CL.reconcileMemoryCandidates(ws3, rp3, h3);
  assert.strictEqual(rc.appended, 1);
  const cid3 = [...CL.readEnvelopeCandidates(ws3).latest.values()].find((x) => x.status === "proposed").candidateId;
  const dr = CL.draftEnvelopeCandidate(ws3, rp3, cid3, h3);
  assert.ok(dr.ok, "draft 성공: " + (dr.error || ""));
  const pr = CL.readEnvelopeProposal(ws3, rp3);
  const merged = JSON.parse(pr.proposalText).alwaysBlocker;
  const last = merged[merged.length - 1];
  assert.ok(last.endsWith("…[절단]"), "절단 표식 보존");
  assert.ok(last.length <= 200, "상한 준수(표식 포함)");
});
t("B4 실행: 계산기에 resolved-blocker 후보 합류(장부→화면 경로)+기등재 억제=자동 declined 기록", () => {
  CL.updateContractPatch(WS, undefined, { envelopeHash: HASH });
  // 계산기 세대=마지막 ask 동결(readFrozenEnvelope) — 시험도 실경로로 동결을 만든다(WS 자체가 정찰 대상·수칙서는 아래 B1 시험과 공유)
  fs.writeFileSync(path.join(WS, CL.ENVELOPE_FILE), envRaw);
  const frozen = CL.freezeEnvelopeForAsk(WS, WS, "ko");
  assert.strictEqual(frozen, HASH, "동결=승인 세대");
  const cc = CB.computeEnvelopeCandidatesFor(WS);
  const rb = (cc.live || []).filter((c) => c.kind === "resolved-blocker");
  assert.ok(rb.length >= 1, "resolved-blocker 후보가 live 목록에 합류");
  assert.ok(rb.some((c) => c.titles && c.titles[0] && c.titles[0].includes("카드번호")), "문안=지적 원문");
  const { latest } = CL.readEnvelopeCandidates(WS);
  const dec = [...latest.values()].filter((x) => x.status === "declined" && x.kind === "resolved-blocker");
  assert.ok(dec.length >= 1 && /등재/.test(dec[0].note || ""), "자동 declined+사유 기록");
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
  assert.ok(ext.includes('m.kind === "resolved-blocker"') && ext.includes("CLM.draftEnvelopeCandidate"), "채택 버튼=draft 실행 표면");
  assert.ok((ext.match(/prP\.note|prA\.note/g) || []).length >= 2, "열람·승인 모달 note 노출");
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
  const r1 = CL.reconcileMemoryCandidates(wsS, rpS, H1);
  assert.strictEqual(r1.appended, 1, "H1 세대에 proposed");
  // 재승인: 무관 항목만 바꿔 새 세대 H2 (검증자 반례 재현)
  const e2 = { ...e1, outOfScope: ["다른 항목"] };
  const raw2 = JSON.stringify(e2, null, 1);
  fs.writeFileSync(path.join(rpS, CL.ENVELOPE_FILE), raw2);
  const H2 = crypto.createHash("sha1").update(raw2).digest("hex");
  const r2 = CL.reconcileMemoryCandidates(wsS, rpS, H2);
  assert.strictEqual(r2.appended, 1, "새 세대 재평가=재제안");
  const { latest } = CL.readEnvelopeCandidates(wsS);
  const cid = [...latest.values()].find((x) => x.status === "proposed").candidateId;
  const old = latest.get(cid + "@" + H1);
  assert.strictEqual(old.status, "declined", "구세대 pending=자동 declined(stale 정리)");
  assert.ok(/세대 변경/.test(old.note || ""), "정리 사유 기록");
  assert.strictEqual(latest.get(cid + "@" + H2).status, "proposed", "새 세대 pending 유효");
});

console.log(`\n결과: ${n}/${n} 통과`);
