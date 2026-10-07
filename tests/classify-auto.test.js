"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-나-2 2단계] 사용자 말 분류 — 자동 계기(캠페인 마감: 검증 통과·왕복 상한)·확인 대기 1줄(§3-7)·
 * 분류하지 못한 말 처리·화면 자료·D3 범위 짧은 목록(정적 전달 전용)·대시보드 합산/한꺼번에 올리기 칸 전달.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입). 분류 담당 호출은 페이지 실행기 주입. 훅·명령줄은 자식 프로세스로 실제 실행.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "classify-auto-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sec = (label) => { pending.push([null, label]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const MIN = 60 * 1000;
let seq = 0;
function project(tag) {
  const ws = mk("ca-ws-" + tag + "-"), repo = mk("ca-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo) };
}
function say(P, text, provider) {
  const anc = CL.turnAnchorOf("ca-s", new Date(Date.UTC(2026, 9, 5, 1, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  const r = UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "ca-s", repoKey: P.rk, provider: provider || "claude" });
  assert.ok(r.ok && !r.held);
  return { anchor: anc, id: "p-" + sha1(CL.wsKeyFor(P.ws) + "|prompt|" + anc).slice(0, 16) };
}
function round(P, campaignId, roundNo, verdict, ts, repoKey) {
  CL.appendFindingsLedger(P.ws, [{ type: "round", campaignId, round: roundNo, roundType: "discovery", verdict, envelopeHash: CL.GEN0_HASH, ts }], { repoKey: repoKey === undefined ? P.rk : repoKey });
}
// 자식과 같은 조건의 판정 — 분류 실행 잠금을 잡고 판정한 뒤 해제(실행은 하지 않음)
const judgeHeld = (P, opts) => { const lk = CF.acquireClassifyLock(P.ws); assert.ok(lk.ok, "잠금"); try { return CF.classifyTickJudge(P.ws, null, Object.assign({}, opts || {}, { lockToken: lk.token })); } finally { CF.releaseClassifyLock(P.ws, lk.token); } };
const fakeRunner = (answer, calls) => ({ arm, prompt }) => { if (calls) calls.push({ arm, prompt }); const out = typeof answer === "function" ? answer(prompt) : answer; return { promise: Promise.resolve({ ok: true, output: JSON.stringify(out) }), cancel() {} }; };
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); assert.ok(from > 0 && i > from); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); };

