@echo off
REM codex-bridge 설치 런처 (Windows 더블클릭/명령창)
REM 실제 작업은 install.js(node 코어)가 한다.
where node >nul 2>nul
if errorlevel 1 (
  echo [X] node 를 찾을 수 없습니다. Node.js 설치 후 다시 실행하세요.
  exit /b 1
)
node "%~dp0install.js" %*
