/*
 * Project MAP v2 — P2-A2b patch pipeline (설계 정본 docs/MAP-P2-DESIGN.md 사전검증 9차 확정판의 §B·§D·§E·§F·§G).
 * 비활성 계약(§A): 자동 적용 트리거 0 — 진입은 CLI 수동 명령뿐. 권위 marker 없음(guard marker만).
 * 잠금: 비중첩 프로토콜 — nsLock(클레임 전이) → withMapLock(트랜잭션) → nsLock(종결). funlock 미사용.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const CL = require(path.join(__dirname, "contract-lib.js"));
const MR = require(path.join(__dirname, "map-runtime.js"));
const MF = require(path.join(__dirname, "map-freshness.js"));
const PM = MR.PM;

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const NUL = "\u0000";

// 3분기 판독(P1 계약 승계): absent / ok / invalid / unreadable — 배열·비객체는 invalid.
function readJson3(f) {
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; }
  try { const d = JSON.parse(raw); if (!d || typeof d !== "object" || Array.isArray(d)) return { st: "invalid" }; return { st: "ok", data: d, raw }; } catch { return { st: "invalid" }; }
}
const fileSha = (f) => { try { return sha1(fs.readFileSync(f, "utf8")); } catch { return null; } };
// 3분기 지문 판독(14차 #3 — ENOENT만 부재, 그 외=unreadable로 표면화)
const fileSha3 = (f) => { try { return { st: "ok", hash: sha1(fs.readFileSync(f, "utf8")) }; } catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; } };

// ── identity(§B — 1-29) ─────────────────────────────────────────────────────────
function gitInfo(repo) {
  const g = (args) => { try { const r = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true }); return r.status === 0 ? String(r.stdout || "").trim() : null; } catch { return null; } };
  const head = g(["rev-parse", "HEAD"]);
  if (!head) return null;
  const branch = g(["rev-parse", "--abbrev-ref", "HEAD"]);
  const common = g(["rev-parse", "--git-common-dir"]);
  const fmt = g(["rev-parse", "--show-object-format"]) || "sha1";
  return {
    head, branch: branch === "HEAD" ? null : branch,
    gitCommonReal: common ? realOf(path.isAbsolute(common) ? common : path.join(repo, common)) : null,
    oidFormat: fmt === "sha256" ? "sha256" : "sha1",
    isAncestor: (old) => { const r = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "merge-base", "--is-ancestor", old, "HEAD"], { timeout: 3000, windowsHide: true }); return r.status === 0; },
  };
}
function canonicalIdentityFor(repo) {
  const phys = realOf(repo);
  const gi = gitInfo(repo);
  const nsRaw = gi ? phys + NUL + (gi.gitCommonReal || "") + NUL + (gi.branch !== null ? gi.branch : "detached:" + gi.head) : phys + NUL + "nogit";
  return { physKey: phys, nsKey: sha1(nsRaw).slice(0, 16), git: gi };
}
function localOriginFor(repo) {
  const gi = gitInfo(repo);
  return gi ? { kind: "git", worktreeReal: realOf(repo), gitCommonReal: gi.gitCommonReal || "" } : { kind: "historyless", rootReal: realOf(repo) };
}
function patchBasisFor(repo, topo) {
  const gi = gitInfo(repo);
  if (gi) return { kind: "git", ref: gi.branch !== null ? { type: "branch", name: gi.branch } : { type: "detached", head: gi.head }, baseHead: gi.head, oidFormat: gi.oidFormat };
  return { kind: "historyless", basisFp: PM.mapHashOf(topo), inventoryFp: PM.opHashOf(topo.inventory) };
}

// ── 서랍(§B) ─────────────────────────────────────────────────────────────────
function pipeRootFor(repo) { return path.join(BRIDGE_DIR, "map-pipeline", canonicalIdentityFor(repo).nsKey); }
function pipeDirFor(repo, mapId) { return path.join(pipeRootFor(repo), mapId); }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function dirsFor(repo, mapId) {
  if (!UUID_RE.test(String(mapId))) throw new Error("mapId가 UUID가 아님(경로 이탈 차단 — 14차 #6): " + String(mapId).slice(0, 40));
  const base = pipeDirFor(repo, mapId);
  return { base, pending: path.join(base, "pending"), wal: path.join(base, "wal"), walComplete: path.join(base, "wal-complete"), walAborted: path.join(base, "wal-aborted"), markers: path.join(base, "markers"), snapshots: path.join(base, "snapshots") };
}
function ensureDirs(repo, mapId) { const d = dirsFor(repo, mapId); for (const k of Object.keys(d)) fs.mkdirSync(d[k], { recursive: true }); return d; }
function listJson(dir) { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (e) { if (e && e.code === "ENOENT") return []; throw e; } } // unreadable=예외 전파(fail-closed — 12차 #7)

// 활성 WAL(writer barrier 재료 — §C: topology 부재·손상이라도 nsKey 전체 스캔 가능. 판독 실패=fail-closed).
function activePipelineWalFor(repo) {
  const root = pipeRootFor(repo);
  let mapIds;
  try { mapIds = fs.readdirSync(root); } catch (e) { return e && e.code === "ENOENT" ? { st: "none" } : { st: "unreadable" }; }
  const found = [];
  for (const m of mapIds) {
    const walDir = path.join(root, m, "wal");
    let items;
    try { items = fs.readdirSync(walDir).filter((f) => f.endsWith(".json")); } catch (e) { if (e && e.code === "ENOENT") continue; return { st: "unreadable" }; }
    for (const f of items) found.push({ mapId: m, decisionId: f.replace(/\.json$/, ""), file: path.join(walDir, f) });
  }
  return found.length ? { st: "active", items: found } : { st: "none" };
}

// ── nsLock(§B — 짧은 원자 전이 전용: wx+토큰. P1 funlock 패턴 승계·비중첩) ─────────
function withNsLock(repo, mapId, fn) {
  const d = ensureDirs(repo, mapId);
  const lockFile = path.join(d.base, ".nslock");
  const tok = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: tok }), { flag: "wx" }); } catch {
    // 자동 회수 없음(14차 #4 — 3자 경합의 상호배제 파괴 창을 P1 수준 fencing 없이 열지 않는다).
    // 죽은 잔재는 pipeline-gc(withMapLock 하)가 정리 — 여기서는 거부+경로 안내만(fail-closed).
    return { ok: false, error: "nsLock 점유/잔재(" + lockFile + ") — 잔재면 gc로 정리" };
  }
  const rb = readJson3(lockFile);
  if (!(rb.st === "ok" && rb.data.token === tok)) return { ok: false, error: "nsLock read-back 실패" };
  try { return { ok: true, result: fn() }; }
  finally { try { const h = readJson3(lockFile); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(lockFile); } catch { /* 무해 */ } }
}

// ── 파일 판독기(§E fail-closed) ──────────────────────────────────────────────────
// P4 증분 3(reader 검증 blocker②): '디렉터리 raw 캡처'와 '파싱·검증'을 분리 — 공용 reader가 map lock 안에서는
// 바이트 캡처만 하고 파싱·검증·해시는 잠금 밖에서 하도록. 기존 For 함수는 캡처+FromCapture 조합(단일 정본 —
// 3카피 금지·오류 메시지 동일).
function captureDirRaw(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { st: e && e.code === "ENOENT" ? "absent" : "error" }; }
  return { st: "ok", files: names.map((name) => { try { return { name, st: "ok", raw: fs.readFileSync(path.join(dir, name), "utf8") }; } catch { return { name, st: "unreadable" }; } }) };
}
function decisionIndexFromCapture(cap, mapId) {
  if (cap.st === "absent") return { st: "none" };
  if (cap.st !== "ok") return { st: "error", error: "decisions/ 판독 실패" };
  const files = cap.files.filter((f) => f.name.endsWith(".json") && !f.name.includes(path.sep) && !f.name.startsWith("legacy"));
  if (!files.length) return { st: "none" };
  const projections = [];
  for (const f of files) {
    let d = null;
    if (f.st === "ok") { try { d = JSON.parse(f.raw); } catch { d = null; } }
    if (d === null) return { st: "error", error: "decision 파일 손상(" + f.name + ")" }; // 조용한 skip 금지(§C-3)
    const errs = PM.validateDecisionAny(d); // P4 dual reader — v2/v3 판독(신규 기록은 v3만)
    if (errs.length) return { st: "error", error: "decision 스키마 위반(" + f.name + "): " + errs[0] };
    if (f.name !== d.decisionId + ".json") return { st: "error", error: "파일명≠decisionId(" + f.name + ")" };
    if (d.mapId !== mapId) continue; // 타 세대 — 색인 불참(파일명·스키마는 유효)
    if (PM.isPolicyOpV2(d.patch.operation)) continue; // 정책 op — 색인 제외(파일은 존재)
    projections.push(PM.adpOf(d));
  }
  return projections.length ? { st: "ok", projections } : { st: "none" };
}
function decisionIndexFor(repo, mapId) {
  return decisionIndexFromCapture(captureDirRaw(path.join(repo, "project-map", "decisions")), mapId);
}
function policyStateFromCapture(cap, mapId) {
  if (cap.st === "absent") return { st: "ok", policies: [], revocations: [], frontier: [], pfh: PM.policyFrontierHashOf([], []) }; // 부재도 frontier·pfh 완전체(빈 frontier 명시 주입 계약)
  if (cap.st !== "ok") return { st: "error", error: "policies/ 판독 실패" };
  const policies = [], revocations = [];
  for (const fc of cap.files) {
    const f = fc.name;
    let r = null;
    if (fc.st === "ok") { try { r = { data: JSON.parse(fc.raw), raw: fc.raw }; } catch { r = null; } }
    if (r === null) return { st: "error", error: "정책 파일 손상(" + f + ")" };
    if (f.endsWith(".revoke.json")) {
      const errs = PM.validatePolicyRevocation(r.data);
      if (errs.length) return { st: "error", error: "revocation 위반(" + f + "): " + errs[0] };
      if (f !== r.data.revocationId + ".revoke.json") return { st: "error", error: "파일명≠revocationId(" + f + ")" };
      revocations.push({ rec: r.data, fp: sha1(r.raw) });
    } else if (f.endsWith(".json")) {
      const errs = PM.validateIntentPolicy(r.data);
      if (errs.length) return { st: "error", error: "정책 위반(" + f + "): " + errs[0] };
      if (f !== r.data.policyId + ".json") return { st: "error", error: "파일명≠policyId(" + f + ")" };
      if (r.data.mapId === mapId) policies.push({ rec: r.data, fp: sha1(r.raw) });
    }
  }
  const frontier = PM.effectivePolicyFrontier(policies.map((x) => x.rec), revocations.map((x) => x.rec));
  const pfh = PM.policyFrontierHashOf(policies.map((x) => x.rec), revocations.map((x) => x.rec));
  return { st: "ok", policies, revocations, frontier, pfh };
}
function policyStateFor(repo, mapId) {
  return policyStateFromCapture(captureDirRaw(path.join(repo, "project-map", "policies")), mapId);
}
// authority 문맥(§E): decision 색인은 디스크, mapHash는 호출자의 동일 스냅샷 — 혼합 금지.
function authorityOf(mapHash, idx) {
  const dih = idx.st === "ok" ? PM.decisionIndexHashOf(idx.projections.map(PM.adpHashOf)) : PM.decisionIndexHashOf([]);
  return { dih, ah: PM.authorityHashOf(mapHash, dih) };
}

