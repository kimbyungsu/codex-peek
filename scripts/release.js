/*
 * 한 줄 배포 파이프라인 — 조수(AI)의 기억이 아니라 '저장소에 박힌 명령'. 누가 어느 PC에서 하든 동일.
 * 사용: npm run release                    (버전 patch 올림 → 테스트 → 빌드+로컬설치 → 커밋+push → 마켓 게시/안내)
 *       npm run release -- --minor        (0.2.0처럼 가운데 올림 / --major, --version 1.2.3 도 가능)
 *       npm run release -- --no-install   (이 PC 설치 생략 — 빌드만)
 *       npm run release -- --no-push      (깃헙 push 생략)
 * 마켓 자동 게시: 환경변수 VSCE_PAT(마켓 publish 권한 토큰)가 있으면 vsce publish까지 자동.
 *   없으면 마지막에 '업로드할 vsix 경로'를 안내(사용자 드래그 1회). 토큰을 이 파일/스크립트에 박지 말 것.
 * 규칙: 마켓은 같은 버전 재업로드를 거부하므로 배포마다 버전이 반드시 올라간다(이 스크립트가 자동으로 올림).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PKG = path.join(ROOT, "package.json");
const LOCK = path.join(ROOT, "package-lock.json");

// ── 버전 계산(순수 — 테스트 대상) ──
function nextVersion(cur, kind, explicit) {
  if (explicit) {
    if (!/^\d+\.\d+\.\d+$/.test(explicit)) throw new Error(`--version 형식 오류: ${explicit} (예: 0.2.0)`);
    return explicit;
  }
  const m = String(cur).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`현재 버전을 해석 못 함: ${cur}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

// ── 작업트리 안전 점검(순수 — 테스트 대상): 추적 파일의 미커밋 변경이 있으면 배포 중단(반쪽 배포 방지) ──
function dirtyTracked(porcelain) {
  return String(porcelain || "").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("??")).map((l) => l.slice(3).trim());
}

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: ROOT, timeout: opts.timeout || 600000 });
  if (r.status !== 0) throw new Error(`실패: ${cmd} (exit ${r.status})`);
}
function runOut(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", cwd: ROOT, timeout: 120000 });
  return { status: r.status, out: String(r.stdout || "") };
}

function main() {
  const args = process.argv.slice(2);
  const kind = args.includes("--major") ? "major" : args.includes("--minor") ? "minor" : "patch";
  const vi = args.indexOf("--version");
  const explicit = vi >= 0 ? args[vi + 1] : null;
  const doInstall = !args.includes("--no-install");
  const doPush = !args.includes("--no-push");

  // 0) 작업트리 점검 — 추적 파일 변경이 남아 있으면 중단(무엇이 배포되는지 명확하게)
  const st = runOut("git status --porcelain");
  const dirty = dirtyTracked(st.out);
  if (dirty.length) {
    console.error("❌ 커밋되지 않은 변경이 있습니다 — 먼저 커밋(또는 되돌리기)한 뒤 배포하세요:");
    for (const f of dirty) console.error("   · " + f);
    process.exit(1);
  }

  // 1) 버전 올림(package.json + package-lock 두 곳)
  const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
  const from = pkg.version;
  const to = nextVersion(from, kind, explicit);
  fs.writeFileSync(PKG, fs.readFileSync(PKG, "utf8").replace(`"version": "${from}"`, `"version": "${to}"`));
  fs.writeFileSync(LOCK, fs.readFileSync(LOCK, "utf8").split(`"version": "${from}"`).join(`"version": "${to}"`));
  console.log(`▶ 버전: ${from} → ${to}`);

  try {
    // 2) 전체 테스트
    console.log("▶ 테스트");
    run("npm test");

    // 3) 빌드(+이 PC 설치) — install.js가 vsix를 현재 소스로 새로 굽고(영문 마켓 소개 동봉) 설치까지. --no-install이면 빌드만.
    if (doInstall) { console.log("▶ 빌드 + 로컬 설치"); run("node install.js"); }
    else { console.log("▶ 빌드"); run("npm run package"); }

    const vsix = path.join(ROOT, `codex-bridge-${to}.vsix`);
    if (!fs.existsSync(vsix)) throw new Error(`vsix가 없습니다: ${vsix}`);

    // 4) 버전 커밋 + push(깃헙 최신화 — 깃헙 3줄 설치도 이걸로 최신)
    run(`git add "${PKG}" "${LOCK}"`);
    run(`git commit -m "chore(release): v${to}"`);
    if (doPush) { console.log("▶ 깃헙 push"); run("git push origin main"); }

    // 5) 마켓 — VSCE_PAT 있으면 자동 게시, 없으면 업로드 경로 안내
    if (process.env.VSCE_PAT) {
      console.log("▶ 마켓 자동 게시(vsce publish)");
      run(`npx vsce publish --packagePath "${vsix}"`);
      console.log(`✅ 배포 완료: v${to} — 깃헙 + 마켓 모두 반영(마켓 심사 후 공개)`);
    } else {
      console.log(`✅ 배포 준비 완료: v${to}`);
      console.log(`   깃헙: ${doPush ? "push 완료" : "push 생략(--no-push)"}`);
      console.log(`   마켓: 아래 파일을 관리 페이지 ⋮ → Update 에 드래그하세요`);
      console.log(`   ${vsix}`);
      console.log(`   (드래그도 없애려면: 마켓 publish 권한 PAT를 발급해 환경변수 VSCE_PAT로 두면 자동 게시)`);
    }
  } catch (e) {
    // 실패 시 버전 파일 원복(반쪽 배포 방지) — 이미 커밋된 뒤 실패(푸시 등)면 사용자가 상태를 보고 판단하도록 그대로 둠
    const committed = runOut("git status --porcelain").out.split(/\r?\n/).some((l) => /package(-lock)?\.json/.test(l));
    if (committed) {
      spawnSync(`git checkout -- "${PKG}" "${LOCK}"`, { shell: true, cwd: ROOT });
      console.error(`❌ 배포 중단(버전 파일 원복): ${e.message}`);
    } else {
      console.error(`❌ 배포 중단(버전 커밋은 이미 됨 — git log 확인 후 수동 정리): ${e.message}`);
    }
    process.exit(1);
  }
}

module.exports = { nextVersion, dirtyTracked };
if (require.main === module) main();
