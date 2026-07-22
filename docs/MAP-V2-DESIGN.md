# Project MAP v2 — 설계 고정 문서 (P0)

> 2026-07-11. 사용자 지시(3트랙 하네스와 Project MAP v1 연결 — 자동 생성·증거층 통합·공급자 3종·자율 반영·intent-choice)의
> 구현 전 설계 고정본. **구현모델 독립 분석(8영역 병렬 정독)과 Codex 독립 분석(HEAD d8947a9 전체 코드)을 교차 대조**하고,
> **Codex 설계 검증을 22차+ 수행 — 1~20차의 잔여 지적과 사용자 후속 지적(5건+국소 정합 7건)을 전부 반영**했다.
> 이후 Phase에서 어긋나는 구현이 나오면 이 문서가 기준이다.

## 0. 지시문 타당성 판정

**대구조는 타당하다** — "사용자는 승인자가 아니라 의도 선택자"라는 철학, typed graph 유일 정본, 결정 상태 5종,
provider 3모드, 결정론 라우팅은 현 코드베이스의 설계 교리(저장 enum 불신·유도 판정·후보 제시와 확정 분리·2트랙 무회귀)와
정합한다. 단 **아래 §1의 수정 사항을 반영해야 논리적으로 실행 가능**하다. 수정 없이 문자 그대로 구현하면
자기모순 파이프라인(CAS 상시 무효화·훅 턴 차단·검증 축 오염)이 된다.

## 1. 지시문 수정 사항 (양측 교차 + 재검증 반영 확정)

