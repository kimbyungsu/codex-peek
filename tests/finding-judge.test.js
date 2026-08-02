// 지적 처분 관문(2026-08-01) — '판단 없는 자동 수용'으로 왕복이 새는 경로 차단.
// 계약(1차 검증 반영): 같은 캠페인의 열린 지적마다 '마지막 등장(asOfRound) 기준 유효한' 처분 1건이
// 있어야 다음 ask 허용. 수용(fix-fact·fix-gap)·반박(rebut)=근거 12자+ 의무(park만 영수증이 근거).
// 재등장(occurrence)=과거 처분 무효화(재판단 강제). 판독 실패=미발동+경고(침묵 금지). 새 캠페인 미차단.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
process.env.CODEX_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fjudge_"));
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const CB = require(path.join(ROOT, "bridge", "codex-bridge.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews_"));
const CAMP = "cl:sess-1:2026-08-01T00:00:00.000Z";
const seed = (id, title, tag, round) => ({ type: "finding", findingId: id, campaignId: CAMP, round: round || 1, tag: tag || "blocker", titleNorm: title, origin: "baseline", oosId: "", envelopeHash: null, demoted: false, status: "open", closeReason: "", ts: "2026-08-01T00:01:00.000Z" });
const dispo = (id, choice, asOfRound, extra) => ({ type: "disposition", campaignId: CAMP, findingId: id, choice, note: "근거 문자열 — 충분히 길게 적음", backlogId: "", asOfRound, envelopeHash: null, ts: "2026-08-01T00:02:00.000Z", ...(extra || {}) });

console.log("[1] 처분 장부 도우미 — 대조·재처분·무효 레코드·asOfRound 결속");
{
  CL.appendFindingsLedger(WS, [seed("f-aaaa0001", "제목 하나"), seed("f-aaaa0002", "제목 둘", "주의")]);
  ok(CL.undisposedOpenFindings(WS, CAMP, null).length === 2, "처분 전 — 열린 2건 전부 미판단");
  CL.appendFindingsLedger(WS, [dispo("f-aaaa0001", "fix-fact", 1)]);
  const und1 = CL.undisposedOpenFindings(WS, CAMP, null);
  ok(und1.length === 1 && und1[0].id === "f-aaaa0002", "1건 처분(asOfRound=1) → 남은 미판단은 나머지 1건");
  // asOfRound 미결속(legacy·수동 append)=유효 처분 불인정 — 무근거 1회 기록 영구 통과 우회 차단(1차 blocker①)
  CL.appendFindingsLedger(WS, [{ type: "disposition", campaignId: CAMP, findingId: "f-aaaa0002", choice: "fix-gap", note: "n", ts: "t" }]);
  ok(CL.undisposedOpenFindings(WS, CAMP, null).some((o) => o.id === "f-aaaa0002"), "asOfRound 없는 처분=미판단 취급(수동 append 우회 차단)");
  // 무효 choice는 처분으로 안 침(장부 오염이 관문을 조용히 해제하면 안 됨)
  CL.appendFindingsLedger(WS, [{ type: "disposition", campaignId: CAMP, findingId: "f-aaaa0002", choice: "yes", asOfRound: 9, ts: "t" }]);
  ok(CL.undisposedOpenFindings(WS, CAMP, null).some((o) => o.id === "f-aaaa0002"), "무효 choice 레코드=처분 불인정");
  // 재처분=마지막 우선
  CL.appendFindingsLedger(WS, [dispo("f-aaaa0002", "rebut", 1), dispo("f-aaaa0002", "fix-gap", 1)]);
  ok(CL.dispositionsFor(WS, CAMP).get("f-aaaa0002").choice === "fix-gap", "재처분=마지막 기록 우선");
  ok(CL.undisposedOpenFindings(WS, CAMP, null).length === 0, "전부 유효 처분 → 미판단 0");
  ok(CL.fixGapCount(WS, CAMP) === 1 && CL.FIX_GAP_NOTICE_AT === 3, "fix-gap 집계 1건(최신 유효 처분 기준)·고지 임계 상수");
}

