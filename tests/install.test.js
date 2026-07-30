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
    resolveCommandOnPath,
    resolveCodeCli,
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

  const pathRoot = path.join(tmp, "path-cli");
  const pathBin = path.join(pathRoot, "bin");
  const pathCli = path.join(pathBin, process.platform === "win32" ? "code.cmd" : "code");
  fs.mkdirSync(pathBin, { recursive: true });
  fs.writeFileSync(pathCli, process.platform === "win32" ? "@echo 1.0.0\r\n" : "#!/bin/sh\necho 1.0.0\n");
  if (process.platform !== "win32") fs.chmodSync(pathCli, 0o755);
  const pathEnv = { ...process.env, PATH: pathBin };
  delete pathEnv.CODE_CLI; delete pathEnv.VSCODE_CWD; delete pathEnv.VSCODE_GIT_ASKPASS_NODE; delete pathEnv.CLAUDE_CODE_EXECPATH;
  const resolvedBare = resolveCommandOnPath("code", pathEnv);
  const selectedBare = resolveCodeCli(pathEnv);
  const realPathCli = fs.realpathSync(pathCli);
  const sameFsPath = (a, b) => process.platform === "win32"
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : a === b;
  ok(sameFsPath(resolvedBare, realPathCli) && sameFsPath(selectedBare, realPathCli), "PATH의 code도 실행한 실제 파일 절대경로로 결속");
  const rootsFromBare = extensionRootCandidates(selectedBare, pathEnv, path.join(tmp, "home"));
  ok(rootsFromBare[0] === path.join(pathRoot, "data", "extensions"), "PATH 포터블 CLI의 목록 조회와 오버레이 폴더가 같은 설치본");
  ok(extensionRootCandidates("code", {}, path.join(tmp, "home")).length === 0, "절대경로로 결속 못 한 bare code는 다른 설치본 추측 없이 거부");

  const installSource = fs.readFileSync(INSTALL, "utf8");
  ok(/const extensionOk = tryInstallVsix\(dryRun\);[\s\S]{0,300}if \(!extensionOk \|\| !doctorOk\)[\s\S]{0,200}return false;/.test(installSource), "확장 동일 버전 갱신 실패는 설치 완료 경로로 진행하지 않음");
  ok(/else if \(!cmdInstall\([\s\S]{0,80}process\.exitCode = 1/.test(installSource), "설치 미완료는 CLI 종료코드 1로 전달");
  fs.rmSync(tmp, { recursive: true, force: true });
})();

