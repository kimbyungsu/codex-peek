# 재판단 권위 회복 설계 (REJUDGE-AUTHORITY) v6

작성 2026-08-29 · v1(blocker 4·보완 3)+v2(blocker 3·보완 1)+v3(blocker 1·보완 3)+v4(blocker 2)+v5(blocker 2·보완 2) 설계 검증 전량 반영 개정 · 상태: **설계 검증 5/5 소진 — v6은 5회차 지적 반영분이며 미도장 · 범위 축소 확정([HARNESS-REALIGNMENT-2026-08-29.md](HARNESS-REALIGNMENT-2026-08-29.md) §5): 1차 구현=A+B+F, C·D는 2차(검증 경로 밖 독립 큐레이션 — v6의 마감 마커·curating 단계·5단 커밋 형태는 폐기), E 보류, §8 기본값으로 닫음**
발단: 사용자 진단 2026-08-29 — "검증자의 지적에 구현자가 경계를 중심으로 재판단·반박하는 부분이 작동하지 않아,
첫 설계 의도보다 보수적 접근(수용만)이 반복되며 사용자 의도에서 벗어났다. 재판단 강화 개선도 실제로는 동작하지 못했다."

선행 정본: [VERIFY-GOVERNANCE.md](VERIFY-GOVERNANCE.md)(2026-07-22 동결 — 원칙 "열린 탐색+제한된 차단 권한",
§3.2 입장 심사, §3.3 "범위 밖은 구현모델의 정식 반박 사유", §7 사용자 지시 2026-07-24 "소진 화면이 수칙서 후보를
직접 제시") · [ENVELOPE-SELECTOR-DESIGN.md](ENVELOPE-SELECTOR-DESIGN.md)(2층 서고+작업별 선별·선별 팔=provider 고정,
외부 팔 제외) · [RULEBOOK-SIMPLIFICATION-DESIGN.md](RULEBOOK-SIMPLIFICATION-DESIGN.md)(공급=판단 경유·표면 4어휘·역할 4분할).

## 헌법 (이 설계의 단일 원칙)
**수칙서는 지킬 규칙집이 아니라, 검증자의 실패 판정 권한을 사용자 승인으로 제한하고 구현자에게 정식 반박
근거를 주는 경계다.** 그러므로 경계는 ①반박하는 쪽에 전달돼야 하고 ②반박은 경계의 '범위 밖' 항목 번호 하나로
성립해야 하며 ③경계에 무엇을 넣고 뺄지는 채점자도 피채점자도 아닌 독립 실행이 장부를 보고 제안하고 사용자가 정한다.

## §0 문제 실측 (2026-08-29 · 장부 전수 — 재현 명령은 §9 · 기준 시각=선별 영수증 62번째 `…-cnnh.json`까지)

| 관측 | 수치 | 의미 |
|---|---|---|
| 재판단 처분(disposition **행 수**) | 706행 = 수용(사실 오류) **619** · 수용(보강) 64 · 보관 22 · **반박 1** (고유 지적 최종 처분 기준 545 = 468/54/22/1) | 반박률 0.1~0.2% — 재판단 규약("지적이라는 이유만으로 수용 금지")이 실행에서 작동하지 않음 |
| 검증자가 '범위 밖(supported:false)'로 표시한 지적 | **0 / 1057** · `oosId` 1 | 채점자에게 "자기 지적을 스스로 범위 밖으로 낮춰라"는 구조(입장 심사 규칙 2)는 한 번도 발동 안 함 |
| 기계 강등 22건의 종류 | 확인 라운드 범위 19 · fix-verify 3 — **경계(oos) 강등 0** | 경계는 채점 기준으로 실렸지만 판정 권한 제한에 쓰인 적이 없음 |
| 경계 전달 | 검증자: 전제·금지·제외 3축+서고 선별분 전량 / **구현자: 턴 시작에 '금지(ab)' 전문만**(implementerEnvelopeInject) · 판정 렌더(contract-lib formatForClaude)와 재판단 규약 꼬리에 경계 없음 | 반박 재료가 반박자에게 오지 않는다 |
| 선별·동봉 구조 | 실존·작동: 비-preview 영수증 62건(서고 크기별 0항 20 · 11항 9 · 23항 19 · 74항 14), 선별>0 34건(1~5항 28 · 6~11항 6) | "고른 뒤 실어 나르는 구조"는 있다 — 없는 것은 '실린 것을 재판단에 쓰는 고리'와 '재료 공급' |
| 서고 재료 | 0항(2026-08-28 23항 전량 빼기 승인 뒤 상신 0건) | 검증 교훈을 수칙으로 올리는 유일 경로(구현자 `rule-propose`)가 쓰이지 않음 |
| 결과 | 오늘 하루 상한 5/5 소진 캠페인 2회·라운드마다 새 blocker 수용의 순환 | 사용자 진단과 일치 |

