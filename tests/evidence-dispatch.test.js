// 근거 재확인 발송 배선(설계 §3·§4·§5·§9-4 — 증분 4) 실행 반례.
// 동결=경보 시점(flagEvidence 안·세대 고정), 발송=후처리·checkpoint 뒤(maybeDispatchChallenge).
// 가짜 runCodexFn을 주입해 발송→응답 파싱→판정→장부 종결→이벤트 ack 투영·복구 재투영을 검사한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "evdp_home_"));
process.env.CODEX_BRIDGE_HOME = home;
process.env.CODEX_HOME = home;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "evdp_ws_"));

const cl = require("../bridge/contract-lib.js");
const ech = require("../bridge/evidence-challenge.js");
const cb = require("../bridge/codex-bridge.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

// 다양성 본문(적격 통과)
const richText = (n) => { let s = ""; for (let i = 0; s.length < n; i++) s += `const line${i} = fn(${i * 7}, "v${i}", opt${i % 13});\n`; return s.slice(0, n); };
const fA = path.join(ws, "a.js"); fs.writeFileSync(fA, richText(900));
const fB = path.join(ws, "b.js"); fs.writeFileSync(fB, richText(700));

console.log("[0] appendIntegrityEvent — 호출자 id 존중(이벤트-장부 결속 전제)");
{
  cl.appendIntegrityEvent({ id: "ev-fixed-1", ts: new Date().toISOString(), kind: "test-kind", workspace: ws, detail: "x" });
  const ev = cl.readIntegrityEvents().find((e) => e.id === "ev-fixed-1");
  ck("제공 id 그대로 기록", !!ev && ev.ack === false);
  cl.appendIntegrityEvent({ ts: new Date().toISOString(), kind: "test-kind2", workspace: ws, detail: "y" });
  ck("id 미제공=자동 생성(기존 동작)", cl.readIntegrityEvents().some((e) => e.kind === "test-kind2" && e.id));
}

console.log("[1] buildChallengePrompt — CH 형식·구간 좌표·언어 분기");
{
  const rec = ech.freezeChallenge({ eventId: "e1", ws, execCwd: ws, roots: [ws], files: [fA], exposedTexts: [], verifierSession: "vs", mode: "claude-codex", lang: "ko", campaignId: "c", askId: "a" });
  const p1 = ech.buildChallengePrompt(rec, "ko");
  const f = rec.files[0];
  ck("ko 문안+CH 형식+좌표 포함", p1.includes("근거 재확인") && p1.includes("CH <challengeId> <pathId> <base64>") && p1.includes(`${rec.challengeId} ${f.pathId} ${f.path} offset=${f.off} length=${f.len}`));
  ck("en 문안 분기", ech.buildChallengePrompt(rec, "en").includes("evidence recheck"));
}

console.log("[2] convergeStaleChallenges — 수명 지난 pending·dispatched=outcome-unknown");
{
  const mk = (eid, file) => { const r = ech.freezeChallenge({ eventId: eid, ws, execCwd: ws, roots: [ws], files: [file], exposedTexts: [], verifierSession: "vs", mode: "claude-codex", lang: "ko", campaignId: "c", askId: "a" }); ech.writeChallenge(r); return r; };
  const backdate = (id, field) => { const f = ech.challengeFileFor(ws, id); const j = JSON.parse(fs.readFileSync(f, "utf8")); j[field] = new Date(Date.now() - ech.CH_DISPATCH_STALE_MS - 1000).toISOString(); fs.writeFileSync(f, JSON.stringify(j), "utf8"); };
  const oldD = mk("e2", fA); ech.markDispatched(ws, oldD.challengeId); backdate(oldD.challengeId, "dispatchedAt");
  const oldP = mk("e2p", fA); backdate(oldP.challengeId, "createdAt"); // 발송 전 사망·checkpoint 실패 포기 재현
  const fresh = mk("e2f", fB); ech.markDispatched(ws, fresh.challengeId);
  const n = ech.convergeStaleChallenges(ws);
  ck("수명 경과 2건(pending·dispatched)만 수렴", n === 2 && ech.readChallenge(ws, oldD.challengeId).state === "outcome-unknown" && ech.readChallenge(ws, oldP.challengeId).state === "outcome-unknown");
  ck("신선한 dispatched는 불변", ech.readChallenge(ws, fresh.challengeId).state === "dispatched");
  ech.markOutcomeUnknown(ws, fresh.challengeId); // 이후 케이스와 무관하게 정리
}

// 공통 헬퍼: flagEvidence가 하는 일을 그대로 — 이벤트 심기+경보 시점 동결
let evSeq = 0;
function plantAlertAndFreeze(files) {
  const eventId = "ev-ch-" + (++evSeq);
  cl.appendIntegrityEvent({ id: eventId, ts: new Date().toISOString(), kind: "evidence-unseen", workspace: ws, detail: "test", severity: "warning" });
  const rec = ech.freezeChallenge({ eventId, ws, execCwd: ws, roots: [ws], files, exposedTexts: ["원 요청문", "원 답변"], verifierSession: "vs-disp", mode: "claude-codex", lang: "ko", campaignId: "cl:x", askId: "ask-d" });
  if (rec) ech.writeChallenge(rec);
  return { eventId, challengeId: rec ? rec.challengeId : null, rec };
}
const respFromRec = (rec) => (rec.files || []).filter((f) => f.status === "pending")
  .map((f) => `CH ${rec.challengeId} ${f.pathId} ${fs.readFileSync(f.path).slice(f.off, f.off + f.len).toString("base64")}`).join("\n");
const base = { ws, codexSession: "vs-disp", lang: "ko" };

console.log("[3] 발송 e2e — 전부 일치=resolved+이벤트 ack 투영");
{
  const a = plantAlertAndFreeze([fA, fB]);
  let sentPrompt = "";
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: (args, p) => { sentPrompt = p; return { answer: respFromRec(a.rec), status: 0 }; } });
  ck("발송 후 resolved+acked", r.outcome === "resolved" && r.acked === true);
  ck("요청문이 CH 형식·두 파일 좌표 포함", sentPrompt.includes("CH <challengeId> <pathId> <base64>") && sentPrompt.split("\n").filter((l) => l.startsWith("- ")).length === 2);
  const ev = cl.readIntegrityEvents().find((e) => e.id === a.eventId);
  ck("원 이벤트 ack(경보 자동 해소)", ev && ev.ack === true);
  ck("장부 종결=resolved", ech.readChallenge(ws, a.challengeId).state === "resolved");
  ck("같은 challenge 재발송 거부(시도 1)", cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: () => { throw new Error("호출되면 안 됨"); } }).skipped === "not-pending");
}

