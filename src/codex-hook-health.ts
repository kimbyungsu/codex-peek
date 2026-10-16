export type CodexHookReason = "healthy" | "turn-unverifiable" | "heartbeat-missing" | "heartbeat-stale";
export type CodexHookTrustReason = "trusted" | "hooks-unverified" | "hooks-untrusted" | "hooks-missing";

// 설치·활성화와 실행 신뢰는 별개다. hooks/list가 아직 끝나지 않았거나 실패한 상태도 신뢰 확인 실패이므로
// heartbeat가 남아 있더라도 준비 완료로 승인하지 않는다(fail-closed).
export function assessCodexHookTrust(snapshot: any): { ready: boolean; reason: CodexHookTrustReason } {
  if (!snapshot || snapshot.queried !== true) return { ready: false, reason: "hooks-unverified" };
  // [2026-10-09 실사고] 등록이 빠진 훅(missingEvents)은 '신뢰 안 됨'이 아니라 '등록 안 됨' — 사용자가 Codex 설정에서 '다 신뢰됨'을 보고도
  // 신뢰하라는 안내를 받던 모순 해소(처방=훅 다시 설치 뒤 새 훅 신뢰).
  if (Array.isArray(snapshot.missingEvents) && snapshot.missingEvents.length) return { ready: false, reason: "hooks-missing" };
  if (snapshot.ready !== true) return { ready: false, reason: "hooks-untrusted" };
  return { ready: true, reason: "trusted" };
}

// hooks/list 결과는 cwd에 따라 달라질 수 있다. 프로젝트 전환 중 앞 프로젝트의 결과나 in-flight 요청을
// 재사용하지 않도록 정규화된 조회 CWD 키별로 snapshot/query/시각을 함께 격리한다.
export class CodexHookTrustCache<T> {
  private readonly snapshots = new Map<string,T>();
  private readonly queries = new Map<string,Promise<T>>();
  private readonly lastChecks = new Map<string,number>();
  private readonly fingerprints = new Map<string,string>();
  private readonly failures = new Map<string,number>();
  getSnapshot(key:string):T|undefined{return this.snapshots.get(key);}
  getFresh(key:string,now:number,ttlMs:number):T|undefined{const v=this.snapshots.get(key),at=this.lastChecks.get(key)||0;return v&&now-at<ttlMs?v:undefined;}
  getQuery(key:string):Promise<T>|undefined{return this.queries.get(key);}
  markStarted(key:string,at:number,fingerprint?:string):void{this.lastChecks.set(key,at);if(fingerprint!==undefined)this.fingerprints.set(key,fingerprint);}
  lastCheckAt(key:string):number{return this.lastChecks.get(key)||0;}
  getFingerprint(key:string):string{return this.fingerprints.get(key)??"";}
  failureCount(key:string):number{return this.failures.get(key)||0;}
  // 조회 결과 기록 — 확인 성공(신뢰 여부와 무관하게 답을 받음)=실패 횟수 0, 확인 실패(시간 초과·오류)=1 증가(다음 확인 간격이 길어짐)
  noteResult(key:string,queried:boolean):void{this.failures.set(key,queried?0:this.failureCount(key)+1);}
  setQuery(key:string,query:Promise<T>):void{this.queries.set(key,query);}
  setSnapshot(key:string,value:T):void{this.snapshots.set(key,value);}
  clearQuery(key:string):void{this.queries.delete(key);}
  reset():void{this.snapshots.clear();this.queries.clear();this.lastChecks.clear();this.fingerprints.clear();this.failures.clear();}
}

// [2026-10-10 실사고] 다시 확인할 때 — 신뢰 상태는 Codex 설정 파일(신뢰 기록)과 훅 파일이 바뀔 때만 바뀐다. 화면을 다시 그릴 때마다(30초)
// 새 Codex 실행 코어를 띄워 묻던 것이 하루 400회 가까이 실행 코어를 띄우고 전부 시간 초과로 끝났다. 이제:
// 두 파일 지문이 바뀌면 바로 · 전부 신뢰 확인됨=30분 · 확인됐지만 아직 신뢰 안 됨=5분(사용자가 고치는 중일 수 있음) ·
// 확인 실패=2→5→15→30분으로 점점 길게. 사용자가 누른 확인·설치 흐름은 이 규칙과 무관하게 바로 확인한다(force).
export const CODEX_HOOK_TRUST_READY_TTL_MS = 30 * 60 * 1000;
export const CODEX_HOOK_TRUST_UNREADY_TTL_MS = 5 * 60 * 1000;
export const CODEX_HOOK_TRUST_FAIL_BACKOFF_MS = [2, 5, 15, 30].map((m) => m * 60 * 1000);
export function codexHookTrustRecheckDue(o: {
  snapshot: { queried?: boolean; ready?: boolean } | undefined | null;
  lastCheckAt: number;
  now: number;
  fingerprint: string;
  lastFingerprint: string;
  failures: number;
}): boolean {
  if (!o.snapshot) return true;
  if (o.fingerprint !== o.lastFingerprint) return true;
  const age = o.now - o.lastCheckAt;
  if (o.snapshot.queried === true) return age >= (o.snapshot.ready === true ? CODEX_HOOK_TRUST_READY_TTL_MS : CODEX_HOOK_TRUST_UNREADY_TTL_MS);
  const i = Math.min(Math.max(o.failures, 1), CODEX_HOOK_TRUST_FAIL_BACKOFF_MS.length) - 1;
  return age >= CODEX_HOOK_TRUST_FAIL_BACKOFF_MS[i];
}