// 설치 안내가 '무엇이 바뀌었는지'에 따라 사실대로 갈리는지(2026-07-30 사용자 지적 실사고):
// 훅 스크립트 내용만 바뀐 재설치인데도 항상 "새 Claude Code 세션부터"라고 찍어, 이미 적용된 변경을
// 아직 적용 안 된 것처럼 안내했다. 등록된 명령은 매 프롬프트마다 새 프로세스로 실행되므로
// 등록이 그대로면 현재 세션의 다음 프롬프트부터 곧바로 적용된다.
console.log("[9] 설치 완료 안내는 훅 '등록' 변화 여부에 따라 갈린다");
(() => {
  const sb = freshSandbox("hooknote");
  const first = run(sb, ["install"]);
  const firstOut = String(first.stdout || "") + String(first.stderr || "");
  // 첫 설치는 설정 파일 자체를 새로 만든다 → 그 시점 이전에 시작한 세션은 감시 목록에 그 파일이 없으므로
  // 새 세션이 맞다(조건이 하나뿐이라 이 갈래만 단정한다).
  ok(/설정 파일을 이번에 새로 만들었습니다/.test(firstOut) && /새 Claude Code 세션에서 적용됩니다/.test(firstOut), "첫 설치(파일 신설)는 새 세션 필요라고 안내");
  ok(!/등록이 그대로라/.test(firstOut), "첫 설치에서 '새 세션 불필요' 안내가 나오지 않음");

  const before = fs.readFileSync(sb.settings, "utf8");
  const second = run(sb, ["install"]);
  const secondOut = String(second.stdout || "") + String(second.stderr || "");
  ok(fs.readFileSync(sb.settings, "utf8") === before, "재설치가 훅 등록을 바꾸지 않음(전제 확인)");
  ok(/등록이 그대로입니다/.test(secondOut) && /다음 프롬프트부터 바로 적용되고/.test(secondOut), "등록 불변 재설치는 '현재 세션 즉시 적용'을 조건과 함께 안내");
  ok(!/새 Claude Code 세션부터/.test(secondOut), "등록 불변인데 '새 세션 필요'라고 잘못 안내하지 않음");

  // 등록을 실제로 지우면 다시 '새 세션 필요'로 돌아와야 한다(안내가 상수가 아니라 사실을 따르는지).
  const s = readJson(sb.settings);
  delete s.hooks.UserPromptSubmit;
  fs.writeFileSync(sb.settings, JSON.stringify(s, null, 2) + "\n");
  const third = run(sb, ["install"]);
  const thirdOut = String(third.stdout || "") + String(third.stderr || "");
  // 등록이 바뀌어도 Claude Code의 설정 감시가 현재 세션에 반영한다 — 기준은 '이번 설치 시 존재 여부'가
  // 아니라 '그 Claude 세션이 시작될 때 파일이 있었는지'다(2.0.22 실측: 감시 목록은 시작 시점의
  // 실존 파일만 담는다). 설치기는 그 시점을 알 수 없으므로 안내가 두 조건을 함께 밝힌다.
  ok(/등록이 바뀌었습니다/.test(thirdOut) && /재시작 없이 반영되고/.test(thirdOut) && /파일이 없던 상태에서 시작한 세션이면 새 세션/.test(thirdOut), "등록 변경 안내는 두 조건(파일 가지고 시작 / 없이 시작)을 함께 밝힘");
  ok(!/새 Claude Code 세션에서 적용됩니다/.test(thirdOut), "실제 기준은 세션 시작 시 존재 여부라 '무조건 새 세션'으로 단정하지 않음");
  cleanup(sb);
})();

// 순서만 달라진 등록은 '변경'이 아니다 — mergeHooks가 우리 훅을 떼었다 뒤에 붙이므로 위치가 바뀔 수 있다.
console.log("[9b] 훅 명령 집합이 같으면 순서가 달라도 '등록 변경'으로 보지 않는다");
(() => {
  const sb = freshSandbox("hookorder");
  run(sb, ["install"]);
  const s = readJson(sb.settings);
  for (const ev of Object.keys(s.hooks)) if (Array.isArray(s.hooks[ev])) s.hooks[ev].reverse();
  s.hooks.zzOther = [{ matcher: "", hooks: [{ type: "command", command: "echo 타인훅" }] }];
  fs.writeFileSync(sb.settings, JSON.stringify(s, null, 2) + "\n");
  const r = run(sb, ["install"]);
  const out = String(r.stdout || "") + String(r.stderr || "");
  ok(/등록이 그대로입니다/.test(out), "그룹 순서만 뒤집히고 타인 훅이 있어도 '불변'으로 판정");
  ok(countContaining(readJson(sb.settings), "UserPromptSubmit", "contract-inject.js") === 1, "그 판정이 실제 병합 결과를 왜곡하지 않음(우리 훅 1개 유지)");
  cleanup(sb);
})();

