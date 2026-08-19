# 설계 경위 색인·선조회 (Design-Provenance Index) — v1 설계

> 발단(2026-08-18 사용자 실사고): "정책 0이 정상인가?"라는 **경위(왜 이렇게 됐나) 질문**에서,
> 답(v12 ⓒ 자동화 결정·카드 폐기)이 docs/MAP-V2-DESIGN.md에 완전 기록돼 있었음에도 구현 AI와
> 1차 검증이 코드 표면만 보고 "진입로 없음=미구현 공백"으로 오판(3왕복 만에 정정). 원인 분석
> (검증 확정): 기록 부재가 아니라 ①결정이 '원자 단위'로 색인되지 않음 ②진단 첫 수에 색인을
> 여는 트리거·영수증 부재 ③기존 MAP 검색은 검증자 동봉 전용+설계 문서가 anchor 밖. 사용자
> 결정: 하네스 기능으로 봉합하되 **기존 색인·검색 자산을 재사용**(신규 대공사 단정 금지).

## 0. 기존 자산 실측(재사용 지도) — 신규는 §0 말미 '직접 배선 7곳'뿐

| 부품 | 실재 위치 | 이 설계에서의 역할 |
|---|---|---|
| 씨앗 추출·검색 엔진 | bridge/map-retrieval.js(extractSeeds·searchSeeds — 경로/백틱/식별자/인용문 8개·흔함 감점·저장소 파일 스캔 1,500) | 코드 씨앗이 있을 때의 보조 신호로만 — **경위 매칭의 주 경로는 아님**(1차 설계검증 blocker①: 한글 자연어 질의는 4모양 규칙에서 씨앗 0건 실측 — "정책 0 정상인가"·찾는말 전부 0건. 경위 축은 §2의 독자 낱말 대조를 쓴다) |
| 동봉 표면 | bridge/map-reader.js renderV2Slice(reqText)·buildMapAttach | 경위 구획을 **게이트 앞 독립 부착**(1차 blocker②: 의도 축은 지도 노드 anchor로만 구성되고 intent 0이면 조기 반환 — 축 합류 불가. §2) |
| 동봉 영수증 | attach.jsonl(appendAttachUsage) | **재사용 불가 판정**(1차 blocker③: 대시보드가 최신 행을 종류 구분 없이 '이번 검증에 실린 기억'으로 읽어 조회 행이 검증 영수증을 가림) — 같은 형식·trim 규약의 **별도 장부** 신설(§3) |
| 진단 규율 주입 | UserPromptSubmit 채널 **2종** — Claude(contract-inject.js)·Codex(codex-hook.js implementerContext) | scoutMode 독립 공용 directive를 **양쪽에서** 호출(아래 §3 — 한쪽만 결속하면 다른 구현자에서 얕은 종료 재발) |
| 확정·도장 채널 | MAP.md 확정층(map-ledger 승인 줄) | v1 범위 밖(경위 색인은 별 파일 — §4 비채택 사유) |

크기 정정(1·2차 설계검증 반영): "두 조각"이 아니라 **직접 배선 7곳**(색인 파서·낱말 매처·게이트 앞 구획·why CLI·공용 directive·구현자 훅 결속 2종[Claude contract-inject.js+Codex codex-hook.js]·별도 영수증 장부) — 신규 서비스·마이그레이션 없는 소형~중형. 씨앗 엔진·기존 4축·attach 소비자는 무접촉(무회귀).

## 1. 색인 파일 — `docs/DECISIONS.md` (원자 결정 색인·repo tracked)

- 형식(항목=결정 1건·원자 단위 — "다캠페인 한 줄" 금지의 정반대):
  ```
  ## D-2026-07-24-intent-auto — MAP 대기 변경은 승인 카드 대신 자동화
  - 날짜: 2026-07-24 · 종류: 개정(ⓒ 확정) · 상태: 유효
  - 결정: 지도가 새 발견을 올릴 때마다 '이걸 반영할까요?' 승인 카드가 쌓여 사람이 일일이
    눌러야 했다 — 사용자가 "후보마다 묻지 말고 자동화하라"고 지시해, 정책이 걸리지 않은
    일반 제안은 검증 결과로 자동 반영하고 그 승인 카드는 폐기했다.
  - 왜: 사용자 지시 "MAP은 후보마다 승인 묻지 말고 검증 통과·반박·결함 확인으로 자동화하라".
  - 결과: '재사용 정책' 숫자가 0으로 머무는 저장소는 고장이 아니라 이 자동화의 잔여 표시.
  - 정본: docs/MAP-V2-DESIGN.md `P9 v12 소규모 개정`~`사용자 지시 부기` 절.
  - 찾는말: 정책 0, 자동 승인, 카드 없음, 왜 정책이 안 생기나, intent policy
  ```
