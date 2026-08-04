# 지도 해상도 증분 상향(file 노드) — 설계 v1 (초안 · 설계검증 대기)

> 2026-08-04 작성. 결정 계보: 3트랙 감사(검증 통과보완 — "모듈 9노드 지도는 실제 사고[함수 내부 결함]를
> 표현할 해상도가 아니다") → 사용자 결정 "2번과 3번도 기능 축의 한계이자 직접적인 문제" + 진행 순서
> "1+2 먼저, 3은 설계부터". 선행 완결: 1(소화 기준점 consumed.json — srcHead 단일 캡처 결속)·2(확인
> 도장 승격 조건 고지) 커밋 221c014·166f996·1486c29, 자기치유 실전 완주(9/10 적용) 실증.

## 0. 문제와 방향

현행 Project MAP은 모듈 수준 9노드·5엣지(DRAFT rev16)다. 최근 수리 캠페인의 실제 결함들 —
`durableEnv {ok,job}` 감싸개 미언랩, 정렬 정본 두 곳 갈림, 견본 어휘 드리프트 — 은 전부 **파일·함수
수준의 계약 결함**이라 이 지도에는 단 하나도 표현될 수 없었다(감사 실측). 지도가 "잘못된 범위를
바로잡는 재료"가 되려면 사고가 난 자리의 해상도가 필요하다.

**방향**: 전면 파일 스캔 노드화(177파일 일괄)가 아니라 **사고·수리 활동이 관측된 자리부터 증분
세밀화**. 재료는 이미 흐른다 — 보강 입력(=소화 기준점 이후의 변경 파일)이 곧 "수리가 일어난 자리"이고,
관찰일지의 확인된 결합이 파일 수준 관계를 담는다. 빠진 것은 보강이 **파일 노드를 만들 권한**뿐이다.

## 1. 현행 실측(설계의 출발 조건)

- 패치 계층(v2)은 `add_node`를 **이미 지원**한다: `PATCH_OPS_V2` 포함, payload `{node}`는 topology와
  같은 `validateNode`로 검증(project-map.js), 적용기는 "id가 이미 존재"를 거부(1936행 상당).
  `split_node`/`merge_node`도 예약돼 있으나 edgeReroute 등 대형 연산이다.
- 보강 결과 계약(enrich-result-v1)은 5연산만 허용: `add_evidence`/`set_state`/`add_anchor`(대상 지정)
  +`add_edge`+`rewrite_label`. **`add_node`가 없어** 관찰일지의 "과정 노드 추가 후보"류 관측이 지도로
  들어갈 길이 없다(감사에서 확인된 끊김).
- `ENTITY_TYPES = ["module","store","boundary","external","process"]` — 파일 단위 유형이 없다.
  어휘 확장 규칙은 "추가만 허용(제거·의미 변경만 schemaVersion 상향)"(RELATIONS 주석 계보).
- 발췌·근거 계약: 근거 인용은 전송한 발췌 안에서만, code/test/config 계열 최소 1개(자기확인 고리
  차단), 발췌 선정·판독은 excerptFilesFor/excerptBodyFor 단일 경로.

## 2. 설계

### 2-1. 어휘: `entityType: "file"` 추가

- `ENTITY_TYPES`에 `"file"` 추가(추가만 — schemaVersion 불변). 의미: **소스 파일 1개의 역할**을
  표현하는 노드. anchors는 정확히 그 파일 1개(kind는 evidenceKindOf 분류를 따름 — code/test/config).
- 라벨은 파일의 역할 한 줄(예: "검증 브릿지 본체 — ask 흐름·재확인 배선"). 경로 자체는 anchors가
  담으므로 라벨에 경로 반복 금지(프롬프트 지시).
- 기존 module 노드와의 관계: 소속은 `owns` 엣지(module→file)로 표현한다. **동반 권장·비강제** —
  add_node와 같은 라운드에 add_edge(owns)를 제안하도록 프롬프트가 지시하되, 미동반이어도 노드는
  유효하다(지도는 advisory·후속 라운드가 엣지를 보강할 수 있고, 슬라이스는 anchor 기반이라 엣지 없이도
  변경 연결이 동작한다).

### 2-2. 보강 연산 개방: enrich-result-v1에 `add_node` 허용

- item 형태: `{"op":"add_node","payload":{"node":{...}},"evidence":[...]}` — targetId 금지(add_edge와
  동형). node는 기존 `validateNode` 전문 검증(계약 갈림 방지 — 같은 함수).
- **v1 한정 강화 규칙**(itemShapeError/validateEnrichResult 확장):
  - `node.entityType === "file"`만 허용(모듈·경계 등 상위 구조 신설은 보강 권한 밖 — 부트스트랩·사용자
    소관 유지).
  - `node.anchors`는 정확히 1개, 그 경로는 **이번 라운드 발췌 파일 집합에 실존**해야 한다(발췌 밖
    파일의 노드화 금지 — 근거 인용 규칙과 같은 원리. 판정은 excerptFilesFor 단일 경로 재사용).
  - `node.state.confidence`는 `candidate` 강제(모델이 confirmed로 태어나게 하는 것 금지 — 승격은
    이후 add_evidence/set_state 라운드+검증 해소 경로 소관).
  - 같은 anchor 경로의 file 노드가 topology에 이미 실존하면 그 item 거부(id 계열 오류 — 중복 노드
    차단. 비교는 경로 정규화[구분자·소문자] 후 전문 일치).
- **node.id는 모델 제안을 무시하고 변환기(toPatchV2)가 결정론 파생으로 강제 대체**: 위조·충돌·비UUID
  차단. 파생식은 jobSeed 계열과 동형의 결정론 UUID(입력: mapId + "file-node" + 정규화 anchor 경로) —
  같은 지도에서 같은 파일이면 언제나 같은 id가 나와, 경합 라운드가 같은 파일 노드를 서로 다른 id로
  이중 생성하는 경로도 함께 닫힌다(적용기의 "id가 이미 존재" 거부와 이중 방어).

### 2-3. 폭발 방지 상한(anti-explosion)

- **라운드당** add_node 상한 5개: 초과 item은 형태 오류로 거부(fail-closed — 침묵 절단 금지 관례.
  프롬프트에 상한을 고지하므로 정상 모델은 걸리지 않는다).
- **지도 전체** file 노드 상한 60개: 적용 시점에 초과가 되는 add_node item은 거부(사유 명시). 상한
  도달은 보강 로그(appendRouteLog)에 남겨 대시보드/감사가 본다. 수치 2개는 상수로 두되 조정 가능
  (하드코딩 구체어가 아니라 카테고리 상한 — 기존 SLICE_NODES_MAX 관례와 동형).
- 슬라이스·발췌 상한(40/60/20)은 불변 — file 노드 증가는 '변경 연결 우선' 규칙이 자연 흡수한다.

### 2-4. 프롬프트 계약(단일 정본 관례 유지)

buildEnrichPrompt에 add_node 견본 1줄 추가:
- 허용 조건 고지: "발췌에 실린 파일 중 역할이 분명한 것만, 라운드당 최대 5개, entityType은 file만,
  confidence는 candidate로" — 상한·유형 값은 상수에서 생성(어휘 드리프트 봉합 계보와 동형: 하드코딩
  복제 금지).
