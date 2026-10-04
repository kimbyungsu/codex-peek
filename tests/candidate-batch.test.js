"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-가 · 사용자 결정 2026-10-04] 후보는 제한 없이 쌓이고 전부 보이며, 사용자가 한꺼번에/골라서 올리거나 안 올린다.
 * 사용자 '안 올림'은 수칙서가 바뀌어도 기억(하네스 정리분은 기억 대상 아님) · 사용자가 대화로 다시 요청하면 --again 으로만 재상신.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입 — 실행 반례가 1급).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cbatch-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function pair(tag) {
  const ws = mk("cbatch-ws-" + tag + "-"), repo = mk("cbatch-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo) };
}
// 원문 결속 문맥 — 턴 스냅샷에 실존하는 연속 구절만 상신 가능(constraintAdd 계약)
function turn(P, text, tag) {
  const anchor = CL.turnAnchorOf("sess-" + tag, "2026-10-04T0" + (tag.length % 9) + ":00:00.000Z");
  CL.writeConstraintTurnSnapshot(P.ws, anchor, text);
  return { ok: true, provider: "claude", sessionId: "sess-" + tag, turnAnchor: anchor, sourceHash: sha1(text), repoKey: P.rk };
}
const approveCore = (P, items) => { // 수칙서 승인(코어) — 세대 변경 재현
  const txt = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: items, outOfScope: [] });
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), txt);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(P.ws, sha1(txt)), 2);
  return sha1(txt);
};

console.log("[1] 제한 없이 쌓임");
t("대기 후보 20건이 있어도 새 약속 상신을 접수(대기 12칸 거절 폐지)", () => {
  const P = pair("nocap");
  const pad = [];
  for (let i = 0; i < 20; i++) pad.push({ candidateId: sha1("pad" + i).slice(0, 16), envelopeHash: CL.GEN0_HASH, status: "proposed", kind: "user-direct", repoKey: P.rk, title: "대기 제안 " + i, ts: "T" });
  assert.ok(CL.appendEnvelopeCandidates(P.ws, pad));
  const T1 = "작업이 끝나면 사용자가 쓰던 원래 설정으로 반드시 되돌려 둔다.";
  const r = CL.constraintAdd(P.ws, T1, "모든 작업에 걸치는 기준", "", turn(P, T1, "nocap"));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

console.log("[2] 사용자 거절 기억 — 세대 무관");
t("사용자 '안 올림'(by:user)=수칙서가 바뀌어도 같은 약속 재상신 거부 · --again=사용자 재요청 시만 재상신(reraised) · 재상신 뒤 기억 해제", () => {
  const P = pair("decl");
  const T1 = "화면에 보이는 연결 상태와 실제 연결 상태는 항상 같아야 한다.";
  const c1 = turn(P, T1, "decl1");
  const r1 = CL.constraintAdd(P.ws, T1, "앞으로 계속 지킬 기준", "", c1);
  assert.ok(r1.ok);
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: r1.candidateId, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", note: "dashboard-record", ts: "T" }]));
  const H1 = approveCore(P, ["다른 기준 하나"]); // 세대 변경
  const c2 = turn(P, T1, "decl22");
  const r2 = CL.constraintAdd(P.ws, T1, "앞으로 계속 지킬 기준", "", c2);
  assert.strictEqual(r2.reason, "declined-suppressed", "새 세대에도 사용자 거절 기억 " + JSON.stringify(r2));
  const r3 = CL.constraintAdd(P.ws, T1, "사용자가 다시 올려 달라고 함", "", { ...c2, again: true });
  assert.ok(r3.ok && r3.candidateId === r1.candidateId, "--again=재상신 " + JSON.stringify(r3));
  const rec = CL.readEnvelopeCandidates(P.ws).latest.get(r3.candidateId + "@" + H1);
  assert.ok(rec && rec.status === "proposed" && rec.reraised === true, "재상신 표식");
  assert.strictEqual(CL.userDeclinedCandidate(CL.readEnvelopeCandidates(P.ws).rows, r1.candidateId), false, "재상신 뒤 거절 기억 해제");
});
t("하네스 정리(declined·by 없음)는 기억 대상 아님 — 새 세대엔 다시 상신 가능 / 옛 대시보드 거절(note dashboard-record)은 기억", () => {
  const P = pair("sys");
  const T1 = "배포 전에는 반드시 지금 상태를 백업으로 남겨 둔다.";
  const r1 = CL.constraintAdd(P.ws, T1, "기준", "", turn(P, T1, "sys1"));
  assert.ok(r1.ok);
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: r1.candidateId, envelopeHash: CL.GEN0_HASH, status: "declined", note: "이미 등재된 문안 — 대기열 자동 정리", ts: "T" }]));
  approveCore(P, ["무관한 기준"]);
  const r2 = CL.constraintAdd(P.ws, T1, "기준", "", turn(P, T1, "sys22"));
  assert.strictEqual(r2.ok, true, "하네스 정리는 세대 바뀌면 재상신 가능 " + JSON.stringify(r2));
  const rows = [{ candidateId: "a".repeat(16), status: "declined", note: "dashboard-record" }];
  assert.strictEqual(CL.userDeclinedCandidate(rows, "a".repeat(16)), true, "옛 대시보드 거절=사용자 거절");
  assert.strictEqual(CL.userDeclinedCandidate([{ candidateId: "b".repeat(16), status: "declined" }], "b".repeat(16)), false);
});
t("직접 입력 후보도 같은 규칙(세대 무관 사용자 거절 · --again)", () => {
  const P = pair("direct");
  const d = CL.directRuleCandidate(P.ws, P.repo, { text: "설치 위치와 남은 일을 함께 안내한다" });
  assert.ok(d.ok);
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: d.candidateId, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: "T" }]));
  approveCore(P, ["무관"]);
  assert.strictEqual(CL.directRuleCandidate(P.ws, P.repo, { text: "설치 위치와 남은 일을 함께 안내한다" }).reason, "declined-suppressed");
  assert.strictEqual(CL.directRuleCandidate(P.ws, P.repo, { text: "설치 위치와 남은 일을 함께 안내한다", again: true }).ok, true);
});

