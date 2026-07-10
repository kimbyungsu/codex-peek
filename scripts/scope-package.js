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
const { parseEventsJsonl, deriveLedger, selectForPackage } = require(path.join(__dirname, "..", "out", "ledger-events.js"));
const { readLedgerEventsText, appendLedgerEvent, loadLang, INTEGRITY_FILE, CONTRACTS_DIR } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

// 관측 장부 선별 — 이벤트(append-only)에서 상태를 유도해 씨앗 관련·신뢰 차선 위주로 꾸러미에 동봉할 몫만 고른다.
// 장부가 없거나 읽기 실패면 null(주입 0) — 장부 문제가 꾸러미 생성을 막지 않는다.
// 동봉된 항목은 'attached' 이벤트로 적재 — 이후 지도/검증이 이 항목을 되읊어도 '주입분 메아리'를
// 강화 신호에서 제외할 수 있게(자기강화 순환 차단의 재료 — 판정은 확인 신호 배선 단계에서).
function ledgerForPackage(repo, seeds) {
  try {
    const raw = readLedgerEventsText(repo);
    if (!raw.trim()) return null;
    const sel = selectForPackage(deriveLedger(parseEventsJsonl(raw).events), seeds || []);
    try {
      const now = new Date().toISOString();
      for (const e of [].concat(sel.trusted, sel.reference, sel.disputed)) appendLedgerEvent(repo, { ts: now, type: "attached", sig: e.sig, from: "package" });
    } catch { /* 적재 실패 무해 */ }
    return sel;
  } catch { return null; }
}

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
// 신선도 기준선 — seed '확정 직후' 캡처(러너가 AI 응답 뒤 재조사하면 diff 수집~응답 사이 삭제/복원이 오분류 —
// Codex 반례 2026-07-10). basisTs=이 시점(이후 mtime 변경은 전부 신호), seedMissing='없음'을 ENOENT만으로 판정
// (접근 오류를 없음으로 확정 금지 — 그 외 오류면 seedMissing만 생략·basisTs는 유지[삭제 판정만 불가]).
const baseline = captureSeedBaseline(repo, seeds);

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

  const pkg = buildPackage({ repo, head, seeds, diffText, tokenHits, droppedTokens, coChange, ...collectCommon(repo), ledger: ledgerForPackage(repo, seeds), sensitiveExcluded });
  if (pkg && pkg.meta) Object.assign(pkg.meta, baseline); // 러너가 지도 메타로 그대로 저장(scoutMapStatus의 신선도 기준)
  return pkg;
}

// 신선도 기준선 캡처 — seed 확정 직후 1회. 기준 시각(basisTs)은 stat 순회 '전' 확보해 항상 반환 —
// 순회 오류로 시각까지 버리면 판독기가 저장 시각(ts)으로 폴백해 AI 응답 대기 중 변경이 fresh로 숨는다(Codex 반례).
// '없음'은 ENOENT만, 그 외 오류(EACCES/ENOTDIR류)는 seedMissing만 생략(삭제 판정만 불가 — mtime 신호는 유지).
function captureSeedBaseline(repo, seeds) {
  const basisTs = new Date().toISOString();
  try {
    const missing = [];
    const hashes = {};
    for (const sd of (seeds || [])) {
      try {
        const abs = path.join(repo, sd);
        const st0 = fs.statSync(abs);
        // 내용 지문(L1-C: 빌드가 mtime만 바꾼 '거짓 stale' 판별용). 부분 해시 금지 — 앞부분만 해시하면 그 뒤만
        // 바뀐 파일이 거짓 fresh(Codex 반례). 예산(2MB) 이내만 '전체' 해시, 초과는 미기록(신선도는 mtime 판정 유지).
        // 해시 도중 파일이 바뀌면(전후 stat 불일치) 지문을 남기지 않는다(오염 지문 방지).
        if (st0.size <= 2 * 1024 * 1024) {
          try {
            const h = require("crypto").createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
            const st1 = fs.statSync(abs);
            if (st1.size === st0.size && st1.mtimeMs === st0.mtimeMs) hashes[sd] = h;
          } catch { /* 지문 실패는 그 seed만 미기록(mtime 판정 유지) — 기준선 전체를 버리지 않음 */ }
        }
      } catch (e) { if (e && e.code === "ENOENT") missing.push(sd); else throw e; }
    }
    return { basisTs, seedMissing: missing, seedHashes: hashes };
  } catch { return { basisTs }; }
}

