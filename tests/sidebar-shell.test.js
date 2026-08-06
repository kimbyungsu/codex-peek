// 사이드바 골격(2026-08-07 UI 개편 1차) 소스 계약 — 겉 구조만 이동, 기존 이음새 무변경이 인수조건.
// ① 세로 레일이 기존 .tabbtn/data-tab 3종을 그대로 품는다(전환 로직·호스트 switchTab·webview-syntax 계약 유지)
// ② 상단바에 운용 모드·언어 세그가 산다(요소 id 불변 — 저장 경로 무변경)
// ③ '작업 깊이' 상단 세그는 표시 전용 미러다(즉시 토글 금지 — 초안 보호 우회 차단이 설계 근거)
// ④ 래퍼 태그 짝이 맞는다(골격 교체가 본문을 삼키는 사고 방지)
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] 세로 레일 — 기존 탭 이음새 유지");
ok(src.includes('<aside class="sidebar">'), "사이드바 컨테이너 존재");
for (const tab of ["main", "stats", "adv"]) {
  const re = new RegExp('class="tabbtn[^"]*" data-tab="' + tab + '"');
  ok(re.test(src), `data-tab="${tab}" 버튼 유지(호스트 switchTab·전환 로직 무접촉)`);
}
{
  const aside = src.slice(src.indexOf('<aside class="sidebar">'), src.indexOf("</aside>"));
  ok((aside.match(/class="tabbtn/g) || []).length === 3, "탭 버튼 3종이 전부 사이드바 안에 있다");
  ok((aside.match(/class="navgroup"/g) || []).length === 3, "그룹 라벨(운영/분석/관리) 3개");
  ok(aside.includes('id="sbToggle"'), "접기 버튼");
}
ok(src.includes(".app{display:grid;grid-template-columns:200px minmax(0,1fr)"), "그리드 골격");
ok(src.includes(".app.rail{grid-template-columns:58px"), "접힘 레일 폭");
ok(src.includes("@media (max-width:700px)"), "좁은 창 자동 레일(미디어쿼리)");

console.log("[2] 상단바 — 기존 요소 id 불변 이동");
{
  const topbar = src.slice(src.indexOf('<header class="topbar">'), src.indexOf("</header>"));
  ok(topbar.includes('id="modeClaude"') && topbar.includes('id="modeCodex"'), "운용 모드 토글이 상단바에(저장 경로 id 불변)");
  ok(topbar.includes('id="langKo"') && topbar.includes('id="langEn"'), "언어 세그가 상단바에");
  ok(topbar.includes('id="tbTrack"') && topbar.includes('style="display:none"'), "작업 깊이 미러 — 데이터 오기 전 숨김");
}

console.log("[3] 작업 깊이 미러 — 표시 전용(쓰기 경로 없음)");
{
  const b = src.indexOf('var tb=$("tbTrack"); if(!tb) return; tb.addEventListener');
  const e = src.indexOf("})();", b);
  const blk = b > 0 && e > b ? src.slice(b, e) : "";
  ok(blk.length > 0, "미러 클릭 핸들러 존재");
  ok(!blk.includes("postMessage"), "클릭이 저장 메시지를 보내지 않는다(초안 보호 우회 금지)");
  ok(blk.includes('data-tab="main"') && blk.includes('$("segScout")'), "클릭=현황 탭의 실제 설정 위치로 이동");
  ok(/appSM===null\?"none":""/.test(src) && src.includes('x.getAttribute("data-tbsm")===(son?"on":"off")'), "renderApplied가 적용값만 반영(미러 갱신)");
}

console.log("[4] 래퍼 짝 — 골격이 본문을 삼키지 않는다");
{
  const bodyStart = src.indexOf('<body><div class="app"');
  const body = src.slice(bodyStart, src.indexOf("</body></html>", bodyStart));
  ok(bodyStart > 0 && body.length > 1000, "대시보드 본문 슬라이스 성립(타 웹뷰 템플릿과 미혼동)");
  ok(body.indexOf('<main class="shell">') > 0 && /<\/main>\s*<\/div>\s*<\/div>\s*<script /.test(body), "shell 닫힘 뒤 maincol·app 래퍼 닫힘(EOL 무관)");
  ok((body.match(/<aside/g) || []).length === (body.match(/<\/aside>/g) || []).length, "aside 짝");
  ok((body.match(/<header/g) || []).length === (body.match(/<\/header>/g) || []).length, "header 짝");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