t("같은 세대 사용자 거절도 again(사용자 재요청)이면 재상신 — 약속 상신·마감 상신·직접 입력 세 경로(검증 1회차 blocker①)", () => {
  const P = pair("same");
  const T1 = "작업 결과를 보고할 때 남은 일과 설치 위치를 함께 알려 준다.";
  const r1 = CL.constraintAdd(P.ws, T1, "기준", "", turn(P, T1, "same1"));
  assert.ok(r1.ok);
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: r1.candidateId, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: "T" }]);
  const c2 = turn(P, T1, "same22");
  assert.strictEqual(CL.constraintAdd(P.ws, T1, "기준", "", c2).reason, "declined-suppressed", "again 없으면 거부");
  const r2 = CL.constraintAdd(P.ws, T1, "사용자가 다시 요청", "", { ...c2, again: true });
  assert.ok(r2.ok, "같은 세대 again=재상신 " + JSON.stringify(r2));
  assert.strictEqual(CL.readEnvelopeCandidates(P.ws).latest.get(r1.candidateId + "@" + CL.GEN0_HASH).reraised, true);
  const d = CL.directRuleCandidate(P.ws, P.repo, { text: "사용자 설정 파일은 묻지 않고 덮어쓰지 않는다" });
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: d.candidateId, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: "T" }]);
  assert.strictEqual(CL.directRuleCandidate(P.ws, P.repo, { text: "사용자 설정 파일은 묻지 않고 덮어쓰지 않는다" }).reason, "declined-suppressed");
  assert.strictEqual(CL.directRuleCandidate(P.ws, P.repo, { text: "사용자 설정 파일은 묻지 않고 덮어쓰지 않는다", again: true }).ok, true, "직접 입력 같은 세대 again");
  // 마감 상신(rule-propose) — 0세대 해소 blocker 1건으로
  CL.appendFindingsLedger(P.ws, [
    { type: "finding", findingId: "f-0000aa01", campaignId: "c-same", round: 1, tag: "blocker", titleNorm: "새 기준", title: "검증 전 상태를 기록으로 남긴다", envelopeHash: CL.GEN0_HASH, status: "open", ts: "t" },
    { type: "close", campaignId: "c-same", findingId: "f-0000aa01", closeReason: "resolved", round: 2, envelopeHash: CL.GEN0_HASH, askId: "ask-same", ts: "t" },
  ], { repoKey: P.rk });
  const rp = CL.ruleProposeCandidate(P.ws, P.repo, { findingId: "f-0000aa01", why: "모든 작업에 걸치는 기준이라서", campaignId: "c-same" });
  assert.ok(rp.ok, JSON.stringify(rp));
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: rp.candidateId, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: "T" }]);
  assert.strictEqual(CL.ruleProposeCandidate(P.ws, P.repo, { findingId: "f-0000aa01", why: "모든 작업에 걸치는 기준이라서", campaignId: "c-same" }).reason, "declined-suppressed");
  const rp2 = CL.ruleProposeCandidate(P.ws, P.repo, { findingId: "f-0000aa01", why: "모든 작업에 걸치는 기준이라서", campaignId: "c-same", again: true });
  assert.ok(rp2.ok && CL.readEnvelopeCandidates(P.ws).latest.get(rp.candidateId + "@" + CL.GEN0_HASH).reraised === true, "마감 상신 같은 세대 again " + JSON.stringify(rp2));
});
t("세대 이월이 사용자 거절 후보를 되살리지 않고 거절 기억도 풀지 않는다 — H1 대기 → H2 이월 → H2 안 올림 → H3 조정(검증 1회차 blocker②)", () => {
  const P = pair("carry");
  const H1 = approveCore(P, ["처음 기준"]);
  const d = CL.directRuleCandidate(P.ws, P.repo, { text: "버튼을 누르면 결과가 올 때까지 끝까지 응답한다" });
  assert.ok(d.ok);
  const H2 = approveCore(P, ["처음 기준", "둘째 기준"]);
  CL.reconcileMemoryCandidates(P.ws, P.repo, H2);
  assert.strictEqual(CL.readEnvelopeCandidates(P.ws).latest.get(d.candidateId + "@" + H2).status, "proposed", "전제: H2 로 이월");
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: d.candidateId, envelopeHash: H2, status: "declined", by: "user", note: "dashboard-record", ts: "T" }]);
  const H3 = approveCore(P, ["처음 기준", "둘째 기준", "셋째 기준"]);
  CL.reconcileMemoryCandidates(P.ws, P.repo, H3);
  const st = CL.readEnvelopeCandidates(P.ws);
  assert.ok(!st.latest.get(d.candidateId + "@" + H3), "H3 재생성 없음(옛 H1 대기 행이 되살리지 않음)");
  assert.strictEqual(CL.userDeclinedCandidate(st.rows, d.candidateId), true, "거절 기억 유지");
  // 자동 이월 행(reraised 없음)은 기억을 풀지 않는다 — 순수 함수 반례
  const id = "c".repeat(16);
  assert.strictEqual(CL.userDeclinedCandidate([{ candidateId: id, status: "declined", by: "user" }, { candidateId: id, status: "proposed", note: "승인 세대 이월" }], id), true);
  assert.strictEqual(CL.userDeclinedCandidate([{ candidateId: id, status: "declined", by: "user" }, { candidateId: id, status: "proposed", reraised: true }], id), false);
  void H1;
});

