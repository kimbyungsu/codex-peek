"use strict";
/*
 * [Envelope Selector v7 §3 — 3b] worker 배선 실행 시험: selecting 내구 상태·취소 의사 CAS·예산 분리·
 * archiveCtx 동결·strict 판독·합집합 상한·영수증 read-back 관문·주입 절+드리프트 재검사·직접 ask 거부·
 * 스냅샷 부재=시작 중단·미도입 무회귀. 격리: 임시 CODEX_BRIDGE_HOME+가짜 선별 실행기/검증 브릿지(env 주입 —
 * ask-job.test.js의 CODEX_BRIDGE_WORKER_BRIDGE 관용구).
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const t = (name) => { n++; console.log(`  ✅ [${n}] ${name}`); };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-ws-"));
const JOBS = path.join(HOME, "ask-jobs");
const CLI = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const WORKER = path.join(__dirname, "..", "bridge", "ask-job-worker.js");

// ── 픽스처: 승인 코어+승인 서고 ──
const coreObj = { schema: "verify-envelope-v1", supportedEnv: ["윈도우 로컬 단일 사용자"], alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"], outOfScope: ["다중 서버 동시 배포"] };
const coreRaw = JSON.stringify(coreObj, null, 1);
fs.writeFileSync(path.join(WS, CL.ENVELOPE_FILE), coreRaw);
assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, sha1(coreRaw)), 2);
const arcObj = { schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "고객 차단 기록은 지우지 않는다"] };
const arcText = JSON.stringify(arcObj, null, 1);
fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), arcText);
const ARC_HASH = sha1(arcText);
assert.strictEqual(CL.setContractHashAllSlots(WS, "archiveHash", ARC_HASH), 2);

// 가짜 선별 실행기 — mode.txt 로 거동 제어·prompts.log 로 입력 계약 검수
const SELDIR = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-fake-"));
const fakeSel = path.join(SELDIR, "fake-selector.js");
fs.writeFileSync(fakeSel, [
  'const fs=require("fs");const D=process.env.SEL_FAKE_DIR;',
  "function runSelectorPage({arm,prompt,timeoutMs}){",
  '  fs.appendFileSync(D+"/prompts.log","=== arm="+arm+"\\n"+prompt+"\\n");',
  '  const mode=fs.readFileSync(D+"/mode.txt","utf8").trim();',
  "  let cancelled=false;",
  "  const promise=new Promise((resolve)=>{const go=()=>{",
  '    if(mode==="hang"){if(cancelled)return resolve({ok:false,key:"cancelled",detail:""});return setTimeout(go,100);}',
  '    if(mode==="fail")return resolve({ok:false,key:"call-failed",detail:"boom"});',
  '    if(mode==="bad-json")return resolve({ok:true,output:"not json"});',
  '    const ids=[...prompt.matchAll(/^(arc-\\d+): /gm)].map((m)=>m[1]);',
  '    if(mode==="all")return resolve({ok:true,output:JSON.stringify({relevant:ids})});',
  '    return resolve({ok:true,output:JSON.stringify({relevant:ids.slice(0,1)})});',
  "  };setTimeout(go,50);});",
  "  return {promise,cancel:()=>{cancelled=true;}};",
  "}",
  "module.exports={runSelectorPage};",
].join("\n"));
const setMode = (m) => fs.writeFileSync(path.join(SELDIR, "mode.txt"), m);
// 가짜 검증 브릿지 — 전달된 절대 deadline env 를 출력에 남김(예산 분리 검수)
const fakeBridge = path.join(SELDIR, "fake-bridge.js");
fs.writeFileSync(fakeBridge, 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.env.CODEX_BRIDGE_JOB_PROMPT_FILE,"utf8"));process.stdout.write("answer:"+j.prompt+":deadline="+(process.env.CODEX_BRIDGE_VERIFY_DEADLINE_AT||""));');
const ENV = { ...process.env, CODEX_BRIDGE_HOME: HOME, CODEX_BRIDGE_WORKER_BRIDGE: fakeBridge, CODEX_BRIDGE_SELECTOR_RUNNER: fakeSel, SEL_FAKE_DIR: SELDIR, CODEX_BRIDGE_VERIFY_TIMEOUT_MIN: "7" };

// 구현 턴 스냅샷(사용자 원문) 픽스처
const SNAP = "이번 작업: 백업 정책을 지키며 배포 스크립트를 고친다";
const ANCHOR = "anchor001";
fs.mkdirSync(path.dirname(CL.constraintTurnFileFor(WS, ANCHOR)), { recursive: true });
fs.writeFileSync(CL.constraintTurnFileFor(WS, ANCHOR), SNAP);
const SNAP_HASH = sha1(SNAP);
const SESS = "sessSelector01";
fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: ANCHOR, constraintSourceHash: SNAP_HASH }));

function craftJob(id, extra) {
  const now = Date.now();
  const job = Object.assign({
    schema: "ask-job-v1", id, state: "queued", workspace: WS, execCwd: WS, flags: ["--allow-new"], prompt: "sel-e2e-check",
    timeoutMin: 7, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 16 * 60 * 1000).toISOString(),
    selector: { archiveHash: ARC_HASH, itemCount: 2, pages: 1, arm: "self" },
    selectorDeadlineAt: new Date(now + 9 * 60 * 1000).toISOString(), verifierDeadlineAt: null,
    harnessMode: "claude-codex", constraintCtx: { provider: "claude", sessionId: SESS, turnAnchor: ANCHOR, sourceHash: SNAP_HASH },
  }, extra || {});
  fs.mkdirSync(JOBS, { recursive: true });
  const file = path.join(JOBS, id + ".json");
  fs.writeFileSync(file, JSON.stringify(job));
  return file;
}
async function runWorkerAndWait(file, ms) {
  const c = cp.spawn(process.execPath, [WORKER, file], { env: ENV, windowsHide: true, stdio: "ignore" });
  const until = Date.now() + (ms || 15000);
  let done = false;
  c.on("close", () => { done = true; });
  while (!done && Date.now() < until) await sleep(100);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

(async () => {
  // [1] ask-start 게이트: 서고 활성+스냅샷 부재=시작 중단(job 생성 0)
  {
    const r = cp.spawnSync(process.execPath, [CLI, "ask-start", "--allow-new", "gate-check"], { cwd: WS, encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: "" }, timeout: 15000 });
    assert.notStrictEqual(r.status, 0, "스냅샷 없는 턴=거부");
    assert.match(r.stderr, /스냅샷|snapshot/i);
    assert.strictEqual(fs.existsSync(JOBS) ? fs.readdirSync(JOBS).filter((x) => x.endsWith(".json")).length : 0, 0, "job 미생성");
    t("ask-start 게이트: 승인 서고 활성+스냅샷 부재=시작 중단(스냅샷 부재≠조용한 무선별 진행)");
  }
  // [2] ask-start 게이트: 서고 소실(내용 불일치)=시작 중단
  {
    fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["몰래 바뀐 판"] }, null, 1));
    const r = cp.spawnSync(process.execPath, [CLI, "ask-start", "--allow-new", "gate-check"], { cwd: WS, encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: SESS }, timeout: 15000 });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /서고가 도장 시점과|archive differs/);
    fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), arcText); // 원복
    t("ask-start 게이트: 소실≠미도입 — 도장 지문과 다른 서고=시작 중단(재승인 안내)");
  }
  // [3] e2e: ask-start→selecting→선별(가짜 팔)→running(verifierDeadlineAt 확정)→가짜 검증→succeeded
  let e2eJob = null;
  {
    setMode("ok");
    const r = cp.spawnSync(process.execPath, [CLI, "ask-start", "--allow-new", "sel-e2e-check"], { cwd: WS, encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: SESS }, timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const started = JSON.parse(r.stdout);
    const jf = path.join(JOBS, started.jobId + ".json");
    const j0 = JSON.parse(fs.readFileSync(jf, "utf8"));
    assert.ok(j0.selector && j0.selector.archiveHash === ARC_HASH && j0.selector.arm === "self" && j0.selector.pages === 1, "선별 계획(팔=구현 턴 provider·페이지) job 동결");
    assert.ok(Number.isFinite(Date.parse(j0.selectorDeadlineAt)), "선별 예산 절대 시각 기록");
    assert.ok(Date.parse(j0.deadlineAt) - Date.parse(j0.createdAt) > 15 * 60 * 1000, "전체 deadline=선별 예산+검증 예산 합(검증 몫 무잠식)");
    const until = Date.now() + 20000;
    let jd = j0;
    while (!["succeeded", "failed"].includes(jd.state) && Date.now() < until) { await sleep(150); jd = JSON.parse(fs.readFileSync(jf, "utf8")); }
    assert.strictEqual(jd.state, "succeeded", JSON.stringify(jd).slice(0, 400));
    assert.ok(jd.selection && Array.isArray(jd.selection.selectedIds) && jd.selection.selectedIds.length === 1, "선별 결과 결속(첫 항목 1건)");
    assert.ok(jd.selectorCtx && jd.selectorCtx.snapshotHash === SNAP_HASH && jd.selectorCtx.scopePackageHash === jd.selection.scopePackageHash, "archiveCtx 동결(스냅샷·변경물 지문)");
    assert.ok(Number.isFinite(Date.parse(jd.verifierDeadlineAt)) && Date.parse(jd.verifierDeadlineAt) > Date.parse(jd.startedAt), "★verifierDeadlineAt=전이 시점 확정(검증 예산 전액)");
    const out = fs.readFileSync(path.join(JOBS, started.jobId + ".out"), "utf8");
    assert.ok(out.includes("deadline=" + jd.verifierDeadlineAt), "★검증 자식에 전달된 절대 deadline=verifierDeadlineAt(생성 시점 단일 deadline 교체)");
    const plog = fs.readFileSync(path.join(SELDIR, "prompts.log"), "utf8");
    assert.ok(plog.includes(SNAP), "선별 입력에 사용자 원문 스냅샷 포함");
    assert.ok(!plog.includes("sel-e2e-check"), "★검증 요청문(구현자 작문)은 선별 입력에 없음(입력 중립 e2e)");
    // 영수증 read-back 실물
    const rc = JSON.parse(fs.readFileSync(path.join(CL.SELECTOR_USAGE_DIR, jd.selection.receiptFile), "utf8"));
    assert.ok(rc.askId === started.jobId && rc.arm === "self" && rc.itemCount === 2 && rc.pages === 1 && rc.selectedIds.length === 1, "선별 영수증(1건=1파일) 실물·조인 키");
    e2eJob = jd;
    t("e2e: ask-start→선별(중립 입력·가짜 팔)→전이(verifierDeadlineAt 확정)→검증 예산 전액 전달→영수증 실물");
  }
  // [4] 취소 계약: hang 선별 중 ask-job clear → 의사 기록(즉시 삭제 없음) → worker가 회수해 failed(cancelled)
  {
    setMode("hang");
    // [4a blocker② 반례] 직전 '다른 프로젝트'의 회차·세션이 새 selecting 기록에 승계되면 안 됨 — 오염 선주입
    fs.writeFileSync(CL.PHASE_FILE, JSON.stringify({ phase: "done", round: 4, session: "other-project-session", workspace: "D:/other-project", ts: new Date().toISOString() }));
    const id = "ask-selhang-aaaaaaaaaa";
    const file = craftJob(id);
    const c = cp.spawn(process.execPath, [WORKER, file], { env: ENV, windowsHide: true, stdio: "ignore" });
    let closed = false; c.on("close", () => { closed = true; });
    const until = Date.now() + 10000;
    let j = null;
    while (Date.now() < until) { j = JSON.parse(fs.readFileSync(file, "utf8")); if (j.state === "selecting") break; await sleep(50); }
    assert.strictEqual(j.state, "selecting", "★신설 내구 상태 selecting 관측");
    const clr = cp.spawnSync(process.execPath, [CLI, "ask-job", "clear", id, "--confirm"], { encoding: "utf8", env: ENV, cwd: WS, timeout: 10000 });
    assert.strictEqual(clr.status, 0, clr.stderr);
    assert.match(clr.stdout, /취소 의사|Cancel intent/, "살아있는 선별=삭제 대신 의사 기록");
    assert.ok(fs.existsSync(path.join(JOBS, id + ".cancel-intent")), "취소 의사 내구 파일(.json 아님 — 손상 스캐너 무접촉)");
    {
      const ph = CL.readPhase(WS);
      assert.strictEqual(ph.phase, "selecting", "[4a] 선별 중=진행 표기 selecting(대시보드 라이브 재료)");
      assert.ok(ph.workspace === WS && ph.round === 0 && ph.session === null, "★필드 전량 명시 — 직전 타 프로젝트의 round(4)·session 승계 오염 차단(blocker②): " + JSON.stringify({ r: ph.round, s: ph.session }));
      // [4a 확인검증 blocker] ws별 기록 분리 — 다른 프로젝트가 동시에 진행을 기록해도 이 ws의 selecting이 소거되지 않음
      CL.writePhase("codex-verifying", { workspace: "D:/other-project", round: 7, session: "other" });
      const ph2 = CL.readPhase(WS);
      assert.ok(ph2.phase === "selecting" && ph2.round === 0, "★타 프로젝트 동시 기록 후에도 이 ws 표기 생존(단일 파일 덮어쓰기 소거 봉합)");
      assert.strictEqual(CL.readPhase("D:/other-project").round, 7, "타 프로젝트 기록은 자기 ws 파일에");
      assert.strictEqual(CL.readPhase().phase, "codex-verifying", "legacy 전역=마지막 기록 미러(구형 확장 호환)");
    }
    const u2 = Date.now() + 15000;
    while (!closed && Date.now() < u2) await sleep(100);
    const jd = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(jd.state === "failed" && jd.selectorOutcome === "cancelled", "worker가 의사 관측→트리 회수→failed(cancelled) 정착: " + JSON.stringify({ st: jd.state, o: jd.selectorOutcome }));
    assert.strictEqual(CL.readPhase().phase, "claude-working", "[4a] 선별 실패 정착=진행 표기 복귀(selecting 잔존 방지)");
    const clr2 = cp.spawnSync(process.execPath, [CLI, "ask-job", "clear", id, "--confirm"], { encoding: "utf8", env: ENV, cwd: WS, timeout: 10000 });
    assert.strictEqual(clr2.status, 0, clr2.stderr);
    assert.ok(!fs.existsSync(file) && !fs.existsSync(path.join(JOBS, id + ".cancel-intent")), "정착 후 clear=기록·의사 파일 정리");
    t("취소 계약: selecting 관측→clear=의사 기록(강제 삭제 금지)→worker 회수→failed(cancelled)→후속 clear 정리");
  }
  // [5] 한 페이지 실패=전체 실패(부분 수용 없음)
  {
    setMode("fail");
    const jd = await runWorkerAndWait(craftJob("ask-selfail-aaaaaaaaaa"));
    assert.ok(jd.state === "failed" && jd.selectorOutcome === "selector-page", JSON.stringify({ st: jd.state, o: jd.selectorOutcome }));
    t("페이지 실패=전체 실패(fail-closed — 부분 선별로 진행 금지)");
  }
  // [6] strict 출력 거부(산문)=전체 실패
  {
    setMode("bad-json");
    const jd = await runWorkerAndWait(craftJob("ask-selbadj-aaaaaaaaaa"));
    assert.ok(jd.state === "failed" && String(jd.selectorOutcome).startsWith("selector-output:"), JSON.stringify({ st: jd.state, o: jd.selectorOutcome }));
    t("strict 출력 위반(산문)=전체 실패(선별 임의 해석 금지)");
  }
  // [7] 합집합 상한 초과=overflow 정직 중단(절단·요약 없음)
  {
    const big = { schema: "verify-envelope-archive-v1", alwaysBlocker: Array.from({ length: 13 }, (_, i) => "보관 수칙 " + (i + 1)) };
    const bigText = JSON.stringify(big, null, 1);
    fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), bigText);
    setMode("all");
    const jd = await runWorkerAndWait(craftJob("ask-selover-aaaaaaaaaa", { selector: { archiveHash: sha1(bigText), itemCount: 13, pages: 1, arm: "self" } }));
    assert.ok(jd.state === "failed" && jd.selectorOutcome === "selector-overflow", JSON.stringify({ st: jd.state, o: jd.selectorOutcome }));
    assert.match(String(jd.error), /no truncation|절단/i);
    fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), arcText); // 원복
    t("합집합 K 초과=selector-overflow 정직 중단+정리 안내(조용한 절단 금지)");
  }
  // [8] 주입 절+합본 manifest: 주입 직전 재검사 통과 시 [서고 수칙] 절이 코어 다음 ab-N 연속 번호로 합류
  {
    const scope = CL.selectorScopeMaterial(WS);
    const id = "ask-selinj9-aaaaaaaaaa";
    const file = craftJob(id, { state: "running", selection: { archiveHash: ARC_HASH, scopePackageHash: scope.hash, snapshotHash: SNAP_HASH, selectedIds: ["arc-2"], itemCount: 2, pages: 1, arm: "self", receiptFile: "x.json" } });
    process.env.CODEX_BRIDGE_JOB_PROMPT_FILE = file;
    process.env.CODEX_BRIDGE_ASK_JOB_ID = id;
    const es = CB.envelopeSliceFor(WS, "ko", "core", CL.loadContract(WS, "ko"));
    assert.ok(es.envText.includes("[서고 수칙 · 이번 작업 선별 v1"), "선별 절 주입");
    assert.ok(es.envText.includes("> ab-2: " + arcObj.alwaysBlocker[1]), "★합본 번호=코어 다음 연속(코어 ab 1항→선별분 ab-2)");
    assert.strictEqual(es.envAxes.alwaysBlocker, 2, "carrier 축 개수=합본(코어 1+선별 1 — ab-2 인용이 오거부되지 않게)");
    const fz = CL.readFrozenEnvelopeRec(WS);
    assert.ok(fz && Array.isArray(fz.manifest) && fz.manifest.length === 2 && fz.manifest[1].source === "archive", "★freeze manifest에 선별분 합류");
    assert.strictEqual(fz.appliedArchiveHash, ARC_HASH, "appliedArchiveHash 실값");
    assert.strictEqual(fz.boundaryGen, CL.boundaryGenOf(sha1(coreRaw), ARC_HASH, fz.manifest), "boundaryGen=합본 세대");
    t("주입 절: [서고 수칙] 합류·연속 ab-N·manifest/appliedArchiveHash/boundaryGen 실값 동결");
  }
  // [9] 주입 직전 드리프트=중단(서고·변경물 각각) + 선별 없는 판 위장 차단
  {
    const scope = CL.selectorScopeMaterial(WS);
    const id = "ask-seldrf9-aaaaaaaaaa";
    const file = craftJob(id, { state: "running", selection: { archiveHash: ARC_HASH, scopePackageHash: scope.hash, snapshotHash: SNAP_HASH, selectedIds: ["arc-1"], itemCount: 2, pages: 1, arm: "self", receiptFile: "x.json" } });
    process.env.CODEX_BRIDGE_JOB_PROMPT_FILE = file;
    process.env.CODEX_BRIDGE_ASK_JOB_ID = id;
    fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["선별 뒤 바뀐 판"] }, null, 1));
    assert.throws(() => CB.envelopeSliceFor(WS, "ko", "core", CL.loadContract(WS, "ko")), (e) => e && e.selectorDrift, "서고 드리프트=중단");
    fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), arcText);
    const j = JSON.parse(fs.readFileSync(file, "utf8")); j.selection.scopePackageHash = "deadbeef"; fs.writeFileSync(file, JSON.stringify(j));
    assert.throws(() => CB.envelopeSliceFor(WS, "ko", "core", CL.loadContract(WS, "ko")), (e) => e && e.selectorDrift, "변경물 드리프트=중단");
    delete process.env.CODEX_BRIDGE_JOB_PROMPT_FILE;
    delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
    assert.throws(() => CB.envelopeSliceFor(WS, "ko", "core", CL.loadContract(WS, "ko")), (e) => e && e.selectorDrift, "★서고 활성+선별 결과 없음=중단('선별 없는 판'이 조용히 진행되는 경로 차단)");
    t("주입 직전 재검사: 서고/변경물 드리프트=중단·선별 없는 판 위장 차단(같은 전이 잠금 안)");
  }
  // [10] 직접 ask 거부(승인 서고 활성 시) + selecting=활성 판정(동시 1개 규칙 편입)
  {
    const r = cp.spawnSync(process.execPath, [CLI, "ask", "hello"], { cwd: WS, encoding: "utf8", env: { ...ENV }, timeout: 15000 });
    assert.strictEqual(r.status, 4, r.stderr);
    assert.match(r.stderr, /직접 ask를 실행하지 않습니다|direct ask is not executed/);
    const id2 = "ask-selact9-aaaaaaaaaa";
    craftJob(id2, { state: "selecting", deadlineAt: new Date(Date.now() + 9 * 60 * 1000).toISOString() });
    assert.strictEqual(CB.activeAskJob(WS).id, id2, "selecting=활성(새 ask-start 차단 대상)");
    assert.ok(!CB.corruptAskJobFiles().includes(id2 + ".json"), "selecting 상태=정상 스키마(손상 오판 없음)");
    fs.writeFileSync(path.join(JOBS, "ask-seldang-aaaaaaaaaa.cancel-intent"), "{}");
    assert.ok(!CB.corruptAskJobFiles().some((x) => x.includes("cancel-intent")), "의사 파일은 손상 스캐너 무접촉");
    fs.unlinkSync(path.join(JOBS, id2 + ".json"));
    fs.unlinkSync(path.join(JOBS, "ask-seldang-aaaaaaaaaa.cancel-intent"));
    t("직접 ask 거부(서고 활성)·selecting=활성 편입·의사 파일 스캐너 무접촉");
  }
  // [11] 미도입 무회귀: archiveHash 없는 ws의 ask-start=selector 미기록·기존 deadline 산식
  {
    const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-ws2-"));
    const r = cp.spawnSync(process.execPath, [CLI, "ask-start", "--allow-new", "legacy-check"], { cwd: WS2, encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: "" }, timeout: 20000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const started = JSON.parse(r.stdout);
    const j0 = JSON.parse(fs.readFileSync(path.join(JOBS, started.jobId + ".json"), "utf8"));
    assert.ok(j0.selector === null && j0.selectorDeadlineAt === null, "미도입=선별 계획 없음");
    assert.ok(Date.parse(j0.deadlineAt) - Date.parse(j0.createdAt) <= 7 * 60 * 1000 + 5000, "미도입 deadline=검증 예산 그대로(무회귀)");
    const until = Date.now() + 15000;
    let jd = j0;
    while (!["succeeded", "failed"].includes(jd.state) && Date.now() < until) { await sleep(150); jd = JSON.parse(fs.readFileSync(path.join(JOBS, started.jobId + ".json"), "utf8")); }
    assert.strictEqual(jd.state, "succeeded", "legacy 경로 완주: " + JSON.stringify(jd).slice(0, 300));
    const out = fs.readFileSync(path.join(JOBS, started.jobId + ".out"), "utf8");
    assert.ok(out.includes("deadline=" + jd.deadlineAt), "legacy=job.deadlineAt 전달(기존 계약 그대로)");
    t("미도입 무회귀: selector 미기록·deadline 산식·legacy deadline 전달 불변");
  }
  // [12] 1차 blocker 반례: 변경물 수집기가 '비-git(정상 축퇴)'과 'git 판독 실패(fail-closed)'를 구분
  {
    const dNG = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-nongit-"));
    const mNG = CL.selectorScopeMaterial(dNG);
    assert.ok(mNG.st === "ok" && mNG.nonGit === true && mNG.head === "no-git", "비-git=정상 축퇴(변경 추적 원천 없음)");
    const dBR = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-broken-"));
    fs.mkdirSync(path.join(dBR, ".git"));
    const mBR = CL.selectorScopeMaterial(dBR);
    assert.ok(mBR.st === "error" && /git-probe/.test(mBR.reason), "★.git 있는데 git이 못 읽음=error(빈 재료 위장 금지 — 1차 blocker 정방향)");
    const dGT = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-git-"));
    cp.execSync("git init -q", { cwd: dGT });
    fs.writeFileSync(path.join(dGT, "a.txt"), "hello");
    cp.execSync("git add a.txt", { cwd: dGT });
    fs.writeFileSync(path.join(dGT, "a.txt"), "hello world");
    fs.writeFileSync(path.join(dGT, ".env"), "SECRET=x");
    cp.execSync("git add .env", { cwd: dGT });
    fs.writeFileSync(path.join(dGT, ".env"), "SECRET=y");
    const mGT = CL.selectorScopeMaterial(dGT);
    assert.ok(mGT.st === "ok" && mGT.nonGit === false && mGT.files.includes("a.txt") && mGT.diffText.includes("hello world"), "git 저장소=strict 수집(무커밋 HEAD=no-head 정상): " + mGT.head);
    assert.ok(!mGT.files.some((f) => f.includes(".env")) && !mGT.diffText.includes("SECRET"), "민감 경로=목록·diff 모두 제외");
    // [f-c4f1dc00 반례] HEAD만 판독 불가(커밋은 존재)=no-head 축퇴 금지 — 커밋을 만들고 HEAD를 미탄생
    // 가지로 돌려 'rev-parse HEAD 깨끗한 실패+rev-list --all 비어있지 않음' 상태를 실물로 구성.
    const dHD = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-head-"));
    cp.execSync("git init -q", { cwd: dHD });
    cp.execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m x", { cwd: dHD });
    cp.execSync("git symbolic-ref HEAD refs/heads/ghost-unborn", { cwd: dHD });
    const mHD = CL.selectorScopeMaterial(dHD);
    assert.ok(mHD.st === "error" && /git-head: unreadable-with-commits/.test(mHD.reason), "★커밋이 있는데 HEAD 판독 실패=error(no-head 위장 금지): " + JSON.stringify(mHD).slice(0, 120));
    t("변경물 수집기 분류: 비-git=정상 축퇴·git 판독 실패=error·git=strict+민감 제외·HEAD 실패≠no-head(1·2차 blocker 봉합)");
  }
  // [13] worker: 변경물 판독 실패=failed(selector-scope) — 선별 없는/빈 재료 진행 금지
  {
    const WSB = fs.mkdtempSync(path.join(os.tmpdir(), "selwire-wsb-"));
    fs.mkdirSync(path.join(WSB, ".git")); // git처럼 보이는데 판독 불가
    fs.writeFileSync(path.join(WSB, CL.ARCHIVE_FILE), arcText);
    const snapB = "깨진 저장소 반례 턴";
    fs.writeFileSync(CL.constraintTurnFileFor(WSB, "anchB"), snapB);
    setMode("ok");
    const id = "ask-selscop-aaaaaaaaaa";
    const file = path.join(JOBS, id + ".json");
    const now = Date.now();
    fs.writeFileSync(file, JSON.stringify({
      schema: "ask-job-v1", id, state: "queued", workspace: WSB, execCwd: WSB, flags: ["--allow-new"], prompt: "scope-fail-check",
      timeoutMin: 7, createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 16 * 60 * 1000).toISOString(),
      selector: { archiveHash: ARC_HASH, itemCount: 2, pages: 1, arm: "self" },
      selectorDeadlineAt: new Date(now + 9 * 60 * 1000).toISOString(), verifierDeadlineAt: null,
      harnessMode: "claude-codex", constraintCtx: { provider: "claude", sessionId: SESS, turnAnchor: "anchB", sourceHash: sha1(snapB) },
    }));
    const jd = await runWorkerAndWait(file);
    assert.ok(jd.state === "failed" && jd.selectorOutcome === "selector-scope" && /scope material failed/.test(String(jd.error)), "★판독 실패=중단(빈 지문으로 선별·전이 진행 금지): " + JSON.stringify({ st: jd.state, o: jd.selectorOutcome }));
    t("worker: git 판독 실패=failed(selector-scope) — fail-open 축퇴 봉합 실행 반례");
  }
  // [14] [4a] 회수 출력 선별 요약 1줄(라운드 2+ 구현자 가시화 — stderr·기계 출력 무오염)
  {
    const id = "ask-selsumm-aaaaaaaaaa";
    const file = craftJob(id, { state: "succeeded", exitCode: 0, harnessMode: "claude-codex", finishedAt: new Date().toISOString(), selection: { archiveHash: ARC_HASH, scopePackageHash: "x", snapshotHash: SNAP_HASH, selectedIds: ["arc-2"], itemCount: 2, pages: 1, arm: "self", receiptFile: "r.json" } });
    fs.writeFileSync(path.join(JOBS, id + ".out"), "verifier answer body");
    const r = cp.spawnSync(process.execPath, [CLI, "ask-wait", id], { encoding: "utf8", env: { ...ENV, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("verifier answer body") && !r.stdout.includes("[서고 선별]"), "기계 출력(stdout)은 답 원문 그대로");
    assert.match(r.stderr, /\[서고 선별\] 이번 판 보관 수칙 1건 동봉\(서고 2항 중\) — arc-2/, "요약 1줄=stderr(선별 실물 기반)");
    fs.unlinkSync(file); fs.unlinkSync(path.join(JOBS, id + ".out"));
    t("회수 출력 선별 요약 1줄(stderr·수정 루프 구현자가 이번 판 기준을 봄)");
  }
  // [15] [4a] extension 결선 소스 핀: selecting 라벨·작업대 목적지(기본=서고·빼기=코어 고정)·서고 현황 동봉
  {
    const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
    assert.ok(ext.includes('case "selecting":'), "라이브 진행 단계에 selecting 라벨");
    assert.ok(ext.includes("dest:wbDest") && ext.includes('var wbDest=e9.arc?"archive":"core"'), "작업대 목적지 세그(기본=서고·구 런타임=코어 강등)");
    assert.ok(ext.includes('const dest9 = m.dest === "core" ? "core" : "archive"') && ext.includes("approvedHash: m.gen, target: dest9"), "핸들러=명시 코어만 코어·기본 서고+빌더 target 전달");
    assert.ok(ext.includes('if (dest9 === "archive" && rem9.length)'), "빼기+서고 혼합=거부(판 어긋남 방어 — 화면 잠금과 이중)");
    assert.ok(ext.includes("readVerifyEnvelopeArchive(repo9)") && ext.includes("arc?: { state: string; count: number; max: number }"), "서고 현황(arc) 카드 동봉+상태 타입");
    assert.ok(ext.includes("if(lock)wbDest=\"core\""), "빼기 표시 존재=목적지 코어 고정(코어 항목 대상)");
    assert.ok(ext.includes("d.live.round>0 ?") && !ext.includes("d.live.round||1") && !ext.includes("(d.live.round || 1)"), "★round 0='회차 1' 오표기 금지(선별/준비 표기 — 확인검증 blocker)");
    assert.ok(ext.includes("lib.phaseFileFor === \"function\"") , "진행 판독=이 창 ws 전용 기록 우선(타 프로젝트 덮어쓰기 소거 봉합)");
    t("extension 결선 소스 핀: selecting 라벨·목적지 세그·혼합 거부·서고 현황·round0 표기·ws별 진행 판독");
  }
  console.log(`envelope-selector-wire: ${n} groups passed`);
})().catch((e) => { console.error(e); process.exit(1); });