- 동반 권장: "만든 file 노드는 소속 모듈로의 owns 엣지를 함께 제안하라(권장)".
- 기존 규칙(근거 code 계열 최소 1개·발췌 안 인용)은 add_node에도 동일 적용(자동 — 공통 검증 경로).

### 2-5. 사고 자리 우선(우선순위는 입력이 이미 만든다)

별도 가중치 기계를 만들지 않는다. 근거: 보강 입력은 이제 "지도가 마지막으로 소화한 시점 이후의 변경"
(과제 1 완결)이고, 그것이 곧 수리·사고가 일어난 자리다. 발췌에 실리는 파일만 노드화할 수 있으므로
(2-2), file 노드는 구조적으로 사고 자리부터 생긴다. 관찰일지 confirmed 결합은 기존 동봉 경로로 이미
프롬프트에 실려 어느 파일이 중요한지의 힌트가 된다(과제 2 완결로 승격률 상승 기대).

## 3. 비목표(v1 범위 밖)

- `split_node`/`merge_node`(edgeReroute 동반 대형 연산), 함수 수준 노드, 전면 파일 스캔 노드화,
  module 노드 자동 생성/개편, MAP.md 렌더러 개편(entityType은 그대로 표시됨 — 렌더 변경 불요),
  기존 9노드·5엣지 마이그레이션(추가만이라 불요).

## 4. 변경 지점(구현 예정 파일)

| 파일 | 변경 |
|---|---|
| src/project-map.ts(→sync bridge/) | ENTITY_TYPES에 "file" 추가(1줄 — validateNode는 enum 참조라 자동) |
| bridge/map-enrich.js | itemShapeError/validateEnrichResult에 add_node 규칙(2-2)·상한(2-3)·toPatchV2 결정론 node.id 강제·file 노드 전체 상한 검사 |
| bridge/enrich-providers.js | 프롬프트 add_node 견본+상한·조건 고지(상수 생성) |
| tests | p8-enrich-store(형태·중복·상한 반례)·p8-enrich-run(e2e: file 노드 제안→적용→topology 반영·결정론 id 재현·상한 거부)·p8-enrich-wire(프롬프트 고지=상수 일치)·project-map(ENTITY_TYPES 추가 무회귀) |

## 5. 테스트 계획(구현 회차 인수조건)

1. add_node(file) 정상 적용 e2e — topology에 노드 실재·confidence=candidate·id=결정론 파생값 재현.
2. 거부 반례: 발췌 밖 anchor / entityType≠file / anchors 2개 / confirmed 태생 / 중복 anchor(기존
   file 노드 실존) / 라운드 6개째 / 전체 61개째.
3. 결정론 id: 같은 (mapId, 경로) 두 라운드 → 같은 id → 두 번째는 적용기 "이미 존재" 거부(이중 방어).
4. owns 엣지 동반 제안이 add_edge 기존 경로로 정상 적용(from=module, to=file).
5. 프롬프트 고지 문구=상수 전문 일치(드리프트 잠금 계보).
6. 기존 스위트 전체 무회귀(특히 map-patch-v2·map-apply-v2·p8 계열).

## 6. 남는 위험(정직 고지)

- file 노드가 늘면 슬라이스의 '잔여 채움' 자리가 줄어 module 노드가 밀릴 수 있다 — 상한 60과 변경
  연결 우선 규칙이 완화하지만, 관측 후 슬라이스 우선순위(유형 가중)는 후속 판단.
- 모델이 상한·조건을 무시하면 item 거부가 늘어 라운드 실패(answer-rejected)가 생길 수 있다 —
  자동 재시도 1회+input 자기치유가 받치고, 고지(2-4)가 1차 방어다(어휘 드리프트 봉합에서 실증된 접근).
- 파일 삭제 시 file 노드는 잔존한다(lifecycle 전이는 검증 해소·사용자 경로 소관) — v1은 생성만 다루고
  소멸은 기존 tombstone/lifecycle 체계에 맡긴다.
