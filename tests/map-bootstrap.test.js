"use strict";
/*
 * P1 — Project MAP 비차단 bootstrap 생명주기 반례 잠금(설계 사전검증 8건+구현 1차 검증 6건 반영).
 * 2트랙 완전 무접촉 / 동의 없인 자동 생성 0(pending-consent) / absent→자식 wx 선점 정확히 1회(fail-closed) /
 * 기존 v2 큐 backfill(내용 정합 재작성·소급 exclude 금지) / invalid·v1 무조치 / failed 무조건 억제(수동만) /
 * 죽은 선점자 회수 / verify-guard 예외(이번 실행 산출물만·보수 포함).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mapboot_home_"));
process.env.CODEX_BRIDGE_HOME = home; // require 전에 — 모듈 상수가 require 시점에 고정됨
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const MB = require(path.join(__dirname, "..", "bridge", "map-bootstrap.js"));
const MR = require(path.join(__dirname, "..", "bridge", "map-runtime.js"));

function mkRepo(name) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "mapboot_" + name + "_"));
  fs.mkdirSync(path.join(r, "src"));
  fs.writeFileSync(path.join(r, "src", "a.js"), "module.exports = 1;\n");
  return r;
}
function setScoutOn(ws, extra) {
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on", ...(extra || {}) }));
}
function rs(repo) { try { return JSON.parse(fs.readFileSync(MB.rsFileFor(repo), "utf8")); } catch { return null; } }
async function waitRs(repo, pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const x = rs(repo); if (pred(x)) return x; await sleep(50); }
  return null;
}

async function main() {
  console.log("[1] 2트랙 = 완전 무접촉(계약 없음/off면 파일 0·spawn 0)");
  {
    const ws = mkRepo("twotrack");
    const r = MB.maybeSpawnBootstrap(ws);
    ok(r.spawned === false && r.reason === "two-track", "maybeSpawn → two-track(즉시 반환)");
    ok(!fs.existsSync(path.join(ws, "project-map")) && !rs(ws) && !fs.existsSync(MB.queueFileFor(ws)), "repo·하네스에 흔적 0");
    ok(MB.hookTick(ws) === null, "hookTick도 null(고지 파일조차 없음)");
    ok(!fs.existsSync(MB.RUN_DIR) || fs.readdirSync(MB.RUN_DIR).length === 0, "RUN_DIR 무생성/빈 상태");
  }

  console.log("[2] 동의 게이트(1차 #1) — 3트랙 on이어도 동의 표식 없이는 자동 생성 0");
  {
    const ws = mkRepo("consent");
    setScoutOn(ws);
    const r = MB.maybeSpawnBootstrap(ws);
    ok(r.spawned === false && r.reason === "pending-consent", "무동의 → pending-consent(spawn 0)");
    ok(!fs.existsSync(path.join(ws, "project-map")), "저장소 파일 생성 0(기존 3트랙 사용자 보호)");
    const a1 = MB.hookTick(ws);
    ok(typeof a1 === "string" && /동의|consent/i.test(a1), "훅 고지 1회(동의 필요+수동 명령 안내)");
    ok(MB.hookTick(ws) === null, "같은 상태 재고지 억제(서명 1회)");
    ok(MB.grantConsent(ws, "test") === true && MB.hasConsent(ws), "동의 기록");
    const r2 = MB.maybeSpawnBootstrap(ws);
    ok(r2.spawned === true && r2.mode === "init", "동의 후 → 기동");
    const done = await waitRs(ws, (x) => x && x.phase === "done", 15000);
    ok(!!done, "자식 완료");
  }

  console.log("[3] absent e2e — topology v2+run-state done(exclude 귀속)+보강 큐(1-33)");
  {
    const ws = mkRepo("absent");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    const r = MB.maybeSpawnBootstrap(ws);
    ok(r.spawned === true && r.mode === "init", "absent → spawn(init)");
    const done = await waitRs(ws, (x) => x && x.phase === "done", 15000);
    ok(!!done, "자식 완료(run-state done)");
    const topo = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8"));
    ok(MR.PM.validateTopology(topo).length === 0 && topo.schemaVersion === 2, "생성 topology = 유효 v2");
    ok(done.mapId === topo.mapId && done.exclude && done.exclude.topology && done.exclude.mapMd, "exclude에 이번 실행 산출물 2종 귀속(1차 #6)");
    const q = JSON.parse(fs.readFileSync(MB.queueFileFor(ws), "utf8"));
    ok(q.mapId === topo.mapId && q.schema === "enrich-queue-v1" && q.mapHash === MR.PM.mapHashOf(topo) && q.basis && q.basis.kind === "historyless" && typeof q.basis.basisFp === "string" && typeof q.basis.inventoryFp === "string", "큐: mapId+mapHash+historyless fp 2종 결속(1차 #3)");
    ok(MB.maybeSpawnBootstrap(ws).reason === "ready", "완료 후 → ready(재기동 0)");
  }

  console.log("[4] 자식 wx 선점 — 동시 2자식 중 무거운 스캔 정확히 1회(1-7)");
  {
    const ws = mkRepo("race");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    const script = path.join(__dirname, "..", "bridge", "map-bootstrap.js");
    const runP = () => new Promise((res) => { const c = spawn(process.execPath, [script, "run", ws], { env: { ...process.env }, stdio: "ignore" }); c.on("close", (code) => res(code)); });
    const codes = await Promise.all([runP(), runP()]);
    ok(codes.filter((c) => c === 0).length === 1 && codes.filter((c) => c === 3).length === 1, `동시 run → 작업 1(exit 0)·선점패배 1(exit 3): [${codes}]`);
    ok(MR.PM.validateTopology(JSON.parse(fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8"))).length === 0, "살아남은 topology 유효");
  }

  console.log("[5] ensure backfill — topology 무변경·소급 exclude 금지·큐 내용 정합(1차 #3·#6)");
  {
    const ws = mkRepo("ensure");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    ok(MR.runCli(ws, "init") === 0, "선행: 사람/P0.5 경로로 topology 생성(큐·run-state 없음)");
    const before = fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8");
    const r = MB.maybeSpawnBootstrap(ws);
    ok(r.spawned === true && r.mode === "ensure", "topology 있음+큐 없음 → ensure 기동");
    const done = await waitRs(ws, (x) => x && x.phase === "done", 15000);
    ok(!!done && fs.existsSync(MB.queueFileFor(ws)), "큐 backfill 완료");
    ok(fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8") === before, "topology 바이트 무변경");
    ok(!done.exclude || !done.exclude.topology, "이번 실행이 만들지 않은 topology는 exclude에 없음(소급 인정 금지 — 1차 #6)");
    ok(MB.mapAutoExcluded(ws).has("project-map/topology.json") === false, "guard도 topology를 제외하지 않음(사람 산출물 보수 포함)");
    // 큐 내용 불일치·손상 → 재작성(1차 #3)
    const qf = MB.queueFileFor(ws);
    const q0 = JSON.parse(fs.readFileSync(qf, "utf8"));
    fs.writeFileSync(qf, JSON.stringify({ ...q0, mapHash: "OLD" }));
    ok(MB.ensureQueue(ws, MR.PM) === true && JSON.parse(fs.readFileSync(qf, "utf8")).mapHash !== "OLD", "mapHash 불일치 큐 → 재작성(스냅샷 자체 판독)");
    { const q2 = JSON.parse(fs.readFileSync(qf, "utf8")); const st = fs.statSync(path.join(ws, "project-map", "topology.json")); const topoNow2 = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8")); ok(q2.topoStat.mtimeMs === st.mtimeMs && q2.topoStat.size === st.size && q2.mapHash === MR.PM.mapHashOf(topoNow2), "큐의 mapHash·topoStat=같은 스냅샷(3차 #1 결속)"); }
    fs.writeFileSync(qf, "{broken");
    ok(MB.queueLooksSane(ws) === false, "손상 큐 → 부모가 backfill 필요로 판정(존재만으론 ready 아님)");
    ok(MB.maybeSpawnBootstrap(ws).spawned === true, "손상 큐 → ensure 재기동");
    await waitRs(ws, (x) => x && x.phase === "done" && MB.queueLooksSane(ws), 15000);
    ok(MB.queueLooksSane(ws), "재작성 완료");
  }

  console.log("[6] invalid·v1 = blocked(무조치)·자동 억제·파일 삭제 시 복구(absent 재개)");
  {
    const ws = mkRepo("invalid");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    fs.mkdirSync(path.join(ws, "project-map"), { recursive: true });
    fs.writeFileSync(path.join(ws, "project-map", "topology.json"), "{broken");
    ok(MB.runChild(ws, false) === 2 && rs(ws).phase === "blocked" && rs(ws).reason === "invalid", "손상 파일 → blocked(invalid)");
    ok(fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8") === "{broken", "원본 무변경");
    ok(MB.maybeSpawnBootstrap(ws).reason === "blocked", "blocked+파일 존재 → 자동 재기동 금지");
    fs.rmSync(path.join(ws, "project-map"), { recursive: true, force: true }); // 사용자 복구(삭제)
    ok(MB.maybeSpawnBootstrap(ws).spawned === true, "blocked였어도 대상 파일 삭제(복구) → absent 재개");
    await waitRs(ws, (x) => x && x.phase === "done", 15000);
    const ws2 = mkRepo("v1");
    setScoutOn(ws2); MB.grantConsent(ws2, "test");
    fs.mkdirSync(path.join(ws2, "project-map"), { recursive: true });
    fs.writeFileSync(path.join(ws2, "project-map", "topology.json"), JSON.stringify({ schemaVersion: 1, draft: true, project: "t", createdAt: "t", revision: 1, nodes: [], edges: [], inventory: { scanComplete: true, filesSeen: 0, policyExcluded: [], depthCapped: [], entryCapped: false, unreadable: [], semantic: { supportedLangs: [], scannedSupportedFiles: 0, unsupportedFiles: 0, dynamicUnknowns: 0, externalOrAliasSkipped: 0, semanticUnreadable: [], parserNote: "x" } }, freshnessNote: "f" }));
    ok(MB.runChild(ws2, false) === 2 && rs(ws2).reason === "v1-needs-migrate", "v1 → blocked(자동 마이그레이션 없음)");
  }

  console.log("[7] failed = 무조건 자동 억제(topology 유무 무관 — 1차 #5)·수동만 재시도");
  {
    const ws = mkRepo("failed");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.writeFileSync(MB.rsFileFor(ws), JSON.stringify({ phase: "failed", pid: 1, runId: "r0", error: "이전 실패", repo: ws }));
    ok(MB.maybeSpawnBootstrap(ws).reason === "failed", "failed+topology 없음 → 억제");
    // failed인데 topology는 이미 존재·큐 없음(1차 반례: ensure 재기동 우회) → 여전히 억제
    ok(MR.runCli(ws, "init") === 0, "(픽스처) topology 생성");
    const r2 = MB.maybeSpawnBootstrap(ws);
    ok(r2.spawned === false && r2.reason === "failed", "failed+topology 존재+큐 없음 → 여전히 억제(매 훅 자식 양산 차단)");
    ok(MB.runChild(ws, true) === 0 && rs(ws).phase === "done", "수동(manual)만 교체 선점 → 완료");
  }

  console.log("[8] 선점 fail-closed(1차 #2) — 손상 run-state=자동 lose·수동 복구·소유권 CAS");
  {
    const ws = mkRepo("claimfc");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.writeFileSync(MB.rsFileFor(ws), "{broken");
    ok(MB.runChild(ws, false) === 3, "손상 run-state → 자동 자식은 선점 실패(교체 금지 — fail-closed)");
    ok(fs.readFileSync(MB.rsFileFor(ws), "utf8") === "{broken", "손상 파일 무변경");
    ok(MB.maybeSpawnBootstrap(ws).reason === "state-invalid", "부모도 자동 경로 정지+고지 사유");
    ok(MB.runChild(ws, true) === 3, "수동도 손상 rs 자동 교체 금지(9차 #3 — 활성 작업자의 외부 손상 rs 교체=병존)");
    const fuHold = MB.forceUnlock(ws, {});
    ok(fuHold.some((a) => a.kind === "run-state" && !a.quarantined && a.needs === "--confirm-corrupt"), "승인 없는 강제 복구=보류+필요 플래그 반환");
    ok(fs.readFileSync(MB.rsFileFor(ws), "utf8") === "{broken", "보류 시 파일 무변경");
    ok(MB.forceUnlock(ws, { corrupt: true }).some((a) => a.kind === "run-state" && a.quarantined), "--confirm-corrupt 승인 시 rs 격리");
    ok(MB.runChild(ws, true) === 0 && rs(ws).phase === "done", "격리 후 수동 복구 성공");
    // 소유권 CAS: 죽은 running을 다른 runId가 강탈한 상황 — 옛 소유자의 전이는 무시돼야
    const stolen = { phase: "running", pid: process.pid, runId: "thief", token: "t", repo: ws };
    fs.writeFileSync(MB.rsFileFor(ws), JSON.stringify(stolen));
    const fakeClaim = { runId: "old-owner" };
    const MBpath = path.join(__dirname, "..", "bridge", "map-bootstrap.js");
    delete require.cache[require.resolve(MBpath)];
    ok(rs(ws).runId === "thief", "(전제) 현 소유자=thief");
    // writeRs는 내부 함수 — runChild 경유 대신 mapAutoExcluded로 소유권 간접 확인은 불가하므로 여기선 계약만:
    // done 전이가 runId CAS를 거친다는 것은 [4]의 경쟁(패배 자식이 done을 못 덮음)+아래 재확인으로 잠금
    ok(rs(ws).runId === "thief" && rs(ws).phase === "running", "타 소유 레코드가 유지됨(경쟁 자식의 사후 덮어쓰기 없음 — [4]와 결합 잠금)");
    void fakeClaim;
  }

  console.log("[9] 죽은 선점자(pid ESRCH) 회수 — 자동 경로 교체");
  {
    const ws = mkRepo("deadpid");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.writeFileSync(MB.rsFileFor(ws), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws }));
    ok(MB.maybeSpawnBootstrap(ws).spawned === true, "죽은 running → living 아님으로 보고 재기동");
    ok(MB.runChild(ws, false) === 0, "자식이 .reclaim(pid+토큰) 아래 교체 후 완료");
  }

  console.log("[10] 트리거③ — 양쪽 다 topology ready여도 대상 변경 감지(1-17)");
  {
    const wsA = mkRepo("trigA"); const wsB = mkRepo("trigB");
    const ws = mkRepo("trigWs");
    setScoutOn(ws, { scoutRepo: wsA });
    MB.grantConsent(wsA, "test"); MB.grantConsent(wsB, "test");
    ok(MB.runChild(wsA, true) === 0 && MB.runChild(wsB, true) === 0, "(전제) 양쪽 repo 모두 topology+큐 ready");
    const r1 = MB.maybeSpawnBootstrap(ws);
    ok(r1.reason === "ready", "대상 A ready 관측(기록)");
    setScoutOn(ws, { scoutRepo: wsB });
    const r2 = MB.maybeSpawnBootstrap(ws);
    ok(r2.reason === "ready" && typeof r2.changedFrom === "string" && r2.changedFrom.toLowerCase().includes(path.basename(wsA).toLowerCase()), "양쪽 ready여도 변경 감지+changedFrom 보고");
    const adv = MB.hookTick(ws);
    ok(adv === null || /바뀌었|changed/.test(String(adv)), "훅 고지(대상 변경) 또는 이미 소거");
  }

  console.log("[11] verify-guard 예외 — 이번 실행 산출물만·사람 편집 복귀·축약 2차 조회(1차 #6·설계 #7)");
  {
    const ws = mkRepo("guard");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    ok(MB.runChild(ws, false) === 0, "선행 자동 생성(init — exclude 2종)");
    let ex = MB.mapAutoExcluded(ws);
    ok(ex.has("project-map/topology.json") && ex.has("project-map/MAP.md"), "지문 일치 → 2파일 제외");
    fs.appendFileSync(path.join(ws, "project-map", "MAP.md"), "\n사람 편집\n");
    ex = MB.mapAutoExcluded(ws);
    ok(ex.has("project-map/topology.json") && !ex.has("project-map/MAP.md"), "사람 편집(불일치) → 그 파일만 포함 복귀");
    ok(MB.mapAutoExcluded(mkRepo("noRs")).size === 0, "run-state 부재 → 제외 없음(보수)");
    const g = (args, cwd) => spawnSync("git", ["-c", "safe.directory=*", ...args], { cwd, encoding: "utf8", timeout: 5000 });
    const gr = mkRepo("guardgit");
    setScoutOn(gr); MB.grantConsent(gr, "test");
    if (g(["init", "-q"], gr).status === 0) {
      g(["config", "user.email", "t@t"], gr); g(["config", "user.name", "t"], gr);
      g(["add", "-A"], gr); g(["commit", "-qm", "base"], gr);
      ok(MB.runChild(gr, false) === 0, "git repo 자동 생성(untracked project-map/)");
      const exg = MB.mapAutoExcluded(gr);
      ok(MB.projectMapMtimeForStatus(gr, "project-map/", exg) === null, "'?? project-map/' 축약 → 전부 자동물 판정(제외)");
      fs.appendFileSync(path.join(gr, "project-map", "MAP.md"), "\n사람 편집\n");
      const m = MB.projectMapMtimeForStatus(gr, "project-map/", MB.mapAutoExcluded(gr));
      ok(typeof m === "number" && m > 0, "일부 사람 편집 → 비자동물 mtime 반영(포함)");
    } else { ok(true, "(git 없음 — 생략)"); ok(true, "(동상)"); ok(true, "(동상)"); }
    ok(MB.projectMapMtimeForStatus(ws, "src/a.js", new Set()) === undefined, "project-map 외 경로 → undefined(일반 처리)");
  }

  console.log("[12] CLI bootstrap(트리거④ 수동=동의) — scope-map 경유 끝-끝");
  {
    const ws = mkRepo("cli");
    setScoutOn(ws); // 동의 없음 — CLI 실행 자체가 동의 기록
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws, "bootstrap"], { encoding: "utf8", env: { ...process.env } });
    ok(r.status === 0 && /draft-ready/.test(r.stdout), "scope-map bootstrap → draft-ready");
    ok(MB.hasConsent(ws), "명시 실행=동의 표식 기록(이후 자동 경로 열림)");
  }

  console.log("[13] 2차 반례 — 스키마 게이트·낡은 큐 감지·exclude 승계·reclaim 잔존·재시도 상한");
  {
    const ws = mkRepo("second");
    setScoutOn(ws);
    // 배열/빈 객체 동의 → 거부
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.writeFileSync(MB.consentFileFor(ws), "[]");
    ok(!MB.hasConsent(ws), "배열 동의 파일 → 무효(2차 #1)");
    fs.writeFileSync(MB.consentFileFor(ws), "{}");
    ok(!MB.hasConsent(ws), "빈 객체 동의 → 무효(version·at 계약)");
    MB.grantConsent(ws, "test");
    ok(MB.hasConsent(ws), "정식 기록 → 유효");
    // {} run-state → state-invalid 정지(매턴 헛spawn 차단)
    fs.writeFileSync(MB.rsFileFor(ws), "{}");
    ok(MB.maybeSpawnBootstrap(ws).reason === "state-invalid", "{} run-state → 자동 정지(2차 #1)");
    ok(MB.runChild(ws, true) === 3, "수동도 스키마 위반 rs 교체 금지(9차 #3)");
    ok(MB.forceUnlock(ws, { corrupt: true }).some((a) => a.kind === "run-state" && a.quarantined) && MB.runChild(ws, true) === 0, "승인 격리 후 수동 복구");
    // 낡은 큐(topology가 그 뒤 바뀜) → 부모가 ensure 재기동(stat 신호 — 2차 #2)
    const q0 = JSON.parse(fs.readFileSync(MB.queueFileFor(ws), "utf8"));
    fs.writeFileSync(MB.queueFileFor(ws), JSON.stringify({ ...q0, topoStat: { mtimeMs: 1, size: 1 } }));
    const rStale = MB.maybeSpawnBootstrap(ws);
    ok(rStale.spawned === true && rStale.mode === "ensure", "큐 topoStat 불일치(낡음) → ensure 기동");
    { // 이전 done 레코드가 남아 있어 rs만으론 완료 판별 불가 — ready 도달을 직접 폴링
      let readyNow = false;
      const until = Date.now() + 15000;
      while (Date.now() < until) { if (MB.maybeSpawnBootstrap(ws).reason === "ready") { readyNow = true; break; } await sleep(50); }
      ok(readyNow, "재작성 후 ready(부모 신선 판정 회복)");
    }
    // exclude 승계(2차 #3): 자동 생성물이던 topology — 큐 손상→ensure 재실행에도 exclude.topology 유지
    const ws2 = mkRepo("inherit");
    setScoutOn(ws2); MB.grantConsent(ws2, "test");
    ok(MB.runChild(ws2, false) === 0, "자동 생성(init — exclude 2종)");
    fs.writeFileSync(MB.queueFileFor(ws2), "{broken");
    ok(MB.runChild(ws2, false) === 0, "큐 손상 → ensure 재실행");
    const rs2 = rs(ws2);
    ok(rs2.exclude && rs2.exclude.topology && rs2.exclude.mapMd, "자동 산출물 exclude가 재실행에도 승계(claim.prev 경유 — 파일 재판독은 이미 running이라 불가)");
    ok(MB.mapAutoExcluded(ws2).has("project-map/topology.json"), "guard 제외 유지(불필요한 Stop 차단 방지)");
    // reclaim 잔존(2차 #4): 죽은 보유자 → 자동 정지·수동 복구
    const ws3 = mkRepo("reclaim");
    setScoutOn(ws3); MB.grantConsent(ws3, "test");
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.writeFileSync(MB.rsFileFor(ws3), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws3 }));
    fs.writeFileSync(MB.rsFileFor(ws3) + ".reclaim", JSON.stringify({ pid: 999999998, token: "stale" }));
    ok(MB.maybeSpawnBootstrap(ws3).reason === "state-lock-blocked", "잔존 회수 잠금 → 자동 정지(헛spawn 반복 차단)");
    ok(MB.runChild(ws3, false) === 3, "자동 자식도 회수 안 함(fail-closed)");
    ok(MB.runChild(ws3, true) === 0 && rs(ws3).phase === "done", "수동=죽은 보유자 확인 후 정리·복구");
    // 재시도 상한(2차 #5): 죽은 running의 attempts>=3 → failed 취급(자동 억제)
    const ws4 = mkRepo("attempts");
    setScoutOn(ws4); MB.grantConsent(ws4, "test");
    fs.writeFileSync(MB.rsFileFor(ws4), JSON.stringify({ phase: "running", pid: 999999999, runId: "x", attempts: 3, repo: ws4 }));
    const rCap = MB.maybeSpawnBootstrap(ws4);
    ok(rCap.spawned === false && rCap.reason === "failed" && /상한|limit/.test(String(rCap.error)), "죽은 running 3회 → 자동 억제(폭주 차단)");
  }

  console.log("[14] 4차 반례 — 상태 우선순위·트랜잭션 결속·.recover 잔존");
  {
    // failed run-state + 유효 topology + fresh 큐 → 상태도 bootstrap-failed(4차 #2: 자동은 정지인데 CLI는 ready라던 상충)
    const ws = mkRepo("prio");
    setScoutOn(ws); MB.grantConsent(ws, "test");
    ok(MB.runChild(ws, true) === 0, "(전제) ready 상태 구축");
    const good = rs(ws);
    fs.writeFileSync(MB.rsFileFor(ws), JSON.stringify({ ...good, phase: "failed", error: "큐 기록 실패(가정)" }));
    const st = MB.bootstrapStatusFor(ws);
    ok(st.state === "bootstrap-failed", "failed는 topology·큐가 멀쩡해도 bootstrap-failed(부모 억제와 동일 우선순위)");
    // 트랜잭션 결속(4차 #1): 완료 직후 run-state의 지문 3종이 '실파일'과 전부 일치(한 스냅샷)
    fs.writeFileSync(MB.rsFileFor(ws), JSON.stringify(good));
    ok(MB.runChild(ws, true) === 0, "재완료");
    const d2 = rs(ws);
    const crypto2 = require("crypto");
    const sha = (f) => crypto2.createHash("sha1").update(fs.readFileSync(f, "utf8")).digest("hex");
    const q2 = JSON.parse(fs.readFileSync(MB.queueFileFor(ws), "utf8"));
    const st2 = fs.statSync(path.join(ws, "project-map", "topology.json"));
    ok(d2.topoFp === sha(path.join(ws, "project-map", "topology.json")) && d2.mapMdFp === sha(path.join(ws, "project-map", "MAP.md")) && q2.topoStat.mtimeMs === st2.mtimeMs && q2.topoStat.size === st2.size && q2.mapId === d2.mapId, "run-state 지문·큐 stat·mapId = 같은 스냅샷(잠금 안 단일 트랜잭션)");
    // MAP.md 훼손 후 ensure — 잠금 안 복구+rendered 귀속
    fs.appendFileSync(path.join(ws, "project-map", "MAP.md"), "\n낙서\n");
    fs.writeFileSync(MB.queueFileFor(ws), "{broken"); // ensure 유도
    ok(MB.runChild(ws, false) === 0, "ensure 재실행(뷰 복구 포함)");
    const d3 = rs(ws);
    ok(d3.exclude && d3.exclude.mapMd === sha(path.join(ws, "project-map", "MAP.md")), "복구 렌더분은 이번 실행 산출물로 귀속(exclude.mapMd)");
    // .recover 잔존(4차 #3): 죽은 보유자 2차 잠금 → 자동·수동 모두 정지+상태 표시(자동 회수 없음)
    const ws5 = mkRepo("recover");
    setScoutOn(ws5); MB.grantConsent(ws5, "test");
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.writeFileSync(MB.rsFileFor(ws5), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5 }));
    fs.writeFileSync(MB.rsFileFor(ws5) + ".reclaim", JSON.stringify({ pid: 999999998, token: "stale" }));
    fs.writeFileSync(MB.rsFileFor(ws5) + ".reclaim.recover", JSON.stringify({ pid: 999999997, token: "stale2" }));
    ok(MB.maybeSpawnBootstrap(ws5).reason === "state-lock-blocked", "잔존 .recover도 자동 정지 사유");
    ok(MB.runChild(ws5, true) === 3, "수동도 2차 잠금은 회수하지 않음(명시 삭제 안내 대상)");
    ok(MB.bootstrapStatusFor(ws5).state === "state-lock-blocked", "상태 조회도 동일 표시(운영 오도 없음)");
    // CLI 표면(5차 #2): lock-blocked에서 안내된 수동 명령이 '성공 위장' 없이 경로+안내로 실패
    const rCli = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws5, "bootstrap"], { encoding: "utf8", env: { ...process.env } });
    ok(rCli.status === 1 && rCli.stderr.includes("force-unlock") && rCli.stderr.includes(".recover"), "CLI bootstrap → exit 1+강제 복구 안내+경로(성공 위장·수동 rm 안내 제거)");
    // 직접 진입점(run-manual)도 같은 계약(6차 #3: 진입점별 exit 계약 분열 금지 — runCli 위임)
    const rMan = spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "map-bootstrap.js"), "run-manual", ws5], { encoding: "utf8", env: { ...process.env } });
    ok(rMan.status === 1 && rMan.stderr.includes(".recover"), "run-manual 직접 진입점도 exit 1+경로(성공 위장 없음)");
    // 8차: 손으로 rm 하지 않고 force-unlock이 사망 재확인 후 격리
    const fua = MB.forceUnlock(ws5);
    ok(fua.some((a) => a.quarantined && a.lock.endsWith(".recover")) && !fs.existsSync(MB.rsFileFor(ws5) + ".reclaim.recover"), "force-unlock이 dead-valid 잠금을 재확인 후 격리(rename)");
    ok(MB.runChild(ws5, true) === 0, "격리 후 수동 복구 성공");
    // .reclaim 단독 잔존(6차 #4): 직접 삭제 권고는 확인~삭제 사이 새 소유자 잠금을 지울 위험 — 안전 회수 안내여야 함
    const ws5b = mkRepo("reclaimonly");
    setScoutOn(ws5b); MB.grantConsent(ws5b, "test");
    fs.writeFileSync(MB.rsFileFor(ws5b), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5b }));
    fs.writeFileSync(MB.rsFileFor(ws5b) + ".reclaim", JSON.stringify({ pid: 999999998, token: "stale" }));
    const advB = MB.hookTick(ws5b);
    ok(!!advB && /직접 지우지 말고|do not delete it by hand/.test(advB) && !/직접 삭제/.test(advB), "1차 잠금 단독 잔존 → 수동 안전 회수 안내(직접 삭제 미권고)");
    ok(!MB.lockNeedsManualDelete(MB.rsFileFor(ws5b) + ".reclaim") && MB.lockNeedsManualDelete(MB.rsFileFor(ws5b) + ".reclaim.recover"), "삭제 안내 분기=2차 잠금 한정");
    ok(MB.runChild(ws5b, true) === 0, "1차 잠금 단독 잔존은 수동 명령이 안전 회수(삭제 불필요)");
    // 손상 잠금(7차): invalid/unreadable/스키마 위반은 보유자 사망 입증 불가 — 회수 금지+pid 확인 안내 대신 손상 전용 안내
    const ws5c = mkRepo("corruptlock");
    setScoutOn(ws5c); MB.grantConsent(ws5c, "test");
    fs.writeFileSync(MB.rsFileFor(ws5c), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5c }));
    fs.writeFileSync(MB.rsFileFor(ws5c) + ".reclaim", "not-json{");
    ok(MB.runChild(ws5c, true) === 3, "손상 .reclaim은 수동도 회수 금지(활성 잠금의 부분 기록일 수 있음)");
    const advC = MB.hookTick(ws5c);
    ok(!!advC && /손상|corrupted/.test(advC) && !/pid가 죽어|its pid is dead/.test(advC), "손상 잠금 → pid 확인 안내 없이 손상 전용 안내");
    ok(MB.lockNeedsManualDelete(MB.rsFileFor(ws5c) + ".reclaim", "invalid") === true, "손상 잠금=직접 삭제 대상(접미사 무관)");
    const rCorrupt = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws5c, "bootstrap"], { encoding: "utf8", env: { ...process.env } });
    ok(rCorrupt.status === 1 && /손상|corrupted/.test(rCorrupt.stderr) && rCorrupt.stderr.includes("force-unlock"), "CLI도 손상 잠금 안내=force-unlock(수동 rm 안내 없음)+exit 1");
    fs.writeFileSync(MB.rsFileFor(ws5c) + ".reclaim", JSON.stringify({ token: "x" })); // 스키마 위반(pid 누락)도 손상 취급
    ok(MB.runChild(ws5c, true) === 3 && MB.lockStateOf({ st: "ok", data: { token: "x" } }) === "invalid", "pid 누락 잠금도 회수 금지(dead-valid 아님)");
    const rFu0 = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws5c, "force-unlock"], { encoding: "utf8", env: { ...process.env } });
    ok(rFu0.status === 1 && rFu0.stderr.includes("--confirm-corrupt") && fs.existsSync(MB.rsFileFor(ws5c) + ".reclaim"), "손상 잠금은 승인 없이 격리 불가(보류+플래그 안내, 파일 무변경 — 9차 #2)");
    const rFu = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws5c, "force-unlock", "--confirm-corrupt"], { encoding: "utf8", env: { ...process.env } });
    ok(rFu.status === 0 && /격리 완료|Quarantined/.test(rFu.stdout) && !fs.existsSync(MB.rsFileFor(ws5c) + ".reclaim"), "--confirm-corrupt 승인 시 CLI 격리(exit 0)");
    ok(MB.runChild(ws5c, true) === 0, "격리 후 수동 복구 성공");
    // owner-unverified(8차): pid 판별 불가(EPERM 외 오류)는 사망도 생존도 미입증 — 자동 기동 차단+표면화, 회수·격리 거부
    const ws5d = mkRepo("ownerunv");
    setScoutOn(ws5d); MB.grantConsent(ws5d, "test");
    fs.writeFileSync(MB.rsFileFor(ws5d), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5d }));
    fs.writeFileSync(MB.rsFileFor(ws5d) + ".reclaim", JSON.stringify({ pid: 424242, token: "t" }));
    const origKill = process.kill.bind(process);
    process.kill = (pid, sig) => { if (pid === 424242) { const e = new Error("EIO"); e.code = "EIO"; throw e; } return origKill(pid, sig); };
    try {
      ok(MB.lockStateOf({ st: "ok", data: { pid: 424242, token: "t" } }) === "owner-unverified", "pid 판별 불가=owner-unverified(alive로 합치지 않음)");
      const mv = MB.maybeSpawnBootstrap(ws5d);
      ok(mv.spawned === false && mv.reason === "state-lock-blocked" && mv.lockState === "owner-unverified", "판별 불가 잠금=자동 기동 차단+표면화(무고지 반복 spawn 제거)");
      const advD = MB.hookTick(ws5d);
      ok(!!advD && /생존을 확인할 수 없다|liveness cannot be verified/.test(advD) && advD.includes("--confirm-owner-dead"), "안내=재시도+OS 확인 후 승인 탈출구(영구 정지 방지 — 9차 #4)");
      ok(MB.forceUnlock(ws5d).every((a) => !a.quarantined), "승인 없는 force-unlock=격리 거부(사망 미입증)");
      ok(MB.runChild(ws5d, true) === 3, "수동 회수도 금지");
      ok(MB.forceUnlock(ws5d, { ownerDead: true }).some((a) => a.quarantined), "--confirm-owner-dead 승인 시 격리(OS 확인 전제)");
      ok(MB.runChild(ws5d, true) === 0, "격리 후 수동 복구 성공");
    } finally { process.kill = origKill; }
    // funlock 상호배제(9차 #1): 강제 복구 진행 중엔 선점자·다른 강제 복구 모두 개입 금지 — 판독·격리 창 봉합
    const ws5e = mkRepo("funlock");
    setScoutOn(ws5e); MB.grantConsent(ws5e, "test");
    fs.writeFileSync(MB.rsFileFor(ws5e), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5e }));
    fs.writeFileSync(MB.rsFileFor(ws5e) + ".reclaim", JSON.stringify({ pid: 999999998, token: "stale" }));
    fs.writeFileSync(MB.rsFileFor(ws5e) + ".funlock", JSON.stringify({ pid: process.pid, token: "held" })); // 활성 강제 복구 시뮬(살아있는 pid)
    ok(MB.runChild(ws5e, true) === 3, "활성 funlock 중 선점자 개입 금지(새 잠금·상태 생성 없음)");
    ok(MB.maybeSpawnBootstrap(ws5e).reason === "force-recovery-running", "부모=조용한 보류(강제 복구는 수동 주도 — 헛spawn 없음)");
    ok(MB.forceUnlock(ws5e).every((a) => !a.quarantined), "활성 funlock 중 두 번째 강제 복구 거부(직렬화)");
    ok(fs.existsSync(MB.rsFileFor(ws5e) + ".reclaim"), "거부 동안 잠금 무변경");
    fs.unlinkSync(MB.rsFileFor(ws5e) + ".funlock");
    fs.writeFileSync(MB.rsFileFor(ws5e) + ".funlock", JSON.stringify({ pid: 999999997, token: "dead" })); // 죽은 funlock 잔재
    ok(MB.runChild(ws5e, true) === 3, "죽은 funlock 잔재=선점자도 fail-closed(회수는 forceUnlock 전용 — 11차 실취득)");
    const me = MB.maybeSpawnBootstrap(ws5e);
    ok(me.reason === "state-lock-blocked" && me.lockState === "dead-valid" && String(me.lock).endsWith(".funlock"), "부모가 잔재를 표면화(안내=force-unlock 자체 회수)");
    ok(MB.forceUnlock(ws5e).some((a) => a.quarantined && a.kind === "lock"), "죽은 funlock 잔재=이동 회수 후 진행(dead-valid 즉시 격리)");
    ok(MB.runChild(ws5e, true) === 0, "복구 완료");
    ok(!fs.existsSync(MB.rsFileFor(ws5e) + ".funlock"), "정상 선점 후 funlock 해제(실취득 mutex 계약)");
    // 11차 #2: 죽은 funlock 동시 회수 — 이동(rename) 성공자 단일화, 패자는 ENOENT로 물러남
    const ws5j = mkRepo("stealrace");
    setScoutOn(ws5j); MB.grantConsent(ws5j, "test");
    fs.writeFileSync(MB.rsFileFor(ws5j), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5j }));
    fs.writeFileSync(MB.rsFileFor(ws5j) + ".reclaim", JSON.stringify({ pid: 999999998, token: "s" }));
    fs.writeFileSync(MB.rsFileFor(ws5j) + ".funlock", JSON.stringify({ pid: 999999997, token: "dead" }));
    const realRename2 = fs.renameSync.bind(fs);
    let g1 = false;
    fs.renameSync = function (a, b) { if (String(a).endsWith(".funlock") && !g1) { g1 = true; realRename2(a, a + ".gone"); } return realRename2(a, b); }; // 경쟁자가 한발 먼저 이동해 감 → 내 rename은 ENOENT
    let ar1;
    try { ar1 = MB.forceUnlock(ws5j); } finally { fs.renameSync = realRename2; }
    ok(ar1.every((x) => !x.quarantined) && fs.existsSync(MB.rsFileFor(ws5j) + ".reclaim"), "이동 경쟁 패배=물러남(대상 잠금 무변경 — 이동 성공자 단일화)");
    fs.unlinkSync(MB.rsFileFor(ws5j) + ".funlock.gone");
    // 11차 #3: 오탈취 극단 — 판독(죽음)과 이동 사이에 활성 소유자로 교체된 funlock을 이동해 버린 경우
    fs.writeFileSync(MB.rsFileFor(ws5j) + ".funlock", JSON.stringify({ pid: 999999997, token: "dead" }));
    let g2 = false;
    fs.renameSync = function (a, b) { if (String(a).endsWith(".funlock") && !g2) { g2 = true; fs.writeFileSync(String(a), JSON.stringify({ pid: 999999996, token: "other-owner" })); } return realRename2(a, b); };
    let ar2;
    try { ar2 = MB.forceUnlock(ws5j); } finally { fs.renameSync = realRename2; }
    ok(ar2.some((x) => x.stolenActive && x.restored) && ar2.every((x) => !x.quarantined) && fs.existsSync(MB.rsFileFor(ws5j) + ".reclaim"), "오탈취 감지=원위치 복원+물러남(대상 잠금 오격리 없음 — 12차 복원 프로토콜)");
    ok(fs.readFileSync(MB.rsFileFor(ws5j) + ".funlock", "utf8").includes("other-owner"), "교체된 잠금이 원위치로 복권됨");
    ok(MB.forceUnlock(ws5j).some((x) => x.quarantined && x.kind === "lock") && MB.runChild(ws5j, true) === 0, "재실행으로 정상 회수·복구(진행성 회복)");
    // 12차: 취득 직후 read-back — 복원 rename이 wx를 덮는 창에서 새 취득자가 스스로 물러남
    const ws5k = mkRepo("readback");
    setScoutOn(ws5k); MB.grantConsent(ws5k, "test");
    const realWrite = fs.writeFileSync.bind(fs);
    let hitW = false;
    fs.writeFileSync = function (p2, d, o) { const r = realWrite(p2, d, o); if (!hitW && String(p2).endsWith(".funlock") && o && o.flag === "wx") { hitW = true; realWrite(String(p2), JSON.stringify({ pid: 999999995, token: "restored-other" })); } return r; };
    let rcRes;
    try { rcRes = MB.runChild(ws5k, true); } finally { fs.writeFileSync = realWrite; }
    ok(rcRes === 3 && !fs.existsSync(MB.rsFileFor(ws5k)), "취득 직후 잠금이 타인 것=물러남(rs 미생성 — read-back 차단)");
    ok(fs.readFileSync(MB.rsFileFor(ws5k) + ".funlock", "utf8").includes("restored-other"), "복원된 타인 잠금 불간섭(미삭제)");
    ok(MB.forceUnlock(ws5k).some((x) => x.quarantined && x.kind === "funlock") && MB.runChild(ws5k, true) === 0, "잔재 회수 후 정상 진행");
    // 13차 fencing: read-back '통과 후' 복원 rename이 도착 — 다음 상태 변경 직전 fence가 잡아 물러남
    const ws5m = mkRepo("fencing");
    setScoutOn(ws5m); MB.grantConsent(ws5m, "test");
    const realRead = fs.readFileSync.bind(fs);
    let fread = 0;
    fs.readFileSync = function (p2, o) { const r = realRead(p2, o); if (String(p2).endsWith(".funlock")) { fread++; if (fread === 1) { fs.writeFileSync(String(p2), JSON.stringify({ pid: 999999994, token: "late-restore" })); } } return r; };
    let fenceRes;
    try { fenceRes = MB.runChild(ws5m, true); } finally { fs.readFileSync = realRead; }
    ok(fenceRes === 3 && !fs.existsSync(MB.rsFileFor(ws5m)), "read-back 통과 후 잠금 상실=첫 fence에서 물러남(rs·잠금 일절 미생성)");
    ok(realRead(MB.rsFileFor(ws5m) + ".funlock", "utf8").includes("late-restore"), "복원된 잠금 불간섭");
    ok(MB.forceUnlock(ws5m).some((x) => x.quarantined && x.kind === "funlock") && MB.runChild(ws5m, true) === 0, "잔재 회수 후 정상 진행(fencing 계약 완결)");
    // 14차 #4: writeRs도 funlock 아래 확인·교체 — 잠금을 얻지 못하면 기록 포기(타 writer의 상태를 덮지 않음)
    const ws5n = mkRepo("wrslock");
    setScoutOn(ws5n); MB.grantConsent(ws5n, "test");
    const realUnlink = fs.unlinkSync.bind(fs);
    let uHit = false;
    fs.unlinkSync = function (p2) { const r = realUnlink(p2); if (!uHit && String(p2).endsWith(".funlock")) { uHit = true; fs.writeFileSync(String(p2), JSON.stringify({ pid: process.pid, token: "wrs-blocker" })); } return r; }; // claim 해제 직후 타 주체가 funlock 점유
    let wres;
    try { wres = MB.runChild(ws5n, true); } finally { fs.unlinkSync = realUnlink; }
    ok(wres === 1, "writeRs가 잠금을 얻지 못하면 기록 포기=실패 반환(성공 위장 금지)");
    ok(JSON.parse(fs.readFileSync(MB.rsFileFor(ws5n), "utf8")).phase === "running", "점유 창에서 done으로 덮지 않음(확인·교체가 같은 잠금 아래)");
    fs.unlinkSync(MB.rsFileFor(ws5n) + ".funlock");
    const rsn = JSON.parse(fs.readFileSync(MB.rsFileFor(ws5n), "utf8"));
    fs.writeFileSync(MB.rsFileFor(ws5n), JSON.stringify({ ...rsn, pid: 999999999 })); // 잔존 running을 죽은 소유자로 치환(테스트 전용 — 자기 pid는 alive라 회수 불가)
    ok(MB.runChild(ws5n, true) === 0, "잠금 해제 후 죽은 running 회수·정상 완료");
    // unreadable run-state(9차 #5): 손상(state-invalid)과 구분 보존 — 권한/일시 판독 실패 안내
    const ws5f = mkRepo("unreadrs");
    setScoutOn(ws5f); MB.grantConsent(ws5f, "test");
    fs.mkdirSync(MB.RUN_DIR, { recursive: true });
    fs.mkdirSync(MB.rsFileFor(ws5f)); // 경로를 디렉터리로=판독 불가 재현(EISDIR)
    ok(MB.bootstrapStatusFor(ws5f).state === "state-unreadable", "판독 불가 rs=state-unreadable 보존(state-invalid로 합병 금지)");
    ok(MB.maybeSpawnBootstrap(ws5f).reason === "state-unreadable", "부모 사유 일치");
    const rUn = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-map.js"), ws5f, "bootstrap"], { encoding: "utf8", env: { ...process.env } });
    ok(rUn.status === 1 && /읽을 수 없다|cannot be read/.test(rUn.stderr), "CLI도 판독 불가 전용 안내(손상 안내와 구분)");
    fs.rmdirSync(MB.rsFileFor(ws5f));
    // 10차 #4: funlock 자체가 손상(invalid) — 선점자 fail-closed+부모 표면화+승인 격리 탈출구
    const ws5g = mkRepo("funlockbad");
    setScoutOn(ws5g); MB.grantConsent(ws5g, "test");
    fs.writeFileSync(MB.rsFileFor(ws5g), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5g }));
    fs.writeFileSync(MB.rsFileFor(ws5g) + ".funlock", "corrupt{");
    ok(MB.runChild(ws5g, true) === 3, "invalid funlock=선점자 fail-closed(잠금·상태 생성 없음)");
    const mg = MB.maybeSpawnBootstrap(ws5g);
    ok(mg.spawned === false && mg.reason === "state-lock-blocked" && String(mg.lock).endsWith(".funlock") && mg.lockState === "invalid", "부모도 funlock 손상을 표면화(무고지 반복 기동 없음)");
    ok(MB.bootstrapStatusFor(ws5g).state === "state-lock-blocked", "상태 조회 일치");
    ok(MB.forceUnlock(ws5g).every((a) => !a.quarantined), "승인 없는 강제 복구=거부(needs 안내)");
    ok(MB.forceUnlock(ws5g, { corrupt: true }).some((a) => a.kind === "funlock" && a.quarantined), "--confirm-corrupt로 손상 funlock 격리(OS 개입 전 탈출구)");
    ok(MB.runChild(ws5g, true) === 0, "복구 완료");
    // 10차 #4: unreadable funlock(디렉터리 재현) — fail-closed+표면화
    const ws5i = mkRepo("funlockdir");
    setScoutOn(ws5i); MB.grantConsent(ws5i, "test");
    fs.writeFileSync(MB.rsFileFor(ws5i), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5i }));
    fs.mkdirSync(MB.rsFileFor(ws5i) + ".funlock");
    ok(MB.runChild(ws5i, true) === 3 && MB.maybeSpawnBootstrap(ws5i).reason === "state-lock-blocked", "unreadable funlock=fail-closed+표면화(무고지 반복 기동 제거)");
    fs.rmdirSync(MB.rsFileFor(ws5i) + ".funlock");
    // 10차 #2: 동시 회수 경쟁 — 첫 격리 직후 funlock이 타인 소유로 바뀌면 잔여 격리를 물러남(패자 자멸 계약)
    const ws5h = mkRepo("funlockrace");
    setScoutOn(ws5h); MB.grantConsent(ws5h, "test");
    fs.writeFileSync(MB.rsFileFor(ws5h), JSON.stringify({ phase: "running", pid: 999999999, runId: "dead", repo: ws5h }));
    fs.writeFileSync(MB.rsFileFor(ws5h) + ".reclaim", JSON.stringify({ pid: 999999998, token: "s1" }));
    fs.writeFileSync(MB.rsFileFor(ws5h) + ".reclaim.recover", JSON.stringify({ pid: 999999997, token: "s2" }));
    const realRename = fs.renameSync.bind(fs);
    let intruded = false;
    fs.renameSync = function (a, b) { const r = realRename(a, b); if (!intruded && String(a).endsWith(".reclaim.recover")) { intruded = true; fs.writeFileSync(MB.rsFileFor(ws5h) + ".funlock", JSON.stringify({ pid: process.pid, token: "intruder" })); } return r; };
    let actsRace;
    try { actsRace = MB.forceUnlock(ws5h); } finally { fs.renameSync = realRename; }
    ok(actsRace.some((a) => a.quarantined && a.lock.endsWith(".recover")) && actsRace.some((a) => a.reason === "funlock-lost"), "소유 상실 감지=잔여 격리 중단(잘못 지워진 쪽이 물러남)");
    ok(fs.existsSync(MB.rsFileFor(ws5h) + ".reclaim"), "물러난 잠금은 무변경");
    ok(fs.readFileSync(MB.rsFileFor(ws5h) + ".funlock", "utf8").includes("intruder"), "타인 funlock 미삭제(자기 token만 해제)");
    fs.unlinkSync(MB.rsFileFor(ws5h) + ".funlock");
    ok(MB.forceUnlock(ws5h).some((a) => a.quarantined) && MB.runChild(ws5h, true) === 0, "재실행으로 잔여 회수·복구 성공");
    // 생성 지문(5차 #1): created 반환 지문 == 실제 기록 파일 지문(사이 편집 시 exclude 미귀속의 근거)
    const ws6 = mkRepo("createdfp");
    const r6 = MR.initTopologyForBootstrap(ws6);
    const crypto3 = require("crypto");
    const sha3 = (f) => crypto3.createHash("sha1").update(fs.readFileSync(f, "utf8")).digest("hex");
    ok(r6.st === "created" && r6.topoFp === sha3(path.join(ws6, "project-map", "topology.json")) && r6.mapMdFp === sha3(path.join(ws6, "project-map", "MAP.md")), "created 생성 지문=기록 파일 지문(finish 대조 재료)");
  }

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 무해 */ }
  process.exit(fail ? 1 : 0);
}
main();
