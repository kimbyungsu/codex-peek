# 수칙서 2층화 + 3트랙 선별자 (Envelope Selector) — 설계 v6 (2026-08-23 · 5차 잔여 blocker 반영 — 확인은 다음 캠페인 첫 검증)

> 배경: ab축 12칸 상한 도달과 '매 지시마다 사용자가 올리고 내리는' 운영 부담 실측. 사용자 확정 방향:
> **수칙은 쌓이되, '이번 작업에 실질적으로 필요한 수칙'을 LLM이 판단해 전달한다** — 사용자는 도장만.
> 선별 주체=3트랙 독립 LLM. **이중 배달**: 구현하는 쪽도 인지하고, 검증자에게는 판마다 신선하게.

## 0. 원칙

- 저장량과 주입량의 분리(서고에 쌓고, 판마다 코어 전량+서고 선별분만).
- 선별자=3트랙 독립 세션(피채점자·판정자 배제 — 세 축 전부).
- 권위 불변: 서고 항목도 도장 받은 문안만. 선별=노출 결정이지 문안 권위 아님.
- fail-closed: 선별·영수증·세대·시간·스냅샷 어느 하나 실패=검증 시작 중단(승인 규칙 없는 판정=통과 위조).

## 1. 2층 구조

- **코어 = 현행 verify-envelope.json 무변**(3축·축 12·200자·전량 주입·기존 도장/전이/작업대).
- **서고 = verify-envelope-archive.json (v1: ab축 전용)**:
  - `{schema:"verify-envelope-archive-v1", alwaysBlocker:[...], +En/Ex}` — 항목 200자·병렬 축 규칙 상속.
  - **v1 서고 상한=96항(코드 상수 — 2차 blocker④ 의식적 수용)**: 완전성(전 항목이 선별 후보)·유계
    시간·무상한 3자는 검색 색인 없이 양립 불가. v1은 '실용 무제한'(코어의 8배)로 시작하고 도달 시
    정리(빼기·병합) 안내. 무상한 해제=§8 세대 결속 검색 색인 증분.
  - ab축 전용 사유: 병목=ab 12칸. oos 서고화는 입장 심사·통계·빼기 계보 확장 필요(§8).
- **target 차원**: 제안본·WAL에 `target:"core"|"archive"`(부재=core legacy). target별 {파일, 계약
  필드(envelopeHash/archiveHash), strict 판독기} 표 분기 — 복구·kind:stamp도 같은 표. 전이 잠금=
  ws당 1개 유지(교차 덮침 직렬화). archiveHash=양 슬롯 동시(언어 공유 계보).
  - **제안본 이중 결속(2차 blocker① 반영)**: `targetBaseHash`(대상 파일 drift 검사용 — archive
    초안이면 archiveHash)와 `candidateGeneration`(후보 복원·adopted 조회용 — 항상 core
    envelopeHash) 분리. 폐기 복원·고아 복원은 candidateGeneration으로 조회, 전이 base-drift는
    targetBaseHash로 검사. legacy 제안본(두 필드 부재)=기존 baseHash 의미(core) 유지.
- **미도입 vs 소실**: archiveHash 부재=미도입(서고 절 없이 진행·무회귀). 지문 존재+파일 부재/손상/
  불일치=소실(검증 시작 중단+재도장 배너).
- **후보 파이프**: 장부·세대 키=core envelopeHash 축 무변. 채택 시점에만 목적지(core/archive) 분기
  (기본=서고·코어 승격은 명시 선택). '이미 등재' normSet=코어∪서고 합집합.

## 2. 판정 세대 (2차 blocker② — 합본이 세대다)

- **boundaryGen = sha1(coreHash + "|" + archiveHash + "|" + manifestFp)** — 이번 판의 판정 경계
  표식. freeze에 저장. **용도 한정(3차 blocker① — 세대와 생명주기의 분리)**: boundaryGen은
  ①신규 지적 레코드의 경계 표기 ②confirm-scope(같은 경계의 재확인만 confirm) ③ab-exempt 권위
  판정에만 쓴다. **열린 지적의 생명주기(openFindingsFor·처분 관문·재판단 의무)는 현행 캠페인 축
  그대로** — fresh 선별로 boundaryGen이 판마다 달라져도 같은 캠페인의 미해결 blocker는 살아서
  처분을 요구한다(경계가 바뀌었다고 열린 지적이 소실되는 경로 차단). deriveRoundType의 confirm
  판정만 boundaryGen 일치를 추가 조건으로(불일치=confirm 아님·신규 취급). **legacy 폴백 한정
  (4차 blocker①)**: envelopeHash 비교 폴백은 '현재 freeze도 legacy(manifest 부재 — 서고 미도입
  판)'일 때만 허용. 활성 manifest 판에서 boundaryGen 없는 과거 행은 confirm 재료가 될 수 없다
  (그 행이 어떤 선별판이었는지 알 수 없음 — 신규 취급·fail-closed).