// 문안 정본 패리티: install.js(복제본) ↔ src/hook-setup.ts(정본). 한쪽만 고치면 여기서 깨진다.
console.log("[9c] 설치 안내 문구는 install.js와 hook-setup이 한 글자도 다르지 않다");
(() => {
  let HS = null;
  try { HS = require(path.join(__dirname, "..", "out", "hook-setup.js")); } catch { /* 미빌드 */ }
  if (!HS || typeof HS.claudeHookApplyNote !== "function") {
    ok(false, "out/hook-setup.js의 claudeHookApplyNote를 불러오지 못함(빌드 필요) — 패리티 미검증");
    return;
  }
  const INS = require(path.join(__dirname, "..", "install.js"));
  const cases = [[false, true], [false, false], [true, true], [true, false]];
  let same = 0;
  for (const [changed, existed] of cases) {
    if (INS.claudeHookApplyNote(changed, existed) === HS.claudeHookApplyNote({ registrationChanged: changed, settingsExisted: existed }, false)) same++;
  }
  ok(same === cases.length, "4경우 모두 한국어 문안이 정확히 일치(복제 드리프트 차단 — install.js는 한국어만 씀)");
  // 영문은 install.js에 대응물이 없어 바이트 패리티 대상이 아니다. 대신 세 갈래가 서로 다르고
  // 각 갈래의 핵심 의미가 실제로 담겼는지를 잠근다(한쪽만 바뀌어도 의미가 무너지지 않게).
  const enUnchanged = HS.claudeHookApplyNote({ registrationChanged: false, settingsExisted: true }, true);
  const enChangedExisted = HS.claudeHookApplyNote({ registrationChanged: true, settingsExisted: true }, true);
  const enFresh = HS.claudeHookApplyNote({ registrationChanged: true, settingsExisted: false }, true);
  ok(new Set([enUnchanged, enChangedExisted, enFresh]).size === 3, "영문 세 갈래가 서로 다름");
  ok(/registration is unchanged/.test(enUnchanged) && /watches the settings file/.test(enChangedExisted) && /start a new Claude Code session/.test(enFresh), "영문 각 갈래가 제 의미를 담음");
  ok(/did not exist needs a restart/.test(enUnchanged) && /did not exist needs a restart/.test(enChangedExisted) && !/did not exist needs a restart/.test(enFresh), "영문 ①②에만 감시 사각지대 조건이 함께 쓰임");
  // 감시 사각지대 단서(한국어)도 ①②에만.
  const koUnchanged = INS.claudeHookApplyNote(false, true), koChanged = INS.claudeHookApplyNote(true, true), koFresh = INS.claudeHookApplyNote(true, false);
  ok(/없던 상태에서 시작한 세션이면 새 세션이 필요/.test(koUnchanged) && /없던 상태에서 시작한 세션이면 새 세션이 필요/.test(koChanged) && !/없던 상태에서 시작한 세션이면 새 세션이 필요/.test(koFresh), "한국어도 ①②에 조건이 함께 쓰이고 ③(파일 신설)에는 없음");
})();

// 정규화가 '실행 의미를 바꾸는 필드'를 흡수하면 진짜 등록 변경을 놓친다(검증 보완 지적).
console.log("[9d] 등록 비교는 나열 순서만 흡수하고 실행 의미 필드는 흡수하지 않는다");
(() => {
  let HS = null;
  try { HS = require(path.join(__dirname, "..", "out", "hook-setup.js")); } catch { /* 미빌드 */ }
  if (!HS || typeof HS.hooksCanon !== "function") { ok(false, "out/hook-setup.js의 hooksCanon을 불러오지 못함(빌드 필요)"); return; }
  const mk = (extra) => ({ Stop: [{ matcher: "", hooks: [Object.assign({ type: "command", command: "node x.js" }, extra)] }] });
  ok(HS.hooksCanon(mk({})) !== HS.hooksCanon(mk({ timeout: 30 })), "timeout 추가는 '변경'으로 잡힘");
  ok(HS.hooksCanon(mk({})) !== HS.hooksCanon(mk({ async: true })), "async 추가는 '변경'으로 잡힘");
  ok(HS.hooksCanon(mk({ type: "command" })) !== HS.hooksCanon(mk({ type: "other" })), "type 변경은 '변경'으로 잡힘");
  const two = (a, b) => ({ Stop: [{ matcher: "", hooks: [{ type: "command", command: a }, { type: "command", command: b }] }] });
  ok(HS.hooksCanon(two("node a.js", "node b.js")) === HS.hooksCanon(two("node b.js", "node a.js")), "같은 엔트리의 나열 순서 차이는 흡수");
  ok(HS.hooksCanon({ Stop: [{ matcher: "", hooks: [{ command: "node x.js" }] }] }) !== HS.hooksCanon({ Stop: [{ matcher: "Bash", hooks: [{ command: "node x.js" }] }] }), "matcher 변경은 '변경'으로 잡힘");
})();

