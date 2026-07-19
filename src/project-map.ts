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
  if (!Number.isSafeInteger(t.revision) || (t.revision as number) < 1) errs.push("revision은 1 이상 안전 정수여야(2^53-1 초과=+1 불능 — 순환 offset 정지 차단: 7차 [보완])");
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
// P4(설계 v8 — historyless 자기참조 해소): provenance 필드를 제외한 '구조 해시'. v3 historyless
// VerificationBasis.basisFp의 유일 출처 — provenance 주입 '전'에 계산 가능하고(순환 없음) provenance만의
// 변경에는 불변이다. ⚠dual basis 불변식: PatchBasis.basisFp·mapHashAfter·audit·snapshot·WAL·authorityHash는
// 계속 mapHashOf(full — provenance 포함)를 쓴다. 이 함수로 교체 금지.
export function structuralHashOf(t: Topology): string {
  const copy = JSON.parse(JSON.stringify(t)) as Topology;
  for (const n of copy.nodes || []) delete (n as { provenance?: unknown }).provenance;
  for (const e of copy.edges || []) delete (e as { provenance?: unknown }).provenance;
  return mapHashOf(copy);
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

// ═══════════════════════════════════════════════════════════════════════════════
// P2 patch pipeline 코어(순수) — 설계 정본 MAP-P2-DESIGN.md(사전검증 9차 확정)의 §C·§D·§E 구현.
// v1 patch 계층(PATCH_OPS·validatePatch·validateDecision·policyTier)은 동결 — v2는 전부 신규 이름(§I).
// fs·시계 없음: 파일 지문·현재 시각이 필요한 검사는 호출부(bridge/map-pipeline.js)가 값을 주입한다.
// ═══════════════════════════════════════════════════════════════════════════════

// ── 공용: canonical 직렬화·도메인 분리 해시(§E — 구분자는 실제 NUL 바이트) ──────────
const sortKeysDeep = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = Object.create(null); // own "__proto__" 키 소실 방지(v1 canonical과 동일)
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
};
export function canonicalJsonOf(v: unknown): string { return JSON.stringify(sortKeysDeep(v)); }
// 무사망 계약(구현 1차 #1): 검증기가 통과시킨 값은 재귀 정규화(opHashOf·canonicalJsonOf)가 처리 가능해야
// 한다 — 자유 확장을 허용하는 필드(predicateExpr 등)는 깊이·크기를 비재귀로 상한 검사한다.
export const FREE_FIELD_MAX_DEPTH = 16;
export function deepShapeOk(v: unknown, maxDepth: number): boolean {
  const stack: Array<{ v: unknown; d: number }> = [{ v, d: 0 }];
  let visited = 0;
  while (stack.length) {
    const { v: cur, d } = stack.pop() as { v: unknown; d: number };
    if (++visited > 10000) return false; // 항목 수 상한(폭 폭주)
    if (d > maxDepth) return false;
    if (cur === null) continue;
    const ty = typeof cur;
    if (ty === "object") {
      const proto = Object.getPrototypeOf(cur);
      if (!Array.isArray(cur) && proto !== Object.prototype && proto !== null) return false; // plain object만(Date·Map 등 거부)
      const vals = Array.isArray(cur) ? cur : Object.values(cur as object);
      for (const x of vals) stack.push({ v: x, d: d + 1 });
    } else if (ty === "string" || ty === "boolean") continue;
    else if (ty === "number") { if (!Number.isFinite(cur)) return false; } // NaN·Infinity 거부
    else return false; // bigint·symbol·undefined·function — JSON 비호환(2차 #1: 검증 통과 후 직렬화 사망 차단)
  }
  return true;
}
const NUL = "\u0000";
function domHash(domain: string, body: string): string {
  return require("crypto").createHash("sha1").update(domain + NUL + body, "utf8").digest("hex");
}

// ── 타입: basis·origin(1-1 세 타입 중 P2 소관 2종 — VerificationBasis는 P0.5에 기존) ──────
// PatchBasis: CAS용 — patch·pending·WAL에 결속. oidFormat은 VerificationBasis의 objectFormat 선례(SHA-256 레포).
export type PatchBasis =
  | { kind: "git"; ref: { type: "branch"; name: string } | { type: "detached"; head: string }; baseHead: string; oidFormat: "sha1" | "sha256" }
  | { kind: "historyless"; basisFp: string; inventoryFp: string };
// ExecutionOrigin: 로컬 전용(절대경로 포함) — pending·WAL의 최상위 localOrigin으로만, 저장소 기록 금지(§C-1).
export type ExecutionOrigin =
  | { kind: "git"; worktreeReal: string; gitCommonReal: string }
  | { kind: "historyless"; rootReal: string };

// ── op 21종(정본 §3 — 기존 7 유지+개명 1+신설 10+정책 3) ──────────────────────────
export const TOPOLOGY_OPS_V2 = [
  "add_node", "add_edge", "set_state", "add_anchor", "add_evidence", "add_condition", "change_relation",
  "split_node", "split_edge", "merge_node", "merge_edge", "widen", "narrow", "supersede",
  "change_steward", "change_authority", "rewrite_label",
] as const;
// proposal-only(§C-2): apply 대상 아님 — classify까지만, 결론이 하나면 파생 set_state patch가 apply를 탄다.
export const PROPOSAL_ONLY_OPS_V2 = ["tombstone_candidate"] as const;
export const POLICY_OPS_V2 = ["create_intent_policy", "supersede_intent_policy", "revoke_intent_policy"] as const;
export const PATCH_OPS_V2 = [...TOPOLOGY_OPS_V2, ...PROPOSAL_ONLY_OPS_V2, ...POLICY_OPS_V2] as const;
export type PatchOpV2 = typeof PATCH_OPS_V2[number];

export const AUTHZ_KINDS = ["user-choice", "intent-decision", "policy-ref"] as const; // 정책 op 전용 — EVIDENCE_KINDS와 별도(§C-1)
export type AuthzRef = { kind: typeof AUTHZ_KINDS[number]; ref: string; note?: string };

// ── read-set(§D — 4범주 T/E/A/N + 정책 P + 색인 X) ─────────────────────────────
export type ReadSet = {
  targets?: Array<{ id: string; contentHash: string }>;                        // T: entity canonical 내용 지문(루트 revision 불참)
  files?: Array<{ ref: string; contentHash: string }>;                         // E: evidence·anchor 파일 내용 지문
  adjacency?: Array<{ key: string; hash: string }>;                            // A: 인접성(내용은 op별 — ②b가 의미 검사)
  negative?: Array<{ kind: string; key: string; fingerprint: string }>;        // N: 음성 조건('없었음'의 지문)
  policies?: { refs: Array<{ policyId: string; policyFp: string }>; frontierHash: string; revocationAbsent?: string[] }; // P
  decisionIndex?: Array<{ id: string; indexFp: string }>;                      // X: 관련 entity별 ADP 부분색인 지문
};
// §D 표 — required(●)/optional(○)/forbidden(✕)/conditional(◐: 대상 decisionLocks·적용 가능 정책 존재 시
// 필수 승격 — 승격 판정은 topology·frontier 입력이 필요하므로 ②b(semantic) 소관. 순수 검증은 구조만).
type RsRule = "required" | "optional" | "forbidden" | "conditional";
export const READSET_RULES: Record<PatchOpV2, { T: RsRule; E: RsRule; A: RsRule; N: RsRule; P: RsRule; X: RsRule }> = {
  add_node:                { T: "forbidden", E: "required", A: "forbidden", N: "required", P: "conditional", X: "forbidden" },
  add_edge:                { T: "required",  E: "required", A: "required",  N: "required", P: "conditional", X: "required" },
  set_state:               { T: "required",  E: "required", A: "forbidden", N: "forbidden", P: "conditional", X: "required" },
  add_anchor:              { T: "required",  E: "required", A: "forbidden", N: "optional",  P: "conditional", X: "required" },
  add_evidence:            { T: "required",  E: "required", A: "forbidden", N: "forbidden", P: "conditional", X: "required" },
  add_condition:           { T: "required",  E: "required", A: "forbidden", N: "forbidden", P: "conditional", X: "required" },
  change_relation:         { T: "required",  E: "required", A: "required",  N: "required",  P: "conditional", X: "required" },
  tombstone_candidate:     { T: "required",  E: "required", A: "required",  N: "required",  P: "conditional", X: "required" },
  split_node:              { T: "required",  E: "required", A: "required",  N: "required",  P: "conditional", X: "required" },
  split_edge:              { T: "required",  E: "required", A: "required",  N: "required",  P: "conditional", X: "required" },
  merge_node:              { T: "required",  E: "required", A: "required",  N: "forbidden", P: "conditional", X: "required" },
  merge_edge:              { T: "required",  E: "required", A: "required",  N: "forbidden", P: "conditional", X: "required" },
  widen:                   { T: "required",  E: "required", A: "optional",  N: "required",  P: "conditional", X: "required" },
  narrow:                  { T: "required",  E: "required", A: "optional",  N: "required",  P: "conditional", X: "required" },
  supersede:               { T: "required",  E: "required", A: "required",  N: "required",  P: "conditional", X: "required" },
  change_steward:          { T: "required",  E: "required", A: "forbidden", N: "forbidden", P: "conditional", X: "required" },
  change_authority:        { T: "required",  E: "required", A: "optional",  N: "forbidden", P: "conditional", X: "required" },
  rewrite_label:           { T: "required",  E: "required", A: "forbidden", N: "forbidden", P: "conditional", X: "required" },
  create_intent_policy:    { T: "forbidden", E: "forbidden", A: "forbidden", N: "required",  P: "required",    X: "forbidden" },
  supersede_intent_policy: { T: "forbidden", E: "forbidden", A: "forbidden", N: "forbidden", P: "required",    X: "forbidden" },
  revoke_intent_policy:    { T: "forbidden", E: "forbidden", A: "forbidden", N: "forbidden", P: "required",    X: "forbidden" },
};

// ── MapPatchV2(§C-1 — 대상 필드 union·payload 화이트리스트) ─────────────────────
export type MapPatchV2 = {
  schema: "map-patch-v2";
  patchId: string; mapId: string;
  basis: PatchBasis;
  baseMapHash: string;
  baseAuthorityHash: string;          // CAS 재검사 진입 신호(네임스페이스 키 아님)
  baseDecisionContextHash: string;    // 동상(정책 참조 op·Verifier 결속 키)
  baseDirtyFp: string;                // 감사 메타 — 판정 불참(1-1 강등)
  operation: PatchOpV2;
  targetId?: string; targetIds?: string[]; targetPolicyId?: string; targetPolicyIds?: string[];
  payload: Record<string, unknown>;
  readSet: ReadSet;
  evidence?: EvidenceRef[];           // topology op 전용(code/test/config ≥1)
  authorizationRefs?: AuthzRef[];     // 정책 op 전용 — 상호 혼입 스키마 거부
  rationale: string;
  detectedBy?: string; provider?: string;
};

const PATCH_V2_KEYS = ["schema", "patchId", "mapId", "basis", "baseMapHash", "baseAuthorityHash", "baseDecisionContextHash", "baseDirtyFp", "operation", "targetId", "targetIds", "targetPolicyId", "targetPolicyIds", "payload", "readSet", "evidence", "authorizationRefs", "rationale", "detectedBy", "provider"] as const;
const READSET_KEYS = ["targets", "files", "adjacency", "negative", "policies", "decisionIndex"] as const;
export const PAYLOAD_KEYS_V2: Record<PatchOpV2, readonly string[]> = {
  add_node: ["node"], add_edge: ["edge"], set_state: ["to", "expect"], add_anchor: ["anchor"],
  add_evidence: ["evidence"], add_condition: ["condition"], change_relation: ["to", "expect", "inverse"],
  tombstone_candidate: ["expect"],
  split_node: ["newNodes", "edgeReroute"], split_edge: ["newEdges"],
  merge_node: ["survivorId", "absorbed", "alias"], merge_edge: ["survivorId", "absorbed"],
  widen: ["additions", "expect"], narrow: ["removals", "expect", "retain"],
  supersede: ["successorId", "expect"],
  change_steward: ["to", "expect"], change_authority: ["to", "expect"], rewrite_label: ["to", "expect"],
  create_intent_policy: ["policy"], supersede_intent_policy: ["policy"], revoke_intent_policy: ["revocation"],
};
// 대상 필드 union(§C-1): op별로 정확히 하나의 형태만 허용.
type TargetShape = "none" | "targetId" | "targetIds" | "targetPolicyId" | "targetPolicyIds";
const TARGET_SHAPE: Record<PatchOpV2, TargetShape> = {
  add_node: "none", add_edge: "none", set_state: "targetId", add_anchor: "targetId",
  add_evidence: "targetId", add_condition: "targetId", change_relation: "targetId",
  tombstone_candidate: "targetId", split_node: "targetId", split_edge: "targetId",
  merge_node: "targetIds", merge_edge: "targetIds", widen: "targetId", narrow: "targetId",
  supersede: "targetId", change_steward: "targetId", change_authority: "targetId", rewrite_label: "targetId",
  create_intent_policy: "none", supersede_intent_policy: "targetPolicyIds", revoke_intent_policy: "targetPolicyId",
};
// add_edge=생성 op — 대상 필드 금지(§C-1 원문). from/to의 T는 readSet.targets가 담당.

const SHA1_RE = /^[0-9a-f]{40}$/;
const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/; // git OID: sha1 40 | sha256 64
function isFp(v: unknown): boolean { return typeof v === "string" && SHA1_RE.test(v); }

