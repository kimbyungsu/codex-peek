/*
 * P1 — Project MAP 비차단 bootstrap 생명주기(설계 정본: docs/MAP-V2-DESIGN.md 1-3·1-7·1-17·1-23·1-33·§5 P1).
 * 역할: 3트랙에서 topology가 없으면 대화를 막지 않고 백그라운드(detached 자식)로 결정론 draft를 만들고,
 * 완료 시 의미 보강 대기 큐를 남긴다(소비는 P5). 훅/확장(부모)은 '유계 신호+상태 고지+기동'만 한다.
 *
 * 동의(1-23 — 1차 검증 #1): 자동 생성은 영속 동의 표식(consent-<repoKey>.json)이 있어야만 한다.
 * 표식은 ①대시보드 off→on 전환 모달 승인 ②사용자의 명시 명령(`scope-map <repo> bootstrap` — 실행 자체가 동의)
 * 에서 기록된다. 업데이트 전부터 3트랙이 켜져 있던 프로젝트는 표식이 없으므로 pending-consent로 고지만 한다
 * (무동의 저장소 파일 생성 0).
 *
 * 정확히 1회(1-7): 자식이 run-state를 wx로 선점한 쪽만 무거운 스캔에 진입(선점 실패 자식은 스캔 전 종료).
 * fail-closed(1차 검증 #2): run-state 판독은 부재/손상/권한 3분기 — 손상·권한은 교체 후보가 아니라 선점 실패
 * (수동 manual만 복구 교체). 회수(.reclaim)는 pid+토큰 소유권, 자기 토큰일 때만 해제. 모든 상태 전이는
 * runId CAS(소유 상실 시 중단). init 자체의 fail-closed 잠금이 최종 방어.
 *
 * done 전이(1차 검증 #4): topology 유효+뷰 정합+큐 실존·내용 검증+지문 확보+기록 성공이 전부 확인될 때만.
 * failed는 자동 재기동 무조건 금지(1차 검증 #5 — topology 유무 무관·수동만), blocked는 대상 파일이 남아있는
 * 동안만 억제(사용자가 삭제로 복구하면 absent 경로 재개).
 *
 * verify-guard 예외 귀속(1차 검증 #6): run-state.exclude에는 '이번 실행이 생성·교체한 파일'만 기록 —
 * ensure(backfill)가 사람이 만든 topology를 자동 산출물로 소급 인정하지 않는다.
 *
 * 저장 위치(하네스 로컬): BRIDGE_DIR/map-bootstrap/<repoKey>.json(run-state)·consent-<repoKey>.json(동의)·
 * ws-<wsKey>.json(트리거③ lastResolvedRepo)·advice-<wsKey>.json(고지 1회 서명),
 * BRIDGE_DIR/map-enrich-queue/<repoKey>.json(보강 대기 — 전환 스키마 v0: basis 결속·경계 불일치 시 자식이 재작성.
 * 브랜치별 파일 분리는 P2 승격). repoKey=realpath 기준(1-29).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const CL = require(path.join(__dirname, "contract-lib.js"));

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const RUN_DIR = path.join(BRIDGE_DIR, "map-bootstrap");
const QUEUE_DIR = path.join(BRIDGE_DIR, "map-enrich-queue");
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }; // junction/symlink 별칭 수렴(1-29)
const repoKeyFor = (repo) => sha1(CL.normWs(realOf(repo))).slice(0, 16);
const rsFileFor = (repo) => path.join(RUN_DIR, repoKeyFor(repo) + ".json");
const queueFileFor = (repo) => path.join(QUEUE_DIR, repoKeyFor(repo) + ".json");
const consentFileFor = (repo) => path.join(RUN_DIR, "consent-" + repoKeyFor(repo) + ".json");
const tB = (ko, en) => (CL.loadLang() === "en" ? en : ko);

// 판독 3분기 — 부재/손상·권한을 null로 뭉개지 않는다(1차 검증 #2: 손상을 '교체 가능'으로 오판 금지)
function readJson3(f) {
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? { st: "absent" } : { st: "unreadable" }; }
  try { const d = JSON.parse(raw); return d && typeof d === "object" && !Array.isArray(d) ? { st: "ok", data: d } : { st: "invalid" }; } catch { return { st: "invalid" }; } // 배열도 invalid(2차 #1)
}
// pid 3분 판정 — ESRCH만 dead, EPERM=존재(권한 없음), 그 외=unknown(자동 회수 금지)
function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try { process.kill(pid, 0); return "alive"; }
  catch (e) { return e && e.code === "ESRCH" ? "dead" : (e && e.code === "EPERM" ? "alive" : "unknown"); }
}

// 잠금 판정 4상태(7차): 삭제·회수는 dead-valid(정상 JSON+죽은 pid)에서만 — invalid/unreadable은 보유자
// 사망을 입증할 수 없고(활성 프로세스 잠금의 부분 기록·일시 판독 실패일 수 있음), unknown pid는 보유 중 취급.
function lockStateOf(x) {
  if (x.st !== "ok") return x.st; // absent | invalid | unreadable
  if (!Number.isInteger(x.data.pid) || x.data.pid <= 0 || typeof x.data.token !== "string") return "invalid"; // 스키마 위반=손상
  const pv = pidState(x.data.pid);
  return pv === "dead" ? "dead-valid" : (pv === "alive" ? "alive" : "owner-unverified"); // unknown=사망도 생존도 입증 불가(8차) — 자동 기동 차단+표면화, 회수·격리 금지
}

// 강제 복구(8~11차): 손상·잔존 잠금을 사용자가 손으로 rm 하게 안내하면 판정 없는 삭제가 상호배제를 깬다 —
// 이 함수가 판정을 재확인한 뒤 격리(rename — 감사 흔적 보존)한다. 승인 사다리:
//   dead-valid              → 즉시 격리(사망 재확인+pid·token 동일).
//   invalid(잠금/rs/funlock) → --confirm-corrupt 승인 시만('활성 작업 부재'는 운영자 확인 사항 — §5 P1 계약).
//   owner-unverified        → --confirm-owner-dead 승인 시만(OS 수준 프로세스 부재 확인 전제).
//   alive / unreadable      → 항상 거부.
// .funlock의 성격(11차 확정): childClaim과 forceUnlock이 '실제로 취득'하는 공용 mutex — 협력 경로에서는
// 선점 전이·격리 작업 전체가 같은 잠금 아래 실행돼 검증→격리 사이에 새 잠금·상태가 생기지 않는다. 잔재
// 회수의 사망 재검증은 판독~이동 사이 교체를 이동 '후' 발견하므로(오탈취→복원), 살아있는 보유자 보호는
// '탈취 불가'가 아니라 '재검증 성공 범위에서의 복원+상대의 fence 물러남'이다(15차 표현 정정 — §5 P1 보장 수준).
// 잔재 회수(11차 #2): unlink가 아니라 '고유 격리명으로의 원자 이동(rename)' — 이동에 성공한 단일 복구자만
// 취득을 시도하고, 이동해 온 파일이 자기가 판독한 그 잔재인지 재검증한다. 오탈취(그새 교체된 잠금을 이동)면
// 진행하지 않고 보고 — 협력 경로에서 상대는 보유 재확인(fence) 실패로 물러나며, 검증~쓰기의 시스템콜 간극이 겹치는 예외 경합의 잔여는 §5 P1 보장 수준 문단이 계약으로 한정한다.
function funlockFileFor(repo) { return rsFileFor(repo) + ".funlock"; }
function forceUnlock(repo, confirms) {
  const cf = confirms || {};
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const fl = funlockFileFor(repo);
  const tok = crypto.randomBytes(8).toString("hex");
  const acts = [];
  const quarantine = (f, kind, state) => {
    const to = f + ".quarantined." + crypto.randomBytes(4).toString("hex");
    try { fs.renameSync(f, to); acts.push({ kind, lock: f, state, quarantined: true, to }); return true; }
    catch { acts.push({ kind, lock: f, state, quarantined: false }); return false; }
  };
  const acquire = () => {
    try { fs.writeFileSync(fl, JSON.stringify({ pid: process.pid, token: tok }), { flag: "wx" }); } catch { return false; }
    const rb = readJson3(fl); // 취득 직후 재확인(12차): 오탈취 복원 rename이 wx를 덮었으면 물러난다(남은 파일=복원된 타인 잠금 — 불간섭)
    return rb.st === "ok" && rb.data.pid === process.pid && rb.data.token === tok;
  };
  // 잔재 회수: 이동 성공자 단일화(11차 #2 — Codex 계약 ①이동 ②단일 취득 시도 ③선취 시 물러남)
  const stealFunlock = (expectSt) => {
    const first = readJson3(fl);
    if (lockStateOf(first) !== expectSt) return { ok: false, state: lockStateOf(first) };
    const to = fl + ".quarantined." + crypto.randomBytes(4).toString("hex");
    try { fs.renameSync(fl, to); } catch { return { ok: false, state: lockStateOf(readJson3(fl)) }; } // 이동 경쟁 패배
    const moved = readJson3(to);
    const same = lockStateOf(moved) === expectSt && (expectSt === "invalid" || (moved.st === "ok" && first.st === "ok" && moved.data.pid === first.data.pid && moved.data.token === first.data.token));
    if (!same) {
      // 오탈취(그새 교체된 잠금을 이동) = 즉시 원위치 복원(12차 #6 옵션③). 복원 rename이 새 wx 취득을 덮는
      // 경우: read-back 전 도착=read-back이 검출, 이후 도착=다음 fence가 대부분 검출, fence 통과~쓰기 간극은
      // 문서화된 잔여(§5 P1 보장 수준). 덮인 취득자는 검증 시점에 물러나고 원 보유자 잠금이 복권된다.
      let restored = false;
      try { fs.renameSync(to, fl); restored = true; } catch { /* 복원 실패 — to 경로를 보고로 표면화 */ }
      // Node fs.renameSync는 POSIX·Windows 모두 기존 목적지를 교체한다(libuv MOVEFILE_REPLACE_EXISTING) —
      // 복원이 새 취득을 덮는 경우는 read-back·fence가 위 3분기 계약대로 검출한다(13·16차 — 간극은 §5 P1).
      return { ok: false, state: lockStateOf(readJson3(fl)), stolenActive: true, restored, to: restored ? null : to };
    }
    return { ok: true, to };
  };
  if (!acquire()) {
    const st = lockStateOf(readJson3(fl));
    let r;
    if (st === "dead-valid") r = stealFunlock("dead-valid");
    else if (st === "invalid" && cf.corrupt) r = stealFunlock("invalid");
    else if (st === "owner-unverified" && cf.ownerDead) r = stealFunlock("owner-unverified");
    else return [{ kind: "funlock", lock: fl, state: st, quarantined: false, needs: st === "invalid" ? "--confirm-corrupt" : (st === "owner-unverified" ? "--confirm-owner-dead" : null) }];
    if (!r.ok) { acts.push({ kind: "funlock", lock: fl, state: r.state, quarantined: false, stolenActive: !!r.stolenActive, restored: !!r.restored, to: r.to || null }); return acts; }
    acts.push({ kind: "funlock", lock: fl, state: st, quarantined: true, to: r.to });
    if (!acquire()) { acts.push({ kind: "funlock", lock: fl, state: lockStateOf(readJson3(fl)), quarantined: false }); return acts; } // 이동~취득 사이 선취=물러남(계약 ③)
  }
  const own = () => { const h = readJson3(fl); return h.st === "ok" && h.data.pid === process.pid && h.data.token === tok; };
  try {
    for (const suf of [".reclaim.recover", ".reclaim"]) {
      const f = rsFileFor(repo) + suf;
      const first = readJson3(f);
      const st1 = lockStateOf(first);
      if (st1 === "absent") continue;
      const needs = st1 === "invalid" ? "--confirm-corrupt" : (st1 === "owner-unverified" ? "--confirm-owner-dead" : null);
      const allowed = st1 === "dead-valid" || (st1 === "invalid" && cf.corrupt) || (st1 === "owner-unverified" && cf.ownerDead);
      if (!allowed) { acts.push({ kind: "lock", lock: f, state: st1, quarantined: false, needs }); continue; }
      const again = readJson3(f); // 격리 직전 재판독(funlock 관측 게이트+wx 생성 성질 하 — 위 머리말)
      const st2 = lockStateOf(again);
      const same = st2 === st1 && (st1 === "invalid" || (again.data.pid === first.data.pid && again.data.token === first.data.token));
      if (!same) { acts.push({ kind: "lock", lock: f, state: st2, quarantined: false }); continue; }
      if (!own()) { acts.push({ kind: "lock", lock: f, state: st1, quarantined: false, reason: "funlock-lost" }); break; } // 보유 재확인 — 실취득 mutex로 주 창은 소멸(11차), 극단 방어의 이중화. '이미 수행한 격리=멱등이라 무해'로 일반화하지 않는다 — 물러남이 계약
      quarantine(f, "lock", st1);
    }
    // 손상 run-state(9차 #3): 승인 하에만 격리
    const rf = rsFileFor(repo);
    const rsr = readJson3(rf);
    if (rsr.st === "invalid" || (rsr.st === "ok" && !rsValid(rsr.data))) {
      if (!cf.corrupt) acts.push({ kind: "run-state", lock: rf, state: "invalid", quarantined: false, needs: "--confirm-corrupt" });
      else if (!own()) acts.push({ kind: "run-state", lock: rf, state: "invalid", quarantined: false, reason: "funlock-lost" });
      else quarantine(rf, "run-state", "invalid");
    } else if (rsr.st === "unreadable") acts.push({ kind: "run-state", lock: rf, state: "unreadable", quarantined: false });
  } finally {
    try { const h = readJson3(fl); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(fl); } catch { /* 무해 */ }
  }
  return acts;
}

