"use strict";
/*
 * Project MAP(스키마 v2 — P0.5) — 설계·구현 검증 반례 잠금.
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
  schemaVersion: PM.MAP_SCHEMA_VERSION, mapId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", draft: true, project: "t", createdAt: "2026-07-10T00:00:00Z", revision: 1,
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
  ok(PM.validateDecision({ ...d, opHash: "b".repeat(40), payload: { x: 1 }, expectedMapHashAfter: "c".repeat(40), appliedRevision: "x" }).some((e) => /appliedRevision/.test(e)), "appliedRevision:'x' → 거부(선택 필드 타입 — P2 배선 전 계약 닫기)");
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
  {
    const st = run("status");
    ok(st.status === 0 && /topology 없음|No topology/.test(st.stdout), "부재 → status가 '없음' 안내+exit 0(3분기: absent — 마감 검증 지적: 문서가 테스트 범위 과장)");
  }
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
  // 3분기의 세 번째: 비-ENOENT 읽기 실패(EISDIR — 파일 자리에 디렉터리) → 부재와 구분된 안내
  fs.rmSync(path.join(repo, "project-map", "topology.json"));
  fs.mkdirSync(path.join(repo, "project-map", "topology.json"));
  const stDir = run("status");
  ok(stDir.status === 1 && /읽기 실패|Failed to read/.test(stDir.stderr), "비-ENOENT 읽기 실패 → '없음' 아닌 읽기 실패 안내+exit 1(3분기: unreadable)");
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 무해 */ }
}

