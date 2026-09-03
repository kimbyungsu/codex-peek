# 구현자 규칙 준수 구조 설계 (RULE-COMPLIANCE) v5

작성 2026-09-02 · v2=설계 검증 1회차 blocker 2·보완 2 반영 · v3=2회차 blocker 3 반영(개수 동시 갱신·Codex 앵커 보존·주입 결정 기록) · v4=3회차 blocker 2 반영(종료 시점 유효 설정 재계산·기록 시점=첫 앵커 쓰기) · v5=4회차 blocker 2 반영(앵커 미상=안전 방향·epoch에 유효 지문) — 4회차 판정 뒤 수정분은 구현 캠페인 1회차에서 도장 대상 · 상태: **구현됨 2026-09-03(§7 1~5 — 사용자 승인 "권장대로 진행·체크리스트는 사용자가 켜고 끄는 형태 유지")** · 선행: HARNESS-REALIGNMENT-2026-08-29.md §7 4번 종결(개선 3 = 보고 세 칸 경비원)
사용자 지시(2026-09-02): "구현자 규칙 칸에 내가 적어 둔 것(예: 상황예시로 설명)을 구현자가 자꾸 빼먹는다 — 검증자에게 판정을
떠넘기지 말고, **구현자가 실제로 지키게 만드는 구조**를 찾아라. 하네스는 그 칸에 무엇이 들어갈지 모른다(불특정 다수 사용자).
세 칸 제목 상수는 하네스 고정 규약처럼 잘못된 기준점. 왕복 상한은 사용자 설정값이지 고정 5회가 아니다."

## 헌법 (이 설계의 단일 원칙)

**하네스는 사용자 규칙의 내용을 해석하지 않는다. 대신 "답을 쓰는 순간에 규칙을 다시 읽고, 규칙마다 자기 답을 대조해 적는 일"을
건너뛸 수 없게 만든다.** 준수 판정은 구현자의 책임이고, 그 자가 대조는 장부에 남아 사용자가 본다. 검증자는 이 일에 관여하지 않는다.

상황으로 말하면 — 학생에게 "답안 끝에 선생님이 준 주의사항 하나하나에 대해 '지켰다/못 지켰다+어디서'를 적어라"고 하고, 그 줄이
없으면 답안을 받지 않는 것이다. 채점자(검증자)에게 주의사항을 넘겨 감점하게 하는 게 아니다. 주의사항이 시험 도중 바뀌었으면 새 종이를
다시 주고 그 종이 기준으로 적게 한다.

## §0 문제 실측 (2026-09-02)

1. 사용자 규칙(Claude 규칙 `c.claude`·구현 Codex 규칙 `c.codexImplementer`)은 두 구현자 훅이 **매 턴 머리에** 그대로 넣는다
   (`buildInjection` — 데이터 그대로·해석 없음). 그런데도 "상황예시 누락"이 반복됐다(사용자 실보고 2026-08-30·09-02 두 차례).
2. 이미 있는 장치: 대시보드 "체크리스트 강제" 옵션(`claudeChecklist`/`codexImplementerChecklist`, 기본값 켜짐). 켜지면 주입문이
   "이번 응답에 `[계약점검]` 블록을 넣어 규칙마다 준수/위반/해당없음+한 줄 근거를 적어라"를 요구한다. **그러나 어떤 종료 훅도
   그 블록의 존재를 검사하지 않는다**(누락해도 턴이 끝남). 이 프로젝트는 두 옵션 모두 꺼져 있다.
3. 개선 3(보고 세 칸 경비원)은 `REPORT_SECTIONS` **코드 상수**(무엇이 바뀌었나/이런 상황이 이렇게 됨/다음에 할 일)의 제목 존재만
   검사한다 — 특정 사용자의 선호가 하네스 전역 양식으로 굳었고, 규칙 내용(상황예시 유무)은 어떤 장치도 보지 않는다.
4. 기각된 대안(사용자 2026-09-02): 구현자 규칙을 검증자에게 채점 기준으로 자동 동봉 — "구현자의 책임을 검증자에게 넘기는 편리한
   구조 해법이고, 검증 실패 횟수를 비약적으로 늘린다".
5. (설계 검증 1회차) 종료 훅의 반복 차단 상한(같은 상태 3회 뒤 해제 — ab-6)을 그대로 쓰면 블록을 계속 빼먹어도 네 번째엔 끝난다 →
   별도 종결 계약 필요. 규칙 개수만 대조하면 같은 개수로 바뀐 규칙을 이전 답의 점검표가 통과한다 → 규칙 목록 지문 결속 필요.