// ── 동의 표식(1-23) ────────────────────────────────────────────────────────────
function hasConsent(repo) { const c = readJson3(consentFileFor(repo)); return c.st === "ok" && c.data.version === 1 && typeof c.data.at === "string"; } // 내용 계약 검증(2차 #1: {}·[]가 동의로 통과 금지)
function grantConsent(repo, from) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  return CL.atomicWrite(consentFileFor(repo), JSON.stringify({ version: 1, at: new Date().toISOString(), from: from || "unknown" }));
}

// ── 실행 기준(basis) — PatchBasis 동형(비-git tagged union · Git 전용 계약 금지: 설계 1-1) ─────
function basisFor(repo) {
  const g = (args) => { try { const r = spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", timeout: 3000, windowsHide: true }); return r.status === 0 ? String(r.stdout || "").trim() : null; } catch { return null; } };
  const head = g(["rev-parse", "HEAD"]);
  if (!head) return { kind: "historyless" }; // fp 2종은 topology를 아는 시점(자식)에 채운다 — fillHistorylessFp
  const branch = g(["rev-parse", "--abbrev-ref", "HEAD"]);
  const common = g(["rev-parse", "--git-common-dir"]);
  return { kind: "git", head, branch: branch === "HEAD" ? null : branch, detachedHead: branch === "HEAD" ? head : null, gitCommonReal: common ? realOf(path.isAbsolute(common) ? common : path.join(repo, common)) : null };
}
// historyless의 PatchBasis 동형 실기록(1차 검증 #3): basisFp=지도 지문, inventoryFp=인벤토리 깊은 정렬 지문(v0 —
// P2가 '작업 내용 기준' 정의로 재정의). PM은 호출자(자식)가 전달 — 부모 경로에서 topology 파싱 금지 유지.
function fillHistorylessFp(basis, topo, PM) {
  if (!basis || basis.kind !== "historyless" || !topo) return basis;
  return { kind: "historyless", basisFp: PM.mapHashOf(topo), inventoryFp: PM.opHashOf(topo.inventory) };
}
function sameBasisBoundary(a, b) { // 브랜치/워크트리 경계 동일성(HEAD 전진은 허용 — hard reject는 경계 이탈만: 1-1)
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "historyless") return true;
  return a.branch === b.branch && (a.branch !== null || a.detachedHead === b.detachedHead) && a.gitCommonReal === b.gitCommonReal;
}

// 큐 소형 검증(부모용 — 유계: 소형 JSON 파싱만. 내용 정합[mapHash·basis]은 자식이 판정)
function queueLooksSane(repo) {
  const q = readJson3(queueFileFor(repo));
  return q.st === "ok" && q.data.schema === "enrich-queue-v0" && typeof q.data.mapId === "string";
}

// 부모용 신선 판정(2차 #2 — 유계 유지): sane + 큐에 기록된 topology stat(mtime·size)과 현재 파일 stat 일치.
// 불일치=topology가 그 뒤 바뀜 → ensure 재평가(자식이 정합이면 재작성 생략 — 거짓 양성 무해). 구형 큐(topoStat
// 없음)도 재작성 유도. ⚠브랜치 전환만으로 파일이 동일하면 못 잡는다 — 큐 브랜치별 분리(P2)의 명시 한계.
function queueFresh(repo, topoPath) {
  const q = readJson3(queueFileFor(repo));
  if (!(q.st === "ok" && q.data.schema === "enrich-queue-v0" && typeof q.data.mapId === "string")) return false;
  if (!q.data.topoStat) return false;
  try { const st = fs.statSync(topoPath); return st.mtimeMs === q.data.topoStat.mtimeMs && st.size === q.data.topoStat.size; } catch { return false; }
}

// ── 부모 게이트(유계 — 훅에서 매 턴: 계약 로드+existsSync+소형 JSON 3개+stat 1회. 전체 topology 파싱 금지) ──
function parentSignals(ws) {
  const c = CL.loadContract(ws);
  if (CL.normScoutMode(c) !== "on") return null; // 2트랙 = 완전 무접촉(파일 생성 0·spawn 0)
  const repo = (CL.resolveScoutRepo(ws, c) || {}).repo || ws; // 계약 동봉 필수(시그니처 (ws,c))
  const topoPath = path.join(repo, "project-map", "topology.json");
  const rl = readJson3(rsFileFor(repo) + ".reclaim");
  const rc = readJson3(rsFileFor(repo) + ".reclaim.recover");
  const stuckOf = (x) => { const st = lockStateOf(x); return st === "absent" || st === "alive" ? null : st; };
  const rcSt = stuckOf(rc), rlSt = stuckOf(rl);
  const fkSt = lockStateOf(readJson3(rsFileFor(repo) + ".funlock"));
  const funlockActive = fkSt === "alive"; // 강제 복구 진행 중(짧음) — 조용히 spawn 보류(10차 #4)
  const fkStuck = fkSt !== "absent" && fkSt !== "alive" ? fkSt : null; // dead-valid 포함(11차 — 선점자도 funlock을 실취득하므로 잔재=자동 경로 정지, 회수는 forceUnlock)
  const stuckLock = fkStuck ? rsFileFor(repo) + ".funlock" : (rcSt ? rsFileFor(repo) + ".reclaim.recover" : (rlSt ? rsFileFor(repo) + ".reclaim" : null));
  const stuckState = fkStuck || rcSt || rlSt; // dead-valid|invalid|unreadable|owner-unverified — 안내가 판정별로 갈린다(7~10차)
  const reclaimStuck = !!stuckLock; // 죽은/손상 회수·복구 잠금=잔존(자동 회수 없음·경로 표면화)
  return { repo, topoExists: fs.existsSync(topoPath), queueSane: queueFresh(repo, topoPath), rs: readJson3(rsFileFor(repo)), consent: hasConsent(repo), reclaimStuck, stuckLock, stuckState, funlockActive };
}
const RS_PHASES = ["running", "done", "failed", "blocked"];
function rsValid(d) { return !!d && RS_PHASES.includes(d.phase) && Number.isInteger(d.pid) && typeof d.runId === "string"; } // 최소 계약(2차 #1: {}·[]가 유효 상태로 통과 금지)
function rsLiving(rsr) { return rsr.st === "ok" && rsValid(rsr.data) && rsr.data.phase === "running" && pidState(rsr.data.pid) !== "dead"; }

// 트리거③(1-17): ws별 마지막 해석 대상 영속 — 불일치=대상 변경 감지(양쪽 다 topology가 있어도 감지·기록 갱신)
function noteResolvedRepo(ws, repo) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const f = path.join(RUN_DIR, "ws-" + CL.wsKeyFor(ws) + ".json");
    const prev = readJson3(f);
    const cur = realOf(repo);
    if (prev.st !== "ok" || prev.data.lastResolvedRepo !== cur) {
      CL.atomicWrite(f, JSON.stringify({ lastResolvedRepo: cur, at: new Date().toISOString() }));
      return prev.st === "ok" ? prev.data.lastResolvedRepo : null;
    }
    return undefined; // 변경 없음
  } catch { return undefined; }
}

