#!/usr/bin/env node
"use strict";
/*
 * codex-bridge 한방 설치기 (풀 자동, 크로스플랫폼 node 코어)
 *
 * 하는 일 (상황으로):
 *  - 브릿지 실행파일(bridge/*.js 전체)을 사용자 홈의 운영 폴더로 복사한다.
 *  - Claude Code 설정(settings.json)에 "코덱스 검증 훅" 4개를 끼워 넣는다.
 *    이때 사용자가 이미 쓰던 다른 훅(memento 등)은 절대 건드리지 않고,
 *    우리 옛 훅만 찾아 새 형태로 교체한다(중복 누적 방지·업그레이드).
 *  - 설정을 고치기 전에 항상 타임스탬프 백업을 남긴다.
 *  - 훅이 부를 node 경로를, 셸에서 실제로 실행되는지 시험해 본 뒤
 *    "절대경로 고정"과 "PATH의 node" 중 동작하는 쪽을 자동 선택한다.
 *  - (선택) 확장 VSIX 자동 설치 시도, 끝에 doctor로 상태를 보여준다.
 *
 * 사용법:
 *   node install.js              설치(여러 번 돌려도 안전 = 멱등)
 *   node install.js --dry-run    미리보기(아무것도 쓰지 않음)
 *   node install.js uninstall    제거(우리 훅만 외과적으로 빼고 백업은 보존)
 *   node install.js uninstall --purge   위 + 브릿지 운영 폴더까지 삭제
 *   node install.js status       현재 상태 점검(doctor 위임)
 *   node install.js --help
 *
 * 환경변수(낯선 환경 대응):
 *   CODEX_BRIDGE_HOME  브릿지 운영 폴더            (기본 ~/.codex-bridge)
 *   CLAUDE_CONFIG_DIR  Claude 설정 폴더            (기본 ~/.claude)
 *   CODEX_BRIDGE_NODE  훅이 쓸 node 실행파일       (기본 지금 이 설치기를 돌린 node)
 *   CODE_CLI           VS Code CLI(code) 경로      (미지정 시 PATH의 code → 환경변수/표준위치 자동탐지)
 *                      ※ 포터블/무설치형 VS Code(PATH에 code 없음)도 VSCODE_CWD 등으로 자동탐지. 그래도 못 찾으면 이 변수로 지정.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = os.homedir();
const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(HOME, ".codex-bridge");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const NODE_BIN = process.env.CODEX_BRIDGE_NODE || process.execPath; // 절대경로 pin 후보
const SRC_BRIDGE = path.join(__dirname, "bridge"); // 레포의 bridge/

// 복사 대상(런타임 전체). contract-lib는 다른 .js가 require하므로 필수.
const BRIDGE_SCRIPTS = [
  "contract-lib.js",
  "codex-bridge.js",
  "contract-inject.js",
  "verify-guard.js",
  "codex-guard.js",
  "deepseek-bridge.js",
  "scout-gate.js",
  "project-map.js", // P0.5: Project MAP 순수 코어(out/ 산출물 사본 — scripts/sync-map-core.js가 생성·훅 아님)
  "map-runtime.js", // P0.5: Project MAP 런타임(수집기·draft·CLI 본체 — 훅 아님)
  "map-bootstrap.js", // P1: 비차단 bootstrap(훅이 lazy require — 훅 아님·detach 자식 실행기)
];

// 우리가 settings.json에 심는 훅. event → {matcher, script}
const OUR_HOOKS = [
  { event: "UserPromptSubmit", matcher: "", script: "contract-inject.js" },
  { event: "PreToolUse", matcher: "Bash", script: "codex-guard.js" },
  { event: "PreToolUse", matcher: "ExitPlanMode", script: "scout-gate.js" }, // ⑥ 지도 preflight — 3트랙 기본 켜짐(실효 scoutGate·2026-07-09 승격, 2트랙은 관측만)·fail-open·관측 로그
  { event: "Stop", matcher: "", script: "verify-guard.js" },
];
// "우리 훅"을 식별하는 파일명(경로·따옴표·node표기 무관하게 basename으로 매칭).
const OUR_SCRIPT_NAMES = ["contract-inject.js", "codex-guard.js", "verify-guard.js", "scout-gate.js"];

// ── 유틸 ──────────────────────────────────────────────
function log(s) { process.stdout.write(s + "\n"); }
function q(s) { return '"' + s + '"'; }
// 훅 명령 경로는 슬래시로 통일 — cmd/bash/node 모두에서 안전(기존 동작 훅과 동일 표기).
function fwd(s) { return String(s).replace(/\\/g, "/"); }

// 동시 읽기 중 손상 방지: tmp 작성 후 rename만(직접쓰기 폴백 없음). 브릿지와 동일 패턴.
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    for (let i = 0; i < 12; i++) {
      try { fs.renameSync(tmp, file); return true; } catch {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* best-effort */ }
      }
    }
  } catch { /* mkdir/tmp 실패 */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return false;
}

