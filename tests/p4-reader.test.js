"use strict";
/*
 * P4 증분 3 — 공용 reader·유도 판정기·slice 동봉·게이트 준비(설계 동결 v8 P4-1·3·4·5 테스트 목록의 증분 3 소유분).
 * 계약: reader 소스 합타입(v2/legacy/none/blocked/error[lock])·blocked=legacy 폴백 금지·effective/degraded 분리 /
 * 판정기: 두 축(anchor 기준선·evidence 실대조)·anchor만 수정=stale·기준선 세대 결속·untracked/치환 반례·
 * provenance 부재=unknown·경계 이탈=unknown+저장소 밖 판독 0·reader는 기준선(a:) 절대 미기록 /
 * attach: 2트랙=null(reader 미호출)·비v2=기존 buildScoutAttach 바이트 동일 위임·v2 envelope {text,mapItems,couplings} /
 * 게이트(비활성 준비): no-map/unknown(fail-open)/미연결=stale/clean 전체 집계(stale edge 단독=stale)/혼합=unknown /
 * manifest: P4 표면 2개 ready+activation=P3b.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p4rd_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const MF = require(path.join(ROOT, "bridge", "map-freshness.js"));
const MP = require(path.join(ROOT, "bridge", "map-pipeline.js"));
const MB = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
const RD = require(path.join(ROOT, "bridge", "map-reader.js"));
const AD = require(path.join(ROOT, "bridge", "map-adapters.js"));
const MBD = require(path.join(ROOT, "bridge", "map-bindings.js"));
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");

function mkWs(tag, files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p4rd_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  for (const [rel, txt] of Object.entries(files || {})) fs.writeFileSync(path.join(ws, rel), txt);
  fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  if (MR.initTopologyForBootstrap(ws).st !== "created") throw new Error("init 실패");
  return ws;
}
function applyOp(ws, targetId, operation, payload, evidenceRef) { // 실 파이프라인 전이(provenance·기준선·decision 생성)
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const patch = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
    baseDirtyFp: "", operation, targetId, payload, readSet: {},
    rationale: "test", evidence: [{ kind: "code", ref: evidenceRef || "src/a.js" }],
  };
  if (patch.targetId === null || patch.targetId === undefined) delete patch.targetId; // 생성 op=targetId 금지(스키마)
  patch.readSet = MP.buildReadSetFor(topo, patch, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
  const pr = MP.proposePatch(ws, patch);
  const cl = MP.classifyPatch(ws, patch.mapId, patch.patchId);
  const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
  if (!ap.ok) ap.error = (ap.error || "") + " | propose=" + JSON.stringify(pr) + " classify=" + JSON.stringify(cl);
  return ap;
}
function mkV2Authority(ws) { // P3b cutover 산출물을 규격대로 수동 구성(테스트 전용 — authorityStateFor=v2 유도)
  const topo = MR.readTopoExFor(ws).topo;
  const did = crypto.randomUUID();
  const ts = new Date().toISOString();
  const ao = { cutover: true, decisionRef: did, mapId: topo.mapId, schema: "map-authority-v1", ts };
  const aoText = JSON.stringify(ao, null, 1);
  const receipt = {
    authorityFileFp: sha(aoText), authorityMode: { from: "legacy", to: "v2" }, authorityObject: ao,
    decisionId: did, mapId: topo.mapId, schema: "map-cutover-receipt-v1", ts,
  };
  const dir = path.join(ws, "project-map", "authority-history");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, did + ".json"), JSON.stringify(receipt, null, 1), "utf8");
  fs.writeFileSync(path.join(ws, "project-map", "authority.json"), aoText, "utf8");
}

console.log("[1] reader 소스 합타입 — legacy/none/blocked/error(lock)·v2");
{
  // none: 3트랙 켰지만 legacy 확정층(docs/MAP.md)도 없음
  const wsN = mkWs("none", { "src/a.js": "// a\n" });
  const pN = RD.readMapProjection(wsN);
  ok(pN.ok === true && pN.source === "none" && pN.authorityHash === null, "legacy 권위+확정층 부재=none(빈 projection·해시 null)");
  // legacy: docs/MAP.md 존재
  fs.mkdirSync(path.join(wsN, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wsN, "docs", "MAP.md"), "# MAP\n- item\n", "utf8");
  const pL = RD.readMapProjection(wsN);
  ok(pL.ok === true && pL.source === "legacy" && pL.authorityHash === null && pL.nodes.length === 0, "legacy=v2 해시 null 고정·권위 데이터 미반환(소비처 위임용)");
  // blocked: cutover 이력 존재+marker 부재 — legacy 폴백 금지
  fs.mkdirSync(path.join(wsN, "project-map", "authority-history"), { recursive: true });
  fs.writeFileSync(path.join(wsN, "project-map", "authority-history", "x.json"), "{}", "utf8");
  const pB = RD.readMapProjection(wsN);
  ok(pB.ok === false && pB.source === "blocked" && !pB.nodes, "cutover 이력+marker 부재=blocked — legacy 데이터 폴백 금지");
  fs.rmSync(path.join(wsN, "project-map", "authority-history"), { recursive: true, force: true });
  // error(lock): 정본 잠금 보유 중 — 조립하지 않고 실패 합타입
  const lockPath = path.join(process.env.CODEX_BRIDGE_HOME, "project-map-locks", CL.wsKeyFor(wsN) + ".lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, process.pid + "-held", { flag: "wx" });
  const pE = RD.readMapProjection(wsN);
  fs.unlinkSync(lockPath);
  ok(pE.ok === false && pE.source === "error" && pE.reason === "lock", "잠금 실패=error(reason=lock) — self-nesting 시나리오 동형(잠금 보유 중 public reader 호출)");
  // v2: cutover 마커 규격 구성+실 전이 1회
  const wsV = mkWs("v2", { "src/a.js": "console.log(1);\n" });
  const nid = MR.readTopoExFor(wsV).topo.nodes[0].id;
  const ap = applyOp(wsV, nid, "add_condition", { condition: "p4r" });
  ok(ap.ok === true, "(전제) 전이 성공");
  mkV2Authority(wsV);
  const pV = RD.readMapProjection(wsV);
  ok(pV.ok === true && pV.source === "v2" && /^[0-9a-f]{40}$/.test(pV.authorityHash) && /^[0-9a-f]{40}$/.test(pV.decisionContextHash), "v2=권위 서명(authorityHash·decisionContextHash) 필수");
  ok(pV.nodes.some((n) => n.id === nid && n.effectiveConfidence) && Array.isArray(pV.approved) && Array.isArray(pV.degraded), "v2 projection 필수 필드(nodes·approved·degraded)");
  // effective/degraded 분리: stored confirmed로 승격(set_state — verified-auto tier) 후 그 decision 파일을
  // 제거해 dangling 유도 → 강등은 stored confirmed에만 적용되므로(candidate는 통과가 정상 — 7차 정정) degraded로 분리
  const apS = applyOp(wsV, nid, "set_state", { to: { confidence: "confirmed" }, expect: { confidence: "candidate" } });
  ok(apS.ok === true, "(전제) confirmed 승격 전이: " + (apS.error || ""));
  const decFile = path.join(wsV, "project-map", "decisions", apS.decisionId + ".json");
  fs.renameSync(decFile, decFile + ".away");
  const pD = RD.readMapProjection(wsV);
  fs.renameSync(decFile + ".away", decFile);
  ok(pD.ok === true && pD.degraded.some((d) => d.id === nid) && !pD.nodes.some((n) => n.id === nid), "stored confirmed+dangling decision → degraded 분리(slice·P8로 새지 않음)");
  const pOk = RD.readMapProjection(wsV);
  ok(pOk.nodes.some((n) => n.id === nid && n.effectiveConfidence === "confirmed"), "(대조) decision 복원=effective confirmed 복귀");
  // 2차 blocker①: 스키마 손상 topology(파싱은 되나 검증 실패)가 v2로 승인되지 않는다
  {
    const topoFile = path.join(wsV, "project-map", "topology.json");
    const orig9 = fs.readFileSync(topoFile, "utf8");
    const broken = { mapId: JSON.parse(orig9).mapId }; // schemaVersion·nodes·edges 등 전부 결손 — validateTopology 다수 오류
    fs.writeFileSync(topoFile, JSON.stringify(broken), "utf8");
    const pX = RD.readMapProjection(wsV);
    fs.writeFileSync(topoFile, orig9, "utf8");
    ok(pX.ok === false && pX.source === "blocked" && /스키마 위반/.test(pX.reason), "손상 topology=blocked(빈 정상 지도로 위장 금지 — validateTopology 관문)");
    // 3차 blocker: 유효 JSON이지만 비객체(null·배열·원시) — 권위 대조 전에 안전 판정(예외 이탈 금지)
    for (const [tag9, raw9] of [["null", "null"], ["배열", "[]"], ["원시", "42"]]) {
      fs.writeFileSync(topoFile, raw9, "utf8");
      let pN = null, threw = false;
      try { pN = RD.readMapProjection(wsV); } catch { threw = true; }
      ok(!threw && pN && pN.ok === false && pN.source === "blocked", "topology=" + tag9 + " JSON → 예외 없이 blocked: " + (pN ? pN.reason : "(예외)"));
    }
    fs.writeFileSync(topoFile, orig9, "utf8");
  }
}

console.log("[2] 판정기 — 두 축·세대 결속·경계·반례");
{
  const ws = mkWs("fr", { "src/a.js": "console.log(1);\n" });
  const nid = MR.readTopoExFor(ws).topo.nodes[0].id;
  const ap = applyOp(ws, nid, "add_condition", { condition: "fr-1" });
  ok(ap.ok === true && ap.freshnessBaseline && ap.freshnessBaseline.ok === true, "(전제) 전이+기준선 기록");
  mkV2Authority(ws);
  const proj = RD.readMapProjection(ws);
  ok(proj.source === "v2", "(전제) v2 projection");
  let fr = RD.deriveFreshness(ws, proj);
  const fOf = (id) => fr.find((x) => x.id === id);
  ok(fOf(nid) && fOf(nid).state === "fresh", "전이 직후 두 축 불변=fresh: " + JSON.stringify(fOf(nid)));
  // anchor만 수정=stale(두 축 독립 — evidence 불변으로 fresh 오판 금지). src/a.js는 anchor이자 evidence인
  // bootstrap 구조라 분리 증명을 위해 anchor 전용 파일 시나리오 대신 '내용 치환·동일 길이+mtime 복원' 반례로.
  const aPath = path.join(ws, "src", "a.js");
  const st0 = fs.statSync(aPath);
  fs.writeFileSync(aPath, "console.log(2);\n"); // 같은 길이 치환
  fs.utimesSync(aPath, st0.atime, st0.mtime);   // mtime 복원 — stat 캐시로는 감지 불가
  fr = RD.deriveFreshness(ws, proj);
  ok(fOf(nid).state === "stale", "같은 size+mtime 내용 치환=stale(판정은 실해시 — 캐시 미신뢰 증명)");
  fs.writeFileSync(aPath, "console.log(1);\n");
  // untracked 신규 evidence… (git 없는 ws — 실대조라 git 목록 무관): 파일 복원 후 fresh 복귀
  fr = RD.deriveFreshness(ws, proj);
  ok(fOf(nid).state === "fresh", "내용 복원=fresh 복귀(HEAD·git 상태 무관 실대조)");
  // 기준선 세대 결속: 같은 mapId에서 새 decision 적용 후 옛 기준선은 무효(새 전이가 기준선 재기록 → 새 세대로 fresh)
  const ap2 = applyOp(ws, nid, "add_condition", { condition: "fr-2" });
  ok(ap2.ok === true, "(전제) 2차 전이");
  const proj2 = RD.readMapProjection(ws);
  fr = RD.deriveFreshness(ws, proj2);
  ok(fOf(nid).state === "fresh" && proj2.nodes.find((n) => n.id === nid).provenance.decisionId === ap2.decisionId, "새 전이 후 새 세대 기준선으로 fresh(세대 결속)");
  // 옛 projection(옛 decisionId 결속)으로 판정하면 기준선 세대 불일치=unknown(옛 기준선이 fresh 주장 못 함)
  fr = RD.deriveFreshness(ws, proj);
  ok(fOf(nid).state === "unknown" && /세대 불일치|기준선/.test(fOf(nid).reason), "옛 세대 projection=기준선 세대 불일치 unknown(옛 지문 재사용 금지)");
  // provenance 부재=unknown
  const bare = { ...proj2, nodes: [{ id: crypto.randomUUID(), anchors: [{ kind: "code", path: "src/a.js" }] }], edges: [] };
  fr = RD.deriveFreshness(ws, bare);
  ok(fr[0].state === "unknown" && /provenance/.test(fr[0].reason), "provenance 부재=unknown(차단 없음·표시 전용)");
  // 경계 이탈=unknown+저장소 밖 판독 0: anchor 경로를 ../ 이탈로 조작한 projection
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "p4rd_out_"));
  fs.writeFileSync(path.join(outside, "secret.js"), "s");
  const esc = { ...proj2, nodes: [{ id: nid, anchors: [{ kind: "code", path: "../" + path.basename(outside) + "/secret.js" }], provenance: proj2.nodes.find((n) => n.id === nid).provenance }], edges: [] };
  fr = RD.deriveFreshness(ws, esc);
  ok(fr[0].state === "unknown", "../ 이탈 anchor=unknown(safeRepoPathFor 거부 — 저장소 밖 stat/hash 0)");
  // reader/판정기는 기준선(a:)을 절대 쓰지 않는다 — 판정 전후 a: 엔트리 집합·바이트 불변
  const before = JSON.stringify(Object.entries(MF.readFreshnessFor(ws, proj2.mapId).entries).filter(([k]) => k.startsWith("a:")).sort());
  RD.deriveFreshness(ws, proj2);
  const after = JSON.stringify(Object.entries(MF.readFreshnessFor(ws, proj2.mapId).entries).filter(([k]) => k.startsWith("a:")).sort());
  ok(before === after, "판정기는 기준선(a:) 무기록(읽기 전용 — 최초 관측 흡수 금지)");
  ok(Object.keys(MF.readFreshnessFor(ws, proj2.mapId).entries).some((k) => k.startsWith("e:")), "e: 비권위 캐시는 기록됨(fresh 증명 비사용 재료)");
}

console.log("[3] attach — 2트랙 0·비v2 위임 바이트 동일·v2 envelope");
{
  // 2트랙: scoutMode off → null + reader 미호출(exports 경유 spy 실측 — 1차 blocker⑦의 항상참 단언 교체)
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "p4rd_2t_"));
  let readerCalls = 0;
  const origRead = RD.readMapProjection;
  RD.readMapProjection = (...a) => { readerCalls++; return origRead(...a); };
  const a2 = RD.buildMapAttach(ws2, { scoutMode: "off" }, "ko");
  RD.readMapProjection = origRead;
  ok(a2 === null && readerCalls === 0, "2트랙=출력 0+reader 미호출(spy 실측: calls=" + readerCalls + ")");
  // 비v2(legacy 지도 존재 ws): 기존 buildScoutAttach와 산출 바이트 동일(위임)
  const ws3 = mkWs("at", { "src/a.js": "// a\n" });
  const c3 = JSON.parse(fs.readFileSync(CL.contractFileFor(ws3, "ko"), "utf8"));
  const legacy = CL.buildScoutAttach(ws3, c3, "ko");
  const viaMap = RD.buildMapAttach(ws3, c3, "ko");
  ok(JSON.stringify(legacy) === JSON.stringify(viaMap), "비v2=기존 동봉 그대로 위임(산출 동일 — cutover 전 무회귀): " + (legacy === null ? "둘 다 null(지도 없음)" : "동일 envelope"));
  // (교체됨 — 위 spy 실측이 정본)
  // v2 envelope: {text, mapItems, couplings}
  const wsV = mkWs("atv2", { "src/a.js": "console.log(1);\n" });
  const nidV = MR.readTopoExFor(wsV).topo.nodes[0].id;
  applyOp(wsV, nidV, "add_condition", { condition: "at" });
  mkV2Authority(wsV);
  const cV = JSON.parse(fs.readFileSync(CL.contractFileFor(wsV, "ko"), "utf8"));
  const aV = RD.buildMapAttach(wsV, cV, "ko");
  ok(aV && typeof aV.text === "string" && Array.isArray(aV.mapItems) && Array.isArray(aV.couplings) && Object.keys(aV).sort().join(",") === "couplings,mapItems,text", "v2 slice=envelope {text,mapItems,couplings}(healthLine 별도 필드 금지)");
  ok(aV.text.includes("Project MAP"), "v2 slice 머리말(advisory 명시)");
}

console.log("[4] 게이트 준비(비활성) — 변환 규칙 단위 반례");
{
  const ws = mkWs("gt", { "src/a.js": "console.log(1);\n" });
  // projection 부재(none)=no-map
  let g = RD.mapGateAssessFor(ws);
  ok(g.prepared === true && g.active === false && g.state === "no-map", "정상 판독+projection 부재=no-map(비활성 준비 함수)");
  // blocked=unknown(무차단 fail-open)
  fs.mkdirSync(path.join(ws, "project-map", "authority-history"), { recursive: true });
  fs.writeFileSync(path.join(ws, "project-map", "authority-history", "x.json"), "{}", "utf8");
  g = RD.mapGateAssessFor(ws);
  ok(g.state === "unknown", "blocked=unknown(무차단 — 판독 실패를 차단 상태로 바꾸지 않는다)");
  fs.rmSync(path.join(ws, "project-map", "authority-history"), { recursive: true, force: true });
  // v2 구성(비-git ws — 변경 파일 판독 실패=unknown 무차단 증명)
  const nid = MR.readTopoExFor(ws).topo.nodes[0].id;
  applyOp(ws, nid, "add_condition", { condition: "gt" });
  mkV2Authority(ws);
  g = RD.mapGateAssessFor(ws);
  ok(g.state === "unknown" && /변경 파일 판독 실패/.test(g.why), "비-git 변경 판독 실패={ok:false}로 분리=unknown(clean 위장 금지)");
  ok(g.notice && typeof g.notice.ko === "string" && typeof g.notice.en === "string", "복구 안내 문구 세트 ko/en 준비(활성화는 P3b)");
  // 순수 변환 규칙: 집계 우선순위 stale>unknown>fresh — deriveFreshness 주입 대신 gitChangedEx 스텁이 어려우니
  // git 레포로 실측: git init 후 clean/변경 시나리오
  const r = require("child_process").spawnSync("git", ["-C", ws, "init", "-q"], { encoding: "utf8" });
  if (r.status === 0) {
    require("child_process").spawnSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
    require("child_process").spawnSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "t"], { encoding: "utf8" });
    g = RD.mapGateAssessFor(ws);
    ok(g.state === "fresh", "clean+두 축 불변=fresh 확정(전체 집계 실측)");
    fs.writeFileSync(path.join(ws, "unmapped.txt"), "x", "utf8");
    g = RD.mapGateAssessFor(ws);
    ok(g.state === "stale" && /미연결/.test(g.why), "변경 파일이 어느 anchor에도 미연결=stale(지도가 이 변경을 모름)");
    fs.unlinkSync(path.join(ws, "unmapped.txt"));
  } else console.log("  (skip) git 없음 — clean/미연결 반례는 CI에서");
}

console.log("[6] 경합·flap·원자성 — testHooks 실행 반례(1차 blocker⑦)");
{
  const ws = mkWs("flap", { "src/a.js": "console.log(1);\n" });
  const nid = MR.readTopoExFor(ws).topo.nodes[0].id;
  applyOp(ws, nid, "add_condition", { condition: "flap" });
  mkV2Authority(ws);
  const authFile = path.join(ws, "project-map", "authority.json");
  // flap 1회 → 재시도 성공: 첫 attempt 캡처 직후 marker 바이트 변경(파싱 의미 동일·바이트 상이 재직렬화)
  let touched = 0;
  const p1 = RD.readMapProjection(ws, { afterCapture: (att) => { if (att === 0 && touched === 0) { touched++; mkV2Authority(ws); } } }); // 캡처 직후 '정합 유지' 재-cutover(바이트 변경) — flap 감지·재시도 성공 경로
  ok(p1.ok === true && p1.source === "v2", "권위 세대 flap 1회=폐기·재시도 1회로 성공(재시도 경로 실행)");
  // 지속 flap → authority-flap 실패 합타입
  let n9 = 0;
  const p2 = RD.readMapProjection(ws, { afterCapture: () => { n9++; const m = JSON.parse(fs.readFileSync(authFile, "utf8")); fs.writeFileSync(authFile, JSON.stringify(m, null, n9 + 1), "utf8"); } }); // 매 시도 다른 바이트(원본 indent 1과도 상이) — 지속 flap
  ok(p2.ok === false && p2.source === "error" && p2.reason === "authority-flap", "지속 flap=authority-flap(재시도 1회 상한)");
  mkV2Authority(ws); // 정합 복원(마지막 쓰기가 receipt 기대 지문을 깨뜨렸을 수 있음)
  // 캡처 스냅샷 원자성: 캡처 후 topology를 다른 세대로 교체해도 반환은 캡처 세트 기준(혼합 없음)
  const topoFile = path.join(ws, "project-map", "topology.json");
  const origTopo = fs.readFileSync(topoFile, "utf8");
  const swapped = JSON.parse(origTopo); swapped.mapId = crypto.randomUUID();
  let did9 = false;
  const p3 = RD.readMapProjection(ws, { afterCapture: () => { if (!did9) { did9 = true; fs.writeFileSync(topoFile, PM.canonicalSerialize(swapped), "utf8"); } } });
  fs.writeFileSync(topoFile, origTopo, "utf8");
  ok(p3.ok === true && p3.source === "v2" && p3.mapId !== swapped.mapId, "캡처 후 topology 교체=반환은 캡처 스냅샷 기준(동시 apply 혼합 차단 동형)");
  // 디스크에 marker A·topology B가 공존하는 세대 혼합=같은 캡처 세트의 mapId 원자 대조로 blocked(1차 blocker①)
  fs.writeFileSync(topoFile, PM.canonicalSerialize(swapped), "utf8");
  const p4 = RD.readMapProjection(ws);
  fs.writeFileSync(topoFile, origTopo, "utf8");
  ok(p4.ok === false && p4.source === "blocked" && /세대/.test(p4.reason), "marker mapId≠topology mapId=blocked(v2 성공 위장 소멸)");
  // bindings 판독 실패=blocked(빈 approved 은폐 금지 — 1차 blocker③)
  fs.mkdirSync(path.dirname(MBD.bindingsFileFor(ws)), { recursive: true });
  fs.writeFileSync(MBD.bindingsFileFor(ws), "{corrupt", "utf8");
  const p5 = RD.readMapProjection(ws);
  fs.unlinkSync(MBD.bindingsFileFor(ws));
  ok(p5.ok === false && p5.source === "blocked" && /bindings/.test(p5.reason), "bindings 손상=blocked(approved 0건 위장 금지)");
  ok(typeof AD.buildMapAttach === "function" && typeof AD.mapGateAssessFor === "function", "manifest ready 함수=module.exports로 실제 호출 가능(1차 blocker④)");
  // 잠금 경쟁(2차 blocker② 후단·동결 목록): 다른 프로세스(=동시 apply와 같은 잠금)가 잠금을 짧게 보유하는
  // 동안 reader가 시작 — withFileLockStrict 재시도 창 안에서 해제되면 reader가 대기 끝에 정상 성공해야 한다.
  {
    const lockPath = path.join(process.env.CODEX_BRIDGE_HOME, "project-map-locks", CL.wsKeyFor(ws) + ".lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const child = require("child_process").spawn(process.execPath, ["-e",
      "const fs=require(String.fromCharCode(102,115));" +
      "fs.writeFileSync(process.argv[1], process.pid+String.fromCharCode(45)+String.fromCharCode(120), {flag:String.fromCharCode(119,120)});" +
      "setTimeout(()=>{ try{fs.unlinkSync(process.argv[1]);}catch{} }, 180);",
      lockPath], { stdio: "ignore" });
    const t0 = Date.now();
    while (!fs.existsSync(lockPath) && Date.now() - t0 < 2000) { /* 자식 선점 대기(바쁜 대기 — 짧음) */ }
    const pR = RD.readMapProjection(ws);
    try { child.kill(); } catch { /* 종료됨 */ }
    ok(pR.ok === true && pR.source === "v2", "잠금 경쟁 — 보유 해제 후 재시도 창 안 획득·정상 성공(대기 " + (Date.now() - t0) + "ms)");
  }
}

