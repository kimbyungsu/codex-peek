#!/usr/bin/env node
/*
 * 관측 장부 씨앗 백필 — 보관함의 기존 지도들에서 ⑥ MAP patch 후보를 소급 적재한다.
 * 배경(2026-07-08 실측): 장부의 유일한 자동 씨앗(proposed)이 '지도 러너 실행'에 묶여 있는데,
 * proposed 적재 코드 도입(7/7 pull) 전에 만들어진 지도들의 후보는 장부에 없다 → 이벤트 0건(점화 실패).
 * 이 스크립트는 러너와 '같은 파서'(bridge/contract-lib.js extractMapPatches — 위생 필터 포함)로 같은 기준의
 * 씨앗을 소급 적재한다(이중 기준 없음). 수동 1회 CLI — 자동 실행 없음(자동은 러너의 기존 경로 그대로).
 *
 * 사용: node scripts/scope-ledger-backfill.js [--dry]
 *   --dry  적재 없이 무엇이 들어갈지 출력만
 * 대상 판정: scouts/<wsKey>/<base>.json 메타의 repo 필드(그 지도가 스스로 기록한 원 프로젝트 경로).
 *   메타나 repo가 없으면 그 지도는 건너뛰고 사유를 보고한다(폴더 키에서 경로 복원은 불가 — 해시라서).
 * 중복 방지: 같은 sig의 이벤트가 장부에 이미 있으면 건너뜀(재실행 안전 — 멱등).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const BRIDGE = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const { extractMapPatches, appendLedgerEvent, readLedgerEventsText, ledgerSig } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const dry = process.argv.includes("--dry");
const scoutsDir = path.join(BRIDGE, "scouts");
let boxes = [];
try { boxes = fs.readdirSync(scoutsDir).filter((d) => { try { return fs.statSync(path.join(scoutsDir, d)).isDirectory(); } catch { return false; } }); } catch { /* 보관함 없음 */ }
if (!boxes.length) { console.log("보관함(scouts/)에 지도가 없습니다 — 백필할 씨앗 없음."); process.exit(0); }

let totalAdd = 0, totalSkipDup = 0, totalSkipNoRepo = 0;
const existingBySig = new Map(); // repo(normalized) → Set<sig> — 장부 1회 판독 캐시
function sigsFor(repo) {
  const key = String(repo).replace(/\\/g, "/").toLowerCase();
  if (!existingBySig.has(key)) {
    const set = new Set();
    for (const ln of String(readLedgerEventsText(repo) || "").split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try { const o = JSON.parse(ln); if (o && o.sig) set.add(o.sig); } catch { /* 불량 줄 무시 */ }
    }
    existingBySig.set(key, set);
  }
  return existingBySig.get(key);
}

for (const box of boxes) {
  const dir = path.join(scoutsDir, box);
  const mds = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const md of mds) {
    const base = md.slice(0, -3);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, base + ".json"), "utf8")); } catch { /* 메타 없음 */ }
    const repo = meta && typeof meta.repo === "string" && meta.repo.trim() ? meta.repo.trim() : null;
    if (!repo) { totalSkipNoRepo++; console.log(`skip(원 프로젝트 경로 불명 — 메타에 repo 없음): ${box}/${base}`); continue; }
    let text = "";
    try { text = fs.readFileSync(path.join(dir, md), "utf8"); } catch { continue; }
    const patches = extractMapPatches(text);
    if (!patches.length) { console.log(`  0건(후보 없음/필터 탈락): ${box}/${base}`); continue; }
    const seen = sigsFor(repo);
    const now = new Date().toISOString();
    for (const t of patches) {
      const sig = ledgerSig(t);
      if (seen.has(sig)) { totalSkipDup++; continue; }
      if (dry) { console.log(`  [dry] proposed ← ${t.slice(0, 80)}`); seen.add(sig); totalAdd++; continue; }
      if (appendLedgerEvent(repo, { ts: now, type: "proposed", sig, text: t, from: "backfill " + base })) { seen.add(sig); totalAdd++; }
    }
    console.log(`  ${box}/${base} → repo=${repo}`);
  }
}
console.log(`\n결과${dry ? "(dry — 미적재)" : ""}: 적재 ${totalAdd}건 · 중복 스킵 ${totalSkipDup}건 · repo 불명 스킵 ${totalSkipNoRepo}장`);
