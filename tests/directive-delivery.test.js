"use strict";
/*
 * [HARNESS-REALIGNMENT §4-B ①② · 규약 1회 전달 — 2026-08-31] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약(문서 §4-B '사고·회귀 방지 시험' 1·5·6): 재전송 트리거(세대 변경/보낸 시각 뒤 compacted/검증 도중 compacted=postflight 보류/기록 판독 실패=재전송) ·
 * 표시 세 곳=전달 레코드 한 곳 파생(머리 첫 줄=판정 하단 상태 줄) · 실행 중 편집=시작 시 조립분 불변·다음 ask에서 성분 표기 ·
 * 사용자 글(계약 규칙) 바이트 그대로 · 무상태/시험 목(carrier.delivery 없음)=종전 전문 무회귀.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const BRIDGE = path.join(__dirname, "..", "bridge", "codex-bridge.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NL = String.fromCharCode(10);

// 픽스처: 승인된 수칙서 + 계약(사용자 검증자 규칙 2줄)
const repoE = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-repo-"));
fs.writeFileSync(path.join(repoE, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["혼자 쓰는 로컬 PC"], alwaysBlocker: ["기록이 남의 장부에 적히는 일"], outOfScope: ["서버 두 대에 동시 배포"] }));
const shaE = CL.readVerifyEnvelope(repoE).sha1;
const wsE = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-ws-"));
const USER_RULES = ["기술용어를 제외하고 상황예시로 정리하라", "  파일·라인을 근거로 대라  "]; // 둘째 줄=앞뒤 공백(정규화 후 내용 보존)
CL.updateContractPatch(wsE, "ko", { envelopeHash: shaE, scoutRepo: repoE, codex: USER_RULES }, { tries: 3 });
const contract = CL.loadContract(wsE, "ko");
const rolloutDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-rollout-"));
const rolloutFile = path.join(rolloutDir, "rollout-2026-08-31T00-00-00-sess-aaaa.jsonl");
const line = (o) => JSON.stringify(o) + NL;
const T0 = "2026-08-31T00:00:10.000Z";
fs.writeFileSync(rolloutFile, line({ timestamp: "2026-08-31T00:00:00.000Z", type: "session_meta", payload: { id: "sess-aaaa", cwd: wsE } })
  + line({ timestamp: "2026-08-31T00:00:05.000Z", type: "compacted", payload: { message: "" } })); // 전달 '이전' 압축=무관
const SESS = "sess-aaaa";
const inj = CL.buildInjection(USER_RULES, "Codex", contract.codexChecklist, "ko"); // 계약 기본=체크리스트 켬([고정 계약] 형태) — withContract와 같은 인자
const ask = (carrier, askId) => CB.withContract("요청 본문 — 잠금 경합 확인", wsE, "ko", carrier, "core", contract, askId || "ask-1");

t("세대 지문 — 같은 성분=같은 G · 성분 하나 바뀌면 G 변경+그 성분만 다름", () => {
  const a = CL.directiveGenOf({ baseline: "b", qual: "q", v2fixed: "v", contract: "c", profile: "core", lang: "ko" });
  const b = CL.directiveGenOf({ baseline: "b", qual: "q", v2fixed: "v", contract: "c", profile: "core", lang: "ko" });
  const c = CL.directiveGenOf({ baseline: "b", qual: "q", v2fixed: "v", contract: "c2", profile: "core", lang: "ko" });
  assert.strictEqual(a.gen, b.gen); assert.notStrictEqual(a.gen, c.gen);
  assert.deepStrictEqual(CL.DIRECTIVE_PART_KEYS.filter((k) => a.parts[k] !== c.parts[k]), ["contract"]);
});

t("압축 감지 — 보낸 시각 뒤 compacted만 / 시각 없는 compacted=보수적 참 / 파일 없음=판독 불가(안전 방향)", () => {
  assert.deepStrictEqual(CL.rolloutCompactedAfter(rolloutFile, T0), { st: "ok", compacted: false, ts: null });
  assert.strictEqual(CL.rolloutCompactedAfter(rolloutFile, "2026-08-31T00:00:01.000Z").compacted, true);
  const f2 = path.join(rolloutDir, "r2.jsonl"); fs.writeFileSync(f2, line({ type: "compacted", payload: {} }));
  assert.strictEqual(CL.rolloutCompactedAfter(f2, T0).compacted, true);
  assert.strictEqual(CL.rolloutCompactedAfter(path.join(rolloutDir, "none.jsonl"), T0).st, "unreadable");
  assert.strictEqual(CL.rolloutCompactedAfter("", T0).st, "unreadable");
});

let fullHead = "", fullOut = null;
t("첫 판(기록 없음)=전문 — 머리 첫 줄이 상태 줄이고 기본 원칙·지적 서식·사용자 규칙(내용 그대로 — 종전 주입 규약의 공백 정리만 예외)이 실린다 · carrier.delivery 없음=종전 머리 무회귀", () => {
  const legacy = CB.withContract("요청 본문 — 잠금 경합 확인", wsE, "ko", {}, "core", contract, "ask-0");
  assert.ok(!legacy.startsWith("[규약 전달]") && legacy.includes("[검증 기본 원칙") && legacy.includes(inj), "no delivery input = previous full head");
  const carrier = { delivery: { session: SESS, rolloutFile } };
  fullHead = ask(carrier); fullOut = carrier.deliveryOut;
  assert.strictEqual(fullOut.mode, "full"); assert.strictEqual(fullOut.reason, "no-record");
  const first = fullHead.split(NL)[0];
  assert.strictEqual(first, fullOut.statusLine);
  assert.ok(first.startsWith("[규약 전달] 세대 " + fullOut.gen.slice(0, 8) + " · 이번 판 전문 전송(사유: 전달 기록 없음)"), first);
  assert.ok(fullHead.includes("[검증 기본 원칙") && fullHead.includes("[지적 서식 v2") && fullHead.includes("[검증 경계 —") && fullHead.includes(inj), "full head carries canon+format+data+user rules verbatim");
  assert.ok(fullHead.includes(JSON.stringify({ n: 2, r: "파일·라인을 근거로 대라" }).slice(1, -1)), "user rule content unchanged — the only normalization is the pre-existing injection contract (surrounding whitespace trimmed, empty items dropped; no wording change)");
  assert.ok(fullHead.includes(JSON.stringify({ n: 1, r: USER_RULES[0] }).slice(1, -1)), "rule 1 byte-identical inside the injected JSON");
});

t("전달 레코드 — 호출 직전 pending 기록 → pending이면 다음 판도 전문 → postflight(압축 없음)로 확정 → 이후 판=상태 줄만(slim)", () => {
  assert.strictEqual(CB.recordDeliveryBeforeCall(SESS, { deliveryOut: fullOut }, T0, rolloutFile, "ask-1", wsE), true);
  const rec = CL.readDirectiveDelivery(SESS);
  assert.ok(rec && rec.pending === true && rec.gen === fullOut.gen && rec.sentAt === T0 && rec.askId === "ask-1");
  const c2 = { delivery: { session: SESS, rolloutFile } }; ask(c2, "ask-1b");
  assert.strictEqual(c2.deliveryOut.reason, "pending"); assert.strictEqual(c2.deliveryOut.mode, "full");
  const pf = CB.postflightDelivery(SESS, { deliveryOut: fullOut }, T0, rolloutFile);
  assert.deepStrictEqual(pf, { st: "ok", compacted: false, ts: null });
  assert.strictEqual(CL.readDirectiveDelivery(SESS).pending, false);
  const c3 = { delivery: { session: SESS, rolloutFile } };
  const slim = ask(c3, "ask-2");
  assert.strictEqual(c3.deliveryOut.mode, "slim"); assert.strictEqual(c3.deliveryOut.reason, "delivered");
  assert.strictEqual(slim.split(NL)[0], c3.deliveryOut.statusLine);
  assert.ok(slim.startsWith("[규약 전달] 세대 " + fullOut.gen.slice(0, 8) + " · 재전송 없음 — 규약 전문은 이 세션 " + T0 + " 메시지에 있고"), slim.split(NL)[0]);
  assert.ok(!slim.includes("[검증 기본 원칙") && !slim.includes("[지적 서식 v2") && !slim.includes("[고정 계약") && !slim.includes("[고정 규약") && !slim.includes("[검증 경계 적용"), "slim drops the static directives");
  assert.ok(slim.includes("[검증 경계 —") && slim.includes("> ab-1:") && slim.includes("[작업 요청]"), "slim keeps the boundary DATA and the request");
  assert.ok(fullHead.length - slim.length >= 2000, `slim must save ≥2,000 chars (saved ${fullHead.length - slim.length})`);
  // [§4-B ④] 데이터(열린 지적)는 slim에도 실린다 — 캠페인 장부에 열린 지적을 만들어 확인
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-2";
  assert.strictEqual(CL.writeEnvelopeFreeze(wsE, shaE, "ask-2", { oos: [{ id: "oos-1", title: "서버 두 대에 동시 배포" }] }), true);
  const r = CB.machineFindingsLayer(["본문", "[지적 목록 v2]", JSON.stringify({ tag: "blocker", title: "잠금 경합", origin: "baseline" }), "[지적 목록 끝]", "", "검증: 실패"].join(NL), wsE, "ko", "core", "claude-codex", "ask-2");
  assert.strictEqual(r.machine.effective, "fail");
  const c4 = { delivery: { session: SESS, rolloutFile } };
  const slim2 = ask(c4, "ask-3");
  assert.strictEqual(c4.deliveryOut.mode, "slim");
  assert.ok(slim2.includes("[열린 지적 —") && /> f-[0-9a-f]{8} \[blocker\] 잠금 경합/.test(slim2) && !slim2.includes("[지적 서식 v2"), "open findings (data) ride along in slim; static format prose does not");
});

t("재전송 트리거 ① 규약 변경 — 사용자가 계약 규칙을 고치면 다음 판은 전문+상태 줄에 바뀐 성분 표기(계약의 검증자 지시)", () => {
  CL.updateContractPatch(wsE, "ko", { codex: USER_RULES.concat(["push 전 무결성 프로필 1회"]) }, { tries: 3 });
  const c5 = { delivery: { session: SESS, rolloutFile } };
  const h = CB.withContract("요청", wsE, "ko", c5, "core", CL.loadContract(wsE, "ko"), "ask-4");
  assert.strictEqual(c5.deliveryOut.mode, "full"); assert.strictEqual(c5.deliveryOut.reason, "gen-changed");
  assert.deepStrictEqual(c5.deliveryOut.changed, ["contract"]);
  assert.ok(h.split(NL)[0].includes("규약 변경: 계약의 검증자 지시"), h.split(NL)[0]);
  assert.ok(h.includes("push 전 무결성 프로필 1회"), "new rule text sent verbatim");
  // 프로필 전환=여러 성분 동시 변경 표기
  const c6 = { delivery: { session: SESS, rolloutFile } };
  const h6 = CB.withContract("요청", wsE, "ko", c6, "integrity", CL.loadContract(wsE, "ko"), "ask-4i");
  assert.ok(c6.deliveryOut.changed.includes("baseline") && c6.deliveryOut.changed.includes("profile") && c6.deliveryOut.changed.includes("contract"), JSON.stringify(c6.deliveryOut.changed));
  assert.ok(h6.split(NL)[0].includes("기본 원칙·응답 서식") && h6.split(NL)[0].includes("프로필"), h6.split(NL)[0]);
  // 확정(전문 전송 후 postflight) → 다시 slim
  const T1 = "2026-08-31T00:01:00.000Z";
  assert.strictEqual(CB.recordDeliveryBeforeCall(SESS, c5, T1, rolloutFile, "ask-4", wsE), true);
  CB.postflightDelivery(SESS, c5, T1, rolloutFile);
  const c7 = { delivery: { session: SESS, rolloutFile } }; CB.withContract("요청", wsE, "ko", c7, "core", CL.loadContract(wsE, "ko"), "ask-5");
  assert.strictEqual(c7.deliveryOut.mode, "slim");
});

t("재전송 트리거 ② 보낸 시각 뒤 compacted — 검증자 스레드 기록에 압축이 남으면 다음 판은 전문(사유: 압축 감지 <시각>)", () => {
  fs.appendFileSync(rolloutFile, line({ timestamp: "2026-08-31T00:02:00.000Z", type: "compacted", payload: { message: "" } }));
  const c8 = { delivery: { session: SESS, rolloutFile } };
  const h = CB.withContract("요청", wsE, "ko", c8, "core", CL.loadContract(wsE, "ko"), "ask-6");
  assert.strictEqual(c8.deliveryOut.mode, "full"); assert.strictEqual(c8.deliveryOut.reason, "compacted");
  assert.ok(h.split(NL)[0].includes("압축 감지 2026-08-31T00:02:00.000Z"), h.split(NL)[0]);
  const T2 = "2026-08-31T00:03:00.000Z";
  CB.recordDeliveryBeforeCall(SESS, c8, T2, rolloutFile, "ask-6", wsE); CB.postflightDelivery(SESS, c8, T2, rolloutFile);
  const c9 = { delivery: { session: SESS, rolloutFile } }; CB.withContract("요청", wsE, "ko", c9, "core", CL.loadContract(wsE, "ko"), "ask-7");
  assert.strictEqual(c9.deliveryOut.mode, "slim", "after resend+confirm the old compaction is before sentAt");
});

t("재전송 트리거 ③ 검증 도중 compacted(postflight) — 판정 권위 없음(보류)+판단 관문 마커(re-verify)+레코드 pending → 다음 판 전문", () => {
  const T3 = "2026-08-31T00:04:00.000Z";
  const c10 = { delivery: { session: SESS, rolloutFile } }; CB.withContract("요청", wsE, "ko", c10, "core", CL.loadContract(wsE, "ko"), "ask-8");
  assert.strictEqual(c10.deliveryOut.mode, "slim");
  fs.appendFileSync(rolloutFile, line({ timestamp: "2026-08-31T00:04:30.000Z", type: "compacted", payload: { message: "" } })); // 호출 중 압축
  const pf = CB.postflightDelivery(SESS, c10, T3, rolloutFile);
  assert.deepStrictEqual(pf, { st: "ok", compacted: true, ts: "2026-08-31T00:04:30.000Z" });
  assert.strictEqual(CL.readDirectiveDelivery(SESS).pending, true); assert.strictEqual(CL.readDirectiveDelivery(SESS).pendingWhy, "compacted-mid-ask");
  const mfl = { machine: { effective: "pass", parse: { ok: true, findings: [] } }, notice: "" };
  assert.strictEqual(CB.applyPostflightHold(mfl, c10, wsE, "ask-8", "no-campaign", "ko"), true);
  assert.strictEqual(mfl.machine.effective, "inconclusive"); assert.strictEqual(mfl.machine.demoted, true); assert.strictEqual(mfl.machine.reasonKey, "compacted-mid-ask");
  assert.ok(mfl.notice.includes("[규약 전달 · 보류]") && mfl.notice.includes("round-judge ask-8 re-verify"), mfl.notice);
  assert.ok(CL.machineReasonText(mfl.machine, false).includes("검증 도중 검증자 기억 압축"));
  assert.deepStrictEqual(CL.judgeRequiredPending(wsE).map((x) => [x.askId, x.reason]).filter((x) => x[0] === "ask-8"), [["ask-8", "compacted-mid-ask"]]);
  // [확인 검증 blocker①(ab-3)] 압축 보류는 close-oos로 닫을 수 없다 — re-verify/escalate만
  assert.deepStrictEqual(CL.resolveJudgeRequired(wsE, "ask-8", "close-oos", { note: "범위 밖 종결 시도 — 거부돼야 함" }), { ok: false, reason: "choice-not-allowed", allowed: ["re-verify", "escalate"] });
  assert.deepStrictEqual(CL.judgeRequiredPending(wsE).map((x) => x.askId).filter((x) => x === "ask-8"), ["ask-8"], "marker survives the rejected close-oos");
  assert.strictEqual(CL.resolveJudgeRequired(wsE, "ask-8", "re-verify", { note: "압축 뒤 판정 — 전문 재전송 재판" }).ok, true);
  assert.strictEqual(CB.postflightHeld(c10), true, "held → finishVerifyRun skips the success proof");
  // 판독 불가 postflight=압축 여부 미상 → 같은 보류(권위 없음·증명 미기록)
  const cU = { deliveryOut: fullOut, postflight: { st: "unreadable", compacted: false, ts: null } };
  const mflU = { machine: { effective: "pass" }, notice: "" };
  assert.strictEqual(CB.applyPostflightHold(mflU, cU, wsE, "ask-8u", "no-campaign", "ko"), true);
  assert.strictEqual(mflU.machine.reasonKey, "postflight-unreadable"); assert.ok(mflU.notice.includes("압축 여부 미상") && mflU.notice.includes("통과 증명 미기록"));
  assert.ok(CL.machineReasonText(mflU.machine, false).includes("압축 여부 미상"));
  assert.strictEqual(CL.resolveJudgeRequired(wsE, "ask-8u", "close-oos", { note: "범위 밖 종결 시도 — 거부돼야 함" }).reason, "choice-not-allowed");
  assert.strictEqual(CL.resolveJudgeRequired(wsE, "ask-8u", "re-verify", { note: "판독 불가 — 전문 재전송 재판" }).ok, true);
  assert.strictEqual(CB.postflightHeld(cU), true);
  // 압축 없는 판은 hold 미적용(무회귀)
  const mfl2 = { machine: { effective: "pass" }, notice: "" };
  assert.strictEqual(CB.applyPostflightHold(mfl2, { postflight: { st: "ok", compacted: false } }, wsE, "ask-x", "no-campaign", "ko"), false);
  assert.strictEqual(mfl2.machine.effective, "pass");
  const c11 = { delivery: { session: SESS, rolloutFile } }; const h = CB.withContract("요청", wsE, "ko", c11, "core", CL.loadContract(wsE, "ko"), "ask-9");
  assert.strictEqual(c11.deliveryOut.reason, "pending"); assert.ok(h.includes("[검증 기본 원칙"));
  for (const p9 of CL.judgeRequiredPending(wsE)) CL.resolveJudgeRequired(wsE, p9.askId, "re-verify", { note: "시험 정리 — 잔여 관문은 재검증으로 종결" });
});

t("재전송 트리거 ④ 기록 판독 실패 — rollout을 못 읽으면 안전 방향(전문) · 새 세션 첫 메시지=first · 무상태 검증자=계획 없음", () => {
  const T4 = "2026-08-31T00:05:00.000Z";
  const cA = { delivery: { session: SESS, rolloutFile } }; CB.withContract("요청", wsE, "ko", cA, "core", CL.loadContract(wsE, "ko"), "ask-10");
  CB.recordDeliveryBeforeCall(SESS, cA, T4, rolloutFile, "ask-10", wsE); CB.postflightDelivery(SESS, cA, T4, rolloutFile);
  const cB = { delivery: { session: SESS, rolloutFile: path.join(rolloutDir, "gone.jsonl") } };
  const h = CB.withContract("요청", wsE, "ko", cB, "core", CL.loadContract(wsE, "ko"), "ask-11");
  assert.strictEqual(cB.deliveryOut.reason, "rollout-unreadable"); assert.ok(h.includes("[검증 기본 원칙") && h.split(NL)[0].includes("기록 판독 실패(안전 방향)"));
  // [확인 검증 blocker③] 전달 레코드 자체가 손상/권한 오류면 '기록 없음'이 아니라 '판독 실패'로 표기(둘 다 전문)
  const recF = CL.directiveDeliveryFileFor(SESS); const keep = fs.readFileSync(recF, "utf8");
  fs.writeFileSync(recF, "{not json");
  assert.deepStrictEqual(CL.readDirectiveDeliveryState(SESS), { st: "corrupt", rec: null });
  const cC = { delivery: { session: SESS, rolloutFile } };
  const hC = CB.withContract("요청", wsE, "ko", cC, "core", CL.loadContract(wsE, "ko"), "ask-11c");
  assert.strictEqual(cC.deliveryOut.reason, "record-unreadable"); assert.ok(hC.split(NL)[0].includes("전달 기록 판독 실패(corrupt — 안전 방향)") && hC.includes("[검증 기본 원칙"), hC.split(NL)[0]);
  assert.strictEqual(CL.readDirectiveDeliveryState("sess-none").st, "absent");
  fs.writeFileSync(recF, keep);
  const cN = { delivery: { session: "", rolloutFile: "", first: true } };
  const hN = CB.withContract("요청", wsE, "ko", cN, "core", CL.loadContract(wsE, "ko"), "ask-new");
  assert.strictEqual(cN.deliveryOut.reason, "first"); assert.ok(hN.split(NL)[0].includes("이 세션 첫 메시지"));
  // 새 세션: id가 알려진 뒤 기록+postflight → 확정
  const rfN = path.join(rolloutDir, "rollout-new-sess-bbbb.jsonl"); fs.writeFileSync(rfN, line({ timestamp: "2026-08-31T00:06:00.000Z", type: "session_meta", payload: { id: "sess-bbbb" } }));
  CB.recordDeliveryBeforeCall("sess-bbbb", cN, "2026-08-31T00:06:00.000Z", rfN, "ask-new", wsE); CB.postflightDelivery("sess-bbbb", cN, "2026-08-31T00:06:00.000Z", rfN);
  const recN = CL.readDirectiveDelivery("sess-bbbb"); assert.ok(recN && recN.pending === false && recN.reason === "first" && recN.rolloutFile === rfN);
  const cS = {}; CB.withContract("요청", wsE, "ko", cS, "core", CL.loadContract(wsE, "ko"), "ask-stateless");
  assert.strictEqual(cS.deliveryOut, undefined, "stateless verifier / no delivery input = no plan, no status line");
});

t("실행 중 편집 — 조립 뒤 계약을 고쳐도 이미 조립된 머리·G는 그대로, 다음 ask에서만 새 G+성분 표기", () => {
  const cA = { delivery: { session: SESS, rolloutFile } };
  const hA = CB.withContract("요청", wsE, "ko", cA, "core", CL.loadContract(wsE, "ko"), "ask-12");
  const genA = cA.deliveryOut.gen; const snapA = hA;
  CL.updateContractPatch(wsE, "ko", { codex: USER_RULES.concat(["편집 중 추가된 규칙"]) }, { tries: 3 }); // 검증 도중 사용자 편집
  assert.strictEqual(hA, snapA); assert.strictEqual(cA.deliveryOut.gen, genA);
  const cB = { delivery: { session: SESS, rolloutFile } };
  const hB = CB.withContract("요청", wsE, "ko", cB, "core", CL.loadContract(wsE, "ko"), "ask-13");
  assert.notStrictEqual(cB.deliveryOut.gen, genA); assert.deepStrictEqual(cB.deliveryOut.changed, ["contract"]);
  assert.ok(hB.includes("편집 중 추가된 규칙") && hB.split(NL)[0].includes("규약 변경: 계약의 검증자 지시"));
});

t("소스 계약 — 이어 쓰기/새 세션 배선 순서·판정 하단 상태 줄=머리 첫 줄과 같은 문자열·판정 행에 delivery·v2DirectiveFor=정적+데이터 무회귀", () => {
  const src = fs.readFileSync(BRIDGE, "utf8");
  const iD = src.indexOf('attCarrier.delivery = { session: link.codexSession, rolloutFile: rolloutFile9 };');
  const iW = src.indexOf("withContract(prompt + (net ? netNote(langSnap) : \"\"), ws, langSnap, attCarrier, profileSnap, contractSnap, askId); // 프롬프트 조립은 측정 밖(1차 blocker①)\n    const callStartIso9");
  const iR = src.indexOf("recordDeliveryBeforeCall(link.codexSession, attCarrier, callStartIso9, rolloutFile9, askId, ws);");
  const iC = src.indexOf('runCodex(["resume", link.codexSession');
  const iP = src.indexOf("postflightDelivery(link.codexSession, attCarrier, callStartIso9, rolloutFile9);");
  assert.ok(iD > 0 && iW > iD && iR > iW && iC > iR && iP > iC, "resume: delivery input → assemble → pending record → call → postflight");
  assert.ok(src.includes('attCarrier.delivery = { session: "", rolloutFile: "", first: true };') && src.includes("recordDeliveryBeforeCall(id, attCarrier, callStartIso9, rfN, askId, ws); postflightDelivery(id, attCarrier, callStartIso9, rfN);"), "new session: first message + record after id known");
  assert.ok(src.includes("applyPostflightHold(mfl, attCarrier, ws, askId, campSnap, langSnap);") && src.indexOf("applyPostflightHold(mfl, attCarrier") < src.indexOf("flagVerdict(answer, ws, verifierSession, modeSnap, mfl.machine"), "hold applied before the verdict row is written");
  assert.ok(src.includes("const held9 = postflightHeld(attCarrier);") && src.includes("const proofBind = held9 ? {} : (writeProof(verifierSession, answer, ws) || {});") && src.includes("if (!held9) attempt.proofAccepted();"), "held verdict → no success proof (exit guard sees no proof this turn)");
  const lib = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(lib.includes('if (holdReason && choice === "close-oos") return { ok: false, reason: "choice-not-allowed"'), "hold markers cannot be closed as out-of-scope");
  // [확인 검증 2회차 blocker(ab-6)] 보류 판은 정직 실패로 닫힌다 — 출력 전달 뒤 비0 종료 → worker=failed → ask-wait 영수증 불요·같은 턴 ask-start 허용
  assert.strictEqual(CB.HOLD_EXIT_CODE, 4);
  const iOut9 = src.indexOf("process.stdout.write(outText);"), iHold9 = src.indexOf("if (held9) { // [ab-6 봉합]"), iExit9 = src.indexOf("process.exitCode = HOLD_EXIT_CODE;");
  assert.ok(iOut9 > 0 && iHold9 > iOut9 && iExit9 > iHold9, "held: output first, then non-zero exit inside finishVerifyRun");
  const worker = fs.readFileSync(path.join(__dirname, "..", "bridge", "ask-job-worker.js"), "utf8");
  assert.ok(worker.includes('state: ok ? "succeeded" : "failed", exitCode: code,'), "worker records a non-zero child as failed (no checkpoint path: proof absent → no checkpoint)");
  assert.ok(/function unretrievedSameTurnJob[\s\S]{0,900}j\.state !== "succeeded"\) continue;/.test(src), "same-turn uncollected check ignores failed jobs → new ask-start allowed");
  assert.ok(src.includes('if (j.state === "failed") process.exit(Number.isInteger(j.exitCode) && j.exitCode !== 0 ? j.exitCode : 1);'), "ask-wait returns a failed job's output without a receipt");
  assert.ok(src.includes('+ (attCarrier && attCarrier.deliveryOut && attCarrier.deliveryOut.statusLine ? "\\n" + attCarrier.deliveryOut.statusLine : "")'), "status line under the verdict = same string as the head's first line");
  assert.ok(src.includes("delivery: { gen: attCarrier.deliveryOut.gen, mode: attCarrier.deliveryOut.mode, reason: attCarrier.deliveryOut.reason"), "verdict row carries the delivery record projection");
  const wsEmpty = fs.mkdtempSync(path.join(os.tmpdir(), "dlv-empty-"));
  assert.strictEqual(CB.v2DirectiveFor(wsEmpty, "ko"), CB.v2StaticDirective("ko"), "no data → v2 directive = static prose only (byte-identical to before)");
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(ext.includes('dl9.indexOf("[규약 전달]")===0') && ext.includes("규약 전문 전송") && ext.includes("directives not resent"), "dashboard card title + overview badge derive from the same status line");
});

delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
console.log(`\n결과: ${n} 통과 / 0 실패`);
