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
 *       node scripts/scope-reconcile.js <repo> aliases           — 관측 장부 별칭 후보(같은 endpoint+방향의 다른 문구 — L1-B)
 *       node scripts/scope-reconcile.js <repo> alias-approve <n...> — 마지막 aliases의 n번 묶음 병합 승인(alias 이벤트)
 *       node scripts/scope-reconcile.js <repo> alias-dismiss <n...> — n번 묶음을 후보 목록에서 숨김(병합 안 함)
 *       node scripts/scope-reconcile.js <repo> aliased           — 현재 병합(별칭) 목록(번호 스냅샷)
 *       node scripts/scope-reconcile.js <repo> unalias <n...>    — 마지막 aliased의 n번 병합 해제(unalias 이벤트 — 잘못 승인의 되돌림)
 *
 * 별칭 병합은 '사람 승인'만 — endpoint+방향 자동 병합은 '읽기 vs 삭제'처럼 다른 주장의 진릿값을 섞는다
 * (Codex 설계검증 2026-07-10). 후보 제시는 자동, 병합은 alias 이벤트(append-only — 원장 보존)로만.
 */
const fs = require("fs");
const path = require("path");
const { listMaps, wsKeyFor } = require("./scout-store.js");
const { atomicWrite, loadLang, readLedgerEventsText, appendLedgerEvent } = require(path.join(__dirname, "..", "bridge", "contract-lib.js")); // 확정층·상태 쓰기는 원자적으로(반쪽 파일 방지)
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI output is ko/en paired (2026-07-09)
const { normSig, computePending, appendApproved } = require(path.join(__dirname, "..", "out", "map-ledger.js")); // npm test의 tsc 산출물(단일 형식 출처)
const { parseEventsJsonl, deriveLedger, computeAliasCandidates } = require(path.join(__dirname, "..", "out", "ledger-events.js")); // 별칭 후보 계산은 정본 유도기(단일 판정 출처)

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
const STATE_DIR = path.join(BRIDGE_DIR, "map-reconcile");

const repoArg = process.argv[2];
const cmd = process.argv[3] || "list";
const rawNums = process.argv.slice(4);
const nums = rawNums.map(Number);
if (!repoArg) { console.error(tB("사용: node scripts/scope-reconcile.js <repo> [list|approve <n...>|reject <n...>]","Usage: node scripts/scope-reconcile.js <repo> [list|approve <n...>|reject <n...>]")); process.exit(2); }
// 승인 CLI는 잘못 친 인자를 조용히 버리지 않는다(확정층 승격 명령이므로) — 숫자 아닌 인자 하나라도 있으면 전체 중단.
if ((cmd === "approve" || cmd === "reject" || cmd === "alias-approve" || cmd === "alias-dismiss" || cmd === "unalias") && nums.some((n) => !Number.isInteger(n) || n <= 0)) {
  console.error(tB(`번호가 아닌 인자 있음: ${rawNums.join(" ")} — 양의 정수 번호만(먼저 목록으로 확인)`,`Non-numeric argument: ${rawNums.join(" ")} — positive integers only (check the list first)`)); process.exit(2);
}
const repo = path.resolve(repoArg);

