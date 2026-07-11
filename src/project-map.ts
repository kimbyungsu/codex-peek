/*
 * Project MAP 순수 코어(스키마 v2 — P0.5. v1 뼈대는 2026-07-10 설계 사전검증 3왕복 합의).
 * 목적: 다섯 의미 편집(분할·확대·축소·소멸·재작성)의 공통 '좌표계'가 될 프로젝트 구조 정본의 스키마·검증·
 * 직렬화·렌더·정책 계산(전부 순수 — vscode/fs 없음). ⚠현 경계(정직): adopt(정본 채택)·propose/apply
 * 배선 없음 — topology는 관측 초안(draft)이며 기존 MAP.md 확정층의 권위를 침범하지 않는다. 지도는 판단
 * '근거'가 아니라 좌표계다: 편집 제안의 근거는 코드·테스트·설정 증거(evidence)여야 하고 지도 자신은 증거가
 * 될 수 없다(자기확인 고리 차단 — 설계검증 합의).
 *
 * 모범 형식 참조: tg-chat-engine SIGNAL-WIRING-MAP.md(축 번호·Producer/Storage/Gate/Consumer·수명주기·
 * 정합 표) — 단 그 문서는 '사람이 보는 최종 뷰'의 모범이지 기계 정본이 아니므로, 여기서는 정본(topology)과
 * 생성 뷰(MAP.md)를 분리한다(같은 구조를 두 문서에 사람이 유지하면 한쪽이 반드시 낡는다 — HTML 미러 실증).
 */

export const MAP_SCHEMA_VERSION = 2; // v2(P0.5): mapId 세대 정체성·decisionLocks·provenance·description — MAP-V2-DESIGN.md §3
// v1 기본 신선도 문구(마이그레이션이 정확 일치 시에만 v2 문구로 교체 — 임의 사용자 문구는 보존: P0.5 설계검증 #5)
export const FRESHNESS_NOTE_V1_DEFAULT = "신선도 판정 미지원(v1 — verifiedHead·내용 지문 판정기는 후속)";
export const FRESHNESS_NOTE_V2 = "신선도 판정 미지원 — 유도 판정기는 후속(P4)"; // 버전 중립(v2가 스스로 v1이라 안내하던 반례 봉합)

// ── enum(설계검증 합의 — 상태는 4차원 분리: 한 enum에 합치면 전환·집계가 왜곡) ──────────────
export const LIFECYCLES = ["active", "deprecated", "superseded", "tombstoned"] as const;
export const IMPLEMENTATIONS = ["runtime", "partial", "deferred"] as const;
export const CONFIDENCES = ["confirmed", "candidate", "unknown"] as const;
// freshness는 '저장하지 않는다'(저장하면 즉시 낡는 값) — lastVerifiedAt/lastSeenAt만 저장, 판정은 유도.
// v1 판정기는 미구현: 상태 표시는 '신선도 판정 미지원'(verifiedHead·anchor 내용 지문은 후속 — 설계검증 합의).
export const ENTITY_TYPES = ["module", "store", "boundary", "external", "process"] as const;
export const ROLES = ["producer", "consumer", "gate", "authority", "storage"] as const;
// 관계 — 외부 평가 11종+imports(정적 의존 — 런타임 호출(calls)·신호 소비(consumes)와 섞으면 안 됨: 설계검증).
// 확장 규칙: 추가만 허용(제거·의미 변경은 schemaVersion 상향과 마이그레이션 동반).
export const RELATIONS = ["produces", "consumes", "stores", "filters", "calls", "validates", "mutates", "promotes", "mirrors", "owns", "supersedes", "imports"] as const;
export const ANCHOR_KINDS = ["code", "test", "config", "doc"] as const;
export const EVIDENCE_KINDS = ["ledger", "ask", "test", "code", "config", "doc"] as const;

export type Lifecycle = typeof LIFECYCLES[number];
export type Implementation = typeof IMPLEMENTATIONS[number];
export type Confidence = typeof CONFIDENCES[number];

export type Anchor = { kind: typeof ANCHOR_KINDS[number]; path: string; symbol?: string; lineHint?: number }; // 위치=증거·힌트(정체성 아님)
export type EvidenceRef = { kind: typeof EVIDENCE_KINDS[number]; ref: string; note?: string }; // ledger sig는 '한 종류·보조 연결'(단독 근거 금지)
// v2 신설(설계 §3): 설계 잠금 — 문구와 정책 참조를 한 string[]에 섞지 않는다(소비자 추측 금지 — typed graph).
// policy-ref는 effective frontier를 따라 해석(P9)·MAP.md에는 원시 참조만 표시.
export type DecisionLock = { kind: "literal"; text: string } | { kind: "policy-ref"; policyId: string };
// v2 신설: 저장소 공유 검증 기준(이식 가능한 값만 — 로컬 절대경로 금지). git은 objectFormat 결속(sha256 저장소의
// 64자 OID를 40자 상한이 거부하던 반례 — P0.5 설계검증 #4), historyless는 sha1 40hex 지문 체계 고정.
export type VerificationBasis =
  | { kind: "git"; objectFormat: "sha1" | "sha256"; head: string }
  | { kind: "historyless"; basisFp: string; inventoryFp: string };
// v2 신설: 공유 provenance — 정본은 applied decision 레코드, 여기엔 참조만(evidence 지문은 decision이 보유).
export type ProvenanceRef = { basis: VerificationBasis; decisionId: string };

export type MapNode = {
  id: string;                     // 불투명·불변(UUID — kind/label 재분류에도 불변. 표시 번호는 렌더 시 파생: 저장 안 함)
  label: string;
  entityType: typeof ENTITY_TYPES[number];
  roles: Array<typeof ROLES[number]>;   // 문맥 역할(다중 — 같은 축이 흐름마다 producer이자 consumer일 수 있음)
  state: { lifecycle: Lifecycle; implementation: Implementation; confidence: Confidence };
  anchors: Anchor[];
  steward?: string;               // 설계 책임(옵션) — 코드 위치(anchors)와 분리
  conditions?: string[];
  evidence?: EvidenceRef[];
  lastVerifiedAt?: string;        // 검증이 마지막으로 확인한 시각(신선도 '유도' 재료 — 판정기는 P4)
  notes?: string;
  description?: string;           // v2: 라벨과 분리된 서술
  decisionLocks?: DecisionLock[]; // v2: 설계 잠금(merge 동형 비교·slice·사람용 뷰 재료)
  provenance?: ProvenanceRef;     // v2: 마지막 확인의 공유 provenance(effectiveConfidence의 confirmed 권위 조건)
  // v1의 lastSeenAt(고빈도 관측치)는 v2에서 제거 — 하네스 로컬 freshness 저장소로 이동(mapHash 자기 유발 무효화 방지)
};

export type MapEdge = {
  id: string;                     // 불투명·불변 — relation과 독립(change_relation 가능해야 함)
  from: string;
  to: string;
  relation: typeof RELATIONS[number];
  state: { lifecycle: Lifecycle; implementation: Implementation; confidence: Confidence }; // 엣지도 노드와 같은 3차원(설계검증 명시)
  conditions?: string[];
  evidence?: EvidenceRef[];
  notes?: string;
  decisionLocks?: DecisionLock[]; // v2
  provenance?: ProvenanceRef;     // v2
};

