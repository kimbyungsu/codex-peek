"use strict";
/*
 * [개선 2 · 결정 장부 — HARNESS-REALIGNMENT-2026-08-29 §4 · 사용자 방향 2026-08-30] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 결정 행의 유일 출처=구현자 판단(origin implementer · kind 닫힌 열거 · 기본값 없는 이유 필수) — 검증자 지적·하네스 상태는
 * 자동으로 사용자 결정을 만들지 않는다(전량 강등 보류=판단 촉구 한 줄) · 멱등 id · 추가 전용/생성·결과 행 분리/원항목 불변 ·
 * read-back · 대상 지문 재대조 필수(fail-closed) · delegate(네가 정해라) · wsKey 결속(ab-1) · CLI raise/list/choose/delegate/metrics.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (x) => crypto.createHash("sha1").update(String(x)).digest("hex");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws-"));
const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws2-"));
const spec = (over) => Object.assign({
  origin: "implementer", kind: "boundary", campaignId: "cl:s:2026-08-30T00:00:00.000Z", sourceAsk: "ask-a1", targetFp: "envhash-1",
  question: "범위표에 '서버 두 대 동시 배포'를 제외 상황으로 넣을까요?", why: "검증자 지적 3건이 전부 그 상황을 전제",
  noDefault: "범위표는 사용자가 정하는 영역이라 구현자가 대신 정할 수 없음",
  choices: [{ key: "add-oos", label: "제외 상황으로 추가", ifChosen: "다음 검증부터 그 지적은 메모" }, { key: "keep", label: "그대로 두고 재검증", ifChosen: "다음 검증이 다시 봄" }],
  recommend: "add-oos",
}, over || {});

t("openDecision — 구현자 판단 행 1건·열린 결정 1건·id 16hex", () => {
  const r = CL.openDecision(WS, spec());
  assert.strictEqual(r.ok, true, String(r.reason || ""));
  assert.ok(/^[a-f0-9]{16}$/.test(r.decisionId));
  assert.strictEqual(r.existed, false);
  const cur = CL.readDecisions(WS);
  assert.strictEqual(cur.open.length, 1);
  assert.strictEqual(cur.rows.length, 1);
  assert.strictEqual(cur.open[0].origin, "implementer");
  assert.strictEqual(cur.open[0].kind, "boundary");
});

t("멱등 — 같은 ws·캠페인·ask·전제·질문은 같은 id·재생성 없음 / 고정 산식 벡터", () => {
  const a = CL.openDecision(WS, spec());
  assert.strictEqual(a.ok, true); assert.strictEqual(a.existed, true);
  assert.strictEqual(CL.readDecisions(WS).rows.length, 1);
  const idKey = "envhash-1|" + sha1(spec().question).slice(0, 16);
  assert.strictEqual(CL.decisionIdKeyFor("envhash-1", spec().question), idKey);
  const vec = sha1("decision:" + CL.wsKeyFor(WS) + "|" + spec().campaignId + "|implementer|ask-a1|" + idKey).slice(0, 16);
  assert.strictEqual(a.decisionId, vec);
  // 질문이 다르면 다른 결정
  const b = CL.openDecision(WS, spec({ question: "다른 질문입니다" }));
  assert.strictEqual(b.existed, false); assert.notStrictEqual(b.decisionId, a.decisionId);
});

t("출처·종류·기본값 이유 — 기계 출처(all-oos-demoted)·미지 kind·짧은 noDefault 거부(형식 관문)", () => {
  assert.strictEqual(CL.openDecision(WS, spec({ origin: "all-oos-demoted", question: "q1" })).reason, "origin-not-allowed");
  assert.strictEqual(CL.openDecision(WS, spec({ kind: "whatever", question: "q2" })).reason, "kind-not-allowed");
  assert.strictEqual(CL.openDecision(WS, spec({ noDefault: "짧음", question: "q3" })).reason, "no-default-reason-required");
  assert.strictEqual(CL.readDecisions(WS).rows.length, 2);
});

t("appendDecisionRows — 손상 행(choices 없음·delegate 키 위장·다른 wsKey·noDefault 없음) 거부", () => {
  const base = CL.readDecisions(WS).rows[0];
  const bad = [
    Object.assign({}, base, { decisionId: "0123456789abcdef", choices: [] }),
    Object.assign({}, base, { decisionId: "0123456789abcdef", choices: [{ key: CL.DECISION_DELEGATE_KEY, label: "x" }] }),
    Object.assign({}, base, { decisionId: "0123456789abcdef", wsKey: "ffffffffffffffff" }),
    Object.assign({}, base, { decisionId: "0123456789abcdef", noDefault: "" }),
    Object.assign({}, base, { decisionId: "0123456789abcdef", choices: [{ key: "same", label: "A" }, { key: "same", label: "B" }] }),
  ];
  for (const b of bad) assert.strictEqual(CL.appendDecisionRows(WS, [b]).ok, false);
  assert.strictEqual(CL.readDecisions(WS).rows.length, 2);
});

t("resolveDecision — 선택지 밖 키·지문 불일치·지문 미제공(current-fp-required)·없는 id 거부, 열린 상태 유지", () => {
  const id = CL.readDecisions(WS).open[0].decisionId;
  assert.strictEqual(CL.resolveDecision(WS, id, "nope", { currentFp: "envhash-1" }).reason, "unknown-choice");
  assert.strictEqual(CL.resolveDecision(WS, id, "add-oos", { currentFp: "envhash-2" }).reason, "target-drift");
  assert.strictEqual(CL.resolveDecision(WS, id, "add-oos").reason, "current-fp-required");
  assert.strictEqual(CL.resolveDecision(WS, id, "add-oos", {}).reason, "current-fp-required");
  assert.strictEqual(CL.resolveDecision(WS, "0000000000000000", "add-oos").reason, "not-found");
  assert.strictEqual(CL.readDecisions(WS).open.length, 2);
  assert.strictEqual(CL.readDecisions(WS).rows.length, 2);
});

t("resolveDecision — 지문 일치 시 결과 행 추가·원항목 불변·재기록 거부·재상신은 상태 반환", () => {
  const id = CL.readDecisions(WS).open[0].decisionId;
  const r = CL.resolveDecision(WS, id, "add-oos", { currentFp: "envhash-1", by: "user" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, "chosen");
  const cur = CL.readDecisions(WS);
  assert.strictEqual(cur.rows.length, 3);
  assert.strictEqual(cur.rows[0].status, "open");
  assert.strictEqual(cur.rows[0].question, spec().question);
  assert.strictEqual(cur.latest.get(id).status, "chosen");
  assert.strictEqual(cur.latest.get(id).choice, "add-oos");
  assert.strictEqual(cur.latest.get(id).noDefault, spec().noDefault);
  assert.strictEqual(cur.open.length, 1);
  assert.strictEqual(CL.resolveDecision(WS, id, "keep", { currentFp: "envhash-1" }).reason, "already-resolved");
  const again = CL.openDecision(WS, spec());
  assert.strictEqual(again.existed, true); assert.strictEqual(again.status, "chosen");
  assert.strictEqual(CL.readDecisions(WS).rows.length, 3);
});

t("delegate — '네가 정해라' 결과 행·전제 없는 결정(targetFp='')은 지문 없이 닫힘·지표 집계", () => {
  const other = CL.readDecisions(WS).open[0];
  assert.strictEqual(other.targetFp, "envhash-1");
  const r = CL.resolveDecision(WS, other.decisionId, CL.DECISION_DELEGATE_KEY, { currentFp: "envhash-1" });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, "delegated");
  const p = CL.openDecision(WS, spec({ kind: "product", targetFp: "", question: "제품 방향 질문" }));
  assert.strictEqual(p.ok, true);
  assert.strictEqual(CL.resolveDecision(WS, p.decisionId, "keep").ok, true); // 전제 지문이 없으면 재대조 대상 없음
  const m = CL.decisionMetrics(WS, spec().campaignId);
  assert.strictEqual(m.total, 3); assert.strictEqual(m.chosen, 2); assert.strictEqual(m.delegated, 1); assert.strictEqual(m.open, 0);
  assert.strictEqual(m.byOrigin.implementer.total, 3);
});

t("ab-1 — 다른 프로젝트 wsKey 행이 섞여도 이 프로젝트 장부에서 권위 없음", () => {
  const foreign = Object.assign({}, CL.readDecisions(WS).rows[0], { decisionId: "abcdefabcdefabcd", wsKey: CL.wsKeyFor(WS2) });
  fs.appendFileSync(CL.decisionsFileFor(WS), JSON.stringify(foreign) + "\n");
  assert.strictEqual(CL.readDecisions(WS).opens.has("abcdefabcdefabcd"), false);
  assert.strictEqual(CL.readDecisions(WS2).open.length, 0);
});

t("read-back — 기록 파일이 디렉터리면 write-failed(성공 위장 없음)", () => {
  const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws3-"));
  fs.mkdirSync(CL.DECISIONS_DIR, { recursive: true });
  fs.mkdirSync(CL.decisionsFileFor(WS3));
  const r = CL.openDecision(WS3, spec());
  assert.strictEqual(r.ok, false); assert.ok(["write-failed", "read-back-failed"].includes(r.reason), r.reason);
});

const bridge = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const runIn = (ws) => (args) => spawnSync(process.execPath, [bridge, ...args], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws }), cwd: ws });

t("CLI decisions raise — 구현자 판단의 구조 채널: 필드 관문(kind·choice 2+·no-default·recommend) 실행·기록·재상신 멱등", () => {
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws4-"));
  const run = runIn(WS4);
  const base = ["decisions", "raise", "--kind", "boundary", "--question", "서버 두 대 동시 배포를 제외 상황으로?", "--why", "지적 3건 전제", "--no-default", "범위표는 사용자 영역이라 대신 정할 수 없음", "--choice", "add-oos=제외 상황으로 추가|다음부터 메모", "--choice", "keep=그대로 두고 재검증"];
  assert.strictEqual(run(["decisions", "raise", "--kind", "nope", "--question", "q", "--no-default", "1234567890ab", "--choice", "a=b", "--choice", "c=d"]).status, 2);
  assert.strictEqual(run(base.slice(0, base.length - 2)).status, 2); // choice 1개
  assert.strictEqual(run(base.map((x) => (x === "범위표는 사용자 영역이라 대신 정할 수 없음" ? "짧음" : x))).status, 2);
  assert.strictEqual(run([...base, "--recommend", "zzz"]).status, 2);
  assert.strictEqual(run([...base.slice(0, base.length - 2), "--choice", "add-oos=같은 키 다시"]).status, 2); // 중복 키=거부
  const ok = run([...base, "--recommend", "add-oos"]);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  const cur = CL.readDecisions(WS4);
  assert.strictEqual(cur.open.length, 1);
  assert.strictEqual(cur.open[0].origin, "implementer"); assert.strictEqual(cur.open[0].kind, "boundary");
  assert.strictEqual(cur.open[0].choices.length, 2); assert.strictEqual(cur.open[0].choices[0].ifChosen, "다음부터 메모");
  assert.strictEqual(cur.open[0].recommend, "add-oos");
  const again = run([...base, "--recommend", "add-oos"]);
  assert.strictEqual(again.status, 0); assert.ok(again.stdout.includes("이미 기록됨") || again.stdout.includes("Already recorded"), again.stdout);
  assert.strictEqual(CL.readDecisions(WS4).rows.length, 1);
});

t("CLI list/choose/delegate/metrics — 양식 출력·전제 지문 재대조(불일치 exit 3)·기록·위임·집계", () => {
  const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws5-"));
  const run = runIn(WS5);
  const HASH_NOW = sha1("core-envelope-now");
  const o = CL.openDecision(WS5, spec({ targetFp: HASH_NOW }));
  const l = run(["decisions", "list"]);
  assert.strictEqual(l.status, 0, l.stderr);
  assert.ok(l.stdout.includes(o.decisionId) && l.stdout.includes("add-oos") && l.stdout.includes(CL.DECISION_DELEGATE_KEY) && l.stdout.includes("구현자가 못 정하는 이유"), l.stdout);
  const c1 = run(["decisions", "choose", o.decisionId, "add-oos"]); // 계약에 승인 지문 없음 → 전제 불일치
  assert.strictEqual(c1.status, 3, c1.stdout + c1.stderr);
  assert.strictEqual(CL.readDecisions(WS5).open.length, 1);
  assert.ok(Number(CL.setEnvelopeHashAllSlots(WS5, HASH_NOW)) >= 1);
  const c2 = run(["decisions", "choose", o.decisionId, "add-oos"]);
  assert.strictEqual(c2.status, 0, c2.stdout + c2.stderr);
  assert.strictEqual(CL.readDecisions(WS5).latest.get(o.decisionId).status, "chosen");
  assert.strictEqual(run(["decisions", "choose", o.decisionId, "keep"]).status, 3);
  const o2 = CL.openDecision(WS5, spec({ targetFp: HASH_NOW, question: "두 번째 방향 질문" }));
  const dg = run(["decisions", "delegate", o2.decisionId]);
  assert.strictEqual(dg.status, 0, dg.stdout + dg.stderr);
  assert.strictEqual(CL.readDecisions(WS5).latest.get(o2.decisionId).status, "delegated");
  const mt = run(["decisions", "metrics", "--campaign", spec().campaignId]);
  assert.strictEqual(mt.status, 0, mt.stderr);
  const mj = JSON.parse(mt.stdout);
  assert.strictEqual(mj.total, 2); assert.strictEqual(mj.chosen, 1); assert.strictEqual(mj.delegated, 1); assert.strictEqual(mj.open, 0);
  assert.strictEqual(run(["decisions", "choose", o2.decisionId]).status, 2);
  const e = run(["decisions", "list"]);
  assert.ok(e.stdout.includes("열린 결정 없음") || e.stdout.includes("No open decisions"), e.stdout);
});

t("실경로 — 전량 강등 보류 판정은 사용자 결정을 만들지 않고 판단 관문 마커를 건다(판정 '보류' 유지)", () => {
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
  assert.ok(r.notice.includes("[판단 관문 걸림]") && r.notice.includes("round-judge ask-d3"), r.notice);
  assert.ok(!r.notice.includes("[결정 장부]"), "no auto decision notice");
  assert.strictEqual(CL.readDecisions(wsE).rows.length, 0, "harness must not create a user decision");
  assert.deepStrictEqual(CL.judgeRequiredPending(wsE).map((x) => x.askId), ["ask-d3"], "judgment gate marker armed");
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
});

t("소스 핀 — 하네스 자동 생산자 없음(openDecision 호출은 CLI raise 1곳뿐)·전량 강등 분기는 관문 장전만·decisions 분기 존재", () => {
  const src = fs.readFileSync(bridge, "utf8");
  assert.strictEqual((src.match(/openDecision\(/g) || []).length, 1, "openDecision must be called only from decisions raise");
  assert.ok(src.includes('origin: "implementer"'));
  assert.ok(!src.includes('origin: "all-oos-demoted"') && !src.includes("recordAllOosDemotedDecision") && !src.includes("scopeDemotedJudgeNotice"));
  const i = src.indexOf('machine.reasonKey = "scope-demoted";');
  assert.ok(i > 0);
  assert.ok(src.slice(i, i + 900).includes("out.push(armScopeDemotedJudge(ws, camp, askId, en, repoKeySnap));"));
  assert.ok(src.includes('case "decisions":'));
  assert.deepStrictEqual(CL.DECISION_ORIGINS, ["implementer"]);
});

t("결정 블록 서식 — 사용자 편집(기본지침 파일의 decisionBlock)이 렌더·마감 검사에 함께 반영, 자리표시자 빠진 서식은 거부·기본 폴백", () => {
  const VH = require("../bridge/verify-cap-handoff.js");
  const WS7 = fs.mkdtempSync(path.join(os.tmpdir(), "decisions-ws7-"));
  const d0 = CL.openDecision(WS7, spec({ targetFp: "" }));
  const before = CL.renderDecisionBlock(CL.readDecisions(WS7).latest.get(d0.decisionId), false);
  assert.ok(before.includes("구현자가 못 정하는 이유:"), before);
  // 사용자가 낱말을 고침: '왜:' → '배경:', '구현자가 못 정하는 이유:' → '제가 정할 수 없는 까닭:'
  const tpl = Object.assign({}, CL.DECISION_TEMPLATE_DEFAULTS.ko, { why: "  배경: {{why}}", noDefault: "  제가 정할 수 없는 까닭: {{noDefault}}" });
  assert.strictEqual(CL.saveDecisionTemplate(tpl, "ko").ok, true);
  assert.strictEqual(CL.loadDecisionTemplate("ko").overridden, true);
  const after = CL.renderDecisionBlock(CL.readDecisions(WS7).latest.get(d0.decisionId), false);
  assert.ok(after.includes("제가 정할 수 없는 까닭:") && after.includes("배경:") && !after.includes("구현자가 못 정하는 이유:"), after);
  // 마감 검사기도 같은 서식을 따른다: 새 서식 블록=승인 / 옛 낱말 블록=거부
  const ctx = { evidence: [], alertKind: "verdict-nonclean", unavailable: false, decisions: [{ id: d0.decisionId, question: spec().question, renderKo: after, renderEn: "" }], backlogItems: [], backlogHealthy: true };
  const closeout = (block) => `[검증 상한 인계]\n[수용·처리]\n없음\n[반박·종결]\n없음\n[보관함 이관]\n없음\n[사용자 판단 필요]\n${block}\n[잔여 위험 판단]\n다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.\n[경고등 의미]\nverdict-nonclean 빨강은 통과 인증이 없다는 뜻이라 남고, 이 마감은 검증 통과가 아닙니다.\n[권장]\n사용자 판단 없이 처리 내용을 유지하고 다음 변경 때 다시 확인하기를 권장합니다.`;
  assert.strictEqual(VH.validateCapHandoff(closeout(after), ctx).ok, true, "new-template block accepted");
  assert.strictEqual(VH.validateCapHandoff(closeout(before), ctx).ok, false, "old-label block rejected after the user edited the template");
  // 세 축 저장이 서식 오버라이드를 지우지 않는다(ab-2)
  const def = CL.baseDefaultsFor("ko", "core");
  assert.strictEqual(CL.saveBaseDirective({ verifyBaseline: def.verifyBaseline + "\n사용자 추가 원칙", transmit: def.transmit, rejudge: def.rejudge }, "ko", "core"), true);
  assert.strictEqual(CL.loadDecisionTemplate("ko").overridden, true, "template override survives base-directive save");
  assert.ok(CL.loadBaseDirective("ko", "core").verifyBaseline.includes("사용자 추가 원칙"));
  // [3회차] 자리표시자 재배치 서식도 렌더=검사: 헤더 "- 사용자 선택: {{question}} [{{id}}]"
  assert.strictEqual(CL.saveDecisionTemplate(Object.assign({}, tpl, { choice: "  {{n}}번 {{label}} ({{key}}) → {{ifChosen}}" }), "ko").reason, "prefix-required:choice", "자리표시자로 시작하는 줄은 본문 내용이 헤더로 위장할 수 있어 거부");
  const rearranged = Object.assign({}, tpl, { header: "- 사용자 선택: {{question}} [{{id}}]", choice: "  선택지 {{n}}번 {{label}} ({{key}}) → {{ifChosen}}" });
  assert.strictEqual(CL.saveDecisionTemplate(rearranged, "ko").ok, true);
  const rr = CL.renderDecisionBlock(CL.readDecisions(WS7).latest.get(d0.decisionId), false);
  assert.ok(rr.startsWith("- 사용자 선택: ") && rr.includes("[" + d0.decisionId + "]") && rr.includes("선택지 1번 "), rr);
  const ctxR = Object.assign({}, ctx, { decisions: [{ id: d0.decisionId, question: spec().question, renderKo: rr, renderEn: "" }] });
  assert.strictEqual(VH.validateCapHandoff(closeout(rr), ctxR).ok, true, "rearranged-template block accepted by the checker");
  assert.strictEqual(VH.validateCapHandoff(closeout(after), ctxR).ok, false, "previous-template block rejected once the template changed");
  assert.strictEqual(CL.saveDecisionTemplate(tpl, "ko").ok, true); // 원래 편집본으로 복귀
  // [4회차] 줄 구분 계약: 머리말 없는 헤더·헤더 머리말과 겹치는 답하기 줄은 저장 거부(모호 서식 원천 차단 → 렌더=검사 불일치 불가)
  assert.strictEqual(CL.saveDecisionTemplate(Object.assign({}, tpl, { header: "{{question}} {{id}}", answer: "답하기 {{id}}" }), "ko").reason, "prefix-required:header");
  assert.strictEqual(CL.saveDecisionTemplate(Object.assign({}, tpl, { header: "- 결정 {{id}}: {{question}}", answer: "- 결정 답하기 {{id}}" }), "ko").reason, "prefix-ambiguous:answer");
  assert.strictEqual(CL.saveDecisionTemplate(Object.assign({}, tpl, { header: "- {{id}} {{question}}", why: "- {{why}}" }), "ko").reason, "prefix-ambiguous:why");
  assert.strictEqual(CL.validateDecisionTemplate(CL.DECISION_TEMPLATE_DEFAULTS.en).ok, true);
  // [3회차 ab-3] 선택 결과({{ifChosen}})를 뺀 서식=정보 누락 → 저장 거부
  assert.strictEqual(CL.saveDecisionTemplate(Object.assign({}, tpl, { choice: "  선택 ({{key}}): {{label}}" }), "ko").reason, "slot:choice:{{ifChosen}}");
  // 자리표시자 빠진 서식=저장 거부·파일에 직접 넣어도 기본 폴백+경고
  assert.strictEqual(CL.saveDecisionTemplate(Object.assign({}, tpl, { noDefault: "  까닭: 없음" }), "ko").ok, false);
  const file = CL.baseDirectiveFileFor("ko", "core");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")); raw.decisionBlock = Object.assign({}, tpl, { header: "- 결정: {{question}}" }); fs.writeFileSync(file, JSON.stringify(raw));
  const bad = CL.loadDecisionTemplate("ko");
  assert.strictEqual(bad.overridden, false); assert.ok(bad.warn.startsWith("decision-template-invalid:slot:header"), bad.warn);
  assert.ok(CL.renderDecisionBlock(CL.readDecisions(WS7).latest.get(d0.decisionId), false).includes("구현자가 못 정하는 이유:"), "fallback to default render");
  // [3회차] 비객체·문법 손상도 경고(fail-visible)
  fs.writeFileSync(file, JSON.stringify({ decisionBlock: "broken" }));
  assert.strictEqual(CL.loadDecisionTemplate("ko").warn, "decision-template-invalid:not-object");
  fs.writeFileSync(file, '{"decisionBlock":');
  assert.strictEqual(CL.loadDecisionTemplate("ko").warn, "decision-template-file-corrupt");
  fs.writeFileSync(file, JSON.stringify(Object.assign({}, raw, { decisionBlock: Object.assign({}, tpl, { header: "- 결정: {{question}}" }) })));
  // CLI: template show/set/reset
  const run = runIn(WS7);
  const shown = run(["decisions", "template", "show"]); assert.strictEqual(shown.status, 3, "invalid override → warn exit 3"); assert.ok(shown.stdout.includes("decision-template-invalid"));
  const tf = path.join(WS7, "tpl.json"); fs.writeFileSync(tf, JSON.stringify(tpl));
  assert.strictEqual(run(["decisions", "template", "set", tf]).status, 0);
  assert.ok(run(["decisions", "render", d0.decisionId]).stdout.includes("제가 정할 수 없는 까닭:"));
  assert.strictEqual(run(["decisions", "template", "reset"]).status, 0);
  assert.strictEqual(CL.loadDecisionTemplate("ko").overridden, false);
  assert.ok(CL.loadBaseDirective("ko", "core").verifyBaseline.includes("사용자 추가 원칙"), "reset keeps the other axes");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