console.log("[7] 게이트 심화 — stale edge 단독·혼합 집계·절단(1차 blocker⑤·⑦)");
{
  const ws = mkWs("g2", { "src/a.js": "console.log(1);\n", "src/b.js": "// b\n" });
  fs.writeFileSync(path.join(ws, "src", "e.js"), "// edge-ev\n"); // init "후" 생성 — bootstrap 노드 anchors에 미포함(edge 전용 evidence·anchor축 무관)
  const nid = MR.readTopoExFor(ws).topo.nodes[0].id;
  applyOp(ws, nid, "add_condition", { condition: "g2" });
  const nb = crypto.randomUUID();
  const apB = applyOp(ws, null, "add_node", { node: { id: nb, entityType: "module", label: "B", roles: [], anchors: [{ kind: "code", path: "src/b.js" }], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } } });
  const eid = crypto.randomUUID();
  const apE = applyOp(ws, null, "add_edge", { edge: { id: eid, from: nid, to: nb, relation: "calls", evidence: [], conditions: [], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } } }, "src/e.js"); // edge decision evidence=전용 파일(src/e.js) — stale edge "단독" 구성
  ok(apB.ok === true && apE.ok === true, "(전제) node B+edge 적용: " + (apB.error || "") + (apE.error || ""));
  mkV2Authority(ws);
  const cp = require("child_process");
  cp.spawnSync("git", ["-C", ws, "init", "-q"], { encoding: "utf8" });
  cp.spawnSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
  cp.spawnSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "t"], { encoding: "utf8" });
  let g = RD.mapGateAssessFor(ws);
  ok(g.state === "fresh", "(전제) clean·전 항목 fresh: " + g.why);
  // stale edge '단독'(2차 blocker②): edge 전용 evidence(src/e.js)만 변경·커밋 — worktree clean·node들은
  // 전부 fresh인데 edge만 stale. clean 집계가 proj.edges를 빼면 이 반례가 실패한다(node stale로는 통과 불가).
  {
    const projChk = RD.readMapProjection(ws);
    const frChk = RD.deriveFreshness(ws, projChk);
    ok(frChk.filter((x) => x.kind === "node").every((x) => x.state === "fresh"), "(전제) node 전부 fresh");
  }
  fs.writeFileSync(path.join(ws, "src", "e.js"), "// edge-ev drift\n");
  cp.spawnSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
  cp.spawnSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "drift"], { encoding: "utf8" });
  {
    const projChk = RD.readMapProjection(ws);
    const frChk = RD.deriveFreshness(ws, projChk);
    ok(frChk.filter((x) => x.kind === "node").every((x) => x.state === "fresh") && frChk.some((x) => x.kind === "edge" && x.state === "stale"), "(전제) node 전부 fresh·edge만 stale — 진짜 단독: " + JSON.stringify(frChk));
  }
  g = RD.mapGateAssessFor(ws);
  ok(g.state === "stale", "clean+node 전부 fresh+edge만 stale=stale(edge 단독 반례 — edges 집계 제거 시 실패하는 구성)");
  fs.writeFileSync(path.join(ws, "src", "e.js"), "// edge-ev\n");
  cp.spawnSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
  cp.spawnSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "restore"], { encoding: "utf8" });
  g = RD.mapGateAssessFor(ws);
  ok(g.state === "fresh", "(대조) 복원 커밋=fresh 복귀");
  // fresh+unknown 혼합=unknown(무차단): B의 기준선 엔트리를 외부 손실로 재현(a: 제거) — anchor축 unknown
  {
    const f = MF.freshnessFileFor(ws);
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const k of Object.keys(d.entries)) if (k.startsWith("a:" + nb + "|")) delete d.entries[k];
    fs.writeFileSync(f, JSON.stringify(d), "utf8");
    g = RD.mapGateAssessFor(ws);
    ok(g.state === "unknown", "fresh+unknown 혼합=unknown(무차단 — stale 아님·fresh 주장도 금지): " + g.why);
  }
  // 절단 반례: gitChangedEx 스텁 — truncated면 전 항목 fresh여도 fresh 주장 금지
  const orig = RD.gitChangedEx;
  RD.gitChangedEx = () => ({ ok: true, paths: [], truncated: true });
  g = RD.mapGateAssessFor(ws);
  RD.gitChangedEx = orig;
  ok(g.state === "unknown" && /절단/.test(g.why), "변경 목록 절단=fresh 주장 금지 unknown(false-fresh 차단·무차단)");
  // v2 slice edge 동봉(1차 blocker⑥): 변경 연결 slice에 [edge] 라인 실림
  fs.writeFileSync(path.join(ws, "src", "a.js"), "console.log(2);\n");
  const cS = JSON.parse(fs.readFileSync(CL.contractFileFor(ws, "ko"), "utf8"));
  const sl = RD.buildMapAttach(ws, cS, "ko");
  fs.writeFileSync(path.join(ws, "src", "a.js"), "console.log(1);\n");
  ok(sl && sl.text.includes("[edge]") && sl.text.includes("node/edge"), "v2 slice에 인접 edge 동봉(신선도 라벨 포함)");
}
console.log("[5] manifest — P4 표면 2개 ready+activation");
{
  const m = AD.adapterManifest();
  const sa = m.surfaces.find((s) => s.id === "scout-attach");
  const gr = m.surfaces.find((s) => s.id === "gate-map-reader");
  ok(sa && sa.ready === true && sa.fn === "buildMapAttach" && sa.activation === "P3b", "scout-attach v2 등록(ready=호출 가능·activation=P3b 별개 명시)");
  ok(gr && gr.ready === true && gr.fn === "mapGateAssessFor" && gr.activation === "P3b", "gate-map-reader v2 등록");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