- **ab 합본 manifest**: freeze에 `[{n, source:"core"|"archive", textFp(sha1-16)}]` — 합본 번호가
  곧 ab-N(코어 1..12 다음 선별 서고분 연속). 파서 정규식·심사 로직 무변, 개수·범위 판독처만
  freeze manifest로 교체. 과거 판 복원=textFp+선별 전문 proof 사본(90일).

## 3. 선별자

- **runner**: runScout 재사용 금지(scope 수집·MAP 기록 부작용) — 공급자 해석·격리 exec(--ephemeral·
  read-only·빈 임시 폴더)·사용량 기록만 추출한 무부작용 `selector-runner`.
  - **팔 고정=구현 턴과 같은 provider(3차 blocker②⑥ 동시 봉합)**: Claude 구현 턴→self(claude) 팔,
    Codex 구현 턴→codex 팔 — 자동 결정(설정 없음). 사용자 원문은 그 서비스에 이미 전송된 대화의
    일부라 **새 외부 전송 범주가 아니며**, 의도 재료(원문 스냅샷)를 항상 포함할 수 있다. deepseek·
    교차 provider 선별은 v1 제외 — 재개 조건=selector 전용 provider별 고지·동의+의도 재료 설계(§8).
  - **실행 형태(3차 blocker④)**: 비동기 spawn(spawnSync 금지) — worker가 주기적으로 cancel-intent
    를 폴링하고, 취소 시 Windows 프로세스 트리 종료(자식 포함)+종료 확인 후 terminal
    failed(cancelled). 마지막 페이지 완료→검증 모델 전환 사이에 원자적 cancel 확인 지점 1개.
- **시점·실행 위치**: ask-start는 queued 생성 즉시 반환(현행). 선별=ask-job worker 내부, 검증 모델
  호출 전 — 신설 내구 상태 `selecting`(대시보드 라이브 표기).
- **취소 계약(2차 blocker⑤·3차 blocker④·4차 blocker②)**: 신설 cancel-intent 내구 파일 — worker
  폴링은 provider 실행과 독립(비동기 spawn). 관측 시 프로세스 트리 종료·종료 확인·terminal
  `failed(cancelled)`. **intent 기록과 selecting→running 전이를 같은 ws job 잠금(withAskJobLock)
  임계구역으로 결속**: clear의 intent 기록도, worker의 전이도 그 잠금 안에서 수행하고 worker는
  전이 직전 잠금 안에서 intent를 재확인한 뒤 원자 전이 — 'intent 없음 판독 직후 기록되는' 전환
  경계 TOCTOU 차단. 살아있는 worker 강제 삭제 금지(기존 안전 규칙)는 유지.
- **입력(중립 재료)**: ①사용자 원문 스냅샷(constraint-turns 훅 산물 — 이번 작업의 목표·인수조건
  권위 원문·지문 결속) ②변경 파일 목록+diff 유계 절단분(scope-package 상한 재사용) ③서고 전문
  (id 병기). 검증 요청문(구현자 작문) 제외.
  - **스냅샷 부재=시작 중단(2차 blocker③)**: 승인 서고 활성 프로젝트에서는 스냅샷 없는 턴의 내구
    검증 시작을 거부('구현 대화에서 새 프롬프트를 한 번 보내 턴을 재기록' 안내 — 기존 관용구).
    미도입 프로젝트=현행 그대로.
  - **외부 전송 경계(2차 blocker⑦·3차 blocker⑥ ab-7)**: 팔 고정(구현 턴과 같은 provider — 위
    runner 절)이 경계 그 자체다. 원문이 이미 가 있는 서비스 밖으로는 어떤 팔에도 원문을 보내지
    않는다(교차·deepseek=v1 선별 제외). 위장 반례 검수: 팔 결정 로직이 설정으로 교차를 만들 수
    없음을 소스 계약으로 고정.
- **코드 세대 동결(2차 blocker⑧)**: 선별 시작 시 {archiveHash, scopePackageHash(변경물 꾸러미
  지문), HEAD sha, 작업트리 지문, snapshotHash}를 archiveCtx로 job에 동결. 주입 직전 서고 지문과
  변경물 지문을 재검사 — 어느 쪽이든 drift=중단(선별자가 본 코드와 검증자가 볼 코드의 동일성 결속).
