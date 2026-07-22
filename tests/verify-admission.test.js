// 거버넌스 증분 2 — 지적 서식 v2·입장 심사·계보 장부 · docs/VERIFY-GOVERNANCE.md §3
// 계약: v1 파서·마커 존치(하위 호환) / v2=신필드(무효 형식=드롭·미기재 취급) / 강등은 '차단 권한'만 —
// 발견은 보존(백로그·장부) / 반전=자동 통과 금지(보류+선택지) / 종결은 round<N 개설분만 / 경계=프로필 공통.
const path = require("path");
const fs = require("fs");
const os = require("os");
const ROOT = path.join(__dirname, "..");
process.env.CODEX_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vadm_"));
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "vadmws_"));

console.log("[1] 서식 v2 파서 — v1 존치·신필드 관용");
{
  const v1 = ["[지적 목록 v1]", JSON.stringify({ tag: "blocker", title: "티" }), "[지적 목록 끝]", "", "검증: 실패"].join("\n");
  const p1 = CL.parseFindingsBlock(v1);
  ok(p1.ok && p1.ver === "v1" && p1.findings[0].origin === undefined, "v1 응답=ver v1·신필드 미부착(완전 하위 호환)");
  const v2 = ["[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "A", origin: "fix-induced", supported: true }),
    JSON.stringify({ tag: "blocker", title: "B", origin: "이상한값", supported: "yes", oosId: "oos-0", id: "f-XYZ" }),
    JSON.stringify({ tag: "주의", title: "C", oosId: "oos-2", abId: "ab-1", prevId: "f-12345678" }),
    "[지적 목록 끝]", "", "검증: 실패"].join("\n");
  const p2 = CL.parseFindingsBlock(v2);
  ok(p2.ok && p2.ver === "v2" && p2.findings.length === 3, "v2 마커 인정(종료 마커는 v1 공유)");
  ok(p2.findings[0].origin === "fix-induced" && p2.findings[0].supported === true, "유효 신필드 파싱");
  ok(p2.findings[1].origin === undefined && p2.findings[1].supported === undefined && p2.findings[1].oosId === undefined && p2.findings[1].id === undefined, "무효 형식(enum 밖·비boolean·oos-0·id 형식 오류)=드롭 — 표기 실수가 강등·면제를 오발동하지 않음");
  ok(p2.findings[2].oosId === "oos-2" && p2.findings[2].abId === "ab-1" && p2.findings[2].prevId === "f-12345678", "oosId·abId·prevId 형식 검증 통과분만 보존");
  const en2 = ["[findings v2]", JSON.stringify({ tag: "blocker", title: "E", origin: "baseline" }), "[findings end]", "", "검증: 실패"].join("\n");
  ok(CL.parseFindingsBlock(en2).ver === "v2", "en v2 마커 쌍");
}

console.log("[2] 계보 장부 — append-only·open/close·캠페인 격리");
{
  const C1 = "camp-A";
  CL.appendFindingsLedger(WS, [
    { type: "round", campaignId: C1, round: 1, roundType: "discovery", verdict: "fail", envelopeHash: null, ts: "t1" },
    { type: "finding", findingId: "f-aaaaaaaa", campaignId: C1, round: 1, tag: "blocker", titleNorm: "티A", origin: "baseline", status: "open", demoted: false, ts: "t1" },
    { type: "finding", findingId: "f-bbbbbbbb", campaignId: C1, round: 1, tag: "보완", titleNorm: "티B", origin: "baseline", status: "open", demoted: false, ts: "t1" },
  ]);
  const opens = CL.openFindingsFor(WS, C1);
  ok(opens.length === 2 && opens.some((o) => o.id === "f-aaaaaaaa"), "open 지적 조회");
  CL.appendFindingsLedger(WS, [{ type: "close", campaignId: C1, findingId: "f-bbbbbbbb", closeReason: "resolved", round: 2, ts: "t2" }]);
  ok(CL.openFindingsFor(WS, C1).length === 1, "close 레코드=open에서 제외");
  ok(CL.openFindingsFor(WS, "camp-B").length === 0, "캠페인 격리(다른 캠페인에 안 새어감)");
}