## §1 원인 분해 (왜 매 턴 주입돼도 빠지나)

- **거리**: 규칙은 턴 첫머리에 있고, 최종 답은 긴 도구 호출 뒤에 생성된다. 답을 쓰는 순간엔 규칙이 시야 밖이다.
- **대조 순간 부재**: "규칙 n을 이 답에서 어떻게 지켰나"를 적는 자리가 없다. 있어도(체크리스트 옵션) 안 적으면 아무 일도 없다.
- **잘못된 대리물**: 세 칸 제목이 규칙의 대리물이 됐다 — 제목만 채우면 통과하므로 규칙 자체는 여전히 안 읽힌다.
- 검증자 경유는 원인(구현자가 안 읽음)을 고치지 않고 결과만 뒤에서 걸러낸다 — 기각.

## §2 방향 (원칙 6)

- **P1 내용 무해석**: 하네스는 규칙 문장을 파싱·분류·판정하지 않는다. 규칙 **개수·번호·목록 지문**만 안다.
- **P2 대조 강제+재독**: 답을 끝내려면 규칙마다 `n) 준수|위반|해당없음 — 근거` 한 줄이 있어야 한다(구조만 검사). 없으면 종료 장치가
  **규칙 전문을 다시 실어** 돌려보낸다 → 답을 쓰는 순간에 규칙이 다시 시야에 들어온다.
- **P3 같은 종이 결속**: 점검표는 "주입된 그 규칙 목록"에 대한 것이어야 한다 — 주입 시점 목록 지문(순서 있는 규칙 전문의 sha1)을
  턴 앵커에 남기고, 점검 블록 머리에 그 지문 앞 8자를 적게 한다. Stop 시점 계약의 지문이 다르면(턴 중 규칙 편집) 새 규칙 전문을 실어
  차단하고 새 지문으로 다시 적게 한다.
- **P4 정직 허용**: '위반'이라고 적는 것은 허용된다(숨기기보다 낫다). 하네스는 위반을 벌하지 않고 **장부에 남긴다**.
- **P5 책임은 구현자·가시성은 사용자**: 자가 대조 행은 장부에 쌓이고 대시보드가 규칙별 준수/위반/미기재 추이를 보여 준다. 검증자는 무관.
- **P6 하네스 고유 양식 최소화**: 하네스가 강제하는 형태는 `[계약점검]` 블록 하나뿐. 보고 세 칸 상수는 폐지하고, 필요하면 사용자가
  자기 규칙 칸에 적는다(이 프로젝트는 그렇게 이전).

## §3 설계 (부품 A~F)

### A. 체크리스트 = 정본 채널 (기존 장치 승격 + 지문 1토큰)
- 주입문은 현행 `buildInjection(checklist=true)`를 쓰되 블록 머리를 `[계약점검 <지문8>]`로 요구한다(코드 소유 서식 1토큰 추가·규칙 문장 무변).
  지문 = `rulesFp = sha1(JSON.stringify(rules 배열))`(순서 포함). 주입 훅이 턴 앵커(Claude `active/<sid>.json`·Codex `codex-active/<sid>.json`)에
  **`ruleCheck` 객체 하나**로 `{mode:"required"|"disabled", rulesFp, rulesN, turnId, ts}`를 기록한다.
  - **기록 시점(3회차 blocker② 반영)**: 출력 콜백이 아니라 **주입 훅이 언제나 수행하는 첫 앵커 쓰기**에 넣는다 — Claude는 `contract-inject`가 조립 전에
    하는 `writeAnchors(activePayload)`(permissionMode·constraint 결속과 같은 자리), Codex는 UserPromptSubmit의 `heartbeat` extraFields. 따라서 출력이 없는
    턴(주입 모드 off·비-plan 턴·규칙 0개 등 "의도적 미주입")에도 `disabled`가 반드시 남는다. 출력이 실패한 `required` 턴은 규칙이 전달되지 않았어도
    `required`로 남아 Stop이 규칙 전문을 실어 되돌린다(안전 방향).
  - `mode`는 **유효 설정 함수** `effectiveRuleCheck(contract, turnKind)`의 값이다: 체크리스트 옵션 켜짐 ∧ 주입 모드(`claudeInjectMode`/`codexInjectMode`
    off|plan|always)상 이 턴 종류(turnKind=앵커 `permissionMode`가 plan인지)에 규칙이 주입됨 ∧ 규칙 ≥1 → `{mode:"required", rulesFp, rulesN}`; 그 외 →
    `{mode:"disabled", rulesFp:null, rulesN:0}`. **같은 함수를 주입 훅과 Stop 훅이 공유한다**(코드 소유·순수 함수·시험 대상).
  - **Codex 앵커 보존 계약**: `heartbeat`(PostToolUse·Stop 진입)는 같은 `turnId`의 `ruleCheck`를 directive와 같은 방식으로 보존하고, 다른 turnId(새 턴)면
    폐기한다(constraintAnchor 승계 규칙과 동형). 회귀 시험: 주입→도구 이벤트→Stop 순서에서 `ruleCheck` 생존.
