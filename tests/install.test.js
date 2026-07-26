"use strict";
/*
 * install.js 설치기 테스트 (프레임워크 없음 — node tests/install.test.js).
 * 실제 ~/.claude 는 건드리지 않는다: 임시 폴더에 CLAUDE_CONFIG_DIR / CODEX_BRIDGE_HOME 를 향하게 한다.
 * 확장 자동설치는 가짜 CODE_CLI 로 실패시켜 부수효과를 막는다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const REPO = path.join(__dirname, "..");
const INSTALL = path.join(REPO, "install.js");
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ✅ " + msg); } else { fail++; console.log("  ❌ " + msg); } }

function freshSandbox(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbtest_" + name + "_"));
  return {
    dir,
    claudeDir: path.join(dir, ".claude"),
    bridgeDir: path.join(dir, ".codex-bridge"),
    settings: path.join(dir, ".claude", "settings.json"),
  };
}
function run(sb, args) {
  return cp.spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 64,
    env: Object.assign({}, process.env, {
      CLAUDE_CONFIG_DIR: sb.claudeDir,
      CODEX_BRIDGE_HOME: sb.bridgeDir,
      CODE_CLI: "no-such-code-cli-xyz", // 확장 자동설치 무력화(실패 → 폴백 메시지만)
    }),
  });
}
function readJson(f) { return JSON.parse(fs.readFileSync(f, "utf8")); }
function cmdsOf(settings, event) {
  const arr = (settings.hooks && settings.hooks[event]) || [];
  return arr.flatMap((g) => (Array.isArray(g && g.hooks) ? g.hooks : []).map((h) => (h && h.command) || ""));
}
function countContaining(settings, event, needle) {
  return cmdsOf(settings, event).filter((c) => c.includes(needle)).length;
}
function cleanup(sb) { try { fs.rmSync(sb.dir, { recursive: true, force: true }); } catch {} }

// ── 1) 빈 환경 새 설치 ───────────────────────────────
(function testFresh() {
  console.log("[1] 빈 환경 새 설치");
  const sb = freshSandbox("fresh");
  const r = run(sb, []);
  ok(r.status === 0, "종료코드 0");
  for (const f of ["contract-lib.js", "verify-cap-handoff.js", "codex-bridge.js", "ask-job-worker.js", "codex-hook.js", "contract-inject.js", "verify-guard.js", "codex-guard.js"])
    ok(fs.existsSync(path.join(sb.bridgeDir, f)), "브릿지 파일 복사: " + f);
  ok(fs.existsSync(sb.settings), "settings.json 생성됨");
  const s = readJson(sb.settings);
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "UserPromptSubmit contract-inject 1개");
  ok(countContaining(s, "PreToolUse", "codex-guard.js") === 1, "PreToolUse codex-guard 1개");
  ok(countContaining(s, "Stop", "verify-guard.js") === 1, "Stop verify-guard 1개");
  // PreToolUse matcher 가 Bash 인지
  const pt = (s.hooks.PreToolUse || []).find((g) => (g.hooks || []).some((h) => (h.command || "").includes("codex-guard.js")));
  ok(pt && pt.matcher === "Bash", "PreToolUse matcher=Bash");
  cleanup(sb);
})();

// ── 2) 기존 설정 병합(타인 훅 보존 + 옛 우리 훅 교체) ──
(function testMerge() {
  console.log("[2] 기존 설정 병합(memento 보존 + 옛 codex 훅 교체)");
  const sb = freshSandbox("merge");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  const existing = {
    permissions: { defaultMode: "bypassPermissions" },
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash ~/.claude/hooks/memento-sessionstart.sh" }] }],
      UserPromptSubmit: [
        { matcher: "", hooks: [{ type: "command", command: "bash ~/.claude/hooks/memento-guard.sh" }] },
        { matcher: "", hooks: [{ type: "command", command: "node C:/old/path/contract-inject.js" }] }, // 옛 우리 훅(다른 경로)
      ],
      PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "bash ~/.claude/hooks/memento-precompact.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node C:/old/path/codex-guard.js" }] }],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "node C:/old/path/verify-guard.js" }] }],
    },
    model: "opus[1m]",
  };
  fs.writeFileSync(sb.settings, JSON.stringify(existing, null, 2));
  const r = run(sb, []);
  ok(r.status === 0, "종료코드 0");
  const s = readJson(sb.settings);
  // 타인 훅 보존
  ok(countContaining(s, "SessionStart", "memento-sessionstart.sh") === 1, "memento SessionStart 보존");
  ok(countContaining(s, "UserPromptSubmit", "memento-guard.sh") === 1, "memento-guard 보존");
  ok(countContaining(s, "PreCompact", "memento-precompact.sh") === 1, "memento PreCompact 보존");
  ok(s.model === "opus[1m]" && s.permissions.defaultMode === "bypassPermissions", "기타 설정 키 보존");
  // 옛 우리 훅 교체(중복 없이 정확히 1개, 옛 경로는 사라짐)
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "contract-inject 정확히 1개(중복 아님)");
  ok(countContaining(s, "UserPromptSubmit", "C:/old/path") === 0, "옛 contract-inject 경로 제거됨");
  ok(countContaining(s, "PreToolUse", "codex-guard.js") === 1, "codex-guard 정확히 1개");
  ok(countContaining(s, "Stop", "verify-guard.js") === 1, "verify-guard 정확히 1개");
  // 백업 생성
  const baks = fs.readdirSync(sb.claudeDir).filter((f) => f.startsWith("settings.json.bak."));
  ok(baks.length === 1, "백업 파일 1개 생성");
  cleanup(sb);
})();

// ── 3) 멱등성(두 번 설치 → 중복 없음) ───────────────
(function testIdempotent() {
  console.log("[3] 멱등성(두 번 설치)");
  const sb = freshSandbox("idem");
  run(sb, []);
  run(sb, []);
  const s = readJson(sb.settings);
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "contract-inject 여전히 1개");
  ok(countContaining(s, "PreToolUse", "codex-guard.js") === 1, "codex-guard 여전히 1개");
  ok(countContaining(s, "Stop", "verify-guard.js") === 1, "verify-guard 여전히 1개");
  cleanup(sb);
})();

// ── 4) 손상 JSON 가드(덮어쓰지 않음) ────────────────
(function testCorrupt() {
  console.log("[4] 손상 JSON 가드");
  const sb = freshSandbox("corrupt");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  const garbage = "{ this is : not json ,,, }";
  fs.writeFileSync(sb.settings, garbage);
  const r = run(sb, []);
  ok(r.status === 1, "종료코드 1(중단)");
  ok(fs.readFileSync(sb.settings, "utf8") === garbage, "원본 settings.json 그대로(덮어쓰지 않음)");
  cleanup(sb);
})();

// ── 5) uninstall(우리 훅만 제거, 타인 보존) ─────────
(function testUninstall() {
  console.log("[5] uninstall(우리 훅만 제거)");
  const sb = freshSandbox("uninst");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  fs.writeFileSync(sb.settings, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "bash ~/.claude/hooks/memento-guard.sh" }] }],
    },
  }, null, 2));
  run(sb, []); // 설치
  let s = readJson(sb.settings);
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "설치 후 contract-inject 존재");
  const r = run(sb, ["uninstall"]);
  ok(r.status === 0, "uninstall 종료코드 0");
  s = readJson(sb.settings);
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 0, "uninstall 후 contract-inject 제거");
  ok(countContaining(s, "PreToolUse", "codex-guard.js") === 0, "codex-guard 제거");
  ok(countContaining(s, "Stop", "verify-guard.js") === 0, "verify-guard 제거");
  ok(countContaining(s, "UserPromptSubmit", "memento-guard.sh") === 1, "memento-guard 보존");
  ok(fs.existsSync(sb.bridgeDir), "uninstall(비-purge)은 브릿지 폴더 보존");
  cleanup(sb);
})();

// ── 6) uninstall --purge(브릿지 폴더 삭제) ──────────
(function testPurge() {
  console.log("[6] uninstall --purge");
  const sb = freshSandbox("purge");
  run(sb, []);
  ok(fs.existsSync(sb.bridgeDir), "설치 후 브릿지 폴더 존재");
  run(sb, ["uninstall", "--purge"]);
  ok(!fs.existsSync(sb.bridgeDir), "purge 후 브릿지 폴더 삭제됨");
  cleanup(sb);
})();

// ── 7) dry-run(아무것도 쓰지 않음) ──────────────────
(function testDryRun() {
  console.log("[7] dry-run(쓰기 없음)");
  const sb = freshSandbox("dry");
  const r = run(sb, ["--dry-run"]);
  ok(r.status === 0, "종료코드 0");
  ok(!fs.existsSync(sb.bridgeDir), "브릿지 폴더 생성 안 함");
  ok(!fs.existsSync(sb.settings), "settings.json 생성 안 함");
  cleanup(sb);
})();

// ── 8) node 토큰 해석 출력 ───────────────────────────
(function testNodeToken() {
  console.log("[8] node 토큰 해석");
  const sb = freshSandbox("nodetok");
  const r = run(sb, []);
  ok(/훅 node\s*:/.test(r.stdout), "훅 node 경로 출력됨");
  ok(/절대경로|PATH의 node/.test(r.stdout), "절대경로 또는 PATH 선택 표시");
  cleanup(sb);
})();

// ── 9) 빈 settings.json = {} 취급(설치 진행) ─────────
(function testEmptyFile() {
  console.log("[9] 빈 settings.json");
  const sb = freshSandbox("empty");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  fs.writeFileSync(sb.settings, "   \n  "); // 공백만
  const r = run(sb, []);
  ok(r.status === 0, "종료코드 0(중단 아님)");
  const s = readJson(sb.settings);
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "빈 파일에 훅 추가됨");
  const baks = fs.readdirSync(sb.claudeDir).filter((f) => f.startsWith("settings.json.bak."));
  ok(baks.length === 1, "빈 파일도 백업함");
  cleanup(sb);
})();

// ── 10) 최상위가 배열인 JSON = 손상 취급(중단) ──────
(function testNonObject() {
  console.log("[10] 최상위 비객체 JSON(배열)");
  const sb = freshSandbox("arr");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  const arr = "[1,2,3]";
  fs.writeFileSync(sb.settings, arr);
  const r = run(sb, []);
  ok(r.status === 1, "종료코드 1(중단)");
  ok(fs.readFileSync(sb.settings, "utf8") === arr, "원본 보존(덮어쓰지 않음)");
  cleanup(sb);
})();

// ── 11) 같은 그룹에 타인 훅 + 우리 훅 공존 → 타인 보존 ─
(function testSameGroup() {
  console.log("[11] 같은 그룹 내 타인 훅 보존(엔트리 단위 제거)");
  const sb = freshSandbox("samegrp");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  // 한 UserPromptSubmit 그룹 안에 memento-guard 와 옛 contract-inject 가 같이 있음
  fs.writeFileSync(sb.settings, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        matcher: "", hooks: [
          { type: "command", command: "bash ~/.claude/hooks/memento-guard.sh" },
          { type: "command", command: "node C:/old/path/contract-inject.js" },
        ],
      }],
    },
  }, null, 2));
  const r = run(sb, []);
  ok(r.status === 0, "종료코드 0");
  const s = readJson(sb.settings);
  ok(countContaining(s, "UserPromptSubmit", "memento-guard.sh") === 1, "같은 그룹의 memento-guard 보존됨");
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "contract-inject 정확히 1개(새 형태)");
  ok(countContaining(s, "UserPromptSubmit", "C:/old/path") === 0, "옛 contract-inject 엔트리 제거");
  cleanup(sb);
})();

// ── 12) 배열 아닌 hooks[event] → 손상 취급(중단) ─────
(function testNonArrayEvent() {
  console.log("[12] hooks[event]가 배열이 아님 → 중단");
  const sb = freshSandbox("nonarr");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  const bad = JSON.stringify({ hooks: { Stop: "not-an-array" } }, null, 2);
  fs.writeFileSync(sb.settings, bad);
  const r = run(sb, []);
  ok(r.status === 1, "종료코드 1(중단)");
  ok(fs.readFileSync(sb.settings, "utf8") === bad, "원본 보존(덮어쓰지 않음)");
  ok(!fs.existsSync(sb.bridgeDir), "검증 실패 시 브릿지 폴더도 안 만듦(쓰기 전 검증)");
  cleanup(sb);
})();

// ── 13) 정규식 경계: 우연 부분문자열은 안 지움 ───────
(function testRegexBoundary() {
  console.log("[13] basename 경계(부분문자열 오탐 방지)");
  const sb = freshSandbox("regex");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  fs.writeFileSync(sb.settings, JSON.stringify({
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "node C:/x/my-verify-guard.js.bak --log verify-guard" }] }, // 우리 것 아님
      ],
    },
  }, null, 2));
  const r = run(sb, []);
  ok(r.status === 0, "종료코드 0");
  const s = readJson(sb.settings);
  ok(countContaining(s, "Stop", "my-verify-guard.js.bak") === 1, "우연 부분문자열 훅 보존됨");
  ok(countContaining(s, "Stop", ".codex-bridge/verify-guard.js") === 1, "우리 verify-guard는 새로 추가됨");
  cleanup(sb);
})();

// ── 14) 그룹의 hooks가 배열이 아님 → 보존(손실 방지, 중단 아님) ─
(function testMalformedGroup() {
  console.log("[14] 비배열 group.hooks 보존");
  const sb = freshSandbox("malgrp");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  // event는 배열(통과)이지만 그 안 그룹의 hooks가 문자열(형식 이상)
  fs.writeFileSync(sb.settings, JSON.stringify({
    hooks: { UserPromptSubmit: [{ matcher: "", hooks: "weird-non-array" }] },
  }, null, 2));
  const r = run(sb, []);
  ok(r.status === 0, "종료코드 0(중단 아님)");
  const s = readJson(sb.settings);
  // 이상한 그룹이 통째로 남아있어야 함(손실 없음)
  const ups = s.hooks.UserPromptSubmit || [];
  ok(ups.some((g) => g.hooks === "weird-non-array"), "비배열 hooks 그룹 보존됨");
  ok(countContaining(s, "UserPromptSubmit", "contract-inject.js") === 1, "우리 훅은 정상 추가됨");
  cleanup(sb);
})();

// ── code CLI 자동탐지(포터블/무설치형 VS Code 대응) — 순수함수 단위검사 ──
(function codeCliDetection() {
  console.log("[code CLI 자동탐지] 포터블 VS Code도 PATH 없이 찾는다");
  const { candidateCodeClis, findRootUpwards } = require(INSTALL);
  const isWin = process.platform === "win32";
  const bin = isWin ? "code.cmd" : "code";
  const sep = path.sep;

  // (1) VSCODE_CWD(설치 루트)에서 bin/code(.cmd) 후보가 1순위로 나온다(포터블 핵심 시나리오).
  const root = isWin ? "C:\\PortableVSCode\\VSCode-x64" : "/opt/portable-vscode";
  const c1 = candidateCodeClis({ VSCODE_CWD: root });
  ok(c1[0] === path.join(root, "bin", bin), "VSCODE_CWD → <root>/bin/" + bin + " 가 1순위 후보");

  // (2) VSCODE_GIT_ASKPASS_NODE(Code 실행파일)에서도 루트를 역추적한다.
  const exe = isWin ? "C:\\VSX\\Code.exe" : "/opt/vsx/code";
  const c2 = candidateCodeClis({ VSCODE_GIT_ASKPASS_NODE: exe });
  ok(c2.includes(path.join(path.dirname(exe), "bin", bin)), "VSCODE_GIT_ASKPASS_NODE → dirname/bin/" + bin + " 후보 포함");

  // (3) 환경변수 전무여도 OS 표준 위치 후보가 채워진다(빈 목록이면 자동탐지 불가).
  const c3 = candidateCodeClis({});
  ok(c3.length > 0 && c3.every((p) => p.endsWith(sep + "bin" + sep + bin) || p.endsWith("/bin/" + bin) || p.includes("code")), "환경변수 없어도 OS 표준 후보 존재");

  // (4) 중복 제거(같은 루트가 VSCODE_CWD·ASKPASS 양쪽서 와도 한 번만).
  const c4 = candidateCodeClis({ VSCODE_CWD: root, VSCODE_GIT_ASKPASS_NODE: path.join(root, isWin ? "Code.exe" : "code") });
  const target = path.join(root, "bin", bin);
  ok(c4.filter((p) => p === target).length === 1, "동일 루트 중복 후보는 1개로 합쳐짐");

  // (5) findRootUpwards: 실제 임시 트리에서 …/<root>/data/x/y/tool 로부터 <root>/bin/<bin> 을 찾는다.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbcode_"));
  const fakeRoot = path.join(tmp, "VSCode-portable");
  fs.mkdirSync(path.join(fakeRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "bin", bin), "#!/bin/sh\n");
  const deep = path.join(fakeRoot, "data", "extensions", "anthropic.claude-code", "native", "claude" + (isWin ? ".exe" : ""));
  fs.mkdirSync(path.dirname(deep), { recursive: true });
  fs.writeFileSync(deep, "x");
  ok(findRootUpwards(deep, bin) === path.join(fakeRoot, "bin", bin), "findRootUpwards: 깊은 실행파일 경로에서 설치 루트의 bin/code 역추적");
  ok(findRootUpwards(path.join(tmp, "nope", "x"), bin) === null, "findRootUpwards: 없으면 null(무한루프/오탐 없음)");
  fs.rmSync(tmp, { recursive: true, force: true });

  // (6) ★우선순위 잠금(Codex 지적): 현재 VS Code 신호(VSCODE_CWD)가 PATH의 'code'보다 먼저,
  //     OS 표준위치는 PATH 'code'보다 뒤 — 여러 VS Code 설치 시 '지금 띄운 그 VS Code'에 설치되게.
  const { codeCliPriority, vscodeSignalClis, standardCodeClis } = require(INSTALL);
  const pri = codeCliPriority({ VSCODE_CWD: root });
  const iSignal = pri.indexOf(path.join(root, "bin", bin));
  const iPath = pri.indexOf("code");
  ok(iSignal >= 0 && iPath >= 0 && iSignal < iPath, "우선순위: 현재 VS Code(VSCODE_CWD) 후보가 PATH 'code'보다 앞");
  const std = standardCodeClis();
  const iStd = std.length ? pri.indexOf(std[0]) : -1;
  ok(iStd > iPath, "우선순위: OS 표준위치는 PATH 'code'보다 뒤");
  ok(vscodeSignalClis({}).length === 0, "신호 없으면(외부 터미널) 신호후보 0개 → PATH/표준으로 폴백");
})();

// ── 같은 버전 강제 재설치 사고 방지 ──────────────────
(function sameVersionInstallGuard() {
  console.log("[같은 버전 설치 보호] 실행 중인 확장 폴더 선삭제 방지");
  const { installedExtensionVersionFromList, installVsixWithCli } = require(INSTALL);
  const list = [
    "ms-vscode.powershell@2026.1.0",
    "kimbyungsu.codex-bridge@0.1.86",
    "openai.chatgpt@26.721.30844",
  ].join("\r\n");
  ok(installedExtensionVersionFromList(list, "kimbyungsu.codex-bridge") === "0.1.86", "목록에서 같은 확장 버전을 찾음");
  ok(installedExtensionVersionFromList(list.toUpperCase(), "kimbyungsu.codex-bridge") === "0.1.86", "확장 이름 대소문자 차이를 무시함");
  ok(installedExtensionVersionFromList(list, "kimbyungsu.other") === null, "다른 확장은 같은 버전으로 오인하지 않음");
  ok(installedExtensionVersionFromList("kimbyungsu.codex-bridge", "kimbyungsu.codex-bridge") === null, "버전 없는 손상 줄은 설치됨으로 오인하지 않음");

  const callsSame = [];
  const same = installVsixWithCli("fake-code", "C:\\tmp\\same.vsix", "kimbyungsu.codex-bridge", "0.1.86", (cmd) => {
    callsSame.push(cmd);
    return { status: 0, stdout: list };
  });
  ok(same.kind === "same-version" && callsSame.length === 1 && /--list-extensions/.test(callsSame[0]), "같은 버전이면 목록 조회 뒤 즉시 멈춤");
  ok(callsSame.every((cmd) => !/--install-extension/.test(cmd)), "같은 버전에서는 force 설치 호출이 실제로 0회");

  const callsUnreadable = [];
  const unreadable = installVsixWithCli("fake-code", "C:\\tmp\\same.vsix", "kimbyungsu.codex-bridge", "0.1.86", (cmd) => {
    callsUnreadable.push(cmd);
    return { status: 1, stdout: "" };
  });
  ok(unreadable.kind === "list-unreadable" && callsUnreadable.length === 1, "설치 목록 판독 실패는 미설치로 추측하지 않고 보류");
  ok(callsUnreadable.every((cmd) => !/--install-extension/.test(cmd)), "목록 판독 실패에서도 force 설치 호출이 실제로 0회");

  const callsNew = [];
  const newer = installVsixWithCli("fake-code", "C:\\tmp\\new.vsix", "kimbyungsu.codex-bridge", "0.1.87", (cmd) => {
    callsNew.push(cmd);
    if (/--list-extensions/.test(cmd)) return { status: 0, stdout: list };
    return { status: 0, stdout: "installed" };
  });
  ok(newer.kind === "installed" && callsNew.length === 2 && /--install-extension/.test(callsNew[1]), "다른 새 버전은 목록 확인 뒤 정상 설치");
})();

// ── 같은 버전 안전 갱신 ──────────────────────────────
(function sameVersionSafeOverlay() {
  console.log("[같은 버전 안전 갱신] 버전 상승 없이 GitHub 설치 묶음 반영");
  const {
    extensionRootCandidates,
    findInstalledExtensionDir,
    overlaySameVersionExtension,
    hasLocalPackageToolchain,
  } = require(INSTALL);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-overlay-test-"));
  const src = path.join(tmp, "source");
  const extensions = path.join(tmp, "portable", "data", "extensions");
  const target = path.join(extensions, "kimbyungsu.codex-bridge-0.1.88");
  const backupParent = path.join(tmp, "backups");
  const meta = { publisher: "kimbyungsu", name: "codex-bridge", version: "0.1.88" };
  const installedMeta = Object.assign({}, meta, { __metadata: { installedTimestamp: 123, size: 456, targetPlatform: "undefined" } });
  fs.mkdirSync(path.join(src, "out"), { recursive: true });
  fs.mkdirSync(path.join(src, "bridge"), { recursive: true });
  fs.mkdirSync(path.join(src, "docs"), { recursive: true });
  fs.mkdirSync(path.join(target, "out"), { recursive: true });
  fs.mkdirSync(path.join(target, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(src, "out", "extension.js"), "NEW-EXTENSION");
  fs.writeFileSync(path.join(src, "bridge", "codex-bridge.js"), "NEW-BRIDGE");
  fs.writeFileSync(path.join(src, "docs", "README.en.md"), "NEW-README");
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify(installedMeta));
  fs.writeFileSync(path.join(target, "out", "extension.js"), "OLD-EXTENSION");
  fs.writeFileSync(path.join(target, "bridge", "codex-bridge.js"), "OLD-BRIDGE");
  fs.writeFileSync(path.join(target, ".vsixmanifest"), "VSCODE-OWNED");

  const explicit = extensionRootCandidates("ignored", { CODEX_BRIDGE_EXTENSIONS_DIR: extensions }, path.join(tmp, "home"));
  ok(explicit.length === 1 && explicit[0] === path.resolve(extensions), "명시한 extensions 폴더만 사용(다른 VS Code 오염 방지)");
  ok(findInstalledExtensionDir(explicit, "kimbyungsu.codex-bridge", "0.1.88") === target, "ID·버전이 모두 맞는 실제 설치 폴더를 찾음");
  ok(findInstalledExtensionDir(explicit, "kimbyungsu.codex-bridge", "0.1.89") === null, "버전이 다르면 같은 설치로 오인하지 않음");

  const over = overlaySameVersionExtension(src, target, "kimbyungsu.codex-bridge", "0.1.88", backupParent);
  ok(over.ok && over.count >= 4, "핵심 런타임을 백업 후 같은 버전에 덮어씀");
  ok(fs.readFileSync(path.join(target, "out", "extension.js"), "utf8") === "NEW-EXTENSION", "새 extension 런타임 반영");
  ok(fs.readFileSync(path.join(target, "bridge", "codex-bridge.js"), "utf8") === "NEW-BRIDGE", "새 bridge 런타임 반영");
  ok(fs.readFileSync(path.join(target, "readme.md"), "utf8") === "NEW-README", "설치본 README도 GitHub 문서로 갱신");
  ok(fs.readFileSync(path.join(target, ".vsixmanifest"), "utf8") === "VSCODE-OWNED", "VS Code 소유 설치 메타데이터 보존");
  ok(JSON.stringify(readJson(path.join(target, "package.json")).__metadata) === JSON.stringify(installedMeta.__metadata), "package.json의 VS Code 설치 메타데이터도 보존");
  ok(fs.readFileSync(path.join(over.backupDir, "out", "extension.js"), "utf8") === "OLD-EXTENSION", "교체 전 런타임 백업 보존");
  const mismatch = overlaySameVersionExtension(src, target, "kimbyungsu.codex-bridge", "0.1.87", backupParent);
  ok(!mismatch.ok && /일치하지 않음/.test(mismatch.why), "요청 버전이 다르면 덮어쓰기 전 거부");

  const toolRoot = path.join(tmp, "tools");
  fs.mkdirSync(path.join(toolRoot, "node_modules", "typescript", "bin"), { recursive: true });
  fs.mkdirSync(path.join(toolRoot, "node_modules", "@vscode", "vsce"), { recursive: true });
  ok(!hasLocalPackageToolchain(toolRoot), "부분 설치된 빌드 도구는 준비됨으로 오인하지 않음");
  fs.writeFileSync(path.join(toolRoot, "node_modules", "typescript", "bin", "tsc"), "");
  fs.writeFileSync(path.join(toolRoot, "node_modules", "@vscode", "vsce", "vsce"), "");
  ok(hasLocalPackageToolchain(toolRoot), "TypeScript와 VSCE가 모두 있을 때만 소스 재빌드");

  const cliA = path.join(tmp, "cli-a", "bin", process.platform === "win32" ? "code.cmd" : "code");
  const envB = path.join(tmp, "cli-b");
  const rootsBound = extensionRootCandidates(cliA, { VSCODE_CWD: envB, VSCODE_PORTABLE: path.join(envB, "data") }, path.join(tmp, "home"));
  ok(rootsBound[0] === path.join(tmp, "cli-a", "data", "extensions"), "버전을 조회한 CLI의 포터블 폴더가 첫 대상");
  ok(!rootsBound.some((p) => p.startsWith(envB)), "다른 열린 VS Code의 환경변수 폴더를 오버레이 후보로 섞지 않음");

  const installSource = fs.readFileSync(INSTALL, "utf8");
  ok(/const extensionOk = tryInstallVsix\(dryRun\);[\s\S]{0,300}if \(!extensionOk \|\| !doctorOk\)[\s\S]{0,200}return false;/.test(installSource), "확장 동일 버전 갱신 실패는 설치 완료 경로로 진행하지 않음");
  ok(/else if \(!cmdInstall\([\s\S]{0,80}process\.exitCode = 1/.test(installSource), "설치 미완료는 CLI 종료코드 1로 전달");
  fs.rmSync(tmp, { recursive: true, force: true });
})();

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
