"use strict";
// [HARNESS-STRUCTURE-2026-09-11 §B2 (2)(3) · 사용자 결정 D2] 지도 칸 회전 — 사실 기반 내리기·복귀·필요 시 교체·보상.
// 원칙: 사람은 기준(상한·보호·켜기/끄기), 기계는 노동. 시간 경과만으로 지우지 않는다. 기록은 지우지 않는다(ab-5).
// 모든 상태 변경은 정규 패치 파이프라인(propose→classify→apply)을 지난다 — 검증기 안 변이 없음. 각 전이=독립 decision·WAL·스냅샷.
// 하네스 통로 표식: patch.provider="harness-git" · detectedBy ∈ FACT_DETECTED_BY · rationale 접두(file-gone@·renamed-to:·rotated-out@·revived@·rotation-reverted@).
// 근거: evidence [{kind:"git", ref:<커밋>}] — 정본 관문은 detectedBy 가 하네스 사실 판독 표식일 때만 git 근거를 코드 계열 대신 인정하고, 적용기가 커밋 실존을 검사한다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const BR = __dirname;
const CL = require(path.join(BR, "contract-lib.js"));
const PM = () => require(path.join(BR, "project-map.js"));
const MP = () => require(path.join(BR, "map-pipeline.js"));
const MR = () => require(path.join(BR, "map-runtime.js"));

const HARNESS_PROVIDER = "harness-git";
const RATIONALE = { gone: "file-gone@", renamed: "renamed-to:", rotated: "rotated-out@", revived: "revived@", reverted: "rotation-reverted@" };
const DEFAULT_POLICY = { enabled: true, protectDays: 14, hubMinDegree: 3 }; // 사용자 설정(계약 mapRotation)이 덮어씀 — 기본값 고지 대상
const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

function git(repo, args, timeout) {
  try { const r = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", timeout: timeout || 5000, windowsHide: true }); return r.status === 0 ? String(r.stdout || "") : null; } catch { return null; }
}
function headOf(repo) { const h = git(repo, ["rev-parse", "HEAD"], 3000); const s = h ? h.trim() : ""; return OID_RE.test(s) ? s : null; }
function objectFormatOf(repo) { const f = git(repo, ["rev-parse", "--show-object-format"], 3000); return f && f.trim() === "sha256" ? "sha256" : "sha1"; }
function short7(h) { return String(h || "").slice(0, 7); }
function normP(p) { return String(p || "").replace(/\\/g, "/"); }
function anchorPathOf(n) { return n && Array.isArray(n.anchors) && n.anchors[0] ? normP(n.anchors[0].path) : ""; }
function isOwn(p) { return normP(p).startsWith("project-map/"); }

// ── (2) 사실 판독: base..end 의 삭제(D)·이름변경(R) — `git diff --name-status -M -z`(NUL 구분·원문 경로) ──
function gitFactsSince(repo, baseHead, endHead) {
  if (!OID_RE.test(String(baseHead || "")) || !OID_RE.test(String(endHead || ""))) return null;
  if (baseHead === endHead) return { deleted: [], renamed: [], changed: [] };
  const out = git(repo, ["diff", "--name-status", "-M", "-z", baseHead + ".." + endHead], 5000);
  if (out === null) return null;
  const parts = out.split("\0");
  const deleted = [], renamed = [], changed = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i];
    if (!st) { i++; continue; }
    if (st[0] === "R" || st[0] === "C") { // R<score>\0old\0new
      const from = parts[i + 1], to = parts[i + 2]; i += 3;
      if (!from || !to) continue;
      if (st[0] === "R" && !isOwn(from)) renamed.push({ from: normP(from), to: normP(to) });
      if (!isOwn(to)) changed.push(normP(to));
    } else {
      const p = parts[i + 1]; i += 2;
      if (!p || isOwn(p)) continue;
      if (st[0] === "D") deleted.push(normP(p)); else changed.push(normP(p));
    }
  }
  return { deleted, renamed, changed };
}

