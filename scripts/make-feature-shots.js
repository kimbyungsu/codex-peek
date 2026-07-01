// 문서/README용 '기능별' 대시보드 스크린샷 생성기.
//  - src/extension.ts 의 <style>(실제 CSS) 추출 + Dark+ 테마 주입(make-screenshot.js 와 동일 방식)
//  - 섹션을 하나씩 .shell 에 넣어 Edge 헤드리스로 캡처 → docs/feat_<key>.png
//  - 내장 PowerShell trim 으로 아래 여백을 잘라 타이트하게(한 명령으로 끝 — make-screenshot.js 와 동일).
// ⚠ 주의: 아래 SECTIONS 마크업은 src/extension.ts html() 본문의 '샘플 복제'다(자동 추출 아님).
//   웹뷰 구조/클래스가 바뀌면 여기 SECTIONS 도 같이 갱신해야 실제 화면과 일치한다(CSS는 자동 추출이라 무방).
//   ⚠ 결과 파일명(feat_<key>.png)은 README·소개글이 CDN으로 참조하므로 바꾸지 말 것(덮어쓰기만).
// 사용: node scripts/make-feature-shots.js  →  docs/feat_*.png
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const docs = path.join(root, "docs");
fs.mkdirSync(docs, { recursive: true });

const ext = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const m = ext.match(/<style>([\s\S]*?)<\/style>/);
if (!m) throw new Error("extension.ts 에서 <style> 블록을 못 찾음");
const css = m[1];

const theme = `:root{
  --vscode-foreground:#cccccc; --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#cccccc;
  --vscode-panel-border:#3c3c3c; --vscode-descriptionForeground:#9d9d9d; --vscode-sideBar-background:#181818;
  --vscode-charts-blue:#3794ff; --vscode-charts-purple:#b180d7; --vscode-charts-green:#89d185; --vscode-charts-orange:#d18616; --vscode-charts-yellow:#d7ba7d; --vscode-charts-red:#f14c4c;
  --vscode-editorWidget-background:#252526;
  --vscode-input-background:#2a2a2a; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
  --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#ffffff;
  --vscode-dropdown-background:#2a2a2a; --vscode-dropdown-foreground:#cccccc; --vscode-dropdown-border:#3c3c3c;
  --vscode-textCodeBlock-background:#2a2a2a; --vscode-editor-font-family:"Cascadia Code",Consolas,monospace;
  --vscode-font-family:"Segoe UI","Malgun Gothic",sans-serif; --vscode-font-size:13px;
}`;

