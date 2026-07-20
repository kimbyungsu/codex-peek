# HANDOFF — 다른 로컬 환경에서 이어서 개발하기 (자립형 인수인계)

> 이 문서 하나로 이어갈 수 있게 쓰였다. 상세 설계 원본(SCOUT-TRACK.md·SCOPE-LEDGER.md)은 **의도적으로 레포 밖 로컬 문서**라
> 다른 환경에는 없다 — 그래서 이 파일이 그 요지를 포함한다. ⚠ **실 API 키·토큰은 어떤 파일·픽스처·예시에도 절대 넣지 말 것.**
> 마지막 갱신: 2026-07-20 (버전 0.1.86 불변 · 이 갱신을 포함해 push된 main 기준). **이번 push 묶음(11커밋+수치 정정 1) 요지 —
> MAP v2 P4 전 증분 완결+탐색 담당(scoutArm) 옵션 신설: 다음 착수=P3b cutover**:
> ①**P4 증분 1 — P2 확장 계층**(4ef214a·검증 3왕복): structuralHashOf(provenance 제외 — historyless 자기참조
> 해소)·map-decision-v3(affectedIds='생존' changedIds 필수·정렬)·v2/v3 dual reader(구 v2 바이트·해시 불변
> 리터럴 잠금·v2 historyless=unknown 정직 강등)·apply provenance 주입·read-set 전 anchor 확장(merge destination
> 포함)·구 v2 WAL 복구=무주입 의미 보존. tests/p4-core 55단언.
> ②**P4 증분 2 — freshness 재료 저장소+기준선 훅**(adbb89a·검증 14왕복 — 구조 교체 2회): mfresh-1(a:=검증
> 전이 기준선[CAS 검증 지문 '복사'만·해시 0회·basisDecisionId 결속·권위 swap 전용]/e:=비권위 캐시 합타입),
> 판독 무파괴·세대 안전·e: 우선 축출·영수증=실기록. 실패 복구=마커 없는 '상시 자가 수리'(누락=상태가 아니라
> 매 topology 전이마다 저장소 vs provenance 차이로 재유도·원본=무GC 정본 decisions/·전체 검증기+ADP 권위
> 스냅샷 결속·fp까지 대조)+retry 사이드카+감사 LRU=논리 순번 seq(시계 비의존 — 시각 기반 순번은 역행·포화·
> 혼합 반례 3연속으로 폐기)+판독 예산(후보 상한+감사 예약·missing-first). 경로 경계+lstat/O_NOFOLLOW 안전
> 판독. tests/p4-freshness 139단언. 보관함 2건: c016deec(symlink 잔여 창)·abec10d4(updates overlay — 지연만).
> ③**P4 증분 3 — 공용 reader·판정기·동봉·게이트 준비**(569f729·검증 4왕복): bridge/map-reader.js —
> readMapProjection(잠금 안='원문 바이트 캡처만'·captureDirRaw/FromCapture 분리 리팩터[pipeline·bindings]·
> 같은 캡처 세트에서 marker↔topology 세대 원자 대조·validateTopology 관문·비객체 JSON 안전 판정·권위 세대
> flap 재시도 1회·blocked=legacy 폴백 금지·bindings 실패 은폐 금지·effective/degraded 분리)/deriveFreshness
> (anchor 기준선+evidence 실대조 이축·stale>unknown>fresh)/buildMapAttach(비v2=기존 동봉 바이트 위임)/
> mapGateAssessFor(비활성 준비 — 절단 시 fresh 주장 금지). manifest P4 표면 2개 ready+activation:'P3b'.
> tests/p4-reader 54단언(실 자식 프로세스 잠금 경쟁·stale edge 단독[전제 실측] 포함). **전 표면 비활성/위임 —
> 활성화는 P3b cutover에서 일괄.**
> ④**탐색 담당(scoutArm) 옵션**(f016212+0512a90+9a38777+이번 커밋·검증 총 8왕복): 배경=사용자 지적 '탐색자
> 선택 옵션 부재' — 절차 실패 기록: 설계 정본(1-26·1-34·P5~P8) 미확인 상태로 임의 신설 진행했고, 사용자 제공
> P0 원문 대비 전수 감사(Codex 백지 감사)로 정본 조항 소실 0 확인(누락은 문서가 아니라 구현모델의 확인 절차).
> 실체: 정찰 카드 '탐색 담당(영향지도)' 행 — 기본 정찰(Claude·**무과금 기본 설계**: 유료 키 없이 전부 동작이
> 정본 1-26 의도)/DeepSeek(키=동의·키 없으면 정직 강등)/**Codex 정찰(예정) 비활성 배지**(2026-07-20 사용자
> 결정 — 로드맵 가시화·러너는 P6에서). 선택은 자동 지시·플랜 게이트(Claude/C-C)의 1순위 러너에 반영.
> **경계(정본 1-26 부기): scoutArm=Impact Map 러너 선호 한정 — P7 provider mode(경제형=DeepSeek/정밀형=
> Codex/자동형=조합, readiness 행렬 1-34)는 별도 제어로 구현·통합 금지·'키 없으면 강등' 규칙 P7 재사용 금지.**
> 클릭 피드백(무반응 실보고 봉합): ✓ 표기·재클릭 안내·낙관 전환+'저장 중…'·판정 순수 함수(미지정≠명시 self·
> 연속 클릭 고착 소멸 — 상태 전이 실행 반례). 언어 슬롯 오염 3단 봉합(UI_EN 베이크 전송·slot 원자 캡처·불일치
> 잠금). tests/scout-arm 57단언.
> ⑤**교훈(재발 방지 — ④의 절차 실패)**: 사용자가 기능 부재를 지적하면 **설계 정본 문서·장기 계획(P0~P10)을
> 먼저 대조**하고, 지적의 의미를 못 찾으면 **물어보고 진행**한다 — 임의 해석으로 신설하지 않는다.
> ▶**다음 착수=P3b cutover**(권위 marker 생성·소비처 일괄 전환[대시보드·collectCommon·게이트 4+P4 표면 2]·
> 자동 적용 활성화·docs/MAP.md 동결·재배선 — 정본 §5 P3 항·MAP-P3A-DESIGN.md §F) → P5(provider 공통
> 인터페이스·self typed adapter) → P6(Codex Scout 독립 세션 — 위 '예정' 배지의 실체) → P7(모드 UI) → P8(라우터).
> ── (이전 2026-07-19 push 묶음(8커밋) 요지 —
> P-12 완전 종결+P-8 2단+P-6b 정정+경합 봉합: 정식 백로그 소진(잔여=3트랙뿐)**:
> ①**P-12 2c 기계 판독 딱지**(c5d38ce) — 핵심 프로필 캐논 v2.5: 검증자가 판정 줄 앞에 기계 판독용 지적 블록
> ('[지적 목록 v1]'…JSONL…'[지적 목록 끝]') 의무. 판독기(엄격 마커 문법·tail 결속·손상 진단 원문 비복사)+
> 정합 행렬(블록 부재/손상/표지 없음=보류 강등 fail-closed·blocker 있는 통과 선언=강등·비차단 있는 깨끗한
> 통과=통과(보완) 상향 정정)+[백로그]만 자동 장부 등록([주의]=재판단 후 수동·source=askId 귀속)+민감 방어
> 공용 스캐너(경로·토큰·이메일·제어+%HH 인코딩 fail-closed — 구현 검증 9왕복 중 4왕복이 인코딩 우회 공방).
> 경보 축=실효 판정 권위. tests/p12-machine 117단언. 정본=PENDING P-12 ⓚ 2c.
> ②**P-12 2d 통계·승격 안내**(fc2fbb7) — 통계 행 확장(프로필·캠페인·회차·소요·5종 종결 결과 — 메타만)+단일
> 시도 기록 계층(예산 예약 후 모든 종결 1회 기록·exit 훅 단계 매핑 — 실행 실패 왕복도 보존)+집계(실효 판정
> 권위·캠페인 3분류·완전 추적만 평균·커버리지)+대시보드 '프로필 효과' 카드(정직 라벨: 로컬 관찰 best-effort)+
> 승격 안내(사실 진술 한정). 측정 목표 축소 정정(승격 blocker 수→실효 fail/보류 건수). tests/p12-stats 47단언.
> ③**P-12 종결 — 사용자 결정(07-19)**(7ab5f5c+100c170) — 비강제 안내 채택·차단형 고위험 정책 기각(근거=
> 무결성조차 차단 없음[핵심>무결성 역전]+왕복 상한과 상호 배타 — 현행 구조 한정). 사용자 지시 3축 감사(C-C
> 동일 효과·프로젝트 분리·한/영)에서 실결함 발견·봉합: C-C 경보 supersede가 전역 active 폴백 세션으로 타
> 프로젝트 미확인 경보를 지우던 구멍 → ws 격리(+세션 폴백 변동 시 해소 경보 잔존 방지 — 프로젝트 기준 갱신).
> 후보 잔류 3건(snapshotHash 승격 증명·통계 잠금 격상·nonce 결속)=PENDING ⓚ 2d.
> ④**P-8 2단 — 계약 저장 구조 재설계 완결**(f8999e4) — 단일 관문 updateContractPatch(전 작성자 7종 통일·
> modeSwitch 원자성 보존·무폴더 폴백)+v10 잠금(구조화 JSON 토큰·read-back fence·상태 6분류·구형 토큰 전환기
> 인정)+자동 회수 없음·승인 격리(원자 무클로버 link 복원·.stale-* TTL·활성 잠금 불가침)+확장 복구 사다리
> (dead-valid 1클릭/invalid·owner-unverified 2단 모달/unreadable 조사 안내)+전체 저장 dirty 제한(필드별
> segTouched — 낡은 창의 타 창 갱신 되돌림 차단)+비동기 재시도·mode 결속·aria-live·전체 예외 복구.
> 구현 검증 5왕복 blocker 15(교훈: '확인-후-삭제'는 그 자체가 경합 — fence 실패 자동 삭제는 최종 '삭제 없음').
> 수용 위험 2건 정본 명문화(쓰기 직전 재확인~쓰기 미시 간극·fence 실패 시 프로세스 생존 동안 자기차단).
> tests/p8-stage2 57단언. 정본=PENDING P-8 '2단 구현 실체'.
> ⑤**P-6b 서술 정정**(8ddb5d0) — 구지칭 3fdd104=실제 6998725(07-15 이력 재작성). 그 커밋 본문의 '훅 CAS가
> raced로 밀림'은 오기(정본=훅 성공 후 자동 고정이 eventAt 전진) — 불변 이력이라 정본 선언+주석·문서 정정.
> ⑥**fallback↔훅 경합 봉합**(4128eba — P-6b ③ 완결) — 테스트로 경합 노출 후: 동일 턴 한정 인계(fallback이
> 남긴 턴 힌트와 일치하는 늦은 훅만 raced 대신 정상 합류·eventAt=훅 anchor로 ms 역전 차단)+힌트 수명주기
> 5전이(N+1 교체·훅 성공 소거·해제 잔존 0)+위생 게이트(프로젝트 결속 훅 흔적=지연·침묵 20초 grace — 정확성
> 아닌 빈도 축소). 설계 4왕복(유예 단독안·무조건 합류안 기각). tests/p6b-race 29단언. ⑦이 인수인계 갱신.
> ⚠ **이 PC 백로그 장부(PC별 로컬): 열림 1건** — f17952166d364f8a(대시보드 대화 칩의 실효 판정 통합 표시 —
> 후보·경보 축은 이미 실효 권위로 정합). 다른 로컬에서 이어가려면 그쪽 장부에 재등록 권장.
> ⚠ **3트랙(정찰)은 이번 묶음도 본체·설계 무변경 보존** — **다음 착수=3트랙 잔여**(게이트 승격 재논의·재실측
> 70.5% 후속·관측 장부 등 — §5~§11 삭제·정리 금지).
> ── (이전 2026-07-18 push 묶음(12커밋 — ★후속 정정: 원표기 11은 자기 서술 커밋 d154a83 제외 집계였음, d154a83에는 테스트 단언 추가도 동승했으므로 12가 정확) 요지 — 캐논 v2.3·v2.4+P-12 2b 왕복 상한 완결(2단 잔여 2c·2d)**:
> ①**캐논 v2.3→v2.4**(371d20c→5a5ad30, 각 구현검증 3·4왕복) — v2.3: 보류 3분류 의무([분쟁|미해결 결함|외부 결정]+근거 — '그냥 보류' 금지)+대시보드 부채 카드. v2.4(사용자 구조 비판 2건 수용): **보관함 재정의=범위 밖 제안([백로그])+사용자 판단 대기로 승격한 [주의] 두 종류만·갚을 의무 없음**(v2.3 마감 선별 의무 폐기 — '어차피 할 일 순환' 차단), **[보완] 신설**(자명·국소 — 첫 판정 수용분만 그 루프 일괄 반영+확인 검증 1회·확인 단계 신규 비차단=미반영 보고 — 보완 연쇄 차단), **반박 대등 원칙**(지적=자동 흡수 금지·blocker도 실측 반례로 반박 가능), footer 첫/확인 판정 양분기, 처리표+검증자 보관 분류 기각권. 직전 백로그 소화 4건(1bac267)·인용 점검기 오경보 봉합(08ec05b — /드라이브: 정규화).
> ②**빈 보관함 카드 가시성 실사고 봉합**(61691da) — 장부 열림 0건이면 카드가 통째로 숨어 사용자가 기능 발견 불가(실보고): 숨김은 bl=null(무폴더·구 런타임)만, 빈 상태='비어 있음' 표시. readBacklog가 ENOENT 외 판독 실패를 readError로 구분('불러올 수 없음' 표시+CLI 경고 — 빈 상태 위장 차단). 렌더 블록 추출 실행 반례 RB-1~6(p12-backlog 57단언).
> ③**P-12 2b 왕복 예산 구현 완결**(설계 동결 v6 e3c70ee[6왕복·차단 16건]→구현 d2045e0[검증 4왕복: 실패×3→통과(보완)·blocker 11건 전부 수용·반박 0]) — verifyBudget(CL-C)/codexVerifyBudget(C-C: 부재=상속·명시 0=슬롯 무제한·빈값 저장=키 삭제 비물질화), campaignId=ask-start job 생성 임계구역 동결(CL-C=세션별 active 앵커 권위[전역 active 단독 판독 금지·멀티창 미끼 차단]·C-C=구현자 세션:턴), 예약=자식 cmdAsk 공통 래퍼 1곳(resume/new 호출 직전·전처리 실패=미집계·M+1 소진만 phase/round 불변 exit 3·내구=child stderr→worker .err→ask-wait exit 3 전달), verify-campaigns/<wsKey>.json 임계구역(오프바이원 next=count+1·기록 순서 ①거부 판정 ②정본 영수증[내구=job patch campaignKey/verifyRound/verifyBudget/budgetUntracked·직접=로컬 예약] ③counter — ②실패=예약 취소·③실패=N/M 억제+budgetUntracked 승격·budget=캠페인 최초 예약 시점 동결·**교대 복귀=history 복원(카운터 초기화 금지)·거부/영수증 실패=history·current 무오염·dedupe=같은 캠페인 마지막 줄 '최신 갱신'·history 판독 실패≠신규(미집계)**·손상=corrupt 서랍 원자 격리[P-3 7일 편입·current/history 스윕 비대상]·history 60일 trim[updatedAt·NaN=보존+경고]), **무제한=침묵 집계**(출력 0바이트 무회귀·유한↔무제한 중간 전환도 동결 budget이 권위 — 다음 지시부터), 소진·예고 문구 프로필 분기(core=v2.4 어휘·**'미확인 반영' 예외 폐기=미반영 보고 원칙**+사용자 승인 유도 / integrity=중립), UI vBudget(min 0·touched-only exact patch·C-C 상속 표시·저장 잠금 편입·다음 지시부터 고지). tests/p12-budget(실 child 소진 e2e[ask-start=queued 성공→child가 codex 실행 '전' exit 3→ask-wait 3 전달]·CODEX_BIN spawn 실패 집계 e2e·chmod ③실패 주입 포함)·npm test 체인 등록.
> ④**2b 표현 다듬기**(2cfa188, 사용자 지적 '예산=돈 연상·설명 난해' — 대화 승인 문안을 화면에 그대로) — 라벨 '검증 왕복 상한 — 한 번의 지시(사용자 턴)당 검증을 몇 번까지 돌지'+힌트 전면 재작성(마지막 회차 예고·기계적 거부·blocker 잔존 시 선택지[더 검증 승인/이 상태로 두기/상한 변경] 붙인 보고·유한 상한 한정 미집계), 브릿지 가시 문구 [검증 왕복 상한 …]/[verify round cap …] 통일(가시 문자열 '예산'/'budget' 잔재 0 음성 단언)·소진 보고 선택지 3종 명시 의무. 표시 전용(스키마·필드명·로직 불변). p12-budget 97단언.
> ⑤이 인계 갱신+CI 봉합 2커밋(ae3f024·4f0f4a2 — push 검증이 발견한 ubuntu CI 적자: 원인은 이번 묶음이 아니라 534f9af[07-17 다른 로컬 push 0cb4142부터 실패]의 p12-backlog 절대경로 반례가 POSIX에서 무효였던 것. 플랫폼 분기+p12-budget [6d] win 한정으로 봉합·제품 코드 무변경·CI 양 플랫폼 초록 확인). **미반영(확인 단계 신규 비차단) 1건**: M번째 '마지막 왕복' 예고 4벌(core/integrity×ko/en)에도 선택지 3종 명시(현재는 M+1 거부 문구에만) — 2c 동승 후보(★07-18 후속: 2c 묶음에서 반영 완료). **이 PC 백로그 장부: 열림 0건**(v2.4 마감에서 전부 처분 — 수용 위험 기록·2b 이관 메모는 CODEX-DUAL-PENDING.md에 문서화). ⚠ 3트랙(정찰) 미완·보존 원칙 유지(§5~§11 삭제·정리 금지). ──)
> ── (이전 2026-07-17 push 묶음(5커밋) 요지 — P-12 1단+v2.2+2a 완료:
> ①**P-12 1단**(c36c327) — 검증 강도 프로필 이원화(핵심/무결성): 사용자 채택 배경='벌레 하나 잡자고 집안에 불'
> 검증 폭주 억제. 계약 필드 verifyProfile(CL-C)/codexVerifyProfile(C-C·부재=상속, 둘 다 부재=integrity),
> core 프리셋 ko/en(심각도 게이트 — '실패'=미해결 blocker≥1·실질 영향 분류·교착 시 보류 승격·push 전 무결성
> 승격 권장), core=코드 캐논 고정(오버라이드 저장은 integrity 문안 전용), ask 시작 시점 동결(job.verifyProfile/
> verifyLang 저장→worker 소비·footer 동일값·legacy job=integrity), 대시보드 프로필 세그+정직 라벨.
> 설계 동결 9왕복(확장 6왕복 후 '비례성 판단'으로 축소 — nonce 완전 결속은 2단 이관). tests/p12-profile 49단언.
> ②**카드 표시 보강**(3d2822b, 사용자 지적 수용) — '단계별 기본 원칙' 카드가 실효 프로필의 '실제 주입 문안'을
> 표시(핵심 선택 시 카드 무변화=표시 공백이었음): 핵심=읽기 전용 캐논 뷰·편집/복원 버튼은 무결성 문안 전용
> 잠금(④정찰 칸 통로는 유지)·무결성 미저장 초안 stash 왕복 보존(4결선)·구버전 웹뷰 capability 판별.
> ③**v2.2 [주의] 딱지**(47d84ec, 사용자 우려 '심각한 것만 잡아 부채 누적' 수용) — core 비차단 지적을 3단화:
> [주의]=보안·개인정보·데이터 손상·복구 불능·운영 오판 '인접'+구체 경로 1줄 필수, 구현모델이 심각성 재판단
> (동승 수정 1회 또는 근거 승격·침묵 이관 금지) / [백로그]=자동수정 금지·목록 전달. ko/en 캐논 동시 개정.
> ④**P-12 2a 백로그 장부+기록물 위생 마무리**(534f9af, 설계 동결 5왕복+구현 4왕복) — verify-backlog/
> <wsKey>.jsonl 장부(전 명령 잠금 직렬화·id 중복 제거·tag 단조 승격·재발견 reopen·손상 fail-visible·TTL
> 비대상·민감 최소화)+CLI backlog 5명령+core 재판단 규약에 기록·id 인용 의무. P-2(ask-jobs 7일 TTL+PRIVACY)·
> P-3(서랍 3종 TTL)·P-4 심화(의미 손상 차단·clear 잠금 보호·손상 격리 60분 시한부) 전부 마무리(§1-0 ⑥ 상세).
> ⑤이 인수인계 갱신(push 전 무결성 폭 승격 검증 2왕복 반영 — 로컬 계정명 비식별화·문서 상태 정합 포함). ⚠ **백로그 장부는
> PC별 로컬**(~/.codex-bridge/verify-backlog — 레포에 없음): 작성 PC에 열린 3건+[주의] 승격 1건은 §1-0 끝에
> 옮겨 적음 — 다른 로컬에서 이어가려면 그쪽 장부에 재등록 권장. (★07-18 정정: 이 4건은 이후 전부 처분 완료 —
> 재등록 불필요. 현황은 머리 ⑤ '이 PC 백로그 장부: 열림 0건' 참조.)
> ⚠ **3트랙(정찰) 관련 사항은 미완·보존**: 3트랙 본체·설계·백로그는 이번 묶음에서 무변경 보존(정합 목적의
> 주변 변경 2건만 — 정찰 attempt 서랍 codex-scout-attempts TTL 편입, 프로필 카드의 ④정찰 칸 저장·복원 통로
> 유지 결선). §5~§11의 3트랙 설계·백로그(게이트 승격 재논의·재실측 70.5% 후속·관측 장부 등)는 추후 진행
> 예정이므로 삭제·정리 금지.
> ── (이전 2026-07-16 push 묶음(9커밋) 요지:
> ①**P-1 완결**(f1d765a+2cac330) — 손상 links.json 덮어쓰기 fail-closed: 기록자 3곳+의미검증+spawn 관문
> (requireLinksWritable), links-cas 33단언. ②**P-9 진단·검토 문서 3건**(24d6af1·a63c337·6341f93) — 모드 불일치
> phase 고아 진단, 사용자 제안(질문 호스트 기준 강제 전환) 검토·안전 6조건, 검증 스위치 모드별 분리 설계 동결
> (ⓐ~ⓖ)+P-10 등재. ③**검증 스위치 모드별 분리+P-10**(ae9932b, 구현검증 12왕복) — verifyMode=CL-C 슬롯/
> codexVerifyMode=C-C 슬롯(부재=상속·verify:true 보존·명시적 C-C 저장에서만 물질화), 옛 saveContract 제거→
> 모드별 exact patch(patchContractExt·CONTRACT_FILE fallback), 웹뷰 cardMachine(전환 잠금·되돌리기·외부 전환
> hold — P-10 계약카드 초안 교차오염 해소)+baseMachine(저장 single-flight·정본 fill만 해제)+strict 판독
> (readCanonFile — 가짜 기본값 차단)+langSnap 단일 슬롯, verify-split 134단언. ④**P-9 자동 전환 본체+성공 Stop
> done 종결**(1d31617, 구현검증 11왕복+마무리 확인 5왕복) — 옵션 모드≠질문 호스트면 경고 후 그 호스트 모드로 강제
> 전환(4사례): Claude측 contract-inject=가드(활성 job[ask-jobs+ask-active]·상대 턴 phase 25분·계약 손상) 통과
> 시 전환+고지, 실패 시 프롬프트 차단(fail-closed) / Codex측 autoSwitchToCodex=vscode-user만 자격(exec 침묵·
> unknown 차단)·검증자 충돌 사전차단·스냅샷→패치→고정·원복은 원복 시점 로컬 CAS(session/revision/eventAt —
> 전역 roleRevision 비교 폐기)·links 레코드 손상 등록 거부(validLinksShape) / 성공 Stop rejudging→done(반영중
> 고아 종결), p9-auto-switch 99단언. **라이브 실측: 사례 ①(C-C 설정+Claude 질문→CL-C 전환+게이트 복원)·
> 사례 ④(CL-C 검증 꺼짐이면 전환만 하고 검증 미실행) 한글 슬롯에서 사용자 확인(07-16). 사례 ②③·영문 슬롯·
> 가드 차단 경로는 라이브 미실측(단위 테스트로만 잠김).** ⑤**P-11 등재·종결**(a97ddc6+이 커밋) — 종료 검문
> '판정 후 마무리 기록' 소음 검토: 원안(마지막 판정 통과=통과) 기각(위험 창=마지막 판정 이후 무검증 수정),
> 사용자 최종 결정=현행 유지(3회 차단 후 error 감사 기록+추가 차단 없이 종료 — 사소 수정의 자율 종료 허용,
> 책임은 구현모델), 운영 규칙=마무리 기록을 마지막 검증 앞에 배치. ⑥이 인수인계 갱신. ──)
> ── (이전 2026-07-15 push 묶음(3커밋) 요지:
> ①**P-8 1단**(d0c6af5) — C-C '체크리스트 강제' 체크박스 저장 안 됨 해소: 토글=즉시 저장(그 필드만 재읽기-병합·손상
> fail-closed), 프로젝트×언어 독립, 응답 수명은 순수 상태기 ckMachine(문서세대 reqId·성공도 화면 좌표 불일치면
> hold·5초 만료 자기회복). Codex 7차 왕복 통과. 사용자 실기기 동작 확인(07-15). 2단(전 작성자 잠금)은 백로그.
> ②**P-5 제품 수정**(df85348) — Codex 훅 PS 즉사 명령 근절: 설치기 dual-shell 실검증(bare node 우선·writer가
> 따옴표 시작 토큰 구조 거부), hook-setup PS 사전검사, Reload UX(리로드 버튼·세대별 1회 권고·재신뢰 전이 포착),
> 옛 설치본 마이그레이션 제안(무표식=수동 안내), 창로드 오경고 억제(조회 실패≠미신뢰 사실), 경고 주어를 사용자
> hooks.json(실행 권위)으로 정정. Codex 4차 왕복 통과. 순수 상태기 2종(게이트·추적기)은 테스트가 직접 실행.
> ③인수인계 갱신 — **작성 PC hooks.json 마이그레이션 실적용·폐루프 확인**(경보 해소·lifecycle 훅 정상·
> 체크리스트 저장 동작 사용자 확인 07-15). ──)
> ── (이전 2026-07-09 push 묶음(17커밋) 요지:
> ①**관찰 일지 진화**(복권 규칙[반박 후 사람1/검증2 재확인]·확인 증거 기록 차단 해제·틀림 각주 완화·트림 판정/증거
> 보존 — "지식은 진화해야" 사용자 방향) ②**언어 슬롯 분리**(정찰 설정·태도 슬롯 — 한/영 생활권 분리, API 키만 전역)
> ③**정찰 프롬프트 ④칸**(단계별 기본 원칙이 트랙 따라 확장 — 태도 편집·형식 잠금 노출·프롬프트 서명) ④**검증 통계
> 3트랙 기여 카드+정찰 비용 장부**(scout-usage.jsonl 60일 — DeepSeek 실측 토큰·기본 정찰 문자수·ping) ⑤**재실측
> 70.5%**(실측 러너 일지 주입[시간 절단]+ablation — 기억 없음 45.5% vs 주입 70.5%, 합격선 60% 최초 돌파 → 게이트
> 승격 재논의 대기) ⑥**상태바 정찰 글자 표시**(flow 3박스 '탐색중·DeepSeek') ⑦**'팔' 은어 전수 교체**(기본 정찰
> (Claude)/DeepSeek 정찰) ⑧**동봉 재랭킹**(바뀐 파일 교집합 우선·실존 필터·후보군 24 — §6-7-1) ⑨이중언어 전면
> (CLI 7종·훅·지도 원문 언어)·문서 정합(PRIVACY 예외 둘·가이드 복권 반영). 직전 push 묶음(14커밋):
> ①전달 원칙 v3(검증 '응답' 축약 요청 금지 — 판정 표지누락 유도 방지, 사용자 문안) ②두뇌 '실제 답' 상시 표시
> (히어로+상태바 — 결정 실험: 앱 모델 피커 체크마크는 답을 지배하지 않는 표시 결함으로 확정, 커밋 9c65848 본문 참조)
> ③**관측 장부 점화**(이벤트 0건 공백 해소 — 파서 위생·legacy 지도 상태·버킷 재알림·씨앗 백필 CLI, §6-3 4-1)
> ④플랜 게이트 실험 성공 판정(§6-3 ⑥ — PreToolUse가 ExitPlanMode를 잡음 확정) ⑤꾸러미 렌더 민감 파일명 전면
> 가리기+pytest 테스트 발견(대형 Python 레포 실측 결함 2건 — tg급 서비스 1차 실증) ⑥정찰 UI 3연타(용어를 '정찰
> 흐름' 4단계로 통일·LLM 필수성 정직 고지·사람 언어 전면 순화·색 카드 시안성·구조 안내 새탭·유형별 기대 실효성). ──)
> ⚠ **2026-07-15 main 이력 재작성(force push)**: 저장소에 있어선 안 될 비공개 로컬 문서 1건이 폴더째 백업 커밋에
> 섞여 들어와 이력에서 제거했다(내용·경로는 의도적으로 미기재). **기존 클론은 먼저 `git status`로 무커밋 수정·무추적 파일을 확인해
> 백업(stash 또는 폴더 복사)한 뒤, `git fetch origin` → `git reset --hard origin/main`으로 맞출 것**(reset은
> 무커밋 작업을 지운다 — 백업 선행 필수. 로컬 커밋이 있으면 rebase — 재작성 구간은 2026-07-13~14의 7커밋,
> 내용 동일·해시만 변경). 교훈: 폴더째 백업 커밋 전 비공개 파일 목록 점검.
> ⚠ **새 환경 온보딩은 한 순서로**(P-5 확정 원인 ① — 리로드 순서가 틀리면 훅이 옛 설정 스냅샷으로 죽는다):
> `node install.js` → 창 리로드(확장·브릿지 최신화) → C-C 쓸 거면 Codex Peek 패키지 설치·활성화 →
> Codex 설정→Hooks에서 네 사용자 훅(SessionStart·UserPromptSubmit·PostToolUse·Stop — 경로는 UI가 표시하는
> 실제 `CODEX_HOME/hooks.json` 기준, 통상 `~/.codex/hooks.json`) 신뢰 → **다시 창 리로드**(신뢰 이전
> 스냅샷 폐기) → 실제 대화 시작·프롬프트 1회로 heartbeat 확인. 옛 형식 명령이 감지되면 확장이 교체를
> 제안한다(교체 후 재신뢰+리로드 재필요·무표식이면 수동 안내). 마켓 vsix는 개발중이라 미배포.
> ⚠ Codex↔Codex 모드 세부: 사용하려는 Codex 대화를 시작·재개하면 기존 구현 연결의 수동 해제 없이 그 대화로 구현 연결과 초록 표시가 자동 이동하며, UI 목록 클릭만으로 resume이 발생하지 않는 경우 첫 프롬프트 rollout이 보조 고정한다. 플러그인 번들에는 중복 훅 정의를 싣지 않는다.
> ⚠ **3트랙 계약·장부·지도는 PC별**(~/.codex-bridge) — 새 환경에서 3트랙을 쓰려면 대시보드에서 켜거나 계약 파일 생성,
> 기존 지도가 있으면 `node scripts/scope-ledger-backfill.js`(멱등·--dry 지원)로 장부 씨앗을 소급 점화할 수 있다.

## 0. 프로젝트 한 줄

**Codex Bridge**: Claude Code(구현) ↔ Codex CLI(검증)를 잇는 VS Code 확장 + 브릿지 런타임(`~/.codex-bridge/*.js`) + Claude 훅.
여기에 **3트랙(탐색)** — "지금 바꾸는 것이 어디까지 영향을 주는가"를 별도 AI(탐색자)가 지도로 그려주는 축 — 을 얹는 중.

## 1. 개발 규칙 (사용자 확정 — 위반 시 재작업됨)

1. **로컬 우선**: 기능 묶음 완성 전까지 로컬 개발·로컬 설치·테스트·**로컬 커밋**만. 푸시는 묶음 완성 또는 사용자 지시 시.
   ⚠ 오해 금지(2026-07-07 사용자 정정): **로컬 설치(`node install.js` → ~/.codex-bridge 즉시 반영)는 승인 불요·기본 동작**이다.
   승인이 필요한 건 대외 배포 3종 세트(버전 bump·깃헙 push·마켓 게시)뿐 — "버전 불변"을 "로컬 미반영"으로 읽지 말 것.
2. **버전 정책**: 커밋·푸시는 버전 불변. bump는 의미 묶음 완성 + **사용자 승인** 시에만. 마켓 게시는 별도 지시가 있을 때만.
3. **마법 시간 상수 금지**: "15분", "24시간" 같은 임의 시간 창으로 실사용을 재단하지 말 것(실제 사고 2회 — 두뇌설정 15분,
   무이력 seeds 24h). 시간 대신 **작업 신호·상태 서명** 기반으로 설계하고, 불가피한 상수는 근거를 주석에 남기고 사용자 확인.
4. **정직성**: 자른 것·못 보는 것·간주한 것은 반드시 산출물에 고지. "완료" 선언은 구조적 해결에만. 예시 하나 통과=완료 아님.
5. **경직성 금지**: 구체어·패턴 목록 누적으로 증상을 막지 말 것. 범주 규칙·구조 신호로.
6. **검증 2트랙**: 모든 결론은 `node ~/.codex-bridge/codex-bridge.js ask "..."`로 Codex 검증(원격 확인 필요시만 `--net`) →
   지적을 항목별 [수용/반박/보류]+근거로 재판단 → 통과 후에만 보고·커밋. 검증 후 수정했으면 재검증.
   ※Codex↔Codex 모드의 구현 세션은 직접 ask가 거부됨(P-6 영수증 계약) — ask-start --allow-new → ask-wait <id> 내구 경로만 성공 증명으로 인정.
7. **모든 UI 문구는 한/영 쌍**(t/T/tE). 한국어만 넣으면 EN 모드 회귀.

### 1-0. 2026-07-14~16 로컬 진행 — C-C 훅 사가 해결 + P-6/P-6b + 검증 스위치 분리·P-9 자동 전환 완결 (07-16분은 문서 머리의 접힌 '이전 2026-07-16 push 묶음(9커밋) 요지' 참조 — 최신 진행은 머리말 '이번 push 묶음' 요지가 정본)

- **훅 미작동 3층 원인 해결(이 PC 폐루프 성공)**: ①리로드 전 장기 실행 app-server가 훅 설치 이전 설정 스냅샷 유지(Reload로 해소) ②핵심 — Codex는 Windows에서 훅을 감지된 기본 셸(PowerShell) -NoProfile -Command로 실행하는데 설치기 생성 명령 '"<node절대경로>" "<script>"'가 PS 파서 오류로 즉사·무로그(업스트림 0.144.0-alpha.4 소스 확인) ③사전검사가 cmd로만 검증(hook-setup.ts:30). **이 PC 핫픽스**: ~/.codex/hooks.json 4훅을 'node "<script>"'로 교체(교체 전 hooks.json 백업 권장·교체 후 Codex 설정>Hooks 4개 재신뢰→Reload→새 C-C 대화에서 heartbeat/경고 소멸 확인). ~~다른 로컬도 같은 핫픽스 필요~~(제품 수정 완료 2026-07-15 — 확장이 옛 형식을 감지해 교체를 제안[무표식=수동 안내]하고, 설치기는 PS·cmd 양쪽 실검증 통과 토큰만 기입. 상세=CODEX-DUAL-PENDING.md P-5). **작성 PC도 2026-07-15 옛 형식 실측 확인 후 마이그레이션 writer로 교체 적용, 재신뢰+리로드+프롬프트로 폐루프 성공**(경보 해소·PostToolUse heartbeat 정상·체크리스트 저장 동작까지 사용자 확인 — 백업 hooks.json.bak.2026-07-14T21-38-21-555Z. 경보 해소 조건(정확): C-C 유지 시 대상 슬롯의 hooks/list 신뢰 4/4 + 현재 구현 세션의 최신 lifecycle 하트비트[codex-active/<session>.json, source=codex-hook·현재 turn 일치 — 단 SessionStart는 최신 기존 turn 이후 타임스탬프면 turn 일치 없이 인정] 확인, 또는 C-C 해제 — 신뢰만으론 안 꺼짐. 주의: 테스트 전 실제 사용할 언어 슬롯(ko) 계약이 codex-codex인지 확인[07-15 실측: ko=claude-codex로 되돌아가 있고 C-C는 en 슬롯에만 저장돼 있었음]).
- **P-6 완결(커밋 8a944af)**: '검증 미완 4라운드'(회수 도구 호출이 proof 자기무효화) 구조 해소 — 회수 영수증 계약(job 동결 스냅샷→proof v2[같은 role-lock 재검사+기록]→ask-wait 영수증[결정론 바이트·read-back 후 출력]→Stop은 턴·revision·지문·HEAD OID 결속 체인). C-C에서 직접 ask 금지(ask-start→ask-wait만)·구계약 v1 proof 불인정. 신규 tests/codex-verify-recovery.test.js.
- **P-6b 완결(커밋 6998725 — 07-15 이력 재작성 전 구지칭 3fdd104)**: 자동 고정의 같은-세션 세대 전진 제거(applyAutoPinUpdate — 같은 세션 재관측=lastSeenAt만)·rollout 스캐너의 hook_prompt 오인 제외(isInjected+bridge 쌍둥이). §5-9의 '보조 고정도 두 revision 증가' 계약은 이 커밋으로 개정됨. 잔여였던 다른 세션 첫 프롬프트 fallback↔훅 경합은 07-19 완결(동일 턴 한정 인계 — PENDING P-6b).
- **P-7(업스트림·수정판 존재)**: Stop 차단 피드백에 UUIDv7 id → 대화 이어가기 invalid_id_prefix 거부. openai/codex#20783·PR #32312·rust-v0.145.0-alpha.5 수정. 이 PC는 확장 재시작으로 0.144.2 로드(backport 미확정 — 라이브에서 재발 시 새 대화 우회). 상세=CODEX-DUAL-PENDING.md P-7.
- **P-8(1단 완료 2026-07-15 · 2단 완료 2026-07-19)**: C-C '체크리스트 강제' 체크박스 저장 안 됨(state 푸시가 저장 전 DOM 되돌림). **1단 반영: 토글=즉시 저장·재읽기-단일필드 병합(patchContractFields — 손상 fail-closed)·큰 저장에서 체크리스트 제외·프로젝트×언어 독립·응답 수명=순수 상태기 ckMachine(서술자 결속, 성공도 화면 좌표 불일치면 hold — 재활성·되돌림 없이 정본 state 채움만이 값·활성화 적용, 5초 만료 자기 회복)·호스트 모드 결속 기록 거부(fail-closed) — ★2026-07-16 갱신: 잠금 축은 '검증 스위치 분리' 묶음(ae9932b)에서 선반영됨 — patchContractFields·확장·스크립트 작성자 전부 계약 파일 잠금 참여(동시 저장 lost-update 해소). 2단은 07-19 완료(단일 관문 updateContractPatch+v10 잠금·승인 사다리 — §1-0 ⑧·PENDING P-8 구현 실체 참조). 테스트 tests/p8-checklist=도우미 실동작+배선 잠금+상태기 순서 반례 실행**. 이력: 설계 10왕복 끝 사용자 방침=2단이었고, 1단 설계 '당시'에는 무잠금 lost-update가 알려진 한계·2단 백로그가 '전 작성자 잠금 도입'이었음 → ae9932b에서 잠금 축이 선반영돼 그 한계는 해소, 2단 완료(07-19). 전체 설계·사용자 구조 원칙(프로젝트×언어×모드 분리·3트랙만 공용)=CODEX-DUAL-PENDING.md P-8.
- 다음 순서: ~~①P-8 최소 수정~~(완료 2026-07-15) ~~②P-5 제품 수정~~(완료 2026-07-15 — 설치기 dual-shell 실검증·PS 사전검사·Reload UX 계약 ①~⑤·마이그레이션·창로드 오경고 억제[조회 실패≠미신뢰 사실, fail-closed는 대시보드 경보 유지] · tests/p5-hook-command, 상세=CODEX-DUAL-PENDING.md P-5) ~~③검증 스위치 모드별 분리+P-10~~(완료 2026-07-16 ae9932b) ~~④P-9 자동 전환 본체+성공 Stop done 종결~~(완료 2026-07-16 1d31617 — 라이브는 사례 ①④·한글만 실측) ⑤~~P-12 검증 강도 프로필 이원화(핵심/무결성)~~(**1단 구현 완료 2026-07-17** — 설계 동결 v2.1[9왕복: 확장 6왕복 후 비례성 축소 — nonce 완전 결속은 2단 이관]·계약 필드 verifyProfile/codexVerifyProfile[부재=integrity·C-C 상속]·core 프리셋 ko/en[심각도 게이트·(백로그) 분리·자동수정 금지·교착 시 보류 승격·승격 게이트 권장]·오버라이드는 integrity만[core=캐논 고정]·ask 시작 시점 동결[job 저장→worker 소비·footer 동일값·legacy=integrity]·대시보드 프로필 세그+정직 라벨+전환 효력 정확 고지·tests/p12-profile 49단언(정본 판독 실행 검증 포함). 2단 중 2a 백로그 장부는 ⑥에서 완료 — 잔여=2b 예산·2c 기계 판독·2d 통계/승격+nonce 결속(⑦ 참조). 정본=CODEX-DUAL-PENDING.md P-12 계약 ⓐ~ⓛ) ⑥~~P-12 2a+P-2·P-3·P-4~~(**완료 2026-07-17** — [2a] 검증 백로그 장부 verify-backlog/<wsKey>.jsonl: 전 명령 <파일>.lock 직렬화[실패=기록 거부]·fold=append 줄 순서[ts=표시용]·id=sha256(정규화 제목|경로) 16hex 중복 제거·tag 단조 승격[백로그→주의만]·재발견=reopen·손상 줄 fail-visible[개수 경고·clear 원문 보존]·TTL 비대상[수동 clear만]·민감 최소화[제목 200자·비밀 원문 금지·ws 내부 상대화/외부 basename], CLI backlog add(id 영수증)/list/done/dismiss/clear, core 재판단 규약에 기록+id 인용 의무 연결. [P-2~P-4] ask-jobs 7일 스윕[부속물 포함]+PRIVACY 표 7행, 서랍 3종 TTL 편입, 손상 차단 심화: 의미 손상[스키마·id↔파일명·state]도 차단·clear는 생성과 같은 잠금+queued&deadline 미경과 삭제 거부+이중 PID 생존 검사·파싱 불가=삭제 아닌 원자 격리[원문 보존·60분 시한부 차단 유지]. tests/p234-hygiene 29단언+p12-backlog 30단언. 설계 동결 5왕복[격리 시한부·fold 권위 단일화·전이표·경합 직렬화]+구현 검증 4왕복[의미 손상 수용·../ 탈출·..세그먼트 경계·id 축소 오삭제 등 전부 봉합, 통과(보완)]. P-1은 07-15 해결.) ⑦~~P-12 2b 왕복 예산~~(**완료 2026-07-18** — 설계 동결 v6 e3c70ee[6왕복·차단 16건]+구현 d2045e0[검증 4왕복·blocker 11건 전부 수용: 교대 복귀 history 복원·거부 무오염·유한↔무제한 동결·C-C 명시 0·판독 실패 fail-visible·프로필별 소진 문구('미확인 반영' 폐기=미반영 보고 원칙)]+표현 다듬기 2cfa188['검증 왕복 상한' 라벨·선택지 3종 명시]. 유의: C-C 직접 ask는 기존 차단 선행이라 직접 예약 경로=CL-C 전용·무제한=침묵 집계(출력 0바이트). 정본=CODEX-DUAL-PENDING.md ⓚ 2b '구현 실체'+1~3차 blocker 반영 블록. 캐논은 v2.4가 정본[보관함 두 종류·(보완) 신설·반박 대등 — ⓝ]) ~~2c 기계 판독 딱지~~(**완료 2026-07-18** — 설계 동결 5왕복 v2~v5+구현: 캐논 v2.5[verifyBaseline 5) 지적 블록 '[지적 목록 v1]'…JSONL…'[지적 목록 끝]'+3) 지적 0건=통과 문구 정정], parseFindingsBlock[엄격 마커 문법·plain object 스키마·손상 진단 원문 비복사 {lineNo,reasonKey}], judgeMachineVerdict[정합 행렬: 블록 부재/손상/표지 없음=보류 강등 fail-closed·blocker≥1은 '실패'만 정합·비차단 있는 깨끗한 통과='통과(보완)' 상향 정정·보류 선언은 고유 의미], **[백로그]만 자동 장부 등록**([주의]=재판단 후 승격 시 수동 — v2.4 보관함 의미 보존·동결에서 원 개요 정정), safeBacklogAutoTitle 민감 방어[형태 일반형: 드라이브·UNC 3형·유닉스 절대경로 일반 경계·물결·이메일·비밀형 접두·32+ 연속 덩어리 — 거부=원문 비복사·수동 폴백], 강등·정정=footer+flagVerdict machine-verdict 경보[supersede 최신 1건]+verdicts.jsonl 같은 행 machine 필드[이중 집계 없음]. proof=실행 영수증 계약 유지(2차 검증에서 반박 성립 — 판정 결속 완료 게이트는 P-6 개정 별도 후보). 동승: M번째 예고 4벌 선택지 3종 반영. tests/p12-machine 117단언[실 child e2e: 반복 회수 3축 동일·장부/이벤트 수 불변]. 정본=ⓚ 2c 블록)→~~2d 통계·승격 안내 기본~~(**완료 2026-07-19** — 설계 동결 7왕복 v1~v7+구현: 통계 행 확장[profile·campaignId·verifyRound·budgetTracked·durationMs·blockerCount·outcome — 메타만], 단일 시도 기록 계층[예약 후 모든 종결=5종 결과 1회 기록·exit 훅 단계 매핑 — 실행 실패 왕복도 통계 보존], 집계[실효 판정 권위·캠페인 3분류 core/integrity/mixed·완전 추적 캠페인만 평균·커버리지·회차 의미 검증·MIN_SAMPLE 5], 대시보드 '프로필 효과' 카드+정직 라벨(best-effort·감사 아님)+승격 안내(사실 진술 한정 — '최근 핵심 이후 무결성 기록 없음'·구 기록 병기). 측정 목표 축소 정정: 승격 blocker 수→실효 fail/보류 건수(무결성 무회귀 우선). tests/p12-stats 47단언. **사용자 결정 완료(07-19): ①P-12 2단 종결(비강제 안내 채택) ②차단형 정책 기각(근거=무결성조차 차단 없음[핵심>무결성 역전]+왕복 상한과 상호 배타 — 현행 구조 한정 서술, 상세=PENDING ⓚ 후보①)**. +3축 감사(사용자 지시 07-19)에서 C-C 경보 supersede의 전역 active 폴백 교차 프로젝트 삭제 blocker 발견·봉합(supersedeIntegrity ws 격리 — p12-stats [8]) — 후보 잔류 3건(snapshotHash 승격 증명·통계 잠금 격상·nonce 결속)=ⓚ 2d 블록 — 차단형 정책은 기각(사용자 결정 07-19·재론 조건 병기). 정본=CODEX-DUAL-PENDING.md P-12 ⓚ)→**다음 착수=P-8 2단 잔여**(⑧) ⑧~~P-8 2단~~(**완료 2026-07-19** — 단일 관문 updateContractPatch[전 작성자 7종 통일·modeSwitch 원자성 보존·무폴더 CONTRACT_FILE 폴백]+v10 잠금[구조화 JSON 토큰·read-back fence·상태 6분류·구형 토큰 전환기 인정]+자동 회수 없음·승인 격리[.stale-* 보존·TTL·활성 잠금 sweep 금지]+확장 복구 사다리[dead-valid 1클릭/invalid·owner-unverified 2단 모달/unreadable 조사 안내]+비동기 재시도+mode 결속·aria-live·전체 예외 복구. tests/p8-stage2 57단언. 정본=CODEX-DUAL-PENDING P-8 '2단 구현 실체')·~~fallback↔훅 경합~~(완료 07-19 — 동일 턴 한정 인계+힌트 수명주기+위생 게이트·tests/p6b-race 29단언·정본=PENDING P-6b '잔여 경합 완결') ⑨~~P-6b 서술 정정~~(**완료 2026-07-19** — 커밋 6998725[구지칭 3fdd104] 본문의 '훅 CAS가 raced로 밀림' 오기는 불변 이력이라 커밋은 그대로 두고, 정본 선언[PENDING P-6b '서술 정정 완결']+동일 오기 코드 주석(implementer-auto-pin.ts) 정정+구지칭 해시 갱신으로 완결) ⑩3트랙(정찰) 잔여는 미완·보존(§5~§11 — 게이트 승격 재논의·재실측 70.5% 후속 등, 추후 진행. 이번 묶음은 본체·설계 무변경이나 정합 목적 주변 변경 2건은 있음 — 머리말 ⚠ 참조). P-11은 검토 후 현행 유지로 종결(07-16).
- **작성 PC 백로그 장부 열린 3건(07-17 이관 — 장부는 PC별 로컬이라 레포에 없음, 다른 로컬에서는 `backlog add`로 재등록 권장)**: ⑴`5b6fff1d950b08a9` backlog CLI list 영문 모드에서 태그·횟수 라벨(주의/백로그/회) 한국어 잔존 — 표시 번역 필요(bridge/codex-bridge.js) ⑵`25dd39231bc50a9f` 장부 동시 프로세스 경합(add vs clear)의 실제 자식 프로세스 회귀 테스트 부재(현재는 잠금 보유 거부 테스트만, tests/p12-backlog.test.js) ⑶`12fc4f498f9a9e74` 의미 손상 add(not-a-hash id) 반례가 지속 회귀 테스트에 미포함(검증에서 1회 실행 확인만). **+[주의] 사용자 승격 1건(수정 안 함·데이터·증적 훼손 없음 판정 07-17 — 운영 영향은 있음)**: 손상 ask-job 격리 차단이 시계 보정 시 문서상 60분이 아니라 최대 ~119분 가능(그동안 해당 ws의 새 검증 시작이 차단됨. `|now-격리시각|<60분` 대칭 판정 — 무기한 아님·안전 방향, bridge/codex-bridge.js QUARANTINE_BLOCK_MS).

### 1-1. 2026-07-12 로컬 진행 — 검증 deadline 일치 + Codex↔Codex 이원화

- 대시보드 `verifyTimeoutMin`이 직접 `ask`뿐 아니라 내구 작업(`ask-start` 1회 + pending 동안 `ask-wait`)의 deadline 정본이다. 외부 호출창이 10분에 닫혀도 worker는 사용자가 저장한 1~60분까지 살아 있으며, 같은 워크스페이스의 두 번째 작업은 차단한다. 테스트는 임의값 7분·23분으로 고정값 회귀를 막는다.
- Claude↔Codex도 예외가 아니다. `contract-inject`의 UserPrompt 지시와 `verify-guard`의 Stop 재차단 모두 같은 `verifyTimeoutMin`을 읽어 `ask-start` 1회+동일 `ask-wait` 반복을 지시한다. 옛 직접 `ask` 문구는 제거했고 `tests/verify-guard.test.js [2b]`가 기본 harnessMode의 ko/en 23분 경로를 실행 검증한다.
- `harnessMode` 기본은 `claude-codex`, 선택값은 `codex-codex`. 현재 프로젝트의 ko/en 계약 파일마다 모드와 `codexImplementer`/`codexVerifier` 규칙·체크리스트를 따로 보존한다. 단계별 기본 원칙과 3트랙 지도·일지·문서는 프로젝트 공용이다.
- Codex↔Codex 구현자는 `SessionStart(startup|resume)`의 실제 `session_id`를 현재 프로젝트의 `implementerSession`으로 원자 갱신하고, 해당 UI가 목록 클릭만으로 resume을 만들지 않는 경우 UserPromptSubmit/rollout이 보조 고정한다. 따라서 시작·재개한 현재 대화로 초록 표시가 이동하며, 대시보드의 수동 구현 연결/인계 UI는 없다. 이것은 하네스의 임의 세션 생성·후보 선택이 아니며, 검증 세션의 자기검증만 거부한다. 새 대화의 첫 훅도 논리 프로젝트 폴더와 계약의 실제 작업 저장소(`scoutRepo`)를 역추적하고, 이후 `codex-active/<session>.json` 앵커가 작업 cwd 변경에도 원 프로젝트 계약을 유지한다.
- Claude verifier는 `codexSession`, C↔C 전용 verifier override는 `codexCodexSession`이다. override가 없으면 C↔C는 Claude verifier를 복사하지 않고 실시간 상속하며 보라색 선+동일세션 표지를 보인다. `codexCodexModelPrefs`도 같은 fallback/override 구조이고, UI에서 전용값을 지우면 즉시 Claude 모드 설정으로 복귀한다.
- Codex 공식 사용자 훅은 SessionStart(대화 시작·재개 즉시 구현 세션 자동고정과 규칙 주입), UserPromptSubmit(구현 규칙·전달 원칙·3트랙 지시), PostToolUse(변경·생존 신호), Stop(검증 proof·3트랙 플랜 게이트와 생존 신호)을 적용한다. C↔C 구현자와 검증자는 모델·추론강도 모두 drift 경고, Claude 구현자는 기록 한계 때문에 모델만 경고한다. 훅 effort가 비면 첫 실제 rollout `turn_context`로 구현자 기준선을 1회 보충한다.
- 잠금 테스트: `tests/verify-timeout.test.js`, `tests/ask-job.test.js`, `tests/ask-active.test.js`, `tests/harness-mode.test.js`, `tests/implementer-baseline.test.js`, `tests/integrity-i18n.test.js`. 최초 verifier 감사에서 잡힌 전용 verifier→구현자 역등록, effort 없는 첫 훅 뒤 후속 값 기준선 탈취, 사라진 수동 역할변경 안내를 닫았다. `metaHistory`의 자동고정 이후 첫 실제 turn_context만 기준선으로 쓰며 후속 훅은 빈 effort를 채우지 않는다. 두 번째 감사의 clean-checkout 지적도 수용해 신규 테스트를 `tsc` 뒤로 옮겼고, `out/implementer-baseline.js`를 실제 삭제한 상태에서 전체 `npm test` 214.7초 통과.
- 같은 날 기존 연결 verifier의 독립 감사에서 추가 반례를 닫음: role 공용 fail-closed lock·verifier 재연결 시 구현 필드 병합·stale verifier와 동시 UI relink 최신값 우선·unlink 시 모델 기준선 제거, ask-start 원자 예약/전수 scan·별도 PID 영수증·PID 없는 deadline 경과 실패·절대 deadline 전달, 새 세션 `--json thread.started` 즉시 ID·모든 미연결 실패의 `autoNewFailed`, C-C에서 Claude Stop/플랜 훅 무동작·Bash/MCP 변경 신호, 모드별 plan 도움말, Codex launcher(.exe/.cmd/.bat/.js/PATH) 정규화(cmd 전용 인용+windowsVerbatimArguments·bare PATHEXT 이름 비인용·JS ELECTRON_RUN_AS_NODE 포함)·marketplace 등록 확인 후 순차 플러그인 설치. 사전 테스트는 `ask-job` 16, `harness-mode` 전수, `verify-timeout` 17, `codex-plugin-install` Windows 21(비Windows 17)이며 Claude↔Codex timeout [2b] 추가 당시 전체 `npm test` 176.1초 통과(리포지토리에 로그 산출물은 커밋하지 않음).
- **두뇌 경고 회귀 수정(2026-07-13)**: 논리 프로젝트 폴더와 계약의 실제 작업 저장소(`scoutRepo`)가 다르면 두 위치 중 최신 응답을 같은 프로젝트 실제값으로 선택하되, 명시되지 않은 형제 폴더는 계속 배제한다. 그래서 C-C/C-Claude 검증 두뇌 저장 직후 모델·추론강도 경고가 다시 생긴다. C-C 구현자는 UserPromptSubmit의 `codex-active`뿐 아니라 **Codex 모델 피커가 클릭 즉시 rollout에 남기는 `thread_settings_applied`** 모델·추론강도를 현재 선택값으로 읽어, 프롬프트를 보내기 전에도 자동고정 기준선과 다르면 경고한다. 이것은 `turn_context`(실제 적용/답 값)와 별도 필드로 보존해 “실제 답” 표기를 선택값으로 오염시키지 않으며, 구현 Codex 실제 답에도 다른 두뇌 표시와 같은 경과시간을 붙인다. active 파일이 아직 없는 재설치/재개 상태도 기존 `implementerSession` 연결로 원 프로젝트를 복구한다. Claude 모델 선택은 Windows 원자 파일교체에서 `fs.watch`가 빠질 수 있어 포커스된 창만 750ms 보조 감시(타 창 오귀속 금지). `scanCcTranscript` 캐시는 workspace 키도 포함해 논리/실작업 폴더 스캔이 서로 덮이지 않는다. 검증 두뇌 저장은 대시보드뿐 아니라 상태바도 즉시 재계산한다. 잠금: `brain-drift` 51단언·`brain-intent` 49단언·`rollout-scan` 49단언·`harness-mode`·`configws`; 추가 수정 뒤 전체 `npm test` 174.6초 통과, 브릿지 16/16·확장 JS 14/14 설치 해시 일치.
- **Codex 구현 훅 설치·생존 차단(2026-07-13, 자동귀속 정정 당시 기록)**: 확장 활성화 때 Claude 훅 제안이 끝난 다음 Codex Peek 플러그인이 없으면 별도 설치 동의 흐름을 자동 제안하고, C-C 모드 선택 시에도 같은 설치 흐름으로 진입한다. 설치는 `codex plugin marketplace add <확장루트>` → 기존 등록 확인 → `codex plugin add codex-peek@codex-peek-local` 순서이며, 확장이 신뢰를 대신 승인하지 않는다. 이 시점 구현은 app-server `hooks/list`로 UserPromptSubmit·PostToolUse·Stop 세 훅의 실제 `trustStatus`를 별도 조회하고, 현재 구현 세션의 UserPromptSubmit heartbeat만 rollout 최신 `turn_context.turn_id`와 대조했다. 이 제한과 이후 보완은 아래 두 항목에 기록한다. 조회 전·시간초과·프로세스 오류는 `hooks-unverified`로 fail-closed하며, 결과·진행중 요청·TTL은 실제 `scoutRepo` 조회 CWD별로 분리한다. 없거나 낡거나 비교 불능이면 `codex-hook-missing` 빨강 경보를 내며 확인 버튼으로 숨길 수 없다. 사용자가 직접 프롬프트를 보낸 현재 Codex 세션은 기존 구현 연결을 원자 교체하지만, 하네스가 새 구현 세션을 생성하거나 임의 후보를 고르지는 않는다. verifier/implementer 링크가 아직 0개인 프로젝트도 계약 파일의 `workspace`와 `scoutRepo`로 첫 프롬프트를 역추적한다. 검증 세션은 기존 원칙대로 Claude 모드 연결을 기본 공유하고 사용자가 전용 검증으로 교체한 경우에만 분리 저장한다. 플러그인 신원은 `codex-peek@personal`·`codex-peek@codex-peek-local`만 허용하며 비활성 설치는 덮어쓰지 않는다. 잠금: `tests/codex-hook-health.test.js`(전체 `npm test` 체인 포함), `tests/harness-mode.test.js`, `tests/rollout-scan.test.js`, `tests/codex-plugin-install.test.js`. 당시 머신 실측에서 설치·활성된 personal 세 훅이 모두 `untrusted`로 정확히 분류됐고, 전체 `npm test`가 177.8초 통과했다. 기존 공유 검증 세션의 1차 감사 실패 5건을 모두 보완한 뒤 재검증 `검증: 통과`를 받았다.
- **Codex 현재 대화 자동고정 보조 경로(2026-07-13 실사고 당시 기록)**: 당시 세 훅을 모두 신뢰한 뒤에도 신뢰 변경 전부터 살아 있던 VS Code/Codex 프로세스의 기존 대화에서는 `UserPromptSubmit`이 0건이고 질문 rollout만 생기는 상태를 실측했다(`PostToolUse`와 구분해 로그 대조). 그래서 UserPromptSubmit을 권위 경로로 유지하되, 확장이 같은 프로젝트 rollout의 실제 비주입 사용자 프롬프트를 감지해 가장 최근 VS Code 사용자 대화로 `implementerSession`과 초록 표시를 옮기는 보조 경로를 추가했다. `source=exec` 검증 세션·하위 에이전트·현재 Claude/C-C 검증 역할은 후보에서 제외하며 세션을 새로 만들지 않는다. 보조 경로는 `codex-active` heartbeat를 절대 위조하지 않으므로, 당시에는 실제 훅이 안 돈 상태의 모든-턴 검증을 계속 빨강으로 차단하고 문구를 “세 훅 신뢰 완료·UserPromptSubmit 미실행·창 리로드 필요”로 구체화했다. 훅 신뢰 비동기 조회 완료도 즉시 재렌더한다. 프로젝트 귀속은 모든 운용 모드와 한·영 양쪽 계약의 논리 workspace/scoutRepo 경계를 포함해 **정확 일치 우선, containment는 소유 프로젝트가 유일할 때만** 허용한다. exec/subagent는 최대 1MiB의 첫 `session_meta`에서 본문 파싱 전에 제외하고, 실제 prompt/link waterline 이후의 VS Code 사용자 rollout 최대 16개만 읽어 20개 증분 캐시의 반복 축출을 막는다. 공식 훅 처리시각과 보조 prompt 시각을 섞지 않고 현재·후보의 실제 prompt 시간축으로 비교하며, 역할 잠금 대기 중 snapshot이 바뀌면 fail-closed한다. `node install.js` 마지막 안내도 **Developer: Reload Window 필수**를 명시한다. 잠금: `tests/implementer-auto-pin.test.js`, `tests/rollout-scan.test.js`(실제 prompt↔turn_context↔cwd 결속), 최종 전체 `npm test` 176.8초 통과. 설치본 `out/extension.js`·`rollout-scan.js`·`implementer-auto-pin.js`와 소스 해시, 브릿지 `codex-hook.js` 해시가 일치했다. 당시 **VS Code 사용자 세션/확장 호스트와 같은 실행 문맥**의 `codex plugin list --json`은 `codex-peek@personal` installed/enabled를, 같은 문맥의 새 app-server `hooks/list`는 해당 세 훅 trusted 3/3을 확인했다. 반면 이 플러그인의 대상이 아닌 중첩 `source=exec` 검증 세션 안에서 다시 띄운 CLI는 같은 파일을 보면서도 plugin/hooks 목록을 빈 값으로 격리해 반환하는 것을 실측했다. 구현 훅 readiness의 정본은 대상 VS Code 실행 문맥에서 확장이 직접 수행하는 `hooks/list`이며, 어느 문맥이든 조회 실패·빈 목록은 해당 문맥에서 fail-closed한다.

- **Codex 진입 자동고정·생존 판정 보완(2026-07-13)**: 프롬프트 이전에 공개적으로 받을 수 있는 `SessionStart(startup|resume)`를 네 번째 플러그인 훅으로 추가했다. 구현 역할 교체 전 해당 session id의 rollout 첫 `session_meta`를 최대 1MiB까지 읽어 `source=vscode`와 `thread_source=user`가 모두 정확히 일치할 때만 승인한다. `originator`·환경변수는 exec 검증 프로세스에도 상속될 수 있어 권위 근거로 사용하지 않는다. 이 판정은 SessionStart와 UserPromptSubmit 양쪽에 적용되므로 verifier `exec`·CLI·하위 세션이 구현 연결을 가로채지 못하며, 식별 파일을 아직 읽을 수 없으면 fail-closed한 뒤 첫 실제 사용자 프롬프트에서 재시도한다. 하네스가 새 구현 세션을 만들지는 않는다. 느린 과거 SessionStart가 더 최신 프롬프트 뒤에 완료되는 순서 역전도 막는다. 각 훅 프로세스는 workspace 탐색 전 전역 `roleRevision`을 잡고, 프로젝트별 `implementerRevision`·session snapshot과 함께 역할 잠금 안에서 CAS한다. snapshot 뒤 다른 세션이 역할을 바꾸거나 ABA로 원 세션에 돌아와도 revision이 달라 오래된 이벤트는 쓰지 않는다. 같은 목표 세션의 수명주기 이벤트만 안전하게 합류한다. rollout 보조 자동고정은 다른 세션으로 교체할 때만 두 revision을 증가시키고, 같은 세션 재관측은 관측 시각(implementerLastSeenAt)만 갱신한다(P-6b — 훅 pin은 성공했으나 그 '뒤' 같은-세션 자동 고정이 eventAt을 재전진시켜 turn-before-link 거부를 만들던 경합 제거·정본 순서=PENDING P-6b). 단순 목록 클릭이 Codex의 실제 resume을 일으키지 않는 UI 버전에서는 첫 프롬프트 rollout 보조 고정이 계속 안전망이다. 생존 판정은 더 이상 `UserPromptSubmit` 한 이벤트에만 묶지 않고 현재 턴의 서명된 `UserPromptSubmit`·`PostToolUse`·`Stop`, 또는 최신 기존 턴 뒤의 `SessionStart`를 인정한다. SessionStart보다 조금이라도 최신인 턴이 생기면 허용 오차 없이 그 턴의 실제 훅을 다시 요구한다. 후속 훅은 기존 model/effort 메타를 보존하고 `Stop`은 검증 게이트 실행 자체를 생존 신호로 기록한다. 따라서 실제 로그에서 PostToolUse가 실행됐는데 UserPromptSubmit만 0건이어서 빨강 경보가 영구 유지되던 오판을 제거하면서 rollout 보조 경로는 여전히 heartbeat를 위조하지 않는다. `hooks/list` 준비 조건은 네 훅 trusted 4/4로 상향했다. 1차 전체 `npm test`는 174.5초에 통과했고 `node install.js`로 확장·브릿지를 재설치했다. 개인 플러그인은 캐시버스터 `0.1.86+codex.20260713060243`으로 재설치했으며 실측 `hooks/list`는 기존 세 훅 trusted, 새 SessionStart만 untrusted로 정확히 분류했다. 따라서 사용자는 Codex 설정 → Hook에서 새 SessionStart 1건을 신뢰하고 `Developer: Reload Window`를 실행해야 새 진입 고정과 경고 해소를 현재 창에 적용할 수 있다. 연결 검증의 1차 감사에서 `source=exec+originator=codex_vscode` 탈취와 SessionStart 뒤 500ms 새 턴 오승인 반례를 찾아 위와 같이 봉합했으며 두 반례를 회귀 테스트에 추가했다. 봉합 후 전체 `npm test`는 176.5초에 다시 통과했다. 2차 감사에서는 느린 과거 SessionStart의 순서 역전을 찾아 revision CAS와 ABA 회귀 테스트를 추가했다.

- **CAS 후속 경합 보완**: 3차 감사에서 전역 revision 캡처보다 먼저 돌던 `maybeCleanupState()` 지연 창을 재현했다. 캡처를 cleanup 앞으로 옮겼고, 더 근본적으로 각 훅 프로세스의 `performance.timeOrigin`을 실제 이벤트 시작 순서로 함께 저장·CAS한다. 따라서 오래된 프로세스가 모듈 로딩·cleanup·workspace 탐색·rollout 판독 어느 단계에서 늦어져 최신 역할 변경 뒤에 snapshot을 잡더라도 `implementerEventAt`보다 과거이므로 쓰지 못한다. rollout 보조 고정도 실제 prompt 시각을 같은 필드에 기록하고 unlink 시 제거한다. 회귀 테스트는 늦게 잡은 snapshot 자체가 최신이어도 과거 process-start 이벤트를 거부하는 경계와 revision ABA를 함께 잠근다.
- **최종 회귀 상태(위 항목 후속)**: process-start 시각 CAS까지 보완한 최종 전체 `npm test`가 176.1초에 통과했다.
- **플러그인 훅 발견≠실행 보완(2026-07-13 실측)**: 창 리로드와 새 대화 뒤에도 초록 구현 연결은 rollout 보조 경로로만 이동했고 `codex-active`는 과거 `runtime-sync`에서 멈췄다. 같은 CWD의 app-server `hooks/list`는 개인 플러그인 네 훅을 `trusted`로 반환했지만 실제 lifecycle 실행은 0건이었다. OpenAI Codex 공개 이슈 #16430의 “플러그인 훅은 발견되지만 실행되지 않고 같은 정의를 `~/.codex/hooks.json`에 두면 실행” 재현과 일치한다. 실행 권위를 `~/.codex/hooks.json`의 네 사용자 훅으로 옮겼고, 설치 동의창이 해당 파일·백업·보존 병합을 명시한다. 신뢰 판정도 pluginId가 아니라 정확한 사용자 hooks 파일·`~/.codex-bridge/codex-hook.js` 명령만 인정한다. 향후 Codex가 플러그인 실행 버그를 고쳐도 이중 Stop/검증이 생기지 않도록 레포·개인 플러그인 번들의 `hooks/hooks.json`은 제거했다. 개인 플러그인은 `0.1.86+codex.20260713072653`으로 캐시버스터 재설치·검증했고, 실기 `hooks/list`는 플러그인 훅 0개와 사용자 훅 4개 `untrusted`를 정확히 반환했다. 사용자가 이 네 새 사용자 훅을 직접 신뢰한 뒤 창을 리로드하고 새/기존 Codex 대화에서 프롬프트를 보내 실제 heartbeat와 빨강 경보 해제를 확인해야 한다.
- **사용자 훅 경로 감사 보완(2026-07-13)**: 최초 이식의 명령 식별은 `codex-hook.js` 문자열을 포함하기만 해도 인정해 `echo`, 뒤쪽 `&&`, 앞쪽 다른 스크립트 인자를 설치·신뢰·제거 대상으로 오인할 수 있었다. 이제 허용 문법은 정확히 `node|node.exe "<실제 브릿지>/codex-hook.js"` 한 명령뿐이며 추가 인자·연산자·다른 실행기는 거부한다. 사용자 훅 설치는 `codex-hooks-installed-by-extension` JSON 소유권 표식에 실제 `hooks.json` 절대경로를 누적한다. `$CODEX_HOME`이 바뀌어도 제거 시 기록된 모든 경로에서 잔존 없음까지 확인한 뒤에만 런타임을 지우며, 표식 기록 실패는 `hooks.json` 원문을 복원한다. 다중 VS Code 창의 A/B 홈 동시 설치와 제거 경합은 같은 프로세스 간 lock으로 표식 read-modify-write부터 브릿지 삭제까지 직렬화한다. 제거 뒤 대기 중이던 설치는 런타임 부재를 확인해 훅 생성을 거부한다. 확장 활성화의 자동 제안·C-C 선택·명령 팔레트·대시보드 설치 중앙 함수 모두 `codex doctor` 홈 동기화를 기다리고, 준비 전 render는 신뢰 조회·건강 경보 생성을 건너뛴다. 완료 시 pre-ready cache를 폐기하고 실제 홈으로 강제 조회한다. 신뢰 안내는 `~/.codex`를 고정 표기하지 않고 실제 탐지 파일을 표시한다. 잠금·동시 자식 프로세스 반례는 `tests/codex-plugin-install.test.js`와 `tests/uninstall.test.js`에 추가했다.

## 2. 개발 루프 & 환경

- 루프: 수정 → `npm test`(전체 스위트 — package.json의 test 체인이 정본) → `node install.js`(빌드+확장 설치+브릿지 동기화) → **창 리로드** → Codex 검증 → 로컬 커밋(`git commit -F <메시지파일>` — PowerShell 5.1은 메시지 속 큰따옴표가 인자를 깨뜨리므로 파일 경유).
- 지뢰: 셸 인라인에 한글 경로·`\t`·`$`·따옴표를 넣지 말 것 — **스크립트는 항상 파일로 써서 실행**.
- 지뢰: `src/extension.ts`의 웹뷰 `<script>`는 바깥 템플릿 리터럴 안 — 웹뷰 JS 문자열의 개행 표기는 **백슬래시 두 겹**이어야 한다
  (한 겹이면 HTML 생성 시 실제 개행으로 변환 → 웹뷰 전체 사망 — 실사고). `tests/webview-syntax.test.js`가 산출물 기준으로 검출.
- 지뢰: DeepSeek `deepseek-v4-flash`는 **추론 모델** — 출력 상한이 작으면 생각(reasoning)에 다 쓰고 본문이 빈 채 온다.
  `bridge/deepseek-bridge.js`가 이미 대응(ping은 본문 안 물음·map은 상한 8000+오류 구분).
- DeepSeek 키: `~/.codex-bridge/deepseek.json`(레포 밖) 또는 env `DEEPSEEK_API_KEY`. 대시보드 ⚙️고급설정 탭에서 입력 가능.
- 디버깅 무기: **jsdom 재현기** — 실제 `html()` 산출물을 jsdom(runScripts)에서 실행 + 실제 `computeState` 데이터 주입
  (`npm i --no-save jsdom` 후 out/extension.js를 vscode 스텁으로 require·내부 함수 노출). 대시보드 무반응류는 이걸로 잡는다.
- 무거운 판독은 `cachedRead`(mtime+size 키) — computeState가 5초를 넘겨 확장 호스트를 포화시킨 실사고 있음. 새 판독기 추가 시 준수.

## 3. 3트랙(탐색) 아키텍처 — 현재 완성 상태

원칙: **발견은 기계가, 판단만 LLM이**(탐색자에게 구현 AI의 요약을 주면 맹점을 물려받는 가시성 역설 회피).

```
[꾸러미 빌더(결정론)] → [탐색자(분리 LLM 1회 호출·무세션)] → [영향지도] → 게시판+Claude
 scripts/scope-package.js      self 팔 | DeepSeek 팔              scouts/ 보관함
```

- **꾸러미**: `src/scope-package.ts`(순수 조립·렌더) + `scripts/scope-package.js`(수집 드라이버).
  내용 = 바뀐 파일·diff·바뀐 식별자의 역참조·함께변경 통계·테스트 목록·최근 검증 실패·(있으면) MAP + **못 보는 것 각주**.
  민감 범주 파일(diff의 .env*·secret/credential/token/apikey·pem/key/p8 등)은 `redactSensitiveDiff`가 전송 전 통째 제외+고지.
- **무이력(비-git) 모드**: git 없으면 자동 폴백 — seeds는 시간 창이 아니라 **작업 신호 계단**:
  ①물때표(마지막 지도 생성 이후 수정된 파일 — 우선) ②첫 지도면 Claude 세션이 실제 편집한 파일(대화 기록 도구 호출)
  ③최근 수정 상위 N. diff 대신 발췌, 역참조는 폴더 스캔. 간주 기준은 꾸러미 1절에 항상 표기.
- **두 팔(D5 A/B 설계)**: 같은 꾸러미·같은 지시.
  - self 팔: `node scripts/scope-scout-self.js <repo>` — `claude -p` 분리 호출(도구 전면 차단)·무추가비용.
  - DeepSeek 팔: `node scripts/scope-scout-deepseek.js <repo>` — `bridge/deepseek-bridge.js map` 경유·외부 전송.
- **보관함**: `scripts/scout-store.js` → `~/.codex-bridge/scouts/<wsKey>/`(md+json, 최근 10장).
  **wsKey = sha1(normWs(경로)) 앞 16자 — 계약 파일·확장과 반드시 동일 규칙**(한쪽만 바꾸면 게시판이 빈다).
  메타에 basis(간주 기준)·seedFiles(근거 파일 — 낡음 배지·물때표의 재료) 기록.
- **자동 지시(지시 주입형)**: `bridge/contract-lib.js buildScoutDirective` — 3트랙 프로젝트에서 지도 없음/낡음이면
  턴 시작 훅(contract-inject)이 Claude에게 갱신 지시 주입. **재지시 억제 = 상태 서명(`no-map` | `stale:<최신 지도 파일명>`) 1회**(시간 상수 0).
  동의 모델: **키 등록=DeepSeek 팔 자동 사용 동의**(PRIVACY에 명시). 확장이 직접 하는 외부 요청은 3트랙 켤 때 연결 점검 1회뿐 — 지도 꾸러미 전송은 확장·훅이 직접 수행하지 않음(2026-07-09 정정: 연결 점검 도입으로 '어떤 전송도 없음'은 더 이상 사실 아님).
- **가시화**: 대시보드 탐색 카드("지금:" 상태 요약·연결 줄·기초 탐색 통계·영향지도 게시판·낡음 배지) + 흐름 지도 둘째 줄
  (Claude→탐색자→게시판) + 히어로 탐색자 카드 + 상태바(망원경 아이콘·생성 도는 동안만 "탐색중" — scout-live 신호).
- **검증 동봉(Phase 3 — 2026-07-07 구현)**: `contract-lib.js extractMapHighlights`(지도 MD에서 ①~④ 구획의 high만 구조화 —
  제외 표기 우선·자유서식 폴백·백트래킹 없는 토큰 파서) + `buildScoutAttach`(3트랙+지도+high 있을 때만 [탐색 지도·참고] 블록,
  낡음 라벨·ko/en·advisory 명시) → `codex-bridge.js withContract`가 모든 ask에 동봉(별도 try — 실패해도 계약 주입 불침).
  러너 두 팔은 저장 시 `meta.highlights`(구조화 계층) 기록. 테스트 `tests/scout-attach.test.js`(31단언).

## 4. 사전 등록 판정 기준 (매몰비용 방지 — 바꾸려면 사용자 합의)

- 통계(함께변경) 단독은 이미 **불합격 판정 완료**: 소급 실측 hit@10 16~51% < 합격선 60% — 원인은 '사상 처음 생기는 결합'
  (원리상 예측 불가 63~74%). 그래서 중심은 LLM 지도+MAP. 통계 카드는 참고용으로만 유지.
- **(완료된 사전등록) D5 A/B 소급 실측**: 완료된 실제 변경들에 두 팔 지도를 소급 생성 → 명중·치명 누락·소음 비교.
  사전 등록 판정 규칙: **차이가 오차 수준이면 self 채택**(무료), DeepSeek 유의미 우위면 DeepSeek.
  → 아래 2026-07-07 실측으로 **종결(self 채택)** — 상세는 아래 두 단락.
- **2026-07-07 실측 결과(러너 `scripts/scope-ab-retro.js` — worktree로 부모 시점 복원+씨앗 1파일 diff만 적용, 커밋 6건·정답쌍 29)**:
  S0 통계 13.8%(커밋당 소음 3.3) / L12 결정론 꾸러미 37.9%(16.2) / **L3 self 지도 48.3%(12.8)**.
  L3는 명중 기준 6커밋 모두 L12와 같거나 우위, 전체 평균 소음은 16.2→12.8로 감소(단 커밋별로는 141b10f에서 23→25 증가).
  L3의 추가 명중은 3건 — e64109e의 package.json·tests/scout-store.test.js, 76a316e의 package.json — 모두 '새 테스트 추가에
  따른 test 체인·관련 테스트 갱신' 같은 관례형 결합(결정론이 원리상 못 잡는 유형: 씨앗이 새 파일인 신규기능 커밋에서
  S0·L12 0/12, L3 2/12). 문서 3종(PRIVACY·README·README.en)은 L3도 놓쳤다 — '문서 갱신까지 잡는다'는 근거 없음.
  표본 6커밋은 작음 — 판 뒤집기용이 아니라 방향 확인용. 씨앗 1파일 재현은 실사용(작업트리 전체가 씨앗)보다 세 레벨 모두에게
  불리한 보수적 조건. L3 텍스트 채점은 '경로 포함 또는 8자 이상 basename 포함' 규칙이라 hit/소음이 일부 부풀 수 있음.
- **2026-07-07 두 팔 비교 완료 → D5 판정: self 채택**. 키 등록 후 `--arm deepseek` 재실행. ⚠ 실행 간 새 커밋(5685a6f)이 최신 6건에
  끼어 세트가 어긋남 → 공정 비교는 **공통 5커밋·27쌍**으로: 결정론(S0 4/27·L12 11/27·소음까지)은 두 실행에서 완전 동일(재현성 확인).
  L3는 self 13/27=48.1%(소음 15.4) vs DeepSeek 10/27=37.0%(소음 9.8) — 불일치쌍 self만 맞힘 3(e64109e package.json·
  7132726 bridge/deepseek-bridge.js·141b10f tests/deepseek-config.test.js) / DeepSeek만 맞힘 0. DeepSeek 우위 없음(명중 열세·
  소음만 우위) → 사전등록 규칙("오차 수준이면 self, DeepSeek 유의미 우위면 DeepSeek")상 어느 해석이든 **self**. 두 팔은 같은
  꾸러미·같은 지시 계열이나 문장이 글자까지 동일하진 않음(도구차단 문구·온도 고정 차이 — deepseek-bridge.js 36~40행).
- 그 뒤: 지도 high 항목 구조화+검증 요청에 지도 동봉 → stable MAP(확정 지식층) 구축 → **강제 게이트는 성능 입증 후에만**.
- **2026-07-09 재실측(장부 학습 반영 — 사전등록 §6-5의 예정 재실측)**: 실측 러너의 구조 결함 발견 — worktree 서랍
  키가 본 레포와 달라 일지가 항상 빈 채 측정됨(48.1%는 '기억 없는 정찰' 점수). 러너에 본 레포 일지 주입(그 커밋
  시각 이전 이벤트만 — 시간 절단으로 순환·미래 누출 방지, attached 재적재 없음)+--no-ledger 대조 스위치 추가 후
  최신 6커밋·44쌍 A/B: **기억 없음 45.5%(소음 13.0) vs 기억 주입 70.5%(소음 11.7) — 기억 효과 +25.0%p·소음 감소,
  합격선 60% 최초 돌파**. 커밋별 최대 효과 431ff43(1/12→8/12 — 문서·다표면 결합을 일지 신뢰분이 견인). 한계(정직):
  표본 6커밋·단일 프로젝트(자기 개발 루프 — 반복 결합이 많은 지형은 기억에 유리한 조건이자 기억의 존재 이유),
  텍스트 채점 부풀 가능. **사전등록 규칙상 60% 초과 → 게이트 기본 승격 '재논의' 발동(사용자 결정 대기)**.

## 5. 파일 지도 (이 작업에서 자주 만지는 곳)

| 무엇 | 어디 |
|---|---|
| 꾸러미 순수부(조립·렌더·민감 제외·무이력 라벨) | `src/scope-package.ts` |
| 수집 드라이버(git/무이력 계단·역참조·공용 수집) | `scripts/scope-package.js` |
| 두 팔 러너 | `scripts/scope-scout-self.js` · `scope-scout-deepseek.js` |
| 지도 보관함·생성중 신호 | `scripts/scout-store.js` |
| DeepSeek 호출(ping/map) | `bridge/deepseek-bridge.js` |
| 자동 지시·계약·검증 지시 | `bridge/contract-lib.js` · `contract-inject.js` |
| 대시보드·상태바·게시판·판독 캐시 | `src/extension.ts` |
| 통계 채굴기(참고 카드) | `src/scope-ledger.ts` |
| 테스트(전 스위트 체인) | `package.json`의 `test` + `tests/*.test.js` |

## 6. 이어서 할 일 (우선순위)

1. ~~D5 A/B 소급 실측~~ — **완료·판정 확정: self 채택**(§4 두 팔 비교 참조). 러너 `scripts/scope-ab-retro.js`·불변식 `tests/ab-retro.test.js`.
2. ~~Phase 3(지도 high 구조화 + 검증 동봉)~~ — **구현+로컬 런타임 반영 완료 2026-07-07**(§3 '검증 동봉' 참조 · install.js로
   ~/.codex-bridge 반영, 배포 사본 해시 일치·실동작 확인). 대외 배포는 사용자 승인 시. 효과 관찰 시작(검증이 지도 경로를 실제
   지적하는 빈도). 알려진 소음: 파서가 'ko/en' 같은 슬래시 표기를 경로로 오인할 수 있음(advisory라 무해 — 관찰 항목).
3. **(진행 중) stable MAP 2층** — 1차 단위 구현 완료 2026-07-07: `extractMapPatches`(⑥ 제안 파서) → 러너가 meta.mapPatches로
   제안층 저장 → `scripts/scope-reconcile.js`(list/approve/reject — approve만이 확정층 MAP.md 승격 경로, 승인/기각 서명은
   브릿지 홈 map-reconcile/). 확정층(docs/MAP.md)은 꾸러미 collectCommon이 이미 신뢰 입력으로 읽음. 테스트
   `tests/map-reconcile.test.js`(25단언). **대시보드 'MAP 장부' 카드 완료 2026-07-07**: 대기·승인·기각 카운터 칩 +
   대기 제안 목록(출처 표기)과 [승인]/[기각] 버튼(모달 동의, sig 기준이라 번호 밀림 원천 차단) + 승인/기각 이력 +
   확정 장부 열람. 계산·형식은 `src/map-ledger.ts` 공유 모듈이 단일 출처(CLI `scope-reconcile.js`도 out/map-ledger.js
   require — 형식 두 벌 금지). **남은 것**: 실사용 제안 축적 후 첫 승인 사이클 관찰.
   **방향 전환 합의 2026-07-07(사용자+양 모델)**: 건별 수동 승인은 실사용 불가 판정 — memento(assertionStatus 4단계·재통합)+
   tg-chat-engine(삭제 금지·disputed 상태 전이·supersedes·learning_events '이벤트 먼저 정책 나중') 패턴으로 **자동 관측 장부**로 전환.
   3층: ①관측 장부(자동) ②오버라이드(pin/ban) ③docs/MAP.md(명시 내보내기만). 로드맵: ①이벤트 적재→②약한 전이→③꾸러미
   신뢰 차선→④발화 기반 강등(보수적)→⑤카드 역할 전환→⑥플랜 게이트 실험(PreToolUse:ExitPlanMode 가능 여부 실험 선행 —
   미확정. 강제 게이트 기본 off: 사전등록 60% vs 당시 실측 48.1% 미달, 사용자 명시 선택만 — **2026-07-09 재실측 70.5%로 재논의 발동 → 같은 날 사용자 승인으로 3트랙 기본 승격 확정**(신뢰도 카드와 한 묶음 조건 — 아래 ⑥·§6 4-5)).
   **①②③ 구현 2026-07-07**: `src/ledger-events.ts`(이벤트 파싱·약한 전이 derive — banned>superseded>tombstone>disputed>
   verified>inferred, pinned은 차선 오버라이드·꾸러미 선별 selectForPackage 씨앗 교집합 우선)+`contract-lib.js`
   appendLedgerEvent(map-ledger-events/<wsKey>.jsonl·상한 2000 정직 고지)+러너 proposed 적재+`scope-package.js`
   ledgerForPackage(동봉分 attached 적재 — 자기강화 차단 재료)+렌더 §7.5(확인됨/미검증/틀림판명 3차선).
   **④ 구현 2026-07-07**: (a) `codex-bridge.js flagLedgerConfirms` — 통과류 판정 + 장부 항목의 서로 다른 경로 2개 이상이
   '실존 확인된 인용'(citedResolvedBasenames)에 등장 + 다룬 흔적 미확인(unseen) 목록에 없음 + basename 8자 이상일 때만
   confirmed 적재(텍스트 메아리 무효 — 자기강화 차단). 제외는 '현재 차단 중'(ban 순계산)·대체·소멸만 — 반박 이력
   항목에도 확인은 기록되고(복권 재료), 승격은 derive의 복권 규칙(반박 이후 사람 1회/검증 2회 — §6-5)이 판정
   (2026-07-09 개정). refuted 자동 추출은 안 함(기계 판정
   불안정 — 정직 한계). (b) `scripts/scope-ledger-note.js` — 사용자 발화 기록 CLI(dispute/confirm/pin/ban/unpin/unban,
   유일 매칭만·모호하면 중단). **Claude 사용 관행**: 사용자가 장부 지식을 확정 어조로 정정/확인하는 발화를 하면 이 CLI로
   기록하라(--why에 발화 요지). 흔들림("맞나? 헷갈리네")·농담·가정법은 기록 금지(tg wavering-hold). 테스트
   `tests/ledger-signals.test.js`(18단언 — 패리티·보수 규칙·CLI).
   **⑤ 구현 2026-07-07(카드 역할 전환)**: 대시보드 MAP 장부 카드를 승인 큐→관측 패널로 — 관측 장부(이벤트→유도)가 1차
   재료(extension이 out/ledger-events.js 직접 import), 신분 칩(신뢰/미검증/틀림판명/제외)+항목별 신분 배지·사건 요약
   (제안·동봉·확인·반박 횟수)+최근 사건 타임라인+확정 장부 열람. 개입은 선택: 고정/해제/차단해제=즉시(가역),
   차단·내보내기=모달 동의(내보내기는 신뢰 차선만·중복 방지·exported 이벤트 기록). 이벤트 적재는 배포 런타임
   bridgeLib().appendLedgerEvent 재사용(낡은 런타임이면 정직 에러 — install.js 안내). 승인/기각 핸들러 제거.
   `scope-reconcile.js` CLI는 번호 기반 대안 경로로 존치(테스트 유지).
   **⑥ 구현 2026-07-07(플랜 게이트 — 실험 장치)**: 공식 문서 확인 결과 차단(exit 2=stderr 피드백)·페이로드는 명시,
   **ExitPlanMode가 PreToolUse에 잡히는지는 미명시**(전용 훅 요청 이슈 존재) → 관측 실험으로 판정.
   (a) `bridge/scout-gate.js` — PreToolUse:ExitPlanMode 훅: 항상 관측 로그(도구명·입력 키 이름만 — 플랜 본문 저장 안 함,
   scout-gate-log/), 게이트는 실효 scoutGate="plan"일 때만(**2026-07-09 기본 승격**: normScoutGate — scoutMode≠on이면 무조건 off[2트랙 무회귀·명시 plan 잔재도 비활성], 3트랙 명시값 존중, 3트랙 미설정=plan. 근거: 재실측 70.5%>60% + 차단 문구에 프로젝트별 관찰 신호 동반[scoutHealthLine — §6 4-5]), 지도 없음/낡음이면
   차단+생성 지시, **세션당 2회 상한 후 통과**(무한 잠금 방지), 모든 오류 fail-open. (b) `scripts/scope-gate.js` on|off|status
   (~~ko·en 슬롯 동시~~ 2026-07-09부터 현재 언어 슬롯만 — §6-9). ⚠ **게이트 설정의 앵커 주의**(2026-07-09 실사고 —
   검증모델도 혼동): 계약은 폴더별이라 '연 폴더'(Claude 세션 폴더) 계약이 적용된다 — 부모 폴더를 열고 작업하면
   부모 계약(plan/on·scoutRepo=하위 레포)이 게이트를 지배하고, 하위 레포를 직접 워크스페이스로 열면 그 폴더의
   별도 계약이 적용된다(승격 후: 그 폴더가 3트랙이면 게이트도 기본 켜짐, 2트랙이면 비활성). 다른 PC에서 게이트 관찰을 이어가려면 '실제로 여는 폴더' 기준으로 3트랙 계약·scoutRepo를 확인하라 — scope-gate on은 이제 불요(3트랙 기본 plan), 끄기만 CLI. (c) 훅 4개 체계: 같은 이벤트 다중 훅에서 병합이 앞 훅을 지우던 함정 발견 →
   mergeHooks/installHooks를 **이벤트 단위 정리**로 재구조화(install.js·hook-setup.ts 동일 수정·회귀 테스트 잠금),
   isOurHookCmd·BRIDGE_SCRIPTS(7개)·훅 문구(4개) 갱신. (d) 확장 saveContract가 미지 필드(scoutGate)를 보존 병합하도록
   수정(대시보드 저장이 게이트 설정을 지우던 문제). 테스트 `tests/scout-gate.test.js`(22단언).
   **실험 절차(다음 사람/세션)**: ① `node install.js`(훅 4개 등록) 후 **새 Claude Code 세션** ② 플랜 모드 진입→플랜 확정 시도
   ③ 브릿지 홈 `scout-gate-log/<wsKey>.jsonl`에 tool:"ExitPlanMode" 줄이 찍혔는지 확인 — **찍힘=가로채기 가능 확정**(게이트
   게이트 관찰 계속[승격 후엔 3트랙 기본 켜짐이라 별도 on 불요]), 안 찍힘=PreToolUse가 ExitPlanMode를 안 잡는 것(전용 훅 이슈 추적·Stop 게이트 대안 검토).
   **판정(2026-07-08, 자연 데이터): 찍힘 — 가로채기 가능 확정.** 실세션의 플랜 확정 2건(2026-07-07T19:44:44Z ·
   2026-07-07T21:10:30Z)이 `scout-gate-log/fff249c3aaa6cbb3.jsonl`에 기록됨(사용자가 거부한 ExitPlanMode도 훅이
   먼저 돌아 기록 — PreToolUse 확정). ~~다음은 원하는 프로젝트에서 `scope-gate.js on` 게이트 실험~~ → **2026-07-09
   기본 승격으로 절차 종결**: 3트랙 프로젝트는 이제 `on` 없이도 게이트가 기본 동작(끄기만 CLI — §6 4-5 후속 묶음).
4. **(완료 2026-07-08) 플랜 게이트 실세션 실험** — 위 ⑥ 판정 참조(찍힘 확정). 남은 것: 기본 켜짐 상태의
   차단·문구 실사용 관찰(레거시 지도면 '판정 불가·재생성 필요' 문구가 나가는지 — 아래 4-1의 legacy 상태 참조).
4-1. **(완료 2026-07-08) 장부 점화 — '이벤트 0건' 구조 공백 진단·해소**. 진단(실측): 씨앗(proposed)의 유일한 자동
   입구가 '지도 러너 실행'인데 러너가 안 돌고, 자동 지시는 같은 낡음 상태에 1회 후 영구 침묵, 실개발 레포(codex-peek)는
   3트랙 계약조차 없어 대상 밖, confirmed 자동 적재는 장부가 비면 즉시 return(공회전) → 이벤트 0건. 조치 4종:
   (a) **파서 위생**(contract-lib extractMapPatches 내부 — 러너·백필 공용 단일 기준): 경로 토큰 ≥1+최소 길이,
   'yaml'·설명 부스러기 탈락 (b) **legacy-no-seeds 상태 신설**(scoutMapStatus): seedFiles 기록 없는 구버전 지도를
   fresh로 오판하던 것 분리 — 자동 지시·플랜 게이트 모두 '판정 불가·재생성 권고' 정직 문구 (c) **버킷 재알림**
   (buildScoutDirective): 같은 지도라도 낡음 정도가 2의 거듭제곱(1,2,4,8…) 상승 시 재지시(하강·동일은 침묵,
   시간 상수 0, 구형 {sig} 기억은 maxBucket=1로 해석) (d) **씨앗 백필 CLI**(scripts/scope-ledger-backfill.js,
   수동 1회·멱등·--dry): 기존 지도의 ⑥ 후보 소급 적재 — 라이브 29건 점화(codex-peek 13·에이전트활용 16,
   deriveLedger 유도 정상). +codex-peek에 3트랙 계약 생성(ko·en 양 슬롯 — en 전환 시 유실 방지).
   ⚠입구 전수(정정): proposed=러너·백필 / attached=꾸러미 빌더 / confirmed=검증 통과 자동(장부 비면 불가) /
   pinned·banned·unpinned·unbanned·exported=**대시보드 개입 경로도 있음**(extension.ts ledgerAct) / user_dispute=발화 CLI.
   ⚠남은 배치 한계였던 세션 cwd≠개발 레포 문제는 → **4-3에서 결정·구현(scoutRepo)로 종결**(2026-07-08).
4-2. **(방향 확정 2026-07-08) Reconciler(정리자 — 통합·분할·확대·축소·폐기)는 점화·축적 '뒤'.** 외부 대화
   제안(하네스 후보화→LLM 정리 제안→검증→이벤트 적재)은 타당하나 '다음 실험 전에 먼저'는 기각 — 전제(축적 잡음)가
   실측(0건)과 어긋났음. R0(조작 표현)는 새 이벤트 타입 신설 없이 기존 조합(선택 A: 새 문장 proposed + 옛 문장
   superseded / retire=tombstone / ban=banned)으로 표현 가능 — split만 향후 newSigs[] 검토. R1+(후보 생성기·
   LLM 제안·scope-curate CLI)는 장부에 실데이터가 쌓인 뒤 착수.
4-3. **(결정·구현 2026-07-08 — P1)** 세션 cwd≠개발 레포 문제 종결: 계약에 **scoutRepo(정찰 대상) 명시 필드**.
   결정 근거(사용자 승인+검증 합의): 관행 의존은 재발 위험, 전면 ws 재해석은 앵커 재설계 — 절충으로 **정찰 계열만**
   (지도·꾸러미 대상·변경감지 통계·관찰 일지·confirmed·플랜 게이트·자동지시 경로) 대상을 따르고 검증·연결·계약 앵커는 불변.
   구현: contract-lib `resolveScoutRepo`(절대경로·존재 검증·무효 시 ws 폴백 ws-fallback-invalid) + buildScoutDirective/
   buildScoutAttach/scoutMapStatus 호출부·codex-bridge flagLedgerConfirms(장부 기록 대상만 — 인용 해석은 execCwd 유지)·
   scout-gate(신선도·지시 명령=대상, 관측 로그에 ws·target 병기)·extension 정찰 판독기 전부(scoutTargetFor — 3카피 패리티
   테스트 잠금)+카드에 대상 고지. CLI: `scripts/scope-target.js`(status/set/auto[직하위 1단계 유일 git 루트만 자동·복수는
   나열]/clear — ~~ko·en 슬롯 동시~~ **2026-07-09 개정: 현재 언어 슬롯만 저장**(§6-9)) · `scripts/scope-ledger-migrate.js`(서랍 이관 — dry 선행·복사 보존·ts+type+sig 중복
   스킵=멱등). 테스트 `tests/scout-target.test.js`(28단언 — 상대경로 무효·빈 .git 오판·기존 지정 잔존 반례 잠금 포함).
   **(구조 보강 2026-07-10 — 어긋남 '자기진단')** 실사고: scoutRepo는 '아는 사용자의 수동 설정' 전제라, 미설정이면
   정찰 축 전체가 조용히 세션 폴더를 봐 다른 환경 사용자가 그대로 재발(이 PC에서 실증 — 일지 정체·동봉 문구 동일).
   사용자 제약(임시처방·고지-only 금지)에 따라 구조 부품 5종: ①증거 수집 collectScoutTargetEvidence(codex-bridge —
   매 ask, 실존 인용 파일의 git root 귀속을 scout-target-evidence/<wsKey>.json 링버퍼 10건에, 판정 무관·3트랙만·
   execCwd 기준[세션 폴더 기준이면 어긋난 상황에서 증거가 빈 값 — Codex 반례]) ②보수 판정 detectScoutTargetDrift
   (관측≥3·같은 레포 최다 인용 ≥70%·실존·대상과 다름 — 표본 미달 무주장) ③자동 지시가 '신선도보다 우선'(Codex
   반례: 엉뚱한 대상의 지도가 fresh면 조기 반환에 막혀 영영 침묵) — scope-target.js set 문법으로 에이전트가 스스로
   교정(같은 제안 1회 — 기억은 advisedKeys[언어|대상|제안 키·상한 20, 구형 advisedRepo는 쓰기 시 정리]·언어 슬롯 효과 명시) ④대시보드: 대상 '상시' 표시(미지정 침묵 해소)+어긋남
   행동 카드(원클릭 setScoutTarget — saveContract 스키마 오염 없이 전용 병합)+3트랙 켜는 순간 대상 확인 스텝(비-git
   ws) ⑤신선도 사각 해소: scoutMapStatus가 seed 8개에 더해 meta.head 이후 새 커밋 수+seed 밖 dirty mtime을 stale
   신호로(신호 3종 분리 표기 seedChanged/commitsAfter/dirtyChanged·비-git 무회귀·러너가 메타에 head 기록). 게이트
   차단문도 drift 시 '대상 지정 먼저'(엉뚱한 레포 지도 생성 안내 금지). 테스트 tests/scout-drift.test.js. 남는 침묵
   경로(정직): 인용이 아예 없는 검증·(path:line) 형식 밖 인용은 증거가 안 쌓임 — 관측되면 파서 폭 확장 후보.
4-4. **(후속 문서 정리)** README ko 본문 일부에 '함께-변경 통계·커밋 이력' 등 옛 표현 잔존(동작 오도 아님 —
   Codex 확인). UI는 '정찰 흐름' 사람 언어로 전거 완료(옛 용어 잔재는 테스트 부정 단언으로 잠김) — 문서만 후속.
4-5. **(방향 확정·v1 구현 2026-07-09) Scout Health — 전역 임계값을 프로젝트별 관찰 신호로 대체.** 사용자 결정:
   "임계값은 프로젝트 구조별로 의미가 달라 고정 불가 — 헬스 신호로 프로젝트 성향에 적응". **v1은 advisory 전용 —
   자동 강제·게이트 기본값 변경 0(승격 결정은 여전히 사용자 몫이며, 이 신호가 그 전제 장치).** 구현: 정본
   `src/ledger-events.ts computeScoutHealth`(entry 단위 — 이벤트 반복 과대 반영 차단)+배포 미니 사본
   `contract-lib.js computeScoutHealthMini`(패리티 테스트 잠금)+`scoutHealthLine`(buildScoutAttach 꼬리에 1~2줄 —
   표본<5면 비율 숨김·'근거 부족' 1줄, 용어 잠금: '정확도' 금지·'재사용 항목 중 확인 이력'[attached=재동봉
   사건이지 열람 인과가 아니고 이벤트 선후도 안 보므로 '후'를 주장하지 않음]·반박은 '수동 기록 기준')+대시보드
   관찰 일지 카드 1줄. 테스트 `tests/scout-health.test.js`(정본↔사본 패리티·미지 타입·용어 잠금 포함).
   **후속 묶음 구현 완료 2026-07-09(사용자 일괄 승인 — "신뢰도 카드+헬스 실시간+게이트 기본 승격+통합뷰")**:
   (a) 게이트 기본 승격 — normScoutGate 조건부 기본값(scoutMode≠on→무조건 off[2트랙 무회귀·명시 plan 잔재도
   비활성 — Codex 사전검증이 잡은 결함]·3트랙 명시값 존중·3트랙 미설정→plan). normalize 층 기본값이라 계약 파일에
   안 쓴다(명시화 오염 방지 — 확장도 Contract 스키마에 안 넣고 effectiveScoutGate 표시 전용, saveContract는 보존
   병합만). (b) 차단 문구에 scoutHealthLine(target) 인용(별도 try — 신호 실패가 차단 문구를 못 막음) — '카드와 한
   묶음' 조건 충족점. (c) informed consent: 대시보드 영향지도 섹션 게이트 상태 1줄(기본/직접 설정/직접 끄심 구분)+
   scope-gate status 실효/저장값 구분+README ko/en·PRIVACY 갱신. (d) 건강 리포트 새탭 openScoutHealthReport(포화
   대응 — enableScripts:false·default-src 'none'·열 때 readMapLedgerUncached 베이크·동적 데이터 esc() 전면) — 수치
   색 카드+게이트 상태+최근 사건 12건+한계 고지, 관찰 일지 카드에 버튼. '헬스 실시간'의 실체는 소비 지점 4곳(ask
   동봉·차단 문구·대시보드 줄·리포트 탭)이 호출 시마다 장부에서 재계산(데몬·자동 강제 없음).
   잔여(다음 묶음): Reconciler advisory R0~R2(후보 생성기+LLM 제안 큐+확인 후
   적재 — 장부가 점화됐으므로 '축적 뒤' 유보는 해제, 단 자동 적용은 계속 금지).
5. **(관찰) 관측 장부 실데이터 축적** — confirmed/user_dispute가 쌓이면: DERIVE_V1 임계(현재 최약 1회) 데이터 기반
   조정 + 장부 학습 반영 후 지도 명중률 재실측(ab-retro) → 60% 넘으면 게이트 기본 승격 재논의(사전등록 §4). **→ 2026-07-09 재실측 완료(§4 말미): 기억 주입 70.5%로 60% 최초 돌파 — 재논의 발동 → 같은 날 사용자 승인으로 3트랙 기본 승격 확정(§6 4-5 후속 묶음).**
   **복권·수명 4약점(2026-07-09 사용자 질문으로 확정 → 같은 날 사용자 방향 지시 "지식은 진화해야"로 (a)(b)(d)
   즉시 구현 완료 — 커밋 참조)**:
   (a) ~~confirmed 기록 차단~~ **해소**: dead-set에서 반박(user_dispute/refuted) 제외 — 반박 이력 항목에도 확인이
   '기록'되고, 승격은 유도기 복권 규칙이 판정(차단 ban·대체·소멸은 여전히 기록 제외 — 사람 오버라이드 존중).
   **복권 규칙(DERIVE_V1)**: 마지막 반박 '이후'의 확인만 인정(이전 확인은 이미 반박에게 진 증거 — 이벤트 순서
   기준) — 사람 재확인 1회(사람 반박과 동급) 또는 검증 확인 2회(기계는 한 단계 약함) → verified 복권 +
   rehabilitated 표기(반박 이력은 counts에 그대로 — 삭제 금지 유지). 재반박 시 카운터 리셋(마지막 판정이 이김).
   (b) ~~트림 부활~~ **해소**: 트림이 판정 이벤트(반박·차단·고정·대체·소멸류)를 보존하고 나머지만 최신순 유지.
   (d) ~~각주 전면 금지~~ **해소**: "같은 결론을 다시 내지 마라" → "근거 없는 재주장 금지 — 다시 제안하려면 반박
   이후 무엇이 바뀌었는지(코드 변경·새 근거)를 명시하라"(재발견 봉쇄 해제·재실수 방지 유지).
   (c) **잔존**: tombstone은 스키마·UI 라벨만 있고 쓰는 곳 없음(파일 소멸 자동 감지 미배선) — P3 임계 튜닝 때.
   잠금: ledger-events [2-1] 복권 6단언 · ledger-signals [3] 기록 정책·[4-1] 트림 보존.
   **(같은 날 추가 부품 2 — 2026-07-10)** ①**같은 요청 중복 전송 차단**(실사고 실측[Codex 시간순 검증 2026-07-10]: 첫 호출이 3분29초 만에
   원인미상 비정상 종료[exit 1 — 10분 도구 상한 아님]하자 구현모델이 원인 확인 없이 재전송 → 동일 요청 중복 실행
   [rollout 같은 해시 2건]. 당시 '검증 대기시간 20분 저장'은 재전송 이후[19:44:37Z>19:42:48Z]라 이 사고의 원인이
   아니며, 대기시간>도구 창 불일치는 '이후 요청'의 잠재 위험): asks-inflight/<wsKey>-<지문>.json(해시·시각·pid·소유
   토큰), wx 원자 선점 claimAskInflight → 살아있는 동일 요청이면 exit 3 거부("rollout/대시보드에서 읽어라" 행동
   지시·--force-resend 탈출구) → 죽은 표식은 reclaimAskInflight(.reclaim 잠금[pid·token 기록] 아래 재판독 — 관측했던 죽은 레코드
   그대로일 때만 회수: 늦은 회수자가 승자의 새 표식을 지우던 TOCTOU 차단·표식 판독 실패는 비ENOENT면
   unreadable로 중단[fail-closed]·잔존 잠금은 자동 강제 해제 없음[동시 강제 해제가 이중 진입을 만드는
   재귀 TOCTOU — 보수 차단, 탈출구는 --force-resend(잠금 미경유)·수동 삭제]·해제는 자기 토큰만),
   표식 해제는 pid+token 일치만·TTL 90분(검증 대기 60분보다 큼·pid 생존이 1차), 청소는 .json만+판독불가는
   mtime>TTL만. ②**신선도 기준 시점 계약**: 기준선(basisTs·seedMissing)은 수집기(scope-package
   captureSeedBaseline)가 seed '확정 직후'(diff/grep/log 수집 전) 캡처해 pkg.meta로 — 러너는 전달만(사후
   재조사는 수집~응답 사이 삭제/복원 오분류·Codex 반례). '없음'은 ENOENT만(접근 오류=seedMissing만 생략·basisTs는 항상 유지 — 삭제 판정만 불가),
   scoutMapStatus·확장 배지는 mtime 비교를 basisTs||ts 기준으로. 잠금: tests/scout-drift.test.js [7][8][9].
   **(2026-07-12 검증 폭격 실사고·수정)**: 대시보드 verifyTimeoutMin=20분은 브릿지의 resume/new-session 내부에
   정상 적용돼 있었으나 구현 에이전트가 외부 실행 래퍼에 10분을 별도로 걸어 먼저 timeout → 실제 검증은 계속되어
   10분44초에 답을 냈는데도 실패로 오판했다. 동시에 즉시연결 판독기가 session_meta 첫 줄을 8KB 고정으로 잘라
   (현 Codex 첫 줄은 base_instructions 포함 수십KB) JSON 파싱이 항상 실패해 답 완료 전까지 링크가 없었고,
   문구를 바꾼 두 번째 --force-new가 요청 지문별 가드를 우회해 별도 세션을 만들었다. 수정: ①첫 JSON 줄을
   줄바꿈까지 chunk 판독(1MiB 안전 상한) ②ask-active/<wsKey>.json으로 ws 전체 정확히 1개 직렬화(hash가 달라도·
   --force-resend여도 차단) ③새 세션 childPid+발견 sessionId 즉시 영속, 부모가 죽어도 자식 생존 차단 ④둘 다
   죽은 비정상 잔재는 자동 재전송하지 않고 대시보드 확인 후 `ask-active clear --confirm`만 ⑤`timeout` 명령이
   대시보드 설정과 같은 minimumCallerTimeoutMs를 반환. 잠금: tests/ask-active.test.js·immediate-link(첫 줄>8KB)·verify-timeout.
   **(2026-07-10 양측 독립 전수 감사 — 사용자 지시로 구현모델 5감사단+Codex 독립 감사 교차 대조. 수정 완료분)**:
   ①검증 카드 11시간 동결 — sessionModelMeta의 turn cwd 필터가 '검증이 돈 폴더≠세션 폴더'에서 전멸하던 것 →
   verdicts.jsonl(브릿지 ws 귀속·model·effort) 최대-ts 병용 보정(한 곳 수정 — brainActual·drift·현재값 공유,
   cwd 무필터 완화는 공유 세션 3쌍 누수라 금지) ②리로드 낡은 대시보드 — 복원 '입양' 폐기(dispose→같은 자리
   새 생성)+ready 핸드셰이크+postedAt '마지막 갱신' 상시 표시+45초 끊김 배지+로딩 표지+정적 새탭 serializer
   (가이드=재베이크·건강 리포트=닫기만[원 ws 저장 불가]) ③탐색자 카드 시각 — scout-usage 방식별 lastTs+카드
   슬롯 ④'신뢰 0' — 서랍 전환 고지(prevDrawer·실인수 이관 명령·오염 경고)+캐시 키에 실효 대상 ⑤PRIVACY/README
   ko·en — 기본 정찰의 Claude CLI 경유 전달 명시(키 없음=전송 0 단정 정정)+무이력 발췌(8개·4,000자) 고지
   ⑥advisedKeys(언어|대상|제안 키잉·상한 20 — 언어 전환 영구 침묵 반례). 잠금: tests/dashboard-freshness.test.js.
   **P1-① 완료(2026-07-10 커밋 참조)** — rollout 대용량 반복 파싱: src/rollout-scan.ts 신설(vscode-free 증분
   판독 — 파일별 {offset·carry(원시 바이트)·anchor 머리 256B·offset 직전 경계 지문 64B·mtime} 상태로 자란
   부분만 병합. append-only가 '정식 전제'이고 정체성 검사는 best-effort(증명 아님 — 표본 지문은 prefix 전체
   동일성을 증명 못 함: 머리·경계 표본을 둘 다 보존한 중간 본문 재작성은 원리상 불가시[Codex 반례 왕복 2회로
   주장 하향]): 축소=size / 같은 크기 재작성=mtime / 커진 재작성=anchor+경계 지문. EOF의 줄바꿈 없는 완결
   JSON은 구식 파서 동등하게 소비).
   대화+모델 메타는 '통합 누적기 한 스캔'(소비자별 tail은 같은 파일 이중 전량 판독 — Codex 실측 190MB
   904+877ms → 963ms 1회), byCwd로 어떤 ws 질의도 추가 스캔 없음. 대화 보존은 '완전한 사용자 턴' 경계 상한
   TURN_CAP=200(메시지 개수 절삭은 recentTurns 계약 파괴 — 라이브 400메시지=57턴+user:null 합성 턴 반례.
   recentTurns는 UI maximum+코드 clamp 이중 잠금. 하드 상한 HARD_MSG_CAP=4000도 턴 단위 제거+단일 거대
   턴은 내부 assistant 절삭 — 원시 개수 절삭은 userTurns 비동기화로 합성 턴 재발[Codex 반례]). 스니펫=머리
   512KB→8MB→firstUser 폴백(절삭 무관 보존 필드 — readMessages 폴백은 절삭된 시야라 금지)+찾은 값 영구 메모.
   라이브 실측: 181MB 첫 구축 963ms 1회 후 0.01ms/호출·상위 3파일 구식 동치(꼬리·메타) 확인+Codex 무작위
   200열 퍼징 위반 0. 잠금: tests/rollout-scan.test.js(47단언). **정직한 잔여 한계**: 첫 구축(활성화 직후
   1회)은 여전히 동기 ~1s(catchUp의 64MB 조각은 메모리 상한이지 시간 분할 아님 — 구식은 상태 계산마다 이
   비용이었으므로 순감소), 절삭은 두 원인(200턴 초과·assistant 다량 턴의 HARD_MSG_CAP=4000 — 후자는 200턴
   미만에서도 발생[Codex 실측 160턴×25→153턴]) — 설정 문구를 '최대 N턴'으로 정정하고 고지 표지 2종 분리
   (turnsDropped=턴 통째 제거→요청 창 미달 시 고지 / firstTurnInnerDropped=선두 턴 내부 답변 생략→그 턴이
   화면에 있는 동안 별도 문구 고지·턴이 밀려나면 리셋 — 단일 표지는 원인 오표기·창 찼을 때 침묵[Codex 반례
   1턴+assistant 4,050]. 조용한 축소 금지).
   **P1-②③④ 완료(2026-07-10 커밋 참조)**: ②integrity 잠금(토큰 소유권·stale 자동 삭제 없음 —
   '정상 경합 유실 방지'로 주장 한정, 완전 해결 아님) ③recentFailures 소유 ws 역추적(+scope-target set이
   workspace 기록·INTEGRITY_FILE 경로 교정) ④scoutRepo 반대 슬롯 상속(현재 슬롯 명시값 우선·표면 4곳 상속
   표기·clear 시 상속 재개 고지). P2=phase.json 전역 단일(다중 창
   덮어씀·README 격리 과장)·confirmed 폴백 오염(기록만 생략)·otherSlotHasRules 거짓 문구·legacy 지도 확장/브릿지
   서사 갈림·이관 원클릭(dry 모달). P3=scout-usage trim race·links CAS 잔여·verify-guard -z 백포트·기존 3태그
   > 경계·inflight 청소 pid 검사.
   **(2026-07-10 3트랙 '논리 성립' 전용 점검 — 사용자 지시: 구조·알고리즘의 논리 분석. Codex 독립 점검 15건+
   구현모델 독립 2건 교차. 총평: 현 상태는 '자율 수렴 폐루프'가 아니라 '사람 정리를 전제로 한 관측 체계' —
   자동 긍정·수동 부정 비대칭+문구 정체성 분열로 방치 시 자주 인용되는 문구 쪽 편향.)** 즉시 수정 5(커밋 참조):
   ⑥위생(조각 차단 — 경로 2개 또는 결합 표기[↔/→] 요구+경로:라인 추출 동형. ⚠결합 표기만 있는 항목은 자동 확인 불가로 분모 왜곡 잔존 — L1)·선별 자기고정 해소(attached는 lastTs 미갱신)·한계 문구 '보수 단방향'
   주장 제거(편향 양방향: 자동 반박 없음=반박 과소·동봉 노출=확인 과대)·'스스로 좁혀짐' 과장 제거(관측치 명시).
   **논리 백로그 L1 — 완료(2026-07-10 커밋 참조 · 설계 사전검증 1회 실패 후 Codex 대안 채택)**:
   ⓐ claim-provenance: confirmed 이벤트에 증거 등급(grade claimed[답의 '결합확인 #id' 명시 표기 — 동봉된
   후보 id만 인정·태생적 echoed]/co-cited[공동 인용]/부재=legacy)·echoed(동봉 '한 항목'이 그 쌍을 노출 —
   전역 합집합 판정은 과도라 폐기)·askId(ask 실행 UUID — '독립 턴' 주장 아님)·seen(이번 턴 취급 흔적 삼상태)
   기록. 승격 규칙 DERIVE_V2: 사람 확인 1회 / 승격 가능 기계 확인(claimed 또는 비-echoed co-cited·seen=ok)
   서로 다른 askId 2회 / legacy는 서로 다른 시각 2회. seen=unknown·echoed co-cited는 기록만. unseen 검사는
   {checked, unseen} 삼상태+rollout '마지막 사용자 메시지 이후'(턴 한정 — 세션 전체 인정 결함 봉합).
   v1 확인 1건 승격은 폐기 — 기존 verified의 재해석 강등은 reinterpreted 표기+헬스/동봉 줄 고지(조용한 강등
   금지). autoEligible(확인기와 동형: 고유 8자+ basename 2개)로 기계 지표 분모 분리(autoDen/autoNum).
   검증 ask에 '결합 확인 요청' 동봉(후보 3·id — PRIVACY 고지). ⓑ sig 별칭: 자동 canonical 병합 폐기(endpoint+
   방향만으로 합치면 '읽기 vs 삭제' 진릿값 혼합 — Codex) → computeAliasCandidates(같은 endpoint+방향의 다른
   문구)가 후보 '제시'만, 병합은 사람 승인 alias/unalias 이벤트(scope-reconcile aliases/alias-approve/
   alias-dismiss·트리머 우선 보존·체인 10홉·우세 부모). raw 소비자(확인기·트리머·이관 CLI) 무변경이라
   마이그레이션 함정 없음. ⓒ 제어 안전성: scoutMapStatus가 공유 정본으로 확장 — invalid(md 형식 불명이고
   메타 저장 계층도 빈 지도 — 게이트 차단·동봉 거부)·unknown(비-git 유계 스캔[1500항목·깊이6·조기종료]이
   전수 확인 못 하고 신호 0 — fresh 사칭 금지·게이트는 기록 후 통과)·historyLost(cat-file -e로 기준 커밋
   존재 검사 — rev-list 실패 삼킴 폐기·무이력 0000000 제외)·seed 내용 지문(전체 sha1·2MB 예산·전후 stat
   안정성 — 부분 해시 금지)·재지시 버킷 성분별(합산 이질 단위 폐기·구형 기억은 1회 재알림). 확장 배지
   computeScoutMapStale 동형 갱신. 장부 동시 쓰기 잠금(<키>.jsonl.lock — appendLedgerEvent의 append→트림→교체 전체 임계·규율은 P1-② integrity 잠금과 동일[withFileLock 일반화]·'정상 경합 유실 방지'로 한정[죽은 pid=즉시 degraded]). 잠금: tests/l1-provenance.test.js(60)+ledger-events(62)·ledger-signals(45)·
   scout-gate([3c] invalid)·evidence-unseen(삼상태·턴 한정) 현행화.
   **L1 정직한 잔여 한계**: claimed는 검증자 협조(표기)에 의존(비협조면 co-cited 경로만)하고 표기는 자기보고라 승격·강등 재료는 '행 단독+상충 없음+항목 경로 실제 인용(cited)+seen=ok'의 4중 조건(2차 왕복 — 무인용 표식 승격·부정문 오인식·상충 허용·즉시 강등 반례 봉합)·비-git unknown은
   대형 폴더에서 상시 unknown일 수 있음(게이트는 막지 않음)·alias 후보는 endpoint+방향 동일 조건이라 서술형
   문구(화살표 없음)는 후보로 안 잡힘(정확성 우선 — 병합 실기는 수동 alias로 보완).
   L2(잔여)=버킷 억제가 변경 정체성 상실·co-change 조건부
   비율 부재·자기진단 다중 형제 레포 전제·MAP 승격이 장부 판정 무시(기존 P2와 동일 항목).
5-9. **(2026-07-10 착수·이하 v1 시점 역사 기록 — 현행은 끝의 [P0.5 갱신] 참조) Project MAP v1 — 'draft 전용 뼈대'**(사용자 제안 '프로젝트별 전체 구조도가 다섯
   의미 편집[분할·확대·축소·소멸·재작성]의 공통 좌표계' + 외부 평가[모범: tg-chat-engine SIGNAL-WIRING-MAP.md]
   + 설계 사전검증 3왕복 합의). 핵심 합의: 지도는 판단 '기준'이 아니라 '좌표계·제안 표면'(판단 근거는 코드·
   테스트·설정 증거 — 지도 자신은 증거 불가[자기확인 고리 차단]) / 정본=typed graph(topology.json — 불투명
   UUID·entityType·roles 다중·anchors[위치=증거·힌트]·상태 4차원 분리[lifecycle/implementation/confidence+
   freshness는 저장 안 함]) / MAP.md=생성 뷰(지문 머리말·수동 수정 탐지·표시 번호는 렌더 파생) / canonical
   직렬화+mapHash(CAS 근거 — revision은 표시용) / patch envelope 형식 확정(baseMapHash·baseHead·
   baseDirtyFp[project-map/** 제외]·op별 payload[expect·inverse]·evidence 최소조건[code/test/config 1개+]) /
   tier 정책기(제출자 불신 — tombstone·supersede 확정=human 고정) / 복구 3분기(base=적용·expectedAfter=보충·
   else conflict) / fail-closed 잠금(withFileLockStrict — 정본은 fail-open 금지). 구현: src/project-map.ts+
   scripts/scope-map.js(inventory[결정론·LLM 0·semanticCoverage 정직: regex 한계·동적 미상 집계]·init[1회성 —
   재실행은 ID 재생성이라 거부]·status·render). **v1 경계(정직)**: adopt(정본 채택)·propose/approve 배선 없음 —
   topology는 관측 초안이며 기존 MAP.md 확정층 권위 불침. 다섯 편집 실동작 전부 후속(v1b: propose/approve/
   decisions.jsonl 배선·큐는 wsKey+branch 로컬·approve에 payload 사본+expectedMapHashAfter / v2: 승인 경로
   단일화 이관·adopt·refresh[rename/merge 제안]·신선도 판정기[verifiedHead·anchor 지문]·slice 동봉).
   잠금: tests/project-map.test.js(96단언 — 구현 검증 9왕복+마감 1왕복[실패 9회 전부 수용] 반례: 빈 payload·복원 권한 상승·
   approve=validatePatch 전체 통과 정규화 사본+patchId 결합+opHash 재계산·set_state 필드 CAS·집합 배열 전체
   정렬[anchor 전키·semanticUnreadable]·inventory 수치+문자열 배열 원소·주석 오탐·side-effect import·status
   표면+검증이 파생 계산보다 먼저·동시 init=병렬 프로세스 spawn[성공 정확히 1·잔존 잠금 0]·부재/손상/읽기실패
   3분기·외부 JSON 무사망 계약[nodes:{}·[null]·중첩 필드·{toString:null} 독성 객체·스칼라 타입]·스키마 밖 키
   전면 거부[깊은 중첩 정크의 해시 RangeError·own __proto__ CAS 충돌 봉합, 직렬화기는 Object.create(null)
   이중 방어]·targetId 계약[add_node/add_edge는 존재 금지]·decision action별 허용 필드). 사용자 결정 축
   11개는 세션 기록 참조(데이터 모델·저장 위치·갱신
   주기 등 — 외부 평가가 상당수 결정).
   **[P0.5 갱신 2026-07-11] 스키마 v2+배포 런타임 완료**: MAP_SCHEMA_VERSION=2(mapId 세대·decisionLocks 합타입·provenance[VerificationBasis: git objectFormat sha1|sha256/historyless]·description·lastSeenAt 제거)·frozen v1 검증기·결정론 v1→v2 마이그레이터(mapId=v1 canonical 지문 유도)·bridge/map-runtime.js(CLI 본체 이관: inventory/init/status/render/migrate — VSIX 미포함이던 scripts/** 문제 해소)·bridge/project-map.js(out 산출물의 tracked 사본 — scripts/sync-map-core.js --write/--check/--watch-with-tsc가 신선도 잠금)·BRIDGE_SCRIPTS 9파일. 설계 정본=docs/MAP-V2-DESIGN.md(25왕복). 테스트 tests/project-map.test.js 153단언(v2 반례·마이그레이터·CLI migrate e2e·동시 migrate 변환 정확히 1·바이트 패리티·sync/watch 수명주기[onExit 1회·침묵 실패 금지]). 위 본문에서 v1 경계로 서술된 propose/approve 미배선은 여전히 사실이되 후속 명칭은 v1b가 아니라 P2다.
   **[P1 갱신 2026-07-12] 비차단 bootstrap 생명주기 완료(커밋 f0f13cc)**: bridge/map-bootstrap.js 신설 —
   사용자 지시 없이 MAP 자동 생성·복구. ①동의 영속(consent-<repoKey>.json — 무동의 자동 생성 0, 대시보드
   off→on 전환 시 저장 전 모달/CLI bootstrap=실행이 곧 동의) ②부모(hookTick)는 유계 신호만 읽고 ko/en 1회
   고지, 실작업=detach 자식의 선점 ③선점 mutex=.funlock(childClaim·forceUnlock 공용 — wx+read-back+모든
   상태 변경 직전 fence+writeRs도 같은 잠금 아래 runId 확인·교체) ④잠금 판정 5상태(alive/dead-valid/invalid/
   unreadable/owner-unverified) — 회수·격리는 dead-valid만 무승인 ⑤강제 복구=scope-map <repo> force-unlock
   (수동 rm 안내 전면 금지 — 원자 이동 격리·오탈취 시 즉시 원위치 복원을 시도하고 실패하면 격리 위치를 보고한 뒤 물러남·승인 사다리 --confirm-corrupt/--confirm-owner-dead)
   ⑥finishDone=withMapLock 단일 스냅샷 트랜잭션(세대 혼합 차단) ⑦exclude={이번 실행 산출물만}(created=생성
   지문 정확 일치 귀속·ensure=prev 승계) — verify-guard lazy 예외 ⑧보장 수준 명문(설계 §5 P1): 검증~쓰기
   시스템콜 간극은 파일 프리미티브의 한계로 계약화(Node 순정에 flock 없음 — Codex 15차 합의), 예외 경합은
   표면화→회수로 수렴. P1 구현 검증 17차(별도 사전 설계검증+1~15차 구현 검증 30여 결함 수용, 15차 통과(보완)→16~17차 문구 마감 통과). 참고: 커밋 f0f13cc 메시지의 '오탈취는 즉시 원위치 복원'은 위 표현이 정확하며, 변경 목록에 package.json(테스트 체인에 map-bootstrap.test.js 배선)이 누락됨 — 이 줄이 정정 기록.
   tests/map-bootstrap.test.js 149단언(전체 체인 1744/0). 다음: P2(patch pipeline — 활성화는 P3b cutover와 동시).
   **[P2 갱신 2026-07-12] patch pipeline 전체 완료(설계 25756c6 → A1 79bbf7c → A2a d5a0360 → A2b 0a586ac)**:
   상세 설계 docs/MAP-P2-DESIGN.md(사전검증 11왕복)가 정본 §5 P2 위임을 닫고, 구현 3단 —
   A1(src/project-map.ts P2 코어: 21 op 스키마·PAYLOAD_KEYS_V2·READSET_RULES·validatePatchV2 증거 이층·
   MapDecisionV2 applied만·이중 해시 adp/dih/ah/pfh/dch·effectiveConfidence, 115단언) ·
   A2a(semanticValidateV2 → SemanticVerdict 3치+순수 적용기 applyOperationV2[입력 불변·revision+1·
   split/merge 보존], 56단언) · A2b(bridge/map-pipeline.js 신설: propose/classify/apply=F-1 ⓪~⑪·F-2 정책
   전용, 클레임 3대 분기 ⓐⓑⓑ′ⓒ[영수증 전체 검증·D/Pf/K 혼합 잔존=conflict], validateWalV2 자기완결
   [kind↔op 동치·해시 DAG·audit 결속·P2=recovery inverse 전용 — patch inverse는 생산자·validator 동반
   도입 시 확장], recoverWal 복구표 t1~t14/p0~p8·t6 선행, abortWal, recoverCorruption 스냅샷 결정론,
   pipelineGc[dead nsLock 격리·보존 상한 CODEX_BRIDGE_MAP_GC_KEEP 기본 200 클램프 20~5000·오래된 순=
   WAL 고정 decision.audit.ts 1차·decisionId 동률·비-git marker는 complete 정리 연동] + map-runtime.js
   canonical writer 공통 barrier(잠금 안 재검사)·CLI 8명령(scoutMode 게이트 최선행·apply는 --pre-cutover
   강제) + map-bootstrap.js P1 배선(barrier 게이트·자식 race 종결·recovery-pending 고지), 119단언).
   + guard 배선(C-5·1-32 — 24차 마감): map-pipeline.guardExcludedFor(decisions/ 존재=1-32 산출물 일치
   판정·부재=bootstrap-only P1 exclude 유지 / marker 정밀 합타입 전체 통과 시에만 신뢰[fail-open 금지] /
   topology·MAP.md 쌍 제외 후보=topology transaction decision만[정책 감사 지문 오귀속 차단] / MAP.md
   실존 필수[부재≠빈 파일])를 map-bootstrap.mapAutoExcluded 최선두에서 소비(verify-guard 무변경 경유).
   비활성 계약 유지: 자동 트리거 0·수동 CLI 전용·권위 marker 부재(cutover는 P3b). 검증: 설계 11왕복+
   A1 7왕복+A2a 4왕복+A2b 12~24차(21차 통과(보완)→22차 통과→guard 배선 23차 실패 3건 수용→24차 통과).
   전체 체인 2052/0. 다음: P3a(정본 §5 순서 — P2 활성화 cutover는 P3b에서 한 번에).
   **[P3a 갱신 2026-07-12] 권위 전환 준비 완료(설계 c39107b → 구현 caee38e)**:
   상세 설계 docs/MAP-P3A-DESIGN.md(사전검증 12왕복·12차 통과(보완)) — 권위 판별(authority.json 정확 키·
   cutover receipt=project-map/authority-history/ 전용 서랍·authorityObject 사본+재개·부재+이력=blocked)·
   sig↔UUID 바인딩(1-24: 후보=하네스 홈 map-bindings/<nsKey>/<mapId>/ 결정론·확정=repo bindings.json 수동
   CLI만·candidateFp=내용 지문이 곧 조회 키·sig 기본키·rebind 감사)·caseAware 매칭(2단 해소·case-exact
   유일만 자동)·live 후보 서랍(.cand-global-lock 단일화·전 세대 backpressure·미처리 삭제 금지·card-refs
   순서 계약)·promoteEntry 6분기(binding 미기록=1-24 분리·durable proposal·결정론 patchId=generationFp)·
   proposeUnique(nsLock 임계구역 의미 키 유일성)·lookupBySig(prevFps+불변 (sig,entryFp,origin) 3요소 재개
   판별)·REQUIRED_SURFACES 6표면/manifest 분리(P3b 전수 검사 재료). 구현 검증 1~8차(1차 9건→7차 2건 전부
   수용→8차 통과): WAL barrier 정본 소비·GC 배선·내용 지문 재계산 신뢰 경계(entryFp/originalsFp/candidateFp
   공식 재계산·writeBindings 전수 자기 검증)·live 합타입 엄격(오타=조용한 강등 금지)·origin canonical 전체
   비교. tests/map-bindings.test.js 133단언·전체 체인 2185/0. **비활성 계약 유지: 라우팅 무변경·권위 marker
   부재·기존 export/approve/reader 경로 100% 무접촉·CLI 5명령(scoutMode 게이트)은 수동 전용.**
   다음: P4(freshness·공용 reader API — 정본 §5 순서. cutover는 P3b).
6. (후보) 대시보드 게이트 토글 UI(현재 CLI만 — informed consent 문구에 실측 명중률 표기), 발화 기록(scope-ledger-note)
   흐름의 실사용 관찰.
7. (관찰 항목) 한 폴더 다중 프로그램 구분 — 권장 관행은 프로그램별 폴더 분리, 보강 후보는 seed 클러스터 자동 좁힘.
7-1. ~~동봉(buildScoutAttach) 개선 3건~~ — **구현 완료 2026-07-09(사용자 "진행해")**: (a) 관련성 재랭킹
   rankScoutItems(순수 함수 — 지금 바뀐 파일[git status·rename은 새 경로·3초 상한·실패 시 재정렬만 포기]과의
   교집합 우선·안정 정렬) (b) 실존 파일 필터(파서 소음 '/arm'류 탈락 — 패턴 목록 아닌 '실존' 범주 규칙·전멸 시
   원본 유지 fail-open) (c) 후보군 상한 분리 — extractMapHighlights(mapText, limit) 기본 8 무회귀, 동봉 경로는
   지도 원문 상한 24 재파싱이 정본(저장 계층 meta.highlights는 8 조기 컷 박제라 폴백으로 강등 — Codex 반례:
   9번째 항목이 바뀐 파일이어도 못 들어오던 문제)·재랭킹 후 동봉 8. 잠금 tests/scout-attach.test.js(44단언 —
   순수 6케이스+실 git 끝-끝[9번째 high가 바뀐 파일이면 맨 앞]+우선순위 개정+rename). 원 분석 기록(아래) 유지.
7-1-0. (이력 — 원 분석) 동봉 개선 3건 — Codex 합의: (a) 관련성 정렬: 최신 지도 top8 고정 첨부 대신 '지금 바뀐 파일(git status)과의 교집합 우선'
   재랭킹(selectForPackage 씨앗 교집합과 동일 문법) (b) 파서 소음 강화 필터: high에 '/arm'·'DeepSeek/scoutLiveNow/flow'
   같은 비경로 토큰 잔존(extractMapHighlights 슬래시 관용성 — §6-2 알려진 소음) → 실존 파일 검증 or 토큰 규칙 강화
   (c) cap 8 전 재랭킹(문서 순서라 하단 새 항목이 밀림). '비슷함'의 주성분은 정상(같은 지형 반복 작업+턴당 지도
   1장 설계 — 지도 미갱신 사이 동봉은 동일), 부성분이 위 3건.
8. ~~가이드 배선도 + 훅·CLI 이중언어화~~ — **완료 2026-07-09**(사용자 지시 2건): ① 정찰 구조 새탭에 960×470 SVG 전체
   배선도(생성·기억·개입 지점 노드 + 점선 피드백 2개, 전 텍스트 tE ko/en — recon-ui 8단언 잠금) ② 훅(buildScoutDirective
   en 변형·scout-gate tB)·CLI 5종(scope-target/gate/ledger-migrate/ledger-note/reconcile) 전 출력 tB(ko,en) —
   `tests/cli-bilingual.test.js`(21단언: en 홈 실행 4종·ko 기본 무회귀·줄 단위 '출력 호출+한글→tB 필수' 잠금). 같은 턴
   Codex 반박 수용: 안내 표면(가이드 FAQ·고급설정·README ko/en)을 PRIVACY '예외 둘(꾸러미+연결 점검 1회)' 체계로 정합화
   (deepseek-bridge.test.js 잔재 금지 단언). **후속 후보**: (a) reconcile 상태 파일 from을 중립 구조 {arm,ts}로 저장하고
   렌더 시 번역(Codex 보완안 — sig 식별 무관·언어 전환 시 이력 표기 혼재는 미관 문제) (b) scope-ledger-backfill.js(타 PC
   작성)가 아직 한글 전용 — tB 이중언어화 필요(cli-bilingual 테스트 대상에도 추가) ~~(c)~~ **→ §6-11 P3에서 해소
   (지시·각주·preface 이중언어+러너 CLI 출력 tB[감사 D 후속 2026-07-09]. 본문 증거 라벨만 한국어 유지)** (c-원문) **정찰 러너·꾸러미
   프롬프트가 한국어 고정**(scope-scout-self.js preface·deepseek-bridge.js map·scope-package.ts 지시/각주) —
   영어 모드에서도 지도·일지 '원문'이 한글로 생성됨(Codex 반례 2026-07-09). UI만 이중언어인 상태 — 데이터
   생성 언어도 loadLang을 따르게 할지는 채점기·파서(한글 구획 표기 의존) 영향 검토와 함께 별도 결정.
9. ~~정찰 설정 언어 슬롯 분리~~ — **완료 2026-07-09(사용자 결정)**: 한글 모드와 영어 모드는 사실상 다른 사용자
   (생활권 분리) — 정찰 부속 설정(scoutGate·scoutRepo)도 규칙·기본지침처럼 **현재 언어 슬롯에만** 저장.
   scope-gate·scope-target의 양슬롯 동기화(writeBothSlots) 폐기, 대신 반대 슬롯 값이 다르면 ⓘ 고지(소실 오해
   방지 — otherSlotHasRules 선례). **API 키(deepseek.json)만 전역 공유가 맞음(사용자 확정)**. 3트랙 선택
   스위치(scoutMode)는 원래부터 대시보드가 슬롯별 저장이라 무변경. 잠금: scout-gate [5]·scout-target [5-1].
   ⚠ 파생 원칙: 앞으로 '설정'은 언어 슬롯별, '전역'은 API 키·언어 자체뿐. 정찰 '데이터'(지도·일지·교범)는
   프로젝트 단위·언어 무차원 유지(기억을 언어로 쪼개면 반쪽 학습 — 변경하려면 사용자 합의).
10. **검증 통계 '3트랙 기여'** — (b) 즉시분(기여 카드·§6-11 말미)과 **정찰 비용 장부(stats/scout-usage.jsonl —
   2026-07-09 사용자 요구 "토큰·건수 투명 기록", 러너 2종+ping 기록·60일 트림·verify-stats computeScoutCosts·
   통계 탭 '정찰 비용' 구획·self는 문자수만[토큰 미제공 정직 표기])는 구현 완료. 잔여 = (a)(c). 원 설계: "2트랙이었으면 못 잡고 지나갔을 것"의
   기록. 반사실은 직접 측정 불가 → 측정 가능한 대리 신호로: (a) 검증 실패/보류 답이 '동봉된 지도 경로'를 실제
   지적에 인용한 사례 수(동봉 없었으면 그 지점을 안 봤을 개연) (b) 장부 신뢰분이 다음 꾸러미에 실려 재인용된
   횟수 (c) 게이트 차단→지도 갱신→플랜 수정 사례. 유도 가능성 정직 구분(Codex 정정 2026-07-09): (b)만 기존
   attached/confirmed 이벤트로 즉시 가능. (a)는 동봉 스냅샷·답변 인용 대조 기록이 현재 없음(동봉은 프롬프트에
   붙을 뿐 이벤트化 안 됨 — contract-lib buildScoutAttach·proofs는 메타만) → 동봉 시점 기록 신설 필요.
   (c)는 차단은 scout-gate-log에 있으나 '이후 플랜 수정' 신호가 없음 → 보강 필요. 추가 LLM 0 원칙은 유지.
   사용자 지시로 ①(슬롯 분리)·②(정정 로직 분석) 이후 착수.
11. ~~정찰 프롬프트 노출~~ — **구현 완료 2026-07-09(사용자 "시작해")**: P1 태도층 슬롯(contract-lib loadScoutBaseline/save/reset — 언어 슬롯별·기본값 복원·두 팔 preface 단일 출처 buildScoutPreface, ab-retro만 실측 안정성 위해 고정) · P2 형식 계약 잠금 노출(정찰 카드 scoutPrompt 패널 — scope-package scoutDirectiveText/scoutLedgerNotes 단일 출처, 편집 개방은 미실시라 파괴 감지 신호는 아직 불요) · P3 프롬프트층 이중언어(지시·각주 en 변형+출력 언어 명시 — §6-8 후속(c) 해소, 본문 증거 라벨은 한국어 유지 정직 고지) · P4 지도 메타 프롬프트 서명(promptLang·baselineHash·baselineCustom·formatVersion=f1) · ~~P5 정찰 카드 노출+원칙 패널 링크~~ → **재배치 2026-07-09(사용자: 일지 카드 접힘 속은 숨은그림 — 발견 불가)**: '단계별 기본 원칙' 패널이 트랙에 따라 확장 — 3트랙이면 ④ 정찰 칸(태도 편집)+④-형식 계약(잠금 노출)+단계 스트립 ④행 등장, 저장/복원 버튼 하나로 ①~④ 일괄. 같은 날 **검증 통계 탭에 '3트랙 기여(관찰 신호)' 카드**(§6-10 (b) 즉시분): 발견(proposed)·동봉(attached)·확인(confirmed+user)·재실수방지/복권 4지표 — 일지 이벤트 합계(추가 LLM 0)·반사실 증명 아님을 정직 고지·2트랙 숨김. 잠금 tests/scout-prompt.test.js(44단언 — 재배치·기여 카드 잠금 포함, 수치는 갱신 시점 기준). 원 제안 기록(아래)은 이력으로 유지.
11-0. (이력 — 원 제안) 정찰 프롬프트 노출 — 2트랙 '단계별 기본 원칙'과 대칭.
   사용자 질문("3트랙도 프롬프트가 별도로 있나? 있다면 2트랙처럼 구현돼야 하지 않나")의 사실 확인: 있다,
   세 겹, 전부 하드코딩·비노출 — (1)역할 preface(scope-scout-self.js 26행 / deepseek-bridge.js buildMapRequest,
   두 벌) (2)형식 계약([탐색자 지시] — scope-package.ts, ①~⑥·high·판정 금지) (3)자료 취급 각주(§7.5).
   Codex 합의 설계(통과·보완 반영): 통째 편집 개방은 위험 — (2)(3)은 extractMapHighlights/extractMapPatches/
   일지 적재/ab-retro 채점기가 그대로 읽는 배선이라 편집 파괴가 '조용히' 죽음(advisory라 오류 없음. 2트랙
   verifyBaseline의 판정 문자열엔 표지누락 경보가 있지만 정찰엔 fail-visible 채널 없음). 따라서:
   (P1) 태도층만 편집 슬롯(scoutBaseline — 언어 슬롯별·기본값 복원), 두 팔 preface 공유 모듈 단일 출처화(필수)
   (P2) 형식 계약은 '보이되 잠금'(읽기 전용 노출) — 편집 개방은 형식 파괴 감지 신호와 세트일 때만. ⚠ 감지
   기준은 '추출 0건'이 아니라 구조 신호여야 함(Codex 정정: high 0건·⑥ 후보 0건은 정상 지도에서도 남 —
   0건을 파괴로 보면 거짓 경고): ①~⑥ 구획 헤더 자체의 부재·허용 구획 전무·형식 버전 불일치를 직접 감지,
   추출 0건은 보조 신호로만 (P3) §6-8 후속(c) 이중언어화와 같은 파일이므로 한 묶음 작업
   (P4) 지도 메타에 프롬프트 서명(arm·model·lang·scoutBaseline 해시·형식 계약 버전) — 수정본 지도가 사전등록
   48.1% 실측군에 섞이는 통계 오염 방지 (P5) 노출 위치: 정찰 카드에 기본 노출 + '단계별 기본 원칙' 패널엔
   링크/요약(Codex 보완 — 원인·결과가 정찰 카드에 있어 이해 흐름상 유리).

## 6.5 설계 요지와 남은 후보 (레포 밖 설계 원본의 알맹이 — 구현 여부는 각 항목에 표기)

- **확정된 결정 레지스트리(변경하려면 사용자 합의)**: D1 MAP은 핵심 파일채널부터(예: proofs/·integrity·phase 같은
  '한쪽이 쓰고 다른 쪽이 읽는' 결합) / D2 탐색자는 프롬프트형(꾸러미 떠먹임 — 도구 탐색형은 후순위) / D3 advisory 유지
  (강제 게이트는 성능 입증 후) / D4 키는 env·파일 수기(UI는 이미 추가됨) / D5 self-preflight A/B(오차 수준이면 self 채택) /
  D6 순서=빌더→self 팔→DeepSeek 연결(완료) → A/B → Phase 3.
- **L1 '사용 장부'(미구현·다음다음 후보)**: 하네스가 이미 관찰하는 것들(이 턴에 변경된 파일·읽힌 파일·검증에 인용된 파일)을
  세션 단위로 자동 누적하는 장부. 목적: ①비-git 폴더의 '함께 변경' 통계 대체 ②한 폴더 다중 프로그램의 자연 클러스터링.
  필수 위생 4종(고아 데이터 방지): 묘비(삭제 파일 표시)·감쇠(오래된 항목 약화)·상한(항목 수 cap)·죽은 키 린트. ws 격리+TTL.
- **stable MAP 2층(1차 구현 완료 — §6-3 참조)**: 확정층(docs/MAP.md)과 제안·관측층 분리는 구현됨 — 남은 것은 실사용
  데이터 축적과 임계 튜닝. 원 설계 취지(탐색자·꾸러미는 확정층만 신뢰 입력)는 유지.
- **scoutMode 원안 확장(현재 off|on)**: 원안은 off|manual|gate|always — gate(쓰기 도구·플랜 확정 시 자동)·always는
  A/B 성능 입증 후에만 검토. 현재 자동 지시(지시 주입형)는 manual과 gate 사이의 중간형으로 이미 동작.
- **한 폴더 다중 프로그램(관찰 항목)**: 권장 관행=프로그램별 폴더 분리(도구 전체가 폴더 키 체계). 보강 후보=seed가 특정
  하위 폴더에 몰리면 탐색 범위 자동 축소+고지, 수동 하위 경로 인자. 장기 정답=L1 클러스터.

## 7. 검증 절차 요약 (다른 환경에서 처음 여는 사람용)

1. `node install.js` → 창 리로드 → 상태바 Codex 항목 확인.
2. 대시보드에서 **검증자** Codex 세션 연결(없으면 ask가 검증자 세션만 자동 생성·연결 — C-C 구현 세션은 생성·수동 연결 대상이 아니라 사용자가 실제로 연 대화가 훅/rollout으로 자동 고정) · 검증 모드 선택 · 트랙(2/3) 선택 — 전부 프로젝트별 저장.
3. 매 턴 훅이 검증 지시를 주입하고, Stop 훅이 "검증 없이 종료"를 막는다. 판정은 통과/통과(보완)/보류/실패 4단.
4. 3트랙이면: 지도 없음/낡음 시 자동 지시가 오고, `scope-scout-self.js`를 돌리면 게시판·상태바가 반응한다.
