/*
 * P9 intent automation — conflict cards, durable choice records, and resume.
 *
 * The read side is deliberately side-effect limited:
 * - collectPolicyConflictCards is a derived, read-only view over pending+frontier.
 * - recordPolicyConflictChoice writes the complete supersession patch before any
 *   pipeline proposal exists.
 * - resumePolicyConflictChoice reuses that exact stored patch and advances the
 *   P2 lifecycle without reconstructing user intent after a restart.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const CL = require(path.join(__dirname, "contract-lib.js"));
const MR = require(path.join(__dirname, "map-runtime.js"));
const MP = require(path.join(__dirname, "map-pipeline.js"));
const PM = MR.PM;

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const INTENT_DIR = path.join(BRIDGE_DIR, "map-intent");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FP_RE = /^[0-9a-f]{40}$/;
const CONFLICT_FILE_RE = /^([0-9a-f]{40})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const DIRECT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const CHOICE_PHASES = ["chosen", "patch-proposed", "done", "stale", "parked"];
const DELEGATION_PHASES = ["proposed", "applied", "done", "stale", "parked"];
const RECOVERY_PLAN_SCHEMA = "map-topology-recovery-v1";
const NONCE_RE = /^[0-9a-f]{32}$/;
const RECOVERY_BACKUP_RE = /^topology\.corrupt-[0-9TZ]+(?:-[0-9]+)?\.json$/;
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

function threeTrackOn(repo, opts) {
  try { return CL.normScoutMode(CL.loadContract(opts && opts.ws ? opts.ws : repo)) === "on"; }
  catch { return false; }
}

function twoTrackResult() { return { ok: false, reason: "two-track" }; }

function readJson3(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? { st: "ok", data } : { st: "invalid" };
  } catch { return { st: "invalid" }; }
}

function intentDirFor(repo) {
  return path.join(INTENT_DIR, CL.wsKeyFor(repo));
}

function conflictChoiceFileFor(repo, conflictKey, cardId) {
  if (!FP_RE.test(String(conflictKey)) || !UUID_RE.test(String(cardId))) throw new Error("conflictKey/cardId 형식 위반");
  return path.join(intentDirFor(repo), conflictKey + "-" + cardId + ".json");
}

function conflictKeyOf(policyIds) {
  const ids = [...new Set(policyIds || [])].sort();
  return sha1(PM.canonicalJsonOf(ids));
}

function delegationDirFor(repo) { return path.join(intentDirFor(repo), "delegations"); }
function delegationFileFor(repo, oldPatchId) {
  if (!UUID_RE.test(String(oldPatchId))) throw new Error("oldPatchId 형식 위반");
  return path.join(delegationDirFor(repo), oldPatchId + ".json");
}

function withRecoverableTransitionLock(lockFile, fn) {
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); } catch { return { ok: false, reason: "lock-dir" }; }
  const token = crypto.randomBytes(8).toString("hex");
  const mine = { pid: process.pid, token };
  try { fs.writeFileSync(lockFile, JSON.stringify(mine), { flag: "wx" }); }
  catch {
    const held = readJson3(lockFile);
    if (!(held.st === "ok" && Number.isInteger(held.data.pid) && held.data.pid > 0 && typeof held.data.token === "string" && held.data.token))
      return { ok: false, reason: "lock-damaged" };
    let dead = false;
    try { process.kill(held.data.pid, 0); } catch (e) { dead = !!(e && e.code === "ESRCH"); }
    if (!dead) return { ok: false, reason: "lock-busy" };
    const grave = lockFile + ".reclaim." + process.pid + "." + token;
    try { fs.renameSync(lockFile, grave); } catch { return { ok: false, reason: "lock-busy" }; }
    const moved = readJson3(grave);
    if (!(moved.st === "ok" && moved.data.pid === held.data.pid && moved.data.token === held.data.token)) {
      try { fs.renameSync(grave, lockFile); } catch { /* 감사 흔적 보존 */ }
      return { ok: false, reason: "lock-lost" };
    }
    try { fs.unlinkSync(grave); } catch { /* 격리 흔적 무해 */ }
    try { fs.writeFileSync(lockFile, JSON.stringify(mine), { flag: "wx" }); } catch { return { ok: false, reason: "lock-busy" }; }
  }
  const fence = () => {
    const r = readJson3(lockFile);
    return r.st === "ok" && r.data.pid === process.pid && r.data.token === token;
  };
  if (!fence()) return { ok: false, reason: "lock-lost" };
  try { return { ok: true, result: fn(fence) }; }
  finally { try { if (fence()) fs.unlinkSync(lockFile); } catch { /* 외부 잠금 삭제 금지 */ } }
}

function pendingRecordsFor(repo, mapId) {
  let names;
  const dir = MP.dirsFor(repo, mapId).pending;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); }
  catch (e) { return e && e.code === "ENOENT" ? { st: "ok", records: [] } : { st: "error", error: "pending 서랍 판독 실패" }; }
  const records = [];
  for (const name of names) {
    const r = readJson3(path.join(dir, name));
    if (r.st !== "ok") return { st: "error", error: "pending 손상(" + name + ": " + r.st + ")" };
    const rec = r.data;
    if (rec.schema !== "map-pending-v2" || !rec.patch || name !== rec.patch.patchId + ".json")
      return { st: "error", error: "pending 형식/파일명 위반(" + name + ")" };
    if (!["proposed", "classified", "claimed", "resolved", "resolved-noop", "expired"].includes(rec.lifecycle))
      return { st: "error", error: "pending lifecycle 위반(" + name + ")" };
    const pe = PM.validatePatchV2(rec.patch);
    if (pe.length) return { st: "error", error: "pending patch 위반(" + name + "): " + pe[0] };
    if (rec.lifecycle === "classified" && (typeof rec.classifiedAt !== "string" || typeof rec.classification !== "string"))
      return { st: "error", error: "classified pending 표지 위반(" + name + ")" };
    if (rec.lifecycle === "claimed" && !(rec.claim && Number.isInteger(rec.claim.pid) && typeof rec.claim.token === "string" && typeof rec.claim.decisionId === "string"))
      return { st: "error", error: "claimed pending 표지 위반(" + name + ")" };
    records.push(rec);
  }
  return { st: "ok", records };
}

function specificityOf(policy) {
  return policy.scope === "entity" ? 3 : policy.scope === "subgraph" ? 2 : 1;
}

function targetSummary(topo, patch) {
  const ids = PM.targetIdsOfPatch(patch);
  const byId = new Map([...(topo.nodes || []), ...(topo.edges || [])].map((ent) => [ent.id, ent]));
  return {
    targetIds: ids,
    targetLabels: ids.map((id) => {
      const ent = byId.get(id);
      return ent && typeof ent.label === "string" ? ent.label : ent && typeof ent.notes === "string" ? ent.notes : id;
    }),
  };
}

function policySummary(stored) {
  const p = stored.rec;
  return {
    policyId: p.policyId,
    policyFp: stored.fp,
    scope: p.scope,
    ...(p.scopeTarget ? { scopeTarget: p.scopeTarget } : {}),
    predicateExpr: p.predicateExpr,
    predicateDescription: p.predicateDescription,
    chosenMeaning: p.chosenMeaning,
    ...(p.exclusions ? { exclusions: p.exclusions } : {}),
  };
}

function contextFor(repo, mapId) {
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return { ok: false, error: "topology 판독 실패(" + rt.st + ")" };
  if (rt.topo.mapId !== mapId) return { ok: false, error: "mapId 불일치" };
  const idx = MP.decisionIndexFor(repo, mapId);
  if (idx.st === "error") return { ok: false, error: idx.error };
  const pol = MP.policyStateFor(repo, mapId);
  if (pol.st !== "ok") return { ok: false, error: pol.error };
  const pending = pendingRecordsFor(repo, mapId);
  if (pending.st !== "ok") return { ok: false, error: pending.error };
  const ah = MP.authorityOf(PM.mapHashOf(rt.topo), idx).ah;
  return { ok: true, topo: rt.topo, idx, pol, pending: pending.records, ah, dch: PM.decisionContextHashOf(ah, pol.pfh) };
}

function derivePolicyConflictCards(ctx, cardIdFor) {
  const groups = new Map();
  for (const rec of ctx.pending) {
    if (rec.lifecycle !== "classified" || rec.classification !== "intent-choice") continue;
    const patch = rec.patch;
    if (patch.mapId !== ctx.topo.mapId || PM.isPolicyOpV2(patch.operation)) continue;
    const heads = matchingPolicyHeads(ctx, patch);
    if (!heads.length) continue;
    const maxSpecificity = specificityOf(heads[0].rec);
    const dispositions = new Set(heads.map((x) => x.rec.chosenMeaning.disposition));
    if (dispositions.size < 2) continue;
    const headPolicyIds = heads.map((x) => x.rec.policyId);
    const conflictKey = conflictKeyOf(headPolicyIds);
    let group = groups.get(conflictKey);
    if (!group) {
      group = {
        kind: "policy-conflict",
        cardId: cardIdFor(conflictKey),
        conflictKey,
        mapId: ctx.topo.mapId,
        headPolicyIds,
        policies: heads.map(policySummary),
        specificity: maxSpecificity,
        frontierHash: ctx.pol.pfh,
        decisionContextHash: ctx.dch,
        affectedPending: [],
      };
      groups.set(conflictKey, group);
    }
    const targets = targetSummary(ctx.topo, patch);
    group.affectedPending.push({
      patchId: patch.patchId,
      opHash: PM.opHashOf(patch),
      operation: patch.operation,
      ...targets,
      rationale: patch.rationale,
      ...(patch.provider ? { provider: patch.provider } : {}),
      baseDecisionContextHash: patch.baseDecisionContextHash,
      classifiedAt: rec.classifiedAt,
    });
  }
  return [...groups.values()].map((card) => ({
    ...card,
    affectedPending: card.affectedPending.sort((a, b) => a.patchId.localeCompare(b.patchId)),
  })).sort((a, b) => a.conflictKey.localeCompare(b.conflictKey));
}

function matchingPolicyHeads(ctx, patch) {
  const storedById = new Map((ctx.pol.policies || []).map((x) => [x.rec.policyId, x]));
  const matched = [];
  for (const leaf of ctx.pol.frontier || []) {
    const stored = storedById.get(leaf.policyId);
    const meaning = leaf && leaf.chosenMeaning;
    const disposition = meaning && typeof meaning === "object" ? meaning.disposition : null;
    if (!stored || (disposition !== "apply" && disposition !== "decline")) continue;
    if (MP.policyAppliesToPatch(leaf, patch, disposition, ctx.topo).ok) matched.push(stored);
  }
  if (!matched.length) return [];
  const maxSpecificity = Math.max(...matched.map((x) => specificityOf(x.rec)));
  return matched.filter((x) => specificityOf(x.rec) === maxSpecificity)
    .sort((a, b) => a.rec.policyId.localeCompare(b.rec.policyId));
}

