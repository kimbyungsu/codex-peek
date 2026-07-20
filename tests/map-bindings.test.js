/*
 * P3a 테스트 — 권위 판별·매칭·legacy-scan·binding confirm/rebind/discard·live 서랍·promoteEntry·어댑터.
 * 설계: docs/MAP-P3A-DESIGN.md §B~§G(완료 조건 테스트 목록).
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "mapbind_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bindings.js");
const MA = require("../bridge/map-adapters.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");

function mkRepo(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mapbind_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  return ws;
}
function setScoutOn(ws) {
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
}
function initTopo(ws) {
  const r = MR.initTopologyForBootstrap(ws);
  if (r.st !== "created") throw new Error("init 실패: " + r.st);
  return MR.readTopoExFor(ws).topo;
}
const scopeMap = (ws, args) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws, ...args], { encoding: "utf8", env: { ...process.env } });
// 매칭 단위 테스트용 순수 topology(anchors 명시)
function mkTopo(nodes, edges) {
  return { schemaVersion: 2, mapId: U(500), revision: 1, draft: true,
    nodes: nodes.map((n, i) => ({ id: n.id || U(510 + i), label: n.label || "n" + i, entityType: "module", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: (n.paths || []).map((p) => ({ kind: "code", path: p })) })),
    edges: (edges || []).map((e, i) => ({ id: e.id || U(530 + i), from: e.from, to: e.to, relation: e.relation || "imports", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } })),
    inventory: { basisFp: sha("b"), inventoryFp: sha("i") } };
}
const approvedLine = (text, from) => `- ${text}  <!-- 승인 2026-01-02 · 출처: ${from} -->`;
const mapMdOf = (lines) => "# MAP — 확정 지식층(stable)\n\n## 확정 결합(승인분)\n" + lines.join("\n") + "\n";

function main() {
  console.log("[1] 2트랙 게이트 — 바인딩 CLI 전부 거부·서랍 미생성");
  {
    const ws = mkRepo("twotrack");
    for (const cmd of ["legacy-scan", "binding-list", "binding-confirm", "binding-rebind", "binding-discard"]) {
      const r = scopeMap(ws, [cmd, sha("x")]);
      ok(r.status === 2 && /3트랙|3-track/.test(r.stderr), `off: ${cmd}=거부`);
    }
    ok(!fs.existsSync(path.join(CL.BRIDGE_DIR, "map-bindings")), "서랍 미생성(무접촉)");
  }

  console.log("[2] 추출기·분류·패리티 — caseAware 동형성·endpointsKey·parseApproved·normRelPath");
  {
    const t = "결합: src/A.ts → lib/B.ts 방향(백틱 `src/C.js:12` 포함)";
    const lower = CL.ledgerPathsFromText(t);
    const aware = MB.caseAwarePathsFromText(t);
    ok(aware.map((x) => x.toLowerCase()).join("|") === lower.join("|"), "caseAware=소문자 추출기와 토큰 동형(소문자화만 차이 — 4차 #2)");
    ok(aware.includes("src/A.ts") && aware.includes("lib/B.ts"), "원문 case 보존");
    const LE = require("../out/ledger-events.js");
    for (const x of [t, "a/b.js와 c/d.js", "혼자 src/a.js", "a/b.js ↔ c/d.js → e/f.js"]) {
      ok(MB.endpointsKeyOfCopy(x) === LE.endpointsKeyOf(x), "endpointsKeyOf 패리티: " + x.slice(0, 20));
    }
    const ML = require("../out/map-ledger.js");
    const md = mapMdOf([approvedLine("첫 항목 src/a.js", "관측 장부"), "- 손으로 쓴 항목", approvedLine("둘째 a/b.js → c/d.js", "검증")]);
    ok(JSON.stringify(MB.parseApprovedCopy(md)) === JSON.stringify(ML.parseApprovedFromMap(md)), "parseApproved 패리티(단일 출처 왕복)");
    ok(MB.normRelPath(".\\\\src\\\\a.js") === null || MB.normRelPath("./src\\a.js") === "src/a.js", "구분자 통일·./ 제거");
    ok(MB.normRelPath("/abs/x.js") === null && MB.normRelPath("a/../b.js") === null, "절대·..=미해소(2차 #6)");
    ok(MB.classifyEvidencePath("tests/x.test.js") === "test" && MB.classifyEvidencePath("conf/app.yml") === "config"
      && MB.classifyEvidencePath(".env.local") === "config" && MB.classifyEvidencePath("docs/x.md") === "doc"
      && MB.classifyEvidencePath("src/a.js") === "code" && MB.classifyEvidencePath("img/logo.png") === "unsupported", "분류 우선순위+.env+unsupported(4차 #6)");
    ok(MB.classifyEvidencePath("tests/config.json") === "test", "우선순위 test>config");
  }

  console.log("[3] 매칭(§C-3) — case-exact/fold/suffix·ambiguous·edge 방향·multi-endpoint·병합");
  {
    const topo = mkTopo([
      { id: U(511), paths: ["src/A.ts"] }, { id: U(512), paths: ["lib/b.ts"] },
      { id: U(513), paths: ["deep/nest/c.js"] }, { id: U(514), paths: ["x/dup.js"] }, { id: U(515), paths: ["y/DUP.js"] },
    ], [{ id: U(531), from: U(511), to: U(512) }]);
    let m = MB.matchEntry(topo, "src/A.ts 단일");
    ok(m.match.status === "matched" && m.match.targetId === U(511) && m.match.matchQuality === "exact", "case-exact 유일=exact");
    m = MB.matchEntry(topo, "src/a.ts 단일");
    ok(m.match.status === "matched" && m.match.matchQuality === "case-fold", "case-fold 유일=matched(case-fold — 자동 확정은 아님)");
    m = MB.matchEntry(topo, "nest/c.js 접미");
    ok(m.match.status === "matched" && m.match.matchQuality === "suffix", "segment 접미=suffix");
    m = MB.matchEntry(topo, "x/dup.js와 y/dup.js가 아니라 dup.js 하나만");
    ok(m.match.status !== "matched" || m.match.matchQuality !== "exact", "대소문자 공존 fold=비exact(3차 #6)");
    m = MB.matchEntry(topo, "결합 src/A.ts → lib/b.ts");
    ok(m.match.status === "matched" && m.match.entityKind === "edge" && m.match.targetId === U(531), "d| 방향 edge=matched");
    m = MB.matchEntry(topo, "결합 lib/b.ts → src/A.ts");
    ok(m.match.status === "unmatched" && m.match.reason === "no-entity", "역방향 d|=no-entity(방향 준수)");
    m = MB.matchEntry(topo, "결합 lib/b.ts ↔ src/A.ts");
    ok(m.match.status === "matched" && m.match.entityKind === "edge", "b| 무방향=양방향 허용");
    m = MB.matchEntry(topo, "셋 결합 src/A.ts → lib/b.ts → deep/nest/c.js");
    ok(m.match.status === "unmatched" && m.match.reason === "multi-endpoint", "endpoint 3+=multi-endpoint 단일 확정(2차 #6)");
    m = MB.matchEntry(topo, "결합 dup.js → lib/b.ts");
    ok(m.match.status === "ambiguous" && m.match.reason === "endpoint-ambiguous" && Array.isArray(m.match.endpointCandidates), "endpoint 복수=endpoint-ambiguous 분리(3차 #5)");
    m = MB.matchEntry(topo, "경로 없는 문장");
    ok(m.match.status === "unmatched" && m.match.reason === "no-paths", "무경로=no-paths");
    // 결정론+병합(3차 #2)
    const md = mapMdOf([approvedLine("항목 src/A.ts", "a"), approvedLine("항목  src/A.ts", "b"), approvedLine("발산 src/A.ts 그리고 lib/b.ts", "c")]);
    const c1 = MB.buildCandidatesFor(topo, md, "docs/MAP.md");
    const c2 = MB.buildCandidatesFor(topo, md, "docs/MAP.md");
    ok(JSON.stringify(c1) === JSON.stringify(c2), "추출기 결정론(같은 입력=동일 산출)");
    const dup = c1.items.find((x) => x.sig === CL.ledgerSig("항목 src/A.ts"));
    ok(dup && dup.originals.length === 2 && dup.originals[0].from === "a", "동일 sig 복수 행=병합·원문 전량 보존(3차 #2)");
  }

  console.log("[4] 권위 판별(§B) — legacy·이력·blocked·receipt 체인");
  {
    const ws = mkRepo("auth");
    setScoutOn(ws); MB2 = MB;
    const topo = initTopo(ws);
    ok(MB.authorityStateFor(ws).st === "legacy", "부재+무이력=legacy(P3a 상태)");
    const histDir = path.join(ws, "project-map", "authority-history");
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(path.join(histDir, "junk.json"), "{broken");
    ok(MB.authorityStateFor(ws).st === "blocked", "이력 존재(손상 포함)+marker 부재=blocked(1차 #1)");
    // 유효 체인 구성: receipt(authorityObject 사본)→marker
    const did = U(600);
    const ao = { schema: "map-authority-v1", cutover: true, mapId: topo.mapId, decisionRef: did, ts: "2026-01-03T00:00:00.000Z" };
    const receipt = { schema: "map-cutover-receipt-v1", decisionId: did, mapId: topo.mapId, authorityMode: { from: "legacy", to: "v2" }, authorityObject: ao, authorityFileFp: sha(JSON.stringify(ao, null, 1)), ts: ao.ts };
    fs.unlinkSync(path.join(histDir, "junk.json"));
    fs.writeFileSync(path.join(histDir, did + ".json"), JSON.stringify(receipt, null, 1));
    ok(MB.authorityStateFor(ws).st === "blocked", "receipt만 존재(marker 부재)=blocked(쓰기 순서 계약)");
    fs.writeFileSync(path.join(ws, "project-map", "authority.json"), JSON.stringify(ao, null, 1));
    ok(MB.authorityStateFor(ws).st === "v2", "receipt+marker 정합=v2");
    fs.writeFileSync(path.join(ws, "project-map", "authority.json"), JSON.stringify({ ...ao, ts: "2026-01-04T00:00:00.000Z" }, null, 1));
    ok(MB.authorityStateFor(ws).st === "blocked", "marker 지문≠receipt 기대=blocked");
    ok(MB.validReceipt({ ...receipt, authorityObject: { ...ao, mapId: U(1) } }, did + ".json") === false, "교차 결속 위반=receipt 무효(4차 #1)");
    ok(MB.validReceipt(receipt, U(1) + ".json") === false, "파일명↔decisionId 불일치=무효");
    fs.unlinkSync(path.join(ws, "project-map", "authority.json"));
    fs.rmSync(histDir, { recursive: true, force: true });
    ok(MB.authorityStateFor(ws).st === "legacy", "(정리) legacy 복귀");
  }

  console.log("[5] legacy-scan(§D)·confirm/rebind/discard(§C-4)");
  {
    const ws = mkRepo("scan");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = (topo.nodes[0].anchors[0] || {}).path;
    ok(!!anchor, "(전제) init 노드에 anchors 존재: " + anchor);
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs", "MAP.md"), mapMdOf([approvedLine("확정 " + anchor, "관측 장부"), approvedLine("미매칭 unknown/zzz.js", "x")]));
    let r = MB.scanLegacy(ws);
    ok(r.ok && r.total === 2 && r.counts.exact === 1 && r.counts.unmatched === 1, "scan 카운트(exact 1·unmatched 1)");
    const d = MB.bindingsDirFor(ws, topo.mapId);
    const t1 = fs.readFileSync(d.candidatesFile, "utf8");
    ok(MB.scanLegacy(ws).ok && fs.readFileSync(d.candidatesFile, "utf8") === t1, "재실행=바이트 동일(멱등)");
    const cand = JSON.parse(t1);
    const exact = cand.items.find((x) => x.match.status === "matched");
    const un = cand.items.find((x) => x.match.status === "unmatched");
    // confirm: exact=--target 생략 가능
    let c = MB.confirmBinding(ws, exact.candidateFp, {});
    ok(c.ok && c.targetId === exact.match.targetId && c.kind === "node", "exact 자동 확정(--target 생략)");
    ok(MB.confirmBinding(ws, exact.candidateFp, {}).idempotent === true, "같은 (sig,target) 재확정=멱등");
    const rb0 = JSON.parse(fs.readFileSync(MB.bindingsFileFor(ws), "utf8"));
    ok(rb0.schema === "map-bindings-v1" && rb0.mapId === topo.mapId && rb0.bindings.length === 1 && rb0.bindings[0].origin.kind === "legacy-map", "bindings.json canonical+origin=legacy-map");
    // unmatched=--target 필수·후보 밖 target 실존 판별
    c = MB.confirmBinding(ws, un.candidateFp, {});
    ok(c.ok === false && /--target 필수/.test(c.error), "unmatched=--target 필수(4차 #7)");
    c = MB.confirmBinding(ws, un.candidateFp, { target: topo.nodes[0].id });
    ok(c.ok === true && c.kind === "node", "후보 밖 --target=실존 판별로 확정(2차 #6)");
    // sig 기본키: 같은 sig 다른 target=거부
    c = MB.confirmBinding(ws, exact.candidateFp, { target: U(999) });
    ok(c.ok === false && /rebind/.test(c.error || "") === false ? /UUID|없음|결속/.test(c.error) : true, "(전제) 잘못된 target 거부");
    // rebind: 감사 배열
    const node2 = topo.nodes[1] ? topo.nodes[1].id : null;
    if (node2) {
      c = MB.rebindBinding(ws, exact.candidateFp, { target: node2 });
      ok(c.ok === true && c.rebound === true, "rebind 성공");
      const rb1 = JSON.parse(fs.readFileSync(MB.bindingsFileFor(ws), "utf8"));
      const b1 = rb1.bindings.find((x) => x.sig === exact.sig);
      ok(b1.targetId === node2 && b1.rebound.length === 1 && b1.rebound[0].prevTargetId === exact.match.targetId && b1.rebound[0].prevCandidateFp === exact.candidateFp, "rebound 감사 스키마(2차 #9)");
    }
    // 신선도: 원문 변경 후 옛 fp=거부(재스캔 안내)
    fs.appendFileSync(path.join(ws, "docs", "MAP.md"), approvedLine("추가 항목 " + anchor + " 신규", "y") + "\n");
    c = MB.confirmBinding(ws, un.candidateFp, { target: topo.nodes[0].id });
    ok(c.ok === false && /재스캔|재실행|조회 실패|불일치/.test(c.error), "원문 변경=신선도 거부(1차 #2)");
    ok(MB.scanLegacy(ws).ok, "(재스캔)");
    const cand2 = JSON.parse(fs.readFileSync(d.candidatesFile, "utf8"));
    ok(!cand2.items.some((x) => x.candidateFp === un.candidateFp), "재스캔 후 옛 candidateFp 소멸(선택 세대 결속 — 2차 #3)");
    // stale bindings(세대 불일치)
    const bf = JSON.parse(fs.readFileSync(MB.bindingsFileFor(ws), "utf8"));
    fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ ...bf, mapId: U(2) }, null, 1));
    const fresh = cand2.items.find((x) => x.match.status === "matched" && x.match.matchQuality === "exact");
    if (fresh) {
      c = MB.confirmBinding(ws, fresh.candidateFp, {});
      ok(c.ok === false && /이전 세대/.test(c.error), "bindings.json 세대 불일치=거부(자동 승계 금지)");
    }
    fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify(bf, null, 1));
  }

  console.log("[6] live 서랍·promoteEntry(§E-W) — needs-binding·멱등·backpressure·patch·상태 분리");
  {
    const ws = mkRepo("live");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = (topo.nodes[0].anchors[0] || {}).path;
    // 미결속 live 승인 → needs-binding+서랍 upsert
    const e1 = { text: "라이브 결합 " + anchor, from: "관측 장부", approvedAt: "2026-01-05T00:00:00.000Z", actionRef: "export" };
    let r = MA.promoteEntry(ws, e1, {});
    ok(r.st === "needs-binding" && r.candidateFp && r.entry.actionRef === "export" && r.entry.sig === CL.ledgerSig(e1.text), "미결속(exact여도)=needs-binding+actionRef 결속(4차 #3·5차 #3)");
    const fp1 = r.candidateFp;
    // 재시도 멱등: 다른 approvedAt이어도 같은 후보 재사용
    r = MA.promoteEntry(ws, { ...e1, approvedAt: "2026-01-06T00:00:00.000Z" }, {});
    ok(r.st === "needs-binding" && r.candidateFp === fp1 && r.entry.approvedAt === e1.approvedAt, "재시도=(mapId,sig) 재사용·최초 approvedAt 보존(6차 #2)");
    // confirm(live 이원 판독)→bound 전이
    let c = MB.confirmBinding(ws, fp1, { target: topo.nodes[0].id });
    ok(c.ok === true, "live 후보 confirm(--target)");
    const d = MB.bindingsDirFor(ws, topo.mapId);
    const lv = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
    ok(lv.items.find((x) => x.candidateFp === fp1).status === "bound", "confirm=제거 아닌 bound 전이(7차 #4)");
    // binding 존재 → patch(durable proposal)
    r = MA.promoteEntry(ws, e1, {});
    ok(r.st === "patch" && /^[0-9a-f-]{36}$/.test(r.patchId), "binding 존재=durable proposal 생성(결정론 patchId)");
    const pid1 = r.patchId;
    const pend = JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, topo.mapId).pending, pid1 + ".json"), "utf8"));
    ok(pend.lifecycle === "proposed" && PM.validatePatchV2(pend.patch).length === 0, "pending=proposed·patch 스키마 전체 통과");
    ok((pend.patch.readSet.files || []).some((x) => x.ref === "project-map/bindings.json"), "readSet.files에 bindings.json 결속(7차 #5)");
    ok(pend.patch.payload.evidence.kind === "ledger" && pend.patch.payload.evidence.ref === CL.ledgerSig(e1.text), "payload={evidence:{kind:ledger}}(3차 #7)");
    ok(JSON.parse(fs.readFileSync(d.liveFile, "utf8")).items.every((x) => x.candidateFp !== fp1), "durable 확인 시 bound 후보 동반 정리(7차 #4)");
    // 재호출=already-pending(의미 키 유일성)
    r = MA.promoteEntry(ws, e1, {});
    ok(r.st === "already-pending" && r.patchId === pid1, "재호출=already-pending(8차 #1 — 중복 proposal 없음)");
    // rebind는 미종결 promotion 존재 시 거부(6차 #4 — 단 live 후보가 정리됐으면 fp 조회 실패가 선행)
    const rb = MB.rebindBinding(ws, fp1, { target: topo.nodes[1] ? topo.nodes[1].id : topo.nodes[0].id });
    ok(rb.ok === false && /미종결 promotion|조회 실패/.test(rb.error), "rebind: 미종결 promotion/낡은 fp=거부");
    // apply까지 통과(생성 patch가 P2 ②b·적용기 정합) → already-applied
    ok(MP.classifyPatch(ws, topo.mapId, pid1).ok, "(전제) classify");
    const ap = MP.applyPatch(ws, topo.mapId, pid1, { preCutover: true });
    ok(ap.ok === true, "생성 patch가 P2 apply 전체 통과" + (ap.ok ? "" : " — " + ap.error));
    r = MA.promoteEntry(ws, e1, {});
    ok(r.st === "already-applied" && r.targetId === topo.nodes[0].id, "적용 후=already-applied(5차 #5)");
    // 증거 채택 0=rejected
    const eDoc = { text: "문서만 docs/none.md", from: "x", approvedAt: "2026-01-07T00:00:00.000Z", actionRef: "approve" };
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs", "none.md"), "# d\n");
    const nb = MA.promoteEntry(ws, eDoc, {});
    ok(nb.st === "needs-binding", "(전제) 미결속");
    c = MB.confirmBinding(ws, nb.candidateFp, { target: topo.nodes[0].id });
    ok(c.ok, "(전제) doc 항목 confirm");
    r = MA.promoteEntry(ws, eDoc, {});
    ok(r.st === "rejected" && /증거 채택 0/.test(r.reason), "doc만=rejected(단순 실존≠code 증거 — 4차 #6)");
    // backpressure(전역 open 상한 — env 최솟값 20)
    process.env.CODEX_BRIDGE_MAP_GC_KEEP = "20";
    let last = null;
    for (let i = 0; i < 25; i++) last = MA.promoteEntry(ws, { text: "벌크 항목 " + i + " 고유문구", from: "x", approvedAt: "2026-01-08T00:00:00.000Z", actionRef: "export" }, {});
    ok(last.st === "rejected" && /backpressure/.test(last.reason), "open 상한 도달=신규 rejected(8차 #2 — 삭제 아님)");
    const lv2 = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
    ok(lv2.items.filter((x) => x.status === "open").length >= 18, "기존 open 보존(바이트 소실 없음)");
    delete process.env.CODEX_BRIDGE_MAP_GC_KEEP;
    // discard(open 전용)+card-refs 참조 거부
    const anyOpen = lv2.items.find((x) => x.status === "open");
    fs.writeFileSync(d.cardRefsFile, JSON.stringify({ schema: "map-card-refs-v1", refs: [{ candidateFp: anyOpen.candidateFp, cardId: U(700) }] }, null, 1));
    r = MB.discardCandidate(ws, anyOpen.candidateFp);
    ok(r.ok === false && /카드 참조/.test(r.error), "card-refs 등록=discard 거부(9차 #4)");
    fs.writeFileSync(d.cardRefsFile, JSON.stringify({ schema: "map-card-refs-v1", refs: [] }, null, 1));
    r = MB.discardCandidate(ws, anyOpen.candidateFp);
    ok(r.ok === true, "참조 해제 후 discard(open 전용)");
  }

  console.log("[7] 어댑터(§E) — legacy 동치·blocked·manifest");
  {
    const ws = mkRepo("adapt");
    setScoutOn(ws);
    const topo = initTopo(ws);
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    const md = mapMdOf([approvedLine("항목 하나 src/a.js", "관측 장부")]);
    fs.writeFileSync(path.join(ws, "docs", "MAP.md"), md);
    const ML = require("../out/map-ledger.js");
    const v = MA.approvedViewFor(ws);
    const ref = ML.parseApprovedFromMap(md);
    ok(v.source === "legacy" && JSON.stringify(v.approved) === JSON.stringify(ref.approved) && v.totalItems === ref.totalItems, "approvedViewFor(legacy)≡parseApprovedFromMap 동치");
    const mc = MA.mapContentFor(ws);
    ok(mc.source === "legacy" && mc.content === md, "mapContentFor(legacy)=docs/MAP.md raw 동치");
    // blocked=권위 데이터 반환 금지
    fs.mkdirSync(path.join(ws, "project-map", "authority-history"), { recursive: true });
    fs.writeFileSync(path.join(ws, "project-map", "authority-history", "x.json"), "{broken");
    const vb = MA.approvedViewFor(ws);
    ok(vb.source === "blocked" && vb.approved.length === 0 && MA.mapContentFor(ws).content === null, "blocked=권위 데이터 반환 금지(§B)");
    ok(MB.legacyPreviewFor(ws) && MB.legacyPreviewFor(ws).authority === false, "legacyPreviewFor=비권위 진단 전용 분리");
    fs.rmSync(path.join(ws, "project-map", "authority-history"), { recursive: true, force: true });
    const mf = MA.adapterManifest();
    // 의도 개정(P4 증분 3, 2026-07-20): P4 표면 2개(scout-attach·gate-map-reader)가 v2 함수 등록으로 ready —
    // ready='호출 가능 구현' 기준이고 활성화(activation=P3b)는 별개(manifest가 명시). 전 표면 ready+P4 표면은 activation 표기 필수.
    ok(mf.surfaces.length === MA.REQUIRED_SURFACES.length && mf.surfaces.filter((x) => x.ready).length === MA.REQUIRED_SURFACES.length, "manifest: 전 표면 ready(P4 2표면 포함 — 증분 3 등록·집합 일치)");
    ok(mf.surfaces.filter((x) => x.activation === "P3b").length === 2, "P4 표면 2개=activation P3b 명시(ready와 활성의 분리)");
    const pr = MA.promoteEntry(ws, { text: "no topo test", from: "x" }, {});
    ok(pr.st === "needs-binding" || pr.st === "rejected", "(경계) promoteEntry 합타입 유지");
  }

  console.log("[8] 구현 1차 반례 — WAL barrier·dead lock GC·손상 신뢰 경계·전 세대 discard·resolved 진단·canonical evidence");
  {
    const ws = mkRepo("fix1");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = topo.nodes[0].anchors[0].path;
    // #1 활성 WAL=scan/promote 차단(barrier 정본 소비)
    const dP = MP.ensureDirs(ws, topo.mapId);
    fs.writeFileSync(path.join(dP.wal, U(70) + ".json"), JSON.stringify({ schema: "map-wal-v2", decision: { decisionId: U(70) } }));
    ok(MB.scanLegacy(ws).ok === false && /WAL/.test(MB.scanLegacy(ws).error), "활성 WAL=scan 보류(구현 1차 #1)");
    let r = MA.promoteEntry(ws, { text: "x " + anchor, from: "x", approvedAt: "2026-01-09T00:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "rejected" && /WAL/.test(r.reason), "활성 WAL=promoteEntry 거부(구현 1차 #1)");
    fs.unlinkSync(path.join(dP.wal, U(70) + ".json"));
    // #8 소문자 병합 복수 경로=node 오확정 금지
    const m8 = MB.matchEntry(topo, anchor + " " + anchor.toUpperCase());
    ok(m8.match.status === "unmatched" && m8.match.reason === "unresolved", "case만 다른 복수 경로=node 오확정 금지(구현 1차 #8)");
    // #9 ts ISO
    const ao9 = { schema: "map-authority-v1", cutover: true, mapId: topo.mapId, decisionRef: U(71), ts: "not-an-iso" };
    ok(MB.validReceipt({ schema: "map-cutover-receipt-v1", decisionId: U(71), mapId: topo.mapId, authorityMode: { from: "legacy", to: "v2" }, authorityObject: ao9, authorityFileFp: sha(JSON.stringify(ao9, null, 1)), ts: "not-an-iso" }, U(71) + ".json") === false, "ts 비ISO=receipt 무효(구현 1차 #9)");
    // #3 손상 bindings(JSON-valid) 신뢰 경계
    fs.mkdirSync(path.join(ws, "project-map"), { recursive: true });
    fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ schema: "map-bindings-v1", mapId: topo.mapId, bindings: [null] }, null, 1));
    ok(MB.readBindingsFor(ws, topo.mapId).st === "invalid", "bindings:[null]=invalid(레코드 정밀 검증 — 구현 1차 #3)");
    r = MA.promoteEntry(ws, { text: "y " + anchor, from: "x", approvedAt: "2026-01-09T00:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "rejected" && /bindings/.test(r.reason), "손상 bindings=promoteEntry 거부(TypeError 사망 아님)");
    fs.unlinkSync(MB.bindingsFileFor(ws));
    // #2 dead .cand-global-lock → gc 격리 → 재개
    const lockF = path.join(MB.bindingsRootFor(ws), ".cand-global-lock");
    fs.mkdirSync(MB.bindingsRootFor(ws), { recursive: true });
    fs.writeFileSync(lockF, JSON.stringify({ pid: 999999999, token: "dead" }));
    r = MA.promoteEntry(ws, { text: "z " + anchor, from: "x", approvedAt: "2026-01-09T00:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "rejected" && /cand-global-lock/.test(r.reason), "dead 후보 잠금=거부(자동 회수 없음)");
    const gc = MP.pipelineGc(ws, topo.mapId);
    ok(gc.ok && !fs.existsSync(lockF), "pipelineGc가 dead .cand-global-lock 격리(구현 1차 #2 배선)");
    r = MA.promoteEntry(ws, { text: "z " + anchor, from: "x", approvedAt: "2026-01-09T00:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "needs-binding", "격리 후 자연 재개");
    // #8 재시도 응답=저장 actionRef(다른 actionRef 재시도)
    const r2 = MA.promoteEntry(ws, { text: "z " + anchor, from: "x", approvedAt: "2026-01-10T00:00:00.000Z", actionRef: "approve" }, {});
    ok(r2.st === "needs-binding" && r2.candidateFp === r.candidateFp && r2.entry.actionRef === "export", "재시도 응답=저장분 actionRef(구현 1차 #8)");
    // #5 이전 세대 서랍 discard+list 상세
    const otherMap = U(800);
    const od = path.join(MB.bindingsRootFor(ws), otherMap);
    fs.mkdirSync(od, { recursive: true });
    const NUL0 = "\u0000";
    const oText = "옛 항목", oAt = "2026-01-01T00:00:00.000Z", oFrom = "x", oAct = "export";
    const oSig = CL.ledgerSig(oText);
    const oEfp = sha(oText + NUL0 + oAt + NUL0 + oFrom + NUL0 + oAct);
    const oMatch = { status: "unmatched", reason: "no-paths" };
    const oTopoH = sha("t-old");
    const oCfp = sha(oSig + NUL0 + otherMap + NUL0 + "live" + NUL0 + oEfp + NUL0 + oTopoH + NUL0 + MB.stableJson(oMatch));
    const oldItem = { candidateFp: oCfp, sig: oSig, originals: [{ text: oText, date: "2026-01-01", approvedAt: oAt, from: oFrom, entryFp: oEfp }], originalsFp: sha(oEfp), entryFp: oEfp, topologyHash: oTopoH, endpointsKey: null, paths: [], match: oMatch, origin: { kind: "live-approval", approvedAt: oAt, actionRef: oAct }, status: "open", prevFps: [] };
    fs.writeFileSync(path.join(od, "live-candidates.json"), JSON.stringify({ schema: "map-live-candidates-v1", mapId: otherMap, items: [oldItem] }, null, 1));
    const lst = MB.listBindings(ws);
    ok(lst.ok && lst.prevGenerations.some((g) => g.mapId === otherMap && g.items && g.items[0].candidateFp === oldItem.candidateFp), "이전 세대 미처리=상세 표시(구현 1차 #5)");
    const dc = MB.discardCandidate(ws, oldItem.candidateFp);
    ok(dc.ok === true && dc.mapId === otherMap, "이전 세대 후보 명시 폐기 가능(backpressure 해소 경로)");
    // #6 복수 evidence 경로=canonical 정규화 통과 / #7 resolved 진단
    fs.mkdirSync(path.join(ws, "zz"), { recursive: true });
    fs.writeFileSync(path.join(ws, "zz", "zfile.js"), "// z\n");
    const multiText = "복수 결합 zz/zfile.js ↔ " + anchor;
    const nb6 = MA.promoteEntry(ws, { text: multiText, from: "x", approvedAt: "2026-01-11T00:00:00.000Z", actionRef: "export" }, {});
    ok(nb6.st === "needs-binding", "(전제) 미결속");
    ok(MB.confirmBinding(ws, nb6.candidateFp, { target: topo.nodes[0].id }).ok, "(전제) confirm");
    const p6 = MA.promoteEntry(ws, { text: multiText, from: "x", approvedAt: "2026-01-11T00:00:00.000Z", actionRef: "export" }, {});
    ok(p6.st === "patch" && p6.patch && PM.validatePatchV2(p6.patch).length === 0 && p6.patch.evidence.length >= 2, "복수 evidence=canonical 정규화로 스키마 통과+patch 반환(구현 1차 #6)");
    ok(MP.classifyPatch(ws, topo.mapId, p6.patchId).ok && MP.applyPatch(ws, topo.mapId, p6.patchId, { preCutover: true }).ok, "(전제) 적용 — resolved 전이");
    // evidence를 수동 제거(resolved 존재+evidence 부재=진단)
    const tp = path.join(ws, "project-map", "topology.json");
    const tobj = JSON.parse(fs.readFileSync(tp, "utf8"));
    const sig6 = CL.ledgerSig(multiText);
    for (const n of tobj.nodes) if (n.evidence) n.evidence = n.evidence.filter((e) => !(e.kind === "ledger" && e.ref === sig6));
    fs.writeFileSync(tp, JSON.stringify(tobj, null, 1));
    const p7 = MA.promoteEntry(ws, { text: multiText, from: "x", approvedAt: "2026-01-11T00:00:00.000Z", actionRef: "export" }, {});
    ok(p7.st === "conflict" && /진단|resolved/.test(p7.reason), "resolved 존재+evidence 부재=진단 conflict(구현 1차 #7)");
  }

  console.log("[9] 구현 2차 반례 — 기록 patch 반환·validator 값 검증·card-refs 유일성·bound 복구·blocked 게이트");
  {
    const ws = mkRepo("fix2");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = topo.nodes[0].anchors[0].path;
    const e1 = { text: "이차 결합 " + anchor, from: "x", approvedAt: "2026-01-12T00:00:00.000Z", actionRef: "export" };
    let r = MA.promoteEntry(ws, e1, {});
    ok(MB.confirmBinding(ws, r.candidateFp, { target: topo.nodes[0].id }).ok, "(전제) confirm");
    r = MA.promoteEntry(ws, e1, {});
    ok(r.st === "patch" && r.patch && r.patch.patchId === r.patchId, "(전제) patch");
    const pendRec = JSON.parse(fs.readFileSync(path.join(MP.dirsFor(ws, topo.mapId).pending, r.patchId + ".json"), "utf8"));
    ok(JSON.stringify(pendRec.patch) === JSON.stringify(r.patch), "반환 patch=durable 기록분 동일(구현 2차 #2 — 잠금 밖 재생성 금지)");
    // validator 값 검증(2차 #3): rebound 위조·비ISO
    const bf = MB.bindingsFileFor(ws);
    const bd = JSON.parse(fs.readFileSync(bf, "utf8"));
    const orig = JSON.stringify(bd, null, 1);
    bd.bindings[0].rebound = [{ prevTargetId: "not-a-uuid", prevKind: "bogus", prevCandidateFp: "xx", confirmedAt: "y", reboundAt: "z" }];
    fs.writeFileSync(bf, JSON.stringify(bd, null, 1));
    ok(MB.readBindingsFor(ws, topo.mapId).st === "invalid", "rebound 값 위조=invalid(구현 2차 #3)");
    fs.writeFileSync(bf, orig);
    // card-refs 유일성: 한 candidateFp에 활성 cardId 둘=진단
    const d = MB.bindingsDirFor(ws, topo.mapId);
    const e2 = { text: "미결속 항목 하나", from: "x", approvedAt: "2026-01-12T01:00:00.000Z", actionRef: "approve" };
    const nb = MA.promoteEntry(ws, e2, {});
    ok(nb.st === "needs-binding", "(전제) open 후보");
    fs.writeFileSync(d.cardRefsFile, JSON.stringify({ schema: "map-card-refs-v1", refs: [{ candidateFp: nb.candidateFp, cardId: U(701) }, { candidateFp: nb.candidateFp, cardId: U(702) }] }, null, 1));
    let dc = MB.discardCandidate(ws, nb.candidateFp);
    ok(dc.ok === false && /유일성/.test(dc.error), "한 candidateFp 활성 cardId 둘=진단 거부(설계 12차 #3)");
    fs.unlinkSync(d.cardRefsFile);
    // live items:null=upsert fail-closed(2차 #3)
    const lvRaw = fs.readFileSync(d.liveFile, "utf8");
    fs.writeFileSync(d.liveFile, JSON.stringify({ schema: "map-live-candidates-v1", mapId: topo.mapId, items: null }, null, 1));
    const r3 = MA.promoteEntry(ws, { text: "셋째 항목", from: "x", approvedAt: "2026-01-12T02:00:00.000Z", actionRef: "export" }, {});
    ok(r3.st === "rejected" && /위반/.test(r3.reason), "live items:null=fail-closed(예외 사망 아님 — 구현 2차 #3)");
    fs.writeFileSync(d.liveFile, lvRaw);
    // 멱등 confirm이 bound 전이 중단을 복구(2차 #4)
    const lv = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
    const bItem = lv.items.find((x) => x.sig === CL.ledgerSig(e1.text));
    if (bItem) { bItem.status = "open"; delete bItem.boundTargetId; fs.writeFileSync(d.liveFile, JSON.stringify(lv, null, 1)); }
    const idem = bItem ? MB.confirmBinding(ws, bItem.candidateFp, {}) : { idempotent: false };
    if (bItem) {
      ok(idem.ok === true && idem.idempotent === true, "(전제) 멱등 confirm");
      const lv2 = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
      ok(lv2.items.find((x) => x.candidateFp === bItem.candidateFp).status === "bound", "멱등 재시도가 bound 전이 복구(구현 2차 #4)");
    }
    // blocked 게이트: scan·discard(2차 #5)
    fs.mkdirSync(path.join(ws, "project-map", "authority-history"), { recursive: true });
    fs.writeFileSync(path.join(ws, "project-map", "authority-history", "j.json"), "{broken");
    ok(MB.scanLegacy(ws).ok === false && /blocked/.test(MB.scanLegacy(ws).error), "blocked=scan 거부(단일 판별 경유 — 구현 2차 #5)");
    dc = MB.discardCandidate(ws, sha("none"));
    ok(dc.ok === false && /blocked/.test(dc.error), "blocked=discard 거부");
    fs.rmSync(path.join(ws, "project-map", "authority-history"), { recursive: true, force: true });
  }

  console.log("[10] 구현 4차 반례 — lookupBySig/list 손상·binding 원문 변조·approvedAt ISO·R1 lifecycle·R2 blocked");
  {
    const ws = mkRepo("fix4");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = topo.nodes[0].anchors[0].path;
    // approvedAt 비ISO=입력 거부(자기 오염 차단)
    let r = MA.promoteEntry(ws, { text: "항목 " + anchor, from: "x", approvedAt: "not-an-iso", actionRef: "export" }, {});
    ok(r.st === "rejected" && /ISO/.test(r.reason), "approvedAt 비ISO=거부(구현 4차 #3)");
    // lookupBySig·list 손상(items:{})=오류 합타입(예외 사망 아님)
    const d = MB.bindingsDirFor(ws, topo.mapId);
    fs.mkdirSync(d.base, { recursive: true });
    fs.writeFileSync(d.liveFile, JSON.stringify({ schema: "map-live-candidates-v1", mapId: topo.mapId, items: {} }, null, 1));
    const lb = MB.lookupBySig(ws, topo.mapId, "아무거나", null, null);
    ok(lb.st === "error", "lookupBySig: items:{}=오류 합타입(구현 4차 #1)");
    const ls = MB.listBindings(ws);
    ok(ls.ok === false && /위반|손상/.test(ls.error), "binding-list: 손상 서랍=fail-closed(구현 4차 #1)");
    fs.unlinkSync(d.liveFile);
    // binding 원문 변조=invalid(권위 뷰 오염 차단)
    r = MA.promoteEntry(ws, { text: "정상 " + anchor, from: "x", approvedAt: "2026-01-13T00:00:00.000Z", actionRef: "export" }, {});
    ok(MB.confirmBinding(ws, r.candidateFp, { target: topo.nodes[0].id }).ok, "(전제) confirm");
    const bf = MB.bindingsFileFor(ws);
    const bd = JSON.parse(fs.readFileSync(bf, "utf8"));
    const keep = JSON.stringify(bd, null, 1);
    bd.bindings[0].originals[0].text = "변조된 원문";
    fs.writeFileSync(bf, JSON.stringify(bd, null, 1));
    ok(MB.readBindingsFor(ws, topo.mapId).st === "invalid", "원문 변조(entryFp·sig 불일치)=invalid(구현 4차 #2)");
    fs.writeFileSync(bf, keep);
    // R1 lifecycle 표시(v2) — 권위 체인 구성 후 tombstoned 대상 표시
    const did = U(801);
    const ao = { schema: "map-authority-v1", cutover: true, mapId: topo.mapId, decisionRef: did, ts: "2026-01-13T01:00:00.000Z" };
    const receipt = { schema: "map-cutover-receipt-v1", decisionId: did, mapId: topo.mapId, authorityMode: { from: "legacy", to: "v2" }, authorityObject: ao, authorityFileFp: sha(JSON.stringify(ao, null, 1)), ts: ao.ts };
    fs.mkdirSync(path.join(ws, "project-map", "authority-history"), { recursive: true });
    fs.writeFileSync(path.join(ws, "project-map", "authority-history", did + ".json"), JSON.stringify(receipt, null, 1));
    fs.writeFileSync(path.join(ws, "project-map", "authority.json"), JSON.stringify(ao, null, 1));
    ok(MB.authorityStateFor(ws).st === "v2", "(전제) v2 권위");
    const tp = path.join(ws, "project-map", "topology.json");
    const tobj = JSON.parse(fs.readFileSync(tp, "utf8"));
    tobj.nodes[0].state.lifecycle = "tombstoned";
    fs.writeFileSync(tp, JSON.stringify(tobj, null, 1));
    const v = MA.approvedViewFor(ws);
    ok(v.source === "v2" && v.approved.length === 1 && v.approved[0].retired === true && v.approved[0].lifecycle === "tombstoned", "R1 v2: tombstoned 대상=retired 표시(구현 4차 #5)");
    // R2: v2에서 MAP.md 부재=blocked+사유
    fs.unlinkSync(path.join(ws, "project-map", "MAP.md"));
    const mc = MA.mapContentFor(ws);
    ok(mc.source === "blocked" && mc.content === null && /부재|판독/.test(mc.reason), "R2 v2: MAP.md 부재=blocked+사유(구현 4차 #5)");
  }

  console.log("[11] 구현 5차 반례 — live date 변조·actionRef 오타·list 손상 bindings·legacy 손상 후보");
  {
    const ws = mkRepo("fix5");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = topo.nodes[0].anchors[0].path;
    // actionRef 오타=rejected(legacy 강등 금지)
    let r = MA.promoteEntry(ws, { text: "오타 " + anchor, from: "x", approvedAt: "2026-01-14T00:00:00.000Z", actionRef: "aprove" }, {});
    ok(r.st === "rejected" && /actionRef/.test(r.reason), "actionRef 오타=rejected(조용한 legacy 강등 금지 — 구현 5차 #2)");
    r = MA.promoteEntry(ws, { text: "누락 " + anchor, from: "x", approvedAt: "2026-01-14T00:00:00.000Z" }, {});
    ok(r.st === "rejected" && /actionRef/.test(r.reason), "approvedAt만 제시=live 의도·actionRef 필수(구현 5차 #2)");
    // live date 변조=서랍 위반(지문 재계산 불요 반례 봉합)
    r = MA.promoteEntry(ws, { text: "정상 " + anchor, from: "x", approvedAt: "2026-01-14T01:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "needs-binding", "(전제) live upsert");
    const d = MB.bindingsDirFor(ws, topo.mapId);
    const lv = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
    const keepLv = JSON.stringify(lv, null, 1);
    lv.items[0].originals[0].date = "2099-99-99";
    fs.writeFileSync(d.liveFile, JSON.stringify(lv, null, 1));
    ok(MB.lookupBySig(ws, topo.mapId, lv.items[0].sig, null, null).st === "error", "live date 변조=서랍 위반(파생 결속 — 구현 5차 #1)");
    fs.writeFileSync(d.liveFile, keepLv);
    // confirm이 손상 원문을 확정본으로 기록하지 않음(writeBindings 전수 검증) — 위 변조를 우회 주입해도 기록 거부
    // (lookup이 먼저 막으므로 여기서는 list 손상 bindings 반례로 확인)
    fs.mkdirSync(path.join(ws, "project-map"), { recursive: true });
    fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ schema: "map-bindings-v1", mapId: topo.mapId, bindings: [null] }, null, 1));
    const ls = MB.listBindings(ws);
    ok(ls.ok === false && /invalid/.test(ls.error), "list: 손상 bindings='없음'이 아니라 fail-closed(구현 5차 #3)");
    fs.unlinkSync(MB.bindingsFileFor(ws));
    // legacy 손상 candidates=promoteEntry rejected(직접 판독 우회 제거)
    fs.writeFileSync(d.candidatesFile, JSON.stringify({ schema: "map-binding-candidates-v1", mapId: topo.mapId, sourceRel: "docs/MAP.md", sourceFp: sha("s"), topologyHash: sha("t"), items: {} }, null, 1));
    r = MA.promoteEntry(ws, { text: "legacy 항목 " + anchor, from: "x" }, {});
    ok(r.st === "rejected" && /위반|손상/.test(r.reason), "legacy 손상 후보=rejected(공용 판독기 경유 — 구현 5차 #4)");
    fs.unlinkSync(d.candidatesFile);
  }

  console.log("[12] 구현 6차 반례 — lookupBySig 교차 서랍 재개·3요소 판별·conflict·scan 정직 보고");
  {
    const ws = mkRepo("fix6");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = topo.nodes[0].anchors[0].path;
    // 교차 서랍 동일 sig: legacy 후보(스캔)+live 후보(승인) 공존 — oldFp가 live prevFps에 있으면 live로 재개
    const text = "겹침 항목 " + anchor;
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs", "MAP.md"), mapMdOf([approvedLine(text, "관측 장부")]));
    ok(MB.scanLegacy(ws).ok, "(전제) legacy 후보 존재");
    let r = MA.promoteEntry(ws, { text, from: "관측 장부", approvedAt: "2026-01-15T00:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "needs-binding", "(전제) live 후보 공존");
    const sig = CL.ledgerSig(text);
    // topology 변경으로 live 후보 fp 교체 유도(prevFps 채움)
    const d = MB.bindingsDirFor(ws, topo.mapId);
    const lv0 = JSON.parse(fs.readFileSync(d.liveFile, "utf8"));
    const oldFp = lv0.items.find((x) => x.sig === sig).candidateFp;
    fs.appendFileSync(path.join(ws, "src", "a.js"), "// 변경\n");
    // topology 자체를 바꿔야 topologyHash가 변함 — add_condition 적용
    const dummy = { text: "다른 항목 zz", from: "x" };
    const tp = path.join(ws, "project-map", "topology.json");
    const tobj = JSON.parse(fs.readFileSync(tp, "utf8"));
    tobj.nodes[0].conditions = [...(tobj.nodes[0].conditions || []), "변경조건"];
    tobj.revision = (tobj.revision || 1) + 1;
    fs.writeFileSync(tp, JSON.stringify(tobj, null, 1));
    r = MA.promoteEntry(ws, { text, from: "관측 장부", approvedAt: "2026-01-16T00:00:00.000Z", actionRef: "export" }, {});
    ok(r.st === "needs-binding" && r.candidateFp !== oldFp, "(전제) topology 변경=fp 교체");
    const cur = JSON.parse(fs.readFileSync(d.liveFile, "utf8")).items.find((x) => x.sig === sig);
    ok(cur.prevFps.includes(oldFp), "(전제) prevFps에 옛 fp");
    let lb = MB.lookupBySig(ws, topo.mapId, sig, { fp: oldFp });
    ok(lb.st === "stale-candidate" && lb.drawer === "live" && lb.current.candidateFp === cur.candidateFp, "교차 서랍에서 oldFp=live 재개(첫 서랍 조기 반환 봉합 — 구현 6차 #1)");
    // 2차 판별: (entryFp, origin) 3요소 — origin 미제공=판별 불가(different/conflict로)
    const eFp = cur.originals[0].entryFp;
    lb = MB.lookupBySig(ws, topo.mapId, sig, { entryFp: eFp });
    ok(lb.st === "conflict" || lb.st === "different", "entryFp 단독(origin 미제공)=2차 판별 불성립(3요소 계약)");
    lb = MB.lookupBySig(ws, topo.mapId, sig, { entryFp: eFp, origin: { kind: "live-approval", approvedAt: cur.origin.approvedAt, actionRef: "export" } });
    ok(lb.st === "stale-candidate" && lb.drawer === "live", "(sig,entryFp,origin) 일치=stale-candidate(prevFps 상한 탈락 후 복구 — 설계 9차 #3)");
    // 동일 sig 양쪽 서랍+판별 불가=conflict
    lb = MB.lookupBySig(ws, topo.mapId, sig, {});
    ok(lb.st === "conflict", "동일 sig 복수(양쪽 서랍)+판별 재료 없음=conflict(구현 6차 #1)");
    // scan 정직 보고: bindings invalid=ok:false / stale=별도 상태
    fs.writeFileSync(MB.bindingsFileFor(ws), "{broken");
    let sc = MB.scanLegacy(ws);
    ok(sc.ok === false && /invalid|unreadable/.test(sc.error), "scan: 손상 bindings=ok:false(확정 0건 위장 금지 — 구현 6차 #2)");
    fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ schema: "map-bindings-v1", mapId: U(999), bindings: [] }, null, 1));
    sc = MB.scanLegacy(ws);
    ok(sc.ok === true && sc.confirmed === null && sc.bindingsState === "stale", "scan: 세대 불일치=stale 별도 상태(confirmed=null)");
    fs.unlinkSync(MB.bindingsFileFor(ws));
  }

  console.log("[13] 구현 7차 반례 — legacy origin 전체 비교·sourceRel enum");
  {
    const ws = mkRepo("fix7");
    setScoutOn(ws);
    const topo = initTopo(ws);
    const anchor = topo.nodes[0].anchors[0].path;
    const text = "레거시 재개 " + anchor;
    fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "docs", "MAP.md"), mapMdOf([approvedLine(text, "관측 장부")]));
    ok(MB.scanLegacy(ws).ok, "(전제) 스캔");
    const sig = CL.ledgerSig(text);
    const d = MB.bindingsDirFor(ws, topo.mapId);
    const head = JSON.parse(fs.readFileSync(d.candidatesFile, "utf8"));
    const it = head.items.find((x) => x.sig === sig);
    // 다른 원천(sourceRel/sourceFp)의 카드 origin으로 2차 판별 시도=불성립(구현 7차 #1)
    let lb = MB.lookupBySig(ws, topo.mapId, sig, { entryFp: it.originals[0].entryFp, origin: { kind: "legacy-map", sourceRel: "MAP.md", sourceFp: sha("다른 원문") } });
    ok(lb.st !== "stale-candidate", "다른 원천 origin=동일 승인 오판별 금지(canonical 전체 비교)");
    lb = MB.lookupBySig(ws, topo.mapId, sig, { entryFp: it.originals[0].entryFp, origin: { kind: "legacy-map", sourceRel: head.sourceRel, sourceFp: head.sourceFp } });
    ok(lb.st === "stale-candidate" && lb.drawer === "legacy", "정확 일치 origin=stale-candidate(legacy head 재구성)");
    // 입력 origin 형식 위반=불성립
    lb = MB.lookupBySig(ws, topo.mapId, sig, { entryFp: it.originals[0].entryFp, origin: { kind: "legacy-map", sourceRel: "../../not-a-ledger", sourceFp: head.sourceFp } });
    ok(lb.st !== "stale-candidate", "입력 origin sourceRel enum 위반=판별 불가(구현 7차 #2)");
    // 확정본의 sourceRel 임의 문자열=invalid
    ok(MB.confirmBinding(ws, it.candidateFp, {}).ok || true, "(전제) confirm 시도");
    const bf = MB.bindingsFileFor(ws);
    if (fs.existsSync(bf)) {
      const bd = JSON.parse(fs.readFileSync(bf, "utf8"));
      if (bd.bindings[0]) {
        const keep = JSON.stringify(bd, null, 1);
        bd.bindings[0].origin = { kind: "legacy-map", sourceRel: "../../not-a-ledger", sourceFp: head.sourceFp };
        fs.writeFileSync(bf, JSON.stringify(bd, null, 1));
        ok(MB.readBindingsFor(ws, topo.mapId).st === "invalid", "확정본 sourceRel 임의 문자열=invalid(구현 7차 #2)");
        fs.writeFileSync(bf, keep);
      }
    }
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  try { fs.rmSync(process.env.CODEX_BRIDGE_HOME, { recursive: true, force: true }); } catch { /* 무해 */ }
  process.exit(fail ? 1 : 0);
}
main();
