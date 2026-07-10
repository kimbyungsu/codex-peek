/*
 * 관측 장부(observed ledger) 순수 로직 — 이벤트 적재 → 약한 상태 전이 → 꾸러미용 선별.
 * 설계 원본: memento(assertionStatus 4단계·재통합) + tg-chat-engine(삭제 금지·disputed 상태 전이·
 * supersedes 링크·learning_events '이벤트 먼저, 정책 나중') — 2026-07-07 사용자·검증 합의 로드맵 ①②③.
 *
 * 원칙:
 *  - 이벤트는 append-only(사실의 기록). 상태는 이벤트에서 '유도'될 뿐 저장하지 않는다 — 규칙을 바꿔도 과거가 다시 해석된다.
 *  - 삭제 없음: 틀린 지식도 disputed로 남아 "이미 틀렸다고 판명된 길"을 알려준다(재실수 방지).
 *  - 전이 규칙은 v1 최약(임계 1회) — learning_events 철학대로 데이터를 본 뒤 임계를 조정한다(아래 상수에 근거 주석).
 * vscode/fs 의존 없음 — 파일 I/O는 bridge/contract-lib.js(appendLedgerEvent)와 확장/드라이버가 담당.
 */

export type LedgerEventType =
  | "proposed"      // 정찰 지도 ⑥이 제안함(태어남 — inferred)
  | "attached"      // 자료 꾸러미(다음 지도 생성 자료)에 재동봉됨 — 생산자: scope-package ledgerForPackage(검증 요청 동봉과는 별개 경로 — Codex 정정 2026-07-09)
  | "confirmed"     // 검증 답변이 실제로 이 결합을 확인함(추후 배선 — 스키마만 선행)
  | "refuted"       // 검증 답변이 반박함(추후 배선)
  | "user_confirm"  // 사용자 발화가 긍정함(보수적 감지 — 추후 배선)
  | "user_dispute"  // 사용자 발화가 정정함("그 파일 상관없어" — 발화 자체가 근거)
  | "pinned" | "unpinned"   // 사람 오버라이드: 고정(신뢰 차선 강제)
  | "banned" | "unbanned"   // 사람 오버라이드: 차단(완전 제외)
  | "superseded"    // 새 항목이 대체(newSig) — 원본은 남는다(direct reversal 금지)
  | "tombstone"     // 관련 파일 소멸 등으로 사실상 무효
  | "exported";     // 사용자가 저장소 MAP.md로 명시 내보냄

export type LedgerEvent = {
  ts: string; type: LedgerEventType; sig: string;
  text?: string;   // 항목 원문(최초 proposed가 들고 옴 — 이후 이벤트는 sig만으로 충분)
  from?: string;   // 출처 바인딩(어느 지도/검증대화/발화에서 왔나 — evidence_bindings 철학)
  newSig?: string; // superseded의 대체 항목
};

export type LedgerStatus = "inferred" | "verified" | "disputed" | "banned" | "superseded" | "tombstone";
export type LedgerEntry = {
  sig: string; text: string; firstTs: string; lastTs: string;
  counts: Partial<Record<LedgerEventType, number>>;
  status: LedgerStatus;
  pinned: boolean;           // 상태와 별개의 사람 고정 플래그(disputed여도 사람이 고정하면 신뢰 차선)
  lane: "trusted" | "reference" | "excluded"; // 꾸러미 회수 권한 차선(tg provenance lane)
  from: string;              // 최초 출처
  supersededBy?: string;
  rehabilitated?: boolean;   // 반박 이후 재확인으로 복권됨(정직 표기 — 반박 이력은 counts에 그대로 남음)
};