- **기본값**: 켜짐(현행 `!== false`). 사용자가 끈 프로젝트는 B~D가 전부 비활성(현행 무회귀). 규칙이 0개면 검사 없음.

### B. 종료 훅의 구조 검사 (Claude `verify-guard`·구현 Codex `codex-hook` 동형)
- 대상 턴: **마지막 답(사람 발화 뒤 마지막 assistant 텍스트)이 있는 모든 턴**(사용자 규칙은 모든 응답에 적용). 도구만 있고 답이 없는 턴은
  대상 아님. 검증 모드 off라도 적용(4-1 경비원과 같은 위치·같은 예외).
- 검사(구조만·내용 무해석):
  0. **유효 설정 재계산이 먼저(3회차 blocker① 반영)**: Stop은 앵커의 `mode`를 믿고 생략하지 않는다. 현재 계약과 앵커의 `permissionMode`(턴 종류)로
     `effectiveRuleCheck`를 다시 계산해 `eff={mode,rulesFp,rulesN}`를 얻고, 앵커 `ruleCheck`(부재·손상이면 null)와 비교한다.
     - `eff.mode==="disabled"` → 검사 없음(앵커가 required였어도 — 체크리스트/주입 모드를 끄거나 규칙을 0개로 줄인 경우). 앵커가 다르면 `eff`로 원자 교체만.
     - `eff.mode==="required"` ∧ 앵커 == eff → 아래 1·2.
     - `eff.mode==="required"` ∧ 앵커 ≠ eff(부재·손상·지문/개수 변경·disabled→required 전환 = 턴 시작엔 규칙 0개였다가 도중에 추가 등) → **앵커를 `eff` 전체
       `{mode,rulesFp,rulesN}`로 한 번에 원자 교체**하고 차단문에 **새 규칙 전문**+새 지문을 실어 돌려보낸다(1회 되돌림·잠금 아님). 부재·손상도 이 경로
       (안전 방향=검사). **앵커 파일 자체가 없거나 읽히지 않는 턴(turnKind 미상 — 첫 앵커 쓰기 실패 포함)은 비-plan으로 간주하지 않는다**(4회차 blocker①:
       주입 모드 plan인 실제 plan 턴의 기록 실패를 '의도적 미주입'으로 오판). 미상이면 주입 모드가 `always`든 `plan`이든 "이 턴에 주입됐을 수 있다"로 보아
       옵션 켜짐 ∧ 규칙 ≥1이면 `required`(규칙 전문 재발급·1회 되돌림), 주입 모드 `off`일 때만 `disabled`. 비용은 기록 실패 턴의 되돌림 1회이며 검사 우회는 없다.
       주입 훅 쪽 보강: 첫 앵커 쓰기의 `atomicWrite` 결과를 확인해 실패 시 stderr 1줄(침묵 금지)을 남기되 주입은 계속한다(Stop의 안전 방향이 뒷받침).
  1. 마지막 답에 `[계약점검 <지문8>]` 블록이 있고, 지문8 == 앵커(=eff) `rulesFp` 앞 8자.
     - 블록 지문 ≠ 앵커 지문: "다른 규칙 목록에 대한 점검표" — 차단(규칙 전문 동봉).
  2. 블록 안에 `n) 준수|위반|해당없음 — 근거`(영문 `complies|violated|n/a`) 줄이 1..N 전부(N=eff `rulesN` — 지문과 같은 쓰기로 갱신된 값), 근거 8~200자·
     민감정보 형태 거부(user-constraint 문안 검사 함수 재사용 — ab-7). 줄 순서 무관·중복 번호=마지막 것·N을 넘는 번호 줄=무시.