sec("[1] 마감 사건 — 검증 통과·왕복 상한 · 이 저장소만");
t("판정 행 중 통과(pass·pass-notes)=통과 마감 · 상한(1 이상)에 닿은 회차=상한 마감 · 상한 0(무제한)=마감 아님 · 다른 저장소·표식 없는 행=제외", () => {
  const P = project("ev");
  round(P, "c-pass", 1, "fail", "2026-10-05T01:00:00.000Z");
  round(P, "c-pass", 2, "pass-notes", "2026-10-05T01:05:00.000Z");
  round(P, "c-cap", 3, "fail", "2026-10-05T02:00:00.000Z");
  round(P, "c-unl", 9, "fail", "2026-10-05T03:00:00.000Z");
  round(P, "c-other", 1, "pass", "2026-10-05T04:00:00.000Z", "f".repeat(16));
  fs.mkdirSync(path.dirname(CL.campaignFileFor(P.ws)), { recursive: true });
  fs.writeFileSync(CL.campaignHistoryFileFor(P.ws), [{ schema: "vcamp-1", campaignId: "c-cap", count: 3, budget: 3, repoKey: P.rk, updatedAt: "2026-10-05T02:00:00.000Z" }, { schema: "vcamp-1", campaignId: "c-unl", count: 9, budget: 0, repoKey: P.rk, updatedAt: "2026-10-05T03:00:00.000Z" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const ev = CF.closeEventsFor(P.ws, P.rk);
  assert.deepStrictEqual(ev.map((e) => e.campaignId + ":" + e.kind), ["c-pass:pass", "c-cap:cap"], JSON.stringify(ev));
  assert.ok(ev.every((e) => typeof e.key === "string" && e.key), "사건 열쇠");
  // [검증 1회차 blocker] 같은 캠페인이 수칙서 세대 H1 두 번→H2 두 번 — 판정 행 회차 1,2,1,2 · 캠페인 누적 count=4·budget=4 → 상한 마감
  const Q = project("evgen");
  for (const [rn, h] of [[1, "H1"], [2, "H1"], [1, "H2"], [2, "H2"]]) CL.appendFindingsLedger(Q.ws, [{ type: "round", campaignId: "c-gen", round: rn, roundType: "discovery", verdict: "fail", envelopeHash: h, ts: "2026-10-05T05:0" + rn + ":00.000Z" }], { repoKey: Q.rk });
  fs.mkdirSync(path.dirname(CL.campaignFileFor(Q.ws)), { recursive: true });
  fs.writeFileSync(CL.campaignFileFor(Q.ws), JSON.stringify({ schema: "vcamp-1", campaignId: "c-gen", count: 4, budget: 4, repoKey: Q.rk, updatedAt: "2026-10-05T05:04:00.000Z" }));
  assert.deepStrictEqual(CF.closeEventsFor(Q.ws, Q.rk).map((e) => e.key), ["cap:c-gen"], "세대를 넘는 상한 소진");
  fs.writeFileSync(CL.campaignFileFor(Q.ws), JSON.stringify({ schema: "vcamp-1", campaignId: "c-gen", count: 4, budget: 4, repoKey: "e".repeat(16), updatedAt: "2026-10-05T05:04:00.000Z" }));
  assert.deepStrictEqual(CF.closeEventsFor(Q.ws, Q.rk), [], "다른 저장소 캠페인 기록=제외");
});

sec("[2] 자동 계기 판정(자식) — 기준선·새 마감·간격·빈 대기열·같은 마감 한 번");
t("첫 판정=기준선(실행 없음) · 새 마감+대기열=실행 · 같은 마감 재판정=없음 · 마감 없음=없음 · 빈 대기열=마감 소모 · 최근 실행 10분 안=없음 · 실행 중 잠금=없음", async () => {
  const P = project("judge");
  round(P, "c1", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "자동 계기 시험용 말입니다 기준 아님");
  const j0 = judgeHeld(P);
  assert.ok(!j0.spawn && j0.reason === "baseline", JSON.stringify(j0));
  assert.strictEqual(judgeHeld(P).reason, "no-close", "설치 이전 마감은 세지 않음");
  round(P, "c2", 2, "pass", "2026-10-05T02:00:00.000Z");
  assert.strictEqual(CF.classifyTickJudge(P.ws).reason, "lock-required", "실행권(잠금) 없이 마감을 소비하지 않음");
  const j1 = judgeHeld(P);
  assert.ok(j1.spawn && j1.kind === "pass", JSON.stringify(j1));
  assert.strictEqual(judgeHeld(P).reason, "no-close", "같은 마감은 한 번만");
  // 최근 실행 10분 안
  await CF.runClassify(P.ws, { pageRunner: fakeRunner({ candidates: [] }) });
  round(P, "c3", 1, "pass", "2026-10-05T03:00:00.000Z");
  assert.strictEqual(judgeHeld(P).reason, "recent");
  const j2 = judgeHeld(P, { now: Date.now() + 11 * MIN });
  assert.strictEqual(j2.reason, "queue-empty", "대기열 비면 실행 없음 " + JSON.stringify(j2));
  round(P, "c4", 1, "pass", "2026-10-05T04:00:00.000Z");
  say(P, "다음 마감 때 살펴볼 말입니다 기준 아님");
  const lk = CF.acquireClassifyLock(P.ws);
  assert.strictEqual(CF.classifyTickJudge(P.ws, null, { now: Date.now() + 11 * MIN }).reason, "running");
  CF.releaseClassifyLock(P.ws, lk.token);
  assert.ok(judgeHeld(P, { now: Date.now() + 11 * MIN }).spawn, "빈 대기열로 소모된 마감 뒤 새 마감=실행");
});
t("반례 고정(검증 1회차): 첫 판정 직전 수동 실행이어도 기준선이 먼저 · 시계가 뒤로 간 뒤의 새 마감도 잡음 · 소비 기록 실패=실행 안 함 · 두 자식이 동시에 돌아도 같은 마감은 한 번", async () => {
  // ① 첫 판정이 '최근 실행'이어도 기준선 — 설치 이전 마감으로 나중에 실행하지 않음
  const A = project("j-recent");
  round(A, "old", 1, "pass", "2026-10-04T01:00:00.000Z");
  say(A, "최근 실행 반례용 말입니다 기준 아님");
  await CF.runClassify(A.ws, { pageRunner: fakeRunner({ candidates: [] }) });
  say(A, "다음 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(A).reason, "baseline", "첫 판정=기준선(최근 실행보다 먼저)");
  assert.strictEqual(judgeHeld(A, { now: Date.now() + 11 * MIN }).reason, "no-close", "설치 이전 마감으로 실행하지 않음");
  // ② 시계 역전 — 이미 본 마감 01:00:00 뒤에 기록 시각이 00:59:55 인 새 마감
  const B = project("j-clock");
  round(B, "b1", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(B, "시계 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(B).reason, "baseline");
  round(B, "b2", 1, "pass", "2026-10-05T00:59:55.000Z");
  const jb = judgeHeld(B, { now: Date.now() + 60 * MIN });
  assert.ok(jb.spawn, "시각이 더 이른 새 마감도 새 사건 " + JSON.stringify(jb));
  // ③ 소비 기록 실패=실행 안 함
  const C = project("j-write");
  round(C, "w1", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(C, "기록 실패 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(C).reason, "baseline");
  round(C, "w2", 1, "pass", "2026-10-05T02:00:00.000Z");
  const tf = CF.classifyTickFileFor(C.ws, C.rk);
  fs.chmodSync(tf, 0o444); // 읽기는 되고 교체 쓰기만 실패(읽기 전용 파일 위로 원자적 교체 불가)
  let jc; try { jc = judgeHeld(C); } finally { fs.chmodSync(tf, 0o644); }
  assert.ok(!jc.spawn && jc.reason === "state-write", "소비 기록 실패=실행 안 함 " + JSON.stringify(jc));
  assert.ok(judgeHeld(C).spawn, "기록이 되면 그 마감으로 실행(실패 때 소비되지 않았음)");
  // ④ 동시 두 자식 — 같은 마감으로 실행은 한 번
  const D = project("j-race");
  round(D, "r1", 1, "pass", "2026-10-05T01:00:00.000Z");
  for (let i = 0; i < 3; i++) say(D, "동시 실행 반례용 말 " + i + " 입니다 기준 아님");
  assert.strictEqual(judgeHeld(D).reason, "baseline");
  round(D, "r2", 1, "pass", "2026-10-05T02:00:00.000Z");
  let calls = 0;
  const slow = () => { calls++; return { promise: new Promise((res) => setTimeout(() => res({ ok: true, output: JSON.stringify({ candidates: [] }) }), 300)), cancel() {} }; };
  const [x, y] = await Promise.all([CF.classifyTick(D.ws, { pageRunner: slow }), CF.classifyTick(D.ws, { pageRunner: slow })]);
  assert.strictEqual(calls, 1, "분류 호출 1회 " + JSON.stringify([x.st, x.judge && x.judge.reason, y.st, y.judge && y.judge.reason]));
  assert.ok([x, y].filter((r) => r.st === "ok").length === 1 && [x, y].some((r) => r.st === "no-run"), "하나만 실행");
  const z = await CF.classifyTick(D.ws, { pageRunner: slow, now: Date.now() + 11 * MIN });
  assert.ok(z.st === "no-run" && calls === 1, "끝난 뒤에도 같은 마감 재실행 없음 " + JSON.stringify(z.judge));
  // ⑤ 확정 반례: 다른 실행이 잠금을 쥐고 있으면 자식은 판정도 마감 소비도 하지 않는다(소비는 잠금 안에서만 — 교차 순서가 생길 자리가 없음)
  const E = project("j-held");
  round(E, "h1", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(E, "잠금 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(E).reason, "baseline");
  round(E, "h2", 1, "pass", "2026-10-05T02:00:00.000Z");
  const seen0 = CF.readClassifyTick(E.ws, E.rk).seenKeys.slice();
  const other = CF.acquireClassifyLock(E.ws);
  let held5; try { held5 = await CF.classifyTick(E.ws, { pageRunner: slow }); } finally { CF.releaseClassifyLock(E.ws, other.token); }
  assert.ok(held5.st === "no-run" && held5.judge.reason === "running", JSON.stringify(held5));
  assert.deepStrictEqual(CF.readClassifyTick(E.ws, E.rk).seenKeys, seen0, "잠금 없이 마감 소비 없음");
  const after5 = await CF.classifyTick(E.ws, { pageRunner: slow });
  assert.ok(after5.st === "ok", "잠금이 풀리면 그 마감으로 한 번 실행 " + JSON.stringify(after5.judge));
});
t("반례 고정(검증 2회차): 판정 장부 판독 오류=본 마감 기억 보존(복구 뒤 같은 마감 재실행 없음) · 첫 판정 판독 오류=기준선 미룸 · 잠금 없이는 빈 대기열 분기도 소비 없음 · 일부만 보인 판독이 기억을 줄이지 않음", async () => {
  const A = project("r2-err");
  const led = CL.findingsLedgerFileFor(A.ws);
  round(A, "e0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(A, "판독 오류 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(A).reason, "baseline");
  round(A, "e1", 1, "pass", "2026-10-05T02:00:00.000Z");
  let calls = 0;
  const pr = () => { calls++; return { promise: Promise.resolve({ ok: true, output: JSON.stringify({ candidates: [] }) }), cancel() {} }; };
  assert.strictEqual((await CF.classifyTick(A.ws, { pageRunner: pr })).st, "ok");
  const seen1 = CF.readClassifyTick(A.ws, A.rk).seenKeys.slice();
  say(A, "다음 마감을 기다리는 말입니다 기준 아님");
  const bak = led + ".bak"; fs.renameSync(led, bak); fs.mkdirSync(led); // 판정 장부 판독 오류(파일 자리에 폴더)
  const je = judgeHeld(A, { now: Date.now() + 11 * MIN });
  fs.rmSync(led, { recursive: true, force: true }); fs.renameSync(bak, led);
  assert.strictEqual(je.reason, "events-unreadable");
  assert.deepStrictEqual(CF.readClassifyTick(A.ws, A.rk).seenKeys, seen1, "본 마감 기억 보존");
  // 파일은 있는데 여는 순간 거부(권한 오류 등)도 같은 판정 — 빈 목록으로 줄이지 않음
  const realOpen = fs.openSync;
  fs.openSync = function (f, ...rest) { if (String(f) === led) { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; } return realOpen.call(fs, f, ...rest); };
  let ja; try { ja = judgeHeld(A, { now: Date.now() + 11 * MIN }); } finally { fs.openSync = realOpen; }
  assert.strictEqual(ja.reason, "events-unreadable", "열기 거부=판독 오류");
  assert.deepStrictEqual(CF.readClassifyTick(A.ws, A.rk).seenKeys, seen1, "본 마감 기억 보존(열기 거부)");
  const after = await CF.classifyTick(A.ws, { pageRunner: pr, now: Date.now() + 22 * MIN });
  assert.ok(after.st === "no-run" && after.judge.reason === "no-close" && calls === 1, "복구 뒤 같은 마감 재실행 없음 " + JSON.stringify(after.judge));
  // 첫 판정에서 판독 오류=기준선 미룸(초기화로 표시하지 않음)
  const B = project("r2-first");
  round(B, "f0", 1, "pass", "2026-10-05T01:00:00.000Z");
  const ledB = CL.findingsLedgerFileFor(B.ws), bakB = ledB + ".bak";
  fs.renameSync(ledB, bakB); fs.mkdirSync(ledB);
  const jf = judgeHeld(B);
  fs.rmSync(ledB, { recursive: true, force: true }); fs.renameSync(bakB, ledB);
  assert.ok(jf.reason === "events-unreadable" && !CF.readClassifyTick(B.ws, B.rk).seeded, "기준선 미룸");
  say(B, "기준선 뒤 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(B).reason, "baseline", "복구 뒤 기준선 — 설치 이전 마감으로 실행 안 함");
  // 잠금 없이는 빈 대기열 분기도 소비 없음
  const C = project("r2-nolock");
  round(C, "n0", 1, "pass", "2026-10-05T01:00:00.000Z");
  assert.strictEqual(judgeHeld(C).reason, "baseline");
  round(C, "n1", 1, "pass", "2026-10-05T02:00:00.000Z");
  const seenC = CF.readClassifyTick(C.ws, C.rk).seenKeys.slice();
  assert.strictEqual(CF.classifyTickJudge(C.ws).reason, "lock-required", "대기열이 비어도 잠금 없이는 판정 안 함");
  assert.deepStrictEqual(CF.readClassifyTick(C.ws, C.rk).seenKeys, seenC, "소비 없음");
  // 일부만 보인 판독(본 마감 행이 꼬리에서 빠짐)이 기억을 줄이지 않음 → 다시 보여도 새 마감 아님
  const D = project("r2-union");
  round(D, "u0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(D, "합집합 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(D).reason, "baseline");
  const ledD = CL.findingsLedgerFileFor(D.ws);
  const full = fs.readFileSync(ledD, "utf8");
  fs.writeFileSync(ledD, ""); // 사건이 잠시 안 보임
  assert.strictEqual(judgeHeld(D).reason, "no-close");
  assert.ok(CF.readClassifyTick(D.ws, D.rk).seenKeys.length === 1, "기억 유지");
  fs.writeFileSync(ledD, full);
  assert.strictEqual(judgeHeld(D).reason, "no-close", "다시 보여도 새 마감 아님");
});
t("반례 고정(검증 3회차): 본 마감 기억 파일 판독 실패=아무것도 쓰지 않고 보류(새 마감을 실행 없이 소비하지 않음 · 사건 장부도 함께 실패해도 기억 덮어쓰기 없음) · 형식 깨진 기억=격리 후 처음 · 짧은 읽기=판독 오류(빈 목록으로 기준선 확정 금지)", async () => {
  const A = project("r3-state");
  round(A, "s0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(A, "기억 판독 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(A).reason, "baseline");
  round(A, "s1", 1, "pass", "2026-10-05T02:00:00.000Z"); // 새 마감 E1
  const tf = CF.classifyTickFileFor(A.ws, A.rk);
  const before = fs.readFileSync(tf, "utf8");
  const realRead = fs.readFileSync;
  const deny = (paths) => { fs.readFileSync = function (f, ...rest) { if (paths.includes(String(f))) { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; } return realRead.call(fs, f, ...rest); }; };
  deny([tf]);
  let j1; try { j1 = judgeHeld(A); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(j1.reason, "state-unreadable");
  assert.strictEqual(fs.readFileSync(tf, "utf8"), before, "기억 파일 무변경");
  // 기억·사건 장부 둘 다 판독 실패해도 덮어쓰기 없음
  const realOpen = fs.openSync;
  const led = CL.findingsLedgerFileFor(A.ws);
  deny([tf]); fs.openSync = function (f, ...rest) { if (String(f) === led) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return realOpen.call(fs, f, ...rest); };
  let j2; try { j2 = judgeHeld(A); } finally { fs.readFileSync = realRead; fs.openSync = realOpen; }
  assert.ok(j2.reason === "state-unreadable" && fs.readFileSync(tf, "utf8") === before, "둘 다 실패=무변경");
  deny([tf]); let mr; try { mr = CF.markClassifyRan(A.ws, A.rk); } finally { fs.readFileSync = realRead; }
  assert.ok(mr === false && fs.readFileSync(tf, "utf8") === before, "실행 시각 기록도 판독 실패면 쓰지 않음");
  const j3 = judgeHeld(A);
  assert.ok(j3.spawn, "복구 뒤 새 마감 E1 으로 실행(소비되지 않았음) " + JSON.stringify(j3));
  // 형식 깨진 기억=격리 후 처음(기준선) — 두 번 실행하지 않는 방향
  const B = project("r3-corrupt");
  round(B, "c0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(B, "깨진 기억 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(B).reason, "baseline");
  const tfB = CF.classifyTickFileFor(B.ws, B.rk);
  fs.writeFileSync(tfB, "{ 깨진");
  assert.strictEqual(judgeHeld(B).reason, "baseline", "격리 후 처음");
  assert.ok(fs.readdirSync(path.dirname(tfB)).some((n) => n.startsWith(path.basename(tfB) + ".corrupt-")), "깨진 파일 격리 보존");
  // 짧은 읽기 — 연 파일에서 요청보다 적게 읽히면 판독 오류(첫 기준선을 빈 목록으로 확정하지 않음)
  const C = project("r3-short");
  round(C, "h0", 1, "pass", "2026-10-05T01:00:00.000Z");
  fs.writeFileSync(CL.campaignHistoryFileFor(C.ws), JSON.stringify({ schema: "vcamp-1", campaignId: "capd", count: 2, budget: 2, repoKey: C.rk, updatedAt: "2026-10-05T00:30:00.000Z" }) + "\n");
  const realReadSync = fs.readSync;
  const hist = CL.campaignHistoryFileFor(C.ws);
  let histFd = -1; const realOpen2 = fs.openSync;
  fs.openSync = function (f, ...rest) { const fd = realOpen2.call(fs, f, ...rest); if (String(f) === hist) histFd = fd; return fd; };
  fs.readSync = function (fd, ...rest) { if (fd === histFd) return 0; return realReadSync.call(fs, fd, ...rest); };
  let jc; try { jc = judgeHeld(C); } finally { fs.openSync = realOpen2; fs.readSync = realReadSync; }
  assert.strictEqual(jc.reason, "events-unreadable", "짧은 읽기=판독 오류");
  assert.ok(!CF.readClassifyTick(C.ws, C.rk).seeded, "기준선 미확정");
  say(C, "짧은 읽기 뒤 말입니다 기준 아님");
  // 경로로 잰 크기가 실제와 달라도(열기 직전 원자 교체) 연 파일 기준으로 읽어 정상 판정
  const realStat = fs.statSync;
  fs.statSync = function (f, ...rest) { const st = realStat.call(fs, f, ...rest); if (String(f) === hist) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size + 99989 }); return st; };
  let jd; try { jd = judgeHeld(C); } finally { fs.statSync = realStat; }
  assert.strictEqual(jd.reason, "baseline", "정상 판독 때 기준선(이미 소진된 캠페인 포함 · 경로 크기와 무관) " + JSON.stringify(jd));
  assert.strictEqual(judgeHeld(C).reason, "no-close", "기존 상한 마감으로 실행하지 않음");
});
t("반례 고정(검증 4회차): 형식 깨진 기억 파일을 훅·기본 판독은 옮기지 않음(잠금 유무 무관) · 격리는 잠금을 쥔 판정만", () => {
  const P = project("r4-hook");
  round(P, "q0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "훅 격리 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(P).reason, "baseline");
  const tf = CF.classifyTickFileFor(P.ws, P.rk);
  fs.writeFileSync(tf, "{ 깨진 기억");
  const corrupts = () => fs.readdirSync(path.dirname(tf)).filter((n) => n.startsWith(path.basename(tf) + ".corrupt-")).length;
  const n0 = corrupts();
  const spawnFn = () => ({ unref() {} });
  const other = CF.acquireClassifyLock(P.ws);
  try { CF.classifyHookTick(P.ws, null, { spawnFn, now: Date.now() + 30 * MIN }); } finally { CF.releaseClassifyLock(P.ws, other.token); }
  CF.classifyHookTick(P.ws, null, { spawnFn, now: Date.now() + 60 * MIN });
  const rd = CF.readClassifyTick(P.ws, P.rk);
  assert.ok(rd && rd.unreadable && rd.corrupt, "기본 판독=판독 전용 표시");
  assert.ok(fs.readFileSync(tf, "utf8") === "{ 깨진 기억" && corrupts() === n0, "훅·기본 판독은 파일을 옮기지 않음");
  assert.strictEqual(CF.markClassifyRan(P.ws, P.rk), false, "실행 시각 기록도 깨진 기억을 덮어쓰지 않음");
  assert.strictEqual(judgeHeld(P).reason, "baseline", "잠금 보유 판정만 격리 후 처음");
  assert.strictEqual(corrupts(), n0 + 1);
});
t("실행 기록 판독 오류는 '이력 없음'이 아님 — 최소 간격(10분)을 깨는 실행 없이 마감을 남겨 둔다", async () => {
  const P = project("runs-err");
  round(P, "g0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "실행 기록 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(P).reason, "baseline");
  await CF.runClassify(P.ws, { pageRunner: fakeRunner({ candidates: [] }) }); // 방금 실행(간격 안)
  say(P, "다음 말입니다 기준 아님");
  round(P, "g1", 1, "pass", "2026-10-05T02:00:00.000Z");
  const rf = CF.classifyFileFor(P.ws);
  const realRead = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) { if (String(f) === rf) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return realRead.call(fs, f, ...rest); };
  let j; try { j = judgeHeld(P); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(j.reason, "runs-unreadable", "간격 안 실행 없음");
  assert.strictEqual(judgeHeld(P).reason, "recent", "판독되면 최근 실행으로 대기");
  assert.ok(judgeHeld(P, { now: Date.now() + 11 * MIN }).spawn, "마감은 소비되지 않고 남아 간격 뒤 실행");
});
t("반례 고정(검증 5회차): 실행 기록의 최신 행이 쓰다 끊겨도 최소 간격(10분) 유지(파일 변경 시각 반영) · 다음 실행 행은 끊긴 줄과 합쳐지지 않음", async () => {
  const P = project("r5-trunc");
  round(P, "t0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "끊긴 실행 기록 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(P, { now: Date.now() - 60 * MIN }).reason, "baseline");
  let calls = 0;
  const pr = () => { calls++; return { promise: Promise.resolve({ ok: true, output: JSON.stringify({ candidates: [] }) }), cancel() {} }; };
  await CF.runClassify(P.ws, { pageRunner: pr }); // 수동 실행
  const rf = CF.classifyFileFor(P.ws);
  const raw = fs.readFileSync(rf, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  fs.writeFileSync(rf, lines.slice(0, -1).map((l) => l + "\n").join("") + lines[lines.length - 1].slice(0, 120)); // 최신 실행 행을 앞 120바이트만 남김(중단 모사)
  say(P, "새 말입니다 기준 아님");
  round(P, "t1", 1, "pass", "2026-10-05T02:00:00.000Z");
  const r1 = await CF.classifyTick(P.ws, { pageRunner: pr });
  assert.ok(r1.st === "no-run" && r1.judge.reason === "recent" && calls === 1, "끊긴 최신 행이어도 간격 안 실행 없음 " + JSON.stringify(r1.judge));
  const r2 = await CF.classifyTick(P.ws, { pageRunner: pr, now: Date.now() + 11 * MIN });
  assert.ok(r2.st === "ok" && calls === 2, "간격 뒤 실행(마감 보존) " + JSON.stringify(r2.judge));
  const runs = CF.readClassifyRows(P.ws).filter((r) => r.type === "run");
  assert.strictEqual(runs[runs.length - 1].trigger, "auto", "끊긴 줄 뒤 새 실행 행이 온전히 판독됨(꼬리 보호)");
});
t("본 마감 기억 상한(2,000) — 넘칠 때 지금 보이는 마감 열쇠는 버려지지 않음(되살아난 '새 마감'으로 다시 실행하지 않음)", () => {
  const P = project("seencap");
  round(P, "v0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "기억 상한 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(P).reason, "baseline");
  const st = CF.readClassifyTick(P.ws, P.rk);
  const vk = st.seenKeys[0];
  const old = Array.from({ length: 2000 }, (_, i) => "pass:gone-" + i + "::1:2026-01-01T00:00:00.000Z");
  assert.ok(CF.writeClassifyTick(P.ws, P.rk, Object.assign({}, st, { seenKeys: [vk, ...old] })), "보이는 열쇠가 가장 오래된 자리");
  round(P, "v1", 1, "pass", "2026-10-05T02:00:00.000Z");
  assert.ok(judgeHeld(P).spawn, "새 마감");
  const after = CF.readClassifyTick(P.ws, P.rk).seenKeys;
  assert.ok(after.length <= 2000 && after.includes(vk), "보이는 열쇠 유지");
  assert.strictEqual(judgeHeld(P, { now: Date.now() + 11 * MIN }).reason, "no-close", "되살아난 새 마감 없음");
});
t("상한 소진 마감도 계기 · 수칙서 승인 전(파일만 있음)=실행 없음(말 소모 없음)", () => {
  const P = project("cap");
  round(P, "x0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "상한 마감 시험용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(P).reason, "baseline");
  round(P, "x1", 2, "fail", "2026-10-05T02:00:00.000Z");
  fs.writeFileSync(CL.campaignFileFor(P.ws), JSON.stringify({ schema: "vcamp-1", campaignId: "x1", count: 2, budget: 2, repoKey: P.rk, updatedAt: "2026-10-05T02:00:00.000Z" }));
  const j = judgeHeld(P);
  assert.ok(j.spawn && j.kind === "cap", JSON.stringify(j));
  const Q = project("inact");
  fs.writeFileSync(path.join(Q.repo, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  assert.strictEqual(judgeHeld(Q).reason, "envelope-inactive");
});

t("하위 담당 보고 봉투(agent-message)는 사람의 말이 아님 — 직전 차례를 이어 새 원문·사용자 말 대기열·새 캠페인을 만들지 않음 · 같은 모양을 사람이 붙여 넣으면 발화(실측 2026-10-05)", () => {
  const env = '<agent-message from="abc123">\n[Subagent hand-back] 보고 본문 — 이 문장은 사용자 말이 아니다\n</agent-message>';
  const tx = path.join(mk("ca-am-tx-"), "t.jsonl");
  const human = (text) => JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: text }, timestamp: new Date().toISOString() });
  fs.writeFileSync(tx, human("앞선 사람의 말") + "\n" + JSON.stringify({ type: "attachment", attachment: { type: "queued_command", origin: { kind: "peer" } } }) + "\n");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: env, transcript_path: tx }), true, "보고 봉투=비-발화");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: env + "\n" + env, transcript_path: tx }), true, "여러 개도");
  fs.appendFileSync(tx, human(env) + "\n");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: env, transcript_path: tx }), false, "사람이 같은 글을 붙여 넣음=발화");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: "앞에 사람 글 " + env, transcript_path: tx }), false, "봉투만이 아니면 발화");
  // 실제 훅 실행 — 사람 차례 뒤 보고가 들어와도 같은 차례를 잇는다
  const P = project("am-hook");
  const SID = "ca-am-session-1";
  const tp = path.join(mk("ca-am-tp-"), SID + ".jsonl");
  fs.writeFileSync(tp, human("이번 차례 사람의 말입니다") + "\n");
  const envp = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SID });
  const run = (prompt, pid) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "contract-inject.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: P.ws, prompt, transcript_path: tp, permission_mode: "default", prompt_id: pid }), encoding: "utf8", env: envp, cwd: P.ws });
  assert.strictEqual(run("이번 차례 사람의 말입니다", "pid-am-1").status, 0);
  const act = () => JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, SID + ".json"), "utf8"));
  const a1 = act();
  assert.strictEqual(run(env, "pid-am-2").status, 0);
  const a2 = act();
  assert.ok(a2.ts === a1.ts && a2.constraintAnchor === a1.constraintAnchor, "직전 차례를 이음(캠페인·원문 결속 유지)");
  const words = [...UW.readUserWordsState(P.ws).words.values()].filter((w) => w.source === "prompt");
  assert.ok(words.length === 1 && UW.wordText(P.ws, words[0]) === "이번 차례 사람의 말입니다", "보고 원문은 사용자 말 대기열에 없음");
  assert.strictEqual(UW.readTurns(SID).length, 1, "보고는 차례 기록을 만들지 않음");
});
t("반례 고정(새 캠페인 1회차): 보고 봉투는 직전 앵커를 못 읽어도(판독 오류) 사람 말로 넘어가지 않고 앵커도 덮어쓰지 않음 · 직전 앵커가 없으면(세션 첫 입력) 원문 없는 앵커만", () => {
  const env = '<agent-message from="abc999">\n[Subagent hand-back] 보고 본문\n</agent-message>';
  const P = project("am-err");
  const run = (SID, prompt, pid, tp) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "contract-inject.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: P.ws, prompt, transcript_path: tp, permission_mode: "default", prompt_id: pid }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SID }), cwd: P.ws });
  const tpOf = (SID) => { const tp = path.join(mk("ca-am2-tp-"), SID + ".jsonl"); fs.writeFileSync(tp, JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: "앞선 사람 말" } }) + "\n"); return tp; };
  const snapCount = () => { try { return fs.readdirSync(CL.CONSTRAINT_TURNS_DIR).filter((n) => n.startsWith(CL.wsKeyFor(P.ws))).length; } catch { return 0; } };
  // 판독 오류: 세션 앵커 자리에 폴더
  const S1 = "ca-am-err-1";
  const af = path.join(CL.ACTIVE_DIR, S1 + ".json");
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(af, "{ 깨진 앵커"); // 읽기(형식)는 실패하고 쓰기는 가능한 상태
  const s0 = snapCount();
  const r1 = run(S1, env, "pid-e1", tpOf(S1));
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.strictEqual(fs.readFileSync(af, "utf8"), "{ 깨진 앵커", "못 읽은 앵커를 새 시각으로 덮어쓰지 않음");
  assert.strictEqual(snapCount(), s0, "원문 스냅샷 없음");
  assert.strictEqual(UW.readTurns(S1).length, 0, "차례 기록 없음");
  assert.strictEqual([...UW.readUserWordsState(P.ws).words.values()].length, 0, "대기열 없음");
  fs.rmSync(af, { force: true });
  // [2회차 반례] JSON 문법은 맞지만 올바른 앵커가 아님 — 세션별·전역 앵커 둘 다 그대로(새 시각으로 덮지 않음) · 다음 사람 입력은 새 앵커로 회복
  const gf = path.join(HOME, "active.json");
  const badAnchors = {
    "null": "null",
    "숫자": "42",
    "배열": "[]",
    "시각 없음": JSON.stringify({ claudeSession: S1, workspace: P.ws }),
    "시각 오류": JSON.stringify({ claudeSession: S1, workspace: P.ws, ts: "언제인지 모름" }),
    "시각이 문자열 아님": JSON.stringify({ claudeSession: S1, workspace: P.ws, ts: 12345 }),
    "다른 세션": JSON.stringify({ claudeSession: "ca-other-session", workspace: P.ws, ts: "2026-10-05T01:00:00.000Z" }),
  };
  for (const [label, body] of Object.entries(badAnchors)) {
    fs.writeFileSync(af, body);
    const gBody = JSON.stringify({ marker: "전역 앵커 보존 확인 " + label, ts: "2026-10-05T00:00:00.000Z" });
    fs.writeFileSync(gf, gBody);
    const rb = run(S1, env, "pid-b-" + label, tpOf(S1));
    assert.strictEqual(rb.status, 0, label + ": " + rb.stderr);
    assert.strictEqual(fs.readFileSync(af, "utf8"), body, label + ": 세션별 앵커를 덮어쓰지 않음");
    assert.strictEqual(fs.readFileSync(gf, "utf8"), gBody, label + ": 전역 앵커를 덮어쓰지 않음");
    assert.ok(/anchor left as is/.test(rb.stderr), label + ": 보류 사유를 드러냄");
    assert.strictEqual(snapCount(), s0, label + ": 원문 스냅샷 없음");
    assert.strictEqual(UW.readTurns(S1).length, 0, label + ": 차례 기록 없음");
    assert.strictEqual([...UW.readUserWordsState(P.ws).words.values()].length, 0, label + ": 대기열 없음");
  }
  // 못 읽는 앵커 상태가 사람 입력까지 이어지면 사람 입력은 종전대로 새 앵커를 쓴다(앵커를 영구히 막지 않음)
  const rh = run(S1, "보류 뒤 사람의 말입니다", "pid-h-1", tpOf(S1));
  assert.strictEqual(rh.status, 0, rh.stderr);
  const ah = JSON.parse(fs.readFileSync(af, "utf8"));
  assert.ok(ah.claudeSession === S1 && Number.isFinite(Date.parse(ah.ts)) && ah.constraintAnchor, "사람 입력이 앵커를 회복");
  assert.strictEqual(JSON.parse(fs.readFileSync(gf, "utf8")).claudeSession, S1, "전역 앵커도 회복");
  assert.strictEqual(UW.readTurns(S1).length, 1, "사람 입력은 차례 기록");
  // 회복 뒤 보고는 정상 승계
  const rc = run(S1, env, "pid-c-1", tpOf(S1));
  assert.strictEqual(rc.status, 0, rc.stderr);
  const ac = JSON.parse(fs.readFileSync(af, "utf8"));
  assert.ok(ac.ts === ah.ts && ac.constraintAnchor === ah.constraintAnchor, "회복된 앵커를 이음");
  fs.rmSync(af, { force: true });
  const w0 = [...UW.readUserWordsState(P.ws).words.values()].length, s1 = snapCount();
  // 직전 앵커 없음(세션 첫 입력이 보고) — 원문 없는 앵커만
  const S2 = "ca-am-first-1";
  const r2 = run(S2, env, "pid-f1", tpOf(S2));
  assert.strictEqual(r2.status, 0, r2.stderr);
  const a2 = JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, S2 + ".json"), "utf8"));
  assert.ok(a2.ts && !a2.constraintAnchor, "앵커는 있되 원문 결속 없음(약속 상신 불가)");
  assert.strictEqual(snapCount(), s1, "원문 스냅샷 없음");
  assert.ok(UW.readTurns(S2).length === 0 && [...UW.readUserWordsState(P.ws).words.values()].length === w0, "차례 기록·대기열 없음");
});
t("반례 고정(새 캠페인 1회차): 실행 기록 파일이 있지만 비어 있어도(만든 직후 끊김) 최소 간격 유지", () => {
  const P = project("runs-empty");
  round(P, "z0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, "빈 실행 기록 반례용 말입니다 기준 아님");
  assert.strictEqual(judgeHeld(P).reason, "baseline");
  fs.mkdirSync(path.dirname(CF.classifyFileFor(P.ws)), { recursive: true });
  fs.writeFileSync(CF.classifyFileFor(P.ws), ""); // 방금 만들어진 빈 실행 기록
  round(P, "z1", 1, "pass", "2026-10-05T02:00:00.000Z");
  assert.strictEqual(judgeHeld(P).reason, "recent", "빈 파일의 변경 시각도 최근 실행");
  assert.ok(judgeHeld(P, { now: Date.now() + 11 * MIN }).spawn, "간격 뒤 실행(마감 보존)");
});
sec("[3] 훅 층 — 간격·잠금만 보고 자식 띄우기");
t("간격(10분) 지나면 classify tick 을 detach(띄우기 전에 판정 시각 기록) · 간격 안=안 띄움 · 실행 중 잠금=안 띄움 · 0세대도 대상 · 승인 전 파일=안 띄움", () => {
  const P = project("hook");
  const calls = [];
  const spawnFn = (exe, args, o) => { calls.push({ exe, args, o }); return { unref() {} }; };
  assert.strictEqual(CF.classifyHookTick(P.ws, null, { spawnFn }), null);
  assert.ok(calls.length === 1 && calls[0].args.slice(-2).join(" ") === "classify tick" && calls[0].o.detached === true && calls[0].o.env.CLAUDE_PROJECT_DIR === P.ws, JSON.stringify(calls[0] && calls[0].args));
  assert.ok(CF.readHookStamp(P.ws, P.rk).spawnedAt, "띄우기 전에 띄운 시각(훅 전용 파일)");
  assert.strictEqual(CF.readClassifyTick(P.ws, P.rk), null, "훅은 판정 상태(본 마감 목록)를 쓰지 않음 — 자식 기록과 덮어쓰기 경합 없음");
  CF.classifyHookTick(P.ws, null, { spawnFn });
  assert.strictEqual(calls.length, 1, "간격 안=안 띄움");
  const lk = CF.acquireClassifyLock(P.ws);
  CF.classifyHookTick(P.ws, null, { spawnFn, now: Date.now() + 11 * MIN });
  assert.strictEqual(calls.length, 1, "잠금=안 띄움");
  CF.releaseClassifyLock(P.ws, lk.token);
  CF.classifyHookTick(P.ws, null, { spawnFn, now: Date.now() + 11 * MIN });
  assert.strictEqual(calls.length, 2, "간격 지남=다시 띄움");
  const Q = project("hookinact");
  fs.writeFileSync(path.join(Q.repo, CL.ENVELOPE_FILE), CL.GEN0_TEXT);
  CF.classifyHookTick(Q.ws, null, { spawnFn });
  assert.strictEqual(calls.length, 2, "승인 전 파일=안 띄움");
});
t("명령줄 classify tick — 기준선 뒤 새 마감이면 자동 실행(trigger auto)·실행 시각 기록 · 마감 없으면 no-run", () => {
  const P = project("clitick");
  const Q1 = "명령줄 자동 계기 시험 문장은 언제나 지켜야 하는 규칙입니다";
  round(P, "k0", 1, "pass", "2026-10-05T01:00:00.000Z");
  say(P, Q1);
  const fakeMod = path.join(HOME, "fake-auto-runner.js");
  fs.writeFileSync(fakeMod, "module.exports = { runSelectorPage: ({ prompt }) => { const f = prompt.indexOf('<<u1 '); const i = prompt.indexOf(" + JSON.stringify(Q1) + ", f); const h = prompt.lastIndexOf('<<u', i); const ref = prompt.slice(h + 2, prompt.indexOf(' ', h)); return { promise: Promise.resolve({ ok: true, output: JSON.stringify({ candidates: [{ ref, seat: 'alwaysBlocker', quote: " + JSON.stringify(Q1) + ", why: '프로젝트 내내 지킬 규칙' }] }) }), cancel() {} }; } };");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CODEX_BRIDGE_SELECTOR_RUNNER: fakeMod });
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const tick = () => JSON.parse(cp.spawnSync(process.execPath, [cli, "classify", "tick", "--json"], { env, encoding: "utf8", cwd: P.ws }).stdout.trim().split(/\r?\n/).pop());
  const a = tick();
  assert.ok(a.st === "no-run" && a.judge.reason === "baseline", JSON.stringify(a));
  round(P, "k1", 1, "pass", "2026-10-05T02:00:00.000Z");
  const b = tick();
  assert.ok(b.st === "ok" && b.judge.spawn && b.envIds.length === 1, JSON.stringify(b));
  const runs = CF.readClassifyRows(P.ws).filter((r) => r.type === "run");
  assert.strictEqual(runs[runs.length - 1].trigger, "auto");
  assert.ok(CF.readClassifyTick(P.ws, P.rk).ranAt, "실행 시각");
  const c = tick();
  assert.ok(c.st === "no-run", "같은 마감 다시 없음 " + JSON.stringify(c));
});