// 제거 안내는 설치용 조건을 그대로 쓰면 반대 결론이 된다 — 설정 파일이 없던 상태에서 시작한 세션은
// 애초에 훅을 로드하지 않았으므로 제거 쪽에서는 오히려 재시작이 불필요하다(검증 blocker 반례).
console.log("[9e] 제거 안내는 사각지대에서 '이미 빠진 상태'라고 말한다");
(() => {
  const sb = freshSandbox("hookremove");
  run(sb, ["install"]);
  const r = run(sb, ["uninstall"]);
  const out = String(r.stdout || "") + String(r.stderr || "");
  ok(/이미 빠진 상태입니다/.test(out), "제거 안내가 사각지대 세션을 '이미 빠진 상태'로 설명");
  ok(!/새 세션이 필요합니다/.test(out), "제거 안내에 설치용 '새 세션 필요' 조건이 섞이지 않음");
  cleanup(sb);
})();

// 설치 '전' 모달의 판정도 실제 병합 결과를 미리 재야 한다(파일은 건드리지 않는다).
console.log("[9f] 설치 전 미리보기는 실제 설치 결과와 어긋나지 않는다(입력 검증 공유)");
(() => {
  let HS = null;
  try { HS = require(path.join(__dirname, "..", "out", "hook-setup.js")); } catch { /* 미빌드 */ }
  if (!HS || typeof HS.previewRegistration !== "function") { ok(false, "previewRegistration을 불러오지 못함(빌드 필요)"); return; }
  const sb = freshSandbox("hookpreview");
  const tok = '"' + process.execPath.replace(/\\/g, "/") + '"';
  ok(HS.previewRegistration(sb.settings, sb.bridgeDir, tok) === "changed", "설정 파일이 없으면 changed");
  const r1 = HS.installHooks(sb.settings, sb.bridgeDir, tok);
  ok(r1.ok === true && r1.registrationChanged === true, "첫 설치는 실제로 등록을 바꿈");
  const before = fs.readFileSync(sb.settings, "utf8");
  ok(HS.previewRegistration(sb.settings, sb.bridgeDir, tok) === "unchanged", "같은 훅 재설치는 unchanged");
  ok(fs.readFileSync(sb.settings, "utf8") === before, "미리보기가 파일을 건드리지 않음");
  const r2 = HS.installHooks(sb.settings, sb.bridgeDir, tok);
  ok(r2.registrationChanged === false, "실제 재설치 결과도 변경 없음으로 일치");
  // 실제 어긋남 반례: 설치가 '거부'하는 입력 4종에서 미리보기가 '변경됨'이라고 말하면 안 된다.
  const bad = {
    "손상 JSON": "{ this is : not json ,,, }",
    "최상위 배열": "[]",
    "hooks가 문자열": JSON.stringify({ hooks: "nope" }),
    "대상 이벤트가 문자열": JSON.stringify({ hooks: { Stop: "nope" } }),
  };
  let agreed = 0;
  for (const raw of Object.values(bad)) {
    fs.writeFileSync(sb.settings, raw, "utf8");
    const pv = HS.previewRegistration(sb.settings, sb.bridgeDir, tok);
    const inst = HS.installHooks(sb.settings, sb.bridgeDir, tok);
    if (pv === "invalid" && inst.ok === false) agreed++;
  }
  ok(agreed === 4, "설치가 거부하는 입력 4종을 미리보기도 invalid로 판정(변경됨으로 오안내 금지)");
  cleanup(sb);
})();

