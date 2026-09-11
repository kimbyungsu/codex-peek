/*
 * [HARNESS-STRUCTURE-2026-09-11 §A2] 강제 새 방 플래그 관문.
 * 규칙 두 줄: ① 연결 기록이 없으면 --allow-new 가 새 방을 만든다(정상·결정 불요). ② 연결 기록이 있으면(유효 여부 불문)
 * --force-new 는 결정 장부 실존 항목(--decision <id>)이 있어야 통과. 결정 실존·저장소 표식 대조는 escalate 와 같은 함수(requireDecision · ab-1).
 * 무효 연결(기록 파일 없음)로 새 방을 만들 때는 침묵하지 않고 고지한다.
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "force-new-gate-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const BRIDGE = path.join(__dirname, "..", "bridge", "codex-bridge.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const ws = path.join(HOME, "repo"); fs.mkdirSync(ws);
const SESSION = "01a00000-0000-7000-8000-000000000001";
const runCli = (args, extraEnv) => cp.spawnSync(process.execPath, [BRIDGE, ...args], {
  encoding: "utf8", cwd: ws, timeout: 60000,
  env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws, CLAUDE_CODE_SESSION_ID: "gate-test-session", CODEX_BIN: path.join(HOME, "no-such-codex.exe") }, extraEnv || {}),
});
const combined = (r) => String(r.stdout || "") + "\n" + String(r.stderr || "");

console.log("[1] askRequest — --decision 값 플래그: 프롬프트에서 빠지고 flags에 쌍으로 남는다(job.flags 보존 재료)");
const r1 = CB.askRequest(["--force-new", "--decision", "abcd1234abcd1234", "검증", "요청"]);
ok(r1.prompt === "검증 요청", "값이 프롬프트에 섞이지 않음: " + JSON.stringify(r1.prompt));
ok(r1.decisionId === "abcd1234abcd1234", "decisionId 추출");
ok(JSON.stringify(r1.flags) === JSON.stringify(["--force-new", "--decision", "abcd1234abcd1234"]), "flags에 쌍으로 보존: " + JSON.stringify(r1.flags));
ok(CB.askRequest(["--allow-new", "x"]).decisionId === "" && CB.askRequest(["--allow-new", "x"]).prompt === "x", "값 플래그 없으면 빈 값·프롬프트 그대로");
ok(CB.askRequest(["x", "--decision"]).decisionId === "" && CB.askRequest(["x", "--decision"]).prompt === "x", "값 없는 --decision=빈 값(프롬프트 오염 없음)");

console.log("[2] requireDecision — 실존·저장소 표식 대조(escalate와 공유)");
ok(CL.requireDecision(ws, "", "").reason === "decision-required", "빈 id → decision-required");
ok(CL.requireDecision(ws, "0000000000000000", "").reason === "decision-required", "미존재 id → decision-required");
const spec = { origin: "implementer", kind: "boundary", campaignId: "cl:s:c1", sourceAsk: "ask-g1", targetFp: "", question: "연결된 방이 있는데 새 방을 강제할까요?", why: "w", noDefault: "검증 방은 사용자가 관리하는 영역이라 구현자가 정할 수 없음", choices: [{ key: "a", label: "새 방" }, { key: "b", label: "기존 방" }] };
const d = CL.openDecision(ws, spec);
ok(d && d.ok !== false && typeof d.decisionId === "string" && d.decisionId, "결정 항목 생성: " + JSON.stringify(d));
const rec = CL.readDecisions(ws).latest.get(d.decisionId);
const rk = String((rec && rec.repoKey) || "");
const rq = CL.requireDecision(ws, d.decisionId, rk);
ok(rq.ok === true && rq.decisionId === d.decisionId, "실존+같은 표식 → ok");
ok(CL.requireDecision(ws, d.decisionId, rk ? rk + "x" : "other-repo").reason === "decision-repo-mismatch", "다른 저장소 표식 → decision-repo-mismatch");
if (!rk) ok(CL.requireDecision(ws, d.decisionId, "").ok === true, "표식 없는 결정+표식 없는 호출 → ok");

console.log("[3] 배선 — cmdAsk 관문 위치(연결 판독 뒤·ws 직렬화 앞)·resolveJudgeRequired 공유·상태 줄 조립");
const src = fs.readFileSync(BRIDGE, "utf8");
const iG = src.indexOf("requireDecision(ws, decisionId0, rkA)");
const iL = src.indexOf("let link = providerSnap === \"claude\" ? null : resolveLink(links);");
const iA = src.indexOf("claimAskActive(ws, promptHash");
ok(iG > 0 && iL > 0 && iA > 0 && iL < iG && iG < iA, "관문은 연결 판독 뒤·ask-active 선점 앞");
ok(src.includes("if (forceNew && link && providerSnap !== \"claude\") {"), "관문 조건: --force-new + 연결 기록 존재");
ok(src.includes("attCarrier.sessionNote = attNote9") && src.includes("attCarrier.sessionNote ? \"\\n\" + attCarrier.sessionNote"), "무효 연결 → 새 방 고지가 답 상태 줄에 조립");
ok(src.includes("const ASK_VALUE_FLAGS = new Set([\"--decision\"]);"), "값 플래그 집합");
const lib = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
ok(lib.includes("const rq = requireDecision(ws, opts.decisionId, rkJ);"), "escalate 도 같은 requireDecision 사용");

console.log("[4] CLI — 연결 기록 있음 + --force-new 단독 → exit 3(결정 장부 안내)");
const links = { bySession: {}, byWorkspace: {} };
links.byWorkspace[ws] = { codexSession: SESSION, linkedAt: "2026-09-11T00:00:00.000Z", via: "ui" };
fs.writeFileSync(path.join(HOME, "links.json"), JSON.stringify(links, null, 2));
const r4 = runCli(["ask", "--force-new", "관문 시험 요청"]);
const t4 = combined(r4);
ok(r4.status === 3, "exit 3 (실제 " + r4.status + ")");
ok(t4.includes("결정 장부 항목이 필요") && t4.includes("decision-required") && t4.includes(SESSION), "거부문에 사유·세션·안내: " + t4.slice(0, 300).replace(/\n/g, " | "));

console.log("[5] CLI — 연결 기록 있음 + --force-new --decision <미존재> → exit 3(decision-required)");
const r5 = runCli(["ask", "--force-new", "--decision", "0000000000000000", "관문 시험 요청"]);
ok(r5.status === 3 && combined(r5).includes("decision-required"), "미존재 결정 → 거부");

console.log("[6] CLI — 연결 기록 있음(기록 파일 없음=무효) + --force-new --decision <실존> → 관문 통과·무효 연결 고지·새 방 경로(codex 실행은 실패해도 됨)");
const r6 = runCli(["ask", "--force-new", "--decision", d.decisionId, "관문 시험 요청"]);
const t6 = combined(r6);
ok(!t6.includes("결정 장부 항목이 필요"), "관문 거부문 없음");
ok(t6.includes("--force-new 허용") || t6.includes("--force-new allowed"), "관문 통과 고지(결정 id): " + t6.slice(0, 200).replace(/\n/g, " | "));
ok(t6.includes("무효(기록 파일 없음) → 새 방 생성") || t6.includes("invalid (rollout file missing)"), "무효 연결 → 새 방 생성 고지(침묵 금지): " + t6.slice(0, 400).replace(/\n/g, " | "));

console.log("[7] CLI — 연결 기록 없음 + --allow-new → 관문 미발동(새 방 정상 경로·codex 실행 실패는 무관)");
fs.writeFileSync(path.join(HOME, "links.json"), JSON.stringify({ bySession: {}, byWorkspace: {} }, null, 2));
const r7 = runCli(["ask", "--allow-new", "관문 시험 요청"]);
const t7 = combined(r7);
ok(!t7.includes("결정 장부 항목이 필요") && !t7.includes("decisions-ledger item"), "연결 없음 → 관문 미발동: " + t7.slice(0, 200).replace(/\n/g, " | "));

// ── 내구 경로 실행(구현 검증 1판 blocker): ask-start → job.flags 쌍 보존 → 작업자가 ask --job-prompt 로 같은 관문을 본다 ──
const readJob = (id) => { try { return JSON.parse(fs.readFileSync(path.join(HOME, "ask-jobs", id + ".json"), "utf8")); } catch { return null; } };
const waitJob = (id, ms) => { const t0 = Date.now(); let j = readJob(id); while (j && (j.state === "queued" || j.state === "selecting" || j.state === "running") && Date.now() - t0 < ms) { const e = Date.now() + 500; while (Date.now() < e) { /* busy wait */ } j = readJob(id); } return j; };
const jobErr = (id) => { try { return fs.readFileSync(path.join(HOME, "ask-jobs", id + ".err"), "utf8"); } catch { return ""; } };
const jobOut = (id) => { try { return fs.readFileSync(path.join(HOME, "ask-jobs", id + ".out"), "utf8"); } catch { return ""; } };
const startJob = (args) => { const r = cp.spawnSync(process.execPath, [BRIDGE, "ask-start", ...args], { encoding: "utf8", cwd: ws, timeout: 60000, env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws, CLAUDE_CODE_SESSION_ID: "gate-test-session", CODEX_BIN: path.join(HOME, "no-such-codex.exe") }) }); const m = String(r.stdout || "").match(/"jobId":\s*"([^"]+)"/); return { r, id: m ? m[1] : "" }; };