- **문체 규약(사용자 식별성 — 하네스 동작 원칙)**: 색인은 사람이 읽고 식별·판단하는 표면이다.
  '결정'은 겪은 상황부터 시작한다 — "무슨 일이 있었고 → 그래서 무엇을 정했다"를 기술용어
  없이 상황예시로 쓴다. 코드 식별자·정확한 지점은 '정본' 줄에만 둔다(기계의 자동 실효 감지
  전용 — 사람 문장과 기계 앵커의 역할 분리). 같은 원칙이 색인을 보여주는 모든 표면(대시보드
  카드 안내문·why 조회 출력·검증 동봉 구획 라벨)에 적용된다. 단 자동층 발췌는 원문 인용이
  원칙(작문 0 — V2-1)이므로 발췌 자체를 풀어쓰지 않고, 둘러싼 라벨·안내만 쉬운 말로 한다.
  문체는 기계가 검사하지 않는다(파서는 형식만 — 문체 regex 검사 추가 금지: 경직성 유발).
- **찾는말(사용자 어휘) 줄이 어휘 간극의 해소 장치** — 문서 내부 코드네임(ⓒ·4버튼)과 질문
  어휘(정책 0·왜 안 생기나)를 잇는다. 찾는말에는 규약 어휘(FINDINGS_MARKERS 값 등)를 쓰지
  않는다(protoSeeds 오염 원천 차단 — 파서가 거부).
- 생성: 추출 보조 스크립트(scripts/provenance-scan.js)가 설계 문서들의 결정 표지(개정·확정·
  폐기·지시 부기 헤더)를 후보로 나열 → **사람이 항목 확정**(자동 승격 없음 — 색인은 요지 재서술이라
  오염 시 오도 비용이 큼). 초기 적재는 기존 설계 문서 결정 블록의 일괄 후보화로 시작.
- 기존 project-map/decisions(적용 MAP 변경의 권위 지문 색인)와 이름·역할 분리 — 혼동 금지.

## 2. 매칭·동봉 — 게이트 앞 독립 구획(축 아님)

**매칭(독자 낱말 대조 — 씨앗 엔진과 분리)**: 색인은 결정 수십 건 규모의 단일 파일이므로 전문
스캔이 아니라 항목별 어휘 대조로 충분하다. 규칙(2차 설계검증 blocker① 반영 — "정책 0"의 '0'이
2자 규칙에서 탈락해 일반어 '정책' 단독 교차·동점 밀림이 실측된 반례의 처방):
- 낱말화: 공백·구두점 분리 — 한글·영문은 2자 이상, **숫자 토큰은 1자여도 유지**("0"·"3" 등은
  식별력 있는 값이라 제외하면 발단 질의가 죽는다).
- 점수: ①**연속구 가점(최우선)** — 질의의 인접 낱말쌍(예: "정책 0")이 항목의 제목·찾는말에
  연속으로 나타나면 강한 가점 ②낱말 교집합 크기 ③기존 4모양 씨앗의 결정 줄·정본 경로 일치 가점
  (보조 신호). 교집합·연속구 모두 0=매칭 없음.
- **정렬키(결정론 — 3차 확인 보완 반영·가점 3종 전부 명시)**: 연속구 가점 > 낱말 교집합 크기 >
  씨앗 가점(③) > 결정 ID 사전순 — 항목이 늘어 동점이 생겨도 출력이 결정적이며, 재현 시험은
  연속구 가점으로 상한(2건) 안 도달을 보장한다.
이 규칙은 extractSeeds를 변경하지 않으며 protoSeeds 계약과 무관한 별도 매처다.

**동봉(게이트 앞 독립 구획)**: '설계 경위' 구획은 renderV2Slice의 노드 선별·요청 축 게이트
**앞에서** 독립 렌더한다 — 경위 매칭이 있으면 지도 동봉이 생략(의도 축 0 조기 반환)되더라도 경위
구획만 부착된다(1차 blocker② 처방: 의도 축은 지도 노드 anchor 전용이라 축 합류 불가·게이트
계약은 무변경). 상한은 **별도 2건**(4축 라운드로빈 몫 공유 안 함·NOTE_MAX 준수). 색인 파일
부재=구획 부재=현행 바이트 동일(무회귀 스냅샷 시험).