// ── 정규 패치 조립·적용(보강 실행기의 toPatchV2 와 같은 기준 필드 — 하네스 표식만 다름) ──
function buildHarnessPatch(repo, topo, spec) {
  const pm = PM(), mp = MP();
  const idx = mp.decisionIndexFor(repo, topo.mapId);
  const pol = mp.policyStateFor(repo, topo.mapId);
  if (idx.st === "error" || pol.st !== "ok") return { ok: false, error: "state-read" };
  const { ah } = mp.authorityOf(pm.mapHashOf(topo), idx);
  const b = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: mp.patchBasisFor(repo, topo), baseMapHash: pm.mapHashOf(topo),
    baseAuthorityHash: ah, baseDecisionContextHash: pm.decisionContextHashOf(ah, pol.pfh),
    baseDirtyFp: "", operation: spec.operation, payload: spec.payload, readSet: {},
    rationale: spec.rationale, evidence: spec.evidence, provider: HARNESS_PROVIDER, detectedBy: spec.detectedBy,
    ...(spec.targetId ? { targetId: spec.targetId } : {}),
  };
  b.readSet = mp.buildReadSetFor(topo, b, { idx, pol, repoRoot: repo, fileHashOf: (ref) => { try { return crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, ref))).digest("hex"); } catch { return null; } } });
  const patch = pm.canonicalPatchV2(b);
  const ve = pm.validatePatchV2(patch);
  if (ve.length) return { ok: false, error: "patch-invalid: " + ve[0] };
  return { ok: true, patch };
}
function applyHarnessPatch(repo, patch) {
  const mp = MP();
  const pr = mp.proposePatch(repo, patch);
  if (!pr.ok) return { ok: false, stage: "propose", error: (pr.errors && pr.errors[0]) || pr.stage || "propose-failed" };
  const cf = mp.classifyPatch(repo, patch.mapId, patch.patchId);
  if (!cf.ok) return { ok: false, stage: "classify", error: cf.error || "classify-failed" };
  // 정본 의미 검사(활성 상한 등)에 걸리면 분류가 needs-investigation 이 되고 적용기는 '해소 증거 없음'으로 거부한다 — 실제 사유(정본 오류 첫 줄)를 앞세워 돌려준다.
  if (cf.classification && cf.classification !== "auto") return { ok: false, stage: "classify", error: "classification=" + cf.classification + (cf.errors && cf.errors.length ? ": " + cf.errors[0] : ""), classification: cf.classification };
  const ap = mp.applyPatch(repo, patch.mapId, patch.patchId, { preCutover: true });
  if (!ap.ok) return { ok: false, stage: "apply", error: ap.error || ap.fail || ap.reasonCode || "apply-failed" };
  return { ok: true, decisionId: ap.decisionId || null };
}
function lifecyclePatch(repo, topo, node, to, expect, rationale, detectedBy, head, note) {
  return buildHarnessPatch(repo, topo, {
    operation: "set_state", targetId: node.id,
    payload: { to: { lifecycle: to }, expect: { lifecycle: expect } },
    rationale, detectedBy, evidence: [{ kind: "git", ref: head, note }],
  });
}
// 노드가 '하네스 사실 통로'로 내려간 것인지 — provenance.decisionId 의 결정 기록에서 patch.detectedBy·rationale 판독
// 이 노드를 deprecated 로 만든 결정 기록을 찾는다 — provenance.decisionId 는 '가장 최근 결정'이라 뒤에 add_evidence·add_anchor 같은 비상태 결정이
// 덮어쓸 수 있다(확인 검증 3판 blocker). 그래서 provenance 가 강등 결정이 아니면 결정 색인에서 이 노드를 겨냥한 set_state(→deprecated) 중
// 가장 최근 것(audit.ts)을 찾는다 — 노드가 지금 deprecated 인 이상 그 결정이 현재 강등의 원인이다(그 뒤 set_state 가 있었다면 lifecycle 이 달라졌다).
function readDecision(repo, did) { try { return JSON.parse(fs.readFileSync(path.join(repo, "project-map", "decisions", did + ".json"), "utf8")); } catch { return null; } }
function demotionOf(dec) {
  const p = dec && dec.patch;
  if (!p || p.operation !== "set_state") return null;
  const to = p.payload && p.payload.to;
  if (!to || to.lifecycle !== "deprecated") return null;
  return { decisionId: dec.decisionId, rationale: String(p.rationale || ""), detectedBy: p.detectedBy || null, ts: String((dec.audit && dec.audit.ts) || "") };
}
// 후보가 여럿이면 순서는 시각(audit.ts — 같은 밀리초에 두 결정이 적힐 수 있다: 확인 검증 4판 blocker)이 아니라 **topology 해시 사슬**로 정한다:
// 각 결정은 audit.topologyBeforeHash → topologyAfterHash 로 이어지고 현재 topology 의 mapHashOf 가 사슬 끝이다. 끝에서 거슬러 올라가
// 처음 만나는 후보가 '현재 강등의 원인'이다. 사슬이 끊겨 순서를 못 정하면 null(=소유 아님 → 되돌리지 않음·표식 회수) — 남의 강등을 뒤집는 쪽으로 기울지 않는다.
function orderByChain(repo, topo, candidates) {
  const pm = PM();
  const dir = path.join(repo, "project-map", "decisions");
  const byAfter = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("legacy")); } catch { return { ok: false }; }
  for (const f of files) {
    const d = readDecision(repo, f.slice(0, -5));
    if (!d || d.mapId !== topo.mapId || !d.audit) continue;
    const b = d.audit.topologyBeforeHash, a = d.audit.topologyAfterHash;
    if (!a || !b || a === b) continue; // topology 를 안 바꾼 결정(정책 op 등)은 사슬 진행이 없다 — 자기 고리 방지
    if (byAfter.has(a)) return { ok: false }; // 같은 after 해시가 둘=사슬 모호 — 순서 판정 포기
    byAfter.set(a, d);
  }
  const ids = new Map(candidates.map((c) => [c.decisionId, c]));
  let h = pm.mapHashOf(topo);
  for (let i = 0; i <= files.length; i++) {
    const d = byAfter.get(h);
    if (!d) return { ok: false }; // 현재 topology 가 어떤 결정의 결과도 아니거나 사슬 끊김
    if (ids.has(d.decisionId)) return { ok: true, decision: ids.get(d.decisionId) };
    h = d.audit.topologyBeforeHash;
  }
  return { ok: false };
}
// topoOrMapId: topology 객체(권장 — 사슬 순서 판정 가능) 또는 mapId 문자열(색인 조회만 — 후보가 둘 이상이면 순서 불명=null)
function demotionDecisionOf(repo, node, topoOrMapId) {
  if (!node) return null;
  const did = node.provenance && node.provenance.decisionId;
  const fast = did ? demotionOf(readDecision(repo, did)) : null;
  if (fast) return fast;
  const topo = topoOrMapId && typeof topoOrMapId === "object" ? topoOrMapId : null;
  const mapId = topo ? topo.mapId : (typeof topoOrMapId === "string" ? topoOrMapId : null);
  if (!mapId) return null; // 색인 조회에는 세대(mapId)가 필요 — 없으면 provenance 경로만
  try {
    const idx = MP().decisionIndexFor(repo, mapId);
    if (!idx || idx.st !== "ok") return null;
    const cands = [];
    for (const pr of idx.projections) {
      if (!pr || pr.operation !== "set_state" || !(pr.targetIds || []).includes(node.id)) continue;
      const d = demotionOf(readDecision(repo, pr.decisionId));
      if (d) cands.push(d);
    }
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    if (!topo) return null; // 순서를 정할 재료(현재 topology) 없음 — 모호=소유 아님
    const o = orderByChain(repo, topo, cands);
    return o.ok ? o.decision : null;
  } catch { return null; }
}
function harnessDeprecationOf(repo, node, topoOrMapId) {
  const pm = PM();
  const d = demotionDecisionOf(repo, node, topoOrMapId);
  if (!d || !(pm.FACT_DETECTED_BY || []).includes(d.detectedBy)) return null;
  return { rationale: d.rationale, detectedBy: d.detectedBy, decisionId: d.decisionId };
}
function readTopo(repo) { const t = MR().readTopoExFor(repo); return t.st === "ok" ? t.topo : null; }
// 이 강등이 '이 교체(head)'의 것인가 — 결정 기록의 detectedBy=rotation + rationale 의 커밋 표기 결속(확인 검증 blocker: lifecycle 만 보면 다른 결정의 강등을 회전 결과로 오인)
function rotationOwns(info, head) { return !!(info && info.detectedBy === "rotation" && info.rationale.startsWith(RATIONALE.rotated + short7(head) + " ")); }

