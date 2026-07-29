/*
 * release.js의 순수 함수 검증 — 버전 계산(nextVersion)·작업트리 점검(dirtyTracked).
 * 배포 부작용(git push 등)은 실행하지 않는다(require.main 가드).
 */
const path = require("path");
const { nextVersion, dirtyTracked, parseArgs, publishGate } = require(path.join(__dirname, "..", "scripts", "release.js"));
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

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
