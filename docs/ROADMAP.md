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
| V7 | **원자적 저장/잠금 부재** | `bridge/codex-bridge.js:106-109` `saveLinks`(`:108` writeFileSync) | `writeFileSync` 직접. 다중 창 동시쓰기 시 손상 위험. temp+rename·락·버전 필드 필요. |
| V8 | **테스트 미커밋 / `npm test` 없음** | `package.json:50-56` | scripts에 test 없음, 커밋된 회귀 스위트 없음("33/33 PASS"는 수동). 훅 오작동=조용한 오게이팅이라 위험. |
| V9 | (의심·**미검증**) `withContract`가 `loadContract()`를 **워크스페이스 인자 없이** 호출 | `bridge/codex-bridge.js:27`(withContract `:23-34`) | 브릿지 프로세스의 `CLAUDE_PROJECT_DIR`/cwd에 의존해 프로젝트 계약 해석. cwd 어긋나면 codex 계약이 전역/타 프로젝트로 샐 여지. 실제 재현은 미확인. |
| V10 | **런타임 stale**(운영) | 이 PC `~/.codex-bridge/*.js` | 레포는 `eac17ab`인데 이 환경 런타임 5파일이 구버전(`contractFileFor`/`verifyMode` 없음). 분석이 말한 기능 일부가 이 PC에선 실제로 안 돔. (※2026-06-19 v0.1.10 동기화로 해소 §8) |
| V11 | **sessions 경로 비-auto-track** | `bridge/codex-bridge.js:37-38` · `src/extension.ts:8-9` | sessions 폴더는 `process.env.CODEX_HOME‖~/.codex`/sessions **하드코딩 기본값**. 바이너리(`codex-bin.txt`+`syncCodexBin`)와 달리 auto-track 없음(config.toml에도 sessions/home 설정 없음, 검증 확인). **현재 이 PC는 정렬됨**(codex가 `~/.codex/sessions`에 씀·index 1:1 매칭·`CODEX_HOME` 빈값→기본). 위험은 **VS Code 확장 호스트 ↔ Claude 훅/codex 실행 환경의 `CODEX_HOME` 상속 분리** 또는 비표준 home → 대시보드·브릿지·세션삭제가 서로 다른 폴더를 봄. **세션 삭제/휴지통의 선행 위험**(표시 오류가 아니라 잘못된 폴더 대상 동작). |

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
- **5. 세션 관리 UI (§5.1 · 사용자 우선)** — 대시보드 '새 세션' 버튼 = `ask --allow-new`를 **비동기 child process**로(동기 실행 시 webview 멈춤). + 숨김/휴지통/삭제(metadata-hide ↔ 실제삭제 분리, 원본 rollout 불이동). webview 메시지 핸들러(`extension.ts:348-380`)·cands 렌더(`:622-632`)에 추가. 상세는 §5.1 '구현 보강'.
- **6. 비동기화 + 역할 교체 (V6 · §5.2/§6)** — `runCodex` spawnSync 8분 동기(`codex-bridge.js:279`) → 비동기/작업ID. 역할교체 경량(Codex 구현·Claude 읽기전용·worktree)→대칭(외부 오케스트레이터 재설계).
- **V3** (`codex-guard.js:20-26`): 행동유도 가드로 유지. proof 도입 후 핵심은 "raw 차단"→"증명 없는 검증 불인정"으로 이동.
- **주입 제어 분리 (§5.3 · 2026-06-19 확정)** — 사용자 계약 주입모드(꺼짐/항상/플랜) + 기본지침 명시성 + UI 3분할·저장피드백. 위험은 **쪼개서**: ①게이팅 read path(permission_mode 읽어 분기)는 작아 **step1과 병행 가능**, ②그러나 **저장 필드·active.json 확장은 saveContract/active.json이 비원자라 V7(원자적 저장) 이후가 안전**. 상세·체크리스트는 §5.3.

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
- **구현 결정 (2026-06-19 · 사용자 우선 · 메모리 회수)**: 후보 세션 목록 각 줄에 **🗑 버튼** → **확인 모달**(세션 id·첫 발화 표시) → 처리. 동기: 브릿지가 `--allow-new`로 자동생성한 세션은 Codex 확장 UI에 안 보여 직접 폴더를 뒤져야 정리 가능했음 → **대시보드가 유일한 정리 창구**.
  - 사용자 선택(AskUserQuestion 2026-06-19): **"되돌림 가능한 이동"**. 연결 중 세션 삭제 시 **경고 + 연결 자동 해제**.
  - 구현 지점: 확장 `onDidReceiveMessage`에 `deleteSession`(필요 시 `hideSession`/`restoreSession`) 핸들러 + cands 렌더에 `data-del` 버튼 + `$("cands")` 위임 클릭 + 확인은 `vscode.window.showWarningMessage`(modal:true).
  - **선행 확인(중요·구현 전 표본 테스트)**: rollout을 `~/.codex/sessions` *밖*으로 옮기면 Codex CLI의 `session_index.jsonl`이 dangling 되거나 `resume`/세션 목록이 에러 내는지 확인. **안전 못 박기 전에는** 1단계 **메타데이터 숨김(파일 불이동)** 을 기본 정리 수단으로 두고(§5.1 원칙과 정합), "되돌림 가능한 이동(휴지통)"은 명시 요청 시. → 사용자의 "되돌림 가능한 이동" 결정은 이 인덱스 안전성 확인 결과에 따라 휴지통 tier로 실현(이동 안전치 않으면 숨김이 기본).
  - 경로 일원화: 휴지통 = `~/.codex-bridge/trash/<id>/`(+`manifest.json`). (이전 테스트 세션 정리 때 쓴 `deleted-sessions/`와 명칭 통일.)
  - **구현 보강 (Codex 검증 019ed785 · 2026-06-19)**:
    - **인덱스 위험 정정**: `~/.codex/session_index.jsonl` 실제 표본은 `id·thread_name·updated_at`만 보유(절대 rollout 경로 **없음**). 따라서 위험은 "인덱스 절대경로 dangling"이 아니라 "Codex가 `id`로 sessions 디렉터리를 **재탐색**하면 이동 후 `resume`/목록이 깨질 수 있음". → 이동을 기본 채택하기 전 **`codex resume <id>` 표본 테스트** 필수.
    - **숨김 구현요소**(§5.1 1단계에 빠져 있던 것): `~/.codex-bridge/sessions-meta.json`(id→{state: visible|hidden|trashed}) 신설 + **확장(`extension.ts` recentRollouts)·브릿지(`codex-bridge.js` recentRollouts) 양쪽**이 이 메타로 후보 필터. 단 **현재 연결된 세션은 숨김이어도 표시/ask 유지** — `computeState`의 `linkedSnippet`이 candidates에서 주제를 찾으므로, 숨겨서 candidates에서 빠지면 연결 주제가 빈값 됨 → "후보 목록 제외"와 "연결 표시/ask 가능"을 **분리**.
    - **연결 해제**: 삭제/휴지통 전 `unlinkSession(id, workspace)` 신설 — `links.json` `byWorkspace`에서 해당 `codexSession` 제거 + 같은 workspace 가리키는 `bySession`도 제거(양축). 기존 `relink`는 교체용이라 부적합(현재 '해제만' 함수 없음).
    - 라인참조 정정: 메시지 핸들러 `extension.ts:348-380`, cands 렌더 `:622-632`, relink `:312-333` (ROADMAP 기존 `:319-334`는 stale).
    - **✅ sessions 폴더 견고화(V11) — 구현됨(2026-06-20)**: 삭제/휴지통/숨김은 `SESSIONS_DIR`에서 동작하므로, 그 폴더가 **확장·브릿지·실제 codex 셋 다 동일하게** 해석되는지 보장해야 함. **구현**: 확장 `syncCodexHome()`이 `codex doctor`로 `CODEX_HOME`을 탐지→`codex-home.txt`, 확장·브릿지 둘 다 `env.CODEX_HOME‖codex-home.txt‖~/.codex`로 SESSIONS_DIR 해석(바이너리 `codex-bin.txt`와 대칭). **잔여(다음 이슈, §10 참조)**: 세션폴더를 `CODEX_HOME/sessions`로 가정 — audit 원안 "새 rollout이 실제 떨어진 루트 관찰(`codex-sessions-dir.txt`)"은 미적용이라 비표준 세션경로는 못 잡음. 실측 탐지로 견고화 남음.
  - **✅ 구현 완료 (2026-06-20 · item 3 · Codex 검증 019ed785 통과 / 재판단 1라운드 후 통과)**: 1단계 **숨김(파일 불이동)** 출고. (함수명 기준 — 라인번호 생략)
    - 메타 `~/.codex-bridge/sessions-meta.json`(id→{state:"hidden"}) — 확장(`setSessionHidden`/`hiddenSessions`)·브릿지(`hiddenSessions`+`recentRollouts` 필터)가 **같은 파일**을 읽어 일관.
    - UI: 후보마다 🗑(`data-del`→`hideSession`), "숨긴 세션 N개 보기" 토글로 `hiddenCandidates` 펼침 + 항목별 복원(`data-restore`→`restoreSession`). 확인 모달 = `showWarningMessage(modal:true)`.
    - **연결 해제는 워크스페이스 한정**: `unlinkSession(id, ws)` — 같은 codex 세션을 공유하는 **타 워크스페이스 링크는 보존**(프로젝트별 분리). 실데이터(019db380이 tg-chat-engine·master001 공유) 로직 테스트 통과. (Codex 1차 검증이 잡은 cross-workspace 삭제 버그를 재판단으로 수정한 결과.)
    - **필터 일관**: 확장 `computeState`가 `recentRollouts(99999)`(walk는 원래 전수라 비용 동일, 후처리 범위만 확대)에서 숨김 제외→상위 12 → 브릿지 `find`와 동일 의미. 오래된(이전 50개 윈도 밖) 숨김 세션도 복원 목록 유지(hidden 상위 50).
    - **미출고(다음 tier)**: 휴지통/완전삭제는 §5.1 원칙(원본 불이동)대로, `codex resume <id>` **이동 후 안전성 표본 테스트** 통과 전까지 보류.

