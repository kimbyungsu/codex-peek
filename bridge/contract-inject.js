#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 고정 계약(contract.claude) + (검증 모드 시) 2트랙 지시를 매 턴 주입.
// 둘 다 비어/꺼져 있으면 아무것도 주입하지 않는다(토큰 비용 0).
// 추가로 '지금 Claude가 도는 작업 폴더'를 active.json에 기록 → 대시보드가 VS Code 첫 폴더가 아니라
// 실제 활성 폴더를 따라가서, "보는 세션 = 검증 가는 세션"이 항상 일치하게 한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, buildInjection, buildVerifyDirective } = require("./contract-lib.js");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  // 활성 작업 폴더 기록(브릿지 workspace()와 동일 기준: CLAUDE_PROJECT_DIR || hook.cwd || cwd).
  try {
    let hook = {};
    try {
      hook = JSON.parse(input);
    } catch {
      /* ignore */
    }
    const f = path.join(os.homedir(), ".codex-bridge", "active.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      JSON.stringify({
        workspace: process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd(),
        claudeSession: hook.session_id || process.env.CLAUDE_CODE_SESSION_ID || "",
        ts: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch {
    /* ignore */
  }

  let parts = [];
  try {
    const c = loadContract();
    const rules = buildInjection(c.claude, "Claude Code", c.claudeChecklist);
    if (rules) parts.push(rules);
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
