"use strict";
/*
 * [RULE-SUPPLY-CORRECTION ④ 묶음 6(H) · 사용자 결정 D-g — 2026-10-12] 수칙 문안 칸·다시 쓰기.
 *  ① 명령줄 실제 실행: --rule/--bounds 없는 새 상신 거부(자체·--from 둘 다 · 무기록 · 결과 미소비) · 형식(한 줄·200자·규약 어휘) · 성공 행=fmt rule-v1·rule·bounds·submitted
 *  ② 유효 문안=마지막 실제 상신 행(자동 전이 행은 권위 아님) · 옛 형식→새 형식 재상신(--again) · 순수 함수 경계(모르는 형식·빈 문안=null)
 *  ③ 초안 두 함수: 옛 후보=원문 · 새 후보=문안 · 문안 칸 깨짐/모르는 형식=거부(원문으로 대신 쓰지 않음)
 *  ④ 다시 쓰기(--redraft-of): 안 올린 같은 저장소 후보만 · 한 요청 문장으로 두 후보 · 같은 쌍 재시도=중복 · 옛 후보 무변 · 자체 상신 한도 · --from 과 섞지 않음 · 다시 쓴 후보의 거절 기억
 *  ⑤ 복원·이월: 초안→취소(폐기 복원)→재초안 · 고아 복원 · 세대 이월 뒤 유효 문안 유지
 *  ⑥ 대기열 정리 반례 두 방향(근거 원문만 등재=정리 안 함 / 문안 등재=정리) — 세대 이월·같은 세대 중복 정리·고아 판정 각각(실제 조정 함수)
 *  ⑦ 대시보드: 후보 집계 → 자료 변환(컴파일 산출물) → 카드(문안→근거→영향→왜 순 · 다시 쓰기·작성 표시 · 문안 칸 이상 · 옛 형식 종전)
 *  ⑧ 후보 원문(title)을 읽는 곳 전수 목록(소스 고정 — 문안 판정·삽입은 단일 함수, 나머지는 출처·존재 확인)
 * 격리: 임시 CODEX_BRIDGE_HOME. 분류 담당 호출은 페이지 실행기 주입(실제 호출 없음).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rtext-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const UW = require("../bridge/user-words.js");
const CF = require("../bridge/classify.js");
const CB = require("../bridge/codex-bridge.js");

const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const mk = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let seq = 0;
function approve(P, core) {
  const raw = CL.serializeEnvelopeCore(Object.assign({ schema: "verify-envelope-v1", supportedEnv: [], alwaysBlocker: [], outOfScope: [] }, core || {}));
  fs.writeFileSync(path.join(P.repo, CL.ENVELOPE_FILE), raw);
  CL.setEnvelopeHashAllSlots(P.ws, sha1(raw));
  P.H = sha1(raw);
}
function project(tag, core) {
  const ws = mk("rt-ws-" + tag + "-"), repo = mk("rt-repo-" + tag + "-");
  assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }, { tries: 3 }).ok);
  assert.ok(CL.updateContractPatch(ws, "en", { scoutRepo: repo }, { tries: 3 }).ok);
  const P = { ws, repo, rk: CL.repoKeyOf(repo), H: CL.GEN0_HASH };
  if (core) approve(P, core);
  return P;
}
function say(P, text) {
  const anc = CL.turnAnchorOf("rt-s", new Date(Date.UTC(2026, 9, 12, 0, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text);
  assert.ok(s.ok);
  assert.ok(UW.enqueuePrompt(P.ws, { anchor: anc, sourceHash: s.sourceHash, sessionId: "rt-s", repoKey: P.rk, provider: "claude" }).ok);
}
function turnNow(P, text) {
  const anc = CL.turnAnchorOf("rt-now", new Date(Date.UTC(2026, 9, 12, 1, 0, ++seq)).toISOString());
  const s = CL.writeConstraintTurnSnapshot(P.ws, anc, text || "다음 단계 진행해 주세요");
  return { ok: true, provider: "claude", sessionId: "rt-now", turnAnchor: anc, sourceHash: s.sourceHash, repoKey: P.rk };
}
function fakeRunner(answer) { return ({ prompt }) => ({ promise: Promise.resolve({ ok: true, output: JSON.stringify(typeof answer === "function" ? answer(prompt) : answer) }), cancel() {} }); }
const refOf = (prompt, text) => { const from = prompt.indexOf("<<u1 "); const i = prompt.indexOf(text, from); const head = prompt.lastIndexOf("<<u", i); return prompt.slice(head + 2, prompt.indexOf(" ", head)); };
async function boundary(P, quote, seat) {
  say(P, quote);
  const r = await CF.runClassify(P.ws, { pageRunner: fakeRunner((p) => ({ results: [{ ref: refOf(p, quote), kind: "boundary", seat, quote, why: "프로젝트 내내 지킬 판정 기준", bounds: "이 기준으로 결함 여부를 판정한다" }] })) });
  assert.ok(r.st === "ok" && r.resultIds.length === 1, JSON.stringify(r));
  return CF.readClassifyResults(P.ws).latest.get(r.resultIds[0]);
}
const rowsOf = (P) => CL.readEnvelopeCandidates(P.ws).rows;
const latestOf = (P, id) => CL.readEnvelopeCandidates(P.ws).latest.get(id + "@" + P.H);
const declineByUser = (P, id) => assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "declined", by: "user", ts: new Date().toISOString() }]));
const proposalAb = (P) => JSON.parse(CL.readEnvelopeProposal(P.ws, P.repo).proposalText).alwaysBlocker;
const opt = (rule, bounds, extra) => Object.assign({ rule, bounds, requireRule: true }, extra || {});

// 사용자 원문(근거)과 구현 담당이 쓴 문안(도장 대상)·판정 영향
const Q1 = "실기기 최신폰 확인은 이번 단계 범위 밖이라고 계속 보자";
const R1 = "이번 단계에서는 실기기 최신폰으로 확인하지 않은 점을 결함으로 보지 않는다";
const B1 = "실기기 최신폰 미확인 지적은 범위 밖으로 돌린다";
const Q2 = "사용자 원래 설정은 검증 뒤 언제나 되돌려 놓아야 해";
const R2 = "검증이 끝나면 사용자가 원래 쓰던 설정을 반드시 되돌려 놓는다";
const B2 = "원래 설정을 되돌리지 않은 변경은 언제나 결함으로 본다";
const Q3 = "외부 서버 연동 오류는 이번 프로젝트에서 다루지 않는다고 했어";
const R3 = "이 프로젝트에서는 외부 서버 연동 오류를 검증 대상으로 삼지 않는다";
const B3 = "외부 서버 연동 오류 지적은 범위 밖으로 돌린다";
const Q4 = "보고할 때 바뀐 파일 목록은 항상 맨 앞에 두라고 했지";
const R4 = "보고서 맨 앞에는 언제나 바뀐 파일 목록을 둔다";
const B4 = "바뀐 파일 목록이 맨 앞에 없으면 결함으로 본다";

t("① 명령줄 실제 실행 — 문안·영향 칸 필수(자체·--from) · 형식 · 성공 행", async () => {
  const P = project("cli", {});
  const rA = await boundary(P, Q1, "outOfScope");
  const SESS = "rt-cli-session";
  const now = turnNow(P, "기억해 줘: " + Q2);
  fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: P.ws, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: now.turnAnchor, constraintSourceHash: now.sourceHash, constraintRepoKey: P.rk }));
  CF.markResultsDelivered(P.ws, [rA], Object.assign({}, now, { sessionId: SESS }));
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws, CLAUDE_CODE_SESSION_ID: SESS });
  const run = (args) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "constraint", "add", ...args], { env, encoding: "utf8", cwd: P.ws });
  const before = rowsOf(P).length;
  const cases = [
    [["--quote", Q2, "--why", "판정 경계 기준"], "rule-missing"],
    [["--quote", Q2, "--rule", R2, "--why", "판정 경계 기준"], "bounds-missing"],
    [["--quote", Q2, "--bounds", B2, "--why", "판정 경계 기준"], "rule-missing"],
    [["--quote", Q1, "--why", "분류 결과를 보고 판단", "--from", rA.resultId], "rule-missing"],
    [["--quote", Q2, "--rule", "첫 줄\n둘째 줄", "--bounds", B2, "--why", "판정 경계 기준"], "rule-format"],
    [["--quote", Q2, "--rule", "가".repeat(201), "--bounds", B2, "--why", "판정 경계 기준"], "rule-format"],
    [["--quote", Q2, "--rule", R2 + " " + CL.FINDINGS_MARKERS.ko.start, "--bounds", B2, "--why", "판정 경계 기준"], "rule-format"],
    [["--quote", Q2, "--rule", R2, "--bounds", "나".repeat(201), "--why", "판정 경계 기준"], "bounds-format"],
  ];
  for (const [args, reason] of cases) {
    const r = run(args);
    assert.ok(r.status === 2 && r.stderr.includes("(" + reason + ")"), reason + " ← " + r.status + " " + r.stderr.slice(0, 200));
  }
  assert.strictEqual(rowsOf(P).length, before, "★거부=무기록");
  assert.ok(CF.deliveredUndecided(P.ws, now).some((x) => x.resultId === rA.resultId), "★--from 거부=결과 미소비");
  const ok1 = run(["--quote", Q2, "--rule", R2, "--bounds", B2, "--why", "판정 경계 기준"]);
  assert.ok(ok1.status === 0 && /수칙서 후보로 상신됨/.test(ok1.stdout), ok1.stdout + ok1.stderr);
  const id1 = ok1.stdout.match(/상신됨: ([0-9a-f]{16})/)[1];
  const row1 = rowsOf(P).filter((x) => x.candidateId === id1).pop();
  assert.ok(row1.submitted === true && row1.fmt === CL.RULE_FMT && row1.rule === R2 && row1.bounds === B2 && row1.title === Q2, "★성공 행 " + JSON.stringify(row1));
  const ok2 = run(["--quote", Q1, "--rule", R1, "--bounds", B1, "--why", "분류 결과를 보고 판단", "--from", rA.resultId]);
  assert.ok(ok2.status === 0, ok2.stdout + ok2.stderr);
  const row2 = rowsOf(P).filter((x) => x.fromResult === rA.resultId).pop();
  assert.ok(row2 && row2.fmt === CL.RULE_FMT && row2.rule === R1 && row2.bounds === B1 && row2.title === Q1, "★--from 성공 행 " + JSON.stringify(row2));
  // 민감 형태(라이브러리 — 명령줄과 같은 검사)
  const c9 = turnNow(P, "기억해 줘: " + Q3);
  assert.ok(/^rule-sensitive-/.test(CL.constraintAdd(P.ws, Q3, "근거", "", c9, opt("연락은 someone@example.com 으로만 한다", B3)).reason));
  assert.ok(/^bounds-sensitive-/.test(CL.constraintAdd(P.ws, Q3, "근거", "", c9, opt(R3, "someone@example.com 관련 지적은 범위 밖")).reason));
  // 도움말
  const help = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "constraint"], { env, encoding: "utf8", cwd: P.ws });
  assert.ok(help.stderr.includes("--rule") && help.stderr.includes("--bounds") && help.stderr.includes("--redraft-of"), help.stderr);
});

t("② 유효 문안=마지막 실제 상신 행 · 옛 형식→새 형식 재상신 · 자동 전이 행은 권위 아님 · 순수 함수 경계", () => {
  const P = project("eff", {});
  const id = CL.constraintAdd(P.ws, Q2, "판정 경계 기준", "", turnNow(P, "기억해 줘: " + Q2)).candidateId; // 옛 형식(정정 전 상신 모양)
  assert.strictEqual(CL.candidateBodyText(rowsOf(P), id, Q2), Q2, "옛 형식=원문");
  assert.deepStrictEqual(CL.effectiveCandidateRule(rowsOf(P), id), {}, "옛 형식 실제 상신 행=문안 칸 없음");
  declineByUser(P, id);
  const r2 = CL.constraintAdd(P.ws, Q2, "사용자 재요청", "", Object.assign({}, turnNow(P, Q2), { again: true }), opt(R2, B2));
  assert.ok(r2.ok && r2.candidateId === id, JSON.stringify(r2));
  assert.strictEqual(CL.candidateBodyText(rowsOf(P), id, Q2), R2, "★새 형식 재상신=문안");
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: Q2, fmt: CL.RULE_FMT, rule: "자동 행이 옮겨 실은 다른 문안", bounds: "x", ts: new Date().toISOString() }]));
  assert.strictEqual(CL.candidateBodyText(rowsOf(P), id, Q2), R2, "★자동 전이 행은 문안을 바꾸지 못함");
  assert.strictEqual(CL.ucKeepFields({ candidateId: id, rule: "옛 값" }, {}, rowsOf(P)).rule, R2, "자동 전이 표시값=유효 문안");
  assert.strictEqual(CL.ucKeepFields({ candidateId: "zz", rule: "x", fmt: CL.RULE_FMT }, {}, []).rule, undefined, "유효 문안 없음=표시값도 지움");
  const T = "2026-10-12T00:00:00.000Z";
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", submitted: true, fmt: CL.RULE_FMT, rule: "앞", ts: T }, { candidateId: "x", submitted: true, fmt: CL.RULE_FMT, rule: "뒤", ts: T }], "x", "원문"), "뒤", "같은 시각=장부 순서");
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", submitted: true, fmt: "rule-v9", rule: "a" }], "x", "원문"), null, "★모르는 형식=null");
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", submitted: true, fmt: CL.RULE_FMT, rule: "" }], "x", "원문"), null, "★빈 문안=null");
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", submitted: true, fmt: CL.RULE_FMT, rule: "a b" }], "x", "원문"), null, "줄 구분 문자=null");
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", submitted: true, fmt: CL.RULE_FMT, rule: "가".repeat(201) }], "x", "원문"), null, "200자 초과=null");
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", submitted: true, axis: "outOfScope" }], "x", "원문"), "원문", "⑤ 2단계 형식(문안 칸 없음)=원문");
  assert.strictEqual(CL.candidateBodyText([{ candidateId: "x", origin: "classifier", title: "옛" }], "x", "옛"), "옛", "실제 상신 행 없음=원문");
});

t("③ 초안 두 함수 — 옛 후보=원문 · 새 후보=문안 · 문안 칸 깨짐/모르는 형식=거부(원문 대체 없음)", () => {
  const P = project("draft", {});
  const c = turnNow(P, "기억해 줘: " + Q2 + " 그리고 " + Q3);
  const idOld = CL.constraintAdd(P.ws, Q2, "옛 형식", "", c).candidateId;
  const idNew = CL.constraintAdd(P.ws, Q3, "새 형식", "", c, opt(R3, B3)).candidateId;
  const d1 = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [idOld, idNew], removeItems: [], approvedHash: P.H, target: "core" });
  assert.ok(d1.ok, JSON.stringify(d1));
  const ab1 = proposalAb(P);
  assert.ok(ab1.includes(Q2) && ab1.includes(R3) && !ab1.includes(Q3), "★옛=원문·새=문안 " + JSON.stringify(ab1));
  assert.ok(CL.discardEnvelopeProposalRestoring(P.ws).ok !== false);
  const d2 = CL.draftEnvelopeCandidate(P.ws, P.repo, idNew, P.H);
  assert.ok(d2.ok && proposalAb(P).includes(R3) && !proposalAb(P).includes(Q3), "★단건 초안 함수도 문안 " + JSON.stringify(d2));
  assert.ok(CL.discardEnvelopeProposalRestoring(P.ws).ok !== false);
  assert.strictEqual(latestOf(P, idNew).status, "proposed");
  // 실제 상신 행의 문안 칸이 깨짐(빈 문안) — 원문으로 대신 쓰지 않고 거부
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: idNew, envelopeHash: P.H, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: Q3, submitted: true, fmt: CL.RULE_FMT, rule: "", bounds: B3, ts: new Date().toISOString() }]));
  const b1 = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [idNew], removeItems: [], approvedHash: P.H, target: "core" });
  assert.ok(!b1.ok && /문안 칸/.test(b1.error), "★깨진 문안=초안 거부 " + JSON.stringify(b1));
  assert.ok(!CL.readEnvelopeProposal(P.ws, P.repo) || CL.readEnvelopeProposal(P.ws, P.repo).st !== "ok", "초안 없음");
  // 모르는 형식
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: idOld, envelopeHash: P.H, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: Q2, submitted: true, fmt: "rule-v9", rule: R2, bounds: B2, ts: new Date().toISOString() }]));
  const b2 = CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [idOld], removeItems: [], approvedHash: P.H, target: "core" });
  assert.ok(!b2.ok && /문안 칸/.test(b2.error), "★모르는 형식=초안 거부 " + JSON.stringify(b2));
  const b3 = CL.draftEnvelopeCandidate(P.ws, P.repo, idNew, P.H);
  assert.ok(!b3.ok && /문안 칸/.test(b3.error), "★단건 초안 함수도 거부 " + JSON.stringify(b3));
});

t("④ 다시 쓰기 — 안 올린 같은 저장소 후보만 · 한 요청 문장으로 두 후보 · 같은 쌍 재시도=중복 · 옛 후보 무변 · 자체 한도 · --from 과 섞지 않음", () => {
  const P = project("redraft", {});
  const P2 = project("redraft-other", {});
  const c0 = turnNow(P, "기억해 줘: " + Q2 + " 그리고 " + Q3);
  const X = CL.constraintAdd(P.ws, Q2, "첫 상신", "", c0, opt(R2, B2)).candidateId;
  const Y = CL.constraintAdd(P.ws, Q3, "첫 상신", "", c0, opt(R3, B3)).candidateId;
  declineByUser(P, X);
  const S = "아까 안 올린 두 제안은 주어를 넣어서 쉬운 말로 고쳐서 다시 올려줘";
  const c1 = turnNow(P, S);
  const R2b = "검증 담당은 검증이 끝난 뒤 사용자가 원래 쓰던 설정으로 돌려 놓았는지 확인한다";
  const R3b = "검증 담당은 이 프로젝트에서 외부 서버 연동 오류를 결함으로 세지 않는다";
  const before = rowsOf(P).length, xRows = rowsOf(P).filter((r) => r.candidateId === X).length;
  const rej = (o, why) => assert.strictEqual(CL.constraintAdd(P.ws, S, "고쳐 다시", "", c1, opt(R2b, B2, o)).reason, why, JSON.stringify(o));
  rej({ redraftOf: Y }, "redraft-target"); // 아직 대기(안 올림 아님)
  rej({ redraftOf: "0".repeat(16) }, "redraft-target"); // 없는 후보
  rej({ redraftOf: "" }, "redraft-target");
  rej({ redraftOf: "abc" }, "redraft-target");
  rej({ redraftOf: X, from: "f".repeat(16) }, "redraft-with-from");
  assert.strictEqual(CL.constraintAdd(P.ws, S, "고쳐 다시", "", Object.assign({}, c1, { repoKey: P2.rk }), opt(R2b, B2, { redraftOf: X })).reason, "redraft-target", "다른 저장소 문맥");
  assert.strictEqual(rowsOf(P).length, before, "★거부=무기록");
  const n1 = CL.constraintAdd(P.ws, S, "고쳐 다시", "", c1, opt(R2b, B2, { redraftOf: X }));
  assert.ok(n1.ok && n1.candidateId !== X && n1.redraftOf === X, JSON.stringify(n1));
  const row1 = rowsOf(P).filter((r) => r.candidateId === n1.candidateId).pop();
  assert.ok(row1.redraftOf === X && row1.rule === R2b && row1.title === S && row1.fmt === CL.RULE_FMT, JSON.stringify(row1));
  assert.ok(rowsOf(P).filter((r) => r.candidateId === X).length === xRows && latestOf(P, X).status === "declined" && CL.userDeclinedCandidate(rowsOf(P), X), "★옛 후보 무변");
  declineByUser(P, Y);
  const n2 = CL.constraintAdd(P.ws, S, "고쳐 다시", "", c1, opt(R3b, B3, { redraftOf: Y }));
  assert.ok(n2.ok && n2.candidateId !== n1.candidateId, "★한 요청 문장으로 두 후보 " + JSON.stringify(n2));
  assert.strictEqual(CL.constraintAdd(P.ws, S, "고쳐 다시", "", c1, opt("또 다른 문안으로 다시 쓴 수칙", B2, { redraftOf: X })).reason, "duplicate", "★같은 (요청 문장, 대상) 재시도=중복");
  // 자체 상신 한도 — 같은 차례의 셋째 다시 쓰기
  const W = CL.constraintAdd(P.ws, Q4, "첫 상신", "", turnNow(P, Q4), opt(R4, B4)).candidateId;
  declineByUser(P, W);
  assert.strictEqual(CL.constraintAdd(P.ws, S, "고쳐 다시", "", c1, opt("보고서 첫머리에 바뀐 파일 목록을 둔다", B4, { redraftOf: W })).reason, "turn-cap", "★자체 상신 한도 안");
  // 다시 쓴 후보를 사용자가 또 안 올리면 그 id 에 거절 기억(재상신은 --again)
  declineByUser(P, n1.candidateId);
  assert.strictEqual(CL.constraintAdd(P.ws, S, "고쳐 다시", "", turnNow(P, S), opt(R2b, B2, { redraftOf: X })).reason, "declined-suppressed", "★다시 쓴 후보의 거절 기억");
  assert.ok(CL.constraintAdd(P.ws, S, "사용자 재요청", "", Object.assign({}, turnNow(P, S), { again: true }), opt(R2b, B2, { redraftOf: X })).ok, "재요청(--again)은 재상신");
});

t("⑤ 복원·이월 — 초안→취소(폐기 복원)→재초안 · 고아 복원 · 세대 이월 뒤 유효 문안 유지", () => {
  const P = project("carry", {});
  const id = CL.constraintAdd(P.ws, Q2, "새 형식", "", turnNow(P, "기억해 줘: " + Q2), opt(R2, B2)).candidateId;
  assert.ok(CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "core" }).ok);
  assert.ok(CL.discardEnvelopeProposalRestoring(P.ws).ok !== false);
  const lt = latestOf(P, id);
  assert.ok(lt.status === "proposed" && lt.fmt === CL.RULE_FMT && lt.rule === R2 && lt.bounds === B2 && lt.submitted !== true, "★폐기 복원 행=문안 칸 표시값·실제 상신 아님 " + JSON.stringify(lt));
  assert.ok(CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "core" }).ok && proposalAb(P).includes(R2), "★재초안=문안");
  assert.ok(CL.discardEnvelopeProposalRestoring(P.ws).ok !== false);
  // 채택 고아 → 조정이 복원
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: id, envelopeHash: P.H, status: "adopted", note: "draft x", ts: new Date().toISOString() }]));
  CL.reconcileMemoryCandidates(P.ws, P.repo, P.H);
  const lo = latestOf(P, id);
  assert.ok(lo.status === "proposed" && lo.rule === R2 && lo.fmt === CL.RULE_FMT && lo.submitted !== true, "★고아 복원 행 " + JSON.stringify(lo));
  // 새 승인 세대(문안·원문 모두 미등재) → 세대 이월
  approve(P, { alwaysBlocker: ["이 프로젝트와 무관한 다른 수칙 한 줄"] });
  CL.reconcileMemoryCandidates(P.ws, P.repo, P.H);
  const lc = latestOf(P, id);
  assert.ok(lc && lc.status === "proposed" && lc.rule === R2 && lc.bounds === B2 && lc.submitted !== true, "★세대 이월 행 " + JSON.stringify(lc));
  assert.strictEqual(CL.candidateBodyText(rowsOf(P), id, Q2), R2);
  assert.ok(CL.draftEnvelopeRevision(P.ws, P.repo, { addCandidateIds: [id], removeItems: [], approvedHash: P.H, target: "core" }).ok && proposalAb(P).includes(R2) && !proposalAb(P).includes(Q2), "★이월 뒤 초안=문안");
});

t("⑥ 대기열 정리 반례 두 방향 — 근거 원문만 등재=정리 안 함 / 문안 등재=정리 (세대 이월·같은 세대 중복 정리·고아 판정 · 실제 조정 함수)", () => {
  // (가) 세대 이월
  const P = project("dd-carry", {});
  const a = CL.constraintAdd(P.ws, Q2, "새 형식", "", turnNow(P, "기억해 줘: " + Q2), opt(R2, B2)).candidateId;
  const b = CL.constraintAdd(P.ws, Q3, "새 형식", "", turnNow(P, "기억해 줘: " + Q3), opt(R3, B3)).candidateId;
  approve(P, { alwaysBlocker: [Q2, R3] });
  CL.reconcileMemoryCandidates(P.ws, P.repo, P.H);
  assert.strictEqual(latestOf(P, a).status, "proposed", "★근거 원문만 등재=이월(정리 안 함)");
  assert.ok(latestOf(P, b).status === "declined" && /이미 수칙서에 등재/.test(latestOf(P, b).note), "★문안 등재=이월 정리 " + JSON.stringify(latestOf(P, b)));
  // (나) 같은 세대 중복 정리 + (다) 고아 판정 · 옛 형식 종전
  const Q6 = "작업이 끝나면 임시 파일은 꼭 지워 달라고 했잖아";
  const P2 = project("dd-same", { alwaysBlocker: [Q2, R3, Q6] });
  const a2 = CL.constraintAdd(P2.ws, Q2, "새 형식", "", turnNow(P2, "기억해 줘: " + Q2), opt(R2, B2)).candidateId;
  const b2 = CL.constraintAdd(P2.ws, Q3, "새 형식", "", turnNow(P2, "기억해 줘: " + Q3), opt(R3, B3)).candidateId;
  const o2 = CL.constraintAdd(P2.ws, Q6, "옛 형식", "", turnNow(P2, "기억해 줘: " + Q6)).candidateId;
  const g2 = CL.constraintAdd(P2.ws, Q4, "새 형식", "", turnNow(P2, "기억해 줘: " + Q4), opt(R3, B3)).candidateId; // 문안이 이미 등재된 채택 고아
  assert.ok(CL.appendEnvelopeCandidates(P2.ws, [{ candidateId: g2, envelopeHash: P2.H, status: "adopted", note: "draft x", ts: new Date().toISOString() }]));
  CL.reconcileMemoryCandidates(P2.ws, P2.repo, P2.H);
  assert.strictEqual(latestOf(P2, a2).status, "proposed", "★근거 원문만 등재=대기 유지");
  assert.ok(latestOf(P2, b2).status === "declined" && /이미 등재된 문안/.test(latestOf(P2, b2).note), "★문안 등재=중복 정리");
  assert.ok(latestOf(P2, o2).status === "declined", "옛 형식(원문=문안)=종전대로 정리");
  assert.strictEqual(latestOf(P2, g2).status, "adopted", "★문안 등재된 채택=고아 아님(복원 안 함)");
  assert.ok(CL.appendEnvelopeCandidates(P2.ws, [{ candidateId: a2, envelopeHash: P2.H, status: "adopted", note: "draft y", ts: new Date().toISOString() }]));
  CL.reconcileMemoryCandidates(P2.ws, P2.repo, P2.H);
  assert.strictEqual(latestOf(P2, a2).status, "proposed", "★근거 원문만 등재된 채택=고아로 복원");
});

t("⑦ 대시보드 — 후보 집계 → 자료 변환(컴파일 산출물) → 카드(문안→근거→영향→왜 · 작성/다시 쓰기 표시 · 문안 칸 이상 · 옛 형식 종전)", () => {
  const P = project("view", {});
  const X = CL.constraintAdd(P.ws, Q2, "첫 상신", "", turnNow(P, "기억해 줘: " + Q2), opt(R2, B2)).candidateId;
  declineByUser(P, X);
  const S = "아까 안 올린 설정 제안은 주어를 넣어서 쉬운 말로 다시 올려줘";
  const R2b = "검증 담당은 검증이 끝난 뒤 사용자가 원래 쓰던 설정으로 돌려 놓았는지 확인한다";
  const rid = CL.constraintAdd(P.ws, S, "사용자가 고쳐 다시 요청", "", turnNow(P, S), opt(R2b, B2, { redraftOf: X })).candidateId;
  const nid = CL.constraintAdd(P.ws, Q3, "판정 경계 기준", "", turnNow(P, "기억해 줘: " + Q3), opt(R3, B3)).candidateId;
  const bid = CL.constraintAdd(P.ws, Q4, "판정 경계 기준", "", turnNow(P, "기억해 줘: " + Q4), opt(R4, B4)).candidateId;
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [{ candidateId: bid, envelopeHash: P.H, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: Q4, submitted: true, fmt: CL.RULE_FMT, rule: "", bounds: B4, ts: new Date().toISOString() }]));
  // [검증 1회차 blocker] 형식 표식이 빈 값("")·모르는 형식인 후보도 화면까지 '문안 칸 이상'으로(형식 표식 값의 참·거짓이 아니라 존재로 판정)
  const Q8 = "배포 전에는 꼭 사용자에게 먼저 물어보라고 했어", Q9 = "검증 결과는 대시보드에만 보여 주면 된다고 했지";
  const eid = CL.constraintAdd(P.ws, Q8, "판정 경계 기준", "", turnNow(P, "기억해 줘: " + Q8), opt("배포 전에는 반드시 사용자 확인을 받는다", "확인 없이 배포하면 결함으로 본다")).candidateId;
  const uid = CL.constraintAdd(P.ws, Q9, "판정 경계 기준", "", turnNow(P, "기억해 줘: " + Q9), opt("검증 결과는 대시보드에만 표시한다", "대화에 결과를 늘어놓으면 결함으로 본다")).candidateId;
  assert.ok(CL.appendEnvelopeCandidates(P.ws, [
    { candidateId: eid, envelopeHash: P.H, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: Q8, submitted: true, fmt: "", rule: "", bounds: "x", ts: new Date().toISOString() },
    { candidateId: uid, envelopeHash: P.H, status: "proposed", kind: "user-constraint", repoKey: P.rk, title: Q9, submitted: true, fmt: "rule-v9", rule: "검증 결과는 대시보드에만 표시한다", bounds: "x", ts: new Date().toISOString() },
  ]));
  const Q7 = "검증 보고는 한국어로만 쓰라고 했어 기억해";
  const oid = CL.constraintAdd(P.ws, Q7, "옛 형식", "", turnNow(P, Q7)).candidateId;
  CL.writeEnvelopeFreeze(P.ws, P.H, "ask-rt-view");
  const cc9 = CB.computeEnvelopeCandidatesFor(P.ws);
  const live = (id) => (cc9.live || []).find((c) => c.candidateId === id);
  assert.ok(live(rid) && live(rid).titles[0] === R2b && live(rid).quote === S && live(rid).bounds === B2 && live(rid).redraftOf === X && live(rid).fmt === CL.RULE_FMT, "집계(다시 쓰기) " + JSON.stringify(live(rid)));
  assert.ok(live(bid) && live(bid).ruleBroken === true && live(bid).titles.length === 0, "집계(문안 칸 이상) " + JSON.stringify(live(bid)));
  for (const x of [eid, uid]) assert.ok(live(x) && live(x).ruleBroken === true && live(x).ruleFmt === true && live(x).titles.length === 0, "★집계(빈·모르는 형식 표식) " + JSON.stringify(live(x)));
  assert.ok(live(rid).ruleFmt === true && live(oid).ruleFmt === undefined, "새 형식 표시=표식 존재");
  assert.ok(live(oid) && live(oid).titles[0] === Q7 && !live(oid).fmt, "집계(옛 형식) " + JSON.stringify(live(oid)));
  assert.ok(!live(X), "안 올린 옛 후보는 목록 밖");
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const i = outSrc.indexOf("const out9 = (cc9.live || []).map("), j = outSrc.indexOf("\n", i);
  assert.ok(i > 0 && j > i, "변환 조각");
  const conv = new Function("cc9", "lat9", "genC9", "CL9", "ws", outSrc.slice(i, j) + "\nreturn out9;")(cc9, CL.readEnvelopeCandidates(P.ws).latest, P.H, CL, P.ws);
  const cv = (id) => conv.find((x) => x.id === id);
  assert.ok(cv(rid).title === R2b && cv(rid).quote === S && cv(rid).bounds === B2 && cv(rid).redraftOf === X && cv(rid).fmt === CL.RULE_FMT, "★변환 " + JSON.stringify(cv(rid)));
  assert.ok(cv(bid).ruleBroken === true && cv(oid).fmt === undefined && cv(oid).ruleFmt === undefined, "변환(이상·옛)");
  for (const x of [eid, uid]) assert.ok(cv(x).ruleBroken === true && cv(x).ruleFmt === true, "★변환에서 문안 칸 이상 표시 유지 " + JSON.stringify(cv(x)));
  const mkEl = (tag) => { const o = { tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, insertBefore(c) { this.children.unshift(c); }, remove() {}, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {} }; Object.defineProperty(o, "innerHTML", { set() { o.children = []; }, get() { return ""; } }); return o; };
  const b2 = outSrc.indexOf('safe(function(){ var ec=$("envCard");'), e2 = outSrc.indexOf('safe(function(){ var uc=$("uwCard");', b2);
  assert.ok(b2 > 0 && e2 > b2);
  const ec = mkEl("div");
  new Function("document", "$", "T", "d", "vscode", "safe", require("./_rf-prelude.js").RFP + "var wbGen='', wbAdds=new Set(), wbRemoves=new Set(), candsMoreOpenWeb=false, signalsOpenWeb=false, rulesOpenWeb=false;\n" + outSrc.slice(b2, e2))({ createElement: mkEl, createTextNode: (tx) => ({ tag: "#text", textContent: String(tx), children: [] }) }, (x) => (x === "envCard" ? ec : null), (a) => a, { envelope: { label: "x", gen: P.H, wsKey: cv(rid).wsKey, lang: "ko", gen0: false, cands: conv }, lang: "ko" }, { postMessage() {} }, (f) => f());
  const all = []; const w = (x) => { all.push(x); (x.children || []).forEach(w); }; w(ec);
  const rowOf = (text) => all.find((x) => (x.children || []).some((c) => c.textContent === text));
  const lines = (row) => row.children.map((c) => c.textContent);
  const rr = rowOf("문안: " + R2b);
  assert.ok(rr, "다시 쓰기 카드");
  const L = lines(rr);
  const at = (pre) => L.findIndex((s) => s.startsWith(pre));
  assert.ok(L[0].includes("안 올리신 제안을 말씀대로 구현 담당이 고쳐 다시 올렸어요"), "★다시 쓰기 표시 " + L[0]);
  assert.ok(at("문안: ") > 0 && at("문안: ") < at("근거: 하신 말 '") && at("근거: 하신 말 '") < at("판정에 미치는 영향: ") && at("판정에 미치는 영향: ") < at("왜: "), "★문안→근거→영향→왜 순 " + JSON.stringify(L));
  assert.ok(L.includes("근거: 하신 말 '" + S + "'") && L.includes("판정에 미치는 영향: " + B2));
  const nr = rowOf("문안: " + R3);
  assert.ok(nr && lines(nr)[0].includes("대화에서 하신 말을 근거로 구현 담당이 수칙 문안을 써서 올렸어요") && lines(nr).includes("근거: 하신 말 '" + Q3 + "'"), "★작성 표시 " + JSON.stringify(nr && lines(nr)));
  const txt = all.map((x) => x.textContent).join(" | ");
  assert.ok(txt.includes("수칙 문안 칸이 비었거나 형식이 맞지 않아 승인할 수 없어요"), "★문안 칸 이상 표시");
  // 문안 칸 이상 카드(형식 표식 rule-v1 빈 문안 · 빈 표식 · 모르는 형식)=각자 안내 줄 · 근거 줄 · 승인 버튼 없음(안 올림만) / 정상 카드=승인 버튼 있음
  const BROKEN = "문안: (수칙 문안 칸이 비었거나 형식이 맞지 않아 승인할 수 없어요)";
  const brokenRows = all.filter((x) => (x.children || []).some((c) => c.textContent === BROKEN));
  assert.strictEqual(brokenRows.length, 3, "★문안 칸 이상 카드 3장 모두 안내 " + brokenRows.length);
  const btns = (row) => (row.children || []).filter((c) => c.tag === "button").map((c) => c.textContent);
  for (const row of brokenRows) {
    assert.ok(!btns(row).some((b) => b.startsWith("승인")) && btns(row).includes("안 올림"), "★문안 칸 이상=승인 버튼 없음·안 올림만 " + JSON.stringify(btns(row)));
    assert.ok(lines(row).some((l) => l.startsWith("근거: 하신 말 '")), "근거 줄은 유지");
  }
  assert.ok(btns(rr).some((b) => b.startsWith("승인")) && btns(nr).some((b) => b.startsWith("승인")), "정상 카드=승인 버튼");
  const orow = rowOf("문안: " + Q7);
  assert.ok(orow && lines(orow)[0].includes("대화에서 직접 말씀하신 약속이에요") && !lines(orow).some((s) => s.startsWith("근거: 하신 말")), "옛 형식=종전 " + JSON.stringify(orow && lines(orow)));
  // 명령줄 후보 목록도 같은 문안
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: P.ws });
  const ls = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "envelope-candidate", "list"], { env, encoding: "utf8", cwd: P.ws });
  assert.ok(ls.stdout.includes(rid + " proposed") && ls.stdout.includes(R2b.slice(0, 40)) && ls.stdout.includes("(문안 칸 이상)") && ls.stdout.includes(Q7.slice(0, 20)), "후보 목록 " + ls.stdout + ls.stderr);
});

t("⑧ 후보 원문(title)을 읽는 곳 전수 목록 — 문안 판정·삽입은 단일 함수, 나머지는 출처·존재 확인(소스 고정)", () => {
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8"), br = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  const cf = fs.readFileSync(path.join(ROOT, "bridge", "classify.js"), "utf8"), ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  const fnSrc = (src, name) => { const i = src.indexOf("function " + name + "("); assert.ok(i >= 0, name); const j = src.indexOf("\nfunction ", i + 10); return src.slice(i, j < 0 ? undefined : j); };
  const reads = (s) => (s.match(/\.title\b/g) || []).length;
  // 후보 장부를 읽는 함수별 원문 읽기 수와 용도(바뀌면 이 목록과 함께 용도를 다시 판정할 것)
  const LIST = [
    [lib, "discardRestoringLocked", 4, "메타 행 찾기(원문 또는 종류가 있는 행) 2 · 복원 행에 원문 옮겨 싣기(출처 — 있으면 싣기) 2"],
    [lib, "constraintAdd", 0, "상신 행에 원문을 쓰기만 함"],
    [lib, "reconcileMemoryCandidatesLocked", 5, "메타 행 찾기 1 · 원문 회수(상태 행에 없으면 첫 행) 4 — 등재·중복·고아 판정은 body9(후보 문안 단일 함수)"],
    [lib, "draftEnvelopeRevision", 3, "원문 존재 확인 2 · 단일 함수의 옛 형식 대체값 1"],
    [lib, "draftEnvelopeCandidateLocked", 3, "원문 존재 확인 2 · 단일 함수의 옛 형식 대체값 1"],
    [br, "cmdEnvelopeCandidate", 2, "단일 함수의 옛 형식 대체값 1 · 원문 존재 확인 1"],
  ];
  for (const [src, name, nRead, why] of LIST) assert.strictEqual(reads(fnSrc(src, name)), nRead, name + " — " + why);
  const dr = fnSrc(lib, "draftEnvelopeRevision"), dc = fnSrc(lib, "draftEnvelopeCandidateLocked"), rc = fnSrc(lib, "reconcileMemoryCandidatesLocked");
  assert.ok(dr.includes("const body9 = candidateBodyText(candRowsAll9, cid, cand.title);") && dr.includes("const t9 = String(body9);") && !dr.includes("String(cand.title)"), "초안(여러 건)=단일 함수");
  assert.ok(dc.includes("const body9 = candidateBodyText(rowsDC9, candidateId, cand.title);") && dc.includes("normBacklogTitle(body9)") && !dc.includes("String(cand.title)") && !dc.includes("normBacklogTitle(cand.title)"), "초안(한 건)=단일 함수");
  assert.ok(rc.includes('const body9 = kindR === "user-constraint" ? (candidateBodyText(candRows, rec.candidateId, title) || "") : title;'), "대기열 정리=단일 함수");
  assert.strictEqual((rc.match(/normBacklogTitle\(title\)/g) || []).length, 1, "원문으로 등재를 판정하는 곳=정리 제안(curator) 추가 이월 1곳뿐");
  assert.strictEqual((rc.match(/normBacklogTitle\(body9\)/g) || []).length, 3, "이월 정리·같은 세대 중복·고아 판정 3곳=문안");
  const cb = fnSrc(br, "computeEnvelopeCandidatesFor");
  assert.ok(cb.includes("CLv5.candidateBodyText(candRows9, rec.candidateId") && !cb.includes('titles: [String(rec.title || m5.title || "")]'), "대시보드 집계=단일 함수");
  // 분류 담당 입력의 '이미 올라간/안 올린 사용자 말'은 승인 전 사용자 원문 대조(출처)라 원문 그대로
  assert.strictEqual((cf.match(/\.title\b/g) || []).length, 2, "classify.js 원문 읽기 2(분류 입력의 대기·안 올림 사용자 말)");
  // 승인 도장의 후보 계보 지문(titleFp)=출처(근거 원문) 지문 — 수칙서에 들어간 문안 자체는 초안·승인 지문이 묶는다
  assert.ok(ext.includes("titleFp: sha1A(m0.title)"), "도장 계보 지문=원문(출처)");
});

(async () => {
  let n = 0;
  for (const [name, fn] of pending) {
    try { await fn(); n++; console.log("  ✅ [" + n + "] " + name); }
    catch (e) { console.error("  ❌ " + name); console.error(e); process.exit(1); }
  }
  console.log("\n결과: " + n + "/" + pending.length + " 통과");
})();