sec("[4] 확인 대기 1줄(§3-7) — 그 상태에 세션당 1회 · 사실 한 줄");
t("대기 0=침묵 · 대기 생기면 1회 · 같은 상태=침묵 · 목록 바뀌면 다시 · 다른 세션=1회 · 지시문 아님", async () => {
  const P = project("notice");
  assert.strictEqual(CF.pendingNoticeFor(P.ws, null, "sess-1", "ko"), null);
  const A = "알림 시험용 첫 번째 지속 기준 문장입니다";
  say(P, A);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ candidates: [{ ref: refOf(p, A), seat: "outOfScope", quote: A, why: "프로젝트 내내 지킬 판정 기준" }] })) });
  assert.strictEqual(r.envIds.length, 1);
  const n1 = CF.pendingNoticeFor(P.ws, null, "sess-1", "ko");
  assert.ok(n1 && n1.includes("1건") && n1.startsWith("[사용자 확인 대기]"), n1);
  assert.ok(!/하라|해라|하세요|올려/.test(n1), "지시문 아님(R1)");
  assert.strictEqual(CF.pendingNoticeFor(P.ws, null, "sess-1", "ko"), null, "같은 상태=침묵");
  assert.ok(CF.pendingNoticeFor(P.ws, null, "sess-2", "en").includes("1 standard"), "다른 세션=1회");
  const B = "알림 시험용 두 번째 판정 기준 문장입니다 계속 지켜요";
  say(P, B);
  const r2 = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ candidates: [{ ref: refOf(p, B), seat: "alwaysBlocker", quote: B, why: "프로젝트 내내 지킬 판정 기준" }] })) });
  assert.strictEqual(r2.envIds.length, 1);
  assert.ok(CF.pendingNoticeFor(P.ws, null, "sess-1", "ko").includes("2건"), "목록 바뀜=다시");
  // [RULE-SUPPLY-CORRECTION 묶음 1] 옛 자리 장부의 대기 제안은 승인 길이 없어 세지 않는다
  fs.mkdirSync(CF.CLASSIFY_DIR, { recursive: true });
  fs.writeFileSync(CF.seatsFileFor(P.ws), JSON.stringify({ schema: "user-seat-v1", wsKey: CL.wsKeyFor(P.ws), candidateId: "f".repeat(16), status: "proposed", seat: "rule", repoKey: P.rk, provider: "claude", quote: "옛 규칙 칸 대기 제안 문장입니다", why: "옛 제안", ts: "2026-10-05T00:00:00.000Z" }) + "\n");
  assert.deepStrictEqual(CF.pendingUserWordIds(P.ws).length, 2, "옛 대기 제안 미합산");
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [r.envIds[0], r2.envIds[0]].map((id) => ({ candidateId: id, envelopeHash: CL.GEN0_HASH, status: "declined", by: "user", ts: new Date().toISOString() }))));
  assert.strictEqual(CF.pendingNoticeFor(P.ws, null, "sess-1", "ko"), null, "다 처리=침묵");
});
t("입력 제출 훅(실제 실행)이 확인 대기 1줄을 싣고 같은 상태의 다음 차례에는 안 싣는다", async () => {
  const P = project("hookline");
  const A = "훅 결선 시험용 지속 기준 문장입니다 계속 지켜요";
  say(P, A);
  await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ candidates: [{ ref: refOf(p, A), seat: "alwaysBlocker", quote: A, why: "프로젝트 내내 지킬 판정 기준" }] })) });
  const SID = "ca-hook-session-1";
  const tp = path.join(mk("ca-tx-"), SID + ".jsonl"); fs.writeFileSync(tp, "");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SID });
  const run = (prompt) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "contract-inject.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: P.ws, prompt, transcript_path: tp, permission_mode: "default", prompt_id: "pid-" + (++seq) }), encoding: "utf8", env, cwd: P.ws });
  const o1 = run("첫 차례 요청입니다");
  assert.strictEqual(o1.status, 0, o1.stderr);
  assert.ok(o1.stdout.includes("[사용자 확인 대기]"), "첫 차례에 1줄");
  const o2 = run("둘째 차례 요청입니다");
  assert.ok(o2.status === 0 && !o2.stdout.includes("[사용자 확인 대기]"), "같은 상태=다음 차례 침묵");
});

