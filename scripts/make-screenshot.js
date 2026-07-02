// README용 대시보드 스크린샷 생성기 (한/영).
//  - src/extension.ts 의 <style> 블록(실제 CSS)을 그대로 추출(드리프트 방지)
//  - VS Code Dark+ 테마 변수를 :root 로 주입(웹뷰 밖에서도 색이 맞게)
//  - 연결됨 + 검증 대화가 보이는 샘플 상태로 채운 화면을 Edge 헤드리스로 캡처
// 사용: node scripts/make-screenshot.js        →  docs/dashboard.png    (한글 — 깃헙 README)
//       node scripts/make-screenshot.js --en   →  docs/dashboard.en.png (영문 — 마켓 README.en.md)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const EN = process.argv.includes("--en");
const t = (ko, en) => (EN ? en : ko); // 문구 선택(레이아웃은 동일)

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
  --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7; --vscode-charts-green:#89d185; --vscode-charts-orange:#d18616; --vscode-charts-yellow:#d7ba7d;
  --vscode-input-background:#2a2a2a; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
  --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#ffffff;
  --vscode-dropdown-background:#2a2a2a; --vscode-dropdown-foreground:#cccccc; --vscode-dropdown-border:#3c3c3c;
  --vscode-editorWidget-background:#252526;
  --vscode-textCodeBlock-background:#2a2a2a; --vscode-editor-font-family:"Cascadia Code",Consolas,monospace;
  --vscode-font-family:"Segoe UI","Malgun Gothic",sans-serif; --vscode-font-size:13px;
}`;

// 3) 현재 UI 샘플 body — extension.ts 본문 구조/클래스에 맞춤(탭바 포함). 문구만 t()로 한/영 전환.
const body = `<main class="shell">
  <nav class="tabbar">
    <button type="button" class="tabbtn active">${t("📋 현황", "📋 Status")}</button>
    <button type="button" class="tabbtn">${t("📊 검증 통계", "📊 Verify stats")}</button>
  </nav>
  <div class="top"><h1><span class="brand"></span>Codex Bridge <span class="sub">${t("Claude ⇄ Codex 자동 연결·검증", "Claude ⇄ Codex auto link & verify")}</span></h1><button class="secondary">↻ ${t("새로고침", "Refresh")}</button></div>

  <div class="hero">
    <div class="agent claude"><div class="mono c">C</div><div class="nm">Claude</div><div class="ro">${t("구현 · implement", "implement")}</div></div>
    <div class="link on"><div class="bar"></div><div class="emo">●</div><div class="st">${t("연결됨", "Linked")}</div></div>
    <div class="agent codex"><div class="mono x">Cx</div><div class="nm">Codex</div><div class="ro">${t("검증 · verify", "verify")}</div></div>
  </div>
  <div class="statusline"><span class="badge b-code">${t("코드 변경 시 검증", "Verify on code change")}</span><span class="wschip">D:/codex-peek</span><span class="muted">· ${t("결제 모듈 리팩터 검증", "payment module refactor")}</span><span class="id">019b…a2f</span></div>

  <div class="livestrip" style="display:block">
    <div class="lsflow">
      <span class="lsbox claude">Claude</span>
      <span class="lsarrow tocodex">▶▶▶ ${t("검증중", "verifying")}</span>
      <span class="lsbox codex on">Codex</span>
    </div>
    <div class="lsstage"><span class="lschip codex-gen">${t("Codex 생성중 · 2라운드", "Codex generating · round 2")}</span></div>
  </div>

  <h2 class="sec claude">${t("Claude 규칙", "Claude rules")} <span class="to claude">${t("→ Claude에게", "→ to Claude")}</span> <span class="sub2">${t("Claude가 지킬 행동규칙 — 검증과 별개", "Behavior rules for Claude — separate from verification")}</span></h2>
  <div class="card">
    <div class="cblock claude">
      <div class="chead">${t("규칙", "Rules")} <span class="muted" style="font-weight:400">· ${t("기본 원칙 말고, 이 프로젝트에만 필요한 것", "project-specific only (base principles live below)")}</span></div>
      <textarea rows="2">${t("추측 말고 관련 파일을 직접 읽고 사실로 답하라\n보고는 기술용어 빼고 상황 예시로 정리하라", "Read the actual files instead of guessing; answer with facts\nReport with plain-language examples, not jargon")}</textarea>
      <div class="rulemeta"><span class="rchip opt">${t("선택", "optional")}</span><span class="rchip">${t("⏎ 한 줄 = 규칙 1개", "⏎ one line = one rule")}</span><span class="rchip">${t("∅ 비우면 안 붙음", "∅ empty = nothing injected")}</span></div>
      <label class="ck"><input type="checkbox" checked> ${t("체크리스트 강제 — 각 규칙마다 [준수/위반+근거] 달게 함", "Enforce checklist — [complied/violated + evidence] per rule")}</label>
    </div>
    <label class="ck verify">${t("넣는 시점 — 이 규칙을 <b>언제</b> Claude에 넣을지", "Injection timing — <b>when</b> to inject these rules")}
      <span class="seg"><button type="button">${t("꺼짐<small>안 넣음</small>", "Off<small>never</small>")}</button><button type="button">${t("플랜 모드<small>플랜 때만</small>", "Plan mode<small>plan only</small>")}</button><button type="button" class="on">${t("항상<small>매 턴</small>", "Always<small>every turn</small>")}</button></span>
    </label>
  </div>

  <h2 class="sec codex">${t("검증", "Verification")} <span class="to codex">→ Codex</span> <span class="sub2">${t("Codex에게 검증받기 — 끄면 검증만 안 함(Claude 규칙은 별개)", "Get verified by Codex — off disables verification only")}</span></h2>
  <div class="card">
    <div class="cblock codex">
      <div class="chead">${t("Codex 규칙", "Codex rules")} <span class="muted" style="font-weight:400">· ${t("이 프로젝트에서 특히 볼 것 · 검증 때마다 붙음", "what to focus on · attached to every verification")}</span></div>
      <textarea rows="2">${t("동시성·레이스 컨디션을 중점으로 봐라\n결제·정산은 중복 청구·반올림 오차·롤백까지 확인해라", "Focus on concurrency & race conditions\nFor billing: double-charge, rounding, rollback paths")}</textarea>
      <div class="rulemeta"><span class="rchip opt">${t("선택", "optional")}</span><span class="rchip">${t("⏎ 한 줄 = 규칙 1개", "⏎ one line = one rule")}</span><span class="rchip">${t("∅ 비우면 안 붙음", "∅ empty = nothing injected")}</span></div>
      <label class="ck"><input type="checkbox" checked> ${t("체크리스트 강제 — 검증 답에 규칙별 [준수/위반+근거] 달게 함", "Enforce checklist in verification answers")}</label>
    </div>
    <label class="ck verify">${t("검증 모드 — <b>언제</b> Codex 검증→보고를 강제할지", "Verify mode — <b>when</b> to force verify→report")}
      <span class="seg"><button type="button">${t("꺼짐<small>강제 안 함</small>", "Off<small>not forced</small>")}</button><button type="button" class="on">${t("코드 변경 시<small>편집한 턴</small>", "On code change<small>edited turns</small>")}</button><button type="button">${t("플랜 확정/코드 변경<small>플랜·편집 턴</small>", "Plan/code<small>plan or edit</small>")}</button><button type="button">${t("모든 턴<small>매 응답</small>", "Every turn<small>all replies</small>")}</button></span>
    </label>
    <div class="stagebox">
      <div class="sbhead">${t("↑ 위 검증을 켜면 <b>흐름 단계마다 '단계별 기본 원칙'</b>이 적용돼요", "↑ With verification on, <b>stage principles</b> apply at each step")} <span class="muted" style="font-weight:400">· ${t("지금 검증: <b>코드 변경 시</b>", "current: <b>on code change</b>")}</span></div>
      <div class="sbrow on"><span class="sbmark">✓</span><b>${t("① Claude→Codex 넘길 때", "① Handing to Codex")}</b> · ${t("전달 원칙", "handoff principles")} <span class="who2 claude">Claude</span></div>
      <div class="sbrow on"><span class="sbmark">✓</span><b>${t("② Codex가 검증할 때", "② Codex verifying")}</b> · ${t("검증 기본원칙 + Codex 규칙", "verify baseline + Codex rules")} <span class="who2 codex">Codex</span></div>
      <div class="sbrow on"><span class="sbmark">✓</span><b>${t("③ Codex 답을 되짚을 때", "③ Re-judging the answer")}</b> · ${t("재판단 원칙", "re-judge principles")} <span class="who2 claude">Claude</span></div>
    </div>
  </div>
  <div class="row"><button>${t("저장", "Save")}</button><span class="muted">· ${t("위 Claude 규칙 · Codex 규칙 · 검증 모드를 함께 저장", "saves Claude rules · Codex rules · verify mode together")}</span></div>

  <h2 class="sec">${t("한눈에 보기", "At a glance")} <span class="sub2">${t("누구에게 · 뭐가 · 언제 들어가나 — 지금 저장된 설정 기준", "who gets what, when — based on saved settings")}</span></h2>
  <section class="flowmap card">
    <div class="flow">
      <div class="fnode rule">${t("Claude<br>규칙", "Claude<br>rules")}</div>
      <div class="farrow"><span class="lbl">${t("넣는 시점<br><b>항상</b>", "inject<br><b>always</b>")}</span><span class="ln"></span></div>
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>${t("구현", "implement")}</small></div>
      <div class="farrow"><span class="lbl">${t("검증 맡김<br><b>코드 변경 시</b>", "verify<br><b>on code change</b>")}</span><span class="ln"></span></div>
      <div class="fnode actor codex"><span class="mono x">Cx</span>Codex<small>${t("검증", "verify")}</small></div>
    </div>
  </section>

  <h2 class="sec base accent-yellow">${t("Codex 검증 대화", "Codex verification conversation")} <span class="sub2">${t("실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인", "the actual exchange — see that verification really happened")}</span></h2>
  <div class="turn">
    <div class="umsg">${t("src/payment.ts 의 applyDiscount() 변경 검증해줘 — 음수 할인율 방어 포함", "Verify the applyDiscount() change in src/payment.ts — incl. negative-rate guard")}</div>
    <div class="vmsg"><div class="vhead"><span class="vname">Codex</span><span class="vchip pass">${t("검증 통과", "verified: pass")}</span></div><div class="vbody">${t("검증: 통과 — applyDiscount()는 rate&lt;0 이면 0으로 클램프함(payment.ts:42). 다만 rate&gt;1(100% 초과)은 미검사 → 상한 클램프 권장.", "Verified: pass — applyDiscount() clamps rate&lt;0 to 0 (payment.ts:42). rate&gt;1 (over 100%) is unchecked → recommend an upper clamp.")}</div></div>
  </div>

  <h2 class="sec base accent-rose">${t("Codex 세션 연결", "Codex session link")} <span class="sub2">${t("첫 발화로 식별", "identified by first message")}</span></h2>
  <div class="cand linked"><div><div class="id">019b…a2f <span class="star">★ ${t("연결됨", "linked")}</span></div><div class="muted">2026-06-22 · ${t("결제 모듈 리팩터 검증", "payment module refactor verify")}</div></div></div>
  <div class="cand"><div><div class="id">019a…7c1</div><div class="muted">2026-06-21 · ${t("인증 토큰 만료 처리", "auth token expiry handling")}</div></div><button>${t("연결", "Link")}</button></div>
