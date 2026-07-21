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

// ── P3b C-6: 정본 잠금 키=물리 경로(realpath — 정본 1-29)+신·구 이중 잠금(이행 창 봉합) ──────────
// map-pipeline canonicalIdentityFor.physKey(realOf)와 동형이어야 한다(패리티 테스트 잠금) — map-pipeline이
// 이 모듈을 선행 require하므로 역방향 top-level require는 순환. 자체 무순환 구현(realpath 실패=resolve 폴백
// — 잠금 부재보다 보수). junction/symlink 별칭 경로가 서로 다른 잠금을 만들던 반례 봉합.
const MAP_LOCK_DIR = path.join(BRIDGE_DIR, "project-map-locks");
function physKeyOf(repo) { try { return fs.realpathSync(path.resolve(repo)); } catch { return path.resolve(repo); } }
// 구 wsKey 잠금 대상=관측 가능한 등록 별칭 전수(설계 C-6): 입력 resolve·realpath·계약(contracts)·links.json에
// 등록된 workspace/scoutRepo 중 같은 물리 경로인 문자열들. 구 세대 프로세스는 자기가 등록한 ws 문자열로
// 잠그므로 이것이 실측 가능한 최대 집합 — 판독 실패=그 별칭 누락 가능(작성자 정지 게이트가 최종 방어).
function legacyLockKeysFor(repo) {
  const phys = physKeyOf(repo);
  const aliases = new Set([path.resolve(repo), phys]);
  const sameReal = (p) => { try { return typeof p === "string" && p.trim() !== "" && physKeyOf(p) === phys; } catch { return false; } };
  try {
    const cdir = path.join(BRIDGE_DIR, "contracts");
    for (const f of fs.readdirSync(cdir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(cdir, f), "utf8"));
        for (const cand of [o && o.workspace, o && o.scoutRepo]) if (sameReal(cand)) aliases.add(path.resolve(cand));
      } catch { /* 손상 계약 — 그 별칭 누락 가능(정지 게이트가 방어) */ }
    }
  } catch { /* contracts 폴더 없음 */ }
  try {
    const lk = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "links.json"), "utf8"));
    for (const k of Object.keys((lk && lk.byWorkspace) || {})) if (sameReal(k)) aliases.add(path.resolve(k));
  } catch { /* links 없음/손상 */ }
  return [...new Set([...aliases].map((a) => wsKeyFor(a)))].sort();
}
// 잠금 전수 취득 — [신 physKey 잠금 → 구 wsKey 잠금들(정렬)] 순서 고정(모든 신 코드 동일 순서=교착 없음).
// withFileLockStrict 중첩의 합타입을 평탄화해 기존 {ok, result|error} 계약 유지.
function withCtxLocks(ctx, fn) {
  fs.mkdirSync(MAP_LOCK_DIR, { recursive: true });
  const acquire = (i) => {
    if (i >= ctx.LOCKS.length) return { ok: true, result: fn() };
    const r = withFileLockStrict(ctx.LOCKS[i], () => acquire(i + 1));
    return r.ok ? r.result : r;
  };
  return acquire(0);
}

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
// canonical writer 공통 barrier(P2 §C — 활성 pipeline WAL 중 topology·MAP.md·큐 쓰기 금지.
// 판독 실패=fail-closed 차단. P2 내부 writer는 이 함수를 거치지 않고 자기 decisionId WAL만 우회).
function pipelineBarrier(repo) {
  try { require.resolve(path.join(__dirname, "map-pipeline.js")); } catch { return { blocked: false }; } // 파일 자체 부재(구버전)만 우회 — 판별을 resolve로(14차 #5)
  try {
    const MP = require(path.join(__dirname, "map-pipeline.js"));
    const aw = MP.activePipelineWalFor(repo);
    if (aw.st === "active") return { blocked: true, reason: "pipeline-recovery-pending", items: aw.items.map((x) => x.decisionId) };
    if (aw.st === "unreadable") return { blocked: true, reason: "pipeline-wal-unreadable" };
    return { blocked: false };
  } catch { return { blocked: true, reason: "pipeline-barrier-error" }; } // resolve 통과 후 예외=전부 fail-closed(내부 의존성 누락 포함 — 14차 #5)
}
function writeCanonicalLocked(ctx, inLock) {
  const r = withCtxLocks(ctx, () => {
    { const b = pipelineBarrier(ctx.repo); if (b.blocked) return { wrote: false, error: "활성 pipeline WAL(" + (b.items || []).join(",") + ") — recoverWal 선행(" + b.reason + ")" }; } // 잠금 '안' 쓰기 직전 재검사(12차 #4 — check-to-lock 창 봉합)
    const topo = inLock();
    if (!topo) return false;
    fs.mkdirSync(ctx.MAP_DIR, { recursive: true }); // 쓰기 확정 후에만 생성(P1 설계검증: 콜백 중단 경로가 무MAP repo에 빈 폴더를 양산하던 부작용)
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
function runCli(repoArg, cmdArg, extraArgs) {
  const cmd = cmdArg || "status";
  if (!repoArg) { console.error(tB("사용: node scripts/scope-map.js <repo> [inventory|init|status|render|migrate]", "Usage: node scripts/scope-map.js <repo> [inventory|init|status|render|migrate]")); return 2; }
  const repo = path.resolve(repoArg);
  const ctx = ctxFor(repo); // C-6(P3b): 잠금 구성의 단일 출처 — runCli 자체 LOCK 조립 폐기(별칭 이원 잠금 반례 봉합)

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
  if (cmd === "bootstrap") {
    // P1 트리거④ 수동 재시도 — 자동 경로와 달리 failed/blocked도 교체 선점 허용(run-manual).
    // 명시 실행 자체가 동의(1-23) — 영속 표식 기록으로 이후 자동 경로도 열린다.
    const MB = require(path.join(__dirname, "map-bootstrap.js"));
    MB.grantConsent(repo, "manual-cli");
    const code = MB.runChild(repo, true);
    const st = MB.bootstrapStatusFor(repo);
    console.log(tB("bootstrap 결과: ", "bootstrap result: ") + st.state + (st.rs && st.rs.error ? " — " + st.rs.error : ""));
    if (code === 3) {
      if (st.state === "bootstrap-running") return 0; // 진짜 경쟁(타 자식 작업 중)만 정상
      const fu = "node scripts/scope-map.js \"" + repo + "\" force-unlock";
      if (st.state === "state-lock-blocked" && st.lock) {
        console.error(st.lockState === "unreadable"
          ? tB("잠금 파일을 읽을 수 없음: " + st.lock + " — 일시적일 수 있으니 삭제하지 말고 잠시 후 재시도하라(지속되면 접근 권한 확인).", "Lock file cannot be read: " + st.lock + " — may be transient; do not delete it, retry shortly (check permissions if it persists).")
          : st.lockState === "owner-unverified"
          ? tB("잠금 보유자 생존 확인 불가: " + st.lock + " — 삭제하지 말고 잠시 후 재시도하라. 계속되면 OS에서 프로세스 부재 확인 후: " + fu + " --confirm-owner-dead", "Lock holder liveness cannot be verified: " + st.lock + " — do not delete it; retry shortly. If it persists, confirm no such process at the OS level, then run: " + fu + " --confirm-owner-dead")
          : st.lockState === "invalid" || MB.lockNeedsManualDelete(st.lock)
          ? tB("잔존 손상/2차 잠금: " + st.lock + " — 직접 지우지 말고 강제 복구: " + fu + " (죽은 보유자만 즉시 격리, 손상 잠금은 활성 프로세스 부재 확인 후 " + fu + " --confirm-corrupt). 이후 bootstrap 재실행.", "Stale corrupted/secondary lock: " + st.lock + " — do not delete it by hand; run: " + fu + " (dead holders quarantine immediately; corrupted locks need " + fu + " --confirm-corrupt after confirming no process is active), then re-run bootstrap.")
          : st.lockState === "dead-valid" && String(st.lock).endsWith(".funlock")
          ? tB("죽은 강제 복구 잔재: " + st.lock + " — " + fu + " 실행 시 재확인 후 자체 회수된다.", "Dead force-recovery lock: " + st.lock + " — run " + fu + "; it re-verifies and reclaims it.")
          : tB("잔존 회수 잠금: " + st.lock + " — 직접 지우지 말고 이 명령을 다시 실행하라(보유자 사망 재확인 후 안전 회수).", "Stale reclaim lock: " + st.lock + " — do not delete it by hand; re-run this command (it re-verifies the holder is dead and reclaims safely)."));
      } else if (st.state === "state-unreadable") console.error(tB("진행 상태 파일을 읽을 수 없다 — 일시적일 수 있으니 잠시 후 재시도하라(지속되면 접근 권한 확인).", "The bootstrap state file cannot be read — may be transient; retry shortly (check permissions if it persists)."));
      else if (st.state === "state-invalid") console.error(tB("진행 상태 파일이 손상됐다 — 활성 자동 생성이 없음을 확인한 뒤: " + fu + " --confirm-corrupt, 이후 bootstrap 재실행.", "The bootstrap state file is corrupted — confirm no active creation is running, then: " + fu + " --confirm-corrupt, and re-run bootstrap."));
      else console.error(tB("선점 실패 — 현재 상태: " + st.state, "Claim failed — current state: " + st.state)); // 무언 실패 금지
      return 1; // 선점 실패인데 진행 중도 아님 = 복구 안 됨(성공 위장 금지 — 5차 #2)
    }
    return code;
  }
  if (cmd === "force-unlock") {
    // 9차: 강제 복구의 유일 공식 표면 — 승인 사다리(죽은 보유자=즉시 / 손상=--confirm-corrupt / 판별불가=--confirm-owner-dead)
    const MB = require(path.join(__dirname, "map-bootstrap.js"));
    const flags = Array.isArray(extraArgs) ? extraArgs : [];
    const acts = MB.forceUnlock(repo, { corrupt: flags.includes("--confirm-corrupt"), ownerDead: flags.includes("--confirm-owner-dead") });
    if (!acts.length) { console.log(tB("격리할 잠금·손상 상태가 없다.", "No locks or corrupted state to quarantine.")); return 0; }
    let okAll = true;
    for (const a of acts) {
      if (a.quarantined) console.log(tB("격리 완료: " + a.lock + " → " + a.to, "Quarantined: " + a.lock + " → " + a.to));
      else if (a.stolenActive) { okAll = false; console.error(tB("오탈취 감지(" + a.state + "): " + a.lock + " — 그새 교체된 잠금을 이동했다가 " + (a.restored ? "원위치로 복원했다" : "복원하지 못했다(격리 위치: " + a.to + ")") + ". 개입하지 말고 잠시 후 재시도하라.", "Mis-steal detected (" + a.state + "): " + a.lock + " — a replaced lock was moved and " + (a.restored ? "restored in place" : "could NOT be restored (quarantined at: " + a.to + ")") + ". Do not intervene; retry shortly.")); }
      else if (a.needs) { okAll = false; console.error(tB("격리 보류(" + a.state + "): " + a.lock + " — 보유자 사망을 입증할 수 없다. 활성 프로세스가 없음을 직접 확인했다면 " + a.needs + " 를 붙여 재실행하라.", "Held back (" + a.state + "): " + a.lock + " — holder death cannot be proven. If you verified no process is active, re-run with " + a.needs + ".")); }
      else { okAll = false; console.error(tB("격리 거부(" + a.state + "): " + a.lock + " — 보유자가 살아 있거나 판독/판별이 불가하다. 삭제하지 말고 잠시 후 재시도하라.", "Refused (" + a.state + "): " + a.lock + " — the holder may be alive or cannot be read/verified. Do not delete it; retry shortly.")); }
    }
    if (okAll) console.log(tB("이제 bootstrap을 다시 실행하라: node scripts/scope-map.js \"" + repo + "\" bootstrap", "Now re-run: node scripts/scope-map.js \"" + repo + "\" bootstrap"));
    return okAll ? 0 : 1;
  }
  if (["legacy-scan", "binding-confirm", "binding-rebind", "binding-list", "binding-discard"].includes(cmd)) {
    // P3a 바인딩 CLI(§C-4·§D — 수동 전용·2트랙 게이트 최선행·repo 쓰기는 confirm/rebind의 bindings.json뿐)
    const CL3 = require(path.join(__dirname, "contract-lib.js"));
    if (CL3.normScoutMode(CL3.loadContract(repo)) !== "on") { console.error(tB("3트랙(정찰)이 꺼져 있음 — 바인딩 명령은 3트랙 프로젝트 전용(2트랙 무접촉 계약)", "3-track is off — binding commands are 3-track only (two-track no-touch contract)")); return 2; }
    const MB = require(path.join(__dirname, "map-bindings.js"));
    if (cmd === "legacy-scan") {
      const r = MB.scanLegacy(repo);
      console.log(JSON.stringify(r)); return r.ok ? 0 : 1;
    }
    if (cmd === "binding-list") { const r = MB.listBindings(repo); console.log(JSON.stringify(r, null, 1)); return r.ok ? 0 : 1; }
    const fp = (extraArgs || []).find((x) => /^[0-9a-f]{40}$/i.test(x));
    if (!fp) { console.error(tB("사용법: " + cmd + " <candidateFp(40hex)> [--target <uuid>]", "usage: " + cmd + " <candidateFp(40hex)> [--target <uuid>]")); return 2; }
    const ti = (extraArgs || []).indexOf("--target");
    const target = ti >= 0 ? (extraArgs || [])[ti + 1] : ((extraArgs || []).find((x) => x.startsWith("--target=")) || "").slice(9) || null;
    if (cmd === "binding-confirm") { const r = MB.confirmBinding(repo, fp, { target }); console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
    if (cmd === "binding-rebind") { const r = MB.rebindBinding(repo, fp, { target }); console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
    if (cmd === "binding-discard") { const r = MB.discardCandidate(repo, fp); console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
  }
    if (["propose", "classify", "apply", "recover", "abort", "gc", "pipeline-status", "recover-corruption"].includes(cmd)) {
    // P2 pipeline CLI(§A 비활성 계약: 수동 전용·2트랙 게이트 최선행)
    const CL2 = require(path.join(__dirname, "contract-lib.js"));
    if (CL2.normScoutMode(CL2.loadContract(repo)) !== "on") { console.error(tB("3트랙(정찰)이 꺼져 있음 — pipeline 명령은 3트랙 프로젝트 전용(2트랙 무접촉 계약)", "3-track is off — pipeline commands are 3-track only (two-track no-touch contract)")); return 2; }
    const MP = require(path.join(__dirname, "map-pipeline.js"));
    const rt0 = readTopoExFor(repo);
    const mapIdArgRaw = ((extraArgs || []).find((x) => x.startsWith("--map=")) || "").slice(6) || null;
    const mapIdArg = mapIdArgRaw && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mapIdArgRaw) ? mapIdArgRaw : null; // UUID 강제(경로 이탈 차단 — 13차 #8)
    if (mapIdArgRaw && !mapIdArg) { console.error(tB("--map 값이 UUID가 아님", "--map must be a UUID")); return 2; }
    const uuidOk = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
    const mapId = rt0.st === "ok" && uuidOk(rt0.topo.mapId) ? rt0.topo.mapId : mapIdArg; // parse만 되는 손상 topology의 mapId 경로 이탈 차단(14차 #6)
    if (!mapId) { console.error(tB("mapId 확인 불가(topology " + rt0.st + ") — 인자로 mapId를 명시하라", "cannot resolve mapId (topology " + rt0.st + ") — pass mapId explicitly")); return 1; }
    if (cmd === "propose") {
      const file = (extraArgs || []).find((x) => x.endsWith(".json"));
      if (!file) { console.error(tB("사용법: propose <patch.json>", "usage: propose <patch.json>")); return 2; }
      let patch; try { patch = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { console.error(tB("patch 파일 판독 실패", "cannot read patch file")); return 1; }
      const r = MP.proposePatch(repo, patch);
      console.log(JSON.stringify(r)); return r.ok ? 0 : 1;
    }
    if (cmd === "classify") {
      const pid = (extraArgs || []).find((x) => /^[0-9a-f-]{36}$/i.test(x));
      if (!pid) { console.error("usage: classify <patchId>"); return 2; }
      const r = MP.classifyPatch(repo, mapId, pid);
      console.log(JSON.stringify(r)); return r.ok ? 0 : 1;
    }
    if (cmd === "apply") {
      const pid = (extraArgs || []).find((x) => /^[0-9a-f-]{36}$/i.test(x));
      if (!pid) { console.error("usage: apply <patchId> --pre-cutover"); return 2; }
      const r = MP.applyPatch(repo, mapId, pid, { preCutover: (extraArgs || []).includes("--pre-cutover") });
      console.log(JSON.stringify(r)); return r.ok ? 0 : 1;
    }
    if (cmd === "recover") { const r = MP.recoverWal(repo, mapId); console.log(JSON.stringify(r, null, 1)); return r.every((x) => x.verdict === "recovered" || x.verdict === "not-started") ? 0 : 1; }
    if (cmd === "abort") {
      const did = (extraArgs || []).find((x) => /^[0-9a-f-]{36}$/i.test(x));
      if (!did) { console.error("usage: abort <decisionId>"); return 2; }
      const r = MP.abortWal(repo, mapId, did); console.log(JSON.stringify(r)); return r.ok ? 0 : 1;
    }
    if (cmd === "gc") { const r = MP.pipelineGc(repo, mapId); console.log(JSON.stringify(r)); return r.ok ? 0 : 1; } // 성공 위장 금지(16차 #2)
    if (cmd === "recover-corruption") { const r = MP.recoverCorruption(repo, mapId); console.log(JSON.stringify(r)); return r.ok ? 0 : 1; }
    if (cmd === "pipeline-status") {
      const aw = MP.activePipelineWalFor(repo);
      const idx = MP.decisionIndexFor(repo, mapId);
      console.log(JSON.stringify({ wal: aw.st, active: aw.st === "active" ? aw.items.map((x) => x.decisionId) : [], decisions: idx.st === "ok" ? idx.projections.length : idx.st }, null, 1));
      return 0;
    }
  }
  console.error(tB(`알 수 없는 명령: ${cmd} (inventory|init|status|render|migrate|bootstrap|force-unlock|propose|classify|apply|recover|abort|gc|pipeline-status|legacy-scan|binding-confirm|binding-rebind|binding-list|binding-discard)`, `Unknown command: ${cmd}`));
  return 2;
}

// ── P1 bootstrap용 구조 API(설계검증 #3: runCli exit 코드의 일반화 금지 — 실패 종류를 합타입으로) ──
function ctxFor(repo) {
  const r = path.resolve(repo);
  const MAP_DIR = path.join(r, "project-map");
  // C-6(P3b): 신 물리 키 잠금("phys-" 접두 — 구 wsKey 파일명과 네임스페이스 분리)+구 wsKey 잠금(등록 별칭
  // 전수·정렬). LOCK은 신 키 단일(진단·표시용) — 실제 취득은 LOCKS 전체(withCtxLocks).
  const physLock = path.join(MAP_LOCK_DIR, "phys-" + crypto.createHash("sha1").update(physKeyOf(r)).digest("hex").slice(0, 16) + ".lock");
  const legacyLocks = legacyLockKeysFor(r).map((k) => path.join(MAP_LOCK_DIR, k + ".lock"));
  return { repo: r, MAP_DIR, TOPO: path.join(MAP_DIR, "topology.json"), VIEW: path.join(MAP_DIR, "MAP.md"), LOCK: physLock, LOCKS: [physLock, ...legacyLocks.filter((l) => l !== physLock)] };
}
function readTopoExFor(repo) { return readTopoEx(ctxFor(repo).TOPO); }
// P1 4차: bootstrap의 완료 트랜잭션이 init·render와 '같은 정본 잠금'을 쓰게 노출 — 잠금 안 단일 스냅샷으로
// MAP 정합·큐·지문·run-state 재료를 결속(잠금 밖 재판독들이 서로 다른 topology 세대를 섞던 반례 차단).
function withMapLock(repo, fn) {
  return withCtxLocks(ctxFor(repo), fn); // C-6: 신·구 이중 잠금 전수 취득(합타입 {ok, result|error} 불변)
}
function renderFor(repo) { return runCli(repo, "render") === 0; }
// 반환 st: created | already-valid | already-v1 | already-invalid | already-unreadable | basis-changed |
//          schema-failed | lock-failed | exists-race(잠금 안에서 타자가 먼저 생성)
function initTopologyForBootstrap(repo, opts) {
  const ctx = ctxFor(repo);
  const pre = readTopoEx(ctx.TOPO);
  if (pre.st === "ok") {
    if (pre.topo && pre.topo.schemaVersion === 1) return { st: "already-v1" };
    const errs0 = PM.validateTopology(pre.topo);
    return errs0.length ? { st: "already-invalid", error: errs0[0] } : { st: "already-valid", mapId: pre.topo.mapId };
  }
  if (pre.st === "invalid") return { st: "already-invalid", error: "JSON 파싱 실패" };
  if (pre.st === "unreadable") return { st: "already-unreadable" };
  const topo = buildDraft(repo); // 수집은 잠금 밖(길다)
  const errs = PM.validateTopology(topo);
  if (errs.length) return { st: "schema-failed", error: errs[0] };
  let raceLost = false, basisChanged = false;
  const w = writeCanonicalLocked(ctx, () => {
    if (fs.existsSync(ctx.TOPO)) { raceLost = true; return null; } // 잠금 안 존재 재검사(동시 init 최종 방어)
    if (opts && typeof opts.basisCheck === "function" && !opts.basisCheck()) { basisChanged = true; return null; } // 쓰기 직전 브랜치/워크트리 경계 재확인(설계검증 #5)
    return topo;
  });
  if (w.lockFailed) return { st: "lock-failed" };
  if (basisChanged) return { st: "basis-changed" };
  if (raceLost) {
    const post = readTopoEx(ctx.TOPO); // 경합 승자의 산출물 확인
    if (post.st === "ok" && PM.validateTopology(post.topo).length === 0) return { st: "already-valid", mapId: post.topo.mapId };
    return { st: "already-invalid", error: "경합 승자의 topology가 유효하지 않음" };
  }
  if (!w.wrote) return { st: "lock-failed" };
  return { st: "created", mapId: topo.mapId, topoFp: crypto.createHash("sha1").update(PM.canonicalSerialize(topo)).digest("hex"), mapMdFp: crypto.createHash("sha1").update(PM.renderMapMd(topo)).digest("hex") }; // 생성 지문(P1 5차: finish 시점 지문과 대조해야 사이 편집분을 자동물로 오귀속하지 않음
}

module.exports = { runCli, collectInventory, buildDraft, readTopoEx, readTopoExFor, renderFor, initTopologyForBootstrap, ctxFor, withMapLock, pipelineBarrier, physKeyOf, legacyLockKeysFor, PM }; // physKeyOf·legacyLockKeysFor: P3b C-6 패리티·잠금 테스트용 노출
