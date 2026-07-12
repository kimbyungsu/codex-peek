/*
 * P3a — sig↔UUID 바인딩·legacy 이관 준비·권위 판별 (설계: docs/MAP-P3A-DESIGN.md §B~§D)
 * 불변 전제: 권위 marker 비활성 유지·기존 경로 100% 무변경·재배선은 P3b 원자 cutover에서(1-22·1-30).
 * repo 쓰기는 binding-confirm/rebind(사용자 명시 행위)의 project-map/bindings.json뿐 — 그 외 전부 로컬 서랍.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CL = require(path.join(__dirname, "contract-lib.js"));
const MR = require(path.join(__dirname, "map-runtime.js"));
const MP = require(path.join(__dirname, "map-pipeline.js"));
const PM = MR.PM;

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const NUL = "\u0000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX40 = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/; // 권위 계약의 ts는 ISO 8601(UTC)만(구현 1차 #9)

// 3치 판독(P2 readJson3 동형 — absent|ok|invalid|unreadable)
function readJson3(f) {
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; }
  try { return { st: "ok", data: JSON.parse(raw), raw }; } catch { return { st: "invalid" }; }
}
function fileSha3(f) {
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; }
  return { st: "ok", hash: sha1(raw), raw };
}
// 결정론 직렬화(키 정렬 — match 지문용)
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

// ── 확정층 판독 사본(src/map-ledger.ts parseApprovedFromMap과 동일 규칙 — 패리티 테스트 잠금) ────
function parseApprovedCopy(md) {
  const approved = [];
  let totalItems = 0;
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    totalItems++;
    const m = line.match(/^- (.*?) {2}<!-- 승인 (\d{4}-\d{2}-\d{2}) · 출처: (.*?) -->$/);
    if (m) approved.push({ text: m[1], date: m[2], from: m[3] });
  }
  return { approved, totalItems };
}
// 확정층 경로 규칙(mapLedgerFile 3처와 동일): docs/MAP.md → MAP.md 폴백. 반환 {rel, text}|null
function legacySourceFor(repo) {
  for (const rel of ["docs/MAP.md", "MAP.md"]) {
    try { return { rel, text: fs.readFileSync(path.join(repo, rel), "utf8") }; }
    catch (e) { if (!(e && e.code === "ENOENT")) return { err: rel + " 판독 실패(권한 등) — fail-closed" }; } // 부재만 폴백(구현 1차 #9)
  }
  return null;
}
// 비권위 진단 전용(§B blocked에서 legacy 원문이 필요한 소비자용 — 권위 아님)
function legacyPreviewFor(repo) { const s = legacySourceFor(repo); return s ? { rel: s.rel, text: s.text, authority: false } : null; }

// ── 원문 case 보존 경로 추출(4차 #2 — ledgerPathsFromText와 동일 토큰 규칙·소문자화만 생략) ─────
function caseAwarePathsFromText(text) {
  const out = [];
  for (const tok of String(text || "").replace(/`/g, "").split(/[\s,;|"'<>{}()[\]—·↔]+/)) {
    const noLine = tok.replace(/:(\d+)(?:-\d+)?$/, "");
    const t = noLine.replace(/^[^A-Za-z0-9_.\\/-]+|[^A-Za-z0-9_.\\/-]+$/g, "").replace(/[.,;:]+$/, "");
    if (!t || t.length > 200 || !/^[A-Za-z0-9_.\\/-]+$/.test(t)) continue;
    const hasSep = /[\\/]/.test(t);
    if (!hasSep && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue;
    if (hasSep && !/[A-Za-z]/.test(t.split(/[\\/]/).pop() || "")) continue;
    out.push(t.replace(/\\/g, "/")); // 소문자화 없음 — 대소문자 구분 저장소의 false match 차단(3차 #6)
  }
  return out;
}
// endpointsKeyOf bridge 사본(src/ledger-events.ts와 동일 규칙 — 패리티 테스트 잠금. 소문자 추출기 기반 유지)
function endpointsKeyOfCopy(text) {
  const paths = [...new Set(CL.ledgerPathsFromText(text))];
  if (paths.length < 2) return null;
  const t = String(text || "");
  const directed = t.includes("→") && !t.includes("↔");
  return directed ? "d|" + paths.join("|") : "b|" + paths.slice().sort().join("|");
}
// 공용 repo-relative 정규화(2차 #6): 구분자 통일·./ 제거·중복 / 축약. 절대·".."=null(미해소)
function normRelPath(p) {
  const t = String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (!t || /^([A-Za-z]:)?\//.test(t) || t.split("/").includes("..")) return null;
  return t;
}
const foldPath = (p) => String(p || "").toLowerCase();

// 경로 분류(4차 #6 — 우선순위 test > config > doc > code > unsupported. 카테고리 규칙·특정 파일명 하드코딩 아님)
const CODE_EXTS = new Set(["js", "ts", "jsx", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "swift", "sh", "ps1", "sql", "vue", "svelte"]);
const CONFIG_EXTS = new Set(["json", "yml", "yaml", "toml", "ini", "cfg", "conf"]);
const DOC_EXTS = new Set(["md", "txt", "rst", "adoc"]);
function classifyEvidencePath(rel) {
  const segs = String(rel || "").split("/");
  const base = segs[segs.length - 1] || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  const segSet = new Set(segs.slice(0, -1).map((x) => x.toLowerCase()));
  if (segSet.has("test") || segSet.has("tests") || segSet.has("spec") || segSet.has("__tests__") || /\.(test|spec)\./i.test(base)) return "test";
  if (CONFIG_EXTS.has(ext) || /^\.env(\..+)?$/i.test(base)) return "config";
  if (DOC_EXTS.has(ext)) return "doc";
  if (CODE_EXTS.has(ext)) return "code";
  return "unsupported";
}

// ── 권위 판별 §B — 단일 함수·P3a 기간 항상 legacy ────────────────────────────────
const AUTH_KEYS = "cutover,decisionRef,mapId,schema,ts";
const RECEIPT_KEYS = "authorityFileFp,authorityMode,authorityObject,decisionId,mapId,schema,ts";
function validReceipt(obj, fname) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (Object.keys(obj).sort().join(",") !== RECEIPT_KEYS) return false;
  if (obj.schema !== "map-cutover-receipt-v1") return false;
  if (typeof obj.decisionId !== "string" || !UUID_RE.test(obj.decisionId) || fname !== obj.decisionId + ".json") return false;
  if (typeof obj.mapId !== "string" || !UUID_RE.test(obj.mapId)) return false;
  const am = obj.authorityMode;
  if (!am || typeof am !== "object" || am.from !== "legacy" || am.to !== "v2" || Object.keys(am).length !== 2) return false;
  if (typeof obj.ts !== "string" || !ISO_RE.test(obj.ts)) return false;
  const ao = obj.authorityObject;
  if (!ao || typeof ao !== "object" || Array.isArray(ao)) return false;
  // 교차 결속 6조건(4차 #1)
  if (Object.keys(ao).sort().join(",") !== AUTH_KEYS) return false;
  if (ao.schema !== "map-authority-v1" || ao.cutover !== true) return false;
  if (ao.mapId !== obj.mapId || ao.decisionRef !== obj.decisionId || ao.ts !== obj.ts) return false;
  if (typeof obj.authorityFileFp !== "string" || !HEX40.test(obj.authorityFileFp)) return false;
  if (sha1(JSON.stringify(ao, null, 1)) !== obj.authorityFileFp) return false;
  return true;
}
function authorityHistoryExists(repo) {
  try { return fs.readdirSync(path.join(repo, "project-map", "authority-history")).length > 0; }
  catch (e) { return !(e && e.code === "ENOENT"); } // 판독 불가=이력 존재로 간주(fail-closed)
}
function authorityStateFor(repo) {
  const authFile = path.join(repo, "project-map", "authority.json");
  const mk = readJson3(authFile);
  if (mk.st === "absent") {
    return authorityHistoryExists(repo)
      ? { st: "blocked", reason: "cutover 이력 존재+marker 부재(삭제로 전환 전 복귀 금지 — §B)" }
      : { st: "legacy" };
  }
  if (mk.st !== "ok") return { st: "blocked", reason: "authority.json 손상/판독 불가" };
  const m = mk.data;
  if (!m || typeof m !== "object" || Object.keys(m).sort().join(",") !== AUTH_KEYS
    || m.schema !== "map-authority-v1" || m.cutover !== true
    || typeof m.mapId !== "string" || !UUID_RE.test(m.mapId)
    || typeof m.decisionRef !== "string" || !UUID_RE.test(m.decisionRef) || typeof m.ts !== "string" || !ISO_RE.test(m.ts)) {
    return { st: "blocked", reason: "authority.json 형식 위반(정확 키 집합 — §B)" };
  }
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { st: "blocked", reason: "topology 판독 불가(권위 대조 불능)" };
  if (rt.topo.mapId !== m.mapId) return { st: "blocked", reason: "authority.json mapId ≠ 현재 topology 세대" };
  const rc = readJson3(path.join(repo, "project-map", "authority-history", m.decisionRef + ".json"));
  if (rc.st !== "ok" || !validReceipt(rc.data, m.decisionRef + ".json")) return { st: "blocked", reason: "cutover receipt 부재/손상/결속 위반(§B-1)" };
  if (rc.data.authorityFileFp !== fileSha3(authFile).hash) return { st: "blocked", reason: "marker 지문 ≠ receipt 기대 지문" };
  return { st: "v2", mapId: m.mapId };
}

// ── 서랍 경로(C-1 — nsKey는 P2 canonical identity·mapId 하위) ───────────────────
function bindingsRootFor(repo) { return path.join(CL.BRIDGE_DIR, "map-bindings", MP.canonicalIdentityFor(repo).nsKey); }
function bindingsDirFor(repo, mapId) {
  if (!UUID_RE.test(String(mapId))) throw new Error("mapId가 UUID가 아님(경로 이탈 차단): " + String(mapId).slice(0, 40));
  const base = path.join(bindingsRootFor(repo), mapId);
  return { base, candidatesFile: path.join(base, "candidates.json"), liveFile: path.join(base, "live-candidates.json"), cardRefsFile: path.join(base, "card-refs.json") };
}
// 전역 후보 잠금(11차 #1 — nsKey 하나·후보/card-refs 쓰기와 전역 집계를 단일 직렬화. P2 .nslock과 별개)
function withCandGlobalLock(repo, fn) {
  const root = bindingsRootFor(repo);
  fs.mkdirSync(root, { recursive: true });
  const lockFile = path.join(root, ".cand-global-lock");
  const tok = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: tok }), { flag: "wx" }); } catch {
    return { ok: false, error: "cand-global-lock 점유/잔재(" + lockFile + ") — 잔재면 gc로 정리" };
  }
  const rb = readJson3(lockFile);
  if (!(rb.st === "ok" && rb.data.token === tok)) { try { const h = readJson3(lockFile); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(lockFile); } catch { /* 무해 */ } return { ok: false, error: "cand-global-lock read-back 실패" }; }
  try { return { ok: true, result: fn() }; }
  finally { try { const h = readJson3(lockFile); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(lockFile); } catch { /* 무해 */ } }
}