### 5.2 역할 교체 (구현자 ↔ 검증자)
- **단기(경량 모드, 현 구조로 가능)**: "Codex 구현(bridge로 구동) → Claude 검토(읽기전용)". 검증자 읽기전용 원칙 + 별도 git worktree/임시 브랜치로 격리. 두 에이전트가 같은 워크트리 동시 수정 금지.
- **장기(대칭, 재설계)**: §6.

### 5.3 주입 제어 분리 — 사용자 계약 주입모드 · 기본지침 명시성 · UI (2026-06-19 확정 · ✅ 2026-06-20 구현 완료 `cdd56b1` v0.1.12)
**배경**: '고정 계약'(사용자가 적는 Claude 행동규칙)이 검증모드와 무관하게 매 턴 무조건 주입돼, 검증모드 off에서도 "평소 그대로"(README §off)가 깨지고, 무엇이 언제·누구에게 적용되는지 대시보드 표기가 모호했다. Codex 검증(세션 019ed785, 2회+)으로 주입 게이팅 사실관계·타당성 확인. 결론: 검증모드와 **분리 유지**하되 계약 자체에 **독립 주입모드**를 준다.

**확정 스펙**
1. **사용자 계약**(← '고정 계약' 개명): 주입 모드 **3트랙 — 꺼짐 / 항상 / 플랜 모드일 때**.
   - 플랜 = Claude Code 플랜 모드. UserPromptSubmit 훅 입력 `permission_mode === "plan"`으로 감지(공식 훅 문서 확인: code.claude.com/docs/hooks). 구현 첫 단계로 실제 플랜모드에서 `permission_mode`가 `"plan"`으로 찍히는지 로그 1줄로 못박기.
   - **"코드 변경 시" 모드는 두지 않음**: 코드 변경은 턴이 끝나야 아는 사후 신호(verify-guard가 Stop에서 판정)라 턴 시작 주입엔 못 씀. 직전 턴 기반은 1턴 지연이라 무의미 → UI에 "코드 옵션이 없는 사유" 안내.
   - 기본값 **항상**(기존 동작 무회귀). 저장 필드 `claudeInjectMode`(`"off"|"plan"|"always"`)는 프로젝트별 contract 파일에. bridge·extension **양쪽** loadContract에서 누락 시 `"always"`로 normalize.
