"use strict";
/*
 * P3b 증분 1 — 6표면 재배선·정본 잠금 교정·reasonKey(설계 동결: docs/MAP-P3B-DESIGN.md B·C-4·C-6).
 * 계약: ①physKeyOf↔canonicalIdentityFor.physKey 패리티+ctxFor 신·구 이중 잠금(구 키 보유=신 코드 대기)
 * ②runCli writer가 ctxFor 단일 출처 ③blocked=전 표면 사유 표시(legacy 위임·공급 금지)+reasonKey ko/en
 * ④applyPatch: blocked=플래그 무관 거부·legacy=기존 --pre-cutover 필수 문구 불변 ⑤읽기 폴백=전환 흔적
 * 원시 검사 ⑥쓰기 표면 폴백=거부 경로만(검사-후-쓰기 부재 — 정적 단언).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3b1_"));
process.env.CODEX_BRIDGE_HOME = dir;
const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
const MP = require(path.join(ROOT, "bridge", "map-pipeline.js"));
const MB = require(path.join(ROOT, "bridge", "map-bindings.js"));
const MA = require(path.join(ROOT, "bridge", "map-adapters.js"));
const RD = require(path.join(ROOT, "bridge", "map-reader.js"));
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

function mkRepo(name, files) {
  const r = path.join(dir, name);
  fs.mkdirSync(r, { recursive: true });
  for (const [rel, txt] of Object.entries(files || {})) {
    const f = path.join(r, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, txt, "utf8");
  }
  return r;
}
function markTrace(repo) { // 전환 흔적(history-only) — authorityStateFor=blocked(history-without-marker)
  fs.mkdirSync(path.join(repo, "project-map", "authority-history"), { recursive: true });
  fs.writeFileSync(path.join(repo, "project-map", "authority-history", "x.json"), "{}", "utf8");
}
function scoutOn(ws) {
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, scoutMode: "on" }), "utf8");
}

console.log("[1] C-6 — 물리 잠금 키 패리티·이중 잠금·runCli 단일 출처");
{
  const r1 = mkRepo("lk", { "a.txt": "x" });
  ok(MR.physKeyOf(r1) === MP.canonicalIdentityFor(r1).physKey, "physKeyOf ≡ canonicalIdentityFor.physKey(무순환 사본 패리티 — 1-29)");
  const ctx = MR.ctxFor(r1);
  ok(path.basename(ctx.LOCK).startsWith("phys-"), "신 잠금 파일=phys- 접두(구 wsKey 파일명과 네임스페이스 분리)");
  ok(ctx.LOCKS.length >= 2 && ctx.LOCKS[0] === ctx.LOCK && ctx.LOCKS.slice(1).every((l) => !path.basename(l).startsWith("phys-")), "LOCKS=[신 physKey 잠금 선행, 구 wsKey 잠금 후행] 순서 고정");
  // 구 키 잠금을 '살아있는 프로세스'가 보유 → 신 withMapLock은 취득 실패(대기 후 timeout — 동시 쓰기 차단)
  fs.mkdirSync(path.dirname(ctx.LOCKS[1]), { recursive: true });
  fs.writeFileSync(ctx.LOCKS[1], process.pid + "-oldgen", "utf8");
  const held = MR.withMapLock(r1, () => "should-not-run");
  ok(held.ok === false && /lock-timeout/.test(held.error || ""), "구 세대가 구 wsKey 잠금 보유 중 → 신 코드 취득 실패(이행 창 상호 배제)");
  fs.unlinkSync(ctx.LOCKS[1]);
  const free = MR.withMapLock(r1, () => 7);
  ok(free.ok === true && free.result === 7, "해제 후 정상 취득(합타입 {ok,result} 불변)");
  // 등록 별칭 전수: 계약에 같은 물리 경로의 별칭(끝 구분자 변형) 등록 → 그 wsKey 잠금도 취득 대상
  const alias = r1 + path.sep; // resolve 동일·문자열 상이(wsKeyFor는 normWs라 대부분 동일 키 — 등록 스캔 경로 실행 증명)
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts", "zz-alias.json"), JSON.stringify({ workspace: alias, scoutRepo: r1 }), "utf8");
  const keys = MR.legacyLockKeysFor(r1);
  ok(Array.isArray(keys) && keys.length >= 1 && keys.every((k) => /^[0-9a-f]{16}$/.test(k)), "legacyLockKeysFor — 등록 별칭 스캔이 wsKey 집합 산출(판독 실패=누락 허용·정지 게이트가 최종 방어)");
  // runCli init·render가 ctxFor 단일 출처(자체 LOCK 조립 부재 — 소스 단언)
  const src = fs.readFileSync(path.join(ROOT, "bridge", "map-runtime.js"), "utf8");
  ok(!/ctx\.LOCK\s*=\s*path\.join\(BRIDGE_DIR/.test(src), "runCli 자체 LOCK 조립 폐기 — ctxFor 단일 출처(2차 #5)");
  ok(/const ctx = ctxFor\(repo\)/.test(src), "runCli가 ctxFor 사용");
}

console.log("[2] reasonKey — 권위·어댑터 전 표면(공통 (f))");
{
  const r2 = mkRepo("rk", { "docs/MAP.md": "# MAP\n" });
  markTrace(r2);
  const a = MB.authorityStateFor(r2);
  ok(a.st === "blocked" && a.reasonKey === "history-without-marker", "authorityStateFor blocked=reasonKey(history-without-marker)");
  const av = MA.approvedViewFor(r2);
  ok(av.source === "blocked" && av.reasonKey === "history-without-marker" && av.approved.length === 0, "approvedViewFor blocked — legacy 데이터 공급 0+reasonKey 전파");
  const mc = MA.mapContentFor(r2);
  ok(mc.source === "blocked" && mc.content === null && mc.reasonKey === "history-without-marker", "mapContentFor blocked — content null+reasonKey");
  const pe = MA.promoteEntry(r2, { text: "지적 x — src/a.js", from: "t", approvedAt: new Date().toISOString(), actionRef: "export" });
  ok(pe.st === "rejected" && pe.reasonKey === "history-without-marker", "promoteEntry blocked=거부+reasonKey");
  const pj = RD.readMapProjection(r2);
  ok(pj.ok === false && pj.source === "blocked" && pj.reasonKey === "history-without-marker", "readMapProjection blocked+reasonKey");
  // 형식 위반 marker → authority-format
  const r2b = mkRepo("rk2", {});
  fs.mkdirSync(path.join(r2b, "project-map"), { recursive: true });
  fs.writeFileSync(path.join(r2b, "project-map", "authority.json"), JSON.stringify({ schema: "map-authority-v1", cutover: true, mapId: "00000000-0000-4000-8000-000000000001", decisionRef: "00000000-0000-4000-8000-000000000002", ts: "2026-07-21T00:00:00Z", extra: 1 }), "utf8");
  ok(MB.authorityStateFor(r2b).reasonKey === "authority-format", "잉여 키 marker=authority-format");
}

console.log("[3] B-5 attach — blocked/error=고지(위임 금지)·legacy=위임(바이트 동일)");
{
  const ws3 = mkRepo("at", { "docs/MAP.md": "# MAP\n" });
  scoutOn(ws3);
  const c3 = CL.loadContract(ws3, "ko");
  const legacyAtt = RD.buildMapAttach(ws3, c3, "ko");
  const directAtt = CL.buildScoutAttach(ws3, c3, "ko");
  ok(JSON.stringify(legacyAtt) === JSON.stringify(directAtt), "legacy 판정 확인=기존 동봉 위임(바이트 동일 — 무회귀)");
  markTrace(ws3);
  const blockedAtt = RD.buildMapAttach(ws3, c3, "ko");
  ok(blockedAtt && typeof blockedAtt.text === "string" && blockedAtt.text.includes("[Project MAP]") && blockedAtt.text.includes("판독 불가") && blockedAtt.mapItems.length === 0, "blocked=고지 attach(사유·ko) — legacy 데이터 미공급·차단 없음");
  const blockedAttEn = RD.buildMapAttach(ws3, c3, "en");
  ok(blockedAttEn.text.includes("Unreadable right now") && /cutover history/.test(blockedAttEn.text), "blocked 고지 en 슬롯 — reasonKey 번역(한국어 원문 노출 없음)");
  ok(!/[가-힣]/.test(blockedAttEn.text), "en 고지에 한글 0(한/영 분리)");
  ok(RD.buildMapAttach(ws3, { ...c3, scoutMode: "off" }, "ko") === null, "2트랙 게이트 최선행 불변(off=null)");
}

console.log("[4] C-4 — applyPatch 권위 게이트");
{
  const r4 = mkRepo("ap", {});
  ok(/--pre-cutover 명시 필수/.test((MP.applyPatch(r4, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", {}) || {}).error || ""), "legacy 무플래그=기존 거부 문구 불변");
  markTrace(r4);
  const b1 = MP.applyPatch(r4, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", { preCutover: true });
  ok(b1.ok === false && /blocked/.test(b1.error) && /재개/.test(b1.error), "blocked=--pre-cutover여도 전면 거부+재개 안내(2차 #3)");
  const src = fs.readFileSync(path.join(ROOT, "bridge", "map-pipeline.js"), "utf8");
  ok(/\.\.\.\(o\.preCutover \? \{ preCutover: true \} : \{\}\)/.test(src), "decision preCutover 필드=--pre-cutover 명시 경로만 기록(v2 무플래그=생략 — 1차 #5)");
  // 구현검증 1차 #1: 잠금 안 권위 재판정 — 트랜잭션 첫 검사로 존재+상태 전이=중단(정적 잠금. 전이 실행
  // 반례는 pending 인프라 필요 — cutover e2e[증분 2]에서 marker 실물로 실행)
  ok(/withMapLock\(repo, \(\) => \{[\s\S]{0,700}authorityStateFor\(repo\)[\s\S]{0,500}권위 상태가 판정~잠금 사이 변경됨/.test(src), "applyPatch — 잠금 안 권위 재판정(blocked·전이=중단)이 트랜잭션 선두에 위치");
}

console.log("[5] B-2 — 꾸러미 blocked 정직 표기");
{
  const r5 = mkRepo("pk", { "docs/MAP.md": "# 확정\n- 항목 A\n" });
  markTrace(r5);
  delete require.cache[require.resolve(path.join(ROOT, "scripts", "scope-package.js"))];
  // collectCommon은 비공개 — buildPackage 산출로 확인(드라이버 스프레드 배선). 여기서는 ts 산출물 계약만 직접:
  const SP = require(path.join(ROOT, "out", "scope-package.js"));
  const pkg = SP.buildPackage({ repo: r5, head: "h", seeds: [], diffText: "", tokenHits: [], coChange: null, tests: [], recentFailures: [], mapContent: null, mapContentBlocked: "이력 존재", mapContentBlockedKey: "history-without-marker" });
  ok(pkg.meta.mapContentBlocked === "이력 존재" && pkg.meta.mapContentBlockedKey === "history-without-marker", "meta에 사유 원문+안정 키 분리 보존(구현검증 1차 #4 — 소비처 번역 재료·구조 소실 봉합)");
  ok(pkg.blindSpots.some((b) => b.includes("판독 불가") && b.includes("없음과 다르다")), "blindSpot 문구 — blocked≠없음");
  const md = SP.renderPackageMarkdown(pkg, "ko");
  ok(md.includes("판독 불가") && md.includes("확인이 필요한 상태"), "렌더 — 지도 없음으로 위장하지 않음");
  const drv = fs.readFileSync(path.join(ROOT, "scripts", "scope-package.js"), "utf8");
  ok(/mapContentFor\(repo\)/.test(drv) && /mapContentBlocked/.test(drv) && /authority-history/.test(drv), "드라이버 — 어댑터 경유+원시 검사 폴백 배선(정적)");
}

console.log("[6] B-6 — scout-gate 3분기(blocked=통과+로그·실 자식 프로세스)");
{
  const ws6 = mkRepo("gt", { "docs/MAP.md": "# MAP\n" });
  markTrace(ws6);
  fs.writeFileSync(CL.contractFileFor(ws6, "ko"), JSON.stringify({ workspace: ws6, scoutMode: "on", scoutGate: "plan" }), "utf8");
  const payload = JSON.stringify({ tool_name: "ExitPlanMode", session_id: "p3b-test", cwd: ws6, tool_input: {} });
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "scout-gate.js")], { input: payload, encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws6 }, timeout: 30000, windowsHide: true });
  ok(r.status === 0, "blocked=차단하지 않고 통과(fail-open 유지 — exit 0)");
  const logF = path.join(dir, "scout-gate-log", CL.wsKeyFor(ws6) + ".jsonl");
  const log = fs.existsSync(logF) ? fs.readFileSync(logF, "utf8") : "";
  ok(/권위 판독 차단|authority blocked/.test(log), "통과하되 관측 로그에 blocked 사유 기록(숨김 금지)");
}

console.log("[7] 쓰기 표면 폴백=fail-closed·재배선 정적 단언");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/mapAdapters\(\)/.test(ext) && /approvedViewFor\(targetRepo\)/.test(ext), "대시보드 확정층=어댑터 경유(B-1)");
  ok(/cutoverTraceState\(targetRepo\)/.test(ext) && /mapSource = "blocked"/.test(ext), "구 런타임 폴백=전환 흔적 원시 검사(존재/판독불가=blocked 표시·legacy 공급 금지)");
  ok(/mapSource === "blocked" \? ""/.test(ext), "blocked=mapText 숨김(원문 미리보기 0 — §B)");
  ok(/const targetSnap = scoutTargetFor\(ws\)\.repo/.test(ext) && /normWs\(scoutTargetFor\(ws\)\.repo\) !== normWs\(targetSnap\)/.test(ext), "export 대상 스냅샷+모달 후 불변 재검사(1차 #10)");
  ok(/actionRef: "export"/.test(ext) && /needs-binding/.test(ext), "export v2 분기=promoteEntry 합타입 소비");
  ok(/withMapLock\(targetSnap/.test(ext) && /a2\.st !== "legacy"/.test(ext), "export legacy 분기=정본 잠금 안 재판정 후 기록(1차 #1)");
  const rec = fs.readFileSync(path.join(ROOT, "scripts", "scope-reconcile.js"), "utf8");
  ok(/MAP 런타임 판독 불가 — 확정층 기록을 거부한다/.test(rec), "reconcile 폴백=기록 거부(검사-후-쓰기 부재 — 공통 (a))");
  ok(/withMapLock\(repo,/.test(rec) && /a2\.st !== "legacy"/.test(rec) && /actionRef: "approve"/.test(rec), "reconcile — legacy 잠금 안 재판정+v2 promoteEntry 분기");
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(/mapAttachSurface\(ws \|\| configWs\(\), c, lang\)/.test(cb) && /authority-history/.test(cb), "동봉 표면=buildMapAttach 경유+원시 검사 폴백(B-5)");
}

console.log("[8] 구현검증 1차 반영 — 경합·키·번역 봉합");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/path\.join\(targetSnap, c9\)/.test(ext) && !/const f = mapLedgerFile\(ws\); \/\/ targetSnap/.test(ext), "export legacy 기록 경로=스냅샷 대상에서 직접 계산(잠금 안 가변 ws 재해석 금지 — 1차 #2)");
  ok(/already-applied[\s\S]{0,400}recordTo\("exported"/.test(ext), "already-applied export도 exported 관측 이벤트 기록(1차 [보완])");
  ok(/reasonTextFor/.test(ext), "확장 사유 번역=배포 map-reader 단일 출처 위임(로컬 표는 폴백)");
  const gate = fs.readFileSync(path.join(ROOT, "bridge", "scout-gate.js"), "utf8");
  ok(/v2 판정기 예외/.test(gate) && /inp.assess()/.test(gate), "게이트 — v2 확인 후 판정기 예외=legacy 하강 금지(순수 결정기 내 봉합·실행은 [11])");
  ok(gate.includes("전환 흔적 감지(legacy 판정기 직전 재검사)") && /gateTraceStateOf/.test(gate), "게이트 — 기존 판정기 진입 직전 전환 흔적 재검사(결정기+3상태 판독기·실행은 [11])");
  const ad = fs.readFileSync(path.join(ROOT, "bridge", "map-adapters.js"), "utf8");
  ok(/res\.reasonKey = "live-rejected"/.test(ad), "promoteEntry 내부 거부에도 reasonKey 보장(1차 #5)");
  const RDx = require(path.join(ROOT, "bridge", "map-reader.js"));
  ok(typeof RDx.reasonTextFor === "function" && !/[가-힣]/.test(RDx.reasonTextFor("live-rejected", "국문", true)) && /[가-힣]/.test(RDx.reasonTextFor("live-rejected", null, false)), "reasonTextFor — en 슬롯 영문·ko 슬롯 국문(공용 번역기)");
  const rec2 = fs.readFileSync(path.join(ROOT, "scripts", "scope-reconcile.js"), "utf8");
  ok(/reasonTextFor/.test(rec2) && /enWhy/.test(rec2), "reconcile en 거부 사유=키 번역(한국어 원문 비노출 — 1차 #5)");
  const drv2 = fs.readFileSync(path.join(ROOT, "scripts", "scope-package.js"), "utf8");
  ok(/mapContentBlockedKey = mc\.reasonKey/.test(drv2), "꾸러미 드라이버 — 사유 키·원문 분리 보존(1차 #4)");
}

console.log("[9] 실행 반례 — applyPatch 권위 전이(잠금 안 재판정)·v2 실물 marker 소비(구현검증 2차 #1)");
{
  // (a) 판정~잠금 사이 권위 전이 — authorityStateFor 모킹(호출 1회차 legacy·이후 blocked)으로 실행
  const MBoot = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
  const PM = MR.PM;
  const sha = (s) => require("crypto").createHash("sha1").update(s).digest("hex");
  const wsA = mkRepo("race", { "src/a.js": "// a\n" });
  scoutOn(wsA);
  MBoot.grantConsent(wsA, "test");
  const init = MR.initTopologyForBootstrap(wsA);
  ok(init.st === "created", "(전제) topology 생성");
  const topoA = MR.readTopoExFor(wsA).topo;
  const nodeA = topoA.nodes[0];
  const idxA = MP.decisionIndexFor(wsA, topoA.mapId);
  const polA = MP.policyStateFor(wsA, topoA.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topoA), idxA);
  const patchA = {
    schema: "map-patch-v2", patchId: require("crypto").randomUUID(), mapId: topoA.mapId,
    basis: MP.patchBasisFor(wsA, topoA), baseMapHash: PM.mapHashOf(topoA),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, polA.pfh),
    baseDirtyFp: "", operation: "add_evidence", targetId: nodeA.id,
    payload: { evidence: { kind: "code", ref: "src/a.js" } }, readSet: {}, rationale: "race-test",
    evidence: [{ kind: "code", ref: "src/a.js" }],
  };
  patchA.readSet = MP.buildReadSetFor(topoA, patchA, { idx: idxA, pol: polA, repoRoot: wsA, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(wsA, ref), "utf8")); } catch { return null; } } });
  ok(MP.proposePatch(wsA, patchA).ok === true, "(전제) 제안 수납");
  ok(MP.classifyPatch(wsA, topoA.mapId, patchA.patchId).ok === true, "(전제) 분류");
  const realAuth = MB.authorityStateFor;
  let calls = 0;
  MB.authorityStateFor = (repo9) => { calls++; return calls === 1 ? { st: "legacy" } : { st: "blocked", reasonKey: "history-without-marker", reason: "모킹 전이" }; }; // 1회차(잠금 밖)=legacy·2회차(잠금 안)=blocked
  const race = MP.applyPatch(wsA, topoA.mapId, patchA.patchId, { preCutover: true });
  MB.authorityStateFor = realAuth;
  ok(race.ok === false && /잠금 안 재판정|판정~잠금 사이/.test(race.error || ""), "판정~잠금 사이 blocked 전이 → 잠금 안 재판정이 중단(topology 무변경)");
  ok(calls >= 2, "권위 판정이 잠금 밖+잠금 안 2회 실행됨(재검사 실증)");
  const pend = JSON.parse(fs.readFileSync(path.join(MP.pipeRootFor(wsA), topoA.mapId, "pending", patchA.patchId + ".json"), "utf8"));
  ok(pend.lifecycle === "classified" && !pend.claim, "중단 시 claim 롤백(classified 복귀 — 재시도 가능)");
  const after = MP.applyPatch(wsA, topoA.mapId, patchA.patchId, { preCutover: true });
  ok(after.ok === true, "전이 해소 후 재실행=정상 적용(중단이 영구 아님)");

  // (b) v2 실물 marker+receipt 제작 → 권위 v2 실증·게이트 판정기 실행(assessor active)
  const wsB = mkRepo("v2live", { "src/b.js": "// b\n" });
  scoutOn(wsB);
  MBoot.grantConsent(wsB, "test");
  ok(MR.initTopologyForBootstrap(wsB).st === "created", "(전제) v2용 topology");
  const topoB = MR.readTopoExFor(wsB).topo;
  const decId = require("crypto").randomUUID();
  const aoB = { schema: "map-authority-v1", cutover: true, mapId: topoB.mapId, decisionRef: decId, ts: new Date().toISOString() };
  const aoBytes = JSON.stringify(aoB, null, 1);
  const receiptB = { schema: "map-cutover-receipt-v1", decisionId: decId, mapId: topoB.mapId, authorityMode: { from: "legacy", to: "v2" }, authorityObject: aoB, authorityFileFp: sha(aoBytes), ts: aoB.ts };
  fs.mkdirSync(path.join(wsB, "project-map", "authority-history"), { recursive: true });
  fs.writeFileSync(path.join(wsB, "project-map", "authority-history", decId + ".json"), JSON.stringify(receiptB, null, 1), "utf8");
  fs.writeFileSync(path.join(wsB, "project-map", "authority.json"), aoBytes, "utf8");
  ok(MB.authorityStateFor(wsB).st === "v2", "손수 제작한 receipt→marker=권위 v2(§B 실물 성립 — cutover 쓰기 계약의 실증 재료)");
  const gB = RD.mapGateAssessFor(wsB);
  ok(gB.prepared === true && gB.active === true, "v2에서 공용 판정기 실행=active(비활성 준비 라벨 해제 실증)");
  const cGate = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "scout-gate.js")], { input: JSON.stringify({ tool_name: "ExitPlanMode", session_id: "p3b-v2", cwd: wsB, tool_input: {} }), encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: wsB }, timeout: 30000, windowsHide: true });
  ok(cGate.status === 0 || cGate.status === 2, "게이트 자식 프로세스 — v2 분기 실행(비정상 종료 없음: " + cGate.status + ")");
  const logB = (() => { try { return fs.readFileSync(path.join(dir, "scout-gate-log", CL.wsKeyFor(wsB) + ".jsonl"), "utf8"); } catch { return ""; } })();
  ok(!/전환된 프로젝트인데 MAP 런타임 판독 불가/.test(logB), "v2 정상 런타임=폴백 경로 미진입(신 판정기 소비)");
}

console.log("[10] 3상태 원시 검사·en 렌더(구현검증 2차 #2·#3·#4)");
{
  const SP2 = require(path.join(ROOT, "out", "scope-package.js"));
  const pkgEn = SP2.buildPackage({ repo: "r", head: "h", seeds: [], diffText: "", tokenHits: [], coChange: null, tests: [], recentFailures: [], mapContent: null, mapContentBlocked: "이력 존재", mapContentBlockedKey: "history-without-marker" });
  const mdEn = SP2.renderPackageMarkdown(pkgEn, "en");
  const blockedLine = mdEn.split("\n").filter((l) => l.includes("history-without-marker"))[0] || "";
  ok(/Unreadable — history-without-marker/.test(blockedLine) && !/[가-힣]/.test(blockedLine), "en 렌더 blocked 줄=키 표기·한국어 0(동결 4표면 언어 계약)");
  const gate2 = fs.readFileSync(path.join(ROOT, "bridge", "scout-gate.js"), "utf8");
  ok(/unreadable/.test(gate2) && /ENOENT/.test(gate2), "게이트 원시 검사=3상태(판독 오류≠부재)");
  const cb2 = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(/trace = "unreadable"/.test(cb2) && /legacy 확인 안 됨|not proven legacy/.test(cb2), "동봉 원시 검사=3상태(unreadable=고지·legacy 미공급)");
  const ext2 = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/cutoverTraceState/.test(ext2) && !/cutoverTraceExists/.test(ext2) && /trace-unreadable/.test(ext2), "확장 원시 검사=3상태 전환 완료");
  ok(/enMode \? \(key \|\| "unknown"\)/.test(ext2), "확장 en 폴백=키 우선(한국어 raw 비노출 — 표 불완전해도 안전)");
  ok(/"live-rejected"/.test(ext2), "확장 로컬 표에 신규 키 동기화");
}

console.log("[11] 게이트 순수 결정기 실행(구현검증 3차 #1 — 판정 로직 분리·같은 팩토리 실행)");
{
  const G = require(path.join(ROOT, "bridge", "scout-gate.js"));
  const D = G.decideGate;
  ok(D({ auth: { st: "v2" }, assess: () => { throw new Error("x"); }, blocksUsed: 0, cap: 2, en: false }).action === "pass", "v2 확인 후 판정기 예외=통과(legacy 하강 금지 — 실행)");
  ok(/v2 판정기 예외/.test(D({ auth: { st: "v2" }, assess: () => { throw new Error("x"); }, blocksUsed: 0, cap: 2, en: false }).log), "예외 통과 사유 로그 동반");
  ok(D({ auth: { st: "legacy" }, trace: "present", en: false }).action === "pass", "legacy 판정 직후 전환 흔적 present=통과(legacy 판정기 위임 금지 — 전환 경합 실행)");
  ok(D({ auth: { st: "legacy" }, trace: "unreadable", en: false }).action === "pass", "전환 흔적 unreadable=통과(부재 축소 금지)");
  ok(D({ auth: { st: "legacy" }, trace: "absent", en: false }).action === "legacy", "흔적 absent 확인 시에만 기존 판정기 위임");
  ok(D({ auth: null, trace: "unreadable", en: false }).action === "pass" && D({ auth: null, trace: "absent", en: false }).action === "legacy", "런타임 판독 실패: 흔적 unreadable=통과/absent=기존 경로");
  ok(D({ auth: { st: "blocked", reasonKey: "authority-format" }, en: false }).action === "pass", "blocked=무차단 통과+로그(숨김 금지)");
  const blk = D({ auth: { st: "v2" }, assess: () => ({ state: "stale", notice: { ko: "지도 먼저", en: "Map first" } }), blocksUsed: 0, cap: 2, en: true });
  ok(blk.action === "block" && blk.msg === "Map first", "v2 stale=차단·notice en 슬롯 소비");
  ok(D({ auth: { st: "v2" }, assess: () => ({ state: "stale", notice: { ko: "k", en: "e" } }), blocksUsed: 2, cap: 2, en: false }).action === "pass", "세션 차단 상한 도달=통과");
  const gateSrc9 = fs.readFileSync(path.join(ROOT, "bridge", "scout-gate.js"), "utf8");
  ok(/decideGate\(\{/.test(gateSrc9) && /decision\.action === "block"/.test(gateSrc9), "훅 본체가 같은 결정기를 소비(배선 단언)");
}

console.log("[12] 3상태 판독기·소비 실행(구현검증 3차 #2 — EACCES 주입)");
{
  const RDx2 = require(path.join(ROOT, "bridge", "map-reader.js"));
  const eacces = () => { const e = new Error("denied"); e.code = "EACCES"; throw e; };
  ok(RDx2.cutoverTraceStateOf("/nope-abc", { statSync: eacces }) === "unreadable", "statSync EACCES=unreadable(부재 축소 금지 — 주입 실행)");
  ok(RDx2.cutoverTraceStateOf("/nope-abc") === "absent", "실부재(ENOENT)=absent");
  // 소비 실행: fs 모듈 함수 일시 교체(공유 모듈 인스턴스) — project-map 경로만 EACCES(권위 판독 자체가
  // 죽는 시나리오: statSync·readFileSync·readdirSync 전부 — 어댑터 경로가 blocked(authority-unreadable)로
  // 정직 강등되고 legacy 데이터가 재공급되지 않음을 실행 증명)
  const realStat = fs.statSync.bind(fs), realRead = fs.readFileSync.bind(fs), realDir = fs.readdirSync.bind(fs);
  const denyOn = (orig) => (p, ...a) => { if (String(p).replace(/\\/g, "/").includes("/project-map")) { const e = new Error("denied"); e.code = "EACCES"; throw e; } return orig(p, ...a); };
  const wsU = mkRepo("unrd", { "docs/MAP.md": "# 확정\n- 항목 U\n" });
  scoutOn(wsU);
  const cU = CL.loadContract(wsU, "ko");
  try {
    fs.statSync = denyOn(realStat); fs.readFileSync = denyOn(realRead); fs.readdirSync = denyOn(realDir);
    const SPd = require(path.join(ROOT, "scripts", "scope-package.js"));
    const cc = SPd.collectCommon(wsU);
    ok(cc.mapContent === null && cc.mapContentBlockedKey && /unreadable|trace-unreadable|authority-unreadable|topology-unreadable/.test(cc.mapContentBlockedKey), "꾸러미 수집 — 판독 불가 시 legacy MAP 공급 0+사유 키(실행: " + cc.mapContentBlockedKey + ")");
    ok(typeof cc.mapContentBlockedEn === "string" && !/[가-힣]/.test(cc.mapContentBlockedEn), "꾸러미 영문 번역문 산출(한국어 0)");
    const CB = require(path.join(ROOT, "bridge", "codex-bridge.js"));
    const att = CB.mapAttachSurface(wsU, cU, "ko");
    ok(att && att.mapItems.length === 0 && /판독 불가|동봉하지 않습니다/.test(att.text), "동봉 표면 — 판독 불가 시 legacy 동봉 0·고지(실행)");
  } finally { fs.statSync = realStat; fs.readFileSync = realRead; fs.readdirSync = realDir; }
  const ccOk = require(path.join(ROOT, "scripts", "scope-package.js")).collectCommon(wsU);
  ok(ccOk.mapContent !== null && !ccOk.mapContentBlocked, "복원 후 정상 legacy 판독(주입 격리 확인)");
}

console.log("[13] en 번역문·표 동기화(구현검증 3차 #3·[보완])");
{
  const SP3 = require(path.join(ROOT, "out", "scope-package.js"));
  const RD3 = require(path.join(ROOT, "bridge", "map-reader.js"));
  const enText = RD3.reasonTextFor("history-without-marker", null, true);
  const pkg3 = SP3.buildPackage({ repo: "r", head: "h", seeds: [], diffText: "", tokenHits: [], coChange: null, tests: [], recentFailures: [], mapContent: null, mapContentBlocked: "이력 존재", mapContentBlockedKey: "history-without-marker", mapContentBlockedEn: enText });
  const md3 = SP3.renderPackageMarkdown(pkg3, "en");
  ok(md3.includes(enText) && /cutover history exists/.test(md3), "en 렌더=번역문 출력(키 표기 아님 — 정본 4표면 언어 계약)");
  // 표 동기화: reader 공용 표 키 집합 ⊆ 확장 로컬 표 키 집합(소스 파싱 집합 대조 — [보완])
  const extSrc3 = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  const koTableM = extSrc3.match(/const ko: Record<string, string> = \{([\s\S]*?)\};/);
  const localKeys = new Set([...koTableM[1].matchAll(/"([a-z0-9-]+)":/g)].map((m) => m[1]).concat([...koTableM[1].matchAll(/(?:^|\s)lock:/g)].length ? ["lock"] : []));
  const missing = RD3.REASON_KEYS.filter((k) => !localKeys.has(k));
  ok(missing.length === 0, "확장 로컬 표 ⊇ 공용 표(누락 0 — 집합 대조: " + (missing.join(",") || "완전") + ")");
}

console.log("[14] require 실패 로컬 폴백 실행(구현검증 4차 #2 — 어댑터 파일이 빠진 사본 트리·실 자식 프로세스)");
{
  // 낡은 배포를 재현: bridge 사본에서 map-adapters.js·map-reader.js를 '빠뜨린' 트리 — 소비처의 lazy require가
  // 실제로 실패해 로컬 3상태 폴백 분기가 실행된다(모킹 아님 — 부분 배포 실물 재현).
  const stale = path.join(dir, "stale-tree");
  fs.mkdirSync(path.join(stale, "bridge"), { recursive: true });
  fs.mkdirSync(path.join(stale, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(stale, "out"), { recursive: true });
  for (const f of ["contract-lib.js", "codex-bridge.js"]) fs.copyFileSync(path.join(ROOT, "bridge", f), path.join(stale, "bridge", f));
  fs.copyFileSync(path.join(ROOT, "scripts", "scope-package.js"), path.join(stale, "scripts", "scope-package.js"));
  for (const f of ["scope-package.js", "scope-ledger.js", "ledger-events.js"]) fs.copyFileSync(path.join(ROOT, "out", f), path.join(stale, "out", f));
  const traced = mkRepo("staletr", { "docs/MAP.md": "# 확정\n- 항목 S\n" });
  markTrace(traced); // 전환 흔적 present
  const plain = mkRepo("staleab", { "docs/MAP.md": "# 확정\n- 항목 P\n" });
  // 비어 있지 않은 legacy 정찰 지도 픽스처(구현검증 6차 #1 — null끼리 비교는 무회귀 증명이 아님):
  // scout-attach.test 정본형과 동일 골격 — buildScoutAttach가 실제 동봉 블록을 생성하는 상태에서 위임 대조.
  {
    const mapsDirP = path.join(dir, "scouts", CL.wsKeyFor(plain));
    fs.mkdirSync(mapsDirP, { recursive: true });
    const baseP = "2026-07-07T00-00-00-000Z-00-self";
    fs.writeFileSync(path.join(mapsDirP, baseP + ".md"), "# 영향범위 지도\n① 직접 영향 후보\n- src/p.js — 대상 (high)\n", "utf8");
    fs.writeFileSync(path.join(mapsDirP, baseP + ".json"), JSON.stringify({ ts: "2026-07-07T00:00:00.000Z", arm: "self", seedFiles: [] }), "utf8");
  }
  const childSrc = `
    const fs = require("fs");
    const path = require("path");
    const SP = require(path.join(${JSON.stringify(stale)}, "scripts", "scope-package.js"));
    const CB = require(path.join(${JSON.stringify(stale)}, "bridge", "codex-bridge.js"));
    const CLc = require(path.join(${JSON.stringify(stale)}, "bridge", "contract-lib.js"));
    const ccT = SP.collectCommon(${JSON.stringify(traced)});
    const ccP = SP.collectCommon(${JSON.stringify(plain)});
    const att = CB.mapAttachSurface(${JSON.stringify(traced)}, { scoutMode: "on" }, "ko");
    const attP = CB.mapAttachSurface(${JSON.stringify(plain)}, { scoutMode: "on" }, "ko");
    const direct = CLc.buildScoutAttach(${JSON.stringify(plain)}, { scoutMode: "on" }, "ko");
    // unreadable 분기(구현검증 5차 #1): 로컬 판독기(statSync·readdirSync)만 project-map 경로 EACCES —
    // 부재(ENOENT)가 아닌 판독 오류가 absent로 축소되지 않고 legacy 공급이 차단되는지 '사본 폴백에서' 실행.
    const realStat = fs.statSync.bind(fs), realDir = fs.readdirSync.bind(fs);
    const deny = (orig) => (p, ...a) => { if (String(p).replace(/\\\\/g, "/").includes("/project-map")) { const e = new Error("denied"); e.code = "EACCES"; throw e; } return orig(p, ...a); };
    fs.statSync = deny(realStat); fs.readdirSync = deny(realDir);
    const ccU = SP.collectCommon(${JSON.stringify(plain)});
    const attU = CB.mapAttachSurface(${JSON.stringify(plain)}, { scoutMode: "on" }, "ko");
    fs.statSync = realStat; fs.readdirSync = realDir;
    console.log(JSON.stringify({
      tKey: ccT.mapContentBlockedKey, tContent: ccT.mapContent,
      pContent: typeof ccP.mapContent === "string",
      attText: att && att.text, attItems: att && att.mapItems.length,
      attPSame: JSON.stringify(attP) === JSON.stringify(direct),
      attPNonEmpty: !!(attP && typeof attP.text === "string" && attP.text.includes("src/p.js")),
      uKey: ccU.mapContentBlockedKey, uContent: ccU.mapContent,
      uAttText: attU && attU.text, uAttItems: attU ? attU.mapItems.length : -1,
    }));
  `;
  const rc = cp.spawnSync(process.execPath, ["-e", childSrc], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir }, timeout: 30000, windowsHide: true });
  let out14 = null;
  try { out14 = JSON.parse((rc.stdout || "").trim().split(/\r?\n/).pop()); } catch { out14 = null; }
  ok(rc.status === 0 && !!out14, "사본 트리 자식 프로세스 실행 성공(어댑터 부재 require 실패 실물)");
  if (out14) {
    ok(out14.tKey === "runtime-outdated" && out14.tContent === null, "꾸러미 폴백 — 전환 흔적 present+런타임 부재=legacy MAP 공급 0+runtime-outdated(실행)");
    ok(out14.pContent === true, "흔적 absent=기존 legacy 판독 유지(무회귀 실행)");
    ok(typeof out14.attText === "string" && /MAP 런타임이 낡음|낡음/.test(out14.attText) && out14.attItems === 0, "동봉 폴백 — 흔적 present=고지·legacy 동봉 0(실행)");
    ok(out14.attPSame === true && out14.attPNonEmpty === true, "동봉 폴백 — 흔적 absent=기존 buildScoutAttach 위임(비어 있지 않은 동봉 바이트 동일 실행 — 6차 #1: null끼리 비교 아님)");
    ok(out14.uKey === "trace-unreadable" && out14.uContent === null, "꾸러미 폴백 — EACCES=unreadable(absent 축소 금지)·legacy MAP 공급 0(실행)");
    ok(typeof out14.uAttText === "string" && /판독 불가/.test(out14.uAttText) && out14.uAttItems === 0, "동봉 폴백 — EACCES=고지·legacy 동봉 0(실행)");
  }
}

console.log("[15] en 산출물 전체에 blocked 한국어 원문 재노출 0(구현검증 4차 #1)");
{
  const SP4 = require(path.join(ROOT, "out", "scope-package.js"));
  const RD4 = require(path.join(ROOT, "bridge", "map-reader.js"));
  const koReason = "권위상태이상 한국어원문 지문";
  const pkg4 = SP4.buildPackage({ repo: "r", head: "h", seeds: [], diffText: "", tokenHits: [], coChange: null, tests: [], recentFailures: [], mapContent: null, mapContentBlocked: koReason, mapContentBlockedKey: "history-without-marker", mapContentBlockedEn: RD4.reasonTextFor("history-without-marker", null, true) });
  const md4 = SP4.renderPackageMarkdown(pkg4, "en");
  ok(!md4.includes(koReason), "en 렌더 전체에서 blocked 한국어 원문 0(§7뿐 아니라 blindSpots 포함 — 사유는 키·번역문만)");
  ok(md4.includes("history-without-marker") && /cutover history exists/.test(md4), "키·번역문은 존재(정보 소실 아님)");
  const mdKo4 = SP4.renderPackageMarkdown(pkg4, "ko");
  ok(mdKo4.includes(koReason), "ko 렌더는 원문 유지(§7 — 무회귀)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
