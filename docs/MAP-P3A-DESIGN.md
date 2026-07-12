# Project MAP v2 — P3a 권위 전환 '준비' 상세 설계 (정본 MAP-V2-DESIGN.md §5 P3a의 위임 이행 · 사전검증 12차 반영)

정본 §5 P3a가 고정한 범위 — legacy 이관 준비(dry-run→candidate 추출→멱등 매칭)·sig↔UUID 바인딩(1-24)·
기존 writer/reader의 v2 어댑터 — 를 구현 선택까지 닫는다. 이 문서는 정본을 덮지 않는다 — 충돌 시 정본이 이긴다.
불변 전제: **권위 marker 비활성 유지·기존 경로 100% 계속 작동·재배선은 P3b 원자 cutover에서 한 번에(1-22·1-30).**
표기: 해시 도메인 구분자는 문서에서 NUL로 표기하고 구현에서만 실바이트(P2 규약 준용).

## A. 범위·비-범위·실측 전제

### A-1. 범위 (정본 §5 P3a 3항목의 실체)
1. **sig↔UUID 바인딩 테이블(1-24)** — 후보(자동)·확정(사용자) 분리 저장, endpointsKeyOf 초기 후보 키.
2. **legacy 이관 준비** — docs/MAP.md 확정층의 dry-run 스캔→candidate 추출→topology 멱등 매칭(repo 읽기 전용).
3. **writer/reader v2 어댑터+준비 manifest** — 함수·테스트만 준비, 라우팅은 legacy 고정. P3b가 REQUIRED_SURFACES
   전수 검사 후 원자 전환.

