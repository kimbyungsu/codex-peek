export type AutoPinCandidate = {
  id: string;
  sessionSource: string;
  threadSource: string;
  turnId: string;
  promptTs: string;
  model: string;
  effort: string;
};
export type AutoPinProject = { project: string; roots: string[] };

export function resolvePromptProject(
  cwd: string,
  projects: AutoPinProject[],
  norm: (p: string) => string,
  contains: (root: string, child: string) => boolean,
): string | null {
  const exact = projects.filter((p) => p.roots.some((r) => norm(r) === norm(cwd)));
  const pool = exact.length ? exact : projects.filter((p) => p.roots.some((r) => contains(r, cwd)));
  const unique = [...new Map(pool.map((p) => [norm(p.project), p.project])).values()];
  return unique.length === 1 ? unique[0] : null;
}

// 훅은 처리 시각을 링크에 쓰지만 보조 경로의 정본은 실제 prompt 시각이다. 현재 구현 세션의
// rollout prompt가 있으면 같은 시간축끼리 비교해 지연된 옛 훅이 새 대화를 영구히 되돌리지 못하게 한다.
export function autoPinCandidateIsCurrent(
  candidatePromptTs: string,
  currentPromptTs: string,
  linkObservedTs: string,
): boolean {
  const candidate = Date.parse(candidatePromptTs || "");
  const current = Date.parse(currentPromptTs || "") || Date.parse(linkObservedTs || "") || 0;
  return Number.isFinite(candidate) && candidate > 0 && candidate >= current;
}

export function autoPinWriteAllowed(
  beforeImplementer: string,
  lockedImplementer: string,
  candidatePromptTs: string,
  currentPromptTs: string,
  linkObservedTs: string,
): boolean {
  return beforeImplementer === lockedImplementer && autoPinCandidateIsCurrent(candidatePromptTs, currentPromptTs, linkObservedTs);
}

// P-6b(2026-07-14 라이브 실측 — 사건 순서는 검증 정정본이 정본: 커밋 6998725 본문의 '훅 CAS가 raced로 밀림'
// 서술은 오기): 실제로는 ①훅 pin이 먼저 '성공'해 턴 상태를 정상 기록했고(raced 아님) ②그 '뒤' 확장의 같은-세션
// 자동 고정이 implementerEventAt을 새 프롬프트(나중엔 <hook_prompt> 차단 쪽지 오인분까지) 시각으로 전진시켜
// ③eventAt이 이미 기록된 turn.startedAt보다 미래가 되면서 freeze가 turn-before-link로 검증 시작을 거부했다
// (job 실행 중이면 writeProof stale-role까지). 그래서 같은 세션 재관측은 '세대'(implementerRevision·
// implementerEventAt·roleRevision)를 전진시키지 않는다 — 세대 기록원은 훅 pin과 '다른 세션 교체'만.
// 관측 시각(implementerLastSeenAt)만 갱신한다. 세대 전진은 '다른 세션으로의 교체'(ABA 포함)에만 허용 —
// ABA 검출은 그 분기의 revision 증가가 그대로 담당한다.
export function applyAutoPinUpdate(
  cur: Record<string, unknown>,
  best: { id: string; promptTs: string; model?: string; effort?: string; turnId?: string },
): { next: Record<string, unknown>; generationAdvanced: boolean } {
  const promptAt = Date.parse(best.promptTs || "") || 0;
  const observed = Date.parse(String(cur.implementerLastSeenAt || cur.implementerLinkedAt || "")) || 0;
  if (cur.implementerSession === best.id) {
    if (promptAt > observed) {
      const next: Record<string, unknown> = { ...cur, implementerLastSeenAt: best.promptTs };
      // 경합 인계 힌트 수명주기(설계 4차 ⑴): auto-pin 출처 레코드에 한해 더 새 프롬프트(N+1) 관측 시 턴
      // 힌트를 최신으로 교체(세대 불변) — 늦은 옛 턴(N) 훅이 동일 턴 예외를 재사용 못 하게. hook 출처
      // 레코드는 힌트 부재라 무접촉(정상 훅 성공이 이미 소거).
      if (cur.implementerLinkSource === "rollout-user-prompt" && best.turnId) next.implementerTurnHint = best.turnId;
      return { next, generationAdvanced: false };
    }
    return { next: { ...cur }, generationAdvanced: false };
  }
  return {
    next: {
      ...cur,
      implementerSession: best.id,
      implementerLinkedAt: best.promptTs,
      implementerLastSeenAt: best.promptTs,
      implementerRevision: (Number(cur.implementerRevision) || 0) + 1,
      implementerEventAt: promptAt,
      implementerModel: best.model || "",
      implementerEffort: best.effort || "",
      implementerLinkSource: "rollout-user-prompt",
      // 동일 턴 한정 인계(설계 동결 v3~v4): 늦게 재개된 '같은 턴' 훅만 registerCodexImplementer의 좁은 예외로
      // 합류할 수 있게 rollout 사용자 턴 id를 힌트로 남긴다(훅 성공 시 소거 — 1회성).
      implementerTurnHint: best.turnId || "",
    },
    generationAdvanced: true,
  };
}