// ── (2) 사실 기반 내리기: 삭제·이름변경된 경로의 활성 file 노드 → deprecated(정규 패치) ──
function applyFactTransitions(repo, facts, head, log) {
  const pm = PM();
  let topo = readTopo(repo);
  if (!topo) return { ok: false, error: "topology-unreadable", applied: [], failed: [] };
  const applied = [], failed = [];
  const work = [
    ...((facts && facts.deleted) || []).map((p) => ({ p, rationale: RATIONALE.gone + short7(head), note: "D " + p })),
    ...((facts && facts.renamed) || []).map((r) => ({ p: r.from, rationale: RATIONALE.renamed + r.to + "@" + short7(head), note: "R " + r.from + " -> " + r.to })),
  ];
  for (const w of work) {
    const n = (topo.nodes || []).find((x) => pm.isActiveFileNode(x) && anchorPathOf(x) === normP(w.p));
    if (!n) continue; // 이미 내려갔거나 지도에 없음 — 멱등
    const b = lifecyclePatch(repo, topo, n, "deprecated", "active", w.rationale, "git-name-status", head, w.note);
    if (!b.ok) { failed.push({ id: n.id, path: w.p, stage: "build", error: b.error }); continue; }
    const r = applyHarnessPatch(repo, b.patch);
    if (!r.ok) { failed.push({ id: n.id, path: w.p, stage: r.stage, error: r.error }); continue; }
    applied.push({ id: n.id, path: w.p, rationale: w.rationale, decisionId: r.decisionId });
    if (typeof log === "function") log({ route: "fact-transition", reason: w.note.startsWith("D") ? "file-gone" : "renamed", outcome: "applied", detail: w.p });
    const t2 = readTopo(repo); if (!t2) { failed.push({ id: null, path: null, stage: "topology", error: "topology-unreadable (remaining transitions skipped)" }); break; } topo = t2;
  }
  return { ok: true, applied, failed };
}
// ── 복귀: 하네스 통로로 내려간 노드가 (가) 삭제·이름변경분=파일 실존 (나) 교체분=이번 변경 목록에 포함이면 active 로 ──
function applyRevivals(repo, changedPaths, head, log) {
  const pm = PM();
  let topo = readTopo(repo);
  if (!topo) return { ok: false, error: "topology-unreadable", applied: [], failed: [] };
  const changed = new Set((changedPaths || []).map(normP));
  const applied = [], failed = [];
  const cands = (topo.nodes || []).filter((n) => n && n.entityType === "file" && n.state && n.state.lifecycle === "deprecated");
  for (const n of cands) {
    const info = harnessDeprecationOf(repo, n, topo);
    if (!info) continue;
    const p = anchorPathOf(n);
    if (!p) continue;
    const exists = (() => { try { return fs.statSync(path.join(repo, p)).isFile(); } catch { return false; } })();
    let revive = false;
    if (info.rationale.startsWith(RATIONALE.gone) || info.rationale.startsWith(RATIONALE.renamed)) revive = exists;
    else if (info.rationale.startsWith(RATIONALE.rotated)) revive = exists && changed.has(p);
    if (!revive) continue;
    const cur = readTopo(repo); if (!cur) { failed.push({ id: n.id, path: p, stage: "topology", error: "topology-unreadable (remaining revivals skipped)" }); break; }
    const now = (cur.nodes || []).find((x) => x && x.id === n.id);
    if (!now || !now.state || now.state.lifecycle !== "deprecated") continue;
    const b = lifecyclePatch(repo, cur, now, "active", "deprecated", RATIONALE.revived + short7(head), "git-name-status", head, "revive " + p);
    if (!b.ok) { failed.push({ id: n.id, path: p, stage: "build", error: b.error }); continue; }
    const r = applyHarnessPatch(repo, b.patch);
    if (!r.ok) { failed.push({ id: n.id, path: p, stage: r.stage, error: r.error }); continue; }
    applied.push({ id: n.id, path: p, decisionId: r.decisionId });
    if (typeof log === "function") log({ route: "fact-transition", reason: "revived", outcome: "applied", detail: p });
  }
  return { ok: true, applied, failed };
}

