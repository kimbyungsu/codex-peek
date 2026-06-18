# Codex Bridge — 분석 · 취약점 · 로드맵

- 작성일: 2026-06-19
- 기준 코드: `github.com/kimbyungsu/codex-peek` @ `eac17ab`
- 목적: 세션이 끊겨 흐름을 잃어도 이어갈 수 있도록 **검증된 취약점·개선 우선순위·설계 결론**을 고정한다.
- 검증 방식: 아래 항목은 추측이 아니라 위 커밋의 실제 코드를 직접 읽어 라인까지 대조한 결과다.

---

## 0. 이 프로젝트가 무엇인가
Claude Code = 구현 에이전트, Codex CLI = 검증 에이전트로 묶는 **개인용 멀티에이전트 작업-규율 하네스**.
3층 구조:
- **브릿지 엔진** `~/.codex-bridge/codex-bridge.js` — Claude↔Codex 세션을 영속 링크(`links.json`), `codex exec resume`로 연결 세션에 질문, `link`/`status`/`find`/`doctor`.
- **Claude 훅 3종** — `contract-inject`(UserPromptSubmit: 계약 매 턴 주입) · `verify-guard`(Stop: 검증 없이 종료 차단) · `codex-guard`(PreToolUse: raw codex 직접호출 차단).
- **VS Code 확장** `src/extension.ts` — 상태바·호버·대시보드(연결/최근대화/계약 편집/검증모드/연결 변경).

---

## 1. 강제력의 구조 (핵심 통찰)
- **모든 강제력은 Claude Code의 훅에서 나온다.** 훅은 *호스트(Claude)*의 기능이다.
- **Codex CLI에는 동등한 생명주기 훅이 없다**(종료 차단·도구 가로채기 불가). 단, 브릿지가 `codex exec`로 **비대화식 구동**은 한다.
- 함의: enforcement는 "훅을 가진 쪽(Claude)"에만 존재 → **대칭 역할교체는 토글이 아니라 재설계 분기점**(§5.2, §6).

---

## 2. 검증된 취약점 (코드 위치 포함)

| # | 취약점 | 코드 위치 | 핵심 |
|---|---|---|---|
| V1 | 검증 "성공"이 아니라 **명령 문자열**만 확인 | `bridge/verify-guard.js:75` | `cmd`에 `codex-bridge`+`ask` 포함이면 `verified=true`. 성공/응답존재/반영 미확인. `echo`·실패·미연결도 통과로 오인 가능. **가장 큰 구멍.** |
| V2 | 파일변경 감지가 **툴 호출에 한정** | `bridge/verify-guard.js:71` | Write/Edit/MultiEdit/NotebookEdit만 `edited=true`. Bash 경유(`sed -i`,`python`,`cat>`,`git apply`,생성기)는 누락 → code 검증 모드 우회. |
| V3 | codex-guard **정규식 우회 가능** | `bridge/codex-guard.js` | `C=codex;$C exec`·`bash -c`·래퍼·alias 등 우회. 보안경계 아님, 행동유도용 가드. |
| V4 | Stop 훅 **1회만 강제** | `bridge/verify-guard.js:28` | `stop_hook_active`면 통과(무한루프 방지). 검증=최대 1회 재시도 유도이지 품질 게이트 아님. |
| V5 | 새 세션 식별 **시간기반 경쟁조건** | `bridge/codex-bridge.js:167,351` | `since=Date.now()-2000` 후 최신 rollout을 새 세션으로 추정. 동시 Codex 작업 시 오연결 가능. |
| V6 | **동기 8분 블로킹** | `bridge/codex-bridge.js:279` | `spawnSync` timeout 8분. 진행률·취소·스트리밍·병렬 불가. |
| V7 | **원자적 저장/잠금 부재** | `bridge/codex-bridge.js:112-115` `saveLinks` | `writeFileSync` 직접. 다중 창 동시쓰기 시 손상 위험. temp+rename·락·버전 필드 필요. |
| V8 | **테스트 미커밋 / `npm test` 없음** | `package.json:50-56` | scripts에 test 없음, 커밋된 회귀 스위트 없음("33/33 PASS"는 수동). 훅 오작동=조용한 오게이팅이라 위험. |
| V9 | (의심·**미검증**) `withContract`가 `loadContract()`를 **워크스페이스 인자 없이** 호출 | `bridge/codex-bridge.js:33` | 브릿지 프로세스의 `CLAUDE_PROJECT_DIR`/cwd에 의존해 프로젝트 계약 해석. cwd 어긋나면 codex 계약이 전역/타 프로젝트로 샐 여지. 실제 재현은 미확인. |
| V10 | **런타임 stale**(운영) | 이 PC `~/.codex-bridge/*.js` | 레포는 `eac17ab`인데 이 환경 런타임 5파일이 구버전(`contractFileFor`/`verifyMode` 없음). 분석이 말한 기능 일부가 이 PC에선 실제로 안 돔. |

