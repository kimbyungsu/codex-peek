"use strict";
/*
 * [HARNESS-REALIGNMENT §7 4-1 · 개선 3 보고 양식 경비원 + P6 서식 재발급 절 + P10 마감문 회차 대조 — 2026-09-01] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 파일을 바꾼 턴·상한 마감 턴의 '마지막 답'에 세 칸 제목(무엇이 바뀌었나/이런 상황이 이렇게 됨/다음에 할 일 · en 동형)이 있어야 종료(제목 존재만·내용 무검사·
 * 마지막 답 없는 턴은 대상 아님·사용자 규칙은 그대로) · 검증자 블록 손상=줄·사유가 다음 요청 절로 자동 동봉(원문 없음)·정상 판독=소거 · 마감문 회차 숫자≠장부=미수락.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const VH = require("../bridge/verify-cap-handoff.js");
const GUARD = path.join(__dirname, "..", "bridge", "verify-guard.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NL = String.fromCharCode(10);

t("보고 양식 검사 — 세 제목이 마크다운·굵게·대괄호·글머리 어느 모양이든 인정, 뒤에 글자가 바로 이어지면 불인정, 한/영 어느 한 벌이면 통과", () => {
  const okKo = ["## 무엇이 바뀌었나", "본문", "**이런 상황이 이렇게 됨**", "예", "- [다음에 할 일]:", "계획"].join(NL);
  assert.deepStrictEqual(VH.reportShapeCheck(okKo), { ok: true, lang: "ko", missing: [] });
  const okEn = ["# What changed", "x", "## One scenario (before/after)", "y", "## Next steps — user approval", "z"].join(NL);
  assert.deepStrictEqual(VH.reportShapeCheck(okEn), { ok: true, lang: "en", missing: [] });
  const miss = VH.reportShapeCheck(["## 무엇이 바뀌었나", "본문", "다음에 할 일은 없음"].join(NL));
  assert.deepStrictEqual(miss, { ok: false, lang: "ko", missing: ["이런 상황이 이렇게 됨", "다음에 할 일"] }, "'다음에 할 일은' — title followed by a letter is not a heading");
  assert.strictEqual(VH.reportShapeCheck("").ok, false);
  assert.strictEqual(VH.reportShapeCheck("무엇이 바뀌었나에 대해 말하면").ok, false, "inline mention is not a heading");
  const ins = VH.reportShapeInstruction("ko", ["다음에 할 일"], false);
  assert.ok(ins.includes("[보고 양식 · 경비원]") && ins.includes("빠진 칸: 다음에 할 일") && ins.includes("## 무엇이 바뀌었나"));
  assert.ok(VH.reportShapeInstruction("en", [], true).includes("A cap-closeout turn") && VH.reportShapeInstruction("en", [], true).includes("Missing: What changed, One scenario, Next steps"));
  assert.deepStrictEqual(VH.REPORT_SECTIONS, { ko: ["무엇이 바뀌었나", "이런 상황이 이렇게 됨", "다음에 할 일"], en: ["What changed", "One scenario", "Next steps"] });
});

// ── 종료 훅 실행 반례(verify-guard 시험 하네스와 같은 방식) ──
function normWs(p) { return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC"); }
function setup(name, verifyMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs_" + name + "_"));
  const bridgeDir = path.join(dir, ".codex-bridge"); const ws = path.join(dir, "ws");
  fs.mkdirSync(path.join(bridgeDir, "contracts"), { recursive: true }); fs.mkdirSync(ws, { recursive: true });
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(bridgeDir, "contracts", key + ".json"), JSON.stringify({ verifyMode: verifyMode || "always" }));
  return { dir, bridgeDir, ws, session: "sess-" + name, tx: path.join(dir, "tx.jsonl") };
}
const T0 = "2026-09-01T10:00:00.000Z", TW = "2026-09-01T10:00:01.000Z", TP = "2026-09-01T10:00:05.000Z", TA = "2026-09-01T10:00:06.000Z";
const human = (sb, ts) => ({ type: "user", sessionId: sb.session, timestamp: ts, message: { content: [{ type: "text", text: "고쳐줘" }] } });
const write = (sb, ts) => ({ type: "assistant", sessionId: sb.session, timestamp: ts, message: { content: [{ type: "tool_use", name: "Write", input: {} }] } });
const say = (sb, ts, text) => ({ type: "assistant", sessionId: sb.session, timestamp: ts, message: { content: [{ type: "text", text }] } });
const putTx = (sb, entries) => fs.writeFileSync(sb.tx, entries.map((e) => JSON.stringify(e)).join(NL));
const putProof = (sb, ts) => { fs.mkdirSync(path.join(sb.bridgeDir, "proofs"), { recursive: true }); fs.writeFileSync(path.join(sb.bridgeDir, "proofs", sb.session + ".json"), JSON.stringify({ v: 1, claudeSession: sb.session, workspace: sb.ws, ts, codexSession: "x", exit: 0, status: "success", answerChars: 120 })); };
const runGuard = (sb) => cp.spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ transcript_path: sb.tx, cwd: sb.ws, session_id: sb.session, stop_hook_active: false }), encoding: "utf8", timeout: 30000, env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir, CLAUDE_CODE_SESSION_ID: sb.session, CLAUDE_PROJECT_DIR: sb.ws }) });
const reasonOf = (r) => { try { const o = JSON.parse((r.stdout || "").trim()); return o.decision === "block" ? String(o.reason) : ""; } catch { return ""; } };
const R3 = "## 무엇이 바뀌었나" + NL + "잠금 경합 봉합" + NL + "## 이런 상황이 이렇게 됨" + NL + "두 창이 동시에 저장해도 한쪽이 기다립니다." + NL + "## 다음에 할 일" + NL + "푸시는 승인 뒤.";

t("종료 훅 — 파일 바꾼 턴+통과 증명인데 마지막 답에 세 칸이 없으면 '보고 양식' 사유로 차단(검증 재촉 아님) · 세 칸을 넣으면 종료 허용 · 도구만 있고 답이 없는 턴은 대상 아님", () => {
  const a = setup("noreport");
  putTx(a, [human(a, T0), write(a, TW), say(a, TA, "고쳤습니다. 커밋 abc.")]); putProof(a, TP);
  const r1 = runGuard(a);
  assert.ok(reasonOf(r1).includes("[보고 양식 · 경비원]") && reasonOf(r1).includes("빠진 칸: 무엇이 바뀌었나, 이런 상황이 이렇게 됨, 다음에 할 일") && !reasonOf(r1).includes("ask-start"), reasonOf(r1));
  putTx(a, [human(a, T0), write(a, TW), say(a, TA, "정리:" + NL + R3)]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "three titles present → allowed");
  putTx(a, [human(a, T0), write(a, TW), say(a, TA, "중간 설명 없음"), say(a, "2026-09-01T10:00:07.000Z", R3)]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "only the LAST reply is checked");
  const b = setup("noreply"); putTx(b, [human(b, T0), write(b, TW)]); putProof(b, TP);
  assert.strictEqual(reasonOf(runGuard(b)), "", "no reply text at all → not a report-shape case");
  const c = setup("noedit"); putTx(c, [human(c, T0), say(c, TA, "질문에 답만 했습니다.")]); putProof(c, TP);
  assert.strictEqual(reasonOf(runGuard(c)), "", "no file change → no report-shape requirement");
  const d = setup("noproof"); putTx(d, [human(d, T0), write(d, TW), say(d, TA, "고쳤습니다")]);
  assert.ok(reasonOf(runGuard(d)).includes("통과 증명이 없다"), "without proof the verification demand comes first (unchanged)");
});

t("종료 훅 — 세 칸이 있어도 영문 한 벌이면 통과 · 반복 차단은 기존 상한으로 유계(보고 양식 사유가 epoch에 포함)", () => {
  const a = setup("en");
  putTx(a, [human(a, T0), write(a, TW), say(a, TA, "## What changed" + NL + "x" + NL + "## One scenario" + NL + "y" + NL + "## Next steps" + NL + "z")]); putProof(a, TP);
  assert.strictEqual(reasonOf(runGuard(a)), "");
  const src = fs.readFileSync(GUARD, "utf8");
  assert.ok(src.includes("reportOk, residual:") && src.includes("if ((!needVerify || verified) && residualOk && judgeOk && reportOk) {") && src.includes("reportShapeInstruction(en ? \"en\" : \"ko\", report.missing, false)"), "guard wiring");
  const hook = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  assert.ok(hook.includes("const report=edited&&lastReply?reportShapeCheck(lastReply)") && hook.includes("gate.ok&&residualOk&&judgeOk&&report.ok") && hook.includes("capReached&&capCloseout.ok&&closeReport.ok") && hook.includes("reportOk:report.ok"), "codex-hook mirrors the gate (C-C implementer)");
  assert.ok(hook.includes("if(!needed&&residualOk&&judgeOk&&report.ok)") && hook.indexOf("const report=edited&&lastReply") < hook.indexOf("if(!needed&&residualOk&&judgeOk&&report.ok)") && hook.includes("(gate.ok||!needed)&&residualOk"), "codex-hook: report check precedes the not-needed early return (off mode covered)");
  assert.ok(hook.includes("const closeReport=capReached?reportShapeCheck(lastReply)") && src.includes("const closeReport = capReached ? reportShapeCheck(lastReply)"), "closeout turn checks the LAST reply (not the aggregate)");
  // [2회차 blocker] C-C off 모드도 Claude 경로와 같은 경계: 잔여 마커·판단 관문·상한을 안 보고 세 칸만
  assert.ok(hook.includes('const vmOff=vmCc==="off"') && hook.includes("let residual=vmOff?null:readResidual(ws)") && hook.includes("const judgePending=vmOff?[]:judgeRequiredPending(ws)") && hook.includes("const capReached=!vmOff&&progress.tracked"), "codex-hook off mode = report guard only (no residual/judge/cap)");
  assert.ok(src.includes("let residual = verifyOff ? null : readResidual(ws)") && src.includes("const judgePending = verifyOff ? [] : judgeRequiredPending(ws)") && src.includes("const capReached = !verifyOff && progress.tracked"), "verify-guard off mode = report guard only");
});

t("종료 훅 — 검증 모드 off라도 파일 바꾼 턴의 세 칸은 요구(검증 증명 없이·검증 재촉 없음) · 세 칸 있으면 종료 · 파일 변경 없으면 대상 아님", () => {
  const a = setup("off", "off");
  putTx(a, [human(a, T0), write(a, TW), say(a, TA, "고쳤습니다.")]);
  const r1 = reasonOf(runGuard(a));
  assert.ok(r1.includes("[보고 양식 · 경비원]") && !r1.includes("ask-start") && !r1.includes("통과 증명"), r1 || "(allowed — off mode bypassed the guard)");
  putTx(a, [human(a, T0), write(a, TW), say(a, TA, R3)]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "off mode + three titles → allowed without proof");
  putTx(a, [human(a, T0), say(a, TA, "답만.")]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "off mode + no file change → allowed");
});

t("P10 — 마감문에 회차 숫자를 쓰면 장부 실제값과 같아야 승인(3/5 ≠ 5/5=거부·5/5=승인·숫자 없음=검사 없음) · 안내문에 실제값 명시", () => {
  const base = "[검증 상한 인계]" + NL + "[수용·처리]" + NL + "없음" + NL + "[반박·종결]" + NL + "없음" + NL + "[보관함 이관]" + NL + "없음" + NL + "[사용자 판단 필요]" + NL + "없음" + NL + "[잔여 위험 판단]" + NL + "다음 캠페인 도장 — 이유: 미검증 수정은 문구뿐이라 회귀 시험이 덮습니다." + NL + "[경고등 의미]" + NL + "verify-incomplete 노랑은 통과 인증이 아니라 잔여 미검증 표시라 남고 사용자 행동은 필요 없습니다; 이 마감은 검증 통과가 아닙니다." + NL + "[권장]" + NL + "사용자 판단 없이 다음 작업 첫 검증에 도장받기를 권장합니다.";
  const ctx = { evidence: [], alertKind: "verify-incomplete", passNoFindings: true, unavailable: false, roundCount: 5, roundBudget: 5 };
  assert.strictEqual(VH.validateCapHandoff(base, ctx).ok, true, "no figure → accepted");
  const withFig = (fig) => base.replace("이 마감은 검증 통과가 아닙니다.", "이 마감은 검증 통과가 아닙니다(검증 상한 " + fig + " 도달).");
  assert.strictEqual(VH.validateCapHandoff(withFig("3/5"), ctx).ok, false, "3/5 ≠ ledger 5/5 → rejected");
  assert.strictEqual(VH.validateCapHandoff(withFig("5/5"), ctx).ok, true, "matching figure → accepted");
  assert.strictEqual(VH.validateCapHandoff(withFig("3/5"), { ...ctx, roundCount: undefined, roundBudget: undefined }).ok, true, "no ledger figures in context → no check");
  // [1회차 blocker] 머리와 첫 절 사이의 숫자도 검사 · 키워드가 떨어진 일반 분수는 회차가 아님
  const headFig = (fig) => base.replace("[검증 상한 인계]" + NL, "[검증 상한 인계]" + NL + "실제 회차 " + fig + " — 마지막 판정 실패." + NL);
  assert.strictEqual(VH.validateCapHandoff(headFig("3/5"), ctx).ok, false, "figure between the head and the first section is checked too");
  assert.deepStrictEqual(VH.validateCapHandoff(headFig("3/5"), ctx).missing, ["round-figure-mismatch"]);
  assert.strictEqual(VH.validateCapHandoff(headFig("5/5"), ctx).ok, true);
  const prose = base.replace("이 마감은 검증 통과가 아닙니다.", "이 마감은 검증 통과가 아닙니다(상한 정책 성공 확률 3/4).");
  assert.strictEqual(VH.validateCapHandoff(prose, ctx).ok, true, "'성공 확률 3/4' is an ordinary fraction, not a round figure");
  assert.strictEqual(VH.roundFigureMismatch("round 3/5 reached · 3/5 회차 · cap: 5/5", { roundCount: 5, roundBudget: 5 }), true);
  assert.strictEqual(VH.roundFigureMismatch("확률 3/5 · 5/5 회차 · 상한 5/5 도달", { roundCount: 5, roundBudget: 5 }), false);
  // [2회차 blocker] 단어 안의 cap/round는 키워드 아님 · 조사·be동사·굵게가 낀 명시적 회차 문구는 검사
  for (const s of ["recap: 3/5 tests passed", "background 3/5", "3/5 roundtrip", "선택 1/2 · 3/4 성공", "pre_cap 3/5 tests passed", "round_trip 3/5", "3/5 round_2"]) assert.strictEqual(VH.roundFigureMismatch(s, { roundCount: 5, roundBudget: 5 }), false, s);
  for (const s of ["현재 회차는 3/5입니다", "round is 3/5", "회차 **3/5**", "3/5 round", "Round: 3/5", "상한: 3/5 도달"]) assert.strictEqual(VH.roundFigureMismatch(s, { roundCount: 5, roundBudget: 5 }), true, s);
  assert.strictEqual(VH.validateCapHandoff(base.replace("[검증 상한 인계]" + NL, "[검증 상한 인계]" + NL + "recap: 3/5 tests passed" + NL), ctx).ok, true, "'recap: 3/5' inside a valid closeout is not a round figure");
  assert.strictEqual(VH.validateCapHandoff(headFig("는 3/5입니다 —"), ctx).ok, false, "'회차는 3/5입니다' in the head is a round figure");
  const ins = VH.capHandoffInstruction("ko", "5/5", "pass", ctx);
  assert.ok(ins.includes("장부 실제값(5/5)") && ins.includes("쉬운 말 세 칸 제목"), ins.slice(0, 200));
  assert.ok(VH.capHandoffInstruction("en", "5/5", "pass", ctx).includes("ledger's actual value (5/5)"));
});

t("P6 — 검증자 지적 블록 손상=줄·사유가 ws 단위 재발급 파일에 남고 다음 요청 절에 원문 없이 동봉 · 정상 판독=소거 · 다른 캠페인=미동봉", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rs-repo-"));
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["로컬 PC"], alwaysBlocker: ["오귀속"], outOfScope: ["다중 배포"] }));
  const sha = CL.readVerifyEnvelope(repo).sha1;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rs-ws-"));
  CL.updateContractPatch(ws, "ko", { envelopeHash: sha, scoutRepo: repo }, { tries: 3 });
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-rs1";
  CL.writeEnvelopeFreeze(ws, sha, "ask-rs1", {});
  const corrupt = ["본문", "[지적 목록 v2]", "{깨진 JSON 비밀값 sk-live-XXXX", '{"tag":"blocker"}', "[지적 목록 끝]", "", "검증: 실패"].join(NL);
  const r = CB.machineFindingsLayer(corrupt, ws, "ko", "core", "claude-codex", "ask-rs1", "no-campaign");
  assert.strictEqual(r.machine.effective, "inconclusive");
  const rec = CL.readReissue(ws);
  assert.ok(rec && rec.campaignId === "no-campaign" && rec.items.length === 2 && rec.items[0].lineNo === 3 && rec.items[0].reasonKey === "bad-json" && rec.items[1].reasonKey === "bad-title", JSON.stringify(rec));
  assert.ok(!JSON.stringify(rec).includes("sk-live"), "no raw text copied (only coordinates)");
  const sec = CL.reissueSectionFor(ws, "no-campaign", "ko");
  assert.ok(sec.startsWith("[서식 재발급 — 직전 판의 지적 블록이 손상돼") && sec.includes("3번째 줄: JSON 한 줄 형식 아님") && sec.includes("4번째 줄: title 누락/다행") && sec.includes("40행 이하") && !sec.includes("sk-live"), sec);
  assert.ok(CB.v2DynamicData(ws, "ko").includes("[서식 재발급"), "next request's dynamic data carries the reissue section");
  assert.strictEqual(CL.reissueSectionFor(ws, "cl:other:campaign", "ko"), "", "different campaign → not attached");
  assert.ok(CL.reissueSectionFor(ws, "no-campaign", "en").includes("line 3: not one JSON object per line"));
  const clean = ["본문", "[지적 목록 v2]", '{"tag":"보완","title":"정상 항목"}', "[지적 목록 끝]", "", "검증: 통과(보완)"].join(NL);
  CB.machineFindingsLayer(clean, ws, "ko", "core", "claude-codex", "ask-rs2", "no-campaign");
  assert.strictEqual(CL.readReissue(ws), null, "clean parse clears the reissue record");
  assert.ok(!CB.v2DynamicData(ws, "ko").includes("[서식 재발급"));
  for (const p9 of CL.judgeRequiredPending(ws)) CL.resolveJudgeRequired(ws, p9.askId, "re-verify", { note: "시험 정리 — 손상 판 재검증" });
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
