/*
 * extractVerdict 단위 테스트 (contract-lib.js).
 * 핵심: '첫 줄'이 아니라 '검증' 든 줄을 훑어 '마지막 결론'으로 4단계 판정.
 * 깨끗한 통과=pass, 통과+보완=pass-notes(보류와 분리), 보류·불가·정보부족=inconclusive, 실패=fail, 표지 없음=null.
 * ⚠️ src/extension.ts의 동명 함수와 로직 동일해야 함 — 여기 케이스가 양쪽 계약이다.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vd_"));
process.env.CODEX_BRIDGE_HOME = path.join(dir, ".bridge"); // require 전 — 실제 ~/.codex-bridge 오염 방지
const { extractVerdict } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

ok(extractVerdict("검증: 통과") === "pass", "검증: 통과 → pass");
ok(extractVerdict("검증: 실패") === "fail", "검증: 실패 → fail");
ok(extractVerdict("검증 불가") === "inconclusive", "검증 불가 → inconclusive");
ok(extractVerdict("검증: 보류") === "inconclusive", "검증: 보류 → inconclusive");
ok(extractVerdict("검증: 통과(보완)") === "pass-notes", "검증: 통과(보완) → pass-notes(정본 4어휘)");
ok(extractVerdict("검증: 통과 (단, 조건부로 X 권장)") === "pass-notes", "통과+조건부 한 줄 → pass-notes(통과지만 챙길 것 — 보류 아님)");
ok(extractVerdict("검증: 통과 — 추가로 테스트 보완 권장") === "pass-notes", "통과+추가/보완 → pass-notes");
ok(extractVerdict("코드를 확인했습니다. 문제 없어 보입니다.") === null, "검증 표지 없음 → null(중립)");
ok(extractVerdict("") === null, "빈 문자열 → null");
ok(extractVerdict(null) === null, "null 입력 → null");

console.log("[마지막-우선] 서두 narration 뒤 진짜 결론이 이긴다");
ok(extractVerdict("검증 요청으로 진행하겠습니다. 항목별 통과/실패 정리\n\n파일 읽는 중\n\n검증: 통과\n\n- 근거…") === "pass",
  "서두에 통과/실패 섞여도 마지막 '검증: 통과'가 최종 → pass");
ok(extractVerdict("작업 중…\n\n검증: 실패\n\n- 근거") === "fail", "마지막 결론 '검증: 실패' → fail");
ok(extractVerdict("검증: 통과\n\n검증 불가(추가 정보 필요)") === "inconclusive", "뒤에 온 '검증 불가'가 최종(마지막-우선)");

console.log("[P1a findings-first/verdict-last 표준형] 본문 먼저, 판정은 마지막 줄에만");
ok(extractVerdict("검토:\n- A 정상\n- B 보완 필요\n- C 추가 확인 권장\n\n검증: 통과(보완)") === "pass-notes",
  "findings-first 본문 + 마지막 '검증: 통과(보완)' → pass-notes(파서 무변경으로 verdict-last 동작)");
ok(extractVerdict("검토 내용...\n- 문제 없음\n\n검증: 통과") === "pass",
  "findings-first 본문 + 마지막 '검증: 통과' → pass");

console.log("[본문 오탐 방지] '검증' 없는 줄의 통과/실패는 무시");
ok(extractVerdict("검증: 통과\n\n- P1은 실패 위험이 있다(검증 아님)") === "pass", "본문 '실패' 줄(검증 없음)은 무시 → pass");

console.log("[콜론형 포괄] 정보 부족·판단 보류도 inconclusive (Codex 검증 반례)");
ok(extractVerdict("검증: 정보 부족") === "inconclusive", "검증: 정보 부족 → inconclusive");
ok(extractVerdict("검증: 정보부족") === "inconclusive", "검증: 정보부족(붙임) → inconclusive");
ok(extractVerdict("검증: 판단 보류") === "inconclusive", "검증: 판단 보류 → inconclusive");

console.log("[콜론 없는 형태] 검증 + 결론어");
ok(extractVerdict("검증 통과") === "pass", "검증 통과(콜론 없음) → pass");
ok(extractVerdict("검증 불가합니다") === "inconclusive", "검증 불가합니다 → inconclusive");

console.log("[서두 여전히 배제] 콜론 없고 결론어 아님");
ok(extractVerdict("검증 요청으로 진행합니다. 항목별 통과/실패 정리") === null, "'검증 요청으로…'(콜론X·요청은 결론어 아님) → null");
ok(extractVerdict("이 검증에서 실패 위험을 봤다") === null, "'이 검증에서…'(검증으로 시작 안 함) → null");

console.log("[핵심: 통과·보완 ≠ 보류] 통과지만 챙길 것 vs 통과 못 함은 다른 칸");
ok(extractVerdict("검증: 통과") === "pass" && extractVerdict("검증: 통과(보완)") === "pass-notes" && extractVerdict("검증: 보류") === "inconclusive",
  "통과 / 통과·보완 / 보류가 각각 다른 값(4단계 분리)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
