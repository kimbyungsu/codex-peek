/*
 * Project MAP 런타임(P0.5 — 배포 모듈). 기존 scripts/scope-map.js의 수집기·draft·정본 쓰기·명령을 이관했다:
 * VSIX는 scripts/**를 제외하므로 마켓 설치본에는 이 bridge/ 사본만 존재한다(MAP-V2-DESIGN.md 1-15).
 * 순수 코어는 같은 폴더의 project-map.js(out/ 컴파일 산출물의 바이트 사본 — scripts/sync-map-core.js가 생성,
 * 패리티는 테스트로 잠금)를 require한다 — 레포·브릿지 홈 어디서든 동일 상대경로.
 * 사용(CLI 래퍼 scripts/scope-map.js 경유):
 *   node scripts/scope-map.js <repo> inventory  — 결정론 인벤토리(LLM 호출 0)
 *   node scripts/scope-map.js <repo> init       — draft topology 신설(v2 — 이미 있으면 실패)
 *   node scripts/scope-map.js <repo> status     — coverage 표시(v1 파일이면 migrate 안내)
 *   node scripts/scope-map.js <repo> render     — MAP.md 생성 뷰 재생성
 *   node scripts/scope-map.js <repo> migrate    — v1 topology를 v2로 결정론 변환(1회·명시 명령만 — 자동 변환 없음)
 * 정본 쓰기는 fail-closed 잠금(withFileLockStrict). 편집 제안·적용 배선은 후속(P2).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadLang, withFileLockStrict, wsKeyFor } = require(path.join(__dirname, "contract-lib.js"));
const PM = require(path.join(__dirname, "project-map.js"));
const tB = (ko, en) => (loadLang() === "en" ? en : ko);

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");

// ── 결정론 인벤토리(설계검증: collectPackage[변경 꾸러미] 재사용 불가 — 전체 구조용 전용 수집기) ──
const POLICY_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "__pycache__", ".venv", "venv", "coverage", ".idea", ".vscode-test"]);
const CODE_EXT = new Set([".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".py"]);
const CONFIG_EXT = new Set([".json", ".yml", ".yaml", ".toml", ".ini"]);
const DOC_EXT = new Set([".md", ".rst", ".txt"]);
const MAX_ENTRIES = 20000, MAX_DEPTH = 10;

function collectInventory(root) {
  const files = []; // {rel, kind}
  // scannedSupportedFiles='regex 스캔한 지원 파일 수'(파싱 성공 주장 아님). semanticUnreadable=내용 읽기 실패(순회 완전성과 분리).
  const cov = { scanComplete: true, filesSeen: 0, policyExcluded: [], depthCapped: [], entryCapped: false, unreadable: [], semantic: { supportedLangs: ["js", "ts"], scannedSupportedFiles: 0, unsupportedFiles: 0, dynamicUnknowns: 0, externalOrAliasSkipped: 0, semanticUnreadable: [], parserNote: "regex 기반(주석 제거 후 매칭) — 배럴 재수출·경로 별칭·외부 패키지 미해석·문자열 안의 가짜 import는 구분 불가(오탐 수 계측 불가)·파싱 보장 아님(lexer/AST는 후속)" } };
  let seen = 0;
  const walk = (dir, depth, rel) => {
    if (seen >= MAX_ENTRIES) { cov.entryCapped = true; cov.scanComplete = false; return; }
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { cov.unreadable.push(rel || "."); cov.scanComplete = false; return; }
    for (const it of items) {
      if (seen >= MAX_ENTRIES) { cov.entryCapped = true; cov.scanComplete = false; return; }
      seen++;
      const r = rel ? rel + "/" + it.name : it.name;
      if (it.isDirectory()) {
        if (POLICY_EXCLUDE.has(it.name)) { cov.policyExcluded.push(r); continue; } // 의도 제외 — 미스캔 '분모' 아님
        if (r === "project-map") continue; // 자기 자신 제외(자기참조 방지)
        if (depth >= MAX_DEPTH) { cov.depthCapped.push(r); cov.scanComplete = false; continue; }
        walk(path.join(dir, it.name), depth + 1, r);
        continue;
      }
      cov.filesSeen++;
      const ext = path.extname(it.name).toLowerCase();
      const kind = it.name.includes(".test.") || /^test_|_test\.py$/.test(it.name) ? "test"
        : CODE_EXT.has(ext) ? "code" : CONFIG_EXT.has(ext) ? "config" : DOC_EXT.has(ext) ? "doc" : "other";
      files.push({ rel: r.replace(/\\/g, "/"), kind });
    }
  };
  walk(root, 0, "");
  // js/ts import·require 정적 추출(정규식 — 한계는 semantic에 정직 기록)
  const importsByDir = new Map(); // fromTop → Map(toTop → Set(근거))
  const topOf = (rel) => rel.includes("/") ? rel.split("/")[0] : "(root)";
  for (const f of files) {
    if (f.kind !== "code" && f.kind !== "test") continue;
    const ext = path.extname(f.rel).toLowerCase();
    if (![".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"].includes(ext)) { cov.semantic.unsupportedFiles++; continue; } // py 등 — import 미해석
    let src;
    try { src = fs.readFileSync(path.join(root, f.rel), "utf8"); } catch { cov.semantic.semanticUnreadable.push(f.rel); continue; }
    cov.semantic.scannedSupportedFiles++;
    // 주석 제거 후 매칭('// from "./x"' 오탐 방지) — 보수적 스트리핑이라 문자열 내 // 한계는 parserNote 고지.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
    // side-effect import(import "./x")도 추출
    const re = /(?:require\s*\(\s*|from\s+|import\s+[^"'\n]*?from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']|require\s*\(\s*([^"')][^)]*)\)|import\s*\(\s*([^"')][^)]*)\)/g;
    let m;
    while ((m = re.exec(stripped))) {
      if (m[2] !== undefined || m[3] !== undefined) { cov.semantic.dynamicUnknowns++; continue; } // 동적 참조 — 대상 미상
      const spec = m[1];
      if (!spec) continue;
      if (!spec.startsWith(".")) { cov.semantic.externalOrAliasSkipped++; continue; } // 외부 패키지·경로 별칭 — 버리지 않고 셈
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), spec));
      const fromTop = topOf(f.rel), toTop = topOf(resolved);
      if (fromTop === toTop) continue; // 디렉터리 수준 집계
      let per = importsByDir.get(fromTop);
      if (!per) { per = new Map(); importsByDir.set(fromTop, per); }
      let samples = per.get(toTop);
      if (!samples) { samples = new Set(); per.set(toTop, samples); }
      if (samples.size < 3) samples.add(f.rel + " → " + spec); // 실제 코드 근거(역추적 가능)
    }
  }
  return { files, importsByDir, cov };
}

// ── init: draft topology 생성(결정론 경계 우선 — 전부 candidate·v2 스키마) ──
function buildDraft(root) {
  const { files, importsByDir, cov } = collectInventory(root);
  const now = new Date().toISOString();
  const nodes = [];
  const byLabel = new Map();
  const addNode = (label, entityType, roles, anchors) => {
    if (byLabel.has(label)) return byLabel.get(label);
    const n = {
      id: crypto.randomUUID(), // 불투명·불변(UUID 128비트)
      label, entityType, roles,
      state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, // 초안은 전부 candidate
      anchors, // v2: lastSeenAt 미기록(고빈도 관측치는 하네스 로컬 — mapHash 자기 유발 무효화 방지)
    };
    nodes.push(n); byLabel.set(label, n);
    return n;
  };
  // 결정론 경계 1: 최상위 디렉터리(코드가 있는 것만)
  const topDirs = new Map();
  for (const f of files) {
    const top = f.rel.includes("/") ? f.rel.split("/")[0] : "(root)";
    let g = topDirs.get(top);
    if (!g) { g = { code: 0, test: 0, config: 0, doc: 0, other: 0, sample: [] }; topDirs.set(top, g); }
    g[f.kind] = (g[f.kind] || 0) + 1;
    if (g.sample.length < 3 && (f.kind === "code" || f.kind === "test")) g.sample.push(f.rel);
    if (f.kind === "config") { if (!g.configSample) g.configSample = []; if (g.configSample.length < 3) g.configSample.push(f.rel); }
  }
  for (const [top, g] of [...topDirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!g.code && !g.test && !g.config) continue;
    const roles = [];
    const testOnly = g.test && !g.code;
    if (testOnly) roles.push("gate"); // 테스트 전용 구역은 검증 관문 후보
    let anchors = g.sample.map((s) => ({ kind: testOnly ? "test" : "code", path: s }));
    if (!anchors.length && g.configSample && g.configSample.length) anchors = g.configSample.map((s) => ({ kind: "config", path: s }));
    addNode(top, testOnly ? "process" : "module", roles, anchors);
  }
  // 결정론 경계 2: entry point — package.json main/bin만(scripts 항목·py __main__은 미지원: 한계 정직)
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const anchors = [];
    if (typeof pj.main === "string") anchors.push({ kind: "code", path: pj.main });
    if (pj.bin && typeof pj.bin === "object") for (const v of Object.values(pj.bin)) anchors.push({ kind: "code", path: String(v) });
    if (anchors.length) addNode("(entry) " + (pj.name || "package"), "boundary", ["gate"], anchors.slice(0, 5));
  } catch { /* package.json 없음 — node 프로젝트 아님 */ }
  // 엣지: 디렉터리 수준 imports(정적 의존)
  const edges = [];
  for (const [fromTop, per] of [...importsByDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const fromN = byLabel.get(fromTop);
    if (!fromN) continue;
    for (const [toTop, samples] of [...per.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const toN = byLabel.get(toTop);
      if (!toN) continue;
      edges.push({
        id: crypto.randomUUID(), from: fromN.id, to: toN.id, relation: "imports",
        state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" },
        evidence: [...samples].sort().map((ref) => ({ kind: "code", ref, note: "inventory 정적 import" })),
      });
    }
  }
  return {
    schemaVersion: PM.MAP_SCHEMA_VERSION,
    mapId: crypto.randomUUID(), // v2: 지도 세대 정체성(재생성=새 세대 — 설계 1-31)
    draft: true,
    project: path.basename(root),
    createdAt: now,
    revision: 1,
    nodes, edges,
    inventory: cov,
    freshnessNote: PM.FRESHNESS_NOTE_V2,
  };
}

// 부재/손상/읽기실패 3분기(ENOENT만 부재 — 권한 오류를 '없음'으로 오도 금지). raw는 migrate의 경합 재검사 재료.
function readTopoEx(TOPO) {
  let raw;
  try { raw = fs.readFileSync(TOPO, "utf8"); } catch (e) { return { st: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
  try { return { st: "ok", topo: JSON.parse(raw), raw }; } catch { return { st: "invalid" }; }
}
// 정본 쓰기 — '검사와 쓰기를 한 잠금 안에서'(check-then-lock 경합 봉합). inLock이 잠금 안에서 현재 상태를
// 재확인하고 topology를 반환(null=중단). 반환: {code:0|1} — 잠금 실패는 fail-closed로 1.
function writeCanonicalLocked(ctx, inLock) {
  fs.mkdirSync(ctx.MAP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(ctx.LOCK), { recursive: true });
  const r = withFileLockStrict(ctx.LOCK, () => {
    const topo = inLock();
    if (!topo) return false;
    const tmp = ctx.TOPO + ".tmp";
    fs.writeFileSync(tmp, PM.canonicalSerialize(topo), "utf8");
    fs.renameSync(tmp, ctx.TOPO);
    fs.writeFileSync(ctx.VIEW + ".tmp", PM.renderMapMd(topo), "utf8");
    fs.renameSync(ctx.VIEW + ".tmp", ctx.VIEW);
    return true;
  });
  if (!r.ok) { console.error(tB("정본 잠금 실패(fail-closed): ", "Canonical lock failed (fail-closed): ") + r.error); return { lockFailed: true, wrote: false }; }
  return { lockFailed: false, wrote: r.result === true };
}

const V1_HINT_KO = "v1 topology 감지 — `migrate`로 v2 전환(1회·결정론: mapId 부여·lastSeenAt 제거). 자동 변환은 하지 않는다.";
const V1_HINT_EN = "v1 topology detected — convert with `migrate` (one-shot, deterministic: assigns mapId, drops lastSeenAt). No automatic conversion.";

// CLI 본체 — 종료 코드를 반환(process.exit는 래퍼 몫: 테스트·재사용성).
function runCli(repoArg, cmdArg) {
  const cmd = cmdArg || "status";
  if (!repoArg) { console.error(tB("사용: node scripts/scope-map.js <repo> [inventory|init|status|render|migrate]", "Usage: node scripts/scope-map.js <repo> [inventory|init|status|render|migrate]")); return 2; }
  const repo = path.resolve(repoArg);
  const ctx = { repo, MAP_DIR: path.join(repo, "project-map") };
  ctx.TOPO = path.join(ctx.MAP_DIR, "topology.json");
  ctx.VIEW = path.join(ctx.MAP_DIR, "MAP.md");
  ctx.LOCK = path.join(BRIDGE_DIR, "project-map-locks", wsKeyFor(repo) + ".lock"); // 잠금은 하네스 서랍(레포 무오염)

  if (cmd === "inventory") {
    const { importsByDir, cov } = collectInventory(repo);
    console.log(tB(`파일 ${cov.filesSeen}개(순회 ${cov.scanComplete ? "완료" : "미완"}) · regex 스캔 ${cov.semantic.scannedSupportedFiles}건(js/ts — 파싱 보장 아님) · 미지원 ${cov.semantic.unsupportedFiles} · 동적 미상 ${cov.semantic.dynamicUnknowns} · 외부/별칭 ${cov.semantic.externalOrAliasSkipped}`, `${cov.filesSeen} file(s) (walk ${cov.scanComplete ? "complete" : "incomplete"}) · regex-scanned ${cov.semantic.scannedSupportedFiles} (js/ts — not full parsing) · unsupported ${cov.semantic.unsupportedFiles} · dynamic unknowns ${cov.semantic.dynamicUnknowns} · external/alias ${cov.semantic.externalOrAliasSkipped}`));
    for (const [fromTop, per] of importsByDir) console.log(`  ${fromTop} → ${[...per.keys()].sort().join(", ")}`);
    return 0;
  }
  if (cmd === "init") {
    const topo = buildDraft(repo); // 수집은 잠금 밖(길다) — 존재 '검사'와 쓰기는 잠금 안
    const errs = PM.validateTopology(topo);
    if (errs.length) { console.error(tB("스키마 검증 실패:\n", "Schema validation failed:\n") + errs.join("\n")); return 1; }
    const w = writeCanonicalLocked(ctx, () => (fs.existsSync(ctx.TOPO) ? null : topo)); // 잠금 안 재검사 — 동시 init 차단
    if (w.lockFailed) return 1;
    if (!w.wrote) { console.error(tB("이미 topology.json이 있음 — init 재실행은 모든 ID를 재생성해 기존 연결을 끊는다(설계검증). 갱신은 후속 refresh(rename/merge '제안')가 담당.", "topology.json already exists — re-running init would regenerate all IDs and sever existing references. Updates belong to the future refresh (rename/merge proposals).")); return 1; }
    const gc = PM.graphCoverage(topo);
    console.log(tB(`draft topology 생성: 노드 ${topo.nodes.length}(candidate ${gc.nodes.candidate}) · 엣지 ${topo.edges.length} · ${ctx.TOPO}`, `Draft topology created: ${topo.nodes.length} node(s) (candidate ${gc.nodes.candidate}) · ${topo.edges.length} edge(s) · ${ctx.TOPO}`));
    console.log(tB("⚠ 이 지도는 관측 초안(draft)이다 — 확정층(MAP.md 승인 장부) 권위를 대체하지 않으며, 편집 제안·적용 배선은 후속(P2).", "⚠ This map is an observational draft — it does not replace the approved stable layer; propose/apply wiring comes later (P2)."));
    return 0;
  }
  if (cmd === "status") {
    const rt = readTopoEx(ctx.TOPO);
    if (rt.st === "absent") { console.log(tB("topology 없음 — `init`으로 draft를 만들 수 있다(관측 초안 — 아무것도 강제하지 않음).", "No topology — create a draft with `init` (observational only).")); return 0; }
    if (rt.st === "invalid") { console.error(tB("⚠ topology.json이 존재하지만 JSON 파싱 실패(손상) — init은 덮어쓰지 않는다. 수동 확인(백업·삭제) 후 다시 init.", "⚠ topology.json exists but failed to parse (corrupted) — init will not overwrite it. Inspect (back up / remove) manually, then re-run init.")); return 1; }
    if (rt.st === "unreadable") { console.error(tB("⚠ topology.json 읽기 실패(권한 등 — 부재 아님) — 파일 접근을 확인하라.", "⚠ Failed to read topology.json (permissions etc. — not absent) — check file access.")); return 1; }
    const topo = rt.topo;
    if (topo && topo.schemaVersion === 1) { console.error(tB("⚠ " + V1_HINT_KO, "⚠ " + V1_HINT_EN)); return 1; } // v1은 v2 검증보다 먼저 식별(오도 방지)
    // 검증을 파생 계산보다 먼저(schema-invalid에서 파생 계산이 TypeError로 죽던 순서 결함)
    const errs = PM.validateTopology(topo);
    if (errs.length) { console.error(tB("⚠ 스키마 위반(파생 계산 생략):\n", "⚠ Schema violations (derived output skipped):\n") + errs.join("\n")); return 1; }
    const gc = PM.graphCoverage(topo);
    console.log(tB(`schema v${topo.schemaVersion} · revision ${topo.revision} · ${topo.draft ? "DRAFT" : "adopted"} · 지문 ${PM.mapHashOf(topo).slice(0, 12)}…`, `schema v${topo.schemaVersion} · revision ${topo.revision} · ${topo.draft ? "DRAFT" : "adopted"} · hash ${PM.mapHashOf(topo).slice(0, 12)}…`));
    console.log(tB(`그래프: 노드 ${topo.nodes.length}(confirmed ${gc.nodes.confirmed}/candidate ${gc.nodes.candidate}/unknown ${gc.nodes.unknown}) · 엣지 ${topo.edges.length}`, `Graph: ${topo.nodes.length} node(s) (confirmed ${gc.nodes.confirmed}/candidate ${gc.nodes.candidate}/unknown ${gc.nodes.unknown}) · ${topo.edges.length} edge(s)`));
    const sm = topo.inventory.semantic;
    console.log(tB(`인벤토리: 파일 ${topo.inventory.filesSeen} · 순회 ${topo.inventory.scanComplete ? "완료" : "미완"} · regex 스캔 ${sm.scannedSupportedFiles}/${sm.scannedSupportedFiles + sm.unsupportedFiles}(파싱 보장 아님) · 동적 미상 ${sm.dynamicUnknowns} · 외부/별칭 ${sm.externalOrAliasSkipped} · 판독 실패 ${(sm.semanticUnreadable || []).length} · ${topo.freshnessNote}`, `Inventory: ${topo.inventory.filesSeen} file(s) · walk ${topo.inventory.scanComplete ? "complete" : "incomplete"} · regex-scanned ${sm.scannedSupportedFiles}/${sm.scannedSupportedFiles + sm.unsupportedFiles} (not full parsing) · dynamic unknowns ${sm.dynamicUnknowns} · external/alias ${sm.externalOrAliasSkipped} · unreadable ${(sm.semanticUnreadable || []).length} · ${topo.freshnessNote}`));
    // catch는 파일 읽기에만 한정 — 렌더 오류까지 삼켜 'MAP.md 없음'으로 오도하지 않는다
    let mdCur = null;
    try { mdCur = fs.readFileSync(ctx.VIEW, "utf8"); } catch { console.log(tB("MAP.md 없음 — `render`로 생성.", "No MAP.md — create it with `render`.")); }
    if (mdCur !== null && mdCur !== PM.renderMapMd(topo)) console.log(tB("⚠ MAP.md가 정본과 불일치(수동 수정 또는 렌더 누락) — `render`로 재생성하라.", "⚠ MAP.md does not match the canonical topology (manual edit or missing render) — re-run `render`."));
    return 0;
  }
  if (cmd === "render") {
    const w = writeCanonicalLocked(ctx, () => {
      const rt = readTopoEx(ctx.TOPO); // 잠금 '안' 재판독 — 낡은 스냅샷 되돌림(lost-update) 차단
      if (rt.st === "absent") { console.error(tB("topology 없음 — 먼저 init.", "No topology — run init first.")); return null; }
      if (rt.st === "invalid") { console.error(tB("topology.json 손상(JSON 파싱 실패) — 렌더 중단. 수동 확인 필요.", "topology.json is corrupted (JSON parse failure) — render aborted. Manual inspection required.")); return null; }
      if (rt.st === "unreadable") { console.error(tB("topology.json 읽기 실패(권한 등) — 렌더 중단.", "Failed to read topology.json (permissions etc.) — render aborted.")); return null; }
      if (rt.topo && rt.topo.schemaVersion === 1) { console.error(tB("⚠ " + V1_HINT_KO, "⚠ " + V1_HINT_EN)); return null; }
      const errs = PM.validateTopology(rt.topo);
      if (errs.length) { console.error(tB("스키마 위반으로 렌더 중단:\n", "Render aborted due to schema violations:\n") + errs.join("\n")); return null; }
      return rt.topo;
    });
    if (w.lockFailed || !w.wrote) return 1;
    console.log(tB("MAP.md 재생성: ", "MAP.md regenerated: ") + ctx.VIEW);
    return 0;
  }
  if (cmd === "migrate") {
    // 순서 계약(P0.5 설계검증 #3): v1 확인→frozen v1 검증→변환→v2 검증→잠금 안 raw 동일성 재확인→교체.
    const pre = readTopoEx(ctx.TOPO);
    if (pre.st === "absent") { console.error(tB("topology 없음 — migrate 대상이 없다(새 지도는 init).", "No topology — nothing to migrate (use init for a new map).")); return 1; }
    if (pre.st === "invalid") { console.error(tB("topology.json 손상(JSON 파싱 실패) — migrate 중단. 수동 확인 필요.", "topology.json is corrupted — migrate aborted. Manual inspection required.")); return 1; }
    if (pre.st === "unreadable") { console.error(tB("topology.json 읽기 실패(권한 등) — migrate 중단.", "Failed to read topology.json — migrate aborted.")); return 1; }
    if (pre.topo && pre.topo.schemaVersion === PM.MAP_SCHEMA_VERSION) { console.log(tB("이미 v" + PM.MAP_SCHEMA_VERSION + " — 변환 불요(멱등).", "Already v" + PM.MAP_SCHEMA_VERSION + " — nothing to do (idempotent).")); return 0; }
    const r = PM.migrateTopologyV1toV2(pre.topo);
    if (!r.topo) { console.error(tB("migrate 중단(원본 무변경) — v1 검증/변환 실패:\n", "Migrate aborted (original untouched) — v1 validation/conversion failed:\n") + r.errors.join("\n")); return 1; }
    const w = writeCanonicalLocked(ctx, () => {
      const cur = readTopoEx(ctx.TOPO); // 잠금 안 재판독 — 그새 바뀌었으면(동시 migrate·편집) 중단
      if (cur.st !== "ok" || cur.raw !== pre.raw) { console.error(tB("migrate 경합 감지(파일이 판독 시점과 다름) — 중단. 다시 실행하라.", "Migrate race detected (file changed since read) — aborted. Re-run.")); return null; }
      return r.topo;
    });
    if (w.lockFailed || !w.wrote) return 1;
    console.log(tB(`v1→v2 변환 완료(결정론 mapId ${r.topo.mapId}) · ${ctx.TOPO}`, `Migrated v1→v2 (deterministic mapId ${r.topo.mapId}) · ${ctx.TOPO}`));
    return 0;
  }
  console.error(tB(`알 수 없는 명령: ${cmd} (inventory|init|status|render|migrate)`, `Unknown command: ${cmd} (inventory|init|status|render|migrate)`));
  return 2;
}

module.exports = { runCli, collectInventory, buildDraft, readTopoEx };