console.log("[10] v2 스키마(P0.5) — mapId 세대·decisionLocks 합타입·provenance(VerificationBasis)·canonical 등록");
{
  const t = mkTopo(); delete t.mapId;
  ok(PM.validateTopology(t).some((e) => /mapId는 UUID여야/.test(e)), "mapId 부재 → 거부(지도 세대 정체성 — 설계 1-31)");
  const t2 = mkTopo(); t2.replacesMapId = "not-uuid";
  ok(PM.validateTopology(t2).some((e) => /replacesMapId는 UUID여야/.test(e)), "replacesMapId 비UUID → 거부");
  const t3 = mkTopo(); t3.replacesMapId = t3.mapId;
  ok(PM.validateTopology(t3).some((e) => /자기 세대 대체 금지/.test(e)), "replacesMapId=자기 자신 → 거부");
  const ok1 = mkTopo();
  ok1.nodes[0].description = "설명";
  ok1.nodes[0].decisionLocks = [{ kind: "literal", text: "runtime 판단 입력 사용 금지" }, { kind: "policy-ref", policyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }];
  ok1.nodes[0].provenance = { basis: { kind: "git", objectFormat: "sha1", head: "a".repeat(40) }, decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  ok1.edges[0].decisionLocks = [{ kind: "literal", text: "관계 의미 변경은 검증 필수" }];
  ok1.edges[0].provenance = { basis: { kind: "historyless", basisFp: "b".repeat(40), inventoryFp: "c".repeat(40) }, decisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
  ok(PM.validateTopology(ok1).length === 0, "정상 v2(신필드 전부) → 위반 0(git sha1·historyless 양쪽 basis)");
  const ok2 = mkTopo(); ok2.nodes[0].provenance = { basis: { kind: "git", objectFormat: "sha256", head: "e".repeat(64) }, decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  ok(PM.validateTopology(ok2).length === 0, "git sha256(64hex) basis 통과 — objectFormat 결속(설계검증 #4: 40자 상한이 sha256 저장소 거부하던 것)");
  const b1 = mkTopo(); b1.nodes[0].decisionLocks = [{ kind: "nope", x: 1 }];
  ok(PM.validateTopology(b1).some((e) => /decisionLock kind 불량/.test(e)), "decisionLock 미지 kind → 거부");
  const b2 = mkTopo(); b2.nodes[0].decisionLocks = [{ kind: "literal", text: " " }];
  ok(PM.validateTopology(b2).some((e) => /text는 비어있지 않은 문자열이어야/.test(e)), "literal 빈 text → 거부");
  const b3 = mkTopo(); b3.nodes[0].decisionLocks = [{ kind: "policy-ref", policyId: "x" }];
  ok(PM.validateTopology(b3).some((e) => /policyId는 UUID여야/.test(e)), "policy-ref 비UUID → 거부");
  const b4 = mkTopo(); b4.nodes[0].decisionLocks = [null];
  ok(PM.validateTopology(b4).some((e) => /decisionLock 원소가 객체가 아님/.test(e)), "decisionLocks:[null] → 무사망 진단(기존 계약 동수준)");
  const b5 = mkTopo(); b5.nodes[0].decisionLocks = [{ kind: "literal", text: "t", junk: 1 }];
  ok(PM.validateTopology(b5).some((e) => /미지 필드/.test(e)), "decisionLock variant 밖 키 → 거부");
  const b6 = mkTopo(); b6.nodes[0].provenance = { basis: { kind: "git", objectFormat: "sha1", head: "a".repeat(64) }, decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  ok(PM.validateTopology(b6).some((e) => /head는 40hex여야/.test(e)), "sha1인데 64hex head → 거부(format·길이 결속)");
  const b7 = mkTopo(); b7.nodes[0].provenance = { basis: { kind: "git", objectFormat: "md5", head: "a".repeat(32) }, decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  ok(PM.validateTopology(b7).some((e) => /objectFormat 불량/.test(e)), "미지 objectFormat → 거부");
  const b8 = mkTopo(); b8.nodes[0].provenance = { basis: { kind: "historyless", basisFp: "짧음", inventoryFp: "c".repeat(40) }, decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  ok(PM.validateTopology(b8).some((e) => /basisFp는 sha1 40hex여야/.test(e)), "historyless 지문 형식 위반 → 거부");
  const b9 = mkTopo(); b9.nodes[0].provenance = { basis: { kind: { toString: null }, x: 1 }, decisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  let r9v = null; try { r9v = PM.validateTopology(b9); } catch { /* 사망 시 실패 */ }
  ok(Array.isArray(r9v) && r9v.some((e) => /basis kind 불량/.test(e)), "독성 객체 kind → 예외 없이 진단(무사망 계약 승계)");
  // canonical: decisionLocks 집합 등록(역순 → 동일 지문)
  const cA = mkTopo(); cA.nodes[0].decisionLocks = [{ kind: "policy-ref", policyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { kind: "literal", text: "a" }];
  const cB = mkTopo(); cB.nodes[0].decisionLocks = [{ kind: "literal", text: "a" }, { kind: "policy-ref", policyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }];
  ok(PM.mapHashOf(cA) === PM.mapHashOf(cB), "decisionLocks 순서 무관 동일 지문(canonical 등록 — 누락 시 CAS 거짓 충돌)");
  const l1 = mkTopo(); l1.nodes[0].lastSeenAt = "2026-07-10T00:00:00Z";
  ok(PM.validateTopology(l1).some((e) => /미지 필드/.test(e)), "v2에서 lastSeenAt → 미지 필드 거부(하네스 로컬로 이동 — 설계 1-2)");
}

console.log("[11] v1→v2 마이그레이터 — 결정론·frozen v1 검증·원본 불변·문구 교체");
{
  const mkV1 = () => ({
    schemaVersion: 1, draft: true, project: "t", createdAt: "2026-07-10T00:00:00Z", revision: 1,
    nodes: [
      { id: "11111111-1111-4111-8111-111111111111", label: "core", entityType: "module", roles: ["producer"], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.ts" }], lastSeenAt: "2026-07-10T01:00:00Z" },
    ],
    edges: [],
    inventory: mkTopo().inventory,
    freshnessNote: PM.FRESHNESS_NOTE_V1_DEFAULT,
  });
  const v1 = mkV1();
  const before = JSON.stringify(v1);
  const r1 = PM.migrateTopologyV1toV2(v1);
  ok(r1.topo && r1.errors.length === 0, "정상 v1 → 변환 성공");
  ok(JSON.stringify(v1) === before, "입력 v1 객체 불변(깊은 복사 — 원본 무변경 계약)");
  ok(PM.validateTopology(r1.topo).length === 0, "변환 결과가 v2 검증 통과");
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r1.topo.mapId), "mapId 부여(UUID 형태)");
  ok(!("lastSeenAt" in r1.topo.nodes[0]), "lastSeenAt 소거");
  ok(r1.topo.freshnessNote === PM.FRESHNESS_NOTE_V2, "알려진 v1 기본 문구 → v2 문구 교체(#5)");
  const r2 = PM.migrateTopologyV1toV2(mkV1());
  ok(r2.topo && r2.topo.mapId === r1.topo.mapId && PM.canonicalSerialize(r2.topo) === PM.canonicalSerialize(r1.topo), "결정론 — 동일 v1 입력=동일 mapId·동일 canonical(clone·브랜치 갈림 방지: 설계검증 #2)");
  const custom = mkV1(); custom.freshnessNote = "사용자 임의 문구";
  const r3 = PM.migrateTopologyV1toV2(custom);
  ok(r3.topo && r3.topo.freshnessNote === "사용자 임의 문구", "임의 사용자 문구는 보존");
  ok(r3.topo.mapId !== r1.topo.mapId, "내용이 다르면 mapId도 다름(내용 지문 유도)");
  const bad = mkV1(); bad.nodes = [null];
  let rb = null; try { rb = PM.migrateTopologyV1toV2(bad); } catch { /* 사망 시 실패 */ }
  ok(rb && rb.topo === null && rb.errors.some((e) => /객체가 아님/.test(e)), "malformed v1(nodes:[null]) → 무사망 진단+변환 거부(frozen v1 검증 — 설계검증 #3)");
  const notV1 = mkTopo();
  const rn = PM.migrateTopologyV1toV2(notV1);
  ok(rn.topo === null && rn.errors.some((e) => /v1\(1\)만 마이그레이션 대상/.test(e)), "v2 입력 → 마이그레이션 거부");
  const junkV1 = mkV1(); junkV1.mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rj = PM.migrateTopologyV1toV2(junkV1);
  ok(rj.topo === null && rj.errors.some((e) => /미지 필드/.test(e)), "v1에 v2 필드(mapId) 혼입 → frozen v1 검증이 거부(스키마 밖 키)");
}

console.log("[12] CLI migrate 끝-끝 — v1 파일 안내→변환→멱등·동시 migrate 변환 정확히 1");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pmap_mig_"));
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.js"), "module.exports = 1;\n");
  const CLI = path.join(__dirname, "..", "scripts", "scope-map.js");
  const run = (...a) => spawnSync(process.execPath, [CLI, repo, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home } });
  // v1 topology를 직접 심는다(마이그레이션 대상 재현)
  const v1 = {
    schemaVersion: 1, draft: true, project: path.basename(repo), createdAt: "2026-07-10T00:00:00Z", revision: 1,
    nodes: [{ id: "11111111-1111-4111-8111-111111111111", label: "src", entityType: "module", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/a.js" }], lastSeenAt: "2026-07-10T01:00:00Z" }],
    edges: [], inventory: mkTopo().inventory, freshnessNote: PM.FRESHNESS_NOTE_V1_DEFAULT,
  };
  fs.mkdirSync(path.join(repo, "project-map"), { recursive: true });
  fs.writeFileSync(path.join(repo, "project-map", "topology.json"), JSON.stringify(v1, null, 1));
  const st1 = run("status");
  ok(st1.status === 1 && /v1 topology 감지/.test(st1.stderr), "v1 파일 → status가 migrate 안내(v2 검증 오류로 오도하지 않음)");
  ok(run("render").status === 1, "v1 파일 → render도 안내 후 중단");
  const mg = run("migrate");
  ok(mg.status === 0 && /v1→v2 변환 완료/.test(mg.stdout), "migrate 성공");
  const after = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "topology.json"), "utf8"));
  ok(after.schemaVersion === PM.MAP_SCHEMA_VERSION && PM.validateTopology(after).length === 0 && !("lastSeenAt" in after.nodes[0]), "변환 결과 v2 유효·lastSeenAt 소거");
  ok(fs.existsSync(path.join(repo, "project-map", "MAP.md")) && PM.mapMdMatches(fs.readFileSync(path.join(repo, "project-map", "MAP.md"), "utf8"), after), "MAP.md 재렌더·지문 일치");
  const mg2 = run("migrate");
  ok(mg2.status === 0 && /이미 v2/.test(mg2.stdout), "재migrate → 멱등(이미 v2)");
  ok(run("status").status === 0, "변환 후 status 정상");
  // 동시 migrate: v1로 되돌린 뒤 2프로세스 — '변환 완료'는 정확히 1회(경합은 raw 재검사로 중단, 후발은 이미 v2)
  fs.writeFileSync(path.join(repo, "project-map", "topology.json"), JSON.stringify(v1, null, 1));
  const { spawn } = require("child_process");
  const runP = () => new Promise((res) => {
    const c = spawn(process.execPath, [CLI, repo, "migrate"], { env: { ...process.env, CODEX_BRIDGE_HOME: home } });
    let out = ""; c.stdout.on("data", (d) => out += d); c.stderr.on("data", (d) => out += d);
    c.on("close", (code) => res({ code, out }));
  });
  Promise.all([runP(), runP()]).then((rs) => {
    const converted = rs.filter((r) => /v1→v2 변환 완료|Migrated v1→v2/.test(r.out)).length;
    ok(converted === 1, `동시 migrate 2회 → 변환 정확히 1(실제 ${converted}) — 잠금 안 raw 재검사`);
    const fin = JSON.parse(fs.readFileSync(path.join(repo, "project-map", "topology.json"), "utf8"));
    ok(fin.schemaVersion === PM.MAP_SCHEMA_VERSION && PM.validateTopology(fin).length === 0, "최종 파일 v2 유효(반쪽 쓰기 없음)");
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 무해 */ }
    afterMigrateRace();
  });
}

function afterMigrateRace() {
console.log("[13] 배포 사본 패리티 — bridge/project-map.js == out/project-map.js(바이트)·--check 통과");
{
  const a = fs.readFileSync(path.join(__dirname, "..", "bridge", "project-map.js"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "..", "out", "project-map.js"), "utf8");
  ok(a === b, "바이트 패리티(생성물 신선도 — 머리주석 없음이 계약: 사전검증 #1)");
  const chk = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "sync-map-core.js"), "--check"], { encoding: "utf8" });
  ok(chk.status === 0, "sync-map-core --check 통과(검사 모드는 파일을 고치지 않음)");
  const pkg = fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8");
  ok(/"watch":\s*"node scripts\/sync-map-core\.js --watch-with-tsc"/.test(pkg), "watch 스크립트가 sync 통합 모드(1차 검증 회귀 잠금: tsc만 돌리면 CLI가 낡은 bridge 사본을 실행)");
  ok(/"compile":[^\n]*sync-map-core\.js --write/.test(pkg) && /"test":[^\n]*sync-map-core\.js --check/.test(pkg), "compile=--write·test=--check 체인 계약");
}

watchLifecycleTests().then(runConcurrentInit);

async function watchLifecycleTests() {
console.log("[14] sync/watch 수명주기 — 침묵 실패 금지·onExit 정확히 1회(3차 반례 잠금)");
const SM = require(path.join(__dirname, "..", "scripts", "sync-map-core.js"));
const { EventEmitter } = require("events");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmap_sync_"));
const src = path.join(dir, "src.js"), dst = path.join(dir, "dst.js");
{
  fs.writeFileSync(src, "AAA");
  const r1 = SM.syncOnce(src, dst);
  ok(r1.st === "synced" && fs.readFileSync(dst, "utf8") === "AAA", "초기 synced+사본 일치");
  ok(SM.syncOnce(src, dst).st === "same", "동일 내용 → same(무기록)");
  ok(SM.syncOnce(path.join(dir, "none.js"), dst).st === "src-missing", "소스 부재 → src-missing");
  const srcDir = path.join(dir, "srcdir"); fs.mkdirSync(srcDir);
  ok(SM.syncOnce(srcDir, dst).st === "read-failed", "소스 읽기 실패(EISDIR) → read-failed(부재와 구분)");
  const dstDir = path.join(dir, "dstdir"); fs.mkdirSync(dstDir);
  const rd = SM.syncOnce(src, dstDir);
  ok(rd.st === "read-failed", "대상 읽기 실패(EISDIR) → read-failed — 읽지 못한 기존 사본을 '부재'로 보고 덮지 않음(3차 반례)");
  const badDst = path.join(dir, "no-such-dir", "x.js");
  const rw = SM.syncOnce(src, badDst);
  ok(rw.st === "write-failed", "쓰기 실패(tmp 생성 불가) → write-failed 표면화");
  ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "tmp 생성 실패 경로 — .tmp 잔존 없음");
  { // 4차 보완: renameSync'만' 실패 주입 — tmp 쓰기 성공 후 정리 분기를 직접 잠금
    const dst2 = path.join(dir, "ren-fail.js");
    const origRename = fs.renameSync;
    fs.renameSync = (a, b) => { if (b === dst2) { const e = new Error("injected"); throw e; } return origRename(a, b); };
    let rr;
    try { rr = SM.syncOnce(src, dst2); } finally { fs.renameSync = origRename; }
    ok(rr.st === "write-failed" && !fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "rename만 실패 → write-failed+.tmp 정리(생성 성공분 잔존 없음)");
  }
}
const mkChild = () => { const c = new EventEmitter(); c.killCount = 0; c.kill = () => { c.killCount++; setTimeout(() => c.emit("exit", null, "SIGTERM"), 5); }; return c; };
{ // 정상: 초기 sync→src 변경 갱신→자연 종료 코드 전파 1회
  fs.writeFileSync(src, "B1"); try { fs.unlinkSync(dst); } catch { /* 무해 */ }
  let exits = []; let spawned = 0; const child = mkChild();
  const w = SM.startWatch({ src, dst, intervalMs: 25, log: () => {}, logErr: () => {}, spawnChild: () => { spawned++; return child; }, onExit: (c) => exits.push(c) });
  await sleep(60);
  ok(fs.readFileSync(dst, "utf8") === "B1" && spawned === 1, "초기 1회 sync+자식 1회 기동");
  fs.writeFileSync(src, "B2");
  await sleep(250);
  ok(fs.readFileSync(dst, "utf8") === "B2", "src 변경 → 사본 자동 갱신(watch 실효 — 문자열 검사가 아님)");
  child.emit("exit", 2, null); child.emit("exit", 0, null); // 중복 이벤트도 1회만
  await sleep(20);
  ok(exits.length === 1 && exits[0] === 2, "자연 종료 코드 2 → onExit(2) 정확히 1회");
  fs.writeFileSync(src, "B3"); await sleep(120);
  ok(fs.readFileSync(dst, "utf8") === "B2", "종료 후 watcher 해제(더 이상 동기화 없음)");
  w.stop(); w.stop();
  ok(child.killCount <= 1, "stop 반복 → kill 최대 1회");
}
{ // child error→exit 연쇄 = 1회
  fs.writeFileSync(src, "C1");
  let exits = []; const child = mkChild();
  SM.startWatch({ src, dst, intervalMs: 25, log: () => {}, logErr: () => {}, spawnChild: () => child, onExit: (c) => exits.push(c) });
  await sleep(30);
  child.emit("error", new Error("spawn fail")); child.emit("exit", 1, null);
  await sleep(20);
  ok(exits.length === 1 && exits[0] === 1, "child error 후 exit 연쇄 → onExit 정확히 1회(멱등 finish — 3차 반례)");
}
{ // 시그널 종료 → 1(성공 위장 금지)
  fs.writeFileSync(src, "D1");
  let exits = []; const child = mkChild();
  SM.startWatch({ src, dst, intervalMs: 25, log: () => {}, logErr: () => {}, spawnChild: () => child, onExit: (c) => exits.push(c) });
  await sleep(30);
  child.emit("exit", null, "SIGKILL");
  await sleep(20);
  ok(exits.length === 1 && exits[0] === 1, "시그널·null 코드 종료 → onExit(1) 1회");
}
{ // 4차 보완: code=null·signal=null 미상 종료도 1(성공 위장 금지)
  fs.writeFileSync(src, "D2");
  let exits = []; const child = mkChild();
  SM.startWatch({ src, dst, intervalMs: 25, log: () => {}, logErr: () => {}, spawnChild: () => child, onExit: (c) => exits.push(c) });
  await sleep(30);
  child.emit("exit", null, null);
  await sleep(20);
  ok(exits.length === 1 && exits[0] === 1, "미상 종료(code·signal 모두 null) → onExit(1) 1회");
}
{ // 초기 fatal(src 읽기 실패) → 자식 미기동·onExit(1) 1회
  const srcDir2 = path.join(dir, "srcdir2"); fs.mkdirSync(srcDir2);
  let exits = []; let spawned = 0;
  SM.startWatch({ src: srcDir2, dst, intervalMs: 25, log: () => {}, logErr: () => {}, spawnChild: () => { spawned++; return mkChild(); }, onExit: (c) => exits.push(c) });
  await sleep(30);
  ok(spawned === 0 && exits.length === 1 && exits[0] === 1, "초기 tick fatal → 자식 미기동+onExit(1) 1회");
}
{ // tick fatal → kill → 자식 exit 연쇄 = 1회
  fs.writeFileSync(src, "E1"); try { fs.unlinkSync(dst); } catch { /* 무해 */ }
  let exits = []; const child = mkChild();
  SM.startWatch({ src, dst, intervalMs: 25, log: () => {}, logErr: () => {}, spawnChild: () => child, onExit: (c) => exits.push(c) });
  await sleep(60);
  fs.rmSync(dst); fs.mkdirSync(dst); // 대상을 디렉터리로 — 다음 tick의 read-failed 유발
  fs.writeFileSync(src, "E2");
  await sleep(300);
  ok(exits.length === 1 && exits[0] === 1 && child.killCount >= 1, "tick fatal→kill→child exit 연쇄 → onExit(1) 정확히 1회");
  fs.rmSync(dst, { recursive: true, force: true });
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
}

function runConcurrentInit() {

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
}
}
