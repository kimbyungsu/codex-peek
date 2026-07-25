# Project MAP P10 상세 설계 v1 — 통계·비용·건강도

> 상태: **v1 동결**(2026-07-25, 독립 설계 검증 완료 뒤 사용자 승인 `terminal-missing` 보완 반영).
> 이후 구현은 이 문서의 분모·필드 의미를 바꾸지 않고 증분별로 진행한다.
>
> 상위 정본: `docs/MAP-V2-DESIGN.md` §5 P10 — “통계·비용·건강도
> (`scout-usage` 확장·지표 분리)”. 이 문서는 그 한 줄을 실행 가능한 계약으로 닫는다.
>
> 이 문서에서 **정찰**은 영향지도를 만드는 흐름, **의미 보강**은 P8이 구조 지도에 의미를 채우는 흐름,
> **자동 이어가기**는 P9가 이미 정한 사용자 정책에 따라 대기 변경을 계속 처리하는 흐름이다. 세 흐름을
> 같은 건수나 같은 성공률로 합치지 않는다.

## 0. 목표와 성공 조건

P10의 목적은 “AI가 얼마나 똑똑했는가”를 점수 하나로 매기는 것이 아니다. 사용자가 다음 세 질문에
거짓 없이 답을 얻도록 한다.

1. **무슨 일이 있었나** — 최근 28일 동안 의미 보강이 몇 묶음 시작됐고, 자동으로 끝난 묶음과 사람 확인을
   기다리는 묶음이 각각 몇 개인가.
2. **어떤 사용량이 들었나** — 영향지도 생성, 준비 점검, 의미 보강, 검증 담당 판정이 각각 몇 번 외부 모델을
   불렀으며, 서비스가 실제 토큰을 준 호출과 글자 수만 알 수 있는 호출을 구분할 수 있는가.
3. **현재 지도를 믿고 참고할 수 있나** — 현재 Project MAP을 읽을 수 있는지, 유효 항목 중 최신·미확인·낡음이
   각각 몇 개인지, 검증 근거가 깨져 임시 제외된 항목이 몇 개인가.

성공 조건은 다음과 같다.

- 모든 비율에 화면에서 확인 가능한 분자·분모가 있다.
- 생성 호출 수, 실행 묶음 수, 지도 항목 수를 서로 나누지 않는다.
- 실제 토큰과 글자 수를 합산하거나 환산하지 않는다. 돈 금액도 추정하지 않는다.
- 현재 프로젝트에 귀속할 수 없는 옛 기록을 현재 프로젝트 실적으로 넣지 않는다.
- 2트랙에서는 P10 기록·지도 판독·화면 카드가 모두 0이다. 기존 검증 통계는 그대로 보인다.
- 한글/영어는 표현만 바뀌고 같은 프로젝트의 통계 원장은 공유한다.
- 세션 폴더와 실제 작업 저장소가 달라도 `resolveScoutRepo`가 고른 실제 저장소 하나로 귀속한다.
- 프롬프트, 모델 답변, 소스 발췌, 파일 경로, 정책 문구는 통계 파일에 새로 저장하지 않는다.
- 기록 실패는 정찰·의미 보강·검증 흐름을 막지 않되, 화면은 이 자료가 완전한 청구서가 아닌 로컬 관찰임을
  항상 밝힌다.

## 1. 직접 범위와 제외 범위

### 1.1 직접 범위

1. `stats/scout-usage.jsonl`의 하위 호환 확장: 외부 호출의 목적과 프로젝트 귀속을 분리한다.
2. 기존 `stats/map-route.jsonl`의 하위 호환 확장: 한 실행의 시작과 마지막 상태를 짝지을 수 있게 한다.
3. 두 파일을 읽는 순수 집계기와 현재 Project MAP 스냅샷 집계기.
4. 검증 통계 탭의 **Project MAP 운영 현황** 카드(3트랙에서만 표시)와 기존 정찰 비용 카드의 목적별 분리.
5. `PRIVACY.md`, README 한/영, HANDOFF 및 실행 반례 테스트.
6. 통계 파일별 잠금 안 append+60일 trim. 기록 실패는 비차단이다.

### 1.2 제외 범위

- MAP 스키마 버전, patch/decision/policy 형식, P8 라우터 표, P9 정책 의미와 적용 순서 변경.
- 새 자동 실행, 새 모델 호출, 새 동의, 가격표 조회, 환율·화폐 비용 계산.
- 공급자·모델의 품질 순위, “정확도”, 단일 건강 점수, 프로젝트 간 순위표.
- 검증 통계(`verdicts.jsonl`)의 판정·캠페인·토큰 계산 변경.
- 기존 관찰 일지의 “관찰 신호” 계산 변경. P10의 Project MAP 건강도와 별도 카드로 유지한다.
- P9 선택·복구 이력의 28일 성공률. P9는 현재 필요한 선택/재시도/복구 건수만 기존 파생 뷰에서 보여준다.
- 2트랙의 숨은 사전 계산. 카드만 숨기고 뒤에서 파일을 읽는 것도 금지한다.
- package 버전 상승, push, 마켓 게시.

## 2. 현재 구현에서 확인한 사실

1. `scout-usage.jsonl`은 60일 보존이며 현재 `arm` 하나에 정찰 지도, 연결 점검, 준비 점검, 의미 보강,
   검증 담당 판정이 섞인다.
2. 기본 정찰과 Codex 정찰은 모델 도구가 토큰을 주지 않아 글자 수만 기록한다. DeepSeek API 호출은 실제
   입력·출력 토큰을 준다.
3. P8 의미 보강의 `enrich-self`, `enrich-codex`, `enrich-adjudicate`, DeepSeek `enrich` 기록은 현재
   `workspace:""`이므로 어느 프로젝트 비용인지 확정할 수 없다.
4. `map-route.jsonl`은 한 P8 실행에서 여러 줄을 남기며 `jobKey`가 없는 줄도 있다. 현재 줄 수를 곧바로
   “작업 수”로 세면 라우팅 재시도와 마지막 결과가 중복된다.
5. P8은 3트랙 검사를 로그보다 먼저 수행하므로 2트랙에서 route 로그 쓰기 0이라는 불변식이 이미 있다.
6. 공용 reader는 현재 유효 node/edge, 검증 근거가 깨진 `degraded`, 항목별 fresh/stale/unknown을 같은 캡처에서
   구할 수 있다. 이 값은 저장된 점수가 아니라 화면을 열 때 다시 읽는 현재 상태다.
