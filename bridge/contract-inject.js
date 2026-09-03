#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 고정 계약(contract.claude) + (검증 모드 시) 2트랙 지시를 매 턴 주입.
// 둘 다 비어/꺼져 있으면 아무것도 주입하지 않는다(토큰 비용 0).
// 추가로 '지금 Claude가 도는 작업 폴더'를 active.json에 기록 → 대시보드가 VS Code 첫 폴더가 아니라
// 실제 활성 폴더를 따라가서, "보는 세션 = 검증 가는 세션"이 항상 일치하게 한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isRealHookInput, folderChangeOf, folderChangeNotice, effectiveRuleCheck, ruleCheckRecord, ruleCheckFp8, latestRuleCheckRow, loadContract, loadLang, buildInjection, buildVerifyDirective, buildVerifyDirectiveSlim, claudeStaticParts, claudeDeliveryPlan, claudeStaticBlock, claudeDeliveryStatusLine, implementerEnvelopeInjectParts, readClaudeDirectiveReset, clearClaudeDirectiveResetMarker, applyClaudeTurnBudget, harnessModeSwitchNotice, buildScoutDirective, verifyCampaignProgress, atomicWrite, BRIDGE_DIR, ACTIVE_DIR, writePhase, patchContractFields, contractReadState, activeAskJobFor, phaseBusy, contractLockIssue, turnAnchorOf, writeConstraintTurnSnapshot, constraintRepoKeyFor } = require("./contract-lib.js");

