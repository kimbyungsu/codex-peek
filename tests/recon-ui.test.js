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
ok(!/keyedDetails\("reconFlow"/.test(ext), "옛 '정찰 흐름 펼쳐보기' 접힘 그룹 폐기(2026-07-09 사용자 지시 — 한눈 도해와 중복)");
ok(/const openPanels = new Set\(\);/.test(ext) && /openPanels\.has\(key\)\) det\.open=true/.test(ext) && /det\.addEventListener\("toggle"/.test(ext), "펼침 유지: 재렌더에도 살아남는 기억 집합(자동 접힘 실버그 해법 — expandedConv 동형, 사용자 지적 4a)");
ok(/keyedDetails\("map:"\+\(sm\.latest\.ts\|\|"\?"\)/.test(ext), "최신 지도 details도 동일 보존 — 키는 지도 시각(새 지도=기본 접힘·형제 분리, 사용자 지적 4b·Codex 보완)");
ok(/이 폴더는 변경 기록이 풍부해요/.test(ext) && /기록이 아직 얕아요/.test(ext) && /과거 변경 기록이 없어요/.test(ext) && !/이 프로젝트 성격: /.test(ext), "옛 '성격 프로필'을 환경 안내 1문장으로 재작성(전문용어·괄호 겹침 제거 — 사용자 지적 2)");
ok(/tests 폴더가 안 보여서/.test(ext) && /hasTestsDir/.test(ext), "테스트 각주 유지 — 사람 말로('안 보여서'·없음 단정 금지)");
ok(/확정 교범'이 뭐예요\?/.test(ext) && /자동 주입 아니에요/.test(ext) && /팀원·다른 PC 공유/.test(ext), "확정 교범 평문 설명(왜 도장을 찍나·일지와의 차이·자동 주입 아님 — 2026-07-09 지적 5)");
ok(/AI 정찰 보고서\(영향지도\)가 아직 없어요/.test(ext), "②의 '없음'도 대상 명명(게시판 빈 상태 문구)");
ok(/실질 효과는 '정찰 실행'에서 나와요/.test(ext) && /별도 과금 없음/.test(ext), "LLM 필수성 정직 고지 — 1문장 압축(도해 아래 상시 노출)");
ok(!/addStep=\(color,name,state\)/.test(ext), "옛 단계 행(addStep) 폐기 — 역할은 항상 노출 도해(rflow 노드+실데이터)가 대체");
ok(!/사람 승인/.test(ext) && !/human approval/.test(ext), "'사람 승인/human approval' 잔재 0 — 세그먼트 힌트 포함 전거(Codex 반례 잠금)");
ok(!/수동 명령으로|수동 생성 가능|via manual command|made by manual command/.test(ext), "상태 요약·상태바의 '수동만' 잔재 0 — 직접/자동 지시 모델 유지(Codex 반례 잠금)");
ok(/추가 LLM 없음/.test(ext) && /ml&&ml\.mapExists/.test(ext) && /mapApproved/.test(ext) && /검증이 확인하면 신뢰로 승격/.test(ext), "③ 정확 표현·④ 실신호 유지(도해·일지 카드로 이관)");
ok(/openReconGuide/.test(ext) && /codexBridgeReconGuide/.test(ext) && /enableScripts: false/.test(ext) && /default-src 'none'; style-src 'unsafe-inline'/.test(ext), "자세히 보기(새탭): 별개 viewType·스크립트 차단·좁은 CSP(사용자 지적 7·Codex 보완)");
ok(/gb\.addEventListener\("click"/.test(ext) && !/summary.*appendChild\(gb\)/.test(ext), "가이드 버튼은 summary 밖(토글 충돌 방지 — Codex 보완)");
ok(!/det\.firstChild\.title=T\("변경 감지\(⚙자동\)/.test(ext), "옛 접힘 hover 스트립 폐기(구획 자체 폐기에 따름)");

console.log("[카드 개명] 번호 없는 이름+배지 — 번호 이중 순환 제거(사용자 지적 5·6)");
ok(/변경 감지 ⚙ 자동·AI 호출 없음 — 지금 고치는 파일/.test(ext) && !/① 변경 감지\(LLM 없음\) — /.test(ext), "카드: '변경 감지'(번호 없음·사람 언어)");
ok(/영향지도\(정찰 보고\) ⚡ AI 호출 — /.test(ext), "카드: '영향지도(정찰 보고)'(번호 없음)");
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

console.log("[한눈 도해(2026-07-08 2차 — 커뮤니티 피드백: 구조가 안 읽힘·API 필요 여부 불명)] 항상 노출 그림 + 텍스트 벽 강등");
ok(/className="rflow"/.test(ext) && /className="rnode"/.test(ext) && /className="rarw"/.test(ext), "정찰 4단계 도해(색 박스+화살표 — 검증 파이프라인과 같은 시각 문법) 항상 노출");
ok(/파일이 바뀌면/.test(ext) && /검증을 지나며/.test(ext) && /원할 때만/.test(ext), "화살표에 '언제 넘어가는지' 라벨");
ok(/className="rlife"/.test(ext) && /신설/.test(ext) && /승격/.test(ext) && /교체/.test(ext) && /폐기/.test(ext), "지식 수명주기 한 줄(신설→승격→교체→폐기) — '언제 뭘 반영하나' 즉답");
ok(/지금 이대로\(키 없음\) = 기본 흐름 전부 동작/.test(ext) && /DeepSeek 키를 넣으면\(선택\) = 정찰만 분업/.test(ext), "API 비교 2박스 — 'DeepSeek 없인 못 쓰나?'에 첫 줄 즉답(과장 없는 문구 — Codex 정정)");
ok(/className="rlchip"/.test(ext) && (ext.match(/\.rchip\{/g)||[]).length===1, "수명주기 칩은 .rlchip — 기존 .rchip(규칙 메타 칩) 전역 충돌 재발 잠금(정의 1개만)");
ok(/aria-label/.test(ext), "칩 hover 설명에 aria-label 병기(접근성)");
ok(/기본\(Claude\)이 더 정확했어요 — 필수 아님/.test(ext), "실측 근거로 '필수 아님' 정직 명시");
ok(/keyedDetails\("senseDetail"/.test(ext) && /keyedDetails\("mapInfo"/.test(ext), "텍스트 벽(후보 목록·한계·ⓘ 설명) → 접힘 강등(첫 화면=그림 원칙)");

console.log("[3트랙 선택 안내(2026-07-09 지적 1)] 키 없음=경고 모달+이동 버튼 · 키 있음=실제 연결 점검");
ok(/등록된 DeepSeek API 키가 없어요/.test(ext) && /3트랙의 효과가 미비할 수 있어요/.test(ext) && /등록하러 가기/.test(ext) && /알겠습니다/.test(ext), "키 없음 → 모달(효과 미비 경고는 '정찰 미실행' 사실 기준으로 정직화)+[등록하러 가기]/[알겠습니다]");
ok(/switchTab/.test(ext) && /data-tab="'\+ev\.data\.tab/.test(ext), "'등록하러 가기' → 고급설정 탭 전환 배선(확장→웹뷰)");
ok(/API 등록과 정상 연결이 확인되었습니다 — 3트랙이 정상 운용됩니다/.test(ext) && /deepseek-bridge\.js/.test(ext) && /연결 점검에 실패했어요/.test(ext), "키 있음 → 실제 ping 점검 후 정상/실패를 사실대로");
ok(/📖 정찰 구조 자세히 보기/.test(ext) && !/gb\.className="secondary"/.test(ext), "'자세히 보기' 주 버튼 승격(경고가 참조하는 문서 — 눈에 띄게, 지적 3)");
ok(/className="rsec"/.test(ext), "영향지도 게시판 섹션 카드화(간격·구획 — 지적 4)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
