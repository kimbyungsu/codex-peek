"use strict";
/*
 * [CURATION v3 — 2026-09-03 구현 1·2단계 시험] 격리 CODEX_BRIDGE_HOME.
 * 계약: 입력 집계기는 장부만 읽고(코드 없음) repoKey·세대 결속으로 실패를 정직 보고한다 · 신호 0+같은 세대=페이지 호출 없이 생략 · 같은 입력=같은 키(멱등) ·
 * 제안기 출력은 JSON 하나·손상=전량 거부·의미 거부=항목 탈락 기록·toggle=보류 · 커밋은 provisional→결과 행→proposed 2단+영수증(purpose curate·turnAnchor=curationKey) ·
 * 회당 ≤3·미승인 ≤6 · 승인 변환(add→서고·oos-add→코어 제외 칸·remove→3중 대조+sourceCandidateIds)·toggle 거부 · 도장 시 applied 종결(고아 복원·세대 이월에서 제외) ·
 * 잠금(산 소유자=거부·죽은 소유자=회수) · 실패=영수증+경보·검증 무영향 · 팔=탐색 담당 유효 팔(2026-09-06 개정 — 종전 harnessMode 유래 폐지) · 재료 0=무호출 · refs 필수 · 울타리 1겹 허용.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cur-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
delete process.env.CLAUDE_PROJECT_DIR; delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CODEX_THREAD_ID;
const CL = require("../bridge/contract-lib.js");
const CU = require("../bridge/curation.js");
const sha1 = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const ta = async (name, fn) => { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); };
const fake = (output, key) => () => ({ promise: Promise.resolve(key ? { ok: false, key, detail: "" } : { ok: true, output }), cancel() {} });

// ── 픽스처: 작업 폴더·정찰 대상 저장소·승인 코어·도장 서고 ──
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws-"));
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo-"));
const coreObj = { schema: "verify-envelope-v1", supportedEnv: ["윈도우 로컬 단일 사용자"], alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"], outOfScope: ["다중 서버 동시 배포"] };
const coreRaw = JSON.stringify(coreObj, null, 1);
fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), coreRaw);
const CORE_HASH = sha1(coreRaw);
assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, CORE_HASH), 2);
assert.ok(CL.updateContractPatch(WS, "ko", { scoutRepo: REPO }).ok);
const arcObj = { schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "고객 차단 기록은 지우지 않는다", "외부 전송 전 원문 마스킹"] };
const arcRaw = JSON.stringify(arcObj, null, 1);
fs.writeFileSync(path.join(REPO, CL.ARCHIVE_FILE), arcRaw);
const ARC_HASH = sha1(arcRaw);
assert.strictEqual(CL.setContractHashAllSlots(WS, "archiveHash", ARC_HASH), 2);
const WSKEY = CL.wsKeyFor(WS), REPOKEY = CL.repoKeyOf(REPO);
const explain = { happened: "검증 때마다 같은 항목이 한 번도 선택되지 않았습니다", ifAdopted: "서고에서 빠져 선별 목록이 짧아집니다", ifNot: "선별 때마다 계속 실려 예산을 씁니다", recommend: "빼기를 권장합니다 — 30일간 0회 선택" };
const good = (over) => Object.assign({ operation: "add", target: "archive", axis: "alwaysBlocker", title: "릴리스 자산은 게시 전에 내부 파일을 실측 확인한다", why: "배포마다 되풀이되는 사고 유형을 막는 관통 지침", refs: ["rebut:oos-1"], recommend: "관련", explain }, over || {}); // refs 기본=신호 1개(2026-09-06: refs 없는 제안은 거부)
const out = (arr) => JSON.stringify({ proposals: arr });
// 2026-09-06: refs 필수 — 신호 0인 픽스처에서 제안 파싱·커밋을 시험하려면 되받아침 신호 1건(rebut:oos-1)을 먼저 심는다(현재 캠페인=그 저장소 — ab-1 수용 조건)
const seedRebutSignal = (ws, repo, tag) => { const rk = CL.repoKeyOf(repo); fs.mkdirSync(path.dirname(CL.campaignFileFor(ws)), { recursive: true }); fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId: "c-" + tag, count: 1, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repoKey: rk })); CL.appendFindingsLedger(ws, [{ type: "disposition", campaignId: "c-" + tag, findingId: "f-" + tag, choice: "rebut", oosId: "oos-1", asOfRound: 1, ts: new Date().toISOString() }]); };

t("팔 결정=탐색 담당 유효 팔(2026-09-06 개정 · 2026-09-17 모드 기본): 미설정=모드 기본(claude-codex=self·codex-codex=codex) · scoutArm codex=codex · deepseek는 키 파일 없으면 self 강등·있으면 deepseek — harnessMode·환경변수 무관", () => {
  assert.strictEqual(CU.selectorArmForCuration(WS, { harnessMode: "codex-codex" }), "codex", "운용 모드가 팔을 직접 정하진 않되, 탐색 담당 미설정의 기본이 모드 기본을 따른다(2026-09-17 개정: C-C=codex — claude CLI 보장 없음) → 정리 담당도 그 유효 팔");
  assert.strictEqual(CU.selectorArmForCuration(WS, { harnessMode: "claude-codex" }), "self", "Claude-Codex 미설정=self(무회귀)");
  const keyFile = path.join(HOME, "deepseek.json");
  try {
    assert.ok(CL.updateContractPatch(WS, "ko", { scoutArm: "codex" }).ok);
    assert.strictEqual(CU.selectorArmForCuration(WS, { harnessMode: "claude-codex" }), "codex", "탐색 담당 codex=정리 담당도 codex(정찰 두뇌 설정 공유)");
    process.env.CODEX_THREAD_ID = "x"; try { assert.strictEqual(CU.selectorArmForCuration(WS, null), "codex", "환경변수는 팔을 바꾸지 않는다"); } finally { delete process.env.CODEX_THREAD_ID; }
    assert.ok(CL.updateContractPatch(WS, "ko", { scoutArm: "deepseek" }).ok);
    fs.rmSync(keyFile, { force: true });
    assert.strictEqual(CU.selectorArmForCuration(WS, null), "self", "키 없는 DeepSeek=self 강등(scoutArmView eff와 동일)");
    fs.writeFileSync(keyFile, JSON.stringify({ apiKey: "sk-test-not-real" }));
    assert.strictEqual(CU.selectorArmForCuration(WS, null), "deepseek", "키 있으면 deepseek");
  } finally { fs.rmSync(keyFile, { force: true }); assert.ok(CL.updateContractPatch(WS, "ko", { scoutArm: "self" }).ok); }
});

t("입력 집계기 — 실패 정직 보고: repo 불일치·수칙서 비활성·미승인 변경·도장 없는 서고 파일", () => {
  assert.strictEqual(CU.curationInput(WS, WS).reason, "repo-mismatch", "정찰 대상이 아닌 폴더=거부(ab-1)");
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws2-"));
  assert.strictEqual(CU.curationInput(WS2, WS2).reason, "envelope-inactive");
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), coreRaw + "\n");
  assert.strictEqual(CU.curationInput(WS, REPO).reason, "envelope-drift");
  fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), coreRaw);
  const REPO3 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo3-")); const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws3-"));
  fs.writeFileSync(path.join(REPO3, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS3, CORE_HASH); CL.updateContractPatch(WS3, "ko", { scoutRepo: REPO3 });
  fs.writeFileSync(path.join(REPO3, CL.ARCHIVE_FILE), arcRaw); // 도장(archiveHash) 없이 서고 파일만 존재
  assert.strictEqual(CU.curationInput(WS3, REPO3).reason, "archive-unstamped");
});

t("입력 집계기 — 정상: 코어·서고 항목(axis·index·itemFp)·신호(미사용 수칙=영수증 합집합·되받아침·선별 초과)·결정 장부·시각 없는 입력 지문(멱등)", () => {
  const i0 = CU.curationInput(WS, REPO);
  assert.ok(i0.ok && i0.signalCount === 0 && i0.rules.core.length === 3 && i0.rules.archive.length === 3, JSON.stringify(i0).slice(0, 300));
  assert.strictEqual(i0.rules.core[2].itemFp, sha1(CL.normBacklogTitle("다중 서버 동시 배포")), "itemFp=정규화 문안 sha1(초안 관문 규칙과 동일)");
  assert.strictEqual(i0.rules.archive[1].id, "arc-2");
  assert.strictEqual(i0.signals.unusedRules.length, 0, "선별 관측 0건이면 '미사용'을 주장하지 않는다");
  // 선별 영수증 2건(미리보기+검증 선별) — arc-1·arc-3만 선택됨 → arc-2 미사용
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  CL.appendSelectorUsage({ ts: old, wsKey: WSKEY, repoKey: REPOKEY, askId: "", purpose: "preview", turnAnchor: "t1", archiveHash: ARC_HASH, selectedIds: ["arc-1"], arm: "self" });
  CL.appendSelectorUsage({ ts: new Date().toISOString(), wsKey: WSKEY, repoKey: REPOKEY, askId: "ask-1", turnAnchor: "t2", archiveHash: ARC_HASH, selectedIds: ["arc-3"], arm: "self" });
  CL.appendSelectorUsage({ ts: new Date().toISOString(), wsKey: WSKEY, repoKey: "0000000000000000", askId: "ask-9", turnAnchor: "t9", archiveHash: ARC_HASH, selectedIds: ["arc-2"], arm: "self" }); // 같은 서고 지문·다른 저장소의 영수증=불산입(ab-1)
  CL.appendSelectorUsage({ ts: new Date().toISOString(), wsKey: WSKEY, askId: "", purpose: "curate", turnAnchor: "k", archiveHash: ARC_HASH, selectedIds: ["arc-2"], arm: "self" }); // 큐레이션 영수증은 '사용' 아님
  fs.mkdirSync(path.dirname(CL.campaignFileFor(WS)), { recursive: true }); fs.writeFileSync(CL.campaignFileFor(WS), JSON.stringify({ schema: "vcamp-1", campaignId: "c1", count: 1, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repoKey: REPOKEY })); // 현재 캠페인=이 저장소(ab-1)
  assert.ok(CL.appendFindingsLedger(WS, [
    { type: "disposition", campaignId: "c1", findingId: "f1", choice: "rebut", oosId: "oos-1", asOfRound: 1, ts: new Date().toISOString() },
    { type: "disposition", campaignId: "c1", findingId: "f8", choice: "rebut", oosId: "oos-9", asOfRound: 1, repoKey: "0000000000000000", ts: new Date().toISOString() }, // ★같은 캠페인 id라도 기록 시점 저장소 표식이 다르면 불산입(ab-1 — 창 교대로 한 캠페인이 두 저장소에 속하는 반례)
  ]));
  fs.mkdirSync(path.dirname(CL.ATTACH_USAGE_FILE), { recursive: true });
  fs.appendFileSync(CL.ATTACH_USAGE_FILE, JSON.stringify({ ts: new Date().toISOString(), ws: WS, repoKey: "0000000000000000", askId: "a0", items: [], envelope: { hash: CORE_HASH, sup: [], ab: [], oos: [] }, selOver: { items: true, count: 13 } }) + "\n"); // 같은 세대 지문·다른 저장소의 초과 행=제외(ab-1)
  fs.appendFileSync(CL.ATTACH_USAGE_FILE, JSON.stringify({ ts: new Date().toISOString(), ws: WS, repoKey: REPOKEY, askId: "a", items: [], envelope: { hash: CORE_HASH, sup: [], ab: [], oos: [] }, selOver: { items: true, count: 13 } }) + "\n");
  const od = CL.openDecision(WS, { origin: "implementer", kind: "boundary", noDefault: "범위표는 구현자가 정할 수 없는 사용자 방향입니다", campaignId: "c1", sourceAsk: "ask-1", targetFp: "fp1", question: "동시 배포를 범위에 넣을까요?", why: "반복 지적", choices: [{ key: "in", label: "넣기" }, { key: "out", label: "빼기" }] });
  assert.ok(od && od.ok, "결정 항목 생성: " + JSON.stringify(od));
  const i1 = CU.curationInput(WS, REPO);
  assert.ok(i1.ok, JSON.stringify(i1));
  assert.deepStrictEqual(i1.signals.unusedRules.map((x) => x.itemId), ["arc-2"]);
  assert.ok(i1.signals.unusedRules[0].receipts === 2 && i1.signals.unusedRules[0].days >= 39, JSON.stringify(i1.signals.unusedRules));
  assert.deepStrictEqual(i1.signals.rebutUsed, [{ id: "rebut:oos-1", oosId: "oos-1", n: 1 }]);
  assert.strictEqual(i1.signals.selOver.count, 1);
  const odOther = CL.openDecision(WS, { origin: "implementer", kind: "product", noDefault: "다른 저장소의 제품 방향은 이 저장소가 정할 수 없습니다", campaignId: "c1", sourceAsk: "ask-x", targetFp: "fpx", question: "다른 프로젝트 결정입니다", why: "타 저장소", choices: [{ key: "a", label: "가" }, { key: "b", label: "나" }], repoKey: "0000000000000000" }); // ★같은 캠페인 id·다른 저장소 표식(창 교대 반례)
  assert.ok(odOther && odOther.ok, "다른 저장소 표식의 결정 생성");
  assert.strictEqual(CL.readDecisions(WS).latest.get(od.decisionId).repoKey, REPOKEY, "결정 행에 기록 시점 repoKey가 심긴다");
  assert.ok(CL.readFindingsLedger(WS).filter((r) => r.type === "disposition" && r.findingId === "f1").every((r) => r.repoKey === REPOKEY), "지적 장부 append 관문이 repoKey를 심는다");
  const i1b = CU.curationInput(WS, REPO, { computeCandidates: () => ({ gen: CL.loadContract(WS).envelopeHash, signals: [] }) });
  assert.ok(i1b.ok && i1b.decisions.open.every((x) => x.decisionId !== odOther.decisionId), "★다른 저장소 캠페인의 결정=입력에서 제외(ab-1)");
  assert.ok(!CU.buildCurationPrompt(i1b, "ko").includes("다른 프로젝트 결정입니다"), "프롬프트에도 없음");
  assert.ok(i1.decisions.open.length === 1 && /동시 배포/.test(i1.decisions.open[0].question));
  assert.strictEqual(i1.signalCount, 3);
  const i2 = CU.curationInput(WS, REPO);
  assert.strictEqual(i1.inputFp, i2.inputFp, "같은 장부=같은 지문(시각 성분 없음)");
  assert.strictEqual(CU.curationKeyOf(i1), CU.curationKeyOf(i2));
  assert.ok(!JSON.stringify(i1).includes(REPO), "입력에 경로 원문 없음(repoKey 지문만)");
});

t("파서 — 손상=전량 거부(JSON 아님·3건 초과·작업 종류·why 형식·explain 누락) · 의미 거부=항목 탈락 기록(중복·미지 refs·대상 불일치·민감 why) · toggle=보류 · add/oos-add/remove 정상", () => {
  const input = CU.curationInput(WS, REPO);
  assert.strictEqual(CU.parseCurationOutput("아무 말", input).reason, "no-json");
  assert.strictEqual(CU.parseCurationOutput(out([good(), good({ title: "b" }), good({ title: "c" }), good({ title: "d" })]), input).reason, "too-many");
  assert.strictEqual(CU.parseCurationOutput(out([good({ operation: "merge" })]), input).reason, "bad-operation");
  assert.strictEqual(CU.parseCurationOutput(out([good({ why: "짧음" })]), input).reason, "bad-why");
  assert.strictEqual(CU.parseCurationOutput(out([good({ explain: undefined })]), input).reason, "no-explain");
  assert.strictEqual(CU.parseCurationOutput(out([good({ explain: { happened: "a" } })]), input).reason, "bad-explain");
  const sem = CU.parseCurationOutput(out([
    good({ title: "배포 전 백업을 남긴다" }),                                  // 서고 기등재=중복
    good({ title: "새 문안 1", refs: ["없는-신호"] }),                         // 미지 refs
    good({ operation: "remove", target: "archive", index: 1, itemFp: "0".repeat(40) }), // 지문 불일치
  ]), input);
  assert.ok(sem.ok && sem.items.length === 0 && sem.dropped.map((d) => d.reason).join() === "duplicate,unknown-ref,target-mismatch", JSON.stringify(sem));
  const sens = CU.parseCurationOutput(out([good({ why: "토큰 sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 를 쓴다" })]), input);
  assert.ok(sens.ok && sens.items.length === 0 && /why-sensitive/.test(sens.dropped[0].reason), JSON.stringify(sens.dropped));
  const arc2 = input.rules.archive[1];
  const okp = CU.parseCurationOutput(out([
    good({ refs: ["rebut:oos-1", "selover"] }),
    good({ operation: "oos-add", title: "외부 결제 연동은 범위 밖", why: "제품 방향상 다루지 않는 영역을 명시하는 관통 지침" }),
    good({ operation: "toggle", target: "archive", index: arc2.index, itemFp: arc2.itemFp, why: "항상 적용해야 할 성격이라 코어로 올릴 후보" }),
  ]), input);
  assert.ok(okp.ok && okp.items.length === 2 && okp.held.length === 1 && okp.items[1].target === "core" && okp.items[1].axis === "outOfScope" && okp.held[0].title === arc2.text, JSON.stringify(okp));
  const rm = CU.parseCurationOutput(out([good({ operation: "remove", target: "archive", index: arc2.index, itemFp: arc2.itemFp, refs: ["unused-rule:arc-2"] })]), input);
  assert.ok(rm.ok && rm.items.length === 1 && rm.items[0].operation === "remove" && rm.items[0].occurrence === "alwaysBlocker#1" && rm.items[0].title === arc2.text, JSON.stringify(rm));
  // 2026-09-06 개정: 근거 없는 제안 거부 · 코드 울타리 1겹 허용(그 안은 JSON 객체 하나뿐) · 산문 섞임·2겹은 여전히 손상
  const noref = CU.parseCurationOutput(out([good({ refs: [] })]), input);
  assert.ok(noref.ok && noref.items.length === 0 && noref.dropped.length === 1 && noref.dropped[0].reason === "no-ref", "refs 빈 배열=항목 탈락(no-ref) " + JSON.stringify(noref));
  const fenced = CU.parseCurationOutput("```json\n" + out([]) + "\n```", input);
  assert.ok(fenced.ok && fenced.items.length === 0, "울타리 1겹 안 빈 제안=정상(실측 실패 재현 봉합) " + JSON.stringify(fenced));
  const fencedCrlf = CU.parseCurationOutput("```json\r\n" + out([good()]) + "\r\n```\r\n", input);
  assert.ok(fencedCrlf.ok && fencedCrlf.items.length === 1, "CRLF 울타리도 1겹 벗김 " + JSON.stringify(fencedCrlf));
  assert.ok(CU.parseCurationOutput("```\n" + out([]) + "\n```", input).ok, "언어 표기 없는 울타리도 허용");
  assert.strictEqual(CU.parseCurationOutput("여기 결과입니다\n```json\n" + out([]) + "\n```", input).reason, "no-json", "울타리 앞 산문=손상");
  assert.strictEqual(CU.parseCurationOutput("```json\n" + out([]) + "\n```\n끝", input).reason, "no-json", "울타리 뒤 산문=손상");
  assert.strictEqual(CU.parseCurationOutput("```json\n```json\n" + out([]) + "\n```\n```", input).reason, "no-json", "울타리 2겹=손상(1겹만 허용)");
});

t("생략 규칙 — 신호 0=항상 생략(첫 실행 포함·2026-09-06 개정) · 신호 있으면 실행 · 같은 입력 표의 결과가 있으면 멱등 생략", () => {
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws4-")); const REPO4 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo4-"));
  fs.writeFileSync(path.join(REPO4, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS4, CORE_HASH); CL.updateContractPatch(WS4, "ko", { scoutRepo: REPO4 });
  const i4 = CU.curationInput(WS4, REPO4); assert.ok(i4.ok && i4.signalCount === 0);
  assert.deepStrictEqual(CU.curationSkip(WS4, i4), { skip: true, reason: "no-signal" }, "재료 0=첫 실행이라도 무호출(2026-09-06 개정 — 지난 실행 기록·세대 무관)");
  CU.appendCurationRow(WS4, { type: "run", repoKey: i4.repoKey, boundaryGen: CORE_HASH, archiveGen: "", outcome: "none" });
  assert.deepStrictEqual(CU.curationSkip(WS4, i4), { skip: true, reason: "no-signal" });
  CU.appendCurationRow(WS4, { type: "result", repoKey: i4.repoKey, curationKey: CU.curationKeyOf(i4), boundaryGen: CORE_HASH, archiveGen: "", resultFp: "x", items: [] }); // --force로 만든 같은 키 결과 행
  assert.deepStrictEqual(CU.curationSkip(WS4, i4), { skip: true, reason: "no-signal" }, "★1판 blocker: 신호 0이면 같은 키 결과 행이 있어도 사유는 no-signal(same-input보다 먼저)");
  const i1 = CU.curationInput(WS, REPO); assert.strictEqual(CU.curationSkip(WS, i1).skip, false, "신호 3건=실행");
  CU.appendCurationRow(WS, { type: "result", repoKey: i1.repoKey, curationKey: CU.curationKeyOf(i1), boundaryGen: CORE_HASH, archiveGen: ARC_HASH, resultFp: "x", items: [] });
  assert.deepStrictEqual(CU.curationSkip(WS, i1), { skip: true, reason: "same-input" });
  fs.rmSync(CU.curationFileFor(WS), { force: true }); // 이후 시험을 위해 결과 행 제거
});

let firstIds = null, gen1Input = null;
function sameAnswer() { const arc2 = gen1Input.rules.archive[1]; return [good({ refs: ["rebut:oos-1"] }), good({ operation: "oos-add", title: "외부 결제 연동은 범위 밖", why: "제품 방향상 다루지 않는 영역을 명시하는 관통 지침" }), good({ operation: "remove", target: "archive", index: arc2.index, itemFp: arc2.itemFp, refs: ["unused-rule:arc-2"] })]; }

async function main() {
  await ta("실행기 — 가짜 페이지 실행기로 완주: 2단 커밋(provisional→결과 행→proposed)·영수증(purpose curate·turnAnchor=curationKey·selectedIds=후보 id)·미승인 수", async () => {
    const input = CU.curationInput(WS, REPO); gen1Input = input;
    const arc2 = input.rules.archive[1];
    const r = await CU.runCuration(WS, { pageRunner: fake(out([
      good({ refs: ["rebut:oos-1"] }),
      good({ operation: "oos-add", title: "외부 결제 연동은 범위 밖", why: "제품 방향상 다루지 않는 영역을 명시하는 관통 지침" }),
      good({ operation: "remove", target: "archive", index: arc2.index, itemFp: arc2.itemFp, refs: ["unused-rule:arc-2"] }),
    ])) });
    assert.ok(r.st === "ok" && r.proposed === 3 && r.candidateIds.length === 3 && r.pending === 3 && r.arm === "self" && r.receipt === true, JSON.stringify(r));
    firstIds = r.candidateIds;
    const raw = fs.readFileSync(CL.envelopeCandidatesFileFor(WS), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const mine = raw.filter((x) => firstIds.includes(x.candidateId));
    assert.strictEqual(mine.filter((x) => x.status === "provisional").length, 3, "1단 provisional 행");
    assert.strictEqual(mine.filter((x) => x.status === "proposed").length, 3, "3단 proposed 행");
    assert.ok(raw.findIndex((x) => x.status === "provisional") < raw.findIndex((x) => x.status === "proposed"), "순서: provisional 뒤에 proposed");
    const { latest } = CL.readEnvelopeCandidates(WS);
    for (const id of firstIds) { const c9 = latest.get(id + "@" + CORE_HASH); assert.ok(c9 && c9.status === "proposed" && c9.kind === "curator" && c9.repoKey === REPOKEY && c9.title && c9.why && c9.explain && c9.curationKey === r.curationKey, JSON.stringify(c9)); }
    const rm9 = [...latest.values()].find((c9) => firstIds.includes(c9.candidateId) && c9.operation === "remove");
    assert.ok(rm9.index === 1 && rm9.itemFp === arc2.itemFp && rm9.expectedTargetHash === ARC_HASH && rm9.target === "archive", "빼기 후보=제안 시점 번호+항목 지문+대상 세대 3중 결속");
    const rows = CU.readCurationRows(WS);
    const res = rows.find((x) => x.type === "result"); const run = rows.find((x) => x.type === "run");
    assert.ok(res && res.curationKey === r.curationKey && res.items.length === 3 && res.resultFp === r.resultFp && run && run.outcome === "proposed" && run.proposed === 3, JSON.stringify(rows));
    const rc = CL.readSelectorUsage().find((x) => x.purpose === "curate" && x.turnAnchor === r.curationKey);
    assert.ok(rc && rc.wsKey === WSKEY && rc.repoKey === REPOKEY && rc.archiveHash === ARC_HASH && rc.envelopeHash === CORE_HASH && rc.selectedIds.length === 3 && rc.outcome === "proposed:3", JSON.stringify(rc));
    assert.strictEqual(CU.curationPendingCount(WS, REPOKEY, CORE_HASH), 3);
    CL.freezeEnvelopeForAsk(WS, REPO, "ko"); // 대시보드 목록은 동결 세대=승인 세대일 때만(기존 계약) — 캠페인 동결을 흉내
    const CB = require("../bridge/codex-bridge.js");
    const live = CB.computeEnvelopeCandidatesFor(WS).live.filter((c9) => c9.kind === "curator");
    assert.ok(live.length === 3 && live.every((c9) => c9.why && c9.operation) && live.some((c9) => c9.operation === "remove" && c9.titles[0] === arc2.text), "대시보드 후보 목록에 합류(kind curator·operation·why)");
  });

  await ta("실행기 — 같은 입력 재실행=멱등 생략(same-input) · --force 재실행도 같은 후보 id=행 재기록 없음", async () => {
    const before = fs.readFileSync(CL.envelopeCandidatesFileFor(WS), "utf8");
    const r1 = await CU.runCuration(WS, { pageRunner: fake(out([good()])) });
    assert.ok(r1.st === "skipped" && r1.reason === "same-input", JSON.stringify(r1));
    const arc2 = gen1Input.rules.archive[1];
    const same = sameAnswer();
    const r2 = await CU.runCuration(WS, { force: true, pageRunner: fake(out(same)) });
    assert.ok(r2.st === "ok" && r2.candidateIds.length === 0 && r2.proposed === 3, "같은 답=같은 후보 id·신규 0 · " + JSON.stringify(r2));
    assert.strictEqual(fs.readFileSync(CL.envelopeCandidatesFileFor(WS), "utf8"), before, "후보 장부 무변(멱등)");
    const rows = CU.readCurationRows(WS).filter((x) => x.type === "result");
    assert.ok(rows.length === 2 && rows[0].resultFp === rows[1].resultFp, "결과 행은 실행마다 남되 같은 resultFp");
    // 같은 입력 표(curationKey)에 다른 결과=fail-closed(설계 §3 D ④) — 첫 결과가 권위·장부 무변·경보
    const r3 = await CU.runCuration(WS, { force: true, pageRunner: fake(out(same.slice(0, 2))) });
    assert.ok(r3.st === "commit-failed" && r3.reason === "result-conflict", JSON.stringify(r3));
    assert.strictEqual(fs.readFileSync(CL.envelopeCandidatesFileFor(WS), "utf8"), before, "충돌=후보 장부 무변");
    assert.ok(CL.readIntegrityEvents().some((e) => e.kind === "curation-failed" && !e.ack), "충돌 경보");
  });

  await ta("미승인 상한 6 — 초과분은 보류(deferred)·영수증만 · 회당 3건 상한", async () => {
    const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws5-")); const REPO5 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo5-"));
    fs.writeFileSync(path.join(REPO5, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS5, CORE_HASH); CL.updateContractPatch(WS5, "ko", { scoutRepo: REPO5 });
    const rk5 = CL.repoKeyOf(REPO5);
    CL.appendEnvelopeCandidates(WS5, Array.from({ length: 5 }, (_, i) => ({ candidateId: sha1("seed" + i).slice(0, 16), envelopeHash: CORE_HASH, status: "proposed", kind: "curator", repoKey: rk5, operation: "add", target: "archive", axis: "alwaysBlocker", title: "씨앗 " + i, why: "씨앗 근거 문장입니다", ts: new Date().toISOString() })));
    // 2026-09-06: refs 필수라 제안이 가리킬 신호(rebut:oos-1)가 먼저 있어야 함 — 현재 캠페인=이 저장소(되받아침 신호 수용 조건 — ab-1)
    fs.mkdirSync(path.dirname(CL.campaignFileFor(WS5)), { recursive: true }); fs.writeFileSync(CL.campaignFileFor(WS5), JSON.stringify({ schema: "vcamp-1", campaignId: "c1", count: 1, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repoKey: rk5 }));
    CL.appendFindingsLedger(WS5, [{ type: "disposition", campaignId: "c1", findingId: "f9", choice: "rebut", oosId: "oos-1", asOfRound: 1, ts: new Date().toISOString() }]);
    const r = await CU.runCuration(WS5, { force: true, pageRunner: fake(out([good({ title: "새 1" }), good({ title: "새 2" }), good({ title: "새 3" })])) });
    assert.ok(r.st === "ok" && r.proposed === 1 && r.deferred === 2 && r.pending === 6, JSON.stringify(r));
    CL.appendFindingsLedger(WS5, [{ type: "disposition", campaignId: "c1", findingId: "f10", choice: "rebut", oosId: "oos-1", asOfRound: 2, ts: new Date().toISOString() }]); // 신호 변화(rebut:oos-1 ×1→×2)=새 입력 표(같은 표에 다른 답은 충돌 규칙)
    const r2 = await CU.runCuration(WS5, { force: true, pageRunner: fake(out([good({ title: "새 4" })])) });
    assert.ok(r2.st === "ok" && r2.proposed === 0 && r2.deferred === 1 && r2.pending === 6, "상한 도달=제안 0·보류 " + JSON.stringify(r2));
    const rc = CL.readSelectorUsage().filter((x) => x.purpose === "curate" && x.wsKey === CL.wsKeyFor(WS5));
    assert.ok(rc.length === 2 && rc[1].outcome === "none", "제안 없음도 영수증");
    assert.strictEqual(CU.curationSummary(WS5).pending, 6);
  });

  await ta("실패=영수증+경보(curation-failed)·후보 무변 · 파서 전량 거부도 같은 길 · 검증 장부 무접촉", async () => {
    const before = fs.readFileSync(CL.envelopeCandidatesFileFor(WS), "utf8");
    const r = await CU.runCuration(WS, { force: true, pageRunner: fake("", "call-failed") });
    assert.ok(r.st === "call-failed", JSON.stringify(r));
    const r2 = await CU.runCuration(WS, { force: true, pageRunner: fake("{\"proposals\": \"no\"}") });
    assert.ok(r2.st === "parse-failed" && r2.reason === "no-proposals-array", JSON.stringify(r2));
    assert.strictEqual(fs.readFileSync(CL.envelopeCandidatesFileFor(WS), "utf8"), before);
    const ev = CL.readIntegrityEvents().filter((e) => e.kind === "curation-failed" && !e.ack);
    assert.strictEqual(ev.length, 1, "같은 종류 경보는 대체(supersede) — 누적 아님");
    const rc = CL.readSelectorUsage().filter((x) => x.purpose === "curate" && x.wsKey === WSKEY).slice(-2);
    assert.ok(/^failed:call-failed/.test(rc[0].outcome) && /^parse-failed:/.test(rc[1].outcome), rc.map((x) => x.outcome).join());
    assert.strictEqual(CL.readFindingsLedger(WS).filter((x) => x.type !== "disposition").length, 0, "검증 장부 무접촉");
  });

  await ta("잠금 — 산 소유자=거부(running) · 죽은 소유자=회수 후 실행 · 정상 종료 시 해제", async () => {
    const lf = CU.curateLockFileFor(WS);
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "live" }));
    const r = await CU.runCuration(WS, { force: true, pageRunner: fake(out(sameAnswer())) });
    assert.ok(r.st === "locked" && r.reason === "running", JSON.stringify(r));
    fs.writeFileSync(lf, JSON.stringify({ pid: 2147483000, ts: new Date().toISOString(), token: "dead" }));
    const r2 = await CU.runCuration(WS, { force: true, pageRunner: fake(out(sameAnswer())) });
    assert.ok(r2.st === "ok" && r2.candidateIds.length === 0, "죽은 소유자 회수 후 실행 " + JSON.stringify(r2));
    assert.ok(!fs.existsSync(lf), "정상 종료=잠금 해제");
    assert.ok(fs.readdirSync(path.dirname(lf)).some((f) => f.startsWith(path.basename(lf) + ".stale-")), "죽은 잠금은 격리(rename)");
  });

  await ta("승인 변환 — add→서고 초안(문안 포함·후보 adopted) · oos-add→코어 제외 칸 초안 · toggle=거부 · 복원형 폐기=proposed 복귀", async () => {
    const { latest } = CL.readEnvelopeCandidates(WS);
    const byOp = (op) => [...latest.values()].find((c9) => firstIds.includes(c9.candidateId) && c9.operation === op);
    const add = byOp("add"), oos = byOp("oos-add");
    const d1 = CL.draftCuratorCandidate(WS, REPO, add.candidateId, CORE_HASH);
    assert.ok(d1.ok && d1.target === "archive" && d1.adds === 1, JSON.stringify(d1));
    let pr = CL.readEnvelopeProposal(WS, REPO);
    assert.ok(pr.st === "ok" && pr.target === "archive" && JSON.parse(pr.proposalText).alwaysBlocker.includes(add.title) && pr.candidateIds.includes(add.candidateId));
    assert.strictEqual(CL.readEnvelopeCandidates(WS).latest.get(add.candidateId + "@" + CORE_HASH).status, "adopted");
    const ds = CL.discardEnvelopeProposalRestoring(WS, pr.draftId); // 신원 토큰=draftId(기존 계약)
    assert.ok(ds.ok && CL.readEnvelopeCandidates(WS).latest.get(add.candidateId + "@" + CORE_HASH).status === "proposed", "복원형 폐기=proposed 복귀");
    // 취소(복원) 뒤 재승인 — 복원 행이 연산 필드를 승계해 변환이 다시 가능해야 한다(실측 결함 봉합)
    const restored = CL.readEnvelopeCandidates(WS).latest.get(add.candidateId + "@" + CORE_HASH);
    assert.ok(restored.operation === "add" && restored.target === "archive" && restored.explain, "복원 행 연산 필드 승계 " + JSON.stringify(restored));
    const dAgain = CL.draftCuratorCandidate(WS, REPO, add.candidateId, CORE_HASH);
    assert.ok(dAgain.ok && dAgain.target === "archive", "취소 뒤 재승인 가능 " + JSON.stringify(dAgain));
    assert.ok(CL.discardEnvelopeProposalRestoring(WS, CL.readEnvelopeProposal(WS, REPO).draftId).ok);
    const d2 = CL.draftCuratorCandidate(WS, REPO, oos.candidateId, CORE_HASH);
    assert.ok(d2.ok && d2.target === "core" && d2.adds === 1, JSON.stringify(d2));
    pr = CL.readEnvelopeProposal(WS, REPO);
    const inner = JSON.parse(pr.proposalText);
    assert.ok(pr.target === "core" && inner.outOfScope.includes(oos.title) && !inner.alwaysBlocker.includes(oos.title), "제외 칸(outOfScope)에만 추가·ab축 무접촉");
    assert.ok(CL.discardEnvelopeProposalRestoring(WS, pr.draftId).ok);
    const tg = CL.appendEnvelopeCandidates(WS, [{ candidateId: sha1("tg").slice(0, 16), envelopeHash: CORE_HASH, status: "proposed", kind: "curator", repoKey: REPOKEY, operation: "toggle", target: "archive", axis: "alwaysBlocker", index: 0, itemFp: gen1Input.rules.archive[0].itemFp, expectedTargetHash: ARC_HASH, title: gen1Input.rules.archive[0].text, why: "전환 후보 근거", ts: new Date().toISOString() }]);
    assert.ok(tg);
    const d3 = CL.draftCuratorCandidate(WS, REPO, sha1("tg").slice(0, 16), CORE_HASH);
    assert.ok(!d3.ok && /2차/.test(d3.error), JSON.stringify(d3));
    CL.appendEnvelopeCandidates(WS, [{ candidateId: sha1("tg").slice(0, 16), envelopeHash: CORE_HASH, status: "declined", note: "test cleanup", ts: new Date().toISOString() }]);
  });

  await ta("승인 변환 — remove: 3중 대조(대상 세대 불일치=거부) · 정상=항목 빠진 서고 초안+sourceCandidateIds 결속(adopted) · 도장=applied 종결·미승인 수 제외·조정 스캔이 되살리지 않음", async () => {
    const { latest } = CL.readEnvelopeCandidates(WS);
    const rm = [...latest.values()].find((c9) => firstIds.includes(c9.candidateId) && c9.operation === "remove");
    const badId = sha1("bad-rm").slice(0, 16);
    CL.appendEnvelopeCandidates(WS, [Object.assign({}, rm, { candidateId: badId, status: "proposed", expectedTargetHash: "f".repeat(40), ts: new Date().toISOString() })]);
    const db = CL.draftCuratorCandidate(WS, REPO, badId, CORE_HASH);
    assert.ok(!db.ok && /대상 판 불일치/.test(db.error), "제안 시점 대상 세대≠현재=거부 · " + JSON.stringify(db));
    CL.appendEnvelopeCandidates(WS, [{ candidateId: badId, envelopeHash: CORE_HASH, status: "declined", note: "test cleanup", ts: new Date().toISOString() }]);
    const d = CL.draftCuratorCandidate(WS, REPO, rm.candidateId, CORE_HASH);
    assert.ok(d.ok && d.target === "archive" && d.removes === 1 && d.adds === 0, JSON.stringify(d));
    const pr = CL.readEnvelopeProposal(WS, REPO);
    const inner = JSON.parse(pr.proposalText);
    assert.ok(inner.alwaysBlocker.length === 2 && !inner.alwaysBlocker.includes(rm.title) && pr.candidateIds.includes(rm.candidateId), "빼기 반영·출처 후보가 제안 파일에 결속");
    assert.strictEqual(CL.readEnvelopeCandidates(WS).latest.get(rm.candidateId + "@" + CORE_HASH).status, "adopted");
    assert.strictEqual(CU.curationPendingCount(WS, REPOKEY, CORE_HASH), 2, "승인된 빼기는 미승인 수에서 빠짐");
    const tr = CL.applyEnvelopeTransition(WS, REPO, "ko", null);
    assert.ok(tr.ok && tr.newHash === pr.newHash, JSON.stringify(tr));
    const arcNow = CL.readVerifyEnvelopeArchive(REPO);
    assert.ok(arcNow.st === "ok" && arcNow.data.alwaysBlocker.length === 2 && CL.loadContract(WS).archiveHash === tr.newHash);
    const fin = CL.readEnvelopeCandidates(WS).latest.get(rm.candidateId + "@" + CORE_HASH);
    assert.ok(fin.status === "adopted" && fin.applied === tr.newHash, "도장 시 applied 종결 " + JSON.stringify(fin));
    assert.strictEqual(CL.readEnvelopeProposal(WS, REPO).st, "absent");
    CL.reconcileMemoryCandidates(WS, REPO, CORE_HASH);
    const after = CL.readEnvelopeCandidates(WS).latest.get(rm.candidateId + "@" + CORE_HASH);
    assert.ok(after.status === "adopted" && after.applied === tr.newHash, "조정 스캔이 고아 복원으로 되살리지 않음(applied)");
    assert.strictEqual(CU.curationPendingCount(WS, REPOKEY, CORE_HASH), 2);
    const CB = require("../bridge/codex-bridge.js");
    assert.ok(!CB.computeEnvelopeCandidatesFor(WS).live.some((c9) => c9.candidateId === rm.candidateId), "화면 목록에서도 사라짐");
    // 같은 서고 세대에 결속된 다른 remove 후보가 있었다면 다음 실행에서 재발급 대상(입력 지문이 바뀜)
    const i2 = CU.curationInput(WS, REPO);
    assert.ok(i2.ok && i2.archiveGen === tr.newHash && i2.inputFp !== gen1Input.inputFp, "서고 세대 변경=새 입력 지문");
  });

  await ta("세대 이월 — 코어 재승인 뒤 curator add/oos-add는 1회 이월(proposed) · 코어 빼기 제안은 정리(declined·재발급 대상) · applied 종결분은 이월 없음", async () => {
    const rowsAll = CL.readEnvelopeCandidates(WS).rows;
    const add = rowsAll.find((c9) => firstIds.includes(c9.candidateId) && c9.operation === "add");
    const coreRm = sha1("core-rm").slice(0, 16);
    CL.appendEnvelopeCandidates(WS, [{ candidateId: coreRm, envelopeHash: CORE_HASH, status: "proposed", kind: "curator", repoKey: REPOKEY, operation: "remove", target: "core", axis: "outOfScope", index: 0, itemFp: gen1Input.rules.core[2].itemFp, expectedTargetHash: CORE_HASH, title: gen1Input.rules.core[2].text, why: "코어 빼기 후보 근거", ts: new Date().toISOString() }]);
    const core2 = JSON.stringify(Object.assign({}, coreObj, { supportedEnv: ["윈도우 로컬 단일 사용자", "리눅스 CI"] }), null, 1);
    fs.writeFileSync(path.join(REPO, CL.ENVELOPE_FILE), core2);
    const GEN2 = sha1(core2);
    assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, GEN2), 2);
    CL.reconcileMemoryCandidates(WS, REPO, GEN2);
    const l2 = CL.readEnvelopeCandidates(WS).latest;
    const a2 = l2.get(add.candidateId + "@" + GEN2);
    assert.ok(a2 && a2.status === "proposed" && a2.kind === "curator" && a2.operation === "add" && a2.title === add.title && a2.explain && a2.repoKey === REPOKEY, "add 이월(필드 보존) " + JSON.stringify(a2));
    const r2 = l2.get(coreRm + "@" + GEN2);
    assert.ok(r2 && r2.status === "declined" && /대상 세대 변경/.test(r2.note), "코어 빼기 제안=정리 " + JSON.stringify(r2));
    const rmId = CL.readEnvelopeCandidates(WS).rows.find((x) => firstIds.includes(x.candidateId) && x.operation === "remove").candidateId; // 종결 행(applied)은 메타를 싣지 않음 — id로 조회
    const rmOld = l2.get(rmId + "@" + CORE_HASH);
    assert.ok(rmOld && rmOld.applied && !l2.has(rmOld.candidateId + "@" + GEN2), "applied 종결분은 새 세대 행 없음");
    CL.reconcileMemoryCandidates(WS, REPO, GEN2);
    assert.strictEqual(CL.readEnvelopeCandidates(WS).rows.filter((x) => x.candidateId === add.candidateId && String(x.envelopeHash) === GEN2).length, 1, "이월은 정확히 1회");
  });

  await ta("CLI curate — status/input(--json)·CLAUDE_PROJECT_DIR 결속 · 소스 핀(설치 목록·대시보드 curator 분기·draftable 편입)", async () => {
    const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: WS });
    const st = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "curate", "status", "--json"], { env, encoding: "utf8" });
    const sm = JSON.parse(st.stdout.trim().split(/\r?\n/).pop());
    assert.ok(st.status === 0 && sm.runs >= 3 && sm.maxPending === 6, st.stdout + st.stderr);
    CL.freezeEnvelopeForAsk(WS, REPO, "ko"); // 동결 세대를 현 승인 세대(GEN2)로 갱신 — 신호 산출 세대 결속 비교용
    const ip = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "curate", "input", "--json"], { env, encoding: "utf8" });
    const io9 = JSON.parse(ip.stdout.trim().split(/\r?\n/).pop());
    assert.ok(ip.status === 0 && io9.ok && io9.repoKey === REPOKEY, ip.stdout + ip.stderr);
    assert.strictEqual(io9.signalsGen, io9.boundaryGen, "CLI(순환 require)에서도 신호 산출이 승인 세대에 결속 — 1회차 blocker① 재현 지점");
    assert.ok(!/circular dependency/.test(ip.stderr), "순환 require 경고 없음");
    const inst = fs.readFileSync(path.join(__dirname, "..", "install.js"), "utf8");
    assert.ok(/"curation\.js",/.test(inst), "배포 목록 편입");
    const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
    assert.ok(ext.includes('m.kind === "curator"') && ext.includes("CLM.draftCuratorCandidate(wsM, repoM, m.id, genM)") && ext.includes('cd.kind==="curator"'), "대시보드 curator 분기·라벨");
    assert.ok(CL.ENVELOPE_DRAFTABLE_KINDS.includes("curator"));
    const lib = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
    assert.ok(lib.includes("applied: wal.newHash") && lib.includes("if (rec.applied) continue;"), "도장 종결·고아 복원 제외 핀");
  });

  // ── 확인 검증 1회차 blocker 반영분 ──
  await ta("[1회차 blocker①] 신호 산출 함수 부재=입력 실패(signals-unavailable)·예외=signals-failed — 신호 0건 위장 금지 · 주입 함수 우선", async () => {
    assert.strictEqual(CU.resolveComputeCandidates({ computeCandidates: null }) !== null, true, "모듈 경로에서는 codex-bridge 함수로 폴백");
    const f9 = () => ({ gen: null, signals: [] });
    assert.strictEqual(CU.resolveComputeCandidates({ computeCandidates: f9 }), f9, "주입 함수 우선");
    assert.strictEqual(CU.curationInput(WS, REPO, { computeCandidates: () => { throw new Error("x"); } }).reason, "signals-failed");
    const i9 = CU.curationInput(WS, REPO, { computeCandidates: () => ({ gen: "0".repeat(40), signals: [{ kind: "lineage", key: "f1", n: 3, titles: ["t"] }] }) });
    assert.ok(i9.ok && i9.signals.lineage.length === 0 && i9.signalsGen === "0".repeat(40), "세대 불일치 신호는 싣지 않되 signalsGen으로 드러냄");
  });

  await ta("[1회차 blocker②] 파서 엄격 — JSON 앞뒤 산문=no-json · why/explain 개행=손상(공백 치환 관용 없음) · 2026-09-06 개정: 코드 울타리 1겹만 예외(그 안은 여전히 JSON 하나뿐)", async () => {
    const input = CU.curationInput(WS, REPO);
    assert.strictEqual(CU.parseCurationOutput("PREFIX " + out([good()]) + " SUFFIX", input).reason, "no-json");
    assert.ok(CU.parseCurationOutput("```json\n" + out([good()]) + "\n```", input).ok, "코드 울타리 1겹은 벗겨 읽음(D-2026-09-06-curator-arm-follows-scout — 실측 거짓 실패 봉합)");
    assert.strictEqual(CU.parseCurationOutput("```json\nPREFIX " + out([good()]) + "\n```", input).reason, "no-json", "울타리 안 산문은 여전히 손상");
    assert.strictEqual(CU.parseCurationOutput(out([good({ why: "project\nwide rule that spans" })]), input).reason, "bad-why");
    assert.strictEqual(CU.parseCurationOutput(out([good({ explain: Object.assign({}, explain, { happened: "line\ntwo" }) })]), input).reason, "bad-explain");
    assert.ok(CU.parseCurationOutput("  " + out([good()]) + "\n", input).ok, "앞뒤 공백만은 허용");
  });

  await ta("[1회차 blocker③ ab-7] 민감 형태=신호 제목 생략·결정 질문 표식·explain 4칸 검사(탈락) — 프롬프트·장부에 원문 없음", async () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    assert.strictEqual(CU.safeText("token " + secret + " here", 200), "", "민감 형태=빈 문자열");
    const od = CL.openDecision(WS, { origin: "implementer", kind: "external", noDefault: "외부 키 정책은 구현자가 정할 수 없는 사용자 방향입니다", campaignId: "c2", sourceAsk: "ask-2", targetFp: "fp2", question: "key " + secret + " 를 계속 쓸까요?", why: "x", choices: [{ key: "a", label: "예" }, { key: "b", label: "아니오" }] });
    assert.ok(od && od.ok, JSON.stringify(od));
    fs.mkdirSync(path.dirname(CL.campaignFileFor(WS)), { recursive: true }); fs.writeFileSync(CL.campaignFileFor(WS), JSON.stringify({ schema: "vcamp-1", campaignId: "c2", count: 1, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repoKey: REPOKEY })); // 현재 캠페인=이 저장소(ab-1 결속 — 캠페인 신호 수용 조건)
    const inp = CU.curationInput(WS, REPO, { computeCandidates: () => ({ gen: CL.loadContract(WS).envelopeHash, signals: [{ kind: "lineage", key: "f2", n: 3, titles: ["C:\\Users\\Alice\\secret.txt 누출", "정상 제목"] }] }) });
    assert.ok(inp.ok, JSON.stringify(inp));
    const q = inp.decisions.open.find((x) => x.decisionId === od.decisionId);
    assert.strictEqual(q.question, CU.RULE_REDACTED);
    assert.deepStrictEqual(inp.signals.lineage[0].titles, ["정상 제목"], "민감 형태 제목만 생략(신호 자체는 유지)");
    const prompt = CU.buildCurationPrompt(inp, "ko");
    assert.ok(!prompt.includes(secret) && !prompt.includes("secret.txt") && prompt.includes("lineage:f2"), "프롬프트에 원문 없음·신호 id는 있음");
    const pe = CU.parseCurationOutput(out([good({ explain: Object.assign({}, explain, { happened: "token " + secret }) })]), inp);
    assert.ok(pe.ok && pe.items.length === 0 && /^explain-sensitive-happened-/.test(pe.dropped[0].reason), JSON.stringify(pe.dropped));
  });

  await ta("[1회차 blocker④⑥] 중단 복구 — 결과 행 뒤 활성화 전 종료된 provisional 후보를 재활성화 · 초안 뒤에도 화면 후보가 작업 종류·설명 4칸을 유지", async () => {
    const WS6 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws6-")); const REPO6 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo6-"));
    fs.writeFileSync(path.join(REPO6, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS6, CORE_HASH); CL.updateContractPatch(WS6, "ko", { scoutRepo: REPO6 });
    fs.writeFileSync(path.join(REPO6, CL.ARCHIVE_FILE), arcRaw); CL.setContractHashAllSlots(WS6, "archiveHash", ARC_HASH);
    const rk6 = CL.repoKeyOf(REPO6);
    // 중단 흉내: provisional 행 + 결과 행(fresh 포함)만 있고 proposed 행 없음
    const inp6 = CU.curationInput(WS6, REPO6); const key6 = CU.curationKeyOf(inp6);
    const arc2 = inp6.rules.archive[1];
    const cid6 = CL.envelopeCandidateId("curator", key6 + "|remove|archive|alwaysBlocker|alwaysBlocker#1|" + sha1(CL.normBacklogTitle(arc2.text)));
    const prov = { candidateId: cid6, envelopeHash: CORE_HASH, kind: "curator", origin: "curator", policyVersion: 2, repoKey: rk6, archiveHash: ARC_HASH, operation: "remove", target: "archive", axis: "alwaysBlocker", index: 1, itemFp: arc2.itemFp, expectedTargetHash: ARC_HASH, title: arc2.text, why: "미사용 보관 수칙 정리 근거", refs: [], recommend: "", explain, curationKey: key6, status: "provisional", ts: new Date().toISOString() };
    CL.appendEnvelopeCandidates(WS6, [prov]);
    CU.appendCurationRow(WS6, { type: "result", repoKey: rk6, curationKey: key6, boundaryGen: CORE_HASH, archiveGen: ARC_HASH, resultFp: sha1(JSON.stringify([cid6])), items: [cid6], fresh: [cid6], deferred: 0, heldToggles: [], dropped: [] });
    assert.ok(!CL.readEnvelopeCandidates(WS6).latest.has(cid6 + "@" + CORE_HASH), "중단 상태: 활성화 행 없음(latest 미판독)");
    const r = await CU.runCuration(WS6, { pageRunner: fake(out([good()])) });
    assert.ok(r.st === "skipped" && r.reason === "no-signal" && r.recovered === 1, "복구 1건 뒤 같은 입력=생략(이 픽스처는 신호 0이라 사유는 no-signal이 same-input보다 먼저 — 2026-09-06 1판 blocker) " + JSON.stringify(r));
    const rec = CL.readEnvelopeCandidates(WS6).latest.get(cid6 + "@" + CORE_HASH);
    assert.ok(rec && rec.status === "proposed" && rec.operation === "remove" && rec.explain && rec.curationKey === key6, "복구 행=provisional 전 필드 승계 " + JSON.stringify(rec));
    assert.strictEqual(CU.recoverCurationProvisional(WS6).recovered, 0, "멱등(재실행 무해)");
    // [⑥] 초안 뒤(최소 adopted 행) 화면 후보의 작업 종류·설명 유지 — 결속 초안이 있어 adopted도 표시 대상
    const d6 = CL.draftCuratorCandidate(WS6, REPO6, cid6, CORE_HASH);
    assert.ok(d6.ok && d6.removes === 1, JSON.stringify(d6));
    CL.freezeEnvelopeForAsk(WS6, REPO6, "ko");
    const CB = require("../bridge/codex-bridge.js");
    const live6 = CB.computeEnvelopeCandidatesFor(WS6).live.find((c9) => c9.candidateId === cid6);
    assert.ok(live6 && live6.operation === "remove" && live6.target === "archive" && live6.explain && live6.explain.happened === explain.happened && live6.why, "초안 뒤에도 operation·target·explain 유지 " + JSON.stringify(live6));
    assert.ok(CL.discardEnvelopeProposalRestoring(WS6, CL.readEnvelopeProposal(WS6, REPO6).draftId).ok);
  });

  await ta("[1회차 blocker⑤] 도장 순서=applied 종결·제안본 폐기 → WAL 삭제(WAL 잔존=멱등 재실행으로 종결 보장)", async () => {
    const lib = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
    const fnBeg = lib.indexOf("function applyEnvelopeTransitionLocked("); const fnEnd = lib.indexOf("function envelopeApprovedCopyFileFor(", fnBeg);
    const body = lib.slice(fnBeg, fnEnd);
    const iApplied = body.indexOf("applied: wal.newHash"); const iDiscard = body.indexOf("discardEnvelopeProposal(ws);"); const iRm = body.lastIndexOf("fs.rmSync(walFile, { force: true })");
    assert.ok(iApplied > 0 && iDiscard > iApplied && iRm > iDiscard, "순서: applied → discard → WAL rm");
    assert.strictEqual(body.indexOf("fs.rmSync(walFile"), iRm, "WAL 삭제는 함수 끝 한 곳뿐");
  });

  await ta("[1회차 blocker⑦] 시작 단계 실패도 영수증+경보 — 계약 없음 · 잠금 '실행 중'은 영수증만(경보 없음)", async () => {
    const WS7 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws7-"));
    const evBefore = CL.readIntegrityEvents().filter((e) => e.kind === "curation-failed" && !e.ack).length;
    const r = await CU.runCuration(WS7, { pageRunner: fake(out([])) });
    assert.ok(r.st === "input-failed" && r.reason === "envelope-inactive", "계약 파일 부재=기본 계약(수칙서 비활성)으로 읽힘 " + JSON.stringify(r));
    const rc7 = CL.readSelectorUsage().filter((x) => x.purpose === "curate" && x.wsKey === CL.wsKeyFor(WS7));
    assert.ok(rc7.length === 1 && rc7[0].outcome === "input-failed:envelope-inactive", "영수증 " + JSON.stringify(rc7));
    assert.ok(CU.readCurationRows(WS7).some((x) => x.type === "run" && x.outcome === "input-failed"), "실행 행");
    assert.ok(CL.readIntegrityEvents().some((e) => e.kind === "curation-failed" && !e.ack && /envelope-inactive/.test(e.detail)), "입력 실패도 경보");
    // 잠금 실행 중=정상 경합: 영수증은 남고 경보는 늘지 않음(같은 종류 대체라 개수 비교는 detail로)
    const lf = CU.curateLockFileFor(WS); fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "live" }));
    try {
      const r2 = await CU.runCuration(WS, { pageRunner: fake(out([])) });
      assert.ok(r2.st === "locked" && r2.reason === "running");
      const last = CL.readSelectorUsage().filter((x) => x.purpose === "curate" && x.wsKey === WSKEY).pop();
      assert.strictEqual(last.outcome, "locked:running");
      assert.ok(!CL.readIntegrityEvents().some((e) => e.kind === "curation-failed" && !e.ack && /locked/.test(e.detail)), "실행 중 경합=경보 없음");
    } finally { fs.rmSync(lf, { force: true }); }
    void evBefore;
  });

  // ── 확인 검증 2회차 blocker 반영분 ──
  await ta("[2회차 blocker①] CLI curate run(탐색 담당 codex 팔 — 2026-09-06: harnessMode가 아니라 scoutArm) — 모듈 평가 뒤 실행이라 selector-runner가 조회하는 resolveCodex export가 채워져 있음(주입 실행기로 실측)", async () => {
    const WS8 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws8-")); const REPO8 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo8-"));
    fs.writeFileSync(path.join(REPO8, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS8, CORE_HASH); CL.updateContractPatch(WS8, "ko", { scoutRepo: REPO8, harnessMode: "codex-codex", scoutArm: "codex" }); CL.updateContractPatch(WS8, "en", { harnessMode: "codex-codex" });
    const marker = path.join(WS8, "runner-seen.json");
    const fixture = path.join(WS8, "fake-runner.js");
    fs.writeFileSync(fixture, [
      '"use strict";',
      "const fs = require('fs');",
      "const CB = require(" + JSON.stringify(path.join(__dirname, "..", "bridge", "codex-bridge.js").replace(/\\/g, "/")) + ");",
      "module.exports.runSelectorPage = function (a) {",
      "  fs.writeFileSync(" + JSON.stringify(marker.replace(/\\/g, "/")) + ", JSON.stringify({ arm: a.arm, resolveCodexIsFn: typeof CB.resolveCodex === 'function', computeIsFn: typeof CB.computeEnvelopeCandidatesFor === 'function', hasPrompt: typeof a.prompt === 'string' && a.prompt.length > 100 }));",
      "  return { promise: Promise.resolve({ ok: true, output: JSON.stringify({ proposals: [] }) }), cancel() {} };",
      "};",
    ].join("\n"));
    const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: WS8, CODEX_BRIDGE_SELECTOR_RUNNER: fixture });
    const rr = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "curate", "run", "--force", "--json"], { env, encoding: "utf8" });
    const res = JSON.parse(rr.stdout.trim().split(/\r?\n/).pop());
    assert.ok(rr.status === 0 && res.st === "ok" && res.arm === "codex" && res.proposed === 0, rr.stdout + rr.stderr);
    const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.ok(seen.arm === "codex" && seen.resolveCodexIsFn === true && seen.computeIsFn === true && seen.hasPrompt, "실행기 호출 시점에 codex-bridge export가 채워져 있음(순환 초기화 해소) " + JSON.stringify(seen));
    assert.ok(!/resolveCodex is not a function|spawn-prep-failed/.test(rr.stderr + rr.stdout));
  });

  await ta("[2026-09-06 개정] CLI curate run(탐색 담당=DeepSeek·키 파일 있음) — curation.js 전용 실행기(runCurationDeepseekPage)가 브릿지 `page` 명령을 stdin 프롬프트로 부르고(선별 실행기 무접촉) stdout(울타리 답)을 파서에 넘김(스텁 브릿지 실측·네트워크 없음)", async () => {
    const WS10 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws10-")); const REPO10 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo10-"));
    fs.writeFileSync(path.join(REPO10, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS10, CORE_HASH); CL.updateContractPatch(WS10, "ko", { scoutRepo: REPO10, scoutArm: "deepseek" });
    const keyFile = path.join(HOME, "deepseek.json"); fs.writeFileSync(keyFile, JSON.stringify({ apiKey: "sk-test-not-real" }));
    const marker = path.join(WS10, "bridge-seen.json");
    const stub = path.join(WS10, "fake-deepseek-bridge.js");
    fs.writeFileSync(stub, [
      '"use strict";',
      "const fs = require('fs');",
      "const prompt = fs.readFileSync(0, 'utf8');",
      "fs.writeFileSync(" + JSON.stringify(marker.replace(/\\/g, "/")) + ", JSON.stringify({ cmd: process.argv[2], hasPrompt: prompt.length > 100, promptHasRefsRule: /refs/.test(prompt) }));",
      "process.stdout.write('```json\\n' + JSON.stringify({ proposals: [] }) + '\\n```\\n');",
    ].join("\n"));
    const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: WS10, CODEX_BRIDGE_DEEPSEEK_BRIDGE: stub });
    delete env.CODEX_BRIDGE_SELECTOR_RUNNER;
    try {
      const rr = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "curate", "run", "--force", "--json"], { env, encoding: "utf8" });
      const res = JSON.parse(rr.stdout.trim().split(/\r?\n/).pop());
      assert.ok(rr.status === 0 && res.st === "ok" && res.arm === "deepseek" && res.proposed === 0, rr.stdout + rr.stderr);
      const seen = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.ok(seen.cmd === "page" && seen.hasPrompt && seen.promptHasRefsRule, "브릿지 page 명령이 stdin 프롬프트를 받음 " + JSON.stringify(seen));
    } finally { fs.rmSync(keyFile, { force: true }); }
  });

  await ta("[2회차 blocker② ab-7] 현재 수칙 원문이 민감 형태면 프롬프트·remove 후보 title에 표식만 · itemFp는 원문 기준(3중 대조 무변) · 표식 문안 add=거부", async () => {
    const secret = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const WS9 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws9-")); const REPO9 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo9-"));
    const core9 = JSON.stringify(Object.assign({}, coreObj, { outOfScope: ["다중 서버 동시 배포", "토큰 " + secret + " 를 쓰는 배포"] }), null, 1);
    fs.writeFileSync(path.join(REPO9, CL.ENVELOPE_FILE), core9); CL.setEnvelopeHashAllSlots(WS9, sha1(core9)); CL.updateContractPatch(WS9, "ko", { scoutRepo: REPO9 });
    const arc9 = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "키 " + secret + " 노출 금지"] }, null, 1);
    fs.writeFileSync(path.join(REPO9, CL.ARCHIVE_FILE), arc9); CL.setContractHashAllSlots(WS9, "archiveHash", sha1(arc9));
    seedRebutSignal(WS9, REPO9, "9");
    const inp = CU.curationInput(WS9, REPO9);
    assert.ok(inp.ok, JSON.stringify(inp));
    const oos2 = inp.rules.core.find((x) => x.axis === "outOfScope" && x.index === 1); const arc2 = inp.rules.archive[1];
    assert.ok(oos2.redacted && oos2.text === CU.RULE_REDACTED && oos2.itemFp === sha1(CL.normBacklogTitle("토큰 " + secret + " 를 쓰는 배포")), "원문 생략·지문은 원문 기준 " + JSON.stringify(oos2));
    assert.ok(arc2.redacted && !inp.rules.archive[0].redacted);
    assert.ok(!JSON.stringify(inp).includes(secret), "입력 어디에도 원문 없음");
    const prompt = CU.buildCurationPrompt(inp, "ko");
    assert.ok(!prompt.includes(secret) && prompt.includes(CU.RULE_REDACTED) && prompt.includes(arc2.itemFp), "프롬프트=표식+지문");
    const pr = CU.parseCurationOutput(out([good({ operation: "remove", target: "archive", index: arc2.index, itemFp: arc2.itemFp }), good({ title: CU.RULE_REDACTED })]), inp);
    assert.ok(pr.ok && pr.items.length === 1 && pr.items[0].title === CU.RULE_REDACTED && pr.dropped[0].reason === "bad-title", JSON.stringify(pr));
    const cm = CU.commitCuration(WS9, inp, pr, {});
    assert.ok(cm.ok && cm.candidateIds.length === 1);
    const rec = CL.readEnvelopeCandidates(WS9).latest.get(cm.candidateIds[0] + "@" + sha1(core9));
    assert.ok(rec.title === CU.RULE_REDACTED && rec.itemFp === arc2.itemFp && !JSON.stringify(rec).includes(secret), "후보 장부에도 원문 없음·지문 결속 유지");
    const dr = CL.draftCuratorCandidate(WS9, REPO9, cm.candidateIds[0], sha1(core9));
    assert.ok(dr.ok && dr.removes === 1, "표식 title이어도 index+itemFp로 빼기 초안 성립 " + JSON.stringify(dr));
    assert.ok(!JSON.parse(CL.readEnvelopeProposal(WS9, REPO9).proposalText).alwaysBlocker.some((x) => x.includes(secret)), "초안에서 그 항목이 빠짐");
    assert.ok(CL.discardEnvelopeProposalRestoring(WS9, CL.readEnvelopeProposal(WS9, REPO9).draftId).ok);
  });

  await ta("[2회차 blocker③④] provisional 복구 쓰기 실패=recover-failed 실행(생략 금지)+영수증+경보 · 후보는 다음 실행 재시도", async () => {
    const WS11 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws11-")); const REPO11 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo11-"));
    fs.writeFileSync(path.join(REPO11, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS11, CORE_HASH); CL.updateContractPatch(WS11, "ko", { scoutRepo: REPO11 });
    const inp = CU.curationInput(WS11, REPO11); const key = CU.curationKeyOf(inp); const rk = CL.repoKeyOf(REPO11);
    const cid = sha1("prov-11").slice(0, 16);
    CL.appendEnvelopeCandidates(WS11, [{ candidateId: cid, envelopeHash: CORE_HASH, kind: "curator", repoKey: rk, operation: "add", target: "archive", axis: "alwaysBlocker", title: "복구 대상 문안", why: "복구 대상 근거 문장", refs: [], explain, curationKey: key, status: "provisional", ts: new Date().toISOString() }]);
    CU.appendCurationRow(WS11, { type: "result", repoKey: rk, curationKey: key, boundaryGen: CORE_HASH, archiveGen: "", resultFp: sha1(JSON.stringify([cid])), items: [cid], fresh: [cid], deferred: 0, heldToggles: [], dropped: [] });
    const orig = CL.appendEnvelopeCandidates;
    CL.appendEnvelopeCandidates = () => false; // 쓰기 실패 주입
    let r; try { r = await CU.runCuration(WS11, { pageRunner: fake(out([good()])) }); } finally { CL.appendEnvelopeCandidates = orig; }
    assert.ok(r.st === "recover-failed" && r.failed === 1, JSON.stringify(r));
    const rc = CL.readSelectorUsage().filter((x) => x.purpose === "curate" && x.wsKey === CL.wsKeyFor(WS11)).pop();
    assert.strictEqual(rc.outcome, "recover-failed:1");
    assert.ok(CU.readCurationRows(WS11).some((x) => x.type === "run" && x.outcome === "recover-failed"));
    assert.ok(CL.readIntegrityEvents().some((e) => e.kind === "curation-failed" && !e.ack && /다시 살리는|re-activate/.test(e.detail)), "경보");
    assert.ok(!CL.readEnvelopeCandidates(WS11).latest.has(cid + "@" + CORE_HASH), "실패 시 후보는 아직 비활성(다음 실행 재시도)");
    const r2 = await CU.runCuration(WS11, { pageRunner: fake(out([good()])) });
    assert.ok(r2.recovered === 1 && CL.readEnvelopeCandidates(WS11).latest.get(cid + "@" + CORE_HASH).status === "proposed", "다음 실행에서 복구 " + JSON.stringify(r2));
  });

  await ta("[2회차 blocker⑤] 도장 applied 종결 행 쓰기 실패=전이 미완(applied-write)·WAL·제안본 보존 → 복구 스캐너가 멱등으로 종결·폐기를 마침", async () => {
    const WS12 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-ws12-")); const REPO12 = fs.mkdtempSync(path.join(os.tmpdir(), "cur-repo12-"));
    fs.writeFileSync(path.join(REPO12, CL.ENVELOPE_FILE), coreRaw); CL.setEnvelopeHashAllSlots(WS12, CORE_HASH); CL.updateContractPatch(WS12, "ko", { scoutRepo: REPO12 });
    fs.writeFileSync(path.join(REPO12, CL.ARCHIVE_FILE), arcRaw); CL.setContractHashAllSlots(WS12, "archiveHash", ARC_HASH);
    seedRebutSignal(WS12, REPO12, "12");
    const inp = CU.curationInput(WS12, REPO12); const arc2 = inp.rules.archive[1];
    const pr = CU.parseCurationOutput(out([good({ operation: "remove", target: "archive", index: arc2.index, itemFp: arc2.itemFp })]), inp);
    const cm = CU.commitCuration(WS12, inp, pr, {}); assert.ok(cm.ok && cm.candidateIds.length === 1);
    const cid = cm.candidateIds[0];
    const dr = CL.draftCuratorCandidate(WS12, REPO12, cid, CORE_HASH); assert.ok(dr.ok, JSON.stringify(dr));
    // 후보 장부 파일 자리를 디렉터리로 바꿔 append 실패 주입(내부 호출이라 monkeypatch 불가)
    const cf = CL.envelopeCandidatesFileFor(WS12); const bak = cf + ".bak";
    fs.renameSync(cf, bak); fs.mkdirSync(cf);
    let tr; try { tr = CL.applyEnvelopeTransition(WS12, REPO12, "ko", null); } finally { fs.rmdirSync(cf); fs.renameSync(bak, cf); }
    assert.ok(tr && tr.ok === false && tr.reason === "applied-write", "종결 행 쓰기 실패=전이 미완 " + JSON.stringify(tr));
    assert.strictEqual(CL.readVerifyEnvelopeArchive(REPO12).sha1, dr.newHash, "규칙 파일은 이미 새 판(데이터 손실 없음)");
    assert.strictEqual(CL.readEnvelopeProposal(WS12, REPO12).st, "ok", "제안본 보존");
    assert.ok(fs.existsSync(path.join(CL.BRIDGE_DIR, "envelope-transitions", CL.wsKeyFor(WS12) + ".wal.json")), "WAL 보존");
    const rec = CL.recoverEnvelopeTransition(WS12);
    assert.ok(rec && (rec.ok === true || rec.st === "ok" || rec.applied === true || rec.recovered === true || JSON.stringify(rec).includes(dr.newHash)), "복구 스캐너 완료 " + JSON.stringify(rec));
    const fin = CL.readEnvelopeCandidates(WS12).latest.get(cid + "@" + CORE_HASH);
    assert.ok(fin && fin.status === "adopted" && fin.applied === dr.newHash, "복구 뒤 applied 종결 " + JSON.stringify(fin));
    assert.strictEqual(CL.readEnvelopeProposal(WS12, REPO12).st, "absent", "제안본 폐기");
    assert.ok(!fs.existsSync(path.join(CL.BRIDGE_DIR, "envelope-transitions", CL.wsKeyFor(WS12) + ".wal.json")), "WAL 정리");
  });

  await ta("★반례(확인검증 ab-1 ×2) — 집계기 실물 경로: 같은 캠페인·같은 세대라도 행 repoKey가 다른 강등 지적은 신호에 들어오지 않고, 이 저장소 표식 행만 셈 · append 관문 override=검증 시작 스냅샷 표식", async () => {
    const CB = require("../bridge/codex-bridge.js");
    const c9 = CL.loadContract(WS); const gen9 = c9.envelopeHash;
    CL.freezeEnvelopeForAsk(WS, REPO, "ko"); // 집계기의 동결 세대=승인 세대
    fs.writeFileSync(CL.campaignFileFor(WS), JSON.stringify({ schema: "vcamp-1", campaignId: "cX", count: 1, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repoKey: REPOKEY }));
    const ts9 = new Date().toISOString();
    assert.ok(CL.appendFindingsLedger(WS, [
      { type: "finding", campaignId: "cX", envelopeHash: gen9, findingId: "xb1", demoted: true, oosId: "oos-7", titleNorm: "b1", repoKey: "0000000000000000", ts: ts9 },
      { type: "finding", campaignId: "cX", envelopeHash: gen9, findingId: "xb2", demoted: true, oosId: "oos-7", titleNorm: "b2", repoKey: "0000000000000000", ts: ts9 },
    ]));
    const raw9 = CB.computeEnvelopeCandidatesFor(WS);
    assert.ok(raw9.gen === gen9 && raw9.signals.some((s) => s.kind === "oos-repeat" && s.key === "oos-7"), "무필터 집계기(대시보드)는 종전대로 신호를 만든다(전제)");
    const inB = CU.curationInput(WS, REPO, { computeCandidates: CB.computeEnvelopeCandidatesFor });
    assert.ok(inB.ok && inB.signals.oosRepeat.length === 0, "★다른 저장소 표식 행=큐레이션 신호 0 " + JSON.stringify(inB.signals.oosRepeat));
    assert.ok(!CU.buildCurationPrompt(inB, "ko").includes("oos-repeat:oos-7"), "프롬프트에도 없음");
    assert.ok(CL.appendFindingsLedger(WS, [
      { type: "finding", campaignId: "cX", envelopeHash: gen9, findingId: "xa1", demoted: true, oosId: "oos-7", titleNorm: "a1", ts: ts9 },
      { type: "finding", campaignId: "cX", envelopeHash: gen9, findingId: "xa2", demoted: true, oosId: "oos-7", titleNorm: "a2", ts: ts9 },
    ]), "표식 없는 행은 관문이 현재 저장소로 심는다");
    const inA = CU.curationInput(WS, REPO, { computeCandidates: CB.computeEnvelopeCandidatesFor });
    assert.ok(inA.ok && inA.signals.oosRepeat.length === 1 && inA.signals.oosRepeat[0].n === 2, "이 저장소 표식 행 2건만 셈(B 행 2건 불산입) " + JSON.stringify(inA.signals.oosRepeat));
    // ★반례(확인검증 3판 ab-1) — A에서 닫힌 계보 F(등장 2·3 뒤 close)를 B의 같은 id open 행이 되살리면 안 된다(열린 지적 판독도 필터 장부로)
    assert.ok(CL.appendFindingsLedger(WS, [
      { type: "finding", campaignId: "cX", envelopeHash: gen9, findingId: "f-same", round: 1, tag: "blocker", titleNorm: "s", status: "open", ts: ts9 },
      { type: "occurrence", campaignId: "cX", envelopeHash: gen9, findingId: "f-same", round: 2, effectiveTag: "blocker", ts: ts9 },
      { type: "occurrence", campaignId: "cX", envelopeHash: gen9, findingId: "f-same", round: 3, effectiveTag: "blocker", ts: ts9 },
      { type: "close", campaignId: "cX", envelopeHash: gen9, findingId: "f-same", closeReason: "resolved", round: 4, ts: ts9 },
      { type: "finding", campaignId: "cX", envelopeHash: gen9, findingId: "f-same", round: 1, tag: "blocker", titleNorm: "s", status: "open", repoKey: "0000000000000000", ts: ts9 }, // B의 같은 id open 행
    ]));
    assert.ok(CB.computeEnvelopeCandidatesFor(WS).signals.some((s) => s.kind === "lineage" && s.key === "f-same"), "무필터(대시보드)는 B open 행 때문에 계보 신호를 만든다(전제)");
    const inC = CU.curationInput(WS, REPO, { computeCandidates: CB.computeEnvelopeCandidatesFor });
    assert.ok(inC.ok && !inC.signals.lineage.some((x) => x.key === "f-same"), "★A 기준 닫힌 계보는 B open 행으로 되살아나지 않음 " + JSON.stringify(inC.signals.lineage));
    // 관문 override: 비동기 검증 결과는 '시작 시점' 저장소를 명시로 넘긴다 — 완료 시점 계약과 달라도 그 값이 찍힌다
    assert.ok(CL.appendFindingsLedger(WS, [{ type: "round", campaignId: "cX", round: 9, verdict: "pass", envelopeHash: gen9, ts: ts9 }], { repoKey: "1111111111111111" }));
    const lastRow = CL.readFindingsLedger(WS).filter((r) => r.type === "round" && r.round === 9).pop();
    assert.strictEqual(lastRow.repoKey, "1111111111111111", "override 표식이 현재 계약을 이긴다");
    const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
    assert.ok(cb.includes("function machineFindingsLayer(answer, ws, langSnap, profileSnap, harnessModeSnap, askId, campSnap, repoKeySnap)") && cb.includes("const appendL = (rows) => appendFindingsLedger(ws, rows, typeof repoKeySnap") && cb.includes("machineFindingsLayer(answer, ws, langSnap, profileSnap, harnessModeSnap, askId, campSnap, repoKeySnap9)") && cb.includes("repoKeyOf(resolveScoutRepo(ws, contractSnap).repo)"), "검증 결과 행=시작 스냅샷 repoKey 전달(소스 핀)");
    const mflBody = cb.slice(cb.indexOf("function machineFindingsLayer("), cb.indexOf("\nfunction ", cb.indexOf("function machineFindingsLayer(") + 10));
    assert.strictEqual((mflBody.match(/appendFindingsLedger\(ws, /g) || []).length, 1, "층 안의 append는 appendL 정의 1곳만 관문을 직접 부른다(나머지 전부 스냅샷 경유)");
    assert.ok(cb.includes("appendFindingsLedger(ws, rowsJ, rkJ ? { repoKey: rkJ } : undefined)"), "처분·종결 행=대상 지적 행의 repoKey 승계");
  });

  console.log(`\n결과: ${n} 통과 / 0 실패`);
}
main().catch((e) => { console.error("❌", e && e.stack || e); process.exit(1); });