// ── 매칭(§C-3 — 순수 함수: topology+원문 → candidates 객체. 시계 불참·재실행 바이트 동일) ─────
// 1단: path→node 해소. 반환 {node, quality} | {ambiguous:[nodeId...]} | null
function resolvePathToNode(topo, entryPath) {
  const np = normRelPath(entryPath);
  if (np === null) return null;
  const anchorsOf = (n) => (n.anchors || []).map((a) => normRelPath(a.path)).filter((x) => x !== null);
  const hit = (pred) => { const ids = new Set(); for (const n of topo.nodes || []) if (anchorsOf(n).some(pred)) ids.add(n.id); return [...ids].sort(); };
  const exact = hit((a) => a === np);
  if (exact.length === 1) return { node: exact[0], quality: "exact" };
  if (exact.length > 1) return { ambiguous: exact };
  const f = foldPath(np);
  const fold = hit((a) => foldPath(a) === f);
  if (fold.length === 1) return { node: fold[0], quality: "case-fold" };
  if (fold.length > 1) return { ambiguous: fold };
  // segment 경계 접미 폴백(1차 #8 — a/b.js ≠ liba/b.js)
  const sufOk = (a) => { const fa = foldPath(a); return fa === f || fa.endsWith("/" + f) || f.endsWith("/" + fa); };
  const suf = hit(sufOk);
  if (suf.length === 1) return { node: suf[0], quality: "suffix" };
  if (suf.length > 1) return { ambiguous: suf };
  return null;
}
const QUALITY_RANK = { exact: 0, "case-fold": 1, suffix: 2 };
// 2단: entry→entity 후보(합타입 — 2차 #6·3차 #5)
function matchEntry(topo, text) {
  const rawPaths = [...new Set(caseAwarePathsFromText(text).map(normRelPath).filter((x) => x !== null))];
  if (!rawPaths.length) return { paths: [], endpointsKey: null, match: { status: "unmatched", reason: "no-paths" } };
  const endpointsKey = endpointsKeyOfCopy(text);
  const distinctFold = [...new Set(rawPaths.map(foldPath))];
  if (endpointsKey !== null) { // 결합(경로 2+) 후보
    if (distinctFold.length !== 2) return { paths: rawPaths, endpointsKey, match: { status: "unmatched", reason: "multi-endpoint" } };
    const p1 = rawPaths.find((p) => foldPath(p) === distinctFold[0]);
    const p2 = rawPaths.find((p) => foldPath(p) === distinctFold[1]);
    const r1 = resolvePathToNode(topo, p1), r2 = resolvePathToNode(topo, p2);
    for (const r of [r1, r2]) {
      if (r && r.ambiguous) return { paths: rawPaths, endpointsKey, match: { status: "ambiguous", entityKind: "edge", reason: "endpoint-ambiguous", endpointCandidates: r.ambiguous } };
    }
    if (!r1 || !r2) return { paths: rawPaths, endpointsKey, match: { status: "unmatched", reason: "unresolved" } };
    const directed = endpointsKey.startsWith("d|");
    const pair = (e) => directed ? (e.from === r1.node && e.to === r2.node) : ((e.from === r1.node && e.to === r2.node) || (e.from === r2.node && e.to === r1.node));
    const edges = (topo.edges || []).filter(pair).map((e) => e.id).sort();
    if (edges.length === 1) {
      const q = QUALITY_RANK[r1.quality] >= QUALITY_RANK[r2.quality] ? r1.quality : r2.quality; // 약한 쪽
      return { paths: rawPaths, endpointsKey, match: { status: "matched", entityKind: "edge", targetId: edges[0], matchQuality: q } };
    }
    if (edges.length > 1) return { paths: rawPaths, endpointsKey, match: { status: "ambiguous", entityKind: "edge", candidateIds: edges } };
    return { paths: rawPaths, endpointsKey, match: { status: "unmatched", reason: "no-entity" } };
  }
  // 단일 경로 node 후보 — 정규화 원문 경로가 정확히 1개일 때만(구현 1차 #8: 소문자 병합으로 endpointsKey가
  // null이 된 복수 경로 문장을 node exact로 오확정하는 반례 차단)
  if (rawPaths.length !== 1) return { paths: rawPaths, endpointsKey: null, match: { status: "unmatched", reason: "unresolved" } };
  const r = resolvePathToNode(topo, rawPaths[0]);
  if (r && r.node) return { paths: rawPaths, endpointsKey: null, match: { status: "matched", entityKind: "node", targetId: r.node, matchQuality: r.quality } };
  if (r && r.ambiguous) return { paths: rawPaths, endpointsKey: null, match: { status: "ambiguous", entityKind: "node", candidateIds: r.ambiguous } };
  return { paths: rawPaths, endpointsKey: null, match: { status: "unmatched", reason: "unresolved" } };
}
const entryFpLegacy = (e) => sha1(e.text + NUL + e.date + NUL + e.from);
const entryFpLive = (e) => sha1(e.text + NUL + e.approvedAt + NUL + e.from + NUL + e.actionRef);
// 후보 추출기(§C-3 — 동일 sig 복수 행은 병합·경로 발산=duplicate-sig-divergent(3차 #2))
function buildCandidatesFor(topo, mdText, sourceRel) {
  const sourceFp = sha1(mdText);
  const topologyHash = PM.mapHashOf(topo);
  const groups = new Map(); // sig → originals[]
  for (const e of parseApprovedCopy(mdText).approved) {
    const sig = CL.ledgerSig(e.text);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push({ text: e.text, date: e.date, from: e.from, entryFp: entryFpLegacy(e) });
  }
  const items = [];
  for (const [sig, originals] of groups) {
    const rep = originals[0];
    let m = matchEntry(topo, rep.text);
    if (originals.length > 1) { // 행마다 경로 발산=병합 불가(3차 #2)
      const repKey = stableJson([...new Set(caseAwarePathsFromText(rep.text).map(normRelPath))].sort());
      const diverge = originals.slice(1).some((o) => stableJson([...new Set(caseAwarePathsFromText(o.text).map(normRelPath))].sort()) !== repKey);
      if (diverge) m = { paths: m.paths, endpointsKey: m.endpointsKey, match: { status: "unmatched", reason: "duplicate-sig-divergent" } };
    }
    const originalsFp = sha1(originals.map((o) => o.entryFp).join(NUL));
    items.push({
      candidateFp: sha1(sig + NUL + topo.mapId + NUL + sourceFp + NUL + topologyHash + NUL + originalsFp + NUL + stableJson(m.match)),
      sig, originals, originalsFp, endpointsKey: m.endpointsKey, paths: m.paths, match: m.match,
    });
  }
  items.sort((a, b) => (a.sig < b.sig ? -1 : 1));
  return { schema: "map-binding-candidates-v1", mapId: topo.mapId, sourceRel, sourceFp, topologyHash, items };
}

