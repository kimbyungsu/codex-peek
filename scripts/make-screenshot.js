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
  --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7; --vscode-charts-green:#89d185; --vscode-charts-orange:#d18616; --vscode-charts-yellow:#d7ba7d;
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

  <details class="card baseline" open style="margin-top:10px">
    <summary style="cursor:pointer;font-weight:600;font-size:13px">단계별 기본 원칙 <span class="fixedbadge">고정 기준 · 기본값 내장</span> <span class="muted" style="font-weight:400">· 검증 흐름 3단계의 기본값 (필요할 때만 편집)</span></summary>
    <div class="hint" style="margin:8px 0 0 0">위 Claude·Codex 규칙(네가 쓰는 것)과 달리, 이건 검증이 제대로 굴러가게 하는 흐름 단계별 기본값임. 평소엔 손댈 필요 없고, 잘못 고쳐도 '기본값 복원'으로 되돌아감.</div>
    <div class="chead" style="margin-top:12px">① 전달 원칙 <span class="muted" style="font-weight:400">→ Claude에게 · Claude가 Codex에 넘길 때 · 검증 ON일 때만</span></div>
    <textarea rows="6">[전달 원칙] 검증모델에게 검증을 맡길 때:
- 검증 대상은 코드 변경만이 아니다 — 설계 판단·적절성 의견·제안 문구 등 사용자에게 보고할 '결론'이면, 구현이 없어도 '내 주장'으로 검증모델에 던져 공격받아라. (단 code/plancode 모드의 ask 트리거 자체는 코드·플랜 기준 그대로.)
- 검증 요청을 요약/생략하지 마라. 관련 파일 경로·확인 지점을 구체적으로 적어 검증모델이 원본을 직접 열게 하라.
- '여기만 봐라 / 이렇게 해라' 식 좁은 명령을 하지 마라. 대신 내가 무엇을 했고·왜 했고·어떤 근거를 봤고·어디가 불안한지를 주고, 내 결론은 '내 주장'으로 표시해 검증모델이 공격하게 하라.
- 파일·라인은 시작점으로만 제시하고, 검토 범위 확장은 검증모델의 판단에 맡겨라.</textarea>
    <div class="chead" style="margin-top:12px">② 검증 기본원칙 <span class="muted" style="font-weight:400">→ Codex에게 · Codex 검증 때마다</span></div>
    <textarea rows="12">[검증 기본 원칙 · 항상 적용]
1) 논리 구조만으로 단정하지 말고, 코드·파일을 실제로 열어 확인해 검증하라.
2) 검증 수행 생략·요약·축약 금지. '빠르게/대충' 요청을 받더라도 충실히 검증하라.
3) 요청자가 지정한 파일·범위는 '시작점'일 뿐 한계가 아니다. 요청자의 결론을 전제로 받아들이지 말고, 필요하면 호출부·테스트·문서·배포 경로까지 범위를 스스로 넓혀 반례를 찾으라.
4) 본문에 검토 내용·항목별 근거(경로·라인)·보완/정정/추가 확인 사항·실패 사유를 '먼저' 상세히 작성하라(본문 축약 금지). 판정 결론은 반드시 '맨 마지막 한 줄'에만 다음 4가지 중 정확히 하나로 출력하라: '검증: 통과'(보완·주의·수정 항목 없음) / '검증: 통과(보완)'(통과지만 보완·정정·추가 의견 있음) / '검증: 보류'(정보 부족·불가 등으로 결론 못 냄) / '검증: 실패'. 마지막 줄 외에는 '검증:'으로 시작하는 줄을 쓰지 마라(근거를 먼저 적고 결론을 마지막에 두어야 결론이 그 근거에 맞춰진다 — 성급한 머리말 오라벨 방지).
5) 판정 기준은 '실질 영향'이다. 오작동·명세 불일치·회귀 위험·사용자/운영 판단을 오도할 표현·작아 보여도 반복·확장 시 결함으로 번질 구조는 사소하지 않으니 잡아라. 반대로 결과·동작·다음 판단을 바꾸지 않는 취향·형식·미세 문구만으로 통과를 막지 마라.</textarea>
    <div class="chead" style="margin-top:12px">③ 재판단 원칙 <span class="muted" style="font-weight:400">→ Claude에게 · Codex 답을 되짚을 때 · 검증 ON일 때만</span></div>
    <textarea rows="7">[재판단] 검증모델 답을 그대로 옮기지 마라. 항목별로 재판단하라:
- 검증모델의 지적을 항목으로 나눠, 각 항목에 [수용/반박/보류] + 근거(파일·라인) + 사유를 달라.
- 수용하는 항목엔 반드시 근거(직접 확인한 파일·라인)가 있어야 한다. 짧은 '동의/이견없음'으로 뭉개지 마라(반박·보류는 그 자체가 재판단 증거).
- 근거는 논리 추정이 아니라 코드/파일에서 직접 확인 가능한 사실(경로·라인·실제 출력/동작)로. 검증모델과 의견이 갈리면 이유를 명시하라.
- 완료 보고는 Codex 판정이 '통과' 또는 '통과(보완)'인 검증 결과를 반영한 뒤에만 하라. 예시 하나·분기 하나·테스트 몇 개·구체어 덧붙임을 '전체 해결'로 포장하지 마라 — 그 자체는 완료가 아니다.
- 검증 후 추가로 수정했으면(검증모델 권고를 적용한 수정 포함) 보고·커밋 전에 그 최종본을 다시 검증하라. 검증받은 상태가 곧 배포 상태다.</textarea>
    <div class="row"><button>단계별 기본 원칙 저장</button><button class="secondary">기본값 복원</button></div>
  </details>

  <h2 class="sec base accent-orange">코덱스 두뇌 설정 <span class="sub2">이 프로젝트에서 코덱스가 쓰는 모델·생각강도 (진행 중 대화에도 적용)</span></h2>
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

  <h2 class="sec base accent-teal">검증 대기시간 <span class="sub2">코덱스 검증을 기다리는 한도 — 추론이 길면 늘리세요 (전역·모든 프로젝트 공통)</span></h2>
  <div class="mcard">
    <div class="mrow"><span class="mlbl">대기시간</span><input type="number" value="20" style="width:72px"> <span class="muted">분 · 기본 8</span></div>
    <div class="row" style="margin-top:10px"><button>대기시간 저장</button></div>
    <div class="muted" style="margin-top:6px">코덱스가 답하는 데 이 시간보다 오래 걸리면 검증이 실패로 끝나요. 추론이 8분을 넘는 경우가 있으면 늘려 두세요.</div>
  </div>

  <h2 class="sec base accent-yellow">Codex 검증 대화 <span class="sub2">실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인</span></h2>
  <div class="turn">
    <div class="umsg">src/payment.ts 의 applyDiscount() 변경 검증해줘 — 음수 할인율 방어 포함</div>
    <div class="vmsg"><div class="vhead"><span class="vname">Codex</span><span class="vchip pass">검증 통과</span></div><div class="vbody">검증: 통과 — applyDiscount()는 rate&lt;0 이면 0으로 클램프함(payment.ts:42). 다만 rate&gt;1(100% 초과)은 미검사 → 상한 클램프 권장.</div></div>
  </div>

  <h2 class="sec base accent-rose">Codex 세션 연결 <span class="sub2">첫 발화로 식별</span></h2>
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
  "--force-device-scale-factor=3", "--window-size=980,3400",
  "--default-background-color=1f1f1fff",
  `--screenshot=${png}`, fileUrl,
], { encoding: "utf8", timeout: 60000 });
if (r.error) throw r.error;
try { fs.unlinkSync(htmlFile); } catch {}
const ok = fs.existsSync(png) && fs.statSync(png).size > 0;

// 5) 아래 배경색(#1f1f1f) 빈 행 자동 트림 — 창을 넉넉히(3400) 잡고 남는 여백을 잘라 정확한 높이로.
//    이렇게 해야 섹션이 추가돼 길어져도 '하단 잘림'이나 '과한 여백' 없이 한 명령으로 끝난다(Windows/PowerShell).
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
  const t = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60000 });
  if (t.stdout && t.stdout.trim()) console.log("  " + t.stdout.trim());
  else if (t.stderr) console.log("  (트림 건너뜀: " + String(t.stderr).slice(0, 120) + ")");
}
console.log(ok ? `OK → ${png} (${Math.round(fs.statSync(png).size / 1024)}KB)` : "FAILED: PNG 생성 안 됨\n" + (r.stderr || ""));
