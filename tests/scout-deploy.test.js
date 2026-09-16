/*
 * 정찰(3트랙) 층 이관(2026-09-16 · 사용자 결정) — 마켓 설치본만으로 3트랙이 돌도록 scripts/ 정찰 실행층 12파일이
 * bridge/ 배포 모듈이 되고, scripts/ 원위치는 얇은 래퍼(레포 사용자 명령·require 무회귀)라는 계약을 잠근다.
 *  [1] 본체 12 + 컴파일 코어 사본 3 이 배포 목록 3사본(install.js·hook-setup.ts·map-cutover.js)에 전부 있고 실물이 있다
 *  [2] 본체는 레포 밖(설치본 평면 폴더)에서도 돌게 부모 폴더 상대경로("..", "bridge"/"out")를 쓰지 않는다
 *  [3] 래퍼는 짧고 같은 이름의 bridge 본체만 가리킨다 — 라이브러리 래퍼는 같은 객체를 내보내고, CLI 래퍼는 본체와 같은 종료 코드·stderr
 *  [4] 코어 사본 3종은 out/ 컴파일 산출물과 바이트 동일(sync-map-core --check)
 *  [5] 설치본 평면 폴더 시뮬레이션: BRIDGE_SCRIPTS 전체를 임시 폴더로 복사한 뒤 그 사본에서 정찰 러너가 로드된다(레포 없이)
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
let n = 0;
const ok = (c, m) => { n++; if (!c) { console.log("  ❌ " + m); process.exitCode = 1; } else console.log("  ✅ " + m); };

const MOVED = ["scout-providers.js", "scope-package.js", "scout-store.js", "scope-scout-self.js", "scope-scout-deepseek.js", "scope-scout-codex.js",
  "scope-target.js", "scope-gate.js", "scope-map.js", "scope-ledger-migrate.js", "scope-ledger-backfill.js", "scope-ledger-note.js"];
const CORES = ["scope-package-core.js", "scope-ledger-core.js", "ledger-events-core.js"];
const LIB = ["scout-providers.js", "scout-store.js", "scope-package.js"];
const CLI = MOVED.filter((f) => !LIB.includes(f));

console.log("[1] 배포 목록 3사본 + 실물");
{
  const a = require(path.join(ROOT, "install.js")).BRIDGE_SCRIPTS;
  const c = require(path.join(ROOT, "bridge", "map-cutover.js")).EXPECTED_DEPLOY_FILES;
  const h = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8");
  const hs = (h.match(/BRIDGE_SCRIPTS = \[(.*?)\]/s) || [])[1] || "";
  for (const f of [...MOVED, ...CORES]) ok(a.includes(f) && c.includes(f) && hs.includes('"' + f + '"') && fs.existsSync(path.join(ROOT, "bridge", f)), f + " — install.js·map-cutover·hook-setup 전부 포함 + 실물");
}

console.log("[2] 본체는 설치본 평면 폴더 전제(부모 폴더 상대경로 없음)");
for (const f of MOVED) {
  const s = fs.readFileSync(path.join(ROOT, "bridge", f), "utf8");
  ok(!/"\.\.",\s*"(bridge|out|scripts)"/.test(s) && !/\.\.\/(bridge|out|scripts)\//.test(s), f + " — 부모 폴더(bridge/out/scripts) 참조 없음");
}
{
  const drv = fs.readFileSync(path.join(ROOT, "bridge", "scope-package.js"), "utf8");
  const prov = fs.readFileSync(path.join(ROOT, "bridge", "scout-providers.js"), "utf8");
  ok(/"scope-package-core\.js"/.test(drv) && /"scope-ledger-core\.js"/.test(drv) && /"ledger-events-core\.js"/.test(drv), "드라이버 — 컴파일 코어는 *-core.js 이름으로(드라이버와 이름 충돌 없음)");
  ok(/"scope-package-core\.js"/.test(prov) && /require\("\.\/scope-package\.js"\)/.test(prov), "공급자 — 드라이버(./scope-package.js)와 코어(scope-package-core.js) 둘 다 각자 이름으로");
  ok(/function cliMain\(\)/.test(drv) && /if \(require\.main === module\) cliMain\(\);/.test(drv), "드라이버 — CLI 본체를 cliMain 으로 내보내(래퍼가 require.main 일 때 호출)");
}

console.log("[3] 얇은 래퍼 — 같은 이름 본체 위임");
for (const f of MOVED) {
  const s = fs.readFileSync(path.join(ROOT, "scripts", f), "utf8");
  const lines = s.split(/\r?\n/).filter((l) => l.trim()).length;
  ok(lines <= 5 && new RegExp('"\\.\\.",\\s*"bridge",\\s*"' + f.replace(".", "\\.") + '"').test(s), f + " — 래퍼 " + lines + "줄·bridge/" + f + " 위임");
}
for (const f of LIB) ok(require(path.join(ROOT, "scripts", f)) === require(path.join(ROOT, "bridge", f)), f + " — 라이브러리 래퍼는 본체와 같은 객체");
{
  const drvW = require(path.join(ROOT, "scripts", "scope-package.js"));
  ok(typeof drvW.collectPackage === "function" && typeof drvW.cliMain === "function", "scope-package 래퍼 — collectPackage·cliMain 노출");
}
for (const f of CLI) { // 인자 없는 호출(usage 경로) — 종료 코드·stderr 가 본체와 같다(argv 는 래퍼가 그대로 통과)
  const env = { ...process.env, CODEX_BRIDGE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sdw-")) };
  const w = spawnSync(process.execPath, [path.join(ROOT, "scripts", f)], { encoding: "utf8", env, timeout: 60000 });
  const b = spawnSync(process.execPath, [path.join(ROOT, "bridge", f)], { encoding: "utf8", env, timeout: 60000 });
  ok(w.status === b.status && String(w.stderr).trim() === String(b.stderr).trim(), f + " — 래퍼/본체 무인자 실행: 종료 " + w.status + "=" + b.status + " · stderr 동일");
}

console.log("[4] 코어 사본 패리티");
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "sync-map-core.js"), "--check"], { encoding: "utf8" });
  ok(r.status === 0 && CORES.every((c) => r.stdout.includes("bridge/" + c)), "sync-map-core --check — project-map + 코어 3종 패리티 OK");
  const SM = require(path.join(ROOT, "scripts", "sync-map-core.js"));
  ok(Array.isArray(SM.PAIRS) && SM.PAIRS.length === 4, "PAIRS=4쌍");
  for (const c of CORES) {
    const s = fs.readFileSync(path.join(ROOT, "bridge", c), "utf8");
    ok(!/require\((?!"fs"|"path"|"os"|"crypto"|"child_process")/.test(s), c + " — 내부 require 없음(이름 변경이 안전한 순수 코어)");
  }
}

console.log("[5] 설치본 평면 폴더 시뮬 — 레포 없이 정찰 러너 로드");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sdh-"));
  const inst = path.join(home, "bridge-install");
  fs.mkdirSync(inst, { recursive: true });
  for (const f of require(path.join(ROOT, "install.js")).BRIDGE_SCRIPTS) fs.copyFileSync(path.join(ROOT, "bridge", f), path.join(inst, f));
  const child = `
    const path = require("path");
    const P = require(path.join(${JSON.stringify(inst)}, "scout-providers.js"));
    const S = require(path.join(${JSON.stringify(inst)}, "scout-store.js"));
    const D = require(path.join(${JSON.stringify(inst)}, "scope-package.js"));
    if (typeof P.runScout !== "function" || !P.PROVIDERS || typeof S.saveMap !== "function" || typeof D.collectPackage !== "function") { console.error("shape"); process.exit(3); }
    process.stdout.write(Object.keys(P.PROVIDERS).sort().join(","));
  `;
  const r = spawnSync(process.execPath, ["-e", child], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home }, timeout: 60000 });
  ok(r.status === 0 && /codex,deepseek,self/.test(r.stdout), "설치본 사본만으로 scout-providers·scout-store·scope-package 로드(공급자 3종) — " + (r.stderr || "").slice(0, 120));
  for (const f of ["scope-target.js", "scope-gate.js", "scope-ledger-note.js"]) {
    const rr = spawnSync(process.execPath, [path.join(inst, f)], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home }, timeout: 60000 });
    ok(rr.status === 2 || rr.status === 0, f + " — 설치본 사본에서 무인자 실행이 usage/정상 종료(" + rr.status + ")·require 실패 아님: " + (rr.stderr || "").slice(0, 80));
  }
}

console.log(`scout-deploy: ${n} checks` + (process.exitCode ? " (FAILED)" : " ok"));
