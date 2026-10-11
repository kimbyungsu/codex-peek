"use strict";
/*
 * [2026-10-10 실사고] Codex 훅 신뢰 확인 — 기다리는 시간·다시 확인하는 주기·확인 중 경보.
 *  실측: 새 Codex 실행 코어가 훅 목록 요청을 처리하기까지 20초 안팎 → 10초 상한으로 하루 400회 가까이 전부 시간 초과,
 *  화면을 다시 그릴 때마다(30초) 실행 코어를 새로 띄움. 처방: 상한 90초 · 신뢰 기록 파일·훅 파일이 바뀔 때만 바로 다시 확인
 *  (확인됨 30분 · 미신뢰 5분 · 실패 2→5→15→30분) · 첫 확인이 진행 중일 때는 경보를 띄우지 않음.
 *  컴파일 산출물(out/extension.js)의 실제 함수를 꺼내 실행한다.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { createRequire } = require("module");
const ROOT = path.join(__dirname, "..");
const H = require("../out/codex-hook-health.js");
const OUT = path.join(ROOT, "out", "extension.js");
const src = fs.readFileSync(OUT, "utf8");
const slice = (startMarker, endMarker) => { const i = src.indexOf(startMarker); const j = src.indexOf(endMarker, i + startMarker.length); assert.ok(i >= 0 && j > i, "조각 " + startMarker); return src.slice(i, j); };

let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);

t("다시 확인 규칙 — 답 없음=바로 · 파일 지문 바뀜=바로 · 확인됨 30분 · 미신뢰 5분 · 실패 2→5→15→30분", () => {
  const M = 60 * 1000;
  const due = (snapshot, age, failures, fpChanged) => H.codexHookTrustRecheckDue({ snapshot, lastCheckAt: 1000, now: 1000 + age, fingerprint: fpChanged ? "b" : "a", lastFingerprint: "a", failures });
  assert.strictEqual(due(undefined, 0, 0, false), true, "답 기록 없음=바로");
  assert.strictEqual(due({ queried: true, ready: true }, 1, 0, true), true, "신뢰 기록·훅 파일이 바뀌면 바로");
  assert.strictEqual(due({ queried: true, ready: true }, 29 * M, 0, false), false);
  assert.strictEqual(due({ queried: true, ready: true }, 30 * M, 0, false), true, "확인됨=30분");
  assert.strictEqual(due({ queried: true, ready: false }, 4 * M, 0, false), false);
  assert.strictEqual(due({ queried: true, ready: false }, 5 * M, 0, false), true, "확인됐지만 미신뢰=5분");
  const fail = (f, mins) => due({ queried: false, ready: false }, mins * M, f, false);
  assert.ok(!fail(1, 1.9) && fail(1, 2), "실패 1회=2분");
  assert.ok(!fail(2, 4.9) && fail(2, 5), "실패 2회=5분");
  assert.ok(!fail(3, 14.9) && fail(3, 15), "실패 3회=15분");
  assert.ok(!fail(4, 29.9) && fail(4, 30) && !fail(9, 29.9) && fail(9, 30), "실패 4회 이상=30분");
  const c = new H.CodexHookTrustCache();
  c.markStarted("k", 5, "fp1"); assert.strictEqual(c.lastCheckAt("k"), 5); assert.strictEqual(c.getFingerprint("k"), "fp1");
  c.noteResult("k", false); c.noteResult("k", false); assert.strictEqual(c.failureCount("k"), 2);
  c.noteResult("k", true); assert.strictEqual(c.failureCount("k"), 0, "확인 성공=실패 횟수 0");
  c.markStarted("k", 9); assert.strictEqual(c.getFingerprint("k"), "fp1", "지문 없이 시작 표시=지문 유지(옛 호출)");
  c.reset(); assert.strictEqual(c.getFingerprint("k"), ""); assert.strictEqual(c.failureCount("k"), 0);
});

t("화면 갱신 경로(강제 아님)는 규칙대로만 실행 코어를 띄우고, 사용자 확인·설치 흐름(강제)은 바로 띄움 — 컴파일 산출물 실행", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cp-trust-"));
  const cfg = path.join(home, "config.toml"), hooks = path.join(home, "hooks.json");
  fs.writeFileSync(cfg, "a=1\n"); fs.writeFileSync(hooks, "{}\n");
  const body = slice("function codexHookTrustFingerprint(", "\nfunction dashboardCodexHookTrustCwd(");
  const cache = new H.CodexHookTrustCache();
  let calls = 0, answer = { queried: false, ready: false, error: "x", checkedAt: 0 };
  const realNow = Date.now; let clock = 1_000_000; Date.now = () => clock;
  try {
    const mk = new Function("fs", "path", "CODEX_HOME", "codexUserHooksFile", "codexHookTrustCache", "codex_hook_health_1", "normWs", "queryCodexPeekHookTrust", "observeCodexHookTrustForReload",
      body + "\nreturn { refresh: refreshCodexPeekHookTrust, fp: codexHookTrustFingerprint };");
    const api = mk(fs, path, home, () => hooks, cache, H, (x) => x, async () => { calls++; return Object.assign({}, answer, { checkedAt: Date.now() }); }, () => {});
    const W = "C:/ws";
    await api.refresh("R", W); assert.strictEqual(calls, 1, "첫 확인");
    for (let i = 0; i < 20; i++) { clock += 5000; await api.refresh("R", W); } // 100초 동안 화면 갱신 20번
    assert.strictEqual(calls, 1, "★실패 뒤 2분 안에는 다시 띄우지 않음(종전=30초마다)");
    clock += 30_000; await api.refresh("R", W); assert.strictEqual(calls, 2, "실패 1회 뒤 2분 지나면 다시");
    clock += 4 * 60_000; await api.refresh("R", W); assert.strictEqual(calls, 2, "실패 2회=5분 간격");
    clock += 61_000; await api.refresh("R", W); assert.strictEqual(calls, 3);
    await api.refresh("R", W, true); assert.strictEqual(calls, 4, "★강제(사용자 확인·설치 흐름)=바로");
    answer = { queried: true, ready: true, error: "" };
    await api.refresh("R", W, true); assert.strictEqual(calls, 5);
    clock += 29 * 60_000; await api.refresh("R", W); assert.strictEqual(calls, 5, "신뢰 확인됨=30분 동안 다시 안 띄움");
    const st = fs.statSync(cfg); fs.writeFileSync(cfg, "a=1\n[hooks.state]\n"); fs.utimesSync(cfg, new Date(st.mtimeMs + 5000), new Date(st.mtimeMs + 5000));
    await api.refresh("R", W); assert.strictEqual(calls, 6, "★신뢰 기록 파일(config.toml)이 바뀌면 바로");
    fs.appendFileSync(hooks, " "); await api.refresh("R", W); assert.strictEqual(calls, 7, "★훅 파일이 바뀌면 바로");
    assert.strictEqual(cache.failureCount("C:/ws"), 0, "확인 성공=실패 횟수 0");
    // 진행 중이면 같은 조회를 함께 기다림
    let release; const slow = new Promise((r) => { release = r; });
    const api2 = mk(fs, path, home, () => hooks, new H.CodexHookTrustCache(), H, (x) => x, async () => { calls++; await slow; return { queried: true, ready: true, error: "", checkedAt: 1 }; }, () => {});
    const before = calls; const p1 = api2.refresh("R", W), p2 = api2.refresh("R", W, true); release();
    await Promise.all([p1, p2]); assert.strictEqual(calls - before, 1, "진행 중 조회는 하나");
  } finally { Date.now = realNow; fs.rmSync(home, { recursive: true, force: true }); }
});

t("기다리는 시간 — 답이 12초 넘게 걸려도 받아 냄(종전 10초면 시간 초과) · 끝나면 실행 코어를 끔 — 가짜 Codex 실행 코어로 실제 실행", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp-fake-codex-"));
  const fake = path.join(dir, "fake-codex.js"), pidFile = path.join(dir, "pid.txt");
  fs.writeFileSync(fake, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let buf = ""; process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line);
  if (m.method === "initialize") setTimeout(() => process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + "\\n"), 1500);
  if (m.method === "hooks/list") setTimeout(() => process.stdout.write(JSON.stringify({ id: m.id, result: { data: [] } }) + "\\n"), 11000); } });
setInterval(() => {}, 1000);`);
  const body = slice("const CODEX_HOOK_TRUST_QUERY_TIMEOUT_MS", "\nfunction codexHookTrustFingerprint(");
  const req = createRequire(OUT);
  const run = new Function("require", "child_process_1", "resolveCodexPathForBridge", "tE", "codexUserHooksFile", "BRIDGE_DIR", "CODEX_PEEK_HOOK_COUNT", body + "\nreturn queryCodexPeekHookTrust;")(
    req, cp, () => fake, (ko) => ko, () => path.join(dir, "hooks.json"), dir, 5);
  assert.ok(/CODEX_HOOK_TRUST_QUERY_TIMEOUT_MS = 90000/.test(body), "상한 90초");
  const t0 = Date.now();
  const r = await run(dir, dir);
  const took = Date.now() - t0;
  assert.ok(r.queried === true && took >= 12000 && took < 30000, "★12초 넘게 걸린 답도 받아 냄 " + JSON.stringify({ queried: r.queried, error: r.error, took }));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((res) => setTimeout(res, 500));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.strictEqual(alive, false, "답을 받은 뒤 실행 코어를 끔");
  fs.rmSync(dir, { recursive: true, force: true });
});

t("첫 확인이 진행 중이면 경보를 띄우지 않음(준비 완료 승인도 아님) · 확인 실패로 끝나면 경보 · 확인 전·진행 중 아님=경보 — 컴파일 산출물 실행", () => {
  const body = slice("function syncCodexHookHealth(", "\n// 대시보드 프로젝트와 실제 작업 저장소가 다를 수 있다");
  const cases = [];
  const runSync = (snapshot, inflight) => {
    const cache = new H.CodexHookTrustCache();
    if (inflight) cache.setQuery("C:/ws", Promise.resolve({}));
    let written = null;
    const fn = new Function("codexHomeIsReady", "withIntegrityLockExt", "readIntegrity", "normWs", "codexHookHealth", "tE", "codexHookEventsKo", "CODEX_PEEK_HOOK_NAME_LIST", "atomicWrite", "INTEGRITY_FILE", "codexHookTrustForWorkspace", "codexHookTrustCache", "codexHookTrustCwd",
      body + "\nreturn syncCodexHookHealth;")(true, (f) => f(), () => [], (x) => x, () => ({ required: true, ready: false, reason: "hooks-unverified" }), (ko) => ko, () => "", "", (f, data) => { written = JSON.parse(data); }, "INTEG", () => snapshot, cache, (x) => x);
    fn("C:/ws");
    return written ? written.events.filter((e) => e.kind === "codex-hook-missing").length : 0;
  };
  assert.strictEqual(runSync(null, true), 0, "★첫 확인 진행 중=경보 없음");
  assert.strictEqual(runSync(null, false), 1, "확인 전·진행 중 아님=경보(종전)");
  assert.strictEqual(runSync({ queried: false, ready: false, error: "timeout" }, true), 1, "이미 실패로 끝난 확인이 있으면 다시 확인 중이어도 경보 유지");
  assert.strictEqual(runSync({ queried: false, ready: false, error: "timeout" }, false), 1, "확인 실패=경보");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