console.log("[3-1] 동결=경보 시점 세대(§2 A) — 이후 파일이 바뀌어도 원 세대 원문이면 resolved");
{
  const fD = path.join(ws, "d.js"); fs.writeFileSync(fD, richText(850));
  const a = plantAlertAndFreeze([fD]); // 동결(경보 시점 — 원 세대)
  const frozen = a.rec.files[0];
  const originalSpan = fs.readFileSync(fD).slice(frozen.off, frozen.off + frozen.len); // 원 세대 바이트 보관
  fs.writeFileSync(fD, "// 다른 창의 편집으로 통째로 교체된 내용\n" + richText(500)); // 발송 전 파일 변경
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: () => ({ answer: `CH ${a.rec.challengeId} ${frozen.pathId} ${originalSpan.toString("base64")}`, status: 0 }) });
  ck("원 세대 원문 응답=resolved(대조는 동결 스냅샷 기준)", r.outcome === "resolved");
  ck("동결 지문=원 세대 파일(변경 전) 지문", frozen.fileSha !== require("crypto").createHash("sha256").update(fs.readFileSync(fD)).digest("hex"));
}

console.log("[4] 무응답·불일치=failed(태만)·이벤트 유지");
{
  const a = plantAlertAndFreeze([fA]);
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: () => ({ answer: "판정: 통과 같은 무관 텍스트", status: 0 }) });
  ck("응답에 CH 없음=failed·ack 안 함", r.outcome === "failed" && r.acked === false);
  const ev = cl.readIntegrityEvents().find((e) => e.id === a.eventId);
  ck("경보 유지(태만 기록)", ev && ev.ack === false && ech.readChallenge(ws, a.challengeId).state === "failed");
}

console.log("[5] 호출 실패=outcome-unknown(태만 아님)·경보 유지");
{
  const a = plantAlertAndFreeze([fA]);
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: () => ({ error: new Error("spawn fail"), answer: "", status: 1 }) });
  ck("outcome-unknown 수렴", r.outcome === "outcome-unknown");
  ck("장부 상태=outcome-unknown(태만 기록 아님)", ech.readChallenge(ws, a.challengeId).state === "outcome-unknown");
  ck("경보 유지", cl.readIntegrityEvents().find((e) => e.id === a.eventId).ack === false);
}