export function validatePatchBasis(b: unknown): string[] {
  const errs: string[] = [];
  if (!b || typeof b !== "object") return ["basis가 객체가 아님"];
  const o = b as Record<string, unknown>;
  if (o.kind === "git") {
    unknownKeys(o, ["kind", "ref", "baseHead", "oidFormat"], "basis(git)", errs);
    if (o.oidFormat !== "sha1" && o.oidFormat !== "sha256") errs.push("basis: oidFormat은 sha1|sha256");
    const oidLen = o.oidFormat === "sha256" ? 64 : 40;
    if (typeof o.baseHead !== "string" || !new RegExp(`^[0-9a-f]{${oidLen}}$`).test(o.baseHead)) errs.push(`basis: baseHead는 ${String(o.oidFormat)} OID(${oidLen}hex) 전체여야`);
    const r = o.ref as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") errs.push("basis: ref 필요({type:branch,name}|{type:detached,head})");
    else if (r.type === "branch") { unknownKeys(r, ["type", "name"], "basis.ref", errs); if (typeof r.name !== "string" || !r.name) errs.push("basis.ref: branch name 필요"); }
    else if (r.type === "detached") { unknownKeys(r, ["type", "head"], "basis.ref", errs); if (typeof r.head !== "string" || !new RegExp("^[0-9a-f]{" + oidLen + "}$").test(r.head)) errs.push("basis.ref: detached head는 " + String(o.oidFormat) + " OID(" + oidLen + "hex)여야(1차 #4 — oidFormat 결속)"); }
    else errs.push("basis.ref.type은 branch|detached");
  } else if (o.kind === "historyless") {
    unknownKeys(o, ["kind", "basisFp", "inventoryFp"], "basis(historyless)", errs);
    if (!isFp(o.basisFp) || !isFp(o.inventoryFp)) errs.push("basis: basisFp·inventoryFp는 sha1 40hex");
  } else errs.push("basis.kind는 git|historyless");
  return errs;
}

function validateReadSetShape(rs: unknown, op: PatchOpV2, errs: string[]): void {
  if (!rs || typeof rs !== "object" || Array.isArray(rs)) { errs.push("readSet: 객체여야"); return; }
  const o = rs as Record<string, unknown>;
  unknownKeys(o, READSET_KEYS, "readSet", errs);
  const rules = READSET_RULES[op];
  const cat = (name: keyof typeof rules, present: boolean, shapeOk: boolean) => {
    const rule = rules[name];
    if (rule === "forbidden" && present) errs.push(`readSet: ${name} 금지(op=${op} — §D)`);
    if (rule === "required" && !present) errs.push(`readSet: ${name} 필수(op=${op} — §D)`);
    if (present && !shapeOk) errs.push(`readSet: ${name} 형식 위반`);
    // conditional(◐)의 필수 승격은 ②b(semantic — topology·frontier 입력 필요) 소관: 여기선 형식만.
  };
  // canonical read-set(2차 #3): 배열은 키 정렬·중복 금지 — 같은 의미의 patch가 순서로 다른 opHash를 갖지 않게.
  const arrOkBy = (v: unknown, f: (x: Record<string, unknown>) => boolean, keyOf: (x: Record<string, unknown>) => string) =>
    Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && f(x as Record<string, unknown>))
    && new Set((v as Array<Record<string, unknown>>).map(keyOf)).size === v.length
    && (v as Array<Record<string, unknown>>).every((x, i) => i === 0 || keyOf((v as Array<Record<string, unknown>>)[i - 1]) <= keyOf(x));
  const arrOk = arrOkBy as never; // (미사용 자리 유지)
  cat("T", o.targets !== undefined, arrOkBy(o.targets, (x) => isUuid(x.id) && isFp(x.contentHash) && Object.keys(x).length === 2, (x) => String(x.id)));
  cat("E", o.files !== undefined, arrOkBy(o.files, (x) => typeof x.ref === "string" && !!x.ref && isFp(x.contentHash) && Object.keys(x).length === 2, (x) => String(x.ref)));
  cat("A", o.adjacency !== undefined, arrOkBy(o.adjacency, (x) => typeof x.key === "string" && !!x.key && isFp(x.hash) && Object.keys(x).length === 2, (x) => String(x.key)));
  cat("N", o.negative !== undefined, arrOkBy(o.negative, (x) => typeof x.kind === "string" && !!x.kind && typeof x.key === "string" && isFp(x.fingerprint) && Object.keys(x).length === 3, (x) => String(x.kind) + "\u0000" + String(x.key)));
  const pOk = (() => {
    const p = o.policies as Record<string, unknown> | undefined;
    if (p === undefined) return true;
    if (!p || typeof p !== "object" || Array.isArray(p)) return false;
    const keys = Object.keys(p);
    if (keys.some((k) => !["refs", "frontierHash", "revocationAbsent"].includes(k))) return false;
    if (!isFp(p.frontierHash)) return false;
    if (!Array.isArray(p.refs) || !p.refs.every((r: unknown) => r && typeof r === "object" && isUuid((r as Record<string, unknown>).policyId) && isFp((r as Record<string, unknown>).policyFp) && Object.keys(r as object).length === 2)) return false;
    const refIds = (p.refs as Array<Record<string, unknown>>).map((r) => String(r.policyId));
    if (new Set(refIds).size !== refIds.length || !refIds.every((x, i) => i === 0 || refIds[i - 1] <= x)) return false; // canonical(2차 #3)
    if (p.revocationAbsent !== undefined && (!Array.isArray(p.revocationAbsent) || !p.revocationAbsent.every(isUuid) || new Set(p.revocationAbsent).size !== p.revocationAbsent.length || !(p.revocationAbsent as string[]).every((x, i) => i === 0 || (p.revocationAbsent as string[])[i - 1] <= x))) return false;
    return true;
  })();
  cat("P", o.policies !== undefined, pOk);
  cat("X", o.decisionIndex !== undefined, arrOkBy(o.decisionIndex, (x) => isUuid(x.id) && isFp(x.indexFp) && Object.keys(x).length === 2, (x) => String(x.id)));
}

export function isPolicyOpV2(op: PatchOpV2): boolean { return (POLICY_OPS_V2 as readonly string[]).includes(op); }
export function isProposalOnlyOpV2(op: PatchOpV2): boolean { return (PROPOSAL_ONLY_OPS_V2 as readonly string[]).includes(op); }

