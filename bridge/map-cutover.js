"use strict";
/*
 * P3b 증분 2 — cutover 명령 본체 (설계 동결: docs/MAP-P3B-DESIGN.md §C — 전 계약 동결·임의 변경 금지)
 *
 * scope-map <repo> cutover --confirm-windows-reloaded [--confirm-unmigrated <N>]
 * 흐름: C-1 게이트(잠금 밖 1차: 0 scoutMode → 1 권위 분기[v2=멱등+tail/blocked=재개 판별/legacy=신규] →
 * 2 manifest → 3 topology → 4 WAL → 5 미이관 N → 6 스냅샷+decisionId 사전발급 → 7 배포 세대 →
 * 8 quiescence 플래그) → C-2 잠금 안(0~5·7 전부 재검사+스냅샷 바이트 불변 → frozen-ledger-fp 'receipt
 * 직전' 내구 기록 → receipt → marker → read-back → C-5 배너[같은 임계구역·실패=경고만]) → 보고.
 * 재개(C-3)=승인 조건(스냅샷·미이관)만 생략·안전 조건 전수 재검사. 자동 롤백 없음(§B 정본).
 * B-1 frozen-ledger probe(frozenLedgerProbeFor)도 이 모듈이 단일 출처(대시보드 lazy 소비).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CL = require(path.join(__dirname, "contract-lib.js"));
const MR = require(path.join(__dirname, "map-runtime.js"));
const MP = require(path.join(__dirname, "map-pipeline.js"));
const MB = require(path.join(__dirname, "map-bindings.js"));
const AD = require(path.join(__dirname, "map-adapters.js"));
const PM = MR.PM;

const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
const en = () => CL.loadLang() === "en";
const t = (ko, eng) => (en() ? eng : ko);
const SNAP_ROOT = path.join(CL.BRIDGE_DIR, "map-cutover-snapshots");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSENT_SENTINEL = "(absent)"; // 확정층 부재 시 frozen-ledger-fp 기준선 sentinel(C-1 6)

// C-5 동결 배너(1-22 — 결정론 바이트·ko/en 병기 고정 문구)
const BANNER = "<!-- DEPRECATED (frozen migration source): 이 확정 교범은 Project MAP(project-map/)으로 전환됨 — 신규 승인은 Project MAP 경로만. This ledger is frozen; new approvals go through Project MAP. -->";
function bannerApplied(text) { return text.startsWith(BANNER) ? text : BANNER + "\n" + text; } // 멱등 결정론(동일 배너 존재=그대로)
function bannerPresent(text) { return typeof text === "string" && text.startsWith(BANNER); }

// C-1 8 — writer-quiescence 지속 약속 문구(6차 #2: 전체 지속 조건 ko/en·문구 단언 잠금)
const QUIESCENCE_KO = "이 저장소를 여는 모든 VS Code 창을 닫거나 리로드했고, 이 저장소를 대상으로 실행 중인 MAP·확정층 명령(scope-map apply·scope-reconcile approve 등 구세대 CLI 포함)이 없음을 확인했으며, 확인 시점부터 cutover 완료(성공 보고 또는 중단 확인)까지 구세대 writer(VS Code 창·구세대 MAP/확정층 CLI)를 새로 시작하지 않고, cutover 후에는 리로드 전 창·구세대 CLI를 이 저장소에 사용하지 않겠다는 지속 약속입니다. 확인했다면 --confirm-windows-reloaded 를 붙여 재실행하세요.";
const QUIESCENCE_EN = "This confirms: every VS Code window opening this repository is closed or reloaded; no MAP/ledger commands targeting it are running (including old-generation CLI such as scope-map apply / scope-reconcile approve); from this confirmation until cutover completes (success report or confirmed abort) you will not start any old-generation writer (VS Code windows or old MAP/ledger CLI); and after cutover you will not use pre-reload windows or old-generation CLI on this repository — an ongoing commitment, not a one-time statement. If confirmed, re-run with --confirm-windows-reloaded.";

function snapDirFor(repo, decisionId) { return path.join(SNAP_ROOT, MP.canonicalIdentityFor(repo).nsKey, decisionId); }
function atomicWriteBuf(file, buf) { return CL.atomicWrite(file, buf); }

// ── 배포 세대 검사(C-1 7 — BRIDGE_SCRIPTS '전체' 바이트 대조·레포 실행 전제) ─────────────────────
// 설치본(BRIDGE_DIR)에서 실행되면 레포 목록(install.js)을 찾을 수 없어 fail-closed 거부("레포에서 실행").
function deployGenerationCheck() {
  let list;
  try { list = require(path.join(__dirname, "..", "install.js")).BRIDGE_SCRIPTS; } catch { return { ok: false, key: "no-repo", detail: "install.js" }; }
  if (!Array.isArray(list) || !list.length) return { ok: false, key: "no-repo", detail: "BRIDGE_SCRIPTS" };
  for (const f of list) {
    let a = null, b = null;
    try { a = fs.readFileSync(path.join(__dirname, f)); } catch { return { ok: false, key: "repo-missing", detail: f }; }
    try { b = fs.readFileSync(path.join(CL.BRIDGE_DIR, f)); } catch { return { ok: false, key: "deploy-missing", detail: f }; }
    if (!a.equals(b)) return { ok: false, key: "deploy-stale", detail: f };
  }
  return { ok: true, count: list.length };
}

// ── 미이관 N(C-1 5 — 행 단위 entryFp 다중집합·1-24 정합) ─────────────────────────────────────────
// 반환: { ok, n, rows:[{sig24, text, why}], err? } — legacy 확정층 부재=0건 정상·판독 실패=거부.
function unmigratedRowsFor(repo, mapId) {
  const src = MB.legacySourceFor(repo);
  if (src && src.err) return { ok: false, err: src.err };
  if (!src) return { ok: true, n: 0, rows: [] };
  const parsed = MB.parseApprovedCopy(src.text);
  const rb = MB.readBindingsFor(repo, mapId);
  if (rb.st !== "ok" && rb.st !== "absent") return { ok: false, err: "bindings.json " + rb.st };
  const bindings = rb.st === "ok" ? rb.data.bindings : [];
  // 1차 blocker①: '다중집합' 수량 비교 — 같은 entryFp의 legacy 행이 originals 보유 수보다 많으면 초과분은
  // v2 뷰에 나타나지 않는다(존재 여부 검사로는 중복 행이 전부 이관된 것으로 오인). fp별 카운트를 소비한다.
  const pool = new Map(); // sig → Map(entryFp → 잔여 수량)
  for (const b of bindings) {
    const m9 = new Map();
    for (const o of b.originals || []) m9.set(o.entryFp, (m9.get(o.entryFp) || 0) + 1);
    pool.set(b.sig, m9);
  }
  const rows = [];
  for (const e of parsed.approved || []) {
    const sig = CL.ledgerSig(e.text);
    const m9 = pool.get(sig);
    if (!m9) { rows.push({ sig24: sig.slice(0, 24), text: String(e.text).slice(0, 80), why: "unbound" }); continue; }
    const fp = MB.entryFpLegacy(e);
    const left = m9.get(fp) || 0;
    if (left <= 0) { rows.push({ sig24: sig.slice(0, 24), text: String(e.text).slice(0, 80), why: "entry-diverged" }); continue; }
    m9.set(fp, left - 1); // 소비 — 같은 fp 중복 행은 보유 수까지만 이관 인정
  }
  return { ok: true, n: rows.length, rows };
}

// ── B-1 frozen-ledger probe(경보 축=동결 파일 지문 대조 — 5차 #1) ────────────────────────────────
// 반환 합타입: { state: "not-cutover" } | { state:"baseline-unknown" } | { state:"ok" } |
//             { state:"violated" } — +unmigratedTotal(정보 배지·경보 축 아님·계산 실패=null).
function frozenLedgerProbeFor(repo) {
  const auth = MB.authorityStateFor(repo);
  if (auth.st !== "v2") return { state: "not-cutover" };
  let baseline = null;
  try {
    const dec = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "authority.json"), "utf8")).decisionRef;
    baseline = JSON.parse(fs.readFileSync(path.join(snapDirFor(repo, dec), "frozen-ledger-fp.json"), "utf8"));
  } catch { baseline = null; }
  let unmigratedTotal = null;
  try { const rt = MR.readTopoExFor(repo); if (rt.st === "ok") { const um = unmigratedRowsFor(repo, rt.topo.mapId); if (um.ok) unmigratedTotal = um.n; } } catch { /* 정보 배지 — 실패=null */ }
  if (!baseline || (typeof baseline.fp !== "string" && baseline.fp !== ABSENT_SENTINEL)) return { state: "baseline-unknown", unmigratedTotal };
  const src = MB.legacySourceFor(repo);
  if (src && src.err) return { state: "baseline-unknown", unmigratedTotal }; // 현재 지문 판독 불가 — 위장 금지·경고 축
  const curFp = src ? sha1(Buffer.from(src.text, "utf8")) : ABSENT_SENTINEL;
  if (curFp === baseline.fp) return { state: "ok", unmigratedTotal };
  return { state: "violated", unmigratedTotal, baselineFp: String(baseline.fp).slice(0, 12), currentFp: String(curFp).slice(0, 12) };
}

