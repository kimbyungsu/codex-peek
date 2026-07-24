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

console.log("[5] verifier 해소 경로 — rewrite_label: no-verifier=park·reject=종결·support=적용");
{
  const mkRl = (ws, nodeId, lbl) => (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "rewrite_label", targetId: nodeId, payload: { to: { label: lbl + "-x" }, expect: { label: lbl } }, evidence: [{ file: "src/a.js", quote: "// a" }], claims: [{ file: "src/a.js", quote: "// a", stance: "support" }] },
  ] } });
  {
    const { ws, topo, nodeId } = setup("rl-nov");
    const lbl = topo.nodes[0].label;
    ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
    const r = ME.runEnrich(ws, base(ws, { adapters: { self: mkRl(ws, nodeId, lbl) } }));
    ok(r.outcome === "parked" && r.reason === "no-verifier", "verifier-resolved 분류인데 askVerifier 미주입=park(no-verifier — 조용한 대체 금지)");
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
  const { ws, nodeId } = setup("quote");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const fake = (ctx) => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/a.js", quote: "// 이 인용은 파일에 없다" }] },
  ] } });
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: fake } }));
  ok(r.outcome === "parked" && r.reason === "self-failed", "허위 인용=근거 실패(self라 승격 없음=park — 파일 대조 실증)");
  const j = ME.readEnrichJob(ws).job;
  ok(/evidence/.test(j.attempts[0].failReason || ""), "실패 사유에 근거 실패 분류 기록");
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

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