console.log("[2] 재등장(occurrence) — 과거 처분 무효화·재판단 강제(1차 blocker① 실행 반례)");
{
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews2r_"));
  CL.appendFindingsLedger(WS2, [seed("f-repeat01", "반복 지적"), dispo("f-repeat01", "fix-gap", 1)]);
  ok(CL.undisposedOpenFindings(WS2, CAMP, null).length === 0, "1라운드 처분 직후=판단 유효");
  // 검증자가 같은 id를 라운드 2에서 재지적 → occurrence 기록(machineFindingsLayer의 실제 레코드 형태)
  CL.appendFindingsLedger(WS2, [{ type: "occurrence", campaignId: CAMP, findingId: "f-repeat01", prevId: "f-repeat01", round: 2, envelopeHash: null, effectiveTag: "blocker", ts: "t" }]);
  const und = CL.undisposedOpenFindings(WS2, CAMP, null);
  ok(und.length === 1 && und[0].id === "f-repeat01", "재등장(round 2) → 과거 처분(asOf 1) 낡음=미판단 복귀");
  ok(CL.findingActivityRound(CL.readFindingsLedger(WS2), CAMP, "f-repeat01") === 2, "활동 라운드=finding·occurrence의 최대 round");
  CL.appendFindingsLedger(WS2, [dispo("f-repeat01", "rebut", 2)]);
  ok(CL.undisposedOpenFindings(WS2, CAMP, null).length === 0, "재판단(asOf 2) → 다시 유효");
}

console.log("[3] 관문 — 미판단이면 거부(왕복 미소모)·판단 완료면 통과");
{
  const WS3 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews2_"));
  CL.appendFindingsLedger(WS3, [seed("f-bbbb0001", "미판단 지적")]);
  const durable = { ok: true, job: { campaignId: CAMP } };
  const g1 = CB.findingDispositionGate(WS3, durable, "ko");
  ok(g1.proceed === false && g1.exitCode === 3, "미판단 1건 → 거부·exit 3(예약 전=왕복 미소모)");
  ok(g1.msg.includes("f-bbbb0001") && g1.msg.includes("finding-judge") && g1.msg.includes("검증을 시작하지 않았습니다"), "거부문=대상 id+해제 명령+미시작 명시(그 자리에서 알려줌)");
  ok(g1.msg.includes("재등장한 지적은 다시 판단"), "거부문에 재등장 재판단 계약 명시");
  const gEn = CB.findingDispositionGate(WS3, durable, "en");
  ok(gEn.proceed === false && gEn.msg.includes("NOT started") && gEn.msg.includes("finding-judge"), "en 거부문 쌍");
  CL.appendFindingsLedger(WS3, [dispo("f-bbbb0001", "rebut", 1)]);
  ok(CB.findingDispositionGate(WS3, durable, "ko").proceed === true, "전부 판단 → 통과");
  // campSnap 인자 우선(1차 blocker② — 호출자 1회 계산 값과 관문이 같은 캠페인을 봄)
  const gSnap = CB.findingDispositionGate(WS3, null, "ko", CAMP);
  ok(gSnap.proceed === true, "campSnap 명시 전달 → durableEnv 없이도 같은 캠페인 판정");
}

