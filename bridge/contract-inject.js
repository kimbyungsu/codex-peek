#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 고정 계약(contract.claude) + (검증 모드 시) 2트랙 지시를 매 턴 주입.
// 둘 다 비어/꺼져 있으면 아무것도 주입하지 않는다(토큰 비용 0).
// 추가로 '지금 Claude가 도는 작업 폴더'를 active.json에 기록 → 대시보드가 VS Code 첫 폴더가 아니라
// 실제 활성 폴더를 따라가서, "보는 세션 = 검증 가는 세션"이 항상 일치하게 한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, buildInjection, buildVerifyDirective, atomicWrite, BRIDGE_DIR, ACTIVE_DIR, writePhase } = require("./contract-lib.js");

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

  // 라이브 진행: 턴 시작 = 'Claude 작업중' + 라운드 0 리셋(이 턴의 ask 횟수는 codex-bridge가 증가시킴).
  try {
    writePhase("claude-working", {
      round: 0,
      session: hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || "",
      workspace: ws,
    });
  } catch { /* 진행표시는 best-effort — 실패해도 훅 동작 막지 않음 */ }

  let parts = [];
  try {
    const c = loadContract(ws);
    // 사용자 계약 주입 게이트: off=안 함 / plan=플랜 모드(permission_mode==="plan")일 때만 / always=매 턴.
    // (검증모드 directive는 이 게이트와 무관한 별도 축.)
    const planActive = hook.permission_mode === "plan";
    const injectClaude = c.claudeInjectMode === "always" || (c.claudeInjectMode === "plan" && planActive);
    if (injectClaude) {
      const rules = buildInjection(c.claude, "Claude Code", c.claudeChecklist);
      if (rules) parts.push(rules);
    }
    if (c.verifyMode && c.verifyMode !== "off") parts.push(buildVerifyDirective(c.verifyMode));
  } catch {
    parts = [];
  }
  if (!parts.length) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n\n") },
    }),
  );
  process.exit(0);
});
