#!/usr/bin/env node
"use strict";
// [Envelope Selector v7 §4 — 4b] PreToolUse 게이트: 승인 서고(2층 수칙서) 활성+이번 턴 스냅샷 존재 상태에서,
// 이 턴에 결속된 선별 미리보기 영수증(purpose:"preview")이 생길 때까지 '모든 변경 가능 도구' 호출을 계속
// 차단한다(1회 아님 — 영수증이 생겨야 열림). matcher는 설치기가 등록(Bash·Edit·Write·MultiEdit·NotebookEdit·
// mcp__.* — MCP는 이름으로 읽기/쓰기 구분이 불가능해 보수적으로 전종). 허용 예외=preview 실행 명령 자체.
// 규약: exit 2=차단(stderr가 Claude에 전달)·exit 0=허용. 미도입·스냅샷 부재=무발동(뒤 관문(ask-start)이
// fail-closed). 영수증 서랍 판독 실패=영수증 없음과 동일(차단 — fail-closed). 훅 안에서 LLM 호출 없음(존재 검사뿐).
const fs = require("fs");
const path = require("path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let o = null;
  try { o = JSON.parse(input); } catch { process.exit(0); } // 페이로드 파싱 실패=판정 불가 — 뒤 관문이 방어(기존 훅 관용)
  try {
    const CL = require("./contract-lib.js");
    const ws = String(o.cwd || "");
    if (!ws) return process.exit(0);
    const c = CL.loadContract(ws);
    if (!(typeof c.archiveHash === "string" && c.archiveHash)) return process.exit(0); // 미도입=무발동
    // 이번 턴 스냅샷(세션 앵커) — 부재=게이트 조건 미충족(무발동·ask-start가 시작 자체를 막음)
    const sid = String(o.session_id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!sid) return process.exit(0);
    let a = null;
    try { a = JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, sid + ".json"), "utf8")); } catch { a = null; }
    if (!a || typeof a.constraintAnchor !== "string" || !a.constraintAnchor || typeof a.constraintSourceHash !== "string" || !a.constraintSourceHash) return process.exit(0);
    // [4b-2] 판정=공용 previewGateDecision(Claude·Codex 동일 게이트 계약 공유 — 런타임별 분기 없음):
    // 예외=미리보기 명령 전체 정확 일치(토큰 basename 결속)·통과=4중 결속(wsKey·turnAnchor·snapshot·archive)
    // 영수증·잔여(타 위치 동명 파일)는 그 파일을 만드는 쓰기 자체가 이 게이트에 막힘(기성 악성 파일=경계 밖).
    const d9 = CL.previewGateDecision({
      archiveHash: c.archiveHash,
      turnAnchor: a.constraintAnchor,
      snapshotHash: a.constraintSourceHash,
      wsKey: CL.wsKeyFor(ws),
      toolName: String(o.tool_name || ""),
      command: String((o.tool_input && o.tool_input.command) || ""),
    });
    if (d9 !== "block") return process.exit(0);
    const en = CL.loadLang() === "en";
    process.stderr.write(
      (en
        ? "⛔ Approved archive (two-tier rulebook) is active — before changing anything, pull the rules selected for THIS task:\n"
        : "⛔ 승인 서고(2층 수칙서) 활성 — 변경 도구를 쓰기 전에 '이번 작업 선별 수칙'을 먼저 받아야 합니다:\n") +
      `   node "${CL.BRIDGE}" selector-preview\n` +
      (en
        ? "   (an independent session picks the relevant stored rules; its receipt opens this gate for the rest of the turn)\n"
        : "   (독립 세션이 관련 보관 수칙을 골라 보여주고, 그 영수증이 이 턴의 나머지 작업에 대해 이 관문을 엽니다)\n"),
    );
    process.exit(2);
  } catch { process.exit(0); } // 게이트 내부 오류=무발동(뒤 관문(ask-start 영수증 조건)이 fail-closed 방어)
});
