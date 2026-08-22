# 약속 발화 포착 (Constraint Capture) — 설계 v3 (2026-08-20 · 설계검증 2차 blocker 4건 반영)

> 배경: F1/F4/F12 smoke(real-benchmark-smoke/REPORT-SMOKE.md)에서 "그 턴의 사용자 요청 그 자체인
> 사고"는 사고 시점 검증자가 결함으로 판정하지 못할 수 있고(이번 구성 3/3 미검출), 그러면 검증자
> 유래 자동 후보가 생기지 않는 경로가 실측됐다. 지켜진 약속·발화된 제약은 사건을 만들지 않으므로
> 어떤 자동 채널에도 안 잡힌다. 이 문서는 그 계기를 만드는 입구의 설계다(사용자 승인 2026-08-20).

## 0. 원칙 (사용자와 확정한 문장)

**판단은 LLM에게, 형식은 구조 채널에, 권위는 기존 계층에.**

- 검출기를 만들지 않는다. 문구 패턴 목록("이 말이 오면 제약")은 금지(전역 경직성 규칙). 구분은
  이미 대화를 이해하는 두 LLM(구현자·검증자)의 의미 이해에 맡긴다.
- 형식은 기계 서식(CLI·규격 블록 — 지적 목록·백로그 자동 등록 관용구).
- 권위는 기존 3계층: 포착물은 **사람에게 보이는 표면**(대시보드·why)에 자동으로 흐르고, **판정
  생성 입력에는 도장 후에만** 들어간다(§3 — 1차 blocker④ 반영). 자동 승격 없음.

## 1. 부품 A — 구현자 상신 명령 (발화 즉시·같은 턴)

- CLI: `node codex-bridge.js constraint add --quote "<사용자 발화 원문>" --why "<한 줄 근거>" [--scope <파일|영역>]`
- **원문 결속(1차 blocker② 반영)**: 훅(contract-inject/codex-hook)이 턴 시작 시 **사용자 프롬프트
  원문 스냅샷**을 홈에 남기고(파일: `constraint-turns/<wsKey>-<turnAnchor>.txt` — 원문 그대로·
  TTL 청소 대상) 그 sha1을 active 기록에 병기한다. CLI는 quote가 **그 스냅샷의 연속 구절**인지
  기계 대조하고, 후보 레코드에 `{provider, wsKey, sessionId, turnAnchor, sourceHash}`를 결속한다.
  스냅샷 부재·불일치=거부(구현모델 작문·기억 재구성 차단 — fail-closed).
- **turnAnchor 규칙(2차 blocker① 반영 — 두 구현자 경로 공통 정의)**: Codex 경로=훅이 이미 가진
  turnId. Claude 경로=turnId가 없으므로 `sha1(sessionId + "|" + active.ts) 앞 16자`를 canonical
  turn anchor로 발급(캠페인 앵커 sessionId+active.ts 계보와 동일 원천 — 턴마다 유일·결정적).
  훅이 스냅샷 파일명과 active 기록에 같은 anchor를 쓴다.