7. 기존 검증 통계와 관찰 일지 신호에는 이미 각자의 분모·표본 경계가 있다. P10이 이 숫자를 재포장하거나
   합산하면 안 된다.

## 3. 용어와 계수 단위

| 이름 | 정확한 한 단위 | 세지 않는 것 |
|---|---|---|
| 외부 호출 | 실제 서비스/CLI 호출을 시작한 한 번 | 형식 검사, 파일 읽기, 라우터 판단 |
| 실행 묶음(run) | P8이 유효 큐를 읽고 저장소 실행 잠금을 얻은 뒤 시작한 한 번 | 2트랙, 큐 없음, 타 창이 이미 실행 중인 경우 |
| 의미 보강 작업(job) | 같은 `jobRunId`로 묶이는 하나의 입력 세대 | 같은 작업 세대를 재개한 run을 새 job으로 세지 않음 |
| 지도 항목 | 현재 projection의 유효 node 또는 edge 하나 | `degraded`로 임시 제외된 항목 |
| 자동 완료 | job의 최신 상태가 `applied` 또는 `settled`이고 확인 대기·조사·장부 손상이 없음 | `noop`, `busy`, `awaiting`, 실행 중, `terminal-missing` |
| 확인 필요 | job의 최신 상태가 `awaiting`, `parked`, `provider-failed`, `error`, `interrupted` | 정상 no-op |

`terminal-missing`은 자동 완료나 확인 필요로 추정하지 않는 자료 한계다. 사용자 표면에서는 “종료 기록 없음”으로
표시하고 별도 coverage에 센다.

`jobKey`는 `mapId+authorityHash[+decisionContextHash]` 계보를 가리키며, 소스가 바뀌어도 같을 수 있다.
`jobRunId=sha1(jobKey+"|"+startedAt)`가 현재 P8이 이미 쓰는 불변 입력 세대다. 같은 `jobRunId`를 여러 run이
재개하면 job 하나이고, 같은 `jobKey`라도 `jobRunId`가 다르면 별도 job이다.

`applied`는 하나 이상의 변경이 지도에 반영되고 남은 확인 대기·조사가 없는 완료, `settled`는 제안들을
검토했지만 반영할 것이 없고 남은 확인 대기·조사가 없는 완료다. `awaiting`은 일부 항목이 반영됐더라도 같은
job 세대에 확인 대기나 추가 조사가 남은 상태다. `parked`는 실패로 몰지 않는다. 문이 잠겨 배달을 현관 앞에
안전하게 둔 상태처럼, 이유를 보여주고 사용자의 재시도나 설정 변경을 기다리는 상태다.

## 4. 저장 계약 A — 외부 호출 사용량

### 4.1 파일과 보존

- 파일: `~/.codex-bridge/stats/scout-usage.jsonl`(기존 경로 유지).
- 보존: 유효 시각 기준 60일. 화면 기본 창은 최근 28일.
- append와 trim은 `scout-usage.jsonl.lock` 하나를 잡은 같은 임계구역에서 수행한다. 잠금을 못 얻거나 쓸 수
  없으면 호출 본체는 계속되고 기록 함수만 `false`를 반환한다.
- trim은 기존처럼 깨진 줄과 60일 초과 줄을 제거하되, 잠금 없이 파일 전체를 다시 쓰지 않는다.

### 4.2 새 행 `scout-usage-v2`

```json
{
  "schema": "scout-usage-v2",
  "ts": "ISO-8601",
  "callId": "UUID",
  "scope": "project",
  "repoKey": "opaque-repo-key",
  "flow": "map-scout",
  "provider": "claude",
  "model": null,
  "tokenIn": null,
  "tokenOut": null,
  "charsIn": 1234,
  "charsOut": 567,
  "runId": null,
  "jobKey": null,
  "jobRunId": null
}
```

필수 규칙:

- `schema`, `ts`, `callId`, `scope`, `flow`, `provider`는 항상 있다.
- `scope`는 `project|global`. `project`면 `repoKey`가 필수이고, `global`이면 `repoKey:null`이다.
- `repoKey`는 `resolveScoutRepo`가 고른 실제 저장소의 정규화 결과로 만든 기존 불투명 키다. 원 경로를 넣지 않는다.
- `flow`는 닫힌 열거다.
  - `map-scout`: 영향지도 생성
  - `readiness`: 연결·형식·준비 점검
  - `map-enrich`: P8 의미 보강
  - `map-adjudicate`: 의미 충돌을 검증 담당이 판정
- `provider`는 `claude|deepseek|codex`. P8의 `self|economy|precision` 내부 이름을 사용자 통계에 그대로
  노출하지 않는다.
- `callId`는 외부 호출 직전에 한 번 만들며 repair 호출은 별도 `callId`다. 같은 호출을 성공·실패 두 줄로
  나누지 않는다.
- 응답 성공 여부와 무관하게 실제 호출을 시작했으면 한 줄을 남긴다. 전송/프로세스 오류로 응답 사용량을 못
  받으면 `tokenIn/tokenOut:null`, 확인 가능한 입력 글자 수와 실제로 캡처한 출력 글자 수(없으면 0)를 남긴다.
  기록은 호출 결과를 반환하거나 오류를 다시 던지기 전 `finally` 경계에서 정확히 한 번 시도한다.
- 서비스가 실제 토큰을 주면 `tokenIn/tokenOut`에 0 이상의 유한 정수를 기록한다. 둘 중 하나라도 모르면 둘 다
  `null`로 두고 부분 토큰을 합계에 넣지 않는다.
- `charsIn/charsOut`은 알 수 있을 때만 0 이상의 유한 정수다. 토큰을 모를 때도 글자 수를 토큰으로 환산하지 않는다.
- P8 호출이면 `runId`, `jobKey`, `jobRunId`를 가능한 시점부터 함께 넘긴다. 호출 전에 job이 없을 수 있는
  준비 점검은 null이다. `jobRunId`가 있으면 `jobKey`도 반드시 있다.
- P8 실행기는 `{repoKey,runId,jobKey,jobRunId}`만 담은 사용량 문맥을 어댑터에 넘긴다. DeepSeek 자식 프로세스에는
  프롬프트나 원 경로가 아닌 이 제한된 문맥만 전용 인수/환경으로 전달한다. repair 호출은 같은 run/job 문맥을
  쓰되 새 `callId`를 받는다.
- 프롬프트/응답 원문, 소스 경로, model reasoning 원문, 오류 원문은 넣지 않는다.

