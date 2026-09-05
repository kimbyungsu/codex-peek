# 독립 큐레이션 설계 (CURATION — HARNESS-REALIGNMENT §7 5번) v3

작성 2026-09-02 · v2=설계 검증 1회차 blocker 3·보완 1 반영 · v3=2회차 blocker 3 반영(문안 필드 title·빼기 후보 종결 결속·빼기 대상 3중 대조) · 상태: **§7 1~4단계 구현됨 — 1·2단계 2026-09-03(dcbc63a·도장 2026-09-04) · 3·4단계 2026-09-04(자동 트리거 판정·detach·대시보드 버튼/카드 1줄/측정) — 잔여=2차(toggle 연결쌍)** · 사용자 승인 2026-09-03 "권장대로 진행" · 선행: HARNESS-REALIGNMENT
§1(누가 넣고 빼나)·§5 C·D, REJUDGE-AUTHORITY §3 C(v6 형태는 폐기·커밋 규약은 재사용), RULEBOOK-SIMPLIFICATION(헌법·§0 사고·2-1 수동 상신·3-1b 합성 신호),
VERIFY-GOVERNANCE §7·§8.

## 헌법 (이 설계의 단일 원칙)

**수칙을 넣고 빼자고 제안하는 쪽은 답안 쓴 사람이 아니라 장부를 읽는 독립 실행이고, 제안은 소수이며, 자격은 이력이 아니라 성격이다.**
사용자는 승인·빼기만 한다. 검증 경로는 이 실행을 기다리지 않는다.

상황으로 말하면 — 도서관 사서가 대출 기록(무엇이 자주 찾아졌고, 무엇이 한 번도 안 나갔고, 어떤 책이 반복해서 "여기 없는데요" 소리를
듣는지)을 보고 가끔 "이 책은 서가 앞줄로, 이건 창고로, 이 주제는 새로 들이자"고 관장에게 **몇 권만** 제안하는 것. 책을 산 사람(구현자)이
자기 책을 앞줄에 놓자고 하는 게 아니고, 반납된 책마다 자동으로 앞줄에 꽂히던 옛 방식(8월 26일 74항 사고)도 아니다.

## §0 배경 — 왜 지금 이 자리가 비어 있나 (실측 2026-09-02, D:\프로그래밍\에이전트 활용 장부)

- 후보 장부 372행: 제안 179(전부 '해소된 결함' 자동 상신)·최종 채택 1·거절/정리 118 — 그중 79건이 "공급 정책 개정(v2) — 자동 상신
  폐지" 사유. 2026-08-26 자동 상신이 서고를 74항으로 불려 선별이 잠겼고, 소수정예 재편으로 자동 상신을 끄고 사용자 도장으로 서고를
  0으로 비웠다.
- 지금 하네스가 스스로 내구 후보를 만드는 경로는 **없다**(설명 검증 2026-09-03 정정): 왕복 상한 소진 화면의 반복·승격·미사용 항목은
  `signals`(참고 표시)일 뿐 후보가 아니며 후보가 되려면 마감 시 구현자가 rule-propose를 거쳐야 한다. 내구 후보 원천은 구현자 수동 상신
  (rule-propose — 이해충돌)·대화 약속 포착(사용자 자신의 말) 둘뿐. 되받아침 2/850·반증 재소환 0·선별 초과 0.
- 결론: "서고가 비어 있어 정리 담당이 필요 없다"는 판단(2026-09-02 오전, 철회)은 원인을 뒤집은 것 — 공급이 꺼져 있어 비었다.
  이 개선 전체의 출발점("독립 실행이 적재적소에 수칙을 제안·전달")을 채우는 마지막 조각이 이 문서다.

## §1 재료 (전부 이미 있는 장부 — 코드·소스 판독 없음)

