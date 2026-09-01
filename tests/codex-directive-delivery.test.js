"use strict";
/*
 * [HARNESS-REALIGNMENT §7 4-2a · §4-B Codex 구현자 쪽 규약 1회 전달 — 2026-09-01] 격리 CODEX_BRIDGE_HOME.
 * 계약: 구현 Codex 세션의 정적 지시(검증 규칙·원격·전달 원칙·재판단 규약·수칙 인지 ab·설계 경위)는 세션 1회(첫 턴·세션 시작 훅·세대 변경·rollout 압축 감지·
 * 기록 판독 불가에만 전문), 매 턴=명령 줄+진행도+상태 줄. 기록=codex-active/<sid>.json.directive(출력 뒤)·도구 이벤트가 지우지 않음·검증 off=무전달.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cdd-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CHOOK = path.join(__dirname, "..", "bridge", "codex-hook.js");
const ws = path.join(HOME, "proj"); fs.mkdirSync(ws, { recursive: true });
const SID = "019f0000-2222-7222-8333-944455566677";
const rollout = path.join(HOME, "rollout-cx.jsonl");
const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }); delete env.CLAUDE_PROJECT_DIR;
const writeRollout = () => fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", timestamp: new Date(Date.now() - 60000).toISOString(), payload: { id: SID, source: "vscode", thread_source: "user" } }) + "\n", "utf8");
const run = (ev, extra) => {
  const r = cp.spawnSync(process.execPath, [CHOOK], { input: JSON.stringify(Object.assign({ hook_event_name: ev, session_id: SID, cwd: ws, transcript_path: rollout }, extra || {})), encoding: "utf8", timeout: 30000, env, windowsHide: true });
  let out = null; try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { r, out, ctx: (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || "" };
};
const anchor = () => CL.readCodexActive(SID);
const STATIC_MARK = "[재판단 규약 — 이 세션에 1회 전달";
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

t("성분·계획 — 성분 7종 지문 결정론 · first/delivered/gen-changed/reset/compacted/rollout-unreadable · 상태 줄 라벨(ko/en)", () => {
  assert.ok(CL.patchContractFields(ws, "ko", { harnessMode: "codex-codex", codexVerifyMode: "always", verifyMode: "always", verifyProfile: "core", verifyBudget: 5 }));
  const c = CL.loadContract(ws, "ko");
  const sp = CL.codexStaticParts(ws, c, "ko", { provenance: "" });
  assert.deepStrictEqual(Object.keys(sp), CL.CLAUDE_STATIC_KEYS, "same component keys as the Claude side");
  assert.ok(sp.verifyStatic.length > 100 && sp.rejudge.length > 50 && sp.mode === "always" && sp.profile === "core");
  const p1 = CL.codexDeliveryPlan(null, null, sp, "");
  assert.ok(p1.mode === "full" && p1.reason === "first");
  const rec = { gen: p1.gen, parts: p1.parts, sentAt: new Date().toISOString() };
  assert.ok(CL.codexDeliveryPlan(rec, null, sp, "").mode === "slim");
  assert.ok(CL.codexDeliveryPlan(rec, { source: "startup" }, sp, "").reason === "reset");
  assert.ok(CL.codexDeliveryPlan(rec, null, Object.assign({}, sp, { rejudge: sp.rejudge + " x" }), "").reason === "gen-changed");
  const rf = path.join(HOME, "r1.jsonl");
  fs.writeFileSync(rf, JSON.stringify({ type: "compacted", timestamp: new Date(Date.now() - 3600000).toISOString() }) + "\n");
  assert.ok(CL.codexDeliveryPlan(rec, null, sp, rf).mode === "slim", "compaction before the delivery does not count");
  fs.appendFileSync(rf, JSON.stringify({ type: "compacted", timestamp: new Date(Date.now() + 5000).toISOString() }) + "\n");
  const pc = CL.codexDeliveryPlan(rec, null, sp, rf);
  assert.ok(pc.mode === "full" && pc.reason === "compacted" && pc.compactedAt, JSON.stringify(pc));
  assert.ok(CL.codexDeliveryPlan(rec, null, sp, path.join(HOME, "nope.jsonl")).reason === "rollout-unreadable");
  const s1 = CL.codexDeliveryStatusLine(p1, "ko", "T");
  assert.ok(s1.startsWith("[규약 전달 · Codex 구현자] 세대 ") && s1.includes("이 세션 첫 턴"), s1);
  assert.ok(CL.codexDeliveryStatusLine(pc, "en", "T").includes("[directive delivery · Codex implementer]") && CL.codexDeliveryStatusLine(pc, "en", "T").includes("compacted after the last delivery"));
  assert.ok(CL.codexDeliveryStatusLine(Object.assign({}, p1, { reason: "session-start" }), "ko", "T").includes("세션 시작 훅"));
  assert.ok(CL.codexDeliveryStatusLine(CL.codexDeliveryPlan(rec, null, sp, ""), "ko", "T0").includes("재전송 없음") && CL.codexDeliveryStatusLine(CL.codexDeliveryPlan(rec, null, sp, ""), "ko", "T0").includes("T0"));
});

t("리셋 — 앵커 없음=no-anchor(아무것도 안 씀) · 앵커 있음=directive null+directiveReset · 마커 판독·소거", () => {
  assert.deepStrictEqual(CL.resetCodexDirectiveDelivery("no-such-cx", "startup"), { ok: true, via: "no-anchor" });
  assert.ok(CL.writeCodexActive("cx-reset-1", ws, { directive: { gen: "g", parts: {}, sentAt: "T" } }));
  assert.deepStrictEqual(CL.resetCodexDirectiveDelivery("cx-reset-1", "resume"), { ok: true, via: "anchor" });
  const a = CL.readCodexActive("cx-reset-1");
  assert.ok(a.directive === null && a.directiveReset && a.directiveReset.source === "resume");
  assert.ok(CL.readCodexDirectiveReset("cx-reset-1", a).source === "resume");
  fs.writeFileSync(CL.codexDirectiveResetMarkerFor("cx-reset-2"), JSON.stringify({ schema: "codex-directive-reset-v1", session: "cx-reset-2", source: "compact", ts: "T" }));
  assert.ok(CL.readCodexDirectiveReset("cx-reset-2", null).marker === true);
  CL.clearCodexDirectiveResetMarker("cx-reset-2");
  assert.strictEqual(CL.readCodexDirectiveReset("cx-reset-2", null), null);
});

t("실행 — 첫 프롬프트=정적 전문+상태 줄(첫 턴)·출력 뒤 기록 · 둘째=재전송 없음(정적 없음) · 도구 이벤트가 기록을 지우지 않음", () => {
  writeRollout();
  const r1 = run("UserPromptSubmit", { turn_id: "t-1", prompt: "구현 시작" });
  assert.ok(r1.ctx.includes(STATIC_MARK) && r1.ctx.includes("[규약 전달 · Codex 구현자] 세대 ") && r1.ctx.includes("이 세션 첫 턴"), (r1.ctx || r1.r.stderr).slice(0, 600));
  const a1 = anchor();
  assert.ok(a1 && a1.directive && a1.directive.gen && a1.directive.reason === "first" && a1.directive.sentAt, JSON.stringify(a1));
  const r2 = run("UserPromptSubmit", { turn_id: "t-2", prompt: "계속" });
  assert.ok(!r2.ctx.includes(STATIC_MARK) && r2.ctx.includes("재전송 없음") && r2.ctx.includes(a1.directive.sentAt), r2.ctx.slice(0, 600));
  assert.ok(r2.ctx.includes("[검증 모드") || r2.ctx.includes("ask-start"), "slim command line still present every turn");
  run("PostToolUse", { turn_id: "t-2", tool_name: "shell", tool_input: {} });
  const a2 = anchor();
  assert.ok(a2 && a2.directive && a2.directive.gen === a1.directive.gen, "tool heartbeat keeps the delivery record");
});

t("실행 — rollout에 압축 레코드가 마지막 전달 뒤에 생기면 다음 프롬프트는 전문(사유: 압축) · 세션 시작 훅=전문(사유: 세션 시작)+기록 갱신 · 그 다음은 다시 슬림", () => {
  fs.appendFileSync(rollout, JSON.stringify({ type: "compacted", timestamp: new Date(Date.now() + 2000).toISOString() }) + "\n");
  const r3 = run("UserPromptSubmit", { turn_id: "t-3", prompt: "압축 뒤" });
  assert.ok(r3.ctx.includes(STATIC_MARK) && r3.ctx.includes("기억 압축 감지"), r3.ctx.slice(0, 400));
  const a3 = anchor(); assert.strictEqual(a3.directive.reason, "compacted");
  writeRollout(); // 새 rollout(압축 레코드 없음) — 이후 판은 슬림이어야 함
  const s = run("SessionStart", {});
  assert.ok(s.ctx.includes(STATIC_MARK) && s.ctx.includes("세션 시작 훅"), s.ctx.slice(0, 400));
  const a4 = anchor(); assert.ok(a4.directive.reason === "session-start" && Date.parse(a4.directive.sentAt) >= Date.parse(a3.directive.sentAt));
  const r4 = run("UserPromptSubmit", { turn_id: "t-4", prompt: "다음" });
  assert.ok(!r4.ctx.includes(STATIC_MARK) && r4.ctx.includes("재전송 없음"), r4.ctx.slice(0, 300));
});

t("실행 — 규약 세대가 바뀌면(프로필 변경) 전문(사유: 규약 변경) · 검증 off면 전달 없음(상태 줄·기록 갱신 없음)", () => {
  assert.ok(CL.patchContractFields(ws, "ko", { codexVerifyProfile: "integrity" }));
  const r5 = run("UserPromptSubmit", { turn_id: "t-5", prompt: "프로필 변경 뒤" });
  assert.ok(r5.ctx.includes(STATIC_MARK) && r5.ctx.includes("규약 변경"), r5.ctx.slice(0, 400));
  const before = anchor().directive;
  assert.ok(CL.patchContractFields(ws, "ko", { codexVerifyMode: "off" }));
  const r6 = run("UserPromptSubmit", { turn_id: "t-6", prompt: "검증 끔" });
  assert.ok(!r6.ctx.includes("[규약 전달"), r6.ctx.slice(0, 300));
  assert.deepStrictEqual(anchor().directive, before, "no record change when verification is off");
  const hook = fs.readFileSync(CHOOK, "utf8");
  assert.ok(hook.includes('contextThen("UserPromptSubmit", preface ? preface + body : body, () => recordCodexDirective(sid, ws, ic9.record))') && hook.includes('contextThen("SessionStart", ic0.text, () => recordCodexDirective(sid, ws, ic0.record))'), "record after output");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