console.log("[3] roundType 유도 — 직전 round verdict 기준(ask 텍스트 미사용)");
{
  const C = "camp-RT";
  ok(CL.deriveRoundType(WS, C) === "discovery", "무이력=discovery(캠페인 첫 라운드)");
  CL.appendFindingsLedger(WS, [{ type: "round", campaignId: C, round: 1, roundType: "discovery", verdict: "fail", ts: "t" }]);
  ok(CL.deriveRoundType(WS, C) === "fix-verify", "직전 실패=fix-verify");
  CL.appendFindingsLedger(WS, [{ type: "round", campaignId: C, round: 2, roundType: "fix-verify", verdict: "error", ts: "t" }]);
  ok(CL.deriveRoundType(WS, C) === "fix-verify", "직전 error(판정 추출 실패)=fix-verify(확인 라운드 오인 금지 — 4차 설계 보완)");
  CL.appendFindingsLedger(WS, [{ type: "round", campaignId: C, round: 3, roundType: "fix-verify", verdict: "pass-notes", ts: "t" }]);
  ok(CL.deriveRoundType(WS, C) === "confirm", "직전 통과 계열=confirm");
}

console.log("[4] 입장 심사 규칙 0~4 — 순수 함수");
{
  const B = (x) => Object.assign({ tag: "blocker", title: "티" }, x);
  const noOpen = new Set();
  // 규칙 0(1차 blocker① 반영): 면제=승인 세대의 '유효' 불변식 인덱스 정확 인용만
  let r = CL.judgeAdmission([B({ abId: "ab-1", origin: "baseline", supported: false, oosId: "oos-1" })], "confirm", noOpen, 3, 5);
  ok(r.keptBlockers === 1 && r.demotedBlockers === 0 && r.receipts[0].key === "ab-exempt", "규칙 0: 유효 abId 지목=면제 최우선(범위·신규성 심사보다 앞)");
  r = CL.judgeAdmission([B({ abId: "ab-999", origin: "baseline", supported: false, oosId: "oos-1" })], "discovery", noOpen, 3, 5);
  ok(r.demotedBlockers === 1 && r.receipts.some((x) => x.key === "ab-invalid") && r.receipts.some((x) => x.key === "out-of-scope"), "규칙 0: 무효 인덱스(ab-999>5)=면제 미발동 영수증+다른 규칙 계속 평가(형식만 맞는 인용의 만능 면제 차단)");
  r = CL.judgeAdmission([B({ abId: "ab-1", origin: "baseline" })], "confirm", noOpen, 3, null);
  ok(r.demotedBlockers === 1, "규칙 0: 세대 불일치(abCount null — 참조 무시 상태)=면제 미발동");
  // 규칙 1: incomplete-fix=면제 — prevId는 영수증만
  r = CL.judgeAdmission([B({ origin: "incomplete-fix", prevId: "f-aaaaaaaa" })], "confirm", new Set(["f-aaaaaaaa"]), 3);
  ok(r.keptBlockers === 1 && r.receipts[0].key === "lineage-bound", "규칙 1: 미완 수정+유효 prevId=유지·계보 결속 영수증");
  r = CL.judgeAdmission([B({ origin: "incomplete-fix", prevId: "f-99999999" })], "confirm", noOpen, 3);
  ok(r.keptBlockers === 1 && r.receipts[0].key === "lineage-unproven", "규칙 1: prevId 불일치=강등 아님·[계보 미증명] 영수증(형식 오류가 해소 둔갑 금지 — 설계 2차 blocker②)");
  // 규칙 2: 범위 밖 — 유효 인덱스 정확 인용만
  r = CL.judgeAdmission([B({ supported: false, oosId: "oos-2", origin: "baseline" })], "discovery", noOpen, 3);
  ok(r.demotedBlockers === 1 && r.items[0].demotedTo === "백로그" && r.receipts[0].key === "out-of-scope", "규칙 2: supported:false+유효 oosId=백로그 강등");
  r = CL.judgeAdmission([B({ supported: false, oosId: "oos-9", origin: "fix-induced" })], "discovery", noOpen, 3);
  ok(r.keptBlockers === 1, "규칙 2: 무효 인덱스(oos-9>3)=미발동(발견은 유지 — 결정론 대조)");
  r = CL.judgeAdmission([B({ supported: false, oosId: "oos-1", origin: "baseline" })], "discovery", noOpen, null);
  ok(r.keptBlockers === 1, "규칙 2: 경계 비활성(oosCount null)=미발동");
  // 규칙 3: 후속 라운드 신규+자격 origin 없음
  r = CL.judgeAdmission([B({ origin: "baseline" })], "fix-verify", noOpen, 3);
  ok(r.demotedBlockers === 1 && r.receipts[0].key === "late-theory", "규칙 3: 후속 라운드 신규 blocker(origin baseline)=백로그 강등");
  r = CL.judgeAdmission([B({ origin: "fix-induced" })], "fix-verify", noOpen, 3);
  ok(r.keptBlockers === 1, "규칙 3: fix-induced=인정");
  r = CL.judgeAdmission([B({ id: "f-aaaaaaaa", origin: "baseline" })], "fix-verify", new Set(["f-aaaaaaaa"]), 3);
  ok(r.keptBlockers === 1, "규칙 3: 열린 id 인용=재지적(신규 아님 — 강등 없음)");
  r = CL.judgeAdmission([B({ origin: "baseline" })], "discovery", noOpen, 3);
  ok(r.keptBlockers === 1, "규칙 3: discovery(1차)=일괄 제출 라운드 — 강등 없음");
  // 규칙 4: 확인 라운드=수정 유발만
  r = CL.judgeAdmission([B({ origin: "new-evidence" })], "confirm", noOpen, 3);
  ok(r.demotedBlockers === 1 && r.receipts[0].key === "confirm-scope", "규칙 4: 확인 라운드 신규(new-evidence)=백로그 강등(fix-induced만 인정)");
  r = CL.judgeAdmission([B({ origin: "fix-induced" })], "confirm", noOpen, 3);
  ok(r.keptBlockers === 1, "규칙 4: 확인 라운드 fix-induced=인정");
  // 비차단=무심사
  r = CL.judgeAdmission([{ tag: "보완", title: "노트", supported: false, oosId: "oos-1" }], "confirm", noOpen, 3);
  ok(!r.items[0].demotedTo && r.receipts.length === 0, "비차단 태그=심사 대상 아님(차단 권한만 제한 — §1 원칙)");
}