## 3. 선조회 — 구현자 진단 첫 수

- CLI: `node codex-bridge.js why "<질문/주제>"` — §2 낱말 대조→항목+정본 경로 출력, 조회
  영수증은 **별도 장부 provenance-usage.jsonl**(attach.jsonl과 같은 형식·trim 규약·같은 폴더 —
  1차 blocker③ 처방: attach.jsonl은 대시보드가 최신 행을 '이번 검증에 실린 기억'으로 읽으므로
  무접촉). 매칭 0건도 "0건" 영수증(부재 증명의 얕은 종료 방지). 대시보드 표시는 v1 범위 밖(장부만).
- 규율 주입(2차 blocker② 반영 — 구현자 훅 2종·2트랙 결속): **scoutMode와 독립인 공용 directive**
  (bridge/map-provenance.js의 buildProvenanceNotice — 색인 파일이 존재할 때만 1줄 반환·없으면 null,
  구현검증 보완: 소유 위치를 구현과 일치)를 신설하고,
  Claude 구현자 UserPromptSubmit(contract-inject.js)과 **Codex 구현자 UserPromptSubmit(codex-hook.js
  implementerContext)** 양쪽에서 호출한다. buildScoutDirective 편승은 불가(scoutMode!=="on"이면
  null — 2트랙에서 why가 죽는 반례). 문구: "경위(왜/결정 이력) 질문이면 결론 전에 `why` 선조회"
  (경고 단계·비차단). 직접 배선 재집계: 파서·매처·구획·CLI·공용 directive+훅 결속 2종·장부 = **7곳**.

## 4. 비채택(범위 밖) — 사유 명기

- MAP.md 확정층 승격: 확정층 항목은 '관계 예측의 승인' 스키마라 결정 서사와 어긋남 — v1은
  별 파일. 도장 채널 통합은 실사용 후 재평가.
- 설계 문서 자체를 MAP 노드 anchor로 등재: 노드는 코드 구조 계층 — 문서 구간 anchor는
  신선도(파일 mtime) 의미가 왜곡됨. 색인 파일 경유가 정확.
- Memento 적재·파일 메모리 원자화: 구현모델 작업 규율(별 트랙 — 이번 세션에 2건 적재 완료).

## 5. 검수 기준

- provenance-scan 후보 나열이 기존 설계 문서에서 결정 표지를 놓치지 않음(표본 검증).
- 경위 구획: 색인 부재=현행 바이트 동일(무회귀 스냅샷) · 매칭 시 게이트 앞 독립 부착(의도 축
  0으로 지도 동봉이 생략돼도 경위 구획은 부착) · 별도 상한 2건 · 찾는말 규약 어휘 거부.
- 낱말 매처: "정책 0 정상인가"·"왜 정책이 안 생기나" 류 한글 자연어 질의가 씨앗 0건이어도
  찾는말 교집합으로 D-2026-07-24-intent-auto 도달(발단 사고 재현 시험 — 1차 blocker① 실측
  반례의 정방향 재현) · 교집합 0=매칭 없음(무관 동봉 0).
- why CLI: 매칭/0건 양쪽 영수증이 provenance-usage.jsonl에만 기록(attach.jsonl 바이트 무변경 —
  대시보드 '실린 기억' 카드 무회귀 시험) · 2트랙(scoutMode off)에선 색인 검색만(지도 부품 미접촉).

## v2 — 등재 자동화 설계 (2026-08-19 사용자 결정 · 초안 v1)

### V2-0. 목적·권위 경계 (3왕복 검증으로 확정된 문장)
v1의 '사람만 등재'는 수칙서(판정 권위 — ab-3 도장 불가침) 관용구의 과적용이었다. 확정 경계:
**금지되는 것은 수칙서의 자동 권위 승격과 정책 op의 자동 생성뿐이다.** confirmed subgraph는
권위 입력이지만 검증 계보를 갖춘 비정책 변경은 자동 적용된다(v12 ⓒ). 경위 색인은 정책 op가
아닌 **비차단 참고 뷰**이므로, 아래 무결성 4조건을 갖추면 자동 등재가 자동화 철학(7/24)과
정합한다. 사람 몫은 등재가 아니라 **거부·정정권**이다.

### V2-1. 항목 형태 개정 — 재서술 폐지·원문 발췌
- v1의 `결정:`(요지 재서술 — 자동화 시 자동 작문이 되는 지점) 폐지. 항목의 본문은
  **정본 원문 발췌(excerpt)** 바이트 그대로(작문 0 — 벤치 정직성 원칙과 동형).