> 참고로 잘 된 설계(유지할 것): 연결 없을 때 새 세션 안 만듦(`--allow-new` 필요), 프롬프트 **stdin** 전달(.cmd 안전, `codex-bridge.js:274-278`), 실패 진단+`doctor`(`:298-305`,`:416`), Codex 입력단 **검증 baseline**(`:23-39`), Codex 답 **재판단 강제**(`contract-lib.js:90`), 프로젝트별 계약 sha1 분리(`contract-lib.js:19-22`), 워크스페이스 우선 링크 + 교차오염 방지(`:121-131`).

---

## 3. 실행 순서 (재판단 — 내 계획 + Codex 검토 반영, 2026-06-19)

> Codex 검토(세션 019ed1ce)에서 원안 우선순위가 "검증:실패" 판정. 바닥(원자적 저장+테스트)을 앞으로, 변경 스냅샷 위치 교정(시작=UserPromptSubmit 훅), 배포 경로 추가, 영수증 키 재정의(turnId 불가)하여 재정렬.

- **0. 배포/반영 경로 고정 (선행 필수)** — 매 변경마다 확장 `npm run package`(compile→vsix)+설치 및 `bridge/*.js` → `~/.codex-bridge/` 복사. `main`=`out/extension.js`(`package.json:21`)이고 훅은 `~/.codex-bridge`에서 실행되므로, 이 단계 없이는 코드를 고쳐도 운영 미반영.
- **1. 바닥: 원자적 저장 helper + 테스트 골격 (V7·V8 선행)** — 공용 atomic write(temp+rename)+lock+version helper. 직접 `writeFileSync` 지점 전부 전환: `codex-bridge.js:112` saveLinks, `extension.ts:119` saveContract, `extension.ts:283-304` relink, `extension.ts:569-575` codex-bin.txt. 이후 proof/snapshot도 이 helper로 기록. fixture 기반 훅 테스트 + `npm test` 연결(V1/V2 구현과 동시).
- **2. 검증 증명 레코드 (V1) + V9** — `runCodex`(`codex-bridge.js:271-306`) 성공 시 proof 파일 기록. 키 = 양쪽 공유가능값 `claudeSession`+`workspace`+`ts` (※ `turnId`는 브릿지 인자에 없어 사용 불가). `verify-guard.js:73-76` 문자열 검사 → proof 검사(이번 사용자 턴 이후 생성 + 워크스페이스 일치 + exit 0 + 비어있지 않은 응답)로 교체. 동시에 `withContract`(`codex-bridge.js:30-34`)를 `loadContract(workspace())`로(V9).
  ```json
  { "claudeSession":"...", "workspace":"...", "ts":"...", "codexSession":"...",
    "requestHash":"...", "responseHash":"...", "exit":0, "status":"success" }
  ```
