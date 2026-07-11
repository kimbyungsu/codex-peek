"use strict";
/*
 * Project MAP v1(draft 전용 뼈대) — 설계 사전검증 3왕복 합의 잠금.
 * 순수 계산(스키마 반례·canonical 결정성·정책기 tier·patch 형식·복구 3분기·dirtyFp 제외)+CLI 끝-끝(init 1회성·
 * 재실행 거부·render 지문·수동 수정 탐지)+fail-closed 잠금.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pmap_"));
process.env.CODEX_BRIDGE_HOME = home;
const PM = require(path.join(__dirname, "..", "out", "project-map.js"));
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const mkTopo = () => ({
  schemaVersion: PM.MAP_SCHEMA_VERSION, draft: true, project: "t", createdAt: "2026-07-10T00:00:00Z", revision: 1,
  nodes: [
    { id: "11111111-1111-4111-8111-111111111111", label: "core", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.ts" }] },
    { id: "22222222-2222-4222-8222-222222222222", label: "store", entityType: "store", roles: ["storage"], state: { lifecycle: "active", implementation: "runtime", confidence: "confirmed" }, anchors: [] },
  ],
  edges: [{ id: "33333333-3333-4333-8333-333333333333", from: "11111111-1111-4111-8111-111111111111", to: "22222222-2222-4222-8222-222222222222", relation: "stores", state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" } }],
  inventory: { scanComplete: true, filesSeen: 2, policyExcluded: [], depthCapped: [], entryCapped: false, unreadable: [], semantic: { supportedLangs: ["js", "ts"], scannedSupportedFiles: 2, unsupportedFiles: 0, dynamicUnknowns: 0, externalOrAliasSkipped: 0, semanticUnreadable: [], parserNote: "regex" } },
  freshnessNote: "신선도 판정 미지원(v1)",
});

console.log("[1] 스키마 검증 — 4차원 상태·불투명 ID·enum·참조 실존(설계검증 반례 잠금)");
ok(PM.validateTopology(mkTopo()).length === 0, "정상 topology → 위반 0");
{
  const t = mkTopo(); t.draft = false;
  ok(PM.validateTopology(t).some((e) => /draft:true만 허용/.test(e)), "v1에서 draft:false → 거부(정본 채택은 승인 경로 이관 후 — 권위 이원화 차단)");
}
{
  const t = mkTopo(); t.edges[0].from = "99999999-9999-4999-8999-999999999999";
  ok(PM.validateTopology(t).some((e) => /참조 부재/.test(e)), "엣지의 유령 참조 → 위반");
}
{
  const t = mkTopo(); t.nodes[0].state.lifecycle = "stale";
  ok(PM.validateTopology(t).some((e) => /lifecycle 불량/.test(e)), "stale은 lifecycle이 아님(신선도는 저장 안 함 — 4차원 분리 계약)");
}
{
  const t = mkTopo(); t.edges[0].relation = "reads";
  ok(PM.validateTopology(t).some((e) => /relation 불량/.test(e)), "미등록 관계 거부(enum·확장은 schemaVersion 동반)");
}

console.log("[2] canonical 직렬화 — 결정성(키·배열 순서 무관 같은 지문)·위조 구분");
{
  const a = mkTopo();
  const b = mkTopo(); b.nodes.reverse(); b.nodes[0] = { ...b.nodes[0], roles: [...b.nodes[0].roles].reverse() };
  ok(PM.canonicalSerialize(a) === PM.canonicalSerialize(b), "노드·roles 순서가 달라도 canonical 동일(결정성)");
  ok(PM.mapHashOf(a) === PM.mapHashOf(b), "지문 동일");
  const c = mkTopo(); c.nodes[0].label = "core2";
  ok(PM.mapHashOf(a) !== PM.mapHashOf(c), "내용이 다르면 지문 상이 — 같은 revision·다른 내용 위조를 mapHash가 구분(CAS 근거는 revision이 아님)");
}

console.log("[3] 정책기 tier — 제출자 신뢰 없음·op+목표값 기반(설계검증: tombstone 확정은 항상 사람)");
ok(PM.policyTier("add_evidence", {}) === "auto", "증거 추가=auto");
ok(PM.policyTier("set_state", { to: { lifecycle: "tombstoned" } }) === "human", "tombstone 목표=human(자동은 후보 감지까지 — 확정은 사람)");
ok(PM.policyTier("set_state", { to: { lifecycle: "superseded" } }) === "human", "대체 확정=human");
ok(PM.policyTier("set_state", { to: { implementation: "partial" } }) === "verified-auto", "active↔partial=검증 후 자동");
ok(PM.policyTier("add_edge", {}) === "verified-auto", "새 연결(확대)=검증 후 자동");
ok(PM.policyTier("change_relation", {}) === "human", "관계 의미 변경=human");

console.log("[4] patch 형식 — 증거 최소조건(코드/테스트/설정 — 지도·문구 단독 금지)·op별 필수·CAS 3요소");
{
  const base = { patchId: "44444444-4444-4444-8444-444444444444", baseMapHash: "a".repeat(40), baseHead: "deadbeef", baseDirtyFp: "fp", operation: "set_state", targetId: "11111111-1111-4111-8111-111111111111", payload: { to: { implementation: "partial" }, expect: { implementation: "runtime" } }, evidence: [{ kind: "code", ref: "src/a.ts:10" }], rationale: "r" };
  ok(PM.validatePatch(base).length === 0, "정상 patch → 위반 0");
  ok(PM.validatePatch({ ...base, evidence: [] }).some((e) => /최소 1개/.test(e)), "증거 0 → 거부");
  ok(PM.validatePatch({ ...base, evidence: [{ kind: "ledger", ref: "sig-x" }] }).some((e) => /code\/test\/config/.test(e)), "장부 문구 단독 증거 → 거부(문구 분열 전파·자기확인 고리 차단)");
  ok(PM.validatePatch({ ...base, payload: { to: { implementation: "partial" } } }).some((e) => /expect/.test(e)), "기대 이전값(expect) 없는 set_state → 거부");
  ok(PM.validatePatch({ ...base, baseMapHash: "12" }).some((e) => /canonical sha1/.test(e)), "baseMapHash 형식 위조 → 거부");
  ok(PM.validatePatch({ ...base, operation: "change_relation", payload: { to: "calls", expect: "imports" } }).some((e) => /inverse/.test(e)), "역연산 없는 관계 변경 → 거부");
}
ok(JSON.stringify(PM.dirtyFpFilter(["src/a.ts", "project-map/topology.json", "project-map\\MAP.md", "docs/x.md"])) === JSON.stringify(["src/a.ts", "docs/x.md"]), "dirty 지문에서 project-map/** 제외 — 제안 기록이 자기 CAS를 깨는 반례 봉합");

console.log("[4-1] 검증 2차 반례 — 빈 payload auto 통과·복원 권한 상승·approve 필수 필드·집합 배열 정렬");
{
  const base = { patchId: "44444444-4444-4444-8444-444444444444", baseMapHash: "a".repeat(40), baseHead: "deadbeef", baseDirtyFp: "fp", operation: "add_anchor", targetId: "11111111-1111-4111-8111-111111111111", payload: {}, evidence: [{ kind: "code", ref: "src/a.ts:10" }], rationale: "r" };
  ok(PM.validatePatch(base).some((e) => /anchor 불량/.test(e)), "add_anchor 빈 payload → 거부(존재 검사만으론 auto 우회 — Codex 반례)");
  ok(PM.validatePatch({ ...base, operation: "add_evidence", payload: {} }).some((e) => /evidence 불량/.test(e)), "add_evidence 빈 payload → 거부");
  ok(PM.validatePatch({ ...base, operation: "add_node", payload: { node: true } }).some((e) => /노드 스키마 위반/.test(e)), "add_node:{node:true} 스키마 우회 → 거부");
  ok(PM.validatePatch({ ...base, patchId: "not-uuid" }).some((e) => /UUID여야/.test(e)), "patchId 비UUID → 거부");
  ok(PM.validatePatch({ ...base, baseHead: "not-hash" }).some((e) => /git 커밋 해시/.test(e)), "baseHead 형식 위조 → 거부");
  ok(PM.validatePatch({ ...base, operation: "set_state", payload: { to: { implementation: "partial" }, expect: { implementation: "partial" } } }).some((e) => /무의미 변경/.test(e)), "to=expect → 거부");
  ok(PM.policyTier("set_state", { to: { lifecycle: "active" }, expect: { lifecycle: "tombstoned" } }) === "human", "tombstoned→active '복원'도 human(Codex 반례: verified-auto로 새던 권한 상승)");
  const d = { decisionId: "55555555-5555-4555-8555-555555555555", patchId: base.patchId, action: "approve", actor: "user", ts: "t" };
  ok(PM.validateDecision(d).some((e) => /expectedMapHashAfter/.test(e)) && PM.validateDecision(d).some((e) => /patch 사본/.test(e)), "approve에 복구 계약 필드 없으면 거부(선택 필드면 복구 불능 레코드 허용 — Codex)");
  ok(PM.validateDecision({ ...d, opHash: "b".repeat(40), payload: { x: 1 }, expectedMapHashAfter: "c".repeat(40) }).some((e) => /patch 사본/.test(e)), "임의 객체 payload({x:1}) → 거부(재적용 가능한 정규화 patch 사본이어야 — 2차 반례)");
  {
    const copy = { ...base, payload: { anchor: { kind: "code", path: "src/a.ts" } } }; // validatePatch '전체' 통과하는 정규화 사본
    const okD = { ...d, payload: copy, opHash: PM.opHashOf(copy), expectedMapHashAfter: "c".repeat(40) };
    ok(PM.validateDecision(okD).length === 0, "정규화 사본+재계산 지문 일치 approve → 통과");
    ok(PM.validateDecision({ ...okD, opHash: "b".repeat(40) }).some((e) => /재계산 지문과 불일치/.test(e)), "임의 hex opHash → 거부(검증기가 직접 재계산 대조 — 2차 반례)");
    // 3차 반례: opHash는 '불변'만 증명 — 완전성(validatePatch)·결합(patchId)은 별도 강제
    const partial = { operation: "add_node", baseMapHash: "a".repeat(40), baseHead: "deadbeef" };
    ok(PM.validateDecision({ ...d, payload: partial, opHash: PM.opHashOf(partial), expectedMapHashAfter: "c".repeat(40) }).some((e) => /유효한 patch 사본이 아님/.test(e)), "불완전 사본(operation·base만·evidence/payload 없음) → 거부(재적용 불능 — 3차 반례)");
    const other = { ...copy, patchId: "77777777-7777-4777-8777-777777777777" };
    ok(PM.validateDecision({ ...d, payload: other, opHash: PM.opHashOf(other), expectedMapHashAfter: "c".repeat(40) }).some((e) => /decision\.patchId와 불일치/.test(e)), "decision은 patch A를 가리키며 payload는 B → 거부(결합 강제 — 3차 반례)");
  }
  ok(PM.validatePatch({ ...base, operation: "set_state", payload: { to: { confidence: "confirmed" }, expect: { lifecycle: "active" } } }).some((e) => /필드 집합이 같아야/.test(e)), "to·expect 필드 집합 불일치 → 거부(바꾸는 필드의 기존값 확인 없는 승격 차단 — 2차 반례)");
  ok(PM.validatePatch({ ...base, operation: "add_node", payload: { node: { id: "66666666-6666-4666-8666-666666666666", label: "x", entityType: "module", roles: ["bad-role"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "nope", path: "" }] } } }).some((e) => /노드 스키마 위반/.test(e)), "잘못된 role·anchor를 가진 add_node → 거부(topology validator와 같은 함수 — 2차 반례)");
  // 집합 의미 배열 정렬(Codex 실측: conditions/evidence/policyExcluded 순서만 달라도 지문이 갈라짐)
  const t1 = mkTopo(); t1.nodes[0].conditions = ["b", "a"]; t1.nodes[0].evidence = [{ kind: "code", ref: "z" }, { kind: "code", ref: "a" }]; t1.inventory.policyExcluded = ["y", "x"];
  const t2 = mkTopo(); t2.nodes[0].conditions = ["a", "b"]; t2.nodes[0].evidence = [{ kind: "code", ref: "a" }, { kind: "code", ref: "z" }]; t2.inventory.policyExcluded = ["x", "y"];
  ok(PM.mapHashOf(t1) === PM.mapHashOf(t2), "집합 의미 배열(conditions·evidence·policyExcluded) 순서 무관 동일 지문 — 파일시스템 순회 순서 의존 CAS 거짓 충돌 봉합");
  // 2차 반례: anchor 부분 정렬 키(kind·lineHint 누락)·semanticUnreadable 미등록
  const t3 = mkTopo(); t3.nodes[0].anchors = [{ kind: "test", path: "p", lineHint: 2 }, { kind: "code", path: "p", lineHint: 1 }]; t3.inventory.semantic.semanticUnreadable = ["b", "a"];
  const t4 = mkTopo(); t4.nodes[0].anchors = [{ kind: "code", path: "p", lineHint: 1 }, { kind: "test", path: "p", lineHint: 2 }]; t4.inventory.semantic.semanticUnreadable = ["a", "b"];
  ok(PM.mapHashOf(t3) === PM.mapHashOf(t4), "anchor 전체 키(kind·lineHint)·semanticUnreadable도 정렬 — 부분 키의 잔여 비결정성 봉합(2차 반례)");
  // inventory 수치 검증(2차 반례: filesSeen=-1·필드 누락이 오류 0으로 통과)
  const t5 = mkTopo(); t5.inventory.filesSeen = -1; delete t5.inventory.semantic.dynamicUnknowns;
  ok(PM.validateTopology(t5).some((e) => /비음수 정수여야/.test(e)), "filesSeen 음수·semantic 수치 누락 → 거부");
  // 3차 반례: 배열 원소 비문자열([1])이 오류 0으로 통과·nodes:{}가 TypeError로 사망
  const t6 = mkTopo(); t6.inventory.policyExcluded = [1];
  ok(PM.validateTopology(t6).some((e) => /문자열 배열이어야/.test(e)), "배열 원소 비문자열(policyExcluded:[1]) → 거부(3차 반례)");
  const t6b = mkTopo(); t6b.inventory.semantic.supportedLangs = [1];
  ok(PM.validateTopology(t6b).some((e) => /문자열 배열이어야/.test(e)), "semantic.supportedLangs:[1] → 거부");
  const t7 = mkTopo(); t7.nodes = {};
  let r7 = null; try { r7 = PM.validateTopology(t7); } catch { /* 예외로 죽으면 실패 */ }
  ok(Array.isArray(r7) && r7.some((e) => /배열이 아님/.test(e)), "nodes:{} → 예외 없이 진단 반환(외부 파일 읽는 validator는 죽지 않는다 — 3차 반례)");
  // 4차 반례: 배열은 맞지만 원소가 null — JSON에서 문법적으로 유효(수동 편집·부분 손상)
  const t7b = mkTopo(); t7b.nodes = [null]; t7b.edges = [null];
  let r7b = null; try { r7b = PM.validateTopology(t7b); } catch { /* 예외로 죽으면 실패 */ }
  ok(Array.isArray(r7b) && r7b.some((e) => /노드 원소가 객체가 아님/.test(e)) && r7b.some((e) => /엣지 원소가 객체가 아님/.test(e)), "nodes:[null]·edges:[null] → 예외 없이 원소 단위 진단(4차 반례)");
  // 5차 반례: 중첩 필드 — roles:{}·anchors:[null]·evidence:[null]·conditions:{}(노드), evidence:[null]·conditions:{}(엣지)
  const t7c = mkTopo();
  t7c.nodes[0].roles = {}; t7c.nodes[0].anchors = [null]; t7c.nodes[0].evidence = [null]; t7c.nodes[0].conditions = {};
  t7c.edges[0].evidence = [null]; t7c.edges[0].conditions = {};
  let r7c = null; try { r7c = PM.validateTopology(t7c); } catch { /* 예외로 죽으면 실패 */ }
  ok(Array.isArray(r7c)
    && r7c.some((e) => /roles가 배열이 아님/.test(e)) && r7c.some((e) => /conditions가 배열이 아님/.test(e))
    && r7c.some((e) => /anchor 불량/.test(e)) && r7c.filter((e) => /evidence 불량/.test(e)).length >= 2,
  "중첩 필드(roles:{}·anchors:[null]·evidence:[null]·conditions:{}) → 예외 없이 전부 진단(5차 반례 — 노드·엣지 공통)");
  // 6차 반례: {"toString":null} — 정상 JSON인데 템플릿 보간·RegExp.test의 String 변환이 TypeError로 사망하던 값
  const poison = { toString: null, valueOf: null };
  const t9 = mkTopo();
  t9.nodes[0].id = poison; t9.nodes[0].entityType = poison; t9.nodes[0].roles = [poison];
  t9.nodes[0].state = { lifecycle: poison, implementation: "runtime", confidence: "candidate" };
  t9.edges[0].relation = poison; t9.edges[0].from = poison;
  let r9 = null; try { r9 = PM.validateTopology(t9); } catch { /* 사망 시 실패 */ }
  ok(Array.isArray(r9) && r9.length > 0, "독성 객체(id·entityType·role·lifecycle·relation·from) → 예외 없이 진단(6차 반례: 보간 사망)");
  // 6차 반례: 스칼라 타입 — label:42가 검증 통과 후 렌더 localeCompare에서 사망하던 공백
  const t10 = mkTopo(); t10.nodes[1].label = 42; t10.revision = "x"; t10.project = 7;
  const r10 = PM.validateTopology(t10);
  ok(r10.some((e) => /label은 비어있지 않은 문자열이어야/.test(e)) && r10.some((e) => /revision/.test(e)) && r10.some((e) => /project/.test(e)), "label:42·revision:'x'·project:7 → 스칼라 타입 거부(렌더 사망 선차단 — 6차 반례)");
  const t11 = mkTopo(); t11.nodes[0].anchors = [{ kind: "code", path: 42 }]; delete t11.nodes[1].roles;
  const r11 = PM.validateTopology(t11);
  ok(r11.some((e) => /anchor 불량/.test(e)) && r11.some((e) => /roles 누락/.test(e)), "anchor.path:42 거부·필수 배열(roles) 부재도 거부(6차 지적)");
  // patch·decision도 같은 외부 JSON 경계 — 독성 객체·null 원소에서 죽지 않고 진단
  let rp = null; try { rp = PM.validatePatch({ patchId: poison, baseMapHash: poison, baseHead: poison, baseDirtyFp: "fp", operation: poison, targetId: poison, payload: {}, evidence: [null], rationale: "r" }); } catch { /* 사망 시 실패 */ }
  ok(Array.isArray(rp) && rp.length > 0, "patch의 독성 객체 필드·evidence:[null] → 예외 없이 진단");
  let rd = null; try { rd = PM.validateDecision({ decisionId: poison, patchId: poison, action: "approve", actor: poison, ts: "t", opHash: poison, payload: "not-object", expectedMapHashAfter: poison }); } catch { /* 사망 시 실패 */ }
  ok(Array.isArray(rd) && rd.length > 0, "decision의 독성 객체 필드·비객체 payload → 예외 없이 진단");
  // 7차 반례: 미검사 선택 필드·스키마 밖 키 — 깊은 중첩 정크가 검증 통과 후 mapHashOf/opHashOf에서 RangeError로 사망
  const t12 = mkTopo(); t12.nodes[0].notes = {}; t12.nodes[0].steward = 1; t12.edges[0].notes = [];
  const r12 = PM.validateTopology(t12);
  ok(r12.some((e) => /notes는 문자열이어야/.test(e)) && r12.some((e) => /steward는 문자열이어야/.test(e)), "notes:{}·steward:1·엣지 notes:[] → 선택 문자열 필드 타입 거부(7차 반례)");
  const t13 = mkTopo(); t13.junk = { deep: 1 }; t13.nodes[0].junk2 = 1; t13.nodes[0].state.junk3 = 1;
  const r13 = PM.validateTopology(t13);
  ok(r13.filter((e) => /미지 필드/.test(e)).length >= 3, "topology·노드·state의 스키마 밖 키 → 전부 거부(깊은 정크·own __proto__ 은닉 차단 — 7차)");
  ok(PM.opHashOf(JSON.parse('{"a":1,"__proto__":{"hidden":1}}')) !== PM.opHashOf({ a: 1 }), "own __proto__ 키가 지문에 반영 — 일반 {}에선 프로토타입 대입으로 소실돼 다른 JSON이 같은 CAS 지문(7차 반례)");
  ok(PM.validatePatch({ ...base, payload: { anchor: { kind: "code", path: "p" }, junk: { deep: 1 } } }).some((e) => /미지 필드/.test(e)), "payload 스키마 밖 키 → 거부(opHash 대상 깊은 정크 차단)");
  ok(PM.validatePatch({ ...base, payload: { anchor: { kind: "code", path: "p" } }, evidence: [{ kind: "code", ref: "r", note: {} }] }).some((e) => /evidence 항목 불량/.test(e)), "patch evidence.note:{} → 거부(공통 validateEvidence — 계약 갈림 봉합)");
  ok(PM.validateDecision({ ...d, opHash: "b".repeat(40), payload: { x: 1 }, expectedMapHashAfter: "c".repeat(40), appliedRevision: "x" }).some((e) => /appliedRevision/.test(e)), "appliedRevision:'x' → 거부(선택 필드 타입 — v1b 배선 전 계약 닫기)");
  // 8차 반례: add_node/add_edge의 targetId 우회 — 깊은 중첩 targetId가 검증을 통과해 approve의 opHashOf가 사망
  ok(PM.validatePatch({ ...base, operation: "add_node", payload: { node: mkTopo().nodes[0] } }).some((e) => /targetId 금지/.test(e)), "add_node에 targetId 존재 → 거부(대상 없는 연산 — 8차 반례)");
  ok(PM.validatePatch({ ...base, targetId: 42 }).some((e) => /targetId는 UUID여야/.test(e)), "targetId:42 → 타입 거부(전 연산 공통)");
  {
    let deep = {}; let cur = deep; for (let i = 0; i < 20000; i++) { cur.n = {}; cur = cur.n; }
    const badCopy = { ...base, operation: "add_node", targetId: deep, payload: { node: mkTopo().nodes[0] } };
    let rd8 = null; try { rd8 = PM.validateDecision({ ...d, payload: badCopy, opHash: "b".repeat(40), expectedMapHashAfter: "c".repeat(40) }); } catch { /* opHashOf 사망 시 실패 */ }
    ok(Array.isArray(rd8) && rd8.some((e) => /유효한 patch 사본이 아님/.test(e)), "깊은 중첩 targetId 사본 → opHashOf 진입 전 거부(RangeError 사망 봉합 — 8차 반례)");
  }
  ok(PM.validateDecision({ ...d, action: "reject", payload: { junk: 1 }, expectedMapHashAfter: "c".repeat(40) }).filter((e) => /미지 필드/.test(e)).length >= 2, "reject에 approve 전용 필드(payload·expectedMapHashAfter) → 미지 필드 거부(action별 계약 — 8차)");
}

