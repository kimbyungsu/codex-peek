"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 3 §4] 검증 상한 마감 기록 — 답 본문 파싱 대신 명령(closing submit)으로 제출·캠페인 결속·종료 시 현재 문맥 재검사.
 * 격리: 임시 CODEX_BRIDGE_HOME. 종료 훅·명령줄은 자식 프로세스로 실제 실행. 화면 조각은 컴파일 산출물을 가짜 화면 요소로 실행.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const VH = require("../bridge/verify-cap-handoff.js");
const GUARD = path.join(ROOT, "bridge", "verify-guard.js");
const CLI = path.join(ROOT, "bridge", "codex-bridge.js");

let n = 0;
const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
let seq = 0;
const TITLE = "저장한 선택값이 화면 재진입 뒤 사라진다";
const LINE_OK = `- R5-F1 ${TITLE} — 변경: \`restoreSavedChoice\` 복원 분기를 수정했습니다; 확인: 시험:재진입-회귀에서 선택값 유지 결과를 확인했습니다; 근거: tests/closeout.test.js`;
const closeout = (o) => {
  const x = Object.assign({ accepted: LINE_OK, rebutted: "없음", parked: "없음", decision: "없음", risk: "다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.", alert: "verdict-nonclean 빨강은 마지막 검증이 통과가 아니었음을 남기며 이 마감은 통과 인증이 아닙니다. 사용자 행동은 필요 없고 나중의 정상 검증 통과 때 해소됩니다.", rec: "사용자 판단 없이 처리 내용을 유지하고 다음 변경의 정상 검증에서 다시 확인하기를 권장합니다." }, o || {});
  return `[검증 상한 인계]\n[수용·처리]\n${x.accepted}\n[반박·종결]\n${x.rebutted}\n[보관함 이관]\n${x.parked}\n[사용자 판단 필요]\n${x.decision}\n[잔여 위험 판단]\n${x.risk}\n[경고등 의미]\n${x.alert}\n[권장]\n${x.rec}`;
};
// 상한(5/5)에 닿은 Claude 캠페인 하나: 작업공간·계약·세션 앵커·대화 기록·마지막 검증 job(실패+지적 1건)
function project(tag, opts) {
  const o = opts || {};
  seq++;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-ws-" + tag + "-"));
  const sid = "co-" + tag + "-" + seq;
  const turnTs = new Date(Date.now() - 60 * 1000).toISOString();
  fs.mkdirSync(path.join(HOME, "contracts"), { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify(Object.assign({ verifyMode: "always", verifyBudget: 5 }, o.contract || {})));
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, sid + ".json"), JSON.stringify({ workspace: ws, claudeSession: sid, ts: turnTs }));
  const tx = path.join(ws, "..", path.basename(ws) + ".jsonl");
  fs.writeFileSync(tx, JSON.stringify({ type: "user", sessionId: sid, timestamp: turnTs, message: { content: [{ type: "text", text: "작업해" }] } }) + "\n");
  const campaignId = "cl:" + sid + ":" + turnTs;
  fs.mkdirSync(CL.CAMPAIGN_DIR, { recursive: true });
  fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId, count: o.count == null ? 5 : o.count, budget: 5, startedAt: turnTs, updatedAt: new Date().toISOString() }));
  const jobs = path.join(HOME, "ask-jobs"); fs.mkdirSync(jobs, { recursive: true });
  const jid = "ask-co" + tag.replace(/[^a-z0-9]/g, "") + seq + "-0000000005";
  fs.writeFileSync(path.join(jobs, jid + ".json"), JSON.stringify({ id: jid, state: "succeeded", workspace: ws, campaignId, verifyRound: 5, finishedAt: turnTs }));
  fs.writeFileSync(path.join(jobs, jid + ".out"), `[지적 목록 v1]\n{"tag":"blocker","title":"${TITLE}"}\n[지적 목록 끝]\n검증: 실패\n`);
  const env = { CLAUDE_CODE_SESSION_ID: sid };
  const target = () => VH.closeoutTargetFor(ws, CL.loadContract(ws), env);
  const submit = (text, extra) => VH.submitCloseout(ws, Object.assign({ text, target: target() }, extra || {}));
  const stop = () => cp.spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ transcript_path: tx, cwd: ws, session_id: sid, stop_hook_active: true }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: ws }), windowsHide: true });
  const cli = (args) => cp.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ws, env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: ws }), windowsHide: true });
  const say = (ts, content) => fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: ts, message: { content } }) + "\n");
  const phase = () => { try { return JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8")).phase; } catch { return ""; } };
  return { ws, sid, tx, campaignId, jid, env, target, submit, stop, cli, say, phase };
}
const blocked = (r) => { try { return JSON.parse(String(r.stdout || "").trim()).decision === "block"; } catch { return false; } };
const reasonOf = (r) => { try { return String(JSON.parse(String(r.stdout || "").trim()).reason || ""); } catch { return ""; } };

t("제출: 상한 전·검증 꺼짐·세션 없음은 받지 않음 · 형식 위반은 사유를 돌려주고 아무것도 저장하지 않음 · 빈 글·과대 글 거부", () => {
  const P0 = project("pre", { count: 3 });
  assert.strictEqual(P0.submit(closeout()).reason, "not-at-cap");
  const Poff = project("off", { contract: { verifyMode: "off" } });
  assert.strictEqual(Poff.submit(closeout()).reason, "verify-off");
  const P = project("bad");
  const noSess = VH.submitCloseout(P.ws, { text: closeout(), target: VH.closeoutTargetFor(P.ws, CL.loadContract(P.ws), {}) });
  assert.ok(!noSess.ok && noSess.reason === "no-campaign", JSON.stringify(noSess));
  const bad = P.submit(closeout({ accepted: `- R5-F1 ${TITLE} — 변경: 어떻게든 고쳤습니다; 확인: 잘 됐습니다; 근거: 어떤 근거` }));
  assert.ok(!bad.ok && bad.reason === "invalid" && /근거|칸/.test(bad.detail), JSON.stringify(bad));
  assert.strictEqual(VH.latestCloseoutFor(P.ws, P.campaignId).row, null, "거부된 글은 저장 안 됨");
  assert.strictEqual(P.submit("   ").reason, "empty");
  assert.strictEqual(P.submit("x".repeat(VH.CLOSEOUT_TEXT_MAX + 1)).reason, "too-large");
  const missingKey = P.submit(closeout({ accepted: "없음" }));
  assert.ok(!missingKey.ok && /미배정|R5-F1/.test(missingKey.detail), "마지막 지적에 행선지가 없으면 거부: " + missingKey.detail);
});

t("제출 성공=캠페인에 결속된 기록(판정 요약·회차·근거 job) · 같은 캠페인은 마지막 기록이 권위 · 다른 캠페인 기록과 섞이지 않음", () => {
  const P = project("ok");
  const r = P.submit(closeout());
  assert.ok(r.ok && /^co-[0-9a-f]{16}$/.test(r.id), JSON.stringify(r));
  const row = VH.latestCloseoutFor(P.ws, P.campaignId).row;
  assert.ok(row && row.id === r.id && row.campaignId === P.campaignId && row.host === "claude" && row.session === P.sid && row.round.count === 5 && row.round.budget === 5
    && row.sourceAsk === P.jid && row.alertKind === "verdict-nonclean" && row.residualRisk === "next" && row.needsUserDecision === false && row.wsKey === CL.wsKeyFor(P.ws), JSON.stringify(row));
  const r2 = P.submit(closeout({ risk: "무시 가능 — 이유: 마지막 판정 뒤 코드 수정이 없고 보고 문구만 바뀌었습니다." }));
  assert.ok(r2.ok && VH.latestCloseoutFor(P.ws, P.campaignId).row.id === r2.id && VH.latestCloseoutFor(P.ws, P.campaignId).row.residualRisk === "ignore", "마지막 기록이 권위");
  assert.strictEqual(VH.latestCloseoutFor(P.ws, "cl:other:campaign").row, null, "다른 캠페인=기록 없음");
  const Q = project("ok2");
  assert.strictEqual(VH.latestCloseoutFor(Q.ws, P.campaignId).row, null, "다른 작업공간 장부와 섞이지 않음(ab-1)");
});

t("종료 관문(실제 훅 실행): 답 본문의 마감문은 인정하지 않음 · 제출 기록이 있으면 정상 종료(자동 정리 완료) · 반복 종료에도 재차단·오경보 없음", () => {
  const P = project("stop");
  P.say(new Date(Date.now() - 30 * 1000).toISOString(), [{ type: "text", text: closeout() }]);
  const r1 = P.stop();
  assert.ok(blocked(r1), "답 본문만=차단");
  const why1 = reasonOf(r1);
  assert.ok(why1.includes("closing submit --file") && why1.includes("[검증 상한 인계]") && why1.includes("마감 기록 제출됨(대시보드)") && !why1.includes("ask-start"), "안내=제출 명령·양식·사용자 답 한 줄(새 검증 아님)");
  assert.ok(P.submit(closeout()).ok);
  const r2 = P.stop();
  assert.ok(r2.stdout === "" && P.phase() === "cap-settled", "제출 뒤 정상 종료·자동 정리 완료(통과 아님)");
  assert.ok([P.stop(), P.stop(), P.stop(), P.stop()].every((x) => x.stdout === ""), "반복 종료에도 재차단 없음");
  assert.ok(!CL.readIntegrityEvents().some((e) => e.session === P.sid && (e.kind === "verify-handoff-missing" || e.kind === "verify-incomplete")), "누락·미검증 빨강 0건");
});

t("종료 관문: 제출 뒤 파일 수정(도구 편집)=기록 낡음 → 다시 제출 요구 · 다시 제출하면 종료", () => {
  const P = project("stale");
  assert.ok(P.submit(closeout()).ok);
  P.say(new Date(Date.now() + 60 * 1000).toISOString(), [{ type: "tool_use", id: "tu1", name: "Edit", input: { file_path: path.join(P.ws, "a.js") } }]);
  const r = P.stop();
  assert.ok(blocked(r) && reasonOf(r).startsWith("[직전 마감 기록 거부 사유]") && reasonOf(r).includes("뒤에 파일이 바뀌었습니다"), reasonOf(r).slice(0, 200));
  assert.ok(P.submit(closeout(), { now: Date.now() + 2 * 60 * 1000 }).ok);
  assert.ok(P.stop().stdout === "" && P.phase() === "cap-settled", "마지막 수정 뒤 다시 제출=종료");
});

t("종료 관문: 제출 뒤 보관함 영수증이 닫히면(현재 문맥) 같은 기록이 재검사에서 떨어짐 → 다시 제출 요구", () => {
  const P = project("park");
  const rc = CL.backlogAdd(P.ws, { tag: "백로그", title: TITLE, lang: "ko", mode: "test", profile: "core", source: "closeout-test" });
  assert.ok(rc && rc.id, JSON.stringify(rc));
  assert.ok(P.submit(closeout({ accepted: "없음", parked: `- R5-F1 ${TITLE} — 범위 밖 백로그로 이관했고 보관함 영수증 ${rc.id}를 기록했습니다.` })).ok, "제출 시점엔 열린 영수증");
  assert.ok(CL.backlogSetStatus(P.ws, rc.id, "done").ok !== false);
  const r = P.stop();
  assert.ok(blocked(r) && reasonOf(r).includes("지금 상태로 다시 검사해 맞지 않습니다") && reasonOf(r).includes("보관함"), reasonOf(r).slice(0, 300));
});

t("종료 관문: 사용자 판단(결정 장부 블록) 기록=사용자 판단 대기(held) · 즉시 재검증 기록=마커+노랑 · 마커 기록 실패=미수락(다시 제출 불필요) → 장애 제거 뒤 같은 기록으로 수락", () => {
  const P = project("held");
  const dc = CL.openDecision(P.ws, { origin: "implementer", kind: "product", campaignId: P.campaignId, sourceAsk: P.jid, targetFp: "", question: "저장한 선택값 복원 방식을 영속 저장으로 바꿀까요?", why: "재진입 시 값이 사라지는 지적(R5-F1)", noDefault: "저장 방식은 제품 방향이라 구현자가 대신 정할 수 없음", choices: [{ key: "keep", label: "현재 방식 유지", ifChosen: "값이 사라질 수 있음" }, { key: "persist", label: "저장소에 영속", ifChosen: "다음 검증에서 확인" }], recommend: "persist" });
  assert.ok(dc.ok);
  const block = CL.renderDecisionBlock(CL.readDecisions(P.ws).latest.get(dc.decisionId), false);
  assert.ok(P.submit(closeout({ accepted: "없음", decision: block })).ok);
  assert.ok(P.stop().stdout === "" && P.phase() === "held", "사용자 판단 대기");
  const Q = project("now");
  const resF = CL.residualFileFor(Q.ws);
  fs.mkdirSync(resF, { recursive: true }); // 마커 기록 실패 주입
  assert.ok(Q.submit(closeout({ risk: "즉시 재검증 — 이유: 경계 수정이 미검증이라 지금 검증해야 합니다.", rec: "이 턴에서 새 검증 캠페인을 바로 시작하기를 권장합니다(경계 수정이 미검증이기 때문)." })).ok);
  const rf = Q.stop();
  assert.ok(blocked(rf) && reasonOf(rf).includes("마커 기록 실패") && reasonOf(rf).includes("다시 제출할 필요 없음"), reasonOf(rf).slice(0, 200));
  fs.rmSync(resF, { recursive: true, force: true });
  const ok2 = Q.stop();
  assert.ok(ok2.stdout === "" && JSON.parse(fs.readFileSync(resF, "utf8")).items[0].campaignId === Q.campaignId, "같은 기록으로 수락·마커 기록");
  assert.ok(CL.readIntegrityEvents().some((e) => e.kind === "verify-residual-now" && e.severity === "warning" && String(e.detailKo || "").includes("마감 기록 판단")), "노랑 경보");
});

t("장부: 판독 실패=종료 미인정(없음으로 줄이지 않음) · 쓰기 실패=제출 실패 · 끊긴 꼬리 뒤 새 기록 보존", () => {
  const P = project("ledger");
  const f = VH.closeoutFileFor(P.ws);
  fs.mkdirSync(f, { recursive: true }); // 장부 자리에 폴더
  const w = P.submit(closeout());
  assert.ok(!w.ok && (w.reason === "write-failed" || w.reason === "write-unconfirmed"), JSON.stringify(w));
  const r = P.stop();
  assert.ok(blocked(r) && reasonOf(r).includes("마감 기록 장부를 읽지 못했습니다"), reasonOf(r).slice(0, 200));
  fs.rmSync(f, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"schema":"closeout-v1","id":"co-'); // 줄 중간에서 끊긴 꼬리
  const ok = P.submit(closeout());
  assert.ok(ok.ok && VH.latestCloseoutFor(P.ws, P.campaignId).row.id === ok.id, "끊긴 꼬리 뒤 새 기록이 읽힘(꼬리 보호)");
});

t("명령줄(실제 실행): submit 성공·거부·상한 전 종료코드 · template=양식 · status=지금 검사 결과 · 사용법", () => {
  const P = project("cli");
  const fileOk = path.join(P.ws, "..", path.basename(P.ws) + "-closeout.md");
  fs.writeFileSync(fileOk, "﻿" + closeout());
  const tpl = P.cli(["closing", "template"]);
  assert.ok(tpl.status === 0 && tpl.stdout.includes("[검증 상한 인계]") && tpl.stdout.includes("closing submit --file") && tpl.stdout.includes("R5-F1"), tpl.stdout.slice(0, 300) + tpl.stderr);
  const st0 = P.cli(["closing", "status"]);
  assert.ok(st0.status === 1 && st0.stdout.includes("아직 제출되지 않았습니다"), st0.stdout);
  const fileBad = fileOk + ".bad"; fs.writeFileSync(fileBad, closeout({ rec: "좋아요" }));
  const bad = P.cli(["closing", "submit", "--file", fileBad]);
  assert.ok(bad.status === 1 && bad.stdout.includes("[마감 기록 거부]") && bad.stdout.includes("저장된 것은 없습니다"), bad.stdout);
  const ok = P.cli(["closing", "submit", "--file", fileOk]);
  assert.ok(ok.status === 0 && ok.stdout.includes("[마감 기록 제출됨]") && ok.stdout.includes("회차 5/5") && ok.stdout.includes("마감 기록 제출됨(대시보드)"), ok.stdout + ok.stderr);
  const st1 = P.cli(["closing", "status", "--json"]);
  const sj = JSON.parse(st1.stdout.trim());
  assert.ok(st1.status === 0 && sj.record && sj.checkNow && sj.checkNow.ok === true && sj.capReached === true, st1.stdout);
  const usage = P.cli(["closing", "approve"]);
  assert.ok(usage.status === 2 && usage.stdout.includes("closing submit --file"), usage.stdout);
  const Ppre = project("clipre", { count: 2 });
  const fp = path.join(Ppre.ws, "..", path.basename(Ppre.ws) + "-c.md"); fs.writeFileSync(fp, closeout());
  const pre = Ppre.cli(["closing", "submit", "--file", fp]);
  assert.ok(pre.status === 2 && pre.stdout.includes("검증 상한에 닿지 않았습니다(지금 2/5)"), pre.stdout);
  const help = P.cli(["no-such-cmd"]);
  assert.ok(help.stdout.includes("closing submit --file"), "도움말 줄");
  // 마지막 예약 왕복 안내는 검증 작업자 프로세스에서도 만들어진다 — 실행 중 스크립트가 아니라 브릿지 홈의 명령 경로여야 한다
  const CB = require("../bridge/codex-bridge.js");
  for (const lang of ["ko", "en"]) {
    const note = CB.budgetNoticeLines({ tracked: true, n: 5, budget: 5, last: true }, lang, "core");
    assert.ok(note.includes(CL.bridgeCmd("codex-bridge.js") + " closing submit --file") && !note.includes(String(process.argv[1]).replace(/\\/g, "/")), lang + " 마지막 왕복 안내 명령 경로: " + note.slice(-400));
  }
});

t("Codex 구현 대화: 대상 캠페인=구현 링크+턴 기록(종료 훅과 같은 원천) · 링크 없음=제출 불가 · 실제 Codex 종료 훅이 제출 기록으로 종료", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-cc-"));
  const sidC = "cccccccc-0000-1111-2222-" + String(Date.now()).slice(-12).padStart(12, "0"), turnC = "turn-co";
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, harnessMode: "codex-codex", codexVerifyMode: "always", codexVerifyBudget: 5 }));
  const c0 = CL.loadContract(ws);
  const none = VH.closeoutTargetFor(ws, c0, { CODEX_THREAD_ID: sidC });
  assert.ok(!none.ok && none.host === "codex" && none.reason === "no-implementer", JSON.stringify(none));
  fs.writeFileSync(path.join(HOME, "links.json"), JSON.stringify({ roleRevision: 1, byWorkspace: { [CL.normWs(ws)]: { workspace: ws, implementerSession: sidC, implementerRevision: 1, implementerEventAt: Date.now() - 2000 } } }));
  const turnDir = path.join(HOME, "codex-turns"); fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(path.join(turnDir, sidC + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: turnC, workspace: ws, startedAt: Date.now() - 1000, lastActionAt: 0, modified: false, permissionMode: "default" }));
  const campC = "cc:" + sidC + ":" + turnC;
  fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId: campC, count: 5, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const jid = "ask-coccstop-0000000005";
  fs.writeFileSync(path.join(HOME, "ask-jobs", jid + ".json"), JSON.stringify({ id: jid, state: "succeeded", workspace: ws, campaignId: campC, verifyRound: 5, finishedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(HOME, "ask-jobs", jid + ".out"), `[지적 목록 v1]\n{"tag":"blocker","title":"${TITLE}"}\n[지적 목록 끝]\n검증: 실패\n`);
  const tg = VH.closeoutTargetFor(ws, CL.loadContract(ws), { CODEX_THREAD_ID: sidC });
  assert.ok(tg.ok && tg.host === "codex" && tg.campaignId === campC && tg.capReached, JSON.stringify(tg));
  // [검증 1회차 f-923705bc] 호출한 Codex 대화가 지금 연결된 구현 대화가 아니면(또는 대화 id 없음) 그 캠페인의 마감을 대신 기록할 수 없다(ab-1)
  const other = VH.closeoutTargetFor(ws, CL.loadContract(ws), { CODEX_THREAD_ID: "dddddddd-9999-8888-7777-666666666666" });
  assert.ok(!other.ok && other.reason === "caller-not-implementer", JSON.stringify(other));
  assert.strictEqual(VH.submitCloseout(ws, { text: closeout(), target: other }).reason, "no-campaign");
  const anon = VH.closeoutTargetFor(ws, CL.loadContract(ws), {});
  assert.ok(!anon.ok && anon.reason === "no-session-env", JSON.stringify(anon));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-codexhome-")); fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const runC = () => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-hook.js")], { input: JSON.stringify({ hook_event_name: "Stop", session_id: sidC, turn_id: turnC, cwd: ws, permission_mode: "default" }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CODEX_HOME: codexHome }), windowsHide: true });
  const r1 = runC();
  assert.ok(r1.stdout.includes("closing submit --file") && r1.stdout.includes("[검증 상한 인계]"), "Codex 종료 훅도 제출 안내: " + r1.stdout.slice(0, 200));
  assert.ok(VH.submitCloseout(ws, { text: closeout(), target: tg }).ok);
  const r2 = runC();
  assert.ok(r2.stdout === "" && JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8")).phase === "cap-settled", "제출 기록으로 종료: " + r2.stdout.slice(0, 200));
  assert.strictEqual(VH.latestCloseoutFor(ws, campC).row.host, "codex");
  // [검증 2회차 f-566d1887] Codex: 유효한 기록 + 판단 미기록 → 판단 관문 차단 → 반복 상한 탈출 시 '마감 누락'이 아닌 일반 미완 경보 → 판단 뒤 같은 기록으로 수락
  assert.ok(CL.addJudgeRequired(ws, { askId: jid, campaignId: campC, reason: "all-demoted" }));
  const j1 = runC();
  assert.ok(j1.stdout.includes("판단 관문") && !j1.stdout.includes("closing submit"), j1.stdout.slice(0, 200));
  runC(); runC(); const jEsc = runC();
  const evC = CL.readIntegrityEvents().filter((e) => e.session === sidC);
  assert.ok(jEsc.stdout === "" && evC.some((e) => e.kind === "verify-incomplete" && String(e.detailKo || "").includes("마감 기록은 제출됐지만")) && !evC.some((e) => e.kind === "verify-handoff-missing"), JSON.stringify(evC.map((e) => e.kind)));
  assert.ok(CL.resolveJudgeRequired(ws, jid, "re-verify", { note: "상한이라 다음 캠페인에서 다시 검증하기로 판단합니다" }).ok !== false);
  assert.ok(runC().stdout === "" && JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8")).phase === "cap-settled", "판단 뒤 같은 기록으로 수락");
});