2. **검증모드는 그대로 4트랙**(꺼짐/코드/플랜+코드/모든턴): Stop 사후 판정이라 코드/플랜+코드 유효. 계약(3트랙)과 **비대칭은 시점 차이(주입=턴 시작 / 검증=턴 끝)** 때문이라 정상. 라벨 "플랜+코드"→"플랜 확정 또는 코드 변경 시"로 명확화.
3. **기본 지침**(하네스용·사용자 계약과 별개) 적용 시점을 **조각별 명시**: verifyBaseline → **Codex에게, 검증 ask마다** / transmit·rejudge → **Claude에게, 검증모드 ON일 때만**. 패널 줄별 "언제·누구에게" 배지.
4. **UI**: 사용자 계약 / 검증 모드 / 기본 지침 **3카드 분리**. 각 "지금 적용 중?" 표시. **플랜모드 라이브 표시**(훅이 `permission_mode`를 active.json류로 기록 → 대시보드 노출). **저장 버튼 눌림 피드백 + "저장됨 ✓(다음 턴부터)" 깜빡/페이드**.
5. **README**: 검증모드 off를 "평소 그대로"→"Codex 검증 왕복만 끔(사용자 계약은 별도)"로 정정.

**구현 순서·체크리스트**(Codex 검증 보강):
1. `permission_mode` 실로그 확인(문서상 `"plan"` 값 있으나 예시는 `"default"` → 실데이터로 못박기 필수).
2. `claudeInjectMode` 게이팅: contract-inject에서 플랜이면 `permission_mode`, 항상/꺼짐 분기 + **bridge(`contract-lib.js`)·extension(`extension.ts`) 양쪽 loadContract에서 누락 시 `always` normalize**(한쪽만 빠뜨리면 대시보드 표시와 실제 훅 동작이 갈림).
3. 저장 경로 **전부**: `Contract` 타입 + `saveContract` + **webview 메시지 payload에 `claudeInjectMode` 추가**(빠지면 저장 시 필드 소실) + `bridge/contract.example.json` 예시 갱신.
4. UI 3카드 분리 + 플랜 **라이브 표시**(active.json에 `permissionMode`=훅 입력 `permission_mode` 기록 ✓계측완료; 단 비원자=V7 영향) + 저장 피드백.
5. README 정정.
6. **배포**(미루면 V10 재발): `src→out` compile + `bridge/*.js → ~/.codex-bridge/` 복사 + VSIX 재설치. 이 단계 없으면 코드를 고쳐도 운영 미반영.

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
- [x] **런타임 동기화 완료**(2026-06-19): 이 PC `~/.codex-bridge/*.js` = 레포 최신(base directive 포함, 5파일 diff 동일), 확장 `0.1.10` 설치. base-directive 커밋(d51f0ba) 후 재동기화 — 버전 0.1.9→0.1.10으로 옛 빌드 혼동 제거. `loadBaseDirective()` 런타임 로드 확인(verifyBaseline 5줄·transmit·rejudge).
- [ ] 착수: §3 재판단 순서 **0(배포 경로) → 1(원자적 저장+테스트 바닥)**부터.
- [ ] 진행 경로: codex-bridge(검증링크)로 Claude↔Codex 연결, 매 단계 구현→검증→재판단.

