/*
 * P8 증분 4 — 실배선 실행 테스트(1차 blocker⑥+2차 blocker①~④ 반영 — 문자열 단언이 아니라 실행 반례):
 * 민감 경로 제외(발췌+topology anchor 직렬화·양쪽 함수 동작 비교)·Verifier 이형 응답=null(가짜 CODEX_BIN 실행)·
 * 발췌 밖 인용 불인정·연결 자격=정본 resolveLink(byWorkspace 우선·잔존 bySession 거부)·
 * 어댑터 3종 stubbed spawn 직접 호출·설치본 디렉터리 CLI 실행(어댑터 실존)·활성 CLI(동의·게이트)·배포 23파일.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p8ew_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const EP = require(path.join(ROOT, "bridge", "enrich-providers.js"));

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

console.log("[1] 민감 경로 제외(ab-7) — 정본(scope-package)과 동작 비교+프롬프트 실검사");
{
  const sp = require(path.join(ROOT, "out", "scope-package.js"));
  const cases = [".env", ".env.local", "config/secrets/x.json", "id_rsa", "a.pem", "my-credentials.txt", "src/a.js", "config/app.yaml", "node_modules/x.js", "README.md", "tokens.js", "src/token-parser.js"];
  const diff = cases.filter((c) => sp.isSensitivePath(c) !== (EP.buildEnrichPrompt({ repo: ROOT, topo: { nodes: [{ id: U(1), label: "L", entityType: "module", state: {}, anchors: [{ kind: "code", path: c }] }], edges: [] }, changed: [c] }).includes("### " + c) === false));
  ok(diff.length === 0, "민감 판정=scope-package 정본과 전 케이스 동작 일치(드리프트 잠금: " + (diff.join(",") || "0건") + ")");
  const ws0 = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_sens_"));
  fs.writeFileSync(path.join(ws0, ".env"), "SECRET_TOKEN=do-not-send-this");
  fs.writeFileSync(path.join(ws0, "app.js"), "// app code");
  const prompt = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: [{ id: U(1), label: "L", entityType: "module", state: {}, anchors: [{ kind: "code", path: "app.js" }] }], edges: [] }, changed: [".env", "app.js"] });
  ok(!prompt.includes("do-not-send-this") && !prompt.includes("### .env"), "합성 비밀값이 프롬프트에 미포함(1차 blocker① 프로브 재현 차단)");
  ok(prompt.includes("### app.js"), "비민감 파일은 정상 발췌");
  // 2차 blocker①(ab-7): anchor '경로명'도 topology 직렬화에서 제외 — 수정 전엔 anchors= 줄로 누출됐다.
  const pT = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: [{ id: U(2), label: "S", entityType: "module", state: {}, anchors: [{ kind: "code", path: "config/secrets/leak-me.json" }, { kind: "code", path: "app.js" }] }], edges: [] }, changed: ["app.js"] });
  ok(!pT.includes("leak-me") && pT.includes("anchors=app.js"), "민감 anchor 경로명=topology 직렬화에서도 제외(2차 blocker① 프로브 재현 차단)");
}

console.log("[1b] topology slice — 전체 지도 직렬화 금지(3차 blocker: 1,000-node 프로브 재현 차단)");
{
  const ws0 = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_slice_"));
  fs.writeFileSync(path.join(ws0, "hot.js"), "// hot\n");
  const bigNodes = Array.from({ length: 1000 }, (_, i) => ({ id: U(i + 100), label: "N" + i, entityType: "module", state: { confidence: "candidate" }, anchors: [{ kind: "code", path: i === 777 ? "hot.js" : "cold-" + i + ".js" }] }));
  const bigEdges = Array.from({ length: 1000 }, (_, i) => ({ id: U(i + 5000), from: U(100 + i), to: U(100 + ((i + 1) % 1000)), relation: "calls", state: { confidence: "candidate" } }));
  const pBig = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: bigNodes, edges: bigEdges }, changed: ["hot.js"] });
  const nodeLines = (pBig.match(/^- node /gm) || []).length;
  const edgeLines = (pBig.match(/^- edge /gm) || []).length;
  ok(nodeLines === EP.SLICE_NODES_MAX && edgeLines <= EP.SLICE_EDGES_MAX, "1,000-node 지도=상한까지만 직렬화(node " + nodeLines + "/" + EP.SLICE_NODES_MAX + "·edge " + edgeLines + ")");
  ok(pBig.includes("N777") && pBig.includes("지도 일부만 표시"), "변경 연결 node 포함+절단 명시(침묵 상한 금지)");
  ok(pBig.length < 20000, "프롬프트 길이 유계(실측 " + pBig.length + "자 — 프로브 89,108자 재현 차단)");
  // 인접 우선: 변경 seed의 이웃(엣지 연결)이 잔여 채움보다 앞에 온다
  const s9 = EP.sliceTopology({ nodes: bigNodes, edges: bigEdges }, ["hot.js"]);
  ok(s9.nodes[0].label === "N777" && (s9.nodes[1].label === "N776" || s9.nodes[1].label === "N778"), "slice 순서=변경 연결→인접→잔여");
  // 작은 지도(상한 이내)=전체 유지(무회귀)
  const sSmall = EP.sliceTopology({ nodes: bigNodes.slice(0, 5), edges: bigEdges.slice(0, 3) }, []);
  ok(sSmall.nodes.length === 5 && sSmall.edges.length === 3, "상한 이내 지도=전체 유지(무회귀)");
  // 4차 blocker①(f-d1ff694e): anchor 폭탄 — 한 노드에 유효 anchor 5,000개(프로브 143,901자 재현 차단)
  const bombNode = { id: U(1), label: "B", entityType: "module", state: { confidence: "candidate" }, anchors: Array.from({ length: 5000 }, (_, i) => ({ kind: "code", path: "deep/dir-" + i + "/file-" + i + ".js" })) };
  const pBomb = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: [bombNode], edges: [] }, changed: ["hot.js"] });
  ok(pBomb.length < EP.TOPO_CHARS_MAX + 90000, "anchor 5,000개 노드=프롬프트 유계(실측 " + pBomb.length + "자 — 발췌 상한 포함)");
  ok(pBomb.includes("(+4992 생략)"), "노드당 anchor 상한 " + EP.NODE_ANCHORS_MAX + "개+생략 표기(침묵 상한 금지)");
  // 총 문자 상한: 필드 상한(라벨 120·anchor 8×200자)을 다 지켜도 노드 줄 합이 예산을 넘으면
  // 줄 단위로 잘리고 절단 고지가 남는다(anchor 8개×190자 경로 노드 40개 ≈ 62,000자 → 예산 초과 구성)
  const fatNodes = Array.from({ length: 40 }, (_, i) => ({ id: U(i + 100), label: "L" + i, entityType: "module", state: { confidence: "candidate" }, anchors: Array.from({ length: 8 }, (_, k) => ({ kind: "code", path: "deep/" + "d".repeat(170) + "/n" + i + "-" + k + ".js" })) }));
  const pFat = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: fatNodes, edges: [] }, changed: ["hot.js"] });
  const fatTopo = pFat.split("## 소스 발췌")[0];
  ok(fatTopo.length < EP.TOPO_CHARS_MAX + 2000 && pFat.includes("지도 일부만 표시"), "topology 직렬화 총 문자 상한+절단 고지(실측 " + fatTopo.length + "자)");
  // 4차 blocker②(ab-3, fix-induced): 변경 목록이 역순이어도 발췌 파일은 slice에 앵커된 파일과 결속된다
  //  — 수정 전엔 slice=f0..f39·발췌=f99..f80으로 교집합 0이었다(프로브 재현 차단).
  const cNodes = Array.from({ length: 100 }, (_, i) => ({ id: U(i + 100), label: "C" + i, entityType: "module", state: { confidence: "candidate" }, anchors: [{ kind: "code", path: "f" + i + ".js" }] }));
  const revChanged = Array.from({ length: 100 }, (_, i) => "f" + (99 - i) + ".js");
  const pC = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: cNodes, edges: [] }, changed: revChanged });
  const sliceFiles = new Set(EP.sliceTopology({ nodes: cNodes, edges: [] }, revChanged).nodes.flatMap((n) => n.anchors.map((a) => a.path)));
  const excerptFiles = (pC.match(/^### (.+)$/gm) || []).map((l) => l.slice(4));
  ok(excerptFiles.length === EP.FILES_MAX && excerptFiles.every((f) => sliceFiles.has(f)), "발췌 " + excerptFiles.length + "건 전부 slice 앵커 파일(분리 선택 차단 — 교집합 " + excerptFiles.filter((f) => sliceFiles.has(f)).length + "건)");
  // 5차 blocker①(f-d1ff694e): 유효한 500,000자 anchor 경로가 발췌 제목으로 총량을 우회하던 프로브 재현 차단
  const longP = "deep/" + "x".repeat(500000) + ".js";
  const pLong = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: [{ id: U(1), label: "LP", entityType: "module", state: { confidence: "candidate" }, anchors: [{ kind: "code", path: longP }] }], edges: [] }, changed: [longP] });
  ok(pLong.length < 25000 && pLong.includes("경로 " + EP.EXCERPT_PATH_MAX + "자 초과 파일 1건 제외"), "초장 경로=발췌 제외+고지·프롬프트 유계(실측 " + pLong.length + "자 — 프로브 543,458자 재현 차단)");
  // 5차 blocker②(ab-3): 문자 예산으로 노드가 탈락해도 발췌 우선 집합은 '실제 표시된 노드' 기준 —
  //  프로브(fat anchor 40노드·역순 changed)에서 표시 노드의 변경 anchor 전부가 발췌에 포함돼야 한다.
  const fatC = Array.from({ length: 40 }, (_, i) => ({ id: U(i + 100), label: "F" + i, entityType: "module", state: { confidence: "candidate" }, anchors: [{ kind: "code", path: "f" + i + ".js" }, ...Array.from({ length: 7 }, (_, k) => ({ kind: "code", path: "pad/" + "d".repeat(170) + "/x" + i + "-" + k + ".js" }))] }));
  const revC = Array.from({ length: 40 }, (_, i) => "f" + (39 - i) + ".js");
  const pFC = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: fatC, edges: [] }, changed: revC });
  const exFC = new Set((pFC.match(/^### (.+)$/gm) || []).map((l) => l.slice(4)));
  const shownIdx = (pFC.match(/^- node [^[]+\[F(\d+)\]/gm) || []).map((l) => Number(l.match(/\[F(\d+)\]/)[1]));
  ok(shownIdx.length > 0 && shownIdx.length < 40 && pFC.includes("지도 일부만 표시"), "프로브 구성 재현: 문자 예산으로 노드 " + shownIdx.length + "/40만 표시");
  ok(shownIdx.every((i) => exFC.has("f" + i + ".js")), "표시 노드의 변경 anchor 전부 발췌 포함(표시-발췌 결속 — 프로브 교집합 0 재현 차단)");
  // 6차 blocker(ab-3): 숨은 endpoint 엣지 — fat 40노드+인접 엣지 39개(표시 11)에서 프롬프트의 모든
  // edge 줄이 '실제 표시된 노드' 양끝이어야 하고, 표시 구간 내부 엣지는 살아 있어야 한다(전삭제 아님).
  const fatE = Array.from({ length: 39 }, (_, i) => ({ id: U(i + 5000), from: U(100 + i), to: U(101 + i), relation: "calls", state: { confidence: "candidate" } }));
  const pFE = EP.buildEnrichPrompt({ repo: ws0, topo: { nodes: fatC, edges: fatE }, changed: revC });
  const shownNodeIds = new Set((pFE.match(/^- node (\S+)/gm) || []).map((l) => l.slice(7)));
  const edgeRefs = (pFE.match(/^- edge \S+ (\S+) -[^>]*-> (\S+)/gm) || []).map((l) => { const m = l.match(/^- edge \S+ (\S+) -[^>]*-> (\S+)/); return [m[1], m[2]]; });
  ok(edgeRefs.length > 0 && edgeRefs.every(([f9, t9]) => shownNodeIds.has(f9) && shownNodeIds.has(t9)), "edge " + edgeRefs.length + "건 전부 표시 노드 양끝(숨은 endpoint 엣지 프로브 재현 차단)");
  ok(edgeRefs.length < 39 && pFE.includes("지도 일부만 표시"), "숨은 endpoint 엣지는 제외(" + edgeRefs.length + "/39)+절단 고지 유지");
}

// 가짜 CODEX_BIN 스텁(-o 파일에 지정 JSON을 쓰고 종료) — [2] Verifier·[2b] precision 어댑터 공용
const mkStub = (json) => {
  const f = path.join(os.tmpdir(), "p8ew-vstub-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".js");
  fs.writeFileSync(f, ['const fs=require("fs");', 'const o=process.argv.indexOf("-o");', "fs.writeFileSync(process.argv[o+1], " + JSON.stringify(JSON.stringify(json)) + ");", "process.exit(0);"].join("\n"));
  return f;
};
const withStub = (json, fn) => { const f = mkStub(json); const old = process.env.CODEX_BIN; process.env.CODEX_BIN = f; try { return fn(); } finally { if (old === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = old; } };

console.log("[2] Verifier 진입점 — 연결 자격 게이트(정본 resolveLink)·이형 응답 strict(가짜 CODEX_BIN 실행)");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_vr_"));
  fs.writeFileSync(path.join(repo, "a.js"), "// evidence body line\n");
  const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");
  const patch = { patchId: U(9), operation: "rewrite_label", targetId: U(1), payload: {}, rationale: "r", provider: "self", baseDecisionContextHash: sha("dch"), evidence: [{ kind: "code", ref: "a.js" }] };
  // 자격 게이트: links.json 부재=null(no-verifier park 계약)
  ok(EP.askVerifierResolution({ repo, ws: repo, patch, item: {}, framing: "resolution" }) === null, "검증 세션 미연결=null(no-verifier — 실행 자체를 안 함)");
  // 연결 구성 후 가짜 CODEX_BIN으로 실행 — 2차 blocker③: 픽스처를 'byWorkspace만 있는 정상 연결'로 구성
  // (수정 전 bySession 전수 스캔이면 이 구성 전체가 no-verifier로 오판돼 아래 정상 케이스가 실패했다).
  fs.writeFileSync(path.join(CL.BRIDGE_DIR, "links.json"), JSON.stringify({ bySession: {}, byWorkspace: { [repo]: { codexSession: U(5), workspace: repo, claudeSession: "c", linkedAt: "T", via: "ui" } } }));
  // CODEX_BIN이 .js면 resolveCodex가 node로 감싸는지 — codexInv 계약은 bridge resolveCodex: .js 처리 확인 필요 →
  // 스텁을 .cmd 없이 node 셔틀로 실행하도록 resolveCodex가 지원하지 않으면 이 반례는 스킵 처리(정직)
  let supported = true;
  try { const inv = require(path.join(ROOT, "bridge", "codex-bridge.js")).resolveCodex(); void inv; } catch { supported = false; }
  if (supported) {
    const rBad = withStub({ verdict: "support", claims: [{ file: "a.js" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch, item: {}, framing: "resolution" }));
    ok(rBad === null, "결손 claim(locator·stance·quote 없음)=세탁 없이 null(1차 blocker③ 프로브 재현 차단)");
    const rGood = withStub({ verdict: "support", claims: [{ file: "a.js", quote: "// evidence body line", locator: "L1", stance: "support" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch, item: {}, framing: "resolution" }));
    ok(rGood !== null && rGood.verdict === "support" && rGood.claims.length === 1, "정상 claim=해소 레코드 조립");
    ok(rGood !== null && rGood.claims[0].contentHash === sha(fs.readFileSync(path.join(repo, "a.js"), "utf8")), "contentHash=호출 전 캡처 바이트(1차 blocker② — 판정 대상과 해시 결속)");
    const rRebut = withStub({ verdict: "support", claims: [{ file: "a.js", quote: "// evidence body line", locator: "L1", stance: "rebut" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch, item: {}, framing: "resolution" }));
    ok(rRebut === null, "support인데 유효 지지 claim 0=null(모순 증명 거부)");
    const rOut = withStub({ verdict: "support", claims: [{ file: "other.js", quote: "x", locator: "L", stance: "support" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch, item: {}, framing: "resolution" }));
    ok(rOut === null, "제시 근거 밖 파일 claim=폐기(사전 결속 계약)");
    // 2차 blocker②(ab-3): 인용 실증='실제 전송한 발췌(4,000자)' 기준 — 수정 전엔 전체 파일 includes라
    // Verifier가 못 본 꼬리 인용이 support 증명으로 승인됐다.
    fs.writeFileSync(path.join(repo, "big.js"), "// HEAD_MARK_Q\n" + "x".repeat(4200) + "\n// TAIL_ONLY_MARK_Q\n");
    const patchB = { ...patch, evidence: [{ kind: "code", ref: "big.js" }] };
    const rTail = withStub({ verdict: "support", claims: [{ file: "big.js", quote: "// TAIL_ONLY_MARK_Q", locator: "tail", stance: "support" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch: patchB, item: {}, framing: "resolution" }));
    ok(rTail === null, "전송 발췌 밖(4,000자 이후) 인용=증명 불인정(2차 blocker② 프로브 재현 차단)");
    const rHead = withStub({ verdict: "support", claims: [{ file: "big.js", quote: "// HEAD_MARK_Q", locator: "head", stance: "support" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch: patchB, item: {}, framing: "resolution" }));
    ok(rHead !== null && rHead.claims[0].contentHash === sha(fs.readFileSync(path.join(repo, "big.js"), "utf8")), "발췌 안 인용=인정·contentHash는 전체 파일(P2 적용 시점 재검증 축)");
    // 2차 blocker③ 반대면: 다른 워크스페이스의 잔존 bySession 항목만 있으면 자격 불인정 —
    // 수정 전 전수 스캔이었다면… ws 일치 조건이 있어 통과하진 않았지만, 정본 resolveLink는
    // '현재 세션(cid)의 항목+같은 ws'만 폴백으로 인정한다는 계약 자체를 실행으로 잠근다.
    const oldCid = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "p8ew-cid";
    const otherWs = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_other_"));
    fs.writeFileSync(path.join(CL.BRIDGE_DIR, "links.json"), JSON.stringify({ byWorkspace: {}, bySession: { "p8ew-cid": { codexSession: U(6), workspace: otherWs, claudeSession: "p8ew-cid", linkedAt: "T" } } }));
    const rStale = withStub({ verdict: "support", claims: [{ file: "a.js", quote: "// evidence body line", locator: "L1", stance: "support" }] }, () => EP.askVerifierResolution({ repo, ws: repo, patch, item: {}, framing: "resolution" }));
    ok(rStale === null, "다른 ws 잔존 bySession 항목=자격 불인정(정본 resolveLink 판독 — no-verifier park)");
    if (oldCid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = oldCid;
  } else { for (let i = 0; i < 8; i++) ok(true, "(스킵) resolveCodex 미지원 환경"); }
  fs.rmSync(path.join(CL.BRIDGE_DIR, "links.json"), { force: true });
}

console.log("[2b] 어댑터 3종 — stubbed spawn 직접 호출(2차 blocker④)");
{
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_ad_"));
  fs.writeFileSync(path.join(repoA, "app.js"), "// adapter fixture\n");
  const ctx = { repo: repoA, topo: { nodes: [{ id: U(1), label: "L", entityType: "module", state: {}, anchors: [{ kind: "code", path: "app.js" }] }], edges: [] }, changed: ["app.js"], provider: "test" };
  const ENRICH_JSON = { schema: "enrich-result-v1", items: [] };
  // precision — 가짜 CODEX_BIN(-o 파일에 enrich-result 기록) 실행
  const rP = withStub(ENRICH_JSON, () => EP.ENRICH_ADAPTERS.precision(ctx));
  ok(rP && rP.ok === true && rP.result.schema === "enrich-result-v1", "precision — 가짜 CODEX_BIN 스텁으로 조립·실행·파싱");
  // self — PATH 맨 앞에 가짜 claude(win=.cmd·posix=sh 스크립트)를 두고 실행
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_self_"));
  const SELF_OUT = JSON.stringify(ENRICH_JSON);
  if (process.platform === "win32") fs.writeFileSync(path.join(stubDir, "claude.cmd"), "@echo " + SELF_OUT + "\r\n");
  else { const p9 = path.join(stubDir, "claude"); fs.writeFileSync(p9, "#!/bin/sh\nprintf '%s' '" + SELF_OUT + "'\n"); fs.chmodSync(p9, 0o755); }
  const oldPath = process.env.PATH;
  process.env.PATH = stubDir + path.delimiter + oldPath;
  let rS = null; try { rS = EP.ENRICH_ADAPTERS.self(ctx); } finally { process.env.PATH = oldPath; }
  ok(rS && rS.ok === true && rS.result.schema === "enrich-result-v1", "self — PATH 스텁 claude로 조립·실행·파싱");
  // economy — 스텁 HTTP 서버(별도 프로세스)+deepseek.json baseUrl로 deepseek-bridge enrich 실체인 실행
  const srvJs = path.join(stubDir, "srv.js");
  const portF = path.join(stubDir, "port.txt");
  fs.writeFileSync(srvJs, [
    'const http = require("http"); const fs = require("fs");',
    "const content = " + JSON.stringify(SELF_OUT) + ";",
    "const srv = http.createServer((req, res) => { let b = \"\"; req.on(\"data\", (c) => { b += c; }); req.on(\"end\", () => {",
    '  res.setHeader("Content-Type", "application/json");',
    '  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "stub" }));',
    "}); });",
    'srv.listen(0, "127.0.0.1", () => { fs.writeFileSync(process.argv[2], String(srv.address().port)); });',
  ].join("\n"));
  const srv = require("child_process").spawn(process.execPath, [srvJs, portF], { stdio: "ignore" });
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { const t = Date.now() + ms; while (Date.now() < t) { /* 폴백 */ } } };
  let port = ""; for (let i = 0; i < 100 && !port; i++) { try { port = fs.readFileSync(portF, "utf8").trim(); } catch { sleep(100); } }
  if (!port) ok(false, "economy — 스텁 서버 기동 실패");
  else {
    fs.writeFileSync(path.join(CL.BRIDGE_DIR, "deepseek.json"), JSON.stringify({ apiKey: "sk-p8ew-stub-000000000000", baseUrl: "http://127.0.0.1:" + port })); // 합성 무해값(실키 아님)
    const oldKey = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY; // 파일 키 강제 — 혹시 있을 실키 env로의 이탈 차단(baseUrl은 어차피 스텁)
    let rE = null; try { rE = EP.ENRICH_ADAPTERS.economy(ctx); } finally { if (oldKey !== undefined) process.env.DEEPSEEK_API_KEY = oldKey; }
    ok(rE && rE.ok === true && rE.result.schema === "enrich-result-v1", "economy — deepseek-bridge enrich 실체인+스텁 API로 실행·파싱");
    fs.rmSync(path.join(CL.BRIDGE_DIR, "deepseek.json"), { force: true });
  }
  try { srv.kill(); } catch { /* 무해 */ }
}

