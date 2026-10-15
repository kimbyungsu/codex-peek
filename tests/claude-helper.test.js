"use strict";
/*
 * [AFTER-0.1.104-FIXES §1 설계 A · 묶음 A-1] Claude 도우미 실행기 시험.
 * 실행 파일 고르기(덮어쓰기 > 지금 대화의 Claude Code 위치 > 기록 파일 > PATH · 새 방식 우선 · 앞 후보가 새 방식이면 뒤 후보 미확인 · 기능 캐시) ·
 * 새 방식 인자(안전 모드·도구 0·MCP 끔·기록 안 남김·정해진 틀)·빈 임시 작업 폴더·환경값 정리(로그인 위치·인증 값 유지)·로그인 파일 무복사 ·
 * 답 꺼내기(틀 답·오류 봉투·깨진 봉투·틀 답 없음·종료 코드·시간 초과·취소) · 옛 방식=최소 격리 인자 · 너무 오래된 판=실행 안 함 ·
 * 실행 파일 위치 기록 · 대시보드 경보(옛 방식·너무 오래됨=한 번만 · 새 방식=지움) · 호출자별 틀과 엄격 판독기 왕복 · 배선.
 * 격리: 임시 CODEX_BRIDGE_HOME · 가짜 Claude(node 스크립트) — 실제 모델 호출 없음.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "chelp-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const CH = require("../bridge/claude-helper.js");
const SR = require("../bridge/selector-runner.js");
const CF = require("../bridge/classify.js");
const CU = require("../bridge/curation.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), "chelp-fix-"));
const LOG = path.join(FIX, "calls.jsonl");
const NEW_HELP = ["--output-format", "--safe-mode", "--tools", "--strict-mcp-config", "--no-session-persistence", "--json-schema", "--setting-sources", "--disallowedTools", "--model"];
const OLD_HELP = ["--output-format", "--strict-mcp-config", "--setting-sources", "--disallowedTools", "--mcp-config"];
const ANCIENT_HELP = ["--output-format", "--disallowedTools"];
function fakeSrc(variant, help, version) {
  return [
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    "const pick = (k) => process.env[k];",
    "let files = []; try { files = fs.readdirSync(process.cwd()); } catch {}",
    "fs.appendFileSync(" + JSON.stringify(LOG) + ", JSON.stringify({ variant: " + JSON.stringify(variant) + ", args, cwd: process.cwd(), files, env: { CLAUDECODE: pick('CLAUDECODE'), CLAUDE_CODE_SESSION_ID: pick('CLAUDE_CODE_SESSION_ID'), CLAUDE_CODE_EXECPATH: pick('CLAUDE_CODE_EXECPATH'), CLAUDE_CODE_MESSAGING_TOKEN: pick('CLAUDE_CODE_MESSAGING_TOKEN'), CLAUDE_CONFIG_DIR: pick('CLAUDE_CONFIG_DIR'), CLAUDE_CODE_OAUTH_TOKEN: pick('CLAUDE_CODE_OAUTH_TOKEN') } }) + '\\n');",
    "if (args.includes('--help')) { if (pick('FAKE_HELP_FAIL') === " + JSON.stringify(variant) + ") process.exit(3); const say = () => { process.stdout.write('Usage: claude [options]\\n' + " + JSON.stringify(help.map((f) => "  " + f + " <v>  description").join("\n")) + " + '\\n'); process.exit(0); }; const slow = Number(pick('FAKE_HELP_SLEEP') || 0); if (slow > 0) setTimeout(say, slow); else say(); return; }",
    "if (args.includes('--version')) { process.stdout.write(" + JSON.stringify(version + " (Claude Code)\n") + "); process.exit(0); }",
    "let input = ''; process.stdin.on('data', (d) => { input += d; }); process.stdin.on('end', () => {",
    "  const mode = pick('FAKE_MODE') || 'ok';",
    "  if (mode === 'sleep') { setTimeout(() => {}, 60000); return; }",
    "  if (mode === 'exit1') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns' })); process.exit(1); }",
    "  const fmt = args[args.indexOf('--output-format') + 1];",
    "  if (fmt === 'json') {",
    "    if (mode === 'broken') { process.stdout.write('not json'); return; }",
    "    if (mode === 'iserror') { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution' })); return; }",
    "    const env = { type: 'result', is_error: false, result: pick('FAKE_RESULT') || 'free text answer' };",
    "    if (args.includes('--json-schema') && mode !== 'noso') env.structured_output = JSON.parse(pick('FAKE_SO') || '{\"results\":[]}');",
    "    process.stdout.write(JSON.stringify(env)); return;",
    "  }",
    "  process.stdout.write(pick('FAKE_TEXT') || 'old text answer for: ' + input.length);",
    "});",
  ].join("\n");
}
const FAKE_NEW = path.join(FIX, "fake-new.js"), FAKE_OLD = path.join(FIX, "fake-old.js"), FAKE_ANCIENT = path.join(FIX, "fake-ancient.js");
fs.writeFileSync(FAKE_NEW, fakeSrc("new", NEW_HELP, "2.1.296"));
fs.writeFileSync(FAKE_OLD, fakeSrc("old", OLD_HELP, "2.0.22"));
fs.writeFileSync(FAKE_ANCIENT, fakeSrc("ancient", ANCIENT_HELP, "0.2.9"));
const readLog = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const clearLog = () => { try { fs.unlinkSync(LOG); } catch {} };
const EMPTY_PATH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "chelp-nopath-"));
// 시험용 환경 — 실제 PATH·실제 Claude Code 위치를 쓰지 않는다(이 시험을 돌리는 대화의 값이 새지 않게)
const baseEnv = (extra) => Object.assign({ PATH: EMPTY_PATH_DIR, Path: EMPTY_PATH_DIR, PATHEXT: process.env.PATHEXT || "", SystemRoot: process.env.SystemRoot || "", TEMP: os.tmpdir(), TMP: os.tmpdir() }, extra || {});
const setRecorded = (p) => { if (p === null) { try { fs.unlinkSync(CH.CLAUDE_BIN_FILE); } catch {} } else fs.writeFileSync(CH.CLAUDE_BIN_FILE, p); };
const run = (env, schema, timeoutMs) => CH.runClaudeHelper({ prompt: "hello", timeoutMs: timeoutMs || 20000, schema, env }).promise;

t("배포·배선 — 새 모듈이 배포 목록 3곳에 있고, 선별 실행기 self 팔·입력 제출 훅·세 호출자가 연결돼 있다", () => {
  const lists = [fs.readFileSync(path.join(ROOT, "install.js"), "utf8"), fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8"), fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8")];
  assert.ok(lists.every((s) => s.includes('"claude-helper.js"')), "배포 목록 3곳");
  const rd = (f) => fs.readFileSync(path.join(ROOT, "bridge", f), "utf8");
  assert.ok(rd("selector-runner.js").includes('if (arm === "self") return CH.runClaudeHelper({ prompt, timeoutMs, schema })'), "self 팔 위임");
  assert.ok(rd("contract-inject.js").includes('require("./claude-helper.js").recordExecPath(process.env)'), "입력 제출 훅이 실행 파일 위치 기록");
  assert.ok(rd("classify.js").includes("schema: classifySchema(input)") && rd("curation.js").includes("schema: curationSchema()"), "분류·정리 담당이 틀을 넘김");
  assert.ok(rd("codex-bridge.js").includes("buildSchema: (pg) => CLx.selectorPageSchema(pg)") && rd("ask-job-worker.js").includes("buildSchema: (pg) => CL.selectorPageSchema(pg)"), "미리보기·검증 선별이 페이지 틀을 넘김");
  for (const f of ["classify.js", "curation.js", "codex-bridge.js", "ask-job-worker.js"]) assert.ok(rd(f).includes("reportHelperTier("), f + " — 대시보드 경보 배선");
});

// PATH 위의 claude — Windows=npm 셔틀(claude.cmd → node_modules/@anthropic-ai/claude-code/cli.js) · POSIX=절대 node 경로 shebang 실행 파일
function makePathClaude(variant, help, version) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "chelp-bin-"));
  const cli = path.join(binDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, fakeSrc(variant, help, version));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "claude.cmd"), '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  } else {
    const p = path.join(binDir, "claude"); fs.writeFileSync(p, "#!" + process.execPath + "\n" + fakeSrc(variant, help, version)); fs.chmodSync(p, 0o755);
  }
  return { binDir, cli };
}

t("후보 순서 — 덮어쓰기가 있으면 그것만 · 없으면 지금 대화의 Claude Code 위치 > 기록 파일 > PATH(npm 셔틀은 안의 스크립트를 node 로)", () => {
  const { binDir, cli } = makePathClaude("pathcli", OLD_HELP, "2.0.22");
  setRecorded(FAKE_OLD);
  const env = baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_NEW, PATH: binDir, Path: binDir });
  const c = CH.candidateList(env);
  assert.deepStrictEqual(c.map((x) => x.how), ["execpath", "recorded", "PATH"], "순서");
  assert.strictEqual(c[0].path, FAKE_NEW); assert.strictEqual(c[1].path, FAKE_OLD);
  if (process.platform === "win32") {
    const inv = CH.invocationFor(c[2].path);
    assert.ok(inv.node && !inv.viaShell && inv.args[0] === cli, "npm 셔틀 → 안의 cli.js 를 node 로(셸 경유 없음)");
    const bare = path.join(binDir, "other.cmd"); fs.writeFileSync(bare, "@echo off\r\nsomething.exe %*\r\n");
    assert.ok(CH.invocationFor(bare).viaShell, "진입점을 못 찾은 셔틀만 셸 경유");
  }
  const ov = CH.candidateList(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_ANCIENT, CLAUDE_CODE_EXECPATH: FAKE_NEW }));
  assert.deepStrictEqual(ov.map((x) => x.how), ["env:CODEX_BRIDGE_CLAUDE_BIN"], "덮어쓰기=그것만(결정론)");
  setRecorded(FAKE_NEW);
  assert.strictEqual(CH.candidateList(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_NEW })).length, 1, "같은 경로는 한 번만");
  assert.strictEqual(CH.candidateList(baseEnv({ CLAUDE_CODE_EXECPATH: path.join(FIX, "missing.exe") })).length, 1, "없는 위치는 후보 아님(기록 파일만)");
  setRecorded(null);
});

t("고르기 — 새 방식 우선 · 앞 후보가 새 방식이면 뒤 후보 도움말 미실행 · 옛 방식만 있으면 옛 방식 · 모두 부족=claude-too-old · 후보 없음=cli-missing · 기능 캐시", async () => {
  setRecorded(null); clearLog();
  const pNew = makePathClaude("pathnew", NEW_HELP, "2.1.300");
  const r1 = await CH.resolveClaudeHelper(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_OLD, PATH: pNew.binDir, Path: pNew.binDir }));
  assert.ok(r1.ok && r1.tier === "new" && r1.how === "PATH" && r1.version === "2.1.300", "앞 후보(옛)보다 새 방식 후보 우선");
  assert.strictEqual(fs.readFileSync(CH.CLAUDE_BIN_FILE, "utf8"), FAKE_OLD, "고르기는 지금 대화의 위치를 기록(그 위치가 옛 판이어도 사실 그대로)");
  await CH.resolveClaudeHelper(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_NEW })); // 첫 확인(캐시 채움)
  clearLog();
  const r2 = await CH.resolveClaudeHelper(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_NEW }));
  assert.ok(r2.ok && r2.tier === "new" && r2.how === "execpath");
  assert.strictEqual(readLog().filter((x) => x.args.includes("--help")).length, 0, "이미 확인한 실행 파일=캐시(도움말 재실행 없음)");
  setRecorded(FAKE_ANCIENT); clearLog();
  const r3 = await CH.resolveClaudeHelper(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_OLD }));
  assert.ok(r3.ok && r3.tier === "old" && r3.version === "2.0.22", "새 방식 후보가 없으면 옛 방식");
  setRecorded(null);
  const r4 = await CH.resolveClaudeHelper(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_ANCIENT }));
  assert.ok(!r4.ok && r4.key === "claude-too-old" && /0\.2\.9/.test(r4.detail), "최소 격리 옵션 없음=claude-too-old");
  const r5 = await CH.resolveClaudeHelper(baseEnv({}));
  assert.ok(!r5.ok && r5.key === "cli-missing", "후보 없음=cli-missing");
  // 앞 후보가 새 방식이면 뒤 후보는 확인하지 않는다 — 처음 보는 PATH 실행 파일(캐시 없음)로 확인
  const pFresh = makePathClaude("freshold", OLD_HELP, "2.0.22");
  setRecorded(null); clearLog();
  const r6 = await CH.resolveClaudeHelper(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_NEW, PATH: pFresh.binDir, Path: pFresh.binDir }));
  assert.ok(r6.ok && r6.tier === "new" && r6.how === "execpath");
  assert.strictEqual(CH.candidateList(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_NEW, PATH: pFresh.binDir, Path: pFresh.binDir })).length, 2, "뒤 후보는 있음");
  assert.strictEqual(readLog().filter((x) => x.variant === "freshold").length, 0, "뒤 후보 도움말 미실행");
  // 파일 캐시 — 실행 파일이 바뀌면(크기·수정 시각) 다시 확인
  const cache = JSON.parse(fs.readFileSync(CH.CAP_CACHE_FILE, "utf8"));
  assert.ok(Object.keys(cache).some((k) => k.startsWith(path.resolve(FAKE_NEW).toLowerCase() + "|")), "기능 캐시 파일 기록");
  fs.appendFileSync(FAKE_NEW, "\n// changed\n"); clearLog();
  await CH.resolveClaudeHelper(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_NEW }));
  assert.ok(readLog().some((x) => x.variant === "new" && x.args.includes("--help")), "실행 파일이 바뀌면 다시 확인");
  setRecorded(null);
});

t("새 방식 실행 — 인자(안전 모드·도구 0·MCP 끔·기록 안 남김·틀)·빈 임시 작업 폴더(끝나면 삭제)·현재 대화에 묶는 값 제거·로그인 위치/인증 값 유지·로그인 파일 무복사", async () => {
  clearLog();
  const schema = CF.classifySchema({ items: [{ ref: "u1" }], refs: {} });
  const r = await run(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_NEW, FAKE_SO: '{"results":[]}', CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent-sid", CLAUDE_CODE_EXECPATH: FAKE_NEW, CLAUDE_CODE_MESSAGING_TOKEN: "tok", CLAUDE_CONFIG_DIR: "C:/my-claude-config", CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep" }), schema);
  assert.ok(r.ok && r.output === '{"results":[]}', "틀 답을 한 줄 JSON 으로");
  assert.deepStrictEqual(r.runner, { tier: "new", version: "2.1.296", how: "env:CODEX_BRIDGE_CLAUDE_BIN" });
  const call = readLog().find((x) => x.args.includes("-p"));
  const a = call.args;
  for (const f of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(a.includes(f), f);
  assert.strictEqual(a[a.indexOf("--output-format") + 1], "json");
  assert.strictEqual(a[a.indexOf("--tools") + 1], "", "도구 0(빈 목록)");
  assert.deepStrictEqual(JSON.parse(a[a.indexOf("--json-schema") + 1]), schema, "호출자 틀 그대로");
  assert.ok(!a.includes("--disallowedTools") && !a.includes("--setting-sources"), "새 방식에 옛 인자 없음");
  assert.ok(path.basename(call.cwd).startsWith("claude-helper-") && call.files.length === 0, "빈 임시 작업 폴더");
  assert.ok(!fs.existsSync(call.cwd), "끝나면 삭제");
  assert.ok(!call.files.includes(".credentials.json"), "로그인 파일 복사 없음");
  assert.deepStrictEqual(call.env, { CLAUDE_CONFIG_DIR: "C:/my-claude-config", CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep" }, "세션·연결 통로·진입점 값 제거 · 로그인 위치·인증 값 유지");
  const src = fs.readFileSync(path.join(ROOT, "bridge", "claude-helper.js"), "utf8");
  assert.ok(!/credentials/.test(src) && !/CLAUDE_CONFIG_DIR\s*[:=]/.test(src), "★실행기 원본에 로그인 파일 복사·설정 폴더 바꾸기 경로 없음");
  // 틀 없이 부르면 결과 글
  const r2 = await run(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_NEW, FAKE_RESULT: "plain answer" }), null);
  assert.ok(r2.ok && r2.output === "plain answer");
});

t("답 꺼내기 실패 — 오류 봉투·깨진 봉투·틀 답 없음·종료 코드·시간 초과·취소는 모두 실패(성공으로 소비되지 않음)", async () => {
  const schema = { type: "object" };
  const e = (mode) => baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_NEW, FAKE_MODE: mode });
  const a = await run(e("iserror"), schema); assert.ok(!a.ok && a.key === "call-failed" && /is-error/.test(a.detail), "오류 봉투");
  const b = await run(e("broken"), schema); assert.ok(!b.ok && /envelope-unreadable/.test(b.detail), "깨진 봉투");
  const c = await run(e("noso"), schema); assert.ok(!c.ok && /no-structured-output/.test(c.detail), "틀 답 없음(결과 글로 대신하지 않음)");
  const d = await run(e("exit1"), schema); assert.ok(!d.ok && /exit=1/.test(d.detail) && /error_max_turns/.test(d.detail), "종료 코드 실패+사유");
  const f = await run(e("sleep"), schema, 1500); assert.ok(!f.ok && f.key === "call-failed", "시간 초과=종료·실패");
  const h = CH.runClaudeHelper({ prompt: "x", timeoutMs: 20000, schema, env: e("sleep") });
  setTimeout(() => h.cancel(), 800);
  const g = await h.promise; assert.ok(!g.ok && g.key === "cancelled" && g.cancelled, "취소");
  assert.deepStrictEqual(CH.extractAnswer("new", JSON.stringify({ is_error: false, structured_output: [1] }), schema).ok, false, "틀 답이 배열이면 실패");
});

t("옛 방식 — 최소 격리 인자(MCP 끔·사용자 설정 안 읽음·도구 끔·빈 작업 폴더)·틀 인자 없음 · 너무 오래된 판은 실행하지 않음", async () => {
  clearLog();
  const r = await run(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_OLD, FAKE_TEXT: '{"relevant":[]}' }), { type: "object" });
  assert.ok(r.ok && r.output === '{"relevant":[]}' && r.runner.tier === "old" && r.runner.version === "2.0.22");
  const call = readLog().find((x) => x.args.includes("-p"));
  assert.deepStrictEqual(call.args, ["-p", "--output-format", "text", "--setting-sources", "project", "--disallowedTools", CH.SELF_DENY, "--strict-mcp-config"], "옛 방식 인자 그대로");
  assert.ok(path.basename(call.cwd).startsWith("claude-helper-") && call.files.length === 0, "빈 임시 작업 폴더(사용자 설정만 안 읽힘 — project 출처에 읽을 것 없음)");
  clearLog();
  const z = await run(baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: FAKE_ANCIENT }), null);
  assert.ok(!z.ok && z.key === "claude-too-old" && z.runner.version === "0.2.9", "너무 오래됨=실패·판 기록");
  assert.ok(!readLog().some((x) => x.args.includes("-p")), "★실행하지 않음(-p 호출 0)");
  setRecorded(null);
  const nn = await run(baseEnv({}), null);
  assert.ok(!nn.ok && nn.key === "cli-missing", "후보 없음");
});

t("실행 파일 위치 기록 — 있으면 기록(바뀔 때만)·없는 위치는 기록 안 함 · 고르기 때도 기록", async () => {
  setRecorded(null);
  assert.strictEqual(CH.recordExecPath({ CLAUDE_CODE_EXECPATH: path.join(FIX, "nope.exe") }), false);
  assert.ok(!fs.existsSync(CH.CLAUDE_BIN_FILE), "없는 위치는 기록 안 함");
  assert.strictEqual(CH.recordExecPath({ CLAUDE_CODE_EXECPATH: FAKE_NEW }), true);
  assert.strictEqual(fs.readFileSync(CH.CLAUDE_BIN_FILE, "utf8"), FAKE_NEW);
  const m0 = fs.statSync(CH.CLAUDE_BIN_FILE).mtimeMs;
  assert.strictEqual(CH.recordExecPath({ CLAUDE_CODE_EXECPATH: FAKE_NEW }), true);
  assert.strictEqual(fs.statSync(CH.CLAUDE_BIN_FILE).mtimeMs, m0, "같으면 다시 쓰지 않음");
  setRecorded(null);
  await CH.resolveClaudeHelper(baseEnv({ CLAUDE_CODE_EXECPATH: FAKE_OLD }));
  assert.strictEqual(fs.readFileSync(CH.CLAUDE_BIN_FILE, "utf8"), FAKE_OLD, "고르기 때도 기록");
  setRecorded(null);
});

t("대시보드 경보 — 옛 방식·너무 오래됨은 한 번만(확인한 경보를 되살리지 않음) · 새 방식이면 지움 · 다른 작업공간 경보는 그대로", () => {
  const WS = "D:/proj-a", WS2 = "D:/proj-b";
  const evs = () => CL.readIntegrityEvents().filter((e) => e.kind === CH.ALARM_KIND);
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.22", how: "PATH" } });
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.22", how: "PATH" } });
  assert.strictEqual(evs().length, 1, "같은 판·같은 이유는 한 번");
  assert.ok(/2\.0\.22/.test(evs()[0].detailKo) && evs()[0].severity === "warning" && evs()[0].sig === "old@2.0.22");
  CL.ackIntegrityEvents([evs()[0].id]);
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.22", how: "PATH" } });
  assert.strictEqual(evs().filter((e) => !e.ack).length, 0, "확인한 경보를 매 실행 되살리지 않음");
  CH.reportHelperTier(WS2, { ok: false, key: "claude-too-old", runner: { tier: "", version: "0.2.9", how: "" } });
  assert.ok(evs().some((e) => e.workspace === WS2 && e.sig === "too-old@0.2.9" && /실행하지 않았습니다/.test(e.detailKo)), "너무 오래됨 경보");
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "new", version: "2.1.296", how: "execpath" } });
  assert.ok(evs().some((e) => e.workspace === WS2 && !e.ack), "다른 작업공간 경보 유지");
  CH.reportHelperTier(WS2, { ok: true, runner: { tier: "new", version: "2.1.296", how: "execpath" } });
  assert.strictEqual(evs().filter((e) => !e.ack).length, 0, "새 방식이면 미확인 경보 지움");
  CH.reportHelperTier(WS, { ok: false, key: "call-failed", runner: { tier: "new" } });
  CH.reportHelperTier(WS, { ok: false, key: "cli-missing", runner: { tier: "" } });
  assert.strictEqual(evs().filter((e) => !e.ack).length, 0, "다른 실패는 이 경보와 무관(호출자 기존 경보가 맡음)");
});

t("호출자별 틀 — 빈 열거 없음 · 틀 답(한 줄 JSON)이 엄격 판독기를 그대로 통과", () => {
  const sNo = CF.classifySchema({ items: [{ ref: "u1" }, { ref: "u2" }], refs: {} });
  const it = sNo.properties.results.items;
  assert.deepStrictEqual(it.properties.ref.enum, ["u1", "u2"]); assert.ok(!("enum" in it.properties.itemRef), "번호 목록이 비면 열거 없음");
  assert.deepStrictEqual(it.properties.kind.enum, ["boundary", "emphasis", "style"]);
  assert.strictEqual(sNo.properties.results.maxItems, 5);
  const sRef = CF.classifySchema({ items: [{ ref: "u1" }], refs: { B1: "x" } });
  assert.deepStrictEqual(sRef.properties.results.items.properties.itemRef.enum, ["B1"]);
  const W = "앞으로 이 프로젝트 검증에서 실기기로 확인하지 않은 점은 결함으로 보지 마";
  const input = { items: [{ ref: "u1", id: "w1", text: W, shown: W }], refs: {} };
  const so = { results: [{ ref: "u1", kind: "boundary", quote: W, seat: "outOfScope", why: "검증 판정 범위를 정하는 기준", bounds: "실기기 미확인은 결함 판정에서 제외" }] };
  const p = CF.parseClassifyOutput(JSON.stringify(so), input);
  assert.ok(p.ok && p.items.length === 1 && p.items[0].seat === "outOfScope", "분류 틀 답 → 판독 통과");
  const pg = CL.selectorPageSchema([{ id: "arc-1" }, { id: "arc-2" }]);
  assert.deepStrictEqual(pg.properties.relevant.items.enum, ["arc-1", "arc-2"]);
  assert.ok(!("enum" in CL.selectorPageSchema([]).properties.relevant.items), "빈 페이지=열거 없음");
  const ps = CL.parseSelectorPageOutput(JSON.stringify({ relevant: ["arc-2"] }), ["arc-1", "arc-2"]);
  assert.ok(ps.ok && ps.ids[0] === "arc-2", "선별 틀 답(한 줄) → 엄격 판독 통과");
  const cs = CU.curationSchema();
  assert.deepStrictEqual(cs.required, ["proposals"]); assert.strictEqual(cs.properties.proposals.maxItems, CU.CURATION_MAX_PER_RUN);
  assert.deepStrictEqual(cs.properties.proposals.items.properties.operation.enum, CU.CURATION_OPERATIONS);
  const cin = { signals: { oosRepeat: [], lineage: [], escalation: [], unusedOos: [], unusedRules: [], rebutUsed: [], selOver: { count: 0 } }, decisions: { open: [], answered: [] }, rules: { core: [], archive: [] } };
  const pc = CU.parseCurationOutput(JSON.stringify({ proposals: [] }), cin);
  assert.ok(pc.ok && pc.items.length === 0, "정리 담당 틀 답(제안 없음) → 판독 통과");
  const walk = (o) => { if (!o || typeof o !== "object") return; if (Array.isArray(o.enum)) assert.ok(o.enum.length > 0, "빈 열거 금지"); for (const v of Object.values(o)) walk(v); };
  for (const s9 of [sNo, sRef, pg, cs]) walk(s9);
});

t("페이지 루프·선별 실행기 — buildSchema 가 페이지마다 틀을 넘기고(없으면 안 넘김) · self 팔은 도우미 실행기로 실제 위임", async () => {
  const seen = [];
  const fake = (o) => { seen.push(o); return { promise: Promise.resolve({ ok: true, output: '{"relevant":[]}' }), cancel() {} }; };
  const pages = [[{ id: "a1" }], [{ id: "a2" }, { id: "a3" }]];
  const r = await SR.runSelectorPages({ arm: "self", pages, buildPrompt: () => "p", buildSchema: (pg) => CL.selectorPageSchema(pg), timeoutMs: 1000, parallel: 2, pageRunner: fake, pollMs: 50 });
  assert.strictEqual(r.st, "ok");
  assert.deepStrictEqual(seen.map((o) => o.schema.properties.relevant.items.enum).sort(), [["a1"], ["a2", "a3"]].sort());
  seen.length = 0;
  await SR.runSelectorPages({ arm: "self", pages: [[{ id: "a1" }]], buildPrompt: () => "p", timeoutMs: 1000, parallel: 1, pageRunner: fake, pollMs: 50 });
  assert.ok(!("schema" in seen[0]), "buildSchema 없으면 틀 안 넘김(정찰·Codex 팔 무변경)");
  const keep = { b: process.env.CODEX_BRIDGE_CLAUDE_BIN, so: process.env.FAKE_SO };
  process.env.CODEX_BRIDGE_CLAUDE_BIN = FAKE_NEW; process.env.FAKE_SO = '{"relevant":["a1"]}';
  try {
    const h = SR.runSelectorPage({ arm: "self", prompt: "p", timeoutMs: 20000, schema: CL.selectorPageSchema([{ id: "a1" }]) });
    const rr = await h.promise;
    assert.ok(rr.ok && rr.output === '{"relevant":["a1"]}' && rr.runner.tier === "new", "self 팔 실제 위임");
  } finally {
    if (keep.b === undefined) delete process.env.CODEX_BRIDGE_CLAUDE_BIN; else process.env.CODEX_BRIDGE_CLAUDE_BIN = keep.b;
    if (keep.so === undefined) delete process.env.FAKE_SO; else process.env.FAKE_SO = keep.so;
  }
  assert.strictEqual(SR.SELF_DENY, CH.SELF_DENY); assert.strictEqual(SR.killTree, CH.killTree);
});

t("[구현 검증 1회차 blocker①] npm 셔틀은 그대로이고 안의 스크립트만 업데이트돼도 기능을 다시 확인한다(캐시 열쇠에 안 스크립트 지문 포함)", async () => {
  setRecorded(null);
  const p = makePathClaude("shimupd", OLD_HELP, "2.0.22");
  const env = baseEnv({ PATH: p.binDir, Path: p.binDir });
  const a = await CH.resolveClaudeHelper(env);
  assert.ok(a.ok && a.tier === "old" && a.version === "2.0.22", "업데이트 전=옛 방식");
  fs.writeFileSync(p.cli, fakeSrc("shimupd2", NEW_HELP, "2.1.296") + "\n// updated inner script\n"); // 셔틀(.cmd)은 그대로, 안 cli.js 만 교체
  if (process.platform !== "win32") { const lp = path.join(p.binDir, "claude"); fs.writeFileSync(lp, "#!" + process.execPath + "\n" + fakeSrc("shimupd2", NEW_HELP, "2.1.296")); fs.chmodSync(lp, 0o755); }
  const b = await CH.resolveClaudeHelper(env);
  assert.ok(b.ok && b.tier === "new" && b.version === "2.1.296", "업데이트 뒤=새 방식(옛 캐시를 쓰지 않음)");
  if (process.platform === "win32") {
    const inv = CH.invocationFor(path.join(p.binDir, "claude.cmd"));
    const key = Object.keys(JSON.parse(fs.readFileSync(CH.CAP_CACHE_FILE, "utf8"))).find((k) => k.startsWith(path.resolve(path.join(p.binDir, "claude.cmd")).toLowerCase() + "|") && k.includes(path.resolve(inv.args[0]).toLowerCase()));
    assert.ok(key, "캐시 열쇠=셔틀 지문+안 스크립트 지문");
  }
});

t("[구현 검증 1회차 blocker②] 기능 확인도 호출 시간 상한 안 · 핸들은 즉시 반환 · 확인 도중 취소하면 바로 끝남", async () => {
  const slowA = path.join(FIX, "slow-help-a.js"); fs.writeFileSync(slowA, fakeSrc("slowa", NEW_HELP, "2.1.296"));
  const t0 = Date.now();
  const h = CH.runClaudeHelper({ prompt: "x", timeoutMs: 1000, schema: null, env: baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: slowA, FAKE_HELP_SLEEP: "5000" }) });
  assert.ok(Date.now() - t0 < 300, "핸들 즉시 반환(기능 확인이 반환 전에 막지 않음)");
  const r = await h.promise;
  const el = Date.now() - t0;
  assert.ok(!r.ok && r.key === "call-failed" && /capability-timeout/.test(r.detail), "상한 안에서 실패: " + r.key + " " + r.detail);
  assert.ok(el < 3500, "전체 1초 상한 근처에서 끝남(도움말 5초를 기다리지 않음): " + el + "ms");
  const slowB = path.join(FIX, "slow-help-b.js"); fs.writeFileSync(slowB, fakeSrc("slowb", NEW_HELP, "2.1.296"));
  const t1 = Date.now();
  const h2 = CH.runClaudeHelper({ prompt: "x", timeoutMs: 60000, schema: null, env: baseEnv({ CODEX_BRIDGE_CLAUDE_BIN: slowB, FAKE_HELP_SLEEP: "20000" }) });
  setTimeout(() => h2.cancel(), 400);
  const r2 = await h2.promise;
  assert.ok(!r2.ok && r2.key === "cancelled" && r2.cancelled, "확인 도중 취소=cancelled");
  assert.ok(Date.now() - t1 < 5000, "취소가 도움말 실행을 끊음: " + (Date.now() - t1) + "ms");
  // 확인 단계에서 끊긴 결과는 캐시에 남지 않는다(다음 호출이 다시 확인)
  const cache = (() => { try { return JSON.parse(fs.readFileSync(CH.CAP_CACHE_FILE, "utf8")); } catch { return {}; } })();
  assert.ok(!Object.keys(cache).some((k) => k.startsWith(path.resolve(slowA).toLowerCase() + "|") || k.startsWith(path.resolve(slowB).toLowerCase() + "|")), "끊긴 확인은 캐시하지 않음");
});

t("[구현 검증 1회차 blocker③] 확인한 경보는 경보 목록이 최근 50건으로 잘려도 다시 뜨지 않음 · 새 방식으로 풀리면 기억을 비워 다시 오래되면 다시 알림", () => {
  const WS = "D:/proj-once";
  const mine = () => CL.readIntegrityEvents().filter((e) => e.kind === CH.ALARM_KIND && e.workspace === WS);
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.22", how: "PATH" } });
  assert.strictEqual(mine().length, 1);
  CL.ackIntegrityEvents(mine().map((e) => e.id));
  for (let i = 0; i < 60; i++) CL.appendIntegrityEvent({ ts: new Date().toISOString(), session: "", workspace: "D:/other", kind: "verdict-nonclean", severity: "warning", detail: "x" + i });
  assert.strictEqual(mine().length, 0, "(전제) 확인한 경보가 목록에서 밀려남");
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.22", how: "PATH" } });
  assert.strictEqual(mine().length, 0, "★같은 판·같은 이유는 다시 뜨지 않음");
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.30", how: "PATH" } });
  assert.strictEqual(mine().length, 1, "판이 바뀌면 새 경보");
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "new", version: "2.1.296", how: "execpath" } });
  assert.strictEqual(mine().filter((e) => !e.ack).length, 0, "새 방식=미확인 경보 지움");
  CH.reportHelperTier(WS, { ok: true, runner: { tier: "old", version: "2.0.22", how: "PATH" } });
  assert.strictEqual(mine().filter((e) => !e.ack).length, 1, "풀린 뒤 다시 오래되면 다시 알림(기억을 비웠으므로)");
  const once = JSON.parse(fs.readFileSync(CL.INTEGRITY_ONCE_FILE, "utf8"));
  assert.ok(Object.keys(once).some((k) => k.startsWith(CH.ALARM_KIND + "|") && k.endsWith("|old@2.0.22")), "한 번만 기록 파일");
});

t("[구현 검증 1회차 보완] 대시보드 요약·상태 표시줄이 도우미 경보를 '근거 의심'으로 세지 않고 따로 표시한다", () => {
  const ts = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(ts.includes('const nHelper = warnEvs.filter(function(e){return e.kind==="claude-helper-old";}).length;') && /const nEvid = warnEvs\.length - [^;]*- nHelper;/.test(ts), "대시보드 요약: 근거 의심에서 제외");
  assert.ok(ts.includes('if (nHelper) warnParts.push(T("도우미가 쓰는 Claude Code 오래됨 "+nHelper+"건"'), "대시보드 요약: 따로 표시");
  assert.ok(ts.includes('const nHelper = warns.filter((e) => e.kind === "claude-helper-old").length;') && /const nEvid = warns\.length - [^;]*- nHelper;/.test(ts) && ts.includes(', nHelper > 0].filter(Boolean).length;'), "상태 표시줄: 근거 의심에서 제외·종류 수");
  assert.ok(ts.includes(': nHelper ? tE("도우미 Claude Code 오래됨","Helper Claude Code outdated")') && ts.includes('if (nHelper) parts.push(tE(`도우미가 쓰는 Claude Code 오래됨 ${nHelper}건`'), "상태 표시줄: 이름·설명");
  assert.strictEqual(CH.ALARM_KIND, "claude-helper-old");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