행의 정확한 키 집합은 예시에 나온 15개(`schema`부터 `jobRunId`까지)다. `model`, 두 token, 두 chars,
`runId`, `jobKey`, `jobRunId`는 null을 허용하고 나머지는 필수다. token 둘은 모두 0 이상의 안전한 정수이거나
둘 다 null이어야 한다. chars는 각각 독립적으로 0 이상의 안전한 정수 또는 null이다. `callId/runId`는 UUID,
`repoKey`는 기존 16자리 소문자 hex, `jobKey/jobRunId`는 기존 40자리 소문자 hex만 허용한다. model은 null 또는
제어문자를 제거한 1~100자 문자열이다. 정확한 키 집합 밖의 필드는 writer가 저장하지 않고 parser는 새 행으로
인정하지 않는다.

### 4.3 구형 행 읽기

- `self|deepseek|codex`는 `map-scout`, `ping|capability|codex-probe`는 `readiness`,
  `enrich-self|enrich|enrich-codex`는 `map-enrich`, `enrich-adjudicate`는 `map-adjudicate`로만 해석한다.
- 구형 `workspace`가 실제 저장소와 일치하는 영향지도 행만 현재 프로젝트에 귀속한다.
- `workspace:""`인 옛 의미 보강 행은 목적은 알지만 프로젝트를 모른다. 현재 프로젝트 합계에 넣지 않고
  **이전 기록·프로젝트 미상** 건수로만 보여준다.
- 구형 `usageIn/usageOut`은 둘 다 유한 숫자일 때만 실제 토큰 합계로 승계한다.
- 미지 `arm`, 미래 시각, 손상 줄은 합계에서 제외하고 제외 건수를 coverage에 남긴다.

## 5. 저장 계약 B — 의미 보강 실행 이력

### 5.1 파일과 공통 행

- 파일: `~/.codex-bridge/stats/map-route.jsonl`(기존 경로 유지).
- 보존: 60일, 화면 기본 창 28일.
- `contract-lib`에 공용 append 관문을 두어 P8만 파일 형식을 소유하지 않게 한다. 파일별 잠금 안 append+trim,
  실패 비차단은 사용량 파일과 같다.
- 기존 P8 route 행은 그대로 읽을 수 있지만 새 성공률 분모에는 넣지 않는다. `runId`와 마지막 상태를 증명하지
  못하기 때문이다.

공통 필드:

```json
{
  "schema": "map-automation-v1",
  "event": "enrich-start",
  "ts": "ISO-8601",
  "repoKey": "opaque-repo-key",
  "runId": "UUID",
  "jobKey": null,
  "jobRunId": null,
  "mapId": "UUID",
  "mode": "self",
  "trigger": "tick"
}
```

- `repoKey`, `runId`, `event`, `mapId`, `mode`, `trigger`는 필수다. 경로와 사용자 문구는 저장하지 않는다.
- 새 형식에는 구형 route 행의 `configWs` 같은 원본 폴더 경로를 복제하지 않는다. 구형 행은 삭제하지 않고
  `legacyRows` 범위로만 남긴다.
- 언어 슬롯은 행동 분석의 분모가 아니므로 저장하지 않는다. 설정 저장 구조와 달리 지도·일지·통계는 프로젝트
  공용이라는 기존 계약을 따른다.
- `mode`는 실행 당시 선택값의 닫힌 열거 `self|economy|precision|auto`다.
- `trigger`는 `consent|retry|probe|tick|cli|link|unknown`이다. 생산값 `link:<세대>:<검증자>`는 원문을 버리고
  `link`로 정규화한다. 테스트·미지 값은 `unknown`이며 자유 문자열을 저장하지 않는다.
- `jobKey/jobRunId`는 null 또는 각각 40자리 소문자 hex다. `jobRunId`가 있으면 `jobKey`도 있어야 한다.
- terminal의 `provider`는 null 또는 사용자 표면의 `claude|deepseek|codex`다. 내부
  `self|economy|precision`은 각각 이 세 값으로 정규화한다.

### 5.2 사건 세 종류

1. `enrich-start`
   - 3트랙 확인, 유효 큐 판독, 실행 잠금 획득 뒤 정확히 한 줄.
   - 이 줄 이후 프로세스가 사라지고 마지막 줄이 없으면 중단 흔적이 된다.
   - 정확한 키 집합은 `schema,event,ts,repoKey,runId,jobKey,jobRunId,mapId,mode,trigger`다.
   - 잠금 안에서 읽은 기존 유효 job이 있으면 그 `jobKey/jobRunId`를 넣고, 새 job이 아직 계산 전이면 둘 다
     null이어도 된다.
2. `enrich-run-terminal`
   - 같은 `runId`로 정상 반환 직전에 정확히 한 줄. P8 공개 반환 하나의 실행 결과만 기록하며 job 완료율에는
     직접 쓰지 않는다.
   - 정확한 키 집합은
     `schema,event,ts,repoKey,runId,mapId,mode,trigger,outcome,reasonCode,provider` 11개다.
   - `outcome`은 `applied|settled|parked|noop|provider-failed|busy|error` 닫힌 열거다.
   - 한 run에서 여러 provider가 서로 다른 job 세대에 쓰였거나 대표 provider를 하나로 정할 수 없으면
     `provider:null`이다.
3. `enrich-job-terminal`
   - run이 실제로 읽어 재시도·적용·폐기·실패·park한 각 `jobRunId`마다 0~1줄을, run terminal보다 먼저 쓴다.
     한 번의 deferred retry가 A와 B 두 세대를 처리하면 같은 `runId`로 job terminal 두 줄과 run terminal 한 줄이
     남는다. 집계 수를 한 세대에 합치거나 `jobRunId:null`로 낮추지 않는다.
   - 정확한 키 집합은
     `schema,event,ts,repoKey,runId,jobKey,jobRunId,mapId,mode,trigger,outcome,reasonCode,provider,baselineState,everApplied,unresolvedBaseItems,activeDeferredItems,deferredState`
     18개다. `jobKey/jobRunId`는 이 사건에서 null일 수 없다.
   - `outcome`은 run terminal과 같은 닫힌 열거다. P8의 공개 반환값을 바꾸지 않고, 해당 job 세대에 한정한 현재
     요약을 내부 관찰값으로 만든다.
   - `baselineState`는 `current-job|prior-terminal|unavailable`이다. 현재 단일 job 파일이 같은 `jobRunId`면
     `current-job`, 아래 규칙의 이전 유효 job terminal에서 두 기초값을 승계했으면 `prior-terminal`, 둘 다 못 하면
     `unavailable`이다.
   - `everApplied`는 이 job 세대에서 지도 반영이 한 번이라도 끝났는지를 나타내는 단조 boolean이다. false에서
     true로만 바뀌며 다시 false가 되지 않는다.
   - `unresolvedBaseItems`는 verifier deferred record와 무관하게 근거 조사로 남은 항목 수다. 0 이상의 안전한
     정수이며 오래된 job을 재시도해도 그대로 승계한다.
   - `activeDeferredItems`는 현재 같은 `jobRunId`의 `waiting|calling|answered|uncertain` record를
     `(attemptId,itemIndex)`별 최신 한 건으로 접은 수다. 0 이상의 안전한 정수다.
   - `deferredState`는 `clear|pending|damaged|unknown`이다. 같은 `jobRunId`의 확인 대기 장부를 정상 판독했고
     `unresolvedBaseItems+activeDeferredItems`가 0이면 `clear`, 하나라도 남으면 `pending`, 장부가 손상됐으면
     `damaged`, 필요한 기초나 판독을 얻지 못했으면 `unknown`이다.