t("예전 수칙서로 되돌려 승인해도 거절한 후보는 목록·초안·재상신 어디서도 살아나지 않는다(again 만 예외) — H1 대기 → H2 이월·안 올림 → H1 바이트 재승인(검증 2회차)", () => {
  const CB = require("../bridge/codex-bridge.js");
  const P = pair("revert");
  const H1 = approveCore(P, ["처음 기준"]);
  const X = "버튼을 누른 뒤에는 결과가 올 때까지 화면이 멈추지 않는다";
  const d = CL.directRuleCandidate(P.ws, P.repo, { text: X });
  assert.ok(d.ok);
  const H2 = approveCore(P, ["처음 기준", "둘째 기준"]);
  CL.reconcileMemoryCandidates(P.ws, P.repo, H2);
  CL.appendEnvelopeCandidates(P.ws, [{ candidateId: d.candidateId, envelopeHash: H2, status: "declined", by: "user", note: "dashboard-record", ts: "T" }]);
  assert.strictEqual(approveCore(P, ["처음 기준"]), H1, "전제: 예전 바이트=같은 지문");
  CL.reconcileMemoryCandidates(P.ws, P.repo, H1);
  assert.strictEqual(CL.readEnvelopeCandidates(P.ws).latest.get(d.candidateId + "@" + H1).status, "proposed", "전제: 옛 H1 대기 행이 현재 세대 행으로 되살아남");
  const live = CB.computeEnvelopeCandidatesFor(P.ws, { gen: H1 }).live;
  assert.ok(!live.some((c) => c.candidateId === d.candidateId), "목록 제외");
  const dr = CL.draftEnvelopeRevision(P.ws, P.repo, { approvedHash: H1, target: "archive", addCandidateIds: [d.candidateId], removeItems: [] });
  assert.ok(!dr.ok && /안 올린/.test(dr.error), "초안 자격 없음 " + JSON.stringify(dr));
  assert.strictEqual(CL.directRuleCandidate(P.ws, P.repo, { text: X }).reason, "declined-suppressed", "재상신 거부(중복 아닌 거절로)");
  const again = CL.directRuleCandidate(P.ws, P.repo, { text: X, again: true });
  assert.ok(again.ok, "사용자 재요청=재상신 " + JSON.stringify(again));
  assert.ok(CB.computeEnvelopeCandidatesFor(P.ws, { gen: H1 }).live.some((c) => c.candidateId === d.candidateId), "재요청 뒤 목록 복귀");
  assert.ok(CL.draftEnvelopeRevision(P.ws, P.repo, { approvedHash: H1, target: "archive", addCandidateIds: [d.candidateId], removeItems: [] }).ok, "재요청 뒤 초안 가능");
});