console.log("[5] 복구 3분기 — 이미 적용과 제3 변경을 구분(설계검증: base 재검사만으론 불가)");
ok(PM.recoveryDecision("H1", "H1", "H2") === "apply", "현재==base → 적용");
ok(PM.recoveryDecision("H2", "H1", "H2") === "supplement-applied", "현재==expectedAfter → applied 이벤트만 보충(중복 적용 금지)");
ok(PM.recoveryDecision("H3", "H1", "H2") === "conflict", "둘 다 아니면 conflict 중단(제3 변경)");

console.log("[6] 생성 뷰 — 지문 머리말·수동 수정 탐지·표시 번호는 파생(저장 안 함)");
{
  const t = mkTopo();
  const md = PM.renderMapMd(t);
  ok(/직접 수정 금지/.test(md) && /원본 지문: `[0-9a-f]{40}`/.test(md), "생성물 표식+지문 머리말");
  ok(PM.mapMdMatches(md, t), "지문 일치 판정");
  ok(!PM.mapMdMatches(md.replace(/원본 지문: `[0-9a-f]{4}/, "원본 지문: `ffff"), t), "지문 불일치(수동 수정) 탐지");
  ok(!/displayNo/.test(PM.canonicalSerialize(t)), "표시 번호는 정본에 없음(렌더 시 안정 정렬 파생 — 재배치 불변식 불요)");
  const t2 = mkTopo(); t2.nodes[0].state.confidence = "unknown";
  ok(PM.renderMapMd(t2) !== md, "상태 변화가 뷰에 반영");
}

console.log("[7] fail-closed 잠금 — 실패 시 실행 안 함(정본 전용 — 기존 fail-open과 구분)");
{
  const lock = path.join(home, "t.lock");
  const r1 = CL.withFileLockStrict(lock, () => 42);
  ok(r1.ok === true && r1.result === 42 && !fs.existsSync(lock), "정상 획득·실행·해제(잔존 0)");
  fs.writeFileSync(lock, "999999999-dead"); // 죽은 pid 잔존
  const r2 = CL.withFileLockStrict(lock, () => 42);
  ok(r2.ok === false && /dead-lock-holder/.test(r2.error), "죽은 보유자 → 실행하지 않고 즉시 실패(fail-open 금지 — lost-update 차단)");
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, process.pid + "-alive"); // 살아있는 보유자
  const t0 = Date.now();
  const r3 = CL.withFileLockStrict(lock, () => 42);
  ok(r3.ok === false && /lock-timeout/.test(r3.error) && Date.now() - t0 < 3000, "생존 보유자 → 대기 후 타임아웃 실패(실행 안 함)");
  fs.unlinkSync(lock);
}

console.log("[8] CLI 끝-끝 — init 1회성·draft 강제·status·render·수동 수정 감지");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pmap_repo_"));
  fs.mkdirSync(path.join(repo, "src")); fs.mkdirSync(path.join(repo, "lib"));
  fs.writeFileSync(path.join(repo, "src", "a.js"), "const b = require('../lib/b');\nconst dyn = require(pathVar);\n");
  fs.writeFileSync(path.join(repo, "lib", "b.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", main: "src/a.js" }));
  const CLI = path.join(__dirname, "..", "scripts", "scope-map.js");
  const run = (...a) => spawnSync(process.execPath, [CLI, repo, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home } });
  // 검증 2차 반례 픽스처: 주석 import 오탐·side-effect import 누락·외부 패키지 셈
  fs.writeFileSync(path.join(repo, "src", "c.js"), "// from \"../lib/comment-only.js\"\nimport \"../lib/b.js\";\nimport ext from \"external-pkg\";\n");
  const inv = run("inventory");
  ok(inv.status === 0 && /동적 미상 1/.test(inv.stdout), "인벤토리 — 동적 require를 '미상'으로 정직 집계(조용한 오해석 금지)");
  ok(/외부\/별칭 1/.test(inv.stdout), "외부 패키지는 버리지 않고 셈(Codex 지적)");
  ok(/regex 스캔/.test(inv.stdout) && !/의미 해석/.test(inv.stdout), "명칭 하향 — '의미 해석'이 아니라 'regex 스캔'(파싱 보장 아님)");
  const init = run("init");
  ok(init.status === 0 && /draft topology 생성/.test(init.stdout) && /관측 초안/.test(init.stdout), "init — draft 생성+권위 불침 고지");
  const topo = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "topology.json"), "utf8"));
  ok(topo.draft === true && topo.nodes.every((n) => /^[0-9a-f-]{36}$/.test(n.id)), "draft:true·불투명 UUID(재분류에도 불변)");
  ok(topo.nodes.every((n) => n.state.confidence === "candidate"), "초안 노드 전부 candidate(임의 확정 금지)");
  ok(topo.edges.some((e) => e.relation === "imports"), "정적 의존은 imports 관계(calls/consumes와 구분)");
  {
    const impEdge = topo.edges.find((e) => e.relation === "imports");
    ok(impEdge && impEdge.evidence.every((ev) => /→/.test(ev.ref) && /\.js/.test(ev.ref)), "엣지 evidence=실제 파일 근거(역추적 가능 — 합성 문자열 금지: Codex 지적)");
    ok(impEdge && impEdge.evidence.some((ev) => ev.ref.includes("c.js → ../lib/b.js")), "side-effect import(import \"./x\")도 엣지 근거로 추출(누락 반례 잠금)");
    ok(!JSON.stringify(topo).includes("comment-only"), "주석 속 import는 오탐하지 않음(주석 제거 후 매칭 — Codex 반례)");
  }
  const md = fs.readFileSync(path.join(repo, "project-map", "MAP.md"), "utf8");
  ok(PM.mapMdMatches(md, topo), "생성 뷰 지문 = 정본 지문");
  const again = run("init");
  ok(again.status === 1 && /ID를 재생성/.test(again.stderr), "재init 거부(ID 재생성이 기존 연결을 끊음 — 갱신은 후속 refresh 제안)");
  {
    const st0 = run("status");
    ok(st0.status === 0 && /regex 스캔 \d+\/\d+/.test(st0.stdout) && !/undefined|NaN/.test(st0.stdout), "status 인벤토리 표면 — 새 필드명으로 수치 표시(undefined/NaN 회귀 잠금 — 2차 반례)");
  }
  fs.appendFileSync(path.join(repo, "project-map", "MAP.md"), "\n수동 낙서\n");
  const st = run("status");
  ok(st.status === 0 && /불일치/.test(st.stdout), "생성 뷰 수동 수정 감지(status 경고)");
  const rr = run("render");
  ok(rr.status === 0 && PM.mapMdMatches(fs.readFileSync(path.join(repo, "project-map", "MAP.md"), "utf8"), topo), "render — 뷰 재생성으로 정합 복원");
  // 4차 반례: 파싱은 되지만 schema-invalid — status가 stack trace 없이 진단+exit 1(검증이 파생 계산보다 먼저)
  {
    const tBadPath = path.join(repo, "project-map", "topology.json");
    const orig = fs.readFileSync(tBadPath, "utf8");
    fs.writeFileSync(tBadPath, JSON.stringify({ ...JSON.parse(orig), nodes: {} }));
    const s1 = run("status");
    ok(s1.status === 1 && /배열이 아님/.test(s1.stderr) && !/TypeError/.test(s1.stderr), "nodes:{} → status가 진단으로 exit 1(TypeError 사망 아님 — 4차 반례)");
    fs.writeFileSync(tBadPath, JSON.stringify({ ...JSON.parse(orig), nodes: [null] }));
    const s2 = run("status");
    ok(s2.status === 1 && /객체가 아님/.test(s2.stderr) && !/TypeError/.test(s2.stderr), "nodes:[null] → status가 원소 단위 진단으로 exit 1");
    // 5차 반례: 중첩 필드 — 파싱 가능한 JSON이 validator 안에서 사망하던 경로
    const nested = JSON.parse(orig);
    nested.nodes[0].roles = {}; nested.nodes[0].anchors = [null];
    nested.nodes[0].id = { toString: null, valueOf: null }; // 6차: 독성 객체도 CLI 경로에서 진단으로
    if (nested.edges[0]) nested.edges[0].evidence = [null];
    fs.writeFileSync(tBadPath, JSON.stringify(nested));
    const s3 = run("status");
    ok(s3.status === 1 && /배열이 아님|불량/.test(s3.stderr) && !/TypeError|not iterable/.test(s3.stderr), "중첩 필드 불량(roles:{}·anchors:[null]·edge evidence:[null]) → 진단으로 exit 1(사망 아님 — 5차 반례)");
    fs.writeFileSync(tBadPath, orig); // 복원(이후 손상 3단 검사)
  }
  // 3차 보충: 부재/손상 구분 — 손상인데 status가 '없음'이라 하고 init은 존재로 거부하는 모순 상태 봉합
  fs.writeFileSync(path.join(repo, "project-map", "topology.json"), "{broken");
  const stBad = run("status");
  ok(stBad.status === 1 && /손상|corrupted/.test(stBad.stderr), "손상 topology → status가 '없음' 아닌 손상으로 구분+exit 1");
  ok(run("init").status === 1, "손상 상태에서도 init은 덮어쓰지 않음(파괴 금지 — 수동 확인 유도)");
  ok(run("render").status === 1, "손상 상태 render 중단(낡은/깨진 정본으로 뷰 재생성 금지)");
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 무해 */ }
}