// 공용 수집(테스트 목록·최근 검증 실패·stable MAP) — git 경로와 무이력 경로가 공유.
function collectCommon(repo) {
  // tests: node 관행(package.json test 체인 + tests/*.test.* 글롭) + pytest 관행(test_*.py·*_test.py·conftest/pytest.ini)
  // — 대형 Python 서비스 실측(2026-07-08, tg-chat-engine)에서 pytest 테스트 다수를 '없음'으로 오보하던 결함.
  // 생태계 무한 나열은 안 함(실사용 범위 node+python) — 그 외 관행은 blindSpots가 정직 고지.
  const tests = [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    if (pj.scripts && typeof pj.scripts.test === "string") tests.push("npm test  ← " + pj.scripts.test.slice(0, 200));
  } catch { /* package.json 없음 */ }
  for (const dir of ["tests", "test"]) {
    try {
      const names = fs.readdirSync(path.join(repo, dir));
      for (const f of names) if (/\.test\./.test(f) || /^test_.*\.py$/.test(f) || /_test\.py$/.test(f)) tests.push(dir + "/" + f);
      if (names.includes("conftest.py")) tests.push("pytest  ← " + dir + "/conftest.py 실재");
    } catch { /* 폴더 없음 */ }
  }
  try { if (fs.existsSync(path.join(repo, "pytest.ini"))) tests.push("pytest  ← pytest.ini 실재"); } catch { /* 무해 */ }
  try { if (/\[tool\.pytest/.test(fs.readFileSync(path.join(repo, "pyproject.toml"), "utf8"))) tests.push("pytest  ← pyproject.toml [tool.pytest]"); } catch { /* 없음 */ }
  if (tests.length > 40) { const n = tests.length; tests.length = 40; tests.push(`(…외 ${n - 40}개 — 상한 절단)`); }

  // 최근 검증 실패/미완(무결성 기록) — 이 repo '소유' ws들의 것(P1-③ 귀속, 감사 2026-07-10): 실패는 '연 폴더(ws)'
  // 소유로 기록되는데 종전 필터는 repo 키만 봐서, 세션 폴더≠개발 레포 구성에선 지도의 핵심 입력(최근 실패)이
  // 영영 안 실렸다. 소유 ws = repo 자신 + 계약(scoutRepo)이 이 repo를 가리키는 모든 세션 폴더(계약 폴더 역추적).
  // 경로도 os.homedir 하드코딩 → CODEX_BRIDGE_HOME 존중(INTEGRITY_FILE)으로 교정(테스트 격리·이식성).
  let recentFailures = [];
  try {
    const j = JSON.parse(fs.readFileSync(INTEGRITY_FILE, "utf8"));
    const norm = (p) => path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase();
    const owners = new Set([norm(repo)]);
    try {
      for (const f of fs.readdirSync(CONTRACTS_DIR)) {
        if (!f.endsWith(".json")) continue;
        try {
          const o = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8"));
          if (o && typeof o.scoutRepo === "string" && o.scoutRepo.trim() && norm(o.scoutRepo) === norm(repo) && typeof o.workspace === "string" && o.workspace.trim()) owners.add(norm(o.workspace));
        } catch { /* 깨진 계약 — 무시 */ }
      }
    } catch { /* contracts 폴더 없음 */ }
    recentFailures = (j.events || [])
      .filter((e) => (e.workspace && owners.has(norm(e.workspace))) && (e.kind === "verify-incomplete" || (e.kind === "verdict-nonclean" && e.severity === "error"))) // 무귀속(workspace 없는 구버전) 이벤트는 제외 — 타 프로젝트 꾸러미 혼입 방지(과소 포함이 과대 혼입보다 안전·PRIVACY 고지와 정합, Codex 반례)
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

// ── 무이력(비-git) 모드 — 사용자 결정 2026-07-06: git이 없는 프로젝트도 지도를 만들 수 있어야 한다.
// 대체 규칙: seeds=작업 신호 계단(물때표[마지막 지도 이후 수정] 우선 → 첫 지도면 세션 편집 파일 → 최근 수정 상위 N —
// 시간 창 상수 없음), diff 대신 '지금 내용 발췌', 역참조는 git grep 대신 Node 스캔(§4.1의 설계된 폴백). 함께변경 통계는 원리상 불가(null).
const HL = { maxSeeds: 8, excerptChars: 4000, maxScanFiles: 1500, maxFileBytes: 512 * 1024, maxDepth: 6, scanBudgetBytes: 16 * 1024 * 1024, transcriptTailBytes: 8 * 1024 * 1024, maxTranscripts: 6 };
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

// Claude Code 대화 기록에서 '이 폴더 하위를 편집한 도구 호출' 파일 경로를 뽑는다 — 작업 흐름 그 자체(1순위 신호).
// 한계(정직 고지): 터미널(Bash) 편집·외부 프로그램 저장은 안 잡힘, 대형 기록은 끝부분(tail)만 읽음.
function collectSessionEditedFiles(repo) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const rnorm = path.normalize(repo).replace(/[\\/]+$/, "").toLowerCase();
  const jsonls = [];
  try {
    const walk = (d, depth) => {
      if (depth > 3) return;
      for (const it of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, it.name);
        if (it.isDirectory()) walk(full, depth + 1);
        else if (it.name.endsWith(".jsonl") && !it.name.startsWith("agent-")) { try { jsonls.push({ f: full, m: fs.statSync(full).mtimeMs }); } catch { /* skip */ } }
      }
    };
    walk(path.join(home, "projects"), 0);
  } catch { return []; }
  jsonls.sort((a, b) => b.m - a.m);
  const out = new Set();
  for (const { f } of jsonls.slice(0, HL.maxTranscripts)) { // 최근 기록 몇 개만 — 다른 프로젝트 기록은 cwd로 걸러짐
    let raw = "";
    try {
      const st = fs.statSync(f);
      const start = Math.max(0, st.size - HL.transcriptTailBytes);
      const fd = fs.openSync(f, "r");
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      raw = buf.toString("utf8");
    } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.includes('"file_path"')) continue; // 싼 사전 필터(대부분 줄 스킵)
      let o; try { o = JSON.parse(line.trim()); } catch { continue; } // tail 절단 줄은 무시
      const cwd = path.normalize(String(o.cwd || "")).replace(/[\\/]+$/, "").toLowerCase();
      if (!cwd || (cwd !== rnorm && !cwd.startsWith(rnorm + path.sep))) continue;
      const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const c of content) {
        if (!c || c.type !== "tool_use" || !/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name || "")) continue;
        const fp = c.input && typeof c.input.file_path === "string" ? c.input.file_path : "";
        if (!fp) continue;
        const fnorm = path.normalize(fp).replace(/[\\/]+$/, "");
        if (!fnorm.toLowerCase().startsWith(rnorm + path.sep)) continue;
        out.add(path.relative(repo, fnorm).replace(/\\/g, "/"));
      }
    }
  }
  return [...out];
}

