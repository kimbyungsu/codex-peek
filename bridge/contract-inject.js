#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 고정 계약(contract.claude) + (검증 모드 시) 2트랙 지시를 매 턴 주입.
// 둘 다 비어/꺼져 있으면 아무것도 주입하지 않는다(토큰 비용 0).
// 추가로 '지금 Claude가 도는 작업 폴더'를 active.json에 기록 → 대시보드가 VS Code 첫 폴더가 아니라
// 실제 활성 폴더를 따라가서, "보는 세션 = 검증 가는 세션"이 항상 일치하게 한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, loadLang, buildInjection, buildVerifyDirective, buildScoutDirective, atomicWrite, BRIDGE_DIR, ACTIVE_DIR, writePhase, patchContractFields, contractReadState, activeAskJobFor, phaseBusy, contractLockIssue } = require("./contract-lib.js");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let hook = {};
  try {
    hook = JSON.parse(input) || {}; // "null" 등으로 파싱돼도 객체 유지(hook.cwd 크래시 방지)
  } catch {
    /* ignore */
  }
  // 이 턴의 작업 폴더 — active.json 기록과 계약 로드에 '동일하게' 적용해 둘의 키가 어긋나지 않게 한다.
  const ws = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();

  // 활성 작업 폴더 기록 → 대시보드/configWs가 VS Code 첫 폴더가 아니라 이 폴더(연 폴더)를 따라가게.
  const sid = hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || "";
  const activePayload = JSON.stringify({
    workspace: ws,
    claudeSession: sid,
    // §5.3: 플랜 모드 감지·라이브표시용. Claude Code UserPromptSubmit 입력의 permission_mode
    // ("plan"이면 플랜 모드). 문서 예시는 "default"라 실제 값은 실로그로 확인(빈값=미노출).
    permissionMode: (hook && typeof hook.permission_mode === "string") ? hook.permission_mode : "",
    ts: new Date().toISOString(),
  });
  // (1) 레거시 단일 active.json — 확장(activeWorkspace)·세션ID 없는 폴백 경로가 읽음.
  try { atomicWrite(path.join(BRIDGE_DIR, "active.json"), activePayload); } catch { /* ignore */ }
  // (2) 세션별 active(active/<claudeSession>.json) — configWs가 1순위로 읽어, 다른 창이 단일 active.json을
  //     덮어써도 '이 대화'의 연 폴더를 레이스 없이 얻는다. 파일명은 traversal 방지로 안전 문자만.
  if (sid) {
    try {
      const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, "");
      if (safe) atomicWrite(path.join(ACTIVE_DIR, safe + ".json"), activePayload);
    } catch { /* ignore */ }
  }

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
    switchNotice = T(
      "[Codex Bridge] 운용 모드 자동 전환: 설정은 코덱스-코덱스였지만 이 질문이 Claude에서 시작되어 클로드-코덱스로 전환했습니다(질문 호스트 기준). 의도와 다르면 대시보드에서 되돌리세요. 이번 턴부터 클로드-코덱스 규칙·검증 설정이 적용됩니다.",
      "[Codex Bridge] Harness mode auto-switched: the setting was Codex-Codex, but this prompt started in Claude, so it switched to Claude-Codex (prompt host wins). Revert from the dashboard if unintended. Claude-Codex rules and verification apply from this turn.");
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
  if (switchNotice) parts.push(switchNotice); // 자동 전환 고지는 항상 최상단(다른 주입이 없어도 단독 출력)
  try {
    const c = contract || loadContract(ws, lang);
    // 사용자 계약 주입 게이트: off=안 함 / plan=플랜 모드(permission_mode==="plan")일 때만 / always=매 턴.
    // (검증모드 directive는 이 게이트와 무관한 별도 축.)
    const planActive = hook.permission_mode === "plan";
    const injectClaude = c.claudeInjectMode === "always" || (c.claudeInjectMode === "plan" && planActive);
    if (injectClaude) {
      const rules = buildInjection(c.claude, "Claude Code", c.claudeChecklist);
      if (rules) parts.push(rules);
    }
    if (c.verifyMode && c.verifyMode !== "off") parts.push(buildVerifyDirective(c.verifyMode, undefined, c.verifyProfile)); // P-12 프로필(주입 시점 실효값)
    // 탐색(3트랙) 자동 지시 — 지도 없음/낡음일 때 그 상태에 1회만(상태 서명 기반·advisory). 실패해도 훅을 막지 않음.
    try { const sd = buildScoutDirective(ws, c); if (sd) parts.push(sd); } catch { /* advisory */ }
    // P1: Project MAP 비차단 bootstrap — 훅은 유계 신호+상태 고지(1회)+detach 기동만(실행·전수 판독 금지:
    // MAP-V2-DESIGN 1-3). 2트랙 게이트는 hookTick 내부 최선행(scoutMode!=='on'→즉시 null — 파일 0·spawn 0).
    // 구버전 브릿지(map-bootstrap.js 부재)·실패는 advisory(훅을 막지 않음).
    try { const adv = require("./map-bootstrap.js").hookTick(ws); if (adv) parts.push(adv); } catch { /* advisory */ }
  } catch {
    parts = switchNotice ? [switchNotice] : []; // 주입 조립 실패에도 전환 고지는 유지(사용자 인지 채널)
  }
  if (!parts.length) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n\n") },
    }),
  );
  process.exit(0);
});