t("화면 자료: 최근 순·세 절 개수·저장소 필터(표식 없는 옛 행은 함께) · 판독 실패 표시 · 큰 장부는 꼬리만", () => {
  const P = project("view");
  assert.deepStrictEqual(VH.closeoutView(P.ws), { readError: false, total: 0, items: [], truncated: false });
  assert.ok(P.submit(closeout()).ok);
  assert.ok(P.submit(closeout({ risk: "무시 가능 — 이유: 마지막 판정 뒤 코드 수정이 없고 보고 문구만 바뀌었습니다." })).ok);
  const f = VH.closeoutFileFor(P.ws);
  const rows = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const other = Object.assign({}, rows[0], { id: "co-" + "e".repeat(16), repoKey: "other-repo-key" });
  const legacy = Object.assign({}, rows[0], { id: "co-" + "f".repeat(16) }); delete legacy.repoKey;
  fs.appendFileSync(f, JSON.stringify(other) + "\n" + JSON.stringify(legacy) + "\n");
  const v = VH.closeoutView(P.ws);
  assert.ok(!v.readError && v.total === 3 && v.items[0].id === legacy.id && v.items[1].residualRisk === "ignore" && !v.items.some((x) => x.id === other.id), JSON.stringify(v.items.map((x) => x.id)));
  assert.deepStrictEqual(v.items[1].counts, { accepted: 1, rebutted: 0, parked: 0 });
  assert.ok(v.items[1].round.count === 5 && v.items[1].text.includes("[검증 상한 인계]"));
  const Q = project("viewbig");
  assert.ok(Q.submit(closeout()).ok);
  const fq = VH.closeoutFileFor(Q.ws);
  const big = JSON.parse(fs.readFileSync(fq, "utf8").trim());
  const pad = Object.assign({}, big, { text: big.text + "\n" + "가".repeat(60000) });
  let buf = ""; for (let i = 0; i < 12; i++) buf += JSON.stringify(Object.assign({}, pad, { id: "co-" + String(i).padStart(16, "0") })) + "\n";
  fs.appendFileSync(fq, buf);
  const vb = VH.closeoutView(Q.ws);
  assert.ok(vb.truncated && !vb.readError && vb.items.length >= 1 && vb.items[0].id === "co-" + String(11).padStart(16, "0"), JSON.stringify({ t: vb.truncated, n: vb.items.length, first: vb.items[0] && vb.items[0].id }));
  const R = project("viewerr");
  fs.mkdirSync(VH.closeoutFileFor(R.ws), { recursive: true });
  assert.strictEqual(VH.closeoutView(R.ws).readError, true, "판독 실패≠빈 목록");
});

