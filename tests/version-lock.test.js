/*
 * 버전 정합 가드 — package.json과 package-lock.json의 버전이 어긋난 채 커밋되는 재발 방지.
 * 배경: 버전 bump 시 lock을 빼먹는 갭이 반복 발생(0.1.68→70, 0.1.76→84, 0.1.85→86 — 3회 실사고).
 * npm test가 매번 도니, 어느 PC에서든 bump 후 테스트만 돌리면 여기서 잡힌다(구조적 해결 — 사람 기억에 안 기댐).
 */
const path = require("path");
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

ok(typeof pkg.version === "string" && /^\d+\.\d+\.\d+$/.test(pkg.version), `package.json 버전 형식(${pkg.version})`);
ok(lock.version === pkg.version, `lock 루트 버전 = package.json (${lock.version} vs ${pkg.version})`);
ok(lock.packages && lock.packages[""] && lock.packages[""].version === pkg.version, `lock packages[""] 버전 = package.json (${lock.packages?.[""]?.version} vs ${pkg.version})`);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