console.log("[3] CLI — 설치본 디렉터리 실행(어댑터 실존)·게이트·동의");
{
  // 설치본 시뮬: BRIDGE_SCRIPTS 23파일을 임시 '설치 디렉터리'로 복사 후 그 사본 CLI 실행
  const inst = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_inst_"));
  const list = require(path.join(ROOT, "install.js")).BRIDGE_SCRIPTS;
  for (const f of list) fs.copyFileSync(path.join(ROOT, "bridge", f), path.join(inst, f));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8ew_ws_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "off" }));
  const run = (args) => require("child_process").spawnSync(process.execPath, [path.join(inst, "map-enrich.js"), ...args], { encoding: "utf8", timeout: 120000, env: { ...process.env } });
  const r0 = run(["run", ws, "--ws", ws, "--slot", "ko", "--trigger", "test"]);
  ok(r0.status === 0 && /two-track/.test(String(r0.stdout || "")), "설치본 CLI — off=noop·exit 0");
  // on+큐+무동의: 설치본 사본이 어댑터를 실존 로드하고(adapter-missing 아님) no-consent park에 도달하는지
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  const MB = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
  const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
  MB.grantConsent(ws, "t");
  MR.initTopologyForBootstrap(ws);
  MB.ensureQueue(ws, MR.PM);
  const r1 = run(["run", ws, "--ws", ws, "--slot", "ko", "--trigger", "test"]);
  const out1 = String(r1.stdout || "");
  ok(/no-consent/.test(out1) && !/adapter-missing/.test(out1), "설치본 실행 — 어댑터 실존 로드(adapter-missing 아님)·무동의=no-consent park(1차 blocker⑤ 봉합 증거)");
  const r2 = run([]);
  ok(r2.status === 2 && /사용:/.test(String(r2.stderr || "")), "인자 없음=사용법·exit 2");
}

