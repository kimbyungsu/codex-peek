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

### P-1. [해결됨 2026-07-15] links.json 손상 시 자동 훅이 빈 파일로 덮어써 기존 연결·설정 유실
- 위치: bridge/contract-lib.js:433 `try { JSON.parse(readFileSync(LINKS_FILE_SHARED)) } catch { o = {} }`
  → 이후 :474 `atomicWrite(LINKS_FILE_SHARED, JSON.stringify(o))`로 전체 덮어씀.
- 문제: registerCodexImplementer는 codex-hook.js:138의 정상 SessionStart·UserPromptSubmit마다 자동 호출.
  links.json이 손상되면 읽기 실패를 `{}`로 축소→새 구현자 레코드만 담아 기록→다른 워크스페이스 연결·
  verifier 링크·모델/timeout 설정 전부 소실. 다음 사용자 대화가 유실 트리거.
- ~~이어서 할 것~~ **(완료 2026-07-15·검증 2왕복 통과[보완 반영])**: 같은 형상 기록자 3곳 전부 수정 —
  ①registerCodexImplementer: ENOENT만 신규, 판독 실패=links-unreadable·파싱/의미 실패=links-corrupt(기록 거부)
  ②bridge updateLinks ③확장 updateLinks(동형). 의미 검증 포함(null·배열·원시값 루트, byWorkspace/bySession
  타입 위반도 거부 — 구문 검사만으론 {}로 축소됨). +spawn 전 관문 requireLinksWritable(cmdAsk·cmdAskStart —
  손상 상태에서 autoNewFailed·stale 제거 반복 실패→새 세션 폭증 차단)·훅 안내에 원인/복구 절차 명시·
  saveLinks export 봉인(단일 관문=updateLinks). 테스트 links-cas [P-1] 33단언(구문·의미 7종×2경로·게이트
  3종·EACCES monkey-patch). 후속 후보: cmdLink exit code 정밀화·확장 파서 공용 함수화.

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

### P-5. [제품 수정 완료 2026-07-15] 훅 경고가 실제 실행 권위를 잘못 지칭 (← "코덱스 훅 경고 수정중"의 지점)
- **제품 수정 구현(2026-07-15) — 잔여 ⓐ~ⓓ 전부**:
  ⓐ 설치기 dual-shell: codex-plugin-install.js에 nodeTokenRunsInShell/nodeTokenDualShellOk 신설 —
    win32는 PowerShell(-NoProfile -Command)과 cmd '양쪽 실검증' 통과 토큰만 hooks.json에 기입.
    확장 installCodexUserRuntimeHooks는 bare node를 첫 후보로 resolveNodeTokenDual 사용(절대경로 우선
    후보 결함 제거), 미해소 시 명시 경고("PATH의 node가 PS·cmd 양쪽에서 실행되지 않습니다").
  ⓑ hook-setup.ts 사전검사에 shellRunsNodePowerShell·resolveNodeTokenDual 추가(기존 shellRunsNode는
    cmd 경유라 PS 무효 문자열 통과 — 실측 단언으로 고정).
  ⓒ UX 계약 ①~⑤: ①설치·신뢰 완료 문구에 '창 리로드 후 반영' 명시 ②'지금 리로드' 버튼이
    workbench.action.reloadWindow 직접 실행 ③창 로드 시 hooks.json sha1 세대 캡처, 같은 세대엔 1회만
    권고(codexHookReloadPromptedGen) ④모든 신뢰 조회가 observeCodexHookTrustForReload를 거쳐 '미준비→
    준비' 전이 시에도 권고 ⑤"시작·재개만 하면 자동 고정" 계열 문구에 신뢰+리로드 조건 명시(ko/en),
    hooks-untrusted 경보 주어를 사용자 hooks.json(실행 권위)으로 정정.
  ⓓ 마이그레이션: codexPeekHookCommandNeedsMigration/detectCodexPeekHookMigration — 우리 훅인데 명령이
    따옴표 절대경로 시작(PS 즉사 옛 형식)이면 자동 제안·설치 흐름 두 입구에서 교체 제안(소유 표식 없으면
    자동 교체 금지·수동 안내), 교체 후 재신뢰+리로드 안내.
  +창로드 오경고: 활성화 자동 진입(auto)에서 신뢰 조회 실패(10s 타임아웃·app-server 오류)는 '미신뢰
    사실'이 아니므로 재신뢰로 오도하는 팝업을 띄우지 않음 — fail-closed는 유지(대시보드 경보·ob4 미확인
    표시 지속). 조회 실패/확인된 미신뢰 문구 분리+'다시 확인' 버튼.
  +2·3차 반영(Codex 검증 반박 수용): ①마이그레이션 검사를 두 진입점 '최선행'으로(플러그인 상태·installed
    4/4 판정보다 앞) — 플러그인 부재·부분 legacy(4개 미만)·무표식 전부 일반 설치 모달(소유권 인수+자동
    재기입)에 도달 불가, owned/unowned 분기는 offerCodexHookMigration 내부(무표식=수동 안내만) ②동시성 —
    running Promise+명시 요청 큐: auto 조회 중 온 명시 진입(모드 클릭)은 종료 후 재실행(유실 없음), auto만
    창당 1회 latch·명시 진입은 latch 무관, auto 조회 실패는 무팝업+latch 해제 ③문구: 재확인 성공은 '설정상
    신뢰 확인·현재 코어 반영은 리로드 후'(hooks/list는 별도 프로세스 — runnable 단정 금지), C-C 모드 클릭
    안내·구현 미고정 경보에 훅 설치·신뢰·리로드 선행조건 명시 ④writer 불변조건 —
    installCodexPeekUserHooks가 따옴표 시작/빈 토큰을 구조적으로 거부(어떤 직접 호출자도 PS 즉사 형식을
    기입 불가; 실셸 dual 검증은 해석기 몫) ⑤신뢰 재전이 — ready→unready→ready 전이마다 권고.
  +4차 반영: 큐·리로드 세대의 순서 계약을 순수 상태기 2종(createCodexHookOfferGate·
    createCodexHookReloadTracker — bridge/codex-plugin-install.js, vscode 무의존)으로 분리, 확장은 판정만
    소비. 테스트 tests/p5-hook-command.test.js가 '같은 팩토리'를 직접 구동해 순서 반례를 실행 검증(자동 중
    명시 진입 큐→1회 재실행·auto 1회·조용 실패 후 재시도·최초 ready 무권고·재신뢰 전이별 권고·같은 세대
    중복 금지·조회 실패 무시)+PS 실셸 실측(절대경로 토큰 cmd 통과·PS 탈락)+writer 거부·파일 바이트 불변
    실행 검증. 남는 한계(정직): vscode 창·알림과의 최종 결선은 배선 잠금(정규식) — 판정 로직 자체는 전부
    실행 검증됨. unowned 수동 안내 분기는 offerCodexHookMigration 내부 소스 잠금.
