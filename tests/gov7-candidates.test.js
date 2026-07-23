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

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