// ── 재개 자격 판별(C-1 1 blocked 분기 — 잠금 밖 1차와 잠금 안 재검사가 '같은 판별'을 실행: 1차 blocker②) ──
// 거부 사유 전수: 손상 receipt 존재(1개라도)·유효 receipt≠1·marker 존재·mapId 불일치 — 자동 선택·삭제 금지.
function resumeEligibilityFor(repo) {
  const histDir = path.join(repo, "project-map", "authority-history");
  let files = [];
  try { files = fs.readdirSync(histDir).filter((f) => f.endsWith(".json")); } catch { files = []; }
  const valid = []; let corrupt = 0;
  for (const f of files) {
    let d0 = null;
    try { d0 = JSON.parse(fs.readFileSync(path.join(histDir, f), "utf8")); } catch { corrupt++; continue; }
    if (MB.validReceipt(d0, f)) valid.push(d0); else corrupt++;
  }
  const markerAbsent = !fs.existsSync(path.join(repo, "project-map", "authority.json"));
  const rt0 = MR.readTopoExFor(repo);
  const mapIdMatch = rt0.st === "ok" && valid.length === 1 && valid[0].authorityObject.mapId === rt0.topo.mapId;
  if (corrupt > 0 || valid.length !== 1 || !markerAbsent || !mapIdMatch) {
    return { eligible: false, valid: valid.length, corrupt, markerAbsent };
  }
  return { eligible: true, receipt: valid[0], valid: 1, corrupt: 0, markerAbsent: true };
}

