# Codex Peek

Codex CLI 세션의 **마지막 출력**과 **최근 N턴 대화**를 VS Code 안에서 바로 확인하는 확장입니다.
Claude Code 등 다른 도구에서 작업하면서 **Codex가 방금 뭐라고 했는지** 빠르게 들여다볼 때 유용합니다.

- **읽기 전용**: 로컬 `~/.codex/sessions/**/rollout-*.jsonl` 세션 파일만 읽습니다. 별도 로그인·네트워크 없음.
- **자동 선택**: 가장 최근에 수정된 세션(=활성 세션)을 자동으로 잡습니다.

## 기능 / 명령

명령 팔레트(`Ctrl+Shift+P`):

- **Codex Peek: 대화 보기 (최근 N턴)** — 패널을 열어 최근 대화를 표시. 턴 수 조절 + 새로고침.
- **Codex Peek: 마지막 출력만 보기** — Codex의 마지막 답변만 빠르게.
- **Codex Peek: 새로고침** — 현재 패널 다시 읽기.

## 설정

- `codexPeek.codexHome`: Codex 홈 경로. 비우면 `CODEX_HOME` 또는 `~/.codex`.
- `codexPeek.defaultTurns`: 기본 표시 턴 수 (기본 5).

## 설치

```powershell
code --install-extension (Get-ChildItem codex-peek-*.vsix | Sort-Object Name | Select-Object -Last 1).FullName --force
```

또는 확장 패널 → `...` → `Install from VSIX...` 후 `Developer: Reload Window`.

## 동작 방식

Codex는 세션을 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 에 기록하며, 각 줄의 `response_item`(role `user`/`assistant`, `input_text`/`output_text`)에 대화가 담깁니다. 이 확장은 그중 가장 최근 파일을 읽어 시스템 주입 컨텍스트를 걸러내고 사람이 보기 좋게 턴 단위로 보여줍니다.
