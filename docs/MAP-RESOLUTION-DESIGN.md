# 지도 해상도 증분 상향(file 노드) — 설계 v2 (설계검증 1차 반영 · 확인 대기)

> 2026-08-04 작성. 결정 계보: 3트랙 감사(검증 통과보완 — "모듈 9노드 지도는 실제 사고[함수 내부 결함]를
> 표현할 해상도가 아니다") → 사용자 결정 "2번과 3번도 기능 축의 한계이자 직접적인 문제" + 진행 순서
> "1+2 먼저, 3은 설계부터". 선행 완결: 1(소화 기준점 consumed.json — srcHead 단일 캡처 결속)·2(확인
> 도장 승격 조건 고지) 커밋 221c014·166f996·1486c29, 자기치유 실전 완주(9/10 적용) 실증.
> v2 개정: 설계검증 1차 blocker 4·보완 1 전부 수용(f-9f577fe4·f-7f91cc33·f-f7bfc665·f-3bae8d12·
> f-aaec461e) — §2-2a 임시 id 결속·§2-2b 판독 실존·§2-3 정본 상한·§2-2c case 보존·§2-5 전제 정정.

## 0. 문제와 방향

현행 Project MAP은 모듈 수준 9노드·5엣지(DRAFT rev16)다. 최근 수리 캠페인의 실제 결함들 —
`durableEnv {ok,job}` 감싸개 미언랩, 정렬 정본 두 곳 갈림, 견본 어휘 드리프트 — 은 전부 **파일·함수
수준의 계약 결함**이라 이 지도에는 단 하나도 표현될 수 없었다(감사 실측). 지도가 "잘못된 범위를
바로잡는 재료"가 되려면 사고가 난 자리의 해상도가 필요하다.

**방향**: 전면 파일 스캔 노드화(177파일 일괄)가 아니라 **사고·수리 활동이 관측된 자리부터 증분
세밀화**. 재료는 이미 흐른다 — 보강 입력(=소화 기준점 이후의 변경 파일)이 곧 "수리가 일어난 자리"다.
빠진 것은 보강이 **파일 노드를 만들 권한**뿐이다.

## 1. 현행 실측(설계의 출발 조건)

- 패치 계층(v2)은 `add_node`를 **이미 지원**한다: `PATCH_OPS_V2` 포함, payload `{node}`는 topology와
  같은 `validateNode`로 검증, 적용기는 "id가 이미 존재"를 거부. `split_node`/`merge_node`도 예약돼
  있으나 edgeReroute 동반 대형 연산이다.
- 보강 결과 계약(enrich-result-v1)은 5연산만 허용(`add_evidence`/`set_state`/`add_anchor`/`add_edge`/
  `rewrite_label`) — **`add_node`가 없어** 파일 수준 관측이 지도로 들어갈 길이 없다.
- `ENTITY_TYPES = ["module","store","boundary","external","process"]` — 파일 단위 유형이 없다.
  어휘 확장 규칙은 "추가만 허용(제거·의미 변경만 schemaVersion 상향)".
- 발췌·근거 계약: 근거 인용은 전송한 발췌 안에서만, code/test/config 계열 최소 1개, 발췌 선정·판독은
  excerptFilesFor/excerptBodyFor 단일 경로.
- `validateEnrichResult`는 **기존 topology의 노드 id만** 실존 집합으로 삼아 add_edge 양끝 선재를
  요구한다(1차 설계검증 실행 반례: 새 노드를 가리키는 엣지는 `edge.to 미실존` 거부).

## 2. 설계

### 2-1. 어휘: `entityType: "file"` 추가

- `ENTITY_TYPES`에 `"file"` 추가(추가만 — schemaVersion 불변). 의미: **소스 파일 1개의 역할**을
  표현하는 노드. anchors는 정확히 그 파일 1개.
- 라벨은 파일의 역할 한 줄(경로 반복 금지 — 경로는 anchors 소관. 프롬프트 지시).
- 소속은 `owns` 엣지(module→file)로 표현하며 **같은 라운드 동반을 지원**한다(§2-2a — 동반 권장·비강제.
  주의: "후속 라운드에서 엣지 보강" 대안은 성립하지 않는다 — 소화 기준점이 전진하면 그 파일이 다음
  라운드 입력에 다시 실리지 않으므로, 같은 라운드 결속이 유일한 실효 경로다).

### 2-2. 보강 연산 개방: enrich-result-v1에 `add_node` 허용

item 형태: `{"op":"add_node","payload":{"node":{...}},"evidence":[...]}` — targetId 금지(add_edge와
동형). node는 기존 `validateNode` 전문 검증(계약 갈림 방지 — 같은 함수).

#### 2-2a. 같은 라운드 신규 노드 참조(임시 id 결속) — 1차 blocker① 반영

- 모델은 add_node의 `node.id`에 **임시 UUID**를 부여하고, 같은 결과의 add_edge가 그 임시 id를
  endpoint로 참조할 수 있다.
- `validateEnrichResult`: 결과를 앞에서부터 훑으며 **"이번 결과에서 생성되는 노드 id" 집합을 실존
  집합에 순차 합류**(가상 topology) — add_edge endpoint는 (기존 노드 ∪ 앞선 add_node의 임시 id)면
  인정. **순서 제약**: 임시 id를 참조하는 item은 그 add_node보다 뒤에 와야 한다(적용이 cursor 순차라
  검증도 같은 순서 — 앞선 참조는 미실존 거부).
- `toPatchV2` 변환: 라운드 스코프의 **임시 id→결정론 id 매핑**을 유지한다 — add_node의 node.id를
  결정론 파생값(§2-2c)으로 교체하면서, 같은 결과의 add_edge payload에서 그 임시 id를 참조하는
  from/to도 **함께 재작성**한다(모델 id와 결정론 id가 갈리는 경로 차단 — 1차 실측 반례). 매핑에 없는
  미지 id는 기존 topology 실존 검사로 넘어간다(종전과 동일).

#### 2-2b. anchors 자격 — 판독 실존(1차 blocker② 반영)

- `node.entityType === "file"`만 허용(상위 구조 신설은 보강 권한 밖 — 부트스트랩·사용자 소관).
- `node.anchors`는 정확히 1개이며, 그 경로는 이번 라운드 발췌 파일 집합에 실존하고 **판독이
  성공하며 본문이 비어 있지 않아야** 한다 — 판정은 `excerptFilesFor`+`excerptBodyFor` 단일 경로
  재사용(answerableInput과 동형: 파일명 집합만 보면 "(판독 불가)"로 발췌된 삭제·빈 파일이 노드가 된다).
- `anchor.kind === evidenceKindOf(path)` 강제(kind 세탁 차단 — currentPatch 결속 계보와 동형).
- 이 검사는 **응답 검증(validateEnrichResult)과 변환 시점(toPatchV2) 양쪽**에서 수행한다(호출과 적용
  사이의 파일 소멸 — 재개 경로 포함 — 을 변환 재검사가 받는다. 기존 conversion 재판독 관례와 동형).
- `node.state.confidence`는 `candidate` 강제(태생 confirmed 금지 — 승격은 이후 라운드·검증 해소 소관).
- 같은 anchor 경로(§2-2c 정규화 후 전문 일치)의 file 노드가 topology에 이미 실존하면 그 item 거부
  (id 계열 오류 — 중복 노드 차단).

#### 2-2c. 결정론 node.id — case 보존(1차 blocker④ 반영)

- 파생식: 결정론 UUID(입력: mapId + "file-node" + 정규화 anchor 경로). 같은 지도·같은 파일이면 언제나
  같은 id — 경합 라운드의 이중 생성을 적용기 "id가 이미 존재" 거부와 이중 방어로 차단.
- **경로 정규화는 구분자 통일(`\`→`/`)만** — 대소문자는 원문 보존한다. case-fold는 Linux 등 대소문자
  구분 저장소에서 `src/A.ts`와 `src/a.ts`(별개 파일)를 같은 id로 합쳐 두 번째 노드를 영구 거부시킨다
  (제품은 macOS/Linux 지원·Ubuntu CI 실측 — 기존 map-bindings의 원문 case 보존 관례와 정합).
  Windows에서 같은 파일이 다른 case로 두 번 나타나는 희귀 경합은 적용기 id-존재 거부가 받는다.

### 2-3. 폭발 방지 상한 — 정본에서 강제(1차 blocker③ 반영)

- **지도 전체 file 노드 상한 60개**: 상수(`MAX_FILE_NODES`)와 검사를 **정본 `src/project-map.ts`의
  semanticValidateV2(add_node)에 둔다** — 적용 잠금(withMapLock) 안에서 그때의 topology로 강제되므로
  ①보강 외 일반 add_node 패치의 우회 ②"각자 59개를 보고 61개까지 적용" 경합이 모두 닫힌다.
  `map-enrich`의 검사는 **조기 진단·로그용**(호출 전 확실한 초과를 걸러 과금 절약)일 뿐 권위가 아니다.
- **라운드당** add_node 상한 5개: enrich-result 형태 검증에서 거부(fail-closed — 프롬프트가 상한을
  고지하므로 정상 모델은 걸리지 않는다).
- 상한 도달 거부는 보강 로그(appendRouteLog)에 남긴다(침묵 상한 금지).
- 슬라이스·발췌 상한(40/60/20)은 불변 — '변경 연결 우선' 규칙이 file 노드 증가를 자연 흡수한다.

### 2-4. 프롬프트 계약(단일 정본 관례 유지)

buildEnrichPrompt에 add_node 견본 1줄 추가:
- 허용 조건 고지: "발췌에 실린(판독 가능한) 파일 중 역할이 분명한 것만, 라운드당 최대 N개, entityType은
  file만, confidence는 candidate로, id는 임시값(변환기가 교체)" — 상한·유형 값은 상수에서 생성(어휘
  드리프트 봉합 계보와 동형: 하드코딩 복제 금지).
- 동반 권장: "만든 file 노드는 소속 모듈로의 owns 엣지를 같은 결과에서, add_node 뒤 순서로 제안하라".
- 기존 규칙(근거 code 계열 최소 1개·발췌 안 인용)은 add_node에도 동일 적용(공통 검증 경로).

### 2-5. 사고 자리 우선(우선순위는 입력이 이미 만든다)

별도 가중치 기계를 만들지 않는다. 근거: 보강 입력은 "지도가 마지막으로 소화한 시점 이후의 변경"
(과제 1 완결)이고, 그것이 곧 수리·사고가 일어난 자리다. 발췌에 실린(판독 가능한) 파일만 노드화할 수
있으므로(§2-2b), file 노드는 구조적으로 사고 자리부터 생긴다.
(v1의 "관찰일지 confirmed 결합이 보강 프롬프트에 힌트로 실린다" 전제는 **삭제** — 1차 보완 수용:
결합 동봉(scoutCouplingAttach)은 검증 ask 경로(map-reader) 전용이며 buildEnrichPrompt에는 실리지
않는다. 보강 프롬프트에의 결합 동봉은 별도 후속 판단 항목으로 남긴다 — v2 비목표.)

## 3. 비목표(v2 범위 밖)

- `split_node`/`merge_node`(edgeReroute 동반 대형 연산), 함수 수준 노드, 전면 파일 스캔 노드화,
  module 노드 자동 생성/개편, MAP.md 렌더러 개편(entityType은 그대로 표시), 기존 9노드·5엣지
  마이그레이션(추가만이라 불요), 관찰일지 결합의 보강 프롬프트 동봉(후속 판단).

## 4. 변경 지점(구현 예정 파일)

| 파일 | 변경 |
|---|---|
| src/project-map.ts(→sync bridge/) | ENTITY_TYPES에 "file" 추가 + `MAX_FILE_NODES` 상수 + semanticValidateV2(add_node)에 전체 상한 검사(잠금 안 권위 — §2-3) |
| bridge/map-enrich.js | validateEnrichResult: add_node 형태·판독 실존·candidate 강제·중복·라운드 상한·가상 topology 순차 실존(§2-2a) / toPatchV2: 임시 id→결정론 id 매핑+edge endpoint 재작성+판독 재검사 / 조기 상한 진단·로그 |
| bridge/enrich-providers.js | 프롬프트 add_node 견본+조건·상한 고지(상수 생성) |
| tests | p8-enrich-store(형태·중복·상한·순서 반례)·p8-enrich-run(e2e: file 노드+owns 동반 적용·결정론 id 재현·정본 상한 잠금 안 거부·판독 소멸 재검사)·p8-enrich-wire(프롬프트 고지=상수 일치)·map-patch-v2/map-apply-v2(semanticValidateV2 상한 반례)·project-map(ENTITY_TYPES 무회귀) |

## 5. 테스트 계획(구현 회차 인수조건)

1. e2e: add_node(file)+같은 라운드 owns 엣지(임시 id 참조) → 둘 다 적용, topology에 노드·엣지 실재,
   edge endpoint=결정론 id로 재작성 확인, confidence=candidate.
2. 거부 반례: 발췌 밖 anchor / 판독 불가·빈 본문 anchor / anchor.kind≠evidenceKindOf / entityType≠file
   / anchors 2개 / confirmed 태생 / 중복 anchor(기존 file 노드 실존) / 라운드 6개째 / 임시 id를 add_node
   보다 앞서 참조하는 add_edge.
3. 정본 상한: semanticValidateV2 — 60개째 허용·61개째 거부(보강 아닌 일반 add_node 패치 경로로도
   거부되는지 — 우회 차단 실증). 경합 시나리오: 59개 스냅샷 두 적용이 잠금 안 재검증으로 61 도달 불가.
4. 결정론 id: 같은 (mapId, 경로) 두 라운드 → 같은 id → 두 번째는 "이미 존재" 거부(이중 방어).
   case 반례: `src/A.ts` vs `src/a.ts` → 서로 다른 id(합침 없음).
5. 변환 시점 재검사: 응답 검증 통과 후 파일 삭제 → toPatchV2가 거부(conversion 재판독 관례 동형).
6. 프롬프트 고지 문구=상수 전문 일치(드리프트 잠금 계보).
7. 기존 스위트 전체 무회귀(특히 map-patch-v2·map-apply-v2·p8 계열).

## 6. 남는 위험(정직 고지)

- file 노드가 늘면 슬라이스의 '잔여 채움' 자리가 줄어 module 노드가 밀릴 수 있다 — 상한 60과 변경
  연결 우선이 완화하지만, 관측 후 슬라이스 우선순위(유형 가중)는 후속 판단.
- 모델이 상한·조건을 무시하면 item 거부→라운드 실패(answer-rejected)가 생길 수 있다 — 자동 재시도
  1회+input 자기치유가 받치고, 고지(§2-4)가 1차 방어다(어휘 드리프트 봉합에서 실증된 접근).
- 파일 삭제 시 file 노드는 잔존한다(lifecycle 전이는 기존 tombstone/검증 해소·사용자 경로 소관 —
  v2는 생성만 다룬다).
- 임시 id 매핑은 결과(라운드) 스코프뿐이다 — 라운드를 넘는 참조는 설계상 불가하며, 필요한 엣지는
  양끝이 실존 노드가 된 뒤의 일반 add_edge 경로가 담당한다.