- **페이지·시간(2차 blocker④·3차 blocker③ — 예산 분리)**: 페이지=항목 수 상수·병렬 P=상수(기본 3)·
  페이지당 timeout=runner 상수. **선별 예산과 검증 예산을 분리**: job에 `selectorDeadlineAt`
  (=산식 ceil(pages/P)×페이지timeout+여유·서고 상한 96항 전제 유한)과 `verifierDeadlineAt`
  (=현행 verifyTimeoutMin — 검증 모델 몫 전액 보존)을 따로 기록, job 전체 deadline=두 예산의 합.
  **verifierDeadlineAt의 절대 기준(4차 보완)**: selecting→running 전이 시점에 now+verifyTimeoutMin
  으로 확정하고, 검증 자식 프로세스 timeout·read-back 판정을 그 같은 절대 시각에 결속(생성 시점
  단일 deadlineAt 전달 방식의 교체). 선별이 자기 예산 초과=failed(selector-timeout) 판정 없음
  (검증 예산 무잠식). ask-wait·대시보드 표시도 두 예산 구분.
- **출력 strict**: 페이지당 `{"relevant":["arc-3",...]}`만 — 미지 필드·비배열·범위 밖 id·파싱
  실패=전체 실패. 이유 산문 없음.
- **주입량 상한**: 합집합 항목 K(기본 12)+바이트 상한. 초과=failed(selector-overflow)+정리 안내
  (절단·요약·재선별 금지).
- **영수증=선행 관문**: selector-usage 서랍(1건=1파일) 기록+read-back 성공까지 확인 후 프롬프트
  조립(실패=중단). 내용: {ts, wsKey, askId, archiveHash, scopePackageHash, snapshotHash|withheld,
  itemCount, pages, selectedIds, arm, durationMs}.
- **자연 축퇴는 미도입 하나뿐**. 빈 서고(도장된 0항)=선별 생략+0/0 영수증.

## 4. 이중 배달 — 구현자 인지 (2차 blocker⑥ 반영)

- **첫 구현 턴=pull+기계 관문(3차 blocker⑤·4차 blocker③)**: 지시문 1줄에 더한 기계 관문 —
  ①**Claude 런타임**: PreToolUse 게이트가 승인 서고 활성+이번 턴 스냅샷 존재 상태에서 preview
  영수증(이 턴 스냅샷 지문 결속)이 생길 때까지 **모든 변경 가능 도구 호출을 계속 차단**(1회 아님).
  matcher=Bash·Edit·Write·NotebookEdit·쓰기성 MCP 전종(설치기가 등록 — 현행 PreToolUse:Bash 단독
  등록을 확장). 영수증 판독 실패=차단(fail-closed). 허용 예외=preview 실행 명령 자체(정확 지문
  매칭)와 읽기 도구. 통과 후=무접촉·미도입 프로젝트=무발동. ②ask-start도 같은 영수증 선행 조건.
  ③**Codex 경로 동등 관문(5차 blocker — 약화 철회)**: 설치기(codex-plugin-install)가 Codex에도
  PreToolUse 등록을 추가하고(현행 SessionStart·UserPromptSubmit·PostToolUse·Stop 4종에 5종째 —
  codex-hook dispatcher는 PreToolUse 입력을 이미 처리 가능[실측]), Claude와 동일 게이트(영수증
  까지 지속 차단·판독 실패=차단·preview 예외)를 태운다. **fail-back 한정**: Codex 런타임이 해당
  이벤트 등록을 거부/미호출하는 실측이 나오면 그때만 ask-start 관문 한정으로 후퇴하되, 그 한계를
  코드 주석·문서에 명시하고 §8 확장 항목으로 남긴다(검수: 등록 실효 여부를 실전 스모크로 확인).
  preview=같은 selector-runner·같은 입력·영수증 purpose:"preview"·판정 권위 없음. 훅 동기 LLM
  호출 금지 유지(관문은 영수증 존재 검사뿐).
- **훅 주입(양 훅 공통)**: ①코어 ab 전문(상시·≤12항) ②**현재 턴 결속 캐시**: 이 턴의 스냅샷 지문+
  현행 archiveHash에 결속되고 **자격=완료된 preview 영수증 또는 primary proof가 실존하는 ask의
  선별 불변 사본**(3차 blocker⑤ — 같은 턴·같은 서고라도 검증 실행이 실패한 판의 선별은 자격 미달
  로 배제)일 때만('이번 작업 선별 수칙(참고)' 라벨). 타 작업·구세대=지문 불일치 자연 배제.