// ── read-set 재계산기(§D — 제안·대조 공용: 대조=재생성 비교가 결정론) ─────────────────
const entityHashOf = (ent) => sha1(PM.canonicalJsonOf(ent));
function buildReadSetFor(topo, patch, ctx) {
  // ctx: { idx: DecisionIndexState, pol: policyState, fileHashOf(ref)→hash|null }
  const rs = {};
  const op = patch.operation;
  const rules = PM.READSET_RULES[op];
  const pl = patch.payload || {};
  const find = (id) => (topo.nodes || []).find((x) => x.id === id) || (topo.edges || []).find((x) => x.id === id) || null;
  // T 대상(12차 #1): 생성 op는 '읽는' 기존 entity가 T — add_edge=from/to(§D 표 명문).
  const readTargetIds = (() => {
    if (op === "add_edge") { const e = pl.edge || {}; return [e.from, e.to].filter((id) => find(id)); }
    return PM.targetIdsOfPatch(patch).filter((id) => find(id));
  })();
  if (rules.T === "required") rs.targets = [...new Set(readTargetIds)].sort().map((id) => ({ id, contentHash: entityHashOf(find(id)) }));
  if (rules.E !== "forbidden") {
    const refs = new Set();
    for (const e of patch.evidence || []) refs.add(e.ref);
    for (const t of (patch.readSet && patch.readSet.files) || []) refs.add(t.ref);
    if (op === "add_anchor" && pl.anchor && pl.anchor.path) refs.add(pl.anchor.path); // anchor 파일 자체(12차 #1)
    if (op === "widen" && pl.additions && Array.isArray(pl.additions.anchors)) for (const a of pl.additions.anchors) if (a && a.path) refs.add(a.path);
    // P4(설계 v8 ⑤): 대상·생성·분할·병합 결과 node의 '모든' anchor를 read-set에 포함 — anchor 기준선 지문의
    // 유일 출처(CAS가 검증한 지문만 기준선이 될 수 있게 set_state/rewrite_label/merge/add 계열까지 확장).
    const addNodeAnchors = (nd) => { for (const a of (nd && nd.anchors) || []) if (a && a.path) refs.add(a.path); };
    for (const id of readTargetIds) addNodeAnchors(find(id));
    if (op === "add_node") addNodeAnchors(pl.node);
    if (op === "split_node") for (const nn of pl.newNodes || []) addNodeAnchors(nn);
    if (op === "merge_node") { addNodeAnchors(find(pl.survivorId)); for (const ab of pl.absorbed || []) { if (ab && ab.anchorsTo) addNodeAnchors(find(ab.anchorsTo)); if (ab && ab.evidenceTo) addNodeAnchors(find(ab.evidenceTo)); } } // 1차 blocker③: 외부 destination node의 기존 anchor 포함
    rs.files = [...refs].sort().map((ref) => ({ ref, contentHash: ctx.fileHashOf(ref) || sha1("__missing__" + ref) }));
    if (!rs.files.length) delete rs.files;
  }
  if (rules.A === "required") {
    const keys = [];
    const adjOf = (nodeId) => sha1(JSON.stringify((topo.edges || []).filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.id).sort()));
    if (op === "add_edge") { const e = pl.edge || {}; keys.push({ key: "adj:" + e.from, hash: adjOf(e.from) }, { key: "adj:" + e.to, hash: adjOf(e.to) }); }
    else if (op === "change_relation") { const tr = find(patch.targetId); if (tr) keys.push({ key: "endpoints:" + patch.targetId, hash: sha1(JSON.stringify([entityHashOf(find(tr.from) || {}), entityHashOf(find(tr.to) || {})])) }); }
    else if (op === "split_node" || op === "tombstone_candidate") keys.push({ key: "adj:" + patch.targetId, hash: adjOf(patch.targetId) });
    else if (op === "split_edge") { const tr = find(patch.targetId); if (tr) keys.push({ key: "endpoints:" + patch.targetId, hash: sha1(JSON.stringify([tr.from, tr.to])) }); }
    else if (op === "merge_node") for (const id of patch.targetIds || []) keys.push({ key: "adj:" + id, hash: adjOf(id) });
    else if (op === "merge_edge") { for (const id of patch.targetIds || []) { const tr = find(id); if (tr) keys.push({ key: "parallel:" + id, hash: sha1(JSON.stringify((topo.edges || []).filter((e) => (e.from === tr.from && e.to === tr.to)).map((e) => e.id).sort())) }); } }
    else if (op === "supersede") { const succ = find(pl.successorId); keys.push({ key: "successor:" + pl.successorId, hash: succ ? entityHashOf(succ) : sha1("__absent__") }, { key: "adj:" + patch.targetId, hash: adjOf(patch.targetId) }); }
    if (keys.length) rs.adjacency = keys.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
  if (rules.N === "required") {
    const negs = [];
    const absent = (key) => ({ kind: "absent", key, fingerprint: sha1("absent:" + key + ":" + String(!find(key.split(":").pop()))) });
    const dirInvOf = (rel) => { try { const dir = path.isAbsolute(rel) ? rel : path.join(ctx.repoRoot || "", rel); return sha1(JSON.stringify(fs.readdirSync(dir).sort())); } catch { return sha1("__nodir__" + rel); } };
    if (op === "add_node") {
      negs.push(absent("node:" + ((pl.node || {}).id || "")));
      for (const an of ((pl.node || {}).anchors || [])) negs.push({ kind: "dir-inventory", key: "dir:" + path.dirname(an.path), fingerprint: dirInvOf(path.dirname(an.path)) }); // §D: anchors 디렉터리 인벤토리
    }
    else if (op === "add_edge") { const e = pl.edge || {}; negs.push({ kind: "absent", key: "edge-sig:" + e.from + ">" + e.to + ":" + e.relation, fingerprint: sha1(JSON.stringify((topo.edges || []).some((x) => x.from === e.from && x.to === e.to && x.relation === e.relation))) }); }
    else if (op === "split_node") for (const n of pl.newNodes || []) negs.push(absent("node:" + n.id));
    else if (op === "split_edge") for (const e of pl.newEdges || []) negs.push(absent("edge:" + e.id));
    else if (op === "change_relation") { const tr = find(patch.targetId) || {}; negs.push({ kind: "absent", key: "edge-sig:" + tr.from + ">" + tr.to + ":" + pl.to, fingerprint: sha1(JSON.stringify((topo.edges || []).some((x) => x.id !== patch.targetId && x.from === tr.from && x.to === tr.to && x.relation === pl.to))) }); }
    else if (op === "tombstone_candidate" || op === "widen" || op === "narrow") {
      negs.push({ kind: "range", key: "entity:" + patch.targetId, fingerprint: entityHashOf(find(patch.targetId) || {}) });
      if (op === "widen" && pl.additions && Array.isArray(pl.additions.anchors)) for (const an of pl.additions.anchors) negs.push({ kind: "dir-inventory", key: "dir:" + path.dirname(an.path), fingerprint: dirInvOf(path.dirname(an.path)) });
    }
    else if (op === "supersede") { const tr = find(patch.targetId) || {}; negs.push({ kind: "absent", key: "supersede-rel:" + patch.targetId + ">" + pl.successorId, fingerprint: sha1(JSON.stringify((topo.edges || []).some((x) => x.relation === "supersedes" && x.from === pl.successorId && x.to === patch.targetId))) }); void tr; }
    else if (op === "create_intent_policy") negs.push({ kind: "absent", key: "policy:" + ((pl.policy || {}).policyId || ""), fingerprint: sha1(JSON.stringify(((ctx.pol || {}).policies || []).some((x) => x.rec.policyId === (pl.policy || {}).policyId))) });
    // canonical 정렬은 검증기(validateReadSetShape)와 동일한 kind\0key 복합키 — key 단독 정렬은 kind가 섞이는
    // op(add_node의 absent+dir-inventory 등)에서 'N 형식 위반'을 유발하던 잠복 결함(P4 증분 1 테스트가 노출).
    const negKeyOf = (x) => x.kind + "\u0000" + x.key;
    // canonical 중복 제거(2차 [보완]②): 같은 디렉터리에 anchor가 여러 개인 add_node/widen은 동일 dir-inventory
    // 항목을 중복 생성했고 검증기는 중복 key를 거부한다 — 유효 patch가 자기 read-set 때문에 거부되던 결함.
    const negSeen = new Set();
    const negUniq = negs.filter((x) => { const k = negKeyOf(x); if (negSeen.has(k)) return false; negSeen.add(k); return true; });
    if (negUniq.length) rs.negative = negUniq.sort((a, b) => (negKeyOf(a) < negKeyOf(b) ? -1 : 1));
  }
  if (rules.X === "required") {
    const involved = new Set([...PM.targetIdsOfPatch(patch)]);
    if (op === "supersede") involved.add(pl.successorId);
    if (op === "add_edge") { const e = pl.edge || {}; involved.add(e.from); involved.add(e.to); }
    if (op === "change_relation") { const tr = find(patch.targetId); if (tr) { involved.add(tr.from); involved.add(tr.to); } } // endpoints(12차 #1)
    const projs = ctx.idx.st === "ok" ? ctx.idx.projections : [];
    rs.decisionIndex = [...involved].sort().map((id) => ({ id, indexFp: sha1(JSON.stringify(projs.filter((p2) => p2.targetIds.includes(id)).map(PM.adpHashOf).sort())) }));
  }
  // P 조건부(◐ — 12차 #1): ②b 승격 판정과 동형(대상·생성물 잠금 or scope·opClass 일치 정책 존재)이면 생성.
  const pNeeded = (() => {
    if (rules.P !== "conditional") return false;
    const created = [pl.node, pl.edge, ...(pl.newNodes || []), ...(pl.newEdges || [])].filter(Boolean);
    const lockRef = [...readTargetIds.map(find), ...created].some((e) => e && (e.decisionLocks || []).some((l) => l.kind === "policy-ref"));
    if (lockRef) return true;
    const involved0 = new Set([...PM.targetIdsOfPatch(patch), ...created.map((e) => e.id)]);
    return (ctx.pol.frontier || []).some((pol2) => {
      if ((pol2.exclusions || []).some((x) => involved0.has(x))) return false;
      if (pol2.scope !== "project" && !(pol2.scopeTarget || []).some((id) => involved0.has(id))) return false;
      const pe = pol2.predicateExpr || {};
      return pe.version === 1 && pe.kind === "op-class" && typeof pe.opClass === "string" && (pe.opClass === op || op.startsWith(pe.opClass + "_"));
    });
  })();
  if (rules.P === "required" || pNeeded || (patch.readSet && patch.readSet.policies)) {
    const pol = ctx.pol;
    const refs = [];
    const wanted = new Set([...(patch.targetPolicyIds || []), ...(patch.targetPolicyId ? [patch.targetPolicyId] : [])]);
    if (pNeeded) { // 적용 판정된 정책의 policyFp도 결속(§D refs 계약 — 13차 #7)
      const involved0 = new Set([...PM.targetIdsOfPatch(patch), ...[pl.node, pl.edge, ...(pl.newNodes || []), ...(pl.newEdges || [])].filter(Boolean).map((e) => e.id)]);
      for (const pol2 of ctx.pol.frontier || []) {
        if ((pol2.exclusions || []).some((x) => involved0.has(x))) continue;
        if (pol2.scope !== "project" && !(pol2.scopeTarget || []).some((id) => involved0.has(id))) continue;
        const pe = pol2.predicateExpr || {};
        if (pe.version === 1 && pe.kind === "op-class" && typeof pe.opClass === "string" && (pe.opClass === op || op.startsWith(pe.opClass + "_"))) wanted.add(pol2.policyId);
      }
    }
    for (const x of (pol.policies || [])) if (wanted.has(x.rec.policyId) || (patch.readSet && (patch.readSet.policies || { refs: [] }).refs.some((r) => r.policyId === x.rec.policyId))) refs.push({ policyId: x.rec.policyId, policyFp: x.fp });
    rs.policies = { refs: refs.sort((a, b) => (a.policyId < b.policyId ? -1 : 1)), frontierHash: pol.pfh };
    if (wanted.size) rs.policies.revocationAbsent = [...wanted].sort().filter((id) => !(pol.revocations || []).some((r) => r.rec.targetPolicyId === id));
    if (rs.policies.revocationAbsent && !rs.policies.revocationAbsent.length) delete rs.policies.revocationAbsent;
  }
  return rs;
}
// read-set 대조(§D CAS 재검사): 제안의 readSet과 현재 재계산의 카테고리별 canonical 비교.
function readSetIntact(topo, patch, ctx) {
  const now = buildReadSetFor(topo, patch, ctx);
  const cats = ["targets", "files", "adjacency", "negative", "decisionIndex", "policies"];
  const bad = [];
  for (const c of cats) {
    const want = patch.readSet[c];
    if (want === undefined) continue;
    if (PM.canonicalJsonOf(want) !== PM.canonicalJsonOf(now[c] === undefined ? null : now[c])) bad.push(c);
  }
  return { intact: bad.length === 0, broken: bad };
}

// ── CAS 판정(§D — 2단: hard boundary → 재검사 신호 → read-set) ─────────────────────
function casCheck(repo, patch, topo, ctx, pendingOrigin) {
  const origin = localOriginFor(repo);
  if (PM.canonicalJsonOf(origin) !== PM.canonicalJsonOf(pendingOrigin)) return { disposition: "hard-reject", reason: "ExecutionOrigin 불일치(worktree/root 이동)" };
  const gi = ctx.git;
  const b = patch.basis;
  if (b.kind === "git") {
    if (!gi) return { disposition: "hard-reject", reason: "git basis인데 현재 비-git" };
    if (b.ref.type === "branch" && gi.branch !== b.ref.name) return { disposition: "hard-reject", reason: "branch 이탈" };
    if (b.ref.type === "detached" && (gi.branch !== null || gi.head !== b.ref.head)) return { disposition: "hard-reject", reason: "detached identity 이탈" };
    if (gi.head !== b.baseHead && !gi.isAncestor(b.baseHead)) return { disposition: "hard-reject", reason: "non-ancestor(reset/rebase — 전진만 재기반)" };
  } else if (gi) return { disposition: "hard-reject", reason: "historyless basis인데 현재 git" };
  // 재검사 신호(불일치=read-set 재검사 진입): head 전진 / 3해시
  const mapHash = PM.mapHashOf(topo);
  const { ah } = authorityOf(mapHash, ctx.idx);
  const dch = PM.decisionContextHashOf(ah, ctx.pol.pfh);
  const invNow = PM.opHashOf(topo.inventory);
  const drift = (b.kind === "git" && gi.head !== b.baseHead)
    || (b.kind === "historyless" && (mapHash !== b.basisFp || invNow !== b.inventoryFp)) // inventoryFp도 신호(12차 #2)
    || patch.baseMapHash !== mapHash || patch.baseAuthorityHash !== ah || patch.baseDecisionContextHash !== dch;
  // read-set은 drift 무관 '항상' 대조(12차 #2 — evidence/anchor 파일만 바뀌는 E 파손은 해시 신호에 안 잡힘)
  const rsChk = readSetIntact(topo, patch, ctx);
  if (!rsChk.intact) return { disposition: "stale-expired", broken: rsChk.broken }; // 파손=자동 정리(1-10 ①)
  if (!drift) return { disposition: "proceed", current: { mapHash, ah, dch } };
  return { disposition: "rebase", current: { mapHash, ah, dch } }; // read-set 보존=재기반(base 갱신 후 진행)
}

// ── proposal lifecycle(1-21 ③) ────────────────────────────────────────────────
function pendingFileFor(repo, mapId, patchId) { return path.join(dirsFor(repo, mapId).pending, patchId + ".json"); }
function proposePatch(repo, patch) {
  const errs = PM.validatePatchV2(patch);
  if (errs.length) return { ok: false, stage: "schema", errors: errs };
  ensureDirs(repo, patch.mapId);
  const w7 = withNsLock(repo, patch.mapId, () => { // 원자 멱등(14차 #7 — 동시 propose의 덮어쓰기 차단)
    const f = pendingFileFor(repo, patch.mapId, patch.patchId);
    if (fs.existsSync(f)) {
      const cur = readJson3(f);
      if (cur.st === "ok" && cur.data.patch && PM.opHashOf(cur.data.patch) === PM.opHashOf(patch)) return { ok: true, idempotent: true };
      return { ok: false, stage: "conflict", errors: ["같은 patchId의 다른 내용 — 멱등 위장 금지"] };
    }
    const rec = { schema: "map-pending-v2", lifecycle: "proposed", patch, localOrigin: localOriginFor(repo), proposedAt: new Date().toISOString() };
    return CL.atomicWrite(f, JSON.stringify(rec, null, 1)) ? { ok: true } : { ok: false, stage: "write", errors: ["pending 기록 실패"] };
  });
  return w7.ok ? w7.result : { ok: false, stage: "lock", errors: [w7.error] };
}
// 기본 분류(§3 표 — 출발점. P2 실경로: auto만 apply 도달)
const DEFAULT_CLASSIFICATION = {
  add_node: "auto", add_edge: "auto", set_state: "auto", add_anchor: "auto", add_evidence: "auto", add_condition: "auto",
  change_relation: "verifier-resolved", split_node: "verifier-resolved", split_edge: "verifier-resolved",
  merge_node: "verifier-resolved", merge_edge: "verifier-resolved", widen: "verifier-resolved", narrow: "verifier-resolved",
  supersede: "verifier-resolved", tombstone_candidate: "needs-investigation",
  change_steward: "intent-choice", change_authority: "intent-choice", rewrite_label: "verifier-resolved",
  create_intent_policy: "intent-choice", supersede_intent_policy: "intent-choice", revoke_intent_policy: "intent-choice",
};
function classifyPatch(repo, mapId, patchId) {
  const f = pendingFileFor(repo, mapId, patchId);
  const pr = readJson3(f);
  if (pr.st !== "ok") return { ok: false, error: "pending 판독 실패(" + pr.st + ")" };
  const patch = pr.data.patch;
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { ok: false, error: "topology 판독 실패(" + rt.st + ")" };
  const pol = policyStateFor(repo, mapId);
  if (pol.st !== "ok") return { ok: false, error: pol.error };
  const verdict = PM.semanticValidateV2(rt.topo, patch, { frontier: pol.frontier, policyIds: new Set((pol.policies || []).map((x) => x.rec.policyId)), artifactIds: new Set([...(pol.policies || []).map((x) => x.rec.policyId), ...(pol.revocations || []).map((x) => x.rec.revocationId)]), revokedPolicyIds: new Set((pol.revocations || []).map((x) => x.rec.targetPolicyId)) });
  let classification, lifecycle = "classified";
  if (verdict.disposition === "hard-reject") { classification = "hard-reject"; lifecycle = "expired"; }
  else if (verdict.disposition === "needs-investigation") classification = "needs-investigation";
  else classification = DEFAULT_CLASSIFICATION[patch.operation] || "needs-investigation";
  const wrote = withNsLock(repo, mapId, () => { // nsLock 안 CAS 갱신(12차 #5 — claimed 덮어쓰기 방지)
    const cur = readJson3(f);
    if (cur.st !== "ok") return { ok: false, error: "pending 재판독 실패" };
    if (cur.data.lifecycle === "claimed") return { ok: false, error: "claimed 상태 — classify 불가(진행 중)" };
    if (["resolved", "expired", "resolved-noop"].includes(cur.data.lifecycle)) return { ok: false, error: "종결 상태(" + cur.data.lifecycle + ") — 재분류 금지(재적용 차단: 13차 #6)" };
    // P8(설계 v10): terminal 종결은 기계 판독 expireCode를 같은 원자 쓰기에 동봉(반환 코드는 프로세스
    // 사망으로 유실될 수 있다 — 재시작 복구는 expireCode로만 분기·expireReason은 사람용).
    const rec = { ...cur.data, lifecycle, classification, classifiedAt: new Date().toISOString(), semanticErrors: verdict.errors, ...(lifecycle === "expired" ? { expiredAt: new Date().toISOString(), expireReason: "classify hard-reject: " + (verdict.errors[0] || ""), expireCode: "hard-reject" } : {}) };
    return CL.atomicWrite(f, JSON.stringify(rec, null, 1)) ? { ok: true } : { ok: false, error: "pending 갱신 실패" };
  });
  if (!wrote.ok || !wrote.result.ok) return { ok: false, error: (wrote.result && wrote.result.error) || wrote.error };
  return { ok: true, classification, errors: verdict.errors };
}

