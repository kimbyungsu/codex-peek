/*
 * P0.5 — out/project-map.js(컴파일 산출물)를 bridge/project-map.js(배포 사본)로 동기화.
 * bridge/project-map.js는 git tracked 생성물: VSIX가 scripts/**·out 미빌드 clone을 가정할 수 없어 배포 사본이
 * 레포에 있어야 하고(install.js가 bridge/에서 복사), 신선도는 --check가 잠근다.
 * ⚠머리주석을 덧붙이지 않는다 — 바이트 패리티가 계약(주석을 더하면 패리티가 원리상 불성립).
 * 모드: --write          compile/package 체인에서 복사(내용 동일하면 무기록)
 *       --check          test 체인에서 검사만 — 불일치·부재 시 exit 1(파일을 고치지 않음 — stale 커밋 검출)
 *       --watch-with-tsc 개발용: tsc -watch를 자식으로 띄우고 out 변경 시 사본 자동 갱신
 * 2차 검증 반영: 동기화 실패는 침묵 금지(소스 '부재'만 무시 — 쓰기·판독 실패는 표면화+비정상 종료: 실패가
 * 은폐되면 1차 지적의 stale 실행이 무경고로 재발), 쓰기는 tmp+rename 원자, 자식은 shell 없이 tsc JS bin을
 * process.execPath로 직접 실행(종료 코드·시그널 정직 전파·부모 시그널에서 정리). 코어는 주입 가능(테스트가
 * syncOnce/startWatch를 가짜 자식·임시 파일로 검증).
 */
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "out", "project-map.js");
const DST = path.join(__dirname, "..", "bridge", "project-map.js");

// 1회 동기화 — 결과를 구조로 반환(호출자가 실패를 판단: watch는 fatal, --write는 exit 1).
function syncOnce(src, dst) {
  let s;
  try { s = fs.readFileSync(src, "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? { st: "src-missing" } : { st: "read-failed", error: String(e && e.message || e) }; }
  let d = null;
  try { d = fs.readFileSync(dst, "utf8"); }
  catch (e) { if (!(e && e.code === "ENOENT")) return { st: "read-failed", error: String(e && e.message || e) }; } // ENOENT만 '첫 생성' — EACCES/EISDIR 등을 부재로 보면 읽지 못한 기존 사본을 덮어씀(3차 반례)
  if (d === s) return { st: "same" };
  const tmp = dst + "." + process.pid + ".tmp"; // 원자 쓰기(tmp+rename) — 부분 쓰기 잔재 방지(기존 규율)
  try {
    fs.writeFileSync(tmp, s, "utf8");
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 무해 */ }
    return { st: "write-failed", error: String(e && e.message || e) };
  }
  return { st: "synced", bytes: s.length };
}

// watch 수명주기 — spawnChild·onExit 주입 가능(테스트용). 반환 {stop}: watcher 해제+자식 종료.
// 계약: 초기 1회 sync, src 변경 시 sync, 판독/쓰기 실패=fatal(즉시 표면화+정리+onExit(1)),
// 자식 error/exit는 정리 후 코드 전파(시그널 종료·null 코드=비정상 → 1, 성공 위장 금지).
function startWatch({ src, dst, spawnChild, onExit, intervalMs = 1000, log = console.log, logErr = console.error }) {
  let stopped = false;
  let finished = false;
  let child = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { fs.unwatchFile(src); } catch { /* 무해 */ }
    if (child && child.kill) { try { child.kill(); } catch { /* 무해 */ } }
  };
  // finish는 정확히 1회(3차 반례: child error→exit 연쇄, sync fatal→kill→exit 연쇄가 onExit를 중복 호출)
  const finish = (code) => { if (finished) return; finished = true; stop(); onExit(code); };
  const tick = () => {
    if (stopped) return;
    const r = syncOnce(src, dst);
    if (r.st === "synced") log("sync-map-core: bridge/project-map.js 갱신(watch, " + r.bytes + " chars)");
    else if (r.st === "write-failed" || r.st === "read-failed") { logErr("sync-map-core: 동기화 실패(" + r.st + "): " + r.error + " — watch 중단(침묵 금지: 낡은 사본 실행 방지)"); finish(1); }
    // src-missing·same은 무시(초기엔 tsc가 아직 out을 안 만들었을 수 있음)
  };
  fs.watchFile(src, { interval: intervalMs }, tick);
  tick();
  if (stopped) return { stop }; // 초기 tick에서 fatal이면 자식을 띄우지 않음
  child = spawnChild();
  child.on("error", (e) => { logErr("sync-map-core: tsc 실행 실패: " + (e && e.message || e)); finish(1); });
  child.on("exit", (code, signal) => { finish(signal ? 1 : (code === null || code === undefined ? 1 : code)); }); // 시그널·미상 종료=1(성공 위장 금지)
  return { stop };
}

function main() {
  const mode = process.argv[2];
  if (mode === "--watch-with-tsc") {
    const { spawn } = require("child_process");
    const tscBin = path.join(__dirname, "..", "node_modules", "typescript", "bin", "tsc"); // JS bin을 node로 직접(2차 지적: shell 경유는 고아·코드 전파 문제)
    const w = startWatch({
      src: SRC, dst: DST,
      spawnChild: () => spawn(process.execPath, [tscBin, "-watch", "-p", "./"], { stdio: "inherit", cwd: path.join(__dirname, "..") }),
      onExit: (code) => process.exit(code),
    });
    const onSig = () => { w.stop(); process.exit(130); };
    process.on("SIGINT", onSig); process.on("SIGTERM", onSig);
    return;
  }
  if (mode === "--check") {
    // --check는 파일을 절대 고치지 않는다 — syncOnce(불일치 시 쓰기)를 재사용하지 않고 직접 비교만
    let s = null, d = null;
    try { s = fs.readFileSync(SRC, "utf8"); } catch { console.error("out/project-map.js 없음 — 먼저 tsc(컴파일)"); process.exit(1); }
    try { d = fs.readFileSync(DST, "utf8"); } catch { /* 부재 */ }
    if (d === s) { console.log("sync-map-core: 패리티 OK(bridge/project-map.js == out/project-map.js)"); process.exit(0); }
    console.error("sync-map-core: 불일치 — bridge/project-map.js가 낡음(src 변경 후 `npm run compile` 미실행 또는 미커밋). --check는 파일을 고치지 않는다.");
    process.exit(1);
  }
  if (mode === "--write") {
    const r = syncOnce(SRC, DST);
    if (r.st === "same") { console.log("sync-map-core: 이미 동일 — 무기록"); process.exit(0); }
    if (r.st === "synced") { console.log("sync-map-core: bridge/project-map.js 갱신(" + r.bytes + " chars)"); process.exit(0); }
    console.error("sync-map-core: " + (r.st === "src-missing" ? "out/project-map.js 없음 — 먼저 tsc(컴파일)" : "실패(" + r.st + "): " + r.error));
    process.exit(1);
  }
  console.error("사용: node scripts/sync-map-core.js --write|--check|--watch-with-tsc");
  process.exit(2);
}

if (require.main === module) main();
module.exports = { syncOnce, startWatch };
