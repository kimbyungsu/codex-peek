"use strict";
/*
 * P4 증분 2 — freshness 재료 저장소(mfresh-1)+P2 apply/복구 기준선 기록 훅(설계 동결 v8 P4-2·P4-3ⓐ).
 * 2차 판정 반영: 판독 무파괴(삭제는 잠금 안 쓰기만)·완료 순서 역전 가드(seenAt 단조)·missing sentinel도
 * 기준선(부재도 CAS 검증 상태 — 이후 생성=stale 감지)·v3 WAL 복구 실행 반례·2트랙 실경로 실행·
 * symlink 안전 판독(lstat+O_NOFOLLOW)·ISO/유한수 검증.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p4fresh_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const MF = require(path.join(ROOT, "bridge", "map-freshness.js"));
const MP = require(path.join(ROOT, "bridge", "map-pipeline.js"));
const MB = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");
const FP = "a".repeat(40);
const NOW = "2026-07-19T00:00:00.000Z";
const LATER = "2026-07-19T01:00:00.000Z";

function mkWs(tag, files) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  for (const [rel, txt] of Object.entries(files || {})) fs.writeFileSync(path.join(ws, rel), txt);
  fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  if (MR.initTopologyForBootstrap(ws).st !== "created") throw new Error("init 실패");
  return ws;
}
function mkLive(ws, op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const base = {
    schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId,
    basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo),
    baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh),
    baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "test", evidence: [{ kind: "code", ref: "src/a.js" }],
    ...fields,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  base.readSet = MP.buildReadSetFor(topo, base, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
  return { patch: base, topo };
}
function applyLive(ws, patch) {
  MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
  return MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
}

console.log("[1] 합타입 — a:/e: 키·entry 검증(역할 분리·ISO·유한수)");
{
  ok(MF.parseEntryKey("a:" + U(1) + "|src/a.js").kind === "a", "a: 키 파싱");
  ok(MF.parseEntryKey("e:" + U(1) + "|docs/x.md").kind === "e", "e: 키 파싱");
  ok(MF.parseEntryKey("x:" + U(1) + "|src/a.js") === null, "미지 kind 거부");
  ok(MF.parseEntryKey("a:not-uuid|src/a.js") === null, "비UUID entity 거부");
  ok(MF.parseEntryKey("a:" + U(1) + "|") === null, "빈 rel 거부");
  ok(MF.parseEntryKey("a:" + U(1) + "|src" + String.fromCharCode(0) + ".js") === null, "NUL 포함 키 거부");
  const aKey = "a:" + U(1) + "|src/a.js", eKey = "e:" + U(1) + "|src/a.js";
  ok(MF.validEntry(aKey, { fp: FP, seenAt: NOW, basisDecisionId: U(9) }) === true, "a: 유효(기준선 — basisDecisionId 결속)");
  ok(MF.validEntry(aKey, { fp: FP, seenAt: NOW }) === false, "a: basisDecisionId 부재=무효(전역 결속 금지)");
  ok(MF.validEntry(eKey, { fp: FP, seenAt: NOW, size: 3, mtimeMs: 1 }) === true, "e: 유효(비권위 캐시)");
  ok(MF.validEntry(eKey, { fp: FP, seenAt: NOW, basisDecisionId: U(9) }) === false, "e: basisDecisionId=무효(캐시가 기준선 흉내 금지)");
  ok(MF.validEntry(aKey, { fp: "short", seenAt: NOW, basisDecisionId: U(9) }) === false, "fp 형식 위반=무효");
  ok(MF.validEntry(aKey, { fp: FP, seenAt: NOW, basisDecisionId: U(9), extra: 1 }) === false, "미지 필드=무효(합타입 닫힘)");
  ok(MF.validEntry(aKey, { fp: FP, seenAt: "not-an-iso", basisDecisionId: U(9) }) === false, "비ISO seenAt=무효(2차 [보완] — 축출 순서 왜곡 차단)");
  ok(MF.validEntry(eKey, { fp: FP, seenAt: NOW, size: Infinity }) === false, "비유한 size=무효(2차 [보완])");
  ok(MF.validEntry(eKey, { fp: FP, seenAt: NOW, mtimeMs: NaN }) === false, "NaN mtimeMs=무효");
  ok(MF.validEntry(aKey, { fp: FP, seenAt: "2026-02-31T00:00:00.000Z", basisDecisionId: U(9) }) === false, "비존재 달력 날짜=무효(3차 [보완] — toISOString 왕복 동등)");
  ok(MF.validEntry(aKey, { fp: FP, seenAt: "2026-07-19T00:00:00Z", basisDecisionId: U(9) }) === false, "밀리초 없는 형태=무효(생산자 규약: toISOString 정확 형태)");
}

console.log("[2] 저장소 IO — 무파괴 판독·merge·가드(a:=권위 전용·e:=시간 단조)·재생성·상한·잠금");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_ws_"));
  const mapId = U(100);
  const aKey = (n, rel) => "a:" + U(n) + "|" + rel;
  const eKey = (n, rel) => "e:" + U(n) + "|" + rel;
  const ent = (seenAt, did) => ({ fp: FP, seenAt: seenAt || NOW, basisDecisionId: did || U(9) });
  const eEnt = (seenAt) => ({ fp: FP, seenAt: seenAt || NOW });
  const SW = { swap: true };
  const w1 = MF.mergeWrite(ws, mapId, { [aKey(1, "src/a.js")]: ent() }, SW);
  ok(w1.ok === true && w1.wrote === 1, "생성 쓰기(권위)");
  const w2 = MF.mergeWrite(ws, mapId, { [aKey(2, "src/b.js")]: ent() }, SW);
  ok(w2.ok === true && Object.keys(MF.readFreshnessFor(ws, mapId).entries).length === 2, "read-merge-write — 기존 키 보존(lost-update 없음)");
  const wBad = MF.mergeWrite(ws, mapId, { [aKey(3, "src/c.js")]: { fp: FP, seenAt: NOW } }, SW);
  ok(wBad.ok === true && wBad.wrote === 0 && wBad.skipped === 1, "무효 entry는 기록하지 않고 skipped 보고");
  // a:=권위 전용(6차 강화): swap 없는 writer의 기준선 쓰기=차단(위조·간섭 차단)
  const wNoAuth = MF.mergeWrite(ws, mapId, { [aKey(8, "src/h.js")]: ent() });
  ok(wNoAuth.ok === true && wNoAuth.wrote === 0 && wNoAuth.skipped === 1, "비권위 writer의 a: 쓰기=skipped(권위 전용)");
  // e: 캐시 — 시간 단조 가드(2차 blocker②의 잔존 적용 범위): 과거 유입=stale, 미래 잔존은 e:만 차단
  ok(MF.mergeWrite(ws, mapId, { [eKey(30, "src/e1.js")]: eEnt(LATER) }).wrote === 1, "(전제) e: 캐시 기록");
  const weOld = MF.mergeWrite(ws, mapId, { [eKey(30, "src/e1.js")]: eEnt(NOW) });
  ok(weOld.ok === true && weOld.stale === 1 && MF.readFreshnessFor(ws, mapId).entries[eKey(30, "src/e1.js")].seenAt === LATER, "e: 늦은 과거 캐시=stale(최신 유지)");
  // a: — 권위가 항상 이긴다(5차 blocker②): 미래 seenAt 잔존이 있어도 권위 기준선이 덮어씀
  ok(MF.mergeWrite(ws, mapId, { [aKey(1, "src/a.js")]: ent("2027-01-01T00:00:00.000Z", U(20)) }, SW).wrote === 1, "(전제) 미래 seenAt 기준선 잔존 구성");
  const wAuth = MF.mergeWrite(ws, mapId, { [aKey(1, "src/a.js")]: ent(NOW, U(21)) }, SW);
  const curA = MF.readFreshnessFor(ws, mapId).entries[aKey(1, "src/a.js")];
  ok(wAuth.ok === true && wAuth.wrote === 1 && curA.basisDecisionId === U(21), "a: 권위 쓰기=시간 가드 비적용·항상 갱신(미래 seenAt 영구 차단 경로 제거 — 순서는 정본 잠금 직렬화가 보장)");
  // 무파괴 판독(2차 blocker①)
  const f = MF.freshnessFileFor(ws);
  fs.writeFileSync(f, "{corrupt", "utf8");
  ok(MF.readFreshnessFor(ws, mapId).st === "corrupt" && fs.existsSync(f), "손상=corrupt 보고·판독은 파일을 삭제하지 않음(무파괴)");
  const wRe = MF.mergeWrite(ws, mapId, { [aKey(1, "src/a.js")]: ent() }, SW);
  ok(wRe.ok === true && MF.readFreshnessFor(ws, mapId).st === "ok", "재생성은 잠금 안 쓰기가 수행(fail-open 실현)");
  ok(MF.readFreshnessFor(ws, U(101)).st === "discarded" && fs.existsSync(f), "mapId 불일치=discarded 보고·파일 보존(판독 무파괴)");
  // 세대 안전 불변식(3차 blocker①)
  const wGen = MF.mergeWrite(ws, U(101), { [eKey(50, "src/x.js")]: eEnt() });
  ok(wGen.ok === false && wGen.reason === "generation", "구세대(비권위) writer=거부(늦은 캐시가 신세대 기준선을 되돌리는 반례 차단)");
  ok(MF.readFreshnessFor(ws, mapId).st === "ok", "거부 후 기존 세대 무손상");
  const wNewMap = MF.mergeWrite(ws, U(101), { [aKey(5, "src/e.js")]: ent() }, SW);
  const afterSwap = MF.readFreshnessFor(ws, U(101));
  ok(wNewMap.ok === true && afterSwap.st === "ok" && Object.keys(afterSwap.entries).length === 1, "세대 교체는 권위(swap — 정본 잠금 안 기준선 기록자)만: 전체 폐기 실현");
  { const wBack = MF.mergeWrite(ws, mapId, { [aKey(1, "src/a.js")]: ent() });
    ok(wBack.ok === false && wBack.reason === "generation" && MF.readFreshnessFor(ws, U(101)).st === "ok", "신세대 확정 후 구세대 쓰기=거부·신세대 보존"); }
  { const back = MF.mergeWrite(ws, mapId, { [aKey(1, "src/a.js")]: ent(LATER, U(21)) }, SW);
    ok(back.ok === true, "(전제) 원 세대 복귀"); }
  // 개별 무효 entry 드랍(fail-open)
  fs.writeFileSync(f, JSON.stringify({ schema: "mfresh-1", mapId, entries: { [aKey(1, "src/a.js")]: ent(), [aKey(2, "src/b.js")]: { fp: "bad" } } }), "utf8");
  ok(Object.keys(MF.readFreshnessFor(ws, mapId).entries).length === 1, "무효 entry 개별 드랍(유효분 보존)");
  // 상한 축출
  const big = {};
  for (let i = 0; i < MF.ENTRY_CAP + 5; i++) big["a:" + crypto.randomUUID() + "|f" + i + ".js"] = { fp: FP, seenAt: i < 5 ? "2020-01-01T00:00:00.000Z" : NOW, basisDecisionId: U(9) };
  const wCap = MF.mergeWrite(ws, mapId, big, SW);
  const after = MF.readFreshnessFor(ws, mapId).entries;
  ok(wCap.ok === true && Object.keys(after).length === MF.ENTRY_CAP, "상한 " + MF.ENTRY_CAP + " 유지");
  ok(!Object.values(after).some((v) => v.seenAt === "2020-01-01T00:00:00.000Z"), "오래된 seenAt부터 축출");
  // 잠금 실패=쓰기 포기
  const lockFile = f + ".lock";
  fs.writeFileSync(lockFile, process.pid + "-held", { flag: "wx" });
  const wLock = MF.mergeWrite(ws, mapId, { [aKey(4, "src/d.js")]: ent() }, SW);
  fs.unlinkSync(lockFile);
  ok(wLock.ok === false && wLock.reason === "lock", "잠금 실패=쓰기 포기(ok:false·reason=lock)");
  ok(!(aKey(4, "src/d.js") in MF.readFreshnessFor(ws, mapId).entries), "포기 시 부분 기록 없음");
  { fs.writeFileSync(lockFile, process.pid + "-held", { flag: "wx" });
    const t0 = Date.now();
    const wq = MF.mergeWrite(ws, mapId, { [aKey(7, "src/g.js")]: ent() }, { swap: true, tries: 3 });
    const dt = Date.now() - t0;
    fs.unlinkSync(lockFile);
    ok(wq.ok === false && wq.reason === "lock" && dt < 400, "tries=3 빠른 포기(" + dt + "ms<400)"); }
}

console.log("[3] 경로 경계+안전 판독 — safeRepoPathFor·readRepoFileSafe");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_repo_"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.js"), "x");
  ok(MF.safeRepoPathFor(repo, "src/a.js").ok === true, "정상 상대경로 허용");
  ok(MF.safeRepoPathFor(repo, "src/no yet.js").ok === true, "공백 포함 미존재 경로 — 경계 내면 허용(부모 기준)");
  ok(MF.safeRepoPathFor(repo, "../out.js").ok === false, "../ 이탈 거부");
  ok(MF.safeRepoPathFor(repo, "src/../../out.js").ok === false, "중간 .. 이탈 거부");
  ok(MF.safeRepoPathFor(repo, "C:/win/abs.js").ok === false, "드라이브 절대경로 거부");
  ok(MF.safeRepoPathFor(repo, "/posix/abs.js").ok === false, "posix 절대경로 거부");
  ok(MF.safeRepoPathFor(repo, "\\\\server\\share\\x").ok === false, "UNC 거부");
  ok(MF.safeRepoPathFor(repo, "src/a" + String.fromCharCode(0) + ".js").ok === false, "NUL 거부");
  ok(MF.safeRepoPathFor(repo, "").ok === false && MF.safeRepoPathFor(repo, null).ok === false, "빈 값·비문자열 거부");
  const rd = MF.readRepoFileSafe(repo, "src/a.js");
  ok(rd.ok === true && rd.buf.toString() === "x" && rd.size === 1, "안전 판독 — 정상 파일 내용+stat");
  ok(MF.readRepoFileSafe(repo, "src/none.js").ok === false && MF.readRepoFileSafe(repo, "src/none.js").reason === "absent", "부재=absent");
  ok(MF.readRepoFileSafe(repo, "src").ok === false && MF.readRepoFileSafe(repo, "src").reason === "not-file", "디렉터리=not-file");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_out_"));
  fs.writeFileSync(path.join(outside, "secret.js"), "s");
  let linked = false;
  try { fs.symlinkSync(path.join(outside, "secret.js"), path.join(repo, "src", "link.js"), "file"); linked = true; } catch { /* 권한 없음 — skip */ }
  if (linked) {
    ok(MF.safeRepoPathFor(repo, "src/link.js").ok === false, "symlink 이탈 거부(realpath 검증)");
    ok(MF.readRepoFileSafe(repo, "src/link.js").ok === false, "안전 판독 — symlink 거부([주의] 봉합: lstat+O_NOFOLLOW·실파일만)");
    // 경계 내부를 가리키는 symlink도 거부(정책: anchor/evidence=실파일만 — 검사↔판독 사이 교체 창 자체를 제거)
    try { fs.symlinkSync(path.join(repo, "src", "a.js"), path.join(repo, "src", "inlink.js"), "file");
      ok(MF.readRepoFileSafe(repo, "src/inlink.js").ok === false && MF.readRepoFileSafe(repo, "src/inlink.js").reason === "symlink", "경계 내부 symlink도 실파일 아님=거부(TOCTOU 창 제거)");
    } catch { /* 무해 */ }
  } else console.log("  (skip) symlink 생성 권한 없음 — 이탈 반례는 CI(unix)에서 검증");
}