// ── 기동(부모) — spawn 여부와 사유를 반환. 실제 1회 보장은 자식의 wx 선점이 담당. ─────────────
function maybeSpawnBootstrap(ws) {
  const sig = parentSignals(ws);
  if (!sig) return { spawned: false, reason: "two-track" };
  const changedFrom = noteResolvedRepo(ws, sig.repo);
  if (rsLiving(sig.rs)) return { spawned: false, reason: "running", repo: sig.repo };
  if (sig.rs.st === "ok" && !rsValid(sig.rs.data)) return { spawned: false, reason: "state-invalid", repo: sig.repo }; // 스키마 위반=자동 정지(2차 #1 — 매턴 헛spawn 차단)
  if (sig.funlockActive) return { spawned: false, reason: "force-recovery-running", repo: sig.repo }; // 강제 복구 진행 중 — 침묵 보류(수동 주도 상황)
  if (sig.reclaimStuck) return { spawned: false, reason: "state-lock-blocked", repo: sig.repo, lock: sig.stuckLock, lockState: sig.stuckState }; // 잔존 잠금(경로+판정 동봉 — 고지가 대상·방법을 특정)
  const rsd = sig.rs.st === "ok" ? sig.rs.data : null;
  if (rsd && rsd.phase === "running" && pidState(rsd.pid) === "dead" && (rsd.attempts || 0) >= 3) {
    return { spawned: false, reason: "failed", repo: sig.repo, error: tB("자동 재시도 상한(3회) 도달 — 수동 bootstrap으로 복구", "auto-retry limit (3) reached — recover with manual bootstrap") }; // 종결 기록 불능 반복의 폭주 차단(2차 #5)
  }
  if (rsd && rsd.phase === "failed") return { spawned: false, reason: "failed", repo: sig.repo, error: rsd.error }; // 무조건 억제(1차 #5 — topology 유무 무관·수동만)
  if (rsd && rsd.phase === "blocked" && sig.topoExists) return { spawned: false, reason: "blocked", repo: sig.repo, error: rsd.error || rsd.reason }; // 대상 파일이 남아있는 동안만(삭제=복구 → absent 재개)
  if (sig.rs.st === "invalid" || sig.rs.st === "unreadable") return { spawned: false, reason: "state-" + sig.rs.st, repo: sig.repo }; // 손상 상태는 자동 경로 정지(수동 복구)
  const needInit = !sig.topoExists;
  const needEnsure = sig.topoExists && !sig.queueSane; // 큐 부재·손상·스키마 불일치 전부 backfill 대상(1차 #3)
  if (!needInit && !needEnsure) return { spawned: false, reason: "ready", repo: sig.repo, changedFrom };
  if (!sig.consent) return { spawned: false, reason: "pending-consent", repo: sig.repo, changedFrom }; // 무동의 자동 생성 0(1차 #1)
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const child = spawn(process.execPath, [__filename, "run", sig.repo], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { spawned: true, mode: needInit ? "init" : "ensure", repo: sig.repo, changedFrom };
  } catch (e) {
    return { spawned: false, reason: "spawn-failed", repo: sig.repo, error: String(e && e.message || e) };
  }
}