- (해결됨 2026-07-15) 위치였던 곳: codex-plugin-install.js(plugin 출처 제외·사용자 hooks.json만 신뢰) vs
  extension.ts 경고 문구("플러그인 발견됐지만…") 불일치 — hooks-untrusted 경보·신뢰 안내의 주어를 전부
  '사용자 훅(hooks.json)=실행 권위'로 정정(아래 구현 단락 ⑤·2차 반영 ③). 옛 기록: 사용자가 잘못된 훅을
  검토하도록 안내될 수 있었음(사용자 수정 중 미완 지점이었음).
- ~~이어서 할 것: 플러그인 훅 신뢰 판정과 경고 문구를 실제 실행 권위(사용자 hooks.json 기준)로 일치시켜 완성.~~ (완료 2026-07-15 — 아래 제품 수정 구현 단락 ⑤·2차 반영 ③)

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
- **(당시 기록 — 현재 전부 구현 완료, 위 구현 단락 참조) 제품 수정 잔여(P-5 구현 범위)**: ⓐ codex-plugin-install.js:39·94 명령 생성부를 PS·cmd 양쪽 유효
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

### P-8. [1단 구현 완료 2026-07-15 · 2단 백로그(설계 동결 v10)] 체크리스트 강제 체크박스 저장 안 됨 — 계약 저장 구조 재설계
- **1단 구현(2026-07-15)**: 토글=즉시 저장(webview change→saveChecklist)+호스트 재읽기-단일필드 병합
  (contract-lib patchContractFields — 손상 JSON fail-closed[P-1 교훈]·부재만 신설), 큰 저장(rolePatch·웹뷰
  페이로드)에서 체크리스트 4필드 전면 제외(되돌린 화면값이 버튼 저장에 실리는 재발 경로 차단), 상태 푸시는
  pending 중 체크박스 불변(증상의 구조 제거). **응답 수명은 순수 상태기 ckMachine**(웹뷰 [P8-CKM-BEGIN/END],
  테스트가 추출·실행): 요청=문서nonce+카운터 reqId·field·lang 서술자, 응답은 서술자 전부 일치 시에만 소비
  (불일치=완전 무시 — single-flight 탈취 불가), **성공이라도 소비 시점의 화면 좌표(모드 기대 field·언어)와
  다르면 commit 금지=hold**(옛 모드/언어 값이 새 화면 기준선 오염 금지), 실패·staleMode 거부·5초 만료도
  hold — hold는 재활성·되돌림 없이 disabled 유지+ready로 정본 state 요청, 값·재활성은 state 채움(fill)만
  담당(15초 주기 state도 복구 경로 — 영구 disabled 없음). 모드 전환 직후 옛 화면 토글은 호스트 렌더 모드
  결속으로 기록 거부(fail-closed·모드 누락도 거부)+재렌더, 모드 클릭~state 사이 ckModeLock 입력 잠금.
  **프로젝트×언어 독립(사용자 추가 요구)**: 창=자기 dashboardWorkspace 앵커·파일=(프로젝트×언어)·재읽기-병합은
  '완료된 선행 저장'을 보존(순차 멀티창 안전). **잔존 한계(정직·2단 잠금이 해소)**: 잠금이 없어 진짜 동시
  저장(읽기-읽기 겹침)은 서로 다른 필드끼리도 유실 가능. 테스트 tests/p8-checklist.test.js — 계약 도우미
  실동작+배선 잠금+**상태기 순서 반례 실행**(모드 경합 skip→hold→fill·성공×모드변경 대칭·유실→만료→복구·문서
  세대 재사용).
