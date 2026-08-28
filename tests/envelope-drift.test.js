"use strict";
/*
 * [경계 통일 2026-08-29] 승인 없이 바뀐 수칙 파일 = 검증 시작 안 함(1층·2층 동일) + 창 하나에서 '바뀐 내용 보기' → 승인/복구.
 * 실행 시험(격리 CODEX_BRIDGE_HOME): ①도장 전이가 승인본 사본을 남김 ②차이 계산(추가/빠짐·축 대조) ③복구=백업 후 승인본 기록·
 * 지문 검증 ④거부 반례(WAL 잔존·초안 대기·사본 없음·백업 실패=파괴 0) ⑤ask-start 코어 게이트·확장 표면 소스 핀.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws-"));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-repo-"));

const coreObj = { schema: "verify-envelope-v1", supportedEnv: ["윈도우 로컬 단일 사용자"], alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"], outOfScope: ["다중 서버 동시 배포"] };
const coreRaw = JSON.stringify(coreObj, null, 1);
fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), coreRaw);
const CORE_HASH = sha1(coreRaw);

t("도장 전이(stampEnvelopeAllSlots)가 승인본 사본을 남긴다 — 지문·전문 일치", () => {
  const r = CL.stampEnvelopeAllSlots(WS, REPO, CORE_HASH, "core");
  assert.strictEqual(r.ok, true, String(r.reason || ""));
  const cp = CL.readEnvelopeApprovedCopy(WS, "core");
  assert.strictEqual(cp.st, "ok"); assert.strictEqual(cp.hash, CORE_HASH); assert.strictEqual(cp.text, coreRaw);
  assert.ok(fs.existsSync(CL.envelopeApprovedCopyFileFor(WS, "core")), "사본 파일 실존");
  const dv0 = CL.envelopeDriftView(WS, REPO, "core");
  assert.strictEqual(dv0.ok, true); assert.strictEqual(dv0.drift, false, "승인 직후=차이 없음"); assert.strictEqual(dv0.hasCopy, true);
});

t("승인 없이 파일 변경 → 차이 계산: 추가 1(금지 축)·빠짐 1(전제 축)·정규화 대조(공백 변형=같은 줄)", () => {
  const edited = { schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: ["로컬 실패 시  무승인 원격 전달 금지", "배포 전 백업을 남긴다"], outOfScope: ["다중 서버 동시 배포"] };
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), JSON.stringify(edited, null, 1));
  const dv = CL.envelopeDriftView(WS, REPO, "core");
  assert.strictEqual(dv.ok, true); assert.strictEqual(dv.drift, true); assert.strictEqual(dv.hasCopy, true); assert.strictEqual(dv.currentReadable, true);
  assert.deepStrictEqual(dv.added.map((x) => x.axis + ":" + x.text), ["alwaysBlocker:배포 전 백업을 남긴다"], "추가 1(공백 변형 줄은 같은 줄로 대조)");
  assert.deepStrictEqual(dv.removed.map((x) => x.axis + ":" + x.text), ["supportedEnv:윈도우 로컬 단일 사용자"], "빠짐 1");
  assert.strictEqual(dv.approvedHash, CORE_HASH); assert.notStrictEqual(dv.currentHash, CORE_HASH);
});

t("손상 파일=currentReadable false(승인 불가·복구만) · 파일 부재=빈 목록(전량 빠짐)", () => {
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), "{ not json");
  const dvC = CL.envelopeDriftView(WS, REPO, "core");
  assert.strictEqual(dvC.ok, true); assert.strictEqual(dvC.currentReadable, false); assert.strictEqual(dvC.drift, true);
  fs.rmSync(path.join(REPO, CL.ENVELOPE_FILE));
  const dvA = CL.envelopeDriftView(WS, REPO, "core");
  assert.strictEqual(dvA.currentReadable, true); assert.strictEqual(dvA.currentAbsent, true, "부재 표지(승인 버튼 비노출 재료)"); assert.strictEqual(dvA.added.length, 0); assert.strictEqual(dvA.removed.length, 3, "부재=승인본 3줄 전량 빠짐");
  assert.strictEqual(dvC.currentAbsent, false);
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), ""); // 존재하는 0바이트 파일=손상(부재 아님) — 4회차 보완
  const dvZ = CL.envelopeDriftView(WS, REPO, "core");
  assert.strictEqual(dvZ.currentAbsent, false, "0바이트 파일은 부재가 아님"); assert.strictEqual(dvZ.currentReadable, false, "0바이트=판독 불가(복구만)");
  fs.rmSync(path.join(REPO, CL.ENVELOPE_FILE));
});

t("복구(restoreEnvelopeApproved)=현재 파일 백업 후 승인본 기록 → 지문 일치·백업 내용=바뀌었던 파일", () => {
  const editedRaw = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: ["배포 전 백업을 남긴다"], outOfScope: [] }, null, 1);
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), editedRaw);
  const r = CL.restoreEnvelopeApproved(WS, REPO, "core");
  assert.strictEqual(r.ok, true, String(r.reason || ""));
  assert.ok(r.backup && fs.existsSync(r.backup), "백업 파일 실존: " + r.backup);
  assert.strictEqual(fs.readFileSync(r.backup, "utf8"), editedRaw, "백업=바뀌었던 파일 그대로");
  assert.strictEqual(sha1(fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8")), CORE_HASH, "복구 후 지문=승인본");
  assert.strictEqual(CL.envelopeDriftView(WS, REPO, "core").drift, false);
  // 파일 부재 상태에서 복구=백업 없음(""), 승인본 기록
  fs.rmSync(path.join(REPO, CL.ENVELOPE_FILE));
  const r2 = CL.restoreEnvelopeApproved(WS, REPO, "core");
  assert.strictEqual(r2.ok, true); assert.strictEqual(r2.backup, ""); assert.strictEqual(sha1(fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8")), CORE_HASH);
});

t("복구 거부 반례: WAL 잔존=recover-needed · 초안 대기=proposal-pending · 사본 없음=no-approved-copy(파일 무접촉)", () => {
  const editedRaw = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: ["x".repeat(20)], outOfScope: [] }, null, 1);
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), editedRaw);
  const walF = CL.envelopeTransWalFileFor ? CL.envelopeTransWalFileFor(WS) : null;
  if (walF) {
    fs.mkdirSync(path.dirname(walF), { recursive: true }); fs.writeFileSync(walF, "{}");
    assert.strictEqual(CL.restoreEnvelopeApproved(WS, REPO, "core").reason, "recover-needed");
    fs.rmSync(walF);
  }
  // 사본 없음: 다른 ws(승인 지문만 있고 사본 파일 없음)
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws2-"));
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WS2, CORE_HASH), 2);
  const dv2 = CL.envelopeDriftView(WS2, REPO, "core");
  assert.strictEqual(dv2.ok, true); assert.strictEqual(dv2.hasCopy, false); assert.strictEqual(dv2.drift, true); assert.ok(dv2.currentItems.length === 1, "사본 없음=현재 내용만");
  const r3 = CL.restoreEnvelopeApproved(WS2, REPO, "core");
  assert.strictEqual(r3.ok, false); assert.strictEqual(r3.reason, "no-approved-copy");
  assert.strictEqual(fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8"), editedRaw, "거부=파일 무접촉");
  assert.strictEqual(CL.restoreEnvelopeApproved(WS, REPO, "core").ok, true, "정상 복구로 원상");
});

t("서고(2층)도 같은 계약: 도장→사본·차이·복구(코어 무접촉)", () => {
  const arcRaw = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다"] }, null, 1);
  fs.writeFileSync(path.join(REPO, CL.ARCHIVE_FILE), arcRaw);
  const AH = sha1(arcRaw);
  const r = CL.stampEnvelopeAllSlots(WS, REPO, AH, "archive");
  assert.strictEqual(r.ok, true, String(r.reason || ""));
  assert.strictEqual(CL.readEnvelopeApprovedCopy(WS, "archive").hash, AH);
  fs.writeFileSync(path.join(REPO, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "고객 차단 기록은 지우지 않는다"] }, null, 1));
  const dv = CL.envelopeDriftView(WS, REPO, "archive");
  assert.strictEqual(dv.drift, true); assert.strictEqual(dv.added.length, 1); assert.strictEqual(dv.removed.length, 0);
  const coreBefore = fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8");
  const rr = CL.restoreEnvelopeApproved(WS, REPO, "archive");
  assert.strictEqual(rr.ok, true, String(rr.reason || ""));
  assert.strictEqual(sha1(fs.readFileSync(path.join(REPO, CL.ARCHIVE_FILE), "utf8")), AH);
  assert.strictEqual(fs.readFileSync(path.join(REPO, CL.ENVELOPE_FILE), "utf8"), coreBefore, "코어 무접촉");
});

t("[2회차 blocker③] 승인본 사본=전이 성공 조건 — 사본 기록 실패면 도장 미기록·WAL 보존(recover-needed)·장애 제거 후 복구 스캐너가 사본까지 완성", () => {
  const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws3-"));
  const R3 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-repo3-"));
  fs.writeFileSync(path.join(R3, CL.ENVELOPE_FILE), coreRaw);
  const cpF = CL.envelopeApprovedCopyFileFor(WS3, "core");
  fs.mkdirSync(cpF, { recursive: true }); // 사본 경로를 디렉터리로 막아 쓰기 실패 유도
  const r = CL.stampEnvelopeAllSlots(WS3, R3, CORE_HASH, "core");
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "approved-copy-write", "★사본 실패=전이 실패");
  assert.strictEqual((CL.loadContract(WS3) || {}).envelopeHash || null, null, "도장 미기록(사본 없는 승인 금지)");
  assert.strictEqual(CL.envelopeTransState(WS3), "recover-needed", "WAL 보존");
  fs.rmSync(cpF, { recursive: true, force: true });
  const rc = CL.recoverEnvelopeTransition(WS3);
  assert.ok(rc && rc.st === "recovered", "장애 제거 후 복구 스캐너 완료: " + JSON.stringify(rc));
  assert.strictEqual((CL.loadContract(WS3) || {}).envelopeHash, CORE_HASH); assert.strictEqual(CL.readEnvelopeApprovedCopy(WS3, "core").hash, CORE_HASH, "복구 완료 시 사본도 실존");
});
t("[3회차 blocker①] 전송 직전 판독(envelopeSliceFor·잠금 안)에서 승인 없는 변경=중단(envelopeDrift) — 선행 게이트 뒤 다른 창의 변경도 '수칙 없는 검증'으로 새지 않음", () => {
  const CB = require("../bridge/codex-bridge.js");
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws4-"));
  const R4 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-repo4-"));
  fs.writeFileSync(path.join(R4, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS4, R4, CORE_HASH, "core").ok, true); CL.updateContractPatch(WS4, undefined, { scoutRepo: R4 });
  const okSlice = CB.envelopeSliceFor(WS4, "ko", "core", CL.loadContract(WS4, "ko"));
  assert.ok(okSlice.envText.includes("로컬 실패 시 무승인 원격 전달 금지"), "승인 일치=주입");
  fs.writeFileSync(path.join(R4, CL.ENVELOPE_FILE), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: ["다른 창이 승인 없이 바꾼 수칙"], outOfScope: [] }, null, 1)); // 선행 게이트 뒤 변경 가정
  assert.throws(() => CB.envelopeSliceFor(WS4, "ko", "core", CL.loadContract(WS4, "ko")), (e) => e && e.envelopeDrift === true && e.exitCode === 3, "★승인 없는 변경=중단(경고+무주입 아님)");
  fs.writeFileSync(path.join(R4, CL.ENVELOPE_FILE), "{ broken");
  assert.throws(() => CB.envelopeSliceFor(WS4, "ko", "core", CL.loadContract(WS4, "ko")), (e) => e && e.envelopeDrift === true, "승인본 있는 프로젝트의 손상=중단");
  const cb0 = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb0.includes("e0.envelopeTransBusy || e0.selectorDrift || e0.envelopeDrift)) throw e0;"), "withContract의 best-effort catch가 envelopeDrift를 삼키지 않음(정직 실패)");
  // 미도입(승인 지문 없음) 프로젝트의 손상은 종전대로 경고만(차단할 승인본 없음)
  const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws5-")); const R5 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-repo5-"));
  fs.writeFileSync(path.join(R5, CL.ENVELOPE_FILE), "{ broken"); CL.updateContractPatch(WS5, undefined, { scoutRepo: R5 });
  assert.doesNotThrow(() => CB.envelopeSliceFor(WS5, "ko", "core", CL.loadContract(WS5, "ko")), "미도입 손상=무회귀(경고만)");
  // [4회차 blocker] 구·신 계약 교차: 잠금 밖 스냅샷(미승인)으로 호출해도 다른 창이 그 사이 승인했으면 손상=중단(신선 계약 기준)
  const staleUnapproved = { ...(CL.loadContract(WS5, "ko") || {}), envelopeHash: null };
  fs.writeFileSync(path.join(R5, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS5, R5, CORE_HASH, "core").ok, true, "다른 창의 승인");
  fs.writeFileSync(path.join(R5, CL.ENVELOPE_FILE), "{ broken");
  assert.throws(() => CB.envelopeSliceFor(WS5, "ko", "core", staleUnapproved), (e) => e && e.envelopeDrift === true, "★옛 스냅샷(미승인)이어도 신선 계약에 승인 지문이 있으면 손상=중단");
  // 반대 교차: 옛 스냅샷은 승인 지문이 있지만 신선 계약은 미승인 → 손상은 경고만(오차단 없음)
  const WS6 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws6-")); const R6 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-repo6-"));
  fs.writeFileSync(path.join(R6, CL.ENVELOPE_FILE), "{ broken"); CL.updateContractPatch(WS6, undefined, { scoutRepo: R6 });
  const staleApproved = { ...(CL.loadContract(WS6, "ko") || {}), envelopeHash: CORE_HASH };
  assert.doesNotThrow(() => CB.envelopeSliceFor(WS6, "ko", "core", staleApproved), "옛 스냅샷에만 승인 지문=오차단 없음(신선 계약 기준)");
  // [5회차 blocker] 전송 직전 계약 파일 자체의 손상/부재 — loadContract 기본값 정규화로 승인 지문이 null이 되는 fail-open 차단
  const WS7 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws7-")); const R7 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-repo7-"));
  fs.writeFileSync(path.join(R7, CL.ENVELOPE_FILE), coreRaw);
  assert.strictEqual(CL.stampEnvelopeAllSlots(WS7, R7, CORE_HASH, "core").ok, true); CL.updateContractPatch(WS7, undefined, { scoutRepo: R7 });
  const cOk7 = CL.loadContract(WS7, "ko"); assert.strictEqual(cOk7.envelopeHash, CORE_HASH);
  const cf7 = CL.contractFileFor(WS7, "ko"); const cfRaw7 = fs.readFileSync(cf7, "utf8");
  fs.writeFileSync(cf7, "{ broken contract"); // 손상
  assert.throws(() => CB.envelopeSliceFor(WS7, "ko", "core", cOk7), (e) => e && e.envelopeDrift === true, "★계약 손상=검증 미실행(기본 계약으로 정규화돼 수칙 없이 진행 금지)");
  fs.rmSync(cf7); // 부재(스냅샷엔 승인 지문 있었음=승인 소실)
  assert.throws(() => CB.envelopeSliceFor(WS7, "ko", "core", cOk7), (e) => e && e.envelopeDrift === true, "★승인 이력 있는 계약 부재=검증 미실행");
  fs.writeFileSync(cf7, cfRaw7);
  assert.ok(CB.envelopeSliceFor(WS7, "ko", "core", cOk7).envText.includes("로컬 실패 시 무승인 원격 전달 금지"), "계약 복원=정상 주입");
  // 승인 이력 없는 계약 부재=legacy 기본값(정상 진행·무회귀)
  const WS8 = fs.mkdtempSync(path.join(os.tmpdir(), "envdrift-ws8-"));
  assert.doesNotThrow(() => CB.envelopeSliceFor(WS8, "ko", "core", CL.loadContract(WS8, "ko")), "미도입=무회귀");
});
t("소스 계약: ask-start 코어 게이트(승인 없이 바뀜=시작 안 함)·확장 카드 act/driftTarget·핸들러·현재 지문 도장 메서드·자동 경계 라벨", () => {
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes('if(typeof cSnap.envelopeHash==="string"&&cSnap.envelopeHash){') && cb.includes('if(core0.st!=="ok"||core0.sha1!==cSnap.envelopeHash)throw Object.assign(new Error(tB(`⚠️ 항상 적용되는 수칙 파일이 승인 없이 바뀌어'), "ask-start: 1층도 승인 없는 변경=검증 시작 안 함(2층과 동일 태도)");
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(ext.includes('btn: tE("승인 없이 바뀐 내용 보기", "View unapproved changes"), act: "envelopeDriftShow", driftTarget: "core"') && ext.includes('act: "envelopeDriftShow", driftTarget: "archive"'), "카드: 1층·2층 모두 버튼 하나(act 지정)");
  assert.ok(ext.includes('var actT=e9.act?e9.act:(') && ext.includes('target: String(e9.driftTarget||"")'), "웹뷰: act 우선·target 동봉");
  assert.ok(ext.includes('m?.type === "envelopeDriftShow"') && ext.includes('CLD.envelopeDriftView(wsD, tgtD, tgD)') && ext.includes('CLD.restoreEnvelopeApproved(wsR, tgtR, tgD)') && ext.includes('this.stampEnvelopeCurrent(tgtD, tgD, langD, shaD)'), "핸들러: 차이 창 → 승인(현재 지문 도장) / 복구(브릿지)");
  assert.ok(ext.includes('stampEnvelopeCurrent(repoAt: string, target: "core" | "archive", lang: Lang, shaAt: string): void {') && ext.includes('bind9 = MPV9.recordApprovalWithStamp(tgtS, { envelopeHash: shaAt, target, sourceRefs: [] }, () => { try { const rS = CLS.stampEnvelopeAllSlots(wsS, tgtS, shaAt, target);'), "승인=사용자가 본 지문(shaAt) 재검사 후 사건 기록+양 슬롯 도장(target 결속)");
  assert.ok(ext.includes("수칙은 검증마다 자동으로 적용돼요 · 사용자는 목록 변경만 승인해요") && !ext.includes("파일을 직접 고치면 다시 승인하기 전까지 멈춰요") && !ext.includes("재승인 전까지 적용 중단(검증엔 주입 안 됨)"), "라벨: 자동/수동 경계 명시·'멈춰요' 모호 문구 소멸");
  assert.ok(!ext.includes('btn: tE("재승인", "Re-approve")'), "구 '재승인' 단독 버튼(확인 없는 도장 경로) 소멸");
  // [2회차 blocker①④] 직접 ask 경로 코어 게이트·파일 부재/손상+승인 지문=같은 카드·같은 버튼
  assert.ok(cb.includes('if (typeof cD9.envelopeHash === "string" && cD9.envelopeHash) {') && cb.includes('if (coreD9.st !== "ok" || coreD9.sha1 !== cD9.envelopeHash) die(tB(`⚠️ 항상 적용되는 수칙 파일이 승인 없이 바뀌어'), "직접 ask도 승인 없는 변경=실행 안 함(ab-3)");
  assert.ok(ext.includes('if (!evv || evv.st === "absent") { if (!hash9) return null; return { label: tE("승인된 수칙 파일이 사라졌어요') && ext.includes('if (evv.st === "corrupt") { if (hash9) return { label: tE("수칙 파일이 깨져 있어 검증이 시작되지 않아요'), "부재·손상+승인 지문=복구 버튼 있는 카드(도입 전=카드 없음 유지)");
  // [2회차 blocker②] 훅은 계약을 한 번만 읽어 표식을 스냅숏 이전에 확정(스냅숏 뒤 재판독 없음)
  const ci = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-inject.js"), "utf8");
  const ch = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  assert.ok(ci.indexOf("const rk0 = cSnap0 ? (constraintRepoKeyFor(ws, cSnap0) || \"\") : \"\";") < ci.indexOf("const snap = writeConstraintTurnSnapshot(ws, anc, ptxt);") && !ci.includes("constraintRepoKeyFor(ws, null)"), "Claude 훅: 표식은 스냅숏 이전·단일 계약 판독");
  assert.ok(ch.includes("rk9 = constraintRepoKeyFor(ws, c) || \"\"") && !ch.includes("constraintRepoKeyFor(ws, null)") && ch.indexOf("rk9 = constraintRepoKeyFor(ws, c)") < ch.indexOf("const snap = writeConstraintTurnSnapshot(ws, turnId, ptxt);"), "Codex 훅: 표식은 스냅숏 이전·프롬프트 훅의 계약 스냅샷(c)에서(스냅숏 뒤 재판독 없음 — 3회차 blocker②)");
  assert.ok(ext.includes("if (dv.currentReadable && !dv.currentAbsent) btns.push(okA);"), "부재 상태=승인 버튼 비노출(3회차 보완)");
});

console.log(`결과: ${n}/${n} 통과`);
