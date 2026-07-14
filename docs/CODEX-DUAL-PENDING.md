# Codex↔Codex 이원화 — 미완 작업 목록 (다른 로컬 동기화분 · 이어서 구현할 항목)

> 출처: 사용자가 다른 PC(C:\Users\MASTER\Documents\codex-peek)에서 개발한 "Codex↔Codex 이원화"
> (Codex가 검증뿐 아니라 구현자 역할도 하도록 훅 라이프사이클 추가)를 커밋 없이 폴더째 복사→
> D:\codex-peek로 무손실 동기화(2026-07-13, write-tree 56741b74 양쪽 동일).
> **마지막 작업이 미완 상태로 급하게 백업된 것** — 아래는 그 미완 부분에 대한 Codex 사전 점검 지적이다.
> 지금은 정본 그대로 동기화가 우선이므로 **수정하지 않고 보존**한다. 이 이원화 작업을 이어서 할 때 처리한다.

## 컨텍스트
- 신규 파일: bridge/{ask-job-worker,codex-hook,codex-plugin-install}.js, codex-plugin/**,
  src/{codex-hook-health,implementer-auto-pin,implementer-baseline}.ts, .agents/plugins/marketplace.json,
  tests/{ask-active,ask-job,codex-hook-health,codex-plugin-install,harness-mode,implementer-auto-pin,implementer-baseline}.test.js
- 사용자 자신이 명시한 마지막 작업: **"코덱스 훅 설정 경고 관련 문제 수정중"** (아래 #5가 그 지점으로 보임)
- 동기화 시점 상태: tsc 통과·compile·sync-map-core 패리티 OK·전체 테스트 2233단언/0. 즉 타입·테스트는
  통과하지만 아래는 런타임 논리/정책 정합의 미완이다(테스트가 아직 안 잡는 경계).

## 이어서 처리할 지적 (Codex 사전 점검 2026-07-13 — 미완이라 예상된 항목)

### P-1. [중대] links.json 손상 시 자동 훅이 빈 파일로 덮어써 기존 연결·설정 유실
- 위치: bridge/contract-lib.js:433 `try { JSON.parse(readFileSync(LINKS_FILE_SHARED)) } catch { o = {} }`
  → 이후 :474 `atomicWrite(LINKS_FILE_SHARED, JSON.stringify(o))`로 전체 덮어씀.
- 문제: registerCodexImplementer는 codex-hook.js:138의 정상 SessionStart·UserPromptSubmit마다 자동 호출.
  links.json이 손상되면 읽기 실패를 `{}`로 축소→새 구현자 레코드만 담아 기록→다른 워크스페이스 연결·
  verifier 링크·모델/timeout 설정 전부 소실. 다음 사용자 대화가 유실 트리거.
- 이어서 할 것: ENOENT(파일 부재)만 신규 파일로 인정하고, JSON 손상·판독 불가는 fail-closed(기록 거부).
  손상 links.json이 바이트 그대로 보존되는 회귀 테스트 추가.

### P-2. [정책 위반] ask-jobs 내구 작업이 프롬프트·응답 영구 보존하는데 PRIVACY.md는 반대 고지
- 위치: bridge/codex-bridge.js:1104(프롬프트를 ask-jobs/<id>.json의 prompt에 기록),
  ask-job-worker.js:64(응답·오류를 .out/.err에 기록). 자동 삭제 없음 — codex-bridge.js:1159 `ask-job clear`만 삭제.
- 문제: PRIVACY.md:73은 "프롬프트를 디스크에 쓰지 않고 출력 임시파일도 곧 지운다"고 단정, ask-jobs/를 데이터 표에 미열거.
- 이어서 할 것: 보존 정책+자동 정리(또는 명시 삭제 계약) 구현 후 PRIVACY.md 표에 ask-jobs/ 위치·내용·수명 명시.

### P-3. [운영] 신규 Codex 상태 서랍이 TTL 정리·문서화 대상에서 빠짐
- 위치: codex-hook.js:17이 codex-turns/·codex-verify-attempts/·codex-scout-attempts/ 생성.
  contract-lib.js:31의 TTL 정리(maybeCleanupState)가 이 셋을 소비하지 않음 → 세션 수만큼 무기한 누적.
  codex-active/는 30일 정리되나 PRIVACY 표에 미열거.
- 이어서 할 것: 세 서랍 TTL 정리 편입 + PRIVACY 표에 위치·내용(세션/워크스페이스/turn/권한모드 메타)·수명 고지 + TTL 테스트.

### P-4. [내구성] 손상된 내구 job을 건너뛰어 중복 검증 시작 가능
- 위치: codex-bridge.js:1074 activeAskJob이 JSON 판독 실패 무시 → :1101에서 신규 worker 생성 선행조건으로 사용.
- 문제: 실행 중 job 파일 손상·일시 판독 불가 시 "활성 작업 없음"으로 축소→중복 worker 생성 가능.
- 이어서 할 것: 손상 job은 진단 후 신규 생성 차단(내구 작업 계약 정합).

### P-5. [사용자 명시 미완] 훅 경고가 실제 실행 권위를 잘못 지칭 (← "코덱스 훅 경고 수정중"의 지점)
- 위치: codex-plugin-install.js:181(plugin 출처 제외·사용자 hooks.json만 신뢰) vs
  extension.ts:1704/1715("플러그인 발견됐지만 그 훅이 신뢰 안 됨" 안내) vs extension.ts:4915(사용자 실행 훅 표현) 불일치.
- 문제: 사용자가 잘못된 훅을 검토하도록 안내될 수 있음 — 이 부분이 미완(사용자가 수정 중이었다고 명시).
- 이어서 할 것: 플러그인 훅 신뢰 판정과 경고 문구를 실제 실행 권위(사용자 hooks.json 기준)로 일치시켜 완성.

#### P-5 근본 원인 유력 진단 — 확정은 폐루프 재현 대기 (2026-07-13 실측·Codex 검증)
- "구현 훅 미작동" 경고에 대해 현재 증거가 가장 강하게 지지하는 원인: **장기 실행 Codex app-server가
  훅 설치·신뢰 '이전'의 설정 스냅샷을 유지하고, 새 대화도 그 스냅샷으로 훅 엔진을 구성** → 설치·신뢰
  후에도 재시작 전까지 훅 미실행. 최종 인과 확정은 아래 폐루프 절차 성공 후에만 선언한다(추가 재현
  없이 진단을 종결하지 말 것).
- 실측 타임라인(UTC): app-server pid39060 기동 12:00:57(프로세스 CreationDate)·DB 첫 로그 12:03:29 →
  hooks.json 생성 12:04:41 → 신뢰 12:04:59 → 새 테스트 세션 13:09이 같은 pid에서 시작(13:38까지 연속).
- 직접 증거: 새 세션에서 heartbeat(codex-active)·rollout 주입·codex-turns 전부 0.
  보조 증거: 훅 실행 로그 행 0(hook/started·completed 모두 0, hooks/list는 24) — 단 이 버전이 훅 실행을
  반드시 SQLite에 기록한다는 보장은 미확인이므로 0건 단독으로 실행 부재를 증명하지 않음.
- 격리 조건에서 훅 실행 경로 정상: 격리 수동 실행으로 파싱→계약 게이트→heartbeat→컨텍스트 주입 완주.
  (통제 시험이므로 실제 13:09 세션의 계약 상태·Codex 트리거 경로까지 입증한 것은 아님.)
- 설정 UI·대시보드가 훅 4개를 정상 표시한 이유: extension.ts:4860의 hooks/list가 조회 때마다 **별도**
  `codex app-server --stdio` 프로세스를 새로 띄움 → 최신 파일을 읽음. 실행 코어의 갱신 증거가 아님(함정).
- Reload Window로 충분(완전 종료 불필요): OpenAI 확장 판독 결과 app-server는 detached 없는 일반 자식이고
  dispose→teardownProcess→proc.kill. 프로세스 트리 실측도 일치(parent=Code.exe 확장호스트 utility).
- 수정 계약(Codex 합의): ①설치+신뢰 모두 완료 시점에 "Reload Window 필요" 명시 ②안내 버튼에서
  workbench.action.reloadWindow 직접 실행 ③훅 파일·신뢰 해시 세대별 reload-required 상태(불필요한 반복
  재시작 요구 방지) ④설치 후 신뢰가 나중에 완료되는 전이 시점에도 Reload 요구 ⑤extension.ts
  4916·4924·4925·4939·4950의 "시작·재개만 하면 자동 고정" 문구 전부 정정(ko/en).
- 폐루프 확정 절차: Reload 후 새 process_uuid 확인 → 완전히 새 대화 → heartbeat(codex-active)와
  rollout additionalContext 주입 **둘 다** 확인.

#### P-5 원인 3층 확정 + 이 PC 핫픽스 완료 (2026-07-14 폐루프 성공·Codex 검증 통과)
- 폐루프 성공 실측(세션 019f5d0f, 04:58 KST): SessionStart→vscodeUserSession(ok)→pin(ok)→heartbeat
  (ret=true)→규칙 주입 1,577자→turnSaved→PostToolUse 흐름→Stop(sameImplementer=true) 전 체인 완주.
  검증 세션(019ed785)은 vscodeUserSession=false로 구현 역할에서 정확히 배제(설계 의도대로).
- **확정된 3층 원인**:
  ① 리로드 전: 장기 실행 app-server가 훅 설치·신뢰 이전 설정 스냅샷 유지(위 진단 블록) — Reload로 해소.
  ② 훅 명령 비호환(핵심): Codex는 Windows에서 훅을 **감지된 기본 셸(여기선 PowerShell) `-NoProfile
     -Command <command>`**로 실행(폴백만 %COMSPEC% /C). 설치기가 생성한 `"<node절대경로>" "<script>"`는
     PS에서 문자열 나열 = ParserError 즉시 exit 1 → node 미실행·무로그. (cmd /C에서는 동작 — 초기 'cmd도
     실패' 판단은 재현 오류로 정정됨.) sh 계열로 실행하는 Claude Code 훅에서는 같은 형식이 유효해서
     Claude 쪽 패턴을 이식할 때 셸 차이로 깨진 것. 업스트림 근거: 0.144.0-alpha.4 태그 커밋 049586f4의
     core/src/session/session.rs(셸 결속)·shell.rs(PS 인자 생성)·hooks/src/engine/command_runner.rs.
  ③ 제품 결함: hook-setup.ts:30 사전검사가 Windows에서 shell:true(=cmd)로만 검증해 PS 무효 문자열을
     통과시킴 + extension.ts:4783이 `where node` 절대경로를 bare node보다 우선 후보로 사용.
- 이 PC 핫픽스(적용·검증 완료): ~/.codex/hooks.json 4개 훅의 command·commandWindows를
  `node "C:/Users/MASTER/.codex-bridge/codex-hook.js"`로 교체(PS·cmd 양쪽 실측 통과, PATH 3중 확인).
  원본 백업 hooks.json.bak-20260714. 재신뢰+Reload 후 폐루프 성공.
- **제품 수정 잔여(P-5 구현 범위)**: ⓐ codex-plugin-install.js:39·94 명령 생성부를 PS·cmd 양쪽 유효
  형식으로(bare node 우선, 설치 시 양쪽 셸 실검증, PATH 미해소 시 명시 경고) ⓑ hook-setup.ts:30 사전
  검사에 PowerShell 검증 추가 ⓒ 위 수정 계약 ①~⑤(Reload 안내·재신뢰 안내 포함) ⓓ 기존 설치본
  마이그레이션(절대경로 명령 감지 시 교체+재신뢰 유도). 진단용 임시 계측은 원복 완료(배포본=저장소 SHA
  6237959d 일치)·hook-trace 삭제.

### P-6. [신규 2026-07-14] 검증 회수 경로가 proof를 자기무효화 — "검증 미완 · 4라운드" (구현 Codex 실측)
- 발견 경위: 훅 정상화 직후 첫 codex-codex 실전 턴. 구현 Codex는 내구 검증 작업 4개를 모두 성공
  (state=succeeded·exitCode=0, 각 성공 시 proof는 status=success·exit=0으로 기록)했으나, 3회 차단 뒤
  네 번째 proof까지 회수 직후 다시 무효화되어 n=4로 incomplete 종료(대시보드 "검증 미완 · 4라운드").
  Codex 재검증 실측: 마지막 proof 20:18:32.319Z → 회수 도구 호출로 lastActionAt 20:18:33.264Z(proof보다
  0.95초 미래) → Stop 20:18:53.174Z에서 불인정.
- 메커니즘(구현 Codex 분석 + 검증 Codex 라인 대조): 구현 세션이 검증 결과를 회수하는 `ask-wait`를 실행한
  Bash/MCP 계열 도구 호출 자체가 PostToolUse로 잡혀 onTool(codex-hook.js:179-186)에서 s.modified=true·
  lastActionAt=now 갱신 → onStop(:198-211)의 since=max(startedAt, lastActionAt, gitTs)가 proof.ts보다
  항상 미래 → proofOk(:123, proof.ts>=since) 영구 불성립 → bump로 라운드 증가 → MAX_VERIFY_ATTEMPTS(3,
  :20) 초과 시 incomplete. 완료된 ask-wait는 proof를 갱신하지 않음(codex-bridge.js:1123-1143 — 저장된
  out/err만 반환, proof 기록은 답 수신 시점 :1263). 즉 "증명을 가져오는 행위가 증명을 낡게 만드는"
  구조적 결함 — 공식 회수 경로가 자기 자신을 무효화하며, 공식 계약(ask-wait로 회수 후 재판단)을 지키는
  한 코드 변경 없이 성공하는 경로가 없음(검증 Codex 확인).
- claude-codex에서 안 보였던 이유: Claude 쪽 verify-guard.js는 Write/Edit/ExitPlan과 실제 파일 mtime을
  신선도 기준으로 사용하고 읽기 전용 Bash(ask-wait)는 lastActionTs를 올리지 않음(codex-codex 제외 분기
  :156, 도구 판정 :217-220, 파일 mtime 판정 :224-228) — 즉 **동일한 PostToolUse 자기무효화 계약이 없음**
  (Claude에도 재시도 상한·incomplete 경로 자체는 존재하므로 "라운드 게이트 없음"이 아니라 이 계약 차이가
  정확한 구분).
- 수정 방향(설계 필요): 검증 회수 도구 호출(codex-bridge.js ask-start/ask-wait)을 modified·lastActionAt
  갱신에서 제외하거나, proof에 turnId를 결속해 신선도를 시간이 아닌 턴 단위로 판정. + 공식 전체 흐름
  (구현 턴→ask→proof→Stop 통과) 통합 회귀 테스트 부재도 확인됨(harness-mode.test.js:63·ask-job.test.js:30
  범위 밖) — 테스트 추가 필수.
- incomplete 해제는 성공이 아님: 4라운드 초과로 차단만 풀린 상태이므로 이 결함 수정 전 codex-codex
  모드의 "모든 턴 검증" 보증은 미완.

### P-7. [신규 2026-07-14·업스트림 — 수정판 존재] 훅 차단 피드백이 대화 이어가기를 오염 — invalid_id_prefix
- 증상: 과거에 Stop 훅 차단이 발생했던 Codex 대화를 이어가면 API가 `[input[N].id] [invalid_id_prefix]
  Expected an ID that begins with 'msg'`로 거부, 대화 진행 불가(이번 사례는 재개 과정에서 발현 — 단 결함의
  본질은 '접두사 없는 과거 id를 outbound 입력에 다시 붙이는 것'이라 재기동이 필수 조건은 아님).
- 실측(rollout 019f5d0f): 오염 항목은 정확히 3건(37·172·261행) — 전부 Stop 차단 사유
  (`<hook_prompt hook_run_id="stop:...">`)를 담은 response_item(type:message, role:user)에 **UUIDv7 id**.
  전체 response_item 219건 중 msg_ 31·UUID 3·무id 77·기타 정상 접두(rs_/fc_/ctc_) 108. 런타임 로그에도
  같은 UUID로 input[23]·input[25] 거부 2건 실재. **우리 훅은 {decision:"block", reason}만 출력 — id 부여는
  업스트림(0.144.0-alpha.4 items.rs build_hook_prompt_message가 new_item_id()=UUIDv7 사용).**
- **업스트림 확정**: 공개 이슈 openai/codex#20783 = 동일 증상. PR #32312(커밋 c9d52de)로 수정 — 새 hook
  prompt에 msg_ id 발급 + 기존 접두사 없는 id는 요청 직전 제거. **rust-v0.145.0-alpha.5 릴리스에 포함.**
- 대응 순서(확정): ①즉시 우회=새 대화(구 코어에 머무는 동안) ②근본=수정 포함 코어로 교체 — 실측(2026-07-14):
  새 확장 26.707.71524(코어 0.144.2)가 설치됐지만 실행 3프로세스는 전부 구 확장(0.144.0-alpha.4)에서 구동 중 —
  **'확장 다시 시작'(또는 Reload)으로 프로세스를 교체해야 새 코어가 로드됨**(디스크의 새 바이너리는 자동 교체
  안 됨 — VS Code 일반 활성화 경계, 하네스가 추가한 요구 아님). 0.144.2에 #32312 수정이 backport됐는지는
  미확정 — Reload 후 새 rollout session_meta.cli_version 확인+Stop 차단 다음 입력으로 실검증 필요(수정 확정
  릴리스는 rust-v0.145.0-alpha.5) ③수동 JSONL 수술(구조적 파싱으로 message의 접두사 없는 payload.id만
  제거·백업+코어 종료 중 한정)은 갱신 불가·수정판 재현 시에만 최후 수단. Responses API 스키마상 입력 메시지
  id는 필수 아님(형식적 타당성 확인됨).
- P-6(8a944af)은 반복 차단으로 인한 오염 '빈도'를 크게 줄이지만, 정당한 차단도 hook prompt를 만들므로
  0.144.0-alpha.4에 머무는 한 직렬화 결함 자체는 남는다(P-7의 해결은 코어 갱신).

### P-6b. [신규 2026-07-14·P-6 첫 라이브에서 발견] 확장 자동 고정이 훅과 세대 경합 — 동결 거부(turn-before-link)
- 증상: 새 C-C 대화에서 ask-start가 '구현 컨텍스트 동결 실패(turn-before-link)'로 거부 → 검증 시작 불가 →
  Stop 차단(proof-missing) → (0.144.0-alpha.4에선 P-7 오염까지 연쇄).
- 실측 사건 순서(검증 Codex 정정 반영): ①UserPromptSubmit 훅 성공 — 턴 상태 02:25:39.421 기록(raced 아님)
  ②rollout 사용자 메시지 02:25:39.635 ③**확장 same-session 자동 고정**(extension.ts:1863-1864)이 그 프롬프트
  시각으로 implementerRevision+1·implementerEventAt 전진 → ④ask-start(02:25:55) 시점 이미
  eventAt>turn.startedAt → turn-before-link 거부. ⑤이후 eventAt이 02:27:05.607(=Stop 차단 쪽지 시각)로 또
  전진 — **rollout 스캐너(rollout-scan.ts:174)가 `<hook_prompt>` 차단 피드백을 일반 사용자 프롬프트로 오인**
  (extension.ts:570 isInjected가 hook_prompt 미제외). 현재 링크: sid 019f5e71·rev 20·src rollout-user-prompt.
- 근본: 같은 세션의 세대(revision·eventAt) 기록원이 둘(훅 pin+확장 자동 고정). job 실행 중 자동 고정이
  revision을 올리면 writeProof 재검사 stale-role 실패도 가능.
- 수정 계약(확정, 3항): ①자동 고정 same-sid 분기=관측 갱신만(implementerLastSeenAt) — revision·eventAt·
  roleRevision 불변(세대 전진은 '다른 세션 교체'와 훅 pin에만, ABA 검출은 다른-세션 분기가 담당하므로 보존.
  두뇌 drift는 model/effort만 사용해 무영향) ②isInjected에 `<hook_prompt(\s|>)` 제외 추가 — 차단 피드백이
  자동 고정·스캔 신호로 오인되지 않게 ③잔여 경합(다른 세션 첫 프롬프트에서 확장 fallback vs 훅 동시 교체 —
  fallback을 훅 heartbeat 확인 뒤로 지연 또는 단일 등록 계약으로 통합)은 테스트로 노출 후 처리.
  HANDOFF의 'rollout 보조 고정도 두 revision 증가' 계약 문구도 함께 갱신할 것.

### P-8. [신규 2026-07-14·설계 진행 중] 체크리스트 강제 체크박스 저장 안 됨 — 계약 저장 구조 재설계
- 증상(사용자): C-C 모드에서 '체크리스트 강제' 체크박스를 바꾸고 저장해도 반영 안 됨.
- 원인(검증 확정): 체크박스는 세그(curVM)와 달리 초안 상태가 없어, 대화 중 수시 도착하는 state 푸시가 저장
  클릭 전에 DOM을 계약값으로 되돌림 → 옛값이 저장됨. 웹뷰 임시 수정 시도 2회(단일 초안·소유권 결속)는 검증이
  반례(언어 전환 시 webview.html 통째 재생성으로 웹뷰 메모리 전멸[extension.ts:2897]·전역 기준선 무음 소실·
  지연 응답·TOCTOU)로 기각 — **웹뷰에 지속 상태를 두는 설계 자체가 불가**.
- **사용자 구조 원칙(2026-07-14 지시·설계 전제)**: 계약은 프로젝트×언어(ko/en)×운용모드(claude-codex/
  codex-codex)별 분리가 기본, 3트랙(정찰) 관련 부분만 공용.
- 확정 방향(v4~v6 설계 왕복·중심 아이디어는 검증 인정): **토글=즉시 저장 + 호스트가 잠금 안에서 재읽기·해당
  필드만 patch + 계약 파일이 유일 정본(웹뷰 무상태)**. 공용 updateContractPatch(ws,lang,patch)로 전 작성자
  통일(전체저장[dirty 필드만·체크리스트 제외]·모드[harnessMode 1필드]·정찰대상·scope-target.js·scope-gate.js·
  체크박스). 무폴더 창은 CONTRACT_FILE 폴백·잠금 키=최종 절대경로. 잠금=신설 계약 파일 전용 fail-closed 잠금(v7~v9 확정): wx 선점+read-back fence, **자동 stale 회수 없음**(자동 경로에서 복원 rename이 사라져 해당 ABA 시나리오가 자동 운영에서 제거 — 수동 승인 경로의 잔여 간극은 P1 §5 동형 보장수준으로 명문화), 잠금 상태는 P1 5합타입+absent(alive/dead-valid/invalid/unreadable/owner-unverified/absent) — 정상JSON+ESRCH만 dead-valid·EPERM=alive·**JSON 파싱 실패=invalid**(P1 형식불명 동형)·fs 읽기 실패=unreadable·판정 중 ENOENT=absent(정상 해제 경합)=즉시 재획득 재시도, 복구는 상태별 승인 사다리만: dead-valid=1클릭 [잠금 정리](토큰 재확인·오탈취 즉시 복원)/invalid·owner-unverified=2단 명시 승인 모달(P1 --confirm 사다리 동형·격리 직전 상태 재판정)/unreadable=격리 금지·조사 안내만(토큰 재확인 불가=오탈취 방지 불가). stale-* 격리물은 TTL 청소(활성 잠금 절대 sweep 금지). 확장 호스트는 비동기 재시도(동기 루프로 호스트 블록 금지)·CLI는 동기 짧은 재시도. fence~쓰기 간극은 P1 §5 동형 보장수준 명문화. saveResult에 field·lang·mode 결속(웹뷰 DOM data-lang/mode
  일치 시만 인라인 표시). 필드별 단일-flight(응답까지 그 박스만 disabled)·호스트 전체 try/catch·최초 렌더 전
  disabled·즉시저장 aria-live 표시·저장버튼 문구를 규칙·세그 전용으로 정정.
- 검증 이력: 진단 1회+수정 검증 2회 실패(웹뷰 상태 접근)+설계 v4(방향 인정)·v5(잠금 차단)·v6(funlock 패턴 —
  판정 대기/진행. 스크래치 /tmp/v-ckbug·v-ckfix·v-slotdesign·v-slotv2·v-v3·v-v4·v-v5.txt).
- 테스트 계약(검증 제시분 채택): 잠금 미획득 시 callback 미실행·죽은 잠금 회수 ABA·2프로세스 동시 patch
  (체크박스 vs 전체저장/CLI)·무폴더 창·HTML 재생성 후 타 슬롯 결과 표시 금지·양 체크박스 동시 저장·손상 JSON
  불변·호스트 예외 시 재활성화+재렌더.

## 처리 원칙
- 위 항목들은 이원화 작업 이어서 할 때 각각 [설계→구현→테스트→Codex 검증→커밋] 루프로 처리.
- P-5(훅 경고)가 사용자 마지막 작업이므로 우선 착수 후보. P-6은 codex-codex 실사용 차단급이라 P-5 제품
  수정과 같은 묶음으로 처리 권장.
- 동기화 자체는 무손실 완료(정본 그대로) — 위 항목은 정본의 미완 상태를 그대로 반영한 것이지 동기화 오류가 아니다.

## 보완(비차단·나중에 확인 후)

### N-1. 검증 대기시간 대시보드 문구 정밀화 (기능 정상·표현만)
- 위치: src/extension.ts:3385 "실제 내구 검증 작업의 deadline — 입력한 시간 그대로 대기".
- 사실: 검증 대기시간 수정 자체는 완성·정상 반영됨(실행 브리지까지 SHA 동일·저장값 그대로 적용·
  Math.min은 '작업 생성 시점부터 설정 시간까지' 절대 deadline 계약으로 조기 절단 아님 — Codex 실측 확인).
- 다만 표현: "입력한 시간 그대로 대기"는 최소 대기시간으로 오해될 여지. 실제는 "입력한 시간만큼 최대 실행
  허용"(검증이 빨리 끝나거나 오류면 즉시 종료가 정상)이 더 정확.
- 이어서 할 것(사용자 확인 후): 문구를 "입력한 시간만큼 최대 실행 허용" 취지로 좁힘(ko/en 쌍). 지금은
  사용자 정본 문구라 동기화 무손실 우선으로 미변경.
- 테스트 보완 여지: 짧은 테스트용 deadline으로 실제 장기 자식을 종료시키는 elapsed-time 회귀 테스트 추가
  (현재 구현엔 조기 절단 경로 없음 — Codex 확인·방어 목적).
