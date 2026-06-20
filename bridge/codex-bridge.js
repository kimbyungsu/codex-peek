#!/usr/bin/env node
// Claude ↔ Codex 브릿지 (일시 대체제)
// - 연결 정보를 영속 저장(Claude 세션id + 워크스페이스 키) → 내 기억과 무관하게 유지.
// - ask: 연결된 Codex 세션으로 resume. 연결 없으면 "보고만"(새 세션 안 만듦). 첫 소통은 --allow-new로 명시 생성.
// - 정책은 스크립트가 강제하고, raw codex 직접호출은 PreToolUse 후크(codex-guard.js)가 차단한다.
//
// 사용:
//   node codex-bridge.js ask "<프롬프트>"          연결된 세션에 보내고 답 받기 (없으면 보고)
//   node codex-bridge.js ask --allow-new "<...>"   연결 없을 때 새 세션 생성+연결 후 보내기 (첫 소통)
//   node codex-bridge.js link <codex-session-id>   현재 Claude 세션을 기존 Codex 세션에 연결
//   node codex-bridge.js link --last               가장 최근(인덱스된) Codex 세션에 연결
//   node codex-bridge.js status                    현재 연결 상태
//   node codex-bridge.js find                       연결 후보(인덱스된 Codex 세션) 목록

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, buildInjection, loadBaseDirective } = require("./contract-lib.js");

// 사용자 요청 앞에 [검증 기본 원칙](기본 지침, 오버라이드 가능) + Codex 고정 계약을 prepend(매 ask마다).
// 기본 지침은 contract-lib의 loadBaseDirective()에서 로드 → 대시보드에서 보기/수정/초기화 가능. 코드에 캐논 기본값 상존.
function withContract(prompt) {
  const baseline = loadBaseDirective().verifyBaseline;
  let inj = "";
  try {
    const c = loadContract();
    inj = buildInjection(c.codex, "Codex", c.codexChecklist);
  } catch {
    inj = "";
  }
  const head = inj ? `${baseline}\n\n${inj}` : baseline;
  return `${head}\n\n---\n[작업 요청]\n${prompt}`;
}