// 읽기 오류를 '파일 없음'으로 축소하면 빈 설정으로 병합해 사용자 설정이 백업 없이 사라진다.
// 또 원문을 두 번 읽으면 두 스냅샷이 생겨 '백업 없이 덮어쓰기'가 가능해진다(검증 blocker 반례 2건).
console.log("[9g] 설정 읽기 오류는 파일 부재로 축소하지 않고, 원문은 한 번만 읽는다");
(() => {
  let HS = null;
  try { HS = require(path.join(__dirname, "..", "out", "hook-setup.js")); } catch { /* 미빌드 */ }
  if (!HS || typeof HS.installHooks !== "function") { ok(false, "hook-setup.js를 불러오지 못함(빌드 필요)"); return; }
  const sb = freshSandbox("hookread");
  const tok = '"' + process.execPath.replace(/\\/g, "/") + '"';
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  const original = JSON.stringify({ model: "opus[1m]", hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash other.sh" }] }] } }, null, 2);
  fs.writeFileSync(sb.settings, original, "utf8");

  const realRead = fs.readFileSync;
  // 그 설정 파일에 대한 읽기만 계측·조작한다(다른 파일 읽기는 그대로 통과).
  let reads = 0, failFrom = 0; // failFrom>0 이면 그 번째 읽기부터 EACCES
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === "string" && p === sb.settings) {
      reads++;
      if (failFrom > 0 && reads >= failFrom) { const e = new Error("denied"); e.code = "EACCES"; throw e; }
    }
    return realRead.call(fs, p, ...rest);
  };
  try {
    // ⓐ 첫 읽기 실패(권한) → 중단·원본 보존. '없음'으로 축소하면 빈 설정으로 덮어쓴다.
    reads = 0; failFrom = 1;
    const r = HS.installHooks(sb.settings, sb.bridgeDir, tok);
    ok(r.ok === false && /읽을 수 없습니다/.test(String(r.reason || "")), "읽기 오류(EACCES)는 설치를 중단하고 사유를 밝힘");
    ok(realRead.call(fs, sb.settings, "utf8") === original, "원본 settings.json이 그대로 보존됨(빈 설정으로 덮어쓰지 않음)");
    reads = 0; failFrom = 1;
    ok(HS.previewRegistration(sb.settings, sb.bridgeDir, tok) === "invalid", "미리보기도 같은 입력을 invalid로 판정(설치와 일치)");

    // ⓑ 핵심 회귀 증거: 첫 읽기는 성공하고 '두 번째' 읽기부터 실패시킨다.
    //    이중 읽기 구현이면 백업용 두 번째 읽기가 실패해 백업 없이 덮어쓴다(과거 결함).
    //    단일 스냅샷이면 두 번째 읽기가 아예 없으므로 정상 설치되고 백업도 남는다.
    reads = 0; failFrom = 2;
    const r2 = HS.installHooks(sb.settings, sb.bridgeDir, tok);
    ok(reads === 1, "설정 파일 읽기가 정확히 1회(두 스냅샷 구조 부재 — 실제 호출 계측: " + reads + "회)");
    ok(r2.ok === true && typeof r2.backup === "string" && realRead.call(fs, r2.backup, "utf8") === original, "그 1회 원문으로 백업이 남고 내용이 일치");
    // 계측을 끊고 최종 상태를 확인한다.
    fs.readFileSync = realRead;
    ok(readJson(sb.settings).model === "opus[1m]" && countContaining(readJson(sb.settings), "SessionStart", "bash other.sh") === 1, "기타 설정·타인 훅 보존");
    ok(countContaining(readJson(sb.settings), "Stop", "verify-guard.js") === 1, "우리 훅이 실제로 등록됨");
  } finally { fs.readFileSync = realRead; }

  // ⓒ 제거 경로도 같은 계약: 읽기 오류를 성공으로 돌리면 훅이 남은 채 브릿지가 지워진다.
  if (typeof HS.removeHooks === "function") {
    const realRead2 = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      if (typeof p === "string" && p === sb.settings) { const e = new Error("denied"); e.code = "EACCES"; throw e; }
      return realRead2.call(fs, p, ...rest);
    };
    let rr = null;
    try { rr = HS.removeHooks(sb.settings); } finally { fs.readFileSync = realRead2; }
    ok(rr && rr.ok === false && /읽을 수 없습니다/.test(String(rr.reason || "")), "제거도 읽기 오류를 성공으로 돌리지 않음");
    ok(countContaining(readJson(sb.settings), "Stop", "verify-guard.js") === 1, "제거 실패 시 훅이 그대로 남아 있음(표식·브릿지 삭제로 진행 금지)");
    const rr2 = HS.removeHooks(path.join(sb.dir, "없는파일.json"));
    ok(rr2 && rr2.ok === true, "파일이 정말 없으면(ENOENT) 제거할 것 없음으로 성공");
  } else ok(false, "removeHooks를 불러오지 못함");
  cleanup(sb);
})();