t("화면 조각(컴파일 산출물) 실제 실행 — 요약·세 절 개수·잔여 위험 설명·원문 접기 · 판독 실패 문구 · 자료 없음=숨김 · 결선", () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf('const sec=$("closeoutSec");'), e = outSrc.indexOf("// P-12 v2.4: 보관함 카드", b);
  assert.ok(b > 0 && e > b, "조각 추출");
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; }, setAttribute(k, v) { this.attrs[k] = v; } }; return o; };
  const run = (d) => {
    const sec = mkEl("details"), sum = mkEl("span"), list = mkEl("div");
    const ids = { closeoutSec: sec, coSummary: sum, coList: list };
    const el = (tag, cls, text) => { const x = mkEl(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
    new Function("document", "$", "T", "d", "el", "(function(){" + outSrc.slice(b, e).replace(/\}\);\s*$/, "") + "})();")({ createElement: mkEl }, (id) => ids[id] || null, (a) => a, d, el);
    const all = []; const walk = (x) => { all.push(x); (x.children || []).forEach(walk); }; walk(list);
    return { sec, sum, text: all.map((x) => x.textContent).join(" | "), all };
  };
  assert.strictEqual(run({ closeouts: null }).sec.style.display, "none", "자료 없음=숨김");
  const empty = run({ closeouts: { readError: false, total: 0, items: [], truncated: false } });
  assert.ok(empty.sec.style.display === "" && empty.sum.textContent.includes("아직 없음"), "빈 장부=아직 없음");
  const err = run({ closeouts: { readError: true, total: 0, items: [], truncated: false } });
  assert.ok(err.sum.textContent.includes("판독 실패"), "판독 실패 문구");
  const r = run({ closeouts: { readError: false, total: 12, truncated: false, items: [
    { id: "co-1", ts: "2026-10-05T01:00:00.000Z", host: "claude", round: { count: 5, budget: 5 }, residualRisk: "now", needsUserDecision: true, decisionCount: 1, alertKind: "verdict-nonclean", verdict: "fail", counts: { accepted: 2, rebutted: 1, parked: 0 }, text: "[검증 상한 인계] 원문" },
    { id: "co-2", ts: "2026-10-04T01:00:00.000Z", host: "codex", round: { count: 3, budget: 3 }, residualRisk: "ignore", needsUserDecision: false, decisionCount: 0, alertKind: "", verdict: null, counts: null, text: "" }] } });
  assert.ok(r.sum.textContent.includes("최근 2건") && r.sum.textContent.includes("전체 12"), r.sum.textContent);
  assert.ok(r.text.includes("고친 것 2") && r.text.includes("반박해 닫은 것 1") && r.text.includes("사용자 결정 필요 1") && r.text.includes("결정 장부에서 답해 주세요"), r.text.slice(0, 400));
  assert.ok(r.text.includes("지금 다시 검증해야 함") && r.text.includes("확인할 코드 수정 없음") && r.text.includes("구현 Codex") && r.text.includes("5/5"), "잔여 위험 설명·담당·회차");
  assert.ok(r.all.some((x) => x.tag === "pre" && x.textContent === "[검증 상한 인계] 원문"), "원문 접기");
  for (const k of ['id="closeoutSec"', "closeoutView(ws)", 'id="coList"']) assert.ok(outSrc.includes(k), "결선: " + k);
});

