"use strict";
/*
 * P-8 2단(설계 동결 v10) — 계약 저장 단일 관문 updateContractPatch + v10 잠금·승인 복구 사다리.
 * 계약: 구조화 JSON 토큰+획득 직후 read-back fence·상태 6분류(alive/dead-valid/invalid/unreadable/
 * owner-unverified/absent)·자동 stale 회수 없음(승인 격리만 — 원문 보존 .stale-*·TTL 청소·활성 잠금 sweep 금지)·
 * 전 작성자 단일 관문(손상 JSON=기록 거부·ENOENT만 신설·무폴더=CONTRACT_FILE 폴백)·확장=비동기 재시도(tries:1).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "p8s2_"));
process.env.CODEX_BRIDGE_HOME = H;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const WS = path.join(H, "proj");
fs.mkdirSync(WS, { recursive: true });
const FILE = CL.contractFileFor(WS, "ko");
const LOCK = path.resolve(FILE) + ".lock";
fs.mkdirSync(path.dirname(FILE), { recursive: true }); // 관문은 스스로 mkdir하지만 [1]은 잠금을 직접 시험
const deadPid = (() => { const c = cp.spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true }); return c.pid; })(); // 이미 종료된 pid

console.log("[1] v10 잠금 — 구조화 토큰·fence·tries 계약");
{
  let ran = 0;
  const r = CL.withContractLockV10(LOCK, () => { ran++; const raw = JSON.parse(fs.readFileSync(LOCK, "utf8")); return raw; });
  ok(r.ok && ran === 1 && r.result && r.result.v === 1 && r.result.pid === process.pid && typeof r.result.rnd === "string", "정상 획득 — 토큰=구조화 JSON({v,pid,rnd,ts})·fence 후 실행·해제");
  ok(!fs.existsSync(LOCK), "종료 시 자기 토큰 확인 후 해제");
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: process.pid, rnd: "held", ts: "t" }));
  let ran2 = 0;
  const t0 = Date.now();
  const r1 = CL.withContractLockV10(LOCK, () => { ran2++; }, 1);
  ok(!r1.ok && ran2 === 0 && r1.state === "alive" && Date.now() - t0 < 200, "tries=1(확장 계약) — 보유 중이면 대기 없이 즉시 alive 반환·callback 미실행");
  const r40 = CL.withContractLockV10(LOCK, () => { ran2++; });
  ok(!r40.ok && ran2 === 0 && r40.state === "alive" && /lock-timeout/.test(r40.error || ""), "기본(동기 짧은 재시도) — 살아있는 보유자=timeout·callback 미실행(잠금 미획득 시 실행 금지)");
  fs.unlinkSync(LOCK);
}

console.log("[2] 상태 6분류(v10) — dead-valid·invalid·unreadable·legacy 토큰");
{
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: deadPid, rnd: "dead", ts: "t" }));
  let r = CL.withContractLockV10(LOCK, () => 1, 1);
  ok(!r.ok && r.state === "dead-valid" && r.pid === deadPid, "정상 JSON 토큰+ESRCH 확정 사망=dead-valid(자동 회수 없음 — 사다리 입력)");
  fs.writeFileSync(LOCK, "{broken not a token");
  r = CL.withContractLockV10(LOCK, () => 1, 1);
  ok(!r.ok && r.state === "invalid", "신·구 형식 모두 아님(파싱 실패)=invalid(2단 승인 대상)");
  fs.unlinkSync(LOCK);
  fs.mkdirSync(LOCK); // 잠금 경로가 디렉터리 — wx 실패+읽기 EISDIR
  r = CL.withContractLockV10(LOCK, () => 1, 1);
  ok(!r.ok && r.state === "unreadable", "fs 읽기 실패(비ENOENT)=unreadable(격리 금지·조사 안내)");
  fs.rmdirSync(LOCK);
  fs.writeFileSync(LOCK, process.pid + "-abc123"); // 구형 평문 토큰(전환기 혼용)
  r = CL.withContractLockV10(LOCK, () => 1, 1);
  ok(!r.ok && r.state === "alive", "구형 토큰+생존 pid=유효 잠금 취급(invalid 오판으로 활성 저장 탈취 유도 금지)");
  fs.writeFileSync(LOCK, deadPid + "-abc123");
  r = CL.withContractLockV10(LOCK, () => 1, 1);
  ok(!r.ok && r.state === "dead-valid", "구형 토큰+사망 pid=dead-valid(전환기에도 사다리 일관)");
  fs.unlinkSync(LOCK);
  ok(typeof CL.parseLockToken === "function" && CL.parseLockToken("") === null && CL.parseLockToken(JSON.stringify({ v: 1, pid: 1, rnd: "x", ts: "t" })).form === "v10", "토큰 판독기 — 신형(전 필드 엄격)/무효 분류");
}

console.log("[3] 단일 관문 updateContractPatch — 병합·함수 patch·손상 거부·무폴더 폴백");
{
  let r = CL.updateContractPatch(WS, "ko", { a: 1 });
  ok(r.ok && JSON.parse(fs.readFileSync(FILE, "utf8")).a === 1, "객체 patch — ENOENT=신설·병합·workspace 스탬프: " + JSON.stringify(r));
  r = CL.updateContractPatch(WS, "ko", (o) => { o.b = 2; delete o.a; });
  const cur = JSON.parse(fs.readFileSync(FILE, "utf8"));
  ok(r.ok && cur.b === 2 && !("a" in cur) && cur.workspace === WS, "함수 patch(mutate) — 삭제 포함 변형(scope 스크립트 계약)");
  fs.writeFileSync(FILE, "{corrupt json");
  const beforeBytes = fs.readFileSync(FILE, "utf8");
  r = CL.updateContractPatch(WS, "ko", { c: 3 });
  ok(!r.ok && fs.readFileSync(FILE, "utf8") === beforeBytes, "손상 JSON — 기록 거부·바이트 불변(P-1 fail-closed·{} 축소 덮어쓰기 금지)");
  fs.writeFileSync(FILE, JSON.stringify({ b: 2, workspace: WS }));
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: process.pid, rnd: "held", ts: "t" }));
  r = CL.updateContractPatch(WS, "ko", { c: 3 }, { tries: 1 });
  ok(!r.ok && r.state === "alive" && !("c" in JSON.parse(fs.readFileSync(FILE, "utf8"))), "잠금 보유 중 — 관문 거부·계약 불변·상태 전달");
  fs.unlinkSync(LOCK);
  r = CL.updateContractPatch(null, "ko", { noFolder: true });
  ok(r.ok && JSON.parse(fs.readFileSync(CL.CONTRACT_FILE, "utf8")).noFolder === true, "무폴더 창(ws=null) — CONTRACT_FILE 폴백·잠금 키=최종 절대경로");
}

console.log("[4] 승인 격리 quarantineContractLock — 원문 보존·직전 재판정·오탈취 방지");
{
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: deadPid, rnd: "dead", ts: "t" }));
  const raw = fs.readFileSync(LOCK, "utf8");
  let q = CL.quarantineContractLock(LOCK, "다른 내용");
  ok(!q.ok && q.reason === "changed" && fs.existsSync(LOCK), "승인 시점 원문과 다르면 중단(승인 사이 교체 오탈취 방지)");
  q = CL.quarantineContractLock(LOCK, raw);
  ok(q.ok && !fs.existsSync(LOCK) && fs.existsSync(q.dest) && fs.readFileSync(q.dest, "utf8") === raw, "dead-valid 승인 격리 — 삭제 아닌 .stale-<ts> 이동·원문 보존");
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: process.pid, rnd: "live", ts: "t" }));
  q = CL.quarantineContractLock(LOCK, fs.readFileSync(LOCK, "utf8"));
  ok(!q.ok && q.reason === "alive" && fs.existsSync(LOCK), "정리 직전 재판정 — 보유자 생존이면 중단·잠금 원위치(수동 복구 경합: 정리 중 새 잠금=중단)");
  fs.unlinkSync(LOCK);
  ok(CL.quarantineContractLock(LOCK).reason === "absent", "이미 해제=absent(무해 중단)");
  // 1차 blocker② TOCTOU: 판정~rename 사이 '옛 잠금 해제+새 활성 잠금 생성' 경합 — 주입 훅으로 재현.
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: deadPid, rnd: "dead2", ts: "t" }));
  const raw2 = fs.readFileSync(LOCK, "utf8");
  const newLive = JSON.stringify({ v: 1, pid: process.pid, rnd: "new-live", ts: "t2" });
  const qr = CL.quarantineContractLock(LOCK, raw2, () => { fs.writeFileSync(LOCK, newLive); }); // 경합 주입: rename 직전 교체
  ok(!qr.ok && qr.reason === "raced-restored" && fs.readFileSync(LOCK, "utf8") === newLive, "정리 중 새 잠금=중단·원위치 복원(rename 후 실물 재확인 — 새 활성 잠금 격리 차단)");
  ok(!fs.readdirSync(path.dirname(LOCK)).some((n) => n.includes("dead2") && n.includes("stale")), "복원 후 격리물 잔존 없음");
  fs.unlinkSync(LOCK);
}

console.log("[4b] 토큰 엄격 검증(1차 blocker③) — v·ts·양의 pid 필수");
{
  ok(CL.parseLockToken(JSON.stringify({ pid: 1, rnd: "x" })) === null, "v·ts 없는 객체 — 정상 토큰 아님(invalid 분류 재료)");
  ok(CL.parseLockToken(JSON.stringify({ v: 1, pid: 0, rnd: "x", ts: "t" })) === null && CL.parseLockToken("0-abc") === null, "pid 0·비양수 — 거부(신·구형 공통)");
  fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, rnd: "x" })); // v·ts 누락 손상 토큰
  const r = CL.withContractLockV10(LOCK, () => 1, 1);
  ok(!r.ok && r.state === "invalid", "손상 토큰 — dead-valid/alive 오분류 없이 invalid(2단 승인 유지)");
  fs.unlinkSync(LOCK);
}

console.log("[4c] 2차 blocker 반영 — 공백 토큰·복원 무클로버·쓰기 직전 소유 재확인");
{
  ok(CL.parseLockToken(JSON.stringify({ v: 1, pid: 1, rnd: "  ", ts: "t" })) === null && CL.parseLockToken(JSON.stringify({ v: 1, pid: 1, rnd: "x", ts: " " })) === null, "공백뿐 rnd·ts — 정상 토큰 아님(invalid·2차 blocker③)");
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: deadPid, rnd: "d3", ts: "t" }));
  const raw3 = fs.readFileSync(LOCK, "utf8");
  const third = JSON.stringify({ v: 1, pid: process.pid, rnd: "third", ts: "t3" });
  const q3 = CL.quarantineContractLock(LOCK, raw3, () => { fs.writeFileSync(LOCK, JSON.stringify({ v: 1, pid: process.pid, rnd: "second", ts: "t2" })); }); // 교체 경합
  ok(!q3.ok && (q3.reason === "raced-restored" || q3.reason === "raced-unrestored"), "경합 격리 — 중단(복원 또는 위치 보고): " + q3.reason);
  if (q3.reason === "raced-unrestored") { ok(!!q3.dest && fs.existsSync(q3.dest), "raced-unrestored — 격리물 위치 보고(수동 복원 재료)"); try { fs.unlinkSync(q3.dest); } catch {} }
  try { fs.unlinkSync(LOCK); } catch {}
  // 쓰기 직전 소유 재확인(stillMine): fn 실행 중 잠금이 교체되면 기록 중단·계약 불변(2차 blocker② 이중 방어)
  fs.writeFileSync(FILE, JSON.stringify({ b: 2, workspace: WS }));
  const beforeC = fs.readFileSync(FILE, "utf8");
  const rSwap = CL.updateContractPatch(WS, "ko", (o) => { o.hijack = true; try { fs.writeFileSync(LOCK, third); } catch {} });
  ok(!rSwap.ok && fs.readFileSync(FILE, "utf8") === beforeC, "임계구역 중 잠금 교체 — 쓰기 직전 재확인이 기록 중단(동시 쓰기 불성립)");
  try { fs.unlinkSync(LOCK); } catch {}
}

console.log("[5] 2프로세스 동시 patch — 서로 다른 필드 무유실(v10 잠금 직렬화)");
{
  const drv = (field) => "const p=require(" + JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js")) + ");const r=p.updateContractPatch(" + JSON.stringify(WS) + ",'ko',{" + field + ":true});process.exit(r.ok?0:1);";
  const env = { ...process.env, CODEX_BRIDGE_HOME: H };
  const a = cp.spawn(process.execPath, ["-e", drv("boxA")], { env, windowsHide: true });
  const b = cp.spawn(process.execPath, ["-e", drv("boxB")], { env, windowsHide: true });
  const codes = [];
  const wait = new Promise((res) => { let n = 0; const done = (c) => { codes.push(c); if (++n === 2) res(null); }; a.on("exit", done); b.on("exit", done); });
  const timer = new Promise((res) => setTimeout(res, 15000));
  require("node:worker_threads"); // no-op(가독) — 아래 await는 최상위 async 아님이라 then 체인
  wait.then(() => {
    const o = JSON.parse(fs.readFileSync(FILE, "utf8"));
    ok(codes.length === 2 && codes.every((c) => c === 0) && o.boxA === true && o.boxB === true, "동시 저장(서로 다른 필드) — 두 필드 모두 보존(lost-update 없음)");
    // 1차 blocker①·⑧ — '체크박스 vs 낡은 전체 저장' 되돌림 재현: dirty 제한이 없으면 낡은 창의 전체 저장이
    // 방금 저장된 다른 필드를 옛값으로 덮는다 → touched-gated patch(변경 필드만)면 미변경 필드는 페이로드에
    // 아예 없어 보존된다(관문 수준 실동작 — 웹뷰 touched 산출은 [7] 배선 단언이 잠금).
    CL.updateContractPatch(WS, "ko", { claudeChecklist: false });                                // 창 B: 체크박스 즉시 저장
    const stale = CL.updateContractPatch(WS, "ko", { verifyMode: "code" });                       // 창 A(낡음): '바뀐 필드만'=verifyMode뿐 — 체크리스트 미포함
    const o2 = JSON.parse(fs.readFileSync(FILE, "utf8"));
    ok(stale.ok && o2.claudeChecklist === false && o2.verifyMode === "code", "체크박스 vs 낡은 전체 저장 — dirty 제한 페이로드면 타 필드 무되돌림(v10 '전체저장=dirty 필드만' 실동작)");
    afterConcurrent();
  });
  Promise.race([wait, timer]).then(() => { /* 안전망 */ });
}

