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

console.log("[1] 세로 레일 — 탭 이음새 유지(2차: 패널 7개)");
ok(src.includes('<aside class="sidebar">'), "사이드바 컨테이너 존재");
const TABS = ["overview", "verify", "setup", "sessions", "map", "stats", "adv"];
for (const tab of TABS) {
  const re = new RegExp('class="tabbtn[^"]*" data-tab="' + tab + '"');
  ok(re.test(src), `data-tab="${tab}" 버튼 존재(전환 로직·호스트 switchTab 무접촉)`);
  ok(src.includes(`id="tab-${tab}"`), `패널 컨테이너 tab-${tab} 존재`);
}
ok(!/data-tab="main"/.test(src) && !src.includes('id="tab-main"'), "구 main 탭 잔재 없음(참조 끊김 방지)");
{
  const aside = src.slice(src.indexOf('<aside class="sidebar">'), src.indexOf("</aside>"));
  ok((aside.match(/class="tabbtn/g) || []).length === 7, "탭 버튼 7종이 전부 사이드바 안에 있다");
  ok((aside.match(/class="navgroup"/g) || []).length === 4, "그룹 라벨(운영/3트랙/분석/관리) 4개");
  ok(aside.includes('id="sbToggle"'), "접기 버튼");
  ok(aside.includes('id="ovNavBadge"') && aside.includes('id="vNavBadge"'), "개요 결정 수·검증 회차 배지 자리");
}
{
  // 전역부 계약 — 경보 배너·온보딩은 어느 패널이 활성이어도 보인다(패널 뒤로 숨는 사고 방지)
  const firstPanel = src.indexOf('id="tab-overview"');
  const shellStart = src.indexOf('<main class="shell">');
  const globalPart = src.slice(shellStart, firstPanel);
  ok(globalPart.includes('id="integrityBanner"') && globalPart.includes('id="onboard"'), "경보 배너·온보딩은 패널 밖 전역부");
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
  ok(blk.includes('$("segScout")') && blk.includes("gotoEl("), "클릭=실제 설정 위치로 이동(gotoEl 단일 경로 — 패널 활성화+스크롤)");
  ok(/appSM===null\?"none":""/.test(src) && src.includes('x.getAttribute("data-tbsm")===(son?"on":"off")'), "renderApplied가 적용값만 반영(미러 갱신)");
}

console.log("[3b] 개요 패널 — 기존 상태값 재조립·안전 표시 계약");
{
  const b = src.indexOf("function renderOverview(d){");
  const e = src.indexOf("\n  }", b);
  const blk = b > 0 && e > b ? src.slice(b, e) : "";
  ok(blk.length > 0, "renderOverview 함수 존재(호이스팅 함수 선언)");
  ok(!blk.includes("innerHTML"), "개요 렌더에 innerHTML 없음(textContent·replaceChildren만)");
  ok(!blk.includes("postMessage"), "개요 렌더가 저장·요청 메시지를 보내지 않는다(표시 전용)");
  ok(blk.includes("d.integrity") && blk.includes("d.backlog") && blk.includes("choicePending") && blk.includes("d.envelope"), "결정 필요 합산 원천(경보 2종·보관함·MAP 선택·수칙서)");
  // 보관함 긴급/여유 분리(사용자 결정 2026-08-07): 기한(due) 항목만 합산·잔여는 합산 밖 '여유' 줄
  ok(blk.includes("d.backlog.cautionDue") && blk.includes("blRest9=Math.max(0,"), "보관함은 검토 기한 항목만 긴급 합산(잔여=여유)");
  ok(!/tot9\+=blRest9|acts9\.push\(\{n:blRest9/.test(blk) && /blRest9\)\{ var rx9=el\("div","ovact relaxed"\)/.test(blk), "여유 줄은 합산·행동 목록 밖 별도 렌더(과장 집계 금지)");
  ok(/cautionDue: items\.filter\(\(x\) => x\.tag === "주의" && x\.due\)\.length/.test(src), "cautionDue는 표시 상한(30) 적용 전 전량 기준");
  ok(/vb9\.textContent=T\("회차 ","rd "\)/.test(blk) && blk.includes("cc9 ? d.contract.codexVerifyBudget : d.contract.verifyBudget"), "검증 배지='회차 N/상한' — 상한은 계약 실효 숫자(편집용 appVB 문자열 금지)");
  ok(blk.includes("cap9>=1)?\"/\"+cap9:\"\"") && !blk.includes('(appVB?"/"+appVB:"")'), "무제한(0)·미정=분모 생략(존재하지 않는 상한 0 표시 금지 — blocker 반영)");
  ok(blk.includes('e.kind==="evidence-unseen"') && !blk.includes("d.challenges"), "근거 재확인은 경보 종류 분리로 1회만 집계 — kept 가산 금지(같은 eventId 이중 집계 blocker 2026-08-07)");
  ok(blk.includes("integAll9.length-ev9"), "일반 경보 수 = 전체 미확인 − evidence-unseen(분리 후 합=전체·과소/과대 없음)");
  ok(blk.includes("d.usedMemory"), "'실린 기억' 카드가 상태값(usedMemory)만 읽는다");
  ok(src.includes("safe(function(){ renderOverview(d); });"), "data 핸들러에 safe 결속(구획 실패 격리)");
  ok(src.includes("usedMemory: (() => {") && src.includes('"stats", "attach.jsonl"'), "computeState가 브릿지 attach 장부를 읽어 usedMemory 공급");
}

console.log("[3c] 교차 패널 이동 — 비활성 패널 안 대상도 도달(실사용 결함 2026-08-07 봉합)");
{
  const b = src.indexOf("function gotoEl(t){");
  const e = src.indexOf("\n  }", b);
  const blk = b > 0 && e > b ? src.slice(b, e) : "";
  ok(blk.length > 0, "gotoEl 단일 경로 존재");
  ok(/closest\("\.tab-panel"\)[\s\S]{0,200}classList\.contains\("active"\)[\s\S]{0,300}scrollIntoView/.test(blk), "패널 활성화가 스크롤보다 먼저(비활성 패널=스크롤 무효 원인 제거)");
  ok(/replace\(\/\^tab-\/,""\)/.test(blk), "패널 id에서 탭 이름 유도 — 기존 tabbtn 클릭(단일 전환 경로) 재사용");
  ok(/const g = ev\.target\.closest\("\[data-go\]"\);[\s\S]{0,200}gotoEl\(t\)/.test(src), "온보딩 '이동' 버튼이 gotoEl 경유(검증 꺼짐→설정 이동 실사용 결함)");
  ok(/var sg=\$\("segScout"\); if\(sg\)\{ gotoEl\(sg\);/.test(src), "상단 '작업 깊이' 미러도 gotoEl 경유(중복 전환 코드 소멸)");
  ok(/cardNoticeKind === "warn"\) \{ try \{ gotoEl\(n\); \}/.test(src), "전환 차단 안내(cardNotice)도 gotoEl 경유 — 다른 패널에서 차단돼도 안내가 보인다(검증 [보완])");
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