sec("[5] 분류하지 못한 말 — 다시 분류·버리기");
t("다시 분류=대기열로(재시도 0) · 출처 불명 말은 다시 분류 불가(버리기만) · 버리기=분류 대상 제외 · 보류 아닌 말=거부 · 화면 자료(원문 일부·다시 분류 가능 표시)", async () => {
  const P = project("held");
  const a = say(P, "세 번 실패할 말입니다 기준 아님");
  for (let i = 0; i < CF.CLASSIFY_RETRY_MAX; i++) await CF.runClassify(P.ws, { pageRunner: () => ({ promise: Promise.resolve({ ok: false, key: "call-failed" }), cancel() {} }) });
  assert.strictEqual(UW.heldWords(P.ws, P.rk)[0].heldReason, "classify-failed");
  const u = UW.recordWord(P.ws, { id: "c-" + "9".repeat(16), source: "choice", turnAnchor: "", repoKey: "", textHash: sha1("출처 모름 말"), len: 6, ts: new Date().toISOString() }, "출처 모름 말");
  assert.ok(u.ok && u.held);
  const v = CF.userWordsView(P.ws);
  assert.ok(v.held.length === 2 && v.held.find((w) => w.id === a.id).canRequeue === true && v.held.find((w) => w.id === "c-" + "9".repeat(16)).canRequeue === false, JSON.stringify(v.held));
  assert.ok(v.held.find((w) => w.id === a.id).text.includes("세 번 실패할 말"), "원문 일부");
  assert.strictEqual(CF.heldWordAction(P.ws, "c-" + "9".repeat(16), "requeue").reason, "origin-unknown");
  assert.ok(CF.heldWordAction(P.ws, a.id, "requeue").ok);
  const q = UW.queuedWords(P.ws, P.rk);
  assert.ok(q.length === 1 && q[0].id === a.id && q[0].retries === 0, "대기열로·재시도 0");
  assert.strictEqual(CF.heldWordAction(P.ws, a.id, "dismiss").reason, "not-held");
  assert.ok(CF.heldWordAction(P.ws, "c-" + "9".repeat(16), "dismiss").ok);
  assert.strictEqual(UW.heldWords(P.ws, P.rk, { unknown: true }).length, 0);
});