function collectPolicyConflictCards(repo, mapId, opts) {
  if (!UUID_RE.test(String(mapId))) return { ok: false, error: "mapId 형식 위반" };
  const ctx = contextFor(repo, mapId);
  if (!ctx.ok) return ctx;
  const supplied = opts && opts.cardIdFor;
  const cardIdFor = typeof supplied === "function" ? supplied : () => crypto.randomUUID();
  try {
    const cards = derivePolicyConflictCards(ctx, (key) => {
      const id = cardIdFor(key);
      if (!UUID_RE.test(String(id))) throw new Error("cardId 생산자 형식 위반");
      return id;
    });
    return { ok: true, cards, frontierHash: ctx.pol.pfh, decisionContextHash: ctx.dch };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function collectIntentDashboard(repo, mapId, opts) {
  if (!UUID_RE.test(String(mapId))) return { ok: false, error: "mapId 형식 위반" };
  const ctx = contextFor(repo, mapId);
  if (!ctx.ok) return ctx;
  const supplied = opts && opts.cardIdFor;
  const cardIdFor = typeof supplied === "function" ? supplied : () => crypto.randomUUID();
  let conflicts;
  try { conflicts = derivePolicyConflictCards(ctx, cardIdFor); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  const information = ctx.pending.filter((rec) => rec.lifecycle === "classified" && rec.classification === "needs-investigation")
    .map((rec) => ({
      kind: "needs-investigation", patchId: rec.patch.patchId, operation: rec.patch.operation,
      ...targetSummary(ctx.topo, rec.patch), rationale: rec.patch.rationale, classifiedAt: rec.classifiedAt,
    })).sort((a, b) => a.patchId.localeCompare(b.patchId));
  const frontierById = new Set((ctx.pol.frontier || []).map((x) => x.policyId));
  const policies = (ctx.pol.policies || []).filter((x) => frontierById.has(x.rec.policyId)).map(policySummary)
    .sort((a, b) => a.policyId.localeCompare(b.policyId));
  const choiceRead = readConflictChoices(repo);
  const parkedChoiceItems = choiceRead.st === "ok" ? choiceRead.records.filter((x) => x.phase === "parked" && x.mapId === mapId)
    .map((x) => ({ cardId: x.cardId, conflictKey: x.conflictKey, parkedReason: x.parkedReason })) : [];
  const parkedChoices = choiceRead.st === "ok" ? parkedChoiceItems.length : null;
  const parkedDelegationItems = [];
  let parkedDelegations = 0, delegationDamaged = false;
  const ids = delegationOldPatchIds(repo);
  if (ids === null) delegationDamaged = true;
  else for (const id of ids) {
    const lr = readDelegationRecord(repo, id);
    if (lr.st !== "ok") { delegationDamaged = true; continue; }
    const last = lr.data.attempts[lr.data.attempts.length - 1];
    if (lr.data.mapId === mapId && last.phase === "parked") {
      parkedDelegations++;
      parkedDelegationItems.push({ oldPatchId: lr.data.oldPatchId, parkedReason: last.parkedReason });
    }
  }
  return {
    ok: true, mapId, conflictCards: conflicts, information, policies,
    policySummary: { activeLeafCount: policies.length, supersedingLeafCount: policies.filter((x) => {
      const stored = (ctx.pol.policies || []).find((p) => p.rec.policyId === x.policyId);
      return !!(stored && stored.rec.supersedesPolicyIds && stored.rec.supersedesPolicyIds.length);
    }).length },
    attention: { parkedChoices, parkedDelegations, parkedChoiceItems, parkedDelegationItems,
      damaged: choiceRead.st !== "ok" || delegationDamaged },
  };
}

function validateConflictChoiceRecord(rec, expectedFile) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "레코드 이형";
  const allowed = ["cardId", "conflictKey", "headPolicyIds", "frontierHashAtChoice", "dchAtChoice", "decision", "phase", "supersedePatchId", "expectedOpHash", "patchCanonical", "inheritancePolicyId", "chosenAt", "parkedReason", "outcome"];
  const unknown = Object.keys(rec).find((k) => !allowed.includes(k));
  if (unknown) return "미지 필드(" + unknown + ")";
  if (!UUID_RE.test(String(rec.cardId)) || !FP_RE.test(String(rec.conflictKey)) || !FP_RE.test(String(rec.frontierHashAtChoice)) || !FP_RE.test(String(rec.dchAtChoice))) return "식별자/지문";
  if (!Array.isArray(rec.headPolicyIds) || rec.headPolicyIds.length < 2 || rec.headPolicyIds.some((id) => !UUID_RE.test(String(id))) || new Set(rec.headPolicyIds).size !== rec.headPolicyIds.length || rec.headPolicyIds.some((id, i) => i > 0 && rec.headPolicyIds[i - 1] > id)) return "headPolicyIds";
  if (conflictKeyOf(rec.headPolicyIds) !== rec.conflictKey) return "conflictKey 결속";
  if (rec.decision !== "apply" && rec.decision !== "decline") return "decision";
  if (!CHOICE_PHASES.includes(rec.phase)) return "phase";
  if (!UUID_RE.test(String(rec.supersedePatchId)) || !FP_RE.test(String(rec.expectedOpHash)) || !UUID_RE.test(String(rec.inheritancePolicyId)) || !rec.headPolicyIds.includes(rec.inheritancePolicyId)) return "정책 교체 선기록";
  if (typeof rec.chosenAt !== "string" || !Number.isFinite(Date.parse(rec.chosenAt))) return "chosenAt";
  if (rec.phase === "parked" && (typeof rec.parkedReason !== "string" || !rec.parkedReason)) return "parkedReason";
  if (rec.parkedReason !== undefined && typeof rec.parkedReason !== "string") return "parkedReason";
  if (rec.outcome !== undefined) {
    if (!rec.outcome || typeof rec.outcome !== "object" || Array.isArray(rec.outcome) || Object.keys(rec.outcome).join(",") !== "appliedDecisionId" || !UUID_RE.test(String(rec.outcome.appliedDecisionId))) return "outcome";
  }
  const patch = rec.patchCanonical;
  const ve = PM.validatePatchV2(patch);
  if (ve.length) return "patchCanonical(" + ve[0] + ")";
  if (patch.patchId !== rec.supersedePatchId || PM.opHashOf(patch) !== rec.expectedOpHash || patch.operation !== "supersede_intent_policy") return "patch 선기록 지문 결속";
  if (PM.canonicalJsonOf(patch.targetPolicyIds) !== PM.canonicalJsonOf(rec.headPolicyIds)) return "patch 대상 결속";
  if (patch.baseDecisionContextHash !== rec.dchAtChoice || !patch.readSet || !patch.readSet.policies || patch.readSet.policies.frontierHash !== rec.frontierHashAtChoice) return "선택 시점 문맥 결속";
  if (patch.authorizationRefs.length !== 1 || patch.authorizationRefs[0].kind !== "user-choice" || patch.authorizationRefs[0].ref !== rec.cardId) return "cardId 권한 결속";
  const policy = patch.payload && patch.payload.policy;
  if (!policy || policy.policyId === rec.inheritancePolicyId || PM.canonicalJsonOf(policy.supersedesPolicyIds) !== PM.canonicalJsonOf(rec.headPolicyIds) || policy.chosenMeaning.disposition !== rec.decision) return "새 정책 결속";
  if (expectedFile && path.basename(expectedFile) !== rec.conflictKey + "-" + rec.cardId + ".json") return "파일명 결속";
  return null;
}

function readConflictChoices(repo) {
  const dir = intentDirFor(repo);
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); }
  catch (e) { return e && e.code === "ENOENT" ? { st: "ok", records: [] } : { st: "damaged", detail: "서랍 판독 실패" }; }
  const records = [];
  for (const name of names) {
    if (DIRECT_FILE_RE.test(name)) continue;
    if (!CONFLICT_FILE_RE.test(name)) return { st: "damaged", detail: "미지 파일(" + name + ")" };
    const file = path.join(dir, name);
    const r = readJson3(file);
    if (r.st !== "ok") return { st: "damaged", detail: "레코드 " + r.st + "(" + name + ")" };
    const ve = validateConflictChoiceRecord(r.data, file);
    if (ve) return { st: "damaged", detail: ve + "(" + name + ")" };
    records.push(r.data);
  }
  return { st: "ok", records };
}

function writeConflictChoice(repo, rec) {
  const file = conflictChoiceFileFor(repo, rec.conflictKey, rec.cardId);
  const ve = validateConflictChoiceRecord(rec, file);
  if (ve) return { ok: false, reason: "record-invalid", detail: ve };
  return CL.atomicWrite(file, JSON.stringify(rec, null, 1))
    ? { ok: true, record: rec }
    : { ok: false, reason: "write-failed" };
}

function pendingRecordFor(repo, mapId, patchId) {
  const r = readJson3(path.join(MP.dirsFor(repo, mapId).pending, patchId + ".json"));
  if (r.st !== "ok") return r;
  const rec = r.data;
  if (rec.schema !== "map-pending-v2" || !rec.patch || rec.patch.patchId !== patchId || PM.validatePatchV2(rec.patch).length)
    return { st: "invalid" };
  return { st: "ok", data: rec };
}

function completedConflictDecisionFor(repo, rec) {
  const policy = rec.patchCanonical && rec.patchCanonical.payload && rec.patchCanonical.payload.policy;
  const decisionId = policy && policy.createdFromDecision;
  if (!UUID_RE.test(String(decisionId))) return { ok: false, reason: "decision-id" };
  const dr = readJson3(path.join(repo, "project-map", "decisions", decisionId + ".json"));
  if (dr.st !== "ok") return { ok: false, reason: "decision-" + dr.st };
  const d = dr.data;
  if (PM.validateDecisionAny(d).length || d.decisionId !== decisionId || d.patchId !== rec.supersedePatchId
    || d.opHash !== rec.expectedOpHash || !d.actor || d.actor.kind !== "user-choice" || d.actor.cardId !== rec.cardId
    || !d.resolution || d.resolution.outcome !== "applied" || d.resolution.evidenceRef !== rec.cardId)
    return { ok: false, reason: "decision-mismatch" };
  const pr = readJson3(path.join(repo, "project-map", "policies", policy.policyId + ".json"));
  if (pr.st !== "ok" || PM.canonicalJsonOf(pr.data) !== PM.canonicalJsonOf(policy))
    return { ok: false, reason: "policy-mismatch" };
  return { ok: true, decisionId };
}

function currentConflictMatches(repo, mapId, rec) {
  const ctx = contextFor(repo, mapId);
  if (!ctx.ok) return { ok: false, reason: "context", detail: ctx.error };
  const card = derivePolicyConflictCards(ctx, () => rec.cardId).find((x) => x.conflictKey === rec.conflictKey);
  if (!card || PM.canonicalJsonOf(card.headPolicyIds) !== PM.canonicalJsonOf(rec.headPolicyIds)
    || card.frontierHash !== rec.frontierHashAtChoice || card.decisionContextHash !== rec.dchAtChoice)
    return { ok: false, reason: "stale-conflict" };
  return { ok: true, card };
}

function finishConflictChoice(repo, rec) {
  const done = completedConflictDecisionFor(repo, rec);
  if (!done.ok) return done;
  return writeConflictChoice(repo, { ...rec, phase: "done", outcome: { appliedDecisionId: done.decisionId } });
}

function parkConflictChoice(repo, rec, reason) {
  const wr = writeConflictChoice(repo, { ...rec, phase: "parked", parkedReason: String(reason || "적용 복구에 사람 판단 필요") });
  return wr.ok ? { ok: false, reason: "parked", recorded: true, record: wr.record } : wr;
}

