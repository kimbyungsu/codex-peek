/*
 * stable MAP 승인 절차(reconcile) — 제안층(탐색자 지도의 ⑥ MAP patch 후보)을 사람이 검토해
 * 확정층(저장소의 MAP.md — 꾸러미가 신뢰 입력으로 읽는 파일)으로 올리는 CLI. (HANDOFF §6.5 'stable MAP 2층')
 *
 * 원칙: 제안은 자동으로 확정층에 절대 들어가지 않는다 — approve만이 유일한 승격 경로(사람 실행).
 * 상태(승인/기각 서명 + 마지막 목록 스냅샷)는 브릿지 홈 map-reconcile/<wsKey>.json.
 * 번호는 '마지막 list가 보여준 목록' 기준으로 고정(스냅샷) — list와 approve 사이에 지도가 갱신돼
 * 새 제안이 끼어도 사용자가 본 번호와 다른 항목이 승인되는 사고가 없다(Codex 지적 반영).
 *
 * 사용: node scripts/scope-reconcile.js <repo> [list]           — 대기 중 제안 목록(번호 스냅샷 고정)
 *       node scripts/scope-reconcile.js <repo> approve <n...>   — 마지막 list의 n번을 MAP.md에 추가(확정층 승격)
 *       node scripts/scope-reconcile.js <repo> reject <n...>    — 마지막 list의 n번 기각(다시 안 보임)
 */
const fs = require("fs");
const path = require("path");
const { listMaps, wsKeyFor } = require("./scout-store.js");
const { atomicWrite } = require(path.join(__dirname, "..", "bridge", "contract-lib.js")); // 확정층·상태 쓰기는 원자적으로(반쪽 파일 방지)

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
const STATE_DIR = path.join(BRIDGE_DIR, "map-reconcile");

const repoArg = process.argv[2];
const cmd = process.argv[3] || "list";
const rawNums = process.argv.slice(4);
const nums = rawNums.map(Number);
if (!repoArg) { console.error("사용: node scripts/scope-reconcile.js <repo> [list|approve <n...>|reject <n...>]"); process.exit(2); }
// 승인 CLI는 잘못 친 인자를 조용히 버리지 않는다(확정층 승격 명령이므로) — 숫자 아닌 인자 하나라도 있으면 전체 중단.
if ((cmd === "approve" || cmd === "reject") && nums.some((n) => !Number.isInteger(n) || n <= 0)) {
  console.error(`번호가 아닌 인자 있음: ${rawNums.join(" ")} — 양의 정수 번호만(먼저 list로 확인)`); process.exit(2);
}
const repo = path.resolve(repoArg);

const norm = (t) => String(t).replace(/\s+/g, " ").trim().toLowerCase(); // 제안 서명(공백 요동 무시)

function loadState() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, wsKeyFor(repo) + ".json"), "utf8")); } catch { return { approved: [], rejected: [] }; }
}
function saveState(st) { // 반환값 필수 확인 — 저장 실패를 성공처럼 넘기면 기각/스냅샷이 유실된다(Codex 지적)
  return atomicWrite(path.join(STATE_DIR, wsKeyFor(repo) + ".json"), JSON.stringify(st, null, 2));
}
// 확정층 파일: 기존 docs/MAP.md > 기존 MAP.md > (없으면) docs/MAP.md 신설 — 꾸러미 수집기(collectCommon)의 탐색 순서와 동일.
function mapFile() {
  for (const c of ["docs/MAP.md", "MAP.md"]) { if (fs.existsSync(path.join(repo, c))) return path.join(repo, c); }
  return path.join(repo, "docs", "MAP.md");
}

// 제안 수집: 최근 지도들(보관 정책=최근 10장)의 meta.mapPatches 합집합 — 승인/기각 서명·확정층 기존 문구 제외.
function pendingProposals(st) {
  const done = new Set([...st.approved, ...st.rejected].map((e) => e.sig));
  let mapNow = "";
  try { mapNow = norm(fs.readFileSync(mapFile(), "utf8")); } catch { /* 확정층 아직 없음 */ }
  const all = new Map(); // sig → {text, from}
  for (const m of listMaps(repo, 10)) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(m.file.replace(/\.md$/, ".json"), "utf8")); } catch { continue; }
    for (const t of Array.isArray(meta.mapPatches) ? meta.mapPatches : []) {
      if (typeof t !== "string" || !t.trim()) continue;
      const sig = norm(t);
      if (done.has(sig) || all.has(sig)) continue;
      if (mapNow && mapNow.includes(sig)) continue; // 이미 확정층에 같은 문구 존재
      all.set(sig, { text: t.trim(), from: `${meta.arm || "?"} 지도 ${meta.ts || m.base}` });
    }
  }
  return [...all.values()].sort((a, b) => a.text.localeCompare(b.text));
}