1-1. **CAS 재설계 — '낡은 스냅샷 감지+재기반'과 '경계 이탈 hard reject'의 이원 규칙.** 전역 baseDirtyFp
완전일치는 기아(무관한 파일 저장 하나로 전체 pending 폐기)라 감사 메타로 강등한다. 판정 규칙(2·3차 재검증 반영):
- **hard reject(재기반 금지)**: patch에 결속된 **origin identity**가 현재와 다르면 무조건 거부 — 지시 §9
  '브랜치나 working tree가 바뀌면 거부'는 이 경계에만 적용된다. 큐 분리만으로는 직접 ID 적용·WAL 복구·장기
  worker의 교차 적용을 못 막으므로 patch 자체에 origin을 결속한다. **비-git 지원이 명시 범위이므로 Git 전용
  계약 금지 — 그리고 '로컬 실행 좌표'와 '공유 검증 기준'은 서로 다른 타입이다(5차 지적 #1). 세 타입 분리:**
  - `ExecutionOrigin`(로컬 전용 — 절대경로 포함, 저장소에 절대 기록 금지):
    `{kind:"git", worktreeReal, gitCommonReal}` | `{kind:"historyless", rootReal}`
  - `PatchBasis`(CAS용 — patch·pending·WAL에 결속):
    `{kind:"git", branch|detachedHead, baseHead}` | `{kind:"historyless", basisFp, inventoryFp}`
  - `VerificationBasis`(저장소 공유 provenance — 이식 가능한 값만):
    `{kind:"git", head}` | `{kind:"historyless", basisFp, inventoryFp}`
    (★P4 v8 불변식: PatchBasis.basisFp=mapHashOf(full·provenance 포함 — CAS는 provenance 변경도 반영) /
    v3 historyless VerificationBasis.basisFp=structuralHashOf(provenance 제외 — provenance만의 변경에 불변) /
    mapHashAfter·audit·snapshot·WAL·authorityHash는 structural로 교체하지 않음. 정본=P4 상세 설계 v8.)
  hard reject 경계=ExecutionOrigin 또는 PatchBasis의 branch/root 변경, 재기반 판정=같은 branch의 head 전진
  +read-set(historyless는 basisFp/inventoryFp+read-set). 빈 문자열·sentinel 해시로 Git 계약을 흉내내는 것 금지.
  applied decision에는 ExecutionOrigin의 절대경로를 저장하지 않는 portable projection만 기록.
- **재기반 허용(같은 브랜치의 HEAD 전진·타 patch 적용으로 인한 mapHash 변경)**: patch의 **read-set**이
  그대로면 새 base로 자동 재기반+재검증 후 적용, 깨졌으면 stale-expired(또는 needs-investigation).
- **read-set은 op별 스키마로 정의한다**(파일 지문+expect만으로는 부족 — 재검증 지적): ①대상 entity의
  revision/내용 지문 ②evidence/anchor 파일 내용 지문 ③**인접성 지문**(add_edge=from/to 노드 존재+동일 관계
  부재+인접 edge 집합 해시, merge=전 입출력 edge·steward·decisionLocks 해시) ④**음성 조건**(widen/narrow의
  '존재하지 않았음' 근거=관련 디렉터리 인벤토리 지문). 상세 표는 P2 설계에서 op별로 고정하되 이 4범주가 기준.
- 재기반·재검증·CAS 재검사는 fail-closed 잠금 '안'에서.

1-2. **휘발 관측치는 로컬, 검증 provenance는 공유.** anchor 내용 지문·stat 캐시·lastSeenAt 같은 고빈도 관측치는
topology 밖 하네스 로컬 freshness 저장소(node UUID+anchor path 키)로 — mapHash 자기 유발 무효화 방지.
**단 검증 기준은 캐시가 아니라 '어느 상태에서 확인됐나'라는 provenance다(재검증 지적 #3)** — clone·타
개발자도 재현해야 하므로 **적용 decision 레코드와 node/edge provenance에 VerificationBasis(1-1의 저장소
공유형 — git=head, historyless=basisFp/inventoryFp)+당시 evidence 내용 지문을 저장소 공유로 기록**한다
(6차 정정: 'verifiedAtHead' 단일 필드명은 Git 전용이라 폐기 — §3의 tagged 구조가 정본). lastSeenAt는 스키마에서 제거(MAP_SCHEMA_VERSION 2, actor=migration).
신선도 '판정'은 항상 읽기 시점 유도(비저장).

1-3. **훅은 실행자가 아니다.** UserPromptSubmit 안에서 bootstrap·의미 보강·전수 검증 금지 — 유계·캐시 가능
신호 판독(파일 존재·mapHash 앞자리·head 비교)+상태 고지+detach 기동(inflight 선점으로 창 간 1회)만.
(근거 정정: '훅 예산 3초'라는 단일 계약은 없고 3000ms는 개별 git 하위 호출 timeout이라 연속 호출은 합산될 수
있다 — 그래서 더더욱 훅 내 실행 금지가 결론이다.) 전수 검증은 비동기 refresh 경로로.

1-4. **Scout·충돌 판정은 검증 부작용 밖의 별도 진입점.** ask 성공 경로의 부작용 5연쇄(writeProof/flagEvidence/
flagLedgerConfirms/flagVerdict/verdict 통계)와 withContract 계약 주입·phase '검증중' 표시를 일절 호출하지 않는다
(정찰 질의가 '검증 성공'으로 기록되는 무결성 구멍 차단). 공용 추출선: runCodex/runCodexNewSessionAsync/세션 탐지
3함수/resolveCodex군/modelArgs/parseLastTurn(전부 역할 중립 실측). cmdAsk는 Verifier orchestrator로 잔류.

1-5. **verifier-resolved의 증거 결속은 '내용 수준'까지.** 판정 표지+cited(실존 인용)+seen(이번 턴 취급)은
필요조건일 뿐이다(cited는 '실존 파일을 인용했다'이지 '그 코드가 이 주장을 지지한다'가 아님 — 재검증 지적 #7).
**요건: MAP 전용 typed 결과가 patchId/opHash/baseDecisionContextHash(§3 — 23차 정합: 정책이 바뀌고 topology가
그대로면 authorityHash 불변이라 옛 검증 결과가 유효로 남는 반례 차단. 정책 비참조 결과도 동일 키 사용 —
frontier 불변이면 값이 같아 무해)에 결속되고,
주장(claim)별로 근거 파일의 내용 지문(blob/content hash)+위치(symbol/line locator)+지지/반박 판정을 담아야 한다.** read-set 지문과 이 claim 결속이
같은 재료를 공유한다. 판정 불가·표지 누락·결속 누락은 전부 needs-investigation.

1-6. **라우팅의 mapped corridor 판정은 'node 소속'(node가 대표하는 디렉터리 경계 포함 여부) 기준.** v1 anchor
밀도(디렉터리당 표본≤3)에서 anchor 일치 기준은 거의 전부를 topology delta로 오판해 정밀형 과호출을 만든다.
anchor 일치 기준은 의미 보강으로 밀도가 오른 뒤에만 활성화.

1-7. **'정확히 1회' init = map identity별 동시 1회.** 판정 근거는 레포 파일계 상태(fail-closed 잠금 안 존재
재검사)이고 UI 전환·훅 폴백·scoutRepo 변경은 전부 '시도 트리거'일 뿐(전환 감지는 언어 슬롯별·창별 비원자라
1회성 근거가 될 수 없음). topology 삭제 후 재시작은 새 identity로 재생성 허용.

1-8. **DeepSeek typed JSON은 능력 검증 후에만.** 경제형 활성 조건에 'schema capability probe 통과' 추가.
strict validator+크기 상한+bounded repair(1회). **repair 실패 후 처리는 1-34의 모드 경계를 따른다(22차 정합 —
사용자 지적 ①): 자동형에서만 Codex 정밀형 자동 승격, 사용자가 경제형을 명시 선택한 경우 provider를 전환하지
않고 needs-investigation 파킹+degraded 사유 표시**(비용 때문에 경제형을 고른 사용자 몰래 Codex를 호출하지
않는다). readiness는 영속 상태 파일(설정 지문+ts)로 기록하고 요청·응답에 설정 지문 에코(판정~호출 사이 설정
변경 TOCTOU 방지). ping은 typed readiness 증거가 아니다.

1-9. **역할 배제는 '단일 role registry' 원자 트랜잭션(재검증 지적 #1).** 두 링크 파일의 상호 조회만으로는 동시
기록 경합에서 둘 다 '미등재'로 보고 이중 등록된다(updateLinks는 best-effort CAS). **결정: 세션 역할의 정본은
단일 session-role-registry(strict 잠금 하 갱신) 하나로 하고, links.json/scout-links.json은 각 축의 상세(모델
선호 등)를 담는 종속 파일로 둔다. 등록·역할 변경(unlink→relink)은 registry 트랜잭션 안에서만. 종속 파일 쓰기
실패 시 복구 계약(registry 선기록→종속 파일 실패=재시도 후 registry 항목에 dirty 표시·다음 판독이 재구성)을
P6 구현에 포함(2차 재검증 부기).** 미등재 세션은
link 시 role 지정 요구(기본 verifier=무회귀). 후보 목록은 숨김이 아니라 role 라벨 표시. 세션 탐지 함수에
'제외 id 집합' 인자 추가. brainActual·drift·verdict 통계 귀속에서 scout 세션 제외. Scout 자동 생성은 무링크
첫 실행 1회만+scout판 autoNewFailed+실패 시 폴백 고지.

1-10. **needs-investigation의 결정론 종결.** ①read-set 불일치 → stale-expired 자동 정리 ②조사 에스컬레이션
단수 상한(횟수 — 시간 아님) 도달 → 'unresolved 파킹'(대시보드 가시화·사용자 질문 아님).

1-11. **'임의 시간 상수 금지'는 '근거 미기록 신규 판정 상수 금지'로 한정.** 신규 운영 파라미터(타임아웃·폴)는
env>설정>기본+클램프 패턴(verifyTimeoutMin 전례). 판정 로직은 상태 서명·버킷 기반(시간 0). Scout 타임아웃은
verify 전용 키를 공유하지 않는 별도 키.

1-12. **이벤트 목록 정정 + decisions 분리.** rehabilitated는 이벤트가 아니라 유도 필드. 실명 15종 = proposed/
attached/confirmed/refuted/user_confirm/user_dispute/pinned/unpinned/banned/unbanned/superseded/tombstone/
exported/alias/unalias. decisions는 기존 장부 JSONL에 넣지 않는다(EVENT_TYPES allowlist·트리머 보존군·헬스 동형
3중 파손) — 별도 저장(§4 P2의 이층 구조).

1-13. **merge류의 분기는 3단 — 동형 증명/조사/의도(사용자 후속 지적 2026-07-11 반영).** anchors·edges·evidence가
같은 대상을 지시하는 것만으로는 부족하다(같은 파일을 공유해도 읽기/쓰기 역할·제품 경계·steward·conditions·
decision lock이 다른 두 기능축일 수 있음 — 자연어 자동 병합을 폐기했던 반례와 동일). 판정 사다리:
- **완전한 의미적 동형**(entityType·roles·state·conditions·steward·decisionLocks·모든 입출력 edge)을 Verifier가
  확인 → verifier-resolved 자동 merge.
- **동형 증명 실패 → needs-investigation**('자동 조건 미충족'과 '사용자가 제품 방향을 골라야 함'은 같은 뜻이
  아니다 — 대부분은 근거 부족이거나 '지금은 별개 유지가 안전'일 뿐. 곧장 사용자를 부르면 MAP 정리 책임이 다시
  사람에게 간다).
- **조사 후에도 '하나의 기능'과 '별개 유지' 둘 다 타당한 제품 모델로 남고, 현재 구조 결정이 실제로 필요한
  경우에만 → intent-choice.**
- **현재 작업에 merge가 필요하지 않으면 → 별개 유지+resolved-noop 종결**(질문 없음. 15차 정정: unresolved는
  '조사 상한 도달·결론 미도출'의 파킹 상태이므로 '결론이 난 no-op'을 거기 넣으면 건강도·정리 대상 집계가
  오염된다 — proposal lifecycle의 정식 종결 resolved-noop으로).

1-14. **intent-choice 채널 = 대시보드 웹뷰 버튼→확장→하네스 파일(기존 ledgerAct 패턴)+proposal/
baseDecisionContextHash(§3 — 22차 정합: 카드의 중복 억제뿐 아니라 '선택 적용 시점'도 decisionContextHash로
검사해야 정책 변경 후 옛 카드 선택이 그대로 적용되는 구멍이 없다) 결속.** 선택 후 base가 바뀌었으면: 선택
'의미'가 그대로면(read-set 동일 — 정책 frontier read-set 포함) 자동 재기반, 의미가 달라진 경우에만 새 카드
(무조건 재질문 금지의 유일한 예외).

1-15. **배포 재료: v2 런타임은 bridge/ 배포 모듈(또는 out/)로 승격.** VSIX는 scripts/**·tests/**·install.js를
제외하므로 scope-map.js 계열은 마켓 설치본에 없다. bridgeLib() require+typeof 가드+낡은 런타임 정직 에러 선례.
(정정 — 재검증 지적 #12: **BRIDGE_SCRIPTS는 배포 파일 추가 시 갱신, OUR_HOOKS·isOurHookCmd는 '새 훅
entrypoint를 Claude 설정에 등록할 때만' 갱신** — 세 목록의 일괄 쌍 갱신이 아니라 각자의 트리거가 다르다.
hook-setup.ts와 install.js의 이중 유지 계약은 해당 목록을 실제로 바꾸는 경우에 적용.)

1-16. **scoutMode(및 신설 provider 모드)의 반대 슬롯 폴백 — key 존재 여부 계약 포함(재검증 지적 #14).**
'사실≠언어 내용'이므로 폴백을 도입하되, **현재 슬롯에 명시값(raw key 존재)이 있으면 그것이 항상 우선하고,
key 자체가 없을 때만 반대 슬롯을 상속한다**(정규화된 off와 명시 off를 구분 — 명시 off를 반대 슬롯 on이 덮으면
2트랙 회귀). loadContract가 미설정과 명시 off를 구분 없이 반환하는 현행 구조에 raw key 판독 경로를 추가한다.

1-17. **트리거 ③ 재정의: '마지막 MAP 평가 시점의 해석된 대상(resolved repo)과 현재 해석의 불일치'.**
ws별 last-resolved-repo를 하네스 로컬에 영속(계약 편집 이벤트는 감지 불가능하고 언어 토글로도 실효 대상이 바뀜).

1-18. **손상 복구는 intent-choice가 아니라 recovery-action(재검증 지적 #6).** 파일 손상 복구는 제품 의도가
아니라 운영 복구다. **결정: recover는 ①로컬 최신 유효 스냅샷(하네스 서랍의 topology 사본 — P2에서 apply마다
보관) ②git 이력의 마지막 유효본(git 프로젝트 한정) 순으로 후보를 찾아 별도 파일로 복구하고 원본은 보존한다.
비-git 프로젝트는 ①만 사용(bootstrap이 비-git도 지원하므로 복구도 git 전제 금지).** 복구 실행은 대시보드의
recovery-action 카드(운영 알림 — 의도 선택 아님)로 노출. dead-lock 잔존 잠금 회수(토큰+pid 검사+원자 재선점)도
recover 전담 — 자동 경로는 degraded 고지만(재시도 폭주 금지).

1-19. **journal 이층 구조 고정 — authority-aware(11차 지적 반영).** **prepared WAL은 하네스 로컬**(지시 §3
'적용 전 제안은 로컬'), **applied decision은 저장소 공유 — decision별 독립 파일
`project-map/decisions/<decisionId>.json`(사용자 후속 지적 2026-07-11: 단일 JSONL append는 두 브랜치가 같은
파일 끝에 각각 append하면 Git 텍스트 충돌이 실제로 발생 — 사용자가 로그 충돌을 손으로 풀게 되면 자동화 철학
위반. 독립 파일이면 병렬 브랜치 충돌이 사실상 없고 decisionId=파일명이 자연 멱등 키. decisionIndexHash는
파일 집합의 canonical 정렬로 생성하고 index 파일은 생성물로 취급).** 쓰기 계약: 둘 다 atomicWrite(tmp+rename),
멱등 키=decisionId.
**prepared WAL 필수 필드(자기완결 — 13차 지적: WAL만 남은 상태에서 재적용, topology 교체 후엔 before 지문
포함 완전한 decision 보충이 가능해야 하며 pending 큐 참조로 대체 금지): ①정규화 patch 사본 전체+patchId+
opHash(v1 approve 복구 계약 승계 — 사본 없으면 재적용 불능) ②PatchBasis·read-set·inverse/복구 정보
③topology before 내용 지문(교체 후엔 사후 계산 불가) ④decisionId·mapId·AuthorityDecisionProjection(canonical
지문 포함) ⑤expectedMapHashAfter·expectedDecisionIndexHashAfter·expectedAuthorityHashAfter(+정책 동반/전용
시 expectedPolicyFrontierHashAfter·expectedDecisionContextHashAfter — 22차: 새 결정 문맥이 기대와 같은지의
복구 기준. 이 expected 해시들은 projection·frontier 입력에서 제외되는 감사 필드)
⑥**(정책 동반/정책 전용 시) tagged policy artifact(19차 확정 — 생성과 철회는 서로 다른 파일 종류이므로
WAL이 종류를 자체 판별해야 자기완결):
`{kind:"intent-policy", policyId, 정규화 IntentPolicy 사본, 예상 파일 지문, supersedesPolicyIds}` |
`{kind:"policy-revocation", revocationId, targetPolicyId, 정규화 revocation 레코드 사본, 예상 파일 지문}`.**
복구 튜플의 policy 검사도 artifact kind에 따라 정확한 파일 경로(.json vs .revoke.json)·내용·지문을 대조. 적용 쓰기의 내구 상태는 6단(12·15차 반영 — WAL만 / topology만 / topology+MAP.md / +decision / +policy 파일
[정책 동반 시 — decision 보충과 동일 규칙으로 WAL 사본에서 보충] / +marker[decision 파일과 policy 파일의
after 지문을 함께 결속])이며
각 중단 지점의 복구 대응: **⓪topology만 원자 교체됨·MAP.md 이전/부재·decision 미기록(mapHash=expected인데
색인·MAP.md가 이전 값인 상태) → WAL projection으로 expected authority 재계산→MAP.md 재렌더→동일
decisionId/projection으로 decision 보충→marker 기록(한 체인으로 완결)** ①topology+MAP.md 기록·decision
미기록 → decision 보충(projection 대조 후)→marker ②decision까지 기록·guard marker 미기록 → marker 보충
③같은 topology인데 decision 색인이 기대와 다름 → 재렌더+authorityHash 재검사 ④복구 대상 projection과 다른
decision이 병합돼 있음 → read-set 재검증 또는 conflict. **policy-aware(16차 반영): 정책 동반 WAL이면 모든
decision 보충 분기가 조건부 decision→policy→marker 체인으로 완결되고, 복구 판정 튜플에 (policyRequired,
policyExists, 실제 policyFp=예상 policyFp)를 포함한다 — 'decision 있음·policy 없음' 중단이 ②(marker 보충)로
오분류되지 않게. marker는 decision·policy 두 파일이 실존하고 예상 지문과 일치한 뒤에만 생성.** **복구 판정은 topology
해시 단독 비교가 아니라 (mapHash, decision 존재·projection 일치, authorityHash) 튜플 비교이고, 정책 경로
(6단 WAL의 policy artifact 동반)에서는 (policy artifact kind/id/내용 지문, policyFrontierHash,
decisionContextHash)를 추가로 대조한다(23차 — expected 값을 저장만 하고 복구에서 안 쓰면 자기완결 아님.
불일치는 즉시 폐기가 아니라 read-set 재검증·conflict 경로로)** — v1
recoveryDecision 3분기는 이 튜플 비교의 내핵으로 승계. CAS 재검사(⑥⑦⑧)는 잠금 안.

1-20. **'②b semantic validation' 단계 명시 신설** — targetId 실존+expect vs 현재값 대조(topology 입력).
validatePatch(형식)와 분리된 이 단계의 실패가 needs-investigation의 정식 진입점.

1-21. **상태 어휘 4계통 직교 분리(5차 지적 #3 반영).** ①bootstrap 생명주기(진행형은 하네스 로컬 run-state+pid
생존 검증) ②freshness(항상 유도·비저장) ③**proposal lifecycle: proposed→classified→resolved|resolved-noop|expired**(로컬
pending 파일의 상태 — 지시 §3 '적용 전 제안은 로컬'. detectedBy/provider 메타 보유. 멱등 키=patchId. 관찰
장부의 proposed '이벤트'와는 별개 계통 — 혼동 금지) ④patch 결정 분류 5종(classified의 산출)+종결
applied/stale-expired/unresolved. conflict는 결정 상태기 소관(공급자 충돌·topology↔검증 불일치)이지 신선도가
아니다. UI는 병기.

1-22. **docs/MAP.md 재배선은 이미 확정된 사용자 정책 — 재승인 없음(재검증 지적 #11 수용, 초안 정정).**
지시 §4가 'legacy는 migration source·신규 승격은 Project MAP 경로만'을 명시했으므로 **재배선 자체는 다시 묻지
않는다.** P3b 원자 cutover에서(23차 정정 — P3a는 준비만·기존 경로 유지): 대시보드 내보내기·scope-reconcile approve의 목적지를 Project MAP patch 제안으로 전환,
docs/MAP.md는 read-only 이관 소스로 동결(deprecated 배너), 기존 '불변 약속' 문구 전면 개정, README '④ 확정
교범' 서술 개정. **개별 항목의 이관 판정이 모호한 것만 intent-choice.** 사용자에게는 변경 사실을 '고지'한다
(질문이 아니라).

1-23. **PRIVACY/README ko·en 선갱신 의무.** 각 Phase 완료 조건에 해당 표면의 문서 개정 포함(PRIVACY 자기 규범:
'조건이 바뀌면 문서를 먼저 갱신'). P1(자동 생성)·P5/P6(외부 전송) 착수 전 선갱신 + 3트랙 켤 때 'MAP을 레포에
생성' 고지를 기존 대상 확인 모달에 결합(informed consent).

1-24. **sig↔UUID 바인딩 테이블 신설.** 초기 자동 후보 키=endpointsKeyOf(경로쌍+방향), 후보 제시·확정 분리 유지.
매핑 없는 기존 entry는 증거층에 그대로. legacy 판독 함수(ledgerSig·extractPathsFromText 패리티 쌍) 보존.

1-25. **꾸러미 기억 주입(+25.0%p 실측) 보존.** 장부는 증거 입력으로 계속 주입(정본 역할만 topology로). 꾸러미
형식 버전을 메타에 기록, P3b cutover 완료 후 ab-retro 재기준선 측정(24차 정정 — 전환 후 효과 측정이 목적이므로 marker 활성 전 실측 금지)(사전등록 변경=사용자 합의 필요 항목).

1-26. **탐색 방식 기본값=self(현행 무회귀)·라우터 미적용. 단 self에도 typed adapter를 제공한다(재검증 지적 #15).**
**(경계 부기 2026-07-20 — 정본 감사 지적 수용)**: 대시보드의 `scoutArm`(f016212 — self|deepseek)은 **기존
Impact Map 자유서식 러너의 선호 선택일 뿐**이며 Project MAP typed provider 정책이 아니다. P7의 provider
mode(economy/precision/auto — 1-34)는 **별도 제어로 구현한다**(같은 옵션으로 합치기 금지). scoutArm의
'키 없으면 self 강등' 규칙은 legacy 팔 전용 — P7 economy에 재사용 금지(1-34 '명시 선택의 조용한 전환
금지'와 충돌: 명시 economy의 readiness 상실은 강등이 아니라 degraded+사유 표시다).
기존 자유서식 self/DeepSeek 팔은 Impact Map 전용으로 무변경 존치하되, **runScout('self')는 typed ScoutResult를
요구하는 별도 프롬프트(claude -p 스키마 강제)로 MAP patch 후보를 생성할 수 있다** — 기본 설정에서도 의미 보강이
가능해야 최종 목표(자동 진화)가 성립하기 때문. typed 실패 시 needs-investigation(자유서식으로의 침묵 강등 금지).
경제형/정밀형/자동형은 opt-in.

1-27. **v1 정책 개정표(의도 문서화된 정책 변경 — 테스트는 '의도 개정'으로 재작성, 삭제 아님).**
①change_relation: 코드 증거 명백 시 verifier-resolved(지시 명시) ②'명백한 supersede': verifier-resolved
③**tombstone 3층(사용자 후속 지시 2026-07-11로 재개정 — '모든 후보가 자동으로 사용자 카드로 가면 안 된다')**:
  ⓐ observed-absent(코드에서 안 보임) = 결정론 관측 기록만, 질문 없음
  ⓑ tombstone_candidate = **needs-investigation 선행**(삭제 커밋·호출부·테스트·설정·대체 존재를 시스템이 조사)
  ⓒ 명시적 기존 정책(IntentPolicy 1-35)·삭제 커밋·호출부 0·테스트/설정 제거·대체 명시가 전부 갖춰져 결론이
    하나 → verifier-resolved(질문 없음)
  ⓓ deprecated/superseded/tombstoned가 모두 타당하게 남을 때만 → intent-choice
④tombstoned/superseded 복원: intent-choice 존치 ⑤merge류: 1-13(3단 사다리). 근거: 지시 §0+§7+선행 합의
(2026-07-07)+사용자 후속 지시(2026-07-11 — 본 항 ③의 완화는 v1 'tombstone 확정=항상 사람' 합의를 사용자가
직접 두 번째로 개정한 결정).

1-28. **blocked-conflict 해제 = 동일 evidence matrix 재검사 통과 시(재검증 지적 #9).** 파일 변경 감지는 재조사
트리거일 뿐 해제 조건이 아니다. integrity 버스에 ack 불가 kind로 노출, 재검사에서 모순 소멸 확인 시에만 제거.

1-29. **identity 이원화(3차 재검증 반영): 물리 쓰기 잠금 키 = realpath(worktree)만**(같은 파일에 브랜치별
잠금 2개가 생기면 checkout 직후 상호 배제가 깨짐 — 잠금은 물리 파일 단위), **큐·WAL·pending namespace =
realpath+git-common-dir+branch(detached면 HEAD)**(브랜치 간 제안 혼입 방지). normWs만으로는 junction·symlink
별칭이 다른 잠금을 만들므로 realpath 해석을 추가. 비-git 프로젝트는 realpath(폴더) 단일 identity.
workspace는 부가 메타.

1-30. **P2 구현과 활성화 분리(재검증 지적 #10).** P2에서 pipeline을 구현하되 **자동 적용 활성화는 P3b의 원자적 cutover(권위
marker 활성+legacy 쓰기 동결 — 22차 재배열로 P3a 준비→P4 reader 완비→P3b cutover 순)와 함께 켠다** — P2~P3 사이에 '새 pipeline은 적용을 시작했는데
legacy 확정층 쓰기도 계속되는' 권위 우회 기간을 만들지 않는다.

1-31. **지도 세대 정체성(3차 재검증 반영).** topology에 **mapId(UUID)**를 두고 patch·decision·sig↔UUID
바인딩·WAL 레코드 전부에 mapId를 결속한다. topology 삭제 후 재생성은 새 mapId — 저장소의 applied decision
로그·바인딩이 이전 세대를 참조하는 것을 새 지도가 자기 이력으로 오인하지 않게 하고, 세대 전환은
replacesMapId(또는 reset decision)로 기록한다.

1-32. **verify-guard의 자동/수동 topology 변경 구분은 '산출물 일치'로 구현한다(3·4차 재검증 반영).** guard의
관측 입력(git status 경로·mtime)으로는 변경 주체를 알 수 없다. **applied decision에 topology의 before/after
내용 지문+생성 뷰(MAP.md) 지문을 기록하고, 현재 파일 내용이 그 기록 산출물과 정확히 일치할 때만 검증 트리거에서
제외한다.** 자동·수동 변경이 섞이면(불일치) 전체를 검증 대상으로. **marker 스키마(17·19·20차 정합 — 실제 합타입): `{decisionId, decisionFileAfterHash, policyArtifact: null |
{kind: "intent-policy"|"policy-revocation", id, fileAfterHash}}`** — policyArtifact가 있으면 세 내부 필드는
전부 필수(부분 상태 금지 불변식: kind 없이는 .json/.revoke.json 경로 판별 불가, 손상 marker가 정상 비정책
marker로 오인되면 복구·guard가 구현마다 갈라짐). kind로 파일 종류·경로를 판별(decision op 재판독 불요). decision 저장 파일(1-19 개정: decision별
독립 파일) 자체는 자기 after-hash를
자기 레코드에 담을 수 없으므로(4차 지적 #4) 별도 계약: 로컬 WAL의 최근 applied marker(decisionId+로그 파일
after 내용 지문)를 guard가 대조해 '이번 pipeline append분'만 제외하고, marker 불일치(수동 편집·혼합)는 검증
대상.** 릴리스의 dirty-worktree 중단은 이와 무관한 별도 계약이며 이 구분으로 해소되지 않음(자동 생성물은 커밋
전 릴리스 불가 — 정상 동작).

1-33. **bootstrap 후 의미 보강 자동 연속성(사용자 후속 지적 2026-07-11 — 없으면 'MAP 파일 자동 생성'은 되지만
'살아 있는 구조 MAP 자동 생성'이 아니게 됨).** bootstrap(결정론 draft) 완료 시 **동일 mapId에 semantic-enrichment
작업을 자동 큐잉한다 — 사용자 별도 명령 없음.** 현재 선택된 provider가 없거나 미준비면 semantic-enrichment-pending
으로 보존하고, **readiness가 성립하는 순간 자동 재개.** 기본 설정에서는 self typed adapter(1-26) 사용. 동일
동일 mapId+authorityHash(정책을 참조하는 보강이면 mapId+decisionContextHash — 22차 정합)에 대해 중복 보강
실행 금지(멱등). **draft 생성만으로 usable 상태를 선언하지 않는다** —
usable-draft→usable 전이는 의미 보강+검증을 거친 confirmed subgraph가 생겨야 한다.

1-34. **provider readiness 행렬과 라우터 규범 판정표(사용자 후속 지적 — P7/P8 구현자의 재해석 금지).**
- `economyReady = DeepSeek 설정 존재 AND 설정 지문 일치 AND typed capability probe 통과`
- `precisionReady = Codex binary/home 준비 AND session-role-registry 정상 AND (Scout 세션 연결 OR 고아 방지
  계약(1-9)을 갖춘 1회 자동 생성 가능)` **[개정 2026-07-23 — P6이 사용자 결정으로 --ephemeral 무잔재 1회 실행이
  되어 상시 Scout 세션·registry 대상이 소멸: 개정 정의는 말미 'P7 상세 설계'(최신판 — 현재 v4) P7-2 참조(원문은 이력 보존).]**
- `selfReady = Claude CLI 실행 가능 AND self typed adapter 배포됨`(15차 반영 — P5에서 성립. **P1~P4 동안
  기본 self의 의미 보강 큐는 semantic-enrichment-pending 보존이 규범이고, P5 배포로 selfReady가 성립하는
  순간 1-33의 자동 재개가 발동한다** — 큐잉(P1)과 실행 가능 시점(P5)의 Phase 간극을 이 계약이 잇는다.)
- `autoReady = economyReady AND precisionReady` — 아니면 자동형 선택 불가(사유 표시).
- **사용자가 선택한 모드를 조용히 다른 provider로 바꾸지 않는다. readiness 상실 시 degraded 상태+이유 표시.**
- 라우터 규범 표(P8에서 재해석 불가): mapped corridor(1-6 node 소속 기준)→경제형 / topology delta→정밀형 /
  경제형 결과의 스키마·근거·ID 실패→정밀형 승격 / 두 provider 충돌→**Verifier 역할 세션의 adjudication
  (1-4의 부작용 없는 경로 — Scout 세션의 자기검증·모델 투표 금지)** / Verifier도 단일 결론 불가→
  needs-investigation 또는 intent-choice.
- **승격의 모드 경계(15차 반영): '경제형 실패→정밀형 승격'은 자동형에서만.** 사용자가 경제형을 명시 선택한
  경우 실패는 승격이 아니라 needs-investigation 파킹+degraded 사유 표시('조용한 전환 금지'의 관철 — 승격도
  전환이다). 정밀형 명시 선택의 실패도 동일(다른 provider로 조용히 대체하지 않음).

1-35. **Intent Policy Memory — 사용자 철학의 재사용층(사용자 후속 지적: '사용자는 방향을 한 번 정하고, 하네스가
그 철학을 이후 판단에 적용한다'의 실체. 없으면 같은 intent-choice 카드가 반복 생성돼 사람이 다시 MAP 관리자가 됨).**
- intent-choice는 단일 patch 결정뿐 아니라 **재사용 가능한 프로젝트 정책(IntentPolicy)으로 저장할 수 있다**:
  `{ policyId, mapId, scope: project|subgraph|entity(one-shot은 아래 — 파일로 저장하지 않음),
  scopeTarget?(entity/subgraph면 대상 UUID 목록 필수), **predicateExpr{version, kind, ...}(22차 — 사용자 지적
  ⑥: 자유문장 predicate 금지 — 자연어면 매번 LLM이 해석해 재사용 결정성이 사라진다. tagged typed expression만
  자동 매칭, canonical expr은 policyFp/policyFrontierHash에 포함. 전체 DSL은 P9 설계 게이트에서 고정)+
  predicateDescription(사람용 설명 — 자동 판정 입력으로 사용 금지. 미지원 predicate는 자동 매칭 없이
  needs-investigation)**, chosenMeaning, exclusions, createdFromDecision, VerificationBasis,
  supersedesPolicyIds?: UUID[](17차: 복수 head 일괄 종결 — 단수면 충돌 정책 중 하나만 닫혀 같은 카드 반복),
  active }`
- **frontier 유효 leaf 규칙(17차 확정 — 결정론): 유효 정책 = active AND '자신을 supersede하는 정책이 존재하지
  않음'(supersede는 successor의 이후 철회와 무관하게 영구 — inactive successor가 생겨도 옛 정책은 부활하지
  않고, 부활은 새 create로만) AND '자신을 대상으로 한 revocation record 없음'.**
- **scope 중첩 우선순위(17차 확정): 특이도 순 — entity > subgraph > project.** 더 구체적 scope의 유효 정책이
  이긴다. 같은 특이도에서 chosenMeaning이 갈리면 frontier conflict → 정책 supersession intent-choice.
- **intent-choice 카드 생성 전에**: ①적용 가능한 IntentPolicy 탐색 ②정확히 일치하는 활성 정책이 있으면 자동
  적용(applied decision에 actor=user-choice의 위임 실행으로 기록·policyId 참조 — 감사 가능) ③동일 scope에서 유효한
  정책들이 서로 다른 chosenMeaning을 내면 **'정책 supersession을 고르는 intent-choice' 단일 경로**(16차 확정 —
  blocked-conflict는 코드 evidence 재검사로만 해제되는 상태라 정책 의미 충돌을 넣으면 영구 파킹됨. 사용자
  선택이 새 immutable policy를 생성해 frontier를 갱신하는 것이 유일 종결) ④정책이 없을 때만 카드 제시.
- 사용자 선택 UI에 적용 범위 선택 동반: '이번 항목에만' / '이 기능축에 같은 원칙' / '이 프로젝트에서 같은 상황에
  계속'. **'이번 항목에만'(one-shot)은 정책 파일을 만들지 않는다(18차 확정)** — 그 선택의 applied decision만
  남기고 재사용 탐색 대상이 아니다(파일로 남기면 active 유효 leaf로 남아 동일 조건 후속 patch에 반복 자동
  적용되는 반례 — '이번만'의 의미 위반).
- 저장 위치: `project-map/policies/<policyId>.json`(저장소 공유 — decision과 같은 이유). node/edge의
  decisionLocks는 정책 참조 ID를 가질 수 있다(미래 node·전역 규칙에는 policy가, 특정 entity에는 lock이).
- 정책 집합은 결정 '분류기'의 입력이지 권위 상태가 아니다 — authorityHash에 넣지 않고, 정책의 효과는 그것이
  만들어낸 applied decision을 통해서만 권위에 반영된다(순환·이중 권위 방지).
- **정책은 불변(immutable) 버전이다(15차 확정): 제자리 변경 금지 — 내용 변경은 supersedesPolicyIds로 새 파일.**
  entity|subgraph scope는 **scopeTarget(대상 UUID 목록) 필수 필드**로 적용 범위를 typed로 확정한다(predicate
  문구만으로 범위 확정 불가). decisionLocks가 policyId를 참조하므로 제자리 변경을 허용하면 같은 authorityHash
  아래서 잠금 의미가 바뀐다 — 불변 버전이 이를 차단.
- **CAS 결속(15·16차 확정): read-set에 ①분류 시 참조한 각 정책의 canonical 전체 내용 지문(policyFp)뿐 아니라
  ②effective policy frontier — 참조 정책에 '활성 superseder가 없었음'이라는 음성 조건과, 같은 scope/predicate에
  적용되는 정책 집합의 canonical 해시 — 를 함께 결속한다.** 정책이 불변 파일이므로 fp(A)만으로는 'B가 A를
  supersede함'을 감지할 수 없다(16차 반례: A 파일 불변→fp 불변→폐기된 의미로 CAS 통과). frontier 해시가
  바뀌면(새 정책 생성·supersede) 해당 pending patch는 read-set 파손으로 stale-expired/재검증.
- **트랜잭션 결속(15차 확정): '계속 적용' 선택의 정책 파일 생성은 그 선택의 applied decision과 같은 WAL
  체인이며, 1-19의 WAL 필드·내구 상태·marker에 정식 편입된다**(1-19 참조 — decision만 있고 policy 없음=같은
  카드 재생성, policy만 있고 decision 없음=근거 없는 위임 정책이라는 분리 상태 금지).

## 2. 단일 정본 확정 (P0 결론)

**현재 구조 지식 권위 4곳(전부 실측):**
① `docs/MAP.md` 확정층 — scope-reconcile approve가 쓰고(실쓰기 195-203) 대시보드 export(extension.ts
  2236-2252)가 append하며 collectCommon이 신뢰 입력으로 읽음(scope-package.js 164-166)
② 관찰 장부 trusted lane 자연어 — §7.5 꾸러미 주입·couplings·scoutHealthLine(contract-lib 1245·1253)
③ Impact Map ⑥ patch 후보 — extractMapPatches(860-889)
④ `project-map/topology.json` — 현재 draft 전용·'확정층 권위 불침' 명문(v1 경계)

**v2 권위 배치(고정):**
- `topology.json` = 유일 구조 정본. 단 **부분 권위** — confirmed subgraph만 라우팅·게이트의 권위 입력.
- 관찰 장부 = 증거·역사·반박·복권층(이벤트 15종·유도·트림 유지, 정본 역할만 회수).
- Impact Map(scouts/) = 단기 영향 후보(무변경 유지).
- `project-map/MAP.md` = 생성 뷰. `docs/MAP.md` = legacy 이관 소스(P3a 이관 준비→P3b cutover에서 동결·재배선 — 1-22).
- 어휘 분리: "MAP 장부/확정 교범"(docs/MAP.md 축)과 "Project MAP"(topology 축)을 문서·UI에서 명확히 구분 표기.

**정체성**: topology=불투명 UUID(불변), 장부=자연어 sig(legacy), 연결=sig↔UUID 바인딩(1-24).
**잠금·큐 identity**: 1-29의 canonical identity. **pending 큐 네임스페이스 = canonical identity + mapId까지만
(10차 지적 #2 — baseAuthorityHash를 네임스페이스 키로 쓰면 patch A 적용 후 같은 base의 patch B가 옛 hash
칸에 고립돼 재기반 로직에 도달 불능). baseAuthorityHash는 각 patch의 메타(신선도·재기반 판정 재료)로만.**
지시의 '브랜치·MAP hash별 분리'는 교차 오염 방지 의도이며 canonical identity(브랜치 포함)+mapId 분리로 충족.

## 3. MAP_SCHEMA_VERSION 2 스키마와 typed operation 계약 (P0에서 고정)

**v2 스키마 변경(3·4차 재검증 반영 — '연산이 참조하는 필드는 스키마에 실재해야 한다'):**
- node 추가: `description?: string`(라벨과 분리된 서술), `decisionLocks?: Array<{kind:"literal", text} |
  {kind:"policy-ref", policyId}>`(22차 — 사용자 지적 ⑤: 문구와 정책 ID를 한 string[]에 섞으면 소비자가 추측 —
  typed graph 철학 위반. **policy-ref는 해당 정책 계보의 effective frontier를 따라 해석하고, dangling·충돌 시
  잠금을 조용히 제거하지 않고 degraded+needs-investigation. 이 판독 캐시 키=decisionContextHash.
  렌더 확정(24차): MAP.md에는 불변 원시 참조({kind:policy-ref, policyId})만 표시 — MAP.md 렌더 키가
  authorityHash라서 effective 해석을 표시하면 정책 supersede 후 낡은 의미가 남는다. effective 잠금 의미의
  표시는 decisionContextHash를 키로 쓰는 표면(대시보드)에서만.**)(설계 금지·잠금 —
  merge 동형 비교·slice 동봉·사람용 뷰의 decision lock 표시 재료), `provenance?: { verifiedAtHead: string;
  decisionId: string }`가 아니라 **`provenance?: { basis: VerificationBasis; decisionId: string }`**(5차 정정 —
  1-1의 세 타입 중 저장소 공유용 VerificationBasis만 사용, 로컬 절대경로 유출 금지. 정본은 applied decision
  레코드이고 여기엔 참조만, evidence 내용 지문은 decision 레코드가 보유). **참조 무결성 규칙(5차 지적 #2):
  freshness/스키마 검증이 provenance 참조를 검사한다 — ①decisionId가 applied decision으로 실존 ②같은 mapId
  ③해당 node/edge를 실제 변경·검증한 decision ④decision의 evidence 지문이 현재 basis와 정합. **강등은 '유도'다
  (6차 지적 #1 확정): dangling(브랜치 병합·로그 손상·topology 단독 복사) 검사는 topology를 절대 직접 수정하지
  않는다 — 판독 시점 유도(7차 정정: **강등은 저장값이 confirmed일 때만** — bootstrap candidate는 provenance가
없는 것이 정상이므로 candidate/unknown은 그대로 통과, coverage의 3분 집계 의미 보존):
`effectiveConfidence = storedConfidence !== "confirmed" ? storedConfidence : (provenance 유효 ? "confirmed" : "unknown")`
  **소비 계약(8차 확장): 권위(confirmed subgraph·slice·라우터·게이트)뿐 아니라 사용자 표면(graphCoverage·
  MAP.md 렌더·대시보드 confidence/coverage·건강도 통계)도 전부 effectiveConfidence를 소비한다** — 내부 제어와
  표시가 다른 사실을 말하면 '거짓 정상 표시 금지' 위반. 렌더러·coverage 계산기는 topology 단독이 아니라
  applied decision 색인(또는 사전 계산된 effective projection)을 함께 받는다. decision 로그 판독 실패 시
  confirmed로 폴백하지 않고 effective unknown+degraded 사유 표시. 감사 표면에서 저장값을 보여줄 땐
  'stored confirmed → effective unknown(provenance dangling)' 식으로 두 값을 명시 구분. 끝단 테스트 계약:
  stored confirmed+dangling decision → 라우터 제외·coverage unknown·MAP.md unknown/경고.**
  **권위 상태 서명(9차 지적 반영 — effective 상태는 topology 단독 함수가 아니므로 mapHash만으론 무효화 누락):**
  `decisionIndexHash = hash(이 mapId 소속 유효 applied decision들의 AuthorityDecisionProjection canonical 색인)`,
  `authorityHash = hash(mapHash + decisionIndexHash)`.
  **AuthorityDecisionProjection(10차 지적 #1 — 해시 순환 차단): decision 레코드 중 effective confidence를
  결정하는 권위 필드만 — decisionId·mapId·operation·대상 entity·VerificationBasis·evidence 내용 지문·판정
  결과. 감사 필드(MAP.md 지문·topology before/after 지문·authorityHashAfter·timestamp·표시 메타·WAL/guard
  marker)는 projection에서 제외** — 안 그러면 decision이 MAP.md 지문을 담고 MAP.md가 authorityHash를 담고
  authorityHash가 decision을 담는 계산 불능 고정점이 생긴다. 쓰기 순서: ①projection으로 authorityHash 계산
  ②그 값으로 MAP.md 렌더 ③MAP.md 지문을 decision의 '감사 필드'에 기록(색인 제외분이므로 순환 없음).
  **이중 해시 분리(22차 — 사용자 지적 ②: 정책은 authorityHash 밖이라 정책이 바뀌어도 분류·라우팅 캐시가
  갱신되지 않던 공백):**
  `policyFrontierHash = hash(이 mapId의 유효 IntentPolicy frontier의 canonical 의미 필드 전체+revocation
  레코드 내용 — ID 목록만이 아니라 내용 포함이라 파일 손상·변조도 캐시를 무효화)`,
  `decisionContextHash = hash(authorityHash + policyFrontierHash)`.
  사용처 분리: **authorityHash** = confirmed subgraph 권위·구조 coverage·구조 provenance·MAP.md 구조 정합 /
  **decisionContextHash** = 분류기·라우터 캐시·IntentPolicy 탐색·intent-choice 중복 억제와 선택 적용
  CAS(1-14)·정책 포함 slice. 정책을 authorityHash에 넣는 방식은 기각(구조 권위≠사용자 정책 분리 유지).
  **decisionContextHash 불일치는 즉시 폐기 조건이 아니라 read-set 기반 재기반 진입 신호**(무관 정책 변경으로
  기아 방지 — 1-1과 동형). base/expected decisionContextHash는 AuthorityDecisionProjection과 policyFrontierHash
  입력에서 제외(해시 순환 방지 — 감사 필드 취급).
  적용: effective projection·MAP.md 구조부·coverage 키=authorityHash / Verifier 결과·intent-choice
  결속=baseDecisionContextHash / patch read-set에 관련 entity의 decision 색인 지문+참조 정책 frontier
  지문 포함(관련 한정 — 무관 append 격리) / MAP.md 머리말은 mapHash와 authorityHash를 구분 표시 / decision·
  policy 파일 변경으로 각 해시가 바뀌면 기존 산출물 재검사. (정본을 즉시 고치면 유일
  쓰기 경로·CAS를 스스로 우회하고, 진단만 하고 소비처가 저장값을 읽으면 dangling이 권위로 남음 — 유도 소비가
  유일한 정합 해법.) 저장된 confidence의 실제 정정은 별도 repair patch를 정상 pipeline으로. 이것이 confirmed의
  권위 조건이다.**
- edge 추가: `decisionLocks?`(node와 같은 tagged union), `provenance?`(node와 동형). (edge에는 label/roles/authority가 원래
  없고 v2에서도 추가하지 않는다 — authority는 node의 roles(authority/gate)로만 표현.)
- node 제거: `lastSeenAt`(휘발 관측치 — 하네스 로컬 freshness 저장소로 이동, 1-2).
- 루트 추가: `mapId: string(UUID)`, `replacesMapId?: string`(세대 전환 — 1-31).
- **도입 시점(4차 지적 #3): 루트 스키마 v2(mapId 포함)와 v1→v2 결정론 마이그레이터는 P0.5로 선행** — P1
  bootstrap이 처음부터 v2를 생성해야 세대 결속이 성립. P2에는 patch/decision 계층 마이그레이션만 남긴다.
- pending의 구 op 변환표: retire_candidate→tombstone_candidate 개명 흡수, 변환 불가 pending은 stale-expired.

**op 계약 — 기존 8 op 중 7 유지+retire_candidate 개명 1+신설 10+정책 op 3 = 계 21(17차 반영):**
정책 op 3종(17차 지적 #1 — 정책 변경을 topology op의 부수효과로 숨기면 의미 단위 op·원자성·복구 원칙 위반):

| op | 대상 | payload 핵심 | inverse | 분류 |
|---|---|---|---|---|
| create_intent_policy | (신규 policyId) | 정규화 IntentPolicy 사본 전체 | revoke_intent_policy | 사용자 선택의 산물만(intent-choice 경로의 산출 — 자동 생성 금지) |
| supersede_intent_policy | 대상 policyId 복수 | 새 정책 사본+**supersedesPolicyIds: UUID[]**(복수 head 일괄 종결) | 이전 frontier 기록 복원 불가 — 새 create로만(감사용 이전 frontier 스냅샷 보존) | 사용자 선택의 산물만 |
| revoke_intent_policy | 대상 policyId | **별도 불변 revocation 레코드 생성**(18차 확정): `project-map/policies/<revocationId>.revoke.json` = {revocationId(UUID), targetPolicyId, reason, createdFromDecision} — 기존 정책 파일 무변경(불변 계약 유지). WAL은 kind:policy-revocation artifact(1-19 ⑥), marker는 policyArtifact={kind:"policy-revocation", id:revocationId, fileAfterHash:revocation 파일 after 지문}(1-32 합타입 — 20차 정합), frontier 해시 계산에 revocation 파일 포함(관측 가능성) | 재활성 없음(부활은 새 create로만) | 사용자 선택의 산물만 |

정책 op의 semantic validation은 아래 '증거 이층 분리'의 op별 계약을 따른다(23차 — create는 기존 대상이 없고
supersede/revoke는 frontier·revocation 검사가 필요하므로 '대상 실존·불변성' 단일 요약은 오도). **정책 op decision은 decision 파일로 기록하되
AuthorityDecisionProjection 색인에서 제외한다**(정책은 authorityHash 밖이라는 기존 확정과 정합 — 정책 변경의
CAS 효과는 read-set의 frontier 해시를 통해서만 전파). policy-only WAL도 1-19의 6단 계약을 따른다.
공통(topology op): evidence 최소조건(code/test/config ≥1)·rationale·inverse(또는 복구 정보)·origin 결속(1-1)·
read-set(1-1). **증거 이층 분리(22차 — 사용자 지적 ④): 정책 op에는 code/test/config 강제가 모순이다(순수 제품
철학 변경·철회는 코드 근거가 아직 없을 수 있음 — '사용자 선택 자체가 정책 권위의 근거'). 계약:**
- **topology op**: 위 공통 그대로 — 지도·문서·정책 문구만으로 구조 변경 금지.
- **정책 op**: `authorizationRefs[]`(user-choice/intent-decision/policy-ref — **기존 evidence[]와 별도 배열.
  EVIDENCE_KINDS에 동급 추가 금지: 사실 근거 통로에 섞으면 topology op의 최소조건을 policy-ref 하나로 우회**)
  + op별 요구 — create=createdFromDecision 필수+신규 ID 부재 확인 / supersede=대상 ID 전체+각각의 policyFp+
  frontier 해시 / revoke=대상 ID+policyFp+기존 revocation 부재 확인. 촉발한 구조 사건이 있으면 그 code/test/
  config evidence를 '함께 연결'(선택). 순수 제품 정책·철회는 코드 증거 없이 허용.
- **이층 규칙: 정책 자체의 유효성=사용자 선택으로 성립 / 그 정책이 이번 코드에 적용된다는 판단(자동 유도된
  개별 topology patch)=다시 code/test/config 증거+Verifier 검증.**

| op | 대상 | payload 핵심 | inverse | 기본 분류 |
|---|---|---|---|---|
| split_node | 원본 node | newNodes[](신규 UUID·label·구성요소 배분: anchors/evidence/conditions 분할표)·edgeReroute[](기존 edge→어느 신규 node로) | merge_node(분할표 보존) | verifier-resolved 가능 |
| split_edge | 원본 edge | newEdges[](conditions 배분) | merge_edge | verifier-resolved 가능 |
| merge_node | 원본 node 2+ | survivorId·absorbed[](anchors/evidence/edges 재지향표)·alias 기록 | split_node | 1-13 3단 사다리: 동형 증명=verifier-resolved / 실패=needs-investigation 선행 / 양쪽 타당+구조 결정 필요 시만 intent-choice / 불필요=resolved-noop 종결 |
| merge_edge | 원본 edge 2+ | survivorId·absorbed[] | split_edge | 1-13 3단 사다리(동상 — 불필요=resolved-noop) |
| widen | node/edge | 확대분(anchors/conditions 추가)·expect(현 범위)·음성 조건 read-set(1-1) | narrow(추가분 제거) | verifier-resolved 가능 |
| narrow | node/edge | 축소분(제거 대상)·expect·조건부 잔존 | widen | verifier-resolved 가능 |
| supersede | 구 node/edge | successorId·expect(구 상태)·lifecycle→superseded | set_state 복원+관계 제거 | 명백 시 verifier-resolved |
| tombstone_candidate | node/edge | expect·근거(호출부 소멸 등) — **topology 무변경 '조사 제안' op(4·15차 정합): 조사 결과 결론이 하나면 파생 set_state(lifecycle) patch로 실체화(verifier-resolved), 복수 의도가 남으면 intent-choice 카드 생성 후 선택 시 실체화**(구 retire_candidate 흡수. topology에 후보 표시 필드 없음 — 후보는 파이프라인 상태) | 카드/제안 철회(topology 무변경) | **1-27③ 3층**: 감지(proposed 단계·결정 상태 아님)→needs-investigation 선행→정책·증거로 결론 1개면 verifier-resolved·복수 타당 시만 intent-choice |
| change_steward | node | to·expect(현 steward) | 역방향 | intent-choice(authority 경계) |
| change_authority | **node 한정** | roles의 authority/gate 변경 to·expect(스키마상 edge에 역할 없음) | 역방향 | intent-choice |
| rewrite_label | **node=label/description·edge=notes** | to·expect | 역방향 | 의미 불변 시 verifier-resolved·의미 변경이면 intent-choice |

targetId 계약: 생성 op(add_node/add_edge)=금지, split/merge=원본 targetId(s)+신규 UUID 목록 동시(이분법 폐지),
나머지=필수 UUID. 전 op payload는 PAYLOAD_KEYS 화이트리스트+무사망 진단 계약 동수준. 분류는 op 이름이 아니라
(증거로 가능한 결론 수, 제품 의도 필요, 코드↔문서 충돌, 가역성, authority 경계) 입력의 신설 분류기 — 표의
'기본 분류'는 출발점일 뿐 증거가 뒤집는다(지시 §7).

## 4. 결정 상태 5종 (재설계 고정)

| 상태 | 판정 주체 | 진입 | 종결 |
|---|---|---|---|
| auto | 결정론 코드 | 관측 사실(evidence/anchor 추가·명백 rename·재료 갱신) | 즉시 적용 |
| verifier-resolved | Codex Verifier(typed·claim 결속 1-5) | 의미 판단 필요·결론 1개 | 자동 적용(decision actor=verifier) |
| needs-investigation | 시스템 | 스키마 실패·근거 부족·②b 실패 | 상한 도달→unresolved 파킹 / read-set 파손→stale-expired |
| intent-choice | 사용자(사람 언어 카드) | 복수 제품 의도 | 선택→자동 적용(의미 변화 시만 재카드) |
| blocked-conflict | 시스템 | 코드·테스트·설정의 실제 모순 | evidence matrix 재검사 통과 시 해제(1-28) |

## 5. Phase 재배열 (실행 순서 고정)

- **P0** ✅ 이 문서(권한 충돌 분석·단일 정본 확정·op 계약·v1 개정표).
- **P0.5** 배포 가능한 공용 런타임(1-15): scope-map 계열의 bridge/ 승격 + **루트 스키마 v2(mapId·description·
  decisionLocks·provenance·lastSeenAt 제거)와 v1→v2 결정론 마이그레이터**(4차 지적 #3 — P1 bootstrap이 처음부터
  v2를 생성해야 세대 결속 성립).
- **P1** 비차단 bootstrap 생명주기: 트리거 5종(재정의 포함)→**완료 시 의미 보강 자동 큐잉(1-33 — 사용자 명령
  없이 usable까지 연속)**→detach 기동·자식 wx 선점(P1 설계검증: 부모 claim이 아니라 '선점자가 직접 작업' —
  훅 부모는 spawn만, 자식이 run-state를 wx로 선점해 무거운 스캔은 정확히 1회)·run-state(pid 검증)·
  **verify-guard의 project-map 예외는 P1에선 bootstrap run-state 지문 일치 기반(1-32 marker의 선행 형태 —
  릴리스 dirty 중단에는 미적용)**·
  degraded 고지·2트랙 3중 게이트(writeCanonicalLocked의 mkdir 선행 부작용 수정 포함)·informed consent+PRIVACY 선갱신.
  **P1 운영 복구 계약(검증 9차 확정)**: 잠금·상태 파일의 수동 rm 안내 금지 — 유일 공식 표면은
  `scope-map <repo> force-unlock`(.funlock 하 재판독→격리[rename, 감사 흔적 보존]. .funlock은 childClaim과 forceUnlock이 '실제로
  취득'하는 공용 mutex — 선점 전이·격리 작업 전체가 같은 잠금 아래 실행돼 검증→격리 사이에 새 잠금·상태가
  생기지 않는다. 잔재 회수는 unlink가 아니라 고유 격리명으로의 원자 이동이며, 이동 성공자만 취득을 시도하고
  이동해 온 파일을 재검증한다 — 오탈취는 즉시 원위치 복원+보고 후 물러나며, 복원 rename이 새 취득을
  덮는 창은 '취득 직후 read-back'+'임계구역의 모든 상태 변경 직전 funlock 소유 재검증(fencing)'이
  대부분 검출하며, funlock을 잃은 주체는 다음 상태 변경 '검증 시점'에 물러난다(검증 통과~쓰기의 시스템콜
  간극은 아래 보장 수준 참조 — '차단'이 아니라 '검출·물러남'이 정확한 계약이다).
  **보장 수준(명문)**: rs 기록(writeRs)도 같은 funlock 아래에서 runId 확인+교체를 수행한다. 파일시스템
  프리미티브(wx·rename·unlink)만으로는 '검증과 쓰기'를 단일 원자 연산으로 묶을 수 없으므로, 검증 통과와
  해당 쓰기 사이의 시스템콜 간극은 남는다 — 이는 저장 계층 fencing token이나 OS 배타 잠금 없이는 어떤
  파일 기반 잠금(업계 표준 구현 포함)도 공유하는 한계이며, 본 설계는 그 간극의 발생 조건을 '복수의 수동
  force-unlock이 stale 스냅샷으로 동시 실행되고 그 마이크로초 창에 선점이 겹치는 3자 경합'으로 좁히고,
  발생 시에도 잃은 쪽은 다음 검증에서 물러난다. 다만 이는 정상 협력 경로의 수렴 성질이며, 명시 승인된 강제복구 경합에서는 stale 기록 가능성을 배제하지 않고 후속 상태 판독·복구(표면화→회수)로 수렴한다 — 저장 계층 보장이 아니다.
  이 이상의 보장이 필요해지면 네이티브 OS 잠금 의존성 도입이 선행 조건이다(현 배포 모델에선 비채택)[정상 협력 경로에서 오격리 방지 — 예외 경합은
  표면화·회수로 수렴]. 죽은 funlock 잔재는
  force-unlock이 재확인 후 자체 회수하고, 손상 funlock은 --confirm-corrupt 승인 격리[탈출구]). 승인 사다리:
  죽은 보유자(dead-valid)=즉시 / 손상(invalid)=`--confirm-corrupt`(활성 작업 부재를 운영자가 확인 — '정확히
  1회' 계약의 책임이 이 승인 경로에서 운영자로 이전) / pid 판별 불가(owner-unverified)=`--confirm-owner-dead`
  (OS 수준 프로세스 부재 확인 — 영구 정지 탈출구) / alive·unreadable=항상 거부. 손상 run-state는 수동
  bootstrap도 자동 교체하지 않는다(활성 작업자 병존 차단). childClaim은 활성 funlock을 존중한다.
- **P2** patch pipeline 구현(활성화는 P3b cutover와 동시 — 1-30): 로컬 prepared WAL+저장소 decisions/ 독립 파일(1-19)·CAS
  재설계(1-1)·②b·신설 op 스키마(§3)·patch/decision 계층 마이그레이션(op 변환표)·5상태 분류기·apply별 로컬
  스냅샷 보관(1-18 재료).
- **P3a** 권위 전환 '준비'(22차 재배열 — 사용자 지적 ③: 쓰기 권위만 새 지도로 넘기고 읽기 일부가 legacy를
  보는 창 금지): legacy 이관(dry-run→candidate 추출→멱등 매칭)·sig↔UUID 바인딩(1-24)·기존 writer/reader의
  v2 어댑터 구현 — **권위 marker는 비활성 유지, 기존 경로 계속 작동.** legacy writer/reader의 실제 분포:
  내보내기(extension.ts 2236)·approve(scope-reconcile.js 195) / 대시보드 판독(extension.ts 1894)·
  collectCommon(scope-package.js)·동봉(contract-lib buildScoutAttach).
- **P4** freshness(로컬 재료 저장소+공유 provenance 1-2·유도 판정기·신선도 권위 단일화)·slice 동봉(buildScoutAttach
  교체 — 이중 try 격리·echo 계약 이관)·**모든 소비 경로가 Project MAP projection을 읽을 수 있는 '공용 reader
  API' 준비**(대시보드·collectCommon·게이트·동봉 — P8 라우터는 아직 없으므로 '라우터 구현'이 아니라 P8이 이
  API만 소비하도록 계약 고정. marker 여전히 비활성).
- **P3b** 원자적 cutover(P4 완료 후에만 — 22차 확정): **등록된 모든 활성 reader가 v2 어댑터 준비 상태이고
  모든 legacy writer가 전환 가능함을 manifest로 검사 — 하나라도 빠지면 marker 활성화를 거부.** v2 topology
  유효·이관 결과·스냅샷/롤백 재료 확인 후 strict lock 안에서 권위 marker 활성화+legacy 쓰기 동결(내보내기/
  approve 재배선 1-22)+자동 적용 활성화(1-30)+서사 표면 스윕. 유일 정본 선언은 모든 읽기·쓰기 경로가 동시에
  바뀌는 이 지점이다.
- **P5** provider 공통 인터페이스: runScout→typed ScoutResult(무사망 계약)·self typed adapter(1-26)·deepseek
  probe(1-8).
- **P6** Codex Scout 독립 세션: session-role-registry(1-9)·Scout 전용 진입점(1-4)·두뇌 설정 독립(매 호출 주입).
- **P7** 모드 UI·readiness 행렬(1-34 — economyReady/precisionReady/autoReady, 조용한 전환 금지)·Scout 세션
  관리(segScout 확장 시 dirty/hold 연쇄 편입) **[개정 2026-07-23 — Scout 세션 관리는 P6 ephemeral 확정으로
  대상 소멸(소거): 말미 'P7 상세 설계'(최신판 — 현재 v4) 참조.]**
- **P8** 결정론 라우터 — 1-34 규범 판정표 그대로(재해석 금지)·라우팅 로그.
- **P9** intent-choice 카드(1-14)·**Intent Policy Memory(1-35 — 정책 탐색→자동 적용→카드는 최후)**·
  recovery-action 카드(1-18)·선택 후 자동 마무리.
- **P10** 통계·비용·건강도(scout-usage 확장·지표 분리).

각 Phase: 설계→양모델 독립 검토→구현→전체 테스트→Codex 검증→재판단→수정→재검증→로컬 설치→로컬 커밋.
버전 bump 금지(=패키지 버전. MAP_SCHEMA_VERSION은 마이그레이터 동반 상향 허용)·push 금지·마켓 금지.

## 6. 무회귀 계약 (2트랙·기존 축)

- 모든 신규 진입점은 scoutMode 게이트 최선행(소스 null+표시 이중 게이트) — MAP 파일 생성 0·Scout 세션 생성 0·
  ping 0·라우팅 0을 2트랙 끝단 테스트로 잠금.
- 미설정 프로젝트=빈 계약=기존과 100% 동일 보장(하네스 상태는 계약 파일이 아닌 별도 서랍).
- **verify-guard의 project-map/** 취급 계약: 1-32의 산출물 일치 계약을 따른다** — topology/MAP.md는 applied
  decision의 기록 지문과 정확 일치 시만 제외, decision·policy 파일은 로컬 WAL marker(양쪽 after 지문 결속 —
  1-19 6단) 대조로 이번 생성분만 제외,
  혼합·불일치는 검증 대상. 릴리스의 dirty-worktree 중단은 별도 계약(이 구분의 적용 대상이 아님 — 1-32).
- 기존 self/DeepSeek 팔·Impact Map 보관함·장부 이벤트 15종·트림 동형성·ledgerSig 패리티 쌍 보존.
- Scout 실행이 Verifier 타임아웃 창을 잠식하지 않게 별도 타임아웃 키.
- 사전등록 실측(70.5%) 비교 가능성: 꾸러미 형식 버전 기록+재기준선 측정 계획(사용자 합의 항목).

## 7. 사용자에게 남는 결정(제품 정책 — 구현이 묻지 않고 기록만)

- topology 라벨·MAP.md 언어 정책(권고: 라벨 언어 중립, MAP.md 단일본 — 언어별 뷰는 대시보드).
- ab-retro 재기준선 측정 시점(P3b cutover 완료 후 — 사전등록 변경 합의).
- (고지 사항) P3b cutover에서 docs/MAP.md 내보내기·approve가 Project MAP 경로로 전환됨 — 지시로 이미 확정된 정책이며
  재승인을 구하지 않는다(1-22).

## P4 상세 설계 (동결 v8 — 2026-07-19 · 설계검증 8왕복+확인 1회 완료[blocker 19·주의 2·보완 12 전부 수용] · ★구현 완료 2026-07-20: 증분 1=P2 확장 계층[3왕복]·증분 2=freshness 저장소+기준선 훅[14왕복]·증분 3=공용 reader·판정기·slice 동봉·게이트 준비·manifest[4왕복 — 통과] · 활성화(P3b cutover) 전 전 표면 비활성/위임 유지)

범위(§5 P4 원문): freshness(로컬 재료 저장소+공유 provenance 1-2·유도 판정기·신선도 권위 단일화)·slice 동봉
(buildScoutAttach 교체 — 이중 try 격리·echo 계약 이관)·공용 reader API(대시보드·collectCommon·게이트·동봉 —
P8은 이 API만 소비하도록 계약 고정). **marker 여전히 비활성 — 모든 소비처는 cutover 전 legacy 동작 무회귀.**

- **P4-1 공용 reader API** — `readMapProjection(repoRoot)` 단일 진입. **권위 단일 캡처(1차 blocker①)**:
  **withMapLock(기존 map lock) 안에서는 topology·decision index·policy frontier '원문 캡처+canonical 지문 계산'만 수행하고, anchor/evidence 실해시·freshness 계산·렌더·캐시 IO는 전부 잠금 밖에서 한다(4차 [주의] — 파일 해시를 잠금 안에서 하면 동시 apply가 40회×15ms 재시도 후 timeout하는 writer 기아). 이미 map lock을 보유한 콜백 안에서 public reader 호출 금지(재진입 불가).** 캡처는 같은 잠금 스냅샷(3차 blocker③: 권위 marker/receipt 세대 토큰만으로는 정상 P2 apply 중간[topology 교체↔decision 기록 사이]의 혼합 스냅샷을 못 막는다 — apply도 같은 잠금을 쓰므로 잠금이 원자성 경계). 잠금 획득 실패=조립하지 않고 `{ok:false, source:"error", reason:"lock"}`. 권위 세대(marker/receipt canonical 지문)는 잠금 진입 전후로 캡처·비교해 cutover 창을 차단 — 달라지면 폐기·재시도 1회 후 `{ok:false, source:"error", reason:"authority-flap"}`(3차 [보완]: ok:false는 source:"blocked"|"error" 둘뿐인 합타입 — source 없는 실패 반환 금지). 반환은 source별 discriminated union(2차 [보완] — 가짜 해시 금지): `ok:true·source:"v2"`={authorityHash, decisionContextHash, mapId, nodes[], edges[], approved[], degraded[]} 필수 / `ok:true·source:"legacy"`=legacy 데이터만(v2 해시=null 고정) / `ok:true·source:"none"`=빈 projection / `ok:false·source:"blocked"`=권위·legacy 데이터 모두 금지(사유만). 권위 세대 재검사 비교 대상=marker/receipt의 canonical 지문(generation token — authorityStateFor의 st/mapId 비교만으로는 불충분)
  — **node·edge 모두** effectiveConfidence(decisionIndexFor+effectiveConfidenceOf를 '동일 topology 스냅샷'에
  적용)·provenance 4검사(applied decision 실존·mapId·대상 entity·evidence 지문) 탈락분은 degraded 사유와 함께
  분리(1차 blocker④ — dangling decision edge가 slice·P8로 새지 않게). **blocked=권위 이력 존재·판독 불가
  상태로 별도 반환 — legacy 데이터 폴백 금지**(권위 역행 차단·소비처는 '판단 불가' 표시만). P8은 이 반환형만
  소비(라우터는 P8에서 구현·여기선 계약 고정). adapterManifest의 P4 표면 2개에 v2 함수 등록.
- **P4-2 freshness 재료 저장소(로컬 캐시·권위 아님 — 역할 강등, 1차 blocker③)** —
  `BRIDGE_DIR/map-freshness/<wsKey>.json` `{schema:"mfresh-1", mapId, auditSeq, entries:{"a:<nodeUUID>|<anchorRelPath>" | "e:<entityUUID>|<evidenceRelPath>":
  {fp,size,mtimeMs,seenAt,basisDecisionId?,seq?}}`(auditSeq=잠금 안 단조 counter·seq=a: 전용 감사 순번 — 증분 2
  구현 확정과 정합·직전 확인 검증 미반영분 동승 소화 2026-07-20). **역할·합타입 분리(5차 [보완])**: `a:` 항목='검증 전이에서만 생성되는 로컬 기준선'(fresh 판정 anchor축의 권위 재료 — '캐시' 아님·basisDecisionId 필수·누락 또는 현재 node provenance decisionId와 불일치=그 엔트리 미사용·축 unknown) / `e:` 항목+stat·seenAt='비권위 캐시'(fresh 증명 사용 금지 계약은 이쪽에만 적용·basisDecisionId 금지)}`. **캐시는 fresh 증명에 절대 사용 금지(2차 blocker① — git clean 목록 기반 재사용도 금지: ignored/untracked는 status에 안 나타나고 assume-unchanged/skip-worktree는 tracked 변경을 숨기며 인덱스 stat 최적화는 내용 증명이 아니다)** — 용도는 ①한 번의 reader 호출 안에서 같은 파일 중복 해시 회피(호출 내 메모) ②'stale'이라는 보수적 음성 힌트뿐. fresh 판정에 쓰이는 현재 fp는 항상 실제 파일 내용에서 계산한다. mtime+size 단독 일치로 fp를 재사용하지 않는다(동일 길이 치환+mtime 복원·거친 시간 해상도 반례). 손상=삭제 재생성(fail-open — 캐시)·mapId 불일치=전체 폐기·엔트리
  상한 2,000(축출 정책은 아래 구현 확정 참조)·TTL 스윕 비대상.
  **(증분 2 구현 확정 2026-07-19 — 구현검증 14왕복이 원안을 강화·정본 반영)**: ①감사 순서는 seenAt(시각)이
  아니라 **논리 순번 seq**(top-level auditSeq counter — 잠금 안 단조 증가·a: 기록마다 스탬프·시계 역행/ISO
  상한 무관·포화 시 상대 순서 보존 재번호화·counter 유실 시 엔트리 최대 seq 복구) ②상한 축출은 **비권위 e:
  우선**(권위 a: 기준선이 캐시에 밀려 소실 금지)·같은 종류 안 seenAt 오래된 순·영수증(wroteKeys)은 축출 후
  실존 기준 ③기준선 기록 실패는 **retry 사이드카**(빠른 회수)+**상시 자가 수리**(마커 없음 — 매 topology
  전이마다 저장소 vs provenance 차이로 재유도·원본=무GC 정본 decisions/·전체 검증기+권위 색인 ADP 지문
  결속·fp까지 대조·판독 예산[후보 상한+감사 예약]·감사는 seq LRU+방문 touch) ④판독은 무파괴(삭제·재생성은
  잠금 안 쓰기만)·a:는 권위(swap) 호출자 전용. 상세 계약=tests/p4-freshness.test.js 139단언이 정본. **동시 쓰기(5차 [주의] — 기준선 lost-update 차단)**: 이 파일의 모든 쓰기(P2 기준선 훅·reader 캐시 갱신)는 `<wsKey>.json.lock` 전용 잠금 아래 read-merge-write로 직렬화 — 잠금 실패=쓰기 포기(기준선은 다음 apply 전이에 재시도·캐시는 무해 skip·판정은 실해시라 정확성 불변). 경합·손상 삭제 경합 반례 테스트. **경로 경계(1차 blocker⑦)**: anchor/evidence 상대경로는
  resolve→realpath 후 repo 경계 내부 검증 — `../` 이탈·드라이브/UNC 절대화·symlink 이탈·NUL 포함은 판독
  거부(해당 노드 freshness=unknown·degraded 사유 기록·저장소 밖 stat/hash 0회 보장).
- **P4-3 유도 판정기(항상 읽기 시점 유도·비저장)** — `deriveFreshness(repoRoot, projection)` → node·edge별
  `{state:"fresh"|"stale"|"unknown", reason}`. **fresh는 두 축이 모두 불변일 때만(3차 blocker① — anchor와 evidence는 독립: anchor만 수정된 노드를 evidence 불변으로 fresh 오판하는 반례 차단)**: ⓐanchor축=node anchors의 현재 내용 지문==로컬 기준선. **기준선 신뢰 생성 계약(4차 blocker① — 최초 관측 흡수 금지)**: 기준선은 '해당 node의 provenance decisionId를 생성한 검증·apply 전이'에서만 기록(P2 apply 경로에 기록 훅 — reader는 기준선을 절대 쓰지 않고 읽기만·임의 최초 관측은 후보로도 승격 금지), basisDecisionId 결속(전역 authorityHash 결속 금지 — 무관 node의 decision이 타 node 기준선을 재기록하는 경로 차단), clone·기준선 부재=로컬 검증(apply) 전이 전까지 계속 이 축 unknown(fresh 주장 금지), P3b 이관 node의 최초 기준선은 만들지 않고 unknown 시작(cutover 잠금 내 대량 해시 금지 — 이후 apply 전이마다 채워짐). **기준선 지문의 출처 순서(5차 blocker — 'CAS 직후 외부 편집'을 사후 실해시로 흡수하는 반례 차단)**: ①decisionId 확정 후 살아남은 changedIds entity에 {basis: VerificationBasis, decisionId} provenance 주입(P2 apply 계약 확장 — 현행 applyOperationV2/pipeline은 미주입이므로 P4가 이 확장을 포함). **historyless 자기참조 해소(6차 blocker① — 현행 basisFp=mapHashAfter는 provenance 포함 해시라 순환)**: `structuralHashOf(topology)`=provenance 필드를 제외한 canonical 직렬화 해시를 신설하고, historyless VerificationBasis.basisFp는 이 structural hash로 기록(주입 전 계산 가능·순환 없음 — git 분기는 head가 독립 값이라 현행 유지). 판정기·provenance 4검사의 historyless 대조도 structural hash 기준. 기존(구 의미) historyless decision은 재계산 불가이므로 판정 시 unknown 처리(정직 강등 — 마이그레이션으로 위조 금지). **주입 범위↔검증 범위 정합(6차 blocker②)**: applied decision에 `affectedIds`(=생존 changedIds) 필드를 해시 결속으로 추가하고, provenance 4검사·effectiveConfidenceOf의 대상 검사를 targetIds∪affectedIds로 확장. 삭제 entity는 주입 제외. **버전·호환 계약(7차 blocker — decision은 topology 마이그레이터 소관이 아니므로 별도 버전 경로 필수)**: `map-decision-v3` 스키마 도입 — v3 KEYS=v2+affectedIds(topology decision=필수·정렬·중복 제거, policy decision=부재[entity 대상 없음]), historyless VerificationBasis의 structural 의미는 v3부터. **dual reader**: decisionIndexFor·WAL validator·recovery가 v2/v3 모두 판독(신규 기록은 v3만). 구 v2 레코드=바이트 의미 보존(필드 생략 포함·재작성/일괄 변환 금지 — decisionIndexHash·authorityHash·audit·WAL 결속 불변). 판정 규칙: v2 historyless=unknown 강등 / v2 git=기존 targetIds 검사 유지 / v3=targetIds∪affectedIds+structural basis. ②provenance 포함 topology 검증+mapHashAfter 계산 ③기준선 지문은 apply 후 재해시가 아니라 'CAS가 방금 검증한 livePatch.readSet.files의 동일 경로 지문'에서만 복사 ④read-set에 없는 anchor=기준선 미생성·unknown 유지 ⑤buildReadSetFor를 대상·생성·분할·병합 결과 node의 모든 anchor를 포함하도록 확장(P2 계약 확장 — set_state/rewrite_label/merge/add 계열 포함) ⓑevidence축=모든 분기에서 현재 내용 지문==provenance 기록 지문 실대조(1차 blocker② — HEAD==basis.head는 단축 아님·전진+불변=fresh 유지 / historyless=basisFp/inventoryFp+evidence 지문). 한 축이라도 상이=stale·판독 불가·provenance 부재·경계 이탈=unknown(표시 전용·차단 없음). **dual basis 불변식(7차 [보완] — §1-1 보강)**: PatchBasis.basisFp=mapHashOf(full·provenance 포함 — CAS는 provenance 변경도 반영) / VerificationBasis.basisFp(v3 historyless)=structuralHashOf(provenance 제외 — provenance만의 변경에 불변) / mapHashAfter·audit·snapshot·WAL·authorityHash 계산은 structural로 교체하지 않음(현행 유지). read-set 4범주(인접성·음성 조건)는 patch 재기반 CAS 소관 — freshness에는 재적용하지 않음(1차
  검증 확인). **권위 단일화 범위**: Project MAP projection 소비 경로의 신선도는 이 판정기 출력만 사용.
  scouts/ 영향지도 낡음 배지는 별개 시스템 존치.
- **P4-4 slice 동봉(scout-attach 표면)** — 새 진입 `buildMapAttach(ws, c, lang)`: 내부 라우팅.
  **source="legacy"·"none"·"blocked"·Project MAP 판독 실패 전부 → 기존 buildScoutAttach에 그대로 위임(출력
  바이트 동일 — cutover 전 무회귀·판독 실패가 legacy 동봉을 막지 않음, 1차 blocker⑥ 후단)**. source="v2"
  (P3b 후)에서만 slice 렌더 — **envelope 계약 승계(1차 blocker⑥·2차 [보완] 정정)**: 반환형은 현행과 동일한 `{text, mapItems, couplings}` — healthLine은 별도 필드가 아니라 기존처럼 text에 포함(소비처 codex-bridge carrier가 text/mapItems/couplings만 읽는 현행 계약 불변), L1-A attach echo·이중 try 격리·2트랙 게이트 최선행 승계. slice 내용=변경 파일 앵커에
  연결된 node/edge(effective만·degraded 제외)+freshness 라벨+advisory 명시.
- **P4-5 게이트(gate-map-reader 표면) — 이전 시점 확정(1차 blocker⑤)**: 게이트의 지도 체계 이전은 **P3b
  cutover와 동시**(그 전까지 현행 scouts/ 영향지도 판독·정책·문구 완전 유지 — P4에서 런타임 변경 0).
  P4가 하는 것: cutover 후 게이트용 v2 판독 함수를 '비활성으로' 준비+계약 고정 — ①freshness→게이트 집계 상태 변환 규칙(2차 blocker② — 판독 실패를 차단 상태로 바꾸지 않는다): 정상 판독인데 projection 자체가 부재=no-map / ok:false·authority-flap·판독 불가·blocked=unknown(무차단·fail-open) / 변경 파일 판독은 {ok, paths}로 분리(3차 blocker②: 현행 판독이 git 실패·timeout에도 빈 배열을 반환해 clean과 구분 불가) — 판독 실패=unknown(무차단) / ok·변경 있음·어느 anchor에도 미연결=stale(지도가 이 변경을 모름 — 갱신 유도) / ok·clean(변경 0)=관련 effective **node와 edge 전체** 집계(4차 blocker② — stale edge 단독 반례: clean이어도 edge evidence 불일치면 fresh 금지) / ok·변경 있음=seed node+인접 edge+evidence 경로 직접 일치 edge 집계. **집계 우선순위(4차 [보완])**: stale 존재→stale, 아니고 unknown 존재→unknown(무차단), 전부 fresh만 fresh. edge에는 anchor축이 없으므로 N/A(축 미적용 — 전 edge가 unknown으로 고정되는 역오류 금지·evidence축만 판정) ②차단 안내의 복구 명령을 Project MAP 갱신 경로로 교체하는 문구
  세트(ko/en — 활성화는 P3b 스윕에서). manifest에는 이 준비 함수를 등록(ready 판정은 '준비됨' 기준 — 활성
  여부와 별개임을 manifest 스키마에 명시).
- **테스트(1차 blocker⑧ 반영 — 동결 목록)**: reader: 소스 5종(v2/legacy/none/blocked/error — error 사유 lock·authority-flap 각각)·권위 flap 폐기·blocked=legacy 폴백 금지·
  effective/degraded 분리(dangling decision edge 반례)·authorityHash 존재 / 캐시: 생성·mapId 무효화·손상
  재생성·상한 축출·**같은 size+mtime 내용 치환 반례(캐시 미신뢰 증명)**·**ignored/untracked evidence 변경=stale·assume-unchanged 숨김 반례(2차 blocker① — clean 목록 신뢰 금지 증명)** / 판정기: **anchor만 수정=stale(두 축 판정 반례)**·기준선 세대 결속(같은 mapId 내 decision 적용 후 옛 기준선 무효)·**같은
  HEAD dirty evidence=stale**·HEAD 전진+불변=fresh·historyless 대조·provenance 부재=unknown·**경로 이탈
  (../·절대·symlink)=unknown+저장소 밖 판독 0** / attach: 2트랙=출력 0·legacy/none/blocked/판독실패=기존
  바이트 동일 위임·v2 envelope 보존(couplings 필드+text 내부 health 문구 — 별도 healthLine 필드 금지) / 게이트: P4 동안 런타임 무변경(현행 테스트 불변)·
  변환 규칙 단위 반례(비활성 함수 — **clean=node·edge 전체 집계(stale edge 단독=stale)·판독 실패=unknown·fresh+unknown 혼합=unknown 무차단**)·**동시 apply 중 reader 혼합 스냅샷 차단(withMapLock) 반례+잠금 경쟁·self-nesting timeout 반례**·**기준선: reader 관측은 기준선 미생성·apply 전이만 생성·무관 decision이 타 node 기준선 불변·CAS 직후 외부 편집=기준선 오염 없음(read-set 지문 복사 증명)·add/set_state/split/merge 계열 anchor 포함·freshness 파일 동시 쓰기 lost-update 반례** / **P2 확장: historyless structural hash 순환 부재(주입 전 계산)·structural은 provenance만의 변경에 불변(dual basis 불변식)·구 v2 historyless=unknown 강등·구 v2 git=targetIds 검사 유지·v2/v3 dual reader(WAL 포함)·구 레코드 바이트 불변(재작성 금지)·**v2 해시 불변 직접 단언 5종(8차 [보완]: 동일 v2 fixture의 adpHashOf 전후 동일·v2-only decisionIndexHash 동일·같은 topology+v2 index의 authorityHash 동일·v2 projection에 affectedIds 키 부재·v3 projection만 정렬 affectedIds)**·affectedIds 해시 결속(정렬·중복 제거·policy 부재 규칙)·split/merge rerouted edge와 destination node의 자기 provenance 4검사 통과·삭제 entity 제외·historyless apply/WAL 복구/투영 반례** / manifest: P4 표면 2개 ready+P3b 사전조건 시나리오 / 2트랙 끝단:
  MAP 파일 생성 0·전송 0·**map-freshness 파일 생성 0·reader 미호출**.


## P7 상세 설계 v4 (2026-07-23 — 1차 blocker 4·주의 1·보완 2+2차 blocker 1(probe 동일 조립)·보완 1(전 provider 세대 결속) 반영. 2차 blocker f-63adc25f=사용자 결정 대기[아래 P7-0 미결 ①])

**P7-0 범위**: 모드 UI+readiness 행렬(1-34 개정 포함)+readiness 영속 상태(1-8). 제외: 라우팅·승격·adjudication(P8). **1-33 정합(1차 blocker④·2차 사실 정정)**: 실측 정정 — 보강 대기열은 실재한다(map-bootstrap.js가 map-enrich-queue/<repoKey>.json 생성·완료 조건 포함). 부재는 '소비자(실행기)'뿐. 따라서 1-33의 즉시 자동 재개 계약과의 정합은 두 길뿐이며 **사용자 결정 사안(미결 ①)**: ⓐP7에 최소 실행기(큐 소비→self 어댑터로 보강 실행→결과 반영)까지 포함(범위 대폭 확대) ⓑ1-33 개정 — 재개 발동 시점을 '실행기 배포 Phase(P8 동승 또는 별도)'로(P7은 재개 트리거 훅 자리만 계약). 결정 전 구현 착수 불가(설계검증 2차 판정).

**P7-1 모드 저장(1차 blocker① 반영)**: 계약 필드 mapMode ∈ **self|economy|precision|auto** — scoutArm과 완전 동형 구조: 명시 self=override(반대 언어 슬롯 폴백을 이김), 부재=미지정(비물질화 — 기본 self 동작·반대 슬롯 상속). 저장=exact-patch 관문(P-8 2단)·대시보드 저장 페이로드 미포함. 반례 봉합: 반대 슬롯 economy+현재 슬롯 명시 self → self(상속 차단).

**P7-2 readiness 행렬(1-34 개정 — 원문에 supersession 부기 완료)**:
- selfReady = Claude CLI 실행 가능(self.probe) AND self typed adapter 배포(scout-providers.js 실존).
- economyReady(1차 blocker② 반영) = 실효 설정 존재 AND **실효 지문 일치** AND typed capability probe 통과. **configFp=sha1(실효 해석 후의 주소·모델·키 지문[sha1(실효 키) 앞 12 — 원문 미포함]) — env(DEEPSEEK_API_KEY)가 파일 키를 이기는 실효 해석 기준**(키 유무만으로는 키 교체를 못 잡는 반례 봉합). probe는 요청 직전 configFp 캡처→typed 결과·저장 레코드에 결속→기록 직전 현재 configFp 재확인(불일치=기록 포기·재점검 요구 — TOCTOU).
- precisionReady(1차 blocker③+2차 blocker 반영) = **실제 초소형 ephemeral 실행 1회 성공 — 단 '실제 정찰과 동일 조립'으로**: probe는 별도 명령 문자열이 아니라 scout-providers codex 어댑터의 공용 invocation 빌더를 그대로 호출한다(--ephemeral·--sandbox read-only·--skip-git-repo-check·**...scoutCodexArgs()(저장된 정찰 두뇌 설정 포함 — 잘못된 모델 설정이면 probe도 같이 실패해야 준비 오판이 없다)**·임시 cwd·동일 env). 소형 프롬프트("ready"만 답하게)로 인증·home·플래그·두뇌 설정까지 실증. 버전 응답·소스 문자열 검사는 참고 표시일 뿐 증거 아님(1-8 동형 원칙). Codex 계정 사용량 1회 고지.
- autoReady = economyReady AND precisionReady(미성립=자동형 선택 불가+사유).
- 조용한 전환 금지: eff 개념 미도입(저장값=표시값)·readiness 상실=degraded 배지+사유만·scoutArm no-key 강등 코드 재사용 금지.

**P7-3 readiness 영속 상태(1-8·1차 보완②+2차 보완 반영)**: 전역 ~/.codex-bridge/map-readiness.json — { version:"map-readiness-v1", probeVer(프로브 계약 버전 — 계약 개정 시 전 레코드 무효), economy:{ok,probedAt,configFp,detail}, precision:{ok,probedAt,**execFp**,detail}, self:{ok,checkedAt,**execFp**,detail} }. **execFp(2차 보완 — 세대 결속을 전 provider로)**: precision=sha1(resolveCodex 해석 결과[file·args·how]·실효 CODEX_HOME·scoutCodexArgs() 조립 결과·어댑터 계약 버전) / self=sha1(claude --version 응답·scout-providers.js 배포 지문). 조회 시 현재 지문과 재대조 — 불일치=무효(재점검 필요 표시·CODEX_BIN/home/정찰 두뇌 설정 변경이 기존 결과를 못 살림). **probe 실행 세대 결속(3차 blocker — economy의 TOCTOU 계약을 전 provider로 일반화)**: 공용 builder가 실행 '직전' {invocation, probeVer, execFp}를 함께 캡처하고, probe 성공 후 **기록은 파일 잠금 안에서 현재 지문을 재계산·비교해 일치할 때만**(불일치=결과 폐기+재점검 요구 — 실행 중 다른 창이 전역 scout-codex.json/CODEX_BIN을 바꾸면 A 설정으로 성공한 결과가 B 지문에 결속되는 반례 차단). 테스트: 지연된 가짜 CODEX_BIN 실행 중 설정 변경 반례 필수. **쓰기=withFileLockStrict 하 read-merge-write(다중 창 경합 직렬화)·atomicWrite. 판독 손상=전 provider unknown(정직 — 기본값 위장 금지). probe 세대=probedAt+configFp 결속(경제형은 지문 불일치 시 무효).** probe 트리거=명시 '준비 점검' 버튼만(자동 백그라운드 금지). **과금 고지(1차 [주의] 반영): DeepSeek capability는 "최대 2회 호출"(strict 실패 시 원격 bounded repair 1회 포함 — repair는 원격 재호출로 고정)·Codex는 "계정 사용량 1회" — 호출별 appendScoutUsage(arm "capability"/"codex-probe") 기록.**

**P7-4 UI**: 정찰 카드 '의미 보강 담당(모드)' 행 — scoutArm 행과 별도(1-26 부기). 4버튼 기본(self)/경제형/정밀형/자동형+readiness 뱃지(미성립=비활성+사유 툴팁)+degraded 표시(저장값 유지)+'라우팅 적용은 P8부터' 정직 배지+'준비 점검' 버튼(과금 고지 병기). 저장·재클릭·낙관 전환·언어 슬롯 잠금·단일-flight=기존 행 문법 재사용.

**P7-5 테스트**: readiness 순수 함수 4값+경계 반례(실효 키 교체 반례 포함)·영속 파일 왕복(잠금·손상=unknown·세대 결속)·capability probe(스텁 API — strict 통과/실패/repair 1회/2회 실패·configFp TOCTOU)·precision probe(가짜 CODEX_BIN 재사용)·mapMode 저장 왕복(명시 self override 반례)·UI 배선(별도 행·강등 코드 부재·비활성 사유)·전체 체인.

**미결(사용자 확인 대상)**: ①1-33 자동 재개 발동 시점 개정(위 P7-0 — 실행기 배포 Phase로) ②정본 개정 승인(1-34 precisionReady ephemeral 재정의·P7 로드맵 Scout 세션 관리 소거 — supersession 부기 완료, 승인 시 [확정] 표기).
