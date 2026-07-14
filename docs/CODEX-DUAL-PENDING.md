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
