// 근거 재확인 발송 배선(설계 §3·§4·§5·§9-4 — 증분 4) 실행 반례.
// 가짜 runCodexFn을 주입해 발송→응답 파싱→판정→장부 종결→이벤트 ack 투영 전 구간을 검사한다.
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

console.log("[2] convergeStaleChallenges — 수명 지난 dispatched만 outcome-unknown");
{
  const rec = ech.freezeChallenge({ eventId: "e2", ws, execCwd: ws, roots: [ws], files: [fA], exposedTexts: [], verifierSession: "vs", mode: "claude-codex", lang: "ko", campaignId: "c", askId: "a" });
  ech.writeChallenge(rec); ech.markDispatched(ws, rec.challengeId);
  // dispatchedAt를 과거로 조작(수명 경과 재현)
  const file = ech.challengeFileFor(ws, rec.challengeId);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  j.dispatchedAt = new Date(Date.now() - ech.CH_DISPATCH_STALE_MS - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(j), "utf8");
  const rec2 = ech.freezeChallenge({ eventId: "e2b", ws, execCwd: ws, roots: [ws], files: [fB], exposedTexts: [], verifierSession: "vs", mode: "claude-codex", lang: "ko", campaignId: "c", askId: "a" });
  ech.writeChallenge(rec2); ech.markDispatched(ws, rec2.challengeId); // 신선한 dispatched
  const n = ech.convergeStaleChallenges(ws);
  ck("수명 경과 1건만 수렴", n === 1 && ech.readChallenge(ws, rec.challengeId).state === "outcome-unknown");
  ck("신선한 dispatched는 불변", ech.readChallenge(ws, rec2.challengeId).state === "dispatched");
  ech.markOutcomeUnknown(ws, rec2.challengeId); // 이후 케이스와 무관하게 정리
}

// 공통 헬퍼: 경보 이벤트 심기 + alert 재료
let evSeq = 0;
function plantAlert(files) {
  const eventId = "ev-ch-" + (++evSeq);
  cl.appendIntegrityEvent({ id: eventId, ts: new Date().toISOString(), kind: "evidence-unseen", workspace: ws, detail: "test", severity: "warning" });
  return { eventId, unseen: files };
}
const goodResp = (rec) => (rec.files || []).filter((f) => f.status === "pending")
  .map((f) => `CH ${rec.challengeId} ${f.pathId} ${fs.readFileSync(f.path).slice(f.off, f.off + f.len).toString("base64")}`).join("\n");
const findRec = (eventId) => ech.listChallenges(ws).find((r) => r.eventId === eventId);
const base = { ws, exec: ws, codexSession: "vs-disp", promptText: "원 요청문", answer: "원 답변", harnessMode: "claude-codex", lang: "ko", campaignId: "cl:x", askId: "ask-d" };

console.log("[3] 발송 e2e — 전부 일치=resolved+이벤트 ack 투영");
{
  const alert = plantAlert([fA, fB]);
  let sentPrompt = "";
  const r = cb.maybeDispatchChallenge({ ...base, alert, runCodexFn: (args, p) => { sentPrompt = p; return { answer: goodResp(findRec(alert.eventId)), status: 0 }; } });
  ck("발송 후 resolved+acked", r.outcome === "resolved" && r.acked === true);
  ck("요청문이 CH 형식·두 파일 좌표 포함", sentPrompt.includes("CH <challengeId> <pathId> <base64>") && sentPrompt.split("\n").filter((l) => l.startsWith("- ")).length === 2);
  const ev = cl.readIntegrityEvents().find((e) => e.id === alert.eventId);
  ck("원 이벤트 ack(경보 자동 해소)", ev && ev.ack === true);
  ck("장부 종결=resolved", findRec(alert.eventId).state === "resolved");
  ck("같은 이벤트 재발송 거부(1회)", cb.maybeDispatchChallenge({ ...base, alert, runCodexFn: () => { throw new Error("호출되면 안 됨"); } }).skipped === "already");
}

