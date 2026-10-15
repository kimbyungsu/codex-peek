"use strict";
// [AFTER-0.1.104-FIXES §1 설계 A · 묶음 A-1] Claude 도우미 실행기 — 하네스가 Claude 를 도우미(분류·서고 선별·정리 담당)로 부를 때의
// 단일 출처. 세 가지를 한곳에서 정한다:
//   ① 실행 파일 고르기(A1): 시험·사용자 덮어쓰기(CODEX_BRIDGE_CLAUDE_BIN) > 지금 대화를 돌리는 Claude Code 가 알려 주는 자기 위치
//      (CLAUDE_CODE_EXECPATH) > 그 위치를 기록해 둔 파일(claude-bin.txt) > PATH 의 claude. 후보마다 도움말로 기능을 확인(경로+크기+수정 시각 캐시).
//   ② 격리 실행(A2·A4): 새 방식=안전 모드(사용자 지침·훅·MCP·플러그인 끔 · 로그인은 그대로 — 로그인 파일 복사 없음)+도구 0+실행 기록 안 남김+
//      빈 임시 작업 폴더+현재 대화에 묶는 환경값 제거. 새 기능이 없는 판뿐이면 옛 방식=밖으로 나가는 길을 막는 최소 격리(MCP 끔·사용자 설정
//      안 읽음 → 사용자 훅 꺼짐·도구 끔·빈 작업 폴더)를 갖출 때만 실행하고, 그것도 못 갖추면 실행하지 않는다(claude-too-old).
//   ③ 답 꺼내기: 새 방식은 결과 봉투(JSON)의 정해진 틀 답(structured_output)을 한 줄 JSON 으로 — 호출자의 엄격 판독기는 그대로 둔다(판독 완화 없음).
// 담당 결정(Claude 차례→Claude)·프롬프트 문장은 이 모듈이 바꾸지 않는다.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CL = require("./contract-lib.js");

const SELF_DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";
const NEW_FLAGS = ["--output-format", "--safe-mode", "--tools", "--strict-mcp-config", "--no-session-persistence", "--json-schema"];
const OLD_FLAGS = ["--output-format", "--strict-mcp-config", "--setting-sources", "--disallowedTools"];
const CLAUDE_BIN_FILE = path.join(CL.BRIDGE_DIR, "claude-bin.txt");
const CAP_CACHE_FILE = path.join(CL.BRIDGE_DIR, "claude-helper-cap.json");
const ALARM_KIND = "claude-helper-old";
// 현재 대화에 묶는 값 — 도우미가 부모 대화의 세션·연결 통로·진입점으로 붙지 않게 뺀다. 로그인 위치(CLAUDE_CONFIG_DIR)·API 키·프록시·
// Windows 셸 경로 같은 사용자 환경은 남긴다(접두어 일괄 삭제는 CLAUDE_CODE_OAUTH_TOKEN·CLAUDE_CODE_GIT_BASH_PATH 같은 인증·실행 환경까지 지운다).
const SESSION_BOUND_ENV = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PROJECT_DIR", "AI_AGENT", "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "CLAUDE_CODE_EMIT_STARTUP_TIMING", "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_ENABLE_TASKS", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT"];

function helperEnv(base) {
  const e = Object.assign({}, base || process.env);
  for (const k of SESSION_BOUND_ENV) delete e[k];
  return e;
}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const normP = (p) => path.resolve(String(p || "")).toLowerCase();

// Windows 프로세스 트리 종료(selector-runner 가 다시 내보냄 — 실행 규약 단일 출처)
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }); } catch { /* 종료 실패=promise가 timeout으로 정착 */ }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료 */ } }
  }
}