console.log("[4] apply 기준선 훅 e2e — CAS 지문 복사·결속·무관 불변·sentinel 포함");
{
  const ws = mkWs("e2e", { "src/a.js": "console.log(1);\n", "src/b.js": "// b\n" });
  const topo0 = MR.readTopoExFor(ws).topo;
  const nid = topo0.nodes[0].id;
  const { patch: p1 } = mkLive(ws, "add_condition", { targetId: nid, payload: { condition: "base-1" } });
  const ap1 = applyLive(ws, p1);
  ok(ap1.ok === true, "(전제) 적용 성공: " + (ap1.error || ""));
  ok(ap1.freshnessBaseline && ap1.freshnessBaseline.ok === true && ap1.freshnessBaseline.wrote >= 1, "apply 결과에 기준선 기록 영수증");
  const st1 = MF.readFreshnessFor(ws, topo0.mapId);
  const key1 = "a:" + nid + "|src/a.js";
  ok(st1.st === "ok" && !!st1.entries[key1], "a:<node>|<anchor> 기준선 생성");
  const rsFp = (p1.readSet.files || []).find((f) => f.ref === "src/a.js").contentHash;
  ok(st1.entries[key1].fp === rsFp, "기준선 fp=CAS가 검증한 read-set 지문 그대로(복사 — 재해시 아님)");
  ok(st1.entries[key1].basisDecisionId === ap1.decisionId, "basisDecisionId=이 전이의 decisionId 결속");
  // 무관 decision이 타 node 기준선 불변
  const before1 = JSON.stringify(st1.entries[key1]);
  const nb = crypto.randomUUID();
  const nodeB = { id: nb, entityType: "module", label: "B", roles: [], anchors: [{ kind: "code", path: "src/b.js" }], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } };
  const { patch: p2 } = mkLive(ws, "add_node", { payload: { node: nodeB } });
  const ap2 = applyLive(ws, p2);
  ok(ap2.ok === true, "(전제) add_node 적용: " + (ap2.error || ""));
  const st2 = MF.readFreshnessFor(ws, topo0.mapId);
  { const b1 = JSON.parse(before1), c1 = st2.entries[key1]; // seenAt은 LRU 감사 touch로 갱신될 수 있음(9차) — 결속·지문 불변이 계약
    ok(c1 && c1.fp === b1.fp && c1.basisDecisionId === b1.basisDecisionId, "무관 decision — 타 node 기준선의 지문·결속 불변(decision 결속 증명·seenAt touch는 LRU 전진용)"); }
  ok(!!st2.entries["a:" + nb + "|src/b.js"] && st2.entries["a:" + nb + "|src/b.js"].basisDecisionId === ap2.decisionId, "생성 node의 anchor도 기준선(add 계열 포함)");
  // missing sentinel도 기준선(2차 blocker③): 부재 anchor를 가진 node 추가 — sentinel 지문이 기준선으로 복사
  const ng = crypto.randomUUID();
  const nodeG = { id: ng, entityType: "module", label: "G", roles: [], anchors: [{ kind: "code", path: "src/ghost.js" }], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } };
  const { patch: pg } = mkLive(ws, "add_node", { payload: { node: nodeG } });
  const apg = applyLive(ws, pg);
  ok(apg.ok === true, "(전제) 부재 anchor node 적용: " + (apg.error || ""));
  const stg = MF.readFreshnessFor(ws, topo0.mapId).entries["a:" + ng + "|src/ghost.js"];
  ok(!!stg && stg.fp === sha("__missing__src/ghost.js"), "부재 anchor=missing sentinel 지문이 기준선(이후 파일 생성=불일치 stale 감지 — 2차 blocker③)");
  // CAS 직후 외부 편집 반례
  const { patch: p3 } = mkLive(ws, "add_condition", { targetId: nid, payload: { condition: "tamper" } });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "console.log(2); // tampered\n");
  const ap3 = applyLive(ws, p3);
  ok(ap3.ok === false, "외부 편집 후 apply=거부(CAS): " + (ap3.error || ""));
  ok(MF.readFreshnessFor(ws, topo0.mapId).entries[key1].fp === rsFp, "거부 전이는 기준선을 건드리지 않음(오염 없음)");
}

