// README용 대시보드 스크린샷 생성기.
//  - src/extension.ts 의 <style> 블록(실제 CSS)을 그대로 추출(드리프트 방지)
//  - VS Code Dark+ 테마 변수를 :root 로 주입(웹뷰 밖에서도 색이 맞게)
//  - 연결됨 + 검증 대화가 보이는 샘플 상태로 채운 화면을 Edge 헤드리스로 캡처
// 사용: node scripts/make-screenshot.js  →  docs/dashboard.png
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const docs = path.join(root, "docs");
fs.mkdirSync(docs, { recursive: true });

// 1) 실제 CSS 추출
const ext = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const m = ext.match(/<style>([\s\S]*?)<\/style>/);
if (!m) throw new Error("extension.ts 에서 <style> 블록을 못 찾음");
const css = m[1];

// 2) 테마 변수(Dark+) 주입
const theme = `:root{
  --vscode-foreground:#cccccc; --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#cccccc;
  --vscode-panel-border:#3c3c3c; --vscode-descriptionForeground:#9d9d9d; --vscode-sideBar-background:#181818;
  --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7; --vscode-charts-green:#89d185; --vscode-charts-orange:#d18616;
  --vscode-input-background:#2a2a2a; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
  --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#ffffff;
  --vscode-dropdown-background:#2a2a2a; --vscode-dropdown-foreground:#cccccc; --vscode-dropdown-border:#3c3c3c;
  --vscode-textCodeBlock-background:#2a2a2a; --vscode-editor-font-family:"Cascadia Code",Consolas,monospace;
  --vscode-font-family:"Segoe UI","Malgun Gothic",sans-serif; --vscode-font-size:13px;
}`;

// 3) 연결됨 + 검증 대화 샘플로 채운 body (렌더 결과 형태)
const body = `<main class="shell">
  <div class="top"><h1>🌉 Codex Bridge <span class="sub">Claude ⇄ Codex 자동 연결·검증</span></h1><button class="secondary">↻ 새로고침</button></div>
  <div class="hero">
    <div class="agent claude"><div class="emo">🤖</div><div class="nm">Claude Code</div><div class="ro">구현 · implement</div></div>
    <div class="link on"><div class="bar"></div><div class="emo">🔗</div><div class="st">연결됨</div></div>
    <div class="agent codex"><div class="emo">⚙️</div><div class="nm">Codex</div><div class="ro">검증 · verify</div></div>
  </div>
  <div class="statusline"><span class="badge b-code">🔁 코드 변경 시 검증</span><span class="muted">· 결제 모듈 리팩터 검증</span><span class="id">session-01 · 019b…a2f</span></div>
  <h2>고정 계약 · 매 턴 자동 주입</h2>
  <div class="card">
    <div class="cblock claude">
      <div class="chead">🤖 Claude 지침 <span class="muted" style="font-weight:400">· 매 턴 주입</span></div>
      <textarea rows="2">추측하지 말고 관련 파일을 직접 읽고 사실로 답하라
완료라고 보고하기 전에 실제로 검증했는지 한 줄로 밝혀라</textarea>
      <label class="ck"><input type="checkbox" checked> 체크리스트 강제 — 각 규칙마다 [준수/위반+근거] 달게 함</label>
      <div class="hint">☑ 켜짐 → 답변 끝에 <code>[계약점검] 1) 준수 — &lt;근거&gt; / 2) 위반 — &lt;근거&gt;</code> 형식으로 규칙별 자가보고를 강제 · ☐ 꺼짐 → 규칙 텍스트만 주입</div>
    </div>
    <div class="cblock codex" style="margin-top:14px">
      <div class="chead">⚙️ Codex 규약 <span class="muted" style="font-weight:400">· ask마다 prepend</span></div>
      <textarea rows="2">검증 답변은 첫 줄을 '검증: 통과' 또는 '검증: 실패'로 시작하라
근거에 구체적 사실 또는 파일 경로를 최소 1개 포함하라</textarea>
      <label class="ck"><input type="checkbox" checked> 체크리스트 강제 — 검증 답에 규칙별 [준수/위반+근거] 달게 함</label>
      <div class="hint">☑ 켜짐 → Codex 검증 답에도 규칙별 <code>[계약점검]</code> 자가보고 강제 · ☐ 꺼짐 → 규약 텍스트만 prepend</div>
    </div>
    <label class="ck verify">🔁 검증 모드 — 트리거 턴에 Codex 검증→보고를 Stop 훅이 강제
      <select style="margin-left:8px"><option>코드 변경 시</option></select></label>
    <div class="hint"><b>꺼짐</b> 강제 안 함 · <b>코드 변경 시</b> 파일 편집한 턴 · <b>플랜+코드</b> 플랜 확정(ExitPlanMode)이나 편집한 턴 · <b>모든 턴</b> 매 응답. 트리거 턴엔 Codex 검증을 받고 그 결과를 반영해 보고해야 종료 가능.</div>
    <div class="row"><button>저장</button><span class="muted">저장됨 ✓ (다음 턴부터 적용)</span></div>
  </div>
  <h2>🔍 Codex 검증 대화 <span class="sub2">실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인</span></h2>
  <div class="card"><div class="role">👤 사용자</div><div class="text">src/payment.ts 의 applyDiscount() 변경 검증해줘 — 음수 할인율 방어 포함</div><div class="role">🤖 Codex</div><div class="text">검증: 통과 — applyDiscount()는 rate&lt;0 이면 0으로 클램프함(payment.ts:42). 다만 rate&gt;1(100% 초과)은 미검사 → 상한 클램프 권장.</div></div>
  <h2>🔗 다른 Codex 세션에 연결 <span class="sub2">첫 발화로 식별</span></h2>
  <div class="cand linked"><div><div class="id">session-01 <span class="star">★연결됨</span></div><div class="muted">2026-06-18 오전 10:14 · 결제 모듈 리팩터 검증</div></div></div>
  <div class="cand"><div><div class="id">session-02</div><div class="muted">2026-06-17 오후 9:02 · 인증 토큰 만료 처리</div></div><button>연결</button></div>
</main>`;

const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><style>${theme}\n${css}</style></head><body>${body}</body></html>`;
const htmlFile = path.join(docs, "_preview.html");
fs.writeFileSync(htmlFile, html, "utf8");

// 4) Edge 헤드리스 캡처
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const png = path.join(docs, "dashboard.png");
const fileUrl = "file:///" + htmlFile.replace(/\\/g, "/");
const r = spawnSync(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=2", "--window-size=980,1120",
  "--default-background-color=1f1f1fff",
  `--screenshot=${png}`, fileUrl,
], { encoding: "utf8", timeout: 60000 });
if (r.error) throw r.error;
try { fs.unlinkSync(htmlFile); } catch {}
const ok = fs.existsSync(png) && fs.statSync(png).size > 0;
console.log(ok ? `OK → ${png} (${Math.round(fs.statSync(png).size / 1024)}KB)` : "FAILED: PNG 생성 안 됨\n" + (r.stderr || ""));