영향받은 job은 “실행 끝에 현재 job 파일 하나”로 추측하지 않는다. 일반 P8 경로는 진입·생성·재개한 job 세대,
deferred 경로는 이번 run에서 실제 선택해 call/answered/apply/reject/stale 종결을 시도한 record의 `jobRunId` 집합을
내부 결과로 모은다. 같은 세대를 여러 record가 가리키면 마지막에 한 번만 요약한다. 단순히 목록에서 보았지만
발동 조건이 맞지 않아 건너뛴 세대는 영향받은 job이 아니다. 이 내부 집합과 세대별 요약을 추가해도 P8 공개 반환과
P9 정책·처리 순서는 바뀌지 않는다.

오래된 job 세대의 상태는 다음 한 경로로만 복원한다. 항목별 누적 수량은 P10 완료율에 필요하지 않으므로 만들지
않는다.

1. `current-job`의 `everApplied`는 모든 attempt의 cursor 적용 도장 중 하나라도 있거나, 같은 `jobRunId`의
   deferred terminalOutcome에 `applied`가 하나라도 있으면 true다. 앞 attempt가 일부 적용 뒤 실패하고 다음
   provider attempt가 성공해도 true가 보존된다. 동일 의미 제안의 중복 개수를 셀 필요가 없는 boolean이라 attempt
   간 항목 동일성 결정을 새로 만들지 않는다.
2. `current-job`의 `unresolvedBaseItems`는 results를 가진 가장 뒤 attempt 하나를 현재 유효 제안 세트로 삼아
   계산한다. 그 attempt의 항목을 `(attemptId,itemIndex)`로 세고, cursor 적용 완료, 저장된 reject resolution,
   같은 키의 deferred record에 속하는 항목을 제외한 나머지가 조사 항목이다. 앞선 실패 attempt의 미처리 항목은
   후속 provider가 대체했으므로 조사 수에 다시 넣지 않되, 앞 attempt의 실제 적용 여부는 1번 boolean에 남는다.
3. 현재 job 파일이 다른 세대라면 `map-route.jsonl`에서 같은 `repoKey+jobRunId+jobKey`의 마지막 유효
   `enrich-job-terminal`을 append 순서로 찾아 `everApplied`와 `unresolvedBaseItems`를 승계한다.
4. 현재 deferred 장부의 같은 `jobRunId` record 전체를 `(attemptId,itemIndex)`별 최신 상태 하나로 접는다.
   `everApplied = 이전 everApplied OR 현재 terminalOutcome applied 존재`로만 갱신한다. active 수는 현재 활성
   record 수를 매번 다시 세므로 같은 retry를 재개·재판독해도 중복 증가하지 않는다. reject 수는 완료율에 필요
   없으므로 별도 누적하지 않는다.
5. `unresolvedBaseItems+activeDeferredItems`가 1 이상이면 `pending`, 0이면 `clear`다. clear일 때
   `everApplied=true`면 job 결과 `applied`, false면 `settled`로 유도한다.
6. 기준 terminal이 없거나 파일 판독·validator가 실패하면 `baselineState=unavailable`, 세 상태값
   `everApplied/unresolvedBaseItems/activeDeferredItems`는 null, `deferredState=unknown`으로 쓴다. 일부 deferred
   자료만으로 완료를 추측하지 않는다.
7. deferred 정본이 손상됐으면 정상 기준선 존재 여부와 무관하게 `activeDeferredItems=null`,
   `deferredState=damaged`다. `everApplied/unresolvedBaseItems`는 기준선이 유효하면 기존 형식대로 보존하고,
   unavailable이면 null이다. damaged는 집계에서 항상 `error`이므로 완료로 쓰이지 않는다.
8. deferred terminal record가 60일 뒤 개별 trim돼도 직전 job terminal의 `everApplied=true`는 단조 승계되어
   과거 적용 사실이 사라지지 않는다. active record는 정본에서 직접 다시 세며, 60일 job terminal 기준선까지
   사라졌다면 `unavailable`로 낮춘다.
9. A/B 여러 세대를 한 retry가 처리해도 위 계산을 `jobRunId`별로 독립 수행한다. 통계 기준선은 표시 정확성에만
   쓰며 P8 적용·재시도 여부를 결정하는 입력이 아니다.

`reasonCode`는 아래 닫힌 열거만 저장한다. 왼쪽은 저장값이고 오른쪽은 현재 P8 반환/로그의 정규화 대상이다.

| 저장값 | 현재 사유의 정규화 |
|---|---|
| `none` | 정상 `applied|settled`이며 별도 사유 없음 |
| `queue-damaged` | 유효 큐 판독 뒤 발견한 큐 이상(현재는 start 전이라 새 행 0, 향후 경계 이동 방지용) |
| `pipeline-blocked` | `pipeline-wal` |
| `map-unavailable` | `map-lock`, `topology-*` |
| `queue-stale` | `queue-stale` |
| `deferred-damaged` | `deferred-damaged`, `deferred-result`, 확인 대기 장부 판독 오류 |
| `deferred-retry` | `deferred-retry`, `legacy-deferred-retry` |
| `job-damaged` | `job-damaged*`, `attempt-state` |
| `policy-unavailable` | `decision-index`, `policy-frontier` |
| `parked-existing` | 기존 parked job을 명시 재시도 없이 다시 만남 |
| `consent-missing` | `consent-damaged`, `no-consent` |
| `consent-stale` | `consent-stale` |
| `mode-invalid` | `invalid-mode` |
| `already-enriched` | `already-enriched` |
| `state-write-failed` | `job-write:*`, `attempt-write:*`, `results-write:*`, `cursor-write:*`, `done-write:*` |
| `route-parked` | 라우터가 고정 정책표에 따라 `park`를 선택, `adjudicate-unreachable`, `route-loop-guard` |
| `adapter-missing` | `adapter-missing:*` |
| `provider-call-failed` | CLI/API 호출 예외·비정상 종료·빈 응답 |
| `provider-result-invalid` | provider 응답의 schema/evidence 검증 실패 |
| `lock-lost` | `run-lock-lost` |
| `retry-exhausted` | `retry-exhausted`, `rev-exhausted` |
| `resolution-pending` | `no-verifier`, `inconclusive`, `uncertain-call`, `resolution-out-of-scope` |
| `apply-failed` | `expire-*`, `apply-*`, 그 밖의 고정 적용 실패 |
| `unknown` | 위 표에 없는 값. 원문은 저장하지 않음 |

