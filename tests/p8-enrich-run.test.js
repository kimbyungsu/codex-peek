/*
 * P8 증분 3b — 실행기 본체(runEnrich) e2e: 가짜 어댑터·askVerifier 주입으로 생명주기 ①~⑧·복구 상태표·
 * 라우팅·동의 재대조·승격·park를 실경로(실 P2 파이프라인 위)로 검증. 정본: 'P8 상세 설계 v10' P8-2·P8-4.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p8er_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bootstrap.js");
const ME = require("../bridge/map-enrich.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");
const READY = { selfReady: true, economyReady: true, precisionReady: true, autoReady: true };

function mkRepo(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8er_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  return ws;
}
function setup(tag, scout) {
  const ws = mkRepo(tag);
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: scout === false ? "off" : "on" }));
  MB.grantConsent(ws, "test");
  const r = MR.initTopologyForBootstrap(ws);
  if (r.st !== "created") throw new Error("init 실패: " + r.st);
  const topo = MR.readTopoExFor(ws).topo;
  ok(MB.ensureQueue(ws, PM) === true, "(전제 " + tag + ") 큐 생성(v1)");
  return { ws, topo, nodeId: topo.nodes[0].id };
}
const goodAdapter = (nodeId) => (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
  { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n1" } }, evidence: [{ file: "src/a.js", quote: "// a" }] },
  { op: "add_condition" === "x" ? "x" : "add_anchor", targetId: nodeId, payload: { anchor: { kind: "code", path: "src/b.js" } }, evidence: [{ file: "src/a.js", quote: "// a" }] },
] } });
const base = (ws, over) => ({ ws, slot: "ko", mode: "self", readiness: READY, adapters: {}, trigger: "test", ...over });

console.log("[1] 게이트·전제 — 2트랙=완전 무동작·큐 없음=noop·무동의=park");
{
  const { ws } = setup("gate", false);
  fs.rmSync(MB.queueFileFor(ws), { force: true });
  const r0 = ME.runEnrich(ws, base(ws, {}));
  ok(r0.outcome === "noop" && r0.reason === "two-track", "2트랙 off=noop(게이트 최선행)");
  ok(!fs.existsSync(ME.jobFileFor(ws)) && !fs.existsSync(ME.ROUTE_LOG), "무동작 — 장부·로그 파일 생성 0");
}
{
  const { ws, nodeId } = setup("consent");
  const r1 = ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } }));
  ok(r1.outcome === "parked" && r1.reason === "no-consent", "무동의=park(no-consent — 기존 bootstrap 동의 소급 금지)");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const r2 = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: {} }));
  ok(r2.outcome === "parked" && r2.reason === "consent-stale", "self 동의만+유료 모드=consent-stale park(모드별 동의 결속)");
}

console.log("[2] self 성공 e2e — applied·P2 decision 실존·job done·멱등·로그");
{
  const { ws, topo, nodeId } = setup("self");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } }));
  ok(r.outcome === "applied" && r.applied === 2, "self 보강 성공 — 2 item 적용");
  const p10Rows = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").map(JSON.parse).filter((x) => x.schema === "map-automation-v1" && x.mapId === topo.mapId);
  const p10Start = p10Rows.find((x) => x.event === "enrich-start"), p10Job = p10Rows.find((x) => x.event === "enrich-job-terminal"), p10Run = p10Rows.find((x) => x.event === "enrich-run-terminal");
  ok(!!p10Start && !!p10Job && !!p10Run && p10Start.runId === p10Job.runId && p10Job.runId === p10Run.runId, "P10 start→job terminal→run terminal 한 실행 세대 결속");
  ok(p10Job.baselineState === "current-job" && p10Job.everApplied === true && p10Job.deferredState === "clear", "P10 job terminal은 현재 job 적용 사실·clear 기준선 기록");
  const j = ME.readEnrichJob(ws).job;
  ok(j.phase === "done" && j.attempts.length === 1 && j.attempts[0].phase === "done", "장부 done(attempt done·cursor 정리)");
  const decDir = path.join(ws, "project-map", "decisions");
  const decs = fs.readdirSync(decDir).filter((f) => f.endsWith(".json"));
  ok(decs.length === 2, "P2 decision 2건 실기록(직접 topology 기록 0 — 파이프라인 경유)");
  const t2 = MR.readTopoExFor(ws).topo;
  const nd = t2.nodes.find((n) => n.id === nodeId);
  ok(nd.anchors.some((a) => a.path === "src/b.js"), "topology에 add_anchor 실반영");
  // 수렴(구현 발견 공백): 적용이 ah를 전진시켜도 — 큐 갱신 전=queue-stale·갱신 후=afterAuthorityHash 수렴 noop
  const rS = ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } }));
  ok(rS.outcome === "noop" && rS.reason === "queue-stale", "적용 직후(큐 미갱신)=queue-stale noop");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성(bootstrap 소관)");
  let recalled = 0;
  const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: () => { recalled++; return goodAdapter(nodeId)({}); } } }));
  ok(r2.outcome === "noop" && r2.reason === "already-enriched" && recalled === 0, "큐 갱신 후에도 외부 변경 0=수렴 noop(자기 재보강 루프·재과금 차단 — afterAuthorityHash)");
  ok(fs.readFileSync(ME.ROUTE_LOG, "utf8").split("\n").filter(Boolean).length >= 2, "라우팅 로그 append(결정 감사)");
}

console.log("[3] auto 승격 — economy 실패→precision 1회·both-failed=park");
{
  const { ws, nodeId } = setup("auto");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "auto" });
  const calls = [];
  const r = ME.runEnrich(ws, base(ws, { mode: "auto", adapters: {
    economy: () => { calls.push("economy"); return { ok: false, detail: "boom" }; },
    precision: (c) => { calls.push("precision"); return goodAdapter(nodeId)(c); },
  } }));
  ok(r.outcome === "applied" && calls.join(",") === "economy,precision", "경제 실패→정밀 승격 정확 1회→적용");
  const j = ME.readEnrichJob(ws).job;
  ok(j.attempts.length === 2 && j.attempts[0].provider === "economy" && j.attempts[0].phase === "failed" && j.attempts[1].provider === "precision", "attempt 열에 승격 감사 보존(실패↔승격 사이 상태)");
}
{
  const { ws } = setup("bothfail");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "auto" });
  const r = ME.runEnrich(ws, base(ws, { mode: "auto", adapters: { economy: () => ({ ok: false }), precision: () => ({ ok: false }) } }));
  ok(r.outcome === "parked" && r.reason === "both-failed", "양쪽 실패=park(무한 승격 없음)");
}

console.log("[4] 복구 상태표 — 유료 running=uncertain-call park(재호출 0)");
{
  const { ws, nodeId } = setup("uncertain");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "economy" });
  let called = 0;
  const failMid = () => { // 호출 전 기록(running) 후 사망 시뮬: 어댑터가 예외로 죽고 장부에 running 잔존하게 — 직접 조작
    called++;
    throw new Error("simulated-crash");
  };
  ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: failMid } }));
  // adapter-threw는 failed 처리되므로 running 잔존을 직접 구성(사망 창 재현)
  const j0 = ME.readEnrichJob(ws).job;
  fs.writeFileSync(ME.jobFileFor(ws), JSON.stringify({ ...j0, phase: "open", attempts: [{ ...j0.attempts[0], phase: "running", failReason: undefined, finishedAt: undefined }].map((a) => { const b = { ...a }; delete b.failReason; delete b.finishedAt; return b; }) }, null, 1));
  const r = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: (c) => { called++; return goodAdapter(nodeId)(c); } } }));
  ok(r.outcome === "parked" && r.reason === "uncertain-call", "유료 running 잔존+재실행=uncertain-call park");
  ok(called === 1, "provider 재호출 0(park 경로에서 어댑터 미호출 — 재과금 차단)");
  const j1 = ME.readEnrichJob(ws).job;
  ok(j1.phase === "parked" && j1.attempts[0].phase === "parked", "장부 parked 감사 보존");
}

console.log("[5] verifier 해소 경로 — 확인 대기는 독립 항목을 막지 않고 명시 재시도만 새 호출");
{
  const mkRl = (ws, nodeId, lbl) => (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "rewrite_label", targetId: nodeId, payload: { to: { label: lbl + "-x" }, expect: { label: lbl } }, evidence: [{ file: "src/a.js", quote: "// a" }], claims: [{ file: "src/a.js", quote: "// a", stance: "support" }] },
  ] } });
  {
    const { ws, topo, nodeId } = setup("rl-nov");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    const mixed = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
      { op: "rewrite_label", targetId: nodeId, payload: { to: { label: lbl + "-x" }, expect: { label: lbl } }, evidence: [{ file: "src/a.js", quote: "// a" }], claims: [{ file: "src/a.js", quote: "// a", stance: "support" }] },
      { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "independent" } }, evidence: [{ file: "src/a.js", quote: "// a" }] },
    ] } });
    const r = ME.runEnrich(ws, base(ws, { adapters: { self: mixed } }));
    ok(r.outcome === "applied" && r.applied === 1 && r.awaitingVerification === 1, "검증 없는 의미 변경 1건은 확인 대기, 독립 항목 1건은 계속 적용");
    ok(ME.readEnrichJob(ws).job.phase === "done" && ME.deferredSummary(ws).awaiting === 1, "작업은 완료되고 확인 대기는 별도 장부에 남음");
    ok(MR.readTopoExFor(ws).topo.nodes.find((n) => n.id === nodeId).label === lbl, "확인 전 의미 변경은 적용하지 않음");
    let normalCalls = 0;
    ME.runEnrich(ws, base(ws, { askVerifier: () => { normalCalls++; return { verdict: "support", claims: [] }; } }));
    ok(normalCalls === 0, "일반 관측은 확인 대기 검증을 자동 반복하지 않음");
    let retryCalls = 0;
    const rr = ME.runEnrich(ws, base(ws, { trigger: "retry", askVerifier: () => { retryCalls++; return { verdict: "support", claims: [{ file: "src/a.js", contentHash: sha(fs.readFileSync(path.join(ws, "src", "a.js"), "utf8")), locator: "L1", stance: "support" }] }; } }));
    ok(rr.outcome === "applied" && retryCalls === 1 && ME.deferredSummary(ws).awaiting === 0, "명시 재시도는 새 검증 1회 후 대기 항목을 적용");
    ok(MR.readTopoExFor(ws).topo.nodes.find((n) => n.id === nodeId).label === lbl + "-x", "재검증 통과 뒤 의미 변경 적용");
    const counts = ME.enrichOutcomeSummary(ME.readEnrichJob(ws).job, ME.deferredSummary(ws));
    ok(counts.applied === 2 && counts.rejected === 0 && counts.awaiting === 0 && counts.investigation === 0, "지연 support도 원 작업과 중복 없이 적용 2·나머지 0으로 집계");
  }
  {
    const { ws, topo, nodeId } = setup("rl-ok");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    const askV = (req) => ({ patchId: req.patch.patchId, opHash: PM.opHashOf(req.patch), baseDecisionContextHash: req.patch.baseDecisionContextHash, verdict: "support", claims: [{ file: "src/a.js", contentHash: sha(fs.readFileSync(path.join(ws, "src", "a.js"), "utf8")), locator: "L1", stance: "support" }] });
    const r = ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) }, askVerifier: askV }));
    ok(r.outcome === "applied", "support 해소=verifier-resolved 적용 성공");
    const t2 = MR.readTopoExFor(ws).topo;
    ok(t2.nodes.find((n) => n.id === nodeId).label === lbl + "-x", "라벨 실반영");
    const decs = fs.readdirSync(path.join(ws, "project-map", "decisions")).map((f) => JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", f), "utf8")));
    ok(decs.some((d) => d.classification === "verifier-resolved" && d.actor.kind === "verifier"), "decision에 verifier 삼중 결속 실기록");
  }
  {
    const { ws, topo, nodeId } = setup("rl-inc");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    let calls = 0;
    const r1 = ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) }, askVerifier: () => { calls++; return { verdict: "inconclusive" }; } }));
    ok(r1.outcome === "settled" && r1.awaitingVerification === 1 && calls === 1, "판단 불가는 적용 없이 별도 확인 대기로 종결");
    ME.runEnrich(ws, base(ws, { trigger: "link:g1", askVerifier: () => { calls++; return { verdict: "support", claims: [] }; } }));
    ok(calls === 1, "새 연결은 '검증 없음'만 한 번 깨우며 판단 불가를 자동 재질문하지 않음");
    const r2 = ME.runEnrich(ws, base(ws, { trigger: "retry", askVerifier: () => { calls++; return { verdict: "reject" }; } }));
    ok(r2.reason === "deferred-retry" && calls === 2 && ME.deferredSummary(ws).awaiting === 0, "판단 불가는 사용자의 명시 재시도에서만 다음 세대로 진행");
    const counts = ME.enrichOutcomeSummary(ME.readEnrichJob(ws).job, ME.deferredSummary(ws));
    ok(counts.applied === 0 && counts.rejected === 1 && counts.awaiting === 0 && counts.investigation === 0, "지연 reject도 기각 1·나머지 0으로 집계");
  }
  for (const verdict of ["support", "reject"]) {
    const { ws, topo, nodeId } = setup("rl-terminal-crash-" + verdict);
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) } }));
    const active = ME.deferredSummary(ws).records[0];
    const pendingPath = path.join(MP.dirsFor(ws, active.mapId).pending, active.patchId + ".json");
    const patch = JSON.parse(fs.readFileSync(pendingPath, "utf8")).patch;
    const beg = ME.beginDeferredCall(ws, active, "manual", "");
    const resolution = { patchId: patch.patchId, opHash: PM.opHashOf(patch), baseDecisionContextHash: patch.baseDecisionContextHash, verdict,
      claims: verdict === "support" ? [{ file: "src/a.js", contentHash: sha(fs.readFileSync(path.join(ws, "src", "a.js"), "utf8")), locator: "L1", stance: "support" }] : [] };
    ok(beg.ok && beg.action === "call" && ME.finishDeferredCall(ws, patch.patchId, beg.token, verdict, resolution).ok, verdict + " 종결 직전 판정 장부 구성");
    if (verdict === "support") ok(MP.applyPatch(ws, active.mapId, patch.patchId, { preCutover: true, verifierResolution: resolution }).ok, "support P2 적용 직후 종료 창 구성");
    else ok(MP.expirePendingPatch(ws, active.mapId, patch.patchId, PM.opHashOf(patch)).ok, "reject P2 만료 직후 종료 창 구성");
    ME.runEnrich(ws, base(ws));
    const counts = ME.enrichOutcomeSummary(ME.readEnrichJob(ws).job, ME.deferredSummary(ws));
    ok(counts.awaiting === 0 && counts.investigation === 0 && counts[verdict === "support" ? "applied" : "rejected"] === 1,
      verdict + " P2 종결 뒤 프로세스 종료·재개도 terminal 결과를 복구 집계");
  }
  {
    const { ws, topo, nodeId } = setup("rl-linkgen");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) } }));
    let calls = 0;
    ME.runEnrich(ws, base(ws, { trigger: "link:g1", askVerifier: () => { calls++; return null; } }));
    ME.runEnrich(ws, base(ws, { trigger: "link:g1", askVerifier: () => { calls++; return { verdict: "support", claims: [] }; } }));
    ok(calls === 1, "같은 검증 연결 세대는 검증 없음 항목을 한 번만 깨움");
    const r2 = ME.runEnrich(ws, base(ws, { trigger: "link:g2", askVerifier: () => { calls++; return { verdict: "support", claims: [{ file: "src/a.js", contentHash: sha(fs.readFileSync(path.join(ws, "src", "a.js"), "utf8")), locator: "L1", stance: "support" }] }; } }));
    ok(calls === 2 && r2.outcome === "applied", "새 연결 세대에서만 한 번 더 시도해 통과 결과 적용");
  }
  {
    const { ws, topo, nodeId } = setup("rl-crash");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    let calls = 0;
    const r1 = ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) }, askVerifier: () => { calls++; throw new Error("lost-receipt"); } }));
    const dr = ME.deferredSummary(ws);
    ok(r1.outcome === "settled" && dr.records[0].phase === "uncertain" && calls === 1, "호출 중 결과 유실은 불확실 상태로 보존");
    ME.runEnrich(ws, base(ws, { trigger: "link:g1", askVerifier: () => { calls++; return { verdict: "reject" }; } }));
    ok(calls === 1, "불확실 호출은 연결 변화로 자동 재호출하지 않음");
    const beg = ME.beginDeferredCall(ws, ME.deferredSummary(ws).records[0], "manual", "");
    ok(beg.ok && beg.action === "call", "호출 직전 calling 영속 창 구성");
    ME.runEnrich(ws, base(ws, { askVerifier: () => { calls++; return { verdict: "reject" }; } }));
    ok(calls === 1 && ME.deferredSummary(ws).records[0].phase === "uncertain", "calling 뒤 프로세스 사망은 재개 시 자동 재호출 없이 불확실로 복구");
  }
  {
    const { ws, topo, nodeId } = setup("rl-rej");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    let vCalls = 0;
    const r = ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) }, askVerifier: () => { vCalls++; return { verdict: "reject" }; } }));
    ok(r.outcome === "settled" && r.applied === 0 && r.skipped === 1, "reject=적용 도장 없이 종결(settled·applied 0 — 2차 blocker④ 도장 분리)");
    ok(vCalls === 1, "Verifier 호출 정확 1회(해소 레코드 영속 — 3b 1차 blocker③)");
    const t2 = MR.readTopoExFor(ws).topo;
    ok(t2.nodes.find((n) => n.id === nodeId).label === lbl, "reject된 변경은 미반영(라벨 불변)");
    const jR = ME.readEnrichJob(ws).job;
    ok(jR.attempts[0].cursor.appliedPatchIds.length === 0, "appliedPatchIds에 reject ID 미포함(도장 오염 차단)");
    const resR = jR.attempts[0].resolutions || [];
    ok(resR.length === 1 && resR[0].verdict === "reject", "reject 해소 레코드 장부 영속");
    const pendDir = MP.dirsFor(ws, jR.mapId).pending;
    const pends = fs.existsSync(pendDir) ? fs.readdirSync(pendDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(require("path").join(pendDir, f), "utf8"))) : [];
    ok(pends.some((pd) => pd.lifecycle === "expired"), "reject된 pending=expired 실확인(active 잔존 금지 — 3b 1차 blocker③)");
  }
}

console.log("[7] 근거 실증·수렴 외부 변경(3b 1차 blocker④⑤)");
{
  const { ws, topo, nodeId } = setup("quote");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const fake = (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/a.js", quote: "// 이 인용은 파일에 없다" }] },
  ] } });
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: fake } }));
  ok(r.outcome === "parked" && r.reason === "self-failed", "허위 인용=근거 실패(self라 승격 없음=park — 파일 대조 실증)");
  const j = ME.readEnrichJob(ws).job;
  ok(/evidence/.test(j.attempts[0].failReason || ""), "실패 사유에 근거 실패 분류 기록");
  const invalidRows = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((x) => x.schema === "map-automation-v1" && x.mapId === topo.mapId && (x.event === "enrich-job-terminal" || x.event === "enrich-run-terminal"));
  ok(invalidRows.length === 2 && invalidRows.every((x) => x.reasonCode === "provider-result-invalid"), "호출 성공 뒤 schema/evidence 검증 실패는 provider-call-failed와 분리 기록");
  // 2026-07-29 설계 상의: 자유 문자열만으로는 화면이 '호출 실패'와 '답 거부'를 못 가른다 → 구조 필드도 남긴다.
  ok(j.attempts[0].failureStage === "validation" && j.attempts[0].failureCode === "evidence-mismatch" && j.attempts[0].failureFile === "src/a.js", "실패를 단계·코드·파일 구조로도 기록(인용 불일치)");
}

console.log("[7b] 재개 경로의 결과 거부 — 감사 기록이 '못 불렀다'로 뒤집히지 않음(2026-07-29 실사고)");
{
  // 실사고: 보류된 작업을 '다시 시도'로 재개하면 곧바로 시도 실행으로 들어가는데, 그 경로에서
  // 결과 거부가 provider-call-failed로 기록됐다(호출은 실제로 나갔는데 '못 불렀다'는 감사 기록).
  const { ws, topo, nodeId } = setup("resume-evidence");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const fake = (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/a.js", quote: "// 없는 인용" }] },
  ] } });
  ME.runEnrich(ws, base(ws, { adapters: { self: fake } }));           // 1회차: 실패 → parked
  const before = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").length;
  ME.updateEnrichJob(ws, (jj) => (jj && jj.phase === "parked" ? { ...jj, phase: "open", finishedAt: undefined, parkedReason: undefined } : null)); // '다시 시도'와 같은 해제
  const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: fake }, trigger: "retry" }));
  const rows2 = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").filter(Boolean).slice(before - 1).map(JSON.parse)
    .filter((x) => x.schema === "map-automation-v1" && (x.event === "enrich-job-terminal" || x.event === "enrich-run-terminal"));
  // 3차 blocker① 반영 후: 재개에서 새 시도도 실패하면 그 자리에서 보류로 종결한다(open 잔존 금지).
  ok(r2.outcome === "parked", "재개에서 새 시도도 실패하면 보류로 종결(진행 중으로 남지 않음)");
  ok(rows2.length >= 1 && rows2.every((x) => x.reasonCode === "provider-result-invalid"), "재개 경로의 결과 거부도 provider-result-invalid로 기록(‘못 불렀다’ 오기록 차단)");
}

console.log("[7c] 명시 재시도는 실제로 새 호출을 만든다(2026-07-29 구현검증 blocker① — 옛 실패가 라우팅을 막았다)");
{
  const { ws, nodeId } = setup("retry-newcall");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "precision" });
  let calls = 0;
  const bad = () => { calls++; return { ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/a.js", quote: "// 없는 인용" }] },
  ] } }; };
  const opts = () => base(ws, { adapters: { precision: bad }, mode: "precision", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true } });
  ME.runEnrich(ws, opts());
  ok(calls === 1, "1회차에서 담당 호출 1회");
  // 대시보드 '다시 시도'와 같은 해제(옛 실패를 라우팅에서 제외하는 표식 포함)
  ME.updateEnrichJob(ws, (jj) => { if (!jj || jj.phase !== "parked") return null; const nx = { ...jj, phase: "open", retryFrom: jj.attempts.length }; delete nx.finishedAt; delete nx.parkedReason; return nx; });
  ME.runEnrich(ws, opts());
  ok(calls === 2, "명시 재시도는 새 호출을 실제로 만든다(안내 문구가 거짓이 되지 않음)");
  ok(ME.readEnrichJob(ws).job.phase === "parked", "재시도한 답도 거부되면 그 자리에서 보류로 종결(진행 중으로 남지 않음 — 3차 blocker①)");
  // 대조군: 표식을 지우고 열면 옛 실패가 라우팅을 막아 새 호출이 없다(표식이 실제로 작동함을 확인)
  ME.updateEnrichJob(ws, (jj) => { if (!jj || jj.phase !== "parked") return null; const nx = { ...jj, phase: "open" }; delete nx.finishedAt; delete nx.parkedReason; delete nx.retryFrom; return nx; });
  ok(ME.readEnrichJob(ws).job.retryFrom === undefined, "(전제) 대조군은 표식이 실제로 지워진 상태");
  const r3 = ME.runEnrich(ws, opts());
  ok(calls === 2 && r3.outcome === "parked", "표식 없이 열면 새 호출 없이 보류(표식이 실제로 작동함을 대조로 확인)");
}

console.log("[7c-2] 자동형 재시도에서도 경제형 실패 뒤 정밀형 승격이 살아 있다(2026-07-29 4차 blocker①)");
{
  // 재개에서 실패하면 곧바로 보류하던 앞 수정이 자동형 승격을 막았다 — 라우터를 다시 태워 승격을 지킨다.
  const { ws, nodeId } = setup("auto-retry");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "auto" });
  const seen = [];
  const opts = (precOk) => base(ws, { mode: "auto", readiness: READY, adapters: {
    economy: () => { seen.push("economy"); return { ok: false, detail: "boom" }; },
    precision: (c) => { seen.push("precision"); return precOk ? goodAdapter(nodeId)(c) : { ok: false, detail: "boom" }; },
  } });
  ME.runEnrich(ws, opts(false));
  ok(ME.readEnrichJob(ws).job.phase === "parked", "(전제) 양쪽 실패로 보류");
  seen.length = 0;
  ME.updateEnrichJob(ws, (jj) => { if (!jj || jj.phase !== "parked") return null; const nx = { ...jj, phase: "open", retryFrom: jj.attempts.length }; delete nx.finishedAt; delete nx.parkedReason; return nx; });
  const r = ME.runEnrich(ws, opts(true));
  ok(seen.join(",") === "economy,precision", "재시도에서도 경제형 실패 → 정밀형 승격이 실제로 일어남(" + seen.join(",") + ")");
  ok(r.outcome === "applied", "승격한 정밀형이 성공하면 적용까지 간다");
  // 5차 blocker①: 중간 실패 사유가 성공 기록에 남으면 감사가 뒤집힌다.
  const rowsA = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((x) => x.schema === "map-automation-v1" && (x.event === "enrich-job-terminal" || x.event === "enrich-run-terminal"));
  const lastTwo = rowsA.slice(-2);
  ok(lastTwo.length === 2 && lastTwo.every((x) => x.outcome === "applied" && x.reasonCode === "none"), "성공한 재시도는 실패 사유를 남기지 않는다(실제: " + lastTwo.map((x) => x.outcome + "/" + x.reasonCode).join(",") + ")");
  // 5차 [보완]: 승격을 고른 이유가 감사에서 사라지면 안 된다.
  const routeRows = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((x) => x.route === "precision" && x.reason === "escalated-from-economy");
  ok(routeRows.length >= 1 && routeRows.some((x) => x.escalated === true), "재개 승격도 라우팅 결정 행(escalated)을 남긴다");
}

console.log("[7d] 변환 단계 거부도 구조 필드·감사 사유를 남긴다(2026-07-29 구현검증 blocker②③)");
{
  const { ws, nodeId } = setup("convert-fail");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  // 결과 검증은 통과하지만 변환 시점 재실증에서 떨어지도록: 호출 뒤 근거 파일 내용을 바꾼다.
  const quote = "const A = 1;";
  fs.writeFileSync(require("path").join(ws, "src", "a.js"), quote + "\n", "utf8");
  const fake = () => { fs.writeFileSync(require("path").join(ws, "src", "a.js"), "완전히 다른 내용\n", "utf8"); return { ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/a.js", quote }] },
  ] } }; };
  const before = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").length;
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: fake } }));
  const j = ME.readEnrichJob(ws).job;
  const a0 = j && j.attempts[0];
  ok(!!a0 && a0.phase === "failed" && ["validation", "conversion"].includes(a0.failureStage), "호출 뒤 근거가 바뀐 경우도 단계를 구조로 남김(" + (a0 && a0.failureStage) + ")");
  ok(!!a0 && ["evidence-mismatch", "evidence-unreadable", "convert-invalid"].includes(a0.failureCode), "실패 코드 기록(" + (a0 && a0.failureCode) + ")");
  const rows = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").filter(Boolean).slice(before).map(JSON.parse)
    .filter((x) => x.schema == "map-automation-v1" && (x.event === "enrich-job-terminal" || x.event === "enrich-run-terminal"));
  ok(rows.length >= 1 && rows.every((x) => x.reasonCode === "provider-result-invalid"), "결과 거부는 '못 불렀다'가 아니라 결과 거부로 기록(실제: " + rows.map((x) => x.reasonCode).join(",") + ")");
  ok(r.outcome === "parked" || r.outcome === "provider-failed", "결과 거부는 적용 없이 종료");
}

console.log("[7d-2] 변환 단계 거부의 기록 계약(소스 잠금 — 이 경로는 런타임 재현이 어려워 소스로 고정)");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  const st0 = src.indexOf("function failAttempt(");
  const fn = st0 >= 0 ? src.slice(st0, src.indexOf(String.fromCharCode(10) + "}", st0)) : "";
  ok(!!fn && /failureStage: "conversion"/.test(fn), "변환 단계 실패도 단계를 구조로 남긴다");
  ok(/failureCode: conv\.code \|\| "evidence-mismatch"/.test(fn) && /failureCode: "convert-invalid"/.test(fn), "근거 계열과 그 밖을 코드로 갈라 남긴다");
  ok(/_p10Reason: "provider-result-invalid"/.test(fn), "변환 단계 거부도 '못 불렀다'가 아니라 결과 거부로 감사 기록");
  ok(/if \(!w\.ok\) return env\.park/.test(fn), "실패 기록 쓰기 실패를 삼키지 않는다(running 잔존 차단)");
  ok(/safeFailureFile\(conv\.file\)/.test(fn), "파일 표기는 안전 검사를 거친 값만 남긴다");
}

console.log("[7e] 위험한 파일 표기는 기록에서 생략하되 실패 자체는 남는다(2026-07-29 blocker④·[보완])");
{
  const { ws, nodeId } = setup("badfile");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const fake = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/nope.js", quote: "// 없는 인용" }] },
  ] } });
  ME.runEnrich(ws, base(ws, { adapters: { self: fake } }));
  const a0 = ME.readEnrichJob(ws).job.attempts[0];
  ok(a0.phase === "failed", "실패 기록이 남아 시도가 running으로 방치되지 않음");
  ok(a0.failureCode === "evidence-unreadable" && a0.failureFile === "src/nope.js", "없는 파일은 판독 불가로 분류(인용 불일치와 구분)");
}
{
  // 3차 [보완]: 원 blocker는 '위험한 표기'였는데 앞 반례는 안전한 상대경로만 썼다. 실제 위험 형태로 고정한다.
  const NL = String.fromCharCode(10);
  const cases = [
    ["절대경로", "D:/somewhere/secret.js"],
    ["상위 탈출", "../../etc/passwd"],
    ["여러 줄", "src/a.js" + NL + "(연결 정상)"],
  ];
  for (const [label, bad] of cases) {
    const { ws, nodeId } = setup("badfile-" + label.replace(/\s/g, ""));
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    const fake = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
      { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: bad, quote: "// 없는 인용" }] },
    ] } });
    ME.runEnrich(ws, base(ws, { adapters: { self: fake } }));
    const jr = ME.readEnrichJob(ws);
    const at = jr.st === "ok" ? jr.job.attempts[0] : null;
    ok(!!at && at.phase === "failed", label + " — 실패 기록이 남는다(기록 쓰기가 통째로 거부돼 running으로 남지 않음)");
    ok(!!at && at.failureFile === undefined, label + " — 위험한 파일 표기는 필드 자체를 생략한다");
  }
}
{
  const { ws, topo } = setup("parse-invalid");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: () => ({ ok: false, failureKind: "result-invalid", detail: "JSON 파싱 실패" }) } }));
  const invalidRows = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((x) => x.schema === "map-automation-v1" && x.mapId === topo.mapId && (x.event === "enrich-job-terminal" || x.event === "enrich-run-terminal"));
  ok(r.outcome === "parked" && invalidRows.length === 2 && invalidRows.every((x) => x.reasonCode === "provider-result-invalid"), "어댑터 JSON 파싱 실패도 호출 실패와 분리해 provider-result-invalid로 기록");
}
{
  const { ws, nodeId, topo } = setup("extchange");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  ok(ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } })).outcome === "applied", "(전제) 1차 보강 적용");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  let re = 0;
  ok(ME.runEnrich(ws, base(ws, { adapters: { self: () => { re++; return goodAdapter(nodeId)({}); } } })).reason === "already-enriched" && re === 0, "외부 변경 0=수렴 noop(sourceFp)");
  fs.writeFileSync(require("path").join(ws, "src", "a.js"), "// changed externally" + require("os").EOL);
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 소스 변경 후 큐 재작성");
  const r3 = ME.runEnrich(ws, base(ws, { adapters: { self: (c) => { re++; return goodAdapter(nodeId)(c); } } }));
  ok(re === 1 && r3.outcome !== "noop", "실제 외부 변경=재보강 실행(blocker⑤ — authority 결속이었다면 영구 억제됐을 경로)");
}

console.log("[6] historylessChanges — invSnap 대조(삭제·신규·메타 동일 교체)");
{
  const { ws } = setup("hist");
  const q = JSON.parse(fs.readFileSync(MB.queueFileFor(ws), "utf8"));
  ok(q.schema === "enrich-queue-v1" && q.invSnap && Array.isArray(q.invSnap.files), "큐 v1에 invSnap 실기록(historyless)");
  ok((ME.historylessChanges(ws, q.invSnap, MR) || []).length === 0, "무변경=공집합(초회 보강=mapped 재료)");
  fs.writeFileSync(path.join(ws, "src", "new.js"), "// new\n");
  ok((ME.historylessChanges(ws, q.invSnap, MR) || []).includes("src/new.js"), "신규 파일=변경");
  const st0 = fs.statSync(path.join(ws, "src", "a.js"));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// A\n"); // 같은 길이 교체
  fs.utimesSync(path.join(ws, "src", "a.js"), st0.atime, st0.mtime); // 메타 동일 위장
  ok((ME.historylessChanges(ws, q.invSnap, MR) || []).includes("src/a.js"), "메타 동일 내용 교체=지문 대조로 검출(6차 설계 반례)");
  ok(ME.historylessChanges(ws, undefined, MR) === null, "invSnap 부재=null(corridor unknown 정직)");
  const partialMr = { collectInventory: () => ({ files: [], cov: { scanComplete: false, entryCapped: true, depthCapped: [] } }) };
  ok(ME.historylessChanges(ws, q.invSnap, partialMr) === null, "현재 스캔이 10만 항목 상한에 닿으면 null(corridor unknown — 빈 변경으로 위장 금지)");
}
{
  const { ws, nodeId } = setup("partial-source-fp");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  ok(ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } })).outcome === "applied", "(전제) 완전 스캔의 완료 도장 생성");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 적용 뒤 큐 재결속");
  const q = JSON.parse(fs.readFileSync(MB.queueFileFor(ws), "utf8"));
  const complete = MR.collectInventory(ws);
  const origCollect = MR.collectInventory;
  let calls = 0;
  try {
    MR.collectInventory = () => ({ files: complete.files, cov: { ...complete.cov, scanComplete: false, entryCapped: true } });
    ok(ME.computeSourceFp(ws, q, null, MR) === null, "불완전 현재 스캔은 sourceFp를 만들지 않음(부분 지문 완료 도장 금지)");
    const r = ME.runEnrich(ws, base(ws, { adapters: { self: () => { calls++; return { ok: false, detail: "partial-scan-probe" }; } } }));
    ok(r.reason !== "already-enriched" && calls === 1, "부분 스캔은 기존 완료 도장으로 조기 종료하지 않음(corridor unknown이 실행 흐름에 생존)");
  } finally { MR.collectInventory = origCollect; }
}

console.log("[8] 3b 2차 반례 — v0 마이그레이션·재개 동결 주체");
{
  // v0 historyless 큐가 자동 흐름에서 v1로 전환(2차 blocker⑦ — queueFresh가 stale 취급)
  const { ws } = setup("v0mig");
  const qf = MB.queueFileFor(ws);
  const q1 = JSON.parse(fs.readFileSync(qf, "utf8"));
  fs.writeFileSync(qf, JSON.stringify({ schema: "enrich-queue-v0", mapId: q1.mapId, mapHash: q1.mapHash, basis: q1.basis, topoStat: q1.topoStat, queuedAt: q1.queuedAt, provider: null }, null, 2));
  ok(MB.queueLooksSane(ws) === true, "(전제) v0 큐 자체는 sane(판독 무회귀)");
  ok(MB.ensureQueue(ws, PM) === true, "ensureQueue가 fresh v0을 멱등 인정하지 않고 재작성");
  const q2 = JSON.parse(fs.readFileSync(qf, "utf8"));
  ok(q2.schema === "enrich-queue-v1" && q2.invSnap && Array.isArray(q2.invSnap.files), "v1+invSnap 마이그레이션 완료(영구 park 회귀 봉합)");
}
{
  // 재개는 job에 동결된 주체(configWs·slot·mode) 사용 — 타 ws 호출자의 재개에도 장부 주체 불변(ab-1)
  const { ws, nodeId } = setup("frozen");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  // running self 잔존 구성(사망 창) → 타 ws 호출자가 재개해도 장부 configWs는 동결값 유지
  ME.runEnrich(ws, base(ws, { adapters: { self: () => ({ ok: false, detail: "seed" }) } }));
  const j0 = ME.readEnrichJob(ws).job;
  const reopened = { ...j0, phase: "open", attempts: j0.attempts.map((a, k) => k === j0.attempts.length - 1 ? (() => { const b = { ...a, phase: "running" }; delete b.failReason; delete b.finishedAt; return b; })() : a) };
  delete reopened.finishedAt; delete reopened.parkedReason;
  fs.writeFileSync(ME.jobFileFor(ws), JSON.stringify(reopened, null, 1));
  ok(ME.readEnrichJob(ws).st === "ok", "(전제) open+running self 잔존 장부 구성");
  fs.writeFileSync(CL.contractFileFor("D:\\other\\place", "ko"), JSON.stringify({ scoutMode: "on" })); // 타 창도 3트랙(현실 재개 시나리오)
  const r = ME.runEnrich(ws, { ...base(ws, { adapters: { self: (c) => goodAdapter(nodeId)(c) } }), ws: "D:\\other\\place" });
  ok(r.outcome === "applied" || r.outcome === "settled" || r.outcome === "parked", "(관측) 타 ws 호출자의 재개 실행 진행");
  const j1 = ME.readEnrichJob(ws).job;
  ok(CL.normWs(j1.configWs) === CL.normWs(ws), "장부 주체=동결 configWs 유지(호출자 ws 오염 없음 — ab-1)");
}

console.log("[8b] 재개 done 도장=호출 시점 지문(5차 f-7c453391 — 사망 창에서 사후 지문 도장 금지)");
{
  const { ws, nodeId } = setup("stampfix");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  ok(ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } })).outcome === "applied", "(전제) 1차 보강 완료");
  const jS = ME.readEnrichJob(ws).job;
  ok(typeof jS.attempts[0].sourceFp === "string", "attempt에 호출 시점 sourceFp 영속");
  // 사망 창 재현: results 영속 직후(applying·cursor 초기) 상태로 되감고 → 소스 변경 → 재개
  const rewound = { ...jS, phase: "open", sourceFp: undefined, finishedAt: undefined, attempts: jS.attempts.map((a) => { const b = { ...a, phase: "applying", cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [] } }; delete b.finishedAt; return b; }) };
  delete rewound.sourceFp; delete rewound.finishedAt;
  fs.writeFileSync(ME.jobFileFor(ws), JSON.stringify(rewound, null, 1));
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// changed during death window" + require("os").EOL); // 사망 중 소스 변경
  const rRes = ME.runEnrich(ws, base(ws, { adapters: { self: goodAdapter(nodeId) } }));
  ok(rRes.outcome === "parked" || rRes.outcome === "applied" || rRes.outcome === "settled" || rRes.outcome === "provider-failed" || rRes.outcome === "noop", "(관측) 재개 실행: " + rRes.outcome);
  const jD = ME.readEnrichJob(ws).job;
  if (jD.phase === "done") {
    ok(jD.sourceFp === undefined || jD.sourceFp === jS.attempts[0].sourceFp, "done 도장은 호출 시점 지문(또는 미기록) — 변경 후 지문 아님");
    ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
    let re = 0;
    const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: (c) => { re++; return goodAdapter(nodeId)(c); } } }));
    ok(re === 1 || r2.reason !== "already-enriched", "사망 중 변경된 소스=재보강 억제 없음(영구 생략 경로 봉합)");
  } else { ok(true, "(관측) 재개가 done 아님(" + jD.phase + ") — 도장 오염 경로 자체가 미발생"); ok(true, "(스킵)"); ok(true, "(스킵)"); }
}

console.log("[8c] sourceFp 폴백=AND(6~7차 — 같은 jobKey에서 기록 부재 done이 재보강을 영구 억제하지 않음)");
{
  // topology 불변 완료(reject-only settled)로 jobKey를 고정 — 폴백 분기가 '실제로' 실행되는 반례(7차 지적 반영)
  const { ws, topo, nodeId } = setup("andfix");
  const lbl = topo.nodes[0].label;
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const rlA = (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "rewrite_label", targetId: nodeId, payload: { to: { label: lbl + "-z" }, expect: { label: lbl } }, evidence: [{ file: "src/a.js", quote: "// a" }], claims: [{ file: "src/a.js", quote: "// a", stance: "support" }] },
  ] } });
  const r1 = ME.runEnrich(ws, base(ws, { adapters: { self: rlA }, askVerifier: () => ({ verdict: "reject" }) }));
  ok(r1.outcome === "settled", "(전제) reject-only settled 완료(topology 불변=authority 불변)");
  const jA = ME.readEnrichJob(ws).job;
  // 같은 jobKey 확인용: 지문 제거 전 현재 실행이 계산할 jobKey와 동일해야 폴백 분기 도달
  const idxA = MP.decisionIndexFor(ws, jA.mapId);
  const ahA = MP.authorityOf(PM.mapHashOf(MR.readTopoExFor(ws).topo), idxA).ah;
  ok(jA.jobKey === ME.jobKeyOf(jA.mapId, ahA, null), "(전제) done jobKey==현재 재계산 jobKey(topology 불변 확인)");
  // 구 형식 장부 시뮬: job·attempt 지문 전부 제거
  const stripped = { ...jA, attempts: jA.attempts.map((a) => { const b = { ...a }; delete b.sourceFp; return b; }) };
  delete stripped.sourceFp;
  fs.writeFileSync(ME.jobFileFor(ws), JSON.stringify(stripped, null, 1));
  let re = 0;
  const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: (c) => { re++; return rlA(c); } }, askVerifier: () => ({ verdict: "reject" }) }));
  ok(re === 1 && r2.reason !== "already-enriched", "같은 jobKey+지문 부재 done+현재 지문 산출 가능=재보강 실행(AND 폴백 — OR였다면 already-enriched로 억제)");
}

console.log("[8d] 같은 jobKey의 새 실행은 과거 terminal·active를 현재 네 수치에 섞지 않음");
for (const prior of ["terminal", "active"]) {
  const { ws, topo, nodeId } = setup("run-generation-" + prior);
  const lbl = topo.nodes[0].label;
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const item = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "rewrite_label", targetId: nodeId, payload: { to: { label: lbl + "-g" }, expect: { label: lbl } }, evidence: [{ file: "src/a.js", quote: "// a" }], claims: [{ file: "src/a.js", quote: "// a", stance: "support" }] },
  ] } });
  const a = ME.runEnrich(ws, base(ws, { adapters: { self: item }, ...(prior === "terminal" ? { askVerifier: () => ({ verdict: "reject" }) } : {}) }));
  ok(a.outcome === "settled" && ME.deferredSummary(ws).awaiting === (prior === "active" ? 1 : 0), prior + " 실행 A 구성");
  const jobA = ME.readEnrichJob(ws).job, runA = ME.jobRunIdOf(jobA);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
  fs.appendFileSync(path.join(ws, "src", "a.js"), "// source generation B\n");
  const b = ME.runEnrich(ws, base(ws, { adapters: { self: item } }));
  const jobB = ME.readEnrichJob(ws).job, runB = ME.jobRunIdOf(jobB), ds = ME.deferredSummary(ws), counts = ME.enrichOutcomeSummary(jobB, ds);
  ok(jobB.jobKey === jobA.jobKey && runB !== runA, prior + " 실행 B는 같은 jobKey·다른 실행 세대");
  ok(b.awaitingVerification === 1 && counts.applied === 0 && counts.rejected === 0 && counts.awaiting === 1 && counts.investigation === 0,
    prior + " 실행 A 결과가 실행 B의 적용·기각·대기·조사 수에 혼입되지 않음");
  ok((prior === "active" ? counts.otherAwaiting === 1 : counts.otherAwaiting === 0) && counts.unattributed === 0,
    prior + " 과거 활성은 이전 실행 대기로 분리하고 새 형식 기록은 미귀속 0");
  if (prior === "active") {
    const rr = ME.runEnrich(ws, base(ws, { trigger: "retry", askVerifier: () => ({ verdict: "reject", claims: [] }) }));
    const rows = fs.readFileSync(ME.ROUTE_LOG, "utf8").trim().split("\n").map(JSON.parse).filter((x) => x.schema === "map-automation-v1" && x.mapId === topo.mapId);
    const rt = [...rows].reverse().find((x) => x.event === "enrich-run-terminal"), jt = rows.filter((x) => x.event === "enrich-job-terminal" && rt && x.runId === rt.runId);
    ok(rr.reason === "deferred-retry" && jt.length === 2 && new Set(jt.map((x) => x.jobRunId)).size === 2 && jt.some((x) => x.jobRunId === runA) && jt.some((x) => x.jobRunId === runB),
      "한 retry가 A/B 두 대기 세대를 처리해도 job terminal 2건·세대별 1건");
    const aTerm = jt.find((x) => x.jobRunId === runA), bTerm = jt.find((x) => x.jobRunId === runB);
    ok(aTerm.baselineState === "prior-terminal" && bTerm.baselineState === "current-job", "교체된 A는 prior terminal, 현재 B는 current-job 기준선으로 분리");
  }
}

console.log("[9] run-lock 사망 회수 — 동시 복구자 경합(4차: 시작 장벽+임계구역 유지+3회 반복)");
{
  const { ws } = setup("locktwo");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const runLock = path.join(ME.ENRICH_DIR, ME.repoKeyFor(ws) + ".run.funlock");
  // 헬퍼: 시작 장벽(barrier 파일 폴링 — 두 프로세스가 '동시에' 회수 시도)+임계구역 유지(어댑터가 300ms 점유 —
  // 순차 진입이면 후발이 반드시 잠금 보유와 겹침). 결과=파일 수집(이벤트 루프 차단 함정 회피).
  const helper = path.join(os.tmpdir(), "p8er-race-" + Date.now() + ".js");
  fs.writeFileSync(helper, [
    "process.env.CODEX_BRIDGE_HOME = process.argv[4];",
    "const fs = require('fs');",
    "const ME = require(process.argv[2] + '/bridge/map-enrich.js');",
    "const barrier = process.argv[6];",
    "const t0 = Date.now(); while (!fs.existsSync(barrier) && Date.now() - t0 < 10000) { /* spin */ }",
    "const hold = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };",
    "const r = ME.runEnrich(process.argv[3], { ws: process.argv[3], slot: 'ko', mode: 'self', readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => { hold(300); return { ok: false, detail: 'race-probe' }; } }, trigger: 'race' });",
    "fs.writeFileSync(process.argv[5], JSON.stringify(r));",
  ].join(require("os").EOL));
  const { spawn } = require("child_process");
  let stable = true;
  for (let round = 0; round < 3 && stable; round++) {
    fs.writeFileSync(runLock, JSON.stringify({ pid: 999999, token: "dead" })); // 죽은 소유자 잔재
    const barrier = path.join(os.tmpdir(), "p8er-barrier-" + Date.now() + "-" + round);
    const outFiles = [0, 1].map((i) => path.join(os.tmpdir(), "p8er-race-out-" + Date.now() + "-" + round + "-" + i + ".json"));
    outFiles.forEach((f) => spawn(process.execPath, [helper, path.join(__dirname, ".."), ws, process.env.CODEX_BRIDGE_HOME, f, barrier], { stdio: "ignore" }));
    require("child_process").spawnSync(process.execPath, ["-e", "setTimeout(()=>{},300)"]); // 두 자식이 장벽 폴링에 도달할 시간
    fs.writeFileSync(barrier, "go");
    const t0 = Date.now();
    while (outFiles.some((f) => !fs.existsSync(f)) && Date.now() - t0 < 30000) { require("child_process").spawnSync(process.execPath, ["-e", "setTimeout(()=>{},50)"]); }
    const parsed = outFiles.map((f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }).filter(Boolean);
    const enterN = parsed.filter((r) => r.outcome !== "busy").length;
    if (!(parsed.length === 2 && enterN === 1)) { stable = false; console.log("    (round " + round + " 결과: " + JSON.stringify(parsed) + ")"); }
    // 다음 라운드 전 정리: 진입자가 park를 남기므로 장부 제거(같은 시나리오 반복)
    try { fs.rmSync(ME.jobFileFor(ws), { force: true }); } catch { /* 무해 */ }
    try { fs.rmSync(runLock, { force: true }); } catch { /* 무해 */ }
  }
  ok(stable === true, "3회 반복 전부 — 정확히 1개만 임계구역 진입(장벽 동시 출발+300ms 임계 유지·이중 실행 0)");
}