| 신호 | 출처 | 뜻 |
|---|---|---|
| 같은 제외 번호로 반복 강등된 지적(oos-repeat) | 처분 장부·동결 레코드 | "계속 치워둘지, 이제 방어할지" |
| 같은 계보로 반복된 blocker(lineage) | 처분 장부 prevId | "이 유형을 항상 차단 목록에 명시할지" |
| 입장 심사에서 승격된 범위 확장(escalation) | 심사 레코드 | "한 번 봐준 항목을 정식 편입할지" |
| 한 번도 선별되지 않은 보관 수칙(unused-rule) | 선별 영수증 — 미리보기(`purpose:"preview"`)와 검증 선별(`askId` 있는 행·purpose 필드 없음) **둘 다** 사용으로 셈 | "창고로 내릴지" |
| 되받아침에 쓰인 제외 칸 / 쓰이지 않은 칸 | 처분 장부 rebut(oosId) | 제외 칸 성장·정리(P12) |
| 선별 정상 범위 초과 | attach 장부 selOver | 서고가 무거워짐 |
| 사용자가 답한 결정·미답 결정 | 결정 장부 | 방향 힌트(제안 근거로만) |
| 현재 코어 3칸·서고 전문·항상/관련 태그 | 수칙서 파일(코어 `envelopeHash`·서고 `archiveHash`) | 중복·전환 판단 |

이 신호들은 이미 대시보드에 "참고 신호"(합성 4종·버튼 없음 — RULEBOOK-SIMPLIFICATION 3-1b)로 나온다 — 큐레이션은 그 신호를 **제안으로
바꾸는 유일한 경로**다.

## §2 방향 (원칙 7)

- **P1 검증 경로 밖**: 검증 job에 단계를 끼우지 않는다(REJUDGE v6 형태 폐기 확정). 지도 부트스트랩처럼 **분리 실행**(detach)이며 잠금은
  자기 것만. 검증·종료 훅·ask-start는 큐레이션을 기다리지도 참조하지도 않는다.
- **P2 소수 강제(코드)**: 실행 1회당 제안 ≤ 3, 미승인 누적 ≤ 6(초과 시 새 제안 보류·영수증만). "제안 없음"도 영수증.
- **P3 자격=성격**: 후보마다 "왜 프로젝트를 관통하는 지침인가"(120자·민감정보 거부)가 필수이고, 코어·서고 기등재 문안과 중복이면 거부
  (reconcile 억제 집합 재사용). 결함 해소 이력만으로는 자격 없음(헌법).
- **P4 제안자는 독립 실행·팔은 계약 유래**: selector-runner 페이지 실행(`purpose:"curate"`) 1회. 팔(provider)은 구현 턴 환경변수가 아니라
  **계약의 운용 모드**로 정한다 — `harnessMode` claude-codex → self(claude 격리 호출)·codex-codex → codex(빈 임시 폴더·읽기 전용) —
  구현 턴의 `selectorArmForTurn` 규칙과 같은 결과를 세션 문맥 없이 얻는 `selectorArmForCuration(ws, c)` 신설(대시보드 버튼·tick 트리거 공통).
  구현자 세션·검증자 세션과 다른 실행(ab-4). 구현자 rule-propose는 잔존하되 "구현 담당 제안" 표기(REJUDGE §8 ① 기본값 유지).
- **P5 승인 표면 불변**: 기존 제안함(제안 → 승인/안 올림 → 도장 WAL·세대 결속)에 kind `curator`로 합류. 사용자 판단 종류 늘지 않음.
  개요 "지금 정할 것" 합산은 기존 '수칙서 후보' 항목이 그대로 담당.
- **P6 저장소 결속**: 입력·키·모든 행에 `repoKey`(정찰 대상 저장소)를 넣는다 — 기존 초안 관문(후보 repoKey 부재·불일치=거부)을 **그대로**
  통과하게(관문 완화 없음·ab-1). 같은 작업 폴더에서 대상 저장소가 바뀌면 이전 저장소의 큐레이션 결과는 다른 키가 되고 복구 대상이 아니다.
- **P7 연산은 보존·변환은 승인 시**: 제안기의 작업 종류(추가·빼기·제외 추가·전환)는 후보 행에 필드로 남고(kind는 `curator` 고정), 승인
  시점에 기존 초안 계약의 연산으로 변환한다. 1차 범위=추가·제외 추가·빼기, 전환(항상↔관련)=2차(연결쌍).

## §3 설계 (부품 A~F)

