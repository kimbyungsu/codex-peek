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

## 3. 개선 우선순위 (종합)

1. **검증 "성공" 증명** (V1): 브릿지가 성공 시 증명 레코드를 남기고 verify-guard가 *문자열 대신 그것*을 검사.
   ```json
   { "claudeSession":"...", "workspace":"...", "turnId":"...", "codexSession":"...",
     "requestHash":"...", "responseHash":"...", "exit":0, "status":"success", "timestamp":"..." }
   ```
   강화: 현재 사용자 턴 이후 생성 / 현재 워크스페이스 일치 / exit 0 / 비어있지 않은 응답 / 최종 답변에 검증 결론 포함.
2. **실제 파일변경 감지** (V2): 툴 대신 턴 시작 시 `git status --porcelain`/`git diff --name-only` 스냅샷 → 종료 시 비교. 비-git이면 mtime/해시 스냅샷.
3. **세션 보관함/삭제** (§5.1): 저위험·고효용 → 먼저 체감됨.
4. **재검증 루프**: 구현→검증→실패→수정→재검증(최대 횟수 + 중단 조건).
5. **원자적 저장/잠금** (V7): `links.json`/계약 파일 temp+rename, 락, 버전 필드.
6. **역할 교체(오케스트레이터)** (§5.2, §6): 큰 재작성 — 준비되면 메이저 버전.
7. **테스트 + `npm test`** (V8): 커밋된 회귀 스위트 + CI 경로.

---

## 4. 사용자 의견 반영 (합의)
- **체크리스트 부작용**: 사용자가 켜고 끄고 규칙 수도 정하는 **운용 선택**이지 설계 결함 아님 → 우선순위 아님. 단 "자기보고는 준수의 증명이 아님"(=V1) 인식은 유지.
- **테스트**: 다른 개선의 후속이지만, 하네스 안전장치로서 V8은 우선순위에 둔다.

---

## 5. 추가 기능 설계

### 5.1 세션 보관함 (archive → trash → delete)
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
- [ ] **런타임 동기화** 결정: 이 PC `~/.codex-bridge/*.js`를 `eac17ab` 기준으로 갱신할지.
- [ ] 착수 항목 선택: 우선순위 **1(검증 증명) / 2(실변경 감지) / 3(세션 보관함)** 중.
- [ ] 진행 경로: codex-bridge(검증링크) 확장으로 Claude↔Codex 연결 후 구현→검증 루프로.

> 이 문서가 단일 기준점(source of truth)이다. 세션이 바뀌면 먼저 이 파일을 읽고 §8부터 이어간다.
