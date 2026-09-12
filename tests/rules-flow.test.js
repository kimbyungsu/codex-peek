"use strict";
// [HARNESS-STRUCTURE-2026-09-11 §B3 · 사용자 결정 D4] 수칙 흐름 4칸 — 순수 계산(rules-flow.js)·장부 실물 결속·개요 카드 소스 계약.
const fs = require("fs");
const os = require("os");
const path = require("path");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rf-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.resolve(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const CU = require("../bridge/curation.js");
const RF = require("../bridge/rules-flow.js");
let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] 순수 — 빈 서고·제안 0·영수증 없음");
{ const f = RF.rulesFlow({});
  ok(f.core.st === "absent" && f.core.count.total === 0 && f.core.injectedChars === 0, "코어 없음=absent·0항·0글자");
  ok(f.archive.state === "none" && f.archive.count === 0 && f.archive.lastSelection === null, "서고 도장 없음+파일 없음=none·영수증 null");
  ok(f.proposals.pending === 0 && f.proposals.nextCheck.tickCount === 0 && f.proposals.nextCheck.lastTickTs === "", "제안 0·검사 0회");
  ok(f.curator.lastTs === "" && f.curator.lastItems.length === 0 && f.curator.metrics.adoptRate === 0, "정리 담당 실행 없음·지표 0"); }

console.log("[2] 순수 — 정상 값·영수증 채택 규칙(wsKey·repoKey 둘 다 일치만 · ab-1)");
{ const env = { st: "ok", sha1: "e".repeat(40), data: { supportedEnv: ["a", "b"], alwaysBlocker: ["c"], outOfScope: ["d", "e", "f"] } };
  const usage = [
    { ts: "2026-09-12T01:00:00.000Z", wsKey: "W", repoKey: "R", askId: "ask-1", selectedIds: ["x", "y"] },                            // 검증 선별 실물=purpose 없음·askId 있음
    { ts: "2026-09-12T02:00:00.000Z", wsKey: "W", repoKey: "OTHER", askId: "ask-2", selectedIds: ["x", "y", "z"] }, // 같은 폴더·다른 저장소=제외
    { ts: "2026-09-12T03:00:00.000Z", wsKey: "W2", repoKey: "R", askId: "ask-3", selectedIds: ["x"] },              // 다른 폴더=제외
    { ts: "2026-09-12T04:00:00.000Z", purpose: "preview", wsKey: "W", repoKey: "R", askId: "", selectedIds: ["x", "y", "z", "w"] },     // 미리보기=제외
    { ts: "2026-09-12T05:00:00.000Z", wsKey: "W", askId: "ask-5", selectedIds: ["x"] },                                                // repoKey 없음(옛 행)=제외
    { ts: "2026-09-12T06:00:00.000Z", purpose: "curate", wsKey: "W", repoKey: "R", askId: "", selectedIds: ["cand-1", "cand-2"] },     // 정리 담당 영수증(후보 id)=제외(1판 blocker)
    { ts: "2026-09-12T07:00:00.000Z", wsKey: "W", repoKey: "R", askId: "", selectedIds: ["x"] },                                        // askId 없는 행=검증 선별 아님=제외
  ];
  const f = RF.rulesFlow({ envelope: env, injection: { st: "ok", text: "0123456789" }, archive: { st: "ok", sha1: "A", data: { alwaysBlocker: ["r1", "r2", "r3"] } }, archiveHash: "A", archiveMax: 96, selectCap: { items: 12, bytes: 4000 }, usage, wsKey: "W", repoKey: "R",
    curation: { pending: 2, maxPending: 6, campaignsSince: 4, lastTs: "2026-09-12T00:30:00.000Z", lastOutcome: "proposed", lastReason: "", lastTrigger: "auto", running: false, lastItems: [{ id: "c1", title: "t1", op: "add", status: "proposed" }], adoptRate: 50, proposedTotal: 4, adopted: 2, declined: 1, archiveSize: 3, selOverCount: 1, unusedCount: 0 },
    tick: { k: 7, judgedAt: "2026-09-12T00:20:00.000Z", ranAt: "" }, consts: { tickK: 10, maxPending: 6, unusedDays: 30 } });
  ok(f.core.count.total === 6 && f.core.count.supportedEnv === 2 && f.core.count.alwaysBlocker === 1 && f.core.count.outOfScope === 3 && f.core.injectedChars === 10 && f.core.st === "ok", "코어 항수 축별·합계·주입 글자 수=실물 길이");
  ok(f.archive.state === "active" && f.archive.count === 3 && f.archive.max === 96 && f.archive.selectCap.items === 12 && f.archive.selectCap.bytes === 4000, "서고 active·항수·상한·선별 상한");
  ok(f.archive.lastSelection && f.archive.lastSelection.askId === "ask-1" && f.archive.lastSelection.selectedCount === 2 && f.archive.lastSelection.ts === "2026-09-12T01:00:00.000Z", "마지막 영수증=wsKey·repoKey 둘 다 일치하는 검증 선별 행(뒤의 다른 저장소·다른 폴더·미리보기·repoKey 없는 행·정리 담당 curate 행·askId 없는 행 제외)");
  ok(RF.isVerifySelectionRow(usage[0]) && !RF.isVerifySelectionRow(usage[3]) && !RF.isVerifySelectionRow(usage[5]) && !RF.isVerifySelectionRow(usage[6]), "검증 선별 행 판별=구조 표식(purpose 없음 && askId 있음) — curation.js 미사용 판정과 같은 규칙");
  ok(RF.lastSelectionOf(usage, "", "R") === null && RF.lastSelectionOf(usage, "W", "") === null, "wsKey·repoKey 미상=null(오귀속보다 표시 생략)");
  ok(f.proposals.pending === 2 && f.proposals.max === 6 && f.proposals.nextCheck.tickK === 10 && f.proposals.nextCheck.tickCount === 7 && f.proposals.nextCheck.unusedDays === 30 && f.proposals.nextCheck.lastTickTs === "2026-09-12T00:20:00.000Z", "제안함: 미승인/상한·다음 검사 조건(훅 K·지금 n·미사용 일수·마지막 검사)");
  ok(f.curator.lastTrigger === "auto" && f.curator.lastItems.length === 1 && f.curator.lastItems[0].title === "t1" && f.curator.metrics.adoptRate === 50 && f.curator.metrics.selOverCount === 1 && f.curator.metrics.archiveSize === 3, "정리 담당: 마지막 실행·제안 목록·4지표");
  const b = RF.rulesFlow({ envelope: env, injection: { st: "mismatch", text: null }, archive: { st: "ok", sha1: "A" }, archiveHash: "B", usage, wsKey: "W", repoKey: "R" });
  ok(b.core.st === "mismatch" && b.core.injectedChars === 0 && b.archive.state === "broken", "미승인 변경=mismatch·0글자 / 서고 도장 불일치=broken");
  ok(RF.rulesFlow({ archive: { st: "ok", sha1: "A" }, archiveHash: null }).archive.state === "stray", "도장 없는 보관 파일=stray"); }

