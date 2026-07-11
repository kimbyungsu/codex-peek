/*
 * Project MAP v1 CLI(draft 전용 뼈대 — 설계 사전검증 3왕복 합의 2026-07-10).
 * 사용: node scripts/scope-map.js <repo> inventory   — 결정론 인벤토리(파일 분류·entry·js/ts import — LLM 호출 0)
 *       node scripts/scope-map.js <repo> init        — draft topology 신설(이미 있으면 실패 — ID 재생성이 연결을 끊음)
 *       node scripts/scope-map.js <repo> status      — coverage 3분리 표시(인벤토리/그래프 — 증거는 후속)
 *       node scripts/scope-map.js <repo> render      — MAP.md 생성 뷰 재생성(직접 수정 금지·지문 머리말)
 *
 * v1 경계(정직): adopt(정본 채택)·propose/approve 배선 없음 — topology는 관측 초안(draft:true 강제)이며
 * 기존 MAP.md 확정층의 권위를 침범하지 않는다. 다섯 의미 편집(분할·확대·축소·소멸·재작성)의 실동작은 전부
 * 후속 — 이 CLI는 좌표계 뼈대만 만든다. 정본 쓰기는 fail-closed 잠금(withFileLockStrict — fail-open 금지).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadLang, withFileLockStrict, wsKeyFor } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const PM = require(path.join(__dirname, "..", "out", "project-map.js"));
const tB = (ko, en) => (loadLang() === "en" ? en : ko);

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
const repoArg = process.argv[2];
const cmd = process.argv[3] || "status";
if (!repoArg) { console.error(tB("사용: node scripts/scope-map.js <repo> [inventory|init|status|render]", "Usage: node scripts/scope-map.js <repo> [inventory|init|status|render]")); process.exit(2); }
const repo = path.resolve(repoArg);
const MAP_DIR = path.join(repo, "project-map");
const TOPO = path.join(MAP_DIR, "topology.json");
const VIEW = path.join(MAP_DIR, "MAP.md");
// 잠금은 하네스 서랍(로컬 — 저장소를 .lock으로 오염시키지 않고 git 추적도 안 됨)
const LOCK = path.join(BRIDGE_DIR, "project-map-locks", wsKeyFor(repo) + ".lock");

// ── 결정론 인벤토리(설계검증: collectPackage[변경 꾸러미] 재사용 불가 — 전체 구조용 전용 수집기) ──
// 제외 정책은 MAP 전용(설계검증: 기존 SKIP_DIRS의 '점 시작 디렉터리 전부 제외'는 .github 등 CI·설정 축을 지움).
const POLICY_EXCLUDE = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "__pycache__", ".venv", "venv", "coverage", ".idea", ".vscode-test"]);
const CODE_EXT = new Set([".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".py"]);
const CONFIG_EXT = new Set([".json", ".yml", ".yaml", ".toml", ".ini"]);
const DOC_EXT = new Set([".md", ".rst", ".txt"]);
const MAX_ENTRIES = 20000, MAX_DEPTH = 10;

function collectInventory(root) {
  const files = []; // {rel, kind}
  // scannedSupportedFiles='regex 스캔한 지원 파일 수'(파싱 성공 주장 아님 — 검증 지적: parsedFiles 명칭은 과장).
  // semanticUnreadable=내용 읽기 실패(의미 판독 실패 — 순회 완전성(scanComplete)과 분리: 검증 지적 #7).
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
  const importsByDir = new Map(); // fromTop → Set(toTop)
  const topOf = (rel) => rel.includes("/") ? rel.split("/")[0] : "(root)";
  for (const f of files) {
    if (f.kind !== "code" && f.kind !== "test") continue;
    const ext = path.extname(f.rel).toLowerCase();
    if (![".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"].includes(ext)) { cov.semantic.unsupportedFiles++; continue; } // py 등 — import 미해석(파일 분류만)
    let src;
    try { src = fs.readFileSync(path.join(root, f.rel), "utf8"); } catch { cov.semantic.semanticUnreadable.push(f.rel); continue; } // 의미 판독 실패 — 순회 완전성과 분리(검증 지적 #7)
    cov.semantic.scannedSupportedFiles++;
    // 주석 제거 후 매칭 — '// from "./x"' 같은 주석이 실제 import로 오탐되던 반례(검증 지적). 보수적
    // 스트리핑(블록·라인 주석)이라 문자열 내 // 케이스에 한계 — parserNote에 고지.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
    // side-effect import(import "./x")도 추출(검증 반례: 기존 정규식이 전혀 못 찾음)
    const re = /(?:require\s*\(\s*|from\s+|import\s+[^"'\n]*?from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']|require\s*\(\s*([^"')][^)]*)\)|import\s*\(\s*([^"')][^)]*)\)/g;
    let m;
    while ((m = re.exec(stripped))) {
      if (m[2] !== undefined || m[3] !== undefined) { cov.semantic.dynamicUnknowns++; continue; } // 동적 참조 — 대상 미상
      const spec = m[1];
      if (!spec) continue;
      if (!spec.startsWith(".")) { cov.semantic.externalOrAliasSkipped++; continue; } // 외부 패키지·경로 별칭 — 버리지 않고 셈(검증 지적)
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), spec));
      const fromTop = topOf(f.rel), toTop = topOf(resolved);
      if (fromTop === toTop) continue; // 디렉터리 수준 집계 — 동일 최상위 내부는 생략(v1 입도)
      let per = importsByDir.get(fromTop);
      if (!per) { per = new Map(); importsByDir.set(fromTop, per); }
      let samples = per.get(toTop);
      if (!samples) { samples = new Set(); per.set(toTop, samples); }
      if (samples.size < 3) samples.add(f.rel + " → " + spec); // 실제 코드 근거(역추적 가능 — 합성 문자열은 typed evidence 미충족: 검증 지적)
    }
  }
  return { files, importsByDir, cov };
}

// ── init: draft topology 생성(결정론 경계 우선 — 설계검증: 임의 의미 모듈 확정 금지·전부 candidate) ──
function buildDraft(root) {
  const { files, importsByDir, cov } = collectInventory(root);
  const now = new Date().toISOString();
  const nodes = [];
  const byLabel = new Map();
  const addNode = (label, entityType, roles, anchors) => {
    if (byLabel.has(label)) return byLabel.get(label);
    const n = {
      id: crypto.randomUUID(), // 불투명·불변(설계검증: 시각/label 시드 sha1 8자는 충돌·재실행 변동 — UUID 128비트)
      label, entityType, roles,
      state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, // 초안은 전부 candidate(임의 확정 금지)
      anchors, lastSeenAt: now,
    };
    nodes.push(n); byLabel.set(label, n);
    return n;
  };
  // 결정론 경계 1: 최상위 디렉터리(코드가 있는 것만) — '임의 의미 모듈'이 아니라 directory candidate
  const topDirs = new Map(); // top → {code, test, config, doc}
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
    // anchor kind 정직화(검증 지적): 테스트 표본=test, 코드 없이 config만이면 config 표본(빈 anchors 방지)
    let anchors = g.sample.map((s) => ({ kind: testOnly ? "test" : "code", path: s }));
    if (!anchors.length && g.configSample && g.configSample.length) anchors = g.configSample.map((s) => ({ kind: "config", path: s }));
    addNode(top, testOnly ? "process" : "module", roles, anchors);
  }
  // 결정론 경계 2: entry point — v1은 package.json main/bin만(scripts 항목·py __main__은 미지원: 주석·한계 정직 한정 — 검증 지적)
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const anchors = [];
    if (typeof pj.main === "string") anchors.push({ kind: "code", path: pj.main });
    if (pj.bin && typeof pj.bin === "object") for (const v of Object.values(pj.bin)) anchors.push({ kind: "code", path: String(v) });
    if (anchors.length) addNode("(entry) " + (pj.name || "package"), "boundary", ["gate"], anchors.slice(0, 5));
  } catch { /* package.json 없음 — node 프로젝트 아님 */ }
  // 엣지: 디렉터리 수준 imports(정적 의존 — calls/consumes와 구분되는 'imports' 관계: 설계검증)
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
        evidence: [...samples].sort().map((ref) => ({ kind: "code", ref, note: "inventory v1 정적 import" })),
      });
    }
  }
  const topo = {
    schemaVersion: PM.MAP_SCHEMA_VERSION,
    draft: true,
    project: path.basename(root),
    createdAt: now,
    revision: 1,
    nodes, edges,
    inventory: cov,
    freshnessNote: "신선도 판정 미지원(v1 — verifiedHead·내용 지문 판정기는 후속)",
  };
  return topo;
}