const st = loadState();
const proposals = pendingProposals(st);
const bySig = new Map(proposals.map((p) => [norm(p.text), p]));

if (cmd === "list") {
  st.lastList = proposals.map((p) => norm(p.text)); // 번호 스냅샷 고정 — approve/reject는 이 목록 기준
  if (!saveState(st)) { console.error("목록 스냅샷 저장 실패 — 번호 기준을 고정할 수 없어 중단(권한/디스크 확인)"); process.exit(1); }
  if (!proposals.length) { console.log("대기 중 제안 없음 (지도의 ⑥ MAP patch 후보가 비었거나 모두 처리됨)"); process.exit(0); }
  console.log(`대기 중 제안 ${proposals.length}건 — approve/reject <번호>로 처리 (번호는 이 목록 기준 고정 · 확정층: ${path.relative(repo, mapFile())})`);
  proposals.forEach((p, i) => console.log(`  ${i + 1}. ${p.text}\n     └ 출처: ${p.from}`));
  process.exit(0);
}
if (cmd !== "approve" && cmd !== "reject") { console.error(`알 수 없는 명령: ${cmd} (list|approve|reject)`); process.exit(2); }
if (!nums.length) { console.error(`${cmd}할 번호를 지정하라 — 먼저 list로 확인`); process.exit(2); }
if (!Array.isArray(st.lastList) || !st.lastList.length) { console.error("번호 기준이 없음 — 먼저 list를 실행하라(번호는 마지막 목록 스냅샷 기준)"); process.exit(1); }
const picked = [];
for (const n of nums) {
  const sig = st.lastList[n - 1];
  if (!sig) { console.error(`번호 ${n}은 마지막 목록(${st.lastList.length}건) 범위 밖 — list로 다시 확인하라`); process.exit(1); }
  const p = bySig.get(sig);
  if (!p) { console.error(`번호 ${n}(마지막 목록 기준)은 이미 처리됐거나 지도 정리로 사라짐 — list로 다시 확인하라`); process.exit(1); }
  picked.push(p);
}

const now = new Date().toISOString();
if (cmd === "approve") {
  const f = mapFile();
  let cur = "";
  try { cur = fs.readFileSync(f, "utf8"); } catch { cur = "# MAP — 확정 지식층(stable)\n\n한쪽을 바꾸면 다른 쪽도 봐야 하는 '의미 결합' 장부. 탐색자 꾸러미가 신뢰 입력으로 읽는다.\n승격 경로는 scope-reconcile approve뿐(제안 자동 반영 없음).\n\n## 확정 결합(승인분)\n"; }
  if (!/## 확정 결합\(승인분\)/.test(cur)) cur += "\n## 확정 결합(승인분)\n";
  for (const p of picked) {
    cur += `- ${p.text}  <!-- 승인 ${now.slice(0, 10)} · 출처: ${p.from} -->\n`;
    st.approved.push({ sig: norm(p.text), ts: now });
    console.log(`승인 → 확정층: ${p.text}`);
  }
  if (!atomicWrite(f, cur)) { console.error("확정층 기록 실패 — 상태 미변경(다시 시도하라)"); process.exit(1); }
  console.log(`확정층 기록: ${f}`);
  if (!saveState(st)) { console.error("⚠ 확정층에는 기록됐으나 승인 상태 저장 실패 — 재목록 방지는 확정층 문구 대조가 대신 막아주지만, 권한/디스크를 확인하라"); process.exit(1); }
} else {
  for (const p of picked) {
    st.rejected.push({ sig: norm(p.text), ts: now });
    console.log(`기각(다시 안 보임): ${p.text}`);
  }
  if (!saveState(st)) { console.error("기각 상태 저장 실패 — 기각이 반영되지 않았다(다시 시도하라)"); process.exit(1); }
}
