# 검증자 공급자 분리(VerifierProvider) — Phase1 설계

상태: 설계 v3 (1·2차 설계검증 반영 — 잔여: session_id 키 서술 정정·존재성 시험 계약 정합 — 검증 통과 시 동결 — 동결 표기는 구현 첫 커밋 동승)
전제: Phase0 선검증 완료(2026-06-28 — Codex 훅 stdin 문서 확인·claude CLI 플래그 실측·변경감지 이식성 확인).
사용자 승인: 2026-08-05 "3번 진행해" (1차 구현 잔여 3축 중 마지막 축).

## 0. 목표와 범위

**목표**: 검증자 자리를 Codex 하드코딩에서 공급자(seam)로 분리해, Claude CLI를 두 번째
검증자(answer-only)로 붙일 수 있게 한다. 역할 전면 교체(구현자 호스트 교체)는 범위 밖(Phase2+).

**Phase1 = "답+증명+판정만"**: 둘째 공급자는 답 텍스트·성공 증명(proof)·판정 판독·기계 지적
블록·예산/캠페인/장부 연속성까지 전부 얻는다. 다음은 **codex 전용으로 유지**(공급자 능력 플래그로
자연 비활성): 세션 목록/대시보드 대화 뷰·모델 picker·evidence-unseen 중 '기록 다룬 흔적' 대조·근거
재확인(바이트 프로브)·연결 세션(링크/임대/이어쓰기)·**관찰일지 결합 확인의 '승격'**(1차 설계검증
blocker①: flagLedgerConfirms의 승격은 rollout 판독 seen="ok"가 필수(citedFilesUnseenExact →
contract-lib 승격 조건) — 무상태 claude에선 seen="unknown"으로 기록 전용이 된다. 호출은 유지하되
(감사 기록은 정직) 승격 불가를 상태 줄 결손 고지에 포함한다).
단 **인용 '존재성' 검사(디스크 대조)는 공통 유지**(1차 설계검증 [주의]: flagEvidence 앞부분
존재성 검사는 rollout 무관 — 통째 생략하면 존재하지 않는 파일·줄 인용이 무경보 통과한다. 생략
대상은 rollout 의존 구간(다룬 흔적)과 challenge 동결뿐 — 능력 플래그로 그 구간만 게이트).

## 1. 계약·동결 (스냅샷 원칙)

- 계약 필드 `verifierProvider: "codex" | "claude"` (기본 codex — 미지정·미지값=codex 무회귀).
  `VERIFIER_PROVIDERS`·`normVerifierProvider(o)`를 contract-lib 정본으로.
- **ask 시작 시점 동결**: ask-job에 `verifyProvider` 스냅샷 저장(기존 verifyProfile/verifyLang/
  rejudgeSnap과 같은 임계구역·같은 계약 스냅샷에서 — 검증이 도는 동안 대시보드 전환이 실행 중
  작업의 공급자를 바꾸지 못한다). 직접 ask는 실행 시점 계약 스냅샷 사용(기존 profileSnap 동형).
- CL-C·C-C 공통 한 필드(두 모드의 검증자 subprocess seam은 동일 — cmdAsk 단일 경로).

## 2. 실행기 (ClaudeVerifier answer-only)

- `resolveClaude()`: PATH의 `claude`(Windows `claude.cmd` 포함) + 시험/오버라이드용
  `CODEX_BRIDGE_CLAUDE_BIN` env. doctor에 상태 줄 추가.