### A. 트리거 (검증 무관·유계)
- 세 갈래: ① 대시보드 버튼 "정리 제안 받기"(수동·즉시) ② 마지막 큐레이션 이후 **마감된 캠페인 K건**(기본 10) ③ 신호 임계
  (oos-repeat ≥2·lineage ≥3·unused-rule 30일·selOver 3회 중 하나) — ②③은 Claude/Codex 훅의 기존 tick 자리(map-bootstrap `hookTick` 옆·
  같은 유계 규약: 파일 판독 상한·spawn 1회·실패=advisory)에서 **판정만** 하고 실행은 detach. 실행 중 잠금(`curate.lock` — P8 run-lock
  문법·구조화 토큰·죽은 소유자만 회수)·동시 1개·같은 ws.
- 팔 결정=P4 `selectorArmForCuration(ws, c)`. 비용 상한: 1페이지 호출·선별 예산 공식과 같은 timeout·초과=실패 영수증(검증 무영향).

### B. 입력 집계기 (순수 함수·시험 대상)
- `curationInput(ws, repo)` → `{wsKey, repoKey, boundaryGen(envelopeHash), archiveGen(archiveHash), signals:{oosRepeat[], lineage[], escalation[],
  unusedRules[], rebutUsed[], selOver[]}, rules:{core(3축·itemFp), archive(itemFp·태그)}, decisions:{open, answered}}` — 전부 장부 판독·정규화
  (개인정보 원문 없음 — 제목·id·횟수·지문만). `itemFp`=기존 초안 관문과 같은 항목 지문 규칙(정규화 문안 sha1).
- **실행 생략**: 모든 신호가 0이고 코어·서고 세대가 마지막 실행과 같으면 페이지 호출 없이 "제안 없음" 영수증(대부분의 실행이 여기).

### C. 제안기 (selector-runner `purpose:"curate"`)
- 입력=B의 표+현재 수칙 전문(항목마다 `axis·index·itemFp` 병기 — 같은 문안이 두 줄 있으면 두 줄 다 번호가 다르게 실림). 출력=JSON 행 ≤3:
  `{operation:"add"|"oos-add"|"remove"|"toggle", target:"core"|"archive", axis, title(문안 — 기존 후보 정본 필드명), index?·itemFp?(remove·toggle 대상: 제안 시점 번호+항목 지문),
  why(성격), refs:[신호 id…], recommend:"항상"|"관련"}`
  + 항목마다 사용자 표현 4요소(ⓐ있었던 일 ⓑ올리면 달라지는 것 ⓒ안 올리면 유지되는 것 ⓓ권장+근거 — VERIFY-GOVERNANCE §7·§8 계약 그대로).
- 파서: 손상 행=전량 거부(fail-closed)·재발급은 다음 실행(P6 재발급 절 규약 재사용). `toggle`은 1차에서 파서가 **보류 표시**로만 받는다(D 참조).

### D. 커밋 (REJUDGE §3 C의 2단 커밋 재사용·검증 job 무관·저장소 결속)
- `curationKey = sha1(wsKey|repoKey|boundaryGen|archiveGen|입력 표 지문)` — 같은 입력=같은 키(멱등).
- 후보 행(모든 단계 공통 필드): `{candidateId=envelopeCandidateId("curator", curationKey|operation|target|axis|occurrence|정규화 문안 sha1), kind:"curator", repoKey,
  envelopeHash(=boundaryGen), archiveHash(=archiveGen), operation, target, axis, index?(=occurrence·제안 시점 번호), itemFp?, expectedTargetHash(=target이 core면
  boundaryGen·archive면 archiveGen), title(문안 — 기존 판독·표시·초안 관문이 요구하는 정본 필드·`text` 별칭 없음), why, refs, recommend, curationKey, ts}`.
  같은 문안에 대한 서로 다른 작업(예: 추가와 빼기)이 같은 id로 충돌하지 않도록 operation·target·axis·occurrence가 id에 들어간다.
- ① `status:"provisional"`(비노출·latest 판독이 무시) append → read-back(원시 행 대상) → ② 결과 행(큐레이션 장부 `curation/<wsKey>.jsonl` — `{schema:"curation-v1", type:"result", curationKey, repoKey, boundaryGen, archiveGen, resultFp, items, fresh, …}`; 실행 행은 `type:"run"`) →
  ③ 활성화 행 `status:"proposed"`(같은 필드 전부 재기록) → ④ selectorUsage 영수증(`purpose:"curate"`, `turnAnchor`=curationKey; 2건 이상 resultFp
  상이=fail-closed 경보). 세대 변경 시 구세대 proposed는 rule-manual과 같은 1회 이월(repoKey 동일할 때만).