- 증상(사용자): C-C 모드에서 '체크리스트 강제' 체크박스를 바꾸고 저장해도 반영 안 됨.
- 원인(검증 확정): 체크박스는 세그(curVM)와 달리 초안 상태가 없어, 대화 중 수시 도착하는 state 푸시가 저장
  클릭 전에 DOM을 계약값으로 되돌림 → 옛값이 저장됨. 웹뷰 임시 수정 시도 2회(단일 초안·소유권 결속)는 검증이
  반례(언어 전환 시 webview.html 통째 재생성으로 웹뷰 메모리 전멸[extension.ts:2897]·전역 기준선 무음 소실·
  지연 응답·TOCTOU)로 기각 — **웹뷰에 지속 상태를 두는 설계 자체가 불가**.
- **사용자 구조 원칙(2026-07-14 지시·설계 전제)**: 계약은 프로젝트×언어(ko/en)×운용모드(claude-codex/
  codex-codex)별 분리가 기본, 3트랙(정찰) 관련 부분만 공용.
- **처리 방침(사용자 확정 2026-07-14) — 2단**: [1단·즉시] 최소 수정: 토글=즉시 저장+호스트가 계약 재읽기 후 해당 필드만 병합(잠금 없음=기존 작성자들과 동급 신뢰 수준 — 동시 저장 lost-update 잔존은 알려진 한계로 명시, 사용자 증상[되돌림]만 구조 제거) [2단·백로그] 아래 확정 설계(전 작성자 통일+잠금). 아래는 2단의 정본 설계다.
- 확정 방향(v4~v10 설계 왕복·잠금 계약 v10에서 구현 가능 수준 판정): **토글=즉시 저장 + 호스트가 잠금 안에서 재읽기·해당
  필드만 patch + 계약 파일이 유일 정본(웹뷰 무상태)**. 공용 updateContractPatch(ws,lang,patch)로 전 작성자
  통일(전체저장[dirty 필드만·체크리스트 제외]·모드[harnessMode 1필드]·정찰대상·scope-target.js·scope-gate.js·
  체크박스). 무폴더 창은 CONTRACT_FILE 폴백·잠금 키=최종 절대경로. 잠금=신설 계약 파일 전용 fail-closed 잠금(v7~v9 확정): wx 선점+read-back fence, **자동 stale 회수 없음**(자동 경로에서 복원 rename이 사라져 해당 ABA 시나리오가 자동 운영에서 제거 — 수동 승인 경로의 잔여 간극은 P1 §5 동형 보장수준으로 명문화), 잠금 상태는 P1 5합타입+absent(alive/dead-valid/invalid/unreadable/owner-unverified/absent) — 정상JSON+ESRCH만 dead-valid·EPERM=alive·**JSON 파싱 실패=invalid**(P1 형식불명 동형)·fs 읽기 실패=unreadable·판정 중 ENOENT=absent(정상 해제 경합)=즉시 재획득 재시도, 복구는 상태별 승인 사다리만: dead-valid=1클릭 [잠금 정리](토큰 재확인·오탈취 즉시 복원)/invalid·owner-unverified=2단 명시 승인 모달(P1 --confirm 사다리 동형·격리 직전 상태 재판정)/unreadable=격리 금지·조사 안내만(토큰 재확인 불가=오탈취 방지 불가). stale-* 격리물은 TTL 청소(활성 잠금 절대 sweep 금지). 확장 호스트는 비동기 재시도(동기 루프로 호스트 블록 금지)·CLI는 동기 짧은 재시도. fence~쓰기 간극은 P1 §5 동형 보장수준 명문화. saveResult에 field·lang·mode 결속(웹뷰 DOM data-lang/mode
  일치 시만 인라인 표시). 필드별 단일-flight(응답까지 그 박스만 disabled)·호스트 전체 try/catch·최초 렌더 전
  disabled·즉시저장 aria-live 표시·저장버튼 문구를 규칙·세그 전용으로 정정.
