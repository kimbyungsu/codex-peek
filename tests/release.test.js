/*
 * release.js의 순수 함수 검증 — 버전 계산(nextVersion)·작업트리 점검(dirtyTracked).
 * 배포 부작용(git push 등)은 실행하지 않는다(require.main 가드).
 */
const path = require("path");
const { nextVersion, dirtyTracked, parseArgs, publishGate, stepTimeoutMsFor } = require(path.join(__dirname, "..", "scripts", "release.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[nextVersion] patch/minor/major/명시 버전");
ok(nextVersion("0.1.74", "patch") === "0.1.75", "patch: 0.1.74→0.1.75");
ok(nextVersion("0.1.74", "minor") === "0.2.0", "minor: 0.1.74→0.2.0");
ok(nextVersion("0.1.74", "major") === "1.0.0", "major: 0.1.74→1.0.0");
ok(nextVersion("0.1.74", "patch", "0.3.1") === "0.3.1", "--version 명시가 우선");
let threw = false; try { nextVersion("0.1.74", "patch", "abc"); } catch { threw = true; }
ok(threw, "잘못된 --version 형식은 거부");
threw = false; try { nextVersion("v1.2", "patch"); } catch { threw = true; }
ok(threw, "해석 불가한 현재 버전은 거부");

console.log("[dirtyTracked] 추적 파일 변경만 잡음(미추적 ?? 제외)");
ok(dirtyTracked(" M src/extension.ts\n?? docs/intro.html\n").join(",") === "src/extension.ts", "수정 1건만(미추적 제외)");
ok(dirtyTracked("?? a.txt\n?? b.txt\n").length === 0, "미추적만 있으면 깨끗");
ok(dirtyTracked("").length === 0, "빈 상태 깨끗");
ok(dirtyTracked("A  new.ts\nM  old.ts\n").length === 2, "staged 추가/수정도 잡음");

console.log("[stepTimeoutMsFor] 단계 timeout — 기본 90분·env 양수 분만 반영(2026-09-18 timeout 사망 재발 방지)");
ok(stepTimeoutMsFor({}) === 90 * 60000, "env 없음=90분");
ok(stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "120" }) === 120 * 60000, "env 120=120분");
ok(stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "0" }) === 90 * 60000 && stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "abc" }) === 90 * 60000 && stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "-5" }) === 90 * 60000, "0·비수·음수=기본 90분");
// 검증 지적(2026-09-18): 유한 양수라도 소수·거대값은 spawnSync 가 거부하는 비정수/Infinity ms 가 됐다 — 정수 ms 로 정규화·상한.
ok(stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "1.5" }) === 90000, "소수 1.5분=90000ms(정수)");
ok(stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "0.000001" }) === 1, "극소 양수=최소 1ms(정수·spawnSync 허용)");
ok(stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "1e308" }) === 2147483647, "거대값=타이머 상한(2^31-1)·Infinity 아님");
ok(stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: "Infinity" }) === 90 * 60000, "Infinity 문자열=기본 90분");
for (const raw of ["", "abc", "0", "-5", "1.5", "0.000001", "1e308", "120"]) {
  const r = stepTimeoutMsFor({ CODEX_BRIDGE_RELEASE_STEP_TIMEOUT_MIN: raw });
  ok(Number.isInteger(r) && r >= 1 && r <= 2147483647, "모든 입력이 유한 정수 ms 범위: " + JSON.stringify(raw) + "→" + r);
}