// ── 공통 안전 조건(신규 C-2 재검사·재개 C-3 공용 — '승인 조건'과 분리) ──────────────────────────
function safetyChecks(repo, opts) {
  const o = opts || {};
  if (CL.loadContract(repo).scoutMode !== "on") return { fail: t("3트랙(정찰)이 꺼져 있음 — 이 명령은 3트랙 전용(파일 생성 0)", "3-track (recon) is off — this command is 3-track only (no files created)") };
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { fail: "topology " + rt.st };
  const ve = PM.validateTopology(rt.topo);
  if (ve.length) return { fail: t("topology 스키마 위반: ", "topology schema violation: ") + ve[0] };
  if (!UUID_RE.test(String(rt.topo.mapId))) return { fail: "mapId UUID 위반" };
  const bar = MR.pipelineBarrier(repo);
  if (bar.blocked) return { fail: t("활성 pipeline WAL — recoverWal 선행(", "active pipeline WAL — run recoverWal first (") + bar.reason + ")" };
  const mf = AD.adapterManifest();
  const want = AD.REQUIRED_SURFACES.map((x) => x.id).sort().join(",");
  const got = (mf.surfaces || []).map((x) => x.id).sort().join(",");
  if (want !== got) return { fail: t("manifest 표면 집합 불일치(누락/잉여): ", "manifest surface set mismatch: ") + got };
  const notReady = (mf.surfaces || []).filter((x) => x.ready !== true).map((x) => x.id);
  if (notReady.length) return { fail: t("manifest ready=false 표면: ", "manifest surfaces not ready: ") + notReady.join(",") };
  if (!o.skipDeploy) { const dg = deployGenerationCheck(); if (!dg.ok) return { fail: t("배포 사본 세대 검사 실패(", "deployed copy generation check failed (") + dg.key + ": " + dg.detail + t(") — node install.js 실행 후 재시도", ") — run node install.js and retry") }; }
  return { ok: true, topo: rt.topo, raw: rt.raw };
}

