#!/usr/bin/env node
// Claude Code SessionStart 훅 — [HARNESS-REALIGNMENT §4-B ① Claude 쪽 · 규약 1회 전달 2026-08-31]
// 세션이 시작·재개·압축(source=startup|resume|compact|clear)되면 이 세션 앵커(active/<claudeSession>.json)의
// '규약 전달 기록'을 리셋한다 → 다음 UserPromptSubmit(contract-inject)이 정적 지시 전문을 다시 보낸다(사유=source).
// 판단 근거는 추측이 아니라 이 훅 이벤트(Claude Code가 압축 복원 채널로 쓰는 통로) 자체다. 앵커가 없으면 아무것도 쓰지 않는다
// (기록 없음=다음 프롬프트가 전문을 보내는 안전 방향). 앵커 쓰기 실패=마커 파일 폴백, 둘 다 실패=비0 종료+stderr(조용한 fail-open 금지 —
// 확인 검증 1회차 blocker③). 주입 출력은 없다.
const { resetClaudeDirectiveDelivery, isRealHookInput } = require("./contract-lib.js");

// [P7 ⓐ 2026-09-01] 불러오기만 됐을 때는 아무것도 하지 않는다(리셋도 쓰지 않음).
if (require.main !== module) return;
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let hook = {};
  try { hook = JSON.parse(input) || {}; } catch { hook = {}; }
  // [P7 ⓐ] contract-inject와 같은 판별기 — stdin에 이벤트 이름·세션 id가 모두 있을 때만(환경변수 폴백 없음·부분 입력=무동작 종료 — 확인 검증 1회차 blocker).
  if (!isRealHookInput(hook)) process.exit(0);
  const sid = hook.session_id;
  const source = (hook && typeof hook.source === "string" && hook.source) || "unknown";
  let r = { ok: false, via: "exception" };
  try { r = resetClaudeDirectiveDelivery(sid, source); } catch { r = { ok: false, via: "exception" }; }
  if (!r.ok) {
    try { process.stderr.write("[Codex Bridge] directive delivery reset FAILED (" + r.via + ") for session " + sid + " — the next prompt may skip the standing directives; check ~/.codex-bridge/active permissions.\n"); } catch { /* 안내 실패 무해 */ }
    process.exit(1);
  }
  process.exit(0);
});