- **라운드 2+**: ask-wait 회수 출력에 선별 요약 1줄(영수증 기반) — 수정 루프의 구현자가 이번 판
  기준을 봄. 검증마다 fresh 선별(사용자 요구 '그때그때').

## 5. 오염·남용 방지 요약

3트랙 독립·입력 중립(원문 스냅샷은 사용자 작성·구현자 작문 제외)·팔 고정(구현 턴 provider 밖으로
원문 불전송 — 교차·deepseek v1 제외)·출력 strict·세대 동결(서고+변경물+스냅샷)·페이지 실패=전체
실패·상한 초과=중단·영수증 read-back 선행 관문·직접 ask 거부(승인 서고 활성 시)·소실≠미도입·
boundaryGen 경계 표식(생명주기는 캠페인 축)·preview 기계 관문·도장 권위 불변.

## 6. 검수 기준

- target: core/archive 왕복+교차 반례(archive 전이가 코어 무접촉)+legacy WAL=core+복구 target 승계+
  부분 슬롯 WAL 보존. 제안본 이중 결속: archive 초안 폐기→후보가 candidateGeneration(core 세대)으로
  복원되는 실행 반례+targetBaseHash drift 거부.
- boundaryGen: 같은 코어·다른 선별판=다른 세대(confirm-scope 오강등 반례의 정방향)·legacy 폴백 무회귀.
- 선별: 페이지 경계·병렬 P·deadline 산식·한 페이지 실패=전체 실패·출력 손상 전종·overflow·세대/변경물
  drift=중단·영수증 read-back 실패=중단·스냅샷 부재=시작 중단(활성 시)·빈 서고 0/0·미도입 무회귀.
- 취소: cancel-intent→페이지 경계 회수→failed(cancelled) 실행 반례.
- 합본 manifest: 연속 ab-N·textFp 복원·심사 범위=합본·legacy freeze 무회귀.
- 직접 ask: 승인 서고 활성=거부+안내·미도입=현행.
- 이중 배달: preview 명령 왕복(영수증 purpose)·훅 캐시=현재 턴 지문 결속만(타 작업 캐시 배제 반례)·
  훅에 동기 LLM 부재(소스 계약).
- 3차 반영분: 캠페인 열린 지적이 boundaryGen 변경 후에도 생존(처분 관문 유지 반례)·confirm은
  boundaryGen 일치에서만·팔 고정=교차 불가 소스 계약·selector/verifier deadline 분리(선별 소진이
  검증 예산을 잠식하지 않는 반례)·비동기 spawn+intent 폴링+트리 종료 실행 반례·PreToolUse preview
  게이트(무영수증=차단·영수증 후=무접촉·미도입=무발동)·캐시 자격(실패 ask 선별=배제) 반례.
- 5차 반영분: Codex PreToolUse 등록 실효(실전 스모크 — 미호출 실측 시 fail-back 한정 발동+문서화)·
  Claude와 동일 게이트 계약 공유(런타임별 분기 없음이 기본).
- 4차 반영분: 활성 manifest 판에서 legacy 행=confirm 불가(폴백은 legacy freeze 판만) 반례·
  intent 기록↔전이 CAS(같은 잠금 임계구역 — 전환 경계 취소 유실 반례의 정방향)·preview 게이트=
  영수증까지 지속 차단+Claude matcher 전종+판독 실패 차단+preview 명령 예외·Codex=ask-start 관문
  한정(정직 한계 문구)·verifierDeadlineAt=전이 시점 확정·PRIVACY 고지 문구 실존.
- 전체 체인 EXIT=0.

## 7. 구현 순서 (설계 동결 후)

1) target 차원+서고 판독기·도장·이중 결속+시험 → 2) boundaryGen·합본 manifest(freeze·carrier·심사
판독처) → 3) selector-runner+selecting/취소(CAS)+페이지·시간·상한·영수증·drift 관문+주입 절+직접
ask 거부 → 4) 이중 배달(preview 관문·훅 캐시)+작업대 목적지·대시보드 표기+**PRIVACY 고지 확장
(4차 주의 — selector 자동 재전송 범주: 같은 provider 한정·목적·내용·사용량 기록을 '정확히 네 갈래'
목록에 추가)**+실전 스모크.

## 8. 비목표 (후속 증분)

- 서고 무상한 해제=세대 결속 검색 색인(완전성 계약 별도 설계 — v1 상한 96항의 해제 조건).
- supported/oos축 서고화.
- 외부 API 팔에 원문 포함 선별(전용 동의+PRIVACY 고지 확장 전제).
- 선별 품질 자동 평가·페이지 병렬 P 상향(비용 선택).
- 등재 도장 완전 자동화(권위 구조 변경 — 별도 안전장치 논의 전제).