console.log("[3] 실물 결속 — 임시 저장소의 코어 수칙으로 주입 글자 수=envelopeInjectionFor(...).text.length · 상수=contract-lib");
{ const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-ws-"));
  fs.writeFileSync(path.join(ws, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["node 20"], alwaysBlocker: ["비밀값 원문 로그 금지"], outOfScope: ["원격 CI"] }));
  const sha = CL.readVerifyEnvelope(ws).sha1;
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ envelopeHash: sha }));
  const f = RF.rulesFlowFor(ws, { lang: "ko" });
  const inj = CL.envelopeInjectionFor(ws, sha, "ko");
  ok(f.core.st === "ok" && f.core.count.total === 3 && f.core.injectedChars === inj.text.length && f.core.injectedChars > 100, "주입 글자 수=실물 주입문 길이(" + f.core.injectedChars + ")");
  ok(f.archive.selectCap.items === CL.SELECTOR_UNION_MAX && f.archive.selectCap.bytes === CL.SELECTOR_UNION_BYTES_MAX && f.archive.max === CL.ARCHIVE_ITEM_MAX && f.proposals.nextCheck.tickK === CU.CURATION_TICK_K && f.proposals.max === CU.CURATION_MAX_PENDING && f.proposals.nextCheck.unusedDays === CU.CURATION_UNUSED_DAYS, "선별 상한·서고 상한·검사 상수=브릿지 상수(단일 출처)");
  ok(f.archive.state === "none" && f.archive.lastSelection === null && f.proposals.pending === 0 && f.curator.lastTs === "", "서고·영수증·제안·정리 담당 없음=빈 상태(예외 없이 4칸)");
  { const wk = CL.wsKeyFor(ws), rk = CL.repoKeyOf(ws);
    CL.appendSelectorUsage({ ts: "2026-09-12T01:00:00.000Z", wsKey: wk, repoKey: rk, askId: "ask-real", turnAnchor: "t", archiveHash: "a", scopePackageHash: "s", snapshotHash: "h", itemCount: 1, selectedIds: ["r-1"] }); // worker 모양(purpose 없음)
    CL.appendSelectorUsage({ ts: "2026-09-12T02:00:00.000Z", wsKey: wk, repoKey: rk, askId: "", purpose: "curate", turnAnchor: "c", archiveHash: "a", selectedIds: ["cand-1", "cand-2", "cand-3"] }); // 정리 담당 모양
    const f2 = RF.rulesFlowFor(ws, { lang: "ko" });
    ok(f2.archive.lastSelection && f2.archive.lastSelection.askId === "ask-real" && f2.archive.lastSelection.selectedCount === 1, "실제 서랍(appendSelectorUsage)에서도 뒤의 정리 영수증이 아니라 검증 선별 행을 고른다"); }
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({}));
  ok(RF.rulesFlowFor(ws, { lang: "ko" }).core.st === "unapproved" && RF.rulesFlowFor(ws, { lang: "ko" }).core.injectedChars === 0, "승인 전=unapproved·0글자(주입 없음)");
  fs.writeFileSync(path.join(ws, "verify-envelope.json"), "{ broken");
  ok(RF.rulesFlowFor(ws, { lang: "ko" }).core.st === "corrupt", "파일 손상=corrupt(카드는 그대로 그려짐)"); }