function staleConflictChoice(repo, mapId, rec, reason) {
  const pending = pendingRecordFor(repo, mapId, rec.supersedePatchId);
  if (pending.st === "ok" && (pending.data.lifecycle === "proposed" || pending.data.lifecycle === "classified")) {
    const ex = MP.expirePendingPatch(repo, mapId, rec.supersedePatchId, rec.expectedOpHash, "superseded");
    if (!ex.ok && ex.reason !== "idempotent") return parkConflictChoice(repo, rec, "낡은 정책 제안 정리 실패: " + (ex.error || ex.reason));
  }
  const next = { ...rec, phase: "stale" };
  delete next.parkedReason;
  const wr = writeConflictChoice(repo, next);
  return wr.ok ? { ok: false, reason: "stale", detail: String(reason || "선택 뒤 정책 상태가 달라짐"), recorded: true, record: wr.record } : wr;
}

function recoverClaimedConflict(repo, mapId, rec, pending) {
  const decisionId = pending && pending.claim && pending.claim.decisionId;
  const activeFile = decisionId ? path.join(MP.dirsFor(repo, mapId).wal, decisionId + ".json") : null;
  if (!activeFile || !fs.existsSync(activeFile)) return { ok: true, action: "retry-apply" };
  const rows = MP.recoverWal(repo, mapId);
  const row = rows.find((x) => x.decisionId === decisionId);
  if (!row) return { ok: false, action: "park", reason: "활성 적용 기록의 복구 결과 부재" };
  if (row.verdict === "recovered") return { ok: true, action: "retry-apply" };
  if (row.verdict === "stale-expired" || row.verdict === "not-started") {
    const ab = MP.abortWal(repo, mapId, decisionId);
    return ab.ok ? { ok: true, action: "retry-apply" } : { ok: false, action: "park", reason: row.verdict + " 뒤 abort 실패: " + ab.error };
  }
  return { ok: false, action: "park", reason: "적용 기록 복구=" + row.verdict + ": " + row.reason };
}

function resumeConflictRecord(repo, mapId, rec, opts) {
  const o = opts || {};
  if (!threeTrackOn(repo, o)) return twoTrackResult();
  if (rec.phase === "done") return { ok: true, idempotent: true, record: rec };
  if (rec.phase === "stale") return { ok: false, reason: rec.phase, record: rec };
  if (rec.phase === "parked" && !o.explicitRetry) return { ok: false, reason: rec.phase, record: rec };

  const already = completedConflictDecisionFor(repo, rec);
  if (already.ok) return finishConflictChoice(repo, rec);

  if (rec.phase === "parked") {
    let parkedPending = pendingRecordFor(repo, mapId, rec.supersedePatchId);
    if (parkedPending.st === "ok" && (parkedPending.data.lifecycle === "resolved" || parkedPending.data.lifecycle === "resolved-noop"))
      return finishConflictChoice(repo, rec);
    if (parkedPending.st === "ok" && parkedPending.data.lifecycle === "expired")
      return staleConflictChoice(repo, mapId, rec, "보류된 정책 제안이 이미 종결되어 새 선택 세대가 필요함");
    if (parkedPending.st === "ok" && parkedPending.data.lifecycle === "claimed") {
      const recovered = recoverClaimedConflict(repo, mapId, rec, parkedPending.data);
      if (!recovered.ok) return { ok: false, reason: "parked-retry-blocked", detail: recovered.reason, record: rec };
      parkedPending = pendingRecordFor(repo, mapId, rec.supersedePatchId);
    }
    if (parkedPending.st !== "ok" && parkedPending.st !== "absent")
      return { ok: false, reason: "parked-retry-pending-" + parkedPending.st, record: rec };
    const unparked = { ...rec, phase: parkedPending.st === "absent" ? "chosen" : "patch-proposed" };
    delete unparked.parkedReason;
    const wr = writeConflictChoice(repo, unparked);
    if (!wr.ok) return wr;
    rec = wr.record;
  }

  if (rec.phase === "chosen") {
    const fresh = currentConflictMatches(repo, mapId, rec);
    if (!fresh.ok) return staleConflictChoice(repo, mapId, rec, fresh.reason);
    const proposed = MP.proposePatch(repo, rec.patchCanonical);
    if (!proposed.ok) return proposed.stage === "conflict"
      ? staleConflictChoice(repo, mapId, rec, "같은 정책 제안 ID의 다른 내용")
      : { ok: false, reason: "propose-" + (proposed.stage || "failed"), detail: (proposed.errors || []).join("; ") };
    const wr = writeConflictChoice(repo, { ...rec, phase: "patch-proposed" });
    if (!wr.ok || o.stopAfterPhase === "patch-proposed") return wr.ok ? { ok: true, stopped: true, record: wr.record } : wr;
    rec = wr.record;
  }

  let pending = pendingRecordFor(repo, mapId, rec.supersedePatchId);
  if (pending.st === "absent") {
    const proposed = MP.proposePatch(repo, rec.patchCanonical);
    if (!proposed.ok) return { ok: false, reason: "repropose-" + (proposed.stage || "failed") };
    pending = pendingRecordFor(repo, mapId, rec.supersedePatchId);
  }
  if (pending.st !== "ok" || PM.opHashOf(pending.data.patch) !== rec.expectedOpHash)
    return parkConflictChoice(repo, rec, "정책 pending 부재·손상 또는 내용 불일치");

  if (pending.data.lifecycle === "proposed") {
    const classified = MP.classifyPatch(repo, mapId, rec.supersedePatchId);
    if (!classified.ok) return { ok: false, reason: "classify-failed", detail: classified.error };
    pending = pendingRecordFor(repo, mapId, rec.supersedePatchId);
    if (o.stopAfterPhase === "classified") return { ok: true, stopped: true, record: rec };
  }
  if (pending.st !== "ok") return parkConflictChoice(repo, rec, "분류 뒤 pending 판독 실패");
  if (pending.data.lifecycle === "expired") return pending.data.expireCode === "cas-stale"
    ? staleConflictChoice(repo, mapId, rec, "정책 적용 기준이 낡음")
    : parkConflictChoice(repo, rec, "정책 제안 종결=" + String(pending.data.expireCode || "expired"));
  if (pending.data.lifecycle === "resolved" || pending.data.lifecycle === "resolved-noop") return finishConflictChoice(repo, rec);
  if (pending.data.lifecycle === "claimed") {
    const recovered = recoverClaimedConflict(repo, mapId, rec, pending.data);
    if (!recovered.ok) return parkConflictChoice(repo, rec, recovered.reason);
  }

  const fresh = currentConflictMatches(repo, mapId, rec);
  if (!fresh.ok) return staleConflictChoice(repo, mapId, rec, fresh.reason);
  const applied = MP.applyPatch(repo, mapId, rec.supersedePatchId, {
    ...(o.preCutover ? { preCutover: true } : {}), resolutionRef: rec.cardId,
  });
  if (applied.ok) return finishConflictChoice(repo, rec);
  if (applied.reasonCode === "already-applied") return finishConflictChoice(repo, rec);
  if (applied.reasonCode === "wal-active" || applied.reasonCode === "claim-busy" || applied.reasonCode === "lock" || applied.reasonCode === "write-failed")
    return { ok: false, reason: applied.reasonCode, retryable: true, detail: applied.error };
  if (applied.reasonCode === "cas-stale") return staleConflictChoice(repo, mapId, rec, applied.error);
  return parkConflictChoice(repo, rec, applied.error || applied.reasonCode || "정책 적용 실패");
}

function resumePolicyConflictChoice(repo, mapId, cardId, opts) {
  if (!UUID_RE.test(String(mapId)) || !UUID_RE.test(String(cardId))) return { ok: false, reason: "id-shape" };
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  const lk = CL.withFileLockStrict(path.join(intentDirFor(repo), ".choices.lock"), () => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    const all = readConflictChoices(repo);
    if (all.st !== "ok") return { ok: false, reason: "drawer-damaged", detail: all.detail };
    const rec = all.records.find((x) => x.cardId === cardId);
    if (!rec) return { ok: false, reason: "choice-absent" };
    return resumeConflictRecord(repo, mapId, rec, opts);
  });
  return lk.ok ? lk.result : { ok: false, reason: "choice-lock" };
}

function resumePolicyConflictChoices(repo, mapId, opts) {
  if (!threeTrackOn(repo, opts)) return { ...twoTrackResult(), results: [] };
  const all = readConflictChoices(repo);
  if (all.st !== "ok") return { ok: false, reason: "drawer-damaged", detail: all.detail, results: [] };
  const results = [];
  for (const rec of all.records.filter((x) => x.phase !== "done" && x.phase !== "stale"
    && (x.phase !== "parked" || (opts && opts.explicitRetry)))) {
    try { results.push({ cardId: rec.cardId, ...resumePolicyConflictChoice(repo, mapId, rec.cardId, opts) }); }
    catch (e) { results.push({ cardId: rec.cardId, ok: false, reason: "exception", detail: String(e && e.message || e) }); }
  }
  return { ok: results.every((x) => x.ok), results };
}

function validateDelegationAttempt(attempt, mapId) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return "attempt 이형";
  const allowed = ["policyId", "policyFp", "replacementPatchId", "expectedOpHash", "patchCanonical", "dchAtStart", "phase", "startedAt", "outcome", "parkedReason"];
  const unknown = Object.keys(attempt).find((k) => !allowed.includes(k));
  if (unknown) return "attempt 미지 필드(" + unknown + ")";
  if (!UUID_RE.test(String(attempt.policyId)) || !FP_RE.test(String(attempt.policyFp))
    || !UUID_RE.test(String(attempt.replacementPatchId)) || !FP_RE.test(String(attempt.expectedOpHash))
    || !FP_RE.test(String(attempt.dchAtStart))) return "attempt 식별자/지문";
  if (!DELEGATION_PHASES.includes(attempt.phase)) return "attempt phase";
  if (typeof attempt.startedAt !== "string" || !Number.isFinite(Date.parse(attempt.startedAt))) return "attempt startedAt";
  if (attempt.phase === "parked" && (typeof attempt.parkedReason !== "string" || !attempt.parkedReason)) return "attempt parkedReason";
  if (attempt.parkedReason !== undefined && typeof attempt.parkedReason !== "string") return "attempt parkedReason";
  if (attempt.outcome !== undefined) {
    if (!attempt.outcome || typeof attempt.outcome !== "object" || Array.isArray(attempt.outcome)
      || Object.keys(attempt.outcome).join(",") !== "appliedDecisionId" || !UUID_RE.test(String(attempt.outcome.appliedDecisionId))) return "attempt outcome";
  }
  const patch = attempt.patchCanonical;
  const ve = PM.validatePatchV2(patch);
  if (ve.length) return "attempt patchCanonical(" + ve[0] + ")";
  if (patch.mapId !== mapId || PM.isPolicyOpV2(patch.operation) || patch.patchId !== attempt.replacementPatchId
    || PM.opHashOf(patch) !== attempt.expectedOpHash || patch.baseDecisionContextHash !== attempt.dchAtStart) return "attempt patch 결속";
  const prs = patch.readSet && patch.readSet.policies;
  if (!prs || !Array.isArray(prs.refs) || !prs.refs.some((x) => x.policyId === attempt.policyId && x.policyFp === attempt.policyFp))
    return "attempt policy read-set 결속";
  return null;
}