- 실패 시 차단문(코드 소유·언어 2종): `[규칙 자가점검] 빠진 줄: n, m · 규칙 목록 지문 <지문8>` + **규칙 JSON 원문 그대로 동봉**
  (데이터 — 매 턴 예산 밖·§4-B ③ 사용자 글 불변). 이 재전송이 P2의 핵심이다.
- 차단 사다리 순서: 판단 관문 > 마감 턴 마감문 > **자가점검** > 잔여 마커 > 상한 안내 > 검증 요구(개선 3의 자리를 승계). **epoch에 `checkOk`와 함께
  `eff.mode|eff.rulesFp|eff.rulesN` 지문을 포함**(4회차 blocker②: 규칙이 바뀌면 epoch가 바뀌어 카운터가 리셋 → 새 규칙 세대에서 전문 재발급 1회가 보장되고,
  그 세대 안에서 다시 유계 종료). 시험: 규칙 A 누락으로 3회 차단 직후 같은 턴에 규칙 B로 교체 → B 전문 동봉 차단 1회 → B 세대 안에서 상한 종결.
- 상한 마감 턴: 마감문 7절 수락 조건의 세 칸 요구를 `[계약점검]`(규칙이 있을 때만)로 교체.

### C. 종결 계약 — 반복 누락 뒤 (ab-6와 강제의 양립)
- 기존 attempts 상한(같은 상태 3회 뒤 해제)은 유지한다(무한 차단 금지). 단 **해제로 끝나는 턴은 조용히 끝나지 않는다**:
  1. 장부(D)에 그 턴 행을 `marks: 전부 "미기재"`·`closedBy:"attempt-cap"`으로 기록(기록 실패해도 해제는 진행 — 가시성 채널).
  2. 무결성 경보 `rule-check-missed`(노랑·확인 가능·같은 사유 재발행 금지 규약 재사용) — 대시보드 배너·개요 미확인 경보 합산에 자연 편입.
  3. 다음 턴 주입의 안내 자리(매 턴 예산 안)에 1줄: "직전 턴 규칙 자가점검 미기재(상한 해제)" — 코드 소유 문장·규칙 재동봉은 없음(그 턴 머리에 이미 있음).
- 즉 "빼먹어도 끝난다"는 남지만 **표시 없이 끝나지는 않는다** — 사용자는 경보·장부로 반복을 본다(P5).

### D. 자가점검 장부 + 대시보드 (가시성 — 판정 아님)
- Stop 훅이 블록을 정상 판독하면 `rule-check/<wsKey>.jsonl`에 `{ts, host:"claude"|"codex", session, turnAnchor, rulesFp, rulesN, marks:[{n, mark, reasonFp}], closedBy:"check"|"attempt-cap"}`
  append(근거 원문 저장 안 함·지문만 — ab-7·크기). **멱등**: 같은 `(wsKey, host, session, turnAnchor, rulesFp)`는 마지막 행이 이긴다
  (latest fold — 같은 사용자 턴에서 Stop이 여러 번 돌아도 1턴=1행으로 집계). 기록 실패는 턴 종료를 막지 않는다(fail-open 명문).
- 대시보드 검증 탭 카드 "규칙 자가점검(최근 30턴·fold 기준)": 규칙 번호별 준수/위반/해당없음/미기재 개수 + 현재 규칙 문장(사용자 글 그대로) +
  지문 불일치 행(옛 규칙 목록 기준 행)은 "이전 규칙 목록" 접힘으로 분리 표시. 개요 "지금 정할 것"엔 **합산하지 않는다**(관찰 자료).

### E. 보고 세 칸 상수 폐지 (개선 3 되돌림 — 직접 참조 전수)
- 코드: `verify-cap-handoff.js` `REPORT_SECTIONS`·`reportShapeCheck`·`reportShapeInstruction`·`capHandoffInstruction`의 세 칸 안내 문장(roundNote 옆) 제거,
  `lastAssistantText`/`lastCodexAssistantText`는 B가 재사용(존치). `verify-guard.js`·`codex-hook.js`의 report 분기·`closeReport`·epoch `reportOk`·차단 사다리 두 줄을
  B의 `checkOk`로 교체. `capHandoffContext`의 roundCount/roundBudget(P10)은 무접촉.
