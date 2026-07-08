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
const { contractFileFor, loadContract, atomicWrite, resolveScoutRepo, loadLang } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(2026-07-09)

const wsArg = process.argv[2];
const cmd = process.argv[3] || "status";
const arg = process.argv[4];
if (!wsArg || !["status", "set", "auto", "clear"].includes(cmd)) {
  console.error(tB("사용: node scripts/scope-target.js <ws> [status|set <repo>|auto|clear]","Usage: node scripts/scope-target.js <ws> [status|set <repo>|auto|clear]"));
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
const gitLabel = (p) => usableGit(p) ? tB("git 저장소(이력 있음)","git repo (has history)") : hasGitDir(p) ? tB("git 폴더는 있으나 커밋 이력 없음(무이력 모드로 동작)","has a .git folder but no commit history (runs in historyless mode)") : tB("비-git(무이력 모드로 동작)","non-git (runs in historyless mode)");

function writeBothSlots(mutate) {
  const files = [contractFileFor(ws, "ko"), contractFileFor(ws, "en")];
  let touched = 0;
  for (const f of files) {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* 이 슬롯 없음 */ }
    if (!o) { if (f !== files[0]) continue; o = {}; } // en은 있을 때만(없는 슬롯 생성 금지 — scope-gate와 동일 규칙)
    mutate(o);
    if (!atomicWrite(f, JSON.stringify({ ...o, updatedAt: new Date().toISOString() }, null, 2))) {
      console.error(tB(`저장 실패: ${f} (권한/디스크?)`,`Save failed: ${f} (permission/disk?)`)); process.exit(1);
    }
    touched++;
  }
  return touched;
}
function setTarget(repoAbs) {
  if (!fs.existsSync(repoAbs) || !fs.statSync(repoAbs).isDirectory()) { console.error(tB(`대상이 존재하지 않거나 폴더가 아님: ${repoAbs}`,`Target does not exist or is not a folder: ${repoAbs}`)); process.exit(1); }
  const n = writeBothSlots((o) => { o.scoutRepo = repoAbs; });
  console.log(tB(`scoutRepo=${repoAbs} 저장(계약 파일 ${n}개 갱신).`,`scoutRepo=${repoAbs} saved (${n} contract file(s) updated).`));
  if (!usableGit(repoAbs)) console.log(tB("ⓘ 대상: " + gitLabel(repoAbs) + " — 정찰이 전후 비교 없는 축소 꾸러미로 동작합니다(정직 고지).","ⓘ Target: " + gitLabel(repoAbs) + " — recon will run on a reduced pack without before/after diffs (honest note)."));
  console.log(tB("ⓘ 이관: 기존에 세션 폴더 서랍에 쌓인 관찰 일지가 있으면 node scripts/scope-ledger-migrate.js로 옮길 수 있습니다(--dry 먼저).","ⓘ Migration: if a journal already accumulated under the session folder, move it with node scripts/scope-ledger-migrate.js (--dry first)."));
}

if (cmd === "status") {
  const r = resolveScoutRepo(ws, loadContract(ws));
  console.log(tB(`정찰 대상: ${r.repo}`,`Scout target: ${r.repo}`) + (r.source === "contract" ? tB(" (계약 지정)"," (set in contract)") : r.source === "ws-fallback-invalid" ? tB(" (⚠ 지정값 무효 — 폴더 사라짐, 세션 폴더로 폴백 중)"," (⚠ configured value invalid — folder missing, falling back to the session folder)") : tB(" (지정 없음 — 세션 폴더 그대로)"," (not set — session folder as-is)")));
  console.log(tB("대상 git 여부: ","Target git status: ") + gitLabel(r.repo));
  process.exit(0);
}
if (cmd === "clear") {
  const n = writeBothSlots((o) => { delete o.scoutRepo; });
  console.log(tB(`scoutRepo 해제(계약 파일 ${n}개 갱신) — 정찰은 세션 폴더 기준으로 복귀.`,`scoutRepo cleared (${n} contract file(s) updated) — recon reverts to the session folder.`));
  process.exit(0);
}
if (cmd === "set") {
  if (!arg) { console.error(tB("set에는 대상 경로가 필요: node scripts/scope-target.js <ws> set <repo>","set requires a target path: node scripts/scope-target.js <ws> set <repo>")); process.exit(2); }
  setTarget(path.resolve(arg));
  process.exit(0);
}
// auto — 보수적 감지(쓸 수 있는 이력 기준)
const existing = (loadContract(ws).scoutRepo || "").trim();
if (usableGit(ws)) {
  if (existing) { // 기존 지정을 조용히 유지하면 '지정 불요' 메시지와 실동작이 어긋난다(Codex 반례) — 명시 행동 요구
    console.log(tB(`세션 폴더 자신이 이력 있는 git 루트지만, 기존 지정이 남아 있습니다: ${existing}`,`The session folder itself is a usable git root, but a previous target is still set: ${existing}`));
    console.log(tB("세션 폴더 기준으로 쓰려면 clear를, 기존 지정을 유지하려면 그대로 두세요(자동 변경 안 함).","Run clear to use the session folder, or leave as-is to keep the current target (no silent change)."));
    process.exit(1);
  }
  console.log(tB("세션 폴더 자신이 쓸 수 있는 git 루트(이력 있음) — 지정이 필요 없습니다(현행 유지).","The session folder itself is a usable git root (has history) — no target needed (keeping as-is).")); process.exit(0);
}
if (hasGitDir(ws)) console.log(tB("ⓘ 세션 폴더에 .git은 있으나 커밋 이력이 없어 정찰에 못 씀 — 하위에서 후보를 찾습니다.","ⓘ The session folder has .git but no commit history — unusable for recon; searching children."));
let candidates = [];
try {
  candidates = fs.readdirSync(ws, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => path.join(ws, d.name))
    .filter(usableGit);
} catch (e) { console.error(tB("폴더 탐색 실패: ","Folder scan failed: ") + (e && e.message)); process.exit(1); }
if (candidates.length === 0) { console.log(tB("바로 아래 1단계에서 '이력 있는' git 루트를 찾지 못함 — set으로 직접 지정하세요.","No git root with history found one level down — set the target explicitly with set.")); process.exit(1); }
if (candidates.length > 1) {
  console.log(tB(`후보가 ${candidates.length}개 — 조용한 오지정을 막기 위해 자동 지정하지 않습니다. set으로 선택하세요:`,`${candidates.length} candidates — refusing to auto-pick (prevents silent mis-targeting). Choose one with set:`));
  for (const c of candidates) console.log("  " + c);
  process.exit(1);
}
console.log(tB(`유일 후보 감지: ${candidates[0]} → 지정합니다.`,`Single candidate detected: ${candidates[0]} → setting it.`));
setTarget(candidates[0]);