## §1 원인 분해 (구조 — 문구·성실성 문제가 아님)

- **R1 재료 결손**: 경계(전제·제외)가 구현자에게 전달되지 않는다. 턴 시작 주입은 ab 전문만, 판정 렌더와 재판단 규약
  꼬리에는 경계 항목이 없다. "이 지적이 범위 밖 상황을 전제하는가"를 대조할 원문이 그 자리에 없다.
- **R2 강등 권한의 오배치**: 경계 강등(입장 심사 규칙 2)은 검증자가 `supported:false`+유효 `oosId`를 스스로 적어야 발동.
  채점자에게 자기 지적을 낮추라는 요구 — 1057건 중 0건.
- **R3 반박 채널의 부재**: `finding-judge rebut`는 자유 메모(12자+)뿐. 경계 항목 인용을 기계가 결속하지 않고,
  "다음 검증 요청에 근거 동봉"은 재판단 문안의 수동 의무이며, 검증자가 같은 지적을 반증 없이 재소환하는 데 제약이 없다.
- **R4 비용 비대칭**: 수용=처분 한 줄+수정+확인 검증. 반박=실측 반례 확보+요청문 동봉+분쟁 보류 위험.
  구조가 수용을 최저 비용 경로로 만든다 → 619:1.
- **R5 공급 정지와 주체 문제**: 현 동결 정본(RULEBOOK v4 §1)은 '상신=구현자·승인=사용자·선별=사서·채점=검증자'를
  ab-4에 맞는 역할 분리로 명시하고 있다(위반 아님). 그러나 ①검증 교훈을 수칙으로 올리는 유일 경로인 구현자
  `rule-propose`가 실제로 0건 사용됐고 ②07-24 사용자 지시(§7: 기계 재료 기반 후보를 화면이 직접 제시)는 '참고
  신호'로만 남아 후보 생성이 없다. 이 설계는 큐레이션을 **독립 실행으로 옮기는 새 역할 정책**을 제안한다(정본
  복원이 아니라 개정 — 사용자 승인 대상 §8-①).
- **R6 항상/관련의 소유권 부재**: '항상'은 저장 위치(코어 파일)에서 파생된 표시일 뿐 사용자가 항목별로 정한 값이
  아니며, 승격·강등 표면도 없다(4d에서 목적지 선택 제거).

## §2 방향 (원칙 6)

- **P1** 재판단은 경계를 근거로 한다 → 그 판에 실린 경계 전문을 반박자에게, 판정이 도착하는 그 자리에 준다.
- **P2** 강등 권한을 옮긴다 → 검증자 자기신고(유지)에 더해 **구현자의 '범위 밖' 인용 반박**이 같은 강등 효력을 갖는다.
  검증자는 그 지적을 재소환하려면 반증(지원 세계 안에서 도달 가능한 구체 인과 경로)을 내야 한다.
- **P3** 반박을 수용만큼 싸게 → 범위 밖 번호+전제 상황 한 줄로 성립, 다음 검증 요청에 하네스가 자동 동봉.
- **P4** 큐레이션은 독립 실행 → 선별 팔(사서와 같은 provider 고정 원칙)이 장부 재료로 유지/추가/삭제/항상↔관련을
  제안, 사용자 승인. 구현자 `rule-propose` 폐지 여부는 사용자 결정(§8-①).
