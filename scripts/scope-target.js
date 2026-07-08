/*
 * 정찰 대상 지정 CLI(P1 — 세션 폴더≠개발 레포 해소) — 계약의 scoutRepo를 확인/지정/자동감지/해제한다.
 * 지정되면 정찰 계열(지도·꾸러미 대상·관찰 일지·확인 신호·플랜 게이트)이 전부 이 레포 기준으로 동작한다.
 * 검증·연결·계약의 '연 폴더' 앵커는 불변(정찰 계열만 재해석 — 검증모델 합의 2026-07-08).
 *
 * 자동 감지는 보수적: 세션 폴더 자신이 git 루트면 지정 불요, 아니면 '바로 아래 1단계'에서 git 루트를 찾아
 * 정확히 1개일 때만 제안한다(복수면 나열만 하고 사용자가 set으로 명시 — 조용한 오지정 방지).
 *
 * 사용: node scripts/scope-target.js <ws> [status|set <repo>|auto|clear]
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { contractFileFor, loadContract, atomicWrite, resolveScoutRepo } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const wsArg = process.argv[2];
const cmd = process.argv[3] || "status";
const arg = process.argv[4];
if (!wsArg || !["status", "set", "auto", "clear"].includes(cmd)) {
  console.error("사용: node scripts/scope-target.js <ws> [status|set <repo>|auto|clear]");
  process.exit(2);
}
const ws = path.resolve(wsArg);
const hasGitDir = (p) => { try { return fs.existsSync(path.join(p, ".git")); } catch { return false; } };
// '쓸 수 있는 git'인지 — .git 폴더 존재만으론 부족(실사고 2026-07-08: 커밋 0개인 빈 .git이 있는 세션 폴더를
// auto가 '지정 불요'로 오판 → 정찰이 계속 무이력 약체 모드로 돌았음). rev-parse HEAD 성공 = 이력 있음.
const usableGit = (p) => {
  if (!hasGitDir(p)) return false;
  try {
    const r = spawnSync("git", ["-c", "safe.directory=" + String(p).replace(/\\/g, "/"), "-C", p, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    return r.status === 0 && !r.error;
  } catch { return false; }
};
const gitLabel = (p) => usableGit(p) ? "git 저장소(이력 있음)" : hasGitDir(p) ? "git 폴더는 있으나 커밋 이력 없음(무이력 모드로 동작)" : "비-git(무이력 모드로 동작)";

function writeBothSlots(mutate) {
  const files = [contractFileFor(ws, "ko"), contractFileFor(ws, "en")];
  let touched = 0;
  for (const f of files) {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* 이 슬롯 없음 */ }
    if (!o) { if (f !== files[0]) continue; o = {}; } // en은 있을 때만(없는 슬롯 생성 금지 — scope-gate와 동일 규칙)
    mutate(o);
    if (!atomicWrite(f, JSON.stringify({ ...o, updatedAt: new Date().toISOString() }, null, 2))) {
      console.error(`저장 실패: ${f} (권한/디스크?)`); process.exit(1);
    }
    touched++;
  }
  return touched;
}
function setTarget(repoAbs) {
  if (!fs.existsSync(repoAbs) || !fs.statSync(repoAbs).isDirectory()) { console.error(`대상이 존재하지 않거나 폴더가 아님: ${repoAbs}`); process.exit(1); }
  const n = writeBothSlots((o) => { o.scoutRepo = repoAbs; });
  console.log(`scoutRepo=${repoAbs} 저장(계약 파일 ${n}개 갱신).`);
  if (!usableGit(repoAbs)) console.log("ⓘ 대상: " + gitLabel(repoAbs) + " — 정찰이 전후 비교 없는 축소 꾸러미로 동작합니다(정직 고지).");
  console.log("ⓘ 이관: 기존에 세션 폴더 서랍에 쌓인 관찰 일지가 있으면 node scripts/scope-ledger-migrate.js로 옮길 수 있습니다(--dry 먼저).");
}

if (cmd === "status") {
  const r = resolveScoutRepo(ws, loadContract(ws));
  console.log(`정찰 대상: ${r.repo}${r.source === "contract" ? " (계약 지정)" : r.source === "ws-fallback-invalid" ? " (⚠ 지정값 무효 — 폴더 사라짐, 세션 폴더로 폴백 중)" : " (지정 없음 — 세션 폴더 그대로)"}`);
  console.log(`대상 git 여부: ${gitLabel(r.repo)}`);
  process.exit(0);
}
if (cmd === "clear") {
  const n = writeBothSlots((o) => { delete o.scoutRepo; });
  console.log(`scoutRepo 해제(계약 파일 ${n}개 갱신) — 정찰은 세션 폴더 기준으로 복귀.`);
  process.exit(0);
}
if (cmd === "set") {
  if (!arg) { console.error("set에는 대상 경로가 필요: node scripts/scope-target.js <ws> set <repo>"); process.exit(2); }
  setTarget(path.resolve(arg));
  process.exit(0);
}
// auto — 보수적 감지(쓸 수 있는 이력 기준)
const existing = (loadContract(ws).scoutRepo || "").trim();
if (usableGit(ws)) {
  if (existing) { // 기존 지정을 조용히 유지하면 '지정 불요' 메시지와 실동작이 어긋난다(Codex 반례) — 명시 행동 요구
    console.log(`세션 폴더 자신이 이력 있는 git 루트지만, 기존 지정이 남아 있습니다: ${existing}`);
    console.log("세션 폴더 기준으로 쓰려면 clear를, 기존 지정을 유지하려면 그대로 두세요(자동 변경 안 함).");
    process.exit(1);
  }
  console.log("세션 폴더 자신이 쓸 수 있는 git 루트(이력 있음) — 지정이 필요 없습니다(현행 유지)."); process.exit(0);
}
if (hasGitDir(ws)) console.log("ⓘ 세션 폴더에 .git은 있으나 커밋 이력이 없어 정찰에 못 씀 — 하위에서 후보를 찾습니다.");
let candidates = [];
try {
  candidates = fs.readdirSync(ws, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => path.join(ws, d.name))
    .filter(usableGit);
} catch (e) { console.error("폴더 탐색 실패: " + (e && e.message)); process.exit(1); }
if (candidates.length === 0) { console.log("바로 아래 1단계에서 '이력 있는' git 루트를 찾지 못함 — set으로 직접 지정하세요."); process.exit(1); }
if (candidates.length > 1) {
  console.log(`후보가 ${candidates.length}개 — 조용한 오지정을 막기 위해 자동 지정하지 않습니다. set으로 선택하세요:`);
  for (const c of candidates) console.log("  " + c);
  process.exit(1);
}
console.log(`유일 후보 감지: ${candidates[0]} → 지정합니다.`);
setTarget(candidates[0]);