console.log("[3] 한꺼번에 올리기 계획(순수 함수)");
const L = [
  { candidateId: "1".repeat(16), kind: "user-constraint" },
  { candidateId: "2".repeat(16), kind: "rule-manual" },
  { candidateId: "3".repeat(16), kind: "curator", operation: "add" },
  { candidateId: "4".repeat(16), kind: "curator", operation: "oos-add" },
  { candidateId: "5".repeat(16), kind: "curator", operation: "remove" },
  { candidateId: "6".repeat(16), kind: "oos-repeat" },
];
const ALL = L.map((c) => c.candidateId).concat(["9".repeat(16), "zz"]);
t("승인 세대=관련될 때(서고) 한 초안 — 서고행 정리 제안 포함·다른 칸/빼기/참고 신호/지금 없는 id 는 제외", () => {
  const p = CL.candidateBatchPlan({ live: L, ids: ALL, gen0: false, dest: "core" });
  assert.strictEqual(p.mode, "archive");
  assert.deepStrictEqual(p.take, ["1".repeat(16), "2".repeat(16), "3".repeat(16)]);
  const why = Object.fromEntries(p.excluded.map((x) => [x.id, x.why]));
  assert.deepStrictEqual(why, { ["4".repeat(16)]: "curator-other-dest", ["5".repeat(16)]: "curator-remove", ["6".repeat(16)]: "not-draftable", ["9".repeat(16)]: "not-current" });
  assert.ok(!p.take.includes("zz") && !p.excluded.some((x) => x.id === "zz"), "형식 밖 id 는 조용히 버림(화면 입력 방어)");
});
t("0세대 — 항상(core)=첫 초안 결속(제외 칸 추가 포함) / 관련될 때=빈 첫 수칙서 뒤 서고(서고 추가 포함) / 빈 선택=none", () => {
  const pc = CL.candidateBatchPlan({ live: L, ids: ALL, gen0: true, dest: "core" });
  assert.ok(pc.mode === "core-initial" && pc.take.join() === ["1".repeat(16), "2".repeat(16), "4".repeat(16)].join(), JSON.stringify(pc));
  const pa = CL.candidateBatchPlan({ live: L, ids: ALL, gen0: true, dest: "archive" });
  assert.ok(pa.mode === "empty-then-archive" && pa.take.join() === ["1".repeat(16), "2".repeat(16), "3".repeat(16)].join(), JSON.stringify(pa));
  assert.strictEqual(CL.candidateBatchPlan({ live: L, ids: [], gen0: true, dest: "core" }).mode, "none");
  assert.strictEqual(CL.candidateBatchPlan({ live: L, ids: ["5".repeat(16)], gen0: false }).mode, "none", "빼기 정리 제안만=묶음 대상 없음");
});

