/*
 * ageLabel(brain-intent.ts) — 두뇌 '실제 답' 평시 정보 표시의 경과 시간 라벨.
 * 배경(2026-07-08 결정 실험): 앱 UI 두 곳(빠른메뉴 줄 라벨 vs 피커 체크마크)이 서로 다르게 보이는 표시 결함이
 * 실측돼, 사용자가 믿을 정본(대화 기록의 실제 답 모델)을 상시 정보로 노출하기로 함. 이 라벨이 그 문구의 시간부.
 * ※ out/brain-intent.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const { ageLabel } = require(path.join(__dirname, "..", "out", "brain-intent.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[ageLabel] 경과 시간 → 사람 말(ko/en)");
ok(ageLabel(0, false) === "방금 전" && ageLabel(0, true) === "just now", "0ms → 방금 전 / just now");
ok(ageLabel(59_000, false) === "방금 전", "59초 → 방금 전(분 미만)");
ok(ageLabel(3 * 60_000, false) === "3분 전" && ageLabel(3 * 60_000, true) === "3m ago", "3분 → 3분 전 / 3m ago");
ok(ageLabel(59 * 60_000, false) === "59분 전", "59분 → 분 단위 유지");
ok(ageLabel(2 * 3600_000, false) === "2시간 전" && ageLabel(2 * 3600_000, true) === "2h ago", "2시간 → 2시간 전 / 2h ago");
ok(ageLabel(23 * 3600_000 + 59 * 60_000, false) === "23시간 전", "24시간 직전 → 시간 단위 유지");
ok(ageLabel(3 * 86400_000, false) === "3일 전" && ageLabel(3 * 86400_000, true) === "3d ago", "3일 → 3일 전 / 3d ago");
ok(ageLabel(-5_000, false) === "방금 전", "음수(시계 왜곡) → 방금 전으로 흡수(정보 표시라 경고 없음)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