console.log("[4.5] roundType 세대 필터 — 비활성 기록이 활성 심사를 오염하지 않음(1차 blocker④)");
{
  const C = "camp-GEN";
  CL.appendFindingsLedger(WS, [
    { type: "round", campaignId: C, round: 1, roundType: "discovery", verdict: "fail", envelopeHash: null, ts: "t" },
    { type: "round", campaignId: C, round: 2, roundType: "fix-verify", verdict: "pass", envelopeHash: null, ts: "t" },
  ]);
  ok(CL.deriveRoundType(WS, C, "a".repeat(40)) === "discovery", "비활성(null) 라운드 2개 뒤 승인 세대 첫 라운드=discovery(1차 일괄 라운드 보장 — baseline 강등 오염 차단)");
  ok(CL.deriveRoundType(WS, C, null) === "confirm", "같은 세대(null)끼리는 정상 유도");
  ok(CL.deriveRoundType(WS, C) === "confirm", "gen 미전달=기존 전체(하위 호환)");
  // 2차 미완수정④: open 조회도 세대 필터
  CL.appendFindingsLedger(WS, [
    { type: "finding", findingId: "f-gen00001", campaignId: C, round: 1, tag: "blocker", titleNorm: "구세대", envelopeHash: null, status: "open", ts: "t" },
    { type: "finding", findingId: "f-gen00002", campaignId: C, round: 1, tag: "blocker", titleNorm: "신세대", envelopeHash: "b".repeat(40), status: "open", ts: "t" },
  ]);
  const gOpen = CL.openFindingsFor(WS, C, "b".repeat(40));
  ok(gOpen.length === 1 && gOpen[0].id === "f-gen00002", "open 조회 세대 필터 — 구세대 id가 새 세대 재지적으로 인정 불가(신규성 심사 우회 차단)");
  ok(CL.openFindingsFor(WS, C).length === 2, "gen 미전달=전체(통계 하위 호환)");
  // 3차 미완수정②: id=세대 결속·close도 세대 결속
  ok(CL.newFindingId("c", "g1", 1, "같은제목", 1) !== CL.newFindingId("c", "g2", 1, "같은제목", 1), "findingId=세대 포함(세대별 회차 재시작에도 교차 세대 충돌 없음 — f-9b363396 실증 반례)");
  CL.appendFindingsLedger(WS, [{ type: "close", campaignId: C, findingId: "f-gen00002", closeReason: "resolved", round: 2, envelopeHash: null, ts: "t" }]);
  ok(CL.openFindingsFor(WS, C, "b".repeat(40)).length === 1, "다른 세대(null)의 close는 이 세대 finding을 닫지 못함");
  CL.appendFindingsLedger(WS, [{ type: "close", campaignId: C, findingId: "f-gen00002", closeReason: "resolved", round: 2, envelopeHash: "b".repeat(40), ts: "t" }]);
  ok(CL.openFindingsFor(WS, C, "b".repeat(40)).length === 0, "같은 세대의 close만 유효");
  // 4차 미완수정②: 구형 무세대 close=전 세대 적용(하위 호환 — 종결된 finding 재open 금지)
  CL.appendFindingsLedger(WS, [
    { type: "finding", findingId: "f-gen00003", campaignId: C, round: 1, tag: "blocker", titleNorm: "구close대상", envelopeHash: "c".repeat(40), status: "open", ts: "t" },
    { type: "close", campaignId: C, findingId: "f-gen00003", closeReason: "resolved", round: 2, ts: "t" },
  ]);
  ok(CL.openFindingsFor(WS, C, "c".repeat(40)).length === 0, "envelopeHash 필드 없는 구형 close=전 세대 적용(업그레이드가 정상 종결을 재open하지 않음 — 4차 미완수정②)");
  // 5차 미완수정②: 같은 id가 복수 세대에 존재(과도기 충돌)하면 legacy close=모호 → open 유지
  CL.appendFindingsLedger(WS, [
    { type: "finding", findingId: "f-dup00001", campaignId: C, round: 1, tag: "blocker", titleNorm: "중복1", envelopeHash: "d".repeat(40), status: "open", ts: "t" },
    { type: "finding", findingId: "f-dup00001", campaignId: C, round: 1, tag: "blocker", titleNorm: "중복1", envelopeHash: "e".repeat(40), status: "open", ts: "t" },
    { type: "close", campaignId: C, findingId: "f-dup00001", closeReason: "resolved", round: 2, ts: "t" },
  ]);
  ok(CL.openFindingsFor(WS, C, "d".repeat(40)).length === 1 && CL.openFindingsFor(WS, C, "e".repeat(40)).length === 1, "복수 세대 동일 id의 legacy close=어느 세대 종결인지 모호 → 양쪽 open 유지(침묵 종결 금지 — 5차 미완수정②)");
}