// ── legacy-scan(§D — repo 읽기 전용·활성 WAL=보류) ───────────────────────────────
function scanLegacy(repo) {
  const auth0 = authorityStateFor(repo);
  if (auth0.st === "blocked") return { ok: false, error: "권위 상태 blocked — " + auth0.reason }; // 단일 판별 경유(구현 2차 #5)
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { ok: false, error: "topology " + rt.st + " — 후보 생성 없음" };
  if (PM.validateTopology(rt.topo).length) return { ok: false, error: "topology 스키마 위반 — 후보 생성 없음" };
  const bar = MR.pipelineBarrier(repo); // 구현 1차 #1 — {st} 객체 자가 해석 금지·barrier가 정본(unreadable=fail-closed 내장)
  if (bar.blocked) return { ok: false, error: "활성 pipeline WAL — recoverWal 후 재시도(" + bar.reason + ")" };
  const src = legacySourceFor(repo);
  if (src && src.err) return { ok: false, error: src.err };
  if (!src) return { ok: true, noSource: true, total: 0, counts: { exact: 0, suffix: 0, "case-fold": 0, ambiguous: 0, unmatched: 0 } };
  const cand = buildCandidatesFor(rt.topo, src.text, src.rel);
  const d = bindingsDirFor(repo, rt.topo.mapId);
  fs.mkdirSync(d.base, { recursive: true });
  const gw = withCandGlobalLock(repo, () => CL.atomicWrite(d.candidatesFile, JSON.stringify(cand, null, 1))); // 후보 파일 쓰기도 전역 직렬화(구현 1차 #4)
  if (!gw.ok || !gw.result) return { ok: false, error: gw.ok ? "후보 파일 기록 실패" : gw.error };
  const counts = { exact: 0, suffix: 0, "case-fold": 0, ambiguous: 0, unmatched: 0 };
  for (const it of cand.items) {
    if (it.match.status === "matched") counts[it.match.matchQuality]++;
    else if (it.match.status === "ambiguous") counts.ambiguous++;
    else counts.unmatched++;
  }
  const b = readBindingsFor(repo, rt.topo.mapId);
  if (b.st === "invalid" || b.st === "unreadable") return { ok: false, error: "bindings.json " + b.st + " — 후보는 갱신됐으나 확정본 손상(수동 확인·구현 6차 #2)", total: cand.items.length, counts };
  return { ok: true, total: cand.items.length, counts,
    confirmed: b.st === "ok" ? b.data.bindings.length : null,
    bindingsState: b.st === "ok" ? "ok" : b.st, // stale='0건'이 아니라 별도 상태(구현 6차 #2)
    file: d.candidatesFile };
}

