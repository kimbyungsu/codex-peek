#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 고정 계약(contract.claude) + (검증 모드 시) 2트랙 지시를 매 턴 주입.
// 둘 다 비어/꺼져 있으면 아무것도 주입하지 않는다(토큰 비용 0).
// 추가로 '지금 Claude가 도는 작업 폴더'를 active.json에 기록 → 대시보드가 VS Code 첫 폴더가 아니라
// 실제 활성 폴더를 따라가서, "보는 세션 = 검증 가는 세션"이 항상 일치하게 한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, buildInjection, buildVerifyDirective, atomicWrite, BRIDGE_DIR } = require("./contract-lib.js");

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

  // 활성 작업 폴더 기록 → 대시보드가 VS Code 첫 폴더가 아니라 이 폴더를 따라가게.
  try {
    const f = path.join(BRIDGE_DIR, "active.json");
    atomicWrite(
      f,
      JSON.stringify({
        workspace: ws,
        claudeSession: hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || "",
        // §5.3: 플랜 모드 감지·라이브표시용. Claude Code UserPromptSubmit 입력의 permission_mode
        // ("plan"이면 플랜 모드). 문서 예시는 "default"라 실제 값은 실로그로 확인(빈값=미노출).
        permissionMode: (hook && typeof hook.permission_mode === "string") ? hook.permission_mode : "",
        ts: new Date().toISOString(),
      }),
    );
  } catch {
    /* ignore */
  }

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