sec("[6] D3 — 지원 환경·범위 밖 짧은 목록(정적 전달 전용)");
t("승인 수칙서의 sup-N·oos-N 짧은 목록(60자)은 정적 전달(세션 1회)에만 · 매 턴 경로(ab)는 종전 그대로 · 칸이 비면 줄 없음", () => {
  const P = project("d3");
  const long = "외부 서버와 연동하는 기능의 오류는 이번 프로젝트 단계에서 다루지 않으므로 결함으로 보지 않는다 — 긴 설명 덧붙임";
  const raw = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: ["사용자 본인 폰 한 대"], alwaysBlocker: ["원래 설정을 되돌리지 않으면 결함"], outOfScope: [long, "최신폰 실기기 확인"] });
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), raw);
  CL.setEnvelopeHashAllSlots(P.ws, sha1(raw));
  const c = CL.loadContract(P.ws, "ko");
  const ep = CL.implementerEnvelopeInjectParts(P.ws, c, "ko", "", "");
  assert.ok(ep.ab.includes("> ab-1:") && !ep.ab.includes("sup-1") && !ep.ab.includes("oos-1"), "ab=종전");
  assert.ok(ep.scope.includes("> sup-1: 사용자 본인 폰 한 대") && ep.scope.includes("> oos-2: 최신폰 실기기 확인") && ep.scope.includes("> oos-1: " + long.slice(0, 60) + "…"), ep.scope);
  assert.ok(!/하라|해라/.test(ep.scope), "데이터(지시문 아님)");
  const sp = CL.claudeStaticParts(P.ws, c, "ko", {});
  assert.ok(sp.envelopeAb.includes(ep.ab) && sp.envelopeAb.includes(ep.scope), "정적 전달=ab+짧은 목록");
  assert.ok(!CL.implementerEnvelopeInject(P.ws, c, "ko", "", "").includes("oos-1"), "매 턴 경로=짧은 목록 없음");
  const Q = project("d3e");
  const raw2 = CL.serializeEnvelopeCore({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: ["a"], outOfScope: [] });
  fs.writeFileSync(path.join(Q.repo, CL.ENVELOPE_FILE), raw2);
  CL.setEnvelopeHashAllSlots(Q.ws, sha1(raw2));
  assert.strictEqual(CL.implementerEnvelopeInjectParts(Q.ws, CL.loadContract(Q.ws, "ko"), "ko", "", "").scope, "", "칸이 비면 줄 없음");
});