// 지금 대화를 돌리는 Claude Code 위치를 기록(바뀌었을 때만) — 그 값이 없는 실행(확장이 띄운 실행 등)이 같은 실행 파일을 쓰게.
function recordExecPath(env) {
  const p = String((env || process.env).CLAUDE_CODE_EXECPATH || "").trim();
  if (!p || !isFile(p)) return false;
  let cur = ""; try { cur = fs.readFileSync(CLAUDE_BIN_FILE, "utf8").trim(); } catch { cur = ""; }
  if (cur === p) return true;
  try { fs.mkdirSync(CL.BRIDGE_DIR, { recursive: true }); return CL.atomicWrite(CLAUDE_BIN_FILE, p) !== false; } catch { return false; }
}

// 후보 목록 — 덮어쓰기 값이 있으면 그것만(결정론 · 시험 주입). 같은 경로는 한 번만.
function candidateList(env) {
  const e = env || process.env;
  const ov = String(e.CODEX_BRIDGE_CLAUDE_BIN || "").trim();
  if (ov) return [{ path: ov, how: "env:CODEX_BRIDGE_CLAUDE_BIN" }];
  const out = [];
  const push = (p, how) => { if (p && !out.some((c) => normP(c.path) === normP(p))) out.push({ path: p, how }); };
  const ex = String(e.CLAUDE_CODE_EXECPATH || "").trim(); if (ex && isFile(ex)) push(ex, "execpath");
  let rec = ""; try { rec = fs.readFileSync(CLAUDE_BIN_FILE, "utf8").trim(); } catch { rec = ""; }
  if (rec && isFile(rec)) push(rec, "recorded");
  const onPath = whichClaude(e); if (onPath) push(onPath, "PATH");
  return out;
}
// PATH 의 claude — 실제 파일만(POSIX 에서 resolveExecutableForSpawn 은 이름만 돌려줘 '없음'을 구분하지 못한다)
function whichClaude(env) {
  if (process.platform === "win32") return CL.resolveExecutableForSpawn("claude", env);
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) { const p = path.join(d, "claude"); if (isFile(p)) return p; }
  return null;
}

// 실행 형태 — 스크립트 진입점은 node 로, npm 셔틀(.cmd/.bat)은 안의 스크립트 진입점을 찾아 node 로(셸 경유는 빈 인자·JSON 인용이 깨진다).
// 진입점을 못 찾은 셔틀만 셸 경유(viaShell) — 그 경우 새 방식(빈 인자·틀 JSON)은 쓰지 않는다.
function invocationFor(p) {
  const ext = path.extname(p).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return { file: process.execPath, args: [p], viaShell: false, node: true };
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    let txt = ""; try { txt = fs.readFileSync(p, "utf8"); } catch { txt = ""; }
    const m = /"%(?:dp0|~dp0)%?\\([^"]+?\.(?:js|mjs|cjs))"/i.exec(txt);
    if (m) { const js = path.join(path.dirname(p), m[1]); if (isFile(js)) return { file: process.execPath, args: [js], viaShell: false, node: true }; }
    return { file: p, args: [], viaShell: true, node: false };
  }
  return { file: p, args: [], viaShell: false, node: false };
}
function spawnEnvFor(inv, base) { const e = helperEnv(base); if (inv.node) e.ELECTRON_RUN_AS_NODE = "1"; return e; }