console.log("[5] baselineUpdatesFor 순수 계약 — 복사·제외 규칙");
{
  const outTopo = {
    nodes: [
      { id: U(1), anchors: [{ kind: "code", path: "src/a.js" }, { kind: "code", path: "src/gone.js" }, { kind: "code", path: "src/unread.js" }] },
      { id: U(2), anchors: [{ kind: "code", path: "src/b.js" }] },
    ],
    edges: [{ id: U(3) }],
  };
  const missingFp = sha("__missing__src/gone.js");
  const patch = { readSet: { files: [
    { ref: "src/a.js", contentHash: FP },
    { ref: "src/gone.js", contentHash: missingFp },
  ] } };
  const up = MP.baselineUpdatesFor(patch, U(9), [U(1), U(3)], outTopo);
  ok(!!up["a:" + U(1) + "|src/a.js"] && up["a:" + U(1) + "|src/a.js"].fp === FP, "read-set 지문 복사(해시 호출 0 — 저장소·훅 모두)");
  ok(!!up["a:" + U(1) + "|src/gone.js"] && up["a:" + U(1) + "|src/gone.js"].fp === missingFp, "missing sentinel 지문도 복사(CAS가 검증한 '부재' 상태 — 2차 blocker③)");
  ok(!("a:" + U(1) + "|src/unread.js" in up), "read-set에 없는 anchor=기준선 미생성(④)");
  ok(!Object.keys(up).some((k) => k.includes(U(2))), "affectedIds 밖 node=미생성(무관 node 차단)");
  ok(!Object.keys(up).some((k) => k.includes(U(3))), "edge=anchor축 N/A(미생성)");
  ok(Object.values(up).every((v) => v.basisDecisionId === U(9)), "전 entry decisionId 결속");
}