// ── 훅 진입(고지 1회 포함) — contract-inject가 lazy require로 호출(advisory·실패 무해) ─────────
function hookTick(ws) {
  const r = maybeSpawnBootstrap(ws);
  if (!r || r.reason === "two-track" || r.reason === "ready" || r.reason === "running") return maybeNote(ws, r);
  return maybeNote(ws, r);
}
function maybeNote(ws, r) {
  if (!r || r.reason === "two-track") return null;
  if (r.reason === "ready" && !r.changedFrom) return null; // 정상 상태는 무고지(변경 감지 시에만)
  if (r.reason === "running") return null; // 진행 중은 무고지(완료 시 상태가 바뀌며 서명 갱신)
  const sig = (r.spawned ? "spawn:" + r.mode : "state:" + r.reason) + "|" + (r.error || "") + "|" + (r.changedFrom || "");
  const f = path.join(RUN_DIR, "advice-" + CL.wsKeyFor(ws) + ".json");
  const prev = readJson3(f);
  if (prev.st === "ok" && prev.data.sig === sig) return null; // 같은 상태 재고지 억제(시간 상수 0)
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); CL.atomicWrite(f, JSON.stringify({ sig, at: new Date().toISOString() })); } catch { /* 고지 실패 무해 */ }
  const manual = "node scripts/scope-map.js \"" + r.repo + "\" bootstrap";
  const fu = "node scripts/scope-map.js \"" + r.repo + "\" force-unlock";
  if (r.spawned && r.mode === "init") return tB("[Project MAP] 구조 지도가 없어 백그라운드 생성을 시작했다(대화 비차단 — 결정론 스캔·LLM 0·전송 없음).", "[Project MAP] No structure map — background creation started (non-blocking; deterministic scan, no LLM, no network).");
  if (r.spawned && r.mode === "ensure") return tB("[Project MAP] 기존 지도에 의미 보강 대기표를 백그라운드로 채운다(소비는 후속 단계).", "[Project MAP] Backfilling the enrichment queue for the existing map in the background (consumed in a later phase).");
  if (r.reason === "pending-consent") return tB("[Project MAP] 3트랙이 켜져 있지만 지도 자동 생성은 사전 동의가 필요하다 — 동의하려면 직접 실행: " + manual + " (실행 자체가 동의로 기록됨. 대시보드에서 3트랙을 껐다 켜며 승인해도 된다.)", "[Project MAP] 3-track is on, but map auto-creation needs prior consent — to consent, run: " + manual + " (running it records consent; re-enabling 3-track in the dashboard also works).");
  if (r.reason === "failed") return tB("[Project MAP] 자동 생성 실패(" + (r.error || "사유 미상") + ") — 기존 3트랙은 정상(degraded). 수동 재시도: " + manual, "[Project MAP] Auto-creation failed (" + (r.error || "unknown") + ") — existing 3-track still works (degraded). Manual retry: " + manual);
  if (r.reason === "blocked") return tB("[Project MAP] 지도 파일이 손상/구버전이라 자동 조치를 하지 않았다(" + (r.error || "") + ") — 확인 후 수동: " + manual, "[Project MAP] Map file is corrupted/legacy; no automatic action taken (" + (r.error || "") + ") — inspect, then run: " + manual);
  if (r.reason === "spawn-failed") return tB("[Project MAP] 백그라운드 기동 실패(" + (r.error || "") + ") — 수동: " + manual, "[Project MAP] Failed to launch background creation (" + (r.error || "") + ") — manual: " + manual);
  if (r.reason === "state-lock-blocked") {
    if (r.lockState === "unreadable") return tB("[Project MAP] 잠금 파일을 읽을 수 없다(" + (r.lock || "") + ") — 일시적 판독 실패일 수 있으니 삭제하지 말고 잠시 후 재시도하라. 지속되면 파일 접근 권한을 확인하라.", "[Project MAP] A lock file cannot be read (" + (r.lock || "") + ") — this may be transient; do not delete it, retry shortly. If it persists, check file permissions.");
    if (r.lockState === "owner-unverified") return tB("[Project MAP] 잠금 보유자의 생존을 확인할 수 없다(" + (r.lock || "") + ") — 삭제하지 말고 잠시 후 재시도하라. 계속되면 OS에서 해당 pid의 프로세스가 없음을 직접 확인한 뒤 승인 격리를 실행하라: " + fu + " --confirm-owner-dead", "[Project MAP] The lock holder's liveness cannot be verified (" + (r.lock || "") + ") — do not delete it; retry shortly. If it persists, confirm at the OS level that the pid has no process, then run: " + fu + " --confirm-owner-dead");
    if (r.lockState === "invalid" || lockNeedsManualDelete(r.lock)) return tB("[Project MAP] 잠금이 손상됐거나 2차 잠금이 남아 자동 경로를 멈췄다(" + (r.lock || "") + ") — 직접 지우지 말고 강제 복구를 실행하라: " + fu + " (죽은 보유자로 재확인된 잠금만 즉시 격리한다. 손상 잠금은 사망을 입증할 수 없으므로 활성 프로세스가 없음을 확인한 뒤 " + fu + " --confirm-corrupt 로 승인해야 격리된다.) 격리 후 " + manual + " 로 복구.", "[Project MAP] A corrupted or stale secondary lock halted the auto path (" + (r.lock || "") + ") — do not delete it by hand; run " + fu + " (only locks re-verified as dead-holder are quarantined immediately; a corrupted lock cannot prove death, so confirm no process is active, then approve with " + fu + " --confirm-corrupt). Recover afterwards with " + manual + ".");
    if (r.lockState === "dead-valid" && String(r.lock || "").endsWith(".funlock")) return tB("[Project MAP] 죽은 강제 복구 잔재가 남아 자동 경로를 멈췄다(" + r.lock + ") — " + fu + " 를 실행하면 재확인 후 자체 회수한다.", "[Project MAP] A dead force-recovery lock remains (" + r.lock + ") — run " + fu + "; it re-verifies and reclaims it automatically.");
    return tB("[Project MAP] 회수 잠금이 남아 자동 경로를 멈췄다(" + (r.lock || "") + ") — 직접 지우지 말고 " + manual + " 를 실행하라(보유자 사망을 재확인한 뒤 안전하게 회수한다).", "[Project MAP] A stale reclaim lock halted the auto path (" + (r.lock || "") + ") — do not delete it by hand; run " + manual + " (it re-verifies the holder is dead and reclaims safely).");
  }
  if (r.reason === "state-unreadable") return tB("[Project MAP] 진행 상태 파일을 읽을 수 없다 — 일시적일 수 있으니 잠시 후 재시도하라(지속되면 접근 권한 확인). 자동 경로는 그동안 정지한다.", "[Project MAP] The bootstrap state file cannot be read — this may be transient; retry shortly (check file permissions if it persists). The auto path stays halted meanwhile.");
  if (r.reason === "state-invalid") return tB("[Project MAP] 진행 상태 파일이 손상됐다 — 자동 경로 정지. 활성 자동 생성이 없음을 확인한 뒤 강제 복구: " + fu + " --confirm-corrupt, 이후 " + manual + " 로 재생성.", "[Project MAP] The bootstrap state file is corrupted — auto path halted. Confirm no active creation is running, then force-recover: " + fu + " --confirm-corrupt, and re-create with " + manual + ".");
  if (r.changedFrom) return tB("[Project MAP] 정찰 대상이 바뀌었다(이전: " + r.changedFrom + ") — 새 대상 기준으로 지도 상태를 재평가했다.", "[Project MAP] Scout target changed (was: " + r.changedFrom + ") — map state re-evaluated for the new target.");
  return null;
}