- 시험: `tests/report-shape.test.js` → `tests/rule-check.test.js`로 재편(§7), `tests/verify-sequential.test.js`의 R3 앞붙임 7곳+마감 턴 "마지막 답" 반례 2종을
  `[계약점검]` 동형으로 교체, `tests/p9-auto-switch.test.js` A9 핀·`tests/p12-profile.test.js`·`tests/verify-guard.test.js` 관련 핀 갱신.
- 문서: HARNESS-REALIGNMENT 개선 3 구현 절·§7 4-1·쉬운 말 4번·부록에 "폐지·규칙 칸으로 이전(2026-09-xx)" 표기, DECISIONS
  `D-2026-08-30-report-three-sections`를 '폐지(사용자 규칙 칸으로 이전)' 상태로 갱신.
- 이 프로젝트 이전: 사용자가 원하면 Claude 규칙 칸에 "보고는 무엇이 바뀌었나/이런 상황이 이렇게 됨/다음에 할 일 세 칸으로"를 **직접 추가**
  (하네스는 그 문장을 모른 채 B로 강제).

### F. 구현 Codex 쪽 동형
- `codexImplementerChecklist`가 켜진 프로젝트에서 codex-hook의 주입(A)·Stop 검사(B)·종결(C)·장부(D, host:"codex") 동형. 앵커=`codex-active` —
  `heartbeat` 보존 계약(A)이 전제이며, Stop 진입 heartbeat 뒤에도 `ruleCheck`가 남아 있어야 한다(회귀 시험 필수).

## §4 하지 않는 것(명시)
- 규칙 문장 파싱·키워드 매칭·"상황예시가 있는지" 같은 내용 판정 — 어떤 형태로도 하지 않는다(경직성·오탐·해석 권한 문제).
- 검증자에게 구현자 규칙 동봉 — 사용자 기각.
- 위반 표기에 대한 자동 제재(차단·감점) — 정직 표기를 막는다.
- 규칙별 '준수 근거' 진위 확인 — 구현자의 책임이며, 장부·대시보드로 사용자가 본다.
- 매 턴 예산 변경(체크리스트 블록은 구현자 답의 일부이지 주입이 아님·C의 1줄 안내만 예산 안).

## §5 ab 경계 자기 점검
- ab-1: 장부·검사·앵커 모두 wsKey·세션 단위. ab-2: 계약 필드 추가 없음(기존 checklist 옵션 재사용·앵커 필드만 추가). ab-3: 자가점검 블록은
  검증 증명이 아니며 종료 조건의 다른 축(검증 증명·잔여·판단 관문)과 AND — 통과 위조 경로 없음(거짓 '준수' 표기는 남지만 이는 사용자가
  승인한 "내용 무해석" 구조의 한계로 명문). ab-6: 반복 차단은 기존 유계(C로 가시화). ab-7: 근거는 지문만 저장·민감정보 형태 거부.

## §6 사용자 결정 — 기본값으로 닫음(재진입 조건 명시)
| 항목 | 기본값 | 재진입 조건 |
|---|---|---|
| 체크리스트 기본 켜짐 | 켜짐(현행) | 사용자가 프로젝트별로 끄면 B~D 비활성 |
| 검사 대상 턴 | 마지막 답이 있는 모든 턴 | 비용 실보고 시 '파일 바꾼 턴'으로 축소 |
| 근거 길이 하한/상한 | 8/200자 | 실사용 오탐 시 조정 |
| 상한 해제 뒤 처리 | 장부 미기재+노랑 경보+다음 턴 1줄 | 반복 실측 시 '다음 턴 첫 답까지 유지'로 강화 재론 |
| 세 칸 상수 폐지 | 폐지 | 여러 사용자가 기본 양식을 요구하면 '기본 규칙 예시'(사용자 글로 복사되는 템플릿)로만 제공 |

## §7 순서와 시험
1. A 지문 기록(두 주입 훅·앵커 `ruleCheck{mode,rulesFp,rulesN,turnId}`)+B 검사기·차단문(규칙 JSON 동봉)·사다리·epoch — 시험: N 동적(1·3·7), 언어 2종,
   누락/부분/전부, 위반 표기 허용, 근거 하한·민감정보 거부, 도구만 턴 제외, 규칙 0개=무검사, **턴 중 규칙 편집(같은 개수·2→3·3→2·0→N·N→0) → 유효 설정 재계산·
   앵커 {mode,rulesFp,rulesN} 원자 교체·required면 새 전문 동봉 차단·disabled면 무검사**, 체크리스트/주입 모드 양방향 전환(required→disabled=무검사·
   disabled→required=재독 차단), 블록 지문 불일치 차단, **출력 없는 의도적 미주입 턴(주입 모드 off·비-plan·규칙 0개)에 `disabled`가 첫 앵커 쓰기로 남아 Stop이
   차단하지 않음**(두 훅 모두·다른 안내도 전혀 없는 턴 반례), 필드 부재=유효 설정 재계산으로 판정, Codex: 주입→PostToolUse→Stop에서 `ruleCheck` 생존·새 turnId에서 폐기.