function validateDelegationRecord(rec, expectedFile) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "위임 원장 이형";
  if (Object.keys(rec).sort().join(",") !== "attempts,mapId,oldOpHash,oldPatchId") return "위임 원장 필드";
  if (!UUID_RE.test(String(rec.oldPatchId)) || !UUID_RE.test(String(rec.mapId)) || !FP_RE.test(String(rec.oldOpHash))) return "위임 원장 식별자";
  if (!Array.isArray(rec.attempts) || rec.attempts.length < 1) return "위임 attempts";
  for (const attempt of rec.attempts) {
    const ae = validateDelegationAttempt(attempt, rec.mapId);
    if (ae) return ae;
  }
  const replacementIds = rec.attempts.map((x) => x.replacementPatchId);
  if (new Set(replacementIds).size !== replacementIds.length) return "위임 replacementPatchId 중복";
  if (expectedFile && path.basename(expectedFile) !== rec.oldPatchId + ".json") return "위임 파일명 결속";
  return null;
}

function readDelegationRecord(repo, oldPatchId) {
  const file = delegationFileFor(repo, oldPatchId);
  const r = readJson3(file);
  if (r.st !== "ok") return r;
  const ve = validateDelegationRecord(r.data, file);
  return ve ? { st: "invalid", detail: ve } : { st: "ok", data: r.data };
}

function writeDelegationRecord(repo, rec) {
  const file = delegationFileFor(repo, rec.oldPatchId);
  const ve = validateDelegationRecord(rec, file);
  if (ve) return { ok: false, reason: "ledger-invalid", detail: ve };
  return CL.atomicWrite(file, JSON.stringify(rec, null, 1))
    ? { ok: true, record: rec }
    : { ok: false, reason: "ledger-write" };
}

function replaceLastAttempt(repo, rec, next) {
  const attempts = rec.attempts.slice();
  attempts[attempts.length - 1] = next;
  return writeDelegationRecord(repo, { ...rec, attempts });
}

function delegatedDecisionFor(repo, rec, attempt) {
  const dir = path.join(repo, "project-map", "decisions");
  let names;
  try { names = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort(); }
  catch (e) { return e && e.code === "ENOENT" ? { ok: false, reason: "decision-absent" } : { ok: false, reason: "decision-unreadable" }; }
  const hits = [];
  for (const name of names) {
    const r = readJson3(path.join(dir, name));
    if (r.st !== "ok") continue;
    const d = r.data;
    if (d.patchId !== attempt.replacementPatchId) continue;
    if (name !== d.decisionId + ".json" || PM.validateDecisionAny(d).length) return { ok: false, reason: "decision-invalid" };
    hits.push(d);
  }
  if (hits.length !== 1) return { ok: false, reason: hits.length ? "decision-multiple" : "decision-absent" };
  const d = hits[0];
  if (d.mapId !== rec.mapId || d.opHash !== attempt.expectedOpHash || d.classification !== "auto"
    || !d.actor || d.actor.kind !== "user-choice-delegated" || d.actor.policyId !== attempt.policyId
    || !d.resolution || d.resolution.outcome !== "applied" || d.resolution.evidenceRef !== attempt.policyId)
    return { ok: false, reason: "decision-mismatch" };
  return { ok: true, decisionId: d.decisionId };
}

function buildDelegationPatch(repo, ctx, oldPatch, attemptIds, selected) {
  const draft = JSON.parse(JSON.stringify(oldPatch));
  draft.patchId = attemptIds.patchId;
  draft.basis = MP.patchBasisFor(repo, ctx.topo);
  draft.baseMapHash = PM.mapHashOf(ctx.topo);
  draft.baseAuthorityHash = ctx.ah;
  draft.baseDecisionContextHash = ctx.dch;
  draft.baseDirtyFp = "";
  draft.readSet = { policies: { refs: [{ policyId: selected.rec.policyId, policyFp: selected.fp }], frontierHash: ctx.pol.pfh } };
  draft.readSet = MP.buildReadSetFor(ctx.topo, draft, {
    idx: ctx.idx, pol: ctx.pol, repoRoot: repo,
    fileHashOf: (ref) => { try { return sha1(fs.readFileSync(path.isAbsolute(ref) ? ref : path.join(repo, ref))); } catch { return null; } },
  });
  const patch = PM.canonicalPatchV2(draft);
  const ve = PM.validatePatchV2(patch);
  if (ve.length) return { ok: false, reason: "replacement-invalid", detail: ve[0] };
  const prs = patch.readSet && patch.readSet.policies;
  if (!prs || prs.frontierHash !== ctx.pol.pfh || !prs.refs.some((x) => x.policyId === selected.rec.policyId && x.policyFp === selected.fp))
    return { ok: false, reason: "replacement-policy-unbound" };
  return { ok: true, patch };
}

function appendDelegationAttempt(repo, ctx, oldRec, selected, existing, opts) {
  const o = opts || {};
  if (existing) {
    if (existing.mapId !== ctx.topo.mapId || existing.oldPatchId !== oldRec.patch.patchId
      || existing.oldOpHash !== PM.opHashOf(oldRec.patch)) return { ok: false, reason: "ledger-old-mismatch" };
    const last = existing.attempts[existing.attempts.length - 1];
    if (!DELEGATION_PHASES.includes(last.phase)) return { ok: false, reason: "ledger-phase" };
    if (!['done', 'stale', 'parked'].includes(last.phase)) return { ok: true, idempotent: true, record: existing };
    if (last.phase === "parked" && !o.explicitRetry) return { ok: false, reason: "parked", record: existing };
  }
  const supplied = typeof o.idForAttempt === "function" ? o.idForAttempt(oldRec.patch.patchId, existing ? existing.attempts.length : 0) : null;
  const patchId = supplied && supplied.patchId ? supplied.patchId : crypto.randomUUID();
  if (!UUID_RE.test(String(patchId))) return { ok: false, reason: "id-producer" };
  const built = buildDelegationPatch(repo, ctx, oldRec.patch, { patchId }, selected);
  if (!built.ok) return built;
  const attempt = {
    policyId: selected.rec.policyId,
    policyFp: selected.fp,
    replacementPatchId: patchId,
    expectedOpHash: PM.opHashOf(built.patch),
    patchCanonical: built.patch,
    dchAtStart: ctx.dch,
    phase: "proposed",
    startedAt: new Date().toISOString(),
  };
  const rec = existing
    ? { ...existing, attempts: [...existing.attempts, attempt] }
    : { oldPatchId: oldRec.patch.patchId, oldOpHash: PM.opHashOf(oldRec.patch), mapId: ctx.topo.mapId, attempts: [attempt] };
  return writeDelegationRecord(repo, rec);
}

function parkDelegation(repo, rec, attempt, reason) {
  const wr = replaceLastAttempt(repo, rec, { ...attempt, phase: "parked", parkedReason: String(reason || "위임 전이 확인 필요") });
  return wr.ok ? { ok: false, reason: "parked", recorded: true, record: wr.record } : wr;
}

function staleDelegation(repo, rec, attempt, reason) {
  const next = { ...attempt, phase: "stale" };
  delete next.parkedReason;
  const wr = replaceLastAttempt(repo, rec, next);
  return wr.ok ? { ok: false, reason: "stale", detail: String(reason || "위임 전이 기준이 달라짐"), recorded: true, record: wr.record } : wr;
}

function recoverClaimedDelegation(repo, mapId, rec, attempt, pending) {
  const decisionId = pending && pending.claim && pending.claim.decisionId;
  const activeFile = decisionId ? path.join(MP.dirsFor(repo, mapId).wal, decisionId + ".json") : null;
  if (!activeFile || !fs.existsSync(activeFile)) return { ok: true, action: "retry-apply" };
  const rows = MP.recoverWal(repo, mapId);
  const row = rows.find((x) => x.decisionId === decisionId);
  if (!row) return { ok: false, reason: "활성 WAL 복구 결과 부재" };
  if (row.verdict === "recovered") return { ok: true, action: "reenter" };
  if (row.verdict === "stale-expired" || row.verdict === "not-started") {
    const ab = MP.abortWal(repo, mapId, decisionId);
    return ab.ok ? { ok: true, action: "retry-apply", recoveryVerdict: row.verdict } : { ok: false, reason: row.verdict + " 뒤 abort 실패: " + ab.error };
  }
  return { ok: false, reason: "WAL 복구=" + row.verdict + ": " + String(row.reason || "") };
}

function finishDelegation(repo, mapId, rec, attempt, decisionId) {
  let liveRec = rec, liveAttempt = attempt;
  if (liveAttempt.phase !== "applied") {
    const wr = replaceLastAttempt(repo, liveRec, { ...liveAttempt, phase: "applied", outcome: { appliedDecisionId: decisionId } });
    if (!wr.ok) return wr;
    liveRec = wr.record;
    liveAttempt = liveRec.attempts[liveRec.attempts.length - 1];
  }
  const old = pendingRecordFor(repo, mapId, liveRec.oldPatchId);
  if (old.st !== "ok") return parkDelegation(repo, liveRec, liveAttempt, "구 pending 판독 실패(" + old.st + ")");
  if (old.data.lifecycle !== "expired") {
    const ex = MP.expirePendingPatch(repo, mapId, liveRec.oldPatchId, liveRec.oldOpHash, "superseded");
    if (!ex.ok) {
      if (ex.reason === "busy" || ex.reason === "lock") return { ok: false, reason: ex.reason, retryable: true, record: liveRec };
      return parkDelegation(repo, liveRec, liveAttempt, "구 pending 종결 실패: " + (ex.error || ex.reason));
    }
  }
  const done = { ...liveAttempt, phase: "done", outcome: { appliedDecisionId: decisionId } };
  const wr2 = replaceLastAttempt(repo, liveRec, done);
  return wr2.ok ? { ok: true, record: wr2.record, decisionId } : wr2;
}