// ── v2 tail 보충(C-1 1 — 6차 #1·7차 #1: 플래그 선행·이중 잠금 안 조건부·흡수 금지) ──────────────
function v2TailFor(repo, flags, report) {
  const src = MB.legacySourceFor(repo);
  if (src && src.err) { report.push(t("⚠ 확정층 판독 불가(" + src.err + ") — tail 판정 불가", "⚠ ledger unreadable (" + src.err + ") — tail state unknown")); return 0; }
  if (!src || bannerPresent(src.text)) return 0; // 배너 불요/완료 — 잠금 진입 없이 즉시 no-op
  if (!flags.confirmWindowsReloaded) {
    report.push(t("⚠ 미완 tail 존재(동결 배너 미삽입) — --confirm-windows-reloaded 플래그와 함께 재실행하면 보충한다(지금은 쓰기 0).", "⚠ Incomplete tail (freeze banner missing) — re-run with --confirm-windows-reloaded to complete it (no writes now)."));
    return 0;
  }
  const lk = MR.withMapLock(repo, () => {
    // 잠금 안 전부 재판독(check-then-write 경합 없음 — 같은 임계구역)
    let dec = null;
    try { dec = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "authority.json"), "utf8")).decisionRef; } catch { return { warn: t("marker 판독 불가 — 보충 중단", "marker unreadable — tail aborted") }; }
    let baseline = null;
    try { baseline = JSON.parse(fs.readFileSync(path.join(snapDirFor(repo, dec), "frozen-ledger-fp.json"), "utf8")); } catch { baseline = null; }
    if (!baseline || typeof baseline.fp !== "string") return { warn: t("기준선 불명(구세대 cutover 산물?) — 현재 바이트 흡수 금지·보충 없음", "baseline unknown (older-generation cutover?) — no absorption, no tail write") };
    const cur = MB.legacySourceFor(repo);
    if (cur && cur.err) return { warn: t("확정층 판독 불가 — 보충 중단", "ledger unreadable — tail aborted") };
    if (!cur) return baseline.fp === ABSENT_SENTINEL ? { done: t("확정층 부재(기준선과 정합) — 배너 불요", "ledger absent (matches baseline) — no banner needed") } : { warn: t("확정층이 사라짐(기준선=존재) — 동결 위반 의심·보충 없음", "ledger vanished (baseline says present) — freeze violation suspected, no tail write") };
    if (bannerPresent(cur.text)) return { done: t("배너 이미 존재(멱등)", "banner already present (idempotent)") };
    const applied = bannerApplied(cur.text);
    if (sha1(Buffer.from(applied, "utf8")) !== baseline.fp) return { warn: t("배너 적용 결과 지문≠기준선 — 동결 위반 경보(흡수 금지·보충 없음). 수동 확인 필요.", "banner-applied fingerprint ≠ baseline — freeze violation alert (no absorption, no tail write). Manual review required.") };
    if (!atomicWriteBuf(path.join(repo, cur.rel), applied)) return { warn: t("배너 기록 실패 — 재실행 시 재시도", "banner write failed — retried on next run") };
    return { done: t("동결 배너 보충 완료(지문=기준선 정합)", "freeze banner completed (fingerprint matches baseline)") };
  });
  if (!lk.ok) { report.push(t("⚠ 정본 잠금 실패 — tail 보충 못 함", "⚠ canonical lock failed — tail not completed")); return 0; }
  report.push((lk.result.done ? "· " : "⚠ ") + (lk.result.done || lk.result.warn));
  return 0;
}