- **3. 실제 변경 스냅샷 (V2)** — 시작 스냅샷 = UserPromptSubmit 훅(`contract-inject.js:20-35`), 종료 비교 = Stop 훅(`verify-guard.js`). `git status --porcelain`(untracked 포함)/비-git이면 파일 해시. 도구이름 기반 `edited`(`verify-guard.js:71`) 대체.
- **4. 재검증 상태머신 + 루프 (V4)** — proof 상태(성공/실패/시도없음)로 `stop_hook_active` 즉시통과(`verify-guard.js:28`)를 정교화. 실패→수정→재검증, 최대 횟수·중단 조건.
- **5. 세션 관리 UI (§5.1 · 사용자 우선)** — 대시보드 '새 세션' 버튼 = `ask --allow-new`를 **비동기 child process**로(동기 실행 시 webview 멈춤). + 숨김/휴지통/삭제(metadata-hide ↔ 실제삭제 분리, 원본 rollout 불이동). webview 메시지(`extension.ts:319-334`)에 핸들러 추가.
- **6. 비동기화 + 역할 교체 (V6 · §5.2/§6)** — `runCodex` spawnSync 8분 동기(`codex-bridge.js:279`) → 비동기/작업ID. 역할교체 경량(Codex 구현·Claude 읽기전용·worktree)→대칭(외부 오케스트레이터 재설계).
- **V3** (`codex-guard.js:20-26`): 행동유도 가드로 유지. proof 도입 후 핵심은 "raw 차단"→"증명 없는 검증 불인정"으로 이동.

---

## 4. 사용자 의견 반영 (합의)
- **체크리스트 부작용**: 사용자가 켜고 끄고 규칙 수도 정하는 **운용 선택**이지 설계 결함 아님 → 우선순위 아님. 단 "자기보고는 준수의 증명이 아님"(=V1) 인식은 유지.
- **테스트**: 다른 개선의 후속이지만, 하네스 안전장치로서 V8은 우선순위에 둔다.

---

## 5. 추가 기능 설계

### 5.1 세션 관리 (새로 만들기 · 보관 · 삭제)
- **새 세션 만들기 (신규 — 사용자 요청)**: 대시보드에 '새 Codex 세션 열기' 버튼 추가. 엔진은 이미 `ask --allow-new`로 새 세션 생성+자동 연결이 됨(`codex-bridge.js` cmdAsk) → UI 노출만 추가하면 됨. 새로 만들면 그 워크스페이스 연결이 새 세션으로 갱신되므로, 아래 보관/해제와 **한 묶음**으로 제공해야 함(헌 세션이 쌓여 "어느 게 진짜 검증방"인지 혼동되지 않게).
- **연결 해제 ≠ 삭제**를 UI에서 분리(연결해제 / 숨김 / 보관함 이동 / 완전삭제 4기능).
- 1단계 **숨김/보관**: Codex 원본 파일 *건드리지 않고* 브릿지 메타데이터에만 `state:"archived"` 기록. 기본 목록 제외, '보관 보기'에서 노출. (가장 안전)
- 2단계 **휴지통**: 명시 요청 시 `~/.codex-bridge/trash/<id>/`로 이동 + `manifest.json`(originalPath, originalMtime, sha256, trashedAt, linkedWorkspaces).
- 3단계 **완전삭제**: 다중연결·실행중·인덱스 참조·보존기간 확인 + `DELETE <세션ID 앞8자>` 확인 문구.
- 원칙: **Codex 원본 rollout은 함부로 옮기지 않는다**(Codex CLI가 인덱싱). 메타데이터 우선.

### 5.2 역할 교체 (구현자 ↔ 검증자)
- **단기(경량 모드, 현 구조로 가능)**: "Codex 구현(bridge로 구동) → Claude 검토(읽기전용)". 검증자 읽기전용 원칙 + 별도 git worktree/임시 브랜치로 격리. 두 에이전트가 같은 워크트리 동시 수정 금지.
- **장기(대칭, 재설계)**: §6.

---

## 6. 역할 교체가 왜 "재설계"인가 (사용자 확인 완료)
- 현재 enforcement = Claude 훅. Codex엔 동등 훅 없음(단 `codex exec`로 비대화식 구동은 가능).
- 따라서 **완전 강제 대칭**을 하려면 제어 루프를 Claude 훅에서 떼어내 **외부 오케스트레이터**가:
  - Claude(headless `-p`/print + 훅)와 Codex(`exec`)를 **둘 다 구동**,
  - 각 출력을 **검사**, 역할(planner/implementer/reviewer/finalizer)에 따라 **라우팅**,
  - 프로토콜(구현→검증→재검증)을 **강제**.
- 추상화(분석안):
  ```
  Orchestrator
   ├ ClaudeAdapter { ask, edit, verify, session }
   └ CodexAdapter  { ask, edit, verify, session }
  roles = { planner, implementer, reviewer, finalizer }  // 에이전트 지정
  ```