// ── 신뢰 경계 validator(구현 1차 #3 — JSON-valid 손상도 오류 합타입으로) ─────────────
const BINDING_KEYS = "candidateFp,endpointsKey,kind,origin,originals,rebound,sig,source,targetId,ts";
const REBOUND_KEYS = "confirmedAt,prevCandidateFp,prevKind,prevTargetId,reboundAt";
function validOriginals(arr, live) {
  return Array.isArray(arr) && arr.length > 0 && arr.every((o) => {
    if (!(o && typeof o === "object" && typeof o.text === "string" && o.text && typeof o.date === "string"
      && typeof o.from === "string" && typeof o.entryFp === "string" && HEX40.test(o.entryFp))) return false;
    const keys = Object.keys(o).sort().join(",");
    return live ? keys === "approvedAt,date,entryFp,from,text" && ISO_RE.test(String(o.approvedAt)) && o.date === String(o.approvedAt).slice(0, 10) : keys === "date,entryFp,from,text"; // date 파생 결속(구현 5차 #1)
  });
}
// match 합타입 변형별 필수 필드(구현 2차 #3)
const MATCH_REASONS = ["no-paths", "unresolved", "multi-endpoint", "no-entity", "duplicate-sig-divergent"];
function validMatch(m) {
  if (!m || typeof m !== "object") return false;
  if (m.status === "matched") return (m.entityKind === "node" || m.entityKind === "edge") && UUID_RE.test(String(m.targetId)) && ["exact", "case-fold", "suffix"].includes(m.matchQuality) && Object.keys(m).length === 4;
  if (m.status === "ambiguous") {
    const sortedUniq = (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((x, i) => UUID_RE.test(String(x)) && (i === 0 || arr[i - 1] < x)); // 정렬+중복 금지(구현 3차 #2)
    if (m.reason === "endpoint-ambiguous") return m.entityKind === "edge" && sortedUniq(m.endpointCandidates) && Object.keys(m).length === 4;
    return (m.entityKind === "node" || m.entityKind === "edge") && sortedUniq(m.candidateIds) && Object.keys(m).length === 3;
  }
  if (m.status === "unmatched") return MATCH_REASONS.includes(m.reason) && Object.keys(m).length === 2;
  return false;
}
function validOrigin(o) {
  if (!o || typeof o !== "object") return false;
  if (o.kind === "legacy-map") return Object.keys(o).sort().join(",") === "kind,sourceFp,sourceRel" && (o.sourceRel === "docs/MAP.md" || o.sourceRel === "MAP.md") && HEX40.test(String(o.sourceFp)); // sourceRel enum(구현 7차 #2)
  if (o.kind === "live-approval") return Object.keys(o).sort().join(",") === "actionRef,approvedAt,kind" && (o.actionRef === "export" || o.actionRef === "approve") && ISO_RE.test(String(o.approvedAt));
  return false;
}
function validBindingRec(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  if (Object.keys(b).sort().join(",") !== BINDING_KEYS) return false;
  if (typeof b.sig !== "string" || !b.sig) return false;
  if (b.endpointsKey !== null && typeof b.endpointsKey !== "string") return false;
  if (b.kind !== "node" && b.kind !== "edge") return false;
  if (!UUID_RE.test(String(b.targetId)) || b.source !== "user-confirmed") return false;
  if (!HEX40.test(String(b.candidateFp)) || !ISO_RE.test(String(b.ts))) return false;
  if (!validOrigin(b.origin)) return false;
  if (!validOriginals(b.originals, b.origin.kind === "live-approval")) return false; // 원천별 originals 형태(구현 2차 #3)
  { // 원문 내용 무결성(구현 4차 #2): entryFp 재계산·sig 결속·live date 결속 — 위조 원문이 권위 뷰로 나가는 통로 차단
    const live = b.origin.kind === "live-approval";
    for (const o of b.originals) {
      const efp = live ? sha1(o.text + NUL + o.approvedAt + NUL + o.from + NUL + b.origin.actionRef) : sha1(o.text + NUL + o.date + NUL + o.from);
      if (o.entryFp !== efp) return false;
      if (CL.ledgerSig(o.text) !== b.sig) return false;
      if (live && o.date !== String(o.approvedAt).slice(0, 10)) return false;
    }
  }
  if (!Array.isArray(b.rebound) || !b.rebound.every((r) => r && typeof r === "object" && Object.keys(r).sort().join(",") === REBOUND_KEYS
    && UUID_RE.test(String(r.prevTargetId)) && (r.prevKind === "node" || r.prevKind === "edge")
    && HEX40.test(String(r.prevCandidateFp)) && ISO_RE.test(String(r.confirmedAt)) && ISO_RE.test(String(r.reboundAt)))) return false; // 값·ISO 검증(구현 3차 #2)
  return true;
}
// 내용 지문 재계산(구현 3차 #1 — 40hex 형식이 아니라 '공식 일치'가 신뢰 조건: 위조 후보 차단)
function verifyCandidateFps(it, kind, mapId, head) {
  const efp = (o) => kind === "live"
    ? sha1(o.text + NUL + o.approvedAt + NUL + o.from + NUL + (it.origin ? it.origin.actionRef : ""))
    : sha1(o.text + NUL + o.date + NUL + o.from);
  if (!(it.originals || []).every((o) => o.entryFp === efp(o))) return "entryFp 불일치";
  if (!(it.originals || []).every((o) => CL.ledgerSig(o.text) === it.sig)) return "sig↔원문 결속 불일치"; // 구현 5차 #1
  const ofp = sha1(it.originals.map((o) => o.entryFp).join(NUL));
  if (it.originalsFp !== ofp) return "originalsFp 불일치";
  const cfp = kind === "live"
    ? sha1(it.sig + NUL + mapId + NUL + "live" + NUL + it.entryFp + NUL + it.topologyHash + NUL + stableJson(it.match))
    : sha1(it.sig + NUL + mapId + NUL + head.sourceFp + NUL + head.topologyHash + NUL + ofp + NUL + stableJson(it.match));
  if (kind === "live" && it.entryFp !== it.originals[0].entryFp) return "entryFp 결속 불일치";
  if (it.candidateFp !== cfp) return "candidateFp 공식 불일치";
  return null;
}
const CAND_HEAD_KEYS = "items,mapId,schema,sourceFp,sourceRel,topologyHash";
const LIVE_HEAD_KEYS = "items,mapId,schema";
function validDrawerFile(data, kind, mapId) { // 파일 top-level 정확 키+세대 결속+sig 유일(구현 3차 #1)
  if (!data || typeof data !== "object") return "형식 위반";
  const keys = Object.keys(data).sort().join(",");
  if (kind === "live") { if (keys !== LIVE_HEAD_KEYS || data.schema !== "map-live-candidates-v1") return "top-level 위반"; }
  else { if (keys !== CAND_HEAD_KEYS || data.schema !== "map-binding-candidates-v1" || !HEX40.test(String(data.sourceFp)) || !HEX40.test(String(data.topologyHash)) || (data.sourceRel !== "docs/MAP.md" && data.sourceRel !== "MAP.md")) return "top-level 위반"; }
  if (!UUID_RE.test(String(data.mapId)) || (mapId && data.mapId !== mapId)) return "mapId 결속 위반";
  if (!Array.isArray(data.items)) return "items 위반";
  const sigs = new Set();
  for (const it of data.items) {
    if (!validCandidateItem(it, kind)) return "항목 형식 위반";
    const fpErr = verifyCandidateFps(it, kind, data.mapId, data);
    if (fpErr) return fpErr;
    if (sigs.has(it.sig)) return "sig 중복";
    sigs.add(it.sig);
  }
  return null;
}
const LEGACY_ITEM_KEYS = "candidateFp,endpointsKey,match,originals,originalsFp,paths,sig";
const LIVE_ITEM_KEYS = "candidateFp,endpointsKey,entryFp,match,origin,originals,originalsFp,paths,prevFps,sig,status,topologyHash";
function validCandidateItem(it, kind) { // kind: "legacy"|"live" — 정확 키 집합(구현 2차 #3)
  if (!it || typeof it !== "object") return false;
  const keys = Object.keys(it).filter((k) => k !== "boundTargetId").sort().join(","); // boundTargetId=bound 전이 선택 필드
  if (kind === "live") {
    if (keys !== LIVE_ITEM_KEYS) return false;
    if (it.status !== "open" && it.status !== "bound") return false;
    if (it.status === "bound" && !UUID_RE.test(String(it.boundTargetId))) return false;
    if (!HEX40.test(String(it.entryFp)) || !HEX40.test(String(it.topologyHash))) return false;
    if (!Array.isArray(it.prevFps) || it.prevFps.length > 20 || new Set(it.prevFps).size !== it.prevFps.length || !it.prevFps.every((x) => HEX40.test(String(x)))) return false; // 유계+중복 금지(구현 3차 #2)
    if (!validOrigin(it.origin) || it.origin.kind !== "live-approval") return false;
    if (!validOriginals(it.originals, true)) return false;
    if (it.originals[0].approvedAt !== it.origin.approvedAt) return false; // 교차 결속(구현 3차 #2)
  } else {
    if (keys !== LEGACY_ITEM_KEYS) return false;
    if (!validOriginals(it.originals, false)) return false;
  }
  if (!HEX40.test(String(it.candidateFp)) || !HEX40.test(String(it.originalsFp)) || typeof it.sig !== "string" || !it.sig) return false;
  if (it.endpointsKey !== null && typeof it.endpointsKey !== "string") return false;
  if (!Array.isArray(it.paths) || !it.paths.every((x) => typeof x === "string")) return false;
  return validMatch(it.match);
}
function readCardRefs3(repo, mapId, authSt) {
  const d = bindingsDirFor(repo, mapId);
  const cr = readJson3(d.cardRefsFile);
  if (cr.st === "absent") return authSt === "v2" ? { st: "error", error: "card-refs 부재 — P3b 활성 후 fail-closed(§C)" } : { st: "ok", refs: [] };
  if (cr.st !== "ok") return { st: "error", error: "card-refs 손상/판독 불가 — fail-closed" };
  const dta = cr.data;
  if (!dta || dta.schema !== "map-card-refs-v1" || !Array.isArray(dta.refs)
    || Object.keys(dta).sort().join(",") !== "refs,schema"
    || !dta.refs.every((x) => x && typeof x === "object" && Object.keys(x).sort().join(",") === "candidateFp,cardId"
      && HEX40.test(String(x.candidateFp)) && UUID_RE.test(String(x.cardId)))) return { st: "error", error: "card-refs 형식 위반 — fail-closed" };
  // 유일성(설계 12차 #3): 한 cardId→한 candidateFp·한 candidateFp→활성 cardId 하나
  const byCard = new Set(), byCand = new Set();
  for (const x of dta.refs) {
    if (byCard.has(x.cardId) || byCand.has(x.candidateFp)) return { st: "error", error: "card-refs 유일성 위반(cardId 또는 candidateFp 중복) — 진단" };
    byCard.add(x.cardId); byCand.add(x.candidateFp);
  }
  return { st: "ok", refs: dta.refs };
}

// ── bindings.json(확정 — repo·sig 기본키·canonical 정렬) ─────────────────────────
function bindingsFileFor(repo) { return path.join(repo, "project-map", "bindings.json"); }
function readBindingsFor(repo, mapId) {
  const r = readJson3(bindingsFileFor(repo));
  if (r.st === "absent") return { st: "ok", data: { schema: "map-bindings-v1", mapId, bindings: [] }, absent: true };
  if (r.st !== "ok") return { st: r.st };
  const d = r.data;
  if (!d || d.schema !== "map-bindings-v1" || !Array.isArray(d.bindings) || !UUID_RE.test(String(d.mapId))
    || Object.keys(d).sort().join(",") !== "bindings,mapId,schema") return { st: "invalid" };
  if (d.mapId !== mapId) return { st: "stale", fileMapId: d.mapId }; // 세대 결속(1차 #2) — 소비 거부
  if (!d.bindings.every(validBindingRec)) return { st: "invalid" }; // JSON-valid 손상도 거부(구현 1차 #3)
  { const seen = new Set(); for (const b of d.bindings) { if (seen.has(b.sig)) return { st: "invalid" }; seen.add(b.sig); } } // sig 유일
  return { st: "ok", data: d };
}
function writeBindings(repo, data) {
  data.bindings.sort((a, b) => (a.sig < b.sig ? -1 : 1)); // canonical(sig 오름차순)
  // 완성 객체 전수 자기 검증(구현 5차 #1 — 손상 입력이 확정본으로 기록돼 이후 전 소비가 막히는 통로 차단)
  if (!data.bindings.every(validBindingRec)) return false;
  { const seen = new Set(); for (const b of data.bindings) { if (seen.has(b.sig)) return false; seen.add(b.sig); } }
  fs.mkdirSync(path.dirname(bindingsFileFor(repo)), { recursive: true });
  return CL.atomicWrite(bindingsFileFor(repo), JSON.stringify(data, null, 1));
}
// target 실존+종류 판별(2차 #5·#6 — nodes/edges 어느 쪽 실존인지가 kind의 출처)
function findTarget(topo, targetId) {
  if ((topo.nodes || []).some((n) => n.id === targetId)) return "node";
  if ((topo.edges || []).some((e) => e.id === targetId)) return "edge";
  return null;
}

// 후보 이원 판독(5차 #2 — legacy→live 순서·정확 1건·중복=fail-closed)
function lookupCandidate(repo, mapId, candidateFp) {
  const d = bindingsDirFor(repo, mapId);
  const rc = readJson3(d.candidatesFile);
  const rl = readJson3(d.liveFile);
  if (rc.st === "invalid" || rc.st === "unreadable" || rl.st === "invalid" || rl.st === "unreadable") return { st: "error", error: "후보 서랍 손상/판독 불가 — fail-closed" };
  for (const [r, nm, knd] of [[rc, "candidates", "legacy"], [rl, "live-candidates", "live"]]) {
    if (r.st === "ok") { const err = validDrawerFile(r.data, knd, mapId); if (err) return { st: "error", error: nm + " " + err + " — fail-closed(구현 3차 #1)" }; }
  }
  const inLegacy = rc.st === "ok" ? (rc.data.items || []).filter((x) => x.candidateFp === candidateFp) : [];
  const inLive = rl.st === "ok" ? (rl.data.items || []).filter((x) => x.candidateFp === candidateFp) : [];
  if (inLegacy.length + inLive.length === 0) return { st: "absent" };
  if (inLegacy.length + inLive.length > 1) return { st: "error", error: "candidateFp 중복(양쪽 서랍) — fail-closed 수동 확인" };
  return inLegacy.length ? { st: "ok", kind: "legacy", item: inLegacy[0], head: rc.data } : { st: "ok", kind: "live", item: inLive[0], head: rl.data };
}
// (mapId,sig) 보조 조회 — 두 서랍 '전부' 수집 후 판정(구현 6차 #1: 첫 서랍 조기 반환이 live 재개를 가림).
// 판별(설계 8차 #3·9차 #3): 1차=oldFp가 candidateFp/prevFps에 포함 / 2차=카드 보존 불변 (sig, entryFp, origin)
// 일치. 정확 1건=stale-candidate·복수 일치=conflict·일치 0에 동일 sig 후보 1건=different·복수=conflict.
function lookupBySig(repo, mapId, sig, old) {
  const o = old || {};
  const d = bindingsDirFor(repo, mapId);
  const hits = [];
  for (const [f, knd] of [[d.candidatesFile, "legacy"], [d.liveFile, "live"]]) {
    const r = readJson3(f);
    if (r.st === "invalid" || r.st === "unreadable") return { st: "error", error: "후보 서랍 손상 — fail-closed(구현 4차 #1)" };
    if (r.st !== "ok") continue;
    { const err = validDrawerFile(r.data, knd, mapId); if (err) return { st: "error", error: "후보 서랍 " + err + " — fail-closed(구현 4차 #1)" }; }
    for (const it of r.data.items) if (it.sig === sig) hits.push({ knd, it, head: r.data }); // head 보존(구현 7차 #1 — legacy origin 재구성 재료)
  }
  if (!hits.length) return { st: "absent" };
  const originOk = (h) => {
    if (!o.origin || !validOrigin(o.origin)) return false; // 3요소 전부+입력 origin 형식 통과(설계 9차 #3·구현 7차 #1)
    const curOrigin = h.it.origin ? h.it.origin : { kind: "legacy-map", sourceRel: h.head.sourceRel, sourceFp: h.head.sourceFp }; // legacy=head에서 재구성
    return stableJson(curOrigin) === stableJson(o.origin); // canonical 전체 정확 일치(sourceRel·sourceFp 포함 — 세대·원천 다른 후보 오판별 차단)
  };
  const stale = hits.filter((h) =>
    (o.fp && (h.it.candidateFp === o.fp || (h.it.prevFps || []).includes(o.fp)))
    || (o.entryFp && (h.it.originals || []).some((x) => x.entryFp === o.entryFp) && originOk(h)));
  if (stale.length === 1) return { st: "stale-candidate", current: stale[0].it, drawer: stale[0].knd };
  if (stale.length > 1) return { st: "conflict", error: "동일 승인 판별 복수 일치 — 수동 확인(구현 6차 #1)" };
  if (hits.length === 1) return { st: "different", current: hits[0].it, drawer: hits[0].knd };
  return { st: "conflict", error: "동일 sig 후보 복수(양쪽 서랍)·판별 불가 — 수동 확인(구현 6차 #1)" };
}
// promoteEntry용 단순 sig 조회(재개 판별과 분리 — 구현 6차 #1): 유효 서랍에서 sig 후보의 fp만
function lookupCandidateFpBySig(repo, mapId, sig) {
  const r = lookupBySig(repo, mapId, sig, {});
  if (r.st === "error") return r;
  if (r.st === "different" || r.st === "stale-candidate") return { st: "ok", candidateFp: r.current.candidateFp };
  if (r.st === "conflict") return { st: "error", error: r.error };
  return { st: "absent" };
}

// confirm/rebind 공통 신선도(1차 #2·2차 #4): sourceRel 규칙 재적용·양쪽 지문 재계산 일치
function freshnessCheck(repo, topo, lookup) {
  { // 저장 match가 현재 원문·topology에서 재산출되는지(위조·손상 차단 — 구현 3차 #1)
    const rep = lookup.item.originals[0];
    const rem = matchEntry(topo, rep.text);
    let m = rem.match;
    if (lookup.item.match.status === "unmatched" && lookup.item.match.reason === "duplicate-sig-divergent") m = lookup.item.match; // 병합 발산은 파일 차원 판정(재산출 불가)
    if (stableJson(m) !== stableJson(lookup.item.match)) return "저장 match ≠ 재산출 match — 재스캔/재승인 필요(위조·손상 차단)";
  }
  if (lookup.kind === "legacy") {
    const head = lookup.head;
    const src = legacySourceFor(repo);
    if (!src || src.rel !== head.sourceRel || sha1(src.text) !== head.sourceFp) return "확정층 원문 변경(sourceRel/sourceFp 불일치) — legacy-scan 재실행 필요";
    if (PM.mapHashOf(topo) !== head.topologyHash) return "topology 변경(topologyHash 불일치) — legacy-scan 재실행 필요";
  } else {
    const it = lookup.item;
    if (it.topologyHash !== PM.mapHashOf(topo)) return "topology 변경 — 재승인 시 재계산됨(promoteEntry 재실행)";
    const o = (it.originals || [])[0];
    if (!o || entryFpLive({ text: o.text, approvedAt: o.approvedAt, from: o.from, actionRef: (it.origin || {}).actionRef }) !== o.entryFp) return "live 후보 원문/actionRef 불변 검사 실패";
  }
  return null;
}

// ── binding-confirm / rebind / discard / list(§C-4) ─────────────────────────────
function confirmBinding(repo, candidateFp, opts) {
  const o = opts || {};
  const lk = MR.withMapLock(repo, () => confirmInLock(repo, candidateFp, o, false));
  if (!lk.ok) return { ok: false, error: "정본 잠금 실패" };
  return lk.result;
}
function rebindBinding(repo, candidateFp, opts) {
  const o = opts || {};
  if (!o.target) return { ok: false, error: "binding-rebind는 --target 필수" };
  const lk = MR.withMapLock(repo, () => confirmInLock(repo, candidateFp, o, true));
  if (!lk.ok) return { ok: false, error: "정본 잠금 실패" };
  return lk.result;
}
function confirmInLock(repo, candidateFp, o, isRebind) {
  // ⓪ barrier·권위 재검사(3차 #9 — 잠금 안)
  const b = MR.pipelineBarrier(repo);
  if (b.blocked) return { ok: false, error: "활성 pipeline WAL — recoverWal 선행(" + b.reason + ")" };
  const auth = authorityStateFor(repo);
  if (auth.st === "blocked") return { ok: false, error: "권위 상태 blocked — " + auth.reason };
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { ok: false, error: "topology " + rt.st };
  const topo = rt.topo;
  // ①~⑤를 cand-global-lock 하나의 임계구역으로(구현 1차 #4 — discard 선행 경합 차단. mapLock→global 순서 허용)
  const gAll = withCandGlobalLock(repo, () => confirmInCandLock(repo, topo, candidateFp, o, isRebind));
  if (!gAll.ok) return { ok: false, error: gAll.error };
  return gAll.result;
}
function confirmInCandLock(repo, topo, candidateFp, o, isRebind) {
  // ①② 후보 조회+신선도
  const lookup = lookupCandidate(repo, topo.mapId, candidateFp);
  if (lookup.st === "error") return { ok: false, error: lookup.error };
  if (lookup.st === "absent") return { ok: false, error: "candidateFp 조회 실패 — 재스캔(legacy-scan) 또는 재승인 후 새 지문으로(선택 세대 결속)" };
  const staleWhy = freshnessCheck(repo, topo, lookup);
  if (staleWhy) return { ok: false, error: staleWhy };
  const item = lookup.item;
  // ③ bindings 재판독(잠금 안)
  const rb = readBindingsFor(repo, topo.mapId);
  if (rb.st === "stale") return { ok: false, error: "bindings.json이 이전 세대(mapId=" + rb.fileMapId + ") — 수동 확인 필요(자동 승계 금지)" };
  if (rb.st !== "ok") return { ok: false, error: "bindings.json " + rb.st + " — fail-closed" };
  const data = rb.data;
  // ④ target 결정·검증(4차 #7 — 자동은 exact 유일뿐)
  let targetId = o.target || null;
  if (!targetId) {
    if (!(item.match && item.match.status === "matched" && item.match.matchQuality === "exact")) {
      return { ok: false, error: "--target 필수(자동 확정은 match=exact 유일뿐 — case-fold/suffix/ambiguous/unmatched는 명시 지정)" };
    }
    targetId = item.match.targetId;
  }
  if (!UUID_RE.test(String(targetId))) return { ok: false, error: "--target이 UUID가 아님" };
  const kind = findTarget(topo, targetId);
  if (!kind) return { ok: false, error: "target이 현재 topology에 없음(같은 세대 소멸 포함 — 2차 #5)" };
  const ex = data.bindings.find((x) => x.sig === item.sig);
  const ensureBound = (tid) => { // 멱등 재시도의 bound 복구 — 결과 정직 보고(구현 3차 #3: 실패=성공 위장 금지)
    if (lookup.kind !== "live") return null;
    const d2 = bindingsDirFor(repo, topo.mapId);
    const r2 = readJson3(d2.liveFile);
    if (r2.st !== "ok") return "live 서랍 판독 실패 — bound 전이 미완(재시도 필요)";
    const it2 = (r2.data.items || []).find((x) => x.candidateFp === candidateFp);
    if (it2 && (it2.status !== "bound" || it2.boundTargetId !== tid)) { // boundTargetId 불일치도 복구 대상
      it2.status = "bound"; it2.boundTargetId = tid;
      if (!CL.atomicWrite(d2.liveFile, JSON.stringify(r2.data, null, 1))) return "bound 전이 기록 실패 — 재시도 필요";
    }
    return null;
  };
  if (!isRebind) {
    if (ex && ex.targetId === targetId) {
      const be = ensureBound(targetId);
      if (be) return { ok: false, error: be }; // 미종결 정직 보고(구현 3차 #3)
      return { ok: true, idempotent: true, sig: item.sig, targetId };
    }
    if (ex) return { ok: false, error: "sig가 이미 다른 target(" + ex.targetId + ")에 결속 — binding-rebind로만 변경(1차 #4)" };
  } else {
    if (!ex) return { ok: false, error: "rebind 대상 binding 없음 — 먼저 binding-confirm" };
    if (ex.targetId === targetId) { const be = ensureBound(targetId); if (be) return { ok: false, error: be }; return { ok: true, idempotent: true, sig: item.sig, targetId }; }
    // 미종결 promotion 존재=거부(6차 #4)
    const act = MP.findPromotions(repo, topo.mapId, { sig: item.sig });
    if (act.st !== "ok") return { ok: false, error: "pending 판독 실패 — fail-closed(" + (act.error || act.st) + ")" };
    if (act.active.length) return { ok: false, error: "미종결 promotion pending(" + act.active.join(",") + ") — 종결/만료 후 rebind" };
  }
  const origin = lookup.kind === "legacy"
    ? { kind: "legacy-map", sourceRel: lookup.head.sourceRel, sourceFp: lookup.head.sourceFp }
    : item.origin;
  const ts = new Date().toISOString();
  const rec = {
    sig: item.sig, endpointsKey: item.endpointsKey || null, kind, targetId,
    originals: item.originals, origin, source: "user-confirmed", candidateFp, ts,
    rebound: ex ? [...(ex.rebound || []), { prevTargetId: ex.targetId, prevKind: ex.kind, prevCandidateFp: ex.candidateFp, confirmedAt: ex.ts, reboundAt: ts }] : [],
  };
  data.bindings = data.bindings.filter((x) => x.sig !== item.sig);
  data.bindings.push(rec);
  if (!writeBindings(repo, data)) return { ok: false, error: "bindings.json 기록 거부(완성 객체 자기 검증 실패 포함) — 후보 원문/결속 확인 필요" };
  // live 후보는 제거가 아니라 bound 전이(7차 #4 — 같은 global lock 임계구역 안: 구현 1차 #4)
  if (lookup.kind === "live") {
    const d2 = bindingsDirFor(repo, topo.mapId);
    const r2 = readJson3(d2.liveFile);
    if (r2.st === "ok") {
      const it2 = (r2.data.items || []).find((x) => x.candidateFp === candidateFp);
      if (it2) { it2.status = "bound"; it2.boundTargetId = targetId; }
      if (!CL.atomicWrite(d2.liveFile, JSON.stringify(r2.data, null, 1))) return { ok: true, sig: item.sig, targetId, kind, warn: "live 후보 bound 전이 실패(다음 promoteEntry가 재시도)" };
    }
  }
  return { ok: true, sig: item.sig, targetId, kind, rebound: isRebind };
}
// open 전용 명시 폐기(8차 #2·9차 #4·10차 #1)
function discardCandidate(repo, candidateFp) {
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { ok: false, error: "topology " + rt.st };
  const auth0 = authorityStateFor(repo);
  if (auth0.st === "blocked") return { ok: false, error: "권위 상태 blocked — " + auth0.reason };
  const authSt = auth0.st;
  const g = withCandGlobalLock(repo, () => {
    // 전 세대 검색(구현 1차 #5 — 이전 mapId 후보도 명시 폐기 가능해야 backpressure 해소 경로 성립)·정확 1건만
    let hits = [];
    let gens = [];
    try { gens = fs.readdirSync(bindingsRootFor(repo)).filter((x) => UUID_RE.test(x)); }
    catch (e) { if (!(e && e.code === "ENOENT")) return { ok: false, error: "서랍 루트 판독 불가 — fail-closed(구현 2차 #6)" }; gens = []; }
    for (const gmap of gens) {
      const lf = path.join(bindingsRootFor(repo), gmap, "live-candidates.json");
      const rl = readJson3(lf);
      if (rl.st === "invalid" || rl.st === "unreadable") return { ok: false, error: "live 서랍(" + gmap + ") 손상 — fail-closed" };
      if (rl.st !== "ok") continue;
      { const err = validDrawerFile(rl.data, "live", gmap); if (err) return { ok: false, error: "live 서랍(" + gmap + ") " + err + " — fail-closed(구현 3차 #1·세대 결속 4차 #1)" }; }
      const it = (rl.data.items || []).find((x) => x.candidateFp === candidateFp);
      if (it) hits.push({ gmap, lf, rl, it });
    }
    if (!hits.length) return { ok: false, error: "candidateFp 조회 실패(전 세대)" };
    if (hits.length > 1) return { ok: false, error: "candidateFp 중복(복수 세대) — fail-closed 수동 확인" };
    const { gmap, lf, rl, it } = hits[0];
    if (it.status !== "open") return { ok: false, error: "open 전용(현재 " + it.status + ")" };
    const cr = readCardRefs3(repo, gmap, authSt);
    if (cr.st !== "ok") return { ok: false, error: cr.error };
    if (cr.refs.some((x) => x.candidateFp === candidateFp)) return { ok: false, error: "카드 참조 존재 — 동반 취소는 카드 흐름에서만(9차 #4)" };
    rl.data.items = rl.data.items.filter((x) => x.candidateFp !== candidateFp);
    if (!CL.atomicWrite(lf, JSON.stringify(rl.data, null, 1))) return { ok: false, error: "기록 실패" };
    return { ok: true, discarded: candidateFp, sig: it.sig, mapId: gmap };
  });
  if (!g.ok) return { ok: false, error: g.error };
  return g.result;
}
function listBindings(repo) {
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { ok: false, error: "topology " + rt.st };
  const topo = rt.topo;
  const d = bindingsDirFor(repo, topo.mapId);
  const rc = readJson3(d.candidatesFile);
  const rl = readJson3(d.liveFile);
  for (const [r, nm, knd] of [[rc, "candidates", "legacy"], [rl, "live-candidates", "live"]]) { // 소비 전 검증(구현 4차 #1)
    if (r.st === "invalid" || r.st === "unreadable") return { ok: false, error: nm + " 손상 — fail-closed" };
    if (r.st === "ok") { const err = validDrawerFile(r.data, knd, topo.mapId); if (err) return { ok: false, error: nm + " " + err + " — fail-closed" }; }
  }
  const rb = readBindingsFor(repo, topo.mapId);
  if (rb.st === "invalid" || rb.st === "unreadable") return { ok: false, error: "bindings.json " + rb.st + " — fail-closed(구현 5차 #3: '없음'과 '손상'을 구분)" };
  const out = { ok: true, authority: authorityStateFor(repo).st, mapId: topo.mapId, candidates: [], live: [], bindings: [], staleBindings: rb.st === "stale", prevGenerations: [] };
  if (rc.st === "ok") for (const it of rc.data.items || []) out.candidates.push({ candidateFp: it.candidateFp, sig: it.sig, match: it.match });
  if (rl.st === "ok") for (const it of rl.data.items || []) out.live.push({ candidateFp: it.candidateFp, sig: it.sig, status: it.status, match: it.match });
  if (rb.st === "ok") for (const x of rb.data.bindings) {
    const kind = findTarget(topo, x.targetId);
    out.bindings.push({ sig: x.sig, targetId: x.targetId, kind: x.kind, stale: kind === null || kind !== x.kind, resume: kind !== null }); // 소멸=stale 표시(2차 #5)
  }
  // 이전 세대 서랍의 미종결 후보(9차 #2 — 표시만·삭제 없음)
  try {
    let names;
    try { names = fs.readdirSync(bindingsRootFor(repo)); }
    catch (e) { if (!(e && e.code === "ENOENT")) return { ok: false, error: "서랍 루트 판독 불가 — fail-closed(구현 3차 #4)" }; names = []; }
    for (const g of names) {
      if (!UUID_RE.test(g) || g === topo.mapId) continue;
      const r = readJson3(path.join(bindingsRootFor(repo), g, "live-candidates.json"));
      if (r.st === "ok") {
        if (validDrawerFile(r.data, "live", g)) { out.prevGenerations.push({ mapId: g, unreadable: true }); continue; } // 손상=진단 표시(구현 4차 #1)
        const opens = (r.data.items || []).filter((x) => x.status === "open").map((x) => ({ candidateFp: x.candidateFp, sig: x.sig, status: x.status })); // 상세(구현 1차 #5 — 폐기 지원)
        if (opens.length) out.prevGenerations.push({ mapId: g, open: opens.length, items: opens });
      } else if (r.st !== "absent") out.prevGenerations.push({ mapId: g, unreadable: true });
    }
  } catch { /* 루트 부재=무해 */ }
  return out;
}

// ── live 후보 upsert(6차 #2·#3·7차 #1·8차 #2·11차 #1 — promoteEntry needs-binding의 내구 지점) ──
const gcKeepCap = () => { const raw = Number(process.env.CODEX_BRIDGE_MAP_GC_KEEP || 200); return Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 20), 5000); };
function upsertLiveCandidate(repo, topo, entry, matchedIn) {
  let matched = matchedIn;
  return withCandGlobalLock(repo, () => {
    const root = bindingsRootFor(repo);
    // 전 세대 판독+전역 open 집계(10차 #2·11차 #1 — 같은 임계구역)
    let openTotal = 0; const perGen = {};
    let gens = [];
    try { gens = fs.readdirSync(root).filter((g) => UUID_RE.test(g)); }
    catch (e) { if (!(e && e.code === "ENOENT")) return { st: "rejected", reason: "서랍 루트 판독 불가 — fail-closed(구현 2차 #6)" }; gens = []; }
    for (const g of gens) {
      const r = readJson3(path.join(root, g, "live-candidates.json"));
      if (r.st === "invalid" || r.st === "unreadable") return { st: "rejected", reason: "live 서랍(" + g + ") 손상 — fail-closed" };
      if (r.st === "ok") { const err = validDrawerFile(r.data, "live", g); if (err) return { st: "rejected", reason: "live 서랍(" + g + ") " + err + " — fail-closed(구현 3차 #1·세대 결속 4차 #1)" }; }
      const n = r.st === "ok" ? (r.data.items || []).filter((x) => x.status === "open").length : 0;
      perGen[g] = n; openTotal += n;
    }
    const d = bindingsDirFor(repo, topo.mapId);
    const rl = readJson3(d.liveFile);
    if (rl.st === "invalid" || rl.st === "unreadable") return { st: "rejected", reason: "live 서랍 손상 — fail-closed" };
    const data = rl.st === "ok" ? rl.data : { schema: "map-live-candidates-v1", mapId: topo.mapId, items: [] };
    if (data.schema !== "map-live-candidates-v1" || data.mapId !== topo.mapId) return { st: "rejected", reason: "live 서랍 스키마/세대 위반 — fail-closed" };
    const sig = CL.ledgerSig(entry.text);
    const topologyHash = PM.mapHashOf(topo);
    const prior0 = data.items.find((x) => x.sig === sig && x.status === "open");
    if (prior0 && !validCandidateItem(prior0, "live")) return { st: "rejected", reason: "기존 live 후보 형식 위반 — fail-closed(구현 1차 #8)" };
    // 재검증: 저장 entryFp가 저장 원문과 일치해야 재사용(위조·부분 손상 차단)
    const prior = prior0 && prior0.originals[0]
      && entryFpLive({ text: prior0.originals[0].text, approvedAt: prior0.originals[0].approvedAt, from: prior0.originals[0].from, actionRef: prior0.origin.actionRef }) === prior0.originals[0].entryFp
      ? prior0 : null;
    if (prior0 && !prior) return { st: "rejected", reason: "기존 live 후보 entryFp 불일치 — fail-closed(구현 1차 #8)" };
    let it;
    if (prior && prior.topologyHash === topologyHash) {
      it = prior; // 재시도 멱등(6차 #2 — 최초 approvedAt·entryFp·candidateFp 재사용)
    } else {
      // topology 변경 재계산 시 '원본 불변' — 저장된 text/from/approvedAt/actionRef 유지(구현 1차 #8: 새 입력으로 entryFp 재생성 금지)
      const src0 = prior ? { text: prior.originals[0].text, approvedAt: prior.originals[0].approvedAt, from: prior.originals[0].from, actionRef: prior.origin.actionRef }
        : { text: entry.text, approvedAt: entry.approvedAt, from: entry.from, actionRef: entry.actionRef };
      const approvedAt = src0.approvedAt;
      const eFp = entryFpLive(src0);
      const originals = [{ text: src0.text, date: String(approvedAt).slice(0, 10), approvedAt, from: src0.from, entryFp: eFp }];
      if (prior) matched = matchEntry(topo, src0.text); // 보존 원문 기준 재계산(구현 3차 #5 — 새 입력 표기로 match 산출 금지)
      const candidateFp = sha1(sig + NUL + topo.mapId + NUL + "live" + NUL + eFp + NUL + topologyHash + NUL + stableJson(matched.match));
      if (prior) { // topology 변경=재계산 교체+prevFps 감사(7차 #1 — 고착 루프 차단·중복 금지·20개 유계)
        const prev = [...new Set([...(prior.prevFps || []), prior.candidateFp])].slice(-20);
        it = { ...prior, candidateFp, topologyHash, endpointsKey: matched.endpointsKey, paths: matched.paths, match: matched.match, prevFps: prev };
        data.items = data.items.filter((x) => x !== prior);
      } else {
        if (openTotal >= gcKeepCap()) return { st: "rejected", reason: "backpressure(전 세대 open " + openTotal + "건 ≥ 상한) — 미처리 후보 확정/폐기 후 재시도", perGen };
        it = { candidateFp, sig, originals, originalsFp: sha1(eFp), entryFp: eFp, topologyHash, endpointsKey: matched.endpointsKey, paths: matched.paths, match: matched.match, origin: { kind: "live-approval", approvedAt, actionRef: src0.actionRef }, status: "open", prevFps: [] };
      }
      it.originals = originals; it.entryFp = eFp;
      data.items.push(it);
      data.items.sort((a, b) => (a.candidateFp < b.candidateFp ? -1 : 1)); // canonical
      { const err = validDrawerFile(data, "live", topo.mapId); if (err) return { st: "rejected", reason: "생성 후보 자기 검증 실패(" + err + ") — 기록 거부(자기 오염 차단·구현 4차 #3)" }; }
      if (!CL.atomicWrite(d.liveFile, JSON.stringify(data, null, 1))) return { st: "rejected", reason: "live 서랍 기록 실패" };
    }
    return { st: "needs-binding", entry: { text: it.originals[0].text, from: it.originals[0].from, approvedAt: it.originals[0].approvedAt, actionRef: it.origin.actionRef, sig }, candidateFp: it.candidateFp, match: it.match }; // 응답=저장분(구현 1차 #8)
  });
}