// ── P8: pending 종결 진입점(설계 v10 P8-0 ③ — 구 revision 종결 의무의 유일 표면) ─────────
// lifecycle CAS 분기표(설계검증 8~9차): proposed|classified+opHash 일치=expired 전환 / claimed=busy 거부
// (recover-first — 적용 중 pending 불가침·claim~map잠금 사이에 끼어드는 8차 재현 경로 차단) /
// resolved|resolved-noop=already-applied 거부(적용 완료 불변) / 이미 expired=idempotent 성공 /
// 부재·opHash 불일치=conflict 거부(다른 주체 관여 — 직접 삭제로 증명 경계를 우회하지 않는다).
function expirePendingPatch(repo, mapId, patchId, expectedOpHash) {
  const w = withNsLock(repo, mapId, () => {
    const f = pendingFileFor(repo, mapId, patchId);
    const pr = readJson3(f);
    if (pr.st === "absent") return { ok: false, reason: "conflict", error: "pending 부재" };
    if (pr.st !== "ok") return { ok: false, reason: "conflict", error: "pending 판독 실패(" + pr.st + ")" };
    const rec = pr.data;
    if (rec.lifecycle === "expired") return { ok: true, reason: "idempotent" };
    if (rec.lifecycle === "claimed") return { ok: false, reason: "busy", error: "claimed — recover-first(적용 중 pending 불가침)" };
    if (rec.lifecycle === "resolved" || rec.lifecycle === "resolved-noop") return { ok: false, reason: "already-applied", error: "적용 완료 불변" };
    if (!rec.patch || PM.opHashOf(rec.patch) !== expectedOpHash) return { ok: false, reason: "conflict", error: "opHash 불일치(다른 주체 관여)" };
    if (rec.lifecycle !== "proposed" && rec.lifecycle !== "classified") return { ok: false, reason: "conflict", error: "미지 lifecycle(" + String(rec.lifecycle) + ")" };
    const next = { ...rec, lifecycle: "expired", expiredAt: new Date().toISOString(), expireReason: "revision superseded(P8 rev 전진)", expireCode: "superseded" };
    return CL.atomicWrite(f, JSON.stringify(next, null, 1)) ? { ok: true, reason: "expired" } : { ok: false, reason: "conflict", error: "쓰기 실패" };
  });
  if (!w.ok) return { ok: false, reason: "lock", error: w.error };
  return w.result;
}

// P8(재검증 blocker — terminal 기록 실패 시 rollback도 같은 잠금에 막혀 claimed 잔존): terminal 종결 기록과
// claim 롤백 폴백을 '하나의 nsLock 안'에서 처리+잠금 경합은 bounded 재시도(경합 창은 짧은 파일 RMW라 수 ms —
// 일시 경합은 재시도로 해소·영구 잔재는 어떤 구현도 잠금 없이 쓰면 상호배제가 깨지므로 정직 반환+기존 복구
// 표면[gc·claim 사망 판정] 소관). 반환: {wrote, rolledBack?, error?} — wrote=false여도 rolledBack=true면
// pending은 classified로 복원돼 rev 전진 CAS 대상.
function persistTerminalExpire(repo, mapId, patchId, expireReason, expireCode, claimToken) {
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 대기 실패=즉시 재시도 */ } };
  for (let i = 0; i < 40; i++) { // ~2s(3차 재검증: 500ms는 긴 보유를 못 흡수 — 소진 잔존은 아래 자기 소유 재선점이 자연 회수)
    const tw = withNsLock(repo, mapId, () => {
      const f = pendingFileFor(repo, mapId, patchId);
      const pr = readJson3(f);
      if (pr.st !== "ok") return { wrote: false, error: "pending 판독 실패(" + pr.st + ")" };
      const rec = pr.data;
      // 3차 재검증(소유권 CAS — 기록 '전' 검사): 이 helper의 계약은 '자기 claim의 terminal 전환'뿐 —
      // claimed+자기 pid+token 일치만 expired 전환. 그 외 lifecycle·타 소유 claim은 거부(아무 레코드나
      // expired로 덮는 우회 차단 — expirePendingPatch의 lifecycle 분기표와 역할 분리).
      if (rec.lifecycle !== "claimed") return { wrote: false, error: "소유권/상태 불일치(lifecycle=" + String(rec.lifecycle) + " — claimed 자기 claim만 terminal 전환)" };
      // 4차 재검증: claimToken은 필수 정확 일치 — 빈 토큰이 같은 pid의 다른 claim을 덮는 우회 차단
      if (typeof claimToken !== "string" || !claimToken) return { wrote: false, error: "claimToken 필수(빈 토큰으로 terminal 전환 불가)" };
      if (!rec.claim || rec.claim.pid !== process.pid || rec.claim.token !== claimToken) return { wrote: false, error: "소유권 불일치(타 claim — terminal 전환 거부)" };
      if (CL.atomicWrite(f, JSON.stringify({ ...rec, lifecycle: "expired", expiredAt: new Date().toISOString(), expireReason, ...(expireCode ? { expireCode } : {}) }, null, 1))) return { wrote: true };
      // 기록 실패 — 같은 잠금 안에서 claim 롤백 시도(claimed 잔존 차단)
      const back = { ...rec, lifecycle: "classified" }; delete back.claim;
      return { wrote: false, rolledBack: CL.atomicWrite(f, JSON.stringify(back, null, 1)), error: "expired 쓰기 실패" };
    });
    if (tw.ok) return tw.result;
    sleep(50); // 잠금 경합 — 재시도(일시 경합 흡수)
  }
  return { wrote: false, rolledBack: false, error: "nsLock 경합 지속(잔재 가능 — 자기 소유 claim은 다음 apply 재호출이 재선점 회수·잔재 잠금은 gc 소관)" };
}

// ── P4-3ⓐ 기준선 기록 훅 재료(설계 v8 — 증분 2·순수 계산) ─────────────────────
// 기준선 지문의 출처(5차 blocker): 'CAS가 방금 검증한 livePatch.readSet.files의 동일 경로 지문'에서만 복사 —
// apply 후 재해시 금지('CAS 직후 외부 편집' 흡수 차단). read-set에 없는 anchor=기준선 미생성(축 unknown 유지).
// missing sentinel 지문도 기준선으로 복사(2차 blocker③ — 부재도 CAS가 검증한 상태: 이후 파일이 생기면
// 지문 불일치=stale로 감지된다. 판정기[P4-3]의 현재 지문은 부재 시 같은 sentinel 규약으로 계산할 계약).
// edge=anchor축 N/A(node만).
function baselineUpdatesFor(patch, decisionId, affectedIds, outTopo) {
  const fpByRef = new Map((((patch || {}).readSet || {}).files || []).map((x) => [x.ref, x.contentHash]));
  const up = {};
  const seenAt = new Date().toISOString();
  for (const id of affectedIds || []) {
    const nd = ((outTopo || {}).nodes || []).find((x) => x && x.id === id);
    if (!nd) continue;
    for (const a of nd.anchors || []) {
      if (!a || !a.path) continue;
      const fp = fpByRef.get(a.path);
      if (!fp) continue; // read-set에 없는 anchor=기준선 미생성(④)
      up["a:" + id + "|" + a.path] = { fp, seenAt, basisDecisionId: decisionId };
    }
  }
  return up;
}