// ── 자식: run-state wx 선점(선점자가 직접 작업 — 1-7) ─────────────────────────────
function childClaim(repo, manual) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const f = rsFileFor(repo);
  // funlock 실취득(11차 #4): 관측이 아니라 선점 전이 전체를 forceUnlock과 같은 mutex 아래 수행 — forceUnlock의
  // 검증→격리 사이에 새 잠금·상태가 생기는 창을 원천 제거. 취득 실패=활성 강제복구/타 선점자/잔재(dead-valid
  // 포함 — 잔재 회수는 forceUnlock 전용이고 부모가 표면화·안내한다).
  const fl0 = f + ".funlock";
  const flTok = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(fl0, JSON.stringify({ pid: process.pid, token: flTok }), { flag: "wx" }); } catch { return null; }
  { const rb = readJson3(fl0); if (!(rb.st === "ok" && rb.data.pid === process.pid && rb.data.token === flTok)) return null; } // 취득 직후 재확인(12차) — 오탈취 복원이 wx를 덮었으면 물러남(남은 파일=복원된 타인 잠금, 불간섭)
  // fencing 계약(13차): read-back '이후'에 복원 rename이 도착하는 순서도 있다 — 임계구역의 모든 상태 변경
  // 직전에 funlock 소유를 재검증하고, 실패하면 그 변경을 수행하지 않고 물러난다(잃은 쪽 전원 물러남 계약).
  const fence = () => { const h = readJson3(fl0); return h.st === "ok" && h.data.pid === process.pid && h.data.token === flTok; };
  try {
    return childClaimUnderFunlock(repo, manual, f, fence);
  } finally {
    try { const h = readJson3(fl0); if (h.st === "ok" && h.data.token === flTok) fs.unlinkSync(fl0); } catch { /* 무해 */ }
  }
}
function childClaimUnderFunlock(repo, manual, f, fence) {
  const rec = { phase: "running", pid: process.pid, runId: crypto.randomUUID(), token: crypto.randomBytes(8).toString("hex"), startedAt: new Date().toISOString(), repo: realOf(repo), attempts: 1 };
  if (!fence()) return null; // fence: rs 신설 직전(13차)
  try { fs.writeFileSync(f, JSON.stringify(rec), { flag: "wx" }); return { rec, prev: null }; } catch { /* 존재/실패 → 아래 조건부 교체 */ }
  const rl = f + ".reclaim";
  // 잔존 회수 잠금(2차 #4): 자동=fail-closed 정지(부모가 state-lock-blocked 고지), 수동만 죽은 보유자 확인 후 정리
  const rlCur = readJson3(rl);
  if (rlCur.st !== "absent") {
    if (!(manual && lockStateOf(rlCur) === "dead-valid")) return null; // 회수=수동+dead-valid만 — 손상 잠금은 사망 입증 불가라 삭제 금지(7차, 부모가 손상 안내)
    // 3차 #3: check-then-unlink 경쟁 봉합 — .recover wx를 얻은 단일 프로세스만 재판독·동일성 확인 후 삭제
    const rc = rl + ".recover";
    const rcTok = crypto.randomBytes(8).toString("hex");
    if (!fence()) return null; // fence: .recover 생성 직전(13차)
    try { fs.writeFileSync(rc, JSON.stringify({ pid: process.pid, token: rcTok }), { flag: "wx" }); } catch { return null; } // 잔존 .recover는 자동 회수하지 않음(4차 #3) — 부모가 state-lock-blocked로 안내·명시 삭제
    try {
      const rlNow = readJson3(rl);
      const sameStale = lockStateOf(rlNow) === "dead-valid" && rlNow.data.token === rlCur.data.token && rlNow.data.pid === rlCur.data.pid;
      if (!sameStale) return null; // 그새 교체/부활/손상 — 사망을 재입증 못 한 잠금은 지우지 않는다(7차)
      if (!fence()) return null; // fence: .reclaim 회수 직전(13차)
      try { fs.unlinkSync(rl); } catch { return null; }
    } finally { try { const h = readJson3(rc); if (h.st === "ok" && h.data.token === rcTok) fs.unlinkSync(rc); } catch { /* 무해 */ } } // 자기 토큰만 해제
  }
  const cur = readJson3(f);
  // fail-closed(1차 #2)+스키마 검증(2차 #1): 손상·권한·스키마 위반은 수동만 복구 교체
  const okRep = (x) =>
    (x.st === "ok" && rsValid(x.data) && ((x.data.phase === "running" && pidState(x.data.pid) === "dead") || x.data.phase === "done" || (manual && (x.data.phase === "failed" || x.data.phase === "blocked"))))
    // 손상 rs(invalid·스키마 위반·판독 불가)는 수동도 교체 금지(9차 #3): .reclaim은 복구자끼리만 직렬화하고
    // 활성 작업자는 선점 직후 해제 후 장시간 작업 — 외부 손상된 활성 rs를 교체하면 무거운 작업이 병존한다.
    // 격리는 force-unlock --confirm-corrupt(활성 작업 부재를 운영자가 확인)만.
    || x.st === "absent";
  if (!okRep(cur)) return null;
  if (!fence()) return null; // fence: .reclaim 생성 직전(13차)
  try { fs.writeFileSync(rl, JSON.stringify({ pid: process.pid, token: rec.token }), { flag: "wx" }); } catch { return null; }
  try {
    const re = readJson3(f); // 잠금 안 재확인
    if (!okRep(re)) return null;
    const prev = re.st === "ok" && rsValid(re.data) ? re.data : null;
    if (prev && prev.phase === "running") rec.attempts = (prev.attempts || 0) + 1; // 죽은 running 교체=시도 횟수 승계(폭주 상한 재료)
    if (!fence()) return null; // fence: rs 교체 직전(13차) — funlock을 잃은 채 상태를 조작하는 경로 차단
    if (!CL.atomicWrite(f, JSON.stringify(rec))) return null; // 기록 실패=선점 실패(무거운 작업 진입 금지)
    return { rec, prev }; // prev=교체 직전 레코드(2차 #3: 교체 후엔 파일에서 읽을 수 없음 — exclude 승계 재료)
  } finally {
    try { const held = readJson3(rl); if (held.st === "ok" && held.data.token === rec.token) fs.unlinkSync(rl); } catch { /* 무해 */ }
  }
}
// 상태 전이 — runId CAS(소유 상실 시 중단: 1차 #2). 반환=기록 성공 여부.
function writeRs(repo, claim, patch) {
  const f = rsFileFor(repo);
  // 14차 #4: runId '확인'과 '교체'를 같은 funlock 아래에서 수행 — 확인~쓰기 사이에 다른 writer가 끼어들어
  // 자기 상태를 덮는 창을 선점 전이와 동일한 mutex 계약으로 좁힌다(오탈취·복원 경로가 경쟁 writer를 만드는
  // 극단 포함). 취득 실패=기록 포기·false(성공 위장 금지 — 호출부가 실패 처리, rs는 dead running으로 남아
  // 다음 주기가 회수한다). funlock은 wx 즉시 실패 방식이라 데드락 없음.
  const fl = f + ".funlock";
  const tok = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(fl, JSON.stringify({ pid: process.pid, token: tok }), { flag: "wx" }); } catch { return false; }
  try {
    const rb = readJson3(fl);
    if (!(rb.st === "ok" && rb.data.pid === process.pid && rb.data.token === tok)) return false; // 취득 직후 재확인(12차와 동일 계약)
    const cur = readJson3(f);
    if (cur.st !== "ok" || cur.data.runId !== claim.runId) return false; // 소유 상실(타 자식이 교체)
    return CL.atomicWrite(f, JSON.stringify({ ...cur.data, ...patch }));
  } finally {
    try { const h = readJson3(fl); if (h.st === "ok" && h.data.token === tok) fs.unlinkSync(fl); } catch { /* 무해 */ }
  }
}
function fileSha(p) { try { return sha1(fs.readFileSync(p, "utf8")); } catch { return null; } }

