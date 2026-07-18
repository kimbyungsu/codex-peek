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
  best: { id: string; promptTs: string; model?: string; effort?: string },
): { next: Record<string, unknown>; generationAdvanced: boolean } {
  const promptAt = Date.parse(best.promptTs || "") || 0;
  const observed = Date.parse(String(cur.implementerLastSeenAt || cur.implementerLinkedAt || "")) || 0;
  if (cur.implementerSession === best.id) {
    if (promptAt > observed) return { next: { ...cur, implementerLastSeenAt: best.promptTs }, generationAdvanced: false };
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
    },
    generationAdvanced: true,
  };
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
