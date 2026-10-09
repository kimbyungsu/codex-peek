"use strict";
/*
 * [2026-10-09 실사고] Codex↔Codex 모드에서 selector-preview 가 늘 '선별 실패'로 끝나던 순서 결함의 봉합 시험.
 * 원인: codex-bridge.js 가 파일 끝에서 main() 을 먼저 부르고 내보내기(module.exports)를 나중에 채웠다 —
 * 선별 실행기(selector-runner)의 Codex 팔은 실행 도중 require("./codex-bridge.js").resolveCodex() 를 조회하므로
 * 첫 페이지가 빈 내보내기를 받아 'resolveCodex is not a function'(spawn-prep-failed)로 실패했다(Claude 팔은 이 조회가 없어 드러나지 않음).
 * 시험: 실제 CLI 를 실행하고, 주입한 페이지 실행기가 '실물과 같은 시점(첫 페이지 호출 안)'에 codex-bridge.js 를 다시 불러와
 * resolveCodex 가 함수인지 기록한다 — Claude 차례(arm self)와 Codex 차례(arm codex) 둘 다.
 * 격리: 임시 CODEX_BRIDGE_HOME · 임시 작업 폴더 · 네트워크·실제 모델 호출 없음.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "selfload-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const CLI = path.join(__dirname, "..", "bridge", "codex-bridge.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "selfload-ws-"));
const coreRaw = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["로컬"], alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"], outOfScope: ["다중 배포"] }, null, 1);
fs.writeFileSync(path.join(WS, CL.ENVELOPE_FILE), coreRaw);
CL.setEnvelopeHashAllSlots(WS, sha1(coreRaw));
const arcText = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "고객 기록은 지우지 않는다"] }, null, 1);
fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), arcText);
CL.setContractHashAllSlots(WS, "archiveHash", sha1(arcText));

const SNAP = "이번 작업: 백업 정책 지키며 스크립트 수정";
const ANCHOR = "anchSelfLd1";
fs.mkdirSync(path.dirname(CL.constraintTurnFileFor(WS, ANCHOR)), { recursive: true });
fs.writeFileSync(CL.constraintTurnFileFor(WS, ANCHOR), SNAP);

// 주입 페이지 실행기 — 실물 selector-runner 의 Codex 팔과 같은 시점(페이지 호출 안)에 브릿지를 다시 불러와 기록
const FIX = fs.mkdtempSync(path.join(os.tmpdir(), "selfload-fix-"));
const marker = path.join(FIX, "seen.jsonl");
const fake = path.join(FIX, "fake-runner.js");
fs.writeFileSync(fake, [
  '"use strict";',
  "const fs = require('fs');",
  "module.exports.runSelectorPage = function (a) {",
  "  const CB = require(" + JSON.stringify(CLI.replace(/\\/g, "/")) + ");",
  "  fs.appendFileSync(" + JSON.stringify(marker.replace(/\\/g, "/")) + ", JSON.stringify({ arm: a.arm, resolveCodexIsFn: typeof CB.resolveCodex === 'function' }) + '\\n');",
  "  if (typeof CB.resolveCodex !== 'function') return { promise: Promise.resolve({ ok: false, key: 'spawn-prep-failed', detail: 'resolveCodex is not a function' }), cancel() {} };",
  "  const ids = [...String(a.prompt).matchAll(/^(arc-\\d+): /gm)].map((m) => m[1]);",
  "  return { promise: Promise.resolve({ ok: true, output: JSON.stringify({ relevant: ids.slice(0, 1) }) }), cancel() {} };",
  "};",
].join("\n"));
const readSeen = () => { try { return fs.readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const baseEnv = () => { const e = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: WS, CODEX_BRIDGE_SELECTOR_RUNNER: fake }); delete e.CLAUDE_CODE_SESSION_ID; delete e.CODEX_THREAD_ID; return e; };
const run = (env) => cp.spawnSync(process.execPath, [CLI, "selector-preview"], { env, encoding: "utf8", cwd: WS, timeout: 120000, windowsHide: true });

t("Claude 차례(arm self) — 첫 페이지 호출 시점에 브릿지 내보내기가 채워져 있음 · 미리보기 영수증 기록", () => {
  fs.rmSync(marker, { force: true });
  const SESS = "sessSelfLoad01";
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: WS, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: ANCHOR, constraintSourceHash: sha1(SNAP) }));
  const r = run(Object.assign(baseEnv(), { CLAUDE_CODE_SESSION_ID: SESS }));
  const seen = readSeen();
  assert.ok(seen.length >= 1 && seen.every((s) => s.arm === "self" && s.resolveCodexIsFn === true), "페이지 호출 시점 내보내기 " + JSON.stringify(seen) + r.stderr);
  assert.ok(r.status === 0 && /영수증|receipt/.test(r.stdout) && !/선별 실패|Selection failed/.test(r.stdout + r.stderr), r.stdout + r.stderr);
});

t("★Codex 차례(arm codex · 실사고 모양) — 첫 페이지 호출 시점에 resolveCodex 가 함수 · 선별 실패 없이 영수증 기록", () => {
  fs.rmSync(marker, { force: true });
  const XSID = "019a0000-aaaa-7bbb-8ccc-" + String(Date.now()).slice(-12).padStart(12, "0");
  const af = CL.codexActiveFileFor(XSID);
  fs.mkdirSync(path.dirname(af), { recursive: true });
  fs.writeFileSync(af, JSON.stringify({ workspace: WS, codexSession: XSID, ts: new Date().toISOString(), constraintAnchor: ANCHOR, constraintSourceHash: sha1(SNAP) }));
  const r = run(Object.assign(baseEnv(), { CODEX_THREAD_ID: XSID }));
  const seen = readSeen();
  assert.ok(seen.length >= 1 && seen.every((s) => s.arm === "codex" && s.resolveCodexIsFn === true), "Codex 팔 페이지 호출 시점 내보내기 " + JSON.stringify(seen) + r.stderr);
  assert.ok(r.status === 0 && !/resolveCodex is not a function|spawn-prep-failed|선별 실패/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  const rec = CL.readSelectorUsage().filter((x) => x.purpose === "preview" && x.arm === "codex").pop();
  assert.ok(rec && rec.turnAnchor === ANCHOR, "Codex 차례 미리보기 영수증 " + JSON.stringify(rec));
});

t("배선 — 내보내기가 main() 호출보다 앞(파일 끝 순서)", () => {
  const src = fs.readFileSync(CLI, "utf8");
  const iExp = src.lastIndexOf("module.exports = {");
  const iMain = src.lastIndexOf("if (require.main === module) main();");
  assert.ok(iExp > 0 && iMain > iExp, "module.exports 가 main() 보다 먼저");
});

console.log(`\n결과: ${n}/${n} 통과`);
