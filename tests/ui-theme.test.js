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
  ok(!src.includes("grayscale(1)"), "이모지 원색 유지(무채색 철회 — 실사용 피드백 2026-08-08)");
  ok(/\.app\.themed \.integrity\{background:color-mix\(in srgb,#d44 9%,var\(--tB\)\)/.test(src), "경보 배너=테마 밝은 면+빨강 테두리(다크 변수 배경의 글자 실종 봉합 — 실보고)");
  ok(/\.app\.themed button\.secondary\{background:transparent;[^}]*color:var\(--tAccA\)/.test(src), "보조 버튼=글자색 액센트(테두리만 바꾸는 어색함 제거 — 실보고)");
  ok(/\.app\.themed \.langbtn\.on\{color:var\(--tB\);background:var\(--tAccB\)\}/.test(src), "언어 세그=액센트B 채움+본문색 글자(고정 흰 글자 대비 붕괴 방지)");
  // 검증 반영분(blocker+보완): 상단바=색A 직접 결속·액센트 25% 혼합(AA 대비)·라이브 스트립 고정색 수렴
  ok(src.includes(".app.themed .topbar{background:var(--tA)}"), "상단바=색A 직접 결속(editorWidget 혼합색 대체 — blocker)");
  // 대비는 문자열 존재가 아니라 실측 계산으로 잠근다(검증 blocker: '25% 존재'만 검사해 미달을 통과시켰음)
  {
    const tb = src.indexOf("const UI_THEMES:"); const te = src.indexOf("];", tb);
    const defs = [...src.slice(tb, te).matchAll(/id: "([a-z-]+)".*?a: "(#[0-9a-f]{6})", b: "(#[0-9a-f]{6})", fg: "(#[0-9a-f]{6})"/g)];
    const mixM = src.match(/--tAccA:color-mix\(in srgb,var\(--tA\) (\d+)%,var\(--tFg\)\)/);
    ok(!!mixM && defs.length === 11, "혼합비·테마 정의 추출(colorful 제외 11종)");
    const m = Number(mixM ? mixM[1] : 0);
    const h2c = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const mixc = (c1, c2, p) => c1.map((v, i) => Math.round(v * p / 100 + c2[i] * (100 - p) / 100));
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const [r, g, b] = c.map(f); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ctr = (c1, c2) => { const a = lum(c1), b = lum(c2); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    let worst = Infinity, worstName = "";
    for (const d of defs) {
      const A = h2c(d[2]), B = h2c(d[3]), F = h2c(d[4]);
      const accA = mixc(A, F, m), accB = mixc(B, F, m);
      for (const v of [ctr(accA, B), ctr(accB, B), ctr(accA, A), ctr(accB, A)]) if (v < worst) { worst = v; worstName = d[1]; }
    }
    ok(worst >= 4.5, `전 테마 액센트 대비 ≥4.5:1 실측(최악 ${worstName} ${worst.toFixed(2)}:1 — 두 표면 tA·tB 모두)`);
  }
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