- **승인 시 변환(초안 계약 확장 — 소규모)**: draftable allowlist에 `curator` 추가하고, 채택 경로가 후보의 `operation`을 읽어
  - `add`(target archive·axis alwaysBlocker) → 현행 `addCandidateIds`(무변);
  - `oos-add`(target core·axis outOfScope) → 초안 계산기의 추가 축을 후보 `axis`로 결정(현행 'ab 고정'을 후보 axis 우선으로 확장 — 후보에 axis 없으면 현행 기본);
  - `remove` → 승인 시점에 **같은 전이 잠금 안에서** 후보의 `{axis, index, itemFp, expectedTargetHash}` 3중 대조(현행 파일의 그 번호에 그 지문의 항목이 있고 대상 세대가
    제안 시점과 같을 것 — 하나라도 다르면 거부·재제안; 같은 문안이 두 줄이어도 사용자가 승인한 그 번호만 빠짐 — ab-2) 뒤 `removeItems=[{axis,index,itemFp}]`로 넘김.
    **원 후보 종결 결속**: `draftEnvelopeRevision`에 `sourceCandidateIds`(이 초안을 낳은 curator 후보 id — remove·oos-add 포함) 인자를 추가해 제안 파일(proposal)의
    `candidateIds`와 같은 자리에 기록하고, 도장 시 같은 잠금 안에서 그 후보들에 `adopted`+`applied:<newHash>` 종결 행을 남긴다(쓰기 실패=전이 미완·WAL 보존; 폐기·복구 경로도 같은 목록을 따름) — 승인된 빼기가
    미승인 수(상한 6)에 남지 않게(2회차 blocker⑤);
  - `toggle` → **2차**: 연결쌍(`linkId` 공유·add-first) 두 제안으로 전개 — 도착지 추가 승인 뒤에만 출발지 빼기 제안이 활성(수칙이 잠시라도 사라지지 않게).
  기존 관문(후보 repoKey=현재 저장소·세대 일치·중복 거부·`title` 필수)은 완화 없이 그대로. 초안 계약 확장은 세 가지뿐: 추가 축을 후보 `axis`로(oos-add), `removeItems`의
  3중 대조(index+itemFp+expectedTargetHash), `sourceCandidateIds` 종결 결속.

### E. 표면
- 제안함: 기존 카드에 `curator` 항목이 "정리 제안"으로 표기(operation 라벨·why·refs 표시). 수칙 카드 하단 1줄: "마지막 정리 제안 <시각> · 제안 n · 미승인 m".
- 대시보드 버튼 "정리 제안 받기"(A①). 실패·보류는 기존 경보 채널 1종(`curation-failed`, 확인 가능).

### F. 측정
- 채택률(승인/제안)·서고 크기·선별 초과 횟수·미사용 수칙 수 — 수칙 카드 1줄(통계 탭 신설 없음).

## §4 하지 않는 것(명시)
- 자동 승인·자동 도장(사용자 전용 표면 불변). 검증 job 단계 추가. 코드·소스 판독으로 수칙 생성. 캠페인마다 실행(비용). 구현자 rule-propose
  폐지(REJUDGE §8 ① 기본값). 통계 탭 신설. 초안 관문 완화(repoKey·세대·중복). 1차에서 전환(toggle) 실제 전개.

## §5 ab 경계 자기 점검
ab-1 wsKey·repoKey 결속(입력·키·모든 행·영수증) · ab-2 계약 필드 추가 없음(제안은 장부·앵커 무접촉) · ab-3 검증 판정 무접촉 · ab-4 제안자=독립
실행(구현자·검증자 세션 아님·팔은 계약 유래) · ab-5 append-only 장부·도장 WAL 재사용 · ab-6 detach·잠금 유계·실패=영수증 · ab-7 why 민감정보 거부·개인정보 원문 없음.

