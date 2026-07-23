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
    ok(r.outcome === "applied", "reject=patch 폐기 후 item 종결(전 item 소화=job done)");
    ok(vCalls === 1, "Verifier 호출 정확 1회(해소 레코드 영속 — 3b 1차 blocker③)");
    const t2 = MR.readTopoExFor(ws).topo;
    ok(t2.nodes.find((n) => n.id === nodeId).label === lbl, "reject된 변경은 미반영(라벨 불변)");
    const jR = ME.readEnrichJob(ws).job;
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

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