// ── 별칭 후보/승인/해제(L1-B) — 병합은 사람 승인 alias 이벤트만. 번호는 각 목록 스냅샷 기준 고정(approve와 동일 규칙).
if (cmd === "aliases" || cmd === "alias-approve" || cmd === "alias-dismiss" || cmd === "aliased" || cmd === "unalias") {
  const stA = (() => { try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, wsKeyFor(repo) + ".json"), "utf8")); } catch { return { approved: [], rejected: [] }; } })();
  const saveA = () => atomicWrite(path.join(STATE_DIR, wsKeyFor(repo) + ".json"), JSON.stringify(stA, null, 2));
  const entries = deriveLedger(parseEventsJsonl(readLedgerEventsText(repo)).events);
  const dismissed = new Set(Array.isArray(stA.aliasDismissed) ? stA.aliasDismissed : []);
  const cands = computeAliasCandidates(entries).filter((c) => !dismissed.has(c.key));
  if (cmd === "aliases") {
    stA.aliasList = cands.map((c) => c.key); // 번호 스냅샷 고정
    if (!saveA()) { console.error(tB("목록 스냅샷 저장 실패 — 번호 기준을 고정할 수 없어 중단","Failed to save the list snapshot — cannot pin numbering, aborting")); process.exit(1); }
    if (!cands.length) { console.log(tB("별칭 후보 없음 (같은 endpoint+방향의 서로 다른 문구 묶음이 없음)","No alias candidates (no groups sharing endpoints+direction with different wording)")); process.exit(0); }
    console.log(tB(`별칭 후보 ${cands.length}묶음 — alias-approve <번호>로 병합(첫 항목이 대표), alias-dismiss <번호>로 숨김. 병합해도 원장 이벤트는 전부 보존된다.`,`${cands.length} alias candidate group(s) — merge with alias-approve <n> (first item becomes primary), hide with alias-dismiss <n>. Merging preserves all ledger events.`));
    cands.forEach((c, i) => {
      console.log(`  ${i + 1}. [${c.key}]`);
      c.texts.forEach((t, j) => console.log(`     ${j === 0 ? tB("대표: ", "primary: ") : tB("별칭: ", "alias:   ")}${String(t).slice(0, 160)}`));
    });
    process.exit(0);
  }
  // 현재 병합 목록·해제(잘못 승인의 되돌림 — undo 없는 append-only 정정 계약 성립: Codex #3)
  // ⚠ 목록은 유도 결과의 후손(aliases)이 아니라 '활성 직접 간선'(alias 순계>0의 child→parent) — A←B←C에서
  // 화면의 A–C를 그대로 unalias하면 실제 간선(C→B)이 아닌 C→A만 감산돼 아무것도 안 풀림(Codex 2차 #3 실측).
  if (cmd === "aliased" || cmd === "unalias") {
    const rawEvents = parseEventsJsonl(readLedgerEventsText(repo)).events;
    const net = new Map(); // child → (parent → 순계)
    for (const e of rawEvents) {
      if ((e.type !== "alias" && e.type !== "unalias") || !e.aliasSig) continue;
      let per = net.get(e.aliasSig);
      if (!per) { per = new Map(); net.set(e.aliasSig, per); }
      per.set(e.sig, (per.get(e.sig) || 0) + (e.type === "alias" ? 1 : -1) * (Number.isFinite(e.n) && e.n > 0 ? Math.floor(e.n) : 1)); // 가중(압축본 n) — 정본과 다른 활성 간선을 표시하면 잘못된 번호로 unalias(Codex 7차 #1)
    }
    const textOf = new Map();
    for (const e of rawEvents) if (e.text && !textOf.has(e.sig)) textOf.set(e.sig, e.text);
    const pairs = [];
    for (const [child, per] of net) {
      const best = [...per.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best) pairs.push({ parent: best[0], child, text: textOf.get(child) || textOf.get(best[0]) || "" });
    }
    pairs.sort((x, y) => (x.parent + "|" + x.child).localeCompare(y.parent + "|" + y.child));
    if (cmd === "aliased") {
      stA.unaliasList = pairs.map((pr) => ({ parent: pr.parent, child: pr.child })); // 객체 스냅샷(구분자·NUL 없음 — Codex 2차 #6)
      if (!saveA()) { console.error(tB("목록 스냅샷 저장 실패","Failed to save the list snapshot")); process.exit(1); }
      if (!pairs.length) { console.log(tB("병합(별칭)이 없음","No merges (aliases)")); process.exit(0); }
      console.log(tB(`병합(활성 직접 간선) ${pairs.length}건 — unalias <번호>로 해제(원장 이벤트는 보존·재해석만)`,`${pairs.length} active merge edge(s) — undo with unalias <n> (ledger preserved · reinterpretation only)`));
      pairs.forEach((pr, i) => console.log(`  ${i + 1}. ${tB("별칭 ", "alias ")}${String(pr.text || pr.child).slice(0, 80)}
     └ ${tB("→ 대표 sig: ", "→ primary sig: ")}${pr.parent.slice(0, 80)}`));
      process.exit(0);
    }
    if (!nums.length) { console.error(tB("unalias할 번호를 지정하라 — 먼저 aliased로 확인","Specify number(s) — check with aliased first")); process.exit(2); }
    if (!Array.isArray(stA.unaliasList) || !stA.unaliasList.length) { console.error(tB("번호 기준이 없음 — 먼저 aliased를 실행하라","No numbering basis — run aliased first")); process.exit(1); }
    const now3 = new Date().toISOString();
    for (const n of nums) {
      const key = stA.unaliasList[n - 1];
      if (!key || typeof key !== "object" || !key.parent || !key.child) { console.error(tB(`번호 ${n}은 범위 밖이거나 구형 스냅샷 — aliased를 다시 실행하라`,`Number ${n} out of range or a legacy snapshot — re-run aliased`)); process.exit(1); }
      if (!pairs.some((pr) => pr.parent === key.parent && pr.child === key.child)) { console.error(tB(`번호 ${n}은 이미 해제됐거나 재해석으로 사라짐 — aliased로 재확인`,`Number ${n} already undone or gone — re-check with aliased`)); process.exit(1); }
      if (!appendLedgerEvent(repo, { ts: now3, type: "unalias", sig: key.parent, aliasSig: key.child, from: "reconcile unalias" })) { console.error(tB("unalias 기록 실패","Failed to append unalias")); process.exit(1); }
      console.log(tB("병합 해제: ", "Merge undone: ") + key.child.slice(0, 80));
    }
    if (!saveA()) { console.error(tB("상태 저장 실패","Failed to save state")); process.exit(1); }
    process.exit(0);
  }
  if (!nums.length) { console.error(tB(`${cmd}할 번호를 지정하라 — 먼저 aliases로 확인`,`Specify number(s) to ${cmd} — check with aliases first`)); process.exit(2); }
  if (!Array.isArray(stA.aliasList) || !stA.aliasList.length) { console.error(tB("번호 기준이 없음 — 먼저 aliases를 실행하라","No numbering basis — run aliases first")); process.exit(1); }
  const byKey = new Map(cands.map((c) => [c.key, c]));
  const now2 = new Date().toISOString();
  for (const n of nums) {
    const key = stA.aliasList[n - 1];
    if (!key) { console.error(tB(`번호 ${n}은 마지막 목록(${stA.aliasList.length}건) 범위 밖`,`Number ${n} is out of range of the last list (${stA.aliasList.length})`)); process.exit(1); }
    const c = byKey.get(key);
    if (!c) { console.error(tB(`번호 ${n}(마지막 목록 기준)은 이미 처리됐거나 후보에서 사라짐 — aliases로 다시 확인`,`Number ${n} (per last list) was already handled or vanished — re-check with aliases`)); process.exit(1); }
    if (cmd === "alias-dismiss") {
      dismissed.add(key);
      stA.aliasDismissed = [...dismissed];
      console.log(tB("숨김(병합 안 함): ", "Dismissed (not merged): ") + key);
      continue;
    }
    const primary = c.sigs[0]; // 표시 순서 첫 항목(최근 활동순 — 유도기 정렬)이 대표
    // 순환 거부(Codex #4): 새 간선(alias→primary)이 기존 활성 그래프에서 primary→…→alias 경로를 만들면 순환 —
    // 유도기는 결정적으로 격리하지만, 승인 시점에 거부해 원장을 애초에 깨끗하게 유지한다.
    const reach = (from, to) => {
      const seen = new Set([from]); const q = [from];
      while (q.length) {
        const cur = q.pop();
        if (cur === to) return true;
        const e2 = entries.find((x) => (x.aliases || []).includes(cur));
        if (e2 && !seen.has(e2.sig)) { seen.add(e2.sig); q.push(e2.sig); }
      }
      return false;
    };
    for (const s of c.sigs.slice(1)) {
      if (reach(primary, s)) { console.error(tB(`순환 위험: ${s.slice(0, 40)}… 이 이미 대표의 상위 — 승인 거부(원장 순환 방지)`,`Cycle risk: ${s.slice(0, 40)}… is already an ancestor — approval rejected (keeps the ledger acyclic)`)); process.exit(1); }
      if (!appendLedgerEvent(repo, { ts: now2, type: "alias", sig: primary, aliasSig: s, from: "reconcile alias-approve" })) {
        console.error(tB("alias 이벤트 기록 실패 — 중단(권한/디스크 확인)","Failed to append the alias event — aborting (check permission/disk)")); process.exit(1);
      }
    }
    console.log(tB(`병합 승인: ${c.sigs.length}개 문구 → 대표 1개(원장 이벤트 보존·해제는 unalias)`,`Merge approved: ${c.sigs.length} wording(s) → 1 primary (ledger preserved · undo = unalias)`));
  }
  if (!saveA()) { console.error(tB("상태 저장 실패","Failed to save state")); process.exit(1); }
  process.exit(0);
}

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
    sources.push({ patches: meta.mapPatches, from: (meta.arm || "?") + tB(" 지도 ", " map ") + (meta.ts || m.base) });
  }
  return computePending(sources, [...(st.approved || []), ...(st.rejected || [])].map((e) => e.sig), mapNow);
}