- 검증 이력: 진단 1회+수정 검증 2회 실패(웹뷰 상태 접근)+설계 v4(방향 인정)·v5(잠금 차단)·v6(funlock 자동회수 — P1 잔여간극으로 기각)·v7(자동 회수 포기=자동 경로 ABA 제거)·v8(복구 사다리)·v9(5합타입)·v10(absent·파싱실패=invalid·읽기실패=unreadable 확정 — 잠금 설계 구현 가능 수준 판정. 스크래치 /tmp/v-ckbug~v-v10.txt).
- 테스트 계약(검증 제시분 채택): 잠금 미획득 시 callback 미실행·죽은 잠금=fail-closed+상태별 수동 사다리(1클릭=dead-valid만·invalid/owner-unverified=2단 승인·unreadable=격리 금지·absent=재획득)·수동 복구 경합(정리 중 새 잠금=중단·복원)·2프로세스 동시 patch
  (체크박스 vs 전체저장/CLI)·무폴더 창·HTML 재생성 후 타 슬롯 결과 표시 금지·양 체크박스 동시 저장·손상 JSON
  불변·호스트 예외 시 재활성화+재렌더.

### P-9. [신규 2026-07-15] 상태바 진행표시(phase)가 모드 불일치·구동 주체 소멸 시 고아로 잔존
- 증상(사용자 2회 관찰): ①대시보드=코덱스-코덱스인데 실제 대화는 Claude에서 진행 → 상태바가 '반영중'에서
  멈춤 ②과거 C-C에서 '검증 미완'도 같은 상태바 표면에 잔존해 보임(단 메커니즘은 다름 — 아래 원인 범위
  보정 ② 참조: 고아가 아니라 의도적 종료 경고).
- 메커니즘(실측 확인): phase.json은 '마지막 기록자' 파일이고 전이는 모드별 훅이 담당 — claude-codex에선
  contract-inject(UserPromptSubmit)→작업중 / ask 답 수신(codex-bridge)→반영중 / verify-guard(Stop)→완료·미완.
  그런데 contract-inject(:64)·verify-guard(:156)는 **C-C 모드면 즉시 종료**하므로, 모드=C-C인데 실제 구동이
  Claude면 ask가 쓴 '반영중' 뒤를 아무도 갱신 못함(구현 훅은 Codex 대화가 없어 침묵) → 화면 고아.
  실측: 모드를 claude-codex로 되돌리고 다음 프롬프트를 보내는 순간 contract-inject가 '작업중'으로 자가 복구
  (12:15 모드 복귀→12:17:54 active 기록으로 확인. 단 phase.json은 마지막 기록자 단일 파일이라 그 시점
  원문 바이트는 이후 검증 작업이 덮어써 독립 재확정은 불가 — 훅 실행·복구 경로는 코드 순서·active로 뒷받침).
- **원인 범위 보정(검증 지적 수용)**: 이 잔존은 모드 불일치 전용이 아니다.
  ①정상 C-C 대화에서도 성공 proof가 인정된 Stop은 codex-hook.js(:228)가 `done`이 아니라 다시 '반영중'
  (rejudging)을 기록 — 이후 새 구현 프롬프트가 없으면 모드 불일치 없이도 같은 '반영중' 잔존 발생.
  모드 전환 초기화·기록 모드 비교만으론 이 경로는 못 잡음(성공 Stop→done 종결 전이 계약 별도 검토 필요).
  ②과거 C-C '검증 미완'(incomplete)은 고아가 아니라 codex-hook.js(:230)가 재시도 소진 후 **의도적으로
  남긴 종료 경고** — 초기화 정책에서 rejudging 고아와 분리 보존해야 함(무조건 지우면 실제 미검증 경고 소실).
  ③영구 잔존은 아님: extension.ts(:62, :1289~1291)가 오래된 phase를 자동 숨김 —
  상한 max(15분, verifyTimeoutMin+5분)=현 설정 25분. 즉 '최대 약 25분 고아처럼 표시'가 정확한 서술.