console.log("[8] 내구 경로 — 연결 기록 있음 + ask-start --force-new(결정 없음) → job.flags=[--force-new] · 작업자의 ask 관문이 거부(exitCode 3·.err 안내)");
fs.writeFileSync(path.join(HOME, "links.json"), JSON.stringify(links, null, 2));
const s8 = startJob(["--force-new", "내구 경로 관문 시험"]);
ok(s8.r.status === 0 && !!s8.id, "ask-start 가 job 을 만듦: " + (s8.id || combined(s8.r).slice(0, 200).replace(/\n/g, " | ")));
const j8 = s8.id ? waitJob(s8.id, 90000) : null;
ok(!!j8 && JSON.stringify(j8.flags) === JSON.stringify(["--force-new"]) && !String(j8.prompt || "").includes("--decision"), "job.flags 보존·프롬프트 오염 없음: " + (j8 ? JSON.stringify(j8.flags) : "no job"));
ok(!!j8 && j8.state === "failed" && j8.exitCode === 3, "작업자 경로 관문 거부 → failed·exitCode 3 (실제 " + (j8 ? j8.state + "/" + j8.exitCode : "no job") + ")");
const e8 = jobErr(s8.id) + jobOut(s8.id);
ok(e8.includes("결정 장부 항목이 필요") && e8.includes("decision-required"), "작업자 .err 에 관문 안내: " + e8.slice(0, 200).replace(/\n/g, " | "));