const st = loadState();
const proposals = pendingProposals(st);
const bySig = new Map(proposals.map((p) => [p.sig, p]));

if (cmd === "list") {
  st.lastList = proposals.map((p) => p.sig); // 번호 스냅샷 고정 — approve/reject는 이 목록 기준
  if (!saveState(st)) { console.error(tB("목록 스냅샷 저장 실패 — 번호 기준을 고정할 수 없어 중단(권한/디스크 확인)","Failed to save the list snapshot — cannot pin numbering, aborting (check permission/disk)")); process.exit(1); }
  if (!proposals.length) { console.log(tB("대기 중 제안 없음 (지도의 ⑥ MAP patch 후보가 비었거나 모두 처리됨)","No pending proposals (maps produced no section-⑥ candidates, or all are handled)")); process.exit(0); }
  console.log(tB(`대기 중 제안 ${proposals.length}건 — approve/reject <번호>로 처리 (번호는 이 목록 기준 고정 · 확정층: ${path.relative(repo, mapFile())})`,`${proposals.length} pending proposal(s) — handle with approve/reject <n> (numbers pinned to this list · stable layer: ${path.relative(repo, mapFile())})`));
  proposals.forEach((p, i) => console.log(`  ${i + 1}. ${p.text}\n     └ ` + tB("출처: ","from: ") + p.from));
  process.exit(0);
}
if (cmd !== "approve" && cmd !== "reject") { console.error(tB(`알 수 없는 명령: ${cmd} (list|approve|reject|aliases|alias-approve|alias-dismiss|aliased|unalias)`,`Unknown command: ${cmd} (list|approve|reject|aliases|alias-approve|alias-dismiss|aliased|unalias)`)); process.exit(2); }
if (!nums.length) { console.error(tB(`${cmd}할 번호를 지정하라 — 먼저 list로 확인`,`Specify number(s) to ${cmd} — check with list first`)); process.exit(2); }
if (!Array.isArray(st.lastList) || !st.lastList.length) { console.error(tB("번호 기준이 없음 — 먼저 list를 실행하라(번호는 마지막 목록 스냅샷 기준)","No numbering basis — run list first (numbers refer to the last list snapshot)")); process.exit(1); }
const picked = [];
for (const n of nums) {
  const sig = st.lastList[n - 1];
  if (!sig) { console.error(tB(`번호 ${n}은 마지막 목록(${st.lastList.length}건) 범위 밖 — list로 다시 확인하라`,`Number ${n} is out of range of the last list (${st.lastList.length}) — re-check with list`)); process.exit(1); }
  const p = bySig.get(sig);
  if (!p) { console.error(tB(`번호 ${n}(마지막 목록 기준)은 이미 처리됐거나 지도 정리로 사라짐 — list로 다시 확인하라`,`Number ${n} (per last list) was already handled or pruned — re-check with list`)); process.exit(1); }
  picked.push(p);
}