console.log("[4.7] 실행 통합 — machineFindingsLayer 실경로(1차 blocker⑤ · 스팬 교체 소실 복원)");
{
  const CB = require(path.join(ROOT, "bridge", "codex-bridge.js")); // require.main 가드로 CLI 미실행
  const NLc = String.fromCharCode(10);
  const repoE = fs.mkdtempSync(path.join(os.tmpdir(), "vadmexe_"));
  fs.writeFileSync(path.join(repoE, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["s1"], alwaysBlocker: ["a1", "a2"], outOfScope: ["o1", "o2"] }));
  const shaE = CL.readVerifyEnvelope(repoE).sha1;
  const wsE = fs.mkdtempSync(path.join(os.tmpdir(), "vadmexws_"));
  CL.updateContractPatch(wsE, "ko", { envelopeHash: shaE, scoutRepo: repoE }, { tries: 3 });
  // E1: 1차(discovery) — v2 실패·blocker 2(baseline) 전부 인정+장부 open 2
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e1"; CL.writeEnvelopeFreeze(wsE, shaE, "ask-e1");
  const r1 = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "실결함 하나", origin: "baseline" }),
    JSON.stringify({ tag: "blocker", title: "실결함 둘", origin: "baseline" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), wsE, "ko", "core", "claude-codex", "ask-e1");
  ok(r1.machine.effective === "fail" && r1.machine.admission && r1.machine.admission.kept === 2 && r1.machine.admission.demoted === 0, "E1: 1차 일괄=전부 인정·실패 유지");
  const open1 = CL.openFindingsFor(wsE, "no-campaign", shaE);
  ok(open1.length === 2, "E1: 장부에 open 2건(신규 발급 id·세대 결속)");
  // E2: 2차(fix-verify) — 재지적 id 인용=유지·신규 이론=강등+기존 open 불변
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e2"; CL.writeEnvelopeFreeze(wsE, shaE, "ask-e2");
  const r2 = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "실결함 하나 남음", id: open1[0].id, origin: "baseline" }),
    JSON.stringify({ tag: "blocker", title: "새 이론 강화", origin: "baseline" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), wsE, "ko", "core", "claude-codex", "ask-e2");
  ok(r2.machine.effective === "fail" && r2.machine.admission.kept === 1 && r2.machine.admission.demoted === 1, "E2: 재지적 유지+신규 이론 강등(실패 유지 — 진짜 잔존 blocker 있음)");
  ok(r2.notice.includes("[입장 심사]") && r2.notice.includes("[장부 자동 등록]"), "E2: 영수증 병기+강등분 백로그 자동 등록(발견 보존)");
  ok(CL.openFindingsFor(wsE, "no-campaign", shaE).length === 2, "E2: 강등 신규=closed(demoted)·기존 open 2건 불변(제목 폴백 제거)");
  // E3: 반전 — 전부 범위 강등된 실패=보류 재산출(자동 통과 금지)
  const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), "vadmexw3_"));
  CL.updateContractPatch(ws3, "ko", { envelopeHash: shaE, scoutRepo: repoE }, { tries: 3 });
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e3"; CL.writeEnvelopeFreeze(ws3, shaE, "ask-e3");
  const r3 = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "범위 밖 경합", origin: "baseline", supported: false, oosId: "oos-2" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), ws3, "ko", "core", "claude-codex", "ask-e3");
  ok(r3.machine.effective === "inconclusive" && r3.machine.reasonKey === "scope-demoted" && r3.notice.includes("①범위 밖 수용(종결) ②재심 요청"), "E3: 전부 강등된 실패=정본 '보류'+선택지(자동 통과 금지)");
  // E4: v1 응답+승인=심사 미적용 경고(fail-open)
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e4"; CL.writeEnvelopeFreeze(ws3, shaE, "ask-e4");
  const r4 = CB.machineFindingsLayer(["본문", "[지적 목록 v1]", JSON.stringify({ tag: "blocker", title: "v1 지적" }), "[지적 목록 끝]", "", "검증: 실패"].join(NLc), ws3, "ko", "core", "claude-codex", "ask-e4");
  ok(r4.machine.effective === "fail" && r4.notice.includes("[입장 심사 미적용 — v1 응답"), "E4: 승인+v1=심사 미발동+경고(활성 행렬 fail-open)");
  // E5: 세대 변경(파일 개정 후 재승인 없이) — 참조 무시+blocker 유지
  fs.appendFileSync(path.join(repoE, "verify-envelope.json"), " ");
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e5"; CL.writeEnvelopeFreeze(ws3, shaE, "ask-e5");
  const r5 = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "세대 경합 지적", origin: "fix-induced", supported: false, oosId: "oos-1" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), ws3, "ko", "core", "claude-codex", "ask-e5");
  ok(r5.notice.includes("[경계 세대 변경") && r5.machine.effective === "fail", "E5: 검증 중 파일 변경=경계 참조 무시(강등 미발동·blocker 유지)");
  // E6: 계약 도장 철회 — 파일 정상이어도 도장 없으면 참조 무시(3자 일치 계약)
  const ws6 = fs.mkdtempSync(path.join(os.tmpdir(), "vadmexw6_"));
  const repo6 = fs.mkdtempSync(path.join(os.tmpdir(), "vadmexr6_"));
  fs.writeFileSync(path.join(repo6, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["s"], alwaysBlocker: ["a"], outOfScope: ["o"] }));
  const sha6 = CL.readVerifyEnvelope(repo6).sha1;
  CL.updateContractPatch(ws6, "ko", { scoutRepo: repo6 }, { tries: 3 }); // 도장 없음
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e6"; CL.writeEnvelopeFreeze(ws6, sha6, "ask-e6"); // 동결만 존재(철회 상황 재현)
  const r6 = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "철회 후 지적", origin: "fix-induced", supported: false, oosId: "oos-1" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), ws6, "ko", "core", "claude-codex", "ask-e6");
  ok(r6.notice.includes("[경계 세대 변경") && r6.machine.effective === "fail", "E6: 승인 철회(계약 도장 부재)=참조 무시(동결·파일·도장 3자 일치 시에만 심사)");
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
}