- 부수 확인(정직 고지): 모드=C-C 동안 Claude 턴은 verify-guard가 서 있지 않아 강제 게이트 없이 진행됐고
  (프로토콜은 수동 준수·검증은 전부 수행됨), proof는 잔재 구현 세션(019f5eac) 키로 적립됨 —
  **결과물 손상은 확인되지 않았으나 강제 게이트 보장은 상실됐고 stale 구현 세션에 proof 상태가 기록됐다**
  (하네스 강제 공백+표시 고아+proof 오귀속의 삼중 증상. "기능 피해 없음"은 과장이라 이 표현으로 정정).
- 수정 후보(미착수): ①모드 전환(setHarnessMode) 시 phase 초기화 — 단 incomplete 경고는 보존 정책 분리
  ②phase에 기록 모드·주체 저장, 대시보드가 현재 모드와 불일치하면 회색 처리 — 기존 25분 자동 숨김과의
  관계(그 이전 구간을 커버) 명시 ③정상 C-C 성공 Stop의 rejudging→done 종결 전이 계약 검토
  ④'모드=C-C인데 구현 heartbeat 없음+Claude 활동 감지' 어긋남 힌트. 최소=①+②(①도 표시 phase 전이를
  추가하는 것이긴 하나, 검증 게이트·Stop 전이 계약은 무변경이라는 뜻. 단 ③은 별도 항목으로 남음).