## §6 사용자 결정 — 기본값으로 닫음(재진입 조건)
| 항목 | 기본값 | 재진입 조건 |
|---|---|---|
| 트리거 K(마감 캠페인 수) | 10 | 제안 채택률·서고 크기 실측 뒤 |
| 회당 제안 상한 / 미승인 누적 상한 | 3 / 6 | 사용자가 "더 보여 달라" 실보고 |
| 실행 팔 | 계약 운용 모드 유래(claude-codex=self·codex-codex=codex) | 선별기 팔 정책 재론 때 |
| 전환(toggle) | 2차(연결쌍) | 1차 채택률 실측 뒤 |
| 구현자 rule-propose | 잔존·표기 | 큐레이션 채택률이 안정되면 폐지 재론 |

## §7 순서(구현 착수 시)
1. B 입력 집계기+생략 규칙+영수증(시험: 신호 0=무호출·표 지문 결정론·영수증 두 형식 모두 사용으로 셈·repoKey 포함). 2. C·D 제안기·파서·2단 커밋·
승인 변환(시험: 상한 3·누적 6·중복 거부·손상 fail-closed·멱등·repoKey 불일치=관문 거부·remove 3중 대조[번호 어긋남·지문 어긋남·세대 어긋남 각각 거부·같은 문안 두 줄 중 승인한
번호만 제거]·sourceCandidateIds로 빼기 후보 adopted 종결·title 필드로 add/oos-add 초안 통과·toggle 보류).
3. A 트리거+팔 결정+잠금+detach(시험: 동시 1·죽은 잠금 회수·검증 무영향·세션 문맥 없이 팔 결정). 4. E·F 표면. 각 단계 Codex 확인 검증+전체 체인.

## §8 구현 기록 (2026-09-03 — §7 1·2단계)
- `bridge/curation.js`(신설·설치 목록 편입): `curationInput(ws, repo)`(B — repo 불일치·수칙서 비활성·미승인 변경·도장 없는 서고=정직 실패 / 코어·서고 항목 `axis·index·itemFp` / 신호 ①~④=대시보드
  참고 신호와 같은 산출(`computeEnvelopeCandidatesFor.signals`·세대 일치 시) ⑤ 미사용 보관 수칙=선별 영수증(미리보기+검증 선별) 합집합·관측 0건이면 주장 안 함·일수 동봉 ⑥ 되받아침 제외 칸 ⑦ 선별 초과
  ⑧ 결정 장부 / 시각 성분 없는 `inputFp`) · `curationKeyOf` · `curationSkip`(신호 0+같은 세대의 지난 실행=생략 · 같은 입력 표 결과 존재=멱등 생략) · `buildCurationPrompt`(C — 범주 지시·수칙
  전문에 axis·index·itemFp 병기·refs는 신호 id만) · `parseCurationOutput`(손상=전량 거부 / 의미 거부=항목 탈락 기록 / toggle=보류) · `commitCuration`(D — provisional→결과 행→proposed 2단·
  read-back·같은 curationKey 다른 결과=fail-closed `result-conflict`·회당 3·미승인 6) · `writeCurationReceipt`(selectorUsage `purpose:"curate"`·`turnAnchor`=curationKey) · `acquireCurateLock`(구조화
  토큰·죽은/오래된 소유자만 격리 후 회수) · `runCuration`(실패=영수증+경보 `curation-failed`·검증 장부 무접촉) · `selectorArmForCuration(ws, c)`(P4 — 계약 `harnessMode` 유래) · `curationSummary`.
- `bridge/contract-lib.js`: `ENVELOPE_DRAFTABLE_KINDS`에 `curator` · `draftEnvelopeRevision` 확장 3가지만(추가 축=후보 `axis`[oos-add→outOfScope] · `sourceCandidateIds` 결속[제안 파일 candidateIds
  한 자리+adopted] · 기존 `removeItems` 3중 대조 그대로) · `draftCuratorCandidate(ws, repo, candidateId, approvedHash)`(승인 시 변환 — add→서고·oos-add→코어 제외 칸·remove→removeItems+
  expectedTargetHash+sourceCandidateIds·toggle=거부·첫 행 메타 폴백) · 도장 전이 ③에서 결속 후보에 `adopted+applied:<newHash>` 종결 행(같은 잠금 안) · 조정 스캔: `applied` 행=이월·고아 복원 제외,
  curator 구세대=add/oos-add 1회 이월·remove는 대상 세대 동일(서고)일 때만 이월·그 외 정리(declined·재발급 대상)·빼기 제안 문안은 '이미 등재' 스윕 제외 · 복원형 폐기가 curator 연산 필드를
  승계(`curatorCarryFields` — 승인→취소→재승인 경로 실측 결함 봉합).
