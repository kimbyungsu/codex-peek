"use strict";
/*
 * [HARNESS-REALIGNMENT §7 4-2a · P7 앵커 이탈 3종 — 2026-09-01] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * ⓐ 훅 스크립트는 진짜 훅 입력(stdin에 이벤트 이름·세션 id)이 있을 때만 앵커를 쓴다 — require 로드·빈/부분 입력=아무것도 쓰지 않음(2026-08-28 실사고 재현).
 * ⓑ 세션 도중 앵커의 폴더가 바뀌면 기록(folderChange)+구현자 고지, ask-start는 시작하지 않음(--folder-changed-ok 로만·그때 해제).
 * ⓒ 프로필·상한 설정이 없는 폴더=기본값 고지 1줄(요청 머리·판정 꼬리 — 소스 계약 핀).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ag-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const INJECT = path.join(__dirname, "..", "bridge", "contract-inject.js");
const SSTART = path.join(__dirname, "..", "bridge", "session-start.js");
const BRIDGE = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const A = path.join(HOME, "projA"), B = path.join(HOME, "projB");
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true });
const SID = "anchor-sess-1";
const envBase = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME });
delete envBase.CLAUDE_PROJECT_DIR; delete envBase.CLAUDE_CODE_SESSION_ID;
const anchorFile = path.join(HOME, "active", SID + ".json");
const readAnchor = () => { try { return JSON.parse(fs.readFileSync(anchorFile, "utf8")); } catch { return null; } };
const runInject = (input, cwd, env) => cp.spawnSync(process.execPath, [INJECT], { input: typeof input === "string" ? input : JSON.stringify(input), cwd, encoding: "utf8", timeout: 30000, env: Object.assign({}, envBase, env || {}), windowsHide: true });
const ctxOf = (r) => { try { const o = JSON.parse(r.stdout); return (o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || ""; } catch { return ""; } };
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

t("ⓐ 훅 스크립트를 require로 불러오기만 하면(로드 시험 — 2026-08-28 실사고) 앵커를 쓰지 않는다 — 환경변수에 세션 id가 살아 있어도", () => {
  const r = cp.spawnSync(process.execPath, ["-e", `require(${JSON.stringify(INJECT)}); require(${JSON.stringify(SSTART)}); console.log("loaded")`], { cwd: B, input: "", encoding: "utf8", timeout: 30000, env: Object.assign({}, envBase, { CLAUDE_CODE_SESSION_ID: SID }), windowsHide: true });
  assert.ok(/loaded/.test(r.stdout), r.stderr);
  assert.ok(!fs.existsSync(anchorFile) && !fs.existsSync(path.join(HOME, "active.json")), "no anchor written on require-load");
  assert.ok(!fs.existsSync(path.join(HOME, "active", SID + ".directive-reset.json")), "no reset marker on require-load");
});

t("ⓐ 빈/부분 stdin(세션 id 없음·이벤트 이름 없음)은 무동작 종료 — 앵커·주입 모두 없음", () => {
  for (const input of ["", "{}", "null", { session_id: SID, cwd: A, prompt: "x" }, { hook_event_name: "UserPromptSubmit", cwd: A, prompt: "x" }]) {
    const r = runInject(input, A, { CLAUDE_CODE_SESSION_ID: SID });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(String(r.stdout || "").trim(), "", "no injection for non-hook input: " + JSON.stringify(input));
    assert.ok(!fs.existsSync(anchorFile), "no anchor for non-hook input: " + JSON.stringify(input));
  }
  const s = cp.spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ source: "compact" }), encoding: "utf8", timeout: 30000, env: Object.assign({}, envBase, { CLAUDE_CODE_SESSION_ID: SID }), windowsHide: true });
  assert.strictEqual(s.status, 0, "session-start without stdin session id = no-op (no env fallback)");
  // [1회차 blocker] session_id만 있고 이벤트 이름이 없는 부분 입력도 리셋하지 않는다(앵커의 전달 기록 보존)
  const SID2 = "anchor-sess-2"; const f2 = path.join(HOME, "active", SID2 + ".json");
  fs.mkdirSync(path.dirname(f2), { recursive: true });
  fs.writeFileSync(f2, JSON.stringify({ workspace: A, claudeSession: SID2, ts: new Date().toISOString(), directive: { gen: "g1", parts: {}, sentAt: "T" } }));
  const s2 = cp.spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ session_id: SID2, source: "compact" }), encoding: "utf8", timeout: 30000, env: envBase, windowsHide: true });
  assert.strictEqual(s2.status, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(f2, "utf8")).directive.gen, "g1", "partial input (no hook_event_name) must not reset the delivery record");
  assert.ok(!fs.existsSync(path.join(HOME, "active", SID2 + ".directive-reset.json")));
  const s3 = cp.spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SID2, source: "compact" }), encoding: "utf8", timeout: 30000, env: envBase, windowsHide: true });
  assert.strictEqual(s3.status, 0);
  const a3 = JSON.parse(fs.readFileSync(f2, "utf8"));
  assert.ok(a3.directive === null && a3.directiveReset && a3.directiveReset.source === "compact", "real SessionStart input resets");
});

t("ⓐ 진짜 훅 입력(이벤트 이름+세션 id)만 앵커를 쓴다 — 폴더 A 기록·변경 기록 없음", () => {
  const r = runInject({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: A, prompt: "첫 프롬프트", permission_mode: "default" }, A);
  assert.strictEqual(r.status, 0, r.stderr);
  const a = readAnchor();
  assert.ok(a && a.claudeSession === SID && CL.normWs(a.workspace) === CL.normWs(A) && !a.folderChange, JSON.stringify(a));
});

t("ⓑ 같은 세션의 다음 턴이 다른 폴더(B)에서 오면 앵커에 folderChange{A→B}가 남고 구현자에게 [앵커] 고지 1줄 — 다음 턴에도 승계", () => {
  const r = runInject({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: B, prompt: "두 번째", permission_mode: "default" }, B);
  const a = readAnchor();
  assert.ok(a && CL.normWs(a.workspace) === CL.normWs(B) && a.folderChange && CL.normWs(a.folderChange.from) === CL.normWs(A) && CL.normWs(a.folderChange.to) === CL.normWs(B), JSON.stringify(a));
  const ctx = ctxOf(r);
  assert.ok(ctx.includes("[앵커]") && ctx.includes("--folder-changed-ok"), ctx.slice(0, 300));
  runInject({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: B, prompt: "세 번째", permission_mode: "default" }, B);
  const a2 = readAnchor();
  assert.ok(a2.folderChange && CL.normWs(a2.folderChange.from) === CL.normWs(A), "record carried until acknowledged");
  assert.ok(CL.claudeAnchorFolderChange(SID) && CL.normWs(CL.claudeAnchorFolderChange(SID).to) === CL.normWs(B));
});

t("ⓑ ask-start는 folderChange가 있으면 시작하지 않는다(두 폴더 명시·종료코드 3·작업 파일 0) — 플래그로 해제하면 기록이 지워진다", () => {
  const r = cp.spawnSync(process.execPath, [BRIDGE, "ask-start", "--allow-new", "목표: 시험 / 인수조건: 없음 / 직접 범위: 없음 / 제외 범위: 없음"], { cwd: B, encoding: "utf8", timeout: 60000, env: Object.assign({}, envBase, { CLAUDE_CODE_SESSION_ID: SID }), windowsHide: true });
  assert.strictEqual(r.status, 3, "refused: " + r.stderr.slice(-400));
  assert.ok(r.stderr.includes("폴더가 세션 도중 바뀌었습니다") && r.stderr.includes("--folder-changed-ok") && r.stderr.includes(path.basename(A)) && r.stderr.includes(path.basename(B)), r.stderr.slice(-500));
  let jobs = []; try { jobs = fs.readdirSync(path.join(HOME, "ask-jobs")); } catch { jobs = []; }
  assert.strictEqual(jobs.length, 0, "no job created");
  const cl = CL.clearClaudeFolderChange(SID);
  assert.ok(cl.ok && !readAnchor().folderChange && CL.claudeAnchorFolderChange(SID) === null);
  assert.deepStrictEqual(CL.clearClaudeFolderChange("no-such-session"), { ok: false, reason: "anchor-unreadable" });
  const src = fs.readFileSync(BRIDGE, "utf8");
  assert.ok(src.includes('"--folder-changed-ok"]') && src.includes("const fc0 = claudeAnchorFolderChange();") && src.includes('if (!rest.includes("--folder-changed-ok")) die(folderChangeRefusal(fc0, lang0), 3);') && src.includes("const cl0 = clearClaudeFolderChange();"), "ask-start wiring");
});

t("ⓒ 설정 없는 폴더=기본값 고지(프로필·상한 각각) · 명시 상한 0(무제한)은 설정 있음 · 둘 다 있으면 고지 없음 · 요청 머리+판정 꼬리 배선(소스 계약)", () => {
  const C = path.join(HOME, "projC"); fs.mkdirSync(C, { recursive: true });
  const n0 = CL.contractDefaultsNotice(C, "ko", CL.loadContract(C, "ko"));
  assert.ok(n0.startsWith("[기본값 고지]") && n0.includes("검증 프로필·왕복 상한") && n0.includes("무결성(감사) 프로필·상한 없음") && n0.includes(path.basename(C)) && !n0.includes(HOME), n0);
  // [1회차 blocker] 절대 경로 전체를 싣지 않고(끝 2단), 상태 줄과 합쳐 HEAD_BUDGET.statusLine(400) 안 — 영문 최장 상태 줄(규약 변경·성분 전부)로 실측
  const longWs = "C:\\Users\\someone\\Documents\\Projects\\a-very-long-project-folder-name-for-budget-checks\\sample-project";
  const nEn = CL.contractDefaultsNotice(longWs, "en", CL.loadContract(longWs, "en"));
  assert.ok(nEn.includes("sample-project") && !nEn.includes("Documents") && nEn.length <= 200, nEn.length + " " + nEn);
  assert.ok(CL.contractDefaultsNotice(longWs, "ko", CL.loadContract(longWs, "ko")).length <= 200);
  const parts9 = { baseline: "b", qual: "q", v2fixed: "v", contract: "c", profile: "core", lang: "en" };
  const g9 = CL.directiveGenOf(parts9);
  const worst = CL.deliveryStatusLine({ mode: "full", reason: "gen-changed", gen: g9.gen, parts: g9.parts, changed: Object.keys(g9.parts), prev: { sentAt: "2026-09-01T00:00:00.000Z" }, compactedAt: null }, "en");
  assert.ok(worst.length <= CL.HEAD_BUDGET.statusLine, "status line alone within budget: " + worst.length);
  const fitted = CL.fitDefaultsNotice(worst, nEn);
  assert.ok(worst.length + 2 + fitted.length <= CL.HEAD_BUDGET.statusLine && fitted.length > 0, `combined ${worst.length}+2+${fitted.length} > ${CL.HEAD_BUDGET.statusLine}`);
  assert.strictEqual(CL.fitDefaultsNotice("x".repeat(CL.HEAD_BUDGET.statusLine), nEn), "", "no room → notice omitted, status line untouched");
  assert.ok(CL.fitDefaultsNotice("x".repeat(CL.HEAD_BUDGET.statusLine - 60), nEn).endsWith("…"), "partial room → clipped with ellipsis");
  // [2회차 보완] 분기점 고정: 남은 자리 24자=절단(24자·말줄임표·합계 정확히 400) / 23자=생략
  const at = (room) => CL.fitDefaultsNotice("x".repeat(CL.HEAD_BUDGET.statusLine - 2 - room), nEn);
  assert.ok(at(24).length === 24 && at(24).endsWith("…") && (CL.HEAD_BUDGET.statusLine - 2 - 24) + 2 + at(24).length === CL.HEAD_BUDGET.statusLine, "room 24 → clipped to exactly 24 with ellipsis");
  assert.strictEqual(at(23), "", "room 23 → omitted");
  assert.ok(CL.contractDefaultsNotice(C, "en", CL.loadContract(C, "en")).startsWith("[defaults notice]"));
  assert.ok(CL.patchContractFields(C, "ko", { verifyProfile: "integrity" }));
  const n1 = CL.contractDefaultsNotice(C, "ko", CL.loadContract(C, "ko"));
  assert.ok(n1.includes("왕복 상한 설정 없음") && !n1.includes("검증 프로필"), n1);
  assert.ok(CL.patchContractFields(C, "ko", { verifyBudget: 0 }));
  assert.strictEqual(CL.contractDefaultsNotice(C, "ko", CL.loadContract(C, "ko")), "", "explicit unlimited cap = configured");
  const D = path.join(HOME, "projD"); fs.mkdirSync(D, { recursive: true });
  assert.ok(CL.patchContractFields(D, "ko", { harnessMode: "codex-codex", codexVerifyBudget: 3 }));
  const n2 = CL.contractDefaultsNotice(D, "ko", CL.loadContract(D, "ko"));
  assert.ok(n2.includes("검증 프로필 설정 없음") && !n2.includes("왕복 상한"), n2);
  assert.ok(CL.patchContractFields(D, "ko", { codexVerifyProfile: "core" }));
  assert.strictEqual(CL.contractDefaultsNotice(D, "ko", CL.loadContract(D, "ko")), "");
  const src = fs.readFileSync(BRIDGE, "utf8");
  assert.ok(src.includes("const defaultsNotice = fitDefaultsNotice(statusLine, contractDefaultsNotice(ws || configWs(), lang || loadLang(), c));") && src.includes("[statusLine, defaultsNotice, envData, v2Data, scout]") && src.includes("[statusLine, defaultsNotice, baseline, baseQual, envText, inj, scout]") && src.includes('attCarrier.defaultsNotice ? "\\n" + attCarrier.defaultsNotice : ""'), "head+tail wiring (independent line, status line untouched)");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
