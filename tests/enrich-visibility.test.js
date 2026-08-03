/*
 * 자동 보강이 스스로 멈췄을 때의 '가시성·자동 재개'(2026-08-04 사용자 실보고 봉합):
 *  ① 멈추면 무결성 경보(노랑)를 남겨 상태바·대시보드에서 보이게 한다(대시보드 특정 줄을 열어야만
 *     아는 상태 = 사용자가 인지 불가 → 자동화 철학 위배).
 *  ② 완주하면 그 경보를 대체(해소)한다 — 멈춤을 알렸으면 풀림도 알린다.
 *  ③ 확장의 발동 게이트가 '보류'만 보고 무조건 막지 않는다: 지도 세대가 바뀌면 즉시 통과시켜
 *     실행기가 새 작업을 열 기회를 준다(같은 입력 재과금은 실행기 jobKey 비교가 그대로 막는다).
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "envis_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MB = require("../bridge/map-bootstrap.js");
const ME = require("../bridge/map-enrich.js");
const PM = MR.PM;

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

function setup(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "envis_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const r = MR.initTopologyForBootstrap(ws);
  if (r.st !== "created") throw new Error("init 실패: " + r.st);
  MB.ensureQueue(ws, PM);
  return ws;
}
const base = (ws, over) => Object.assign({ ws, slot: "ko", mode: "self", trigger: "test", adapters: {}, readiness: { selfReady: true, economyReady: true, precisionReady: true, autoReady: true } }, over || {});
const evOf = (ws) => CL.readIntegrityEvents().filter((e) => e.kind === "enrich-parked" && CL.normWs(e.workspace || "") === CL.normWs(ws));

console.log("[1] 멈추면 경보를 남긴다 — 상태바·대시보드에서 보이는 채널");
{
  const ws = setup("park");
  const before = evOf(ws).length;
  const r = ME.runEnrich(ws, base(ws, {})); // 동의 없음 → park(no-consent)
  ok(r.outcome === "parked", "전제: 보류로 끝남(" + r.reason + ")");
  const evs = evOf(ws);
  ok(evs.length === before + 1, "보류 시 무결성 경보 1건 기록");
  const e = evs[evs.length - 1];
  ok(e.severity === "warning" && e.ack === false, "노랑(경고)·미확인 상태로 남음");
  ok(/지도 자동 보강이 멈췄습니다/.test(e.detailKo || "") && /사유: no-consent/.test(e.detailKo || ""), "ko 문구+사유 포함");
  ok(/Map auto-enrichment stopped/.test(e.detailEn || "") && /reason: no-consent/.test(e.detailEn || ""), "en 문구+사유 포함(양언어)");
  ok(/자동 보강' 줄에서 원인과 다시 시도를 확인/.test(e.detailKo || ""), "어디서 무엇을 하면 되는지 안내 포함");
  // 반복 보류가 노랑을 쌓지 않는다(최신 1건만)
  ME.runEnrich(ws, base(ws, {}));
  ME.runEnrich(ws, base(ws, {}));
  const open = evOf(ws).filter((x) => !x.ack);
  ok(open.length === 1, "반복 보류에도 열린 경보는 최신 1건(누적 노랑 방지)");
}

console.log("[2] 다른 프로젝트의 경보는 건드리지 않는다(창 격리)");
{
  const wsA = setup("isoA"); const wsB = setup("isoB");
  ME.runEnrich(wsA, base(wsA, {}));
  ME.runEnrich(wsB, base(wsB, {}));
  ok(evOf(wsA).filter((x) => !x.ack).length === 1 && evOf(wsB).filter((x) => !x.ack).length === 1, "프로젝트별로 각각 1건(대체가 남의 것을 지우지 않음)");
}

console.log("[3] 완주하면 그 경보를 해소한다 — 멈춤을 알렸으면 풀림도 알린다");
{
  const ws = setup("done");
  const topo = MR.readTopoExFor(ws).topo;
  const nodeId = topo.nodes[0].id;
  ME.runEnrich(ws, base(ws, {})); // 먼저 보류 경보를 만든다
  ok(evOf(ws).filter((x) => !x.ack).length === 1, "전제: 열린 보류 경보 1건");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const adapter = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n1" } }, evidence: [{ file: "src/a.js", quote: "// a" }] },
  ] } });
  const r = ME.runEnrich(ws, base(ws, { adapters: { self: adapter } }));
  ok(r.outcome === "applied" || r.outcome === "settled", "전제: 완주(" + r.outcome + ")");
  ok(evOf(ws).filter((x) => !x.ack).length === 0, "완주 시 열린 보류 경보 0(대체로 해소)");
}

console.log("[4] 발동 게이트 — 보류라도 '지도 세대가 바뀌면' 실행기에 기회를 준다");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  const blk = ext.slice(ext.indexOf('if (jr9.st === "ok" && jr9.job.phase === "parked" && !trigger.startsWith("link:"))'), ext.indexOf("enrichSpawnBusy = true;"));
  ok(blk.length > 0, "게이트 블록 추출");
  ok(/q\.mapId \|\| ""\) === String\(jr9\.job\.mapId \|\| ""\)/.test(blk), "큐의 지도 세대와 보류 당시 세대를 비교(다르면 통과)");
  ok(/if \(sameGen\) \{[\s\S]{0,200}parkedRecheckDone\.has\(repo9\)\) return;/.test(blk), "같은 세대는 창당 1회만 재판단 기회(반복 spawn 금지)");
  ok(/const parkedRecheckDone = new Set<string>\(\);/.test(ext), "재판단 기회 기록 집합 실재");
  ok(!/phase === "parked" && !trigger\.startsWith\("link:"\)\) return;/.test(ext), "무조건 차단(구 계약) 잔재 0");
  // 실행기 쪽 계약(같은 jobKey만 보류 유지)이 그대로인지 — 게이트 완화의 안전 근거
  const me = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  ok(/if \(j\.jobKey === jobKey && j\.phase === "parked"\)/.test(me), "실행기는 같은 입력(jobKey)일 때만 보류 유지 — 재과금 차단 불변");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
