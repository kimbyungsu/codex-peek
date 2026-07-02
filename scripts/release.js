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

// ── 인자 해석(순수 — 테스트 대상) ──
function parseArgs(args) {
  const kind = args.includes("--major") ? "major" : args.includes("--minor") ? "minor" : "patch";
  const vi = args.indexOf("--version");
  if (vi >= 0 && (!args[vi + 1] || args[vi + 1].startsWith("--"))) throw new Error("--version 뒤에 버전을 지정하세요 (예: --version 0.2.0)"); // 단독 --version이 조용히 patch로 빠지는 것 방지
  const poi = args.indexOf("--publish-only");
  const poArg = poi >= 0 && args[poi + 1] && !args[poi + 1].startsWith("--") ? args[poi + 1] : null;
  return {
    kind,
    explicit: vi >= 0 ? args[vi + 1] : null,
    doInstall: !args.includes("--no-install"),
    doPush: !args.includes("--no-push"),
    publishOnly: poi >= 0,
    publishOnlyPath: poArg, // 없으면 현재 버전 vsix 자동 선택
  };
}

// ── 마켓 게시 조건(순수 — 테스트 대상): push까지 된 '완전 배포'일 때만 자동 게시 — --no-push인데 마켓만 앞서가는 반쪽 배포 방지(Codex 지적) ──
function publishGate(doPush, hasPat) { return !!(doPush && hasPat); }

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: ROOT, timeout: opts.timeout || 600000 });
  if (r.status !== 0) throw new Error(`실패: ${cmd} (exit ${r.status})`);
}
function runOut(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", cwd: ROOT, timeout: 120000 });
  return { status: r.status, out: String(r.stdout || "") };
}

function main() {
  const { kind, explicit, doInstall, doPush, publishOnly, publishOnlyPath } = parseArgs(process.argv.slice(2));

  // ── publish-only 모드: 버전·빌드·커밋 없이 '이미 만든 vsix'만 마켓 게시(푸시 후 마켓만 실패했을 때의 재시도 경로 — 버전 중복 증가 방지) ──
  if (publishOnly) {
    if (!process.env.VSCE_PAT) { console.error("❌ --publish-only는 VSCE_PAT 환경변수가 필요합니다(마켓 publish 권한 토큰)."); process.exit(1); }
    const cur = JSON.parse(fs.readFileSync(PKG, "utf8")).version;
    const vsix = publishOnlyPath ? path.resolve(publishOnlyPath) : path.join(ROOT, `codex-bridge-${cur}.vsix`);
    if (!fs.existsSync(vsix)) { console.error(`❌ vsix가 없습니다: ${vsix}\n   (경로 지정: npm run release -- --publish-only <vsix경로>)`); process.exit(1); }
    console.log(`▶ 마켓 게시만 재시도: ${vsix}`);
    run(`npx vsce publish --packagePath "${vsix}"`);
    console.log("✅ 마켓 게시 완료(심사 후 공개)");
    return;
  }

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
    if (doPush) {
      console.log("▶ 깃헙 push");
      try { run("git push origin main"); }
      catch (e) {
        console.error(`❌ push 실패(버전 커밋은 로컬에 있음): ${e.message}`);
        console.error(`   → 네트워크 확인 후: git push origin main`);
        console.error(`   → 그다음 마켓 게시: npm run release -- --publish-only "${vsix}"  (또는 관리 페이지에 드래그)`);
        process.exit(1);
      }
    }

    // 5) 마켓 — 'push까지 된 완전 배포'일 때만 자동 게시(--no-push면 마켓도 건너뜀 — 마켓만 앞서가는 반쪽 배포 방지)
    if (publishGate(doPush, !!process.env.VSCE_PAT)) {
      console.log("▶ 마켓 자동 게시(vsce publish)");
      try { run(`npx vsce publish --packagePath "${vsix}"`); }
      catch (e) {
        console.error(`❌ 마켓 게시만 실패 — 깃헙은 v${to}로 이미 반영됨(재실행하면 버전이 또 올라가니 재실행 금지).`);
        console.error(`   → 게시만 재시도: npm run release -- --publish-only "${vsix}"`);
        console.error(`   → 또는 관리 페이지 ⋮ → Update 에 위 vsix 드래그`);
        process.exit(1);
      }
      console.log(`✅ 배포 완료: v${to} — 깃헙 + 마켓 모두 반영(마켓 심사 후 공개)`);
    } else {
      console.log(`✅ 배포 준비 완료: v${to}`);
      console.log(`   깃헙: ${doPush ? "push 완료" : "push 생략(--no-push)"}`);
      if (!doPush && process.env.VSCE_PAT) console.log(`   마켓: --no-push라 자동 게시도 건너뜀(반쪽 배포 방지) — push 후: npm run release -- --publish-only "${vsix}"`);
      else {
        console.log(`   마켓: 아래 파일을 관리 페이지 ⋮ → Update 에 드래그하세요`);
        console.log(`   ${vsix}`);
        console.log(`   (드래그도 없애려면: 마켓 publish 권한 PAT를 발급해 환경변수 VSCE_PAT로 두면 자동 게시)`);
      }
    }
  } catch (e) {
    // bump~커밋 사이 실패: 버전 파일이 아직 미커밋(작업트리에 남음)이면 원복. push/publish 실패는 위에서 각자 정확한 재시도 안내 후 종료.
    const stillDirty = runOut("git status --porcelain").out.split(/\r?\n/).some((l) => /package(-lock)?\.json/.test(l));
    if (stillDirty) {
      spawnSync(`git checkout -- "${PKG}" "${LOCK}"`, { shell: true, cwd: ROOT });
      console.error(`❌ 배포 중단(버전 파일 원복 — 아무것도 반영 안 됨): ${e.message}`);
    } else {
      console.error(`❌ 배포 중단(버전 커밋은 이미 됨 — git log 확인 후 수동 정리): ${e.message}`);
    }
    process.exit(1);
  }
}

module.exports = { nextVersion, dirtyTracked, parseArgs, publishGate };
if (require.main === module) main();