console.log("[parseArgs] 플래그 해석(publish-only 경로 유무 포함)");
let a = parseArgs([]);
ok(a.kind === "patch" && a.doInstall && a.doPush && !a.publishOnly, "기본: patch·설치·push·게시모드 아님");
a = parseArgs(["--minor", "--no-install", "--no-push"]);
ok(a.kind === "minor" && !a.doInstall && !a.doPush, "--minor --no-install --no-push");
a = parseArgs(["--publish-only"]);
ok(a.publishOnly && a.publishOnlyPath === null, "--publish-only(경로 없음 → 현재 버전 vsix 자동)");
a = parseArgs(["--publish-only", "codex-bridge-0.1.75.vsix"]);
ok(a.publishOnly && a.publishOnlyPath === "codex-bridge-0.1.75.vsix", "--publish-only <경로>");
a = parseArgs(["--publish-only", "--no-push"]);
ok(a.publishOnly && a.publishOnlyPath === null, "--publish-only 뒤 플래그는 경로로 안 오인");
threw = false; try { parseArgs(["--version"]); } catch { threw = true; }
ok(threw, "--version 단독(값 없음)은 에러 — 조용히 patch로 안 빠짐");
threw = false; try { parseArgs(["--version", "--minor"]); } catch { threw = true; }
ok(threw, "--version 뒤가 플래그여도 에러");

console.log("[publishGate] 마켓 자동 게시는 'push까지 된 완전 배포'일 때만(반쪽 배포 방지)");
ok(publishGate(true, true) === true, "push O + PAT O → 게시");
ok(publishGate(false, true) === false, "--no-push + PAT O → 게시 안 함(핵심 반례)");
ok(publishGate(true, false) === false, "PAT 없음 → 게시 안 함(경로 안내)");
ok(publishGate(false, false) === false, "둘 다 없음 → 게시 안 함");

console.log("[패키징 제외] 릴리스 자산이 확장 설치 파일 안으로 들어가지 않는다(2026-07-29 실측 사고)");
{
  // 릴리스 자산(전체 설치 묶음·체크섬)은 저장소 루트에 잠깐 놓였다가 업로드된다. 그 사이에 확장을 구우면
  // 7MB짜리 묶음이 설치 파일 안으로 통째로 들어갔다(55개 1.98MB → 57개 9.57MB 실측).
  const fs2 = require("fs");
  const p2 = require("path");
  const ig = fs2.readFileSync(p2.join(__dirname, "..", ".vscodeignore"), "utf8").split(/\r?\n/).map((s) => s.trim());
  ok(ig.includes("*.zip"), "전체 설치 묶음(zip) 제외");
  ok(ig.includes("SHA256SUMS.txt"), "체크섬 파일 제외");
  ok(ig.includes("*.vsix"), "다른 버전 확장 파일 제외(기존 계약 무회귀)");
  ok(ig.includes("docs/*.md"), "런타임과 무관한 내부 작업 문서 제외(패키징 위생)");
}