function resumeDelegationRecord(repo, mapId, rec, opts, fence) {
  const o = opts || {};
  if (!threeTrackOn(repo, o)) return twoTrackResult();
  let attempt = rec.attempts[rec.attempts.length - 1];
  if (attempt.phase === "done") return { ok: true, idempotent: true, record: rec };
  if (attempt.phase === "stale" || attempt.phase === "parked") return { ok: false, reason: attempt.phase, record: rec };
  if (!fence()) return { ok: false, reason: "lock-lost" };
  const completed = delegatedDecisionFor(repo, rec, attempt);
  if (completed.ok) return finishDelegation(repo, mapId, rec, attempt, completed.decisionId);
  if (completed.reason !== "decision-absent") return parkDelegation(repo, rec, attempt, completed.reason);
  if (attempt.phase === "applied") return parkDelegation(repo, rec, attempt, "applied 단계인데 decision 부재");

  let pending = pendingRecordFor(repo, mapId, attempt.replacementPatchId);
  if (pending.st === "absent") {
    if (!fence()) return { ok: false, reason: "lock-lost" };
    const pr = MP.proposePatch(repo, attempt.patchCanonical);
    if (!pr.ok) return pr.stage === "conflict" ? staleDelegation(repo, rec, attempt, "replacement patchId 내용 충돌")
      : { ok: false, reason: "propose-" + (pr.stage || "failed"), retryable: true };
    if (o.stopAfterPhase === "patch-proposed") return { ok: true, stopped: true, record: rec };
    pending = pendingRecordFor(repo, mapId, attempt.replacementPatchId);
  }
  if (pending.st !== "ok" || PM.opHashOf(pending.data.patch) !== attempt.expectedOpHash)
    return staleDelegation(repo, rec, attempt, "replacement pending 부재·손상 또는 내용 불일치");
  if (pending.data.lifecycle === "expired") return pending.data.expireCode === "cas-stale"
    ? staleDelegation(repo, rec, attempt, "replacement read-set이 낡음")
    : parkDelegation(repo, rec, attempt, "replacement 종결=" + String(pending.data.expireCode || "expired"));
  if (pending.data.lifecycle === "resolved" || pending.data.lifecycle === "resolved-noop") {
    const d2 = delegatedDecisionFor(repo, rec, attempt);
    return d2.ok ? finishDelegation(repo, mapId, rec, attempt, d2.decisionId) : parkDelegation(repo, rec, attempt, d2.reason);
  }
  if (pending.data.lifecycle === "proposed") {
    if (!fence()) return { ok: false, reason: "lock-lost" };
    const cf = MP.classifyPatch(repo, mapId, attempt.replacementPatchId);
    if (!cf.ok) return { ok: false, reason: "classify", retryable: true, detail: cf.error };
    if (o.stopAfterPhase === "classified") return { ok: true, stopped: true, record: rec };
    pending = pendingRecordFor(repo, mapId, attempt.replacementPatchId);
  }
  if (pending.st !== "ok") return parkDelegation(repo, rec, attempt, "분류 뒤 replacement 판독 실패");
  if (pending.data.lifecycle === "claimed") {
    const rr = recoverClaimedDelegation(repo, mapId, rec, attempt, pending.data);
    if (!rr.ok) return parkDelegation(repo, rec, attempt, rr.reason);
    pending = pendingRecordFor(repo, mapId, attempt.replacementPatchId);
    if (rr.action === "reenter" && pending.st === "ok" && (pending.data.lifecycle === "resolved" || pending.data.lifecycle === "resolved-noop")) {
      const d3 = delegatedDecisionFor(repo, rec, attempt);
      return d3.ok ? finishDelegation(repo, mapId, rec, attempt, d3.decisionId) : parkDelegation(repo, rec, attempt, d3.reason);
    }
  }
  if (!fence()) return { ok: false, reason: "lock-lost" };
  const applied = MP.applyPatch(repo, mapId, attempt.replacementPatchId, {
    ...(o.preCutover ? { preCutover: true } : {}), policyDelegation: { policyId: attempt.policyId, policyFp: attempt.policyFp },
  });
  if (applied.ok) {
    const wr = replaceLastAttempt(repo, rec, { ...attempt, phase: "applied", outcome: { appliedDecisionId: applied.decisionId } });
    if (!wr.ok || o.stopAfterPhase === "applied") return wr.ok ? { ok: true, stopped: true, record: wr.record } : wr;
    return finishDelegation(repo, mapId, wr.record, wr.record.attempts[wr.record.attempts.length - 1], applied.decisionId);
  }
  if (applied.reasonCode === "already-applied") {
    const d4 = delegatedDecisionFor(repo, rec, attempt);
    return d4.ok ? finishDelegation(repo, mapId, rec, attempt, d4.decisionId) : parkDelegation(repo, rec, attempt, d4.reason);
  }
  if (applied.reasonCode === "cas-stale") return staleDelegation(repo, rec, attempt, applied.error);
  if (["wal-active", "claim-busy", "lock", "write-failed"].includes(applied.reasonCode))
    return { ok: false, reason: applied.reasonCode, retryable: true, detail: applied.error, record: rec };
  return parkDelegation(repo, rec, attempt, applied.error || applied.reasonCode || "위임 적용 실패");
}

function driveDelegation(repo, mapId, oldPatchId, selected, opts) {
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  const lockFile = delegationFileFor(repo, oldPatchId).replace(/\.json$/, ".lock");
  const lk = withRecoverableTransitionLock(lockFile, (fence) => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    let lr = readDelegationRecord(repo, oldPatchId);
    if (lr.st === "invalid" || lr.st === "unreadable") return { ok: false, reason: "ledger-" + lr.st, detail: lr.detail };
    let rec = lr.st === "ok" ? lr.data : null;
    if (rec && rec.attempts[rec.attempts.length - 1].phase === "parked" && opts && opts.explicitRetry) {
      const prior = rec.attempts[rec.attempts.length - 1];
      const aw = MP.activePipelineWalFor(repo);
      if (aw.st === "unreadable") return { ok: false, reason: "wal-corrupt", record: rec };
      if (aw.st === "active") {
        const rows = MP.recoverWal(repo, mapId);
        const ownPending = pendingRecordFor(repo, mapId, prior.replacementPatchId);
        const ownDecisionId = ownPending.st === "ok" && ownPending.data.claim && ownPending.data.claim.decisionId;
        const ownRow = rows.find((x) => x.decisionId === ownDecisionId);
        if (ownRow && (ownRow.verdict === "conflict" || ownRow.verdict === "hard-reject"))
          return { ok: false, reason: "parked-retry-blocked", detail: ownRow.verdict + ": " + String(ownRow.reason || ""), record: rec };
        for (const row of rows.filter((x) => x.verdict === "stale-expired" || x.verdict === "not-started")) {
          const ab = MP.abortWal(repo, mapId, row.decisionId);
          if (!ab.ok) return { ok: false, reason: "parked-retry-abort", detail: ab.error, record: rec };
        }
        const after = MP.activePipelineWalFor(repo);
        if (after.st !== "none") return { ok: false, reason: "parked-retry-wal-active", record: rec };
        if (ownRow && ownRow.verdict === "recovered") {
          const dd = delegatedDecisionFor(repo, rec, prior);
          if (dd.ok) return finishDelegation(repo, mapId, rec, prior, dd.decisionId);
          return { ok: false, reason: "parked-retry-recovered-mismatch", detail: dd.reason, record: rec };
        }
        if (ownRow && (ownRow.verdict === "stale-expired" || ownRow.verdict === "not-started")) {
          const retried = MP.applyPatch(repo, mapId, prior.replacementPatchId, {
            ...(opts.preCutover ? { preCutover: true } : {}), policyDelegation: { policyId: prior.policyId, policyFp: prior.policyFp },
          });
          if (retried.ok) return finishDelegation(repo, mapId, rec, prior, retried.decisionId);
          if (retried.reasonCode === "already-applied") {
            const dd = delegatedDecisionFor(repo, rec, prior);
            return dd.ok ? finishDelegation(repo, mapId, rec, prior, dd.decisionId)
              : { ok: false, reason: "parked-retry-decision", detail: dd.reason, record: rec };
          }
          if (retried.reasonCode !== "cas-stale") return { ok: false, reason: "parked-retry-apply", detail: retried.error, record: rec };
          const st = staleDelegation(repo, rec, prior, retried.error);
          if (!st.record) return st;
          rec = st.record;
        }
      }
    }
    if (!rec || ["done", "stale"].includes(rec.attempts[rec.attempts.length - 1].phase)
      || (rec.attempts[rec.attempts.length - 1].phase === "parked" && opts && opts.explicitRetry)) {
      const ctx = contextFor(repo, mapId);
      if (!ctx.ok) return ctx;
      const old = ctx.pending.find((x) => x.patch.patchId === oldPatchId);
      if (!old || old.lifecycle !== "classified" || old.classification !== "intent-choice" || PM.isPolicyOpV2(old.patch.operation))
        return { ok: false, reason: "old-not-eligible" };
      const currentHeads = matchingPolicyHeads(ctx, old.patch);
      const current = currentHeads.find((x) => x.rec.policyId === selected.rec.policyId && x.fp === selected.fp);
      if (!current || new Set(currentHeads.map((x) => x.rec.chosenMeaning.disposition)).size !== 1
        || current.rec.chosenMeaning.disposition !== "apply") return { ok: false, reason: "policy-no-longer-selected" };
      const ap = appendDelegationAttempt(repo, ctx, old, current, rec, opts);
      if (!ap.ok) return ap;
      rec = ap.record;
      if (opts && opts.stopAfterPhase === "attempt-recorded") return { ok: true, stopped: true, record: rec };
    }
    return resumeDelegationRecord(repo, mapId, rec, opts, fence);
  });
  return lk.ok ? lk.result : { ok: false, reason: lk.reason || "transition-lock" };
}

function resumeDelegation(repo, mapId, oldPatchId, opts) {
  if (!UUID_RE.test(String(mapId)) || !UUID_RE.test(String(oldPatchId))) return { ok: false, reason: "id-shape" };
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  const lr = readDelegationRecord(repo, oldPatchId);
  if (lr.st !== "ok") return { ok: false, reason: "ledger-" + lr.st, detail: lr.detail };
  const lockFile = delegationFileFor(repo, oldPatchId).replace(/\.json$/, ".lock");
  const lk = withRecoverableTransitionLock(lockFile, (fence) => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    const latest = readDelegationRecord(repo, oldPatchId);
    return latest.st === "ok" ? resumeDelegationRecord(repo, mapId, latest.data, opts, fence)
      : { ok: false, reason: "ledger-" + latest.st, detail: latest.detail };
  });
  return lk.ok ? lk.result : { ok: false, reason: lk.reason || "transition-lock" };
}

function retryDelegation(repo, mapId, oldPatchId, opts) {
  if (!UUID_RE.test(String(mapId)) || !UUID_RE.test(String(oldPatchId))) return { ok: false, reason: "id-shape" };
  const o = { ...(opts || {}), explicitRetry: true };
  if (!threeTrackOn(repo, o)) return twoTrackResult();
  const ctx = contextFor(repo, mapId);
  if (!ctx.ok) return ctx;
  const old = ctx.pending.find((x) => x.patch.patchId === oldPatchId);
  if (!old || old.lifecycle !== "classified" || old.classification !== "intent-choice" || PM.isPolicyOpV2(old.patch.operation))
    return { ok: false, reason: "old-not-eligible" };
  const heads = matchingPolicyHeads(ctx, old.patch);
  const dispositions = new Set(heads.map((x) => x.rec.chosenMeaning.disposition));
  if (heads.length === 0 || dispositions.size !== 1 || heads[0].rec.chosenMeaning.disposition !== "apply")
    return { ok: false, reason: "policy-no-longer-selected" };
  return driveDelegation(repo, mapId, oldPatchId, heads[0], o);
}

function delegationOldPatchIds(repo) {
  try { return fs.readdirSync(delegationDirFor(repo)).filter((x) => UUID_RE.test(x.replace(/\.json$/, "")) && x.endsWith(".json")).map((x) => x.replace(/\.json$/, "")).sort(); }
  catch (e) { return e && e.code === "ENOENT" ? [] : null; }
}