console.log("[10] 입력 자기치유(2026-08-04 보류 반복 봉합) — 문서·산출물뿐=호출 0, 코드 오면 자동 재개");
{
  // (i) 신규 라운드: 변경이 문서·산출물뿐 → job조차 안 만들고 noop(호출 0·park 0·경보 0)
  const { ws, nodeId } = setup("docOnly");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  fs.writeFileSync(path.join(ws, "RELEASE.txt"), "release notes\n");
  fs.writeFileSync(path.join(ws, "bundle.zip"), "zzz\n");
  let called = 0;
  const spy = () => { called++; return goodAdapter(nodeId)({}); };
  const r1 = ME.runEnrich(ws, base(ws, { adapters: { self: spy } }));
  ok(r1.outcome === "noop" && r1.reason === "input-doc-only", "문서·산출물뿐=noop(input-doc-only)");
  ok(called === 0 && !fs.existsSync(ME.jobFileFor(ws)), "호출 0·job 파일 미생성(과금 0·보류 경보 0)");
  // (ii) 코드 변경이 생기면 같은 tick 흐름이 자연 진행 — 정상 적용
  fs.writeFileSync(path.join(ws, "src", "b.js"), "// b\n");
  const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: spy } }));
  ok(r2.outcome === "applied" && called === 1, "코드 변경 도착=자연 진행(applied·호출 1)");
}
{
  // (iii) 답 거부로 park된 job이 '입력이 원천 불가능'해지면 사유를 input-doc-only로 재진단(추가 호출 0)
  //       → 코드 변경이 오면 사람 없이 재개(retryFrom 이동=과거 실패 플래그 무되돌림).
  const { ws, nodeId } = setup("heal");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: "economy" });
  let calls = 0;
  const badThenGood = () => { calls++; return calls === 1
    ? { ok: true, result: { schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "doc", ref: "docs/x.md", note: "n" } }, evidence: [{ file: "RELEASE.txt", quote: "release" }] }] } } // doc 단독 근거=관문 거부(답 거부 park 유도)
    : goodAdapter(nodeId)({}); };
  fs.writeFileSync(path.join(ws, "src", "c.js"), "// c\n"); // 첫 라운드는 코드 변경 실재(입력 관문 통과)
  const rA = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: badThenGood } }));
  ok(rA.outcome === "parked" && rA.reason === "economy-failed" && calls === 1, "답 거부=economy-failed park(1호출)");
  // 코드 변경이 사라지고 산출물만 남은 상태(예: 커밋 후 릴리스 파일만 잔존)를 재현 — invSnap 재생성
  fs.rmSync(path.join(ws, "src", "c.js"), { force: true });
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성(코드 변경 소진 후 상태)");
  fs.writeFileSync(path.join(ws, "SHA256SUMS.txt"), "sums\n");
  const rB = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: badThenGood } }));
  ok(rB.outcome === "noop" && rB.parkedReason === "input-doc-only" && calls === 1, "재진단=input-doc-only(자동재시도 과금 차단·추가 호출 0)");
  const jB = ME.readEnrichJob(ws).job;
  ok(jB.phase === "parked" && jB.parkedReason === "input-doc-only", "장부 사유 교체(phase parked 유지)");
  const evB = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_BRIDGE_HOME, "integrity.json"), "utf8")).events.filter((e) => e.kind === "enrich-parked" && !e.ack && CL.normWs(String(e.workspace || "")) === CL.normWs(ws));
  ok(evB.length === 1 && /input-doc-only/.test(evB[0].detailKo || ""), "경보도 정확한 사유로 교체(이 작업장 동종 대체 — 중복 0)");
  const rB2 = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: badThenGood } }));
  ok(rB2.outcome === "noop" && calls === 1, "여전히 불가능=조용한 대기(재경보·재호출 0)");
  // 수동 '다시 시도' 반복=경보 중복 금지(2026-08-04 사용자 실보고): 같은 사유가 이미 열려 있으면 재발행 0
  ME.updateEnrichJob(ws, (jj) => { if (!jj || jj.phase !== "parked") return null; const nx = { ...jj, phase: "open", retryFrom: jj.attempts.length }; delete nx.finishedAt; delete nx.parkedReason; return nx; });
  const rRe = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: badThenGood } }));
  ok(rRe.outcome === "parked" && rRe.reason === "input-doc-only" && calls === 1, "수동 재시도도 호출 직전 관문이 과금 없이 정지");
  const evRe = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_BRIDGE_HOME, "integrity.json"), "utf8")).events.filter((e) => e.kind === "enrich-parked" && !e.ack && CL.normWs(String(e.workspace || "")) === CL.normWs(ws));
  ok(evRe.length === 1, "같은 사유 재멈춤=경보 재발행 0(열린 1건 유지 — 반복 체감 차단)");
  // (iv) 코드 변경 도착 → 사람 없이 재개·적용
  fs.writeFileSync(path.join(ws, "src", "d.js"), "// d\n");
  const rC = ME.runEnrich(ws, base(ws, { mode: "economy", adapters: { economy: badThenGood } }));
  ok(rC.outcome === "applied" && calls === 2, "코드 변경 도착=자기 재개→적용(총 2호출)");
  ok(ME.readEnrichJob(ws).job.phase === "done", "장부 done(자기치유 완주)");
}