// 부재와 손상을 구분(3차 보충: 합치면 status는 '없음'이라 안내하는데 init은 파일 존재로 거부하는 모순 상태).
// ENOENT만 부재 — 권한 등 다른 읽기 실패를 '없음'으로 안내하면 운영 오도(4차 보완).
function readTopoEx() {
  let raw;
  try { raw = fs.readFileSync(TOPO, "utf8"); } catch (e) { return { st: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
  try { return { st: "ok", topo: JSON.parse(raw) }; } catch { return { st: "invalid" }; }
}
// 정본 쓰기 — '검사와 쓰기를 한 잠금 안에서'(검증 지적: 잠금 밖 존재 검사/판독은 check-then-lock 경합 —
// 두 init이 동시에 '없음'을 보고 서로 덮어쓰거나, render가 낡은 스냅샷으로 되돌리는 lost-update).
// inLock 콜백이 잠금 '안'에서 현재 상태를 다시 보고 topology를 반환(null 반환=중단).
function writeCanonicalLocked(inLock) {
  fs.mkdirSync(MAP_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const r = withFileLockStrict(LOCK, () => {
    const topo = inLock();
    if (!topo) return false;
    const tmp = TOPO + ".tmp";
    fs.writeFileSync(tmp, PM.canonicalSerialize(topo), "utf8");
    fs.renameSync(tmp, TOPO);
    fs.writeFileSync(VIEW + ".tmp", PM.renderMapMd(topo), "utf8");
    fs.renameSync(VIEW + ".tmp", VIEW);
    return true;
  });
  if (!r.ok) { console.error(tB("정본 잠금 실패(fail-closed): ", "Canonical lock failed (fail-closed): ") + r.error); process.exit(1); }
  return r.result === true;
}

if (cmd === "inventory") {
  const { files, importsByDir, cov } = collectInventory(repo);
  console.log(tB(`파일 ${cov.filesSeen}개(순회 ${cov.scanComplete ? "완료" : "미완"}) · regex 스캔 ${cov.semantic.scannedSupportedFiles}건(js/ts — 파싱 보장 아님) · 미지원 ${cov.semantic.unsupportedFiles} · 동적 미상 ${cov.semantic.dynamicUnknowns} · 외부/별칭 ${cov.semantic.externalOrAliasSkipped}`, `${cov.filesSeen} file(s) (walk ${cov.scanComplete ? "complete" : "incomplete"}) · regex-scanned ${cov.semantic.scannedSupportedFiles} (js/ts — not full parsing) · unsupported ${cov.semantic.unsupportedFiles} · dynamic unknowns ${cov.semantic.dynamicUnknowns} · external/alias ${cov.semantic.externalOrAliasSkipped}`));
  for (const [fromTop, per] of importsByDir) console.log(`  ${fromTop} → ${[...per.keys()].sort().join(", ")}`);
  process.exit(0);
}
if (cmd === "init") {
  const topo = buildDraft(repo); // 수집은 잠금 밖(길다) — 존재 '검사'와 쓰기는 아래 잠금 안(check-then-lock 경합 봉합)
  const errs = PM.validateTopology(topo);
  if (errs.length) { console.error(tB("스키마 검증 실패:\n", "Schema validation failed:\n") + errs.join("\n")); process.exit(1); }
  const wrote = writeCanonicalLocked(() => {
    if (fs.existsSync(TOPO)) return null; // 잠금 안 재검사 — 동시 init의 덮어쓰기 차단
    return topo;
  });
  if (!wrote) { console.error(tB("이미 topology.json이 있음 — init 재실행은 모든 ID를 재생성해 기존 연결을 끊는다(설계검증). 갱신은 후속 refresh(rename/merge '제안')가 담당.", "topology.json already exists — re-running init would regenerate all IDs and sever existing references. Updates belong to the future refresh (rename/merge proposals).")); process.exit(1); }
  const gc = PM.graphCoverage(topo);
  console.log(tB(`draft topology 생성: 노드 ${topo.nodes.length}(candidate ${gc.nodes.candidate}) · 엣지 ${topo.edges.length} · ${TOPO}`, `Draft topology created: ${topo.nodes.length} node(s) (candidate ${gc.nodes.candidate}) · ${topo.edges.length} edge(s) · ${TOPO}`));
  console.log(tB("⚠ 이 지도는 관측 초안(draft)이다 — 확정층(MAP.md 승인 장부) 권위를 대체하지 않으며, 편집 제안·승인 배선은 후속(v1b).", "⚠ This map is an observational draft — it does not replace the approved stable layer; propose/approve wiring comes later (v1b)."));
  process.exit(0);
}
if (cmd === "status") {
  const rt = readTopoEx();
  if (rt.st === "absent") { console.log(tB("topology 없음 — `init`으로 draft를 만들 수 있다(관측 초안 — 아무것도 강제하지 않음).", "No topology — create a draft with `init` (observational only).")); process.exit(0); }
  if (rt.st === "invalid") { console.error(tB("⚠ topology.json이 존재하지만 JSON 파싱 실패(손상) — init은 덮어쓰지 않는다. 수동 확인(백업·삭제) 후 다시 init.", "⚠ topology.json exists but failed to parse (corrupted) — init will not overwrite it. Inspect (back up / remove) manually, then re-run init.")); process.exit(1); }
  if (rt.st === "unreadable") { console.error(tB("⚠ topology.json 읽기 실패(권한 등 — 부재 아님) — 파일 접근을 확인하라.", "⚠ Failed to read topology.json (permissions etc. — not absent) — check file access.")); process.exit(1); }
  const topo = rt.topo;
  // 검증을 파생 계산보다 먼저 — nodes:{} 같은 schema-invalid에서 graphCoverage/mapHashOf가 TypeError로
  // 죽어 validator 진단이 사용자에게 전달되지 않던 순서 결함(4차 반례)
  const errs = PM.validateTopology(topo);
  if (errs.length) { console.error(tB("⚠ 스키마 위반(파생 계산 생략):\n", "⚠ Schema violations (derived output skipped):\n") + errs.join("\n")); process.exit(1); }
  const gc = PM.graphCoverage(topo);
  console.log(tB(`schema v${topo.schemaVersion} · revision ${topo.revision} · ${topo.draft ? "DRAFT" : "adopted"} · 지문 ${PM.mapHashOf(topo).slice(0, 12)}…`, `schema v${topo.schemaVersion} · revision ${topo.revision} · ${topo.draft ? "DRAFT" : "adopted"} · hash ${PM.mapHashOf(topo).slice(0, 12)}…`));
  console.log(tB(`그래프: 노드 ${topo.nodes.length}(confirmed ${gc.nodes.confirmed}/candidate ${gc.nodes.candidate}/unknown ${gc.nodes.unknown}) · 엣지 ${topo.edges.length}`, `Graph: ${topo.nodes.length} node(s) (confirmed ${gc.nodes.confirmed}/candidate ${gc.nodes.candidate}/unknown ${gc.nodes.unknown}) · ${topo.edges.length} edge(s)`));
  const sm = topo.inventory.semantic;
  console.log(tB(`인벤토리: 파일 ${topo.inventory.filesSeen} · 순회 ${topo.inventory.scanComplete ? "완료" : "미완"} · regex 스캔 ${sm.scannedSupportedFiles}/${sm.scannedSupportedFiles + sm.unsupportedFiles}(파싱 보장 아님) · 동적 미상 ${sm.dynamicUnknowns} · 외부/별칭 ${sm.externalOrAliasSkipped} · 판독 실패 ${(sm.semanticUnreadable || []).length} · ${topo.freshnessNote}`, `Inventory: ${topo.inventory.filesSeen} file(s) · walk ${topo.inventory.scanComplete ? "complete" : "incomplete"} · regex-scanned ${sm.scannedSupportedFiles}/${sm.scannedSupportedFiles + sm.unsupportedFiles} (not full parsing) · dynamic unknowns ${sm.dynamicUnknowns} · external/alias ${sm.externalOrAliasSkipped} · unreadable ${(sm.semanticUnreadable || []).length} · ${topo.freshnessNote}`));
  // catch는 파일 읽기에만 한정 — 렌더 오류까지 삼켜 'MAP.md 없음'으로 오도하지 않는다(6차 지적)
  let mdCur = null;
  try { mdCur = fs.readFileSync(VIEW, "utf8"); } catch { console.log(tB("MAP.md 없음 — `render`로 생성.", "No MAP.md — create it with `render`.")); }
  if (mdCur !== null && mdCur !== PM.renderMapMd(topo)) console.log(tB("⚠ MAP.md가 정본과 불일치(수동 수정 또는 렌더 누락) — `render`로 재생성하라.", "⚠ MAP.md does not match the canonical topology (manual edit or missing render) — re-run `render`."));
  process.exit(0);
}
if (cmd === "render") {
  const wrote = writeCanonicalLocked(() => {
    const rt = readTopoEx(); // 잠금 '안' 재판독 — 잠금 밖 스냅샷으로 낡은 상태를 되돌리는 lost-update 차단(검증 지적)
    if (rt.st === "absent") { console.error(tB("topology 없음 — 먼저 init.", "No topology — run init first.")); return null; }
    if (rt.st === "invalid") { console.error(tB("topology.json 손상(JSON 파싱 실패) — 렌더 중단. 수동 확인 필요.", "topology.json is corrupted (JSON parse failure) — render aborted. Manual inspection required.")); return null; }
    if (rt.st === "unreadable") { console.error(tB("topology.json 읽기 실패(권한 등) — 렌더 중단.", "Failed to read topology.json (permissions etc.) — render aborted.")); return null; }
    const topo = rt.topo;
    const errs = PM.validateTopology(topo);
    if (errs.length) { console.error(tB("스키마 위반으로 렌더 중단:\n", "Render aborted due to schema violations:\n") + errs.join("\n")); return null; }
    return topo;
  });
  if (!wrote) process.exit(1);
  console.log(tB("MAP.md 재생성: ", "MAP.md regenerated: ") + VIEW);
  process.exit(0);
}
console.error(tB(`알 수 없는 명령: ${cmd} (inventory|init|status|render)`, `Unknown command: ${cmd} (inventory|init|status|render)`));
process.exit(2);