t("[검증 1회차 f-a812cc41] 판단 관문(구현자 판단 미기록)이 남으면 유효한 마감 기록이 있어도 종료 불가 → 판단 기록 뒤 수락 · 앞 캠페인 '즉시 재검증' 잔여는 상한 턴에 소비 불가라 마감은 수락하되 잔여는 그대로 남음", () => {
  const P = project("judge");
  assert.ok(CL.addJudgeRequired(P.ws, { askId: P.jid, campaignId: P.campaignId, reason: "all-demoted" }));
  assert.ok(P.submit(closeout()).ok);
  fs.writeFileSync(CL.PHASE_FILE, JSON.stringify({ phase: "reset-by-test" })); // 진행 표시 파일은 전역 하나 — 앞 시험의 값을 지운다
  const r1 = P.stop();
  assert.ok(blocked(r1) && reasonOf(r1).includes("판단 관문") && !reasonOf(r1).includes("closing submit"), reasonOf(r1).slice(0, 200));
  assert.ok(P.phase() !== "cap-settled" && P.phase() !== "held", "판단 전 마감 수락 없음");
  P.stop(); P.stop(); const esc = P.stop(); // 반복 차단 상한 → 경보로 끝남: 마감 기록은 유효하므로 '마감 누락' 빨강이 아니어야 한다
  const evs = CL.readIntegrityEvents().filter((e) => e.session === P.sid);
  assert.ok(esc.stdout === "" && evs.some((e) => e.kind === "verify-incomplete") && !evs.some((e) => e.kind === "verify-handoff-missing"), JSON.stringify(evs.map((e) => e.kind)));
  const rj = CL.resolveJudgeRequired(P.ws, P.jid, "re-verify", { note: "상한이라 다음 캠페인에서 다시 검증하기로 판단합니다" });
  assert.ok(rj && rj.ok !== false, JSON.stringify(rj));
  assert.ok(P.stop().stdout === "" && P.phase() === "cap-settled", "판단 기록 뒤 같은 마감 기록으로 수락");
  const Q = project("resid");
  assert.ok(CL.addResidual(Q.ws, { campaignId: "cl:previous-campaign:1", sourceAsk: "", evidence: ["R5-F1 앞 작업 미검증분"], ts: new Date().toISOString() }));
  assert.ok(Q.submit(closeout()).ok);
  const rq = Q.stop();
  assert.ok(rq.stdout === "" && Q.phase() === "cap-settled", "상한 턴=마감 수락(잔여는 이 턴에 소비할 수 없음): " + rq.stdout.slice(0, 200));
  const left = CL.readResidual(Q.ws);
  assert.ok(left && left.items.some((x) => x.campaignId === "cl:previous-campaign:1"), "앞 캠페인 잔여는 그대로 남아 다음 턴을 막는다");
});

