#!/usr/bin/env node
// PreToolUse 후크: Bash로 Codex를 "직접" 호출하려는 명령을 차단한다.
// Codex 소통은 반드시 codex-bridge.js를 거치게 강제(브릿지는 codex를 내부 spawn으로 부르므로
// 이 후크가 보는 Bash 명령엔 'codex exec'가 안 나타나 → 차단되지 않음).
// PreToolUse 규약: exit 2 = 해당 도구 호출 차단(이유는 stderr로 Claude에 전달).

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    const o = JSON.parse(input);
    cmd = (o.tool_input && o.tool_input.command) || "";
  } catch {
    process.exit(0); // 파싱 실패 시 막지 않음(안전)
  }

  const isBridge = /codex-bridge(\.js)?\b/i.test(cmd);
  const direct =
    /codex\.exe\b/i.test(cmd) || // 번들 바이너리 직접 경로
    /(^|[\s;|&"'`(])codex\s+(exec|resume|app-server|login|logout|e)\b/i.test(cmd) || // codex <subcmd>
    /codex-ask(\.js)?\b/i.test(cmd); // 구버전 사이드도어

  if (direct && !isBridge) {
    process.stderr.write(
      "⛔ Codex 직접 호출이 차단되었습니다. Codex 소통은 브릿지만 사용하세요.\n" +
        '   node C:/Users/MAIN/.codex-bridge/codex-bridge.js ask "..."\n' +
        "   (연결 없으면 보고만 함 / 첫 소통은 ask --allow-new)\n",
    );
    process.exit(2);
  }
  process.exit(0);
});
