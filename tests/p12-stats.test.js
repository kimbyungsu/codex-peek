"use strict";
/*
 * P-12 2d — 통계·승격 안내(설계 동결 v1~v7).
 * 계약: 검증 행에 프로필·캠페인·추적·소요 메타(원문 무추가) → 집계는 실효 판정 권위·비-accepted 행 분리·
 * 캠페인 3분류(혼합 과대계상 차단)·완전 추적 캠페인만 평균·커버리지 가시화·회차 의미 검증 →
 * 승격 안내는 '정상 판정 accepted 무결성 행'만 인정(사실 진술·구 기록 병기).
 * 기록 계층: 예산 예약 후 모든 종결=단일 recordAttemptOnce(5종 결과·exit 훅 매핑) — 종결당 기록 시도 1회.
 * ※ out/verify-stats.js는 npm test compile 산출물 — 단독 실행 시 먼저 `npm run compile`.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const { computeVerifyStats, VERIFY_STATS_MIN_SAMPLE } = require(path.join(ROOT, "out", "verify-stats.js"));
const normWs = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const NOW = Date.parse("2026-07-19T12:00:00Z");
const ago = (d) => new Date(NOW - d * 864e5).toISOString();
const J = (o) => JSON.stringify(o);
const cs = (rows) => computeVerifyStats(rows.join("\n"), NOW, null, normWs);

console.log("[1] 실효 판정 권위 + 비-accepted 분리(3차 B2)");
{
  const s = cs([
    J({ ts: ago(1), workspace: "/w", verdict: "pass", machineEffective: "inconclusive", machineDemoted: true, profile: "core" }),
    J({ ts: ago(1), workspace: "/w", verdict: "pass", machineEffective: "pass-notes", machineCorrected: true, profile: "core" }),
    J({ ts: ago(1), workspace: "/w", outcome: "run-error", profile: "core" }),
    J({ ts: ago(1), workspace: "/w", outcome: "proof-rejected", profile: "integrity" }),
    J({ ts: ago(1), workspace: "/w", outcome: "session-unresolved", profile: "core" }),
    J({ ts: ago(1), workspace: "/w", outcome: "postprocess-error", profile: "core" }),
  ]);
  ok(s.week.inconclusive === 1 && s.week.passNotes === 1 && s.week.pass === 0, "판정 버킷 — machineEffective 우선(원시 pass가 강등·정정 반영)");
  ok(s.week.total === 2 && s.week.unparsed === 0, "비-accepted 행 — 판정 버킷 미산입(unparsed 오염 차단)");
  ok(s.outcomes28.runError === 1 && s.outcomes28.proofRejected === 1 && s.outcomes28.sessionUnresolved === 1 && s.outcomes28.postprocessError === 1, "실행 실패 5종 결과 — outcomes28 별도 계수");
  ok(s.byProfile.core.count === 2 && s.byProfile.core.demoted === 1 && s.byProfile.core.corrected === 1 && s.byProfile.core.effInconclusive === 1, "byProfile — count=accepted만·강등/정정 계수");
  ok(s.byProfile.core.attempts === 5 && s.byProfile.integrity.attempts === 1 && s.byProfile.integrity.count === 0, "byProfile.attempts — outcome 무관 전 시도(core 실패 3건 귀속·integrity는 proof 거부 1건만 — 구현검증 2차 blocker)");
}

console.log("[2] 캠페인 3분류·완전 추적 평균·커버리지(1차 B3·B4)");
{
  const rowsFor = (cid, profile, rounds, tracked) => rounds.map((n, i) => J({ ts: ago(2, i), workspace: "/w", verdict: "pass", profile, campaignId: cid, verifyRound: n, budgetTracked: tracked !== false }));
  const s = cs([
    ...rowsFor("c1", "core", [1, 2, 3]),
    ...rowsFor("c2", "core", [1]),
    ...rowsFor("c3", "integrity", [1, 2]),
    // 혼합 캠페인 — core 2회+integrity 1회: 어느 평균에도 미산입·mixed 계수
    J({ ts: ago(2), workspace: "/w", verdict: "pass", profile: "core", campaignId: "c4", verifyRound: 1, budgetTracked: true }),
    J({ ts: ago(2), workspace: "/w", verdict: "pass", profile: "core", campaignId: "c4", verifyRound: 2, budgetTracked: true }),
    J({ ts: ago(2), workspace: "/w", verdict: "pass", profile: "integrity", campaignId: "c4", verifyRound: 3, budgetTracked: true }),
    // 미집계 포함 캠페인 — 평균 제외+불완전 계수(낙관 편향 차단)
    J({ ts: ago(2), workspace: "/w", verdict: "pass", profile: "core", campaignId: "c5", verifyRound: 1, budgetTracked: true }),
    J({ ts: ago(2), workspace: "/w", verdict: "pass", profile: "core", campaignId: "c5", budgetTracked: false, untrackedReason: "counter-write-failed" }),
  ]);
  ok(s.campaigns28.total === 5 && s.campaigns28.coreOnly === 3 && s.campaigns28.integrityOnly === 1 && s.campaigns28.mixed === 1, "3분류 — core-only 3·integrity-only 1·mixed 1(중복 분모 없음)");
  ok(s.campaigns28.sampleCore === 2 && s.campaigns28.avgRoundsCore === 2, "핵심 평균 — 완전 추적 단일 프로필(c1=3, c2=1)만 → 평균 2(혼합 c4·불완전 c5 제외)");
  ok(s.campaigns28.sampleIntegrity === 1 && s.campaigns28.avgRoundsIntegrity === 2, "무결성 평균 — c3=2");
  ok(s.campaigns28.incompleteCampaigns === 1 && s.campaigns28.untrackedRows === 1, "미집계 가시화 — 불완전 캠페인·미집계 행 계수");
  ok(s.campaigns28.campaignRows === 11 && s.campaigns28.trackedRows === 10, "커버리지 — 추적/전체 행(11행 중 10 추적)");
  ok(typeof VERIFY_STATS_MIN_SAMPLE === "number" && VERIFY_STATS_MIN_SAMPLE === 5, "표본 정책값 5 명시(정찰 상수 재사용 아님)");
}

console.log("[3] 회차 의미 검증(2차 [보완]4) — 중복·역행·비정수=손상·평균 미산입");
{
  const s = cs([
    J({ ts: ago(3), workspace: "/w", verdict: "pass", profile: "core", campaignId: "cx", verifyRound: 1, budgetTracked: true }),
    J({ ts: ago(3), workspace: "/w", verdict: "pass", profile: "core", campaignId: "cx", verifyRound: 1, budgetTracked: true }),
    J({ ts: ago(3), workspace: "/w", verdict: "pass", profile: "core", campaignId: "cy", verifyRound: 0.5, budgetTracked: true }),
    J({ ts: ago(3), workspace: "/w", verdict: "pass", profile: "core", campaignId: "cz", verifyRound: 2, budgetTracked: true }),
  ]);
  ok(s.campaigns28.corruptRounds === 2 && s.campaigns28.sampleCore === 1 && s.campaigns28.avgRoundsCore === 2, "중복(cx)·비정수(cy)=손상 계수·평균은 cz만");
}

console.log("[4] 승격 안내 재료(3차 B2·[주의]) — 정상 판정 accepted 무결성만·구 기록 병기");
{
  const s = cs([
    J({ ts: ago(5), workspace: "/w", verdict: "pass", profile: "core" }),
    J({ ts: ago(4), workspace: "/w", outcome: "run-error", profile: "integrity" }),        // error류 — 미산입
    J({ ts: ago(3), workspace: "/w", verdict: "unparsed", profile: "integrity" }),          // 표지 없음 — 정상 판정 아님
    J({ ts: ago(10), workspace: "/w", verdict: "pass" }),                                   // 프로필 미상(구 기록)
  ]);
  ok(s.escalation.lastCoreTs > 0 && s.escalation.lastIntegrityOkTs === 0, "실행 실패·표지 없음 무결성 행은 '최근 무결성'으로 안 침(승격 안내 유지)");
  ok(s.escalation.legacyRows === 1, "프로필 미상 행 계수 — 안내에 병기(과거 이력 오판 방지)");
  const s2 = cs([
    J({ ts: ago(5), workspace: "/w", verdict: "pass", profile: "core" }),
    J({ ts: ago(2), workspace: "/w", verdict: "pass-notes", profile: "integrity" }),
  ]);
  ok(s2.escalation.lastIntegrityOkTs > s2.escalation.lastCoreTs, "정상 판정 무결성 행 — 최근 무결성 갱신");
}

console.log("[5] 소요시간 집계(7차 [보완]·구현검증 1차 blocker②) — 유효값만·실패 종결 소요도 합산");
{
  const s = cs([
    J({ ts: ago(1), workspace: "/w", verdict: "pass", profile: "core", durationMs: 4000 }),
    J({ ts: ago(1), workspace: "/w", verdict: "pass", profile: "core", durationMs: -5 }),
    J({ ts: ago(1), workspace: "/w", verdict: "pass", profile: "core" }),
    J({ ts: ago(1), workspace: "/w", outcome: "run-error", profile: "core", durationMs: 6000 }),
  ]);
  ok(s.byProfile.core.durationMsSum === 10000 && s.byProfile.core.durationCount === 2, "음수·부재 제외+실패 종결 소요 합산(실패 잦은 프로필 낙관 표시 차단)");
  ok(s.byProfile.core.count === 3, "count는 accepted 전용 유지(소요 분모=durationCount)");
}

console.log("[6] 기록 계층 e2e(실 프로세스) — 5종 결과·예약 전 거부 0행·exit 훅");
{
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "p12st_"));
  const act = path.join(H, "active"); fs.mkdirSync(act, { recursive: true });
  const SID = "sess-st-01", TS = "2026-07-19T10:00:00.000Z";
  fs.writeFileSync(path.join(act, SID + ".json"), JSON.stringify({ claudeSession: SID, workspace: H, ts: TS }));
  fs.mkdirSync(path.join(H, "contracts"), { recursive: true });
  process.env.CODEX_BRIDGE_HOME = H;
  const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
  const wsKey = CL.wsKeyFor(H);
  fs.writeFileSync(path.join(H, "contracts", wsKey + ".json"), JSON.stringify({ workspace: H, verifyProfile: "core", verifyBudget: 4 }));
  const UUID = "32345678-1234-4123-8123-123456789abc";
  const KO = { s: "[지적 목록 v1]", e: "[지적 목록 끝]" };
  const answer = [KO.s, KO.e, "검증: 통과"].join("\n");
  const fakeCodex = path.join(H, "fake-codex.js");
  const writeFake = (ans) => fs.writeFileSync(fakeCodex, [
    "const fs=require('fs');",
    "const i=process.argv.indexOf('-o');",
    "if(i>=0)fs.writeFileSync(process.argv[i+1]," + JSON.stringify(ans) + ");",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'" + UUID + "'})+'\\n');",
  ].join("\n"));
  writeFake(answer);
  const CH = path.join(H, "codex-home");
  const sess = path.join(CH, "sessions", "2026", "07", "19");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, "rollout-2026-07-19T10-00-00-" + UUID + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id: UUID, cwd: H } }) + "\n");
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const env = { ...process.env, CODEX_BRIDGE_HOME: H, CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PROJECT_DIR: H, CODEX_BIN: fakeCodex, CODEX_HOME: CH };
  delete env.CODEX_BRIDGE_JOB_PROMPT_FILE; delete env.CODEX_BRIDGE_ASK_JOB_ID; delete env.CODEX_BRIDGE_WORKER_BRIDGE;
  const statsFile = path.join(H, "stats", "verdicts.jsonl");
  const rowsNow = () => { try { return fs.readFileSync(statsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  // ① accepted — 직접 ask 성공 1행(프로필·캠페인·회차·추적·소요 포함)
  const r1 = cp.spawnSync(process.execPath, [cli, "ask", "--allow-new", "stats-accepted"], { cwd: H, encoding: "utf8", env, timeout: 60000, windowsHide: true });
  const rows1 = rowsNow();
  ok(r1.status === 0 && rows1.length === 1 && rows1[0].outcome === "accepted", "accepted — 정확히 1행(이중 append 없음): " + rows1.length);
  const a = rows1[0] || {};
  ok(a.profile === "core" && a.budgetTracked === true && a.verifyRound === 1 && typeof a.campaignId === "string" && a.campaignId.startsWith("cl:"), "행 메타 — 프로필·캠페인·회차·추적");
  ok(typeof a.durationMs === "number" && a.durationMs >= 0 && a.verdict === "pass" && a.blockerCount === 0, "행 메타 — 소요·판정·blockerCount(정상 판독)");

  // ①b resume accepted — 같은 링크 정상 재검증(연결 분기 실행 증거 · 구현검증 1차 blocker③)
  const r1b = cp.spawnSync(process.execPath, [cli, "ask", "stats-accepted-resume"], { cwd: H, encoding: "utf8", env, timeout: 60000, windowsHide: true });
  const rows1b = rowsNow();
  ok(r1b.status === 0 && rows1b.length === 2 && rows1b[1].outcome === "accepted" && rows1b[1].verifyRound === 2, "resume accepted — 연결 분기도 정확히 1행(회차 2 — 같은 캠페인 누적)");

  // ② run-error — 모델 실행 실패(exit 훅 아닌 pre-call 종결 매핑)
  fs.writeFileSync(fakeCodex, "process.stderr.write('boom');process.exit(7);");
  const r2 = cp.spawnSync(process.execPath, [cli, "ask", "stats-runerror"], { cwd: H, encoding: "utf8", env, timeout: 60000, windowsHide: true });
  const rows2 = rowsNow();
  ok(r2.status !== 0 && rows2.length === 3 && rows2[2].outcome === "run-error", "run-error — 실행 실패도 1행(소비 왕복 보존·3차 B1)");
  ok(!("verdict" in rows2[2]) && !("answerChars" in rows2[2]), "실패 행 — 원문·판정 필드 없음(메타만)");

  // ③ 예약 전 거부(상한 소진) — 0행
  fs.writeFileSync(path.join(H, "verify-campaigns", wsKey + ".json"), JSON.stringify({ schema: "vcamp-1", campaignId: rows1[0].campaignId, count: 4, budget: 4, startedAt: TS, updatedAt: TS }));
  const r3 = cp.spawnSync(process.execPath, [cli, "ask", "stats-rejected"], { cwd: H, encoding: "utf8", env, timeout: 60000, windowsHide: true });
  ok(r3.status === 3 && rowsNow().length === 3, "게이트 거부(예약 전) — 통계 0행 추가(시도 아님)");

  // ③b proof 거부 실경로(구현검증 1차 blocker③) — C-C 동결 내구 job인데 완료 시점 계약은 CL-C(stale 모드)
  // → 답 수신 후 writeProof die(4) → exit 훅 answered 매핑=proof-rejected 1행·정상 판정 행 0·proof 미기록.
  {
    fs.writeFileSync(path.join(H, "verify-campaigns", wsKey + ".json"), JSON.stringify({ schema: "vcamp-1", campaignId: rows1[0].campaignId, count: 2, budget: 0, startedAt: TS, updatedAt: TS })); // 무제한 동결(거부 안 함)
    writeFake(answer);
    const jid = "ask-test01-aaaaaaaaaa";
    const jobFile = path.join(H, "ask-jobs", jid + ".json");
    fs.mkdirSync(path.join(H, "ask-jobs"), { recursive: true });
    const job = { schema: "ask-job-v1", id: jid, state: "running", workspace: H, execCwd: H, flags: [], prompt: "x", timeoutMin: 7, createdAt: TS, deadlineAt: new Date(Date.now() + 7 * 60000).toISOString(), workerPid: process.pid, childPid: null, exitCode: null, harnessMode: "codex-codex", verifyProfile: "core", verifyLang: "ko", campaignId: rows1[0].campaignId, implementerSession: "sess-impl-01", implementerTurnId: "turn-A", implementerRevision: 3 };
    fs.writeFileSync(jobFile, JSON.stringify(job));
    const envJ = { ...env, CODEX_BRIDGE_JOB_PROMPT_FILE: jobFile, CODEX_BRIDGE_ASK_JOB_ID: jid };
    const proofsBefore = fs.existsSync(path.join(H, "proofs")) ? fs.readdirSync(path.join(H, "proofs")).length : 0;
    const r3b = cp.spawnSync(process.execPath, [cli, "ask", "stats-prooffail"], { cwd: H, encoding: "utf8", env: envJ, timeout: 60000, windowsHide: true });
    const rows3b = rowsNow();
    const last = rows3b[rows3b.length - 1] || {};
    ok(r3b.status === 4 && rows3b.length === 4 && last.outcome === "proof-rejected", "C-C stale 증명 거부 — 답 수신 후 die(4)를 exit 훅이 proof-rejected 1행으로 기록: " + last.outcome);
    ok(!("verdict" in last) && (fs.existsSync(path.join(H, "proofs")) ? fs.readdirSync(path.join(H, "proofs")).length : 0) === proofsBefore, "증명 거부 — 정상 판정 행 0·proof 실물 미증가(승격 미산입 축)");
    fs.unlinkSync(jobFile);
  }

  // ④ session-unresolved — 답 수신 후 세션 미결속(실재하는 답-수신-후 실패 경로): 새 홈·thread.started 없음·rollout 없음
  {
    const H2 = fs.mkdtempSync(path.join(os.tmpdir(), "p12st_un_"));
    const act2 = path.join(H2, "active"); fs.mkdirSync(act2, { recursive: true });
    fs.writeFileSync(path.join(act2, SID + ".json"), JSON.stringify({ claudeSession: SID, workspace: H2, ts: TS }));
    fs.mkdirSync(path.join(H2, "contracts"), { recursive: true });
    const wsKey2 = CL.wsKeyFor(H2);
    fs.writeFileSync(path.join(H2, "contracts", wsKey2 + ".json"), JSON.stringify({ workspace: H2, verifyProfile: "core" }));
    const fake2 = path.join(H2, "fake-codex.js");
    fs.writeFileSync(fake2, ["const fs=require('fs');", "const i=process.argv.indexOf('-o');", "if(i>=0)fs.writeFileSync(process.argv[i+1]," + JSON.stringify(answer) + ");"].join("\n")); // thread.started 없음
    const CH2 = path.join(H2, "codex-home"); fs.mkdirSync(path.join(CH2, "sessions"), { recursive: true }); // rollout 없음
    const env2 = { ...env, CODEX_BRIDGE_HOME: H2, CLAUDE_PROJECT_DIR: H2, CODEX_BIN: fake2, CODEX_HOME: CH2 };
    const r4 = cp.spawnSync(process.execPath, [cli, "ask", "--allow-new", "stats-unresolved"], { cwd: H2, encoding: "utf8", env: env2, timeout: 60000, windowsHide: true });
    const rows4 = (() => { try { return fs.readFileSync(path.join(H2, "stats", "verdicts.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();
    ok(r4.status !== 0 && rows4.length === 1 && rows4[0].outcome === "session-unresolved", "세션 미결속 — 답 수신 후 실패도 1행(명시 종결·승격 미산입 축): " + (rows4[0] || {}).outcome);
    ok(!("verdict" in (rows4[0] || {})), "미결속 행 — 판정·원문 필드 없음");
  }
}

console.log("[6b] exit 훅 매핑(실 프로세스 — 5·6차 blocker) — 명시 종결 없이 죽어도 단계 기반 1행");
{
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "p12st_hook_"));
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const drive = (body) => cp.spawnSync(process.execPath, ["-e", "const b=require(" + JSON.stringify(cli) + ");" + body], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: H, CLAUDE_CODE_SESSION_ID: "sess-hook" }, timeout: 20000, windowsHide: true });
  const rows = () => { try { return fs.readFileSync(path.join(H, "stats", "verdicts.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
  drive("const a=b.beginVerifyAttempt('D:/hook-ws',{tracked:true,n:1,budget:2,campaignId:'cl:x:y'},'core','always');a.markCallStart();process.exit(1);");
  drive("const a=b.beginVerifyAttempt('D:/hook-ws',{tracked:true,n:2,budget:2,campaignId:'cl:x:y'},'core','always');a.markCallStart();a.answered();throw new Error('mid');");
  drive("const a=b.beginVerifyAttempt('D:/hook-ws',{tracked:true,n:3,budget:2,campaignId:'cl:x:y'},'core','always');a.markCallStart();a.answered();a.proofAccepted();process.exit(1);");
  drive("const a=b.beginVerifyAttempt('D:/hook-ws',{tracked:true,n:4,budget:2,campaignId:'cl:x:y'},'core','always');a.record('accepted',{verdict:'pass'});process.exit(0);");
  const rs = rows();
  ok(rs.length === 4, "4개 프로세스=정확히 4행(종결당 1회 기록 시도): " + rs.length);
  ok(rs[0] && rs[0].outcome === "run-error", "pre-call에서 사망 → run-error(exit 훅)");
  ok(rs[1] && rs[1].outcome === "proof-rejected", "답 수신 후 예외 → proof-rejected(exit 훅)");
  ok(rs[2] && rs[2].outcome === "postprocess-error", "증명 확정 후 사망 → postprocess-error(6차 blocker — proof 실물과 정합)");
  ok(rs[3] && rs[3].outcome === "accepted" && rs[3].verdict === "pass", "명시 accepted 후 exit → 추가 행 없음(recorded 플래그)");
  ok(rs.every((r) => r.campaignId === "cl:x:y" && r.profile === "core" && r.budgetTracked === true), "전 행 — 캠페인·프로필·추적 메타 보존");
}

console.log("[7] 배선 소스 계약 — 단일 계층·양 분기·flagVerdict 위임·게이트 보존");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  const askBody = src.slice(src.indexOf("async function cmdAsk(rest)"), src.indexOf("function cmdLink"));
  ok((src.match(/function beginVerifyAttempt\(/g) || []).length === 1, "기록 계층 정의 1곳");
  ok((askBody.match(/beginVerifyAttempt\(ws, budgetGate\.res, profileSnap, modeSnap\)/g) || []).length === 2, "양 분기 — 예약 직후 시도 생성");
  ok((askBody.match(/attempt\.markCallStart\(\)/g) || []).length === 2 && (askBody.match(/attempt\.answered\(\)/g) || []).length === 2 && (askBody.match(/attempt\.proofAccepted\(\)/g) || []).length === 2, "단계 전이 — 호출 직전·답 수신·증명 확정(양 분기)");
  ok(/attempt\.record\("session-unresolved"\)/.test(askBody), "세션 미결속 — 명시 종결(3차 B1)");
  ok(/a\.stage === "pre-call" \? "run-error" : a\.stage === "answered" \? "proof-rejected" : "postprocess-error"/.test(src), "exit 훅 — 단계 기반 매핑(5·6차 blocker: proof 후 예외=postprocess-error)");
  ok(/if \(attempt\) attempt\.record\("accepted", row\);/.test(src), "flagVerdict — accepted 1행 위임(이중 append 없음)");
  ok(/budget: res\.budget, campaignId \};/.test(src) && /\{ unlimited: true, campaignId \}/.test(src), "예산 래퍼 — 미집계·무제한 환원에도 campaignId 보존(2차 [보완]3)");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/best-effort/.test(ext) && /감사 기록 아님/.test(ext), "통계 카드 정직 라벨 — 로컬 관찰·감사 아님(3차 [주의])");
  ok(/승격 검증 1회를 권장해요/.test(ext) && !/승격 (충족|미충족)/.test(ext), "승격 안내 — 사실 진술 문구(판정 표현 금지·2차 B2)");
  ok(/프로필 기록이 없는 이전 검증/.test(ext), "구 기록 병기 — 과거 이력 오판 방지(3차 [주의])");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