sec("[7] 대시보드 — 개요 합산·한꺼번에 올리기 칸 전달·카드 결선(컴파일 산출물)");
t("개요 '지금 정할 것'에 옛 규칙·결정 제안이 합류하지 않음(순수 함수 실행) · 한꺼번에 올리기 계획에 칸 전달 · 옛 제안 처리기 없음·남은 처리기·카드 결선", () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b3 = outSrc.indexOf("function decideActs(d){"), e3 = outSrc.indexOf("function renderOverview(d){", b3);
  const acts = new Function("var T=function(a,b){return a;};\n" + outSrc.slice(b3, e3) + "\nreturn decideActs;")();
  const a = acts({ userWords: { seats: [{ id: "x" }, { id: "y" }], held: [] } }); // 옛 실행본이 남긴 모양의 자료가 와도
  assert.strictEqual(a.length, 0, "옛 제안은 '지금 정할 것'에 없음 " + JSON.stringify(a));
  assert.strictEqual(acts({ userWords: null }).length, 0);
  assert.ok(outSrc.includes("operation: c.operation, axis: c.axis })"), "한꺼번에 올리기 계획에 칸 전달");
  for (const k of ['m?.type === "heldMark"', 'CFH.heldWordAction(wsH, m.id, m.action)', 'id="uwCard"', "userWordsView(ws)"]) assert.ok(outSrc.includes(k), "결선: " + k);
  for (const k of ['m?.type === "seatMark"', "approveSeatCandidate", "declineSeatCandidate", "data-seats-box"]) assert.ok(!outSrc.includes(k), "옛 제안 승인 길 없음: " + k);
});