- 이렇게 해야 Gemini CLI 등 추가에도 구조가 안 깨짐. = 현 "Claude 훅 얹기" 하네스의 이식/재작성.

---

## 7. 유료화 판단
- **현 형태(로컬 확장)는 월 구독 어렵다**: 대상 협소(Claude Code+Codex 병용+로컬 훅 감수), 사용자 이미 양쪽 비용 지불, 핵심 구조 공개 시 복제 쉬움, 외부 CLI 포맷 변경에 취약.
- **현실적**: 오픈코어(무료) + **1회구매 Pro**(역할교체·검증증명·재검증루프·세션보관함·리포트·worktree) 또는 저가 연간 유지보수.
- **구독 명분**은 팀 정책·PR/CI 연동·감사 로그·다중 에이전트·작업 샌드박스까지 확장해 **멀티에이전트 개발 운영 플랫폼**이 될 때 생김.
- 요약: 잘 다듬은 개인 도구 + 오픈소스 평판으로는 가치 충분, 지속 구독 사업이 되려면 범위 자체가 달라져야 함.

---

## 8. 다음 액션 (체크박스)
- [x] **런타임 동기화 완료**(2026-06-19): 이 PC `~/.codex-bridge/*.js` = 레포 최신, 확장 `0.1.9` 설치.
- [ ] 착수: §3 재판단 순서 **0(배포 경로) → 1(원자적 저장+테스트 바닥)**부터.
- [ ] 진행 경로: codex-bridge(검증링크)로 Claude↔Codex 연결, 매 단계 구현→검증→재판단.

> 이 문서가 단일 기준점(source of truth)이다. 세션이 바뀌면 먼저 이 파일을 읽고 §8·§9부터 이어간다.

---

## 9. 진행 로그
- **2026-06-19 — 기본 지침(base directive) 층 + 대시보드 노출 + UI 개편**
  - `contract-lib.js`: 캐논 `BASE_DEFAULTS` 3종 — verifyBaseline(검증모델: 지정 범위는 시작점일 뿐·요청자 결론 전제 금지·독립 범위확장), transmit(구현모델: 명령 금지·내가 한 것/이유/근거/불안점 제공·결론은 내 주장), rejudge(항목별 수용/반박/보류+근거(파일·라인), 짧은 동의 금지). + `loadBaseDirective`(오버라이드 `~/.codex-bridge/base-directive.json`, 빈 항목=기본) + `saveBaseDirective`(기본값과 같으면 미저장, 전부 기본이면 파일 삭제) + `resetBaseDirective`. `buildVerifyDirective`·`withContract`가 이를 사용(코드에 캐논 상존, 사용자 고정계약과 분리).
  - 대시보드(`extension.ts`): 접힌 "🔒 기본 지침(최소 동작 보장 고정 규약·커스텀 아님)" 보기/수정/**기본값 복원**. 런타임 `contract-lib.js`를 require해 단일 출처. 런타임 미발견 시 거짓 성공 방지(버튼 비활성+경고).
  - UI 개편: 🤖⚙️ → C/Cx 색 모노그램, 검증모드 드롭다운→세그먼트 토글, 검증 대화=사용자 말풍선+Codex 전폭 카드(통과/실패 칩+펼치기).
  - 예시 재프레임: `contract.example.json` codex 규칙을 판정형식→검증깊이로.
  - 테스트: 기본지침 17체크 + 웹뷰 문법 + TS 컴파일 통과. 런타임 동기화·확장 0.1.9 설치.
  - **남은 부채**: (1) 커밋된 `npm test` 없음(V8) (2) `base-directive.json` 비원자적 저장(V7) (3) README/ROADMAP 세부 미갱신 (4) V9(`withContract`의 `loadContract()` 무인자) (5) 대시보드 화면 렌더 미확인(Reload 필요) (6) **결정2 강제 미구현** — verify-guard가 최종 답을 읽어 항목별 근거↔실제 연 파일(작업기록)을 대조해 차단하는 것. *작업기록이 파일 열람·줄범위를 남기는지 표본 확인이 선행* 필요.
- **다음 세션 착수 후보**: (6) 결정2 강제의 선행(작업기록 표본 확인) → 그다음 §3의 1(원자적 저장 helper + 테스트 바닥)에 (2)(V7)·(1)(V8)을 묶어 처리.