### 8.1 다음 이슈 (2026-06-20 사용자 확정 · 다음 접속 시 여기부터)
'세션 관리' 묶음(item1~4)+UX/시안성 보강 완료(커밋 483cb1d) 후 남은 것. 환경 가변 경로는 추적/탐지, 자체 namespace는 live(homedir) 호출+override 원칙(§10) 유지.
- [ ] **(추천 1순위) 엉뚱 폴더/cwd 방어**: `codex-bridge ask`를 링크 없는 폴더(예: 코드 레포)에서 돌리면 엉뚱한 워크스페이스로 새 세션을 만들어 오염 — 이번 세션에 실제 발생(고아 019ee492). `--allow-new` 새 세션 생성 직전 '의도치 않은 컨텍스트' 경고/차단 또는 워크스페이스 식별 강화. (§10 '부분 견고' 잔여)
- [ ] **(추천 2순위) 세션폴더 실측 탐지(V11 잔여)**: 지금은 `CODEX_HOME/sessions` 가정. audit 원안대로 codex 실행 직후 '실제 새 rollout이 떨어진 루트'를 관찰해 `~/.codex-bridge/codex-sessions-dir.txt`에 기록(바이너리 대칭) → 비표준 세션경로도 견고.
- [ ] **자체 폴더 견고화**: `~/.codex-bridge` homedir 가정에 대한 선택적 `CODEX_BRIDGE_HOME` override(확장 호스트≠훅 home 엣지 대비) + **원자적 저장(V7)** 을 이 폴더 파일들(links.json·sessions-meta.json·contracts 등)에 적용(현재 직접 writeFileSync 다수, 동시쓰기 손상 위험).
- [ ] **코덱스 호출 멈춤 검토(§6 일부)**: `runCodex` spawnSync 최대 8분 동기 → 그동안 멈춤. 비동기/작업ID로 풀지 검토(사용자: "보긴 봐야"). **역할 교체(구현↔검증)는 보류.**
- [ ] 기존 바닥(§3): 커밋된 테스트(V8) · verify-guard 결정2(연 파일 대조 강제) · V9 · dev 하드코딩(낮음).

