# 호환성 (Compatibility)

이 도구가 **어떤 환경에서 동작하고, 무엇이 바뀌면 깨질 수 있는지**를 적습니다.

## 지원 환경

| 항목 | 범위 | 비고 |
|------|------|------|
| OS | Windows · macOS · Linux | 설치기는 `install.cmd`(Windows)와 `install.sh`(POSIX) 제공. CI는 Windows+Ubuntu에서 검사. |
| Node.js | 20 이상 권장 | CI는 Node 20, 개발은 22에서 확인. 브릿지·훅은 순수 Node(내장 모듈만). |
| VS Code | `^1.96.0` | `package.json`의 engines 기준. |
| Claude Code | 훅을 지원하는 버전 | 아래 "Claude Code에 기대는 것" 참고. |
| Codex CLI | `codex exec` / `codex exec resume` 지원 버전 | 아래 "Codex에 기대는 것" 참고. |

## Claude Code에 기대는 것

- 3개 훅 지점: 입력 시(UserPromptSubmit), Bash 실행 전(PreToolUse), 완료 시(Stop)
- 훅에 전달되는 값: 작업 폴더·세션 ID·대화기록 경로(`CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `transcript_path`), 그리고 훅 입력 JSON
- 이 인터페이스가 바뀌면: 계약 주입·검증 가드가 영향을 받습니다.

## Codex에 기대는 것 (가장 깨지기 쉬운 부분)

이 도구는 코덱스의 **내부 형식**에 의존합니다. 코덱스 업데이트로 다음이 바뀌면 깨질 수 있습니다:

- **세션 기록 위치/형식** — 코덱스 홈(`$CODEX_HOME`, 기본 `~/.codex`) 아래 `sessions/`의 `rollout-*.jsonl`. 파일명 규칙·폴더 구조·JSON 줄 형식이 바뀌면 세션 목록·최근 대화 표시가 깨질 수 있습니다.
- **홈 경로 탐지** — `codex doctor` 출력의 `CODEX_HOME  <경로> (dir)` 줄을 정규식으로 읽습니다. 이 출력 문구가 바뀌면 자동 탐지가 실패합니다(그때는 `CODEX_HOME` 환경변수로 직접 지정 가능).
- **실행 명령** — `codex exec` / `codex exec resume`. 명령 체계가 바뀌면 검증 요청이 실패합니다.

### 깨졌을 때 진단

- `node ~/.codex-bridge/codex-bridge.js doctor` — 코덱스 홈, 세션 폴더 존재 여부, 탐지 출처를 보여줍니다. 세션이 안 보이면 여기를 1순위로 확인하세요.
- 세션 폴더는 못 찾았는데 코덱스 홈 하위 다른 곳에 기록이 있으면, 자동으로 바꾸지 않고 **진단으로만 알립니다**(잘못된 자동 전환 방지).

## 경로·환경 적응 / 비적응

- **잘 적응**: 실행 경로, 코덱스 홈(`CODEX_HOME`), 브릿지 홈(`CODEX_BRIDGE_HOME`), 설치 위치 — 환경변수로 재지정 가능.
- **PC를 넘어 자동 승계되지 않음**: 프로젝트별 규칙은 *작업 폴더의 절대경로*로 식별됩니다. 같은 저장소라도 PC마다 경로가 다르면 다른 규칙 파일을 보게 됩니다. "같은 프로젝트 규칙이 여러 PC에서 이어지는" 동기화는 현재 범위 밖입니다.

## WSL · 원격 · 컨테이너

명시적으로 검증된 환경은 위 표 기준이며, WSL/Remote/Container에서는 Claude Code 훅과 코덱스 CLI가 **같은 파일 시스템·홈을 보도록** 맞춰져 있어야 합니다(브릿지 홈과 코덱스 홈이 한쪽에만 있으면 세션을 못 찾습니다). 이 조합은 아직 폭넓게 검증되지 않았습니다.