// ── apply(§B 클레임+§F 트랜잭션) ────────────────────────────────────────────────
function applyPatch(repo, mapId, patchId, opts) {
  const o = opts || {};
  // P3b C-4: 권위 분기 — blocked=플래그 무관 전면 거부(receipt-only 중단 위에 topology 변경 금지·설계검증
  // 2차 #3) / v2=플래그 불요(자동 적용 활성화 1-30) / legacy=기존 --pre-cutover 명시 필수. lazy require —
  // map-bindings가 이 모듈을 top-level require하므로 역방향은 실행 시점만(순환 초기화 회피).
  // P8(설계 v10 P8-0 ④): 반환에 기계 판독 reasonCode 동봉 — 닫힌 열거(일시=wal-active|lock|write-failed|
  // claim-busy / 영구-전진=cas-stale / 영구-park=hard-reject|authority-blocked|wal-corrupt|decision-conflict|
  // semantic-reject|not-classified / 완료=already-applied). 명확히 매핑되지 않는 반환점은 코드 미부여 —
  // 소비자는 미지·미부여=fail-closed park(기존 {ok,error} 문자열 무회귀).
  const auth0 = (() => { try { return require(path.join(__dirname, "map-bindings.js")).authorityStateFor(repo); } catch { return null; } })();
  if (auth0 === null) return { ok: false, reasonCode: "authority-blocked", error: "권위 판독 불가(map-bindings 로드 실패) — 적용 거부(fail-closed)" };
  if (auth0.st === "blocked") return { ok: false, reasonCode: "authority-blocked", error: "권위 상태 blocked(" + (auth0.reasonKey || "") + ": " + auth0.reason + ") — 적용 거부. 전환 중단 상태면 cutover 재실행으로 재개하라" };
  o._authV2 = auth0.st === "v2"; // 기록 필드 분기 재료(아래 decision 조립 — 잠금 안 재검사와 함께 최종 확정)
  if (!o.preCutover && !o._authV2) return { ok: false, error: "--pre-cutover 명시 필수(§A — cutover 전 수동 적용 승인)" };
  const d = ensureDirs(repo, mapId);
  // §B ①′ 사전 검사: 활성 WAL 있으면 claim 자체를 만들지 않음
  const aw = activePipelineWalFor(repo);
  if (aw.st === "unreadable") return { ok: false, reasonCode: "wal-corrupt", error: "WAL 서랍 판독 불가(fail-closed)" };
  if (aw.st === "active") return { ok: false, reasonCode: "wal-active", error: "활성 WAL 존재 — recoverWal 선행: " + aw.items.map((x) => x.decisionId).join(",") };
  // §B ① 클레임(nsLock — 3대 분기)
  // decisionId 발급은 nsLock '안'에서(12차 #5 — preview 경쟁 창 제거). 값은 클레임 결과로 회수.
  const claim = withNsLock(repo, mapId, () => {
    const f = pendingFileFor(repo, mapId, patchId);
    const pr = readJson3(f);
    if (pr.st !== "ok") return { ok: false, error: "pending 판독 실패(" + pr.st + ")" };
    const rec = pr.data;
    if (rec.lifecycle === "resolved" || rec.lifecycle === "resolved-noop") return { ok: false, reasonCode: "already-applied", error: "이미 종결(" + rec.lifecycle + ")" };
    if (rec.lifecycle === "expired") return { ok: false, error: "이미 종결(expired)" }; // 코드 미부여 — 소비자는 pending의 영속 expireCode로 분기(P8 상태표 ⑦)
    if (rec.lifecycle === "claimed") {
      const cid = rec.claim && rec.claim.decisionId;
      if (cid && fs.existsSync(path.join(d.wal, cid + ".json"))) return { ok: false, reasonCode: "wal-active", error: "진행 중(활성 WAL) — recoverWal" }; // ⓐ
      const cw = cid ? readJson3(path.join(d.walComplete, cid + ".json")) : { st: "absent" };
      if (cw.st === "invalid" || cw.st === "unreadable") return { ok: false, error: "완료 영수증 손상/판독 불가 — conflict(재선점 금지·18차 #1)" };
      if (cw.st === "ok") { // ⓑ/ⓑ′ 완료 영수증 — 전체 검증 후 보충 종결·재적용 금지(18차 #1)
        const wErr = validateWalV2(cw.data, cid + ".json");
        if (wErr) return { ok: false, error: "완료 영수증 WAL 위반(" + wErr + ") — conflict" };
        const cwd = cw.data;
        const decFile = path.join(repo, "project-map", "decisions", cid + ".json");
        const D3r = fileSha3(decFile);
        if (D3r.st !== "ok" || D3r.hash !== cwd.expectedDecisionFileAfterHash) return { ok: false, error: "완료 영수증과 decision 파일 불일치/부재 — conflict(수동 확인)" };
        if (cwd.policyArtifact) {
          const pfPath = path.join(repo, "project-map", "policies", cwd.policyArtifact.kind === "intent-policy" ? cwd.policyArtifact.policyId + ".json" : cwd.policyArtifact.revocationId + ".revoke.json");
          const Pf3r = fileSha3(pfPath);
          if (Pf3r.st !== "ok" || Pf3r.hash !== cwd.policyArtifact.expectedFileHash) return { ok: false, error: "완료 영수증과 policy 파일 불일치/부재 — conflict(frontier 미반영 종결 차단)" };
        }
        const mkPath = path.join(d.markers, cid + ".json");
        const mk3r = readJson3(mkPath);
        if (mk3r.st === "invalid" || mk3r.st === "unreadable") return { ok: false, error: "marker 손상 — conflict" };
        let markerOk = mk3r.st === "ok" && PM.canonicalJsonOf(mk3r.data) === PM.canonicalJsonOf(cwd.expectedMarker);
        if (!markerOk) { // ⓑ′: 파일 재검증을 통과했으므로 marker 보충 — 쓰기 결과 검사(18차 #2)
          if (!CL.atomicWrite(mkPath, JSON.stringify(cwd.expectedMarker, null, 1))) return { ok: false, reasonCode: "write-failed", error: "marker 보충 실패 — 재시도 필요(종결 안 됨)" };
          markerOk = true;
        }
        const wrote = CL.atomicWrite(pendingFileFor(repo, mapId, patchId), JSON.stringify({ ...rec, lifecycle: "resolved", resolvedAt: new Date().toISOString() }, null, 1));
        if (!wrote) return { ok: false, reasonCode: "write-failed", error: "영수증 확인·pending 종결 쓰기 실패 — 재시도 필요(supplemented 아님·18차 #2)" };
        return { ok: false, reasonCode: "already-applied", error: "이미 적용 완료 — 검증 후 보충 종결(재적용 금지)", supplemented: true };
      }
      { // 영수증 소실 혼합 상태(19차 #1): wal·wal-complete 모두 부재인데 durable 산출물이 하나라도 있으면
        // pre-WAL 사망이 아니다 — 자동 재선점 금지(topology는 새 decisionId로 재적용 왜곡·정책은 영구 claimed).
        const D3m = cid ? fileSha3(path.join(repo, "project-map", "decisions", cid + ".json")) : { st: "absent" };
        const mk3m = cid ? readJson3(path.join(d.markers, cid + ".json")) : { st: "absent" };
        let Pf3m = { st: "absent" }; // 정책 artifact 잔존(20차 #2 — patch에서 결정론 유도)
        if (cid && PM.isPolicyOpV2(rec.patch.operation)) {
          const pl2 = rec.patch.payload || {};
          const pfName = rec.patch.operation === "revoke_intent_policy" ? ((pl2.revocation || {}).revocationId + ".revoke.json") : ((pl2.policy || {}).policyId + ".json");
          Pf3m = fileSha3(path.join(repo, "project-map", "policies", pfName));
        }
        if (D3m.st !== "absent" || mk3m.st !== "absent" || Pf3m.st !== "absent") return { ok: false, error: "영수증 소실·산출물 잔존 혼합 상태 — conflict(수동 확인: decisions/" + cid + ")" };
      }
      // ⓒ pre-WAL 사망 회수
      const pid = rec.claim && rec.claim.pid;
      // P8(3차 재검증 — terminal 기록 실패 후 claimed 잔존의 자연 회수): 자기 프로세스 소유 claim은 사망과
      // 동일하게 재선점 허용 — 같은 프로세스의 동시 apply는 이 nsLock으로 직렬화되므로 활성 진행과의 경합이
      // 없고, 위의 WAL·완료 영수증·durable 잔존 검사를 이미 통과한 상태(pre-WAL)라 안전.
      const dead = !Number.isInteger(pid) || pid === process.pid || (() => { try { process.kill(pid, 0); return false; } catch (e) { return !!(e && e.code === "ESRCH"); } })();
      if (!dead) return { ok: false, reasonCode: "claim-busy", error: "타 프로세스 claim 보유 중" };
    }
    const prevOp = rec.patch ? rec.patch.operation : null;
    const prevPl = rec.patch ? (rec.patch.payload || {}) : {};
    const decisionId = prevOp === "revoke_intent_policy" ? (prevPl.revocation || {}).createdFromDecision
      : (prevOp === "create_intent_policy" || prevOp === "supersede_intent_policy") ? (prevPl.policy || {}).createdFromDecision
      : crypto.randomUUID();
    if (!decisionId) return { ok: false, error: "정책 artifact의 createdFromDecision 부재" };
    if (fs.existsSync(path.join(repo, "project-map", "decisions", decisionId + ".json"))) return { ok: false, error: "decisionId 충돌(기존 decision 존재)" };
    const isPolicyOp = PM.isPolicyOpV2(rec.patch.operation);
    if (isPolicyOp) {
      // 정책 op(§A·정본 §3 '사용자 선택의 산물만'): intent-choice 분류+해소 참조(선택 카드/레코드) 필수.
      // P9 전 공개 해소 경로 없음 — 테스트·후속 단계만 opts.resolutionRef 주입.
      if (rec.classification !== "intent-choice") return { ok: false, error: "정책 op는 classification=intent-choice여야(classify 선행)" };
      if (!o.resolutionRef) return { ok: false, error: "정책 op는 해소 참조(resolutionRef) 없이 적용 불가(§A — intent-choice 카드는 P9)" };
      if (!(rec.patch.authorizationRefs || []).some((x) => x.kind === "user-choice" && x.ref === o.resolutionRef)) return { ok: false, error: "resolutionRef가 patch.authorizationRefs(user-choice)와 불일치(선택→정책 귀속 — A1 계약)" };
    } else if (rec.classification === "verifier-resolved" && o.verifierResolution && typeof o.verifierResolution === "object") {
      // P8(설계 v10 P8-4): 예약돼 있던 '해소 레코드 검증기' 자리 — 1-5 결속을 nsLock 안에서 1차 재검증
      // (내용 지문·claims⊆evidence는 map 트랜잭션 안에서 적용 시점 재검증 — 아래 ①vr).
      const vr = o.verifierResolution;
      if (vr.patchId !== patchId) return { ok: false, reasonCode: "decision-conflict", error: "해소 레코드 patchId 불일치(낡은 해소로 다른 patch 적용 금지)" };
      if (vr.opHash !== PM.opHashOf(rec.patch)) return { ok: false, reasonCode: "decision-conflict", error: "해소 레코드 opHash 불일치" };
      if (vr.baseDecisionContextHash !== rec.patch.baseDecisionContextHash) return { ok: false, reasonCode: "decision-conflict", error: "해소 레코드 baseDecisionContextHash 불일치" };
      if (vr.verdict !== "support") return { ok: false, reasonCode: "decision-conflict", error: "해소 verdict=" + String(vr.verdict) + " — support만 적용 가능(reject=폐기·inconclusive=잔류는 호출자 소관)" };
      if (!Array.isArray(vr.claims) || vr.claims.length === 0) return { ok: false, reasonCode: "decision-conflict", error: "해소 claims 부재(1-5 — 내용 결속 없는 판정은 증거가 아니다)" };
      const evRefs = new Set((rec.patch.evidence || []).map((e) => e.ref));
      // 구현검증 1차 blocker①(ab-3): claim은 typed 계약 {file, contentHash, locator, stance} 전 필드 강제 —
      // 필드 누락·이형이 canonical 지문에 실려 '유효한 verifier 판정'으로 확정되는 경로 차단.
      const fpRe = /^[0-9a-f]{40}$/;
      for (const c of vr.claims) {
        if (!c || typeof c !== "object") return { ok: false, reasonCode: "decision-conflict", error: "해소 claim 이형(객체 아님)" };
        if (typeof c.file !== "string" || !c.file) return { ok: false, reasonCode: "decision-conflict", error: "해소 claim file 누락" };
        if (typeof c.contentHash !== "string" || !fpRe.test(c.contentHash)) return { ok: false, reasonCode: "decision-conflict", error: "해소 claim contentHash 이형(sha1 필요)" };
        if (typeof c.locator !== "string" || !c.locator.trim()) return { ok: false, reasonCode: "decision-conflict", error: "해소 claim locator 누락(1-5 — 위치 없는 인용은 결속이 아니다)" };
        if (c.stance !== "support" && c.stance !== "rebut") return { ok: false, reasonCode: "decision-conflict", error: "해소 claim stance 이형(support|rebut)" };
        if (!evRefs.has(c.file)) return { ok: false, reasonCode: "decision-conflict", error: "해소 claim이 patch.evidence 밖 파일 인용(" + c.file + ") — 사전 결속 위반(재제안+재해소 필요)" };
      }
      if (!vr.claims.some((c) => c.stance === "support")) return { ok: false, reasonCode: "decision-conflict", error: "verdict=support인데 지지 claim 0(전부 반박 — 모순 해소 레코드 거부)" };
    } else if (rec.classification !== "auto") {
      // 분류 해소 증거 강제(§A): P2 실경로는 auto+verifier-resolved(P8 해소 레코드 동봉 시)만. intent는 P9.
      return { ok: false, reasonCode: "not-classified", error: "classification=" + String(rec.classification) + " — 해소 증거 없이 적용 불가(§A. classify 선행 필요 여부 확인)" };
    }
    const claimed = { ...rec, lifecycle: "claimed", claim: { pid: process.pid, token: crypto.randomBytes(8).toString("hex"), claimedAt: new Date().toISOString(), decisionId } };
    if (!CL.atomicWrite(f, JSON.stringify(claimed, null, 1))) return { ok: false, reasonCode: "write-failed", error: "claim 기록 실패" };
    return { ok: true, rec: claimed };
  });
  if (!claim.ok) return { ok: false, reasonCode: "lock", error: claim.error };
  if (!claim.result.ok) return { ok: false, ...(claim.result.reasonCode ? { reasonCode: claim.result.reasonCode } : {}), error: claim.result.error, supplemented: claim.result.supplemented };
  const pending = claim.result.rec;
  const decisionId = pending.claim.decisionId;
  const patch = pending.patch;

  const rollbackClaim = () => { withNsLock(repo, mapId, () => { const f = pendingFileFor(repo, mapId, patchId); const pr = readJson3(f); if (pr.st === "ok" && pr.data.claim && pr.data.claim.decisionId === decisionId && pr.data.claim.pid === process.pid && pr.data.claim.token === pending.claim.token) { const back = { ...pr.data, lifecycle: "classified" }; delete back.claim; CL.atomicWrite(f, JSON.stringify(back, null, 1)); } }); };

  // §B ② withMapLock 트랜잭션(§F-1/F-2)
  const tx = MR.withMapLock(repo, () => {
    // ⓪ 공통 barrier 재검사(mapLock 안 — 7차 #2·9차 보완①)
    // P3b C-4(구현검증 1차 #1): 권위 상태도 잠금 안 재판정 — 판정~잠금 사이 cutover 전이(어느 방향이든)=중단.
    // blocked=중단(receipt-only 위 topology 변경 금지). 초기 판정과 상이=중단(재실행 시 새 판정으로 진행).
    {
      const authIn = (() => { try { return require(path.join(__dirname, "map-bindings.js")).authorityStateFor(repo); } catch { return null; } })();
      if (authIn === null) return { fail: "권위 판독 불가(잠금 안 재판정) — fail-closed 중단", reasonCode: "authority-blocked" };
      if (authIn.st === "blocked") return { fail: "권위 상태 blocked(잠금 안 재판정 — " + (authIn.reasonKey || "") + ") — 중단. 전환 중단 상태면 cutover 재실행으로 재개하라", reasonCode: "authority-blocked" };
      if ((authIn.st === "v2") !== !!o._authV2) return { fail: "권위 상태가 판정~잠금 사이 변경됨(" + (o._authV2 ? "v2→legacy" : "legacy→v2") + " — cutover 전이) — 재실행하라" };
    }
    const aw2 = activePipelineWalFor(repo);
    if (aw2.st === "unreadable") return { fail: "WAL 서랍 판독 불가", reasonCode: "wal-corrupt" };
    if (aw2.st === "active") return { fail: "활성 WAL 존재(경쟁) — recoverWal 선행", reasonCode: "wal-active" };
    const rt = MR.readTopoExFor(repo);
    if (rt.st !== "ok") return { fail: "topology 판독 실패(" + rt.st + ")" };
    const topo = rt.topo;
    if (topo.mapId !== mapId) return { fail: "mapId 불일치(세대 이탈)" };
    const idx = decisionIndexFor(repo, mapId);
    if (idx.st === "error") return { fail: idx.error };
    const pol = policyStateFor(repo, mapId);
    if (pol.st !== "ok") return { fail: pol.error };
    const ctx = { idx, pol, git: gitInfo(repo), repoRoot: repo, fileHashOf: (ref) => fileSha(path.isAbsolute(ref) ? ref : path.join(repo, ref)) };
    // ① CAS
    let cas = casCheck(repo, patch, topo, ctx, pending.localOrigin);
    if (cas.disposition === "hard-reject") return { fail: "CAS hard-reject: " + cas.reason, terminal: "expired", reasonCode: "hard-reject", expireCode: "hard-reject" };
    if (cas.disposition === "stale-expired") return { fail: "read-set 파손(" + cas.broken.join(",") + ") — stale-expired", terminal: "expired", reasonCode: "cas-stale", expireCode: "cas-stale" };
    const vrIn = pending.classification === "verifier-resolved" && o.verifierResolution ? o.verifierResolution : null;
    let livePatch = patch;
    if (cas.disposition === "rebase") { // 재기반(12차 #3): base 3해시·basis를 현재로 갱신한 사본으로 진행 — decision·WAL에 신선 기준 기록
      // P8(설계 v10 P8-4): verifier 해소 경로는 CAS rebase 전면 금지 — 검증받지 않은 rebased patch가
      // verifier-resolved로 기록되는 경로 차단(base 불일치=거부·재제안+재해소 요구). terminal 아님(expire는
      // 호출자의 rev 전진 규약 소관 — P2가 임의 종결하지 않는다).
      if (vrIn) return { fail: "verifier 해소 경로 rebase 금지 — base 불일치(재제안+재해소 필요)", reasonCode: "cas-stale" };
      livePatch = { ...patch, basis: patchBasisFor(repo, topo), baseMapHash: cas.current.mapHash, baseAuthorityHash: cas.current.ah, baseDecisionContextHash: cas.current.dch };
      const ve2 = PM.validatePatchV2(livePatch);
      if (ve2.length) return { fail: "재기반 사본 검증 실패: " + ve2[0] };
    }
    // ①vr(P8 — 적용 시점 claim 지문 재검증·설계 3~5차 ab-3): 해소 후 근거 파일이 바뀐 상태에서 이전 판정이
    // 결속되는 경로를 map 잠금 안 현재 지문 대조로 차단. claims⊆evidence는 claim 단계에서 검증 완료.
    if (vrIn) {
      for (const c of vrIn.claims || []) {
        const now9 = ctx.fileHashOf(c.file);
        if (!now9 || now9 !== c.contentHash) return { fail: "해소 claim 지문 불일치(" + c.file + ") — 근거가 바뀜(재해소 필요)", reasonCode: "decision-conflict" };
      }
    }
    // ② ②b(frontier 주입)
    const verdict = PM.semanticValidateV2(topo, livePatch, { frontier: pol.frontier, policyIds: new Set((pol.policies || []).map((x) => x.rec.policyId)), artifactIds: new Set([...(pol.policies || []).map((x) => x.rec.policyId), ...(pol.revocations || []).map((x) => x.rec.revocationId)]), revokedPolicyIds: new Set((pol.revocations || []).map((x) => x.rec.targetPolicyId)) });
    if (verdict.disposition !== "ok") return { fail: "②b " + verdict.disposition + ": " + verdict.errors[0], terminal: verdict.disposition === "hard-reject" ? "expired" : null, reasonCode: verdict.disposition === "hard-reject" ? "hard-reject" : "semantic-reject", ...(verdict.disposition === "hard-reject" ? { expireCode: "hard-reject" } : {}) };
    // ③ 선계산 일괄(§F ③)
    const isPolicy = PM.isPolicyOpV2(livePatch.operation);
    const mapHashBefore = PM.mapHashOf(topo);
    const mapMdBefore = fileSha(path.join(repo, "project-map", "MAP.md"));
    let outTopo = topo, mapHashAfter = mapHashBefore, mapMdText = null, mapMdAfterHash = mapMdBefore, apChangedIds = [];
    if (!isPolicy) {
      const ap = PM.applyOperationV2(topo, livePatch);
      if (ap.errors.length) return { fail: "적용기: " + ap.errors[0] };
      const ve = PM.validateTopology(ap.topo);
      if (ve.length) return { fail: "출력 topology 스키마 위반: " + ve[0] };
      outTopo = ap.topo;
      apChangedIds = ap.changedIds || []; // P4: 생존 changedIds — provenance 주입·affectedIds의 재료
      mapHashAfter = PM.mapHashOf(outTopo);
      mapMdText = PM.renderMapMd(outTopo);
      mapMdAfterHash = sha1(mapMdText);
    }
    const prospective = idx.st === "ok" ? [...idx.projections] : [];
    // P4(설계 v8): historyless basisFp=structuralHashOf(provenance 제외 — 자기참조 해소·주입 전후 동일값).
    const verification = ctx.git ? { kind: "git", objectFormat: ctx.git.oidFormat, head: ctx.git.head } : { kind: "historyless", basisFp: PM.structuralHashOf(outTopo), inventoryFp: PM.opHashOf(outTopo.inventory) };
    // P4 provenance 주입(설계 v8 순서 ①): 생존 changedIds entity에 {basis, decisionId} — 주입 '후' 재검증·해시.
    let affectedIds = null;
    if (!isPolicy) {
      // 1차 blocker①: affectedIds='생존' changedIds만 — split/merge의 삭제 entity ID를 제외(outTopo 실존 교집합).
      const surviving = new Set([...(outTopo.nodes || []).map((x) => x && x.id), ...(outTopo.edges || []).map((x) => x && x.id)]);
      affectedIds = [...new Set(apChangedIds)].filter((id) => surviving.has(id)).sort();
      for (const cid of affectedIds) {
        const ent = (outTopo.nodes || []).find((x) => x && x.id === cid) || (outTopo.edges || []).find((x) => x && x.id === cid);
        if (ent) ent.provenance = { basis: verification, decisionId };
      }
      const ve3 = PM.validateTopology(outTopo);
      if (ve3.length) return { fail: "provenance 주입 후 topology 스키마 위반: " + ve3[0] };
      mapHashAfter = PM.mapHashOf(outTopo);
      mapMdText = PM.renderMapMd(outTopo);
      mapMdAfterHash = sha1(mapMdText);
    }
    const evidenceFps = (livePatch.evidence || []).map((e) => ({ ref: e.ref, contentHash: ctx.fileHashOf(e.ref) || sha1("__missing__" + e.ref) })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
    // 정책 산출물 선계산(F-2·F-1 정책 동반은 P2 미지원 — 정책은 전용 트랜잭션)
    let policyArtifact = null, pfhAfter, dchAfter;
    if (isPolicy) {
      const pl = livePatch.payload;
      if (patch.operation === "revoke_intent_policy") {
        const rec2 = pl.revocation;
        policyArtifact = { kind: "policy-revocation", revocationId: rec2.revocationId, targetPolicyId: rec2.targetPolicyId, copy: rec2, expectedFileHash: sha1(JSON.stringify(rec2, null, 1)) };
        pfhAfter = PM.policyFrontierHashOf(pol.policies.map((x) => x.rec), [...pol.revocations.map((x) => x.rec), rec2]);
      } else {
        const rec2 = pl.policy;
        policyArtifact = { kind: "intent-policy", policyId: rec2.policyId, copy: rec2, expectedFileHash: sha1(JSON.stringify(rec2, null, 1)), supersedesPolicyIds: rec2.supersedesPolicyIds || [] };
        pfhAfter = PM.policyFrontierHashOf([...pol.policies.map((x) => x.rec), rec2], pol.revocations.map((x) => x.rec));
      }
    } else pfhAfter = pol.pfh;
    const decision = {
      schema: "map-decision-v3", decisionId, mapId, patchId: livePatch.patchId, opHash: PM.opHashOf(livePatch), // P4: 신규 기록=v3만
      ...(isPolicy ? {} : { affectedIds }),
      patch: livePatch,
      // P8(설계 v10 P8-4·삼중 결속 — 4차 보완①): verifier 해소 적용은 기존 decision 스키마의 삼중 결속을
      // 실제로 채운다 — validator 규칙(1차 #6)은 verdictFp==actor.resultFp==resolution.evidenceRef '동일 값':
      // 전부 해소 레코드의 canonical 지문 하나(vrFp)로 통일.
      actor: isPolicy ? { kind: "user-choice", cardId: o.resolutionRef } : vrIn ? { kind: "verifier", resultFp: sha1(PM.canonicalJsonOf(vrIn)) } : { kind: "auto" },
      classification: isPolicy ? "intent-choice" : vrIn ? "verifier-resolved" : "auto",
      ...(vrIn ? { verdictFp: sha1(PM.canonicalJsonOf(vrIn)) } : {}),
      resolution: { outcome: "applied", evidenceRef: isPolicy ? o.resolutionRef : vrIn ? sha1(PM.canonicalJsonOf(vrIn)) : "auto" }, ...(o.preCutover ? { preCutover: true } : {}), // P3b C-4: 필드는 --pre-cutover 명시 경로만 기록(v2 무플래그=생략 — validator '부재=cutover 후' 정합·증명 이력 왜곡 차단)
      verification, evidenceFps,
      audit: { ts: new Date().toISOString(), topologyBeforeHash: mapHashBefore, topologyAfterHash: mapHashAfter, mapMdAfterHash: mapMdAfterHash || sha1(""), authorityHashAfter: "", expectedMapHashAfter: mapHashAfter, walRef: "wal/" + decisionId + ".json" },
    };
    const prospIdx = isPolicy ? prospective : [...prospective, PM.adpOf(decision)];
    const dihAfter = PM.decisionIndexHashOf(prospIdx.map(PM.adpHashOf));
    const ahAfter = PM.authorityHashOf(mapHashAfter, dihAfter);
    decision.audit.authorityHashAfter = ahAfter;
    dchAfter = PM.decisionContextHashOf(ahAfter, pfhAfter);
    const decisionText = JSON.stringify(decision, null, 1);
    const decisionFileHash = sha1(decisionText);
    const marker = { decisionId, decisionFileAfterHash: decisionFileHash, policyArtifact: policyArtifact ? { kind: policyArtifact.kind, id: policyArtifact.kind === "intent-policy" ? policyArtifact.policyId : policyArtifact.revocationId, fileAfterHash: policyArtifact.expectedFileHash } : null };
    // ④ 스냅샷(topology op만 — C-6)
    let snapshotRef = null;
    if (!isPolicy) {
      const snapText = JSON.stringify({ mapId, decisionId, topologyBeforeHash: mapHashBefore, basis: livePatch.basis, appliedCountAtSnapshot: prospective.length, topology: JSON.parse(rt.raw ? rt.raw : JSON.stringify(topo)) }, null, 1); // basis=재기반 후(14차 #9)
      const snapFile = path.join(d.snapshots, decisionId + ".json");
      if (!CL.atomicWrite(snapFile, snapText)) return { fail: "스냅샷 기록 실패", reasonCode: "write-failed" };
      snapshotRef = { path: snapFile, contentHash: sha1(snapText) };
    }
    // ⑤ WAL(합타입 — C-4)
    const wal = {
      schema: "map-wal-v2", transactionKind: isPolicy ? "policy" : "topology", localOrigin: pending.localOrigin,
      patch: livePatch, patchId: livePatch.patchId, opHash: decision.opHash, basis: livePatch.basis, readSet: livePatch.readSet,
      inverse: { kind: "recovery", ref: snapshotRef ? snapshotRef.path : "(policy — frontier 기록)", note: "P2 inverse 재료" },
      decision, expectedDecisionFileAfterHash: decisionFileHash,
      baselineDecisionIndexHash: PM.decisionIndexHashOf(prospective.map(PM.adpHashOf)),
      expectedDecisionIndexHashAfter: dihAfter, expectedAuthorityHashAfter: ahAfter,
      expectedMarker: marker,
      ...(isPolicy
        ? { topologyHashInvariant: mapHashBefore, mapMdHashInvariant: mapMdBefore || sha1(""), policyArtifact, baselinePolicyFrontierHash: pol.pfh, expectedPolicyFrontierHashAfter: pfhAfter, expectedDecisionContextHashAfter: dchAfter }
        : { topologyBeforeHash: mapHashBefore, mapMdBeforeHash: mapMdBefore || sha1(""), snapshotRef, expectedTopologyAfterHash: mapHashAfter, expectedMapMdAfterHash: mapMdAfterHash }),
    };
    if (fs.existsSync(path.join(repo, "project-map", "decisions", decisionId + ".json"))) return { fail: "decisionId 충돌(경쟁 — 클레임 후 생성됨)" }; // 정책 createdFromDecision 재확인(12차 #5)
    { const dv = PM.validateDecisionAny(decision); if (dv.length) return { fail: "decision 최종 검증 실패: " + dv[0] }; } // P4: v3 기록 // durable 전 최종 검증(12차 #6)
    const walFile = path.join(d.wal, decisionId + ".json");
    if (!CL.atomicWrite(walFile, JSON.stringify(wal, null, 1))) {
      if (snapshotRef) { try { fs.unlinkSync(snapshotRef.path); } catch { /* gc 승계 */ } } // orphan 즉시 삭제(12차 #6)
      return { fail: "WAL 기록 실패", reasonCode: "write-failed" };
    }
    // ⑥~⑪ 산출물 기록(중단=recoverWal 소관). P8 보완: 직접 쓰기 예외를 구조화 실패로 변환(write-failed·
    // 활성 WAL 유지=recoverWal 소관 — 예외 이탈로 닫힌 반환 계약이 깨지지 않게).
    try {
    const decDir = path.join(repo, "project-map", "decisions");
    fs.mkdirSync(decDir, { recursive: true });
    if (!isPolicy) {
      const topoText = PM.canonicalSerialize(outTopo);
      const tmp = path.join(repo, "project-map", "topology.json." + process.pid + ".tmp");
      fs.writeFileSync(tmp, topoText, "utf8"); fs.renameSync(tmp, path.join(repo, "project-map", "topology.json")); // ⑥
      const tmp2 = path.join(repo, "project-map", "MAP.md." + process.pid + ".tmp");
      fs.writeFileSync(tmp2, mapMdText, "utf8"); fs.renameSync(tmp2, path.join(repo, "project-map", "MAP.md")); // ⑦
    }
    { const t3 = path.join(decDir, decisionId + ".json." + process.pid + ".tmp"); fs.writeFileSync(t3, decisionText, "utf8"); fs.renameSync(t3, path.join(decDir, decisionId + ".json")); } // ⑧(원자 — 12차 #6)
    if (isPolicy) { // ⑨
      const polDir = path.join(repo, "project-map", "policies");
      fs.mkdirSync(polDir, { recursive: true });
      const fname = policyArtifact.kind === "intent-policy" ? policyArtifact.policyId + ".json" : policyArtifact.revocationId + ".revoke.json";
      { const t4 = path.join(polDir, fname + "." + process.pid + ".tmp"); fs.writeFileSync(t4, JSON.stringify(policyArtifact.copy, null, 1), "utf8"); fs.renameSync(t4, path.join(polDir, fname)); }
    }
    if (!CL.atomicWrite(path.join(d.markers, decisionId + ".json"), JSON.stringify(marker, null, 1))) return { fail: "marker 기록 실패 — 활성 WAL 유지(recoverWal이 보충. 산출물은 기록됨 — 성공 위장 금지: 13차 #3)", keepClaim: true, reasonCode: "write-failed" }; // ⑩
    fs.renameSync(walFile, path.join(d.walComplete, decisionId + ".json")); // ⑪
    } catch (e9) { return { fail: "산출물 기록 실패(" + String(e9 && e9.message).slice(0, 80) + ") — 활성 WAL 유지(recoverWal 소관)", keepClaim: true, reasonCode: "write-failed" }; }
    // P4-3ⓐ 기준선 기록(2차 blocker② 봉합): 정본 잠금 '안'(트랜잭션 완결 후)에서 기록 — apply가 정본 잠금으로
    // 직렬화되므로 완료 순서 역전(늦은 과거 쓰기가 최신을 덮음)이 원천 차단된다. 전용 잠금은 reader 캐시(e:)
    // 경합용으로 여전히 사용(map→freshness 단방향 중첩 — 역방향 없음·교착 불가). 실패=apply 성공 불변(축 unknown 유지).
    let freshnessBaseline;
    if (!isPolicy) {
      const up = baselineUpdatesFor(livePatch, decisionId, affectedIds, outTopo);
      // up이 비어도 호출: 상시 자가 수리(저장소 vs provenance 차이)가 이번 topology 전이에서 수행된다(구조 교체 —
      // 재수집 원본은 GC 비대상 영구 정본 decisions/·수리 승인은 이번 apply가 권위 계산에 쓴 색인 스냅샷과
      // ADP 지문 결속: 5차 blocker③).
      const idxByDec = {};
      for (const pr9 of prospIdx) idxByDec[pr9.decisionId] = PM.adpHashOf(pr9);
      try { freshnessBaseline = MF.recordBaselines(repo, mapId, up, { topo: outTopo, decisionsDir: path.join(repo, "project-map", "decisions"), indexByDecision: idxByDec }); }
      catch (e) { freshnessBaseline = { ok: false, wrote: 0, skipped: 0, stale: 0, reason: "exception: " + String(e && e.message).slice(0, 60) }; }
    }
    return { done: true, decisionId, mapHashAfter, authorityHashAfter: ahAfter, freshnessBaseline };
  });
  if (!tx.ok) { rollbackClaim(); return { ok: false, reasonCode: "lock", error: "정본 잠금 실패: " + (tx.error || "") }; }
  const r = tx.result;
  if (r.fail) {
    if (r.keepClaim) return { ok: false, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}), error: r.fail }; // 활성 WAL 유지 — claim 롤백도 하지 않음(recoverWal 소관)
    // P8: terminal 종결은 expireCode를 같은 원자 쓰기에 동봉(반환 코드 유실 대비 — 재시작 복구는 이 코드로만
    // 분기). 구현검증 1차 blocker②: 영속 실패(잠금 점유·쓰기 실패)를 무시하면 pending이 claimed로 잔존한 채
    // 호출자만 terminal을 받는다 — 실패 시 claim 롤백(classified 복원)+정직 병기: 소비자가 반환 코드로 rev
    // 전진해도 expire CAS 대상(proposed|classified)이라 규약 정합·재시도도 가능.
    if (r.terminal === "expired") {
      const tw = persistTerminalExpire(repo, mapId, patchId, r.fail, r.expireCode || null, pending.claim.token);
      if (!tw.wrote) return { ok: false, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}), error: r.fail + " (terminal 기록 실패: " + (tw.error || "") + (tw.rolledBack ? " — claim 롤백됨[classified 복원·rev 전진 CAS 대상]" : " — claim 잔존 가능[gc·claim 사망 판정 소관]") + " · expireCode 미영속)", terminalPersisted: false, claimRolledBack: !!tw.rolledBack };
    }
    else rollbackClaim();
    return { ok: false, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}), error: r.fail };
  }
  // §B ③ 종결(nsLock — 결과 검사: 17차 #3. durable은 완료됐으므로 실패=finalizePending 미종결로 정직 보고,
  // 재시도는 claimed 분기의 완료 영수증 판정이 보충 종결한다)
  const fin = withNsLock(repo, mapId, () => { const f = pendingFileFor(repo, mapId, patchId); const pr = readJson3(f); if (pr.st !== "ok") return false; return CL.atomicWrite(f, JSON.stringify({ ...pr.data, lifecycle: "resolved", resolvedAt: new Date().toISOString() }, null, 1)); });
  const finalized = fin.ok && fin.result === true;
  return { ok: true, decisionId: r.decisionId, mapHashAfter: r.mapHashAfter, authorityHashAfter: r.authorityHashAfter, ...(r.freshnessBaseline ? { freshnessBaseline: r.freshnessBaseline } : {}), ...(finalized ? {} : { finalizePending: true, warn: "적용은 완결·pending 종결만 실패 — apply 재호출이 영수증으로 보충 종결" }) };
}