const SECTIONS = {
  connect: `<div class="top"><h1><span class="brand"></span>Codex Bridge <span class="sub">Claude ⇄ Codex 자동 연결·검증</span></h1><button class="secondary">↻ 새로고침</button></div>
  <div class="hero">
    <div class="agent claude"><div class="mono c">C</div><div class="nm">Claude</div><div class="ro">구현 · implement</div></div>
    <div class="link on"><div class="bar"></div><div class="emo">●</div><div class="st">연결됨</div></div>
    <div class="agent codex"><div class="mono x">Cx</div><div class="nm">Codex</div><div class="ro">검증 · verify</div></div>
  </div>
  <div class="statusline"><span class="badge b-code">코드 변경 시 검증</span><span class="wschip">D:/codex-peek</span><span class="muted">· 결제 모듈 리팩터 검증</span></div>
  <div class="livestrip" style="display:block">
    <div class="lsflow"><span class="lsbox claude">Claude</span><span class="lsarrow tocodex">▶▶▶ 검증중</span><span class="lsbox codex on">Codex</span></div>
    <div class="lsstage"><span class="lschip codex-gen">Codex 생성중 · 2라운드</span></div>
  </div>`,

  claude: `<h2 class="sec claude" style="margin-top:6px">Claude 규칙 <span class="to claude">→ Claude에게</span> <span class="sub2">Claude가 지킬 행동규칙 — 검증과 별개</span></h2>
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
  </div>`,

  verify: `<h2 class="sec codex" style="margin-top:6px">검증 <span class="to codex">→ Codex</span> <span class="sub2">Codex에게 검증받기 — 끄면 검증만 안 함(Claude 규칙은 별개)</span></h2>
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
  </div>`,

  flow: `<h2 class="sec" style="margin-top:6px">한눈에 보기 <span class="sub2">누구에게 · 뭐가 · 언제 들어가나 — 지금 저장된 설정 기준</span></h2>
  <section class="flowmap card">
    <div class="flow">
      <div class="fnode rule">Claude<br>규칙</div>
      <div class="farrow"><span class="lbl">넣는 시점<br><b>항상</b></span><span class="ln"></span></div>
      <div class="fnode actor claude"><span class="mono c">C</span>Claude<small>구현</small></div>
      <div class="farrow"><span class="lbl">검증 맡김<br><b>코드 변경 시</b></span><span class="ln"></span></div>
      <div class="fnode actor codex"><span class="mono x">Cx</span>Codex<small>검증</small></div>
    </div>
  </section>`,

  brain: `<h2 class="sec base accent-orange" style="margin-top:6px">코덱스 두뇌 설정 <span class="sub2">이 프로젝트에서 코덱스가 쓰는 모델·생각강도 (진행 중 대화에도 적용)</span></h2>
  <div class="mcard">
    <div class="muted">지금 쓰는 값(최근 기록): <b>GPT-5.5 · 생각강도 높음</b></div>
    <div class="mrow"><span class="mlbl">모델</span><select><option>GPT-5.5 (gpt-5.5)</option><option>GPT-5.4 (gpt-5.4)</option></select></div>
    <div class="mrow"><span class="mlbl">생각강도</span><span class="seg"><button type="button">기본</button><button type="button">낮음</button><button type="button">보통</button><button type="button" class="on">높음</button><button type="button">매우높음</button></span></div>
    <div class="row" style="margin-top:10px"><button>두뇌 설정 저장</button></div>
  </div>`,

  timeout: `<h2 class="sec base accent-teal" style="margin-top:6px">검증 대기시간 <span class="sub2">코덱스 검증을 기다리는 한도 — 추론이 길면 늘리세요 (전역·모든 프로젝트 공통)</span></h2>
  <div class="mcard">
    <div class="mrow"><span class="mlbl">대기시간</span><input type="number" value="20" style="width:72px"> <span class="muted">분 · 기본 8</span></div>
    <div class="row" style="margin-top:10px"><button>대기시간 저장</button></div>
    <div class="muted" style="margin-top:6px">코덱스가 답하는 데 이 시간보다 오래 걸리면 검증이 실패로 끝나요. 추론이 8분을 넘는 경우가 있으면 늘려 두세요.</div>
  </div>`,

  conv: `<h2 class="sec base accent-yellow" style="margin-top:6px">Codex 검증 대화 <span class="sub2">실제 주고받은 내용 — 검증이 진짜 일어났는지 눈으로 확인</span></h2>
  <div class="turn">
    <div class="umsg">src/payment.ts 의 applyDiscount() 변경 검증해줘 — 음수 할인율 방어 포함</div>
    <div class="vmsg"><div class="vhead"><span class="vname">Codex</span><span class="vchip pass">검증 통과</span></div><div class="vbody">검증: 통과 — applyDiscount()는 rate&lt;0 이면 0으로 클램프함(payment.ts:42). 다만 rate&gt;1(100% 초과)은 미검사 → 상한 클램프 권장.</div></div>
  </div>`,

  link: `<h2 class="sec base accent-rose" style="margin-top:6px">Codex 세션 연결 <span class="sub2">첫 발화로 식별</span></h2>
  <div class="cand linked"><div><div class="id">019b…a2f <span class="star">★ 연결됨</span></div><div class="muted">2026-06-22 · 결제 모듈 리팩터 검증</div></div></div>
  <div class="cand"><div><div class="id">019a…7c1</div><div class="muted">2026-06-21 · 인증 토큰 만료 처리</div></div><button>연결</button></div>`,

  // 검증 통계 탭(탭2). 차트(도넛·추이·히트맵)는 런타임 JS가 그리므로, 여기선 '샘플 데이터 + 동일 렌더 로직'을
  // 인라인 <script>로 넣어 Edge가 실제로 그리게 한다(빈 차트 방지). 렌더 규칙은 extension.ts renderStats와 동일하게 맞춤.
  stats: `<h2 class="sec base accent-yellow" style="margin-top:6px">검증 통계 <span class="sub2">이 폴더에서 코덱스 검증이 어떻게 흘러왔는지 — 최근 흐름·통과율·막고 풀린 전환</span></h2>
  <div class="card">
    <div class="stat-cards">
      <div class="stat-card s-blue"><div class="stat-num" id="st7total">–</div><div class="stat-lbl">최근 7일 검증</div></div>
      <div class="stat-card s-green"><div class="stat-num" id="st7pass">–</div><div class="stat-lbl">완전통과율 (7일)</div></div>
      <div class="stat-card s-orange"><div class="stat-num" id="st7touch">–</div><div class="stat-lbl">보완이상 비율 (7일)</div></div>
      <div class="stat-card s-purple"><div class="stat-num" id="st7res">–</div><div class="stat-lbl">실패·보류→통과 전환 (7일)</div></div>
    </div>
    <div class="stat-chart">
      <div class="chart-box"><h3 class="chart-h">최근 28일 검증 결과 분포</h3><div class="donut-wrap"><svg id="donut" viewBox="0 0 120 120" width="140" height="140"></svg><div id="donutTotal" class="donut-center"></div></div></div>
      <div id="donutLegend" class="legend"></div>
    </div>
    <div class="stat-chart"><div class="chart-box wide"><h3 class="chart-h">최근 14일 검증 추이 <span class="muted">(아래부터 완전통과·통과보완·보류·실패·표지누락 5색, 높이=24시간 구간별 검증량)</span></h3><div id="trendBars" class="trend-bars"></div></div></div>
    <div class="stat-chart"><div class="chart-box wide"><h3 class="chart-h">검증 활동 <span class="muted">(최근 4주 · 세로 요일 / 가로 0~23시 · 색이 진할수록 그 시간대 검증이 많음 — 아래 범례)</span></h3><div id="heat" class="heatmap"></div></div></div>
  </div>
  <script>
  (function(){
    var $=function(id){return document.getElementById(id);};
    var w={total:17,pass:10,passNotes:3,inconclusive:1,fail:2};
    var m={pass:30,passNotes:9,inconclusive:3,fail:4,unparsed:2};
    var jw=w.pass+w.passNotes+w.inconclusive+w.fail;
    var pct=function(n,d){return d>0?Math.round(n/d*100)+"%":"–";};
    $("st7total").textContent=w.total; $("st7pass").textContent=pct(w.pass,jw);
    $("st7touch").textContent=pct(w.passNotes+w.inconclusive+w.fail,jw); $("st7res").textContent=4;
    var R=50,CX=60,CY=60,C=2*Math.PI*R;
    var segs=[{n:m.pass,c:"var(--vscode-charts-green)",lbl:"완전통과"},{n:m.passNotes,c:"var(--vscode-charts-yellow,#d7ba7d)",lbl:"통과(보완)"},{n:m.inconclusive,c:"var(--vscode-charts-orange)",lbl:"보류"},{n:m.fail,c:"var(--vscode-charts-red)",lbl:"실패"}];
    var judged=m.pass+m.passNotes+m.inconclusive+m.fail,svg="",off=0;
    segs.forEach(function(s){ if(s.n<=0)return; var frac=s.n/judged; svg+='<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="none" stroke="'+s.c+'" stroke-width="16" stroke-dasharray="'+(frac*C).toFixed(2)+' '+C.toFixed(2)+'" stroke-dashoffset="'+(-off*C).toFixed(2)+'" transform="rotate(-90 '+CX+' '+CY+')"/>'; off+=frac; });
    $("donut").innerHTML=svg; $("donutTotal").textContent=judged;
    var bars=segs.map(function(s){ var wp=Math.round(s.n/judged*100); return '<div class="vrow"><span class="leg-dot" style="background:'+s.c+'"></span><span class="vlbl">'+s.lbl+'</span><span class="vbar"><span class="vbar-fill" style="width:'+wp+'%;min-width:3px;background:'+s.c+'"></span></span><b class="vnum">'+s.n+' · '+wp+'%</b></div>'; }).join("");
    bars+='<div class="vrow vmiss"><span class="leg-dot" style="background:var(--vscode-descriptionForeground)"></span><span class="vlbl">판정표지 누락</span><span class="vmiss-note">코덱스가 답은 했지만 결론 줄을 안 적은 답 — 통과율 계산엔 안 넣어요</span><b class="vnum">'+m.unparsed+'</b></div>';
    $("donutLegend").innerHTML=bars;
    var d14=[[1,1,0,1,0],[2,0,0,0,0],[0,0,0,0,0],[3,1,0,0,1],[2,0,1,0,0],[1,1,0,1,0],[0,0,0,0,0],[4,1,0,0,0],[3,0,1,1,0],[2,2,0,0,0],[1,0,0,0,0],[3,1,0,1,0],[2,1,0,0,0],[4,2,1,0,0]].map(function(a){return{pass:a[0],passNotes:a[1],inconclusive:a[2],fail:a[3],unparsed:a[4],total:a[0]+a[1]+a[2]+a[3]+a[4]};});
    var maxd=1; d14.forEach(function(b){if(b.total>maxd)maxd=b.total;});
    var sc=[["pass","var(--vscode-charts-green)"],["passNotes","var(--vscode-charts-yellow,#d7ba7d)"],["inconclusive","var(--vscode-charts-orange)"],["fail","var(--vscode-charts-red)"],["unparsed","var(--vscode-descriptionForeground)"]];
    $("trendBars").innerHTML=d14.map(function(b,i){ var ago=13-i,lbl=ago===0?"최근":(ago+"d"); var stack=sc.map(function(x){var h=b[x[0]]?(b[x[0]]/maxd*100):0; return h>0?'<div class="tseg" style="height:'+h.toFixed(1)+'%;background:'+x[1]+'"></div>':"";}).reverse().join(""); return '<div class="tbar"><div class="tbar-stack">'+stack+'</div><div class="tbar-lbl">'+(ago%2===0?lbl:"")+'</div></div>'; }).join("");
    var days=["월","화","수","목","금","토","일"];
    var heatColors=['var(--vscode-editorWidget-background)','color-mix(in srgb,var(--vscode-charts-blue) 22%,var(--vscode-editor-background))','color-mix(in srgb,var(--vscode-charts-blue) 45%,var(--vscode-editor-background))','color-mix(in srgb,var(--vscode-charts-blue) 68%,var(--vscode-editor-background))','color-mix(in srgb,var(--vscode-charts-blue) 92%,var(--vscode-editor-background))'];
    var hm=[]; for(var dd=0;dd<7;dd++){ var row=[]; for(var hx=0;hx<24;hx++){ var base=0; if(dd<5&&hx>=10&&hx<=19)base=((hx>=13&&hx<=17)?4:2)-Math.floor(dd*0.4); else if(hx>=20&&hx<=23)base=1; else if(dd>=5&&hx>=14&&hx<=18)base=2; row.push(base<0?0:base); } hm.push(row); }
    var maxh=1; hm.forEach(function(r){r.forEach(function(v){if(v>maxh)maxh=v;});});
    function heatLv(v){ if(v<=0)return 0; var r=v/maxh; return r<=0.25?1:(r<=0.5?2:(r<=0.75?3:4)); }
    var head='<div class="heat-row heat-head"><span class="heat-day"></span>'; for(var hh=0;hh<24;hh++){head+='<span class="heat-hh">'+(hh%6===0?hh+"시":"")+'</span>';} head+='</div>';
    var hhtml=head; for(var d2=0;d2<7;d2++){ hhtml+='<div class="heat-row"><span class="heat-day">'+days[d2]+'</span>'; for(var h2=0;h2<24;h2++){ hhtml+='<span class="heat-cell" style="background:'+heatColors[heatLv(hm[d2][h2])]+'"></span>'; } hhtml+='</div>'; }
    var leg='<div class="heat-legend"><span class="hl-t">적음</span>'; for(var li=0;li<5;li++){leg+='<span class="hl" style="background:'+heatColors[li]+'"></span>';} leg+='<span class="hl-t">많음</span></div>';
    $("heat").innerHTML=hhtml+leg;
  })();
  </script>`,
};

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// 아래 배경(#1f1f1f) 빈 행 자동 트림 — 창을 넉넉히 잡고 남는 하단 여백을 잘라 정확한 높이로(make-screenshot.js와 동일 방식).
//   ⚠ 파일명 유지: 결과는 docs/feat_<key>.png 로 '그대로' 덮어쓴다(README·소개글이 이 파일명을 CDN으로 참조 → 이름 바뀌면 깨짐).
function trimBottom(pngPath) {
  const pf = pngPath.replace(/\\/g, "/");
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    `$f='${pf}'`,
    "$b=New-Object System.Drawing.Bitmap $f; $W=$b.Width; $H=$b.Height; $bot=0",
    "for($y=$H-1;$y -ge 0;$y-=2){$fnd=$false;for($x=0;$x -lt $W;$x+=20){$p=$b.GetPixel($x,$y);if([math]::Abs($p.R-31)-gt 14 -or [math]::Abs($p.G-31)-gt 14 -or [math]::Abs($p.B-31)-gt 14){$fnd=$true;break}};if($fnd){$bot=$y;break}}",
    "$ch=[math]::Min($H,$bot+50); $c=New-Object System.Drawing.Bitmap $W,$ch; $g=[System.Drawing.Graphics]::FromImage($c)",
    "$g.DrawImage($b,(New-Object System.Drawing.Rectangle 0,0,$W,$ch),(New-Object System.Drawing.Rectangle 0,0,$W,$ch),[System.Drawing.GraphicsUnit]::Pixel)",
    "$b.Dispose(); $c.Save($f,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $c.Dispose(); Write-Output ('trim ' + $W + 'x' + $ch)",
  ].join("; ");
  const t = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60000 });
  return (t.stdout && t.stdout.trim()) ? t.stdout.trim() : ("(트림 건너뜀: " + String(t.stderr || "").slice(0, 100) + ")");
}