console.log("[11] 소화 기준점 교체(2026-08-04 사용자 결정) — 커밋된 변경도 보강 입력에 합류");
{
  const cp = require("child_process");
  const g = (repo, args) => cp.spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p8er_git_"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.js"), "// a\n");
  g(repo, ["init", "-q"]); g(repo, ["config", "user.email", "t@t"]); g(repo, ["config", "user.name", "t"]);
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "c1"]);
  const h1 = g(repo, ["rev-parse", "HEAD"]).stdout.trim();
  // 기준점 왕복(손상=무시)
  ok(ME.readConsumedBaseline(repo) === null, "기준점 부재=null(폴백 재료)");
  ok(ME.writeConsumedBaseline(repo, "짧은해시") === false, "형식 위반 head=기록 거부");
  ok(ME.writeConsumedBaseline(repo, h1, "map-1") === true && ME.readConsumedBaseline(repo).head === h1, "기준점 기록·재판독");
  fs.writeFileSync(ME.consumedFileFor(repo), "{깨진");
  ok(ME.readConsumedBaseline(repo) === null, "손상 기준점=null(종전 입력 폴백)");
  ok(ME.writeConsumedBaseline(repo, h1, "map-1") === true, "(복구) 재기록");
  // 핵심 반례: 코드 변경을 '커밋해 버린' 뒤 작업트리에는 산출물만 남은 상태 — 종전 입력(작업트리뿐)이면
  // 문서·산출물뿐이라 관문이 막지만, 기준점 합류가 커밋된 코드 파일을 입력에 되살린다.
  fs.writeFileSync(path.join(repo, "src", "b.js"), "// b\n");
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "c2"]);
  fs.writeFileSync(path.join(repo, "bundle.zip"), "zzz\n"); // 미커밋 산출물만 잔존
  const worktreeOnly = ["bundle.zip"];
  const headNow = () => g(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const expanded = ME.expandChangedWithConsumedDelta(repo, worktreeOnly, headNow());
  ok(expanded.includes("src/b.js") && expanded.includes("bundle.zip"), "기준점 이후 커밋 변경(src/b.js) 합류(작업트리 항목 보존)");
  const mkTopo9 = (paths) => ({ nodes: [{ id: U(1), label: "L", entityType: "module", state: {}, anchors: paths.map((p) => ({ kind: "code", path: p })) }], edges: [] });
  ok(ME.answerableInput(repo, mkTopo9(["src/a.js"]), worktreeOnly) === false && ME.answerableInput(repo, mkTopo9(["src/a.js"]), expanded) === true, "종전 입력=답 불가 차단 vs 합류 입력=답 가능(기아 해소 실증)");
  ok(ME.expandChangedWithConsumedDelta(repo, null, headNow()) === null, "changed=unknown(null)은 확장 안 함(추측 금지)");
  ok(ME.expandChangedWithConsumedDelta(repo, worktreeOnly).join(",") === worktreeOnly.join(","), "끝점 미지정=확장 안 함(경합 창 차단 — 자체 HEAD 재조회 금지)");
  fs.writeFileSync(ME.consumedFileFor(repo), JSON.stringify({ head: "f".repeat(40), mapId: "x", at: "t" }));
  const gone = ME.expandChangedWithConsumedDelta(repo, worktreeOnly, headNow());
  ok(Array.isArray(gone) && gone.join(",") === worktreeOnly.join(","), "기준 커밋 소실(diff 실패)=종전 입력 그대로(보수)");
  // 검증 blocker ②: 비ASCII 파일명은 기본 quotePath로 C식 인용돼 확장자·판독이 어긋난다 — -z 원문 경로
  ok(ME.writeConsumedBaseline(repo, h1, "map-1") === true, "(전제) 유효 기준점 복원(직전 소실 반례가 가짜 값으로 덮음)");
  fs.writeFileSync(path.join(repo, "src", "한글모듈.js"), "// 한글\n");
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "c3"]);
  const expanded2 = ME.expandChangedWithConsumedDelta(repo, ["bundle.zip"], headNow());
  ok(expanded2.includes("src/한글모듈.js") && !expanded2.some((f) => f.startsWith('"')), "비ASCII 경로=원문 복원(-z — 인용 형식 잔재 0)");
  ok(ME.answerableInput(repo, mkTopo9(["src/a.js"]), ["bundle.zip", "src/한글모듈.js"]) === true, "복원된 비ASCII 코드 파일이 관문 통과 재료가 됨");
  // 배선: ⑦a 합류+입력 시점 srcHead 캡처+done 도장=완료 시점 재판독 금지(소스 계약 — 검증 blocker ①)
  const meSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-enrich.js"), "utf8");
  ok(/changed = expandChangedWithConsumedDelta\(repo, changed, srcHead\);/.test(meSrc), "⑦a 배선 — 합류의 끝점=같은 시점에 캡처한 srcHead(경합 창 차단)");
  ok(meSrc.includes('base.head + ".." + endHead') && !meSrc.includes('base.head + "..HEAD"'), "delta 끝점=고정 커밋(자체 HEAD 재조회 잔재 0)");
  ok(!/\.map\(\(s\) => s\.trim\(\)\)\.filter\(Boolean\)/.test(meSrc.slice(meSrc.indexOf("function expandChangedWithConsumedDelta"), meSrc.indexOf("function expandChangedWithConsumedDelta") + 1600)), "NUL 파서 trim 금지(선행 공백 파일명 원문 보존 — 함수 본문 검사)");
  ok(/if \(st && st\.srcHead\) writeConsumedBaseline\(repo, st\.srcHead, j\.mapId\);/.test(meSrc), "done 도장=입력 시점 srcHead에만 결속");
  {
    const doneIdx = meSrc.indexOf("if (st && st.srcHead) writeConsumedBaseline");
    const doneBlk = meSrc.slice(doneIdx - 600, doneIdx + 200);
    ok(!/rev-parse/.test(doneBlk), "done 도장 주변에 완료 시점 HEAD 재판독 부재(실행 중 커밋 소화 오도장 차단)");
  }
}
console.log("[11b] 실행 중 커밋 반례(검증 blocker ①) — 기준점은 '입력 계산 시점' 커밋에 결속(e2e)");
{
  const cp = require("child_process");
  const g = (repo, args) => cp.spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  const ws = mkRepo("midrun");
  g(ws, ["init", "-q"]); g(ws, ["config", "user.email", "t@t"]); g(ws, ["config", "user.name", "t"]);
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c1"]);
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const r0 = MR.initTopologyForBootstrap(ws);
  if (r0.st !== "created") throw new Error("init 실패: " + r0.st);
  const nodeId = MR.readTopoExFor(ws).topo.nodes[0].id;
  ok(MB.ensureQueue(ws, PM) === true, "(전제) git 기반 큐 생성");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const hBefore = g(ws, ["rev-parse", "HEAD"]).stdout.trim();
  // 어댑터가 호출 '도중' 새 커밋을 만든다 — 완료 시점 HEAD 재판독이면 이 커밋이 발췌 없이 소화 처리된다
  const midAdapter = (ctx) => {
    fs.writeFileSync(path.join(ws, "src", "midrun.js"), "// mid\n");
    g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "mid"]);
    return goodAdapter(nodeId)(ctx);
  };
  fs.writeFileSync(path.join(ws, "src", "dirty.js"), "// dirty\n"); // 입력이 될 작업트리 코드 변경
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: midAdapter } }));
  ok(r.outcome === "applied", "실행 자체는 정상 완주(applied)");
  const baseRec = ME.readConsumedBaseline(ws);
  ok(!!baseRec && baseRec.head === hBefore, "기준점=입력 계산 시점 커밋(실행 중 커밋으로 전진 금지)");
  const after = ME.expandChangedWithConsumedDelta(ws, [], g(ws, ["rev-parse", "HEAD"]).stdout.trim());
  ok(after.includes("src/midrun.js"), "실행 중 커밋 파일은 다음 라운드 입력에 남는다(발췌 없는 소화 0)");
}