</main>`;

const html = `<!DOCTYPE html><html lang="${EN ? "en" : "ko"}"><head><meta charset="UTF-8"><style>${theme}\n${css}</style></head><body>${body}</body></html>`;
const htmlFile = path.join(docs, "_preview.html");
fs.writeFileSync(htmlFile, html, "utf8");

// 4) Edge 헤드리스 캡처
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const png = path.join(docs, EN ? "dashboard.en.png" : "dashboard.png");
const fileUrl = "file:///" + htmlFile.replace(/\\/g, "/");
const r = spawnSync(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--force-device-scale-factor=3", "--window-size=980,3400",
  "--default-background-color=1f1f1fff",
  `--screenshot=${png}`, fileUrl,
], { encoding: "utf8", timeout: 60000 });
if (r.error) throw r.error;
try { fs.unlinkSync(htmlFile); } catch {}
const ok = fs.existsSync(png) && fs.statSync(png).size > 0;

// 5) 아래 배경색(#1f1f1f) 빈 행 자동 트림 — 창을 넉넉히(3400) 잡고 남는 여백을 잘라 정확한 높이로.
if (ok) {
  const pf = png.replace(/\\/g, "/");
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    `$f='${pf}'`,
    "$b=New-Object System.Drawing.Bitmap $f; $W=$b.Width; $H=$b.Height; $bot=0",
    "for($y=$H-1;$y -ge 0;$y-=2){$fnd=$false;for($x=0;$x -lt $W;$x+=20){$p=$b.GetPixel($x,$y);if([math]::Abs($p.R-31)-gt 14 -or [math]::Abs($p.G-31)-gt 14 -or [math]::Abs($p.B-31)-gt 14){$fnd=$true;break}};if($fnd){$bot=$y;break}}",
    "$ch=[math]::Min($H,$bot+60); $c=New-Object System.Drawing.Bitmap $W,$ch; $g=[System.Drawing.Graphics]::FromImage($c)",
    "$g.DrawImage($b,(New-Object System.Drawing.Rectangle 0,0,$W,$ch),(New-Object System.Drawing.Rectangle 0,0,$W,$ch),[System.Drawing.GraphicsUnit]::Pixel)",
    "$b.Dispose(); $c.Save($f,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $c.Dispose(); Write-Output ('trim ' + $W + 'x' + $ch)",
  ].join("; ");
  const tr = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60000 });
  if (tr.stdout && tr.stdout.trim()) console.log("  " + tr.stdout.trim());
  else if (tr.stderr) console.log("  (트림 건너뜀: " + String(tr.stderr).slice(0, 120) + ")");
}
console.log(ok ? `OK → ${png} (${Math.round(fs.statSync(png).size / 1024)}KB)` : "FAILED: PNG 생성 안 됨\n" + (r.stderr || ""));