// 큐 기록/정합(1차 #3·3차 #1): mapHash·topoStat을 '같은 topology 스냅샷'에서 산출 — stat→read→stat 재확인으로
// 결속(읽기 전후 stat이 다르면 1회 재시도 후 실패). 호출자의 topo 객체를 쓰지 않는 이유: 객체 확보와 stat 사이에
// 파일이 교체되면 A의 해시+B의 stat이 한 큐에 저장돼 부모 신선 판정이 영구 오판(3차 반례).
function ensureQueue(repo, PM) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const qf = queueFileFor(repo);
  const tp = path.join(repo, "project-map", "topology.json");
  const snap = () => {
    try {
      const st1 = fs.statSync(tp);
      const raw = fs.readFileSync(tp, "utf8");
      const st2 = fs.statSync(tp);
      if (st1.mtimeMs !== st2.mtimeMs || st1.size !== st2.size) return null; // 읽는 사이 교체됨
      const topo = JSON.parse(raw);
      return { topo, topoStat: { mtimeMs: st2.mtimeMs, size: st2.size } };
    } catch { return null; }
  };
  let sn = snap();
  if (!sn) sn = snap(); // 정상 경합 1회 재시도
  if (!sn || PM.validateTopology(sn.topo).length) return false;
  const nowHash = PM.mapHashOf(sn.topo);
  const basis = fillHistorylessFp(basisFor(repo), sn.topo, PM);
  const cur = readJson3(qf);
  if (cur.st === "ok" && cur.data.schema === "enrich-queue-v0" && cur.data.mapId === sn.topo.mapId && cur.data.mapHash === nowHash && sameBasisBoundary(cur.data.basis, basis)
    && cur.data.topoStat && cur.data.topoStat.mtimeMs === sn.topoStat.mtimeMs && cur.data.topoStat.size === sn.topoStat.size) return true; // 멱등(1-33)
  return CL.atomicWrite(qf, JSON.stringify({
    schema: "enrich-queue-v0", // 전환 스키마: 브랜치별 파일 분리·stale 정밀 판정은 P2 승격
    mapId: sn.topo.mapId, mapHash: nowHash, basis, topoStat: sn.topoStat, queuedAt: new Date().toISOString(), provider: null,
  }, null, 2));
}

