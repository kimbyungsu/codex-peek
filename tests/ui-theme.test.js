// 화면 색상 테마(12종 · 2026-08-08) 소스 계약 — 두 색감 교차·기본 다크·colorful=무테마·간접층 재도장.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] 테마 목록 — 12종·중복 없음·기본 다크·컬러풀 포함");
{
  const b = src.indexOf("const UI_THEMES:");
  const e = src.indexOf("];", b);
  const blk = src.slice(b, e);
  const ids = [...blk.matchAll(/id: "([a-z-]+)"/g)].map((m) => m[1]);
  ok(ids.length === 12, "테마 12종 (실측 " + ids.length + ")");
  ok(new Set(ids).size === ids.length, "id 중복 없음");
  ok(ids[0] === "dark" && ids.includes("colorful"), "다크(기본)+컬러풀(기존 톤) 포함");
  const hexes = [...blk.matchAll(/[ab]: "(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  ok(hexes.length === 22 && new Set(hexes).size >= 20, "파스텔 10쌍+다크 1쌍의 두 색(a·b) 실재·사실상 전부 상이(톤앤톤 아님)");
  ok(/return "dark"; \/\/ 사용자 결정: 기본은 다크 그레이 2색/.test(src), "저장 없음·손상=다크 기본");
  ok(/if \(o && UI_THEMES\.some\(\(t\) => t\.id === o\.theme\)\)/.test(src), "알 수 없는 id=기본으로 강등(오염 내성)");
}

console.log("[2] 저장·동기화 배선 — 전역 파일·검증 후 저장·푸시 수렴");
{
  ok(src.includes('path.join(BRIDGE_DIR, "ui-theme.json")'), "전역 파일(모든 창 공유·기존 감시 폴더)");
  ok(/if \(!UI_THEMES\.some\(\(t\) => t\.id === id\)\) return false;/.test(src), "저장 전 id 검증(임의 문자열 저장 금지)");
  ok(/m\?\.type === "saveUiTheme" && typeof m\.theme === "string"/.test(src), "저장 메시지 핸들러");
  ok(src.includes("uiTheme: loadUiTheme(),"), "상태 푸시에 테마 동봉");
  ok(src.includes("if (d.uiTheme && d.uiTheme !== curTheme) applyTheme(d.uiTheme);"), "다른 창 변경 동기화(같은 값=무동작)");
}

console.log("[3] 적용 계층 — 변수 3개+클래스만·colorful=무테마·경고색 보존");
{
  const b = src.indexOf("function applyTheme(id){");
  const e = src.indexOf("\n  }", b);
  const blk = b > 0 && e > b ? src.slice(b, e) : "";
  ok(blk.length > 0, "applyTheme 존재(호이스팅 함수 선언)");
  ok(blk.includes('app.classList.remove("themed")') && blk.includes('removeProperty("--tA")'), "colorful=클래스·변수 제거(기존 다색 완전 복원)");
  ok(blk.includes('setProperty("--tA"') && blk.includes('setProperty("--tB"') && blk.includes('setProperty("--tFg"'), "적용은 두 색+글자색 변수 3개뿐(파생은 CSS color-mix)");
  ok(src.includes("applyTheme(curTheme); // 부팅 즉시"), "부팅 즉시 적용(깜빡임 방지)");
  const cssB = src.indexOf(".app.themed{");
  const cssE = src.indexOf("}", cssB);
  const css = src.slice(cssB, cssE);
  ok(css.includes("--vscode-charts-blue:var(--tAccA)") && css.includes("--vscode-charts-green:var(--tAccB)"), "액센트도 두 색 파생으로 교차(A/B 번갈아)");
  ok(!css.includes("--vscode-charts-red") && !css.includes("errorForeground") && !css.includes("inputValidation"), "경고·오류 빨강 계열은 재정의 안 함(위험 신호 보존)");
  ok(src.includes(".app.themed .sb-ico") && src.includes("grayscale(1)"), "컬러풀 외 테마=좌측 이모지 무채색(시안성 — 사용자 지적)");
  // 검증 반영분(blocker+보완): 상단바=색A 직접 결속·액센트 25% 혼합(AA 대비)·라이브 스트립 고정색 수렴
  ok(src.includes(".app.themed .topbar{background:var(--tA)}"), "상단바=색A 직접 결속(editorWidget 혼합색 대체 — blocker)");
  ok(src.includes("var(--tA) 25%,var(--tFg)") && src.includes("var(--tB) 25%,var(--tFg)"), "액센트=원색 25%만 혼합(버튼 글자 AA 대비 — 보완)");
  ok(/\.app\.themed \.lsarrow\.tocodex[\s\S]{0,200}var\(--tAccB\)/.test(src) && !/\.app\.themed[^}]*#3a9/.test(src), "라이브 스트립 고정 상태색도 두 색 파생 수렴(빨강만 원색 — 보완)");
}

console.log("[4] 선택 카드 — 12개 스와치·즉시 적용+저장");
{
  ok(src.includes('id="themeGrid"') && src.includes("UI_THEMES.map((th)"), "관리 패널 스와치 그리드(목록 단일 출처로 생성)");
  ok(src.includes("linear-gradient(105deg,${th.a} 0 50%,${th.b} 50% 100%)"), "스와치=두 색 반반(교차 미리보기)");
  ok(/applyTheme\(id\); \/\/ 즉시 적용[\s\S]{0,200}saveUiTheme/.test(src), "클릭=즉시 적용 후 저장");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
