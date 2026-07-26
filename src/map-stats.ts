// P10 증분 1~2 — Project MAP 사용량·자동 실행 JSONL 집계와 현재 지도 상태 수집.
// 파일 I/O와 VS Code 의존은 주입 경계 밖에 둔다. 호출자는 실제 저장소와 현재 관찰값만 넘긴다.

const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX16_RE = /^[0-9a-f]{16}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const USAGE_KEYS = ["schema", "ts", "callId", "scope", "repoKey", "flow", "provider", "model", "tokenIn", "tokenOut", "charsIn", "charsOut", "runId", "jobKey", "jobRunId"];
const AUTO_KEYS: Record<string, string[]> = {
  "enrich-start": ["schema", "event", "ts", "repoKey", "runId", "jobKey", "jobRunId", "mapId", "mode", "trigger"],
  "enrich-run-terminal": ["schema", "event", "ts", "repoKey", "runId", "mapId", "mode", "trigger", "outcome", "reasonCode", "provider"],
  "enrich-job-terminal": ["schema", "event", "ts", "repoKey", "runId", "jobKey", "jobRunId", "mapId", "mode", "trigger", "outcome", "reasonCode", "provider", "baselineState", "everApplied", "unresolvedBaseItems", "activeDeferredItems", "deferredState"],
};
const FLOWS = new Set(["map-scout", "readiness", "map-enrich", "map-adjudicate"]);
const PROVIDERS = new Set(["claude", "deepseek", "codex"]);
const MODES = new Set(["self", "economy", "precision", "auto"]);
const TRIGGERS = new Set(["consent", "retry", "probe", "tick", "cli", "link", "unknown"]);
const OUTCOMES = new Set(["applied", "settled", "parked", "noop", "provider-failed", "busy", "error"]);
const REASONS = new Set(["none", "queue-damaged", "pipeline-blocked", "map-unavailable", "queue-stale", "deferred-damaged", "deferred-retry", "job-damaged", "policy-unavailable", "parked-existing", "consent-missing", "consent-stale", "mode-invalid", "already-enriched", "state-write-failed", "route-parked", "adapter-missing", "provider-call-failed", "provider-result-invalid", "lock-lost", "retry-exhausted", "resolution-pending", "apply-failed", "unknown"]);
const BASELINES = new Set(["current-job", "prior-terminal", "unavailable"]);
const DEFERRED = new Set(["clear", "pending", "damaged", "unknown"]);
const LEGACY_FLOW: Record<string, string> = {
  self: "map-scout", deepseek: "map-scout", codex: "map-scout",
  ping: "readiness", capability: "readiness", "codex-probe": "readiness",
  "enrich-self": "map-enrich", enrich: "map-enrich", "enrich-codex": "map-enrich",
  "enrich-adjudicate": "map-adjudicate",
};
const LEGACY_PROVIDER: Record<string, string> = {
  self: "claude", deepseek: "deepseek", codex: "codex", ping: "deepseek", capability: "deepseek", "codex-probe": "codex",
  "enrich-self": "claude", enrich: "deepseek", "enrich-codex": "codex", "enrich-adjudicate": "codex",
};

function objectOnly(v: any): v is Record<string, any> { return !!v && typeof v === "object" && !Array.isArray(v); }
function exactKeys(v: any, keys: string[]): boolean { return objectOnly(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k)); }
function safeInt(v: any): boolean { return Number.isSafeInteger(v) && v >= 0; }
function iso(v: any): boolean {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  try { return new Date(v).toISOString() === v; } catch { return false; }
}
function nullableId(v: any, re: RegExp): boolean { return v === null || (typeof v === "string" && re.test(v)); }
function displayModel(v: any): string | null {
  return typeof v === "string" && v.length >= 1 && v.length <= 100 && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
}