console.log("[9] 내구 경로 — ask-start --force-new --decision <실존> → job.flags 쌍 보존 · 작업자 관문 통과·무효 연결 고지·새 방 경로(codex 실패=exitCode 3 아님)");
const s9 = startJob(["--force-new", "--decision", d.decisionId, "내구 경로 관문 시험 둘"]);
ok(s9.r.status === 0 && !!s9.id, "ask-start 가 job 을 만듦(결정 있음): " + (s9.id || combined(s9.r).slice(0, 200).replace(/\n/g, " | ")));
const j9 = s9.id ? waitJob(s9.id, 90000) : null;
ok(!!j9 && JSON.stringify(j9.flags) === JSON.stringify(["--force-new", "--decision", d.decisionId]) && !String(j9.prompt || "").includes(d.decisionId), "job.flags 에 --decision 쌍 보존·프롬프트에 id 없음: " + (j9 ? JSON.stringify(j9.flags) : "no job"));
ok(!!j9 && j9.state !== "queued" && j9.state !== "running" && j9.exitCode !== 3, "관문 통과(exitCode 3 아님 · 실제 " + (j9 ? j9.state + "/" + j9.exitCode : "no job") + ")");
const e9 = jobErr(s9.id) + jobOut(s9.id);
ok(!e9.includes("결정 장부 항목이 필요") && (e9.includes("--force-new 허용") || e9.includes("--force-new allowed")), "작업자 .err 에 관문 통과 고지: " + e9.slice(0, 200).replace(/\n/g, " | "));
ok(e9.includes("무효(기록 파일 없음) → 새 방 생성") || e9.includes("invalid (rollout file missing)"), "무효 연결 → 새 방 생성 고지(내구 경로): " + e9.slice(0, 300).replace(/\n/g, " | "));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
