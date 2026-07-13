export type CodexHookReason = "healthy" | "turn-unverifiable" | "heartbeat-missing" | "heartbeat-stale";
export type CodexHookTrustReason = "trusted" | "hooks-unverified" | "hooks-untrusted";

// 설치·활성화와 실행 신뢰는 별개다. hooks/list가 아직 끝나지 않았거나 실패한 상태도 신뢰 확인 실패이므로
// heartbeat가 남아 있더라도 준비 완료로 승인하지 않는다(fail-closed).
export function assessCodexHookTrust(snapshot: any): { ready: boolean; reason: CodexHookTrustReason } {
  if (!snapshot || snapshot.queried !== true) return { ready: false, reason: "hooks-unverified" };
  if (snapshot.ready !== true) return { ready: false, reason: "hooks-untrusted" };
  return { ready: true, reason: "trusted" };
}

// hooks/list 결과는 cwd에 따라 달라질 수 있다. 프로젝트 전환 중 앞 프로젝트의 결과나 in-flight 요청을
// 재사용하지 않도록 정규화된 조회 CWD 키별로 snapshot/query/시각을 함께 격리한다.
export class CodexHookTrustCache<T> {
  private readonly snapshots = new Map<string,T>();
  private readonly queries = new Map<string,Promise<T>>();
  private readonly lastChecks = new Map<string,number>();
  getSnapshot(key:string):T|undefined{return this.snapshots.get(key);}
  getFresh(key:string,now:number,ttlMs:number):T|undefined{const v=this.snapshots.get(key),at=this.lastChecks.get(key)||0;return v&&now-at<ttlMs?v:undefined;}
  getQuery(key:string):Promise<T>|undefined{return this.queries.get(key);}
  markStarted(key:string,at:number):void{this.lastChecks.set(key,at);}
  setQuery(key:string,query:Promise<T>):void{this.queries.set(key,query);}
  setSnapshot(key:string,value:T):void{this.snapshots.set(key,value);}
  clearQuery(key:string):void{this.queries.delete(key);}
  reset():void{this.snapshots.clear();this.queries.clear();this.lastChecks.clear();}
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