t("사용자 말 카드 그리기 조각(컴파일 산출물)을 가짜 화면 요소로 실제 실행 — 옛 제안 행·승인 버튼 없음 · 분류하지 못한 말(다시 분류는 이 프로젝트 말만)·버튼이 보내는 메시지", () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf('safe(function(){ var uc=$("uwCard");'), e = outSrc.indexOf('safe(function(){ var n=$("vBudgetNote");', b);
  assert.ok(b > 0 && e > b, "조각 추출");
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, remove() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const run = (d) => {
    const uc = mkEl("div"); const sent = [];
    new Function("document", "$", "T", "d", "vscode", "safe", outSrc.slice(b, e))({ createElement: mkEl }, (id) => (id === "uwCard" ? uc : null), (a) => a, d, { postMessage: (m) => sent.push(m) }, (f) => f());
    const all = []; const walk = (x) => { all.push(x); (x.children || []).forEach(walk); }; walk(uc);
    return { uc, all, sent, text: all.map((x) => x.textContent).join(" | ") };
  };
  const hidden = run({ userWords: null });
  assert.strictEqual(hidden.uc.style.display, "none", "자료 없음=숨김");
  const empty = run({ userWords: { wsKey: "w", repoKey: "r", summary: { queued: 0, lastTs: "" }, held: [] } });
  assert.strictEqual(empty.uc.style.display, "none", "정상 빈 목록=숨김");
  const legacyOnly = run({ userWords: { wsKey: "w", repoKey: "r", summary: { queued: 0, lastTs: "" }, seats: [{ id: "a".repeat(16), seat: "rule", quote: "옛 제안", why: "", provider: "claude", ts: "" }], held: [] } });
  assert.strictEqual(legacyOnly.uc.style.display, "none", "옛 실행본 자료의 제안만 있으면 카드 숨김(제안 행 없음)");
  const err = run({ userWords: { wsKey: "w", repoKey: "r", summary: { queued: null, lastTs: "" }, held: null } });
  assert.ok(err.uc.style.display === "block" && err.text.includes("처리할 것이 없다는 뜻이 아니에요"), "판독 실패=숨기지 않고 알림(검증 1회차 주의)");
  const d = { userWords: { wsKey: "wk1", repoKey: "rk", summary: { queued: 3, lastTs: "2026-10-05T01:02:00.000Z", lastOutcome: "failed", lastReason: "timeout" },
    seats: [{ id: "a".repeat(16), seat: "rule", quote: "설명은 상황 예시로", why: "소통 방식", provider: "codex", ts: "2026-10-05T00:00:00.000Z" }], // 옛 실행본 모양 — 무시돼야 함
    held: [{ id: "p-" + "c".repeat(16), source: "prompt", reason: "classify-failed", ts: "", text: "원문 일부", canRequeue: true }, { id: "c-" + "d".repeat(16), source: "choice", reason: "repo-unknown", ts: "", text: "", canRequeue: false }] } };
  const r = run(d);
  assert.strictEqual(r.uc.style.display, "block");
  assert.ok(r.text.includes("사용자 말 분류") && r.text.includes("살펴볼 말 3건") && r.text.includes("실패 — 말은 남아 있어 다시 시도(timeout)"), "요약 줄");
  assert.ok(!r.text.includes("어디로:") && !r.text.includes("설명은 상황 예시로") && r.text.includes("구현 담당 규칙 칸에 직접 적어 주세요") && !r.text.includes("Claude 규칙 칸"), "옛 제안 행 없음·규칙 칸은 사용자가 직접(구현 담당 회사와 무관한 안내 — 검증 보완)");
  assert.ok(r.text.includes("분류하지 못한 사용자 말 2건") && r.text.includes("분류 담당이 세 번 실패했어요") && r.text.includes("어느 프로젝트의 말인지 확인하지 못했어요"), "보류 사유");
  const btn = r.all.filter((x) => x.tag === "button");
  assert.strictEqual(btn.filter((x) => x.textContent === "승인" || x.textContent === "안 올림").length, 0, "승인·안 올림 버튼 없음");
  assert.strictEqual(btn.filter((x) => x.textContent === "다시 분류").length, 1, "출처 불명 말엔 다시 분류 없음");
  btn.find((x) => x.textContent === "다시 분류").onclick();
  btn.filter((x) => x.textContent === "버리기")[1].onclick();
  assert.deepStrictEqual(r.sent.map((m) => m.type + ":" + m.action + ":" + m.wsKey), ["heldMark:requeue:wk1", "heldMark:dismiss:wk1"]);
  assert.strictEqual(r.all.filter((x) => x.attrs && x.attrs["data-seats-box"]).length, 0, "옛 개요 이동 앵커 없음");
});

