/*
 * P5 — 탐색 provider 공통 인터페이스(scripts/scout-providers.js) 계약 테스트(임시 홈·실 git 픽스처·목 provider).
 * 핵심 계약: ①runScout 공통 파이프라인(수집→렌더→호출→비용 장부→(--out)→보관→관측 장부→ScoutResult)
 * ②typed ScoutResult 합타입(성공 필드·실패 error.key 열거) ③어댑터(self=claude 1회+도구 차단·무과금 /
 * deepseek=브릿지 map 위임·probe=ping·과금 / codex=P6 소켓 available:false) ④러너 2종=껍데기(출력 바이트 보존)
 * ⑤1-26 경계(scoutArm과 결합 없음·P7 provider mode 통합 금지 명문).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

// 임시 브릿지 홈 격리 — require 전에 env(모듈 상수가 이 경로를 잡는다)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "scout-providers-test-"));
process.env.CODEX_BRIDGE_HOME = tmpHome;
const ROOT = path.join(__dirname, "..");
const SP = require(path.join(ROOT, "scripts", "scout-providers.js"));
const store = require(path.join(ROOT, "scripts", "scout-store.js"));

// 실 git 픽스처 — collectPackage의 git 경로(커밋 1 + 작업트리 변경 1 = seed)
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "scout-providers-repo-"));
const g = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
g(["init"]); g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.js"), "console.log(1);\n");
g(["add", "."]); g(["commit", "-m", "c1"]);
fs.appendFileSync(path.join(repo, "a.js"), "console.log(2);\n");

console.log("[1] 레지스트리 — 어댑터 3종 인터페이스(probe/invoke)·과금 표기·P6 소켓");
ok(SP.PROVIDERS.self && SP.PROVIDERS.self.billed === false, "self=무과금(구독 Claude 재사용 — 1-26)");
ok(SP.PROVIDERS.deepseek && SP.PROVIDERS.deepseek.billed === true && SP.PROVIDERS.deepseek.handlesOutFile === true, "deepseek=과금·--out은 브릿지 위임");
ok(SP.PROVIDERS.codex && SP.PROVIDERS.codex.available() === true && SP.PROVIDERS.codex.billed === true, "codex=실체 어댑터(P6 — 검증 축이 이미 codex 의존이라 가용성 게이트 없음·플랜 사용량 표기)");
for (const k of ["self", "deepseek", "codex"]) ok(typeof SP.PROVIDERS[k].probe === "function" && typeof SP.PROVIDERS[k].invoke === "function", k + " — probe/invoke 인터페이스 구비");
ok(/Bash/.test(SP.SELF_DENY) && /Read/.test(SP.SELF_DENY) && /WebFetch/.test(SP.SELF_DENY) && /Task/.test(SP.SELF_DENY), "SELF_DENY — 파일·웹·에이전트 도구 차단(공정성 계약 D2: 꾸러미만 근거)");

console.log("[2] runScout 성공 파이프라인(목 provider — 실 AI 호출 없음)");
const MAP = ["① 핵심 영향", "- high | a.js | 직접 수정", "⑥ MAP patch", "- scripts/a.js 저장 형식 ↔ scripts/b.js 판독 규칙"].join("\n");
let sawLive = false, gotPreface = null, gotMd = null;
const mock = { id: "mock", available: () => true, probe: () => ({ ok: true }), invoke: ({ preface, md }) => { gotPreface = preface; gotMd = md; sawLive = fs.existsSync(path.join(store.LIVE_DIR, store.wsKeyFor(repo) + ".json")); return { ok: true, map: MAP, usage: { in: 11, out: 22, model: "m-x" }, stderrPass: "" }; } };
const res = SP.runScout(repo, "mock", { _providers: { mock } });
ok(res.ok === true && res.provider === "mock" && res.map === MAP, "성공 ScoutResult — 지도 본문 그대로");
ok(res.usage && res.usage.in === 11 && res.usage.out === 22 && res.usage.model === "m-x", "usage 통과(형식화)");
ok(res.pkgChars === (gotPreface + gotMd).length && res.mapChars === MAP.length && gotMd.length > 0, "문자수=전송/수신 실측");
ok(gotPreface === "", "비self provider — preface 주입 없음(딥시크 계약: 브릿지가 같은 슬롯에서 읽음)");
ok(sawLive === true && !fs.existsSync(path.join(store.LIVE_DIR, store.wsKeyFor(repo) + ".json")), "호출 동안만 live 신호(상태바 '생성중') — 직후 해제");
ok(!!res.savedNote && fs.existsSync(res.savedNote), "게시판 보관(md 실존): " + path.basename(res.savedNote || ""));
const meta = JSON.parse(fs.readFileSync(res.savedNote.replace(/\.md$/, ".json"), "utf8"));
ok(meta.usageIn === 11 && meta.usageOut === 22 && meta.model === "m-x", "보관 메타 — usage 보존");
ok(typeof meta.head === "string" && meta.head.length > 0 && typeof meta.basisTs === "string" && Array.isArray(meta.seedFiles), "보관 메타 — head·기준선·seed(신선도 재료 전달만)");
ok(Array.isArray(meta.highlights) && Array.isArray(meta.mapPatches) && meta.mapPatches.length >= 1, "보관 메타 — 지도 구조화(⑥ 추출 포함)");
const usagePath = path.join(tmpHome, "stats", "scout-usage.jsonl");
const usageLog = fs.readFileSync(usagePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(usageLog.length === 1 && usageLog[0].arm === "mock" && usageLog[0].usageIn === 11 && usageLog[0].pkgChars === res.pkgChars, "비용 장부 1건(팔=providerId·문자수 실측)");
ok(res.ledgerNote === "ok" && fs.existsSync(path.join(tmpHome, "map-ledger-events")), "관측 장부 — ⑥ 제안 proposed 적재");

console.log("[3] 실패 경로 — error 합타입·부수효과 없음·self preface");
let selfPreface = null;
const rf = SP.runScout(repo, "self", { _providers: { self: { id: "self", available: () => true, probe: () => ({ ok: true }), invoke: ({ preface }) => { selfPreface = preface; return { ok: false, key: "call-failed", detail: "stub", stderrPass: "E" }; } } } });
ok(rf.ok === false && rf.error.key === "call-failed" && rf.error.detail === "stub" && rf.stderrPass === "E", "실패 ScoutResult — key 열거·detail·stderr 통과");
ok(typeof selfPreface === "string" && selfPreface.length > 2 && /\n\n$/.test(selfPreface), "self만 preface 주입(단일 출처 buildScoutPreface — 구 러너와 같은 끝 공백)");
ok(fs.readFileSync(usagePath, "utf8").trim().split("\n").length === 1, "실패 시 비용 장부 미기록(성공 지도만 집계 — 구 러너 동일)");
ok(!fs.existsSync(path.join(store.LIVE_DIR, store.wsKeyFor(repo) + ".json")), "실패에도 live 해제(finally)");
const ru = SP.runScout(repo, "nope", {});
ok(ru.ok === false && ru.error.key === "provider-unavailable", "미지 provider — provider-unavailable");
// P6: codex preface 주입 — self와 같은 자리(CLI 팔). 실 codex 호출 없이 목 provider로 조립만 검증.
let cxPreface = null;
SP.runScout(repo, "codex", { _providers: { codex: { id: "codex", available: () => true, probe: () => ({ ok: true }), invoke: ({ preface }) => { cxPreface = preface; return { ok: false, key: "call-failed", detail: "stub" }; } } } });
ok(typeof cxPreface === "string" && cxPreface.length > 2 && /\n\n$/.test(cxPreface), "codex도 preface 주입(단일 출처 buildScoutPreface — P6·실 호출 없음)");

console.log("[4] --out — 위임 플래그 분기(구 러너 계약 보존)");
const outF = path.join(tmpHome, "out-map.md");
SP.runScout(repo, "w", { outFile: outF, _providers: { w: { id: "w", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: "지도W", usage: null }) } } });
ok(fs.existsSync(outF) && fs.readFileSync(outF, "utf8") === "지도W", "handlesOutFile 없음 → 공통층이 씀(구 self 러너와 같은 자리)");
const outF2 = path.join(tmpHome, "out-map2.md");
SP.runScout(repo, "w2", { outFile: outF2, _providers: { w2: { id: "w2", handlesOutFile: true, available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: "지도X", usage: null }) } } });
ok(!fs.existsSync(outF2), "handlesOutFile → 공통층이 안 씀(브릿지 위임 — 이중 쓰기 금지)");

console.log("[5] 어댑터·러너 소스 계약 — 실호출 형태·껍데기·출력 바이트 보존");
const provSrc = fs.readFileSync(path.join(ROOT, "scripts", "scout-providers.js"), "utf8");
ok(/"-p", "--output-format", "text", "--disallowedTools", SELF_DENY/.test(provSrc), "self 어댑터 — claude 1회 호출(도구 전면 차단)");
ok(/\[bridge, "map"\]/.test(provSrc) && /\[bridge, "ping"\]/.test(provSrc), "deepseek 어댑터 — 브릿지 map 경유·probe=ping(키 없으면 정직 실패 — 게이트 아님)");
const selfW = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-self.js"), "utf8");
const dsW = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-deepseek.js"), "utf8");
ok(/runScout\(repo, "self", \{ outFile \}\)/.test(selfW) && !/spawnSync/.test(selfW), "self 러너=껍데기(직접 spawn 없음)");
ok(/runScout\(repo, "deepseek", \{ outFile \}\)/.test(dsW) && !/spawnSync/.test(dsW), "deepseek 러너=껍데기");
ok(/self 탐색 호출 실패:/.test(selfW) && /self scout call failed:/.test(selfW) && /git 저장소가 아니거나 git 실패/.test(selfW), "self 실패 문구 보존(한/영)");
ok(/DeepSeek 탐색 호출 실패:/.test(dsW) && /res\.stderrPass\) process\.stderr\.write/.test(dsW), "deepseek 실패 문구+브릿지 stderr 통과 전달 보존");
ok(/process\.stdout\.write\(res\.map \+ "\\n"\)/.test(selfW) && /process\.stdout\.write\(res\.rawStdout != null \? res\.rawStdout : res\.map\)/.test(dsW), "최종 stdout 형태 보존(self=트림+개행 · deepseek=비트림 원문)");
ok(/if \(o\.outFile && !P\.handlesOutFile\) fs\.writeFileSync\(o\.outFile, map\)/.test(provSrc), "--out 쓰기 실패는 구 러너처럼 전파(조용한 삼킴 금지 — 소스 잠금)");
// P6 — codex 어댑터 소스 계약(실 호출 없이 형태 잠금)
ok(/resolveCodex\(\)/.test(provSrc) && !/function resolveCodex/.test(provSrc), "codex 어댑터 — 실행 해석은 브릿지 정본 resolveCodex 재사용(중복 구현 없음)");
ok(/"exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", \.\.\.CL\.scoutCodexArgs\(\), "-o", outFile/.test(provSrc) && /cwd: tmpCwd/.test(provSrc) && /mkdtempSync/.test(provSrc), "codex 어댑터 — 독립 exec 1회·--ephemeral(rollout 무잔재)·read-only 강제·정찰 전용 -c 슬롯·빈 임시 폴더 실행");
ok(/\[\.\.\.inv\.args, "--version"\]/.test(provSrc), "codex probe=codex --version(가벼운 도달성 — 지도 요청 아님)");
ok(/read-only는 절대경로 읽기를 물리 차단하진|절대경로 '읽기'를 물리/.test(provSrc + fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8")), "정직 한계 명문(빈 폴더+지시 보강 — 읽기 전면 물리 차단 아님)");
const cxW = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-codex.js"), "utf8");
ok(/runScout\(repo, "codex", \{ outFile \}\)/.test(cxW) && !/spawnSync/.test(cxW), "codex 러너=껍데기(직접 spawn 없음)");
ok(/Codex 탐색 호출 실패:/.test(cxW) && /Codex scout call failed:/.test(cxW) && /process\.stdout\.write\(res\.map \+ "\\n"\)/.test(cxW), "codex 러너 — 실패 문구 한/영·stdout=지도+개행(self와 동형)");

console.log("[6] 1-26 경계 — scoutArm(러너 선호)과 별개 축·P7 통합 금지 명문");
const provCode = provSrc.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/?\*)/.test(l)).join("\n");
ok(!/scoutArm/.test(provCode), "공통층 코드에 scoutArm 결합 없음(머리말 경계 '서술'은 예외 — 선호는 지시문 층 소관·별개 축)");
ok(/P7 provider mode와 통합 금지/.test(provSrc) && /'키 없으면 강등' 규칙 P7 재사용 금지/.test(provSrc), "경계 부기 명문(공통층 머리 — 후속 트랙이 어기면 여기서 걸림)");
ok(/available: \(\) => true, \/\/ 키 유무는 probe\/invoke가 정직 보고/.test(provSrc), "deepseek available=true 고정(키 없음=정직 실패이지 강등 게이트 아님)");

console.log("[7] 런타임 경계(검증 1차 blocker① 잠금) — 어댑터 예외·오형식 전부 ScoutFailure로 정규화(합타입 보장)");
const bThrow = SP.runScout(repo, "t1", { _providers: { t1: { id: "t1", available: () => true, probe: () => ({ ok: true }), invoke: () => { throw new Error("붕괴"); } } } });
ok(bThrow.ok === false && bThrow.error.key === "call-failed" && /invoke-threw: 붕괴/.test(bThrow.error.detail), "invoke 예외 → call-failed 정규화(프로세스 예외 이탈 금지)");
ok(!fs.existsSync(path.join(store.LIVE_DIR, store.wsKeyFor(repo) + ".json")), "예외 경로에도 live 해제(finally)");
const bHalf = SP.runScout(repo, "t2", { _providers: { t2: { id: "t2", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true }) } } });
ok(bHalf.ok === false && bHalf.error.key === "call-failed" && /invalid-adapter-result: map/.test(bHalf.error.detail), "반쪽 성공({ok:true}·map 없음) → call-failed(파이프라인 진입 금지)");
const bRaw = SP.runScout(repo, "t3", { _providers: { t3: { id: "t3", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: "M", rawStdout: 7 }) } } });
ok(bRaw.ok === false && /invalid-adapter-result: rawStdout/.test(bRaw.error.detail), "rawStdout 오형식(비문자열) → call-failed");
const bUsage = SP.runScout(repo, "t4", { _providers: { t4: { id: "t4", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: "M", usage: { in: "abc", out: 2 } }) } } });
ok(bUsage.ok === true && bUsage.usage === null, "usage 오형식(in 비숫자) → null 강등(오형식을 장부·메타에 싣지 않음 — 성공은 유지)");
const bAvail = SP.runScout(repo, "t5", { _providers: { t5: { id: "t5", available: () => { throw new Error("av"); }, probe: () => { throw new Error("pr"); }, invoke: () => ({ ok: true, map: "M" }) } } });
ok(bAvail.ok === false && bAvail.error.key === "provider-unavailable" && bAvail.error.detail === "probe-threw", "available/probe 예외 → provider-unavailable(경계 방어)");
const bBadFail = SP.runScout(repo, "t6", { _providers: { t6: { id: "t6", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: false, key: "bogus-key", detail: 7, stderrPass: 9 }) } } });
ok(bBadFail.ok === false && bBadFail.error.key === "call-failed" && bBadFail.error.detail === "7" && bBadFail.stderrPass === "", "오형식 실패(미지 key·비문자열 detail/stderrPass) → 열거 정규화·문자열화(2차 잔여 f-710a3f76 잠금)");
const bNullDetail = SP.runScout(repo, "t7", { _providers: { t7: { id: "t7", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: false, key: "provider-unavailable" }) } } });
ok(bNullDetail.ok === false && bNullDetail.error.key === "provider-unavailable" && bNullDetail.error.detail === "", "허용 열거 key는 보존·detail 부재=빈 문자열");

console.log("[8] ledgerNote 정직(검증 1차 blocker② 잠금) — append 실패 시 'ok' 금지");
const ledgerDir = path.join(tmpHome, "map-ledger-events");
fs.rmSync(ledgerDir, { recursive: true, force: true });
fs.writeFileSync(ledgerDir, "sabotage"); // 디렉터리 자리에 파일 → appendLedgerEvent가 false 반환
const rl = SP.runScout(repo, "mock2", { _providers: { mock2: { id: "mock2", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: MAP, usage: null }) } } });
ok(rl.ok === true && rl.ledgerNote === "failed", "append 실패 → ledgerNote='failed'(반환값 기반 — 오보고 차단)");
fs.rmSync(ledgerDir, { force: true });
const rl2 = SP.runScout(repo, "mock3", { _providers: { mock3: { id: "mock3", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: "제안 없음 지도", usage: null }) } } });
ok(rl2.ok === true && rl2.ledgerNote === "", "⑥ 제안 없음 → ledgerNote=''(적재 성공과 구분)");

console.log("[9] 러너 실행(목 runScout — Module._load 후킹) — stdout/stderr/exit 바이트 직접 단언(검증 1차 보완 잠금)");
function runRunner(runnerFile, mockResult, args) {
  const abs = path.join(ROOT, "scripts", runnerFile).replace(/\\/g, "/");
  const code = [
    'const Module = require("module");',
    "const orig = Module._load;",
    "Module._load = function (request, parent, isMain) {",
    '  if (/scout-providers(\\.js)?$/.test(request)) return { runScout: () => (' + JSON.stringify(mockResult) + ") };",
    "  return orig.apply(this, arguments);",
    "};",
    "process.argv = [process.argv[0], " + JSON.stringify(abs) + "].concat(" + JSON.stringify(args || []) + ");",
    "require(" + JSON.stringify(abs) + ");",
  ].join("\n");
  return spawnSync(process.execPath, ["-e", code], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: tmpHome } });
}
const e1 = runRunner("scope-scout-self.js", { ok: true, map: "지도본문", usage: null, savedNote: "x/y.md", saveErr: "", ledgerNote: "", stderrPass: "" }, [repo]);
ok(e1.status === 0 && e1.stdout === "지도본문\n" && e1.stderr.includes("지도 보관(게시판): x/y.md"), "self 성공 — stdout=지도+개행·보관 알림·exit 0");
const e2 = runRunner("scope-scout-self.js", { ok: true, map: "M", savedNote: "", saveErr: "디스크", ledgerNote: "", stderrPass: "" }, [repo]);
ok(e2.status === 0 && e2.stdout === "M\n" && e2.stderr.includes("지도 보관 실패(게시판에만 영향): 디스크"), "self 보관 실패 — advisory(지도 출력은 유지)");
const e3 = runRunner("scope-scout-self.js", { ok: false, error: { key: "call-failed", detail: "exit=1 tail" } }, [repo]);
ok(e3.status === 1 && e3.stdout === "" && e3.stderr.includes("self 탐색 호출 실패: exit=1 tail"), "self 호출 실패 — 구 러너 문구 조인·exit 1");
const e4 = runRunner("scope-scout-self.js", { ok: false, error: { key: "not-git", detail: "" } }, [repo]);
ok(e4.status === 1 && e4.stderr.includes("git 저장소가 아니거나 git 실패"), "self not-git — 구 러너 문구·exit 1");
const e5 = runRunner("scope-scout-deepseek.js", { ok: true, map: "MAP", rawStdout: "MAP\n", stderrPass: "[usage] in=1 out=2 (m)\n", savedNote: "p.md", saveErr: "", ledgerNote: "ok", usage: { in: 1, out: 2, model: "m" } }, [repo]);
ok(e5.status === 0 && e5.stdout === "MAP\n" && e5.stderr.startsWith("[usage] in=1 out=2 (m)\n") && e5.stderr.includes("지도 보관(게시판): p.md"), "deepseek 성공 — 비트림 원문 그대로·브릿지 stderr 선통과·보관 알림");
const e6 = runRunner("scope-scout-deepseek.js", { ok: false, error: { key: "call-failed", detail: "exit=1" }, stderrPass: "ERR\n" }, [repo]);
ok(e6.status === 1 && e6.stdout === "" && e6.stderr.startsWith("ERR\n") && e6.stderr.includes("DeepSeek 탐색 호출 실패: exit=1"), "deepseek 실패 — stderr 통과 후 실패 문구·exit 1");
const e7 = runRunner("scope-scout-codex.js", { ok: true, map: "지도C", usage: null, savedNote: "c/z.md", saveErr: "", ledgerNote: "", stderrPass: "" }, [repo]);
ok(e7.status === 0 && e7.stdout === "지도C\n" && e7.stderr.includes("지도 보관(게시판): c/z.md"), "codex 성공 — stdout=지도+개행·보관 알림·exit 0(P6)");
const e8 = runRunner("scope-scout-codex.js", { ok: false, error: { key: "call-failed", detail: "exit=1 t" } }, [repo]);
ok(e8.status === 1 && e8.stdout === "" && e8.stderr.includes("Codex 탐색 호출 실패: exit=1 t"), "codex 실패 — 문구·exit 1(P6)");

console.log("[10] codex 어댑터 실 invoke 경로(가짜 CODEX_BIN — 검증 1차 blocker③ 잠금: 인자·stdin·임시 cwd·-o 회수·정리·종료코드)");
const stubPath = path.join(tmpHome, "codex-stub.js");
const stubLog = path.join(tmpHome, "codex-stub-log.json");
fs.writeFileSync(stubPath, [
  'const fs = require("fs");',
  "const args = process.argv.slice(2);",
  'let inp = ""; try { inp = fs.readFileSync(0, "utf8"); } catch { /* stdin 없음 */ }',
  "fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({ args, cwd: process.cwd(), inputLen: inp.length }));",
  'if (process.env.STUB_MODE === "fail") { process.stderr.write("stub-fail"); process.exit(2); }',
  'const oIdx = args.indexOf("-o");',
  'fs.writeFileSync(args[oIdx + 1], "지도-CODEX-STUB\\n");',
  "process.exit(0);",
].join("\n"));
process.env.CODEX_BIN = stubPath; // resolveCodex 1순위 — .js라 node로 감싸 실행(wrapCodexPath 계약)
process.env.STUB_LOG = stubLog;
delete process.env.STUB_MODE;
const rx = SP.runScout(repo, "codex", {});
const slog = JSON.parse(fs.readFileSync(stubLog, "utf8"));
ok(rx.ok === true && rx.map === "지도-CODEX-STUB" && rx.usage === null, "실 invoke 성공 — -o 파일 회수·트림·usage null(토큰 미제공 정직)");
ok(slog.args.includes("exec") && slog.args.includes("--skip-git-repo-check") && slog.args.includes("--ephemeral") && slog.args.includes("--sandbox") && slog.args[slog.args.indexOf("--sandbox") + 1] === "read-only", "인자 — exec·--ephemeral·--skip-git-repo-check·--sandbox read-only 강제(1차 blocker①+2차 blocker② 잠금)");
ok(slog.args.indexOf("-o") > 0 && typeof slog.args[slog.args.indexOf("-o") + 1] === "string", "인자 — -o 출력 파일 지정");
ok(path.basename(slog.cwd).startsWith("scout-codex-") && path.resolve(slog.cwd) !== path.resolve(repo), "실행 cwd=빈 임시 폴더(레포 아님 — 독립 세션·오링크 방지 계약)");
ok(slog.inputLen > 0, "stdin=preface+꾸러미 전달(비어 있지 않음)");
ok(!fs.existsSync(slog.cwd), "임시 cwd 정리(finally rmSync — 잔재 없음)");
const cxSaved = require(path.join(ROOT, "scripts", "scout-store.js")).listMaps(repo, 1)[0];
ok(cxSaved && cxSaved.arm === "codex", "게시판 보관 arm=codex(소비 화면 3값 분기의 데이터 근거)");
process.env.STUB_MODE = "fail";
const rxf = SP.runScout(repo, "codex", {});
ok(rxf.ok === false && rxf.error.key === "call-failed" && /exit=2/.test(rxf.error.detail) && /stub-fail/.test(rxf.error.detail), "실 invoke 실패 — 종료코드·stderr 꼬리가 detail로(정직 보고)");
delete process.env.STUB_MODE;

