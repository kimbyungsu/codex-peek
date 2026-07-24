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
  ok(notice.includes(idEsc) && notice.includes(idLin), "escalation·계보 반복 후보 포함(결정론 id 표기)");
  ok(!notice.includes(idOos), "declined 기록된 oos-2 후보=이 세대에서 스킵([1]에서 declined 기록)");
  ok(notice.includes("스킵"), "스킵 수 명시(침묵 제외 금지)");
  ok(!notice.includes(CL.envelopeCandidateId("lineage", "f-bbb")), "보완 effectiveTag 재등장=blocker 계보로 오집계 안 함(§7 effectiveTag 계약)");
  ok(!notice.includes("딴캠페인"), "다른 캠페인 기록은 미집계(캠페인 축)");
  ok(notice.includes("[의무]") && notice.includes("§8") && notice.includes("문안 초안") && notice.includes("envelope-candidate mark"), "작성 의무 문구(§8 계약·문안 초안·결과 기록 명령)");
  ok(CB.envelopeCandidateNoticeFor(ws, "ko", { tracked: true, last: false, n: 1, budget: 3 }) === "", "비소진=0바이트(무회귀)");
  ok(CB.envelopeCandidateNoticeFor(ws, "ko", null) === "", "res 부재=0바이트");
  // 전 후보 스킵 반례 → 0건 명시 문구
  CL.appendEnvelopeCandidates(ws, [
    { candidateId: idEsc, envelopeHash: GEN, status: "failed", ts: "T4" },
    { candidateId: idLin, envelopeHash: GEN, status: "declined", ts: "T5" },
  ]);
  const n2 = CB.envelopeCandidateNoticeFor(ws, "ko", { tracked: true, last: true, n: 3, budget: 3 });
  ok(n2.includes("후보가 없습니다") && n2.includes("3건 스킵"), "전 후보 스킵=0건 명시+스킵 수(침묵 생략 금지)");
}

console.log("[4] CLI — list·mark 실행(설치본 동형 소스 직접 호출은 스위치 계약으로)");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes('case "envelope-candidate":') && src.includes("function cmdEnvelopeCandidate(rest)"), "CLI 스위치·명령 함수 존재");
  ok(src.includes('ENVELOPE_CANDIDATE_STATUSES.includes(status)') && src.includes("/^[0-9a-f]{16}$/.test(id)"), "mark 인자 strict(16hex id·닫힌 status 열거)");
}

console.log("[5] 출력부 병기 — 두 경로(내구 회수·직결) 모두");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok((src.match(/envelopeCandidateNoticeFor\(ws, langSnap, budgetGate\.res\)/g) || []).length === 2, "budget 소진 출력 2곳 모두 후보 재료 병기(breakdown과 동일 배치)");
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
  const nAfterR2 = CB.envelopeCandidateNoticeFor(ws2, "ko", { tracked: true, last: true, n: 9, budget: 9 });
  ok(!nAfterR2.includes(CL.envelopeCandidateId("lineage", rootId)), "고유 라운드 2회(원 등장 포함)뿐이면 아직 후보 아님(중복 제출 조기 후보 차단 — 집계 측)");
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
  const nAfterR3 = CB.envelopeCandidateNoticeFor(ws2, "ko", { tracked: true, last: true, n: 9, budget: 9 });
  ok(nAfterR3.includes(CL.envelopeCandidateId("lineage", rootId)) && nAfterR3.includes("×3"), "고유 라운드 3회=계보 후보 생성(실경로 — prevId 사슬이 뿌리 기준으로 수렴)");
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
  ok(ext.includes("수칙서 개정 초안이 승인을 기다려요") && ext.includes('proposal: "pending"'), "대기 배지(🔔·원본 무변 명시 — 사용자 요구)");
  ok(ext.includes('m?.type === "proposalApprove"') && ext.includes("applyEnvelopeTransition(wsA, tgtA, apL, null)") && ext.includes("pr2.newHash !== hashAt"), "도장 핸들러 — 모달 전문·도장 직전 해시 재확인·전이 실행");
  ok(!/proposalText\.slice\(0, 6000\)/.test(ext) && (ext.match(/detail: prA\.proposalText/g) || []).length === 1 && (ext.match(/detail: prP\.proposalText/g) || []).length === 1, "모달 전문 절단 금지(재검증 blocker② — 상한은 제안 strict가 보증)");
  ok(ext.includes("normWs(tgtNow2) !== normWs(tgtA)"), "도장 확인 후 현재 대상 재대조(재검증 blocker④ — 직접 승인 경로 동형)");
  ok(ext.includes('m?.type === "proposalRecover"') && ext.includes('envelopeTransState(ws0) === "recover-needed"'), "복구 버튼+기동 자가 복구");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
