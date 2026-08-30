"use strict";
/*
 * [개선 2 · 결정 장부 — HARNESS-REALIGNMENT-2026-08-29 §4] 1단계 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 결정 행은 origin 닫힌 열거(기계 상태)에서만 · 멱등 id · 추가 전용/생성·결과 행 분리/결과가 원항목을 덮지 않음 ·
 * read-back · 대상 지문 재대조(target-drift 거부) · delegate(네가 정해라) · wsKey 결속(ab-1) · CLI 양식 출력 · 생산자 배선 소스 핀.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws-"));
const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws2-"));
const spec = (over) => Object.assign({
  origin: "all-oos-demoted", campaignId: "cl:s:2026-08-30T00:00:00.000Z", sourceAsk: "ask-a1", targetFp: "envhash-1",
  question: "남은 실패 사유가 전부 범위 밖 — 어떻게 닫을까요?", why: "범위표 문제",
  choices: [{ key: "accept-oos", label: "범위 밖 수용(종결)", ifChosen: "닫힘" }, { key: "re-review", label: "재심 요청", ifChosen: "다시 봄" }],
}, over || {});

t("openDecision — 생성 행 1건·열린 결정 1건·id 16hex", () => {
  const r = CL.openDecision(WS, spec());
  assert.strictEqual(r.ok, true, String(r.reason || ""));
  assert.ok(/^[a-f0-9]{16}$/.test(r.decisionId));
  assert.strictEqual(r.existed, false);
  const cur = CL.readDecisions(WS);
  assert.strictEqual(cur.open.length, 1);
  assert.strictEqual(cur.rows.length, 1);
  assert.strictEqual(cur.open[0].origin, "all-oos-demoted");
});

t("멱등 — 같은 ws·캠페인·출처·ask·대상 지문은 같은 id·재생성 없음(existed)", () => {
  const a = CL.openDecision(WS, spec());
  assert.strictEqual(a.ok, true); assert.strictEqual(a.existed, true);
  assert.strictEqual(CL.readDecisions(WS).rows.length, 1);
  assert.strictEqual(CL.decisionIdFor(WS, spec().campaignId, "all-oos-demoted", "ask-a1", "envhash-1"), a.decisionId);
  // 고정 산식 벡터: sha1("decision:" + wsKey + "|" + campaign + "|" + origin + "|" + ask + "|" + targetFp)[:16]
  const vec = require("crypto").createHash("sha1").update("decision:" + CL.wsKeyFor(WS) + "|" + spec().campaignId + "|all-oos-demoted|ask-a1|envhash-1").digest("hex").slice(0, 16);
  assert.strictEqual(a.decisionId, vec);
});

t("origin 닫힌 열거 — 구현자 자기신고 출처(implementer-note)는 생성 거부", () => {
  const r = CL.openDecision(WS, spec({ origin: "implementer-note", sourceAsk: "ask-x" }));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, "origin-not-allowed");
  assert.strictEqual(CL.readDecisions(WS).rows.length, 1);
});

t("appendDecisionRows — 손상 행(choices 없음·delegate 키를 선택지로 위장·다른 wsKey) 거부", () => {
  const base = CL.readDecisions(WS).rows[0];
  const bad1 = Object.assign({}, base, { decisionId: "0123456789abcdef", choices: [] });
  const bad2 = Object.assign({}, base, { decisionId: "0123456789abcdef", choices: [{ key: CL.DECISION_DELEGATE_KEY, label: "x" }] });
  const bad3 = Object.assign({}, base, { decisionId: "0123456789abcdef", wsKey: "ffffffffffffffff" });
  for (const b of [bad1, bad2, bad3]) assert.strictEqual(CL.appendDecisionRows(WS, [b]).ok, false);
  assert.strictEqual(CL.readDecisions(WS).rows.length, 1);
});

t("resolveDecision — 선택지 밖 키 거부·대상 지문 불일치(target-drift) 거부·열린 상태 유지", () => {
  const id = CL.readDecisions(WS).open[0].decisionId;
  assert.strictEqual(CL.resolveDecision(WS, id, "nope", { currentFp: "envhash-1" }).reason, "unknown-choice");
  assert.strictEqual(CL.resolveDecision(WS, id, "accept-oos", { currentFp: "envhash-2" }).reason, "target-drift");
  assert.strictEqual(CL.resolveDecision(WS, id, "accept-oos").reason, "current-fp-required"); // 재대조 생략 호출=거부(fail-closed)
  assert.strictEqual(CL.resolveDecision(WS, id, "accept-oos", {}).reason, "current-fp-required");
  assert.strictEqual(CL.resolveDecision(WS, "0000000000000000", "accept-oos").reason, "not-found");
  assert.strictEqual(CL.readDecisions(WS).open.length, 1);
  assert.strictEqual(CL.readDecisions(WS).rows.length, 1);
});

t("resolveDecision — 지문 일치 시 결과 행 추가·원항목 보존·열린 결정 0·재기록 거부", () => {
  const id = CL.readDecisions(WS).open[0].decisionId;
  const r = CL.resolveDecision(WS, id, "accept-oos", { currentFp: "envhash-1", by: "user" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, "chosen");
  const cur = CL.readDecisions(WS);
  assert.strictEqual(cur.rows.length, 2);
  assert.strictEqual(cur.rows[0].status, "open"); // 생성 행 불변
  assert.strictEqual(cur.rows[0].question, spec().question);
  assert.strictEqual(cur.latest.get(id).status, "chosen");
  assert.strictEqual(cur.latest.get(id).choice, "accept-oos");
  assert.strictEqual(cur.latest.get(id).question, spec().question); // 합성 뷰에 원항목 필드 유지
  assert.strictEqual(cur.open.length, 0);
  assert.strictEqual(CL.resolveDecision(WS, id, "re-review", { currentFp: "envhash-1" }).reason, "already-resolved");
  assert.strictEqual(CL.readDecisions(WS).rows.length, 2);
  const again = CL.openDecision(WS, spec()); // 같은 판정 재처리 → 재생성 없음·상태 반환(열림으로 오안내 금지)
  assert.strictEqual(again.existed, true); assert.strictEqual(again.status, "chosen");
  assert.strictEqual(CL.readDecisions(WS).rows.length, 2);
});

t("delegate — '네가 정해라' 결과 행(delegated)·지표에 집계", () => {
  const r0 = CL.openDecision(WS, spec({ sourceAsk: "ask-a2" }));
  assert.strictEqual(r0.ok, true);
  const r = CL.resolveDecision(WS, r0.decisionId, CL.DECISION_DELEGATE_KEY, { currentFp: "envhash-1" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, "delegated");
  const m = CL.decisionMetrics(WS, spec().campaignId);
  assert.strictEqual(m.total, 2); assert.strictEqual(m.chosen, 1); assert.strictEqual(m.delegated, 1); assert.strictEqual(m.open, 0);
  assert.strictEqual(m.byOrigin["all-oos-demoted"].total, 2);
});

t("ab-1 — 다른 프로젝트 wsKey 행이 같은 파일에 섞여도 이 프로젝트 장부에서 권위 없음", () => {
  const foreign = Object.assign({}, CL.readDecisions(WS).rows[0], { decisionId: "abcdefabcdefabcd", wsKey: CL.wsKeyFor(WS2) });
  fs.appendFileSync(CL.decisionsFileFor(WS), JSON.stringify(foreign) + "\n");
  assert.strictEqual(CL.readDecisions(WS).opens.has("abcdefabcdefabcd"), false);
  assert.strictEqual(CL.readDecisions(WS2).open.length, 0); // 다른 ws는 자기 파일이 따로 있음(파일도 다름)
});

t("read-back — 기록 파일이 디렉터리면 write-failed(성공 위장 없음)", () => {
  const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws3-"));
  fs.mkdirSync(CL.DECISIONS_DIR, { recursive: true });
  fs.mkdirSync(CL.decisionsFileFor(WS3));
  const r = CL.openDecision(WS3, spec());
  assert.strictEqual(r.ok, false); assert.ok(["write-failed", "read-back-failed"].includes(r.reason), r.reason);
});

t("CLI decisions list/choose — 양식 출력·선택 기록·지문 불일치 거부(exit 3)", () => {
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws4-"));
  const HASH_NOW = require("crypto").createHash("sha1").update("core-envelope-now").digest("hex"); // 계약 envelopeHash는 40hex만 유효
  const o = CL.openDecision(WS4, spec({ targetFp: HASH_NOW }));
  assert.strictEqual(o.ok, true);
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: WS4 });
  const bridge = path.join(__dirname, "..", "bridge", "codex-bridge.js");
  const run = (args) => spawnSync(process.execPath, [bridge, ...args], { encoding: "utf8", env, cwd: WS4 });
  const l = run(["decisions", "list"]);
  assert.strictEqual(l.status, 0, l.stderr);
  assert.ok(l.stdout.includes(o.decisionId) && l.stdout.includes("accept-oos") && l.stdout.includes(CL.DECISION_DELEGATE_KEY), l.stdout);
  // 계약에 승인 지문이 없으면 currentFp="" → 결정이 전제한 지문과 달라 target-drift(exit 3)
  const c1 = run(["decisions", "choose", o.decisionId, "accept-oos"]);
  assert.strictEqual(c1.status, 3, c1.stdout + c1.stderr);
  assert.strictEqual(CL.readDecisions(WS4).open.length, 1);
  // 지문 일치 픽스처: 승인 도장과 같은 경로(setEnvelopeHashAllSlots)로 계약 envelopeHash 기록 후 선택 → 기록됨
  assert.ok(Number(CL.setEnvelopeHashAllSlots(WS4, HASH_NOW)) >= 1); // 반환=기록된 슬롯 수
  assert.strictEqual(CL.loadContract(WS4, "ko").envelopeHash, HASH_NOW);
  const c2 = run(["decisions", "choose", o.decisionId, "accept-oos"]);
  assert.strictEqual(c2.status, 0, c2.stdout + c2.stderr);
  assert.strictEqual(CL.readDecisions(WS4).latest.get(o.decisionId).status, "chosen");
  const c3 = run(["decisions", "choose", o.decisionId, "re-review"]);
  assert.strictEqual(c3.status, 3);
  const e = run(["decisions", "list"]);
  assert.ok(e.stdout.includes("열린 결정 없음") || e.stdout.includes("No open decisions"), e.stdout);
  // delegate(네가 정해라)·metrics도 실제 spawn
  const o2 = CL.openDecision(WS4, spec({ targetFp: HASH_NOW, sourceAsk: "ask-b" }));
  const dg = run(["decisions", "delegate", o2.decisionId]);
  assert.strictEqual(dg.status, 0, dg.stdout + dg.stderr);
  assert.strictEqual(CL.readDecisions(WS4).latest.get(o2.decisionId).status, "delegated");
  const mt = run(["decisions", "metrics", "--campaign", spec().campaignId]);
  assert.strictEqual(mt.status, 0, mt.stderr);
  const mj = JSON.parse(mt.stdout);
  assert.strictEqual(mj.total, 2); assert.strictEqual(mj.chosen, 1); assert.strictEqual(mj.delegated, 1); assert.strictEqual(mj.open, 0);
  const bad = run(["decisions", "choose", o2.decisionId]);
  assert.strictEqual(bad.status, 2); // 사용법 오류
});

t("생산자 실행 — recordAllOosDemotedDecision: 성공=장부 행+고지 / 재처리=상태 고지 / 기록 실패=고지 1줄·예외 없음", () => {
  const CB = require("../bridge/codex-bridge.js");
  const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws5-"));
  const n1 = CB.recordAllOosDemotedDecision(WS5, "cl:s:c1", "ask-p1", "f".repeat(40), false);
  assert.ok(n1.startsWith("[결정 장부] ") && n1.includes("decisions choose"), n1);
  const cur = CL.readDecisions(WS5);
  assert.strictEqual(cur.open.length, 1);
  assert.strictEqual(cur.open[0].origin, "all-oos-demoted");
  assert.strictEqual(cur.open[0].targetFp, "f".repeat(40));
  assert.strictEqual(cur.open[0].sourceAsk, "ask-p1");
  assert.strictEqual(cur.open[0].campaignId, "cl:s:c1");
  const n2 = CB.recordAllOosDemotedDecision(WS5, "cl:s:c1", "ask-p1", "f".repeat(40), false);
  assert.ok(n2.includes("이미 기록됨: 열림"), n2);
  assert.strictEqual(CL.readDecisions(WS5).rows.length, 1);
  assert.strictEqual(CL.resolveDecision(WS5, cur.open[0].decisionId, "accept-oos", { currentFp: "f".repeat(40) }).ok, true);
  assert.ok(CB.recordAllOosDemotedDecision(WS5, "cl:s:c1", "ask-p1", "f".repeat(40), false).includes("이미 기록됨: 선택됨"));
  // 기록 실패 경로: 장부 파일 자리에 디렉터리 → 고지 1줄 반환·throw 없음
  const WS6 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws6-"));
  fs.mkdirSync(CL.DECISIONS_DIR, { recursive: true }); fs.mkdirSync(CL.decisionsFileFor(WS6));
  let n3 = null; assert.doesNotThrow(() => { n3 = CB.recordAllOosDemotedDecision(WS6, "cl:s:c2", "ask-p2", "a".repeat(40), false); });
  assert.ok(n3.startsWith("[결정 장부] 기록 실패("), n3);
  const n4 = CB.recordAllOosDemotedDecision(WS6, "cl:s:c2", "ask-p2", "a".repeat(40), true);
  assert.ok(n4.startsWith("[decision ledger] record failed ("), n4);
});

t("실경로 — machineFindingsLayer 전량 강등 보류 판정이 결정 행을 만들고(targetFp=동결 지문) 판정은 그대로 '보류'", () => {
  const CB = require("../bridge/codex-bridge.js");
  const NLc = String.fromCharCode(10);
  const repoE = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-repo-"));
  fs.writeFileSync(path.join(repoE, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["s1"], alwaysBlocker: ["a1", "a2"], outOfScope: ["o1", "o2"] }));
  const shaE = CL.readVerifyEnvelope(repoE).sha1;
  const wsE = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-wse-"));
  CL.updateContractPatch(wsE, "ko", { envelopeHash: shaE, scoutRepo: repoE }, { tries: 3 });
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-d3"; CL.writeEnvelopeFreeze(wsE, shaE, "ask-d3");
  const r = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "범위 밖 경합", origin: "baseline", supported: false, oosId: "oos-2" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), wsE, "ko", "core", "claude-codex", "ask-d3");
  assert.strictEqual(r.machine.effective, "inconclusive"); assert.strictEqual(r.machine.reasonKey, "scope-demoted");
  assert.ok(r.notice.includes("[결정 장부] "), r.notice);
  const cur = CL.readDecisions(wsE);
  assert.strictEqual(cur.open.length, 1);
  assert.strictEqual(cur.open[0].targetFp, shaE);
  assert.strictEqual(cur.open[0].origin, "all-oos-demoted");
  assert.ok(r.notice.includes(cur.open[0].decisionId));
  // 같은 판정 재처리(같은 ask·동결) → 행 1건 유지·상태 고지
  const r2 = CB.machineFindingsLayer(["본문", "[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "범위 밖 경합", origin: "baseline", supported: false, oosId: "oos-2" }),
    "[지적 목록 끝]", "", "검증: 실패"].join(NLc), wsE, "ko", "core", "claude-codex", "ask-d3");
  assert.ok(r2.notice.includes("이미 기록됨"), r2.notice);
  assert.strictEqual(CL.readDecisions(wsE).rows.length, 1);
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
});

t("소스 핀 — 생산자 배선: 전량 강등 보류 분기에서만 openDecision(all-oos-demoted)·CLI decisions 분기 존재", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  const i = src.indexOf('machine.reasonKey = "scope-demoted";');
  assert.ok(i > 0);
  const seg = src.slice(i, i + 1200);
  assert.ok(seg.includes('recordAllOosDemotedDecision(ws, camp, askId, frozen, en)'), "producer not wired in scope-demoted branch");
  assert.strictEqual((src.match(/out\.push\(recordAllOosDemotedDecision\(/g) || []).length, 1, "producer call must exist exactly once");
  assert.strictEqual((src.match(/function recordAllOosDemotedDecision\(/g) || []).length, 1, "single producer definition (function)");
  assert.strictEqual((src.match(/origin: "all-oos-demoted"/g) || []).length, 1, "single producer definition");
  assert.ok(src.includes('case "decisions":'), "CLI dispatch missing");
  assert.ok(!/origin: "implementer/.test(src), "no implementer self-report origin");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