function collectPackageHistoryless(repo) {
  const { files, capped } = walkFiles(repo);
  // seeds 계단 — 시간 창 없음(사용자 지적: '최근 24h'는 두뇌설정 15분 사건과 같은 맹목 상수·개발 흐름과 직결):
  // ①물때표(마지막 지도 이후 수정 — 지도마다 기준 자동 갱신·세션/외부 편집 모두 포착, 세션 편집 파일은 정렬 우선)
  // → ②(첫 지도) Claude 세션이 실제 편집한 파일 → ③(신호 전무) 최근 수정 '상위 N개'. 어느 계단인지 꾸러미 1절에 명시(basisNote).
  const byRel = new Map(files.map((f) => [f.rel.toLowerCase(), f]));
  let seeds = [];
  let basisNote = "";
  let basisTrunc = null;
  const sessionSet = new Set(collectSessionEditedFiles(repo).map((r) => r.toLowerCase()));
  let lastMapTs = 0;
  try { const l = require("./scout-store.js").listMaps(repo, 1); if (l.length && l[0].ts) lastMapTs = Date.parse(l[0].ts) || 0; } catch { /* 보관함 없음 */ }
  if (lastMapTs) {
    // 물때표가 항상 우선 기준 — 세션 편집 신호는 시각이 없어(대화 기록에 경로만) 이것만 믿으면 옛 편집 파일이
    // 물때표를 영구 우회하고, 외부 편집기·터미널로 고친 새 파일이 빠진다(Codex 반례). mtime>물때표가 전 편집 경로를
    // 포착하고, 세션 편집 파일은 정렬 우선순위(작업 흐름 힌트)로만 쓴다.
    seeds = files.filter((f) => f.mtime > lastMapTs);
    basisNote = seeds.length
      ? "마지막 영향지도 생성 이후 수정된 파일(물때표" + (seeds.some((f) => sessionSet.has(f.rel.toLowerCase())) ? " · Claude 세션 편집 파일 우선" : "") + ")"
      : "마지막 영향지도 이후 수정된 파일 없음";
    seeds.sort((a, b) => (Number(sessionSet.has(b.rel.toLowerCase())) - Number(sessionSet.has(a.rel.toLowerCase()))) || b.mtime - a.mtime);
  } else if (sessionSet.size) {
    seeds = files.filter((f) => sessionSet.has(f.rel.toLowerCase()));
    basisNote = "Claude 세션이 이 폴더에서 실제 편집한 파일(대화 기록의 편집 도구 호출 — 첫 지도라 물때표 없음)";
    basisTrunc = "세션 편집 신호는 대화 기록 끝부분(파일당 8MB·최근 기록 6개)만 검토 — 그 이전/터미널 편집은 누락 가능";
    seeds.sort((a, b) => b.mtime - a.mtime);
  } else {
    seeds = files.slice().sort((a, b) => b.mtime - a.mtime);
    basisNote = "최근 수정 순 상위(첫 지도 — 세션·지도 기준 없음)";
  }
  seeds = seeds.slice(0, HL.maxSeeds);
  const baseline = captureSeedBaseline(repo, seeds.map((f) => f.rel)); // seed 확정 직후(발췌·스캔 수집 전) — git 경로와 동일 계약
  // 비-git 삭제 감지 기준선(L1-C·Codex 3차 #3): seed '확정 직후'(basisTs와 같은 시점)에 캡처 — 발췌·꾸러미 구성
  // 뒤로 미루면 그 사이 삭제가 지도 입력엔 있는데 기준선엔 없어 저장 직후 삭제를 못 잡는다(기준선 시점 경쟁).
  try { const { nonGitChangedSince, normWs } = require(path.join(__dirname, "..", "bridge", "contract-lib.js")); const seedAbs = new Set(seeds.map((f) => normWs(path.join(repo, f.rel)))); const inv = nonGitChangedSince(repo, Number.MAX_SAFE_INTEGER, seedAbs); baseline.nonGitFiles = { n: inv.files, complete: inv.complete }; } catch { /* 기준선 실패 — 삭제 감지만 비활성(무해) */ }
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
  const pkg = buildPackage({ repo, head: "0000000", seeds: seeds.map((s) => s.rel), diffText: excerpts, tokenHits, droppedTokens, coChange: null, ...collectCommon(repo), ledger: ledgerForPackage(repo, seeds.map((s) => s.rel)), sensitiveExcluded: [], historyless: true, basisNote });
  Object.assign(pkg.meta, baseline); // 신선도 기준선(basisTs·seedMissing) — 러너가 지도 메타로 저장
  if (basisTrunc) pkg.meta.truncations.push(basisTrunc);
  if (scanNote) pkg.meta.truncations.push(scanNote); // 커버리지 축소는 정직 고지(침묵 절단 금지)
  if (capped) pkg.meta.truncations.push(`파일 탐색이 상한(파일 ${HL.maxScanFiles}개·깊이 ${HL.maxDepth})에 도달 — 일부 파일은 목록에서 빠졌을 수 있음`);
  return pkg;
}

module.exports = { collectPackage, captureSeedBaseline };

if (require.main === module) {
  const repo = process.argv[2];
  const asJson = process.argv.includes("--json");
  if (!repo) { console.error("사용: node scripts/scope-package.js <repo경로> [--json]"); process.exit(2); }
  const pkg = collectPackage(repo);
  if (!pkg) { console.error("git 저장소가 아니거나 git 실패"); process.exit(1); }
  process.stdout.write(asJson ? JSON.stringify(pkg, null, 2) : renderPackageMarkdown(pkg, loadLang()));
}