- `bridge/codex-bridge.js`: CLI `curate [run|input|status] [--force] [--json]`(A① 수동 트리거 — 실행은 동기·검증 무관) · 후보 계산기 ⑤가 curator 행에 `operation·target·explain` 동봉 · 소진 보고 kindLabel.
- `src/extension.ts`: 제안함 candMark 채택 분기에 `curator`(→`draftCuratorCandidate`) · 후보 행 라벨 "독립 정리 담당이 … 올린 제안" + 작업 종류 + 상황 설명 4칸(textContent) · 상태 타입 `op/explain`.
- 시험 `tests/curation.test.js`(24묶음 — 1·2회차 blocker 반영분 포함) · 낡은 핀 갱신(gov7-candidates·memory-authority·p8-enrich-wire 배포 33파일·map-cutover EXPECTED_DEPLOY_FILES). 미구현(다음 캠페인): A②③ 자동 트리거(tick 판정·detach)·E 대시보드 버튼 "정리 제안 받기"·수칙 카드 1줄·F 측정.
- 구현 검증 1회차 blocker 7 반영: ① CLI 순환 require로 신호가 0건이 되던 침묵 → 신호 산출 함수 주입(`computeCandidates`)·부재=입력 실패(`signals-unavailable`) ② 파서=출력 전체가 JSON 객체 하나·why/explain 개행=손상
  ③ ab-7: 신호 제목·결정 질문은 민감 형태면 생략/표식, explain 4칸도 검사(탈락) ④ 결과 행을 복구 표지로 provisional 후보 재활성화(`recoverCurationProvisional`, 실행 시작 시·잠금 안) ⑤ 도장 순서=applied 종결·제안본 폐기 → WAL 삭제
  ⑥ 후보 계산기 메타 캐시가 operation/target/explain 보존 ⑦ 시작 단계 실패(계약·저장소·잠금 비정상·입력)도 영수증+경보(잠금 '실행 중'만 영수증만).
- 구현 검증 2회차 blocker 5 반영: ① CLI `curate run`은 모듈 평가가 끝난 다음 틱에 실행(Codex 팔이 조회하는 `resolveCodex` export가 채워진 뒤)·시험 주입점 `CODEX_BRIDGE_SELECTOR_RUNNER`
  ② 현재 수칙 원문도 민감 형태면 프롬프트·remove 후보 title에 표식(`[민감 형태 — 문안 생략]`)만·itemFp는 원문 기준 ③④ provisional 복구 쓰기 실패=실행 실패(recover-failed)+영수증+경보(생략으로 위장 금지)
  ⑤ 도장의 applied 종결 행 쓰기 실패=전이 미완(`applied-write`)·WAL·제안본 보존 → 복구 스캐너 멱등 재실행.

## §9 구현 기록 (2026-09-04 — §7 3·4단계)
- 3단계 트리거·detach(`bridge/curation.js`): `curationTickJudge(ws, c)` — 판정만(장부 4종 유계 판독: 큐레이션 실행 행·캠페인 이력·지적 장부 마지막 캠페인·선별 영수증·attach)·
  ② 마지막 실행 이후 마감 캠페인 K=10(`CURATION_TICK_K`) ③ 신호 임계 `CURATION_TICK_THRESHOLDS`(oos-repeat ≥2·lineage ≥3·unused-rule 30일[관측 0건이면 주장 없음]·selOver 3) ·
  무실행 사유=envelope-inactive·repo-unresolved·running(잠금 산 소유자)·recent(최소 간격 10분)·same-tick(마지막 실행 행 tickFp 동일)·below-threshold.
  `curationHookTick(ws, c)`(훅 층)=계약·잠금·tick 상태 3파일만 보고 최소 간격(10분)이 지났으면 상태를 찍은 뒤 `node codex-bridge.js curate tick`을 detach(cwd=ws·CLAUDE_PROJECT_DIR=ws)·항상 null(무고지 — 결과는 수칙 카드)·실패=null.
  자식 `curate tick`=curationTickJudge(꼬리 상한 판독) → spawn이면 같은 프로세스에서 runCuration(trigger auto·tickFp). (초판의 "훅이 curate run --auto를 직접 detach·안내 1줄"은 2회차 확인검증 뒤 폐기.)
  훅 연결: `contract-inject.js`·`codex-hook.js`의 map-bootstrap `hookTick` 옆(advisory·검증 훅/워커/ask-start 무접촉 — P1 소스 핀). CLI `curate run --auto|--button [--tick <fp>]`가 실행 행에 `trigger`·`tickFp`를 남긴다.