// [AFTER-0.1.104-FIXES 설계 B] 훅 기록이 없거나 옛 차례 것뿐일 때(heartbeat-missing·stale) — 실패인지, 훅 설치 뒤 아직 쓴 적이 없는지 구분.
// 기준 시각 T(writeTimeMs)=설치기가 지금 훅 항목을 훅 파일에 쓰기 직전 시각(이른 쪽으로만 틀림). 경계(마지막 차례 시각=T)는 실패 쪽.
//  · failed: 마지막 차례 시각 ≥ T(그 차례에 훅이 돌았어야 함 — 기록이 전무해도)
//  · pending(확인 전): 이 프로젝트에 차례가 아직 없거나 마지막 차례가 T 보다 이름
//  · install-time-unknown / turn-time-unreadable: 구분할 근거가 없음 → 호출자는 지금 규칙 그대로(낮추지 않음)
export type CodexHookMissStage = "failed" | "pending" | "install-time-unknown" | "turn-time-unreadable";
export function stageCodexHookMiss(o: { writeTimeMs: number | null; turnExists: boolean; latestTurnTs: string }): CodexHookMissStage {
  if (o.writeTimeMs === null || !Number.isFinite(o.writeTimeMs)) return "install-time-unknown";
  if (!o.turnExists) return "pending";
  const at = Date.parse(String(o.latestTurnTs || ""));
  if (!Number.isFinite(at)) return "turn-time-unreadable";
  return at >= o.writeTimeMs ? "failed" : "pending";
}

// Codex 플러그인 설치 여부만으로는 현재 대화에 lifecycle 훅이 붙었다고 볼 수 없다.
// UserPromptSubmit이 남긴 출처+turn id를 현재 rollout turn id와 대조해 실제 생존만 인정한다.
export function assessCodexHookHeartbeat(
  active: any,
  latestTurnId: string,
  latestTurnTs = "",
): { ready: boolean; reason: CodexHookReason; heartbeatTurnId: string } {
  const heartbeatTurnId = String(active?.turnId || "");
  const event = String(active?.hookEvent || "");
  if (!active || active.source !== "codex-hook" || !["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].includes(event)) {
    return { ready: false, reason: "heartbeat-missing", heartbeatTurnId };
  }
  if (event === "SessionStart") {
    const activeAt = Date.parse(String(active.ts || ""));
    const latestAt = Date.parse(String(latestTurnTs || ""));
    if (!Number.isFinite(activeAt)) return { ready: false, reason: "heartbeat-missing", heartbeatTurnId };
    // A resume after the latest turn is healthy. Any strictly newer turn must have one of that
    // turn's signed hooks; a tolerance window would incorrectly approve a missing hook.
    if (Number.isFinite(latestAt) && latestAt > activeAt) {
      return { ready: false, reason: "heartbeat-stale", heartbeatTurnId };
    }
    return { ready: true, reason: "healthy", heartbeatTurnId };
  }
  // 현재 rollout turn을 읽지 못하면 과거 heartbeat와의 동치 여부도 증명할 수 없다. C-C 강제 게이트는
  // 비교 불능을 정상으로 승인하지 않는다(fail-closed). 최신 Codex turn_context에는 turn_id가 있다.
  if (!latestTurnId) {
    return { ready: false, reason: "turn-unverifiable", heartbeatTurnId };
  }
  if (heartbeatTurnId !== latestTurnId) {
    return { ready: false, reason: "heartbeat-stale", heartbeatTurnId };
  }
  return { ready: true, reason: "healthy", heartbeatTurnId };
}
