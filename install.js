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
 *   CODEX_BRIDGE_EXTENSIONS_DIR  비표준 VS Code의 extensions 폴더(같은 버전 안전 갱신용)
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
  "verify-cap-handoff.js",
  "codex-bridge.js",
  "ask-job-worker.js",
  "codex-hook.js",
  "codex-plugin-install.js",
  "contract-inject.js",
  "verify-guard.js",
  "codex-guard.js",
  "deepseek-bridge.js",
  "scout-gate.js",
  "project-map.js", // P0.5: Project MAP 순수 코어(out/ 산출물 사본 — scripts/sync-map-core.js가 생성·훅 아님)
  "map-runtime.js", // P0.5: Project MAP 런타임(수집기·draft·CLI 본체 — 훅 아님)
  "map-bootstrap.js", "map-pipeline.js", "map-bindings.js", "map-adapters.js", // P1: 비차단 bootstrap(훅이 lazy require — 훅 아님·detach 자식 실행기)
  "map-freshness.js", "map-reader.js", // P3b: P4 신설분 배포 편입 — map-adapters가 map-reader를 require하므로 누락 시 설치본 어댑터 전체 로드 불능(P3b 설계 A-3 실측 결함 봉합)
  "map-cutover.js", // P3b 증분 2: cutover 본체+frozen-ledger probe(대시보드 lazy 소비 — 설치본 부재 시 probe 불능)
  "map-probe.js", // P7: readiness probe 실행기(vscode 무관 계층 — 확장이 설치본 사본을 lazy require)
  "map-router.js", // P8: 결정론 라우터(1-34 표 — 실행기·테스트 공용 순수 계층)
  "map-enrich.js", // P8: 의미 보강 실행기(저장·순수+runEnrich+CLI — 발동 3지점이 spawn하는 표면)
  "map-intent.js", // P9: 정책 충돌 카드 파생 뷰+사용자 선택 선기록(자동 적용/UI 전 바닥 계층)
  "enrich-providers.js", // P8: 보강 어댑터 3종+Verifier 해소 진입점(설치본 자동 발동에서 실존해야 함)
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

// ⚠ 읽기 실패를 전부 null(=없음)로 접으면 안 된다. 권한 오류·잠금인데 부모 폴더 쓰기는 되는 조합에서
// '빈 설정'으로 병합해 사용자 설정을 백업 없이 지운다(검증 blocker 반례). ENOENT만 부재로 인정하고,
// 그 외 오류는 sentinel(READ_ERR)로 올려 호출부가 중단하게 한다.
const READ_ERR = Symbol("read-error");
function readText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (e) { if (e && e.code === "ENOENT") return null; return READ_ERR; }
}

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
  if (raw === READ_ERR) return { ok: false, settings: null, raw: null, existed: true, kind: "unreadable", err: "파일을 읽을 수 없음(권한·잠금) — 덮어쓰지 않음" };
  if (raw === null) return { ok: true, settings: {}, raw: null, existed: false };
  if (raw.trim() === "") return { ok: true, settings: {}, raw, existed: true }; // 빈 파일 = {} 취급(백업은 함)
  try {
    const parsed = JSON.parse(raw);
    // JSON 최상위가 객체가 아니면(배열·숫자 등) 병합 불가 — 손상으로 간주(덮어쓰지 않음).
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, settings: null, raw, existed: true, kind: "corrupt", err: "최상위가 JSON 객체가 아님" };
    }
    return { ok: true, settings: parsed, raw, existed: true };
  } catch (e) { return { ok: false, settings: null, raw, existed: true, kind: "corrupt", err: e.message }; }
}

