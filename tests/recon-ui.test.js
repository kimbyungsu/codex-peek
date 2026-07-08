/*
 * 정찰 UI 구조 개편(2026-07-08 사용자 지적 3건: 용어 나열로 역할이 안 그려짐 · LLM 호출 여부 시각 구분 부재 ·
 * 기대 효용 표시 부재) 소스 계약. 산출 스크립트의 문법 건전성은 tests/webview-syntax.test.js가 별도 재현 검사.
 */
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

console.log("[정찰 흐름 통합 그룹] 4단계가 한 줄기 이야기로 + 각 단계 LLM 배지 + 지금 신호 기준 상태");
ok(/정찰 흐름 — 기계가 모으고\(⚙\) → 정찰 LLM이 예측하고\(⚡\)/.test(ext), "흐름 머리글: 기계→정찰LLM→자동→사람(배지 포함)");
ok(/① 변경 감지 ⚙ LLM 없음 · /.test(ext) && /② 영향지도 ⚡ 정찰 LLM 호출 · /.test(ext), "①⚙·②⚡ — 단계별 LLM 여부가 이름 옆에");
ok(/③ 관찰 일지 ⚙ 추가 LLM 없음\(검증 대화에 편승\)/.test(ext), "③은 '추가 LLM 없음'으로 정확히(씨앗은 ②의 LLM 산물 — 과장 금지, Codex 보완)");
ok(/④ 확정 교범 👤 사람 승인/.test(ext) && /ml&&ml\.mapExists/.test(ext) && /mapApproved/.test(ext), "④는 표기만이 아니라 기존 신호(mapExists·mapApproved)로 상태 표시(Codex 보완)");
ok(/제한 — git 이력이 없어 통계 불가\(지도는 무이력 모드로 가능\)/.test(ext) && /제한 — 과거 표본 부족/.test(ext), "①의 가능/제한/불가+이유(비-git·표본부족) — 프로젝트 신호 기준 기대치");

console.log("[카드 개명] 역할이 이름에 — 번호·LLM 배지 동반");
ok(/① 변경 감지\(LLM 없음\) — 지금 바뀌는 파일과/.test(ext), "⑤ 카드: '범위 장부'→'① 변경 감지'");
ok(/② 영향지도\(정찰 보고 · ⚡LLM 호출\)/.test(ext), "⑤-2 카드: '영향지도 게시판'→'② 영향지도(정찰 보고)'");
ok(/③ 관찰 일지\(자동 기억 · ⚙추가 LLM 없음\)/.test(ext), "⑤-3 카드: 'MAP 장부'→'③ 관찰 일지'");
ok(/'④ 확정 교범\("\+ml\.mapRel\+"\)'으로 내보내기\(승격\)/.test(ext), "내보내기 문구가 ④로의 '승격'임을 명시");

console.log("[상태바 LLM 상시 줄] 대시보드 안 열어도 호출 여부 판단(사용자 요청)");
ok(/지금 실행 중인 LLM 호출 없음 — 변경 감지는 LLM 없이 자동 · 관찰 일지는 추가 LLM 없이 자동 누적/.test(ext), "평시: '실행 중' 한정 + 관찰 일지는 '추가 LLM 없음'으로 정확히(씨앗은 ② LLM 산물 — Codex 재보완)");
ok(/⚡ LLM 호출 중: 정찰 지도 생성\(/.test(ext), "정찰 러너 도는 동안: 팔 이름과 함께 표시");
ok(/⚡ LLM 호출 중: Codex 검증/.test(ext), "검증 흐름 3박스 툴팁에도 LLM 명시(flow 모드는 linked 툴팁을 안 타므로 — Codex 보완)");
ok(/llm: scoutLiveNow \? scoutLiveNow\.arm : "none"/.test(ext), "멱등 키에 LLM 상태 포함(켜짐/꺼짐 전환 즉시 갱신·경과시간 미포함 원칙 유지)");

console.log("[용어 통일] 정찰 계열로 — 단 기존 잠금 라벨('탐색중' 스핀·Scout)은 유지(전면 치환 아님)");
ok(/정찰\(3트랙\): /.test(ext) && /정찰\(영향 미리보기·관찰 일지\)/.test(ext), "상태바 접두·세그먼트 라벨");
ok(/정찰이란\? \(4단계 흐름\)/.test(ext), "세그먼트 힌트가 4단계 흐름 설명");
ok(/탐색중", "scouting"/.test(ext), "기존 '탐색중' 스핀 라벨 유지(회귀 방지)");
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const readmeEn = fs.readFileSync(path.join(__dirname, "..", "docs", "README.en.md"), "utf8");
ok(/정찰\(3트랙\) 용어 한눈에/.test(readme) && /① 변경 감지/.test(readme) && /옛 표기 '범위 장부'/.test(readme), "README ko: 용어표+옛 표기 별칭");
ok(/Recon \(3-track\) at a glance/.test(readmeEn) && /formerly "scope ledger"/.test(readmeEn), "README en: 대응 절");
const privacy = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
ok(/'② 영향지도'.*옛 표기 '영향지도 게시판'/.test(privacy) && /'③ 관찰 일지'.*옛 표기 '관측 장부/.test(privacy), "PRIVACY: 새 표기·옛 표기 별칭(혼선 방지 — Codex 보완)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