// ── (3) 교체 정책·후보 ──
function rotationPolicyFor(ws) { // 정규화 출처=contract-lib normMapRotation(계약 판독기가 알려진 키만 돌려주므로 거기서 정규화) · 판독 실패=기본값
  try { const c = CL.loadContract(ws); if (c && c.mapRotation && typeof c.mapRotation === "object") return { ...DEFAULT_POLICY, ...c.mapRotation }; } catch { /* 기본값 */ }
  return { ...DEFAULT_POLICY };
}
// 마지막 커밋 시각(초) — 경로별 `git log -1 --format=%ct -- <path>`. 예산 초과·실패=미상(보호). 노드 파일에 캐시하지 않는다.
function gitLastCommitEpochs(repo, paths, budgetMs) {
  const out = new Map();
  const start = Date.now();
  for (const p of paths || []) {
    if (Date.now() - start > (budgetMs || 5000)) break;
    const r = git(repo, ["log", "-1", "--format=%ct", "--", p], 2000);
    const n = r ? parseInt(r.trim(), 10) : NaN;
    if (Number.isFinite(n) && n > 0) out.set(normP(p), n);
  }
  return out;
}
// 순수 함수: 방출 후보 1개 — 보호(확정 허브·최근 변경·시각 미상) 제외 후 점수 오름차순(오래됨 → candidate 우선 → 간선 적음 → 근거 적음 → id).
function rotateCandidate(topo, ages, policy, nowSec) {
  const pm = PM();
  const pol = Object.assign({}, DEFAULT_POLICY, policy || {});
  const edges = (topo && topo.edges) || [];
  const degree = (id) => edges.filter((e) => e && (e.from === id || e.to === id)).length;
  const rank = { candidate: 0, unknown: 1, confirmed: 2 };
  const cands = [];
  for (const n of (topo && topo.nodes) || []) {
    if (!pm.isActiveFileNode(n)) continue;
    const p = anchorPathOf(n);
    const age = ages && ages.has(p) ? ages.get(p) : null;
    if (age === null) continue; // 시각 미상=보호
    const deg = degree(n.id);
    const conf = n.state && n.state.confidence;
    if (conf === "confirmed" && deg >= pol.hubMinDegree) continue; // 확정 허브 보호
    if (nowSec - age < pol.protectDays * 86400) continue; // 최근 변경 보호
    cands.push({ id: n.id, path: p, age, conf: rank[conf] === undefined ? 1 : rank[conf], deg, ev: Array.isArray(n.evidence) ? n.evidence.length : 0 });
  }
  cands.sort((a, b) => (a.age - b.age) || (a.conf - b.conf) || (a.deg - b.deg) || (a.ev - b.ev) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cands.length ? cands[0] : null;
}
// add_node 직전 교체 — 활성 칸이 상한이고 들어오는 노드가 활성 file 이면 후보 1개를 정규 패치로 내린다.
// 반환: {rotated:false} | {rotated:true, victimId, head, objectFormat} | {parkReason:"rotation-failed:<단계>"}
// ctx: { patch, topo, head?, updateJob(mut)->{ok}, log }
function rotateBeforeAdd(repo, ws, ctx) {
  const pm = PM();
  const patch = ctx && ctx.patch;
  if (!patch || patch.operation !== "add_node" || !pm.isActiveFileNode(patch.payload && patch.payload.node)) return { rotated: false };
  const policy = rotationPolicyFor(ws);
  if (!policy.enabled) return { rotated: false, reason: "disabled" };
  const topo = ctx.topo;
  if (!topo || pm.activeFileNodeCount(topo) < pm.MAX_FILE_NODES) return { rotated: false };
  const head = OID_RE.test(String(ctx.head || "")) ? ctx.head : headOf(repo);
  if (!head) return { parkReason: "rotation-failed:no-git" };
  const ages = gitLastCommitEpochs(repo, (topo.nodes || []).filter((n) => pm.isActiveFileNode(n)).map(anchorPathOf).filter(Boolean), 5000);
  const victim = rotateCandidate(topo, ages, policy, Math.floor(Date.now() / 1000));
  if (!victim) { if (ctx.log) ctx.log({ route: "rotation", reason: "no-candidate", outcome: "parked" }); return { parkReason: "rotation-failed:no-candidate" }; }
  const node = (topo.nodes || []).find((n) => n && n.id === victim.id);
  const newPath = anchorPathOf(patch.payload.node);
  const b = lifecyclePatch(repo, topo, node, "deprecated", "active", RATIONALE.rotated + short7(head) + " for " + newPath, "rotation", head, "rotate-out " + victim.path + " for " + newPath);
  if (!b.ok) return { parkReason: "rotation-failed:build" };
  const objectFormat = objectFormatOf(repo);
  const partial = { victimId: victim.id, objectFormat, head, at: new Date().toISOString() };
  // 부분 상태 표식은 방출 '전'에 적는다(방출 뒤 사망해도 다음 실행이 보상) — 기록 실패면 방출하지 않는다.
  const w0 = ctx.updateJob ? ctx.updateJob((jj) => jj && { ...jj, rotationPartial: partial }) : { ok: true };
  if (!w0 || !w0.ok) return { parkReason: "rotation-failed:job-write" };
  const r = (typeof ctx.apply === "function" ? ctx.apply : applyHarnessPatch)(repo, b.patch); // ctx.apply=시험 주입(부분 적용 실패 재현)
  if (!r.ok) {
    // [확인 검증 blocker] applyPatch 는 topology·decision 을 적은 뒤(marker 기록 등) 실패할 수 있다 — 실물이 이미 내려갔으면 표식을 지우지 않는다(다음 실행 시작이 보상).
    const t2 = readTopo(repo);
    const nowV = t2 && (t2.nodes || []).find((n) => n && n.id === victim.id);
    const deprecatedNow = !!(nowV && nowV.state && nowV.state.lifecycle === "deprecated");
    // 표식 유지 조건=실물이 내려갔고 '그 강등의 결정 기록이 이 교체(head)의 것'일 때만 — 다른 결정의 강등이면 우리 것이 아니므로 표식 회수(되돌리면 남의 결정을 뒤집는다).
    const ownedNow = deprecatedNow && rotationOwns(harnessDeprecationOf(repo, nowV, t2), head);
    if (!ownedNow && ctx.updateJob) ctx.updateJob((jj) => jj && { ...jj, rotationPartial: null }); // 상태 변화 없음 또는 남의 강등=표식 회수
    if (ctx.log) ctx.log({ route: "rotation", reason: r.stage, outcome: "parked", detail: (r.error || "") + (ownedNow ? " (victim deprecated by this rotation — partial kept)" : deprecatedNow ? " (victim deprecated by another decision — partial dropped)" : "") });
    return { parkReason: "rotation-failed:" + r.stage, partialKept: ownedNow };
  }
  if (ctx.log) ctx.log({ route: "rotation", reason: "rotated-out", outcome: "applied", detail: victim.path + " -> " + newPath });
  return { rotated: true, victimId: victim.id, head, objectFormat, victimPath: victim.path };
}
// 보상: 방출한 노드를 active 로 되돌린다(정규 패치). 이미 active 면 멱등 성공.
function rotationCompensate(repo, victimId, head) {
  const topo = readTopo(repo);
  if (!topo) return { ok: false, stage: "topology", error: "topology-unreadable" };
  const n = (topo.nodes || []).find((x) => x && x.id === victimId);
  if (!n) return { ok: false, stage: "lookup", error: "victim-missing" };
  if (!n.state || n.state.lifecycle !== "deprecated") return { ok: true, noop: true };
  // 남의 강등은 되돌리지 않는다 — 결정 기록이 '이 교체(head)'의 것일 때만 되돌림 대상(다른 결정의 강등=정산만·표식 회수).
  if (!rotationOwns(harnessDeprecationOf(repo, n, topo), head)) return { ok: true, noop: true, reason: "not-this-rotation" };
  // 활성 칸이 이미 상한이면 되돌리지 않는다 — 새 칸이 자리를 차지한 것이므로 교체는 완료된 것(표식 정리 대상). 되살리면 활성 61 이 된다.
  // (조기 판정일 뿐 — 권위는 적용 잠금 안 정본 set_state 상한 검사. 경합으로 거기서 거부되면 아래 재판독이 같은 결론으로 정산한다.)
  if (PM().activeFileNodeCount(topo) >= PM().MAX_FILE_NODES) return { ok: true, noop: true, reason: "cap-full" };
  const h = OID_RE.test(String(head || "")) ? head : headOf(repo);
  if (!h) return { ok: false, stage: "git", error: "no-head" };
  const b = lifecyclePatch(repo, topo, n, "active", "deprecated", RATIONALE.reverted + short7(h), "rotation-revert", h, "rotation-revert " + anchorPathOf(n));
  if (!b.ok) return { ok: false, stage: "build", error: b.error };
  const r = applyHarnessPatch(repo, b.patch);
  if (r.ok) return r;
  // 적용 거부(정본 상한 등) — 실물 재판독으로 정산: 이미 active 면 멱등 성공, 활성이 상한이면 cap-full 로 정산(61 경로는 정본이 막았다), 그 밖은 실패 그대로.
  const t3 = readTopo(repo);
  const n3 = t3 && (t3.nodes || []).find((x) => x && x.id === victimId);
  if (n3 && (!n3.state || n3.state.lifecycle !== "deprecated")) return { ok: true, noop: true };
  if (t3 && PM().activeFileNodeCount(t3) >= PM().MAX_FILE_NODES) return { ok: true, noop: true, reason: "cap-full", rejected: r.error || r.stage };
  return r;
}
// 순수: 방출 뒤 add_node 한 걸음의 결과로 표식을 어떻게 정산하나 — "clear"(추가 적용=교체 완료) · "compensate"(거부·보류=되돌림) · "keep"(일시 재시도=표식 유지) · "none"(표식 없음)
// [확인 검증 blocker] 판단 재료는 '그 반복의 교체 여부'가 아니라 '작업에 남은 표식'이다 — 일시 재시도 뒤 다음 반복에서 성공한 추가도 표식을 지운다.
function settleRotation(step, pending) {
  if (!pending || !pending.victimId) return "none";
  if (step && step.done && step.applied) return "clear";
  if ((step && step.done && !step.applied) || (step && step.parkReason)) return "compensate";
  return "keep";
}
// 실행 시작 통과: (a) 이전 실행의 부분 상태(rotationPartial) 보상 재시도 (b) 사실 전이 (c) 복귀 — 전부 정규 패치·실패는 기록만(실행을 막지 않음)
// ctx: { job, baselineHead, updateJob(mut)->{ok}, log }
// 반환 { head, ok, ... } — head=이 통과가 본 HEAD(호출자는 같은 값을 소화 기준점 끝점으로 써서 판독을 하나로 결속) · ok=false 면 호출자가 기준점을 전진시키지 않는다(다음 실행이 다시 먹는다).
function factPass(repo, ws, ctx) {
  const out = { compensated: null, facts: null, revived: null, head: null, ok: true };
  const head = headOf(repo);
  if (!head) { out.ok = false; return out; } // HEAD 판독 실패=사실 처리 없음 → 이 실행에서 기준점 전진 금지(확인 검증 blocker: 뒤의 별도 판독이 성공해도)
  out.head = head;
  try {
    const rp = ctx && ctx.job && ctx.job.rotationPartial;
    if (rp && rp.victimId) {
      const c = rotationCompensate(repo, rp.victimId, rp.head);
      out.compensated = c;
      // 보상 실패는 표식(rotationPartial)이 다음 실행에서 다시 시도한다 — 소화 기준점 전진 여부(out.ok)와는 별개 축
      if (c.ok && ctx.updateJob) ctx.updateJob((jj) => jj && { ...jj, rotationPartial: null });
      if (ctx.log) ctx.log({ route: "rotation", reason: c.ok ? "reverted-on-resume" : "rotation-partial", outcome: c.ok ? "reverted" : "partial", detail: rp.victimId });
    }
  } catch (e) { if (ctx && ctx.log) ctx.log({ route: "rotation", reason: "exception:" + String(e && e.message).slice(0, 60), outcome: "partial" }); }
  try {
    const base = ctx && ctx.baselineHead;
    const facts = gitFactsSince(repo, base, head);
    if (facts) {
      out.facts = applyFactTransitions(repo, facts, head, ctx && ctx.log);
      out.revived = applyRevivals(repo, facts.changed, head, ctx && ctx.log);
      if (!out.facts.ok || out.facts.failed.length || !out.revived.ok || out.revived.failed.length) out.ok = false; // 일부라도 못 적용=기준점 전진 금지
    } else {
      if (OID_RE.test(String(base || ""))) out.ok = false; // 기준점은 있는데 판독 실패(git 오류)=전진 금지
      out.revived = applyRevivals(repo, [], head, ctx && ctx.log); // 기준점 없음=삭제·이름변경 판독 불가, 복귀(파일 실존)만
      if (!out.revived.ok || out.revived.failed.length) out.ok = false; // (확인 검증 3판 blocker) 이 분기도 복귀 실패=기준점 전진 금지
    }
  } catch (e) { out.ok = false; if (ctx && ctx.log) ctx.log({ route: "fact-transition", reason: "exception:" + String(e && e.message).slice(0, 60), outcome: "skipped" }); }
  return out;
}
module.exports = { HARNESS_PROVIDER, RATIONALE, DEFAULT_POLICY, OID_RE, settleRotation, rotationOwns, demotionDecisionOf, orderByChain, gitFactsSince, headOf, objectFormatOf, buildHarnessPatch, applyHarnessPatch, harnessDeprecationOf, applyFactTransitions, applyRevivals, rotationPolicyFor, gitLastCommitEpochs, rotateCandidate, rotateBeforeAdd, rotationCompensate, factPass };