function withDeployLock(fn) { // C-7 9차: wx 파일 잠금 — 검사기(map-cutover)·확장과 동일 프로토콜(".deploy.lock"·wx 원자 생성=신원 동시·read-back fence·자동 탈환 없음[contract-lock v10 결론]). 반환 {ok, why}
  const crypto = require("crypto");
  const lockPath = path.join(BRIDGE_DIR, ".deploy.lock");
  const token = JSON.stringify({ v: 1, pid: process.pid, rnd: crypto.randomBytes(8).toString("hex"), ts: new Date().toISOString() });
  const timeoutMs = Math.max(200, Number(process.env.CODEX_DEPLOY_LOCK_TIMEOUT_MS || 5000) || 5000);
  const t0 = Date.now();
  let staleWhy = null;
  for (;;) {
    if (Date.now() - t0 > timeoutMs) return { ok: false, why: staleWhy || ("타임아웃(다른 배포/검사 진행 중): " + lockPath + " — 잠시 후 재실행") };
    let locked = false;
    try { fs.writeFileSync(lockPath, token, { flag: "wx" }); locked = true; }
    catch (e) { if (!e || (e.code !== "EEXIST" && e.code !== "EPERM")) return { ok: false, why: "잠금 오류: " + String((e && e.code) || e) }; }
    if (locked) {
      let back = null;
      try { back = fs.readFileSync(lockPath, "utf8"); } catch { back = null; }
      if (back === token) break; // read-back fence — 실패=삭제 없이 재시도(확인-후-삭제 TOCTOU 폐기)
    } else {
      try {
        const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        const pid = Number(cur && cur.pid);
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); staleWhy = null; }
          catch (ke) { if (ke && ke.code === "ESRCH") staleWhy = "잔존 잠금(" + lockPath + " · pid " + pid + " 사망) — pid 사망을 확인했다면 이 파일을 삭제 후 재실행"; }
        }
      } catch { /* 판독 불가/경합 소멸 — 재시도 */ }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  let lockLost = false;
  try { fn(); }
  finally {
    let cur = null;
    try { cur = fs.readFileSync(lockPath, "utf8"); } catch { cur = null; }
    lockLost = cur !== token;
    if (!lockLost) { try { fs.unlinkSync(lockPath); } catch { /* 드묾 — 다음 획득자에게 stale 안내 */ } }
  }
  return lockLost ? { ok: false, why: "임계구역 중 잠금 파일이 외부에서 변경됨 — 설치 상태 재확인 후 재실행 권장" } : { ok: true, why: null };
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
    const locked = withDeployLock(() => { // 6차 blocker: 복사+manifest를 검사기와 상호 배제(검사 도중 교체 경합 소멸)
    for (const f of BRIDGE_SCRIPTS) fs.copyFileSync(path.join(SRC_BRIDGE, f), path.join(BRIDGE_DIR, f));
    { // C-7(B2): 배포 manifest — 이 설치가 하나의 세대임을 파일별 지문으로 증명(설치본 실행 cutover의 전수 검사 기준)
      // 5차 blocker: 지문은 복사 '원본'(레포 bridge/) 바이트에서 계산 — 목적지 재판독 금지. 대조↔기록 사이 다른
      // 배포자가 설치본을 교체하는 경합에서 혼합 세대가 정상 manifest로 승인되는 창을 제거한다(경합 시
      // manifest≠디스크 → cutover 전수 대조가 fail-closed로 거부 — 승인이 아니라 거부로 떨어지는 방향).
      const crypto = require("crypto");
      const files = {};
      for (const f of BRIDGE_SCRIPTS) files[f] = crypto.createHash("sha1").update(fs.readFileSync(path.join(SRC_BRIDGE, f))).digest("hex");
      fs.writeFileSync(path.join(BRIDGE_DIR, "deploy-manifest.json"), JSON.stringify({ schema: "deploy-manifest-v1", ts: new Date().toISOString(), files }, null, 1));
    }
    // 확장 자동배치 stamp 제거 = '수동(레포) 설치 모드' 표시 — 확장이 개발자의 최신 수동본을 옛 번들본으로 덮지 않게 한다(src/extension.ts deployBridgeRuntime 대칭).
    try { fs.unlinkSync(path.join(BRIDGE_DIR, ".bridge-deployed-by.json")); } catch { /* 없으면 무시 */ }
    });
    if (!locked.ok) { log("❌ 배포 잠금 실패: " + locked.why); process.exit(1); }
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
// `code --list-extensions --show-versions`의 한 줄(`publisher.name@1.2.3`)에서
// 우리 확장의 현재 버전만 안전하게 뽑는다. 같은 버전을 실행 중인 채 `--force`로
// 덮으면 VS Code가 기존 폴더부터 지운 뒤 재시작 요구로 멈출 수 있으므로 사전 확인에 쓴다.
function installedExtensionVersionFromList(output, extensionId) {
  const wanted = String(extensionId || "").trim().toLowerCase();
  if (!wanted) return null;
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.lastIndexOf("@");
    if (at <= 0) continue;
    if (line.slice(0, at).toLowerCase() === wanted) return line.slice(at + 1).trim() || null;
  }
  return null;
}
function installedExtensionState(codeCli, extensionId, spawnSyncImpl = cp.spawnSync) {
  const codeTok = /[\\/\s]/.test(String(codeCli)) ? q(fwd(codeCli)) : String(codeCli);
  try {
    const r = spawnSyncImpl(`${codeTok} --list-extensions --show-versions`, {
      shell: true,
      encoding: "utf8",
      timeout: 30000,
    });
    if (!r || r.status !== 0) return { ok: false, version: null };
    return { ok: true, version: installedExtensionVersionFromList(r.stdout, extensionId) };
  } catch {
    return { ok: false, version: null };
  }
}

// 같은 버전의 새 소스를 `code --install-extension --force`로 밀어 넣으면, 실행 중인 VS Code가
// 기존 확장 폴더를 먼저 지운 뒤 재시작 대기 상태에 들어갈 수 있다. 버전 숫자를 억지로 올리지 않고도
// GitHub 설치 묶음을 적용할 수 있도록, 현재 CLI가 실제로 쓰는 extensions 폴더를 좁게 찾은 뒤
// 런타임 파일만 백업·대조하며 덮는다. `.vsixmanifest` 등 VS Code 소유 파일은 건드리지 않는다.
function extensionRootCandidates(codeCli, env = process.env, home = HOME) {
  const out = [];
  const add = (p) => { if (p) { const abs = path.resolve(String(p)); if (!out.includes(abs)) out.push(abs); } };
  if (env.CODEX_BRIDGE_EXTENSIONS_DIR) return [path.resolve(String(env.CODEX_BRIDGE_EXTENSIONS_DIR))];
  const cli = String(codeCli || "");
  // bare `code`만으로는 PATH의 어느 설치본을 실행했는지 여기서 증명할 수 없다. 잘못된 다른
  // VS Code를 덮는 것보다 명시 위치를 요구하며 실패하는 편이 안전하다(resolveCodeCli는 정상
  // 자동탐지에서 bare 명령을 실제 실행 파일 절대경로로 바꿔 이 경로에 넘긴다).
  if (!/[\\/]/.test(cli)) return [];
  // 버전을 조회한 바로 그 CLI에서 유도한 포터블 루트를 항상 먼저 쓴다. VSCODE_CWD/PORTABLE은
  // 다른 열린 창의 값일 수 있으므로 여기서 독립 후보로 섞지 않는다(A CLI 확인→B 폴더 갱신 방지).
  add(path.join(path.dirname(path.dirname(path.resolve(cli))), "data", "extensions"));
  const insiders = /insiders/i.test(cli);
  add(path.join(home, insiders ? ".vscode-insiders" : ".vscode", "extensions"));
  return out;
}