// ── recoverWal(§G — 전진만·표) ─────────────────────────────────────────────────
// WAL 합타입 공용 검증(16차 #1·#3 — 복구·abort가 같은 신뢰 경계 사용. 예외=오류 문자열로 변환).
function validateWalV2(w, fname) {
  try {
    if (!w || w.schema !== "map-wal-v2" || !w.decision || !w.expectedDecisionFileAfterHash || !w.expectedMarker) return "필수 필드 누락";
    if (w.transactionKind !== "topology" && w.transactionKind !== "policy") return "transactionKind 합타입 위반";
    if (!w.patch || PM.validatePatchV2(w.patch).length) return "patch 사본 위반";
    if ((w.transactionKind === "policy") !== PM.isPolicyOpV2(w.patch.operation)) return "transactionKind↔operation 불일치(17차 #1 — 양방향 동치)";
    { const lo = w.localOrigin; // 합타입 내용 검증(18차 #4)
      const loOk = lo && typeof lo === "object" && ((lo.kind === "git" && typeof lo.worktreeReal === "string" && lo.worktreeReal && typeof lo.gitCommonReal === "string") || (lo.kind === "historyless" && typeof lo.rootReal === "string" && lo.rootReal));
      if (!loOk) return "localOrigin 합타입 위반(C-4)"; }
    { const iv = w.inverse;
      // P2 WAL 스키마는 recovery inverse만 승인(20차 #1): 이 파이프라인의 생산자(applyPatch)는 recovery만
      // 기록한다 — patch inverse를 '허용 키 검사'로 열어두면 실행 불가 payload가 자기완결 WAL로 승인되는
      // 통로가 된다. patch inverse는 미래 생산자가 op별 validator·forward→inverse 허용표와 함께 도입(C-4).
      const ivOk = iv && typeof iv === "object" && iv.kind === "recovery" && typeof iv.ref === "string" && !!iv.ref && typeof iv.note === "string";
      if (!ivOk) return "inverse 합타입 위반(P2=recovery{ref,note}만 — patch inverse는 생산자·validator 동반 도입 전 불허·20차 #1)"; }

    if (PM.validatePatchBasis(w.basis).length) return "basis 위반";
    if (fname !== undefined && fname !== String(w.decision.decisionId) + ".json") return "파일명≠decisionId";
    if (PM.validateDecisionAny(w.decision).length) return "decision 사본 위반"; // P4 dual
    if (w.transactionKind === "topology") {
      if (w.policyArtifact !== undefined && w.policyArtifact !== null) return "topology WAL에 policyArtifact 금지(16차 #1)";
      if (!/^[0-9a-f]{40}$/.test(String(w.topologyBeforeHash)) || !/^[0-9a-f]{40}$/.test(String(w.expectedTopologyAfterHash)) || !/^[0-9a-f]{40}$/.test(String(w.expectedMapMdAfterHash))) return "topology WAL 지문 위반";
      if (!(w.snapshotRef && typeof w.snapshotRef.path === "string" && /^[0-9a-f]{40}$/.test(String(w.snapshotRef.contentHash)))) return "snapshotRef 합타입 위반";
      if (!/^[0-9a-f]{40}$/.test(String(w.mapMdBeforeHash))) return "mapMdBeforeHash 위반";
    } else {
      if (!/^[0-9a-f]{40}$/.test(String(w.topologyHashInvariant)) || !/^[0-9a-f]{40}$/.test(String(w.mapMdHashInvariant))) return "policy WAL invariant 위반";
      if (!w.policyArtifact || typeof w.policyArtifact !== "object") return "policy WAL policyArtifact 필수";
      if (w.snapshotRef !== undefined) return "policy WAL에 snapshotRef 금지(C-4 — 17차 #1)";
      if (!/^[0-9a-f]{40}$/.test(String(w.baselinePolicyFrontierHash)) || !/^[0-9a-f]{40}$/.test(String(w.expectedPolicyFrontierHashAfter)) || !/^[0-9a-f]{40}$/.test(String(w.expectedDecisionContextHashAfter))) return "policy WAL frontier/context 해시 필수(C-4)";
      if (PM.decisionContextHashOf(w.expectedAuthorityHashAfter, w.expectedPolicyFrontierHashAfter) !== w.expectedDecisionContextHashAfter) return "expectedDecisionContextHashAfter 재계산 불일치(DAG 결속 — 17차 #2)";
    }
    // 해시 DAG·audit 결속(17차 #2): top-level expected와 decision audit의 동일성+권위 해시 재계산
    const au = w.decision.audit || {};
    if (w.transactionKind === "topology") {
      if (w.topologyBeforeHash !== au.topologyBeforeHash) return "topologyBeforeHash≠audit(결속 위반)";
      if (w.expectedTopologyAfterHash !== au.topologyAfterHash || au.topologyAfterHash !== au.expectedMapHashAfter) return "expectedTopologyAfterHash≠audit(결속 위반)";
      if (w.expectedMapMdAfterHash !== au.mapMdAfterHash) return "expectedMapMdAfterHash≠audit(결속 위반)";
      if (PM.authorityHashOf(w.expectedTopologyAfterHash, w.expectedDecisionIndexHashAfter) !== w.expectedAuthorityHashAfter) return "expectedAuthorityHashAfter 재계산 불일치(DAG)";
    } else {
      if (w.topologyHashInvariant !== au.topologyBeforeHash || au.topologyBeforeHash !== au.topologyAfterHash) return "policy invariant≠audit(결속 위반)";
      if (w.mapMdHashInvariant !== au.mapMdAfterHash) return "policy mapMdHashInvariant≠audit(결속 위반 — 18차 #3)";
      if (w.expectedDecisionIndexHashAfter !== w.baselineDecisionIndexHash) return "정책 WAL의 DIH 변경(정책은 구조 권위 밖 — 색인 불변이어야: 18차 #3)";
      if (PM.authorityHashOf(w.topologyHashInvariant, w.expectedDecisionIndexHashAfter) !== w.expectedAuthorityHashAfter) return "policy expectedAuthorityHashAfter 재계산 불일치";
    }
    if (w.expectedAuthorityHashAfter !== au.authorityHashAfter) return "expectedAuthorityHashAfter≠audit(결속 위반)";
    if (!/^[0-9a-f]{40}$/.test(String(w.baselineDecisionIndexHash)) || !/^[0-9a-f]{40}$/.test(String(w.expectedDecisionIndexHashAfter)) || !/^[0-9a-f]{40}$/.test(String(w.expectedAuthorityHashAfter))) return "색인 지문 위반";
    if (w.policyArtifact) {
      const pa = w.policyArtifact;
      if (pa.kind !== "intent-policy" && pa.kind !== "policy-revocation") return "policyArtifact kind 위반";
      const wantId = pa.kind === "intent-policy" ? pa.policyId : pa.revocationId;
      if (!UUID_RE.test(String(wantId))) return "policyArtifact id 위반(경로 주입 차단)";
      if (!pa.copy || typeof pa.copy !== "object" || Array.isArray(pa.copy)) return "policyArtifact copy 스키마 위반(해시 전 선검사 — 16차 #1)";
      const src2 = pa.kind === "intent-policy" ? (w.patch.payload || {}).policy : (w.patch.payload || {}).revocation;
      if (PM.canonicalJsonOf(pa.copy) !== PM.canonicalJsonOf(src2)) return "policyArtifact copy≠patch.payload(결속 위반)";
      if (pa.expectedFileHash !== sha1(JSON.stringify(pa.copy, null, 1))) return "policyArtifact.expectedFileHash 재계산 불일치";
    }
    if (PM.canonicalJsonOf(w.patch) !== PM.canonicalJsonOf(w.decision.patch)) return "w.patch≠decision.patch(분리 위조)";
    if (w.patchId !== w.patch.patchId || w.decision.patchId !== w.patch.patchId) return "patchId 삼중 결속 위반";
    if (w.opHash !== PM.opHashOf(w.patch) || w.decision.opHash !== w.opHash) return "opHash 재계산 결속 위반";
    if (PM.canonicalJsonOf(w.basis) !== PM.canonicalJsonOf(w.patch.basis)) return "basis≠patch.basis";
    if (PM.canonicalJsonOf(w.readSet) !== PM.canonicalJsonOf(w.patch.readSet)) return "readSet≠patch.readSet";
    if (w.expectedDecisionFileAfterHash !== sha1(JSON.stringify(w.decision, null, 1))) return "expectedDecisionFileAfterHash 재계산 불일치(거짓 지문)";
    if (w.expectedMarker.decisionId !== w.decision.decisionId || w.expectedMarker.decisionFileAfterHash !== w.expectedDecisionFileAfterHash) return "expectedMarker 결속 위반";
    if (w.policyArtifact) {
      const em = w.expectedMarker.policyArtifact;
      const wantId = w.policyArtifact.kind === "intent-policy" ? w.policyArtifact.policyId : w.policyArtifact.revocationId;
      if (!em || em.kind !== w.policyArtifact.kind || em.id !== wantId || em.fileAfterHash !== w.policyArtifact.expectedFileHash) return "expectedMarker.policyArtifact 결속 위반";
    } else if (w.expectedMarker.policyArtifact !== null) return "비정책 WAL의 marker에 policyArtifact 존재";
    return null;
  } catch (e) { return "WAL 검증 중 예외(" + String(e && e.message).slice(0, 80) + ") — conflict"; }
}
function recoverWal(repo, mapId) {
  const lk = MR.withMapLock(repo, () => recoverWalInLock(repo, mapId));
  if (!lk.ok) return [{ decisionId: "-", verdict: "conflict", reason: "정본 잠금 실패" }];
  return lk.result;
}
function recoverWalInLock(repo, mapId) {
  const d = ensureDirs(repo, mapId);
  const out = [];
  for (const f of listJson(d.wal)) {
    const wf = path.join(d.wal, f);
    const wr = readJson3(wf);
    if (wr.st !== "ok") { out.push({ decisionId: f, verdict: "conflict", reason: "WAL " + wr.st + "(fail-closed)" }); continue; }
    const w = wr.data;
    const walShapeErr = validateWalV2(w, f);
    if (walShapeErr) { out.push({ decisionId: f, verdict: "conflict", reason: "WAL 스키마 위반: " + walShapeErr }); continue; }
    const did = w.decision.decisionId;
    if (f !== did + ".json" || PM.validateDecisionAny(w.decision).length) { out.push({ decisionId: f, verdict: "conflict", reason: "WAL decision 사본 위반(파일명/스키마)" }); continue; } // 경로 주입 차단(12차 #7)
    // 선행 ⓐ hard boundary(항상)
    if (PM.canonicalJsonOf(localOriginFor(repo)) !== PM.canonicalJsonOf(w.localOrigin)) { out.push({ decisionId: did, verdict: "hard-reject", reason: "localOrigin 불일치(cross-worktree 복구 금지)" }); continue; }
    const gi = gitInfo(repo);
    if (w.basis.kind === "git" && gi) { // 상시 hard boundary(13차 #4 — 설계 §G ⓐ)
      if (w.basis.ref.type === "branch" && gi.branch !== w.basis.ref.name) { out.push({ decisionId: did, verdict: "hard-reject", reason: "branch 이탈" }); continue; }
      if (w.basis.ref.type === "detached" && (gi.branch !== null || gi.head !== w.basis.ref.head)) { out.push({ decisionId: did, verdict: "hard-reject", reason: "detached identity 이탈" }); continue; }
      if (gi.head !== w.basis.baseHead && !gi.isAncestor(w.basis.baseHead)) { out.push({ decisionId: did, verdict: "hard-reject", reason: "non-ancestor(reset/rebase)" }); continue; }
    }
    const rt = MR.readTopoExFor(repo);
    if (rt.st !== "ok") { out.push({ decisionId: did, verdict: "conflict", reason: "topology " + rt.st + " — recoverCorruption 안내" }); continue; }
    const T = PM.mapHashOf(rt.topo);
    const M3 = fileSha3(path.join(repo, "project-map", "MAP.md"));
    const decFile = path.join(repo, "project-map", "decisions", did + ".json");
    const D3 = fileSha3(decFile);
    const mkR = readJson3(path.join(d.markers, did + ".json"));
    if (M3.st === "unreadable" || D3.st === "unreadable" || mkR.st === "unreadable" || mkR.st === "invalid") { out.push({ decisionId: did, verdict: "conflict", reason: "산출물 판독 불가/손상(fail-closed — 14차 #3)" }); continue; }
    const M = M3.st === "ok" ? M3.hash : null;
    const D = D3.st === "ok" ? D3.hash : null;
    const K = mkR.st === "ok" ? mkR.data : null;
    const kMatches = K && PM.canonicalJsonOf(K) === PM.canonicalJsonOf(w.expectedMarker); // 전체 합타입 대조(12차 #7)
    const pfFile3 = null; void pfFile3;
    const pol = w.transactionKind === "policy" || w.policyArtifact ? true : false;
    const polFile = w.policyArtifact ? path.join(repo, "project-map", "policies", w.policyArtifact.kind === "intent-policy" ? w.policyArtifact.policyId + ".json" : w.policyArtifact.revocationId + ".revoke.json") : null;
    const Pf3 = polFile ? fileSha3(polFile) : { st: "absent" };
    if (Pf3.st === "unreadable") { out.push({ decisionId: did, verdict: "conflict", reason: "policy 파일 판독 불가(fail-closed)" }); continue; }
    const Pf = Pf3.st === "ok" ? Pf3.hash : null;
    let topoAfterForBaseline = rt.topo; // t5만 재적용 결과로 교체(그 외 표 상태는 디스크가 이미 후상태)
    const finish = (steps) => {
      try { for (const s of steps) s(); } catch (e) { out.push({ decisionId: did, verdict: "conflict", reason: "복구 쓰기 실패: " + (e && e.message) }); return; }
      fs.renameSync(wf, path.join(d.walComplete, did + ".json"));
      out.push({ decisionId: did, verdict: "recovered", reason: "roll-forward 완결" });
      // P4-3ⓐ: 복구=그 decisionId를 생성한 apply 전이의 완결 — v3 topology만 기준선 기록(구 v2=주입 gating과
      // 동일 경계). 정본 잠금 안이라 apply 경로와 같은 직렬화·실패해도 복구 결과 불변(축 unknown 유지).
      if (w.transactionKind === "topology" && w.decision.schema === "map-decision-v3") {
        const up9 = baselineUpdatesFor(w.patch, did, w.decision.affectedIds, topoAfterForBaseline);
        // 수리 결속용 색인: writeD 직후의 검증된 색인(정본 잠금 안 — apply 경로의 스냅샷 결속과 동형).
        const idx9 = decisionIndexFor(repo, mapId);
        const idxByDec9 = {};
        if (idx9.st === "ok") for (const pr9 of idx9.projections) idxByDec9[pr9.decisionId] = PM.adpHashOf(pr9);
        try { MF.recordBaselines(repo, mapId, up9, { topo: topoAfterForBaseline, decisionsDir: path.join(repo, "project-map", "decisions"), ...(idx9.st === "ok" ? { indexByDecision: idxByDec9 } : {}) }); }
        catch { /* 예외여도 누락은 상시 자가 수리가 다음 topology 전이에서 재유도 */ }
      }
    };
    const writeD = () => { fs.mkdirSync(path.dirname(decFile), { recursive: true }); const t7 = decFile + "." + process.pid + ".tmp"; fs.writeFileSync(t7, JSON.stringify(w.decision, null, 1), "utf8"); fs.renameSync(t7, decFile); };
    const writeP = () => { if (w.policyArtifact) { const pd = path.join(repo, "project-map", "policies"); fs.mkdirSync(pd, { recursive: true }); const t8 = polFile + "." + process.pid + ".tmp"; fs.writeFileSync(t8, JSON.stringify(w.policyArtifact.copy, null, 1), "utf8"); fs.renameSync(t8, polFile); } };
    const writeK = () => { if (!CL.atomicWrite(path.join(d.markers, did + ".json"), JSON.stringify(w.expectedMarker, null, 1))) throw new Error("marker 기록 실패"); };
    const writeM = () => { const t2 = path.join(repo, "project-map", "MAP.md." + process.pid + ".tmp"); const txt = PM.renderMapMd(rt.topo); fs.writeFileSync(t2, txt, "utf8"); fs.renameSync(t2, path.join(repo, "project-map", "MAP.md")); };
    if (w.transactionKind === "policy") {
      // 정책 표(p0~p8)
      if (T !== w.topologyHashInvariant) { out.push({ decisionId: did, verdict: "conflict", reason: "p0: topology 불변 조건 위반" }); continue; }
      if (M !== w.mapMdHashInvariant) { out.push({ decisionId: did, verdict: "conflict", reason: "p0: MAP.md 불변 조건 위반" }); continue; }
      if (D && D !== w.expectedDecisionFileAfterHash) { out.push({ decisionId: did, verdict: "conflict", reason: "p1: decision 변조" }); continue; }
      if (Pf && w.policyArtifact && Pf !== w.policyArtifact.expectedFileHash) { out.push({ decisionId: did, verdict: "conflict", reason: "p1: policy 변조" }); continue; }
      if (K && (!D || !Pf)) { out.push({ decisionId: did, verdict: "conflict", reason: "p2: marker 고아" }); continue; }
      if (!D && !Pf && !K) { // p3: frontier read-set 재검사(13차 #2 — 외부 정책 유입 감지)
        const ps3 = policyStateFor(repo, mapId);
        if (ps3.st !== "ok" || ps3.pfh !== w.baselinePolicyFrontierHash) { out.push({ decisionId: did, verdict: "conflict", reason: "p3: frontier가 baseline과 다름(외부 유입) — abort 후 새 prepare" }); continue; }
        finish([writeD, writeP, writeK]); continue;
      }
      if (!D && Pf) { out.push({ decisionId: did, verdict: "conflict", reason: "p4: 순서 위반(D 전 Pf)" }); continue; }
      if (D && !Pf) { // p5: baseline F 확인(12차 #7 — 외부 정책 유입 감지)
        const ps5 = policyStateFor(repo, mapId);
        if (ps5.st !== "ok") { out.push({ decisionId: did, verdict: "conflict", reason: "p5: 정책 상태 판독 실패" }); continue; }
        if (ps5.pfh !== w.baselinePolicyFrontierHash) { out.push({ decisionId: did, verdict: "conflict", reason: "p5: frontier가 baseline과 다름(외부 유입) — read-set 재검사 필요(수동)" }); continue; }
        finish([writeP, writeK]); continue;
      }
      if (D && Pf && !K) { finish([writeK]); continue; } // p7
      if (K && !kMatches) { out.push({ decisionId: did, verdict: "conflict", reason: "p2: marker 불일치(합타입 대조 — 13차 #2)" }); continue; }
      finish([]); continue; // p8 complete — 이동 보충
    }
    // topology 표(t1~t14)
    if (D && D !== w.expectedDecisionFileAfterHash) { out.push({ decisionId: did, verdict: "conflict", reason: "t1: decision 변조" }); continue; }
    if (K && (!kMatches || !D || M !== w.expectedMapMdAfterHash)) { out.push({ decisionId: did, verdict: "conflict", reason: "t3: marker 고아/불일치/선행 파손" }); continue; }
    if (T === w.topologyBeforeHash) {
      if (D || K) { out.push({ decisionId: did, verdict: "conflict", reason: "t4: 적용 전 산출물 존재(변조)" }); continue; }
      { // t5 전진(12차 #7 — §G ⓑ): basis·read-set 보존이면 ⑥부터 roll-forward(적용기 재실행은 결정론)
        const idx5 = decisionIndexFor(repo, mapId);
        const pol5 = policyStateFor(repo, mapId);
        if (idx5.st === "error" || pol5.st !== "ok") { out.push({ decisionId: did, verdict: "conflict", reason: "t5: 상태 판독 실패" }); continue; }
        const ctx5 = { idx: idx5, pol: pol5, git: gitInfo(repo), repoRoot: repo, fileHashOf: (ref) => fileSha(path.isAbsolute(ref) ? ref : path.join(repo, ref)) };
        const cas5 = casCheck(repo, w.patch, rt.topo, ctx5, w.localOrigin);
        if (cas5.disposition === "hard-reject") { out.push({ decisionId: did, verdict: "hard-reject", reason: "t5: " + cas5.reason }); continue; }
        if (cas5.disposition === "stale-expired") { out.push({ decisionId: did, verdict: "stale-expired", reason: "t5: read-set 파손 — abort 권고" }); continue; }
        if (cas5.disposition === "rebase") { out.push({ decisionId: did, verdict: "not-started", reason: "t5: 기반 전진 — WAL expected가 낡음: abort 후 새 prepare" }); continue; }
        const ap5 = PM.applyOperationV2(rt.topo, w.patch);
        // P4: 재적용 결정론 — apply 경로와 동일하게 생존 changedIds에 WAL decision의 {basis, decisionId}를
        // 주입한 뒤 expected와 대조한다. 단 '구 v2 WAL'은 주입 없이 기록된 expected 해시라 주입하면 영구
        // 불일치(1차 blocker② — 업그레이드 직전 중단된 정상 v2 WAL 보존): v3 decision일 때만 주입.
        if (!ap5.errors.length && w.decision && w.decision.schema === "map-decision-v3") {
          for (const cid5 of [...new Set(ap5.changedIds || [])]) {
            const ent5 = (ap5.topo.nodes || []).find((x) => x && x.id === cid5) || (ap5.topo.edges || []).find((x) => x && x.id === cid5);
            if (ent5) ent5.provenance = { basis: w.decision.verification, decisionId: did };
          }
        }
        if (ap5.errors.length || PM.mapHashOf(ap5.topo) !== w.expectedTopologyAfterHash) { out.push({ decisionId: did, verdict: "conflict", reason: "t5: 재적용 결과가 expected와 불일치" }); continue; }
        topoAfterForBaseline = ap5.topo; // P4-3ⓐ: t5의 후상태
        const topoText5 = PM.canonicalSerialize(ap5.topo);
        const tmp5 = path.join(repo, "project-map", "topology.json." + process.pid + ".tmp");
        fs.writeFileSync(tmp5, topoText5, "utf8"); fs.renameSync(tmp5, path.join(repo, "project-map", "topology.json"));
        const md5 = PM.renderMapMd(ap5.topo);
        const tmp6 = path.join(repo, "project-map", "MAP.md." + process.pid + ".tmp");
        fs.writeFileSync(tmp6, md5, "utf8"); fs.renameSync(tmp6, path.join(repo, "project-map", "MAP.md"));
        finish([writeD, writeP, writeK]); continue;
      }
    }
    if (T !== w.expectedTopologyAfterHash) { out.push({ decisionId: did, verdict: "conflict", reason: "t14: 기반 이탈 — recoverCorruption 안내" }); continue; }
    { // t6 선행(14차 #1 — T=after 전체·D 유무 무관): 현재 유효 색인의 '이번 제외분'=baseline 필수
      const idx6 = decisionIndexFor(repo, mapId);
      if (idx6.st === "error") { out.push({ decisionId: did, verdict: "conflict", reason: "t6: 색인 판독 실패" }); continue; }
      const curDih = PM.decisionIndexHashOf((idx6.st === "ok" ? idx6.projections : []).filter((x) => x.decisionId !== did).map(PM.adpHashOf));
      if (curDih !== w.baselineDecisionIndexHash) { out.push({ decisionId: did, verdict: "conflict", reason: "t6: 색인 외부 개입(baseline 불일치 — 권위 오염 차단)" }); continue; }
    }
    if (!D) {
      if (M === w.expectedMapMdAfterHash) { finish([writeD, writeK]); continue; } // t8 ①
      if (M === w.mapMdBeforeHash || M === null) { finish([writeM, writeD, writeK]); continue; } // t7 ⓪
      out.push({ decisionId: did, verdict: "conflict", reason: "t7x: 중단 사이 MAP 수동 편집(혼합)" }); continue;
    }
    if (M !== w.expectedMapMdAfterHash) { out.push({ decisionId: did, verdict: "conflict", reason: "t9: D 이후 MAP 혼합" }); continue; }
    if (!K) { finish([writeK]); continue; } // t12 ②
    finish([]); continue; // t13 complete 이동 보충
  }
  return out;
}
function abortWal(repo, mapId, decisionId) {
  const lk = MR.withMapLock(repo, () => abortWalInLock(repo, mapId, decisionId));
  if (!lk.ok) return { ok: false, error: "정본 잠금 실패" };
  return lk.result;
}
function abortWalInLock(repo, mapId, decisionId) {
  const d = ensureDirs(repo, mapId);
  const wf = path.join(d.wal, decisionId + ".json");
  const wr = readJson3(wf);
  if (wr.st !== "ok") return { ok: false, error: "활성 WAL 없음/판독 불가(" + wr.st + ")" };
  const w = wr.data;
  { const we = validateWalV2(w, decisionId + ".json"); if (we) return { ok: false, error: "WAL 위반(" + we + ") — abort 불가(복구·abort 동일 신뢰 경계: 16차 #3)" }; }
  const rt = MR.readTopoExFor(repo);
  const T = rt.st === "ok" ? PM.mapHashOf(rt.topo) : null;
  if (T === null) return { ok: false, error: "topology 판독 불가 — abort 불가(fail-closed)" };
  // 3분기 판독(15차 #3): invalid/unreadable=무조건 거부(ENOENT만 부재 인정)
  const D3 = fileSha3(path.join(repo, "project-map", "decisions", decisionId + ".json"));
  const Pf3 = w.policyArtifact ? fileSha3(path.join(repo, "project-map", "policies", w.policyArtifact.kind === "intent-policy" ? w.policyArtifact.policyId + ".json" : w.policyArtifact.revocationId + ".revoke.json")) : { st: "absent" };
  const M3 = fileSha3(path.join(repo, "project-map", "MAP.md"));
  const mk3 = readJson3(path.join(d.markers, decisionId + ".json"));
  if (D3.st === "unreadable" || Pf3.st === "unreadable" || M3.st === "unreadable" || mk3.st === "unreadable" || mk3.st === "invalid") return { ok: false, error: "산출물 판독 불가/손상 — abort 거부(fail-closed·15차 #3)" };
  const Mab = M3.st === "ok" ? M3.hash : null;
  const preM = w.transactionKind === "policy" ? (Mab === w.mapMdHashInvariant) : (Mab === w.mapMdBeforeHash || Mab === null);
  const idxAb = decisionIndexFor(repo, mapId);
  const dihAb = PM.decisionIndexHashOf((idxAb.st === "ok" ? idxAb.projections : []).filter((x) => x.decisionId !== decisionId).map(PM.adpHashOf));
  const pre = (w.transactionKind === "policy" ? (T === w.topologyHashInvariant) : (T === w.topologyBeforeHash)) && preM && idxAb.st !== "error" && dihAb === w.baselineDecisionIndexHash;
  if (!pre || D3.st !== "absent" || Pf3.st !== "absent" || mk3.st !== "absent") return { ok: false, error: "abort 불가 — pre-apply 상태가 아니거나 산출물 존재(§F 조건)" };
  fs.renameSync(wf, path.join(d.walAborted, decisionId + ".json"));
  return { ok: true };
}