function afterConcurrent() {
console.log("[6] 격리물 TTL — .lock.stale-*만 청소·활성 .lock 절대 sweep 금지");
{
  const cdir = path.dirname(FILE);
  const staleOld = path.join(cdir, path.basename(FILE) + ".lock.stale-1");
  const active = LOCK;
  fs.writeFileSync(staleOld, "old", "utf8");
  const old = Date.now() / 1000 - 8 * 24 * 3600;
  fs.utimesSync(staleOld, old, old);
  fs.writeFileSync(active, JSON.stringify({ v: 1, pid: process.pid, rnd: "live", ts: "t" }));
  fs.utimesSync(active, old, old); // 오래돼 보여도 활성 잠금은 절대 청소 금지
  CL.cleanupOldState(Date.now());
  ok(!fs.existsSync(staleOld), "7일 지난 격리물(.lock.stale-*) — TTL 청소");
  ok(fs.existsSync(active), "활성 .lock — mtime이 오래돼도 sweep 금지(자동 회수 없음 계약)");
  fs.unlinkSync(active);
}

console.log("[7] 배선 소스 계약 — 전 작성자 관문·사다리·비동기·mode 결속·aria-live·예외 복구");
{
  const st = fs.readFileSync(path.join(ROOT, "scripts", "scope-target.js"), "utf8");
  const sg = fs.readFileSync(path.join(ROOT, "scripts", "scope-gate.js"), "utf8");
  ok(/updateContractPatch\(ws, loadLang\(\), \(o\) => mutate\(o\)\)/.test(st) && !/withFileLockStrict\(/.test(st), "scope-target — 직접 RMW 폐기·관문 이관");
  ok(/updateContractPatch\(repo, lang, \{ scoutGate: target \}\)/.test(sg) && !/withFileLockStrict\(/.test(sg), "scope-gate — 관문 이관");
  ok(!/\.lock 잔존 시 보유 프로세스 종료 확인 후 삭제/.test(st) && !/verify the owner is gone and delete it/.test(sg), "CLI 안내 — 수동 삭제 유도 문구 제거(사다리 안내로 교체)");
  const cl = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  ok(/function patchContractFields\(ws, lang, patch\) \{\n  if \(!ws\) return false;/.test(cl) && /updateContractPatch\(ws, lang, patch\)\.ok === true/.test(cl), "훅 경로(patchContractFields) — 서명 유지 래퍼로 관문 위임(modeSwitch 원자 patch 포함 전 훅 자동 이관)");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/lib\.updateContractPatch\(ws, lang, patch, \{ tries: 1 \}\)/.test(ext), "확장 — 관문 위임(tries:1 = 관문 내부 동기 대기 제거)");
  ok(/async function patchContractRetryExt/.test(ext) && /await new Promise\(\(r\) => setTimeout\(r, 15\)\)/.test(ext), "확장 — 비동기 재시도(호스트 블록 금지·v10)");
  ok(/res\.state === "dead-valid"/.test(ext) && /tE\("잠금 정리", "Clean up lock"\)/.test(ext), "사다리 — dead-valid=1클릭 정리");
  ok(/res\.state === "invalid" \|\| res\.state === "owner-unverified"/.test(ext) && /\{ modal: true \}, c2\)/.test(ext), "사다리 — invalid·owner-unverified=2단 명시 승인 모달");
  ok(/state === "unreadable"/.test(ext) && /격리하지 않습니다\(오탈취 방지\)/.test(ext), "사다리 — unreadable=격리 금지·조사 안내");
  ok(/quarantineContractLock\(lp, raw\)/.test(ext), "사다리 — 승인 시점 원문(expect) 전달(정리 직전 재판정과 이중 방어)");
  ok(/patchContractWithRecovery\(dashboardWorkspace\(\), slotLang, \{ harnessMode: m\.mode \}/.test(ext) && /await patchContractRetryExt\(dashboardWorkspace\(\), slotLang, patch\)/.test(ext), "저장 지점(모드·전체저장) — 재시도+사다리 경로");
  ok(/mode: modeCk, ok: res\.ok, reqId \}\)/.test(ext) && /var ckModeOk = !ev\.data\.mode \|\| ev\.data\.mode === \(cardM\.renderedMode\(\) \|\| harnessMode\);/.test(ext) && /if \(ckR\.act === "commit" && ckModeOk\)/.test(ext), "saveResult mode 결속 — 상태기 판정 '후' commit 조건 결속(조기 반환 없음: pending·타이머·hold aria-live 정상 경유 — 1차 B5)");
  ok(/void \(async \(\) => \{\s*\n\s*try \{\s*\n\s*const res = await patchContractRetryExt\(wsCk, slotLang/.test(ext), "체크박스 — 관문 비동기 재시도 경유(무폴더 폴백·호스트 비블록 — 1차 B4)");
  ok(/\}\)\(\)\.catch\(\(e: any\) => \{/.test(ext) && /target: "contract", ok: false, reqId: typeof m\.reqId === "string" \? m\.reqId : null \}\); \} catch/.test(ext), "분리 실행 비동기 전체 저장 — 예외 시 실패 응답+정본 재렌더(1차 B6)");
  ok(/claudeRulesTouched \? \{ codexImplementer/.test(ext) && /m\.verifyModeTouched \? \{ codexVerifyMode/.test(ext) && /m\.scoutModeTouched \? \{ scoutMode/.test(ext) && /appRulesC = inC; appRulesX = inX;/.test(ext), "전체 저장 dirty 제한 — 전 필드 touched-gated+웹뷰 기준선(1차 B1)");
  ok(/m\.scoutModeTouched \? normScoutMode\(\{ scoutMode: m\.scoutMode \}\) === "on" : prevScoutOn/.test(ext), "3트랙 전환 판정도 touched 기준(미변경=전환 아님 — 동의 모달·ping 미발동)");
  // 2차 blocker① — 필드별 사용자 편집 플래그: 클릭=set·정본 fill=필드별 동기화·저장 성공=일괄 해제·payload=AND 결합
  ok(/var segTouched = \{ vm:false, im:false, sm:false, vp:false, vb:false \};/.test(ext) && /segTouched\.vm=true;/.test(ext) && /segTouched\.vb=true;/.test(ext), "segTouched — 사용자 상호작용에서만 set(외부 갱신은 편집 아님)");
  ok(/if \(!segTouched\.sm\)\{ curSM=appSM;/.test(ext) && /if \(segTouched\.vm && curVM===appVM\) segTouched\.vm=false;/.test(ext), "정본 fill — 필드별 동기화+자기치유(묶음 dirty의 전 필드 보존 폐기)");
  ok(/scoutModeTouched: \(segTouched\.sm && appSM!==null && curSM!==appSM\)/.test(ext) && /claudeRulesTouched: \(contractDirty\.claude===true &&/.test(ext), "payload touched=사용자 편집 AND 값 상이(외부 변경 오인·동일값 물질화 양쪽 차단)");
  ok(/segTouched = \{ vm:false, im:false, sm:false, vp:false, vb:false \}; \/\/ v10\(2차 B1\)/.test(ext), "저장 성공 — 편집 플래그 일괄 해제(저장값=새 정본)");
  ok(/stillMine/.test(fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8")) && /lock-unreadable-after-acquire/.test(fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8")), "잠금 — 쓰기 직전 소유 재확인+fence 읽기 실패=unreadable(자동 삭제 없음 — 2차 B2·B4·4차 확정)");
  ok(/q\?\.dest \? tE\(` 격리물 위치: \$\{q\.dest\}`/.test(ext), "사다리 — raced-unrestored 격리물 위치 사용자 고지(2차 B2)");
  const cl2 = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  ok(/fs\.linkSync\(dest, lockPath\);/.test(cl2) && !/if \(!fs\.existsSync\(lockPath\)\) \{ fs\.renameSync\(dest, lockPath\)/.test(cl2), "격리 복원 — 원자적 무클로버(link EEXIST)만·existsSync+rename 폐기(3차 B2)");
  ok(/fence 판독 실패 시 자동 삭제 '없음'/.test(cl2) && /lock-unreadable-after-acquire/.test(cl2) && !/back2 === mine/.test(cl2), "fence 실패 — 자동 삭제 자체 폐기(확인-후-삭제 TOCTOU 제거·사후 회수=dead-valid 사다리·4차 blocker)");
  ok(/id="ckLive" role="status" aria-live="polite"/.test(ext) && (ext.match(/lv\.textContent = T\(/g) || []).length >= 2, "즉시저장 aria-live — 성공·hold 양쪽 고지(v10 ⑸)");
  ok(/P-8 2단 v10 ⑸: 호스트 전체 예외 복구/.test(ext) && /Dashboard action failed — the view was re-rendered/.test(ext), "호스트 전체 예외 복구 — 고지+정본 재렌더(v10 ⑸)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
}
