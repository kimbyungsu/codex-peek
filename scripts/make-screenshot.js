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

// 3) 현재 UI(연결됨·검증 진행 중·두뇌설정 등) 샘플로 채운 body — extension.ts 본문 구조/클래스에 맞춤
const body = `<main class="shell">
  <div class="top"><h1><span class="brand"></span>Codex Bridge <span class="sub">Claude ⇄ Codex 자동 연결·검증</span></h1><button class="secondary">↻ 새로고침</button></div>

  <div class="hero">
    <div class="agent claude"><div class="mono c">C</div><div class="nm">Claude</div><div class="ro">구현 · implement</div></div>
    <div class="link on"><div class="bar"></div><div class="emo">●</div><div class="st">연결됨</div></div>
    <div class="agent codex"><div class="mono x">Cx</div><div class="nm">Codex</div><div class="ro">검증 · verify</div></div>
  </div>
  <div class="statusline"><span class="badge b-code">코드 변경 시 검증</span><span class="wschip">D:/codex-peek</span><span class="muted">· 결제 모듈 리팩터 검증</span><span class="id">019b…a2f</span></div>

  <div class="livestrip" style="display:block">
    <div class="lsflow">
      <span class="lsbox claude">Claude</span>
      <span class="lsarrow tocodex">▶▶▶ 검증중</span>
      <span class="lsbox codex on">Codex</span>
    </div>
    <div class="lsstage"><span class="lschip codex-gen">Codex 생성중 · 2라운드</span></div>
  </div>

  <h2 class="sec claude">Claude 규칙 <span class="to claude">→ Claude에게</span> <span class="sub2">Claude가 지킬 행동규칙 — 검증과 별개</span></h2>
  <div class="card">
    <div class="cblock claude">
      <div class="chead">규칙 <span class="muted" style="font-weight:400">· 기본 원칙 말고, 이 프로젝트에만 필요한 것</span></div>
      <textarea rows="2">추측 말고 관련 파일을 직접 읽고 사실로 답하라
보고는 기술용어 빼고 상황 예시로 정리하라</textarea>
      <div class="rulemeta"><span class="rchip opt">선택</span><span class="rchip">⏎ 한 줄 = 규칙 1개</span><span class="rchip">∅ 비우면 안 붙음</span></div>
      <label class="ck"><input type="checkbox" checked> 체크리스트 강제 — 각 규칙마다 [준수/위반+근거] 달게 함</label>
    </div>
    <label class="ck verify">넣는 시점 — 이 규칙을 <b>언제</b> Claude에 넣을지
      <span class="seg"><button type="button">꺼짐<small>안 넣음</small></button><button type="button">플랜 모드<small>플랜 때만</small></button><button type="button" class="on">항상<small>매 턴</small></button></span>
    </label>
  </div>

  <h2 class="sec codex">검증 <span class="to codex">→ Codex</span> <span class="sub2">Codex에게 검증받기 — 끄면 검증만 안 함(Claude 규칙은 별개)</span></h2>
  <div class="card">
    <div class="cblock codex">
      <div class="chead">Codex 규칙 <span class="muted" style="font-weight:400">· 이 프로젝트에서 특히 볼 것 · 검증 때마다 붙음</span></div>
      <textarea rows="2">동시성·레이스 컨디션을 중점으로 봐라
결제·정산은 중복 청구·반올림 오차·롤백까지 확인해라</textarea>
      <div class="rulemeta"><span class="rchip opt">선택</span><span class="rchip">⏎ 한 줄 = 규칙 1개</span><span class="rchip">∅ 비우면 안 붙음</span></div>
      <label class="ck"><input type="checkbox" checked> 체크리스트 강제 — 검증 답에 규칙별 [준수/위반+근거] 달게 함</label>
    </div>
    <label class="ck verify">검증 모드 — <b>언제</b> Codex 검증→보고를 강제할지
      <span class="seg"><button type="button">꺼짐<small>강제 안 함</small></button><button type="button" class="on">코드 변경 시<small>편집한 턴</small></button><button type="button">플랜 확정/코드 변경<small>플랜·편집 턴</small></button><button type="button">모든 턴<small>매 응답</small></button></span>
    </label>
    <div class="stagebox">
      <div class="sbhead">↑ 위 검증을 켜면 <b>흐름 단계마다 '단계별 기본 원칙'</b>이 적용돼요 <span class="muted" style="font-weight:400">· 지금 검증: <b>코드 변경 시</b></span></div>
      <div class="sbrow on"><span class="sbmark">✓</span><b>① Claude→Codex 넘길 때</b> · 전달 원칙 <span class="who2 claude">Claude</span></div>
      <div class="sbrow on"><span class="sbmark">✓</span><b>② Codex가 검증할 때</b> · 검증 기본원칙 + Codex 규칙 <span class="who2 codex">Codex</span></div>
      <div class="sbrow on"><span class="sbmark">✓</span><b>③ Codex 답을 되짚을 때</b> · 재판단 원칙 <span class="who2 claude">Claude</span></div>
    </div>
  </div>
  <div class="row"><button>저장</button><span class="muted">· 위 Claude 규칙 · Codex 규칙 · 검증 모드를 함께 저장</span></div>

  <h2 class="sec">한눈에 보기 <span class="sub2">누구에게 · 뭐가 · 언제 들어가나 — 지금 저장된 설정 기준</span></h2>
  <section class="flowmap card">
    <div class="flow">
      <div class="fnode rule">Claude<br>규칙</div>
      <div class="farrow"><span class="lbl">넣는 시점<br><b>항상</b></span><span class="ln"></span></div>
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>구현</small></div>
      <div class="farrow"><span class="lbl">검증 맡김<br><b>코드 변경 시</b></span><span class="ln"></span></div>
      <div class="fnode actor codex"><span class="mono x">Cx</span>Codex<small>검증</small></div>
    </div>
  </section>

  <h2 class="sec base">코덱스 두뇌 설정 <span class="sub2">이 프로젝트에서 코덱스가 쓰는 모델·생각강도 (진행 중 대화에도 적용)</span></h2>
  <div class="mcard">
    <div class="muted">지금 쓰는 값(최근 기록): <b>GPT-5.5 · 생각강도 높음</b></div>
    <div class="mrow"><span class="mlbl">모델</span>
      <select><option>GPT-5.5 (gpt-5.5)</option><option>GPT-5.4 (gpt-5.4)</option><option>GPT-5.4-mini (gpt-5.4-mini)</option></select>
    </div>
    <div class="mrow"><span class="mlbl">생각강도</span>
      <span class="seg"><button type="button">기본</button><button type="button">낮음</button><button type="button">보통</button><button type="button" class="on">높음</button><button type="button">매우높음</button></span>
    </div>
    <div class="row" style="margin-top:10px"><button>두뇌 설정 저장</button></div>
  </div>

  <h2 class="sec base">검증 대기시간 <span class="sub2">코덱스 검증을 기다리는 한도 — 추론이 길면 늘리세요 (전역·모든 프로젝트 공통)</span></h2>
  <div class="mcard">
    <div class="mrow"><span class="mlbl">대기시간</span><input type="number" value="20" style="width:72px"> <span class="muted">분 · 기본 8</span></div>
    <div class="row" style="margin-top:10px"><button>대기시간 저장</button></div>
    <div class="muted" style="margin-top:6px">코덱스가 답하는 데 이 시간보다 오래 걸리면 검증이 실패로 끝나요. 추론이 8분을 넘는 경우가 있으면 늘려 두세요.</div>
  </div>

  <h2 class="sec codex">Codex 검증 대화 <span class="sub2">실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인</span></h2>
  <div class="turn">
    <div class="umsg">src/payment.ts 의 applyDiscount() 변경 검증해줘 — 음수 할인율 방어 포함</div>
    <div class="vmsg"><div class="vhead"><span class="vname">Codex</span><span class="vchip pass">검증 통과</span></div><div class="vbody">검증: 통과 — applyDiscount()는 rate&lt;0 이면 0으로 클램프함(payment.ts:42). 다만 rate&gt;1(100% 초과)은 미검사 → 상한 클램프 권장.</div></div>
  </div>

  <h2 class="sec base">Codex 세션 연결 <span class="sub2">첫 발화로 식별</span></h2>
  <div class="cand linked"><div><div class="id">019b…a2f <span class="star">★ 연결됨</span></div><div class="muted">2026-06-22 · 결제 모듈 리팩터 검증</div></div></div>
  <div class="cand"><div><div class="id">019a…7c1</div><div class="muted">2026-06-21 · 인증 토큰 만료 처리</div></div><button>연결</button></div>
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
  "--force-device-scale-factor=2", "--window-size=980,2120",
  "--default-background-color=1f1f1fff",
  `--screenshot=${png}`, fileUrl,
], { encoding: "utf8", timeout: 60000 });
if (r.error) throw r.error;
try { fs.unlinkSync(htmlFile); } catch {}
const ok = fs.existsSync(png) && fs.statSync(png).size > 0;
console.log(ok ? `OK → ${png} (${Math.round(fs.statSync(png).size / 1024)}KB)` : "FAILED: PNG 생성 안 됨\n" + (r.stderr || ""));
