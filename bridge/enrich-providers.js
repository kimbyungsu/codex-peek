/*
 * P8 증분 4 — 의미 보강 어댑터 3종+프롬프트 빌더+Verifier 해소 진입점(정본 'P8 상세 설계 v10~v11' P8-3·P8-4).
 * scout-providers와 별도(영향지도 ①~⑥ 양식과 다른 작업 — 산출=enrich-result-v1 typed JSON).
 * 어댑터 계약(runEnrich 주입형): (ctx{repo, topo, changed, provider}) => {ok:true, result}|{ok:false, detail}.
 * strict 합타입·ID 실존·근거 실증(quote 대조)은 실행기(map-enrich)가 수행 — 여기서는 호출·형태 회복만.
 * self=구독 Claude(무과금)·economy=deepseek-bridge enrich(과금·bounded repair 1회는 브릿지)·
 * precision=codex exec --ephemeral 독립 1회(P6 문법 — 검증 세션 무잔재).
 * askVerifierResolution=1-4 부작용 없는 진입점: 검증 부작용 5연쇄·계약 주입·phase 표시 전부 미호출 —
 * P6에서 상시 Scout 세션이 ephemeral 1회 실행으로 대체된 결정(사용자 승인)과 동형으로, 해소 질의도
 * codex exec --ephemeral 독립 1회(부작용 물리적 0·rollout 무잔재).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const BR = __dirname; // bridge 계층(증분 4 1차 blocker⑤ — 설치본 자동 발동에서 어댑터 실존해야 하므로 배포 대상으로 이동)
const CL = require(path.join(BR, "contract-lib.js"));

const SELF_DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";

// 민감 경로 제외(증분 4 1차 blocker① ab-7 — 정찰 꾸러미와 같은 규칙): 정본은 scope-package.js의
// SENSITIVE_PATH_RE — 배포본(bridge)은 out/에 의존할 수 없어 동형 복제하고, 드리프트는 테스트가 양쪽
// 함수의 동작 비교로 잠근다. 민감 파일은 발췌·근거 본문 어디에도 싣지 않는다(전송 안전).
const SENSITIVE_PATH_RE = /(^|\/)\.(env[^/]*|netrc|npmrc|pgpass|htpasswd)$|(^|[/._-])(secrets?|credentials?|tokens?|api[_-]?keys?|passwords?|passwd)([/._-]|$)|\.(pem|key|p12|pfx|jks|keystore|der|p8|ppk)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|(^|\/)(node_modules|dist|build|vendor)\//i;
function isSensitiveEnrichPath(p) { return SENSITIVE_PATH_RE.test(String(p || "").replace(/\\/g, "/")); }

// ── 프롬프트 빌더(전 provider 공용 — 입력 동일 조건) ─────────────────────────────
// topology slice(노드·엣지 요약)+변경 파일 발췌(각 상한)+enrich-result-v1 스키마 지시.
const FILE_EXCERPT_MAX = 4000;
const FILES_MAX = 20;
// 3차 blocker(topology slice): 전체 지도 직렬화 금지(정본 P8-3 '입력=topology slice' — 대형 지도에서
// 전송·컨텍스트·과금 팽창). 변경 파일 앵커 연결 node 우선 → 그 인접 node → 잔여 채움 순으로 상한까지만.
// 작은 지도(상한 이내)는 전체 유지(무회귀). 절단 시 프롬프트에 명시(침묵 상한 금지).
const SLICE_NODES_MAX = 40;
const SLICE_EDGES_MAX = 60;
function sliceTopology(t, changedList) {
  const allN = t.nodes || [], allE = t.edges || [];
  const changed = new Set(changedList || []);
  const seedIds = new Set(allN.filter((n) => (n.anchors || []).some((a) => a && changed.has(a.path))).map((n) => n.id));
  const neighborIds = new Set();
  for (const e of allE) {
    if (seedIds.has(e.from)) neighborIds.add(e.to);
    if (seedIds.has(e.to)) neighborIds.add(e.from);
  }
  const pickedIds = new Set(), picked = [];
  const push9 = (n) => { if (picked.length < SLICE_NODES_MAX && !pickedIds.has(n.id)) { pickedIds.add(n.id); picked.push(n); } };
  for (const n of allN) if (seedIds.has(n.id)) push9(n); // ① 변경 연결
  for (const n of allN) if (neighborIds.has(n.id)) push9(n); // ② 인접
  for (const n of allN) push9(n); // ③ 잔여(작은 지도=전체 유지)
  const edges = allE.filter((e) => pickedIds.has(e.from) && pickedIds.has(e.to)).slice(0, SLICE_EDGES_MAX);
  return { nodes: picked, edges, totalNodes: allN.length, totalEdges: allE.length };
}
// 4차 blocker①(f-d1ff694e): node·edge '개수'만 제한하면 anchor 5,000개짜리 유효 노드 하나로 다시 무제한
// 팽창한다 — 필드 단위 상한(anchor 노드당 개수·경로/라벨 문자)+topology 직렬화 총 문자 상한을 함께 건다.
const NODE_ANCHORS_MAX = 8;
const TOPO_CHARS_MAX = 20000;
// 줄 목록을 문자 예산까지만 취하고 버린 줄 수+유지된 원본 인덱스를 보고(침묵 상한 금지·표시-발췌 결속 재료)
function capLines(lines, budget) {
  const kept = [], keptIdx = []; let used = 0, dropped = 0;
  for (let i = 0; i < lines.length; i++) { const ln = lines[i]; if (used + ln.length + 1 <= budget) { kept.push(ln); keptIdx.push(i); used += ln.length + 1; } else dropped++; }
  return { text: kept.join("\n"), dropped, keptIdx };
}
// 5차 blocker①(f-d1ff694e): 초장 anchor 경로가 발췌 제목("### <경로>")으로 총량 상한을 우회 —
// 경로 자체가 이 길이를 넘는 파일은 발췌 대상에서 제외(제목 절단은 모델의 file 인용과 어긋나므로 금지)+고지.
const EXCERPT_PATH_MAX = 200;
function buildEnrichPrompt(ctx) {
  const t = sliceTopology(ctx.topo || {}, ctx.changed);
  // 2차 blocker①(ab-7): 민감 경로는 '경로명 자체'도 topology 직렬화에서 제외 — 발췌만 걸러선 anchor 줄로 새어나간다.
  const anchorsOf = (n) => {
    const list = (n.anchors || []).map((a) => a.path).filter((p9) => !isSensitiveEnrichPath(p9));
    const shown = list.slice(0, NODE_ANCHORS_MAX).map((p9) => String(p9).slice(0, 200));
    return shown.join(",") + (list.length > shown.length ? `,(+${list.length - shown.length} 생략)` : "");
  };
  const nodeLines = (t.nodes || []).map((n) => `- node ${n.id} [${String(n.label || "").slice(0, 120)}] ${n.entityType} conf=${(n.state || {}).confidence} anchors=${anchorsOf(n)}`);
  const nCap = capLines(nodeLines, Math.floor(TOPO_CHARS_MAX * 0.8));
  const shownNodes = nCap.keptIdx.map((i) => (t.nodes || [])[i]);
  // 6차 blocker(ab-3): edge는 '실제 표시된 노드' 양끝만 직렬화 — 문자 예산으로 숨은 endpoint의 엣지가
  // 남으면 모델이 표시 발췌를 그 엣지에 결속해 auto 적용되는 경로가 열린다(slice 자기완결).
  const shownIds9 = new Set(shownNodes.map((n) => n.id));
  const visEdges = (t.edges || []).filter((e) => shownIds9.has(e.from) && shownIds9.has(e.to));
  const edgeLines = visEdges.map((e) => `- edge ${e.id} ${e.from} -${String(e.relation || "").slice(0, 40)}-> ${e.to} conf=${(e.state || {}).confidence}`);
  const eCap = capLines(edgeLines, TOPO_CHARS_MAX - Math.min(TOPO_CHARS_MAX * 0.8, nCap.text.length));
  const nodes = nCap.text, edges = eCap.text;
  const shownN = nodeLines.length - nCap.dropped, shownE = edgeLines.length - eCap.dropped;
  const truncNote = (t.totalNodes > shownN || t.totalEdges > shownE)
    ? `(지도 일부만 표시: node ${shownN}/${t.totalNodes} · edge ${shownE}/${t.totalEdges} — 이번 변경과 연결된 항목 우선)` : "";
  // 4차 blocker②(ab-3, fix-induced): 발췌 파일을 slice와 결속 — 변경 목록이 상한을 넘을 때 slice에
  // 앵커된 파일을 먼저 취해, '직렬화된 노드'와 '발췌 파일'이 서로 무관해지는 분리 선택을 차단한다.
  // 5차 blocker②(ab-3): 결속 기준은 '절단 전 slice'가 아니라 capLines가 실제로 유지한 표시 노드 —
  // 문자 예산으로 탈락한 노드의 anchor가 발췌 우선순위를 차지하는 재분리를 막는다(shownNodes는 위에서 산출).
  const sliceAnchored = new Set(shownNodes.flatMap((n) => (n.anchors || []).map((a) => a.path)));
  const changed9 = Array.isArray(ctx.changed) && ctx.changed.length ? ctx.changed : null;
  const ordered = changed9
    ? [...changed9.filter((f) => sliceAnchored.has(f)), ...changed9.filter((f) => !sliceAnchored.has(f))]
    : [...sliceAnchored];
  const okPath = (f) => !isSensitiveEnrichPath(f) && String(f).length <= EXCERPT_PATH_MAX; // 민감 경로+초장 경로=목록에서부터 제외(ab-7·f-d1ff694e)
  const files = ordered.filter(okPath).slice(0, FILES_MAX);
  const longExcluded = ordered.filter((f) => !isSensitiveEnrichPath(f) && String(f).length > EXCERPT_PATH_MAX).length;
  const excerpts = files.map((f) => {
    let body = "";
    try { body = fs.readFileSync(path.join(ctx.repo, f), "utf8").slice(0, FILE_EXCERPT_MAX); } catch { body = "(판독 불가)"; }
    return "### " + f + "\n```\n" + body + "\n```";
  }).join("\n\n");
  return [
    "당신은 코드 구조 지도의 '의미 보강' 담당이다. 아래 지도 초안과 소스 발췌만 근거로, 지도 항목의 의미를 보강하는 제안을 JSON으로만 출력하라.",
    "",
    "## 지도 초안(노드·엣지)", ...(truncNote ? [truncNote] : []), nodes || "(없음)", edges || "(없음)",
    "", "## 소스 발췌", ...(longExcluded ? [`(경로 ${EXCERPT_PATH_MAX}자 초과 파일 ${longExcluded}건 제외)`] : []), excerpts || "(없음)",
    "",
    "## 출력 계약(이 JSON 객체 '만' — 설명·코드펜스 금지)",
    '{"schema":"enrich-result-v1","items":[...]}',
    "items의 각 원소는 다음 중 하나(모든 원소에 evidence:[{file,quote}] 필수 — quote는 위 발췌에 '실제로 존재하는' 원문 그대로):",
    '- {"op":"add_evidence","targetId":"<실존 node/edge id>","payload":{"evidence":{"kind":"code","ref":"<파일>","note":"<근거 설명>"}},"evidence":[...]}',
    '- {"op":"set_state","targetId":"<실존 id>","payload":{"to":{"confidence":"confirmed"},"expect":{"confidence":"<현재 값>"}},"evidence":[...]} — 확신 상향(하향은 확실한 반증이 있을 때만)',
    '- {"op":"add_anchor","targetId":"<실존 node id>","payload":{"anchor":{"kind":"code","path":"<파일>"}},"evidence":[...]}',
    '- {"op":"add_edge","payload":{"edge":{"id":"<새 UUID>","from":"<실존 node id>","to":"<실존 node id>","relation":"calls|stores|reads|configures|serves|tests","state":{"lifecycle":"active","implementation":"runtime","confidence":"candidate"}}},"evidence":[...]} — targetId 금지',
    '- {"op":"rewrite_label","targetId":"<실존 id>","payload":{"to":{"label":"<개선 라벨>"},"expect":{"label":"<현재 라벨>"}},"evidence":[...],"claims":[{"file":"<파일>","quote":"<원문>","stance":"support"}]}',
    "확실한 근거가 있는 항목만(1~10개 권장). 근거 없는 추측·발췌 밖 인용 금지.",
  ].join("\n");
}

// 출력 파싱 — 코드펜스 제거만(bounded 추출)·JSON 파싱 실패=형태 실패(실행기 분류로)
function parseResult(txt) {
  const m = String(txt || "").match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (m ? m[1] : String(txt || "")).trim();
  try { const o = JSON.parse(body); return { ok: true, result: o }; } catch { return { ok: false, detail: "JSON 파싱 실패: " + body.slice(0, 120) }; }
}

// ── 어댑터 3종 ────────────────────────────────────────────────────────────────
const ENRICH_ADAPTERS = {
  self: (ctx) => {
    const r = spawnSync("claude", ["-p", "--output-format", "text", "--disallowedTools", SELF_DENY], {
      input: buildEnrichPrompt(ctx), encoding: "utf8", timeout: 8 * 60 * 1000, windowsHide: true,
      shell: process.platform === "win32", // npm 전역 셔틀(claude.cmd) 대응
    });
    if (r.error || r.status !== 0 || !String(r.stdout || "").trim()) return { ok: false, detail: ((r.error && r.error.message) || `exit=${r.status}`) + " " + String(r.stderr || "").slice(-200) };
    try { CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "enrich-self", model: null, usageIn: null, usageOut: null, pkgChars: buildEnrichPrompt(ctx).length, mapChars: r.stdout.length }); } catch { /* 무해 */ }
    return parseResult(r.stdout);
  },
  economy: (ctx) => {
    const bridge = path.join(BR, "deepseek-bridge.js"); // 브릿지가 bounded repair(원격 1회)+usage(arm enrich) 기록
    const r = spawnSync(process.execPath, [bridge, "enrich"], { input: buildEnrichPrompt(ctx), encoding: "utf8", timeout: 6 * 60 * 1000, windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, detail: ((r.error && r.error.message) || `exit=${r.status}`) + " " + String(r.stderr || "").slice(-200) };
    return parseResult(r.stdout);
  },
  precision: (ctx) => {
    let inv;
    try { inv = require(path.join(BR, "codex-bridge.js")).resolveCodex(); }
    catch (e) { return { ok: false, detail: "bridge-load: " + ((e && e.message) || "") }; }
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-codex-"));
    const outF = path.join(tmpCwd, "enrich-out.txt");
    try {
      const prompt = buildEnrichPrompt(ctx);
      const r = spawnSync(inv.file, [...(inv.args || []), ...CL.codexScoutExecArgs(outF)], { input: prompt, cwd: tmpCwd, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true, shell: !!inv.shell, stdio: ["pipe", "ignore", "pipe"] });
      let outTxt = "";
      try { outTxt = fs.readFileSync(outF, "utf8").trim(); } catch { /* 실패 판정 */ }
      try { CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "enrich-codex", model: null, usageIn: null, usageOut: null, pkgChars: prompt.length, mapChars: outTxt.length }); } catch { /* 무해 */ }
      if (r.error || r.status !== 0 || !outTxt) return { ok: false, detail: ((r.error && r.error.message) || `exit=${r.status}`) + " " + String(r.stderr || "").slice(-200) };
      return parseResult(outTxt);
    } finally { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 무해 */ } }
  },
};