- **사용자 제안 검토(2026-07-15, Codex 2왕복 — 방향 채택·원안 그대로 구현은 불가 판정)**:
  제안 = "기준점은 사용자가 어디(Claude/Codex)에서 질문을 시작했는가 + 그 모드의 검증 꺼짐 여부.
  옵션 모드와 실제 질문 호스트가 어긋나면 경고 후 해당 호스트의 모드로 강제 전환"(4사례).
  - 채택(방향): 모드 불일치 계열에 한해 근원해결 방향 맞음 — 표시 땜빵이 아니라 원인(모드≠실호스트)을
    제거하며, 검증이 켜진 경우 게이트·표시·proof 귀속을 원인 층에서 복원. contract-inject(:64)·
    codex-hook(:248)의 '즉시 종료'를 '판별→안전 전환→정상 진행'으로 바꾸는 위치도 실현 가능.
  - 한정 1: '반영중' 잔존 전체의 근원해결은 아님 — 정상 C-C 성공 Stop의 rejudging 종결(위 보정 ①,
    후보 ③)은 불일치 없이 발생하므로 독립 수정 필수. incomplete 경고 분리 보존도 그대로 필요.
  - 한정 2: 후보 ①②④는 '대체'가 아니라 '보완재로 축소 유지' — 자동 전환이 보류·실패하는 경로와 수동
    대시보드 전환이 남는 한 provenance·불일치 표시·경고는 여전히 복구/진단 수단(제안의 '경고 알림'은
    ④의 구체화).
  - 전제 정정: 사례 ③④가 전제한 '모드별 검증 꺼짐'은 현 스키마에 없음 — verifyMode는 프로젝트×언어
    슬롯당 단일(contract-lib.js:833~857). 단일 유지 시 ③④는 '전역 off'로 합쳐져 자동 충족(off면 어느
    모드로 전환돼도 검증 안 돎). 모드별로 서로 다른 on/off를 기억하려면 스키마·UI·마이그레이션 분리가
    필요(선행조건 아님 — 사용자 요구 확정 시에만).
    **→ 결정 확정(2026-07-15 사용자): 분리한다.** 근거: 규칙이 이미 모드별 4슬롯(claude/codex/
    codexImplementer/codexVerifier, contract-lib.js:822~827)·체크리스트 4필드(:829~832)로 별개이듯 검증
    스위치도 모드별이 맞다 — '모드별 분리 기본' 구조 원칙과 일치. 단일 verifyMode가 오히려 스키마의 예외.
    설계 방향(미착수 — Codex 설계검증 2왕복 반영):
    ⓐ 필드: 기존 `verifyMode`=CL-C 슬롯 유지(레거시 무회귀), 신규 `codexVerifyMode`=C-C 슬롯.
    ⓑ fallback: `codexVerifyMode`가 유효값이면 그것, 아니면 **normVerifyMode(o) 전체를 재사용**(원시
      o.verifyMode 폴백 금지 — 구형 `verify:true→code` 호환이 contract-lib.js:853·extension.ts:259에
      있어 원시 폴백이면 구계약의 C-C가 off로 회귀). 전례=codexVerifier 규칙(contract-lib.js:824~827).
    ⓒ 마이그레이션(표현 한정): 벌크 파일 마이그레이션 불필요. 단 신규 필드 부재 동안 C-C는 CL-C 값
      '상속 중'인 과도 상태(CL-C 변경이 C-C 실효값도 바꿈)이며, 최초 C-C 저장에서 `codexVerifyMode`를
      물질화해야 독립. **물질화 계약 확정: 계약 파일에 '정규화된 전체 객체 재직렬화'를 금지하고 모든
      저장을 모드별 exact patch로 바꾼다.** ⑴모드 전환 저장=`harnessMode`만 patch(신규 필드 부재 보존)
      ⑵CL-C 일반 저장=`claude/codex/claudeInjectMode/verifyMode`(+공용 필드 허용목록)만 기록 ⑶C-C 일반
      저장=`codexImplementer/codexVerifier/codexInjectMode/codexVerifyMode`(+공용 허용목록)만 기록 —
      `codexVerifyMode`는 ⑶에서만 물질화. **공용 허용목록 확정: 일반 저장에 함께 실리는 공용 축은
      `scoutMode`뿐(extension.ts:2731). `harnessMode`는 전환 patch 전용, 체크리스트 4필드는 즉시 저장
      경로(P-8 1단) 소유, `scoutRepo/scoutGate` 등 타 작성자 소유 필드는 건드리지 않고 보존** — 허용목록을
      구체 명시해 exact patch가 전체 쓰기로 되넓어지는 것을 차단. 근거: 모드 변경(extension.ts:2577~2580)뿐 아니라 **일반 저장도**
      `loadContract` 결과 전체를 전개해 재저장(:2713·2726~2728, saveContract `...c` :457~465)하므로,
      실효 fallback 값이 CL-C 저장만으로 원시 필드에 기록되는 누출이 있음(설계검증 3차 지적 1).
      구현 수단: patchContractFields는 ws 필수(contract-lib.js:242)라 무폴더 창의 레거시 CONTRACT_FILE
      경로(saveContract(null,...) 지원, extension.ts:457)가 회귀함 — CONTRACT_FILE fallback을 포함한
      확장 전용 exact patch 또는 helper 확장이 필요(3차 지적 2).
    ⓓ 소비처(런타임): C-C 게이트 codex-hook.js:96·221 / 브릿지 스냅샷 codex-bridge.js:1347(harnessMode
      스냅샷 기준 필드 선택)+상태 출력 :1627. **verify-guard.js·contract-inject.js는 CL-C 전용이라 기존
      verifyMode를 계속 읽음 — '전환 대상'이 아니라 codexVerifyMode가 이 경로로 새지 않는지의 음성 회귀
      테스트 대상.**
    ⓔ 소비처(확장): 상수 :257 / Contract 인터페이스 :302·312 / normalize :260·406·2730(+contract-lib
      loadContract 반환 필드 :835) / 저장 :3701 /
      저장 결과 처리 :3963 / 모드 전환 처리 :3725·3977 / segVerify 로드 :4072~4077 / 온보딩 ob3
      :4419·4441 / :4491 / 예제 contract.example.json:12. normalize는 contract-lib+extension 양쪽 동시
      정합(SCOUT-TRACK 교훈).
    ⓕ ★UI 교차 오염 차단(설계 핵심)★: 웹뷰의 검증모드 초안이 전역 단일 쌍(curVM/appVM 선언
      :3531~3532)이고 dirty면 렌더가 curVM을 동기화하지 않아(:4070~4077 `if(first||!dirty)`), 'CL-C에서
      초안 변경(미저장)→C-C 전환→저장(:3701)'이 CL-C 초안을 C-C 슬롯에 기록하는 누출 경로가 생김.
      **UI 계약 확정: 계약 카드가 dirty(미저장 초안 존재)이거나 계약 저장 응답 대기 중이면 모드 전환을
      잠근다(전환 버튼 비활성+'저장하거나 되돌린 뒤 전환' 안내, ckModeLock :3727~3728과 동일 계열).**
      선택 근거: 슬롯별 초안 보존은 상태 폭발, '전환 시 자동 확정'은 미저장 값의 무단 저장, '폐기'는
      입력 소실 — 전환 차단이 유일하게 데이터 소실·무단 저장 없이 fail-closed이며, 같은 카드의 규칙
      textarea·주입모드(curIM)까지 한 계약으로 커버함(동일 누출이 이미 존재 — 아래 P-10).
      부속 계약 3건(3차 지적 3~5 수용):
      ⑴ 외부(수동 파일 편집·향후 P-9 자동 전환) 모드 변경은 버튼 잠금으로 못 막음 — 웹뷰는 화면이
        렌더된 모드(renderedModeC)를 별도 보관하고, 외부 모드 변경 감지 시 **`dirty || contractSavePending`
        이면**(dirty만이 아님 — 저장 응답 대기 중 전환도 동일 결속) 기존 슬롯 화면을 hold(state push가
        화면을 덮지 않음), 저장은 renderedModeC의 슬롯 필드만 patch(현재 harnessMode를 되돌리지 않음),
        되돌리기는 초안 폐기 후 현재 모드 슬롯 재적재, 완료 시 hold 해제. **표시 계약: hold 중 카드
        제목·필드 라벨은 renderedModeC(옛 슬롯) 기준으로 고정하고 '런타임은 현재 모드, 이 카드는 미저장
        옛 모드 초안 편집 중'을 구분 표기** — 새 모드 라벨 아래 옛 값이 보이는 오도 차단.
      ⑵ '되돌리기' 실행 수단 신설 — 현재 contractDirty는 입력 시 true(:3908)·성공 저장 시만
        해제(:3956)라 원복 입력으로도 안 풀리고 카드 되돌리기 버튼이 없음 → 명시적 되돌리기 버튼(초안
        폐기+적용값 재적재+dirty 해제). 이것 없이는 저장 원치 않는 사용자가 전환을 풀 수 없음.
      ⑶ 저장 대기 권위 분리 — pendingSave는 계약·기본값·모델·타임아웃이 공유(:3953)라 다른 저장 응답이
        잠금을 조기 해제할 수 있음 → 계약 전용 contractSavePending(또는 요청 ID 대조)으로 결속.
    ⓖ 테스트 계약: 기존 단일 필드 가정 테스트(harness-mode.test.js:12·codex-verify-recovery.test.js:141·
      verify-guard.test.js:32·i18n.test.js:29·withcontract.test.js:24·정찰 테스트들) 갱신 + 최소 반례 —
      verifyMode=off/codexVerifyMode=always와 역방향, 신규 필드 부재 fallback(verify:true 포함), CL-C가
      C-C 필드 무시, C-C가 CL-C 명시값 무시, 모드 왕복 독립 보존, 언어별 독립, 미저장 초안 상태 모드 전환
      잠금, 저장 응답 대기 중 모드 전환 잠금, 모드 전환이 codexVerifyMode를 물질화하지 않음, CLI status의
      현재 모드 필드 선택, **CL-C 일반 저장이 codexVerifyMode를 물질화하지 않음, 무폴더 창(CONTRACT_FILE)의
      모드 단일 patch, 외부/자동 모드 전환 중 dirty 초안 보존(hold), 명시적 되돌리기 후 잠금 해제, 계약
      저장과 타 저장 요청이 겹쳐도 pending 권위 불변, 저장 실패 시 dirty·초안·잠금 상태 일관성**(3차 추가),
      **hold 중 카드 라벨·저장 대상이 renderedModeC로 일치하고 런타임 모드와 구분 표시됨, contractSavePending
      중 외부 전환도 hold**(4차 추가).
      **귀속: UI 상태 전이 반례는 신규 순수 상태기 테스트 파일에 배치(현 recon-ui.test.js:20은 이 전이를
      검사하지 않음) — 규칙 textarea·curIM의 모드 교차 반례(P-10) 포함.**
    범위: verifyMode만(claudeInjectMode/codexInjectMode는 이미 분리, scoutMode·scoutGate는 3트랙 공용
    원칙, verifyTimeoutMin은 links.json 워크스페이스 설정이라 대상 아님 — contract-lib.js:100).
    착수 순서 권고: 이 분리를 먼저 작은 묶음(스키마+게이트+UI+테스트)으로 완결 → P-9 자동 전환은 그 위에.
    분리 후 자동 전환과 결합하면 사례 ①~④가 원안 의미 그대로 성립.
  - 안전 구현 6조건(검증 지적 수용 — 이것 없이 원안 그대로면 역할 충돌·검증 stale·무게이트 진행·계약
    lost-update 발생):
    ⑴ 이벤트 4분류 선행: claude-user / codex-vscode-user / codex-exec-verifier / unknown.
       판별기는 이미 존재 — isVscodeUserSession(codex-hook.js:73~77, session_meta source="vscode"+
       thread_source="user"). 검증자(codex exec resume 구동, codex-bridge.js:1371)도 SessionStart·
       UserPromptSubmit 훅을 실제 발화시킴이 실측 확인됨(훅 trace) — sid==links.codexSession 정적 비교가
       아니라 위 불변 판별기가 주 기준.
    ⑵ 역할 충돌 절차: CL-C 연결 검증자 세션에서 사용자가 직접 질문해도 그 세션을 구현자로 못 바꿈
       (registerCodexImplementer의 verifier-conflict 거부 — 함수 시작 contract-lib.js:449, 실제 판정
       :470) — 사례 ②에는 '다른
       Codex 대화를 구현자로 선택 또는 검증자 재배치' 절차 필요.
    ⑶ 상대 구현 턴 + in-flight 검증 job(ask-active·내구 job) 확인 — 진행 중 전환은 stale die
       (codex-bridge.js:131)를 유발하므로 금지. 단 Claude active는 프롬프트 앵커라 턴 종료 신호가 아님
       (양방향 활성 판정 비대칭 — 설계에서 해소 필요).
    ⑷ 전환 불가 시 fail-closed: '보류+경고만'은 mismatched 턴이 무게이트로 진행되는 구멍 — 전환 못 하면
       그 턴 자체를 차단하고 재시도 유도.
    ⑸ 계약 쓰기 잠금/CAS: patchContractFields(contract-lib.js:240)·대시보드 saveContract 모두 무잠금
       RMW — 훅이 새 작성자가 되면 lost-update 가능. P-8 2단(updateContractPatch+잠금)과 합류 지점.
       언어 슬롯은 프롬프트 시작 시 language.json 1회 스냅샷으로 읽기~쓰기 결속.
    ⑹ 전환 provenance(누가·언제·어디서→어디로·언어 슬롯) 기록 + 경고 채널(Claude 주입·대시보드).

