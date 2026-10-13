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

/**
 * [RULE-SUPPLY-CORRECTION ⑦ 묶음 4(E) · D-c] 쓰기 직전 판정 — 수칙서·후보 장부에 쓰는 화면 동작 직전에 부른다.
 * ① 관측 기반(observeBridgeStale — 처음 관측한 지문 대비) ② 모듈이 스스로 내보낸 '읽힌 순간의 지문'(identOf — 예: contract-lib 의 LOADED_IDENT)이
 * 지금 디스크와 다른가. 둘 중 하나라도 다르면 이전 판이다. ②는 '읽기와 첫 관측 사이에 파일이 바뀐' 경우(①의 한계)를 메운다.
 * identOf 가 null 을 주는 모듈(지문을 내보내지 않는 옛 모듈)은 ①만. 지금 지문을 못 읽으면(파일 없음) 이전 판으로 본다.
 */
export function bridgeWriteStale(cachedPaths: string[], bridgeDir: string, loaded: Map<string, FileIdent>, statOf: (p: string) => FileIdent | null, identOf: (p: string) => FileIdent | null): BridgeStaleResult {
  const a = observeBridgeStale(cachedPaths, bridgeDir, loaded, statOf);
  const changed = new Set<string>(a.changed);
  const dir = normPath(bridgeDir);
  for (const raw of cachedPaths || []) {
    const p = String(raw || "");
    const n = normPath(p);
    if (!dir || !n.startsWith(dir + "/") || !n.endsWith(".js") || n.slice(dir.length + 1).includes("/")) continue;
    const base = n.slice(n.lastIndexOf("/") + 1);
    const cur = statOf(p);
    if (!cur) { changed.add(base); continue; } // [검증 1회차 blocker] 지금 파일을 못 읽음=이전 판 — 첫 관측·자기 지문 유무와 무관
    const id = identOf(p);
    if (!id) continue;
    if (cur.mtimeMs !== id.mtimeMs || cur.size !== id.size) changed.add(base);
  }
  const list = [...changed].sort();
  return { stale: list.length > 0, changed: list, tracked: a.tracked };
}
