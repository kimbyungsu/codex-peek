# 근거 재확인 루프(evidence challenge) — 설계 v6 (동결)

> 2026-08-03 동결. 결정 계보: 사용자 결정(경보를 검증자에게 되돌려 재확인·1회 한정·누락 시 경고 유지·
> 검증 상한과 별개) + 설계검증 5왕복(blocker 9·보완 3·주의 1 전부 수용, 반박 0 — 처분 장부
> f-ef91fe61·f-2c986b4e·f-9edd4e62·f-4ad47e7d·f-887f54be·f-5a966fd5·f-cc8fe8a9·f-b20c5d53·
> f-e0a7dc2c·f-73a53416·f-b2f03897). 상한 소진으로 통과 도장 없이 수렴 — 본 문서의 확인 검증 1회가
> 그 도장을 대신한다.

## 0. 문제와 방향

`flagEvidence`의 evidence-unseen 경보(검증 답이 인용한 파일을 이 검증 기록에서 다룬 흔적 미확인)는
현재 무결성 로그에만 남아 구현자만 본다. 경보를 줄이려 탐지기의 '판독 명령 인식 형태'를 늘리는 축은
형태마다 새 위조 통로를 만들며(2026-08-03 blame `--contents` 계보 실측) 원리상 완결 불가다.

**방향 전환**: 경보를 검증자에게 되돌려 1회 재확인시키고, 재확인의 인정 기준을 자기보고가 아니라
**내용 증명**(브릿지가 동결한 파일 구간의 원문 바이트 반환→로컬 대조)으로 둔다. 탐지기는 모든 판독
형태를 알 필요가 없어지고, 잔여 경보는 노이즈가 아니라 재확인 신호가 된다.

- 참고: 같은 날 대조기 구분자 정규화 수정(커밋 e2f1392)으로 매턴 오경보의 주 원인은 이미 제거됨.
  본 루프는 그 뒤에 남는 진짜 '흔적 미확인'을 다루는 구조 장치다.

## 1. 불변 원칙 (G)

- 재확인 결과는 **경보 해소에만** 쓴다. 캠페인 판정(통과/실패)·왕복 예산·proof·findings 장부는 불변.
- 경보 1건당 재확인 **시도 최대 1회**. 여러 파일 경보는 1회 호출로 묶는다(비용).
- 재확인에도 누락·불일치·회피면 경보 유지(검증자 태만 기록). 자동 해소는 내용 증명 일치뿐.
- 기존 `gitReadParse` 허용목록 하드닝은 유지하고, 이후 '인식 형태 확장'은 하지 않는다.
- 재확인 호출은 검증 왕복 상한과 **별개 카운트**(성격=위생 점검, 판정 아님).

## 2. 경보 시점 동결 (A·J·I·M)

경보 기록 시점에 파일별로 동결(challenge 재료):

- **단일 스냅샷(J)**: 파일을 **한 번의 읽기(단일 Buffer)** 로 적재해 전체 SHA-256과 구간 digest를
  같은 바이트에서 계산한다(별도 읽기 2회 금지 — 중간 편집으로 세대가 섞인다). 구간 선택은
  `crypto.randomBytes` 기반. 장부에는 **digest와 범위만** 저장(원문 바이트 저장 금지).
- **동결 필드(A)**: 정규화 경로, **pathId**(브릿지 생성 파일별 ID — 요청·응답·장부에 공통 결속),
  전체 파일 SHA-256, 구간 offset/length, 구간 digest, challengeId. 구간은 브릿지가 지정한다
  (검증자 지정 금지).
- **구간 적격성과 선택 순서**(확인 검증 보완 반영 — 이 순서가 규범):
  1. **적격성 검사 선행**: ⓐ기노출 제외 — 원 요청문·답변 텍스트에 그대로 등장하는 바이트 구간은
     후보에서 제외한다. ⓑ저정보 판정(확인 검증 [주의] 2건 반영·강화) — 다음 중 하나면 부적격:
     구간 길이 16바이트 미만 / 고유 바이트 종류 8 미만 / 공백류 90% 이상 / **어떤 주기 p
     (1 ≤ p ≤ 길이/2)로도 완전 반복이면 부적격**(예: `true`·`abcd`·`abcdefgh` 반복 — 주기 임계
     열거가 아니라 자기반복 일반 판정).
  - **수용 위험(정직 명시)**: 적격성 검사는 발견법이다 — '추측 가능한 내용'의 완전 판정은 원리상
    불가하므로(반복이 아니어도 예측 가능한 수열 등), 무판독 응답이 우연히 일치하는 잔여 경로가
    이론상 남는다. 피해는 한정된다: 캠페인 판정·proof·왕복 예산은 불변이고, 불일치·회피는 항상
    실패 방향(태만 기록·경보 유지)이며, 영향 범위는 '경보 1건의 해소 표시'뿐이다.
  2. 적격 후보 중에서 `crypto.randomBytes` 기반으로 선택한다.
  3. 파일이 64바이트보다 작으면 전체를 구간으로 쓰되, **같은 적격성 검사를 통과해야** 한다
     (16바이트 미만 파일은 항상 부적격 → `no-safe-span`).
  4. 적격 후보가 하나도 없으면 그 파일은 발송하지 않고 `no-safe-span` 사유를 기록한다(경보 유지).
