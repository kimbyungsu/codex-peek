/*
 * MAP 장부(stable MAP 2층) 공유 순수 로직 — 제안층(지도 ⑥ 후보) 계산·승인 줄 형식·확정층(MAP.md) 파싱.
 * 확장(src/extension.ts 대시보드 카드)과 CLI(scripts/scope-reconcile.js — out/map-ledger.js를 require)가
 * 같은 형식을 이 한 곳에서 쓴다(형식이 두 벌로 갈리면 장부가 서로 안 읽힘 — 단일 출처 강제).
 * vscode/fs 의존 없음(순수 함수만) — tests/map-ledger.test.js가 node로 직접 검증.
 */

export type PendingItem = { sig: string; text: string; from: string };
export type ApprovedEntry = { text: string; date: string; from: string };

// 제안 서명 — 공백 요동만 무시(내용이 같으면 같은 제안). CLI norm()과 동일 규칙이어야 승인/기각 기록이 서로 읽힌다.
export function normSig(t: string): string {
  return String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// 확정층에 추가되는 승인 줄의 유일한 형식. 날짜·출처 주석은 parseApprovedFromMap이 되읽는다(왕복 보장).
export function approvedLine(text: string, from: string, isoNow: string): string {
  return `- ${text}  <!-- 승인 ${isoNow.slice(0, 10)} · 출처: ${from} -->`;
}

export const MAP_SECTION_HEADER = "## 확정 결합(승인분)";

// 확정층 파일이 없을 때의 뼈대 — CLI·확장이 같은 문서를 만든다.
export function mapSkeleton(): string {
  return "# MAP — 확정 지식층(stable)\n\n한쪽을 바꾸면 다른 쪽도 봐야 하는 '의미 결합' 장부. 탐색자 꾸러미가 신뢰 입력으로 읽는다.\n승격 경로는 사람 승인뿐 — CLI(scope-reconcile approve) 또는 대시보드 MAP 장부 카드의 [승인] 버튼(제안 자동 반영 없음).\n\n" + MAP_SECTION_HEADER + "\n";
}

// MAP.md에서 '승인 줄'들을 되읽는다(무엇이 언제·어디서 승인됐는지 — 대시보드 이력용).
// 손으로 쓴 일반 항목은 승인 메타가 없으므로 approved에는 안 잡히고 totalItems에만 센다(정직 표기).
export function parseApprovedFromMap(md: string): { approved: ApprovedEntry[]; totalItems: number } {
  const approved: ApprovedEntry[] = [];
  let totalItems = 0;
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    totalItems++;
    const m = line.match(/^- (.*?) {2}<!-- 승인 (\d{4}-\d{2}-\d{2}) · 출처: (.*?) -->$/);
    if (m) approved.push({ text: m[1], date: m[2], from: m[3] });
  }
  return { approved, totalItems };
}

// 제안층 계산 — 최근 지도들의 ⑥ 후보(sources는 새 지도부터)에서 이미 처리(승인/기각)됐거나 확정층에
// 같은 문구가 있는 것을 뺀 대기 목록. 같은 제안이 여러 지도에 있으면 첫(=최신) 지도의 출처가 남는다.
// 정렬은 텍스트 기준(결정적 — CLI 번호 스냅샷·대시보드가 같은 순서를 본다).
export function computePending(
  sources: Array<{ patches: unknown; from: string }>,
  doneSigs: Iterable<string>,
  mapMd: string
): PendingItem[] {
  const done = new Set<string>();
  for (const s of doneSigs) done.add(s);
  const mapNow = normSig(mapMd);
  const all = new Map<string, PendingItem>();
  for (const src of sources) {
    const patches = Array.isArray(src.patches) ? src.patches : [];
    for (const t of patches) {
      if (typeof t !== "string" || !t.trim()) continue;
      const sig = normSig(t);
      if (done.has(sig) || all.has(sig)) continue;
      if (mapNow && mapNow.includes(sig)) continue; // 확정층에 이미 같은 문구
      all.set(sig, { sig, text: t.trim(), from: src.from });
    }
  }
  return [...all.values()].sort((a, b) => a.text.localeCompare(b.text));
}

// 확정층 본문에 승인 줄들을 붙인 결과(쓰기는 호출자가 원자적으로). cur가 비면 뼈대에서 시작, 구획 헤더 보장.
export function appendApproved(cur: string, items: Array<{ text: string; from: string }>, isoNow: string): string {
  let out = cur && cur.trim() ? cur : mapSkeleton();
  if (!out.includes(MAP_SECTION_HEADER)) out += "\n" + MAP_SECTION_HEADER + "\n";
  if (!out.endsWith("\n")) out += "\n";
  for (const it of items) out += approvedLine(it.text, it.from, isoNow) + "\n";
  return out;
}