export function isScoutUsageV2(v: any): boolean {
  if (!exactKeys(v, USAGE_KEYS) || v.schema !== "scout-usage-v2" || !iso(v.ts) || !UUID_RE.test(String(v.callId || ""))) return false;
  if (!(v.scope === "project" || v.scope === "global") || !FLOWS.has(v.flow) || !PROVIDERS.has(v.provider)) return false;
  if (v.scope === "project" ? !HEX16_RE.test(String(v.repoKey || "")) : v.repoKey !== null) return false;
  if (!(v.model === null || displayModel(v.model) !== null)) return false;
  if (!((v.tokenIn === null && v.tokenOut === null) || (safeInt(v.tokenIn) && safeInt(v.tokenOut)))) return false;
  if (!((v.charsIn === null || safeInt(v.charsIn)) && (v.charsOut === null || safeInt(v.charsOut)))) return false;
  if (!nullableId(v.runId, UUID_RE) || !nullableId(v.jobKey, HEX40_RE) || !nullableId(v.jobRunId, HEX40_RE)) return false;
  return v.jobRunId === null || v.jobKey !== null;
}

export interface UsageCell {
  calls: number;
  tokenCoveredCalls: number;
  tokenIn: number;
  tokenOut: number;
  charsWithoutTokensIn: number;
  charsWithoutTokensOut: number;
  models: string[];
}
export interface MapUsageStats {
  byFlowProvider: Record<string, UsageCell>;
  globalReadinessByProvider: Record<string, UsageCell>;
  coverage: { validV2: number; legacyAttributed: number; legacyUnknownProject: number; excluded: number; future: number };
}
function emptyUsageCell(): UsageCell { return { calls: 0, tokenCoveredCalls: 0, tokenIn: 0, tokenOut: 0, charsWithoutTokensIn: 0, charsWithoutTokensOut: 0, models: [] }; }
function addUsage(out: Record<string, UsageCell>, key: string, row: any): void {
  const c = out[key] || (out[key] = emptyUsageCell());
  c.calls++;
  if (safeInt(row.tokenIn) && safeInt(row.tokenOut)) { c.tokenCoveredCalls++; c.tokenIn += row.tokenIn; c.tokenOut += row.tokenOut; }
  else { if (safeInt(row.charsIn)) c.charsWithoutTokensIn += row.charsIn; if (safeInt(row.charsOut)) c.charsWithoutTokensOut += row.charsOut; }
  if (typeof row.model === "string" && row.model && !c.models.includes(row.model)) c.models.push(row.model);
}