- 항목 스키마(자동층): `{id, subjectKey, gen(정수 — 같은 subjectKey 재등재마다 +1), ts(등재 시각 —
  reducer 동률 비교키), title, source{file, anchor, excerptSha}, excerpt(표시용 절단), keywords,
  origin{eventKind, eventRef, repoKey, registeredAt}}` (R4 blocker③: reducer가 비교하는 gen·ts를
  최상위 명시 필드로 — origin.registeredAt은 감사용).
- tombstone 전체 스키마: `{kind:"tombstone", tombstoneId(고유), subjectKey, scope:"event"|"subject",
  eventRef(scope=event면 필수·subject면 생략), gen?(scope=event에서 특정 세대만 겨냥할 때), ts}` —
  유효성: scope=event인데 eventRef 부재=무효, 철회는 targetTombstoneId 실존 대조.
  **subjectKey = sha1(정규화 file + "#" + anchor)** — '같은 결정'의 정체성은 정본 구간이며,
  eventRef(어느 사건이 등재했나)와 분리한다(설계검증 R1 blocker④: 중복·가림·tombstone 범위의
  판정 기준). 같은 subjectKey의 재등재=새 세대(gen 증가)로 기록.
- `찾는말` 수작업 의존 해소 — **안전 원천 한정(R1 blocker② ab-7)**: keywords = 발췌 토큰(정본
  공개 문서) + 사건의 **구조 필드**(finding 제목·정책 predicateDescription 등 — 이미 평문 계약이
  있는 필드만). **질의 원문 토큰은 금지** — v1 영수증 계약(질의=지문+길이만)과 동일한 이유로,
  질의에 실릴 수 있는 비밀값·개인정보가 자동 장부에 평문 잔존하는 경로를 열지 않는다. 사람 추가 가능.

### V2-2. 등재 원천 — 하네스가 관측 가능한 '검증 계보 있는 사건'만
**sourceRefs 파일 안전 경계(R3 blocker③ ab-7)**: file은 repo 상대 경로만 — 절대경로·`..` 거부,
realpath가 repo 내부임을 확인(containment), 민감 경로(.env·credentials·token·키 파일 등)는 기존
외부 전송 발췌 계층(enrich-providers)의 제외 규칙을 **공용 함수로 추출해 양쪽이 같은 정의를
참조**(복사 금지 — R4 보완: 규칙 이원화 드리프트 차단)한다(발췌가 장부·동봉으로 복제되는
경로이므로 v1 질의 지문화와 같은 급의 경계).

**저장소 정체성 결속(R4 blocker② ab-1)**: 모든 생산자 사건 레코드와 sourceRefs에는 **기록 시점의
정규 저장소 키(repoKey=wsKeyFor(realpath(repo)))**를 함께 저장한다 — 수확기는 클릭·수확 시점의
현재 대상이 아니라 **사건에 저장된 repoKey**로 파티션을 정하고 containment를 재검증한다(사건 기록
후 대상 저장소가 바뀐 채 재시작해도 오귀속 없음 — repoKey 불일치=자격 없음·후보 대기).

**전제(R1 blocker① — 생산자 결속이 1단계)**: 현행 사건 레코드는 file+anchor를 보유하지 않는다
(fix-fact=자유서식 note·수칙서 승인=envelopeHash만·intent-choice=patchCanonical만). 따라서 수확기
이전에 **각 생산자에 `sourceRefs: [{file, anchor, contentHash}]` 선택 필드를 결속**하는 확장이
선행돼야 하며, 자동 등재는 sourceRefs 보유 사건만 대상이다(휴리스틱 경로 추측 금지 — 결정론).