function sweepIntentAuto(repo, mapId, opts) {
  const o = opts || {};
  if (!threeTrackOn(repo, o)) return { ok: true, outcome: "noop", reason: "two-track", scanned: 0, applied: 0, declined: 0, conflicts: 0, errors: 0, results: [] };
  const out = { ok: true, outcome: "done", scanned: 0, applied: 0, declined: 0, conflicts: 0, errors: 0, results: [] };
  const resumedChoices = resumePolicyConflictChoices(repo, mapId, o);
  for (const row of resumedChoices.results || []) if (!row.ok && row.reason !== "stale" && row.reason !== "parked") out.errors++;
  const ledgerIds = delegationOldPatchIds(repo);
  if (ledgerIds === null) out.errors++;
  else for (const oldPatchId of ledgerIds) {
    if (!threeTrackOn(repo, o)) { out.outcome = "two-track"; break; }
    const lr = readDelegationRecord(repo, oldPatchId);
    if (lr.st !== "ok") { out.errors++; out.results.push({ patchId: oldPatchId, action: "resume", ok: false, reason: "ledger-" + lr.st }); continue; }
    const last = lr.data.attempts[lr.data.attempts.length - 1];
    if (["done", "stale", "parked"].includes(last.phase)) continue;
    const rr = resumeDelegation(repo, mapId, oldPatchId, o);
    out.results.push({ patchId: oldPatchId, action: "resume", ...rr });
    if (!rr.ok && !rr.retryable) out.errors++;
  }
  const initial = contextFor(repo, mapId);
  if (!initial.ok) { out.ok = false; out.outcome = "error"; out.errors++; out.error = initial.error; }
  else {
    const ids = initial.pending.filter((x) => x.lifecycle === "classified" && x.classification === "intent-choice"
      && !PM.isPolicyOpV2(x.patch.operation)).map((x) => x.patch.patchId).sort();
    for (const patchId of ids) {
      try {
        if (!threeTrackOn(repo, o)) { out.outcome = "two-track"; break; }
        const ctx = contextFor(repo, mapId);
        if (!ctx.ok) { out.errors++; out.results.push({ patchId, action: "context", ok: false }); continue; }
        const old = ctx.pending.find((x) => x.patch.patchId === patchId);
        if (!old || old.lifecycle !== "classified" || old.classification !== "intent-choice") continue;
        out.scanned++;
        const heads = matchingPolicyHeads(ctx, old.patch);
        if (!heads.length) { out.results.push({ patchId, action: "none", ok: true }); continue; }
        const dispositions = new Set(heads.map((x) => x.rec.chosenMeaning.disposition));
        if (dispositions.size > 1) { out.conflicts++; out.results.push({ patchId, action: "conflict", ok: true, conflictKey: conflictKeyOf(heads.map((x) => x.rec.policyId)) }); continue; }
        const selected = heads[0];
        if (selected.rec.chosenMeaning.disposition === "decline") {
          if (!threeTrackOn(repo, o)) { out.outcome = "two-track"; break; }
          const ex = MP.expirePendingPatch(repo, mapId, patchId, PM.opHashOf(old.patch), "policy-declined");
          if (ex.ok) out.declined++; else out.errors++;
          out.results.push({ patchId, action: "decline", ...ex });
          continue;
        }
        const dr = driveDelegation(repo, mapId, patchId, selected, o);
        if (dr.ok && !dr.stopped) out.applied++;
        else if (!dr.ok && !dr.retryable && dr.reason !== "stale" && dr.reason !== "parked") out.errors++;
        out.results.push({ patchId, action: "apply", ...dr });
      } catch (e) {
        out.errors++;
        out.results.push({ patchId, action: "exception", ok: false, reason: String(e && e.message || e) });
      }
    }
  }
  out.ok = out.errors === 0;
  if (!out.ok) out.outcome = "partial";
  const line = "[map-intent] scanned=" + out.scanned + " applied=" + out.applied + " declined=" + out.declined + " conflicts=" + out.conflicts + " errors=" + out.errors;
  out.summary = line;
  try { if (typeof o.log === "function") o.log(line, out); } catch { /* 로그 실패는 전이 결과를 바꾸지 않음 */ }
  return out;
}

function pidIsDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return !!(e && e.code === "ESRCH"); }
}

function nsLockStateFor(repo, mapId) {
  let file;
  try { file = path.join(MP.dirsFor(repo, mapId).base, ".nslock"); }
  catch { return { state: "invalid-map" }; }
  const r = readJson3(file);
  if (r.st === "absent") return { state: "none", file };
  if (r.st !== "ok" || !Number.isInteger(r.data.pid) || r.data.pid <= 0 || typeof r.data.token !== "string" || !r.data.token)
    return { state: "damaged", file };
  return { state: pidIsDead(r.data.pid) ? "dead" : "active", file, pid: r.data.pid };
}

function recoveryCandidatesFor(repo) {
  const found = new Map();
  const add = (mapId, source, meta) => {
    if (!UUID_RE.test(String(mapId))) return;
    const cur = found.get(mapId) || { mapId, sources: [], latestSnapshot: null };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (meta && (!cur.latestSnapshot || meta.appliedCount > cur.latestSnapshot.appliedCount
      || (meta.appliedCount === cur.latestSnapshot.appliedCount && meta.decisionId > cur.latestSnapshot.decisionId))) cur.latestSnapshot = meta;
    found.set(mapId, cur);
  };
  try {
    const dir = path.join(repo, "project-map", "decisions");
    for (const name of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const r = readJson3(path.join(dir, name));
      if (r.st === "ok" && !PM.validateDecisionAny(r.data).length && name === r.data.decisionId + ".json") add(r.data.mapId, "decision");
    }
  } catch { /* 다른 증거원 계속 */ }
  try {
    const root = MP.pipeRootFor(repo);
    for (const mapId of fs.readdirSync(root).filter((x) => UUID_RE.test(x))) {
      const dir = path.join(root, mapId, "snapshots");
      let names = [];
      try { names = fs.readdirSync(dir).filter((x) => x.endsWith(".json")); } catch { continue; }
      for (const name of names) {
        const r = readJson3(path.join(dir, name));
        const s = r.st === "ok" ? r.data : null;
        if (!s || s.mapId !== mapId || !UUID_RE.test(String(s.decisionId)) || !Number.isInteger(s.appliedCountAtSnapshot)
          || !s.topology || PM.validateTopology(s.topology).length || s.topology.mapId !== mapId) continue;
        let ts = null;
        try { ts = fs.statSync(path.join(dir, name)).mtime.toISOString(); } catch { /* 표시 생략 */ }
        add(mapId, "snapshot", { decisionId: s.decisionId, appliedCount: s.appliedCountAtSnapshot, ...(ts ? { ts } : {}) });
      }
    }
  } catch { /* 다른 증거원 계속 */ }
  try {
    const lg = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "rev-list", "-n", "20", "HEAD", "--", "project-map/topology.json"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const commits = lg.status === 0 ? String(lg.stdout || "").trim().split(/\r?\n/).filter(Boolean) : [];
    for (const cmt of commits) {
      const sh = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, "show", cmt + ":project-map/topology.json"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (sh.status !== 0 || !sh.stdout) continue;
      try { const topo = JSON.parse(sh.stdout); if (!PM.validateTopology(topo).length) add(topo.mapId, "git:" + cmt.slice(0, 8)); } catch { /* 다음 이력 */ }
    }
  } catch { /* 비-git */ }
  return [...found.values()].map((x) => ({ ...x, sources: x.sources.sort() })).sort((a, b) => a.mapId.localeCompare(b.mapId));
}

function recoveredFileState(repo, mapId) {
  const file = path.join(repo, "project-map", "topology.recovered.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { state: "none", file } : { state: "unreadable", file }; }
  let topo;
  try { topo = JSON.parse(raw); } catch { return { state: "invalid", file }; }
  const ve = PM.validateTopology(topo);
  if (ve.length || topo.mapId !== mapId) return { state: "invalid", file };
  return { state: "ready", file, hash: sha1(raw), mapId };
}

function topologyHealthFor(repo) {
  const rt = MR.readTopoExFor(repo);
  if (rt.st !== "ok") return rt;
  const errors = PM.validateTopology(rt.topo);
  return errors.length ? { st: "invalid", detail: errors[0], raw: rt.raw } : rt;
}

function recoveryPlanFileFor(repo) { return path.join(intentDirFor(repo), "topology-recovery.json"); }

function fileIdentityFor(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (e) {
    const value = { state: e && e.code === "ENOENT" ? "absent" : "unreadable" };
    return { value, fp: sha1(PM.canonicalJsonOf(value)) };
  }
  try {
    const raw = fs.readFileSync(file);
    const value = { state: "readable", hash: sha1(raw), size: raw.length };
    return { value, fp: sha1(PM.canonicalJsonOf(value)) };
  } catch {
    const value = { state: "unreadable", size: stat.size, mtimeMs: stat.mtimeMs };
    return { value, fp: sha1(PM.canonicalJsonOf(value)) };
  }
}

function topologyIdentityFor(repo) { return fileIdentityFor(path.join(repo, "project-map", "topology.json")); }

function validateRecoveryPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.schema !== RECOVERY_PLAN_SCHEMA) return "plan-shape";
  const base = ["candidate", "candidateFp", "mapId", "nonce", "original", "originalFp", "phase", "planId",
    "preparedAt", "recoveredFile", "recoveredHash", "schema", "source"];
  const expected = plan.phase === "replacing" ? [...base, "backupName"].sort() : base.sort();
  if (Object.keys(plan).sort().join(",") !== expected.join(",")) return "plan-fields";
  if (!UUID_RE.test(String(plan.planId)) || !UUID_RE.test(String(plan.mapId)) || !NONCE_RE.test(String(plan.nonce))
    || !FP_RE.test(String(plan.originalFp)) || !FP_RE.test(String(plan.candidateFp)) || !FP_RE.test(String(plan.recoveredHash))) return "plan-ids";
  if (plan.phase !== "prepared" && plan.phase !== "replacing") return "plan-phase";
  if (typeof plan.preparedAt !== "string" || !Number.isFinite(Date.parse(plan.preparedAt))
    || plan.recoveredFile !== "topology.recovered.json" || typeof plan.source !== "string" || !plan.source) return "plan-metadata";
  if (!plan.original || typeof plan.original !== "object" || Array.isArray(plan.original)
    || sha1(PM.canonicalJsonOf(plan.original)) !== plan.originalFp) return "plan-original";
  const cand = plan.candidate;
  if (!cand || typeof cand !== "object" || Array.isArray(cand) || cand.mapId !== plan.mapId || !Array.isArray(cand.sources)
    || cand.sources.some((x) => typeof x !== "string") || sha1(PM.canonicalJsonOf(cand)) !== plan.candidateFp) return "plan-candidate";
  const sourceBound = cand.sources.includes(plan.source)
    || (plan.source.startsWith("snapshot:") && cand.sources.includes("snapshot") && cand.latestSnapshot
      && plan.source === "snapshot:" + cand.latestSnapshot.decisionId);
  if (!sourceBound) return "plan-source";
  if (plan.phase === "replacing" && (typeof plan.backupName !== "string" || !RECOVERY_BACKUP_RE.test(plan.backupName))) return "plan-backup";
  return null;
}

function readRecoveryPlan(repo) {
  const r = readJson3(recoveryPlanFileFor(repo));
  if (r.st !== "ok") return r;
  const error = validateRecoveryPlan(r.data);
  return error ? { st: "invalid", detail: error } : { st: "ok", data: r.data };
}

function writeRecoveryPlan(repo, plan) {
  const error = validateRecoveryPlan(plan);
  if (error) return { ok: false, reason: "plan-invalid", detail: error };
  return CL.atomicWrite(recoveryPlanFileFor(repo), JSON.stringify(plan, null, 1))
    ? { ok: true, plan }
    : { ok: false, reason: "plan-write" };
}

function removeRecoveryPlan(repo) {
  try { fs.unlinkSync(recoveryPlanFileFor(repo)); return true; }
  catch (e) { return !!(e && e.code === "ENOENT"); }
}

