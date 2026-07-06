/*
 * 자료 패키지 빌더 드라이버(Phase 1, 개발용 CLI) — 결정론 수집만 하고 조립은 정본(out/scope-package.js)에 맡긴다.
 * 사용: node scripts/scope-package.js <repo경로> [--json]
 *   기본 출력=탐색자에게 먹일 마크다운(Phase 2 self 팔 실험의 입력). --json이면 구조체 그대로.
 * 수집원(전부 로컬): git status/diff/log(이력) · git grep(바뀐 식별자 역참조, untracked는 제외되므로 diff에 이미 포함) ·
 *   package.json test 체인+tests 글롭 · ~/.codex-bridge/integrity.json 최근 실패 · (있으면) MAP.md/docs/MAP.md.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { extractDiffTokens, buildPackage, renderPackageMarkdown, redactSensitiveDiff, isSensitivePath, PKG_DEFAULTS } = require(path.join(__dirname, "..", "out", "scope-package.js"));
const { parseGitLog, suggest } = require(path.join(__dirname, "..", "out", "scope-ledger.js"));

// 수집 본체 — self/DeepSeek 팔 러너가 require해서 재사용(Phase 2). CLI 실행은 하단 main 가드.
function collectPackage(repo) {
  // safe.directory: 저장소 소유자가 실행 계정과 다른 환경(검증 샌드박스·CI·공유 폴더)에서 git이 'dubious ownership'으로
  // 거부하면 수집기 전체가 죽는다(Codex 실패 재현) → 이 저장소에 한해 신뢰 지시(전역 설정은 안 건드림).
  const safe = "safe.directory=" + String(repo).replace(/\\/g, "/");
  const git = (args) => { const r = spawnSync("git", ["-c", safe, "-C", repo, ...args], { encoding: "utf8", timeout: 30000, windowsHide: true }); return r.status === 0 && !r.error ? String(r.stdout || "") : null; };
  const head = (git(["rev-parse", "HEAD"]) || "").trim();
  if (!head) return collectPackageHistoryless(repo); // 이력(git) 없음 → 무이력 모드 폴백(최근 수정 파일 기준 축소 꾸러미)

// seeds: 작업트리 변경(-z, rename은 새 경로)
const stz = git(["status", "--porcelain", "-z"]) || "";
const toks = stz.split("\0").filter(Boolean);
const seeds = [];
for (let i = 0; i < toks.length; i++) {
  const t = toks[i]; const status = t.slice(0, 2); const p = t.slice(3);
  if (/[RC]/.test(status)) i++;
  if (p && !/\/$/.test(p)) seeds.push(p);
}

// diff: unstaged+staged 합본(untracked 새 파일 내용은 diff에 안 나오나 seed 목록에는 있음 — 정직 한계로 꾸러미 각주가 커버)
// 민감 범주(env/키/토큰류) 파일 섹션은 여기서 제외 — 꾸러미는 외부 탐색자(API)까지 가므로, 토큰 추출 '전'에 잘라
// 비밀값 파편이 역참조 씨앗으로도 새지 않게 한다(§3.2). 제외 목록은 꾸러미에 정직 표기.
const raw = (git(["diff"]) || "") + "\n" + (git(["diff", "--cached"]) || "");
const { text: diffText, excluded: sensitiveExcluded } = redactSensitiveDiff(raw);

// 바뀐 식별자 → 저장소 역참조(git grep -l, tracked 한정) — seed 파일 자신은 제외
const tokens = extractDiffTokens(diffText);
const seedSet = new Set(seeds.map((s) => s.replace(/\\/g, "/").toLowerCase()));
const tokenHits = [];
const droppedTokens = [];
for (const { token } of tokens) {
  const out = git(["grep", "-l", "-F", "--", token]);
  if (out === null) continue;
  const files = out.split(/\r?\n/).filter(Boolean)
    .filter((f) => !seedSet.has(f.replace(/\\/g, "/").toLowerCase()));
  if (!files.length) continue;
  // 편재 필터: 참조 파일이 상한을 넘는 토큰은 '어디에나 있는 말'(test·node류)이라 결합 증거가 안 됨 —
  // 단어 목록 하드코딩 대신 실측(참조 수) 기준으로 제외하고, 제외 사실은 꾸러미에 정직 표기.
  if (files.length > PKG_DEFAULTS.maxGrepFilesPerToken) { droppedTokens.push(token); continue; }
  tokenHits.push({ token, files, truncated: false });
}

// co-change(L0 채굴기 재사용)
const logOut = git(["log", "--no-merges", "--first-parent", "--pretty=format:%H|%ct|%s", "--name-only", "-n", "300"]);
const coChange = logOut ? suggest(parseGitLog(logOut), seeds) : null;

  return buildPackage({ repo, head, seeds, diffText, tokenHits, droppedTokens, coChange, ...collectCommon(repo), sensitiveExcluded });
}

// 공용 수집(테스트 목록·최근 검증 실패·stable MAP) — git 경로와 무이력 경로가 공유.
function collectCommon(repo) {
  // tests: package.json test 체인 + tests/*.test.* 글롭
  const tests = [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    if (pj.scripts && typeof pj.scripts.test === "string") tests.push("npm test  ← " + pj.scripts.test.slice(0, 200));
  } catch { /* package.json 없음 */ }
  try {
    const td = path.join(repo, "tests");
    for (const f of fs.readdirSync(td)) if (/\.test\./.test(f)) tests.push("tests/" + f);
  } catch { /* tests 폴더 없음 */ }

  // 최근 검증 실패/미완(무결성 기록 — 이 repo(workspace) 것만)
  let recentFailures = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex-bridge", "integrity.json"), "utf8"));
    const norm = (p) => path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase();
    recentFailures = (j.events || [])
      .filter((e) => (!e.workspace || norm(e.workspace) === norm(repo)) && (e.kind === "verify-incomplete" || (e.kind === "verdict-nonclean" && e.severity === "error")))
      .slice(-PKG_DEFAULTS.maxFailures)
      .map((e) => ({ ts: e.ts, kind: e.kind, detail: e.detail }));
  } catch { /* 없음 */ }

  // stable MAP(있으면)
  let mapContent = null;
  for (const c of ["docs/MAP.md", "MAP.md"]) {
    try { mapContent = fs.readFileSync(path.join(repo, c), "utf8"); break; } catch { /* 다음 후보 */ }
  }
  return { tests, recentFailures, mapContent };
}

