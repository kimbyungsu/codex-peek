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
const { extractDiffTokens, buildPackage, renderPackageMarkdown, PKG_DEFAULTS } = require(path.join(__dirname, "..", "out", "scope-package.js"));
const { parseGitLog, suggest } = require(path.join(__dirname, "..", "out", "scope-ledger.js"));

const repo = process.argv[2];
const asJson = process.argv.includes("--json");
if (!repo) { console.error("사용: node scripts/scope-package.js <repo경로> [--json]"); process.exit(2); }
const git = (args) => { const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 30000, windowsHide: true }); return r.status === 0 && !r.error ? String(r.stdout || "") : null; };

const head = (git(["rev-parse", "HEAD"]) || "").trim();
if (!head) { console.error("git 저장소가 아니거나 git 실패"); process.exit(1); }

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
const diffText = (git(["diff"]) || "") + "\n" + (git(["diff", "--cached"]) || "");

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

// tests: package.json test 체인 + tests/*.test.* 글롭
let tests = [];
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

const pkg = buildPackage({ repo, head, seeds, diffText, tokenHits, droppedTokens, coChange, tests, recentFailures, mapContent });
process.stdout.write(asJson ? JSON.stringify(pkg, null, 2) : renderPackageMarkdown(pkg));