export function validatePatchV2(p: MapPatchV2): string[] {
  if (!p || typeof p !== "object") return ["patch가 객체가 아님"];
  const errs: string[] = [];
  if (p.schema !== "map-patch-v2") errs.push('schema는 "map-patch-v2"여야');
  if (!isUuid(p.patchId)) errs.push("patchId는 UUID여야");
  if (!isUuid(p.mapId)) errs.push("mapId는 UUID여야(세대 결속 — 1-31)");
  errs.push(...validatePatchBasis(p.basis));
  if (!isFp(p.baseMapHash)) errs.push("baseMapHash는 canonical sha1(40hex)이어야");
  if (!isFp(p.baseAuthorityHash)) errs.push("baseAuthorityHash는 sha1(40hex)이어야");
  if (!isFp(p.baseDecisionContextHash)) errs.push("baseDecisionContextHash는 sha1(40hex)이어야");
  if (typeof p.baseDirtyFp !== "string") errs.push("baseDirtyFp 누락(감사 메타 — project-map/** 제외 지문)");
  if (!(PATCH_OPS_V2 as readonly string[]).includes(p.operation as string)) { errs.push(`operation 불량 ${show(p.operation)}`); return errs; }
  const op = p.operation as PatchOpV2;
  if (typeof p.rationale !== "string" || !p.rationale.trim()) errs.push("rationale 필요");
  unknownKeys(p, PATCH_V2_KEYS, "patch", errs);
  optStr(p.detectedBy, "patch", "detectedBy", errs); optStr(p.provider, "patch", "provider", errs);

  // 증거 이층(§C-1·정본 22차): topology/proposal op=evidence 필수·authz 금지 / 정책 op=authz 필수·evidence 금지.
  if (isPolicyOpV2(op)) {
    if (p.evidence !== undefined) errs.push("정책 op: evidence 금지(증거 이층 — authorizationRefs로. 촉발 사건 연결은 authz.note)");
    if (!Array.isArray(p.authorizationRefs) || !p.authorizationRefs.length) errs.push("정책 op: authorizationRefs 최소 1개");
    else for (const a of p.authorizationRefs) {
      if (!a || typeof a !== "object" || !(AUTHZ_KINDS as readonly string[]).includes((a as AuthzRef).kind) || typeof (a as AuthzRef).ref !== "string" || !(a as AuthzRef).ref) { errs.push("authorizationRefs 항목 불량(kind∈user-choice|intent-decision|policy-ref·ref 필수)"); break; }
      const keys = Object.keys(a); if (keys.some((k) => !["kind", "ref", "note"].includes(k)) || ((a as AuthzRef).note !== undefined && typeof (a as AuthzRef).note !== "string")) { errs.push("authorizationRefs: 미지 필드/비문자열 note(무사망 — 1차 #1)"); break; }
    }
  } else {
    if (p.authorizationRefs !== undefined) errs.push("topology op: authorizationRefs 금지(정책 op 전용 — 우회 차단)");
    if (!Array.isArray(p.evidence) || !p.evidence.length) errs.push("evidence 최소 1개 필요");
    else {
      for (const e of p.evidence) if (validateEvidence(e, "x").length) { errs.push("evidence 항목 불량"); break; }
      if (!p.evidence.some((e) => e && typeof e === "object" && (e.kind === "code" || e.kind === "test" || e.kind === "config"))) errs.push("code/test/config 계열 증거 최소 1개(자기확인 고리 차단)");
    }
  }

  // 대상 필드 union(§C-1)
  const shape = TARGET_SHAPE[op];
  const has = { targetId: p.targetId !== undefined, targetIds: p.targetIds !== undefined, targetPolicyId: p.targetPolicyId !== undefined, targetPolicyIds: p.targetPolicyIds !== undefined };
  for (const [k, v] of Object.entries(has)) if (v && k !== shape) errs.push(`${op}: ${k} 금지(대상 형태=${shape})`);
  if (shape === "targetId" && !isUuid(p.targetId)) errs.push(`${op}: targetId(UUID) 필요`);
  const sortedArr = (v: unknown[], key: (x: unknown) => string) => v.every((x, i) => i === 0 || key(v[i - 1]) <= key(x));
  if (shape === "targetIds" && !(Array.isArray(p.targetIds) && p.targetIds.length >= 2 && p.targetIds.every(isUuid) && new Set(p.targetIds).size === p.targetIds.length && sortedArr(p.targetIds, String))) errs.push(`${op}: targetIds(UUID 2+·중복 금지·정렬 — canonical patch 계약·2차 #3) 필요`);
  if (shape === "targetPolicyId" && !isUuid(p.targetPolicyId)) errs.push(`${op}: targetPolicyId(UUID) 필요`);
  if (shape === "targetPolicyIds" && !(Array.isArray(p.targetPolicyIds) && p.targetPolicyIds.length >= 1 && p.targetPolicyIds.every(isUuid) && new Set(p.targetPolicyIds).size === p.targetPolicyIds.length && sortedArr(p.targetPolicyIds, String))) errs.push(`${op}: targetPolicyIds(UUID 1+·중복 금지·정렬) 필요`);

  // payload 화이트리스트+op별 내용(§C-2 op별 의미의 스키마 가능 부분 — 완전성 검사는 ②b)
  const pl = (p.payload && typeof p.payload === "object" && !Array.isArray(p.payload) ? p.payload : null) as Record<string, unknown> | null;
  if (!pl) { errs.push("payload는 객체여야"); return errs; }
  unknownKeys(pl, PAYLOAD_KEYS_V2[op], "payload", errs);
  const canonState = (v: unknown) => JSON.stringify(Object.fromEntries(Object.entries((v as Record<string, string>) || {}).sort()));
  const nonEmptyStrArr = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x);
  switch (op) {
    case "set_state": {
      if (!stateFieldsValid(pl.to) || !stateFieldsValid(pl.expect)) { errs.push("set_state: to·expect가 상태 필드(enum)여야"); break; }
      const tk = Object.keys(pl.to as object).sort().join(","); const ek = Object.keys(pl.expect as object).sort().join(",");
      if (tk !== ek) errs.push("set_state: to·expect 필드 집합 동일(필드 CAS)");
      else if (canonState(pl.to) === canonState(pl.expect)) errs.push("set_state: to=expect(무의미 변경)");
      break;
    }
    case "add_node": { const e = validateNode(pl.node as MapNode); if (e.length) errs.push("add_node: node 스키마 위반 — " + e[0]); break; }
    case "add_edge": { const e = validateEdge(pl.edge as MapEdge); if (e.length) errs.push("add_edge: edge 스키마 위반 — " + e[0]); break; }
    case "add_anchor": if (validateAnchor(pl.anchor as Anchor | undefined, "x").length) errs.push("add_anchor: anchor 불량"); break;
    case "add_evidence": if (validateEvidence(pl.evidence as EvidenceRef | undefined, "x").length) errs.push("add_evidence: evidence 불량"); break;
    case "add_condition": if (typeof pl.condition !== "string" || !(pl.condition as string).trim()) errs.push("add_condition: condition(비어있지 않은 문자열) 필요"); break;
    case "change_relation":
      if (!RELATIONS.includes(pl.to as typeof RELATIONS[number]) || !RELATIONS.includes(pl.expect as typeof RELATIONS[number]) || typeof pl.inverse !== "string" || !pl.inverse) errs.push("change_relation: to·expect(관계 enum)·inverse 필요");
      else if (pl.to === pl.expect) errs.push("change_relation: to=expect(무의미 변경)");
      break;
    case "tombstone_candidate": if (!stateFieldsValid(pl.expect)) errs.push("tombstone_candidate: expect(현 상태) 필요"); break;
    case "split_node": {
      const nn = pl.newNodes as MapNode[] | undefined;
      if (!Array.isArray(nn) || nn.length < 2) errs.push("split_node: newNodes 2+ 필요");
      else { for (const n of nn) { const e = validateNode(n); if (e.length) { errs.push("split_node: newNodes 항목 스키마 위반 — " + e[0]); break; } } if (new Set(nn.map((n) => n && n.id)).size !== nn.length) errs.push("split_node: newNodes id 중복"); }
      const rr = pl.edgeReroute as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(rr) || !rr.every((r) => r && typeof r === "object" && isUuid(r.edgeId) && isUuid(r.to) && Object.keys(r).length === 2)) errs.push("split_node: edgeReroute[{edgeId,to}] 필요(빈 배열 허용 — 전수성은 ②b)");
      else {
        const eids = rr.map((r) => String(r.edgeId));
        if (new Set(eids).size !== eids.length) errs.push("split_node: edgeReroute edgeId 중복 금지");
        const nnIds = new Set(((pl.newNodes as MapNode[]) || []).map((n) => n && n.id));
        if (!rr.every((r) => nnIds.has(String(r.to)))) errs.push("split_node: edgeReroute.to는 newNodes id여야(3차 판정)");
      }
      if (Array.isArray(pl.newNodes) && (pl.newNodes as MapNode[]).some((n) => n && n.id === p.targetId)) errs.push("split_node: newNodes id는 원본 targetId와 달라야");
      break;
    }
    case "split_edge": {
      const ne = pl.newEdges as MapEdge[] | undefined;
      if (!Array.isArray(ne) || ne.length < 2) errs.push("split_edge: newEdges 2+ 필요");
      else { for (const ed of ne) { const e = validateEdge(ed); if (e.length) { errs.push("split_edge: newEdges 항목 스키마 위반 — " + e[0]); break; } } if (new Set(ne.map((x) => x && x.id)).size !== ne.length) errs.push("split_edge: newEdges id 중복"); if (ne.some((x) => x && x.id === p.targetId)) errs.push("split_edge: newEdges id는 원본 targetId와 달라야"); }
      break;
    }
    case "merge_node": case "merge_edge": {
      if (!isUuid(pl.survivorId)) errs.push(`${op}: survivorId(UUID) 필요`);
      else if (!(p.targetIds || []).includes(pl.survivorId as string)) errs.push(`${op}: survivorId는 targetIds에 포함돼야`);
      const ab = pl.absorbed as Array<Record<string, unknown>> | undefined;
      const AB_KEYS = op === "merge_node" ? ["id", "rerouteEdgesTo", "anchorsTo", "evidenceTo"] : ["id"]; // merge_edge는 재지향 필드 없음(적용기가 무시하던 불일치 제거 — 8차 #4)
      // envelope 내부 정합(3차 #3 — topology 불요 판정은 A1 소관): absorbed id 집합 = targetIds − survivor.
      if (Array.isArray(ab) && Array.isArray(p.targetIds) && isUuid(pl.survivorId)) {
        const abIds = ab.map((a) => String(a.id));
        const want = p.targetIds.filter((t) => t !== pl.survivorId).sort();
        if (new Set(abIds).size !== abIds.length || canonicalJsonOf([...abIds].sort()) !== canonicalJsonOf(want)) errs.push(`${op}: absorbed id 집합은 targetIds−survivor와 정확히 일치해야(중복 금지)`);
      }
      if (!Array.isArray(ab) || !ab.length || !ab.every((a) => a && typeof a === "object" && isUuid(a.id) && Object.keys(a).every((k) => AB_KEYS.includes(k)) && ["rerouteEdgesTo", "anchorsTo", "evidenceTo"].every((k) => (a as Record<string, unknown>)[k] === undefined || isUuid((a as Record<string, unknown>)[k]))) || !ab.every((a, i) => i === 0 || String(ab[i - 1].id) <= String(a.id))) errs.push(`${op}: absorbed[{id, rerouteEdgesTo?, anchorsTo?, evidenceTo?}](전부 UUID·id 정렬) 필요`);
      else if (ab.some((a) => a.id === pl.survivorId)) errs.push(`${op}: absorbed에 survivor 포함 금지`);
      if (op === "merge_node" && pl.alias !== undefined && !nonEmptyStrArr(pl.alias)) errs.push("merge_node: alias는 비어있지 않은 문자열 배열이어야");
      break;
    }
    case "widen": case "narrow": {
      const box = (op === "widen" ? pl.additions : pl.removals) as Record<string, unknown> | undefined;
      if (!box || typeof box !== "object" || Array.isArray(box)) { errs.push(`${op}: ${op === "widen" ? "additions" : "removals"} 객체 필요`); break; }
      const bk = Object.keys(box);
      if (!bk.length || bk.some((k) => !["anchors", "conditions"].includes(k))) { errs.push(`${op}: anchors|conditions만 허용·최소 1키`); break; }
      if (box.anchors !== undefined && (!Array.isArray(box.anchors) || !box.anchors.length || box.anchors.some((a: unknown) => validateAnchor(a as Anchor, "x").length))) errs.push(`${op}: anchors 항목 불량`);
      if (box.conditions !== undefined && !nonEmptyStrArr(box.conditions)) errs.push(`${op}: conditions 항목 불량`);
      {
        const ex = pl.expect as Record<string, unknown> | undefined;
        const exKeysOk = ex && typeof ex === "object" && !Array.isArray(ex) && Object.keys(ex).length > 0 && Object.keys(ex).every((k) => ["anchors", "conditions"].includes(k));
        const exCondOk = !ex || ex.conditions === undefined || (Array.isArray(ex.conditions) && (ex.conditions as unknown[]).every((c) => typeof c === "string"));
        const exAnchOk = !ex || ex.anchors === undefined || (Array.isArray(ex.anchors) && (ex.anchors as unknown[]).every((a) => validateAnchor(a as Anchor, "x").length === 0));
        if (!exKeysOk || !exCondOk || !exAnchOk) errs.push(`${op}: expect는 {anchors?: Anchor[], conditions?: string[]}(최소 1필드 — 현 범위 CAS 자료·2차 #2)`);
      }
      if (op === "narrow" && pl.retain !== undefined && !nonEmptyStrArr(pl.retain)) errs.push("narrow: retain은 문자열 배열이어야");
      break;
    }
    case "supersede":
      if (!isUuid(pl.successorId)) errs.push("supersede: successorId(UUID) 필요");
      else if (pl.successorId === p.targetId) errs.push("supersede: 자기 자신 계승 금지");
      if (!stateFieldsValid(pl.expect)) errs.push("supersede: expect(구 상태) 필요");
      break;
    case "change_steward":
      if (typeof pl.to !== "string") errs.push("change_steward: to(문자열 — 빈 문자열=미지정 복원, inverse 재적용 가능성: 8차 #6) 필요");
      if (typeof pl.expect !== "string") errs.push("change_steward: expect(현 steward — 빈 문자열=미지정) 필요");
      if (pl.to === pl.expect) errs.push("change_steward: to=expect(무의미 변경)");
      break;
    case "change_authority": {
      const rolesOk = (v: unknown) => Array.isArray(v) && v.every((r) => (ROLES as readonly string[]).includes(r as string)) && new Set(v).size === (v as unknown[]).length;
      if (!rolesOk(pl.to) || !rolesOk(pl.expect)) errs.push("change_authority: to·expect는 roles 배열(enum·중복 금지)이어야");
      else if (canonicalJsonOf([...(pl.to as string[])].sort()) === canonicalJsonOf([...(pl.expect as string[])].sort())) errs.push("change_authority: to=expect(무의미 변경)");
      break;
    }
    case "rewrite_label": {
      const shapeOk = (v: unknown) => { if (!v || typeof v !== "object" || Array.isArray(v)) return false; const ks = Object.keys(v); return ks.length > 0 && ks.every((k) => ["label", "description", "notes"].includes(k)) && ks.every((k) => typeof (v as Record<string, unknown>)[k] === "string"); };
      if (!shapeOk(pl.to) || !shapeOk(pl.expect)) errs.push("rewrite_label: to·expect는 {label|description|notes} 문자열 필드 객체");
      else {
        const tk = Object.keys(pl.to as object).sort().join(","); const ek = Object.keys(pl.expect as object).sort().join(",");
        if (tk !== ek) errs.push("rewrite_label: to·expect 필드 집합 동일(필드 CAS)");
        else if (canonicalJsonOf(pl.to) === canonicalJsonOf(pl.expect)) errs.push("rewrite_label: to=expect(무의미 변경)");
        else if ((pl.to as Record<string, unknown>).notes !== undefined && Object.keys(pl.to as object).length > 1) errs.push("rewrite_label: notes(edge)와 label/description(node)은 혼용 금지");
      }
      break;
    }
    case "create_intent_policy": case "supersede_intent_policy": {
      const e = validateIntentPolicy(pl.policy as IntentPolicy);
      if (e.length) errs.push(`${op}: policy 사본 불량 — ` + e[0]);
      else {
        const pol = pl.policy as IntentPolicy;
        if (op === "create_intent_policy" && pol.supersedesPolicyIds !== undefined) errs.push("create_intent_policy: supersedesPolicyIds 금지(supersede op로)");
        if (op === "supersede_intent_policy") {
          if (!Array.isArray(pol.supersedesPolicyIds) || !pol.supersedesPolicyIds.length) errs.push("supersede_intent_policy: policy.supersedesPolicyIds 필수(복수 head 일괄 종결)");
          else if (canonicalJsonOf([...pol.supersedesPolicyIds].sort()) !== canonicalJsonOf([...(p.targetPolicyIds || [])].sort())) errs.push("supersede_intent_policy: targetPolicyIds와 policy.supersedesPolicyIds 불일치");
        }
        if (p.mapId !== pol.mapId) errs.push(`${op}: policy.mapId가 patch.mapId와 불일치(세대 결속)`);
      }
      break;
    }
    case "revoke_intent_policy": {
      const e = validatePolicyRevocation(pl.revocation as PolicyRevocation);
      if (e.length) errs.push("revoke_intent_policy: revocation 사본 불량 — " + e[0]);
      else if ((pl.revocation as PolicyRevocation).targetPolicyId !== p.targetPolicyId) errs.push("revoke_intent_policy: targetPolicyId 불일치");
      break;
    }
  }
  validateReadSetShape(p.readSet, op, errs);
  // canonical 저장 계약(4차 #1·#3): patch '자체'가 canonical이어야 한다 — 해시만 정규화하면 decision 파일
  // 지문·WAL expectedDecisionFileAfterHash가 생산자 배열 순서에 갈라진다(C-3 '정규화 사본' 위반).
  // 정렬 위반은 canonical 자기 동일성 검사 하나로 전부 잡고, 중복은 정렬로 안 사라지므로 별도 거부
  // (조용한 중복 제거는 위조·입력 오류 은닉 — fail-closed).
  if (errs.length === 0) {
    if (hasDupSetKeys(p)) errs.push("집합 배열에 중복 항목(canonical key 기준) — 거부(fail-closed·4차 #3)");
    else if (canonicalJsonOf(p) !== canonicalJsonOf(canonicalPatchV2(p))) errs.push("patch가 canonical 형태가 아님(집합 배열 정렬 위반 — canonicalPatchV2와 자기 동일해야: C-3 정규화 사본 계약)");
  }
  return errs;
}
// 집합 배열의 canonical key 중복 검사(canonicalPatchV2와 같은 키 함수 공유 — 4차 #3)
function hasDupSetKeys(p: MapPatchV2): boolean {
  const dup = (arr: unknown[] | undefined, key: (x: never) => string): boolean =>
    Array.isArray(arr) && new Set(arr.map((x) => key(x as never))).size !== arr.length;
  const pl = (p.payload || {}) as Record<string, unknown>;
  const entDup = (ent: unknown): boolean => {
    if (!ent || typeof ent !== "object") return false;
    const e = ent as { roles?: string[]; anchors?: Anchor[]; conditions?: string[]; evidence?: EvidenceRef[]; decisionLocks?: DecisionLock[] };
    return dup(e.roles, String) || dup(e.anchors, keyAnchor as never) || dup(e.conditions, String) || dup(e.evidence, keyEvidence as never) || dup(e.decisionLocks, canonicalJsonOf as never);
  };
  if (dup(p.evidence, keyEvidence as never)) return true;
  if (dup(p.authorizationRefs, ((a: AuthzRef) => [a.kind, a.ref, a.note || ""].join("\u0000")) as never)) return true;
  if (entDup(pl.node) || entDup(pl.edge)) return true;
  if (Array.isArray(pl.newNodes) && (pl.newNodes as unknown[]).some(entDup)) return true;
  if (Array.isArray(pl.newEdges) && (pl.newEdges as unknown[]).some(entDup)) return true;
  if (dup(pl.alias as string[], String) || dup(pl.retain as string[], String)) return true;
  if (Array.isArray(pl.to) && dup(pl.to as string[], String)) return true;
  if (Array.isArray(pl.expect) && dup(pl.expect as string[], String)) return true;
  for (const box of ["additions", "removals", "expect"]) {
    const b = pl[box] as { anchors?: Anchor[]; conditions?: unknown[] } | undefined;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      if (dup(b.anchors, keyAnchor as never)) return true;
      if (Array.isArray(b.conditions) && b.conditions.every((x) => typeof x === "string") && dup(b.conditions as string[], String)) return true;
    }
  }
  return false;
}

