"use strict";
/*
 * [Envelope Selector v6 §1·§6] 구현 1단계 — 서고 판독기·target 차원(제안본·WAL·전이·도장 이중 결속) 실행 시험.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입·모킹 없음). 핵심 반례=교차 무접촉(archive 전이가 코어를 안 건드림)·
 * legacy(target 부재)=core 동작·복구 target 승계·targetBaseHash drift·candidateGeneration 복원.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-ws-"));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-repo-"));

// 픽스처: 코어 수칙서(승인 상태)
const coreObj = { schema: "verify-envelope-v1", supportedEnv: ["윈도우 로컬 단일 사용자"], alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"], outOfScope: ["다중 서버 동시 배포"] };
const coreRaw = JSON.stringify(coreObj, null, 1);
fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), coreRaw);
const CORE_HASH = sha1(coreRaw);
assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, CORE_HASH), 2);

const arcObj = { schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "고객 차단 기록은 지우지 않는다"] };
const arcText = JSON.stringify(arcObj, null, 1);

t("서고 판독기: 부재=absent·정상=ok(sha1·ab축)·미지 필드/타 축/상한 위반=corrupt(절삭 관용 없음)", () => {
  assert.strictEqual(CL.readVerifyEnvelopeArchive(REPO).st, "absent", "미도입=absent");
  fs.writeFileSync(path.join(REPO, CL.ARCHIVE_FILE), arcText);
  const r = CL.readVerifyEnvelopeArchive(REPO);
  assert.ok(r.st === "ok" && r.data.alwaysBlocker.length === 2 && r.sha1 === sha1(arcText));
  assert.strictEqual(CL.validEnvelopeArchiveInner({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["a".repeat(201)] }), false, "항목 200자 초과=거부");
  assert.strictEqual(CL.validEnvelopeArchiveInner({ schema: "verify-envelope-archive-v1", alwaysBlocker: Array.from({ length: CL.ARCHIVE_ITEM_MAX + 1 }, (_, i) => "항목 " + i) }), false, "96항 초과=거부");
  assert.strictEqual(CL.validEnvelopeArchiveInner({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["ok"], supportedEnv: ["침입 축"] }), false, "타 축(미지 필드)=거부 — v1 서고는 ab 전용");
  assert.strictEqual(CL.validEnvelopeArchiveInner({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["ok"], alwaysBlockerEn: ["ok", "extra"] }), false, "병렬 축 길이 불일치=거부");
});

t("archive 제안본: target·이중 결속(targetBaseHash=서고 지문·candidateGeneration=core 세대) 기록·판독", () => {
  const w = CL.writeEnvelopeProposal(WS, REPO, arcText, "서고 초안", { target: "archive" });
  assert.strictEqual(w.ok, true, "archive 제안 저장: " + (w.error || ""));
  const pr = CL.readEnvelopeProposal(WS, REPO);
  assert.strictEqual(pr.st, "ok");
  assert.strictEqual(pr.target, "archive");
  assert.strictEqual(pr.targetBaseHash, sha1(arcText), "targetBaseHash=대상(서고) 파일 현행 지문");
  assert.strictEqual(pr.candidateGeneration, CORE_HASH, "★candidateGeneration=core 승인 세대(후보 복원 축 — 2차 blocker① 이중 결속)");
});

t("archive 제안에 core 스키마 전문=거부·core 제안(레거시 meta 없음)=종전 동작", () => {
  CL.discardEnvelopeProposal(WS);
  const bad = CL.writeEnvelopeProposal(WS, REPO, coreRaw, "잘못된 대상", { target: "archive" });
  assert.strictEqual(bad.ok, false, "대상별 strict 판독기 분기(서고에 코어 전문=거부)");
  const wc = CL.writeEnvelopeProposal(WS, REPO, coreRaw, "코어 초안", {});
  assert.strictEqual(wc.ok, true);
  const prc = CL.readEnvelopeProposal(WS, REPO);
  assert.ok(prc.target === "core" && prc.targetBaseHash === CORE_HASH, "core 기본 대상·targetBaseHash=코어 지문");
  CL.discardEnvelopeProposal(WS);
});

t("★archive 전이=코어 무접촉(교차 반례): 서고 교체+archiveHash 기록·envelopeHash·코어 파일 그대로", () => {
  const arc2Obj = { schema: "verify-envelope-archive-v1", alwaysBlocker: [...arcObj.alwaysBlocker, "복구 시험은 매주 돌린다"] };
  const arc2 = JSON.stringify(arc2Obj, null, 1);
  assert.strictEqual(CL.writeEnvelopeProposal(WS, REPO, arc2, "서고 개정", { target: "archive" }).ok, true);
  const r = CL.applyEnvelopeTransition(WS, REPO, "ko", null);
  assert.strictEqual(r.ok, true, "archive 전이 성공: " + (r.reason || ""));
  assert.strictEqual(fs.readFileSync(path.join(REPO, CL.ARCHIVE_FILE), "utf8"), arc2, "서고 파일 교체");
  assert.strictEqual(fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8"), coreRaw, "★코어 파일 무접촉");
  const cKo = CL.loadContract(WS, "ko"), cEn = CL.loadContract(WS, "en");
  assert.ok(cKo.archiveHash === sha1(arc2) && cEn.archiveHash === sha1(arc2), "archiveHash 양 슬롯 기록(언어 공유 계보)");
  assert.ok(cKo.envelopeHash === CORE_HASH && cEn.envelopeHash === CORE_HASH, "★envelopeHash 무접촉(교차 덮침 차단)");
  assert.strictEqual(CL.readEnvelopeProposal(WS, REPO).st, "absent", "소비한 제안본 폐기(소유 결속 유지)");
});

t("targetBaseHash drift: 초안 생성 후 서고가 직접 편집되면 전이 거부(base-drift·WAL 미구성)", () => {
  const arc3 = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["새 판 항목"] }, null, 1);
  assert.strictEqual(CL.writeEnvelopeProposal(WS, REPO, arc3, "d", { target: "archive" }).ok, true);
  fs.appendFileSync(path.join(REPO, CL.ARCHIVE_FILE), " "); // 제3 편집(지문 변경)
  const r = CL.applyEnvelopeTransition(WS, REPO, "ko", null);
  assert.strictEqual(r.reason, "base-drift", "대상 파일 drift=거부(targetBaseHash 검사 — 이중 결속의 대상 축)");
  assert.strictEqual(CL.envelopeTransState(WS), "clear", "WAL 미구성(아무것도 안 바꾼 거부)");
  CL.discardEnvelopeProposal(WS);
  // 서고 복원(뒤 시험 전제)
  const cur = fs.readFileSync(path.join(REPO, CL.ARCHIVE_FILE), "utf8").trimEnd();
  fs.writeFileSync(path.join(REPO, CL.ARCHIVE_FILE), cur);
});

t("archive WAL 부분 슬롯 실패=WAL 보존·복구가 target 승계(서고 행 그대로·코어 무접촉)", () => {
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-ws2-"));
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WS2, CORE_HASH), 2);
  const arcNow = fs.readFileSync(path.join(REPO, CL.ARCHIVE_FILE), "utf8");
  const arc4 = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["부분 실패 반례 항목"] }, null, 1);
  const walFile = CL.envelopeTransWalFileFor(WS2);
  fs.mkdirSync(path.dirname(walFile), { recursive: true });
  fs.writeFileSync(walFile, JSON.stringify({ schema: "env-trans-wal-v1", target: "archive", ws: WS2, repo: REPO, lang: "ko", oldText: arcNow, oldHash: sha1(arcNow), newText: arc4, newHash: sha1(arc4), ts: "T" }));
  fs.rmSync(CL.contractFileFor(WS2, "en"), { force: true });
  fs.mkdirSync(CL.contractFileFor(WS2, "en"), { recursive: true }); // en 슬롯 쓰기 장애 주입
  const r1 = CL.recoverEnvelopeTransition(WS2);
  assert.strictEqual(r1.reason, "contract-write-partial", "부분 실패=완료 금지(대상 무관 상속)");
  assert.ok(fs.existsSync(walFile), "WAL 보존");
  fs.rmdirSync(CL.contractFileFor(WS2, "en"));
  const r2 = CL.recoverEnvelopeTransition(WS2);
  assert.strictEqual(r2.st, "recovered", "★복구가 WAL의 target(archive)을 승계해 수렴");
  assert.strictEqual((CL.loadContract(WS2, "en") || {}).archiveHash, sha1(arc4), "en 슬롯 archiveHash 수렴");
  assert.strictEqual((CL.loadContract(WS2, "ko") || {}).envelopeHash, CORE_HASH, "코어 지문 무접촉");
  fs.writeFileSync(path.join(REPO, CL.ARCHIVE_FILE), arcNow); // 서고 원복(다른 시험 영향 차단)
});

t("archive 재도장(stampEnvelopeAllSlots target=archive): 파일 무변·archiveHash만 갱신·core 도장은 종전 시그니처", () => {
  const arcNow = fs.readFileSync(path.join(REPO, CL.ARCHIVE_FILE), "utf8");
  const rs = CL.stampEnvelopeAllSlots(WS, REPO, sha1(arcNow), "archive");
  assert.strictEqual(rs.ok, true, "서고 재도장 성공: " + (rs.reason || ""));
  assert.strictEqual((CL.loadContract(WS, "en") || {}).archiveHash, sha1(arcNow));
  assert.strictEqual(fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8"), coreRaw, "코어 무접촉");
  const rc = CL.stampEnvelopeAllSlots(WS, REPO, CORE_HASH); // target 생략=core(기존 호출부 무회귀)
  assert.strictEqual(rc.ok, true, "core 도장 기존 시그니처 동작");
});

t("도장 strict 검증(f-d9c9930d 반례): 96항 초과·손상 서고는 실제 sha로도 도장 거부", () => {
  const REPO9 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-repo9-"));
  fs.writeFileSync(path.join(REPO9, CL.ENVELOPE_FILE), coreRaw);
  const over = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: Array.from({ length: CL.ARCHIVE_ITEM_MAX + 1 }, (_, i) => "항목 " + i) }, null, 1);
  fs.writeFileSync(path.join(REPO9, CL.ARCHIVE_FILE), over);
  const r1 = CL.stampEnvelopeAllSlots(WS, REPO9, sha1(over), "archive");
  assert.strictEqual(r1.reason, "target-corrupt", "★97항 전문=sha 일치여도 도장 거부(도장 대상 아닌 전문에 지문 금지)");
  fs.writeFileSync(path.join(REPO9, CL.ARCHIVE_FILE), "{broken json");
  const r2 = CL.stampEnvelopeAllSlots(WS, REPO9, sha1("{broken json"), "archive");
  assert.strictEqual(r2.reason, "target-corrupt", "손상 JSON=도장 거부");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(src.includes("if (!tgtS.validInner(inner9)) return { ok: false, reason: \"target-corrupt\" };"), "도장 전 대상별 strict 검증(소스 계약)");
});
t("archive 초안 폐기=candidateGeneration(core 세대)으로 후보 복원(2차 blocker① 정방향)", () => {
  const cid = crypto.createHash("sha1").update("arc-cand").digest("hex").slice(0, 16);
  CL.appendEnvelopeCandidates(WS, [
    { candidateId: cid, envelopeHash: CORE_HASH, status: "proposed", kind: "user-constraint", repoKey: CL.repoKeyOf(REPO), title: "서고행 약속 후보", ts: "T" },
    { candidateId: cid, envelopeHash: CORE_HASH, status: "adopted", ts: "T2" },
  ]);
  const arcNow = fs.readFileSync(path.join(REPO, CL.ARCHIVE_FILE), "utf8");
  const arc5 = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: [...JSON.parse(arcNow).alwaysBlocker, "서고행 약속 후보"] }, null, 1);
  assert.strictEqual(CL.writeEnvelopeProposal(WS, REPO, arc5, "채택 초안", { target: "archive", candidateIds: [cid] }).ok, true);
  const rD = CL.discardEnvelopeProposalRestoring(WS);
  assert.ok(rD.ok && rD.restored, "★archive 초안 폐기가 core 세대 축(candidateGeneration)에서 채택 후보를 proposed로 복원 — baseHash(서고 지문)로 조회했다면 실패했을 반례");
  assert.strictEqual(CL.readEnvelopeCandidates(WS).latest.get(cid + "@" + CORE_HASH).status, "proposed");
});

t("legacy 호환: target·이중 결속 필드 없는 구형 제안본/WAL=core 의미 그대로(무회귀 소스+실행)", () => {
  const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-ws3-"));
  const REPO3 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-repo3-"));
  fs.writeFileSync(path.join(REPO3, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WS3, CORE_HASH), 2);
  const core2Obj = { ...coreObj, outOfScope: [...coreObj.outOfScope, "레거시 개정 항목"] };
  const core2 = JSON.stringify(core2Obj, null, 1);
  // 구형 제안본(수동 조립 — target/targetBaseHash/candidateGeneration 부재·baseHash만)
  fs.mkdirSync(CL.ENVELOPE_PROPOSED_DIR, { recursive: true });
  fs.writeFileSync(CL.envelopeProposedFileFor(WS3), JSON.stringify({ schema: "env-proposal-v1", repo: String(REPO3), proposalText: core2, newHash: sha1(core2), baseHash: CORE_HASH, ts: "T" }, null, 1));
  const pr = CL.readEnvelopeProposal(WS3, REPO3);
  assert.ok(pr.st === "ok" && pr.target === "core" && pr.targetBaseHash === CORE_HASH && pr.candidateGeneration === CORE_HASH, "legacy 제안본=core·baseHash 겸용 해석");
  const r = CL.applyEnvelopeTransition(WS3, REPO3, "ko", null);
  assert.strictEqual(r.ok, true, "legacy 제안본 전이 무회귀");
  assert.strictEqual((CL.loadContract(WS3, "ko") || {}).envelopeHash, sha1(core2), "envelopeHash 갱신(core 행)");
  assert.strictEqual((CL.loadContract(WS3, "ko") || {}).archiveHash, null, "archiveHash 무접촉(null 유지)");
});

t("v7 §2 manifest·boundaryGen: 결정성·freeze 왕복·legacy 동결=null(strict 판독)", () => {
  const mf = CL.buildAbManifest(["규칙 하나", "규칙 둘"], ["서고 규칙"]);
  assert.deepStrictEqual(mf.map((r) => [r.n, r.source]), [[1, "core"], [2, "core"], [3, "archive"]], "합본 번호=코어 다음 서고 연속");
  assert.ok(mf.every((r) => /^[0-9a-f]{16}$/.test(r.textFp)), "textFp=문안 지문(과거 판 복원 재료)");
  const bg = CL.boundaryGenOf(CORE_HASH, "", mf);
  assert.strictEqual(bg, CL.boundaryGenOf(CORE_HASH, "", mf), "결정성");
  assert.notStrictEqual(bg, CL.boundaryGenOf(CORE_HASH, "", mf.slice(0, 2)), "manifest 다르면 다른 경계");
  const WSF = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-fz-"));
  assert.ok(CL.writeEnvelopeFreeze(WSF, CORE_HASH, "ask-x", { manifest: mf, boundaryGen: bg, appliedArchiveHash: "" }));
  const rec = CL.readFrozenEnvelopeRec(WSF);
  assert.ok(rec.boundaryGen === bg && Array.isArray(rec.manifest) && rec.manifest.length === 3 && rec.appliedArchiveHash === "", "동결 왕복");
  assert.ok(CL.writeEnvelopeFreeze(WSF, CORE_HASH, "ask-y")); // legacy 동결(extra 없음)
  const rec2 = CL.readFrozenEnvelopeRec(WSF);
  assert.ok(rec2.manifest === null && rec2.boundaryGen === null, "legacy=null(코어만 시절 — confirm은 envelopeHash 폴백)");
  assert.ok(CL.writeEnvelopeFreeze(WSF, CORE_HASH, "ask-z", { manifest: [{ n: 1, source: "bad-src", textFp: "zz" }], boundaryGen: bg }));
  assert.strictEqual(CL.readFrozenEnvelopeRec(WSF).boundaryGen, null, "손상 manifest=legacy 취급(strict — fail-closed 방향)");
});
t("v7 §2 deriveRoundType: 같은 경계 통과=confirm·다른 선별판/legacy 행=confirm 불가·legacy 판=기존 동작", () => {
  const WSB = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-bg-"));
  const CAMP = "cl:bg-test";
  const G1 = "1".repeat(40), G2 = "2".repeat(40);
  CL.appendFindingsLedger(WSB, [{ type: "round", campaignId: CAMP, round: 1, roundType: "discovery", verdict: "pass", envelopeHash: CORE_HASH, boundaryGen: G1, ts: "T" }]);
  assert.strictEqual(CL.deriveRoundType(WSB, CAMP, CORE_HASH, G1), "confirm", "같은 경계의 통과=confirm");
  assert.strictEqual(CL.deriveRoundType(WSB, CAMP, CORE_HASH, G2), "fix-verify", "★다른 선별판의 통과=confirm 불가(A판 통과가 B판 신규 blocker를 confirm-scope로 강등하는 경로 차단)");
  assert.strictEqual(CL.deriveRoundType(WSB, CAMP, CORE_HASH), "fix-verify", "★현재 판이 legacy인데 직전 통과가 활성 manifest 판=confirm 불가(대칭 한정 — 손상·legacy freeze가 활성 통과를 재사용하는 경로 차단)");
  const WSC = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-bg2-"));
  CL.appendFindingsLedger(WSC, [{ type: "round", campaignId: CAMP, round: 1, roundType: "discovery", verdict: "pass", envelopeHash: CORE_HASH, ts: "T" }]); // legacy 행(경계 없음)
  assert.strictEqual(CL.deriveRoundType(WSC, CAMP, CORE_HASH, G1), "fix-verify", "★활성 manifest 판에서 legacy 통과 행=confirm 재료 불가(4차 blocker① 정방향)");
  assert.strictEqual(CL.deriveRoundType(WSC, CAMP, CORE_HASH), "confirm", "legacy 판끼리는 기존 동작");
});
t("v7 §2 배선 소스 계약: freeze 동결(잠금 안 sha 결속)·roundType 경계 인자·abCount=manifest 판독처·round/finding 경계 표기", () => {
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes("boundaryGen: boundaryGenOf(evi.sha1, sel9 ? selArc9.sha1 : \"\", mf9)") && cb.includes("evM.sha1 === evi.sha1"), "freeze 지점: 같은 잠금 안 재판독+주입 지문 결속일 때만 manifest 구성(불일치=legacy 동결·3b: 선별 판=appliedArchiveHash 실값 결속)");
  assert.ok(cb.includes("buildAbManifest(evM.data.alwaysBlocker, selTexts9)"), "manifest에 선별분 합류(3b — 코어 다음 연속 ab-N)");
  assert.ok(cb.includes("deriveRoundType(ws, camp, frozen, bg9 || undefined)"), "confirm 판정에 이번 판 경계 전달");
  assert.ok(cb.includes("abCount = frozenManifest ? frozenManifest.length : evNow.data.alwaysBlocker.length"), "ab 범위 판독처=동결 합본 manifest(§2 — 부재·askId 불일치=legacy 코어 개수)");
  assert.strictEqual((cb.match(/boundaryGen: bg9/g) || []).length, 6, "round 3경로+일반 finding+범위확장 신규 blocker·상한 소진 주의 finding 전 경로에 경계 표기(§2-① — 2단계 재검증 blocker②)");
});
// ── [4a] 개정 작업대 목적지(서고 기본/코어)·normSet 코어∪서고·96 상한 — 신선 픽스처(위 상태와 독립) ──
const W4 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc4-ws-"));
const R4 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc4-repo-"));
const core4 = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["로컬"], alwaysBlocker: ["코어에 이미 있는 수칙"], outOfScope: ["범위 밖"] }, null, 1);
fs.writeFileSync(path.join(R4, CL.ENVELOPE_FILE), core4);
const G4 = sha1(core4);
assert.strictEqual(CL.setEnvelopeHashAllSlots(W4, G4), 2);
const cand4 = (cid, title, rp) => ({ candidateId: cid, envelopeHash: G4, status: "proposed", kind: "resolved-blocker", repoKey: CL.repoKeyOf(rp || R4), title, ts: new Date().toISOString() }); // [ab-1] 픽스처도 태어난 저장소 표식 필수
CL.appendEnvelopeCandidates(W4, [cand4("aaaa000000000001", "배포 전 백업을 남긴다"), cand4("aaaa000000000002", "코어에 이미 있는 수칙"), cand4("aaaa000000000003", "서고에 이미 있는 수칙"), cand4("aaaa000000000004", "고객 기록은 지우지 않는다")]);

t("★[4a] 미도입 최초 서고 올림: 빈 서고에서 초안→도장 전이=서고 파일 생성+archiveHash 양 슬롯·코어 무접촉", () => {
  const r = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000001"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.strictEqual(r.ok, true, String(r.error || ""));
  assert.strictEqual(r.target, "archive");
  const pr = CL.readEnvelopeProposal(W4, R4);
  assert.ok(pr.st === "ok" && pr.target === "archive" && pr.targetBaseHash === null, "제안본 target=archive·미도입 base=null(최초 생성 경로)");
  const tr = CL.applyEnvelopeTransition(W4, R4, "ko", null);
  assert.strictEqual(tr.ok, true, String(tr.reason || ""));
  const ar = CL.readVerifyEnvelopeArchive(R4);
  assert.ok(ar.st === "ok" && ar.data.alwaysBlocker.length === 1 && ar.data.alwaysBlocker[0] === "배포 전 백업을 남긴다", "서고 파일 실생성+항목 반영");
  const c4 = CL.loadContract(W4, "ko"), c4e = CL.loadContract(W4, "en");
  assert.ok(c4.archiveHash === ar.sha1 && c4e.archiveHash === ar.sha1, "archiveHash 양 슬롯");
  assert.ok(c4.envelopeHash === G4 && fs.readFileSync(path.join(R4, CL.ENVELOPE_FILE), "utf8") === core4, "★코어 무접촉");
});
t("★[4a→4e] normSet=코어∪서고: 중복=배치 거부가 아니라 자동 제외+declined 정리(두 층 동시 등재 금지 유지)", () => {
  const r1 = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000002"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.ok(!r1.ok && r1.skippedDup === 1 && /자동 정리/.test(r1.error), "코어 중복 1건뿐=초안 없음+자동 정리 보고: " + String(r1.error));
  assert.strictEqual(CL.readEnvelopeCandidates(W4).latest.get("aaaa000000000002@" + G4).status, "declined", "★중복 후보=declined 자동 기록(대기열 정돈)");
  // 서고에 '서고에 이미 있는 수칙'을 먼저 등재
  const r2 = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000003"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.strictEqual(r2.ok, true, String(r2.error || ""));
  assert.strictEqual(CL.applyEnvelopeTransition(W4, R4, "ko", null).ok, true);
  // 같은 문안 후보를 코어로 — 자동 제외(서고 중복 — 두 층 동시 등재는 여전히 불가)
  CL.appendEnvelopeCandidates(W4, [cand4("aaaa000000000005", "서고에 이미 있는 수칙")]);
  const r3 = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000005"], removeItems: [], approvedHash: G4, target: "core" });
  assert.ok(!r3.ok && r3.skippedDup === 1, "서고 중복→코어 자동 제외(등재 안 됨): " + String(r3.error));
});
t("[4a→재편 B] 서고 빼기(ab 전용)+코어 축 빼기 지정=형식 오류·지문 필수·전이 반영", () => {
  const fp4=(s)=>require("crypto").createHash("sha1").update(CL.normBacklogTitle(s),"utf8").digest("hex");
  const AH4=CL.readVerifyEnvelopeArchive(R4).sha1;
  const bad = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: [], removeItems: [{ axis: "supportedEnv", index: 0, itemFp: "0".repeat(40) }], approvedHash: G4, target: "archive", expectedTargetHash: AH4 });
  assert.ok(!bad.ok && /ab축만/.test(bad.error), "서고 빼기는 ab축만");
  // [재편 B 1차 blocker③] 지문 없는 빼기=거부(fail-closed — index 단독 경로 소멸)
  const noFp = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: [], removeItems: [{ axis: "alwaysBlocker", index: 1 }], approvedHash: G4, target: "archive", expectedTargetHash: AH4 });
  assert.ok(!noFp.ok && /결속 지문 누락/.test(noFp.error), "행 지문 누락=거부: " + noFp.error);
  const noTgt = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: [], removeItems: [{ axis: "alwaysBlocker", index: 1, itemFp: fp4(CL.readVerifyEnvelopeArchive(R4).data.alwaysBlocker[1]) }], approvedHash: G4, target: "archive" });
  assert.ok(!noTgt.ok && /결속 지문 누락/.test(noTgt.error), "대상 판 지문 누락=거부: " + noTgt.error);
  const r = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: [], removeItems: [{ axis: "alwaysBlocker", index: 1, itemFp: fp4(CL.readVerifyEnvelopeArchive(R4).data.alwaysBlocker[1]) }], approvedHash: G4, target: "archive", expectedTargetHash: AH4 });
  assert.strictEqual(r.ok, true, String(r.error || ""));
  assert.strictEqual(CL.applyEnvelopeTransition(W4, R4, "ko", null).ok, true);
  const ar = CL.readVerifyEnvelopeArchive(R4);
  assert.ok(ar.data.alwaysBlocker.length === 1 && ar.data.alwaysBlocker[0] === "배포 전 백업을 남긴다", "빼기 반영(#2 제거)");
});
t("★[4a-보강→4e] 코어 '범위 밖' 축 중복→자동 제외·같은 장문(절단 저장) 재등재=자동 제외(저장 실물 대조 유지)", () => {
  // 코어 outOfScope와 같은 문안 — ab만 보면 통과하던 반례(의미 충돌: '방어 안 함'과 '절대 차단' 동시 존재)
  CL.appendEnvelopeCandidates(W4, [cand4("aaaa000000000006", "범위 밖")]);
  const rO = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000006"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.ok(!rO.ok && rO.skippedDup === 1, "코어 3축 전체와 대조(oos 중복=자동 제외·등재 안 됨): " + String(rO.error));
  // 200자 초과 장문 — 절단 저장 후 같은 장문이 다시 오면 '저장 실물' 기준으로 제외돼야 함(원문 비교만 하면 통과)
  const long9 = "장문 수칙 ".repeat(40).trim(); // 240자 — 항목 상한 200자 초과(절단 저장 경로)
  CL.appendEnvelopeCandidates(W4, [cand4("aaaa000000000007", long9), cand4("aaaa000000000008", long9)]);
  const rL = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000007"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.strictEqual(rL.ok, true, String(rL.error || ""));
  assert.strictEqual(CL.applyEnvelopeTransition(W4, R4, "ko", null).ok, true);
  assert.ok(CL.readVerifyEnvelopeArchive(R4).data.alwaysBlocker.some((x) => x.endsWith("…[절단]")), "장문=절단 저장 확인");
  const rL2 = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000008"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.ok(!rL2.ok && rL2.skippedDup === 1, "★같은 장문 재등재=자동 제외(저장 실물(절단 후) 기준 대조): " + String(rL2.error));
});
t("★[4e 실보고 반례] 혼합 배치(신규+중복)=중복만 자동 제외하고 신규는 올림(1건 중복이 배치를 죽이지 않음)", () => {
  const W7 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-mix-ws-"));
  const R7 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-mix-repo-"));
  fs.writeFileSync(path.join(R7, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(W7, CORE_HASH), 2);
  fs.writeFileSync(path.join(R7, CL.ARCHIVE_FILE), arcText); // 기존 서고 2항
  assert.strictEqual(CL.setContractHashAllSlots(W7, "archiveHash", sha1(arcText)), 2);
  const mk7 = (cid, title, rp) => ({ candidateId: cid, envelopeHash: CORE_HASH, status: "proposed", kind: "resolved-blocker", repoKey: CL.repoKeyOf(rp || R7), title, ts: "T" }); // [ab-1] 픽스처도 태어난 저장소 표식 필수
  CL.appendEnvelopeCandidates(W7, [mk7("dd00000000000001", arcObj.alwaysBlocker[0]), mk7("dd00000000000002", "완전히 새로운 수칙 하나"), mk7("dd00000000000003", arcObj.alwaysBlocker[1]), mk7("dd00000000000004", "완전히 새로운 수칙 둘"), mk7("dd00000000000005", "완전히 새로운 수칙 하나")]);
  const r = CL.draftEnvelopeRevision(W7, R7, { addCandidateIds: ["dd00000000000001", "dd00000000000002", "dd00000000000003", "dd00000000000004", "dd00000000000005"], removeItems: [], approvedHash: CORE_HASH, target: "archive" });
  assert.ok(r.ok && r.adds === 2 && r.skippedDup === 3, "★신규 2건만 올림·서고 중복 2+배치 내부 중복 1=제외 3: " + JSON.stringify({ ok: r.ok, adds: r.adds, skip: r.skippedDup, err: r.error }));
  const inner = JSON.parse(CL.readEnvelopeProposal(W7, R7).proposalText);
  assert.ok(inner.alwaysBlocker.length === 4 && inner.alwaysBlocker.includes("완전히 새로운 수칙 하나") && inner.alwaysBlocker.includes("완전히 새로운 수칙 둘"), "초안=기존 2+신규 2(중복 미포함)");
  const { latest } = CL.readEnvelopeCandidates(W7);
  assert.ok(latest.get("dd00000000000001@" + CORE_HASH).status === "declined" && latest.get("dd00000000000005@" + CORE_HASH).status === "declined", "제외분=declined 자동 정리");
  assert.ok(latest.get("dd00000000000002@" + CORE_HASH).status === "adopted", "올림분=adopted");
  // [4e 확인검증 blocker① 반례] 뒤쪽 후보의 하드 오류(95항 서고에서 상한 도달)가 앞서 발견한 중복 정리를 못 막음
  const W8 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-cap-ws-"));
  const R8 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-cap-repo-"));
  fs.writeFileSync(path.join(R8, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(W8, CORE_HASH), 2);
  const items95 = Array.from({ length: 95 }, (_, i) => "채워진 수칙 " + (i + 1));
  const full95 = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: items95 }, null, 1);
  fs.writeFileSync(path.join(R8, CL.ARCHIVE_FILE), full95);
  assert.strictEqual(CL.setContractHashAllSlots(W8, "archiveHash", sha1(full95)), 2);
  CL.appendEnvelopeCandidates(W8, [mk7("ee00000000000001", "채워진 수칙 1", R8), mk7("ee00000000000002", "새 수칙 A", R8), mk7("ee00000000000003", "새 수칙 B", R8)]);
  const rc8 = CL.draftEnvelopeRevision(W8, R8, { addCandidateIds: ["ee00000000000001", "ee00000000000002", "ee00000000000003"], removeItems: [], approvedHash: CORE_HASH, target: "archive" });
  assert.ok(!rc8.ok && /96항 상한/.test(rc8.error) && rc8.skippedDup === 1, "95항+[중복,A,B]=A가 96번째 채운 뒤 B에서 상한 중단: " + JSON.stringify({ err: rc8.error, skip: rc8.skippedDup }));
  assert.strictEqual(CL.readEnvelopeCandidates(W8).latest.get("ee00000000000001@" + CORE_HASH).status, "declined", "★상한 중단에도 앞서 발견한 중복=declined 정리(반환 전 flush)");
});
t("★[4a] 소실·무단 파일·96 상한=정직 거부", () => {
  // 소실(도장과 다름): 파일 직접 편집 → 어느 목적지든 거부
  const keep = fs.readFileSync(path.join(R4, CL.ARCHIVE_FILE), "utf8");
  fs.writeFileSync(path.join(R4, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["몰래 바꾼 판"] }, null, 1));
  const rB = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000004"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.ok(!rB.ok && /도장 시점과 다름/.test(rB.error), "서고 드리프트=거부: " + String(rB.error));
  fs.writeFileSync(path.join(R4, CL.ARCHIVE_FILE), keep);
  // 96 상한: 96항 서고를 도장 상태로 구성
  const full = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: Array.from({ length: CL.ARCHIVE_ITEM_MAX }, (_, i) => "보관 수칙 " + (i + 1)) }, null, 1);
  fs.writeFileSync(path.join(R4, CL.ARCHIVE_FILE), full);
  assert.strictEqual(CL.setContractHashAllSlots(W4, "archiveHash", sha1(full)), 2);
  const rC = CL.draftEnvelopeRevision(W4, R4, { addCandidateIds: ["aaaa000000000004"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.ok(!rC.ok && /96항 상한/.test(rC.error), "96 상한 도달=정리 안내: " + String(rC.error));
  // 무단 파일(도장 없는 서고): 별도 ws
  const W5 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc4-ws5-"));
  const R5 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc4-repo5-"));
  fs.writeFileSync(path.join(R5, CL.ENVELOPE_FILE), core4);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(W5, G4), 2);
  fs.writeFileSync(path.join(R5, CL.ARCHIVE_FILE), keep);
  CL.appendEnvelopeCandidates(W5, [cand4("bbbb000000000001", "새 수칙", R5)]);
  const rD = CL.draftEnvelopeRevision(W5, R5, { addCandidateIds: ["bbbb000000000001"], removeItems: [], approvedHash: G4, target: "archive" });
  assert.ok(!rD.ok && /도장 없이 존재/.test(rD.error), "무단 서고 파일=덮어쓰기 거부: " + String(rD.error));
});
t("★[4c UX] 초안 차이 요약(envelopeDraftDiff): 유지·올림·빼기·최초 생성·판독 실패=null", () => {
  const RD = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-diff-"));
  const curArr = ["기존 수칙 하나", "기존 수칙 둘"];
  fs.writeFileSync(path.join(RD, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: curArr }, null, 1));
  const prAdd = { st: "ok", target: "archive", proposalText: JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: [...curArr, "새로 올린 수칙"] }, null, 1) };
  const d1 = CL.envelopeDraftDiff(RD, prAdd);
  assert.ok(d1 && d1.kept === 2 && d1.added.length === 1 && d1.added[0].text === "새로 올린 수칙" && d1.removed.length === 0 && !d1.firstTime, "올림만=유지 2·추가 1·빼기 0(기존 삭제 없음이 수치로 보임): " + JSON.stringify(d1));
  const prDel = { st: "ok", target: "archive", proposalText: JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: [curArr[0]] }, null, 1) };
  const d2 = CL.envelopeDraftDiff(RD, prDel);
  assert.ok(d2 && d2.kept === 1 && d2.removed.length === 1 && d2.removed[0].text === curArr[1], "빼기=제거 목록에 그 항목");
  const RD2 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-diff2-"));
  const d3 = CL.envelopeDraftDiff(RD2, prAdd);
  assert.ok(d3 && d3.firstTime && d3.added.length === 3, "대상 파일 부재=최초 생성(전부 추가)");
  assert.strictEqual(CL.envelopeDraftDiff(RD, { st: "ok", target: "archive", proposalText: "{broken" }), null, "초안 판독 실패=null(요약 실패가 승인을 막지 않음 — 호출자는 전문만 표시)");
  // [1차 blocker① 반례] 현행 파일 '손상'(부재 아님)=null — '첫 등재·전부 추가'로 위장 금지
  const RD3 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-diff3-"));
  fs.writeFileSync(path.join(RD3, CL.ARCHIVE_FILE), "{corrupt json");
  assert.strictEqual(CL.envelopeDraftDiff(RD3, prAdd), null, "★현행 손상=null(부재(ENOENT)만 최초 생성)");
  // [2차 확인검증 blocker 반례] 문법 유효·정본 계약 손상(스키마 오기/축 비배열)=null — strict 판독기와 같은 눈
  const RD5 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-diff5-"));
  fs.writeFileSync(path.join(RD5, CL.ARCHIVE_FILE), JSON.stringify({ schema: "wrong", alwaysBlocker: ["기존"] }, null, 1));
  assert.strictEqual(CL.envelopeDraftDiff(RD5, prAdd), null, "★스키마 오기 현행=null(정상 요약 위장 금지)");
  fs.writeFileSync(path.join(RD5, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: "기존" }, null, 1));
  assert.strictEqual(CL.envelopeDraftDiff(RD5, prAdd), null, "★축 비배열 현행=null");
  assert.strictEqual(CL.envelopeDraftDiff(RD, { st: "ok", target: "archive", proposalText: JSON.stringify({ schema: "wrong", alwaysBlocker: ["x"] }) }), null, "초안 정본 계약 손상=null");
  // [1차 blocker② 반례] 중복 문안 축소=빼기로 계상(집합 비교의 거짓 '빼기 0' 차단)
  const RD4 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-diff4-"));
  fs.writeFileSync(path.join(RD4, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["같은 문안", "같은 문안"] }, null, 1));
  const d5 = CL.envelopeDraftDiff(RD4, { st: "ok", target: "archive", proposalText: JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["같은 문안"] }, null, 1) });
  assert.ok(d5 && d5.kept === 1 && d5.removed.length === 1 && d5.removed[0].text === "같은 문안", "★중복 2→1 축소=빼기 1(다중집합 대조): " + JSON.stringify(d5));
});
t("[4c UX] 승인 화면 배선 소스 핀: 요약 선행·'교체' 헤드라인 폐기·다음 할 일 안내", () => {
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok((ext.match(/draftSummaryDetail\(/g) || []).length >= 3, "열람·승인 두 모달이 같은 요약 렌더러 사용(정의 포함 3회 이상)");
  assert.ok(ext.includes("[바뀌는 것 — 한눈 요약") && ext.includes("그대로 유지 ${d.kept}항"), "요약=유지/올림/빼기 수치+항목 나열");
  assert.ok(!ext.includes("전문이 현재 수칙서를 교체합니다") && ext.includes("기존 수칙은 그대로 있고, 아래 요약의 추가·빼기만 반영됩니다"), "★'교체' 오해 문구 폐기 — 유지 보장 문구로(재편 B 어휘: 추가·빼기)");
  assert.ok(ext.includes("다음 할 일: '초안 확인·승인'"), "대기 카드·생성 안내에 다음 단계 지시");
  assert.ok(/if \(lines\.length\) parts\.push\(lines\.join\("\\n"\)\);\s*\n\s*if \(pr\.note\) parts\.push\(/.test(ext), "★표시 순서=요약→note→전문(note 선행이면 '한눈 요약'이 첫 구조가 못 됨 — 1차 blocker③)");
});
t("★[4d blocker 반례] 13건 이상 서고 올림 초안→폐기=전 후보 판단 대기 복원(12 상한 절단의 adopted 고아 봉합)", () => {
  const W6 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-many-ws-"));
  const R6 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-many-repo-"));
  fs.writeFileSync(path.join(R6, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(W6, CORE_HASH), 2);
  const ids6 = Array.from({ length: 13 }, (_, i) => "cc" + String(i).padStart(2, "0") + "000000000000");
  CL.appendEnvelopeCandidates(W6, ids6.map((cid, i) => ({ candidateId: cid, envelopeHash: CORE_HASH, status: "proposed", kind: "resolved-blocker", repoKey: CL.repoKeyOf(R6), title: "많은 수칙 " + (i + 1), ts: "T" })));
  const r = CL.draftEnvelopeRevision(W6, R6, { addCandidateIds: ids6, removeItems: [], approvedHash: CORE_HASH, target: "archive" });
  assert.strictEqual(r.ok, true, String(r.error || ""));
  const pr = CL.readEnvelopeProposal(W6, R6);
  assert.strictEqual(pr.candidateIds.length, 13, "★영수증 후보 결속=전량(코어 12 상한으로 절단 금지): " + pr.candidateIds.length);
  const d = CL.discardEnvelopeProposalRestoring(W6);
  assert.ok(d.ok && d.restored, "복원형 폐기 성공");
  const { latest } = CL.readEnvelopeCandidates(W6);
  const back = ids6.filter((cid) => (latest.get(cid + "@" + CORE_HASH) || {}).status === "proposed");
  assert.strictEqual(back.length, 13, "★13건 전원 판단 대기 복원(13번째 이후 adopted 고아 없음): " + back.length + "/13");
});
t("★[4f 실보고 반례] 대기열 정리기(reconcile)가 서고 문안까지 보고 기등재 후보를 자동 정리(중복이 '판단 대기'로 잔존 금지)", () => {
  const W9 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-rec-ws-"));
  const R9 = fs.mkdtempSync(path.join(os.tmpdir(), "envarc-rec-repo-"));
  fs.writeFileSync(path.join(R9, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.setEnvelopeHashAllSlots(W9, CORE_HASH), 2); CL.updateContractPatch(W9, undefined, { scoutRepo: R9 }); // [ab-1] 상신은 계약 정찰 대상과 repo 일치 요구
  fs.writeFileSync(path.join(R9, CL.ARCHIVE_FILE), arcText); // 서고 2항
  assert.strictEqual(CL.setContractHashAllSlots(W9, "archiveHash", sha1(arcText)), 2);
  // [재편 A] legacy resolved-blocker proposed는 정책 개정 정리 대상 — 스윕 계약은 현행 공급 kind(rule-manual)로 검사(스윕은 draftable 공통·계약 보존).
  const mk9 = (cid, title) => ({ candidateId: cid, envelopeHash: CORE_HASH, status: "proposed", kind: "rule-manual", origin: "manual", policyVersion: 2, repoKey: CL.repoKeyOf(R9), title, ts: "T" });
  CL.appendEnvelopeCandidates(W9, [mk9("ff00000000000001", arcObj.alwaysBlocker[0]), mk9("ff00000000000002", "진짜 새로운 수칙"), mk9("ff00000000000003", coreObj.outOfScope[0])]);
  CL.reconcileMemoryCandidates(W9, R9, CORE_HASH);
  const { latest } = CL.readEnvelopeCandidates(W9);
  assert.strictEqual(latest.get("ff00000000000001@" + CORE_HASH).status, "declined", "★서고 등재 문안의 대기 후보=자동 정리");
  assert.strictEqual(latest.get("ff00000000000003@" + CORE_HASH).status, "declined", "코어(oos) 등재 문안의 대기 후보=자동 정리");
  assert.strictEqual(latest.get("ff00000000000002@" + CORE_HASH).status, "proposed", "신규 문안=대기 유지(오정리 없음)");
  // [확인검증 blocker 반례] 장문 기등재의 '신규 생성' 억제 — 서고에 절단 실물로 저장된 장문과 같은 blocker가
  // 새로 해소되면 declined로 억제(한 스캔도 대기 노출 금지)
  const longT9 = "긴 수칙 문안 ".repeat(30).trim(); // 240자+
  const cut9 = longT9.slice(0, 200 - "…[절단]".length) + "…[절단]";
  const arcLong = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: [...arcObj.alwaysBlocker, cut9] }, null, 1);
  fs.writeFileSync(path.join(R9, CL.ARCHIVE_FILE), arcLong);
  assert.strictEqual(CL.setContractHashAllSlots(W9, "archiveHash", sha1(arcLong)), 2);
  const CAMP9 = "cl:test:rec";
  CL.appendFindingsLedger(W9, [
    { type: "finding", findingId: "f-long9", campaignId: CAMP9, round: 1, tag: "blocker", title: longT9, titleNorm: longT9, envelopeHash: CORE_HASH, demoted: false, status: "open", ts: "T" },
    { type: "close", findingId: "f-long9", campaignId: CAMP9, closeReason: "resolved", askId: "ask-x", ts: "T" },
  ]);
  // [재편 A] 생성 시점 억제의 새 계약: 자동 스캔이 아니라 명시 상신(rule-propose)이 절단 실물 대조로 거부
  const rpLong = CL.ruleProposeCandidate(W9, R9, { findingId: "f-long9", why: "절단 등재 대조 반례용 관통 이유", campaignId: CAMP9, approvedHash: CORE_HASH });
  assert.strictEqual(rpLong.reason, "already-in-envelope", "장문(절단 등재)과 같은 신규 blocker=상신 시점 거부(한 스캔도 대기 노출 없음)");
  const cidLong = CL.envelopeCandidateId("rule-manual", CL.wsKeyFor(W9) + "|" + CAMP9 + "|f-long9");
  assert.ok(!CL.readEnvelopeCandidates(W9).latest.has(cidLong + "@" + CORE_HASH), "거부=장부 무기록(대기열 오염 없음)");
  // 소실 서고(도장 불일치)=보수: 서고 문안을 억제 집합에 안 넣음(코어만) — 신규가 서고 문안과 겹쳐도 대기 유지
  const keep9 = fs.readFileSync(path.join(R9, CL.ARCHIVE_FILE), "utf8");
  fs.writeFileSync(path.join(R9, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["바뀐 판"] }, null, 1));
  CL.appendEnvelopeCandidates(W9, [mk9("ff00000000000004", arcObj.alwaysBlocker[1])]);
  CL.reconcileMemoryCandidates(W9, R9, CORE_HASH);
  assert.strictEqual(CL.readEnvelopeCandidates(W9).latest.get("ff00000000000004@" + CORE_HASH).status, "proposed", "소실 서고=보수(코어만 대조 — 오정리 없음)");
  fs.writeFileSync(path.join(R9, CL.ARCHIVE_FILE), keep9);
});
t("★[재편 B §3-2] 빼기 기대 지문=빌더 잠금 안 대조 — 대상 판·항목 지문 불일치=거부·일치=성공(TOCTOU 반례)", () => {
  const W=fs.mkdtempSync(path.join(os.tmpdir(),"envarc-toctou-ws-"));
  const R=fs.mkdtempSync(path.join(os.tmpdir(),"envarc-toctou-repo-"));
  fs.writeFileSync(path.join(R, CL.ENVELOPE_FILE), coreRaw);
  CL.setEnvelopeHashAllSlots(W, CORE_HASH);
  fs.writeFileSync(path.join(R, CL.ARCHIVE_FILE), arcText);
  const AH=sha1(arcText);
  CL.setContractHashAllSlots(W, "archiveHash", AH);
  const fpOf=(s)=>require("crypto").createHash("sha1").update(CL.normBacklogTitle(s),"utf8").digest("hex");
  // ① 대상 판 불일치=거부
  const r1=CL.draftEnvelopeRevision(W,R,{target:"archive",removeItems:[{axis:"alwaysBlocker",index:0,itemFp:fpOf(arcObj.alwaysBlocker[0])}],approvedHash:CORE_HASH,expectedTargetHash:"f".repeat(40)});
  assert.strictEqual(r1.ok,false); assert.ok(/목록이 갱신/.test(r1.error||""),"대상 판 불일치=거부: "+r1.error);
  // ② 항목 지문 불일치(다른 항목의 지문)=거부
  const r2=CL.draftEnvelopeRevision(W,R,{target:"archive",removeItems:[{axis:"alwaysBlocker",index:0,itemFp:fpOf(arcObj.alwaysBlocker[1])}],approvedHash:CORE_HASH,expectedTargetHash:AH});
  assert.strictEqual(r2.ok,false); assert.ok(/항목 지문 불일치/.test(r2.error||""),"항목 지문 불일치=거부: "+r2.error);
  // ③ 전부 일치=성공(서고 빼기 문 — 재편 B 신설 경로)
  const r3=CL.draftEnvelopeRevision(W,R,{target:"archive",removeItems:[{axis:"alwaysBlocker",index:0,itemFp:fpOf(arcObj.alwaysBlocker[0])}],approvedHash:CORE_HASH,expectedTargetHash:AH});
  assert.strictEqual(r3.ok,true,"일치=초안 성공: "+(r3.error||"")); assert.strictEqual(r3.removes,1);
  const pr=CL.readEnvelopeProposal(W,R);
  assert.strictEqual(JSON.parse(pr.proposalText).alwaysBlocker.length, arcObj.alwaysBlocker.length-1, "서고에서 1건 빠진 제안본");
  CL.discardEnvelopeProposal(W);
});
t("[재편 B §3-4] 취소 원자 순서 — 소스 계약: 복원 기록 성공 후에만 초안 삭제·실패=초안 보존 반환", () => {
  const src=fs.readFileSync(path.join(__dirname,"..","bridge","contract-lib.js"),"utf8");
  const i1=src.indexOf('return { ok: false, restored: false, reason: "restore-write" }');
  const i2=src.indexOf('return { ok: false, restored: false, reason: "restore-read" }');
  const i3=src.indexOf("return { ok: discardEnvelopeProposal(ws), restored };");
  assert.ok(i1>0 && i2>0 && i3>i1 && i3>i2, "복원 실패 반환 2종이 초안 삭제 호출보다 앞(원자 순서 — f-47c1c6bc)");
});
t("★[재편 B 2차 blocker①] 취소 결속=wrapper 신원(draftId) — 같은 문안·다른 후보의 새 초안은 옛 모달 취소로 폐기되지 않음", () => {
  const W=fs.mkdtempSync(path.join(os.tmpdir(),"envarc-did-ws-"));
  const R=fs.mkdtempSync(path.join(os.tmpdir(),"envarc-did-repo-"));
  fs.writeFileSync(path.join(R, CL.ENVELOPE_FILE), coreRaw);
  CL.setEnvelopeHashAllSlots(W, CORE_HASH);
  // 초안 A: 후보 X(문안 T) 올림 → 서고 신규 생성
  const mk=(cid,title)=>({ candidateId: cid, envelopeHash: CORE_HASH, status: "proposed", kind: "rule-manual", origin: "manual", policyVersion: 2, repoKey: CL.repoKeyOf(R), title, ts: "T" });
  CL.appendEnvelopeCandidates(W, [mk("dd00000000000001","같은 문안 수칙"), mk("dd00000000000002","같은 문안 수칙")]);
  const a=CL.draftEnvelopeRevision(W,R,{addCandidateIds:["dd00000000000001"],removeItems:[],approvedHash:CORE_HASH,target:"archive"});
  assert.strictEqual(a.ok,true,"초안 A: "+(a.error||""));
  const prA=CL.readEnvelopeProposal(W,R); const tokA=String(prA.draftId||prA.newHash); assert.ok(prA.draftId, "wrapper 신원 draftId 존재");
  // 다른 창: A 폐기 후 후보 Y(같은 문안)로 초안 B 재작성 → proposalText·newHash 동일, draftId 다름
  assert.ok(CL.discardEnvelopeProposalRestoring(W, tokA).ok, "A 폐기(자기 신원)");
  const b=CL.draftEnvelopeRevision(W,R,{addCandidateIds:["dd00000000000002"],removeItems:[],approvedHash:CORE_HASH,target:"archive"});
  assert.strictEqual(b.ok,true,"초안 B: "+(b.error||""));
  const prB=CL.readEnvelopeProposal(W,R);
  assert.strictEqual(prB.newHash, prA.newHash, "(전제) 같은 문안=같은 newHash");
  assert.notStrictEqual(prB.draftId, prA.draftId, "(전제) wrapper 신원은 다름");
  // 옛 모달(A 토큰)의 취소 → B는 무접촉
  const d=CL.discardEnvelopeProposalRestoring(W, tokA);
  assert.strictEqual(d.ok,false); assert.strictEqual(d.reason,"draft-changed","옛 신원으로는 새 초안 폐기 불가");
  assert.strictEqual(CL.readEnvelopeProposal(W,R).st,"ok","B 초안 보존");
  assert.strictEqual(CL.readEnvelopeCandidates(W).latest.get("dd00000000000002@"+CORE_HASH).status,"adopted","B 후보 adopted 유지(오복원 없음)");
  // legacy 초안(draftId 부재)=newHash 폴백 — 판독기 계약
  const src=fs.readFileSync(path.join(__dirname,"..","bridge","contract-lib.js"),"utf8");
  assert.ok(/String\(pr\.draftId \|\| pr\.newHash \|\| ""\)/.test(src), "legacy 초안=newHash 폴백");
  CL.discardEnvelopeProposalRestoring(W, String(prB.draftId));
});
console.log(`결과: ${n}/${n} 통과`);