function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }

// 셸을 통해 node 토큰이 실제로 실행되는지 시험(훅 러너와 같은 OS 셸 경유 = shell:true).
function shellRunsNode(nodeToken) {
  try {
    const r = cp.spawnSync(nodeToken + ' -e "process.stdout.write(String(6*7))"', {
      shell: true, encoding: "utf8", timeout: 20000,
    });
    return r.status === 0 && String(r.stdout || "").trim() === "42";
  } catch { return false; }
}

// 훅이 쓸 node 토큰 결정: 절대경로(고정)가 셸에서 되면 그걸, 아니면 PATH의 node.
// 둘 다 셸 검증 실패하면 관례형 `node`로 폴백(예시·동작중 설정과 동일 형태) + verified=false 경고.
function resolveNodeToken() {
  const abs = q(fwd(NODE_BIN));
  if (shellRunsNode(abs)) return { token: abs, how: "절대경로 고정(PATH에 node 없어도 동작)", verified: true };
  if (shellRunsNode("node")) return { token: "node", how: "PATH의 node(절대경로는 셸 검증 실패)", verified: true };
  return { token: "node", how: "PATH의 node(셸 검증 실패 — 관례형으로 폴백)", verified: false };
}

let NODE_TOKEN = null; // resolveNodeToken().token (install 시 1회 결정)
function hookCommand(script) {
  return NODE_TOKEN + " " + q(fwd(path.join(BRIDGE_DIR, script)));
}

// 명령 하나가 "우리 훅"인가 — 경로 경계가 있는 스크립트 파일명으로만 매칭(부분문자열 오탐 방지).
// 예: ".../contract-inject.js"는 매칭, "mycontract-inject.js.bak"이나 인자 속 우연 일치는 비매칭.
// 후행 경계엔 셸 구분자(; & | ) , )도 포함 — `node verify-guard.js; echo x` 같은 복합 명령도 식별.
function isOurHookCmd(cmd) {
  return /(^|[\\/\s"'])(contract-inject|codex-guard|verify-guard|scout-gate)\.js(?=$|["'\s;,&|)])/.test(String(cmd || ""));
}
// 그룹에서 '우리 hook 엔트리'만 제거. 같은 그룹에 타인 hook이 섞여 있어도 그건 보존.
// group.hooks가 배열이 아니면(예상 못한 형식) 건드리지 않고 그대로 보존(손실 방지).
// 반환 {group|null, removed}. 모든 엔트리가 우리 것이라 비면 group:null(그룹째 정리).
function stripOurFromGroup(group) {
  if (!group || !Array.isArray(group.hooks)) return { group, removed: 0 };
  const entries = group.hooks;
  const kept = entries.filter((h) => !isOurHookCmd(h && h.command));
  const removed = entries.length - kept.length;
  if (kept.length === 0) return { group: null, removed };
  if (removed === 0) return { group, removed: 0 };
  return { group: Object.assign({}, group, { hooks: kept }), removed };
}

// settings.hooks 형식이 병합 가능한지 검사. null=정상, 문자열=중단 사유(손상 방지).
function checkHooksShape(settings) {
  if (settings.hooks === undefined) return null;
  if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return "settings.hooks가 객체가 아닙니다";
  for (const { event } of OUR_HOOKS) {
    if (settings.hooks[event] !== undefined && !Array.isArray(settings.hooks[event]))
      return `settings.hooks.${event} 가 배열이 아닙니다(예상치 못한 형식)`;
  }
  return null;
}

// 설정에 우리 훅 병합: 타인 훅(같은 그룹 내 포함) 보존, 우리 옛 엔트리만 제거 후 새 명령 그룹 추가.
// ⚠ 이벤트 단위로 1회만 정리 — 훅별로 정리하면 같은 이벤트(PreToolUse)에 우리 훅이 2개일 때
// 두 번째 순회가 첫 번째로 추가한 우리 훅을 지운다(scout-gate 추가 때 발견된 함정 — hook-setup.ts와 동일 수정).
function mergeHooks(settings) {
  settings.hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  const byEvent = new Map();
  for (const h of OUR_HOOKS) { if (!byEvent.has(h.event)) byEvent.set(h.event, []); byEvent.get(h.event).push(h); }
  for (const [event, ours] of byEvent) {
    const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = [];
    for (const g of arr) { const { group } = stripOurFromGroup(g); if (group) cleaned.push(group); }
    for (const { matcher, script } of ours) cleaned.push({ matcher, hooks: [{ type: "command", command: hookCommand(script) }] });
    settings.hooks[event] = cleaned;
  }
  return settings;
}

// 우리 훅 엔트리만 외과적으로 제거(uninstall). 타인 hook은 같은 그룹에 있어도 보존. 빈 그룹/이벤트는 정리.
function removeHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return { settings, removed: 0 };
  let removed = 0;
  for (const { event } of OUR_HOOKS) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;
    const cleaned = [];
    for (const g of arr) { const r = stripOurFromGroup(g); removed += r.removed; if (r.group) cleaned.push(r.group); }
    if (cleaned.length) settings.hooks[event] = cleaned; else delete settings.hooks[event];
  }
  return { settings, removed };
}