console.log("[4] 실제 묶음 승인 — 초안 1개·승인 1번");
t("승인 세대: 후보 3건을 한 초안으로 서고에 올리고 한 번 도장 → 3건 모두 적용(applied)", () => {
  const P = pair("arc");
  const H = approveCore(P, ["기존 기준"]);
  const ids = [];
  for (const x of ["첫째 기준을 지킨다고 약속한다", "둘째 기준을 지킨다고 약속한다", "셋째 기준을 지킨다고 약속한다"]) { const d = CL.directRuleCandidate(P.ws, P.repo, { text: x }); assert.ok(d.ok, JSON.stringify(d)); ids.push(d.candidateId); }
  const plan = CL.candidateBatchPlan({ live: ids.map((id) => ({ candidateId: id, kind: "user-direct" })), ids, gen0: false });
  const dr = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: plan.take, removeItems: [], approvedHash: H, target: "archive" });
  assert.ok(dr.ok && dr.adds === 3, JSON.stringify(dr));
  const tr = CL.applyEnvelopeTransition(P.ws, P.repo, "ko", null);
  assert.ok(tr.ok, JSON.stringify(tr));
  const ar = CL.readVerifyEnvelopeArchive(P.repo);
  assert.strictEqual(ar.data.alwaysBlocker.length, 3);
  const lat = CL.readEnvelopeCandidates(P.ws).latest;
  for (const id of ids) assert.strictEqual(lat.get(id + "@" + H).applied, tr.newHash, "applied " + id);
});
t("0세대 항상: 후보 2건으로 첫 수칙서(코어 2항) 한 번에 · 관련될 때: 빈 첫 수칙서 → 서고 2건 두 번째 승인", () => {
  const P = pair("g0c");
  const a = CL.directRuleCandidate(P.ws, P.repo, { text: "사용자 원래 설정을 작업 뒤 되돌린다" }), b = CL.directRuleCandidate(P.ws, P.repo, { text: "화면과 실제 연결 상태를 일치시킨다" });
  assert.ok(a.ok && b.ok);
  const dc = CL.draftEnvelopeInitial(P.ws, P.repo, { addCandidateIds: [a.candidateId, b.candidateId] });
  assert.ok(dc.ok && dc.adds === 2, JSON.stringify(dc));
  assert.ok(CL.applyEnvelopeTransition(P.ws, P.repo, "ko", null).ok);
  assert.strictEqual(CL.readVerifyEnvelope(P.repo).data.alwaysBlocker.length, 2);
  const Q = pair("g0a");
  const c = CL.directRuleCandidate(Q.ws, Q.repo, { text: "사용자 원래 설정을 작업 뒤 되돌린다" }), d = CL.directRuleCandidate(Q.ws, Q.repo, { text: "화면과 실제 연결 상태를 일치시킨다" });
  assert.ok(CL.draftEnvelopeInitial(Q.ws, Q.repo, { allowEmpty: true }).ok);
  assert.ok(CL.applyEnvelopeTransition(Q.ws, Q.repo, "ko", null).ok);
  const d2 = CL.draftEnvelopeRevision(Q.ws, Q.repo, { addCandidateIds: [c.candidateId, d.candidateId], removeItems: [], approvedHash: CL.GEN0_HASH, target: "archive" });
  assert.ok(d2.ok && d2.adds === 2, JSON.stringify(d2));
  assert.ok(CL.applyEnvelopeTransition(Q.ws, Q.repo, "ko", null).ok);
  assert.strictEqual(CL.readVerifyEnvelopeArchive(Q.repo).data.alwaysBlocker.length, 2);
});

console.log("[5] 배선 핀(화면·처리기·명령줄)");
t("대시보드: 고르기 칸·전체 선택·선택 올리기(0세대 두 칸)·선택 안 올림 → candBatch / 처리기=실후보 재대조·계획 함수·사용자 거절 표식", () => {
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(ext.includes('setAttribute("data-cand-ck", cd.id)') && ext.includes('type:"candBatch"') && ext.includes('send9("adopt","archive")') && ext.includes('send9("adopt","core")') && ext.includes('send9("decline","")'), "화면");
  assert.ok(ext.includes('m?.type === "candBatch"') && ext.includes("CLB.candidateBatchPlan(") && ext.includes('status: "declined", by: "user", note: "dashboard-batch"'), "처리기");
  assert.ok(/status: m\.status, \.\.\.\(m\.status === "declined" \? \{ by: "user" \} : \{\}\)/.test(ext), "단건 안 올림도 사용자 표식");
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes('rest.includes("--again")') && cb.includes('...(status === "declined" ? { by: "user" } : {})'), "명령줄 --again·mark 사용자 표식");
});

console.log(`\n결과: ${n}/${n} 통과`);
