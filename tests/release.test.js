/*
 * release.js의 순수 함수 검증 — 버전 계산(nextVersion)·작업트리 점검(dirtyTracked).
 * 배포 부작용(git push 등)은 실행하지 않는다(require.main 가드).
 */
const path = require("path");
const { nextVersion, dirtyTracked } = require(path.join(__dirname, "..", "scripts", "release.js"));
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

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