- 4단계 표면·측정: `curationSummary(ws)`에 lastTrigger·adopted(applied)·declined·adoptRate·archiveSize·selOverCount·unusedDays·running 추가(§3 F 4지표). 대시보드 상태 `curation`(수칙 카드 1줄
  "마지막 정리 제안 <시각>(트리거·결과) · 제안 n · 미승인 m/6 · 채택률 · 서고 크기 · 선별 초과")+버튼 "정리 제안 받기"(→ `curationRun` 메시지 → detach `curate run --button`·실행 중이면 비활성). 실패·보류는 기존 경보 `curation-failed`. 개요 '지금 정할 것' 미합산.
- 시험 `tests/curation-trigger.test.js` 8묶음(훅 층·K 누계·tickFp 1회·신호 4종 단독·옛 세대 해소 계보 반례·CLI tick/run·저장소 전환 반례·소스 핀).
- **구현 검증 1회차 blocker 5 반영(2026-09-04)**: ① 신호는 현재 세대(envelopeHash)의 마지막 캠페인·열린 지적(close 행 없음)만 — 옛 세대 해소 계보 재발동 차단 ② 마감 캠페인 누계는 tick 상태 파일
  `curation/<wsKey>.<repoKey>.tick.json`(repoKey 결속·seen id ≤64+시각 워터마크 hwm·k·judgedAt·ranAt·tickFp·reason)에 누적 — 캠페인 이력 60일 절단·seen 절단과 무관(워터마크 이전 행은 재계수 없음), 첫 tick은 기준선(k=0), 실행(입력 단계 진입)마다 k=0 ③ 훅 층은
  계약·잠금·tick 상태 3파일만 보고 `curate tick`을 detach(전수 판독 0·최소 간격 10분·무고지), 판정·실행은 자식(꼬리 256KB·영수증 최신 300개 상한) ④ 요약은 현재 repoKey의 실행·결과·후보만
  ⑤ 4번째 지표 미사용 수칙 수(unusedCount·관측 일수)를 요약·카드에 표시.
- **2회차 blocker 2 반영**: ⑥ tick 상태·마감 캠페인 누계=(wsKey, repoKey) 파일로 분리(정찰 대상 전환=새 기준선) · 선별 초과(selOver)는 attach 행의 수칙서 세대(envelope.hash)=현재 세대일 때만(입력 집계기도 동일) ·
  선별 영수증·지적 장부는 종전대로 archiveHash·envelopeHash(저장소별 파일 지문) 결속 ⑦ 누계는 시각 워터마크+seen 병행으로 seen 상한 절단 뒤 옛 id 재계수 차단.
- **3회차 blocker 2 반영(미완 수정 봉합)**: ⑧ 기록 지점 4곳에 정찰 대상 저장소 지문 `repoKey`를 싣는다 — 캠페인 카운터(`reserveVerifyCampaign` → 이력 행 승계)·선별 미리보기 영수증·검증 선별 영수증(worker)·첨부(attach) 행.
  판정·입력 집계는 그 표식으로만 거른다: 마감 캠페인 누계=이력 행 repoKey 일치분 · 지적 장부 신호=이 저장소 캠페인 id(카운터·이력 repoKey)에 속한 행만 · 영수증·첨부=repoKey 일치분. 표식 없는 옛 행은 불산입(보수).
  같은 내용 지문(수칙서·서고)을 가진 두 저장소도 섞이지 않는다.