// ── IntentPolicy·revocation(1-35 — 불변 버전 파일) ─────────────────────────────
export type IntentPolicy = {
  policyId: string; mapId: string;
  scope: "project" | "subgraph" | "entity";           // one-shot은 파일로 저장하지 않음(1-35)
  scopeTarget?: string[];                              // entity|subgraph면 필수(대상 UUID)
  predicateExpr: { version: number; kind: string } & Record<string, unknown>; // typed 강제 — 자유문장 금지(미지원 kind=자동 매칭 없이 needs-investigation)
  predicateDescription: string;                        // 사람용 — 자동 판정 입력 금지
  chosenMeaning: string;
  exclusions?: string[];
  createdFromDecision: string;                         // decisionId(UUID)
  verification: VerificationBasis;
  supersedesPolicyIds?: string[];
  active: boolean;
};
export type PolicyRevocation = { revocationId: string; targetPolicyId: string; reason: string; createdFromDecision: string };

const POLICY_KEYS = ["policyId", "mapId", "scope", "scopeTarget", "predicateExpr", "predicateDescription", "chosenMeaning", "exclusions", "createdFromDecision", "verification", "supersedesPolicyIds", "active"] as const;
export function validateIntentPolicy(pol: IntentPolicy): string[] {
  if (!pol || typeof pol !== "object") return ["policy가 객체가 아님"];
  const errs: string[] = [];
  if (!isUuid(pol.policyId)) errs.push("policyId는 UUID여야");
  if (!isUuid(pol.mapId)) errs.push("policy.mapId는 UUID여야");
  if (!["project", "subgraph", "entity"].includes(pol.scope)) errs.push("scope는 project|subgraph|entity");
  if (pol.scope !== "project") { if (!Array.isArray(pol.scopeTarget) || !pol.scopeTarget.length || !pol.scopeTarget.every(isUuid)) errs.push("entity|subgraph scope: scopeTarget(UUID 목록) 필수(1-35)"); }
  else if (pol.scopeTarget !== undefined) errs.push("project scope: scopeTarget 금지");
  const pe = pol.predicateExpr as Record<string, unknown> | undefined;
  if (!pe || typeof pe !== "object" || Array.isArray(pe) || !Number.isInteger(pe.version) || (pe.version as number) < 1 || typeof pe.kind !== "string" || !pe.kind) errs.push("predicateExpr{version≥1,kind,...} typed 필수(자유문장 금지 — 정본 22차)");
  if (pe && !deepShapeOk(pe, FREE_FIELD_MAX_DEPTH)) errs.push("predicateExpr: 깊이/크기 상한 초과(무사망 계약 — 1차 #1)");
  if (typeof pol.predicateDescription !== "string" || !pol.predicateDescription.trim()) errs.push("predicateDescription 필요(사람용)");
  if (typeof pol.chosenMeaning !== "string" || !pol.chosenMeaning.trim()) errs.push("chosenMeaning 필요");
  if (pol.exclusions !== undefined && (!Array.isArray(pol.exclusions) || !pol.exclusions.every((x) => typeof x === "string" && x))) errs.push("exclusions는 문자열 배열이어야");
  // 집합 의미 배열=정렬·중복 거부(1차 #3 — v1 '집합 배열 전체 정렬' 선례: 파일 자체가 canonical이어야 frontier 해시가 의미 결정론)
  const sortedSet = (v: unknown) => Array.isArray(v) && new Set(v).size === v.length && v.every((x, i) => i === 0 || String(v[i - 1]) <= String(x));
  if (pol.scopeTarget !== undefined && !sortedSet(pol.scopeTarget)) errs.push("scopeTarget은 정렬·중복 없는 목록이어야(canonical 파일 계약)");
  if (pol.exclusions !== undefined && !sortedSet(pol.exclusions)) errs.push("exclusions는 정렬·중복 없는 목록이어야");
  if (pol.supersedesPolicyIds !== undefined && !sortedSet(pol.supersedesPolicyIds)) errs.push("supersedesPolicyIds는 정렬·중복 없는 목록이어야");
  if (!isUuid(pol.createdFromDecision)) errs.push("createdFromDecision(decisionId UUID) 필수");
  if (pol.supersedesPolicyIds !== undefined && (!Array.isArray(pol.supersedesPolicyIds) || !pol.supersedesPolicyIds.length || !pol.supersedesPolicyIds.every(isUuid) || pol.supersedesPolicyIds.includes(pol.policyId))) errs.push("supersedesPolicyIds는 UUID 목록(자기 참조 금지)이어야");
  if (pol.active !== true) errs.push("active는 true여야(비활성 정책은 파일로 만들지 않음 — 철회는 revocation)");
  errs.push(...validateVerificationBasis(pol.verification, "policy").map((e) => e)); // 기존 엄격 검증기 재사용(1차 #5)
  unknownKeys(pol, POLICY_KEYS, "policy", errs);
  return errs;
}
export function validatePolicyRevocation(r: PolicyRevocation): string[] {
  if (!r || typeof r !== "object") return ["revocation이 객체가 아님"];
  const errs: string[] = [];
  if (!isUuid(r.revocationId)) errs.push("revocationId는 UUID여야");
  if (!isUuid(r.targetPolicyId)) errs.push("targetPolicyId는 UUID여야");
  if (typeof r.reason !== "string" || !r.reason.trim()) errs.push("reason 필요");
  if (!isUuid(r.createdFromDecision)) errs.push("createdFromDecision 필수");
  unknownKeys(r, ["revocationId", "targetPolicyId", "reason", "createdFromDecision"], "revocation", errs);
  return errs;
}

// frontier 유효 leaf(1-35·17차): active AND 자기를 supersede하는 정책 부재(successor의 이후 철회와 무관 — 영구)
// AND 자기 대상 revocation 부재. 부활은 새 create로만.
export function effectivePolicyFrontier(policies: IntentPolicy[], revocations: PolicyRevocation[]): IntentPolicy[] {
  const superseded = new Set<string>();
  for (const p of policies || []) for (const sid of p.supersedesPolicyIds || []) superseded.add(sid);
  const revoked = new Set((revocations || []).map((r) => r.targetPolicyId));
  return (policies || []).filter((p) => p.active === true && !superseded.has(p.policyId) && !revoked.has(p.policyId));
}
// pfh: 유효 frontier의 canonical 의미 필드 전체+모든 revocation 내용(파일 손상·변조도 캐시 무효화 — §3).
export function policyFrontierHashOf(policies: IntentPolicy[], revocations: PolicyRevocation[]): string {
  const frontier = effectivePolicyFrontier(policies, revocations).map((p) => canonicalJsonOf(p)).sort();
  const revs = (revocations || []).map((r) => canonicalJsonOf(r)).sort();
  return domHash("pfh", JSON.stringify({ frontier, revs }));
}

// ── decision v2·projection·이중 해시(§C-3·§E) ─────────────────────────────────
export type DecisionActor =
  | { kind: "auto" } | { kind: "verifier"; resultFp: string }
  | { kind: "user-choice"; cardId: string } | { kind: "user-choice-delegated"; policyId: string }; // cardId 필수(6차 — 카드 ID=선택 레코드 ID 단일 식별자)
export type AuthorityDecisionProjection = {
  decisionId: string; mapId: string; patchId: string; opHash: string; operation: PatchOpV2;
  targetIds: string[]; verification: VerificationBasis;
  evidenceFps: Array<{ ref: string; contentHash: string }>;
  classification: "auto" | "verifier-resolved" | "intent-choice";
  resolutionOutcome: string; verdictFp?: string;
  affectedIds?: string[]; // P4(v3 전용): 생존 changedIds — v2 projection에는 이 키 자체가 없어야 한다(해시 불변 계약)
};
export type MapDecisionV2 = {
  schema: "map-decision-v2";
  decisionId: string; mapId: string; patchId: string; opHash: string;
  patch: MapPatchV2;                   // 정규화 사본(localOrigin 없음)
  actor: DecisionActor;
  classification: "auto" | "verifier-resolved" | "intent-choice";
  resolution: { outcome: "applied"; evidenceRef: string };
  preCutover?: true;
  verification: VerificationBasis;
  evidenceFps: Array<{ ref: string; contentHash: string }>;
  verdictFp?: string;
  audit: { ts: string; topologyBeforeHash: string; topologyAfterHash: string; mapMdAfterHash: string; authorityHashAfter: string; expectedMapHashAfter: string; walRef: string };
};