// ── 자식 본체 — 상태별 처리. done은 산출물 전부 확인된 경우에만(1차 #4). ───────────────
function runChild(repo, manual) {
  const cl = childClaim(repo, manual);
  if (!cl) return 3;
  const claim = cl.rec; // 선점 실패 = 타 자식 작업 중/손상(자동 경로 정지) — 스캔 전 종료
  const MR = require(path.join(__dirname, "map-runtime.js"));
  const basis0 = basisFor(repo);
  const TOPO = path.join(repo, "project-map", "topology.json");
  const VIEW = path.join(repo, "project-map", "MAP.md");
  // 완료 트랜잭션(4차 #1): init·render와 같은 정본 잠금 안에서 '한 번 읽은 raw'를 기준으로 MAP 정합·복구·
  // 큐·지문을 전부 산출 — 잠금 밖 독립 재판독들이 서로 다른 topology 세대를 섞던 반례(A의 run-state+B의 큐) 차단.
  // topology 자체는 재기록하지 않는다(ensure가 사람 산출물을 건드리면 소급 exclude 문제 재발 — MAP.md만 복구).
  const finishDone = (excludeOf) => {
    const w = MR.withMapLock(repo, () => {
      let raw, st;
      try { st = fs.statSync(TOPO); raw = fs.readFileSync(TOPO, "utf8"); } catch { return { err: "topology 판독 실패" }; }
      let topo;
      try { topo = JSON.parse(raw); } catch { return { err: "topology 파싱 실패" }; }
      if (MR.PM.validateTopology(topo).length) return { err: "topology 스키마 위반" };
      const view = MR.PM.renderMapMd(topo);
      let mdCur = null;
      try { mdCur = fs.readFileSync(VIEW, "utf8"); } catch { /* 부재=복구 */ }
      let rendered = false;
      if (mdCur !== view) {
        try { const tmp = VIEW + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, view, "utf8"); fs.renameSync(tmp, VIEW); rendered = true; }
        catch { return { err: "MAP.md 렌더 복구 실패" }; }
      }
      const topoStat = { mtimeMs: st.mtimeMs, size: st.size };
      const basis = fillHistorylessFp(basisFor(repo), topo, MR.PM);
      const qOk = CL.atomicWrite(queueFileFor(repo), JSON.stringify({
        schema: "enrich-queue-v0", mapId: topo.mapId, mapHash: MR.PM.mapHashOf(topo), basis, topoStat, queuedAt: new Date().toISOString(), provider: null,
      }, null, 2));
      if (!qOk) return { err: "보강 큐 기록 실패" };
      return { mapId: topo.mapId, topoFp: sha1(raw), mapMdFp: sha1(view), rendered };
    });
    if (!w.ok) { writeRs(repo, claim, { phase: "failed", error: "정본 잠금 실패: " + (w.error || ""), doneAt: new Date().toISOString() }); return 1; }
    if (w.result && w.result.err) { writeRs(repo, claim, { phase: "failed", error: w.result.err, doneAt: new Date().toISOString() }); return 1; }
    const r0 = w.result;
    const okRs = writeRs(repo, claim, { phase: "done", doneAt: new Date().toISOString(), mapId: r0.mapId, topoFp: r0.topoFp, mapMdFp: r0.mapMdFp, exclude: excludeOf(r0) });
    return okRs ? 0 : 1; // 기록 실패·소유 상실=성공 위장 금지
  };
  try {
    const rt = MR.readTopoExFor(repo);
    if (rt.st === "ok") {
      const errs2 = MR.PM.validateTopology(rt.topo);
      if (errs2.length === 0) { // 기존 유효 v2 → 큐 backfill(+뷰 복구는 finishDone 잠금 안에서)
        return finishDone((r0) => {
          // 이번 실행 산출물만 exclude(1차 #6). 렌더했으면 MAP.md는 이번 산출 — 추가. 이전 exclude는 현재 지문
          // 일치 시 승계(claim.prev — 교체 후 파일 재판독은 항상 running이라 불가: 2차 #3).
          const prevEx = cl.prev && cl.prev.exclude && typeof cl.prev.exclude === "object" ? cl.prev.exclude : {};
          const exclude = {};
          if (prevEx.topology && prevEx.topology === r0.topoFp) exclude.topology = prevEx.topology;
          if (r0.rendered) exclude.mapMd = r0.mapMdFp;
          else if (prevEx.mapMd && prevEx.mapMd === r0.mapMdFp) exclude.mapMd = prevEx.mapMd;
          return exclude;
        });
      }
      const isV1 = rt.topo && rt.topo.schemaVersion === 1;
      return writeRs(repo, claim, { phase: "blocked", reason: isV1 ? "v1-needs-migrate" : "schema-invalid", error: isV1 ? tB("v1 지도 — migrate 필요", "v1 map — migrate required") : (errs2[0] || "invalid"), doneAt: new Date().toISOString() }) ? 2 : 1; // 기록 실패=1(2차 #5)
    }
    if (rt.st === "invalid" || rt.st === "unreadable") { return writeRs(repo, claim, { phase: "blocked", reason: rt.st, doneAt: new Date().toISOString() }) ? 2 : 1; }
    // absent → 결정론 init(구조 결과 API — exit 코드 일반화 금지)
    const r = MR.initTopologyForBootstrap(repo, { basisCheck: () => sameBasisBoundary(basis0, basisFor(repo)) });
    if (r.st === "created") return finishDone((r0) => {
      // 5차 #1: init 잠금 해제~finish 잠금 획득 사이에 편집됐으면 그 파일은 자동물 아님 — 생성 지문과 정확 일치만 귀속
      const ex = {};
      if (r0.topoFp === r.topoFp) ex.topology = r0.topoFp;
      if (r0.mapMdFp === r.mapMdFp) ex.mapMd = r0.mapMdFp;
      return ex;
    });
    if (r.st === "already-valid") return finishDone(() => ({})); // 경합 승자 산출물 — 이번 실행 산출물 아님(exclude 없음), 큐만 보장
    if (r.st === "already-v1" || r.st === "already-invalid" || r.st === "already-unreadable") { return writeRs(repo, claim, { phase: "blocked", reason: r.st, error: r.error || "", doneAt: new Date().toISOString() }) ? 2 : 1; }
    writeRs(repo, claim, { phase: "failed", error: r.st + (r.error ? ": " + r.error : ""), doneAt: new Date().toISOString() });
    return 1; // failed 기록 실패여도 1(attempts 상한이 폭주 차단 — 2차 #5)
  } catch (e) {
    try { writeRs(repo, claim, { phase: "failed", error: String(e && e.message || e), doneAt: new Date().toISOString() }); } catch { /* 무해 */ }
    return 1;
  }
}