- **인용 형식 검증**: 빈값·12자 미만·규약 어휘(FINDINGS_MARKERS 값) 포함=거부. **200자 초과=거부**
  (1차 blocker⑥ — 수칙서 항목 200자 절삭 규칙상 애초에 승격 불가 길이·"긴 약속은 줄여서 다시
  상신하라" 안내 출력. 절단 저장은 하지 않는다 — 원문과 권위 문안의 괴리 금지).
- **민감정보 방어(1차 blocker③ 반영)**: quote에 `safeBacklogAutoTitle` 계보의 형태 방어(제어문자·
  절대경로·이메일·토큰류·인코딩 우회 거부 — contract-lib 기존 필터 재사용), scope에
  `safeBacklogAutoFile` 동형 방어. 이것은 의미 패턴 검출이 아니라 민감정보 '형태' 방어라 경직성
  금지 규칙과 무관(설계검증 1차가 이 구분을 확인).
- **candidateId(1차 blocker⑥·2차 blocker③ 반영)**: `envelopeCandidateId("user-constraint",
  wsKey + "|" + sha1(정규화 전체 원문))` — 200자 절단 정규화가 아니라 **전체 원문 지문** 결속.
  **scope는 ID에 넣지 않는다**: scope의 지위는 **출처 메타데이터 한정**(표면 표시용 — 후보
  레코드에만 저장·영수증 제외) —
  ab축 문안은 전역 목록이라 scope별 적용 의미론이 없고, ID에만 scope를 넣으면 같은 문장의 두
  scope 후보가 같은 문안으로 draft 중복 충돌한다(2차 실측 반례). 범위가 본질인 약속은 사용자
  문장 자체에 범위가 들어가게 안내한다("~에서는 …" — 인용 원문이 곧 권위 문안이므로 범위도
  문안에 실린다). scope 인자 경로 표기는 `normBacklogFile` 최소화+`safeBacklogAutoFile` 형태
  방어(canonicalization과 형태 방어는 별개 함수 — 2차 지적 반영).
- **남발 억제(1차 blocker⑦ 반영)**: ①턴당 상신 상한 2건(같은 turnAnchor 결속 카운트 — 초과=거부)
  ②`--why` 필수(비권위 — 판단 근거 한 줄) ③pending cap은 A/B 합산 기존 12 유지 ④모든 거부가
  **내구 영수증**으로 남는다(§4).
- **why의 저장·표면(2차 blocker④ 반영 — 지위 확정)**: why는 **후보 레코드에 저장**한다(개행
  금지·120자 상한·quote와 동일한 민감정보 형태 방어). 영수증에는 `whyLen`만(원문 비복사 원칙
  유지). 사람 표면=대시보드 후보 줄의 보조 줄(textContent — 2026-08-20 개편 표면의 '원문:' 줄과
  같은 방식·"근거: <why>"). 경위 색인 조회 명령(why CLI)과는 무관 — v2의 "why 조회" 표현 삭제.
- **영수증(1차 blocker②·2차 blocker① 반영)**: 성공·거부 공통 스키마로 별도 장부
  (~~`constraint-usage.jsonl`~~ → **파일 서랍 `stats/constraint-usage/` — 2026-08-23 구현검증 개정**:
  공유 jsonl은 어떤 변형(trim 재작성·회전 rename)이든 다중 창 열린 append 핸들과 경합해 성공 반환된
  영수증을 지울 수 있음이 결정적으로 실측돼(개수 기반 정리의 최신성 판정 TOCTOU 4연속 계보), 영수증
  1건=고유 이름 파일 1개(기록 경로에 삭제·정리 코드 없음)+유계는 일일 스윕 mtime 90일 TTL로 개정.
  판독은 `readConstraintUsage()` — 후속 부품 B/C 구현자는 jsonl이 아니라 이 판독기를 쓸 것):
  `{ts, provider, wsKey, outcome:
  registered|rejected, reason?, quoteFp(sha1-16), quoteLen, whyLen, sessionId, turnAnchor}` —
  **원문 비복사**(지문+길이만·ab-7 계보). provider·wsKey 포함으로 TTL 후에도 출처 프로젝트 복원.
  **scope는 영수증에서 제외**(후보 레코드에만 저장 — 표면 표시는 후보 레코드가 원천·영수증은
  지문/길이 원칙 유지 — 3차 보완 반영·§1 scope 지위 문구도 '표면 표시용(후보 레코드 경유)'로 한정).
- 착지: envelope-candidates 장부 kind `user-constraint`(status proposed·why 포함).

## 2. 부품 B — 검증자 회수 그물 (같은 턴·이중화)

- 검증 답변의 규격 블록(1차 blocker⑤ — 문법 동결):
  - 여는 줄 `[제약 후보 v1]` · 닫는 줄 `[제약 후보 끝]` — **위치는 '[지적 목록 v2]' 블록보다 앞**
    (기존 지적 파서가 지적 블록 뒤 잔여 내용을 손상으로 처리 — 실측 반례 반영).
  - 줄당 JSON `{"quote":"<원문 연속 구절>","why":"<한 줄>"}` — 최대 4행·행당 1KB. 중복 키·미지
    필드·개행 값·JSON 파싱 실패가 하나라도 있으면 **블록 전량 거부**(부분 수용 없음 — fail-closed).
    블록 부재=정상(선택 절).
- **원문 대조 권위(1차 blocker⑤ → 2차 blocker①로 교체)**: v2가 기준으로 삼은 ask의 `prompt`는
  **구현자가 작성한 검증 요청문**이지 사용자 원문이 아니다(실측: askRequest는 CLI 인자 합성문을
  그대로 저장 — 구현자 작문이 '원문' 검사를 통과하는 구멍). 따라서 부품 B도 **부품 A와 같은 훅
  원문 스냅샷을 유일 권위**로 쓴다: ask 생성 시 현재 턴의 `{provider, wsKey, sessionId,
  turnAnchor, sourceHash}`를 job에 동결 결속하고, 답 후처리는 **그 스냅샷 파일에서** quote의
  연속 구절 존재를 검사한다(스냅샷 부재·지문 불일치=블록 전량 거부). 검증 요청문·주입문은 대조
  대상이 아니다 — 계약·지도·구현자 문장의 원문 위장이 전부 차단된다.
- **부품 B는 내구 job 경로 전용(3차 blocker① 반영)**: 직접 `ask`(job 없는 즉석 실행)에는 시작
  시점 동결 carrier가 없어 완료 시점 active 재판독=다른 턴 원문 오결속 위험 — 직접 ask 답변의
  `[제약 후보 v1]` 블록은 **전량 무시**하고 영수증(outcome: rejected·reason: direct-ask)만
  남긴다. 포착 기회는 부품 A(CLI — 두 경로 공통)와 내구 job 검증(현재 기본 흐름)이 담당하므로
  지원 경로 누락이 아니라 의식적 한정이다.
- 통과 행은 부품 A와 같은 게이트(형태 방어·200자·지문 ID)로 같은 장부에 적재 — 구현자가 이미
  상신한 발화는 지문 dedupe로 자연 합류.

## 3. 부품 C — 파이프 합류·표면·권위 흐름 (1차 blocker①·④ 반영)

- **파이프 합류 명세(재사용은 '분기 확장'이 필요하다 — 1차 blocker①)**:
  1. 계산기 합류: computeEnvelopeCandidatesFor ⑤의 장부 합류 분기 kind allowlist를
     `["resolved-blocker","user-constraint"]`로 확장(동일 dedupe·live 필터).
  2. stale 생명주기(2차 blocker② 반영 — adopted 고아 봉합 포함): reconcileMemoryCandidates의
     세대 변경 정리를 kind 공통으로 확장하되, user-constraint는 원천 재스캔이 없으므로
     **carry-forward**: 구세대의 ⓐproposed와 ⓑ**adopted인데 새 Envelope에 해당 문안이 없는 것**
     (adopted-but-unstamped — draft가 도장 전에 adopted를 기록하고 singleton proposal이 덮어쓰기·
     폐기될 수 있는 기존 경로의 고아) 둘 다 새 승인 세대 행으로 **candidateId별 정확히 1회**
     재발급(proposed 상태·사유 기록) — 사용자 판단 전 소실 금지. 같은 세대 안의 고아 복원도 동일
     규칙: draft 덮어쓰기·proposal 폐기 시 **proposal에 결속된 candidateId 목록**과 대조해 미등재
     adopted를 proposed로 복원한다(proposal 파일에 candidateId 결속 필드 추가 — draftable 공통·
     resolved-blocker의 기존 고아 경로도 함께 봉합).
  3. draft allowlist: candMark의 병합 초안 분기를 draftable kinds(`resolved-blocker`,
     `user-constraint`) 목록으로 — user-constraint 채택=ab축 병합 초안 생성(A-4 재사용·문안=
     인용 원문 그대로 — scope는 문안에 넣지 않는다: §1 scope 지위 참조·범위가 본질이면 인용
     문장 안에 있어야 함).
  3b. **mark 우회 봉합(3차 blocker② 반영 — 기존 계약의 의식적 개정)**: `envelope-candidate mark
     <id> adopted`가 proposal 결속 없이 상태만 기록하는 기존 경로는 draftable kind에서
     adopted-but-unstamped 고아를 복원 규칙 밖에서 만든다 → **draftable kind의 직접 adopted
     기록은 거부**하고 draft 경로 안내를 출력한다("채택은 draft 명령/대시보드 버튼으로 — 초안
     생성과 결속돼야 함"). declined·failed 기록은 그대로 허용. 소진 보고의 결과 기록 안내문도
     draftable kind에 대해 draft 명령으로 갱신(비 draftable kind는 종전대로 mark adopted 허용).
  4. UI: 후보 줄 kind 문구 1종 추가("M/D 대화에서 말씀하신 제약이에요 — 수칙서로 올릴까요?"),
     버튼은 draftable 분기라 자동으로 "수칙서 초안 만들기"가 뜸(2026-08-20 개편 표면 상속 —
     개요 벨·gotoEl 포함). Envelope 비활성(승인 지문 없음) 워크스페이스에서는 상신 시 후보 대신
     안내만("수칙서를 먼저 승인해야 올릴 수 있어요" — A-6 경계와 동형).
  - "신규 전이 코드 0"의 의미는 **승인 전이 primitive(draft·stamp·transition)의 재사용**으로
    한정한다 — 분기 확장 코드는 위 4곳에서 발생한다.
- **권위 흐름(1차 blocker④ 반영 — 초안 v1에서 의식적으로 후퇴)**: 미승인(proposed) 후보는
  **판정 생성 프롬프트에 넣지 않는다.** LLM 입력 안에서 '참고' 라벨은 정보 흐름을 격리하는
  구조적 경계가 아니므로, 도장 전 원문 동봉은 사실상의 판정 권위 우회가 된다(경위 색인 자동층과
  결정적으로 다른 점: 색인 자동층은 '검증이 이미 확정한 사건'의 발췌이고, user-constraint는
  검증을 거치지 않은 발화다). 도장 전 노출 표면은 **대시보드 후보 줄(원문+근거 보조 줄)뿐**이며,
  검증 주입은 도장(ab축 편입) 후 기존 Envelope 경로로만.

## 4. 오염·남용 방지 요약

원문 스냅샷 결속(작문·재구성 차단 — A·B 공통 유일 권위)·민감정보 형태 방어·200자 거부·
전체 지문 ID(scope는 메타)·턴당 2건+pending 12 합산 상한·성공·거부 내구 영수증(원문 비복사·
provider/wsKey 포함)·거부권(declined=같은 세대 억제)·규약 어휘 거부·블록 손상=전량 거부·
adopted 고아 복원+carry-forward candidateId별 1회.

## 5. 비목표

- 문구 패턴 검출기·키워드 목록(경직성 금지).
- 자동 수칙 승격(도장 우회)·미승인 후보의 판정 입력 동봉 — 권위 경계 불변.
- 포착률 보장 — 목표는 "계기 0 → 계기 상시+측정 가능"(영수증으로 미포착/버림 구분).
- Memento 등 외부 기억층 연동(별도 주제).

## 6. 검수 기준

- 부품 A 실행 왕복: 성공+거부 반례 전종(스냅샷 부재·비연속 구절·12자 미만·200자 초과·민감정보
  형태·규약 어휘·턴당 상한·pending cap·중복 지문·why 형식) — 각 거부의 내구 영수증 실존(원문
  비복사·provider/wsKey 실림). turnAnchor 결정성(Claude 경로: 같은 sessionId+active.ts=같은
  anchor·다른 턴=다른 anchor).
- 부품 B 파서: 정상 적재·블록 위치(지적 블록 앞) 규격·손상 전량 거부·**대조 권위=훅 스냅샷**
  반례(구현자가 검증 요청문에 새로 쓴 문장을 quote로 제출→거부 — 2차 blocker① 정방향)·주입문
  위장 반례(계약 문구 제출→거부)·블록 부재 무해·job 결속(sourceHash 불일치=전량 거부)·
  **직접 ask 반례**(job 없는 즉석 실행의 후보 블록=전량 무시+reason direct-ask 거부 영수증 실존
  — 3차 blocker① 정방향).
- 부품 C: 계산기 합류·세대 carry-forward(proposed+adopted-but-unstamped 각 1회 재발급)·
  **adopted 고아 복원 반례**(A 채택→B draft 덮어쓰기→A가 proposed로 복원·재채택 가능 — 2차
  blocker② 정방향)·**mark 우회 반례**(draftable kind에 envelope-candidate mark adopted 직접
  기록→거부+draft 안내 출력·declined/failed는 허용 — 3차 blocker② 정방향)·draft 생성(채택→
  초안→도장 경로·scope 미포함 문안)·Envelope 비활성 안내·기존 resolved-blocker 파이프 무회귀.
- 전체 체인 EXIT=0.

## 7. 구현 순서 (설계 동결 후)

1) 훅 턴 원문 스냅샷+A(CLI·게이트·영수증) + 시험 → 2) C 파이프 합류 4곳+표면 문구 →
3) B 블록 파서(문법 동결분)+프롬프트 범주 규칙 1줄 → 4) 체인·설치·실전 스모크 1회.