### A-2. 비-범위 (P3b·P4·P9로 위임 — 이 문서에서 구현 금지)
- 재배선(내보내기·approve의 목적지 전환, docs/MAP.md 동결·deprecated 배너 — 1-22)
- 권위 marker '활성화'·자동 적용(1-30)·서사 표면 스윕
- collectCommon/동봉의 공용 reader API 완비(P4 — §E의 저수준 어댑터는 그 선행 재료·공용 API와 실배선은 P4/P3b)
- ab-retro 재기준선(1-25 — cutover 후에만)
- **confidence 승격(set_state confirmed)** — provenance 기록 방식(effectiveConfidence의 confirmed 권위 조건)과
  typed Verifier 결속이 선행돼야 하므로 P3a 승격 생성기에서 제외(1차 #6 — §E-W 참조). P9 카드/검증 흐름과 함께.

### A-3. 실측 전제 (2026-07-12 코드 실측 — 설계의 입력)
- 확정층 형식 단일 출처=src/map-ledger.ts: 승인 줄 `- ${text}  <!-- 승인 YYYY-MM-DD · 출처: ${from} -->`,
  왕복 정규식 parseApprovedFromMap(원문·날짜·출처 전부 보존), sig=normSig(공백 정규화+소문자).
- legacy writer 2: 내보내기(extension.ts ledgerAct export — trusted lane만·inMap 중복 방지·appendApproved) /
  approve(scope-reconcile.js — computePending→picked→appendApproved+state). reader 2: 대시보드 판독
  (readMapLedgerUncached — 관측 장부 1차·확정층은 inMap substring+승인 수 보조) / collectCommon(raw embed·절단만).
- 동봉(buildScoutAttach)은 확정층 무소비(정찰 지도+관측 장부) — 단 P4 대상 표면이므로 REQUIRED_SURFACES에는
  등재(ownerPhase:"P4" — 1차 #7).
- 현존 sig↔UUID 접점=EvidenceRef{kind:"ledger", ref:sig}(단방향·보조 연결·단독 근거 금지 — 1차 #6의 제약 원천).
- topology patch envelope는 code/test/config 증거 ≥1 필수(validatePatchV2 — ledger evidence만으로 불충족).
- set_state는 provenance를 기록하지 않아 저장 confidence=confirmed여도 effectiveConfidenceOf가 provenance
  부재로 강등 — 승격을 P3a서 만들면 '이름만 confirmed'가 됨(1차 #6 수용 근거).
- v1 decisions.jsonl: **현재 저장소에서 writer·실물 관측되지 않음. 존재 시(구 설치·사용자 저장소) P2 설계 §I의
  decisions/legacy/ quarantine 계약이 그대로 적용된다 — 종결이 아니라 관측 기록(1차 #10 정정).**
- sig 함수 패리티 쌍: normSig↔ledgerSig, extractPathsFromText↔ledgerPathsFromText(테스트 잠금 유지).
  endpointsKeyOf는 src/ledger-events.ts 정본 전용 → P3a가 bridge 사본+패리티 테스트 신설.

## B. 권위 판별 — 단일 함수 (1차 #1 전면 개정)

- **cutover marker 계약(P3b가 쓰기 주체·P3a는 판독만)**: repo `project-map/authority.json` =
  정확 키 집합 `{schema:"map-authority-v1", cutover:true, mapId(UUID — 현재 topology 세대와 일치 필수),
  decisionRef(cutover receipt의 decisionId — §B-1 실존+유효 결속), ts(ISO 8601)}`.
  잉여 키·누락 키·형식 위반=손상으로 판정.
- `authorityStateFor(repo)` → `{st:"legacy"}` | `{st:"v2", mapId}` | `{st:"blocked", reason}`:
  - **legacy = marker 부재(ENOENT) '그리고' cutover 이력 없음**. cutover 이력 검사: **전용 서랍
    `project-map/authority-history/`**(§B-1)에 파일이 하나라도 존재(판독 실패 포함) — 이력이 있는데
    marker만 없으면 **blocked**(marker 삭제로 전환 전 상태 복귀 차단 — 1차 #1).
  - v2 = marker 유효+cutover:true+mapId=현재 topology.mapId+decisionRef가 §B-1 receipt로 실존·유효·
    authorityFileFp가 현재 authority.json 파일 지문과 일치.
  - **blocked = 그 외 전부**(손상·판독불가·mapId 불일치·decisionRef 미결속·부재+이력 존재). blocked에서
    **권위 데이터 반환 금지** — v2 표면 거부·legacy도 권위로 제공하지 않는다. legacy 원문이 필요한 소비자는
    별도 `legacyPreviewFor(repo)`(비권위·진단 전용 표시 강제)로만 접근. 이관 관련 쓰기(binding-confirm 등)=거부.
- P3a 기간의 실상태: 이력·marker 모두 없으므로 항상 legacy — 기존 경로 100% 유지(무회귀).
- 소비자: P3a 신규 CLI·어댑터 함수 전부 이 함수 경유(개별 판독 금지 — 판별 단일화).

### B-1. cutover receipt — 전용 서랍·스키마 확정 (2차 #1·#2 개정)
- **저장 위치: repo `project-map/authority-history/<decisionId>.json` 전용 서랍** — decisions/에 두면
  decisionIndexFor가 전 파일을 validateDecisionV2로 검사해 색인이 st:error로 깨진다(실측: map-pipeline
  decisionIndexFor·schema:"map-decision-v2"만 허용). 전용 서랍은 P2 소비자(색인·guard·GC·복구기) 무접촉.
- **receipt 스키마(P3a에서 확정 — 판독기가 지금 필요·2차 #2·3차 #1)**: 정확 키 집합
  `{schema:"map-cutover-receipt-v1", decisionId(UUID — 파일명과 일치 필수), mapId(UUID),
  authorityMode:{from:"legacy", to:"v2"},
  authorityObject(활성화될 authority.json의 기대 '객체 전체 사본' — 재개 재료),
  authorityFileFp(그 canonical 직렬화 바이트의 sha1 — 기대 지문), ts(ISO 8601)}`. 잉여·누락 키=손상.
  **canonical 직렬화 규정**: authority.json 파일 바이트=`JSON.stringify(authorityObject, null, 1)`
  (P2 decision 파일과 동일 규약). **유효 receipt 검사(4차 #1 — 교차 결속 전체)**:
  authorityObject.schema==="map-authority-v1" ∧ cutover===true ∧ authorityObject.mapId===receipt.mapId ∧
  authorityObject.decisionRef===receipt.decisionId ∧ authorityObject.ts===receipt.ts ∧
  sha1(JSON.stringify(authorityObject,null,1))===receipt.authorityFileFp — 하나라도 위반=손상.
- **쓰기 순서 계약(P3b 구현 시 준수 — 선언)**: ①receipt 원자 기록 완료 → ②marker(authority.json) 원자
  활성화. marker가 receipt보다 앞선 상태는 존재할 수 없다 — authorityStateFor는 marker 존재+receipt
  부재/불일치=blocked로 판정한다.
- **중단 재개 절차(3차 #1 — 정상 중단 1회가 영구 blocked가 되지 않게)**: P3b cutover 명령은 시작 시 기존
  receipt를 발견하면(마커 부재·receipt 유효·mapId 일치) 새 receipt를 만들지 않고 **receipt.authorityObject를
  canonical 직렬화해 marker를 원자 보충**하는 재개 경로를 탄다(결정론 — 지문이 receipt.authorityFileFp와
  일치할 수밖에 없음). receipt 손상=수동 확인 안내(fail-closed 유지). **현재 mapId와 일치하는 유효 receipt가
  복수면 자동 선택 금지 — conflict 중단(수동 확인 안내. 시각 최신 선택 같은 자동 규칙 금지 — 4차 #1).
  재개는 정확히 1개일 때만.**
- 이력 검사: authority-history/ 안 판독 실패·손상 파일도 '이력 존재'로 간주(fail-closed — 삭제·손상으로
  legacy 복귀 불가).

## C. sig↔UUID 바인딩 테이블 (1-24)

### C-1. 저장 이원화 — 후보(로컬)·확정(repo)
- **후보(자동 산출물)**: `<BRIDGE_DIR>/map-bindings/<nsKey>/<mapId>/candidates.json` — repo 무접촉.
  **서랍 키=P2 canonicalIdentityFor의 nsKey**(realpath+gitCommon+branch — 1차 #9: wsKey는 별칭 미통합)+
  mapId 하위 네임스페이스(P2 map-pipeline 서랍과 동형).
- **확정(사용자 선택의 산물만)**: repo `project-map/bindings.json` — **수동 CLI 승인 명령만** 쓴다
  (실행=informed 동의 — P1 bootstrap 동일 패턴·PRIVACY 선갱신). canonical 정렬(sig 오름차순)+중복 거부 —
  파일 자체가 canonical(A1 계약 준용).
- 1-24 "매핑 없는 기존 entry는 증거층에 그대로": unmatched는 후보 파일에 기록될 뿐 어떤 강제도 없다.

### C-2. 형식 (1차 #2·#4·#5 반영)
```
candidates.json = { schema:"map-binding-candidates-v1", mapId,
  sourceRel: "docs/MAP.md"|"MAP.md",                                       ← 실제 판독 파일(폴백 결과 — 2차 #4)
  sourceFp: sha1(sourceRel 원문), topologyHash: mapHashOf(topology),        ← 양쪽 입력 결속(1차 #2)
  items: [ { candidateFp: sha1(sig NUL mapId NUL sourceFp NUL topologyHash NUL originalsFp NUL canonicalJson(match)),
             ← **항목 정체성=내용 지문(조회 키 통합 — 2차 #3: 사용자가 목록에서 본 지문만 확정 가능.
                별도 candidateId 없음 — 내용이 바뀌면 키가 바뀌어 낡은 선택이 조회 실패=재스캔 안내)**
             sig,   ← **항목당 sig 유일(3차 #2): 같은 normSig의 승인 행 복수는 한 후보로 '병합'** —
             originals: [ {text, date, from, entryFp: sha1(text NUL date NUL from)} ]  ← 원문 전량 보존
               (파일 등장 순서·첫 항목이 대표 표시), originalsFp: sha1(entryFp들을 NUL join),
             endpointsKey: string|null, paths: string[],  ← paths·endpointsKey는 대표(첫 행) 기준 —
               행마다 경로가 다르면 병합 불가이므로 {status:"unmatched", reason:"duplicate-sig-divergent"}
             match: {status:"matched", entityKind:"node"|"edge", targetId, matchQuality:"exact"|"case-fold"|"suffix"}
                  | {status:"ambiguous", entityKind:"node"|"edge", candidateIds:[...]}
                  | {status:"ambiguous", entityKind:"edge", reason:"endpoint-ambiguous", endpointCandidates:[nodeId...]}
                  | {status:"unmatched", reason:"no-paths"|"unresolved"|"multi-endpoint"|"no-entity"|"duplicate-sig-divergent"} } ] }
bindings.json  = { schema:"map-bindings-v1", mapId,
  bindings: [ { sig(기본키 — sig당 정확 1건: 확정=sig→target 함수. 1차 #4),
                endpointsKey: string|null, kind:"node"|"edge", targetId(UUID),
                originals: [{text, date, from, entryFp}],
                origin: {kind:"legacy-map", sourceRel, sourceFp}          ← 확정층 이관분(4차 #4)
                      | {kind:"live-approval", approvedAt(ISO), actionRef("export"|"approve")}, ← cutover 후 신규
                  ← live의 entryFp=sha1(text NUL approvedAt NUL from)·date=approvedAt.slice(0,10)
                source:"user-confirmed", candidateFp(확정 당시 지문), ts(ISO — 사용자 행위 기록),
                rebound: [ {prevTargetId, prevKind, prevCandidateFp, confirmedAt, reboundAt} ] } ] }
                ← rebound는 정확 키 스키마·오래된 것 먼저 append·ts는 최신 확정 시각으로 갱신(2차 #9)
```
- sig=normSig 단일 정규화(새 정규화 신설 금지). 같은 target을 여러 sig가 가리키는 것은 허용(1차 #4).
- **live 후보 서랍·지문(4차 #4·5차 #2·#3·6차 #2·#3)**: cutover 후 신규 승인 항목(promoteEntry
  needs-binding)은 **`<BRIDGE_DIR>/map-bindings/<nsKey>/<mapId>/live-candidates.json`에 durable upsert**
  (candidateFp 키 — 반환만으로 승인 행위가 소실되지 않는 1차 내구 지점. P3b 카드는 상위 UI/해소 계층).
  **재시도 멱등(6차 #2·7차 #1 개정)**: upsert 전에 **(mapId, sig) 동일·미종결 live 후보를 먼저 검색** —
  존재하고 **스키마·entryFp 유효 ∧ stored.topologyHash===현재 topologyHash**면 그 항목(최초 approvedAt·
  entryFp·candidateFp)을 재사용한다(응답 유실 후 재실행이 두 번째 후보를 만들지 않음 — sig=동일 지식 멱등
  키·actionRef는 인스턴스 키 아님). **topologyHash가 다르면 고착 금지(7차 #1)**: 최초 approvedAt·entryFp는
  보존하되 match·topologyHash·candidateFp를 현재 topology로 재계산해 항목을 교체하고, 교체된 이전 지문은
  항목 내 `prevFps` 감사 배열에 append — **동일 지문 중복 금지·최근 20개 유지(초과는 오래된 것 드롭 —
  감사 유계화, 8차 #4)**. 옛 fp로의 confirm은 조회 실패=재확인 안내(무한 거부 루프 차단). 신규일 때만
  이번 approvedAt으로 생성. **claimed 카드 재개 계약(8차 #3·9차 #3 — P3b 카드 구현의 전제를 P3a가 고정)**:
  후보 판독기는 fp 조회 실패 시 `(mapId, sig)` 보조 조회를 제공해 현재 후보를 반환하고, **동일 승인 판별은
  이중**: 1차=옛 fp가 현재 항목 prevFps에 포함 / 2차=**카드가 보존한 불변 (sig, entryFp, origin)이 현재
  항목의 originals·origin과 일치**(entryFp는 최초 approvedAt 보존으로 topology 변경을 넘어 불변 — prevFps
  상한 탈락 후에도 판별 가능·9차 #3: 20개 상한이 재개 보장을 끊는 반례 봉합). 어느 쪽이든 성립하면
  **{st:"stale-candidate", current}**. P3b 카드는 이 신호로 stale-candidate 전이 후 새 지문으로 재결속
  (자동 승계 아님·명시 재확인). prevFps 상한(중복 금지·20개)은 미참조 감사 이력에만 적용된다.
  **파일 스키마·잠금(6차 #3·7차 #3)**: 정확 top-level `{schema:"map-live-candidates-v1", mapId, items:[...]}`
  — 항목=candidates.json items와 동일 정확 키+origin+`status:"open"|"bound"`+`boundTargetId?`+`prevFps`·
  정렬=candidateFp 오름차순(canonical). 쓰기는 **nsKey 전역 후보 잠금 `<BRIDGE_DIR>/map-bindings/<nsKey>/.cand-global-lock` 하나**(11차 #1 —
  mapId별 잠금이면 세대 서랍 둘에 동시 진입해 전역 backpressure 상한을 초과하는 경합이 남는다: 세대별
  잠금을 폐기하고 후보·card-refs의 모든 쓰기와 전역 집계를 이 단일 잠금으로 직렬화. 로컬 소규모 파일이라
  성능 트레이드오프 없음. P2 .nslock과 별개 파일) 안에서
  **전 세대 서랍 판독(어느 하나라도 손상·판독불가=fail-closed 중단)→전역 상한 확인→재사용 검사→canonical
  upsert→원자 교체**(집계와 쓰기가 같은 임계구역 — 상한 초과 경합 원천 차단).
  **잠금 순서 계약(12차 #2)**: 허용=mapLock→cand-global-lock / cand-global-lock 단독. 금지=cand-global-lock→
  mapLock·cand-global-lock 보유 중 P2 .nslock 또는 카드 claim 잠금 취득(카드 claim은 ref 등록 완료·global
  lock 해제 후 수행). 잠금 계약은 P2 .nslock과 동형 전체: `{pid, token}` 스키마·alive/owner-unverified/unreadable/
  invalid/dead-valid 5상태 판정·자동 경로는 회수하지 않는 fail-closed·**pipelineGc가 mapLock 아래
  dead-valid만 재확인 후 격리 rename**(회수 경로 없이는 upsert 중 사망 1회가 신규 승인 영구 차단 — 7차 #3.
  P2 nsLock 격리 절차에 .cand-global-lock을 추가 등재). atomicWrite 단독은 lost-update를 막지 못함을 명기. 손상·
  판독 불가=덮지 않고 fail-closed.
  **종결 전이·GC(7차 #4·#6)**: binding-confirm 성공=항목 제거가 아니라 `status:"bound"+boundTargetId`
  **전이만**(카드 없는 CLI 경로가 binding 기록 후 proposal 전에 죽어도 재개 트리거 보존). 제거는
  **durable proposal 확인 시점**(promoteEntry가 {st:"patch"|"already-applied"|"already-pending"}에
  도달했을 때 잠금 안 동반 정리) 또는 P3b 카드 resolved. binding-list는 'binding 존재+target evidence/
  pending 부재' 항목을 **재개 대상**으로 표시(재개=promoteEntry 재호출). 잔존 정리(8차 #2 개정 — **미처리 승인은 삭제 금지**: open 후보는 '승인 행위의 유일한 내구
  기록'이므로 상한 삭제는 보존 계약 위반): pipelineGc는 **실제 종결분만** 정리 — bindings에 확정된 sig의
  bound 후보 중 proposal 확인이 끝난 것뿐. **이전 mapId 서랍의 미종결(open·bound-미확인) 후보는 삭제
  금지(9차 #2 — mapId 변경≠종결: binding·card·proposal 없는 승인이 옛 서랍에만 남아 있을 수 있다)** —
  stale 상태로 조회 가능하게 보존하고, binding-list가 이전 세대 서랍의 미종결 후보를 '이전 세대 미처리'로
  표시한다(해소=새 세대에서 재승인·재매칭 또는 binding-discard 명시 폐기). open 후보의 무한 증가는
  **backpressure로 차단**: **집계 범위=`<BRIDGE_DIR>/map-bindings/<nsKey>/*/live-candidates.json` 전
  세대 합산**(10차 #2 — mapId별 상한이면 세대 재생성마다 상한까지 쌓여 전체는 무제한: pipelineGc의
  mapId 단위 패턴을 이 집계에 복제하지 않는다). **집계·상한 확인·기록은 .cand-global-lock 단일 임계구역
  안**(11차 #1 — 두 세대 서랍 동시 진입 경합 차단). 어느 세대 서랍이든 판독 불가=신규 승인 fail-closed
  거부·보고에 현재/이전 세대별 open 카운트 병기. 합산 open 수가 상한(CODEX_BRIDGE_MAP_GC_KEEP 준용) 이상이면
  promoteEntry가 신규 승인을 {st:"rejected", reason:"backpressure"}로 거부하고 미처리 후보 정리(확정 또는 명시 폐기
  `binding-discard <candidateFp>` — open 전용·잠금 안 제거·감사 보고. **카드 참조 확인(9차 #4·10차 #1)**: 잠금 안에서 카드 참조
  등록 파일(`<서랍>/card-refs.json`)을 판독해 **candidateFp가 등록돼 있으면 거부**(dangling card 차단 —
  동반 취소는 P3b의 명시 취소 프로토콜로만). **card-refs 계약(10차 #1 — 모든 중단이 '과보호' 방향으로만
  떨어지게 순서 고정)**: 스키마=`{schema:"map-card-refs-v1", refs:[{candidateFp, cardId}]}`(candidateFp
  오름차순 canonical·쓰기는 .cand-global-lock 안 재판독→원자 교체 — 후보 파일과 같은 잠금 주체·12차 #1). 전이 순서:
  **등록은 카드 claim '전'·해제는 카드 resolved '후'** — ①등록 후 claim 실패=고아 참조가 후보를 과보호
  (유실 없음·pipelineGc가 카드 원장 대조로 카드 부재 참조를 해제) ②claim 성공·등록 전 중단은 순서상 존재
  불가 ③resolved 후 해제 전 중단=과보호(동일 GC 정리). **등록 전 재검사(11차 #2 — 삭제된 후보를 가리키는
  카드 차단)**: 등록 전이는 .cand-global-lock 안에서 후보·card-refs를 모두 재판독해 ⓐcandidateFp가 정확히
  1건 실존 ⓑstatus==="open" ⓒ카드가 보존할 (sig, entryFp, origin)이 후보와 일치 ⓓ같은 candidateFp의 활성
  cardId 부재(동일 cardId 재시도만 멱등) — 전부 통과 후에만 등록·등록 성공 후에만 카드 claim. 후보 부재·
  교체(fp 불일치)·bound=카드 claim 금지. **P3b 활성(authorityStateFor=v2) 후에는 card-refs
  손상·판독불가=fail-closed(discard 거부)** — P3a 기간(legacy·카드 계층 부재)에만 부재=참조 없음.
  **고아 참조 정리의 원장 대조 조건(11차 #3)**: P3b 활성 후 pipelineGc는 **카드 원장이 완전 판독(ok)된
  경우에만** 카드 부재 참조를 고아로 정리한다 — 원장 부재·손상·판독불가·중복 cardId=전부 참조 유지+진단
  보고(고아 오판이 discard 보호를 뚫는 반례 차단). refs는 (candidateFp,cardId) 쌍 중복 금지·cardId 형식
  (UUID) 검증 포함)를 안내한다 — 소실 없는 유계화.
  live entry의 entryFp=sha1(text NUL approvedAt NUL from NUL actionRef) — **actionRef("export"|"approve")가
  입력·entryFp·후보 항목에 전부 결속**(5차 #3).
  live candidateFp=sha1(sig NUL mapId NUL "live" NUL entryFp NUL topologyHash NUL canonicalJson(match))
  ("live" 리터럴=legacy 지문과 도메인 분리).
  **binding-confirm의 후보 판독 합타입(5차 #2)**: candidateFp를 ①legacy candidates.json ②live-candidates.json
  순서로 검색해 **정확히 1건**일 때만 진행 — 양쪽 중복·판독 불가=fail-closed 거부. 신선도 재검사도 원천별:
  legacy=sourceRel 규칙 재적용+sourceFp+topologyHash / live=topologyHash+entryFp(원문·actionRef 불변 검사).
- **mapId 세대 결속**: bindings.mapId ≠ 현재 topology.mapId → 전체 stale(소비 거부+재확정 안내). candidates 동일.
- **같은 세대 안 target 소멸(2차 #5)**: merge 흡수·split 원본 제거는 mapId 불변으로 일어난다 — 모든 소비자
  (approvedViewFor·promoteEntry·binding-list)는 **매 사용 시 target 실존+kind 재검사**하고 부재=해당
  binding만 stale 표시·제외한다(5차 #6 — 폐기 명칭 buildEvidencePatch 정정). successor 자동 승계 금지 —
  명시적 binding-rebind만.
- **재확정=같은 (sig,targetId)만 멱등 no-op. 다른 target으로 변경=`binding-rebind` 명시 명령 전용**(1차 #4 —
  감사 스키마는 위 형식 블록의 rebound가 유일 정본. 3차 #8).

### C-3. 결정론 매칭 규칙 (후보 추출기 — 1차 #8 반영: 해소·후보 2단 분리)
입력: parseApprovedFromMap(docs/MAP.md) entry들 + 현재 topology. 순수 함수(두 입력 → candidates 객체 —
시계 불참·재실행 바이트 동일).

**0단 — 공용 경로 정규화·대소문자 규칙(2차 #6·3차 #6)**: `normRelPath(p)` = 구분자 \→/ 통일·선행 "./"
제거·중복 "/" 축약. 절대 경로·".." 포함=미해소(repo-relative만). **entry 경로 추출은 원문 case 보존 변형을
map-bindings 안에 신설**(caseAwarePathsFromText — ledgerPathsFromText와 동일 토큰 규칙·소문자화만 생략.
기존 패리티 쌍은 불변 존치). **대조 규칙**: ①entry 경로와 anchors 경로의 case-exact 일치 유일=exact
②case-exact 0이고 case-fold(소문자 대조) 일치가 '정확히 하나'=matched(matchQuality:"case-fold") —
**단 case-fold는 자동 확정 대상이 아니다(4차 #2·#7): anchor 원문과 entry 원문의 대소문자가 다르면
대소문자 구분 저장소에서 서로 다른 경로일 수 있으므로 exact와 달리 사용자 명시 확인(--target) 필수.**
③case-fold 일치 복수(대소문자만 다른 anchors 공존)=ambiguous — 소문자 전역 대조 금지(3차 #6).

**1단 — path→node 해소(경로별 독립):**
1. `paths = caseAwarePathsFromText(text)` (**원문 case 보존 — 4차 #2: ledgerPathsFromText(소문자)는
   endpointsKey 계산에만 유지**. 두 함수는 토큰 규칙 동일·소문자화 여부만 다름 — 동형성 테스트로 잠금).
2. 각 path의 노드 해소: 정규화 대조로 anchors[].path 정확 일치 → 유일=`{node, quality:"exact"}` / 복수=ambiguous.
   0이면 **segment 경계 접미 일치 1회 폴백**: anchors path가 `(^|/)`+entry path로 끝나거나 그 역(경로 구분자
   경계 강제 — `a/b.js`≠`liba/b.js`, 1차 #8) → 유일=`{node, quality:"suffix"}` / 복수=ambiguous / 0=미해소.

**2단 — entry→entity 후보:**
3. **edge 후보**: `endpointsKey` 존재 '그리고' **서로 다른 endpoint가 정확히 2개**이며 **둘 다 단일
   node로 해소**된 경우에만 자동 후보 — from/to가 그 노드쌍인 edge를 검색: `d|`=방향 일치만, `b|`=양방향
   모두. 유일={status:"matched", entityKind:"edge", matchQuality=두 해소 quality 중 약한 쪽} / edge 복수=
   {status:"ambiguous", entityKind:"edge", candidateIds:[edgeId...]} / 0={status:"unmatched", reason:"no-entity"}.
   **경로(서로 다른 endpoint) 3+ = {status:"unmatched", reason:"multi-endpoint"} 단일 확정(2차 #6)**.
   endpoint 해소 실패={status:"unmatched", reason:"unresolved"} / **endpoint 해소 복수=
   {status:"ambiguous", entityKind:"edge", reason:"endpoint-ambiguous", endpointCandidates:[nodeId...]}
   (3차 #5 — edge 후보 candidateIds와 필드 분리: 한 필드에 edge/node UUID 혼재 금지)**. 합타입·알고리즘
   공히 키는 matchQuality로 통일(3차 #5).
4. **node 후보**(paths=1): 해소 유일=matched / 복수=ambiguous(entityKind:"node") /
   0={status:"unmatched", reason:"unresolved"}.
5. paths=0 = {status:"unmatched", reason:"no-paths"} — 1-24 '증거층에 그대로'.

### C-4. 확정 CLI (1차 #2·#3·#8 반영)
- `scope-map <repo> binding-confirm <candidateFp> [--target <uuid>]` — **조회 키=candidateFp(내용 지문 —
  사용자가 binding-list에서 본 그 세대만 확정 가능. 2차 #3: 재스캔이 match를 바꾸면 fp가 바뀌어 조회 실패=
  재스캔·재확인 안내. 파일 신선도와 별개의 '선택 세대 결속')**:
  - **동시성(1차 #3·3차 #9)**: P2 canonical identity 기반 `withMapLock` 안에서 — ⓪**pipelineBarrier·
    authorityStateFor 잠금 안 재검사**(활성/판독불가 P2 WAL=거부[부분 적용 topology를 정상 세대로 오인 차단]·
    blocked=거부 — 기존 canonical writer들의 '잠금 안 쓰기 직전 barrier' 계약과 동형) ①candidates 재판독+
    **신선도 재검사**(sourceRel 규칙 재적용 결과가 파일 기록값과 일치: 우선순위 높은 파일 신설도 stale(2차
    #4)·sourceFp·topologyHash 재계산 일치 — 불일치=재스캔 요구 거부(1차 #2)) ②candidateFp로 항목 조회
    (부재=거부) ③bindings.json 재판독(잠금 안) ④검증 ⑤canonical 재직렬화 원자 교체. 잠금 실패·판독 불가=
    쓰기 금지(fail-closed).
  - target 결정(4차 #7 단일 계약): **--target 생략 가능=match.status="matched" ∧ matchQuality="exact" 유일뿐.
    case-fold·suffix·ambiguous·unmatched 전부 --target 필수**(암묵 확정 금지). **--target은 후보 집합 밖
    UUID도 허용**(수동 지정=명시 행위 — 2차 #6): 검증은 현재 topology 실존+entity 종류 판별(nodes/edges
    어느 쪽 실존인지가 kind의 출처).
  - sig 기본키: 동일 (sig,targetId) 재확정=멱등 no-op 보고. 기존 sig가 다른 target에 결속돼 있으면 거부+
    `binding-rebind` 안내(1차 #4).
- `scope-map <repo> binding-rebind <candidateFp> --target <uuid>`: **조회 키=candidateFp만(3차 #3 — sig
  경로는 사용자가 본 후보 세대 지문이 없어 선택 세대 결속을 우회한다. target 소멸 등으로 후보가 낡았으면
  legacy-scan 재실행 후 새 candidateFp로)**. 항상 --target 필수. 기존 레코드의 {prevTargetId, prevKind,
  prevCandidateFp, confirmedAt}을 rebound[]에 append(오래된 것 먼저) 후 본문 교체·ts 갱신(2차 #9).
  동시성·신선도 계약은 confirm과 동일. (cutover 후 후보 없이 기존 binding만 대상으로 하는 rebind가 필요해지면
  bindingFp CAS를 받는 별도 명령을 P3b에서 설계 — P3a는 candidateFp 단일 경로.)
- `scope-map <repo> binding-list [--json]`: 후보·확정·stale·진행률 보고(읽기 전용).
- 모든 신규 CLI: scoutMode 게이트 최선행(off=거부·파일 생성 0). authorityStateFor=blocked면 확정·rebind 거부.

## D. legacy 이관 준비 — dry-run 스캔

- `scope-map <repo> legacy-scan [--json]`:
  1. docs/MAP.md 판독(mapLedgerFile 경로 규칙 동일: docs/MAP.md→MAP.md 폴백) — 부재=정상 종료(카운트 0·후보 파일 생성 없음).
  2. topology 판독(부재·손상=진단 종료 — 후보 생성 없음). **활성 P2 WAL 존재=후보 생성 보류**(3차 #9 —
     부분 적용 세대로 후보를 만들면 사용자가 낡은 선택을 하게 됨. recoverWal 안내).
  3. §C-3 추출기 실행 → candidates.json 원자 갱신(로컬 서랍만 — **repo에는 어떤 쓰기도 없다**).
  4. 보고: 총 entry/exact/suffix/모호/무매칭 카운트+확정 진행률(bindings 대비).
- P3b 소비 계약(선언만): candidates의 ambiguous+unmatched(+suffix 미확정) 목록이 1-22 '이관 판정이 모호한
  것만 intent-choice'의 입력. P3a는 목록 산출까지.
- 관측 장부(JSONL)는 스캔 대상이 아니다 — 확정층(사람 승인분)만 이관 후보. 장부는 증거층 존치(1-25).

## E. v2 어댑터 — 함수·테스트만 준비(라우팅 무변경)

신설 bridge/map-adapters.js. 모든 함수는 authorityStateFor 경유(§B) — P3a 기간엔 항상 legacy 분기.

- **R1 대시보드 확정층 뷰**: `approvedViewFor(repo)` → `{source:"legacy"|"v2"|"blocked",
  approved:[{text,date,from}], totalItems}`.
  - legacy=현행 parseApprovedFromMap 결과 그대로(동치 잠금 테스트).
  - v2=**bindings.json의 originals 사본에서 직접**(대표 행 {text,date,from}+복수 행 전량 — legacy 파일
    역참조·label 합성 금지, 1차 #5·3차 #2)+target entity 실존·lifecycle 검사(tombstoned/superseded 대상은
    표시 플래그)·신규 승인 항목은 promoteEntry가 기록한 binding으로 즉시 표시됨(3차 #4).
  - blocked=빈 approved+사유(권위 데이터 반환 금지 — §B. 진단 표시는 legacyPreviewFor 별도).
- **R2 collectCommon 재료**: `mapContentFor(repo)` → legacy=docs/MAP.md raw(현행 동치) / v2=project-map/MAP.md
  raw / blocked=null+사유. 절단은 소비자 계약 그대로.
- **W writer 어댑터(1차 #6 축소·3차 #4·4차 #3·#5·#8 개정)**: `promoteEntry(repo, entry, opts)` —
  entry={text, from, approvedAt(live)| originals(legacy)}. **binding을 기록하지 않는다**(4차 #3 — 1-24
  '후보 제시·확정 분리': export/approve 모달·목록 선택은 '문구 승격' 확인일 뿐 UUID target 확인이 아니다.
  binding 기록은 언제나 binding-confirm[사용자 target 확인] 단일 경로):
  ```
  promoteEntry → {st:"patch", patchId, patch}        ← **기존 확정 binding이 있을 때만**: proposePatch로
                                                        durable pending 영속화까지 완료 후 반환(4차 #5)
              | {st:"already-applied", targetId}     ← target entity에 같은 ledger evidence 실존(5차 #5)
              | {st:"already-pending", patchId}      ← 동일 patchId pending이 proposed|classified|claimed
              | {st:"retry-required", patchId}       ← 동일 patchId pending이 lifecycle:"expired"뿐(6차 #5)
                                                        — 새 세대 재제안 필요(생성 입력 갱신=새 patchId)
              | {st:"needs-binding", entry:{text,from,approvedAt,actionRef,sig}, candidateFp, match}
                                                     ← binding 부재(매칭 품질 무관 — exact여도): live 후보
                                                        서랍에 durable upsert 후 반환(5차 #2 — §C-2)
              | {st:"rejected", reason}              ← 증거 채택 0·topology 부재·blocked·활성 WAL
  ```
  **활성 promotion 선검색+원자 기록(7차 #2·8차 #1)**: 의미 키 검색과 proposal 기록을 분리하면 검색 사이
  경쟁으로 동일 승인의 활성 pending 2건이 여전히 가능하다(proposePatch의 .nslock은 patchId 파일 하나의
  멱등만 보장 — 실측). 따라서 **map-pipeline에 P3a 확장 API `proposeUnique(repo, mapId, semanticKey,
  buildPatch)`를 신설**한다: **하나의 nsLock 임계구역 안에서** ①pending 전 파일을 의미 키
  (mapId, targetId, payload.evidence.ref=ledger sig)로 검색(손상·판독 불가 pending=건너뛰지 않고
  fail-closed 중단 — **'손상'의 정의(10차 #3)**: JSON 판독 실패만이 아니라 schema!=="map-pending-v2"·
  lifecycle이 허용 enum 밖(미지 lifecycle을 '활성도 expired도 아님'으로 건너뛰면 신규 proposal 이중 생성)·
  patch 부재 또는 validatePatchV2 실패·파일명↔patch.patchId 불일치·claimed인데 claim {pid,token,decisionId}
  불완전 — 전부 fail-closed. 동일 의미 키의 resolved|resolved-noop 존재+target evidence 부재=진단 대상
  conflict) ②활성(proposed|classified|claimed) 정확 1건={st:"already-pending", patchId}(base가
  달라도 P2 read-set 보존 rebase에 위임)·복수=conflict ③expired만 존재 또는 부재일 때에만 buildPatch()로
  patch를 생성해 같은 잠금 안에서 수납. **API 내부 강제(9차 #1 — semanticKey 파라미터를 신뢰하지 않는다)**:
  buildPatch() 결과에 대해 ⓐvalidatePatchV2 전체 통과 ⓑpatch.mapId===mapId ⓒoperation==="add_evidence"
  ⓓpayload.evidence.kind==="ledger" ⓔ**patch에서 재산출한 (mapId,targetId,payload.evidence.ref)가 검색에
  쓴 의미 키와 정확 일치**(불일치=거부 — 호출부 실수로 A 키 검색 후 B 키 patch 기록하는 우회 차단)
  ⓕpatchId 파일 기존재 시 기존 proposePatch와 동일한 내용 멱등 검사. buildPatch 예외·검증 실패=잠금 해제
  후 {st:"error", reason} 합타입 반환(잠금 누수 금지). promoteEntry의 patch 경로는 proposePatch 직접 호출이
  아니라 이 API만 사용한다(비중첩 유지 — mapLock 불참·nsLock 단독).
  **결정론 patchId(5차 #1·6차 #1 개정)**: promotion patch는 **patchId를 제외한 모든 필드를 먼저 확정**
  (basis·baseMapHash·baseAuthorityHash·baseDecisionContextHash·readSet·evidence·payload 전부)한 뒤,
  그 canonicalPatchV2 사본(patchId 자리=빈 고정값)의 sha1=**generationFp**의 앞 32hex를 UUID 8-4-4-4-12로
  포맷해 patchId로 쓴다 — 어떤 생성 입력이 바뀌어도 새 patchId 세대가 파생된다(6차 #1). 같은 상태의
  재시도는 전 필드 동일→같은 patchId→(patchId+opHash) 멱등 안착.
  **binding 결속(6차 #4·7차 #5 개정)**: bindings.json은 **patch.evidence가 아니라 readSet.files에만**
  결속한다 — 실측: buildReadSetFor는 `patch.readSet.files`에 미리 든 ref를 E 지문 집합에 편입하는 경로를
  이미 갖고 있어(map-pipeline buildReadSetFor — evidence 합집합에 readSet.files ref 추가) 스키마 무변경으로
  가능하며, evidence에 넣으면 decision.evidenceFps에 권위 증거로 영구 기록돼 이후 무관한 binding 변경이
  그 decision의 파일 증거를 낡게 만든다(7차 #5). 부작용 명기: bindings.json은 단일 canonical 파일이므로
  **무관한 sig의 confirm도 pending promotion을 stale-expired로 만들 수 있다** — 이는 재제안(promoteEntry
  재호출→expired만 존재→새 세대)으로 복구되는 안전 방향의 마찰이며, sig별 파일 분리는 sig 기본키 canonical
  단일 파일 계약(1차 #4)과 충돌해 채택하지 않는다(정확성>편의 — 1차 방어는 아래 rebind 거부). 동시에
  **binding-rebind는 해당 sig의 미종결 promotion pending(proposed|classified|claimed)이 있으면 거부**
  (pending 파일 판독만 — 잠금 불요·비중첩 유지. 안내: 먼저 pending 종결/만료 후 rebind).
  **resolved proposal 존재+target evidence 부재=진단 대상(conflict 보고 — 자동 완료 판정 금지, 5차 #5).
  pending lifecycle 어휘(6차 #5): 상태는 "expired"뿐 — "stale"은 상태가 아니라 원인·disposition 명칭
  (stale-expired)으로만 사용.**
  **needs-binding 종결 프로토콜(P3b 구현·P3a가 계약 고정 — 5차 #4)**: ①카드(또는 CLI 세션) claimed →
  ②binding-confirm(candidateFp CAS — §C-4) → ③같은 entry로 promoteEntry 재호출(binding이 이제 존재 →
  patch 경로·결정론 patchId로 멱등) → ④durable proposal 확인(already-pending 포함) → ⑤카드 resolved.
  각 단계는 같은 candidateFp/patchId로 결속·재실행은 최초 미완료 단계부터 전진. 중단점 판정: binding 있음+
  proposal 없음=③부터 / proposal durable+카드 미종결=④ 확인 후 ⑤ / proposal 실패=카드 resolved 금지 /
  카드 무관 binding-confirm 선행=재개 시 binding 존재로 ③부터 정상 전진(동일 경로 — 별도 분기 없음).
  manifest의 writer ready 정의: '승인 행위가 durable 상태에 도달 가능'까지 — P3a는 합타입·live 후보 서랍·
  durable proposal 경로·테스트를 완비하고, 카드 UI·재개 배선은 P3b 몫(이 프로토콜이 그것을 가능하게 함).
  patch 형식(3차 #7 정정): `add_evidence`의 payload는 **`{evidence:{kind:"ledger", ref:sig}}`**
  (PAYLOAD_KEYS_V2가 evidence 키만 허용 — 실측 정정. 이전 표기 {kind,ref} 직접 배치는 validatePatchV2
  불통과). envelope evidence는 entry paths 중 **실존+분류 통과** 경로 — **분류 규칙 고정(3차 #7)**:
  판정 우선순위 `test > config > doc > code > unsupported` — ①test: 경로 세그먼트에 test/tests/spec/
  __tests__ 또는 파일명에 .test./.spec. ②config: 확장자 json/yml/yaml/toml/ini/cfg/conf 또는 **basename이
  .env·.env.***(4차 #6) ③doc: 확장자 md/txt/rst/adoc ④code: **소스 확장자 명시 열거** — js/ts/jsx/tsx/mjs/
  cjs/py/rb/go/rs/java/kt/c/h/cpp/hpp/cs/php/swift/sh/ps1/sql/vue/svelte(카테고리 확장은 개정으로만)
  ⑤**unsupported: 어느 분류에도 안 드는 파일(바이너리·데이터·무확장자 등)=증거 채택 불가**(4차 #6 —
  '그 외 전부=code'는 임의 파일을 코드 증거로 승격). **code/test/config만 evidence 채택 — 채택 0이면
  rejected**(단순 실존≠code 증거). basis·readSet·3해시는 P2 제안 생성 규칙 공유. 기존 binding 항목의 patch 재생성은
  `promoteEntry`가 binding.originals 대표 행으로 동일 경로를 탄다(별도 함수 불요). **P3a에서는 어떤
  배선도 하지 않는다** — 호출 전환은 P3b(단 함수·합타입·테스트는 완비 = manifest ready의 실체).
- **REQUIRED_SURFACES(고정 집합 — 1차 #7)**: P3b 전수 검사의 정본 표. manifest(자기신고)와 분리.
```
REQUIRED_SURFACES = [   // file·fn·목적을 실호출부로 정확 기록(2차 #8)
  { id:"dashboard-approved",  ownerPhase:"P3a", legacyFile:"src/extension.ts",          legacyFn:"readMapLedgerUncached→parseApprovedFromMap", v2:"approvedViewFor" },
  { id:"package-map-content", ownerPhase:"P3a", legacyFile:"scripts/scope-package.js",  legacyFn:"collectCommon(mapContent raw embed)",        v2:"mapContentFor" },
  { id:"ledger-export",       ownerPhase:"P3a", legacyFile:"src/extension.ts",          legacyFn:"ledgerAct export→appendApproved",            v2:"promoteEntry" },
  { id:"reconcile-approve",   ownerPhase:"P3a", legacyFile:"scripts/scope-reconcile.js", legacyFn:"approve→appendApproved",                     v2:"promoteEntry" },
  { id:"scout-attach",        ownerPhase:"P4",  legacyFile:"bridge/contract-lib.js",    legacyFn:"buildScoutAttach",                            v2:null },
  { id:"gate-map-reader",     ownerPhase:"P4",  legacyFile:"bridge/scout-gate.js",      legacyFn:"scoutMapStatus 소비(플랜 게이트 preflight)",   v2:null },
]
ADAPTER_MANIFEST = { surfaces: [{id, ready:boolean, fn}] }   ← 구현 상태(자기신고)
```
  (2차 #8 정정: 'scope-gate 소비'는 부정확 — scripts/scope-gate.js는 설정 온오프뿐, 실제 지도 preflight
  소비자는 bridge/scout-gate.js의 scoutMapStatus 호출이다.)
  P3b 검사 계약(선언): REQUIRED_SURFACES와 manifest의 **집합 정확 일치**+**전 표면 ready=true 단순 규정**
  (2차 #8 — ownerPhase 비교식 폐기: 실행 순서가 P3a→P4→P3b라 P3b 시점엔 P4 표면도 완료돼 있어야 하며,
  ownerPhase는 책임 단계 표기일 뿐 검사 조건이 아니다). 하나라도 어긋나면 cutover 거부.

## F. 2트랙·무회귀·문서

- 신규 진입점(legacy-scan·binding-confirm·binding-rebind·binding-list·binding-discard) 전부 scoutMode 게이트 최선행 —
  off=거부·파일 생성 0 끝단 테스트.
- 기존 경로 무변경 증명: export/approve/readMapLedger/collectCommon 기존 테스트 무손상+
  approvedViewFor(legacy)≡parseApprovedFromMap 동치 단언.
- PRIVACY(ko)·README(ko) 선갱신(1-23): map-bindings 로컬 서랍 행·project-map/bindings.json(수동 확정 시에만
  생성) 행·legacy-scan은 저장소 읽기 전용 명시.
- 임의 시간 상수 신설 없음. ts는 사용자 행위(확정·rebind) 기록에만.

## G. 완료 조건
- bridge/map-bindings.js(추출기·저장·확정)+bridge/map-adapters.js(어댑터·REQUIRED_SURFACES·manifest)+
  scope-map CLI 5명령+endpointsKeyOf bridge 사본+패리티 테스트.
- BRIDGE_SCRIPTS 갱신(+2파일=13)+hook-setup.ts/install.js 쌍+패리티 테스트.
- 테스트: 결정론(같은 입력=바이트 동일)·candidateFp 조회=선택 세대 결속(재스캔 후 옛 fp 조회 실패)·
  sourceRel 폴백·우선순위 파일 신설=stale·mapId stale·같은 세대 target 소멸=stale 제외·동일 sig 복수 행
  병합(originals 전량 보존)·경로 발산 행=duplicate-sig-divergent·suffix는 --target 필수·후보 밖 --target
  실존 판별·sig 기본키/rebind 감사 스키마·rebind는 candidateFp만·동시 confirm 직렬화·confirm의 잠금 안
  barrier/authority 재검사(활성 WAL=거부)·scan의 활성 WAL 보류·ambiguous 합타입(endpoint-ambiguous 분리)·
  case-exact/case-fold/대소문자 공존=ambiguous·d|/b| 방향·multi-endpoint 단일 확정·경로 분류 우선순위
  (doc만=rejected·unsupported 제외·.env basename)·promoteEntry 6분기 합타입(needs-binding에 exact 포함·
  already-applied/already-pending/retry-required 분리·resolved+evidence 부재=진단·patch=durable proposal
  완료)·결정론 patchId=generationFp 전체 파생(정책/색인/basis 변경도 새 세대·같은 상태 재시도=멱등)·
  promotion readSet.files에 bindings.json 결속(rebind→CAS stale-expired·evidence 비오염)·rebind는 미종결
  promotion 존재 시 거부·proposeUnique 원자 임계구역(동시 진입=활성 1건만 생성·손상 pending=fail-closed·활성 1건=already-pending·
  복수=conflict·expired만=새 세대)·open 후보 backpressure(상한 도달=rejected·소실 없음)·binding-discard·
  prevFps 유계(중복 금지·20개)·(mapId,sig) 보조 조회=stale-candidate 신호·live 후보 서랍 upsert+(mapId,sig) 재시도 멱등(approvedAt 재사용)·topologyHash 불일치=재계산
  교체+prevFps 감사(고착 루프 차단)·live 후보 잠금(.cand-global-lock 5상태·dead-valid GC 격리·동시 upsert
  lost-update 차단)·live 스키마 정확 키(status/boundTargetId/prevFps)·bound 전이(confirm=제거 아님·재개
  트리거 보존)·open 상한 도달=신규 rejected(backpressure — 기존 open 바이트 불변)·이전 mapId 미종결 후보 보존·
  card-refs 참조 시 discard 거부·entryFp 2차 판별(prevFps 탈락 후 stale-candidate)·proposeUnique 내부
  강제(의미 키 재산출 대조·오류 합타입·미지 lifecycle=fail-closed·파일명 불일치=fail-closed)·
  backpressure 전역 합산=단일 잠금 임계구역(두 세대 동시 진입 경합 차단·판독 불가 서랍=fail-closed)·
  card-refs 순서 계약(등록=claim 전·해제=resolved 후·등록 전 후보 재검사 4조건·P3b 활성 후 손상=
  fail-closed·원장 완전 판독 시에만 고아 정리)·card-refs 유일성(한 cardId가 두 candidateFp=거부·한
  candidateFp에 활성 cardId 둘=거부·GC는 원장 (cardId,candidateFp) 결속까지 대조·canonical 정렬/유일성
  위반=정리 금지 진단 — 12차 #3)·binding-confirm 이원 판독(legacy/live·중복=fail-closed)·
  actionRef 결속(entryFp 포함)·binding 미기록(1-24 분리)·
  case-fold는 --target 필수·
  1단 입력=caseAware(소문자 추출기와 동형성)·receipt 교차 결속 전체·복수 receipt=conflict·
  payload={evidence:{...}} 형식·blocked fail-closed(권위 데이터
  미반환·marker만 존재+receipt 부재=blocked)·이력 존재+marker 부재=blocked·receipt 재개(authorityObject
  보충=지문 일치)·2트랙·legacy 동치·evidence patch가 validatePatchV2+②b 통과.
- 전체 체인(2052)+신규 전부 통과 → Codex 검증 → 설치 → 로컬 커밋. 버전 0.1.86 불변.