let okAll = true;
for (const [key, inner] of Object.entries(SECTIONS)) {
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><style>${theme}\n${css}\n.shell{padding:18px 22px}</style></head><body><main class="shell">${inner}</main></body></html>`;
  const htmlFile = path.join(docs, `_feat_${key}.html`);
  fs.writeFileSync(htmlFile, html, "utf8");
  const png = path.join(docs, `feat_${key}.png`); // 파일명 유지(기존 게시글이 참조) — 덮어쓰기
  const winH = key === "stats" ? 2400 : 940; // 통계 탭은 차트가 많아 세로가 김 → 창을 크게(트림이 남는 여백 자름)
  const r = spawnSync(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--force-device-scale-factor=3", `--window-size=980,${winH}`,
    "--default-background-color=1f1f1fff",
    `--screenshot=${png}`, "file:///" + htmlFile.replace(/\\/g, "/"),
  ], { encoding: "utf8", timeout: 60000 });
  try { fs.unlinkSync(htmlFile); } catch {}
  const ok = fs.existsSync(png) && fs.statSync(png).size > 0;
  const tr = ok ? trimBottom(png) : "";
  okAll = okAll && ok;
  console.log(`${ok ? "OK" : "FAIL"} ${key} → ${png}  ${tr}`);
}
console.log(okAll ? "ALL OK → docs/feat_*.png (트림까지 완료)" : "일부 실패");