t("[검증 1회차 f-62c0d942] 저장소 상태 결속: 제출 뒤 고친 것을 커밋해 작업 트리가 깨끗해져도 낡은 기록으로 종료하지 않음 · 그대로면 수락", () => {
  const P = project("git");
  const g = (args) => cp.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "safe.directory=*", "-C", P.ws, ...args], { encoding: "utf8", windowsHide: true });
  assert.strictEqual(g(["init", "-q"]).status, 0);
  fs.writeFileSync(path.join(P.ws, "a.js"), "one\n");
  assert.ok(g(["add", "a.js"]).status === 0 && g(["commit", "-q", "-m", "first"]).status === 0);
  const r = P.submit(closeout());
  assert.ok(r.ok && r.row.repoState && /^[0-9a-f]{40}/.test(r.row.repoState.head) && typeof r.row.repoState.statusFp === "string", JSON.stringify(r.row && r.row.repoState));
  assert.ok(P.stop().stdout === "" && P.phase() === "cap-settled", "상태 그대로=수락");
  // 제출 뒤 수정 → 커밋(깨끗한 트리) — 변경 시각 판독으로는 안 보이는 경로
  fs.writeFileSync(path.join(P.ws, "a.js"), "two\n");
  assert.ok(g(["commit", "-q", "-am", "after submit"]).status === 0 && g(["status", "--porcelain"]).stdout.trim() === "");
  const rs = P.stop();
  assert.ok(blocked(rs) && reasonOf(rs).includes("저장소 상태가 바뀌었습니다"), reasonOf(rs).slice(0, 240));
  assert.ok(P.submit(closeout()).ok && P.stop().stdout === "", "지금 상태로 다시 제출=수락");
  // 제출 뒤 바뀐 파일 목록 변화(되돌리기 등)도 같은 판정
  fs.writeFileSync(path.join(P.ws, "b.js"), "x\n");
  assert.ok(P.submit(closeout(), { now: Date.now() + 1000 }).ok);
  fs.rmSync(path.join(P.ws, "b.js"));
  const rb = P.stop();
  assert.ok(blocked(rb) && reasonOf(rb).includes("저장소 상태가 바뀌었습니다"), "바뀐 파일 목록 변화: " + reasonOf(rb).slice(0, 200));
});

t("[검증 1회차 f-f318a260] 다른 저장소의 기록으로는 종료하지 않음(ab-1) · 화면에서도 숨김", () => {
  const P = project("repo");
  const r = P.submit(closeout());
  assert.ok(r.ok && r.row.repoKey === CL.repoKeyNow(P.ws), JSON.stringify(r.row && r.row.repoKey));
  const f = VH.closeoutFileFor(P.ws);
  const row = JSON.parse(fs.readFileSync(f, "utf8").trim());
  fs.writeFileSync(f, JSON.stringify(Object.assign({}, row, { repoKey: "f".repeat(16) })) + "\n"); // 같은 작업공간·캠페인, 다른 저장소 기록만 있는 상태
  assert.strictEqual(VH.latestCloseoutFor(P.ws, P.campaignId, CL.repoKeyNow(P.ws)).row, null);
  const rs = P.stop();
  assert.ok(blocked(rs) && reasonOf(rs).includes("closing submit"), "다른 저장소 기록=없음 취급: " + reasonOf(rs).slice(0, 160));
  assert.strictEqual(VH.closeoutView(P.ws).total, 0, "화면도 현재 저장소 기록만");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 정리 실패 무해 */ }
})().catch((e) => { console.error(e); process.exit(1); });