// verify-guard용: '이번 실행이 생성·교체한' 자동 산출물만(run-state.exclude 귀속 — 소급 인정 금지: 1차 #6).
// 부재·불일치·실패=빈 집합(보수 — 자동물을 잘못 제외하는 거짓 음성 금지).
function mapAutoExcluded(ws) {
  try {
    const rs = readJson3(rsFileFor(ws));
    if (rs.st !== "ok" || rs.data.phase !== "done" || !rs.data.exclude || typeof rs.data.exclude !== "object") return new Set();
    const out = new Set();
    const chk = (rel, fp) => { if (!fp) return; try { if (sha1(fs.readFileSync(path.join(ws, rel), "utf8")) === fp) out.add(rel); } catch { /* 포함 유지 */ } };
    chk("project-map/topology.json", rs.data.exclude.topology);
    chk("project-map/MAP.md", rs.data.exclude.mapMd);
    return out;
  } catch { return new Set(); }
}

// verify-guard의 project-map status 줄 판정(untracked 디렉터리 축약 대응·순수 테스트 가능).
// 반환: null=이 줄은 전부 자동 생성물 / number=비자동물의 최신 mtime / undefined=판정 불가(일반 처리).
function projectMapMtimeForStatus(ws, posix, excluded) {
  if (posix !== "project-map/" && !posix.startsWith("project-map/")) return undefined;
  if (posix !== "project-map/") return excluded.has(posix) ? null : undefined; // 개별 파일 줄: 일치=제외, 불일치=일반 처리
  let inner = null;
  try {
    const r2 = spawnSync("git", ["-C", ws, "--no-optional-locks", "-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all", "--", "project-map/"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r2 && r2.status === 0 && typeof r2.stdout === "string") inner = r2.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3).replace(/^"|"$/g, "").replace(/\\/g, "/"));
  } catch { /* 조회 실패 = 보수 포함 */ }
  if (!inner || !inner.length) return undefined; // 판정 불가 — 일반 처리(보수)
  if (inner.every((f) => excluded.has(f))) return null; // 전부 자동 생성물
  let max = 0;
  for (const f of inner) {
    if (excluded.has(f)) continue;
    try { const m = fs.statSync(path.join(ws, f)).mtimeMs; if (m > max) max = m; } catch { /* 무해 */ }
  }
  return max;
}

// 유도 상태(확장·CLI용 — 훅에서는 쓰지 않는다: 전체 파싱 포함)
function lockNeedsManualDelete(lock, state) { // 직접 삭제 안내: 2차 잠금(수동도 못 엶) + 손상 잠금(어떤 명령도 회수 불가 — 접미사 무관)
  if (state === "invalid" || state === "unreadable") return true;
  return typeof lock === "string" && lock.endsWith(".reclaim.recover");
}

function bootstrapStatusFor(repo) {
  const rs = readJson3(rsFileFor(repo));
  if (rsLiving(rs)) return { state: "bootstrap-running", rs: rs.data };
  // 부모 게이트와 같은 유도 신호·'우선순위' 공유(3·4차 #2 — 자동 경로는 failed 정지인데 상태는 draft-ready인 상충 금지)
  if (rs.st === "unreadable") return { state: "state-unreadable", rs: null }; // 손상과 구분(9차 #5 — 판독 실패는 권한/일시 안내가 다름)
  if (rs.st === "invalid" || (rs.st === "ok" && !rsValid(rs.data))) return { state: "state-invalid", rs: rs.st === "ok" ? rs.data : null };
  if (rs.st === "ok" && rs.data.phase === "failed") return { state: "bootstrap-failed", rs: rs.data }; // 무조건(topology 유무 무관 — 부모 억제와 동일)
  if (rs.st === "ok" && rs.data.phase === "running" && pidState(rs.data.pid) === "dead" && (rs.data.attempts || 0) >= 3) return { state: "bootstrap-failed", rs: rs.data };
  const fkSt2 = lockStateOf(readJson3(rsFileFor(repo) + ".funlock"));
  if (fkSt2 !== "absent" && fkSt2 !== "alive") return { state: "state-lock-blocked", rs: rs.st === "ok" ? rs.data : null, lock: rsFileFor(repo) + ".funlock", lockState: fkSt2 }; // funlock 잔재·손상=최우선(10·11차)
  for (const lockSuffix of [".reclaim.recover", ".reclaim"]) { // 2차 잠금 우선 — 수동 명령이 회수 못 하는 쪽이 삭제 안내 대상(parentSignals stuckLock과 동순위)
    const lkSt = lockStateOf(readJson3(rsFileFor(repo) + lockSuffix));
    if (lkSt !== "absent" && lkSt !== "alive") return { state: "state-lock-blocked", rs: rs.st === "ok" ? rs.data : null, lock: rsFileFor(repo) + lockSuffix, lockState: lkSt };
  }
  const rsd = rs.st === "ok" ? rs.data : null;
  const MR = require(path.join(__dirname, "map-runtime.js"));
  const rt = MR.readTopoExFor(repo);
  if (rt.st === "absent") return { state: "absent", rs: rsd };
  if (rt.st === "invalid" || rt.st === "unreadable") return { state: rt.st, rs: rsd };
  const errs = MR.PM.validateTopology(rt.topo);
  if (errs.length) return { state: rt.topo && rt.topo.schemaVersion === 1 ? "v1-needs-migrate" : "invalid", rs: rsd };
  const tp = path.join(repo, "project-map", "topology.json");
  if (!queueFresh(repo, tp)) return { state: "draft-stale-queue", rs: rsd, mapId: rt.topo.mapId }; // 큐 부재·손상·낡음
  const q = readJson3(queueFileFor(repo));
  const contentOk = q.st === "ok" && q.data.mapId === rt.topo.mapId && q.data.mapHash === MR.PM.mapHashOf(rt.topo); // CLI는 전체 판독 가능 — 내용까지 대조
  return { state: contentOk ? "draft-ready" : "draft-stale-queue", rs: rsd, mapId: rt.topo.mapId };
}
module.exports = { maybeSpawnBootstrap, hookTick, bootstrapStatusFor, lockNeedsManualDelete, lockStateOf, forceUnlock, runChild, parentSignals, repoKeyFor, rsFileFor, queueFileFor, consentFileFor, hasConsent, grantConsent, basisFor, fillHistorylessFp, sameBasisBoundary, pidState, ensureQueue, queueLooksSane, mapAutoExcluded, projectMapMtimeForStatus, RUN_DIR, QUEUE_DIR }; // main 블록보다 먼저 — run-manual→runCli→본 모듈 순환 require 시 exports가 채워져 있어야 함(6차 #3 위임의 전제)

if (require.main === module) {
  const mode = process.argv[2];
  const repo = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (mode === "run" && repo) process.exit(runChild(repo, false));
  if (mode === "run-manual" && repo) process.exit(require(path.join(__dirname, "map-runtime.js")).runCli(repo, "bootstrap")); // 단일 경로(6차 #3) — 종료 코드·잔존 잠금 안내가 진입점마다 갈리면 안 됨
  if (mode === "status" && repo) { const st = bootstrapStatusFor(repo); console.log(st.state + (st.rs && st.rs.error ? " — " + st.rs.error : "")); process.exit(0); }
  console.error("usage: node map-bootstrap.js run|run-manual|status <repo>");
  process.exit(2);
}
