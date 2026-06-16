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

---

## 기능

### 1. 세션 고정 (링크)
- 연결은 `~/.codex-bridge/links.json` 에 **Claude 세션 id + 워크스페이스** 두 키로 영속 저장 → 재접속·압축·리로드에도 유지.
- `ask`: 연결된 Codex 세션으로 `resume`. **연결이 없으면 보고만** 하고 새 세션을 임의로 만들지 않음. 첫 소통만 `--allow-new` 로 명시 생성.
- raw `codex exec/resume` 직접 호출은 `codex-guard`(PreToolUse 훅)가 차단 → 모든 Codex 접근이 브릿지를 통과.

### 2. 고정 계약 (매 턴 주입)
- 대시보드에 **Claude 지침**·**Codex 규약**을 한 줄=한 항목으로 입력 → `~/.codex-bridge/contract.json`.
- **Claude**: `contract-inject`(UserPromptSubmit 훅)가 매 턴 압축 JSON으로 주입.
- **Codex**: 브릿지가 매 `ask` 프롬프트 앞에 prepend.
- **체크리스트 체크박스(항목별)**: 해제 → 규약만 주입 / 체크 → `[계약점검]` TODO로 펼쳐 각 항목에 `준수/위반+근거` 강제.

### 3. 검증 모드 (구현→검증 2트랙, opt-in)
- 대시보드 체크박스로 on/off. 기본 off.
- on: 파일을 변경한 턴은 `verify-guard`(Stop 훅)가 종료를 막고, Claude가 `codex-bridge ask`로 Codex 검증을 받아 결과를 반영해 보고하도록 강제. `stop_hook_active`로 **1회만** 강제(무한루프 방지).

### 4. 시각화 (확장)
- **상태바**: 연결된 Codex 세션 주제 / 미연결.
- **호버**: 세션 id·주제·연결시각·마지막 활동.
- **대시보드**(클릭): 연결 상태, 연결 세션의 최근 N턴, 후보 세션 목록(첫 발화로 식별)+`[연결]`, 계약 편집칸+체크박스, 새로고침. `links.json`·`~/.codex/sessions` 변경 자동 감지.

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
