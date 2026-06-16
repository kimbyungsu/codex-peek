#!/usr/bin/env node
// Claude Code UserPromptSubmit 훅: 고정 계약(contract.claude) + (검증 모드 시) 2트랙 지시를 매 턴 주입.
// 둘 다 비어/꺼져 있으면 아무것도 주입하지 않는다(토큰 비용 0).
const { loadContract, buildInjection, buildVerifyDirective } = require("./contract-lib.js");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let parts = [];
  try {
    const c = loadContract();
    const rules = buildInjection(c.claude, "Claude Code", c.claudeChecklist);
    if (rules) parts.push(rules);
    if (c.verify) parts.push(buildVerifyDirective());
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