- `runClaudeVerifier(promptText)`: spawnSync
  `claude -p --output-format json` — 프롬프트는 stdin(runCodex와 같은 원칙: 따옴표·줄바꿈 안전),
  timeout=minimumCallerTimeoutMs(), maxBuffer 동일(256MB), windowsHide.
  - stdout JSON 파싱: `{ result, session_id, is_error }` — `result`=답 텍스트, `is_error=true` 또는
    비0 종료=실패(부분 출력 성공 소비 금지 — runCodex의 badExit 원칙 동일). 파싱 실패=실패
    (진단 꼬리 diag 동형 — doctor 안내 포함).
  - **환경 격리**: spawn env에서 `CLAUDE_CODE_SESSION_ID`·`CLAUDE_PROJECT_DIR`·`CLAUDECODE` 류
    호스트 훅 변수 제거 — 구현 세션(Claude Code)의 훅·세션 문맥이 검증자 프로세스로 새어
    역할 오염(자기 세션 proof 키 충돌·훅 재귀)되는 경로 차단.
  - **무상태(stateless)**: 매 ask가 새 `-p` 실행. `session_id`는 proof '메타데이터'(codexSession
    필드 값)와 출력 헤더 표기 재료로만 사용 — **저장 키 아님**(§3 proof 항: 저장 키=구현자 세션 불변).
    연결 세션 연속성 없음 — 자연어 문맥 연속은 포기하되, 기계 연속성(findings 계보·입장 심사·
    캠페인 예산·재확인 규약 동결본)은 답 텍스트 기반이라 전부 유지된다. 출력 헤더는
    "# 연결 세션 <id>" 대신 "# 검증자: Claude(무상태) <askId>"로 정직 표기.
- 권한 거동: `-p` 비대화식에서 읽기 도구(Read/Grep/Glob)는 기본 허용, Bash 등은 거부될 수 있음 —
  검증은 읽기 중심이라 Phase1 수용(제약을 공급자 능력 플래그 `supportsShell:false`로 명시).
  **구현 첫 단계 = 런타임 선점검**(로그인 상태·권한 프롬프트·비대화식 타임아웃·JSON 에러 형식을
  실측하는 스모크 — Phase0 이월 잔여).

## 3. 배선 (cmdAsk 수술 — 핵심 위험 지점)

- **분기 순서(1차 설계검증 blocker② 반영 — '링크 판독 직전 단일 분기'는 실물과 불일치)**:
  ①공급자·harness 스냅샷을 계약 스냅샷과 같은 지점에서 확정 ②CL-C+claude=검증자 링크 해석·rollout
  확인·세션 임대·모델 인자·새 세션 비동기 감지 생략, ask-active 클레임 모드는 명시적 "new" 취급
  (링크 유무로 모드를 정하는 기존 식을 공급자 분기 뒤로) ③**C-C는 구현자 역할 저장소(links) 검사
  유지**(proof가 구현자 역할 확인에 같은 저장소를 재판독 — 검증자 링크와 별개 축) ④requireLinksWritable:
  C-C 유지(역할 기록 필수), CL-C+claude는 링크 기록이 없어 생략 가능하나 초기엔 유지(보수).
  ask-active 클레임·예산 예약·withContract 조립·attempt 기록은 공급자 무관 공통(순서 불변).
- **후처리 꼬리 공유화(중복 금지)**: runCodex 이후의 인라인 꼬리(proof→플래그→기계층→판정→출력
  조립→checkpoint→인쇄→재확인 발송)를 `finishVerifyRun(answer, sessionKey, ctx)`로 추출해 두
  분기가 같은 함수를 쓴다. **추출은 이동만(로직 불변) — provider=codex 경로의 출력 바이트가 추출
  전과 동일함을 회귀로 고정**(가동 중 검증 시스템 리팩터의 1급 인수조건).
- **공급자 능력 플래그로 codex 전용 단계 게이트**:
  - `flagEvidence` — **분리 게이트**(1차 설계검증 [주의] 수용): 인용 존재성 검사(디스크 대조 —
    rollout 무관)는 공통 유지, rollout '다룬 흔적' 대조와 재확인 challenge 동결만 능력 플래그로
    생략(허위 '근거의심' 경보 방지). 통째 생략은 허위 인용 무경보 통과라 기각.
  - `collectScoutTargetEvidence`·`machineFindingsLayer`·`formatForClaude`·예산/분해 고지 — 답
    텍스트 기반 공통 유지. `flagLedgerConfirms`=호출 유지·승격 불가(§0 결손 — seen=unknown 기록).
  - `flagVerdict`(1차 설계검증 [보완]): finishVerifyRun ctx에 provider·verifierSession을 분리해
    전달 — 통계 필드의 세션 기록과 사용자 경보 문구("Codex 결론" 고정)를 공급자 중립으로 조건화
    (codex 경로는 기존 문구·바이트 그대로 유지가 인수조건).
  - proof(1차 설계검증 blocker③ 정정 — 저장 키와 메타데이터 혼동 금지): **저장 키는 종전대로
    구현자 세션**(CL-C=구현자 Claude 세션·C-C=구현자 Codex 세션 — verify-guard·durableProofGate가
    이 키로 파일을 찾는다·불변). writeProof 첫 인자는 proof 안의 검증자 세션 '메타데이터'
    (codexSession 필드)이며 두 게이트는 이 필드 값을 해석하지 않는다 — claude에선 이 자리에
    `claude:<session_id||askId>`를 기록(필드명 유지·값만 공급자 표기).