// JSONL 원문 → 이벤트 배열(깨진 줄·미지 type은 건너뜀 — 진단용 dropped 카운트 동봉).
// type 허용값 검증 이유: 임의 type이 counts에 들어가면 전이 집계를 조용히 오염시킨다(Codex 반례).
const EVENT_TYPES = new Set<string>(["proposed", "attached", "confirmed", "refuted", "user_confirm", "user_dispute", "pinned", "unpinned", "banned", "unbanned", "superseded", "tombstone", "exported"]);
export function parseEventsJsonl(raw: string): { events: LedgerEvent[]; dropped: number } {
  const events: LedgerEvent[] = [];
  let dropped = 0;
  for (const ln of String(raw || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try {
      const o = JSON.parse(ln);
      if (o && typeof o.sig === "string" && o.sig && typeof o.type === "string" && EVENT_TYPES.has(o.type)) events.push(o as LedgerEvent);
      else dropped++;
    } catch { dropped++; }
  }
  return { events, dropped };
}

// v1 전이 임계 — 최약(1회)으로 시작. 근거: '이벤트 먼저, 정책 나중'(tg learning_events) — 임계 튜닝은
// 실데이터 관측 후 별도 결정(마법 상수 고착 방지: 여기 한 곳에서만 정의하고 데이터 근거를 달아 갱신).
// 복권(rehab — 2026-07-09 사용자 결정 "지식은 진화해야"): 마지막 반박 '이후'의 확인만 인정(이전 확인은 이미
// 반박에게 진 증거) — 사람 재확인 1회는 사람 반박과 동급이라 즉시 복권, 기계(검증) 확인은 한 단계 약해 2회.
export const DERIVE_V1 = { confirmToVerify: 1, disputeToDemote: 1, rehabUserConfirm: 1, rehabVerifyConfirm: 2 };

// 이벤트 → 항목별 현재 상태(약한 전이). 우선순위(문서화된 결정, 위에서 아래로 먼저 매치):
//   banned > superseded > tombstone > disputed > verified > inferred. pinned은 상태가 아니라 차선 오버라이드.
// disputed가 verified보다 위인 이유: tg 정책 — 반박된 지식을 권위 차선에 두지 않는다(사람이 pin하면 예외).
// 단 복권(2026-07-09): 마지막 반박 '이후' 사람 재확인 1회 또는 검증 확인 2회가 쌓이면 disputed를 verified로
// 되돌린다(rehabilitated 표기 — 반박 이력은 counts에 남음). 차단·대체·소멸은 복권 대상 아님(선매치).
export function deriveLedger(events: LedgerEvent[]): LedgerEntry[] {
  const m = new Map<string, LedgerEntry>();
  const afterDispute = new Map<string, { verify: number; user: number }>(); // 마지막 반박 이후의 확인 수(복권 재료 — 이벤트 순서 기준)
  for (const e of events) {
    let it = m.get(e.sig);
    if (!it) {
      it = { sig: e.sig, text: "", firstTs: e.ts || "", lastTs: e.ts || "", counts: {}, status: "inferred", pinned: false, lane: "reference", from: "" };
      m.set(e.sig, it);
    }
    it.counts[e.type] = (it.counts[e.type] || 0) + 1;
    // attached(꾸러미 재동봉)는 최신성 갱신에서 제외 — 선별(lastTs 최신순)이 자기 선별을 다시 최신으로 만들어
    // 같은 소수 항목이 상한을 영구 점유하던 자기고정(논리 점검 #7, 2026-07-10). 판정·제안·개입 이벤트만 최신성 기여.
    if (e.ts && e.type !== "attached") it.lastTs = e.ts;
    if (e.text && !it.text) it.text = e.text;
    if (e.from && !it.from) it.from = e.from;
    if (e.type === "superseded" && e.newSig) it.supersededBy = e.newSig;
    // 복권 카운터: 반박이 오면 0으로 리셋(그 이전 확인은 무효) — '반박 이후에 다시 쌓인 확인'만 복권을 민다.
    if (e.type === "user_dispute" || e.type === "refuted") afterDispute.set(e.sig, { verify: 0, user: 0 });
    else if (e.type === "confirmed" && afterDispute.has(e.sig)) afterDispute.get(e.sig)!.verify++;
    else if (e.type === "user_confirm" && afterDispute.has(e.sig)) afterDispute.get(e.sig)!.user++;
  }
  for (const it of m.values()) {
    const c = it.counts;
    const pinNet = (c.pinned || 0) - (c.unpinned || 0);
    const banNet = (c.banned || 0) - (c.unbanned || 0);
    it.pinned = pinNet > 0;
    const disputes = (c.user_dispute || 0) + (c.refuted || 0);
    const confirms = (c.confirmed || 0) + (c.user_confirm || 0);
    if (banNet > 0) it.status = "banned";
    else if (c.superseded) it.status = "superseded";
    else if (c.tombstone) it.status = "tombstone";
    else if (disputes >= DERIVE_V1.disputeToDemote) {
      // 복권 판정 — 반박 '이후'의 확인만 본다(사람 1회 또는 검증 2회). 차단(ban)·대체·소멸은 복권 대상 아님(위에서 선매치).
      const r = afterDispute.get(it.sig) || { verify: 0, user: 0 };
      if (r.user >= DERIVE_V1.rehabUserConfirm || r.verify >= DERIVE_V1.rehabVerifyConfirm) { it.status = "verified"; it.rehabilitated = true; }
      else it.status = "disputed";
    }
    else if (confirms >= DERIVE_V1.confirmToVerify) it.status = "verified";
    else it.status = "inferred";
    // 차선: 사람 고정 > 차단 > 상태. disputed는 excluded(단 '틀림 판명' 각주로는 노출 가능 — 선별기에서 결정).
    if (it.status === "banned") it.lane = "excluded";
    else if (it.pinned) it.lane = "trusted";
    else if (it.status === "verified") it.lane = "trusted";
    else if (it.status === "inferred") it.lane = "reference";
    else it.lane = "excluded";
  }
  return [...m.values()].sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""));
}