function preparedRecoveryView(repo) {
  const pr = readRecoveryPlan(repo);
  if (pr.st !== "ok" || pr.data.phase !== "prepared") return { state: pr.st === "ok" ? pr.data.phase : pr.st, detail: pr.detail };
  const plan = pr.data;
  const original = topologyIdentityFor(repo);
  const ready = recoveredFileState(repo, plan.mapId);
  if (original.fp !== plan.originalFp) return { state: "original-changed", planId: plan.planId };
  if (ready.state !== "ready" || ready.hash !== plan.recoveredHash) return { state: "recovered-changed", planId: plan.planId };
  return { state: "ready", mapId: plan.mapId, hash: plan.recoveredHash, planId: plan.planId, nonce: plan.nonce,
    candidateFp: plan.candidateFp, file: ready.file };
}

function convergeRecoveryTransition(repo, opts) {
  if (!threeTrackOn(repo, opts)) return { ok: true, outcome: "noop", reason: "two-track" };
  const first = readRecoveryPlan(repo);
  if (first.st === "absent") return { ok: true, outcome: "none" };
  if (first.st !== "ok") return { ok: false, reason: "recovery-plan-" + first.st, detail: first.detail };
  if (first.data.phase !== "replacing") return { ok: true, outcome: "prepared" };
  const lock = MR.withMapLock(repo, () => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    const reread = readRecoveryPlan(repo);
    if (reread.st !== "ok") return { ok: false, reason: "recovery-plan-" + reread.st, detail: reread.detail };
    const plan = reread.data;
    if (plan.phase !== "replacing") return { ok: true, outcome: "prepared" };
    const topoFile = path.join(repo, "project-map", "topology.json");
    const recoveredFile = path.join(repo, "project-map", plan.recoveredFile);
    const backup = path.join(repo, "project-map", plan.backupName);
    const topoIdentity = topologyIdentityFor(repo);
    const topoNow = topologyHealthFor(repo);
    if (topoNow.st === "ok" && topoNow.topo.mapId === plan.mapId && topoIdentity.value.hash === plan.recoveredHash) {
      const cleaned = removeRecoveryPlan(repo);
      return { ok: true, outcome: "completed", mapId: plan.mapId, backup, cleanupPending: !cleaned };
    }
    if (topoIdentity.fp === plan.originalFp) {
      const reset = { ...plan, phase: "prepared" };
      delete reset.backupName;
      const wr = writeRecoveryPlan(repo, reset);
      return wr.ok ? { ok: true, outcome: "prepared" } : wr;
    }
    const backupIdentity = fileIdentityFor(backup);
    if (topoIdentity.value.state === "absent" && backupIdentity.fp === plan.originalFp) {
      const ready = recoveredFileState(repo, plan.mapId);
      if (ready.state === "ready" && ready.hash === plan.recoveredHash) {
        try {
          fs.renameSync(recoveredFile, topoFile);
          const final = topologyHealthFor(repo);
          if (final.st !== "ok" || final.topo.mapId !== plan.mapId) throw new Error("복구 전이 재검증 실패");
          const cleaned = removeRecoveryPlan(repo);
          return { ok: true, outcome: "completed", mapId: plan.mapId, backup, cleanupPending: !cleaned };
        } catch (e) {
          if (!fs.existsSync(topoFile) && fs.existsSync(backup)) { try { fs.renameSync(backup, topoFile); } catch { /* fail-visible below */ } }
          return { ok: false, reason: "transition-resume-failed", detail: String(e && e.message || e) };
        }
      }
      try {
        fs.renameSync(backup, topoFile);
        removeRecoveryPlan(repo);
        return { ok: true, outcome: "rolled-back" };
      } catch (e) { return { ok: false, reason: "transition-rollback-failed", detail: String(e && e.message || e) }; }
    }
    return { ok: false, reason: "transition-state-mismatch" };
  });
  return lock.ok ? lock.result : { ok: false, reason: "map-lock", detail: lock.error };
}

function collectRecoveryState(repo, opts) {
  const transition = convergeRecoveryTransition(repo, opts);
  const rt = topologyHealthFor(repo);
  if (rt.st === "absent") return { ok: true, needed: false, topologyState: "absent", reason: "bootstrap-required", candidates: [], transition };
  if (rt.st === "ok") {
    const lock = nsLockStateFor(repo, rt.topo.mapId);
    if (lock.state === "none") return { ok: true, needed: false, topologyState: "ok", mapId: rt.topo.mapId, lock, transition };
    return { ok: true, needed: true, kind: "pipeline-lock", topologyState: "ok", mapId: rt.topo.mapId, lock, transition };
  }
  if (rt.st !== "unreadable" && rt.st !== "invalid") return { ok: false, error: "topology 상태 판독 실패(" + rt.st + ")" };
  const candidates = recoveryCandidatesFor(repo);
  const chosen = candidates.length === 1 ? candidates[0].mapId : null;
  const prepared = preparedRecoveryView(repo);
  return {
    ok: true, needed: true, kind: "topology-corruption", topologyState: rt.st, candidates,
    ...(chosen ? { mapId: chosen, recovered: recoveredFileState(repo, chosen), lock: nsLockStateFor(repo, chosen) } : {}),
    ...(prepared.state === "ready" ? { prepared } : { recoveryPlanState: prepared.state }),
    ...(!transition.ok ? { transitionError: transition.reason } : {}),
    ...(candidates.length === 0 ? { reason: "no-recovery-source" } : {}),
  };
}

function prepareTopologyRecovery(repo, mapId, opts) {
  if (!UUID_RE.test(String(mapId))) return { ok: false, reason: "map-id" };
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  const converged = convergeRecoveryTransition(repo, opts);
  if (!converged.ok) return converged;
  const lock = MR.withMapLock(repo, () => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    const rt = topologyHealthFor(repo);
    if (rt.st !== "unreadable" && rt.st !== "invalid") return { ok: false, reason: "not-corrupt", detail: rt.st };
    const candidates = recoveryCandidatesFor(repo);
    const candidate = candidates.find((x) => x.mapId === mapId);
    if (!candidate) return { ok: false, reason: "candidate-stale" };
    const original = topologyIdentityFor(repo);
    let made;
    try { made = MP.recoverCorruption(repo, mapId); }
    catch (e) { return { ok: false, reason: "recover-exception", detail: String(e && e.message || e) }; }
    if (!made.ok) return { ok: false, reason: "recover-failed", detail: made.error };
    const ready = recoveredFileState(repo, mapId);
    if (ready.state !== "ready" || path.resolve(made.out) !== path.resolve(ready.file)) return { ok: false, reason: "recovered-invalid" };
    const plan = {
      schema: RECOVERY_PLAN_SCHEMA, planId: crypto.randomUUID(), nonce: crypto.randomBytes(16).toString("hex"), mapId,
      phase: "prepared", preparedAt: new Date().toISOString(), original: original.value, originalFp: original.fp,
      candidate, candidateFp: sha1(PM.canonicalJsonOf(candidate)), source: made.source,
      recoveredHash: ready.hash, recoveredFile: path.basename(ready.file),
    };
    const wr = writeRecoveryPlan(repo, plan);
    if (!wr.ok) { try { fs.unlinkSync(ready.file); } catch { /* 결속 없는 복구본은 확인 경로에 노출하지 않음 */ } return wr; }
    return { ok: true, stage: "prepared", mapId, source: made.source, recoveredFile: ready.file,
      recoveredHash: ready.hash, planId: plan.planId, nonce: plan.nonce, candidateFp: plan.candidateFp, note: made.note };
  });
  return lock.ok ? lock.result : { ok: false, reason: "map-lock", detail: lock.error };
}

function recoveryBackupName(repo) {
  const dir = path.join(repo, "project-map");
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let file = path.join(dir, "topology.corrupt-" + stamp + ".json"), n = 0;
  while (fs.existsSync(file)) file = path.join(dir, "topology.corrupt-" + stamp + "-" + (++n) + ".json");
  return file;
}

function confirmTopologyRecovery(repo, mapId, confirmation, opts) {
  if (!UUID_RE.test(String(mapId)) || !confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)
    || Object.keys(confirmation).sort().join(",") !== "nonce,planId,recoveredHash"
    || !UUID_RE.test(String(confirmation.planId)) || !NONCE_RE.test(String(confirmation.nonce))
    || !FP_RE.test(String(confirmation.recoveredHash))) return { ok: false, reason: "confirmation-shape" };
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  const beforePlan = readRecoveryPlan(repo);
  if (beforePlan.st !== "ok" || beforePlan.data.phase !== "prepared") return { ok: false, reason: "plan-not-prepared", detail: beforePlan.st };
  if (beforePlan.data.mapId !== mapId || beforePlan.data.planId !== confirmation.planId || beforePlan.data.nonce !== confirmation.nonce
    || beforePlan.data.recoveredHash !== confirmation.recoveredHash) return { ok: false, reason: "confirmation-mismatch" };
  if (topologyIdentityFor(repo).fp !== beforePlan.data.originalFp) return { ok: false, reason: "original-changed" };
  const ready = recoveredFileState(repo, mapId);
  if (ready.state !== "ready" || ready.hash !== confirmation.recoveredHash) return { ok: false, reason: "recovered-changed", detail: ready.state };
  const topoFile = path.join(repo, "project-map", "topology.json");
  const recoveredFile = ready.file;
  const lock = MR.withMapLock(repo, () => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    const pr = readRecoveryPlan(repo);
    if (pr.st !== "ok" || pr.data.phase !== "prepared") return { ok: false, reason: "plan-not-prepared", detail: pr.st };
    const plan = pr.data;
    if (plan.mapId !== mapId || plan.planId !== confirmation.planId || plan.nonce !== confirmation.nonce
      || plan.recoveredHash !== confirmation.recoveredHash) return { ok: false, reason: "confirmation-mismatch" };
    const again = topologyHealthFor(repo);
    if (again.st !== "unreadable" && again.st !== "invalid") return { ok: false, reason: "topology-changed" };
    if (topologyIdentityFor(repo).fp !== plan.originalFp) return { ok: false, reason: "original-changed" };
    const r2 = recoveredFileState(repo, mapId);
    if (r2.state !== "ready" || r2.hash !== confirmation.recoveredHash) return { ok: false, reason: "recovered-changed" };
    const backup = recoveryBackupName(repo);
    const replacing = { ...plan, phase: "replacing", backupName: path.basename(backup) };
    const planWrite = writeRecoveryPlan(repo, replacing);
    if (!planWrite.ok) return planWrite;
    if (opts && opts.stopAfterPhase === "plan-recorded") return { ok: true, stopped: true, stage: "plan-recorded", plan: replacing };
    let movedOriginal = false, movedRecovered = false;
    try {
      fs.renameSync(topoFile, backup); movedOriginal = true;
      if (opts && opts.stopAfterPhase === "original-backed-up")
        return { ok: true, stopped: true, stage: "original-backed-up", mapId, backup, topologyFile: topoFile };
      fs.renameSync(recoveredFile, topoFile); movedRecovered = true;
      if (opts && opts.stopAfterPhase === "topology-installed")
        return { ok: true, stopped: true, stage: "topology-installed", mapId, backup, topologyFile: topoFile };
      const final = topologyHealthFor(repo);
      if (final.st !== "ok" || final.topo.mapId !== mapId) throw new Error("교체본 재검증 실패");
      const cleaned = removeRecoveryPlan(repo);
      return { ok: true, stage: "confirmed", mapId, backup, topologyFile: topoFile, cleanupPending: !cleaned };
    } catch (e) {
      if (movedRecovered) { try { fs.renameSync(topoFile, recoveredFile); } catch { /* 원복 증거 보존 */ } }
      if (movedOriginal && !fs.existsSync(topoFile)) { try { fs.renameSync(backup, topoFile); } catch { /* 실패를 반환 */ } }
      if (topologyIdentityFor(repo).fp === plan.originalFp && recoveredFileState(repo, mapId).state === "ready") {
        const reset = { ...plan, phase: "prepared" };
        delete reset.backupName;
        writeRecoveryPlan(repo, reset);
      }
      return { ok: false, reason: "replace-failed", detail: String(e && e.message || e), backup: fs.existsSync(backup) ? backup : null };
    }
  });
  return lock.ok ? lock.result : { ok: false, reason: "map-lock", detail: lock.error };
}