// ── 무이력(비-git) 모드 1단계 — 사용자 결정 2026-07-06: git이 없는 프로젝트도 지도를 만들 수 있어야 한다.
// 대체 규칙: seeds='최근 24시간 내 수정된 파일'(이력이 없어 근사 — 각주로 정직 고지), diff 대신 '지금 내용 발췌',
// 역참조는 git grep 대신 Node 스캔(SCOUT-TRACK §4.1의 설계된 폴백). 함께변경 통계는 원리상 불가(null).
const HL = { windowMs: 24 * 3600 * 1000, maxSeeds: 8, excerptChars: 4000, maxScanFiles: 1500, maxFileBytes: 512 * 1024, maxDepth: 6, scanBudgetBytes: 16 * 1024 * 1024 };
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", "out", ".vscode", ".idea", "__pycache__", ".venv", "venv"]);
const BIN_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|7z|rar|exe|dll|vsix|woff2?|ttf|otf|mp3|mp4|mov|iso|bin|class|pyc|jar|db|sqlite)$/i;

function walkFiles(root) {
  const out = [];
  let capped = false; // 상한 도달 여부 — '자른 것은 잘랐다고 말한다' 원칙(Codex 보완: 큰 폴더에서 과소보고 침묵 방지)
  const walk = (dir, depth) => {
    if (depth > HL.maxDepth) { capped = true; return; }
    if (out.length >= HL.maxScanFiles) { capped = true; return; }
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= HL.maxScanFiles) { capped = true; return; }
      const abs = path.join(dir, it.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (it.isDirectory()) { if (!SKIP_DIRS.has(it.name) && !it.name.startsWith(".")) walk(abs, depth + 1); continue; }
      if (!it.isFile() || BIN_RE.test(it.name) || isSensitivePath(rel)) continue; // 민감 범주는 목록에서부터 제외(전송 안전)
      try { const st = fs.statSync(abs); if (st.size <= HL.maxFileBytes) out.push({ rel, abs, mtime: st.mtimeMs, size: st.size }); } catch { /* 접근 불가 */ }
    }
  };
  walk(root, 0);
  return { files: out, capped };
}