function findInstalledExtensionDir(roots, extensionId, version) {
  const wantedId = String(extensionId || "").toLowerCase();
  const wantedVersion = String(version || "");
  for (const root of roots || []) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    const matches = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      const dir = path.join(root, ent.name);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { continue; }
      const id = meta && meta.publisher && meta.name ? `${meta.publisher}.${meta.name}`.toLowerCase() : "";
      if (id !== wantedId || String(meta.version || "") !== wantedVersion) continue;
      matches.push({ dir, exact: ent.name.toLowerCase() === `${wantedId}-${wantedVersion}` });
    }
    matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.dir.localeCompare(b.dir));
    if (matches.length) return matches[0].dir;
  }
  return null;
}

function walkFiles(root, rel = "") {
  const dir = path.join(root, rel);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    const child = path.join(rel, ent.name);
    if (ent.isDirectory() && !ent.isSymbolicLink()) out.push(...walkFiles(root, child));
    else if (ent.isFile()) out.push(child);
  }
  return out;
}

function sameVersionOverlayEntries(sourceRoot) {
  const pairs = [];
  const add = (sourceRel, targetRel = sourceRel) => {
    if (fs.existsSync(path.join(sourceRoot, sourceRel))) pairs.push({ sourceRel, targetRel });
  };
  for (const rel of walkFiles(path.join(sourceRoot, "out")).filter((p) => !p.endsWith(".map"))) add(path.join("out", rel));
  for (const rel of BRIDGE_SCRIPTS) add(path.join("bridge", rel));
  add(path.join(".agents", "plugins", "marketplace.json"));
  add(path.join("codex-plugin", "codex-peek", ".codex-plugin", "plugin.json"));
  add(path.join("codex-plugin", "codex-peek", "scripts", "codex-hook-launcher.js"));
  add("verify-envelope.json");
  add(path.join("docs", "icon.png"));
  add(path.join("docs", "README.en.md"), "readme.md");
  add("LICENSE", "LICENSE.txt");
  add("package.json"); // 활성화 메타는 런타임 파일이 모두 복사된 뒤 마지막에 교체한다.
  return pairs;
}

function overlaySameVersionExtension(sourceRoot, targetDir, expectedId, expectedVersion, backupParent) {
  let srcMeta, dstMeta;
  try {
    srcMeta = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    dstMeta = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8"));
    if (fs.lstatSync(targetDir).isSymbolicLink()) throw new Error("설치 폴더가 심볼릭 링크임");
  } catch (e) { return { ok: false, why: `메타데이터 판독 실패: ${e.message}` }; }
  const srcId = srcMeta.publisher && srcMeta.name ? `${srcMeta.publisher}.${srcMeta.name}` : "";
  const dstId = dstMeta.publisher && dstMeta.name ? `${dstMeta.publisher}.${dstMeta.name}` : "";
  if (srcId.toLowerCase() !== String(expectedId || "").toLowerCase() || dstId.toLowerCase() !== srcId.toLowerCase()
      || String(srcMeta.version || "") !== String(expectedVersion || "") || String(dstMeta.version || "") !== String(expectedVersion || "")) {
    return { ok: false, why: "확장 ID 또는 버전이 일치하지 않음" };
  }
  const entries = sameVersionOverlayEntries(sourceRoot);
  if (!entries.some((e) => e.targetRel === path.join("out", "extension.js")) || !entries.some((e) => e.targetRel === path.join("bridge", "codex-bridge.js"))) {
    return { ok: false, why: "컴파일된 핵심 파일(out/extension.js 또는 bridge/codex-bridge.js)이 없음" };
  }
  let backupDir;
  try {
    const parent = backupParent || os.tmpdir();
    fs.mkdirSync(parent, { recursive: true });
    backupDir = fs.mkdtempSync(path.join(parent, `codex-bridge-extension-${expectedVersion}-backup-`));
  } catch (e) { return { ok: false, why: `백업 폴더 생성 실패: ${e.message}` }; }
  const existed = [], created = [];
  try {
    const rootReal = fs.realpathSync(targetDir);
    for (const { sourceRel, targetRel } of entries) {
      const src = path.join(sourceRoot, sourceRel);
      const dst = path.join(targetDir, targetRel);
      let payload = fs.readFileSync(src);
      if (targetRel === "package.json" && Object.prototype.hasOwnProperty.call(dstMeta, "__metadata")) {
        // VS Code가 설치 시 덧붙인 관리 메타데이터는 소스 package.json에 없다. 새 확장 메타와
        // 결합해 보존해야 이후 업데이트/진단에서 불완전 설치로 보이지 않는다.
        const mergedMeta = Object.assign({}, srcMeta, { __metadata: dstMeta.__metadata });
        payload = Buffer.from(JSON.stringify(mergedMeta, null, "\t") + "\n", "utf8");
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const parentReal = fs.realpathSync(path.dirname(dst));
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) throw new Error(`설치 폴더 밖 경로 거부: ${targetRel}`);
      if (fs.existsSync(dst)) {
        if (fs.lstatSync(dst).isSymbolicLink()) throw new Error(`심볼릭 링크 파일 거부: ${targetRel}`);
        const bak = path.join(backupDir, targetRel);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dst, bak);
        existed.push({ dst, bak });
      } else created.push(dst);
      fs.writeFileSync(dst, payload);
      if (!payload.equals(fs.readFileSync(dst))) throw new Error(`복사 대조 실패: ${targetRel}`);
    }
    return { ok: true, count: entries.length, backupDir };
  } catch (e) {
    for (const dst of created.reverse()) { try { fs.unlinkSync(dst); } catch { /* best-effort rollback */ } }
    for (const { dst, bak } of existed.reverse()) { try { fs.copyFileSync(bak, dst); } catch { /* best-effort rollback */ } }
    return { ok: false, why: e.message, backupDir };
  }
}

