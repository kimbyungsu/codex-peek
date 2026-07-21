# Project MAP v2 — P3b 원자 cutover 상세 설계 (정본 MAP-V2-DESIGN.md §5 P3b·1-22·1-30의 위임 이행)

정본 §5 P3b가 고정한 범위 — 전수 검사 후 strict lock 안 권위 marker 활성화+legacy 쓰기 동결(재배선 1-22)+
자동 적용 활성화(1-30)+서사 표면 스윕 — 를 구현 선택까지 닫는다. 이 문서는 정본과 MAP-P3A-DESIGN.md(§B
marker/receipt 계약·§E 검사 계약·§E-W 종결 프로토콜)를 덮지 않는다 — 충돌 시 그쪽이 이긴다.
불변 전제: **버전 0.1.86 불변·push 금지·2트랙 무회귀(scoutMode off=무접촉)·한/영 쌍(tB)·프로젝트별 분리
(marker=repo 파일·서랍=nsKey)·시작 폴더≠실질 작업 폴더 추적(모든 표면은 resolveScoutRepo/scoutTargetFor의
실효 대상 기준 — ws 직접 사용 금지).**

## A. 범위·비-범위·실측 전제

### A-1. 범위 (두 증분)
1. **증분 1 — 소비처 일괄 재배선**: 6표면(REQUIRED_SURFACES)이 전부 v2 어댑터를 '경유'하도록 호출 전환.
   어댑터가 authorityStateFor로 분기하므로 **marker 비활성인 동안 행동은 legacy와 100% 동치**(동치 잠금
   테스트) — 이렇게 해야 marker 활성화 한 번으로 모든 읽기·쓰기 경로가 동시에 바뀐다(§5 P3b '유일 정본
   선언 지점').
2. **증분 2 — cutover 명령+동결+스윕**: `scope-map <repo> cutover`(검사→스냅샷→receipt→marker→read-back),
   applyPatch의 자동 적용 활성화(v2에서 --pre-cutover 요구 해제), docs/MAP.md deprecated 배너,
   PRIVACY/README 서사 스윕.

### A-2. 비-범위 (이후 Phase로 위임 — 이 문서에서 구현 금지)
- intent-choice/needs-binding 카드 UI(P9 — CLI 안내 문구까지만), ab-retro 재기준선(1-25 — 사용자 합의 항목),
  provider 3모드(P5~P8), 서사 표면 중 '카드' 신설류 일체.
- confidence 승격 생성기(P3a §A-2와 동일 사유).

### A-3. 실측 전제 (2026-07-21 코드 실측)
- authorityStateFor/validReceipt/authorityHistoryExists/captureAuthorityRaw = bridge/map-bindings.js에 구현
  완료(P3a) — cutover는 **판정 재사용·쓰기만 신설**(판정 로직 중복 구현 금지).
- adapterManifest()/REQUIRED_SURFACES = bridge/map-adapters.js — P4 표면 2개 포함 6표면 전부 ready 상태.
- applyPatch(bridge/map-pipeline.js 401)= `--pre-cutover` 명시 필수(§A 비활성 계약)가 유일한 활성화 게이트.
- 6표면 현재 호출부:
  ① dashboard-approved: src/extension.ts readMapLedgerUncached 2743 `parseApprovedFromMap(mapMd)` —
    대상은 mapLedgerFile(ws)=scoutTargetFor(ws).repo 기준(이미 실효 대상 추적).
  ② package-map-content: scripts/scope-package.js 163-167 docs/MAP.md 직접 판독(repo 인자 기준).
  ③ ledger-export: src/extension.ts 3185-3200 `appendApproved`+atomicWrite(mapLedgerFile(ws)).
  ④ reconcile-approve: scripts/scope-reconcile.js 196-207 `appendApproved`+atomicWrite(mapFile()).
  ⑤ scout-attach: bridge/codex-bridge.js 48 `buildScoutAttach(ws||configWs(), c, lang)` —
    buildMapAttach(bridge/map-reader.js)는 이미 '비v2=buildScoutAttach 위임(바이트 동일)' 계약으로 구현됨.
  ⑥ gate-map-reader: bridge/scout-gate.js 57 `scoutMapStatus(target)` — target=resolveScoutRepo(ws,c).repo.
- extension.ts는 bridgeLib()(~/.codex-bridge 배포 사본 require+typeof 가드) 패턴 보유(1-15).
- **배포 목록 결함(실측·P3b에서 봉합)**: BRIDGE_SCRIPTS(install.js 45)=16파일에 map-adapters.js는 있으나
  **P4 신설 map-reader.js·map-freshness.js가 누락** — 배포 사본의 map-adapters가 `require("./map-reader.js")`
  (177행)에서 즉사해 설치본 어댑터 전체가 로드 불능(레포 실행 테스트에는 안 잡힘). P3b 증분 1에서 +2(=18)
  등재+hook-setup.ts 쌍 갱신(1-15 트리거: BRIDGE_SCRIPTS는 배포 파일 추가 시 — 훅 entrypoint 아님이므로
  OUR_HOOKS 불변)+패리티 테스트 반영.
- scope-reconcile approve는 `out/map-ledger.js`(tsc 산출물)를 require — bridge 모듈 require 추가 가능(동일
  프로세스·개발 레포 전용 진입점).

## B. 증분 1 — 소비처 재배선 계약 (표면별)

공통 원칙: **(a) 낡은 런타임 폴백=fail-closed**(1차 #8→2차 #1·#2 수용으로 강화) — 폴백 분기는 '새 확장·
새 CLI+낡은/손상 브릿지 사본' 조합에서만 발동한다(구 설치본에는 이 분기 자체가 없음 — 무회귀 논점 아님).
**쓰기 표면**: 어댑터·map-runtime require 실패로 withMapLock 재판정이 불가능하면 **쓰기 자체를 거부**+고지
("MAP 런타임 판독 불가 — node install.js 후 재시도". check-then-write 경합은 잠금 없이는 봉합 불가하므로
검사-후-쓰기 폴백은 채택하지 않는다 — 2차 #1). **읽기 표면**: require 실패 시 대상 repo의
`project-map/authority.json` '또는' `project-map/authority-history/`(비어있지 않음)를 fs로 원시 검사
(2차 #1 — receipt-only 상태 포함) — **어느 쪽이든 존재=legacy 데이터 공급 금지**(사유 표시: 대시보드=
blocked 표기·package=mapContent null+blocked 메타·attach=고지 attach·gate=통과+로그), 둘 다 부재=기존
legacy 판독(권위 역행 없음 — 2차 #2). **(b) blocked=fail-visible** — 권위 데이터 반환 금지(§B): 읽기
표면은 '판독 불가+사유' 표시(빈 정상·legacy 위임으로 위장 금지 — 전 표면: attach·gate 포함. **reader의
일시 실패(lock·flap)도 marker 세대 판정 불가이므로 legacy 위임 금지 — 사유 반환**(2차 #2: legacy/none
판정이 확인된 경우에만 위임)), 쓰기 표면은 거부+사유. **대시보드 mapText**: blocked면 원문 미리보기 숨김+
사유만(정본 §B가 blocked에서 허용하는 건 legacyPreviewFor 진단 전용뿐 — 전용 표시는 P9로 위임·지금은
숨김이 보수). **(c) 2트랙** — scoutMode≠on이면 표면 자체가 기존처럼 무동작/카드 숨김(어댑터 호출 0).
**(d) 실효 대상** — 모든 판정·기록은 scoutTargetFor/resolveScoutRepo 결과 repo 기준(ws 직접 금지 — 실측
전제상 ①③⑤⑥은 이미 충족·②④는 repo 인자 진입점이라 해당 없음). **(e) legacy 쓰기=정본 잠금 참여**
(1차 #1 수용) — export/approve의 legacy 분기 쓰기는 withMapLock 안에서 'authorityStateFor 재판정 → legacy
확인 시에만 기록'(marker 활성과 legacy 쓰기 동결이 같은 잠금으로 직렬화 — 1-30 원자성. bindings 확정은
이미 withMapLock 경유[map-bindings.js confirmBinding·rebindBinding — 1차 #1 해당 반절은 실측 반박]).
**(f) 사유의 한/영**(1차 #11→2차 #7 수용으로 확장) — `reasonKey`(안정 식별자) 병행 반환을 **어댑터 전
표면에 일괄 적용**: authorityStateFor(blocked 사유 키 고정: authority-corrupt|authority-format|
authority-mapid-mismatch|history-without-marker|receipt-unbound 등)·approvedViewFor·mapContentFor·
readMapProjection·mapGateAssessFor·promoteEntry — blocked/거부 반환마다 reasonKey 동봉(reason 원문 유지
— 스키마 확장·키 전파는 authorityStateFor 산출을 그대로 실어 나름). 소비처(웹뷰·package 메타·attach·
gate 로그·CLI)가 키→ko/en 표로 번역·미지 키=원문 폴백. **영문 슬롯 테스트가 blocked 4표면(dashboard·
package·attach·gate)의 영어 표시를 각각 단언**(2차 #7).

### B-1. dashboard-approved (extension.ts)
- readMapLedgerUncached의 확정층 파트만 교체: `bridgeLib()` 경유 `mapAdapters()` 헬퍼 신설(lazy require
  `<BRIDGE_DIR>/map-adapters.js` — bridgeLib와 동형 가드). `approvedViewFor(target)` 호출:
  - legacy → 기존과 동일 데이터(mapApproved=approved.length·mapTotalItems). **동치의 정본은 P3a 테스트**
    (approvedViewFor(legacy)≡parseApprovedFromMap) — extension은 소비만.
  - v2 → mapApproved=approved.length·mapTotalItems=totalItems·**mapSource:"v2" 배지**+stale/retired 카운트
    노출(뷰 모델 필드 추가: mapSource, mapStale, mapRetired, mapBlockedReason:null).
  - blocked → mapSource:"blocked"+mapBlockedReason(사유 — 대시보드 확정층 칸에 '판독 불가' 정직 표시,
    mapApproved=0을 '없음'으로 위장 금지).
  - **잔여 감시(frozen-ledger probe — 3차 #4·4차 #3·5차 #1 수용으로 확정)**: 경보 축은 행 대조가 아니라
    **동결 파일 지문 대조** — cutover가 스냅샷 서랍에 기록한 frozen-ledger-fp(동결 시점 확정층 파일의
    sha1 — **C-5 배너 삽입 '후' 최종 바이트에서 계산**·파일 부재=부재 sentinel)와 현재 파일 지문을
    대조해 **불일치=동결 위반 경보**(추가·삭제·수정·재기록·치환 등 모든 변경 유형을 잡는 완전 축 —
    5차 #1: 행 단위 대조는 이미 결속된 행의 재기록·삭제를 놓친다). 별도로 mapUnmigratedTotal(현재
    미표현 행 수 — C-1 5 entryFp 공식·정보 배지 전용·경보 축 아님)을 병기. 기준선 지문 판독 실패=
    '기준선 불명' 경고 표시(경보 억제·위장 금지). 경보는 kind 신설·ws 결속·해소(지문 재일치=현실적으로
    재이관 후 재동결 절차 — 후속 cutover 도구 전까지는 경보 유지가 정직) — 구 확장 창·수동 편집의 후발
    변경을 수동 legacy-scan 없이 자동 가시화.
  - 폴백(구 런타임·require 실패) → **공통 원칙 (a) 읽기 폴백**(4차 #1 정합): marker '또는'
    authority-history 존재를 fs 원시 검사 — 존재=mapSource:"blocked"+사유(legacy 데이터 공급 0)·둘 다
    부재=기존 parseApprovedFromMap 경로(mapSource:"legacy").
- mapText(원문 미리보기): legacy=기존 그대로 / v2=docs/MAP.md 동결본을 '동결(이관 소스)' 라벨과 함께
  표시(v2에서는 approved 목록이 정본 표시 — 미리보기는 비권위 서사) / **blocked=숨김+사유만**(공통 원칙
  (b) — 3차 #1 문구 정합: legacyPreviewFor 진단 표시는 P9 위임).
- 웹뷰: 배지·사유 표시만 추가(레이아웃 불변·ko/en 쌍).

### B-2. package-map-content (scope-package.js)
- collectCommon의 mapContent 판독을 `mapContentFor(repo)` 경유로 교체. lazy require 실패=**공통 원칙 (a)
  읽기 폴백**(4차 #1 정합): marker/history 원시 검사 — 존재=mapContent null+mapContentBlocked 사유·둘 다
  부재=기존 직접 판독. legacy=기존 바이트 동일(어댑터가 같은 폴백 순서 docs/MAP.md→MAP.md — P3a 동치
  테스트 존재).
  v2=project-map/MAP.md 원문. blocked=mapContent:null+**meta.mapContentBlocked=사유**. 절단 상한은 소비자
  계약 그대로. **스키마·렌더 배선 동반**(1차 #7 수용 — 필드만 넣으면 소실 실측): collectCommon 반환에
  mapContentBlocked 추가 → scripts/scope-package.js의 메타 조립·**src/scope-package.ts의 buildPackage 입력·
  ScopePackage.meta 타입·렌더**(blocked면 '지도 없음'이 아니라 '지도 판독 불가+사유' 표기 — blind spot
  위장 금지)까지 한 묶음(tsc 산출물 out/scope-package.js 경유 소비 확인).

### B-3. ledger-export (extension.ts)
- **대상 스냅샷 결속**(1차 #10 수용): 모달을 열기 '전' target=scoutTargetFor(ws).repo를 캡처하고, 모달
  callback에서 재해석 결과가 스냅샷과 다르면 **기록 0으로 중단**+"정찰 대상이 바뀜 — 다시 시도" 고지
  (교차 프로젝트 혼입 차단). record()의 관측 이벤트도 스냅샷 대상 사용.
- export 모달 확인 뒤 분기(어댑터 `authorityStateFor` 경유 — mapAdapters().promoteEntry 사용 가능 여부와
  함께 판정. 어댑터·map-runtime require 실패=**쓰기 거부+install 안내**(공통 원칙 (a) fail-closed —
  3차 #1 문구 정합: 검사-후-쓰기 폴백 없음)):
  - legacy → **withMapLock 안에서**(공통 원칙 (e)): authorityStateFor 재판정 → legacy 확인 시에만
    appendApproved+atomicWrite → 잠금 해제(v2로 바뀌었으면 기록 없이 v2 분기 재진입 안내 — 사후 경고가
    아니라 사전 차단·데이터 무결성 우선[1차 #1 수용: '파일에 남아 회수 가능'은 원자 동결의 대체가 아님]).
    잠금 실패=기록 거부+재시도 안내(fail-closed).
  - v2 → `promoteEntry(target, {text, from, approvedAt: now(ISO), actionRef:"export"})` 합타입별 고지(ko/en):
    patch="제안 생성(patchId 앞 8) — classify/apply는 pipeline 명령" / already-applied="이미 반영됨" /
    already-pending="같은 제안이 대기 중" / retry-required="만료 제안만 있음 — 재실행" /
    needs-binding="Project MAP 결속 필요 — binding-confirm <candidateFp> 안내(후보는 durable 저장됨)" /
    conflict·rejected=사유 그대로. 관측 장부 exported 이벤트는 **patch|already-applied|already-pending에서만**
    기록(needs-binding은 아직 확정층 반영이 아님 — 기존 '내보냄' 의미 보존. inMap 중복 대조는 v2에서
    already-applied가 대신함).
  - blocked → 거부 모달(사유)+아무 기록 없음.
- 모달 문구: v2 분기는 "확정 장부(docs/MAP.md)"가 아니라 "Project MAP(구조 지도)"로 대상 표기 정정(ko/en).

### B-4. reconcile-approve (scope-reconcile.js)
- approve 분기: 어댑터·map-runtime lazy require 실패=**기록 거부 exit 1+install 안내**(공통 원칙 (a)
  fail-closed — 3차 #1 문구 정합). authorityStateFor:
  - legacy → **withMapLock 안 재판정 후 기록**(B-3과 동일 계약 — CLI라 map-runtime lazy require 가능·잠금
    실패=기록 거부 exit 1).
  - v2 → picked 각각 `promoteEntry(repo, {text, from, approvedAt: now, actionRef:"approve"})` — **항목별
    독립 처리·항목별 결과 줄 출력**(legacy도 원자성 없었음 — 전체 롤백 신설 금지). st.approved에는
    patch|already-applied|already-pending만 push(needs-binding은 미승격 — lastList에서 재선택 가능하게
    보존·"결속 후 재승인" 안내). 종료 코드: 전 항목 성공(승격 도달)=0 / 하나라도 미승격=1(부분 성공 보고).
  - blocked → 전체 거부+사유(exit 1)·상태 무변경.

### B-5. scout-attach (codex-bridge.js)
- 48행 `buildScoutAttach(...)` → `mapAttach(...)` 헬퍼: lazy require map-reader.js의 buildMapAttach.
  require 실패·부재=**공통 원칙 (a) 읽기 폴백**(marker '또는' authority-history 존재를 fs 원시 검사 —
  존재=고지 attach(사유)·둘 다 부재=buildScoutAttach 직접[바이트 동일] — 3차 #1 문구 정합). buildMapAttach
  자체가 2트랙 게이트·legacy/none 위임을 보장(P4 잠금 테스트) — 호출부는 단순 교체.
- **blocked/error 위임 개정**(1차 #6→2차 #2 수용 — P4의 '비v2 전부 위임' 계약은 marker 상시 legacy였던
  활성화 전 전제·P3b에서 개정): buildMapAttach는 projection이 **blocked '또는' error(lock·flap)면 위임
  대신 '판독 불가 고지 attach'**({text: 1줄 사유(ko/en·reasonKey 번역), mapItems:[], couplings:[]} —
  권위·legacy 데이터 모두 미반환·차단 없음) 반환. error도 위임 금지인 이유(2차 #2): 일시 실패 상태에서는
  marker 세대를 판정할 수 없으므로 legacy 공급이 권위 역행일 수 있다 — 다음 호출이 정상 재판정.
  **legacy/none 판정이 확인된 경우에만** 기존 buildScoutAttach 위임(바이트 동일).

### B-6. gate-map-reader (scout-gate.js)
- **3분기 라우팅**(1차 #6 수용): lazy require map-reader+map-bindings 후 authorityStateFor(target) —
  - legacy → 기존 scoutMapStatus 경로 무변경. require 실패=**공통 원칙 (a) 읽기 폴백**(marker/history
    fs 원시 검사 — 존재=통과+관측 로그에 사유[legacy 데이터 미공급]·둘 다 부재=기존 경로 — 3차 #1 정합).
  - v2 → `mapGateAssessFor(target)` 소비: fresh=통과(exit 0) / no-map·stale=기존 차단 절차에 **notice
    (ko/en — mapGateAssessFor 보유)** 문구 사용 / unknown=통과+관측 기록(기존 unknown 규약 동형).
  - blocked → **통과(fail-open 원칙 — marker 손상이 플랜 확정을 잠그면 안 됨)+관측 로그에 blocked 사유
    기록**(숨김 금지·차단 없음 — 로그가 fail-visible 축).
  세션 차단 상한·관측 로그·drift 안내·모든 예외=exit 0은 기존 골격 그대로.
- mapGateAssessFor 개정: **blocked를 unknown으로 뭉개지 않고 `state:"blocked"` 별도 반환**(1차 #6 —
  reason 포함·무차단은 동일. 소비처가 구분 소비). gateResult.active는 projection.source==="v2"로 유도
  (자기신고 고정값 폐기 — 표시 전용 필드).

## C. 증분 2 — cutover 명령

`scope-map <repo> cutover --confirm-windows-reloaded [--confirm-unmigrated <N>]`
(map-runtime.js runCli 신규 분기 — 수동 전용. 4차 #4: 필수 플래그를 CLI 형식에 명기).

### C-1. 게이트·사전 검사 (잠금 밖 1차 → 잠금 안 전부 재검사)
0. scoutMode 게이트 최선행(off=거부·파일 생성 0 — 기존 P2/P3a CLI와 동일 문구 계약).
1. **authority 상태 분기**(authorityStateFor 재사용):
   - v2 → **멱등 no-op+미완 tail 결정론 보충**(6차 #1·7차 #1 수용 — marker 성공 후 C-5 전 종료가 영구
     미완이 되지 않게, 단 보충도 '쓰기'이므로 게이트·잠금 전체 준수): tail 보충 경로는 **①C-1 8
     writer-quiescence 플래그 선행**(부재=보충 없이 '미완 tail 존재+플래그와 함께 재실행' 안내만 — 쓰기 0)
     **②C-6 이중 잠금(withMapLock) 안에서** marker decisionRef·스냅샷 기준선·현재 확정층 바이트를 전부
     재판독 후 조건부 기록: 기준선 존재+배너 미삽입+'배너 적용 결과 바이트의 지문=기준선 지문'일 때만
     배너 원자 보충(결정론 재실행 — 잠금 안 재판독과 쓰기가 같은 임계구역이라 check-then-write 경합
     없음). 지문 불일치=**흡수 금지**·보충 없이 동결 위반 경보 안내. 기준선 자체가 없으면(구세대 cutover
     산물) '기준선 불명' 안내(현재 바이트 흡수 금지 — 6차 #1). 이후 "이미 전환됨(mapId·ts 표기)" 보고
     (exit 0 — 보충 불요 시 잠금 진입 없이 즉시 no-op: 잠금은 '배너 미삽입 관측' 시에만).
   - legacy(marker 부재+이력 없음) → 신규 진행.
   - blocked → **재개 판별**(§B-1): authority-history의 유효 receipt(validReceipt)가 **정확히 1개**이고
     marker 부재이고 receipt.mapId===현재 topology.mapId면 재개 경로(§C-3). 그 외(손상 receipt·복수 유효
     receipt·mapId 불일치·marker 손상)=거부+수동 확인 안내(자동 선택·자동 삭제 금지 — 4차 #1).
2. **manifest 전수 검사**(§E 계약 그대로): REQUIRED_SURFACES와 adapterManifest().surfaces의 **id 집합 정확
   일치**(누락·잉여 모두 거부)+**전 표면 ready===true**. ownerPhase는 검사 조건 아님.
3. **topology 유효**: readTopoExFor=ok+validateTopology 0건+mapId UUID. draft여도 거부하지 않되 보고에
   DRAFT 표기(권위 전환은 쓰기 경로 전환이지 지도 품질 선언이 아님 — usable 전이는 1-33 별개).
4. **활성 WAL 부재**: pipelineBarrier 통과(blocked=거부·recoverWal 안내).
5. **이관 결과 확인**(1-22·1-24 정합 — 1차 #2 수용: sig 집합 비교는 같은 문구의 신규·변경 행을 이관
   완료로 오인): legacy 확정층(docs/MAP.md→MAP.md 폴백)을 parseApprovedCopy로 판독(판독 실패=거부·부재=
   0건 정상), **행 단위 entryFp 다중집합**(entryFpLegacy(text,date,from) — map-bindings 기존 공식)과
   bindings.json(현재 mapId·판독 실패=거부) 전 binding의 originals[].entryFp 집합을 대조 — **v2 뷰에
   나타나지 않을 행 수 N**(sig 미결속 행+sig는 결속됐지만 그 행의 entryFp가 originals에 없는 행)이 0보다
   크면 `--confirm-unmigrated <N>`(정확 수 일치 명시) 없이는 거부. 근거: 1-24 '매핑 없는 entry는 증거층에
   그대로'이므로 완전 이관은 요구하지 않되, cutover 후 대시보드 확정층 표시에서 사라지는(v2 뷰=bindings
   originals 사본만) 행 수를 사용자가 정확히 인지하고 진행해야 한다(informed 동의 — 수가 다르면 거부·
   재확인). 미결속 목록은 거부 보고에 sig 앞 24자+대표 문구+사유(unbound|entry-diverged)로 출력.
6. **스냅샷/롤백 재료**(§5 '스냅샷/롤백 재료 확인' — 1차 #3 수용: id 생성 순서 교정): **decisionId=
   crypto.randomUUID()를 잠금 밖 검사 통과 직후 '사전 발급'**하고 이 시도의 스냅샷 경로와 잠금 안 receipt
   조립에 **같은 id를 결속**(재개 경로는 기존 receipt의 decisionId 사용·스냅샷 생략 — 이미 전환 중 상태).
   `<BRIDGE_DIR>/map-cutover-snapshots/<nsKey>/<decisionId>/`에 topology.json 원문·확정층 원문(존재 시)·
   bindings.json 원문(존재 시)+manifest 사본을 원자 기록 — 기록 실패=중단(marker 이전이므로 아무것도
   바뀌지 않음). **frozen-ledger-fp(B-1 probe의 동결 기준 지문 — 5차 #1·6차 #1)는 marker '전'에 내구
   기록**: C-2 잠금 안 재검사가 확인한 확정층 바이트에 C-5 배너를 '적용한 결과 바이트'를 결정론 계산해
   그 sha1을 스냅샷 서랍 frozen-ledger-fp.json에 원자 기록(receipt 기록 직전 — 실패=중단·marker 이전이라
   무해. 확정층 부재=부재 sentinel 기록). C-5 실물 배너 삽입은 이 계산과 동일한 바이트를 쓰는 결정론
   재실행이므로 삽입 성공 시 파일 지문=기준선 지문(정합). nsKey=P2 canonicalIdentityFor(프로젝트별 분리·브랜치 결속). 스냅샷은 진단·수동 복구
   재료(자동 롤백 경로는 신설하지 않는다 — §B '이력 존재+marker 부재=blocked'가 전환 전 상태 복귀를
   의도적으로 차단하므로, 자동 롤백은 정본 위반).
7. **배포 사본 세대 검사**(1차 #8→2차 #6 수용으로 확장 — manifest 자기신고는 정본 §E 계약 그대로[P3A
   377-379]·배선 증명은 테스트 소관이나, 활성 소비처가 낡은 사본이면 marker 후 legacy 경로가 재개되는
   실질 구멍은 별도): cutover 검사에 **BRIDGE_DIR(CODEX_BRIDGE_HOME 존중)의 BRIDGE_SCRIPTS '전체'
   (18파일 — codex-bridge.js·scout-gate.js 등 소비처 사본 포함)가 전부 존재하고 레포 bridge/ 사본과
   바이트 동일**인지 대조 — 부재·불일치=거부+`node install.js` 안내. **이 검사는 C-2 잠금 안 재검사에도
   편입**(2차 #6 — 외부 검사 후 사본 교체·손상 TOCTOU 봉합). **검증 불가 표면의 수용 위험 명문**(2차 #6):
   확장 웹뷰 번들(VS Code 설치본)의 세대는 CLI가 검증할 수 없다 — 구 확장(어댑터 경유 이전 코드)의 legacy
   직접 쓰기는 이 검사로 못 막는다. 완화: ①cutover 성공 보고에 "모든 VS Code 창 리로드 필수" 고지(ko/en)
   ②사후 자동 발견 경보(B-1 잔여 감시 — 수동 legacy-scan 의존 아님) ③사전 창 확인 게이트
   `--confirm-windows-reloaded`(C-6 — 3차 #4: '수용 위험' 강등 철회·사용자 명시 확인+자동 감시 2축 봉합).
   폴백 fail-closed(공통 (a))는 새 코드 표면에만 유효함을 함께 명문.
8. **작성자 정지(writer-quiescence) 확인 게이트**(4차 #2 수용 — 창만이 아니라 구세대 writer 전부):
   `--confirm-windows-reloaded` 부재=거부+안내(ko/en) — 확인 문구를 **"이 저장소를 여는 모든 VS Code
   창을 닫거나 리로드했고, 이 저장소를 대상으로 실행 중인 MAP·확정층 명령(scope-map apply·
   scope-reconcile approve 등 구세대 CLI 포함)이 없음을 확인했다"**로 확장(등록 밖 별칭에서 이미 실행
   중인 구 CLI writer는 어떤 잠금·플래그로도 원격 배제 불가 — 사용자 확인이 유일한 실측 가능 방어.
   informed 동의·C-6 잠금이 못 덮는 잔여의 사전 방어).
9. PRIVACY 선갱신(1-23)은 **구현 커밋에 동반**(문서가 파일 신설보다 늦지 않게 — E절).

### C-2. 쓰기 순서 (withMapLock 안 — §B-1 계약 그대로)
①**C-1의 0~5와 7(배포 세대) 전부 잠금 안 재검사**(1차 #9·3차 #5 수용 — scoutMode 게이트·배포 세대 검사
포함: 사전 검사 후 track이 꺼지거나 사본이 바뀌었으면 marker 기록 금지. 8(창 확인 플래그)은 인자
존재라 재검사 무의미 — 제외. TOCTOU 봉합 — 스냅샷은 잠금 밖 선행 후 잠금 안에서 topology·확정층·
bindings 바이트 불변 재확인: 달라졌으면 중단·재실행 안내) → ②receipt 조립: **decisionId=C-1 6에서 사전
발급된 값**,
ts=new Date().toISOString(), authorityObject={schema:"map-authority-v1", cutover:true, mapId, decisionRef:
decisionId, ts}, authorityFileFp=sha1(JSON.stringify(authorityObject, null, 1)) — validReceipt 자체 검증
통과 확인 후 `authority-history/<decisionId>.json` 원자 기록 → ③marker `authority.json`=
JSON.stringify(authorityObject, null, 1) 원자 기록 → ④read-back: authorityStateFor(repo)==="v2" 재판정 —
실패면 **삭제 없이** 실패 보고(§B-1 '중단 재개'가 후속 실행에서 marker 보충·중간 상태는 blocked=안전 방향).
receipt 기록 성공+marker 기록 실패=정확히 §B-1 재개 대상 상태(정상 중단 1회 허용).
- **2트랙 판정 관례·수용 위험 명문**(1차 #9): scoutMode 판정은 기존 P2/P3a CLI와 동일하게
  loadContract(repo)(대상 repo의 계약 슬롯) — 'workspace A→scoutRepo B' 구성에서 B에 계약이 없으면
  cutover가 거부되는 **과보호 방향**을 수용 위험으로 명문(기존 binding·pipeline CLI 전부 같은 관례 —
  cutover만 다른 판정을 신설하면 관례 이원화. 해소가 필요해지면 --workspace 옵션을 후속 개정으로).

### C-3. 재개 경로 (§B-1 + 2차 #4·3차 #2 수용 — strict lock+전수 조건 결속)
재개 marker 보충도 **withMapLock 안**에서: 잠금 안 재검사(marker 여전히 부재·유효 receipt 여전히 정확
1개·receipt.mapId===현재 topology.mapId·활성 WAL 부재·scoutMode on·배포 세대·**manifest 집합 정확
일치+전 표면 ready·topology 유효(readTopoEx ok+validateTopology 0)** — 3차 #2: marker 활성 '순간'의
전수 조건은 신규·재개가 동일해야 한다[receipt-only 중단 후 소스 교체·topology 손상 시나리오 차단])
전부 통과 후에만 receipt.authorityObject를 canonical 직렬화해 marker 원자 보충 → read-back. 지문은
receipt.authorityFileFp와 일치할 수밖에 없음(결정론). 재개 경로는 스냅샷·미이관 확인만 생략(전환 결정은
최초 시도에서 이미 승인됨·재개는 그 완결 — 안전 조건이 아닌 '승인 조건'만 생략).

### C-4. 자동 적용 활성화 (1-30)
applyPatch의 preCutover 게이트 개정: `--pre-cutover` 부재 시 **authorityStateFor(repo).st==="v2"면 통과**
(lazy require로 map-bindings 참조 — 순환 require 회피), 아니면 기존 거부 문구 유지. **blocked=플래그
무관 전면 거부**(2차 #3 수용 — receipt-only 중단 상태에서 --pre-cutover로 topology를 바꾸면 재개 marker
보충이 다른 세대 위에 얹힌다: blocked에서 v2 쓰기 거부는 §B 정본·거부 문구에 cutover 재개 안내 동봉).
판정은 applyPatch의 기존 잠금·barrier 임계구역 안 재검사에 편입(잠금 밖 1차 판정 금지 — cutover 직후
경합 창 차단).
**decision 기록 정합**(1차 #5 수용): decision 조립의 `preCutover:true` 무조건 기록을 개정 — **--pre-cutover
명시 경로만 필드 기록, v2 무플래그 경로는 필드 생략**(정본 validator의 '부재=cutover 후' 정의와 정합 —
증명 이력 왜곡 차단. WAL 사본·projection 해시 결속은 기존 규약 그대로 따라감).
'자동'의 실체는 P8 라우터·P9 카드가 오기 전까지 '수동 승인 플래그 불요'까지다(새 자동 실행 데몬 신설 금지
— 정본 §5의 활성화는 게이트 해제이지 실행기 신설이 아님).

### C-6. 정본 잠금 키 교정 (1-29 — 1차 #4→2차 #5 수용으로 확장)
- **적용 범위=정본 잠금의 유일 출처 일원화**: runCli(205-212)의 자체 `ctx.LOCK=wsKeyFor(repo)` 구성을
  폐기하고 **ctxFor 단일 출처로 통일**(init·render·migrate writer가 같은 물리 잠금을 쓰도록 — 2차 #5:
  ctxFor만 고치면 runCli 별도 구성이 남는 반례). ctxFor의 잠금 키를 **물리 키(realpath)**로 교정.
- **무순환 구현**(2차 #5): canonicalIdentityFor는 map-pipeline 소재(map-pipeline→map-runtime 선행
  require라 역방향 top-level require=순환) — map-runtime에 자체 `physKeyOf(repo)`(fs.realpathSync 폴백
  포함 래퍼)를 무순환 구현하고, **map-pipeline canonicalIdentityFor.physKey와의 동형성을 패리티 테스트로
  잠금**(3카피 규약 전례). realpath 해석 실패(부재 경로 등)=path.resolve 폴백(잠금 부재보다 보수).
- **신·구 이행 창=이중 잠금+등록 별칭 전수**(2차 #5→3차 #3 수용 확장): withMapLock은 **[신 physKey 잠금
  → 구 wsKey 잠금(들)] 순서 고정으로 전부 취득**. 구 키 집합은 '현재 입력 경로' 하나가 아니라 **관측
  가능한 등록 별칭 전수**: ①입력 경로 resolve ②realpath ③CONTRACTS_DIR 전 계약·links.json의
  workspace/scoutRepo 중 realpath가 같은 물리 경로인 문자열들 — 각각의 wsKey 잠금을 정렬 순서로 취득
  (3차 #3: 구 프로세스는 자기가 등록한 ws 문자열로 잠그므로, 등록 별칭 전수가 실측 가능한 최대 집합.
  판독 실패한 계약 파일=그 별칭 누락 가능 — 아래 정지 게이트가 최종 방어). 교착 없음(모든 신 코드
  동일 순서·정렬 고정). 구 키 잠금은 후속 세대에서 제거(개정 항목으로 명문).
- **등록 밖 별칭·구 확장 창의 최종 방어=작성자 정지(writer-quiescence) 게이트 — 정의는 C-1 8이 유일
  정본**(3차 #3·#4·5차 #2 수용: 이 절에서 계약을 재서술·축소하지 않는다 — C-1 8 전체 계약을 그대로
  참조). **유지 구간 명시**(5차 #2): 사용자의 확인은 일회 진술이 아니라 **'확인 시점부터 cutover 완료
  (성공 보고 또는 중단 확인)까지 구세대 writer(VS Code 창·구세대 MAP/확정층 CLI)를 새로 시작하지
  않으며, cutover 후에는 리로드 전 창·구세대 CLI를 이 저장소에 사용하지 않는다'는 지속 약속**이다
  (안내 문구에 명문 — ko/en). cutover 후 위반은 B-1 frozen-ledger probe(지문 대조)가 자동 발견한다.
- 구 키 잔존 .lock 파일은 자연 방치(strict lock이 재선점 판정 — 회수 불요·TTL 스윕 비대상 유지).

### C-5. 동결 배너 (1-22)
cutover 성공(read-back 통과) 후 확정층 파일 존재 시 머리에 1줄 배너 원자 삽입 — **C-1 6에서 지문을 계산한
'배너 적용 결과 바이트'를 그대로 기록**(결정론 — 삽입 후 파일 지문=frozen-ledger-fp. 멱등 — 동일 배너
존재=생략):
`<!-- DEPRECATED (frozen migration source): 이 확정 교범은 Project MAP(project-map/)으로 전환됨 — 신규 승인은 Project MAP 경로만. This ledger is frozen; new approvals go through Project MAP. -->`
실패=경고만(marker가 권위 — 배너는 서사·**재시도는 C-1의 v2 재진입 tail 보충이 담당**[6차 #1 — 이
명령의 재실행이 v2 no-op여도 보충 경로가 실행됨]). 파일 부재=생략(정상 — 기준선은 부재 sentinel).

### C-7. 자동화 계층 (2026-07-21 사용자 지시 개정 — "MAP은 수동 동작을 없애려는 설계인데 전환에 또 수동
명령을 만드는 것은 과보수". 원칙: **동의할 내용이 없으면 자동, 판단이 실제로 필요한 경우만 원클릭** —
P0 §0 '사용자는 승인자가 아니라 의도 선택자'의 관철. CLI는 존치[스크립트·원격용].)

- **auto-eligible 판정**: 권위=legacy AND 미이관 N=0(확정층 부재 포함 — v2 뷰에서 사라질 행이 없어
  informed 동의의 '내용' 자체가 없음) AND 나머지 안전 조건(manifest·topology·WAL·배포 세대) 전부 통과.
- **auto 경로(runCutover opts.auto)**: auto-eligible이면 quiescence 플래그 없이 진행 — **수용 위험 재판정
  근거(C-1 8·C-6에 대한 명시 예외 — 정본 내 모순 아님)**: C-1 8의 '사용자 확인=유일한 사전 방어'는 유효하나,
  미이관 0에서 구세대 writer 위반의 결과는 ①구 확정층에 기록된 신규 승인이 v2 권위에 반영되지 않음(승인
  원문은 파일에 그대로 보존 — 소실 없음·Project MAP 경로로 재승인 가능한 '사후 회복 계약') ②동결 위반 —
  둘 다 B-1 probe가 자동 발견·대시보드가 재승인 경로를 안내한다. 즉 사전 확인이 막는 것은 '일시적 무권위
  기록'이고 그 비용은 회복 가능 — 자동화 가치(P0 §0)가 이 비용을 상회한다는 것이 사용자 결정(2026-07-21).
  자동 전환 후 대시보드는 '자동 전환됨 — 모든 창 리로드' 상태를 표시한다. 미이관 N>0이면 auto는
  **쓰기 0으로 조용히 물러남(exit 3)** — 카드 소관. **blocked(재개)도 auto 범위 밖(exit 3)** — 재개는
  중단 이력이라는 '판단 필요' 상태이므로 수동·카드 경로만.
- **자동 실행 지점 2개**: ①bootstrap 완료 트랜잭션 성공 직후(detach 자식 — 신규 프로젝트의 자연 경로)
  ②대시보드 관측(mapSource=legacy 관측 시 ws당 상태 1회 백그라운드 시도 — 기존 프로젝트 경로).
  실패=무해(다음 상태 변화에 재시도·강제 없음).
- **원클릭 카드(미이관 N>0만)**: 대시보드 확정층 카드에 '전환 준비됨 — N건 확인 필요' 버튼 → 모달에
  미이관 N·대표 행·지속 약속 문구 → 확인=확장이 프로그램적으로 cutover 실행(CLI 타이핑 제거 —
  informed 동의는 모달이 담당·ledgerAct 전례). 거절=아무 일 없음.
- **배포 세대 검사의 컨텍스트 인식(2차 정정 — 자기 경로 확인만으로는 '섞인 세대'를 못 잡는다)**: 자동
  경로는 설치본(BRIDGE_DIR) 사본으로 실행된다 — install.js/확장 배포가 설치 시 기록한
  `deploy-manifest.json`(파일별 sha1 — 설치 세대의 원자 증명)과 현재 사본을 **전수 대조**하고, manifest의
  키 집합은 EXPECTED_DEPLOY_FILES(19파일 — install.js·hook-setup.ts와 3카피 패리티)와 **정확 일치**해야
  한다(부재·축소·잉여·지문 불일치=거부). 레포 실행은 현행 레포↔설치본 전수 대조 유지.
- **manifest 기록 조건(4차 정정 — '디스크에 있는 것'의 정본화 금지)**: manifest는 **설치본=배포 원본이
  검증된 상태에서만** 기록한다. install.js=자기가 방금 복사한 세대. 확장=①전체 재배치(19파일 전부 번들에서
  복사) 성공 직후 ②같은 버전 stamp 조기 반환은 설치본↔번들 sha1 전수 대조 통과 시에만 manifest 보충(드리프트
  =전체 재배치로 진입). **부분 보충(수동 모드 — 누락분만 복사) 경로는 manifest를 기록하지 않는다**(새 파일+
  낡은 파일 혼합 상태를 새 정상 세대로 승인하게 됨 — 수동 흐름의 manifest는 install.js 재실행이 소관이며
  부재 시 cutover는 deploy-manifest-missing으로 fail-closed). **지문의 출처=배포 '원본'(install.js=레포
  bridge/·확장=번들 src) 바이트 — 설치본 재판독 금지(5차 정정)**: 대조↔기록 사이 다른 배포자가 설치본을
  교체하는 경합에서 혼합 결과를 정상 manifest로 승인하는 창을 제거한다. 경합이 나면 manifest(원본 세대)≠
  디스크(교체 세대) → cutover 전수 대조가 거부 — 잠금 없이도 '승인'이 아니라 '거부'로 떨어지는 방향 반전이
  불변식이다(다음 활성화/재설치가 수리).
- **배포 잠금(6차 정정 도입·9차 프로토콜 확정 — 검사기 자체의 reader-writer TOCTOU)**: 19파일 순차 대조
  '도중' writer가 교체하면 검사기는 교체 전 바이트만 읽고 통과하는데 최종 디스크는 혼합 세대가 된다 →
  우리가 소유한 모든 writer(install.js·확장 deployBridgeRuntime)와 검사기(deployGenerationCheck)가 같은
  잠금을 공유한다. 잠금 실패/타임아웃: 검사기=fail-closed 거부·install.js=중단(사유+복구 안내)·확장=이번
  활성화 배치 보류(다음 활성화 재시도).
- **잠금 프로토콜(9차 확정 — 6~8차 안 폐기 이력 포함)**: 6~8차의 '디렉터리 mkdir+소유자 토큰+자동 stale
  탈환(rename 결속)' 안은 검증에서 ①원복 구간 정본 경로 공백에 제3자 진입 ②null 세대 동치+비배타 owner
  기록의 이중 진입이 확인되어 **전면 폐기**. 본 저장소 contract-lock v10이 4왕복 끝에 도달한 동일 결론을
  재사용한다: ①획득=`.deploy.lock` 파일 **wx 원자 생성**(파일 내용=신원 토큰 pid·rnd·ts — 생성과 신원이 한
  시스템콜, 무주 창 없음) ②**read-back fence**(불일치/판독 실패=삭제 없이 재시도·타임아웃) ③**자동
  탈환/삭제 전면 폐기**('확인-후-삭제' 자체가 TOCTOU — 어떤 경로도 타인 잠금을 이동·삭제하지 않으므로
  이중 진입 벡터가 원천 소멸) ④사망 보유자(kill 0=ESRCH)=deploy-lock-stale '검출된 실패'+수동 복구
  안내(pid 사망 확인 후 파일 삭제 — install.js/CLI 메시지에 경로·pid 동봉) ⑤해제=내 토큰일 때만 unlink·
  임계구역 종료 시 소유권 재확인(외부 개입=deploy-lock-lost 검출 실패) ⑥루프 머리 타임아웃(모든 실패
  경로가 50ms 대기+상한을 지남). **수용 위험(명시)**: 크래시 잔존 잠금은 수동 복구까지 auto 전환·배포를
  차단한다(fail-closed 방향·임계구역 초 미만이라 희귀·복구 사다리는 후속 후보). 확장 카피는 사망 pid
  분류 없이 침묵 보류(실패 모드가 '다음 활성화 재시도'라 안내 표면이 없음 — 프로토콜 나머지는 3카피 동일).
- **자동 전환 리로드 고지의 전달 계약(4차 정정 — bootstrap 침묵 경로 포함)**: marker는 정확 키 집합+receipt
  지문 결속이라 provenance를 담을 수 없음 → auto 성공 시 `project-map/cutover-notice.json`
  (map-cutover-notice-v1·pending:true·decisionRef) 기록. 확장은 **v2 관측 시** pending이면 ws당 1회
  알림("자동 전환됨 — 모든 창 리로드")+카드 표시 후 ack(pending:false) — bootstrap 자식의 침묵 전환도
  다음 대시보드 관측에서 고지된다. 기록/ack 실패=고지 소실 가능(수용 위험 — 잔여 수단=receipt ts·B-1
  probe·수동 CLI 완료 문구).
- 멱등·재개·probe·모든 안전 조건은 C-1~C-6 그대로 — 자동화는 '진입 방식'의 계층이지 검사의 완화가 아님.

## D. 서사 표면 스윕·문서 (1-22·1-23)

- **PRIVACY.md**: 신설 파일 행 추가 — repo `project-map/authority.json`·`project-map/authority-history/`
  (cutover 시에만·수동 명령 산물), 하네스 `map-cutover-snapshots/`(로컬 진단 재료·TTL 비대상[일생 소수 회·
  롤백 재료 — 자동 삭제가 재료를 없앰]).
- **README.md·README.en.md**: '확정 교범' 서술에 cutover 후 전환 사실 1문단(전환 전=현행 서술 유지 —
  두 모드 병존 서술·'불변 약속' 문구를 '전환 전까지' 한정으로 개정).
- docs/MAP.md(codex-peek 자기 레포)는 **건드리지 않는다** — 배너는 cutover 실행된 '대상 repo'의 파일에만.
- HANDOFF·CODEX-DUAL-PENDING 갱신은 커밋 절차 소관(설계 범위 밖).

## E. 테스트 (신설 tests/p3b-cutover.test.js + 기존 픽스처 무손상)

- **재배선 동치(증분 1)**: ①scope-package collectCommon — legacy 상태에서 기존과 mapContent 바이트 동일·
  어댑터 부재 폴백 동일 ②codex-bridge 동봉 경로 — legacy에서 buildScoutAttach와 출력 동일(기존 p4-reader
  위임 잠금 재사용+호출부 전환 단언) ③scout-gate — legacy에서 기존 차단/통과 행동 불변(기존 scout-gate
  테스트 무손상) ④reconcile approve — legacy에서 확정층 기록 바이트 동일 ⑤extension은 tsc 컴파일+정적
  단언(소스에 어댑터 경유·폴백 가드 존재 — 웹뷰 e2e는 비대상 관례).
- **cutover 명령(증분 2)**: 성공 경로(receipt→marker 순서·read-back·스냅샷 실존·decisionRef 결속) /
  멱등(2회차=no-op) / 재개(receipt만 있는 상태에서 marker 보충·새 receipt 미생성) / 복수 유효 receipt=
  conflict 거부 / 손상 receipt=거부 / manifest 집합 불일치·ready=false=거부(스텁 주입) / 활성 WAL=거부 /
  topology 손상·mapId 비UUID=거부 / 미결속 N>0 무플래그=거부·`--confirm-unmigrated N` 정확 수만 통과·
  오수=거부 / 2트랙 off=거부·파일 생성 0 / 잠금 안 재검사(스냅샷 후 확정층 변조=중단) / 배너 멱등 /
  Windows 경로.
- **cutover 후 소비(증분 1+2 통합)**: approvedViewFor=v2 데이터·mapContentFor=project-map/MAP.md·
  promoteEntry 분기(export/approve 합타입별)·gate가 mapGateAssessFor 소비(fresh 통과·stale 차단 문구=
  notice)·attach가 v2 slice(기존 p4-reader 테스트 재사용)·blocked 상태(marker 변조)에서 읽기=사유 표시·
  쓰기=거부.
- **자동 적용**: v2에서 --pre-cutover 없이 apply 통과+**decision에 preCutover 필드 부재** / legacy에서
  기존 거부 문구·preCutover:true 기록 불변.
- **원자 동결(1차 #1)**: 잠금 보유 중 legacy 쓰기 시도=거부(실 자식 프로세스)·잠금 안 재판정이 v2면 기록 0.
- **3차 반영 추가 반례**: 재개 시 manifest ready=false·topology 손상=거부 / 등록 별칭 구 키 잠금 전수
  취득(계약에 별칭 등록 후 그 키 보유 중 신 코드 대기) / --confirm-windows-reloaded 부재=거부 /
  frozen-ledger probe: cutover 후 legacy 파일 행 추가·이미 결속된 행 재기록·행 삭제·동수 치환 각각 →
  지문 불일치 경보(5차 #1 반례 전수)·mapUnmigratedTotal 배지 별도·기준선 지문 판독 실패='기준선 불명'
  경고(경보 억제 없음)·확정 필드명 잠금 / **tail 내구(6차 #1·7차 #1)**: marker 성공 직후 강제 종료(배너
  전) → 재실행 v2 경로가 플래그 동반 시 잠금 안 배너 결정론 보충+지문 정합·**플래그 부재=쓰기 0(안내만)**·
  **잠금 중 현재 바이트 교체(주입 훅)=보충 중단**·기준선 부재 중 파일 변경=보충 없이 경보(흡수 금지 실측) /
  **quiescence 안내문 잠금(6차 #2)**: 플래그 부재 거부 안내가 C-1 8 전체 지속 조건(VS Code 창+구세대
  CLI 부재+cutover 완료까지 미시작+사후 미사용)을 ko/en 각각 포함하는지 문구 단언 /
  쓰기 폴백=거부 경로만 존재(marker 검사-후-쓰기 부재 단언 — 3차 #1 정합).
- **미이관 entryFp(1차 #2)**: binding 확정 후 같은 문구·다른 날짜 행 추가=N에 계상(entry-diverged)·
  --confirm-unmigrated 정확 수만 통과.
- **배포 세대(1차 #8)**: BRIDGE_DIR 사본 불일치·부재=거부 / 읽기 폴백의 marker·history 존재=legacy 공급 0.
- **blocked 라우팅(1차 #6)**: attach=사유 고지(위임 아님)·gate=통과+로그 사유·mapGateAssessFor
  state:"blocked" 반환.
- **잠금 키(1차 #4)**: 같은 물리 폴더의 별칭 경로 두 개가 같은 잠금 파일로 상호 배제(실측 — Windows
  junction 생성 가능 환경 한정·불가면 정규화 동치 단언).
- **대상 스냅샷(1차 #10)**: 모달 중 대상 전환 시 기록 0(정적 단언+상태기 분리 시 실행 반례).
- **reasonKey(1차 #11·2차 #7)**: promoteEntry 합타입 전 분기+authorityStateFor blocked 사유 전 종 —
  reasonKey 존재·en 슬롯에서 blocked 4표면(dashboard·package·attach·gate) 각각 영어 표시(미지 키=원문
  폴백).
- **2차 반영 추가 반례**: 폴백 쓰기=런타임 판독 불가 시 거부(직접 쓰기 경로 부재 단언) / 읽기 폴백=
  history-only(receipt-only) 상태에서 legacy 공급 금지 / blocked에서 apply --pre-cutover=거부 / 재개
  marker 보충이 잠금 안(경합 주입: 재개 재검사 중 marker 출현=중단) / runCli init·render·migrate가
  ctxFor 단일 잠금 경유(별칭 경로 상호 배제 실측 확장) / physKeyOf↔canonicalIdentityFor.physKey 패리티 /
  이중 잠금: 구 키 보유 중 신 코드 대기(실 자식 프로세스) / 배포 세대 검사=BRIDGE_SCRIPTS 전체·잠금 안
  재실행(외부 통과 후 사본 변조=중단) / 대시보드 blocked=mapText 숨김+사유.

## F. 완료 조건
- 증분 1: 재배선+동치 테스트 전체 통과 → Codex 검증 → 로컬 커밋.
- 증분 2: cutover+테스트 전체 통과 → Codex 검증 → PRIVACY/README 동반 → 클린빌드·install → 로컬 커밋.
- 전체 체인(기존 전 스위트) 무손상·버전 0.1.86 불변·push는 사용자 지시 시만.