console.log("[4.8] 동결-잡 결속 — askId 동등 비교(5차 미완수정① — 벽시계 폐기)");
{
  const CB2 = require(path.join(ROOT, "bridge", "codex-bridge.js"));
  const repoS = fs.mkdtempSync(path.join(os.tmpdir(), "vadmstale_"));
  fs.writeFileSync(path.join(repoS, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["s"], alwaysBlocker: ["a"], outOfScope: ["o"] }));
  const shaS = CL.readVerifyEnvelope(repoS).sha1;
  const wsS = fs.mkdtempSync(path.join(os.tmpdir(), "vadmstalews_"));
  CL.updateContractPatch(wsS, "ko", { envelopeHash: shaS, scoutRepo: repoS }, { tries: 3 });
  const mk48 = () => ["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "동결 결속 검증", origin: "baseline", supported: false, oosId: "oos-1" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(String.fromCharCode(10));
  // 다른 ask의 동결 잔존(기록 실패·시계 역행과 무관하게 id 불일치로 차단)
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-this-0001"; CL.writeEnvelopeFreeze(wsS, shaS, "ask-other-9999"); // 타 ask 잔존 재현
  const rS = CB2.machineFindingsLayer(mk48(), wsS, "ko", "core", "claude-codex", "ask-this-0001");
  ok(rS.notice.includes("[경계 동결이 이 검증 잡에 결속되지 않음") && rS.machine.effective === "fail" && !rS.machine.admission, "동결 askId≠잡 id=심사 미발동+경고(시계 역행·기록 실패 어느 경로든 동등 비교가 차단 — 5차)");
  // askId 없는 동결(비내구 경로 잔존)도 미발동
  CL.writeEnvelopeFreeze(wsS, shaS, null); // askId 없는 잔존
  const rS0 = CB2.machineFindingsLayer(mk48(), wsS, "ko", "core", "claude-codex", "ask-this-0001");
  ok(rS0.notice.includes("[경계 동결이 이 검증 잡에 결속되지 않음"), "동결 askId 부재=미발동(비표준 경로 안전 방향)");
  // 정상: id 일치=발동
  CL.writeEnvelopeFreeze(wsS, shaS, "ask-this-0001");
  const rS2 = CB2.machineFindingsLayer(mk48(), wsS, "ko", "core", "claude-codex", "ask-this-0001");
  ok(rS2.machine.admission && rS2.machine.admission.demoted === 1, "(대조) 동결 askId=잡 env id → 심사 정상 발동");
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
  CL.writeEnvelopeFreeze(wsS, shaS, null);
  const rS3 = CB2.machineFindingsLayer(mk48(), wsS, "ko", "core", "claude-codex", "ask-this-0001");
  ok(rS3.notice.includes("[경계 동결이 이 검증 잡에 결속되지 않음"), "env 부재(비내구 직접 경로)=엄격 미발동(null-동결 잔존 미검출 창 제거 — 6차)");
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-this-0001";
  const cb48 = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok((cb48.match(/process\.env\.CODEX_BRIDGE_ASK_JOB_ID/g) || []).length >= 2 && cb48.includes("fz.askId !== envJid9") && !cb48.includes("fz.ts < jts") && !cb48.includes("String(fz.askId) !== String(askId)"), "조립·후처리가 같은 출처(내구 잡 env)로 결속 — L1-A UUID 오비교 제거(6차 라이브 실증 반영)·벽시계 비교 부재");
}