function hasLocalPackageToolchain(root = __dirname) {
  return fs.existsSync(path.join(root, "node_modules", "typescript", "bin", "tsc"))
    && fs.existsSync(path.join(root, "node_modules", "@vscode", "vsce", "vsce"));
}

// 목록을 읽지 못하면 "미설치"로 추측하지 않는다. 그 추측이 동일 버전 강제 교체로 이어져
// 실행 중인 확장 폴더부터 사라진 실제 사고가 있었으므로, 판독 실패는 설치 보류가 정답이다.
function installVsixWithCli(codeCli, vsixPath, extensionId, version, spawnSyncImpl = cp.spawnSync) {
  const installed = installedExtensionState(codeCli, extensionId, spawnSyncImpl);
  if (!installed.ok) return { kind: "list-unreadable", command: null, result: null };
  if (version && installed.version === version) return { kind: "same-version", command: null, result: null };

  const command = buildInstallCmd(codeCli, vsixPath);
  let result;
  try { result = spawnSyncImpl(command, { shell: true, encoding: "utf8", timeout: 120000 }); }
  catch { result = null; }
  return {
    kind: result && result.status === 0 ? "installed" : "install-failed",
    command,
    result,
  };
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
function standardCodeClis(env = process.env) {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const bin = isWin ? "code.cmd" : "code";
  const list = [];
  const fromRoot = (root) => { if (root) list.push(path.join(root, "bin", bin)); };
  if (isWin) {
    // 환경변수가 없어도 동작하도록 표준 기본값으로 폴백(LOCALAPPDATA→홈/AppData/Local, ProgramFiles→C:\Program Files).
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const progFiles = env.ProgramFiles || "C:\\Program Files";
    const progFiles86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
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
  return [...new Set([...vscodeSignalClis(env), "code", ...standardCodeClis(env)])];
}
// 하위호환: 신호+표준 후보(‘code’ 제외) — 기존 호출/테스트용.
function candidateCodeClis(env) {
  return [...new Set([...vscodeSignalClis(env), ...standardCodeClis(env)])];
}
// PATH의 bare 명령을 실제 실행 파일에 결속한다. 같은 이름의 다른 VS Code 폴더를 갱신하지
// 않으려면 `--version`을 실행한 대상과 extensions 루트를 유도한 대상이 같은 절대경로여야 한다.
function resolveCommandOnPath(command, env = process.env, platform = process.platform, cwd = process.cwd()) {
  let cmd = String(command || "").trim();
  if (cmd.startsWith('"') && cmd.endsWith('"')) cmd = cmd.slice(1, -1);
  if (!cmd) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (/[\\/]/.test(cmd)) {
    try { return fs.statSync(cmd).isFile() ? real(cmd) : null; } catch { return null; }
  }
  const isWin = platform === "win32";
  const pathText = String(env.PATH || env.Path || env.path || "");
  const delim = isWin ? ";" : ":";
  const dirs = [...new Set([...(isWin && cwd ? [cwd] : []), ...pathText.split(delim)]
    .map((p) => String(p || "").trim().replace(/^"|"$/g, "")).filter(Boolean))];
  let suffixes = [""];
  if (isWin && !path.extname(cmd)) {
    const pathext = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((x) => x.trim()).filter(Boolean);
    suffixes = [...new Set(["", ...pathext, ...pathext.map((x) => x.toLowerCase())])];
  }
  for (const dir of dirs) for (const suffix of suffixes) {
    const candidate = path.join(dir, cmd + suffix);
    try { if (fs.statSync(candidate).isFile()) return real(candidate); } catch { /* 다음 PATH 후보 */ }
  }
  return null;
}
// 실제로 동작하는 code 실행파일인지 확인(--version 시도). 경로/공백 있으면 따옴표, bare 이름은 그대로(PATHEXT 해석 위해).
function codeCliWorks(tok, env = process.env) {
  if (!tok) return false;
  const t = /[\\/\s]/.test(String(tok)) ? q(fwd(tok)) : String(tok);
  try { const r = cp.spawnSync(`${t} --version`, { shell: true, encoding: "utf8", timeout: 30000, env }); return !!(r && r.status === 0); }
  catch { return false; }
}
// 쓸 code CLI를 결정: ① CODE_CLI 명시(그대로 신뢰 — 자동탐지 안 함; 테스트가 가짜값으로 자동설치 무력화하는 계약 유지)
// ② codeCliPriority 순서대로 — 현재 VS Code 신호(존재+동작) → PATH 'code'(동작) → OS 표준(존재+동작). 못 찾으면 null.
function resolveCodeCli(env = process.env) {
  if (env.CODE_CLI) {
    const bound = resolveCommandOnPath(env.CODE_CLI, env);
    if (bound && codeCliWorks(bound, env)) return bound;
    return codeCliWorks(env.CODE_CLI, env) ? env.CODE_CLI : null; // 셸 별칭이면 같은 버전 갱신은 명시 extensions 경로를 요구
  }
  for (const tok of codeCliPriority(env)) {
    const bound = resolveCommandOnPath(tok, env);
    if (bound && codeCliWorks(bound, env)) return bound;
  }
  return null;
}
function tryInstallVsix(dryRun) {
  let files = [];
  try { files = fs.readdirSync(__dirname); } catch { /* ignore */ }
  let version = "";
  let extensionId = "";
  try {
    const meta = require(path.join(__dirname, "package.json"));
    version = meta.version || "";
    extensionId = meta.publisher && meta.name ? `${meta.publisher}.${meta.name}` : "";
  } catch { /* ignore */ }
  // 개발 체크아웃은 현재 소스로 다시 빌드해 stale VSIX를 피한다. GitHub 설치 묶음은 node_modules 없이
  // 배포되므로, 정확한 현재 버전의 동봉 VSIX를 릴리스 산출물로 신뢰해 그대로 사용한다.
  let vsix = null;
  if (dryRun) {
    const cur = currentVsix(files, version);
    if (hasLocalPackageToolchain(__dirname)) {
      log("ℹ️  (미리보기) 실제 설치 시 현재 소스로 새로 빌드(npm run package) 후 설치합니다" +
        (cur ? ` (현재 ${cur}가 있어도 최신 보장 위해 재빌드).` : " (현재 버전 VSIX 없음 → 빌드로 생성)."));
    } else if (cur) {
      log(`ℹ️  (미리보기) GitHub 설치 묶음의 미리 빌드된 ${cur}를 사용합니다 (npm install 불필요).`);
    } else {
      log("ℹ️  (미리보기) 빌드 도구와 현재 버전 VSIX가 없어 확장 설치는 보류됩니다. 먼저 'npm install'이 필요합니다.");
    }
    const detected = resolveCodeCli();
    log(detected ? `ℹ️  (미리보기) 확장 설치에 쓸 VS Code CLI: ${detected}` : "ℹ️  (미리보기) VS Code CLI(code)를 못 찾음 — CODE_CLI 지정 또는 수동 설치 필요.");
    return true;
  }
  let b;
  const bundled = currentVsix(files, version);
  if (!hasLocalPackageToolchain(__dirname) && bundled) {
    log(`ℹ️  GitHub 설치 묶음의 미리 빌드된 ${bundled}를 사용합니다 (npm install 불필요).`);
    b = { status: 0, bundled: true };
  } else if (!hasLocalPackageToolchain(__dirname)) {
    log("ℹ️  확장을 빌드할 도구가 없고 함께 제공된 VSIX도 없습니다. 먼저 'npm install'을 실행하세요.");
    return true;
  } else {
    log("ℹ️  현재 소스로 확장을 새로 빌드합니다 (npm run package)…");
    try { b = cp.spawnSync("npm run package", { cwd: __dirname, shell: true, encoding: "utf8", timeout: 300000, stdio: "inherit" }); }
    catch { b = null; }
  }
  // npm run package는 성공이든 실패든 clean:vsix로 기존 VSIX를 이미 지웠을 수 있다(예: compile·clean은 됐는데 vsce 실패).
  // 그래서 빌드 결과와 무관하게 디렉터리를 '다시' 읽어 실제 '남아있는' VSIX로만 판단한다(삭제된 파일을 가리키지 않게).
  try { files = fs.readdirSync(__dirname); } catch { /* ignore */ }
  vsix = currentVsix(files, version);
  if (!(b && b.status === 0)) {
    // 빌드 실패(빌드 도구 미설치 / vsce 실패 등): 현재 버전 VSIX가 '실제로' 남아있으면 폴백(경고), 없으면 안내 후 종료.
    if (vsix) log(`⚠️  빌드 실패 — 남아있는 ${vsix}로 설치합니다(최신 소스가 아닐 수 있음). 'npm install' 후 재시도를 권장합니다.`);
    else { log("ℹ️  VSIX 빌드 실패 + 설치할 VSIX 없음(clean:vsix로 삭제됐을 수 있음) — 'npm install' 후 다시 실행하거나 확장을 수동 설치하세요."); return true; }
  }
  if (!vsix) {
    log("ℹ️  확장 VSIX(codex-bridge-*.vsix)를 못 찾음 — 확장은 수동 설치하세요(또는 마켓플레이스).");
    return true;
  }
  const vsixPath = path.join(__dirname, vsix);
  if (!fs.existsSync(vsixPath)) {
    // 최종 안전장치: 설치 직전 파일이 실제로 있는지 확인(빌드 산출물/폴백 불일치 방어 — 없는 파일로 code 설치 시도 방지).
    log(`ℹ️  설치할 VSIX 파일이 실제로 없습니다(${vsix}) — 'npm install' 후 다시 실행하세요.`);
    return true;
  }
  const codeCli = resolveCodeCli();
  if (!codeCli) {
    // PATH에도 없고 표준 위치/환경변수 역추적으로도 못 찾음(아주 비표준 포터블 위치 등).
    log("ℹ️  VS Code CLI(code)를 못 찾아 확장 자동 설치를 건너뜁니다.");
    log(`   수동: VS Code에서 '확장: VSIX에서 설치'로 ${vsixPath} 선택`);
    log("   또는 환경변수 CODE_CLI 에 code(.cmd) 실행파일 경로 지정 후 재시도.");
    return true;
  }
  const installResult = installVsixWithCli(codeCli, vsixPath, extensionId, version);
  if (installResult.kind === "list-unreadable") {
    log(`ℹ️  확장 설치 목록을 읽지 못해 자동 설치를 안전하게 보류합니다(${extensionId}).`);
    log("   미설치로 추측해 강제 교체하면 실행 중인 확장 폴더가 먼저 사라질 수 있습니다.");
    log("   VS Code를 완전히 다시 연 뒤 설치기를 재실행하거나 새 버전 VSIX를 수동 설치하세요.");
    return true; // 기존 계약: 브릿지·훅 설치는 유지하고 확장만 명시적으로 보류한다.
  }
  if (installResult.kind === "same-version") {
    const roots = extensionRootCandidates(codeCli);
    const target = findInstalledExtensionDir(roots, extensionId, version);
    if (!target) {
      log(`ℹ️  확장 ${extensionId}@${version}의 실제 설치 폴더를 찾지 못해 같은 버전 갱신을 안전하게 보류합니다.`);
      log(`   확인한 위치: ${roots.join(" · ") || "없음"}`);
      log("   비표준 위치라면 CODEX_BRIDGE_EXTENSIONS_DIR에 extensions 폴더를 지정한 뒤 재실행하세요.");
      return false;
    }
    const over = overlaySameVersionExtension(__dirname, target, extensionId, version);
    if (!over.ok) {
      log(`ℹ️  같은 버전 안전 갱신을 완료하지 못했습니다: ${over.why}`);
      if (over.backupDir) log(`   복구용 백업: ${over.backupDir}`);
      return false;
    }
    log(`✅ 같은 버전 안전 갱신: ${extensionId}@${version} 런타임 ${over.count}개 → ${target}`);
    log(`   기존 파일 백업: ${over.backupDir}`);
    log("   VS Code 소유 설치 메타데이터는 보존했습니다. Developer: Reload Window로 새 코드를 불러오세요.");
    return true;
  }
  if (installResult.kind === "installed") { log(`✅ 확장 설치: ${vsix}  (code: ${codeCli})`); return true; }
  else {
    log(`ℹ️  확장 자동 설치 실패(code: ${codeCli}).`);
    log(`   수동: VS Code에서 '확장: VSIX에서 설치'로 ${vsixPath} 선택`);
    log("   또는 환경변수 CODE_CLI 에 code(.cmd) 실행파일 경로 지정 후 재시도.");
    return true;
  }
}

// 레포에서 status를 실행할 때는 "실행 가능"만 보지 말고, 지금 레포의 실행 파일과 실제 훅이 부르는
// 운영 사본이 같은 세대인지 먼저 본다. 사용자가 새 코드를 받은 뒤 창만 리로드하면 옛 확장 묶음이 옛
// 사본을 계속 쓰는 상황을 doctor의 초록처럼 오해하지 않게 한다.
function bridgeRuntimeParity(srcDir = SRC_BRIDGE, liveDir = BRIDGE_DIR, files = BRIDGE_SCRIPTS) {
  const missing = [], changed = [];
  for (const f of files) {
    const src = path.join(srcDir, f), live = path.join(liveDir, f);
    if (!fs.existsSync(src) || !fs.existsSync(live)) { missing.push(f); continue; }
    try { if (!fs.readFileSync(src).equals(fs.readFileSync(live))) changed.push(f); }
    catch { changed.push(f); }
  }
  let manifest = "ok";
  try {
    const m = JSON.parse(fs.readFileSync(path.join(liveDir, "deploy-manifest.json"), "utf8"));
    const got = m && m.schema === "deploy-manifest-v1" && m.files && typeof m.files === "object"
      ? Object.keys(m.files).sort().join(",") : "";
    if (got !== [...files].sort().join(",")) manifest = "set-mismatch";
    else {
      const crypto = require("crypto");
      for (const f of files) {
        const sha = crypto.createHash("sha1").update(fs.readFileSync(path.join(srcDir, f))).digest("hex");
        if (m.files[f] !== sha) { manifest = "source-mismatch"; break; }
      }
    }
  } catch { manifest = "missing-or-corrupt"; }
  return { ok: missing.length === 0 && changed.length === 0 && manifest === "ok", missing, changed, manifest };
}

function runDoctor() {
  const bridge = path.join(BRIDGE_DIR, "codex-bridge.js");
  if (!fs.existsSync(bridge)) { log("❌ 활성 브릿지 미설치 — node install.js 실행 필요"); return false; }
  const parity = bridgeRuntimeParity();
  if (!parity.ok) {
    log("❌ 현재 레포와 활성 브릿지의 실행 세대가 다릅니다 — 창 리로드만으로는 갱신되지 않습니다.");
    if (parity.missing.length) log("   빠진 실행 파일: " + parity.missing.join(", "));
    if (parity.changed.length) log("   내용이 다른 실행 파일: " + parity.changed.join(", "));
    if (parity.manifest !== "ok") log("   배포 목록 상태: " + parity.manifest);
    log("   이 레포에서 node install.js 를 실행한 뒤 다시 status를 확인하세요.");
  } else log("✅ 현재 레포와 활성 브릿지의 실행 세대가 같습니다.");
  log("\n── 설치 점검(doctor) ──");
  let doctorOk = true;
  try {
    const r = cp.spawnSync(process.execPath, [bridge, "doctor"], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 * 64 });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status !== 0 && r.stderr) process.stdout.write(r.stderr);
    doctorOk = r.status === 0;
  } catch (e) { log("ℹ️  doctor 실행 실패: " + e.message); doctorOk = false; }
  return parity.ok && doctorOk;
}