// 안내가 '중단한 진짜 이유'를 말해야 한다. 권한·잠금인데 'JSON을 고치세요'라고 하면 사용자가
// 멀쩡한 설정을 건드린다. 감지도 읽기 실패를 '훅 미등록'으로 축소하면 잘못된 설치 안내가 뜬다.
console.log("[9h] 중단 안내는 읽기 실패와 JSON 손상을 갈라 말한다");
(() => {
  const sb = freshSandbox("hookreason");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  // ⓐ 진짜 JSON 손상 → 손상 안내(수동 수정 권고)가 맞다.
  fs.writeFileSync(sb.settings, "{ not json ,,, }", "utf8");
  const bad = run(sb, ["install"]);
  const badOut = String(bad.stdout || "") + String(bad.stderr || "");
  ok(bad.status === 1 && /올바른 JSON이 아닙니다/.test(badOut) && /수동으로 JSON을 고친 뒤/.test(badOut), "JSON 손상은 손상 안내 + 수동 수정 권고");
  ok(!/권한과 파일 잠금/.test(badOut), "손상인데 권한 얘기를 하지 않음");

  // ⓑ 읽기 실패는 파일 내용 문제가 아니라고 밝혀야 한다(단위 검증 — 실제 권한 조작 없이 판독기로 확인).
  let HS = null;
  try { HS = require(path.join(__dirname, "..", "out", "hook-setup.js")); } catch { /* 미빌드 */ }
  if (HS && typeof HS.detectHooks === "function") {
    const realRead = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      if (typeof p === "string" && p === sb.settings) { const e = new Error("denied"); e.code = "EACCES"; throw e; }
      return realRead.call(fs, p, ...rest);
    };
    let d = null;
    try { d = HS.detectHooks(sb.settings); } finally { fs.readFileSync = realRead; }
    ok(d && d.installed === false && typeof d.unreadable === "string" && /읽을 수 없음/.test(d.unreadable), "감지가 읽기 실패를 unreadable로 알림(부재로 축소하지 않음)");
    ok(HS.detectHooks(path.join(sb.dir, "없는파일.json")).unreadable === null, "파일이 정말 없으면 unreadable=null(기존 의미 유지)");
  } else ok(false, "detectHooks를 불러오지 못함(빌드 필요)");
  cleanup(sb);
})();