const now = new Date().toISOString();
if (cmd === "approve") {
  // ── P3b B-4: 권위 분기 — v2=promoteEntry(항목별 독립) / legacy=정본 잠금 안 재판정 후 기존 기록 /
  // blocked=거부. 어댑터·런타임 require 실패=기록 거부(공통 (a) fail-closed — 검사-후-쓰기 폴백 없음).
  let MA = null, MRt = null, MBd = null;
  try {
    MA = require(path.join(__dirname, "..", "bridge", "map-adapters.js"));
    MRt = require(path.join(__dirname, "..", "bridge", "map-runtime.js"));
    MBd = require(path.join(__dirname, "..", "bridge", "map-bindings.js"));
  } catch { MA = null; }
  if (!MA || !MRt || !MBd || typeof MA.promoteEntry !== "function" || typeof MRt.withMapLock !== "function" || typeof MBd.authorityStateFor !== "function") {
    console.error(tB("MAP 런타임 판독 불가 — 확정층 기록을 거부한다(node install.js 후 재시도)","MAP runtime unreadable — refusing to write the stable layer (run node install.js, then retry)")); process.exit(1);
  }
  const auth = MBd.authorityStateFor(repo);
  if (auth.st === "blocked") { console.error(tB("권위 판독 차단(" + (auth.reasonKey || "") + ": " + auth.reason + ") — 승인 기록 거부(상태 무변경)","Authority blocked (" + (auth.reasonKey || "") + ": " + auth.reason + ") — refusing to record approvals (state unchanged)")); process.exit(1); }
  if (auth.st === "v2") {
    // 전환 후: 항목별 promoteEntry(actionRef=approve) — 부분 실패는 항목별 보고(legacy도 전체 원자성 없었음).
    let allOk = true;
    for (const p of picked) {
      const r = MA.promoteEntry(repo, { text: p.text, from: p.from || "", approvedAt: now, actionRef: "approve" });
      if (r.st === "patch") { st.approved.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); console.log(tB("승인 → Project MAP 제안 생성(" + String(r.patchId).slice(0, 8) + "…): ","Approved → Project MAP proposal (" + String(r.patchId).slice(0, 8) + "…): ") + p.text); }
      else if (r.st === "already-applied") { st.approved.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); console.log(tB("이미 Project MAP에 반영됨: ","Already applied in Project MAP: ") + p.text); }
      else if (r.st === "already-pending") { st.approved.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); console.log(tB("같은 제안이 이미 대기 중(" + String(r.patchId).slice(0, 8) + "…): ","Same proposal already pending (" + String(r.patchId).slice(0, 8) + "…): ") + p.text); }
      else if (r.st === "needs-binding") { allOk = false; console.log(tB("결속 필요(미승격 — 목록에 남음): `binding-confirm " + (r.candidateFp || "<legacy-scan 필요>") + "` 후 재승인: ","Needs binding (not promoted — stays listed): run `binding-confirm " + (r.candidateFp || "<legacy-scan needed>") + "`, then approve again: ") + p.text); }
      else { // en 슬롯=키 번역(한국어 원문 비노출 — 구현검증 1차 #5·공통 (f). 번역기 부재=키만)
        allOk = false;
        const rtx = (() => { try { return require(path.join(__dirname, "..", "bridge", "map-reader.js")).reasonTextFor; } catch { return null; } })();
        const enWhy = rtx ? rtx(r.reasonKey, null, true) : (r.reasonKey || String(r.st));
        console.error(tB("거부(" + (r.reasonKey ? r.reasonKey + ": " : "") + (r.reason || r.st) + "): ","Rejected (" + (r.reasonKey ? r.reasonKey + ": " : "") + enWhy + "): ") + p.text);
      }
    }
    if (!saveState(st)) { console.error(tB("⚠ 승인 상태 저장 실패 — 재목록 방지는 Project MAP 중복 대조가 대신 막아주지만, 권한/디스크를 확인하라","Warning: saving approval state failed — re-listing is still prevented by Project MAP dedup; check permission/disk")); process.exit(1); }
    process.exit(allOk ? 0 : 1);
  }
  // legacy — 정본 잠금 안 재판정 후 기록(설계검증 1차 #1: marker 활성과 legacy 쓰기가 같은 잠금으로 직렬화)
  const lkw = MRt.withMapLock(repo, () => {
    const a2 = MBd.authorityStateFor(repo);
    if (a2.st !== "legacy") return { wrote: false, why: a2.st }; // 그 사이 전환됨 — 기록 0(사전 차단)
    const f = mapFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let cur = "";
    try { cur = fs.readFileSync(f, "utf8"); } catch { /* 없으면 공유 모듈이 뼈대 생성 */ }
    if (!atomicWrite(f, appendApproved(cur, picked, now))) return { wrote: false, why: "write-failed" };
    return { wrote: true, f };
  });
  if (!lkw.ok) { console.error(tB("정본 잠금 실패 — 기록 거부(다시 시도하라): " + lkw.error,"Map lock failed — write refused (retry): " + lkw.error)); process.exit(1); }
  if (!lkw.result.wrote) {
    if (lkw.result.why === "write-failed") { console.error(tB("확정층 기록 실패 — 상태 미변경(다시 시도하라)","Failed to write the stable layer — state unchanged (retry)")); process.exit(1); }
    console.error(tB("기록 직전 권위 상태 변경(" + lkw.result.why + " — cutover 감지) — 기록 0. 다시 실행하면 Project MAP 경로로 승격된다.","Authority changed right before write (" + lkw.result.why + " — cutover detected) — nothing written. Re-run to promote via Project MAP.")); process.exit(1);
  }
  for (const p of picked) {
    st.approved.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); // text·from 보존 — 대시보드 이력이 원문을 보여줌
    console.log(tB("승인 → 확정층: ","Approved → stable layer: ") + p.text);
  }
  console.log(tB("확정층 기록: ","Stable layer written: ") + lkw.result.f);
  if (!saveState(st)) { console.error(tB("⚠ 확정층에는 기록됐으나 승인 상태 저장 실패 — 재목록 방지는 확정층 문구 대조가 대신 막아주지만, 권한/디스크를 확인하라","Warning: written to the stable layer but saving approval state failed — re-listing is still prevented by the layer text match; check permission/disk")); process.exit(1); }
} else {
  for (const p of picked) {
    st.rejected.push({ sig: p.sig, ts: now, text: p.text, from: p.from }); // 기각도 원문 보존(무엇을 정정했는지 이력)
    console.log(tB("기각(다시 안 보임): ","Rejected (hidden from future lists): ") + p.text);
  }
  if (!saveState(st)) { console.error(tB("기각 상태 저장 실패 — 기각이 반영되지 않았다(다시 시도하라)","Failed to save the rejection — it was not applied (retry)")); process.exit(1); }
}