// ── GC 배선(구현 1차 #2 — pipelineGcInLock이 mapLock 아래에서 lazy 호출) ──────────
// dead-valid .cand-global-lock 격리+종결 bound 후보 정리. 자동 회수 없음 계약은 유지(gc만 회수 주체).
function gcBindingsInLock(repo) {
  let lockRecovered = 0, removed = 0;
  const root = bindingsRootFor(repo);
  const lockFile = path.join(root, ".cand-global-lock");
  const cur = readJson3(lockFile);
  const deadValid = cur.st === "ok" && Number.isInteger(cur.data.pid) && cur.data.pid > 0 && typeof cur.data.token === "string"
    && (() => { try { process.kill(cur.data.pid, 0); return false; } catch (e) { return !!(e && e.code === "ESRCH"); } })();
  if (deadValid) {
    const again = readJson3(lockFile);
    if (again.st === "ok" && again.data.pid === cur.data.pid && again.data.token === cur.data.token) {
      try { fs.renameSync(lockFile, lockFile + ".stale." + crypto.randomBytes(4).toString("hex")); lockRecovered = 1; } catch { /* 경쟁 무해 */ }
    }
  }
  // 종결 bound 후보 정리: bindings 확정 sig+target에 ledger evidence 실존(=proposal 확인 완료)만(8차 #2 — open 불가침)
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { lockRecovered, removed };
  const rb = readBindingsFor(repo, rt.topo.mapId);
  if (rb.st === "invalid" || rb.st === "unreadable") return { lockRecovered, removed, error: "bindings.json " + rb.st + " — gc 정리 보류(진단)" };
  if (rb.st !== "ok") return { lockRecovered, removed };
  const g = withCandGlobalLock(repo, () => {
    const d = bindingsDirFor(repo, rt.topo.mapId);
    const rl = readJson3(d.liveFile);
    if (rl.st === "invalid" || rl.st === "unreadable") return { err: "live 서랍 손상 — gc 정리 보류(진단)" }; // 축소 금지(구현 3차 #4)
    if (rl.st !== "ok") return 0;
    { const verr = validDrawerFile(rl.data, "live", rt.topo.mapId); if (verr) return { err: "live 서랍 " + verr + " — gc 정리 보류(진단)" }; }
    const applied = (sig, targetId) => {
      const ent = (rt.topo.nodes || []).find((n) => n.id === targetId) || (rt.topo.edges || []).find((e) => e.id === targetId);
      return !!(ent && (ent.evidence || []).some((e) => e.kind === "ledger" && e.ref === sig));
    };
    const before = (rl.data.items || []).length;
    rl.data.items = (rl.data.items || []).filter((x) => {
      if (x.status !== "bound") return true;
      const b = rb.data.bindings.find((y) => y.sig === x.sig);
      return !(b && applied(x.sig, b.targetId));
    });
    if (rl.data.items.length === before) return 0;
    if (!CL.atomicWrite(d.liveFile, JSON.stringify(rl.data, null, 1))) return { err: "live 서랍 기록 실패 — gc 미완(구현 4차 #4)" };
    return before - rl.data.items.length;
  });
  if (!g.ok) return { lockRecovered, removed, error: "후보 잠금 실패 — gc 미완(" + g.error + ")" }; // 잠금 실패도 진단(구현 4차 #4)
  if (typeof g.result === "number") removed += g.result;
  if (g.result && typeof g.result === "object" && g.result.err) return { lockRecovered, removed, error: g.result.err };
  return { lockRecovered, removed };
}

module.exports = {
  gcBindingsInLock, readCardRefs3, validBindingRec, validCandidateItem,
  authorityStateFor, legacyPreviewFor, validReceipt,
  parseApprovedCopy, legacySourceFor, caseAwarePathsFromText, endpointsKeyOfCopy, normRelPath, classifyEvidencePath,
  resolvePathToNode, matchEntry, buildCandidatesFor, scanLegacy,
  bindingsRootFor, bindingsDirFor, withCandGlobalLock, readBindingsFor, bindingsFileFor, findTarget,
  lookupCandidate, lookupBySig, lookupCandidateFpBySig, confirmBinding, rebindBinding, discardCandidate, listBindings,
  upsertLiveCandidate, entryFpLegacy, entryFpLive, stableJson,
};
