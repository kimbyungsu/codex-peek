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

console.log("[3-1] 자동 재시도 1회 — 답이 거부돼 멈춘 건은 스스로 한 번 더 물어본다(사용자 결정 2026-08-04)");
{
  const ws = setup("autoretry");
  const nodeId = MR.readTopoExFor(ws).topo.nodes[0].id;
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "precision" });
  let calls = 0;
  // 근거 인용이 파일과 맞지 않는 답 → 결과 거부 → precision-failed park(사용자가 겪은 그 상태)
  const bad = () => { calls++; return { ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n1" } }, evidence: [{ file: "src/a.js", quote: "이 문장은 파일에 없다" }] },
  ] } }; };
  const opt = base(ws, { mode: "precision", adapters: { precision: bad } });
  const r1 = ME.runEnrich(ws, opt);
  const j1 = ME.readEnrichJob(ws).job;
  ok(r1.outcome === "parked" && r1.reason === "precision-failed" && j1.phase === "parked", "전제: 답 거부로 보류(precision-failed)");
  ok(calls === 1 && !Number.isInteger(j1.retryFrom), "전제: 1회 호출·재시도 한도 미사용");
  const r2 = ME.runEnrich(ws, opt);
  const j2 = ME.readEnrichJob(ws).job;
  ok(calls === 2, "같은 입력이라도 자동으로 한 번 더 물어본다(사람 개입 없이)");
  ok(Number.isInteger(j2.retryFrom), "재시도 한도 소모 기록(retryFrom)");
  const r3 = ME.runEnrich(ws, opt);
  const r4 = ME.runEnrich(ws, opt);
  ok(calls === 2, "한도 소진 후 자동 호출 0(무한 재과금 차단)");
  ok(r3.outcome === "noop" && r3.reason === "parked" && r4.reason === "parked", "그 이후는 보류 유지(명시 재시도만)");
  ok(evOf(ws).filter((x) => !x.ack).length === 1, "멈춘 사실은 경보로 계속 보인다(최신 1건)");
}

console.log("[3-1a] 첫 경보를 확인해도, 자동 재시도가 또 실패하면 새 경보가 남는다(확인 검증 blocker)");
{
  const ws = setup("ackthenfail");
  const nodeId = MR.readTopoExFor(ws).topo.nodes[0].id;
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "precision" });
  const bad = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n1" } }, evidence: [{ file: "src/a.js", quote: "이 문장은 파일에 없다" }] },
  ] } });
  const opt = base(ws, { mode: "precision", adapters: { precision: bad } });
  ME.runEnrich(ws, opt); // 1차 보류 → 경보
  const first = evOf(ws).filter((x) => !x.ack);
  ok(first.length === 1, "전제: 첫 경보 1건");
  CL.ackIntegrityEvents(first.map((x) => x.id)); // 사용자가 확인 처리
  ok(evOf(ws).filter((x) => !x.ack).length === 0, "전제: 확인 처리로 열린 경보 0");
  ME.runEnrich(ws, opt); // 자동 재시도 → 또 거부 → 재개 경로에서 park
  ok(evOf(ws).filter((x) => !x.ack).length === 1, "자동 재시도 실패도 새 경보를 남긴다(재개 경로 park 포함)");
  ok(ME.readEnrichJob(ws).job.phase === "parked", "상태는 보류로 유지");
}

console.log("[3-1c] 호출 자체가 실패한 건은 자동 재시도 대상이 아니다(답이 없었던 실패)");
{
  const ws = setup("callfail");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: false, paidMode: "precision" });
  let calls = 0;
  const dead = () => { calls++; return { ok: false, detail: "spawn 실패" }; }; // 호출 단계 실패
  const opt = base(ws, { mode: "precision", adapters: { precision: dead } });
  const r1 = ME.runEnrich(ws, opt);
  ok(r1.outcome === "parked" && calls === 1, "전제: 호출 실패로 보류(1회 호출)");
  const att = ME.readEnrichJob(ws).job.attempts.slice(-1)[0];
  ok(att && att.failureStage === "call", "전제: 실패 단계=call(답이 도착하지 않음)");
  ME.runEnrich(ws, opt);
  ME.runEnrich(ws, opt);
  ok(calls === 1, "호출 단계 실패는 자동 재호출 0(사용자가 정한 범위 밖·환경 문제일 공산)");
}

console.log("[3-1b] 입력·설정 문제는 자동 재시도 대상이 아니다(다시 물어도 같은 결과)");
{
  const ws = setup("noretry");
  let calls = 0;
  const adapter = () => { calls++; return { ok: true, result: { schema: "enrich-result-v1", items: [] } }; };
  const r1 = ME.runEnrich(ws, base(ws, { adapters: { self: adapter } })); // 동의 없음 → park(no-consent)
  ok(r1.outcome === "parked" && r1.reason === "no-consent", "전제: 동의 없음으로 보류");
  const r2 = ME.runEnrich(ws, base(ws, { adapters: { self: adapter } }));
  ok(calls === 0 && r2.outcome === "parked" && r2.reason === "no-consent", "동의 없음은 자동 재시도 없음(호출 0)");
}