console.log("[5] 경계 동결 — ask 시작 스냅샷");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vadmrepo_"));
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["a"], alwaysBlocker: ["b"], outOfScope: ["c", "d"] }));
  const sha = CL.readVerifyEnvelope(repo).sha1;
  const wsF = fs.mkdtempSync(path.join(os.tmpdir(), "vadmwsf_"));
  CL.updateContractPatch(wsF, "ko", { envelopeHash: sha }, { tries: 3 });
  ok(CL.freezeEnvelopeForAsk(wsF, repo, "ko") === sha && CL.readFrozenEnvelope(wsF) === sha, "승인 상태=동결 파일에 승인 지문 기록·재판독 일치");
  const wsN = fs.mkdtempSync(path.join(os.tmpdir(), "vadmwsn_"));
  ok(CL.freezeEnvelopeForAsk(wsN, repo, "ko") === null && CL.readFrozenEnvelope(wsN) === null, "미승인=null 동결(심사 미발동 축 — 이전 ask 잔존 덮어쓰기)");
  { // 2차 미완수정②: '삭제 먼저→기록' 순서 — 기록 실패 시 파일 부재=심사 미발동 보장(소스 단언: unlink가 atomicWrite보다 앞)
    const clSrc = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
    const body = clSrc.slice(clSrc.indexOf("function writeEnvelopeFreeze"), clSrc.indexOf("function readFrozenEnvelope"));
    ok(body.indexOf("fs.unlinkSync(fzF)") < body.indexOf('askId: askJobId || null') && body.includes('hash: null') && body.includes('".stale-"'), "동결=삭제 먼저→기록+삭제 실패 시 2단 무효화(null 덮어쓰기→rename 격리)+askId 동등 결속 기록(3~5차 미완수정①)");
  }
}