// P4(설계 v8 — 버전·호환 계약): map-decision-v3 = v2 + affectedIds(topology decision 필수·정렬·중복 제거 /
// policy decision=부재 금지 조건부). historyless VerificationBasis의 structural 의미는 v3부터. 신규 기록=v3만,
// 구 v2 레코드=바이트 의미 보존(재작성·일괄 변환 금지 — adpOf/해시 결속 불변, 판정은 dual reader가 분기).
export type MapDecisionV3 = Omit<MapDecisionV2, "schema"> & { schema: "map-decision-v3"; affectedIds?: string[] };
const DECISION_V2_KEYS = ["schema", "decisionId", "mapId", "patchId", "opHash", "patch", "actor", "classification", "resolution", "preCutover", "verification", "evidenceFps", "verdictFp", "audit"] as const;
const AUDIT_KEYS = ["ts", "topologyBeforeHash", "topologyAfterHash", "mapMdAfterHash", "authorityHashAfter", "expectedMapHashAfter", "walRef"] as const;
export function validateDecisionV2(d: MapDecisionV2): string[] {
  if (!d || typeof d !== "object") return ["decision이 객체가 아님"];
  const errs: string[] = [];
  if (d.schema !== "map-decision-v2") errs.push('schema는 "map-decision-v2"여야');
  if (!isUuid(d.decisionId)) errs.push("decisionId는 UUID여야");
  if (!isUuid(d.mapId)) errs.push("mapId는 UUID여야");
  if (!isUuid(d.patchId)) errs.push("patchId는 UUID여야");
  unknownKeys(d, DECISION_V2_KEYS, "decision", errs);
  // patch 사본: v1 approve 계약 승계 — 전체 통과+patchId 결합+opHash 재계산(§C-3).
  const pc = d.patch as MapPatchV2 | undefined;
  if (!pc || typeof pc !== "object") errs.push("patch(정규화 사본) 필수");
  else {
    if ((pc as unknown as Record<string, unknown>).localOrigin !== undefined) errs.push("decision.patch에 localOrigin 금지(이식 가능성 — §C-1)");
    const pe = validatePatchV2(pc);
    if (pe.length) errs.push("patch 사본이 유효하지 않음(재적용 불능) — " + pe[0]);
    else {
      if (pc.patchId !== d.patchId) errs.push("patch.patchId≠decision.patchId(다른 patch 결합 금지)");
      if (pc.mapId !== d.mapId) errs.push("patch.mapId≠decision.mapId");
      if (opHashV2Of(pc) !== d.opHash) errs.push("opHash가 canonical patch 재계산 지문(opHashV2Of)과 불일치 — 3차 #2");
      // 사본 canonical성은 validatePatchV2의 자기 동일성 검사가 보장(4차 #1 — 비정규 사본은 위에서 이미 거부)
      if (isProposalOnlyOpV2(pc.operation)) errs.push("proposal-only op(tombstone_candidate)는 decision이 될 수 없음(§C-2 — 파생 set_state로)");
    }
  }
  const a = d.actor as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") errs.push("actor 필수");
  else if (a.kind === "auto") { if (Object.keys(a).length !== 1) errs.push("actor(auto): 추가 필드 금지"); }
  else if (a.kind === "verifier") { if (!isFp(a.resultFp) || Object.keys(a).length !== 2) errs.push("actor(verifier): resultFp(sha1) 필요"); }
  else if (a.kind === "user-choice") { if (Object.keys(a).some((k) => !["kind", "cardId"].includes(k)) || typeof a.cardId !== "string" || !a.cardId) errs.push("actor(user-choice): cardId(비어있지 않은 문자열) 필수(6차 — 단일 식별자)"); }
  else if (a.kind === "user-choice-delegated") { if (!isUuid(a.policyId) || Object.keys(a).length !== 2) errs.push("actor(delegated): policyId(UUID) 필요"); }
  else errs.push("actor.kind 불량");
  if (!["auto", "verifier-resolved", "intent-choice"].includes(d.classification)) errs.push("classification은 applied 도달 3종(auto|verifier-resolved|intent-choice)만(§C-3)");
  // 정책 op='사용자 선택의 산물만 — 자동 생성 금지'(정본 §3 표·4차 #4): intent-choice+user-choice 강제
  // (delegated는 '기존 정책의 위임 적용'이지 새 정책 생성·종결이 아님).
  if (d.patch && isPolicyOpV2(d.patch.operation)) {
    if (d.classification !== "intent-choice") errs.push("정책 op decision: classification=intent-choice여야(자동 생성 금지 — 정본 §3)");
    if (!a || (a as Record<string, unknown>).kind !== "user-choice") errs.push("정책 op decision: actor=user-choice여야(사용자 선택의 산물만)");
  }
  // 정책 artifact 귀속(5차 #1): 파일은 '이 decision과 같은 WAL 체인'의 산물 — createdFromDecision=decisionId.
  if (d.patch && isPolicyOpV2(d.patch.operation)) {
    const pl2 = (d.patch.payload || {}) as Record<string, unknown>;
    const artCfd = d.patch.operation === "revoke_intent_policy"
      ? (pl2.revocation as PolicyRevocation | undefined)?.createdFromDecision
      : (pl2.policy as IntentPolicy | undefined)?.createdFromDecision;
    if (artCfd !== d.decisionId) errs.push("정책 artifact의 createdFromDecision이 이 decisionId와 불일치(귀속 분리 금지 — 5차 #1)");
  }
  // 사용자 선택 결속(5차 #2 — verifier 삼중 결속과 대칭): 카드 ID=선택 레코드 ID 단일 식별자로 확정.
  // intent-choice decision은 actor.cardId 필수·resolution.evidenceRef=cardId, 정책 op면 patch의
  // authorizationRefs(user-choice)에 같은 ref가 실존해야 한다 — 문자열 actor만으로 '선택이 있었다' 주장 차단.
  if (d.classification === "intent-choice" && a && (a as Record<string, unknown>).kind === "user-choice") {
    const cid = (a as Record<string, unknown>).cardId;
    if (typeof cid !== "string" || !cid) errs.push("intent-choice: actor.cardId 필수(선택 레코드 식별자)");
    else {
      const r0 = d.resolution as Record<string, unknown> | undefined;
      if (r0 && r0.evidenceRef !== cid) errs.push("intent-choice: resolution.evidenceRef=actor.cardId여야(선택 결속)");
      if (d.patch && isPolicyOpV2(d.patch.operation)) {
        const az = (d.patch.authorizationRefs || []) as AuthzRef[];
        if (!az.some((x) => x.kind === "user-choice" && x.ref === cid)) errs.push("정책 op: authorizationRefs(user-choice)에 actor.cardId와 같은 ref 필요(선택→정책 귀속)");
      }
    }
  }
  // classification↔actor 정합(§A 해소 증거의 기록 형태): verifier-resolved↔verifier, intent-choice↔user-choice 계열, auto↔auto|delegated(정책 위임 자동 적용 — 1-35 ②).
  if (a && typeof a === "object") {
    if (d.classification === "verifier-resolved" && a.kind !== "verifier") errs.push("verifier-resolved는 actor=verifier여야(해소 증거 결속)");
    if (d.classification === "intent-choice" && a.kind !== "user-choice") errs.push("intent-choice는 actor=user-choice여야");
    if (d.classification === "auto" && a.kind !== "auto" && a.kind !== "user-choice-delegated") errs.push("auto는 actor=auto|user-choice-delegated여야");
  }
  const r = d.resolution as Record<string, unknown> | undefined;
  if (!r || r.outcome !== "applied" || typeof r.evidenceRef !== "string" || !r.evidenceRef.trim() || Object.keys(r).length !== 2) errs.push('resolution={outcome:"applied", evidenceRef(비어있지 않음)} 필수(decisions/=applied만 — §C-3)');
  // verifier 해소 증거 결속(1차 #6): actor.resultFp=verdictFp=resolution.evidenceRef 삼중 일치
  if (d.classification === "verifier-resolved" && a && (a as Record<string, unknown>).kind === "verifier") {
    const rf = (a as Record<string, unknown>).resultFp;
    if (d.verdictFp === undefined || d.verdictFp !== rf) errs.push("verifier-resolved: verdictFp=actor.resultFp 필수(해소 증거 결속)");
    if (r && r.evidenceRef !== rf) errs.push("verifier-resolved: resolution.evidenceRef=actor.resultFp여야");
  }
  if (d.preCutover !== undefined && d.preCutover !== true) errs.push("preCutover는 true만(부재=cutover 후)");
  errs.push(...validateVerificationBasis(d.verification, "decision"));
  if (!Array.isArray(d.evidenceFps) || !d.evidenceFps.every((f) => f && typeof f === "object" && typeof f.ref === "string" && !!f.ref && isFp(f.contentHash) && Object.keys(f).length === 2)) errs.push("evidenceFps[{ref,contentHash}] 필요(빈 배열=정책 op만 허용)");
  else {
    const refs = d.evidenceFps.map((f) => f.ref);
    if (new Set(refs).size !== refs.length || !refs.every((x, i) => i === 0 || refs[i - 1] <= x)) errs.push("evidenceFps: ref 정렬·중복 금지(ref당 지문 1개 — canonical)");
    if (d.patch && !isPolicyOpV2(d.patch.operation)) {
      if (!d.evidenceFps.length) errs.push("topology op decision: evidenceFps 최소 1개");
      // 권위 결속(3차 #1): decision의 지문 대상 = patch가 근거로 든 파일 집합과 정확히 일치 —
      // 무관 파일 지문이 ADP에 들어가 effectiveConfidence 검사 ④를 우회하는 오염 차단.
      const want = [...new Set(((d.patch.evidence || []) as EvidenceRef[]).map((e) => e.ref))].sort();
      if (canonicalJsonOf(refs) !== canonicalJsonOf(want)) errs.push("evidenceFps ref 집합이 patch.evidence ref 집합과 불일치(권위 오염 차단 — 3차 #1)");
    }
  }
  if (d.verdictFp !== undefined && !isFp(d.verdictFp)) errs.push("verdictFp는 sha1이어야");
  const au = d.audit as Record<string, unknown> | undefined;
  if (!au || typeof au !== "object") errs.push("audit 블록 필수");
  else {
    unknownKeys(au, AUDIT_KEYS, "audit", errs);
    if (typeof au.ts !== "string" || !au.ts) errs.push("audit.ts 필요");
    for (const k of ["topologyBeforeHash", "topologyAfterHash", "mapMdAfterHash", "authorityHashAfter", "expectedMapHashAfter"]) if (!isFp(au[k])) errs.push(`audit.${k}는 sha1이어야`);
    if (typeof au.walRef !== "string" || !au.walRef) errs.push("audit.walRef 필요");
    // 감사 해시 내부 정합(2차 #4): topologyAfterHash=expectedMapHashAfter(같은 prospective topology의 실제/예상).
    if (isFp(au.topologyAfterHash) && isFp(au.expectedMapHashAfter) && au.topologyAfterHash !== au.expectedMapHashAfter) errs.push("audit: topologyAfterHash=expectedMapHashAfter여야(WAL 선계산·guard 참조 정합)");
    // 정책 op는 topology 무변경(§F-2): before=after(=expected)까지 전부 동일 강제.
    if (d.patch && isPolicyOpV2(d.patch.operation) && (au.topologyBeforeHash !== au.topologyAfterHash || au.topologyBeforeHash !== au.expectedMapHashAfter)) errs.push("정책 op: audit의 topology 3해시(before/after/expected) 전부 동일해야(무변경 계약)");
  }
  return errs;
}

// 대상 entity 추출(projection의 targetIds — 'op가 의미적으로 읽은 entity 전체'는 X의 정의이고,
// projection.targetIds는 '변경 대상'만: 색인의 entity 귀속 판정 재료).
// ── canonical patch(3차 #2 — '정규화 MapPatchV2 사본' 계약의 단일 고정점) ─────────────
// 집합 의미 배열의 정렬 규칙을 한곳에 고정한다(개별 validator 산개 시 누락 확장 위험 — 검증자 권고).
// v1 opHashOf는 동결 — v2 해시는 이 정규화를 지난 뒤 같은 깊은 정렬 직렬화를 쓴다.
// predicateExpr 내부 배열은 정렬하지 않는다(DSL 연산자 순서 의미 가능 — P9 전 일괄 정렬 금지: 3차 판정).
const keyAnchor = (a: Anchor) => [a.kind, a.path, a.symbol || "", a.lineHint ?? ""].join("\u0000");
const keyEvidence = (e: EvidenceRef) => [e.kind, e.ref, e.note || ""].join("\u0000");
const sortBy = <T,>(arr: T[] | undefined, key: (x: T) => string): T[] | undefined =>
  arr === undefined ? undefined : [...arr].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
function canonicalEntitySets<T extends { roles?: string[]; anchors?: Anchor[]; conditions?: string[]; evidence?: EvidenceRef[]; decisionLocks?: DecisionLock[] }>(ent: T): T {
  const out = { ...ent } as T & Record<string, unknown>;
  if (Array.isArray(out.roles)) out.roles = [...out.roles].sort();
  if (Array.isArray(out.anchors)) out.anchors = sortBy(out.anchors as Anchor[], keyAnchor);
  if (Array.isArray(out.conditions)) out.conditions = [...(out.conditions as string[])].sort();
  if (Array.isArray(out.evidence)) out.evidence = sortBy(out.evidence as EvidenceRef[], keyEvidence);
  if (Array.isArray(out.decisionLocks)) out.decisionLocks = sortBy(out.decisionLocks as DecisionLock[], (l) => canonicalJsonOf(l));
  return out;
}
export function canonicalPatchV2(p: MapPatchV2): MapPatchV2 {
  const c = JSON.parse(JSON.stringify(p)) as MapPatchV2 & { payload: Record<string, unknown> };
  if (c.targetIds) c.targetIds = [...c.targetIds].sort();
  if (c.targetPolicyIds) c.targetPolicyIds = [...c.targetPolicyIds].sort();
  if (c.evidence) c.evidence = sortBy(c.evidence, keyEvidence);
  if (c.authorizationRefs) c.authorizationRefs = sortBy(c.authorizationRefs, (a) => [a.kind, a.ref, a.note || ""].join("\u0000"));
  const rs = c.readSet as ReadSet | undefined;
  if (rs && typeof rs === "object") {
    if (rs.targets) rs.targets = sortBy(rs.targets, (x) => x.id);
    if (rs.files) rs.files = sortBy(rs.files, (x) => x.ref);
    if (rs.adjacency) rs.adjacency = sortBy(rs.adjacency, (x) => x.key);
    if (rs.negative) rs.negative = sortBy(rs.negative, (x) => x.kind + "\u0000" + x.key);
    if (rs.decisionIndex) rs.decisionIndex = sortBy(rs.decisionIndex, (x) => x.id);
    if (rs.policies) { rs.policies = { ...rs.policies, refs: sortBy(rs.policies.refs, (x) => x.policyId) as Array<{ policyId: string; policyFp: string }> }; if (rs.policies.revocationAbsent) rs.policies.revocationAbsent = [...rs.policies.revocationAbsent].sort(); }
  }
  const pl = c.payload || {};
  if (Array.isArray(pl.newNodes)) pl.newNodes = sortBy((pl.newNodes as MapNode[]).map(canonicalEntitySets), (n) => n.id);
  if (Array.isArray(pl.newEdges)) pl.newEdges = sortBy((pl.newEdges as MapEdge[]).map(canonicalEntitySets), (e) => e.id);
  if (Array.isArray(pl.edgeReroute)) pl.edgeReroute = sortBy(pl.edgeReroute as Array<{ edgeId: string; to: string }>, (r) => r.edgeId);
  if (Array.isArray(pl.absorbed)) pl.absorbed = sortBy(pl.absorbed as Array<{ id: string }>, (a) => a.id);
  if (Array.isArray(pl.alias)) pl.alias = [...(pl.alias as string[])].sort();
  if (Array.isArray(pl.retain)) pl.retain = [...(pl.retain as string[])].sort();
  if (Array.isArray(pl.to) && (pl.to as unknown[]).every((x) => typeof x === "string")) pl.to = [...(pl.to as string[])].sort(); // change_authority roles(4차 #2)
  if (Array.isArray(pl.expect) && (pl.expect as unknown[]).every((x) => typeof x === "string")) pl.expect = [...(pl.expect as string[])].sort();
  if (pl.node && typeof pl.node === "object") pl.node = canonicalEntitySets(pl.node as MapNode);
  if (pl.edge && typeof pl.edge === "object") pl.edge = canonicalEntitySets(pl.edge as MapEdge);
  for (const box of ["additions", "removals", "expect"]) {
    const b = pl[box] as Record<string, unknown> | undefined;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      if (Array.isArray(b.anchors)) b.anchors = sortBy(b.anchors as Anchor[], keyAnchor);
      if (Array.isArray(b.conditions) && (b.conditions as unknown[]).every((x) => typeof x === "string")) b.conditions = [...(b.conditions as string[])].sort();
    }
  }
  const pol = pl.policy as IntentPolicy | undefined;
  if (pol && typeof pol === "object") {
    if (Array.isArray(pol.scopeTarget)) pol.scopeTarget = [...pol.scopeTarget].sort();
    if (Array.isArray(pol.exclusions)) pol.exclusions = [...pol.exclusions].sort();
    if (Array.isArray(pol.supersedesPolicyIds)) pol.supersedesPolicyIds = [...pol.supersedesPolicyIds].sort();
  }
  return c;
}
export function opHashV2Of(p: MapPatchV2): string { return opHashOf(canonicalPatchV2(p) as unknown as Record<string, unknown>); }

export function targetIdsOfPatch(p: MapPatchV2): string[] {
  const pl = (p.payload || {}) as Record<string, unknown>;
  // 생성물 우선 수집(1차 #2: targetId 조기 반환이 split 생성물을 누락 — 생성 entity도 provenance 귀속 대상)
  if (p.operation === "add_node") { const n = pl.node as MapNode | undefined; return n && typeof n.id === "string" ? [n.id] : []; }
  if (p.operation === "add_edge") { const e = pl.edge as MapEdge | undefined; return e && typeof e.id === "string" ? [e.id] : []; }
  if (p.operation === "split_node") { const nn = (pl.newNodes as MapNode[]) || []; return [p.targetId, ...nn.map((n) => n && n.id)].filter((x): x is string => typeof x === "string"); }
  if (p.operation === "split_edge") { const ne = (pl.newEdges as MapEdge[]) || []; return [p.targetId, ...ne.map((e) => e && e.id)].filter((x): x is string => typeof x === "string"); }
  if (p.targetIds) return [...p.targetIds];
  if (p.targetId) return [p.targetId];
  return [];
}

