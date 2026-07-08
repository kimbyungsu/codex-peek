/*
 * 정찰 UI 구조 개편(2026-07-08 사용자 지적 3건: 용어 나열로 역할이 안 그려짐 · LLM 호출 여부 시각 구분 부재 ·
 * 기대 효용 표시 부재) 소스 계약. 산출 스크립트의 문법 건전성은 tests/webview-syntax.test.js가 별도 재현 검사.
 */
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

console.log("[정찰 흐름 접힘 그룹] 기본 접힘 + 펼침 유지 + 성격 프로필 + 4단계 요약(번호는 여기·가이드에만)");
ok(/keyedDetails\("reconFlow", T\("▶ 정찰 흐름 펼쳐보기/.test(ext), "'▶ 정찰 흐름 펼쳐보기' — 나열 문구 1차 숨김(기본 접힘, 사용자 지적 3)");
ok(/const openPanels = new Set\(\);/.test(ext) && /openPanels\.has\(key\)\) det\.open=true/.test(ext) && /det\.addEventListener\("toggle"/.test(ext), "펼침 유지: 재렌더에도 살아남는 기억 집합(자동 접힘 실버그 해법 — expandedConv 동형, 사용자 지적 4a)");
ok(/keyedDetails\("map:"\+\(sm\.latest\.ts\|\|"\?"\)/.test(ext), "최신 지도 details도 동일 보존 — 키는 지도 시각(새 지도=기본 접힘·형제 분리, 사용자 지적 4b·Codex 보완)");
ok(/이 프로젝트 성격: /.test(ext) && /이력 깊은 코드 프로젝트/.test(ext) && /이력\(git\) 없는 폴더 — 메모·문서형/.test(ext) && /신생\/커밋이 드문 프로젝트/.test(ext), "성격 프로필: 신호→성격 범주→기대 효용 번역(사용자 지적 2)");
ok(/표준 테스트 폴더\(tests\/·test\/\) 미감지/.test(ext) && /hasTestsDir/.test(ext), "테스트 각주는 '미감지'로 낮춰 표현(없음 단정 금지 — Codex 보완)");
ok(/원할 때만 문서로 도장 찍습니다\(👤·선택\)/.test(ext) && /④ 확정 교범 👤 선택\(내보내기할 때만 — 없어도 자동 동작\)/.test(ext), "'사람이 확정' 오해 제거 — 선택·자동 명시(사용자 지적 1)");
ok(!/사람 승인/.test(ext) && !/human approval/.test(ext), "'사람 승인/human approval' 잔재 0 — 세그먼트 힌트 포함 전거(Codex 반례 잠금)");
ok(!/수동 명령으로|수동 생성 가능|via manual command|made by manual command/.test(ext), "상태 요약·상태바의 '수동만' 잔재 0 — 직접/자동 지시 모델 유지(Codex 반례 잠금)");
ok(/③ 관찰 일지 ⚙ 추가 LLM 없음\(검증 대화에 편승\)/.test(ext) && /ml&&ml\.mapExists/.test(ext) && /mapApproved/.test(ext), "③ 정확 표현·④ 실신호 유지");
ok(/openReconGuide/.test(ext) && /codexBridgeReconGuide/.test(ext) && /enableScripts: false/.test(ext) && /default-src 'none'; style-src 'unsafe-inline'/.test(ext), "자세히 보기(새탭): 별개 viewType·스크립트 차단·좁은 CSP(사용자 지적 7·Codex 보완)");
ok(/gb\.addEventListener\("click"/.test(ext) && !/summary.*appendChild\(gb\)/.test(ext), "가이드 버튼은 summary 밖(토글 충돌 방지 — Codex 보완)");
ok(/det\.firstChild\.title=T\("변경 감지\(⚙자동\)/.test(ext), "접힘 상태 hover: 구조 한 줄 툴팁+색 배지 스트립(사용자 지적 7 전반)");

console.log("[카드 개명] 번호 없는 이름+배지 — 번호 이중 순환 제거(사용자 지적 5·6)");
ok(/변경 감지 ⚙ LLM 없음 — 지금 바뀌는 파일과/.test(ext) && !/① 변경 감지\(LLM 없음\) — /.test(ext), "카드: '변경 감지'(번호 없음)");
ok(/영향지도\(정찰 보고\) ⚡ LLM 호출 — /.test(ext), "카드: '영향지도(정찰 보고)'(번호 없음)");
ok(/관찰 일지\(자동 기억\) ⚙ 추가 LLM 없음 — 개입은 선택/.test(ext), "카드: '관찰 일지'(번호 없음·현 UI 유지·분리)");
ok(!/아래 ② 카드/.test(ext), "본문 속 번호 참조 잔재 없음(Codex 보완)");

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