console.log("[5-1] 복구 재투영(§5 K) — resolved인데 미ack면 다음 진입에서 ack");
{
  const a = plantAlertAndFreeze([fA]);
  // resolved 종결까지는 정상 진행하되 ack 직전에 죽은 상태를 재현: 장부만 resolved로 만들고 이벤트는 미ack
  ech.markDispatched(ws, a.challengeId);
  const judged = ech.judgeChallenge(a.rec, ech.parseChallengeResponse(respFromRec(a.rec), a.rec));
  ech.settleChallenge(ws, a.challengeId, judged);
  ck("전제: 장부 resolved·이벤트 미ack", ech.readChallenge(ws, a.challengeId).state === "resolved" && cl.readIntegrityEvents().find((e) => e.id === a.eventId).ack === false);
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: null }); // 다음 실행 진입(발송 없음)
  ck("진입만으로 재투영 실행", r.skipped === "no-challenge");
  ck("이벤트 ack 수렴(멱등 재투영)", cl.readIntegrityEvents().find((e) => e.id === a.eventId).ack === true);
}

console.log("[6] 발송 안 함 경로 — 루트 밖·부적격 전부면 challenge가 pending이 아님(호출 0회)");
{
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evdp_out_")), "secret.js");
  fs.writeFileSync(outside, richText(300));
  const a = plantAlertAndFreeze([outside]);
  ck("동결 결과=no-dispatch(루트 밖 사유)", a.rec.state === "no-dispatch" && a.rec.files[0].reason === "out-of-root");
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: () => { throw new Error("호출되면 안 됨"); } });
  ck("발송부는 not-pending으로 거부(호출 0회·경보 유지)", r.skipped === "not-pending");
}

console.log("[7] cmdAsk 배선 순서(소스 잠금) — 경보 시점 동결→후처리→outText→checkpoint 게이트→인쇄→발송");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../bridge/codex-bridge.js"), "utf8");
  const iProof = src.indexOf("const proofBind = writeProof(link.codexSession");
  const iCtx = src.indexOf("const chRoots = [exec, ws];");
  const iAlert = src.indexOf("const evAlert = flagEvidence(answer, ws, link.codexSession, exec, {");
  const iVerdict = src.indexOf("flagVerdict(answer, ws, link.codexSession", iAlert);
  const iOut = src.indexOf("const outText =", iVerdict);
  const iGate = src.indexOf("let ckptOk = !durableEnv;", iOut);
  const iPrint = src.indexOf("process.stdout.write(outText)", iGate);
  const iDisp = src.indexOf("maybeDispatchChallenge({ ws, codexSession: link.codexSession", iPrint);
  ck("배선 실재", [iProof, iCtx, iAlert, iVerdict, iOut, iGate, iPrint, iDisp].every((i) => i > 0));
  ck("순서 고정(A·H·§6·G)", iProof < iCtx && iCtx < iAlert && iAlert < iVerdict && iVerdict < iOut && iOut < iGate && iGate < iPrint && iPrint < iDisp);
  ck("발송 조건에 checkpoint 게이트 결속", src.includes("if (evAlert && evAlert.challengeId && ckptOk)"));
  ck("정비(수렴·재투영)는 발송 조건과 무관하게 매 검증 실행", (() => {
    const iMaint = src.indexOf("echM.convergeStaleChallenges(ws); projectResolvedAcks(ws, echM);");
    const iCond = src.indexOf("if (evAlert && evAlert.challengeId && ckptOk)");
    return iMaint > 0 && iCond > 0 && iMaint < iCond; // 조건문 '앞'의 독립 블록
  })());
  ck("루트=동결 스냅샷 값 직접(helper 폴백 재판독 금지)", src.includes("contractSnap.scoutRepo.trim()) chRoots.push(contractSnap.scoutRepo.trim())") && !/const chRoots = \[exec, ws\];[\s\S]{0,300}?resolveScoutRepo\(/.test(src) && !/function maybeDispatchChallenge[\s\S]{0,2600}?loadContract\(/.test(src));
  ck("동결은 이벤트 저장 확인 후(경보 없는 전송 금지)", src.includes("readIntegrityEvents().some((e) => e.id === evId)"));
  ck("발송은 예산 게이트·시도 기록을 안 씀(B — 격리)", !/function maybeDispatchChallenge[\s\S]{0,2600}?(reserveVerifyBudgetGate|beginVerifyAttempt|writeProof\(|machineFindingsLayer|flagVerdict)/.test(src));
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
