# Codex Bridge

Claude Code ↔ Codex(OpenAI) 를 **하나의 작업 흐름으로 잇는** 도구 모음입니다.
사람이 두 에이전트 사이에서 답을 복사·전달하지 않아도, **세션을 고정**하고 **고정 계약(규약)을 매 턴 주입**하며, 원하면 **구현→검증 2트랙**을 하니스가 강제합니다.

세 부분으로 구성됩니다.

| 구성 | 위치(런타임) | 역할 |
|---|---|---|
| **브릿지 엔진** | `~/.codex-bridge/codex-bridge.js` | Claude 세션 ↔ Codex 세션 연결을 영속 저장하고, 연결된 Codex 세션으로 `ask`(resume)·`link`·`status`·`find` |
| **훅(하니스 강제)** | `~/.codex-bridge/*.js` | `codex-guard`(raw codex 직접호출 차단) · `contract-inject`(계약 매 턴 주입) · `verify-guard`(검증 모드 시 종료 차단) |
| **VS Code 확장** | 이 저장소 루트 | 상태바·호버·대시보드로 연결 상태를 **보여주고**, 계약/체크박스를 **편집**하고, 연결을 **갈아끼움** |

확장만으로는 동작하지 않습니다. 엔진(`bridge/`)과 훅이 함께 있어야 합니다.

## 미리보기

![Codex Bridge 대시보드](docs/dashboard.png)

> 한 화면에 **Claude(구현) ⇄ Codex(검증)** 연결 상태(초록 라인=연결됨) · 검증 모드 배지 · 고정 계약 편집 · 실제 검증 대화가 모입니다.

```
🌉 Codex Bridge   Claude ⇄ Codex 자동 연결·검증                  [↻ 새로고침]

┌───────────────┐   ═══ 🔗 ═══   ┌───────────────┐
│      🤖       │    연결됨      │      ⚙️       │     ← 파랑 / 초록 테두리
│  Claude Code  │  (초록 라인)   │     Codex     │
│ 구현·implement │               │  검증·verify   │
└───────────────┘               └───────────────┘
 🔁 코드 변경 시 검증   · (주제 스니펫)   <codex 세션 id>        ← 검증모드 색 배지

고정 계약 · 매 턴 자동 주입
 ▏🤖 Claude 지침   [textarea]   ☑ 체크리스트 강제      ← 파란 좌측바
 ▏⚙️ Codex 규약    [textarea]   ☑ 체크리스트 강제      ← 초록 좌측바
 🔁 검증 모드 [ 꺼짐 / 코드 변경 시 / 플랜+코드 / 모든 턴 ]   [저장]

🔍 Codex 검증 대화 — 실제 주고받은 내용 (검증이 진짜 됐는지 눈으로 확인)
🔗 다른 Codex 세션에 연결
```

---

## 기능

### 1. 세션 고정 (링크)
- 연결은 `~/.codex-bridge/links.json` 에 **Claude 세션 id + 워크스페이스** 두 키로 영속 저장 → 재접속·압축·리로드에도 유지.
- `ask`: 연결된 Codex 세션으로 `resume`. **연결이 없으면 보고만** 하고 새 세션을 임의로 만들지 않음. 첫 소통만 `--allow-new` 로 명시 생성.
- raw `codex exec/resume` 직접 호출은 `codex-guard`(PreToolUse 훅)가 차단 → 모든 Codex 접근이 브릿지를 통과.

### 2. 고정 계약 (매 턴 주입)

대시보드에서 **Claude 지침**과 **Codex 규약**을 입력합니다. **규칙은 한 줄에 하나씩**(Enter로 구분) — 글자수와 무관하게 *줄 단위*로 끊으며, 각 줄이 개별 규칙(번호 1, 2, 3…)이 되어 `~/.codex-bridge/contract.json`에 저장됩니다.

- **Claude**: `contract-inject`(UserPromptSubmit 훅)가 매 턴 컨텍스트에 주입.
- **Codex**: 브릿지가 매 `ask` 프롬프트 앞에 prepend.
- 칸이 비면 주입하지 않습니다(토큰 비용 0).

**체크리스트 강제 체크박스**(Claude·Codex 각각)는 그 규칙들을 *어떻게* 주입할지 정합니다.

- **해제** — 규칙 텍스트만 상수로 주입:
  ```
  [고정 규약 · Claude Code · 매 턴 적용되는 상수]
  {"rules":[{"n":1,"r":"추측 말고 파일을 직접 읽어라"},{"n":2,"r":"완료 전 검증했는지 밝혀라"}]}
  ```