| 사건 | 생산자 확장(1단계) | 자동 등재 내용 | 계보 증명 |
|---|---|---|---|
| 수칙서 승인 도장(사용자 선택) | 승인 기록에 candidateId·askId·원 finding 참조+sourceRefs 보존(현행 envelopeHash 단독에서 확장) | 승격 규칙의 정본 구간 발췌 | 승인 지문+askId |
| 캠페인 blocker 해소(fix-fact 종결) | fix-fact 처분에 구조 필드 sourceRefs(선택 — CLI 인자) 추가 | 판단이 가리키는 정본 구간 발췌 | finding id+해소 라운드 |
| MAP intent-choice 선택 레코드 | patchCanonical→정책 파일 경로+결정 필드의 결정론 locator 어댑터 | 선택된 정책 뜻의 정본 구간 | cardId+decision |
- **구간 결속 정의(R2 blocker①·R3 blocker① 반영)**: anchor 정규 형식=`heading:<정확한 헤딩 원문>`
  (md — **문서 내 그 헤딩이 유일할 때만 유효**·중복 시 `heading:<원문>#<k>`(k번째 출현·1부터)로만
  결속 가능) 또는 `lines:<시작>-<끝>`(비-md — **끝줄 포함(inclusive)·각 줄의 개행 바이트 포함**,
  마지막 줄 무개행이면 그대로). contentHash=**그 anchor가 해석하는 구간의 바이트 그대로 sha1** —
  자동층 excerptSha는 그 구간의 앞 N자(발췌 상한) 해시가 아니라 **contentHash와 동일 값**(발췌는
  표시용 절단, 지문은 구간 전체 — 표시 절단이 지문을 바꾸면 안 됨).
- **수확 자격(유효 완료 사건만 — R2 blocker①·R3 blocker①·R4 blocker①)**: ⓐfix-fact는 close(resolved)
  조인에 더해 **수확 시점에 그 finding의 최신 처분이 choice=fix-fact이고 dispositionValid(...)===true이며,
  그 resolved close의 round가 같은 캠페인·승인 세대 안에서 finding의 최신 활동 라운드(occurrence·
  asOfRound) 이상**이어야 한다(R4 실측 반례: 재등장 후 새 fix-fact가 유효해도 옛 round의 close와
  조인되면 미해소 상태를 수확 — close가 최신 활동보다 앞서면 자격 없음·새 종결을 기다린다)
  ⓑintent-choice는 **phase=done+applied decision 실존** 확인 후에만(chosen·stale·parked 제외)
  ⓒ수칙서 승인은 **승인 사건 레코드 append를 도장(계약 저장)과 같은 잠금 구간에서 '선기록→도장'
  순서로** 수행(선기록 후 도장 실패=사건 레코드에 미완 표지 잔존→수확기가 도장 실존(envelopeHash
  일치) 확인 후에만 자격 인정 — 중간 종료의 허위 승인 사건·사건 없는 승인 분리 상태 양방 차단).
  레코드={approvalTs, envelopeHash, candidateId?, askId?, repoKey, sourceRefs} — sourceRefs 각
  항목에도 repoKey 명시(R5 park① — 축약 스키마 표기의 해석 여지 제거).
- 스캔 후보(문서 헤딩 나열)는 **여전히 사람 판단** — 사건 계보가 없는 원천의 자동 등재 금지.
- sourceRefs 없는 사건은 자동 등재하지 않고 후보 대기(사람 확정) — 초기에는 자동 등재가 드물고
  생산자 확장이 보급될수록 늘어나는 점진 구조를 의도로 명시한다(공백≠결함).

### V2-3. 지문 계약 — 자동 실효·새 사건 재수확 (드리프트 이슈의 해소 지점)
- 조회·동봉 시 `excerptSha`를 정본 현재 구간과 대조: **불일치=자동 실효**(항목 보존·stale
  마킹·동봉/매칭 제외·화면에 '정본이 바뀜' 표시).
- **재수확은 새 지문에 결속된 '새 사건'(새 검증 통과·새 사용자 선택)이 생긴 뒤에만** —
  옛 사건의 증명을 새 내용에 승계 금지(MAP confirmed→unknown 강등 계약 :364와 동형).
- 정본 표기 엄격화: file+anchor 필수('기억 노트' 류 금지). 기존 v1 3항목은 마이그레이션 시
  사람 재확정(느슨 표기 2건 포함).

### V2-4. 저장 2층·사람 거부권
- 자동층=기계 장부 — **위치·파티션(R2 blocker② ab-1·R5 park① 표기 정합)**: 브릿지 홈
  `map-provenance/<repoKey>.jsonl`(repoKey=wsKeyFor(realpath(repo)) — V2-2 결속 키와 동일 정의) — subjectKey는 상대
  file#anchor 해시라 **파티션 안에서만** 유일(전역 단일 장부 금지 — 타 프로젝트 동일 경로 오귀속
  차단). 사람층=기존 DECISIONS.md 유지(repo tracked — 파일 충돌 원천 차단·ledger stable 2층 관용구).