writer는 각 사건의 정확 키 집합, null 규칙, 열거, ID, 수치를 모두 확인한 뒤 한 줄을 쓴다. parser도 같은 검사를
하며, run/job terminal의 `provider` 또는 job terminal의
`jobRunId/baselineState/everApplied/unresolvedBaseItems/activeDeferredItems/deferredState`가 규칙을 어기면 구형
행으로 낮추지 않고 손상·미지 제외로 센다. null 행렬은 다음과 같다.

- `current-job|prior-terminal`: `everApplied`는 boolean, `unresolvedBaseItems`는 정수다.
- `unavailable`: 두 값은 null이고 `deferredState`는 `unknown|damaged`다.
- `clear|pending`: 유효 기준선이 필요하고 `activeDeferredItems`는 정수다.
- `damaged|unknown`: `activeDeferredItems`는 null이다. damaged에서는 유효 기준선의 앞 두 값은 보존할 수 있다.

P8의 공개 반환값은 바꾸지 않고 writer에 넘길 내부 요약만 이 표로 정규화한다.

2트랙, 큐 없음, 실행 잠금 선점 실패는 `enrich-start` 전 사건이므로 새 행이 0이다. 잠금 획득 뒤 소유권 상실은
이미 시작한 실행의 `busy` 마지막 상태로 남긴다. 기존 실행 잠금 토큰에는 선택 필드 `runId`를 추가한다. 옛
`{pid,token}`도 계속 유효하고, 새 실행만 `{pid,token,runId}`를 쓴다. 이는 잠금 획득·회수 판정을 바꾸지 않고
화면이 “아직 실행 중”인지 확인하는 관찰 표지만 제공한다.

### 5.3 중단과 중복 접기

- 파일의 유효 행에 0부터 증가하는 append 순번을 붙인다. `ts`는 28일 창과 미래 시각 제외에만 쓰고, 최신 활동은
  시계 역행에 영향받지 않도록 append 순번으로 정한다.
- 같은 `runId`의 start가 여러 개면 최초 한 줄만, run terminal이 여러 개면 append 순서상 마지막 유효 한 줄만
  쓴다. 같은 `(runId,jobRunId)`의 job terminal이 여러 개면 마지막 유효 한 줄만 쓴다.
- 관찰된 run 수는 세 사건 중 하나라도 있는 고유 `runId`의 합집합이다. run terminal만 남은 run도 실제 종결
  증거로 집계하되 `start 누락` coverage에 따로 보인다. job terminal은 있지만 run terminal이 없으면 job 결과는
  보존한다.
- run terminal이 없는 모든 run은 start 유무와 관계없이 현재 같은 저장소 실행 잠금의 `runId`와 소유자
  판정을 결합한다. 같은 `runId`의 `alive`는 `running`, 같은 `runId`의 `ESRCH` 확정 사망만 `interrupted`다.
  `owner-unverified`·잠금 손상·판독 불가는 `state-unknown`이다. 잠금 부재·다른 `runId`는 정상 종료 뒤 마지막
  통계 기록만 빠진 경우와 실제 중단을 구별할 수 없으므로 `terminal-missing`(사용자 표면: “종료 기록 없음”)이다.
  start가 없으면 같은 상태를 쓰되 `start 누락` coverage에도 센다. 고정 시간으로 생사를 추측하지 않는다.
- job 활동 후보는 모든 유효 job terminal과, run terminal도 job terminal도 없이 끝난 start의 유효
  `jobRunId/jobKey`다. start는 그 세대의 `running|interrupted|state-unknown|terminal-missing` 후보이고 job
  terminal은 기록된 세대의 종결 후보다. 한 run의 start가 A를 가리켜도 그 run이 A와 B job terminal을 함께
  남기는 것은 충돌이 아니라 정상 deferred 다중 종결이다.
- 같은 `jobRunId`가 서로 다른 유효 `jobKey`와 결속되면 그 세대의 job 통계를 제외하고 `job identity 충돌`
  coverage로 센다.
- job 통계는 `jobRunId`별로 모든 활동을 모으고 append 순번이 가장 뒤인 활동 하나를 최신 상태로 쓴다.
  같은 `jobRunId`의 여러 run은 재개이고, 같은 `jobKey`라도 다른 `jobRunId`면 별도 job이다. 과거 실패 terminal
  뒤에 살아 있는 재개 start가 오면 최신 상태는 `running`이며 완료율 분모에서 빠진다.
- job terminal 상태는 먼저 `deferredState`를 본다. `damaged`는 `error`, `pending`은 `awaiting`, `unknown`은
  `state-unknown`이다. `clear`일 때만 `applied|settled`을 자동 완료로 인정한다. `noop+deferred-retry+clear`는
  `everApplied=true`면 `applied`, 아니면 `settled`로 유도한다. 그 밖의 terminal은 raw outcome을 따른다.
- `jobRunId:null` start와 identity 충돌 세대는 run 통계에는 포함하지만 job 완료율 분모에서는 제외하고
  coverage에 남긴다.
- 구형 route 행과 `jobRunId` 없는 초기 `map-automation-v1` job 활동 행은 경로별 횟수 참고치나 새 성공률에 섞지 않고
  각각 `legacyRows`, `jobGenerationUnknown`으로만 보여준다.

## 6. 현재 Project MAP 건강도

건강도는 28일 이력과 섞지 않고 **화면을 연 현재 시점 스냅샷**으로 표시한다.