- **체크** — 같은 규칙들이 *점검 항목*으로 펼쳐지고, AI가 매 답변에 각 항목의 준수 여부+근거를 달도록 강제:
  ```
  [계약점검]
  - 1) <준수|위반|해당없음> — <한 줄 근거>
  - 2) <준수|위반|해당없음> — <한 줄 근거>
  ```

> 주입은 규칙을 매 턴 눈앞에 둬 "잊어버림"을 막지만, AI의 실제 준수를 100% 보장하진 않습니다(형식적 체크 가능). **강제 명시**이지 강제 이행은 아닙니다.

### 3. 검증 모드 (구현→검증 2트랙, opt-in · 기본 OFF)

대시보드 드롭다운으로 **국면별 4모드** 중 선택합니다. ON인 모드에서, 트리거가 걸린 턴은 `verify-guard`(Stop 훅)가 Claude의 종료를 막고, Claude가 `codex-bridge ask`로 Codex 검증을 받아 그 결과(통과/실패+근거)를 반영해 보고하도록 강제합니다(사람이 두 모델 사이를 중계하지 않음).

| 모드 | 검증을 강제하는 트리거 |
|---|---|
| **꺼짐(off)** | 강제 없음(기본). 평소 Claude 그대로 |
| **코드 변경 시(code)** | 파일 편집(`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) 발생 턴 |
| **플랜 확정 + 코드 변경 시(plancode)** | `ExitPlanMode`(플랜 확정) **또는** 파일 편집 발생 턴 |
| **모든 턴(always)** | 모든 응답 |

- **트리거는 transcript의 결정적 `tool_use` 신호(`ExitPlanMode`·편집 툴)만으로 판정** — 별도 모델 추론이 없어 추가 토큰·오탐이 없습니다.
- **전달 충실도**: 검증 요청은 요약/생략 없이 **실제 변경 파일 경로와 확인 지점**을 담도록 지시합니다. 브릿지는 그 요청을 **원문 그대로** Codex에 넘기고(요약 안 함), Codex는 같은 워크스페이스에서 **원본 파일을 직접 읽어** 검증합니다. Claude가 Codex에게 "빠르게/대충/요약" 식 축약 검증을 요청하는 것도 금지합니다.
- **검증 기본 원칙(항상 적용)**: 모든 `ask` 요청 앞에 고정 원칙이 붙습니다 — *"논리 구조만으로 단정 말고 코드·파일을 실제로 열어 확인, 검증 생략·요약·축약 금지(빠르게 요청받아도 충실히)."* 사용자 codex 계약과 별개로 **엔진(`withContract`)이 강제**하므로, 혹시 Claude가 sloppy하게 요청해도 **Codex 입력 단에서 방어**됩니다. (추가 규칙은 대시보드 codex 계약란에 자유롭게 더할 수 있음)
- **재판단(앵무새 방지)**: Claude는 Codex 답을 그대로 옮기지 않고, 타당성을 **다시 점검해 동의/반박을 근거와 함께 판단**한 최종 결론을 자기 책임으로 보고합니다. 이때 근거는 논리 추정이 아니라 **코드·파일에서 직접 확인 가능한 사실**로 제시하도록 지시합니다. (단, 지시 기반이라 100% 이행 보장은 아님 — 대시보드에서 실제 수행 여부 확인 가능)
- 안전장치: `stop_hook_active`로 **턴당 1회만** 강제 → Codex가 응답 못 해도 작업이 무한 정지하지 않습니다.
- 구버전 `contract.json`의 `verify: true`는 자동으로 `code` 모드로 해석됩니다(하위호환).

### 4. 시각화 (확장)
- **상태바**: 연결된 Codex 세션 주제 / 미연결.
- **호버**: 세션 id·주제·연결시각·마지막 활동.
- **대시보드**(클릭): 연결 상태, 연결 세션의 최근 N턴, 후보 세션 목록(첫 발화로 식별)+`[연결]`, 계약 편집칸+체크박스, 새로고침. `links.json`·`~/.codex/sessions` 변경 자동 감지.
- 대시보드·상태바는 **지금 Claude가 실제 도는 폴더**(훅이 `~/.codex-bridge/active.json`에 기록)를 따라가므로 **보여주는 세션 = 검증이 실제 가는 세션**이 일치합니다(열린 폴더가 여러 개여도 어긋나지 않음). 어느 폴더 기준인지는 📁 칩으로 표시됩니다.

### 5. Codex 실행 파일 탐색 + 진단(doctor)
브릿지는 codex 바이너리를 **경로로 뒤지지 않고** 다음 순서로 해석합니다(설치 형태·잦은 버전 업데이트에 안 깨짐):
1. 환경변수 `CODEX_BIN` (직접 지정)
2. VS Code 설정 `codexBridge.codexPath` — 비우면 **설치된 Codex 확장(`openai.chatgpt` 등) 내부의 codex를 확장이 vscode API로 자동 탐색**해 기록(포터블/설치형·버전 무관, 활성화마다 갱신)
3. `PATH` 의 `codex` (CLI 설치 표준; Windows `.cmd`는 셸 경유, 프롬프트는 stdin이라 따옴표 안전)

진단: `node ~/.codex-bridge/codex-bridge.js doctor` → 지금 **어떤 codex를 어디서 쓰는지·실행 가능 여부·연결 상태**를 한 번에 표시(막혔을 때 추측 대신 이것부터).

---

## 설치

### 1) 브릿지 엔진·훅 배치
`bridge/` 의 `.js` 파일들을 홈의 `~/.codex-bridge/` 로 복사합니다.

```bash
mkdir -p ~/.codex-bridge
cp bridge/*.js ~/.codex-bridge/
```

`contract.example.json` 을 참고해 `~/.codex-bridge/contract.json` 을 만들거나, 대시보드에서 작성합니다.

### 2) 훅 등록
`settings.example.json` 의 `hooks` 블록을 Claude Code `~/.claude/settings.json` 에 병합합니다.
`<HOME>` 을 실제 홈 경로(예: `C:/Users/이름`)로 바꾸고, 기존 다른 훅은 보존하세요.

> **글로벌(`~/.claude/settings.json`)에 넣어도 안전합니다 — 프로젝트별로 반복 설정할 필요 없음.** 훅은 항상 등록돼 있되, 실제 동작·비용은 **전적으로 확장 대시보드(고정 계약 / 검증 모드)가 제어**하기 때문입니다:
> - `codex-guard` — 직접 `codex` 호출 가드. **모델 토큰 0**(통과/차단만).
> - `verify-guard` — 검증 모드가 **꺼짐이면 즉시 no-op**. 켰을 때만, 고른 트리거에서 동작.
> - `contract-inject` — **대시보드 계약 칸에 적은 줄만** 주입. 칸을 비우면 주입 0.
>
> 즉 기본/비활성 상태에서는 글로벌이어도 사실상 무비용이고, 무엇을 켤지는 `settings.json` 을 건드리지 않고 대시보드에서 토글합니다. (에이전트로 설치를 자동화할 때 "글로벌 훅이 매 턴 비용 아니냐"는 우려가 불필요한 이유)

### 3) 확장 설치
```bash
npm install
npm run package
code --install-extension codex-bridge-*.vsix --force
```
설치 후 `Developer: Reload Window`.

> Codex 실행 파일은 OpenAI ChatGPT VS Code 확장(`openai.chatgpt-*`)의 `codex` 바이너리를 자동 탐색합니다. 필요 시 `CODEX_BIN` 환경변수로 지정하세요.

---

## CLI (브릿지 직접 사용)

```bash
node ~/.codex-bridge/codex-bridge.js ask "<프롬프트>"        # 연결 세션에 보내고 답 받기(없으면 보고)
node ~/.codex-bridge/codex-bridge.js ask --allow-new "<...>" # 첫 소통: 새 세션 생성+연결
node ~/.codex-bridge/codex-bridge.js link <codex-session-id> # 기존 Codex 세션에 연결
node ~/.codex-bridge/codex-bridge.js link --last             # 가장 최근 세션에 연결
node ~/.codex-bridge/codex-bridge.js status | find           # 상태 / 후보 목록
```

---

## 읽기 전용·안전 원칙
- 대화 내용(`~/.codex/sessions`)은 **읽기만** 합니다. 쓰는 것은 `links.json`·`contract.json`(연결/계약)뿐.
- `links.json`(세션 id·로컬 경로)·`contract.json`(개인 규약)은 런타임 데이터로 **저장소에서 제외**됩니다(`.gitignore`).
- 검증 모드는 opt-in이며 Stop 훅 강제는 1회로 제한되어 작업이 멈추는 사고를 내지 않습니다.

## 라이선스
MIT — `LICENSE` 참조.