function backupSettings() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${SETTINGS}.bak.${ts}`;
  fs.copyFileSync(SETTINGS, bak);
  return bak;
}

// settings.json을 안전하게 읽는다. {ok, settings, raw, existed}
// 파싱 실패 시 ok=false → 호출부는 절대 덮어쓰지 않는다(손상 방지).
function readSettingsSafe() {
  const raw = readText(SETTINGS);
  if (raw === null) return { ok: true, settings: {}, raw: null, existed: false };
  if (raw.trim() === "") return { ok: true, settings: {}, raw, existed: true }; // 빈 파일 = {} 취급(백업은 함)
  try {
    const parsed = JSON.parse(raw);
    // JSON 최상위가 객체가 아니면(배열·숫자 등) 병합 불가 — 손상으로 간주(덮어쓰지 않음).
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, settings: null, raw, existed: true, err: "최상위가 JSON 객체가 아님" };
    }
    return { ok: true, settings: parsed, raw, existed: true };
  } catch (e) { return { ok: false, settings: null, raw, existed: true, err: e.message }; }
}

// ── 명령들 ────────────────────────────────────────────
function copyBridge(dryRun) {
  for (const f of BRIDGE_SCRIPTS) {
    const src = path.join(SRC_BRIDGE, f);
    if (!fs.existsSync(src)) {
      log(`❌ 원본 브릿지 파일이 없습니다: ${src}`);
      log("   (설치기는 레포의 bridge/ 옆에서 실행해야 합니다)");
      process.exit(1);
    }
  }
  if (!dryRun) {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    for (const f of BRIDGE_SCRIPTS) fs.copyFileSync(path.join(SRC_BRIDGE, f), path.join(BRIDGE_DIR, f));
    // 확장 자동배치 stamp 제거 = '수동(레포) 설치 모드' 표시 — 확장이 개발자의 최신 수동본을 옛 번들본으로 덮지 않게 한다(src/extension.ts deployBridgeRuntime 대칭).
    try { fs.unlinkSync(path.join(BRIDGE_DIR, ".bridge-deployed-by.json")); } catch { /* 없으면 무시 */ }
  }
  log(`✅ 브릿지 파일 ${BRIDGE_SCRIPTS.length}개 → ${BRIDGE_DIR}${dryRun ? "  (미리보기 — 복사 안 함)" : ""}`);
}

// .vsix 후보 중 '우리 확장(codex-bridge-*)'만 골라 최신 버전을 고른다(순수함수 = 테스트 가능).
//  - codex-bridge- 접두로 거르지 않으면 잔재 codex-peek-*.vsix가 사전순으로 뽑히는 버그.
//  - 문자열 정렬은 0.1.9를 0.1.18보다 뒤로 봐 최신을 못 고른다 → semver 숫자 비교.
//  - preferVersion(package.json version) 정확 일치 파일이 있으면 그걸 최우선.
function pickVsix(files, preferVersion) {
  const ours = (files || []).filter((f) => /^codex-bridge-.*\.vsix$/i.test(f));
  if (!ours.length) return null;
  if (preferVersion) { const exact = `codex-bridge-${preferVersion}.vsix`; if (ours.includes(exact)) return exact; }
  const ver = (f) => { const m = f.match(/^codex-bridge-(\d+)\.(\d+)\.(\d+)/); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
  return ours.slice().sort((a, b) => {
    const va = ver(a), vb = ver(b);
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
    return a < b ? -1 : a > b ? 1 : 0; // 동률이면 이름순(안정)
  }).pop();
}
// '현재 package.json 버전과 정확히 일치하는 vsix'만 인정한다(순수함수 = 테스트 가능).
//  - 설치는 항상 새로 빌드하므로(tryInstallVsix 참고), 이 함수는 '방금 빌드한 현재 버전 vsix'를 집거나,
//    빌드 실패 시 폴백으로 기존 현재 버전 vsix를 찾는 데 쓴다. pickVsix의 '최신으로 폴백'을 그대로 쓰면 버전
//    올린 뒤 옛 vsix를 잡는 사고가 나므로, 파일명이 codex-bridge-(현재버전).vsix와 정확히 일치할 때만 인정한다.
//  - version이 비면(메타 못 읽음) 폴백 동작 유지(pickVsix 결과 그대로) — 하위호환.
function currentVsix(files, version) {
  const picked = pickVsix(files, version);
  if (!picked) return null;
  if (version && picked !== `codex-bridge-${version}.vsix`) return null;
  return picked;
}
// code 설치 명령 문자열 조립(순수함수). ⚠ bare 명령(code)을 따옴표로 감싸면 Windows cmd에서 PATHEXT(.cmd)
// 해석이 깨져 9009로 실패한다(재현 확인). 그래서 경로/공백 있는 실행파일만 따옴표, bare 이름은 그대로.
// vsix 경로는 공백 있어도 되게 항상 따옴표.
function buildInstallCmd(codeCli, vsixPath) {
  const codeTok = /[\\/\s]/.test(String(codeCli)) ? q(fwd(codeCli)) : String(codeCli);
  return `${codeTok} --install-extension ${q(fwd(vsixPath))} --force`;
}
// 주어진 파일 경로에서 위로 올라가며 'bin/<binName>'을 찾는다(예: …/<root>/data/extensions/…/claude.exe → <root>/bin/code.cmd).
// VS Code 포터블/무설치형은 표준 위치에 없으므로, 실행 중인 도구의 경로에서 설치 루트를 역추적하는 신호로 쓴다.
function findRootUpwards(startPath, binName) {
  let d = path.dirname(String(startPath || ""));
  for (let i = 0; i < 12 && d; i++) {
    const cand = path.join(d, "bin", binName);
    if (fs.existsSync(cand)) return cand;
    const up = path.dirname(d);
    if (up === d) break; // 루트 도달
    d = up;
  }
  return null;
}
// (A) '지금 실행 중인 VS Code'의 code 후보 — VS Code가 심는 환경변수/실행 중 바이너리 경로에서 설치 루트를 역추적.
// ★ "어떤 OS든 3줄 설치"가 깨지던 원인: PATH에 code 없는 포터블 VS Code. 이 신호가 있으면 PATH의 다른 code보다 먼저 써야
//   '사용자가 지금 띄운 그 VS Code'에 확장이 깔린다(여러 VS Code 설치 시 엉뚱한 곳에 설치 방지 — Codex 지적 반영).
function vscodeSignalClis(env) {
  env = env || process.env;
  const bin = process.platform === "win32" ? "code.cmd" : "code";
  const list = [];
  const fromRoot = (root) => { if (root) list.push(path.join(root, "bin", bin)); };
  fromRoot(env.VSCODE_CWD);                                                  // 설치 루트(포터블 포함)
  if (env.VSCODE_GIT_ASKPASS_NODE) fromRoot(path.dirname(env.VSCODE_GIT_ASKPASS_NODE)); // Code 실행파일 → 그 폴더가 루트
  if (env.CLAUDE_CODE_EXECPATH) { const up = findRootUpwards(env.CLAUDE_CODE_EXECPATH, bin); if (up) list.push(up); } // …/<root>/data/…/claude.exe
  return [...new Set(list)];
}
// (B) OS 표준 설치 위치 후보(설치형 VS Code / Insiders / Flatpak 등). PATH의 code보다 뒤에 시도.
function standardCodeClis() {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const bin = isWin ? "code.cmd" : "code";
  const list = [];
  const fromRoot = (root) => { if (root) list.push(path.join(root, "bin", bin)); };
  if (isWin) {
    // 환경변수가 없어도 동작하도록 표준 기본값으로 폴백(LOCALAPPDATA→홈/AppData/Local, ProgramFiles→C:\Program Files).
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const progFiles = process.env.ProgramFiles || "C:\\Program Files";
    const progFiles86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    fromRoot(path.join(localAppData, "Programs", "Microsoft VS Code"));
    fromRoot(path.join(progFiles, "Microsoft VS Code"));
    fromRoot(path.join(progFiles86, "Microsoft VS Code"));
    fromRoot(path.join(localAppData, "Programs", "Microsoft VS Code Insiders"));
  } else if (isMac) {
    list.push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
    list.push(path.join(os.homedir(), "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"));
    list.push("/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code");
  } else {
    list.push("/usr/bin/code", "/usr/local/bin/code", "/usr/share/code/bin/code", "/snap/bin/code");
    list.push("/usr/bin/code-insiders", "/snap/bin/code-insiders");                         // Insiders
    list.push("/var/lib/flatpak/exports/bin/com.visualstudio.code");                        // Flatpak(system)
    list.push(path.join(os.homedir(), ".local", "share", "flatpak", "exports", "bin", "com.visualstudio.code")); // Flatpak(user)
  }
  return [...new Set(list)];
}
// 전체 우선순위(순수함수 — 테스트로 잠금): 현재 VS Code 신호 → PATH의 'code' → OS 표준위치.
// (CODE_CLI 명시는 resolveCodeCli에서 이보다 먼저 단락처리.) 'code'는 PATH 해석용 bare 토큰(존재검사 없이 --version으로 확인).
function codeCliPriority(env) {
  return [...new Set([...vscodeSignalClis(env), "code", ...standardCodeClis()])];
}
// 하위호환: 신호+표준 후보(‘code’ 제외) — 기존 호출/테스트용.
function candidateCodeClis(env) {
  return [...new Set([...vscodeSignalClis(env), ...standardCodeClis()])];
}
// 실제로 동작하는 code 실행파일인지 확인(--version 시도). 경로/공백 있으면 따옴표, bare 이름은 그대로(PATHEXT 해석 위해).
function codeCliWorks(tok) {
  if (!tok) return false;
  const t = /[\\/\s]/.test(String(tok)) ? q(fwd(tok)) : String(tok);
  try { const r = cp.spawnSync(`${t} --version`, { shell: true, encoding: "utf8", timeout: 30000 }); return !!(r && r.status === 0); }
  catch { return false; }
}
// 쓸 code CLI를 결정: ① CODE_CLI 명시(그대로 신뢰 — 자동탐지 안 함; 테스트가 가짜값으로 자동설치 무력화하는 계약 유지)
// ② codeCliPriority 순서대로 — 현재 VS Code 신호(존재+동작) → PATH 'code'(동작) → OS 표준(존재+동작). 못 찾으면 null.
function resolveCodeCli() {
  if (process.env.CODE_CLI) return process.env.CODE_CLI;
  for (const tok of codeCliPriority()) {
    if (tok === "code") { if (codeCliWorks("code")) return "code"; }      // PATH bare — 존재검사 없이 --version
    else if (fs.existsSync(tok) && codeCliWorks(tok)) return tok;          // 경로 후보 — 실제 존재+동작
  }
  return null;
}
function tryInstallVsix(dryRun) {
  let files = [];
  try { files = fs.readdirSync(__dirname); } catch { /* ignore */ }
  let version = "";
  try { version = (require(path.join(__dirname, "package.json")).version) || ""; } catch { /* ignore */ }
  // ★ 실제 설치는 '항상' 현재 소스로 새로 빌드한다. 캐시된 vsix를 재사용하면 (1) 버전 올린 뒤 옛 vsix만 남거나
  //   (2) 버전은 같은데 옛 소스로 빌드된 stale vsix가 남았을 때 'git pull && install'이 옛 확장을 깔았다(둘 다 실제 발생).
  //   currentVsix(버전명 일치)만으론 (2)를 못 거르므로 캐시 재사용 자체를 버린다. npm run package = compile &&
  //   clean:vsix && vsce package 라 십수 초에 항상 최신을 보장. 빌드 도구가 없을 때(빌드 실패)만 기존 vsix로 폴백.
  let vsix = null;
  if (dryRun) {
    const cur = currentVsix(files, version);
    log("ℹ️  (미리보기) 실제 설치 시 현재 소스로 새로 빌드(npm run package) 후 설치합니다" +
      (cur ? ` (현재 ${cur}가 있어도 최신 보장 위해 재빌드).` : " (현재 버전 VSIX 없음 → 빌드로 생성)."));
    const detected = resolveCodeCli();
    log(detected ? `ℹ️  (미리보기) 확장 설치에 쓸 VS Code CLI: ${detected}` : "ℹ️  (미리보기) VS Code CLI(code)를 못 찾음 — CODE_CLI 지정 또는 수동 설치 필요.");
    return;
  }
  log("ℹ️  현재 소스로 확장을 새로 빌드합니다 (npm run package)…");
  let b;
  try { b = cp.spawnSync("npm run package", { cwd: __dirname, shell: true, encoding: "utf8", timeout: 300000, stdio: "inherit" }); }
  catch { b = null; }
  // npm run package는 성공이든 실패든 clean:vsix로 기존 VSIX를 이미 지웠을 수 있다(예: compile·clean은 됐는데 vsce 실패).
  // 그래서 빌드 결과와 무관하게 디렉터리를 '다시' 읽어 실제 '남아있는' VSIX로만 판단한다(삭제된 파일을 가리키지 않게).
  try { files = fs.readdirSync(__dirname); } catch { /* ignore */ }
  vsix = currentVsix(files, version);
  if (!(b && b.status === 0)) {
    // 빌드 실패(빌드 도구 미설치 / vsce 실패 등): 현재 버전 VSIX가 '실제로' 남아있으면 폴백(경고), 없으면 안내 후 종료.
    if (vsix) log(`⚠️  빌드 실패 — 남아있는 ${vsix}로 설치합니다(최신 소스가 아닐 수 있음). 'npm install' 후 재시도를 권장합니다.`);
    else { log("ℹ️  VSIX 빌드 실패 + 설치할 VSIX 없음(clean:vsix로 삭제됐을 수 있음) — 'npm install' 후 다시 실행하거나 확장을 수동 설치하세요."); return; }
  }
  if (!vsix) {
    log("ℹ️  확장 VSIX(codex-bridge-*.vsix)를 못 찾음 — 확장은 수동 설치하세요(또는 마켓플레이스).");
    return;
  }
  const vsixPath = path.join(__dirname, vsix);
  if (!fs.existsSync(vsixPath)) {
    // 최종 안전장치: 설치 직전 파일이 실제로 있는지 확인(빌드 산출물/폴백 불일치 방어 — 없는 파일로 code 설치 시도 방지).
    log(`ℹ️  설치할 VSIX 파일이 실제로 없습니다(${vsix}) — 'npm install' 후 다시 실행하세요.`);
    return;
  }
  const codeCli = resolveCodeCli();
  if (!codeCli) {
    // PATH에도 없고 표준 위치/환경변수 역추적으로도 못 찾음(아주 비표준 포터블 위치 등).
    log("ℹ️  VS Code CLI(code)를 못 찾아 확장 자동 설치를 건너뜁니다.");
    log(`   수동: VS Code에서 '확장: VSIX에서 설치'로 ${vsixPath} 선택`);
    log("   또는 환경변수 CODE_CLI 에 code(.cmd) 실행파일 경로 지정 후 재시도.");
    return;
  }
  const cmd = buildInstallCmd(codeCli, vsixPath);
  let r;
  try { r = cp.spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 120000 }); }
  catch { r = null; }
  if (r && r.status === 0) { log(`✅ 확장 설치: ${vsix}  (code: ${codeCli})`); }
  else {
    log(`ℹ️  확장 자동 설치 실패(code: ${codeCli}).`);
    log(`   수동: VS Code에서 '확장: VSIX에서 설치'로 ${vsixPath} 선택`);
    log("   또는 환경변수 CODE_CLI 에 code(.cmd) 실행파일 경로 지정 후 재시도.");
  }
}

function runDoctor() {
  const bridge = path.join(BRIDGE_DIR, "codex-bridge.js");
  if (!fs.existsSync(bridge)) { log("ℹ️  doctor 생략(브릿지 미설치)"); return; }
  log("\n── 설치 점검(doctor) ──");
  try {
    const r = cp.spawnSync(process.execPath, [bridge, "doctor"], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 * 64 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status !== 0 && r.stderr) process.stdout.write(r.stderr);
  } catch (e) { log("ℹ️  doctor 실행 실패: " + e.message); }
}

function cmdInstall(dryRun) {
  log(`codex-bridge 설치${dryRun ? " (미리보기)" : ""}`);
  log(`  브릿지 폴더 : ${BRIDGE_DIR}`);
  log(`  Claude 설정 : ${SETTINGS}`);

  // 1) node 토큰 결정(셸 실행 검증)
  const nt = resolveNodeToken();
  NODE_TOKEN = nt.token;
  log(`  훅 node     : ${NODE_TOKEN}  [${nt.how}]`);
  if (!nt.verified) {
    log("⚠️  node 실행을 셸에서 확인하지 못했습니다 — 훅이 안 돌 수 있습니다.");
    log("    설치 후 'node \"" + fwd(path.join(BRIDGE_DIR, "codex-bridge.js")) + "\" doctor'로 확인하거나,");
    log("    환경변수 CODEX_BRIDGE_NODE 에 node 실행파일 절대경로를 지정해 다시 실행하세요.");
  }

  // 2) 설정 검증을 '모든 쓰기 전에' — 손상/형식 이상이면 브릿지 복사도 하지 않고 중단(원본 보존).
  const s = readSettingsSafe();
  if (!s.ok) {
    log(`❌ 기존 settings.json이 올바른 JSON이 아닙니다 — 자동 병합을 중단합니다(손상 방지).`);
    log(`   파일: ${SETTINGS}`);
    log(`   사유: ${s.err}`);
    log(`   → 수동으로 JSON을 고친 뒤 다시 실행하세요.`);
    process.exit(1);
  }
  const shapeErr = checkHooksShape(s.settings);
  if (shapeErr) {
    log(`❌ settings.json 의 훅 형식이 예상과 달라 중단합니다(손상 방지): ${shapeErr}`);
    log(`   파일: ${SETTINGS} → 해당 항목을 확인한 뒤 다시 실행하세요.`);
    process.exit(1);
  }

  // 3) (검증 통과) 브릿지 파일 복사
  copyBridge(dryRun);

  // 4) 설정 백업 + 훅 병합
  const merged = mergeHooks(s.settings);
  const out = JSON.stringify(merged, null, 2) + "\n";
  if (dryRun) {
    log("✅ 훅 병합 미리보기(타인 훅 보존, 우리 훅만 교체):");
    for (const { event, script } of OUR_HOOKS) log(`     ${event} ← ${hookCommand(script)}`);
  } else {
    if (s.existed) { const bak = backupSettings(); log(`🗂  설정 백업: ${bak}`); }
    const ok = atomicWrite(SETTINGS, out);
    if (!ok) { log(`❌ 설정 저장 실패 — 원본은 그대로 보존됨: ${SETTINGS}`); process.exit(1); }
    log("✅ 훅 병합 완료(타인 훅 보존): UserPromptSubmit / PreToolUse:Bash / PreToolUse:ExitPlanMode / Stop");
  }

  // 5) 확장 + 점검
  tryInstallVsix(dryRun);
  if (!dryRun) runDoctor();

  log(`\n${dryRun ? "미리보기 끝(쓰기 없음)." : "설치 완료."} 새 Claude Code 세션부터 훅이 적용됩니다.`);
}

function cmdUninstall(purge) {
  log("codex-bridge 제거");
  const s = readSettingsSafe();
  if (!s.ok) {
    log(`❌ settings.json 파싱 실패 — 자동 수정 중단(손상 방지): ${SETTINGS}`);
    log(`   사유: ${s.err} → 수동으로 우리 훅 항목만 지우세요.`);
    process.exit(1);
  }
  const shapeErr = checkHooksShape(s.settings);
  if (shapeErr) {
    log(`❌ settings.json 훅 형식 이상 — 자동 수정 중단(손상 방지): ${shapeErr}`);
    log(`   파일: ${SETTINGS} → 수동으로 우리 훅 항목만 지우세요.`);
    process.exit(1);
  }
  if (s.existed) {
    const { settings, removed } = removeHooks(s.settings);
    if (removed > 0) {
      const bak = backupSettings();
      const ok = atomicWrite(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
      if (!ok) { log(`❌ 설정 저장 실패 — 원본 보존됨: ${SETTINGS}`); process.exit(1); }
      log(`🗂  설정 백업: ${bak}`);
      log(`✅ 우리 훅 ${removed}개 제거(타인 훅 보존).`);
    } else {
      log("ℹ️  제거할 우리 훅이 없습니다(이미 깨끗함).");
    }
  } else {
    log("ℹ️  settings.json이 없어 훅 제거 생략.");
  }
  if (purge) {
    try { fs.rmSync(BRIDGE_DIR, { recursive: true, force: true }); log(`✅ 브릿지 폴더 삭제: ${BRIDGE_DIR}`); }
    catch (e) { log(`ℹ️  브릿지 폴더 삭제 실패: ${e.message}`); }
  } else {
    log(`ℹ️  브릿지 파일은 남겨둡니다(${BRIDGE_DIR}). 완전 삭제는 'uninstall --purge'.`);
  }
  log("제거 완료. 새 세션부터 훅이 빠집니다.");
}

function cmdHelp() {
  log([
    "codex-bridge 설치기",
    "",
    "  node install.js              설치(멱등)",
    "  node install.js --dry-run    미리보기(쓰기 없음)",
    "  node install.js uninstall    제거(우리 훅만, 백업 보존)",
    "  node install.js uninstall --purge   위 + 브릿지 폴더 삭제",
    "  node install.js status       상태 점검(doctor)",
    "",
    "환경변수: CODEX_BRIDGE_HOME, CLAUDE_CONFIG_DIR, CODEX_BRIDGE_NODE, CODE_CLI",
  ].join("\n"));
}

// ── 진입점 ────────────────────────────────────────────
// CLI로 직접 실행할 때만 동작. require("./install.js") 시엔 순수함수만 노출(테스트용).
if (require.main === module) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const cmd = argv.find((a) => !a.startsWith("-")) || "install";

  if (has("--help") || has("-h") || cmd === "help") cmdHelp();
  else if (cmd === "uninstall") cmdUninstall(has("--purge"));
  else if (cmd === "status" || cmd === "doctor") runDoctor();
  else cmdInstall(has("--dry-run") || has("-n"));
}

module.exports = { pickVsix, currentVsix, buildInstallCmd, candidateCodeClis, findRootUpwards, vscodeSignalClis, standardCodeClis, codeCliPriority, OUR_HOOKS, BRIDGE_SCRIPTS, isOurHookCmd }; // 뒤 3개: hook-setup.ts와의 규칙 패리티 테스트용