// 인벤토리 완전성(설계검증 — '정규식은 실패하지 않고 조용히 틀린다'): 순회 완전성과 의미 해석 범위를 분리 기록.
export type InventoryCoverage = {
  scanComplete: boolean;          // '파일 순회'가 상한 없이 끝났는가(의미 해석 완전성 아님)
  filesSeen: number;
  policyExcluded: string[];       // 의도 제외(node_modules 등) — 미스캔 '분모'에 넣지 않는다
  depthCapped: string[];          // 깊이 상한으로 못 본 디렉터리
  entryCapped: boolean;           // 항목 상한 도달
  unreadable: string[];           // 판독 실패
  semantic: {                     // 의미 해석 범위(정규식 한계의 정직 표기)
    supportedLangs: string[];     // v1: js/ts import·require 정적 추출만(파이썬 등은 파일 분류만 — import 미해석)
    scannedSupportedFiles: number; // 'regex 스캔한 지원 파일 수' — 파싱 성공 주장 아님(parsedFiles 명칭은 과장: 검증 지적)
    unsupportedFiles: number;
    dynamicUnknowns: number;      // 동적 require(expr)·import(expr) — 대상 미상으로 셈만
    externalOrAliasSkipped: number; // 외부 패키지·경로 별칭 — 해석 제외지만 버리지 않고 셈(검증 지적)
    semanticUnreadable: string[]; // 내용 읽기 실패 — 순회 완전성(scanComplete)과 분리(검증 지적)
    parserNote: string;           // "regex 기반 — 배럴 재수출·경로 별칭 미해석(AST는 후속)"
  };
};

export type Topology = {
  schemaVersion: number;
  mapId: string;                  // v2: 지도 세대 정체성(UUID) — patch·decision·바인딩·WAL이 결속(재생성=새 세대)
  replacesMapId?: string;         // v2: 세대 전환 기록(자기 자신 금지)
  draft: boolean;                 // 정본 채택(adopt)은 P3b cutover와 함께(후속)
  project: string;
  createdAt: string;
  revision: number;               // 표시용 순번 — 정체성·CAS 근거 아님(근거는 mapHash — 설계검증)
  nodes: MapNode[];
  edges: MapEdge[];
  inventory: InventoryCoverage;
  freshnessNote: string;          // '신선도 판정 미지원' 고정 문구(허위 신선 표시 방지 — 판정기는 P4)
};