// P4 dual reader: v3 검증 — v2 본문 검사를 사본(schema=v2·affectedIds 제거)으로 재사용하고 v3 고유 조건만 추가.
// 원본은 무변경(사본 검사) — v2 validator의 strict unknownKeys를 그대로 활용한다.
export function validateDecisionV3(d: MapDecisionV3): string[] {
  if (!d || typeof d !== "object") return ["decision이 객체가 아님"];
  if ((d as { schema?: unknown }).schema !== "map-decision-v3") return ['schema는 "map-decision-v3"여야'];
  const asV2 = { ...(d as unknown as Record<string, unknown>) };
  delete asV2.affectedIds;
  asV2.schema = "map-decision-v2";
  const errs = validateDecisionV2(asV2 as unknown as MapDecisionV2);
  const isPolicy = d.patch && isPolicyOpV2(d.patch.operation);
  const a = (d as { affectedIds?: unknown }).affectedIds;
  if (isPolicy) {
    if (a !== undefined) errs.push("정책 op decision(v3): affectedIds 금지(entity 대상 없음)");
  } else if (!Array.isArray(a) || !a.length || a.some((x) => typeof x !== "string" || !isUuid(x))) {
    errs.push("v3 topology decision: affectedIds(비어있지 않은 entity UUID 배열) 필수");
  } else if (JSON.stringify(a) !== JSON.stringify([...a].sort()) || new Set(a).size !== a.length) {
    errs.push("affectedIds는 정렬·중복 제거 canonical이어야");
  }
  return errs;
}
export function validateDecisionAny(d: MapDecisionV2 | MapDecisionV3): string[] {
  if (d && (d as { schema?: unknown }).schema === "map-decision-v3") return validateDecisionV3(d as MapDecisionV3);
  return validateDecisionV2(d as MapDecisionV2);
}
export function adpOf(d: MapDecisionV2 | MapDecisionV3): AuthorityDecisionProjection {
  return {
    decisionId: d.decisionId, mapId: d.mapId, patchId: d.patchId, opHash: d.opHash,
    operation: d.patch.operation, targetIds: targetIdsOfPatch(d.patch).sort(),
    verification: d.verification, evidenceFps: [...(d.evidenceFps || [])].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    classification: d.classification, resolutionOutcome: d.resolution.outcome,
    ...(d.verdictFp ? { verdictFp: d.verdictFp } : {}),
    // v3 전용 — v2 projection에는 이 키가 절대 들어가지 않는다(adpHash·decisionIndexHash·authorityHash 불변 계약)
    ...((d as MapDecisionV3).schema === "map-decision-v3" && (d as MapDecisionV3).affectedIds
      ? { affectedIds: [...((d as MapDecisionV3).affectedIds as string[])].sort() } : {}),
  };
}
export function adpHashOf(proj: AuthorityDecisionProjection): string { return domHash("adp", canonicalJsonOf(proj)); }
// dih: mapId 소속 유효 applied decision(정책 op 제외 — §C-3)의 projection 지문 정렬 색인.
export function decisionIndexHashOf(projectionHashes: string[]): string { return domHash("dih", JSON.stringify([...projectionHashes].sort())); }
export function authorityHashOf(mapHash: string, decisionIndexHash: string): string { return domHash("ah", mapHash + NUL + decisionIndexHash); }
export function decisionContextHashOf(authorityHash: string, policyFrontierHash: string): string { return domHash("dch", authorityHash + NUL + policyFrontierHash); }

// ── effectiveConfidence(§E — 정본 §3 수식·소비 계약) ───────────────────────────
// 판독기 분리(§E): decisionIndex는 decisions/만 읽은 결과(topology 안 읽음 — 혼합 스냅샷 차단),
// mapHash 결합은 호출자가 이미 확보한 동일 raw topology 스냅샷으로(authorityOf).
export type DecisionIndexState =
  | { st: "ok"; projections: AuthorityDecisionProjection[] }
  | { st: "none" }
  | { st: "error"; error: string };

export function decisionIndexHashOfState(idx: DecisionIndexState): string | null {
  if (idx.st !== "ok") return null;
  return decisionIndexHashOf(idx.projections.map(adpHashOf));
}

// provenance 4검사(§E): ①decisionId 실존 ②같은 mapId ③해당 entity 변경 ④evidence 지문 정합.
// ④는 파일 접근이 필요 — 순수 계층은 fileHashOf 주입(미제공=검사 생략 금지: fail-closed로 unknown).
export function effectiveConfidenceOf(
  entity: { id: string; state: { confidence: Confidence }; provenance?: ProvenanceRef },
  mapId: string,
  idx: DecisionIndexState,
  fileHashOf: (ref: string) => string | null,
): { confidence: Confidence; degraded?: string } {
  const stored = entity.state.confidence;
  if (stored !== "confirmed") return { confidence: stored }; // candidate/unknown은 어떤 경우에도 그대로(정본 §3 수식)
  if (idx.st === "error") return { confidence: "unknown", degraded: "decision 색인 판독 실패(" + idx.error + ") — confirmed 폴백 금지" };
  if (idx.st === "none") return { confidence: "unknown", degraded: "stored confirmed인데 decision 기록 부재(provenance dangling)" };
  const pv = entity.provenance;
  if (!pv || !pv.decisionId) return { confidence: "unknown", degraded: "confirmed인데 provenance 부재" };
  const proj = idx.projections.find((x) => x.decisionId === pv.decisionId);
  if (!proj) return { confidence: "unknown", degraded: "provenance decision 미실존(dangling)" };
  if (proj.mapId !== mapId) return { confidence: "unknown", degraded: "provenance decision의 mapId 불일치(세대 오염)" };
  // P4 판정 규칙: 구(v2) historyless는 basisFp가 provenance 포함 mapHashAfter 의미(자기참조)라 structural
  // 기준으로 재검증 불가 — 정직 강등(마이그레이션 위조 금지). v2 git=기존 검사 유지, v3=targetIds∪affectedIds.
  if (proj.affectedIds === undefined && (proj.verification as { kind?: string }).kind === "historyless") {
    return { confidence: "unknown", degraded: "구(v2) historyless provenance — structural 기준 재검증 불가(정직 강등)" };
  }
  if (!proj.targetIds.includes(entity.id) && !(proj.affectedIds || []).includes(entity.id)) {
    return { confidence: "unknown", degraded: "provenance decision이 이 entity를 변경하지 않음" };
  }
  if (canonicalJsonOf(pv.basis) !== canonicalJsonOf(proj.verification)) return { confidence: "unknown", degraded: "provenance basis가 decision 기록과 불일치" };
  for (const f of proj.evidenceFps) {
    const cur = fileHashOf(f.ref);
    if (cur === null || cur !== f.contentHash) return { confidence: "unknown", degraded: "evidence 지문이 현재 상태와 불일치(" + f.ref + ")" };
  }
  return { confidence: "confirmed" };
}

