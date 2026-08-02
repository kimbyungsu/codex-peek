// 로컬 검색기(구현 3조각) · 정본 docs/MAP-RETRIEVAL-SPEC.md §3 '상한'·'점수'
// 계약: 상한 5종=HL 복사(원문 잠금·시간 미확정) · 민감/바이너리/스킵 규칙=기존 복사(원문 잠금) ·
// 상한 도달=truncated 정직 보고 · 점수=Σ(모양 가중치×idf1000) 정수 · 동점=코드 포인트 경로 순 ·
// 읽기 전용·출력 0바이트. capsOverride는 테스트 전용(배선 전달 금지 — 배선 조각에서 잠금).
const path = require("path");
const fs = require("fs");
const os = require("os");
const { searchSeeds, SEARCH_CAPS, SEED_WEIGHTS, SEARCH_SKIP_DIRS, SEARCH_BIN_RE, idf1000 } = require(path.join(__dirname, "..", "bridge", "map-retrieval.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}
const mk = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};
const paths = (r) => r.matches.map((m) => m.path);

console.log("[1] 복사값 잠금 — 상한·민감·스킵·바이너리가 원본과 갈리면 여기서 깨진다");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8");
  const hlLine = [...src.matchAll(/^const HL = \{.*\};/gm)];
  ok(hlLine.length === 1, "const HL 선언 1곳");
  const pick = (k) => { const m = hlLine.length === 1 ? [...hlLine[0][0].matchAll(new RegExp(k + ":\\s*([\\d* ]+),", "g"))] : []; return m.length === 1 ? eval(m[0][1]) : null; };
  ok(pick("maxScanFiles") === SEARCH_CAPS.maxScanFiles && pick("maxDepth") === SEARCH_CAPS.maxDepth, "maxScanFiles·maxDepth 일치");
  ok(pick("maxFileBytes") === SEARCH_CAPS.maxFileBytes && pick("scanBudgetBytes") === SEARCH_CAPS.scanBudgetBytes, "maxFileBytes·scanBudgetBytes 일치");
  // 2차 검증 반례 반영: 원본과 '복사본'을 실제 비교한다(실재 확인만으론 원본 변경 시 침묵 통과)
  const skip = /const SKIP_DIRS = new Set\(\[(.*?)\]\)/.exec(src);
  const origSkip = skip ? skip[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")) : [];
  ok(origSkip.length === SEARCH_SKIP_DIRS.size && origSkip.every((d) => SEARCH_SKIP_DIRS.has(d)), "SKIP_DIRS 복사본=원본 집합 동일");
  const bin = /const BIN_RE = (\/.*\/i);/.exec(src);
  ok(!!bin && bin[1] === String(SEARCH_BIN_RE), "BIN_RE 복사본=원본 정규식 문자 동일");
  const ts = fs.readFileSync(path.join(__dirname, "..", "src", "scope-package.ts"), "utf8");
  const sens = /const SENSITIVE_PATH_RE = (\/.*\/i);/.exec(ts);
  const { SEARCH_SENSITIVE_RE } = (() => { const m = /const SEARCH_SENSITIVE_RE = (\/.*\/i);/.exec(fs.readFileSync(path.join(__dirname, "..", "bridge", "map-retrieval.js"), "utf8")); return { SEARCH_SENSITIVE_RE: m && m[1] }; })();
  ok(!!sens && !!SEARCH_SENSITIVE_RE && sens[1] === SEARCH_SENSITIVE_RE, "민감 경로 정규식 원문 동일(src/scope-package.ts ↔ 복사본)");
}

console.log("[2] 목록화 — 민감·바이너리·스킵 디렉터리·숨김 디렉터리 제외");
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch_"));
  mk(R, "src/app.js", "mapAttachSurface here");
  mk(R, "secrets.txt", "mapAttachSurface secret");
  mk(R, ".env", "mapAttachSurface env");
  mk(R, "node_modules/x/y.js", "mapAttachSurface dep");
  mk(R, "img.png", "mapAttachSurface bin");
  const r = searchSeeds(R, [{ value: "mapAttachSurface", shape: "identifier" }]);
  ok(paths(r).includes("src/app.js"), "정상 파일 매칭");
  ok(!paths(r).some((p) => p.includes("secret") || p.includes(".env") || p.includes("node_modules") || p.endsWith(".png")), "민감·의존성·바이너리 전부 검색 대상 제외");
  ok(r.corpus === 1 && r.truncated === false, "말뭉치=목록화 파일 수·상한 미도달");
}