- **동시성·유계 계약(R1 blocker③ ab-5 — 경위 영수증·일지 관용구 재사용 확정)**: 모든 쓰기
  (append·compaction)는 단일 엄격 잠금(withFileLockStrict+사망 잠금은 quarantine 격리 회수·활성
  불가침·선회수 absent 재획득 — 경위 영수증과 동일 계보) 안에서 수행. 유계 compaction 시
  **tombstone·사람 가림 관련 레코드는 절대 제거하지 않고**(활성 판독 보존 — 제거되면 거부 사건이
  재등재됨), 잘리는 원시줄은 일지 트림 아카이브 관용구(별도 archive 파일·2단 커밋·재작성 증표)를
  재사용해 무손실 보존한다('검토'가 아니라 확정). **유계와 보존의 양립(R2 blocker③ — 기존 일지
  관용구 :2939와 동형)**: compaction은 '활성 의미 상태'(subject별 최신 유효 세대·유효 tombstone·
  철회·가림 참조)를 compact snapshot으로 항상 본문에 보존하고, 그 수가 상한을 넘는 극단에선
  **상한 예외**(의미 보존 우선 — 파일은 사람 결정 속도로만 성장). archive는 콜드 저장소(판독기
  미접촉)이므로 활성 판정에 필요한 상태는 본문 snapshot이 담당한다.
- **병합 reducer(R1 blocker④+R2 blocker④ — append 순서 무관 결정론·5단 완결)**: subjectKey별로
  ①철회 대조 — tombstone은 발급 시 **고유 tombstoneId**를 가지며(같은 사건 중복 거부도 각자 id),
  철회 레코드 `{kind:"tombstone-retract", subjectKey, targetTombstoneId, ts}`가 그 id를 무효화
  (R3 blocker②: eventRef 참조는 subject tombstone(대응 사건 없음)·중복 거부에서 다의적 — id 결속·
  중복 철회=멱등)
  ②유효 subject tombstone 존재=자동층 전체 억제(사람 항목은 불변)
  ③유효 event tombstone은 그 eventRef의 세대만 후보 집합에서 제거(같은 결정의 다른 사건은 허용)
  ④남은 자동 세대 중 fresh(지문 일치) 최신 gen 선택 — 없으면 최신 stale을 'stale 표시'로만
  ⑤사람 정정 항목(DECISIONS.md `가림: <subjectKey>` 선택 줄) 존재=자동 결과 대신 사람 항목.
  모든 단계의 비교 키: **gen은 수치 비교**(사전순 금지 — gen=10이 2보다 앞서는 R3 반례), 동률은
  (subjectKey, eventRef, ts) 사전순 tie-break — append 순서와 무관한 유일 결과.
- 대시보드 MAP 패널에 자동 등재분 목록+거부(scope 선택)·철회 버튼(비모달).

### V2-5. 검수 기준
- 실행 시험: 사건→자동 등재 왕복 / 지문 불일치=실효·매칭 제외 / 실효 후 옛 계보 재수확 거부·
  새 사건 후 재수확 허용 / tombstone scope 2종(event=그 사건만·subject=후속 사건까지) 억제·철회 /
  병합 reducer 결정론(append 순서 뒤섞기 반례) / keywords에 질의 토큰 부재(ab-7 핀) / 동시 쓰기
  잠금·사망 회수·compaction의 tombstone 보존 / 민감 경로 공용 판정기 배선(비공개→export)+경로 탈출
  반례(절대경로·`..`·.env류·**symlink/junction으로 repo 밖을 가리키는 경로의 realpath containment 거부**)
  / **과거 close 재사용 반례**(old close.round<최신 활동=거부·새 close=허용 — R4 실행 반례의 정방향)
  / repoKey 불일치=후보 대기 / v1 무회귀(md 항목·매칭·영수증·동봉 전부). 체인 EXIT=0.
- 무게 상한: 자동층 장부는 **soft cap**(활성 의미 상태가 상한 초과 시 보존 우선 예외 — V2-4와 문구
  정합·R3 보완 반영) · compaction 시 원시줄=트림 아카이브 관용구로 무손실 보존(확정).

### V2-6. 구현 순서(승인 후)
1) 생산자 sourceRefs 결속 3종(수칙서 승인 기록 확장·fix-fact 구조 필드·intent-choice locator) →
2) 스키마·파서(자동층 장부+subjectKey+병합 reducer) → 3) 지문 대조·실효·재수확 게이트 →
4) 수확기(사건→등재) 배선 → 5) tombstone·대시보드 표면 → 6) v1 마이그레이션(사람 재확정) →
7) 시험·체인.
