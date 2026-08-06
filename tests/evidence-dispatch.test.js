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
  // [VerifierProvider Phase1] 인라인 꼬리 2중 구조 → 공유 꼬리 1곳(finishVerifyRun) — 같은 순서 계약을 단일 지점에서 검사(더 강한 계약).
  const iProof = src.indexOf("const proofBind = writeProof(verifierSession");
  const iCtx = src.indexOf("const chRoots = [exec, ws];");
  const iAlert = src.indexOf("const evAlert = flagEvidence(answer, ws, verifierSession, exec, {");
  const iVerdict = src.indexOf("flagVerdict(answer, ws, verifierSession", iAlert);
  const iOut = src.indexOf("const outText =", iVerdict);
  const iGate = src.indexOf("let ckptOk = !durableEnv;", iOut);
  const iPrint = src.indexOf("process.stdout.write(outText)", iGate);
  const iDisp = src.indexOf("maybeDispatchChallenge({ ws, codexSession: verifierSession", iPrint);
  ck("배선 실재", [iProof, iCtx, iAlert, iVerdict, iOut, iGate, iPrint, iDisp].every((i) => i > 0));
  ck("순서 고정(A·H·§6·G)", iProof < iCtx && iCtx < iAlert && iAlert < iVerdict && iVerdict < iOut && iOut < iGate && iGate < iPrint && iPrint < iDisp);
  ck("발송 조건에 checkpoint 게이트 결속", src.includes("if (evAlert && evAlert.challengeId && ckptOk)"));
  ck("정비(수렴·재투영)는 발송 조건과 무관하게 매 검증 실행", (() => {
    const iMaint = src.indexOf("echM.convergeStaleChallenges(ws); projectResolvedAcks(ws, echM);");
    const iCond = src.indexOf("if (evAlert && evAlert.challengeId && ckptOk)");
    return iMaint > 0 && iCond > 0 && iMaint < iCond; // 조건문 '앞'의 독립 블록
  })());
  ck("루트=동결 스냅샷 값 직접·절대경로만(helper 폴백·상대값 편입 금지)", src.includes("if (chScout && path.isAbsolute(chScout)) chRoots.push(chScout)") && !/const chRoots = \[exec, ws\];[\s\S]{0,400}?resolveScoutRepo\(/.test(src) && !/function maybeDispatchChallenge[\s\S]{0,2600}?loadContract\(/.test(src));
  ck("동결은 이벤트 저장 확인 후(경보 없는 전송 금지)", src.includes("readIntegrityEvents().some((e) => e.id === evId)"));
  ck("발송은 예산 게이트·시도 기록을 안 씀(B — 격리)", !/function maybeDispatchChallenge[\s\S]{0,2600}?(reserveVerifyBudgetGate|beginVerifyAttempt|writeProof\(|machineFindingsLayer|flagVerdict)/.test(src));
  // 2026-08-04 실사고: durableEnv는 {ok, job} 감싸개 — 알맹이를 안 꺼내면 checkpoint가 job.id 부재로
  // 전량 실패해 예약 검증 경로에서 발송이 0건이었다(동결→다음 턴 stale 수렴→outcome-unknown만 누적).
  ck("checkpoint에는 알맹이(durableEnv.job)를 넘긴다(감싸개 금지)", /writePrimaryComplete\([^,]+, durableEnv\.job, outText/.test(src) && !/writePrimaryComplete\([^,]+, durableEnv, outText/.test(src));
  ck("challenge 결속 campaignId도 알맹이에서(감싸개=항상 direct 오염 차단)", src.includes('campaignId: (durableEnv && durableEnv.ok && durableEnv.job.campaignId) || "direct"'));
  // 실행 반례: 감싸개를 넘기면 writePrimaryComplete가 반드시 거부한다(이 계약이 위 배선 규칙의 근거)
  {
    const wrapper = { ok: true, job: { id: "ask-x-1", workspace: "D:/w", implementerTurnId: null, implementerRevision: null } };
    ck("실행 반례 — 감싸개 입력=checkpoint 거부(null)", ech.writePrimaryComplete(os.tmpdir(), wrapper, "본문", { verifierSession: "s", proofFile: "p.json", proofFp: "f" }) === null);
  }
  // 확인 검증 blocker(2026-08-04): --allow-new '첫 세션 생성' 분기에도 같은 배선이 있어야 한다 —
  // 이 분기만 빠져 예약 검증의 첫 회차에서 재확인이 동결·발송되지 않았다. 새 세션 분기 블록을 추출해
  // 문맥 전달→조립→checkpoint→인쇄→발송 순서를 연결 분기와 동형으로 잠근다.
  { // [VerifierProvider Phase1] 세 분기(연결·새 세션·claude)가 배선을 각자 복제하지 않고 공유 꼬리
    // (finishVerifyRun — 위 절이 배선·순서를 잠금) 호출로 지난다. 동형 배선 계약이 '단일 지점'으로 승격.
    const nb = src.indexOf("# 새 Codex 세션 생성·즉시연결");
    const ne = src.indexOf("attempt.record(\"session-unresolved\")", nb);
    const blk = nb > 0 && ne > nb ? src.slice(Math.max(0, nb - 600), ne) : "";
    ck("새 세션 분기 — 공유 꼬리 호출(finishVerifyRun(answer, id, head))", blk.includes("finishVerifyRun(answer, id, head"));
    ck("claude 분기 — 같은 공유 꼬리 호출", /finishVerifyRun\(r9\.answer, vSess/.test(src));
    ck("연결 분기 — 같은 공유 꼬리 호출", src.includes("finishVerifyRun(answer, link.codexSession"));
    ck("배선 중복 소멸 — flagEvidence 호출은 공유 꼬리 1곳뿐", (src.match(/= flagEvidence\(answer, ws, /g) || []).length === 1);
  }
}

console.log("[10] skip 혼합 해소(2026-08-06 실전 재현 봉합) — 즉시 ack·재투영·회수 결속");
{
  // 실전: 인용 파일 대부분이 범위 밖(skipped)이고 1건만 실검증 가능 — 구 술어는 양 경로 모두 ack를 영원히 거부했다.
  const fOut = path.join(home, "outside-roots.js"); fs.writeFileSync(fOut, richText(800));
  const a = plantAlertAndFreeze([fA, fOut]);
  ck("전제 — 범위 밖 파일=skipped 동결", a.rec.files.some((f) => f.status === "skipped") && a.rec.files.some((f) => f.status === "pending"));
  const r = cb.maybeDispatchChallenge({ ...base, challengeId: a.challengeId, runCodexFn: () => ({ answer: respFromRec(a.rec), status: 0 }) });
  const ev = cl.readIntegrityEvents().find((e) => e.id === a.eventId);
  ck("즉시 경로 — skip 혼합+실검증 일치=resolved+ack", r.outcome === "resolved" && r.acked === true && ev && ev.ack === true);

  // 복구 경로: worker가 settle까지 쓰고 ack 전에 죽은 상황 재현 → projectResolvedAcks가 닫는다
  const b = plantAlertAndFreeze([fB, fOut]);
  ech.markDispatched(ws, b.challengeId);
  const rec2 = ech.readChallenge(ws, b.challengeId);
  ech.settleChallenge(ws, b.challengeId, ech.judgeChallenge(rec2, ech.parseChallengeResponse(respFromRec(rec2), rec2)));
  ck("전제 — settle=resolved인데 이벤트는 미ack(ack 유실 창)", ech.readChallenge(ws, b.challengeId).state === "resolved" && cl.readIntegrityEvents().find((e) => e.id === b.eventId).ack === false);
  cb.projectResolvedAcks(ws, ech);
  ck("재투영 — skip 혼합 resolved도 ack(경보 자동 해소)", cl.readIntegrityEvents().find((e) => e.id === b.eventId).ack === true);

  // 회수 결속: 답 회수(ask-wait) 성공 지점에서 stale 수렴+재투영이 돈다 — 세션 마지막 검증이어도
  // '답을 받았는데 경보가 남는' 창이 닫힌다(다음 검증 진입을 기다리지 않음).
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ck("ask-wait 회수 성공 지점 — 수렴+재투영 결속(소스 계약)", /회수 시점 재투영[\s\S]{0,400}convergeStaleChallenges\(wsW\); projectResolvedAcks\(wsW, echW\)/.test(src));
}

console.log("[11] 회수 결속 실행 증명 — 실제 ask-wait CLI가 회수하면서 미ack 이벤트를 닫는다");
{
  const cp = require("child_process");
  const cli = path.join(__dirname, "..", "bridge", "codex-bridge.js");
  const jobDir = path.join(home, "ask-jobs"); fs.mkdirSync(jobDir, { recursive: true });
  const mkDoneJob = (jid, jws) => {
    fs.writeFileSync(path.join(jobDir, jid + ".json"), JSON.stringify({ schema: "ask-job-v1", id: jid, state: "succeeded", workspace: jws, execCwd: jws, timeoutMin: 7, deadlineAt: new Date(Date.now() + 60000).toISOString(), workerPid: null, finishedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(jobDir, jid + ".out"), "검증 답 원문 " + jid + "\n");
  };
  // worker 사망 창 재현: settle=resolved(skip 혼합)까지 기록됐는데 이벤트는 미ack
  const fOut2 = path.join(home, "outside-roots-2.js"); fs.writeFileSync(fOut2, richText(820));
  const c = plantAlertAndFreeze([fA, fOut2]);
  ech.markDispatched(ws, c.challengeId);
  const rc3 = ech.readChallenge(ws, c.challengeId);
  ech.settleChallenge(ws, c.challengeId, ech.judgeChallenge(rc3, ech.parseChallengeResponse(respFromRec(rc3), rc3)));
  ck("전제 — resolved 선기록·이벤트 미ack", ech.readChallenge(ws, c.challengeId).state === "resolved" && cl.readIntegrityEvents().find((e) => e.id === c.eventId).ack === false);
  mkDoneJob("ask-retr-aaaaaaaaaa", ws); // job.workspace=challenge ws — 회수 지점의 작업공간 선택이 이 값을 써야 ack된다
  const w = cp.spawnSync(process.execPath, [cli, "ask-wait", "ask-retr-aaaaaaaaaa"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  ck("실행 — 회수 성공(출력 원문·exit 0)", w.status === 0 && w.stdout.includes("검증 답 원문 ask-retr-aaaaaaaaaa"));
  ck("실행 — 회수 시점 재투영이 미ack 이벤트를 ack(경보 자동 해소)", cl.readIntegrityEvents().find((e) => e.id === c.eventId).ack === true);

  // 격리 증명: 장부 저장소가 오염돼도(워크스페이스 장부 경로가 디렉터리가 아니라 파일) 회수 출력은 보존된다
  const wsBad = path.join(os.tmpdir(), "evdp_bad_ws_" + Date.now());
  const badDir = ech.challengeDirFor(wsBad);
  fs.mkdirSync(path.dirname(badDir), { recursive: true });
  if (!fs.existsSync(badDir)) fs.writeFileSync(badDir, "포이즌 — 디렉터리 자리에 파일");
  mkDoneJob("ask-retr-bbbbbbbbbb", wsBad);
  const w2 = cp.spawnSync(process.execPath, [cli, "ask-wait", "ask-retr-bbbbbbbbbb"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  ck("실행 — 장부 오염에도 회수 출력 보존(best-effort 격리)", w2.status === 0 && w2.stdout.includes("검증 답 원문 ask-retr-bbbbbbbbbb"));
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
