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
const { loadContract, buildInjection } = require("./contract-lib.js");

// 사용자 요청 앞에 Codex 고정 계약을 prepend(매 ask마다). 계약 없으면 원문 그대로.
function withContract(prompt) {
  let inj = "";
  try {
    const c = loadContract();
    inj = buildInjection(c.codex, "Codex", c.codexChecklist);
  } catch {
    inj = "";
  }
  return inj ? `${inj}\n\n---\n[작업 요청]\n${prompt}` : prompt;
}

const HOME = os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const BRIDGE_DIR = path.join(HOME, ".codex-bridge");
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

function findCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const extDir = path.join(HOME, ".vscode", "extensions");
  try {
    for (const d of fs.readdirSync(extDir).filter((x) => x.startsWith("openai.chatgpt-")).sort().reverse()) {
      const binDir = path.join(extDir, d, "bin");
      if (!fs.existsSync(binDir)) continue;
      for (const plat of fs.readdirSync(binDir)) {
        const cand = path.join(binDir, plat, exe);
        if (fs.existsSync(cand)) return cand;
      }
    }
  } catch {
    /* ignore */
  }
  return exe;
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
function resolveLink(links) {
  const cid = claudeId();
  const ws = workspace();
  if (cid && links.bySession[cid]) return { ...links.bySession[cid], via: "session" };
  const wsLink = lookupWorkspace(links, ws);
  if (wsLink) return { ...wsLink, via: "workspace" };
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
  const bin = findCodexBin();
  const outFile = path.join(os.tmpdir(), `codex_bridge_${process.pid}_${Date.now()}.txt`);
  const args = ["exec", "--skip-git-repo-check", "-o", outFile, ...extraArgs, prompt];
  const r = spawnSync(bin, args, {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 1000 * 60 * 8,
    windowsHide: true,
    encoding: "utf8",
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
  return { answer, error: r.error, stderr: (r.stderr || "").toString() };
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
    const { answer, error, stderr } = runCodex(["resume", link.codexSession], withContract(prompt));
    if (error || !answer) die(`Codex resume 실패: ${error?.message || ""}\n${stderr.slice(-500)}`);
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

  // --allow-new: 새 세션 생성 + 연결 기록.
  const since = Date.now() - 2000;
  const { answer, error, stderr } = runCodex([], withContract(prompt));
  if (error || !answer) die(`Codex 새 세션 실패: ${error?.message || ""}\n${stderr.slice(-500)}`);
  const newFile = newestRolloutSince(since);
  const m = newFile && newFile.match(UUID_RE);
  if (m) {
    recordLink(links, m[1]);
    process.stdout.write(`# 새 Codex 세션 생성·연결: ${m[1]}\n\n${answer}\n`);
  } else {
    process.stdout.write(`# 새 세션 생성됨(세션id 식별 실패 — 다음 호출은 워크스페이스 폴백 의존)\n\n${answer}\n`);
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
    default:
      process.stdout.write(
        "codex-bridge: ask | link | status | find\n" +
          '  node codex-bridge.js ask "<프롬프트>"\n' +
          '  node codex-bridge.js ask --allow-new "<프롬프트>"\n' +
          "  node codex-bridge.js link <id> | link --last\n" +
          "  node codex-bridge.js status | find\n",
      );
  }
}

main();