// 설치 뒤 "언제 적용되나" 안내 — hook-setup.ts claudeHookApplyNote(ko)와 같은 규칙·같은 문장(패리티 테스트로 잠금).
// 실측 근거(Claude Code 2.0.22 cli.js): 설정 파일을 감시하다가 바뀌면 다시 읽는다("Watching for changes in
// setting files …"). 감시 목록은 세션 시작 시 '실제로 존재하는 파일'만 담는다(statSync(...).isFile()).
// 그래서 ①등록 불변=즉시 ②등록 변경+파일 원래 있었음=현재 세션 반영 ③파일을 이번에 새로 만듦=새 세션.
// ⚠ 설치기는 '지금 파일이 있는가'만 알 뿐 '현재 세션 시작 때 있었는가'는 모른다.
// 그래서 ①②는 조건을 먼저 쓰고 두 경우를 함께 밝힌다(단정 후 예외를 덧대면 읽는 순서가 꼬인다 — 검증 지적).
function claudeHookApplyNote(registrationChanged, settingsExisted) {
  if (!registrationChanged) return "Claude 훅은 등록이 그대로입니다. 이 설정 파일을 가지고 시작한 세션이면 새 스크립트가 다음 프롬프트부터 바로 적용되고, 파일이 아예 없던 상태에서 시작한 세션이면 새 세션이 필요합니다.";
  if (settingsExisted) return "Claude 훅 등록이 바뀌었습니다. Claude Code가 설정 파일 변경을 감시하므로, 이 파일을 가지고 시작한 세션이면 재시작 없이 반영되고 파일이 없던 상태에서 시작한 세션이면 새 세션이 필요합니다.";
  return "Claude 훅은 설정 파일을 이번에 새로 만들었습니다. 이미 실행 중인 세션은 그 파일을 감시하고 있지 않으니 새 Claude Code 세션에서 적용됩니다.";
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
    // 중단 사유가 "읽을 수 없음"인지 "JSON 손상"인지 갈라 안내한다 — 권한·잠금인데 JSON을 고치라고
    // 하면 사용자가 멀쩡한 설정을 건드린다(검증 [주의] 반영).
    const unreadable = s.kind === "unreadable";
    log(unreadable
      ? `❌ settings.json을 읽을 수 없습니다 — 자동 병합을 중단했습니다(원본 그대로).`
      : `❌ 기존 settings.json이 올바른 JSON이 아닙니다 — 자동 병합을 중단합니다(손상 방지).`);
    log(`   파일: ${SETTINGS}`);
    log(`   사유: ${s.err}`);
    log(unreadable
      ? `   → 파일 내용 문제가 아닙니다. 권한과 파일 잠금(다른 프로그램이 열고 있는지)을 확인한 뒤 다시 실행하세요.`
      : `   → 수동으로 JSON을 고친 뒤 다시 실행하세요.`);
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
  // mergeHooks는 넘긴 설정을 '그 자리에서' 고쳐 돌려준다 — 비교하려면 부르기 전에 원본을 떠 둬야 한다.
  // (병합 후에 비교하면 같은 객체끼리 대는 셈이라 언제나 '불변'으로 나온다. 실행 반례로 잡힌 결함.)
  // 순서만 다른 것은 '변경'이 아니다: mergeHooks가 우리 훅을 떼었다 뒤에 다시 붙이므로 내용이 같아도
  // 위치가 달라질 수 있다. 다만 엔트리는 '통째로' 정규화한다 — command·matcher만 남기면 timeout·async·type
  // 처럼 실행 의미를 바꾸는 필드가 달라져도 같은 것으로 보여 진짜 변경을 놓친다(검증 지적).
  const canonVal = (v) => {
    if (Array.isArray(v)) return "[" + v.map(canonVal).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonVal(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  };
  const hooksCanon = (hooks) => {
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "";
    const out = {};
    for (const ev of Object.keys(hooks).sort()) {
      const arr = Array.isArray(hooks[ev]) ? hooks[ev] : [];
      // 그룹 경계는 유지(matcher는 그룹 속성) · 그룹과 엔트리의 '나열 순서'만 정렬로 흡수.
      out[ev] = arr.map((g) => (g && typeof g === "object" && Array.isArray(g.hooks)
        ? canonVal(Object.assign({}, g, { hooks: g.hooks.map(canonVal).sort() }))
        : canonVal(g))).sort();
    }
    return JSON.stringify(out);
  };
  const hooksBefore = hooksCanon(s.settings && s.settings.hooks);
  const merged = mergeHooks(s.settings);
  const out = JSON.stringify(merged, null, 2) + "\n";
  let hooksRegistrationChanged = true; // 미확정 상태 방어값(dryRun 경로는 이 안내를 출력하지 않는다)
  if (dryRun) {
    log("✅ 훅 병합 미리보기(타인 훅 보존, 우리 훅만 교체):");
    for (const { event, script } of OUR_HOOKS) log(`     ${event} ← ${hookCommand(script)}`);
  } else {
    // 훅 '등록'이 실제로 바뀌었는지 여기서만 알 수 있다. 등록이 그대로면 현재 Claude 세션이 다음
    // 프롬프트부터 새 스크립트를 그대로 읽는다(등록된 명령은 매번 새 프로세스를 띄운다) — 이 사실을
    // 마지막 안내에서 갈라 쓰려고 결과를 남긴다. 항상 '새 세션 필요'라고 적으면 매번 틀린 안내가 된다.
    hooksRegistrationChanged = !s.existed || hooksBefore !== hooksCanon(merged.hooks);
    if (s.existed) { const bak = backupSettings(); log(`🗂  설정 백업: ${bak}`); }
    const ok = atomicWrite(SETTINGS, out);
    if (!ok) { log(`❌ 설정 저장 실패 — 원본은 그대로 보존됨: ${SETTINGS}`); process.exit(1); }
    log("✅ 훅 병합 완료(타인 훅 보존): UserPromptSubmit / PreToolUse:Bash / PreToolUse:ExitPlanMode / Stop");
  }

  // 5) 확장 + 점검
  const extensionOk = tryInstallVsix(dryRun);
  const doctorOk = dryRun ? true : runDoctor();
  if (!extensionOk || !doctorOk) {
    log("\n❌ 설치 미완료 — 브릿지·훅의 반영 여부와 위 오류를 확인한 뒤 다시 실행하세요.");
    return false;
  }

  // 문안은 hook-setup.ts claudeHookApplyNote와 '같은 규칙'이다(이 파일은 빌드 산출물에 의존하지 않으려고
  // 규칙을 복제하는 기존 관례를 따른다 — OUR_HOOKS·isOurHookCmd와 동일). 두 문장이 갈라지지 않도록
  // 패리티 테스트로 잠근다. 한쪽만 고치면 테스트가 깨진다.
  const claudeNote = claudeHookApplyNote(hooksRegistrationChanged, !!s.existed);
  log(dryRun
    ? "\n미리보기 끝(쓰기 없음)."
    : `\n설치 완료. VS Code에서 'Developer: Reload Window'를 한 번 실행해야 새 확장·Codex 훅 상태가 현재 창에 적용됩니다. ${claudeNote}`);
  return true;
}

function cmdUninstall(purge) {
  log("codex-bridge 제거");
  const s = readSettingsSafe();
  if (!s.ok) {
    const unreadable = s.kind === "unreadable";
    log(unreadable
      ? `❌ settings.json을 읽을 수 없습니다 — 자동 수정 중단(원본 그대로): ${SETTINGS}`
      : `❌ settings.json 파싱 실패 — 자동 수정 중단(손상 방지): ${SETTINGS}`);
    log(unreadable
      ? `   사유: ${s.err} → 파일 내용 문제가 아닙니다. 권한과 파일 잠금을 확인한 뒤 다시 실행하세요.`
      : `   사유: ${s.err} → 수동으로 우리 훅 항목만 지우세요.`);
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
  // 제거도 설정 파일 '변경'이라 감시가 잡는다. 다만 설치용 단서를 그대로 쓰면 안 된다 — 설정 파일이 없던
  // 상태에서 시작한 세션은 애초에 훅을 로드하지 않았으므로 제거 쪽에서는 오히려 재시작이 불필요하다(검증 반례).
  log("제거 완료. Claude Code가 설정 파일 변경을 감시하므로 그 파일을 가지고 시작한 세션이면 재시작 없이 훅이 빠집니다. (그 파일이 없던 상태에서 시작한 세션은 애초에 훅을 들고 있지 않으니 이미 빠진 상태입니다.)");
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
  else if (cmd === "status" || cmd === "doctor") { if (!runDoctor()) process.exitCode = 1; }
  else if (!cmdInstall(has("--dry-run") || has("-n"))) process.exitCode = 1;
}

module.exports = { pickVsix, currentVsix, buildInstallCmd, installedExtensionVersionFromList, installVsixWithCli, extensionRootCandidates, findInstalledExtensionDir, sameVersionOverlayEntries, overlaySameVersionExtension, hasLocalPackageToolchain, resolveCommandOnPath, resolveCodeCli, candidateCodeClis, findRootUpwards, vscodeSignalClis, standardCodeClis, codeCliPriority, bridgeRuntimeParity, OUR_HOOKS, BRIDGE_SCRIPTS, isOurHookCmd, claudeHookApplyNote }; // 뒤 3개: hook-setup.ts와의 규칙 패리티 테스트용