// ── Verifier 해소 진입점(1-4 — 부작용 없는 별도 실행) ──────────────────────────
// codex exec --ephemeral 독립 1회: 검증 부작용 5연쇄·계약 주입·phase 표시 물리적 미호출·rollout 무잔재.
// 반환: 해소 레코드 {patchId, opHash, baseDecisionContextHash, verdict, claims}|null(실패=no-verifier park).
function askVerifierResolution(req) {
  // 증분 4 1차 blocker④: 'Verifier 역할 세션 연결 존재'를 자격 게이트로 유지(no-verifier park 계약 보존) —
  // 미연결이면 실행하지 않는다. 실행 자체는 ephemeral 독립 1회(부작용 물리 0 — 정본 v11 부기로 명문화:
  // 역할 세션 resume은 검증 부작용 5연쇄 코드와 결합돼 있어 분리 비용·오염 위험이 더 크다는 P6 동형 결정).
  // 2차 blocker③: 자격 판독=정본 resolveLink 재사용(byWorkspace 우선·bySession은 같은 ws 폴백만).
  // bySession 전수 스캔은 양쪽으로 틀린다 — byWorkspace만 있는 정상 연결(UI 지정)을 no-verifier로 오판하고,
  // 반대로 현재 연결이 아닌 잔존 세션 항목을 자격으로 오인한다. 대시보드·ask와 같은 기준을 본다.
  try {
    const CB9 = require(path.join(BR, "codex-bridge.js"));
    const lk9 = CB9.resolveLink(CB9.loadLinks(), String(req.ws || req.repo || ""));
    if (!lk9 || !lk9.codexSession) return null; // 미연결=no-verifier park(정본 계약 — 연결된 검증 세션이 있어야 자격)
  } catch { return null; } // 판독 불가=자격 불명=park(fail-closed)
  let inv;
  try { inv = require(path.join(BR, "codex-bridge.js")).resolveCodex(); } catch { return null; }
  const PM = require(path.join(BR, "project-map.js"));
  const opH = PM.opHashOf(req.patch);
  const evList = (req.patch.evidence || []).map((e) => e.ref).filter((f) => !isSensitiveEnrichPath(f)); // ab-7 — 민감 경로는 근거 본문에도 미포함
  // blocker② ab-3: 근거 본문·해시를 '호출 전 같은 판독'으로 캡처 — 해소 레코드는 Verifier가 실제로 본
  // 바이트의 해시에 결속(호출 중 편집=P2 적용 시점 재검증이 거부하는 방향으로 정합).
  const preRead = new Map(); // file → {body(전송 발췌), sha(전체 파일 — P2 적용 시점 재검증 대상)}
  for (const f of evList) {
    try { const buf = fs.readFileSync(path.join(req.repo, f)); preRead.set(f, { body: buf.toString("utf8").slice(0, FILE_EXCERPT_MAX), sha: require("crypto").createHash("sha1").update(buf).digest("hex") }); }
    catch { preRead.set(f, null); }
  }
  const bodyOf = (f) => { const r = preRead.get(f); return r ? r.body : "(판독 불가)"; };
  const prompt = [
    req.framing === "conflict"
      ? "구조 지도의 '충돌 판정'이다: 서로 다른 두 자동 담당의 결론이 상충한다. 아래 양측 자료를 근거로 새 제안을 지지(support)할지 반박(reject)할지, 판단이 불가하면 inconclusive를 판정하라."
      : "구조 지도 변경 제안의 '해소 판정'이다: 아래 제안과 근거를 검토해 지지(support)/반박(reject)/판정 불가(inconclusive)를 판정하라.",
    "",
    "## 제안(patch)", JSON.stringify({ op: req.patch.operation, targetId: req.patch.targetId, payload: req.patch.payload, rationale: req.patch.rationale, provider: req.patch.provider }, null, 1),
    ...(req.existing ? ["", "## 기존 측(현재 확정 상태의 출처)", JSON.stringify({ provider: req.existing.provider, decisionId: req.existing.decisionId, rationale: req.existing.rationale, evidence: req.existing.evidence, claims: req.existing.claims }, null, 1)] : []),
    "", "## 근거 파일(제시된 범위 안에서만 판정 — 범위 밖 파일 인용은 재제안 사유가 된다)",
    ...evList.map((f) => "### " + f + "\n```\n" + bodyOf(f) + "\n```"),
    "",
    "## 출력 계약(이 JSON 객체 '만' — 설명·코드펜스 금지)",
    '{"verdict":"support|reject|inconclusive","claims":[{"file":"<위 근거 파일 중 하나>","quote":"<파일 원문 그대로>","locator":"<위치 설명>","stance":"support|rebut"}]}',
    "support면 지지 claim을 1개 이상 포함하라. 각 claim의 quote는 해당 파일에 실제로 존재해야 한다.",
  ].join("\n");
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-adjud-"));
  const outF = path.join(tmpCwd, "verdict-out.txt");
  try {
    const r = spawnSync(inv.file, [...(inv.args || []), ...CL.codexScoutExecArgs(outF)], { input: prompt, cwd: tmpCwd, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true, shell: !!inv.shell, stdio: ["pipe", "ignore", "pipe"] });
    let outTxt = "";
    try { outTxt = fs.readFileSync(outF, "utf8").trim(); } catch { /* 실패 판정 */ }
    try { CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "enrich-adjudicate", model: null, usageIn: null, usageOut: null, pkgChars: prompt.length, mapChars: outTxt.length }); } catch { /* 무해 */ }
    if (r.error || r.status !== 0 || !outTxt) return null;
    const pr = parseResult(outTxt);
    if (!pr.ok || !pr.result || !["support", "reject", "inconclusive"].includes(pr.result.verdict)) return null;
    // 해소 레코드 조립(blocker③ ab-3 — 결손 claim 세탁 금지): strict — file이 제시 근거 안·locator 실문자열·
    // stance 정확 열거·quote가 '호출 전 캡처 원문'에 실존해야만 유효. 보정(기본값 채움) 전면 금지 — 이형은
    // 그 claim 폐기. support인데 유효 지지 claim 0=null(no-verifier park — 불완전 증명으로 적용 금지).
    const claims = (Array.isArray(pr.result.claims) ? pr.result.claims : []).map((c) => {
      if (!c || typeof c !== "object") return null;
      const f9 = String(c.file || "");
      const rec9 = preRead.get(f9);
      if (!rec9) return null; // 제시 근거 밖·판독 불가=폐기
      if (typeof c.locator !== "string" || !c.locator.trim()) return null;
      if (c.stance !== "support" && c.stance !== "rebut") return null;
      if (typeof c.quote !== "string" || !c.quote || !rec9.body.includes(c.quote)) return null; // 2차 blocker②(ab-3): 인용 실증='실제 전송한 발췌' 기준 — Verifier가 못 본 4,000자 이후 인용은 증명 불인정
      return { file: f9, contentHash: rec9.sha, locator: c.locator.slice(0, 200), stance: c.stance }; // 해시=호출 전 캡처한 전체 파일(P2 적용 시점 재검증과 같은 축)
    }).filter(Boolean);
    if (pr.result.verdict === "support" && !claims.some((c) => c.stance === "support")) return null;
    return { patchId: req.patch.patchId, opHash: opH, baseDecisionContextHash: req.patch.baseDecisionContextHash, verdict: pr.result.verdict, claims };
  } finally { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 무해 */ } }
}

module.exports = { ENRICH_ADAPTERS, buildEnrichPrompt, parseResult, askVerifierResolution, sliceTopology, SELF_DENY, FILE_EXCERPT_MAX, FILES_MAX, SLICE_NODES_MAX, SLICE_EDGES_MAX, NODE_ANCHORS_MAX, TOPO_CHARS_MAX, EXCERPT_PATH_MAX };
