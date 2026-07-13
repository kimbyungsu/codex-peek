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