2. C 종결 계약 — 시험: 3회 해제 뒤 장부 미기재 행·경보 1회(재발행 금지)·다음 턴 1줄.
3. D 장부 fold+대시보드 카드 — 시험: 같은 턴 반복 Stop=1행, 지문별 분리, 개요 미합산, 기록 실패 fail-open.
4. E 상수 폐지·시험 재편·문서/색인 갱신·이 프로젝트 규칙 칸 이전(사용자 승인 뒤).
5. F 구현 Codex 동형 — 시험: codex-hook 반례.
검증: 각 단계 Codex 확인 검증 + 전체 체인.

## §8 구현 기록 (2026-09-03)
- `contract-lib.js`: `normRules/rulesFpOf/effectiveRuleCheck(c, host, turnKind)/ruleCheckSame/ruleCheckRecord/ruleCheckFp8/parseRuleCheckBlock/ruleCheckReasonIssue/ruleCheckVerdict/ruleCheckInstruction`
  ·장부 `rule-check/<wsKey>.jsonl`(`appendRuleCheckRow/readRuleCheckRows`(fold)/`latestRuleCheckRow/ruleCheckSummary`)·앵커 `readClaudeAnchorFile/writeClaudeAnchorRuleCheck/writeCodexRuleCheck`.
  `buildInjection(rules, who, checklist, lang, fp8)` — 지문 머리 `[계약점검 <지문8>]`(체크리스트 옵션 켜짐일 때만·규칙 문장 무변).
- `contract-inject.js`: 첫 앵커 쓰기(`writeAnchors(activePayload)`)에 `ruleCheck{mode,rulesFp,rulesN,turnId,ts}` — 출력 없는 disabled 턴도 기록·쓰기 실패 stderr 1줄. 직전 턴 미기재(상한 해제) 1줄 안내(매 턴 예산 안).
- `codex-hook.js`: UserPromptSubmit heartbeat extraFields에 `ruleCheck`, heartbeat가 같은 turnId의 `ruleCheck` 보존(새 턴 폐기), Stop 검사 동형(turnKind=턴 상태 `permissionMode`).
- 두 종료 훅: `effectiveRuleCheck` 재계산 → 앵커 대조·`{mode,rulesFp,rulesN}` 원자 교체 → required면 `ruleCheckVerdict` → 차단문 `ruleCheckInstruction`(규칙 JSON 원문 동봉) · epoch에 `eff.mode|rulesFp|rulesN` · 상한 해제=장부 `attempt-cap`+경보 `rule-check-missed`(노랑·같은 종류 재발행 금지) · 마감 턴 수락 조건에 `checkOk`.
  앵커 파일 부재(turnKind 미상)=주입 모드 off만 disabled(안전 방향) — 앵커 없이 검사할 때는 rules-changed 되돌림 없이 블록 판정으로 직행(되돌림 반복 방지).
- 세 칸 상수 폐지: `verify-cap-handoff.js`의 `REPORT_SECTIONS/reportShapeCheck/reportShapeInstruction`·`capHandoffInstruction` 세 칸 문장 제거, 두 훅의 report 분기 제거, `tests/report-shape.test.js` → `tests/rule-check.test.js`(9묶음), verify-sequential 마감 '세 칸' 반례 2종 제거·핀 갱신, p9 A9 핀 갱신.
- 대시보드(`src/extension.ts`): 상태 `ruleCheck{host,checklist,rules,rulesFp,summary}` + 검증 탭 카드 `#ruleCheckSec`(규칙별 준수/위반/해당없음/미기재·옵션 꺼짐/규칙 없음 안내·개요 미합산). 체크리스트 토글 UI는 무변(사용자 결정).
- 이 프로젝트(D:\프로그래밍\에이전트 활용)는 체크리스트 옵션이 꺼져 있어 카드가 "옵션 꺼짐"을 보이며 검사는 돌지 않는다 — 켜는 것은 사용자 몫.