// fallback 교체 게이트(설계 동결 B — 위생 축: 목표는 '이중 세대 전진 빈도 축소'이며 정확성 책임은 동일 턴
// 합류 예외(A'')가 진다): ①훅 흔적(codex-active ts)이 프롬프트 이후=지연(훅이 그 프롬프트를 봄 — pin은 훅
// 권위 몫) ②흔적 없음·프롬프트가 grace(기본 20초) 미만 경과=지연(훅에게 기회) ③그 외=허용(훅 침묵 — 안전망).
export const AUTO_PIN_HOOK_GRACE_MS = 20000;
// 게이트의 훅 흔적은 '이 프로젝트·이 후보 세션'의 기록만 인정(구현검증 1차 B1): codex-active는 세션당 단일
// 파일이라 같은 세션의 '다른 프로젝트' heartbeat ts를 그대로 쓰면 그 프로젝트 활동이 이 프로젝트의 안전망을
// 영구 지연시킨다(프로젝트 분리 훼손). 세션 id·workspace 결속이 확인될 때만 ts 반환.
// 구현자 연결 필드 일괄 소거(수명주기 ⑸ 공용 정본 — 확장 해제 경로 2곳이 이 함수만 호출·테스트가 직접 실행):
// 출처(implementerLinkSource)·턴 힌트(implementerTurnHint)까지 포함해 잔존 0(고아 메타로 남으면 늦은 옛 훅이
// 예외 재사용·verifier 연결만 남은 레코드에 falsy 힌트 잔류). 비구현자 필드(codexSession 등)는 불변.
export function clearImplementerLinkFields(cur: Record<string, unknown>): void {
  delete cur.implementerSession; delete cur.implementerLinkedAt; delete cur.implementerLastSeenAt;
  delete cur.implementerRevision; delete cur.implementerEventAt; delete cur.implementerModel;
  delete cur.implementerEffort; delete cur.implementerLinkSource; delete cur.implementerTurnHint;
}
export function hookActiveTsForGate(rec: { codexSession?: unknown; workspace?: unknown; ts?: unknown } | null | undefined, sessionId: string, ws: string, normWsFn: (p: string) => string): number | null {
  if (!rec || String(rec.codexSession || "") !== sessionId) return null;
  if (!ws || normWsFn(String(rec.workspace || "")) !== normWsFn(ws)) return null;
  const t = Date.parse(String(rec.ts || ""));
  return Number.isFinite(t) ? t : null;
}
export function autoPinReplacementReady(promptTsMs: number, hookActiveTsMs: number | null, nowMs: number, graceMs: number = AUTO_PIN_HOOK_GRACE_MS): boolean {
  if (!promptTsMs) return false;
  if (hookActiveTsMs !== null && hookActiveTsMs >= promptTsMs) return false; // 훅이 이미 봄 — 영구 지연
  return nowMs - promptTsMs >= graceMs; // 훅 침묵이 grace 이상 지속될 때만 안전망 가동
}

// 구현 역할은 사용자가 Codex 앱에서 실제 프롬프트를 가장 최근 제출한 대화가 맡는다.
// exec 검증 세션·하위 에이전트·현재 검증 역할은 후보에서 제외해 자동고정이 검증 트래픽을 따라가지 않게 한다.
export function chooseImplementerAutoPin(
  candidates: AutoPinCandidate[],
  verifierIds: Iterable<string>,
): AutoPinCandidate | null {
  const blocked = new Set([...verifierIds].filter(Boolean));
  let best: AutoPinCandidate | null = null;
  let bestTs = 0;
  for (const c of candidates) {
    if (!c.id || blocked.has(c.id) || c.sessionSource !== "vscode" || c.threadSource !== "user" || !c.turnId) continue;
    const ts = Date.parse(c.promptTs || "");
    if (!Number.isFinite(ts) || ts <= bestTs) continue;
    best = c;
    bestTs = ts;
  }
  return best;
}