console.log("[4] 개요 카드 소스 계약 — 항상 4칸·빈 상태 문장·설정 탭은 승인·편집만·gotoEl 단일 경로");
{ const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/id="ovRulesFlow"/.test(ext) && ["rfCore", "rfArchive", "rfProposals", "rfCurator"].every((id) => ext.includes('id="' + id + '"')), "개요 패널에 4칸(항상 존재)");
  const b = ext.indexOf("function rfWhen(ts){"); const e = ext.indexOf("function decideActs(d){", b); // rfWhen·rfSet·renderRulesFlow 세 함수 블록
  ok(b > 0 && e > b, "렌더 함수 블록");
  const blk = ext.slice(b, e);
  ok(blk.includes("지금 제안 없음") && blk.includes("다음 검사: 훅 ") && blk.includes("일 미사용 관측") && blk.includes("관련될 때만 적용되는 수칙 0항 · 정리 담당이 제안하면 채워집니다"), "빈 상태 문장(제안 0=왜 비었는지·서고 0)");
  ok(blk.includes("글자가 검증 요청마다 실려요(비용 근거)") && blk.includes("a.selectCap.items") && blk.includes("a.count+\"/\"+a.max"), "비용 근거 숫자(주입 글자 수·선별 상한·서고 상한)");
  ok(!/innerHTML/.test(blk) && blk.includes("document.createElement(\"details\")") && blk.includes("u.lastItems"), "정리 담당 마지막 제안=인라인 접기(details)·innerHTML 없음");
  ok(blk.includes("자료 없음 — 브릿지 장부를 읽지 못했어요"), "자료 없음(null)도 4칸 문장");
  ok(!ext.includes('if(d.curation){ // [CURATION v3 §3 E·F] 수칙 카드 1줄') && !ext.includes('m?.type === "curationShow"'), "설정 탭 정리 줄·모달 버튼 제거(승인·편집만)");
  ok(/id="rfGoSetup"/.test(ext) && /rfg\.addEventListener\("click", function\(\)\{ var t0=\$\("envCard"\); if\(t0 && t0\.style\.display!=="none"\)\{ gotoEl\(t0\); \}/.test(ext), "개요→검증 설정 이동=gotoEl 단일 경로");
  ok(ext.includes('safe(function(){ renderRulesFlow(d); });') && ext.includes('RF9.rulesFlowFor(ws, { lang: loadLangExt() })'), "상태 배선(rulesFlowFor)·렌더 디스패치");
  const dBeg = ext.indexOf("function decideActs(d){"); const dEnd = ext.indexOf("function renderOverview(d){", dBeg);
  ok(!/rulesFlow/.test(ext.slice(dBeg, dEnd)), "'지금 정할 것' 합산에 미편입(수칙 흐름은 정보)");
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  ok(outSrc.includes("rules-flow.js") && outSrc.includes("renderRulesFlow"), "컴파일 산출물 반영"); }

console.log("[5] 배포 편입 — 3사본에 rules-flow.js");
{ const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8"), hs = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8"), mc = fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8");
  ok(inst.includes('"rules-flow.js"') && hs.includes('"rules-flow.js"') && mc.includes('"rules-flow.js"'), "install.js·hook-setup.ts·map-cutover.js"); }

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
