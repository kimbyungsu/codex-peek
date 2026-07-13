// Codex 구현자 자동 고정 뒤 첫 실제 turn_context의 모델·추론강도를 찾는 순수 판독기.
// 훅 입력에 effort가 없을 수 있으므로 "나중에 도착한 훅 값"이 아니라 rollout의 시간순 첫 관측을 기준선으로 삼는다.
export type ImplementerBaseline = { model: string; effort: string; ts: string };
export type ImplementerMetaPoint = ImplementerBaseline & { cwd: string };

export function firstImplementerMetaFromHistory(
  history: ImplementerMetaPoint[],
  workspace: string,
  sinceMs: number,
  normWs: (p: string) => string,
  clockSkewMs = 5000,
): ImplementerBaseline {
  const out: ImplementerBaseline = { model: "", effort: "", ts: "" };
  const want = normWs(workspace || "");
  const floor = Number.isFinite(sinceMs) ? sinceMs - Math.max(0, clockSkewMs) : 0;
  for (const p of history || []) {
    if (want && normWs(String(p.cwd || "")) !== want) continue;
    const tsMs = Date.parse(String(p.ts || ""));
    if (floor && (!Number.isFinite(tsMs) || tsMs < floor)) continue;
    if (!out.ts && Number.isFinite(tsMs)) out.ts = new Date(tsMs).toISOString();
    if (!out.model && p.model) out.model = String(p.model);
    if (!out.effort && p.effort) out.effort = String(p.effort);
    if (out.model && out.effort) break;
  }
  return out;
}

export function firstImplementerMetaSince(
  text: string,
  workspace: string,
  sinceMs: number,
  normWs: (p: string) => string,
  clockSkewMs = 5000,
): ImplementerBaseline {
  const history: ImplementerMetaPoint[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; } // tail 첫 조각·손상 줄은 건너뜀
    if ((o?.type || o?.payload?.type) !== "turn_context") continue;
    const p = o.payload || o;
    const tsMs = Date.parse(String(o.timestamp || p.timestamp || ""));
    const effort = p.effort || p.reasoning_effort || p.collaboration_mode?.settings?.reasoning_effort;
    history.push({ cwd: String(p.cwd || ""), model: p.model ? String(p.model) : "", effort: effort ? String(effort) : "", ts: Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : "" });
  }
  return firstImplementerMetaFromHistory(history, workspace, sinceMs, normWs, clockSkewMs);
}