console.log("[패키징 제외 2] out/ 에는 컴파일 산출물(src/*.ts→out/*.js)만 — 작업 산출물(스모크·진단 프롬프트/응답·.cmds·하위 폴더)은 vsix 에 안 들어간다(2026-09-21 릴리스 검증 [주의])");
{
  const fs2 = require("fs");
  const p2 = require("path");
  const ROOT2 = p2.join(__dirname, "..");
  const lines = fs2.readFileSync(p2.join(ROOT2, ".vscodeignore"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  for (const r of ["out/*/**", "out/*.cmds", "out/*.txt", "out/*.json", "out/smoke_*.js", "out/*.test.js"]) ok(lines.includes(r), "제외 규칙 " + r);
  ok(!lines.some((l) => l.startsWith("!out/")), "out/ 에 부정(!) 패턴 없음 — vsce 는 부정 패턴이 모든 제외를 이기므로 명시 제외만 쓴다");
  // vsce(package.js collectFiles)와 같은 판정: 제외 패턴에 하나라도 걸리면 빠지되, 부정 패턴에 걸리면 무조건 남는다(minimatch dot:true)
  const { minimatch } = require("minimatch");
  const ignore = lines.filter((l) => !l.startsWith("!")), negate = lines.filter((l) => l.startsWith("!")).map((l) => l.slice(1));
  const kept = (f) => !ignore.some((i) => minimatch(f, i, { dot: true })) || negate.some((i) => minimatch(f, i, { dot: true }));
  const srcJs = fs2.readdirSync(p2.join(ROOT2, "src")).filter((f) => f.endsWith(".ts")).map((f) => "out/" + f.replace(/\.ts$/, ".js"));
  ok(srcJs.length >= 10 && srcJs.every(kept), "컴파일 산출물 " + srcJs.length + "개는 전부 실린다");
  const junk = ["out/smoke_cc_en.js", "out/chain_tail.log.cmds", "out/enrich-diag-2026-09-18/enrich_diag.js", "out/enrich-diag-2026-09-18/diag1.prompt.txt", "out/enrich-diag-2026-09-18/diag1.result.json", "out/pkg/codex-peek-0.1.102/package.json", "out/extension.js.map", "out/notes.txt", "out/x.json", "out/foo.test.js", "out/chain-bundle4.log"];
  ok(junk.every((f) => !kept(f)), "작업 산출물(스모크·.cmds·진단 폴더·pkg·map·txt·json·시험·로그)은 전부 빠진다");
  // 로컬 out/ 잔재 감시(fail-visible): 최상위 out/*.js 는 src/*.ts 짝이 있어야 한다 — 짝 없는 js 가 남아 있으면 배포 전에 지우라는 신호(체인은 패키징보다 먼저 돈다)
  const outDir = p2.join(ROOT2, "out");
  const strays = fs2.existsSync(outDir) ? fs2.readdirSync(outDir).filter((f) => /\.js$/.test(f) && !fs2.existsSync(p2.join(ROOT2, "src", f.replace(/\.js$/, ".ts")))) : [];
  ok(strays.length === 0, "out/ 최상위에 src 짝 없는 js 잔재 없음" + (strays.length ? " — 지우세요: " + strays.join(", ") : ""));
}

console.log("[패키징 제외 3] 실제 선별 결과 허용 목록 — vsce listFiles(패키저와 같은 선별)가 고른 파일의 최상위 항목은 확장 런타임 구성물뿐이어야 한다(2026-09-21 확인 검증 blocker: .gitignore 대상 _backups/ 가 vsix 에 실림)");
(async () => {
  try {
    const fs3 = require("fs");
    const p3 = require("path");
    const ROOT3 = p3.join(__dirname, "..");
    const vsce = require("@vscode/vsce");
    const files = (await vsce.listFiles({ cwd: ROOT3, packageManager: vsce.PackageManager.None })).map((f) => String(f).replace(/\\/g, "/"));
    const srcNames = new Set(fs3.readdirSync(p3.join(ROOT3, "src")).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ".js")));
    // 허용 목록: 실행 계층(bridge/)·컴파일 산출물(out/*.js — src 짝)·문서 이미지(docs/*.png|svg)·플러그인 매니페스트·수칙서 스냅숏·package.json·LICENSE·readme(--readme-path)
    const allowed = (f) => {
      if (/^bridge\/[^/]+\.js$/.test(f)) return true;
      if (/^out\/[^/]+\.js$/.test(f)) return srcNames.has(f.slice(4));
      if (/^docs\/[^/]+\.(png|svg)$/.test(f)) return true;
      if (/^codex-plugin\//.test(f) || /^\.agents\//.test(f)) return true;
      return ["package.json", "LICENSE", "LICENSE.txt", "verify-envelope.json", "verify-envelope-archive.json", "docs/README.en.md", "README.md"].includes(f);
    };
    const bad = files.filter((f) => !allowed(f));
    ok(files.length >= 70 && files.some((f) => f === "bridge/map-enrich.js") && files.some((f) => f === "out/extension.js"), "선별 결과 " + files.length + "개 — 실행 계층·컴파일 산출물 포함");
    ok(bad.length === 0, "허용 목록 밖 파일 0" + (bad.length ? " — " + bad.slice(0, 12).join(", ") + (bad.length > 12 ? " …(" + bad.length + "건)" : "") : ""));
    ok(!files.some((f) => /^_backups\//.test(f) || /^out\/.+\//.test(f) || /\.(txt|cmds|log)$/.test(f)), "_backups·out 하위 폴더·txt/cmds/log 없음");
  } catch (e) {
    ok(false, "vsce listFiles 실행 실패: " + String(e && e.message || e).slice(0, 200));
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
