/*
 * 브릿지 판 어긋남 감지(순수 — 테스트 대상). 결정 D-2026-09-19-bridge-stale-banner.
 * 실사고(2026-09-19): install.js 로 브릿지를 갱신한 뒤 창을 다시 로드하지 않으면 확장 호스트는 require 캐시의 옛
 * 브릿지 모듈로 새 형식의 장부를 읽어 '손상'이라 표시했고, 화면은 원인도 조치(창 다시 로드)도 말하지 못했다.
 * 규칙: 이 프로세스가 캐시한 브릿지 모듈(브릿지 홈 아래 .js)마다 '처음 관측한 순간'의 파일 지문(mtime+size)을 기억하고,
 * 이후 디스크 지문이 달라지면 그 모듈은 '이전 판'이다. 특정 장부 키·특정 파일에 매이지 않는 일반 규칙이라
 * 앞으로의 형식 변경에도 같은 안내가 나온다. 한계: 로드와 첫 관측 사이에 파일이 바뀌면 그 한 번은 놓친다(창이 뜬 직후
 * 한 번, 그리고 매 렌더마다 관측하므로 창은 좁다).
 */
export interface FileIdent { mtimeMs: number; size: number }
export interface BridgeStaleResult { stale: boolean; changed: string[]; tracked: number }

function normPath(p: string): string { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }

/** cachedPaths=require.cache 의 키들, bridgeDir=브릿지 홈, loaded=관측 지문 저장소(호출자가 유지·이 함수가 갱신), statOf=현재 지문 판독(없으면 null). */
export function observeBridgeStale(cachedPaths: string[], bridgeDir: string, loaded: Map<string, FileIdent>, statOf: (p: string) => FileIdent | null): BridgeStaleResult {
  const dir = normPath(bridgeDir);
  const changed: string[] = [];
  for (const raw of cachedPaths || []) {
    const p = String(raw || "");
    const n = normPath(p);
    if (!dir || !n.startsWith(dir + "/") || !n.endsWith(".js")) continue; // 브릿지 홈 아래 .js 만
    if (n.slice(dir.length + 1).includes("/")) continue; // 하위 폴더(node_modules 등)는 대상 아님 — 브릿지 모듈은 홈 바로 아래
    const cur = statOf(p);
    const seen = loaded.get(n);
    if (!seen) { loaded.set(n, cur || { mtimeMs: 0, size: 0 }); continue; } // 첫 관측=로드된 판의 지문으로 기록
    if (!cur || cur.mtimeMs !== seen.mtimeMs || cur.size !== seen.size) changed.push(n.slice(n.lastIndexOf("/") + 1));
  }
  changed.sort();
  return { stale: changed.length > 0, changed, tracked: loaded.size };
}