function recoverDeadPipelineLock(repo, mapId, opts) {
  if (!UUID_RE.test(String(mapId))) return { ok: false, reason: "map-id" };
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  const before = nsLockStateFor(repo, mapId);
  if (before.state !== "dead") return { ok: false, reason: before.state === "none" ? "lock-absent" : "lock-not-dead", state: before.state };
  let gc;
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  try { gc = MP.pipelineGc(repo, mapId); } catch (e) { return { ok: false, reason: "gc-exception", detail: String(e && e.message || e) }; }
  const after = nsLockStateFor(repo, mapId);
  return gc.ok && gc.nsRecovered >= 1 && after.state === "none"
    ? { ok: true, recovered: 1, state: after.state }
    : { ok: false, reason: "gc-failed", detail: gc.error || gc.bindingsGcError, state: after.state };
}

function verificationBasisNow(repo, topo) {
  const basis = MP.patchBasisFor(repo, topo);
  return basis.kind === "git"
    ? { kind: "git", objectFormat: basis.oidFormat, head: basis.baseHead }
    : { kind: "historyless", basisFp: PM.structuralHashOf(topo), inventoryFp: PM.opHashOf(topo.inventory) };
}

function buildSupersedePatch(repo, ctx, card, decision, inheritancePolicyId, ids) {
  const baseStored = (ctx.pol.policies || []).find((x) => x.rec.policyId === inheritancePolicyId);
  if (!baseStored || !card.headPolicyIds.includes(inheritancePolicyId)) return { ok: false, reason: "inheritance-policy" };
  const base = baseStored.rec;
  const meaning = base.chosenMeaning;
  if (!meaning || typeof meaning !== "object" || meaning.version !== 1 || typeof meaning.opClass !== "string") return { ok: false, reason: "inheritance-meaning" };
  const policy = {
    policyId: ids.policyId,
    mapId: ctx.topo.mapId,
    scope: base.scope,
    ...(base.scopeTarget ? { scopeTarget: [...base.scopeTarget] } : {}),
    predicateExpr: JSON.parse(JSON.stringify(base.predicateExpr)),
    predicateDescription: base.predicateDescription + " [정책 충돌 선택: " + (decision === "apply" ? "적용" : "거부") + "]",
    chosenMeaning: { version: 1, disposition: decision, opClass: meaning.opClass },
    ...(base.exclusions ? { exclusions: [...base.exclusions] } : {}),
    createdFromDecision: ids.decisionId,
    verification: verificationBasisNow(repo, ctx.topo),
    supersedesPolicyIds: [...card.headPolicyIds],
    active: true,
  };
  const patch = {
    schema: "map-patch-v2",
    patchId: ids.patchId,
    mapId: ctx.topo.mapId,
    basis: MP.patchBasisFor(repo, ctx.topo),
    baseMapHash: PM.mapHashOf(ctx.topo),
    baseAuthorityHash: ctx.ah,
    baseDecisionContextHash: ctx.dch,
    baseDirtyFp: "",
    operation: "supersede_intent_policy",
    targetPolicyIds: [...card.headPolicyIds],
    payload: { policy },
    readSet: {},
    authorizationRefs: [{ kind: "user-choice", ref: card.cardId }],
    rationale: "사용자가 서로 충돌하는 정책의 새 의미를 선택함",
  };
  patch.readSet = MP.buildReadSetFor(ctx.topo, patch, { idx: ctx.idx, pol: ctx.pol, repoRoot: repo, fileHashOf: () => null });
  const canonical = PM.canonicalPatchV2(patch);
  const ve = PM.validatePatchV2(canonical);
  return ve.length ? { ok: false, reason: "patch-invalid:" + ve[0] } : { ok: true, patch: canonical };
}

function recordPolicyConflictChoice(repo, mapId, input, opts) {
  const card = input && input.card;
  const decision = input && input.decision;
  const inheritancePolicyId = input && input.inheritancePolicyId;
  if (!UUID_RE.test(String(mapId)) || !card || typeof card !== "object" || card.kind !== "policy-conflict" || card.mapId !== mapId
    || !UUID_RE.test(String(card.cardId)) || !FP_RE.test(String(card.conflictKey)) || !FP_RE.test(String(card.frontierHash))
    || !FP_RE.test(String(card.decisionContextHash)) || !Array.isArray(card.headPolicyIds)) return { ok: false, reason: "choice-shape" };
  if (decision !== "apply" && decision !== "decline") return { ok: false, reason: "decision" };
  if (!UUID_RE.test(String(inheritancePolicyId))) return { ok: false, reason: "inheritance-policy" };
  if (!threeTrackOn(repo, opts)) return twoTrackResult();
  try { fs.mkdirSync(intentDirFor(repo), { recursive: true }); } catch { return { ok: false, reason: "drawer" }; }
  const lock = CL.withFileLockStrict(path.join(intentDirFor(repo), ".choices.lock"), () => {
    if (!threeTrackOn(repo, opts)) return twoTrackResult();
    const old = readConflictChoices(repo);
    if (old.st !== "ok") return { ok: false, reason: "drawer-damaged", detail: old.detail };
    const sameFile = old.records.find((r) => r.conflictKey === card.conflictKey && r.cardId === card.cardId);
    if (sameFile) {
      if (sameFile.decision !== decision || sameFile.inheritancePolicyId !== inheritancePolicyId)
        return { ok: false, reason: "choice-conflict" };
      return { ok: true, idempotent: true, record: sameFile };
    }
    const latest = old.records.filter((r) => r.conflictKey === card.conflictKey)
      .sort((a, b) => (b.chosenAt + b.cardId).localeCompare(a.chosenAt + a.cardId))[0];
    if (latest && !["done", "stale", "parked"].includes(latest.phase)) return { ok: false, reason: "choice-in-progress", cardId: latest.cardId };
    // parked 해소는 활성 WAL 선행 검사까지 포함한 명시 재시도 계약이다. 그 상태표를 구현하기 전인 2B에서는
    // 새 세대를 조용히 열지 않고 닫아 둔다(다음 transition increment가 전용 retry 표면으로 연다).
    if (latest && latest.phase === "parked") return { ok: false, reason: "parked-retry-not-available", cardId: latest.cardId };
    const mapLock = MR.withMapLock(repo, () => {
      if (!threeTrackOn(repo, opts)) return twoTrackResult();
      const ctx = contextFor(repo, mapId);
      if (!ctx.ok) return ctx;
      const currentCards = derivePolicyConflictCards(ctx, () => crypto.randomUUID());
      const current = currentCards.find((x) => x.conflictKey === card.conflictKey);
      if (!current) return { ok: false, reason: "stale-conflict" };
      const headIds = Array.isArray(card.headPolicyIds) ? [...card.headPolicyIds] : [];
      if (PM.canonicalJsonOf(headIds) !== PM.canonicalJsonOf(current.headPolicyIds)
        || card.frontierHash !== current.frontierHash || card.decisionContextHash !== current.decisionContextHash)
        return { ok: false, reason: "stale-conflict" };
      if (!headIds.includes(inheritancePolicyId)) return { ok: false, reason: "inheritance-policy" };
      const ids = {
        policyId: opts && opts.policyId ? opts.policyId : crypto.randomUUID(),
        decisionId: opts && opts.decisionId ? opts.decisionId : crypto.randomUUID(),
        patchId: opts && opts.patchId ? opts.patchId : crypto.randomUUID(),
      };
      if (!UUID_RE.test(String(ids.policyId)) || !UUID_RE.test(String(ids.decisionId)) || !UUID_RE.test(String(ids.patchId))) return { ok: false, reason: "id-producer" };
      if (new Set(Object.values(ids)).size !== 3
        || (ctx.pol.policies || []).some((x) => x.rec.policyId === ids.policyId)
        || (ctx.pol.revocations || []).some((x) => x.rec.revocationId === ids.policyId)
        || fs.existsSync(path.join(repo, "project-map", "decisions", ids.decisionId + ".json"))
        || fs.existsSync(path.join(MP.dirsFor(repo, mapId).pending, ids.patchId + ".json"))) return { ok: false, reason: "id-collision" };
      const built = buildSupersedePatch(repo, ctx, { ...current, cardId: card.cardId }, decision, inheritancePolicyId, ids);
      if (!built.ok) return built;
      const record = {
        cardId: card.cardId,
        conflictKey: card.conflictKey,
        headPolicyIds: current.headPolicyIds,
        frontierHashAtChoice: current.frontierHash,
        dchAtChoice: current.decisionContextHash,
        decision,
        phase: "chosen",
        supersedePatchId: built.patch.patchId,
        expectedOpHash: PM.opHashOf(built.patch),
        patchCanonical: built.patch,
        inheritancePolicyId,
        chosenAt: new Date().toISOString(),
      };
      const ve = validateConflictChoiceRecord(record, conflictChoiceFileFor(repo, record.conflictKey, record.cardId));
      if (ve) return { ok: false, reason: "record-invalid", detail: ve };
      const recordFile = conflictChoiceFileFor(repo, record.conflictKey, record.cardId);
      if (fs.existsSync(recordFile)) return { ok: false, reason: "choice-file-race" };
      const wrote = CL.atomicWrite(recordFile, JSON.stringify(record, null, 1));
      return wrote ? { ok: true, record } : { ok: false, reason: "write-failed" };
    });
    return mapLock.ok ? mapLock.result : { ok: false, reason: "map-lock" };
  });
  return lock.ok ? lock.result : { ok: false, reason: "choice-lock" };
}

module.exports = {
  INTENT_DIR,
  CHOICE_PHASES,
  DELEGATION_PHASES,
  intentDirFor,
  conflictChoiceFileFor,
  delegationDirFor,
  delegationFileFor,
  conflictKeyOf,
  collectPolicyConflictCards,
  collectIntentDashboard,
  validateConflictChoiceRecord,
  readConflictChoices,
  recordPolicyConflictChoice,
  resumePolicyConflictChoice,
  resumePolicyConflictChoices,
  validateDelegationRecord,
  readDelegationRecord,
  resumeDelegation,
  retryDelegation,
  sweepIntentAuto,
  recoveryCandidatesFor,
  recoveryPlanFileFor,
  readRecoveryPlan,
  collectRecoveryState,
  prepareTopologyRecovery,
  confirmTopologyRecovery,
  convergeRecoveryTransition,
  recoverDeadPipelineLock,
};