console.log("[6] 배선 소스 단언 — codex-bridge·캐논·정본");
{
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(cb.includes("writeEnvelopeFreeze(ws || configWs(), evi.st === \"ok\" ? evi.sha1 : null, jid9)") && cb.includes("경계 동결 기록 실패"), "ask 조립=주입에 쓴 지문을 재판독 없이 동결+잡 id 결속(원자 결속)+실패 가시화(1차 blocker②·5차 ①)");
  ok(cb.includes('cNow.envelopeHash === frozen'), "후처리=파일 세대+현재 계약 도장까지 동결과 3자 일치 시에만 참조 유효(재승인·철회 경합 차단)");
  ok(cb.includes('if (profile === "core") envText += ') , "v2 서식 지시절=core 한정(무결성=문구 준수 감사 — 1차 [보완]② 지시·후처리 정합)");
  ok(!cb.includes("opens.slice(0, 50)") && !cb.includes("열린 지적 미표시") && cb.includes("for (const o of opens) L.push"), "열린 지적=상한 없이 전부 주입(2차 미완수정③ — 구현모델 의존 복귀 금지·제목 60자 절단으로 비대 완화)");
  ok(cb.includes("openFindingsFor(ws, currentCampaignIdFor(ws), readFrozenEnvelope(ws))") && cb.includes("openFindingsFor(ws, camp, frozen)"), "주입·심사 양쪽 open 조회=동결 세대 필터(2차 미완수정④)");
  ok(cb.includes("newFindingId(camp, frozen, roundNo, tn, seq)") && cb.includes("newFindingId(camp, null, roundNo, tn, seq)"), "id 생성=세대 결속(3차 미완수정②)");
  ok(cb.includes("const prevTag = (openList.find((o) => o.id === cited) || {}).tag") && cb.includes("else if (f.tag !== prevTag)"), "재제출 종결=태그가 실제로 바뀐 재분류·강등만 — 같은 태그 재제출=open 유지(3차 신규 실행증거 f-63c42134 침묵 소멸 반영)");
  ok(cb.includes("인용 필수(미인용=면제 없음)") && cb.includes("MUST cite \"abId\""), "v2 지시절=abId 인용 필수 계약(2차 미완수정① — 정본 규칙 0 개정과 정합)");
  ok(cb.includes('profile === "core" ? envelopeCoreQualifier(lang) : envelopeIntegrityQualifier(lang)'), "경계=프로필 공통(무결성=재소환 금지+재심 관점 문구 — 사용자 결정 2026-07-22)");
  ok(cb.includes("v2DirectiveFor(ws || configWs(), lang)") && cb.includes("[열린 지적 — 재지적·미완 수정 보고 시 이 id를 인용하라(미인용=신규 취급)]"), "경계 활성=v2 서식 요구+열린 지적 하네스 직접 주입(구현모델 선별 금지)");
  ok(/judgeAdmission\(parse\.findings, roundType, openIds, oosCount, abCount\)/.test(cb), "후처리=입장 심사 발동(v2+동결 승인·abCount 결속 — 1차 blocker①)");
  ok(cb.includes('machine.effective = "inconclusive"; machine.demoted = true; machine.reasonKey = "scope-demoted"') && cb.includes("①범위 밖 수용(종결) ②재심 요청"), "규칙 5: 반전=자동 통과 금지·정본 '보류'+사용자 선택지");
  ok(cb.includes("[입장 심사 미적용 — v1 응답(지시문은 v2 요구) · 통계 기록]"), "활성 행렬: 승인+v1=fail-open+경고 병기");
  ok(cb.includes('verdict: "error", envelopeHash: frozen'), "판정 추출 실패 라운드도 회차 기록(error — 다음 라운드 fix-verify 유도)");
  ok(cb.includes("const effTag = f.demotedTo || f.tag") && cb.includes('" (강등분)"'), "강등분도 [백로그] 자동 등록 경로(발견 보존 — §3.3)");
  ok(cb.includes("evNow.sha1 === frozen") && cb.includes("[경계 세대 변경 — 이번 라운드의 경계 참조(oosId·abId)는 무시됨]"), "동결 세대 재확인 — 검증 중 재승인=참조 무시+경고(4차 설계 blocker①)");
  const qi = CL.envelopeIntegrityQualifier("ko"), qe = CL.envelopeIntegrityQualifier("en");
  ok(qi.includes("blocker로 재소환하지 마라") && qi.includes("경계 자체를 재심") && qe.includes("do NOT resubmit") && qe.includes("audits the boundary itself"), "무결성 문구=부채화 차단+경계 재심([주의] 제출) ko/en");
  ok(CL.machineReasonText({ reasonKey: "scope-demoted" }, false).includes("범위 강등"), "footer 사유 키 scope-demoted 등록");
  const doc = fs.readFileSync(path.join(ROOT, "docs", "VERIFY-GOVERNANCE.md"), "utf8");
  ok(doc.includes("프로필 공통(사용자 결정 2026-07-22") && doc.includes("부채로 되살아나는 경로 차단"), "정본=프로필 공통 결정·부채화 차단·구현 한정 명문");
}