1. 3트랙일 때만 `readMapProjection(actualRepo)`를 호출한다.
2. `source=v2`가 아니면 비율을 만들지 않고 다음 상태만 표시한다.
   - `none|legacy`: 아직 Project MAP 기준으로 전환되지 않음
   - `blocked`: 읽을 수 없어 확인 필요(구조화 reasonKey)
   - `error`: 잠금 경합/세대 변동으로 이번 판독 불가
3. `source=v2`면 `deriveFreshness` 한 번으로 유효 node+edge를 집계한다.
   - 유효 항목 분모 = `nodes.length + edges.length`
   - 최신 = `fresh`, 갱신 필요 = `stale`, 확인 불가 = `unknown`
   - 임시 제외 = `degraded.length`이며 유효 항목 분모에 넣지 않고 별도 표시한다.
4. 유효 항목이 5개 미만이면 비율을 숨기고 건수만 보여준다. 5개 이상이면 각 비율 옆에 `n/분모`도 병기한다.
5. `stale`은 “틀림”이 아니라 근거 파일이 바뀌었다는 뜻이고, `unknown`은 근거가 부족하거나 읽지 못했다는 뜻이다.
6. 이 판독은 새로운 LLM 호출을 하지 않는다. 공용 reader가 기존처럼 비권위 캐시를 갱신하는 것 외에 P10 전용
   기록을 만들지 않는다.

기존 관찰 일지의 `computeScoutHealth`는 정찰 제안이 재사용·확인·반박된 신호다. P10 스냅샷은 구조 지도 항목의
현재 근거 상태다. “가게 이용 후기”와 “오늘 냉장고 온도”처럼 목적이 다르므로 합산하거나 하나의 건강 점수로
만들지 않는다.

## 7. 최근 28일 집계 계약

### 7.1 의미 보강 실행

`map-automation-v1` 행을 현재 `repoKey`와 28일 창으로 필터한 뒤 다음을 표시한다.

- 관찰된 run / start-run terminal 정상 쌍 / start 누락 run terminal / 진행 중 / 중단 흔적 / 종료 기록 없음 /
  상태 판정 불가.
- 고유 job 수.
- job 최신 상태별 `applied`, `settled`, `awaiting`, `parked`, `provider-failed`, `error`, `interrupted`,
  `running`, `state-unknown`, `terminal-missing`, `busy`, `noop`.
- 정상 no-op은 job 완료율에서 제외하고 `이미 최신`, `큐 교체됨` 등 사유별 별도 건수로 표시한다.
- 자동 완료 비율 = `(applied job + settled job) / (applied + settled + awaiting + parked + provider-failed + error +
  interrupted)`.
- 분모 5 미만이면 비율을 숨긴다. `busy`, `running`, `state-unknown`, `terminal-missing`, 정상 `noop`,
  `jobRunId:null`은 이 분모에서 제외하고 coverage에 표시한다. `terminal-missing`은 실제 중단의 증거가 아니라
  마지막 통계 기록의 부재이므로 자료 한계를 함께 고지한다.
- “자동 완료 비율”은 지도 정확도나 수정 항목 성공률이 아니라, 시작한 고유 작업 묶음이 사람 확인 없이
  종결됐는지를 나타낸다고 화면에 명시한다.

### 7.2 외부 호출과 사용량

`scout-usage-v2`를 `flow × provider`로 나누어 다음을 표시한다.

- 호출 수.
- 실제 토큰을 준 호출 수/전체 호출 수(coverage).
- 실제 토큰 합계. coverage가 100%가 아니면 “확인 가능한 호출만의 합”이라고 표시한다.
- 토큰 미제공 호출의 입력·출력 글자 수 합계.
- `map-scout`, `readiness`, `map-enrich`, `map-adjudicate`는 서로 다른 행/구획이다.
- `scope=global` 준비 점검은 현재 프로젝트 비용에 합치지 않고 **전역 준비 점검** 행에만 표시한다.
- 모델 이름은 행 세부 펼침에서만 보여주며, 모델 간 품질·비용 비교는 하지 않는다.

### 7.3 기록 coverage

화면 아래에 다음을 작은 글씨로 항상 표시한다.

- 유효 새 사용량 행 수 / 구형 귀속 가능 / 구형 프로젝트 미상 / 손상·미지 제외.
- 유효 start-run terminal 쌍 / start 누락 / 유효 job terminal / job 기준선 없음 / `jobRunId` 없는 start /
  job identity 충돌 / 실행 상태 확인 불가 / 구형 route 행 / 손상·미지 제외.
- “이 수치는 로컬에서 기록에 성공한 사건만 보여주며 서비스 청구서와 다를 수 있음.”

## 8. P9 현재 상태의 표시 경계

P9 자동 이어가기는 같은 대기 항목을 여러 번 안전하게 재시도할 수 있어, 현재 원장만으로 28일 성공률을 만들면
중복 분모가 된다. P10 v1은 새 P9 이력 로그를 만들지 않는다. 대신 기존 `intentView`에서 현재 필요한 행동만
Project MAP 운영 현황 하단에 별도 표시한다.

P10 상태 수집기는 이미 만들어진 `intentView`를 받아 표시만 한다. 통계를 열었다는 이유로 P9 sweep이나 재시도를
새로 호출하지 않는다.

- 사용자 선택 대기 카드 수.
- 명시 재시도 대기 수.
- 손상 복구 필요 여부.
- 조사 정보 행 수.

모두 현재 스냅샷이며 P8 자동 완료 비율의 분자·분모에 넣지 않는다. 추후 실제 사용에서 이력 질문이 생기면
별도 설계로 올리며, P10 v1의 “기록 최소화” 원칙 때문에 미리 사람의 선택 이력을 복제하지 않는다.

## 9. 화면 계약

위치: **검증 통계** 탭. 기존 검증 결과·토큰·프로필 카드 아래, 기존 3트랙 관찰 신호/비용 영역과 같은 묶음.

### 9.1 2트랙

- Project MAP 운영 현황과 목적별 정찰/MAP 비용 카드는 DOM에서 숨김.
- 상태 수집도 `scoutMode !== on`이면 순수 빈값을 반환하고 `map-route`, `scout-usage`, Project MAP reader를
  호출하지 않는다.
- 기존 검증 통계, 검증 토큰, 구현 작업 토큰, 프로젝트별 검증 비교는 그대로 표시한다.

### 9.2 3트랙 카드 순서

1. **현재 지도 상태** — 읽기 상태, 최신/갱신 필요/확인 불가, 임시 제외.
2. **최근 자동 의미 보강** — 고유 작업 묶음의 최신 종결 상태와 분모가 드러난 자동 완료 비율.
3. **현재 선택·복구 대기** — P9 현재 스냅샷(이력률 아님).
4. **목적별 외부 호출·사용량** — 영향지도/준비 점검/의미 보강/검증 담당 판정 분리.
5. **자료 범위와 한계** — 28일 화면·60일 보존·coverage·청구서 아님.

