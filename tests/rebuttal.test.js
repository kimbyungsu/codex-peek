"use strict";
/*
 * [개선 1 · 되받아침 고리 — HARNESS-REALIGNMENT §4 개선 1(A+B+F) · 2026-08-30] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * A: 판마다 제외 칸(번호+한 줄 제목)을 동결하고 판정 도착 자리에 ≤300자 재료로 붙인다.
 * B: finding-judge <id> rebut --oos oos-n = 제외 n번 전제의 되받아침(효력=범위 밖 강등·기록 보존) → 검증자 재소환은 origin boundary-contest+prevId+
 *    contest(20~300자) 필수(없으면 강등) → 같은 계보 두 번째 복귀=분쟁(판단 관문 마커 — 사용자 결정 자동 생성 없음).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const BRIDGE = path.join(__dirname, "..", "bridge", "codex-bridge.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NL = String.fromCharCode(10);
const runCli = (ws, args) => cp.spawnSync(process.execPath, [BRIDGE, ...args], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws }), cwd: ws });

const repoE = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-repo-"));
fs.writeFileSync(path.join(repoE, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["혼자 쓰는 로컬 PC"], alwaysBlocker: ["a1", "a2"], outOfScope: ["서버 두 대에 동시 배포", "네트워크가 끊긴 상태"] }));
const shaE = CL.readVerifyEnvelope(repoE).sha1;
const wsE = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-wse-"));
CL.updateContractPatch(wsE, "ko", { envelopeHash: shaE, scoutRepo: repoE }, { tries: 3 });
const OOS = [{ id: "oos-1", title: "서버 두 대에 동시 배포" }, { id: "oos-2", title: "네트워크가 끊긴 상태" }];
let jobSeq = 0;
const ASK_JOBS = path.join(CL.BRIDGE_DIR, "ask-jobs");
// 검증 잡 실물(최소 필드) — finding-judge --oos는 '마지막 검증 잡'과 동결 askId를 대조한다
const writeJob = (askId, ws) => { fs.mkdirSync(ASK_JOBS, { recursive: true }); fs.writeFileSync(path.join(ASK_JOBS, askId + ".json"), JSON.stringify({ schema: "ask-job-v1", id: askId, state: "done", workspace: ws || wsE, createdAt: new Date(Date.UTC(2026, 7, 31, 0, 0, ++jobSeq)).toISOString() })); };
const freeze = (askId, oos) => { process.env.CODEX_BRIDGE_ASK_JOB_ID = askId; writeJob(askId); assert.strictEqual(CL.writeEnvelopeFreeze(wsE, shaE, askId, { oos: oos || OOS }), true); };
const verdict = (askId, findings) => CB.machineFindingsLayer(["본문", "[지적 목록 v2]", ...findings.map((f) => JSON.stringify(f)), "[지적 목록 끝]", "", "검증: 실패"].join(NL), wsE, "ko", "core", "claude-codex", askId);
const CAMP = "no-campaign";

t("A — 동결 레코드에 제외 칸(번호+제목)이 실리고 판독된다", () => {
  freeze("ask-r1");
  const fz = CL.readFrozenEnvelopeRec(wsE);
  assert.deepStrictEqual(fz.oos, OOS);
  assert.strictEqual(fz.askId, "ask-r1");
});

let X = "";
t("A — 판정 도착 자리에 되받아침 재료(제외 칸 번호+한 줄 제목 ≤200자)가 붙고, 1차 지적은 열린 채 등록", () => {
  const r = verdict("ask-r1", [{ tag: "blocker", title: "배포 두 대 동시 진행 시 잠금 경합", origin: "baseline" }]);
  assert.strictEqual(r.machine.effective, "fail");
  const line = r.notice.split(NL).find((l) => l.startsWith("[되받아침 재료"));
  assert.ok(line && line.includes("oos-1 서버 두 대에 동시 배포") && line.includes("oos-2") && line.includes("finding-judge <id> rebut --oos oos-n") && line.includes("finding-judge --list-oos"), r.notice);
  assert.ok(line.length <= 200, "material budget 200");
  const opens = CL.openFindingsFor(wsE, CAMP, shaE);
  assert.strictEqual(opens.length, 1); X = opens[0].id;
});

t("A — 재료 줄은 이 잡에 결속된 동결만(askId 불일치=재료 없음) · 제외 칸이 많으면 번호 전량+전문 안내(뒤 번호 소실 없음) · --list-oos 전문", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: "oos-" + (i + 1), title: "제외 상황 " + (i + 1) + " — 설명이 꽤 긴 편이라 제목이 서른 자를 넘어간다" }));
  freeze("ask-many", many);
  const r = verdict("ask-many", [{ tag: "blocker", title: "많은 제외 칸 판", origin: "baseline" }]);
  const line = r.notice.split(NL).find((l) => l.startsWith("[되받아침 재료"));
  assert.ok(line && line.length <= 200 && line.includes("oos-1") && line.includes("oos-8") && line.includes("--list-oos"), line);
  // 축 상한 12칸(ENVELOPE_ITEM_MAX) · ko/en 모두 번호 전량이 200자 안에(뒤 번호 절단 없음)
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: "oos-" + (i + 1), title: "제외 상황 " + (i + 1) + " 제목이 길어서 서른 자 상한을 넘기는 설명 문장" }));
  freeze("ask-twelve", twelve);
  for (const lg of ["ko", "en"]) {
    const rT = CB.machineFindingsLayer(["본문", "[지적 목록 v2]", JSON.stringify({ tag: "blocker", title: "열두 칸 판 " + lg, origin: "baseline" }), "[지적 목록 끝]", "", lg === "en" ? "Verdict: fail" : "검증: 실패"].join(NL), wsE, lg, "core", "claude-codex", "ask-twelve");
    const lT = rT.notice.split(NL).find((l) => l.startsWith(lg === "en" ? "[rebuttal material" : "[되받아침 재료"));
    assert.ok(lT && lT.length <= 200 && lT.includes("oos-12") && !lT.endsWith("…"), lg + ": " + lT);
  }
  freeze("ask-many", many);
  const ls = runCli(wsE, ["finding-judge", "--list-oos"]);
  assert.strictEqual(ls.status, 0, ls.stdout + ls.stderr);
  assert.ok(ls.stdout.includes("제외 칸 8건") && ls.stdout.includes("oos-8  제외 상황 8 — 설명이 꽤 긴 편이라 제목이 서른 자를 넘어간다") && ls.stdout.includes("결속됨"), ls.stdout);
  // askId 불일치(잡 env가 다른 잡) → 입장 심사 stale + 재료 없음
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-other";
  const r2 = verdict("ask-other", [{ tag: "blocker", title: "stale 동결 판", origin: "baseline" }]);
  assert.ok(r2.notice.includes("경계 동결이 이 검증 잡에 결속되지 않음") && !r2.notice.includes("[되받아침 재료"), r2.notice);
  // 원 판으로 복귀(다음 시험은 ask-r1 동결·잡을 전제)
  freeze("ask-r1");
  for (const a9 of ["ask-many", "ask-twelve"]) CL.resolveJudgeRequired(wsE, a9, "close-oos", { note: "시험 정리 — 많은 제외 칸 판 종결" });
  for (const p9 of CL.judgeRequiredPending(wsE)) CL.resolveJudgeRequired(wsE, p9.askId, "close-oos", { note: "시험 정리 — stale 판 종결" });
  const opensNow = CL.openFindingsFor(wsE, CAMP, shaE);
  for (const o of opensNow) if (o.id !== X) { const c = runCli(wsE, ["finding-judge", o.id, "park", "--note", "시험 정리 — 부수 지적 보관함", "--campaign", CAMP]); assert.strictEqual(c.status, 0, c.stdout + c.stderr); }
});

t("B — finding-judge rebut --oos: 무효 번호 거부 / 마지막 검증 잡과 결속되지 않은 동결 거부 / 유효 번호=처분+종결 행을 한 번의 쓰기로(삭제 아님)", () => {
  const bad = runCli(wsE, ["finding-judge", X, "rebut", "--oos", "oos-9", "--note", "동결된 제외 칸에 없는 번호로 되받아침", "--campaign", CAMP]);
  assert.notStrictEqual(bad.status, 0, bad.stdout + bad.stderr);
  assert.strictEqual(CL.openFindingsFor(wsE, CAMP, shaE).length, 1);
  // 새 판의 잡은 생겼는데 동결 쓰기가 실패해 이전 판 동결이 남은 상황 → 이전 판 번호 거부
  writeJob("ask-stale-newer");
  const stale = runCli(wsE, ["finding-judge", X, "rebut", "--oos", "oos-1", "--note", "이전 판 동결로 되받아침 시도", "--campaign", CAMP]);
  assert.notStrictEqual(stale.status, 0, stale.stdout + stale.stderr);
  assert.ok((stale.stdout + stale.stderr).includes("마지막 검증 잡에 결속되지 않았습니다"), stale.stdout + stale.stderr);
  assert.strictEqual(CL.openFindingsFor(wsE, CAMP, shaE).length, 1);
  assert.ok(!CL.readFindingsLedger(wsE).some((r) => r.type === "disposition" && r.findingId === X), "rejected rebut must not record a disposition");
  fs.unlinkSync(path.join(ASK_JOBS, "ask-stale-newer.json"));
  const ok = runCli(wsE, ["finding-judge", X, "rebut", "--oos", "oos-1", "--note", "지적이 서버 두 대 동시 배포를 전제 — 승인 범위 밖", "--campaign", CAMP]);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(ok.stdout.includes("되받아침: " + X + " → 제외 oos-1"), ok.stdout);
  const rows = CL.readFindingsLedger(wsE);
  const disp = rows.find((r) => r.type === "disposition" && r.findingId === X);
  assert.ok(disp && disp.choice === "rebut" && disp.oosId === "oos-1");
  const close = rows.find((r) => r.type === "close" && r.findingId === X && r.closeReason === "implementer-oos");
  assert.ok(close && close.oosId === "oos-1" && close.envelopeHash === shaE);
  assert.strictEqual(CL.openFindingsFor(wsE, CAMP, shaE).length, 0);
  assert.ok(rows.some((r) => r.type === "finding" && r.findingId === X), "finding row preserved (no deletion)");
  // 원자성: 종결 행이 처분 행보다 '앞'에 기록된다(꼬리 부분 기록에서 살아남는 쪽=종결) + 쓰기 뒤 읽기 확인
  const iC = rows.findIndex((r) => r.type === "close" && r.findingId === X && r.closeReason === "implementer-oos"), iD = rows.findIndex((r) => r.type === "disposition" && r.findingId === X);
  assert.ok(iC >= 0 && iD > iC, "close row must precede the disposition row in the ledger");
  assert.strictEqual(rows[iC].ts, rows[iD].ts, "same write stamp");
  const src = fs.readFileSync(BRIDGE, "utf8");
  assert.ok(src.includes('rowsJ.unshift({ type: "close", campaignId: camp, findingId: id, closeReason: "implementer-oos"') && src.includes("if (!rowsJ.every(has)) wrote = false;"), "close-first + read-back");
  assert.strictEqual((src.match(/closeReason: "implementer-oos"/g) || []).length, 1, "exactly one writer of implementer-oos close rows");
  // 부분 기록 실증: 처분 행이 잘려 나간 장부(종결 행만 완전) → 지적은 닫힌 채(계보 보존)·관문 미판단 목록에도 없음·다음 판 resolved 대상 아님
  const wsP = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-wsp-"));
  CL.appendFindingsLedger(wsP, [{ type: "finding", findingId: "f-0000p001", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "부분 기록 지적", title: "부분 기록 지적", origin: "baseline", envelopeHash: shaE, demoted: false, status: "open", ts: "2026-08-31T00:00:00.000Z" }]);
  fs.appendFileSync(CL.findingsLedgerFileFor(wsP), JSON.stringify({ type: "close", campaignId: CAMP, findingId: "f-0000p001", closeReason: "implementer-oos", oosId: "oos-1", round: 1, envelopeHash: shaE, ts: "2026-08-31T00:00:01.000Z" }) + NL + '{"type":"disposition","campaignId":"' + CAMP + '","findingId":"f-0000p0');
  assert.strictEqual(CL.openFindingsFor(wsP, CAMP, shaE).length, 0, "closed by the surviving close row");
  assert.strictEqual(CL.undisposedOpenFindings(wsP, CAMP, shaE).length, 0);
  assert.strictEqual(CB.implementerRebuttalsFor(wsP, CAMP, shaE).length, 1, "lineage preserved without the disposition row");
  // 2단계 반례(3회차 확인): 종결 행 '중간'에서 끊긴 조각 → 재시도 append가 조각과 결합하지 않고(개행 격리) 새 행은 온전 · 처분만 남은 장부는 미판단 유지
  const wsQ = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-wsq-"));
  CL.appendFindingsLedger(wsQ, [{ type: "finding", findingId: "f-0000q001", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "조각 결합 지적", title: "조각 결합 지적", origin: "baseline", envelopeHash: shaE, demoted: false, status: "open", ts: "2026-08-31T00:00:00.000Z" }]);
  fs.appendFileSync(CL.findingsLedgerFileFor(wsQ), '{"type":"close","campaignId":"' + CAMP + '","findingId":"f-0000q001","closeReason":"implementer-o'); // 개행 없는 조각
  const okQ = CL.appendFindingsLedger(wsQ, [{ type: "close", campaignId: CAMP, findingId: "f-0000q001", closeReason: "implementer-oos", oosId: "oos-1", round: 1, envelopeHash: shaE, ts: "2026-08-31T00:00:02.000Z" }, { type: "disposition", campaignId: CAMP, findingId: "f-0000q001", choice: "rebut", oosId: "oos-1", note: "재시도", asOfRound: 1, ts: "2026-08-31T00:00:02.000Z" }]);
  assert.strictEqual(okQ, true);
  const rowsQ = CL.readFindingsLedger(wsQ);
  assert.ok(rowsQ.some((r) => r.type === "close" && r.closeReason === "implementer-oos"), "retry close row survives as its own line (fragment isolated)");
  assert.strictEqual(CL.openFindingsFor(wsQ, CAMP, shaE).length, 0);
  // 처분만 유효하게 남은 장부(종결 없음) → 관문은 미판단으로 본다(처분이 종결 행에 결속)
  const wsR = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-wsr-"));
  CL.appendFindingsLedger(wsR, [{ type: "finding", findingId: "f-0000r001", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "처분만 남은 지적", title: "처분만 남은 지적", origin: "baseline", envelopeHash: shaE, demoted: false, status: "open", ts: "2026-08-31T00:00:00.000Z" },
    { type: "disposition", campaignId: CAMP, findingId: "f-0000r001", choice: "rebut", oosId: "oos-1", note: "종결 없는 처분", asOfRound: 1, ts: "2026-08-31T00:00:03.000Z" }]);
  assert.strictEqual(CL.openFindingsFor(wsR, CAMP, shaE).length, 1);
  assert.deepStrictEqual(CL.undisposedOpenFindings(wsR, CAMP, shaE).map((o) => o.id), ["f-0000r001"], "rebut disposition without its close row must not count as judged");
  // 판독 실패 경로(4회차 확인): 꼬리 판독이 권한 오류면 append 거부(장부 불변) · 장부 전체 판독 오류면 처분 관문은 차단(proceed:false)
  const wsS = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-wss-"));
  CL.appendFindingsLedger(wsS, [{ type: "finding", findingId: "f-0000s001", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "판독 실패 지적", title: "판독 실패 지적", origin: "baseline", envelopeHash: null, demoted: false, status: "open", ts: "2026-08-31T00:00:00.000Z" }]);
  const ledgerS = CL.findingsLedgerFileFor(wsS);
  const before = fs.readFileSync(ledgerS, "utf8");
  const openOrig = fs.openSync;
  fs.openSync = function (f, ...a) { if (String(f) === ledgerS) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return openOrig.call(fs, f, ...a); };
  let okS;
  try { okS = CL.appendFindingsLedger(wsS, [{ type: "disposition", campaignId: CAMP, findingId: "f-0000s001", choice: "fix-fact", note: "권한 오류 중 쓰기", asOfRound: 1, ts: "2026-08-31T00:00:05.000Z" }]); } finally { fs.openSync = openOrig; }
  assert.strictEqual(okS, false, "tail read failure (non-ENOENT) must refuse the append");
  assert.strictEqual(fs.readFileSync(ledgerS, "utf8"), before, "ledger unchanged");
  const readOrig = fs.readFileSync;
  fs.readFileSync = function (f, ...a) { if (String(f) === ledgerS) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return readOrig.call(fs, f, ...a); };
  let gS;
  try { gS = CB.findingDispositionGate(wsS, null, "ko", CAMP); } finally { fs.readFileSync = readOrig; }
  assert.strictEqual(gS.proceed, false, "persistent ledger read error must close the gate");
  assert.ok(gS.exitCode === 3 && /장부를 읽지 못해/.test(gS.msg), gS.msg);
  assert.strictEqual(CB.findingDispositionGate(wsS, null, "ko", CAMP).proceed, false, "readable again: the open finding is still unjudged → still closed");
  // 경합 반례(5회차 확인): 첫 판독은 성공, 그 뒤 판독부터 EACCES → 관문은 여전히 차단(단일 스냅샷 계산·재판독 0회)
  let readsS = 0;
  fs.readFileSync = function (f, ...a) { if (String(f) === ledgerS && ++readsS > 1) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; } return readOrig.call(fs, f, ...a); };
  let gS2;
  try { gS2 = CB.findingDispositionGate(wsS, null, "ko", CAMP); } finally { fs.readFileSync = readOrig; }
  assert.strictEqual(gS2.proceed, false, "first read ok, later reads fail → gate must still block (single snapshot)");
  assert.strictEqual(readsS, 1, "gate must read the ledger exactly once");
  const okS2 = runCli(wsS, ["finding-judge", "f-0000s001", "fix-fact", "--note", "판독 복구 뒤 정상 처분", "--campaign", CAMP]);
  assert.strictEqual(okS2.status, 0, okS2.stdout + okS2.stderr);
  assert.strictEqual(CB.findingDispositionGate(wsS, null, "ko", CAMP).proceed, true);
  // 일반 처분(oosId 없음)은 종전대로 유효
  CL.appendFindingsLedger(wsR, [{ type: "disposition", campaignId: CAMP, findingId: "f-0000r001", choice: "rebut", note: "메모만 되받아침", asOfRound: 1, ts: "2026-08-31T00:00:04.000Z" }]);
  assert.strictEqual(CL.undisposedOpenFindings(wsR, CAMP, shaE).length, 0);
});

t("B — 다음 검증 요청의 서식 안내에 '구현자 되받아침' 목록이 실린다(데이터 행) · origin 열거에 boundary-contest", () => {
  const d = CB.v2DirectiveFor(wsE, "ko");
  assert.ok(d.includes("[구현자 되받아침(범위 밖)]") && d.includes("> " + X + " ← oos-1"), d);
  assert.ok(d.includes("boundary-contest") && d.includes('"contest"') && d.includes("20~300자") && d.includes("같은 제목을 새 id·다른 origin으로 올려도 같은 지적으로 심사"), d);
  // 규칙 문장은 되받아침이 있을 때만(고정 산문 예산 밖) — 되받아침 0인 작업공간의 서식 안내엔 contest 규칙이 없다
  const wsZ = fs.mkdtempSync(path.join(os.tmpdir(), "rebut-wsz-"));
  const dz = CB.v2DirectiveFor(wsZ, "ko");
  assert.ok(dz.includes("boundary-contest") && !dz.includes('"contest"') && !dz.includes("[구현자 되받아침"), dz);
  const rb = CB.implementerRebuttalsFor(wsE, CAMP, shaE);
  assert.strictEqual(rb.length, 1); assert.strictEqual(rb[0].findingId, X); assert.strictEqual(rb[0].restores, 0);
});

t("B — 재소환에 반증(contest)이 없거나 짧으면 강등(contest-unproven)·판정 보류·사용자 결정 자동 생성 0", () => {
  freeze("ask-r2");
  const r = verdict("ask-r2", [{ tag: "blocker", title: "잠금 경합 다시", origin: "boundary-contest", prevId: X, contest: "짧음" }]);
  assert.ok(r.notice.includes("contest") || r.notice.includes("반증"), r.notice);
  assert.ok(r.notice.includes("되받아친 지적의 재소환 — 반증(contest 20~300자) 없음"), r.notice);
  assert.strictEqual(r.machine.admission.kept, 0); assert.strictEqual(r.machine.admission.demoted, 1);
  assert.strictEqual(r.machine.effective, "inconclusive"); // 전량 강등=보류(기존 규칙)+판단 관문
  assert.strictEqual(CL.readDecisions(wsE).rows.length, 0);
  assert.deepStrictEqual(CL.judgeRequiredPending(wsE).map((x) => x.askId), ["ask-r2"]);
  assert.strictEqual(CL.resolveJudgeRequired(wsE, "ask-r2", "close-oos", { note: "반증 없는 재소환 — 범위 밖 종결" }).ok, true);
  // 반증 형식 엄격(확인 blocker⑤): 301자·다행 contest는 파서가 잘라 살리지 않고 부재 취급 → 강등
  const long301 = "가".repeat(301);
  const rL = verdict("ask-r2", [{ tag: "blocker", title: "잠금 경합 301자 반증", origin: "boundary-contest", prevId: X, contest: long301 }]);
  assert.strictEqual(rL.machine.admission.kept, 0, rL.notice);
  const rN = verdict("ask-r2", [{ tag: "blocker", title: "잠금 경합 다행 반증", origin: "boundary-contest", prevId: X, contest: "첫 줄은 스무 자가 넘는 근거 문장입니다" + NL + "둘째 줄" }]);
  assert.strictEqual(rN.machine.admission.kept, 0, rN.notice);
  // 우회 차단(확인 blocker①): id·prevId 없이 새 지적처럼 fix-induced로 올려도 정규화 제목이 같으면 규칙 2b가 잡는다
  const rB = verdict("ask-r2", [{ tag: "blocker", title: "배포 두 대 동시 진행 시 잠금 경합", origin: "fix-induced", supported: true }]);
  assert.ok(rB.notice.includes("되받아친 지적의 재소환 — 반증(contest 20~300자) 없음") && rB.machine.admission.kept === 0, rB.notice);
  // 같은 제목 + boundary-contest + 유효 contest 이지만 prevId 없음 → 세 필드 전부가 아니므로 복귀 없음(2차 확인 blocker①)
  const rP = verdict("ask-r2", [{ tag: "blocker", title: "배포 두 대 동시 진행 시 잠금 경합", origin: "boundary-contest", contest: "서버 한 대에서도 프로세스 두 개를 띄우면 같은 경합이 재현됨" }]);
  assert.strictEqual(rP.machine.admission.kept, 0, rP.notice);
  assert.ok(rP.notice.includes("contest") || rP.notice.includes("반증"), rP.notice);
  // 계보 없는 origin boundary-contest(되받아친 id 인용 없음·제목도 다름)는 규칙 2b 대상이 아님 — 후속 라운드 신규 이론으로 기존 규칙 3이 처리
  const r2 = verdict("ask-r2", [{ tag: "blocker", title: "무관한 새 지적", origin: "boundary-contest", contest: "이것은 승인 범위 안에서도 재현되는 문제입니다" }]);
  assert.ok(r2.notice.includes("후속 라운드 신규 blocker") || r2.machine.admission.demoted === 1, r2.notice);
  for (const p9 of CL.judgeRequiredPending(wsE)) CL.resolveJudgeRequired(wsE, p9.askId, "close-oos", { note: "시험 정리 — 반증 부적격·신규 이론 범위 밖 종결" });
});

let Y = "";
t("B — 반증(20~300자)이 있으면 복귀(contest-restored)·실패 유지·새 id로 열림", () => {
  freeze("ask-r3");
  const r = verdict("ask-r3", [{ tag: "blocker", title: "잠금 경합 — 단일 서버에서도 재현", origin: "boundary-contest", prevId: X, contest: "서버 한 대에서 프로세스 두 개를 동시에 띄워도 같은 경합이 20회 중 3회 재현됨" }]);
  assert.ok(r.notice.includes("되받아친 지적 복귀 — 반증 제시"), r.notice);
  assert.strictEqual(r.machine.effective, "fail"); assert.strictEqual(r.machine.admission.kept, 1);
  const opens = CL.openFindingsFor(wsE, CAMP, shaE);
  assert.strictEqual(opens.length, 1); Y = opens[0].id; assert.notStrictEqual(Y, X);
  assert.strictEqual(CL.judgeRequiredPending(wsE).length, 0, "no dispute yet");
  const row = CL.readFindingsLedger(wsE).find((x) => x.type === "finding" && x.findingId === Y);
  assert.strictEqual(row.origin, "boundary-contest"); assert.strictEqual(row.prevId, X);
});

t("B — 두 번째 되받아침 뒤 다시 복귀하면 분쟁: 판단 관문 마커(reason dispute:<id>)·사용자 결정 자동 생성 0·판정은 그대로", () => {
  const ok = runCli(wsE, ["finding-judge", Y, "rebut", "--oos", "oos-1", "--note", "재현 조건이 여전히 다중 배포 전제 — 범위 밖", "--campaign", CAMP]);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  const rb = CB.implementerRebuttalsFor(wsE, CAMP, shaE);
  const y = rb.find((x) => x.findingId === Y); assert.ok(y && y.restores === 1, JSON.stringify(rb));
  freeze("ask-r4");
  const r = verdict("ask-r4", [{ tag: "blocker", title: "잠금 경합 — 단일 서버 재현 로그 첨부", origin: "boundary-contest", prevId: Y, contest: "단일 서버·단일 배포 조건에서도 로그 3건으로 경합이 재현됨(첨부)" }]);
  assert.ok(r.notice.includes("두 번째 복귀 — 분쟁") && r.notice.includes("[분쟁] " + Y) && r.notice.includes("round-judge ask-r4"), r.notice);
  assert.strictEqual(r.machine.effective, "fail");
  assert.deepStrictEqual(CL.judgeRequiredPending(wsE).map((x) => [x.askId, x.reason]), [["ask-r4", "dispute:" + Y]]);
  assert.strictEqual(CL.readDecisions(wsE).rows.length, 0, "no auto user decision");
  // 구현자 판단: escalate는 결정 장부 실존 항목 필수
  assert.strictEqual(CL.resolveJudgeRequired(wsE, "ask-r4", "escalate", { note: "범위표 자체를 바꿔야 하는 방향 질문" }).reason, "decision-required");
  const d = CL.openDecision(wsE, { origin: "implementer", kind: "boundary", campaignId: CAMP, sourceAsk: "ask-r4", targetFp: "", question: "'서버 두 대 동시 배포'를 제외 상황에서 뺄까요?", why: "검증자가 단일 서버 재현 근거를 두 번 제시", noDefault: "범위표는 사용자가 정하는 영역", choices: [{ key: "keep", label: "제외 유지" }, { key: "remove", label: "제외에서 빼고 고침" }], recommend: "remove" });
  assert.strictEqual(CL.resolveJudgeRequired(wsE, "ask-r4", "escalate", { note: "범위표 자체를 바꿔야 하는 방향 질문", decisionId: d.decisionId }).ok, true);
  assert.strictEqual(CL.judgeRequiredPending(wsE).length, 0);
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
});

t("판정 도착 자리 예산 — 처리 안내·규약 절차문 축약으로 재료 200자를 상쇄(꼬리+재료 ≤ 개선 전 꼬리)", () => {
  const before = { ko: 1894, en: 3520 }; // 개선 1 직전(HEAD 0e7b419) 실측: formatForClaude 실패 꼬리(재판단 규약 포함)
  const tail = CL.formatForClaude("x" + NL + "검증: 실패", "ko", "core", null, CL.safeLoadRejudge("ko", "core"));
  const tailLen = tail.length - 1;
  assert.ok(tailLen + 200 <= before.ko, `ko tail ${tailLen} + material 200 must stay ≤ ${before.ko}`);
  const tailEn = CL.formatForClaude("x" + NL + "Verdict: fail", "en", "core", null, CL.safeLoadRejudge("en", "core")).length - 1;
  assert.ok(tailEn + 200 <= before.en, `en tail ${tailEn} + material 200 must stay ≤ ${before.en}`);
  assert.ok(tail.includes("처리 의무: 수정 필요") && tail.includes("[재판단 규약"), tail.slice(0, 200));
});

t("소스 핀 — 규칙 2b가 규칙 1(미완 수정) 앞에 있고 되받아침 종결은 삭제가 아닌 close 행·자동 사용자 결정 생산자 없음", () => {
  const lib = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  const i2b = lib.indexOf("규칙 2b(개선 1-B"), i1 = lib.indexOf("규칙 1(면제 — prevId는 영수증만");
  assert.ok(i2b > 0 && i1 > i2b, "rule 2b must precede rule 1");
  const src = fs.readFileSync(BRIDGE, "utf8");
  assert.ok(src.includes('closeReason: "implementer-oos"'));
  assert.ok(lib.includes("!/[\\r\\n\\u2028\\u2029]/.test(c9)) rec.contest = c9;"), "contest parse: single-line 20~300 only, never truncated");
  assert.ok(lib.includes('f.origin === "boundary-contest" && f.prevId && f.prevId === rbKey && c9.length >= 20'), "restore needs all three fields (prevId bound)");
  assert.strictEqual((src.match(/openDecision\(/g) || []).length, 1, "still only decisions raise creates decisions");
  assert.ok(src.includes('reason: "dispute:"'));
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