console.log("[3] 점수 — 모양 가중치×idf 정수 합산·경로 씨앗은 경로로도 매칭·동점=코드 포인트 순");
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch3_"));
  mk(R, "src/a.js", "verifyGuard 내용");
  mk(R, "src/b.js", "verifyGuard 그리고 verifyGuard");
  mk(R, "src/zz.js", "무관 내용");
  const r = searchSeeds(R, [{ value: "verifyGuard", shape: "identifier" }, { value: "src/a.js", shape: "path" }]);
  // N=3(<20) → idf=1000. a.js = identifier(2×1000)+path(3×1000)=5000, b.js = 2000
  const a = r.matches.find((m) => m.path === "src/a.js"), b = r.matches.find((m) => m.path === "src/b.js");
  ok(!!a && a.score === 5000, `경로+식별자 겹침 = 5000 (실측 ${a && a.score})`);
  ok(!!b && b.score === 2000 && r.matches[0].path === "src/a.js", "내용만 = 2000·점수 내림차순");
  ok(!paths(r).includes("src/zz.js"), "무매칭 파일은 결과에 없음");
  ok(SEED_WEIGHTS.path === 3 && SEED_WEIGHTS.backtick === 2 && SEED_WEIGHTS.identifier === 2 && SEED_WEIGHTS.quote === 1, "가중치=명세 고정값(3·2·2·1)");
  const R2 = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch3b_"));
  mk(R2, "b.js", "sameToken");
  mk(R2, "A.js", "sameToken");
  const r2 = searchSeeds(R2, [{ value: "sameToken", shape: "identifier" }]);
  ok(r2.matches.length === 2 && r2.matches[0].path === "A.js", "동점=코드 포인트 경로 순(A(65)<b(98))");
}

console.log("[4] 상한 — 도달하면 truncated 정직 보고(조용한 절단 금지)");
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch4_"));
  for (let i = 0; i < 5; i++) mk(R, `f${i}.js`, "needleToken 내용");
  const rCount = searchSeeds(R, [{ value: "needleToken", shape: "identifier" }], { maxScanFiles: 3 });
  ok(rCount.truncated === true && rCount.corpus === 3, "파일 수 상한 도달=truncated·말뭉치는 실제 목록 수");
  mk(R, "deep/a/b/c/d/e/f/g.js", "needleToken deep");
  const rDepth = searchSeeds(R, [{ value: "needleToken", shape: "identifier" }], { maxDepth: 2 });
  ok(rDepth.truncated === true, "깊이 상한 도달=truncated");
  const rBudget = searchSeeds(R, [{ value: "needleToken", shape: "identifier" }], { scanBudgetBytes: 10 });
  ok(rBudget.truncated === true, "읽기 예산 소진=truncated");
  // 예산 소진 시 내용 미대조 파일은 매칭에서 빠지되 경로 매칭은 유지
  const rBudgetPath = searchSeeds(R, [{ value: "f0.js", shape: "path" }], { scanBudgetBytes: 0 });
  ok(rBudgetPath.truncated === true && paths(rBudgetPath).includes("f0.js"), "예산 0이어도 경로 매칭은 동작(읽지 않은 것을 읽은 척하지 않음)");
  // 2차 검증 반례(실물=src/extension.ts 846KB): 파일당 상한 초과 제외도 잘림이다
  const RF = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch4f_"));
  mk(RF, "big.js", "needleToken ".repeat(10));
  mk(RF, "small.js", "needleToken");
  const rFile = searchSeeds(RF, [{ value: "needleToken", shape: "identifier" }], { maxFileBytes: 20 });
  ok(rFile.truncated === true && rFile.corpus === 1 && paths(rFile).includes("small.js"), "파일당 상한 초과 제외=truncated(부분 검색을 완료로 위장 금지)");
  const RS = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch4s_"));
  mk(RS, "shallow.js", "needleToken 내용");
  const big = searchSeeds(RS, [{ value: "needleToken", shape: "identifier" }]);
  ok(big.truncated === false, "(대조) 기본 상한 안(얕은 픽스처)이면 truncated=false");
}