function collectPackageHistoryless(repo) {
  const { files, capped } = walkFiles(repo);
  const now = Date.now();
  const seeds = files.filter((f) => now - f.mtime < HL.windowMs).sort((a, b) => b.mtime - a.mtime).slice(0, HL.maxSeeds);
  // '변경 내용' 대체 = 지금 내용 앞부분 발췌(전후 비교 불가 — 렌더/각주가 정직 고지)
  const excerpts = seeds.map((f) => {
    let t = "";
    try { t = fs.readFileSync(f.abs, "utf8").slice(0, HL.excerptChars); } catch { /* 읽기 불가 */ }
    return "### " + f.rel + " (수정 " + new Date(f.mtime).toISOString() + ")\n" + t;
  }).join("\n\n");
  // 발췌 줄에 +접두를 붙여 diff 토큰 규칙(범주 필터·빈도) 재사용
  const tokens = extractDiffTokens(excerpts.split(/\r?\n/).map((l) => "+" + l).join("\n"));
  // 역참조 스캔 — 최근 파일 우선으로 용량 예산 내에서 1회 로드(토큰×파일 반복 읽기 방지)
  const seedSet = new Set(seeds.map((s) => s.rel.toLowerCase()));
  const pool = files.slice().sort((a, b) => b.mtime - a.mtime);
  const contents = [];
  let budget = HL.scanBudgetBytes;
  for (const f of pool) {
    if (budget <= 0) break;
    try { const t = fs.readFileSync(f.abs, "utf8"); contents.push({ rel: f.rel, text: t }); budget -= t.length; } catch { /* skip */ }
  }
  const scanNote = contents.length < files.length ? `역참조 스캔이 파일 ${contents.length}/${files.length}개만 검토(용량 상한)` : null;
  const tokenHits = [];
  const droppedTokens = [];
  for (const { token } of tokens) {
    const hits = contents.filter((c) => c.text.includes(token)).map((c) => c.rel).filter((r) => !seedSet.has(r.toLowerCase()));
    if (!hits.length) continue;
    if (hits.length > PKG_DEFAULTS.maxGrepFilesPerToken) { droppedTokens.push(token); continue; }
    tokenHits.push({ token, files: hits, truncated: false });
  }
  const pkg = buildPackage({ repo, head: "0000000", seeds: seeds.map((s) => s.rel), diffText: excerpts, tokenHits, droppedTokens, coChange: null, ...collectCommon(repo), sensitiveExcluded: [], historyless: true });
  if (scanNote) pkg.meta.truncations.push(scanNote); // 커버리지 축소는 정직 고지(침묵 절단 금지)
  if (capped) pkg.meta.truncations.push(`파일 탐색이 상한(파일 ${HL.maxScanFiles}개·깊이 ${HL.maxDepth})에 도달 — 일부 파일은 목록에서 빠졌을 수 있음`);
  return pkg;
}

module.exports = { collectPackage };

if (require.main === module) {
  const repo = process.argv[2];
  const asJson = process.argv.includes("--json");
  if (!repo) { console.error("사용: node scripts/scope-package.js <repo경로> [--json]"); process.exit(2); }
  const pkg = collectPackage(repo);
  if (!pkg) { console.error("git 저장소가 아니거나 git 실패"); process.exit(1); }
  process.stdout.write(asJson ? JSON.stringify(pkg, null, 2) : renderPackageMarkdown(pkg));
}