// ── recoverCorruption(1-18 — 별도 파일·원본 보존) ─────────────────────────────────
function recoverCorruption(repo, mapId) {
  const rt = MR.readTopoExFor(repo);
  if (rt.st === "ok") return { ok: false, error: "topology 정상 — 복구 불필요" };
  const d = ensureDirs(repo, mapId);
  let snaps;
  try { snaps = listJson(d.snapshots).map((f) => readJson3(path.join(d.snapshots, f))).filter((r) => r.st === "ok" && r.data.topology && r.data.mapId === mapId && r.data.decisionId).map((r) => r.data); }
  catch { return { ok: false, error: "스냅샷 서랍 판독 불가(fail-closed)" }; }
  snaps.sort((a, b) => (b.appliedCountAtSnapshot - a.appliedCountAtSnapshot) || (a.decisionId < b.decisionId ? 1 : -1)); // 최신=applied 최대·동수 decisionId 사전순 최대
  for (const s of snaps) {
    if (PM.validateTopology(s.topology).length === 0) {
      const out = path.join(repo, "project-map", "topology.recovered.json");
      fs.writeFileSync(out, PM.canonicalSerialize(s.topology), "utf8");
      return { ok: true, source: "snapshot:" + s.decisionId, out, note: "원본 보존 — 적용된 decision을 되돌리는 경로가 아님(수동 확인 후 교체)" };
    }
  }
  { // git 이력 fallback(1-18 ② — '마지막 유효본': 최근 커밋을 유계로 거슬러 첫 유효본. 13차 #9)
    const lg = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "rev-list", "-n", "20", "HEAD", "--", "project-map/topology.json"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const commits = lg.status === 0 ? String(lg.stdout || "").trim().split(/\r?\n/).filter(Boolean) : [];
    for (const cmt of commits) {
      const r = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "show", cmt + ":project-map/topology.json"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (r.status !== 0 || !r.stdout) continue;
      try {
        const cand = JSON.parse(r.stdout);
        if (PM.validateTopology(cand).length === 0 && cand.mapId === mapId) {
          const out2 = path.join(repo, "project-map", "topology.recovered.json");
          fs.writeFileSync(out2, PM.canonicalSerialize(cand), "utf8");
          return { ok: true, source: "git:" + cmt.slice(0, 8), out: out2, note: "원본 보존 — 수동 확인 후 교체" };
        }
      } catch { /* 다음 커밋 */ }
    }
  }
  return { ok: false, error: "유효 스냅샷·git 이력 없음" };
}