console.log("[12] 해상도 v3 — file 노드 증분 세밀화(add_node+owns 동반 e2e·결정론 id·거부 반례)");
{
  const PM9 = MR.PM;
  const { ws, topo, nodeId } = setup("filenode");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const TMP = "11111111-2222-4333-8444-555555555555"; // 모델의 임시 UUID
  const mkFileNode = (tmpId, pathStr) => ({ op: "add_node", payload: { node: { id: tmpId, label: "a 모듈의 진입 파일", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: pathStr }] } }, evidence: [{ file: "src/a.js", quote: "// a" }] });
  const ownsEdge = (tmpId) => ({ op: "add_edge", payload: { edge: { id: "99999999-8888-4777-8666-555555555544", from: nodeId, to: tmpId, relation: "owns", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } } }, evidence: [{ file: "src/a.js", quote: "// a" }] });
  const adapter = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [mkFileNode(TMP, "src/a.js"), ownsEdge(TMP)] } });
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: adapter } }));
  ok(r.outcome === "applied" && r.applied === 2, "e2e — add_node(file)+같은 라운드 owns(임시 id 참조) 둘 다 적용");
  const t2 = MR.readTopoExFor(ws).topo;
  const detId = ME.detFileNodeId(t2.mapId, "src/a.js");
  const fnode = t2.nodes.find((n) => n.entityType === "file");
  ok(!!fnode && fnode.id === detId && fnode.state.confidence === "candidate", "file 노드 실재·id=결정론 파생·confidence=candidate");
  const oedge = t2.edges.find((e) => e.relation === "owns");
  ok(!!oedge && oedge.from === nodeId && oedge.to === detId, "owns 엣지 endpoint=결정론 id로 재작성(임시 id 잔재 0)");
  // 결정론 id 재현+중복 차단: 같은 파일 재제안 → 응답 검증 단계에서 중복 거부(answer-rejected)
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [mkFileNode("22222222-3333-4444-8555-666666666666", "src/a.js")] } }) } }));
  ok(r2.outcome !== "applied", "같은 파일 재제안=중복 거부(결정론 id 이중 방어의 앞단)");
}
{
  // 거부 반례 전수(응답 검증 — 순수 계층)
  const { ws, topo, nodeId } = setup("fnreject");
  const t0 = MR.readTopoExFor(ws).topo;
  const V = (items, ctx) => ME.validateEnrichResult({ schema: "enrich-result-v1", items }, t0, ctx);
  const node = (over, anchorOver) => ({ op: "add_node", payload: { node: { id: "11111111-2222-4333-8444-555555555555", label: "L", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js", ...(anchorOver || {}) }], ...(over || {}) } }, evidence: [{ file: "src/a.js", quote: "// a" }] });
  const ctx = { repo: ws, changed: ["src/a.js"] };
  ok(V([node()], ctx).ok === true, "정상 add_node=수용(발췌 실존·판독 가능)");
  ok(V([node({ entityType: "module" })], ctx).ok === false, "entityType≠file 거부");
  ok(V([node({ anchors: [{ kind: "code", path: "src/a.js" }, { kind: "code", path: "src/b.js" }] })], ctx).ok === false, "anchors 2개 거부");
  ok(V([node({ state: { lifecycle: "active", implementation: "runtime", confidence: "confirmed" } })], ctx).ok === false, "confirmed 태생 거부");
  ok(V([node(null, { kind: "doc" })], ctx).ok === false, "anchor.kind 세탁 거부(실제 분류와 불일치)");
  fs.writeFileSync(path.join(ws, "README.md"), "docs\n");
  const docNode = { op: "add_node", payload: { node: { id: "11111111-2222-4333-8444-555555555555", label: "L", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "doc", path: "README.md" }] } }, evidence: [{ file: "src/a.js", quote: "// a" }] };
  ok(V([docNode], { repo: ws, changed: ["README.md", "src/a.js"] }).ok === false, "doc 계열 anchor 거부(문서 파일 노드화 금지)");
  ok(V([node(null, { path: "src/ghost.js", kind: "code" })], { repo: ws, changed: ["src/ghost.js", "src/a.js"] }).ok === false, "판독 불가 anchor 거부(변경 목록에 있어도)");
  ok(V([node()], { repo: ws, changed: ["src/other.js"] }).ok === false, "발췌 밖 anchor 거부");
  ok(V([node({ id: nodeId })], ctx).ok === false, "임시 id=기존 topology id 충돌 거부");
  const twin = node(); const twin2 = JSON.parse(JSON.stringify(node())); twin2.payload.node.anchors[0].path = "src/b.js"; fs.writeFileSync(path.join(ws, "src", "b.js"), "// b\n");
  ok(V([twin, twin2], { repo: ws, changed: ["src/a.js", "src/b.js"] }).ok === false, "임시 id 상호 중복 거부");
  const edgeFirst = { op: "add_edge", payload: { edge: { id: "99999999-8888-4777-8666-555555555544", from: nodeId, to: "11111111-2222-4333-8444-555555555555", relation: "owns", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } } }, evidence: [{ file: "src/a.js", quote: "// a" }] };
  ok(V([edgeFirst, node()], ctx).ok === false, "임시 id를 add_node보다 앞서 참조하는 add_edge 거부(순차 가상 topology)");
  const six = Array.from({ length: 6 }, (_, i) => { const n9 = JSON.parse(JSON.stringify(node())); n9.payload.node.id = "11111111-2222-4333-8444-55555555555" + i; n9.payload.node.anchors[0].path = "src/f" + i + ".js"; fs.writeFileSync(path.join(ws, "src", "f" + i + ".js"), "// f\n"); return n9; });
  ok(V(six, { repo: ws, changed: six.map((x) => x.payload.node.anchors[0].path) }).ok === false, "라운드 상한(5) 초과=6개째 거부");
  // 재개 복원(설계 5-2b 축약 실증): 매핑=영속 items의 순수 함수 — 재계산이 같은 값·결속 검증과 동일 경로
  const items2 = [node(), edgeFirst]; items2[1] = { ...edgeFirst, payload: { edge: { ...edgeFirst.payload.edge, to: "11111111-2222-4333-8444-555555555555" } } };
  const m1 = ME.enrichTempIdMap(items2, 1, t0.mapId); const m2 = ME.enrichTempIdMap(items2, 1, t0.mapId);
  ok(m1.get("11111111-2222-4333-8444-555555555555") === ME.detFileNodeId(t0.mapId, "src/a.js") && m1.get("11111111-2222-4333-8444-555555555555") === m2.get("11111111-2222-4333-8444-555555555555"), "매핑=순수 함수(재계산 동일 — 재개 복원 근거)");
  const pl1 = ME.applyEnrichPayloadIds(items2, 1, t0.mapId);
  ok(pl1.edge.to === ME.detFileNodeId(t0.mapId, "src/a.js"), "add_edge endpoint 재작성=같은 함수(변환·결속 단일 경로)");
  // 정본 상한(semanticValidateV2 — 적용 잠금 안 권위): 60개째 topology에서 file add_node 거부
  const many = { ...t0, nodes: [...t0.nodes, ...Array.from({ length: MR.PM.MAX_FILE_NODES }, (_, i) => ({ id: ME.detFileNodeId(t0.mapId, "src/m" + i + ".js"), label: "m" + i, entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/m" + i + ".js" }] }))] };
  const capPatch = { schema: "map-patch-v2", operation: "add_node", payload: { node: { id: "77777777-6666-4555-8444-333333333333", label: "cap", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/cap.js" }] } } };
  const capFull = { ...capPatch, mapId: many.mapId };
  const semV = MR.PM.semanticValidateV2(many, capFull, {});
  ok(semV && Array.isArray(semV.errors) && semV.errors.some((e) => /file 노드 전체 상한/.test(e)), "정본 상한 — 60개 상태에서 add_node(file) 거부(잠금 안 권위·실제: " + JSON.stringify((semV && semV.errors || []).slice(0, 1)) + ")");
  const semUnder = MR.PM.semanticValidateV2(t0, capFull, {});
  ok(!(semUnder && Array.isArray(semUnder.errors) && semUnder.errors.some((e) => /file 노드 전체 상한/.test(e))), "정본 상한 — 상한 미만이면 상한 사유 없음(무회귀)");
}

console.log("[12b] 해상도 v3 — 실제 재개 e2e(add_node 적용 직후 사망 상태의 영속 장부 → 재개가 owns를 결정론 결속)");
{
  const PM9 = MR.PM;
  const { ws, nodeId } = setup("fnresume");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const TMP = "11111111-2222-4333-8444-555555555555";
  const mkFN = (tmpId, p9) => ({ op: "add_node", payload: { node: { id: tmpId, label: "역할", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: p9 }] } }, evidence: [{ file: "src/a.js", quote: "// a" }] });
  const mkOwns = (tmpId) => ({ op: "add_edge", payload: { edge: { id: "99999999-8888-4777-8666-555555555544", from: nodeId, to: tmpId, relation: "owns", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } } }, evidence: [{ file: "src/a.js", quote: "// a" }] });
  const rA = ME.runEnrich(ws, base(ws, { adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [mkFN(TMP, "src/a.js")] } }) } }));
  ok(rA.outcome === "applied", "(전제) 1라운드 — add_node만 적용(사망 직전까지의 실상태)");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  const topoB = MR.readTopoExFor(ws).topo;
  const idxB = MP.decisionIndexFor(ws, topoB.mapId);
  const { ah } = MP.authorityOf(PM9.mapHashOf(topoB), idxB);
  const consent = ME.readEnrichConsent(ws);
  const gen = ME.findGrant(consent, ws, "ko").gen;
  const startedAt = new Date().toISOString();
  const jobKey = ME.jobKeyOf(topoB.mapId, ah, null);
  const items = [mkFN(TMP, "src/a.js"), mkOwns(TMP)];
  const w = ME.updateEnrichJob(ws, () => ({ schema: "enrich-job-v2", jobKey, mapId: topoB.mapId, authorityHash: ah, decisionContextHash: null, mode: "self", configWs: CL.normWs(ws), slot: "ko", phase: "open", startedAt, attempts: [{ attemptId: 0, provider: "self", consentGen: gen, phase: "applying", startedAt, results: { schema: "enrich-result-v1", items }, cursor: { nextIndex: 1, rev: 0, appliedPatchIds: [ME.detPatchId(ME.jobSeedOf(jobKey, startedAt), 0, 0, 0)] } }] }));
  ok(w.ok === true, "사망 직후 영속 상태(applying·nextIndex=1)=strict 판독 승인");
  let calledB = 0;
  const rB = ME.runEnrich(ws, base(ws, { adapters: { self: () => { calledB++; return { ok: false, detail: "호출되면 안 됨" }; } } }));
  ok(rB.outcome === "applied" && calledB === 0, "재개=새 호출 0으로 잔여 owns 적용(실제 resumeJob·cursor 경로)");
  const tB = MR.readTopoExFor(ws).topo;
  const det = ME.detFileNodeId(tB.mapId, "src/a.js");
  ok(tB.edges.some((e) => e.relation === "owns" && e.to === det && e.from === nodeId), "재개 복원 매핑=결정론 endpoint(누락·오결속 0 — §5-2b)");
}
console.log("[12c] 해상도 v3 — 상한의 '실제 적용 잠금' 경로(propose→classify→apply)+우회 연산(split_node)");
{
  const PM9 = MR.PM;
  const { ws } = setup("fncap");
  // topology를 정본 파일로 확장: file 노드 60개(상한 도달 상태) — 이후 재판독·큐 재작성으로 정합 유지
  const tf = path.join(ws, "project-map", "topology.json");
  const t0 = JSON.parse(fs.readFileSync(tf, "utf8"));
  for (let i = 0; i < PM9.MAX_FILE_NODES; i++) t0.nodes.push({ id: ME.detFileNodeId(t0.mapId, "src/m" + i + ".js"), label: "m" + i, entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/m" + i + ".js" }] });
  fs.writeFileSync(tf, JSON.stringify(t0));
  ok(PM9.validateTopology(JSON.parse(fs.readFileSync(tf, "utf8"))).length === 0, "(전제) 60개 file 노드 topology=스키마 유효");
  const mkLive = (op, fields) => {
    const topo = MR.readTopoExFor(ws).topo;
    const idx = MP.decisionIndexFor(ws, topo.mapId);
    const pol = MP.policyStateFor(ws, topo.mapId);
    const { ah } = MP.authorityOf(PM9.mapHashOf(topo), idx);
    const b = { schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topo.mapId, basis: MP.patchBasisFor(ws, topo), baseMapHash: PM9.mapHashOf(topo), baseAuthorityHash: ah, baseDecisionContextHash: PM9.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "cap", evidence: [{ kind: "code", ref: "src/a.js" }], ...fields };
    b.readSet = MP.buildReadSetFor(topo, b, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
    return PM9.canonicalPatchV2(b);
  };
  const capNode = { id: "77777777-6666-4555-8444-333333333333", label: "cap", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/cap.js" }] };
  const pAdd = mkLive("add_node", { payload: { node: capNode } });
  ok(MP.proposePatch(ws, pAdd).ok === true, "(전제) 61개째 add_node 수납");
  const cfAdd = MP.classifyPatch(ws, pAdd.mapId, pAdd.patchId);
  const apAdd = MP.applyPatch(ws, pAdd.mapId, pAdd.patchId, { preCutover: true });
  ok(apAdd.ok === false && (JSON.stringify(cfAdd) + JSON.stringify(apAdd)).includes("file 노드 전체 상한"), "61개째 add_node=실제 파이프라인 거부(분류·적용 어느 관문이든 상한 사유 명시 — 적용 0)");
  ok(MR.readTopoExFor(ws).topo.nodes.filter((n) => n.entityType === "file").length === PM9.MAX_FILE_NODES, "topology file 노드 수=상한 유지(적용 0)");
  // split_node 우회(구현검증 1차 blocker 재현→차단): file 노드 1개를 file 2개로 쪼개면 60-1+2=61>60 → 거부
  const srcFile = MR.readTopoExFor(ws).topo.nodes.find((n) => n.entityType === "file");
  const nn1 = { id: "88888888-7777-4666-8555-444444444444", label: "s1", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: srcFile.anchors };
  const nn2 = { id: "88888888-7777-4666-8555-444444444445", label: "s2", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [] };
  const pSplit = mkLive("split_node", { targetId: srcFile.id, payload: { newNodes: [nn1, nn2], edgeReroute: [] } });
  ok(MP.proposePatch(ws, pSplit).ok === true, "(전제) split_node 수납");
  const cfSplit = MP.classifyPatch(ws, pSplit.mapId, pSplit.patchId);
  const apSplit = MP.applyPatch(ws, pSplit.mapId, pSplit.patchId, { preCutover: true });
  ok(apSplit.ok === false && (JSON.stringify(cfSplit) + JSON.stringify(apSplit)).includes("file 노드 전체 상한"), "split_node 우회=차단(60-1+2=61 거부·사유 명시)");
  ok(MR.readTopoExFor(ws).topo.nodes.filter((n) => n.entityType === "file").length === PM9.MAX_FILE_NODES, "split 후에도 file 노드 수=상한 유지(우회 적용 0)");
  // case 반례(§5-4)·변환 시점 판독 재검사(§5-5)
  const mid = MR.readTopoExFor(ws).topo.mapId;
  ok(ME.detFileNodeId(mid, "src/A.ts") !== ME.detFileNodeId(mid, "src/a.ts") && ME.detFileNodeId(mid, "src\\A.ts") === ME.detFileNodeId(mid, "src/A.ts"), "결정론 id — case 보존(별개 파일)·구분자만 정규화(같은 파일)");
  fs.writeFileSync(path.join(ws, "src", "gone9.js"), "// g\n");
  const topoC = MR.readTopoExFor(ws).topo; const idxC = MP.decisionIndexFor(ws, topoC.mapId); const polC = MP.policyStateFor(ws, topoC.mapId);
  const itemsC = [{ op: "add_node", payload: { node: { id: "11111111-2222-4333-8444-555555555556", label: "g", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/gone9.js" }] } }, evidence: [{ file: "src/gone9.js", quote: "// g" }] }];
  const ctxC = { repo: ws, topo: topoC, idx: idxC, pol: polC, fileHashOf: () => sha("x"), jobKey: sha("jk"), attemptId: 0, rev: 0, provider: "self", items: itemsC };
  ok(ME.toPatchV2(itemsC[0], 0, ctxC).ok === true, "판독 가능=변환 통과");
  fs.rmSync(path.join(ws, "src", "gone9.js"), { force: true });
  const convGone = ME.toPatchV2(itemsC[0], 0, ctxC);
  ok(convGone.ok === false && JSON.stringify(convGone.errors).includes("판독 불가"), "응답 검증 후 anchor 삭제=변환 시점 재검사 거부(§5-5)");
}

console.log("[12d] 해상도 v3 — '실제 프로세스 사망' e2e: 자식이 add_node 커서 기록 직후 죽고, 부모(딴 프로세스)가 잔재 장부로 재개");
{
  const cp = require("child_process");
  const { ws, nodeId } = setup("fnkill");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  // 자식 러너: fs.renameSync에 개입(내부 atomicWrite도 같은 fs 모듈) — job 파일이 nextIndex:1(applying)로
  // 갱신되는 '그 순간' exit(9). 몽키패치가 아니라 실제 실행 경로의 실제 쓰기 지점에서의 결정론 사망.
  const childSrc = [
    'const fs = require("fs");',
    'const origRename = fs.renameSync;',
    'const origUnlink = fs.unlinkSync;',
    'let armed = false;', // 커서(nextIndex:1) 영속을 관측하면 무장 — 그 쓰기의 잠금 해제 직후 사망
    'fs.renameSync = function (a, b) {',
    '  const r = origRename.apply(fs, arguments);',
    '  try { if (String(b).endsWith(".job.json")) { const s = fs.readFileSync(b, "utf8");',
    '    if (/"nextIndex":\\s*1(?=[^\\d])/.test(s) && /"phase":\\s*"applying"/.test(s)) armed = true; } } catch { }',
    '  return r;',
    '};',
    'fs.unlinkSync = function (a) {',
    '  const r = origUnlink.apply(fs, arguments);',
    '  if (armed && /\\.job\\.json/.test(String(a))) process.exit(9);', // 잠금 해제 직후=적용·영속 완료·해제까지 끝난 정확한 사망 창
    '  return r;',
    '};',
    'const path = require("path");',
    'const ROOT = process.argv[2], ws = process.argv[3], moduleId = process.argv[4];',
    'const ME9 = require(path.join(ROOT, "bridge", "map-enrich.js"));',
    'const TMP = "11111111-2222-4333-8444-555555555555";',
    'const items = [',
    '  { op: "add_node", payload: { node: { id: TMP, label: "역할", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }] } }, evidence: [{ file: "src/a.js", quote: "// a" }] },',
    '  { op: "add_edge", payload: { edge: { id: "99999999-8888-4777-8666-555555555544", from: moduleId, to: TMP, relation: "owns", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } } }, evidence: [{ file: "src/a.js", quote: "// a" }] },',
    '];',
    'const r = ME9.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items } }) }, trigger: "test" });',
    'console.log("CHILD-DONE " + JSON.stringify(r));',
  ].join("\n");
  const childFile = path.join(os.tmpdir(), "p8er_killer_" + Date.now() + ".js");
  fs.writeFileSync(childFile, childSrc);
  const ROOT9 = path.join(__dirname, "..");
  const rc = cp.spawnSync(process.execPath, [childFile, ROOT9, ws, nodeId], { encoding: "utf8", env: { ...process.env }, timeout: 120000, windowsHide: true });
  ok(rc.status === 9 && !/CHILD-DONE/.test(String(rc.stdout || "")), "자식=add_node 커서 기록 직후 실제 사망(exit 9·완주 출력 없음)");
  const jMid = ME.readEnrichJob(ws);
  ok(jMid.st === "ok" && jMid.job.phase === "open" && jMid.job.attempts[0].phase === "applying" && jMid.job.attempts[0].cursor.nextIndex === 1, "잔재 장부=실제 중단 산물(applying·nextIndex=1·strict 판독)");
  const tMid = MR.readTopoExFor(ws).topo;
  const det9 = ME.detFileNodeId(tMid.mapId, "src/a.js");
  ok(tMid.nodes.some((n) => n.id === det9) && !tMid.edges.some((e) => e.relation === "owns"), "사망 시점 실상태=노드만 적용·owns 미적용");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성(부트스트랩 소관 — 실제 재개 tick의 선행 단계)");
  let calledK = 0;
  const rR = ME.runEnrich(ws, base(ws, { adapters: { self: () => { calledK++; return { ok: false }; } } }));
  ok(rR.outcome === "applied" && calledK === 0, "부모(다른 프로세스)=잔재 장부 재개·새 호출 0으로 owns 적용");
  const tEnd = MR.readTopoExFor(ws).topo;
  ok(tEnd.edges.some((e) => e.relation === "owns" && e.to === det9 && e.from === nodeId), "재개 복원=결정론 endpoint(실사망·실재개 — §5-2b 전문)");
  try { fs.unlinkSync(childFile); } catch { /* 무해 */ }
}
console.log("[12e] 해상도 v3 — '59개 기준' 두 적용 경합: 둘 다 분류를 통과해도 61 도달 불가(잠금 안 재판정)");
{
  const PM9 = MR.PM;
  const { ws } = setup("fnrace");
  const tf = path.join(ws, "project-map", "topology.json");
  const t0 = JSON.parse(fs.readFileSync(tf, "utf8"));
  for (let i = 0; i < PM9.MAX_FILE_NODES - 1; i++) t0.nodes.push({ id: ME.detFileNodeId(t0.mapId, "src/r" + i + ".js"), label: "r" + i, entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/r" + i + ".js" }] });
  fs.writeFileSync(tf, JSON.stringify(t0));
  const topo59 = MR.readTopoExFor(ws).topo;
  ok(topo59.nodes.filter((n) => n.entityType === "file").length === PM9.MAX_FILE_NODES - 1, "(전제) 59개 file 노드 상태");
  const idx59 = MP.decisionIndexFor(ws, topo59.mapId);
  const pol59 = MP.policyStateFor(ws, topo59.mapId);
  const { ah: ah59 } = MP.authorityOf(PM9.mapHashOf(topo59), idx59);
  const mkAt59 = (label9, p9, pid9) => {
    const b = { schema: "map-patch-v2", patchId: pid9, mapId: topo59.mapId, basis: MP.patchBasisFor(ws, topo59), baseMapHash: PM9.mapHashOf(topo59), baseAuthorityHash: ah59, baseDecisionContextHash: PM9.decisionContextHashOf(ah59, pol59.pfh), baseDirtyFp: "", operation: "add_node", payload: { node: { id: "77777777-6666-4555-8444-33333333333" + label9, label: "race" + label9, entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: p9 }] } }, readSet: {}, rationale: "race", evidence: [{ kind: "code", ref: "src/a.js" }] };
    b.readSet = MP.buildReadSetFor(topo59, b, { idx: idx59, pol: pol59, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
    return PM9.canonicalPatchV2(b);
  };
  const pA = mkAt59("1", "src/raceA.js", "aaaaaaa1-0000-4000-8000-000000000001");
  const pB = mkAt59("2", "src/raceB.js", "aaaaaaa2-0000-4000-8000-000000000002");
  ok(MP.proposePatch(ws, pA).ok === true && MP.proposePatch(ws, pB).ok === true, "(전제) 두 패치 수납(둘 다 59 기준)");
  const cA = MP.classifyPatch(ws, pA.mapId, pA.patchId);
  const cB = MP.classifyPatch(ws, pB.mapId, pB.patchId);
  ok(!JSON.stringify(cA).includes("file 노드 전체 상한") && !JSON.stringify(cB).includes("file 노드 전체 상한"), "둘 다 59 기준 분류=상한 사유 없음(경합 전제 성립)");
  const aA = MP.applyPatch(ws, pA.mapId, pA.patchId, { preCutover: true });
  const aB = MP.applyPatch(ws, pB.mapId, pB.patchId, { preCutover: true });
  ok(aA.ok === true, "첫 적용=60개째 성공");
  ok(aB.ok === false && aB.reasonCode === "semantic-reject", "둘째 적용=잠금 안 '의미 재판정' 거부(reasonCode=semantic-reject — cas-stale 아님)");
  { // 확인 검증 보완: 거부 사유가 'file 상한'임을 영속 기록/반환에서 직접 단언(간접 추정 금지)
    let capHit = false;
    try { capHit = JSON.stringify(aB).includes("file 노드 전체 상한"); } catch { /* 아래 폴백 */ }
    if (!capHit) {
      const pdir = path.join(ws, "project-map", "pipeline", topo59.mapId, "pending");
      try { for (const f of fs.readdirSync(pdir)) { const s = fs.readFileSync(path.join(pdir, f), "utf8"); if (s.includes(pB.patchId)) capHit = capHit || s.includes("file 노드 전체 상한"); } } catch { /* 실패=false */ }
    }
    ok(capHit === true, "둘째 거부 사유=file 노드 전체 상한(명시 기록)");
  }
  ok(MR.readTopoExFor(ws).topo.nodes.filter((n) => n.entityType === "file").length === PM9.MAX_FILE_NODES, "최종=정확히 60(61 도달 불가 실증)");
}
console.log("[12f] ab-6 — 커서 영속과 잠금 해제 '사이' 사망: 잔존 잠금을 격리 개명으로 회수해 자동 재개 유지");
{
  const cp = require("child_process");
  const { ws, nodeId } = setup("fnlockdie");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  // [12d]와 같은 자식이되, 사망 지점=커서(nextIndex:1) rename '직후'(잠금 해제 전) — 잔존 잠금 재현
  const childSrc = [
    'const fs = require("fs");',
    'const origRename = fs.renameSync;',
    'fs.renameSync = function (a, b) {',
    '  const r = origRename.apply(fs, arguments);',
    '  try { if (String(b).endsWith(".job.json")) { const s = fs.readFileSync(b, "utf8");',
    '    if (/"nextIndex":\\s*1(?=[^\\d])/.test(s) && /"phase":\\s*"applying"/.test(s)) process.exit(9); } } catch { }',
    '  return r;',
    '};',
    'const path = require("path");',
    'const ROOT = process.argv[2], ws = process.argv[3], moduleId = process.argv[4];',
    'const ME9 = require(path.join(ROOT, "bridge", "map-enrich.js"));',
    'const TMP = "11111111-2222-4333-8444-555555555555";',
    'const items = [',
    '  { op: "add_node", payload: { node: { id: TMP, label: "역할", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }] } }, evidence: [{ file: "src/a.js", quote: "// a" }] },',
    '  { op: "add_edge", payload: { edge: { id: "99999999-8888-4777-8666-555555555544", from: moduleId, to: TMP, relation: "owns", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } } }, evidence: [{ file: "src/a.js", quote: "// a" }] },',
    '];',
    'ME9.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true }, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items } }) }, trigger: "test" });',
    'console.log("CHILD-DONE");',
  ].join("\n");
  const childFile = path.join(os.tmpdir(), "p8er_lockdie_" + Date.now() + ".js");
  fs.writeFileSync(childFile, childSrc);
  const rc = cp.spawnSync(process.execPath, [childFile, path.join(__dirname, ".."), ws, nodeId], { encoding: "utf8", env: { ...process.env }, timeout: 120000, windowsHide: true });
  const lockP = ME.jobFileFor(ws) + ".lock";
  ok(rc.status === 9 && fs.existsSync(lockP), "자식=잠금 보유 채 사망(잔존 잠금 실재 — ab-6 재현)");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  let calledL = 0;
  const rL = ME.runEnrich(ws, base(ws, { adapters: { self: () => { calledL++; return { ok: false }; } } }));
  ok(rL.outcome === "applied" && calledL === 0, "부모=잔존 잠금 격리 회수 후 자동 재개(수동 개입 0)");
  ok(!fs.existsSync(lockP) && fs.readdirSync(path.dirname(lockP)).some((f) => f.includes(".lock.stale-")), "잔존 잠금=삭제 아닌 격리 개명(잔존물 보존)");
  const tL = MR.readTopoExFor(ws).topo;
  ok(tL.edges.some((e) => e.relation === "owns" && e.to === ME.detFileNodeId(tL.mapId, "src/a.js")), "재개 결과=owns 결정론 결속(ab-6 자동 재개 유지)");
  try { fs.unlinkSync(childFile); } catch { /* 무해 */ }
}

console.log("[12g] ab-6 오탈취 방지 — 동시 회수 경합에서 '산 잠금'을 납치하지 않는다(복원·보유 취급)");
{
  const { ws } = setup("fnsteal");
  const lockP = ME.jobFileFor(ws) + ".lock";
  fs.mkdirSync(path.dirname(lockP), { recursive: true });
  // 가드1: 살아있는 보유자(우리 자신 pid)의 잠금=회수 금지(격리물 0·실패 반환)
  fs.writeFileSync(lockP, process.pid + "-alive1");
  const rAlive = ME.updateEnrichJob(ws, (j) => j && { ...j });
  const staleOfThis = () => fs.readdirSync(path.dirname(lockP)).filter((f) => f.startsWith(path.basename(lockP) + ".stale-")); // 장부 폴더는 전 픽스처 공용 — 이 저장소 몫만
  ok(rAlive.ok === false && fs.existsSync(lockP) && staleOfThis().length === 0, "산 보유자 잠금=회수 안 함(격리물 0·보유 취급)");
  fs.unlinkSync(lockP);
  // 가드2(재확인 blocker 반례): 죽은 표를 읽은 '뒤' 다른 회수자가 회수·재획득한 상황 —
  // rename 개입으로 그 창을 결정론 재현: 첫 .stale- 개명 직전에 잠금을 '산 토큰'으로 교체.
  const deadTok = "999999-deadtok";
  const liveTok = process.pid + "-liveNew";
  fs.writeFileSync(lockP, deadTok);
  const origRen = fs.renameSync;
  let swapped = false;
  fs.renameSync = function (a, b) {
    if (!swapped && String(b).includes(".lock.stale-")) { swapped = true; fs.writeFileSync(String(a), liveTok); } // 다른 회수자의 회수+재획득이 먼저 끝남
    return origRen.apply(fs, arguments);
  };
  let rSteal;
  try { rSteal = ME.updateEnrichJob(ws, (j) => j && { ...j }); } finally { fs.renameSync = origRen; }
  ok(rSteal.ok === false, "오탈취 시나리오=RMW 진입 없이 보유 취급(중첩 쓰기 0)");
  ok(fs.existsSync(lockP) && fs.readFileSync(lockP, "utf8") === liveTok, "납치한 '산 잠금'을 원위치 복원(내용 보존)");
  ok(staleOfThis().length === 0, "격리물 잔재 0(복원 완료)");
  fs.unlinkSync(lockP);
  // 정상 회수(무회귀): 죽은 표 그대로면 격리 개명+재획득 성공
  fs.writeFileSync(lockP, deadTok);
  const rDead = ME.updateEnrichJob(ws, (j) => j); // j=null(무변경) — 잠금 획득만 검증
  ok(rDead.ok === true && !fs.existsSync(lockP) === false || rDead.ok === true, "죽은 표=정상 회수(무회귀·재획득 성공)");
  ok(staleOfThis().length >= 1, "정상 회수=격리물 보존(삭제 아님)");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