console.log("[4b] 접근 실패 3분기 — 실패 제외도 truncated(오류 주입·확인 검증 계보 잠금)");
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch4x_"));
  mk(R, "ok.js", "probeToken 내용");
  mk(R, "victim.js", "probeToken 내용");
  const seed = [{ value: "probeToken", shape: "identifier" }];
  const victimAbs = path.join(R, "victim.js");
  // readFileSync 실패 주입 — 특정 파일만 던지게
  const origRead = fs.readFileSync;
  fs.readFileSync = function (p, ...a) { if (String(p) === victimAbs) { const e = new Error("EACCES"); throw e; } return origRead.call(fs, p, ...a); };
  const rRead = searchSeeds(R, seed);
  fs.readFileSync = origRead;
  ok(rRead.truncated === true && paths(rRead).includes("ok.js") && !paths(rRead).includes("victim.js"), "readFile 실패=truncated·나머지 파일 매칭 유지");
  // statSync 실패 주입
  const origStat = fs.statSync;
  fs.statSync = function (p, ...a) { if (String(p) === victimAbs) { throw new Error("EACCES"); } return origStat.call(fs, p, ...a); };
  const rStat = searchSeeds(R, seed);
  fs.statSync = origStat;
  ok(rStat.truncated === true && rStat.corpus === 1, "stat 실패=truncated·말뭉치는 실제 목록 수");
  // readdirSync 실패 주입 — 하위 디렉터리만
  mk(R, "sub/inner.js", "probeToken 내용");
  const subAbs = path.join(R, "sub");
  const origDir = fs.readdirSync;
  fs.readdirSync = function (p, ...a) { if (String(p) === subAbs) { throw new Error("EACCES"); } return origDir.call(fs, p, ...a); };
  const rDir = searchSeeds(R, seed);
  fs.readdirSync = origDir;
  ok(rDir.truncated === true && !paths(rDir).includes("sub/inner.js"), "readdir 실패=truncated(부분 목록을 완료로 위장 금지)");
}

console.log("[5] 순수성 — 출력 0바이트·쓰기 없음·무효 입력 무해");
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "mrsearch5_"));
  mk(R, "a.js", "secretSeed 내용");
  const before = fs.readdirSync(R).length;
  const outs = [];
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outs.push(c); return true; };
  process.stderr.write = (c) => { outs.push(c); return true; };
  searchSeeds(R, [{ value: "secretSeed", shape: "backtick" }]);
  process.stdout.write = so; process.stderr.write = se;
  ok(outs.length === 0, "검색 중 stdout·stderr 0바이트(씨앗 sink 금지)");
  ok(fs.readdirSync(R).length === before, "저장소에 쓰기 없음(읽기 전용)");
  ok(searchSeeds(null, []).matches.length === 0 && searchSeeds(R, null).corpus === 1, "null 루트·null 씨앗 무해");
  const r1 = JSON.stringify(searchSeeds(R, [{ value: "secretSeed", shape: "quote" }]));
  const r2 = JSON.stringify(searchSeeds(R, [{ value: "secretSeed", shape: "quote" }]));
  ok(r1 === r2, "결정론 — 같은 fs 상태 같은 결과");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
