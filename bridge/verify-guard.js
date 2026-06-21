#!/usr/bin/env node
// Claude Code Stop 훅: 검증 모드 ON일 때, 이번 턴에 파일을 변경했는데
// Codex 검증(codex-bridge ask)을 안 받았으면 종료를 막고 검증을 강제한다.
// - 검증 모드 OFF → 통과
// - stop_hook_active(이미 한 번 막아 재진입) → 통과(무한루프 방지)
// - 변경 있음 + 브릿지 ask 없음 → block(검증 지시), 그 외 통과
const fs = require("fs");
const { loadContract, BRIDGE } = require("./contract-lib.js");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let j = {};
  try {
    j = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  // 계약(verifyMode)을 이 턴의 작업 폴더 기준으로 로드 — contract-inject와 동일 해석(프로젝트별).
  const ws = process.env.CLAUDE_PROJECT_DIR || j.cwd || process.cwd();
  let c;
  try {
    c = loadContract(ws);
  } catch {
    process.exit(0);
  }
  if (c.verifyMode === "off") process.exit(0); // 검증 모드 off
  if (j.stop_hook_active) process.exit(0); // 재진입 → 통과(루프 방지)

  const tp = j.transcript_path;
  if (!tp || !fs.existsSync(tp)) process.exit(0);
  let lines;
  try {
    lines = fs.readFileSync(tp, "utf8").trim().split(/\r?\n/);
  } catch {
    process.exit(0);
  }

  // 마지막 '사람' user 메시지 위치(도구 결과 user는 제외).
  let lastUser = -1;
  for (let i = 0; i < lines.length; i++) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type === "user" && o.message) {
      const ct = o.message.content;
      const isToolResult = Array.isArray(ct) && ct.some((x) => x && x.type === "tool_result");
      const isHuman = typeof ct === "string" || (Array.isArray(ct) && ct.some((x) => x && x.type === "text"));
      if (isHuman && !isToolResult) lastUser = i;
    }
  }

  // 마지막 사람 발화 이후: 파일 변경(edited)·플랜 확정(planned)·브릿지 검증(verified) 여부.
  let edited = false;
  let planned = false;
  let verified = false;
  for (let i = lastUser + 1; i < lines.length; i++) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !o.message || !Array.isArray(o.message.content)) continue;
    for (const b of o.message.content) {
      if (!b || b.type !== "tool_use") continue;
      const n = b.name || "";
      if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(n)) edited = true;
      if (n === "ExitPlanMode") planned = true; // 플랜 확정 신호(추론 없이 결정적)
      if (n === "Bash") {
        const cmd = (b.input && b.input.command) || "";
        if (/codex-bridge/.test(cmd) && /\bask\b/.test(cmd)) verified = true;
      }
    }
  }

  // 모드별 트리거: always=모든 턴 / plancode=플랜확정 or 코드변경 / code=코드변경.
  const needVerify =
    c.verifyMode === "always" ? true :
    c.verifyMode === "plancode" ? (edited || planned) :
    edited;

  if (needVerify && !verified) {
    const what = planned && !edited ? "플랜을 확정했는데" : edited ? "파일을 변경했는데" : "이번 턴에";
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          `[검증 모드:${c.verifyMode}] ${what} Codex 검증을 받지 않았다. ` +
          `종료하지 말고 지금 \`node "${BRIDGE}" ask "<무엇을 검증할지>"\` 로 Codex 검증을 받아라. ` +
          `그 결과(통과/실패+근거)를 사용자에게 보고한 뒤 종료하라. (연결 없으면 보고만 됨 — 그 사실을 보고하라)`,
      }),
    );
  }
  process.exit(0);
});
