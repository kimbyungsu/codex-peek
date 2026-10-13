"use strict";
/*
 * [RULE-SUPPLY-CORRECTION ⑤ 2단계-나 — 2026-10-11] 분류 결과 전달(§2 B · §3-1 2·6·7).
 *  ① 넘길 목록: 판정 경계·같은 저장소·같은 회사(R3)·미판단만 · 한 차례 한 번 · 한 차례 상한(나머지는 새 결과로 남음)
 *  ② 전달 2회: 미판단이면 다음 사람의 차례에 한 번 더 · 2회째에도 미판단=종결 '구현 담당 미처리'(더 안 넘김 · 안 올림 아님)
 *  ③ 원문 만료=종결 '원문 만료'(안 넘김) · 만료 전 원문 판독 실패=읽기 보류(상태 그대로 · 복구되면 넘김)
 *  ④ 전달 블록 문구(자료+명령 한 줄 · 대화 나열 금지 표기)
 *  ⑤ 실제 훅 실행 — Claude(사람의 차례만 · 알림 차례 제외)·Codex(하위 담당 완료 알림 제외 · 대기열도 제외) · 전달 기록은 출력 뒤
 * 격리: 임시 CODEX_BRIDGE_HOME. 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cdeliver-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let seq = 0;
function project(tag) {
  const ws = mk("cd-ws-" + tag + "-"), repo = mk("cd-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  return { ws, repo, rk: CL.repoKeyOf(repo), H: CL.GEN0_HASH };
}
function say(P, text, provider) {
  const anc = CL.turnAnchorOf("cd-s", new Date(Date.UTC(2026, 9, 11, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  const r = UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "cd-s", repoKey: P.rk, provider: provider || "claude" });
  assert.ok(r.ok && !r.held, JSON.stringify(r));
  return anc;
}
const turnOf = (provider) => ({ turnAnchor: "turn-" + (++seq), repoKey: null, provider: provider || "claude", sessionId: "cd-now" });
function fakeRunner(answer) { return ({ prompt }) => ({ promise: Promise.resolve({ ok: true, output: JSON.stringify(typeof answer === "function" ? answer(prompt) : answer) }), cancel() {} }); }
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); };
// 분류 실행 1회 — 결과 여러 개(같은 실행=같은 회사)
async function classify(P, entries, provider) {
  for (const e of entries) say(P, e.quote, provider);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: entries.map((e) => ({ ref: refOf(p, e.quote), kind: e.kind || "boundary", seat: e.kind && e.kind !== "boundary" ? undefined : (e.seat || "outOfScope"), quote: e.quote, why: "프로젝트 내내 지킬 판정 기준", ...(e.kind && e.kind !== "boundary" ? (e.kind === "emphasis" ? { itemRef: "B1" } : {}) : { bounds: "이 기준으로 결함 여부를 판정한다" }) })) })) });
  assert.ok(r.st === "ok", JSON.stringify(r));
  return r.resultIds.map((id) => CF.readClassifyResults(P.ws).latest.get(id));
}
const ctxFor = (P, provider) => Object.assign(turnOf(provider), { repoKey: P.rk, ok: true });
const status = (P, id) => CF.readClassifyResults(P.ws).latest.get(id).status;
const deliveredIds = (pl) => (pl ? pl.deliver.map((r) => r.resultId).sort() : null);

t("① 넘길 목록 — 판정 경계·같은 저장소·같은 회사·미판단만 · 계획만으로는 전달 기록 없음 · 안 올림 판단한 결과 제외", async () => {
  const P = project("basic");
  const [a, b] = await classify(P, [{ quote: "실기기 최신폰 확인은 이번 단계 범위 밖으로 계속 본다" }, { quote: "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다", seat: "outOfScope" }]);
  const [x] = await classify(P, [{ quote: "Codex 쪽에서 한 말 기준은 이렇게 간다고 했어요" }], "codex");
  const c1 = ctxFor(P, "claude");
  const pl = CF.planDelivery(P.ws, c1);
  assert.deepStrictEqual(deliveredIds(pl), [a.resultId, b.resultId].sort(), "Claude 결과만(Codex 결과 제외)");
  assert.strictEqual(status(P, a.resultId), "new", "계획만으로는 전달 기록 없음");
  assert.deepStrictEqual(deliveredIds(CF.planDelivery(P.ws, ctxFor(P, "codex"))), [x.resultId], "Codex 결과는 Codex 구현 담당에게만");
  const other = Object.assign(ctxFor(P, "claude"), { repoKey: "f".repeat(16) });
  assert.strictEqual(CF.planDelivery(P.ws, other).deliver.length, 0, "다른 저장소=안 넘김");
  assert.strictEqual(CF.planDelivery(P.ws, Object.assign(ctxFor(P, "claude"), { repoKey: "" })).deliver.length, 0, "저장소 표식 없음=안 넘김");
  // 안 올림으로 판단한 결과는 다음 차례에 안 넘김
  CF.markResultsDelivered(P.ws, pl.deliver, c1);
  assert.ok(CF.skipResult(P.ws, b.resultId, "같은 뜻 수칙이 이미 있어서 안 올림", c1).ok);
  assert.deepStrictEqual(deliveredIds(CF.planDelivery(P.ws, ctxFor(P, "claude"))), [a.resultId], "판단한 결과 제외");
  const [e] = await classify(P, [{ quote: "보고 형식은 항상 표로 정리해 달라고 했다", kind: "style" }]);
  assert.ok(!CF.planDelivery(P.ws, ctxFor(P, "claude")).deliver.some((r) => r.resultId === e.resultId), "판정 경계가 아닌 결과 제외");
});

t("② 전달 2회 — 같은 차례 재전달 없음 · 다음 사람의 차례에 한 번 더 · 2회째에도 미판단=구현 담당 미처리(종결 · 안 올림 아님 · 더 안 넘김)", async () => {
  const P = project("twice");
  const [a] = await classify(P, [{ quote: "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 한다고 했어" }]);
  const t1 = ctxFor(P, "claude");
  const p1 = CF.planDelivery(P.ws, t1);
  assert.ok(p1.deliver.length === 1 && p1.deliver[0].deliveries === 0);
  assert.ok(CF.markResultsDelivered(P.ws, p1.deliver, t1));
  assert.ok(status(P, a.resultId) === "delivered" && CF.readClassifyResults(P.ws).latest.get(a.resultId).deliveries === 1);
  assert.strictEqual(CF.planDelivery(P.ws, t1).deliver.length, 0, "★같은 차례에 되풀이하지 않음");
  const t2 = ctxFor(P, "claude");
  const p2 = CF.planDelivery(P.ws, t2);
  assert.ok(p2.deliver.length === 1 && p2.deliver[0].deliveries === 1, "다음 사람의 차례에 한 번 더(2회째)");
  CF.markResultsDelivered(P.ws, p2.deliver, t2);
  assert.strictEqual(CF.readClassifyResults(P.ws).latest.get(a.resultId).deliveries, 2);
  const t3 = ctxFor(P, "claude");
  const p3 = CF.planDelivery(P.ws, t3);
  assert.ok(p3.deliver.length === 0 && p3.transitions === 1, JSON.stringify(p3));
  assert.strictEqual(status(P, a.resultId), "unhandled", "★2회째에도 미판단=구현 담당 미처리");
  assert.strictEqual(CF.planDelivery(P.ws, ctxFor(P, "claude")).deliver.length, 0, "종결 뒤 더 안 넘김");
  assert.strictEqual(CF.classifySummary(P.ws).boundaryStatus.unhandled, 1, "화면 요약 '구현 담당 미처리'");
  assert.strictEqual(CF.skipResult(P.ws, a.resultId, "미처리 뒤 안 올림 시도는 거부되어야", t3).reason, "not-delivered", "미처리는 판단 대상 아님");
});

t("③ 원문 만료=종결 '원문 만료'(안 넘김) · 만료 전 판독 실패=읽기 보류(상태 그대로) → 복구되면 넘김", async () => {
  const P = project("expire");
  const [a] = await classify(P, [{ quote: "검증 범위는 사용자 본인 폰 한 대 기준으로만 본다고 했어" }]);
  const w = UW.readUserWordsState(P.ws).words.get(a.wordId);
  const snapF = CL.constraintTurnFileFor(P.ws, w.turnAnchor);
  fs.renameSync(snapF, snapF + ".off");
  const ph = CF.planDelivery(P.ws, ctxFor(P, "claude"));
  assert.ok(ph.deliver.length === 0 && ph.held === 1 && ph.transitions === 0 && status(P, a.resultId) === "new", "★판독 실패=읽기 보류 " + JSON.stringify(ph));
  fs.renameSync(snapF + ".off", snapF);
  assert.strictEqual(CF.planDelivery(P.ws, ctxFor(P, "claude")).deliver.length, 1, "복구되면 넘김");
  const realNow = Date.now;
  Date.now = () => realNow() + CL.ATTEMPTS_TTL_MS + 60_000;
  let pe; try { pe = CF.planDelivery(P.ws, ctxFor(P, "claude")); } finally { Date.now = realNow; }
  assert.ok(pe.deliver.length === 0 && pe.transitions === 1 && status(P, a.resultId) === "expired", "★만료=원문 만료 " + JSON.stringify(pe));
  assert.strictEqual(CF.planDelivery(P.ws, ctxFor(P, "claude")).deliver.length, 0, "종결 뒤 안 넘김");
  assert.strictEqual(CF.classifySummary(P.ws).boundaryStatus.expired, 1);
});

t("④ 한 차례 상한 — 넘치는 결과는 '새 결과'로 남아 다음 사람의 차례에(전달 횟수 미소비 · 사라지지 않음)", async () => {
  const P = project("cap");
  const q = (i) => "프로젝트 내내 지킬 판정 기준 문장 번호 " + i + " 입니다 계속 지켜요";
  const r1 = await classify(P, [1, 2, 3, 4, 5].map((i) => ({ quote: q(i) })));
  const r2 = await classify(P, [6, 7].map((i) => ({ quote: q(i) })));
  const t1 = ctxFor(P, "claude");
  const p1 = CF.planDelivery(P.ws, t1);
  assert.strictEqual(p1.deliver.length, CF.DELIVER_PER_TURN);
  assert.deepStrictEqual(deliveredIds(p1), r1.map((r) => r.resultId).sort(), "오래된 것부터");
  CF.markResultsDelivered(P.ws, p1.deliver, t1);
  for (const r of r2) assert.ok(status(P, r.resultId) === "new" && !CF.readClassifyResults(P.ws).latest.get(r.resultId).deliveries, "넘치는 결과=새 결과 그대로");
  // [검증 1회차 blocker] 같은 차례에 다시 계획해도 이번 차례에 이미 넘긴 수를 빼고 — 그 사이 판단돼 상태가 바뀐 결과도 셈
  assert.ok(CF.skipResult(P.ws, r1[0].resultId, "같은 차례 안에서 먼저 판단한 결과입니다", t1).ok);
  const again = CF.planDelivery(P.ws, t1);
  assert.strictEqual(again.deliver.length, 0, "★같은 차례 재실행=이미 5건 넘김(판단된 1건 포함) → 더 안 넘김 " + JSON.stringify(deliveredIds(again)));
  for (const r of r1.slice(1, 4)) assert.ok(CF.skipResult(P.ws, r.resultId, "시험용으로 안 올리는 이유 한 줄", t1).ok);
  const p2 = CF.planDelivery(P.ws, ctxFor(P, "claude"));
  assert.deepStrictEqual(deliveredIds(p2), [r1[4].resultId, ...r2.map((r) => r.resultId)].sort(), "다음 차례: 남은 미판단 1(2회째)+새 결과 2");
});

t("⑤ 전달 블록 — 자료(번호·제안 칸·전달 회차·말·판정 영향·이유)+명령 한 줄(브릿지 경로) · 대화 나열·질문 금지 표기 · 영어", async () => {
  const P = project("block");
  const [a] = await classify(P, [{ quote: "실기기 최신폰 확인은 이번 단계 범위 밖으로 계속 본다", seat: "outOfScope" }]);
  const pl = CF.planDelivery(P.ws, ctxFor(P, "claude"));
  const ko = CF.deliveryBlock(pl.deliver, "ko");
  for (const k of ["[사용자 말 분류 결과 — 이번 차례 판단 1건]", a.resultId, "제안 칸 범위 밖(outOfScope)", "전달 1/2회째", "실기기 최신폰 확인은", "판정 영향: 이 기준으로", "constraint add --quote", '--rule "', '--bounds "', "--from <id>", "classify skip <id> --note", "codex-bridge.js", "대화에 늘어놓거나 사용자에게 묻지 않고"]) assert.ok(ko.includes(k), "블록에 " + k + "\n" + ko);
  const en = CF.deliveryBlock(pl.deliver, "en");
  assert.ok(en.includes("decide 1 this turn") && en.includes("delivery 1/2") && en.includes("without listing these in the conversation"), en);
  assert.strictEqual(CF.deliveryBlock([], "ko"), "");
  const long = Object.assign({}, pl.deliver[0], { quote: "가".repeat(500) + "\n둘째 줄", deliveries: 1 });
  const b2 = CF.deliveryBlock([long], "ko");
  assert.ok(!/\n둘째 줄/.test(b2) && b2.includes("…") && b2.includes("전달 2/2회째"), "말 한 줄·길이 상한·2회째 표기");
});

t("⑥ Claude 훅 실제 실행 — 사람의 차례에 블록+전달 기록(이번 차례 앵커) · 그 차례에 --from 올림 가능 · 알림 차례엔 블록·기록 없음", async () => {
  const P = project("hookc");
  assert.ok(CL.patchContractFields(P.ws, "ko", { verifyMode: "always" }));
  const [a] = await classify(P, [{ quote: "실기기 최신폰 확인은 이번 단계 범위 밖으로 계속 본다", seat: "outOfScope" }]);
  const SID = "cd-hook-session-1";
  const tp = path.join(mk("cd-tx-"), SID + ".jsonl"); fs.writeFileSync(tp, "");
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SID });
  const run = (prompt, pid) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "contract-inject.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: P.ws, prompt, transcript_path: tp, permission_mode: "default", prompt_id: pid }), encoding: "utf8", env, cwd: P.ws });
  const ctxOf = (o) => { try { return JSON.parse(o.stdout).hookSpecificOutput.additionalContext || ""; } catch { return ""; } };
  // 알림 차례 먼저(직전 앵커 없음) — 블록·기록 없음
  const on = run("<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>", "pid-n0");
  assert.ok(on.status === 0 && !ctxOf(on).includes("[사용자 말 분류 결과"), "알림 차례=블록 없음");
  assert.strictEqual(status(P, a.resultId), "new", "알림 차례=전달 기록 없음");
  const o1 = run("다음 단계 진행해 주세요", "pid-1");
  const c1 = ctxOf(o1);
  assert.ok(o1.status === 0 && c1.includes("[사용자 말 분류 결과 — 이번 차례 판단 1건]") && c1.includes(a.resultId), "★사람의 차례=블록 " + o1.stderr + c1.slice(0, 300));
  const act = JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, SID + ".json"), "utf8"));
  const row = CF.readClassifyResults(P.ws).latest.get(a.resultId);
  assert.ok(row.status === "delivered" && row.deliveredTurn === act.constraintAnchor && row.deliveries === 1 && row.provider === "claude", "★전달 기록=이번 차례 앵커 " + JSON.stringify(row));
  // 같은 차례의 알림(앵커 이어 씀) — 블록·기록 없음
  const on2 = run("<task-notification>\n<task-id>y</task-id>\n<status>completed</status>\n</task-notification>", "pid-n1");
  assert.ok(!ctxOf(on2).includes("[사용자 말 분류 결과") && CF.readClassifyResults(P.ws).latest.get(a.resultId).deliveries === 1, "같은 차례 알림=재전달 없음");
  // 차례 도중 분류가 끝나 새 결과가 생긴 뒤 알림이 와도(앵커 이어 씀) 그 새 결과는 알림 차례에 안 넘김 — 다음 사람의 차례에
  const [b] = await classify(P, [{ quote: "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어", seat: "outOfScope" }]);
  const on3 = run("<task-notification>\n<task-id>z</task-id>\n<status>completed</status>\n</task-notification>", "pid-n2");
  assert.ok(!ctxOf(on3).includes(b.resultId) && status(P, b.resultId) === "new", "★차례 도중 새 결과=알림 차례에 안 넘김");
  // 그 차례에 --from 올림(명령줄)
  const cli = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "constraint", "add", "--quote", "실기기 최신폰 확인은 이번 단계 범위 밖", "--rule", "실기기 최신폰 확인은 이번 단계 검증 범위에서 뺀다", "--bounds", "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다", "--why", "분류 결과를 보고 판단", "--from", a.resultId], { env, encoding: "utf8", cwd: P.ws });
  assert.ok(cli.status === 0 && /분류 결과/.test(cli.stdout), "★전달받은 차례에 올림 " + cli.stdout + cli.stderr);
  // 다음 사람의 차례 — 판단된 a 는 없고 차례 도중 생긴 b 만
  const o2 = run("그다음 진행해 주세요", "pid-2");
  const c2 = ctxOf(o2);
  assert.ok(!c2.includes(a.resultId) && c2.includes(b.resultId) && c2.includes("이번 차례 판단 1건"), "판단 뒤 a 없음·새 결과 b 는 다음 사람의 차례에 " + c2.slice(0, 300));
});

t("⑦ Codex 훅 실제 실행 — 사람의 차례에 블록+전달 기록(provider codex·이번 턴) · 하위 담당 완료 알림=블록·전달 기록·사용자 말 대기열 모두 없음", async () => {
  const P = project("hookx");
  assert.ok(CL.patchContractFields(P.ws, "ko", { harnessMode: "codex-codex", codexVerifyMode: "always", verifyMode: "always" }));
  const [x] = await classify(P, [{ quote: "Codex 쪽 기준 외부 서버 연동 오류는 다루지 않는다고 했어" }], "codex");
  const CSID = "019f0000-4444-7444-8444-955566677799";
  const rollout = path.join(mk("cd-rollout-"), "rollout.jsonl");
  fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", timestamp: new Date(Date.now() - 60000).toISOString(), payload: { id: CSID, source: "vscode", thread_source: "user" } }) + "\n", "utf8");
  const envX = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }); delete envX.CLAUDE_PROJECT_DIR;
  const run = (turn, prompt) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-hook.js")], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CSID, cwd: P.ws, transcript_path: rollout, turn_id: turn, prompt }), encoding: "utf8", timeout: 30000, env: envX, windowsHide: true });
  const ctxOf = (o) => { try { return JSON.parse(o.stdout).hookSpecificOutput.additionalContext || ""; } catch { return ""; } };
  const wordsBefore = UW.readUserWordsState(P.ws).words.size;
  const on = run("t-cd-n", "<subagent_notification>\n{\"agent_path\":\"a\",\"status\":{\"completed\":\"done\"}}\n</subagent_notification>");
  assert.ok(on.status === 0 && !ctxOf(on).includes("[사용자 말 분류 결과"), "★하위 담당 완료 알림=블록 없음 " + on.stderr);
  assert.strictEqual(status(P, x.resultId), "new", "알림=전달 기록 없음");
  assert.strictEqual(UW.readUserWordsState(P.ws).words.size, wordsBefore, "★알림=사용자 말 대기열에 안 넣음");
  const o1 = run("t-cd-1", "구현 계속 진행해");
  const c1 = ctxOf(o1);
  assert.ok(o1.status === 0 && c1.includes("[사용자 말 분류 결과 — 이번 차례 판단 1건]") && c1.includes(x.resultId), "★사람의 차례=블록 " + o1.stderr + " " + c1.slice(0, 200));
  const row = CF.readClassifyResults(P.ws).latest.get(x.resultId);
  assert.ok(row.status === "delivered" && row.provider === "codex" && row.deliveries === 1 && row.deliveredTurn, "★전달 기록 " + JSON.stringify(row));
  assert.strictEqual(UW.readUserWordsState(P.ws).words.size, wordsBefore + 1, "사람 말은 대기열에");
  const o2 = run("t-cd-1", "구현 계속 진행해");
  assert.ok(!ctxOf(o2).includes("[사용자 말 분류 결과") && CF.readClassifyResults(P.ws).latest.get(x.resultId).deliveries === 1, "같은 턴 재실행=재전달 없음");
  // 사람의 차례 뒤 새 결과가 생기고, 다음 턴이 하위 담당 완료 알림이면(직전 사람 차례 결속을 이음) — 그 알림 턴엔 넘기지 않음
  const [y] = await classify(P, [{ quote: "Codex 쪽 기준 실기기 확인은 범위 밖이라고 계속 보자고 했어" }], "codex");
  const on2 = run("t-cd-2", "<subagent_notification>\n{\"agent_path\":\"b\",\"status\":{\"completed\":\"done\"}}\n</subagent_notification>");
  assert.ok(on2.status === 0 && !ctxOf(on2).includes("[사용자 말 분류 결과"), "★사람의 차례 뒤 알림 턴=블록 없음 " + ctxOf(on2).slice(0, 200));
  assert.ok(status(P, y.resultId) === "new" && CF.readClassifyResults(P.ws).latest.get(x.resultId).deliveries === 1, "★알림 턴=새 결과·이전 결과 모두 전달 기록 없음");
  const o3 = run("t-cd-3", "다음 단계로 가 주세요");
  assert.ok(ctxOf(o3).includes(y.resultId) && ctxOf(o3).includes(x.resultId), "다음 사람의 차례에 새 결과+2회째");
});

t("⑨ Codex 같은 턴 재입력 — 하위 담당 완료 알림·덧붙인 말이 그 턴의 변경 기록·시작 시각·사람 말 원문을 지우지 않음 · 새 턴은 새로 시작(알림이면 직전 사람 차례 결속을 이음) · 코드 모드 종료 관문은 여전히 검증 요구", async () => {
  const P = project("sameturn");
  assert.ok(CL.patchContractFields(P.ws, "ko", { harnessMode: "codex-codex", codexVerifyMode: "code", verifyMode: "always" }));
  const CSID = "019f0000-5555-7555-8555-955566677711";
  const rollout = path.join(mk("cd-rollout2-"), "rollout.jsonl");
  fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", timestamp: new Date(Date.now() - 60000).toISOString(), payload: { id: CSID, source: "vscode", thread_source: "user" } }) + "\n", "utf8");
  const envX = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }); delete envX.CLAUDE_PROJECT_DIR;
  const hook = (ev, extra) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-hook.js")], { input: JSON.stringify(Object.assign({ hook_event_name: ev, session_id: CSID, cwd: P.ws, transcript_path: rollout }, extra)), encoding: "utf8", timeout: 30000, env: envX, windowsHide: true });
  const turnF = path.join(HOME, "codex-turns", CSID + ".json");
  const turnS = () => JSON.parse(fs.readFileSync(turnF, "utf8"));
  const act = () => CL.readCodexActive(CSID) || {};
  const NOTE = "<subagent_notification>\n{\"agent_path\":\"a\",\"status\":{\"completed\":\"done\"}}\n</subagent_notification>";
  assert.strictEqual(hook("UserPromptSubmit", { turn_id: "T1", prompt: "구현을 시작해 주세요" }).status, 0);
  const s0 = turnS(), a0 = act();
  assert.ok(s0.turnId === "T1" && s0.modified === false && a0.constraintAnchor === "T1", "(전제) 사람 차례 " + JSON.stringify([s0, a0]));
  const snapF = CL.constraintTurnFileFor(P.ws, "T1"), snap0 = fs.readFileSync(snapF, "utf8");
  assert.strictEqual(hook("PostToolUse", { turn_id: "T1", tool_name: "apply_patch", tool_use_id: "u1" }).status, 0);
  const s1 = turnS();
  assert.ok(s1.modified === true && s1.startedAt === s0.startedAt, "(전제) 변경 기록 " + JSON.stringify(s1));
  // 같은 턴에 하위 담당 완료 알림
  assert.strictEqual(hook("UserPromptSubmit", { turn_id: "T1", prompt: NOTE }).status, 0);
  const s2 = turnS();
  assert.ok(s2.turnId === "T1" && s2.modified === true && s2.startedAt === s0.startedAt, "★같은 턴 알림=변경 기록·시작 시각 유지 " + JSON.stringify(s2));
  assert.strictEqual(fs.readFileSync(snapF, "utf8"), snap0, "★같은 턴 알림=사람 말 원문 그대로");
  assert.ok(act().constraintAnchor === "T1" && act().constraintSourceHash === a0.constraintSourceHash, "결속 그대로");
  // 코드 모드 종료 관문 — 변경이 있으니 검증 요구(증명 없음=막힘)
  const st = hook("Stop", { turn_id: "T1", stop_hook_active: false });
  let so = null; try { so = JSON.parse(st.stdout); } catch { so = null; }
  assert.ok(so && so.decision === "block", "★알림 뒤에도 종료 관문이 검증을 요구 " + st.stdout.slice(0, 200) + st.stderr.slice(0, 200));
  // 같은 턴에 사람이 덧붙인 말도 변경 기록을 지우지 않음
  assert.strictEqual(hook("UserPromptSubmit", { turn_id: "T1", prompt: "아 그리고 이것도 같이 봐 주세요" }).status, 0);
  assert.ok(turnS().modified === true && turnS().startedAt === s0.startedAt, "★같은 턴 덧붙인 말=변경 기록 유지");
  // 새 턴의 알림 — 새로 시작(앞 턴의 종료 관문은 이미 지남) · 직전 사람 차례 결속을 이음
  const aBefore = act();
  assert.strictEqual(hook("UserPromptSubmit", { turn_id: "T2", prompt: NOTE }).status, 0);
  const s3 = turnS();
  assert.ok(s3.turnId === "T2" && s3.modified === false && s3.startedAt >= s0.startedAt, "새 턴=새로 시작 " + JSON.stringify(s3));
  assert.ok(act().constraintAnchor === aBefore.constraintAnchor && act().constraintSourceHash === aBefore.constraintSourceHash, "★새 턴 알림=직전 사람 차례 결속을 이음 " + JSON.stringify(act()));
  assert.ok(!fs.existsSync(CL.constraintTurnFileFor(P.ws, "T2")), "알림 턴은 원문 스냅샷을 만들지 않음");
  // 같은 턴인데 앞 기록을 못 읽으면 변경이 있었던 것으로(fail-closed)
  fs.writeFileSync(turnF, "{ 손상");
  assert.strictEqual(hook("UserPromptSubmit", { turn_id: "T2", prompt: "계속 진행해 주세요" }).status, 0);
  assert.strictEqual(turnS().modified, true, "★같은 턴 앞 기록 판독 불가=변경 있음으로");
});

t("⑧ Codex 입력 비-발화 판별 · 전달 기록은 출력 뒤에만(소스 고정 — 두 훅)", () => {
  const f = CL.isCodexNonUtterancePrompt;
  assert.strictEqual(f({ prompt: "<subagent_notification>\n{}\n</subagent_notification>" }), true);
  assert.strictEqual(f({ prompt: "  <subagent_notification>a</subagent_notification>\n<subagent_notification>b</subagent_notification> " }), true);
  assert.strictEqual(f({ prompt: "<task-notification>x</task-notification>" }), true, "Claude 봉투도");
  assert.strictEqual(f({ prompt: "일반 요청" }), false);
  assert.strictEqual(f({ prompt: "<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>" }), false, "질문에 대한 사용자 답=사람의 차례");
  assert.strictEqual(f({ prompt: "이거 봐 <subagent_notification>x</subagent_notification>" }), false, "사람 말이 섞이면 사람의 차례");
  assert.strictEqual(f({ prompt: "" }), false);
  const inj = fs.readFileSync(path.join(ROOT, "bridge", "contract-inject.js"), "utf8");
  assert.ok(/const finalize = \(err\) => \{\s*\n\s*if \(!err && deliverPlan\) \{ try \{ require\("\.\/classify\.js"\)\.markResultsDelivered\(ws, deliverPlan\.results, deliverPlan\.ctx\);/.test(inj), "Claude: 출력 성공 뒤에만 전달 기록");
  assert.ok(/deliverPlan = null; \/\/ 분류 결과 블록도 빠짐=전달 기록 없음/.test(inj), "Claude: 조립 실패=전달 기록 없음");
  const hk = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  assert.ok(/contextThen\("UserPromptSubmit", preface \? preface \+ body : body, \(\) => \{\s*\n\s*recordCodexDirective\(sid, ws, ic9\.record\);\s*\n\s*if \(deliverPlan9\) \{ try \{ require\("\.\/classify\.js"\)\.markResultsDelivered\(ws, deliverPlan9\.results, deliverPlan9\.ctx\);/.test(hk), "Codex: 출력 뒤에만 전달 기록");
  assert.ok(/if \(snap\.ok && !nonUtter9\) \{ try \{ require\("\.\/user-words\.js"\)\.enqueuePrompt/.test(hk), "Codex: 비-발화는 대기열 제외");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
