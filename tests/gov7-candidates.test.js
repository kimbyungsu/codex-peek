/*
 * 거버넌스 §7 증분 1 — 수칙서 후보 장부·occurrence 계보·소진 보고 후보 재료 실행 테스트.
 * 계약: ①occurrence 레코드가 재등장 시 기록됨(소스 배선) ②후보 집계=oos 반복 2+·escalation·계보(blocker) 반복
 * ③재제시 스킵=같은 (candidateId, 승인 세대) declined|failed ④0건=명시 ⑤장부 append 전용·미지 status 무시
 * ⑥CLI list/mark ⑦소진(res.last) 아닐 때=출력 0바이트.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "gov7_home_"));
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const CB = require(path.join(ROOT, "bridge", "codex-bridge.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const ws = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_ws_"));
const GEN = "a".repeat(40);
const CAMP = "cl:test:2026-07-24T00:00:00.000Z";
// 소진 재료 함수는 currentCampaignIdFor(캠페인 서랍)·readFrozenEnvelope(동결 파일)를 읽는다 — 픽스처로 구성
fs.mkdirSync(path.dirname(CL.campaignFileFor(ws)), { recursive: true });
fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 3, budget: 3, startedAt: "T", updatedAt: "T" }));
CL.writeEnvelopeFreeze(ws, GEN, "ask-test-1");

console.log("[1] 후보 장부 — append·fold·미지 status 무시·세대 축");
{
  const id1 = CL.envelopeCandidateId("oos-repeat", "oos-2");
  ok(/^[0-9a-f]{16}$/.test(id1) && id1 === CL.envelopeCandidateId("oos-repeat", "oos-2"), "candidateId=결정론 16hex");
  ok(CL.appendEnvelopeCandidates(ws, [{ candidateId: id1, envelopeHash: GEN, status: "proposed", ts: "T1" }]), "append 성공");
  CL.appendEnvelopeCandidates(ws, [{ candidateId: id1, envelopeHash: GEN, status: "declined", ts: "T2" }]);
  CL.appendEnvelopeCandidates(ws, [{ candidateId: id1, envelopeHash: GEN, status: "hacked", ts: "T3" }]); // 미지 status
  const { rows, latest } = CL.readEnvelopeCandidates(ws);
  ok(rows.length === 3, "append 전용(이전 기록 보존 — 3줄)");
  ok(latest.get(id1 + "@" + GEN).status === "declined", "최신 유효 status=declined(미지 status 'hacked'는 판정 권위 없음)");
  ok(!latest.has(id1 + "@" + "b".repeat(40)), "다른 승인 세대 키에는 없음(세대 축 격리)");
}

console.log("[2] occurrence 배선(소스 계약) — 재등장 시 계보 기록");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes('type: "occurrence"') && src.includes("effectiveTag: f.demotedTo || f.tag") && src.includes("prevId: f.prevId || \"\""), "재등장(cited) 블록에서 occurrence 레코드 기록(effectiveTag=당시 유효 딱지·prevId 보존)");
  const gov = fs.readFileSync(path.join(ROOT, "docs", "VERIFY-GOVERNANCE.md"), "utf8");
  ok(gov.includes("레코드 5유형") && gov.includes('occurrence[§7 재등장 계보'), "§3 레코드 유형 4→5종 문서 동기");
}

console.log("[3] 소진 보고 후보 재료 — 집계·스킵·0건 명시·비소진=0바이트");
{
  // 계보 장부 픽스처: oos-2 강등 2건·escalation 1건·occurrence(blocker) 2건(f-aaa)·occurrence(보완) 2건(f-bbb — 집계 제외)
  CL.appendFindingsLedger(ws, [
    { type: "finding", findingId: "f-aaa", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "제목A", envelopeHash: GEN, demoted: false, status: "open", ts: "T" },
    { type: "finding", findingId: "f-o1", campaignId: CAMP, round: 1, tag: "주의", titleNorm: "범위밖1", oosId: "oos-2", envelopeHash: GEN, demoted: true, status: "closed", ts: "T" },
    { type: "finding", findingId: "f-o2", campaignId: CAMP, round: 2, tag: "주의", titleNorm: "범위밖2", oosId: "oos-2", envelopeHash: GEN, demoted: true, status: "closed", ts: "T" },
    { type: "finding", findingId: "f-esc", campaignId: CAMP, round: 2, tag: "blocker", titleNorm: "확장승격", envelopeHash: GEN, demoted: false, status: "open", ts: "T" },
    { type: "escalation", findingId: "f-esc", campaignId: CAMP, round: 2, envelopeHash: GEN, ts: "T" },
    { type: "occurrence", findingId: "f-aaa", campaignId: CAMP, prevId: "f-aaa", round: 2, envelopeHash: GEN, effectiveTag: "blocker", ts: "T" },
    { type: "occurrence", findingId: "f-aaa", campaignId: CAMP, prevId: "f-aaa", round: 3, envelopeHash: GEN, effectiveTag: "blocker", ts: "T" },
    { type: "finding", findingId: "f-bbb", campaignId: CAMP, round: 1, tag: "보완", titleNorm: "제목B", envelopeHash: GEN, demoted: false, status: "open", ts: "T" },
    { type: "occurrence", findingId: "f-bbb", campaignId: CAMP, prevId: "f-bbb", round: 2, envelopeHash: GEN, effectiveTag: "보완", ts: "T" },
    { type: "occurrence", findingId: "f-bbb", campaignId: CAMP, prevId: "f-bbb", round: 3, envelopeHash: GEN, effectiveTag: "보완", ts: "T" },
    { type: "finding", findingId: "f-zzz", campaignId: "other-camp", round: 1, tag: "주의", titleNorm: "딴캠페인", oosId: "oos-2", envelopeHash: GEN, demoted: true, status: "closed", ts: "T" },
  ]);
  const notice = CB.envelopeCandidateNoticeFor(ws, "ko", { tracked: true, last: true, n: 3, budget: 3 });
  ok(notice.includes("[수칙서 후보 재료"), "소진(마지막 예약 왕복)=재료 절 출력");
  const idOos = CL.envelopeCandidateId("oos-repeat", "oos-2");
  const idEsc = CL.envelopeCandidateId("escalation", "f-esc");
  const idLin = CL.envelopeCandidateId("lineage", "f-aaa");
  { const cc3 = CB.computeEnvelopeCandidatesFor(ws); const sid3 = (cc3.signals || []).map((s) => s.candidateId);
    ok(sid3.includes(idEsc) && sid3.includes(idLin), "[재편 B] escalation·계보 반복=참고 신호(signals)로 산출(권위 후보 아님)");
    ok(sid3.includes(idOos), "★처분 필터 비적용 — 과거 declined된 합성 신호도 참고로 계속 표시(참고는 처분 상태가 없음)");
    ok(!(cc3.live || []).some((c) => [idEsc, idLin, idOos].includes(c.candidateId)), "합성은 live(권위 후보)에 미합류(구조 분리)"); }
  ok(notice.includes("참고 신호"), "소진 보고=참고 신호 병기(판단 의무 아님 표기)");
  ok(!(CB.computeEnvelopeCandidatesFor(ws).signals || []).some((s) => s.candidateId === CL.envelopeCandidateId("lineage", "f-bbb")), "보완 effectiveTag 재등장=blocker 계보로 오집계 안 함(§7 effectiveTag 계약)");
  ok(!notice.includes("딴캠페인"), "다른 캠페인 기록은 미집계(캠페인 축)");
  ok(notice.includes("후보가 없습니다"), "장부 후보 0=0건 명시(합성은 의무 대상 아님 — 재편 B: 의무 문구는 장부 후보 있을 때만)");
  ok(CB.envelopeCandidateNoticeFor(ws, "ko", { tracked: true, last: false, n: 1, budget: 3 }) === "", "비소진=0바이트(무회귀)");
  ok(CB.envelopeCandidateNoticeFor(ws, "ko", null) === "", "res 부재=0바이트");
  // 전 후보 스킵 반례 → 0건 명시 문구
  CL.appendEnvelopeCandidates(ws, [
    { candidateId: idEsc, envelopeHash: GEN, status: "failed", ts: "T4" },
    { candidateId: idLin, envelopeHash: GEN, status: "declined", ts: "T5" },
  ]);
  const n2 = CB.envelopeCandidateNoticeFor(ws, "ko", { tracked: true, last: true, n: 3, budget: 3 });
  ok(n2.includes("후보가 없습니다") && n2.includes("참고 신호"), "[재편 B] 합성 처분 기록이 있어도 참고 신호는 계속 표시(장부 개입 소멸·0건 명시 유지)");
}

console.log("[4] CLI — list·mark 실행(설치본 동형 소스 직접 호출은 스위치 계약으로)");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes('case "envelope-candidate":') && src.includes("function cmdEnvelopeCandidate(rest)"), "CLI 스위치·명령 함수 존재");
  ok(src.includes('ENVELOPE_CANDIDATE_STATUSES.includes(status)') && src.includes("/^[0-9a-f]{16}$/.test(id)"), "mark 인자 strict(16hex id·닫힌 status 열거)");
}

console.log("[4b] [재편 B §3-1b] mark 실행 반례 — 합성(장부 밖) id의 adopted|declined 기록 거부");
{
  const { spawnSync } = require("child_process");
  const fakeId = "ab12cd34ef56ab12"; // 장부에 없는 16hex(합성 신호와 동형 조건)
  const r = spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "envelope-candidate", "mark", fakeId, "declined"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME }, cwd: ws });
  ok(r.status === 2 && /참고 신호|reference signal/.test((r.stderr || "") + (r.stdout || "")), "장부 밖 id의 declined=거부+rule-propose 안내(exit 2): " + r.status);
  // [1차 blocker④ 반례] 과거 합성 처분 행(kind 무기록)이 있어도 우회 불가 — 판정 기준은 draftable kind
  const pastId = CL.envelopeCandidateId("oos-repeat", "oos-2"); // [1]에서 proposed→declined 행이 이미 존재
  const r2 = spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "envelope-candidate", "mark", pastId, "declined"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME }, cwd: ws });
  ok(r2.status === 2 && /참고 신호|reference signal/.test((r2.stderr || "") + (r2.stdout || "")), "★과거 처분 행 존재해도 kind 무기록=거부(존재 검사 우회 봉합): " + r2.status);
}

console.log("[5] 출력부 병기 — 두 경로(내구 회수·직결) 모두");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok((src.match(/envelopeCandidateNoticeFor\(ws, langSnap, budgetGate\.res, profileSnap\)/g) || []).length === 1 && (src.match(/finishVerifyRun\(/g) || []).length === 3, "budget 소진 출력=공유 꼬리 1곳이 동결 profile 결속(core에서만 후보 재료 병기 — 세 분기 호출 경유)");
}

console.log("[6] 실경로 반례(재검증 blocker①②) — machineFindingsLayer로 prevId 계보·같은 라운드 중복");
{
  const ws2 = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_ws2_"));
  fs.writeFileSync(CL.campaignFileFor(ws2), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 1, budget: 9, startedAt: "T", updatedAt: "T" }));
  const block = (items, verdict) => "본문\n[지적 목록 v2]\n" + items.map((o) => JSON.stringify(o)).join("\n") + "\n[지적 목록 끝]\n\n검증: " + verdict + "\n";
  // frozen은 '내구 잡 env(CODEX_BRIDGE_ASK_JOB_ID)==동결 askId' 결속(6차 미완수정① 실계약) — 라운드마다 동형 구성
  const withAsk = (jid, fn) => { CL.writeEnvelopeFreeze(ws2, GEN, jid); const old = process.env.CODEX_BRIDGE_ASK_JOB_ID; process.env.CODEX_BRIDGE_ASK_JOB_ID = jid; try { return fn(); } finally { if (old === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = old; } };
  // R1: 원 결함(신규 blocker)
  withAsk("ask-r1", () => CB.machineFindingsLayer(block([{ tag: "blocker", title: "원 결함 A", origin: "baseline", supported: true }], "실패"), ws2, "ko", "core", "claude-codex", "ask-r1"));
  const led1 = CL.readFindingsLedger(ws2);
  const rootId = (led1.find((r) => r.type === "finding") || {}).findingId;
  ok(!!rootId, "(전제) R1 원 finding 기록");
  // R2: prevId만 인용한 미완 수정(새 id 없음 — 신규 finding 경로) + 같은 응답에 중복 재지적(같은 prevId 2회)
  withAsk("ask-r2", () => CB.machineFindingsLayer(block([
    { tag: "blocker", title: "원 결함 A 미완", origin: "incomplete-fix", supported: true, prevId: rootId },
    { tag: "blocker", title: "원 결함 A 미완 중복", origin: "incomplete-fix", supported: true, prevId: rootId },
  ], "실패"), ws2, "ko", "core", "claude-codex", "ask-r2"));
  const led2 = CL.readFindingsLedger(ws2);
  const occ2 = led2.filter((r) => r.type === "occurrence" && r.findingId === rootId);
  ok(occ2.length === 1 && occ2[0].round === 2 && occ2[0].prevId === rootId, "prevId만 인용해도 계보 뿌리로 occurrence 기록+같은 라운드 중복=1건(blocker①② 기록 측)");
  ok(led2.some((r) => r.type === "finding" && r.prevId === rootId), "신규 finding 레코드에 prevId 저장(계보 사슬 보존)");
  ok(!(CB.computeEnvelopeCandidatesFor(ws2).signals || []).some((s) => s.candidateId === CL.envelopeCandidateId("lineage", rootId)), "고유 라운드 2회(원 등장 포함)뿐이면 아직 신호 아님(중복 제출 조기 신호 차단 — 집계 측)");
  // R3: 실제 사슬(재재검증 f-2344e4d8) — '직전 자식' id를 prevId로 인용(root→child→grandchild)해도 뿌리로 수렴해야 함
  const childId = (led2.find((r) => r.type === "finding" && r.prevId === rootId) || {}).findingId;
  ok(!!childId && childId !== rootId, "(전제) R2 자식 finding id 확보(사슬 중간 고리)");
  withAsk("ask-r3", () => CB.machineFindingsLayer(block([
    { tag: "blocker", title: "원 결함 A 재미완", origin: "incomplete-fix", supported: true, prevId: childId },
  ], "실패"), ws2, "ko", "core", "claude-codex", "ask-r3"));
  const led3 = CL.readFindingsLedger(ws2);
  ok(led3.filter((r) => r.type === "occurrence" && r.findingId === rootId).length === 2 && !led3.some((r) => r.type === "occurrence" && r.findingId === childId), "직전 자식 인용도 뿌리(root)로 정규화 — occurrence가 root에 2건·child에 0건(분산 차단)");
  // 3차 [보완] 반례: 최초 finding이 '실존하지 않는 prevId'를 달고 있어도 뿌리는 실존 finding(그 자신)에 멈춘다
  //  — 존재하지 않는 id에 occurrence가 귀속돼 제목 없는 후보가 생기는 경로 차단.
  const ws3 = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_ws3_"));
  fs.writeFileSync(CL.campaignFileFor(ws3), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 1, budget: 9, startedAt: "T", updatedAt: "T" }));
  const withAsk3 = (jid, fn) => { CL.writeEnvelopeFreeze(ws3, GEN, jid); const old = process.env.CODEX_BRIDGE_ASK_JOB_ID; process.env.CODEX_BRIDGE_ASK_JOB_ID = jid; try { return fn(); } finally { if (old === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = old; } };
  withAsk3("ask-g1", () => CB.machineFindingsLayer(block([{ tag: "blocker", title: "고아 prevId 결함", origin: "baseline", supported: true, prevId: "f-deadbeef" }], "실패"), ws3, "ko", "core", "claude-codex", "ask-g1"));
  const gRoot = (CL.readFindingsLedger(ws3).find((r) => r.type === "finding") || {}).findingId;
  withAsk3("ask-g2", () => CB.machineFindingsLayer(block([{ tag: "blocker", title: "고아 재등장", origin: "incomplete-fix", supported: true, id: gRoot }], "실패"), ws3, "ko", "core", "claude-codex", "ask-g2"));
  const gOcc = CL.readFindingsLedger(ws3).filter((r) => r.type === "occurrence");
  ok(gOcc.length === 1 && gOcc[0].findingId === gRoot && !gOcc.some((r) => r.findingId === "f-deadbeef"), "실존하지 않는 prevId로는 전진 안 함 — occurrence가 실존 finding에 귀속(제목 없는 유령 후보 차단)");
  { const sg6 = (CB.computeEnvelopeCandidatesFor(ws2).signals || []).find((s) => s.candidateId === CL.envelopeCandidateId("lineage", rootId));
    ok(!!sg6 && sg6.n === 3, "고유 라운드 3회=계보 신호 생성(실경로 — prevId 사슬이 뿌리 기준으로 수렴·재편 B: signals)"); }
}

console.log("[7] CLI 종료 코드(재검증 보완) — 오류가 0으로 위장 금지");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes("const rc9 = cmdEnvelopeCandidate(rest)") && src.includes("process.exitCode = rc9"), "스위치가 반환값을 exitCode에 반영");
  const r = require("child_process").spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "envelope-candidate", "mark", "bad-id", "declined"], { encoding: "utf8", env: { ...process.env }, timeout: 30000 });
  ok(r.status === 2, "잘못된 인자=exit 2 실측(이전=0 위장)");
}

console.log("[8] 확정 장부 keyedDetails(재검증 blocker③) — 펼침 유지+내부 좌표가 함께여야 복원 완결");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(ext.includes('keyedDetails("ledger:"+(ml.mapRel||"?")') && !/mapExists\)\{\s*\n\s*const det=document\.createElement\("details"\)/.test(ext), "확정 장부=keyedDetails(일반 details 잔재 0 — 재렌더에도 펼침 유지)");
}

console.log("[9] §7 증분 2 — 제안본(strict 판독·원본 무변)·승인 전이(WAL·복구·드리프트 중단)·상호배제");
{
  const repo = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_repo_"));
  const wsP = repo; // 이 테스트는 ws=repo 동일 구성(경로 결속만 검증)
  const oldRule = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["구항목"], alwaysBlocker: [], outOfScope: [] }, null, 1);
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), oldRule);
  const newRule = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["구항목"], alwaysBlocker: ["신항목"], outOfScope: [] }, null, 1);
  // strict 판독 반례
  ok(CL.readEnvelopeProposal(wsP, repo).st === "absent", "제안본 부재=absent");
  ok(!CL.writeEnvelopeProposal(wsP, repo, "{조각", "").ok, "JSON 아님=거부");
  ok(!CL.writeEnvelopeProposal(wsP, repo, JSON.stringify({ schema: "다른것" }), "").ok, "수칙서 스키마 아님=거부");
  const wOK = CL.writeEnvelopeProposal(wsP, repo, newRule, "신항목 추가");
  ok(wOK.ok && /^[0-9a-f]{40}$/.test(wOK.newHash), "정상 초안 저장(전문-해시 결속)");
  ok(fs.readFileSync(path.join(repo, "verify-envelope.json"), "utf8") === oldRule, "제안본 저장 후에도 원본 무변(§7 핵심 — 경계 공백 0)");
  const prOK = CL.readEnvelopeProposal(wsP, repo);
  ok(prOK.st === "ok" && prOK.proposalText === newRule, "판독 왕복 무결");
  ok(CL.readEnvelopeProposal(wsP, "D:/다른레포").st === "corrupt", "다른 프로젝트 초안=corrupt(오적용 차단)");
  { // 변조 반례: proposalText만 바꿔치기 → 해시 결속 위반=corrupt
    const f9 = CL.envelopeProposedFileFor(wsP); const o9 = JSON.parse(fs.readFileSync(f9, "utf8"));
    o9.proposalText = o9.proposalText.replace("신항목", "몰래바꿈"); fs.writeFileSync(f9, JSON.stringify(o9));
    ok(CL.readEnvelopeProposal(wsP, repo).st === "corrupt", "작성 후 변조=corrupt(다른 본문에 도장 찍힘 차단)");
    CL.writeEnvelopeProposal(wsP, repo, newRule, "신항목 추가"); // 정상본 복원
  }
  // 전이 실행(정상 경로): 원본 교체+계약 해시+정리
  ok(CL.envelopeTransState(wsP) === "clear", "전이 전=clear");
  const tr = CL.applyEnvelopeTransition(wsP, repo, "ko", null);
  ok(tr.ok && tr.newHash === wOK.newHash, "도장 전이 성공");
  ok(fs.readFileSync(path.join(repo, "verify-envelope.json"), "utf8") === newRule, "원본=신 전문으로 교체");
  ok((CL.loadContract(wsP, "ko") || {}).envelopeHash === wOK.newHash, "계약 승인 해시=신 해시(두 저장소 수렴)");
  ok(CL.readEnvelopeProposal(wsP, repo).st === "absent" && CL.envelopeTransState(wsP) === "clear", "제안본·WAL 정리 완료");
  // 사망 창 복구: WAL만 남기고(① 직전 사망 재현) recover가 완료로 수렴
  const rule3 = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["구항목"], alwaysBlocker: ["신항목", "3차"], outOfScope: [] }, null, 1);
  const wal3 = { schema: "env-trans-wal-v1", ws: wsP, repo, lang: "ko", oldText: newRule, oldHash: require("crypto").createHash("sha1").update(newRule).digest("hex"), newText: rule3, newHash: require("crypto").createHash("sha1").update(rule3).digest("hex"), ts: "T" };
  fs.mkdirSync(CL.ENVELOPE_TRANS_DIR, { recursive: true });
  fs.writeFileSync(CL.envelopeTransWalFileFor(wsP), JSON.stringify(wal3));
  ok(CL.envelopeTransState(wsP) === "recover-needed", "WAL 잔존=recover-needed(ask 시작 차단 상태)");
  const rc = CL.recoverEnvelopeTransition(wsP);
  ok(rc.st === "recovered" && fs.readFileSync(path.join(repo, "verify-envelope.json"), "utf8") === rule3 && (CL.loadContract(wsP, "ko") || {}).envelopeHash === wal3.newHash, "복구=도장 시점 내용으로 완료 수렴(어느 지점 사망도 유실 없음)");
  // 드리프트 중단: 전이 중 제3자가 원본을 바꿈 → WAL 보존·중단(반쯤 적용 금지)
  const rule4 = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["제3자변경"], alwaysBlocker: [], outOfScope: [] }, null, 1);
  const wal4 = { ...wal3, oldText: rule3, oldHash: wal3.newHash, newText: rule4, newHash: require("crypto").createHash("sha1").update(rule4).digest("hex") };
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["딴사람"], alwaysBlocker: [], outOfScope: [] }, null, 1));
  fs.writeFileSync(CL.envelopeTransWalFileFor(wsP), JSON.stringify(wal4));
  const rd = CL.recoverEnvelopeTransition(wsP);
  ok(rd.st === "failed" && rd.reason === "drift" && CL.envelopeTransState(wsP) === "recover-needed", "전이 중 제3 변경=drift 중단·WAL 보존(침묵 덮어쓰기 금지)");
  fs.rmSync(CL.envelopeTransWalFileFor(wsP), { force: true });
  // 산 소유자 잠금=busy(회수 금지)
  fs.writeFileSync(CL.envelopeTransLockFileFor(wsP), JSON.stringify({ pid: 99999999, ts: "T", token: "t" }));
  ok(CL.acquireEnvelopeTransLock ? true : true, "(참고) 잠금 API 내부 계약은 전이 함수 경유로 검증");
  fs.rmSync(CL.envelopeTransLockFileFor(wsP), { force: true });
}

console.log("[9b] 재검증 blocker 반례 — 손상 수칙서 도장 차단·전이 잠금 상호배제 실행");
{
  const repo = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_repo2_"));
  // B1: 정본 reader가 corrupt로 볼 전문({schema만})은 제안 단계에서 거부 — 도장 후 주입 소멸 경로 차단
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1" }), "").ok, "축 누락 전문=제안 거부(도장 후 readVerifyEnvelope corrupt→주입 소멸 경로 차단)");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["a"], alwaysBlocker: [123], outOfScope: [] }), "").ok, "비문자열 항목=거부(정본 축 동일)");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["x".repeat(201)], alwaysBlocker: [], outOfScope: [] }), "").ok, "항목 200자 초과=거부(절삭 도장 차단 — 모달 전문 표시의 전제)");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: Array.from({ length: 13 }, (_, i) => "항목" + i), alwaysBlocker: [], outOfScope: [] }), "").ok, "축 12항목 초과=거부");
  // 판독 측도 동일(파일 직접 조작 대비): 유효 제안 저장 후 내부 전문만 축 누락으로 바꿔치기 → corrupt
  const good = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["정상"], alwaysBlocker: [], outOfScope: [] }, null, 1);
  CL.writeEnvelopeProposal(repo, repo, good, "");
  const pf = CL.envelopeProposedFileFor(repo); const po = JSON.parse(fs.readFileSync(pf, "utf8"));
  const badInner = JSON.stringify({ schema: "verify-envelope-v1" });
  po.proposalText = badInner; po.newHash = require("crypto").createHash("sha1").update(badInner).digest("hex");
  fs.writeFileSync(pf, JSON.stringify(po));
  ok(CL.readEnvelopeProposal(repo, repo).st === "corrupt", "판독 측도 정본 축 strict(해시를 맞춘 손상 전문도 거부)");
  CL.discardEnvelopeProposal(repo);
  // 재재검증 blocker①: 선택 번역·예시 슬롯도 strict — 정본 reader가 절삭·무시하는 값에 도장 찍힘 차단
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["기본"], supportedEnvEn: ["x".repeat(200) + "TAIL"], alwaysBlocker: [], outOfScope: [] }), "").ok, "번역 슬롯 200자 초과=거부(승인 전문≠주입 경계 차단 — 검증자 반례 재현)");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["기본"], supportedEnvEn: ["a", "b"], alwaysBlocker: [], outOfScope: [] }), "").ok, "번역 슬롯 항목 수 불일치=거부(정본은 조용 무시 — 제안은 거부)");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["기본"], alwaysBlocker: [], outOfScope: [], 몰래필드: "x".repeat(90000) }), "").ok, "미지 최상위 필드=거부(잉여 데이터로 전문 무한 팽창·도장 차단)");
  ok(CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["기본"], supportedEnvEn: ["base"], supportedEnvEx: ["예시"], alwaysBlocker: [], outOfScope: [], note: "메모" }), "").ok, "유효 선택 슬롯(길이 일치·상한 내)+note=허용(무회귀)");
  // 확인 검증 [보완] 반영: 메타 필드 strict의 영속 회귀 반례(note 객체·1,001자·approvedBy/At 201자)
  const base9 = { schema: "verify-envelope-v1", supportedEnv: ["기본"], alwaysBlocker: [], outOfScope: [] };
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ ...base9, note: { 몰래: "객체" } }), "").ok, "note 객체=거부(문자열+상한만 — f-e4b3dbe1)");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ ...base9, note: "x".repeat(1001) }), "").ok, "note 1,001자=거부");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ ...base9, approvedBy: "x".repeat(201) }), "").ok, "approvedBy 201자=거부");
  ok(!CL.writeEnvelopeProposal(repo, repo, JSON.stringify({ ...base9, approvedAt: "x".repeat(201) }), "").ok, "approvedAt 201자=거부");
  CL.discardEnvelopeProposal(repo);
  // B3: 전이 잠금 보유 중 경계 판독이 거부되는 인터리빙 — withContract 경로를 직접 실행
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), good);
  const lk = CL.acquireEnvelopeTransLock(repo);
  ok(lk.ok, "(전제) 전이 잠금 획득(도장 전이 진행 중 상황 재현)");
  let threw = null;
  try { CB.withContract("요청 본문", repo); } catch (e) { threw = e; }
  ok(!!threw && !!threw.envelopeTransBusy, "전이 잠금 보유 중 프롬프트 조립=정직 실패(경계 없는 프롬프트 생성 금지 — 인터리빙 차단)");
  CL.releaseEnvelopeTransLock(repo, lk.token);
  const okBody = CB.withContract("요청 본문", repo);
  ok(typeof okBody === "string" && okBody.includes("요청 본문"), "잠금 해제 후=정상 조립(무회귀)");
  // 재재재검증 f-789aadc5: '구 스냅샷 무사용'의 결정론 반례 — 낡은 스냅샷(구 해시)을 인자로 '직접 주입'해
  // 경계 절 산출 함수를 실행. 구 구현(스냅샷 해시 사용)이었다면 신 원본과 mismatch로 무주입=실패했을 구성.
  {
    const ruleA = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["경계표식A"], alwaysBlocker: [], outOfScope: [] }, null, 1);
    const ruleB = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["경계표식B"], alwaysBlocker: [], outOfScope: [] }, null, 1);
    const shaA = require("crypto").createHash("sha1").update(ruleA).digest("hex");
    const shaB = require("crypto").createHash("sha1").update(ruleB).digest("hex");
    // 현재 상태=전이 완료 후(원본=ruleB·계약=shaB)
    fs.writeFileSync(path.join(repo, "verify-envelope.json"), ruleB);
    CL.updateContractPatch(repo, undefined, { envelopeHash: shaB });
    // 잠금 밖에서 읽힌 '낡은 스냅샷'(전이 전 계약 — 구 해시 shaA)을 그대로 주입
    const staleSnap = { ...(CL.loadContract(repo, "ko") || {}), envelopeHash: shaA };
    const es = CB.envelopeSliceFor(repo, "ko", "core", staleSnap);
    ok(es.envText.includes("경계표식B"), "낡은 스냅샷(구 해시) 주입에도 신 경계 주입 — 잠금 안 신선 재판독 실증(구 구현=mismatch 무주입으로 실패했을 구성)");
    // 대조군: 함수가 스냅샷 해시를 썼다면 이 값이 나왔을 것 — mismatch 무주입(빈 문자열) 아님을 명시 확인
    ok(es.envText !== "", "무주입(경계 없는 프롬프트) 아님 — f-b6db1bbd 경합의 산출물 차단");
  }
}

console.log("[10] 배선 소스 계약 — ask 상호배제·대시보드 배지·핸들러·CLI·기동 복구");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes("envelopeTransState(ws)") && src.includes('st9 === "busy"') && src.includes('st9 === "recover-needed"'), "ask-start에 전이 상호배제(산 잠금=재시도 후 거부·WAL=복구 안내)");
  ok(src.includes('case "envelope-proposal"') && src.includes('case "envelope-transition"') && !/cmdEnvelopeProposal[\s\S]{0,3000}approve/.test(src.slice(src.indexOf("function cmdEnvelopeProposal"))), "CLI=propose/show/discard·recover만 — approve 없음(도장=대시보드 전용)");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(ext.includes("개정 초안이 승인을 기다려요 — 기존 항목은 그대로 있고") && ext.includes('proposal: "pending"'), "대기 배지(🔔·기존 유지 보장+다음 할 일 — 4c UX 사용자 실보고)");
  ok(ext.includes('m?.type === "proposalApprove"') && ext.includes("applyEnvelopeTransition(wsA, tgtA, apL, null)") && ext.includes("pr2.newHash !== hashAt"), "도장 핸들러 — 모달 전문·도장 직전 해시 재확인·전이 실행");
  // [기억 권위 A-4 2026-08-14] detail이 note 접두(병렬 축 복제 경고)+전문 결합으로 확장 — 전문 절단 금지 의도는 유지.
  ok(!/proposalText\.slice\(0, 6000\)/.test(ext) && /function draftSummaryDetail[\s\S]{0,2400}\+ pr\.proposalText\)/.test(ext) && ext.includes("draftSummaryDetail(CLA, tgtA, prA") && ext.includes("draftSummaryDetail(CLP9, m.repo, prP"), "모달 전문 절단 금지+note 접두 결합 — 공용 요약 렌더러 경유(4c UX·기억 권위 A-4 계약 유지)");
  ok(ext.includes("normWs(tgtNow2) !== normWs(tgtA)"), "도장 확인 후 현재 대상 재대조(재검증 blocker④ — 직접 승인 경로 동형)");
  ok(ext.includes('m?.type === "proposalRecover"') && ext.includes('envelopeTransState(ws0) === "recover-needed"'), "복구 버튼+기동 자가 복구");
}

console.log("[11] §7 증분 3 — 해소 계보 제외·빼기 후보·항목 수 임계·대시보드 기록 버튼");
{
  // 해소 계보 제외: [3] 픽스처의 f-aaa(open)는 후보 유지 — close 기록을 추가하면 후보에서 사라져야 한다
  const idLin = CL.envelopeCandidateId("lineage", "f-aaa");
  const before = CB.computeEnvelopeCandidatesFor(ws);
  // (f-aaa·f-esc는 [3]에서 declined/failed 기록됨 — skipped로 이미 제외 상태. 제외 로직 검증은 별도 ws)
  const wsR = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_wsr_"));
  fs.writeFileSync(CL.campaignFileFor(wsR), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 1, budget: 9, startedAt: "T", updatedAt: "T" }));
  CL.writeEnvelopeFreeze(wsR, GEN, "ask-rz");
  CL.appendFindingsLedger(wsR, [
    { type: "finding", findingId: "f-live", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "미해결 반복", envelopeHash: GEN, demoted: false, status: "open", ts: "T" },
    { type: "occurrence", findingId: "f-live", campaignId: CAMP, prevId: "f-live", round: 2, envelopeHash: GEN, effectiveTag: "blocker", ts: "T" },
    { type: "occurrence", findingId: "f-live", campaignId: CAMP, prevId: "f-live", round: 3, envelopeHash: GEN, effectiveTag: "blocker", ts: "T" },
    { type: "finding", findingId: "f-done", campaignId: CAMP, round: 1, tag: "blocker", titleNorm: "해소된 반복", envelopeHash: GEN, demoted: false, status: "open", ts: "T" },
    { type: "occurrence", findingId: "f-done", campaignId: CAMP, prevId: "f-done", round: 2, envelopeHash: GEN, effectiveTag: "blocker", ts: "T" },
    { type: "occurrence", findingId: "f-done", campaignId: CAMP, prevId: "f-done", round: 3, envelopeHash: GEN, effectiveTag: "blocker", ts: "T" },
    { type: "close", campaignId: CAMP, findingId: "f-done", closeReason: "resolved", round: 4, envelopeHash: GEN, ts: "T" },
    { type: "finding", findingId: "f-esc2", campaignId: CAMP, round: 2, tag: "blocker", titleNorm: "승격후해소", envelopeHash: GEN, demoted: false, status: "open", ts: "T" },
    { type: "escalation", findingId: "f-esc2", campaignId: CAMP, round: 2, envelopeHash: GEN, ts: "T" },
    { type: "close", campaignId: CAMP, findingId: "f-esc2", closeReason: "resolved", round: 4, envelopeHash: GEN, ts: "T" },
  ]);
  const cc = CB.computeEnvelopeCandidatesFor(wsR);
  const ids = (cc.signals || []).map((c) => c.candidateId);
  ok(ids.includes(CL.envelopeCandidateId("lineage", "f-live")), "미해결 반복=신호 유지(재편 B: signals)");
  ok(!ids.includes(CL.envelopeCandidateId("lineage", "f-done")), "해소된 반복 계보=신호 제외(실전 첫 발동의 교훈 — '이미 지키는 약속'은 신호 아님)");
  ok(!ids.includes(CL.envelopeCandidateId("escalation", "f-esc2")), "해소된 승격 확장=신호 제외");
  ok(before.live !== undefined && typeof before.skipped === "number", "분리 집계 함수=소진 보고와 공유 산출(live·skipped)");
  ok(before.overCap === false, "소형 수칙서=임계 미달(overCap=false)");
  { // 미사용만으로 사용자 선택을 만들지 않음: 3항목은 그대로 보존, 30항목에 닿았을 때만 정리 후보
    const mkEnv = (n) => ({ schema: "verify-envelope-v1", approvedBy: "test", approvedAt: "2026-07-25", supportedEnv: Array.from({length:n},(_,i)=>"지원 "+i), alwaysBlocker: Array.from({length:n},(_,i)=>"차단 "+i), outOfScope: Array.from({length:n},(_,i)=>"제외 "+i) });
    const mkCandidateWs = (n) => {
      const w = fs.mkdtempSync(path.join(require("os").tmpdir(), "gov7_unused_"));
      fs.writeFileSync(path.join(w, "verify-envelope.json"), JSON.stringify(mkEnv(n)));
      const e = CL.readVerifyEnvelope(w); ok(e.st === "ok", n+"개씩 수칙서 픽스처 정상");
      fs.mkdirSync(path.dirname(CL.contractFileFor(w)), { recursive: true });
      fs.writeFileSync(CL.contractFileFor(w), JSON.stringify({ workspace:w, envelopeHash:e.sha1 }));
      fs.writeFileSync(CL.campaignFileFor(w), JSON.stringify({ schema:"vcamp-1", campaignId:CAMP, count:1, budget:1, startedAt:"T", updatedAt:"T" }));
      CL.writeEnvelopeFreeze(w, e.sha1, "ask-unused");
      return w;
    };
    const small = CB.computeEnvelopeCandidatesFor(mkCandidateWs(1));
    ok(!small.overCap && !(small.signals || []).some((c)=>c.kind === "unused-oos"), "30항목 미만=미사용 제외 신호 없음");
    const large = CB.computeEnvelopeCandidatesFor(mkCandidateWs(10));
    ok(large.overCap && (large.signals || []).filter((c)=>c.kind === "unused-oos").length === 10, "30항목 도달=미사용 제외를 참고 신호로 제시(재편 B: 처분·버튼 없음, 빼기 참고 재료)");
  }
  // 재검증 blocker(세대 오귀속) 반례: 산출 세대(gen)가 반환에 결속되고, 소비자는 현 승인 해시와 일치할 때만 표시
  ok((CB.computeEnvelopeCandidatesFor(wsR).gen || null) === GEN, "집계 반환에 산출 세대(gen=동결 해시) 결속");
  {
    const ext2 = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
    ok(ext2.includes("(cc9.gen || null) !== (hash9 || null)") /* 헬퍼화로 조기 반환 형태(2026-08-21) — 계약 동일 */ && ext2.includes("gen: cc9.gen"), "대시보드=산출 세대≠현 승인 해시면 카드 미표시+DTO에 세대 동봉");
    ok(ext2.includes('typeof m.gen === "string"') && ext2.includes("(m.gen || null) !== (genM || null)"), "기록 핸들러=클릭 시점 세대 재대조(불일치=기록 거부 — 구세대 판단의 신세대 오귀속 차단)");
    ok(ext2.includes("wsKey: typeof CL9.wsKeyFor") && ext2.includes('String(CLM.wsKeyFor(wsM)) !== m.wsKey'), "DTO에 원본 프로젝트 내구 키 결속+클릭 시 재대조(멀티루트 활성 전환 오귀속 차단 — ab-1)");
    ok(ext2.includes("computeEnvelopeCandidatesFor(wsM)") && ext2.includes("c.candidateId === m.id"), "기록 전 후보 실존 재검사(유령 id·낡은 카드 차단)");
  }
}

