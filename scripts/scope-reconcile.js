/*
 * stable MAP 승인 절차(reconcile) — 제안층(탐색자 지도의 ⑥ MAP patch 후보)을 사람이 검토해
 * 확정층(저장소의 MAP.md — 꾸러미가 신뢰 입력으로 읽는 파일)으로 올리는 CLI. (HANDOFF §6.5 'stable MAP 2층')
 *
 * 원칙: 제안은 자동으로 확정층에 절대 들어가지 않는다 — approve만이 유일한 승격 경로(사람 실행).
 * 상태(승인/기각 서명 + 마지막 목록 스냅샷)는 브릿지 홈 map-reconcile/<wsKey>.json.
 * 번호는 '마지막 list가 보여준 목록' 기준으로 고정(스냅샷) — list와 approve 사이에 지도가 갱신돼
 * 새 제안이 끼어도 사용자가 본 번호와 다른 항목이 승인되는 사고가 없다(Codex 지적 반영).
 * 계산·형식(제안 서명·승인 줄·뼈대)은 out/map-ledger.js 공유 모듈이 단일 출처 — 대시보드 카드와 형식 동일.
 *
 * 사용: node scripts/scope-reconcile.js <repo> [list]           — 대기 중 제안 목록(번호 스냅샷 고정)
 *       node scripts/scope-reconcile.js <repo> approve <n...>   — 마지막 list의 n번을 MAP.md에 추가(확정층 승격)
 *       node scripts/scope-reconcile.js <repo> reject <n...>    — 마지막 list의 n번 기각(다시 안 보임)
 */
const fs = require("fs");
const path = require("path");
const { listMaps, wsKeyFor } = require("./scout-store.js");
const { atomicWrite } = require(path.join(__dirname, "..", "bridge", "contract-lib.js")); // 확정층·상태 쓰기는 원자적으로(반쪽 파일 방지)
const { normSig, computePending, appendApproved } = require(path.join(__dirname, "..", "out", "map-ledger.js")); // npm test의 tsc 산출물(단일 형식 출처)

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

// 제안 수집: 최근 지도들(보관 정책=최근 10장)의 meta.mapPatches 합집합 — 계산은 공유 모듈(computePending).
function pendingProposals(st) {
  let mapNow = "";
  try { mapNow = fs.readFileSync(mapFile(), "utf8"); } catch { /* 확정층 아직 없음 */ }
  const sources = [];
  for (const m of listMaps(repo, 10)) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(m.file.replace(/\.md$/, ".json"), "utf8")); } catch { continue; }
    sources.push({ patches: meta.mapPatches, from: `${meta.arm || "?"} 지도 ${meta.ts || m.base}` });
  }
  return computePending(sources, [...(st.approved || []), ...(st.rejected || [])].map((e) => e.sig), mapNow);
}

const st = loadState();
const proposals = pendingProposals(st);
const bySig = new Map(proposals.map((p) => [p.sig, p]));

if (cmd === "list") {
  st.lastList = proposals.map((p) => p.sig); // 번호 스냅샷 고정 — approve/reject는 이 목록 기준
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
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let cur = "";
  try { cur = fs.readFileSync(f, "utf8"); } catch { /* 없으면 공유 모듈이 뼈대 생성 */ }
  const next = appendApproved(cur, picked, now);
  for (const p of picked) {
    st.approved.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); // text·from 보존 — 대시보드 이력이 원문을 보여줌
    console.log(`승인 → 확정층: ${p.text}`);
  }
  if (!atomicWrite(f, next)) { console.error("확정층 기록 실패 — 상태 미변경(다시 시도하라)"); process.exit(1); }
  console.log(`확정층 기록: ${f}`);
  if (!saveState(st)) { console.error("⚠ 확정층에는 기록됐으나 승인 상태 저장 실패 — 재목록 방지는 확정층 문구 대조가 대신 막아주지만, 권한/디스크를 확인하라"); process.exit(1); }
} else {
  for (const p of picked) {
    st.rejected.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); // 기각도 원문 보존(무엇을 정정했는지 이력)
    console.log(`기각(다시 안 보임): ${p.text}`);
  }
  if (!saveState(st)) { console.error("기각 상태 저장 실패 — 기각이 반영되지 않았다(다시 시도하라)"); process.exit(1); }
}