### P-10. [신규 2026-07-15] 계약 카드 미저장 초안이 모드 전환을 넘어 타 모드 슬롯에 저장됨 (기존 잠재 결함)
- 발견 경위: 검증 스위치 모드별 분리(P-9 소절 ⓕ) 설계검증 중 Codex가 확인 — 분리 신설로 생기는 문제가
  아니라 **현재 코드에 이미 존재**하는 누출.
- 메커니즘(실측): 웹뷰 계약 카드의 초안 상태(규칙 textarea·curIM/appIM 등)가 전역 단일이고
  (extension.ts:3531 부근), 입력 시 contractDirty 설정(:3906~3908) 후 모드가 바뀌어도 dirty면 대상 모드
  값으로 재적재하지 않음(:4062~4063). 모드 버튼은 체크박스만 잠금(ckModeLock :3727~3728).
  → 'CL-C 규칙/주입모드를 미저장 편집→C-C 전환→저장'이 CL-C 초안을 C-C 구현자/검증자 규칙·codexInjectMode로
  기록할 수 있음.
- 해결 계약(P-9 소절 ⓕ와 공통): 계약 카드 dirty 또는 저장 응답 대기 중이면 모드 전환 잠금 — 검증
  스위치만이 아니라 카드 전체(규칙 textarea·주입모드·검증모드)를 한 계약으로 커버.
- 처리 위치: 검증 스위치 분리 묶음(P-9 소절)과 같은 UI 상태기 수정에서 함께 해소하는 것이 자연스러움
  (같은 잠금 하나). 테스트 반례는 신규 순수 상태기 테스트 파일에 귀속.

## 처리 원칙
- 위 항목들은 이원화 작업 이어서 할 때 각각 [설계→구현→테스트→Codex 검증→커밋] 루프로 처리.
- 착수 순서는 **HANDOFF §1-0 끝의 '다음 순서'가 정본(2026-07-15 갱신)**: ~~P-8 1단~~(완료 07-15) →
  ~~P-5~~(완료 07-15) → P-2~P-4 잔여(P-1 해결 2026-07-15 — 손상 links fail-closed 3기록자+spawn 관문) →
  P-6b 서술 정정. (이 단락의 옛 참조 'HANDOFF §깃헙 동기화 절 07-14 14:02'와 'P-6·P-5 같은 묶음 권장'은
  낡은 기록 — P-6·P-5 모두 완료됨.)
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