- **4회차 blocker 2 반영**: ⑨ 입력 집계기의 되받아침 신호(rebutUsed)도 이 저장소 캠페인(`repoCampaignIds`)의 처분만 — 마지막 남은 무결속 경로 봉합(ab-1) ⑩ tick 상태에서 캠페인 id 배열(seen)을 폐기하고
  워터마크 시각(`hwm`)+**그 시각에 마감된 캠페인 id 집합**(`hwmIds`)으로 센다: 새 마감=워터마크보다 나중 시각 전부+같은 시각에서 집합에 없던 것. 집합은 같은 밀리초 마감분만 담아 실사용에서 1~2개이고 절단하지 않는다.
  이력이 짧아져도 워터마크는 되감기지 않으며(Math.max), 꼬리에서 행이 사라져도 집합이 '이미 센 것'을 기억해 절단과 신규 추가가 겹쳐도 정확하다(구조 이전 상태=기준선 재설정).
- **5회차 blocker 2 반영**: ⑪ 결정 장부(open/answered)도 이 저장소 캠페인의 결정만 입력·프롬프트·유효 refs에 싣는다(마지막 무결속 경로) ⑫ 워터마크의 '개수' 비교를 id 집합 비교로 교체(절단과 동시각 추가가 상쇄돼 신규를 놓치던 경로 봉합).
- **확인검증(2026-09-05) blocker 1 반영 — 캠페인 대리 매핑 폐기**: 창 두 개가 저장소를 바꿔 가며 같은 캠페인을 이어가면 한 캠페인 id가 두 저장소 이력에 함께 남아 "캠페인 id→저장소" 매핑이 무너진다.
  그래서 ⑬ 지적 장부 append 관문(`appendFindingsLedger`)이 지적·등장·종결·승격·처분·판단 행 전부에 기록 시점 `repoKey`를 심고(호출자 값 보존), 결정 생성(`openDecision`)도 `repoKey`를 기록한다.
  결정·되받아침·지적 신호는 **행의 repoKey**로만 거른다(표식 없는 옛 행=불산입). 캠페인 id 매핑은 마감 캠페인 수(K) 계수에만 남는다(이력 행 자체가 repoKey를 가짐).
- **확인검증 2판(2026-09-05) blocker 2 반영**: ⑭ 입력 집계기의 캠페인 신호(oos-repeat·lineage·escalation·unused-oos)도 후보 집계기 `computeEnvelopeCandidatesFor(ws, {rowFilter})`에 행 필터(repoKey===현재 저장소)를 넘겨
  같은 캠페인·같은 세대의 타 저장소 행을 배제한다(대시보드의 무필터 호출은 종전 그대로) ⑮ 비동기 검증 결과 행의 표식=검증 **시작** 스냅샷의 저장소 — `machineFindingsLayer`가 시작 시점 repoKey를 받아 append 관문 override(`opts.repoKey`)로 심고,
  처분·종결 행(finding-judge)은 대상 지적 행의 repoKey를 승계한다(판단 시점 계약이 아님). 완료 시점 계약으로 찍으면 응답 대기 중 대상 전환에 A 결과가 B로 귀속되는 경로(수정 유발 결함)를 닫는다.
- **확인검증 3판(2026-09-05) blocker 2 반영 — 판독도 같은 저장소로**: ⑯ 집계기의 열린 지적 판독을 필터된 장부(`openFindingsFromRows(ledger9)`)로 바꿔 타 저장소 open 행이 닫힌 계보를 되살리지 못하게 함.
  ⑰ 검증 결과 처리(`machineFindingsLayer`)의 판 유형(`deriveRoundType(…, rows)`)·라운드 번호·열린 목록·승격 사용·기존 id 판독을 시작 스냅샷 저장소와 '다른' 표식의 행을 제외한 장부로 계산(표식 없는 옛 행은 호환상 포함) — A 판이 B 지적을 닫거나 B 통과로 confirm이 되던 경로 차단.
  finding-judge의 열린 목록·대상 행 선택도 현재 저장소 우선. 표식 정책 요약: 큐레이션 신호=표식 일치만(옛 행 불산입·보수) / 검증 결과·판단 판독=다른 표식만 제외(옛 행 포함·연속성).
