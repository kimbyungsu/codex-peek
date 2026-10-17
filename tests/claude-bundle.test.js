"use strict";
/*
 * [도우미 판 따라가기 · 2026-10-17] 확장이 '이 창에 올라온 Claude Code 확장'의 실행 파일 위치를 claude-bin.txt 에 기록 —
 * 훅 쪽 기록이 판 전환(업데이트 2.1.296→2.1.301 · 되돌리기 2.1.301→2.1.295)을 따라가지 못해, 훅이 띄운 도우미가 옛 판을 쓰고
 * 그 폴더가 지워지면 PATH 의 아주 옛 판으로 떨어지던 문제.
 * 폴더 모양 찾기(Claude 확장이 스스로 찾는 순서) · 확장 고르기 · 기록(다를 때만·못 찾으면 그대로) · 확장 산출물 연결 실행 ·
 * 도우미 실행기가 그 기록을 실제 후보로 집는지(별도 프로세스 · 임시 브릿지 폴더).
 * 격리: 임시 폴더 · 실제 사용자 기록·Claude 실행 무접촉.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const B = require("../out/claude-bundle.js");
const OUT = path.join(ROOT, "out", "extension.js");
const src = fs.readFileSync(OUT, "utf8");
const slice = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, "조각 " + a); return src.slice(i, j); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bundle-"));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✅ " + name); };
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "x"); return p; };
const ex = (p) => fs.existsSync(p);
const extDir = (name) => path.join(TMP, "ext", name);

console.log("[1] 폴더 모양 — Claude 확장이 스스로 찾는 순서(플랫폼별 → Windows arm64 는 x64 → 단일 폴더)");
t("단일 폴더(native-binary)만 있으면 그것", () => {
  const d = extDir("a"); const p = mk(path.join(d, "resources", "native-binary", "claude.exe"));
  assert.strictEqual(B.bundledClaudeIn(d, "win32", "x64", ex), p);
});
t("플랫폼별 폴더와 단일 폴더가 둘 다 있으면 플랫폼별 폴더가 먼저", () => {
  const d = extDir("b"); mk(path.join(d, "resources", "native-binary", "claude.exe"));
  const p = mk(path.join(d, "resources", "native-binaries", "win32-x64", "claude.exe"));
  assert.strictEqual(B.bundledClaudeIn(d, "win32", "x64", ex), p);
});
t("Windows arm64 는 arm64 폴더가 없으면 x64 폴더", () => {
  const d = extDir("c"); const p = mk(path.join(d, "resources", "native-binaries", "win32-x64", "claude.exe"));
  assert.strictEqual(B.bundledClaudeIn(d, "win32", "arm64", ex), p);
  assert.strictEqual(B.bundledClaudeIn(d, "linux", "arm64", ex), "", "Windows 가 아니면 x64 폴더로 넘어가지 않음");
});
t("리눅스는 확장자 없는 이름 · musl 폴더도 찾음", () => {
  const d = extDir("d"); const p = mk(path.join(d, "resources", "native-binaries", "linux-x64-musl", "claude"));
  assert.strictEqual(B.bundledClaudeIn(d, "linux", "x64", ex), p);
  assert.strictEqual(B.bundledClaudeIn(d, "win32", "x64", ex), "", "Windows 는 claude.exe 만");
});
t("실행 파일이 없거나 확장 경로가 비면 빈 값 · 확인 함수가 던져도 빈 값", () => {
  const d = extDir("e"); fs.mkdirSync(path.join(d, "resources"), { recursive: true });
  assert.strictEqual(B.bundledClaudeIn(d, "win32", "x64", ex), "");
  assert.strictEqual(B.bundledClaudeIn("", "win32", "x64", ex), "");
  assert.strictEqual(B.bundledClaudeIn(d, "win32", "x64", () => { throw new Error("x"); }), "");
});

console.log("[2] 확장 고르기 — 실행 파일을 품은 확장 · 이 창에서 활성화된 것 우선 · 자기 자신 제외(이름·판 번호로 고정하지 않음)");
const plain = { id: "x.plain", extensionPath: extDir("e"), isActive: true };
const off = { id: "p.cc-old", extensionPath: extDir("a"), isActive: false };
const on = { id: "p.cc-new", extensionPath: extDir("b"), isActive: true };
t("실행 파일 없는 확장은 건너뛰고, 활성화된 것을 고른다(목록 순서보다 우선)", () => {
  const h = B.pickClaudeBundle([plain, off, on], "", "win32", "x64", ex);
  assert.deepStrictEqual(h, { path: path.join(extDir("b"), "resources", "native-binaries", "win32-x64", "claude.exe"), id: "p.cc-new", active: true });
});
t("활성화된 것이 없으면 목록 순서 첫째", () => {
  const h = B.pickClaudeBundle([plain, off, Object.assign({}, on, { isActive: false })], "", "win32", "x64", ex);
  assert.strictEqual(h.id, "p.cc-old");
});
t("자기 자신(대소문자 무관)은 실행 파일이 있어도 제외 · 아무것도 없으면 null", () => {
  assert.strictEqual(B.pickClaudeBundle([on], "P.CC-NEW", "win32", "x64", ex), null);
  assert.strictEqual(B.pickClaudeBundle([plain, null, { id: "z", extensionPath: "" }], "", "win32", "x64", ex), null);
  assert.strictEqual(B.pickClaudeBundle(undefined, "", "win32", "x64", ex), null);
});

console.log("[3] 기록 — 찾았고 다를 때만 쓴다 · 못 찾으면 기존 기록을 지우지 않는다 · 쓰기 실패는 실패로");
const REC = path.join(TMP, "home1", "claude-bin.txt");
const io = { read: (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } }, write: (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, d); return true; } };
const opt = (o) => Object.assign({ file: REC, selfId: "me.bridge", platform: "win32", arch: "x64", exists: ex, io }, o || {});
t("기록이 없으면 씀", () => {
  const r = B.syncClaudeBinFrom([plain, on], opt());
  assert.strictEqual(r.state, "written"); assert.strictEqual(fs.readFileSync(REC, "utf8"), r.path);
});
t("같으면 쓰지 않음(쓰기 함수 호출 없음)", () => {
  let wrote = 0; const r = B.syncClaudeBinFrom([on], opt({ io: { read: io.read, write: () => { wrote++; return true; } } }));
  assert.strictEqual(r.state, "same"); assert.strictEqual(wrote, 0);
});
t("되돌리기 장면: 기록이 옛 확장(지워질 폴더)을 가리키면 지금 올라온 확장 위치로 바꿈", () => {
  const stale = path.join(extDir("gone-2.1.301"), "resources", "native-binary", "claude.exe");
  fs.writeFileSync(REC, stale);
  const now = { id: "p.cc", extensionPath: extDir("a"), isActive: true };
  const r = B.syncClaudeBinFrom([now], opt());
  assert.strictEqual(r.state, "written"); assert.strictEqual(fs.readFileSync(REC, "utf8"), path.join(extDir("a"), "resources", "native-binary", "claude.exe"));
});
t("못 찾으면 기존 기록 그대로(터미널 Claude Code 처럼 도구 실행이 남긴 기록 보존)", () => {
  fs.writeFileSync(REC, "C:/term/claude.exe");
  const r = B.syncClaudeBinFrom([plain], opt());
  assert.strictEqual(r.state, "none"); assert.strictEqual(fs.readFileSync(REC, "utf8"), "C:/term/claude.exe");
});
t("쓰기 실패(거짓 반환·예외)는 failed · 기록 불변 · 읽기 예외는 '기록 없음'으로", () => {
  fs.writeFileSync(REC, "C:/term/claude.exe");
  assert.strictEqual(B.syncClaudeBinFrom([on], opt({ io: { read: io.read, write: () => false } })).state, "failed");
  assert.strictEqual(B.syncClaudeBinFrom([on], opt({ io: { read: io.read, write: () => { throw new Error("w"); } } })).state, "failed");
  assert.strictEqual(fs.readFileSync(REC, "utf8"), "C:/term/claude.exe");
  let wrote = ""; const r = B.syncClaudeBinFrom([on], opt({ io: { read: () => { throw new Error("r"); }, write: (f, d) => { wrote = d; return true; } } }));
  assert.strictEqual(r.state, "written"); assert.strictEqual(wrote, r.path);
});

console.log("[4] 확장 산출물 연결 — out/extension.js 의 syncClaudeBin 을 실제로 실행(vscode 확장 목록만 대역) · 활성화 때 호출+목록 변경 구독");
const run = new Function("vscode", "path", "fs", "process", "BRIDGE_DIR", "claude_bundle_1", "console",
  slice("function readTextSafe(", "\n}\n") + "\n}\n" + slice("function atomicWrite(", "\n}\n") + "\n}\n" + slice("function syncClaudeBin(", "\n}\n") + "\n}\nreturn syncClaudeBin;");
const HOME2 = path.join(TMP, "home2");
const vsc = (list) => ({ extensions: { all: list.map((e) => ({ id: e.id, extensionPath: e.extensionPath, isActive: e.isActive, packageJSON: {} })) } });
t("이 창 확장 목록에서 찾은 위치를 브릿지 폴더의 claude-bin.txt 에 씀 · 자기 자신 제외 · 같으면 그대로", () => {
  const self = { id: "me.bridge", extensionPath: extDir("b"), isActive: true }; // 자기 자신이 실행 파일을 품은 척해도 제외
  const fn = run(vsc([plain, self, off]), path, fs, { platform: "win32", arch: "x64", pid: 1 }, HOME2, B, console);
  fn("me.bridge");
  const f = path.join(HOME2, "claude-bin.txt");
  assert.strictEqual(fs.readFileSync(f, "utf8"), path.join(extDir("a"), "resources", "native-binary", "claude.exe"));
  const m1 = fs.statSync(f).mtimeMs; fn("me.bridge"); assert.strictEqual(fs.statSync(f).mtimeMs, m1, "같으면 다시 쓰지 않음");
});
t("확장 목록 판독이 던져도 활성화를 막지 않음(조용히 넘어감)", () => {
  const bad = { extensions: { get all() { throw new Error("boom"); } } };
  const fn = run(bad, path, fs, { platform: "win32", arch: "x64", pid: 1 }, HOME2, B, console);
  assert.doesNotThrow(() => fn("me.bridge"));
});
t("활성화 때 호출하고 확장 목록 변경(설치·업데이트·되돌리기)을 구독 — codex 위치 기록 바로 뒤", () => {
  const act = slice("function activate(context)", "ensureLangInitialized();");
  // 줄 첫머리(공백 뒤)에서 시작하는 실제 문장만 — 주석으로 막아 둔 줄은 호출로 치지 않는다
  const at = (re) => { const m = re.exec(act); return m ? m.index : -1; };
  const i = at(/^[ \t]*syncCodexBin\(\);/m), j = at(/^[ \t]*syncClaudeBin\(context\.extension\.id\);/m);
  const k = at(/^[ \t]*context\.subscriptions\.push\(vscode\.extensions\.onDidChange\(\(\) => \{ syncCodexBin\(\); syncClaudeBin\(context\.extension\.id\); \}\)\);/m);
  assert.ok(i >= 0 && j > i && k > j, "활성화 순서 syncCodexBin → syncClaudeBin → 목록 변경 구독(Codex·Claude 둘 다 · 구독 해제 등록 포함)");
});

console.log("[5] 도우미 실행기가 그 기록을 실제 후보로 집음 — 지금 대화 위치 값이 없는 실행(훅·확장이 띄운 실행)과 같은 조건 · 별도 프로세스");
t("되돌리기 뒤 확장 기록 → 도우미 첫 후보가 지금 올라온 확장의 실행 파일(how=recorded) · 지워진 옛 폴더는 후보 아님", () => {
  const home = path.join(TMP, "home3"); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "claude-bin.txt"), path.join(extDir("gone-2.1.301"), "resources", "native-binary", "claude.exe"));
  const emptyBin = path.join(TMP, "emptybin"); fs.mkdirSync(emptyBin, { recursive: true });
  const probe = (label) => {
    const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: home, PATH: emptyBin, Path: emptyBin });
    delete env.CLAUDE_CODE_EXECPATH; delete env.CODEX_BRIDGE_CLAUDE_BIN;
    const code = "const H=require(" + JSON.stringify(path.join(ROOT, "bridge", "claude-helper.js")) + ");console.log(JSON.stringify(H.candidateList(Object.assign({},process.env))));";
    const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8", timeout: 30000 });
    assert.strictEqual(r.status, 0, label + " " + r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  assert.deepStrictEqual(probe("전"), [], "옛 폴더가 지워졌고 PATH 에도 없으면 후보 없음(실제 사고에선 여기서 PATH 의 옛 판)");
  const r = B.syncClaudeBinFrom([{ id: "p.cc", extensionPath: extDir("a"), isActive: true }], opt({ file: path.join(home, "claude-bin.txt") }));
  assert.strictEqual(r.state, "written");
  assert.deepStrictEqual(probe("후"), [{ path: path.join(extDir("a"), "resources", "native-binary", "claude.exe"), how: "recorded" }]);
});

console.log("[6] 지도 준비 점검(self)도 같은 고르기 — 종전엔 PATH 의 claude 를 직접 실행해 실제 보강과 다른(옛) 판을 근거로 삼았다 · 별도 프로세스");
{
  const FAKE = path.join(TMP, "fakes"); fs.mkdirSync(FAKE, { recursive: true });
  const NEW_HELP = "Options:\n  --output-format\n  --safe-mode\n  --tools\n  --strict-mcp-config\n  --no-session-persistence\n  --json-schema\n  --model\n  --setting-sources\n  --disallowedTools\n";
  const OLD_HELP = "Options:\n  --output-format\n  --strict-mcp-config\n  --setting-sources\n  --disallowedTools\n";
  const fakeJs = (name, ver, help) => { const f = path.join(FAKE, name); fs.writeFileSync(f, "const a=process.argv.slice(2);if(a.includes('--version')){console.log(" + JSON.stringify(ver + " (Claude Code)") + ");process.exit(0)}if(a.includes('--help')){process.stdout.write(" + JSON.stringify(help) + ");process.exit(0)}process.exit(3);\n"); return f; };
  const fNew = fakeJs("cc-new.js", "7.7.7", NEW_HELP), fNew2 = fakeJs("cc-new2.js", "8.8.8", NEW_HELP), fOld = fakeJs("cc-old.js", "1.0.0", OLD_HELP);
  const binOld = path.join(TMP, "bin-old"); fs.mkdirSync(binOld, { recursive: true }); // PATH 의 옛 판(명령줄에 남은 npm 판 흉내)
  if (process.platform === "win32") fs.writeFileSync(path.join(binOld, "claude.cmd"), "@\"" + process.execPath + "\" \"%~dp0\\..\\fakes\\cc-old.js\" %*\r\n");
  else { const f = path.join(binOld, "claude"); fs.writeFileSync(f, "#!/bin/sh\nexec \"" + process.execPath + "\" \"" + fOld + "\" \"$@\"\n"); fs.chmodSync(f, 0o755); }
  const binEmpty = path.join(TMP, "bin-empty"); fs.mkdirSync(binEmpty, { recursive: true });
  const ADAPTER = path.join(ROOT, "bridge", "enrich-providers.js");
  const probe = (label, home, pathDir, extra) => {
    fs.mkdirSync(home, { recursive: true });
    const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: home, PATH: pathDir, Path: pathDir }, extra || {});
    if (!extra || !("CLAUDE_CODE_EXECPATH" in extra)) delete env.CLAUDE_CODE_EXECPATH;
    delete env.CODEX_BRIDGE_CLAUDE_BIN;
    const code = "const MP=require(" + JSON.stringify(path.join(ROOT, "bridge", "map-probe.js")) + ");const r=MP.probeSelf({adapterHint:" + JSON.stringify(ADAPTER) + "});console.log(JSON.stringify({ver:r.ver,ok:r.rec.ok,detail:r.rec.detail,cliVer:r.rec.cliVer,wrote:r.write.ok}));";
    const r = spawnSync(process.execPath, ["-e", code], { env, encoding: "utf8", timeout: 120000 });
    assert.strictEqual(r.status, 0, label + " " + r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  t("기록된 위치(확장이 적은 지금 판)가 있으면 PATH 의 옛 판 대신 그 판으로 점검 — 준비 기록 판도 같음", () => {
    const home = path.join(TMP, "p-home1"); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, "claude-bin.txt"), fNew);
    const r = probe("기록", home, binOld);
    assert.strictEqual(r.ver, "7.7.7 (Claude Code)"); assert.strictEqual(r.ok, true); assert.strictEqual(r.wrote, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, "map-readiness.json"), "utf8")).self.cliVer, "7.7.7 (Claude Code)");
  });
  t("(대조) 기록이 없으면 PATH 의 판 — 고르기 순서 그대로(옛 판도 옛 방식으로 실행 가능하면 준비)", () => {
    const r = probe("PATH", path.join(TMP, "p-home2"), binOld);
    assert.strictEqual(r.ver, "1.0.0 (Claude Code)"); assert.strictEqual(r.ok, true);
  });
  t("지금 대화 위치 값이 있으면 그것이 기록보다 먼저(도우미와 같은 순서)", () => {
    const home = path.join(TMP, "p-home3"); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, "claude-bin.txt"), fNew);
    const r = probe("execpath", home, binOld, { CLAUDE_CODE_EXECPATH: fNew2 });
    assert.strictEqual(r.ver, "8.8.8 (Claude Code)");
  });
  t("PATH 에 없어도 기록이 있으면 준비(종전엔 '명령줄 없음'으로 실패) · 아무것도 없으면 실행 없이 cli-not-found", () => {
    const home = path.join(TMP, "p-home4"); fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, "claude-bin.txt"), fNew);
    assert.strictEqual(probe("기록만", home, binEmpty).ver, "7.7.7 (Claude Code)");
    const r = probe("없음", path.join(TMP, "p-home5"), binEmpty);
    assert.strictEqual(r.ver, null); assert.strictEqual(r.ok, false); assert.ok(/^cli-not-found/.test(r.detail), r.detail);
  });
  t("시험·호출자가 명령을 직접 넘기면 종전 경로(이름을 PATH 에서 해석) 그대로", () => {
    const MP = require("../bridge/map-probe.js");
    const tt = MP.selfTarget({ claudeCmd: process.execPath, claudeArgs: [fOld], shell: false });
    assert.deepStrictEqual(tt.args, [fOld, "--version"]); assert.strictEqual(tt.shell, false); assert.ok(tt.target);
  });
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nclaude-bundle 결과: " + n + " 통과");