console.log("[4] 관문 — 새 캠페인·앵커 부재·legacy job은 막지 않음(잠금 사고 방지)");
{
  const WS4 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews3_"));
  CL.appendFindingsLedger(WS4, [seed("f-cccc0001", "이전 캠페인 잔여")]);
  ok(CB.findingDispositionGate(WS4, { ok: true, job: { campaignId: "cl:sess-1:2026-08-02T00:00:00.000Z" } }, "ko").proceed === true, "다른(새) 캠페인 job → 이전 캠페인 지적으로 미차단");
  ok(CB.findingDispositionGate(WS4, { ok: true, job: {} }, "ko").proceed === true, "legacy job(campaignId 없음) → 미발동");
  ok(CB.findingDispositionGate(WS4, { ok: false }, "ko").proceed === true, "비정본 env → 미발동");
  ok(CB.campaignSnapFor({ ok: true, job: { campaignId: "campQ" } }) === "campQ" && CB.campaignSnapFor({ ok: false }) === null, "campaignSnapFor=예산 게이트와 같은 산식(내구=job 동결)");
  const savedSid = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  ok(CB.findingDispositionGate(WS4, null, "ko").proceed === true, "직접 ask+앵커 부재 → 미발동");
  if (savedSid !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSid;
}

console.log("[5] 관문 — 세대 결속·판독 실패 가시화(1차 [주의])");
{
  const WS5 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews4_"));
  CL.appendFindingsLedger(WS5, [{ ...seed("f-dddd0001", "구세대 지적"), envelopeHash: "sha-old" }]);
  ok(CB.findingDispositionGate(WS5, { ok: true, job: { campaignId: CAMP } }, "ko").proceed === true, "동결 세대 불일치 open → 관문 대상 제외");
  // 판독 실패=미발동이되 경고 반환(빈 장부 위장 금지)
  const WS5b = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews4b_"));
  fs.mkdirSync(CL.findingsLedgerFileFor(WS5b), { recursive: true }); // 파일 자리에 디렉터리=EISDIR
  const st = CL.readFindingsLedgerState(WS5b);
  ok(st.readError === true && st.rows.length === 0, "readFindingsLedgerState — EISDIR=readError(빈 장부와 구분)");
  const gErr = CB.findingDispositionGate(WS5b, { ok: true, job: { campaignId: CAMP } }, "ko");
  ok(gErr.proceed === true && /관문이 동작하지 않았습니다/.test(gErr.warn), "판독 실패=미발동+경고 문구(침묵 통과 금지)");
  const WS5c = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews4c_"));
  ok(CL.readFindingsLedgerState(WS5c).readError === false, "장부 없음(ENOENT)=정상 빈 상태(경고 아님)");
}

console.log("[6] CLI finding-judge — 목록·근거 의무·park 자동 보관함");
{
  const HOME6 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudge5_"));
  const WS6 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews5_"));
  const env = { ...process.env, CODEX_BRIDGE_HOME: HOME6, CLAUDE_PROJECT_DIR: WS6 };
  delete env.CODEX_BRIDGE_ASK_JOB_ID;
  const seedJs = `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});
CL.appendFindingsLedger(process.argv[1],[
 {type:"finding",findingId:"f-eeee0001",campaignId:"campX",round:1,tag:"blocker",titleNorm:"고칠 지적",origin:"baseline",oosId:"",envelopeHash:null,demoted:false,status:"open",closeReason:"",ts:"t"},
 {type:"finding",findingId:"f-eeee0002",campaignId:"campX",round:1,tag:"주의",titleNorm:"보관할 지적",origin:"baseline",oosId:"",envelopeHash:null,demoted:false,status:"open",closeReason:"",ts:"t"}]);
const fs=require("fs");fs.mkdirSync(require("path").dirname(CL.campaignFileFor(process.argv[1])),{recursive:true});
fs.writeFileSync(CL.campaignFileFor(process.argv[1]),JSON.stringify({campaignId:"campX",count:1,budget:5,updatedAt:"t"}));`;
  const run = (args) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
  const s0 = run(["-e", seedJs, WS6]);
  ok(s0.status === 0, "시딩 스크립트 정상(" + String(s0.stderr || "").slice(0, 80) + ")");
  const BR = path.join(ROOT, "bridge", "codex-bridge.js");
  const list1 = run([BR, "finding-judge"]);
  ok(list1.status === 0 && list1.stdout.includes("f-eeee0001") && list1.stdout.includes("⬜"), "목록 — 미판단 표시");
  const bad = run([BR, "finding-judge", "f-eeee0001", "yes"]);
  ok(bad.status === 2 && /사용법|Usage/.test(bad.stderr), "무효 choice → exit 2·사용법");
  const noEv = run([BR, "finding-judge", "f-eeee0001", "rebut", "--note", "짧음"]);
  ok(noEv.status === 2 && /근거/.test(noEv.stderr), "rebut 근거 12자 미만 → 거부");
  const noteFix = run([BR, "finding-judge", "f-eeee0001", "fix-fact", "--note", "짧다"]);
  ok(noteFix.status === 2 && /근거/.test(noteFix.stderr), "fix-fact도 근거 의무(1차 blocker① — 수용이 싼 기본값이면 무력화)");
  const noteGap = run([BR, "finding-judge", "f-eeee0001", "fix-gap"]);
  ok(noteGap.status === 2, "fix-gap 무근거 → 거부");
  const unknown = run([BR, "finding-judge", "f-zzzz9999", "fix-fact", "--note", "근거 근거 근거 근거 근거"]);
  ok(unknown.status === 2, "열린 지적에 없는 id → exit 2");
  const okFix = run([BR, "finding-judge", "f-eeee0001", "fix-fact", "--note", "검증자 실행 반례로 사실 오류가 증명됨"]);
  ok(okFix.status === 0 && /기록됨|Recorded/.test(okFix.stdout) && /1건|1 unjudged/.test(okFix.stdout), "fix-fact(근거 포함) 기록+남은 미판단 수 표시");
  const okPark = run([BR, "finding-judge", "f-eeee0002", "park"]);
  ok(okPark.status === 0 && /보관함 영수증|backlog receipt/.test(okPark.stdout), "park=note 없이 허용(영수증이 근거) → 자동 등록+결속");
  const backlogChk = run(["-e", `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});const b=CL.readBacklog(process.argv[1]);process.stdout.write(JSON.stringify(b.items.map(x=>({t:x.title,s:x.status}))));`, WS6]);
  ok(backlogChk.stdout.includes("보관할 지적") && backlogChk.stdout.includes("open"), "보관함 실물 존재(open) — 기록만 남고 실물 없는 상태 아님");
  const dispChk = run(["-e", `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});const d=CL.dispositionsFor(process.argv[1],"campX");process.stdout.write(JSON.stringify([...d.values()].map(x=>({c:x.choice,r:x.asOfRound}))));`, WS6]);
  ok(/"r":1/.test(dispChk.stdout), "CLI 기록에 asOfRound 결속(재등장 시 무효화 재료)");
  const list2 = run([BR, "finding-judge"]);
  ok(list2.status === 0 && /전부 판단됨|All judged/.test(list2.stdout), "전부 판단 → 시작 가능 안내");
}

console.log("[7] fix-gap 수확 체감 신호 — 임계 도달 시 고지(비차단)·대체 레코드 중복 집계 금지");
{
  const HOME7 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudge6_"));
  const WS7 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews6_"));
  const env = { ...process.env, CODEX_BRIDGE_HOME: HOME7, CLAUDE_PROJECT_DIR: WS7 };
  const seedJs = `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});
const mk=(i)=>({type:"finding",findingId:"f-gap0000"+i,campaignId:"campY",round:1,tag:"주의",titleNorm:"보강 요구 "+i,origin:"baseline",oosId:"",envelopeHash:null,demoted:false,status:"open",closeReason:"",ts:"t"});
CL.appendFindingsLedger(process.argv[1],[mk(1),mk(2),mk(3)]);
const fs=require("fs");fs.mkdirSync(require("path").dirname(CL.campaignFileFor(process.argv[1])),{recursive:true});
fs.writeFileSync(CL.campaignFileFor(process.argv[1]),JSON.stringify({campaignId:"campY",count:1,budget:5,updatedAt:"t"}));`;
  const run = (args) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
  run(["-e", seedJs, WS7]);
  const BR = path.join(ROOT, "bridge", "codex-bridge.js");
  const N = "--note", LONGN = "틀린 건 아니지만 보강 요구를 받아들임";
  const r1 = run([BR, "finding-judge", "f-gap00001", "fix-gap", N, LONGN]);
  const r2 = run([BR, "finding-judge", "f-gap00002", "fix-gap", N, LONGN]);
  ok(!/수확 체감|diminishing/.test(r1.stdout + r2.stdout), "임계 미만(1·2건째)=고지 없음(소음 금지)");
  const r3 = run([BR, "finding-judge", "f-gap00003", "fix-gap", N, LONGN]);
  ok(r3.status === 0 && /수확 체감/.test(r3.stdout) && /3건째/.test(r3.stdout), "3건째=수확 체감 신호 고지(차단 아님·exit 0)");
  // [보완] 반영: 재처분으로 fix-gap→rebut 대체 시 과거 레코드 중복 집계 금지(1차 실행 대조 반례)
  const r4 = run([BR, "finding-judge", "f-gap00001", "rebut", N, "측정으로 반박 — 재현 절차와 결과를 확인함"]);
  ok(r4.status === 0 && !/3건째|4건째/.test(r4.stdout), "fix-gap→rebut 재처분=집계 감소(대체 레코드 미중복)");
  const cntChk = run(["-e", `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});process.stdout.write(String(CL.fixGapCount(process.argv[1],"campY")));`, WS7]);
  ok(cntChk.stdout === "2", "fixGapCount=최신 유효 처분 기준 고유 지적 수(3→2)");
}

console.log("[8] machineFindingsLayer 캠페인 스냅(1차 blocker②) — 생산자·관문 동일 귀속");
{
  const HOME8 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudge8_"));
  const WS8 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews8_"));
  const env = { ...process.env, CODEX_BRIDGE_HOME: HOME8, CLAUDE_PROJECT_DIR: WS8 };
  delete env.CODEX_BRIDGE_ASK_JOB_ID;
  // 캠페인 파일은 '다른' 캠페인을 가리킴 — 스냅 전달이 없으면 지적이 campOther로 귀속돼 관문이 못 봄
  const js = `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});
const CB=require(${JSON.stringify(path.join(ROOT, "bridge", "codex-bridge.js"))});
const fs=require("fs");fs.mkdirSync(require("path").dirname(CL.campaignFileFor(process.argv[1])),{recursive:true});
fs.writeFileSync(CL.campaignFileFor(process.argv[1]),JSON.stringify({campaignId:"campOther",count:1,budget:5,updatedAt:"t"}));
const ans=["[지적 목록 v2]",JSON.stringify({tag:"blocker",title:"스냅 결속 확인용",origin:"baseline",supported:true}),"[지적 목록 끝]","","검증: 실패"].join("\\n");
CB.machineFindingsLayer(ans,process.argv[1],"ko","core","claude-codex","ask-x","campFrozen");
const rows=CL.readFindingsLedger(process.argv[1]).filter(r=>r.type==="finding");
process.stdout.write(JSON.stringify(rows.map(r=>r.campaignId)));`;
  const r = spawnSync(process.execPath, ["-e", js, WS8], { env, encoding: "utf8" });
  ok(r.status === 0 && r.stdout.includes("campFrozen") && !r.stdout.includes("campOther"), "campSnap 전달 → 지적이 동결 캠페인으로 귀속(현재 파일 재판독 아님)" + (r.status !== 0 ? " [" + String(r.stderr).slice(0, 120) + "]" : ""));
}

console.log("[9] 손상 장부 줄 — 판독 무해(관문 오발동·크래시 없음)");
{
  const WS9 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgews7_"));
  CL.appendFindingsLedger(WS9, [seed("f-ffff0001", "정상 지적")]);
  fs.appendFileSync(CL.findingsLedgerFileFor(WS9), "{손상된 줄\n");
  const g = CB.findingDispositionGate(WS9, { ok: true, job: { campaignId: CAMP } }, "ko");
  ok(g.proceed === false && g.msg.includes("f-ffff0001"), "손상 줄 무시·정상 지적은 여전히 관문 대상");
}

console.log("[10] 계보 재등장(확인 blocker①) — occurrence가 루트에 기록돼도 열린 자식의 처분이 낡는다");
{
  const WSA = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsA_"));
  // 루트는 닫힘·자식은 열림(검증자 실행 반례 구성): 자식 처분(asOf=2) 후 3라운드 재등장이
  // rootOf 정규화로 {findingId: root, prevId: child}에 기록되는 실제 생산자 형태
  CL.appendFindingsLedger(WSA, [
    seed("f-root0001", "루트 지적", "blocker", 1),
    { type: "close", campaignId: CAMP, findingId: "f-root0001", closeReason: "reclassified", round: 2, envelopeHash: null, ts: "t" },
    seed("f-child001", "자식 지적", "blocker", 2),
    dispo("f-child001", "fix-gap", 2),
  ]);
  ok(CL.undisposedOpenFindings(WSA, CAMP, null).length === 0, "자식 처분(asOf=2) 직후=유효");
  CL.appendFindingsLedger(WSA, [{ type: "occurrence", campaignId: CAMP, findingId: "f-root0001", prevId: "f-child001", round: 3, envelopeHash: null, effectiveTag: "blocker", ts: "t" }]);
  ok(CL.findingActivityRound(CL.readFindingsLedger(WSA), CAMP, "f-child001") === 3, "prevId 인용 occurrence도 자식의 활동으로 집계");
  const undA = CL.undisposedOpenFindings(WSA, CAMP, null);
  ok(undA.length === 1 && undA[0].id === "f-child001", "루트 앞 occurrence에도 열린 자식 처분이 낡음=재판단 복귀(검증자 반례 봉합)");
}

console.log("[10b] 변형③(3회차 blocker) — id+다른 prevId 동시 제출로 자식이 두 필드에서 사라지는 경로");
{
  const WSB0 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsAb_"));
  // 검증자 실행 반례의 결과 형태: occurrence {findingId: root, prevId: root} — 자식은 subjectId에만 남는다
  CL.appendFindingsLedger(WSB0, [
    seed("f-child001", "자식 지적", "blocker", 2),
    dispo("f-child001", "fix-gap", 2),
    { type: "occurrence", campaignId: CAMP, findingId: "f-root0001", prevId: "f-root0001", subjectId: "f-child001", round: 3, envelopeHash: null, effectiveTag: "blocker", ts: "t" },
  ]);
  ok(CL.findingActivityRound(CL.readFindingsLedger(WSB0), CAMP, "f-child001") === 3, "subjectId 축도 자식 활동으로 집계(prevId·findingId 모두 루트여도)");
  const undB = CL.undisposedOpenFindings(WSB0, CAMP, null);
  ok(undB.length === 1 && undB[0].id === "f-child001", "변형③에서도 자식 처분이 낡음=재판단 복귀");
}

console.log("[10c] 생산자 e2e — 실제 machineFindingsLayer가 subjectId를 기록하는지(변형③ 원천 봉합)");
{
  const WSC0 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsAc_"));
  const SHA = "a".repeat(40); // env-freeze-v1은 40자리 16진만 인정(형식 미달=동결 무효)
  const ROOTID = "f-aaaa1111", CHILDID = "f-bbbb2222"; // 응답 인용 id는 f-+hex8 형식 검증을 통과해야 함
  // 루트 닫힘·자식 열림(자식 finding행 prevId=root — rootOf가 root로 정규화되는 실제 조건)
  CL.appendFindingsLedger(WSC0, [
    { type: "finding", findingId: ROOTID, campaignId: "campE2E", round: 1, tag: "blocker", titleNorm: "루트 지적", origin: "baseline", oosId: "", envelopeHash: SHA, demoted: false, status: "open", closeReason: "", ts: "t" },
    { type: "close", campaignId: "campE2E", findingId: ROOTID, closeReason: "reclassified", round: 1, envelopeHash: SHA, ts: "t" },
    { type: "round", campaignId: "campE2E", round: 1, roundType: "initial", verdict: "fail", envelopeHash: SHA, ts: "t" },
    { type: "finding", findingId: CHILDID, campaignId: "campE2E", round: 1, tag: "blocker", titleNorm: "자식 지적", origin: "baseline", oosId: "", prevId: ROOTID, envelopeHash: SHA, demoted: false, status: "open", closeReason: "", ts: "t" },
    { type: "disposition", campaignId: "campE2E", findingId: CHILDID, choice: "fix-gap", note: "보강 요구 수용 사유를 기록함", backlogId: "", asOfRound: 1, envelopeHash: null, ts: "t" },
  ]);
  const savedJid = process.env.CODEX_BRIDGE_ASK_JOB_ID;
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e2e-0001";
  ok(CL.writeEnvelopeFreeze(WSC0, SHA, "ask-e2e-0001") === true && CL.readFrozenEnvelope(WSC0) === SHA, "동결 기록·판독 성립(형식 유효 40-hex)");
  // 재지적: id=자식 + 계보용 prevId=루트(다른 값) — 변형③의 실제 제출 형태
  const ans = ["[지적 목록 v2]", JSON.stringify({ tag: "blocker", title: "자식 지적", origin: "incomplete-fix", supported: true, id: CHILDID, prevId: ROOTID }), "[지적 목록 끝]", "", "검증: 실패"].join("\n");
  CB.machineFindingsLayer(ans, WSC0, "ko", "core", "claude-codex", "ask-x2", "campE2E");
  if (savedJid === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = savedJid;
  const occ = CL.readFindingsLedger(WSC0).filter((r) => r.type === "occurrence");
  ok(occ.length === 1 && occ[0].findingId === ROOTID && occ[0].subjectId === CHILDID, "생산자가 인용 자식을 subjectId로 보존(" + JSON.stringify(occ.map((o) => ({ f: o.findingId, p: o.prevId, s: o.subjectId }))) + ")");
  const undC = CL.undisposedOpenFindings(WSC0, "campE2E", SHA);
  ok(undC.some((o) => o.id === CHILDID), "재등장 후 자식 처분 무효화=관문 재차단(검증자 반례 원천 봉합)");
}

console.log("[10d] 다자식 동시 재지적(4회차 blocker) — 루트당 1건 유지+subjectIds 전원 보존");
{
  const WSD0 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsAd_"));
  const SHA = "b".repeat(40);
  const ROOTID = "f-aaaa1111", C1 = "f-bbbb2222", C2 = "f-cccc3333";
  CL.appendFindingsLedger(WSD0, [
    { type: "finding", findingId: ROOTID, campaignId: "campMulti", round: 1, tag: "blocker", titleNorm: "루트 지적", origin: "baseline", oosId: "", envelopeHash: SHA, demoted: false, status: "open", closeReason: "", ts: "t" },
    { type: "close", campaignId: "campMulti", findingId: ROOTID, closeReason: "reclassified", round: 1, envelopeHash: SHA, ts: "t" },
    { type: "round", campaignId: "campMulti", round: 1, roundType: "initial", verdict: "fail", envelopeHash: SHA, ts: "t" },
    { type: "finding", findingId: C1, campaignId: "campMulti", round: 1, tag: "blocker", titleNorm: "자식 하나", origin: "baseline", oosId: "", prevId: ROOTID, envelopeHash: SHA, demoted: false, status: "open", closeReason: "", ts: "t" },
    { type: "finding", findingId: C2, campaignId: "campMulti", round: 1, tag: "blocker", titleNorm: "자식 둘", origin: "baseline", oosId: "", prevId: ROOTID, envelopeHash: SHA, demoted: false, status: "open", closeReason: "", ts: "t" },
    { type: "disposition", campaignId: "campMulti", findingId: C1, choice: "fix-gap", note: "보강 요구 수용 사유를 기록함", backlogId: "", asOfRound: 1, envelopeHash: null, ts: "t" },
    { type: "disposition", campaignId: "campMulti", findingId: C2, choice: "fix-gap", note: "보강 요구 수용 사유를 기록함", backlogId: "", asOfRound: 1, envelopeHash: null, ts: "t" },
  ]);
  const savedJid = process.env.CODEX_BRIDGE_ASK_JOB_ID;
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-e2e-0002";
  CL.writeEnvelopeFreeze(WSD0, SHA, "ask-e2e-0002");
  const ans = ["[지적 목록 v2]",
    JSON.stringify({ tag: "blocker", title: "자식 하나", origin: "incomplete-fix", supported: true, id: C1, prevId: ROOTID }),
    JSON.stringify({ tag: "blocker", title: "자식 둘", origin: "incomplete-fix", supported: true, id: C2, prevId: ROOTID }),
    "[지적 목록 끝]", "", "검증: 실패"].join("\n");
  CB.machineFindingsLayer(ans, WSD0, "ko", "core", "claude-codex", "ask-x3", "campMulti");
  if (savedJid === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = savedJid;
  const occ = CL.readFindingsLedger(WSD0).filter((r) => r.type === "occurrence");
  ok(occ.length === 1, "루트당 occurrence 1건 유지(계보 반복 집계 미부풀 — 레코드 수 " + occ.length + ")");
  ok(occ.length === 1 && Array.isArray(occ[0].subjectIds) && occ[0].subjectIds.includes(C1) && occ[0].subjectIds.includes(C2), "subjectIds에 두 자식 전원 보존(" + JSON.stringify(occ[0] && occ[0].subjectIds) + ")");
  const rowsD = CL.readFindingsLedger(WSD0);
  ok(CL.findingActivityRound(rowsD, "campMulti", C1) === 2 && CL.findingActivityRound(rowsD, "campMulti", C2) === 2, "두 자식 모두 활동 라운드 상승(둘째 자식 소거 반례 봉합)");
  const undD = CL.undisposedOpenFindings(WSD0, "campMulti", SHA);
  ok(undD.some((o) => o.id === C1) && undD.some((o) => o.id === C2), "두 자식 처분 모두 무효화=재판단 강제(검증자 반례 봉합)");
}

console.log("[11] --campaign 결속(확인 blocker②) — 관문 캠페인과 현재 캠페인 파일이 갈려도 해제 가능");
{
  const HOMEB = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgeB_"));
  const WSB = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsB_"));
  const env = { ...process.env, CODEX_BRIDGE_HOME: HOMEB, CLAUDE_PROJECT_DIR: WSB };
  const seedJs = `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});
CL.appendFindingsLedger(process.argv[1],[{type:"finding",findingId:"f-frzn0001",campaignId:"campFrozen",round:1,tag:"blocker",titleNorm:"동결 캠페인 지적",origin:"baseline",oosId:"",envelopeHash:null,demoted:false,status:"open",closeReason:"",ts:"t"}]);
const fs=require("fs");fs.mkdirSync(require("path").dirname(CL.campaignFileFor(process.argv[1])),{recursive:true});
fs.writeFileSync(CL.campaignFileFor(process.argv[1]),JSON.stringify({campaignId:"campOther",count:1,budget:5,updatedAt:"t"}));`;
  const run = (args) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
  run(["-e", seedJs, WSB]);
  const BR = path.join(ROOT, "bridge", "codex-bridge.js");
  const noFlag = run([BR, "finding-judge"]);
  ok(noFlag.status === 0 && /열린 지적 없음/.test(noFlag.stdout) && /--campaign/.test(noFlag.stdout), "캠페인 갈림+무플래그 → 없음이되 --campaign 안내(교착 탈출로 제시)");
  const withFlag = run([BR, "finding-judge", "--campaign", "campFrozen"]);
  ok(withFlag.status === 0 && withFlag.stdout.includes("f-frzn0001"), "--campaign 지정 → 동결 캠페인 목록 조회");
  const rec = run([BR, "finding-judge", "f-frzn0001", "rebut", "--note", "측정으로 반박 — 재현 절차와 결과 확인함", "--campaign", "campFrozen"]);
  ok(rec.status === 0 && /기록됨/.test(rec.stdout), "--campaign 지정 기록 성공(교착 해소)");
  const gateChk = run(["-e", `const CB=require(${JSON.stringify(path.join(ROOT, "bridge", "codex-bridge.js"))});const g=CB.findingDispositionGate(process.argv[1],{ok:true,job:{campaignId:"campFrozen"}},"ko");process.stdout.write(JSON.stringify({p:g.proceed}));`, WSB]);
  ok(gateChk.stdout.includes('"p":true'), "처분 후 동결 캠페인 관문 통과(관문·해제 명령 같은 캠페인)");
  // 관문 거부문 자체가 캠페인 id를 결속해 인쇄하는지(해제 명령을 그대로 복사 가능해야 함)
  const g2 = CB.findingDispositionGate(fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsB2_")), { ok: true, job: { campaignId: CAMP } }, "ko");
  ok(g2.proceed === true || g2.msg.includes(`--campaign "${CAMP}"`), "거부문에 --campaign 결속(전제: 거부 발생 시)");
  const WSB3 = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsB3_"));
  CL.appendFindingsLedger(WSB3, [seed("f-gggg0001", "결속 확인")]);
  const g3 = CB.findingDispositionGate(WSB3, { ok: true, job: { campaignId: CAMP } }, "ko");
  ok(g3.proceed === false && g3.msg.includes(`--campaign "${CAMP}"`), "거부문 실측 — 명령·현황 줄에 관문 캠페인 id 인쇄");
}

console.log("[12] 표시·집계=관문과 같은 유효성 계산(확인 [보완]①② — blocker① 동반 수정면)");
{
  const HOMEC = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgeC_"));
  const WSC = fs.mkdtempSync(path.join(os.tmpdir(), "fjudgewsC_"));
  const env = { ...process.env, CODEX_BRIDGE_HOME: HOMEC, CLAUDE_PROJECT_DIR: WSC };
  const seedJs = `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});
CL.appendFindingsLedger(process.argv[1],[
 {type:"finding",findingId:"f-stale001",campaignId:"campZ",round:1,tag:"주의",titleNorm:"낡은 처분 표시 확인",origin:"baseline",oosId:"",envelopeHash:null,demoted:false,status:"open",closeReason:"",ts:"t"},
 {type:"disposition",campaignId:"campZ",findingId:"f-stale001",choice:"fix-gap",note:"보강 요구를 받아들이는 이유 기록",backlogId:"",asOfRound:1,envelopeHash:null,ts:"t"},
 {type:"occurrence",campaignId:"campZ",findingId:"f-stale001",prevId:"f-stale001",round:2,envelopeHash:null,effectiveTag:"주의",ts:"t"}]);
const fs=require("fs");fs.mkdirSync(require("path").dirname(CL.campaignFileFor(process.argv[1])),{recursive:true});
fs.writeFileSync(CL.campaignFileFor(process.argv[1]),JSON.stringify({campaignId:"campZ",count:1,budget:5,updatedAt:"t"}));`;
  const run = (args) => spawnSync(process.execPath, args, { env, encoding: "utf8" });
  run(["-e", seedJs, WSC]);
  const BR = path.join(ROOT, "bridge", "codex-bridge.js");
  const list = run([BR, "finding-judge"]);
  ok(list.status === 0 && /🔁/.test(list.stdout) && !/✅/.test(list.stdout) && /미판단 1건/.test(list.stdout), "낡은 처분=🔁 재판단 필요 표시(전부 판단됨 오표시 소멸 — 관문과 동일 판정)");
  const cnt = run(["-e", `const CL=require(${JSON.stringify(path.join(ROOT, "bridge", "contract-lib.js"))});process.stdout.write(String(CL.fixGapCount(process.argv[1],"campZ")));`, WSC]);
  ok(cnt.stdout === "0", "낡은 fix-gap 처분=집계 제외(유효 처분만)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