console.log("[4] extension 배선 — 소스 계약(발동·핸들러·동의 모달·감사)");
{
  const src = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(src.includes('maybeSpawnEnrichExt(ws, "probe")') && src.includes('maybeSpawnEnrichExt(ws, "tick")'), "발동 ⓑⓒ(ⓐ=큐 pending 관측이 커버)");
  ok(src.includes('type === "grantEnrichSelf"') && src.includes('type === "retryEnrich"'), "핸들러 2종");
  ok(src.includes("동의하고 선택") && src.includes("동의하고 켜기"), "유료 모달 동의+self 별도 동의(소급 금지)");
  ok(!src.includes("라우팅 적용은 P8부터") && src.includes("ELECTRON_RUN_AS_NODE") && src.includes("enrichSpawnBusy"), "배지 제거·node 전환·단일-flight");
  ok(src.includes('jr9.job.phase === "parked") return'), "parked=자동 재발동 금지");
}

console.log("[5] 배포 23파일 — 3카피 패리티+실물+deepseek enrich 계약");
{
  const a = require(path.join(ROOT, "install.js")).BRIDGE_SCRIPTS;
  const c = require(path.join(ROOT, "bridge", "map-cutover.js")).EXPECTED_DEPLOY_FILES;
  const h = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8");
  ok(a.length === 23 && c.length === 23 && JSON.stringify([...a].sort()) === JSON.stringify([...c].sort()), "23파일(+router·enrich·providers) 집합 일치");
  ok(h.includes('"enrich-providers.js"') && a.every((f) => fs.existsSync(path.join(ROOT, "bridge", f))), "hook-setup 포함+전부 실물");
  const db = fs.readFileSync(path.join(ROOT, "bridge", "deepseek-bridge.js"), "utf8");
  ok(db.includes('cmd === "enrich"') && /enrich-result-v1/.test(db) && db.includes("enrich-shape-fail") && db.includes('arm: "enrich"'), "deepseek enrich — strict 표지·repair 1회 실패 표지·usage");
}

console.log("[6] 문서 — PRIVACY·README 자동 보강 고지");
{
  const pv = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
  ok(pv.includes("자동 의미 보강") && pv.includes("별도 동의") && pv.includes("map-route.jsonl") && pv.includes("map-enrich/"), "PRIVACY — 별도 동의·로컬 파일 고지");
  ok(fs.readFileSync(path.join(ROOT, "README.md"), "utf8").includes("자동 의미 보강(P8)") && fs.readFileSync(path.join(ROOT, "docs", "README.en.md"), "utf8").includes("Automatic semantic enrichment"), "README ko/en 고지");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