// ── 스키마 검증(불변식) ─────────────────────────────────────────────
// 예외 안전 표시 — {"toString":null} 같은 정상 JSON 객체는 템플릿 보간(String 변환) 자체가 TypeError
// (6차 반례: 검증 '전' 값을 오류 문구에 직접 보간하면 validator가 진단 대신 사망). JSON 유래 값은
// JSON.stringify로 안전, 그 외(순환 등)는 try로 방어.
function show(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v) ?? String(v); } catch { return "(표시 불가 값)"; }
}
const idOf = (v: unknown): string => (typeof v === "string" && v ? v : "(없음)");
// 스키마 밖 키 전면 거부(7차 반례: 미검사 필드에 12,000단 중첩 객체 → 검증 통과 후 mapHashOf/opHashOf가
// RangeError로 사망 + own "__proto__" 키 은닉). 정본을 해시하는 이상 '모르는 키'는 통과 자체가 결함.
function unknownKeys(v: object, allowed: readonly string[], who: string, errs: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errs.push(`${who}: 미지 필드 ${show(k)}(스키마 밖 키 금지 — canonical/CAS 오염 차단)`);
}
// 선택 문자열 필드 — 있으면 문자열이어야(7차 반례: notes:{}가 통과)
function optStr(v: unknown, who: string, name: string, errs: string[]): void {
  if (v !== undefined && typeof v !== "string") errs.push(`${who}: ${name}는 문자열이어야`);
}
const TOPO_KEYS = ["schemaVersion", "mapId", "replacesMapId", "draft", "project", "createdAt", "revision", "nodes", "edges", "inventory", "freshnessNote"] as const;
const NODE_KEYS = ["id", "label", "entityType", "roles", "state", "anchors", "steward", "conditions", "evidence", "lastVerifiedAt", "notes", "description", "decisionLocks", "provenance"] as const;
const EDGE_KEYS = ["id", "from", "to", "relation", "state", "conditions", "evidence", "notes", "decisionLocks", "provenance"] as const;
// frozen v1 키셋 — 마이그레이터의 입력 검증 전용(v1 파일의 무사망 진단 계약을 v2 이후에도 보존: P0.5 설계검증 #3)
const TOPO_KEYS_V1 = ["schemaVersion", "draft", "project", "createdAt", "revision", "nodes", "edges", "inventory", "freshnessNote"] as const;
const NODE_KEYS_V1 = ["id", "label", "entityType", "roles", "state", "anchors", "steward", "conditions", "evidence", "lastSeenAt", "lastVerifiedAt", "notes"] as const;
const EDGE_KEYS_V1 = ["id", "from", "to", "relation", "state", "conditions", "evidence", "notes"] as const;
const LOCK_KEYS_LITERAL = ["kind", "text"] as const;
const LOCK_KEYS_POLICY = ["kind", "policyId"] as const;
const PROV_KEYS = ["basis", "decisionId"] as const;
const BASIS_GIT_KEYS = ["kind", "objectFormat", "head"] as const;
const BASIS_HL_KEYS = ["kind", "basisFp", "inventoryFp"] as const;
// 스키마 사양 — v1(frozen)과 v2가 같은 강화 코어를 공유(계약 갈림 방지)
type SchemaSpec = { version: number; topoKeys: readonly string[]; nodeKeys: readonly string[]; edgeKeys: readonly string[]; v2: boolean };
const SPEC_V2: SchemaSpec = { version: 2, topoKeys: TOPO_KEYS, nodeKeys: NODE_KEYS, edgeKeys: EDGE_KEYS, v2: true };
const SPEC_V1: SchemaSpec = { version: 1, topoKeys: TOPO_KEYS_V1, nodeKeys: NODE_KEYS_V1, edgeKeys: EDGE_KEYS_V1, v2: false };
const STATE_KEYS = ["lifecycle", "implementation", "confidence"] as const;
const ANCHOR_KEYS = ["kind", "path", "symbol", "lineHint"] as const;
const EVIDENCE_KEYS = ["kind", "ref", "note"] as const;
const INV_KEYS = ["scanComplete", "filesSeen", "policyExcluded", "depthCapped", "entryCapped", "unreadable", "semantic"] as const;
const SEM_KEYS = ["supportedLangs", "scannedSupportedFiles", "unsupportedFiles", "dynamicUnknowns", "externalOrAliasSkipped", "semanticUnreadable", "parserNote"] as const;
export function validateTopology(t: Topology): string[] { return validateTopologyWith(t, SPEC_V2); }
// frozen v1 검증 — 마이그레이터 입력 전용(v1 파일도 '죽지 않고 진단' 계약 유지). 같은 강화 코어를 공유.
export function validateTopologyV1(t: unknown): string[] { return validateTopologyWith(t as Topology, SPEC_V1); }
function validateTopologyWith(t: Topology, spec: SchemaSpec): string[] {
  const errs: string[] = [];
  if (!t || typeof t !== "object") return ["topology가 객체가 아님"];
  if (t.schemaVersion !== spec.version) errs.push(`schemaVersion ${show(t.schemaVersion)} ≠ ${spec.version}`);
  if (t.draft !== true) errs.push("draft:true만 허용(정본 채택은 P3b cutover 후 — 설계검증 합의)");
  // 루트 스칼라 타입(6차 반례: 비문자열 label 등이 검증을 통과한 뒤 렌더에서 사망 — 정본 스키마의 타입 계약)
  if (typeof t.project !== "string" || !t.project) errs.push("project는 비어있지 않은 문자열이어야");
  if (typeof t.createdAt !== "string" || !t.createdAt) errs.push("createdAt은 문자열이어야");
  if (!Number.isInteger(t.revision) || (t.revision as number) < 1) errs.push("revision은 1 이상 정수여야");
  if (t.freshnessNote !== undefined && typeof t.freshnessNote !== "string") errs.push("freshnessNote는 문자열이어야");
  if (spec.v2) {
    if (!isUuid(t.mapId)) errs.push("mapId는 UUID여야(지도 세대 정체성 — patch·decision·바인딩·WAL 결속 키)");
    if (t.replacesMapId !== undefined) {
      if (!isUuid(t.replacesMapId)) errs.push("replacesMapId는 UUID여야");
      else if (t.replacesMapId === t.mapId) errs.push("replacesMapId가 자기 자신(자기 세대 대체 금지)");
    }
  }
  unknownKeys(t, spec.topoKeys, "topology", errs);
  // 외부 파일을 읽는 validator는 잘못된 형태에서 예외로 죽지 말고 진단으로 반환(3차 반례: nodes:{} → TypeError)
  if (!Array.isArray(t.nodes)) return [...errs, "nodes가 배열이 아님"];
  if (!Array.isArray(t.edges)) return [...errs, "edges가 배열이 아님"];
  const ids = new Set<string>();
  for (const n of t.nodes || []) {
    // 원소 자체가 비객체(null 등)면 접근 전에 진단 후 continue(4차 반례: nodes:[null] → TypeError 사망)
    if (!n || typeof n !== "object") { errs.push("노드 원소가 객체가 아님(null 등)"); continue; }
    if (typeof n.id !== "string" || !n.id || ids.has(n.id)) errs.push(`노드 id 누락/중복: ${idOf(n.id)}`);
    if (typeof n.id === "string" && n.id) ids.add(n.id); // 중복 집계는 유효한 ID에만
    errs.push(...validateNodeWith(n, spec));
  }
  const eids = new Set<string>();
  for (const e of t.edges || []) {
    if (!e || typeof e !== "object") { errs.push("엣지 원소가 객체가 아님(null 등)"); continue; }
    if (typeof e.id !== "string" || !e.id || eids.has(e.id) || ids.has(e.id as string)) errs.push(`엣지 id 누락/중복: ${idOf(e.id)}`);
    if (typeof e.id === "string" && e.id) eids.add(e.id);
    errs.push(...validateEdgeWith(e, spec));
    if (typeof e.from !== "string" || !ids.has(e.from)) errs.push(`엣지 ${idOf(e.id)}: from 참조 부재 ${show(e.from)}`);
    if (typeof e.to !== "string" || !ids.has(e.to)) errs.push(`엣지 ${idOf(e.id)}: to 참조 부재 ${show(e.to)}`);
  }
  // inventory 구조 검증 — 없거나 형식이 깨지면 coverage 주장 자체가 성립 안 함
  const inv = t.inventory as InventoryCoverage | null | undefined;
  if (!inv || typeof inv !== "object") errs.push("inventory 누락/불량");
  else {
    unknownKeys(inv, INV_KEYS, "inventory", errs);
    if (inv.semantic && typeof inv.semantic === "object") unknownKeys(inv.semantic, SEM_KEYS, "inventory.semantic", errs);
    if (typeof inv.scanComplete !== "boolean" || !Number.isFinite(inv.filesSeen)) errs.push("inventory: scanComplete/filesSeen 불량");
    // 배열은 원소까지 문자열 강제(3차 반례: [1]이 오류 0으로 통과 — Array.isArray만으론 계약 미성립)
    const strArr = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");
    for (const k of ["policyExcluded", "depthCapped", "unreadable"] as const) if (!strArr(inv[k])) errs.push(`inventory.${k}는 문자열 배열이어야`);
    if (typeof inv.entryCapped !== "boolean") errs.push("inventory.entryCapped 불량");
    if (!Number.isInteger(inv.filesSeen) || inv.filesSeen < 0) errs.push("inventory.filesSeen은 비음수 정수여야");
    const sem = inv.semantic;
    if (!sem || !strArr(sem.supportedLangs) || typeof sem.parserNote !== "string" || !strArr(sem.semanticUnreadable)) errs.push("inventory.semantic 불량(supportedLangs·semanticUnreadable은 문자열 배열이어야)");
    else for (const k of ["scannedSupportedFiles", "unsupportedFiles", "dynamicUnknowns", "externalOrAliasSkipped"] as const) { const v = sem[k]; if (!Number.isInteger(v) || (v as number) < 0) errs.push(`inventory.semantic.${k}은 비음수 정수여야`); }
  }
  return errs;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // 불투명 ID 강제(설계검증)
// 노드·엣지 단건 검증 — topology validator와 patch validator가 '같은 함수'를 쓴다(2차 반례: 서로 다른 계약이면
// patch 적용 시점에만 topology가 깨짐).
// 중첩 필드도 순회 전에 배열·원소를 검사(5차 반례: roles:{}·anchors:[null]·evidence:[null]·conditions:{}가
// 파싱 가능한 JSON인데 validator가 TypeError로 사망 — 외부 입력 경계 전체가 '죽지 않고 진단' 계약).
function fieldArr(v: unknown, who: string, name: string, errs: string[], required = false): unknown[] | null {
  if (v === undefined) {
    if (required) { errs.push(`${who}: ${name} 누락(배열 필요)`); return null; } // 타입상 필수 필드는 부재도 위반(6차 지적)
    return [];
  }
  if (!Array.isArray(v)) { errs.push(`${who}: ${name}가 배열이 아님`); return null; }
  return v;
}
// 문자열 UUID 검사 — {"toString":null} 같은 객체가 `v || ""`를 지나 RegExp.test의 String 변환에서 사망(6차 반례)
const isUuid = (v: unknown): boolean => typeof v === "string" && UUID_RE.test(v);
export function validateNode(n: MapNode): string[] { return validateNodeWith(n, SPEC_V2); }
function validateNodeWith(n: MapNode, spec: SchemaSpec): string[] {
  if (!n || typeof n !== "object") return ["노드가 객체가 아님"];
  const errs: string[] = [];
  const who = `노드 ${idOf(n.id)}`;
  if (!isUuid(n.id)) errs.push(`${who}: 불투명 UUID 아님`);
  if (typeof n.label !== "string" || !n.label) errs.push(`${who}: label은 비어있지 않은 문자열이어야`);
  if (!ENTITY_TYPES.includes(n.entityType)) errs.push(`${who}: entityType 불량 ${show(n.entityType)}`);
  const roles = fieldArr(n.roles, who, "roles", errs, true);
  if (roles) for (const r of roles) if (!ROLES.includes(r as typeof ROLES[number])) errs.push(`${who}: role 불량 ${show(r)}`);
  errs.push(...validateState(n.state, who));
  const anchors = fieldArr(n.anchors, who, "anchors", errs, true);
  if (anchors) for (const a of anchors as Anchor[]) errs.push(...validateAnchor(a, who));
  const evd = fieldArr(n.evidence, who, "evidence", errs);
  if (evd) for (const e of evd as EvidenceRef[]) errs.push(...validateEvidence(e, who));
  const conds = fieldArr(n.conditions, who, "conditions", errs);
  if (conds) for (const c of conds) if (typeof c !== "string" || !c.trim()) errs.push(`${who}: condition 불량`);
  optStr(n.steward, who, "steward", errs);
  optStr(n.lastVerifiedAt, who, "lastVerifiedAt", errs); optStr(n.notes, who, "notes", errs);
  if (spec.v2) {
    optStr(n.description, who, "description", errs);
    const locks = fieldArr(n.decisionLocks, who, "decisionLocks", errs);
    if (locks) for (const l of locks as DecisionLock[]) errs.push(...validateDecisionLock(l, who));
    if (n.provenance !== undefined) errs.push(...validateProvenance(n.provenance, who));
  } else {
    optStr((n as MapNode & { lastSeenAt?: unknown }).lastSeenAt, who, "lastSeenAt", errs); // v1 전용 필드
  }
  unknownKeys(n, spec.nodeKeys, who, errs);
  return errs;
}
export function validateEdge(e: MapEdge): string[] { return validateEdgeWith(e, SPEC_V2); }
function validateEdgeWith(e: MapEdge, spec: SchemaSpec): string[] {
  if (!e || typeof e !== "object") return ["엣지가 객체가 아님"];
  const errs: string[] = [];
  const who = `엣지 ${idOf(e.id)}`;
  if (!isUuid(e.id)) errs.push(`${who}: 불투명 UUID 아님`);
  if (!isUuid(e.from)) errs.push(`${who}: from이 UUID 아님`);
  if (!isUuid(e.to)) errs.push(`${who}: to가 UUID 아님`);
  if (!RELATIONS.includes(e.relation)) errs.push(`${who}: relation 불량 ${show(e.relation)}`);
  errs.push(...validateState(e.state, who));
  const evd = fieldArr(e.evidence, who, "evidence", errs);
  if (evd) for (const ev of evd as EvidenceRef[]) errs.push(...validateEvidence(ev, who));
  const conds = fieldArr(e.conditions, who, "conditions", errs);
  if (conds) for (const c of conds) if (typeof c !== "string" || !c.trim()) errs.push(`${who}: condition 불량`);
  optStr(e.notes, who, "notes", errs);
  if (spec.v2) {
    const locks = fieldArr(e.decisionLocks, who, "decisionLocks", errs);
    if (locks) for (const l of locks as DecisionLock[]) errs.push(...validateDecisionLock(l, who));
    if (e.provenance !== undefined) errs.push(...validateProvenance(e.provenance, who));
  }
  unknownKeys(e, spec.edgeKeys, who, errs);
  return errs;
}
// v2 신설 필드 검증(설계 §3 — 외부 JSON 무사망 계약 동수준: 비객체·독성·미지 키 전부 진단)
function validateDecisionLock(l: DecisionLock | null | undefined, who: string): string[] {
  if (!l || typeof l !== "object") return [`${who}: decisionLock 원소가 객체가 아님`];
  const errs: string[] = [];
  if (l.kind === "literal") {
    if (typeof l.text !== "string" || !l.text.trim()) errs.push(`${who}: decisionLock literal의 text는 비어있지 않은 문자열이어야`);
    unknownKeys(l, LOCK_KEYS_LITERAL, `${who} decisionLock`, errs);
  } else if (l.kind === "policy-ref") {
    if (!isUuid((l as { policyId?: unknown }).policyId)) errs.push(`${who}: decisionLock policy-ref의 policyId는 UUID여야`);
    unknownKeys(l, LOCK_KEYS_POLICY, `${who} decisionLock`, errs);
  } else errs.push(`${who}: decisionLock kind 불량 ${show((l as { kind?: unknown }).kind)}(literal|policy-ref)`);
  return errs;
}
function validateVerificationBasis(b: VerificationBasis | null | undefined, who: string): string[] {
  if (!b || typeof b !== "object") return [`${who}: provenance.basis가 객체가 아님`];
  const errs: string[] = [];
  if (b.kind === "git") {
    const g = b as { objectFormat?: unknown; head?: unknown };
    if (g.objectFormat === "sha1") { if (typeof g.head !== "string" || !/^[0-9a-f]{40}$/i.test(g.head)) errs.push(`${who}: basis(git/sha1) head는 40hex여야`); }
    else if (g.objectFormat === "sha256") { if (typeof g.head !== "string" || !/^[0-9a-f]{64}$/i.test(g.head)) errs.push(`${who}: basis(git/sha256) head는 64hex여야`); }
    else errs.push(`${who}: basis objectFormat 불량 ${show(g.objectFormat)}(sha1|sha256 — 축약 해시 금지)`);
    unknownKeys(b, BASIS_GIT_KEYS, `${who} basis`, errs);
  } else if (b.kind === "historyless") {
    const h = b as { basisFp?: unknown; inventoryFp?: unknown };
    if (typeof h.basisFp !== "string" || !/^[0-9a-f]{40}$/i.test(h.basisFp)) errs.push(`${who}: basis(historyless) basisFp는 sha1 40hex여야`);
    if (typeof h.inventoryFp !== "string" || !/^[0-9a-f]{40}$/i.test(h.inventoryFp)) errs.push(`${who}: basis(historyless) inventoryFp는 sha1 40hex여야`);
    unknownKeys(b, BASIS_HL_KEYS, `${who} basis`, errs);
  } else errs.push(`${who}: basis kind 불량 ${show((b as { kind?: unknown }).kind)}(git|historyless — sentinel 흉내 금지)`);
  return errs;
}
function validateProvenance(p: ProvenanceRef | null | undefined, who: string): string[] {
  if (!p || typeof p !== "object") return [`${who}: provenance가 객체가 아님`];
  const errs: string[] = [];
  errs.push(...validateVerificationBasis(p.basis, who));
  if (!isUuid(p.decisionId)) errs.push(`${who}: provenance.decisionId는 UUID여야`);
  unknownKeys(p, PROV_KEYS, `${who} provenance`, errs);
  return errs;
}
// anchor·evidence 원소의 전체 필드 타입(6차 지적: path·ref가 숫자 42여도 truthy로 통과 → 렌더/canonical에서 사망)
function validateAnchor(a: Anchor | null | undefined, who: string): string[] {
  if (!a || typeof a !== "object") return [`${who}: anchor 불량`];
  const errs: string[] = [];
  if (!ANCHOR_KINDS.includes(a.kind) || typeof a.path !== "string" || !a.path) errs.push(`${who}: anchor 불량`);
  if (a.symbol !== undefined && typeof a.symbol !== "string") errs.push(`${who}: anchor.symbol은 문자열이어야`);
  if (a.lineHint !== undefined && !Number.isInteger(a.lineHint)) errs.push(`${who}: anchor.lineHint는 정수여야`);
  unknownKeys(a, ANCHOR_KEYS, who, errs);
  return errs;
}
function validateEvidence(e: EvidenceRef | null | undefined, who: string): string[] {
  if (!e || typeof e !== "object") return [`${who}: evidence 불량`];
  const errs: string[] = [];
  if (!EVIDENCE_KINDS.includes(e.kind) || typeof e.ref !== "string" || !e.ref) errs.push(`${who}: evidence 불량`);
  if (e.note !== undefined && typeof e.note !== "string") errs.push(`${who}: evidence.note는 문자열이어야`);
  unknownKeys(e, EVIDENCE_KEYS, who, errs);
  return errs;
}
function validateState(s: { lifecycle: Lifecycle; implementation: Implementation; confidence: Confidence } | undefined, who: string): string[] {
  if (!s || typeof s !== "object") return [`${who}: state 누락/불량`];
  const errs: string[] = [];
  if (!LIFECYCLES.includes(s.lifecycle)) errs.push(`${who}: lifecycle 불량 ${show(s.lifecycle)}`);
  if (!IMPLEMENTATIONS.includes(s.implementation)) errs.push(`${who}: implementation 불량 ${show(s.implementation)}`);
  if (!CONFIDENCES.includes(s.confidence)) errs.push(`${who}: confidence 불량 ${show(s.confidence)}`);
  unknownKeys(s, STATE_KEYS, who + " state", errs);
  return errs;
}

// ── canonical 직렬화+지문 — 같은 구조는 항상 같은 바이트(키 정렬·배열 안정 정렬·CAS의 근거) ─────
export function canonicalSerialize(t: Topology): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      // null-프로토타입 — own "__proto__" 키가 일반 {}에선 프로토타입 대입으로 소실돼 서로 다른 JSON이
      // 같은 CAS 지문을 얻던 반례 봉합(7차). 스키마 검증도 미지 키를 거부하지만 직렬화기 자체도 방어.
      const o: Record<string, unknown> = Object.create(null);
      for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  const copy: Topology = JSON.parse(JSON.stringify(t));
  // 집합 의미 배열은 '전부' canonical 정렬(검증 반례: conditions/evidence/policyExcluded 순서만 달라도 지문이
  // 갈라져 CAS 거짓 충돌 — 파일시스템 순회 순서는 플랫폼 의존). v1 스키마에 '순서가 의미 있는 배열'은 없음.
  const evKey = (e: EvidenceRef) => e.kind + "|" + e.ref + "|" + (e.note || "");
  const lockKey = (l: DecisionLock) => l.kind + "|" + (l.kind === "literal" ? l.text : (l as { policyId: string }).policyId); // v2 집합 배열 — canonical 등록(누락 시 입력 순서가 지문에 남음)
  copy.nodes = [...(copy.nodes || [])].sort((a, b) => a.id.localeCompare(b.id));
  copy.edges = [...(copy.edges || [])].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of copy.nodes) {
    n.roles = [...(n.roles || [])].sort();
    if (n.anchors) n.anchors = [...n.anchors].sort((a, b) => (a.kind + "|" + a.path + "|" + (a.symbol || "") + "|" + (a.lineHint ?? "")).localeCompare(b.kind + "|" + b.path + "|" + (b.symbol || "") + "|" + (b.lineHint ?? ""))); // 전체 키(kind·lineHint 포함 — 부분 키는 입력 순서가 지문에 남음: 2차 반례)
    if (n.conditions) n.conditions = [...n.conditions].sort();
    if (n.evidence) n.evidence = [...n.evidence].sort((a, b) => evKey(a).localeCompare(evKey(b)));
    if (n.decisionLocks) n.decisionLocks = [...n.decisionLocks].sort((a, b) => lockKey(a).localeCompare(lockKey(b)));
  }
  for (const e of copy.edges) {
    if (e.conditions) e.conditions = [...e.conditions].sort();
    if (e.evidence) e.evidence = [...e.evidence].sort((a, b) => evKey(a).localeCompare(evKey(b)));
    if (e.decisionLocks) e.decisionLocks = [...e.decisionLocks].sort((a, b) => lockKey(a).localeCompare(lockKey(b)));
  }
  if (copy.inventory) {
    copy.inventory.policyExcluded = [...(copy.inventory.policyExcluded || [])].sort();
    copy.inventory.depthCapped = [...(copy.inventory.depthCapped || [])].sort();
    copy.inventory.unreadable = [...(copy.inventory.unreadable || [])].sort();
    if (copy.inventory.semantic && Array.isArray(copy.inventory.semantic.semanticUnreadable)) copy.inventory.semantic.semanticUnreadable = [...copy.inventory.semantic.semanticUnreadable].sort(); // 새 집합 배열도 등록(2차 반례 — 스키마에 배열 추가 시 canonical 등록 누락 주의)
    if (copy.inventory.semantic) copy.inventory.semantic.supportedLangs = [...(copy.inventory.semantic.supportedLangs || [])].sort();
  }
  return JSON.stringify(sortKeys(copy), null, 1);
}
export function mapHashOf(t: Topology): string {
  return require("crypto").createHash("sha1").update(canonicalSerialize(t)).digest("hex");
}