// ── gc(§C-5) ────────────────────────────────────────────────────────────────
function pipelineGc(repo, mapId) {
  const lk = MR.withMapLock(repo, () => pipelineGcInLock(repo, mapId)); // 회수자 직렬화(15차 #1 — gc끼리 mapLock)
  if (!lk.ok) return { ok: false, error: "정본 잠금 실패" };
  return lk.result;
}
function pipelineGcInLock(repo, mapId) {
  const d = ensureDirs(repo, mapId);
  // dead .nslock 격리(15차 #1 — withNsLock은 자동 회수를 하지 않으므로 여기가 유일 복구 경로):
  // dead-valid(정상 JSON+죽은 pid)만, 재확인 후 격리 rename(P1 계약 동형 — mapLock이 gc끼리 직렬화하고,
  // claim의 wx는 부재 시에만 성공하므로 격리 후 자연 재개. 활성·손상·판독불가는 불간섭).
  let nsRecovered = 0;
  {
    const lockFile = path.join(d.base, ".nslock");
    const cur = readJson3(lockFile);
    const deadValid = cur.st === "ok" && Number.isInteger(cur.data.pid) && cur.data.pid > 0 && typeof cur.data.token === "string"
      && (() => { try { process.kill(cur.data.pid, 0); return false; } catch (e) { return !!(e && e.code === "ESRCH"); } })();
    if (deadValid) {
      const again = readJson3(lockFile);
      if (again.st === "ok" && again.data.pid === cur.data.pid && again.data.token === cur.data.token) {
        try { fs.renameSync(lockFile, lockFile + ".stale." + crypto.randomBytes(4).toString("hex")); nsRecovered = 1; } catch { /* 경쟁 무해 */ }
      }
    }
  }
  const active = new Set(listJson(d.wal).map((f) => f.replace(/\.json$/, "")));
  const claimed = new Set();
  for (const f of listJson(d.pending)) { const r = readJson3(path.join(d.pending, f)); if (r.st === "ok" && r.data.lifecycle === "claimed" && r.data.claim) claimed.add(r.data.claim.decisionId); }
  let removed = 0;
  const gi = gitInfo(repo);
  // 보존 상한(19차 #2 — env>기본 클램프·별도 설정 계층 없음. 근거: C-5 '비-git은 개수 상한'·wal-complete 보존 상한 gc)
  const capRaw = Number(process.env.CODEX_BRIDGE_MAP_GC_KEEP || 200);
  const keepCap = Math.min(Math.max(Number.isFinite(capRaw) ? capRaw : 200, 20), 5000);
  const trimOldComplete = (protect) => { // '오래된 순'=WAL 고정 decision.audit.ts 1차·decisionId 동률(20차 #3 — UUID 사전순은 시간이 아님)
    const items = listJson(d.walComplete).map((f2) => {
      const id = f2.replace(/\.json$/, "");
      const r2 = readJson3(path.join(d.walComplete, f2));
      const ts = r2.st === "ok" && r2.data.decision && r2.data.decision.audit ? String(r2.data.decision.audit.ts || "") : "";
      return { id, ts };
    }).filter((x) => !protect.has(x.id)).sort((a2, b2) => (a2.ts + a2.id < b2.ts + b2.id ? -1 : 1));
    const excess = items.length - keepCap;
    for (let i = 0; i < excess; i++) { try { fs.unlinkSync(path.join(d.walComplete, items[i].id + ".json")); removed++; } catch { /* 무해 */ } }
  };
  for (const f of listJson(d.markers)) {
    const did = f.replace(/\.json$/, "");
    if (active.has(did) || claimed.has(did)) continue; // 활성·claimed 참조 보존(§C-5+§B)
    if (gi) { // git: decision 파일이 HEAD에 존재+내용 일치 시 제거
      const rel = "project-map/decisions/" + did + ".json";
      const r = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "cat-file", "-p", "HEAD:" + rel], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const cur = fileSha(path.join(repo, rel));
      if (r.status === 0 && cur && sha1(String(r.stdout)) === cur) { try { fs.unlinkSync(path.join(d.markers, f)); removed++; } catch { /* 무해 */ } }
    }
  }
  // wal-complete 보존 상한(활성·claimed 참조 보존 — 19차 #2·20차 #3 ts 순서)
  const protect = new Set([...active, ...claimed]);
  trimOldComplete(protect);
  // 비-git marker는 complete 정리와 연동: 대응 complete가 정리된(부재) marker만 제거 — complete의 ts 순
  // 상한이 시간 순서를 지배하므로 marker에 별도 시계가 필요 없다(20차 #3).
  if (!gi) {
    const haveComplete = new Set(listJson(d.walComplete).map((f2) => f2.replace(/\.json$/, "")));
    for (const f2 of listJson(d.markers)) {
      const id = f2.replace(/\.json$/, "");
      if (protect.has(id) || haveComplete.has(id)) continue;
      try { fs.unlinkSync(path.join(d.markers, f2)); removed++; } catch { /* 무해 */ }
    }
  }
  // P3a 바인딩 서랍 GC(구현 1차 #2 — lazy require: 로드 순환 회피. 구버전 '파일 부재'만 무시·그 외 예외=진단 표기)
  let bindingsGcError = null;
  try {
    const MBx = require(path.join(__dirname, "map-bindings.js"));
    const rg = MBx.gcBindingsInLock(repo);
    nsRecovered += rg.lockRecovered; removed += rg.removed;
    if (rg.error) bindingsGcError = rg.error; // 서랍 손상 진단(구현 3차 #4)
  } catch (e) {
    const notFound = e && e.code === "MODULE_NOT_FOUND" && String(e.message || "").includes("map-bindings");
    if (!notFound) bindingsGcError = String(e && e.message || e); // 성공 위장 금지(구현 2차 #6)
  }
  // orphan 스냅샷(WAL·complete 미참조) 정리
  const completeRef = new Set(listJson(d.walComplete).map((f) => f.replace(/\.json$/, "")));
  for (const f of listJson(d.snapshots)) {
    const did = f.replace(/\.json$/, "");
    if (!active.has(did) && !claimed.has(did) && !completeRef.has(did)) { try { fs.unlinkSync(path.join(d.snapshots, f)); removed++; } catch { /* 무해 */ } }
  }
  return bindingsGcError ? { ok: false, removed, nsRecovered, bindingsGcError } : { ok: true, removed, nsRecovered }; // exit 계약도 실패로(구현 3차 #4)
}