// 기능 확인 — 도움말의 옵션 이름 + 판(--version). 캐시 열쇠=실행 파일 지문(경로+크기+수정 시각) — node 로 돌리는 스크립트 진입점(npm 셔틀 안 cli.js)이 있으면
// 그 지문도 함께(셔틀은 그대로이고 안의 스크립트만 업데이트되는 경우를 놓치지 않게 — 구현 검증 1회차 blocker). 메모리 → 파일. 실패=null(그 후보는 못 씀).
// 확인은 비동기 실행이며 호출의 시간 상한·취소 안에서 돈다(ctl: {deadline, cancelled, child}) — 구현 검증 1회차 blocker.
const capMem = new Map();
function fpOf(p) { try { const st = fs.statSync(p); return st.size + "|" + Math.round(st.mtimeMs); } catch { return ""; } }
function capKeyOf(p, inv) {
  const a = fpOf(p); if (!a) return "";
  let k = normP(p) + "|" + a;
  const js = inv && inv.node && inv.args && inv.args[0] ? inv.args[0] : "";
  if (js && normP(js) !== normP(p)) { const b = fpOf(js); if (!b) return ""; k += "|" + normP(js) + "|" + b; }
  return k;
}
function readCapCache() { try { const o = JSON.parse(fs.readFileSync(CAP_CACHE_FILE, "utf8")); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
const HELP_TIMEOUT_MS = 20000;
function remainingMs(ctl) { return ctl && Number.isFinite(ctl.deadline) ? ctl.deadline - Date.now() : HELP_TIMEOUT_MS; }
// 짧은 실행 1회(도움말·판) — 남은 시간과 20초 중 짧은 쪽에서 끊고, 취소되면 바로 끊는다.
function runQuick(inv, args, env, ctl) {
  return new Promise((resolve) => {
    const limit = Math.min(HELP_TIMEOUT_MS, remainingMs(ctl));
    if (limit <= 0) return resolve({ status: null, stdout: "", stderr: "", timedOut: true });
    let ch; try { ch = spawn(inv.file, [...inv.args, ...args], { windowsHide: true, shell: inv.viaShell, env: spawnEnvFor(inv, env), stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return resolve({ status: null, error: e, stdout: "", stderr: "" }); }
    if (ctl) ctl.child = ch;
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(ch.pid); }, limit);
    ch.stdout.on("data", (d) => { out += String(d); }); ch.stderr.on("data", (d) => { err += String(d); });
    ch.on("error", (e) => { clearTimeout(timer); if (ctl && ctl.child === ch) ctl.child = null; resolve({ status: null, error: e, stdout: out, stderr: err, timedOut }); });
    ch.on("close", (code) => { clearTimeout(timer); if (ctl && ctl.child === ch) ctl.child = null; resolve({ status: code, stdout: out, stderr: err, timedOut }); });
  });
}
// 캐시 판독·기능 계산·캐시 기록 — 비동기·동기 경로 공용(같은 규칙)
function cachedCaps(key) {
  if (capMem.has(key)) return capMem.get(key);
  const file = readCapCache();
  if (file[key] && Array.isArray(file[key].flags)) { capMem.set(key, file[key]); return file[key]; }
  return null;
}
function capsFrom(help, ver) {
  const flags = [...new Set((String(help.stdout || "") + "\n" + String(help.stderr || "")).match(/--[A-Za-z][A-Za-z0-9-]*/g) || [])];
  const vm = ver && !ver.error ? /(\d+\.\d+\.\d+)/.exec(String(ver.stdout || "")) : null;
  return { flags, version: vm ? vm[1] : "", at: new Date().toISOString() };
}
function storeCaps(key, caps) {
  capMem.set(key, caps);
  try { const f2 = readCapCache(); f2[key] = caps; const keys = Object.keys(f2); if (keys.length > 20) for (const k of keys.slice(0, keys.length - 20)) delete f2[k]; fs.mkdirSync(CL.BRIDGE_DIR, { recursive: true }); CL.atomicWrite(CAP_CACHE_FILE, JSON.stringify(f2)); } catch { /* 캐시 실패=다음에 다시 확인 */ }
  return caps;
}
async function capabilitiesOf(p, inv, env, ctl) {
  const key = capKeyOf(p, inv); if (!key) return null;
  const hit = cachedCaps(key); if (hit) return hit;
  const help = await runQuick(inv, ["--help"], env, ctl);
  if (help.timedOut || (ctl && ctl.cancelled)) return { interrupted: true };
  if (help.error || help.status !== 0) return null;
  const ver = await runQuick(inv, ["--version"], env, ctl);
  if (ver.timedOut || (ctl && ctl.cancelled)) return { interrupted: true };
  return storeCaps(key, capsFrom(help, ver));
}
// [묶음 A-2] 동기 형태 — 지금 spawnSync 로 부르는 호출자(정찰·자동 보강·Claude 검증 담당)용. 남은 시간과 20초 중 짧은 쪽에서 끊는다(취소 개념 없음).
function runQuickSync(inv, args, env, deadline) {
  const limit = Math.min(HELP_TIMEOUT_MS, Number.isFinite(deadline) ? deadline - Date.now() : HELP_TIMEOUT_MS);
  if (limit <= 0) return { status: null, stdout: "", stderr: "", timedOut: true };
  let r; try { r = spawnSync(inv.file, [...inv.args, ...args], { encoding: "utf8", timeout: limit, windowsHide: true, shell: inv.viaShell, env: spawnEnvFor(inv, env), stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return { status: null, error: e, stdout: "", stderr: "" }; }
  return { status: r.status, error: r.error, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: !!(r.error && r.error.code === "ETIMEDOUT") };
}
function capabilitiesOfSync(p, inv, env, deadline) {
  const key = capKeyOf(p, inv); if (!key) return null;
  const hit = cachedCaps(key); if (hit) return hit;
  const help = runQuickSync(inv, ["--help"], env, deadline);
  if (help.timedOut) return { interrupted: true };
  if (help.error || help.status !== 0) return null;
  const ver = runQuickSync(inv, ["--version"], env, deadline);
  if (ver.timedOut) return { interrupted: true };
  return storeCaps(key, capsFrom(help, ver));
}
function tierOf(caps, inv) {
  if (!caps || caps.interrupted) return "";
  const has = (f) => caps.flags.includes(f);
  if (!inv.viaShell && NEW_FLAGS.every(has)) return "new";
  if (OLD_FLAGS.every(has)) return "old";
  return "";
}

// 실행 파일 고르기 — 새 방식이 되는 첫 후보 > 옛 방식(최소 격리)이 되는 첫 후보 > 실패(후보 없음=cli-missing · 있으나 모두 부족=claude-too-old)
// 확인 도중 취소=cancelled · 시간 상한 도달=call-failed(capability-timeout). ctl 없이 부르면(시험·진단) 후보마다 20초 상한만.
async function resolveClaudeHelper(env, ctl) {
  const e = env || process.env;
  try { recordExecPath(e); } catch { /* 기록 실패=다음 실행에서 다시 */ }
  // 앞 후보가 새 방식이면 뒤 후보는 확인하지 않는다(도움말 실행 비용 — 보통 첫 후보가 지금 대화의 Claude Code)
  const list = candidateList(e), seen = [];
  let old = null;
  for (const c of list) {
    if (ctl && ctl.cancelled) return { ok: false, key: "cancelled", detail: "" };
    if (ctl && remainingMs(ctl) <= 0) return { ok: false, key: "call-failed", detail: "capability-timeout" };
    const inv = invocationFor(c.path); const caps = await capabilitiesOf(c.path, inv, e, ctl);
    if (ctl && ctl.cancelled) return { ok: false, key: "cancelled", detail: "" };
    if (caps && caps.interrupted) return { ok: false, key: "call-failed", detail: "capability-timeout" };
    const it = Object.assign({}, c, { inv, caps, tier: tierOf(caps, inv) }); seen.push(it);
    if (it.tier === "new") return { ok: true, tier: "new", path: it.path, how: it.how, inv, version: (caps && caps.version) || "" };
    if (it.tier === "old" && !old) old = it;
  }
  if (old) return { ok: true, tier: "old", path: old.path, how: old.how, inv: old.inv, version: (old.caps && old.caps.version) || "" };
  if (!seen.length) return { ok: false, key: "cli-missing", detail: "claude-not-found" };
  return { ok: false, key: "claude-too-old", detail: seen.map((c) => c.how + "=" + ((c.caps && c.caps.version) || "?")).join(" "), versions: seen.map((c) => (c.caps && c.caps.version) || "") };
}
// [묶음 A-2] 동기 고르기 — 비동기 고르기와 같은 순서·같은 판정(deadline=절대 시각 · 없으면 후보마다 20초 상한만).
// 단 셸을 거쳐야만 실행되는 후보(진입점을 못 찾은 .cmd/.bat)는 쓰지 않는다 — 동기 실행은 시간 초과 때 셸만 끝내고 그 아래 실제 Claude 를
// 회수할 수 없다(구현 검증 A-2 1회차 blocker · 비동기 형태는 트리 종료로 회수하므로 그대로 씀). 그런 후보뿐이면 claude-shell-only.
function resolveClaudeHelperSync(env, deadline) {
  const e = env || process.env;
  try { recordExecPath(e); } catch { /* 기록 실패=다음 실행에서 다시 */ }
  const list = candidateList(e), seen = [];
  let old = null, shellOnly = 0;
  for (const c of list) {
    if (Number.isFinite(deadline) && deadline - Date.now() <= 0) return { ok: false, key: "call-failed", detail: "capability-timeout" };
    const inv = invocationFor(c.path);
    if (inv.viaShell) { shellOnly++; continue; } // 기능 확인(도움말)도 셸 경유라 실행하지 않음
    const caps = capabilitiesOfSync(c.path, inv, e, deadline);
    if (caps && caps.interrupted) return { ok: false, key: "call-failed", detail: "capability-timeout" };
    const it = Object.assign({}, c, { inv, caps, tier: tierOf(caps, inv) }); seen.push(it);
    if (it.tier === "new") return { ok: true, tier: "new", path: it.path, how: it.how, inv, version: (caps && caps.version) || "" };
    if (it.tier === "old" && !old) old = it;
  }
  if (old) return { ok: true, tier: "old", path: old.path, how: old.how, inv: old.inv, version: (old.caps && old.caps.version) || "" };
  if (!seen.length) return shellOnly ? { ok: false, key: "claude-shell-only", detail: "only shell-wrapped claude found (" + shellOnly + ")" } : { ok: false, key: "cli-missing", detail: "claude-not-found" };
  return { ok: false, key: "claude-too-old", detail: seen.map((c) => c.how + "=" + ((c.caps && c.caps.version) || "?")).join(" ") + (shellOnly ? " · shell-only " + shellOnly : ""), versions: seen.map((c) => (c.caps && c.caps.version) || "") };
}
function helperArgs(tier, schema) {
  if (tier === "new") return ["-p", "--output-format", "json", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence", ...(schema ? ["--json-schema", JSON.stringify(schema)] : [])];
  // 옛 방식: 빈 임시 작업 폴더라 project 출처에서 읽을 설정이 없다 → 사용자 설정(훅·플러그인)을 읽지 않음
  return ["-p", "--output-format", "text", "--setting-sources", "project", "--disallowedTools", SELF_DENY, "--strict-mcp-config"];
}

// 답 꺼내기 — 새 방식=결과 봉투. 틀이 있으면 틀 답(객체)만 받는다(봉투의 result 글로 대신하지 않음 — 틀이 없는 답은 실패).
function extractAnswer(tier, stdout, schema) {
  const raw = String(stdout || "").trim();
  if (tier !== "new") return raw ? { ok: true, output: raw } : { ok: false, key: "call-failed", detail: "empty" };
  let o = null; try { o = JSON.parse(raw); } catch { return { ok: false, key: "call-failed", detail: "envelope-unreadable" }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, key: "call-failed", detail: "envelope-unreadable" };
  if (o.is_error === true) return { ok: false, key: "call-failed", detail: "is-error " + String(o.subtype || "").slice(0, 60) };
  if (schema) {
    const so = o.structured_output;
    if (!so || typeof so !== "object" || Array.isArray(so)) return { ok: false, key: "call-failed", detail: "no-structured-output " + String(o.subtype || "").slice(0, 60) };
    return { ok: true, output: JSON.stringify(so) };
  }
  const txt = typeof o.result === "string" ? o.result.trim() : "";
  return txt ? { ok: true, output: txt } : { ok: false, key: "call-failed", detail: "empty" };
}

// 페이지 1회 실행 — 반환 {promise, cancel}(즉시 반환). promise 는 {ok, output, key, detail, durationMs, cancelled, runner}로 정착(selector-runner 와 같은 모양).
// 시간 상한(timeoutMs)은 기능 확인과 모델 실행을 합친 전체에 걸리고, 취소는 어느 단계에서든 지금 도는 자식 프로세스를 끊는다.
function runClaudeHelper({ prompt, timeoutMs, schema, env }) {
  const t0 = Date.now();
  const ctl = { deadline: t0 + Math.max(1000, Number(timeoutMs) || 1000), cancelled: false, child: null };
  let settled = false;
  const cancel = () => { ctl.cancelled = true; if (ctl.child && !settled) killTree(ctl.child.pid); };
  const promise = (async () => {
    const base = env || process.env;
    let runner = { tier: "", version: "", how: "" };
    const fin = (r) => { settled = true; return Object.assign({}, r, { durationMs: Date.now() - t0, cancelled: ctl.cancelled, runner }); };
    let rz;
    try { rz = await resolveClaudeHelper(base, ctl); } catch (e) { return fin({ ok: false, key: "spawn-prep-failed", detail: String((e && e.message) || e) }); }
    if (!rz.ok) { runner = { tier: "", version: (rz.versions || []).filter(Boolean).join(","), how: "" }; return fin({ ok: false, key: rz.key, detail: rz.detail }); }
    runner = { tier: rz.tier, version: rz.version, how: rz.how };
    if (ctl.cancelled) return fin({ ok: false, key: "cancelled", detail: "" });
    const left = remainingMs(ctl);
    if (left <= 0) return fin({ ok: false, key: "call-failed", detail: "timeout before model run" });
    let tmpCwd = null;
    try { tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-helper-")); } catch (e) { return fin({ ok: false, key: "spawn-prep-failed", detail: "tmp " + String((e && e.message) || e) }); }
    const cleanup = () => { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 임시 잔재 무해 */ } };
    const args = [...rz.inv.args, ...helperArgs(rz.tier, rz.tier === "new" ? schema : null)];
    return await new Promise((resolve) => {
      let out = "", err = "", child;
      try { child = spawn(rz.inv.file, args, { cwd: tmpCwd, env: spawnEnvFor(rz.inv, base), windowsHide: true, shell: rz.inv.viaShell, stdio: ["pipe", "pipe", "pipe"] }); }
      catch (e) { cleanup(); return resolve(fin({ ok: false, key: "spawn-failed", detail: String((e && e.message) || e) })); }
      ctl.child = child;
      if (ctl.cancelled) killTree(child.pid); // 확인과 실행 사이에 취소된 경우
      const timer = setTimeout(() => { killTree(child.pid); }, left);
      child.stdout.on("data", (d) => { out += String(d); });
      child.stderr.on("data", (d) => { err += String(d); });
      child.on("error", (e) => { clearTimeout(timer); cleanup(); resolve(fin({ ok: false, key: "spawn-failed", detail: String((e && e.message) || e) })); });
      child.on("close", (code) => {
        clearTimeout(timer); cleanup();
        if (ctl.cancelled) return resolve(fin({ ok: false, key: "cancelled", detail: "" }));
        if (code !== 0) {
          let sub = ""; if (rz.tier === "new") { try { const o = JSON.parse(String(out).trim()); sub = String((o && o.subtype) || ""); } catch { sub = ""; } }
          return resolve(fin({ ok: false, key: "call-failed", detail: `exit=${code} ` + (sub ? sub + " " : "") + String(err || "").slice(-200) }));
        }
        const a = extractAnswer(rz.tier, out, rz.tier === "new" ? schema : null);
        resolve(fin(a.ok ? { ok: true, output: a.output } : { ok: false, key: a.key, detail: a.detail }));
      });
      try { child.stdin.end(String(prompt || "")); } catch { /* close 핸들러가 실패 정착 */ }
    });
  })();
  return { promise, cancel };
}
// [묶음 A-2] 동기 실행 — 정찰·자동 보강처럼 지금 spawnSync 로 부르는 호출자용. 같은 고르기·같은 인자·같은 답 꺼내기.
// 시간 상한(timeoutMs)은 기능 확인과 모델 실행을 합친 전체. beforeSpawn=모델 실행 직전(호출 기록 시작) · afterSpawn(pid)=실제로 시작됐을 때.
// 반환 {ok, output, key, detail, durationMs, runner, started}.
function runClaudeHelperSync({ prompt, timeoutMs, schema, env, beforeSpawn, afterSpawn }) {
  const t0 = Date.now();
  const deadline = t0 + Math.max(1000, Number(timeoutMs) || 1000);
  const base = env || process.env;
  let runner = { tier: "", version: "", how: "" }, started = false;
  const fin = (r) => Object.assign({}, r, { durationMs: Date.now() - t0, runner, started });
  let rz;
  try { rz = resolveClaudeHelperSync(base, deadline); } catch (e) { return fin({ ok: false, key: "spawn-prep-failed", detail: String((e && e.message) || e) }); }
  if (!rz.ok) { runner = { tier: "", version: (rz.versions || []).filter(Boolean).join(","), how: "" }; return fin({ ok: false, key: rz.key, detail: rz.detail }); }
  runner = { tier: rz.tier, version: rz.version, how: rz.how };
  const left = deadline - Date.now();
  if (left <= 0) return fin({ ok: false, key: "call-failed", detail: "timeout before model run" });
  let tmpCwd = null;
  try { tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-helper-")); } catch (e) { return fin({ ok: false, key: "spawn-prep-failed", detail: "tmp " + String((e && e.message) || e) }); }
  const args = [...rz.inv.args, ...helperArgs(rz.tier, rz.tier === "new" ? schema : null)];
  if (typeof beforeSpawn === "function") { try { beforeSpawn(); } catch { /* 기록 실패=실행 무영향 */ } }
  let r;
  try { r = spawnSync(rz.inv.file, args, { input: String(prompt || ""), encoding: "utf8", timeout: left, windowsHide: true, shell: rz.inv.viaShell, cwd: tmpCwd, env: spawnEnvFor(rz.inv, base), maxBuffer: 1024 * 1024 * 64 }); }
  catch (e) { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {} return fin({ ok: false, key: "spawn-failed", detail: String((e && e.message) || e) }); }
  try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 임시 잔재 무해 */ }
  started = Number.isSafeInteger(r.pid) && r.pid > 0;
  if (started && typeof afterSpawn === "function") { try { afterSpawn(r.pid); } catch { /* 기록 실패=실행 무영향 */ } }
  if (r.error) return fin({ ok: false, key: "call-failed", detail: (r.error.code === "ETIMEDOUT" ? "timeout" : String(r.error.code || r.error.message || r.error)) + " " + String(r.stderr || "").slice(-200) });
  if (r.status !== 0) {
    let sub = ""; if (rz.tier === "new") { try { const o = JSON.parse(String(r.stdout || "").trim()); sub = String((o && o.subtype) || ""); } catch { sub = ""; } }
    return fin({ ok: false, key: "call-failed", detail: `exit=${r.status} ` + (sub ? sub + " " : "") + String(r.stderr || "").slice(-200) });
  }
  const a = extractAnswer(rz.tier, r.stdout, rz.tier === "new" ? schema : null);
  return fin(a.ok ? { ok: true, output: a.output } : { ok: false, key: a.key, detail: a.detail });
}

// [묶음 A-2 · A5] 정찰·자동 보강의 실행 방식·판 기록 — 사용량 장부(stats/scout-usage.jsonl · 칸이 정확히 정해진 통계 계약)는 그대로 두고,
// 같은 호출 번호(callId)로 이어지는 별도 기록(stats/claude-helper-runs.jsonl · 60일 보관)에 남긴다. 실패도 남긴다(너무 오래됨·셸 경유뿐 포함).
const HELPER_RUNS_FILE = path.join(CL.STATS_DIR, "claude-helper-runs.jsonl");
function recordHelperRun({ callId, flow, repoKey, r }) {
  const runner = (r && r.runner) || {};
  const row = { schema: "claude-helper-run-v1", ts: new Date().toISOString(), callId: String(callId || ""), flow: String(flow || ""), repoKey: repoKey ? String(repoKey) : null,
    tier: String(runner.tier || ""), version: String(runner.version || ""), how: String(runner.how || ""), ok: !!(r && r.ok), key: r && !r.ok ? String(r.key || "") : "", started: !!(r && r.started) };
  try { return CL.appendStatsLocked(HELPER_RUNS_FILE, row); } catch { return false; }
}

// 대시보드 한 줄(A4) — 옛 방식으로 돌았거나 너무 오래돼 못 돌았으면 경고(같은 판·같은 이유는 한 번만), 새 방식으로 돌면 지운다.
function reportHelperTier(ws, r) {
  if (!ws || !r) return;
  const runner = r.runner || {};
  try {
    const onceBase = ALARM_KIND + "|" + CL.normWs(String(ws)) + "|";
    if (runner.tier === "new") { CL.supersedeIntegrity("", ALARM_KIND, ws); CL.clearIntegrityOnce(onceBase); return; } // 풀렸으면 기억도 비움(다시 오래되면 다시 알림)
    const tooOld = r.key === "claude-too-old";
    if (runner.tier !== "old" && !tooOld) return;
    const ver = runner.version || "?";
    const sig = (tooOld ? "too-old@" : "old@") + ver;
    const ko = tooOld
      ? `도우미가 쓸 Claude Code(판 ${ver})가 너무 오래돼 사용자 말 분류·서고 선별·정리 담당을 실행하지 않았습니다 — 연결 도구와 사용자 훅을 끄는 기능이 없는 판으로는 돌리지 않습니다. Claude Code를 업데이트하면 다음 실행부터 다시 돕니다.`
      : `도우미가 쓰는 Claude Code(판 ${ver})가 오래돼 사용자 말 분류·서고 선별·정리 담당이 사용자 지침을 읽은 채로 돌고, 답 형식이 자주 깨져 버려지며, 실행 기록이 대화 목록에 남을 수 있습니다(연결 도구·사용자 훅은 꺼져 있습니다). Claude Code를 업데이트하면 다음 실행부터 자동으로 새 방식으로 바뀝니다.`;
    const en = tooOld
      ? `The Claude Code the helper would use (version ${ver}) is too old, so the classifier, archive selector and curator did not run — the harness does not run them without the options that switch off MCP and user hooks. Update Claude Code and the next run will work again.`
      : `The Claude Code the helper uses (version ${ver}) is old: the classifier, archive selector and curator run with your user instructions loaded, answers are often discarded for format, and each run may appear in your conversation list (MCP and user hooks are already off). Update Claude Code and the next run switches to the new way automatically.`;
    // 같은 작업공간·같은 이유·같은 판은 한 번만 — 경보 목록(최근 50건)이 잘려도 띄운 기록이 남아 확인한 경보를 매 실행 되살리지 않는다(구현 검증 1회차 blocker)
    CL.appendIntegrityEventOnce({ ts: new Date().toISOString(), session: "", workspace: ws, kind: ALARM_KIND, severity: "warning", sig, detail: ko, detailKo: ko, detailEn: en }, onceBase + sig, { supersedeSameKindWs: true });
  } catch { /* best-effort — 경보 실패가 실행 결과를 바꾸지 않음 */ }
}

module.exports = { SELF_DENY, NEW_FLAGS, OLD_FLAGS, SESSION_BOUND_ENV, CLAUDE_BIN_FILE, CAP_CACHE_FILE, ALARM_KIND, helperEnv, killTree, recordExecPath, candidateList, invocationFor, capabilitiesOf, capabilitiesOfSync, tierOf, resolveClaudeHelper, resolveClaudeHelperSync, helperArgs, extractAnswer, runClaudeHelper, runClaudeHelperSync, reportHelperTier, recordHelperRun, HELPER_RUNS_FILE };