const HOME = os.homedir();
const BRIDGE_DIR = path.join(HOME, ".codex-bridge");
// codex가 실제 쓰는 home을 확장이 'codex doctor'로 탐지해 적어둔 값(바이너리 codex-bin.txt 대칭).
// → CODEX_HOME 미설정/비표준 home·다중설치에서도 세션 폴더를 정확히 찾는다(V11). 없으면 ~/.codex 폴백.
function readPinnedHome() {
  try {
    const p = fs.readFileSync(path.join(BRIDGE_DIR, "codex-home.txt"), "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}
const CODEX_HOME = process.env.CODEX_HOME || readPinnedHome() || path.join(HOME, ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const LINKS_FILE = path.join(BRIDGE_DIR, "links.json");
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function nowIso() {
  return new Date().toISOString();
}
function claudeId() {
  return process.env.CLAUDE_CODE_SESSION_ID || "";
}
function workspace() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
// 워크스페이스 키 정규화(대소문자/구분자/끝슬래시 차이 흡수) — 브릿지·확장 일치용.
function normWs(p) {
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase();
}
function lookupWorkspace(links, ws) {
  const n = normWs(ws);
  for (const k of Object.keys(links.byWorkspace || {})) {
    if (normWs(k) === n) return links.byWorkspace[k];
  }
  return null;
}

// 경로 하나를 실행형으로 포장: .js 런처면 node로 실행, 네이티브면 그대로 exec.
function wrapCodexPath(p, how) {
  if (/\.js$/i.test(p)) return { file: process.execPath, args: [p], how };
  if (/\.(cmd|bat)$/i.test(p)) return { file: p, args: [], how, shell: true }; // win 셰임(.cmd/.bat)은 셸 경유 필요
  return { file: p, args: [], how };
}

// codex-peek 확장이 기록해 둔 codex 실행 경로. 확장이 vscode API로 '사용자가 실제 쓰는 codex'
// (설정 지정값 또는 설치된 Codex 확장 내부)를 활성화 때마다 찾아 적는다.
// → 포터블/설치형·버전 폴더 변경과 무관하게 항상 현재 위치(자동추적 = 범용성·편의성의 핵심).
function readPinnedCodex() {
  try {
    const p = fs.readFileSync(path.join(BRIDGE_DIR, "codex-bin.txt"), "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}

// codex 실행 방법 해석. 반환 { file, args, how, shell? } → spawn(file, [...args, ...], { shell, input }).
// 우선순위(전부 override·doctor 표시 가능):
//   1) CODEX_BIN(env)       — 비-VSCode/CLI 에서 직접 지정
//   2) codex-bin.txt(확장)  — 사용자 설정값 또는 자동탐색 결과(포터블/설치형·버전 무관)
//   3) PATH 의 codex         — CLI 설치 표준(win은 셸로 .cmd/PATHEXT 해석; 프롬프트는 stdin이라 따옴표 안전)
// 경로를 직접 뒤지지 않는다 — 위치 추적은 확장이 vscode API로 담당(설치형태/버전에 안 깨짐).
function resolveCodex() {
  const isWin = process.platform === "win32";
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return wrapCodexPath(process.env.CODEX_BIN, "CODEX_BIN");
  const pinned = readPinnedCodex();
  if (pinned) return wrapCodexPath(pinned, "vscode-ext");
  return { file: "codex", args: [], how: "PATH", shell: isWin };
}

// codex가 실제 쓰는 home을 'codex doctor'로 탐지해 codex-home.txt에 기록(바이너리 자동추적 대칭).
// doctor 출력의 "CODEX_HOME   <경로> (dir)" 줄을 파싱. sessions = home/sessions.
function detectCodexHome() {
  const inv = resolveCodex();
  const r = spawnSync(inv.file, [...inv.args, "doctor"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1000 * 30,
    windowsHide: true,
    encoding: "utf8",
    shell: !!inv.shell,
  });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  // 줄 단위 앵커: 'CODEX_HOME  <경로> (dir)' 한 줄만 잡음(줄바꿈·다른 (dir) 줄 오탐 방지).
  // ⚠ 세션찾기 고장 시 1순위 점검: codex 업데이트로 doctor 출력 형식이 바뀌면 이 정규식이 안 맞아 home 탐지가 깨진다.
  const m = out.match(/^\s*CODEX_HOME\s+([^\r\n]+?)\s*\(dir\)\s*$/m);
  const home = m ? m[1].trim() : "";
  const f = path.join(BRIDGE_DIR, "codex-home.txt");
  let ok = false;
  try {
    if (home && fs.existsSync(home)) {
      fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      fs.writeFileSync(f, home, "utf8");
      ok = true;
    }
  } catch {
    /* ignore */
  }
  return { home, ok };
}
function cmdDetectHome() {
  const { home, ok } = detectCodexHome();
  if (ok) process.stdout.write(`codex home 탐지·기록: ${home}\n  sessions = ${path.join(home, "sessions")}\n`);
  else process.stderr.write(`codex home 탐지 실패: 'codex doctor'에서 CODEX_HOME 줄을 못 읽음.\n  → codex 업데이트로 출력 형식이 바뀌었을 수 있음(detectCodexHome 정규식 확인). 현재 폴백 = ${CODEX_HOME}\n`);
}

function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return { bySession: {}, byWorkspace: {} };
  }
}
function saveLinks(links) {
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2), "utf8");
}

// 연결 조회: 세션id 우선, 없으면 워크스페이스 폴백.
// 워크스페이스 링크를 우선한다(대시보드가 기록하는 것 = 사용자 명시 선택). bySession은 폴백.
// 과거엔 bySession을 우선해서, 한 번 --allow-new로 만들어진 세션이 박히면 대시보드로 다시
// 연결해도 안 먹고 엉뚱한 세션으로 검증이 가는 버그가 있었다 → 대시보드와 브릿지가 같은 기준을 보게 통일.
function resolveLink(links) {
  const ws = workspace();
  const wsLink = lookupWorkspace(links, ws);
  if (wsLink) return { ...wsLink, via: wsLink.via === "ui" ? "workspace·UI지정" : "workspace" };
  // bySession 폴백은 '그 항목의 워크스페이스가 현재와 같을 때만'. 다른 워크스페이스의 stale 링크가
  // byWorkspace 미스 시 새어드는 교차오염(검증이 엉뚱한 세션으로 감)을 막는다. (Codex 검증 #4)
  const cid = claudeId();
  const sLink = cid ? links.bySession[cid] : null;
  if (sLink && normWs(sLink.workspace || "") === normWs(ws)) return { ...sLink, via: "session(폴백)" };
  return null;
}
function recordLink(links, codexSession) {
  const entry = { codexSession, workspace: workspace(), claudeSession: claudeId(), linkedAt: nowIso() };
  if (claudeId()) links.bySession[claudeId()] = entry;
  // 정규화 키로 저장 + 동일 워크스페이스의 옛 키(대소문자 다름 등) 정리.
  const nk = normWs(workspace());
  for (const k of Object.keys(links.byWorkspace)) {
    if (normWs(k) === nk) delete links.byWorkspace[k];
  }
  links.byWorkspace[nk] = entry;
  saveLinks(links);
}

// sessions 폴더에서 특정 uuid의 rollout 파일 경로 찾기.
function findRolloutById(uuid) {
  let found = null;
  const walk = (d, depth) => {
    if (found || depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (found) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.includes(uuid) && it.name.endsWith(".jsonl")) found = full;
    }
  };
  walk(SESSIONS_DIR, 0);
  return found;
}

// 특정 시각 이후 생성/수정된 rollout 중 최신 → 방금 만든 세션 식별용.
function newestRolloutSince(sinceMs) {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        let m;
        try {
          m = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (m >= sinceMs && (!best || m > best.m)) best = { full, m };
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return best?.full || null;
}

// 세션 식별용: 그 세션의 첫 '실제' 사용자 발화를 짧게 뽑는다.
function firstUserSnippet(file) {
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      const s = l.trim();
      if (!s || s[0] !== "{") continue;
      let o;
      try {
        o = JSON.parse(s);
      } catch {
        continue;
      }
      if (o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "user") {
        const t = (o.payload.content || []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
        if (t && !/^<(environment_context|user_instructions|system)/i.test(t)) {
          return t.replace(/\s+/g, " ").slice(0, 70);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return "(내용 미상)";
}

// 최근 rollout(헤드리스 포함) 목록 — 최신 수정순.
function recentRollouts(limit) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        const m = it.name.match(UUID_RE);
        if (!m) continue;
        let mt = 0;
        try {
          mt = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        out.push({ id: m[1], file: full, mtime: mt });
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function indexedSessions() {
  try {
    return fs
      .readFileSync(INDEX_FILE, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// codex exec 실행(헤드리스). stdin 닫음(멈춤 방지), 최종 메시지는 -o 파일에서 회수.
function runCodex(extraArgs, prompt) {
  const inv = resolveCodex();
  const outFile = path.join(os.tmpdir(), `codex_bridge_${process.pid}_${Date.now()}.txt`);
  // 프롬프트는 인자가 아니라 stdin으로 전달 → 따옴표/줄바꿈/셸(.cmd) 무관하게 안전(범용).
  const codexArgs = [...inv.args, "exec", "--skip-git-repo-check", "-o", outFile, ...extraArgs];
  const r = spawnSync(inv.file, codexArgs, {
    input: prompt,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 1000 * 60 * 8,
    windowsHide: true,
    encoding: "utf8",
    shell: !!inv.shell,
  });
  let answer = "";
  try {
    answer = fs.readFileSync(outFile, "utf8").trim();
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* ignore */
  }
  // 종료코드 nonzero는 -o 파일이 남아도 실패로 본다(부분/오류 출력이 성공처럼 소비되지 않게).
  const badExit = typeof r.status === "number" && r.status !== 0;
  // 실패 시 "무엇으로 어떻게 실패했는지"를 붙인다 — 다음 세션이 추측으로 헤매지 않게.
  let diag = "";
  if (r.error || !answer || badExit) {
    diag =
      `\n[브릿지 진단] codex 실행방식=${inv.how} · file=${path.basename(inv.file)}` +
      (inv.args.length ? ` · launcher=${path.basename(inv.args[0])}` : "") +
      `\n  spawn=${r.error ? r.error.code || r.error.message : "ok"} · exit=${r.status} · signal=${r.signal || "-"}` +
      `\n  (자세한 점검: node "${__filename}" doctor)`;
  }
  return { answer, error: r.error, status: r.status, stderr: (r.stderr || "").toString() + diag };
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function cmdAsk(rest) {
  const allowNew = rest.includes("--allow-new");
  const prompt = rest.filter((x) => x !== "--allow-new").join(" ").trim();
  if (!prompt) die('사용법: ask "<프롬프트>"', 2);

  const links = loadLinks();
  const link = resolveLink(links);

  if (link) {
    const file = findRolloutById(link.codexSession);
    if (!file) {
      // 연결은 있으나 세션이 사라짐 → 보고만, 새로 안 만듦.
      die(
        `⚠️ 연결된 Codex 세션(${link.codexSession})을 찾을 수 없습니다(삭제됨?).\n` +
          `→ 새로 시작하려면: ask --allow-new "..."  /  다른 세션에 붙이려면: link <id>`,
      );
    }
    const { answer, error, status, stderr } = runCodex(["resume", link.codexSession], withContract(prompt));
    if (error || !answer || (typeof status === "number" && status !== 0)) die(`Codex resume 실패: ${error?.message || ""}\n${stderr.slice(-500)}`);
    process.stdout.write(`# 연결 세션 ${link.codexSession} (${link.via})\n\n${answer}\n`);
    return;
  }

  // 연결 전무 = 진짜 첫 소통.
  if (!allowNew) {
    // (나) 정책: 보고만 하고 멈춤. 멋대로 새 세션 안 만듦.
    die(
      `🔌 이 Claude 세션/워크스페이스에 연결된 Codex 세션이 없습니다.\n` +
        `   - 기존 세션에 연결:   node codex-bridge.js link <codex-session-id>   (목록: find)\n` +
        `   - 가장 최근에 연결:   node codex-bridge.js link --last\n` +
        `   - 새로 시작(첫 소통): node codex-bridge.js ask --allow-new "..."\n` +
        `※ 새 세션을 임의로 만들지 않았습니다.`,
      3,
    );
  }

  // 폭증 방지: 직전 --allow-new가 세션을 만들고도 연결 기록에 실패했으면, 또 만들지 않는다(수동 link 유도).
  const wsKey = normWs(workspace());
  if (links.autoNewFailed && links.autoNewFailed[wsKey]) {
    die(
      `⚠️ 직전에 새 Codex 세션을 만들었지만 연결 기록에 실패했습니다(세션id 식별 실패).\n` +
        `   무한 생성 방지를 위해 자동 생성을 멈춥니다.\n` +
        `   - 만든 세션 연결: node codex-bridge.js find  →  node codex-bridge.js link <id>\n` +
        `   - 폴더 탐지 점검: node codex-bridge.js doctor`,
      3,
    );
  }

  // --allow-new: 새 세션 생성 + 연결 기록.
  const since = Date.now() - 2000;
  const { answer, error, status, stderr } = runCodex([], withContract(prompt));
  if (error || !answer || (typeof status === "number" && status !== 0)) {
    // 응답은 실패했지만 세션 파일이 생겼을 수 있음 → 폭증 방지 플래그를 걸어 다음 자동 생성을 막고 종료.
    if (newestRolloutSince(since)) {
      links.autoNewFailed = links.autoNewFailed || {};
      links.autoNewFailed[wsKey] = true;
      saveLinks(links);
    }
    die(`Codex 새 세션 실패: ${error?.message || ""}\n${stderr.slice(-500)}\n(세션 파일이 생겼다면 'find'→'link <id>'로 연결하세요.)`);
  }
  const newFile = newestRolloutSince(since);
  const m = newFile && newFile.match(UUID_RE);
  if (m) {
    if (links.autoNewFailed) delete links.autoNewFailed[wsKey]; // 성공 → 폭증방지 플래그 해제
    recordLink(links, m[1]); // saveLinks 포함(플래그 해제도 함께 영속)
    process.stdout.write(`# 새 Codex 세션 생성·연결: ${m[1]}\n\n${answer}\n`);
  } else {
    links.autoNewFailed = links.autoNewFailed || {};
    links.autoNewFailed[wsKey] = true;
    saveLinks(links); // 다음 자동 생성 차단 플래그 저장
    process.stdout.write(`# 새 세션 생성됨(세션id 식별 실패) — 폭증 방지로 다음 자동 생성은 멈춥니다. 'find'로 찾아 'link <id>' 하세요.\n\n${answer}\n`);
  }
}

function cmdLink(rest) {
  const links = loadLinks();
  let id;
  if (rest[0] === "--last") {
    const rec = recentRollouts(1);
    if (!rec.length) die("Codex 세션이 없습니다. (find로 확인)");
    id = rec[0].id;
  } else if (rest[0] && UUID_RE.test(rest[0])) {
    id = rest[0].match(UUID_RE)[1];
  } else {
    die('사용법: link <codex-session-id> | link --last   (후보: find)', 2);
  }
  const file = findRolloutById(id);
  if (links.autoNewFailed) delete links.autoNewFailed[normWs(workspace())]; // 수동 연결됨 → 폭증방지 플래그 해제
  recordLink(links, id);
  process.stdout.write(
    `✅ 연결됨: Claude(${claudeId() || "?"}) + ${workspace()}  →  Codex ${id}\n` +
      (file ? `   세션 파일: ${path.basename(file)}\n` : `   ⚠️ 해당 세션 rollout 파일이 안 보임(추후 resume 시 실패할 수 있음)\n`),
  );
}

function cmdStatus() {
  const links = loadLinks();
  const link = resolveLink(links);
  process.stdout.write(`Claude 세션: ${claudeId() || "(env 없음)"}\n워크스페이스: ${workspace()}\n`);
  if (!link) {
    process.stdout.write("연결: 없음 (ask 하면 보고만 함, 또는 link/--allow-new)\n");
    return;
  }
  const file = findRolloutById(link.codexSession);
  process.stdout.write(
    `연결: Codex ${link.codexSession} (${link.via})  · 파일 ${file ? "있음" : "없음(삭제됨?)"}\n`,
  );
}

function cmdFind() {
  const links = loadLinks();
  const link = resolveLink(links);
  const list = recentRollouts(12);
  if (!list.length) {
    process.stdout.write("Codex 세션 없음.\n");
    return;
  }
  process.stdout.write("최근 Codex 세션(연결 후보 — 첫 사용자 발화로 식별):\n");
  for (const s of list) {
    const mark = link && link.codexSession === s.id ? "  ★현재 연결됨" : "";
    const when = s.mtime ? new Date(s.mtime).toLocaleString() : "";
    process.stdout.write(`  ${s.id}${mark}\n     ${when} · ${firstUserSnippet(s.file)}\n`);
  }
  process.stdout.write('\n연결 바꾸기: node codex-bridge.js link <id>\n');
}

// 점검: codex를 실제로 실행 가능한지 + 연결/검증 상태를 한눈에. 검증이 안 될 때 추측 대신 이걸 본다.
function cmdDoctor() {
  const inv = resolveCodex();
  const runnable = inv.shell ? null : fs.existsSync(inv.file) && (!inv.args.length || fs.existsSync(inv.args[0]));
  process.stdout.write("=== codex-bridge doctor ===\n");
  process.stdout.write(`codex 실행방식 : ${inv.how}\n`);
  process.stdout.write(`실행 명령      : ${inv.file}${inv.args.length ? " " + inv.args.join(" ") : ""}${inv.shell ? "   (PATH 셸 해석)" : ""}\n`);
  process.stdout.write(`실행 가능?     : ${inv.shell ? "PATH 의존(런타임 확인)" : runnable ? "예" : "아니오  ← 검증 불가의 직접 원인"}\n`);
  let c = null;
  try {
    c = loadContract();
  } catch {
    /* ignore */
  }
  process.stdout.write(`검증 모드      : ${c ? c.verifyMode : "(계약 로드 실패)"}\n`);
  process.stdout.write(`Claude 세션    : ${claudeId() || "(env 없음)"}\n`);
  process.stdout.write(`워크스페이스   : ${workspace()}\n`);
  const homeSrc = process.env.CODEX_HOME ? "env CODEX_HOME" : readPinnedHome() ? "codex-home.txt(자동탐지)" : "기본 ~/.codex";
  process.stdout.write(`Codex home     : ${CODEX_HOME}  (출처: ${homeSrc})\n`);
  process.stdout.write(`세션 폴더      : ${SESSIONS_DIR} · ${fs.existsSync(SESSIONS_DIR) ? "있음" : "없음 ← 세션 안 보이면 1순위 의심"}\n`);
  const links = loadLinks();
  const link = resolveLink(links);
  if (link) {
    const file = findRolloutById(link.codexSession);
    process.stdout.write(`연결           : Codex ${link.codexSession} (${link.via}) · 세션파일 ${file ? "있음" : "없음(삭제됨?)"}\n`);
  } else {
    process.stdout.write(`연결           : 없음 (ask=보고만 / 첫 소통=ask --allow-new)\n`);
  }
  if (!inv.shell && !runnable) {
    process.stdout.write(`\n해결: CODEX_BIN 환경변수에 codex 실행파일 또는 bin/codex.js 경로를 지정하세요.\n`);
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    process.stdout.write(
      `\n⚠ 세션 폴더가 없음. 세션 목록/연결/검증/삭제가 안 되면 1차 의심:\n` +
        `  codex 업데이트로 'codex doctor'의 CODEX_HOME 출력 형식이 바뀌어 home 자동탐지가 깨졌을 수 있음.\n` +
        `  → 'node codex-bridge.js detect-home' 재실행. 그래도 실패면 detectCodexHome()의 파싱 규칙(정규식) 확인.\n`,
    );
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "ask":
      return cmdAsk(rest);
    case "link":
      return cmdLink(rest);
    case "status":
      return cmdStatus();
    case "find":
      return cmdFind();
    case "doctor":
      return cmdDoctor();
    case "detect-home":
      return cmdDetectHome();
    default:
      process.stdout.write(
        "codex-bridge: ask | link | status | find | doctor | detect-home\n" +
          '  node codex-bridge.js ask "<프롬프트>"\n' +
          '  node codex-bridge.js ask --allow-new "<프롬프트>"\n' +
          "  node codex-bridge.js link <id> | link --last\n" +
          "  node codex-bridge.js status | find | doctor | detect-home\n",
      );
  }
}

if (require.main === module) main(); // CLI로 직접 실행할 때만. require 시엔 테스트용 export만.
module.exports = { withContract };