// authority-aware coverage(§E 소비 계약): stored 대신 effective를 집계. draft(색인 none+confirmed 0)는
// graphCoverage와 결과 동일 — 렌더 바이트 동일 계약의 짝.
export function graphCoverageEffective(
  t: Topology, idx: DecisionIndexState, fileHashOf: (ref: string) => string | null,
): { nodes: Record<Confidence, number>; edges: Record<Confidence, number>; degradedCount: number } {
  const zero = (): Record<Confidence, number> => ({ confirmed: 0, candidate: 0, unknown: 0 });
  const nodes = zero(), edges = zero();
  let degradedCount = 0;
  for (const n of t.nodes || []) { const r = effectiveConfidenceOf(n, t.mapId, idx, fileHashOf); nodes[r.confidence]++; if (r.degraded) degradedCount++; }
  for (const e of t.edges || []) { const r = effectiveConfidenceOf(e, t.mapId, idx, fileHashOf); edges[r.confidence]++; if (r.degraded) degradedCount++; }
  return { nodes, edges, degradedCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// P2-A2a: ②b semantic validation(1-20)·순수 적용기 applyOperationV2(§C-2) — 전부 순수(fs·시계 없음).
// ②b는 'topology 입력이 필요한 의미 검사'의 정식 진입점: 실패=needs-investigation(§4).
// ═══════════════════════════════════════════════════════════════════════════════

type EntityRef = { kind: "node"; ent: MapNode } | { kind: "edge"; ent: MapEdge };
function findEntity(t: Topology, id: string): EntityRef | null {
  const n = (t.nodes || []).find((x) => x && x.id === id);
  if (n) return { kind: "node", ent: n };
  const e = (t.edges || []).find((x) => x && x.id === id);
  if (e) return { kind: "edge", ent: e };
  return null;
}
const anchorKeyOf = (a: Anchor) => [a.kind, a.path, a.symbol || "", a.lineHint ?? ""].join("\u0000");
const evidenceKeyOf = (e: EvidenceRef) => [e.kind, e.ref, e.note || ""].join("\u0000");
function adjacentEdgeIds(t: Topology, nodeId: string): string[] {
  return (t.edges || []).filter((e) => e && (e.from === nodeId || e.to === nodeId)).map((e) => e.id).sort();
}

// ②b semantic validation(1-20 — validatePatchV2(형식) 통과를 전제로 호출):
// targetId 실존·expect vs 현재값 대조·op별 완전성(edgeReroute 전수 등)·조건부 P 승격(§D ◐ —
// frontier는 호출부가 '검증 통과한 정책들'로 주입: 미주입=정책 판정 불가로 needs-investigation 사유).
export type SemanticVerdict = { disposition: "ok" | "hard-reject" | "needs-investigation"; errors: string[] };
export function semanticValidateV2(
  t: Topology, p: MapPatchV2,
  ctx: { frontier?: IntentPolicy[] | null; policyIds?: Set<string> | string[]; revokedPolicyIds?: Set<string> | string[]; artifactIds?: Set<string> | string[] },
): SemanticVerdict {
  const errs: string[] = [];
  if (p.mapId !== t.mapId) return { disposition: "hard-reject", errors: ["mapId 불일치(세대 오염)"] }; // 8차 #7 — API로 구분(문자열 파싱 금지)
  const pl = (p.payload || {}) as Record<string, unknown>;
  const stateEq = (expect: Record<string, string>, cur: { lifecycle: string; implementation: string; confidence: string }) =>
    Object.entries(expect).every(([k, v]) => (cur as unknown as Record<string, string>)[k] === v);

  // 조건부 P 승격(§D ◐): 대상의 decisionLocks에 policy-ref가 있거나 적용 가능한 활성 정책이 있으면
  // readSet.policies 필수. 미지원 predicate(자동 매칭 불가 kind)는 생략 허용이 아니라 실패(정본 1-35).
  const targetIdsAll = targetIdsOfPatch(p);
  const targets = targetIdsAll.map((id) => findEntity(t, id)).filter((x): x is EntityRef => !!x);
  if (!isPolicyOpV2(p.operation)) {
    // 잠금 감지(8차 #5): 기존 대상뿐 아니라 '이 patch가 만드는' entity(payload 내 node/edge/newNodes/newEdges)의
    // policy-ref도 포함 — findEntity는 현재 topology만 보므로 생성물 잠금이 새던 구멍.
    const pl0 = (p.payload || {}) as Record<string, unknown>;
    const created: Array<MapNode | MapEdge> = [
      ...(pl0.node ? [pl0.node as MapNode] : []), ...(pl0.edge ? [pl0.edge as MapEdge] : []),
      ...((pl0.newNodes as MapNode[]) || []), ...((pl0.newEdges as MapEdge[]) || []),
    ];
    const hasLockRef = targets.some((x) => (x.ent.decisionLocks || []).some((l) => l.kind === "policy-ref"))
      || created.some((e) => (e.decisionLocks || []).some((l) => l.kind === "policy-ref"));
    // 적용 가능 정책 판정(8차 #5 — scope·opClass·exclusions 정확 비교):
    //  scope: project=전부 / entity·subgraph=scopeTarget∩(대상∪생성물 id)≠∅. exclusions=대상 id 제외 목록.
    //  opClass: patch.operation과 일치하거나 접두 부류(예: "merge"가 merge_node/merge_edge 커버).
    //  미지원 kind는 'scope 밖이면 무시' 우선 — scope 판정은 kind 무관하게 가능하므로, scope 안일 때만 실패.
    const involved = new Set([...targetIdsAll, ...created.map((e) => e.id)]);
    const inScope = (pol: IntentPolicy): boolean => {
      if ((pol.exclusions || []).some((x) => involved.has(x))) return false;
      if (pol.scope === "project") return true;
      return (pol.scopeTarget || []).some((id) => involved.has(id));
    };
    const opMatches = (opClass: unknown): boolean =>
      typeof opClass === "string" && (opClass === p.operation || p.operation.startsWith(opClass + "_"));
    let applicable = false;
    if (ctx.frontier === undefined || ctx.frontier === null) {
      // fail-closed(9차 #3): frontier 없이는 '적용 가능한 정책이 없다'를 판정할 수 없다 — 잠금 유무 무관 실패.
      // A2b는 항상 '검증된 frontier'(빈 배열 포함)를 주입한다.
      errs.push("frontier 미주입 — 정책 CAS 판정 불가(needs-investigation. 정책이 없는 레포도 빈 frontier를 명시 주입)");
    } else {
      for (const pol of ctx.frontier) {
        if (!inScope(pol)) continue; // scope 밖=무시(미지원 kind여도 — 8차 #5)
        // 지원 DSL 정확 고정(9차 #4): {version:1, kind:"op-class", opClass:string} 3필드 정확일 때만 자동
        // 해석 — 다른 버전·여분 의미 필드(negate 등)는 임의 해석하지 않고 needs-investigation(1-35).
        const pe = pol.predicateExpr as { version?: unknown; kind?: unknown; opClass?: unknown };
        const supported = pe && typeof pe === "object" && pe.version === 1 && pe.kind === "op-class"
          && typeof pe.opClass === "string" && Object.keys(pe).sort().join(",") === "kind,opClass,version";
        if (supported) { if (opMatches(pe.opClass)) applicable = true; }
        else errs.push(`미지원 predicate(${String(pe && pe.kind)}/v${String(pe && pe.version)}${pe && Object.keys(pe).length > 3 ? "+여분 필드" : ""}) — 자동 해석 금지(1-35)`);
      }
    }
    if ((hasLockRef || applicable) && !p.readSet.policies) errs.push("readSet.policies 필수 승격(◐ — 대상 잠금/적용 가능 정책 존재)");
  }

  switch (p.operation) {
    case "add_node": {
      const n = pl.node as MapNode;
      if (findEntity(t, n.id)) errs.push("add_node: id가 이미 존재");
      break;
    }
    case "add_edge": {
      const e = pl.edge as MapEdge;
      if (findEntity(t, e.id)) errs.push("add_edge: id가 이미 존재");
      if (!(t.nodes || []).some((x) => x.id === e.from)) errs.push("add_edge: from 노드 미실존");
      if (!(t.nodes || []).some((x) => x.id === e.to)) errs.push("add_edge: to 노드 미실존");
      if ((t.edges || []).some((x) => x.from === e.from && x.to === e.to && x.relation === e.relation)) errs.push("add_edge: 동일 (from,to,relation) edge 기존재");
      break;
    }
    case "set_state": case "tombstone_candidate": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push(`${p.operation}: targetId 미실존`); break; }
      if (!stateEq(pl.expect as Record<string, string>, tr.ent.state)) errs.push(`${p.operation}: expect가 현재 상태와 불일치(필드 CAS)`);
      break;
    }
    case "add_anchor": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push("add_anchor: targetId 미실존"); break; }
      if (tr.kind !== "node") { errs.push("add_anchor: 대상은 node여야(edge에 anchors 없음)"); break; }
      const key = anchorKeyOf(pl.anchor as Anchor);
      if ((tr.ent.anchors || []).some((a) => anchorKeyOf(a) === key)) errs.push("add_anchor: 동일 anchor 기존재");
      break;
    }
    case "add_evidence": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push("add_evidence: targetId 미실존"); break; }
      const key = evidenceKeyOf(pl.evidence as EvidenceRef);
      if ((tr.ent.evidence || []).some((e) => evidenceKeyOf(e) === key)) errs.push("add_evidence: 동일 evidence 기존재");
      break;
    }
    case "add_condition": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push("add_condition: targetId 미실존"); break; }
      if ((tr.ent.conditions || []).includes(pl.condition as string)) errs.push("add_condition: 동일 condition 기존재");
      break;
    }
    case "change_relation": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr || tr.kind !== "edge") { errs.push("change_relation: 대상 edge 미실존"); break; }
      if (tr.ent.relation !== pl.expect) errs.push("change_relation: expect가 현재 relation과 불일치");
      const e = tr.ent;
      if ((t.edges || []).some((x) => x.id !== e.id && x.from === e.from && x.to === e.to && x.relation === pl.to)) errs.push("change_relation: 변경 후와 동일한 edge 기존재(N 위반)");
      break;
    }
    case "split_node": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr || tr.kind !== "node") { errs.push("split_node: 대상 node 미실존"); break; }
      const nn = pl.newNodes as MapNode[];
      for (const n of nn) if (findEntity(t, n.id)) errs.push(`split_node: 신규 id 기존재(${n.id})`);
      // edgeReroute 전수성(§C-2): 원본의 모든 인접 edge가 재지향표에 정확히 1회씩.
      const adj = adjacentEdgeIds(t, p.targetId as string);
      const rr = (pl.edgeReroute as Array<{ edgeId: string; to: string }>).map((r) => r.edgeId).sort();
      if (canonicalJsonOf(adj) !== canonicalJsonOf(rr)) errs.push("split_node: edgeReroute가 인접 edge 전수와 불일치(누락/과잉)");
      // 구성요소 배분 보존(8차 #1 — 정본 §3 '구성요소 배분: anchors/evidence/conditions 분할표'):
      // 원본의 각 집합은 newNodes에 합집합=원본·쌍별 서로소로 정확히 배분돼야 한다(무검사 소실 차단).
      if (tr && tr.kind === "node") {
        const distOk = (orig: string[], parts: string[][], label: string) => {
          const all = parts.flat();
          if (new Set(all).size !== all.length) errs.push(`split_node: ${label} 중복 배분(서로소 위반)`);
          else if (canonicalJsonOf([...all].sort()) !== canonicalJsonOf([...orig].sort())) errs.push(`split_node: ${label} 배분이 원본과 불일치(소실/추가 금지 — 새 구성요소는 별도 widen으로)`);
        };
        distOk(((tr.ent.anchors || []) as Anchor[]).map(anchorKeyOf), nn.map((n) => ((n.anchors || []) as Anchor[]).map(anchorKeyOf)), "anchors");
        distOk(((tr.ent.evidence || []) as EvidenceRef[]).map(evidenceKeyOf), nn.map((n) => ((n.evidence || []) as EvidenceRef[]).map(evidenceKeyOf)), "evidence");
        distOk([...(tr.ent.conditions || [])], nn.map((n) => [...(n.conditions || [])]), "conditions");
      }
      break;
    }
    case "split_edge": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr || tr.kind !== "edge") { errs.push("split_edge: 대상 edge 미실존"); break; }
      const ne = pl.newEdges as MapEdge[];
      for (const e of ne) {
        if (findEntity(t, e.id)) errs.push(`split_edge: 신규 id 기존재(${e.id})`);
        if (!(t.nodes || []).some((x) => x.id === e.from) || !(t.nodes || []).some((x) => x.id === e.to)) errs.push("split_edge: 신규 edge endpoint 미실존");
      }
      if (tr && tr.kind === "edge") { // 배분 보존(8차 #1 — split_node와 동형)
        const distOk = (orig: string[], parts: string[][], label: string) => {
          const all = parts.flat();
          if (new Set(all).size !== all.length) errs.push(`split_edge: ${label} 중복 배분`);
          else if (canonicalJsonOf([...all].sort()) !== canonicalJsonOf([...orig].sort())) errs.push(`split_edge: ${label} 배분이 원본과 불일치`);
        };
        distOk([...(tr.ent.conditions || [])], ne.map((x) => [...(x.conditions || [])]), "conditions");
        distOk(((tr.ent.evidence || []) as EvidenceRef[]).map(evidenceKeyOf), ne.map((x) => ((x.evidence || []) as EvidenceRef[]).map(evidenceKeyOf)), "evidence");
      }
      break;
    }
    case "merge_node": case "merge_edge": {
      const wantKind = p.operation === "merge_node" ? "node" : "edge";
      for (const id of p.targetIds as string[]) {
        const tr = findEntity(t, id);
        if (!tr || tr.kind !== wantKind) errs.push(`${p.operation}: 대상 미실존/종류 불일치(${id})`);
      }
      const ab = pl.absorbed as Array<{ id: string; rerouteEdgesTo?: string; anchorsTo?: string; evidenceTo?: string }>;
      const absorbedIds = new Set(ab.map((a) => a.id));
      // merge 충돌 사전 판정(9차 #2 — 자동 정리는 '의미 동형'에만, 비동형=needs-investigation):
      if (p.operation === "merge_node") {
        const survivor = pl.survivorId as string;
        const destOf = (id: string) => { const a = ab.find((x) => x.id === id); return a ? (a.rerouteEdgesTo || survivor) : id; };
        const semKey = (e: MapEdge) => canonicalJsonOf({ state: e.state, conditions: [...(e.conditions || [])].sort(), evidence: [...((e.evidence || []) as EvidenceRef[])].map(evidenceKeyOf).sort(), notes: e.notes || "", decisionLocks: [...((e.decisionLocks || []) as DecisionLock[])].map((l) => canonicalJsonOf(l)).sort(), provenance: e.provenance || null });
        const hasMeaning = (e: MapEdge) => !!((e.conditions && e.conditions.length) || (e.evidence && e.evidence.length) || e.notes || (e.decisionLocks && e.decisionLocks.length) || e.provenance);
        // 검사 대상 한정(10차 — 적용기의 rerouted 판정과 동일 조건): 이번 merge에 '관여한'(endpoint가
        // absorbed) edge만 시뮬레이션 — read-set 밖 기존 self·중복 edge의 상태로 유효 merge가 차단되지 않게.
        const finalPos = new Map<string, { e: MapEdge; affected: boolean }[]>();
        for (const e of (t.edges || [])) {
          const affected = absorbedIds.has(e.from) || absorbedIds.has(e.to);
          const f = absorbedIds.has(e.from) ? destOf(e.from) : e.from;
          const t2 = absorbedIds.has(e.to) ? destOf(e.to) : e.to;
          if (f === t2) { // self化 — '관여 edge'만 판정(무관 기존 self는 불간섭)
            if (affected && hasMeaning(e)) errs.push(`merge_node: 내부 edge(${e.id})가 self가 되며 의미 필드를 보유 — 자동 폐기 금지(needs-investigation·9차 #2)`);
            continue;
          }
          const k = f + "\u0000" + t2 + "\u0000" + e.relation;
          const arr = finalPos.get(k) || []; arr.push({ e, affected }); finalPos.set(k, arr);
        }
        for (const [, arr] of finalPos) {
          if (arr.length < 2 || !arr.some((x) => x.affected)) continue; // 관여 edge 없는 그룹=무관 기존 중복(불간섭)
          const keys = new Set(arr.map((x) => semKey(x.e)));
          if (keys.size > 1) errs.push(`merge_node: 충돌 edge(${arr.map((x) => x.e.id).sort().join(",")})가 의미 비동형 — 자동 병합 금지(명시적 merge_edge로·1-13)`);
        }
      }
      for (const a of ab) for (const k of ["rerouteEdgesTo", "anchorsTo", "evidenceTo"] as const) {
        const dest = a[k];
        if (dest !== undefined) {
          if (absorbedIds.has(dest)) errs.push(`${p.operation}: absorbed.${k}가 함께 소멸하는 entity를 가리킴(${dest}) — 최종 생존 node로만(8차 #2)`);
          const dr = findEntity(t, dest);
          if (!dr || dr.kind !== "node") errs.push(`${p.operation}: absorbed.${k} 대상 미실존(${dest})`);
        }
      }
      break;
    }
    case "widen": case "narrow": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push(`${p.operation}: targetId 미실존`); break; }
      const box = (p.operation === "widen" ? pl.additions : pl.removals) as { anchors?: Anchor[]; conditions?: string[] };
      const ex = pl.expect as { anchors?: Anchor[]; conditions?: string[] };
      // expect=현 범위 CAS: 명시된 축의 현재 목록과 정확 일치.
      if (ex.conditions !== undefined && canonicalJsonOf([...(tr.ent.conditions || [])].sort()) !== canonicalJsonOf([...ex.conditions].sort())) errs.push(`${p.operation}: expect.conditions가 현재와 불일치`);
      if (ex.anchors !== undefined) {
        if (tr.kind !== "node") errs.push(`${p.operation}: anchors 축은 node 전용`);
        else if (canonicalJsonOf(((tr.ent.anchors || []) as Anchor[]).map(anchorKeyOf).sort()) !== canonicalJsonOf((ex.anchors as Anchor[]).map(anchorKeyOf).sort())) errs.push(`${p.operation}: expect.anchors가 현재와 불일치`);
      }
      if (p.operation === "widen") {
        for (const c of box.conditions || []) if ((tr.ent.conditions || []).includes(c)) errs.push(`widen: 추가분이 이미 존재(${c}) — N 위반`);
        if (box.anchors && tr.kind === "node") for (const a of box.anchors) if (((tr.ent.anchors || []) as Anchor[]).some((x) => anchorKeyOf(x) === anchorKeyOf(a))) errs.push("widen: 추가 anchor 기존재");
      } else {
        for (const c of box.conditions || []) if (!(tr.ent.conditions || []).includes(c)) errs.push(`narrow: 제거 대상 미존재(${c})`);
        if (box.anchors && tr.kind === "node") for (const a of box.anchors) if (!((tr.ent.anchors || []) as Anchor[]).some((x) => anchorKeyOf(x) === anchorKeyOf(a))) errs.push("narrow: 제거 anchor 미존재");
        for (const r of (pl.retain as string[]) || []) if (!(tr.ent.conditions || []).includes(r)) errs.push(`narrow: retain 대상 미존재(${r})`);
      }
      break;
    }
    case "supersede": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push("supersede: targetId 미실존"); break; }
      const sr = findEntity(t, pl.successorId as string);
      if (!sr) errs.push("supersede: successor 미실존");
      else if (tr && sr.kind !== tr.kind) errs.push("supersede: 대상과 successor의 종류 불일치(node→node·edge→edge — 9차 #5)");
      if (!stateEq(pl.expect as Record<string, string>, tr.ent.state)) errs.push("supersede: expect가 현재 상태와 불일치");
      if (tr.ent.state.lifecycle === "superseded") errs.push("supersede: 이미 superseded");
      break;
    }
    case "change_steward": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr || tr.kind !== "node") { errs.push("change_steward: 대상 node 미실존"); break; }
      if ((tr.ent.steward || "") !== pl.expect) errs.push("change_steward: expect가 현재 steward와 불일치");
      break;
    }
    case "change_authority": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr || tr.kind !== "node") { errs.push("change_authority: 대상 node 미실존(§3 — node 한정)"); break; }
      if (canonicalJsonOf([...tr.ent.roles].sort()) !== canonicalJsonOf([...(pl.expect as string[])].sort())) errs.push("change_authority: expect가 현재 roles와 불일치");
      break;
    }
    case "rewrite_label": {
      const tr = findEntity(t, p.targetId as string);
      if (!tr) { errs.push("rewrite_label: targetId 미실존"); break; }
      const ex = pl.expect as Record<string, string>;
      if (ex.notes !== undefined) {
        if (tr.kind !== "edge") errs.push("rewrite_label: notes 축은 edge 전용");
        else if ((tr.ent.notes || "") !== ex.notes) errs.push("rewrite_label: expect.notes가 현재와 불일치");
      } else {
        if (tr.kind !== "node") errs.push("rewrite_label: label/description 축은 node 전용");
        else {
          if (ex.label !== undefined && tr.ent.label !== ex.label) errs.push("rewrite_label: expect.label 불일치");
          if (ex.description !== undefined && (tr.ent.description || "") !== ex.description) errs.push("rewrite_label: expect.description 불일치");
        }
      }
      break;
    }
    case "create_intent_policy": case "supersede_intent_policy": case "revoke_intent_policy": {
      // 정책 op ②b(12차 #6): 파일 판독기가 주입한 정책 상태로 의미 검사 — create=기존 policyId 부재
      // (immutable 덮어쓰기 차단), supersede/revoke=대상 실존+revocation 부재. 미주입=판정 불가(fail-closed).
      const ids = ctx.policyIds instanceof Set ? ctx.policyIds : new Set(ctx.policyIds || []); // 정책 실존만(13차 #7 — revocationId 혼입 금지)
      const arts = ctx.artifactIds instanceof Set ? ctx.artifactIds : new Set(ctx.artifactIds || [...ids]); // 충돌 검사용 전체 artifact id
      const revoked = ctx.revokedPolicyIds instanceof Set ? ctx.revokedPolicyIds : new Set(ctx.revokedPolicyIds || []);
      if (ctx.policyIds === undefined) { errs.push("정책 상태 미주입 — 정책 op ②b 판정 불가(needs-investigation)"); break; }
      if (p.operation === "create_intent_policy") {
        const pid = ((pl.policy || {}) as IntentPolicy).policyId;
        if (arts.has(pid)) errs.push("create_intent_policy: policyId 기존재(불변 파일 덮어쓰기 금지)");
      } else if (p.operation === "supersede_intent_policy") {
        const pol2 = (pl.policy || {}) as IntentPolicy;
        if (arts.has(pol2.policyId)) errs.push("supersede_intent_policy: 새 policyId 기존재");
        for (const tid of p.targetPolicyIds || []) {
          if (!ids.has(tid)) errs.push(`supersede_intent_policy: 대상 정책 미실존(${tid})`);
          if (revoked.has(tid)) errs.push(`supersede_intent_policy: 대상이 이미 revoke됨(${tid})`);
        }
      } else {
        const tid = p.targetPolicyId as string;
        if (!ids.has(tid)) errs.push("revoke_intent_policy: 대상 정책 미실존");
        if (revoked.has(tid)) errs.push("revoke_intent_policy: 이미 revoke됨(중복 철회)");
        const rid = ((pl.revocation || {}) as PolicyRevocation).revocationId;
        if (arts.has(rid)) errs.push("revoke_intent_policy: revocationId가 기존 artifact와 충돌");
      }
      break;
    }
  }
  return { disposition: errs.length ? "needs-investigation" : "ok", errors: errs }; // ②b 실패=needs-investigation(1-20)
}