> 이 문서가 단일 기준점(source of truth)이다. 세션이 바뀌면 먼저 이 파일을 읽고 §8·§9부터 이어간다.

---

## 9. 진행 로그
- **2026-06-20 — '세션 관리' 묶음 4개 + UX/시안성 보강 + 검증 인프라 수정 (커밋 9e8d933→483cb1d)**
  - **item1 V11**(세션폴더 자동탐지, `codex doctor`→codex-home.txt, 확장·브릿지 양쪽+진단) → **item2** 무링크 새세션 자동시작(`ask --allow-new`)+폭증방지(autoNewFailed) → **item3** 세션 숨김/복원(sessions-meta.json, 워크스페이스 한정 unlink, 전수필터; f382398) → **item4** 모델·생각강도 보기+고르기(links.json modelPrefs→매 ask `-c` 주입; 5498bdd) + **계정캐시 기반 옵션**(CODEX_HOME/models_cache.json에서 모델·모델별 생각강도 읽음, 계정 등급별 xhigh/pro 자동; 43ef138).
  - **UX 보강(944b4ac)**: 두뇌설정 재배치 / 숨긴세션 **영구삭제**(휴지통 모델, 삭제=전역 링크해제 `unlinkSessionEverywhere`, 실패시 거짓삭제 방지, 공유세션 경고) / 캐시 진단. 삭제 안전성 런타임 확인(코덱스 "no rollout found" 곱게 실패, state db는 안 건드림).
  - **시안성(f2ca75b→483cb1d)**: 한눈에 보기를 카드로 통일+검증 섹션 다음으로 이동(🗺 제거), 단계별 기본 원칙 '고정 기준' 배지/좌측보더, 저장 스크롤 상단→중앙.
  - **검증 인프라(f5a7558)**: runCodex spawnSync `maxBuffer` 미설정(1MB) → 무거운 검증의 stderr 초과 시 Windows ENOBUFS로 검증이 결과없이 죽던 버그 → 256MB로 수정. (자기진단 검증이 resume에서도 ENOBUFS 재발해 원인이 '새세션 vs resume'이 아니라 '출력버퍼 초과'임을 확인.)
  - **교훈(중요)**: 검증 ask는 반드시 그 대화 워크스페이스 폴더에서 걸 것 — 코드 레포 폴더(링크 없음)에서 돌리면 엉뚱한 새 세션 생성(세션파일 cwd로 입증)+오염. 숨김≠삭제(가림은 파일 보존). → §8.1 '엉뚱 폴더 방어'로 등록.
  - **문서 동기화(이 항목)**: §10·§5.1의 V11을 '구현됨+잔여(세션폴더 CODEX_HOME/sessions 가정)'로 갱신. 남은 경로/바닥 이슈는 §8.1에 정리.