- **P5** 항상/관련은 사용자 속성 → 수칙 한 줄마다 사용자가 정하고(제안은 추천값만), 새 수칙 기본값=관련될 때.
- **P6** 통과 위조 방지 불변 → 경계 반박은 삭제가 아니라 강등이며 판정 재산출은 기존 규칙("남은 blocker 전부 강등=
  '보류' 재산출·사용자 선택 ①범위 밖 수용 ②재심")을 그대로 탄다 — **구현자 반박만으로 '통과'가 생기지 않는다.**

## §3 설계 (부품 A~F)

### A. 판정 도착 자리의 '재판단 재료' (R1) — 동결 전문 v2
- **동결 확장(freeze v2)**: ask-start가 이미 남기는 동결 레코드(`readFrozenEnvelopeRec`: hash·manifest{n,source,textFp}·
  boundaryGen·appliedArchiveHash)에 **이번 판에 실제 주입된 경계 전문**을 추가한다:
  `boundary: { sup:[{n,text,textFp}], ab:[…], oos:[…], archiveSel:[{n,text,textFp}] }` — askId 결속·유계(축 12항×200자
  ×3+선별 12항×200자). 주입 조립(envelopeSliceFor)이 잠금 안에서 읽은 그 원문을 그대로 적는다(파일 재판독 없음).
  구 freeze(전문 없음)=하위 호환: 재료 절 생략+"이 판은 경계 전문이 동결되지 않은 구 세대" 1줄 고지.
- **판정 도착 렌더**: 검증 답 꼬리(재판단 규약 바로 위)에 **[재판단 재료 — 이번 판에 실린 경계]** 절을 붙인다:
  전제 sup-n / 금지 ab-n / 제외 oos-n / 서고 선별분 ab-(코어 다음 번호) 전문을 **그 판의 freeze v2에서만** 읽어 나열
  (다른 세대 문안 결속 금지 — ab-1·계보 오결속 방지). 미판단 관문 거부문(finding-judge 목록)에도 같은 번호표.
- 자동 대조는 하지 않는다("이 지적은 oos-3 후보"라는 기계 추정 금지 — 문안 패턴 매칭 누적 금지). 판단은 구현자.

### B. '범위 밖' 인용 반박 채널 (R2·R3·R4) — 근거는 oos-n뿐
- **의미 정정(v1 blocker①)**: 반박 근거는 **`oos-n`(제외 — 지원하지 않는 상황)만**이다. `sup-n`은 "그 상황은 지원 세계
  안"이라는 뜻이라 오히려 지적을 뒷받침하고, `ab-n`은 입장 심사 '강등 면제' 인용이다 — 둘 다 반박 근거가 아니다.
- CLI: `finding-judge <id> rebut --oos oos-3 --path "<이 지적이 전제하는 범위 밖 상황 한 줄>"` —
  `--oos`는 **그 판 freeze v2의 유효 번호만**(무효=거부·`ab-invalid` 문법과 동형), `--path`는 필수(120자·단일행·민감 형태
  검사=safeBacklogAutoTitle) — 번호의 존재가 아니라 "어느 범위 밖 상황을 전제하는지"를 구현자가 적는다.
  처분 레코드에 `boundaryRef{kind:"oos", index, textFp, boundaryGen, askId}` 결속.
- 기계 효력(즉시·장부): 입장 심사 규칙 2와 **같은 강등 결과**(`demotedTo:"백로그"`·영수증 `implementer-oos`·finding 즉시
  closed=reclassified). 판정 재산출은 기존 규칙 그대로: 남은 blocker가 전부 강등이면 **'보류'**(사용자 선택 ①범위 밖
  수용 ②재심) — 통과로 재산출되는 경로 없음(P6·ab-3).
- 다음 검증 요청 자동 동봉: ask-start가 요청문 뼈대에 **[경계 반박 — 하네스 동봉]** 절을 붙인다:
  `f-xxxx: <지적 제목> ← oos-3 <전문> / 전제 상황: <path> (구현자 반박·세대 <boundaryGen>)`. 구현자가 손으로 옮기지 않는다.
- 검증자 서식 확장(v2 서식·`FINDING_ORIGINS`에 `boundary-contest` 추가·파서 동시 확장 — **기계 판독 스키마 v2 blocker① 반영**):
  경계 반박된 지적을 다시 blocker로 올리려면 지적 행에 다음 세 필드가 모두 있어야 한다:
  `"origin":"boundary-contest"` · `"prevId":"f-…"`(같은 캠페인에서 구현자 `implementer-oos` 강등 처분이 결속된 지적 id) ·
  `"contest":"<반증 서술>"`(**문자열·단일행·공백 정규화 후 20~300자** — 인용된 oos 상황 없이도 지원 세계 안에서 도달
  가능한 구체 인과 경로). 파서는 `contest`를 보존 필드에 추가(형식 무효=필드 드롭·'미기재' 취급 — 기존 v2 필드 규칙과 동형).
  입장 심사 **규칙 2b(결정론)**: `origin==="boundary-contest"`이면 ①`prevId`가 이 캠페인·현 세대의 `implementer-oos` 강등
  지적을 가리키지 않음 → `contest-unbound` 강등 ②`contest` 미기재/형식 무효 → `contest-unproven` 강등 ③둘 다 유효 →
  blocker 복귀(영수증 `contest-restored`·구현자 재판단 대상 — 다시 반박하려면 다른 oos 번호 또는 실측 반례). 진위는
  재판단 몫(기계는 형식·결속만 — 기존 입장 심사 기대치와 동일).
- 분쟁 종결: 같은 지적이 `boundary-contest`로 **2회 복귀**하면 자동 **[분쟁 보류]**(기존 보류 3분류 재사용 — 경계 문안
  개정 여부는 사용자만).
- 남용 억제(구현자가 모든 blocker에 oos를 붙이는 경로): ①번호만으론 성립 불가(`--path` 필수) ②강등은 삭제가 아니라
  보관·마감 보고·통계(경계 반박 M/캠페인)에 잔존 ③전량 강등=보류(사용자 선택) ④같은 oos 2회=큐레이션 후보(§7 원천 ①
  — "이 상황을 계속 치워둘지, 이제 방어할지" 사용자 결정) ⑤검증자 반증으로 복귀.
- 비용: 반박=명령 1줄(번호+상황 한 줄). 수용과 같다(P3).

### C. 큐레이션 실행 (R5) — 마감 마커 + 다음 검증 job의 'curating' 단계 (v2 blocker② 반영: 새 내구 조각을 명문)
- **왜 후처리가 안 되나(정정)**: worker는 검증 호출 직후 `succeeded|failed`로 끝나고, 캠페인 마감(통과 종결·상한 마감 수락)
  은 그 뒤 Stop 훅이 구현자 마감문을 읽어 결정한다. 따라서 "마지막 검증 job의 후처리"는 성립하지 않는다 — v2 표현 철회.
- **트리거(새 내구 조각 ①)**: Stop 훅이 캠페인을 마감할 때(`done`·`cap-settled`·`held` 기록 직전) **큐레이션 마커**
  `verify-findings/<wsKey>.curate.json`(목록형·campaignId별 누적·잔여 마커와 같은 파일 규약)를 남긴다. 기록 실패=마감 미수락
  (잔여 마커와 동일 fail-closed). **마커 항목=캠페인 스냅숏(v4 blocker① 반영)**: `{campaignId, sourceAsk(마지막 검증 job id),
  boundaryGen, verifierProvider, ts}` — freeze는 ws 단일 파일이라 다음 검증이 덮어쓰므로 캠페인의 세대·provider를 마커에 동결한다.
  이를 위해 **ask-start가 job 레코드에 `boundaryGen`을 기록**(기존 verifierProvider 동결과 같은 자리 — 소규모 확장). Stop 훅은
  **capHandoffContext와 같은 선택 규칙(같은 ws 정규화·같은 campaignId·verifyRound→완료 시각 정렬)을 공용 함수로 확장해 재사용**하되,
  **state 무관(succeeded·failed 모두)** 마지막 job에서 두 값을 읽는다(v5 blocker② 반영: 예산 전부 failed인 상한 캠페인도 스냅숏
  원천이 있음 — 두 Stop 훅이 다른 job을 고르는 일 없음). job이 하나도 없거나 두 값이 없으면 마커 항목을 `{campaignId, boundaryGen:null,
  reason:"gen-unknown"}`로 남기고 **마감은 수락**한다(완료 불가 교착 금지·ab-6) — 그 항목은 큐레이션에서 "세대 미상=제안 보류"로 표시만
  하고 소비하지 않는다(사용자가 대시보드에서 제거). `curationKey`는 마커 항목의 boundaryGen으로만 계산(현재 freeze 참조 금지). 팔 결정의
  입력도 마커 항목의 `verifierProvider`(현재 계약 재판독 아님).
- **실행(새 내구 조각 ②)**: 그 ws의 **다음 ask-start가 만드는 검증 job**이 `queued→curating→selecting→running`으로 한 단계를
  더 갖는다(유효 상태 목록 확장). `curating`은 selector-runner(`purpose:"curate"`·1페이지·팔 규칙은 아래)로 마커의 캠페인들을
  차례로 처리한다. **예산**: 선별 예산 공식(페이지×timeout+여유)을 큐레이션 페이지 수만큼 별도 가산(`curateDeadlineAt` —
  검증 예산 무접촉). 초과=큐레이션만 실패 기록·마커 유지·검증은 정상 진행(검증 판정 무영향).
  **실행 생략 조건(비용)**: 그 캠페인의 기계 신호(§7 원천 ①~③)·경계 반박·강등·복귀가 모두 0이면 페이지 호출 없이 "제안 없음"
  영수증만 남기고 소비(통과 종결 캠페인 대부분이 여기 해당 — 매 캠페인 LLM 호출 방지).
- **커밋 순서·멱등 키(v3~v5 blocker 반영 — 5단 저장의 once-only·미커밋 비노출)**: 캠페인 하나의 큐레이션 결과는 **단일 결정론 키**
  `curationKey = sha1(wsKey|campaignId|boundaryGen)`(boundaryGen=마커 항목 값)로 묶인다. `resultFp` = 정본 직렬화
  `{boundaryGen, items:[{candidateId, kind(추가|삭제|전환), text 정규화, recommend} … candidateId 오름차순]}`의 sha1(v5 보완 반영 —
  같은 지문=같은 items). 순서:
  ①**후보 항목 행을 `status:"provisional"`로** append(`candidateId = envelopeCandidateId("curator", curationKey|정규화 문안 sha1)`) —
  **provisional은 기존 latest 합류·대시보드·조정기·초안 어디에도 노출되지 않는 상태**(v5 blocker① 반영: 결과 행 부재=외부 효과 0) →
  read-back: `items[]`의 모든 candidateId가 provisional로 실존 확인 →
  ②**결과 행(커밋 행)** `{type:"curation", curationKey, campaignId, boundaryGen, resultFp, items:[candidateId…]}` append →
  ③**활성화 행** — `items[]` 각각에 `status:"proposed"`(kind curator·curationKey 결속) append(이때부터 화면·승인 흐름에 등장) →
  ④**영수증(멱등 판독 후 기록)**: selectorUsage에서 `(purpose:"curate", wsKey, curationKey)`를 먼저 조회 — 정확히 1건이면 재사용,
  0건이면 append, **2건 이상이면서 resultFp가 서로 다르면 fail-closed**(마커 보류·경보) →
  ⑤read-back(②결과 행·③활성화 행 전부·④영수증 실존) 뒤에만 마커에서 항목 제거(제거 실패=마커 유지·다음 실행에서 재시도).
  **재시작 규칙**: 마커 항목의 `curationKey`로 ②결과 행을 찾는다 — 있으면 `items[]`의 provisional 실존 재확인(누락=①을 그 id로만
  재기록) → ③ 누락분만 재기록(멱등) → ④⑤(LLM 호출 없음); 없으면 처음부터 — 이때 남아 있는 provisional 행은 노출된 적이 없으므로
  새 결과의 id와 달라도 무해(같은 curationKey의 미커밋 provisional은 결과 행 부재 시 조정기가 `superseded`로 닫음). 마커가 먼저
  사라지는 경로 없음(⑤가 마지막) → 침묵 유실 없음·미커밋 노출 없음·중복은 키·조회로 차단.
- **취소·복구**: 취소=마커 항목 삭제(대시보드 제안함 '제안 안 받기' 1클릭 — 사용자만). 재시작 복구=worker 재실행 시 마커에
  남은 항목만 재처리(멱등). 충돌=같은 ws 검증 job 동시 1개 규칙이 이미 보장.
- **팔·입력 provenance(v2 blocker③ ab-7·v3 보완 반영)**: 큐레이션 팔은 **그 캠페인 검증 job에 동결된 `verifierProvider`로
  캠페인마다 결정**한다(codex → codex 팔 / claude → self 팔 — 구현자 턴의 constraintCtx.provider가 아님). 현재 턴 환경에서 그
  팔을 실행할 수 없으면(예: verifierProvider=codex인데 Codex 연결 없음) 그 campaignId는 **소비하지 않고 마커에 보류**(사유 기록·
  대시보드 "제안 보류: 검증자 연결 필요") — 불일치 행을 전부 제외한 채 "제안 없음"으로 소비하는 경로 없음.
  입력 행은 **"그 행을 이미 본 provider"와 팔이 같을 때만** 포함한다: finding 행에 `verifierProvider`를 기록(신규 필드 — 이 설계
  이전 행=provenance 없음=제외).
  **구현자 자유문(처분 note·`--path`)은 입력에서 제외**하고 번호·영수증 종류(`implementer-oos`·`contest-restored`·강등 규칙 키)
  만 보낸다 — 휴리스틱 비식별화(safeBacklogAutoTitle는 전화·주민번호 미검출)에 기대지 않는 구조적 제외.
  대화 원문 없음. 직전 N캠페인 항목은 같은 provenance 규칙 아래서만 합류(N=§5 운영값).
- **입력(장부·파일만)**: 현 수칙 전문(코어+서고·번호·항상/관련 값) · 마커 캠페인의 finding 제목(provenance 일치분)·강등/복귀
  영수증 키·boundaryRef 번호·반복 계보 · §7 기계 신호 · '한 번도 안 실린/안 쓰인' 항목(selectorUsage의 askId·archiveHash·
  selectedIds를 ask job campaignId로 결합 — 서고 세대가 바뀌면 `arc-N` 동일성은 textFp로 대조·세대 불일치 행 제외).
- **출력**: 후보 장부 kind `curator`(policyVersion 3) — {추가(문안+왜+추천 항상/관련) · 삭제(번호+왜) · 항상↔관련 변경(번호+왜)}.
  §7 표현 계약(ⓐ이번에 있었던 일 ⓑ올리면 달라지는 것 ⓒ안 올리면 유지되는 것 ⓓ권장+근거). 후보 0건이면 영수증에 "제안 없음"
  기록(침묵 금지). 파서=선별 페이지 파서와 같은 strict 규칙(형식 손상=전량 거부·재시도 없음).
- 성장 억제 §7 그대로: 추가는 반복 임계(같은 oos 반박 2회·같은 계보 2회+)에서만, 정리 임계(30항)에선 정리 후보 우선.
- 표면·승인 배선(v3 보완 반영 — 구현 지점 명시): `curator` kind를 **`ENVELOPE_DRAFTABLE_KINDS`(contract-lib)와 대시보드 초안
  분기(extension candMark adopted → draftEnvelopeRevision target archive)·제안 문구 분기·계산기 합류(computeEnvelopeCandidatesFor ⑤)·
  조정기 이월(reconcile carry-forward)**에 추가한다 — 빠지면 승인 기록만 남고 초안이 안 만들어진다. 제안함 표시 "제안(독립 실행)"·
  [승인]/[안 올림] 1클릭(기존 승인 흐름). 삭제·항상↔관련 제안은 기존 빼기(envelopeRevise)·D의 전환과 같은 승인 창으로 배선.
  구현자 `rule-propose`의 폐지/잔존은 §8-① — 잔존 시 제안 줄에 '구현 담당 제안' 표기 의무.
- **새로 만드는 것(정직 명문)**: 마감 마커 파일·worker 상태 `curating`·큐레이션 예산 가산·purpose curate 페이지 프롬프트/파서·
  후보 kind curator·후보 status `provisional`(비노출)·큐레이션 결과 행(type curation·curationKey)·job 레코드 `boundaryGen`·finding 행
  `verifierProvider` 필드·마지막 job 공용 선택 함수(state 무관)·실행 생략 조건.
- **시간 상한(정직 명문)**: 최악 합계=선별 상한(74항 기준 ~17분)+큐레이션 1페이지(~9분)+검증(~8분)≈34분으로 대시보드 대기 30분을
  넘을 수 있다(멈춤은 아님 — 각 예산이 유계). 실행 생략 조건으로 대부분 0분이지만, 30분 UX 상한을 지키려면 §8-④ 결정 필요. 재사용: selector-runner·후보 장부·승인 흐름·잔여 마커 파일 규약·
  selectorUsage 서랍·같은 ws job 단일 규칙.

### D. 항상/관련 = 사용자 속성 (R6)
- 수칙 목록 각 줄에 값 표시·1클릭 전환(같은 승인 창 1번). 저장은 코어 파일(항상)/서고 파일(관련) 이동 — 같은 전이 잠금·WAL.
- 새 수칙 기본값=관련될 때. 기존 19항은 현 값(항상) 유지·사용자가 줄마다 내릴 수 있음(시스템이 '헌법' 주장 안 함).
  금지(ab) 항목을 내릴 때는 창에 "이 항목은 관련 없는 판에 실리지 않게 됩니다"를 한 줄 표시(설명만·차단 없음).
- 보관 파일 확장: v1 '금지' 칸 전용 → 전제·제외 칸 추가(선별 절 주입·freeze v2·번호 연속 규칙 확장). **별도 증분(§8-③)**.
- 카드 첫 줄: "수칙은 검증마다 자동 적용돼요(항상=매번 · 관련될 때=사서가 작업 보고 골라 실음) · 사용자는 목록과 이 값만 정합니다".

### E. 가시화·계량 (R4 관측)
- 수칙 카드/개요: "이번 캠페인 재판단 — 수용 N · 경계 반박 M · 검증자 반증 K · 분쟁 보류 J".
- 통계 탭: 캠페인별 반박률·경계 인용률·왕복 수·소진 여부. 연속 N캠페인 반박 0+경계 실림>0이면 노랑
  "경계가 재판단에 쓰이지 않고 있어요"(N은 운영값 §5).

### F. 재판단 규약 문안 (구조가 아니라 표기 — A·B와 함께 1회 변경)
- 순서 반전: "①지적이 제외(oos) 상황을 전제하는지 먼저 본다 — 그렇다면 반박이 기본(`rebut --oos`) ②아니면 실측 근거로
  수용/반박". 반박 명령 1줄 안내 포함. 각 처분에 `boundaryRef` 유무가 장부에 남는다(문구가 아니라 기록).

## §4 순서 (증분)
1. **1차 = A+B+F** — 서고 0항이어도 코어 제외(oos) 6항으로 즉시 반박 가능. freeze v2·처분 boundaryRef·규칙 2b·origin 확장·요청문 동봉·렌더.
2. **2차 = C** — 마감 마커·worker curating 단계·finding verifierProvider 기록·후보 kind curator·제안함 표기(§8-① 결정 반영).
3. **3차 = D+E** — 속성 소유권·보관 파일 3칸 확장·계량.
각 증분은 독립 캠페인·독립 검증. 1차 완료 시점부터 반박률 계측 시작.

## §5 운영 초기값 (정답 아님 — 통계로 조정)
- 분쟁 보류 자동 승격: 같은 지적 `boundary-contest` 복귀 2회.
- 큐레이션 추가 후보 임계: 같은 oos 반박 2회 / 같은 계보 2회+ / 강등 반복 2회(§7 ①③ 그대로).
- 반박 미사용 노랑: 연속 3캠페인(경계 실림>0·반박 0).

## §6 비범위
- 경험 색인(2차 색인 설계)·선별 품질(사서의 관련도 판단 자체)·Codex↔Codex 표면 동기(같은 함수 공유 원칙만 명문).
- 경계 문안의 자동 대조·추천(패턴 매칭 누적 금지 — 판단은 사람과 독립 실행).

## §7 ab 경계 자기 점검
- **ab-3(통과 위조)**: 반박 근거=oos-n만(sup·ab 불가)·`--path` 필수·강등은 삭제 아님·**전량 강등=보류(통과 아님)**·반증 복귀·
  2회=사용자 판단·freeze v2 유효 번호 결속(무효 거부). 구현자 반박이 통과를 만드는 경로 없음.
- **ab-4(역할 혼합)**: 반박=구현자(정식 권한·§3.3), 반증=검증자, 큐레이션=독립 실행(선별 팔), 승인=사용자.
- **ab-1(오귀속)**: boundaryRef=askId·boundaryGen·ws 결속. 다른 판의 번호로 반박 불가.
- **ab-5(기록 파괴)**: 처분·강등·반증·후보 전부 append-only. 삭제 없음.
- **ab-7(유출)**: 큐레이션 입력은 provenance 일치 행(그 provider가 이미 본 검증자 원문)만·구현자 자유문 제외·대화 원문 없음·외부 API 팔 제외 고정. 반박 `--path`는 장부 저장 전 민감 형태 검사(저장 자체를 거부).

## §8 결정 항목 — 기본값으로 닫음 (2026-08-29 범위 축소, 지금 결정할 것 없음)

[HARNESS-REALIGNMENT-2026-08-29.md](HARNESS-REALIGNMENT-2026-08-29.md) §5·개선 2의 규칙("기본값이 있으면 구현자가 정하고 보고만 한다")에 따라
아래 4항은 **사용자 결정 요구가 아니라 기본값 확정 보고**다. 재진입 조건이 실측되기 전에는 다시 묻지 않는다.

| 항목 | 기본값(확정) | 재진입 조건 |
|---|---|---|
| ① 구현자 `rule-propose` 폐지 vs 잔존 | **잔존(현행)** — 제안 줄 '구현 담당 제안' 표기 | C 큐레이션을 재론할 때 함께 |
| ② 반증 없는 `boundary-contest` 재소환 | **자동 강등(`contest-unproven`)** — 1차 B에 포함 | 실제 캠페인에서 부당 강등이 관측될 때 |
| ③ 보관 파일 전제·제외 칸 확장 시기 | **확장 안 함(보류)** — 전제·제외는 코어에만 | 되받아침이 실제로 쓰이고 "제외 칸이 모자라다"가 실측될 때 (유일한 재진입 항목) |
| ④ 큐레이션 최악 ~34분 허용 vs 30분 강제 | **큐레이션 자체 보류 → 질문 소멸** | C 재론 때 |

(구 문안 보존) 1. 구현자 `rule-propose` 폐지 vs 보조 채널 잔존. 2. 반증 없는 재소환: 자동 강등 vs 경고만. 3. D의 3칸 확장 시기.
4. 큐레이션 ~34분: (a) 허용 vs (b) 대시보드 대기시간 안으로 강제.

## §9 실측 재현 (검증자용)
- 처분 집계: `~/.codex-bridge/verify-findings/*.jsonl`에서 `type:"disposition"`의 `choice` 집계(행 수 706=619/64/22/1 ·
  고유 지적 최종 처분 545=468/54/22/1).
- 범위 밖 표시: 같은 파일 `type:"finding"`의 `supported===false` 0건·`oosId` 1건·`demoted` 22건(confirm 19·fix-verify 3).
- 구현자 주입: `bridge/contract-lib.js implementerEnvelopeInject`(ab 전용) · 판정 렌더 `bridge/contract-lib.js formatForClaude`
  (정의)·호출 `bridge/codex-bridge.js` finishVerifyRun — 경계 없음.
- 선별 영수증: `readSelectorUsage()` purpose≠preview — 62번째 영수증 `01787981663981-0000015664-000000-cnnh.json`까지 62건,
  선별>0 34건(크기·개수 분포는 §0 표).
- 검증자 서식: `bridge/codex-bridge.js v2DirectiveFor`(supported/oosId 자기신고) · 입장 심사 `contract-lib.js judgeAdmission`
  규칙 2 · 전량 강등=보류 재산출 `codex-bridge.js machineFindingsLayer`("[입장 심사] 남은 blocker가 전부 범위 강등").
- 동결 레코드 현행: `contract-lib.js readFrozenEnvelopeRec`(manifest=ab {n,source,textFp}만 — sup/oos·전문 없음) → A의 freeze v2 근거.
- `FINDING_ORIGINS` 4종·v2 파서 보존 필드(origin·supported·oosId·abId·id·prevId)(`contract-lib.js`) → B의 `boundary-contest`·`contest` 필드 추가 근거.
- worker 생명주기(`ask-job-worker.js`: 검증 호출 직후 terminal·Stop 훅이 마감 결정) → C의 마감 마커+curating 단계 근거.
- freeze=ws 단일 파일(다음 판이 덮어씀)·job 레코드에 boundaryGen 없음(`codex-bridge.js` ask-start) → 마커 스냅숏·job boundaryGen 기록 근거.
- `appendSelectorUsage`=호출마다 새 파일·유일성 검사 없음 → ④ 영수증 멱등 조회 규칙 근거. 후보 장부 latest=candidateId@envelopeHash fold·유효 status 전부 즉시 합류(`contract-lib.js` readEnvelopeCandidates)·계산기 ⑤가 proposed|adopted 즉시 소비 → provisional 비노출 상태 근거.
- 라운드 예약이 결과 전 영속(`contract-lib.js` verify 예약)·worker 실패=failed 기록 → 전부 failed 캠페인의 스냅숏 원천(state 무관 마지막 job) 근거.