console.log("[4] 발동 게이트 — 보류라도 새 입력이면 실행기에 기회를 준다(컴파일 산출물 실행)");
{
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf("function shouldSpawnWhenParked(");
  const e = outSrc.indexOf("\nfunction ", b + 10);
  ok(b > 0 && e > b, "컴파일 산출물에서 판단 함수 추출 가능");
  const consts = "const PARKED_RECHECK_MS = 30 * 60 * 1000;\n";
  const should = new Function(consts + outSrc.slice(b, e) + "\nreturn shouldSpawnWhenParked;")();
  const T0 = 1_700_000_000_000;
  // ① 새 지도 세대 = 즉시 통과(시간 무관)
  ok(should("map-A", "map-B", T0, T0 + 1000) === true, "지도 세대가 다르면 즉시 통과(방금 재판단했어도)");
  // ② 같은 세대: 첫 진입은 통과, 곧바로 다시 오면 차단, 주기가 지나면 다시 통과
  ok(should("map-A", "map-A", undefined, T0) === true, "같은 세대 첫 진입=통과(재판단 기회)");
  ok(should("map-A", "map-A", T0, T0 + 60_000) === false, "같은 세대 직후 반복=차단(spawn 폭주 금지)");
  ok(should("map-A", "map-A", T0, T0 + 30 * 60 * 1000) === true, "주기 경과 후 재판단 기회(같은 지도에 새 결정이 붙은 경우 — 영구 사각지대 금지)");
  // ★확인 검증 blocker 재현 반례★: 첫 tick이 기회를 소모해도, 이후 authority만 바뀐 입력이 영구 차단되면 안 된다
  ok(should("map-A", "map-A", T0, T0 + 29 * 60 * 1000) === false && should("map-A", "map-A", T0, T0 + 31 * 60 * 1000) === true, "첫 진입 소모 후에도 시간이 지나면 반드시 다시 열린다(구 '창당 1회' 표지 회귀 반례)");
  // 큐 판독 실패(빈 문자열)=세대 비교 불가 → 시간 기준만 적용(과도 통과 금지)
  ok(should("map-A", "", T0, T0 + 60_000) === false && should("map-A", "", T0, T0 + 31 * 60 * 1000) === true, "큐 판독 실패=시간 기준만(무조건 통과 아님)");

  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/shouldSpawnWhenParked\(String\(jr9\.job\.mapId \|\| ""\), qMapId, parkedRecheckAt\.get\(repo9\), Date\.now\(\)\)/.test(ext), "게이트가 그 판단 함수를 실제로 사용");
  ok(/parkedRecheckAt\.set\(repo9, Date\.now\(\)\)/.test(ext), "통과 시 재판단 시각 갱신");
  ok(!/phase === "parked" && !trigger\.startsWith\("link:"\)\) return;/.test(ext), "무조건 차단(구 계약) 잔재 0");
  // 실행기 쪽 계약(같은 jobKey만 보류 유지)이 그대로인지 — 게이트 완화의 안전 근거
  const me = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  ok(/if \(j\.jobKey === jobKey && j\.phase === "parked"\)/.test(me), "실행기는 같은 입력(jobKey)일 때만 보류 유지 — 재과금 차단 불변");
}

console.log("[5] 경보 갈아끼우기는 원자적 — 삭제만 되고 추가가 실패하는 창이 없다");
{
  const cl = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  ok(/function appendIntegrityEvent\(ev, opts\)/.test(cl) && /opts\.supersedeSameKindWs/.test(cl), "한 잠금 안에서 대체+추가를 수행하는 옵션 실재");
  const me = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  const notifyBlk = me.slice(me.indexOf("function notifyEnrichParked("), me.indexOf("function jobKeyOf("));
  ok(/\{ supersedeSameKindWs: true \}/.test(notifyBlk) && !/supersedeIntegrity/.test(notifyBlk), "통지 헬퍼는 별도 supersede 호출 없이 원자 옵션만 사용");
  { const pb = me.slice(me.indexOf("const park = (jobMut, reason, extra)"), me.indexOf("// ⓪ 게이트 최선행")); ok(pb.includes("notifyEnrichParked("), "신규 보류 경로가 통지 헬퍼 사용"); }
  ok(/const wrappedPark = [\s\S]{0,260}notifyEnrichParked\(/.test(me), "재개(자동 재시도) 경로의 보류도 통지 헬퍼 사용 — 경보 유실 창 0");
  // 실제 동작: 같은 ws 반복 기록은 1건 유지, 다른 ws는 보존, ack된 건 보존
  const wsX = "D:/atomic-x", wsY = "D:/atomic-y";
  CL.appendIntegrityEvent({ ts: new Date().toISOString(), workspace: wsY, kind: "enrich-parked", severity: "warning", detail: "다른 프로젝트" }, { supersedeSameKindWs: true });
  CL.appendIntegrityEvent({ ts: new Date().toISOString(), workspace: wsX, kind: "enrich-parked", severity: "warning", detail: "1차" }, { supersedeSameKindWs: true });
  CL.appendIntegrityEvent({ ts: new Date().toISOString(), workspace: wsX, kind: "enrich-parked", severity: "warning", detail: "2차" }, { supersedeSameKindWs: true });
  const openX = CL.readIntegrityEvents().filter((e) => !e.ack && e.kind === "enrich-parked" && CL.normWs(e.workspace || "") === CL.normWs(wsX));
  ok(openX.length === 1 && /2차/.test(openX[0].detail || ""), "같은 프로젝트 반복=최신 1건만");
  ok(CL.readIntegrityEvents().some((e) => !e.ack && CL.normWs(e.workspace || "") === CL.normWs(wsY)), "다른 프로젝트 경보는 보존");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