// 반환값만 고치고 화면이 그 값을 버리면 사용자에게는 아무것도 달라지지 않는다.
// 판독 실패에 '훅 미등록' 안내를 띄우면 사용자가 이미 있는 훅을 다시 설치하려 한다(검증 blocker 반례).
console.log("[9i] 판독 실패는 화면에서도 '미등록'이 아니라 '확인 불가'로 안내된다");
(() => {
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const offer = ext.slice(ext.indexOf("async function maybeOfferHookSetup"));
  const offerBody = offer.slice(0, offer.indexOf("export function activate"));
  // read로만 좁히면 손상 JSON(kind="parse")이 미등록 경로로 새어나간다 — 실제로 그 회귀가 있었다.
  ok(/if \(st\.unreadable\)/.test(offerBody) && !/st\.kind === "read"/.test(offerBody), "훅 제안 흐름이 판독 실패 '전체'를 분기한다(read로 좁히면 손상 JSON이 미등록으로 샌다)");
  // 문구는 공용 생성기(hookStatusUnknownMsg)로 옮겼다 — 호출은 분기 안에, 문장은 그 함수에 있다.
  ok(/hookStatusUnknownMsg\(st, false\)/.test(offerBody) && /hookStatusUnknownMsg\(st, true\)/.test(offerBody), "판독 실패 분기가 ko/en 문구를 공용 생성기로 만든다");
  ok(/훅 등록 상태를 확인할 수 없습니다/.test(ext) && /could not determine hook registration/.test(ext), "그 생성기가 ko/en 모두 '확인 불가'로 말한다");
  const uIdx = offerBody.indexOf("if (st.unreadable)");
  const nIdx = offerBody.indexOf("검증 훅이 아직 등록되지 않았습니다");
  const dIdx = offerBody.indexOf("HOOKS_PROMPT_DISMISSED");
  ok(uIdx >= 0 && nIdx >= 0 && uIdx < nIdx, "미등록 안내보다 먼저 갈라져 판독 실패에 미등록 문구가 나오지 않는다");
  ok(dIdx >= 0 && uIdx < dIdx, "'다시 묻지 않음' 표식 확인보다도 먼저 갈라진다(설치 제안 거부가 사실 고지를 막지 않음)");
  ok(/return;[\s\S]{0,80}\}/.test(offerBody.slice(uIdx, nIdx)), "분기 뒤 즉시 반환한다(미등록 경로로 흘러가지 않음)");

  // 모달: 판독 상태를 한 번만 잡아 ko/en이 같은 원인을 말한다(재조회 경합 차단).
  // 미리보기와 원인을 따로 읽으면 두 문장이 서로 다른 순간을 말한다 — 한 판독에서 함께 받아야 한다.
  ok(/previewRegistrationDetailed\(settingsFile/.test(ext) && !/preview === "invalid" \? hookSetup\.detectHooks/.test(ext), "모달은 미리보기와 원인을 한 판독에서 받는다(따로 읽어 세대가 갈리지 않게)");
  const noteIdx = ext.indexOf("const applyNote = (en: boolean)");
  const noteBody = ext.slice(noteIdx, ext.indexOf("const detail = tE(", noteIdx));
  ok(!/detectHooks\(/.test(noteBody), "문안 생성 안에서 다시 읽지 않는다(ko/en 원인 어긋남 차단)");
  ok(/설정 파일을 읽을 수 없어/.test(noteBody) && /cannot be read/.test(noteBody), "모달도 판독 실패를 형식 문제로 뭉개지 않는다(ko/en)");
  ok(/권한과 파일 잠금을 확인해 주세요/.test(noteBody) && /Check permissions and file locks/.test(noteBody), "무엇을 해야 하는지 알려준다");

  // 사유 문장은 언어 중립 값(kind·code)에서 만든다 — 영문에 한국어가 섞이지 않게.
  ok(/function hookUnreadableReason/.test(ext), "사유 문장 생성기가 화면 쪽에 있다");
  const rIdx = ext.indexOf("function hookUnreadableReason");
  const rBody = ext.slice(rIdx, ext.indexOf("\n}", rIdx));
  ok(/읽기 실패/.test(rBody) && /read failed/.test(rBody) && !/st\.unreadable/.test(rBody), "사유를 ko/en 각각 만들고 한국어 원문(unreadable)을 쓰지 않는다");
})();

// 판독 실패 사유가 영문 화면에 한국어로 새지 않는지 실제 값으로 확인한다.
console.log("[9j] 판독 실패 사유는 언어 중립 값으로 전달된다");
(() => {
  let HS = null;
  try { HS = require(path.join(__dirname, "..", "out", "hook-setup.js")); } catch { /* 미빌드 */ }
  if (!HS || typeof HS.detectHooks !== "function") { ok(false, "hook-setup.js를 불러오지 못함(빌드 필요)"); return; }
  const sb = freshSandbox("hookkind");
  fs.mkdirSync(sb.claudeDir, { recursive: true });
  fs.writeFileSync(sb.settings, "{}", "utf8");
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === "string" && p === sb.settings) { const e = new Error("denied"); e.code = "EACCES"; throw e; }
    return realRead.call(fs, p, ...rest);
  };
  let d = null;
  try { d = HS.detectHooks(sb.settings); } finally { fs.readFileSync = realRead; }
  ok(d && d.kind === "read" && d.code === "EACCES", "읽기 실패는 kind=read + 원인 코드를 함께 준다");
  fs.writeFileSync(sb.settings, "{ not json", "utf8");
  const d2 = HS.detectHooks(sb.settings);
  ok(d2 && d2.kind === "parse", "내용이 JSON이 아니면 kind=parse(읽기 실패와 구분)");
  fs.writeFileSync(sb.settings, "{}", "utf8");
  const d3 = HS.detectHooks(sb.settings);
  ok(d3 && !d3.kind && d3.unreadable === null, "정상 판독은 kind 없음·unreadable=null(기존 의미 유지)");
  cleanup(sb);
})();

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