// ── verify-guard 소비(C-5·§6 1-32): 자동/수동 변경 구분은 '산출물 일치'로만 ───────────────────
// 반환 {mode, excluded}: mode="pipeline"=decisions/가 존재하는 mapId(1-32 판정 — P1 exclude 불사용) /
// "bootstrap-only"=decisions/ 부재(P1 run-state exclude 유지). 모든 실패=포함(빈 집합) — 자동물을 잘못
// 제외하는 거짓 음성 금지. 읽기 전용·잠금 없음(guard는 훅 경로 — 관측이 파이프라인 상태를 바꾸지 않는다).
function guardExcludedFor(repo) {
  const excluded = new Set();
  try {
    const decDir = path.join(repo, "project-map", "decisions");
    let hasDec = false;
    try { hasDec = fs.readdirSync(decDir).some((f) => f.endsWith(".json")); } catch (e) { if (!(e && e.code === "ENOENT")) return { mode: "pipeline", excluded }; } // 판독 불가=1-32 모드의 빈 집합(전부 검증 대상)
    if (!hasDec) return { mode: "bootstrap-only", excluded };
    const rt = MR.readTopoExFor(repo);
    if (rt.st !== "ok") return { mode: "pipeline", excluded };
    const d = dirsFor(repo, rt.topo.mapId);
    const HEX40 = /^[0-9a-f]{40}$/;
    // marker는 정확 합타입 전체 통과 시에만 신뢰(23차 #1 — 1-32 '부분 상태 금지' 불변식): 키 집합 정확 일치·
    // decisionId=UUID+파일명 결속·40hex 지문·policyArtifact=null 또는 {kind 열거형,id UUID,fileAfterHash 40hex}
    // 정확 3키. 위반=이 marker가 가리키는 산출물 전부 검증 대상(fail-open 금지).
    const markerOf = (fname) => {
      const mk = readJson3(path.join(d.markers, fname));
      if (mk.st !== "ok" || !mk.data || typeof mk.data !== "object" || Array.isArray(mk.data)) return null;
      const m = mk.data;
      if (Object.keys(m).sort().join(",") !== "decisionFileAfterHash,decisionId,policyArtifact") return null;
      if (typeof m.decisionId !== "string" || !UUID_RE.test(m.decisionId) || fname !== m.decisionId + ".json") return null;
      if (typeof m.decisionFileAfterHash !== "string" || !HEX40.test(m.decisionFileAfterHash)) return null;
      if (m.policyArtifact !== null) {
        const pa = m.policyArtifact;
        if (!pa || typeof pa !== "object" || Array.isArray(pa)) return null;
        if (Object.keys(pa).sort().join(",") !== "fileAfterHash,id,kind") return null;
        if (pa.kind !== "intent-policy" && pa.kind !== "policy-revocation") return null;
        if (typeof pa.id !== "string" || !UUID_RE.test(pa.id)) return null;
        if (typeof pa.fileAfterHash !== "string" || !HEX40.test(pa.fileAfterHash)) return null;
      }
      return m;
    };
    let latest = null; // topology transaction decision만 후보(23차 #2 — 정책 op은 topology/MAP.md를 쓰지 않는 불변 트랜잭션(F-2)이라 그 감사 지문으로 topology를 귀속하면 수동 변경 세탁 통로가 된다)
    for (const f of listJson(d.markers)) {
      const m = markerOf(f);
      if (m === null) continue; // 합타입 위반=이 marker 산출물 전부 포함(검증 대상)
      const rel = "project-map/decisions/" + m.decisionId + ".json";
      const D3 = fileSha3(path.join(repo, rel));
      if (D3.st !== "ok" || D3.hash !== m.decisionFileAfterHash) continue; // 불일치(수동 편집·혼합)=검증 대상
      excluded.add(rel);
      if (m.policyArtifact) {
        const pa = m.policyArtifact;
        const rel2 = "project-map/policies/" + (pa.kind === "policy-revocation" ? pa.id + ".revoke.json" : pa.id + ".json");
        const P3 = fileSha3(path.join(repo, rel2));
        if (P3.st === "ok" && P3.hash === pa.fileAfterHash) excluded.add(rel2);
      }
      const dj = readJson3(path.join(repo, rel));
      if (dj.st === "ok" && dj.data.audit && typeof dj.data.audit.ts === "string"
        && dj.data.patch && !PM.isPolicyOpV2(dj.data.patch.operation)) { // topology 후보만(audit.ts 최신·동률 decisionId — GC와 동일 키)
        const key = dj.data.audit.ts + m.decisionId;
        if (!latest || key > latest.key) latest = { key, audit: dj.data.audit };
      }
    }
    // topology/MAP.md: 최신 topology decision의 기록 지문과 '둘 다' 정확 일치 시에만 쌍으로 제외(혼합=검증 대상).
    // topologyAfterHash=canonical mapHash(적용기 기록과 동일 함수). MAP.md는 실존 파일 일치 필수 — topology
    // writer는 파일을 항상 생성하므로 부재=삭제됨=검증 대상(부재≠빈 파일, 23차 #3).
    if (latest) {
      let topoOk = false;
      try { topoOk = PM.mapHashOf(rt.topo) === latest.audit.topologyAfterHash; } catch { topoOk = false; }
      const M3 = fileSha3(path.join(repo, "project-map", "MAP.md"));
      if (topoOk && M3.st === "ok" && M3.hash === latest.audit.mapMdAfterHash) { excluded.add("project-map/topology.json"); excluded.add("project-map/MAP.md"); }
    }
  } catch { /* 보수: 포함 */ }
  return { mode: "pipeline", excluded };
}

// ── P3a 확장 — promotion 의미 키 유일성(설계 MAP-P3A-DESIGN.md §E-W·8차 #1·9차 #1·10차 #3) ─────
const PENDING_LIFECYCLES = ["proposed", "classified", "claimed", "resolved", "resolved-noop", "expired"];
// pending 전수 스캔(잠금 없는 판독 — proposeUnique는 nsLock 안에서 호출). '손상'은 fail-closed(10차 #3):
// JSON 실패·schema 불일치·미지 lifecycle·patch 부재/스키마 실패·파일명↔patchId 불일치·claimed인데 claim 불완전.
function findPromotions(repo, mapId, key) {
  const d = dirsFor(repo, mapId);
  let files;
  try { files = listJson(d.pending); } catch { return { st: "error", error: "pending 서랍 판독 불가 — fail-closed" }; }
  const active = [], expired = [], resolved = [];
  for (const f of files) {
    const r = readJson3(path.join(d.pending, f));
    if (r.st !== "ok") return { st: "error", error: "pending 손상(" + f + ": " + r.st + ") — fail-closed" };
    const rec = r.data;
    if (!rec || rec.schema !== "map-pending-v2" || !PENDING_LIFECYCLES.includes(rec.lifecycle) || !rec.patch)
      return { st: "error", error: "pending 형식 위반(" + f + ") — fail-closed(미지 lifecycle 포함)" };
    if (f !== rec.patch.patchId + ".json") return { st: "error", error: "pending 파일명↔patchId 불일치(" + f + ") — fail-closed" };
    if (rec.lifecycle === "claimed" && !(rec.claim && Number.isInteger(rec.claim.pid) && typeof rec.claim.token === "string" && typeof rec.claim.decisionId === "string"))
      return { st: "error", error: "claimed pending의 claim 불완전(" + f + ") — fail-closed" };
    const pt = rec.patch;
    if (PM.validatePatchV2(pt).length) return { st: "error", error: "pending patch 스키마 실패(" + f + ") — fail-closed" };
    const isPromo = pt.mapId === mapId && pt.operation === "add_evidence" && pt.payload && pt.payload.evidence
      && pt.payload.evidence.kind === "ledger" && pt.payload.evidence.ref === key.sig
      && (!key.targetId || pt.targetId === key.targetId);
    if (!isPromo) continue;
    if (rec.lifecycle === "proposed" || rec.lifecycle === "classified" || rec.lifecycle === "claimed") active.push(pt.patchId);
    else if (rec.lifecycle === "expired") expired.push(pt.patchId);
    else resolved.push(pt.patchId);
  }
  return { st: "ok", active: active.sort(), expired: expired.sort(), resolved: resolved.sort() };
}
// 의미 키 검색·검증·수납을 '하나의 nsLock 임계구역'에서(8차 #1 — 검색·기록 분리 경합 봉합).
// semanticKey를 신뢰하지 않는다(9차 #1): buildPatch() 결과에서 키를 재산출해 대조.
function proposeUnique(repo, mapId, semanticKey, buildPatch) {
  ensureDirs(repo, mapId);
  const w = withNsLock(repo, mapId, () => {
    const fp = findPromotions(repo, mapId, semanticKey);
    if (fp.st !== "ok") return { st: "error", reason: fp.error };
    if (fp.active.length > 1) return { st: "conflict", reason: "동일 의미 키 활성 pending 복수(" + fp.active.join(",") + ") — 수동 확인" };
    if (fp.active.length === 1) return { st: "already-pending", patchId: fp.active[0] };
    if (fp.resolved.length) return { st: "resolved-exists", patchId: fp.resolved[0] }; // 구현 1차 #7 — caller의 already-applied 검사가 선행됐으므로 여기 도달=evidence 부재=진단
    let patch;
    try { patch = buildPatch(); } catch (e) { return { st: "error", reason: "buildPatch 예외: " + String(e && e.message || e) }; }
    const errs = PM.validatePatchV2(patch);
    if (errs.length) return { st: "error", reason: "patch 스키마 실패: " + errs[0] };
    if (patch.mapId !== mapId) return { st: "error", reason: "patch.mapId ≠ mapId" };
    if (patch.operation !== "add_evidence") return { st: "error", reason: "promotion은 add_evidence만" };
    const ev = patch.payload && patch.payload.evidence;
    if (!ev || ev.kind !== "ledger") return { st: "error", reason: "payload.evidence.kind=ledger 필수" };
    if (patch.targetId !== semanticKey.targetId || ev.ref !== semanticKey.sig)
      return { st: "error", reason: "patch 재산출 의미 키 ≠ 검색 키(호출부 우회 차단 — 9차 #1)" };
    const f = pendingFileFor(repo, mapId, patch.patchId);
    if (fs.existsSync(f)) {
      const cur = readJson3(f);
      if (!(cur.st === "ok" && cur.data.patch && PM.opHashOf(cur.data.patch) === PM.opHashOf(patch))) return { st: "error", reason: "같은 patchId의 다른 내용 — 멱등 위장 금지" };
      // 같은 내용의 기존 파일 — 활성이면 위 의미 키 검색이 이미 잡았으므로 여기 도달=expired|resolved(5차 #5)
      if (cur.data.lifecycle === "expired") return { st: "retry-required", patchId: patch.patchId }; // 같은 생성 입력=같은 세대 — 입력 갱신 후 재제안
      if (cur.data.lifecycle === "resolved" || cur.data.lifecycle === "resolved-noop") return { st: "resolved-exists", patchId: patch.patchId }; // 소비자가 evidence 실존으로 already-applied/진단 분기
      return { st: "proposed", patchId: patch.patchId, idempotent: true };
    }
    const rec = { schema: "map-pending-v2", lifecycle: "proposed", patch, localOrigin: localOriginFor(repo), proposedAt: new Date().toISOString() };
    if (!CL.atomicWrite(f, JSON.stringify(rec, null, 1))) return { st: "error", reason: "pending 기록 실패" };
    return { st: "proposed", patchId: patch.patchId, patch }; // 기록한 그 patch를 반환(구현 2차 #2 — 재생성 금지)
  });
  return w.ok ? w.result : { st: "error", reason: w.error };
}

module.exports = {
  findPromotions, proposeUnique, expirePendingPatch, persistTerminalExpire,
  guardExcludedFor,
  canonicalIdentityFor, localOriginFor, patchBasisFor, pipeRootFor, dirsFor, ensureDirs, baselineUpdatesFor, captureDirRaw, decisionIndexFromCapture, policyStateFromCapture,
  activePipelineWalFor, decisionIndexFor, policyStateFor, authorityOf,
  buildReadSetFor, readSetIntact, casCheck, entityHashOf,
  proposePatch, classifyPatch, applyPatch, recoverWal, abortWal, recoverCorruption, pipelineGc, validateWalV2,
  DEFAULT_CLASSIFICATION,
};