// [P7 ⓐ 2026-09-01] 불러오기(require)만 됐을 때는 아무것도 하지 않는다 — stdin도 읽지 않고 앵커도 쓰지 않는다(2026-08-28 로드 시험이 앵커를 덮은 실사고).
if (require.main !== module) return;
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let hook = {};
  try {
    hook = JSON.parse(input) || {}; // "null" 등으로 파싱돼도 객체 유지(hook.cwd 크래시 방지)
  } catch {
    /* ignore */
  }
  // [P7 ⓐ] 진짜 훅 입력(stdin에 이벤트 이름·세션 id)일 때만 진행 — 빈/부분 입력(수동 실행·로드 시험)은 무동작 종료(앵커 없이 주입만 하면 이후 ask-start가
  // 엉뚱 폴더를 읽으므로 주입도 하지 않는다). 환경변수의 세션 id는 판정 근거가 아니다.
  if (!isRealHookInput(hook)) process.exit(0);
  // 이 턴의 작업 폴더 — active.json 기록과 계약 로드에 '동일하게' 적용해 둘의 키가 어긋나지 않게 한다.
  const ws = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();

  // 활성 작업 폴더 기록 → 대시보드/configWs가 VS Code 첫 폴더가 아니라 이 폴더(연 폴더)를 따라가게.
  const sid = hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || "";
  const activeTs = new Date().toISOString();
  // [약속 발화 포착 §1] 턴 원문 스냅샷 — `constraint add` CLI의 유일 대조 권위(구현모델 작문·기억 재구성 차단).
  // anchor=sha1(sessionId|active.ts) 앞 16자(캠페인 앵커와 동일 원천·턴마다 유일). 실패=필드 미기록(그 턴 상신 불가
  // — fail-closed)·훅 동작은 막지 않음(best-effort).
  let constraintAnchor = "", constraintSourceHash = "", constraintRepoKey = ""; // [ab-1] 원문 시점 정찰 대상 지문 — 스냅숏과 같은 active 레코드에 기록(ask-start 재계산 금지)
  try {
    const ptxt = (hook && typeof hook.prompt === "string") ? hook.prompt : "";
    if (ptxt && sid) {
      // [검증 2회차 blocker②] 계약 판독은 이 훅에서 한 번(cSnap0) — 스냅숏 기록 뒤 계약을 다시 읽지 않는다
      // (두 판독 사이 다른 창의 정찰 대상 전환=A 원문+B 표식 경합). 표식은 스냅숏 "이전"에 확정하고 같은 레코드에 쓴다.
      let cSnap0 = null; try { cSnap0 = loadContract(ws); } catch { cSnap0 = null; }
      const rk0 = cSnap0 ? (constraintRepoKeyFor(ws, cSnap0) || "") : "";
      const anc = turnAnchorOf(sid, activeTs);
      const snap = writeConstraintTurnSnapshot(ws, anc, ptxt);
      if (snap.ok) { constraintAnchor = anc; constraintSourceHash = snap.sourceHash; constraintRepoKey = rk0; }
    }
  } catch { /* best-effort */ }
  // [§4-B ① Claude 쪽] 이 세션 앵커의 규약 전달 기록(directive)·세션 시작 훅 리셋(directiveReset)을 덮어쓰기 전에 읽어 보존한다
  let prevDirective = null, prevReset = null, prevAnchor0 = null;
  const safeSid = String(sid).replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    if (safeSid) {
      let prev0 = null; try { prev0 = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, safeSid + ".json"), "utf8")); } catch { prev0 = null; }
      if (prev0 && typeof prev0 === "object") { prevAnchor0 = prev0; prevDirective = prev0.directive && typeof prev0.directive === "object" ? prev0.directive : null; }
      prevReset = readClaudeDirectiveReset(safeSid, prev0); // 앵커의 리셋 표시 또는 폴백 마커(세션 시작 훅이 앵커를 못 썼을 때)
    }
  } catch { prevDirective = null; prevReset = null; }
  // [P7 ⓑ] 이전 앵커의 폴더와 다르면 변경 기록(해제 전까지 승계) — ask-start가 이 기록을 보면 시작하지 않는다(--folder-changed-ok 로만).
  const folderChange = folderChangeOf(prevAnchor0, ws);
  // [RULE-COMPLIANCE §3 A] 이 턴의 규칙 점검 결정(required|disabled·규칙 목록 지문·개수)을 '첫 앵커 쓰기'에 기록 — 출력이 없는 의도적 미주입 턴에도 남는다.
  let cRC = null; try { cRC = loadContract(ws); } catch { cRC = null; }
  const ruleCheck = ruleCheckRecord(effectiveRuleCheck(cRC || {}, "claude", hook.permission_mode === "plan" ? "plan" : "normal"), constraintAnchor || "");
  const anchorBase = {
    workspace: ws,
    claudeSession: sid,
    ruleCheck,
    ...(folderChange ? { folderChange } : {}),
    // §5.3: 플랜 모드 감지·라이브표시용. Claude Code UserPromptSubmit 입력의 permission_mode
    // ("plan"이면 플랜 모드). 문서 예시는 "default"라 실제 값은 실로그로 확인(빈값=미노출).
    permissionMode: (hook && typeof hook.permission_mode === "string") ? hook.permission_mode : "",
    ...(constraintAnchor ? { constraintAnchor, constraintSourceHash, ...(constraintRepoKey ? { constraintRepoKey } : {}) } : {}), // 약속 발화 포착 — CLI가 이 턴의 스냅샷을 찾는 열쇠(+저장소 결속 ab-1)
    ts: activeTs,
  };
  const activePayload = JSON.stringify({ ...anchorBase, ...(prevDirective ? { directive: prevDirective } : {}), ...(prevReset ? { directiveReset: prevReset } : {}) }); // 전달 기록 보존(계획 확정 전 덮어쓰기 손실 방지)
  const writeAnchors = (payload) => {
    let okG = false, okS = true;
    try { okG = atomicWrite(path.join(BRIDGE_DIR, "active.json"), payload) === true; } catch { okG = false; }
    if (sid) { try { const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, ""); if (safe) okS = atomicWrite(path.join(ACTIVE_DIR, safe + ".json"), payload) === true; } catch { okS = false; } }
    if (!okG || !okS) { try { process.stderr.write("[Codex Bridge] anchor write failed (session " + String(sid) + ") — the Stop hook will treat the rule check as required\n"); } catch { /* 진단 실패 무해 */ } } // [RULE-COMPLIANCE] 침묵 금지·주입은 계속
  };
  // (1) 레거시 단일 active.json — 확장(activeWorkspace)·세션ID 없는 폴백 경로가 읽음.
  // (2) 세션별 active(active/<claudeSession>.json) — configWs가 1순위로 읽어, 다른 창이 단일 active.json을
  //     덮어써도 '이 대화'의 연 폴더를 레이스 없이 얻는다. 파일명은 traversal 방지로 안전 문자만.
  writeAnchors(activePayload);

  // 환경 적응(확장의 CLAUDE_HOME 해석용 — 이슈#1 CODEX_HOME 자동탐지와 '동일하게'): 확장 호스트는 CLAUDE_CONFIG_DIR을 못 볼 수
  // 있으나(특히 *nix GUI 실행), 이 훅은 Claude 프로세스에서 실제 transcript_path를 받는다. 거기서 Claude 설정폴더(= projects의 부모)를
  // 도출해 claude-home.txt(codex-home.txt 대칭)에 적어 둔다. 확장은 env → 이 파일 → ~/.claude 순으로 해석한다. 전부 best-effort.
  try {
    const tp = (hook && typeof hook.transcript_path === "string") ? hook.transcript_path : "";
    if (tp) {
      const projectsDir = path.dirname(path.dirname(tp)); // <CLAUDE_HOME>/projects/<proj>/<id>.jsonl → <CLAUDE_HOME>/projects
      if (path.basename(projectsDir) === "projects") { // 구조 확인(엉뚱한 경로 기록 방지)
        const claudeHome = path.dirname(projectsDir);   // <CLAUDE_HOME>
        const chf = path.join(BRIDGE_DIR, "claude-home.txt");
        let prev = ""; try { prev = fs.readFileSync(chf, "utf8").trim(); } catch { /* 최초엔 없음 */ }
        if (claudeHome && claudeHome !== prev) atomicWrite(chf, claudeHome); // 변경 시에만(churn 방지)
      }
    }
  } catch { /* best-effort — 훅 동작 막지 않음 */ }

  // [P-9 자동 전환] 언어 슬롯 1회 스냅샷 — 아래 계약 판독과 (전환 시) 패치가 같은 슬롯에 결속(설계 ⓖ).
  const lang = loadLang();
  const T = (ko, en) => (lang === "en" ? en : ko);
  const blockPrompt = (reason) => { process.stdout.write(JSON.stringify({ decision: "block", reason })); process.exit(0); };

  // 계약 파일이 '존재하는데 손상'이면 모드·검증 권위를 판정할 수 없다 — loadContract의 기본값 축소로
  // 게이트·모드가 조용히 꺼지는 fail-open 차단(codex-hook의 contractReadState 가드와 대칭. 부재=정상).
  try {
    if (contractReadState(ws, lang) === "corrupt") blockPrompt(T(
      "[Codex Bridge] 프로젝트 계약 파일이 손상되어 운용 모드·검증 설정을 판정할 수 없습니다. 대시보드에서 계약을 다시 저장한 뒤 프롬프트를 다시 보내세요.",
      "[Codex Bridge] The project contract file is corrupt, so the harness mode and verification settings cannot be judged. Re-save the contract from the dashboard, then resend the prompt."));
  } catch { /* 판정 자체가 실패하면 기존 동작 유지(아래 loadContract catch가 처리) */ }

  let contract;
  try { contract = loadContract(ws, lang); } catch { contract = null; }
  // [P-9 자동 전환·사례 ①④] 설정=코덱스-코덱스인데 질문이 Claude에서 시작 — 질문 호스트가 사용자 의도의
  // 기준점(사용자 결정 2026-07-15). 안전 가드(진행 중 검증 작업·상대 구현 턴 개연성·계약 기록 실패)를 전부
  // 통과할 때만 클로드-코덱스로 전환하고, 하나라도 걸리면 이 프롬프트 자체를 차단한다(전환 불가+경고만 하고
  // 진행하면 무게이트 턴이 되는 구멍 — 설계 ⓓ fail-closed).
  let switchNotice = "";
  if (contract && contract.harnessMode === "codex-codex") {
    const job = activeAskJobFor(ws);
    if (job) blockPrompt(T(
      `[Codex Bridge] 운용 모드가 코덱스-코덱스인데 이 질문은 Claude에서 시작됐습니다. 자동 전환하려 했으나 진행 중인 검증 작업(${job.id})이 있어 전환하면 그 검증이 무효가 됩니다. 작업이 끝난 뒤 다시 보내거나, 대시보드에서 모드를 직접 전환하세요.`,
      `[Codex Bridge] The harness mode is Codex-Codex but this prompt started in Claude. Auto-switch was halted because a verification job (${job.id}) is in flight and switching would invalidate it. Resend after it finishes, or switch the mode from the dashboard.`));
    const busy = phaseBusy(ws, ["codex-implementing", "codex-verifying", "rejudging"], 25 * 60 * 1000);
    if (busy && busy.session && busy.session !== sid) blockPrompt(T(
      `[Codex Bridge] 운용 모드가 코덱스-코덱스인데 이 질문은 Claude에서 시작됐습니다. 자동 전환하려 했으나 구현 Codex 쪽 진행 흔적(${busy.phase})이 최근에 있어 전환하면 그 턴의 게이트가 무장해제됩니다. 구현 대화가 끝난 뒤 다시 보내거나, 대시보드에서 모드를 직접 전환하세요.`,
      `[Codex Bridge] The harness mode is Codex-Codex but this prompt started in Claude. Auto-switch was halted because the implementer side shows recent activity (${busy.phase}); switching would disarm that turn's gate. Resend after it finishes, or switch the mode from the dashboard.`));
    const patched = patchContractFields(ws, lang, {
      harnessMode: "claude-codex",
      modeSwitch: { by: "claude-hook", from: "codex-codex", to: "claude-codex", at: new Date().toISOString(), session: sid, lang },
    });
    if (!patched) {
      // 잠금 진단(3차 지적 3 → 4차 5상태): 해시 파일명이라 정확 경로·PID·상태를 안내. 삭제 안내는 dead(ESRCH)에만.
      const li = contractLockIssue(ws, lang);
      const hint = !li ? T(" (잠금 파일 없음 — 권한/손상 계열일 수 있습니다.)", " (No lock file found — likely permission/corruption.)")
        : li.state === "alive" ? T(` 다른 저장이 진행 중입니다: ${li.lockPath} (프로세스 ${li.pid} 실행 중) — 잠시 후 재시도하세요.`, ` Another save is in progress: ${li.lockPath} (process ${li.pid} running) — retry shortly.`)
        : li.state === "dead" ? T(` 잔존 잠금: ${li.lockPath} (보유 프로세스 ${li.pid} 종료 확인됨) — 이 파일을 삭제한 뒤 재시도하세요.`, ` Stale lock: ${li.lockPath} (owner process ${li.pid} confirmed gone) — delete this file and retry.`)
        : li.state === "owner-unverified" ? T(` 잠금 보유자 확인 불가: ${li.lockPath} (프로세스 ${li.pid} — 다른 사용자의 프로세스일 수 있음). 파일을 삭제하지 말고 그 프로세스 종료 후 재시도하세요.`, ` Lock owner unverified: ${li.lockPath} (process ${li.pid} — may belong to another user). Do not delete the file; retry after that process ends.`)
        : T(` 잠금 파일 상태를 판독할 수 없습니다: ${li.lockPath} — 임의 삭제하지 말고 잠시 후 재시도하세요.`, ` Lock file state unreadable: ${li.lockPath} — do not delete it; retry shortly.`);
      blockPrompt(T(
        "[Codex Bridge] 운용 모드 자동 전환에 실패했습니다(계약 파일 기록 불가 — 잠금/권한/손상). 대시보드에서 모드를 직접 전환한 뒤 프롬프트를 다시 보내세요.",
        "[Codex Bridge] Failed to auto-switch the harness mode (contract file not writable — lock/permission/corruption). Switch the mode from the dashboard, then resend the prompt.") + hint);
    }
    try { contract = loadContract(ws, lang); } catch { contract = null; }
    if (!contract || contract.harnessMode !== "claude-codex") blockPrompt(T(
      "[Codex Bridge] 운용 모드 자동 전환 결과를 확인하지 못했습니다. 대시보드에서 모드를 확인·전환한 뒤 프롬프트를 다시 보내세요.",
      "[Codex Bridge] Could not confirm the auto-switched harness mode. Check/switch the mode from the dashboard, then resend the prompt."));
    switchNotice = harnessModeSwitchNotice(lang); // 코드 소유 문장 단일 출처(길이 상한 300 — 매 턴 예산의 고정 조각)
  }

  // 라이브 진행: 턴 시작 = 'Claude 작업중' + 라운드 0 리셋(이 턴의 ask 횟수는 codex-bridge가 증가시킴).
  try {
    writePhase("claude-working", {
      round: 0,
      session: hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || "",
      workspace: ws,
    });
  } catch { /* 진행표시는 best-effort — 실패해도 훅 동작 막지 않음 */ }

  let parts = [];
  let dlvPlan = null; // 전달 계획(try 밖에서도 finalize가 읽는다)
  const advisories = []; // [§4-B ④] 안내(지도 상태·부트스트랩)
  if (folderChange) advisories.push(folderChangeNotice(folderChange, lang)); // [P7 ⓑ] 구현자에게도 같은 사실을 1줄로(검증 시작 시 거부되는 이유를 미리)
  try { // [RULE-COMPLIANCE §3 C] 직전 턴이 자가점검 미기재(상한 해제)로 끝났으면 1줄 — 코드 소유 문장·규칙 재동봉 없음(이 턴 머리에 이미 있음)
    const lastRC = sid ? latestRuleCheckRow(ws, "claude", sid) : null;
    const prevTurnAnchor = prevAnchor0 ? String(prevAnchor0.constraintAnchor || prevAnchor0.ts || "") : ""; // '직전 턴'에만 결속(최신 행이 옛 턴이면 침묵 — 1회차 보완)
    if (lastRC && lastRC.closedBy === "attempt-cap" && prevTurnAnchor && String(lastRC.turnAnchor || "") === prevTurnAnchor) advisories.push(lang === "en" ? "[Rule self-check] The previous turn ended without the check block (repeat-block cap released) — the omission is on the ledger." : "[규칙 자가점검] 직전 턴이 점검 블록 없이 끝났습니다(반복 차단 상한 해제) — 미기재로 장부에 남았습니다.");
  } catch { /* advisory */ }
  if (switchNotice) parts.push(switchNotice); // 자동 전환 고지는 항상 최상단(다른 주입이 없어도 단독 출력)
  try {
    const c = contract || loadContract(ws, lang);
    // 사용자 계약 주입 게이트: off=안 함 / plan=플랜 모드(permission_mode==="plan")일 때만 / always=매 턴.
    // (검증모드 directive는 이 게이트와 무관한 별도 축.)
    const planActive = hook.permission_mode === "plan";
    const injectClaude = c.claudeInjectMode === "always" || (c.claudeInjectMode === "plan" && planActive);
    if (injectClaude) {
      const rules = buildInjection(c.claude, "Claude Code", c.claudeChecklist, undefined, ruleCheck.mode === "required" ? ruleCheckFp8(ruleCheck) : "");
      if (rules) parts.push(rules);
    }
    dlvPlan = null; // [§4-B ① Claude 쪽] 정적 지시=세션 1회(첫 턴·리셋·세대 변경에만 전문), 매 턴=명령 줄+진행도+상태 줄
    let provenanceInStatic = false, envelopeDynOnly = false;
    if (c.verifyMode && c.verifyMode !== "off") {
      const campaignId = sid ? "cl:" + sid + ":" + activeTs : "";
      const progress9 = verifyCampaignProgress(ws, campaignId, c.verifyBudget);
      let pn9 = ""; try { pn9 = require("./map-provenance.js").buildProvenanceNotice(ws, c) || ""; } catch { pn9 = ""; }
      const sp9 = claudeStaticParts(ws, c, lang, { provenance: pn9 });
      dlvPlan = claudeDeliveryPlan(prevDirective, prevReset, sp9);
      if (dlvPlan.mode === "full") parts.push(claudeStaticBlock(sp9, lang));
      const slimText9 = buildVerifyDirectiveSlim(c.verifyMode, undefined, c.verifyProfile, progress9);
      parts.push(slimText9);
      const sentAt9 = dlvPlan.mode === "full" ? activeTs : String((prevDirective && prevDirective.sentAt) || activeTs);
      const statusText9 = claudeDeliveryStatusLine(dlvPlan, lang, sentAt9);
      parts.push(statusText9);
      dlvPlan.budget = { fixed: [...(switchNotice ? [switchNotice] : []), slimText9, statusText9] }; // 고정 조각(전환 고지 포함)·구분자까지 예산 계산
      dlvPlan.record = { gen: dlvPlan.gen, parts: dlvPlan.parts, sentAt: sentAt9, lastTurnTs: activeTs, reason: dlvPlan.reason };
      provenanceInStatic = true; envelopeDynOnly = true; // 경위 안내·수칙 인지 전문은 정적 블록에 속함(세대 결속)
    }
    // 탐색(3트랙) 자동 지시 — 지도 없음/낡음일 때 그 상태에 1회만(상태 서명 기반·advisory). 실패해도 훅을 막지 않음.
    try { const sd = buildScoutDirective(ws, c); if (sd) advisories.push(sd); } catch { /* advisory */ }
    // 설계 경위 선조회 안내(MAP-PROVENANCE-DESIGN §3) — scoutMode 독립(2트랙에서도 why 동작)·색인 존재 시만 1줄.
    if (!provenanceInStatic) { try { const pn = require("./map-provenance.js").buildProvenanceNotice(ws, c); if (pn) parts.push(pn); } catch { /* advisory */ } }
    // P1: Project MAP 비차단 bootstrap — 훅은 유계 신호+상태 고지(1회)+detach 기동만(실행·전수 판독 금지:
    // MAP-V2-DESIGN 1-3). 2트랙 게이트는 hookTick 내부 최선행(scoutMode!=='on'→즉시 null — 파일 0·spawn 0).
    // 구버전 브릿지(map-bootstrap.js 부재)·실패는 advisory(훅을 막지 않음).
    try { const adv = require("./map-bootstrap.js").hookTick(ws); if (adv) advisories.push(adv); } catch { /* advisory */ }
    // [§4-B ④] 안내는 매 턴 예산(하네스 소유분 1,500=slim 700+상태 250+안내 550) 안에서만 — 검증 모드 밖(전달 계획 없음)은 종전 그대로
    if (dlvPlan && dlvPlan.budget) {
      const bt9 = applyClaudeTurnBudget({ fixed: dlvPlan.budget.fixed, advisories }, lang);
      for (const tx of bt9.texts) parts.push(tx); dlvPlan.budget.clipped = bt9.clipped;
      if (bt9.overflow) { try { process.stderr.write((lang === "en" ? "[Codex Bridge] per-turn fixed pieces exceed the budget (" : "[Codex Bridge] 매 턴 고정 조각이 예산을 넘음(") + bt9.fixedLen + "/" + require("./contract-lib.js").claudeTurnBudgetTotal() + (lang === "en" ? ") — code-defect signal; advisories omitted\n" : ") — 코드 결함 신호·안내 전량 생략\n")); } catch { /* 안내 실패 무해 */ } }
    }
    else for (const tx of advisories) parts.push(tx);
    // [4b 이중 배달 §4] 구현자 인지 — 코어 ab 전문(수칙서 활성 시 상시)+이번 턴 결속 선별 캐시/미리보기 안내.
    // LLM 호출 없음(파일 판독뿐)·실패=advisory(훅을 막지 않음).
    try {
      const ep = implementerEnvelopeInjectParts(ws, c, lang, constraintSourceHash || "", constraintAnchor || "");
      if (ep) { if (envelopeDynOnly) { const dyn9 = String(ep.dyn || "").replace(/^\n+/, ""); if (dyn9) parts.push(dyn9); } else { const ei = ep.dyn ? ep.ab + "\n" + ep.dyn : ep.ab; if (ei) parts.push(ei); } }
    } catch { /* advisory */ }
  } catch {
    parts = switchNotice ? [switchNotice] : []; // 주입 조립 실패에도 전환 고지는 유지(사용자 인지 채널)
    dlvPlan = null; // 조립 실패=전달 기록 갱신 없음(다음 턴 전문 — 안전 방향)
  }
  if (!parts.length) process.exit(0);
  // 전달 기록 확정은 '출력이 실제로 전달된 뒤'(stdout write 콜백) — 출력 전 종료·파이프 실패면 기록하지 않아 다음 턴이 전문을 다시 보낸다
  // (확인 검증 1회차 blocker②: 기록 선행이면 '기록 있음=전문 수신'이 성립하지 않는다). 리셋 마커도 그때 소거.
  const outJson = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n\n") } });
  const finalize = (err) => {
    if (!err && dlvPlan && dlvPlan.record) {
      try { writeAnchors(JSON.stringify({ ...anchorBase, directive: dlvPlan.record })); if (safeSid) clearClaudeDirectiveResetMarker(safeSid); } catch { /* 기록 실패=다음 턴 전문 */ }
    }
    process.exit(0);
  };
  try {
    const flushed = process.stdout.write(outJson, (err) => finalize(err));
    process.stdout.once("error", () => finalize(new Error("stdout-error")));
    void flushed;
  } catch (e) { finalize(e); }
});