// ── 본체 ─────────────────────────────────────────────────────────────────────────────────────────
// flags: { confirmWindowsReloaded: boolean, confirmUnmigrated: number|null }
function runCutover(repo, flags, _testHooks) { // _testHooks.afterSnapshot: 테스트 전용 주입점(스냅샷 직후·잠금 진입 직전 — 프로덕션 분기 없음: E절 TOCTOU 반례용)
  const report = [];
  const out = (lines) => { for (const l of [].concat(lines)) console.log(l); };
  // C-1 0: scoutMode 게이트 최선행(파일 생성 0)
  if (CL.loadContract(repo).scoutMode !== "on") { console.error(t("3트랙(정찰)이 꺼져 있음 — 이 명령은 3트랙 전용(파일 생성 0)", "3-track (recon) is off — this command is 3-track only (no files created)")); return 2; }
  // C-1 1: 권위 분기
  const auth = MB.authorityStateFor(repo);
  if (auth.st === "v2") {
    v2TailFor(repo, flags, report);
    let ts = "?";
    try { ts = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "authority.json"), "utf8")).ts || "?"; } catch { /* 표기용 */ }
    out([t("이미 전환됨(mapId " + auth.mapId + " · " + ts + ") — 멱등 no-op.", "Already cut over (mapId " + auth.mapId + " · " + ts + ") — idempotent no-op."), ...report]);
    return 0;
  }
  let resume = null;
  if (auth.st === "blocked") {
    // 재개 판별(§B-1 — 공용 함수: 잠금 안 재검사와 동일 판별·손상 receipt 존재도 거부)
    const el = resumeEligibilityFor(repo);
    if (!el.eligible) {
      console.error(t("권위 상태 blocked이며 재개 조건 불충족(유효 receipt " + el.valid + "개·손상 " + el.corrupt + "개·marker " + (el.markerAbsent ? "부재" : "존재") + ") — 수동 확인 필요(자동 선택·자동 삭제 금지). 사유: " + (auth.reason || ""), "Authority blocked and resume conditions unmet (valid receipts " + el.valid + " · corrupt " + el.corrupt + " · marker " + (el.markerAbsent ? "absent" : "present") + ") — manual review required (no auto-pick/auto-delete). Reason: " + (auth.reason || "")));
      return 1;
    }
    resume = el.receipt;
    if (_testHooks && typeof _testHooks.afterEligibility === "function") _testHooks.afterEligibility(); // E절 경합 반례 주입점(잠금 진입 직전)
  }
  // C-1 8: quiescence 플래그(재개 포함 — 승인 조건이 아니라 안전 조건)
  if (!flags.confirmWindowsReloaded) { console.error(t("작성자 정지 확인 필요: ", "Writer-quiescence confirmation required: ") + t(QUIESCENCE_KO, QUIESCENCE_EN)); return 2; }
  // C-1 0·2·3·4·7 안전 조건 1차(잠금 밖)
  const pre = safetyChecks(repo);
  if (pre.fail) { console.error(pre.fail); return 1; }
  const topo = pre.topo;

  if (resume) {
    // C-3 재개 — 승인 조건(스냅샷·미이관)만 생략. 잠금 '안'에서: 재개 자격 전수 재판별(1차 blocker② —
    // 사전 판독 후 receipt 교체·추가·손상 경합 차단·잠금 안 재판독본으로 marker 기록)+안전 조건+read-back+
    // C-5 배너 완결(1차 blocker③ — 미배너 재개가 probe 동결 위반으로 남는 경로 차단)까지 같은 임계구역.
    const lk = MR.withMapLock(repo, () => {
      const el2 = resumeEligibilityFor(repo);
      if (!el2.eligible) return { fail: t("잠금 안 재검사: 재개 조건 변동(유효 " + el2.valid + "·손상 " + el2.corrupt + "·marker " + (el2.markerAbsent ? "부재" : "존재") + ") — 중단", "in-lock recheck: resume conditions changed (valid " + el2.valid + " · corrupt " + el2.corrupt + " · marker " + (el2.markerAbsent ? "absent" : "present") + ") — aborted") };
      const rcpt = el2.receipt; // 잠금 안 재판독본이 정본(잠금 밖 resume 객체는 판별 트리거일 뿐)
      const sc = safetyChecks(repo);
      if (sc.fail) return { fail: t("잠금 안 재검사 실패: ", "in-lock recheck failed: ") + sc.fail };
      if (rcpt.authorityObject.mapId !== sc.topo.mapId) return { fail: "receipt.mapId ≠ 현재 topology.mapId" };
      const text = JSON.stringify(rcpt.authorityObject, null, 1);
      if (!atomicWriteBuf(path.join(repo, "project-map", "authority.json"), text)) return { fail: t("marker 기록 실패", "marker write failed") };
      const rb = MB.authorityStateFor(repo);
      if (rb.st !== "v2") return { fail: t("read-back 실패(" + rb.st + ") — 삭제 없이 중단(후속 실행이 재개)", "read-back failed (" + rb.st + ") — aborted without deletion (next run resumes)") };
      // C-5 배너 완결(재개도 성공 전 완결 — tail과 '동일' 조건부 판정: 2차 blocker① — cur===null도
      // 기준선과 대조해 존재형 기준선인데 파일이 사라졌으면 동결 위반 의심 경보·ABSENT sentinel만 정상 부재)
      let bannerNote = null;
      const cur = MB.legacySourceFor(repo);
      let baseline = null;
      try { baseline = JSON.parse(fs.readFileSync(path.join(snapDirFor(repo, rcpt.authorityObject.decisionRef), "frozen-ledger-fp.json"), "utf8")); } catch { baseline = null; }
      if (cur && cur.err) bannerNote = t("⚠ 확정층 판독 불가 — 배너 판정 불가", "⚠ ledger unreadable — banner state unknown");
      else if (!baseline || typeof baseline.fp !== "string") bannerNote = t("⚠ 기준선 불명 — 배너 보충 없음(흡수 금지)", "⚠ baseline unknown — no banner (no absorption)"); // 3차 blocker: 조건 없이 경고(parse 가능 손상+확정층 부재 조합의 침묵 소멸 — probe 판정과 동형)
      else if (!cur) { if (baseline.fp !== ABSENT_SENTINEL) bannerNote = t("⚠ 확정층이 사라짐(기준선=존재) — 동결 위반 의심·경보", "⚠ ledger vanished (baseline says present) — freeze violation suspected"); }
      else if (!bannerPresent(cur.text)) {
        if (sha1(Buffer.from(bannerApplied(cur.text), "utf8")) !== baseline.fp) bannerNote = t("⚠ 배너 적용 결과 지문≠기준선 — 동결 위반 경보(보충 없음)", "⚠ banner-applied fingerprint ≠ baseline — freeze violation alert (no write)");
        else if (!atomicWriteBuf(path.join(repo, cur.rel), bannerApplied(cur.text))) bannerNote = t("⚠ 배너 기록 실패(marker가 권위 — 재실행이 보충)", "⚠ banner write failed (marker is authority — next run completes it)");
      }
      return { ok: true, mapId: rb.mapId, bannerNote, decisionRef: rcpt.authorityObject.decisionRef };
    });
    if (!lk.ok) { console.error(t("정본 잠금 실패", "canonical lock failed")); return 1; }
    if (lk.result.fail) { console.error(lk.result.fail); return 1; }
    out([t("✅ cutover 재개 완결(marker 보충) — mapId " + lk.result.mapId + " · decisionRef " + lk.result.decisionRef, "✅ cutover resumed & completed (marker filled) — mapId " + lk.result.mapId + " · decisionRef " + lk.result.decisionRef),
      ...(lk.result.bannerNote ? [lk.result.bannerNote] : []),
      t("⚠ 모든 VS Code 창 리로드 필수 — 리로드 전 창·구세대 CLI를 이 저장소에 쓰지 마세요.", "⚠ Reload every VS Code window — do not use pre-reload windows or old CLI on this repository.")]);
    return 0;
  }

  // C-1 5: 미이관 N(신규 경로 승인 조건)
  const um = unmigratedRowsFor(repo, topo.mapId);
  if (!um.ok) { console.error(t("이관 결과 확인 실패: ", "migration check failed: ") + um.err); return 1; }
  if (um.n > 0 && flags.confirmUnmigrated !== um.n) {
    console.error(t("v2 뷰에 나타나지 않을 확정층 행 " + um.n + "건 — 정확 수로 --confirm-unmigrated " + um.n + " 를 붙여야 진행(informed 동의·수가 다르면 거부).", um.n + " ledger row(s) will not appear in the v2 view — re-run with --confirm-unmigrated " + um.n + " (informed consent; a different number is refused)."));
    for (const r of um.rows.slice(0, 20)) console.error("  · " + r.sig24 + " [" + r.why + "] " + r.text);
    return 1;
  }
  // C-1 6: decisionId 사전 발급+스냅샷(잠금 밖 — 기록 실패=중단·marker 이전이라 무해)
  const decisionId = crypto.randomUUID();
  const sdir = snapDirFor(repo, decisionId);
  fs.mkdirSync(sdir, { recursive: true });
  const snapTopoRaw = pre.raw !== undefined && pre.raw !== null ? pre.raw : PM.canonicalSerialize(topo);
  const srcSnap = MB.legacySourceFor(repo);
  if (srcSnap && srcSnap.err) { console.error(t("확정층 판독 불가: ", "ledger unreadable: ") + srcSnap.err); return 1; }
  let bindRaw = null;
  try { bindRaw = fs.readFileSync(MB.bindingsFileFor(repo), "utf8"); } catch { bindRaw = null; }
  const wrote = atomicWriteBuf(path.join(sdir, "topology.json"), snapTopoRaw)
    && (srcSnap ? atomicWriteBuf(path.join(sdir, "ledger" + (srcSnap.rel.endsWith(".md") ? ".md" : "")), srcSnap.text) : true)
    && (bindRaw !== null ? atomicWriteBuf(path.join(sdir, "bindings.json"), bindRaw) : true)
    && atomicWriteBuf(path.join(sdir, "manifest.json"), JSON.stringify(AD.adapterManifest(), null, 1));
  if (!wrote) { console.error(t("스냅샷 기록 실패 — 중단(아무것도 바뀌지 않음)", "snapshot write failed — aborted (nothing changed)")); return 1; }
  if (_testHooks && typeof _testHooks.afterSnapshot === "function") _testHooks.afterSnapshot();

  // C-2: 잠금 안 재검사(0~5·7)+바이트 불변 → frozen-fp → receipt → marker → read-back → C-5 배너
  const lk = MR.withMapLock(repo, () => {
    const sc = safetyChecks(repo);
    if (sc.fail) return { fail: t("잠금 안 재검사 실패: ", "in-lock recheck failed: ") + sc.fail };
    const auth2 = MB.authorityStateFor(repo);
    if (auth2.st !== "legacy") return { fail: t("잠금 안 재검사: 권위 상태 변경(" + auth2.st + ") — 중단", "in-lock recheck: authority changed (" + auth2.st + ") — aborted") };
    // 스냅샷 바이트 불변 재확인(TOCTOU 봉합 — 달라졌으면 중단·재실행 안내)
    const curTopoRaw = (() => { const r2 = MR.readTopoExFor(repo); return r2.st === "ok" && r2.raw !== undefined && r2.raw !== null ? r2.raw : null; })();
    if (curTopoRaw === null || curTopoRaw !== snapTopoRaw) return { fail: t("topology가 스냅샷과 다름 — 중단·재실행", "topology changed since snapshot — aborted, re-run") };
    const cur = MB.legacySourceFor(repo);
    if (cur && cur.err) return { fail: cur.err };
    if ((cur === null) !== (srcSnap === null) || (cur && srcSnap && (cur.text !== srcSnap.text || cur.rel !== srcSnap.rel))) return { fail: t("확정층이 스냅샷과 다름 — 중단·재실행", "ledger changed since snapshot — aborted, re-run") };
    let curBind = null; try { curBind = fs.readFileSync(MB.bindingsFileFor(repo), "utf8"); } catch { curBind = null; }
    if (curBind !== bindRaw) return { fail: t("bindings.json이 스냅샷과 다름 — 중단·재실행", "bindings.json changed since snapshot — aborted, re-run") };
    const um2 = unmigratedRowsFor(repo, sc.topo.mapId);
    if (!um2.ok) return { fail: um2.err };
    if (um2.n !== um.n) return { fail: t("미이관 수가 검사 사이 변경(" + um.n + "→" + um2.n + ") — 재실행·재확인", "unmigrated count changed (" + um.n + "→" + um2.n + ") — re-run & reconfirm") };
    // frozen-ledger-fp: '잠금 안 재확인된 확정층 바이트'에 배너 적용 결과의 지문 — receipt '직전' 내구 기록
    const frozenFp = cur ? sha1(Buffer.from(bannerApplied(cur.text), "utf8")) : ABSENT_SENTINEL;
    if (!atomicWriteBuf(path.join(sdir, "frozen-ledger-fp.json"), JSON.stringify({ schema: "frozen-ledger-fp-v1", fp: frozenFp, rel: cur ? cur.rel : null, ts: new Date().toISOString() }, null, 1))) return { fail: t("frozen-ledger-fp 기록 실패 — 중단(marker 이전·무해)", "frozen-ledger-fp write failed — aborted (before marker, harmless)") };
    // receipt 조립·자체 검증·기록
    const ts = new Date().toISOString();
    const authorityObject = { schema: "map-authority-v1", cutover: true, mapId: sc.topo.mapId, decisionRef: decisionId, ts };
    const authorityFileFp = sha1(JSON.stringify(authorityObject, null, 1));
    const receipt = { schema: "map-cutover-receipt-v1", decisionId, mapId: sc.topo.mapId, authorityMode: { from: "legacy", to: "v2" }, authorityObject, authorityFileFp, ts };
    if (!MB.validReceipt(receipt, decisionId + ".json")) return { fail: "receipt 자체 검증 실패(구성 결함)" };
    const histDir = path.join(repo, "project-map", "authority-history");
    fs.mkdirSync(histDir, { recursive: true });
    if (!atomicWriteBuf(path.join(histDir, decisionId + ".json"), JSON.stringify(receipt, null, 1))) return { fail: t("receipt 기록 실패 — 중단(marker 이전·무해)", "receipt write failed — aborted (before marker, harmless)") };
    // marker
    if (!atomicWriteBuf(path.join(repo, "project-map", "authority.json"), JSON.stringify(authorityObject, null, 1))) return { fail: t("marker 기록 실패 — receipt만 존재=재개 대상 상태(재실행이 보충)", "marker write failed — receipt-only state, next run resumes"), receiptOnly: true };
    // read-back(잠금 안 — 같은 스냅샷 세계에서 판정)
    const rb2 = MB.authorityStateFor(repo);
    if (rb2.st !== "v2") return { fail: t("read-back 실패(" + rb2.st + ") — 삭제 없이 중단(후속 실행이 재개)", "read-back failed (" + rb2.st + ") — aborted without deletion"), receiptOnly: true };
    // C-5 배너(성공 후·같은 임계구역 — 실패=경고만·재시도는 tail)
    let bannerNote = null;
    if (cur) {
      const applied = bannerApplied(cur.text);
      if (!bannerPresent(cur.text) && !atomicWriteBuf(path.join(repo, cur.rel), applied)) bannerNote = t("⚠ 동결 배너 기록 실패(marker가 권위 — 재실행이 보충)", "⚠ freeze banner write failed (marker is authority — next run completes it)");
    }
    return { ok: true, mapId: sc.topo.mapId, ts, bannerNote, unmig: um2.n, draft: !!sc.topo.draft };
  });
  if (!lk.ok) { console.error(t("정본 잠금 실패", "canonical lock failed")); return 1; }
  const r = lk.result;
  if (r.fail) { console.error(r.fail); return 1; }
  out([
    t("✅ cutover 완결 — mapId " + r.mapId + " · decisionId " + decisionId + " · " + r.ts + (r.draft ? " · DRAFT(지도 품질 선언 아님 — usable 전이는 별개)" : ""), "✅ cutover complete — mapId " + r.mapId + " · decisionId " + decisionId + " · " + r.ts + (r.draft ? " · DRAFT (not a quality claim — usable transition is separate)" : "")),
    t("· 스냅샷/진단 재료: " + sdir, "· snapshot/diagnostics: " + sdir),
    ...(r.unmig > 0 ? [t("· 미이관 " + r.unmig + "건은 v2 뷰에 나타나지 않음(증거층에는 그대로 — 1-24)", "· " + r.unmig + " unmigrated row(s) will not appear in the v2 view (still in the evidence layer — 1-24)")] : []),
    ...(r.bannerNote ? [r.bannerNote] : []),
    t("⚠ 모든 VS Code 창 리로드 필수 — 리로드 전 창·구세대 CLI를 이 저장소에 쓰지 마세요(위반은 동결 감시가 자동 경보).", "⚠ Reload every VS Code window — do not use pre-reload windows or old CLI on this repository (violations trigger the freeze probe alert)."),
  ]);
  return 0;
}

module.exports = { runCutover, frozenLedgerProbeFor, unmigratedRowsFor, deployGenerationCheck, safetyChecks, BANNER, bannerApplied, bannerPresent, snapDirFor, QUIESCENCE_KO, QUIESCENCE_EN, ABSENT_SENTINEL };
