"use strict";
/*
 * [RULE-SUPPLY-CORRECTION ⑤ 3단계 — 2026-10-12] 분류 결과 판단 관문(§3-1 6 · D-b).
 *  ① 관문 판정: 이번 차례에 넘겨받고 아직 판단하지 않은 결과만 막음 · 같은 상태 3번 막은 뒤 노랑 경보 1건으로 놓아줌(같은 상태로 다시 막지 않음) ·
 *     판단하면 상태가 바뀌어 다시 셈 · 다 판단하면 관문 없음 · 장부 판독 오류=관문 없음 · 횟수 저장 실패=막지 않음(경보)
 *     [검증 1회차] 횟수 기록 손상·읽기 불가=막지 않음(경보는 같은 상태당 1건) · 장부 판독 오류에도 '놓아줌' 기억 보존 · 경보 문구가 남은 전달 횟수에 맞음
 *  ② Claude 종료 훅 실제 실행 — 다른 조건이 통과한 자리에서만(검증 안내가 먼저) · 안 올림 뒤 통과
 *  ③ Codex 종료 훅 실제 실행 — 같은 규칙 · 판단 뒤 통과
 *  ④ 대시보드 경보 줄·상태 표시줄 이름(근거 의심과 구분)
 * 격리: 임시 CODEX_BRIDGE_HOME. 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cstop-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let seq = 0;
function project(tag) {
  const ws = mk("cs-ws-" + tag + "-"), repo = mk("cs-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo) };
}
function say(P, text, provider) {
  const anc = CL.turnAnchorOf("cs-s", new Date(Date.UTC(2026, 9, 12, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  assert.ok(UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "cs-s", repoKey: P.rk, provider: provider || "claude" }).ok);
}
function fakeRunner(answer) { return ({ prompt }) => ({ promise: Promise.resolve({ ok: true, output: JSON.stringify(typeof answer === "function" ? answer(prompt) : answer) }), cancel() {} }); }
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); };
async function classify(P, quotes, provider) {
  for (const q of quotes) say(P, q, provider);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: quotes.map((q) => ({ ref: refOf(p, q), kind: "boundary", seat: "outOfScope", quote: q, why: "프로젝트 내내 지킬 판정 기준", bounds: "이 기준으로 결함 여부를 판정한다" })) })) });
  assert.ok(r.st === "ok", JSON.stringify(r));
  return r.resultIds;
}
const events = (kind) => { try { return (CL.readIntegrityEvents() || []).filter((e) => e && e.kind === kind); } catch { return []; } };

t("① 관문 판정 — 이번 차례 미판단만 · 같은 상태 3번 막고 4번째에 노랑 경보로 놓아줌(같은 상태 재차단 없음) · 판단하면 다시 셈 · 다 판단=관문 없음 · 판독 오류=관문 없음", async () => {
  const P = project("unit");
  const [a, b] = await classify(P, ["실기기 최신폰 확인은 이번 단계 범위 밖으로 계속 본다", "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다"]);
  const ctx = { ok: true, turnAnchor: "turn-u1", repoKey: P.rk, provider: "claude", sessionId: "cs-u1" };
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx, { lang: "ko" }), null, "넘겨받은 것 없음=관문 없음");
  const pl = CF.planDelivery(P.ws, ctx); CF.markResultsDelivered(P.ws, pl.deliver, ctx);
  const evBefore = events("classify-undecided").length;
  for (let i = 1; i <= CF.STOP_GATE_MAX; i++) {
    const g = CF.classifyStopGate(P.ws, ctx, { lang: "ko" });
    assert.ok(g && g.n === i && g.block.includes("[분류 결과 판단 관문]") && g.block.includes(a) && g.block.includes(b) && g.block.includes("classify skip <id> --note") && g.block.includes("--from <id>") && g.block.includes('--rule "') && g.block.includes('--bounds "') && g.block.includes("대화에 늘어놓거나 사용자에게 묻지 않고"), "막음 " + i + " " + (g && g.block));
  }
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx, { lang: "ko" }), null, "★같은 상태 4번째=놓아줌");
  const ev = events("classify-undecided");
  assert.ok(ev.length === evBefore + 1 && ev[ev.length - 1].severity === "warning" && ev[ev.length - 1].detailKo.includes("다음 사람의 차례에 한 번 더"), "★노랑 경보 1건 " + JSON.stringify(ev.slice(-1)));
  // 사용자가 경보를 '확인함'으로 닫은 뒤 같은 상태로 다시 종료해도 경보가 되살아나지 않음(놓아준 상태 기억)
  assert.ok(CL.ackIntegrityEvents(events("classify-undecided").map((e) => e.id)));
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx, { lang: "ko" }), null, "★놓아준 같은 상태로 다시 막지 않음");
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx, { lang: "ko" }), null);
  assert.strictEqual(events("classify-undecided").filter((e) => !e.ack).length, 0, "★닫은 경보가 같은 상태 종료로 되살아나지 않음");
  // 경보 목록이 최근 50건 상한으로 밀려나 같은 상태의 경보가 사라져도 '놓아줌' 기억만으로 경보를 다시 쓰지 않음(두 겹 방어)
  assert.ok(CL.atomicWrite(CL.INTEGRITY_FILE, JSON.stringify({ events: CL.readIntegrityEvents().filter((e) => e.kind !== "classify-undecided") })));
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx, { lang: "ko" }), null, "밀려난 뒤에도 같은 상태로 다시 막지 않음");
  assert.strictEqual(events("classify-undecided").length, 0, "★밀려난 뒤에도 같은 상태 경보 재발행 없음");
  // 하나를 판단하면 상태가 바뀌어 남은 것으로 다시 셈
  assert.ok(CF.skipResult(P.ws, a, "같은 뜻 수칙이 이미 있어서 안 올림", ctx).ok);
  const g2 = CF.classifyStopGate(P.ws, ctx, { lang: "en" });
  assert.ok(g2 && g2.n === 1 && !g2.block.includes(a) && g2.block.includes(b) && g2.block.includes("[User-words classification gate]"), "★판단 뒤 남은 것으로 다시 셈 " + (g2 && g2.block));
  assert.ok(CF.skipResult(P.ws, b, "이번 작업 전체 기준은 아니어서 안 올림", ctx).ok);
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx, { lang: "ko" }), null, "다 판단=관문 없음");
  assert.ok(!fs.existsSync(CF.stopGateFileFor("claude", "cs-u1")), "관문 기록 정리");
  // 다른 차례·다른 회사=관문 없음
  const [c2] = await classify(P, ["검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어"]);
  const ctx2 = Object.assign({}, ctx, { turnAnchor: "turn-u2", sessionId: "cs-u2" });
  const pl2 = CF.planDelivery(P.ws, ctx2); CF.markResultsDelivered(P.ws, pl2.deliver, ctx2);
  assert.ok(CF.classifyStopGate(P.ws, Object.assign({}, ctx2, { turnAnchor: "turn-u3" }), {}) === null, "다른 차례=관문 없음");
  assert.ok(CF.classifyStopGate(P.ws, Object.assign({}, ctx2, { provider: "codex" }), {}) === null, "다른 회사=관문 없음");
  // 결과 장부 판독 오류=관문 없음
  const rf = path.join(HOME, "classify", CL.wsKeyFor(P.ws) + ".results.jsonl");
  fs.renameSync(rf, rf + ".bak"); fs.mkdirSync(rf);
  try { assert.strictEqual(CF.classifyStopGate(P.ws, ctx2, {}), null, "판독 오류=관문 없음"); } finally { fs.rmdirSync(rf); fs.renameSync(rf + ".bak", rf); }
  assert.ok(CF.classifyStopGate(P.ws, ctx2, {}), "복구 뒤 다시 막음 " + c2);
  // 횟수를 저장할 수 없으면 막지 않음(셀 수 없는 차단=끝없는 차단 위험) — 경보만
  const gd = path.join(HOME, "classify", "stop-gate");
  fs.renameSync(gd, gd + ".bak"); fs.writeFileSync(gd, "not a dir");
  let g9; try { g9 = CF.classifyStopGate(P.ws, ctx2, { lang: "ko" }); } finally { fs.rmSync(gd, { force: true }); fs.renameSync(gd + ".bak", gd); }
  assert.strictEqual(g9, null, "★횟수 저장 실패=막지 않음");
  const ev9 = events("classify-undecided");
  assert.ok(ev9.length && ev9[ev9.length - 1].detailKo.includes("횟수 기록 실패"), "경보에 사유 " + JSON.stringify(ev9.slice(-1)));
  // [검증 1회차 blocker] 횟수 기록이 손상됐으면(없음과 다름) 막지 않음 + 경보 1건 · 읽을 수 있는 '놓아줌' 기록으로 갈아 두어 다음 종료부터 조용히 통과
  //  (같은 상태의 경보가 이미 있으면 새로 쓰지 않으므로 다른 세션 — 바로 위 저장 실패 경보와 같은 상태면 1건으로 묶임)
  const ctx3 = Object.assign({}, ctx2, { sessionId: "cs-u3" });
  const fx = CF.stopGateFileFor("claude", "cs-u3");
  fs.writeFileSync(fx, "{ broken");
  //  (같은 종류의 미확인 경보는 새 경보가 갈아끼우므로 개수가 아니라 세션별 경보로 확인)
  const bySess = (sid) => events("classify-undecided").filter((e) => e.session === sid);
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx3, { lang: "ko" }), null, "★손상된 횟수 기록=막지 않음");
  const evA1 = bySess("cs-u3");
  assert.ok(evA1.length === 1 && evA1[0].detailKo.includes("횟수 기록 판독 실패"), "경보 1건 " + JSON.stringify(evA1));
  for (let i = 0; i < 4; i++) assert.strictEqual(CF.classifyStopGate(P.ws, ctx3, { lang: "ko" }), null, "갈아 둔 기록으로 계속 통과");
  assert.ok(JSON.parse(fs.readFileSync(fx, "utf8")).gaveUp === true, "읽을 수 있는 '놓아줌' 기록으로 갈아 둠");
  assert.ok(bySess("cs-u3").length === 1 && bySess("cs-u3")[0].id === evA1[0].id, "경보 재발행 없음");
  // [검증 1회차 blocker] 횟수 기록을 계속 읽을 수 없으면(갈아 쓰기도 실패) 매번 1번째로 세어 끝없이 막지 않음 · 경보는 같은 상태당 1건 · 닫은 경보도 되살아나지 않음
  const ctx4 = Object.assign({}, ctx2, { sessionId: "cs-u4" });
  const fd = CF.stopGateFileFor("claude", "cs-u4");
  fs.mkdirSync(fd, { recursive: true });
  try {
    for (let i = 0; i < 8; i++) assert.strictEqual(CF.classifyStopGate(P.ws, ctx4, { lang: "ko" }), null, "★읽을 수 없는 횟수 기록=막지 않음 " + i);
    assert.strictEqual(bySess("cs-u4").length, 1, "★경보는 같은 상태당 1건");
    assert.ok(bySess("cs-u4")[0].detailKo.includes("횟수 기록 판독 실패"));
    assert.ok(CL.ackIntegrityEvents(events("classify-undecided").map((e) => e.id)));
    for (let i = 0; i < 4; i++) assert.strictEqual(CF.classifyStopGate(P.ws, ctx4, { lang: "ko" }), null);
    assert.strictEqual(events("classify-undecided").filter((e) => !e.ack).length, 0, "★닫은 경보가 되살아나지 않음");
    assert.strictEqual(bySess("cs-u4").length, 1);
  } finally { fs.rmSync(fd, { recursive: true, force: true }); }
  // [검증 1회차 blocker] 결과 장부를 잠깐 못 읽어도 '놓아줌' 기억이 지워지지 않음 — 회복 뒤 같은 상태를 다시 막거나 경보를 또 쓰지 않음
  const ctx5 = Object.assign({}, ctx2, { sessionId: "cs-u5" });
  for (let i = 1; i <= CF.STOP_GATE_MAX; i++) assert.ok(CF.classifyStopGate(P.ws, ctx5, { lang: "ko" }), "막음 " + i);
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx5, { lang: "ko" }), null, "4번째=놓아줌");
  const evC = bySess("cs-u5");
  assert.strictEqual(evC.length, 1, "놓아줌 경보 1건");
  fs.renameSync(rf, rf + ".bak"); fs.mkdirSync(rf);
  try { assert.strictEqual(CF.classifyStopGate(P.ws, ctx5, {}), null, "판독 오류=관문 없음"); } finally { fs.rmdirSync(rf); fs.renameSync(rf + ".bak", rf); }
  const kept = JSON.parse(fs.readFileSync(CF.stopGateFileFor("claude", "cs-u5"), "utf8"));
  assert.ok(kept.gaveUp === true, "★판독 오류가 '놓아줌' 기억을 지우지 않음 " + JSON.stringify(kept));
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx5, { lang: "ko" }), null, "★회복 뒤 같은 상태를 다시 막지 않음");
  assert.ok(bySess("cs-u5").length === 1 && bySess("cs-u5")[0].id === evC[0].id, "★회복 뒤 경보 재발행 없음");
  // [검증 1회차 보완] 경보 문구가 남은 전달 횟수에 맞음 — 두 번째로 넘겨받은 결과는 '한 번 더'를 약속하지 않음
  const w1 = CF.stopGateWarnText([{ resultId: "r1", deliveries: 1 }], "반복 종료 막기 상한", "ko"), w2 = CF.stopGateWarnText([{ resultId: "r2", deliveries: 2 }], "반복 종료 막기 상한", "ko");
  assert.ok(w1.includes("한 번 더 넘어갈 수 있고") && !w1.includes("이미 두 번째"), w1);
  assert.ok(w2.includes("이미 두 번째로 넘겨받은") && !w2.includes("한 번 더"), w2);
  const w3 = CF.stopGateWarnText([{ resultId: "r1", deliveries: 1 }, { resultId: "r2", deliveries: 2 }], "x", "en");
  assert.ok(w3.includes("1 can be handed over once more") && w3.includes("1 were already on their second hand-over"), w3);
  // 실제 두 번째 전달 차례에서 상한으로 놓아주면 '이미 두 번째' 문구
  const ctx6 = Object.assign({}, ctx2, { turnAnchor: "turn-u6", sessionId: "cs-u6" });
  const pl6 = CF.planDelivery(P.ws, ctx6);
  assert.ok(pl6.deliver.length === 1 && pl6.deliver[0].resultId === c2 && pl6.deliver[0].deliveries === 1, "두 번째 전달 " + JSON.stringify(pl6));
  CF.markResultsDelivered(P.ws, pl6.deliver, ctx6);
  for (let i = 1; i <= CF.STOP_GATE_MAX; i++) assert.ok(CF.classifyStopGate(P.ws, ctx6, { lang: "ko" }), "막음 " + i);
  assert.strictEqual(CF.classifyStopGate(P.ws, ctx6, { lang: "ko" }), null);
  const ev6 = events("classify-undecided");
  assert.ok(ev6[ev6.length - 1].detailKo.includes("이미 두 번째로 넘겨받은") && !ev6[ev6.length - 1].detailKo.includes("한 번 더"), "★두 번째 전달 문구 " + ev6[ev6.length - 1].detailKo);
});

t("② Claude 종료 훅 실제 실행 — 다른 조건 통과 자리에서만 막음(검증 안내가 먼저) · 안 올림 뒤 통과", async () => {
  const P = project("vg");
  assert.ok(CL.patchContractFields(P.ws, "ko", { verifyMode: "code" }));
  const [a] = await classify(P, ["실기기 최신폰 확인은 이번 단계 범위 밖으로 계속 본다"]);
  const SID = "cs-vg-session-1";
  const txDir = mk("cs-tx-"), tp = path.join(txDir, SID + ".jsonl");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SID });
  const ts0 = new Date(Date.now() - 5000).toISOString();
  fs.writeFileSync(tp, JSON.stringify({ type: "user", sessionId: SID, timestamp: ts0, message: { role: "user", content: "다음 단계 진행해 주세요" } }) + "\n");
  const inj = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "contract-inject.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: P.ws, prompt: "다음 단계 진행해 주세요", transcript_path: tp, permission_mode: "default", prompt_id: "pid-vg-1" }), encoding: "utf8", env, cwd: P.ws });
  assert.ok(inj.status === 0 && CF.readClassifyResults(P.ws).latest.get(a).status === "delivered", "(전제) 전달 " + inj.stderr);
  fs.appendFileSync(tp, JSON.stringify({ type: "assistant", sessionId: SID, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "진행했습니다." }] } }) + "\n");
  const stop = () => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "verify-guard.js")], { input: JSON.stringify({ hook_event_name: "Stop", session_id: SID, cwd: P.ws, transcript_path: tp, stop_hook_active: false }), encoding: "utf8", env, cwd: P.ws });
  const out = (o) => { try { return JSON.parse(o.stdout); } catch { return null; } };
  const s1 = out(stop());
  assert.ok(s1 && s1.decision === "block" && s1.reason.includes("[분류 결과 판단 관문]") && s1.reason.includes(a), "★미판단=종료 막음 " + JSON.stringify(s1));
  // 검증이 필요한 상태(검증 모드 always)면 검증 안내가 먼저
  assert.ok(CL.patchContractFields(P.ws, "ko", { verifyMode: "always" }));
  const s2 = out(stop());
  assert.ok(s2 && s2.decision === "block" && !s2.reason.includes("[분류 결과 판단 관문]"), "★검증 안내가 먼저 " + (s2 && s2.reason.slice(0, 80)));
  assert.ok(CL.patchContractFields(P.ws, "ko", { verifyMode: "code" }));
  // 명령줄 안 올림 → 통과
  const sk = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "classify", "skip", a, "--note", "이번 작업 전체 기준이 아니라 안 올림"], { env, encoding: "utf8", cwd: P.ws });
  assert.ok(sk.status === 0, sk.stdout + sk.stderr);
  const s3 = stop();
  assert.ok(s3.status === 0 && !out(s3), "★판단 뒤 통과 " + s3.stdout.slice(0, 120));
});

t("③ Codex 종료 훅 실제 실행 — 넘겨받은 미판단이면 막음 · 판단 뒤 통과", async () => {
  const P = project("cx");
  assert.ok(CL.patchContractFields(P.ws, "ko", { harnessMode: "codex-codex", codexVerifyMode: "code", verifyMode: "always" }));
  const [x] = await classify(P, ["Codex 쪽 기준 외부 서버 연동 오류는 다루지 않는다고 했어"], "codex");
  const CSID = "019f0000-6666-7666-8666-955566677722";
  const rollout = path.join(mk("cs-rollout-"), "rollout.jsonl");
  fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", timestamp: new Date(Date.now() - 60000).toISOString(), payload: { id: CSID, source: "vscode", thread_source: "user" } }) + "\n", "utf8");
  const envX = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }); delete envX.CLAUDE_PROJECT_DIR;
  const hook = (ev, extra) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-hook.js")], { input: JSON.stringify(Object.assign({ hook_event_name: ev, session_id: CSID, cwd: P.ws, transcript_path: rollout }, extra)), encoding: "utf8", timeout: 30000, env: envX, windowsHide: true });
  const out = (o) => { try { return JSON.parse(o.stdout); } catch { return null; } };
  assert.strictEqual(hook("UserPromptSubmit", { turn_id: "C1", prompt: "구현 계속 진행해" }).status, 0);
  assert.strictEqual(CF.readClassifyResults(P.ws).latest.get(x).status, "delivered", "(전제) 전달");
  const s1 = out(hook("Stop", { turn_id: "C1", stop_hook_active: false }));
  assert.ok(s1 && s1.decision === "block" && s1.reason.includes("[분류 결과 판단 관문]") && s1.reason.includes(x), "★Codex 미판단=종료 막음 " + JSON.stringify(s1));
  assert.ok(CF.skipResult(P.ws, x, "이번 작업 전체 기준이 아니라 안 올림", { ok: true, turnAnchor: "C1", repoKey: P.rk, provider: "codex", sessionId: CSID }).ok);
  const s2 = hook("Stop", { turn_id: "C1", stop_hook_active: false });
  assert.ok(!out(s2), "★판단 뒤 통과 " + s2.stdout.slice(0, 160));
});

t("④ 대시보드 경보 줄 — '분류 결과 판단 없이 끝난 차례'(근거 의심 아님) · 상태 표시줄 이름(소스 고정)", () => {
  const src = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const i = src.indexOf('    safe(function(){\n    const ib = $("integrityBanner");');
  const j = src.indexOf("\n    safe(function(){", i + 20);
  assert.ok(i > 0 && j > i, "경보 줄 조각");
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", innerHTML: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, replaceChildren() { this.children = []; }, addEventListener() {}, remove() {} }; return o; };
  const el = (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ib = mkEl("div");
  new Function("document", "$", "T", "d", "el", "vscode", "safe", src.slice(i, j))({ createElement: mkEl, createTextNode: (x) => Object.assign(mkEl("#text"), { textContent: String(x) }) }, (id) => (id === "integrityBanner" ? ib : null), (ko) => ko, { integrity: [{ id: "c1", ack: false, severity: "warning", kind: "classify-undecided", workspace: "w", detail: "x" }] }, el, { postMessage() {} }, (f) => f());
  const all = []; const w = (x) => { all.push(x.textContent || ""); (x.children || []).forEach(w); }; w(ib);
  const txt = all.join(" | ");
  assert.ok(txt.includes("사용자 말 분류 결과 판단 없이 끝난 차례 1건") && !txt.includes("근거 의심") && /확인함/.test(txt), "경보 줄 " + txt.slice(0, 200));
  const ts = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(/const nClsUnd = warns\.filter\(\(e\) => e\.kind === "classify-undecided"\)\.length;/.test(ts) && /: nClsUnd \? tE\("분류 결과 판단 누락","User-words results undecided"\)/.test(ts) && /nEnrich - nHookChk - nClsUnd;/.test(ts), "상태 표시줄 분리");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