- **루트 결속(I)**: challenge 후보는 `realpath` 기준으로 **원 execCwd 또는 승인된 정찰 대상 루트의
  자손**만. Windows 대소문자·경로 구분자 경계 비교, symlink 이탈 거부. 루트 밖 인용은 challenge
  없이 `out-of-root` 사유로 경보 유지(임의 경로 문자열이 외부 전송 통로가 되는 것을 차단).
- **크기 상한(M)**: 읽기 전에 검사 — 파일별 크기 상한(`CH_MAX_FILE_BYTES`=1 MiB), 경보당 총 읽기
  바이트(`CH_MAX_TOTAL_BYTES`=4 MiB), challenge 파일 수(`CH_MAX_FILES`=8), 총 응답 바이트
  (`CH_MAX_RESP_BYTES`=64 KiB). 초과분은 추가 호출 없이 `too-large`/`cap-exceeded` 사유로 경보 유지.
  구간 길이는 64~512바이트(파일이 더 작으면 전체).

## 3. 재확인 호출 경로 (B·H·E)

- **탐지·발송 분리(H)**: 원 턴의 후처리(proof 기록·`flagLedgerConfirms`·정찰 증거·machine findings·
  `flagVerdict`)를 **전부 동결·기록 완료한 뒤에만** challenge를 발송한다. 원 턴 경계와 telemetry는
  resume 전에 동결 — challenge 턴이 원 답변의 결합 판독 증거나 검증 통계로 소비될 수 없다.
- **전용 저수준 경로(B)**: `flagEvidence` 안에서 일반 `ask`/`ask-start` 재호출 금지(활성·inflight
  표식에 자기 차단됨). 활성 표식을 보유한 같은 소유 프로세스가 원 검증자 세션으로 직접
  `runCodex(["resume", …])` 하거나, 내구 worker의 'job 성공 확정 전 evidence 단계'로 수행한다.
  이 경로는 `reserveVerifyBudgetGate`·`beginVerifyAttempt`·`writeProof`·`machineFindingsLayer`·
  `flagVerdict`·findings 장부를 **일절 호출하지 않는다**. 응답은 challenge 결과만 파싱하고
  재귀적으로 `flagEvidence`에 넣지 않는다(왕복 우회·재귀 차단).
- **모드·언어·프로젝트(E)**: 내구 job의 동결값(모드·언어·캠페인)과 **원 verifier session**만 소비
  (전역 설정 판독 금지). 연결이 바뀌었거나 세션이 사라졌으면 **새 세션을 만들지 않고** 경보 유지.
  요청 문안은 동결 `langSnap`으로 만들고, 응답 블록 형식은 언어 중립.

## 4. 응답 형식과 판정 (C)

- 요청: 파일별로 challengeId·**pathId**·경로·구간(offset/length)을 제시하고 "그 구간의 원문
  바이트를 base64로 반환하라"고 요구한다.
- 응답(언어 중립 기계 형식): 줄 단위 `CH <challengeId> <pathId> <base64(raw bytes)>`.
  challengeId가 다르거나 **미지·중복 pathId**인 줄은 거부한다(중복=먼저 온 줄만 무효가 아니라
  그 pathId 전체를 응답 누락으로 처리 — 어느 줄이 진짜인지 알 수 없으면 안 세는 쪽이 안전).