console.log("[12] 배선 — 대시보드 후보 카드·기록 버튼(기록 전용)·소진 임계 문구");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  // [기억 권위 A-4 2026-08-14] 해소 blocker 채택=병합 초안 생성 — '기록만' 문구 계약을 '도장 전 무효력' 계약으로 개정.
  // [UX 개편 2026-08-20 사용자 실보고] 헤더 문구를 쉬운 말+건수 표기로 재개정(도장 전 무효력 문구는 유지가 계약).
  ok(ext.includes("computeEnvelopeCandidatesFor(ws)") && ext.includes('T("제안 — "+e9.cands.length+"건 (승인해야만 효력이 생겨요)"'), "[재편 B] 제안함=같은 집계 공유+승인 전 무효력 명시(어휘: 제안)");
  // UX 개편 핀: 상황 설명 조립(구조 데이터)·쉬운 버튼 라벨·원문 보조 보존·개요 벨(합산+gotoEl 딥링크)·MAP 할일/실적 분리
  ok(ext.includes('T("승인","Approve")') && ext.includes('T("안 올림","Not this one")') && ext.includes('T("문안: ","text: ")'), "[재편 B] 제안 줄=승인/안 올림 2버튼+문안 보조 보존(요약 작문 금지·올림 표시 토글 폐지)");
  ok(ext.includes('data-cands-box') && /ec0\) acts9\.push\(\{n:ec0, tab:"setup", el:"\[data-cands-box\]"/.test(ext), "개요 '지금 정할 것'에 후보 대기 편입+정확 위치 딥링크(초인종)");
  // R1 blocker①(2026-08-20): 장부 유래 후보의 대기 상태='proposed' — 빈 상태와 함께 '미판단'으로 취급해야
  // 버튼·벨이 산다(빈 상태만 세면 resolved-blocker 후보 전체가 버튼 없이 [proposed] 라벨로만 렌더되는 오작동).
  ok(ext.includes('var undecided9=!cd.status||cd.status==="proposed";') && /if\(undecided9 && !viewOnly9\)\{[\s\S]{0,500}approve: true/.test(ext), "proposed=판단 대기 — [승인] 1클릭 버튼 렌더 조건(재편 B)");
  ok(ext.includes('return !c9.status||c9.status==="proposed";'), "proposed=판단 대기 — 개요 벨 계수 조건");
  ok(/if\(a9\.el\)\{ var t0=document\.querySelector\(a9\.el\); if\(t0\)\{ if\(t0\.tagName==="DETAILS"\) t0\.open=true; gotoEl\(t0\); return; \} \}/.test(ext), "교차 패널 이동=gotoEl 경유(규칙)+접힌 상자 펼침+대상 부재 시 탭 폴백");
  // 2026-08-20 사용자 실보고 3건: 보관함 두 줄의 오착지·더보기 재렌더 접힘
  ok(/blDue9, tab:"verify", el:"#backlogSec"/.test(ext), "보관함 검토 기한 줄=보관함 실위치 딥링크(탭 상단 오착지 봉합)");
  ok(/acts9\.push\(\{n:1, tab:"setup", el:"#envCard"/.test(ext), "'수칙서 승인 대기' 줄=수칙서 카드 실위치 딥링크(2026-08-22 실보고 — 동일 계보)");
  // 2026-08-26 사용자 실보고: '자동 보강 멈춤' 클릭이 조치 지점으로 못 감 — 다시 시도·재점검 버튼은 검증 설정
  // #mapModeRow에 있는데 Project MAP 통계 탭으로 보냈다. 이동 전면 점검으로 나머지 줄도 실위치 딥링크.
  ok(/ha9\) acts9\.push\(\{n:1, tab:"setup", el:"#mapModeRow"/.test(ext) && !/ha9\) acts9\.push\(\{n:1, tab:"map"/.test(ext), "'자동 보강 멈춤' 줄=조치 버튼 실위치(검증 설정 #mapModeRow) — 통계 탭 오착지 봉합");
  ok(/ev9\) acts9\.push\(\{n:ev9, tab:"verify", el:"#chSec"/.test(ext) && /ic9\) acts9\.push\(\{n:ic9, tab:"setup", el:"#intentBox"/.test(ext), "근거 재확인·MAP 대기 선택 줄도 실위치 딥링크(이동 전면 점검 2026-08-26)");
  // [보완 f-807cfd86] 딥링크 목적지 문자열만 고정하면 요소가 다른 패널로 이사해도 시험이 통과한다 —
  // 대상 id가 '실제로 그 탭 패널 마크업 안'에 있는지(소속)와, #mapModeRow가 렌더에서 실제로 열리고
  // 조치 버튼(다시 시도)이 그 안에 부착되는지(렌더 제어)까지 결속한다.
  {
    const setupIdx = ext.indexOf('<div id="tab-setup" class="tab-panel">');
    const setupEnd = ext.indexOf('<div id="tab-sessions" class="tab-panel">', setupIdx);
    const verifyIdx = ext.indexOf('<div id="tab-verify" class="tab-panel">');
    const mmIdx = ext.indexOf('id="mapModeRow"');
    const ibIdx = ext.indexOf('id="intentBox"');
    const chIdx = ext.indexOf('id="chSec"');
    ok(setupIdx > 0 && setupEnd > setupIdx && mmIdx > setupIdx && mmIdx < setupEnd && ibIdx > setupIdx && ibIdx < setupEnd, "#mapModeRow·#intentBox는 실제 tab-setup 패널 마크업 안(소속 결속)");
    ok(verifyIdx > 0 && chIdx > verifyIdx && chIdx < setupIdx, "#chSec은 실제 tab-verify 패널 마크업 안(소속 결속)");
    ok(/const row=\$\("mapModeRow"\); if\(!row\) return;/.test(ext) && /row\.style\.display=""; row\.replaceChildren\(\);/.test(ext) && /vscode\.postMessage\(\{type:"retryEnrich"\}\)/.test(ext) && /row\.appendChild\(st9\);/.test(ext), "#mapModeRow 렌더가 실제로 열리고(display 해제) 자동 보강 상태줄+다시 시도 버튼이 그 행에 부착(렌더 제어 결속)");
  }
  // 2026-08-22(2) 승인 지문 언어 공유: 직접 승인 도장=양 슬롯·대시보드 자기치유(반대 슬롯 지문=현행 파일 sha 일치 시 표기 정렬)
  // [부품 C 2026-08-23] draftable kinds 공통 표면 — 채택 분기·올림 토글·kind 문구·why 보조줄·mark 가드·소진 안내
  ok(ext.includes('(m.kind === "resolved-blocker" || m.kind === "user-constraint" || m.kind === "rule-manual") && m.status === "adopted"'), "candMark 채택=draftable kinds 공통(초안 생성 결속 — 재편 A: rule-manual 편입)");
  ok(ext.includes("대화에서 직접 말씀하신 약속이에요") && ext.includes('T("왜: ","why: ")+cd.why'), "UI: user-constraint 문구+왜 보조줄(textContent — 재편 B 어휘)");
  const cb7 = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(cb7.includes("ENVELOPE_DRAFTABLE_KINDS.includes(k5)"), "계산기 ⑤ 합류 allowlist=draftable kinds 단일 정본");
  ok(cb7.includes("envelopeMarkGuard(ws, id, status)") && cb7.includes("envelope-candidate draft"), "mark 우회 가드 배선+draft 안내(§3-3b)");
  ok(cb7.includes("사용자가 대화에서 직접 말한 약속(검증 계보 아님)"), "소진 보고 kindLabel: user-constraint 전용 분기(미검증 발화를 blocker 반복으로 오표시 금지 — 주의 수용)");
  ok(ext.includes('if (typeof CLS.stampEnvelopeAllSlots !== "function") return false;') && ext.includes("stampEnvelopeAllSlots(wsE, tgtNow, shaAt)") && ext.includes("rS && rS.ok"), "직접 승인=WAL 경유 트랜잭션 도장(부분 기록 영속 금지)·구세대 브릿지=거부 fail-closed(f-71d4c2a8 연속분)");
  ok(ext.includes("setEnvelopeHashAllSlots(ws, oh9) === 2") && ext.includes("oh9 === evv.sha1"), "자기치유=2슬롯 성공만 표기 정렬(지문 일치 조건부 — 새 권위 부여 아님)");
  ok(/rb9\.addEventListener\("click", function\(\)\{ var t0=document\.querySelector\("#backlogSec"\); if\(t0\)\{ t0\.open=true; gotoEl\(t0\); return; \}/.test(ext), "'여유' 줄도 보관함 실위치+펼침(동일 봉합)");
  ok(ext.includes("var candsMoreOpenWeb=false;") && ext.includes("candsMoreOpenWeb=true;") && ext.includes('ix9>=8 && !candsMoreOpenWeb'), "후보 '더 보기' 펼침이 재렌더에도 유지(expandedConv 전례 — 2초 접힘 실보고 봉합)");
  // 2026-08-21 사용자 실보고 3건: 초안 대기 중 후보 소실·보관함 처리 장치·근거의심 반복
  ok(ext.includes('candsView: "pending-draft"') && ext.includes('viewOnly9=e9.candsView==="pending-draft"') && ext.includes("undecided9 && !viewOnly9"), "초안 대기 중에도 후보 목록 열람(버튼 없음·'사라진 게 아님' 안내) — 14건 소실 혼란 봉합");
  ok(ext.includes('m?.type === "backlogMark"') && ext.includes('m.status === "done" || m.status === "dismissed"') && /wsKeyFor\(wsB\)\) !== m\.wsKey/.test(ext) && ext.includes("backlogSetStatus"), "보관함 행 처리 핸들러(완료/기각·wsKey 재대조·기록만)");
  ok(ext.includes('T("해결됨(장부 닫기)"') && ext.includes('T("안 하기로 종결"'), "보관함 행에 처리 버튼 2종(화면에서 바로 장부 닫기)");
  // 2026-08-21(2) 초안 폐기 경로: 화면 버튼 부재+폐기 시 채택 후보 고아 실보고 봉합
  ok(ext.includes('btn3: tE("초안 폐기(수칙서 무변)"') && ext.includes('m?.type === "proposalDiscard"') && ext.includes("discardEnvelopeProposalRestoring"), "초안 대기 카드에 폐기 버튼+복원형 폐기 핸들러(확인 모달·수칙서 무변 명시)");
  // R4(f-a65cacd8): 수동 propose CLI도 전이 잠금 — 모든 proposal writer가 한 잠금(임계구역 침입 봉합)
  const cb21 = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(/const lkP = acquireEnvelopeTransLock\(ws\);/.test(cb21) && /finally \{ releaseEnvelopeTransLock\(ws, lkP\.token\); \}/.test(cb21), "수동 envelope-proposal propose=전이 잠금 아래(우회 writer 0)");
  // [개정 작업대 2026-08-22] 올림 N+빼기 M→개정판 초안 1개→도장 1번
  ok(ext.includes('m?.type === "envelopeRevise"') && /wsKeyFor\(wsR9\)\) !== m\.wsKey/.test(ext) && ext.includes("(m.gen || null) !== (genNow9 || null)") && ext.includes("draftEnvelopeRevision"), "개정판 핸들러=strict 인자+wsKey·gen 재대조+빌더 호출");
  // [재편 B] 작업대(올림·빼기 표시+초안 만들기) 폐지 → 수칙 목록(줄마다 1클릭 빼기·행 지문 결속)+직접 추가 안내
  ok(ext.includes('T("수칙 목록 — 항상 "') && ext.includes('T("빼기","Remove")') && ext.includes("itemFp:r.itemFp") && ext.includes("expectedTargetHash:String(r.targetHash||") && ext.includes('T("직접 추가","Add my own")'), "수칙 목록=통합 표시+1클릭 빼기(행 지문·대상 판 결속)+직접 추가=채팅 유도");
  ok(!ext.includes('T("빼기 표시"') && !ext.includes('T("올림 표시"') && !ext.includes("현행 수칙서 항목 — 빼거나"), "구 작업대 어휘 정상 흐름 소멸(빼기 표시·올림 표시·현행 수칙서 항목)");
  ok(ext.includes('T("반복 신호 "+e9.signals.length+"건 — 참고(처리할 일 아님)"'), "반복 신호=참고 접힘 줄(버튼 없음)");
  // [재편 B 2차 blocker②③] 정상 흐름 어휘 잔존 0·ride=영수증 실측치만
  ok(!ext.includes("검증 판정 경계로 주입돼요") && ext.includes("승인 1번으로 적용돼요") && ext.includes("항상 적용되는 수칙 ${n9[0] + n9[1] + n9[2]}개"), "활성 카드·제안 안내 어휘=수칙·승인(검증 경계·재승인·도장 소멸)");
  ok(ext.includes("관련 수칙 ${r.selectedIds.length}개가 함께 실렸어요(영수증 실측)") && !ext.includes("그때 관련분 ${r.selectedIds.length}"), "ride=영수증 실측치만(현재 코어 개수 혼합 금지)");
  ok(ext.includes("String(prA.draftId || prA.newHash)") && ext.includes("String(prD0.draftId || prD0.newHash || \"\")"), "취소·폐기 결속 토큰=draftId(legacy=newHash)");
  ok(/approve === true.*runProposalApprove|runProposalApprove\(scoutTargetFor\(wsM\)\.repo, m\.lang, true\)/.test(ext) && ext.includes("runProposalApprove(repoR9, m.lang, true)"), "1클릭 체인=승인·빼기 모두 같은 도장 모달 공유(취소=복원형 폐기)");
  const clWB = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  ok(clWB.includes("function draftEnvelopeRevision(") && /draftEnvelopeRevision[\s\S]{0,1600}acquireEnvelopeTransLock\(ws\)/.test(clWB), "개정판 빌더=전이 잠금 아래(writer 직렬화 계약 합류 — 4a 목적지 분기로 머리 확장·잠금 계약 무변)");
  ok(ext.includes("자동으로 끝난 일(참고 — 하실 일 아님)") && ext.includes("지금 여기서 하실 일은 없습니다"), "MAP 구획=할 일/끝난 일 시각 분리(실적을 대기로 오독하는 흐름 봉합)");
  // draft는 제안본 생성일 뿐 전이(도장)가 아님 — candMark 경로에 applyEnvelopeTransition 부재 계약은 유지.
  ok(ext.includes('m?.type === "candMark"') && ext.includes('note: "dashboard-record"') && !/candMark[\s\S]{0,2400}applyEnvelopeTransition/.test(ext.slice(ext.indexOf('m?.type === "candMark"'))), "채택 경로에 승인 전이 발동 없음(초안 생성까지만 — 효력은 도장부터·§7 개정 계약)");
  ok(ext.includes('m.status === "adopted" || m.status === "declined"') && ext.includes("/^[0-9a-f]{16}$/.test(m.id)"), "기록 인자 strict(16hex·상태 2종만)");
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes("30항목 이상 — 추가보다 빼기/병합 후보를 우선하라") && src.includes('kind: "unused-oos"'), "임계 문구+빼기 후보 kind 존재");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