// ── Scout Health(정찰 관찰 신호) — 전역 임계값 대신 '이 프로젝트의 장부'가 신뢰 판단 재료(사용자 결정 2026-07-09:
// 임계값은 프로젝트 구조별로 의미가 달라 고정 불가 → 헬스 신호로 프로젝트 성향에 적응). v1은 advisory 전용 —
// 어떤 자동 강제·게이트 기본값 변경도 없음. 용어 잠금: '정확도' 아님 — '관찰 신호'·'재사용 항목 중 확인 이력'
// (attached는 다음 꾸러미 재동봉 사건이지 검증자 열람 인과가 아니고, 이벤트 선후도 검사하지 않으므로 '후'를
// 주장하지 않는다)·반박은 '수동 기록 기준'(자동 추출 미배선).
// 전부 entry(항목) 단위 — 이벤트 수 합산은 반복 사건 많은 한 항목에 끌린다(Codex 보완).
export type ScoutHealth = {
  entries: number;          // 전체 항목 수(표본 게이트의 1차 분모)
  verified: number;         // 지금 신분이 '확인됨(verified)'인 항목 수(복권 포함 — pinned lane은 별개, 표시 라벨은 '확인 항목')
  reusedDen: number;        // 재사용 이력(attached≥1)이 있는 항목 수 — 비율의 분모
  reusedNum: number;        // 그중 확인 이력(confirmed/user_confirm≥1)도 있는 항목 수 ⚠순서 무주장 — '재사용 후'가 아님(이벤트 선후 미검사)
  disputedEntries: number;  // 반박 이력(user_dispute/refuted≥1) 항목 수 — 수동 기록 기준
  rehabilitated: number;    // 복권된 항목 수(분모는 disputedEntries — 이벤트 수 아님)
};
export const HEALTH_MIN_SAMPLE = 5; // 표본 게이트 — 미만이면 비율 표시 금지(범위 장부 sparse 철학·과신 방지). 지표별 분모에도 적용.
export function computeScoutHealth(entries: LedgerEntry[]): ScoutHealth {
  const h: ScoutHealth = { entries: entries.length, verified: 0, reusedDen: 0, reusedNum: 0, disputedEntries: 0, rehabilitated: 0 };
  for (const e of entries) {
    if (e.status === "verified") h.verified++;
    if ((e.counts.attached || 0) > 0) {
      h.reusedDen++;
      if ((e.counts.confirmed || 0) + (e.counts.user_confirm || 0) > 0) h.reusedNum++;
    }
    if ((e.counts.user_dispute || 0) + (e.counts.refuted || 0) > 0) h.disputedEntries++;
    if (e.rehabilitated) h.rehabilitated++;
  }
  return h;
}

// 항목 텍스트에서 경로꼴 토큰 추출(씨앗 교집합 판정용) — extractMapHighlights와 같은 보수 규칙의 축약판.
export function extractPathsFromText(text: string): string[] {
  const out: string[] = [];
  for (const tok of String(text || "").replace(/`/g, "").split(/[\s,;|"'<>{}()[\]—·↔]+/)) {
    const noLine = tok.replace(/:(\d+)(?:-\d+)?$/, ""); // 경로:라인 꼬리 제거(저장소 상대경로 계약) — contract-lib ledgerPathsFromText와 동형(논리 점검 #6)
    const t = noLine.replace(/^[^A-Za-z0-9_.\\/-]+|[^A-Za-z0-9_.\\/-]+$/g, "").replace(/[.,;:]+$/, "");
    if (!t || t.length > 200 || !/^[A-Za-z0-9_.\\/-]+$/.test(t)) continue;
    const hasSep = /[\\/]/.test(t);
    if (!hasSep && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue;
    if (hasSep && !/[A-Za-z]/.test(t.split(/[\\/]/).pop() || "")) continue;
    out.push(t.replace(/\\/g, "/").toLowerCase());
  }
  return out;
}

// 꾸러미 동봉용 선별 — 신뢰(씨앗 교집합 우선→최근순 채움)·미검증 참고·틀림 판명(재실수 방지 각주). 상한은 주입 비용 통제.
export const PKG_LEDGER_CAPS = { trusted: 8, reference: 5, disputed: 3 };
export type LedgerForPackage = { trusted: LedgerEntry[]; reference: LedgerEntry[]; disputed: LedgerEntry[] };
export function selectForPackage(entries: LedgerEntry[], seeds: string[]): LedgerForPackage {
  const seedSet = new Set((seeds || []).map((s) => String(s).replace(/\\/g, "/").toLowerCase()));
  const touches = (e: LedgerEntry) => extractPathsFromText(e.text).some((p) => seedSet.has(p));
  const pick = (pool: LedgerEntry[], cap: number) => {
    const hit = pool.filter(touches);
    const rest = pool.filter((e) => !hit.includes(e));
    return hit.concat(rest).slice(0, cap);
  };
  return {
    trusted: pick(entries.filter((e) => e.lane === "trusted"), PKG_LEDGER_CAPS.trusted),
    reference: pick(entries.filter((e) => e.lane === "reference"), PKG_LEDGER_CAPS.reference),
    disputed: pick(entries.filter((e) => e.status === "disputed" && !e.pinned), PKG_LEDGER_CAPS.disputed),
  };
}
