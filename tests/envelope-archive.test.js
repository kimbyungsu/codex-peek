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
    { candidateId: cid, envelopeHash: CORE_HASH, status: "proposed", kind: "user-constraint", title: "서고행 약속 후보", ts: "T" },
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
  assert.ok(cb.includes("boundaryGen: boundaryGenOf(evi.sha1, \"\", mf9)") && cb.includes("evM.sha1 === evi.sha1"), "freeze 지점: 같은 잠금 안 재판독+주입 지문 결속일 때만 manifest 구성(불일치=legacy 동결)");
  assert.ok(cb.includes("deriveRoundType(ws, camp, frozen, bg9 || undefined)"), "confirm 판정에 이번 판 경계 전달");
  assert.ok(cb.includes("abCount = frozenManifest ? frozenManifest.length : evNow.data.alwaysBlocker.length"), "ab 범위 판독처=동결 합본 manifest(§2 — 부재·askId 불일치=legacy 코어 개수)");
  assert.strictEqual((cb.match(/boundaryGen: bg9/g) || []).length, 6, "round 3경로+일반 finding+범위확장 신규 blocker·상한 소진 주의 finding 전 경로에 경계 표기(§2-① — 2단계 재검증 blocker②)");
});
console.log(`결과: ${n}/${n} 통과`);