console.log("[6] v3 WAL 복구 기준선 — t5 재적용·이미 후상태·잠금 실패(2차 blocker④)");
function mkV3Wal(ws) {
  // 구성: apply가 기록했을 v3 WAL을 그대로 수동 구성(p4-core [7]의 v2 대비 — v3: 주입·structural·affectedIds)
  const topo = MR.readTopoExFor(ws).topo;
  const nid = topo.nodes[0].id;
  const { patch } = mkLive(ws, "add_condition", { targetId: nid, payload: { condition: "v3-era" } });
  const apOld = PM.applyOperationV2(topo, patch);
  if (apOld.errors.length) throw new Error(apOld.errors[0]);
  const outTopo = apOld.topo;
  const did = crypto.randomUUID();
  const verification = { kind: "historyless", basisFp: PM.structuralHashOf(outTopo), inventoryFp: PM.opHashOf(outTopo.inventory) };
  const surviving = new Set([...(outTopo.nodes || []).map((x) => x.id), ...(outTopo.edges || []).map((x) => x.id)]);
  const affectedIds = [...new Set(apOld.changedIds || [])].filter((id) => surviving.has(id)).sort();
  for (const cid of affectedIds) {
    const ent = (outTopo.nodes || []).find((x) => x.id === cid) || (outTopo.edges || []).find((x) => x.id === cid);
    if (ent) ent.provenance = { basis: verification, decisionId: did };
  }
  const before = PM.mapHashOf(topo), after = PM.mapHashOf(outTopo);
  const mdBefore = sha(fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8"));
  const mdAfter = sha(PM.renderMapMd(outTopo));
  const evidenceFps = (patch.evidence || []).map((e) => ({ ref: e.ref, contentHash: sha(fs.readFileSync(path.join(ws, e.ref), "utf8")) })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const decision = {
    schema: "map-decision-v3", decisionId: did, mapId: topo.mapId, patchId: patch.patchId, opHash: PM.opHashOf(patch),
    affectedIds, patch, actor: { kind: "auto" }, classification: "auto",
    resolution: { outcome: "applied", evidenceRef: "auto" }, preCutover: true, verification, evidenceFps,
    audit: { ts: new Date().toISOString(), topologyBeforeHash: before, topologyAfterHash: after, mapMdAfterHash: mdAfter, authorityHashAfter: "", expectedMapHashAfter: after, walRef: "wal/" + did + ".json" },
  };
  const dihAfter = PM.decisionIndexHashOf([PM.adpHashOf(PM.adpOf(decision))]);
  const ahAfter = PM.authorityHashOf(after, dihAfter);
  decision.audit.authorityHashAfter = ahAfter;
  if (PM.validateDecisionAny(decision).length) throw new Error("v3 decision 구성 실패: " + PM.validateDecisionAny(decision)[0]);
  const decisionText = JSON.stringify(decision, null, 1);
  const dfh = sha(decisionText);
  const d = MP.ensureDirs(ws, topo.mapId);
  const snapText = JSON.stringify({ mapId: topo.mapId, decisionId: did, topologyBeforeHash: before, basis: patch.basis, appliedCountAtSnapshot: 0, topology: topo }, null, 1);
  const snapFile = path.join(d.snapshots, did + ".json");
  fs.writeFileSync(snapFile, snapText, "utf8");
  const wal = {
    schema: "map-wal-v2", transactionKind: "topology", localOrigin: MP.localOriginFor(ws),
    patch, patchId: patch.patchId, opHash: decision.opHash, basis: patch.basis, readSet: patch.readSet,
    inverse: { kind: "recovery", ref: snapFile, note: "P2 inverse 재료" },
    decision, expectedDecisionFileAfterHash: dfh,
    baselineDecisionIndexHash: PM.decisionIndexHashOf([]),
    expectedDecisionIndexHashAfter: dihAfter, expectedAuthorityHashAfter: ahAfter,
    expectedMarker: { decisionId: did, decisionFileAfterHash: dfh, policyArtifact: null },
    topologyBeforeHash: before, mapMdBeforeHash: mdBefore, snapshotRef: { path: snapFile, contentHash: sha(snapText) },
    expectedTopologyAfterHash: after, expectedMapMdAfterHash: mdAfter,
  };
  fs.writeFileSync(path.join(d.wal, did + ".json"), JSON.stringify(wal, null, 1), "utf8");
  return { did, nid, patch, outTopo, mapId: topo.mapId };
}
{
  // (a) t5: 적용 전 상태에서 중단 — 재적용+주입+기준선
  const ws = mkWs("v3t5", { "src/a.js": "console.log(1);\n" });
  const w = mkV3Wal(ws);
  const out = MP.recoverWal(ws, w.mapId);
  ok(out.length === 1 && out[0].verdict === "recovered", "t5 — v3 roll-forward 완결: " + JSON.stringify(out));
  const st = MF.readFreshnessFor(ws, w.mapId);
  const key = "a:" + w.nid + "|src/a.js";
  const rsFp = (w.patch.readSet.files || []).find((f) => f.ref === "src/a.js").contentHash;
  ok(st.st === "ok" && !!st.entries[key] && st.entries[key].fp === rsFp, "t5 복구가 기준선 기록(read-set 지문 복사)");
  ok(st.entries[key].basisDecisionId === w.did, "복구 기준선도 decisionId 결속");
  // (b) 이미 후상태(⑥⑦ 완료 후 중단): topology·MAP.md가 이미 교체됨 — t8 경로
  const ws2 = mkWs("v3t8", { "src/a.js": "console.log(1);\n" });
  const w2 = mkV3Wal(ws2);
  const topoText = PM.canonicalSerialize(w2.outTopo);
  fs.writeFileSync(path.join(ws2, "project-map", "topology.json"), topoText, "utf8");
  fs.writeFileSync(path.join(ws2, "project-map", "MAP.md"), PM.renderMapMd(w2.outTopo), "utf8");
  const out2 = MP.recoverWal(ws2, w2.mapId);
  ok(out2.length === 1 && out2[0].verdict === "recovered", "t8(이미 후상태) — 완결: " + JSON.stringify(out2));
  const st2 = MF.readFreshnessFor(ws2, w2.mapId);
  ok(!!st2.entries["a:" + w2.nid + "|src/a.js"] && st2.entries["a:" + w2.nid + "|src/a.js"].basisDecisionId === w2.did, "후상태 복구도 기준선 기록(rt.topo 재료)");
  // (c) freshness 잠금 보유 중 복구 — 복구 결과 불변·기준선만 포기
  const ws3 = mkWs("v3lock", { "src/a.js": "console.log(1);\n" });
  const w3 = mkV3Wal(ws3);
  const lockFile = MF.freshnessFileFor(ws3) + ".lock";
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, process.pid + "-held", { flag: "wx" });
  const out3 = MP.recoverWal(ws3, w3.mapId);
  fs.unlinkSync(lockFile);
  ok(out3.length === 1 && out3[0].verdict === "recovered", "잠금 실패에도 복구 결과 불변(recovered)");
  ok(!(("a:" + w3.nid + "|src/a.js") in MF.readFreshnessFor(ws3, w3.mapId).entries), "기준선만 포기(저장소 미기록 — 축 unknown 유지)");
  // '다음 apply 전이에 재시도'의 실현(3차 blocker②): 실패분이 retry 사이드카에 보관되고 다음 전이가 회수
  ok(fs.existsSync(MF.retryFileFor(ws3)) && Object.keys(MF.peekRetry(ws3, w3.mapId)).length === 1, "실패 기준선=retry 사이드카 보관");
  const { patch: pNext } = mkLive(ws3, "add_condition", { targetId: w3.nid, payload: { condition: "retry-carrier" } });
  const apNext = applyLive(ws3, pNext);
  ok(apNext.ok === true && apNext.freshnessBaseline && apNext.freshnessBaseline.retried === 1, "(전제) 다음 전이가 retry 1건 회수: " + JSON.stringify(apNext.freshnessBaseline || {}));
  const stR = MF.readFreshnessFor(ws3, w3.mapId);
  const entR = stR.entries["a:" + w3.nid + "|src/a.js"];
  ok(!!entR, "회수된 기준선이 저장소에 반영(영구 unknown 경로 소멸)");
  ok(entR.basisDecisionId === apNext.decisionId || entR.basisDecisionId === w3.did, "기준선 결속 유지(최신 전이 우선 — seenAt 단조)");
  ok(!fs.existsSync(MF.retryFileFor(ws3)), "회수 완료 후 retry 사이드카 삭제");
}

console.log("[8] 이중 실패·자가 수리 — 마커 없는 상시 탐지(5차 구조 교체)·대형 배치 무절단");
{
  const ws = mkWs("dual", { "src/a.js": "console.log(1);\n", "src/b.js": "// b\n" });
  const topo0 = MR.readTopoExFor(ws).topo;
  const nid = topo0.nodes[0].id;
  const mainLock = MF.freshnessFileFor(ws) + ".lock";
  const retryLock = MF.retryFileFor(ws) + ".lock";
  fs.mkdirSync(path.dirname(mainLock), { recursive: true });
  fs.writeFileSync(mainLock, process.pid + "-held", { flag: "wx" });
  fs.writeFileSync(retryLock, process.pid + "-held", { flag: "wx" });
  // 전체 recordBaselines 경로 점유 상한: 직접 호출 측정(merge 3회+stash 3회 ≈ 100ms대)
  const t0 = Date.now();
  const rbDirect = MF.recordBaselines(ws, topo0.mapId, { ["a:" + nid + "|src/a.js"]: { fp: FP, seenAt: NOW, basisDecisionId: U(9) } }, {});
  const dt = Date.now() - t0;
  ok(rbDirect.ok === false && rbDirect.stashed === false && dt < 500, "이중 잠금 전체 경로 빠른 포기(" + dt + "ms<500)+정직 영수증(stashed:false)");
  const { patch: p1 } = mkLive(ws, "add_condition", { targetId: nid, payload: { condition: "dual-fail" } });
  const ap1 = applyLive(ws, p1);
  fs.unlinkSync(mainLock); fs.unlinkSync(retryLock);
  ok(ap1.ok === true, "(전제) 이중 잠금에도 apply 성공 불변: " + (ap1.error || ""));
  const fb1 = ap1.freshnessBaseline || {};
  ok(fb1.ok === false && fb1.stashed === false, "이중 실패=본 저장소·사이드카 모두 실패 정직 보고(내구 마커에 의존하지 않음)");
  ok(!(("a:" + nid + "|src/a.js") in MF.readFreshnessFor(ws, topo0.mapId).entries), "(전제) 기준선 미기록 상태");
  // 상시 자가 수리: 다음 전이(무관 node)가 '영구 정본' decisions/에서 소실 기준선을 재유도 — 마커·사이드카 불요
  const nb = crypto.randomUUID();
  const nodeB = { id: nb, entityType: "module", label: "B", roles: [], anchors: [{ kind: "code", path: "src/b.js" }], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } };
  const { patch: p2 } = mkLive(ws, "add_node", { payload: { node: nodeB } });
  const ap2 = applyLive(ws, p2);
  ok(ap2.ok === true && ap2.freshnessBaseline && ap2.freshnessBaseline.ok === true && ap2.freshnessBaseline.repaired >= 1, "(전제) 다음 전이가 자가 수리: " + JSON.stringify(ap2.freshnessBaseline || {}));
  const stD = MF.readFreshnessFor(ws, topo0.mapId);
  const keyD = "a:" + nid + "|src/a.js";
  const rsFp1 = (p1.readSet.files || []).find((f) => f.ref === "src/a.js").contentHash;
  ok(!!stD.entries[keyD] && stD.entries[keyD].fp === rsFp1 && stD.entries[keyD].basisDecisionId === ap1.decisionId, "수리 기준선=원 decision(정본 decisions/)의 readSet 지문+결속(무영수증 소실 경로 소멸)");
  // 탐지의 영속성(5차 blocker② 반례 소멸): 근거가 '마커 상태'가 아니라 '저장소 vs provenance 차이'라
  // 수리 실패가 몇 번이든 다음 시도가 재탐지한다. 원본 부재는 rename으로 구성(decisions/ 손상은 권위
  // 색인을 깨 apply 자체가 fail-closed 거부되므로 — 그 자체가 정합 — 직접 함수 호출로 검증).
  const ws2 = mkWs("persist", { "src/a.js": "console.log(1);\n", "src/b.js": "// b\n" });
  const t2 = MR.readTopoExFor(ws2).topo;
  const nid2 = t2.nodes[0].id;
  fs.mkdirSync(path.dirname(MF.freshnessFileFor(ws2)), { recursive: true });
  fs.writeFileSync(MF.freshnessFileFor(ws2) + ".lock", process.pid + "-held", { flag: "wx" });
  fs.writeFileSync(MF.retryFileFor(ws2) + ".lock", process.pid + "-held", { flag: "wx" });
  const { patch: q1 } = mkLive(ws2, "add_condition", { targetId: nid2, payload: { condition: "lost" } });
  const aq1 = applyLive(ws2, q1);
  fs.unlinkSync(MF.freshnessFileFor(ws2) + ".lock"); fs.unlinkSync(MF.retryFileFor(ws2) + ".lock");
  ok(aq1.ok === true && aq1.freshnessBaseline && aq1.freshnessBaseline.ok === false, "(전제) 기준선 소실 상태 구성");
  const decDir2 = path.join(ws2, "project-map", "decisions");
  const idxMapOf = (w, mid) => { const ix = MP.decisionIndexFor(w, mid); const m = {}; if (ix.st === "ok") for (const pr of ix.projections) m[pr.decisionId] = PM.adpHashOf(pr); return m; };
  const decFile2 = path.join(decDir2, aq1.decisionId + ".json");
  const decRaw = fs.readFileSync(decFile2, "utf8");
  const topoNow = MR.readTopoExFor(ws2).topo;
  const idxM0 = idxMapOf(ws2, t2.mapId); // rename '전'에 캡처한 권위 스냅샷(부재 실험 중 색인 판독 실패 회피)
  fs.renameSync(decFile2, decFile2 + ".away"); // 수리 원본 일시 부재
  ok(Object.keys(MF.repairUpdatesFor(ws2, t2.mapId, topoNow, decDir2, { indexByDecision: idxM0 }).updates).length === 0, "원본 부재=수리 0(검증 없는 성급한 수리 없음)");
  ok(Object.keys(MF.repairUpdatesFor(ws2, t2.mapId, topoNow, decDir2, { indexByDecision: idxM0 }).updates).length === 0, "재시도에도 동일(소모되는 마커 상태 없음 — 근거는 차이 자체)");
  fs.renameSync(decFile2 + ".away", decFile2); // 원본 복원
  const rep3 = MF.repairUpdatesFor(ws2, t2.mapId, topoNow, decDir2, { indexByDecision: idxM0 }).updates;
  ok(Object.keys(rep3).length >= 1 && rep3["a:" + nid2 + "|src/a.js"] && rep3["a:" + nid2 + "|src/a.js"].basisDecisionId === aq1.decisionId, "복원 후 재탐지·수리 재유도(영속성)");
  // 실제 파이프라인 경유로도 최종 복원: 다음 정상 전이가 수리 반영
  const nb3 = crypto.randomUUID();
  const { patch: q3 } = mkLive(ws2, "add_node", { payload: { node: { id: nb3, entityType: "module", label: "B3", roles: [], anchors: [{ kind: "code", path: "src/b.js" }], state: { lifecycle: "active", confidence: "candidate", implementation: "runtime" } } } });
  const aq3 = applyLive(ws2, q3);
  ok(aq3.ok === true && aq3.freshnessBaseline.repaired >= 1 && !!MF.readFreshnessFor(ws2, t2.mapId).entries["a:" + nid2 + "|src/a.js"], "다음 전이가 소실 기준선 최종 복원: " + JSON.stringify(aq3.freshnessBaseline || {}));
  // 신뢰 경계(5차 blocker③): readSet 지문 변조=opHash 결속 위반 → validateDecisionAny 거부 → 수리 거부
  const tampered = JSON.parse(decRaw);
  tampered.patch.readSet.files = tampered.patch.readSet.files.map((x) => (x.ref === "src/a.js" ? { ...x, contentHash: "f".repeat(40) } : x));
  ok(PM.validateDecisionAny(tampered).some((e) => e.includes("opHash")), "(전제) 변조 decision=전체 검증기 거부(opHash가 canonical patch 전체[readSet 포함] 결속)");
  const wsT = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_tamper_")); // 빈 저장소(entries 0) — 수리 후보가 되도록
  const topoT = { nodes: [{ id: nid2, provenance: topoNow.nodes.find((n) => n.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] }] };
  fs.writeFileSync(decFile2, JSON.stringify(tampered, null, 1), "utf8");
  ok(Object.keys(MF.repairUpdatesFor(wsT, t2.mapId, topoT, decDir2, { indexByDecision: idxM0 }).updates).length === 0, "변조된 decision=수리 원본 불인정(검증되지 않은 기준선 생성 없음)");
  fs.writeFileSync(decFile2, decRaw, "utf8");
  ok(Object.keys(MF.repairUpdatesFor(wsT, t2.mapId, topoT, decDir2, { indexByDecision: idxM0 }).updates).length === 1, "(대조) 원본 복원=수리 승인 — 차단 사유가 정확히 검증기였음");
  // 5차 blocker③: '자체 유효'하게 위조된 decision(readSet fp 변조+opHash 재계산 — 로컬 검사 전부 통과)도
  // 권위 색인 스냅샷의 ADP 지문 불일치로 거부. 자기 지문을 스냅샷으로 주면 통과(대조 — 차단 축이 정확히 결속).
  const forged = JSON.parse(decRaw);
  forged.patch.readSet.files = forged.patch.readSet.files.map((x) => (x.ref === "src/a.js" ? { ...x, contentHash: "e".repeat(40) } : x));
  forged.opHash = PM.opHashOf(forged.patch);
  ok(PM.validateDecisionAny(forged).length === 0, "(전제) opHash 재계산 위조=로컬 검증기 전체 통과(자체 유효)");
  fs.writeFileSync(decFile2, JSON.stringify(forged, null, 1), "utf8");
  ok(Object.keys(MF.repairUpdatesFor(wsT, t2.mapId, topoT, decDir2, { indexByDecision: idxM0 }).updates).length === 0, "자체 유효 위조=권위 스냅샷 ADP 지문 불일치로 거부(5차 blocker③)");
  const idxForged = { [aq1.decisionId]: PM.adpHashOf(PM.adpOf(forged)) };
  ok(Object.keys(MF.repairUpdatesFor(wsT, t2.mapId, topoT, decDir2, { indexByDecision: idxForged }).updates).length === 1, "(대조) 위조 지문을 스냅샷으로 주면 통과 — 차단 축=색인 결속 그 자체");
  fs.writeFileSync(decFile2, decRaw, "utf8");
  // 5차 blocker①: 같은 D·손상 fp — 완전 일치가 아니면 수리 대상(거짓 fresh 재료 차단)
  const wsF = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_fp_"));
  const goodFp = JSON.parse(decRaw).patch.readSet.files.find((x) => x.ref === "src/a.js").contentHash;
  MF.mergeWrite(wsF, t2.mapId, { ["a:" + nid2 + "|src/a.js"]: { fp: "9".repeat(40), seenAt: NOW, basisDecisionId: aq1.decisionId } }, { swap: true });
  const repFp = MF.repairUpdatesFor(wsF, t2.mapId, topoT, decDir2, { indexByDecision: idxM0 }).updates;
  ok(!!repFp["a:" + nid2 + "|src/a.js"] && repFp["a:" + nid2 + "|src/a.js"].fp === goodFp, "같은 decisionId·손상 fp=수리 대상(fp까지 decision readSet과 대조 — 5차 blocker①)");
  // 8차 blocker: 수리 불능 명백 후보 backlog가 예산을 독식해도 감사(fp 대조) 단계는 예약 슬롯으로 실행
  {
    const starve = [];
    for (let i = 0; i < 25; i++) starve.push({ id: crypto.randomUUID(), provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: crypto.randomUUID() }, anchors: [{ kind: "code", path: "src/s" + i + ".js" }] });
    const stIdx = { ...idxM0 }; for (const nd of starve) stIdx[nd.provenance.decisionId] = "0".repeat(40);
    const audNode = { id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] };
    // wsF 저장소에는 nid2가 D1 결속·손상 fp로 존재(위에서 구성) → '감사' 단계 대상
    const rpSt = MF.repairUpdatesFor(wsF, t2.mapId, { revision: 3, nodes: [...starve, audNode] }, decDir2, { indexByDecision: stIdx, budget: 25 });
    ok(!!rpSt.updates["a:" + nid2 + "|src/a.js"] && rpSt.updates["a:" + nid2 + "|src/a.js"].fp === goodFp, "후보 25 독식 상황에도 감사 예약 슬롯이 손상 fp 수리(기아 소멸): reads=" + rpSt.reads);
    ok(rpSt.budgetHit === true && rpSt.reads <= 25, "예산 총량 준수+budgetHit 보고");
  }
  // 9차 blocker: 동적으로 커지는 감사 집합 — LRU(최고령 seenAt 우선+방문 touch)라 삽입이 앞 순번을 못 민다.
  // 구성: 손상 fp 대상 1(감사·seenAt 중간 순위) + 검증 불능 감사 12(더 오래된 seenAt — touch로 뒤로 밀림) +
  // 매 전이 새 감사 노드 삽입(seenAt=now → 항상 후미). budget=3 → 유한 전이 내 대상 감사·수리 보장.
  {
    const wsL = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_lru_"));
    const mkT = (i) => "2026-07-01T00:00:" + String(i).padStart(2, "0") + ".000Z";
    const lruNodes = [];
    const lruIdx = { ...idxM0 };
    const seed = {};
    for (let i = 0; i < 12; i++) { // 검증 불능 감사(미존재 decision) — 대상보다 오래된 seenAt
      const id = crypto.randomUUID(), did = crypto.randomUUID();
      lruNodes.push({ id, provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: did }, anchors: [{ kind: "code", path: "src/l" + i + ".js" }] });
      lruIdx[did] = "0".repeat(40);
      seed["a:" + id + "|src/l" + i + ".js"] = { fp: FP, seenAt: mkT(i), basisDecisionId: did };
    }
    const target = { id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] };
    seed["a:" + nid2 + "|src/a.js"] = { fp: "9".repeat(40), seenAt: mkT(30), basisDecisionId: aq1.decisionId }; // 손상 fp·13번째 순위
    ok(MF.mergeWrite(wsL, t2.mapId, seed, { swap: true }).ok === true, "(전제) LRU 시나리오 저장소 구성");
    lruNodes.push(target);
    let repairedAt = -1;
    for (let call = 0; call < 8 && repairedAt < 0; call++) {
      // 삽입 공격: 매 전이 새 감사 노드(결속 entry seenAt=now — LRU 후미 합류)
      const nid9 = crypto.randomUUID(), did9 = crypto.randomUUID();
      lruNodes.push({ id: nid9, provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: did9 }, anchors: [{ kind: "code", path: "src/ins" + call + ".js" }] });
      lruIdx[did9] = "0".repeat(40);
      MF.mergeWrite(wsL, t2.mapId, { ["a:" + nid9 + "|src/ins" + call + ".js"]: { fp: FP, seenAt: new Date().toISOString(), basisDecisionId: did9 } }, { swap: true });
      const rb = MF.recordBaselines(wsL, t2.mapId, {}, { topo: { revision: call + 1, nodes: lruNodes }, decisionsDir: decDir2, indexByDecision: lruIdx, repairBudget: 3 });
      if (rb.ok && MF.readFreshnessFor(wsL, t2.mapId).entries["a:" + nid2 + "|src/a.js"] && MF.readFreshnessFor(wsL, t2.mapId).entries["a:" + nid2 + "|src/a.js"].fp === goodFp) repairedAt = call;
    }
    ok(repairedAt >= 0 && repairedAt <= 6, "LRU 감사 — 삽입 공격 중에도 유한 전이 내 손상 fp 수리(9차 고착 반례 소멸): call=" + repairedAt);
  }
  // 10차 blocker①: 벽시계 역행 — 저장소 seenAt이 전부 미래(2030)여도 touch가 max+1ms로 후미 이동해 LRU 전진
  {
    const wsK = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_clock_"));
    const idA = crypto.randomUUID(), didA = crypto.randomUUID();
    const nodes = [
      { id: idA, provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: didA }, anchors: [{ kind: "code", path: "src/k0.js" }] },
      { id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] },
    ];
    const kIdx = { ...idxM0, [didA]: "0".repeat(40) };
    MF.mergeWrite(wsK, t2.mapId, {
      ["a:" + idA + "|src/k0.js"]: { fp: FP, seenAt: "2030-01-01T00:00:00.000Z", basisDecisionId: didA }, // 검증 불능·최고령(미래)
      ["a:" + nid2 + "|src/a.js"]: { fp: "9".repeat(40), seenAt: "2030-01-02T00:00:00.000Z", basisDecisionId: aq1.decisionId }, // 손상 대상(그 다음)
    }, { swap: true });
    let hitAt = -1;
    for (let call = 0; call < 4 && hitAt < 0; call++) {
      MF.recordBaselines(wsK, t2.mapId, {}, { topo: { revision: call + 1, nodes }, decisionsDir: decDir2, indexByDecision: kIdx, repairBudget: 1 });
      const e = MF.readFreshnessFor(wsK, t2.mapId).entries["a:" + nid2 + "|src/a.js"];
      if (e && e.fp === goodFp) hitAt = call;
    }
    ok(hitAt >= 0, "시계 역행(현재<seenAt)에도 단조 touch로 LRU 전진 — 손상 fp 유한 수리(10차 blocker① 소멸): call=" + hitAt);
  }
  // 10차 blocker②: decision 일시 판독 실패 중의 touch가 내구 retry의 검증된 수리값을 덮지 못한다
  {
    const wsV = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_tr_"));
    const kV = "a:" + nid2 + "|src/a.js";
    MF.mergeWrite(wsV, t2.mapId, { [kV]: { fp: "9".repeat(40), seenAt: "2026-07-01T00:00:01.000Z", basisDecisionId: aq1.decisionId } }, { swap: true }); // 손상 store
    MF.stashRetry(wsV, t2.mapId, { [kV]: { fp: goodFp, seenAt: "2026-07-01T00:00:02.000Z", basisDecisionId: aq1.decisionId } }); // 검증된 수리값이 retry에 대기
    fs.renameSync(decFile2, decFile2 + ".away"); // decision 일시 판독 실패 → repair 없음·touch만 생성되는 조건
    const rbV = MF.recordBaselines(wsV, t2.mapId, {}, { topo: { revision: 1, nodes: [{ id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] }] }, decisionsDir: decDir2, indexByDecision: idxM0 });
    fs.renameSync(decFile2 + ".away", decFile2);
    const eV = MF.readFreshnessFor(wsV, t2.mapId).entries[kV];
    ok(rbV.ok === true && eV && eV.fp === goodFp, "touch<retry 우선순위 — 검증된 retry 수리값이 최종(10차 blocker② 소멸): " + JSON.stringify(eV || {}));
  }
  // 11차 blocker①: 미래 e: 캐시(2030)+벽시계(2026) 새 기준선 혼합 — 순서가 seq(논리 순번)라 시각 혼합과 무관
  {
    const wsM = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_mix_"));
    MF.mergeWrite(wsM, t2.mapId, { ["e:" + U(80) + "|src/e9.js"]: { fp: FP, seenAt: "2030-01-01T00:00:00.000Z" } }); // 미래 e: 캐시
    const mixNodes = [{ id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] }];
    MF.mergeWrite(wsM, t2.mapId, { ["a:" + nid2 + "|src/a.js"]: { fp: "9".repeat(40), seenAt: "2027-01-01T00:00:00.000Z", basisDecisionId: aq1.decisionId } }, { swap: true }); // 손상 대상(seq 1)
    const mixIdx = { ...idxM0 };
    let mixHit = -1;
    for (let call = 0; call < 6 && mixHit < 0; call++) {
      // 매 전이 새 정상 기준선(벽시계 2026 seenAt) 추가 — seq는 저장소가 후미 스탬프하므로 선두를 못 뺏음
      const idN = crypto.randomUUID(), didN = crypto.randomUUID();
      mixNodes.push({ id: idN, provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: didN }, anchors: [{ kind: "code", path: "src/mx" + call + ".js" }] });
      mixIdx[didN] = "0".repeat(40);
      MF.mergeWrite(wsM, t2.mapId, { ["a:" + idN + "|src/mx" + call + ".js"]: { fp: FP, seenAt: new Date().toISOString(), basisDecisionId: didN } }, { swap: true });
      MF.recordBaselines(wsM, t2.mapId, {}, { topo: { revision: call + 1, nodes: mixNodes }, decisionsDir: decDir2, indexByDecision: mixIdx, repairBudget: 1 });
      const e = MF.readFreshnessFor(wsM, t2.mapId).entries["a:" + nid2 + "|src/a.js"];
      if (e && e.fp === goodFp) mixHit = call;
    }
    ok(mixHit >= 0, "미래 캐시+벽시계 기준선 혼합·budget=1 — seq LRU라 유한 수리(11차 blocker① 소멸): call=" + mixHit);
  }
  // 11차 blocker②: ISO 상한(9999-12-31) entry가 있어도 시각 산술이 없어 touch·수리 정상 기록+영수증=실기록
  {
    const wsX = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_iso_"));
    MF.mergeWrite(wsX, t2.mapId, { ["a:" + nid2 + "|src/a.js"]: { fp: "9".repeat(40), seenAt: "9999-12-31T23:59:59.999Z", basisDecisionId: aq1.decisionId } }, { swap: true });
    const rbX = MF.recordBaselines(wsX, t2.mapId, {}, { topo: { revision: 1, nodes: [{ id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] }] }, decisionsDir: decDir2, indexByDecision: idxM0 });
    const eX = MF.readFreshnessFor(wsX, t2.mapId).entries["a:" + nid2 + "|src/a.js"];
    ok(rbX.ok === true && rbX.repaired === 1 && eX && eX.fp === goodFp, "ISO 상한 seenAt에도 수리 실기록+영수증 일치(스키마 밖 시각 생성 경로 소멸): " + JSON.stringify(rbX));
    ok(MF.validEntry("a:" + nid2 + "|src/a.js", eX) === true, "기록된 entry가 스키마 유효(seq 포함)");
  }
  // 12차 blocker①: auditSeq 포화 — 위험 구간이면 상대 순서 보존 재번호화(무효 순번 기록 없음)
  {
    const wsS = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_sat_"));
    const k1 = "a:" + U(90) + "|src/s1.js", k2 = "a:" + U(91) + "|src/s2.js";
    MF.mergeWrite(wsS, t2.mapId, { [k1]: { fp: FP, seenAt: NOW, basisDecisionId: U(9) }, [k2]: { fp: FP, seenAt: NOW, basisDecisionId: U(9) } }, { swap: true });
    const fS = MF.freshnessFileFor(wsS);
    const dS = JSON.parse(fs.readFileSync(fS, "utf8"));
    dS.auditSeq = Number.MAX_SAFE_INTEGER - 1; // 포화 직전 상태 주입
    dS.entries[k1].seq = Number.MAX_SAFE_INTEGER - 3; dS.entries[k2].seq = Number.MAX_SAFE_INTEGER - 2;
    fs.writeFileSync(fS, JSON.stringify(dS), "utf8");
    const k3 = "a:" + U(92) + "|src/s3.js";
    const wS = MF.mergeWrite(wsS, t2.mapId, { [k3]: { fp: FP, seenAt: NOW, basisDecisionId: U(9) } }, { swap: true });
    const stS = MF.readFreshnessFor(wsS, t2.mapId);
    const e1 = stS.entries[k1], e2 = stS.entries[k2], e3 = stS.entries[k3];
    ok(wS.ok === true && !!e1 && !!e2 && !!e3, "포화 직전 기록=전 entry 보존(판독 드랍 없음)");
    ok(Number.isSafeInteger(e3.seq) && e1.seq < e2.seq && e2.seq < e3.seq, "재번호화 — 상대 순서 보존+안전 정수 유지: " + [e1.seq, e2.seq, e3.seq].join(","));
    // 13차 blocker①: 포화 '직전+대량 배치' — 증가 시마다 경계 보장이라 배치 크기와 무관하게 전량 안전
    const dS2 = JSON.parse(fs.readFileSync(fS, "utf8"));
    dS2.auditSeq = Number.MAX_SAFE_INTEGER - 2;
    fs.writeFileSync(fS, JSON.stringify(dS2), "utf8");
    const batch = {};
    for (let i = 0; i < 7; i++) batch["a:" + crypto.randomUUID() + "|b" + i + ".js"] = { fp: FP, seenAt: NOW, basisDecisionId: U(9) };
    const wB = MF.mergeWrite(wsS, t2.mapId, batch, { swap: true });
    const stB = MF.readFreshnessFor(wsS, t2.mapId);
    ok(wB.ok === true && (wB.wroteKeys || []).length === 7, "(전제) 포화 직전 대량 배치 기록");
    ok(Object.values(stB.entries).every((v) => v.seq === undefined || Number.isSafeInteger(v.seq)) && Object.keys(stB.entries).length >= 10, "배치 중간 재번호화 — unsafe seq 0건·전량 보존(13차 blocker①)");
    // 13차 blocker②: counter 유실(top-level 0)·엔트리 최대 seq 잔존 — 복구 후 이어감(새 기록=후미)
    const dS3 = JSON.parse(fs.readFileSync(fS, "utf8"));
    dS3.auditSeq = 0; // counter 유실 주입(엔트리 seq는 잔존)
    fs.writeFileSync(fS, JSON.stringify(dS3), "utf8");
    const kR2 = "a:" + U(96) + "|src/r.js";
    MF.mergeWrite(wsS, t2.mapId, { [kR2]: { fp: FP, seenAt: NOW, basisDecisionId: U(9) } }, { swap: true });
    const stR2 = MF.readFreshnessFor(wsS, t2.mapId);
    const maxOther = Math.max(...Object.entries(stR2.entries).filter(([k]) => k !== kR2).map(([, v]) => (Number.isSafeInteger(v.seq) ? v.seq : 0)));
    ok(stR2.entries[kR2].seq > maxOther, "counter 유실 복구 — 새 기록이 선두로 되감기지 않고 후미(13차 blocker②): " + stR2.entries[kR2].seq + ">" + maxOther);
  }
  // 12차 blocker②: 축출 정책 — 비권위 e: 캐시가 먼저 축출되어 권위 a: 기준선이 보존+영수증=축출 후 실존
  {
    const wsE2 = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_ev_"));
    const eBig = {};
    for (let i = 0; i < MF.ENTRY_CAP; i++) eBig["e:" + crypto.randomUUID() + "|c" + i + ".js"] = { fp: FP, seenAt: "2030-01-01T00:00:00.000Z" }; // 미래 e: 캐시 가득
    ok(MF.mergeWrite(wsE2, t2.mapId, eBig).ok === true, "(전제) e: 캐시 상한 채움");
    const kA = "a:" + U(93) + "|src/base.js";
    const wA = MF.mergeWrite(wsE2, t2.mapId, { [kA]: { fp: FP, seenAt: NOW, basisDecisionId: U(9) } }, { swap: true });
    const stE2 = MF.readFreshnessFor(wsE2, t2.mapId);
    ok(!!stE2.entries[kA], "권위 a: 기준선은 미래 e: 캐시에 밀려 축출되지 않음(e: 우선 축출)");
    ok((wA.wroteKeys || []).includes(kA), "영수증 wroteKeys=축출 후 실존 키(직전 반례: 축출된 키의 실기록 위장 소멸)");
    // 대조: a:끼리 상한 초과 시엔 축출이 일어나고 그 키는 영수증에서 제외
    const wsE3 = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_ev3_"));
    const aBig = {};
    for (let i = 0; i < MF.ENTRY_CAP; i++) aBig["a:" + crypto.randomUUID() + "|a" + i + ".js"] = { fp: FP, seenAt: LATER, basisDecisionId: U(9) };
    MF.mergeWrite(wsE3, t2.mapId, aBig, { swap: true });
    const kOld = "a:" + U(94) + "|src/old.js";
    const wOld2 = MF.mergeWrite(wsE3, t2.mapId, { [kOld]: { fp: FP, seenAt: "2020-01-01T00:00:00.000Z", basisDecisionId: U(9) } }, { swap: true });
    ok(!(kOld in MF.readFreshnessFor(wsE3, t2.mapId).entries) && !(wOld2.wroteKeys || []).includes(kOld), "(대조) 최고령 a:가 축출되면 영수증에서도 제외(정직)");
  }
  // 12차 [보완]: e: entry에 외부 seq 제공=무효
  ok(MF.validEntry("e:" + U(95) + "|src/x.js", { fp: FP, seenAt: NOW, seq: 1 }) === false, "e: entry의 seq=무효(권위 감사 순번은 a: 전용)");
  // 5차 [주의]: 판독 예산 상한 — 미존재 decision 다수여도 호출당 reads<=budget·budgetHit 보고
  const manyNodes = [];
  for (let i = 0; i < 40; i++) manyNodes.push({ id: crypto.randomUUID(), provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: crypto.randomUUID() }, anchors: [{ kind: "code", path: "src/m" + i + ".js" }] });
  const fakeIdx = {};
  for (const nd of manyNodes) fakeIdx[nd.provenance.decisionId] = "0".repeat(40);
  const repB = MF.repairUpdatesFor(wsF, t2.mapId, { revision: 1, nodes: manyNodes }, decDir2, { indexByDecision: fakeIdx, budget: 10 });
  ok(repB.reads === 10 && repB.budgetHit === true, "판독 예산 상한(reads=" + repB.reads + "·budgetHit — map lock 점유 상한)");
  // 6차 [주의]: 순환 offset — 예산 밖 후보도 유한 전이 내 반드시 선두 창에 들어옴(해시 재셔플과 달리 커버 보장).
  // 구성: 실존·유효 decision을 가진 실노드 1 + 미존재 decision 가짜 4, budget=1 → revision 0..4를 돌리면
  // 정확히 한 시작점에서 실노드가 선두가 되어 수리 updates가 생성된다.
  {
    const realNode = { id: nid2, provenance: topoNow.nodes.find((x) => x.id === nid2).provenance, anchors: [{ kind: "code", path: "src/a.js" }] };
    const covNodes = [realNode];
    for (let i = 0; i < 4; i++) covNodes.push({ id: crypto.randomUUID(), provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: crypto.randomUUID() }, anchors: [{ kind: "code", path: "src/n" + i + ".js" }] });
    const covIdx = { ...idxM0 }; for (const nd of covNodes.slice(1)) covIdx[nd.provenance.decisionId] = "0".repeat(40);
    const wsC = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_cov_")); // 빈 저장소 — 전 노드가 '명백 후보'
    let hits = 0;
    for (let rev = 0; rev < 5; rev++) {
      const rp = MF.repairUpdatesFor(wsC, t2.mapId, { revision: rev, nodes: covNodes }, decDir2, { indexByDecision: covIdx, budget: 1 });
      if (Object.keys(rp.updates).length) hits++;
    }
    ok(hits >= 1, "순환 offset — n(5) 전이 내 예산 밖 후보 최소 1회 선두 도달(유한 커버 보장): hits=" + hits);
    // 7차 [주의]: 명백 후보 최우선(missing-first) — 노드가 계속 삽입돼도 누락 기준선은 즉시 판독 창 진입.
    // 삽입 공격 재현: 실존 decision 후보 1+미존재 decision 후보 1(budget=1)에 매 전이 사전순 앞 id의
    // '비후보' 노드를 늘려도 후보 상대 위치가 밀리지 않아 2 전이 내 실후보가 반드시 판독된다.
    {
      const fakeCand = { id: crypto.randomUUID(), provenance: { basis: { kind: "git", objectFormat: "sha1", head: "d".repeat(40) }, decisionId: crypto.randomUUID() }, anchors: [{ kind: "code", path: "src/f0.js" }] };
      const covIdx2 = { ...idxM0, [fakeCand.provenance.decisionId]: "0".repeat(40) };
      let hit2 = 0;
      for (let rev = 0; rev < 2; rev++) {
        const fillers = [];
        for (let i = 0; i <= rev; i++) fillers.push({ id: "0000000" + i + "-0000-4000-8000-000000000000", anchors: [{ kind: "code", path: "src/x" + i + ".js" }] }); // 무 provenance=순회 비대상 — 위치 밀기 시도
        const rp = MF.repairUpdatesFor(wsC, t2.mapId, { revision: rev, nodes: [...fillers, realNode, fakeCand] }, decDir2, { indexByDecision: covIdx2, budget: 1 });
        if (rp.updates["a:" + nid2 + "|src/a.js"]) hit2++;
      }
      ok(hit2 >= 1, "missing-first — 삽입 중에도 실후보가 2 전이 내 판독·수리(상대 위치 고착 반례 소멸): hit2=" + hit2);
    }
  }
  // 6차 blocker①: 미래 seenAt 구세대 retry가 신세대 수리를 덮지 못한다
  {
    const wsR = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_retryv_"));
    const kR = "a:" + nid2 + "|src/a.js";
    const oldEnt = { fp: "1".repeat(40), seenAt: "2027-06-01T00:00:00.000Z", basisDecisionId: U(70) }; // 미래 시각의 구세대
    ok(MF.stashRetry(wsR, t2.mapId, { [kR]: oldEnt }).ok === true, "(전제) 미래 seenAt 구세대 retry 보관");
    const newEnt = { fp: "2".repeat(40), seenAt: NOW, basisDecisionId: U(71) }; // 시계 복귀 후 신세대
    ok(MF.stashRetry(wsR, t2.mapId, { [kR]: newEnt }).ok === true && MF.peekRetry(wsR, t2.mapId)[kR].basisDecisionId === U(71), "신세대 stash가 미래 seenAt 구세대를 교체(a:=시간 가드 비적용 — 사이드카 변형 봉합)");
    // 병합 우선순위: retry에 구세대가 남아 있어도 수리(권위 결속)가 이긴다 — recordBaselines 경유 실측
    MF.stashRetry(wsR, t2.mapId, { [kR]: oldEnt }); // 구세대를 다시 심음(교체 — 최악 상태 재현)
    const rb = MF.recordBaselines(wsR, t2.mapId, {}, { topo: topoT, decisionsDir: decDir2, indexByDecision: idxM0 });
    const fin = MF.readFreshnessFor(wsR, t2.mapId).entries[kR];
    ok(rb.ok === true && !!fin && fin.basisDecisionId === aq1.decisionId && fin.fp === goodFp, "병합 우선순위 retry<repair — 검증된 수리값이 최종(6차 blocker① 경로 소멸)");
  }
  // 대형 배치 무절단(4차 blocker②): 503건 stash — RETRY_CAP=ENTRY_CAP이라 전량 보존·dropped=0
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_big_"));
  const big = {};
  for (let i = 0; i < 503; i++) big["a:" + crypto.randomUUID() + "|f" + i + ".js"] = { fp: FP, seenAt: NOW, basisDecisionId: U(9) };
  const stBig = MF.stashRetry(wsB, U(100), big);
  ok(stBig.ok === true && stBig.dropped === 0, "503건 배치=무절단(dropped 0 — RETRY_CAP=" + MF.RETRY_CAP + ")");
  ok(Object.keys(MF.peekRetry(wsB, U(100))).length === 503, "retry에 503건 전량 보존");
  const over = {};
  for (let i = 0; i < MF.RETRY_CAP + 3; i++) over["a:" + crypto.randomUUID() + "|g" + i + ".js"] = { fp: FP, seenAt: LATER, basisDecisionId: U(9) };
  const stOver = MF.stashRetry(wsB, U(100), over);
  ok(stOver.ok === true && stOver.dropped > 0, "상한 초과=dropped 노출(" + stOver.dropped + " — 조용한 절단 아님·잔여는 자가 수리가 재유도)");
  // canonical 전체 비교(4차 [보완]①)
  const wsE = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_eq_"));
  const kEq = "a:" + U(60) + "|src/eq.js";
  MF.stashRetry(wsE, U(100), { [kEq]: { fp: FP, seenAt: NOW, basisDecisionId: U(62) } });
  MF.clearRetryCovered(wsE, U(100), { [kEq]: { fp: FP, seenAt: NOW, basisDecisionId: U(61) } });
  ok(Object.keys(MF.peekRetry(wsE, U(100))).length === 1, "동률(seenAt·fp)·다른 decision 결속=미삭제(canonical 전체 비교)");
  MF.clearRetryCovered(wsE, U(100), { [kEq]: { fp: FP, seenAt: NOW, basisDecisionId: U(62) } });
  ok(!fs.existsSync(MF.retryFileFor(wsE)), "완전 동일 entry만 회수 정리(빈 파일 삭제)");
}

console.log("[7] 2트랙 실경로 — pipeline CLI 거부·freshness 무접촉(2차 blocker⑤)");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p4fresh_2track_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  const freshDir = path.join(process.env.CODEX_BRIDGE_HOME, "map-freshness");
  const beforeFiles = fs.existsSync(freshDir) ? fs.readdirSync(freshDir).sort() : [];
  for (const cmd of ["propose", "classify", "apply", "recover"]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-map.js"), ws, cmd, U(1)], { encoding: "utf8", env: { ...process.env } });
    ok(r.status === 2 && /3트랙|3-track/.test(r.stderr), `2트랙: ${cmd}=거부(실경로 실행)`);
  }
  ok(!fs.existsSync(MP.pipeRootFor(ws)), "2트랙: 파이프라인 서랍 미생성");
  const afterFiles = fs.existsSync(freshDir) ? fs.readdirSync(freshDir).sort() : [];
  ok(JSON.stringify(beforeFiles) === JSON.stringify(afterFiles), "2트랙: freshness 파일 생성 0(디렉터리 목록 불변)");
  ok(!fs.existsSync(MF.freshnessFileFor(ws)), "2트랙: 이 워크스페이스의 freshness 파일 없음");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