// ── v1→v2 결정론 마이그레이터(P0.5 — 설계 §3) ──────────────────────────────
// '결정론'=동일 v1 입력이면 어느 clone·브랜치에서 실행해도 동일 v2 출력(P0.5 설계검증 #2: 실사용 randomUUID는
// 두 clone이 서로 다른 mapId 세대를 만들어 patch·decision·바인딩 결속이 갈라짐). mapId는 v1 canonical 내용
// 지문+고정 네임스페이스에서 유도한다.
export function deterministicMapIdFromV1(v1: Topology): string {
  const hex: string = require("crypto").createHash("sha1")
    .update("codex-bridge:project-map:v1->v2:" + canonicalSerialize(v1)).digest("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}
// 순서 계약(P0.5 설계검증 #3): schemaVersion===1 확인 → frozen v1 전체 검증(무사망 진단) → 변환 → v2 전체 검증.
// 유효하지 않은 v1은 topo:null+진단으로 반환하고 입력을 한 바이트도 바꾸지 않는다(깊은 복사 후 변환).
export function migrateTopologyV1toV2(t: unknown): { topo: Topology | null; errors: string[] } {
  if (!t || typeof t !== "object") return { topo: null, errors: ["topology가 객체가 아님"] };
  if ((t as Topology).schemaVersion !== 1) return { topo: null, errors: [`schemaVersion ${show((t as Topology).schemaVersion)} — v1(1)만 마이그레이션 대상`] };
  const v1errs = validateTopologyV1(t);
  if (v1errs.length) return { topo: null, errors: v1errs };
  const mapId = deterministicMapIdFromV1(t as Topology);
  const copy = JSON.parse(JSON.stringify(t)) as Topology & { nodes: Array<MapNode & { lastSeenAt?: string }> };
  copy.schemaVersion = MAP_SCHEMA_VERSION;
  copy.mapId = mapId;
  for (const n of copy.nodes) delete n.lastSeenAt; // 고빈도 관측치 — v2에서 하네스 로컬로 이동(유실 무해: 설계 1-2)
  if (copy.freshnessNote === FRESHNESS_NOTE_V1_DEFAULT) copy.freshnessNote = FRESHNESS_NOTE_V2; // 알려진 기본 문구만 교체·임의 문구 보존(#5)
  const v2errs = validateTopology(copy);
  return v2errs.length ? { topo: null, errors: v2errs.map((e) => "변환 결과 v2 위반 — " + e) } : { topo: copy, errors: [] };
}

// ── coverage 3분리(설계검증 — 파일/그래프/증거는 단위가 달라 한 비율로 못 합침) ─────────────
export function graphCoverage(t: Topology): { nodes: Record<Confidence, number>; edges: Record<Confidence, number> } {
  const zero = (): Record<Confidence, number> => ({ confirmed: 0, candidate: 0, unknown: 0 });
  const nodes = zero(), edges = zero();
  for (const n of t.nodes || []) nodes[n.state.confidence]++;
  for (const e of t.edges || []) edges[e.state.confidence]++;
  return { nodes, edges };
}

// ── patch envelope 형식(형식+순수 계산까지 — CLI 배선(propose/apply)은 P2) ──────────
// append-only: patch 자체는 불변, 상태는 decisions의 전이 이벤트로 유도. tier는 제출자 신뢰 안 함 — 정책기가 산출.
export const PATCH_OPS = ["add_node", "add_edge", "set_state", "add_anchor", "add_evidence", "add_condition", "change_relation", "retire_candidate"] as const; // split/merge/change_owner는 스키마 예약(후속 — 대형 연산)
export type PatchOp = typeof PATCH_OPS[number];
export type MapPatch = {
  patchId: string;                // UUID
  baseMapHash: string;            // CAS 1(revision 아님 — 같은 revision·다른 내용 위조 차단)
  baseHead: string;               // CAS 2(git HEAD)
  baseDirtyFp: string;            // CAS 3(미커밋 지문 — ⚠project-map/** 제외: 제안 기록이 자기 CAS를 깨는 반례 봉합)
  operation: PatchOp;
  targetId?: string;
  payload: Record<string, unknown>;   // op별 형식(기대 이전값 expect·역연산 inverse 포함 — 검증기가 op별 필수 필드 강제)
  evidence: EvidenceRef[];        // 지도 자신은 증거 불가 — code/test/config 계열 최소 1개(정책기 검사)
  rationale: string;
};
export type MapDecision = {
  decisionId: string;             // 전역 고유(병합 합집합 의미 — 중복 제거 키)
  patchId: string;
  action: "approve" | "reject" | "applied";
  actor: string;
  ts: string;
  opHash?: string;                // approve에 payload 지문 동봉(pending이 로컬이라 타 clone 감사·복구용 — 설계검증)
  payload?: Record<string, unknown>; // approve에 적용 payload의 불변 사본
  expectedMapHashAfter?: string;  // 복구 3분기 판정 재료
  appliedRevision?: number;
  mapHashAfter?: string;
  reason?: string;
};

// tier 정책기 — operation 이름만으로 못 정한다(설계검증: 같은 set_state라도 stale 표시는 자동, tombstone은 사람).
export function policyTier(op: PatchOp, payload: Record<string, unknown>): "auto" | "verified-auto" | "human" {
  if (op === "add_evidence") return "auto";                       // 증거 추가(사실 기록)
  if (op === "add_anchor") return "auto";                         // 탐색 힌트 추가
  if (op === "set_state") {
    const to = (payload && (payload.to as Record<string, string>)) || {};
    const from = (payload && (payload.expect as Record<string, string>)) || {};
    if (to.lifecycle === "tombstoned" || to.lifecycle === "superseded") return "human"; // 소멸·대체 '확정'은 항상 사람(자동은 후보 감지까지만)
    if (from.lifecycle === "tombstoned" || from.lifecycle === "superseded") return "human"; // '복원'도 사람(검증 반례: tombstoned→active가 verified-auto로 통과)
    if (to.confidence === "confirmed") return "verified-auto";    // 승격은 검증 통과 조건부
    return "verified-auto";                                        // active↔partial 등
  }
  if (op === "add_node" || op === "add_edge" || op === "add_condition") return "verified-auto"; // 확대·조건 추가
  if (op === "change_relation" || op === "retire_candidate") return "human"; // 관계 의미 변경·후보 폐기
  return "human"; // 미지 연산은 보수
}

// patch 형식 검증 — op별 payload '내용'까지(존재 검사만으론 빈 payload·스키마 우회가 auto로 통과: 검증 반례).
const UUID_RE_P = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stateFieldsValid(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, string>;
  const ks = Object.keys(o);
  if (!ks.length) return false;
  for (const k of ks) {
    if (k === "lifecycle") { if (!LIFECYCLES.includes(o[k] as Lifecycle)) return false; }
    else if (k === "implementation") { if (!IMPLEMENTATIONS.includes(o[k] as Implementation)) return false; }
    else if (k === "confidence") { if (!CONFIDENCES.includes(o[k] as Confidence)) return false; }
    else return false; // 미지 필드 금지
  }
  return true;
}
// 문자열일 때만 regex — {"toString":null} 같은 객체는 `v || ""`를 지나 test()의 String 변환에서 사망(6차 반례와
// 같은 경계: patch·decision도 외부 JSON에서 온다).
const strTest = (re: RegExp, v: unknown): boolean => typeof v === "string" && re.test(v);
const PATCH_KEYS = ["patchId", "baseMapHash", "baseHead", "baseDirtyFp", "operation", "targetId", "payload", "evidence", "rationale"] as const;
const DECISION_KEYS = ["decisionId", "patchId", "action", "actor", "ts", "opHash", "payload", "expectedMapHashAfter", "appliedRevision", "mapHashAfter", "reason"] as const;
const PAYLOAD_KEYS: Partial<Record<PatchOp, readonly string[]>> = {
  set_state: ["to", "expect"], add_node: ["node"], add_edge: ["edge"], add_anchor: ["anchor"],
  add_evidence: ["evidence"], add_condition: ["condition"], change_relation: ["to", "expect", "inverse"], retire_candidate: ["expect"],
};
export function validatePatch(p: MapPatch): string[] {
  if (!p || typeof p !== "object") return ["patch가 객체가 아님"];
  const errs: string[] = [];
  if (!strTest(UUID_RE_P, p.patchId)) errs.push("patchId는 UUID여야");
  if (!strTest(/^[0-9a-f]{40}$/, p.baseMapHash)) errs.push("baseMapHash는 canonical sha1(40자)이어야");
  if (!strTest(/^[0-9a-f]{7,40}$/i, p.baseHead)) errs.push("baseHead는 git 커밋 해시(7~40 hex)여야");
  if (typeof p.baseDirtyFp !== "string") errs.push("baseDirtyFp 누락(project-map/** 제외 지문)");
  if (!PATCH_OPS.includes(p.operation)) errs.push(`operation 불량 ${show(p.operation)}`);
  if (typeof p.rationale !== "string" || !p.rationale.trim()) errs.push("rationale 필요");
  if (!Array.isArray(p.evidence) || !p.evidence.length) errs.push("evidence 최소 1개 필요");
  else {
    for (const e of p.evidence) if (validateEvidence(e, "x").length) errs.push("evidence 항목 불량"); // topology와 같은 함수(note 타입 포함 — 7차: 계약 갈림)
    if (!p.evidence.some((e) => e && typeof e === "object" && (e.kind === "code" || e.kind === "test" || e.kind === "config"))) errs.push("code/test/config 계열 증거 최소 1개(지도·문구 단독 근거 금지 — 자기확인 고리 차단)");
  }
  unknownKeys(p, PATCH_KEYS, "patch", errs);
  const pl = (p.payload && typeof p.payload === "object" ? p.payload : {}) as Record<string, unknown>;
  // 프로퍼티 키 접근은 String 변환을 유발 — 독성 객체 operation은 enum 확인 후에만 조회(6차와 같은 사망 경로)
  const plAllowed = PATCH_OPS.includes(p.operation) ? PAYLOAD_KEYS[p.operation] : undefined;
  if (plAllowed) unknownKeys(pl, plAllowed, "payload", errs); // payload도 스키마 밖 키 금지(opHash 대상 — 깊은 정크 차단)
  const canonState = (v: unknown) => JSON.stringify(Object.fromEntries(Object.entries((v as Record<string, string>) || {}).sort()));
  switch (p.operation) {
    case "set_state": {
      if (!stateFieldsValid(pl.to) || !stateFieldsValid(pl.expect)) { errs.push("set_state: to·expect가 상태 필드(enum)여야"); break; }
      const toKeys = Object.keys(pl.to as object).sort().join(",");
      const exKeys = Object.keys(pl.expect as object).sort().join(",");
      if (toKeys !== exKeys) errs.push("set_state: to와 expect의 필드 집합이 같아야(바꾸는 필드의 기존값을 확인 — 필드 CAS: 2차 반례)");
      else if (canonState(pl.to) === canonState(pl.expect)) errs.push("set_state: to=expect(무의미 변경 — canonical 비교)");
      break;
    }
    case "add_node": {
      const errsN = validateNode(pl.node as MapNode); // topology validator와 '같은 함수'(계약 갈림 방지 — 2차 반례)
      if (errsN.length) errs.push("add_node: payload.node가 노드 스키마 위반 — " + errsN[0]);
      break;
    }
    case "add_edge": {
      const errsE = validateEdge(pl.edge as MapEdge);
      if (errsE.length) errs.push("add_edge: payload.edge가 엣지 스키마 위반 — " + errsE[0]);
      break;
    }
    case "add_anchor": {
      if (validateAnchor(pl.anchor as Anchor | undefined, "x").length) errs.push("add_anchor: payload.anchor 불량"); // topology와 같은 함수
      break;
    }
    case "add_evidence": {
      if (validateEvidence(pl.evidence as EvidenceRef | undefined, "x").length) errs.push("add_evidence: payload.evidence 불량");
      break;
    }
    case "add_condition":
      if (typeof pl.condition !== "string" || !(pl.condition as string).trim()) errs.push("add_condition: payload.condition(비어있지 않은 문자열) 필요");
      break;
    case "change_relation":
      if (!RELATIONS.includes(pl.to as typeof RELATIONS[number]) || !RELATIONS.includes(pl.expect as typeof RELATIONS[number]) || typeof pl.inverse !== "string" || !pl.inverse) errs.push("change_relation: to·expect(관계 enum)·inverse(역연산 — 비어있지 않은 문자열) 필요");
      break;
    case "retire_candidate":
      if (!stateFieldsValid(pl.expect)) errs.push("retire_candidate: expect(현 상태) 필요");
      break;
  }
  // targetId 계약(8차 반례): 대상 필수 6개 op는 UUID 강제, 대상 없는 add_node/add_edge는 존재 자체 거부
  // (PATCH_KEYS가 전 op에 targetId를 허용해 12,000단 중첩 targetId가 검증을 통과 → approve의 opHashOf 사망).
  if (p.targetId !== undefined && !strTest(UUID_RE_P, p.targetId)) errs.push("targetId는 UUID여야");
  if ((p.operation === "add_node" || p.operation === "add_edge") && p.targetId !== undefined) errs.push(`${show(p.operation)}: targetId 금지(대상 없는 연산)`);
  if ((p.operation === "set_state" || p.operation === "add_anchor" || p.operation === "add_evidence" || p.operation === "add_condition" || p.operation === "change_relation" || p.operation === "retire_candidate") && !strTest(UUID_RE_P, p.targetId)) errs.push(`${show(p.operation)}: targetId 필요(대상 UUID)`);
  return errs;
}
// decision 검증 — approve는 복구 계약 필수 필드(opHash·payload 사본·expectedMapHashAfter)를 강제(선택이면 복구 불능 레코드 허용: 검증 반례).
export function validateDecision(d: MapDecision): string[] {
  if (!d || typeof d !== "object") return ["decision이 객체가 아님"];
  const errs: string[] = [];
  if (!strTest(UUID_RE_P, d.decisionId)) errs.push("decisionId는 UUID여야(병합 합집합 키)");
  if (!strTest(UUID_RE_P, d.patchId)) errs.push("patchId는 UUID여야");
  if (!["approve", "reject", "applied"].includes(d.action)) errs.push("action 불량");
  if (typeof d.actor !== "string" || !d.actor || typeof d.ts !== "string" || !d.ts) errs.push("actor·ts 필요(문자열)");
  if (d.action === "approve") {
    if (!strTest(/^[0-9a-f]{40}$/, d.expectedMapHashAfter)) errs.push("approve: expectedMapHashAfter 필수(복구 3분기 재료)");
    // 재적용 가능한 '정규화 patch 사본' 강제 — payload:{x:1} 같은 임의 객체로는 다른 clone에서 무엇을 어디에
    // 적용할지 알 수 없다(2차 반례). 3차 반례 봉합: 사본은 validatePatch '전체' 통과여야 하고(세 필드 존재만으론
    // evidence·payload 없는 불완전 사본이 통과), decision.patchId와 결합돼야 한다(patch A를 가리키며 B를 담는 위조 차단).
    // opHash는 검증기가 직접 재계산해 대조(임의 hex 통과 차단 — 단 opHash는 '불변'만 증명, 완전성은 validatePatch가 증명).
    const pc = d.payload as Partial<MapPatch> | undefined;
    if (!pc || typeof pc !== "object") {
      errs.push("approve: payload는 정규화 patch 사본(operation·baseMapHash·baseHead 포함)이어야");
    } else {
      const pErrs = validatePatch(pc as MapPatch);
      if (pErrs.length) errs.push("approve: payload가 유효한 patch 사본이 아님(재적용 불능) — " + pErrs[0]);
      else if (pc.patchId !== d.patchId) errs.push("approve: payload.patchId가 decision.patchId와 불일치(다른 patch 결합 금지)");
      else if (opHashOf(pc as Record<string, unknown>) !== d.opHash) errs.push("approve: opHash가 payload 사본의 재계산 지문과 불일치(임의 hex 금지 — 깊은 정렬 지문)");
    }
  }
  if (d.action === "applied" && !strTest(/^[0-9a-f]{40}$/, d.mapHashAfter)) errs.push("applied: mapHashAfter 필수");
  // 선택 필드도 있으면 타입 강제(7차 지적: P2 배선 전에 외부 레코드 계약을 닫는다)
  if (d.opHash !== undefined && !strTest(/^[0-9a-f]{40}$/, d.opHash)) errs.push("opHash는 sha1(40자 hex)이어야");
  if (d.mapHashAfter !== undefined && !strTest(/^[0-9a-f]{40}$/, d.mapHashAfter)) errs.push("mapHashAfter는 sha1(40자 hex)이어야");
  if (d.appliedRevision !== undefined && (!Number.isInteger(d.appliedRevision) || d.appliedRevision < 1)) errs.push("appliedRevision은 1 이상 정수여야");
  if (d.reason !== undefined && typeof d.reason !== "string") errs.push("reason은 문자열이어야");
  if (d.payload !== undefined && (typeof d.payload !== "object" || d.payload === null)) errs.push("payload는 객체여야");
  // action별 허용 필드(8차 지적: reject에 payload·expectedMapHashAfter가 통과 — approve 전용 필드는 approve에만)
  const commonD = ["decisionId", "patchId", "action", "actor", "ts", "reason"];
  const byAction: Record<string, readonly string[]> = {
    approve: [...commonD, "opHash", "payload", "expectedMapHashAfter"],
    applied: [...commonD, "appliedRevision", "mapHashAfter"],
    reject: commonD,
  };
  const allowedD = ["approve", "reject", "applied"].includes(d.action) ? byAction[d.action] : DECISION_KEYS; // 독성 action은 키 조회 전에 배제
  unknownKeys(d, allowedD, "decision", errs);
  return errs;
}

// patch 사본의 정규화 지문 — 깊은 키 정렬 후 sha1(얕은 replacer는 중첩 키를 유실). approve validator와
// 이후 CLI(P2)가 '같은 함수'를 쓴다.
export function opHashOf(payload: Record<string, unknown>): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = Object.create(null); // own "__proto__" 키 소실 방지(7차 — canonical과 동일)
      for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  return require("crypto").createHash("sha1").update(JSON.stringify(sortKeys(payload))).digest("hex");
}

// 복구 3분기(설계검증 — 'baseMapHash 재검사'만으론 이미 적용과 제3 변경을 구분 못 함):
export function recoveryDecision(currentHash: string, baseHash: string, expectedAfter: string): "apply" | "supplement-applied" | "conflict" {
  if (currentHash === baseHash) return "apply";
  if (currentHash === expectedAfter) return "supplement-applied";
  return "conflict";
}

// dirty fingerprint 입력 필터 — project-map/** 제외(제안 기록·지도 갱신이 자기 CAS를 깨지 않게).
export function dirtyFpFilter(paths: string[]): string[] {
  return (paths || []).filter((p) => !String(p).replace(/\\/g, "/").startsWith("project-map/"));
}

// ── 생성 뷰(MAP.md) — 정본에서 자동 생성·직접 수정 금지(hash 머리말로 수동 수정 탐지) ──────────
export function renderMapMd(t: Topology): string {
  const hash = mapHashOf(t);
  const gc = graphCoverage(t);
  // 표시 번호는 저장하지 않고 렌더 시 안정 정렬로 파생(설계검증 — 저장하면 재배치·중복 불변식이 필요해짐)
  const nodesSorted = [...(t.nodes || [])].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const no = new Map(nodesSorted.map((n, i) => [n.id, i + 1]));
  const lines: string[] = [];
  lines.push(`# Project MAP — ${t.project} (draft)`);
  lines.push("");
  lines.push(`> ⚠ 생성 문서 — 직접 수정 금지(정본: project-map/topology.json). 원본 지문: \`${hash}\``);
  lines.push(`> schema v${t.schemaVersion} · revision ${t.revision} · ${t.draft ? "DRAFT(관측 초안 — 확정층 아님)" : ""} · ${t.freshnessNote}`);
  lines.push("");
  lines.push(`## Coverage`);
  lines.push(`- 그래프: 노드 confirmed ${gc.nodes.confirmed} / candidate ${gc.nodes.candidate} / unknown ${gc.nodes.unknown} · 엣지 confirmed ${gc.edges.confirmed} / candidate ${gc.edges.candidate} / unknown ${gc.edges.unknown}`);
  lines.push(`- 인벤토리: 파일 ${t.inventory.filesSeen}개 순회 ${t.inventory.scanComplete ? "완료" : "미완"} · regex 스캔 ${t.inventory.semantic.scannedSupportedFiles}/${t.inventory.semantic.scannedSupportedFiles + t.inventory.semantic.unsupportedFiles}(지원 언어: ${t.inventory.semantic.supportedLangs.join(", ")} — 파싱 보장 아님) · 동적 참조 미상 ${t.inventory.semantic.dynamicUnknowns}건 · 외부/별칭 ${t.inventory.semantic.externalOrAliasSkipped}건`);
  lines.push(`- 한계: ${t.inventory.semantic.parserNote}${t.inventory.depthCapped.length ? ` · 깊이 상한으로 못 본 구역 ${t.inventory.depthCapped.length}곳` : ""}${t.inventory.unreadable.length ? ` · 판독 실패 ${t.inventory.unreadable.length}건` : ""}`);
  lines.push("");
  lines.push(`## Nodes`);
  lines.push(`| # | label | type | roles | lifecycle | impl | confidence | anchors |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const n of nodesSorted) {
    lines.push(`| ${no.get(n.id)} | ${n.label} | ${n.entityType} | ${(n.roles || []).join("·") || "—"} | ${n.state.lifecycle} | ${n.state.implementation} | ${n.state.confidence} | ${(n.anchors || []).slice(0, 3).map((a) => a.path + (a.lineHint ? ":" + a.lineHint : "")).join("<br>") || "—"} |`);
  }
  lines.push("");
  lines.push(`## Edges`);
  lines.push(`| from | relation | to | lifecycle | confidence | conditions |`);
  lines.push(`|---|---|---|---|---|---|`);
  const edgesSorted = [...(t.edges || [])].sort((a, b) => a.id.localeCompare(b.id));
  for (const e of edgesSorted) {
    const fl = t.nodes.find((n) => n.id === e.from)?.label || e.from;
    const tl = t.nodes.find((n) => n.id === e.to)?.label || e.to;
    lines.push(`| ${fl}(#${no.get(e.from) ?? "?"}) | ${e.relation} | ${tl}(#${no.get(e.to) ?? "?"}) | ${e.state.lifecycle} | ${e.state.confidence} | ${(e.conditions || []).join("; ") || "—"} |`);
  }
  lines.push("");
  lines.push(`## Unknown / 미해석`);
  lines.push(t.inventory.depthCapped.length || t.inventory.unreadable.length || t.inventory.semantic.dynamicUnknowns
    ? [...t.inventory.depthCapped.map((d) => `- (깊이 상한) ${d}`), ...t.inventory.unreadable.map((u) => `- (판독 실패) ${u}`), ...(t.inventory.semantic.dynamicUnknowns ? [`- (동적 참조 미상) ${t.inventory.semantic.dynamicUnknowns}건 — 대상 미해석`] : [])].join("\n")
    : "- 없음(현 스캔 정책 기준)");
  lines.push("");
  return lines.join("\n");
}
// 생성 뷰 수동 수정 탐지 — '전문' 비교(머리말 지문만 보면 본문 낙서를 놓침: 검증 반례).
export function mapMdMatches(md: string, t: Topology): boolean {
  return String(md || "") === renderMapMd(t);
}