console.log("[7] 통합 시나리오 — 1차 일괄→재지적 유지·신규 강등→통과 종결");
{
  const C = "camp-INT";
  // 1차(discovery): blocker 2 제출 — 전부 인정·open
  const r1 = CL.judgeAdmission([
    { tag: "blocker", title: "결함1", origin: "baseline" },
    { tag: "blocker", title: "결함2", origin: "baseline" },
  ], "discovery", new Set(), 3);
  ok(r1.keptBlockers === 2, "1차 일괄=전부 인정");
  CL.appendFindingsLedger(WS, [
    { type: "round", campaignId: C, round: 1, roundType: "discovery", verdict: "fail", ts: "t" },
    { type: "finding", findingId: "f-11111111", campaignId: C, round: 1, tag: "blocker", titleNorm: "결함1", status: "open", ts: "t" },
    { type: "finding", findingId: "f-22222222", campaignId: C, round: 2, tag: "blocker", titleNorm: "결함2", status: "open", ts: "t" },
  ]);
  // 2차(fix-verify): 재지적 유지+신규 이론 강등
  const opens2 = new Set(CL.openFindingsFor(WS, C).map((o) => o.id));
  const r2 = CL.judgeAdmission([
    { tag: "blocker", title: "결함1 남음", id: "f-11111111", origin: "baseline" },
    { tag: "blocker", title: "새 이론", origin: "baseline" },
  ], CL.deriveRoundType(WS, C), opens2, 3);
  ok(CL.deriveRoundType(WS, C) === "fix-verify" && r2.keptBlockers === 1 && r2.demotedBlockers === 1, "2차: 재지적(id 인용)=유지·신규 이론=강등 — C-7 폭주 패턴의 기계 차단");
  // 통과 라운드: round<N 개설분만 종결(같은 라운드 첫 등장은 open 유지)
  CL.appendFindingsLedger(WS, [
    { type: "round", campaignId: C, round: 2, roundType: "fix-verify", verdict: "pass-notes", ts: "t" },
    { type: "finding", findingId: "f-33333333", campaignId: C, round: 2, tag: "보완", titleNorm: "이번에 첫 등장", status: "open", ts: "t" },
    { type: "close", campaignId: C, findingId: "f-11111111", closeReason: "resolved", round: 2, ts: "t" },
  ]);
  const remain = CL.openFindingsFor(WS, C);
  ok(remain.some((o) => o.id === "f-33333333") && !remain.some((o) => o.id === "f-11111111"), "통과 종결=이전 라운드 개설분만·같은 라운드 첫 등장은 open 유지(계보 소멸 차단 — 4차 설계 blocker②)");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
