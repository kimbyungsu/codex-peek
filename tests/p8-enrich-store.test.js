/*
 * P8 증분 3a — 보강 저장·순수 계층(bridge/map-enrich.js): 동의 세대(ws×slot·genCounter)·작업 장부
 * (enrich-job-v2 strict·RMW)·enrich-result-v1 validator(op별 합타입)·toPatchV2 결정론 변환기.
 * 정본: 'P8 상세 설계 v10' P8-2·P8-3.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p8es_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bootstrap.js");
const ME = require("../bridge/map-enrich.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");

function mkRepo(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8es_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  return ws;
}

console.log("[1] 동의 세대 — ws×slot upsert·타 레코드 보존(ab-2)·genCounter 단조·normWs");
{
  const repo = mkRepo("consent");
  ok(ME.readEnrichConsent(repo).st === "ok" && ME.readEnrichConsent(repo).grants.length === 0, "부재=무동의(정상 — 손상 아님)");
  const g1 = ME.grantEnrichConsent(repo, { ws: "D:\\proj\\A", slot: "ko", selfAuto: true, paidMode: null });
  ok(g1.ok === true && g1.gen === 1, "grant 1(gen=1)");
  const g2 = ME.grantEnrichConsent(repo, { ws: "D:\\proj\\B", slot: "ko", selfAuto: true, paidMode: "auto" });
  ok(g2.ok === true && g2.gen === 2, "다른 ws grant(gen=2)");
  const c1 = ME.readEnrichConsent(repo);
  ok(c1.grants.length === 2, "upsert — 타 (ws,slot) 레코드 보존(ab-2)");
  // path.normalize는 실행 OS의 구분자만 해석한다. 동의 파일은 로컬 전용이므로 Linux CI에 Windows의
  // 구분자 혼용 의미를 강요하지 않고, Windows에서만 slash/backslash 혼용까지 확인한다.
  const aliasA = process.platform === "win32" ? "d:/PROJ/a/" : "d:\\PROJ\\a\\";
  const g3 = ME.grantEnrichConsent(repo, { ws: aliasA, slot: "ko", selfAuto: false, paidMode: "economy" });
  ok(g3.ok === true && ME.readEnrichConsent(repo).grants.length === 2, "normWs 정규화 — 대소문자·꼬리 슬래시(Windows는 구분자 혼용)에도 같은 ws로 upsert(중복 생성 0)");
  const found = ME.findGrant(ME.readEnrichConsent(repo), "D:\\proj\\A", "ko");
  ok(found && found.paidMode === "economy" && found.gen === 3, "findGrant — 정규화 조회·최신 grant(gen=3)");
  ok(ME.findGrant(ME.readEnrichConsent(repo), "D:\\proj\\A", "en") === null, "언어 슬롯 독립(en 무동의)");
  ok(ME.revokeEnrichConsent(repo, "D:\\proj\\A", "ko").ok === true, "철회(grant 제거)");
  ok(ME.findGrant(ME.readEnrichConsent(repo), "D:\\proj\\A", "ko") === null && ME.readEnrichConsent(repo).genCounter === 3, "철회 후 무동의·genCounter 잔존(단조 유지)");
  const g4 = ME.grantEnrichConsent(repo, { ws: "D:\\proj\\A", slot: "ko", selfAuto: true, paidMode: "auto" });
  ok(g4.gen === 4, "삭제 후 재동의=genCounter+1(이전 gen 재사용 차단 — 3차 f-5cb42200)");
  // 3a 검증 1차(ab-2): 이형 slot·paidMode strict 거부 — 조용한 정규화로 기존 동의 덮기·타 슬롯 자격 차단
  ok(ME.grantEnrichConsent(repo, { ws: "D:\\proj\\A", slot: "typo", selfAuto: true, paidMode: null }).reason === "slot-invalid", "이형 slot grant=거부(기존 (ws,ko) 덮기 차단)");
  ok(ME.grantEnrichConsent(repo, { ws: "D:\\proj\\A", slot: "ko", selfAuto: true, paidMode: "typo" }).reason === "paid-mode-invalid", "이형 paidMode=거부(null 강등 금지)");
  ok(ME.grantEnrichConsent(repo, { ws: "D:\\proj\\A", slot: "ko", selfAuto: "true", paidMode: "auto" }).reason === "selfauto-invalid", "이형 selfAuto(문자열)=거부(false 정규화로 기존 동의 덮기 차단 — 2차 ab-2)");
  ok(ME.findGrant(ME.readEnrichConsent(repo), "D:\\proj\\A", "typo") === null, "이형 slot 조회=무자격(타 슬롯 grant 반환 금지)");
  ok(ME.revokeEnrichConsent(repo, "D:\\proj\\A", "typo").reason === "slot-invalid", "이형 slot 철회=거부");
  ok(ME.findGrant(ME.readEnrichConsent(repo), "D:\\proj\\A", "ko").gen === 4, "이형 시도들 뒤에도 (ws,ko) grant 불변");
  // 판독기 단조·중복 fail-closed
  const okC = ME.readEnrichConsent(repo);
  fs.writeFileSync(ME.consentFileFor(repo), JSON.stringify({ schema: "enrich-consent-v1", genCounter: 4, grants: [...okC.grants, { ...okC.grants[0] }] }));
  ok(ME.readEnrichConsent(repo).st === "damaged", "중복 (ws,slot) 레코드=damaged");
  fs.writeFileSync(ME.consentFileFor(repo), JSON.stringify({ schema: "enrich-consent-v1", genCounter: 2, grants: [{ ws: "x", slot: "ko", selfAuto: true, paidMode: null, gen: 9, grantedAt: "T" }] }));
  ok(ME.readEnrichConsent(repo).st === "damaged", "grant.gen>genCounter=damaged(단조 불변식 fail-closed)");
  fs.writeFileSync(ME.consentFileFor(repo), "{corrupt");
  ok(ME.readEnrichConsent(repo).st === "damaged", "손상=damaged(fail-closed — 무동의 위장 금지)");
  ok(ME.grantEnrichConsent(repo, { ws: "X", slot: "ko", selfAuto: true, paidMode: null }).ok === false, "손상 위 기록 금지(수동 복구 소관)");
}

console.log("[2] 작업 장부 — strict 판독·RMW·자기 산출 strict·손상 fail-closed");
{
  const repo = mkRepo("job");
  ok(ME.readEnrichJob(repo).st === "absent", "부재=absent");
  const mkJob = (over) => ({ schema: "enrich-job-v2", jobKey: ME.jobKeyOf(U(1), sha("a"), null), mapId: U(1), authorityHash: sha("a"), decisionContextHash: null, mode: "auto", configWs: "d:/x", slot: "ko", phase: "open", startedAt: "T", attempts: [], ...over });
  const w1 = ME.updateEnrichJob(repo, () => mkJob({}));
  ok(w1.ok === true, "신규 job 기록");
  const w2 = ME.updateEnrichJob(repo, (j) => ({ ...j, attempts: [{ attemptId: 0, provider: "economy", consentGen: 3, phase: "running", startedAt: "T1" }] }));
  ok(w2.ok === true && ME.readEnrichJob(repo).job.attempts.length === 1, "RMW — attempt 추가");
  const FULLITEM = { op: "add_evidence", targetId: U(1), payload: { evidence: { kind: "code", ref: "src/a.js" } }, evidence: [{ file: "src/a.js", quote: "q" }] };
  const RESOK = { schema: "enrich-result-v1", items: [FULLITEM, FULLITEM] };
  const w3 = ME.updateEnrichJob(repo, (j) => ({ ...j, attempts: [{ ...j.attempts[0], phase: "applying", results: RESOK, cursor: { nextIndex: 1, rev: 1, appliedPatchIds: [U(9)], super: { fromPatchId: U(8), fromOpHash: sha("o"), toRev: 2, phase: "marked" } } }] }));
  ok(w3.ok === true, "cursor+super 스키마 승인(strict에 super 명시 — 9차 보완)");
  const wBad = ME.updateEnrichJob(repo, (j) => ({ ...j, phase: "weird" }));
  ok(wBad.ok === false && /job-invalid/.test(wBad.reason), "자기 산출도 strict — 이형 기록 거부(오염 차단)");
  const RES1 = { schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: U(1), payload: { evidence: { kind: "code", ref: "src/a.js" } }, evidence: [{ file: "src/a.js", quote: "q" }] }] };
  // 3a 검증 1차 blocker①: 미지 필드·이형 results/resolutions/currentPatch/appliedPatchIds 전부 damaged
  const okJob = ME.readEnrichJob(repo).job;
  const put = (j) => { fs.writeFileSync(ME.jobFileFor(repo), JSON.stringify(j)); return ME.readEnrichJob(repo).st; };
  ok(put({ ...okJob, extra: 1 }) === "damaged", "job 미지 필드=damaged");
  // 7차 f-b74df6a1: jobKey 공식 결속 — 임의 sha1 키·dch 유무 불일치=damaged
  ok(put({ ...okJob, jobKey: sha("arbitrary") }) === "damaged", "임의 jobKey=damaged(멱등키 공식 결속)");
  ok(put({ ...okJob, decisionContextHash: sha("dch") }) === "damaged", "dch 추가인데 jobKey 미갱신=damaged");
  ok(put({ ...okJob, jobKey: ME.jobKeyOf(okJob.mapId, okJob.authorityHash, sha("dch")), decisionContextHash: sha("dch") }) === "ok", "dch 포함 공식 일치=승인");
  ok(put({ ...okJob, mapId: "not-a-uuid", jobKey: ME.jobKeyOf("not-a-uuid", okJob.authorityHash, null) }) === "damaged", "mapId 형식 위반=damaged");
  // 8차 ab-7: self도 동의 세대 필수 — consentGen 0(무동의)=damaged(자동 보강 동의 결속)
  ok(put({ ...okJob, mode: "self", attempts: [{ ...okJob.attempts[0], provider: "self", consentGen: 0 }] }) === "damaged", "self attempt consentGen 0=damaged(selfAuto grant 세대 동결 필수)");
  ok(put({ ...okJob, mode: "self", attempts: [{ ...okJob.attempts[0], provider: "self", consentGen: 1 }] }) === "ok", "self attempt consentGen>=1=승인");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: "bad" }] }) === "damaged", "results 이형=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], resolutions: "bad" }] }) === "damaged", "resolutions 이형=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: ["not-a-uuid"] } }] }) === "damaged", "appliedPatchIds 비UUID=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [], currentPatch: { schema: "x" } }, phase: "applying" }] }) === "damaged", "currentPatch가 MapPatchV2 위반=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], unknownField: true }] }) === "damaged", "attempt 미지 필드=damaged");
  // 2차 프로브 재현(중첩 strict): 빈 items·이형 claims·범위 밖 nextIndex·중복 UUID·중복 attemptId=damaged
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: { schema: "enrich-result-v1", items: [] } }] }) === "damaged", "results 빈 items=damaged(실 validator와 동형)");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], resolutions: [{ patchId: U(1), opHash: sha("o"), baseDecisionContextHash: sha("c"), verdict: "support", claims: [null] }] }] }) === "damaged", "resolution claims null=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], resolutions: [{ patchId: U(1), opHash: sha("o"), baseDecisionContextHash: sha("c"), verdict: "support", claims: [{ anything: true }] }] }] }) === "damaged", "resolution claim 미지 필드=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 999, rev: 0, appliedPatchIds: [] } }] }) === "damaged", "nextIndex>items 수=damaged(오재개 차단)");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [U(1), U(1)] } }] }) === "damaged", "appliedPatchIds 중복=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0] }, { ...okJob.attempts[0] }] }) === "damaged", "attemptId 중복(순번 위반)=damaged");
  // 4차 f-b74df6a1: 상한·cursor 전이 불변식 반례
  const MANY = { schema: "enrich-result-v1", items: Array.from({ length: 201 }, () => RES1.items[0]) };
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: MANY }] }) === "damaged", "201 items=상한 초과 damaged(실 validator 동형)");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [U(5)] } }] }) === "damaged", "appliedPatchIds 수!=nextIndex=damaged(ⓑ 원자 전이 불변식)");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 0, rev: 3, appliedPatchIds: [] } }] }) === "damaged", "rev>0인데 재제안 흔적 없음=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 1, rev: 1, appliedPatchIds: [U(5)], super: { fromPatchId: U(6), fromOpHash: sha("o"), toRev: 1, phase: "marked" } } }] }) === "damaged", "super.toRev!=rev+1=damaged");
  ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], results: RES1, cursor: { nextIndex: 1, rev: 1, appliedPatchIds: [U(5)], super: { fromPatchId: U(6), fromOpHash: sha("o"), toRev: 2, phase: "marked" } } }] }) === "damaged", "전 item 완료(nextIndex==items 수)인데 진행 흔적 잔존=damaged");
  // 5차 f-b74df6a1: currentPatch 결속 — '다른 유효 patch' 재개 정본 승인 차단
  {
    const cpOK = { schema: "map-patch-v2", patchId: ME.detPatchId(ME.jobSeedOf(okJob.jobKey, okJob.startedAt), 0, 0, 0), mapId: okJob.mapId, basis: { kind: "historyless", basisFp: sha("b"), inventoryFp: sha("i") }, baseMapHash: sha("m"), baseAuthorityHash: sha("a"), baseDecisionContextHash: sha("c"), baseDirtyFp: "", operation: "add_evidence", targetId: U(1), payload: RES1.items[0].payload, readSet: { targets: [{ id: U(1), contentHash: sha("t") }], files: [{ ref: "src/a.js", contentHash: sha("e") }], decisionIndex: [{ id: U(1), indexFp: sha("x") }] }, rationale: "r", evidence: [{ kind: "code", ref: "src/a.js" }], provider: "economy" };
    const withCp = (cp) => put({ ...okJob, attempts: [{ ...okJob.attempts[0], phase: "applying", results: RES1, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [], currentPatch: cp } }] });
    ok(withCp(cpOK) === "ok", "결속 일치 currentPatch=승인");
    ok(withCp({ ...cpOK, patchId: U(77) }) === "damaged", "patchId 결속 위반(공식 밖 UUID)=damaged");
    ok(withCp({ ...cpOK, provider: "self" }) === "damaged", "provider 결속 위반=damaged(타 provider patch 재투입 차단)");
    ok(withCp({ ...cpOK, mapId: U(99) }) === "damaged", "mapId 결속 위반=damaged");
    ok(withCp({ ...cpOK, payload: { evidence: { kind: "code", ref: "src/b.js" } } }) === "damaged", "payload↔item 불일치=damaged");
    ok(withCp({ ...cpOK, evidence: [{ kind: "code", ref: "src/other.js" }] }) === "damaged", "evidence 파일 집합↔item 불일치=damaged");
    // 6차(ab-3): kind 세탁 반례 — 같은 ref여도 kind가 변환기 규칙(evidenceKindOf)과 다르면 damaged
    const RESDOC = { schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: U(1), payload: RES1.items[0].payload, evidence: [{ file: "docs/x.md", quote: "q" }] }] };
    const cpDoc = { ...cpOK, patchId: ME.detPatchId(ME.jobSeedOf(okJob.jobKey, okJob.startedAt), 0, 0, 0), evidence: [{ kind: "code", ref: "docs/x.md" }] };
    ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], phase: "applying", results: RESDOC, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [], currentPatch: cpDoc } }] }) === "damaged", "doc 근거를 code kind로 기록한 currentPatch=damaged(P2 관문 세탁 차단)");
    ok(put({ ...okJob, attempts: [{ ...okJob.attempts[0], phase: "applying", results: RESDOC, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [], currentPatch: { ...cpDoc, evidence: [{ kind: "doc", ref: "docs/x.md" }] } } }] }) === "damaged", "(참고) doc 단독 근거 patch는 P2 validator 자체가 거부 — currentPatch로도 승인 불가");
  }
  ok(put(okJob) === "ok", "(복원) 정상 장부 재승인");
  ok(ME.updateEnrichJob(repo, () => null).ok === true, "mut null=무변경 성공");
  fs.writeFileSync(ME.jobFileFor(repo), "[]");
  ok(ME.readEnrichJob(repo).st === "damaged", "손상(배열 루트)=damaged(자동 실행 전면 정지 소관)");
  ok(ME.updateEnrichJob(repo, () => mkJob({})).ok === false, "손상 위 RMW 거부(fail-closed)");
}

console.log("[3] enrich-result-v1 validator — op별 합타입·실패 분류(schema/id)");
{
  const topo = { nodes: [{ id: U(1) }, { id: U(2) }], edges: [{ id: U(11) }] };
  const EV = [{ file: "src/a.js", quote: "// a" }];
  const R = (items) => ME.validateEnrichResult({ schema: "enrich-result-v1", items }, topo);
  ok(R([{ op: "add_evidence", targetId: U(1), payload: { evidence: {} }, evidence: EV }]).ok === true, "대상 op 정상");
  ok(R([{ op: "add_evidence", targetId: U(9), payload: {}, evidence: EV }]).kind === "id", "targetId 미실존=ID 실패(승격 트리거 분류)");
  ok(R([{ op: "add_evidence", targetId: U(1), payload: {} }]).kind === "schema", "evidence 누락=스키마 실패(전 op 공통 재료)");
  ok(R([{ op: "add_edge", payload: { edge: { from: U(1), to: U(2) } }, evidence: EV }]).ok === true, "add_edge 정상(payload.edge 단일 출처)");
  ok(R([{ op: "add_edge", targetId: U(1), payload: { edge: { from: U(1), to: U(2) } }, evidence: EV }]).kind === "schema", "add_edge targetId 금지(생성 op 계약)");
  ok(R([{ op: "add_edge", payload: { edge: { from: U(1), to: U(99) } }, evidence: EV }]).kind === "id", "edge.to 미실존=ID 실패");
  ok(R([{ op: "rewrite_label", targetId: U(1), payload: { to: { label: "L" }, expect: { label: "K" } }, evidence: EV, claims: [{ file: "src/a.js", quote: "q", stance: "support" }] }]).ok === true, "rewrite_label 정상(claims 필수)");
  ok(R([{ op: "rewrite_label", targetId: U(1), payload: { to: {}, expect: {} }, evidence: EV }]).kind === "schema", "rewrite_label claims 누락=스키마 실패");
  ok(R([{ op: "supersede", targetId: U(1), payload: {}, evidence: EV }]).kind === "schema", "허용 밖 op=스키마 실패(격하 op는 보강 산출 금지 — 충돌은 P8-4 감지)");
  ok(ME.validateEnrichResult({ schema: "x", items: [] }, topo).ok === false, "스키마 표지 위반");
  ok(R([]).ok === false, "빈 items 거부");
  // 3a 검증 1차 blocker②: strict 합타입 — 미지·잉여 필드 거부
  ok(R([{ op: "add_edge", from: U(1), to: U(2), payload: { edge: { from: U(1), to: U(2) } }, evidence: EV }]).kind === "schema", "add_edge top-level from/to=미지 필드 거부(payload.edge 단일 출처)");
  ok(R([{ op: "add_evidence", targetId: U(1), payload: {}, evidence: EV, bonus: 1 }]).kind === "schema", "item 미지 필드=거부(조용한 재해석 금지)");
  ok(R([{ op: "add_edge", payload: { edge: { from: U(1), to: U(2) }, extra: 1 }, evidence: EV }]).kind === "schema", "add_edge payload 잉여 키=거부");
  ok(R([{ op: "rewrite_label", targetId: U(1), payload: { to: { label: "L" }, expect: { label: "K" } }, evidence: EV, claims: [{ file: "f", quote: "q", stance: "support", extra: 1 }] }]).kind === "schema", "claim 잉여 필드=거부(strict)");
  // 2차 프로브 재현: root·payload strict
  ok(ME.validateEnrichResult({ schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: U(1), payload: { evidence: {} }, evidence: EV }], extra: 1 }, topo).kind === "schema", "root 미지 필드=거부");
  ok(R([{ op: "add_evidence", targetId: U(1), payload: { evidence: {}, extra: 1 }, evidence: EV }]).kind === "schema", "대상 op payload 잉여 키=거부(P2 화이트리스트)");
  ok(R([{ op: "rewrite_label", targetId: U(1), payload: { to: { label: "L" }, expect: { label: "K" }, extra: 1 }, evidence: EV, claims: [{ file: "f", quote: "q", stance: "support" }] }]).kind === "schema", "rewrite_label payload 잉여 키=거부");
}

console.log("[3b] evidenceKindOf — 결정론 분류(문서 근거 세탁 차단 — ab-3)");
{
  ok(ME.evidenceKindOf("src/a.js") === "code", "소스=code");
  ok(ME.evidenceKindOf("docs/MAP-V2-DESIGN.md") === "doc", "md=doc(P2 관문이 doc 단독을 거부하게 정직 분류)");
  ok(ME.evidenceKindOf("tests/x.test.js") === "test", "테스트 경로=test");
  ok(ME.evidenceKindOf("config/app.yaml") === "config", "설정=config");
  ok(ME.evidenceKindOf("SRC\\B.TS") === "code", "win 구분자·대문자 정규화");
  // 2차(ab-3): 무확장·test 경로 문서의 세탁 차단
  ok(ME.evidenceKindOf("LICENSE") === "doc", "무확장(LICENSE)=doc(코드 세탁 금지 — 보수 기본값)");
  ok(ME.evidenceKindOf("README") === "doc", "무확장(README)=doc");
  ok(ME.evidenceKindOf("tests/README.md") === "doc", "test 경로의 문서=doc(확장자 우선 — 문서는 어디 있든 문서)");
  ok(ME.evidenceKindOf("docs/design.test.md") === "doc", ".test.md도 doc(문서 확장자 우선)");
  ok(ME.evidenceKindOf("weird.xyz") === "doc", "미지 확장자=doc(code 화이트리스트 밖)");
}

console.log("[4] toPatchV2 — 결정론 patchId(UUID·재현·rev)·P2 validator 실통과·claims 사전 결속");
{
  const repo = mkRepo("conv");
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(repo, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(repo, "test");
  const r = MR.initTopologyForBootstrap(repo);
  ok(r.st === "created", "(전제) init");
  const topo = MR.readTopoExFor(repo).topo;
  const nodeId = topo.nodes[0].id;
  const idx = MP.decisionIndexFor(repo, topo.mapId);
  const pol = MP.policyStateFor(repo, topo.mapId);
  const fh = (ref) => { try { return sha(fs.readFileSync(path.join(repo, ref), "utf8")); } catch { return null; } };
  const ctx = { repo, topo, idx, pol, fileHashOf: fh, jobKey: sha("jk"), attemptId: 0, rev: 0, provider: "economy" };
  const item = { op: "add_condition" }; // 허용 밖 — validator가 걸렀을 op는 변환기에 오지 않지만 방어 확인용 아님. 실사용 op:
  const itemEv = { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "src/a.js", quote: "// a" }] };
  const c1 = ME.toPatchV2(itemEv, 0, ctx);
  ok(c1.ok === true, "add_evidence 변환 성공(P2 validatePatchV2 실통과)");
  ok(c1.patch.patchId === ME.detPatchId(ctx.jobKey, 0, 0, 0) && c1.patch.provider === "economy", "결정론 patchId+provider 필드 기록(충돌 감지 원천)");
  const c1b = ME.toPatchV2(itemEv, 0, ctx);
  ok(c1b.patch.patchId === c1.patch.patchId, "재변환 동일 patchId(재현)");
  const c1c = ME.toPatchV2(itemEv, 0, { ...ctx, rev: 1 });
  ok(c1c.patch.patchId !== c1.patch.patchId, "rev 전진=새 patchId");
  // rewrite_label — claims 파일이 evidence에 사전 결속(P8-4: 해소 근거가 opHash·evidenceFps에 실림)
  fs.writeFileSync(path.join(repo, "src", "b.js"), "// b\n");
  const lbl = topo.nodes[0].label;
  const itemRl = { op: "rewrite_label", targetId: nodeId, payload: { to: { label: lbl + "-x" }, expect: { label: lbl } }, evidence: [{ file: "src/a.js", quote: "// a" }], claims: [{ file: "src/b.js", quote: "// b", stance: "support" }] };
  const c2 = ME.toPatchV2(itemRl, 1, ctx);
  ok(c2.ok === true && c2.patch.evidence.some((e) => e.ref === "src/b.js") && c2.patch.evidence.some((e) => e.ref === "src/a.js"), "claims 파일이 patch.evidence에 합류(사전 결속 — 5차 blocker ⓐ 채택)");
  // 변환 실패=분류 반환
  const cBad = ME.toPatchV2({ op: "add_evidence", targetId: nodeId, payload: { wrong: 1 }, evidence: [{ file: "src/a.js", quote: "q" }] }, 2, ctx);
  ok(cBad.ok === false && cBad.kind === "schema", "P2 payload 위반=schema 실패 분류(provider 실패 플래그 재료)");
  // ab-3(3a 1차 blocker③): 문서 단독 근거는 P2 관문('code/test/config 최소 1개')이 거부 — kind 세탁 차단 e2e
  fs.writeFileSync(path.join(repo, "notes.md"), "# n\n");
  const cDoc = ME.toPatchV2({ op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/a.js", note: "n" } }, evidence: [{ file: "notes.md", quote: "# n" }] }, 3, ctx);
  ok(cDoc.ok === false && (cDoc.errors || []).some((e) => /code\/test\/config/.test(e)), "문서 단독 근거=P2 증거 관문 거부(자기확인 고리 차단 — kind를 code로 세탁하지 않는다)");
  // 실 e2e: 변환 patch가 propose→classify→apply(auto)까지 통과
  MP.proposePatch(repo, c1.patch);
  MP.classifyPatch(repo, topo.mapId, c1.patch.patchId);
  const ap = MP.applyPatch(repo, topo.mapId, c1.patch.patchId, { preCutover: true });
  ok(ap.ok === true, "변환 patch가 P2 전체 경로(propose→classify→apply) 실통과");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