- **세션 lease**: claude 무상태라 대상 없음(우회). ask-active(작업장 단위 동시 1)는 공통 유지.

## 4. 사용자 표면

- 전환 CLI: `node codex-bridge.js verifier-provider [codex|claude]`(현재값 표시/설정 —
  updateContractPatch 경유·계약 잠금 규약 준수). 대시보드 picker는 후속(작은 UI 캠페인) —
  Phase1에서는 대시보드 '자동 보강/검증' 상태 줄에 현재 공급자 라벨만 표시(오해 방지 최소 표면).
- 문서/안내: 공급자=claude일 때 대시보드 대화 뷰·근거의심·연결 세션이 비는 이유를 상태 줄에 1줄
  고지(침묵 결손 금지).

## 5. 시험 계획 (인수조건)

1. **무회귀 1급**: provider 미지정/codex에서 cmdAsk 경로의 출력·부작용이 추출 전과 동일
   (기존 withcontract/evidence/verdict 스위트 전부 초록 + 꼬리 추출 전후 출력 바이트 비교 고정).
2. 가짜 claude 바이너리(CODEX_BRIDGE_CLAUDE_BIN → JSON emit 스크립트)로 e2e: 답 수신→proof 기록→
   판정 판독→기계 지적 블록→예산 예약·회차 표시까지 완주. is_error·비0 종료·JSON 파손=실패 처리.
3. 스냅샷 동결: ask-start 후 계약 provider를 바꿔도 실행은 동결값(worker 경유 e2e).
4. codex 전용 단계 생략: claude 실행에서 evidence-unseen·challenge·링크 기록이 발생하지 않음.
5. 환경 격리: 자식 env에 호스트 훅 변수 부재 단언.
6. C-C 모드에서 claude 공급자 조합(구현자 Codex+검증자 Claude) 스모크.
6-1. **proof 결속 실증**(blocker③): CL-C+claude 실행 후 Stop 게이트(verify-guard)가 proof를
   인정하는 e2e + C-C+claude에서 durableProofGate 인정 e2e(저장 키=구현자 세션 불변의 실증).
6-2. 인용 존재성 검사 유지 실증(2차 설계검증 [보완] — 정본 검사 계약 정합): claude 답이 '실재·유일
   해석 가능한 파일'의 범위 초과 줄을 인용하면 evidence-mismatch 경보 발행. 존재하지 않는 파일은
   정본 계약대로 경보하지 않음(cry-wolf 방지 — tests/evidence.test.js 고정)·다룬 흔적·challenge는
   미발동.
7. doctor·CLI 전환 왕복.

## 6. 위험·한계 (정직 고지)

- claude CLI 런타임 거동(로그인·권한·타임아웃) 미실측 — 구현 첫 단계 스모크가 관문(실패=Phase1
  중단하고 사용자 보고, 우회 구현 금지).
- 무상태라 검증자의 자연어 맥락 연속성 없음 — 왕복이 긴 캠페인에서 재설명 비용 증가(기계 연속성은
  유지). 사용자에게 공급자 특성으로 고지.
- cmdAsk 꼬리 추출은 가동 중 시스템 리팩터 — 시험 1(바이트 동일)이 유일한 안전망이므로 생략 불가.
- 근거의심(evidence-unseen)·근거 재확인이 claude 공급자에서 꺼진다 — 검증 품질 방어층 하나가
  빠지는 트레이드오프를 상태 줄로 상시 가시화.
