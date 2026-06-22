#!/usr/bin/env node
"use strict";
/*
 * codex-bridge 한방 설치기 (풀 자동, 크로스플랫폼 node 코어)
 *
 * 하는 일 (상황으로):
 *  - 브릿지 실행파일(5개 .js)을 사용자 홈의 운영 폴더로 복사한다.
 *  - Claude Code 설정(settings.json)에 "코덱스 검증 훅" 3개를 끼워 넣는다.
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
 *   CODE_CLI           VS Code CLI(code) 경로      (기본 PATH의 code)
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
];

// 우리가 settings.json에 심는 훅. event → {matcher, script}
const OUR_HOOKS = [
  { event: "UserPromptSubmit", matcher: "", script: "contract-inject.js" },
  { event: "PreToolUse", matcher: "Bash", script: "codex-guard.js" },
  { event: "Stop", matcher: "", script: "verify-guard.js" },
];
// "우리 훅"을 식별하는 파일명(경로·따옴표·node표기 무관하게 basename으로 매칭).
const OUR_SCRIPT_NAMES = ["contract-inject.js", "codex-guard.js", "verify-guard.js"];

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
  return /(^|[\\/\s"'])(contract-inject|codex-guard|verify-guard)\.js(?=$|["'\s;,&|)])/.test(String(cmd || ""));
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
function mergeHooks(settings) {
  settings.hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  for (const { event, matcher, script } of OUR_HOOKS) {
    const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = [];
    for (const g of arr) { const { group } = stripOurFromGroup(g); if (group) cleaned.push(group); }
    cleaned.push({ matcher, hooks: [{ type: "command", command: hookCommand(script) }] });
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
// code 설치 명령 문자열 조립(순수함수). ⚠ bare 명령(code)을 따옴표로 감싸면 Windows cmd에서 PATHEXT(.cmd)
// 해석이 깨져 9009로 실패한다(재현 확인). 그래서 경로/공백 있는 실행파일만 따옴표, bare 이름은 그대로.
// vsix 경로는 공백 있어도 되게 항상 따옴표.
function buildInstallCmd(codeCli, vsixPath) {
  const codeTok = /[\\/\s]/.test(String(codeCli)) ? q(fwd(codeCli)) : String(codeCli);
  return `${codeTok} --install-extension ${q(fwd(vsixPath))} --force`;
}
function tryInstallVsix(dryRun) {
  let files = [];
  try { files = fs.readdirSync(__dirname); } catch { /* ignore */ }
  let version = "";
  try { version = (require(path.join(__dirname, "package.json")).version) || ""; } catch { /* ignore */ }
  const vsix = pickVsix(files, version);
  if (!vsix) { log("ℹ️  확장 VSIX(codex-bridge-*.vsix)를 못 찾음 — 확장은 수동 설치하세요(또는 마켓플레이스)."); return; }
  const vsixPath = path.join(__dirname, vsix);
  const codeCli = process.env.CODE_CLI || "code";
  const cmd = buildInstallCmd(codeCli, vsixPath);
  if (dryRun) { log(`ℹ️  (미리보기) 확장 설치 예정: ${cmd}`); return; }
  let r;
  try { r = cp.spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 120000 }); }
  catch { r = null; }
  if (r && r.status === 0) { log(`✅ 확장 설치: ${vsix}`); }
  else {
    log("ℹ️  확장 자동 설치 실패(code CLI 없음/무설치형 VS Code일 수 있음).");
    log(`   수동: VS Code에서 '확장: VSIX에서 설치'로 ${vsixPath} 선택`);
    log("   또는 환경변수 CODE_CLI 에 code 실행파일 경로 지정 후 재시도.");
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
    log("✅ 훅 병합 완료(타인 훅 보존): UserPromptSubmit / PreToolUse:Bash / Stop");
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

module.exports = { pickVsix, buildInstallCmd };