- **2026-06-19 — 기본 지침(base directive) 층 + 대시보드 노출 + UI 개편**
  - `contract-lib.js`: 캐논 `BASE_DEFAULTS` 3종 — verifyBaseline(검증모델: 지정 범위는 시작점일 뿐·요청자 결론 전제 금지·독립 범위확장), transmit(구현모델: 명령 금지·내가 한 것/이유/근거/불안점 제공·결론은 내 주장), rejudge(항목별 수용/반박/보류+근거(파일·라인), 짧은 동의 금지). + `loadBaseDirective`(오버라이드 `~/.codex-bridge/base-directive.json`, 빈 항목=기본) + `saveBaseDirective`(기본값과 같으면 미저장, 전부 기본이면 파일 삭제) + `resetBaseDirective`. `buildVerifyDirective`·`withContract`가 이를 사용(코드에 캐논 상존, 사용자 고정계약과 분리).
  - 대시보드(`extension.ts`): 접힌 "🔒 기본 지침(최소 동작 보장 고정 규약·커스텀 아님)" 보기/수정/**기본값 복원**. 런타임 `contract-lib.js`를 require해 단일 출처. 런타임 미발견 시 거짓 성공 방지(버튼 비활성+경고).
  - UI 개편: 🤖⚙️ → C/Cx 색 모노그램, 검증모드 드롭다운→세그먼트 토글, 검증 대화=사용자 말풍선+Codex 전폭 카드(통과/실패 칩+펼치기).
  - 예시 재프레임: `contract.example.json` codex 규칙을 판정형식→검증깊이로.
  - 테스트: 기본지침 17체크 + 웹뷰 문법 + TS 컴파일 통과. 런타임 동기화·확장 0.1.9 설치.
  - **남은 부채**: (1) 커밋된 `npm test` 없음(V8) (2) `base-directive.json` 비원자적 저장(V7) (3) README는 base directive·UI 기준 갱신 완료✓(ROADMAP 세부는 본 §9로 대체) (4) V9(`withContract`의 `loadContract()` 무인자) (5) 대시보드 화면 렌더 미확인(Reload 필요) (6) **결정2 강제 미구현** — verify-guard가 최종 답을 읽어 항목별 근거↔실제 연 파일(작업기록)을 대조해 차단하는 것. *작업기록이 파일 열람·줄범위를 남기는지 표본 확인이 선행* 필요.
- **다음 세션 착수 후보**: (6) 결정2 강제의 선행(작업기록 표본 확인) → 그다음 §3의 1(원자적 저장 helper + 테스트 바닥)에 (2)(V7)·(1)(V8)을 묶어 처리.
- **2026-06-19 — 주입 제어 분리 설계 확정(§5.3)**
  - 출발 의문: 검증모드 off인데도 '고정 계약'이 매 턴 주입 → off="평소 그대로"(README:90) 모순. Codex 검증(019ed785)으로 게이팅 사실 확정 — 계약(buildInjection)=verifyMode 무관 매턴 / 기본지침 transmit·rejudge=검증모드 ON일 때만 / verifyBaseline=ask 시 Codex.
  - 결정: 계약을 검증모드와 **분리 유지** + 독립 주입모드 **3트랙(꺼짐/항상/플랜)**. '코드 변경 시'는 사후 신호라 주입 불가(드롭). 플랜은 UserPromptSubmit `permission_mode`로 감지 가능(훅 문서 확인). '고정 계약'→'사용자 계약' 개명. 기본지침 조각별 적용시점 명시. UI 3카드 분리·플랜 라이브표시·저장 피드백. README off 문구 정정.
  - 구현 보류(설계만 확정) — 다음에 §5.3 순서대로. 첫 단계 `permission_mode` 실로그 확인.
- **2026-06-19 — 세션 삭제/관리 UI를 ROADMAP에 통합(§5.1 보강)**
  - 이전에 "다음 세션에 진행"으로 미뤘던 대시보드 세션 삭제(🗑+확인모달+되돌림 가능 이동+연결중 경고/해제, `deleteSession` 핸들러·cands `data-del`)를 메모리(frag-c8c345a)에서 회수해 §5.1에 **구현 결정**으로 명시. 사용자 선택 = 되돌림 가능한 이동(휴지통).
  - 정직한 reconcile: 기존 §5.1 원칙("원본 rollout 함부로 안 옮김 — Codex 인덱싱")과 "이동" 결정이 충돌 → **선행으로 rollout 이동이 `session_index.jsonl`·`resume`에 주는 영향을 표본 확인**, 안전 전엔 메타데이터 숨김을 기본. §3 step5와 연결.
- **2026-06-19 — sessions 경로 비-auto-track 발견(V11) + 세션삭제 선행조건화**
  - 사용자 지적(바이너리는 auto-track인데 sessions 경로도?)을 검증(019ed785). 결론: sessions는 `env.CODEX_HOME‖~/.codex` 하드코딩, auto-track 없음(config.toml에도 설정 없음). 현재 이 PC는 정렬됐으나 확장↔훅 `CODEX_HOME` 분리/비표준 home에서 깨질 수 있음. 세션 삭제/휴지통의 선행 위험으로 §5.1·§2(V11)에 기록. 견고화 = `codex-sessions-dir.txt` 실측 탐지(바이너리 대칭).
- **2026-06-19 — 경로 해석 전수 audit(§10)**: V11(sessions)이 단발 누락인지 전수 점검하자는 사용자 요청 → Codex와 전 파일 대조(019ed785). 큰 분류 맞음 + 누락 보완(확장의 런타임 contract-lib 동적 require, make-screenshot Edge 하드코딩, package clean cwd) + workspace 키는 부분 견고로 정정. §10 신설.

---

- **2026-06-20 — §5.3 구현 완료(v0.1.12, `cdd56b1`)**: `permission_mode==="plan"` 실측 확정 후 사용자 계약 주입모드(off/plan/always, 기본 always 무회귀) 구현. contract-inject 게이트(plan일 때만 plan 주입, 검증 directive는 별도 축) + 양쪽 normInjectMode + saveContract payload + contract.example. 대시보드 사용자계약/검증모드 카드 분리, 주입모드 세그먼트, 검증모드 라벨 풀기, 플랜 라이브표시(창 워크스페이스 일치 시만), 기본지침 조각별 배지, 저장 flash, README off 정정. 단위표(주입모드×permission_mode)·Codex 다단계 검증(payload 갭·out stale·게이트·창격리) 통과. **다음 = 2순위 V11(세션 폴더 견고화 = 세션삭제 선행) / §3 바닥(V7 원자적 저장·V8 테스트).**

## 10. 경로 해석 전수 audit (2026-06-19 · Codex 019ed785 대조)
환경마다 다른 경로를 코드가 어떻게 잡는지 전수 분류. **원칙**: *타앱(codex) 데이터처럼 환경 가변 경로는 추적/탐지, 자체 namespace(`~/.codex-bridge`)는 homedir 가정+문서화+override.*

- **견고(조치 불필요)**: codex 바이너리(`codex-bin.txt` auto-track + `CODEX_BIN` + PATH), vscode `workspaceFolders`·`extensionPath`(API), Claude 훅 입력(`transcript_path`·`session_id`·`hook.cwd`), `os.tmpdir()`. (다중 chatgpt/codex 확장 동시설치 시 첫 매칭 → `codexBridge.codexPath` override가 안전장치.)
- **✅ 구현됨(V11, 2026-06-20) — 잔여 1건**: `CODEX_HOME → SESSIONS_DIR·INDEX_FILE` (`codex-bridge.js`, `extension.ts`) + 의존하는 `findRolloutById`·`recentRollouts`·`newestRolloutSince`·watcher 전부. 루트 틀리면 후보/연결/`--allow-new`/삭제가 모두 헛돎. **구현 방식**: 확장 활성화 시 `syncCodexHome()`이 `codex doctor`의 `CODEX_HOME` 줄을 줄앵커 정규식으로 파싱→`~/.codex-bridge/codex-home.txt` 기록, 확장·브릿지 둘 다 `env.CODEX_HOME‖codex-home.txt(존재확인)‖~/.codex`로 해석. doctor에 home 출처·세션폴더 상태 진단. **잔여(다음 이슈)**: 세션폴더를 `CODEX_HOME/sessions`로 **가정**한다 — audit 원안인 "새 rollout이 실제 떨어진 루트 관찰"(`codex-sessions-dir.txt`)이 아니라서, codex가 비표준 세션경로를 쓰면 못 잡음(드묾·"세션폴더 못 찾음" 진단은 있음). → 실측 탐지로 견고화 남음.
- **중간 — `~/.codex-bridge` homedir 가정**: 그 하위 *전부*(`links.json`·`contracts/`·`contract.json`·`base-directive.json`·`codex-bin.txt`·`active.json`) + **확장이 동적 require하는 런타임 `contract-lib.js`**(`extension.ts:247-253`)가 "확장 호스트와 훅이 같은 `os.homedir()`를 본다"는 가정에 의존. 단일 사용자면 정합(현재 5파일 SHA 동일 확인). 조치: 문서화 + 선택적 `CODEX_BRIDGE_HOME` override + require stale 가드(이미 부분: 미발견 시 경고) + 원자적 저장(V7)을 이 파일들에 적용.
- **부분 견고 — workspace 키**: 훅 `active.json` + 확장이 자기 창 폴더 안에서만 active 채택으로 보강됨. 잔여 엣지 = `codex-bridge ask`가 다른 cwd에서 돌거나 `CLAUDE_PROJECT_DIR`이 훅/브릿지에 다르게 들어올 때.
- **dev 전용 하드코딩(런타임 무관·낮음)**: `make-screenshot.js:75` Edge 실행파일 경로 하드코딩(`C:/Program Files (x86)/...`), `package.json:54` `clean:vsix`의 `readdirSync('.')`(repo root 실행 가정). → env 탐색/문서화로 정리 가능(스크린샷 생성용이라 급하지 않음).

**우선순위(2026-06-20 갱신)**: ~~V11~~(구현됨) → **엉뚱 폴더/cwd 방어**(§8.1 1순위·실사고) ≫ **V11 잔여**(세션폴더 실측 탐지) ≫ homedir override/문서화·require 가드 ≈ V7 원자적 저장(이 파일들 포함) ≫ dev 하드코딩 정리. workspace 키는 잔여 엣지만 문서화.