console.log("[11] P6b — Codex 정찰 두뇌 설정(전역 scout-codex.json·모델+추론강도만·세션 선택 없음 — 사용자 결정 2026-07-23)");
const CL2 = require(path.join(ROOT, "bridge", "contract-lib.js"));
ok(JSON.stringify(CL2.readScoutCodexPrefs()) === JSON.stringify({ model: "", reasoning: "" }), "부재=빈 값(비물질화 — codex 기본 그대로)");
ok(CL2.scoutCodexArgs().length === 0, "미설정 → -c 오버라이드 0개(현행 무회귀)");
ok(CL2.saveScoutCodexPrefs({ model: "  m-정찰 ", reasoning: " high " }) === true && JSON.stringify(CL2.readScoutCodexPrefs()) === JSON.stringify({ model: "m-정찰", reasoning: "high" }), "저장 왕복(공백 트림)");
ok(JSON.stringify(CL2.scoutCodexArgs()) === JSON.stringify(["-c", "model=m-정찰", "-c", "model_reasoning_effort=high"]), "인자 조립 — 검증 경로와 같은 -c 키(값 출처만 정찰 전용 슬롯)");
ok(CL2.saveScoutCodexPrefs({ model: "", reasoning: "low" }) === true && JSON.stringify(CL2.scoutCodexArgs()) === JSON.stringify(["-c", "model_reasoning_effort=low"]), "부분 설정 — 지정된 값만 오버라이드");
// 실 invoke 반영(가짜 CODEX_BIN 재사용): 설정값이 exec 인자에 실제로 실린다
CL2.saveScoutCodexPrefs({ model: "m-정찰", reasoning: "high" });
const rx2 = SP.runScout(repo, "codex", {});
const slog2 = JSON.parse(fs.readFileSync(stubLog, "utf8"));
ok(rx2.ok === true && slog2.args.includes("-c") && slog2.args.includes("model=m-정찰") && slog2.args.includes("model_reasoning_effort=high"), "실 invoke — -c model·추론강도가 인자에 실림(다음 정찰부터 적용)");
ok(slog2.args.indexOf("model=m-정찰") < slog2.args.indexOf("-o"), "인자 순서 — 오버라이드는 -o 앞(exec 옵션 구간)");
ok(CL2.saveScoutCodexPrefs({ model: "", reasoning: "" }) === true && !fs.existsSync(CL2.SCOUT_CODEX_FILE), "둘 다 빈 값=파일 삭제(초기화=비물질화)");
const rx3 = SP.runScout(repo, "codex", {});
const slog3 = JSON.parse(fs.readFileSync(stubLog, "utf8"));
ok(rx3.ok === true && !slog3.args.includes("-c"), "초기화 후 실 invoke — 오버라이드 0개(codex 기본 복귀)");
delete process.env.CODEX_BIN; delete process.env.STUB_LOG;
// 배선 소스 단언 — 확장(고급설정 카드·핸들러·payload·안내)·PRIVACY·어댑터
const extP6b = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/saveScoutCodexPrefs/.test(extP6b) && /scModel/.test(extP6b) && /scSeg/.test(extP6b) && /scState/.test(extP6b), "고급설정 카드+저장 핸들러 배선(선택형 개편 2026-07-23 — 자유 텍스트 입력 폐기)");
ok(!/id="scReason"/.test(extP6b) && /<select id="scModel"/.test(extP6b) && /renderScSeg/.test(extP6b), "선택형 UI — 모델 <select>+강도 버튼(검증 두뇌 카드 동형·1차원 텍스트칸 잔재 0)");
ok(extP6b.includes("SCAVAIL = d.availModels||[]") && extP6b.includes('(d.knownModels||[])'), "목록 출처=검증 카드와 같은 계정 캐시(+known 폴백 — 하드코딩 목록 아님)");
ok(extP6b.includes('addO(savedM, savedM+T(" (저장된 값 · 현재 목록에 없음)"') && extP6b.includes("저장된 값(현재 목록에 없음)"), "목록 밖 저장값 보존(모델·강도 모두 — 조용히 안 바뀜)");
ok(extP6b.includes('if(!scDirty){ sel.value=savedM; scCurRS=sc.reasoning||""; }'), "현재 저장값 선충전(WYSIWYG — 빈 선택 전체 교체로 기존값 침묵 소실 차단·1차 blocker ab-2 계승)");
ok((extP6b.match(/scMark\(\)/g) || []).length >= 2 && extP6b.includes("function scMark(){ scDirty=true; scGen++; }") && (extP6b.match(/scSavedGen=scGen/g) || []).length === 2, "편집 보존 — 선택/버튼 편집마다 세대 전진·저장/초기화가 요청 시점 세대 캡처");
ok(extP6b.includes("if(scSavedGen===scGen) scDirty=false"), "성공 응답은 세대 일치 시에만 clean(응답 전 새 편집 초안 보호 — 2차 blocker 잠금)");
ok((extP6b.match(/if\(scBusy\) return;/g) || []).length === 2 && (extP6b.match(/scLock\(true\)/g) || []).length === 2, "단일-flight — 응답 전 재클릭 차단(요청 겹침 자체가 불가·3차 blocker f-c4c4ab24 잠금)");
ok(extP6b.includes('if (ev.data.target === "scoutCodex") scLock(false);'), "잠금 해제=성공/실패 응답 공통(실패 시 버튼 고착 없음·dirty 유지로 초안 보존)");
ok(extP6b.includes("전역 설정(모든 프로젝트 공통)이고") && extP6b.includes("Global (shared by all projects)"), "전역 명시 ko/en(사용자 결정 — 프로젝트별 분리 안 함)");
ok(extP6b.includes("scoutCodex: readScoutCodexPrefsExt()"), "payload에 현재값(비밀 아님 — 그대로 표시)");
ok(extP6b.includes("모델·추론 강도 옵션은 ⚙️ 고급설정에 있어요") && extP6b.includes("options live in ⚙️ Advanced"), "대시보드 codex 선택 시 고급설정 안내(사용자 제안 채택)");
// 2026-07-23 사용자 요청 ③ — 탐색 담당에서 고급설정 원클릭 이동(딥시크 무키/유키·코덱스 3분기 전부)
ok((extP6b.match(/note\.appendChild\(advBtn\(\)\)/g) || []).length === 4 && extP6b.includes("⚙️ 고급설정 열기") && extP6b.includes("⚙️ Open Advanced"), "고급설정 바로가기 버튼 — 딥시크(키 유/무)·코덱스 3분기+재클릭 안내까지 4곳");
ok(extP6b.includes('.tabbtn[data-tab=\\"adv\\"]'), "바로가기=탭 버튼 로컬 클릭(호스트 왕복 없음)");
ok(extP6b.includes('if(arm==="deepseek"||arm==="codex") note.appendChild(advBtn());'), "재클릭(이미 선택됨) 안내가 바로가기를 지우지 않게 재부착(1차 blocker③)");
ok(extP6b.includes("(편집 중 값 · 현재 목록에 없음)") && extP6b.includes("(editing · not in current list)"), "dirty 편집값도 목록 밖 보존 옵션(캐시 갱신으로 빈 값 강등→오저장 차단 — 1차 blocker① ab-2)");
// 2026-07-23 사용자 실보고 ② — 두 겹: ⓐ데이터 재렌더 중 높이 붕괴 clamp=캡처→복원 ⓑ클릭 직접 경로=점프 가드
ok(extP6b.includes("const keepY = window.scrollY;") && extP6b.includes("window.scrollTo(0, keepY)"), "ⓐ렌더 전 스크롤 캡처+렌더 후 복원(주기 푸시 재구성 중 위로 튐 봉합)");
ok(extP6b.includes("function clickJumpRestore(prevY, nowY, maxY)") && extP6b.includes('document.addEventListener("click"') && /requestAnimationFrame/.test(extP6b), "ⓑ클릭 점프 가드 배선(캡처 단계 클릭→1프레임 뒤 판정·복원)");
{ // ⓑ 판정 순수 함수를 컴파일 산출물에서 추출해 '실행'으로 잠금(문자열 존재 단언만으로는 불충분 — 1차 blocker② 지적 수용)
  const outSrc9 = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const stI9 = outSrc9.indexOf("function clickJumpRestore(");
  const enI9 = outSrc9.indexOf("}", stI9);
  ok(stI9 >= 0 && enI9 > stI9, "(전제) 산출물에서 가드 판정 함수 추출");
  const fnJ = new Function("return (" + outSrc9.slice(stI9, enI9 + 1) + ");")();
  ok(fnJ(500, 0, 2000) === 500, "실행 — 클릭 직후 최상단 강제(500→0) → 원좌표 복원");
  ok(fnJ(500, 0, 300) === 300, "실행 — 접기로 페이지가 짧아짐 → 가능한 최대 좌표로 복원(500>max 300)");
  ok(fnJ(500, 480, 2000) === null, "실행 — 점프 아님(스크롤 유지·smooth 이동 중 포함) → 개입 없음");
  ok(fnJ(30, 0, 2000) === null, "실행 — 원래 상단 근처(30) → 개입 없음(오탐 방지)");
  ok(fnJ(500, 0, -10) === 0, "실행 — 내용이 화면보다 짧음 → 0으로 클램프(음수 좌표 금지)");
}
ok(/scoutCodexArgs\(\)/.test(fs.readFileSync(path.join(ROOT, "scripts", "scout-providers.js"), "utf8")), "어댑터가 정찰 전용 슬롯을 소비(검증 modelPrefs 재사용 아님)");
ok(/scout-codex\.json/.test(fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8")), "PRIVACY 파일 표에 scout-codex.json 행(비밀 아님 명시)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