### 9.3 표현 원칙

- 사용자 표면에서 `arm`, `route`, `jobKey`, `repoKey`, `WAL`, `CAS`를 쓰지 않는다.
- 예: `applied=3, settled=2, parked=1` 대신 “지도에 반영하고 끝남 3 · 바꿀 것 없이 끝남 2 · 확인 대기 1”.
- `stale`은 “근거 파일이 바뀌어 갱신 필요”, `unknown`은 “현재 확인할 자료 부족”, `degraded`는
  “검증 근거가 맞지 않아 임시 제외”로 쓴다.
- 한/영 문구는 같은 수치·같은 분모·같은 한계를 전달한다.
- 빨강/노랑 무결성 경보를 새로 만들지 않는다. P10은 통계 탭의 관찰 표면이며 기존 복구 카드가 행동을 맡는다.

## 10. 프로젝트·폴더·언어 귀속

1. 화면의 VS Code 폴더가 아니라 `scoutTargetFor(ws).repo`/`resolveScoutRepo`가 정한 실제 저장소를 기준으로 한다.
2. 새 기록은 원 경로 대신 기존 `repoKeyFor(actualRepo)`를 사용한다.
3. 하위 폴더에서 실행해도 같은 저장소 루트로 정규화되면 같은 통계다.
4. 서로 다른 저장소는 같은 상위 폴더 아래 있어도 합치지 않는다.
5. 한글/영어 슬롯 전환은 같은 원장을 읽는다. `slot`별 합계나 중복 기록은 만들지 않는다.
6. 구형 raw workspace 기록은 정확히 일치한다고 증명할 수 있을 때만 호환 집계한다. basename 유사성이나 현재
   활성 프로젝트라는 이유로 추측 귀속하지 않는다.

## 11. 개인정보·보안·무결성

- 새 행 허용값은 닫힌 열거와 수치·불투명 ID뿐이다.
- 원 경로, 파일명, 사용자 발화, 정책 문구, 프롬프트, 답변, 오류 전문은 저장 금지다.
- 모델 이름은 로컬 표시용 비밀 아닌 설정값이지만 길이 상한 100자와 제어문자 제거를 적용한다.
- `callId/runId`는 UUID, `repoKey`는 기존 16자리 소문자 hex, `jobKey/jobRunId`는 기존 40자리 소문자 hex,
  `mapId`는 UUID validator를 통과한 값만 기록한다.
- JSONL 파서는 객체·스키마·필드 형식·열거·유한 수·ISO 시각을 엄격히 확인한다. 미지 행은 조용히 기존 항목으로
  해석하지 않고 coverage의 제외 수로만 센다.
- 미래 시각은 28일 합계에서 제외한다. trim 과정에서 미래 시각을 오래된 것으로 삭제하지 않는다.
- 통계 잠금은 데이터 유실 방지용이며, 실패해도 제품 동작을 막는 보안 게이트가 아니다.
- 통계 파일은 로컬에만 있고 저장소 공유 파일(`project-map/**`)에 복제하지 않는다.

## 12. 구현 증분

### 증분 1 — 기록 계약과 순수 집계기

- `contract-lib`: 두 통계 파일의 잠금 append/trim, `scout-usage-v2`, `map-automation-v1` writer/validator.
- 영향지도·준비 점검·P8 provider·검증 담당 판정의 호출 직전/직후 배선. 실제 저장소 `repoKey` 전달.
- P8 run wrapper가 start/run-terminal을 정확히 한 쌍으로 기록하고, 영향받은 각 job 세대의 job-terminal을
  0~1줄 기록한다. 2트랙·큐 없음·선점 실패는 0행이다. 새 실행 잠금에 같은 `runId`를 선택 필드로 넣어 고정
  시간 없이 생존 상태를 판독한다.
- `src/map-stats.ts`: 구형 호환, 엄격 파서, run/job fold, 비용 분리, coverage를 순수 함수로 구현.
- 실행 반례: DeepSeek repair 2호출=서로 다른 call 2건+같은 `jobRunId`, 실제 CLI/API 시작 뒤 실패·throw·usage
  미제공도 call 1건, 실제 호출 전 available/probe 중단은 0건, 부분 token은 둘 다 null, 같은 `jobRunId` 재개는
  job 1건, 같은 `jobKey`라도 다른 `startedAt/jobRunId`면 job 2건, 구형 `jobRunId` 부재 격리, 과거 실패 뒤
  살아 있는 재개 start, 죽은 소유자, owner-unverified, 잠금 손상·판독 불가, applied+확인 대기와
  inconclusive-only는 `awaiting`, 지연 support/reject 뒤 clear 종결, deferred 손상은 error, 구형 프로젝트 미상
  격리, 서로 다른 두 `jobRunId`의 대기를 retry 한 번으로 처리하면 job terminal 2건·각 세대 독립 상태,
  A의 기존 적용 여부·조사 수가 B로 교체된 뒤에도 보존, 같은 retry 재판독 시 중복 증가 0, 기준선
  없음·손상은 state-unknown, 앞 attempt 부분 적용 뒤 실패·다음 attempt 성공에도 everApplied 보존,
  current/prior 기준선+damaged/unknown null 행렬, D1 terminal 60일 만료+D2 active에도 prior everApplied 보존,
  동시 append+trim 무유실, writer 실패가 provider/P8 반환값을 바꾸지 않음.

### 증분 2 — 현재 건강도와 상태 수집

- 3트랙에서만 actual repo projection+freshness 한 번 판독.
- 유효 항목/임시 제외 분리, 표본 5 미만 비율 숨김, blocked/error의 reasonKey 소비.
- P9 `intentView` 현재 스냅샷 수치만 결합.
- 실행 반례: node/edge 분모, degraded 분모 제외, stale/unknown 문구, reader 실패 무사망, 2트랙 reader 호출 0,
  작업 폴더와 actual repo가 다른 경우 actual repo만 집계, 통계 화면 수집만으로 P9 sweep·재시도를 추가 호출하지
  않음.

### 증분 3 — 대시보드·문서·마감

- 검증 통계 탭 카드와 ko/en 표현, 목적별 비용 행, coverage/한계.
- 기존 관찰 신호·검증 통계·작업 토큰 무회귀.
- PRIVACY/README ko/en/HANDOFF 갱신.
- 전체 테스트→독립 Codex 검증→지적 재판단→필요 수정·재검증→`node install.js`→로컬 커밋.
- 버전 bump·push 금지.