- 대조는 **동결 스냅샷 기준**(현재 파일 아님):
  - base64 디코드 바이트의 digest == 동결 구간 digest → 그 파일 `resolved`.
  - 불일치·응답 누락·회피 → 현재 파일을 다시 단일 읽기로 검사해
    - 전체 SHA-256이 동결값과 다르면 `indeterminate`(file-changed — 태만 기록 아님),
    - 같으면 `failed`(태만 기록·경보 유지).
  - 읽기 실패·저정보 파일·안전 구간 부재는 애초에 발송하지 않고 사유 기록(`read-fail` 등).

## 5. 내구 challenge 장부와 이벤트 투영 (D·K)

- **장부 = 권위 원본**(ws 결속·비절단·50건 절단 이벤트와 별도 파일). 레코드:
  challengeId·원 이벤트 ID·파일별 {**pathId**, 경로, 해시들, 구간, 상태}·원 ws/execCwd·verifier
  session·모드/언어 동결·campaign/ask ID·시도 횟수(최대 1)·타임스탬프.
- 상태: `pending → dispatched → resolved | failed | indeterminate | outcome-unknown`.
- **호출 전 `dispatched` 원자 기록**. 강제 종료 후 결과를 복구하지 못하면 **재발송하지 않고**
  `outcome-unknown` 유지.
- **투영 순서(K)**: 파일별 `resolved`를 장부에 원자 선기록 → 이벤트 전체 해소 조건(**전 파일
  resolved**) 충족 시 원 이벤트를 `ackIntegrityEvents(ids)`로 투영. 중간 종료 복구는
  resolved→ack 투영을 재실행(거짓 해소 없음). 미종결 레코드 삭제 금지, 종결 레코드는 감사
  보존기간(90일) 후 정리.

## 6. 원 검증 성공과의 생명주기 분리 (L·N)

- **primary-complete checkpoint(N)**: 원 검증 출력 파일을 **원자 기록하고 read-back으로 확인한 뒤**
  checkpoint를 생성한다. checkpoint 결속 필드: job ID·workspace·구현 턴/revision·verifier session·
  proof 지문·출력 바이트 수·출력 SHA-256.
- checkpoint 이후 challenge 중 강제 종료 시: worker는 원 job을 **succeeded로 확정**하고(부분
  stdout으로 checkpoint 결속 출력 파일을 덮어쓰지 않는다 — 결속본이 권위), challenge만
  `outcome-unknown`으로 남긴다. `writeRecoveryReceipt`의 proof 회수 계약이 보존된다.

## 7. verifier 세션 전역 lease (O — v6 개정)

- lease의 **유일 키 = 정규화한 verifier session ID 전역 1개**. workspace·mode·job ID·PID·token은
  소유자 메타데이터다(복합 키 금지 — (A,S)·(B,S) 두 창이 같은 세션 S에 동시 resume하는 경합 차단).
- **일반 검증 resume와 challenge resume 모두 같은 lease를 확인**한다. 원 검증이 획득한 lease를
  같은 token으로 challenge까지 유지·이관해 둘 사이 무잠금 구간을 없앤다.
- 강제 종료 복구: 기록된 child PID가 살아 있으면 다음 resume 차단 유지, 죽었으면
  `outcome-unknown` 전이와 lease 해제를 원자적으로 수렴. lease 없이 challenge resume 불가.
- workspace별 보조 인덱스는 정리·표시용으로만.

## 8. 고지 (F)

- 구현 묶음에 동승: PRIVACY(전송 4경로에 '재확인 시 브릿지가 선택한 파일 구간 바이트가 추가
  전송됨' 명시)·추가 비용(재확인 1회=Codex 호출 1회) 고지, 기존 동의 범위와 대조.

## 9. 구현 증분 계획

1. **증분 1 — 순수 계층**: `bridge/evidence-challenge.js` 신설: 스냅샷 동결(단일 Buffer·구간 선택·
   digest), 루트 결속 검사, 크기 상한, challenge 장부(상태기계·원자 기록·복구 판독), 응답 파싱·대조.
   전 기능 실행 반례 테스트.
2. **증분 2 — checkpoint**: primary-complete(출력 선기록+read-back+지문 결속), worker 복구 분기.
3. **증분 3 — 전역 lease**: session 전역 잠금 + 기존 resume 경로 합류 + token 이관.
4. **증분 4 — 발송 배선**: flagEvidence→(후처리 완료 후) challenge 발송·응답 수거·ack 투영,
   대시보드 표시(재확인 대기/해소/태만), PRIVACY·README 고지.
- 각 증분마다 테스트+Codex 검증. 상한 수치는 §2의 상수로 구현하고 테스트로 잠근다.