export function computeMapUsageStats(raw: string, now: number, repoKey: string, legacyWorkspace: string, normWs: (s: string) => string): MapUsageStats {
  const out: MapUsageStats = { byFlowProvider: {}, globalReadinessByProvider: {}, coverage: { validV2: 0, legacyAttributed: 0, legacyUnknownProject: 0, excluded: 0, future: 0 } };
  const cut = now - 28 * DAY, targetWs = normWs(legacyWorkspace || "");
  for (const ln of String(raw || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let v: any; try { v = JSON.parse(ln); } catch { out.coverage.excluded++; continue; }
    if (v?.schema === "scout-usage-v2" && v.scope === "project" && HEX16_RE.test(String(v.repoKey || "")) && v.repoKey !== repoKey) continue;
    const t = Date.parse(v?.ts || "");
    if (!Number.isFinite(t)) { out.coverage.excluded++; continue; }
    if (t > now) { out.coverage.future++; out.coverage.excluded++; continue; }
    if (t < cut) continue;
    if (v.schema === "scout-usage-v2") {
      if (!isScoutUsageV2(v)) { out.coverage.excluded++; continue; }
      out.coverage.validV2++;
      if (v.scope === "global") {
        if (v.flow === "readiness") addUsage(out.globalReadinessByProvider, v.provider, v);
        continue;
      }
      if (v.repoKey === repoKey) addUsage(out.byFlowProvider, v.flow + "|" + v.provider, v);
      continue;
    }
    const flow = LEGACY_FLOW[String(v.arm || "")], provider = LEGACY_PROVIDER[String(v.arm || "")];
    if (!flow || !provider) { out.coverage.excluded++; continue; }
    const workspace = typeof v.workspace === "string" ? v.workspace : "";
    const tokenPair = Number.isFinite(v.usageIn) && Number.isFinite(v.usageOut);
    const row = { tokenIn: tokenPair ? v.usageIn : null, tokenOut: tokenPair ? v.usageOut : null, charsIn: safeInt(v.pkgChars) ? v.pkgChars : null, charsOut: safeInt(v.mapChars) ? v.mapChars : null, model: displayModel(v.model) };
    if (flow === "readiness") { out.coverage.legacyAttributed++; addUsage(out.globalReadinessByProvider, provider, row); continue; }
    if (!workspace) { out.coverage.legacyUnknownProject++; continue; }
    if (normWs(workspace) === targetWs) { out.coverage.legacyAttributed++; addUsage(out.byFlowProvider, flow + "|" + provider, row); }
  }
  return out;
}

export function isMapAutomationV1(v: any): boolean {
  const keys = objectOnly(v) ? AUTO_KEYS[v.event] : undefined;
  if (!keys || !exactKeys(v, keys) || v.schema !== "map-automation-v1" || !iso(v.ts)) return false;
  if (!HEX16_RE.test(String(v.repoKey || "")) || !UUID_RE.test(String(v.runId || "")) || !UUID_RE.test(String(v.mapId || "")) || !MODES.has(v.mode) || !TRIGGERS.has(v.trigger)) return false;
  if (v.event === "enrich-start") return nullableId(v.jobKey, HEX40_RE) && nullableId(v.jobRunId, HEX40_RE) && (v.jobRunId === null || v.jobKey !== null);
  if (!OUTCOMES.has(v.outcome) || !REASONS.has(v.reasonCode) || !(v.provider === null || PROVIDERS.has(v.provider))) return false;
  if (v.event === "enrich-run-terminal") return true;
  if (!HEX40_RE.test(String(v.jobKey || "")) || !HEX40_RE.test(String(v.jobRunId || "")) || !BASELINES.has(v.baselineState) || !DEFERRED.has(v.deferredState)) return false;
  const validBase = v.baselineState === "current-job" || v.baselineState === "prior-terminal";
  if (validBase ? !(typeof v.everApplied === "boolean" && safeInt(v.unresolvedBaseItems)) : !(v.everApplied === null && v.unresolvedBaseItems === null && (v.deferredState === "unknown" || v.deferredState === "damaged"))) return false;
  if (v.deferredState === "clear" || v.deferredState === "pending") return validBase && safeInt(v.activeDeferredItems);
  return v.activeDeferredItems === null;
}

export type RunLockObservation = { state: "alive" | "dead" | "owner-unverified" | "absent" | "damaged" | "unreadable"; runId?: string | null };
export type MapActivityState = "applied" | "settled" | "awaiting" | "parked" | "provider-failed" | "error" | "interrupted" | "running" | "state-unknown" | "terminal-missing" | "busy" | "noop";
export interface MapAutomationStats {
  observedRuns: number;
  pairedRuns: number;
  runsByState: Record<string, number>;
  jobs: number;
  jobsByState: Record<string, number>;
  noopByReason: Record<string, number>;
  completion: { numerator: number; denominator: number; ratio: number | null };
  coverage: { validRows: number; validJobTerminals: number; startMissing: number; baselineMissing: number; jobGenerationUnknown: number; jobIdentityCollision: number; stateUnknown: number; terminalMissing: number; legacyRows: number; excluded: number; future: number };
}
type SeqRow = { seq: number; row: any };
function bump(rec: Record<string, number>, key: string): void { rec[key] = (rec[key] || 0) + 1; }
function missingRunState(runId: string, lock: RunLockObservation): MapActivityState {
  const same = !!lock && lock.runId === runId;
  if (same && lock.state === "alive") return "running";
  if (same && lock.state === "dead") return "interrupted";
  if (lock && (lock.state === "owner-unverified" || lock.state === "damaged" || lock.state === "unreadable")) return "state-unknown";
  // 잠금 부재·다른 runId만으로는 정상 종료 직전 마지막 통계 쓰기 실패와 실제 중단을 구별할 수 없다.
  return "terminal-missing";
}
function terminalJobState(v: any): MapActivityState {
  if (v.deferredState === "damaged") return "error";
  if (v.deferredState === "pending") return "awaiting";
  if (v.deferredState === "unknown" || v.baselineState === "unavailable") return "state-unknown";
  if (v.outcome === "noop" && v.reasonCode === "deferred-retry") return v.everApplied ? "applied" : "settled";
  return v.outcome as MapActivityState;
}

export function computeMapAutomationStats(raw: string, now: number, repoKey: string, lock: RunLockObservation): MapAutomationStats {
  const coverage = { validRows: 0, validJobTerminals: 0, startMissing: 0, baselineMissing: 0, jobGenerationUnknown: 0, jobIdentityCollision: 0, stateUnknown: 0, terminalMissing: 0, legacyRows: 0, excluded: 0, future: 0 };
  const rows: SeqRow[] = [], cut = now - 28 * DAY; let seq = 0;
  for (const ln of String(raw || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let v: any; try { v = JSON.parse(ln); } catch { coverage.excluded++; continue; }
    if (v?.schema === "map-automation-v1" && HEX16_RE.test(String(v.repoKey || "")) && v.repoKey !== repoKey) continue;
    if (v?.schema !== "map-automation-v1" && HEX16_RE.test(String(v.repoKey || "")) && v.repoKey !== repoKey) continue;
    const t = Date.parse(v?.ts || "");
    if (!Number.isFinite(t)) { coverage.excluded++; continue; }
    if (t > now) { coverage.future++; coverage.excluded++; continue; }
    if (t < cut) continue;
    if (v.schema !== "map-automation-v1") { coverage.legacyRows++; continue; }
    if (!isMapAutomationV1(v)) { coverage.excluded++; continue; }
    if (v.repoKey !== repoKey) continue;
    rows.push({ seq: seq++, row: v }); coverage.validRows++;
    if (v.event === "enrich-job-terminal") { coverage.validJobTerminals++; if (v.baselineState === "unavailable") coverage.baselineMissing++; }
  }
  const byRun = new Map<string, { start?: SeqRow; terminal?: SeqRow; jobs: SeqRow[] }>();
  for (const x of rows) {
    const r = byRun.get(x.row.runId) || { jobs: [] };
    if (x.row.event === "enrich-start" && !r.start) r.start = x;
    else if (x.row.event === "enrich-run-terminal") r.terminal = x;
    else if (x.row.event === "enrich-job-terminal") r.jobs.push(x);
    byRun.set(x.row.runId, r);
  }
  const runsByState: Record<string, number> = {}, runState = new Map<string, MapActivityState>(); let pairedRuns = 0;
  for (const [id, r] of byRun) {
    if (!r.start) coverage.startMissing++;
    else if (!r.start.row.jobRunId || !r.start.row.jobKey) coverage.jobGenerationUnknown++;
    if (r.terminal) {
      const st = r.terminal.row.outcome as MapActivityState; runState.set(id, st); bump(runsByState, st);
      if (r.start) pairedRuns++;
    } else {
      const st = missingRunState(id, lock); runState.set(id, st); bump(runsByState, st);
      if (st === "state-unknown") coverage.stateUnknown++;
      if (st === "terminal-missing") coverage.terminalMissing++;
    }
  }
  const jobKeys = new Map<string, Set<string>>();
  for (const x of rows) if (x.row.jobRunId && x.row.jobKey) {
    const s = jobKeys.get(x.row.jobRunId) || new Set<string>(); s.add(x.row.jobKey); jobKeys.set(x.row.jobRunId, s);
  }
  const collisions = new Set([...jobKeys].filter(([, s]) => s.size > 1).map(([id]) => id));
  coverage.jobIdentityCollision = collisions.size;
  const activities = new Map<string, SeqRow & { state: MapActivityState }>();
  for (const [runId, r] of byRun) {
    for (const x of r.jobs) {
      if (collisions.has(x.row.jobRunId)) continue;
      const cand = { ...x, state: terminalJobState(x.row) };
      const old = activities.get(x.row.jobRunId); if (!old || old.seq < x.seq) activities.set(x.row.jobRunId, cand);
    }
    // start는 이 run에 run/job terminal이 모두 없을 때만 job 활동 후보가 된다.
    if (!r.terminal && r.jobs.length === 0 && r.start) {
      const s = r.start.row;
      if (!s.jobRunId || !s.jobKey) continue;
      if (collisions.has(s.jobRunId)) continue;
      const cand = { ...r.start, state: runState.get(runId) || "state-unknown" };
      const old = activities.get(s.jobRunId); if (!old || old.seq < cand.seq) activities.set(s.jobRunId, cand);
    }
  }
  const jobsByState: Record<string, number> = {}, noopByReason: Record<string, number> = {};
  for (const a of activities.values()) {
    bump(jobsByState, a.state);
    if (a.state === "noop" && typeof a.row.reasonCode === "string") bump(noopByReason, a.row.reasonCode);
  }
  const numerator = (jobsByState.applied || 0) + (jobsByState.settled || 0);
  const denominator = numerator + (jobsByState.awaiting || 0) + (jobsByState.parked || 0) + (jobsByState["provider-failed"] || 0) + (jobsByState.error || 0) + (jobsByState.interrupted || 0);
  return {
    observedRuns: byRun.size, pairedRuns, runsByState, jobs: activities.size, jobsByState, noopByReason,
    completion: { numerator, denominator, ratio: denominator >= 5 ? numerator / denominator : null }, coverage,
  };
}

export interface MapHistoryState {
  usage: MapUsageStats;
  automation: MapAutomationStats;
  readStatus: { usage: "ok" | "absent" | "unreadable"; automation: "ok" | "absent" | "unreadable" };
}
export interface MapHistoryCollectors {
  repoKeyFor: (repo: string) => string;
  readUsage: () => string;
  readAutomation: () => string;
  observeRunLock: (repoKey: string) => RunLockObservation;
}

// P10 이력 수집의 3트랙 경계. I/O는 모두 주입하며, OFF에서는 repoKey 계산을 포함해
// 어떤 수집기도 호출하지 않는다. 판독 실패는 제품 동작을 막지 않고 '기록 없음'으로 보수 집계한다.
export function collectMapHistoryState(enabled: boolean, actualRepo: string | null, now: number,
  normWs: (s: string) => string, collectors: MapHistoryCollectors): MapHistoryState | null {
  if (!enabled || typeof actualRepo !== "string" || !actualRepo.trim()) return null;
  let repoKey = "";
  try { repoKey = collectors.repoKeyFor(actualRepo); } catch { return null; }
  if (!HEX16_RE.test(String(repoKey || ""))) return null;
  let usageRaw = "", automationRaw = "";
  let usageRead: "ok" | "absent" | "unreadable" = "ok", automationRead: "ok" | "absent" | "unreadable" = "ok";
  try { usageRaw = String(collectors.readUsage() || ""); }
  catch (e: any) { usageRead = e && e.code === "ENOENT" ? "absent" : "unreadable"; }
  try { automationRaw = String(collectors.readAutomation() || ""); }
  catch (e: any) { automationRead = e && e.code === "ENOENT" ? "absent" : "unreadable"; }
  let lock: RunLockObservation = { state: "unreadable", runId: null };
  try { lock = collectors.observeRunLock(repoKey); } catch { /* 판독 불가를 중단 확정으로 바꾸지 않음 */ }
  return {
    usage: computeMapUsageStats(usageRaw, now, repoKey, actualRepo, normWs),
    automation: computeMapAutomationStats(automationRaw, now, repoKey, lock),
    readStatus: { usage: usageRead, automation: automationRead },
  };
}

// ── 증분 2: 현재 지도 건강도와 P9 현재 상태 ────────────────────────────────────
// 28일 이력과 섞지 않는 '지금 한 번 읽은 스냅샷'이다. 경로·오류 전문은 반환하지 않는다.
export type CurrentMapSource = "v2" | "none" | "legacy" | "blocked" | "error";
export interface CurrentMapHealth {
  total: number;
  degraded: number;
  fresh: number;
  stale: number;
  unknown: number;
  ratios: { fresh: number | null; stale: number | null; unknown: number | null };
}
export interface CurrentIntentSnapshot {
  state: "ok" | "partial" | "damaged" | "unavailable";
  choicePending: number | null;
  retryPending: number | null;
  recoveryNeeded: boolean | null;
  investigations: number | null;
}
export interface CurrentMapState {
  source: CurrentMapSource;
  reasonKey: string | null;
  health: CurrentMapHealth | null;
  intent: CurrentIntentSnapshot;
}
export interface CurrentMapCollectors {
  readProjection: (repo: string) => any;
  deriveFreshness: (repo: string, projection: any) => any;
}

function intentSnapshotOf(view: any): CurrentIntentSnapshot {
  const recovery = objectOnly(view) && objectOnly(view.recovery) ? view.recovery : null;
  const dashboard = objectOnly(view) && objectOnly(view.dashboard) ? view.dashboard : null;
  const attention = dashboard && objectOnly(dashboard.attention) ? dashboard.attention : null;
  const choicePending = dashboard && Array.isArray(dashboard.conflictCards) ? dashboard.conflictCards.length : null;
  const investigations = dashboard && Array.isArray(dashboard.information) ? dashboard.information.length : null;
  const retryPending = attention && attention.damaged !== true && safeInt(attention.parkedChoices) && safeInt(attention.parkedDelegations)
    ? attention.parkedChoices + attention.parkedDelegations : null;
  const recoveryNeeded = recovery && typeof recovery.needed === "boolean" ? recovery.needed : null;
  const vals = [choicePending, retryPending, recoveryNeeded, investigations];
  const known = vals.filter((v) => v !== null).length;
  return {
    state: attention && attention.damaged === true ? "damaged" : known === vals.length ? "ok" : known > 0 ? "partial" : "unavailable",
    choicePending, retryPending, recoveryNeeded, investigations,
  };
}

function currentStateError(reasonKey: string, intentView: any): CurrentMapState {
  return { source: "error", reasonKey, health: null, intent: intentSnapshotOf(intentView) };
}

export function computeCurrentMapState(projection: any, freshness: any, intentView: any): CurrentMapState {
  const intent = intentSnapshotOf(intentView);
  if (!objectOnly(projection)) return currentStateError("projection-invalid", intentView);
  const source = projection.source;
  if (source === "none" || source === "legacy") return { source, reasonKey: null, health: null, intent };
  if (source === "blocked" || source === "error") {
    const stableReason = typeof projection.reason === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(projection.reason) ? projection.reason : null;
    const reasonKey = typeof projection.reasonKey === "string" && projection.reasonKey
      ? projection.reasonKey : stableReason || (source === "blocked" ? "map-blocked" : "map-reader-error");
    return { source, reasonKey, health: null, intent };
  }
  if (source !== "v2" || projection.ok !== true || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)
    || !Array.isArray(projection.degraded) || !Array.isArray(freshness)) return currentStateError("projection-invalid", intentView);

  const items = new Map<string, { id: string; kind: "node" | "edge" }>();
  for (const [list, kind] of [[projection.nodes, "node"], [projection.edges, "edge"]] as const) {
    for (const v of list) {
      if (!objectOnly(v) || typeof v.id !== "string" || !v.id) return currentStateError("projection-invalid", intentView);
      const key = kind + ":" + v.id;
      if (items.has(key)) return currentStateError("projection-invalid", intentView);
      items.set(key, { id: v.id, kind });
    }
  }
  const rank: Record<string, number> = { fresh: 1, unknown: 2, stale: 3 };
  const observed = new Map<string, "fresh" | "stale" | "unknown">();
  for (const v of freshness) {
    if (!objectOnly(v) || (v.kind !== "node" && v.kind !== "edge") || typeof v.id !== "string"
      || (v.state !== "fresh" && v.state !== "stale" && v.state !== "unknown")) continue;
    const key = v.kind + ":" + v.id;
    if (!items.has(key)) continue;
    const old = observed.get(key);
    if (!old || rank[v.state] > rank[old]) observed.set(key, v.state);
  }
  let fresh = 0, stale = 0, unknown = 0;
  for (const key of items.keys()) {
    const state = observed.get(key) || "unknown";
    if (state === "fresh") fresh++;
    else if (state === "stale") stale++;
    else unknown++;
  }
  const total = items.size, enough = total >= 5;
  return {
    source: "v2", reasonKey: null,
    health: {
      total, degraded: projection.degraded.length, fresh, stale, unknown,
      ratios: { fresh: enough ? fresh / total : null, stale: enough ? stale / total : null, unknown: enough ? unknown / total : null },
    },
    intent,
  };
}

export function collectCurrentMapState(enabled: boolean, actualRepo: string | null, intentView: any, collectors: CurrentMapCollectors): CurrentMapState | null {
  if (!enabled || typeof actualRepo !== "string" || !actualRepo.trim()) return null;
  let projection: any;
  try { projection = collectors.readProjection(actualRepo); }
  catch { return currentStateError("reader-exception", intentView); }
  if (!objectOnly(projection) || projection.source !== "v2" || projection.ok !== true)
    return computeCurrentMapState(projection, [], intentView);
  let freshness: any;
  try { freshness = collectors.deriveFreshness(actualRepo, projection); }
  catch { return currentStateError("freshness-exception", intentView); }
  return computeCurrentMapState(projection, freshness, intentView);
}