console.log("[4] 무응답·불일치=failed(태만)·이벤트 유지");
{
  const alert = plantAlert([fA]);
  const r = cb.maybeDispatchChallenge({ ...base, alert, runCodexFn: () => ({ answer: "판정: 통과 같은 무관 텍스트", status: 0 }) });
  ck("응답에 CH 없음=failed·ack 안 함", r.outcome === "failed" && r.acked === false);
  const ev = cl.readIntegrityEvents().find((e) => e.id === alert.eventId);
  ck("경보 유지(태만 기록)", ev && ev.ack === false && findRec(alert.eventId).state === "failed");
}

console.log("[5] 호출 실패=outcome-unknown(태만 아님)·경보 유지");
{
  const alert = plantAlert([fA]);
  const r = cb.maybeDispatchChallenge({ ...base, alert, runCodexFn: () => ({ error: new Error("spawn fail"), answer: "", status: 1 }) });
  ck("outcome-unknown 수렴", r.outcome === "outcome-unknown");
  ck("장부 상태=outcome-unknown(태만 기록 아님)", findRec(alert.eventId).state === "outcome-unknown");
  ck("경보 유지", cl.readIntegrityEvents().find((e) => e.id === alert.eventId).ack === false);
}

console.log("[6] 발송 안 함 경로 — 루트 밖·부적격 전부면 no-dispatch");
{
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evdp_out_")), "secret.js");
  fs.writeFileSync(outside, richText(300));
  const alert = plantAlert([outside]);
  const r = cb.maybeDispatchChallenge({ ...base, alert, runCodexFn: () => { throw new Error("호출되면 안 됨"); } });
  ck("루트 밖 파일만=no-dispatch(호출 0회·경보 유지)", r.skipped === "no-dispatch" && findRec(alert.eventId).files[0].reason === "out-of-root");
}

console.log("[7] 파일 변경 감지=indeterminate(태만 아님)");
{
  const fC = path.join(ws, "c.js"); fs.writeFileSync(fC, richText(800));
  const alert = plantAlert([fC]);
  const r = cb.maybeDispatchChallenge({
    ...base, alert,
    runCodexFn: () => { fs.writeFileSync(fC, richText(801) + "변경"); return { answer: "CH 엉뚱 응답 없음", status: 0 }; },
  });
  ck("무응답+파일 변경=indeterminate", r.outcome === "indeterminate" && findRec(alert.eventId).state === "indeterminate");
}

console.log("[8] cmdAsk 배선 순서(소스 잠금) — proof→flags→verdict→outText→checkpoint→인쇄→발송");
{
  const src = fs.readFileSync(path.resolve(__dirname, "../bridge/codex-bridge.js"), "utf8");
  const iProof = src.indexOf("const proofBind = writeProof(link.codexSession");
  const iAlert = src.indexOf("const evAlert = flagEvidence(answer, ws, link.codexSession");
  const iVerdict = src.indexOf("flagVerdict(answer, ws, link.codexSession", iAlert);
  const iOut = src.indexOf("const outText =", iVerdict);
  const iCkpt = src.indexOf("writePrimaryComplete(path.dirname", iOut);
  const iPrint = src.indexOf("process.stdout.write(outText)", iCkpt);
  const iDisp = src.indexOf("maybeDispatchChallenge({ ws, exec", iPrint);
  ck("배선 실재", [iProof, iAlert, iVerdict, iOut, iCkpt, iPrint, iDisp].every((i) => i > 0));
  ck("순서 고정(H·§6·G)", iProof < iAlert && iAlert < iVerdict && iVerdict < iOut && iOut < iCkpt && iCkpt < iPrint && iPrint < iDisp);
  ck("발송은 예산 게이트·시도 기록을 안 씀(B — 격리)", !/function maybeDispatchChallenge[\s\S]{0,2600}?(reserveVerifyBudgetGate|beginVerifyAttempt|writeProof\(|machineFindingsLayer|flagVerdict)/.test(src));
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
