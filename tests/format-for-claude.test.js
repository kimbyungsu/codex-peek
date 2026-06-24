/*
 * formatForClaude 단위 테스트 (contract-lib.js · P1b).
 * Claude 소비용 stdout 재배치: findings-first/verdict-last(P1a) 답에서 '마지막 검증: 선언 줄'을
 * 본문에서 떼어, 라벨이 아니라 '처리 의무' footer로 옮긴다. 대시보드/proof/rollout은 원문 그대로(여기선 Claude용만 검증).
 * VERDICT_DECL_RE를 extractVerdict와 공유하므로 '같은 줄'을 인식/제거해야 한다.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffc_"));
process.env.CODEX_BRIDGE_HOME = path.join(dir, ".bridge"); // require 전 — 실제 ~/.codex-bridge 오염 방지
const { formatForClaude } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[통과(보완)] 본문 findings 보존 + 선언 줄 제거 + 처리의무 footer");
const pn = formatForClaude("검토:\n- A 정상\n- B 보완 필요\n\n검증: 통과(보완)");
const pnBody = pn.split("[Claude 처리 안내")[0];
ok(!/^[\s#>*\-]*검증\s*[:：]/m.test(pnBody), "footer 앞 본문에 '검증:' 선언 줄이 없음(떼어냄)");
ok(pn.includes("처리 의무: 보완 의견 있음"), "pass-notes → '보완 의견 있음' 처리의무");
ok(pn.includes("Codex 선언: 검증: 통과(보완)"), "떼어낸 원문 결론 줄을 footer에 그대로 보존(정확한 인용)");
ok(pn.includes("B 보완 필요"), "본문 findings는 보존");

console.log("[통과] 조치 없음 + '본문 우선' 단서(Codex 오라벨 전파 완화)");
const p = formatForClaude("검토 결과 문제 없음.\n\n검증: 통과");
ok(p.includes("처리 의무: 조치 없음") && p.includes("본문 항목을 우선"), "pass → '조치 없음 + 본문 우선'");
ok(p.includes("Codex 선언: 검증: 통과"), "pass 원문 결론 줄 보존");

console.log("[실패/보류] 행동 지시 매핑");
ok(formatForClaude("근거...\n\n검증: 실패").includes("처리 의무: 수정 필요"), "fail → '수정 필요 + 재검증'");
ok(formatForClaude("근거...\n\n검증: 보류").includes("처리 의무: 추가 확인 필요"), "inconclusive(보류) → '추가 확인 필요'");

console.log("[표지 없음] 원문 그대로, footer 안 붙임");
const nov = "그냥 코드 설명입니다.";
ok(formatForClaude(nov) === nov, "결론 표지 없음(null) → 원문 그대로");
ok(formatForClaude("") === "" && formatForClaude(null) === "", "빈/널 입력 → 빈 문자열");

console.log("[본문 단어 보존] prose의 통과/실패 단어는 선언 줄이 아니므로 남는다");
const pr = formatForClaude("이 부분은 통과할 만하다.\nB는 실패 위험은 낮다.\n\n검증: 통과(보완)");
ok(pr.includes("이 부분은 통과할 만하다") && pr.includes("실패 위험은 낮다"), "본문 prose의 통과/실패 단어 보존");
ok((pr.split("[Claude 처리 안내")[0].match(/^검증[:：]/gm) || []).length === 0, "본문에 '검증:' 시작 줄이 남지 않음");

console.log("[보수적 제거] 판정어 없는 '검증:' 설명 줄은 본문 보존(과잉 제거 방지)");
const expl = formatForClaude("검토 중:\n검증: 이 함수는 A 경로에서만 호출됨\n- 그 외 정상\n\n검증: 통과");
ok(expl.includes("검증: 이 함수는 A 경로에서만 호출됨"), "판정어 없는 '검증: 설명' 줄은 본문에 남음(extractVerdict가 null이라 비-선언)");
ok(expl.includes("처리 의무: 조치 없음"), "마지막 '검증: 통과'는 판정으로 분류(pass)");
ok((expl.split("[Claude 처리 안내")[0].match(/^검증[:：]\s*통과\s*$/m) || []).length === 0, "실제 판정 줄 '검증: 통과'는 본문에서 제거됨");

console.log("[모든 선언 줄 제거] 여러 선언 줄이면 본문에서 '전부' 제거, footer엔 마지막 선언만(앞쪽 bare 라벨 앵커 방지)");
const multi = formatForClaude("검증: 통과\n\n재검토 후 B 보완 필요\n\n검증: 통과(보완)");
const multiBody = multi.split("[Claude 처리 안내")[0];
ok((multiBody.match(/^검증[:：]/gm) || []).length === 0, "본문에 '검증:' 선언 줄이 하나도 안 남음(앞쪽 '검증: 통과'도 제거)");
ok(multi.includes("재검토 후 B 보완 필요"), "선언이 아닌 본문은 보존");
ok(multi.includes("Codex 선언: 검증: 통과(보완)"), "footer엔 마지막 선언(통과(보완))");
ok(multi.includes("처리 의무: 보완 의견 있음"), "처리의무도 마지막 선언 기준(extractVerdict와 일치)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