증분마다 이전 증분의 정본 테스트를 포함해 전체 체인을 통과해야 한다. 한 증분에서 새 지표 의미를 결정하지
않는다. 이 문서의 분모나 기록 필드를 바꿔야 하면 구현 편의 수정이 아니라 설계 재검증 대상이다.

## 13. 인수 테스트 목록

1. 2트랙에서 새 통계 파일이 없을 때 실행 전후 디렉터리 목록과 파일 mtime이 같다.
2. 2트랙에서 기존 통계 파일이 있어도 P10 판독 함수와 Project MAP reader 호출 횟수가 0이다.
3. 실제 저장소 A를 작업 폴더 B에서 추적해도 A의 `repoKey`에만 기록되고 B·다른 저장소 통계에 안 보인다.
4. 한/영 전환 전후 수치 JSON이 바이트 동등하고 표시 문구만 바뀐다.
5. DeepSeek repair 1회는 서로 다른 `callId`의 실제 API 호출 2건으로 보이고 두 행의
   `runId/jobKey/jobRunId`는 같으며, 의미 보강 job은 하나다.
6. 실제 Claude/Codex CLI가 시작된 뒤 비정상 종료·빈 출력이 나면 token null인 호출 한 줄이 남고, Codex/Claude
   정상 호출도 글자 수만 표시되어 토큰 합계 0으로 위장하지 않는다.
7. DeepSeek API가 throw하거나 usage 없는 응답을 내도 호출 한 줄이 남고, token 한쪽만 온 응답은 둘 다 null이다.
8. provider 없음·키 없음·사전 형식 검사처럼 실제 CLI/API 호출 전에 끝나면 호출 행은 0이다.
9. 구형 `workspace:""` 의미 보강 비용은 현재 프로젝트 합계에 들어가지 않는다.
10. 같은 `jobRunId`의 실패→재개→완료는 run 여러 건, job 하나, 최신 상태 완료 하나다.
11. 같은 `jobKey`라도 `startedAt/jobRunId`가 다른 두 입력 세대는 job 둘이며 서로의 terminal을 섞지 않는다.
12. start 뒤 정상 run terminal, 살아 있는 같은 `runId` 잠금과 짝인 start, ESRCH 사망인 같은 `runId` 잠금과
    짝인 start, owner-unverified, 잠금 손상·판독 불가, 잠금 부재·다른 `runId`, run-terminal-only, 중복
    run/job terminal, `jobRunId:null`, 동일 jobRunId-jobKey identity 충돌을 각각 정해진 상태/coverage로 접는다.
    잠금 부재·다른 `runId`는 `interrupted`가 아니라 `terminal-missing`이다.
13. 과거 provider 실패 terminal 뒤 같은 `jobRunId`의 살아 있는 재개 start가 오면 최신 job은 `running`이고
    실패 분모에서 빠진다.
14. 적용 1+확인 대기 1인 `applied` terminal과 inconclusive-only `settled` terminal은 둘 다 `awaiting`이며,
    지연 support/reject 재개 뒤 장부가 clear가 되면 각각 `applied|settled`로 종결된다. 장부 손상은 `error`다.
15. 서로 다른 두 `jobRunId`의 deferred가 동시에 대기할 때 retry 한 번으로 두 세대를 종결해도 같은 run의
    job terminal 두 줄이 생기고, 두 job의 최신 상태 근거는 서로 섞이지 않는다. A에 독립 적용 1·조사 1·대기
    1을 만든 뒤 B가 현재 job 파일을 교체한 반례에서도 A의 `everApplied=true`, 조사 수 1이 보존되고, 같은
    결과를 재판독해도 active 수가 중복 증가하지 않는다. A의 이전 terminal이 없거나 손상되면 A는
    `state-unknown`이다. 같은 묶음에서 다음 세 반례도 실행한다.
    - attempt 0이 항목 하나를 실제 적용한 뒤 실패하고 attempt 1이 완료해도 `everApplied=true`다.
    - `current-job|prior-terminal` 기준선과 `damaged|unknown` 조합은 기초값을 보존하고 active만 null이며,
      `unavailable`은 세 상태값이 모두 null이다.
    - D1 applied terminal record가 60일 trim되고 같은 A의 D2 active가 남아 재시도돼도 prior terminal의
      `everApplied=true`가 false로 내려가지 않는다.
16. 4개 표본에서는 비율이 없고 5개부터 `분자/분모`와 함께 비율이 보인다.
17. `noop/busy/running/state-unknown/terminal-missing`은 자동 완료율 분모에서 빠지고 `awaiting`은 확인 필요
    분모에 들어간다.
18. projection의 node 2+edge 1+degraded 1이면 freshness 분모 3, 임시 제외 1이다.
19. blocked/error/legacy/none 상태에서는 stale 비율을 만들지 않는다.
20. 손상·미지·미래 JSONL 줄은 합계를 오염시키지 않고 coverage에 반영된다.
21. 두 프로세스가 동시에 append하고 한쪽이 trim해도 고유 `callId/runId` 유실이 없다.
22. 통계 writer 실패를 주입해도 영향지도 provider/P8 반환값과 P9 후행 스윕 결과가 바뀌지 않는다.
23. 통계 화면 상태 수집만으로 P9 sweep·재시도를 추가 호출하지 않는다.
24. 새 파일·필드·보존 기간이 PRIVACY 한/영 사용자 안내와 일치한다.
25. 기존 `verify-stats`, `scout-health`, `scout-usage`, P7/P8/P9, 전체 `npm test`가 통과한다.

## 14. 처리표

| 분류 | 항목 | 근거 |
|---|---|---|
| ① 즉시 구현 | 목적별 사용량, run/job 접기, 현재 지도 스냅샷, 3트랙 UI | P10 한 줄을 거짓 없는 최소 기능으로 닫는 직접 범위 |
| ② 보관·제외 | P9 28일 성공률, 가격·환율, 모델 품질 순위 | 중복 분모 또는 외부 가격 자료가 필요하고 P10 v1 성공 조건에 직접 필요 없음 |
| ③ 계획 승격 | 없음 | 새 Phase나 스키마 전환을 요구하지 않음 |
| ④ 수용 위험 | 통계 기록 실패 시 사건 누락 가능 | 기록을 강제하면 본 작업을 막으므로 비차단 유지. 대신 coverage와 “청구서 아님”을 상시 표시 |
