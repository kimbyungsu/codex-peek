#!/usr/bin/env node
// Claude ↔ Codex 브릿지 (일시 대체제)
// - 연결 정보를 영속 저장(Claude 세션id + 워크스페이스 키) → 내 기억과 무관하게 유지.
// - ask: 연결된 Codex 세션으로 resume. 연결 없으면 "보고만"(새 세션 안 만듦). 첫 소통은 --allow-new로 명시 생성.
// - 정책은 스크립트가 강제하고, raw codex 직접호출은 PreToolUse 후크(codex-guard.js)가 차단한다.
//
// 사용:
//   node codex-bridge.js ask "<프롬프트>"          연결된 세션에 보내고 답 받기 (없으면 보고)
//   node codex-bridge.js ask --allow-new "<...>"   연결 없을 때 새 세션 생성+연결 후 보내기 (첫 소통)
//   node codex-bridge.js ask --force-new "<...>"   엉뚱 폴더 방어를 무릅쓰고 '이 폴더'에 새 세션 강제(--allow-new 함의)
//   node codex-bridge.js ask --force-resend "<...>" 같은 요청 진행 중 차단(중복 전송 가드)을 의식적으로 우회
//   node codex-bridge.js ask --net "<...>"          이 1회만 검증자 네트워크 허용(파일 읽기전용 유지) — 원격(GitHub 등) 직접 확인용
//   node codex-bridge.js link <codex-session-id>   현재 Claude 세션을 기존 Codex 세션에 연결
//   node codex-bridge.js link --last               가장 최근(인덱스된) Codex 세션에 연결
//   node codex-bridge.js status                    현재 연결 상태
//   node codex-bridge.js find                       연결 후보(인덱스된 Codex 세션) 목록

const { spawnSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { undisposedOpenFindingsFromRows } = require("./contract-lib.js");
const { claudeAnchorFolderChange, folderChangeRefusal, clearClaudeFolderChange, contractDefaultsNotice, fitDefaultsNotice, HEAD_BUDGET, headBudgetTotal, applyReferenceBudgets, deliveryPlanFor, deliveryStatusLine, writeDirectiveDelivery, readDirectiveDelivery, rolloutCompactedAfter, readDecisions, openDecision, resolveDecision, decisionMetrics, renderDecisionBlock, loadDecisionTemplate, saveDecisionTemplate, DECISION_TEMPLATE_DEFAULTS, DECISION_DELEGATE_KEY, DECISION_KINDS, DECISION_NO_DEFAULT_MIN, JUDGE_CHOICES, readJudgeRequired, addJudgeRequired, resolveJudgeRequired, askShapeCheck, askShapeNotice, appendAskShape, appendAttachUsage, verifierBaselineFor, VERIFIER_PROVIDERS, normVerifierProvider, patchContractFields, loadContract, contractReadState, buildInjection, buildScoutAttach, loadBaseDirective, atomicWrite, readPhase, writePhase, appendIntegrityEvent, supersedeIntegrity, maybeCleanupState, extractVerdict, formatForClaude, safeLoadRejudge, REJUDGE_SNAP_MAX, parseFindingsBlock, judgeMachineVerdict, safeBacklogAutoTitle, safeBacklogAutoFile, machineReasonText, backlogAdd, configWs, appendVerdict, loadLang, appendLedgerEvent, readLedgerEventsText, ledgerPathsFromText, resolveScoutRepo, envelopeInjectionFor, envelopeCoreQualifier, envelopeIntegrityQualifier, readVerifyEnvelope, readEnvelopeProposal, writeEnvelopeProposal, discardEnvelopeProposal, envelopeTransState, recoverEnvelopeTransition, acquireEnvelopeTransLock, releaseEnvelopeTransLock, envelopeTransWalFileFor, envelopeCandidateId, repoKeyOf, constraintRepoKeyFor, readEnvelopeCandidates, appendEnvelopeCandidates, reconcileMemoryCandidates, draftEnvelopeCandidate, ENVELOPE_CANDIDATE_STATUSES, freezeEnvelopeForAsk, writeEnvelopeFreeze, readFrozenEnvelope, readFrozenEnvelopeRec, judgeAdmission, deriveRoundType, openFindingsFor, newFindingId, appendFindingsLedger, readFindingsLedger, FINDING_DISPOSITIONS, FIX_GAP_NOTICE_AT, dispositionsFor, undisposedOpenFindings, fixGapCount, findingActivityRound, dispositionValid, readFindingsLedgerState, campaignFileFor, normBacklogTitle, appendScoutTargetEvidence, askInflightGuard, askInflightFileFor, claimAskInflight, reclaimAskInflight, overwriteAskInflight, clearAskInflight, readAskActive, askActiveGuard, claimAskActive, updateAskActive, clearAskActive, askActiveFileFor, acquireSessionLease, releaseSessionLease, readSessionLease, clearSessionLease, ackIntegrityEvents, readIntegrityEvents, verifyTimeoutMin, readCodexActive, withRoleLock, freezeImplementerContext, effectiveVerifyProfile, VERIFY_PROFILES, claudeCampaignAnchor, reserveVerifyCampaign, writeDurableProofV2, writeRecoveryReceipt, durableJobSnapshotOk, askJobIdOk, recoveryReceiptFileFor, receiptSettled, constraintTurnContext, constraintAdd, CONSTRAINT_QUOTE_MIN, CONSTRAINT_QUOTE_MAX, CONSTRAINT_WHY_MAX, CONSTRAINT_TURN_CAP, ENVELOPE_DRAFTABLE_KINDS, envelopeMarkGuard, constraintHarvestFromAnswer, buildAbManifest, boundaryGenOf, readVerifyEnvelopeArchive, SELECTOR_PAGE_ITEMS, selectorDeadlineMsFor, selectorScopeMaterial, SELECTOR_UNION_MAX, SELECTOR_UNION_BYTES_MAX, readSelectorUsage } = require("./contract-lib.js");

// 사용자 요청 앞에 [검증 기본 원칙](기본 지침, 오버라이드 가능) + Codex 고정 계약을 prepend(매 ask마다).
// 기본 지침은 contract-lib의 loadBaseDirective()에서 로드 → 대시보드에서 보기/수정/초기화 가능. 코드에 캐논 기본값 상존.
// 호출 시점 전역 언어의 문자열 선택(무결성 detail·CLI 안내 등). ask 본문 흐름은 langSnap 사용.
function tB(ko, en) { return loadLang() === "en" ? en : ko; }
// 거버넌스 증분 1: 판정문 병기 경고 — 승인된 경계가 '손상/미승인 변경' 상태면 ask-wait 결과에 1줄 병기(위장 금지).
// 정상·부재·미승인="" (바이트 동일 — 기존 출력 무회귀).
function envelopeWarnLine(ws, lang) {
  // 보완②(1차 구현검증): 이 함수는 '완료 시점 재판독'이라 이번 ask에 실제 주입됐는지는 모른다 — 문구를 '현재 상태'
  // 서술로 한정(주입 여부 단정 금지). ask 시점 주입 상태의 내구 보존은 증분 2 라운드 레코드(envelopeHash 동결) 소관.
  try {
    const c9 = loadContract(ws || configWs(), lang);
    const evi = envelopeInjectionFor(resolveScoutRepo(ws || configWs(), c9).repo, c9.envelopeHash, lang);
    const en9 = (lang || loadLang()) === "en";
    if (evi.warn === "mismatch") return en9 ? "\n[verification envelope: the rulebook now differs from the approved copy — new verifications will not inject it until re-approval (dashboard)]\n" : "\n[검증 경계: 수칙서 파일이 지금 승인본과 다릅니다 — 재승인 전까지 새 검증에 주입되지 않습니다(대시보드에서 재승인)]\n";
    if (evi.warn === "corrupt") return en9 ? "\n[verification envelope: the rulebook file is currently unreadable — new verifications will not inject it]\n" : "\n[검증 경계: 수칙서 파일이 지금 판독 불가 상태입니다 — 새 검증에 주입되지 않습니다]\n";
    if (evi.warn === "truncated") return en9 ? "\n[verification envelope: some items are truncated by the caps — the injected boundary omits the excess; trim the file and re-approve]\n" : "\n[검증 경계: 일부 항목이 상한 초과로 절삭된 상태로 적용 중 — 초과분은 경계에서 빠져 있습니다. 파일을 줄여 재승인 권장]\n";
  } catch { /* 무해 — 경고 계층이 결과 전달을 막지 않음 */ }
  return "";
}
// ── 검증자 프롬프트 머리의 상한(검증 [주의] 반영) ─────────────────────────────────────────
// 이 머리는 매 회차 검증자에게 통째로 실려 간다. 지금까지 총량 상한이 없어, 열린 지적이 쌓이거나
// 지도 이름이 길거나 계약 규칙이 늘면 머리가 계속 부풀고 정작 사용자 요청문이 뒤로 밀렸다.
// 원칙 두 가지: ①조각별로 막는다(총량에서 통째로 잘라내면 승인 정책 같은 계약이 사라질 수 있다)
//              ②조용히 자르지 않는다 — 생략한 개수와 사유를 항상 밝힌다.
// ⚠ 열린 지적 목록에는 개수 상한을 두지 않는다 — 자르면 숨은 지적의 id를 인용할 수 없고
//   '미인용=신규 취급'이라 이력이 끊긴다('구현모델 선별 금지' 계약). 그 자리 주석 참조.
const CONTRACT_INJ_MAX = HEAD_BUDGET.contract;  // 계약 주입(사용자 규칙·체크리스트) 최대 문자 — 파생 총량(HEAD_BUDGET)과 같은 출처
// [§4-B ② · 확인 검증 2회차 blocker(ab-6)] postflight 보류(검증 도중 압축/기록 판독 불가)는 '정직 실패'로 닫는다 — 출력은 그대로 내고 비0 종료.
// 내구 경로에서 worker가 job을 failed로 기록하므로 ask-wait이 영수증 없이 출력을 돌려주고(succeeded+proof 없음=영원한 proof-missing 순환 차단),
// 같은 턴의 새 ask-start도 막히지 않는다(미회수 검사는 succeeded만 본다). 통과 증명·체크포인트는 기록되지 않는다.
const HOLD_EXIT_CODE = 4;
const HEAD_SOFT_LIMIT = headBudgetTotal();  // [개선 4 (c)] 총량=조각 상한의 합(파생) — 넘으면 조각별 길이를 stderr+경보 1건으로 알린다(차단 아님·시작 거부 없음)
// 계약 규칙이 상한을 넘는지 '아무것도 예약하기 전에' 판정한다. 여기서 die하면 왕복도 phase도 그대로다.
// 문구는 withContract의 throw와 같은 뜻이어야 한다(두 자리가 갈리면 사용자가 다른 안내를 받는다).
function contractInjectionTooLongMsg(len, en) {
  return en
    ? `Contract rules/checklist are ${len} characters (cap ${CONTRACT_INJ_MAX}). Verification was NOT started and no round was consumed — running without your saved rules would stamp a pass that never applied them. Shorten them in the dashboard, then retry.`
    : `계약 규칙·체크리스트가 ${len}자입니다(상한 ${CONTRACT_INJ_MAX}). 검증을 시작하지 않았고 왕복도 쓰지 않았습니다 — 저장한 규칙 없이 진행하면 그 규칙이 적용되지 않은 통과가 됩니다. 대시보드에서 줄인 뒤 다시 시도하세요.`;
}
function assertContractInjectionFits(ws, contractSnap, harnessModeSnap, lang) {
  let len = 0;
  try {
    const c = contractSnap || {};
    const rules = harnessModeSnap === "codex-codex" ? c.codexVerifier : c.codex;
    const list = harnessModeSnap === "codex-codex" ? c.codexVerifierChecklist : c.codexChecklist;
    len = String(buildInjection(rules, harnessModeSnap === "codex-codex" ? "Codex Verifier" : "Codex", list, lang) || "").length;
  } catch { return; } // 판독 실패는 여기서 막지 않는다(withContract의 기존 try/catch가 담당)
  if (len > CONTRACT_INJ_MAX) die(contractInjectionTooLongMsg(len, (lang || loadLang()) === "en"), 3);
}
function withContract(prompt, ws, lang, carrier, profile, contractSnap, askId9p) {
  // lang: 언어 스냅샷(cmdAsk의 langSnap) — 미지정 시 전역 언어. 주입(기본지침·계약 지시문)과 헤더/footer 언어를 한 스냅샷으로 일관.
  // carrier(L1-A): 호출자가 준 객체에 '이번 ask에 실제로 실린 동봉 스냅샷'(mapItems·couplings)을 담아 준다 —
  // 확인 판정(flagLedgerConfirms)이 '지금 다시 계산한 동봉'이 아니라 '전송된 그 동봉'으로 echo를 판정하게(Codex 설계검증).
  // [머리 다이어트] baseline은 경계 절 산출 뒤에 조립한다 — v2 서식 절이 실제로 실리는지(envText 실물)를 보고 블록 서식을 위임/전문으로 고른다(아래).
  let inj = "", scout = "", c = null, attSnap9 = null;
  try {
    // 계약은 '연 폴더(configWs)' 기준으로 로드 — cmdAsk가 modelPref·proof·라벨·withContract에 같은 configWs 스냅샷(ws)을
    // 넘겨, 작업 cwd가 외부 폴더로 흔들려도 사용자가 연 폴더에 건 계약이 일관 적용된다(인자 없으면 configWs()로 폴백).
    // (resolveLink/recordLink도 configWs 기준 — 세션은 작업 cwd가 아니라 이 대화의 연 폴더에 묶인다.)
    // 호출자가 이미 잡아둔 스냅샷이 있으면 그것을 쓴다 — 여기서 다시 읽으면 사전 검사(예약 전)와
    // 조립(예약 후)이 서로 다른 계약을 볼 수 있다. 그 사이 대시보드가 계약을 늘리면 왕복은 이미
    // 소진됐는데 '왕복도 쓰지 않았다'는 안내가 나간다(검증 blocker).
    c = contractSnap && typeof contractSnap === "object" ? contractSnap : loadContract(ws || configWs(), lang);
    const verifierRules = c.harnessMode === "codex-codex" ? c.codexVerifier : c.codex;
    const verifierChecklist = c.harnessMode === "codex-codex" ? c.codexVerifierChecklist : c.codexChecklist;
    inj = buildInjection(verifierRules, c.harnessMode === "codex-codex" ? "Codex Verifier" : "Codex", verifierChecklist, lang);
  } catch {
    inj = "";
  }
  // Phase 3 동봉은 별도 try — 새 기능(지도 동봉) 실패가 기존 계약 주입(inj)까지 지우지 않게(모든 ask의 급소 분리).
  try {
    const att = c ? mapAttachSurface(ws || configWs(), c, lang, prompt) : null; // 검색 4조각: 요청문을 지도 선별까지 전달(설계 3단계)
    if (att && typeof att === "object") {
      scout = att.text || "";
      if (carrier && typeof carrier === "object") carrier.attachParts = att.parts && typeof att.parts === "object" ? att.parts : (scout ? { map: scout, _legacy: true } : null); // [개선 4 (c)] 예산 적용은 아래(선별 초과분 확정 뒤)
      if (carrier && typeof carrier === "object") { carrier.mapItems = att.mapItems || []; carrier.couplings = att.couplings || []; }
      // [개요 카드] 동봉 스냅샷 캡처만 — 기록은 아래 조립 검사(fail-closed) 통과 뒤에(차단된 ask의 미전송 행 방지·검증 [주의]).
      attSnap9 = { items: (att.mapItems || []).slice(0, 12).map((it) => ({ path: String(it.path || ""), note: String(it.note || "").slice(0, 160) })), couplings: (att.couplings || []).length, omitted: /\[Project MAP (동봉 생략|omitted)\]/.test(att.text || "") };
    } else scout = att || ""; // 구형 문자열 반환 호환(테스트 목·부분 배포)
  } catch { scout = ""; }
  // 거버넌스 증분 1: 검증 경계(사용자 승인 수칙서) — 승인 지문 일치 시에만 주입(데이터 절=두 프로필 공통·한정 문구=core만).
  // 부재·미승인=주입 없음(현행 그대로)·손상/미승인 변경=주입 생략+stderr 1줄 경고(ask 시작 출력 — 위장 금지).
  let envText = "", baseQual = "", v2Attached = false, envData = "", v2Static = "", v2Data = "";
  try {
    const es9 = envelopeSliceFor(ws || configWs(), lang, profile, c);
    envText = es9.envText; baseQual = es9.baseQual; v2Attached = es9.v2Attached === true;
    envData = es9.envData || ""; v2Static = es9.v2Static || ""; v2Data = es9.v2Data || "";
    if (carrier && typeof carrier === "object") carrier.selOver = es9.selOver || null; // [§4-B ④] 서고 선별 정상 범위 초과 표시(판정 하단 정보 행)
    // [기억 권위 C-1] 전송된 그 경계의 실물을 carrier에 고정 — 판정 후 파서(제약 처리 표기)가 '동봉된 abId만'
    // 인정하게(결합확인 byId 결속과 동형). id는 위치 결정론(ab-1..n)이라 축별 개수+지문이면 재구성 충분.
    if (carrier && typeof carrier === "object" && es9.envAxes) {
      const mk9 = (pfx, n) => Array.from({ length: n }, (_, i) => pfx + "-" + (i + 1));
      carrier.envelope = { hash: es9.envSha || null, sup: mk9("sup", es9.envAxes.supportedEnv || 0), ab: mk9("ab", es9.envAxes.alwaysBlocker || 0), oos: mk9("oos", es9.envAxes.outOfScope || 0) };
    }
  } catch (e0) { if (e0 && (e0.envelopeTransBusy || e0.selectorDrift || e0.envelopeDrift)) throw e0; /* envelopeDrift=승인 없는 변경(경계 통일·ab-3)=정직 실패 */ /* 상호배제 실패·[3b] 서고 선별 드리프트=ask 정직 실패(경계 없는/선별 없는 프롬프트 생성 금지 — 삼키면 '선별 없는 판'이 조용히 진행된다). 그 외 경계 실패=주입만 생략(검증은 현행 규약으로 진행) */ }
  // 계약 규칙은 사용자가 '이렇게 검증하라'고 저장한 요구다. 길어서 뺀 채로 검증을 진행하면
  // 그 요구가 적용되지 않았는데 통과 도장이 찍힌다 — 검증 통과 위조 경로다(검증 blocker).
  // 그래서 잘라 붙이지도, 빼고 진행하지도 않는다. ask 자체를 멈추고 줄이라고 요구한다(fail-closed).
  // 같은 파일의 경계 판독 상호배제 실패와 같은 방식(정직 실패 — 규칙 없는 프롬프트 생성 금지).
  // 이중 방어 — 정상 경로는 위 assertContractInjectionFits가 예약 전에 이미 막는다.
  // 여기까지 온다면 그 사전 검사를 거치지 않은 호출자이므로, 프롬프트를 만들지 않고 올린다.
  if (inj && inj.length > CONTRACT_INJ_MAX) {
    throw Object.assign(new Error(contractInjectionTooLongMsg(inj.length, (lang || loadLang()) === "en")), { exitCode: 3, contractTooLong: true });
  }
  // [머리 다이어트 2026-08-06] 같은 머리에 [지적 서식 v2] 절이 실물로 실리면 기계 서식의 v1 블록 설명은
  // 중복이다(같은 규칙 2회 설명·~400자/ask) — 위임 1줄로 교체. 판정은 가정이 아니라 envText 내용 실물로.
  // 위임 판정=envelopeSliceFor가 v2 절을 실제로 붙인 지점의 구조적 표지(재검증 blocker: envText 문자열
  // 검사는 수칙서 데이터의 표제 문자열로 오발동해 integrity 경로의 블록 서식을 비웠다 — 데이터로 산문 판정 금지).
  const baseline = verifierBaselineFor(lang, profile, v2Attached ? "delegated" : undefined); // 자유 문안+기계 서식(코드 고정 — 편집 개방과 무관하게 항상 동봉)
  // [§4-B ①② 규약 1회 전달] carrier.delivery(검증자 세션·rollout)가 있으면 전달 계획을 세운다 — 없음(무상태 검증자·시험 목)=종전 전문(무회귀).
  // 성분 지문은 '이 ask에서 조립한 실물'로 계산(시작 시 동결 — 검증 도중 편집은 다음 ask부터). 사용자 글(계약 규칙)은 바이트 그대로.
  let dlvPlan = null, statusLine = "";
  if (carrier && typeof carrier === "object" && carrier.delivery && typeof carrier.delivery === "object") {
    const parts9 = { baseline, qual: baseQual, v2fixed: v2Attached ? v2Static : "", contract: inj, profile: String(profile || ""), lang: String(lang || loadLang()) };
    dlvPlan = deliveryPlanFor({ session: carrier.delivery.session, rolloutFile: carrier.delivery.rolloutFile, parts: parts9, first: carrier.delivery.first === true });
    statusLine = deliveryStatusLine(dlvPlan, lang || loadLang());
    carrier.deliveryOut = { mode: dlvPlan.mode, reason: dlvPlan.reason, gen: dlvPlan.gen, parts: dlvPlan.parts, changed: dlvPlan.changed || [], compactedAt: dlvPlan.compactedAt || null, prevSentAt: dlvPlan.prev ? dlvPlan.prev.sentAt : null, statusLine };
  }
  // [P7 ⓒ 2026-09-01] 프로필·상한 설정이 없는 폴더=기본값으로 도는 검증 — 요청 머리(상태 줄 자리)·판정 꼬리 양쪽에 같은 1줄 고지(조용한 기본값 금지).
  // 상태 줄은 '머리 첫 줄=판정 꼬리=기록' 한 문자열 불변식이 있어 고지를 그 안에 붙이지 않는다 — 머리에서는 상태 줄 다음의 독립 줄, 꼬리에서는 독립 줄.
  const defaultsNotice = fitDefaultsNotice(statusLine, contractDefaultsNotice(ws || configWs(), lang || loadLang(), c)); // 상태 줄+고지 ≤ HEAD_BUDGET.statusLine(확인 검증 1회차 blocker)
  if (defaultsNotice && carrier && typeof carrier === "object") carrier.defaultsNotice = defaultsNotice;
  // [개선 4 (c)] 참고 자료(경위·지도·결합·정찰)에만 조각별 예산 — 권위 자료는 절단 없음. 선별 초과분(바이트)은 참고 예산에서 순서대로 차감.
  if (carrier && typeof carrier === "object" && carrier.attachParts) {
    const parts9 = carrier.attachParts; const legacy9 = parts9._legacy === true;
    const rb9 = applyReferenceBudgets(legacy9 ? { map: parts9.map } : parts9, lang || loadLang(), { shrinkBytes: carrier.selOver ? carrier.selOver.excessBytes : 0, singleCap: legacy9 });
    scout = rb9.text; carrier.refClipped = rb9.clipped;
    if (rb9.clipped.length) { try { process.stderr.write((lang === "en" ? "[reference budget] clipped: " : "[참고 자료 예산] 절단: ") + rb9.clipped.map((c9) => `${c9.part} ${c9.from}→${c9.to}`).join(" · ") + "\n"); } catch { /* 안내 실패 무해 */ } }
  }
  const slim9 = !!(dlvPlan && dlvPlan.mode === "slim");
  // slim=상태 줄+데이터(경계 데이터·서고 선별·열린 지적·되받아침·지도)만 / full=상태 줄+전문(종전 머리 그대로)
  const head = slim9
    ? [statusLine, defaultsNotice, envData, v2Data, scout].filter(Boolean).join("\n\n")
    : [statusLine, defaultsNotice, baseline, baseQual, envText, inj, scout].filter(Boolean).join("\n\n"); // [P7 ⓒ] 기본값 고지=상태 줄 다음 독립 줄
  // 총량은 막지 않고 '보이게' 한다 — 통째로 잘라내면 승인 정책 같은 계약이 사라질 수 있다.
  // 어느 조각이 부풀었는지 알려야 사람이 그 자리를 줄일 수 있다.
  // [개선 4 (c)] 총량 측정=열린 지적 데이터(v2Data) 제외 — 열린 지적은 예산 밖·캠페인 유계(회차 ≤5 × 판당 행 상한). 파생 상한 초과=코드 결함 신호(경보 1건·차단 없음).
  const headMeasured9 = head.length - (slim9 || v2Attached ? v2Data.length : 0);
  if (headMeasured9 > HEAD_SOFT_LIMIT) {
    const parts = `기본원칙 ${baseline.length} · 경계한정 ${baseQual.length} · 승인정책 ${envText.length} · 계약 ${inj.length} · 지도 ${scout.length} · 규약전달 ${slim9 ? "상태줄" : "전문"} · 열린지적(예산 밖) ${v2Data.length}`;
    try { process.stderr.write(`⚠️ 검증자 프롬프트 머리가 ${headMeasured9}자입니다(파생 상한 ${HEAD_SOFT_LIMIT} — 조각 상한의 합) — ${parts}\n`); } catch { /* 안내 실패가 검증을 막지 않음 */ }
    try { appendIntegrityEvent({ ts: new Date().toISOString(), session: claudeId(), workspace: ws || configWs(), kind: "head-budget", severity: "warning", detailKo: `검증자 머리 ${headMeasured9}자가 파생 상한 ${HEAD_SOFT_LIMIT}을 넘음(코드 결함 신호·검증은 진행) — ${parts}`, detailEn: `verifier head ${headMeasured9} chars exceeds the derived cap ${HEAD_SOFT_LIMIT} (code-defect signal; verification proceeds) — ${parts}` }); } catch { /* best-effort */ }
  }
  // [개요 카드] 조립 검사(경계 상호배제·계약 상한) 통과 뒤에만 기록 — 차단된 ask는 행을 남기지 않는다.
  // 기록 실패·이후 발송 실패의 잔여 위험은 화면이 '마지막 동봉 기록 시각'을 함께 표시해 정직화(단정 금지).
  const so9 = carrier && carrier.selOver && (carrier.selOver.items || carrier.selOver.bytes) ? { count: Number(carrier.selOver.count || 0), bytesTotal: Number(carrier.selOver.bytesTotal || 0), itemsMax: SELECTOR_UNION_MAX, bytesMax: SELECTOR_UNION_BYTES_MAX } : null; // [§7 4-2b] 대시보드 서고 카드 초과 표기 재료(행 기록 조건은 아래 그대로)
  if (attSnap9 || (carrier && carrier.envelope)) {
    try {
      // [기억 권위 C-1·구현검증 1차 blocker①] askId=실행 UUID(호출자가 verdicts 행과 같은 값을 전달 — 두 원장 조인 키).
      // env 잡 id는 폴백(내구 경로 감사용). 경계 실물은 '개수'가 아니라 축별 id 배열 그대로(어떤 ab-N이 실렸는지 결속).
      // 지도 미동봉(mapMode off 등)이어도 경계(envelope)가 실렸으면 행을 남긴다 — 경계 영수증이 지도에 종속되지 않게.
      const askId9 = askId9p || (typeof process.env.CODEX_BRIDGE_ASK_JOB_ID === "string" && process.env.CODEX_BRIDGE_ASK_JOB_ID ? process.env.CODEX_BRIDGE_ASK_JOB_ID : "");
      const env9 = carrier && carrier.envelope ? { hash: carrier.envelope.hash, sup: carrier.envelope.sup.slice(), ab: carrier.envelope.ab.slice(), oos: carrier.envelope.oos.slice() } : null;
      appendAttachUsage({ ts: new Date().toISOString(), ws: ws || configWs(), askId: askId9, items: attSnap9 ? attSnap9.items : [], couplings: attSnap9 ? attSnap9.couplings : 0, omitted: attSnap9 ? attSnap9.omitted : false, mapAbsent: !attSnap9, ...(env9 ? { envelope: env9 } : {}), ...(so9 ? { selOver: so9 } : {}) });
    } catch { /* best-effort */ }
  }
  const reqLabel = (lang || loadLang()) === "en" ? "[Work Request]" : "[작업 요청]";
  return `${head}\n\n---\n${reqLabel}\n${prompt}`;
}

// §7 증분 2 — 경계 절 산출(전이 잠금 아래·구 스냅샷 무사용). cSnapshot은 '잠금 밖에서 읽힌 계약'이며 경계
// 축에는 사용하지 않는다(잠금 안 신선 재판독 — f-b6db1bbd 인터리빙 봉합). 함수로 분리한 이유: 테스트가
// 낡은 스냅샷(구 해시)을 인자로 직접 주입해 '스냅샷을 썼다면 실패했을' 결정론 반례를 실행하기 위함(f-789aadc5).
function envelopeSliceFor(wsIn, lang, profile, cSnapshot) {
  const out9 = { envText: "", baseQual: "", v2Attached: false, envAxes: null, envSha: null, envData: "", v2Static: "", v2Data: "", selOver: null }; // [§4-B] envData=데이터 절만·v2Static=고정 산문·v2Data=열린 지적 등 데이터 // [기억 권위 C-1] 주입 실물(축별 항목 수+지문) — 잠금 안에서 고정
  const c = cSnapshot;
  {
    if (c && typeof envelopeInjectionFor === "function") {
      // §7 증분 2(재검증 blocker③ ab-3): 판독·동결을 '전이 잠금 보유' 아래에서 — 도장 전이(원본↔계약 두 저장소
      // 교체)와 원자적 상호배제. 잠금 실패(전이 진행)=짧은 재시도 후 이 ask를 정직 실패(경계 없는 프롬프트 생성 금지).
      // WAL 잔존(중단 전이)도 동일 거부 — 복구 전 새 검증 시작 차단.
      let lk9 = null;
      for (let i9 = 0; i9 < 5 && !lk9; i9++) { const a9 = acquireEnvelopeTransLock(wsIn); if (a9.ok) lk9 = a9; else { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } catch { /* 즉시 재시도 */ } } }
      if (!lk9) throw Object.assign(new Error("수칙서 승인 전이 진행 중 — 경계 판독 상호배제 실패(잠시 후 재시도)"), { envelopeTransBusy: true });
      try {
        try { fs.accessSync(envelopeTransWalFileFor(wsIn)); throw Object.assign(new Error("중단된 수칙서 승인 전이(WAL) — envelope-transition recover 후 재시도"), { envelopeTransBusy: true }); } catch (e9w) { if (e9w && e9w.envelopeTransBusy) throw e9w; /* WAL 없음=정상 */ }
      // 재재검증 blocker②(ab-3): 계약 해시·대상 산출을 잠금 '안'에서 신선 재판독 — 잠금 밖 스냅샷 c의
      // envelopeHash를 쓰면 '구 계약 읽기→전이 완료→잠금 획득→구 해시로 신 원본 판독=mismatch 무주입' 경합.
      let cFresh9 = c;
      { // [경계 통일 · 검증 5회차 blocker(ab-3)] loadContract는 부재·손상을 기본 계약(승인 지문 null)으로 정규화해 `|| c` 폴백이 작동하지
        // 않는다 → 엄격 판독기로 먼저 상태를 본다: 손상=검증 미실행 / 부재인데 스냅샷엔 승인 지문이 있었음=검증 미실행(승인 소실) /
        // 부재+승인 이력 없음=legacy 기본값(정상 진행).
        const st9 = contractReadState(wsIn, lang);
        if (st9 === "corrupt" || (st9 === "absent" && c && typeof c.envelopeHash === "string" && c.envelopeHash)) throw Object.assign(new Error(lang === "en" ? `⚠️ The project contract file is ${st9 === "corrupt" ? "unreadable" : "missing"} at send time — verification was not run (the approved rules cannot be resolved).` : `⚠️ 전송 직전 프로젝트 계약 파일이 ${st9 === "corrupt" ? "손상" : "사라짐"}돼 승인 수칙을 판정할 수 없어 검증을 실행하지 않았습니다.`), { envelopeDrift: true, exitCode: 3 });
        try { cFresh9 = loadContract(wsIn, lang) || c; } catch { throw Object.assign(new Error("전송 직전 계약 재판독 실패 — 검증을 실행하지 않았습니다"), { envelopeDrift: true, exitCode: 3 }); }
      }
      const target9 = resolveScoutRepo(wsIn, cFresh9).repo;
      const evi = envelopeInjectionFor(target9, cFresh9.envelopeHash, lang);
      const en9 = (lang || loadLang()) === "en";
      // [Envelope Selector v7 §3 — 3b] 서고 선별 결과 결속: 내구 job의 worker 선별을 '주입 직전' 같은 전이
      // 잠금 안에서 재검사(서고 지문·변경물 지문 — 어느 쪽 드리프트든 중단)하고, 절 주입·manifest 합류를
      // 준비한다. 실패=정직 예외(선별자가 본 규칙·코드와 검증자가 볼 규칙·코드의 동일성 결속 — 위장 금지).
      let sel9 = null, selArc9 = null; const selTexts9 = []; let selTextsEn9 = null;
      {
        const failSel = (why) => { throw Object.assign(new Error((en9 ? "[archive rules] " : "[서고 수칙] ") + why + (en9 ? " — this verification was not started (a fresh selection is required; restart with ask-start)." : " — 이번 검증을 시작하지 않았습니다(새 선별 필요 — ask-start로 다시 시작하세요).")), { selectorDrift: true }); };
        const dj9 = process.env.CODEX_BRIDGE_JOB_PROMPT_FILE ? readCanonicalEnvJob(wsIn) : null;
        const rawSel9 = dj9 && dj9.ok && dj9.job && dj9.job.selection && typeof dj9.job.selection === "object" && !Array.isArray(dj9.job.selection) ? dj9.job.selection : null;
        const archActive9 = typeof cFresh9.archiveHash === "string" && !!cFresh9.archiveHash;
        if (archActive9 || rawSel9) {
          if (!rawSel9) failSel(en9 ? "approved archive active but this run carries no selection result (non-durable or pre-selector job)" : "승인 서고 활성인데 이 실행에 선별 결과가 없습니다(내구 경로 밖 또는 선별 이전 job)");
          if (!archActive9) failSel(en9 ? "a selection result exists but the contract has no archive stamp (unstamp drift)" : "선별 결과가 있는데 계약의 서고 승인 지문이 없습니다(도장 해제 드리프트)");
          if (evi.st !== "ok") failSel((en9 ? "core rulebook not injectable (" : "코어 수칙서가 주입 불가 상태(") + evi.st + (en9 ? ") while an archive selection is bound" : ")인데 서고 선별이 결합돼 있습니다"));
          const arc9 = readVerifyEnvelopeArchive(target9);
          if (arc9.st !== "ok" || arc9.sha1 !== cFresh9.archiveHash || arc9.sha1 !== rawSel9.archiveHash) failSel(en9 ? "the archive file differs from selection time (drift)" : "서고 파일이 선별 시점과 다릅니다(드리프트)");
          const sc9 = selectorScopeMaterial(target9);
          if (sc9.st !== "ok") failSel((en9 ? "changed-files bundle unreadable (" : "변경물 꾸러미 판독 실패(") + String(sc9.reason) + ")"); // [1차 blocker 봉합] 판독 실패=중단 — 빈 지문 동률로 drift 관문을 통과하는 fail-open 차단
          if (sc9.hash !== rawSel9.scopePackageHash) failSel(en9 ? "the changed-files bundle differs from selection time (drift)" : "변경물 꾸러미가 선별 시점과 다릅니다(드리프트)");
          if (!Array.isArray(rawSel9.selectedIds)) failSel(en9 ? "selection record malformed" : "선별 결과 형식 손상");
          for (const idd of rawSel9.selectedIds) {
            const nm9 = /^arc-(\d+)$/.exec(String(idd));
            const tx9 = nm9 ? arc9.data.alwaysBlocker[Number(nm9[1]) - 1] : undefined;
            if (typeof tx9 !== "string") failSel(en9 ? "a selected id falls outside the archive range" : "선별 id가 서고 범위를 벗어났습니다");
            selTexts9.push(tx9);
          }
          // [§4-B ④ 격하] 12항·4,000바이트 초과=실패가 아니라 '정상 범위 초과' 표시 — 승인 수칙은 한 항목도 빼지 않고 전량 싣는다(초과분은 참고 예산에서 차감).
          // 바이트 산출은 아래 '실제로 실리는 문안'(shown9 — en 판은 번역문) 기준으로 sel9 절에서 한다(확인 검증 blocker③).
          selArc9 = arc9; sel9 = rawSel9;
          if (en9 && arc9.dataEn.alwaysBlocker) selTextsEn9 = rawSel9.selectedIds.map((idd) => arc9.dataEn.alwaysBlocker[Number(/^arc-(\d+)$/.exec(String(idd))[1]) - 1]);
        }
      }
      try { // 1차 blocker②+5차 미완수정①: 주입에 쓴 지문을 재판독 없이 동결하고 '이 ask의 잡 id'를 동등 결속(시계 무관 — 후처리가 id 일치로만 인정)
        const jid9 = typeof process.env.CODEX_BRIDGE_ASK_JOB_ID === "string" && process.env.CODEX_BRIDGE_ASK_JOB_ID ? process.env.CODEX_BRIDGE_ASK_JOB_ID : null;
        // [Envelope Selector v7 §2] ab 합본 manifest+boundaryGen 동결 — 같은 전이 잠금 '안'에서 재판독하고
        // 주입 지문(evi.sha1)과 일치할 때만 구성(불일치·실패=legacy 동결: manifest 없음 → confirm은 envelopeHash 폴백).
        // 선별 판(sel9)은 선별분이 manifest에 합류하고 appliedArchiveHash=실값 — 아래 strict 관문이 legacy 위장을 막는다.
        let fx9 = undefined;
        try {
          if (evi.st === "ok") {
            const evM = readVerifyEnvelope(target9);
            if (evM.st === "ok" && evM.sha1 === evi.sha1) {
              const mf9 = buildAbManifest(evM.data.alwaysBlocker, selTexts9);
              fx9 = { manifest: mf9, boundaryGen: boundaryGenOf(evi.sha1, sel9 ? selArc9.sha1 : "", mf9), appliedArchiveHash: sel9 ? selArc9.sha1 : "",
                oos: (Array.isArray(evM.data.outOfScope) ? evM.data.outOfScope : []).map((t9, i9) => ({ id: "oos-" + (i9 + 1), title: String(t9).slice(0, 60) })) }; // [개선 1-A] 판마다 제외 칸 동결
            }
          }
        } catch { fx9 = undefined; }
        // [3b strict] 선별 판인데 manifest 구성 실패=중단 — legacy 동결로 넘기면 입장 심사의 ab 범위·경계
        // 표식이 선별분을 모르는 채 판정한다(조용한 축소 금지).
        if (sel9 && !fx9) throw Object.assign(new Error(en9 ? "[archive rules] failed to freeze the combined manifest — this verification was not started." : "[서고 수칙] 합본 manifest 동결 실패 — 이번 검증을 시작하지 않았습니다."), { selectorDrift: true });
        if (!writeEnvelopeFreeze(wsIn, evi.st === "ok" ? evi.sha1 : null, jid9, fx9)) {
          if (sel9) throw Object.assign(new Error(en9 ? "[archive rules] envelope freeze write failed — this verification was not started (admission must see the combined boundary)." : "[서고 수칙] 경계 동결 기록 실패 — 이번 검증을 시작하지 않았습니다(입장 심사가 합본 경계를 봐야 함)."), { selectorDrift: true });
          console.error(en9 ? "[envelope freeze write failed — admission disabled this ask]" : "[경계 동결 기록 실패 — 이번 ask 입장 심사 미발동]");
        }
      } catch (eF9) { if (eF9 && eF9.selectorDrift) throw eF9; /* 그 외=안전 방향(legacy와 동일) */ }
      if (evi.text) {
        out9.envText = evi.text;
        // [기억 권위 C-1] 전송된 그 경계의 실물(재판독 금지 — 잠금 안 값). [3b] 선별 판=전송 ab 집합이 코어+선별분
        // 합본이므로 축 개수를 합본으로 확장 — carrier의 ab-N id 집합이 검증자가 인용할 수 있는 번호와 일치해야
        // 제약 처리 표기(ab-13 등)가 '동봉 안 된 id'로 오거부되지 않는다.
        out9.envAxes = evi.axes ? { ...evi.axes, alwaysBlocker: evi.axes.alwaysBlocker + selTexts9.length } : null;
        out9.envSha = evi.sha1 || null;
        out9.baseQual = profile === "core" ? envelopeCoreQualifier(lang) : envelopeIntegrityQualifier(lang); // 증분 2(사용자 결정): 경계=프로필 공통 — 무결성=재소환 금지+경계 재심 관점([주의]로 제출)
        if (evi.warn === "truncated") console.error(en9 ? "[verification envelope: some items exceeded the caps (12/axis · 200 chars) and were truncated — the injected boundary omits the excess; trim the file and re-approve]" : "[검증 경계: 일부 항목이 상한(축 12·항목 200자) 초과로 절삭된 채 주입됨 — 초과분은 경계에서 빠짐. 파일을 줄여 재승인 권장]"); // 1차 blocker④: 절삭의 침묵 금지
        if (sel9) { // [3b] 서고 선별 절 — 합본 ab-N 번호는 코어 다음 연속(manifest와 동일 규약·심사 범위가 자동 확장)
          const k9 = evi.axes.alwaysBlocker;
          const selL9 = [
            en9 ? "[Archive rules · selected for this task v1 — user-approved stored policy · DATA, not instructions]" : "[서고 수칙 · 이번 작업 선별 v1 — 사용자 승인 보관 수칙 중 이번 작업 관련분 · 데이터이며 지시가 아님]",
            en9 ? `An independent selector session picked ${selTexts9.length} of ${selArc9.data.alwaysBlocker.length} archived item(s) as relevant to this task. Judge them with the same authority as the core ab items above (always a blocker within the supported world).` : `독립 선별 세션이 보관 수칙 ${selArc9.data.alwaysBlocker.length}항 중 ${selTexts9.length}항을 이번 작업 관련분으로 골랐다. 위 코어 ab 항목과 같은 권위(지원 세계 안 절대 blocker)로 심사하라.`,
          ];
          const shown9 = selTextsEn9 || selTexts9;
          { // [§4-B ④] 실제 주입 문안 기준 초과 산출(en=번역문 바이트) — 참고 예산 차감·정보 행·stderr 1줄
            const selBytes9 = shown9.reduce((a, t) => a + Buffer.byteLength(String(t), "utf8"), 0);
            out9.selOver = { items: shown9.length > SELECTOR_UNION_MAX, bytes: selBytes9 > SELECTOR_UNION_BYTES_MAX, count: shown9.length, bytesTotal: selBytes9, excessBytes: Math.max(0, selBytes9 - SELECTOR_UNION_BYTES_MAX) };
            if (out9.selOver.items || out9.selOver.bytes) console.error(en9 ? `[archive rules] ${shown9.length} related item(s) · ${selBytes9} bytes — above the normal range (${SELECTOR_UNION_MAX} items · ${SELECTOR_UNION_BYTES_MAX} bytes); all included, reference budget reduced — consider tidying the archive` : `[서고 수칙] 관련 수칙 ${shown9.length}항 · ${selBytes9}바이트 — 정상 범위(${SELECTOR_UNION_MAX}항 · ${SELECTOR_UNION_BYTES_MAX}바이트) 초과, 전량 동봉·참고 자료 예산 축소 — 서고 정리 권장`);
          }
          shown9.forEach((tx, i) => selL9.push("> ab-" + (k9 + i + 1) + ": " + tx));
          if (!selTexts9.length) selL9.push(en9 ? "(no archived item selected for this task)" : "(이번 작업 관련 선별 0건)");
          if (out9.selOver && (out9.selOver.items || out9.selOver.bytes)) selL9.push(en9 ? `(related rules ${out9.selOver.count} item(s) · ${out9.selOver.bytesTotal} bytes — above the normal range (${SELECTOR_UNION_MAX} · ${SELECTOR_UNION_BYTES_MAX}); ALL included — none omitted)` : `(관련 수칙 ${out9.selOver.count}항 · ${out9.selOver.bytesTotal}바이트 — 정상 범위(${SELECTOR_UNION_MAX}항 · ${SELECTOR_UNION_BYTES_MAX}바이트) 초과, 전량 동봉 — 누락 없음)`);
          out9.envText += "\n\n" + selL9.join("\n");
        }
        out9.envData = out9.envText;
        if (profile === "core") { out9.v2Static = v2StaticDirective(lang); out9.v2Data = v2DynamicData(wsIn, lang); out9.envText += "\n\n" + [out9.v2Static, out9.v2Data].filter(Boolean).join("\n"); out9.v2Attached = true; } // v2Attached=구조적 표지(재검증 blocker: 수칙서 '데이터'가 표제 문자열을 담아도 오발동 금지 — 실제로 붙인 지점에서만 참). // 증분 2 §3.1: 경계 활성+core=v2 서식 요구+열린 지적 자동 동봉(하네스 직접). integrity=문구 준수 감사(기계화는 증분 3 검토 — 1차 [보완]② 지시·후처리 정합)
      }
      // [경계 통일 2026-08-29 · 검증 3회차 blocker①(ab-3)] 전송 직전 잠금 안 판독에서 승인 없는 변경/손상이면 여기서 중단 —
      // 선행 게이트 통과 뒤 다른 창이 파일을 바꿔도 "수칙 없는 검증"이 조용히 진행되지 않는다(종전=경고+무주입). 승인 지문이 없는
      // 미도입 프로젝트의 손상은 종전대로 경고만(차단할 승인본이 없음). 승인 지문 판정도 잠금 안 신선 계약(cFresh9) 기준 — 잠금 밖 스냅샷 c는
      // 구·신 계약 교차(다른 창 승인 직후 손상)에서 fail-open/오차단을 만든다(4회차 blocker).
      else if (evi.warn === "mismatch" || (evi.warn === "corrupt" && typeof cFresh9.envelopeHash === "string" && cFresh9.envelopeHash)) throw Object.assign(new Error(en9 ? `⚠️ The always-applied rules file changed without approval (${evi.warn === "corrupt" ? "unreadable" : "content mismatch"}) — this verification was not run. Open 'View unapproved changes' on the Rules card to approve or restore, then retry.` : `⚠️ 항상 적용되는 수칙 파일이 승인 없이 바뀌어(${evi.warn === "corrupt" ? "판독 불가" : "내용 불일치"}) 검증을 실행하지 않았습니다 — 대시보드 수칙 카드의 '승인 없이 바뀐 내용 보기'에서 승인하거나 마지막 승인 목록으로 복구한 뒤 다시 시도하세요.`), { envelopeDrift: true, exitCode: 3 });
      else if (evi.warn === "corrupt") console.error(en9 ? "[verification envelope unreadable — skipped]" : "[검증 경계 판독 불가 — 주입 생략]");
      } finally { releaseEnvelopeTransLock(wsIn, lk9.token); } // 판독·동결·조립까지 잠금 보유(전이와 원자 상호배제)
    }
  }
  return out9;
}

// ── P3b B-5: scout-attach 표면 재배선 — buildMapAttach 경유(비v2=기존 동봉 위임·바이트 동일) ─────────
// lazy require: map-reader가 없는/깨진 배포 사본이면 공통 원칙 (a) 읽기 폴백 — 대상 repo의 전환 표식(marker)
// '또는' 전환 이력(authority-history)이 존재하면 legacy 데이터 공급 금지(고지 attach), 둘 다 부재=기존 동봉.
function mapAttachSurface(ws, c, lang, reqText) {
  try { return require(path.join(__dirname, "map-reader.js")).buildMapAttach(ws, c, lang, reqText); }
  catch { /* 낡은/손상 사본 — 아래 원시 검사 폴백 */ }
  // 3상태 원시 검사(구현검증 2차 #3): present/unreadable=legacy 공급 금지·absent만 기존 동봉.
  let trace = "unreadable"; // 검사 자체가 죽으면 보수(공급 금지)
  try {
    const target = resolveScoutRepo(ws, c).repo;
    const st1 = (p) => { try { const s = fs.statSync(p); if (s.isFile()) return "present"; if (s.isDirectory()) { try { return fs.readdirSync(p).length > 0 ? "present" : "absent"; } catch { return "unreadable"; } } return "absent"; } catch (e) { return e && e.code === "ENOENT" ? "absent" : "unreadable"; } };
    const a = st1(path.join(target, "project-map", "authority.json")), b = st1(path.join(target, "project-map", "authority-history"));
    trace = (a === "present" || b === "present") ? "present" : (a === "unreadable" || b === "unreadable") ? "unreadable" : "absent";
  } catch { trace = "unreadable"; }
  if (trace === "absent") return buildScoutAttach(ws, c, lang);
  const en = lang === "en" || (lang !== "ko" && loadLang() === "en");
  return {
    text: trace === "present"
      ? (en ? "[Project MAP] This project has cut over, but the MAP runtime here is outdated — no map slice attached (run node install.js)." : "[Project MAP] 전환된 프로젝트인데 이 설치본의 MAP 런타임이 낡음 — 지도 조각을 동봉하지 않습니다(node install.js 실행 필요).")
      : (en ? "[Project MAP] Cutover trace unreadable (permissions?) — no map slice attached (not proven legacy)." : "[Project MAP] 전환 흔적 판독 불가(권한?) — 지도 조각을 동봉하지 않습니다(legacy 확인 안 됨)."),
    mapItems: [], couplings: [],
  };
}

const HOME = os.homedir();
// 자체 namespace 폴더. CODEX_BRIDGE_HOME으로 override 가능(WSL/Remote/Container·포터블에서 확장 호스트와 훅이
// 같은 폴더를 보도록 명시 고정). 미설정이면 ~/.codex-bridge. ★모든 자체파일 경로는 이 BRIDGE_DIR 한 곳에서만 파생.
const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(HOME, ".codex-bridge");
// codex가 실제 쓰는 home을 확장이 'codex doctor'로 탐지해 적어둔 값(바이너리 codex-bin.txt 대칭).
// → CODEX_HOME 미설정/비표준 home·다중설치에서도 세션 폴더를 정확히 찾는다(V11). 없으면 ~/.codex 폴백.
function readPinnedHome() {
  try {
    const p = fs.readFileSync(path.join(BRIDGE_DIR, "codex-home.txt"), "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}
const CODEX_HOME = process.env.CODEX_HOME || readPinnedHome() || path.join(HOME, ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const LINKS_FILE = path.join(BRIDGE_DIR, "links.json");
const ASK_JOBS_DIR = path.join(BRIDGE_DIR, "ask-jobs");
const ASK_JOB_WORKER = path.join(__dirname, "ask-job-worker.js");
// 검증 증명 폴더 — 실제로 Codex가 성공 응답했을 때만 기록(아래 writeProof). verify-guard가 이걸 읽어
// '명령 문자열을 쳤는가'가 아니라 '진짜 성공한 검증이 이번 턴에 있었는가'를 본다(V1: 흉내/실패/미연결 통과 차단).
const PROOFS_DIR = path.join(BRIDGE_DIR, "proofs");
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function nowIso() {
  return new Date().toISOString();
}
function claudeId() {
  return process.env.CLAUDE_CODE_SESSION_ID || "";
}
function implementerId(ws) {
  if (claudeId()) return claudeId();
  const env = process.env.CODEX_THREAD_ID || "";
  if (env) return env;
  const a = readCodexActive();
  return a && (!ws || normWs(a.workspace || "") === normWs(ws)) ? (a.codexSession || "") : "";
}
// (구 workspace()=CLAUDE_PROJECT_DIR||cwd 제거: configWs(연 폴더, 설정 기준)와 process.cwd()(execCwd, 실행 기준)로 분리됨.)
// 검증 증명 기록 — 실제로 Codex가 성공(exit 0·비어있지 않은 응답)했을 때만 호출한다(cmdAsk의 성공 분기들).
// 한 Claude 세션당 1파일(최신 성공만 보존). verify-guard는 '이번 사용자 발화/변경 이후 ts + status/exit/answerChars'로 인정(workspace는 V1에서 게이트 제외 — 같은 세션 키로 격리).
// → 명령 문자열만 보던 V1 구멍(echo·실패·미연결도 통과)을 닫는다. claudeSession 미설정(수동 실행)이면 _nosession에 기록(무해).
// P-6(3차 지적 3): 내구 env는 '존재'가 아니라 실체를 검증한다 — 정본 경로(ask-jobs/<id>.json)·파일명↔id·
// 정확 스냅샷·running 상태·workspace 결속까지. 임의 경로의 조작 JSON으로 직접 ask 게이트를 우회하거나
// writeProof가 비정본 job을 신뢰하는 통로를 닫는다. cmdAsk 게이트와 writeProof가 같은 판정을 공유한다.
// P-12(구현검증 2차 정정): 프로필·언어 동결값 회수용 '모드 무관' 정본 판독기 — 경로·ID 문법·정본 경로·
// id 일치·schema·workspace·running까지 확인하되, C-C proof 전용 조건(구현 세션·턴·revision —
// durableJobSnapshotOk)은 적용하지 않는다. CL-C 정상 job이 job-mode로 거부돼 동결값이 무시되던 회귀 봉합.
// P-6 proof 경계(readDurableEnvJob)는 그대로 — 완화 아님(분리).
function readCanonicalEnvJob(ws) {
  const jobFile = process.env.CODEX_BRIDGE_JOB_PROMPT_FILE || "";
  const jobIdEnv = process.env.CODEX_BRIDGE_ASK_JOB_ID || "";
  if (!jobFile || !jobIdEnv) return { ok: false, reason: "env-missing" };
  if (!askJobIdOk(jobIdEnv)) return { ok: false, reason: "env-id-grammar" };
  const canonical = path.resolve(ASK_JOBS_DIR, jobIdEnv + ".json");
  let resolved = ""; try { resolved = path.resolve(jobFile); } catch { return { ok: false, reason: "env-path" }; }
  if (resolved.toLowerCase() !== canonical.toLowerCase()) return { ok: false, reason: "env-noncanonical" };
  let job = null; try { job = JSON.parse(fs.readFileSync(canonical, "utf8")); } catch { return { ok: false, reason: "env-job-unreadable" }; }
  if (job.id !== jobIdEnv) return { ok: false, reason: "env-id-mismatch" };
  if (job.schema !== "ask-job-v1") return { ok: false, reason: "env-schema" };
  if (normWs(String(job.workspace || "")) !== normWs(ws)) return { ok: false, reason: "env-workspace" };
  if (job.state !== "running") return { ok: false, reason: "env-not-running" };
  return { ok: true, job };
}
function readDurableEnvJob(ws) {
  const jobFile = process.env.CODEX_BRIDGE_JOB_PROMPT_FILE || "";
  const jobIdEnv = process.env.CODEX_BRIDGE_ASK_JOB_ID || "";
  if (!jobFile || !jobIdEnv) return { ok: false, reason: "env-missing" };
  if (!askJobIdOk(jobIdEnv)) return { ok: false, reason: "env-id-grammar" };
  const canonical = path.resolve(ASK_JOBS_DIR, jobIdEnv + ".json");
  let resolved = ""; try { resolved = path.resolve(jobFile); } catch { return { ok: false, reason: "env-path" }; }
  if (resolved.toLowerCase() !== canonical.toLowerCase()) return { ok: false, reason: "env-noncanonical" };
  let job = null; try { job = JSON.parse(fs.readFileSync(canonical, "utf8")); } catch { return { ok: false, reason: "env-job-unreadable" }; }
  if (job.id !== jobIdEnv) return { ok: false, reason: "env-id-mismatch" };
  const jr = durableJobSnapshotOk(job);
  if (!jr.ok) return { ok: false, reason: jr.reason };
  if (normWs(String(job.workspace || "")) !== normWs(ws)) return { ok: false, reason: "env-workspace" };
  if (job.state !== "running") return { ok: false, reason: "env-not-running" };
  return { ok: true, job };
}
function writeProof(codexSession, answer, ws) {
  // claudeSession: env 우선, 없으면 active.json(contract-inject가 hook.session_id로 기록) 폴백 →
  // verify-guard의 reader 키(env‖j.session_id‖transcript)와 같은 대화 id로 수렴(환경별 env 결측 대비).
  const c = loadContract(ws);
  // P-6(설계 v5.1 + 구현 검증 1차 지적 3): 분기의 권위는 '완료 시점 계약'이 아니라 job의 동결 harnessMode.
  // C-C로 시작한 job이 완료 중 claude-codex로 바뀌어도 v1 proof로 새지 않고 stale로 실패해 worker가
  // job을 failed로 기록한다(모드 전환 stale). env job은 정본 검증(readDurableEnvJob)을 통과해야 신뢰한다.
  const envJob = readDurableEnvJob(ws);
  const job = envJob.ok ? envJob.job : null;
  if (job && job.harnessMode === "codex-codex") {
    if (c.harnessMode !== "codex-codex") die(tB("⚠️ 이 검증 작업은 Codex-Codex 모드에서 시작됐는데 완료 시점 계약이 다른 모드입니다(stale). 현재 모드에서 새 검증을 시작하세요.", "⚠️ This verification job started in Codex-Codex mode but the contract has switched modes (stale). Start a new verification under the current mode."), 4);
    const r = writeDurableProofV2(ws, job, answer, codexSession);
    if (!r.ok) die(tB(`⚠️ 검증 증명 기록 실패(${r.reason}) — 이 검증은 성공으로 인정되지 않습니다. 역할·턴이 바뀌었으면 구현 대화의 현재 턴에서 새 검증을 시작하세요.`, `⚠️ Failed to record the verification proof (${r.reason}) — this verification is not accepted. If the role/turn changed, start a new verification from the implementer conversation's current turn.`), 4);
    // 재확인 배선(증분 4): checkpoint 결속용 proof 실물 좌표 반환(실패해도 proof 기록 자체는 유효)
    try { return { proofFile: path.basename(r.file || ""), proofFp: crypto.createHash("sha256").update(fs.readFileSync(r.file)).digest("hex") }; } catch { return {}; }
  }
  if (c.harnessMode === "codex-codex") {
    // env job이 없거나(직접 ask) 스냅샷 없는 구버전 job — C-C 성공 계약은 내구 경로 v2만 인정.
    die(tB("⚠️ Codex-Codex 모드의 검증 증명은 내구 작업(ask-start → ask-wait) 경유만 기록됩니다. 직접 ask 또는 구버전 작업은 성공으로 인정되지 않습니다 — ask-start를 사용하세요.", "⚠️ In Codex-Codex mode a verification proof is only recorded through the durable job path (ask-start → ask-wait). A direct ask or a legacy job is not accepted — use ask-start."), 4);
  }
  const cs = claudeId() || ((readActive() || {}).claudeSession) || "";
  const proof = {
    v: 1,
    claudeSession: cs,
    implementerSession: "",
    workspace: ws || configWs(), // 라벨=연 폴더(인자 없으면 폴백). cmdAsk의 ws 스냅샷과 동일
    ts: nowIso(),
    codexSession: codexSession || "",
    exit: 0,
    status: "success",
    answerChars: (answer || "").length,
  };
  const key = (cs || "_nosession").replace(/[^0-9a-zA-Z._-]/g, "_"); // 파일명 안전(UUID는 본래 안전)
  const rawProof = JSON.stringify(proof);
  atomicWrite(path.join(PROOFS_DIR, key + ".json"), rawProof); // atomicWrite가 PROOFS_DIR 자동 생성
  // 재확인 배선(증분 4): checkpoint 결속용 proof 실물 좌표 반환
  return { proofFile: key + ".json", proofFp: crypto.createHash("sha256").update(Buffer.from(rawProof, "utf8")).digest("hex") };
}

// 결정2-2단계: Codex 답의 인용 근거(파일:라인)를 보수적으로 점검. 거짓경보(cry-wolf) 회피 최우선 —
// 경로를 '자신 있게' 한 실제 파일로 해석할 수 있을 때만(절대존재 / ws 상대존재 / ws내 basename 유일) 평가하고,
// 라인이 파일 줄수를 '명백히 초과'할 때만 불일치로 본다. 해석 불가·모호·범위 내는 건너뜀(안 띄움). '코덱스가
// 실제로 안 열었나'(rollout 대조)는 fuzzy라 보류. → 불일치가 있으면 노랑(warning) 무결성 이벤트.
function findByBasename(root, base, maxDepth, maxFiles) {
  const hits = [];
  let count = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth || count > maxFiles || hits.length > 1) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (hits.length > 1) return;
      const n = it.name;
      if (it.isDirectory()) {
        if (n === "node_modules" || n === ".git" || n === "out" || n.startsWith(".")) continue;
        walk(path.join(d, n), depth + 1);
      } else if (it.isFile()) {
        count++;
        if (n === base) hits.push(path.join(d, n));
      }
    }
  };
  walk(root, 0);
  return hits;
}
function resolveCitedPath(raw, ws) {
  let p = normSepWin(String(raw)); // 인용측도 같은 플랫폼 규칙(POSIX=\ 보존 — 백슬래시 파일명이 타 경로로 둔갑 금지)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return null; // URL(https:// 등)은 로컬 파일 아님 → 건너뜀(cry-wolf 방지)
  const mnt = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/); // /mnt/d/... → d:/...
  if (mnt) p = mnt[1] + ":/" + mnt[2];
  // /D:/... → D:/... (검증자가 마크다운 링크에 즐겨 쓰는 선행 슬래시 절대경로 — 이 정규화가 없으면 절대/상대
  // 해석이 모두 실패한 뒤 basename 폴백이 ws의 '이름만 같은 무관 파일'과 대조해 오경보를 낸다. 2026-07-17
  // 실사고: 정확한 인용 docs/HANDOFF.md:116을 대화 폴더의 79줄짜리 옛 HANDOFF.md와 대조해 불일치 2건 오보.)
  const drv = p.match(/^\/([a-zA-Z]):\/(.*)$/);
  if (drv) p = drv[1] + ":/" + drv[2];
  try { if (path.isAbsolute(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* */ }
  try { const c = path.join(ws, p); if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* */ }
  const hits = findByBasename(ws, path.basename(p), 6, 5000);
  return hits.length === 1 ? hits[0] : null; // 유일할 때만(모호하면 skip — cry-wolf 방지)
}
function checkCitedEvidence(answer, ws) {
  const text = String(answer || "");
  // 마크다운 링크 (경로.확장자:라인[-라인]). 경로엔 드라이브 콜론(D:/...)·유니코드도 허용해야 하므로 괄호/공백만 제외.
  // '.확장자:숫자)'로 끝을 고정해 (3:00)·(텍스트:5) 같은 비-파일 인용은 거른다.
  const re = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?\)/g;
  const seen = new Set();
  const mism = [];
  let m;
  while ((m = re.exec(text))) {
    const rawPath = m[1];
    const line = parseInt(m[2], 10);
    if (!line) continue;
    const k = rawPath + ":" + line;
    if (seen.has(k)) continue;
    seen.add(k);
    const file = resolveCitedPath(rawPath, ws || process.cwd());
    if (!file) continue; // 해석 불가/모호 → 건너뜀
    let count = 0;
    try { count = fs.readFileSync(file, "utf8").split(/\n/).length; } catch { continue; }
    if (line > count) mism.push(`${path.basename(rawPath)}:${line}(실제 ${count}줄)`);
  }
  return mism;
}
function canonicalFileKey(file) {
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file);
    const norm = normSepWin(path.resolve(real)); // POSIX에서 \는 파일명 문자 — 보존(확인 검증 blocker 계보)
    return process.platform === "win32" ? norm.toLowerCase() : norm;
  } catch { return null; }
}
// 인용된 파일 중 실재하며 줄 번호도 유효하고, 인용 범위에 실제 비어 있지 않은 내용이 있는 파일의 정확한
// 정규 경로+내용 조각. 읽기 도구의 성공 출력이 이 조각 중 하나를 실제 반환했는지까지 뒤에서 대조한다.
function citedResolvedEvidence(answer, ws) {
  const text = String(answer || "");
  const re = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?\)/g;
  const out = new Map();
  let m;
  while ((m = re.exec(text))) {
    const file = resolveCitedPath(m[1], ws || process.cwd());
    if (!file) continue;
    let lines = [];
    try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { continue; }
    const start = parseInt(m[2], 10), end = m[3] ? parseInt(m[3], 10) : start;
    if (start < 1 || end < start || end > lines.length) continue;
    const snippets = lines.slice(start - 1, end).map((s) => s.trim()).filter(Boolean);
    if (!snippets.length) continue; // 빈 줄 인용은 실제 내용 반환 증거와 결속할 수 없음
    const key = canonicalFileKey(file);
    if (!key) continue;
    const prev = out.get(key) || [];
    out.set(key, [...new Set(prev.concat(snippets))]);
  }
  return out;
}
function citedResolvedPaths(answer, ws) { return new Set(citedResolvedEvidence(answer, ws).keys()); }
// 기존 공개 API와 무결성 경고 문구 호환 — 화면에는 basename만, 신뢰 판정은 citedResolvedPaths를 사용.
function citedResolvedBasenames(answer, ws) {
  return new Set([...citedResolvedPaths(answer, ws)].map((p) => path.basename(p)));
}
// 결정2-3(L1-A 개정): 인용한 실재 파일 중, '이번 턴'(rollout 마지막 사용자 메시지 이후)의 읽기 도구 인수에
// 정확한 절대/상대 경로가 없는 것. 세션 '전체' 스캔은 이전 턴에서 다룬 파일을 이번 확인의 근거로 인정하는
// 결함(Codex 설계검증). 반환은 삼상태 — {checked:false}=검사 자체가 불가(세션 미식별·현재 턴 경계 미발견·
// 도구활동 0)로, '미확인 파일 없음'(checked:true·unseen:[])과 구분된다. 판정 불가를 빈 배열로 돌려주면
// 소비자가 확인 성공으로 오독해 승격으로 흐른다(같은 지적).
// 오래 이어진 세션은 파일 전체 크기와 이번 턴의 증명 가능성이 무관하다. 따라서 전체 파일을 거부하지 않고
// 끝 16MiB만 읽어 마지막 사용자 경계를 찾는다. 현재 턴 자체가 이 범위를 넘겨 경계가 잘렸다면 unknown을
// 유지한다 — 과거 턴을 이번 턴 근거로 오인하지 않으면서 장기 세션의 정상 최신 턴은 판독한다.
const ROLLOUT_TURN_TAIL_MAX = 16 * 1024 * 1024;
function rolloutTailLines(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return null; }
  if (size <= ROLLOUT_TURN_TAIL_MAX) {
    try { return fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { return null; }
  }
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const start = size - ROLLOUT_TURN_TAIL_MAX;
    const before = Buffer.allocUnsafe(1);
    const startsAtLineBoundary = fs.readSync(fd, before, 0, 1, start - 1) === 1 && before[0] === 0x0a;
    const buf = Buffer.allocUnsafe(ROLLOUT_TURN_TAIL_MAX);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (!n) break;
      got += n;
    }
    let text = buf.subarray(0, got).toString("utf8");
    // 직전 바이트가 개행이면 꼬리는 완전한 JSONL 행에서 시작한다. 그때 첫 행을 버리면 정확히 경계에
    // 놓인 최신 사용자 메시지를 잃는다. 그 외에는 한 줄(또는 UTF-8 문자) 중간이므로 첫 개행까지 버린다.
    if (!startsAtLineBoundary) {
      const firstNl = text.indexOf("\n");
      if (firstNl < 0) return null;
      text = text.slice(firstNl + 1);
    }
    return text.split(/\r?\n/);
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best-effort */ } } }
}
// 명령 텍스트의 \→/ 정규화는 win32 한정(확인 검증 blocker 계보 — POSIX에서 \는 경로 구분자가 아니라
// 파일명 문자라, 플랫폼 무관 변환은 서로 다른 파일을 같은 판독 대상으로 합친다). 추출 계층(여기·중첩
// workdir·원시 스캔)과 비교 계층(hit의 fold)이 같은 플랫폼 규칙을 써야 분기가 실효한다.
const normSepWin = process.platform === "win32" ? (s) => String(s).replace(/\\/g, "/") : (s) => String(s);
function toolArgumentValues(p) {
  const values = [];
  const collect = (v) => {
    if (typeof v === "string") { values.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) collect(x); return; }
    if (v && typeof v === "object") for (const x of Object.values(v)) collect(x);
  };
  for (const raw of [p && p.arguments, p && p.input]) {
    if (typeof raw === "string") { try { collect(JSON.parse(raw)); } catch { collect(raw); } }
    else collect(raw);
  }
  return values.map((v) => normSepWin(String(v)));
}
function toolArgumentText(p) { return toolArgumentValues(p).join("\n"); }
function toolCallCanReadFile(p, hay) {
  const name = String((p && (p.name || p.tool_name)) || "").toLowerCase();
  if (/apply[_-]?patch|write|delete|remove|list|glob/.test(name) && !/read|view|open/.test(name)) return false;
  if (/read|view|open/.test(name)) return true;
  const text = String(hay || "").trim();
  // 셸/터미널 호출은 문장 '시작'의 실제 내용 판독 명령만 인정한다. echo 안의 "cat 파일" 같은 문자열과
  // 파일 목록·상태 조회는 제외한다. 복잡한 스크립트는 과대 승격보다 unknown으로 남기는 쪽을 택한다.
  // 셸/터미널 호출은 문장 '시작'의 실제 내용 판독 명령만 인정한다. echo 안의 "cat 파일" 같은 문자열과
  // 파일 목록·상태 조회는 제외한다. 복잡한 스크립트는 과대 승격보다 unknown으로 남기는 쪽을 택한다.
  //
  // [2026-07-28 시도와 되돌림 — 이 목록이 좁은 이유의 정본 기록]
  // "정직하게 읽었는데 인식 안 되는" 사례(`node -e`로 읽기·제어문으로 감싼 읽기)를 살리려고 이 판정을
  // '명백한 비판독만 배제하고 나머지는 통과'로 넓혔다가 **되돌렸다**. 독립 검증이 실경로 반례를 제시:
  //   node -e "console.log('A의 인용 줄\nB의 인용 줄')" path/A.js path/B.js
  // 이 명령은 파일을 전혀 읽지 않지만 ①후보 통과 ②인수의 파일명 매칭 ③성공 종료+비어 있지 않은 출력
  // ④합성 출력에 인용 문자열 존재 — 최종 관문 3중을 모두 통과해 '강한 확인 1회 → verified'가 된다.
  // 핵심 교훈: 최종 관문은 "출력을 만들었다"만 증명하고 "이번 턴에 그 파일을 읽었다"는 증명하지 못한다.
  // 그 증명은 **명령 자체의 의미론**(cat/sed/grep 등은 지정한 파일을 읽지 않고는 그 출력을 낼 수 없다)에서만
  // 나온다. 그래서 임의 코드 실행기(node -e·python -c·perl -e·sh -c·powershell -Command)와 제어문은
  // 계속 제외한다 — 좁은 창구는 위조 방지의 대가이며, 놓친 판독은 unknown(기록만)으로 남는 안전한 실패다.
  // 변수 대입 접두(`$lines=Get-Content …`)는 벗겨서 **대입 오른쪽**을 판정한다. 오른쪽이 목록 밖이면
  // 그대로 탈락하므로(예: `$x = node -e "…"`) 인정 범위는 넓어지지 않는다.
  // 여는 괄호도 벗긴다 — `$t = (git show <판>:<경로>)` 처럼 출력을 값으로 받는 형태가 흔한데,
  // 괄호 하나 때문에 같은 명령이 통째로 안 보였다(2026-07-29 실측). 안쪽이 목록 밖이면 그대로 탈락한다.
  const lead = text.replace(/^&\s*/, "").replace(/^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "").replace(/^\(\s*/, "");
  if (/^(rg|ripgrep)(?:\.exe)?\s+[^\r\n]*--files(?:\s|$)/i.test(lead)) return false;
  // [확장 시도 3회 전면 철회 — 목록은 종전 그대로] 3차 반증에서 더 근본적인 사실이 드러났다: 목록에 무엇을
  // 넣든 `Write-Output '<인용 줄>' | nl # A.js B.js`처럼 **표준 입력으로 받은 내용을 출력하면서 경로는
  // 주석·비피연산자 위치에 두는** 구성이면 이 함수의 경로 대조를 통과한다. 즉 한계는 '어떤 명령을 넣느냐'가
  // 아니라 **경로가 실제 입력 피연산자인지 결속하지 못하는 판정 방식 자체**에 있다(기존 sed·cat 등에도 동일).
  // 따라서 목록 확장으로는 이 문제를 풀 수 없다고 결론하고 원상 복구했다. 근본 해법은 판독 기록의 구조화
  // (무엇을 읽었는지 도구가 직접 남기는 방식)이며 별도 설계가 필요하다 — 보관함 d6ead5db517cffa4·b8e15bf229983ddb.
  //
  // [2026-07-28 문맥 보정 — 위와 '축'이 다른 수정]
  // 위 되돌림은 **인정 명령을 늘리는** 축이었다. 그와 별개로, 같은 명령을 우리가 못 알아보는 구문 문제가
  // 실제 기록에서 확인됐다(정직하게 읽었는데 매번 '근거 의심' 경보가 뜨는 원인).
  //   (a) `git -c safe.directory=… -C <repo> show … -- <파일들>` — 옛 규칙은 git 바로 뒤 -C만 허용했다.
  //   (b) `$p='경로'; $lines=Get-Content -LiteralPath $p …` — 문장 선두가 변수 대입이라 탈락하고,
  //       경로가 다른 문장에 있어 경로 대조도 못 했다.
  // 아래 보정은 **인정 명령을 한 개도 늘리지 않는다**(같은 목록·같은 최종 관문). 그래서 위조 여지도
  // 늘지 않는다 — 임의 실행기는 여전히 전부 탈락한다(대입 오른쪽이 목록 밖이면 탈락, git -c는 실행을
  // 유발할 수 있는 설정이면 탈락). 검증 반례는 tests/evidence-unseen.test.js [4] 절.
  return /^(cat|type|more|less|head|tail|sed|grep|rg|ripgrep|select-string|get-content|gc)(?:\.exe)?(?:\s|$)/i.test(lead)
    || gitReadsFiles(lead);
}
// git 전역 옵션(-C 폴더 / -c 설정)이 앞에 붙어도 판독 하위명령을 알아본다.
// -c는 **실행을 유발하지 않는 설정만** 허용한다(허용 목록 방식): diff.external·core.pager·alias.* 처럼
// 외부 프로그램을 부르는 설정을 통과시키면 '읽지 않고 출력만 만드는' 경로가 새로 열리기 때문이다.
// 금지 목록이 아니라 허용 목록인 이유: git 설정은 계속 늘어나므로 '아직 모르는 실행 설정'이 새면 안 된다.
// 목록에 없는 설정이 쓰이면 인식만 실패한다(과대 승격이 아니라 unknown — 안전한 실패 방향).
const GIT_INERT_CONFIG_KEYS = ["safe.directory"];
// 한 번의 훑기로 '판독인가'와 '경로 기준 폴더는 어디인가'를 함께 낸다. 기준 폴더는 **하위명령 앞의 옵션
// 구간에서 소비된 -C 값만** 인정한다(1차 blocker② — 주석이나 인수 자리의 -C 를 주우면 읽지도 않은
// 다른 폴더가 기준이 되어 엉뚱한 파일이 '다뤘음'으로 둔갑한다).
function gitReadParse(lead) {
  const m = String(lead || "").match(/^git(?:\.exe)?\s+([\s\S]*)$/i);
  if (!m) return { ok: false, roots: [] };
  let rest = m[1].trim();
  const roots = [];
  for (;;) {
    const c1 = rest.match(/^-C\s+("([^"]*)"|'([^']*)'|\S+)\s+/);
    if (c1) { roots.push(normSepWin(c1[2] || c1[3] || c1[1])); rest = rest.slice(c1[0].length); continue; }
    const c2 = rest.match(/^-c\s+([A-Za-z0-9_.-]+)=(?:"[^"]*"|'[^']*'|\S+)\s+/);
    if (c2) {
      if (!GIT_INERT_CONFIG_KEYS.includes(c2[1].toLowerCase())) return { ok: false, roots: [] }; // 실행 유발 가능 설정 → 인식 거부
      rest = rest.slice(c2[0].length);
      continue;
    }
    break;
  }
  // blame 추가(2026-08-03 실측): 검증자가 판독을 git blame -L로 상시 수행 — blame은 지정 파일을 읽지
  // 않고는 그 출력을 낼 수 없으므로(cat·grep과 같은 의미론 기준) 목록 원칙 안의 확장이다.
  // 임의 실행기(node -e 등) 제외는 불변.
  const subM = rest.match(/^(diff|show|grep|blame)(?:\s|$)/i);
  if (!subM) return { ok: false, roots: [] };
  // 옵션 fail-closed 허용목록(확인 검증 ab-3 실행 반례: blame --contents·따옴표/장옵션 축약 우회·
  // show --format+--no-patch — 전부 '읽지 않고 대상 경로+임의 내용 출력'을 만들 수 있었다):
  // 금지 열거는 따옴표("--contents")·축약(--conten)·미지 옵션에 계속 뚫리므로, 각 하위명령의
  // '실제 파일 본문을 내는 안전한 형태'에 필요한 옵션만 허용하고 목록 밖 대시 토큰이 하나라도 있으면
  // 인식 거부한다(과대 승격이 아니라 unknown — GIT_INERT_CONFIG_KEYS와 같은 허용목록 원칙).
  // `--` 뒤는 경로 자리이므로 옵션 검사에서 제외한다.
  //  - blame: 범위 지정 -L만. --contents류·미지 옵션 전부 거부.
  //  - show: 옵션 전면 거부(판독 형태 `show REV:path`/`show REV -- path`엔 옵션이 불필요) — --format 위조 차단.
  //  - diff: 문맥·통계·검사만. --line-prefix/--src-prefix류(임의 문자열 주입) 거부.
  //  - grep: 검색 플래그만(출력은 파일의 실제 매칭 줄뿐).
  const SAFE_GIT_OPTS = {
    blame: (t) => /^-L\S*$/.test(t),
    show: () => false,
    diff: (t) => ["--check", "--stat", "--cached", "--staged", "--name-only", "--name-status", "--no-color"].includes(t) || /^-U\d*$/.test(t) || /^--unified=\d+$/.test(t),
    grep: (t) => ["-e", "-A", "-B", "-C", "--line-number", "--fixed-strings", "--ignore-case"].includes(t) || /^-[niFwlchEv]+$/.test(t) || /^-[ABC]\d+$/.test(t),
  };
  const optOk = SAFE_GIT_OPTS[subM[1].toLowerCase()];
  // 토큰화는 따옴표 인지(셸 의미와 일치): "패턴 A + B" 같은 다중 단어 문자열이 조각나 중간 조각이
  // 비따옴표 토큰으로 오판되면 정상 grep 인식이 깨진다(회귀 실측). 따옴표 span=한 토큰.
  const toks = (rest.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || []).slice(1);
  let pastDD = false;
  for (const t0raw of toks) {
    // 상위에서 $t=(git …) 그룹 괄호를 벗긴 잔여 닫는 괄호·세미콜론만 꼬리에서 제거 — 여는/내부 괄호는
    // 아래 문자집합이 계속 거부하므로 표현식 우회 통로가 되지 않는다.
    const t0 = t0raw.replace(/[);]+$/, "");
    if (pastDD) continue;
    if (t0 === "") continue;
    const t = t0.replace(/^["']+/, "").replace(/["']+$/, ""); // 따옴표 감싼 옵션("--contents")도 옵션으로 본다
    if (t === "--") { pastDD = true; continue; }
    // 동적 확장 봉쇄(확인 검증 ab-3 실행 반례 누적: $env:OPT·$('--contents')·$opts=@(…)·맨괄호식
    // ('--contents')·([string[]](…))). 위험 문자를 열거하면 표기법마다 계속 뚫리므로 반전한다:
    //  ① $·백틱은 따옴표 안에서도 확장되므로 어디서든 거부.
    //  ② 비따옴표 토큰은 옵션·리비전·경로에 필요한 불활성 문자만 허용 — 괄호식·배열·스플래팅(@선두)·
    //     내부 따옴표·%VAR%·구분자 전부 집합 밖이라 자동 거부(미지 표기법도 unknown 방향 실패).
    //  ③ 따옴표로 감싼 토큰은 셸이 문자열 리터럴로 넘기므로(①만 통과하면) 내용 문자를 제한하지 않는다.
    // `--` 뒤는 git이 전부 경로로 해석하므로 옵션 주입 불가 — 검사 제외 유지.
    if (/[$`]/.test(t0)) return { ok: false, roots: [] };
    const quoted = /^["']/.test(t0);
    if (!quoted && (t0.startsWith("@") || !/^[A-Za-z0-9,._:~^\/\\@{}=-]+$/.test(t0))) return { ok: false, roots: [] };
    if (t.startsWith("-") && !optOk(t)) return { ok: false, roots: [] };
  }
  return { ok: true, roots };
}
function gitReadsFiles(lead) { return gitReadParse(lead).ok; }
// 셸 호출이 스스로 밝힌 작업 폴더. 같은 검증 안에서도 도구 호출마다 폴더가 다를 수 있어(브릿지를 띄운
// 폴더와 검증자가 실제로 파일을 읽은 폴더가 다름), 상대경로 인용을 한 폴더 기준으로만 풀면 못 맞춘다.
function toolCallWorkdir(p) {
  for (const raw of [p && p.arguments, p && p.input]) {
    let o = raw;
    if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = null; } }
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of ["workdir", "cwd", "working_dir", "workingDirectory"]) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return normSepWin(v);
      }
    }
  }
  return "";
}
// `$이름 = '리터럴'` 대입 1건. 값이 명령·치환이면 담지 않는다(실행 결과가 경로처럼 둔갑하는 것을 막음).
function shellLiteralAssign(stmt) {
  const m = String(stmt).trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"$`]*)"|'([^']*)')$/);
  return m ? { name: m[1], value: m[2] !== undefined ? m[2] : m[3] } : null;
}
function shellAssignTarget(stmt) {
  const m = String(stmt).trim().match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return m ? m[1] : "";
}
// 주석은 명령의 일부가 아니다 — 주석에 적힌 경로는 그 명령이 읽은 대상일 수 없다(2차 blocker② 대응).
// 따옴표 안의 #은 주석이 아니므로 인용 상태를 지키며 자른다.
function stripShellComment(stmt) {
  const s = String(stmt || "");
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote && s[i - 1] !== "\\" && s[i - 1] !== "`") quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}
function expandShellVars(part, map) {
  if (!map || !map.size) return part;
  return String(part).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, nm) => (map.has(nm) ? map.get(nm) : whole));
}
function splitShellStatements(text) {
  const out = [];
  let cur = "", quote = "";
  const push = () => { const s = cur.trim(); if (s) out.push(s); cur = ""; };
  const src = String(text || "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote && src[i - 1] !== "\\" && src[i - 1] !== "`") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "\r" || ch === "\n" || ch === ";" || ch === "|") {
      push();
      if (ch === "\r" && src[i + 1] === "\n") i++;
      if (ch === "|" && src[i + 1] === "|") i++;
      continue;
    }
    if (ch === "&" && src[i + 1] === "&") { push(); i++; continue; }
    cur += ch;
  }
  push();
  return out;
}
// functions.exec가 감싼 실제 호출들. 각 호출은 명령과 **자기 작업 폴더**를 같이 들고 있어서, 명령만 뽑고
// 폴더를 버리면 그 호출이 쓴 상대경로를 풀 기준이 사라진다(사용자 실보고 2026-07-29: 이 형태로 읽은
// 회차가 전부 '흔적 미확인'으로 남았다). 명령과 폴더를 짝지어 돌려준다.
// 짝짓기는 **같은 중괄호 블록에 들어 있을 때만** 인정한다(1차 blocker① — 글자 순서로만 짝지으면
// 명령 사이에 놓인 무관한 객체의 폴더가 끌려와, 읽지도 않은 폴더가 경로 기준이 된다).
// 소속을 확인할 수 없으면 폴더 없음으로 둔다(안전한 실패).
// JSON 이중따옴표 리터럴만 받아 임의 JS를 평가하지 않는다.
// 스크립트를 한 번 훑어 ①각 글자가 속한 중괄호 블록 ②주석 안인지 ③문자열 '안'인지를 함께 낸다.
// 문자열은 '여는 따옴표 다음부터' 안으로 본다 — 속성 이름이 따옴표로 감싸인 정상 형태("workdir": …)는
// 여는 따옴표에서 시작하므로 걸러지지 않고, 명령 문자열 속에 적힌 workdir 같은 글자는 걸러진다.
function scriptOwnerScan(s) {
  const owner = new Int32Array(s.length).fill(-1);
  const inStr = new Uint8Array(s.length);
  const inCmt = new Uint8Array(s.length);
  const closeOf = new Map(); // 여는 중괄호 → 닫는 중괄호(소속 블록의 끝을 알아야 '나중에 쓰였는지'를 본다)
  const stack = [];
  let i = 0, quote = "";
  const mark = (j, top, str, cmt) => { if (j < s.length) { owner[j] = top; inStr[j] = str; inCmt[j] = cmt; } };
  while (i < s.length) {
    const top = stack.length ? stack[stack.length - 1] : -1;
    const ch = s[i], nx = s[i + 1];
    if (quote) {
      mark(i, top, 1, 0);
      if (ch === "\\") { mark(i + 1, top, 1, 0); i += 2; continue; }
      if (ch === quote) quote = "";
      i++; continue;
    }
    if (ch === "/" && nx === "/") { while (i < s.length && s[i] !== "\n") { mark(i, top, 0, 1); i++; } continue; }
    if (ch === "/" && nx === "*") { mark(i, top, 0, 1); mark(i + 1, top, 0, 1); i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { mark(i, top, 0, 1); i++; } mark(i, top, 0, 1); mark(i + 1, top, 0, 1); i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { mark(i, top, 0, 0); quote = ch; i++; continue; }
    if (ch === "{") { mark(i, top, 0, 0); stack.push(i); i++; continue; }
    if (ch === "}") { const op = stack.pop(); if (op !== undefined) closeOf.set(op, i); mark(i, stack.length ? stack[stack.length - 1] : -1, 0, 0); i++; continue; }
    mark(i, top, 0, 0); i++;
  }
  return { owner, inStr, inCmt, closeOf };
}
function nestedShellCalls(text) {
  const s = String(text || "");
  const { owner, inStr, inCmt, closeOf } = scriptOwnerScan(s);
  const live = (idx) => !inStr[idx] && !inCmt[idx]; // 주석 안·문자열 안의 글자는 속성이 아니다
  const collect = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(s))) { if (!live(m.index)) continue; let v; try { v = JSON.parse(m[1]); } catch { continue; } out.push({ value: v, own: owner[m.index] }); }
    return out;
  };
  const cmds = collect(/(?:["'](?:cmd|command)["']|\b(?:cmd|command))\s*:\s*("(?:\\.|[^"\\])*")/g);
  const wds = collect(/(?:["'](?:workdir|cwd)["']|\b(?:workdir|cwd))\s*:\s*("(?:\\.|[^"\\])*")/g);
  // 실제로 '쓰인' 객체만 판독 후보로 본다(2차 blocker — 선언만 하고 안 쓴 객체나 정규식 안의 글자가
  // 도구 호출 증거로 집계되면, 파일을 읽지 않고도 판독 흔적을 만들 수 있다).
  // 쓰였다고 인정하는 두 가지: ①괄호 바로 안에 놓인 객체(호출 인수) ②이름에 담긴 뒤 그 이름이 나중에
  // 다시 나오는 경우(실제 형태 `const calls=[{…}]; calls.map(c=>tools.shell_command(c))`).
  // 둘 다 아니면 미인정한다 — 증명 못 하면 안 세는 쪽이 안전한 실패다.
  const prevCode = (i, skip) => { let j = i; while (j >= 0 && (!live(j) || skip.includes(s[j]))) j--; return j; };
  const usedLater = (name, from) => {
    const re = new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
    let m;
    while ((m = re.exec(s))) if (m.index > from && live(m.index)) return true;
    return false;
  };
  const openOf = new Map();
  for (const [o, c] of closeOf) openOf.set(c, o);
  const bound = (b) => {
    const p = prevCode(b - 1, " \t\r\n");
    if (p >= 0 && s[p] === "(") return true;                       // 호출 인수 자리
    // 배열 안 형제 객체를 건너뛰며 '이름에 담는 =' 를 찾는다(`const calls=[{…},{…}]` 형태).
    let q = prevCode(b - 1, " \t\r\n[,");
    while (q >= 0 && s[q] === "}" && openOf.has(q)) q = prevCode(openOf.get(q) - 1, " \t\r\n[,");
    if (q < 0 || s[q] !== "=") return false;                        // 이름에 담기지도 않음
    const idEnd = prevCode(q - 1, " \t\r\n");
    if (idEnd < 0) return false;
    let st = idEnd;
    while (st >= 0 && /[A-Za-z0-9_$]/.test(s[st]) && live(st)) st--;
    const name = s.slice(st + 1, idEnd + 1);
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
    const close = closeOf.has(b) ? closeOf.get(b) : b;
    return usedLater(name, close);
  };
  // 같은 객체 안에서만 짝짓고, 그 객체에 명령이나 폴더가 둘 이상이면 어느 것이 실제인지 알 수 없으므로
  // 폴더 결속을 통째로 포기한다(1차 blocker② — 중복 속성은 실행 시 마지막 값이 이기지만 우리가 그걸
  // 안다고 가정하면 안 된다. 모르면 폴더 없음이 안전한 실패).
  const cnt = (arr, own) => arr.filter((x) => x.own === own).length;
  const boundCache = new Map();
  const isBound = (b) => { if (!boundCache.has(b)) boundCache.set(b, bound(b)); return boundCache.get(b); };
  return cmds.filter((c) => c.own >= 0 && cnt(cmds, c.own) === 1 && isBound(c.own)).map((c) => {
    const own = cnt(wds, c.own) === 1 ? wds.find((w) => w.own === c.own) : null;
    return { command: c.value, workdir: own ? normSepWin(String(own.value)) : "" };
  });
}
function nestedShellCommands(text) { return nestedShellCalls(text).map((c) => c.command); }
function toolReadParts(p) {
  const values = toolArgumentValues(p);
  const name = String((p && (p.name || p.tool_name)) || "").toLowerCase();
  if (/apply[_-]?patch|write|delete|remove|list|glob/.test(name) && !/read|view|open/.test(name)) return [];
  if (/read|view|open/.test(name)) return values.map((v) => ({ text: v, workdir: "", weak: false }));
  // 증거 세기 구분(2026-07-29 — 검증 4왕복이 같은 벽에 부딪힌 뒤 결론): 도구 인수는 하네스가 기록한
  // '실제로 부른 것'이지만, 중첩 스크립트는 검증자가 **쓴 코드 글자**라 어느 줄이 실행됐는지 글자만으로는
  // 증명할 수 없다(실행 안 되는 분기·호출 아닌 이름 재사용 등이 계속 새 반례로 나왔다).
  // 그래서 스크립트에서 읽어낸 것은 **약한 증거**로만 쓴다: 경보(다룬 흔적 확인)에는 쓰고,
  // 신뢰 등급 승격에는 쓰지 않는다. 승격은 하네스가 기록한 인수만 인정한다.
  const nested = values.flatMap(nestedShellCalls);
  const sources = nested.length ? nested.map((c) => ({ ...c, weak: true })) : values.map((v) => ({ command: v, workdir: "", weak: false }));
  // 리터럴 대입을 풀어 넣되 **실행 순서를 지키고**(1차 blocker① — 뒤에 나온 대입이 앞 문장에 소급되면,
  // 없는 파일을 읽고 실패한 뒤 이름만 나중에 대입해도 '그 파일을 읽었다'가 된다), **호출 경계를 넘지
  // 않는다**(2차 blocker① — 셸 호출이 다르면 서로 다른 프로세스라 변수가 이어지지 않는다).
  // 리터럴이 아닌 대입은 그 변수의 값을 알 수 없게 되므로 복원 대상에서 지운다(옛 값이 남지 않게).
  // 각 조각은 자기가 나온 호출의 작업 폴더를 달고 나간다(경로 기준이 호출마다 다르기 때문).
  const out = [];
  for (const source of sources) {
    const vars = new Map();
    for (const s of splitShellStatements(source.command)) {
      if (toolCallCanReadFile(p, s)) out.push({ text: expandShellVars(stripShellComment(s), vars), workdir: source.workdir || "", weak: !!source.weak });
      const lit = shellLiteralAssign(s);
      if (lit) { vars.set(lit.name, lit.value); continue; }
      const tgt = shellAssignTarget(s);
      if (tgt) vars.delete(tgt);
    }
  }
  // [2026-08-03 문맥 보정 — 약한(경보) 축 한정] 검증자가 임의 코드 실행기(exec)에 '명령 문자열 배열'
  // (const cmds=["git grep … -- 파일", …])로 판독을 싣는 형태가 상시화되면서, 스크립트 본문이 문장
  // 선두 판정에 걸리지 않아 정직한 판독 회차마다 '근거 의심'이 붙었다(실측 2026-08-03 — 8/8 미인식).
  // 스크립트 글자는 기존 원칙대로 강한 증거가 될 수 없지만(어느 줄이 실행됐는지 글자만으론 증명 불가
  // — 위 3회 확장 철회 기록), '그 자체로 판독 명령 문장'인 따옴표 문자열 리터럴은 스크립트-글자 수준의
  // 흔적으로는 실재한다 → 약한 축에만 추가한다. 승격(strong)은 불변: 하네스 기록 인수만.
  // ⚠ 반드시 '원시 인수'에서 스캔한다 — toolArgumentValues는 백슬래시를 /로 바꾸므로 이스케이프 따옴표
  // (\")가 깨져 리터럴 경계가 무너진다(같은 날 실측: 정규화본에선 추출 0·원시본에선 정상 추출).
  // ⚠ 무결속 전체 스캔은 금지(재검증 blocker — 미실행 문자열·타 폴더 동명 파일이 경보를 거짓 해제):
  //   ①배열-사용 결속 — '문자열 배열로 선언된 변수'가 같은 스크립트에서 shell 실행 호출과 연결된
  //     경우에만 그 배열의 리터럴을 인정(선언만 하고 안 쓴 객체·정규식 표기=기존 미인정 계약 유지)
  //   ②작업 폴더 결속 — 스크립트가 밝힌 workdir가 하나면 부품에 부착(그 폴더만 기준), 서로 다른
  //     workdir가 여럿이면 어느 명령이 어느 폴더인지 글자로 못 가르므로 스캔 중단(fail-closed —
  //     경보가 남는 안전한 방향).
  const rawStrings = [];
  for (const raw of [p && p.arguments, p && p.input]) {
    if (typeof raw === "string") rawStrings.push(raw);
    else if (raw && typeof raw === "object") { try { rawStrings.push(JSON.stringify(raw)); } catch { /* 무시 */ } }
  }
  for (const rawText of rawStrings) {
    // workdir 결속: 밝혀진 workdir 값들을 수집 — 서로 다른 값이 2개 이상이면 이 스크립트는 건너뛴다
    const wds = new Set();
    let wdLitCount = 0; // 리터럴 '매치 수' — 고유값 수(Set)와 분리(같은 폴더 반복 명시는 정상·확인 반례 4)
    // 키의 따옴표 표기("workdir":)도 유효한 JS — 미인식이면 결속 우회가 된다(확인 반례).
    for (const wm of rawText.matchAll(/["']?workdir["']?\s*[:=]\s*"((?:[^"\\]|\\.)*)"|["']?workdir["']?\s*[:=]\s*'((?:[^'\\]|\\.)*)'/g)) {
      wdLitCount++;
      wds.add(normSepWin(((wm[1] !== undefined ? wm[1] : wm[2]) || "").replace(/\\(["'\\])/g, "$1")));
    }
    // 변수형 workdir(리터럴로 안 풀림)이 하나라도 있으면 결속 불가 — 폴백하면 교차 폴더 오인이
    // 되살아나므로 스캔 중단(fail-closed·확인 반례 2). 비교는 '키 수 vs 리터럴 매치 수' — 고유값
    // 수와 비교하면 같은 폴더를 두 호출에 반복 명시한 정상 스크립트가 오차단된다(확인 반례 4).
    const wdKeyCount = (rawText.match(/["']?workdir["']?\s*[:=]/g) || []).length;
    if (wds.size > 1 || wdKeyCount > wdLitCount) continue;
    const boundWd = wds.size === 1 ? [...wds][0] : "";
    // 배열-사용 결속: (const|let|var) 이름 = [ ... ] 로 선언된 배열 중, 그 이름이 shell 실행 호출과
    // 연결된 것만. 연결 판정=이름과 shell_command 가 한 문장 범위(200자) 안에서 함께 등장.
    for (const am of rawText.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*;/g)) {
      const arrName = am[1];
      const body = am[2];
      // 사용 판정은 '선언 구간을 지운 텍스트'에서만 — 선언 뒤에 우연히 shell_command가 이어지는
      // 미사용 배열이 '사용'으로 둔갑하는 헛점 차단(확인 반례 ①).
      const usageText = rawText.slice(0, am.index) + " ".repeat(am[0].length) + rawText.slice(am.index + am[0].length);
      const nameEsc = arrName.replace(/\$/g, "\\$");
      // 사용 판정 조임(확인 반례 — console.log(이름); 뒤 별개 shell_command 근접이 '사용'으로 둔갑):
      // ⓐ같은 표현식 연결 — 이름→(세미콜론 없이)→shell_command( (cmds.map(c=>tools.shell_command( 형)
      // ⓑ호출 인수 내 참조 — shell_command( 뒤 300자 인수 구간 안에 이름 (shell_command({command:cmds[i]}) 형)
      const usedChain = new RegExp("\\b" + nameEsc + "\\b[^;]{0,120}?shell_command\\s*\\(").test(usageText);
      // 인수 구간은 '괄호 균형'으로 한정한다(확인 반례 2 — 고정 300자 창은 호출이 끝난 뒤의
      // 로그·주석 속 이름까지 포섭해 미실행 배열을 되살림). 문자열 리터럴 안의 괄호는 건너뛴다.
      let usedArg = false;
      for (const cm of usageText.matchAll(/shell_command\s*\(/g)) {
        const from = cm.index + cm[0].length;
        let depth = 1, i2 = from, quote = "";
        const cap = Math.min(usageText.length, from + 600);
        while (i2 < cap && depth > 0) {
          const ch = usageText[i2];
          if (quote) { if (ch === "\\") i2++; else if (ch === quote) quote = ""; }
          else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") depth--;
          i2++;
        }
        if (depth !== 0) continue; // 괄호가 창 안에서 안 닫히면 인수 구간 미확정 — 인정하지 않음
        if (new RegExp("\\b" + nameEsc + "\\b").test(usageText.slice(from, i2 - 1))) { usedArg = true; break; }
      }
      if (!usedChain && !usedArg) continue;
      for (const m of body.matchAll(/"((?:[^"\\]|\\.)+)"|'((?:[^'\\]|\\.)+)'/g)) {
        const lit2 = normSepWin((m[1] !== undefined ? m[1] : m[2] || "").replace(/\\(["'\\])/g, "$1"));
        if (lit2.length < 4 || lit2.length > 4000) continue;
        for (const s2 of splitShellStatements(lit2)) {
          if (toolCallCanReadFile(p, s2)) out.push({ text: stripShellComment(s2), workdir: boundWd, weak: true });
        }
      }
    }
  }
  return out;
}
function toolCallNamesExactFile(p, fileKey, ws) {
  // 전용 read/view/open 도구는 인수 전체가 한 읽기 동작이다. 셸 호출은 문장별로 잘라, 다른 문장에서 이름만
  // 출력한 파일이 앞 문장의 읽기 명령 덕분에 함께 처리된 것으로 오인되지 않게 한다.
  // 반환: ""(아님) / "weak"(스크립트 글자에서 읽어냄 — 경보용) / "strong"(하네스가 기록한 인수 — 승격 가능)
  const readParts = toolReadParts(p);
  if (!readParts.length) return "";
  let best = "";
  // 상대경로 인용은 '그 명령이 실제로 돈 폴더' 기준으로 풀어야 맞는다. 기준 후보는 문장마다 다를 수 있어
  // (호출이 밝힌 작업 폴더 / 종전 기준 폴더 / git -C 로 지정한 저장소) 문장별로 만들어 대조한다.
  // 호출이 작업 폴더를 밝혔으면 **그 폴더만** 기준이다(1차 blocker③ — 기준 폴더를 둘 다 열어 두면
  // B 폴더에서 읽은 동명 파일이 A 폴더 파일의 판독으로 둔갑한다). 안 밝힌 경우에만 종전 기준(무회귀).
  // 우선순위: 그 조각이 나온 호출의 폴더 → 도구 인수의 폴더 → 종전 기준(무회귀). 하나만 쓴다.
  const wd = toolCallWorkdir(p);
  const hit = (v0, part) => {
    // 구분자 정규화는 **양쪽 모두**(2026-08-03 실측 — 매턴 오경보의 근본 원인): 중첩 스크립트 원문의
    // 백슬래시 경로(bridge\codex-bridge.js)는 JSON 이스케이프(\\)로 적혀 있고, 인수 정규화가 각 \를 /로
    // 바꾸면 bridge//codex-bridge.js 가 된다. 바늘만 정규화하면 이 본문과 영원히 불일치 — 연속 구분자를
    // 하나로 접어 비교한다(경로 의미 동일·모양 열거가 아니라 대조기 계층의 구조 수정).
    // ⚠ 플랫폼 분기(확인 검증 blocker): POSIX에서 \\는 경로 구분자가 아니라 파일명 문자 — 접으면 서로
    // 다른 파일(sub\deep.ts vs sub/deep.ts)을 동일시해 과대 인정이 된다. 백슬래시 접기는 win32 한정.
    const fold = process.platform === "win32"
      ? (s) => String(s).replace(/[\\/]+/g, "/")
      : (s) => String(s).replace(/\/+/g, "/");
    const v = fold(v0);
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9_.\\/-])(?:\\./)?${esc}(?=$|[^a-z0-9_.\\/-])`, process.platform === "win32" ? "i" : "");
    return re.test(fold(part));
  };
  // 기준 폴더는 '실제 경로'로도 한 번 더 시도한다. 윈도는 같은 폴더를 짧은 이름(RUNNER~1)으로도 가리키는데,
  // 인용에서 푼 파일 경로는 긴 이름이라 짧은 이름 기준으로 상대경로를 구하면 서로 다른 폴더로 계산된다
  // (2026-07-29 CI 실측: ws=…\RUNNER~1\… vs 인용키=…/runneradmin/… — 이 때문에 판독이 전부 미인정됐다).
  const realOf = (p0) => { try { return fs.realpathSync.native(p0); } catch { try { return fs.realpathSync(p0); } catch { return p0; } } };
  const rootsOf = (r) => { const rr = realOf(r); return rr && rr !== r ? [r, rr] : [r]; };
  for (const item of readParts) {
    const part = item.text;
    const baseRoots = rootsOf(item.workdir || wd || ws || process.cwd());
    const strength = item.weak ? "weak" : "strong";
    let matched = hit(fileKey, part);
    if (!matched) {
      for (const root of [...baseRoots, ...gitDirRoots(part).flatMap(rootsOf)]) {
        let rel = "";
        try { rel = normSepWin(path.relative(root, fileKey)); } catch { continue; }
        if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) continue;
        if (hit(rel, part)) { matched = true; break; }
      }
    }
    if (!matched) continue;
    if (strength === "strong") return "strong"; // 더 강한 증거가 나오면 즉시 확정
    best = "weak";
  }
  return best;
}
// `git -C <폴더>`로 지정한 저장소 — git이 인쇄하는 경로는 작업 폴더가 아니라 이 폴더 기준이다.
// 옵션 구간에서 소비된 값만 돌려주므로, 주석·인수 자리에 적힌 -C 는 기준이 되지 않는다.
function gitDirRoots(part) {
  // 앞머리 벗기기는 toolCallCanReadFile과 같은 순서여야 한다 — 여기서 괄호를 안 벗기면 판독으로는
  // 인정되는데 -C 로 준 저장소 기준만 사라져, 실행 폴더가 다를 때 경보가 남는다(1차 [보완]).
  const lead = String(part || "").trim().replace(/^&\s*/, "").replace(/^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "").replace(/^\(\s*/, "");
  const r = gitReadParse(lead);
  return r.ok ? r.roots : [];
}
function toolCallId(p) { return String((p && (p.call_id || p.callId || p.id)) || ""); }
function toolResultEvidence(call, result) {
  const statuses = [];
  const content = [];
  let successMarker = false;
  const visitString = (raw, keyed) => {
    const s = String(raw || "");
    if (!s) return;
    const trimmed = s.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 2_000_000) {
      try { const parsed = JSON.parse(trimmed); visit(parsed, "json"); return; } catch { /* 일반 출력 */ }
    }
    let m;
    const codeRe = /(?:process\s+exited\s+with\s+code|exit\s*code)\s*[:=]?\s*(-?\d+)/ig;
    while ((m = codeRe.exec(s))) statuses.push(parseInt(m[1], 10));
    if (/\bscript completed\b/i.test(s)) successMarker = true;
    const marker = /(?:final\s+output|output)\s*:\s*(?:\r?\n|$)/ig;
    let last = null;
    while ((m = marker.exec(s))) last = m;
    if (last) content.push(s.slice(last.index + last[0].length));
    else if (keyed) content.push(s);
  };
  const visit = (v, key) => {
    if (typeof v === "string") { visitString(v, /^(output|stdout|text|content|json)$/.test(String(key || ""))); return; }
    if (typeof v === "number" && /^(exit_code|exitCode|code|status)$/.test(String(key || ""))) { statuses.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, "content"); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(result, "result");
  const name = String((call && (call.name || call.tool_name)) || "").toLowerCase();
  const directRead = /read|view|open/.test(name) && !/apply[_-]?patch|write|delete|remove|list|glob/.test(name);
  const failed = statuses.some((n) => n !== 0);
  const succeeded = !failed && (statuses.some((n) => n === 0) || successMarker || directRead);
  return { ok: succeeded, text: content.join("\n").trim() };
}
function outputContainsCitedContent(output, snippets) {
  const hay = String(output || "");
  return !!hay && (snippets || []).some((s) => s && hay.includes(s));
}
function citedFilesUnseenExact(answer, ws, sessionId) {
  // 두 갈래로 돌려준다(2026-07-29 결론): unseen=**승격에 쓸 강한 증거**로도 확인 안 된 것,
  // unseenWeak=강한 증거든 스크립트 글자든 아무 흔적도 못 찾은 것(경보용).
  // 검증자가 쓴 스크립트 글자는 '무엇이 실행됐는지'를 증명하지 못하므로 승격 재료로 삼지 않는다.
  const unknown = { checked: false, unseen: [], unseenWeak: [] };
  if (!sessionId) return unknown;
  let file;
  try { file = findRolloutById(sessionId); } catch { return unknown; }
  if (!file) return unknown;
  const citedEvidence = citedResolvedEvidence(answer, ws);
  const remaining = new Set(citedEvidence.keys());
  const remainingWeak = new Set(citedEvidence.keys());
  if (!remaining.size) return { checked: true, unseen: [], unseenWeak: [] };
  const lines = rolloutTailLines(file);
  if (!lines) return unknown;
  // 턴 경계: 마지막 '사용자 메시지'(response_item message user) 줄 — 그 이후만 이번 ask의 활동.
  let lastUser = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || ln.indexOf('"message"') < 0) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o && o.type === "response_item" && o.payload && o.payload.type === "message" && o.payload.role === "user") lastUser = i;
  }
  if (lastUser < 0) return unknown; // 경계 미발견 — 세션 전체를 근거로 쓰지 않는다(판단 보류)
  let hadTool = false;
  const pending = new Map();
  for (let i = lastUser + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const p = o && typeof o.payload === "object" && o.payload ? o.payload : null;
    if (!p) continue;
    const t = p.type;
    if (t === "function_call" || t === "custom_tool_call") {
      hadTool = true;
      // 두 축을 **독립적으로** 본다: 약한 증거가 먼저 와서 경보 집합이 비어도, 승격 집합에 남은 파일은
      // 뒤에 오는 직접 도구 판독으로 여전히 확인될 수 있다(5차 blocker — 순서에 따라 강한 증거를 잃던 회귀).
      const files = [];
      for (const fp of new Set([...remaining, ...remainingWeak])) { const st = toolCallNamesExactFile(p, fp, ws); if (st) files.push({ fp, st }); }
      if (!files.length) continue;
      const id = toolCallId(p);
      if (!id) continue; // 강한 승격 증명은 호출-결과 동일 id가 필수 — 구형/불완전 사건의 순서 추측 금지
      pending.set(id, { call: p, files });
      continue;
    }
    if (t === "function_call_output" || t === "custom_tool_call_output") {
      const id = toolCallId(p);
      if (!id) continue;
      const rec = pending.get(id);
      if (!rec) continue;
      pending.delete(id);
      const proof = toolResultEvidence(rec.call, p);
      if (!proof.ok || !proof.text) continue;
      // 성공 코드와 비어 있지 않은 출력만으로도 다른 문장의 출력일 수 있다. 답에서 인용한 실제 줄 내용이
      // 반환물 안에 들어 있는 파일만 이번 턴에 다룬 것으로 인정한다.
      for (const f of rec.files) {
        // 경보 축(약한 증거): 판독 명령이 그 파일을 지목했고 호출이 성공했으면 '다뤘다'로 본다.
        //   실측(2026-07-29): 검증자가 파일을 읽고도 개수·해시만 출력하는 경우가 흔한데, 그때도
        //   그 파일을 다룬 것은 사실이다. 경보 문구 자체가 '흔적 확인'이지 '내용 대조'가 아니다.
        remainingWeak.delete(f.fp);
        // 승격 축(강한 증거): 종전 그대로 — 하네스가 기록한 인수 + 인용한 줄 내용이 출력에 실재해야 한다.
        if (f.st === "strong" && outputContainsCitedContent(proof.text, citedEvidence.get(f.fp))) remaining.delete(f.fp);
      }
      if (!remaining.size && !remainingWeak.size) break; // 둘 다 비어야 끝 — 한쪽만 비었다고 멈추면 다른 축을 잃는다
    }
  }
  if (!hadTool) return unknown; // 이번 턴 도구활동 없음 → 이전 턴 맥락 등으로 답했을 수 있음 → 판단 보류
  return { checked: true, unseen: [...remaining], unseenWeak: [...remainingWeak] };
}
// 경보용 — '아무 흔적도 못 찾은 것'만 알린다. 스크립트 글자로라도 판독이 보이면 경보하지 않는다
// (정직하게 읽은 회차가 매번 의심으로 남던 실보고 해소 — 승격은 아래 strong 축에서 따로 잠근다).
function citedFilesUnseen(answer, ws, sessionId) {
  const r = citedFilesUnseenExact(answer, ws, sessionId);
  return r.checked ? { checked: true, unseen: (r.unseenWeak || r.unseen).map((p) => path.basename(p)) } : r;
}
// [반복 억제 술어 2026-08-21 — 순수 함수(시험이 직접 실행)] 같은 세션의 '미ack' 근거의심 경보가 이번
// unseen 집합(basename)을 전부 덮고 있으면 재발행 억제. files 필드 없는 구형 이벤트=비교 불가라 억제 안 함
// (보수적 — 위장 억제 금지). ack된 경보는 대상 아님(사용자가 확인한 뒤 재발생하면 새 경보가 정당).
function shouldSuppressUnseenRepeat(events, implVal, wsVal, unseenBasenames) {
  const want = (unseenBasenames || []).map((f) => String(f));
  if (!want.length) return false;
  // R2 blocker(f-7f21c6a4)+R3: 억제 신원은 이벤트 전용 implId(implementerId 산출 — 모드 인지)로만 대조.
  // ①신원 미상(빈 값)=억제 금지 ②legacy session 필드는 C-C 전환 후 stale Claude 세션이 비어 있지 않게
  // 남는 오염 원천이라 억제 키로 쓰지 않는다(R3 실행 반례) ③implId 없는 구형 이벤트=비교 불가=억제 안 함
  // ④workspace 대조 결속(전역 장부 교차 오억제 차단).
  if (!String(implVal || "") || !String(wsVal || "")) return false;
  return (events || []).some((e) => e && e.kind === "evidence-unseen" && e.ack !== true
    && String(e.implId || "") === String(implVal) && String(e.workspace || "") === String(wsVal)
    && Array.isArray(e.files) && want.every((f) => e.files.includes(f)));
}
// [지문 결속 재발행 억제 2026-08-27 — 순수 함수(시험이 직접 실행)] 사용자 실보고: 같은 검증 세션을
// 이어 쓰는 구조에서 직전 회차에 재확인까지 끝난 파일들이 다음 회차마다 다시 '흔적 없음' 의심으로
// 떠 매 턴 경고가 반복됐다. 억제 조건(전부 충족·1차 검증 blocker 3건 반영):
// ① 이전 경보가 ack이고 **그 재확인이 실제로 resolved로 종결**된 것(resolvedEventIds — 사용자가
//    배너 '확인' 버튼으로 닫은 일반 ack는 재확인 성공이 아니므로 억제 근거가 아니다·ab-3).
// ② 같은 implId·workspace, 그리고 이번 의심 전 파일이 **실경로(절대경로) 단위**로 당시와 동일한
//    내용 지문(fileSha) — basename 축약은 타 경로 동명·동내용 파일의 정당한 경보를 숨긴다(ab-3).
// 지문·경로·신원·집합 어느 하나라도 결손이면 억제하지 않는다(보수).
function shouldSuppressUnseenAcked(events, implVal, wsVal, fpMap, resolvedEventIds) {
  if (!fpMap || typeof fpMap !== "object" || Array.isArray(fpMap)) return false;
  const names = Object.keys(fpMap);
  if (!names.length) return false;
  if (names.some((p) => typeof fpMap[p] !== "string" || !fpMap[p])) return false; // 지문 결손=억제 금지(보수)
  if (!String(implVal || "") || !String(wsVal || "")) return false;
  const resolved = resolvedEventIds instanceof Set ? resolvedEventIds : new Set(Array.isArray(resolvedEventIds) ? resolvedEventIds : []);
  return (events || []).some((e) => e && e.kind === "evidence-unseen" && e.ack === true
    && e.id && resolved.has(e.id) // 재확인 resolved 결속 — 일반 ack만으로는 억제 금지(blocker①)
    && String(e.implId || "") === String(implVal) && String(e.workspace || "") === String(wsVal)
    && e.filesFp && typeof e.filesFp === "object" && !Array.isArray(e.filesFp)
    && names.every((p) => typeof e.filesFp[p] === "string" && e.filesFp[p] === fpMap[p]));
}
// ws=configWs(이벤트 workspace 라벨 — 대시보드 귀속), execCwd=실제 실행 폴더(인용 상대경로 해석 기준).
// 분리 이유: 코덱스 답의 '(경로:라인)' 인용은 코덱스가 돈 폴더(execCwd) 기준 상대경로라, 라벨용 연 폴더로 해석하면 오탐.
function flagEvidence(answer, ws, sessionId, execCwd, chCtx) {
  // chCtx(재확인 배선·증분 4): {roots, promptText, mode, lang, campaignId, askId} — 있으면 경보 기록
  // '직후'에 challenge를 동결한다(설계 A — 경보 시점 세대 고정. 후처리 뒤에 읽으면 그 사이 편집된
  // 세대가 최초 스냅샷으로 둔갑해 file-changed 판정이 무력화된다·확인 검증 blocker). 발송은 호출자가
  // 후처리·checkpoint 뒤에 maybeDispatchChallenge로 수행한다(H — 탐지·발송 분리).
  const pathWs = execCwd || ws; // 경로 해석은 실행 폴더 기준(미지정 시 ws로 폴백=무회귀)
  try {
    const mism = checkCitedEvidence(answer, pathWs);
    if (mism.length) {
      appendIntegrityEvent({
        ts: nowIso(),
        session: claudeId() || ((readActive() || {}).claudeSession) || "",
        workspace: ws,
        kind: "evidence-mismatch",
        severity: "warning", // 노랑 — '의심'이지 '검증 미완(빨강)'은 아님
        // detailKo/detailEn 동시 저장(동적 목록 포함) — 표시부가 현재 언어 선택. detail은 구버전 판독 폴백.
        detail: tB(`검증 답의 인용 근거 ${mism.length}개가 실제 파일/라인과 불일치(존재하지 않는 줄): ${mism.slice(0, 3).join(" / ")}`, `${mism.length} cited evidence item(s) do not match real files/lines (nonexistent lines): ${mism.slice(0, 3).join(" / ")}`),
        detailKo: `검증 답의 인용 근거 ${mism.length}개가 실제 파일/라인과 불일치(존재하지 않는 줄): ${mism.slice(0, 3).join(" / ")}`,
        detailEn: `${mism.length} cited evidence item(s) do not match real files/lines (nonexistent lines): ${mism.slice(0, 3).join(" / ")}`,
      });
    }
    const seenChk = citedFilesUnseen(answer, pathWs, sessionId);
    const unseen = seenChk.checked ? seenChk.unseen : []; // 판단 보류(checked=false)는 경보 안 함 — 종전과 동일한 보수성
    // [반복 억제 2026-08-21 사용자 실보고] 같은 세션에서 아직 확인 안 된(미ack) 같은 파일 집합의 근거의심이
    // 이미 열려 있으면 새 경보를 또 만들지 않는다(같은 사유 경보 재발행 금지 관용구 — 08-04 계보).
    // 첫 발생은 그대로 경보·재확인이 돌고, 후속 회차의 동일 사유 반복만 조용해진다(ack되면 재발생 시 새 경보).
    const sessNow = claudeId() || ((readActive() || {}).claudeSession) || ""; // legacy 표시 필드(event.session — 억제 키 아님)
    const implNow = implementerId(ws); // 억제 신원(R3): 모드 인지·stale active 폴백 없음 — C-C에서 codex 스레드가 신원
    if (unseen.length && shouldSuppressUnseenRepeat(readIntegrityEvents(), implNow, ws, unseen)) {
      return { eventId: null, challengeId: null, suppressed: true }; // 호출자 계약(eventId/challengeId) 유지 — 억제는 부작용 0
    }
    if (unseen.length) {
      // 재확인 배선(증분 4): 이벤트 id를 선생성해 challenge 장부와 결속(전체 경로 목록은 exact에서)
      const evId = `${nowIso()}_${Math.random().toString(36).slice(2, 8)}`;
      const exact = citedFilesUnseenExact(answer, pathWs, sessionId);
      // [2026-08-27 매 턴 반복 경고 봉합 — 사용자 실보고] 동결(순수 계산·쓰기 없음)을 이벤트 기록보다
      // 먼저 수행해 두 판정 재료를 얻는다: ①전량 범위 밖/판독 불능(state no-dispatch)=사용자가 할 수
      // 있는 행동이 0인 경고 → 배너 대신 '자동 확인' 기록만 남긴다 ②대기(pending) 파일별 내용 지문
      // (fileSha) → 직전 ack 경보와 지문까지 같으면 재발행 억제(shouldSuppressUnseenAcked — 파일이
      // 바뀌면 지문 불일치로 다시 경보). 감지 계약([2-1] 턴 한정)은 무변경 — 발행 정책만 바꾼다.
      let frozen = null;
      if (chCtx && typeof chCtx === "object") {
        try {
          const ech0 = require("./evidence-challenge.js");
          frozen = ech0.freezeChallenge({
            eventId: evId, ws, execCwd: pathWs, roots: (chCtx.roots || []).filter(Boolean),
            files: exact.checked ? exact.unseenWeak : [],
            exposedTexts: [String(chCtx.promptText || ""), String(answer || "")],
            verifierSession: String(sessionId || ""), mode: chCtx.mode, lang: chCtx.lang,
            campaignId: chCtx.campaignId, askId: chCtx.askId,
          });
        } catch { frozen = null; /* 동결 실패=legacy 흐름(경보 유지) */ }
      }
      // 지문 지도: 동결의 pending 파일별 fileSha를 **실경로(절대경로) 키**로 접는다(1차 검증 blocker② —
      // basename 축약은 타 경로 동명·동내용 파일의 정당한 경보를 오억제). 경로가 키라 충돌이 없다.
      let fpMap = null;
      if (frozen && Array.isArray(frozen.files)) {
        fpMap = {};
        for (const f of frozen.files) {
          if (!f || f.status !== "pending" || !f.fileSha) continue;
          const p9 = String(f.path || "");
          if (!p9) continue;
          fpMap[p9] = f.fileSha;
        }
      }
      // ① 사전 확인 기록은 skipped 사유 **전원이 out-of-root**일 때만(1차 검증 blocker③ — too-large·
      //    read-fail·cap-exceeded·no-safe-span은 '지원 범위인데 판독 못 한' 상태라 배너 유지가 정직).
      const noDispatch = !!(frozen && frozen.state === "no-dispatch"
        && Array.isArray(frozen.files) && frozen.files.length > 0
        && frozen.files.every((f) => f && f.status === "skipped" && f.reason === "out-of-root"));
      // ② 지문 결속 억제 — 이번 의심 전 파일이 pending 지문을 갖고, '재확인이 resolved로 끝난'(1차 검증
      //    blocker① — 일반 확인 ack 제외) 직전 경보와 실경로·지문 전부 일치할 때만.
      if (!noDispatch && fpMap && Object.keys(fpMap).length === unseen.length) {
        let resolvedIds = new Set();
        try {
          const echS = require("./evidence-challenge.js");
          for (const rc of echS.listChallenges(ws)) if (rc && rc.state === "resolved" && echS.eventFullyResolved(rc) && rc.eventId) resolvedIds.add(rc.eventId);
        } catch { resolvedIds = new Set(); /* 판독 실패=억제 근거 없음(보수) */ }
        if (shouldSuppressUnseenAcked(readIntegrityEvents(), implNow, ws, fpMap, resolvedIds)) {
          return { eventId: null, challengeId: null, suppressed: true }; // 호출자 계약 유지 — 억제는 부작용 0
        }
      }
      const detKo = `검증 답이 인용한 파일 ${unseen.length}개를 이 검증 기록에서 다룬 흔적을 확인하지 못했습니다(이전 턴에서 봤거나 기록 형식 차이일 수 있음 — '안 읽음' 단정 아님): ${unseen.slice(0, 3).join(" / ")}`
        + (noDispatch ? " · 재확인 가능한 안전 구간이 없어 자동 확인으로 기록만 남깁니다(행동 불필요)" : "");
      const detEn = `${unseen.length} cited file(s) show no trace of being handled in this verification log (may be from an earlier turn or a log-format difference — not asserting 'unread'): ${unseen.slice(0, 3).join(" / ")}`
        + (noDispatch ? " · no safely re-checkable span exists, so this is auto-acknowledged as a record only (no action needed)" : "");
      appendIntegrityEvent({
        id: evId,
        ts: nowIso(),
        session: sessNow,
        workspace: ws,
        implId: implNow, // 억제 신원 결속(R3 — legacy session과 분리·모드 인지)
        files: unseen.slice(), // 전체 basename 목록(반복 억제 대조 재료 — detail의 앞 3개 절단과 별개)
        ...(fpMap && Object.keys(fpMap).length ? { filesFp: fpMap } : {}), // 지문 결속 억제 재료(다음 회차 대조)
        // ① 전량 범위 밖=사전 확인 기록(배너 제외) — 삭제가 아니라 ack 상태로 남는 기록(ab-5).
        ...(noDispatch ? { ack: true, autoAcked: "no-dispatch" } : {}),
        kind: "evidence-unseen",
        severity: "warning", // 노랑(의심) — '안 읽음' 단정이 아니라 '기록에서 다룬 흔적 미확인'
        // detailKo/detailEn 동시 저장(동적 목록 포함) — 표시부가 현재 언어 선택. detail은 구버전 판독 폴백.
        detail: tB(detKo, detEn),
        detailKo: detKo,
        detailEn: detEn,
      });
      // 재확인 배선(증분 4): 이벤트 '저장 확인' 후에만 동결 기록([주의] 반영 — 경보가 실제로 남지 않았으면
      // 어떤 추가 전송 재료도 만들지 않는다). 동결 계산은 위에서 끝났고, 장부 쓰기만 저장 확인 뒤에 한다.
      let challengeId = null;
      if (frozen && readIntegrityEvents().some((e) => e.id === evId)) {
        try {
          const ech = require("./evidence-challenge.js");
          if (ech.writeChallenge(frozen)) challengeId = frozen.challengeId;
        } catch { /* best-effort — 기록 실패=발송 없음(경보 유지) */ }
      }
      return { eventId: evId, challengeId, ...(noDispatch ? { autoAcked: true } : {}) };
    }
  } catch { /* best-effort — 점검 실패가 검증 흐름을 막지 않음 */ }
  return null;
}
// ── 근거 재확인 발송(설계 §3·§4·§5 — 증분 4) ────────────────────────────────────────────
// 원 턴의 모든 후처리(proof·flags·verdict·telemetry)와 출력 조립·(내구면 §6 checkpoint)이 끝난 뒤에만
// 호출된다(H — 탐지·발송 분리). 예산·proof·판정·findings 파이프라인을 일절 건드리지 않고(B), 어떤
// 실패도 원 검증 결과에 영향을 주지 않는다(G — 전체 best-effort). 같은 프로세스가 lease를 보유한 채
// resume하므로 원 검증→재확인 사이 무잠금 구간이 없다(§7 token 이관). 응답은 CH 줄만 파싱(재귀 없음).
// §5 K — resolved→ack 재투영(복구·멱등): resolved로 종결됐지만 원 이벤트가 아직 미ack인 레코드를
// ack한다. 'resolved 기록 후 ack 전 중단'이 dedupe에 걸려 영구 미해소가 되는 경로 봉합(확인 검증
// blocker). 매 발송 진입 시 실행 — ack는 멱등이고 이벤트가 절단(50건 상한)으로 사라졌으면 할 일 없음.
function projectResolvedAcks(ws, ech) {
  for (const rec of ech.listChallenges(ws)) {
    if (rec.state !== "resolved" || !ech.eventFullyResolved(rec)) continue;
    try {
      const ev = readIntegrityEvents().find((e) => e.id === rec.eventId);
      if (ev && !ev.ack) ackIntegrityEvents([rec.eventId]);
    } catch { /* 실패=경보 유지(안전) — 다음 진입에서 재시도 */ }
  }
}
function maybeDispatchChallenge(opts) {
  try {
    const { ws, codexSession, challengeId, lang, runCodexFn } = opts || {};
    const ech = require("./evidence-challenge.js");
    ech.convergeStaleChallenges(ws); // §5 강제 종료 잔재 수렴(재발송 없음 — pending·dispatched 공통)
    projectResolvedAcks(ws, ech);    // §5 K 복구 재투영(멱등)
    if (!challengeId) return { skipped: "no-challenge" };
    const rec = ech.readChallenge(ws, challengeId);
    if (!rec || rec.state !== "pending") return { skipped: "not-pending" }; // 동결은 flagEvidence가 수행(경보 시점)
    if (minimumCallerTimeoutMs() < 60_000) return { skipped: "no-time" };   // 마감 임박 — 발송 포기(경보 유지=안전·stale 수렴이 정리)
    if (!ech.markDispatched(ws, challengeId).ok) return { skipped: "dispatch-refused" }; // 호출 전 원자 선기록·시도 1
    const run = runCodexFn || ((args, p) => runCodex(args, p));
    const r = run(["resume", codexSession], ech.buildChallengePrompt(rec, lang || rec.lang));
    if (!r || r.error || !r.answer || (typeof r.status === "number" && r.status !== 0)) {
      ech.markOutcomeUnknown(ws, challengeId); // 호출 실패=판정 대상 아님(태만 기록 금지 — §4)
      return { challengeId, outcome: "outcome-unknown" };
    }
    const judged = ech.judgeChallenge(rec, ech.parseChallengeResponse(r.answer, rec));
    const st = ech.settleChallenge(ws, challengeId, judged);
    if (st.ok && ech.eventFullyResolved(st.rec)) {
      // §5 K: resolved 선기록(settle) 뒤 ack 투영 — 재판독으로 실제 ack 여부를 확인해 정직 보고.
      let acked = false;
      try { ackIntegrityEvents([rec.eventId]); const ev = readIntegrityEvents().find((e) => e.id === rec.eventId); acked = !ev || ev.ack === true; } catch { /* 재투영이 재시도 */ }
      return { challengeId, outcome: "resolved", acked };
    }
    return { challengeId, outcome: judged.overall, acked: false };
  } catch { return { skipped: "error" }; }
}

function exactPathFromRoot(raw, root) {
  let p = normSepWin(String(raw || "")); // 장부측 바늘도 같은 플랫폼 규칙(POSIX=\ 보존)
  if (!p || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return null;
  const mnt = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mnt) p = mnt[1] + ":/" + mnt[2];
  const drv = p.match(/^\/([a-zA-Z]):\/(.*)$/);
  if (drv) p = drv[1] + ":/" + drv[2];
  const file = path.isAbsolute(p) ? p : path.resolve(root || process.cwd(), p);
  try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
  return canonicalFileKey(file);
}
function exactLedgerPathKeys(paths, root) {
  const out = new Set();
  for (const p of paths || []) {
    const key = exactPathFromRoot(p, root);
    if (key) out.add(key);
  }
  return out;
}
// 관측 장부 확인 신호(로드맵 ④ — L1-A v2) — 증거의 질을 이벤트에 남긴다(승격 판정은 유도기 DERIVE_V2):
//  claimed  = 답의 '결합확인 #id' 명시 표기(동봉 결합 후보의 id — 기계 판정 확실. 동봉이 유도하므로 태생적 echoed)
//  co-cited = 통과류 답 전체에서 항목의 서로 다른 경로 2개가 각각 실존 인용(약한 공동 인용 — 공동 인용≠결합 확인)
//  echoed   = 이번 ask 동봉의 '한 항목 안에' 그 경로 쌍이 함께 노출됐음(항목 단위 — 전역 합집합은 과도[Codex])
//  seen     = 이번 턴 정확 경로 읽기 흔적 검사 삼상태("ok"/"unknown" — 판정 불가를 확인 성공으로 오독 금지)
//  askId    = ask 실행 UUID('서로 다른 ask 실행' 판정 재료 — '독립 턴' 주장 아님)
// 반박은 명시 표기('결합반박 #id')만 자동 적재(기계 추측 반박 없음 — 발화 기록 CLI는 별도).
// 텍스트 메아리(항목 문구가 답에 보임)로는 확인 안 됨 — 자기강화 순환 차단. 실패가 검증 흐름을 절대 막지 않음.
function flagLedgerConfirms(answer, ws, sessionId, execCwd, extra) {
  try {
    const askId = extra && extra.askId ? String(extra.askId) : "";
    const attach = extra && extra.attach && typeof extra.attach === "object" ? extra.attach : { mapItems: [], couplings: [] };
    const verdict = extractVerdict(answer);
    // P1: 확인 신호는 '정찰 대상' 장부로 — 세션 폴더가 비-git 부모여도 개발 레포 장부에 쌓인다.
    // (인용 경로 해석은 계속 execCwd 기준 — 실제 모델이 본 파일 기준. 장부 '기록 대상'만 재해석 — Codex 합의)
    let target = ws;
    try { target = resolveScoutRepo(ws, loadContract(ws)).repo; } catch { /* ws 유지(fail-open) */ }
    const now = nowIso();
    const pathWs = execCwd || ws;
    const seenChk = citedFilesUnseenExact(answer, pathWs, sessionId);
    const seenState = seenChk.checked ? "ok" : "unknown";
    const unseen = new Set(seenChk.checked ? seenChk.unseen : []);
    // 실존·줄번호 유효 인용의 정확 경로 집합. 같은 basename의 다른 파일과 디렉터리 목록 출력은 결합 증거가 아니다.
    const cited = citedResolvedPaths(answer, pathWs);
    const citedPairOk = (paths) => {
      const keys = exactLedgerPathKeys(paths, target);
      return [...keys].filter((p) => cited.has(p) && !unseen.has(p)).length >= 2;
    };
    // ① 명시 표기(claimed) — 표식은 검증자의 '자기보고'라 방어 3겹(Codex 반례 왕복):
    //    ⑴ 행 단독만 인정(부정문 "…표기를 쓰지 않았다"·본문 예시 오인식 차단)
    //    ⑵ 같은 id에 확인·반박이 함께 오면 상충 — 둘 다 거부
    //    ⑶ 승격·강등 '재료'가 되려면 그 항목의 경로 2개가 답에서 실제 인용(라인 실재·미확인 아님)돼야 함(cited 필드
    //       — 인용 0개 답의 표식만으로 verified/disputed가 움직이는 것 차단. 기록 자체는 남김: 자기보고도 사실).
    //    id는 이번 ask에 실제 동봉된 결합 후보의 것만 인정(임의 id 날조 무시). 반박 표기는 실패 답에서도 유효.
    const byId = new Map((attach.couplings || []).map((cp) => [String(cp.id), cp]));
    if (byId.size) {
      const marks = new Map(); // id → Set(kinds)
      for (const line of String(answer || "").split(/\r?\n/)) {
        const m = line.match(/^\s*결합(확인|반박)\s*#([0-9a-f]{6})\s*$/);
        if (!m || !byId.has(m[2])) continue;
        let set = marks.get(m[2]);
        if (!set) { set = new Set(); marks.set(m[2], set); }
        set.add(m[1] === "확인" ? "confirmed" : "refuted");
      }
      for (const [id, kinds] of marks) {
        if (kinds.size > 1) continue; // 상충(확인+반박) — 자기모순 자기보고는 기록하지 않음
        const kind = [...kinds][0];
        const cp = byId.get(id);
        // cited='그 답이 항목 경로 2개를 실제(라인 실재) 인용했다'는 사실 기록 — 승격은 유도기에서 cited && seen=ok
        // 이중 게이트(promotableConfirm)로 판정되므로 여기서 seen을 겹쳐 걸지 않는다(기록의 의미를 순수하게).
        const citedOk = citedPairOk(cp.paths);
        appendLedgerEvent(target, { ts: now, type: kind, sig: cp.sig, grade: "claimed", echoed: true, askId, seen: seenState, cited: citedOk, from: `verify ${sessionId || "?"} ${verdict || "?"} — 명시 표기 #${id}${citedOk ? "" : " (인용 미동반 — 기록만)"}` });
      }
    }
    // ② 공동 인용(co-cited) — 통과류 판정에서만.
    if (verdict !== "pass" && verdict !== "pass-notes") return;
    const raw = readLedgerEventsText(target);
    if (!raw || !raw.trim()) return;
    // 원시 이벤트에서 sig→text 최소 집계(배포 사본은 out/ 유도기를 require 못 함).
    // 제외는 '현재 차단 중'(banned-unbanned 순계산 — 해제된 차단은 되살림, Codex 반례 2026-07-09)·대체·소멸만.
    // 반박 이력 항목에도 확인은 '기록'한다(2026-07-09 사용자 결정: 복권 재료를 문 앞에서 버리면 지식이 진화 못 함.
    // 승격 여부는 유도기의 복권 규칙[반박 이후 확인만 인정]이 판정).
    const texts = new Map(); const dead = new Set(); const banNet = new Map();
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (!o || !o.sig) continue;
      if (o.text && !texts.has(o.sig)) texts.set(o.sig, o.text);
      if (o.type === "banned") banNet.set(o.sig, (banNet.get(o.sig) || 0) + 1);
      else if (o.type === "unbanned") banNet.set(o.sig, (banNet.get(o.sig) || 0) - 1);
      else if (o.type === "superseded" || o.type === "tombstone") dead.add(o.sig);
    }
    for (const [s, n] of banNet) { if (n > 0) dead.add(s); }
    if (!texts.size) return;
    // cited(라인 실재 정확 경로 인용)·unseen은 위에서 표식 판정과 함께 계산됨(같은 재료 공유).
    if (cited.size < 2) return;
    // echo 판정용: 동봉 '항목 단위' 정확 경로 집합(경로+노트 안 경로들) — 전역 합집합 아님.
    const itemSets = (attach.mapItems || []).map((it) => {
      return exactLedgerPathKeys(ledgerPathsFromText(String(it.path || "") + " " + String(it.note || "")), target);
    });
    for (const cp of attach.couplings || []) {
      const ps = exactLedgerPathKeys(cp.paths || [], target);
      if (ps.size) itemSets.push(ps); // 결합 후보 동봉 자체도 '그 쌍의 노출'
    }
    for (const [sig, text] of texts) {
      if (dead.has(sig)) continue;
      // basename 8자 미만은 우연 일치 위험(index.ts류) → 제외(지도 채점기의 8자 규칙과 동일 근거)
      const ledgerPaths = ledgerPathsFromText(text).filter((p) => path.basename(p).length >= 8);
      const hit = [...exactLedgerPathKeys(ledgerPaths, target)].filter((p) => cited.has(p) && !unseen.has(p));
      if (hit.length < 2) continue;
      const echoed = itemSets.some((set) => hit.filter((p) => set.has(p)).length >= 2);
      appendLedgerEvent(target, { ts: now, type: "confirmed", sig, grade: "co-cited", echoed, askId, seen: seenState, from: `verify ${sessionId || "?"} ${verdict} — 실존 인용: ${hit.slice(0, 3).map((p) => path.basename(p)).join(", ")}` });
    }
  } catch { /* best-effort — 장부 실패가 검증 흐름을 막지 않음 */ }
}
// 정찰 대상 어긋남 자기진단의 '증거 수집'(구조 해법 2026-07-10 — buildScoutDirective의 detectScoutTargetDrift가 소비).
// 이 답이 실존 인용한 파일들이 어느 git 레포 소속인지 관측 1건으로 적재. 판정과 무관(어긋남은 실패 답에서도 보인다),
// 3트랙일 때만(2트랙 무회귀), 경로 해석은 execCwd 기준(세션 폴더 기준으로 풀면 어긋난 상황에서 증거 자체가 빈 값 —
// Codex 설계검증 2026-07-10). git root 탐지는 rev-parse --show-toplevel(디렉터리별 캐시·3s·실패 skip).
// safe.directory=* 는 이 발견 호출 1회 한정(레포 루트를 아직 모르는 단계라 특정 경로를 못 박음 — 읽기 전용 조회).
function collectScoutTargetEvidence(answer, ws, execCwd) {
  try {
    const c = loadContract(ws);
    if (!c || c.scoutMode !== "on") return;
    const re = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?\)/g; // citedResolvedBasenames와 동일 파서(같은 신호원)
    const text = String(answer || "");
    const files = new Set();
    let m;
    while ((m = re.exec(text)) && files.size < 40) { const f = resolveCitedPath(m[1], execCwd || ws); if (f) files.add(f); } // 파일 상한 40(비용 상수화 — Codex 보완)
    if (!files.size) return;
    const topCache = new Map(); const counts = new Map();
    for (const f of files) {
      const d = path.dirname(f);
      let top = topCache.get(d);
      if (top === undefined) {
        if (topCache.size >= 12) continue; // 서로 다른 디렉터리 git 조회 상한(동기 3s 누적 방지 — Codex 보완)
        try {
          const r = spawnSync("git", ["-c", "safe.directory=*", "-C", d, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, windowsHide: true });
          top = r.status === 0 && String(r.stdout).trim() ? String(r.stdout).trim() : null;
        } catch { top = null; }
        topCache.set(d, top);
      }
      if (!top) continue; // git 밖 파일은 레포 증거가 아님
      const k = normWs(top);
      const cur = counts.get(k) || { repo: top, n: 0 };
      cur.n++; counts.set(k, cur);
    }
    if (!counts.size) return;
    appendScoutTargetEvidence(ws, { ts: nowIso(), repos: [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 5) });
  } catch { /* best-effort — 수집 실패가 검증 흐름을 막지 않음 */ }
}
// rollout 끝에서 '마지막 turn의 모델 + 그 turn 1회 토큰(last_token_usage)'을 읽는다 — 검증 1건의 모델·비용 기록용.
// usage-monitor 구조: type==='turn_context'의 payload.model, payload.type==='token_count'의 info.last_token_usage. 파일 끝 256KB만(검증=보통 마지막 1턴). 못 찾으면 빈/ null(통계는 '미상').
function readLastTurnTail(file, bytes) {
  let raw = "";
  const fd = fs.openSync(file, "r");
  try {
    const sz = fs.fstatSync(fd).size;
    const start = Math.max(0, sz - bytes);
    const len = Math.min(sz, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    raw = buf.toString("utf8");
  } finally { fs.closeSync(fd); }
  let model = "", effort = "", last = null;
  for (const ln of raw.split(/\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o && o.type === "turn_context" && o.payload) {
      const m = o.payload.model || (o.payload.collaboration_mode && o.payload.collaboration_mode.settings && o.payload.collaboration_mode.settings.model);
      if (m) model = String(m); // 뒤로 갈수록 최신 turn 모델
      const ef = o.payload.effort || (o.payload.collaboration_mode && o.payload.collaboration_mode.settings && o.payload.collaboration_mode.settings.reasoning_effort);
      if (ef) effort = String(ef); // 추론강도(low/medium/high/xhigh) — turn_context.effort 또는 collaboration_mode.settings.reasoning_effort
    } else if (o && o.payload && o.payload.type === "token_count" && o.payload.info && o.payload.info.last_token_usage) {
      last = o.payload.info.last_token_usage; // 마지막 token_count의 1회 사용량
    }
  }
  const n = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
  const g = (s, c) => n(last[s] != null ? last[s] : last[c]); // snake 우선, camel 폴백
  const tokens = last ? { input: g("input_tokens", "inputTokens"), cachedInput: g("cached_input_tokens", "cachedInputTokens"), output: g("output_tokens", "outputTokens"), reasoning: g("reasoning_output_tokens", "reasoningOutputTokens"), total: g("total_tokens", "totalTokens") } : null;
  return { model: model, effort: effort, tokens: tokens };
}
function parseLastTurn(file) {
  try {
    let r = readLastTurnTail(file, 256 * 1024);
    if (!r.model || !r.tokens) { const big = readLastTurnTail(file, 2 * 1024 * 1024); r = { model: r.model || big.model, effort: r.effort || big.effort, tokens: r.tokens || big.tokens }; } // 끝 256KB에 모델·토큰이 안 잡히면 더 크게 재시도(누락 줄임)
    return r;
  } catch { return { model: "", effort: "", tokens: null }; }
}
// 비-깨끗한 결론을 사용자에게 '가시화'(실패=빨강·보류·불가=노랑). 자동 차단 안 함(설계 경계 결론: 품질은 강제 말고 가시화).
// 핵심: verdict는 '최신 상태'다. 새 검증 결과가 나오면 같은 세션의 직전 verdict-nonclean을 먼저 대체(supersede)한다 →
// 실패→수정→재검증 통과로 해소되면 그 경보도 사라진다(반복 검증이 무조건 경보를 남기는 cry-wolf 방지). 그 뒤 실패(빨강)·보류·불가(노랑)일 때만 새로 띄움.
// '통과'·'통과(보완)'은 새 경보를 만들지 않는다(굿하트 '통과 도장' 안 만들기). 단 답은 있는데 마지막 판정 줄이 없으면(null)
// verdict-missing 노랑으로 '표지 누락'을 가시화한다(대시보드 색 분류 입력이 비기 때문). 빈/공백 답은 아무 신호도 안 건드린다. answer=마지막 메시지(-o).
// ── P-12 2d 단일 시도 기록 계층(설계 동결 v5~v7) ──────────────────────────────
// 예산 예약 '직후' 생성 — 예약된 왕복의 모든 종결을 상호 배타 결과 5종
// {accepted, run-error, session-unresolved, proof-rejected, postprocess-error}로 정확히 1회 기록 '시도'한다
// (append는 기존 best-effort — 저장 성공 시 1행. 감사급 격상=잠금 후보). die(process.exit)·예기치 못한 예외로
// 명시 종결을 안 거치면 exit 훅이 단계 기반 매핑(pre-call→run-error / answered→proof-rejected /
// proof-accepted→postprocess-error)으로 기록 — 경로 열거가 아니라 구조적으로 우회 불가(6·7차 blocker).
// duration: 시도 생성 시각이 아니라 '모델 호출 직전'(markCallStart)부터 측정(7차 [보완] — 예약·전처리 시간 미포함).
function beginVerifyAttempt(ws, gateRes, profileSnap, modeSnap) {
  const r = gateRes || {};
  const a = {
    stage: "pre-call", recorded: false, callStartHr: null,
    meta: {
      profile: profileSnap || "", mode: modeSnap || "",
      campaignId: typeof r.campaignId === "string" ? r.campaignId : "",
      budgetTracked: r.tracked === true,
      untrackedReason: r.tracked === true ? "" : String(r.untracked || (r.unlimited ? "unlimited" : "") || ""),
      ...(r.tracked === true && Number.isInteger(r.n) && r.n >= 1 ? { verifyRound: r.n } : {}), // 권위 있을 때만(회차 의미 검증은 집계기도 재확인)
      ...(Number.isInteger(r.budget) ? { budget: r.budget } : {}),
    },
  };
  a.markCallStart = () => { if (!a.callStartHr) a.callStartHr = process.hrtime.bigint(); };
  // 구현검증 1차 blocker①: 측정 종료='답 수신 시각'(answered) — proof·기계 판독·stdout 등 후처리 시간을
  // 소요에 넣지 않는다(효과 측정 왜곡 방지). 실패 종결(수신 없음)은 종결 시각이 곧 실패 반환 시각.
  a.answered = () => { if (a.stage === "pre-call") { a.stage = "answered"; if (a.endHr === null) a.endHr = process.hrtime.bigint(); } };
  a.endHr = null;
  a.proofAccepted = () => { a.stage = "proof-accepted"; };
  a.record = (outcome, extra) => {
    if (a.recorded) return; // 이중 기록 방지(명시 지점·exit 훅 공용 플래그)
    a.recorded = true;
    let durationMs;
    if (a.callStartHr !== null) {
      const end = a.endHr !== null ? a.endHr : process.hrtime.bigint();
      const d = Number((end - a.callStartHr) / 1000000n); // bigint 차이→ms 정수(3차 [보완] 변환 계약)
      if (Number.isFinite(d) && d >= 0) durationMs = d;
    }
    try {
      appendVerdict({
        ts: nowIso(), workspace: ws,
        claudeSession: claudeId() || ((readActive() || {}).claudeSession) || "",
        outcome, ...a.meta, ...(durationMs !== undefined ? { durationMs } : {}),
        ...(extra || {}), // accepted: verdict·machine·model·tokens·answerChars·blockerCount / 그 외: 없음(원문·stderr 비저장)
      });
    } catch { /* 통계 실패가 검증 흐름을 막지 않음(best-effort) */ }
  };
  process.on("exit", () => {
    if (a.recorded) return;
    a.record(a.stage === "pre-call" ? "run-error" : a.stage === "answered" ? "proof-rejected" : "postprocess-error");
  });
  return a;
}
// [기억 권위 §4 C-2] 검증자 답의 '제약 처리 표기' 파서 — 행 단독 `제약적용|제약기각|제약대체 <abId>`만 인정
// (결합확인 #id 규약과 동형 — flagLedgerConfirms:행 단독·동봉 결속·상충 거부). 동봉되지 않은 abId는 무시
// (carrier.envelope.ab가 '전송된 그 경계'의 정본), 같은 id에 서로 다른 표기=상충 → 둘 다 거부.
// 무표기 동봉 ab 항목은 irrelevant로 집계 — '찾았지만 버림'과 '무관'을 검증자 자기보고로 구분한다.
function parseConstraintHandling(answerText, attCarrier) {
  const abIds = attCarrier && attCarrier.envelope && Array.isArray(attCarrier.envelope.ab) ? attCarrier.envelope.ab : [];
  if (!abIds.length) return null; // ab 동봉 없음=처리 표기 채널 자체가 비활성(빈 배열 기록도 하지 않음 — 분모 오염 방지)
  const KIND = { "적용": "used", "기각": "rejected", "대체": "superseded", "used": "used", "rejected": "rejected", "superseded": "superseded" };
  const seen = new Map(); // abId → handling | "conflict"
  for (const line of String(answerText || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:제약(적용|기각|대체)|constraint-(used|rejected|superseded))\s+(ab-\d+)\s*$/);
    if (!m) continue;
    const id = m[3], h = KIND[m[1] || m[2]];
    if (!abIds.includes(id)) continue;
    if (seen.has(id) && seen.get(id) !== h) seen.set(id, "conflict");
    else if (!seen.has(id)) seen.set(id, h);
  }
  return abIds.map((id) => ({ id, handling: seen.get(id) === "conflict" ? "conflict" : (seen.get(id) || "irrelevant") }));
}
// [기억 권위 C-3·구현검증 1차 blocker⑤] 사용자 가시 영수증 1줄 — 동봉 경계(ab)가 있을 때만.
// verdicts 행(C-2)과 같은 파서를 재사용(순수 함수 재계산 — 이중 기록 아님·표시 전용).
function memReceiptLine(answerText, attCarrier, lang) {
  try {
    const h = parseConstraintHandling(answerText, attCarrier);
    if (!h) return "";
    const n = (k) => h.filter((x) => x.handling === k).length;
    const en = lang === "en";
    return en
      ? `\n[memory receipt] ${h.length} ab constraint(s) enclosed — used ${n("used")} · rejected ${n("rejected")} · superseded ${n("superseded")} · unmarked ${n("irrelevant")}${n("conflict") ? ` · conflict ${n("conflict")}` : ""}\n`
      : `\n[기억 영수증] 경계 제약 ${h.length}건 동봉 — 적용 ${n("used")} · 기각 ${n("rejected")} · 대체 ${n("superseded")} · 무표기 ${n("irrelevant")}${n("conflict") ? ` · 상충 ${n("conflict")}` : ""}\n`;
  } catch { return ""; }
}
function flagVerdict(answer, ws, codexSession, modeSnapshot, machine, attempt, providerName, askId, attCarrier) {
  const provLabel = providerName || "Codex"; // 미지정=Codex(기존 문구 바이트 불변)
  try {
    const text = String(answer || "");
    if (!text.trim()) return; // 빈/공백 답 → 직전 신호(표지 누락 포함)도 함부로 안 건드림(supersede도 안 함)
    const session = claudeId() || ((readActive() || {}).claudeSession) || "";
    supersedeIntegrity(session, "verdict-missing", ws); // 새 답 도착 → 직전 '표지 누락' 신호는 갱신 대상(최신 1건만 유지)
    supersedeIntegrity(session, "machine-verdict", ws); // P-12 2c: 기계 판독 경보도 verdict와 같은 '최신 1건' 수명주기(새 답=직전 강등 경보 갱신)
    const v = extractVerdict(text);
    // 2순위: 모델·검증모드·이 검증 1회 토큰 수집(모델별/모드별 통계 재료). 못 읽으면 빈값/null → 통계에서 '미상' 처리. 과거 기록엔 이 필드들이 없다.
    let model = "", mode = modeSnapshot || "", codexTok = null, effort = ""; // mode는 cmdAsk 시작 시점 스냅샷(검증 중 사용자가 바꿔도 trigger 모드 보존)
    try { if (codexSession) { const f = findRolloutById(codexSession); if (f) { const lt = parseLastTurn(f); model = lt.model; effort = lt.effort || ""; codexTok = lt.tokens; } } } catch { /* rollout 파싱 best-effort */ }
    // 통계 누적(append-only, stats/verdicts.jsonl) — 대시보드 탭2 재료. 원문 저장 안 함(메타만). best-effort.
    // P-12 2c: machine 필드는 같은 행에 추가(별도 append 없음 — 검증 1회=통계 1행 유지). 2c=원시 메타까지·집계는 2d.
    const mFields = machine && machine.effective ? { machineEffective: machine.effective, machineDemoted: !!machine.demoted, machineCorrected: !!machine.corrected, machineReason: machine.reasonKey || "" } : {};
    // 2d([보완]1): blockerCount는 블록 정상 판독(core) 행만 — 손상·부재는 필드 생략(집계에서 '판독 불가' 분리).
    const bc = machine && machine.parse && machine.parse.ok ? { blockerCount: machine.parse.findings.filter((f) => f.tag === "blocker").length } : {};
    // [기억 권위 C-2] askId+동봉 요약+제약 처리(같은 행 필드 추가 — '검증 1회=통계 1행' 계약 준수·별도 append 금지).
    const memA = attCarrier && typeof attCarrier === "object" ? {
      memAttached: {
        map: Array.isArray(attCarrier.mapItems) ? attCarrier.mapItems.length : 0,
        couplings: Array.isArray(attCarrier.couplings) ? attCarrier.couplings.length : 0,
        ...(attCarrier.envelope ? { envelope: { sup: attCarrier.envelope.sup.length, ab: attCarrier.envelope.ab.length, oos: attCarrier.envelope.oos.length, hash: attCarrier.envelope.hash || null } } : {}),
      },
    } : {};
    const memH = (() => { try { const h = parseConstraintHandling(text, attCarrier); return h ? { memHandling: h } : {}; } catch { return {}; } })();
    const dlv9 = attCarrier && attCarrier.deliveryOut ? { delivery: { gen: attCarrier.deliveryOut.gen, mode: attCarrier.deliveryOut.mode, reason: attCarrier.deliveryOut.reason, changed: attCarrier.deliveryOut.changed || [], ...(attCarrier.postflight ? { postflight: { st: attCarrier.postflight.st, compacted: !!attCarrier.postflight.compacted, ts: attCarrier.postflight.ts || null } } : {}) } } : {}; // [§4-B ②] 전달 레코드 파생(같은 행)
    const row = { codexSession: codexSession || "", verdict: v || "unparsed", answerChars: text.length, model: model, mode: mode, effort: effort, codexTokens: codexTok, ...(askId ? { askId } : {}), ...memA, ...memH, ...mFields, ...bc, ...dlv9 };
    // 2d: 시도 계층이 있으면 accepted 1행으로 위임(검증 1회=통계 1행 유지 — 이중 append 없음). 없으면 기존 직접 기록(무회귀).
    if (attempt) attempt.record("accepted", row);
    else { try { appendVerdict({ ts: nowIso(), workspace: ws, claudeSession: session, ...row }); } catch { /* 통계 실패가 검증 흐름을 막지 않음 */ } }
    // P-12 2c: 강등·정정 가시화 — 기존 verdict 경보와 같은 계층(위 supersede로 최신 1건 유지). 원문 비복사(사유 키 문장만).
    if (machine && (machine.demoted || machine.corrected)) {
      const reasonKo = machineReasonText(machine, false);
      appendIntegrityEvent({
        ts: nowIso(), session, workspace: ws, kind: "machine-verdict", severity: "warning",
        detail: tB(machine.demoted ? `기계 판독이 판정을 '보류'로 강등했습니다(${reasonKo}) — 지적 블록과 판정 선언이 어긋나거나 블록이 없어, 선언 결론을 신뢰하지 않았습니다.` : `기계 판독이 '통과' 선언을 '통과(보완)'로 정정했습니다 — 비차단 지적이 지적 블록에 존재합니다.`,
          machine.demoted ? `Machine reading demoted the verdict to 'inconclusive' (${machine.reasonKey}) — the findings block is missing/corrupt or contradicts the declared verdict.` : `Machine reading corrected 'pass' to 'pass (notes)' — non-blocking findings exist in the findings block.`),
        detailKo: machine.demoted ? `기계 판독이 판정을 '보류'로 강등했습니다(${reasonKo}) — 지적 블록과 판정 선언이 어긋나거나 블록이 없어, 선언 결론을 신뢰하지 않았습니다.` : `기계 판독이 '통과' 선언을 '통과(보완)'로 정정했습니다 — 비차단 지적이 지적 블록에 존재합니다.`,
        detailEn: machine.demoted ? `Machine reading demoted the verdict to 'inconclusive' (${machine.reasonKey}) — the findings block is missing/corrupt or contradicts the declared verdict.` : `Machine reading corrected 'pass' to 'pass (notes)' — non-blocking findings exist in the findings block.`,
      });
    }
    if (!v) {
      // 답은 있는데 마지막 '검증:' 판정 줄이 없음 → 형식 위반 가시화. 별도 kind로 격리해 verdict-nonclean(실패 빨강·보류 노랑)은 안 건드린다.
      appendIntegrityEvent({
        ts: nowIso(),
        session,
        workspace: ws,
        kind: "verdict-missing",
        severity: "warning", // 노랑 — '통과 아님'이 아니라 '판정 표지가 없어 색 표시가 빔'
        // detailKo/detailEn 동시 저장 — 확장 표시부(readVisibleIntegrity)가 '그때그때 현재 언어'를 고른다(기록 시점 언어로 굳는 것 방지). detail은 구버전 판독 폴백.
        detail: tB(`${provLabel} 답에 마지막 '검증: 통과/통과(보완)/보류/실패' 판정 줄이 없습니다 — 대시보드 색 표시가 비고, 결론을 직접 확인해야 합니다.`, `${provLabel}'s answer has no final verdict line ('Verdict: pass/pass (notes)/inconclusive/fail') — the dashboard chip stays empty; check the conclusion yourself.`),
        detailKo: `${provLabel} 답에 마지막 '검증: 통과/통과(보완)/보류/실패' 판정 줄이 없습니다 — 대시보드 색 표시가 비고, 결론을 직접 확인해야 합니다.`,
        detailEn: `${provLabel}'s answer has no final verdict line ('Verdict: pass/pass (notes)/inconclusive/fail') — the dashboard chip stays empty; check the conclusion yourself.`,
      });
      return; // verdict-nonclean(직전 실패 빨강·보류 노랑)은 유지
    }
    supersedeIntegrity(session, "verdict-nonclean", ws); // 정상 판정 → 직전 비-깨끗 신호를 대체(통과면 그대로 해소)
    // P-12 2c([주의] 동승): 경보 축은 '실효 판정' 권위 — 기계가 보류로 강등한 답에 원시 '실패' 빨강을 병존시키면
    // 사용자가 실효 결론(보류)과 다른 색을 본다. 통계(위)는 원시 v+machine 필드로 그대로 남는다(원문 계층 불변).
    const vAlert = machine && machine.effective ? machine.effective : v;
    if (vAlert !== "fail" && vAlert !== "inconclusive") return; // 통과·통과(보완) → 새 경보 없음(직전 것은 이미 supersede로 정리)
    appendIntegrityEvent({
      ts: nowIso(),
      session,
      workspace: ws,
      kind: "verdict-nonclean",
      // 실패=빨강(error) — 대시보드 칩(실패=빨강)과 일치, '고쳐야 함'의 명확한 신호. 보류·불가=노랑(warning) — '검토하라'.
      // 빨강이어도 kind는 verdict-nonclean이라 재검증 통과 시 supersede로 자동 해소(검증 미완 빨강과 달리 ack 안 해도 사라짐).
      severity: vAlert === "fail" ? "error" : "warning",
      // detailKo/detailEn 동시 저장 — 확장 표시부가 현재 언어를 고름. detail은 구버전 판독 폴백.
      detail: vAlert === "fail"
        ? tB(`${provLabel} 결론이 '검증 실패'입니다 — 통과가 아닙니다. 대시보드 대화에서 결론과 근거를 확인하세요.`, `${provLabel}'s verdict is FAIL — not a pass. Check the conclusion and evidence in the dashboard conversation.`)
        : tB(`${provLabel} 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요.`, `${provLabel}'s verdict is not a pass (hold/unable/insufficient info — no conclusion). Check the conclusion in the dashboard conversation.`),
      detailKo: vAlert === "fail"
        ? `${provLabel} 결론이 '검증 실패'입니다 — 통과가 아닙니다. 대시보드 대화에서 결론과 근거를 확인하세요.`
        : `${provLabel} 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요.`,
      detailEn: vAlert === "fail"
        ? `${provLabel}'s verdict is FAIL — not a pass. Check the conclusion and evidence in the dashboard conversation.`
        : `${provLabel}'s verdict is not a pass (hold/unable/insufficient info — no conclusion). Check the conclusion in the dashboard conversation.`,
    });
  } catch { /* best-effort — 점검 실패가 검증 흐름을 막지 않음 */ }
}
// 지금 Claude 대화가 '실제로' 도는 폴더 — contract-inject 훅이 매 턴 active.json에 기록. 엉뚱 폴더 방어용.
function readActive() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "active.json"), "utf8"));
  } catch {
    return null;
  }
}
// 워크스페이스 키 정규화(대소문자/구분자/끝슬래시 차이 흡수) — 브릿지·확장 일치용.
function normWs(p) {
  // NFC: 환경별 유니코드 폼(NFC/NFD) 차이로 같은 경로가 다른 키 되는 것 방지. 브릿지·확장 3카피 '동일 규칙'이어야 함.
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
}
function lookupWorkspace(links, ws) {
  const n = normWs(ws);
  for (const k of Object.keys(links.byWorkspace || {})) {
    if (normWs(k) === n) return links.byWorkspace[k];
  }
  return null;
}

// 경로 하나를 실행형으로 포장: .js 런처면 node로 실행, 네이티브면 그대로 exec.
function wrapCodexPath(p, how) {
  if (/\.js$/i.test(p)) return { file: process.execPath, args: [p], how };
  if (/\.(cmd|bat)$/i.test(p)) return { file: p, args: [], how, shell: true }; // win 셰임(.cmd/.bat)은 셸 경유 필요
  return { file: p, args: [], how };
}

// codex-peek 확장이 기록해 둔 codex 실행 경로. 확장이 vscode API로 '사용자가 실제 쓰는 codex'
// (설정 지정값 또는 설치된 Codex 확장 내부)를 활성화 때마다 찾아 적는다.
// → 포터블/설치형·버전 폴더 변경과 무관하게 항상 현재 위치(자동추적 = 범용성·편의성의 핵심).
function readPinnedCodex() {
  try {
    const p = fs.readFileSync(path.join(BRIDGE_DIR, "codex-bin.txt"), "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}

// codex 실행 방법 해석. 반환 { file, args, how, shell? } → spawn(file, [...args, ...], { shell, input }).
// 우선순위(전부 override·doctor 표시 가능):
//   1) CODEX_BIN(env)       — 비-VSCode/CLI 에서 직접 지정
//   2) codex-bin.txt(확장)  — 사용자 설정값 또는 자동탐색 결과(포터블/설치형·버전 무관)
//   3) PATH 의 codex         — CLI 설치 표준(win은 셸로 .cmd/PATHEXT 해석; 프롬프트는 stdin이라 따옴표 안전)
// 경로를 직접 뒤지지 않는다 — 위치 추적은 확장이 vscode API로 담당(설치형태/버전에 안 깨짐).
function resolveCodex() {
  const isWin = process.platform === "win32";
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return wrapCodexPath(process.env.CODEX_BIN, "CODEX_BIN");
  const pinned = readPinnedCodex();
  if (pinned) return wrapCodexPath(pinned, "vscode-ext");
  return { file: "codex", args: [], how: "PATH", shell: isWin };
}

// codex가 실제 쓰는 home을 'codex doctor'로 탐지해 codex-home.txt에 기록(바이너리 자동추적 대칭).
// doctor 출력의 "CODEX_HOME   <경로> (dir)" 줄을 파싱. sessions = home/sessions.
function detectCodexHome() {
  const inv = resolveCodex();
  const r = spawnSync(inv.file, [...inv.args, "doctor"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1000 * 30,
    windowsHide: true,
    encoding: "utf8",
    shell: !!inv.shell,
  });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  // 줄 단위 앵커: 'CODEX_HOME  <경로> (dir)' 한 줄만 잡음(줄바꿈·다른 (dir) 줄 오탐 방지).
  // ⚠ 세션찾기 고장 시 1순위 점검: codex 업데이트로 doctor 출력 형식이 바뀌면 이 정규식이 안 맞아 home 탐지가 깨진다.
  const m = out.match(/^\s*CODEX_HOME\s+([^\r\n]+?)\s*\(dir\)\s*$/m);
  const home = m ? m[1].trim() : "";
  const f = path.join(BRIDGE_DIR, "codex-home.txt");
  let ok = false;
  try {
    if (home && fs.existsSync(home)) {
      ok = atomicWrite(f, home); // 저장 성공 여부를 그대로 — 거짓 성공 방지(doctor/탐지 신뢰성)
    }
  } catch {
    /* ignore */
  }
  return { home, ok };
}
function cmdDetectHome() {
  const { home, ok } = detectCodexHome();
  if (ok) process.stdout.write(`codex home 탐지·기록: ${home}\n  sessions = ${path.join(home, "sessions")}\n`);
  else process.stderr.write(`codex home 탐지 실패: 'codex doctor'에서 CODEX_HOME 줄을 못 읽음.\n  → codex 업데이트로 출력 형식이 바뀌었을 수 있음(detectCodexHome 정규식 확인). 현재 폴백 = ${CODEX_HOME}\n`);
}

function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return { bySession: {}, byWorkspace: {} };
  }
}
function saveLinks(links) {
  return atomicWrite(LINKS_FILE, JSON.stringify(links, null, 2));
}
// links.json 쓰기 단일 관문(CAS+재시도): 최신본을 읽어 mutate로 '내 부분'만 바꾸고, 쓰기 직전 파일이 그새
// 바뀌었으면(확장·다른 ask 프로세스가 저장) 최신본으로 다시 적용해 재시도한다 → 마지막 글쓴이가 남의 변경을
// 통째로 덮어쓰는 lost-update를 크게 줄인다. ⚠ 완전한 lock은 아님(재읽기↔쓰기 사이 미세 경쟁 잔존 — 문서화된 한계).
// P-1: 부재(ENOENT)와 '판독 실패/손상'을 구분한다 — 손상을 빈 문자열·{}로 축소해 덮어쓰면 전체 링크·설정 유실.
function readLinksRaw() { try { return fs.readFileSync(LINKS_FILE, "utf8"); } catch (e) { return (e && e.code === "ENOENT") ? null : undefined; } }
// 의미 검증(P-1 검증 반례): null·false·0·배열·문자열 루트는 JSON.parse가 '성공'하므로 구문 검사만으로는
// {}로 축소돼 덮어써진다. 루트와 byWorkspace/bySession(존재 시)이 일반 객체여야만 links 파일로 인정.
function isPlainObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function validLinksRoot(o) { return isPlainObj(o) && (o.byWorkspace === undefined || isPlainObj(o.byWorkspace)) && (o.bySession === undefined || isPlainObj(o.bySession)); }
// 쓰기 명령이 spawn 전에 links 상태를 판정하는 관문 — 손상 상태에서 autoNewFailed 기록·stale 제거가
// 계속 실패해 '링크 없음'으로 축소·새 세션 폭증으로 이어지는 반복 장애 차단(P-1 검증 지적 2).
function linksFileState() {
  const raw = readLinksRaw();
  if (raw === null) return "absent";
  if (raw === undefined) return "unreadable";
  try { const o = JSON.parse(raw); return validLinksRoot(o) ? "ok" : "corrupt"; } catch { return "corrupt"; }
}
function requireLinksWritable() {
  const st = linksFileState();
  if (st === "corrupt" || st === "unreadable") {
    die(tB(`⚠️ links.json이 ${st === "corrupt" ? "손상" : "판독 불가"} 상태입니다(${LINKS_FILE}). 유실 방지를 위해 어떤 기록도 하지 않았습니다 — 파일을 백업 후 복구(유효한 JSON으로 수정)하거나 삭제(연결·설정 초기화)한 뒤 다시 시도하세요.`, `⚠️ links.json is ${st} (${LINKS_FILE}). Nothing was written to prevent data loss — back up and repair the file (valid JSON) or delete it (resets links/settings), then retry.`), 4);
  }
}
function updateLinks(mutate, retries = 4) {
  const parseOr = (raw) => { // null=부재(신규 인정) / undefined=판독실패 / 파싱·의미검증 실패 → undefined(기록 거부)
    if (raw === null) return {};
    if (raw === undefined) return undefined;
    try { const o = JSON.parse(raw); return validLinksRoot(o) ? o : undefined; } catch { return undefined; }
  };
  for (let i = 0; i <= retries; i++) {
    const before = readLinksRaw();
    const o = parseOr(before);
    if (o === undefined) return false; // 손상·판독 실패=기록 거부(손상 바이트 보존 — P-1)
    o.bySession = o.bySession || {};
    o.byWorkspace = o.byWorkspace || {};
    mutate(o);
    if (readLinksRaw() !== before) continue; // 그새 누가 저장함 → 최신본으로 재적용(재시도)
    return saveLinks(o);
  }
  // 재시도 소진(계속 경합) — 최신본에 한 번 더 적용해 best-effort 저장(드롭보다 나음). 손상은 여기서도 거부.
  const o = parseOr(readLinksRaw());
  if (o === undefined) return false;
  o.bySession = o.bySession || {};
  o.byWorkspace = o.byWorkspace || {};
  mutate(o);
  return saveLinks(o);
}

// 연결 조회: 세션id 우선, 없으면 워크스페이스 폴백.
// 워크스페이스 링크를 우선한다(대시보드가 기록하는 것 = 사용자 명시 선택). bySession은 폴백.
// 과거엔 bySession을 우선해서, 한 번 --allow-new로 만들어진 세션이 박히면 대시보드로 다시
// 연결해도 안 먹고 엉뚱한 세션으로 검증이 가는 버그가 있었다 → 대시보드와 브릿지가 같은 기준을 보게 통일.
function harnessModeFor(ws) {
  try { return loadContract(ws).harnessMode === "codex-codex" ? "codex-codex" : "claude-codex"; }
  catch { return "claude-codex"; }
}
// C↔C 검증자는 전용 override가 있을 때만 분리한다. 없으면 Claude↔Codex의 codexSession을
// 실시간 상속한다(복사 아님). 따라서 Claude 모드 연결 변경을 자동으로 따라가며, override 삭제 시 즉시 복귀한다.
function verifierLinkForMode(raw, mode) {
  if (!raw) return null;
  const dedicated = mode === "codex-codex" && !!raw.codexCodexSession;
  const id = dedicated ? raw.codexCodexSession : raw.codexSession;
  if (!id) return null;
  return {
    ...raw,
    codexSession: id,
    linkedAt: dedicated ? (raw.codexCodexLinkedAt || raw.linkedAt) : raw.linkedAt,
    verifierSource: mode === "codex-codex" ? (dedicated ? "dedicated" : "shared") : "claude",
  };
}
function resolveLink(links, wsArg, modeArg) {
  const ws = wsArg || configWs(); // 링크 해석 기준 = 연 폴더(작업 cwd가 흔들려도 이 대화의 세션을 찾음)
  const mode = modeArg || harnessModeFor(ws);
  const wsLink = verifierLinkForMode(lookupWorkspace(links, ws), mode);
  if (wsLink) {
    const source = wsLink.verifierSource === "shared" ? tB("Claude 모드와 공유","shared with Claude mode")
      : wsLink.verifierSource === "dedicated" ? tB("C↔C 전용","C↔C dedicated")
      : wsLink.via === "ui" ? tB("workspace·UI지정","workspace·UI-set") : "workspace";
    return { ...wsLink, via: source };
  }
  // bySession 폴백은 '그 항목의 워크스페이스가 현재와 같을 때만'. 다른 워크스페이스의 stale 링크가
  // byWorkspace 미스 시 새어드는 교차오염(검증이 엉뚱한 세션으로 감)을 막는다. (Codex 검증 #4)
  const cid = claudeId();
  const sLink = cid ? links.bySession[cid] : null;
  const resolvedSession = sLink && normWs(sLink.workspace || "") === normWs(ws) ? verifierLinkForMode(sLink, mode) : null;
  if (resolvedSession) return { ...resolvedSession, via: tB("session(폴백)","session (fallback)") };
  return null;
}
// 연결 기록은 CAS 관문(updateLinks)을 통과 — ask 도중 확장/다른 프로세스가 links.json을 바꿔도
// 그 변경을 덮어쓰지 않는다. 연결 성공이므로 이 워크스페이스의 autoNewFailed 폭증방지 플래그도 함께 해제한다.
function recordLink(codexSession) {
  const wsNow = configWs(); // 링크 기록 기준 = 연 폴더(세션은 작업 cwd가 아니라 이 대화의 연 폴더에 묶인다)
  const claude = claudeId();
  const nk = normWs(wsNow);
  return withRoleLock(() => updateLinks((links) => {
    let previous = {};
    for (const k of Object.keys(links.byWorkspace)) if (normWs(k) === nk) previous = links.byWorkspace[k] || {};
    const mode = harnessModeFor(wsNow);
    // verifier 연결만 바꾸며 구현 역할·모델 기준선 등 같은 프로젝트의 다른 필드는 보존한다.
    // C↔C에서 새로 고른/생성한 verifier는 전용 override이고, 기본 상태는 codexSession 상속이다.
    const entry = mode === "codex-codex"
      ? { ...previous, codexCodexSession: codexSession, codexCodexLinkedAt: nowIso(), workspace: wsNow }
      : { ...previous, codexSession, workspace: wsNow, claudeSession: claude, linkedAt: nowIso() };
    if (entry.implementerSession === codexSession) throw new Error("implementer-verifier-session-conflict");
    if (mode !== "codex-codex" && claude) links.bySession[claude] = entry;
    // 정규화 키로 저장 + 동일 워크스페이스의 옛 키(대소문자 다름 등) 정리.
    for (const k of Object.keys(links.byWorkspace)) {
      if (normWs(k) === nk) delete links.byWorkspace[k];
    }
    links.byWorkspace[nk] = entry;
    if (links.autoNewFailed) delete links.autoNewFailed[nk]; // 연결됨 → 폭증방지 플래그 해제(호출부 중복 제거)
  }));
}
function clearStaleVerifier(staleId, wsNow) {
  const mode = harnessModeFor(wsNow);
  withRoleLock(()=>updateLinks((o)=>{
    if(mode!=="codex-codex")for(const k of Object.keys(o.bySession||{}))if(o.bySession[k]&&o.bySession[k].codexSession===staleId&&normWs(o.bySession[k].workspace||"")===normWs(wsNow))delete o.bySession[k];
    for(const k of Object.keys(o.byWorkspace||{}))if(normWs(k)===normWs(wsNow)){
      const cur=o.byWorkspace[k]||{};
      if(mode==="codex-codex"&&cur.codexCodexSession===staleId){delete cur.codexCodexSession;delete cur.codexCodexLinkedAt;o.byWorkspace[k]=cur;}
      else if(mode!=="codex-codex"&&cur.codexSession===staleId){delete cur.codexSession;delete cur.linkedAt;o.byWorkspace[k]=cur;}
    }
  }));
  return resolveLink(loadLinks(),wsNow,mode);
}

// ── 모델/생각강도 선택(프로젝트별) — links.json modelPrefs[normWs] = {model, reasoning} ──
// 런타임 검증(2026-06-20): 모델/생각강도는 세션에 고정 저장되지 않고 '호출별'이라, 매 resume/새세션
// 호출마다 -c로 다시 실어야 적용된다. 값은 TOML 파싱 실패 시 raw 문자열로 쓰여 따옴표 없이 model=gpt-5.5 안전.
function modelPrefFor(links, ws, mode) {
  const key = normWs(ws);
  if (mode === "codex-codex" && links.codexCodexModelPrefs && links.codexCodexModelPrefs[key]) return links.codexCodexModelPrefs[key];
  return (links.modelPrefs && links.modelPrefs[key]) || {};
}
function modelArgs(pref) {
  const a = [];
  if (pref && typeof pref.model === "string" && pref.model.trim()) a.push("-c", `model=${pref.model.trim()}`);
  if (pref && typeof pref.reasoning === "string" && pref.reasoning.trim()) a.push("-c", `model_reasoning_effort=${pref.reasoning.trim()}`);
  return a;
}

// ask --net 옵트인: 이 검증 1회에 한해 '파일 읽기전용 유지 + 외부 통신 허용' 권한 프로필을 -c 오버라이드로 주입.
// config.toml은 건드리지 않음(전역 기본은 현행 통신 차단 유지 — 검증자 안전설계). 기본 read-only 샌드박스는 죽은 프록시
// (127.0.0.1:9)를 하위 셸에 심어 통신을 끊는데, 이 프로필이 그걸 대체한다(0.118 실측: 프록시 해제·git ls-remote 성공·쓰기 여전히 거부).
// 도메인 allowlist(network.domains)는 Windows에서 미집행 실측(예: example.com 직결 성공)이라 넣지 않는다 — 거짓 안전감 방지.
// 즉 --net = "그 1회, 파일은 못 쓰지만 인터넷 전체가 열린다"가 정직한 계약.
function netArgs() {
  return [
    "-c", "default_permissions=netverify",
    "-c", 'permissions.netverify.extends=":read-only"',
    "-c", "permissions.netverify.network.enabled=true",
    "-c", "permissions.netverify.network.mode=limited",
  ];
}
// --net일 때 프롬프트 끝에 붙는 안내 — 검증자가 통신 가능함을 알고, Windows 인증서 함정(schannel)을 우회하게 한다(실측: openssl 백엔드는 성공).
function netNote(lang) {
  return lang === "en"
    ? "\n\n[Network enabled for this request (opt-in) — outbound access is allowed; filesystem stays read-only. On Windows, if git/curl fail with schannel certificate errors (SEC_E_NO_CREDENTIALS), retry with `git -c http.sslBackend=openssl ...` or use Python/Node HTTP.]"
    : "\n\n[이 요청은 네트워크 허용(옵트인) — 외부 통신 가능, 파일은 여전히 읽기전용. Windows에서 git/curl이 schannel 인증서 오류(SEC_E_NO_CREDENTIALS)를 내면 `git -c http.sslBackend=openssl ...`로 재시도하거나 Python/Node HTTP를 사용하라.]";
}

// sessions 폴더에서 특정 uuid의 rollout 파일 경로 찾기.
function findRolloutById(uuid) {
  let found = null;
  const walk = (d, depth) => {
    if (found || depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (found) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.includes(uuid) && it.name.endsWith(".jsonl")) found = full;
    }
  };
  walk(SESSIONS_DIR, 0);
  return found;
}

// 특정 시각 이후 생성/수정된 rollout 중 최신 → 방금 만든 세션 식별용.
function newestRolloutSince(sinceMs) {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        let m;
        try {
          m = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (m >= sinceMs && (!best || m > best.m)) best = { full, m };
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return best?.full || null;
}

// session_meta 첫 줄은 base_instructions가 함께 들어가 수십 KB가 될 수 있다. 고정 8KB 한 번만 읽으면 JSON이
// 중간에서 잘려 모든 최신 Codex 세션의 cwd 탐지가 실패하고, 새 세션이 답을 마칠 때까지 링크되지 않는다
// (2026-07-12 실사고: 그 사이 두 번째 --allow-new가 별도 고아 세션 생성). 줄바꿈까지 chunk로 읽되 1MiB에서
// 진단 실패로 닫는다 — 엉뚱 cwd 링크보다 미검출이 안전하다.
function readFirstJsonLine(file, maxBytes = 1024 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const chunks = []; let total = 0;
    while (total < maxBytes) {
      const buf = Buffer.alloc(Math.min(8192, maxBytes - total));
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (!n) break;
      const part = buf.subarray(0, n); const nl = part.indexOf(10);
      if (nl >= 0) { chunks.push(part.subarray(0, nl)); return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/\r$/, "")); }
      chunks.push(part); total += n;
    }
    return null;
  } catch { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// since 이후 rollout 중 '이 워크스페이스(session_meta.cwd 일치)'의 최신 → 즉시연결 시 동시 다른 폴더 세션을
// 잘못 링크하지 않게 한다(race 방어). cwd를 못 읽는 rollout은 제외(엉뚱 링크보다 미검출이 안전 — 폴백이 받아줌).
function newestRolloutSinceForWs(sinceMs, ws) {
  const want = normWs(ws || "");
  if (!want) return null;
  let best = null;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!(it.isFile() && /^rollout-.*\.jsonl$/.test(it.name))) continue;
      let m;
      try { m = fs.statSync(full).mtimeMs; } catch { continue; }
      if (m < sinceMs || (best && m <= best.m)) continue;
      const o = readFirstJsonLine(full);
      const cwd = o && ((o.payload && o.payload.cwd) || o.cwd || "");
      if (!cwd) continue; // 첫 줄(session_meta) 못 읽으면 제외
      if (normWs(cwd) === want) best = { full, m };
    }
  };
  walk(SESSIONS_DIR, 0);
  return best ? best.full : null;
}

// 세션 식별용: 그 세션의 첫 '실제' 사용자 발화를 짧게 뽑는다.
function firstUserSnippet(file) {
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      const s = l.trim();
      if (!s || s[0] !== "{") continue;
      let o;
      try {
        o = JSON.parse(s);
      } catch {
        continue;
      }
      if (o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "user") {
        let t = (o.payload.content || []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
        if (t && !/^<(environment_context|user_instructions|system|recommended_plugins>|hook_prompt[\s>])/i.test(t)) { // recommended_plugins>=Codex 실행 런타임 주입(닫는 > 요구 — 정상 유사 문자열 보존·확장 isInjected와 동형, 2026-07-10 실사고)
          // 주제 표시용: withContract가 붙인 지침 보일러플레이트를 걷어내고 '실제 요청 본문'만(확장 stripInjectedPreamble과 동일 규칙).
          for (const marker of ["\n---\n[작업 요청]\n", "\n---\n[Work Request]\n"]) {
            const i = t.lastIndexOf(marker);
            if (i >= 0) { t = t.slice(i + marker.length); break; }
          }
          return t.replace(/\s+/g, " ").trim().slice(0, 70);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return tB("(내용 미상)","(content unknown)");
}

// 최근 rollout(헤드리스 포함) 목록 — 최신 수정순.
// 숨긴 세션(대시보드 후보에서 제외). ~/.codex-bridge/sessions-meta.json (id→{state}). 원본 rollout은 안 건드림(§5.1).
function hiddenSessions() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "sessions-meta.json"), "utf8"));
    return new Set(Object.keys(o).filter((k) => o[k] && (o[k].state === "hidden" || o[k] === "hidden")));
  } catch {
    return new Set();
  }
}

function recentRollouts(limit) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        const m = it.name.match(UUID_RE);
        if (!m) continue;
        let mt = 0;
        try {
          mt = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        out.push({ id: m[1], file: full, mtime: mt });
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  const hidden = hiddenSessions();
  return out.filter((r) => !hidden.has(r.id)).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function indexedSessions() {
  try {
    return fs
      .readFileSync(INDEX_FILE, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// codex exec 실행(헤드리스). stdin 닫음(멈춤 방지), 최종 메시지는 -o 파일에서 회수.
function minimumCallerTimeoutMs() {
  const configured=verifyTimeoutMin()*60*1000;
  const deadline=Date.parse(process.env.CODEX_BRIDGE_VERIFY_DEADLINE_AT||"");
  return Number.isFinite(deadline)?Math.max(1,Math.min(configured,deadline-Date.now())):configured;
}
// [VerifierProvider Phase1 · 설계 §2] Claude 검증자 실행기(무상태 answer-only).
// 스모크 실측(2026-08-05): 성공={type:"result",is_error:false,result,session_id}·exit 0 / 오류=is_error:true·exit 1.
function resolveClaudeVerifier() {
  const envBin = String(process.env.CODEX_BRIDGE_CLAUDE_BIN || "").trim();
  if (envBin) {
    // 시험/오버라이드: .js면 node로 실행(가짜 검증자 주입 — worker fake와 같은 관용구), 그 외=실행파일 그대로.
    if (/\.js$/i.test(envBin)) return { file: process.execPath, args: [envBin], shell: false, how: "env:CODEX_BRIDGE_CLAUDE_BIN(node)" };
    return { file: envBin, args: [], shell: /\.(cmd|bat)$/i.test(envBin), how: "env:CODEX_BRIDGE_CLAUDE_BIN" };
  }
  // PATH의 claude(Windows=npm shim이라 shell 경유가 견고).
  return { file: "claude", args: [], shell: process.platform === "win32", how: "PATH" };
}
function runClaudeVerifier(promptText) {
  const inv = resolveClaudeVerifier();
  // 환경 격리(설계 §2): 구현 세션(Claude Code)의 훅·세션 변수가 검증자 프로세스로 새는 역할 오염 차단.
  // CLAUDE_CONFIG_DIR은 보존(로그인 자격이 그 안에 있다) — 세션·훅 문맥 변수만 제거.
  const env9 = { ...process.env };
  for (const k of Object.keys(env9)) if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PROJECT_DIR$/.test(k)) delete env9[k];
  const r = spawnSync(inv.file, [...inv.args, "-p", "--output-format", "json"], {
    input: promptText, stdio: ["pipe", "pipe", "pipe"], timeout: minimumCallerTimeoutMs(),
    windowsHide: true, encoding: "utf8", shell: !!inv.shell, maxBuffer: 1024 * 1024 * 256, env: env9,
  });
  let parsed = null;
  try { parsed = JSON.parse(String(r.stdout || "").trim()); } catch { parsed = null; }
  const badExit = typeof r.status === "number" && r.status !== 0;
  // 성공=정상 JSON+result 문자열+is_error 아님+정상 종료(부분/오류 출력이 성공처럼 소비되지 않게 — runCodex 원칙).
  const ok = !!(parsed && typeof parsed.result === "string" && parsed.result.trim() && parsed.is_error !== true) && !badExit && !r.error;
  let diag = "";
  if (!ok) {
    diag = tB(`\n[브릿지 진단] claude 실행방식=`, `\n[bridge diagnostics] claude invocation=`) + `${inv.how}` +
      `\n  spawn=${r.error ? r.error.code || r.error.message : "ok"} · exit=${r.status} · signal=${r.signal || "-"} · json=${parsed ? "ok" : "parse-failed"}` +
      (parsed && parsed.is_error ? `\n  is_error: ${String(parsed.result || "").slice(0, 300)}` : "") +
      tB(`\n  (자세한 점검: node "${__filename}" doctor)`, `\n  (details: node "${__filename}" doctor)`);
  }
  return { ok, answer: ok ? parsed.result.trim() : "", sessionId: parsed && parsed.session_id ? String(parsed.session_id) : "", error: r.error, status: r.status, stderr: (r.stderr || "").toString() + diag };
}

function runCodex(extraArgs, prompt) {
  const inv = resolveCodex();
  const outFile = path.join(os.tmpdir(), `codex_bridge_${process.pid}_${Date.now()}.txt`);
  // 프롬프트는 인자가 아니라 stdin으로 전달 → 따옴표/줄바꿈/셸(.cmd) 무관하게 안전(범용).
  const codexArgs = [...inv.args, "exec", "--skip-git-repo-check", "-o", outFile, ...extraArgs];
  const r = spawnSync(inv.file, codexArgs, {
    input: prompt,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: minimumCallerTimeoutMs(),
    windowsHide: true,
    encoding: "utf8",
    shell: !!inv.shell,
    // 무거운 검증(코덱스가 파일을 많이 읽으면 stderr가 커짐)에서 기본 1MB를 넘으면 Windows가 ENOBUFS로
    // spawn을 죽여 검증이 결과 없이 실패한다 → 천장을 크게 올려 출력량 때문에 검증이 깨지지 않게 한다.
    maxBuffer: 1024 * 1024 * 256,
  });
  let answer = "";
  try {
    answer = fs.readFileSync(outFile, "utf8").trim();
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* ignore */
  }
  // 종료코드 nonzero는 -o 파일이 남아도 실패로 본다(부분/오류 출력이 성공처럼 소비되지 않게).
  const badExit = typeof r.status === "number" && r.status !== 0;
  // 실패 시 "무엇으로 어떻게 실패했는지"를 붙인다 — 다음 세션이 추측으로 헤매지 않게.
  let diag = "";
  if (r.error || !answer || badExit) {
    diag =
      tB(`\n[브릿지 진단] codex 실행방식=`, `\n[bridge diagnostics] codex invocation=`) + `${inv.how} · file=${path.basename(inv.file)}` +
      (inv.args.length ? ` · launcher=${path.basename(inv.args[0])}` : "") +
      `\n  spawn=${r.error ? r.error.code || r.error.message : "ok"} · exit=${r.status} · signal=${r.signal || "-"}` +
      tB(`\n  (자세한 점검: node "${__filename}" doctor)`, `\n  (details: node "${__filename}" doctor)`);
  }
  return { answer, error: r.error, status: r.status, stderr: (r.stderr || "").toString() + diag };
}

// 새 세션 전용 비동기 실행 — 답을 기다리는 동안 rollout이 생기는 '즉시' onDetect(sessionId)를 호출(생성 즉시 연결).
// resume 경로는 기존 동기 runCodex 그대로(무위험). 반환 shape은 runCodex와 동일(+detected). cwd 일치 rollout만 조기 감지(race 방어).
function threadIdFromJsonLine(line){
  try{const o=JSON.parse(line);const id=(o&&o.type==="thread.started"&&o.thread_id)||o.thread_id||o.session_id||"";const m=String(id).match(UUID_RE);return m?m[1]:"";}catch{return "";}
}
function runCodexNewSessionAsync(extraArgs, prompt, sinceMs, ws, onDetect, onSpawn) {
  const inv = resolveCodex();
  const outFile = path.join(os.tmpdir(), `codex_bridge_${process.pid}_${Date.now()}.txt`);
  // --json의 thread.started.thread_id를 1차 권위로 삼아 rollout 첫 줄/mtime 탐지 실패에도 생성 즉시 연결한다.
  const codexArgs = [...inv.args, "exec", "--json", "--skip-git-repo-check", "-o", outFile, ...extraArgs];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.file, codexArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: !!inv.shell });
      try { onSpawn && onSpawn(child.pid); } catch { /* parent pid 표식이 계속 방어 — 자식 pid 보강 실패는 비치명 */ }
    } catch (e) {
      return resolve({ answer: "", error: e, status: null, stderr: "", detected: null });
    }
    let stderr = "";
    let jsonBuf = "";
    let detected = null;
    let timedOut = false;
    let done = false;
    const detect = () => {
      try {
        const f = newestRolloutSinceForWs(sinceMs, ws); // cwd 일치만(동시 다른 폴더 세션 오링크 방지)
        const mm = f && f.match(UUID_RE);
        if (mm) { detected = mm[1]; try { onDetect && onDetect(mm[1]); } catch { /* 다음 폴서 재시도 */ } } // onDetect 자체 멱등(연결 성공시만 멈춤) → recordLink 재시도 허용
      } catch { /* ignore */ }
    };
    const detectJsonLine=(line)=>{const id=threadIdFromJsonLine(line);if(id){detected=id;try{onDetect&&onDetect(id);}catch{/* final fallback */}}};
    if(child.stdout)child.stdout.on("data",(d)=>{jsonBuf+=d.toString();const lines=jsonBuf.split(/\r?\n/);jsonBuf=lines.pop()||"";for(const line of lines)if(line.trim())detectJsonLine(line);});
    if (child.stderr) child.stderr.on("data", (d) => { if (stderr.length < 4 * 1024 * 1024) stderr += d.toString(); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* ignore */ }
    const poll = setInterval(detect, 700);                                  // 답 도중 rollout 생기면 즉시 링크
    const killer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ignore */ } }, minimumCallerTimeoutMs());
    const finish = (status, err) => {
      if (done) return; done = true;
      clearInterval(poll); clearTimeout(killer);
      if(jsonBuf.trim())detectJsonLine(jsonBuf);
      detect();                                                              // 마지막 한 번 더(폴링이 놓쳤을 수도)
      let answer = "";
      try { answer = fs.readFileSync(outFile, "utf8").trim(); } catch { /* ignore */ }
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      let diag = "";
      const badExit = typeof status === "number" && status !== 0;
      if (err || !answer || badExit || timedOut) {
        diag = tB(`\n[브릿지 진단] codex 실행방식=`, `\n[bridge diagnostics] codex invocation=`) + `${inv.how} · file=${path.basename(inv.file)}` +
          `\n  spawn=${err ? err.code || err.message : "ok"} · exit=${status} · timeout=${timedOut}` +
          tB(`\n  (자세한 점검: node "${__filename}" doctor)`, `\n  (details: node "${__filename}" doctor)`);
      }
      resolve({ answer, error: err || (timedOut ? new Error("timeout") : null), status, stderr: stderr + diag, detected });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code, null));
  });
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const ASK_FLAGS = new Set(["--allow-new", "--force-new", "--net", "--force-resend", "--folder-changed-ok"]); // --folder-changed-ok=[P7 ⓑ] 폴더 변경 기록 확인 후 진행
function askRequest(rest) {
  const flags = (rest || []).filter((x) => ASK_FLAGS.has(x));
  let prompt = (rest || []).filter((x) => !ASK_FLAGS.has(x) && x !== "--job-prompt").join(" ").trim();
  // 내구 작업 worker 전용: 프롬프트를 프로세스 명령줄에 노출하지 않고 job JSON에서 읽는다.
  if ((rest || []).includes("--job-prompt") && process.env.CODEX_BRIDGE_JOB_PROMPT_FILE) {
    try { prompt = String(JSON.parse(fs.readFileSync(process.env.CODEX_BRIDGE_JOB_PROMPT_FILE, "utf8")).prompt || "").trim(); }
    catch { prompt = ""; }
  }
  return { flags, prompt };
}

function askJobFile(id) {
  const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return safe ? path.join(ASK_JOBS_DIR, safe + ".json") : "";
}
function askJobPidFile(id){const f=askJobFile(id);return f?f.replace(/\.json$/,".pid"):"";}
function readAskJob(id) {
  const f = askJobFile(id);
  if (!f) return null;
  try { const o = JSON.parse(fs.readFileSync(f, "utf8")); return o && typeof o === "object" ? o : null; }
  catch { return null; }
}
function pidAlive(pid) { try { if (!(Number.isInteger(pid) && pid > 0)) return false; process.kill(pid, 0); return true; } catch { return false; } }
function askJobLockFile(ws) { return path.join(ASK_JOBS_DIR, ".lock-" + crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0,16)); }
// [3b] 잠금 획득/해제 분리 — worker(별 프로세스)가 die 없는 자체 오류 처리로 같은 프로토콜을 쓰기 위함.
// withAskJobLock은 이 두 조각의 합성(프로토콜 단일 출처 — 잠금 파일·토큰·재시도 규칙이 갈리지 않게).
function acquireAskJobLock(ws) {
  fs.mkdirSync(ASK_JOBS_DIR, { recursive:true });
  const file=askJobLockFile(ws), token=process.pid+"-"+crypto.randomBytes(4).toString("hex");
  for(let i=0;i<200;i++){
    try{fs.writeFileSync(file,token,{flag:"wx"});return {ok:true,token};}
    catch{
      // 죽은 보유자라도 자동 삭제하지 않는다. read→delete 사이 다른 프로세스가 새 잠금을 얻는 ABA 경합에서
      // 그 새 잠금을 지워 이중 진입할 수 있기 때문이다. 짧은 잠금 잔재는 명시 진단 후 수동 복구가 안전하다.
      try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}catch{/* retry */}
    }
  }
  return {ok:false};
}
function releaseAskJobLock(ws, token) {
  try{const f=askJobLockFile(ws);if(fs.readFileSync(f,"utf8")===token)fs.unlinkSync(f);}catch{/* 무해 */}
}
function withAskJobLock(ws, fn) {
  const a=acquireAskJobLock(ws);
  if(!a.ok)die(tB("검증 작업 잠금 획득 실패 — 새 작업을 만들지 않았습니다.","Could not acquire the verification job lock — no job was created."),3);
  try{return fn();}finally{releaseAskJobLock(ws,a.token);}
}
// [3b] 취소 의사 내구 파일 — .json 확장자 금지(corruptAskJobFiles가 job 파일로 오인해 신규 생성을 차단).
// 기록은 ask-job clear가 잠금 안에서, 관측·회수는 selecting worker가 페이지 경계와 전이 직전(같은 잠금)에서.
function askJobCancelIntentFile(id) { return path.join(ASK_JOBS_DIR, id + ".cancel-intent"); }
// P-4: 손상(파싱 불가·비객체) job 파일 목록 — activeAskJob은 손상 파일을 건너뛰므로(타 작업 보호)
// '실행 중 job이 손상되면 활성 없음으로 축소→중복 worker 생성' 구멍이 있었다. 신규 생성 전에 진단해 차단.
const QUARANTINE_BLOCK_MS = 60 * 60 * 1000; // verifyTimeoutMin의 기존 코드 상한(60분) 재사용 — 새 상수 아님(P-12 ⓚ)
function corruptAskJobFiles() {
  let names = [];
  try { names = fs.readdirSync(ASK_JOBS_DIR); } catch { return []; }
  const bad = [];
  for (const n of names) {
    // §6 checkpoint 부속물(<askId>.checkpoint.json)은 작업 파일이 아니다 — ask-job-v1 스키마 검사에
    // 걸려 '손상'으로 오판되면 새 작업 생성이 전면 차단된다(2026-08-04 실사고: 재확인 배선이 처음
    // 실전 작동한 직후 발생). 유효성은 전용 판독기(primaryCheckpointValid)가 자체 검증하고, 이 검사의
    // 목적(활성 판정 우회 차단)과 무관하므로 제외가 정답.
    if (n.endsWith(".checkpoint.json")) continue;
    if (n.endsWith(".json")) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(ASK_JOBS_DIR, n), "utf8"));
        // 의미 손상(P-4 3차 blocker): 파싱은 되지만 정본 필드가 깨진 객체(schema·id↔파일명·state)는
        // activeAskJob의 활성 판정을 우회해 중복 worker를 허용하므로 함께 차단. 구스키마 잔존 job도
        // 여기 걸린다 — 확인 후 clear로 해소(안내 메시지에 명시).
        const stOk = ["queued", "selecting", "running", "succeeded", "failed"].includes(o && o.state); // 상태 오타=활성 판정 우회 차단(구현검증 1차 blocker) · selecting=서고 선별(3b)
        const wsOk = o && typeof o.workspace === "string" && o.workspace.trim(); // workspace 소실·공백뿐=활성 판정 우회 차단(재검증 2차 blocker)
        const dlOk = !(o && (o.state === "queued" || o.state === "selecting" || o.state === "running")) || Number.isFinite(Date.parse(o && o.deadlineAt || "")); // 진행형은 deadline 필수
        if (!o || typeof o !== "object" || Array.isArray(o) || o.schema !== "ask-job-v1" || typeof o.id !== "string" || !askJobIdOk(o.id) || o.id + ".json" !== n || !stOk || !wsOk || !dlOk) bad.push(n);
      } catch { bad.push(n); }
      continue;
    }
    // 격리 파일 시한부 차단(P-12 ⓚ — '격리 즉시 해제'는 살아있는 worker와 중복 가능): 격리시각+60분까지 유지.
    const m = /\.json\.corrupt-(\d+)$/.exec(n);
    if (m) { const ts = Number(m[1]); if (Number.isFinite(ts) && Math.abs(Date.now() - ts) < QUARANTINE_BLOCK_MS) bad.push(n); } // |now-ts|<60분 — 미래 시각(시계 역행·조작)이 무기한 차단이 되지 않게(재검증 2차 blocker)
  }
  return bad;
}
// [개선 1-B 확인 blocker②] 이 작업공간의 가장 최근 검증 잡 id — finding-judge --oos·--list-oos가 동결 레코드의 askId와 대조해
// '다른 판(이전 판)의 번호'를 거부한다(입장 심사의 envJid 결속과 같은 방향·CLI는 잡 env가 없어 장부에서 최신 잡을 찾는다).
function latestAskJobIdFor(ws) {
  let names = [];
  try { names = fs.readdirSync(ASK_JOBS_DIR).filter((n) => n.endsWith(".json") && !n.endsWith(".checkpoint.json")); } catch { return null; }
  const key = normWs(ws);
  let best = null;
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ASK_JOBS_DIR, n), "utf8"));
      if (!j || j.schema !== "ask-job-v1" || typeof j.id !== "string" || normWs(j.workspace || "") !== key) continue;
      const ts = Date.parse(j.createdAt || "") || 0;
      if (!best || ts > best.ts) best = { id: j.id, ts };
    } catch { /* 깨진 타 작업은 건너뜀 */ }
  }
  return best ? best.id : null;
}
function activeAskJob(ws) {
  let names = [];
  try { names = fs.readdirSync(ASK_JOBS_DIR).filter((n) => n.endsWith(".json")); } catch { return null; }
  const key = normWs(ws);
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ASK_JOBS_DIR, n), "utf8"));
      if (normWs(j.workspace || "") !== key || !["queued", "selecting", "running"].includes(j.state)) continue;
      // queued는 workerPid가 기록되기 전의 짧은 창도 살아있는 작업으로 본다. 죽은 worker라도 자동 재전송하지 않고
      // 사용자가 상태를 확인해 명시 clear하도록 보수 차단(ask-active의 abandoned 정책과 동일).
      return j;
    } catch { /* 깨진 타 작업은 건너뜀 */ }
  }
  return null;
}
// P-6: 같은 구현 턴에서 성공했지만 아직 영수증이 없는(=미회수) C-C job을 찾는다 — 새 ask-start가 세션
// 단일 proof 슬롯을 덮기 전에 회수를 강제하기 위한 검사(구현 검증 1차 지적 4).
function unretrievedSameTurnJob(ws, frozen) {
  let names = [];
  try { names = fs.readdirSync(ASK_JOBS_DIR).filter((n) => n.endsWith(".json")); } catch { return null; }
  const key = normWs(ws);
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ASK_JOBS_DIR, n), "utf8"));
      if (j.schema !== "ask-job-v1" || j.harnessMode !== "codex-codex" || j.state !== "succeeded") continue;
      if (normWs(j.workspace || "") !== key) continue;
      if (j.implementerSession !== frozen.implementerSession || j.implementerTurnId !== frozen.implementerTurnId) continue;
      // 귀속 가능한 의미 손상(현재 턴에 결속되는데 id 누락·파일명 불일치)은 건너뛰지 않고 파일명 id로
      // conflict 차단한다(3차 지적 4 — undefined 반환으로 새 시작이 허용되던 구멍).
      const fid = n.slice(0, -5);
      if (!askJobIdOk(String(j.id || "")) || j.id !== fid) return fid;
      // 존재만 보면 빈 파일·타 내용 영수증을 회수 완료로 오인한다(2차 지적 3) — job·proof에 결속된
      // 유효 영수증(receiptSettled: 스키마+5필드+지문 사슬)이어야 회수 완료.
      if (!receiptSettled(j)) return j.id;
    } catch (e) { try { process.stderr.write("unretrieved-scan skip " + n + ": " + String(e && e.message || e) + "\n"); } catch { /* 진단 실패 무해 */ } }
  }
  return null;
}

// 주입 구조화 3단계: 요청문 뼈대 경고(관측 단계) — stdout(기계 출력)을 오염시키지 않도록 stderr로만.
// 플랜 3단계의 다른 축인 '지적 처리 확인 관문'은 신설하지 않는다 — findingDispositionGate(예산 예약 전
// 실행)가 이미 그 기능이다(judgeAdmission은 검증자 '제출 지적'의 입장 심사 — 다른 축. 구현 검증 정정).
function warnAskShape(prompt, cmd) {
  try {
    const shape = askShapeCheck(prompt);
    if (shape.ok) return;
    process.stderr.write(askShapeNotice(shape.missing, loadLang()) + "\n");
    appendAskShape({ ts: new Date().toISOString(), cmd, missing: shape.missing.map((m) => m.id) });
  } catch { /* 경고 실패=시작 방해 금지 */ }
}
// [4b 이중 배달 §4] selector-preview — 검증에 앞서 '이번 작업에 실릴 보관 수칙'을 구현자가 미리 본다.
// 같은 실행기·같은 중립 입력(사용자 원문 스냅샷+변경물 — 검증 요청문 없음)·같은 상한. 판정 권위 없음 —
// 산출은 영수증(purpose:"preview"·이 턴 스냅샷 지문 결속)뿐이고, 그 영수증이 preview 게이트와 ask-start의
// 선행 조건을 푼다. 검증 판은 worker가 fresh 선별을 따로 돈다(이 결과를 재사용하지 않음 — 오염 차단).
async function cmdSelectorPreview() {
  const en = loadLang() === "en";
  const ws = configWs();
  const c = loadContract(ws);
  if (!(typeof c.archiveHash === "string" && c.archiveHash)) {
    process.stdout.write(tB("서고(2층 수칙서) 미도입 — 미리보기가 필요 없습니다(코어 수칙은 매 검증 전량 주입).\n", "Archive (two-tier rulebook) not adopted — no preview needed (core rules are always fully injected).\n"));
    return;
  }
  const ctx = constraintTurnContext();
  if (!ctx.ok) die(tB(`⚠️ 이번 턴의 사용자 원문 스냅샷이 없어 선별할 수 없습니다(${ctx.reason}) — 구현 대화에서 새 프롬프트를 한 번 보내 턴을 다시 기록한 뒤 재시도하세요.`, `⚠️ No user-prompt snapshot for this turn (${ctx.reason}) — send one new prompt in the implementer conversation, then retry.`), 3);
  const target = resolveScoutRepo(ws, c).repo;
  const arc = readVerifyEnvelopeArchive(target);
  if (arc.st !== "ok" || arc.sha1 !== c.archiveHash) die(tB(`⚠️ 승인 서고가 도장 시점과 다릅니다(${arc.st === "ok" ? "내용 불일치" : arc.st}) — 대시보드에서 확인·재승인 후 재시도하세요.`, `⚠️ The approved archive differs from its stamped state (${arc.st === "ok" ? "content mismatch" : arc.st}) — review/re-approve on the dashboard, then retry.`), 3);
  let snapText = null;
  try { snapText = fs.readFileSync(require("./contract-lib.js").constraintTurnFileFor(ws, ctx.turnAnchor), "utf8"); } catch { snapText = null; }
  const sha1p = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
  if (snapText === null || sha1p(snapText) !== ctx.sourceHash) die(tB("⚠️ 턴 스냅샷 판독 실패/불일치 — 새 프롬프트를 한 번 보내 턴을 다시 기록한 뒤 재시도하세요.", "⚠️ Turn snapshot unreadable/mismatched — send one new prompt to re-record the turn, then retry."), 3);
  const scope = selectorScopeMaterial(target);
  if (scope.st !== "ok") die(tB(`⚠️ 변경물 꾸러미 판독 실패(${scope.reason}) — 저장소 상태를 확인한 뒤 재시도하세요(빈 재료로 선별하지 않습니다).`, `⚠️ Changed-files bundle unreadable (${scope.reason}) — check the repository state and retry (no selection on empty material).`), 3);
  const SRp = require(path.join(__dirname, "selector-runner.js"));
  const fakePage = process.env.CODEX_BRIDGE_SELECTOR_RUNNER ? require(process.env.CODEX_BRIDGE_SELECTOR_RUNNER).runSelectorPage : undefined; // 격리 테스트용(worker와 같은 주입점)
  const CLx = require("./contract-lib.js");
  const items = arc.data.alwaysBlocker;
  const pages = CLx.buildSelectorPages(items);
  const arm = ctx.provider === "codex" ? "codex" : "self";
  const t0 = Date.now();
  process.stderr.write(tB(`[서고 선별 미리보기] 보관 수칙 ${items.length}항 · 페이지 ${pages.length}장 — 독립 세션이 이번 작업 관련분을 고릅니다(수 분 걸릴 수 있음)...\n`, `[archive preview] ${items.length} item(s) · ${pages.length} page(s) — an independent session is selecting (may take minutes)...\n`));
  const run = await SRp.runSelectorPages({
    arm, pages,
    buildPrompt: (pg) => CLx.buildSelectorPagePrompt({ snapshotText: snapText, changedFiles: scope.files, diffText: scope.diffText, pageItems: pg }),
    timeoutMs: CLx.SELECTOR_PAGE_TIMEOUT_MS, parallel: CLx.SELECTOR_PARALLEL,
    deadlineAt: t0 + selectorDeadlineMsFor(pages.length),
    ...(fakePage ? { pageRunner: fakePage } : {}),
  });
  if (run.st !== "ok") die(tB(`⚠️ 선별 실패(${run.st}${run.msg ? ": " + run.msg : ""}) — 재시도하거나 서고 상태를 확인하세요.`, `⚠️ Selection failed (${run.st}${run.msg ? ": " + run.msg : ""}) — retry or inspect the archive.`), 3);
  const idLists = [];
  for (const it of run.results) {
    if (!it || !it.r || !it.r.ok) die(tB("⚠️ 선별 페이지 결과 불완전 — 재시도하세요(부분 선별로 진행하지 않습니다).", "⚠️ Incomplete page results — retry (no partial selection)."), 3);
    const parsed = CLx.parseSelectorPageOutput(it.r.output, it.ids);
    if (!parsed.ok) die(tB(`⚠️ 선별 출력 형식 위반(${parsed.reason}) — 재시도하세요.`, `⚠️ Selector output rejected (${parsed.reason}) — retry.`), 3);
    idLists.push(parsed.ids);
  }
  const un = CLx.selectorUnion(idLists, items);
  if (!un.ok) die(tB(`⚠️ 선별 합집합 상한 초과(${un.reason}) — 서고 정리(빼기·병합) 후 재시도하세요(절단·요약 없음).`, `⚠️ Selection union over cap (${un.reason}) — organize the archive and retry (no truncation).`), 3);
  const selectedIds = un.selected.map((s) => s.id);
  // 영수증(read-back 관문) — purpose:"preview"가 게이트·ask-start 조건의 자격 표식
  const rec = { ts: new Date().toISOString(), wsKey: CLx.wsKeyFor(ws), askId: "", purpose: "preview", turnAnchor: ctx.turnAnchor, archiveHash: arc.sha1, scopePackageHash: scope.hash, snapshotHash: ctx.sourceHash, itemCount: items.length, pages: pages.length, selectedIds, arm, durationMs: Date.now() - t0 }; // turnAnchor=턴 결속(1차 blocker① — 재사용 차단 4중 결속의 한 축)
  const fname = CLx.appendSelectorUsage(rec);
  let back = null;
  try { back = fname ? JSON.parse(fs.readFileSync(path.join(CLx.SELECTOR_USAGE_DIR, fname), "utf8")) : null; } catch { back = null; }
  if (!back || JSON.stringify(back) !== JSON.stringify(rec)) die(tB("⚠️ 미리보기 영수증 기록 실패 — 재시도하세요(영수증 없이는 게이트가 열리지 않습니다).", "⚠️ Failed to record the preview receipt — retry (the gate stays closed without it)."), 3);
  const L = [en ? "[Selected archive rules for this task (reference — not a verdict authority)]" : "[이번 작업 선별 수칙(참고 — 판정 권위 없음)]"];
  un.selected.forEach((s) => L.push("> " + s.id + ": " + s.text));
  if (!un.selected.length) L.push(en ? "(no archived rule selected for this task)" : "(이번 작업 관련 선별 0건)");
  L.push(en ? `receipt: ${fname} · verification runs its own fresh selection` : `영수증: ${fname} · 검증 판은 별도 fresh 선별로 돕니다`);
  process.stdout.write(L.join("\n") + "\n");
}
function cmdAskStart(rest) {
  const req = askRequest(rest);
  if (!req.prompt) die('사용법: ask-start [--allow-new] "<프롬프트>"', 2);
  warnAskShape(req.prompt, "ask-start"); // 주입 구조화 3단계 — 요청문 뼈대 검사(경고 단계·관측 기록, 기준=코드 소유 구조 데이터)
  requireLinksWritable(); // P-1: 손상 links 상태에서 worker를 만들면 연결·기록이 반복 실패 — 시작 전 중단
  const ws = configWs();
  { // [P7 ⓑ 2026-09-01] 이 대화의 폴더가 세션 도중 바뀐 기록(앵커 folderChange)이 있으면 시작하지 않는다 — 명시 플래그로만 진행(그때 기록 해제).
    // C-C는 구현자 세션 앵커가 폴더를 정하므로(cwd 변화 무관) 대상 아님. 앵커·세션 부재=다른 관문이 처리.
    const lang0 = loadLang();
    if (loadContract(ws, lang0).harnessMode !== "codex-codex") {
      const fc0 = claudeAnchorFolderChange();
      if (fc0) {
        if (!rest.includes("--folder-changed-ok")) die(folderChangeRefusal(fc0, lang0), 3);
        const cl0 = clearClaudeFolderChange();
        if (!cl0.ok) die(tB(`⚠️ 폴더 변경 기록을 해제하지 못했습니다(${cl0.reason}) — 검증을 시작하지 않았습니다.`, `⚠️ Could not clear the folder-change record (${cl0.reason}) — verification was not started.`), 3);
        process.stderr.write(tB(`[앵커] 폴더 변경(${fc0.from} → ${fc0.to})을 확인하고 진행합니다 — 기록 해제.\n`, `[anchor] folder change (${fc0.from} → ${fc0.to}) acknowledged — record cleared.\n`));
      }
    }
  }
  { // §7 승인 전이 상호배제: 도장 전이(원본↔계약 두 저장소 교체)의 순간 불일치 창에 '경계 없는 검증'이
    // 시작되는 것 차단 — 산 잠금=짧은 재시도(전이는 수 초 규모) 후 정직 오류·WAL 잔존=복구 안내(위장 금지).
    let st9 = envelopeTransState(ws);
    for (let i9 = 0; i9 < 5 && st9 === "busy"; i9++) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } catch { /* 대기 실패=즉시 재검사 */ } st9 = envelopeTransState(ws); }
    if (st9 === "busy") die(tB("수칙서 승인 전이가 진행 중입니다 — 잠시 후 다시 시작하세요(경계 없는 검증 시작 차단).", "A rulebook approval transition is in progress — retry shortly (starting a boundary-less verification is blocked)."), 3);
    if (st9 === "recover-needed") die(tB("수칙서 승인 전이가 중단된 흔적(WAL)이 있습니다 — 대시보드를 열거나 envelope-transition recover를 실행해 복구한 뒤 시작하세요.", "An interrupted rulebook approval transition (WAL) exists — open the dashboard or run envelope-transition recover, then start."), 3);
  }
  if (!fs.existsSync(ASK_JOB_WORKER)) die(tB("ask job worker가 없습니다. node install.js로 런타임을 다시 동기화하세요.", "Ask job worker is missing. Re-sync the runtime with node install.js."));
  let id,timeoutMin,job,file;
  // read-active/read-job/create-queued를 한 임계구역으로 묶는다. 동시 ask-start 둘이 모두 '없음'을 보고
  // 서로 다른 worker를 만드는 검사-쓰기 경합을 원천 차단한다.
  try { withAskJobLock(ws,()=>{
    const active=readAskActive(ws);
    if(active)throw Object.assign(new Error(tB("⚠️ 이미 검증이 진행 중이거나 확인 대기 중입니다. 새 작업을 만들지 않았습니다. ask-active status로 확인하세요.","⚠️ A verification is already running or awaiting review. No new job was created. Check ask-active status.")),{exitCode:3});
    const old=activeAskJob(ws);
    if(old)throw Object.assign(new Error(tB(`⚠️ 기존 검증 작업(${old.id})이 ${old.state} 상태입니다. 새 작업을 만들지 않았습니다. ask-wait ${old.id} 로 이어서 기다리세요.`,`⚠️ Verification job ${old.id} is ${old.state}. No new job was created. Continue with ask-wait ${old.id}.`)),{exitCode:3});
    // P-4 fail-closed: 손상 job 파일이 있으면 '활성 없음'으로 축소하지 않고 신규 생성을 차단(중복 worker 방지).
    // 손상 파일의 workspace를 읽을 수 없어 보수적으로 전체 차단 — 확인 후 ask-job clear <id> --confirm 또는
    // 파일 정리로 해소(7일 경과분은 하루 1회 정리가 자동 삭제).
    const corrupt=corruptAskJobFiles();
    if(corrupt.length)throw Object.assign(new Error(tB(`⚠️ 판독 불가(손상) 검증 작업 파일이 있어 새 작업을 만들지 않았습니다: ${corrupt.join(", ")}. 실행 중 작업일 수 있으니 내용 확인 후 ask-job clear <id> --confirm 으로 정리하고 재시도하세요.`,`⚠️ Unreadable (corrupt) verification job file(s) exist; no new job was created: ${corrupt.join(", ")}. They may belong to a running job — inspect, then clean with ask-job clear <id> --confirm and retry.`)),{exitCode:3});
    // P-6(설계 v5.1): C-C면 구현 컨텍스트를 job에 불변 동결. 잠금 순서 고정 ask-job → role(유일한 중첩 지점 —
    // 기존 role lock 사용처는 전부 단독 획득이라 역순 데드락 없음, Codex 전수 확인). 부재·중간 상태는 fail-closed.
    const askLangSnap=loadLang(); // P-12: 언어 먼저 캡처 → 같은 슬롯 계약(프로필·언어 단일 스냅샷)
    const cSnap=loadContract(ws, askLangSnap);
    let frozen={implementerSession:null,implementerTurnId:null,implementerRevision:null};
    if(cSnap.harnessMode==="codex-codex"){
      const fr=freezeImplementerContext(ws);
      if(!fr.ok)throw Object.assign(new Error(tB(`⚠️ 구현 컨텍스트 동결 실패(${fr.reason}) — 검증 작업을 만들지 않았습니다. 구현 Codex 대화에서 새 프롬프트를 한 번 보내 역할·턴을 다시 고정한 뒤 재시도하세요.`,`⚠️ Failed to freeze the implementer context (${fr.reason}) — no verification job was created. Send one new prompt in the implementer Codex conversation to re-pin the role/turn, then retry.`)),{exitCode:3});
      frozen={implementerSession:fr.implementerSession,implementerTurnId:fr.implementerTurnId,implementerRevision:fr.implementerRevision};
      // 같은 턴의 '성공했지만 아직 회수 안 된' job이 있으면 새 job이 세션 단일 proof 슬롯을 덮어 첫 job의
      // 영수증 발급이 영구 불가가 된다(구현 검증 1차 지적 4) — 회수를 먼저 강제. 다른 턴의 미회수 job은
      // 어차피 게이트에서 거부되므로 새 시작을 막지 않는다.
      const pendingId=unretrievedSameTurnJob(ws,frozen);
      if(pendingId)throw Object.assign(new Error(tB(`⚠️ 회수 대기 중인 성공 검증(${pendingId})이 있습니다. 새 작업을 만들지 않았습니다 — 먼저 ask-wait ${pendingId} 로 회수하세요.`,`⚠️ A succeeded verification (${pendingId}) is awaiting retrieval. No new job was created — retrieve it first with ask-wait ${pendingId}.`)),{exitCode:3});
    }
    // P-12 2b(⑵): campaignId는 job '생성 시점'에 완성해 동결 — child가 예약 시점에 앵커를 재판독하면
    // queued~예약 사이 새 사용자 발화가 이전 턴 검증을 새 캠페인 예산으로 오귀속한다. C-C=구현자 세션·턴 앵커
    // (위 frozen — 이미 이 임계구역에서 확정), CL-C=세션별 active 앵커(claudeCampaignAnchor — 전역 active
    // 단독 판독 금지). 앵커 실패=null 동결(예약 시점에 미집계로 가시화·job 생성은 막지 않음).
    let campaignId=null;
    if(cSnap.harnessMode==="codex-codex")campaignId="cc:"+frozen.implementerSession+":"+frozen.implementerTurnId;
    else{const an=claudeCampaignAnchor();if(an.ok)campaignId=an.campaignId;}
    // [약속 발화 포착 부품 B §2] 턴 원문 결속을 job에 불변 동결 — 답 후처리의 [제약 후보 v1] 대조 권위는
    // 이 스냅샷 지문뿐(완료 시점 active 재판독=다른 턴 원문 오결속 위험이라 금지). 부재=null(직접 ask와 동일 취급).
    let constraintCtx=null;
    try{const cc9=constraintTurnContext();if(cc9.ok)constraintCtx={provider:cc9.provider,sessionId:cc9.sessionId,turnAnchor:cc9.turnAnchor,sourceHash:cc9.sourceHash,repoKey:cc9.repoKey||null};}catch{constraintCtx=null;} // [ab-1] repoKey=훅이 원문 스냅숏 시점에 기록한 값만(ask-start 시점 재계산 금지 — 스냅숏~ask 사이 대상 전환 경합)
    // [Envelope Selector v7 §3 — 3b] 승인 서고 활성 게이트: 소실≠미도입(지문 있는데 파일 부재/불일치=중단)·
    // 스냅샷 부재=시작 중단('구현 대화에서 새 프롬프트 1회' 기존 관용구)·선별 계획(팔·페이지·예산)을 job에
    // 동결. 팔=구현 턴 provider 고정(constraintCtx.provider 외 다른 출처 인자 없음 — 교차 불가 소스 계약).
    // 미도입(archiveHash null)=selector 미기록·deadline 산식 무변(완전 무회귀).
    // [경계 통일 2026-08-29] 1층(항상 적용 수칙)도 2층과 같은 태도: 승인 없이 파일이 바뀌면 검증을 시작하지 않는다
    // (종전=수칙만 빼고 조용히 진행+경고 — 사용자가 눈치채기 어려움). 해소=대시보드 카드 "승인 없이 바뀐 내용 보기"에서 승인/복구.
    if(typeof cSnap.envelopeHash==="string"&&cSnap.envelopeHash){
      const core0=readVerifyEnvelope(resolveScoutRepo(ws,cSnap).repo);
      if(core0.st!=="ok"||core0.sha1!==cSnap.envelopeHash)throw Object.assign(new Error(tB(`⚠️ 항상 적용되는 수칙 파일이 승인 없이 바뀌어(${core0.st==="ok"?"내용 불일치":core0.st}) 검증을 시작하지 않았습니다 — 대시보드 수칙 카드의 '승인 없이 바뀐 내용 보기'에서 승인하거나 마지막 승인 목록으로 복구한 뒤 다시 시도하세요.`,`⚠️ The always-applied rules file changed without approval (${core0.st==="ok"?"content mismatch":core0.st}) — no verification was started. Open 'View unapproved changes' on the Rules card to approve or restore, then retry.`)),{exitCode:3});
    }
    let selector=null,selBudgetMs=0;
    if(typeof cSnap.archiveHash==="string"&&cSnap.archiveHash){
      const selTarget=resolveScoutRepo(ws,cSnap).repo;
      const arc0=readVerifyEnvelopeArchive(selTarget);
      if(arc0.st!=="ok"||arc0.sha1!==cSnap.archiveHash)throw Object.assign(new Error(tB(`⚠️ 승인 서고가 도장 시점과 다릅니다(${arc0.st==="ok"?"내용 불일치":arc0.st}) — 검증을 시작하지 않았습니다. 대시보드에서 서고를 확인·재승인한 뒤 재시도하세요.`,`⚠️ The approved archive differs from its stamped state (${arc0.st==="ok"?"content mismatch":arc0.st}) — no verification was started. Review/re-approve the archive on the dashboard, then retry.`)),{exitCode:3});
      if(!constraintCtx)throw Object.assign(new Error(tB("⚠️ 승인 서고 활성 프로젝트인데 이번 턴의 사용자 원문 스냅샷이 없어 선별을 시작할 수 없습니다 — 검증을 시작하지 않았습니다. 구현 대화에서 새 프롬프트를 한 번 보내 턴을 다시 기록한 뒤 재시도하세요.","⚠️ The approved archive is active but this turn has no user-prompt snapshot, so selection cannot start — no verification was started. Send one new prompt in the implementer conversation to re-record the turn, then retry.")),{exitCode:3});
      // [4b §4-②] 구현자 인지 선행 조건: 이 턴 스냅샷+현행 서고에 결속된 preview 영수증이 있어야 시작 —
      // 구현하는 쪽이 '이번 작업 선별 수칙'을 못 본 채 검증만 도는 경로 차단(이중 배달의 ask-start 측 관문).
      // 4중 결속(1차 blocker①): 프로젝트(wsKey)+턴(turnAnchor)+원문(snapshotHash)+서고(archiveHash) —
      // 같은 서고·같은 문구의 타 프로젝트/과거 턴 영수증이 이 관문을 열지 못한다.
      let pv0=false;
      try{const wk0=require("./contract-lib.js").wsKeyFor(ws);pv0=readSelectorUsage().some((r0)=>r0&&r0.purpose==="preview"&&r0.wsKey===wk0&&r0.turnAnchor===constraintCtx.turnAnchor&&r0.snapshotHash===constraintCtx.sourceHash&&r0.archiveHash===arc0.sha1);}catch{pv0=false;}
      if(!pv0)throw Object.assign(new Error(tB(`⚠️ 이번 턴의 선별 미리보기 영수증이 없습니다 — 구현 측 인지 채널이 비어 있어 검증을 시작하지 않았습니다. 먼저 실행하세요: node "${__filename}" selector-preview`,`⚠️ No preview receipt for this turn — the implementer-awareness channel is empty, so no verification was started. Run first: node "${__filename}" selector-preview`)),{exitCode:3});
      const pages0=Math.ceil(arc0.data.alwaysBlocker.length/SELECTOR_PAGE_ITEMS);
      selector={archiveHash:arc0.sha1,itemCount:arc0.data.alwaysBlocker.length,pages:pages0,arm:constraintCtx.provider==="codex"?"codex":"self"};
      selBudgetMs=selectorDeadlineMsFor(pages0);
    }
    id="ask-"+Date.now().toString(36)+"-"+crypto.randomBytes(5).toString("hex");timeoutMin=verifyTimeoutMin();const now=Date.now();
    // 주입 구조화 2단계: 재판단 규약을 '판정이 도착하는 자리'로 옮기면서, 같은 ask가 시작할 때 확정한 문안을
    // 완료 처리에도 쓰도록 원문을 여기서 동결한다. 동결하지 않고 완료 시점에 파일을 다시 읽으면 검증이 도는
    // 동안 다른 창이 문안을 저장했을 때 시작과 도착이 다른 세대가 된다(검증 지적 반영).
    // 프로필·언어와 '같은 스냅샷'에서 뽑는다 — 교차 슬롯 결합 차단(위 askLangSnap 계약과 동일 원리).
    const askProfileSnap=effectiveVerifyProfile(cSnap);
    const askProviderSnap=normVerifierProvider(cSnap); // [VerifierProvider §1] 같은 임계구역·같은 계약 스냅샷에서 동결(재확인 blocker①)
    // 원문을 그대로 동결한다(정규화는 footer 한 곳에서만) — 첨부가 거부된 경우에도 '무엇이 있었는지'를 알아야
    // 조용한 누락 대신 사유를 밝힐 수 있다. 파일 비대는 상한+1자 절단으로 막는다(길이 초과 판정에는 충분).
    const rejudgeSnap=safeLoadRejudge(askLangSnap,askProfileSnap).trim().slice(0,REJUDGE_SNAP_MAX+1);
    // [3b] deadline=두 예산의 합(선별 예산+검증 예산 — 선별이 검증 몫을 잠식하지 않음). verifierDeadlineAt은
    // selecting→running 전이 시점에 worker가 절대 시각으로 확정(생성 시점 단일 deadline 전달 방식의 교체).
    job={schema:"ask-job-v1",id,state:"queued",workspace:ws,execCwd:process.cwd(),flags:req.flags,prompt:req.prompt,timeoutMin,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+selBudgetMs+timeoutMin*60*1000).toISOString(),selector,selectorDeadlineAt:selector?new Date(now+selBudgetMs).toISOString():null,verifierDeadlineAt:null,workerPid:null,childPid:null,exitCode:null,harnessMode:cSnap.harnessMode,verifyProfile:askProfileSnap,verifyLang:askLangSnap,verifyProvider:askProviderSnap,rejudgeSnap,campaignId,constraintCtx,implementerSession:frozen.implementerSession,implementerTurnId:frozen.implementerTurnId,implementerRevision:frozen.implementerRevision};
    file=askJobFile(id);
    if(!atomicWrite(file,JSON.stringify(job)))throw new Error(tB("검증 작업 저장 실패 — 새 검증을 시작하지 않았습니다.","Failed to save the verification job — no verification was started."));
  }); } catch(e) { die(String(e&&e.message||e),Number(e&&e.exitCode)||1); }
  try {
    const child = spawn(process.execPath, [ASK_JOB_WORKER, file], {
      cwd: process.cwd(), env: Object.assign({}, process.env, { CODEX_BRIDGE_VERIFY_TIMEOUT_MIN: String(timeoutMin) }),
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    atomicWrite(askJobPidFile(id),String(child.pid)); // job JSON과 분리: worker의 running patch와 덮어쓰기 경합 없음
    // worker가 자기 pid와 running 상태를 기록한다. 부모가 오래된 queued 스냅샷으로 되덮지 않는다.
  } catch (e) {
    atomicWrite(file, JSON.stringify(Object.assign({}, job, { state: "failed", finishedAt: new Date().toISOString(), error: String(e && e.message || e) })));
    die(tB("검증 작업 worker 시작 실패: ", "Failed to start verification worker: ") + String(e && e.message || e));
  }
  process.stdout.write(JSON.stringify({ jobId: id, state: "queued", workspace: ws, verifyTimeoutMin: timeoutMin, deadlineAt: job.deadlineAt, next: `node "${__filename}" ask-wait ${id}` }, null, 2) + "\n");
}

function cmdAskWait(rest) {
  const id = rest[0] || "";
  let j = readAskJob(id);
  if (!j) die(tB("검증 작업을 찾을 수 없습니다: ", "Verification job not found: ") + id, 2);
  const sliceEnv = Number(process.env.CODEX_BRIDGE_JOB_WAIT_SLICE_MS);
  const sliceMs = Number.isFinite(sliceEnv) && sliceEnv >= 0 ? Math.min(sliceEnv, 55000) : 45000;
  const until = Date.now() + sliceMs;
  while (["queued", "selecting", "running"].includes(j.state) && Date.now() < until) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } catch { /* 즉시 재조회 */ }
    j = readAskJob(id) || j;
  }
  if (["succeeded", "failed"].includes(j.state)) {
    // P-6(설계 v5.1): C-C 내구 job의 성공 회수는 '영수증 기록·read-back 성공 후에만' 출력을 반환한다.
    // 영수증의 모든 필드는 job/proof 복사값·ts=job.finishedAt(결정론) — 동시 회수도 같은 바이트로 수렴하고,
    // 기록 실패면 출력을 반환하지 않고 비0 종료(멱등 재시도 유도). failed job은 영수증 없이 기존대로 출력만.
    if (j.state === "succeeded" && j.harnessMode === "codex-codex") {
      if (j.id !== id) die(tB(`⚠️ 작업 파일과 job id가 어긋납니다(${j.id} ≠ ${id}). 손상된 작업 — 새 검증을 시작하세요.`, `⚠️ Job file and id mismatch (${j.id} ≠ ${id}). Corrupt job — start a new verification.`), 4);
      const rc = writeRecoveryReceipt(j);
      if (!rc.ok) die(tB(`⚠️ 회수 영수증 기록 실패(${rc.reason}) — 검증 출력은 반환하지 않았습니다. 같은 명령(ask-wait ${id})으로 재시도하고, 반복 실패면 구현 대화의 현재 턴에서 새 검증을 시작하세요.`, `⚠️ Failed to record the recovery receipt (${rc.reason}) — verification output was not returned. Retry the same command (ask-wait ${id}); if it keeps failing, start a new verification from the implementer conversation's current turn.`), 4);
    }
    const outFile = path.join(ASK_JOBS_DIR, id + ".out");
    const errFile = path.join(ASK_JOBS_DIR, id + ".err");
    let out = "", err = "";
    try { out = fs.readFileSync(outFile, "utf8"); } catch { /* 빈 출력 */ }
    try { err = fs.readFileSync(errFile, "utf8"); } catch { /* 빈 오류 */ }
    if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    if (err) process.stderr.write(err.endsWith("\n") ? err : err + "\n");
    // [4a §4 라운드 2+] 선별 요약 1줄(worker 선별 결과 기반) — 수정 루프의 구현자가 이번 판에 어떤 보관
    // 수칙이 실렸는지 본다. stderr로만(기계 출력 오염 금지).
    if (j.state === "succeeded" && j.selection && typeof j.selection === "object" && Array.isArray(j.selection.selectedIds)) {
      try { const s9 = j.selection; process.stderr.write(tB(`[서고 선별] 이번 판 보관 수칙 ${s9.selectedIds.length}건 동봉(서고 ${Number(s9.itemCount) || 0}항 중)${s9.selectedIds.length ? " — " + s9.selectedIds.join(", ") : ""}\n`, `[archive selection] ${s9.selectedIds.length} stored rule(s) attached (of ${Number(s9.itemCount) || 0} archived)${s9.selectedIds.length ? " — " + s9.selectedIds.join(", ") : ""}\n`)); } catch { /* 요약 실패=회수 방해 금지 */ }
    }
    // [회수 시점 재투영 2026-08-06 — 실전 재현 봉합] worker가 재확인을 resolved로 기록한 직후 종료·ack
    // 실패하면 경보가 '회신을 받았는데도' 열려 남는다(다음 검증 진입까지 — 세션 마지막 검증이면 무기한).
    // 회수(ask-wait)는 반드시 그 뒤에 오므로 여기서 멱등 재투영 — 사용자 화면 기준 '답 회수=경보 정리'.
    try { const echW = require("./evidence-challenge.js"); const wsW = j.workspace || configWs(); echW.convergeStaleChallenges(wsW); projectResolvedAcks(wsW, echW); } catch { /* best-effort — 다음 검증의 정비가 최후 방어선 */ }
    if (j.state === "failed") process.exit(Number.isInteger(j.exitCode) && j.exitCode !== 0 ? j.exitCode : 1);
    return;
  }
  const deadline = Date.parse(j.deadlineAt || "");
  let spawnPid=0;try{spawnPid=parseInt(fs.readFileSync(askJobPidFile(id),"utf8"),10)||0;}catch{/* worker patch 전/옛 job */}
  const effectivePid=j.workerPid||spawnPid,alive=pidAlive(effectivePid),remaining=Number.isFinite(deadline)?Math.max(0,deadline-Date.now()):null;
  if((effectivePid&&!alive)||remaining===0){j={...j,state:"failed",workerPid:j.workerPid||spawnPid||null,exitCode:1,error:remaining===0?"verification deadline elapsed":"durable worker exited before recording a final state",finishedAt:new Date().toISOString()};atomicWrite(askJobFile(id),JSON.stringify(j));die(remaining===0?tB("검증 작업이 저장된 절대 deadline을 넘겨 실패했습니다.","The verification job exceeded its stored absolute deadline."):tB("검증 worker가 최종 상태 없이 종료됐습니다. 같은 작업을 재전송하지 말고 job/rollout을 확인하세요.","The verification worker exited without a final state. Do not resend; inspect the job/rollout."));}
  process.stdout.write(JSON.stringify({ jobId: id, state: j.state, workerAlive: alive, childPid: j.childPid || null, verifyTimeoutMin: j.timeoutMin, remainingMs: remaining, ...(j.selector ? { selectorDeadlineAt: j.selectorDeadlineAt || null, verifierDeadlineAt: j.verifierDeadlineAt || null } : {}), next: `node "${__filename}" ask-wait ${id}` }, null, 2) + "\n"); // [3b] 선별 판=두 예산 구분 표시(선별/검증 절대 시각)
}

// P-12 2a — 검증 백로그 장부 CLI(설계 동결 ⓚ): add/list/done/dismiss/clear. 프로젝트별·로컬 전용.
// §7 증분 2 — 제안본 CLI: propose=초안 파일(수칙서 전문 JSON)을 검증해 하네스 로컬 제안본으로 저장(원본·주입 무변) /
// show=현 제안본 표시 / discard=폐기(철회=원상 복귀 그 자체 — 원본은 애초에 무변). 승인은 대시보드 도장 전용.
function cmdEnvelopeProposal(rest) {
  const en = loadLang() === "en";
  const ws = configWs();
  const repo = resolveScoutRepo(ws, loadContract(ws)).repo;
  const sub = rest[0];
  if (sub === "propose") {
    const fi = rest.indexOf("--file");
    const fp = fi >= 0 ? rest[fi + 1] : null;
    if (!fp) { console.error(en ? "usage: envelope-proposal propose --file <draft.json> [--note ...]" : "사용: envelope-proposal propose --file <초안.json> [--note ...]"); return 2; }
    let txt; try { txt = fs.readFileSync(fp, "utf8"); } catch { console.error(en ? "cannot read draft file" : "초안 파일을 읽을 수 없음"); return 2; }
    const ni = rest.indexOf("--note");
    // R3(f-cbaf266d 잔여): 수동 propose도 전이 잠금 아래 — draft의 'proposal 쓰기→adopted 기록' 임계구역
    // 안으로 끼어들어 결속 proposal을 무결속 M으로 교체하는 우회 봉합(모든 proposal writer=한 잠금).
    const lkP = acquireEnvelopeTransLock(ws);
    if (!lkP.ok) { console.error(en ? "rulebook busy (another draft/discard/stamp in progress) — retry shortly" : "수칙서 작업 잠금 경합(다른 초안/폐기/도장 진행 중) — 잠시 후 재시도"); return 3; }
    let r;
    try { r = writeEnvelopeProposal(ws, repo, txt, ni >= 0 ? rest.slice(ni + 1).join(" ") : ""); }
    finally { releaseEnvelopeTransLock(ws, lkP.token); }
    if (!r.ok) { console.error((en ? "proposal rejected: " : "제안본 거부: ") + r.error); return 2; }
    console.log((en ? "proposal saved (original & injection unchanged until the dashboard stamp): " : "제안본 저장됨(대시보드 도장 전까지 원본·주입 무변): ") + r.newHash);
    return 0;
  }
  if (sub === "show") {
    const pr = readEnvelopeProposal(ws, repo);
    if (pr.st === "absent") { console.log(en ? "(no proposal)" : "(제안본 없음)"); return 0; }
    if (pr.st !== "ok") { console.error(en ? "proposal file is corrupt (will not be shown for approval)" : "제안본 파일 손상(승인 화면에 표시되지 않음)"); return 1; }
    console.log((en ? "# proposal " : "# 제안본 ") + pr.newHash + (pr.note ? " — " + pr.note : "") + "\n" + pr.proposalText);
    return 0;
  }
  if (sub === "discard") {
    const rD = require("./contract-lib.js").discardEnvelopeProposalRestoring(ws); // 복원형(2026-08-21) — 채택 후보를 판단 대기로 되돌림
    if (!rD.ok) { // R4 [주의]: 잠금 경합·삭제 실패를 성공으로 출력하던 거짓 보고 봉합
      console.error(rD.reason === "lock" ? (en ? "rulebook busy (another draft/discard/stamp in progress) — retry shortly" : "수칙서 작업 잠금 경합(다른 초안/폐기/도장 진행 중) — 잠시 후 재시도") : (en ? "discard failed — retry" : "폐기 실패 — 다시 시도"));
      return 3;
    }
    console.log((en ? "proposal discarded (original was never touched)" : "제안본 폐기됨(원본은 애초에 무변)") + (rD.restored ? (en ? " · the adopted candidate was restored to pending" : " · 채택했던 후보는 판단 대기로 복원됨") : ""));
    return 0;
  }
  console.error(en ? "usage: envelope-proposal <propose|show|discard>" : "사용: envelope-proposal <propose|show|discard>");
  return 2;
}
function cmdEnvelopeTransition(rest) {
  const en = loadLang() === "en";
  if (rest[0] !== "recover") { console.error(en ? "usage: envelope-transition recover" : "사용: envelope-transition recover"); return 2; }
  const r = recoverEnvelopeTransition(configWs());
  if (r.st === "none") { console.log(en ? "(no interrupted transition)" : "(중단된 전이 없음)"); return 0; }
  if (r.st === "recovered") { console.log((en ? "transition completed: " : "전이 완료 수렴: ") + r.newHash); return 0; }
  console.error((en ? "recover failed: " : "복구 실패: ") + (r.reason || r.st) + (en ? " (WAL preserved — old & new full texts inside)" : " (WAL 보존 — 구·신 전문이 안에 있음)"));
  return 1;
}
// 거버넌스 §7 증분 1 — 수칙서 후보 장부 CLI: list=현 승인 세대 기준 후보 상태 조회 / mark=결과 기록(append 전용).
// 기록 세대=현 승인 세대(계약 envelopeHash) — 소진 재료의 스킵 판정과 같은 축.
// ── constraint — 약속 발화 포착 부품 A(설계 §1): 구현자가 사용자 발화 원문을 같은 턴에 상신 ────────────
// 사용: constraint add --quote "<사용자 발화 원문 연속 구절>" --why "<한 줄 근거>" [--scope <파일|영역>]
// 대조 권위=훅 턴 스냅샷(작문·재구성 fail-closed). 성공해도 '후보'일 뿐 — 판정 경계 반영은 사용자 도장 후.
function cmdConstraint(rest) {
  const en = loadLang() === "en";
  const ws = configWs();
  if (String(rest[0] || "") !== "add") {
    console.error(en ? 'usage: constraint add --quote "<verbatim user words>" --why "<one-line reason>" [--scope <file|area>]' : '사용: constraint add --quote "<사용자 발화 원문 연속 구절>" --why "<한 줄 근거>" [--scope <파일|영역>]');
    return 2;
  }
  const flagText = (name) => { // 값이 공백 포함 다단 토큰이어도 다음 --플래그 전까지 합류(따옴표 유실 관용)
    const i = rest.indexOf(name);
    if (i < 0) return "";
    const vals = [];
    for (let k = i + 1; k < rest.length && !String(rest[k]).startsWith("--"); k++) vals.push(String(rest[k]));
    return vals.join(" ");
  };
  const quote = flagText("--quote");
  const why = flagText("--why");
  const scope = flagText("--scope");
  const ctx = constraintTurnContext(); // [ab-1] repoKey=훅이 원문 스냅숏 시점에 기록한 값(ctx.repoKey) — 여기서 재계산하지 않는다
  const r = constraintAdd(ws, quote, why, scope, ctx);
  if (r.ok) {
    console.log((en ? "registered as a rulebook candidate: " : "수칙서 후보로 상신됨: ") + r.candidateId + (en
      ? " — recorded in the candidate ledger; it becomes judging authority ONLY after the user stamps it."
      : " — 후보 장부에 기록됐습니다. 사용자가 도장을 찍어야만 판정 경계에 반영됩니다."));
    return 0;
  }
  const M = {
    "no-session": [en ? "no implementer session detected (CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID missing)." : "구현자 세션을 찾지 못했습니다(CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID 부재).", 2],
    "no-turn-anchor": [en ? "no turn anchor — send this in the same turn as the user's words (hook records the anchor at turn start)." : "턴 앵커가 없습니다 — 사용자 발화가 있던 '같은 턴'에서 상신하세요(훅이 턴 시작에 앵커를 기록합니다).", 2],
    "snapshot-missing": [en ? "no prompt snapshot for this turn — the hook could not capture the user's words (old hook or empty prompt). Cannot verify verbatim quoting; not registered." : "이 턴의 원문 스냅샷이 없습니다 — 훅이 사용자 발화를 못 남긴 턴(구훅·빈 프롬프트)이라 원문 대조가 불가능해 상신하지 않았습니다.", 1],
    "snapshot-mismatch": [en ? "snapshot fingerprint mismatch — the turn record and snapshot disagree; not registered (fail-closed)." : "스냅샷 지문 불일치 — 턴 기록과 스냅샷이 어긋나 상신하지 않았습니다(fail-closed).", 1],
    "not-in-prompt": [en ? "the quote is not a verbatim contiguous passage of this turn's user prompt — copy the user's words exactly (no paraphrase)." : "인용문이 이 턴 사용자 발화의 '연속 구절'이 아닙니다 — 바꿔 쓰지 말고 원문 그대로 옮기세요.", 1],
    "too-short": [en ? `quote too short (min ${CONSTRAINT_QUOTE_MIN} chars).` : `인용문이 너무 짧습니다(최소 ${CONSTRAINT_QUOTE_MIN}자).`, 1],
    "too-long": [en ? `quote over ${CONSTRAINT_QUOTE_MAX} chars — a rulebook item cannot exceed this; ask the user to restate it shorter, then resubmit (no truncated save).` : `인용문이 ${CONSTRAINT_QUOTE_MAX}자를 넘습니다 — 수칙서 항목 상한이라 승격 자체가 불가하니, 줄인 문장으로 다시 말씀받아 재상신하세요(절단 저장은 하지 않습니다).`, 1],
    "multiline": [en ? "quote spans multiple lines — a rulebook item is one line; pick the single decisive sentence." : "인용문에 줄바꿈이 있습니다 — 수칙서 항목은 1줄 계약이라, 핵심이 담긴 한 문장을 고르세요.", 1],
    "protocol-vocab": [en ? "quote contains harness protocol markers — rejected (injection guard)." : "인용문에 하네스 규약 어휘가 들어 있어 거부했습니다(주입 방어).", 1],
    "why-missing": [en ? "--why is required (one-line non-authoritative reason)." : "--why는 필수입니다(비권위 판단 근거 한 줄).", 2],
    "why-format": [en ? `--why must be a single line within ${CONSTRAINT_WHY_MAX} chars.` : `--why는 개행 없는 ${CONSTRAINT_WHY_MAX}자 이내 한 줄이어야 합니다.`, 2],
    "envelope-inactive": [en ? "the rulebook is not approved in this workspace yet — approve it first, then candidates can be filed." : "이 작업공간은 수칙서가 아직 승인 전입니다 — 수칙서를 먼저 승인해야 올릴 수 있어요.", 1],
    "duplicate": [en ? "already filed for this approval generation (same quote fingerprint)." : "이미 이 승인 세대에 같은 원문 지문으로 상신돼 있습니다.", 1],
    "declined-suppressed": [en ? "the user already declined this in the current approval generation — not re-filed (a new generation resets this)." : "사용자가 현 승인 세대에서 이미 거절한 문안입니다 — 재상신하지 않습니다(새 승인 세대에서 자연 리셋).", 1],
    "turn-cap": [en ? `per-turn cap reached (${CONSTRAINT_TURN_CAP}).` : `턴당 상신 상한(${CONSTRAINT_TURN_CAP}건)에 도달했습니다.`, 1],
    "pending-cap": [en ? "pending candidate cap reached — ask the user to triage existing candidates first." : "대기 후보 상한에 도달했습니다 — 기존 후보를 먼저 정리(도장/거절)해야 새로 올릴 수 있어요.", 1],
    "ledger-write": [en ? "ledger write failed." : "장부 기록에 실패했습니다.", 1],
  };
  const m = M[r.reason] || (r.reason && r.reason.startsWith("sensitive-") ? [en ? "quote rejected by the sensitive-form guard (paths/emails/tokens) — never quote secrets; pick a different passage." : "인용문이 민감정보 형태 방어(경로·이메일·토큰류)에 걸렸습니다 — 비밀값은 옮기지 말고 다른 구절을 고르세요.", 1]
    : r.reason && r.reason.startsWith("why-sensitive-") ? [en ? "--why rejected by the sensitive-form guard." : "--why가 민감정보 형태 방어에 걸렸습니다.", 2]
    : r.reason && r.reason.startsWith("scope-sensitive-") ? [en ? "--scope rejected by the sensitive-form guard." : "--scope가 민감정보 형태 방어에 걸렸습니다.", 2]
    : [en ? "rejected: " + r.reason : "거부됨: " + r.reason, 1]);
  console.error((en ? "not registered (" : "상신 안 됨(") + r.reason + ") — " + m[0] + (en ? " A durable receipt was recorded either way." : " 성공·거부 모두 내구 영수증으로 남았습니다."));
  return m[1];
}
function cmdEnvelopeCandidate(rest) {
  const en = loadLang() === "en";
  const ws = configWs();
  const sub = rest[0];
  const gen = (() => { try { return loadContract(ws).envelopeHash || null; } catch { return null; } })();
  // [기억 권위 A-3] 조정 트리거 ②후보 조회·③draft 전 — 멱등 스캔(중단 복구: 마지막 판정 후 죽어도 여기서 회수)
  const recon9 = (() => { try { const repo9 = resolveScoutRepo(ws, loadContract(ws)).repo; return reconcileMemoryCandidates(ws, repo9, gen); } catch { return null; } })();
  if (recon9 && (recon9.appended || recon9.suppressed.length || recon9.legacyUnbound)) {
    console.error((en ? "[memory candidates] " : "[기억 후보 조정] ") + `+${recon9.appended}` + (recon9.suppressed.length ? ` · ${en ? "suppressed" : "억제"} ${recon9.suppressed.length}(${recon9.suppressed.map((s) => s.why).join(",")})` : "") + (recon9.legacyUnbound ? ` · legacy-unbound ${recon9.legacyUnbound}` : "")); // 침묵 누락 금지(설계 A-5)
  }
  if (sub === "list") {
    const { latest } = readEnvelopeCandidates(ws);
    const rows = [...latest.entries()].filter(([k]) => k.endsWith("@" + String(gen || "")));
    if (!rows.length) { console.log(en ? "(no candidate records for the current approval generation)" : "(현 승인 세대의 후보 기록 없음)"); return 0; }
    for (const [, r] of rows) console.log(`${r.candidateId} ${r.status} ${r.ts || ""}${r.title ? " — " + String(r.title).slice(0, 80) : r.note ? " — " + r.note : ""}`);
    return 0;
  }
  if (sub === "draft") { // [기억 권위 A-4] 후보 1건 → 현행 수칙서 병합 proposalText 초안(승인은 기존 도장 경로)
    const id = String(rest[1] || "");
    if (!/^[0-9a-f]{16}$/.test(id)) { console.error(en ? "usage: envelope-candidate draft <16hex-id>" : "사용: envelope-candidate draft <16자리 id>"); return 2; }
    const repo = resolveScoutRepo(ws, loadContract(ws)).repo;
    // [재편 B 사실확인 blocker] 코어 전용 draftEnvelopeCandidate 잔존 경로 폐기 — 대시보드 [승인]과 동형(서고행 revision)
    const CLd = require("./contract-lib.js");
    const r = CLd.draftEnvelopeRevision(ws, repo, { addCandidateIds: [id], removeItems: [], approvedHash: gen, target: "archive" });
    if (!r.ok) { console.error((en ? "draft failed: " : "draft 실패: ") + r.error); return 1; }
    console.log((en ? "draft saved (approve via the existing dashboard stamp): " : "제안본 저장됨(승인은 기존 대시보드 도장 경로): ") + r.newHash + (r.parallelCopied ? (en ? " · parallel axes copied — user edit needed" : " · 병렬 축 복제됨 — 사용자 편집 필요") : ""));
    return 0;
  }
  if (sub === "mark") {
    const id = String(rest[1] || "");
    const status = String(rest[2] || "");
    const ni = rest.indexOf("--note");
    const note = ni >= 0 ? rest.slice(ni + 1).join(" ") : "";
    if (!/^[0-9a-f]{16}$/.test(id) || !ENVELOPE_CANDIDATE_STATUSES.includes(status)) {
      console.error(en ? "usage: envelope-candidate mark <16hex-id> <proposed|adopted|declined|failed> [--note ...]" : "사용: envelope-candidate mark <16자리 id> <proposed|adopted|declined|failed> [--note ...]");
      return 2;
    }
    // [재편 B §3-1b · f-3144cbc9] 합성 신호(장부에 없는 조회 시 계산물)는 처분 대상이 아니다 — 참고 표시
    // 전용이라 adopted|declined 기록 경로를 차단(과거처럼 기록만 남기는 장부 개입 소멸). 장부 실존 후보만 mark.
    if (status === "adopted" || status === "declined") {
      // [1차 blocker④ 재봉합] '존재' 검사는 과거 합성 처분 행으로 우회된다 — 판정 기준은 kind: draftable
      // kind가 기록된 장부 후보만 처분 대상(합성·kind 무기록 잔재=거부, 과거 처분 행은 판독 무시라 자연 무효).
      let inLedger9 = false;
      try { for (const r of readEnvelopeCandidates(ws).rows) if (r && r.candidateId === id && ENVELOPE_DRAFTABLE_KINDS.includes(r.kind)) { inLedger9 = true; break; } } catch { inLedger9 = false; }
      if (!inLedger9) {
        console.error(en
          ? "this id is a computed reference signal (not a ledger candidate) — signals take no disposition. To promote a lesson to a rule, use `rule-propose <findingId> --why \"...\"` at campaign closing."
          : "이 id는 조회 시 계산되는 참고 신호라 처분 대상이 아니에요(장부 후보 아님). 지침으로 올리려면 마감 때 `rule-propose <findingId> --why \"...\"`를 쓰세요.");
        return 2;
      }
    }
    // [부품 C §3-3b] draftable kind의 직접 adopted 기록=초안 미결속 고아 생성 경로 — 거부+draft 안내(declined/failed는 허용)
    const g9 = envelopeMarkGuard(ws, id, status);
    if (!g9.ok) {
      console.error(en
        ? "adopted for this candidate (" + g9.kind + ") cannot be recorded via mark — adoption must be bound to a draft: use `envelope-candidate draft " + id + "` or the dashboard 'Mark to add → Build revision draft'. (declined/failed records still use mark.)"
        : "이 후보(" + g9.kind + ")의 채택은 mark로 기록할 수 없어요 — 채택은 초안 생성과 결속돼야 합니다: `envelope-candidate draft " + id + "` 또는 대시보드 '올림 표시 → 개정판 초안 만들기'를 쓰세요(안 올림/실패 기록은 mark 그대로).");
      return 2;
    }
    const okW = appendEnvelopeCandidates(ws, [{ candidateId: id, envelopeHash: gen, status, ts: new Date().toISOString(), ...(note ? { note: note.slice(0, 200) } : {}) }]);
    if (!okW) { console.error(en ? "record failed (ledger write error)" : "기록 실패(장부 쓰기 오류)"); return 1; }
    console.log((en ? "recorded: " : "기록됨: ") + id + " " + status);
    return 0;
  }
  console.error(en ? "usage: envelope-candidate <list|draft|mark ...>" : "사용: envelope-candidate <list|draft|mark ...>");
  return 2;
}
// ── finding-judge — 열린 지적 처분 기록(관문 findingDispositionGate의 해제 수단·2026-08-01) ──────────
// 인자 없음=현황 목록. <id> <choice>=기록. park 외 전 선택=근거 필수(--note 12자+ — 확인 검증 [보완]③으로
// 문구 정정: rebut만이 아니다). park=보관함 자동 등록(영수증 id를 처분에 결속 — 등록 실패면 처분도 기록하지
// 않음). 재처분 허용(마지막 기록 우선). fix-gap 누적=수확 체감 신호 고지(비차단).
// --campaign(확인 검증 blocker② 반영): 관문은 job 동결 캠페인을 보는데 이 명령이 현재 캠페인 파일만
// 읽으면, 미집계 진행처럼 둘이 갈린 상태에서 '관문은 막는데 해제 명령은 열린 지적 없음'인 교착이 된다.
// 관문 거부문이 자기 캠페인 id를 인쇄하고, 여기서 --campaign으로 그 id를 그대로 받는다.
// [재편 A §2-1] rule-propose <findingId> --why "<왜 관통 지침인지 1줄>" [--campaign <id>]
// 헌법: 상신 자격은 성격(관통)이지 이력(고쳐졌음)이 아니다 — 마감 판단(a 그자리한정/b 참고/c 관통)에서
// (c)로 분류한 교훈만 이 명령으로 올린다. 등재 효력은 사용자 도장부터(후보=판정 권위 없음).
// [CURATION v3] curate [run] [--force] [--json] · curate input [--json] · curate status — 팔=계약 유래(selectorArmForCuration)·잠금·영수증·경보는 curation.js
async function cmdCurate(rest) {
  const ws = configWs();
  const en = loadLang() === "en";
  const CU = require("./curation.js");
  const sub = (rest || []).find((a) => !String(a).startsWith("--")) || "run";
  const json = (rest || []).includes("--json");
  const force = (rest || []).includes("--force");
  const c = loadContract(ws);
  const repo = resolveScoutRepo(ws, c).repo;
  if (sub === "input") {
    const inp = CU.curationInput(ws, repo, { computeCandidates: computeEnvelopeCandidatesFor }); // CLI=순환 require라 module.exports가 아직 비어 있음 — 직접 주입(1회차 blocker①)
    if (json) { console.log(JSON.stringify(inp)); if (!inp.ok) process.exitCode = 2; return; }
    if (!inp.ok) { console.log((en ? "curation input unavailable: " : "정리 입력을 만들 수 없습니다: ") + inp.reason); process.exitCode = 2; return; }
    console.log((en ? "[curation input] " : "[정리 입력] ") + `core ${inp.rules.core.length} · archive ${inp.rules.archive.length} · signals ${inp.signalCount} · decisions ${inp.decisions.open.length}/${inp.decisions.answered.length} · key ${CU.curationKeyOf(inp).slice(0, 12)}`);
    const s = inp.signals;
    console.log(`  oos-repeat ${s.oosRepeat.length} · lineage ${s.lineage.length} · escalation ${s.escalation.length} · unused-oos ${s.unusedOos.length} · unused-rule ${s.unusedRules.length} · rebut ${s.rebutUsed.length} · selOver ${s.selOver.count}`);
    return;
  }
  if (sub === "status") {
    const sm = CU.curationSummary(ws);
    if (json) { console.log(JSON.stringify(sm)); return; }
    console.log((en ? "[curation] " : "[정리 제안] ") + (sm.lastTs ? `${en ? "last" : "마지막"} ${sm.lastTs} · ${sm.lastOutcome}${sm.lastReason ? "(" + sm.lastReason + ")" : ""}` : (en ? "never run" : "실행 이력 없음")) + ` · ${en ? "runs" : "실행"} ${sm.runs} · ${en ? "proposed" : "제안"} ${sm.proposedTotal} · ${en ? "pending" : "미승인"} ${sm.pending}/${sm.maxPending}`);
    return;
  }
  console.error(en ? "[curation] reading ledgers and asking the independent curator (may take minutes; verification is not affected)..." : "[정리 제안] 장부를 읽고 독립 정리 담당에게 묻는 중(수 분 걸릴 수 있음 · 검증 무영향)...");
  // [2회차 blocker①] 이 파일은 main() 뒤에 module.exports를 채운다 — Codex 팔의 selector-runner가 require("./codex-bridge.js").resolveCodex()를 조회하므로
  // 모듈 평가가 끝난 다음 틱에 실행한다(순환 초기화 중 빈 export 조회 차단). 시험 주입점=worker와 같은 CODEX_BRIDGE_SELECTOR_RUNNER.
  await new Promise((res) => setImmediate(res));
  let fakeRunner9 = null;
  if (process.env.CODEX_BRIDGE_SELECTOR_RUNNER) { try { fakeRunner9 = require(process.env.CODEX_BRIDGE_SELECTOR_RUNNER).runSelectorPage; } catch { fakeRunner9 = null; } }
  const r = await CU.runCuration(ws, { force, lang: loadLang(), contract: c, computeCandidates: computeEnvelopeCandidatesFor, ...(typeof fakeRunner9 === "function" ? { pageRunner: fakeRunner9 } : {}) });
  if (json) { console.log(JSON.stringify(r)); if (r.st !== "ok" && r.st !== "skipped") process.exitCode = 2; return; }
  if (r.st === "ok") console.log((en ? "[curation] done — proposals " : "[정리 제안] 완료 — 제안 ") + r.proposed + (en ? " (new " : " (신규 ") + r.candidateIds.length + (en ? ") · deferred " : ") · 보류 ") + r.deferred + (en ? " · held toggles " : " · 전환 보류 ") + r.heldToggles + (en ? " · dropped " : " · 탈락 ") + r.dropped + (en ? " · pending " : " · 미승인 ") + r.pending + "/" + CU.CURATION_MAX_PENDING + (en ? " — approve or drop them in the dashboard proposal box." : " — 대시보드 제안함에서 승인하거나 안 올림으로 처리하세요."));
  else if (r.st === "skipped") console.log((en ? "[curation] skipped (" : "[정리 제안] 생략(") + r.reason + (en ? ") — no new signal since the last run; pass --force to ask anyway." : ") — 마지막 실행 이후 새 신호가 없습니다. 그래도 묻게 하려면 --force."));
  else { console.log((en ? "[curation] not run: " : "[정리 제안] 실행되지 않음: ") + r.st + (r.reason ? " (" + r.reason + ")" : "")); process.exitCode = 2; }
}
function cmdRulePropose(rest) {
  const ws = configWs();
  const en = loadLang() === "en";
  const flagVal = (flag) => { const i = rest.indexOf(flag); return i >= 0 && rest[i + 1] !== undefined ? String(rest[i + 1]).trim() : ""; };
  const why = flagVal("--why");
  const camp = flagVal("--campaign") || currentCampaignIdFor(ws);
  const pos = [];
  for (let i = 0; i < rest.length; i++) { const a = String(rest[i] || ""); if (a === "--why" || a === "--campaign") { i++; continue; } pos.push(a.trim()); }
  const findingId = (pos[0] || "").trim();
  if (!findingId) { console.log(en ? "usage: rule-propose <findingId> --why \"<one line>\"" : "사용법: rule-propose <findingId> --why \"<왜 관통 지침인지 1줄>\""); process.exitCode = 2; return; }
  const repo = resolveScoutRepo(ws, loadContract(ws)).repo;
  const CLany = require("./contract-lib.js");
  const r = CLany.ruleProposeCandidate(ws, repo, { findingId, why, campaignId: camp });
  if (!r.ok) {
    const msgs = {
      "finding-missing": ["findingId가 비었습니다", "findingId is empty"],
      "campaign-missing": ["캠페인을 결정하지 못했습니다(--campaign 지정)", "cannot resolve campaign (pass --campaign)"],
      "envelope-inactive": ["승인된 수칙서가 없어(비활성) 상신 대상이 아닙니다", "no approved rulebook (inactive)"],
      "why-missing": ["--why(왜 관통 지침인지 1줄)는 필수입니다", "--why is required (one line)"],
      "why-format": ["why는 개행 없는 120자 이내 1줄이어야 합니다", "why must be a single line ≤120 chars"],
      "finding-not-found": ["그 findingId의 지적이 장부에 없습니다", "finding not found in the ledger"],
      "other-campaign": ["이번 캠페인의 지적이 아닙니다(--campaign으로 그 캠페인을 지정)", "finding belongs to another campaign"],
      "legacy-unbound": ["기록 결속(title·askId)이 없는 구형 지적이라 상신 불가", "legacy finding without binding (title/askId)"],
      "not-eligible": ["해소(resolved)로 닫혔거나 강등(demoted) 닫힘인 지적만 상신할 수 있습니다", "only resolved-closed or demoted-closed findings are eligible"],
      "not-blocker": ["blocker였던 지적만 상신할 수 있습니다", "only blocker findings are eligible"],
      "envelope-read": ["수칙서 실물 판독 실패", "failed to read the rulebook"],
      "envelope-drift": ["수칙서가 승인 세대와 다릅니다(재승인 후 재시도)", "rulebook differs from the approved generation"],
      "already-in-envelope": ["이미 수칙서(코어·서고)에 있는 문안입니다", "already in the rulebook (core/archive)"],
      "duplicate": ["같은 지적이 이미 후보로 올라가 있습니다", "already proposed for this generation"],
      "declined-suppressed": ["같은 세대에서 이미 '안 올림' 처분된 지적입니다(거부권 존중)", "declined in this generation (veto respected)"],
      "ledger-write": ["후보 장부 기록 실패", "candidate ledger write failed"],
    };
    const m = msgs[r.reason] || [r.reason, r.reason];
    const sens = String(r.reason || "").startsWith("why-sensitive-") ? (en ? "why contains a sensitive-looking value — rewrite it" : "why에 비밀값 형태가 있어 거부됐습니다 — 문구를 바꿔 주세요") : null;
    console.log((en ? "rejected: " : "상신 거부: ") + (sens || (en ? m[1] : m[0])));
    process.exitCode = 2;
    return;
  }
  console.log((en ? "proposed: " : "상신됨: ") + r.candidateId + (en ? " — takes effect only after the user stamps it" : " — 효력은 사용자 도장부터(대시보드 '제안'에서 승인/안 올림)"));
  if (r.warn === "pending-cap") console.log(en ? "note: pending queue is over the guide cap — consider fewer, more general proposals" : "참고: 대기 후보가 안내 상한을 넘었습니다 — 상신은 더 적고 더 일반적인 원칙 위주로");
}
// [개선 2 · 판단 관문 — 장치화 2026-08-30] 전량 강등 보류 = 구현자 판단이 필요한 상태. 촉구 문장 대신 마커를 걸어 종료 훅이 판단 기록(round-judge)
// 전에는 턴을 못 끝내게 한다. 사용자 결정은 자동으로 만들지 않는다 — escalate를 고르면 그때 결정 장부 항목(decisions raise)이 있어야 기록된다.
function armScopeDemotedJudge(ws, camp, askId, en) {
  const cmd = `node codex-bridge.js round-judge ${askId || "<askId>"} <close-oos|re-verify|escalate --decision <id>> --note "..."`;
  const ok = askId ? addJudgeRequired(ws, { askId, campaignId: String(camp || ""), reason: "scope-demoted" }) : false;
  if (!ok) return en
    ? "[judgment gate NOT armed] (" + (askId ? "marker write failed" : "no askId") + ") — record the judgment manually: " + cmd
    : "[판단 관문 미장전] (" + (askId ? "마커 기록 실패" : "askId 없음") + ") — 관문이 걸리지 않았으니 수동으로 판단을 기록하라: " + cmd;
  return en
    ? "[judgment gate armed] every remaining blocker is out of the approved boundary — this turn cannot end until the implementer records a judgment: " + cmd + " (close-oos=close as out-of-scope · re-verify=request re-verification · escalate=direction question for the user — needs a decision id made by decisions raise)"
    : "[판단 관문 걸림] 남은 지적이 전부 승인된 범위 밖 — 구현자 판단이 기록되기 전에는 이 턴을 끝낼 수 없다: " + cmd + " (close-oos=범위 밖 종결 · re-verify=재검증 요청 · escalate=사용자 방향 질문 — decisions raise로 만든 항목 id 필수)";
}
// CLI round-judge — 판단 관문 해제 수단. 인자 없으면 대기 목록.
function cmdRoundJudge(rest) {
  const ws = configWs();
  const val = (f) => { const k = rest.indexOf(f); return k >= 0 && rest[k + 1] !== undefined ? String(rest[k + 1]) : ""; };
  const pos = [];
  for (let k = 0; k < rest.length; k++) { const a = String(rest[k] || ""); if (a === "--note" || a === "--decision") { k++; continue; } pos.push(a.trim()); }
  const askId = pos[0] || "", choice = pos[1] || "";
  const usage = tB('사용법: round-judge [<askId> <close-oos|re-verify|escalate> --note "판단 근거(12자+)" [--decision <결정 장부 id>]]', 'Usage: round-judge [<askId> <close-oos|re-verify|escalate> --note "reason (12+ chars)" [--decision <decision id>]]');
  if (!askId) {
    const cur = readJudgeRequired(ws);
    if (!cur) { process.stdout.write(tB("판단 대기 없음 — 관문이 걸린 판정이 없습니다.\n", "No judgment pending.\n")); return 0; }
    process.stdout.write(tB(`판단 대기 ${cur.items.length}건\n`, `Judgments pending: ${cur.items.length}\n`));
    for (const it of cur.items) process.stdout.write(`  ⬜ ${it.askId} [${it.reason}] ${it.campaignId}\n`);
    process.stdout.write(usage + "\n");
    return 0;
  }
  const r = resolveJudgeRequired(ws, askId, choice, { note: val("--note"), decisionId: val("--decision") });
  if (r.ok) { process.stdout.write(tB(`기록됨: ${askId} → ${choice}${r.decisionId ? ` (결정 장부 ${r.decisionId})` : ""}\n`, `Recorded: ${askId} → ${choice}${r.decisionId ? ` (decision ${r.decisionId})` : ""}\n`)); return 0; }
  const M = {
    "unknown-choice": usage,
    "not-pending": tB(`${askId}는 판단 대기 항목이 아닙니다(round-judge 로 목록 확인).`, `${askId} is not pending (see round-judge).`),
    "note-required": tB("--note 에 판단 근거를 12자 이상 적으세요 — 근거 없는 판단은 통과 의식입니다.", "--note needs a reason (12+ chars)."),
    "decision-required": tB("escalate 는 결정 장부의 실존 항목이 필요합니다 — 먼저 decisions raise 로 항목을 만들고 --decision <id> 로 지정하세요(사용자 판단 필요 = 스크립트 출력 강제).", "escalate requires an existing decision — create one with decisions raise, then pass --decision <id>."),
    "ledger-write-failed": tB("장부 기록 실패 — 판단이 저장되지 않았습니다(디스크 확인).", "Ledger write failed — judgment not saved."),
    "already-judged": tB(`이 판정엔 이미 판단(${r.choice}${r.decisionId ? " · 결정 " + r.decisionId : ""})이 기록돼 있습니다 — 마커만 남은 상태라면 같은 선택으로 다시 실행하면 정리됩니다. 다른 판단으로 바꾸는 중복 기록은 하지 않습니다.`, `Already judged (${r.choice}${r.decisionId ? " · decision " + r.decisionId : ""}) — rerun with the same choice to clear a leftover marker; conflicting duplicates are refused.`),
    "marker-remove-failed": tB("판단은 기록됐지만 마커 제거에 실패했습니다 — 다시 실행하세요.", "Recorded but the marker could not be removed — rerun."),
    "choice-not-allowed": tB("이 보류(검증 도중 압축/기록 판독 불가)는 범위 밖 종결(close-oos)로 닫을 수 없습니다 — re-verify(재검증) 또는 escalate --decision <id> 만 가능합니다.", "This hold (compaction / unreadable record during verification) cannot be closed as out-of-scope — use re-verify or escalate --decision <id>."),
  };
  process.stderr.write((M[r.reason] || tB(`실패(${r.reason})`, `Failed (${r.reason})`)) + "\n");
  return r.reason === "unknown-choice" ? 2 : 3;
}
// [개선 2 · 결정 장부 — HARNESS-REALIGNMENT §4] 결정은 장부 행으로만 존재하고 이 명령이 양식으로 출력한다. 행을 만드는 곳은 여기의
// raise(구현자 판단의 구조 채널)뿐. 선택 시 전제 지문(targetFp, 예: 승인 수칙서 지문)이 있는 결정은 지금 계약의 지문과 같아야 닫힌다(다른 세대 항목 종결 금지).
// 결정 항목 렌더의 정본은 contract-lib.renderDecisionBlock(마감 검사기가 같은 함수로 대조) — 여기서는 호출만.
function cmdDecisions(rest) {
  const ws = configWs();
  const sub = String(rest[0] || "").trim();
  if (sub === "template") { // 결정 블록 서식 — 사용자 편집 가능(기본지침 core 파일의 decisionBlock 키). show|set <json 파일>|reset
    const en = loadLang() === "en";
    const act = String(rest[1] || "show").trim();
    if (act === "show") { const cur = loadDecisionTemplate(en ? "en" : "ko"); process.stdout.write(JSON.stringify({ overridden: cur.overridden, warn: cur.warn, template: cur.template }, null, 1) + "\n"); return cur.warn ? 3 : 0; }
    if (act === "reset") { const r = saveDecisionTemplate(null, en ? "en" : "ko"); process.stdout.write((r.ok ? (en ? "reset to default" : "기본 서식으로 되돌림") : (en ? "reset failed: " : "되돌리기 실패: ") + r.reason) + "\n"); return r.ok ? 0 : 3; }
    if (act === "set") {
      const file = String(rest[2] || "").trim();
      let tpl = null; try { tpl = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.stderr.write((en ? "cannot read template json: " : "서식 JSON을 읽을 수 없습니다: ") + file + "\n"); return 2; }
      const r = saveDecisionTemplate(tpl, en ? "en" : "ko");
      if (!r.ok) { process.stderr.write((en ? "template rejected (" : "서식 거부(") + r.reason + (en ? ") — every line must keep its placeholders: " : ") — 줄마다 필수 자리표시자를 남겨야 합니다: ") + JSON.stringify(DECISION_TEMPLATE_DEFAULTS[en ? "en" : "ko"]) + "\n"); return 3; }
      process.stdout.write((en ? "template saved — render and closeout check now follow it" : "서식 저장 — 렌더와 마감 검사가 이 서식을 따릅니다") + "\n"); return 0;
    }
    process.stderr.write(tB("사용법: decisions template [show|set <json>|reset]", "Usage: decisions template [show|set <json>|reset]") + "\n"); return 2;
  }
  if (sub === "render") { // 마감문·보고용 — 열린 항목(또는 지정 id)을 쉬운 말 블록으로
    const en = loadLang() === "en";
    const cur = readDecisions(ws);
    const id = String(rest[1] || "").trim();
    const items = id ? [cur.latest.get(id)].filter(Boolean) : cur.open;
    if (!items.length) { process.stdout.write((id ? (en ? "no such decision" : "그 id의 결정이 없습니다") : (en ? "None" : "없음")) + "\n"); return id ? 3 : 0; }
    process.stdout.write(items.map((d) => renderDecisionBlock(d, en)).join("\n") + "\n");
    return 0;
  }
  const usage = tB("사용법: decisions [list] | decisions render [id] | decisions raise --kind <boundary|product|risk|external> --question \"…\" --why \"…\" --no-default \"기본값이 없는 이유\" --choice key=라벨[|고르면] (2개 이상) [--recommend key] [--ask <askId>] [--target-fp <sha1>] | decisions choose <id> <key> | decisions delegate <id> | decisions metrics [--campaign <id>]", "Usage: decisions [list] | decisions render [id] | decisions raise --kind <boundary|product|risk|external> --question \"…\" --why \"…\" --no-default \"why no default\" --choice key=label[|ifChosen] (2+) [--recommend key] [--ask <askId>] [--target-fp <sha1>] | decisions choose <id> <key> | decisions delegate <id> | decisions metrics [--campaign <id>]");
  const w = (x) => process.stdout.write(x + "\n");
  if (sub === "raise") { // 구현자 판단의 구조 채널 — 산문 대신 필드(형식만 검사·진위는 구현자 몫·개수는 지표)
    const val = (f) => { const k = rest.indexOf(f); return k >= 0 && rest[k + 1] !== undefined ? String(rest[k + 1]) : ""; };
    const choices = [];
    for (let k = 0; k < rest.length; k++) if (rest[k] === "--choice" && rest[k + 1] !== undefined) {
      const m = /^([a-z][a-z0-9-]{0,30})=([^|]+)(?:\|(.+))?$/i.exec(String(rest[k + 1]).trim());
      if (m) choices.push({ key: m[1].toLowerCase(), label: m[2].trim(), ifChosen: (m[3] || "").trim() });
      k++;
    }
    const kind = val("--kind").trim();
    if (!DECISION_KINDS.includes(kind)) { process.stderr.write(tB(`--kind 는 ${DECISION_KINDS.join("|")} 중 하나`, `--kind must be one of ${DECISION_KINDS.join("|")}`) + "\n"); return 2; }
    if (choices.length < 2) { process.stderr.write(tB("--choice 는 2개 이상(사용자가 고를 수 있는 진짜 갈림길만)", "--choice needs 2+ options") + "\n"); return 2; }
    if (new Set(choices.map((c) => c.key)).size !== choices.length) { process.stderr.write(tB("--choice 키가 중복됩니다 — 서로 다른 키로", "--choice keys must be unique") + "\n"); return 2; }
    const noDefault = val("--no-default").trim();
    if (noDefault.length < DECISION_NO_DEFAULT_MIN) { process.stderr.write(tB(`--no-default: 구현자가 스스로 정할 수 없는 이유를 ${DECISION_NO_DEFAULT_MIN}자 이상으로 — 기본값이 있으면 정해서 진행하고 보고만`, `--no-default: explain (${DECISION_NO_DEFAULT_MIN}+ chars) why you cannot pick a default — if a default exists, decide and report`) + "\n"); return 2; }
    const recommend = val("--recommend").trim();
    if (recommend && !choices.some((c) => c.key === recommend)) { process.stderr.write(tB("--recommend 는 --choice 키 중 하나", "--recommend must be one of the choice keys") + "\n"); return 2; }
    const r = openDecision(ws, { origin: "implementer", kind, campaignId: currentCampaignIdFor(ws), sourceAsk: val("--ask").trim(), targetFp: val("--target-fp").trim(), question: val("--question").trim(), why: val("--why").trim(), noDefault, choices, recommend });
    if (!r.ok) { process.stderr.write(tB(`기록 실패(${r.reason})`, `Record failed (${r.reason})`) + "\n"); return 3; }
    w(tB(`${r.existed ? "이미 기록됨" : "기록됨"}: ${r.decisionId}${r.existed ? " (" + r.status + ")" : ""} — 사용자는 decisions list 로 보고 decisions choose/delegate 로 답합니다`, `${r.existed ? "Already recorded" : "Recorded"}: ${r.decisionId}${r.existed ? " (" + r.status + ")" : ""} — the user answers via decisions list / choose / delegate`));
    return 0;
  }
  if (!sub || sub === "list") {
    const cur = readDecisions(ws);
    if (!cur.open.length) { w(tB("열린 결정 없음 — 지금 정할 것이 없습니다.", "No open decisions — nothing to decide now.")); return 0; }
    w(tB(`열린 결정 ${cur.open.length}건`, `Open decisions: ${cur.open.length}`));
    for (const d of cur.open) {
      w(`  ⬜ ${d.decisionId} [${d.kind}] ${d.question}`);
      if (d.why) w(tB(`     왜: ${d.why}`, `     why: ${d.why}`));
      w(tB(`     구현자가 못 정하는 이유: ${d.noDefault}`, `     why no default: ${d.noDefault}`));
      if (d.recommend) w(tB(`     권장: ${d.recommend}`, `     recommended: ${d.recommend}`));
      for (const c of d.choices) w(`     - ${c.key}: ${c.label}${c.ifChosen ? " — " + c.ifChosen : ""}`);
      w(tB(`     - ${DECISION_DELEGATE_KEY}: 네가 정해라(구현자가 정하고 보고만)`, `     - ${DECISION_DELEGATE_KEY}: you decide (implementer decides and reports)`));
      w(tB(`     기록: node codex-bridge.js decisions choose ${d.decisionId} <key>`, `     record: node codex-bridge.js decisions choose ${d.decisionId} <key>`));
    }
    return 0;
  }
  if (sub === "choose" || sub === "delegate") {
    const id = String(rest[1] || "").trim();
    const key = sub === "delegate" ? DECISION_DELEGATE_KEY : String(rest[2] || "").trim();
    if (!id || !key) { process.stderr.write(usage + "\n"); return 2; }
    const cur = readDecisions(ws);
    const d = cur.latest.get(id);
    let currentFp;
    if (d && d.targetFp) { try { currentFp = String((loadContract(ws) || {}).envelopeHash || ""); } catch { currentFp = ""; } } // 전제(승인 수칙서 지문)가 있는 결정만 재대조
    const r = resolveDecision(ws, id, key, { currentFp, by: "user" });
    if (r.ok) { w(tB(`기록됨: ${id} → ${r.status === "delegated" ? "네가 정해라(구현자 결정)" : key}`, `Recorded: ${id} → ${r.status === "delegated" ? "delegated to implementer" : key}`)); return 0; }
    const M = {
      "not-found": tB("그 id의 열린 결정이 없습니다(decisions list로 확인).", "No open decision with that id (see decisions list)."),
      "already-resolved": tB("이미 기록된 결정입니다 — 결과 행은 덮어쓰지 않습니다.", "Already recorded — result rows are never overwritten."),
      "target-drift": tB("이 결정이 전제한 수칙서 세대가 바뀌었습니다 — 항목을 닫지 않았습니다. decisions list로 다시 확인하세요(다른 세대의 항목 종결 금지).", "The rulebook generation this decision assumed has changed — not closed. Re-check with decisions list."),
      "unknown-choice": tB("선택지 밖 키입니다 — decisions list의 key 중 하나 또는 delegate.", "Unknown choice key — use a key from decisions list or delegate."),
    };
    process.stderr.write((M[r.reason] || tB(`기록 실패(${r.reason})`, `Record failed (${r.reason})`)) + "\n");
    return 3;
  }
  if (sub === "metrics") {
    const k = rest.indexOf("--campaign");
    const camp = k >= 0 && rest[k + 1] ? String(rest[k + 1]) : "";
    w(JSON.stringify(decisionMetrics(ws, camp), null, 1));
    return 0;
  }
  process.stderr.write(usage + "\n");
  return 2;
}
function cmdFindingJudge(rest) {
  const ws = configWs();
  const en = loadLang() === "en";
  const flagVal = (flag) => { const i = rest.indexOf(flag); return i >= 0 && rest[i + 1] !== undefined ? String(rest[i + 1]).trim() : ""; };
  const campFlag = flagVal("--campaign");
  const camp = campFlag || currentCampaignIdFor(ws);
  const gen = readFrozenEnvelope(ws);
  const opens = openFindingsFor(ws, camp, gen);
  const rows = readFindingsLedger(ws);
  const disp = dispositionsFor(ws, camp);
  // [개선 1-A 조회 옵션] --list-oos: 이 판에 동결된 제외 칸 전문(번호+제목)과 결속 상태 — 판정 자리의 재료 줄(≤200자)에서 잘린 항목의 원천
  if (rest.includes("--list-oos")) {
    const fzL = readFrozenEnvelopeRec(ws);
    const lastL = latestAskJobIdFor(ws);
    const bound = !!(fzL && fzL.askId && lastL && fzL.askId === lastL);
    if (!fzL || !Array.isArray(fzL.oos)) { process.stdout.write(tB("동결된 제외 칸 없음(이 판의 검증 시작 기록이 없거나 구 형식).\n", "No frozen out-of-scope items (no freeze for this round or legacy format).\n")); return; }
    process.stdout.write(tB(`이 판의 제외 칸 ${fzL.oos.length}건 — 동결 잡 ${fzL.askId || "?"} · 마지막 검증 잡 ${lastL || "없음"} · ${bound ? "결속됨(되받아침 가능)" : "결속 안 됨(--oos 거부됨 — 다음 검증 시작 후 다시)"}\n`, `Out-of-scope items of this round: ${fzL.oos.length} — frozen job ${fzL.askId || "?"} · latest job ${lastL || "none"} · ${bound ? "bound (rebut allowed)" : "not bound (--oos rejected — start the next verification first)"}\n`));
    for (const o of fzL.oos) process.stdout.write("  " + o.id + "  " + String(o.title || "") + "\n");
    return;
  }
  // 위치 인자=플래그와 그 값을 제외한 나머지(--campaign이 첫 인자여도 목록 모드가 되도록)
  const pos = [];
  for (let i = 0; i < rest.length; i++) { const a = String(rest[i] || ""); if (a === "--note" || a === "--campaign" || a === "--source" || a === "--decision" || a === "--oos") { i++; continue; } pos.push(a.trim()); }
  const id = pos[0] || "";
  if (!id) {
    if (!opens.length) { process.stdout.write(tB(`열린 지적 없음(캠페인 ${camp}) — 판단할 것이 없습니다. 관문 거부문의 캠페인이 다르면 --campaign "<그 id>"를 붙이세요.\n`, `No open findings (campaign ${camp}) — nothing to judge. If the gate refusal names a different campaign, pass --campaign "<that id>".\n`)); return; }
    const CH = { "fix-fact": en ? "fix (proven wrong)" : "수용(사실 오류)", "fix-gap": en ? "fix (enrichment)" : "수용(보강 요구)", rebut: en ? "rebutted" : "반박 종결", park: en ? "parked" : "보관함 이관", escalate: en ? "escalated to the user (decision ledger)" : "사용자 방향 질문(결정 장부)" };
    process.stdout.write(tB(`열린 지적 ${opens.length}건 — 캠페인 ${camp}\n`, `Open findings: ${opens.length} — campaign ${camp}\n`));
    // 유효성 표시=관문과 같은 계산(확인 검증 [보완]① — 낡은 처분을 ✅로 보이면 '관문은 막는데 화면은 전부
    // 판단됨' 모순): ✅=지금 유효한 처분만. 재등장으로 낡은 처분은 🔁(재판단 필요)로 구분.
    for (const o of opens) {
      const d = disp.get(o.id);
      const valid = dispositionValid(rows, camp, d);
      const mark = valid ? "✅" : d ? "🔁" : "⬜";
      const suffix = valid ? tB(" → ", " → ") + (CH[d.choice] || d.choice) : d ? tB(" → 재등장으로 재판단 필요(이전: ", " → re-raised, judge again (was: ") + (CH[d.choice] || d.choice) + ")" : "";
      process.stdout.write(`  ${mark} ${o.id} [${o.tag}] ${String(o.titleNorm || "").slice(0, 60)}${suffix}\n`);
    }
    const remain = undisposedOpenFindings(ws, camp, gen).length;
    process.stdout.write(remain
      ? tB(`미판단 ${remain}건 — 기록: node codex-bridge.js finding-judge <id> <fix-fact|fix-gap|rebut[ --oos oos-n]|park|escalate> --note "근거"${campFlag ? ` --campaign "${camp}"` : ""}\n`, `${remain} unjudged — record: node codex-bridge.js finding-judge <id> <fix-fact|fix-gap|rebut[ --oos oos-n]|park|escalate> --note "evidence"${campFlag ? ` --campaign "${camp}"` : ""}\n`)
      : tB("전부 판단됨 — 다음 검증을 시작할 수 있습니다.\n", "All judged — the next verification can start.\n"));
    return;
  }
  const choice = pos[1] || "";
  const note = flagVal("--note");
  if (!FINDING_DISPOSITIONS.includes(choice)) {
    die(tB(`사용법: finding-judge <id> <fix-fact|fix-gap|rebut[ --oos oos-n]|park|escalate> --note "근거(12자+)" (제외 칸 전문: finding-judge --list-oos) [--campaign "<관문 거부문의 캠페인 id>"]\n  fix-fact=사실 오류 인정(고침·근거 필수) / fix-gap=보강 요구 수용(고침·이유 필수) / rebut=반박 종결(근거 필수) / park=보관함 이관(근거=영수증)`,
           `Usage: finding-judge <id> <fix-fact|fix-gap|rebut[ --oos oos-n]|park|escalate> --note "evidence (12+ chars)" (out-of-scope list: finding-judge --list-oos) [--campaign "<campaign id from the gate refusal>"]\n  fix-fact=proven wrong (fix, note required) / fix-gap=enrichment accepted (fix, note required) / rebut=rebutted (note required) / park=parked (receipt is the evidence)`), 2);
  }
  // [경위 v2 생산자 결속] --source "<file>#<anchor>" (선택·반복 가능): 판단이 가리키는 정본 구간을
  // 구조 필드로 기록 — 검증(경계·containment·민감 제외·anchor 해석) 실패=즉시 거부(침묵 기록 금지).
  // repoKey는 기록 시점 결속(ab-1) — 수확기가 이 키로 파티션·containment를 재검증한다.
  let sourceRefs;
  {
    const srcArgs = [];
    for (let si = 0; si < rest.length; si++) {
      if (String(rest[si] || "") !== "--source") continue;
      const val = si + 1 < rest.length ? String(rest[si + 1] || "") : "";
      // R2 blocker⑥: 값이 없거나 다음 토큰이 플래그면 형식 오류로 즉시 거부(침묵 통과 금지)
      if (!val || val.startsWith("--")) die(tB('--source에 값이 없습니다 — 형식: --source "<repo 상대경로>#<heading:제목|lines:s-e>"', '--source needs a value — format: --source "<repo-relative path>#<heading:title|lines:s-e>"'), 2);
      srcArgs.push(val);
    }
    if (srcArgs.length) {
      const MPV9 = require(path.join(__dirname, "map-provenance.js"));
      const repo9 = (resolveScoutRepo(ws, loadContract(ws)) || {}).repo || ws;
      sourceRefs = [];
      for (const sa of srcArgs) {
        const hi = sa.indexOf("#");
        if (hi <= 0) die(tB(`--source 형식: "<repo 상대경로>#<heading:제목|lines:s-e>" — 받은 값: ${sa}`, `--source format: "<repo-relative path>#<heading:title|lines:s-e>" — got: ${sa}`), 2);
        const file = sa.slice(0, hi), anchor = sa.slice(hi + 1);
        const rv = MPV9.resolveAnchor(repo9, file, anchor);
        if (!rv.ok) die(tB(`--source 검증 실패(${rv.reason}): ${sa} — 정본 구간이 해석돼야 기록합니다.`, `--source validation failed (${rv.reason}): ${sa}`), 2);
        sourceRefs.push({ file: file.replace(/\\/g, "/"), anchor, contentHash: MPV9.excerptShaOf(rv.text), repoKey: MPV9.repoKeyFor(repo9) });
      }
    }
  }
  const target = opens.find((o) => o.id === id);
  if (!target) die(tB(`열린 지적에 ${id}가 없습니다(캠페인 ${camp}·현재 세대 기준). 현황: node codex-bridge.js finding-judge${campFlag ? ` --campaign "${camp}"` : ""}`, `${id} is not an open finding (campaign ${camp}, current generation). Status: node codex-bridge.js finding-judge${campFlag ? ` --campaign "${camp}"` : ""}`), 2);
  // 1차 검증 blocker① 반영: 수용에도 근거 의무 — 수용이 '싼 기본값'이면 판단 강제가 무력화된다(실사고의
  // 원인 그 자체). park만 예외(보관함 영수증이 실물 근거). 12자는 rebut과 같은 최소 기준.
  if (choice !== "park" && note.length < 12) {
    const why = { "fix-fact": tB("무엇이 어떻게 틀렸다고 증명됐는지", "what was proven wrong and how"), "fix-gap": tB("틀린 게 아닌데 왜 받아들이는지", "why you accept it although nothing is wrong"), rebut: tB("측정·재현 근거", "measured/reproduced evidence"), escalate: tB("왜 구현자가 정할 수 없고 사용자 방향이 필요한지", "why the implementer cannot decide and the user's direction is needed") }[choice];
    die(tB(`${choice}에는 근거가 필요합니다 — --note "${why}"(12자 이상). 근거 없는 처분은 판단이 아니라 통과 의식입니다.`, `${choice} needs a note — --note "${why}" (12+ chars). A note-free judgment is a ritual, not a judgment.`), 2);
  }
  // [장치화 2026-08-30] escalate=사용자 판단 필요 — 결정 장부의 실존 항목 없이는 기록 불가(산문으로 "정해 주세요"를 쓰는 길 차단·스크립트 출력 강제)
  let escDecisionId = "";
  if (choice === "escalate") {
    escDecisionId = flagVal("--decision");
    const d9 = escDecisionId ? readDecisions(ws).latest.get(escDecisionId) : null;
    if (!d9) die(tB("escalate 는 결정 장부 항목이 필요합니다 — 먼저 node codex-bridge.js decisions raise ... 로 항목을 만들고 --decision <id> 를 지정하세요.", "escalate requires a decision — create one with decisions raise, then pass --decision <id>."), 2);
  }
  // [개선 1-B · 되받아침 명령] rebut --oos oos-n: 이 판에 동결된 제외 칸 번호로 되받아친다 — 효력=범위 밖 강등과 동일(지적은 '구현자 되받아침'
  // 사유로 닫히고 기록에 남으며, 검증자는 반증 없이는 다시 올릴 수 없다). 번호 판단은 구현자 몫·하네스는 번호 유효성만.
  let rebutOos = "";
  if (choice === "rebut") {
    const oosArg = flagVal("--oos");
    if (oosArg) {
      const fz9 = readFrozenEnvelopeRec(ws);
      // 확인 blocker②: 동결이 '이 작업공간의 마지막 검증 잡'에 결속돼 있어야 그 판의 번호다 — 새 판의 동결 쓰기가 실패해 이전 파일이 남은 경우 거부
      const last9 = latestAskJobIdFor(ws);
      if (!fz9 || !fz9.askId || !last9 || fz9.askId !== last9) die(tB(`동결된 제외 칸이 마지막 검증 잡에 결속되지 않았습니다(동결 ${fz9 && fz9.askId ? fz9.askId : "없음"} · 마지막 잡 ${last9 || "없음"}) — 이전 판의 번호로는 되받아칠 수 없습니다. 다음 검증을 시작한 뒤 finding-judge --list-oos 로 확인하세요.`, `Frozen out-of-scope items are not bound to the latest verification job (freeze ${fz9 && fz9.askId ? fz9.askId : "none"} · latest ${last9 || "none"}) — cannot rebut with a previous round's numbers.`), 2);
      const okOos = Array.isArray(fz9.oos) && fz9.oos.some((o) => o.id === oosArg);
      if (!okOos) die(tB(`--oos ${oosArg} 는 이 판에 동결된 제외 칸 번호가 아닙니다(유효: ${Array.isArray(fz9.oos) ? fz9.oos.map((o) => o.id).join(", ") || "없음" : "동결 없음"} — 전문: finding-judge --list-oos).`, `--oos ${oosArg} is not an out-of-scope item frozen for this round (see finding-judge --list-oos).`), 2);
      rebutOos = oosArg;
    }
  }
  let parkedId = "";
  if (choice === "park") {
    const r = backlogAdd(ws, { title: target.titleNorm, tag: "백로그", lang: loadLang(), source: "finding-judge" });
    if (!r.ok) die(tB(`보관함 등록 실패(${r.error}) — 처분을 기록하지 않았습니다.`, `Backlog registration failed (${r.error}) — judgment NOT recorded.`), 1);
    parkedId = r.id;
  }
  // asOfRound 결속(1차 blocker①): 이 처분은 '지금까지의 마지막 등장'까지만 유효 — 이후 재등장하면
  // undisposedOpenFindings가 낡은 처분으로 판정해 관문이 다시 닫힌다(재판단 강제).
  const asOfRound = findingActivityRound(readFindingsLedger(ws), camp, id);
  // R2 blocker⑤(ab-1): 사건 최상위에 기록 시점 저장소 정체성(repoKey+repoPath) 결속 — 수확기는
  // close 시점의 현재 대상이 아니라 이 값으로 파티션·검증(대상 전환 후에도 A 사건=A 저장소).
  let evRepoTop;
  if (sourceRefs) {
    const MPV9b = require(path.join(__dirname, "map-provenance.js"));
    const repo9b = (resolveScoutRepo(ws, loadContract(ws)) || {}).repo || ws;
    evRepoTop = { repoKey: MPV9b.repoKeyFor(repo9b), repoPath: String(repo9b) };
  }
  const rowsJ = [{ type: "disposition", campaignId: camp, findingId: id, choice, note: note.slice(0, 400), backlogId: parkedId, ...(escDecisionId ? { decisionId: escDecisionId } : {}), ...(rebutOos ? { oosId: rebutOos } : {}), asOfRound, envelopeHash: gen || null, ...(sourceRefs ? { sourceRefs, ...evRepoTop } : {}), ts: new Date().toISOString() }];
  // 확인 blocker③(2차): 되받아침은 종결 행을 '먼저' 놓고 처분 행을 뒤에 둔 한 번의 쓰기 — 꼬리가 부분 기록돼도 살아남는 쪽이 종결 행이라
  // 지적은 implementer-oos 계보로 닫힌 채 남고(관문 fail-open 없음·다음 통과 판이 resolved로 덮지 않음), 잃는 것은 메모뿐. 쓰기 뒤 장부를
  // 다시 읽어 두 행이 실재하는지 확인(read-back)하고, 없으면 기록 실패로 보고한다.
  const tsJ = new Date().toISOString();
  if (rebutOos) rowsJ.unshift({ type: "close", campaignId: camp, findingId: id, closeReason: "implementer-oos", oosId: rebutOos, round: asOfRound, envelopeHash: gen || null, ts: tsJ });
  rowsJ[rowsJ.length - 1].ts = tsJ; // 처분 행도 같은 쓰기 도장(read-back 대조 키)
  let wrote = appendFindingsLedger(ws, rowsJ);
  if (wrote) {
    const back = readFindingsLedger(ws);
    const has = (r0) => back.some((r) => r && r.type === r0.type && r.campaignId === r0.campaignId && r.findingId === r0.findingId && r.ts === r0.ts && (r0.type !== "close" || r.closeReason === r0.closeReason));
    if (!rowsJ.every(has)) wrote = false;
  }
  if (!wrote) die(tB("장부 기록 실패(쓰기 또는 읽기 확인 실패) — 처분이 저장되지 않았습니다. 같은 명령을 다시 실행하세요(되받아침이 이미 종결됐다면 목록에서 사라져 있음).", "Ledger write failed (write or read-back) — judgment not saved. Rerun the same command."), 1);
  if (rebutOos) { // 되받아침 효력=범위 밖 강등과 동일: 지적을 '구현자 되받아침' 사유로 닫는다(기록 보존·삭제 없음 — 종결 행은 위 한 번의 쓰기에 포함)
    process.stdout.write(tB(`되받아침: ${id} → 제외 ${rebutOos} 전제(범위 밖) — 검증자가 다시 올리려면 반증(contest)이 필요합니다.\n`, `Rebutted: ${id} → out-of-scope ${rebutOos} — the verifier needs contest evidence to re-raise.\n`));
  }
  const remain = undisposedOpenFindings(ws, camp, gen).length;
  process.stdout.write(tB(`기록됨: ${id} → ${choice}${parkedId ? ` (보관함 영수증 ${parkedId})` : ""}${disp.has(id) ? " (재판단 — 이전 기록 대체)" : ""}\n남은 미판단 ${remain}건${remain ? "" : " — 다음 검증을 시작할 수 있습니다"}\n`,
                          `Recorded: ${id} → ${choice}${parkedId ? ` (backlog receipt ${parkedId})` : ""}${disp.has(id) ? " (re-judged — supersedes previous)" : ""}\n${remain} unjudged remaining${remain ? "" : " — the next verification can start"}\n`));
  const gaps = fixGapCount(ws, camp);
  if (gaps >= FIX_GAP_NOTICE_AT) {
    process.stdout.write(tB(
      `📈 이번 묶음에서 '보강 요구 수용(fix-gap)'이 ${gaps}건째입니다 — 산출물이 틀려서가 아니라 "더 자세히"가 반복되는 상태입니다. 글로 정하는 단계가 수확 체감에 들어갔다는 신호이니, 다음 왕복 대신 실제 구현·측정으로 옮길지 사용자에게 이 신호와 함께 보고하세요.\n`,
      `📈 That is fix-gap #${gaps} in this batch — the output is not wrong; "more detail" keeps repeating. This signals diminishing returns for the paper stage: report this signal to the user and consider moving to real implementation/measurement instead of another round.\n`));
  }
}
function cmdBacklog(rest) {
  const lib = require("./contract-lib.js");
  const ws = configWs();
  const sub = rest[0] || "list";
  const val = (flag) => { const i = rest.indexOf(flag); return i >= 0 && rest[i + 1] ? rest[i + 1] : ""; };
  if (sub === "add") {
    const tag = val("--tag"), title = val("--title");
    if (tag !== "주의" && tag !== "백로그") die(tB('사용법: backlog add --tag 주의|백로그 --title "..." [--file <경로>] [--source <jobId>]', 'Usage: backlog add --tag 주의|백로그 --title "..." [--file <path>] [--source <jobId>]'), 2);
    const c = loadContract(ws);
    const r = lib.backlogAdd(ws, { tag, title, file: val("--file"), source: val("--source"), lang: loadLang(), mode: c.harnessMode, profile: (c.harnessMode === "codex-codex" ? c.codexVerifyProfile : c.verifyProfile) || "integrity" });
    if (!r.ok) die(tB("장부 기록 실패(잠금/입력): ", "Backlog write failed (lock/input): ") + String(r.error || ""), 3);
    process.stdout.write((r.existed ? tB("재발견 기록됨(기존 항목 갱신) — id: ", "Re-occurrence recorded (existing item updated) — id: ") : tB("등록됨 — id: ", "Registered — id: ")) + r.id + "\n"); return;
  }
  if (sub === "list") {
    const all = rest.includes("--all");
    const r0 = lib.readBacklog(ws);
    const { items, corrupt } = r0;
    if (r0.readError) process.stdout.write(tB("⚠ 장부 파일을 읽지 못했습니다(권한/잠금) — 아래 집계는 불완전할 수 있습니다.\n", "⚠ Could not read the ledger file (permissions/lock) — counts below may be incomplete.\n"));
    const shown = all ? items : items.filter((x) => x.status === "open");
    const cnt = (t) => shown.filter((x) => x.tag === t && x.status === "open").length;
    // 표시 라벨은 전역 언어를 따름(장부 저장 태그는 한국어 고정값 — 표시만 번역. 백로그 ab1fe318 소화)
    const en = loadLang() === "en";
    const tagL = (t) => (en ? (t === "주의" ? "caution" : "backlog") : t);
    process.stdout.write(tB(`검증 백로그 — 열림 ${items.filter((x) => x.status === "open").length}건(주의 ${cnt("주의")} · 백로그 ${cnt("백로그")})${all ? ` · 전체 ${items.length}건` : ""}\n`, `Verify backlog — open ${items.filter((x) => x.status === "open").length} (caution ${cnt("주의")} · backlog ${cnt("백로그")})${all ? ` · total ${items.length}` : ""}\n`));
    for (const x of shown) process.stdout.write(`  [${tagL(x.tag)}]${x.status !== "open" ? "(" + x.status + ")" : ""} ${x.id} ${x.title}${x.file ? " — " + x.file : ""} (${x.seenCount}${en ? "×" : "회"} · ${String(x.lastSeen).slice(0, 10)})\n`);
    if (corrupt) process.stdout.write(tB(`⚠ 손상 ${corrupt}줄 — 해당 줄의 할 일은 표시되지 않을 수 있습니다(원문은 장부 파일에 보존됨).\n`, `⚠ ${corrupt} corrupt line(s) — items on those lines may be hidden (originals preserved in the ledger file).\n`));
    return;
  }
  if ((sub === "done" || sub === "dismiss") && rest[1]) {
    const r = lib.backlogSetStatus(ws, rest[1], sub === "done" ? "done" : "dismissed");
    if (!r.ok) die(tB("상태 변경 실패: ", "Status change failed: ") + String(r.error || ""), r.error === "not-found" ? 2 : 3);
    process.stdout.write(tB("처리됨 ✓\n", "Updated ✓\n")); return;
  }
  if (sub === "clear" && rest.includes("--done") && rest.includes("--confirm")) {
    const r = lib.backlogClearDone(ws);
    if (!r.ok) die(tB("정리 실패: ", "Clear failed: ") + String(r.error || ""), 3);
    process.stdout.write(tB(`닫힌 항목 ${r.removed}건 정리됨${r.corrupt ? ` · 손상 ${r.corrupt}줄은 원문 보존` : ""}\n`, `Cleared ${r.removed} closed item(s)${r.corrupt ? ` · ${r.corrupt} corrupt line(s) preserved verbatim` : ""}\n`)); return;
  }
  die(tB('사용법: backlog add --tag 주의|백로그 --title "..." [--file <경로>] [--source <jobId>] | backlog list [--all] | backlog done <id> | backlog dismiss <id> | backlog clear --done --confirm', 'Usage: backlog add --tag 주의|백로그 --title "..." [--file <path>] [--source <jobId>] | backlog list [--all] | backlog done <id> | backlog dismiss <id> | backlog clear --done --confirm'), 2);
}
function cmdAskJob(rest) {
  const sub = rest[0] || "status";
  const id = rest[1] || "";
  if (sub === "status") {
    if (id) { const j = readAskJob(id); if (!j) die(tB("검증 작업을 찾을 수 없습니다: ", "Verification job not found: ") + id, 2); process.stdout.write(JSON.stringify(Object.assign({}, j, { prompt: undefined, workerAlive: pidAlive(j.workerPid) }), null, 2) + "\n"); return; }
    const a = activeAskJob(configWs()); process.stdout.write(a ? JSON.stringify(Object.assign({}, a, { prompt: undefined, workerAlive: pidAlive(a.workerPid) }), null, 2) + "\n" : tB("활성 검증 작업 없음\n", "No active verification job\n")); return;
  }
  if (sub === "clear" && id && rest.includes("--confirm")) {
    // id 문법 강제(구현검증 1차 blocker): 문자 제거식 경로 해석은 잘못된 id가 '다른 정상 job'으로 축소돼
    // 오삭제될 수 있다 — 문법 밖 id는 거부하고 수동 처리 안내(계약 ⓚ와 일치).
    if (!askJobIdOk(id)) die(tB("id 문법이 올바르지 않습니다: " + id + " — 파일명이 문법을 벗어난 손상 파일은 ask-jobs 폴더에서 직접 확인·삭제하세요.", "Invalid job id grammar: " + id + " — for corrupt files whose names fall outside the grammar, inspect/delete them manually in the ask-jobs folder."), 2);
    const jsonPath = askJobFile(id);
    const j = readAskJob(id);
    if (!j && fs.existsSync(jsonPath)) {
      // P-4(2차 blocker): 파싱 불가 파일은 '삭제'가 아니라 원자 rename 격리 — queued/deadline/ws를 알 수
      // 없어 생존·잠금 판단이 원천 불가. 원문 보존, corruptAskJobFiles의 시한부 차단이 약 60분 유지된다.
      const q = jsonPath + ".corrupt-" + Date.now();
      try { fs.renameSync(jsonPath, q); } catch (e) { die(tB("격리 실패: ", "Quarantine failed: ") + String(e && e.message || e), 3); }
      process.stdout.write(tB(`손상 job을 격리했습니다: ${path.basename(q)} — 원문은 보존되며, 살아있는 worker와의 중복을 막기 위해 약 60분(시스템 timeout 상한)까지 신규 검증 생성 차단이 유지됩니다. 즉시 해제가 필요하면 위험을 확인한 뒤 격리 파일을 직접 삭제하세요(안전 해소 아님).\n`, `Quarantined the corrupt job: ${path.basename(q)} — original preserved; new-verification blocking stays ~60min (system timeout cap) to avoid duplicating a live worker. To lift immediately, review the risk and delete the quarantine file manually (not a safe resolution).\n`)); return;
    }
    if (!j) return;
    // P-2(1차 blocker)+queued 경합(설계 ⓚ ⑸①): 생성과 같은 ask-job 잠금 안에서 판정 —
    // 생성 잠금 해제~spawn~.pid 기록 공백에선 두 PID 모두 부재라 생존 검사로 못 닫는다.
    let intent9 = false;
    try {
      withAskJobLock(String(j.workspace || configWs()), () => {
        const cur = readAskJob(id) || j;
        const dl = Date.parse(cur.deadlineAt || "");
        if (cur.state === "queued" && Number.isFinite(dl) && Date.now() < dl) throw Object.assign(new Error(tB("대기(queued) 상태이고 deadline이 지나지 않아 지우지 않았습니다 — worker가 곧 붙을 수 있습니다. deadline 경과 후 다시 시도하세요.", "Job is queued and its deadline has not passed; not cleared — a worker may still attach. Retry after the deadline.")), { exitCode: 3 });
        let spawnPid = 0; try { spawnPid = parseInt(fs.readFileSync(path.join(ASK_JOBS_DIR, id + ".pid"), "utf8"), 10) || 0; } catch { /* 없음 */ }
        const alive9 = pidAlive(cur.workerPid) || pidAlive(spawnPid);
        if (cur.state === "selecting" && alive9) {
          // [3b 취소 계약] 살아있는 선별 worker는 죽이지 않는다(죽음-안전 규칙 유지) — 같은 잠금 안에서 취소
          // 의사만 기록. worker가 페이지 경계/전이 직전(같은 잠금)에 관측해 failed(cancelled)로 정착한다.
          if (!atomicWrite(askJobCancelIntentFile(id), JSON.stringify({ ts: new Date().toISOString(), by: "ask-job-clear" }))) throw Object.assign(new Error(tB("취소 의사 기록 실패 — 다시 시도하세요.", "Failed to record the cancel intent — retry.")), { exitCode: 3 });
          intent9 = true; return;
        }
        if (alive9) throw Object.assign(new Error(tB("worker가 살아 있어 지우지 않았습니다.", "Worker is still alive; job was not cleared.")), { exitCode: 3 });
        for (const ext of [".json", ".out", ".err", ".pid", ".cancel-intent"]) try { fs.unlinkSync(path.join(ASK_JOBS_DIR, id + ext)); } catch { /* 없음 */ }
      });
    } catch (e) { die(String(e && e.message || e), Number(e && e.exitCode) || 3); }
    if (intent9) { process.stdout.write(tB("취소 의사를 기록했습니다 — 진행 중인 선별이 회수되는 대로 이 작업은 failed(cancelled)로 정착합니다. 정착 후 같은 명령으로 기록을 정리하세요.\n", "Cancel intent recorded — the running selection will be reclaimed and this job will settle as failed(cancelled). Clear the record with the same command afterwards.\n")); return; }
    process.stdout.write(tB("확인된 검증 작업 기록을 지웠습니다.\n", "Cleared the reviewed verification job record.\n")); return;
  }
  die(tB("사용법: ask-job status [id] | ask-job clear <id> --confirm", "Usage: ask-job status [id] | ask-job clear <id> --confirm"), 2);
}

// ── P-12 2b 왕복 예산(설계 동결 v6) ──────────────────────────────────────────
// child가 자기 job 파일에 예약 영수증을 남긴다(worker patch와 경합 없음 — worker는 시작 전 running·종료 후
// final만 기록하고 종료 patch는 재읽기-병합이라 이 필드를 보존한다).
function patchAskJobFile(id, extra) {
  const file = askJobFile(id);
  let cur = null; try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return false; }
  if (!cur || cur.id !== id) return false;
  return atomicWrite(file, JSON.stringify(Object.assign({}, cur, extra)));
}
// 검증 모델 호출 공통 래퍼(⑶) — resume/new 두 분기가 이 함수 '1곳'을 호출 직전에 지난다(전처리 실패=호출 전
// =미집계). 소진 거부(M+1)만 phase/round 불변으로 조기 반환하고, tracked 성공·무제한·가시화된 untracked
// 진행은 codex-verifying 기록+round를 정확히 1회 증가시킨다. 상한의 성격(정직 한정): '정상 추적 상태의
// 기계적 상한' — 앵커·잠금·기록 실패는 미집계로 느슨해지되 반드시 가시화(절대 상한 주장 금지).
// 소진 문구(3차 blocker 봉합): ①'미확인 반영' 같은 캐논 밖 예외를 만들지 않는다 — 확인 왕복이 불가하면
// '[보완]'은 반영하지 않고 미반영 보고가 원칙(확인 단계 종결 규칙과 동형), 반영이 필요하면 사용자 승인으로.
// ②프로필 정합 — v2.4 어휘([보완]/[주의]/[백로그]·보관함)는 core 전용, integrity(기타)는 프로필 중립 문구.
function budgetExhaustMsg(m, lang, profile) {
  const en = lang === "en";
  if (profile === "core") return en
    ? `[verify round cap exhausted · ${m}/${m}] This campaign's verification round cap is used up — no further rounds. Re-judge only the latest findings: (1) accepted and already handled, (2) rebutted and closed with measured evidence, (3) parked out-of-scope/caution with a real backlog receipt, or (4) a product/risk/external decision the implementer cannot make. Do not apply new '[notes]' without their required confirmation; if one is important enough to require acceptance, put only that concrete choice in (4). Never auto-pass. Ask the user one combined question only when lane (4) is nonempty; otherwise close the triage without inventing choices, while stating that it is not a verification pass.`
    : `[검증 왕복 상한 소진 · ${m}/${m}] 이 지시(턴)의 검증 왕복 상한을 다 썼습니다 — 추가 왕복은 불가합니다. 마지막 지적만 다시 판단해 ①수용해 이미 처리 ②측정 근거로 반박·종결 ③범위 밖·주의를 실제 영수증과 보관함 이관 ④구현자가 대신 정할 수 없는 제품·위험·외부 결정으로 정확히 나누세요. 확인 검증 없는 새 '[보완]' 반영은 금지하며, 꼭 수용해야 할 보완만 구체적 선택으로 ④에 둡니다. 자동 통과시키지 마세요. ④가 있을 때만 한 묶음으로 사용자에게 묻고, 없으면 선택지를 만들지 말고 검증 통과가 아니라는 점과 함께 자동 정리하세요.`;
  return en
    ? `[verify round cap exhausted · ${m}/${m}] This campaign's verification round cap is used up — no further rounds. Re-judge only the latest findings into exactly one lane: accepted and handled; rebutted with measured evidence; parked with a real backlog receipt; or a genuine product/risk/external decision. Never auto-pass. Ask one combined user question only when the last lane is nonempty; otherwise close the triage without inventing choices and state that it is not a verification pass.`
    : `[검증 왕복 상한 소진 · ${m}/${m}] 이 지시(턴)의 검증 왕복 상한을 다 썼습니다 — 추가 왕복은 불가합니다. 마지막 지적만 ①수용·처리 ②측정 근거로 반박·종결 ③실제 영수증과 보관함 이관 ④진짜 제품·위험·외부 결정 중 정확히 한 곳으로 나누세요. 자동 통과시키지 마세요. ④가 있을 때만 한 번에 사용자에게 묻고, 없으면 선택지를 만들지 말고 검증 통과가 아니라는 점과 함께 자동 정리하세요.`;
}
// ── 지적 처분 관문(2026-08-01) — 판단 강제 지점: 같은 캠페인의 열린 지적에 처분이 없으면 다음 검증을
// 시작하지 않는다(예약보다 앞 = 왕복 미소모·exit 3). 캠페인 귀속은 예산 게이트와 같은 산식(내구=job 동결
// campaignId·직접=현재 앵커) — 새 지시(새 캠페인)는 이전 캠페인 지적으로 막지 않는다(그건 상한 마감문 몫).
// 앵커 실패·legacy job(campaignId 없음)·장부 판독 실패=미발동(잠금 사고 방지 — '판독 실패=목록 생략' 관례).
// 캠페인 귀속 산식의 단일 출처(1차 검증 blocker② 반영): 관문·예산 게이트·machineFindingsLayer가 같은
// 값을 쓰도록 여기서 1회 계산해 전달한다(생산자만 currentCampaignIdFor를 재판독하면 미집계 경로에서
// 지적이 다른 캠페인에 기록돼 관문이 못 본다). null=귀속 불가(미발동·생산자는 기존 폴백 유지 — 정직 한계).
function campaignSnapFor(durableEnv) {
  if (durableEnv) {
    const j = durableEnv.ok ? durableEnv.job : null;
    return j && typeof j.campaignId === "string" && j.campaignId ? j.campaignId : null;
  }
  const an = claudeCampaignAnchor();
  return an.ok ? an.campaignId : null;
}
function findingDispositionGate(ws, durableEnv, langSnap, campSnap) {
  const en = langSnap === "en";
  const camp = typeof campSnap === "string" && campSnap ? campSnap : campaignSnapFor(durableEnv);
  if (!camp) return { proceed: true, warn: "" };
  // 판독 실패=차단(4회차 확인 blocker — ab-3): 장부를 못 읽으면 '미판단 지적 0'으로 보일 뿐 실제로는 알 수 없다 — 경고만 내고 진행하면
  // 판독 오류가 이어지는 동안 통과 증명이 만들어진다. 검증을 시작하지 않고(왕복 미소모) 장부 파일 점검을 요구한다.
  const st = readFindingsLedgerState(ws);
  if (st.readError) {
    return { proceed: false, exitCode: 3, msg: en
      ? "⚠️ Verification NOT started (no round consumed) — the findings ledger could not be read (permission/lock), so open findings cannot be judged. Fix access to the ledger file, then retry.\n"
      : "⚠️ 검증을 시작하지 않았습니다(왕복 미소모) — 지적 장부를 읽지 못해(권한/잠금) 열린 지적 유무를 판정할 수 없습니다. 장부 파일 접근을 복구한 뒤 다시 시작하세요.\n" };
  }
  // 5회차 확인 blocker(ab-3): 관문 계산은 위에서 한 번 읽은 st.rows 스냅샷만 쓴다(장부 재판독 0회) — 첫 판독 성공 뒤 후속 판독이 실패해
  // '열린 지적 0'으로 위장되는 경합 차단. 계산 자체가 던지면 미발동이 아니라 차단(알 수 없음=시작 안 함).
  let und = [];
  try { und = undisposedOpenFindingsFromRows(st.rows, camp, readFrozenEnvelope(ws)); } catch {
    return { proceed: false, exitCode: 3, msg: en
      ? "⚠️ Verification NOT started (no round consumed) — the findings ledger could not be evaluated (unexpected ledger shape). Inspect the ledger file, then retry." + "\n"
      : "⚠️ 검증을 시작하지 않았습니다(왕복 미소모) — 지적 장부를 계산하지 못했습니다(예상 밖 장부 형태). 장부 파일을 점검한 뒤 다시 시작하세요." + "\n" };
  }
  if (!und.length) return { proceed: true, warn: "" };
  const rows = und.map((o) => `   - ${o.id} [${o.tag}] ${String(o.titleNorm || "").slice(0, 60)}`).join("\n");
  // 확인 검증 blocker② 반영: 관문이 본 캠페인 id를 명령에 그대로 결속 — 현재 캠페인 파일과 갈린 상태
  // (미집계 진행 등)에서 '관문은 막는데 해제 명령은 열린 지적 없음'인 교착 차단.
  const cmd = `   node codex-bridge.js finding-judge <id> <fix-fact|fix-gap|rebut[ --oos oos-n]|park|escalate> --note "..." --campaign "${camp}"   (제외 칸 전문: finding-judge --list-oos)`;
  return {
    proceed: false, exitCode: 3,
    msg: en
      ? `⚠️ Verification NOT started (no round consumed) — ${und.length} open finding(s) have no valid judgment for their latest appearance.\nJudge each one first (accepting everything is not the default — even blockers are subject to measured rebuttal; a finding re-raised after your judgment must be judged again):\n${rows}\n${cmd}\n   fix-fact = my output was proven factually wrong → I fix it (evidence note required)\n   fix-gap  = not wrong, but I accept the enrichment request → I fix it (reason note required)\n   rebut    = the finding is wrong → no fix (evidence note required)\n   park     = right, but outside this batch → auto-parked to the backlog\n   Status: node codex-bridge.js finding-judge --campaign "${camp}"`
      : `⚠️ 검증을 시작하지 않았습니다(왕복 미소모) — 열린 지적 ${und.length}건에 '마지막 등장 기준' 유효한 판단이 없습니다.\n먼저 하나씩 판단해 기록하세요(전부 수용이 기본값이 아닙니다 — blocker도 실측 반박 대상이고, 판단 뒤 재등장한 지적은 다시 판단해야 합니다):\n${rows}\n${cmd}\n   fix-fact = 내 산출물이 사실과 다름이 증명됨 → 고친다(근거 필수)\n   fix-gap  = 틀린 건 아니나 보강 요구를 받아들임 → 고친다(이유 필수)\n   rebut    = 지적이 틀렸다 → 고치지 않는다(근거 필수)\n   park     = 맞지만 이 묶음 밖 → 보관함 자동 등록\n   현황: node codex-bridge.js finding-judge --campaign "${camp}"`,
  };
}
function reserveVerifyBudgetGate(ws, durableEnv, contractSnap, harnessModeSnap, langSnap, profileSnap) {
  const job = durableEnv && durableEnv.ok ? durableEnv.job : null;
  // 슬롯·앵커 권위(⑸): 내구=job 동결값(생성 후 모드 변경이 CL-C job에 C-C 예산을 읽히는 혼합 차단), 직접=현재 스냅샷.
  const slotCC = job ? job.harnessMode === "codex-codex" : harnessModeSnap === "codex-codex";
  const M = slotCC ? contractSnap.codexVerifyBudget : contractSnap.verifyBudget; // 0=무제한 '요청' — 캠페인 동결값이 최종 권위(1차 B2)
  let campaignId = null, anchorReason = "";
  if (durableEnv) {
    if (job && typeof job.campaignId === "string" && job.campaignId) campaignId = job.campaignId; // 생성 시점 동결(⑵)
    else anchorReason = job ? "job-no-campaign" : "env-noncanonical"; // legacy job·비정본 env=미집계
  } else {
    const an = claudeCampaignAnchor(); // 직접 ask=실행 시점 1회 캡처
    if (an.ok) campaignId = an.campaignId; else anchorReason = an.reason;
  }
  let res;
  if (!campaignId) {
    // 앵커 실패: 유한 요청=미집계 가시화, 무제한 요청=침묵(예산 미사용자 무회귀 — 경고 소음 금지)
    res = (Number.isInteger(M) && M >= 1) ? { tracked: false, untracked: "anchor:" + anchorReason } : { unlimited: true };
  } else {
    // 1차 B2: 무제한 '요청'이어도 캠페인 동결 계약은 유지 — 진행 중 캠페인이 유한 예산으로 동결돼 있으면
    // 설정을 비워도 그 예산이 권위(거부 가능)고, 무제한(0)으로 시작한 캠페인은 유한 저장도 다음 캠페인부터.
    // 기록 순서·권위(⑸): 임계구역 안 ①next 계산·거부 판정 ②정본 영수증([내구] job patch/[직접] 로컬 예약)
    // 성공 시에만 ③counter. ②실패=예약 취소(미증가·untracked 진행), ③실패=budgetUntracked 승격+N/M 억제.
    const persist = job
      ? (n, m, cid) => patchAskJobFile(job.id, { campaignKey: cid, verifyRound: n, verifyBudget: m, budgetUntracked: false })
      : () => true; // [직접] 프로세스 로컬 불변 예약 — 반환 res(n/budget/campaignId)가 그 예약 객체(job 없음)
    res = reserveVerifyCampaign(ws, campaignId, Number.isInteger(M) && M >= 1 ? M : 0, persist);
    if (res && res.rejected) return { proceed: false, exitCode: 3, msg: budgetExhaustMsg(res.budget, langSnap, profileSnap) };
    if (res && res.counterFailedAfterReceipt) {
      // ③ 실패(counter·history): 미반영 N은 캠페인 서수가 아니므로 권위 주장 금지 — N/M 억제(실패 사유·동결 budget 보존).
      // 2d([보완]3): campaignId는 보존 — 통계 행이 캠페인 귀속을 잃지 않음(추적 상태와 분리 필드).
      res = { tracked: false, untracked: res.untracked || "counter-write-failed", budget: res.budget, campaignId };
    }
    // 침묵 판정(무회귀): 이 캠페인의 동결 budget이 무제한(0)이면 침묵 집계(요청 M과 무관 — 유한 저장도 다음
    // 캠페인부터), 미집계인데 유한 요청도 유한 동결도 아니면 무제한 동작으로 환원(경고 소음 0).
    if (res && res.tracked === true && res.budget === 0) res = Object.assign({}, res, { silent: true }); // 2d 재료용 침묵 집계
    else if (res && res.tracked !== true && res.unlimited !== true && !(Number.isInteger(M) && M >= 1) && !(res.budget >= 1)) res = { unlimited: true, campaignId }; // 2d: 무제한 환원도 캠페인 귀속 보존(출력 계약 불변 — unlimited면 안내 "")
  }
  // [내구] 미집계 가시화(⑵ — 앵커·영수증·counter·history 실패 전부): job.budgetUntracked=true 승격.
  // 이 patch마저 실패해도 미집계 1줄이 child 로컬 stdout·worker .out에 남는다(최후 fallback).
  if (job && res && res.tracked !== true && res.unlimited !== true) patchAskJobFile(job.id, { budgetUntracked: true });
  // 호출 진행 확정(⑶: tracked 성공 '또는' 가시화된 untracked 진행 결정·무제한) → phase/round 정확히 1회.
  // [회차 단일 원천 2026-08-30 — 사용자 실보고 "화면은 1/5인데 보고는 5/5"] 진행 파일의 round는 워커가 선별 단계에서 0으로 되돌리므로
  // '이전 값+1'은 매 판 1이 된다(장부와 다른 숫자를 두 곳에서 셈 — P10의 화면판). 화면 회차=캠페인 장부의 예약 서수(res.n)만 쓴다.
  // 미집계·무제한이면 서수 권위가 없으므로 종전처럼 '이전 값+1'(가시화용 진행 표시일 뿐 회차 권위 아님 — p12-budget 가시화 계약 유지).
  const roundShown = (res && res.tracked === true && Number.isFinite(Number(res.n))) ? Number(res.n) : ((readPhase(ws).round || 0) + 1);
  try { writePhase("codex-verifying", { round: roundShown, session: claudeId(), workspace: ws }); } catch { /* 진행표시 best-effort — [4a] 회차도 ws별 기록 기준(타 프로젝트 회차 승계 차단) */ }
  return { proceed: true, res };
}
// 포맷 계층(⑻) — formatForClaude 소비자 stdout 전용 안내(raw answer·proof·rollout 불변). 무제한·침묵·중간 왕복="".
// profile 분기(3차 blocker): v2.4 어휘는 core 전용 — integrity에는 프로필 중립 문구(처리 규약 혼입 금지).
function budgetNoticeLines(res, lang, profile) {
  if (!res || res.unlimited || res.silent) return "";
  const en = lang === "en";
  if (res.tracked) {
    let s = "";
    if (res.historyWarn) s += en
      ? `\n[verify round cap] ${res.historyWarn} campaign-history line(s) had unreadable timestamps — preserved, not trimmed; inspect verify-campaigns/<ws>.history.jsonl if this repeats.\n`
      : `\n[검증 왕복 상한] 캠페인 이력에서 시각 판독 불가 줄 ${res.historyWarn}건 — 삭제하지 않고 보존했습니다(반복되면 verify-campaigns 이력 파일 확인).\n`;
    if (res.quarantined) s += en
      ? "\n[verify round cap] The round counter was corrupt and was quarantined (original preserved in verify-campaigns/corrupt) — a new campaign started, and the cap was not applied to earlier rounds.\n"
      : "\n[검증 왕복 상한] 왕복 카운터가 손상돼 격리했습니다(원문은 verify-campaigns/corrupt에 보존) — 새 캠페인으로 시작하며, 이전 왕복에는 상한이 적용되지 않았습니다.\n";
    s += en
      ? `\n[verify round ${res.n}/${res.budget}] This is the round reserved immediately before the verifier model call. Pass ends the sequence; after fail or a later edit, finish this job first and then start the next round sequentially if capacity remains.\n`
      : `\n[검증 왕복 ${res.n}/${res.budget}] 검증 모델 호출 직전에 예약된 실제 회차입니다. 통과하면 종료하고, 실패하거나 이후 수정했다면 이 작업을 먼저 끝낸 뒤 여유가 있을 때 다음 회차를 순차적으로 시작하세요.\n`;
    if (res.last) s += en
      ? `\n[verify round cap ${res.n}/${res.budget}] This was the last reserved round. Re-judge its findings into accepted-and-handled, evidence-backed rebuttal, receipt-backed parking, or genuine user decision. Ask one combined question only for the last lane; otherwise close triage without inventing options. This is never a verification pass.\n`
      : `\n[검증 왕복 상한 ${res.n}/${res.budget}] 마지막 예약 왕복입니다. 이 판정의 지적을 수용·처리, 근거 있는 반박, 영수증 있는 보관함, 진짜 사용자 결정으로 나누세요. 마지막 갈래가 있을 때만 한 번에 묻고, 없으면 선택지를 만들지 말고 정리하세요. 어느 쪽도 검증 통과는 아닙니다.\n`;
    if (res.last) s += en
      ? "\n[cap closeout format] If this final verdict is not pass, one response must contain: [Verification cap closeout] [Accepted and handled] [Rebutted and closed] [Parked] [User decision required] [Residual risk call] [Alert meaning] [Recommendation]. Each latest finding belongs to exactly one of the first four sections; the residual risk call starts with Verify now / Next campaign / Ignorable.\n"
      : "\n[상한 마감 형식] 이 마지막 판정이 통과가 아니라면 한 응답에 다음 제목을 모두 넣으세요: [검증 상한 인계] [수용·처리] [반박·종결] [보관함 이관] [사용자 판단 필요] [잔여 위험 판단] [경고등 의미] [권장]. 마지막 지적마다 앞 네 절 중 정확히 한 곳만 배정하고, 잔여 위험 판단은 즉시 재검증/다음 캠페인 도장/무시 가능 셋 중 하나로 시작합니다.\n";
    return s;
  }
  const why = String(res.untracked || "unknown");
  return en
    ? `\n[verify round cap untracked] This round was not counted toward the cap (${why}) — the cap is enforced only while its bookkeeping is intact; N/M has no authority for this round.\n`
    : `\n[검증 왕복 상한 미집계] 이 왕복은 상한에 집계되지 않았습니다(${why}) — 상한은 내부 기록이 정상일 때만 기계적으로 강제되며, 이 왕복의 N/M은 권위가 없습니다.\n`;
}

// P-12 2c 기계 판독 계층(동결 v2~v5) — cmdAsk가 답 수신 직후 1회 실행(자연 1회: 내구 경로는 child가 1번 돌고
// ask-wait는 저장된 .out 재인쇄 → 반복 회수 바이트 동일·부작용 없음). core 프로필만(integrity·legacy=null 무회귀).
// 반환 {machine, notice}: machine=judgeMachineVerdict 결과(+parse) → formatForClaude 4번째 인자·flagVerdict 전달,
// notice=[백로그] 자동 장부 등록 영수증/거부/실패 줄(stdout 전용 — raw answer·proof·rollout 불변).
// 민감 방어(D-2): safeBacklogAutoTitle 거부 시 제목 원문을 장부·경고 어디에도 복사하지 않는다(순번·태그만).
// 증분 2: 계보 장부의 캠페인 결속 — 기존 캠페인 서랍(vcamp-1)의 식별자를 재사용(부재=no-campaign: 무제한
// 슬롯 등 캠페인 미예약 상태도 장부는 쌓인다 — 라운드 유형 유도·열린 지적은 같은 식별자 안에서만 유효).
function currentCampaignIdFor(ws) {
  try { const o = JSON.parse(fs.readFileSync(campaignFileFor(ws), "utf8")); if (o && typeof o === "object" && (o.campaignId || o.startedAt)) return String(o.campaignId || o.startedAt); } catch { /* 미예약 */ }
  return "no-campaign";
}
// 증분 2 §3.1: 경계 활성 시 v2 서식 요구+열린 지적 자동 동봉. 열린 목록은 하네스가 장부에서 직접 뽑아
// 주입한다(구현모델이 목록을 선별·누락해 기존 결함을 '신규'로 위장 분류시키는 경로 차단 — 설계 2차 blocker①).
// [개선 1-B] 캠페인·세대 안에서 구현자가 제외 n번으로 되받아쳐 닫은 지적 목록 — restores=그 계보에서 반증으로 복귀한 횟수(두 번째 복귀=분쟁)
function implementerRebuttalsFor(ws, camp, gen) {
  const rows = readFindingsLedger(ws).filter((r) => r && r.campaignId === camp && (r.envelopeHash || null) === (gen || null));
  const finding = new Map(); for (const r of rows) if (r.type === "finding") finding.set(r.findingId, r);
  const out = [];
  for (const r of rows) {
    if (r.type !== "close" || r.closeReason !== "implementer-oos") continue;
    let restores = 0, cur = r.findingId, guard = 0;
    while (cur && guard++ < 20) { const fr = finding.get(cur); if (!fr || fr.origin !== "boundary-contest" || fr.demoted) break; restores++; cur = fr.prevId || ""; }
    const fr0 = finding.get(r.findingId);
    out.push({ findingId: r.findingId, oosId: String(r.oosId || ""), title: fr0 ? fr0.titleNorm : "", restores });
  }
  return out;
}
// [§4-B ①] 지적 서식 절의 '고정 산문'(세션 1회 전달 대상) — 데이터(열린 지적·되받아침)는 v2DynamicData로 분리
// [§4-B ②] 전달 레코드 — 전문을 보내는 판이면 호출 '직전'에 pending으로 적고(호출 실패=미확정→다음 판 재전송), 답 수신 후
// postflight(보낸 시각 뒤 compacted 유무)로 확정한다. 판단은 검증자 자기신고가 아니라 브릿지 기록+rollout 실물.
// [§4-B ① Claude 쪽 · 개선 4 (d)] 판정 꼬리의 재판단 규약: 이 Claude 세션 앵커의 전달 기록(directive.parts.rejudge)이 동결 문안과 같은 지문이면
// 전문 대신 포인터 1줄(세대·전달 턴 시각). 압축·재개는 SessionStart 훅이 기록을 리셋하므로 그 뒤 첫 판정은 다시 전문. 판독 실패=전문(안전 방향).
function rejudgeTailFor(rejudgeSnap, lang) {
  try {
    const sid = claudeId(); if (!sid || !rejudgeSnap) return rejudgeSnap;
    const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, ""); if (!safe) return rejudgeSnap;
    const a = JSON.parse(fs.readFileSync(path.join(require("./contract-lib.js").ACTIVE_DIR, safe + ".json"), "utf8"));
    const d = a && a.directive; if (!d || !d.parts || typeof d.gen !== "string") return rejudgeSnap;
    const fp = crypto.createHash("sha1").update(String(rejudgeSnap)).digest("hex").slice(0, 16);
    if (d.parts.rejudge !== fp) return rejudgeSnap;
    return lang === "en"
      ? `gen ${d.gen.slice(0, 8)} — identical to the protocol delivered in this session's turn at ${d.sentAt} (same fingerprint); full text is in that turn's injected note or the dashboard base directive.`
      : `세대 ${d.gen.slice(0, 8)} — 이 세션 ${d.sentAt} 턴에 전달된 규약 문안 그대로(같은 지문). 전문은 그 턴 주입문 또는 대시보드 기본 지침.`;
  } catch { return rejudgeSnap; }
}
function recordDeliveryBeforeCall(session, carrier, callStartIso, rolloutFile, askId, ws) {
  const p = carrier && carrier.deliveryOut; if (!p || !session) return false;
  if (p.mode !== "full") return true;
  return writeDirectiveDelivery(session, { ws: String(ws || ""), gen: p.gen, parts: p.parts, sentAt: callStartIso, askId: String(askId || ""), rolloutFile: String(rolloutFile || ""), pending: true, reason: p.reason });
}
function postflightDelivery(session, carrier, callStartIso, rolloutFile) {
  const p = carrier && carrier.deliveryOut; if (!p || !session) return null;
  const rf = String(rolloutFile || "") || findRolloutById(session) || "";
  const rc = rolloutCompactedAfter(rf, callStartIso);
  const pf = { st: rc.st, compacted: rc.st === "ok" && rc.compacted === true, ts: rc.ts || null };
  carrier.postflight = pf;
  const prev = readDirectiveDelivery(session);
  if (rc.st === "ok" && !rc.compacted) {
    if (p.mode === "full") writeDirectiveDelivery(session, { ws: prev ? prev.ws : "", gen: p.gen, parts: p.parts, sentAt: callStartIso, askId: prev ? prev.askId : "", rolloutFile: rf, pending: false, reason: p.reason });
    else if (prev && !prev.rolloutFile && rf) writeDirectiveDelivery(session, { ...prev, rolloutFile: rf });
    return pf;
  }
  // 검증 도중 압축(또는 기록 판독 불가)=이 판의 전달을 미확정으로 — 다음 ask가 전문을 다시 보낸다(안전 방향)
  writeDirectiveDelivery(session, { ...(prev || { ws: "", gen: p.gen, parts: p.parts, sentAt: callStartIso, askId: "", reason: p.reason }), rolloutFile: rf, pending: true, pendingWhy: rc.st === "ok" ? "compacted-mid-ask" : "rollout-unreadable" });
  return pf;
}
// 검증 도중 압축이 잡힌 판정=권위 없음(보류) — 기존 '보류' 강등 경로 그대로(기계 판정 강등+판단 관문 마커: 구현자가 round-judge re-verify로 재판)
// 보류 조건=압축 감지 또는 판독 불가(압축 여부 미상) — 둘 다 '권위 없음'. 이 판의 통과 증명(proof)은 기록되지 않으므로(finishVerifyRun) 종료 훅이
// 재검증 전 종료를 막고, 판단 관문 마커는 re-verify/escalate로만 풀린다(close-oos 불가 — resolveJudgeRequired).
function postflightHeld(carrier) { const pf = carrier && carrier.postflight; return !!(pf && (pf.compacted === true || pf.st !== "ok")); }
function applyPostflightHold(mfl, carrier, ws, askId, camp, lang) {
  if (!postflightHeld(carrier)) return false;
  const pf = carrier.postflight; const en = lang === "en";
  const key = pf.compacted === true ? "compacted-mid-ask" : "postflight-unreadable";
  mfl.machine = Object.assign({}, mfl.machine || {}, { effective: "inconclusive", demoted: true, reasonKey: key });
  const okJ = askId ? addJudgeRequired(ws, { askId, campaignId: String(camp || ""), reason: key }) : false;
  const why = pf.compacted === true ? (en ? `verifier memory was compacted during this verification (${pf.ts})` : `검증 도중 검증자 기억 압축 감지(${pf.ts})`) : (en ? "verifier thread record unreadable after the call (compaction unknown)" : "답 수신 뒤 검증자 기록 판독 불가(압축 여부 미상)");
  mfl.notice = String(mfl.notice || "") + (en
    ? `\n[directive delivery · HOLD] ${why} — this verdict has no authority and NO success proof was recorded. The next ask resends the full directives; record your judgment first: node codex-bridge.js round-judge ${askId} re-verify --note "..." (close-oos is not accepted for this hold)${okJ ? "" : " (judgment gate NOT armed — marker write failed; the missing proof still blocks the turn)"}`
    : `\n[규약 전달 · 보류] ${why} — 이 판정은 권위 없음·통과 증명 미기록. 다음 검증에 규약 전문을 다시 보내 재판을 받는다 — 먼저 판단 기록: node codex-bridge.js round-judge ${askId} re-verify --note "근거" (이 보류는 close-oos로 닫을 수 없음)${okJ ? "" : " (판단 관문 미장전 — 마커 기록 실패·증명 미기록이 종료를 막음)"}`);
  return true;
}
function v2StaticDirective(lang) {
  const en = (lang || loadLang()) === "en";
  const L = [];
  L.push(en
    ? '[Finding format v2 — envelope active] Submit the machine block with the "[findings v2]" marker (at most 40 rows per round — the rest next round · fields beyond v1): "origin":"baseline|fix-induced|incomplete-fix|new-evidence|boundary-contest" (required on every blocker), "supported":true|false, an out-of-scope claim must cite "oosId":"oos-<n>" exactly, an invariant-breach blocker MUST cite "abId":"ab-<n>" (uncited = no exemption), a re-raised finding cites "id":"f-xxxxxxxx", an incomplete fix cites "prevId". Missing or invalid fields are treated as absent by the admission gate.'
    : '[지적 서식 v2 — 검증 경계 활성] 기계 판독 블록은 "[지적 목록 v2]" 마커로 제출하라(한 판 최대 40행 — 초과분은 다음 판 · v1 대비 추가 필드): "origin":"baseline|fix-induced|incomplete-fix|new-evidence|boundary-contest"(모든 blocker에 필수), "supported":true|false, 범위 밖 주장은 "oosId":"oos-<n>" 정확 인용, 불변식 침해 blocker는 "abId":"ab-<n>" 인용 필수(미인용=면제 없음), 재지적은 "id":"f-xxxxxxxx", 미완 수정은 "prevId" 인용. 누락·무효 형식은 입장 심사에서 미기재로 취급된다.');
  L.push(en
    ? '[Scope-expansion channel] A finding OUTSIDE the boundary that deserves reconsideration: submit "tag":"scope-expansion" with a mandatory "abId":"ab-<n>" and a concrete causal path. It is a non-blocking submission (never a failure reason by itself). If valid, the harness escalates it to an open blocker for the NEXT round (limit: once per campaign AND approval generation); invalid/uncited goes to [backlog]. Boundary revisions themselves remain user-only.'
    : '[범위 확장 통로] 경계 밖이지만 재검토가 필요한 중대 발견: "tag":"범위확장"으로 제출하되 "abId":"ab-<n>" 인용+구체 인과 경로 필수. 비차단 제출이다(그 자체로 실패 사유 아님). 유효하면 하네스가 다음 라운드의 열린 blocker로 승격한다(캠페인·승인 세대당 1회 상한). 무효·미인용=[백로그]. 경계 개정 자체는 사용자만 한다.');
  L.push(en
    ? '[MAP routing] If a Project MAP attachment is present: only slices marked fresh may inform boundary judgments; stale/unknown maps are advisory only — never a basis for supported/oosId claims.'
    : '[MAP 라우팅] Project MAP 동봉이 있는 경우: fresh 표시 조각만 경계 판정 참고 가능. stale·unknown 지도=참고 전용 — supported·oosId 주장 근거로 사용 금지.');
  return L.join("\n");
}
// [§4-B ④] 판단 재료(데이터) — 매 ask 실림(열린 지적=예산 밖·캠페인 유계)
function v2DynamicData(ws, lang) {
  const en = (lang || loadLang()) === "en";
  const L = [];
  try {
    // 2차 미완수정③④ 반영: 상한 제거=전 목록 주입(구현모델 의존 복귀 금지 — 프롬프트 비대는 제목 60자
    // 절단으로 완화·id는 전부 보존) / 세대 필터=이 ask의 동결 세대 open만(구세대 id 주입 금지).
    // ⚠ 여기에 개수 상한을 두면 안 된다. 자르는 순간 숨은 지적의 id를 인용할 수 없게 되고,
    // 규약상 '미인용=신규 취급'이라 그 지적의 이력이 끊긴다. 목록을 누가 고르느냐의 문제이기도 하다 —
    // '구현모델 선별 금지'가 이 자리의 계약이다(거버넌스 증분 2, 검증 7왕복). 비대는 제목 60자 절단으로만
    // 완화한다. 2026-07-30에 상한을 넣으려다 tests/verify-admission.test.js가 이 계약으로 막았다.
    const opens = openFindingsFor(ws, currentCampaignIdFor(ws), readFrozenEnvelope(ws));
    if (opens.length) {
      L.push(en ? "[Open findings — cite these ids when re-raising or reporting an incomplete fix (uncited = treated as new)]" : "[열린 지적 — 재지적·미완 수정 보고 시 이 id를 인용하라(미인용=신규 취급)]");
      for (const o of opens) L.push("> " + o.id + " [" + o.tag + "] " + String(o.titleNorm || "").slice(0, 60));
    }
    // [개선 1-B] 구현자가 제외 n번으로 되받아쳐 닫은 지적 — 검증자가 다시 올리려면 반증(contest) 필수. 규칙 문장은 이 목록의 머리줄에만
    // (되받아침이 있을 때만 실림 — 고정 산문 예산 밖·tests/verifier-head CAPS.v2Fixed 준수)
    const rb = implementerRebuttalsFor(ws, currentCampaignIdFor(ws), readFrozenEnvelope(ws));
    if (rb.length) {
      L.push(en ? '[Rebutted by the implementer as out-of-scope] Re-raise only with "origin":"boundary-contest" + "prevId" + "contest":"one line of evidence that the problem occurs INSIDE the approved boundary" (20-300 chars, single line) — otherwise it is demoted. Re-submitting the same title under a new id/origin is judged as the same finding.' : '[구현자 되받아침(범위 밖)] 다시 올리려면 "origin":"boundary-contest"+"prevId"+"contest":"승인 범위 안에서도 이 문제가 난다는 근거 한 줄"(20~300자·단일행) 필수 — 없으면 강등된다. 같은 제목을 새 id·다른 origin으로 올려도 같은 지적으로 심사한다.');
      for (const r of rb) L.push("> " + r.findingId + " ← " + r.oosId + (r.title ? " [" + String(r.title).slice(0, 60) + "]" : "") + (r.restores ? (en ? " (restored ×" + r.restores + ")" : " (복귀 " + r.restores + "회)") : ""));
    }
  } catch { /* 장부 판독 실패=목록 생략(서식 요구는 유지) */ }
  try { const rs = require("./contract-lib.js").reissueSectionFor(ws, currentCampaignIdFor(ws), lang || loadLang()); if (rs) L.push(rs); } catch { /* 재발급 절 실패=생략 */ } // [P6]
  return L.join("\n");
}
function v2DirectiveFor(ws, lang) { return [v2StaticDirective(lang), v2DynamicData(ws, lang)].filter(Boolean).join("\n"); } // 종전 바이트 그대로(무회귀)
// 증분 3(§4): 상한 소진(마지막 예약 왕복) 시 '구현이 놓쳤나 vs 검증이 올렸나'에 데이터로 답하는 원인 분해 1줄.
// demote 사유 구분: demoted+oosId=범위 밖 / demoted+oosId 없음=후속 이론(신규성·확인 라운드 심사).
// §7 수칙서 후보 재료(요구 동결 2026-07-24 — 구현 증분 1): 상한 소진(마지막 예약 왕복) 보고에 기계 재료를
// 병기하고, 구현모델에게 '수칙서 후보' 절 작성 의무(§8 표현 계약)를 지시한다. 후보 원천(①~③=기계):
// ①같은 oosId 강등 2회+ ②입장 심사 승격 범위확장(escalation) ③같은 계보(occurrence) 반복 2회+(원 등장 포함 3회).
// 재제시 스킵: 후보 장부에서 같은 (candidateId, 승인 세대)에 declined|failed → 목록에서 제외하고 스킵 수만 표기.
// 후보 0건=명시(침묵 생략 금지). ④(보류 항목)는 캐논 전용 재료 — 여기서 집계하지 않음(§7 명문).
// §7 증분 3 — 후보 집계 본체(분리: 소진 보고와 대시보드 후보 카드가 같은 산출을 공유). 반환
// { live, skipped, overCap } — live=[{candidateId, kind, key, n, titles}].
function computeEnvelopeCandidatesFor(ws) {
  const camp = currentCampaignIdFor(ws);
  const gen = readFrozenEnvelope(ws);
  const rows = readFindingsLedger(ws).filter((r) => r.campaignId === camp && (r.envelopeHash || null) === (gen || null));
  const titleOf = new Map();
  // 원문 무절단(2026-08-20 UX 검증 blocker②): 집계 단계 60자 절단은 식별 정보를 영구 소실시킴 —
  // 절단은 표시 지점(ask 재료 절)에서만. 원천 titleNorm은 기록 시 이미 유계.
  for (const r of rows) if (r.type === "finding" && r.findingId) titleOf.set(r.findingId, String(r.titleNorm || ""));
  // §7 증분 3(실전 첫 발동의 교훈 2026-07-24): '이미 해소된 계보'는 후보에서 제외 — 반복됐어도 이번 캠페인에서
  // 수정 완료된 지적은 "앞으로 지킬 약속" 후보가 아니다. open 판정=현 세대 열린 지적 목록.
  const openIds9 = new Set();
  try { for (const o of openFindingsFor(ws, camp, gen)) openIds9.add(o.id); } catch { /* 판독 실패=제외 없이 전체(보수) */ }
  const cands = [];
  // [재편 B §3-1b] 합성 신호(반복·기계 집계)는 권위 후보와 구조 분리 — 장부 처분·초안·판단 의무 밖의
  // 참고 표시 전용(f-3144cbc9). 아래 ①~④는 signals로만 산출된다.
  const signals = [];
  // 빼기 후보는 수칙서가 실제 정리 임계(30항목)에 닿았을 때만 의미가 있다. 작은 수칙서에서 단지
  // "아직 발동 안 됨"만으로 전 항목을 사용자 판단으로 올리면 사용하지 않은 소화기를 버리자고 매번 묻는 셈이다.
  let overCap = false, envForCleanup = null;
  try {
    const c9 = loadContract(ws), evv9 = readVerifyEnvelope(resolveScoutRepo(ws, c9).repo);
    if (evv9.st === "ok") {
      overCap = (evv9.data.supportedEnv.length + evv9.data.alwaysBlocker.length + evv9.data.outOfScope.length) >= 30;
      if (c9.envelopeHash === evv9.sha1 && (gen || null) === evv9.sha1) envForCleanup = evv9;
    }
  } catch { /* 판정 불가=false */ }
  { // ① oos 강등 반복(강등=닫힘이 정상이라 open 조건 비적용 — 반복 자체가 신호)
    const byOos = new Map();
    for (const r of rows) if (r.type === "finding" && r.demoted && r.oosId) { const a = byOos.get(r.oosId) || []; a.push(r); byOos.set(r.oosId, a); }
    for (const [oosId, list] of byOos) if (list.length >= 2) signals.push({ candidateId: envelopeCandidateId("oos-repeat", oosId), kind: "oos-repeat", key: oosId, n: list.length, titles: list.map((x) => titleOf.get(x.findingId) || x.titleNorm || "").filter(Boolean).slice(0, 3) });
  }
  { // ② 입장 심사 승격 범위확장(기계 승격 — 사용자 승인 아님·§2 승인과 구분)·해소됐으면 제외
    for (const r of rows) if (r.type === "escalation" && r.findingId && openIds9.has(r.findingId)) signals.push({ candidateId: envelopeCandidateId("escalation", r.findingId), kind: "escalation", key: r.findingId, n: 1, titles: [titleOf.get(r.findingId) || ""].filter(Boolean) });
  }
  { // ③ 같은 계보 반복(occurrence — 원 등장 포함 3회+)·effectiveTag가 blocker인 재등장만·**고유 라운드 수**로
    // 집계(재검증 blocker② — 같은 라운드 중복 레코드를 별도 반복으로 세는 조기 후보 차단·기록 측 억제와 이중 방어)·
    // 해소된(open 아님) 계보=제외(증분 3).
    const byF = new Map();
    for (const r of rows) if (r.type === "occurrence" && r.findingId && r.effectiveTag === "blocker") { const st9 = byF.get(r.findingId) || new Set(); st9.add(r.round); byF.set(r.findingId, st9); }
    for (const [fid, st9] of byF) if (st9.size >= 2 && openIds9.has(fid)) signals.push({ candidateId: envelopeCandidateId("lineage", fid), kind: "lineage", key: fid, n: st9.size + 1, titles: [titleOf.get(fid) || ""].filter(Boolean) });
  }
  if (overCap && envForCleanup) { // ④ 빼기 후보(§7 성장 억제 — 30항목 이상일 때만, 현 승인 세대 '전체'에서 한 번도 발동 안 한 범위-밖 항목): 세대 전 캠페인의
    // finding에서 oosId 인용이 0회인 oos-N=빼기/병합 검토 재료. 항상-차단(ab)은 발동 데이터가 심사 면제 축이라
    // 미인용=미발동으로 단정할 수 없어 제외(정직 한정 — 캐논 재료로만).
    try {
      const usedOos = new Set(readFindingsLedger(ws).filter((r) => r.type === "finding" && (r.envelopeHash || null) === (gen || null) && r.oosId).map((r) => r.oosId));
      envForCleanup.data.outOfScope.forEach((txt, i) => { const id9 = "oos-" + (i + 1); if (!usedOos.has(id9)) signals.push({ candidateId: envelopeCandidateId("unused-oos", id9 + "@" + envForCleanup.sha1), kind: "unused-oos", key: id9, n: 0, titles: [String(txt)] }); }); // 무절단(수칙서 항목은 승인 절삭 규칙상 이미 200자 유계)
    } catch { /* 원본 판독 실패=빼기 후보 생략(추가 후보는 유지) */ }
  }
  const { rows: candRows9, latest } = readEnvelopeCandidates(ws);
  // [재편 B 실보고 2026-08-28] adopted는 "진행 중 초안에 결속된 것"만 화면에 — 도장 완료(문안 등재)·고아 adopted가
  // "처리 중" 줄로 남아 승인 버튼 없는 문구만 보이던 혼란 봉합. 초안 부재·손상=adopted 전부 숨김(보수).
  let bound5 = new Set(); let unmarked5 = 0; // [ab-1] 저장소 표식 없는 대기 행(숨김 건수 — 고지용)
  let repoKey5 = null; try { const c5r = loadContract(ws); repoKey5 = repoKeyOf(resolveScoutRepo(ws, c5r).repo); } catch { repoKey5 = null; } // [ab-1] 현재 정찰 대상 파티션
  try { const c5 = loadContract(ws); const pr5 = readEnvelopeProposal(ws, resolveScoutRepo(ws, c5).repo); if (pr5 && pr5.st === "ok") bound5 = new Set([pr5.candidateId, ...(pr5.candidateIds || [])].filter(Boolean)); } catch { bound5 = new Set(); }
  { // ⑤ [기억 권위 A·구현검증 1차 blocker④] 해소 blocker 계보 후보(조정 스캔이 장부에 proposed로 적재) —
    // 계산기 산출에 합류해야 대시보드 목록·채택 표면에 나타난다(장부 단독 적재=화면 미표시 공백 봉합).
    // kind·title은 append-only 이력 전체에서 보강 — 상태 전이 행(adopted/declined)이 메타를 안 실어도 유실되지 않게.
    const meta5 = new Map();
    for (const r of candRows9) if (r && r.candidateId && (r.kind || r.title) && !meta5.has(r.candidateId)) meta5.set(r.candidateId, { kind: r.kind || "", title: r.title || "", findingId: r.findingId || "", why: r.why || "", repoKey: r.repoKey || "", operation: r.operation || "", target: r.target || "", explain: r.explain && typeof r.explain === "object" ? r.explain : null }); // operation/target/explain=curator 표면 필드(초안 뒤 최소 adopted 행에서도 유지 — CURATION 1회차 blocker⑥)
    const seen5 = new Set(cands.map((c) => c.candidateId));
    for (const [, rec] of latest) {
      const m5 = meta5.get(rec && rec.candidateId) || {};
      const k5 = (rec && rec.kind) || m5.kind || "";
      // [부품 C §3-1] 합류 allowlist=draftable kinds 공통 — user-constraint(약속 발화 상신)도 같은 dedupe·
      // live 필터로 대시보드 목록·채택 표면에 나타난다(장부 단독 적재=화면 미표시 공백의 kind 확장).
      if (!rec || !ENVELOPE_DRAFTABLE_KINDS.includes(k5) || String(rec.envelopeHash || "") !== String(gen || "")) continue;
      if (rec.status !== "proposed" && rec.status !== "adopted") continue; // declined/failed는 아래 live 필터와 동일 취급
      if (rec.status === "adopted" && !bound5.has(rec.candidateId)) continue; // 결속 초안 없는 adopted=등재 완료/고아 — 표시 안 함
      { const rk5 = rec.repoKey || m5.repoKey || ""; if (!rk5) { unmarked5++; continue; } if (!repoKey5 || rk5 !== repoKey5) continue; } // [ab-1] fail-closed: 무표기(판정 불가)·현재 대상 판독 불가·다른 저장소 태생=합류 안 함
      if (seen5.has(rec.candidateId)) continue;
      seen5.add(rec.candidateId);
      cands.push({ candidateId: rec.candidateId, kind: k5, key: rec.findingId || m5.findingId || "", n: 1, titles: [String(rec.title || m5.title || "")].filter(Boolean), ts: String(rec.ts || ""), ...(k5 === "user-constraint" || k5 === "rule-manual" || k5 === "user-direct" || k5 === "curator" ? { why: String(rec.why || m5.why || "") } : {}), ...(k5 === "curator" ? { operation: String(rec.operation || m5.operation || ""), target: String(rec.target || m5.target || ""), explain: rec.explain || m5.explain || null } : {}) }); // ts=제안 시각·why=상신 근거(사람 표면 보조 줄 — rule-manual도 '왜 관통 지침인지' 동봉·재편 A §2-2)
    }
  }
  let skipped = 0;
  const live = cands.filter((c) => {
    const cur = latest.get(c.candidateId + "@" + String(gen || ""));
    if (cur && (cur.status === "declined" || cur.status === "failed")) { skipped++; return false; }
    return true;
  });
  // [재편 B §3-1b] signals에는 장부 처분 필터를 적용하지 않는다 — 참고는 처분 상태가 없다(신호가 살아
  // 있으면 표시·소멸하면 사라짐). 과거에 기록된 합성 처분 행은 판독에서 무시되어 자연 무효.
  return { live, signals, skipped, overCap, unmarked: unmarked5, gen: gen || null }; // gen=산출 세대(동결) — 소비자(대시보드)는 이 값과 현 승인 해시의 일치를 결속해야 함(증분 3 재검증 blocker)
}
function envelopeCandidateNoticeFor(ws, lang, res, profile = "core") {
  try {
    if (profile !== "core") return ""; // integrity 검증에는 core 전용 수칙서 후보·입장 심사 어휘를 붙이지 않는다.
    if (!res || !res.tracked || !res.last) return "";
    const en = lang === "en";
    const { live, signals, skipped, overCap, unmarked } = computeEnvelopeCandidatesFor(ws);
    const kindLabel = (k) => en
      ? (k === "curator" ? "curation proposal (independent run — approve/decline)" : k === "oos-repeat" ? "repeated out-of-scope demotions — reconsider defending this scenario" : k === "escalation" ? "admission-escalated scope expansion — consider formal adoption" : k === "unused-oos" ? "never triggered this approval generation — consider removing/merging" : k === "user-constraint" ? "a promise the user stated directly in chat (no verification lineage) — consider adopting into the rulebook" : k === "resolved-blocker" ? "a blocker caught and fixed in verification — consider an always-block entry" : "repeated blocker lineage — consider an always-block entry")
      : (k === "curator" ? "정리 제안(독립 실행 — 승인/안 올림)" : k === "oos-repeat" ? "범위 밖 강등 반복 — 이 시나리오를 계속 치워둘지 재검토" : k === "escalation" ? "입장 심사 승격 확장 — 정식 편입 검토" : k === "unused-oos" ? "이 승인 세대에서 한 번도 발동 안 됨 — 빼기/병합 검토" : k === "user-constraint" ? "사용자가 대화에서 직접 말한 약속(검증 계보 아님) — 수칙서 편입 검토" : k === "resolved-blocker" ? "검증에서 잡혀 이미 고친 blocker — 항상 차단 명시 검토" : "같은 계보 blocker 반복 — 항상 차단 명시 검토"); // [주의 수용] user-constraint를 반복 blocker로 오표시하면 미검증 발화에 검증 계보가 있다고 오인시킴
    const L = [];
    L.push(en ? "\n[rulebook candidates · this campaign — machine material]" : "\n[수칙서 후보 재료 · 이번 캠페인 — 기계 집계]");
    if (unmarked) L.push(en ? `> ${unmarked} older proposal(s) without a repository mark are hidden from display/approval (cleaned at the next reconcile — re-enter if still needed).` : `> 저장소 표식 없는 이전 제안 ${unmarked}건은 표시·승인 대상에서 제외(다음 조정 때 자동 정리 — 필요하면 다시 넣기).`);
    if (overCap) L.push(en ? "> ⚠ the rulebook already holds 30+ items — prioritize removal/merge candidates over additions (§7 growth control)." : "> ⚠ 수칙서가 이미 30항목 이상 — 추가보다 빼기/병합 후보를 우선하라(§7 성장 억제).");
    if (!live.length) L.push(en ? "> no machine-aggregated candidate from this exhaustion. Any item parked by the implementer must still carry its real receipt in [Parked]." + (skipped ? ` (${skipped} previously declined/failed candidate(s) skipped this generation)` : "") : "> 이번 소진의 기계 집계로는 수칙서로 올릴 후보가 없습니다. 구현 담당이 보류한 항목은 [보관함 이관]에 실제 영수증과 별도로 밝혀야 합니다." + (skipped ? ` (이 승인 세대에서 이미 거절·실패한 후보 ${skipped}건 스킵)` : ""));
    else {
      for (const c of live) L.push(`> ${c.candidateId} [${c.kind} ×${c.n}] ${kindLabel(c.kind)}${c.titles.length ? " — " + c.titles.map((t9) => String(t9).slice(0, 60)).join(" / ") : ""}`); // 절단은 이 표시 지점만(집계는 무절단 — 대시보드 원문 보존)
      if (skipped) L.push(en ? `> (${skipped} previously declined/failed candidate(s) skipped this generation)` : `> (이 승인 세대에서 이미 거절·실패한 후보 ${skipped}건 스킵)`);
      L.push(en
        ? "[duty] Write a 'rulebook candidates' section in the exhaustion report from the material above, per the global presentation contract (§8): no jargon · a concrete situation example per candidate · what changes if adopted / what stays if not · one-line recommendation with grounds · include a draft clause the user can approve as-is. Selection is confirmed via chat reply (a dashboard click may only record a selection); adoption still requires the user's stamp. Record outcomes with: adoption via `envelope-candidate draft <id>` (draft-bound; direct mark adopted is refused for these kinds), decline/failure via `envelope-candidate mark <id> <declined|failed>`."
        : "[의무] 위 재료로 소진 보고에 '수칙서 후보' 절을 §8 전역 표현 계약대로 작성하라: 기술용어 금지 · 후보마다 상황예시 · 채택 시 달라지는 것/미채택 시 유지되는 것 · 권장+근거 1줄 · 사용자가 '이대로 올려'만 하면 되는 문안 초안 포함. 선택 확정=대화 응답(대시보드 클릭은 선택 기록까지만) · 채택돼도 효력은 사용자 도장부터. 결과 기록: 채택은 `envelope-candidate draft <id>`(초안 결속 — 이 후보들은 mark adopted 직접 기록이 거부됨)·안 올림/실패는 `envelope-candidate mark <id> <declined|failed>`.");
    }
    if (signals && signals.length) L.push(en ? `> [reference signals - not decisions] ${signals.length} repetition signal(s): ` + signals.map((s) => s.kind + "×" + s.n).join(", ") + " (no ledger disposition - promote only via rule-propose at campaign closing)" : `> [참고 신호 — 판단 대상 아님] 반복 신호 ${signals.length}건: ` + signals.map((s) => s.kind + "×" + s.n).join(", ") + " (장부 처분 없음 — 지침 승격은 마감 rule-propose로만)");
    return L.join("\n") + "\n";
  } catch { return ""; } // 재료 산출 실패가 판정 전달을 막지 않음
}
function breakdownNoticeFor(ws, lang, res) {
  try {
    if (!res || !res.tracked || !res.last) return "";
    const en = lang === "en";
    const camp = currentCampaignIdFor(ws);
    const gen = readFrozenEnvelope(ws);
    const rows9 = readFindingsLedger(ws);
    const fs9 = rows9.filter((r) => r.type === "finding" && r.campaignId === camp && (r.envelopeHash || null) === (gen || null));
    if (!fs9.length) return "";
    // 증분 3 1차 blocker② 반영: 승격 유래 finding은 escalation 축에만 — 초기/유발 축과 중복 집계 금지(원인 오보 차단)
    const escIds9 = new Set(rows9.filter((r) => r.type === "escalation" && r.campaignId === camp && (r.envelopeHash || null) === (gen || null)).map((r) => r.findingId));
    let base9 = 0, fixi = 0, oos9 = 0, theory = 0;
    for (const f of fs9) {
      if (escIds9.has(f.findingId) || f.expansion) continue; // 확장 유래(승격·상한 소진 주의)=초기/유발 축 제외
      if (f.demoted) { if (f.oosId) oos9++; else theory++; continue; }
      if (f.origin === "fix-induced") fixi++; else base9++;
    }
    const esc9 = escIds9.size;
    return en
      ? `\n[cause breakdown · this campaign] initial defects ${base9} · fix-induced ${fixi} · out-of-scope demoted ${oos9} · late-theory demoted ${theory} · scope-expansions ${esc9}\n`
      : `\n[원인 분해 · 이번 캠페인] 초기 결함 ${base9} · 수정 유발 ${fixi} · 범위 밖 강등 ${oos9} · 후속 이론 강등 ${theory} · 범위 확장 ${esc9}\n`;
  } catch { return ""; }
}
// 증분 3(§4·프로필 공통 결정): 무결성 검증 결과에 '경계 재심 재료' 병기 — 치워둔(강등) 지적을 oos 항목별로
// 집계해 재검토 판단 재료로 제공(자동 개정 아님 — 개정은 사용자만). 강등 0건·경계 비활성="".
function integrityReviewLine(ws, lang, profile) {
  try {
    if (profile !== "integrity") return "";
    const en = lang === "en";
    const gen = readFrozenEnvelope(ws);
    if (!gen) return "";
    const camp = currentCampaignIdFor(ws);
    const cnt = new Map();
    for (const r of readFindingsLedger(ws)) {
      if (r.type !== "finding" || r.campaignId !== camp || !r.demoted || !r.oosId) continue;
      if ((r.envelopeHash || null) !== (gen || null)) continue; // 1차 [주의]① 반영: 세대 필터 — 재승인으로 의미가 바뀐 구세대 oos 번호를 신세대 집계에 합산 금지(개정 대상 오판 차단)
      cnt.set(r.oosId, (cnt.get(r.oosId) || 0) + 1);
    }
    if (!cnt.size) return "";
    const parts = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " ×" + v);
    return en
      ? "\n[boundary review material] findings demoted as out-of-scope this campaign: " + parts.join(" · ") + " — if any deserve defending now, request a boundary revision by item id (user approval required)\n"
      : "\n[경계 재심 재료] 이번 캠페인에서 범위 밖으로 치워진 지적: " + parts.join(" · ") + " — 이제는 방어할 가치가 있어 보이면 항목 번호로 경계 개정을 요청하세요(개정은 사용자 승인)\n";
  } catch { return ""; }
}
function machineFindingsLayer(answer, ws, langSnap, profileSnap, harnessModeSnap, askId, campSnap) {
  if (profileSnap !== "core") return { machine: null, notice: "" }; // 기계 판독 계약은 core 경로(무결성=문구 준수 감사 — 정본 §2.1 구현 한정)
  const en = langSnap === "en";
  const parse = parseFindingsBlock(answer);
  // 위치 결속(구현검증 1차 blocker①): 정합 판정은 '종료 마커 뒤의 판정 선언'에만 결속 — 블록 앞 본문의 옛 판정
  // 줄을 전체 재판독으로 재사용하지 않는다(tail 부재=no-verdict-line 강등). 블록 부재/손상은 어차피 그 사유로 강등.
  const verdict = parse.present && parse.ok ? extractVerdict(parse.tailVerdictLine || "") : extractVerdict(String(answer || ""));
  // [P6] 블록 손상=줄 좌표·사유 키를 ws 단위 파일에 남겨 다음 요청에 재발급 절로 자동 동봉(원문 비복사) · 정상 판독=지움
  try {
    if (parse.present && !parse.ok) require("./contract-lib.js").writeReissue(ws, { askId: String(askId || ""), campaignId: String(campSnap || ""), ts: new Date().toISOString(), ver: parse.ver, items: parse.corrupt.items });
    else if (parse.present && parse.ok) require("./contract-lib.js").clearReissue(ws);
  } catch { /* 기록 실패=다음 요청에 재발급 절 없음(경고 경로는 기존 손상 강등이 담당) */ }
  const machine = { ...judgeMachineVerdict(verdict, parse), parse };
  const out = [];
  // ── 증분 2(§3.2): 입장 심사+계보 장부 — 동결 경계(ask 시작 스냅샷) 기준 ─────────────────────────
  // 4차→5차 미완수정① 반영 — 동결 기록 실패의 최종 방어=후처리 자체 검증(벽시계 비교 폐기): 동결 레코드의
  // askId가 이 검증 잡 id와 '동등'할 때만 이 ask의 동결로 인정(시계 역행 무관). 불일치·부재=낡은 동결(이번
  // ask의 기록 실패·잔존)로 간주해 심사 미발동(fail-closed). askId가 없는 비표준 직접 경로는 심사 자체를
  // 발동하지 않는 방향으로 동일(동결 askId=null이어도 잡 askId가 없으면 대조 불능=미발동 — 내구 경로가 표준).
  let frozen = null;
  let staleFreezeNote = false;
  let frozenManifest = null, frozenBoundaryGen = null; // [v7 §2] 동결 합본·경계(legacy 동결=null)
  {
    const fz = readFrozenEnvelopeRec(ws);
    frozen = fz ? fz.hash : null;
    frozenManifest = fz && Array.isArray(fz.manifest) ? fz.manifest : null;
    frozenBoundaryGen = fz && typeof fz.boundaryGen === "string" ? fz.boundaryGen : null;
    if (fz && frozen) {
      // 6차 미완수정① 반영: 비교 기준=동결 기록자와 '같은 출처'(이 child 프로세스의 내구 잡 env) — 인자
      // askId는 L1-A 실행 표식용 랜덤 UUID라 잡 id와 다르다(라이브 실증: 정상 ask가 항상 미발동). env가
      // 없는 비내구 직접 경로=엄격 미발동(잔존 null-동결 미검출 창까지 제거 — 내구 경로가 표준).
      const envJid9 = typeof process.env.CODEX_BRIDGE_ASK_JOB_ID === "string" && process.env.CODEX_BRIDGE_ASK_JOB_ID ? process.env.CODEX_BRIDGE_ASK_JOB_ID : null;
      if (!envJid9 || !fz.askId || fz.askId !== envJid9) { frozen = null; frozenManifest = null; frozenBoundaryGen = null; staleFreezeNote = true; }
    }
  }
  // 캠페인 귀속(처분 관문 1차 blocker② 반영): 호출자(cmdAsk)가 관문·예산과 같은 산식으로 계산한 스냅을
  // 우선한다 — 여기서 캠페인 파일을 재판독하면 미집계 경로에서 지적이 다른 캠페인에 기록돼 관문이 못 본다.
  // 스냅 부재(직접 ask 앵커 실패 등)=기존 폴백 유지(정직 한계 — 그 경로는 관문도 미발동이라 결속 불일치 없음).
  const camp = typeof campSnap === "string" && campSnap ? campSnap : currentCampaignIdFor(ws);
  const bg9 = frozenBoundaryGen; // [v7 §2] 이번 판의 판정 경계(legacy 동결·askId 불일치=null → confirm은 envelopeHash 폴백)
  const roundType = deriveRoundType(ws, camp, frozen, bg9 || undefined); // 1차 blocker④+v7: 같은 동결 세대·같은 경계의 라운드만 confirm
  const roundNo = readFindingsLedger(ws).filter((r) => r.type === "round" && r.campaignId === camp && (r.envelopeHash || null) === (frozen || null)).length + 1;
  const blockShaped = parse.present && parse.ok && machine.reasonKey !== "no-verdict-line";
  if (staleFreezeNote) out.push(en ? "[envelope freeze is not bound to this verification job (freeze write likely failed or non-durable path) — admission disabled this round]" : "[경계 동결이 이 검증 잡에 결속되지 않음(동결 기록 실패·비내구 경로로 판단) — 이번 라운드 입장 심사 미발동]");
  let effItems = parse.findings; // 자동 등록 루프가 쓰는 '실효' 목록(강등 반영본)
  if (frozen && blockShaped && parse.ver === "v2") {
    // 동결 세대 재확인(§2.1 4차 blocker①): 후처리 시점 승인 해시≠동결이면 경계 참조(oosId·abId) 무시+경고
    let oosCount = null, abCount = null;
    try {
      const cNow = loadContract(ws, langSnap);
      const evNow = readVerifyEnvelope(resolveScoutRepo(ws, cNow).repo);
      // 1차 blocker②: 파일 세대+'현재 계약 도장'까지 동결과 일치해야 참조 유효(검증 중 재승인·철회=무시+경고)
      if (evNow.st === "ok" && evNow.sha1 === frozen && cNow.envelopeHash === frozen) { oosCount = evNow.data.outOfScope.length; abCount = frozenManifest ? frozenManifest.length : evNow.data.alwaysBlocker.length; } // [v7 §2] ab 범위 판독처=동결 합본 manifest(부재=legacy 코어 개수)
      else out.push(en ? "[envelope generation changed — oosId/abId references ignored this round]" : "[경계 세대 변경 — 이번 라운드의 경계 참조(oosId·abId)는 무시됨]");
    } catch { oosCount = null; abCount = null; }
    const openList = openFindingsFor(ws, camp, frozen); // 2차 미완수정④: 같은 동결 세대의 open만(구세대 id=재지적 인정 금지)
    const openIds = new Set(openList.map((o) => o.id));
    const rebutted9 = new Map(); // [개선 1-B] 되받아친 지적 → {oosId, restores}
    try { for (const r9 of implementerRebuttalsFor(ws, camp, frozen)) rebutted9.set(r9.findingId, { oosId: r9.oosId, restores: r9.restores, titleNorm: r9.title }); } catch { /* 장부 판독 실패=되받아침 없음으로 심사(강등 방향 아님·기존 규칙만) */ }
    const adm = judgeAdmission(parse.findings, roundType, openIds, oosCount, abCount, rebutted9);
    machine.admission = { kept: adm.keptBlockers, demoted: adm.demotedBlockers, roundType };
    effItems = adm.items;
    const RK = {
      "ab-exempt": en ? "invariant (abId) cited — exempt from demotion (truth judged in re-judgment)" : "불변식(abId) 지목 — 강등 면제(진위는 재판단 몫)",
      "lineage-bound": en ? "incomplete-fix — lineage bound (prevId verified)" : "미완 수정 — 계보 결속(prevId 확인)",
      "lineage-unproven": en ? "incomplete-fix kept — [lineage unproven] (prevId missing/unmatched)" : "미완 수정 — blocker 유지·[계보 미증명](prevId 부재/불일치)",
      "out-of-scope": en ? "out-of-scope (approved boundary) → demoted to [backlog]" : "범위 밖(승인 경계) → [백로그] 강등",
      "late-theory": en ? "late new blocker without qualifying origin (theory not raised in round 1) → [backlog]" : "후속 라운드 신규 blocker(자격 origin 없음 — 1차에 제출하지 않은 이론 강화) → [백로그] 강등",
      "confirm-scope": en ? "confirm-round new blocker not fix-induced → [backlog]" : "확인 라운드 신규 blocker(수정 유발 아님) → [백로그] 강등",
      "ab-invalid": en ? "abId cites an invalid index — exemption not applied (other rules evaluated)" : "abId가 무효 인덱스 — 면제 미발동(다른 규칙으로 계속 평가)",
      "expansion-candidate": en ? "scope-expansion with a valid abId — escalation candidate (once per campaign)" : "범위 확장 — 유효 abId 인용(승격 후보·캠페인당 1회)",
      "expansion-unproven": en ? "scope-expansion without a valid abId → [backlog]" : "범위 확장 — abId 무효/미인용 → [백로그] 강등",
      "contest-unproven": en ? "re-raised a rebutted finding without a valid contest line → [backlog]" : "되받아친 지적의 재소환 — 반증(contest 20~300자) 없음 → [백로그] 강등",
      "contest-restored": en ? "rebutted finding restored — contest evidence supplied (re-judge it)" : "되받아친 지적 복귀 — 반증 제시(다시 판단하라)",
      "contest-dispute": en ? "restored a second time in the same lineage — DISPUTE (judgment gate armed)" : "같은 계보에서 두 번째 복귀 — 분쟁(판단 관문 장전)",
    };
    for (const r of adm.receipts) out.push((en ? "[admission] finding #" + r.idx + ": " : "[입장 심사] " + r.idx + "번째 항목: ") + (RK[r.key] || r.key) + (r.detail ? " (" + r.detail + ")" : ""));
    // [개선 1-A] 판정 도착 자리의 되받아침 재료 — 이 판에 동결된 제외 칸 번호+한 줄 제목(≤200자·4-d 예산: 처리 안내·규약 절차문 축약으로 상쇄)
    try {
      // 확인 blocker②: 입장 심사가 이 잡에 결속했다고 확인한 동결(frozen≠null)만 재료로 쓴다 — stale 동결(askId 불일치)은 재료도 없음
      const fzO = frozen ? readFrozenEnvelopeRec(ws) : null;
      if (fzO && fzO.hash === frozen && Array.isArray(fzO.oos) && fzO.oos.length) {
        // 머리말 예산: 번호 전량 폴백이 축 상한 12칸(ENVELOPE_ITEM_MAX)에서도 200자 안에 들도록 머리말 ≤ 125자(12칸 번호 74자) — tests/rebuttal [3]이 ko/en 12칸 실측
        const head = en ? "[rebuttal material — out-of-scope items of this round · finding-judge <id> rebut --oos oos-n · finding-judge --list-oos] " : "[되받아침 재료 — 이 판의 제외 칸 · 되받아침: finding-judge <id> rebut --oos oos-n · 전문: finding-judge --list-oos] ";
        let line = head + fzO.oos.map((o) => o.id + " " + String(o.title || "").slice(0, 30)).join(" · ");
        // 예산 200(개선 전 꼬리 대비 규약 절차문·처리 안내 축약분 안 — tests/rebuttal [8]): 넘치면 제목을 버리고 번호 전량만(뒤 번호 소실 금지·전문은 --list-oos)
        if (line.length > 200) line = head + fzO.oos.map((o) => o.id).join("·");
        if (line.length > 200) line = line.slice(0, 197) + "…";
        out.push(line);
      }
    } catch { /* 재료 부재=생략 */ }
    // [개선 1-B] 분쟁(같은 계보 두 번째 복귀) — 사용자 결정 자동 생성 없음: 판단 관문 마커(구현자가 round-judge로 정함)
    try {
      for (const f of adm.items) {
        if (!f.dispute) continue;
        const okD = askId ? addJudgeRequired(ws, { askId, campaignId: String(camp || ""), reason: "dispute:" + String(f.contestOf || "") }) : false;
        out.push(okD
          ? (en ? "[dispute] " + (f.contestOf || "") + " restored twice — this turn cannot end until the implementer records a judgment: node codex-bridge.js round-judge " + askId + " <close-oos|re-verify|escalate --decision <id>> --note \"...\"" : "[분쟁] " + (f.contestOf || "") + " 계보가 두 번 복귀 — 구현자 판단이 기록되기 전에는 이 턴을 끝낼 수 없다: node codex-bridge.js round-judge " + askId + " <close-oos|re-verify|escalate --decision <id>> --note \"근거\"")
          : (en ? "[dispute] judgment gate NOT armed (marker write failed / no askId) — judge manually" : "[분쟁] 판단 관문 미장전(마커 기록 실패/askId 없음) — 수동으로 판단 기록"));
      }
    } catch { /* 관문 실패가 판정 전달을 막지 않음 */ }
    // 증분 3(§4): 범위 확장 승격 — 유효 후보(escalateCandidate)를 캠페인·세대당 1회 blocker로 승격해 '다음
    // 라운드'의 열린 지적으로 등록(이번 판정은 불변 — 기계는 판정을 만들지도 뒤집지도 않는다). 상한 소진=주의 기록.
    try {
      const escUsed = readFindingsLedger(ws).some((r9) => r9.type === "escalation" && r9.campaignId === camp && (r9.envelopeHash || null) === (frozen || null));
      let escSeq = 0;
      for (const f of adm.items) {
        if (!f.escalateCandidate) continue;
        escSeq++;
        const tnE = normBacklogTitle(f.title);
        if (!escUsed && escSeq === 1) {
          const fidE = newFindingId(camp, frozen, roundNo, tnE, "esc" + escSeq);
          appendFindingsLedger(ws, [
            { type: "escalation", campaignId: camp, round: roundNo, findingId: fidE, abId: f.abId || "", envelopeHash: frozen, ts: new Date().toISOString() },
            { type: "finding", findingId: fidE, campaignId: camp, round: roundNo, tag: "blocker", titleNorm: tnE, origin: "new-evidence", oosId: "", envelopeHash: frozen, ...(bg9 ? { boundaryGen: bg9 } : {}), demoted: false, status: "open", closeReason: "", ts: new Date().toISOString() },
          ]);
          out.push(en ? "[scope-expansion granted] " + fidE + " — escalated to an open blocker for the next round (once per campaign & approval generation; boundary revision itself stays user-only)" : "[범위 확장 승격] " + fidE + " — 다음 라운드부터 열린 blocker로 추적(캠페인·승인 세대당 1회·경계 개정 자체는 사용자만)");
        } else {
          appendFindingsLedger(ws, [{ type: "finding", findingId: newFindingId(camp, frozen, roundNo, tnE, "esc" + escSeq), campaignId: camp, round: roundNo, tag: "주의", titleNorm: tnE, origin: "new-evidence", oosId: "", envelopeHash: frozen, ...(bg9 ? { boundaryGen: bg9 } : {}), demoted: false, expansion: true, status: "open", closeReason: "", ts: new Date().toISOString() }]); // expansion 표식 — 원인 분해에서 초기/유발 축 오집계 금지
          out.push(en ? "[scope-expansion cap reached] recorded as [caution] — this campaign & approval generation's single escalation is already used" : "[범위 확장 상한 소진] 캠페인·승인 세대당 1회 승격이 이미 사용됨 — [주의]로 기록(재판단·사용자 보고 경로)");
        }
      }
    } catch { /* 승격 실패가 판정 전달을 막지 않음 */ }
    // §3.2 규칙 5(판정 반전 안전장치): 강등으로 blocker 0이 된 '실패'는 자동 통과가 아니라 정본 '보류'+선택지
    if (machine.effective === "fail" && adm.keptBlockers === 0 && adm.demotedBlockers > 0) {
      machine.effective = "inconclusive"; machine.demoted = true; machine.reasonKey = "scope-demoted";
      out.push(en
        ? "[admission] every remaining blocker was demoted as out-of-scope — verdict re-derived as HOLD. Choices: (1) accept as out-of-scope and close (2) request re-review"
        : "[입장 심사] 남은 blocker가 전부 범위 강등되어 판정을 '보류'로 재산출했습니다 — 선택지: ①범위 밖 수용(종결) ②재심 요청");
      // [개선 2 · 판단 관문 — 장치화 2026-08-30] 하네스는 여기서 사용자 결정을 '만들지 않는다'. 대신 마커를 걸어 종료 훅이 구현자 판단
      // (round-judge: 범위 밖 종결·재검증·escalate=결정 장부 항목 필수)이 기록되기 전에는 턴을 못 끝내게 한다 — 촉구 문장이 아니라 관문.
      out.push(armScopeDemotedJudge(ws, camp, askId, en));
    }
    // 장부 기록(§3.2): round 1건+finding(신규만·강등=즉시 closed)+close(통과 계열=round<N 개설분만·재분류)
    try {
      const now = new Date().toISOString();
      const recs = [{ type: "round", campaignId: camp, round: roundNo, roundType, verdict: machine.effective, envelopeHash: frozen, ...(bg9 ? { boundaryGen: bg9 } : {}), ts: now }]; // [v7 §2] 경계 표기 — confirm 판정의 유일 재료
      // §7 — 같은 라운드 같은 계보(뿌리)의 occurrence는 라운드당 1건 유지(중복 제출로 반복 후보 조기 생성
      // 차단)하되, 4회차 확인 blocker 반영: 그 1건에 인용된 자식 '전부'를 subjectIds로 모은다 — 루트 단위
      // 억제가 같은 라운드 두 번째 자식의 활동을 소거해 그 처분이 영구 유효해지는 우회 차단(실행 반례:
      // child1 activity=3·child2 activity=2·undisposed=[child1]). 반복 횟수 집계는 여전히 레코드 수=1.
      const occAgg = new Map(); // root → { rec, subjects:Set } — 루프 뒤 subjectIds 배열로 확정해 recs에 push
      const occAdd = (root9, subject9, rec9) => {
        let agg = occAgg.get(root9);
        if (!agg) { agg = { rec: rec9, subjects: new Set() }; occAgg.set(root9, agg); }
        agg.subjects.add(subject9);
      };
      // §7 재재검증(f-2344e4d8): 미완 수정이 '직전 자식'을 prevId로 인용하는 실제 사슬(root→child→grandchild)에서도
      // 뿌리로 수렴해야 집계가 모인다 — 이 세대 finding들의 prevId 사슬을 유계 순회(순환 방지)로 뿌리 정규화.
      const prevMap = new Map();
      const existIds = new Set(); // 이 세대에 finding으로 실존하는 id — 끊긴 사슬(실존하지 않는 prevId)로 전진 금지(3차 [보완])
      try { for (const r0 of readFindingsLedger(ws)) if (r0.type === "finding" && r0.campaignId === camp && (r0.envelopeHash || null) === (frozen || null) && r0.findingId) { existIds.add(r0.findingId); if (r0.prevId) prevMap.set(r0.findingId, r0.prevId); } } catch { /* 판독 실패=사슬 없음 취급 */ }
      const rootOf = (id0) => { const seen0 = new Set(); let cur0 = id0; while (prevMap.has(cur0) && existIds.has(prevMap.get(cur0)) && !seen0.has(cur0) && seen0.size < 50) { seen0.add(cur0); cur0 = prevMap.get(cur0); } return cur0; };
      let seq = 0;
      for (const f of effItems) {
        seq++;
        if (f.tag === "범위확장" && !f.demotedTo) continue; // 증분 3: 확장 요청의 장부 수명주기는 승격 블록 전담(승격 blocker/[주의]) — 일반 finding 이중 기록 금지
        const tn = normBacklogTitle(f.title);
        const cited = f.id && openIds.has(f.id) ? f.id : null; // 1차 blocker③: 제목 일치 폴백 제거 — '미인용=신규' 계약 그대로(동명 신규가 기존 지적을 침묵 종결시키는 경로 차단)
        // §7 재검증 blocker①: prevId만 인용된 미완 수정(새 id의 신규 finding)도 계보에 영속 — 뿌리 정규화:
        // prevId가 '열린' 지적이면 그 id를 계보 뿌리로 occurrence 기록(사슬 순회 없이 뿌리 기준 집계 가능).
        // prevId가 이미 닫힌 id면 occurrence 생략(finding.prevId 저장만 — 집계 한계는 정직 수용).
        const prevRoot = !cited && f.prevId && (openIds.has(f.prevId) || prevMap.has(f.prevId)) ? rootOf(f.prevId) : null;
        if (prevRoot && openIds.has(prevRoot)) occAdd(prevRoot, f.prevId, { type: "occurrence", campaignId: camp, findingId: prevRoot, prevId: f.prevId, subjectId: f.prevId, round: roundNo, envelopeHash: frozen, effectiveTag: f.demotedTo || f.tag, ts: now });
        if (cited) { // 재등장 — 새 레코드 없음. 종결은 ⓑ'태그가 실제로 바뀐' 재분류 ⓒ강등만(3차 신규 실행증거 반영:
          // 같은 태그 재제출을 reclassified로 닫으면 미해결 비차단이 계보에서 침묵 소멸 — f-63c42134 실증. 같은 태그=open 유지)
          // §7 occurrence(레코드 5유형째): 매 재등장을 계보로 영속 — 수칙서 후보 원천 ③("같은 계보 반복")의
          // 유일 재료. effectiveTag=당시 유효 딱지(보완 재분류 재등장을 반복 blocker로 오집계하지 않기 위함).
          // 같은 라운드에 같은 id가 중복 제출돼도 occurrence는 라운드당 1건(재검증 blocker② — 중복 제출로 3회 후보 조기 생성 차단).
          // subjectId=인용된 자식 그 자체(3회차 확인 blocker — prevId는 계보용이라 f.prevId가 있으면 cited가
          // 두 필드 모두에서 사라져 자식 처분이 영구 유효해짐. 인용 대상 축을 분리 보존해 활동 집계에 잡는다).
          { const root9 = rootOf(cited); occAdd(root9, cited, { type: "occurrence", campaignId: camp, findingId: root9, prevId: f.prevId || cited, subjectId: cited, round: roundNo, envelopeHash: frozen, effectiveTag: f.demotedTo || f.tag, ts: now }); }
          const prevTag = (openList.find((o) => o.id === cited) || {}).tag;
          if (f.demotedTo) recs.push({ type: "close", campaignId: camp, findingId: cited, closeReason: "demoted", round: roundNo, envelopeHash: frozen, ts: now });
          else if (f.tag !== prevTag) recs.push({ type: "close", campaignId: camp, findingId: cited, closeReason: "reclassified", round: roundNo, envelopeHash: frozen, ts: now });
          continue;
        }
        // [기억 권위 A-2] title=표시용 원문(절단 시 표식) — 후보 공급의 문안 원천(자동 작문 금지 계약). 구행(title 부재)은 조정 스캔이 legacy-unbound로 제외.
        const rawT9 = String(f.title || "");
        recs.push({ type: "finding", findingId: newFindingId(camp, frozen, roundNo, tn, seq), campaignId: camp, round: roundNo, tag: f.demotedTo || f.tag, titleNorm: tn, title: rawT9.length > 300 ? rawT9.slice(0, 300) + "…[절단]" : rawT9, origin: f.origin || "", oosId: f.oosId || "", prevId: f.prevId || "", envelopeHash: frozen, ...(bg9 ? { boundaryGen: bg9 } : {}), demoted: !!f.demotedTo, status: f.demotedTo ? "closed" : "open", closeReason: f.demotedTo ? "demoted" : "", ts: now });
      }
      // 루트당 1건 확정 — subjectIds=이 라운드에 인용된 자식 전체(중복 제거). subjectId(첫 자식)는 하위 호환 유지.
      for (const [, agg] of occAgg) { agg.rec.subjectIds = [...agg.subjects]; recs.push(agg.rec); }
      if (machine.effective === "pass" || machine.effective === "pass-notes") {
        for (const o of openList) if (o.round < roundNo) recs.push({ type: "close", campaignId: camp, findingId: o.id, closeReason: "resolved", round: roundNo, envelopeHash: frozen, askId: askId || "", ts: now }); // 같은 라운드 첫 등장은 open 유지(4차 설계 blocker②)·close도 세대 결속(3차 미완수정②) · [기억 권위 A-2] 마감 askId 결속(후보 근거)
      }
      appendFindingsLedger(ws, recs);
      // [경위 v2 수확기 배선] 해소 마감 직후 — 자격(최신 처분 fix-fact+dispositionValid+close.round
      // 게이트+sourceRefs)은 수확기가 판정. advisory(실패가 판정 경로를 막지 않음).
      try {
        const MPV9 = require(path.join(__dirname, "map-provenance.js"));
        // R2 blocker⑤: 수확 대상 저장소는 수확기가 '사건(처분)에 저장된 repoPath·repoKey'로 결정 —
        // 여기서는 현재 대상을 폴백으로만 전달(사건에 저장소 기록이 없는 구행 호환).
        const repo9 = (resolveScoutRepo(ws, loadContract(ws)) || {}).repo || ws;
        for (const r9 of recs) if (r9.type === "close" && r9.closeReason === "resolved") MPV9.harvestFromResolvedFinding(ws, repo9, camp, r9.findingId);
      } catch { /* 수확은 참고 계층 — 실패 무해 */ }
    } catch { /* 장부 실패가 판정 전달을 막지 않음 */ }
  } else if (frozen && blockShaped && parse.ver === "v1") {
    out.push(en ? "[admission not applied — v1 response (the directive requested v2); recorded for statistics]" : "[입장 심사 미적용 — v1 응답(지시문은 v2 요구) · 통계 기록]"); // 활성 행렬 fail-open
    try { appendFindingsLedger(ws, [{ type: "round", campaignId: camp, round: roundNo, roundType, verdict: machine.effective, envelopeHash: frozen, ...(bg9 ? { boundaryGen: bg9 } : {}), v1: true, ts: new Date().toISOString() }]); } catch { /* 무해 */ }
  } else if (frozen && !blockShaped) {
    // 판정 추출 실패·블록 손상도 회차 소비 기록(verdict:"error" — 다음 라운드 유형은 fix-verify 유도·4차 설계 보완)
    try { appendFindingsLedger(ws, [{ type: "round", campaignId: camp, round: roundNo, roundType, verdict: "error", envelopeHash: frozen, ...(bg9 ? { boundaryGen: bg9 } : {}), ts: new Date().toISOString() }]); } catch { /* 무해 */ }
  } else if (!frozen && blockShaped && parse.ver === "v2") {
    // 경계 비활성+v2=신필드 파싱·장부 기록만(활성 행렬 — 강등 없음·통계 축적)
    try {
      const now = new Date().toISOString();
      const recs = [{ type: "round", campaignId: camp, round: roundNo, roundType, verdict: machine.effective, envelopeHash: null, ts: now }];
      let seq = 0;
      for (const f of parse.findings) { seq++; const tn = normBacklogTitle(f.title); recs.push({ type: "finding", findingId: newFindingId(camp, null, roundNo, tn, seq), campaignId: camp, round: roundNo, tag: f.tag, titleNorm: tn, origin: f.origin || "", oosId: "", envelopeHash: null, demoted: false, status: "open", closeReason: "", ts: now }); }
      appendFindingsLedger(ws, recs);
    } catch { /* 무해 */ }
  }
  // ── 기존 2c: [백로그] 자동 등록 — 강등분(demotedTo=백로그)도 같은 경로(강등된 지적도 보관함·통계에 남김 §3.3) ──
  if (blockShaped) {
    let idx = 0;
    for (const f of effItems) {
      idx++;
      const effTag = f.demotedTo || f.tag;
      if (effTag !== "백로그") continue; // 자동 등록은 [백로그]만(동결 D-1 — [주의]는 재판단 후 승격 시 수동)
      // 민감 방어(동결 D-2+2차 blocker③): 제목=전체 규칙, file=비경로 비밀형(토큰·이메일·제어) — 거부 시 원문 비복사(순번·태그·사유 키만).
      const safe = safeBacklogAutoTitle(f.title);
      const safeF = safe.ok ? safeBacklogAutoFile(f.file) : safe;
      if (!safe.ok || !safeF.ok) {
        const why = safe.ok ? (en ? `possibly sensitive file (${safeF.reasonKey})` : `민감 가능 file(${safeF.reasonKey})`) : (en ? `possibly sensitive title (${safe.reasonKey})` : `민감 가능 제목(${safe.reasonKey})`);
        out.push(en
          ? `[ledger auto-record refused] finding #${idx} [backlog]: ${why} — generalize it and register manually: node "${__filename}" backlog add --tag 백로그 --title "<generalized title>"`
          : `[장부 자동 등록 거부] ${idx}번째 [백로그] 항목: ${why} — 일반화해 수동 등록: node "${__filename}" backlog add --tag 백로그 --title "<일반화한 제목>"`);
        continue;
      }
      let r = null;
      try { r = backlogAdd(ws, { tag: "백로그", title: f.title, file: f.file || undefined, lang: langSnap, mode: harnessModeSnap, profile: profileSnap, source: askId ? String(askId) : "machine-2c" }); } catch { r = null; } // source=askId(동결 D — 검증 실행 귀속)
      if (r && r.ok) out.push(en
        ? `[ledger auto-record] ${r.id}${r.existed ? " (re-seen)" : ""}${f.demotedTo ? " (demoted)" : ""} — cite this id in your report`
        : `[장부 자동 등록] ${r.id}${r.existed ? " (재발견)" : ""}${f.demotedTo ? " (강등분)" : ""} — 이 id를 보고에 인용하세요`);
      else {
        const ek = r && typeof r.error === "string" && /^[a-z0-9-]{1,32}$/.test(r.error) ? r.error : "write-refused";
        out.push(en
          ? `[ledger auto-record failed] finding #${idx} [backlog] (${ek}) — register manually: node "${__filename}" backlog add --tag 백로그 --title "<title>"`
          : `[장부 자동 등록 실패] ${idx}번째 [백로그] 항목(${ek}) — 수동 등록: node "${__filename}" backlog add --tag 백로그 --title "<제목>"`);
      }
    }
  }
  return { machine, notice: out.length ? "\n" + out.join("\n") + "\n" : "" };
}

async function cmdAsk(rest) {
  const forceNew = rest.includes("--force-new"); // 엉뚱 폴더 방어를 무릅쓰고 '이 폴더'에 새 세션 강제
  const allowNew = rest.includes("--allow-new") || forceNew;
  const net = rest.includes("--net"); // 이 1회만 네트워크 허용(파일 읽기전용 유지) — netArgs 주석 참조
  const forceResend = rest.includes("--force-resend"); // 중복 전송 차단(아래 가드)을 의식적으로 우회
  const prompt = askRequest(rest).prompt;
  if (!prompt) die('사용법: ask "<프롬프트>"', 2);
  warnAskShape(prompt, "ask"); // 주입 구조화 3단계 — 직접 경로도 같은 기준(경고 단계)

  try { maybeCleanupState(); } catch { /* 오래된 상태파일 정리 best-effort(Stop 훅 미설치 환경 대비) — 하루 1회 */ }
  requireLinksWritable(); // P-1: 손상 links 상태로 진행하면 링크·autoNewFailed 기록이 반복 실패해 새 세션 폭증 — spawn 전 중단
  // configWs/execCwd 분리: 설정 기준(계약·생각강도·링크·proof·이벤트 라벨)은 '연 폴더'(ws), 코덱스 실행·새세션 탐지·인용
  // 근거 경로 해석은 '작업 폴더'(exec=실제 실행 cwd). 사용자가 연 폴더에 건 설정이 외부 폴더 작업에도 일관 적용되게 한다.
  const ws = configWs();        // 연 폴더(설정 기준)
  // P-6(구현 검증 1·2차 지적 5): C-C 모드의 직접 ask는 어차피 proof로 인정되지 않는다 — 답을 받은 뒤
  // 버리는 과도 동작 대신, 링크 해석·외부 실행보다 '앞에서' 안내하고 중단한다. env 두 개가 '있기만' 하면
  // 통과시키는 검사는 임의 문자열로 우회돼 같은 비용 경로가 되살아나므로, 내구 경로 실체(문법·파일·id 결속·
  // 모드·workspace)까지 확인한 경우에만 실행을 허용한다.
  if (loadContract(ws).harnessMode === "codex-codex" && !readDurableEnvJob(ws).ok) {
    die(tB("⚠️ Codex-Codex 모드에서는 직접 ask가 성공 증명으로 인정되지 않아 실행하지 않았습니다. 내구 작업을 사용하세요: ask-start --allow-new \"<검증 요청>\" → ask-wait <job-id>.", "⚠️ In Codex-Codex mode a direct ask is not accepted as a success proof, so it was not executed. Use the durable path: ask-start --allow-new \"<request>\" → ask-wait <job-id>."), 4);
  }
  // [Envelope Selector v7 §3 — 3b] 승인 서고 활성=직접 ask 거부(모드 무관): 선별·세대 동결·영수증 관문이
  // 내구 작업(worker) 경로에만 있어, 직접 ask를 허용하면 '선별 없는 판'이 승인 규칙 일부를 빼고 판정한다.
  if (!process.env.CODEX_BRIDGE_JOB_PROMPT_FILE) {
    const cD9 = loadContract(ws);
    // [경계 통일 2026-08-29 · 검증 2회차 blocker①(ab-3)] 직접 ask도 ask-start와 같은 관문: 항상 적용 수칙 파일이 승인 없이
    // 바뀌었으면 검증을 실행하지 않는다(종전=수칙 빼고 경고만 — 승인 수칙 없이 통과 판정을 만들 수 있는 길).
    if (typeof cD9.envelopeHash === "string" && cD9.envelopeHash) {
      const coreD9 = readVerifyEnvelope(resolveScoutRepo(ws, cD9).repo);
      if (coreD9.st !== "ok" || coreD9.sha1 !== cD9.envelopeHash) die(tB(`⚠️ 항상 적용되는 수칙 파일이 승인 없이 바뀌어(${coreD9.st === "ok" ? "내용 불일치" : coreD9.st}) 검증을 실행하지 않았습니다 — 대시보드 수칙 카드의 '승인 없이 바뀐 내용 보기'에서 승인하거나 마지막 승인 목록으로 복구한 뒤 다시 시도하세요.`, `⚠️ The always-applied rules file changed without approval (${coreD9.st === "ok" ? "content mismatch" : coreD9.st}) — verification not run. Open 'View unapproved changes' on the Rules card to approve or restore, then retry.`), 3);
    }
    if (typeof cD9.archiveHash === "string" && cD9.archiveHash) {
      die(tB("⚠️ 승인 서고(2층 수칙서)가 활성인 프로젝트에서는 직접 ask를 실행하지 않습니다 — 서고 선별이 내구 작업에서만 수행됩니다. ask-start --allow-new \"<검증 요청>\" → ask-wait <job-id> 를 사용하세요.", "⚠️ With the approved archive (two-tier rulebook) active, a direct ask is not executed — archive selection runs only in the durable job path. Use ask-start --allow-new \"<request>\" → ask-wait <job-id>."), 4);
    }
  }
  // P-12 동결(계약 ⓕ · 구현검증 1~2차 정정): 내구 경로는 '모드 무관 정본 판독'(readCanonicalEnvJob —
  // 경로·id·schema·workspace·running까지, C-C proof 전용 조건은 미적용: P-6 판독기 readDurableEnvJob은
  // CL-C job을 job-mode로 거부하므로 여기 쓰면 안 됨)을 통과한 job의 동결값만 신뢰하고, 정본인데 필드가
  // 없는 legacy job은 integrity+전역 언어로 고정한다(생성 후 계약을 core로 바꿔도 legacy job이 core로
  // 실행되지 않음 — 무회귀). 직접 ask는 시작 시점 스냅샷.
  const durableEnv = process.env.CODEX_BRIDGE_JOB_PROMPT_FILE ? readCanonicalEnvJob(ws) : null; // 모드 무관 정본 판독(CL-C job 포함 — P-6 판독기는 C-C proof 전용이라 여기서 쓰면 CL-C 동결값이 무시됨)
  const jobFrozen = (() => {
    if (!durableEnv) return null; // 직접 ask
    if (!durableEnv.ok) return { profile: "integrity", lang: loadLang(), rejudge: "" }; // 비정본 env — 프로필 출처로 불신(fail-safe 최소값)
    const j = durableEnv.job;
    return {
      profile: VERIFY_PROFILES.includes(j.verifyProfile) ? j.verifyProfile : "integrity",
      lang: (j.verifyLang === "ko" || j.verifyLang === "en") ? j.verifyLang : loadLang(),
      // 옛 job(필드 없음)·비문자열 = 빈 문자열 → footer 첨부 없음(구조화 이전과 같은 출력·사유 고지도 없음).
      // 여기서 파일을 '다시 읽어' 메우면 시작과 도착이 다른 세대가 되므로 폴백 재판독은 하지 않는다.
      // 원문 그대로 넘긴다 — 첨부 가능 여부 판정과 미첨부 사유 고지는 formatForClaude 한 곳이 담당한다.
      rejudge: typeof j.rejudgeSnap === "string" ? j.rejudgeSnap : "",
    };
  })();
  // 언어를 먼저 한 번 캡처하고 '같은 슬롯'의 계약을 읽는다 — 두 읽기 사이 언어 전환으로 ko 계약 프로필과
  // en 언어가 한 ask에 결합되는 교차 슬롯 스냅샷 차단(구현검증 1차 지적 4).
  const langSnap = jobFrozen ? jobFrozen.lang : loadLang();
  const contractSnap = loadContract(ws, langSnap) || {};
  const harnessModeSnap = contractSnap.harnessMode === "codex-codex" ? "codex-codex" : "claude-codex";
  // 검증 트리거 모드 스냅샷(검증 중 사용자가 바꿔도 오염 안 되게) → flagVerdict로 전달.
  // 모드별 분리(2026-07-15): 현재 운용 모드의 슬롯 스위치를 기록(통계 귀속 정확성).
  const modeSnap = (harnessModeSnap === "codex-codex" ? contractSnap.codexVerifyMode : contractSnap.verifyMode) || "";
  const profileSnap = jobFrozen ? jobFrozen.profile : effectiveVerifyProfile(contractSnap); // 직접 ask=시작 스냅샷(계약 ⓕ)
  // 재판단 규약 동결본: 내구 job=ask-start 시점 동결값, 직접 ask=여기(프로필·언어와 같은 순간) 캡처.
  // 직접 ask에는 job이 없어 동결 자리가 이 지점뿐이다 — 두 formatForClaude 호출이 같은 값을 쓴다.
  const rejudgeSnap = jobFrozen ? jobFrozen.rejudge : safeLoadRejudge(langSnap, profileSnap).trim().slice(0, REJUDGE_SNAP_MAX + 1);
  // [VerifierProvider §1·§3] 공급자 스냅샷 — 내구 job=시작 시점 동결값(legacy 무필드=codex 고정 —
  // 생성 후 계약 전환이 실행 중 작업의 공급자를 못 바꾼다), 직접 ask=계약 스냅샷.
  const providerSnap = durableEnv ? ((durableEnv.ok && VERIFIER_PROVIDERS.includes(durableEnv.job.verifyProvider)) ? durableEnv.job.verifyProvider : "codex") : normVerifierProvider(contractSnap);
  const links = loadLinks();
  let link = providerSnap === "claude" ? null : resolveLink(links); // [VerifierProvider §3] claude=검증자 링크 장치 전체 미사용(codex-shaped)
  if (!link && !allowNew && providerSnap !== "claude") {
    die(
      tB(`🔌 이 Claude 세션/워크스페이스에 연결된 Codex 세션이 없습니다. 새 세션을 임의로 만들지 않았습니다.\n   기존 세션은 대시보드에서 연결하거나 link <id>로 연결하세요. 정말 첫 소통일 때만 --allow-new를 사용하세요.`,
         `🔌 No Codex session is linked to this Claude session/workspace. No session was created automatically.\n   Link an existing session in the dashboard or with link <id>. Use --allow-new only for genuine first contact.`),
      3,
    );
  }
  // 같은 요청 중복 전송 차단(2026-07-10 실사고: 첫 호출이 3분29초 만에 원인미상 비정상 종료되자 원인 확인 없이 '전송 실패' 오판 재전송 →
  // 동일 요청 중복 실행 — 실측: rollout 같은 해시 2건). 같은 내용이 살아있는 프로세스에서 진행 중이면 거부 — 답은 rollout/대시보드에서 확인하라.
  const promptHash = crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 16);
  // 요청 지문별 중복 가드보다 먼저 ws 전체를 직렬화한다. A가 진행 중일 때 문구가 다른 B를 보내거나,
  // A의 첫 세션 즉시연결 전에 B가 또 --allow-new/--force-new를 보내는 고아 세션 폭증 경로를 함께 차단한다.
  const activeClaim = claimAskActive(ws, promptHash, link ? "resume" : "new");
  if (!activeClaim.claimed) {
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const g = askActiveGuard(activeClaim.rec, alive);
    const state = g.reason === "parent-alive" || g.reason === "child-alive"
      ? tB("검증이 실제로 진행 중", "verification is still running")
      : tB("이전 검증의 비정상 종료 표식이 남음(답이 대시보드에 도착했을 수 있음)", "a previous verification left an abnormal-exit marker (the answer may already be in the dashboard)");
    die(tB(`⚠️ 이 워크스페이스에는 ${state}입니다. 문구가 다른 요청도 재전송하지 마세요. 대시보드 검증 대화/rollout을 먼저 확인하세요.\n   상태: node codex-bridge.js ask-active status\n   부모·자식 종료를 확인하고 사용자가 재시도를 결정한 경우에만: node codex-bridge.js ask-active clear --confirm`,
             `⚠️ This workspace has ${state}. Do not resend even a differently worded request. Check the dashboard verification chat/rollout first.\n   Status: node codex-bridge.js ask-active status\n   Only after the user decides to retry and both parent/child are gone: node codex-bridge.js ask-active clear --confirm`), 3);
  }
  const activeRec = activeClaim.rec;
  process.on("exit", () => clearAskActive(ws, activeRec && activeRec.token));
  // 선점 직전 UI가 연결을 저장했을 수 있다. 새 세션 판단 직전에 최신 사용자 고정을 다시 우선한다.
  link = resolveLink(loadLinks()) || link;
  let inflightRec = null;
  if (forceResend) {
    inflightRec = overwriteAskInflight(ws, promptHash); // 의식적 강행 — 자기 소유 토큰으로 재선점
  } else {
    const cl = claimAskInflight(ws, promptHash); // 원자적 wx 선점(검사-후-기록 분리의 동시 통과 구멍 차단 — Codex 반례)
    if (cl.claimed) inflightRec = cl.rec;
    else {
      const blockMsg = () => die(loadLang() === "en"
        ? `⚠️ The same verification request is already in flight. Do NOT resend — wait for it to finish and read the answer in the dashboard verification chat (or the Codex rollout). If your capture window died, the answer still arrives there. Conscious override: --force-resend`
        : `⚠️ 같은 검증 요청이 이미 진행 중입니다. 재전송하지 마세요 — 완료를 기다렸다가 대시보드 검증 대화(또는 Codex rollout)에서 답을 읽으면 됩니다. 호출 창이 죽었어도 답은 거기 도착합니다. 의식적 강행: --force-resend`, 3);
      if (!cl.rec) blockMsg(); // 표식은 있는데 판독 불가(재시도 후에도) — 보수적 '진행 중' 처리(죽은 표식처럼 덮어쓰면 동시 재시도 중복 — Codex 반례)
      const g = askInflightGuard(cl.rec, promptHash, Date.now(), (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (g.block) blockMsg();
      // 죽은/만료 표식 회수 — 삭제 후 wx 재선점(동시 재시도 중 하나만 승자 — 단순 덮어쓰기는 둘 다 통과, Codex 반례).
      const rc = reclaimAskInflight(ws, promptHash, cl.rec); // 관측했던 죽은 레코드를 넘겨 잠금 아래 재검증(TOCTOU 차단)
      if (rc.claimed) inflightRec = rc.rec;
      else {
        const g2 = askInflightGuard(rc.rec, promptHash, Date.now(), (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
        if (g2.block || !rc.rec) blockMsg(); // 경쟁 승자가 진행 중(또는 판독 불가) — 차단
        inflightRec = overwriteAskInflight(ws, promptHash); // 극단(승자도 즉사) — 강행보다 좁은 창, 진행
      }
    }
  }
  process.on("exit", () => clearAskInflight(ws, promptHash, inflightRec && inflightRec.token)); // 자기 표식만 해제(SIGKILL 잔존은 pid 생존 검사가 무시)
  const exec = process.cwd();   // 작업 폴더(실행/탐지/근거경로 기준) — 코덱스 spawn은 cwd 미지정이라 실제로 여기서 돈다
  const mArgs = modelArgs(modelPrefFor(links, ws, harnessModeSnap)); // 운용 모드별 검증 모델/생각강도를 매 호출 -c로 재적용
  // 계약 길이 검사는 '예약보다 앞'이어야 한다(검증 blocker). withContract 안에서만 막으면 이미 왕복이
  // 예약되고 phase가 오른 뒤라, 마지막 허용 왕복에서 걸리면 계약을 줄여도 그 캠페인에서 검증을 못 한다.
  // 여기서 걸러야 '검증을 시작하지 않았습니다'가 사실이 된다(withContract의 throw는 이중 방어로 유지).
  assertContractInjectionFits(ws, contractSnap, harnessModeSnap, langSnap);
  // 지적 처분 관문 — 예약(reserveVerifyBudgetGate)보다 앞: 거부돼도 왕복·phase 불변('검증을 시작하지
  // 않았습니다'가 사실이 되는 자리). 내구 경로면 이 stderr가 .err에 보존돼 ask-wait가 exit 3으로 전달.
  // 캠페인 스냅은 여기서 1회 계산해 관문·지적 생산자(machineFindingsLayer)가 같은 값을 쓴다(1차 blocker②).
  const campSnap = campaignSnapFor(durableEnv);
  {
    const fdg = findingDispositionGate(ws, durableEnv, langSnap, campSnap);
    if (fdg.warn) process.stderr.write(fdg.warn);
    if (!fdg.proceed) die(fdg.msg, fdg.exitCode);
  }

  // [VerifierProvider §3] 후처리 꼬리 공유(추출=이동만 — codex 경로 출력 바이트 동일이 1급 인수조건):
  // proof→근거/장부 플래그→기계층→판정→출력 조립→(내구면 §6 checkpoint)→인쇄→재확인 정비·발송.
  // 자연 축퇴(설계 §0·§3): 비-codex 검증자 세션은 rollout이 없어 citedFilesUnseen(Exact)이 checked:false로
  // 스스로 물러난다 — 존재성 검사(evidence-mismatch)는 유지되고, 다룬 흔적·challenge·결합 승격만 비활성.
  const finishVerifyRun = (answer, verifierSession, headText, budgetGate, attempt, askId, attCarrier, promptText, providerName) => {
    // [§4-B ② · 확인 검증 blocker①(ab-3)] postflight 보류(검증 도중 압축/판독 불가)면 성공 증명을 기록하지 않는다 — 종료 훅이 '이번 턴 통과 증명 없음'으로
    // 막아, 압축 판의 답이 정상 명령만으로 통과 도장이 되는 경로를 원천 차단(판단 마커 실패와 무관하게 fail-closed).
    const held9 = postflightHeld(attCarrier);
    const proofBind = held9 ? {} : (writeProof(verifierSession, answer, ws) || {}); // 저장 키=구현자 세션(불변) — 이 인자는 proof 안 검증자 메타데이터(설계 blocker③)
    if (!held9) attempt.proofAccepted(); // 증명 실물 확정(이후 예외=postprocess-error — proof-rejected 오분류 차단·6차 blocker)
    const chRoots = [exec, ws];
    const chScout = contractSnap && typeof contractSnap.scoutRepo === "string" ? contractSnap.scoutRepo.trim() : "";
    if (chScout && path.isAbsolute(chScout)) chRoots.push(chScout);
    const evAlert = flagEvidence(answer, ws, verifierSession, exec, {
      roots: chRoots, promptText, mode: harnessModeSnap, lang: langSnap,
      campaignId: (durableEnv && durableEnv.ok && durableEnv.job.campaignId) || "direct", askId,
    });
    flagLedgerConfirms(answer, ws, verifierSession, exec, { askId, attach: attCarrier });
    collectScoutTargetEvidence(answer, ws, exec);
    const mfl = machineFindingsLayer(answer, ws, langSnap, profileSnap, harnessModeSnap, askId, campSnap);
    applyPostflightHold(mfl, attCarrier, ws, askId, campSnap, langSnap); // [§4-B ②] 검증 도중 압축=판정 권위 없음(보류)+판단 관문
    flagVerdict(answer, ws, verifierSession, modeSnap, mfl.machine, attempt, providerName, askId, attCarrier); // [기억 권위 C-2] askId·동봉 실물 결속
    // [약속 발화 포착 부품 B §2] 검증자 답의 [제약 후보 v1] 회수 — 내구 job의 동결 constraintCtx만 권위.
    // 직접 ask(동결 carrier 없음)=블록 전량 무시+direct-ask 영수증(§2 의식적 한정). best-effort — 실패가 판정 흐름을 막지 않음.
    try {
      const ccJob9 = (durableEnv && durableEnv.ok && durableEnv.job && durableEnv.job.constraintCtx) || null;
      if (ccJob9 && ccJob9.repoKey && constraintRepoKeyFor(ws, null) !== ccJob9.repoKey) console.error(langSnap === "en" ? "[constraint harvest] scout target changed while waiting - captured items stay bound to the original repository" : "[제약 후보 회수] 기다리는 사이 정찰 대상이 바뀜 — 포착 항목은 원문 당시 저장소에 결속 기록(현재 대상 화면에는 안 보임)"); // [ab-1] 재대조=고지(기록 권위는 동결값)
      const hv9 = constraintHarvestFromAnswer(ws, answer, ccJob9);
      if (hv9 && hv9.present) console.error((langSnap === "en" ? "[constraint harvest] " : "[제약 후보 회수] ") + (hv9.ignored ? (langSnap === "en" ? "direct ask - block ignored (receipt kept)" : "직접 ask — 블록 전량 무시(영수증 기록)") : `+${hv9.accepted}` + (hv9.rejected ? (langSnap === "en" ? ` · rejected ${hv9.rejected}` : ` · 거부 ${hv9.rejected}`) : "") + (hv9.reason ? ` · ${hv9.reason}` : "")));
    } catch { /* best-effort */ }
    // [기억 권위 A-3] 조정 트리거 ①판정 말미 — 해소된 blocker 계보를 envelope 후보로(멱등·best-effort — 실패=다음 트리거가 회수)
    try {
      const gen9m = (contractSnap && contractSnap.envelopeHash) || null;
      const rc9m = reconcileMemoryCandidates(ws, resolveScoutRepo(ws, contractSnap || loadContract(ws)).repo, gen9m);
      if (rc9m && (rc9m.appended || rc9m.suppressed.length)) process.stderr.write(`[기억 후보 조정] +${rc9m.appended}${rc9m.suppressed.length ? ` · 억제 ${rc9m.suppressed.length}(${rc9m.suppressed.map((s) => s.why).join(",")})` : ""}\n`);
    } catch { /* 공급 실패가 판정 전달을 막지 않음 */ }
    const outText = `${headText}\n\n${formatForClaude(answer, langSnap, profileSnap, mfl.machine, rejudgeTailFor(rejudgeSnap, langSnap))}\n` // [§4-B ① Claude 쪽] 규약이 이 세션에 이미 전달됐으면 꼬리는 지문 포인터 1줄
      + mfl.notice
      + memReceiptLine(answer, attCarrier, langSnap) // [기억 권위 C-3] 동봉 경계 처리 영수증(표시 전용 — 기록은 C-2 verdicts 행)
      + (attCarrier && attCarrier.deliveryOut && attCarrier.deliveryOut.statusLine ? "\n" + attCarrier.deliveryOut.statusLine : "")
      + (attCarrier && attCarrier.defaultsNotice ? "\n" + attCarrier.defaultsNotice : "") // [P7 ⓒ] 기본값 고지 — 머리와 같은 문자열의 독립 줄
      + (attCarrier && attCarrier.selOver && (attCarrier.selOver.items || attCarrier.selOver.bytes) ? "\n" + (langSnap === "en" ? `[archive rules] related items ${attCarrier.selOver.count} · ${attCarrier.selOver.bytesTotal} bytes — above the normal range, ALL included · consider tidying the archive` : `[서고 수칙] 관련 수칙 ${attCarrier.selOver.count}항 · ${attCarrier.selOver.bytesTotal}바이트 — 정상 범위 초과, 전량 동봉 · 서고 정리 권장`) : "") // [§4-B ④] 정보 행(경보 아님)
      + envelopeWarnLine(ws, langSnap)
      + budgetNoticeLines(budgetGate.res, langSnap, profileSnap)
      + breakdownNoticeFor(ws, langSnap, budgetGate.res)
      + envelopeCandidateNoticeFor(ws, langSnap, budgetGate.res, profileSnap)
      + integrityReviewLine(ws, langSnap, profileSnap);
    let ckptOk = !durableEnv;
    if (durableEnv && evAlert && evAlert.challengeId) {
      ckptOk = false;
      if (proofBind.proofFile && durableEnv.ok) {
        try { ckptOk = !!require("./evidence-challenge.js").writePrimaryComplete(path.dirname(String(process.env.CODEX_BRIDGE_JOB_PROMPT_FILE || "")), durableEnv.job, outText, { verifierSession, proofFile: proofBind.proofFile, proofFp: proofBind.proofFp }); } catch { ckptOk = false; }
      }
    }
    process.stdout.write(outText);
    try { const echM = require("./evidence-challenge.js"); echM.convergeStaleChallenges(ws); projectResolvedAcks(ws, echM); } catch { /* best-effort */ }
    if (evAlert && evAlert.challengeId && ckptOk) {
      maybeDispatchChallenge({ ws, codexSession: verifierSession, challengeId: evAlert.challengeId, lang: langSnap });
    }
    if (held9) { // [ab-6 봉합] 보류 판=정직 실패 종결(HOLD_EXIT_CODE) — 출력은 위에서 이미 전달됨
      try { process.stderr.write(langSnap === "en" ? "[directive delivery · HOLD] this run ends as a FAILED verification (no success proof) — record the judgment (round-judge ... re-verify) and start the re-verification with ask-start.\n" : "[규약 전달 · 보류] 이 실행은 검증 실패로 닫힘(통과 증명 없음) — 판단 기록(round-judge … re-verify) 뒤 ask-start로 재검증을 시작하라.\n"); } catch { /* 안내 실패 무해 */ }
      process.exitCode = HOLD_EXIT_CODE;
    }
  };

  // [VerifierProvider §3] claude 분기 — 링크·rollout·임대·모델인자·새세션 감지 없이 무상태 1회 실행.
  if (providerSnap === "claude") {
    const budgetGate = reserveVerifyBudgetGate(ws, durableEnv, contractSnap, harnessModeSnap, langSnap, profileSnap);
    if (!budgetGate.proceed) die(budgetGate.msg, budgetGate.exitCode);
    const attempt = beginVerifyAttempt(ws, budgetGate.res, profileSnap, modeSnap);
    const askId = require("crypto").randomUUID();
    const attCarrier = {};
    const promptText = withContract(prompt + (net ? netNote(langSnap) : ""), ws, langSnap, attCarrier, profileSnap, contractSnap, askId);
    attempt.markCallStart();
    const r9 = runClaudeVerifier(promptText);
    if (!r9.ok) {
      try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ }
      die(tB(`Claude 검증자 실행 실패: `, `Claude verifier failed: `) + `${r9.error?.message || ""}\n${String(r9.stderr || "").slice(-800)}`);
    }
    attempt.answered();
    try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ }
    const vSess = "claude:" + (r9.sessionId || askId); // proof '메타데이터'(저장 키 아님 — 설계 blocker③)
    finishVerifyRun(r9.answer, vSess, langSnap === "en" ? `# Verifier: Claude (stateless) ${askId}` : `# 검증자: Claude(무상태) ${askId}`, budgetGate, attempt, askId, attCarrier, promptText, "Claude");
    return;
  }

  if (link && !findRolloutById(link.codexSession)) {
    if (!allowNew) die(tB(`⚠️ 연결된 Codex 세션(${link.codexSession})을 찾을 수 없습니다. 새 세션을 임의로 만들지 않았습니다.\n→ 사용자가 새 검증 세션 생성을 승인할 때만 ask --allow-new "..."를 사용하세요.`, `⚠️ Linked Codex session (${link.codexSession}) was not found. No session was created automatically.\n→ Use ask --allow-new "..." only when the user approves creating a replacement verifier.`));
    // 명시 --allow-new는 삭제된 verifier 링크를 같은 역할 잠금에서 제거한 뒤에만 새 세션 경로로 간다.
    // 구현자 필드는 그대로 보존하므로 역할 탈취/소실이 없다.
    const staleId=link.codexSession;
    const latestRaw=clearStaleVerifier(staleId,ws);
    // 잠금 대기 중 사용자가 다른 verifier를 연결했다면 그 최신 연결을 존중해 resume한다. 새 세션으로 덮지 않는다.
    const latest=latestRaw?{...latestRaw,via:"workspace"}:null;
    if(latest&&latest.codexSession!==staleId){
      if(!findRolloutById(latest.codexSession))die(tB(`동시에 새로 연결된 검증 세션(${latest.codexSession})의 파일을 찾을 수 없어 새 세션을 만들지 않았습니다.`,`The concurrently linked verifier (${latest.codexSession}) has no rollout; no new session was created.`));
      link=latest;
    }else link=null;
  }

  if (link) {
    // §7 전역 세션 lease(증분 3): 같은 verifier 세션의 동시 resume을 창·프로젝트 무관하게 차단
    // (ask-active는 ws 단위 — 두 창이 같은 세션을 공유하면 못 막는다). 예산 게이트보다 먼저 —
    // busy 거부는 왕복을 소모하지 않는다. 해제는 exit 훅(die 포함 모든 종료 경로에서 실행,
    // 강제 종료 잔재는 acquire의 사망 회수 규칙이 수렴).
    const lease = acquireSessionLease(link.codexSession, {
      ws, mode: harnessModeSnap, jobId: String(process.env.CODEX_BRIDGE_ASK_JOB_ID || ""),
      deadlineAt: new Date(Date.now() + minimumCallerTimeoutMs()).toISOString(),
    });
    if (!lease.ok) {
      const h = lease.holder || {};
      // 보유자 프로세스가 죽어 있어도 자동 회수하지 않는다(고아 codex 생존 가능 — ask-active와 같은
      // 수동 clear 철학). 사용자에게 확인 후 정리 명령을 안내한다.
      const staleHint = lease.staleOwner
        ? tB(`\n(보유 프로세스는 종료된 상태입니다. 실행 중 codex가 없음을 확인했으면: node "${__filename}" session-lease clear ${link.codexSession} --confirm)`, `\n(The owning process has exited. If you confirmed no codex is still running: node "${__filename}" session-lease clear ${link.codexSession} --confirm)`)
        : "";
      die(tB(`⚠️ 이 검증 세션(${link.codexSession})은 다른 작업이 사용 중입니다(소유 ws=${h.ws || "?"} · pid=${h.ownerPid || "?"}). 동시 resume은 기록을 섞을 수 있어 시작하지 않았습니다 — 그 작업이 끝난 뒤 다시 시도하세요.`, `⚠️ This verifier session (${link.codexSession}) is in use by another task (owner ws=${h.ws || "?"} · pid=${h.ownerPid || "?"}). Concurrent resume can interleave the session log, so nothing was started — retry after that task finishes.`) + staleHint, 3);
    }
    process.on("exit", () => { try { releaseSessionLease(link.codexSession, lease.token); } catch { /* 무해 */ } });
    // P-12 2b: 예약=호출 직전 공통 래퍼 1곳(전처리 전부 통과 후). 소진 거부는 phase/round 불변 exit 3 —
    // 내구 경로면 이 stderr가 worker .err에 보존돼 job failed(3)→ask-wait가 안내와 함께 exit 3 전달.
    const budgetGate = reserveVerifyBudgetGate(ws, durableEnv, contractSnap, harnessModeSnap, langSnap, profileSnap);
    if (!budgetGate.proceed) die(budgetGate.msg, budgetGate.exitCode); // 예약 전 거부=시도 0행(2d 계약)
    const attempt = beginVerifyAttempt(ws, budgetGate.res, profileSnap, modeSnap); // 2d: 예약 직후 — 이후 모든 종결이 정확히 1회 기록 시도
    const askId = require("crypto").randomUUID(); // L1-A: '서로 다른 ask 실행' 판정 재료(지문·verdict ts는 재실행 구분에 부적합 — Codex)
    const attCarrier = {};                        // L1-A: 이번 ask에 실제로 실린 동봉 스냅샷(재계산 아님)
    const rolloutFile9 = findRolloutById(link.codexSession) || "";
    attCarrier.delivery = { session: link.codexSession, rolloutFile: rolloutFile9 }; // [§4-B ①] 이어 쓰기=전달 계획(전문 1회·이후 상태 줄)
    const promptText = withContract(prompt + (net ? netNote(langSnap) : ""), ws, langSnap, attCarrier, profileSnap, contractSnap, askId); // 프롬프트 조립은 측정 밖(1차 blocker①)
    const callStartIso9 = new Date().toISOString();
    recordDeliveryBeforeCall(link.codexSession, attCarrier, callStartIso9, rolloutFile9, askId, ws); // 전문 판=pending 기록(호출 실패=다음 판 재전송)
    attempt.markCallStart(); // duration=모델 호출 직전부터(7차 [보완])
    const { answer, error, status, stderr } = runCodex(["resume", link.codexSession, ...mArgs, ...(net ? netArgs() : [])], promptText);
    if (error || !answer || (typeof status === "number" && status !== 0)) {
      try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // ask 실패 → 진행표시 codex-verifying 잔존 방지(Claude로 복귀)
      // [회차 환급 2026-09-04] 답이 한 글자도 오지 않은 실패(스폰·네트워크)는 왕복이 아니다 — 방금 예약한 서수를 되돌린다(캠페인당 VERIFY_REFUND_MAX회 유계).
      // 답이 있는데 status≠0인 판(보류·실패 판정)은 환급하지 않는다. 환급 결과는 job 파일·stderr에 남겨 사용자가 본다.
      let refundNote9 = "";
      if (!String(answer || "").trim() && budgetGate.res && budgetGate.res.tracked === true && Number.isInteger(budgetGate.res.n)) {
        const rf9 = require("./contract-lib.js").refundVerifyCampaignRound(ws, budgetGate.res.campaignId, budgetGate.res.n);
        try { if (durableEnv && durableEnv.ok && durableEnv.job) patchAskJobFile(durableEnv.job.id, { roundRefunded: !!rf9.ok, roundRefundReason: rf9.ok ? "" : String(rf9.reason || "") }); } catch { /* 가시화 best-effort */ }
        refundNote9 = rf9.ok
          ? tB(`\n[회차 환급] 검증자 답 없이 실패한 호출이라 회차 ${budgetGate.res.n}을(를) 돌려받았습니다(이 캠페인 환급 ${rf9.refunds}/${rf9.max}회 · 사용 회차 ${rf9.count}/${rf9.budget}).`, `\n[round refunded] The verifier produced no answer, so round ${budgetGate.res.n} was returned (refunds this campaign ${rf9.refunds}/${rf9.max} · used ${rf9.count}/${rf9.budget}).`)
          : tB(`\n[회차 미환급] 답 없는 실패지만 회차를 돌려받지 못했습니다(${rf9.reason}) — 상한이 그대로 소모됩니다.`, `\n[round not refunded] No answer, but the round could not be returned (${rf9.reason}) — the cap is consumed as usual.`);
      }
      die(tB(`Codex resume 실패: `,`Codex resume failed: `) + `${error?.message || ""}\n${stderr.slice(-500)}` + refundNote9);
    }
    attempt.answered(); // 답 수신(이후 예외=proof-rejected 매핑)
    try { postflightDelivery(link.codexSession, attCarrier, callStartIso9, rolloutFile9); } catch { /* 판독 실패=계획기가 다음 판 재전송 */ } // [§4-B ②] 검증 도중 압축 검사(postflight)
    try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // 검증 답 수신 → Claude 반영중
    finishVerifyRun(answer, link.codexSession, `${langSnap === "en" ? "# Linked session" : "# 연결 세션"} ${link.codexSession} (${link.via})`, budgetGate, attempt, askId, attCarrier, promptText, "Codex");
    return;
  }

  // 연결 전무 = 진짜 첫 소통.
  if (!allowNew) {
    // (나) 정책: 보고만 하고 멈춤. 멋대로 새 세션 안 만듦.
    die(
      tB(`🔌 이 Claude 세션/워크스페이스에 연결된 Codex 세션이 없습니다.\n   - 기존 세션에 연결:   node codex-bridge.js link <codex-session-id>   (목록: find)\n   - 가장 최근에 연결:   node codex-bridge.js link --last\n   - 새로 시작(첫 소통): node codex-bridge.js ask --allow-new "..."\n※ 새 세션을 임의로 만들지 않았습니다.`,
         `🔌 No Codex session is linked to this Claude session/workspace.\n   - Link an existing session:  node codex-bridge.js link <codex-session-id>   (list: find)\n   - Link the most recent:      node codex-bridge.js link --last\n   - Start fresh (first contact): node codex-bridge.js ask --allow-new "..."\n※ No new session was created on its own.`),
      3,
    );
  }

  // 엉뚱 폴더 방어(레거시): 원래는 '엉뚱한 cwd에서 새 세션 만들어 목록 오염'을 막던 차단이었다.
  // 이제 ws=configWs(연 폴더)·recordLink도 configWs라 새 세션은 항상 '이 대화의 연 폴더'에 묶인다 → 고아 세션이 원천적으로 안 생긴다.
  // 그래서 here(=configWs)는 activeIsThisConv일 때 active.workspace와 같아 이 차단은 사실상 no-op(configWs 앵커가 목적을 흡수).
  // (남겨둔 이유: CLAUDE_PROJECT_DIR 명시 override 등 폴백 경로의 안전망. --force-new로 우회.)
  const here = ws;
  const active = readActive();
  const myClaude = claudeId();
  const sameWs = (a, b) => normWs(a) === normWs(b); // normWs가 이미 NFC 정규화하므로 단순 비교로 충분
  // active.json은 전역 1개 파일이라 멀티 창에선 '마지막에 프롬프트 넣은 대화'가 덮어쓴다. 그래서 workspace만 보고
  // 막으면 다른 창/오래된 active로 정상 폴더를 오탐 차단할 수 있다. → active가 '바로 이 Claude 대화'의 것일 때만
  // (active.claudeSession == 현재 CLAUDE_CODE_SESSION_ID) 강한 차단. 불일치/세션id 없음/active 없음이면 차단 안 함(오탐 방지).
  const activeIsThisConv = active && active.claudeSession && myClaude && active.claudeSession === myClaude;
  if (!forceNew && activeIsThisConv && active.workspace && !sameWs(active.workspace, here)) {
    die(
      tB(
        `⚠️ 새 Codex 세션을 만들 '이 폴더'가 지금 이 Claude 대화가 도는 폴더와 다릅니다.\n   - 이 폴더(실행 위치): ${here}\n   - 이 대화의 폴더:     ${active.workspace}\n   엉뚱한 폴더에서 돌렸을 가능성이 큽니다. 새 세션을 만들지 않았습니다.\n   → 그 대화 폴더에서 실행하거나, CLAUDE_PROJECT_DIR을 그 폴더로 설정하세요.\n   → 정말 '${here}'에 새 세션을 만들려면: ask --force-new "..."`,
        `⚠️ The folder for the new Codex session differs from this Claude conversation's folder.\n   - this folder (exec cwd): ${here}\n   - conversation folder:    ${active.workspace}\n   This looks like a wrong-folder run. No new session was created.\n   → Run from that conversation folder, or set CLAUDE_PROJECT_DIR to it.\n   → To really create one in '${here}': ask --force-new "..."`,
      ),
      3,
    );
  }

  // 폭증 방지: 직전 --allow-new가 세션을 만들고도 연결 기록에 실패했으면, 또 만들지 않는다(수동 link 유도).
  // 게이트는 시작 시점 스냅샷이 아니라 '지금' 상태로 본다 — 그새 다른 창이 수동 연결로 플래그를 해제했을 수 있음.
  const wsKey = normWs(ws);
  const freshAutoFail = (loadLinks() || {}).autoNewFailed;
  if (freshAutoFail && freshAutoFail[wsKey]) {
    die(
      tB(`⚠️ 직전에 새 Codex 세션을 만들었지만 연결 기록에 실패했습니다(세션id 식별 실패).\n   무한 생성 방지를 위해 자동 생성을 멈춥니다.\n   - 만든 세션 연결: node codex-bridge.js find  →  node codex-bridge.js link <id>\n   - 폴더 탐지 점검: node codex-bridge.js doctor`,
         `⚠️ A new Codex session was just created but linking failed (session id unresolved).\n   Auto-creation is paused to prevent runaway session creation.\n   - Link the created session: node codex-bridge.js find  →  node codex-bridge.js link <id>\n   - Check folder detection:  node codex-bridge.js doctor`),
      3,
    );
  }

  // --allow-new: 새 세션 생성 + '생성 즉시' 연결(답을 기다리는 동안 rollout 뜨면 바로 link → 8분 답 끝까지 안 기다림).
  const since = Date.now() - 2000;
  // P-12 2b: 새 세션 분기도 같은 래퍼 1곳(전처리 전부 통과 후·호출 직전) — 소진 거부는 phase/round 불변 exit 3.
  const budgetGate = reserveVerifyBudgetGate(ws, durableEnv, contractSnap, harnessModeSnap, langSnap, profileSnap);
  if (!budgetGate.proceed) die(budgetGate.msg, budgetGate.exitCode);
  const attempt = beginVerifyAttempt(ws, budgetGate.res, profileSnap, modeSnap); // 2d: 예약 직후 — 모든 종결 1회 기록 시도
  let earlyLinked = null;
  // recordLink가 '성공(true)'일 때만 earlyLinked 확정 → 저장 실패(CAS/잠금/권한)면 미연결로 두고 다음 폴/최종 단계서 재시도.
  // detected(세션 발견)와 linked(저장 성공)를 분리해 "즉시연결" 거짓보고를 막는다(Codex 지적).
  const onDetect = (id) => { if (earlyLinked) return; try { if (recordLink(id)) earlyLinked = id; } catch { /* 다음 폴/최종 단계서 재시도 */ } };
  const askId = require("crypto").randomUUID(); // L1-A: '서로 다른 ask 실행' 판정 재료
  const attCarrier = {};                        // L1-A: 이번 ask에 실제로 실린 동봉 스냅샷
  attCarrier.delivery = { session: "", rolloutFile: "", first: true }; // [§4-B ①] 세션을 만드는 첫 메시지=규약 전문 1회
  const promptText = withContract(prompt + (net ? netNote(langSnap) : ""), ws, langSnap, attCarrier, profileSnap, contractSnap, askId); // 프롬프트 조립은 측정 밖(1차 blocker①)
  const callStartIso9 = new Date().toISOString();
  attempt.markCallStart(); // duration=모델 호출 직전부터(7차 [보완])
  const { answer, error, status, stderr, detected } = await runCodexNewSessionAsync([...mArgs, ...(net ? netArgs() : [])], promptText, since, exec,
    (id) => { updateAskActive(ws, activeRec && activeRec.token, { sessionId: id }); onDetect(id); },
    (pid) => { updateAskActive(ws, activeRec && activeRec.token, { childPid: Number.isInteger(pid) ? pid : null }); }); // 탐지=작업폴더(코덱스 session_meta.cwd와 일치)
  // cwd 일치 우선, 못 찾으면 원래 방식(무회귀) — 최종 식별용 폴백.
  const resolveNew = () => { const f = newestRolloutSinceForWs(since, exec) || newestRolloutSince(since); const mm = f && f.match(UUID_RE); return mm ? mm[1] : ""; }; // 탐지=작업폴더
  if (error || !answer || (typeof status === "number" && status !== 0)) {
    // 실패: 이미 '생성 즉시 연결'됐으면 고아 아님 → autoNewFailed 안 검(다음 시도는 그 세션 resume). 미연결일 때만 폭증방지/식별 시도.
    if (!earlyLinked) {
      const nid = detected || resolveNew();
      if(nid)try{if(recordLink(nid))earlyLinked=nid;}catch{/* 아래에서 생성 차단 */} // 실패해도 세션이 생겼으면 연결(고아 방지)
      // 새 세션 시도가 연결 없이 끝났다면 실제 생성 여부를 모르는 경우도 포함해 무조건 다음 생성을 막는다.
      // '생기지 않았을 수도 있음'보다 고아 세션 증식 방지가 우선이며, 수동 link가 성공하면 recordLink가 해제한다.
      if (!earlyLinked) updateLinks((o) => { o.autoNewFailed = o.autoNewFailed || {}; o.autoNewFailed[wsKey] = true; });
    }
    try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // ask 실패 → 진행표시 정리(Claude로 복귀)
    die(tB(`Codex 새 세션 ${earlyLinked ? `(연결됨 ${earlyLinked}) ` : ""}실패: `, `Codex new session ${earlyLinked ? `(linked ${earlyLinked}) ` : ""}failed: `) + `${error?.message || ""}\n${stderr.slice(-500)}\n` + (earlyLinked ? tB("(세션은 연결됐으니 다시 검증하면 그 세션을 이어갑니다.)", "(the session is linked — re-verifying continues it.)") : tB("(세션 파일이 생겼다면 'find'→'link <id>'로 연결하세요.)", "(if a session file appeared, link it via 'find' → 'link <id>'.)")));
  }
  attempt.answered(); // 답 수신(이후 예외=proof-rejected 매핑)
  try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // 검증 답 수신 → Claude 반영중
  let id = earlyLinked;
  if (!id) { const nid = resolveNew(); if (nid && recordLink(nid)) id = nid; } // 즉시연결 못했으면 지금 찾아 연결
  if (id) {
    const en = langSnap === "en";
    const head = earlyLinked
      ? (en ? `# New Codex session created·linked immediately: ${id}` : `# 새 Codex 세션 생성·즉시연결: ${id}`)
      : (en ? `# New Codex session created·linked: ${id}` : `# 새 Codex 세션 생성·연결: ${id}`);
    try { const rfN = findRolloutById(id) || ""; recordDeliveryBeforeCall(id, attCarrier, callStartIso9, rfN, askId, ws); postflightDelivery(id, attCarrier, callStartIso9, rfN); } catch { /* 기록 실패=다음 판 재전송 */ } // [§4-B ②] 첫 메시지 전달 기록+postflight
    finishVerifyRun(answer, id, head, budgetGate, attempt, askId, attCarrier, promptText, "Codex");
  } else {
    attempt.record("session-unresolved"); // 2d: 답은 왔으나 세션 미결속 — 소비된 왕복 보존(승격·최근 무결성 미산입)
    updateLinks((o) => { o.autoNewFailed = o.autoNewFailed || {}; o.autoNewFailed[wsKey] = true; }); // 다음 자동 생성 차단 플래그
    // thread.started JSON + rollout 탐지 모두 실패한 비정상 상태는 성공 proof로 인정하지 않는다. 세션 증식을
    // 멈추고 빨강 무결성 사건으로 드러내 사용자가 정확한 세션을 연결하기 전에는 다음 검증을 만들 수 없다.
    collectScoutTargetEvidence(answer, ws, exec); // 답 자체의 경로 증거는 정찰 대상 진단에만 보존(검증 proof와 무관)
    flagLedgerConfirms(answer, ws, "", exec, { askId, attach: attCarrier }); // 세션 미식별은 seen=unknown 기록만, 승격/proof 재료 아님
    try { appendIntegrityEvent({ts:new Date().toISOString(),session:claudeId(),workspace:ws,kind:"session-unresolved",severity:"error",detailKo:"새 검증 세션은 생성됐지만 ID를 식별·연결하지 못했습니다. 자동 생성을 중지했습니다. find에서 방금 세션을 확인해 검증 역할로 연결하세요.",detailEn:"A verifier session was created but its ID could not be resolved and linked. Auto-creation is paused. Identify the new session in find and link it as verifier."}); } catch { /* 상태 파일은 autoNewFailed가 보존 */ }
    die(langSnap === "en" ? "New verifier session ID unresolved; no proof was accepted and auto-creation is paused. Use find then link <id>." : "새 검증 세션 ID 식별 실패: 성공 증명으로 인정하지 않았고 자동 생성을 중지했습니다. find 후 link <id>로 연결하세요.");
  }
}

function cmdLink(rest) {
  let id;
  if (rest[0] === "--last") {
    const rec = recentRollouts(1);
    if (!rec.length) die("Codex 세션이 없습니다. (find로 확인)");
    id = rec[0].id;
  } else if (rest[0] && UUID_RE.test(rest[0])) {
    id = rest[0].match(UUID_RE)[1];
  } else {
    die('사용법: link <codex-session-id> | link --last   (후보: find)', 2);
  }
  const file = findRolloutById(id);
  const ok = recordLink(id); // CAS 저장 + autoNewFailed 해제 포함(수동 연결도 동일 관문)
  process.stdout.write(
    (ok ? `✅ 연결됨` : `⚠️ 연결 기록 저장 실패(권한/잠금?) — 다시 시도하세요`) +
      `: Claude(${claudeId() || "?"}) + ${configWs()}  →  Codex ${id}\n` +
      (file ? `   세션 파일: ${path.basename(file)}\n` : `   ⚠️ 해당 세션 rollout 파일이 안 보임(추후 resume 시 실패할 수 있음)\n`),
  );
}

// 모델/생각강도 선택 보기·설정·해제(프로젝트별). 대시보드가 links.json을 직접 쓰지만, CLI로도 점검/테스트 가능.
function cmdPref(rest) {
  const ws = configWs(); // 설정 저장 기준 = 연 폴더(ask가 configWs로 읽으므로 CLI 저장도 같은 키여야 일치). 대시보드(연 폴더 저장)와도 정합.
  const key = normWs(ws);
  const mode = harnessModeFor(ws);
  const bucket = mode === "codex-codex" ? "codexCodexModelPrefs" : "modelPrefs";
  let ok = true;
  if (rest[0] === "set") {
    ok = updateLinks((o) => {
      o[bucket] = o[bucket] || {};
      const cur = o[bucket][key] || {};
      for (const kv of rest.slice(1)) {
        const i = kv.indexOf("=");
        if (i < 0) continue;
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (k === "model") cur.model = v;
        else if (k === "reasoning") cur.reasoning = v;
      }
      o[bucket][key] = cur;
    });
  } else if (rest[0] === "clear") {
    ok = updateLinks((o) => { if (o[bucket]) delete o[bucket][key]; });
  }
  if (!ok) process.stderr.write(`⚠️ 모델 선택 저장 실패(권한/잠금?) — 다시 시도하세요.\n`);
  const now = loadLinks();
  const own = (now[bucket] || {})[key];
  const pref = modelPrefFor(now, ws, mode);
  process.stdout.write(
    `워크스페이스: ${ws}\n` +
      `운용 모드: ${mode}${mode === "codex-codex" && !own ? " (Claude 모드 설정 상속)" : ""}\n` +
      `선택값: model=${pref.model || "(기본)"} · 생각강도=${pref.reasoning || "(기본)"}\n` +
      `다음 ask 주입 인자: ${modelArgs(pref).join(" ") || "(없음 — codex config 기본값 사용)"}\n`,
  );
}

function cmdStatus() {
  const links = loadLinks();
  const link = resolveLink(links);
  { const cfg = configWs(), ex = process.cwd();
    process.stdout.write(`Claude 세션: ${claudeId() || "(env 없음)"}\n워크스페이스(설정 기준): ${cfg}\n` +
      (normWs(cfg) !== normWs(ex) ? `실행 폴더(작업 cwd): ${ex}\n` : "")); }
  // 모드별 분리(2026-07-16 구현검증 1차 지적 5): status에도 현재 운용 모드의 실효 스위치+양 슬롯 병기(doctor와 동일 계약).
  { let cST = null; try { cST = loadContract(configWs()); } catch { /* 계약 없음/손상 — 아래서 정직 표기 */ }
    process.stdout.write(`검증 모드: ${cST ? `${cST.harnessMode === "codex-codex" ? cST.codexVerifyMode : cST.verifyMode} (현재 ${cST.harnessMode === "codex-codex" ? "Codex-Codex" : "Claude-Codex"} 모드 기준 · CL-C=${cST.verifyMode} / C-C=${cST.codexVerifyMode})` : "(계약 로드 실패)"}\n`); }
  if (!link) {
    process.stdout.write("연결: 없음 (ask 하면 보고만 함, 또는 link/--allow-new)\n");
    return;
  }
  const file = findRolloutById(link.codexSession);
  process.stdout.write(
    `연결: Codex ${link.codexSession} (${link.via})  · 파일 ${file ? "있음" : "없음(삭제됨?)"}\n`,
  );
}

function pidAlive(pid) { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; } }
function cmdAskActive(rest) {
  const ws = configWs();
  const rec = readAskActive(ws);
  if (rest[0] === "clear") {
    if (!rest.includes("--confirm")) die("사용법: ask-active clear --confirm", 2);
    if (!rec) { process.stdout.write(tB("진행 표식 없음\n", "No active marker\n")); return; }
    if (pidAlive(rec.pid) || pidAlive(rec.childPid)) die(tB("실행 중인 부모/자식 프로세스가 있어 clear를 거부합니다.", "Refusing clear while the parent/child process is alive."), 3);
    if (!clearAskActive(ws, null, { manual: true, confirm: true })) die(tB("진행 표식 clear 실패", "Failed to clear active marker"));
    process.stdout.write(tB("✅ 사용자가 확인한 비정상 종료 표식을 해제했습니다.\n", "✅ Cleared the user-confirmed abnormal-exit marker.\n")); return;
  }
  if (!rec) { process.stdout.write(tB("진행 중 검증 없음\n", "No active verification\n")); return; }
  process.stdout.write(JSON.stringify({ workspace: ws, file: askActiveFileFor(ws), mode: rec.mode, startedAt: rec.startedAt, promptHash: rec.hash, parentPid: rec.pid, parentAlive: pidAlive(rec.pid), childPid: rec.childPid, childAlive: pidAlive(rec.childPid), sessionId: rec.sessionId || null }, null, 2) + "\n");
}

function cmdTimeout() {
  process.stdout.write(JSON.stringify({ verifyTimeoutMin: verifyTimeoutMin(), minimumCallerTimeoutMs: minimumCallerTimeoutMs(), note: tB("직접 ask의 timeout과 내구 job 절대 deadline에 같은 값이 적용됩니다. 긴 검증은 ask-start 1회 후 같은 job을 ask-wait로 조회하세요.", "The same value governs direct ask timeout and the durable job's absolute deadline. For long verification, call ask-start once and poll that same job with ask-wait.") }, null, 2) + "\n");
}

function cmdFind() {
  const links = loadLinks();
  const link = resolveLink(links);
  const list = recentRollouts(12);
  if (!list.length) {
    process.stdout.write("Codex 세션 없음.\n");
    return;
  }
  process.stdout.write("최근 Codex 세션(연결 후보 — 첫 사용자 발화로 식별):\n");
  for (const s of list) {
    const mark = link && link.codexSession === s.id ? "  ★현재 연결됨" : "";
    const when = s.mtime ? new Date(s.mtime).toLocaleString() : "";
    process.stdout.write(`  ${s.id}${mark}\n     ${when} · ${firstUserSnippet(s.file)}\n`);
  }
  process.stdout.write('\n연결 바꾸기: node codex-bridge.js link <id>\n');
}

// 진단 전용(doctor에서만 호출): CODEX_HOME 하위에서 '실제 rollout이 떨어진 폴더'를 관찰한다(archived_sessions 제외).
// SESSIONS_DIR(=CODEX_HOME/sessions) 가정이 어긋났는지(미래 codex layout 변경 등) '진단'만 — 자동 전환은 안 한다
// (archived 등 오탐 위험). 비용 제한 위해 깊이 제한. 없으면 null.
function observeRolloutDir() {
  let best = null, bestMt = 0;
  const walk = (d, depth) => {
    if (depth > 7) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (it.name === "archived_sessions") continue; // active 세션 아님 → 오탐 제외
        walk(path.join(d, it.name), depth + 1);
      } else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        let mt = 0;
        try { mt = fs.statSync(path.join(d, it.name)).mtimeMs; } catch { /* ignore */ }
        if (mt > bestMt) { bestMt = mt; best = d; }
      }
    }
  };
  walk(CODEX_HOME, 0);
  return best;
}

// 점검: codex를 실제로 실행 가능한지 + 연결/검증 상태를 한눈에. 검증이 안 될 때 추측 대신 이걸 본다.
function cmdDoctor() {
  const inv = resolveCodex();
  const runnable = inv.shell ? null : fs.existsSync(inv.file) && (!inv.args.length || fs.existsSync(inv.args[0]));
  process.stdout.write("=== codex-bridge doctor ===\n");
  process.stdout.write(`codex 실행방식 : ${inv.how}\n`);
  process.stdout.write(`실행 명령      : ${inv.file}${inv.args.length ? " " + inv.args.join(" ") : ""}${inv.shell ? "   (PATH 셸 해석)" : ""}\n`);
  process.stdout.write(`실행 가능?     : ${inv.shell ? "PATH 의존(런타임 확인)" : runnable ? "예" : "아니오  ← 검증 불가의 직접 원인"}\n`);
  let c = null;
  try {
    c = loadContract(configWs());
  } catch {
    /* ignore */
  }
  // 모드별 분리(2026-07-15): 현재 운용 모드의 슬롯 값을 실효값으로, 양 슬롯을 참고로 병기.
  process.stdout.write(`검증 모드      : ${c ? `${c.harnessMode === "codex-codex" ? c.codexVerifyMode : c.verifyMode} (현재 ${c.harnessMode === "codex-codex" ? "Codex-Codex" : "Claude-Codex"} 모드 기준 · CL-C=${c.verifyMode} / C-C=${c.codexVerifyMode})` : "(계약 로드 실패)"}\n`);
  process.stdout.write(`Claude 세션    : ${claudeId() || "(env 없음)"}\n`);
  process.stdout.write(`워크스페이스   : ${configWs()} (설정 기준=연 폴더)\n`);
  process.stdout.write(`실행 폴더(cwd) : ${process.cwd()}\n`);
  // 자체 폴더(브릿지 home) 진단: 확장과 훅이 같은 폴더를 보는지의 핵심. 훅이 active.json을 다른 BRIDGE_DIR에 쓰면
  // 여기서 '활성 대화기록 없음'으로 드러난다(=확장↔훅 home 불일치 or 훅 미동작).
  const bridgeSrc = process.env.CODEX_BRIDGE_HOME ? "env CODEX_BRIDGE_HOME" : "기본 ~/.codex-bridge";
  const active = readActive();
  process.stdout.write(`브릿지 폴더    : ${BRIDGE_DIR}  (출처: ${bridgeSrc})\n`);
  process.stdout.write(`활성 대화기록  : ${active ? `있음 (대화폴더: ${active.workspace || "?"})` : "없음 ← 훅 미동작이거나 확장↔훅이 다른 폴더를 봄(CODEX_BRIDGE_HOME 일치 확인)"}\n`);
  const homeSrc = process.env.CODEX_HOME ? "env CODEX_HOME" : readPinnedHome() ? "codex-home.txt(자동탐지)" : "기본 ~/.codex";
  process.stdout.write(`Codex home     : ${CODEX_HOME}  (출처: ${homeSrc})\n`);
  process.stdout.write(`세션 폴더      : ${SESSIONS_DIR} · ${fs.existsSync(SESSIONS_DIR) ? "있음" : "없음 ← 세션 안 보이면 1순위 의심"}\n`);
  const links = loadLinks();
  const link = resolveLink(links);
  if (link) {
    const file = findRolloutById(link.codexSession);
    process.stdout.write(`연결           : Codex ${link.codexSession} (${link.via}) · 세션파일 ${file ? "있음" : "없음(삭제됨?)"}\n`);
  } else {
    process.stdout.write(`연결           : 없음 (ask=보고만 / 첫 소통=ask --allow-new)\n`);
  }
  if (!inv.shell && !runnable) {
    process.stdout.write(`\n해결: CODEX_BIN 환경변수에 codex 실행파일 또는 bin/codex.js 경로를 지정하세요.\n`);
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    process.stdout.write(
      `\n⚠ 세션 폴더가 없음. 세션 목록/연결/검증/삭제가 안 되면 1차 의심:\n` +
        `  codex 업데이트로 'codex doctor'의 CODEX_HOME 출력 형식이 바뀌어 home 자동탐지가 깨졌을 수 있음.\n` +
        `  → 'node codex-bridge.js detect-home' 재실행. 그래도 실패면 detectCodexHome()의 파싱 규칙(정규식) 확인.\n`,
    );
  }
  // layout 변경 진단: 세션 폴더가 없거나 비었는데 CODEX_HOME 하위 다른 곳에 rollout이 있으면 알린다(자동 전환은 안 함).
  if (!fs.existsSync(SESSIONS_DIR) || !newestRolloutSince(0)) {
    const obs = observeRolloutDir();
    // 'obs가 SESSIONS_DIR 하위인가'를 path.relative로 경계 있게 판정(단순 prefix는 sessions_backup·sessions2 형제를
    // 하위로 오판). rel이 ""(같음)이거나 ".."로 시작 안 하고 절대경로 아니면 하위 → 그 경우만 알림 억제.
    const rel = obs ? path.relative(normWs(SESSIONS_DIR), normWs(obs)) : "..";
    const underSessions = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (obs && !underSessions) {
      process.stdout.write(
        `\n↪ 단, CODEX_HOME 하위 다른 곳에 rollout이 있음:\n   ${obs}\n` +
          `   → codex가 세션 위치를 바꿨을 수 있음(layout 변경). 이 경로 기준으로 CODEX_HOME/세션 폴더 해석을 점검하세요.\n` +
          `   (자동 전환은 하지 않음 — archived 등 오탐 방지. 필요 시 CODEX_HOME을 위 경로의 상위로 맞추세요.)\n`,
      );
    }
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "ask": {
      const p = cmdAsk(rest); // 새 세션 경로는 async(즉시연결). resume는 동기 흐름이라 즉시 resolve.
      // 오류가 구분 코드를 달고 오면 그대로 전달한다 — 1로 뭉개면 호출자가 '검증 안 함(3)'과
      // 일반 실패(1)를 구별하지 못한다(검증 [보완]).
      if (p && typeof p.then === "function") p.catch((e) => die(tB("ask 오류: ", "ask error: ") + (e && e.message ? e.message : String(e)), Number(e && e.exitCode) || 1));
      return p;
    }
    case "ask-start":
      return cmdAskStart(rest);
    case "selector-preview": // [4b 이중 배달] 구현 시작 전 '이번 작업 선별' 미리보기 — 영수증(purpose:preview)이 게이트·ask-start 선행 조건
      return void cmdSelectorPreview(rest);
    case "ask-wait":
      return cmdAskWait(rest);
    case "ask-job":
      return cmdAskJob(rest);
    case "session-lease": { // §7 증분 3 — 세션 lease 확인·수동 정리(자동 회수 없는 childPid 미기록 잔재용)
      const sub = String(rest[0] || ""), sid = String(rest[1] || "");
      if (sub === "show") {
        const cur = sid ? readSessionLease(sid) : null;
        console.log(cur ? JSON.stringify(cur, null, 1) : tB("lease 없음(그 세션은 지금 아무도 사용하지 않습니다).", "No lease (that session is not in use)."));
        return;
      }
      if (sub === "clear") {
        if (!sid) die(tB("사용법: session-lease clear <sessionId> --confirm", "Usage: session-lease clear <sessionId> --confirm"));
        if (!rest.includes("--confirm")) die(tB("⚠️ 실행 중 codex가 없음을 확인한 뒤 --confirm 을 붙여 다시 실행하세요(동시 resume은 세션 기록을 섞습니다).", "⚠️ Confirm no codex is still running, then re-run with --confirm (concurrent resume interleaves the session log)."));
        const old = clearSessionLease(sid);
        if (old && old.blocked === "alive") die(tB("⚠️ 보유 프로세스(또는 기록된 자식)가 아직 살아 있습니다 — 살아있는 세션의 lease는 지울 수 없습니다. 그 작업이 끝난 뒤 다시 확인하세요.", "⚠️ The owning process (or its recorded child) is still alive — a live session lease cannot be cleared. Re-check after that task finishes."), 3);
        if (old && old.blocked === "lock") {
          // [주의] 반영: 삭제 안내는 '보유자 사망 확정(dead-lock-holder)'에만 — 일반 timeout은 살아있는
          // 보유자가 느린 것일 수 있어 활성 잠금 삭제를 유도하면 안 된다.
          if (String(old.error || "").includes("dead-lock-holder")) die(tB(`⚠️ 잠금 파일 잔재 때문에 진행할 수 없습니다(${old.error}). 표시된 잠금 파일을 직접 삭제한 뒤 이 명령을 다시 실행하세요 — 프로그램은 잠금 파일을 스스로 지우지 않습니다.`, `⚠️ Cannot proceed due to a leftover lock file (${old.error}). Delete the indicated lock file manually, then re-run this command — the program never removes lock files on its own.`), 3);
          die(tB(`⚠️ 다른 작업이 잠금을 보유한 채 진행 중입니다(${old.error}). 잠금 파일을 지우지 말고 잠시 후 다시 시도하세요.`, `⚠️ Another task is still holding the lock (${old.error}). Do not delete the lock file — retry shortly.`), 3);
        }
        console.log(old ? tB(`정리됨 — 직전 보유: ws=${old.ws || "?"} · pid=${old.ownerPid || "?"} · ${old.createdAt || ""}`, `Cleared — previous holder: ws=${old.ws || "?"} · pid=${old.ownerPid || "?"} · ${old.createdAt || ""}`) : tB("정리할 lease가 없습니다.", "No lease to clear."));
        return;
      }
      die(tB("사용법: session-lease show <sessionId> | session-lease clear <sessionId> --confirm", "Usage: session-lease show <sessionId> | session-lease clear <sessionId> --confirm"));
      return;
    }
    case "backlog":
      return cmdBacklog(rest); // P-12 2a — 검증 백로그 장부
    case "finding-judge":
      return cmdFindingJudge(rest); // 지적 처분 관문 해제 수단(2026-08-01) — 열린 지적 판단 기록
    case "round-judge": { // [개선 2 · 판단 관문] 구현자 판단 기록(관문 해제)
      const rcJ = cmdRoundJudge(rest);
      if (rcJ) process.exitCode = rcJ;
      return;
    }
    case "decisions": { // [개선 2 · 결정 장부] 사용자 결정 목록·선택·위임을 양식으로 출력(산문 결정 칸의 대체)
      const rcD = cmdDecisions(rest);
      if (rcD) process.exitCode = rcD;
      return;
    }
    case "rule-propose":
      return cmdRulePropose(rest); // [재편 A §2-1] 마감 판단의 명시 상신 — 관통 지침만 수칙서 후보로
    case "curate": // [CURATION v3 §3 A①] 독립 큐레이션 수동 실행(검증 무관·유계) — 제안은 대시보드 제안함에 합류(승인은 사용자)
      return void cmdCurate(rest);
    case "envelope-proposal": { // §7 증분 2 — 제안본(초안) 작성·열람·폐기. 승인(도장)은 대시보드 전용 — CLI에 없음.
      const rc8 = cmdEnvelopeProposal(rest);
      if (rc8) process.exitCode = rc8;
      return;
    }
    case "envelope-transition": { // §7 증분 2 — 중단된 승인 전이 복구(WAL 수렴)
      const rc7 = cmdEnvelopeTransition(rest);
      if (rc7) process.exitCode = rc7;
      return;
    }
    case "constraint": { // 약속 발화 포착 부품 A(CONSTRAINT-CAPTURE-DESIGN v3 §1) — 사용자 발화 원문 상신
      const rcC = cmdConstraint(rest);
      if (rcC) process.exitCode = rcC;
      return;
    }
    case "envelope-candidate": { // 거버넌스 §7 증분 1 — 수칙서 후보 장부(list/mark)
      const rc9 = cmdEnvelopeCandidate(rest);
      if (rc9) process.exitCode = rc9; // main()은 반환값을 exit code로 안 쓰므로 여기서 반영(오류가 0으로 위장 금지)
      return;
    }
    case "link":
      return cmdLink(rest);
    case "status":
      return cmdStatus();
    case "ask-active":
      return cmdAskActive(rest);
    case "timeout":
      return cmdTimeout();
    case "find":
      return cmdFind();
    case "why": { // 설계 경위 선조회(MAP-PROVENANCE-DESIGN §3) — 2트랙에서도 색인 검색만(지도 부품 미접촉)
      const q = rest.join(" ").trim();
      if (!q) die(tB('사용법: why "<질문/주제>" — 결정 이력 색인(docs/DECISIONS.md) 선조회', 'Usage: why "<question/topic>" — query the design-provenance index (docs/DECISIONS.md)'), 2);
      const MPV = require(path.join(__dirname, "map-provenance.js"));
      const ws9 = configWs();
      const repo9 = ((resolveScoutRepo(ws9, loadContract(ws9)) || {}).repo) || ws9; // R3 blocker②: CL 미선언 참조로 즉사하던 경로 — 구조분해 임포트 사용(CLI 실행 시험으로 잠금)
      const r9 = MPV.queryProvenance(repo9, q);
      // R3 blocker③: 성패 고지 모순 금지 — 영수증 문구는 receiptOk에 따라 한 가지만.
      const rcpt = r9.receiptOk === false
        ? tB("조회 영수증 기록 실패 — 잠금 파일 상태를 확인하세요(" + MPV.PROVENANCE_USAGE_FILE + ".lock)", "query receipt FAILED — check the lock file (" + MPV.PROVENANCE_USAGE_FILE + ".lock)")
        : tB("조회 영수증 기록됨", "query receipted");
      if (r9.receiptOk === false) process.stdout.write(tB("[주의] ", "[caution] ") + rcpt + "\n");
      if (r9.index !== "ok") { process.stdout.write(tB("결정 색인 없음(" + MPV.INDEX_REL + ") — ", "No decisions index (" + MPV.INDEX_REL + ") — ") + rcpt + "\n"); break; }
      if (!r9.matches.length) { process.stdout.write(tB("매칭 0건 — ", "0 matches — ") + rcpt + tB("(얕은 '없다' 종료 방지: 정본 설계 문서 개정 이력도 확인하세요)\n", " (also check design-doc revision history before concluding 'absent')\n")); break; }
      for (const m of r9.matches) process.stdout.write("  " + m.entry.id + " · " + m.entry.title + "\n    " + tB("결정: ", "decision: ") + m.entry.decision + "\n    " + tB("정본: ", "source: ") + m.entry.source + "\n");
      break;
    }
    case "verifier-provider": { // [VerifierProvider §4] 현재값 표시/전환(계약 patch 경유)
      const vpv = (rest[0] || "").trim();
      if (!vpv) { process.stdout.write(JSON.stringify({ verifierProvider: normVerifierProvider(loadContract(configWs())) }) + "\n"); break; }
      if (!VERIFIER_PROVIDERS.includes(vpv)) die(tB(`사용법: verifier-provider [codex|claude] — 인자 없이 실행하면 현재값을 보여줍니다.`, `Usage: verifier-provider [codex|claude] — run without an argument to show the current value.`), 2);
      if (!patchContractFields(configWs(), loadLang(), { verifierProvider: vpv })) die(tB("계약 저장 실패 — 파일 잠금/권한을 확인하세요.", "Failed to save the contract — check file locks/permissions."), 1);
      process.stdout.write(JSON.stringify({ verifierProvider: vpv, saved: true }) + "\n");
      break;
    }
    case "doctor":
      return cmdDoctor();
    case "detect-home":
      return cmdDetectHome();
    case "pref":
      return cmdPref(rest);
    default:
      process.stdout.write(
        "codex-bridge: ask-start | ask-wait | ask-job | ask | ask-active | timeout | link | status | find | doctor | detect-home | pref\n" +
          '  node codex-bridge.js ask-start --allow-new "<프롬프트>"  (내구 작업 시작 — 즉시 job id 반환)\n' +
          "  node codex-bridge.js ask-wait <job-id>                 (45초씩 결과 대기 — pending이면 반복)\n" +
          "  node codex-bridge.js ask-job status [job-id] | ask-job clear <job-id> --confirm\n" +
          '  node codex-bridge.js ask "<프롬프트>"              (Codex-Codex 모드에선 미지원 — ask-start를 사용)\n' +
          '  node codex-bridge.js ask --allow-new "<프롬프트>"\n' +
          '  node codex-bridge.js ask --force-new "<프롬프트>"  (엉뚱 폴더 방어 무시, 이 폴더에 새 세션 강제)\n' +
          '  node codex-bridge.js ask --net "<프롬프트>"        (이 1회만 네트워크 허용 — 파일은 읽기전용 유지, 원격 확인용)\n' +
          '  node codex-bridge.js ask --force-resend "<프롬프트>" (같은 요청 진행 중 차단을 의식적으로 우회)\n' +
          "  node codex-bridge.js ask-active status | ask-active clear --confirm\n" +
          '  node codex-bridge.js finding-judge [<id> <fix-fact|fix-gap|rebut|park> --note "근거(12자+·park 제외)"] [--campaign <id>]  (열린 지적 판단 기록 — 미판단이 남으면 다음 검증이 시작되지 않음)\n' +
          '  node codex-bridge.js rule-propose <findingId> --why "<왜 관통 지침인지 1줄>"  (마감 판단 (c)관통 지침만 수칙서 후보로 — 효력은 사용자 도장부터)\n' +
          "  node codex-bridge.js timeout  (대시보드 검증 대기시간과 외부 호출 최소 timeout 확인)\n" +
          "  node codex-bridge.js link <id> | link --last\n" +
          "  node codex-bridge.js status | find | doctor | detect-home\n" +
          "  node codex-bridge.js pref [set model=<m> reasoning=<low|medium|high> | clear]\n",
      );
  }
}

if (require.main === module) main(); // CLI로 직접 실행할 때만. require 시엔 테스트용 export만.
// saveLinks는 export하지 않는다 — links 기록은 updateLinks(CAS+P-1 손상 거부) 단일 관문만(검증 지적: 우회 통로 봉인).
module.exports = { rejudgeTailFor, HOLD_EXIT_CODE, v2StaticDirective, v2DynamicData, recordDeliveryBeforeCall, postflightDelivery, applyPostflightHold, postflightHeld, implementerRebuttalsFor, latestAskJobIdFor, armScopeDemotedJudge, cmdRoundJudge, cmdDecisions, readCanonicalEnvJob, corruptAskJobFiles, withContract, assertContractInjectionFits, checkCitedEvidence, resolveCitedPath, flagEvidence, flagVerdict, flagLedgerConfirms, updateLinks, loadLinks, recordLink, clearStaleVerifier, verifierLinkForMode, resolveLink, modelPrefFor, threadIdFromJsonLine, LINKS_FILE, ASK_JOBS_DIR, verifyTimeoutMin, minimumCallerTimeoutMs, askRequest, askJobFile, readAskJob, activeAskJob, citedResolvedBasenames, citedFilesUnseen, citedFilesUnseenExact, shouldSuppressUnseenRepeat, shouldSuppressUnseenAcked, maybeDispatchChallenge, newestRolloutSinceForWs, readFirstJsonLine, parseLastTurn, netArgs, netNote, writeProof, unretrievedSameTurnJob, linksFileState, reserveVerifyBudgetGate, budgetNoticeLines, patchAskJobFile, beginVerifyAttempt, mapAttachSurface, machineFindingsLayer, findingDispositionGate, cmdFindingJudge, campaignSnapFor, v2DirectiveFor, projectResolvedAcks, currentCampaignIdFor, breakdownNoticeFor, envelopeCandidateNoticeFor, computeEnvelopeCandidatesFor, envelopeSliceFor, integrityReviewLine, resolveCodex, parseConstraintHandling, memReceiptLine, acquireAskJobLock, releaseAskJobLock, askJobCancelIntentFile };