// 순수 적용기(§C-2): 입력 불변·출력은 호출부가 validateTopology 전체 재검증. revision +1.
// proposal-only(tombstone_candidate)·정책 op는 이 함수의 대상이 아니다 — 호출 시 오류 반환.
// split의 원본 entity는 제거된다(분할=신규가 대체 — inverse가 merge/split 쌍이므로 복원 가능,
// 이력은 decision이 보유. merge 흡수 제거와 대칭). supersede/tombstone은 lifecycle만(제거 없음 — §C-2).
export function applyOperationV2(t: Topology, p: MapPatchV2): { topo: Topology | null; changedIds: string[]; errors: string[] } {
  if (isProposalOnlyOpV2(p.operation)) return { topo: null, changedIds: [], errors: ["proposal-only op는 적용 불가(파생 set_state로 — §C-2)"] };
  if (isPolicyOpV2(p.operation)) return { topo: null, changedIds: [], errors: ["정책 op는 topology 적용기 대상 아님(F-2 — topology 무변경)"] };
  const c: Topology = JSON.parse(JSON.stringify(t));
  const pl = (p.payload || {}) as Record<string, unknown>;
  const changed: string[] = [];
  const node = (id: string) => (c.nodes || []).find((x) => x.id === id) as MapNode | undefined;
  const edge = (id: string) => (c.edges || []).find((x) => x.id === id) as MapEdge | undefined;
  const ent = (id: string) => node(id) || edge(id);
  switch (p.operation) {
    case "add_node": c.nodes.push(pl.node as MapNode); changed.push((pl.node as MapNode).id); break;
    case "add_edge": c.edges.push(pl.edge as MapEdge); changed.push((pl.edge as MapEdge).id); break;
    case "set_state": {
      const e = ent(p.targetId as string)!;
      e.state = { ...e.state, ...(pl.to as Record<string, never>) };
      changed.push(e.id); break;
    }
    case "add_anchor": { const n = node(p.targetId as string)!; n.anchors = [...(n.anchors || []), pl.anchor as Anchor]; changed.push(n.id); break; }
    case "add_evidence": { const e = ent(p.targetId as string)!; e.evidence = [...(e.evidence || []), pl.evidence as EvidenceRef]; changed.push(e.id); break; }
    case "add_condition": { const e = ent(p.targetId as string)!; e.conditions = [...(e.conditions || []), pl.condition as string]; changed.push(e.id); break; }
    case "change_relation": { const e = edge(p.targetId as string)!; e.relation = pl.to as typeof RELATIONS[number]; changed.push(e.id); break; }
    case "split_node": {
      const origId = p.targetId as string;
      c.nodes = c.nodes.filter((x) => x.id !== origId);
      for (const n of pl.newNodes as MapNode[]) c.nodes.push(n);
      for (const r of pl.edgeReroute as Array<{ edgeId: string; to: string }>) {
        const e = edge(r.edgeId); if (!e) continue;
        if (e.from === origId) e.from = r.to;
        if (e.to === origId) e.to = r.to;
        changed.push(e.id);
      }
      changed.push(origId, ...(pl.newNodes as MapNode[]).map((n) => n.id));
      break;
    }
    case "split_edge": {
      const origId = p.targetId as string;
      c.edges = c.edges.filter((x) => x.id !== origId);
      for (const e of pl.newEdges as MapEdge[]) c.edges.push(e);
      changed.push(origId, ...(pl.newEdges as MapEdge[]).map((e) => e.id));
      break;
    }
    case "merge_node": {
      const surv = node(pl.survivorId as string)!;
      const rerouted = new Set<string>();
      for (const a of pl.absorbed as Array<{ id: string; rerouteEdgesTo?: string; anchorsTo?: string; evidenceTo?: string }>) {
        const dead = node(a.id); if (!dead) continue;
        const anchorDest = node(a.anchorsTo || surv.id)!;
        const evDest = ent(a.evidenceTo || surv.id)!;
        const edgeDest = a.rerouteEdgesTo || surv.id;
        // 소지품 병합 — 자연 병합의 키 중복은 제거(입력 patch의 중복 거부와 별개: 두 노드가 같은 anchor를
        // 정당하게 공유하던 경우의 합집합).
        const aSeen = new Set(((anchorDest.anchors || []) as Anchor[]).map(anchorKeyOf));
        for (const x of dead.anchors || []) if (!aSeen.has(anchorKeyOf(x))) { anchorDest.anchors = [...(anchorDest.anchors || []), x]; aSeen.add(anchorKeyOf(x)); }
        const eSeen = new Set(((evDest.evidence || []) as EvidenceRef[]).map(evidenceKeyOf));
        for (const x of dead.evidence || []) if (!eSeen.has(evidenceKeyOf(x))) { evDest.evidence = [...(evDest.evidence || []), x]; eSeen.add(evidenceKeyOf(x)); }
        if (a.anchorsTo) changed.push(a.anchorsTo); // 외부 destination도 변경 대상(8차 #4)
        if (a.evidenceTo) changed.push(a.evidenceTo);
        for (const e of c.edges) {
          if (e.from === a.id) { e.from = edgeDest; changed.push(e.id); rerouted.add(e.id); }
          if (e.to === a.id) { e.to = edgeDest; changed.push(e.id); rerouted.add(e.id); }
        }
        c.nodes = c.nodes.filter((x) => x.id !== a.id);
        changed.push(a.id);
      }
      // 정리는 '이번 재지향으로 생긴' 충돌에만 한정(8차 #3)·생존자는 결정론(9차 #1 — 최소 id 고정.
      // 비동형 충돌·의미 보유 self는 ②b가 사전 차단했으므로 여기 도달한 충돌은 의미 동형=어느 쪽이든 등가):
      c.edges = c.edges.filter((e) => { if (rerouted.has(e.id) && e.from === e.to) { changed.push(e.id); return false; } return true; });
      const keyE = (e: MapEdge) => e.from + "\u0000" + e.to + "\u0000" + e.relation;
      const groups = new Map<string, MapEdge[]>();
      for (const e of c.edges) { const k = keyE(e); const arr = groups.get(k) || []; arr.push(e); groups.set(k, arr); }
      const drop = new Set<string>();
      for (const [, arr] of groups) {
        if (arr.length < 2 || !arr.some((e) => rerouted.has(e.id))) continue; // 재지향 관여 충돌만(무관 기존 중복 불간섭)
        const survivorEdge = [...arr].sort((x, y) => (x.id < y.id ? -1 : 1))[0]; // 결정론: 최소 id
        for (const e of arr) if (e.id !== survivorEdge.id) { drop.add(e.id); changed.push(e.id); }
      }
      c.edges = c.edges.filter((e) => !drop.has(e.id));
      changed.push(surv.id);
      break;
    }
    case "merge_edge": {
      const surv = edge(pl.survivorId as string)!;
      for (const a of pl.absorbed as Array<{ id: string }>) {
        const dead = edge(a.id); if (!dead) continue;
        const cSeen = new Set(surv.conditions || []);
        for (const x of dead.conditions || []) if (!cSeen.has(x)) { surv.conditions = [...(surv.conditions || []), x]; cSeen.add(x); }
        const eSeen = new Set(((surv.evidence || []) as EvidenceRef[]).map(evidenceKeyOf));
        for (const x of dead.evidence || []) if (!eSeen.has(evidenceKeyOf(x))) { surv.evidence = [...(surv.evidence || []), x]; eSeen.add(evidenceKeyOf(x)); }
        c.edges = c.edges.filter((x) => x.id !== a.id);
        changed.push(a.id);
      }
      changed.push(surv.id);
      break;
    }
    case "widen": case "narrow": {
      const e = ent(p.targetId as string)!;
      const box = (p.operation === "widen" ? pl.additions : pl.removals) as { anchors?: Anchor[]; conditions?: string[] };
      if (p.operation === "widen") {
        if (box.conditions) e.conditions = [...(e.conditions || []), ...box.conditions];
        if (box.anchors) (e as MapNode).anchors = [...((e as MapNode).anchors || []), ...box.anchors];
      } else {
        const retain = new Set((pl.retain as string[]) || []);
        if (box.conditions) { const rm = new Set(box.conditions.filter((x) => !retain.has(x))); e.conditions = (e.conditions || []).filter((x) => !rm.has(x)); }
        if (box.anchors) { const rm = new Set(box.anchors.map(anchorKeyOf)); (e as MapNode).anchors = (((e as MapNode).anchors || []) as Anchor[]).filter((x) => !rm.has(anchorKeyOf(x))); }
      }
      changed.push(e.id); break;
    }
    case "supersede": { const e = ent(p.targetId as string)!; e.state = { ...e.state, lifecycle: "superseded" }; changed.push(e.id); break; }
    case "change_steward": { const n = node(p.targetId as string)!; if ((pl.to as string) === "") delete n.steward; else n.steward = pl.to as string; changed.push(n.id); break; }
    case "change_authority": { const n = node(p.targetId as string)!; n.roles = [...(pl.to as MapNode["roles"])]; changed.push(n.id); break; }
    case "rewrite_label": {
      const ex = pl.to as Record<string, string>;
      const e = ent(p.targetId as string)!;
      if (ex.notes !== undefined) (e as MapEdge).notes = ex.notes;
      if (ex.label !== undefined) (e as MapNode).label = ex.label;
      if (ex.description !== undefined) (e as MapNode).description = ex.description;
      changed.push(e.id); break;
    }
  }
  c.revision = (c.revision || 0) + 1; // topology 변경 성공마다 정확히 1 증가(표시·감사 — CAS 불참: §C-2)
  return { topo: c, changedIds: [...new Set(changed)].sort(), errors: [] };
}