t("'수칙' 카드 그리기 조각 실제 실행 — 분류 담당이 고른 범위 밖 후보: 칸 이름·어디로 줄·버튼 하나(본문) · 0세대·승인 세대 모두 · 칸 없는 후보=종전 버튼", () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf('safe(function(){ var ec=$("envCard");'), e = outSrc.indexOf('safe(function(){ var uc=$("uwCard");', b);
  assert.ok(b > 0 && e > b, "조각 추출");
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, addEventListener() {}, querySelectorAll() { return []; }, remove() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const run = (e9) => {
    const ec = mkEl("div"); const sent = [];
    const body = "var wbGen='', wbAdds=new Set(), wbRemoves=new Set(), candsMoreOpenWeb=false, signalsOpenWeb=false, rulesOpenWeb=false;\n" + outSrc.slice(b, e);
    new Function("document", "$", "T", "d", "vscode", "safe", body)({ createElement: mkEl }, (id) => (id === "envCard" ? ec : null), (a) => a, { envelope: e9, lang: "ko" }, { postMessage: (m) => sent.push(m) }, (f) => f());
    const all = []; const walk = (x) => { all.push(x); (x.children || []).forEach(walk); }; walk(ec);
    return { all, sent, text: all.map((x) => x.textContent).join(" | ") };
  };
  const cand = (over) => Object.assign({ id: "e".repeat(16), kind: "user-constraint", n: 1, title: "최신폰 실기기 확인은 범위 밖", status: "proposed", gen: "g", wsKey: "wk", ts: "2026-10-05T00:00:00.000Z", why: "단계 범위", axis: "outOfScope", origin: "classifier", quoteSource: "prompt" }, over || {});
  for (const gen0 of [true, false]) {
    const r = run({ label: "x", gen: "g", wsKey: "wk", lang: "ko", gen0, cands: [cand()] });
    assert.ok(r.text.includes("분류 담당이 골랐어요 — 수칙서 '범위 밖' 칸") && r.text.includes("어디로: 수칙서 본문 '범위 밖' 칸"), "칸·어디로 " + gen0);
    const ap = r.all.filter((x) => x.tag === "button" && /^승인/.test(x.textContent));
    assert.ok(ap.length === 1 && ap[0].textContent === "승인 — 수칙서 본문(항상)", "버튼 하나 " + gen0 + " " + ap.map((x) => x.textContent));
    ap[0].onclick();
    assert.ok(r.sent.length === 1 && r.sent[0].type === "candMark" && r.sent[0].dest === "core", JSON.stringify(r.sent));
  }
  const rab0 = run({ label: "x", gen: "g", wsKey: "wk", lang: "ko", gen0: true, cands: [cand({ axis: "alwaysBlocker" })] });
  assert.ok(rab0.text.includes("어디로: 수칙서 '항상 막을 것' 칸") && rab0.all.filter((x) => x.tag === "button" && /^승인/.test(x.textContent)).length === 2, "0세대 항상 막을 것=전달처+두 버튼(검증 1회차 보완)");
  const rab1 = run({ label: "x", gen: "g", wsKey: "wk", lang: "ko", gen0: false, cands: [cand({ axis: "alwaysBlocker" })] });
  assert.ok(rab1.text.includes("어디로: 수칙서 '관련될 때' 목록"), "승인 세대 항상 막을 것=관련될 때 목록");
  const r0 = run({ label: "x", gen: "g", wsKey: "wk", lang: "ko", gen0: true, cands: [cand({ axis: "", origin: "" })] });
  assert.ok(r0.text.includes("대화에서 직접 말씀하신 약속이에요") && r0.all.filter((x) => x.tag === "button" && /^승인/.test(x.textContent)).length === 2, "칸 없는 후보=종전(0세대 두 버튼)");
});

(async () => {
  for (const [name, fn] of pending) { if (name === null) { console.log(fn); continue; } n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.filter((x) => x[0] !== null).length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
