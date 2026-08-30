"use strict";
/*
 * [개선 2 · 판단 관문 — 장치화 2026-08-30] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 전량 강등 보류 판정 → 마커 장전(촉구 문장 아님) → 종료 훅(verify-guard·codex-hook)이 판단 기록 전 턴 종료 차단 →
 * round-judge(close-oos|re-verify|escalate)로 해제 — escalate는 결정 장부 실존 항목 필수(사용자 판단 필요=스크립트 출력 강제).
 * finding-judge escalate도 --decision 실존 항목 필수. 판단 자체는 구현자 몫(하네스는 기록됐는가만 본다).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const BRIDGE = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const GUARD = path.join(__dirname, "..", "bridge", "verify-guard.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-ws-"));
const runCli = (ws, args) => cp.spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws }), cwd: ws });
const decisionSpec = (q) => ({ origin: "implementer", kind: "boundary", campaignId: "cl:s:c1", sourceAsk: "ask-j1", targetFp: "", question: q, why: "w", noDefault: "범위표는 사용자가 정하는 영역이라 대신 정할 수 없음", choices: [{ key: "a", label: "A" }, { key: "b", label: "B" }] });

t("마커 — 장전·멱등·판독", () => {
  assert.strictEqual(CL.judgeRequiredPending(WS).length, 0);
  assert.strictEqual(CL.addJudgeRequired(WS, { askId: "ask-j1", campaignId: "cl:s:c1", reason: "scope-demoted" }), true);
  assert.strictEqual(CL.addJudgeRequired(WS, { askId: "ask-j1", campaignId: "cl:s:c1", reason: "scope-demoted" }), true);
  assert.strictEqual(CL.addJudgeRequired(WS, { askId: "", campaignId: "x" }), false);
  const p = CL.judgeRequiredPending(WS);
  assert.strictEqual(p.length, 1); assert.strictEqual(p[0].askId, "ask-j1"); assert.strictEqual(p[0].reason, "scope-demoted");
});

t("해제 거부 — 미지 선택·대기 아님·근거 없음·escalate에 결정 항목 없음(장부 행 0·마커 유지)", () => {
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j1", "whatever", { note: "근거는 충분히 길게 적는다" }).reason, "unknown-choice");
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-none", "close-oos", { note: "근거는 충분히 길게 적는다" }).reason, "not-pending");
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j1", "close-oos", { note: "짧음" }).reason, "note-required");
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j1", "escalate", { note: "근거는 충분히 길게 적는다" }).reason, "decision-required");
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j1", "escalate", { note: "근거는 충분히 길게 적는다", decisionId: "0000000000000000" }).reason, "decision-required");
  assert.strictEqual(CL.judgeRequiredPending(WS).length, 1);
  assert.strictEqual(CL.readFindingsLedger(WS).filter((r) => r.type === "round-judgment").length, 0);
});

t("해제 — escalate는 결정 장부 실존 항목이 있어야 기록(장부 행+마커 제거)", () => {
  const d = CL.openDecision(WS, decisionSpec("범위표를 바꿀까요?"));
  assert.strictEqual(d.ok, true);
  const r = CL.resolveJudgeRequired(WS, "ask-j1", "escalate", { note: "지적 3건이 전부 범위표 밖 상황 전제 — 범위표 변경은 사용자 영역", decisionId: d.decisionId });
  assert.strictEqual(r.ok, true, r.reason); assert.strictEqual(r.decisionId, d.decisionId);
  assert.strictEqual(CL.judgeRequiredPending(WS).length, 0);
  const rows = CL.readFindingsLedger(WS).filter((x) => x.type === "round-judgment");
  assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].askId, "ask-j1"); assert.strictEqual(rows[0].choice, "escalate"); assert.strictEqual(rows[0].decisionId, d.decisionId); assert.strictEqual(rows[0].campaignId, "cl:s:c1");
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j1", "close-oos", { note: "근거는 충분히 길게 적는다" }).reason, "not-pending");
});

t("해제 — close-oos / re-verify 는 결정 항목 없이 근거만으로 기록·두 항목 중 하나만 제거", () => {
  CL.addJudgeRequired(WS, { askId: "ask-j2", campaignId: "cl:s:c1", reason: "scope-demoted" });
  CL.addJudgeRequired(WS, { askId: "ask-j3", campaignId: "cl:s:c1", reason: "scope-demoted" });
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j2", "close-oos", { note: "지적이 전부 승인 범위 밖 — 보관함으로 이관" }).ok, true);
  assert.deepStrictEqual(CL.judgeRequiredPending(WS).map((x) => x.askId), ["ask-j3"]);
  assert.strictEqual(CL.resolveJudgeRequired(WS, "ask-j3", "re-verify", { note: "동봉 자료가 부족했으니 다시 검증받는다" }).ok, true);
  assert.strictEqual(CL.judgeRequiredPending(WS).length, 0);
});

t("복구 멱등 — 판단 행이 남고 마커 제거 전 종료된 상태의 재실행: 같은 선택=행 추가 없이 마커 정리 / 다른 선택=already-judged 거부", () => {
  CL.addJudgeRequired(WS, { askId: "ask-j4", campaignId: "cl:s:c1", reason: "scope-demoted" });
  // 강제 종료 재현: 판단 행만 먼저 적힌 상태(마커는 그대로)
  CL.appendFindingsLedger(WS, [{ type: "round-judgment", campaignId: "cl:s:c1", askId: "ask-j4", choice: "close-oos", note: "승인 범위 밖 지적 — 보관함", decisionId: "", reason: "scope-demoted", ts: "t" }]);
  const before = CL.readFindingsLedger(WS).filter((r) => r.type === "round-judgment" && r.askId === "ask-j4").length;
  assert.strictEqual(before, 1);
  const conflict = CL.resolveJudgeRequired(WS, "ask-j4", "re-verify", { note: "다른 판단으로 바꾸려는 재실행" });
  assert.strictEqual(conflict.reason, "already-judged"); assert.strictEqual(conflict.choice, "close-oos");
  assert.strictEqual(CL.judgeRequiredPending(WS).map((x) => x.askId).includes("ask-j4"), true, "conflicting rerun must not clear the marker");
  const same = CL.resolveJudgeRequired(WS, "ask-j4", "close-oos", { note: "같은 판단으로 재실행(복구)" });
  assert.strictEqual(same.ok, true, same.reason);
  assert.strictEqual(CL.readFindingsLedger(WS).filter((r) => r.type === "round-judgment" && r.askId === "ask-j4").length, 1, "no duplicate row");
  assert.strictEqual(CL.judgeRequiredPending(WS).map((x) => x.askId).includes("ask-j4"), false);
});

t("실경로 — machineFindingsLayer 전량 강등 보류 → 마커 장전(askId 결속)·판정 '보류'·사용자 결정 0", () => {
  const NLc = String.fromCharCode(10);
  const repoE = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-repo-"));
  fs.writeFileSync(path.join(repoE, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["s1"], alwaysBlocker: ["a1", "a2"], outOfScope: ["o1", "o2"] }));
  const shaE = CL.readVerifyEnvelope(repoE).sha1;
  const wsE = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-wse-"));
  CL.updateContractPatch(wsE, "ko", { envelopeHash: shaE, scoutRepo: repoE }, { tries: 3 });
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e9"; CL.writeEnvelopeFreeze(wsE, shaE, "ask-e9");
  const r = CB.machineFindingsLayer(["본문", "[지적 목록 v2]", JSON.stringify({ tag: "blocker", title: "범위 밖 경합", origin: "baseline", supported: false, oosId: "oos-2" }), "[지적 목록 끝]", "", "검증: 실패"].join(NLc), wsE, "ko", "core", "claude-codex", "ask-e9");
  assert.strictEqual(r.machine.effective, "inconclusive");
  assert.ok(r.notice.includes("[판단 관문 걸림]") && r.notice.includes("round-judge ask-e9"), r.notice);
  assert.deepStrictEqual(CL.judgeRequiredPending(wsE).map((x) => x.askId), ["ask-e9"]);
  assert.strictEqual(CL.readDecisions(wsE).rows.length, 0);
  // 마커 기록 실패 경로: 마커 파일 자리에 디렉터리 → '미장전' 고지(판정 전달은 계속)
  const wsF = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-wsf-"));
  fs.mkdirSync(path.dirname(CL.judgeFileFor(wsF)), { recursive: true }); fs.mkdirSync(CL.judgeFileFor(wsF));
  assert.ok(CB.armScopeDemotedJudge(wsF, "cl:s:c9", "ask-f1", false).startsWith("[판단 관문 미장전]"));
  assert.ok(CB.armScopeDemotedJudge(wsE, "cl:s:c9", "", true).includes("no askId"));
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
});

t("CLI round-judge — 목록·거부(exit 2/3)·해제 기록", () => {
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-ws4-"));
  CL.addJudgeRequired(WS4, { askId: "ask-c1", campaignId: "cl:s:c4", reason: "scope-demoted" });
  const l = runCli(WS4, ["round-judge"]);
  assert.strictEqual(l.status, 0, l.stderr); assert.ok(l.stdout.includes("ask-c1") && l.stdout.includes("scope-demoted"), l.stdout);
  assert.strictEqual(runCli(WS4, ["round-judge", "ask-c1", "nope", "--note", "근거는 충분히 길게 적는다"]).status, 2);
  assert.strictEqual(runCli(WS4, ["round-judge", "ask-c1", "escalate", "--note", "근거는 충분히 길게 적는다"]).status, 3);
  assert.strictEqual(runCli(WS4, ["round-judge", "ask-c1", "close-oos", "--note", "짧음"]).status, 3);
  assert.strictEqual(CL.judgeRequiredPending(WS4).length, 1);
  const d = CL.openDecision(WS4, decisionSpec("방향 질문"));
  const ok = runCli(WS4, ["round-judge", "ask-c1", "escalate", "--note", "범위표 변경이 필요해 사용자에게 올림", "--decision", d.decisionId]);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.strictEqual(CL.judgeRequiredPending(WS4).length, 0);
  const e = runCli(WS4, ["round-judge"]);
  assert.ok(e.stdout.includes("판단 대기 없음") || e.stdout.includes("No judgment pending"), e.stdout);
});

t("finding-judge escalate — --decision 실존 항목 없이는 기록 불가(exit≠0)·있으면 처분 행에 decisionId 결속", () => {
  const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-ws5-"));
  const C = "cl:s:c5";
  CL.appendFindingsLedger(WS5, [{ type: "finding", findingId: "f-esc00001", campaignId: C, round: 1, tag: "blocker", titleNorm: "범위표 자체 문제", envelopeHash: null, status: "open", ts: "t" }]);
  assert.strictEqual(CL.openFindingsFor(WS5, C).length, 1);
  const bad = runCli(WS5, ["finding-judge", "f-esc00001", "escalate", "--note", "사용자가 범위를 정해야 한다", "--campaign", C]);
  assert.notStrictEqual(bad.status, 0, bad.stdout);
  assert.strictEqual(CL.dispositionsFor(WS5, C).size, 0);
  const d = CL.openDecision(WS5, decisionSpec("범위표 변경?"));
  const ok = runCli(WS5, ["finding-judge", "f-esc00001", "escalate", "--note", "사용자가 범위를 정해야 한다", "--campaign", C, "--decision", d.decisionId]);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  const disp = CL.dispositionsFor(WS5, C).get("f-esc00001");
  assert.ok(disp && disp.choice === "escalate" && disp.decisionId === d.decisionId, JSON.stringify(disp));
  assert.strictEqual(CL.undisposedOpenFindings(WS5, C, null).length, 0, "escalate is a valid judgment for the gate");
});

// ── 종료 훅(Claude) 실행: 마커가 있으면 검증 불필요 턴도 차단, 해제 후 통과 ──
function normWs(p) { return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC"); }
function guardSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-guard-"));
  const bridgeDir = path.join(dir, ".codex-bridge"); const ws = path.join(dir, "ws");
  fs.mkdirSync(bridgeDir, { recursive: true }); fs.mkdirSync(ws, { recursive: true });
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  fs.mkdirSync(path.join(bridgeDir, "contracts"), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "contracts", key + ".json"), JSON.stringify({ verifyMode: "code" })); // 변경 없는 턴=검증 불필요
  const sb = { dir, bridgeDir, ws, session: "sess-rjudge", transcriptPath: path.join(dir, "tx.jsonl") };
  fs.writeFileSync(sb.transcriptPath, JSON.stringify({ type: "user", sessionId: sb.session, timestamp: "2026-08-30T10:00:00.000Z", message: { content: [{ type: "text", text: "해줘" }] } }));
  return sb;
}
function runGuard(sb) {
  const stdin = { transcript_path: sb.transcriptPath, cwd: sb.ws, session_id: sb.session, stop_hook_active: false };
  return cp.spawnSync(process.execPath, [GUARD], { input: JSON.stringify(stdin), encoding: "utf8", timeout: 30000, env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir, CLAUDE_CODE_SESSION_ID: sb.session, CLAUDE_PROJECT_DIR: sb.ws }) });
}
const blocked = (r) => { try { return JSON.parse((r.stdout || "").trim()).decision === "block"; } catch { return false; } };

t("종료 훅(Claude verify-guard) — 판단 마커가 있으면 검증 불필요 턴도 차단(명령 안내), 판단 기록 후 통과", () => {
  const sb = guardSandbox();
  const r0 = runGuard(sb);
  assert.strictEqual(r0.status, 0, r0.stderr); assert.strictEqual(blocked(r0), false, "baseline must pass: " + r0.stdout);
  // 마커를 이 샌드박스 HOME에 장전(격리 HOME에서 contract-lib 재로드)
  const armed = cp.spawnSync(process.execPath, ["-e", `const CL=require(${JSON.stringify(path.join(__dirname, "..", "bridge", "contract-lib.js"))});process.exit(CL.addJudgeRequired(process.argv[1],{askId:"ask-g1",campaignId:"cl:s:g",reason:"scope-demoted"})?0:9)`, sb.ws], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir }) });
  assert.strictEqual(armed.status, 0, armed.stderr);
  const r1 = runGuard(sb);
  assert.strictEqual(blocked(r1), true, "must block while judgment pending: " + r1.stdout);
  const reason = JSON.parse(r1.stdout.trim()).reason;
  assert.ok(reason.includes("[판단 관문") && reason.includes("round-judge") && reason.includes("ask-g1"), reason);
  const rel = cp.spawnSync(process.execPath, ["-e", `const CL=require(${JSON.stringify(path.join(__dirname, "..", "bridge", "contract-lib.js"))});const r=CL.resolveJudgeRequired(process.argv[1],"ask-g1","close-oos",{note:"승인 범위 밖 지적이라 보관함으로 이관"});process.exit(r.ok?0:9)`, sb.ws], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir }) });
  assert.strictEqual(rel.status, 0, rel.stderr);
  const r2 = runGuard(sb);
  assert.strictEqual(blocked(r2), false, "must pass after judgment: " + r2.stdout);
});

t("종료 훅 카운터 — 차단이 누적된 상태에서 판단 마커가 새로 걸리면 진행 epoch가 바뀌어 카운터가 리셋된다(영구 정지 방지·상한 탈출 유지)", () => {
  const sb = guardSandbox();
  const key = crypto.createHash("sha1").update(normWs(sb.ws)).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(sb.bridgeDir, "contracts", key + ".json"), JSON.stringify({ verifyMode: "always" })); // 증명 없음=매번 차단
  const attempts = path.join(sb.bridgeDir, "verify-attempts", sb.session + ".json");
  const r1 = runGuard(sb); assert.strictEqual(blocked(r1), true, r1.stdout);
  const r2 = runGuard(sb); assert.strictEqual(blocked(r2), true, r2.stdout);
  const a2 = JSON.parse(fs.readFileSync(attempts, "utf8"));
  assert.strictEqual(a2.count, 2, "two blocks in the same state accumulate");
  const armed = cp.spawnSync(process.execPath, ["-e", `const CL=require(${JSON.stringify(path.join(__dirname, "..", "bridge", "contract-lib.js"))});process.exit(CL.addJudgeRequired(process.argv[1],{askId:"ask-g2",campaignId:"cl:s:g",reason:"scope-demoted"})?0:9)`, sb.ws], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir }) });
  assert.strictEqual(armed.status, 0, armed.stderr);
  const r3 = runGuard(sb); assert.strictEqual(blocked(r3), true, r3.stdout);
  const a3 = JSON.parse(fs.readFileSync(attempts, "utf8"));
  assert.strictEqual(a3.count, 1, "new marker = new epoch = counter reset");
  assert.notStrictEqual(a3.progressEpoch, a2.progressEpoch);
  assert.ok(JSON.parse(r3.stdout.trim()).reason.includes("[판단 관문"), "judgment gate reason takes precedence");
  // 같은 상태 반복 → 상한(MAX_ATTEMPTS=3) 뒤 탈출 유지(ab-6)
  const r4 = runGuard(sb); const r5 = runGuard(sb); const r6 = runGuard(sb);
  assert.strictEqual(blocked(r4) && blocked(r5), true);
  assert.strictEqual(blocked(r6), false, "after MAX attempts in the same state the hook releases: " + r6.stdout);
});

t("소스 핀 — Codex 종료 훅(codex-hook)에도 같은 관문·전량 강등 분기는 마커 장전 함수·촉구 문장 함수 없음", () => {
  const hook = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  assert.ok(hook.includes("judgeRequiredPending(ws)") && hook.includes("[판단 관문"), "codex-hook gate missing");
  assert.ok(hook.includes("residualOk&&judgeOk"), "codex-hook pass condition must include judgeOk");
  const guard = fs.readFileSync(GUARD, "utf8");
  assert.ok(guard.includes("judgeRequiredPending(ws)") && guard.includes("residualOk && judgeOk"), "verify-guard pass condition must include judgeOk");
  const src = fs.readFileSync(BRIDGE, "utf8");
  assert.strictEqual((src.match(/out\.push\(armScopeDemotedJudge\(ws, camp, askId, en\)\);/g) || []).length, 1);
  assert.ok(!src.includes("scopeDemotedJudgeNotice"));
  assert.ok(src.includes('case "round-judge":'));
  assert.deepStrictEqual(CL.JUDGE_CHOICES, ["close-oos", "re-verify", "escalate"]);
  assert.ok(CL.FINDING_DISPOSITIONS.includes("escalate"));
});

t("화면 회차=캠페인 장부 서수 — 선별 단계가 진행 파일 round를 0으로 되돌려도 다음 예약은 장부 N을 쓴다(매 판 1/5 오표기 봉합)", () => {
  const WS9 = fs.mkdtempSync(path.join(os.tmpdir(), "rjudge-ws9-"));
  const sid = "sess-round-9";
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID; process.env.CLAUDE_CODE_SESSION_ID = sid;
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, sid + ".json"), JSON.stringify({ workspace: WS9, claudeSession: sid, ts: "2026-08-30T14:00:00.000Z" }));
  const snap = { verifyBudget: 5, codexVerifyBudget: 5, harnessMode: "claude-codex" };
  const g1 = CB.reserveVerifyBudgetGate(WS9, null, snap, "claude-codex", "ko", "core");
  assert.strictEqual(g1.proceed, true); assert.strictEqual(g1.res.n, 1);
  assert.strictEqual(CL.readPhase(WS9).round, 1);
  CL.writePhase("selecting", { workspace: WS9, round: 0, session: null }); // 워커 선별 단계(예약 전) — 0으로 되돌림(현행 유지)
  assert.strictEqual(CL.readPhase(WS9).round, 0);
  const g2 = CB.reserveVerifyBudgetGate(WS9, null, snap, "claude-codex", "ko", "core");
  assert.strictEqual(g2.res.n, 2);
  assert.strictEqual(CL.readPhase(WS9).round, 2, "phase round must equal the ledger ordinal, not prev+1 (which would be 1)");
  CL.writePhase("selecting", { workspace: WS9, round: 0, session: null });
  const g3 = CB.reserveVerifyBudgetGate(WS9, null, snap, "claude-codex", "ko", "core");
  assert.strictEqual(g3.res.n, 3); assert.strictEqual(CL.readPhase(WS9).round, 3);
  const src = fs.readFileSync(BRIDGE, "utf8");
  assert.ok(!src.includes('writePhase("codex-verifying", { round: (readPhase(ws).round || 0) + 1'), "tracked path must not use prev+1 counting");
  assert.ok(src.includes("const roundShown = (res && res.tracked === true"), "ledger ordinal is the single source");
  if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