console.log("[9] 동시 init(병렬 프로세스) — 성공 정확히 1·기존 topology 보존·잠금 잔존 0(2차 지적: 순차 재실행은 경합 검사가 아님)");
{
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "pmap_race_"));
  fs.mkdirSync(path.join(repo2, "src"));
  fs.writeFileSync(path.join(repo2, "src", "a.js"), "module.exports = 1;\n");
  const CLI2 = path.join(__dirname, "..", "scripts", "scope-map.js");
  const { spawn } = require("child_process");
  const runP = () => new Promise((res) => {
    const c = spawn(process.execPath, [CLI2, repo2, "init"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home } });
    let code = null;
    c.on("close", (cd) => { code = cd; res(code); });
  });
  Promise.all([runP(), runP()]).then((codes) => {
    const okCount = codes.filter((c) => c === 0).length;
    ok(okCount === 1, `동시 init 2회 → 성공 정확히 1(실제 ${okCount}) — 잠금 안 존재 재검사(check-then-lock 봉합)`);
    const topo2 = JSON.parse(fs.readFileSync(path.join(repo2, "project-map", "topology.json"), "utf8"));
    ok(PM.validateTopology(topo2).length === 0, "살아남은 topology 스키마 정상(반쪽 덮어쓰기 없음)");
    const lockDir = path.join(home, "project-map-locks");
    ok(!fs.existsSync(lockDir) || fs.readdirSync(lockDir).every((f) => !f.endsWith(".lock")), "잠금 잔존 0");
    try { fs.rmSync(repo2, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } catch { /* 무해 */ }
    console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
    process.exit(fail ? 1 : 0);
  });
}
