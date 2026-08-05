"use strict";
// [VerifierProvider Phase1] 검증자 공급자 분리 — 설계 docs/VERIFIER-PROVIDER-DESIGN.md(동결 v3)의 인수시험.
// 핵심: 기본 codex 무회귀 · claude=무상태 answer-only(가짜 실행기) · proof 저장 키=구현자 세션(메타만 claude:*) ·
// codex 전용 장치 자연 축퇴(evidence-unseen·challenge·링크 기록 0) · env 격리 · 실패 처리 · 스냅샷 동결.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vprov_"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require("../bridge/contract-lib.js");
let pass = 0, fail = 0;
function ok(v, name) { if (v) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }

console.log("[1] 정본 — 공급자 목록·정규화(기본 codex 무회귀)");
ok(Array.isArray(CL.VERIFIER_PROVIDERS) && CL.VERIFIER_PROVIDERS.join(",") === "codex,claude", "VERIFIER_PROVIDERS=[codex,claude]");
ok(CL.normVerifierProvider(null) === "codex" && CL.normVerifierProvider({}) === "codex" && CL.normVerifierProvider({ verifierProvider: "gpt" }) === "codex", "미지정·미지값=codex(무회귀)");
ok(CL.normVerifierProvider({ verifierProvider: "claude" }) === "claude", "명시 claude 인정");

const ws = path.join(home, "ws"); fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
const bridgeBin = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0001"; // 구현자(Claude Code) 세션 — proof 저장 키
const baseEnv = { ...process.env, CODEX_BRIDGE_HOME: home, CLAUDE_PROJECT_DIR: ws, CLAUDE_CODE_SESSION_ID: SID };
const run = (args, extraEnv) => cp.spawnSync(process.execPath, [bridgeBin, ...args], { encoding: "utf8", env: { ...baseEnv, ...(extraEnv || {}) }, timeout: 30000, windowsHide: true });

console.log("[2] CLI verifier-provider — 표시/전환 왕복");
let r = run(["verifier-provider"]);
ok(r.status === 0 && JSON.parse(r.stdout).verifierProvider === "codex", "인자 없음=현재값(기본 codex)");
r = run(["verifier-provider", "claude"]);
ok(r.status === 0 && JSON.parse(r.stdout).saved === true, "claude 전환 저장");
r = run(["verifier-provider"]);
ok(r.status === 0 && JSON.parse(r.stdout).verifierProvider === "claude", "전환 후 현재값=claude");
r = run(["verifier-provider", "gpt5"]);
ok(r.status !== 0 && /codex\|claude/.test(r.stderr + r.stdout), "미지값=거부·사용법 안내");

console.log("[3] 가짜 claude 실행기 e2e — 답·proof·판정·축퇴·격리");
const fakeDir = path.join(home, "fake"); fs.mkdirSync(fakeDir, { recursive: true });
const envDump = path.join(fakeDir, "env-dump.json");
const fakeBin = path.join(fakeDir, "fake-claude.js");
fs.writeFileSync(fakeBin, `
const fs=require("fs");
let stdin="";process.stdin.on("data",(d)=>stdin+=d);
process.stdin.on("end",()=>{
  fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({ keys: Object.keys(process.env).filter((k)=>/^CLAUDE/.test(k)), promptLen: stdin.length }));
  const mode=process.env.FAKE_CLAUDE_MODE||"ok";
  if(mode==="err"){ process.stdout.write(JSON.stringify({type:"result",is_error:true,result:"API Error: 401 login required",session_id:"fake-err"})); process.exit(1); }
  if(mode==="corrupt"){ process.stdout.write("{broken json"); process.exit(0); }
  const answer="본문 근거: tests/verifier-provider.test.js 검토.\\n[지적 목록 v2]\\n[지적 목록 끝]\\n검증: 통과\\n";
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:answer,session_id:"fake-sess-0001"}));
});
`);
// 직접 ask는 CL-C에서 허용 — 계약은 위 [2]에서 이미 verifierProvider=claude.
r = run(["ask", "이 변경을 검증해줘"], { CODEX_BRIDGE_CLAUDE_BIN: fakeBin });
ok(r.status === 0, "claude 공급자 직접 ask 완주(exit 0) stderr=" + (r.status !== 0 ? r.stderr.slice(-300) : ""));
ok(r.stdout.includes("# 검증자: Claude(무상태)"), "출력 헤더=공급자 정직 표기(연결 세션 아님)");
ok(r.stdout.includes("Codex 선언: 검증: 통과") || /검증: 통과/.test(r.stdout), "판정 파싱·footer 조립 완주(답 텍스트 공통 계층)");
const proofFile = path.join(CL.PROOFS_DIR, SID + ".json");
ok(fs.existsSync(proofFile), "proof 저장 키=구현자 세션(설계 blocker③ — 게이트가 이 키로 찾는다)");
const proof = JSON.parse(fs.readFileSync(proofFile, "utf8"));
ok(String(proof.codexSession || "").startsWith("claude:fake-sess-0001"), "검증자 세션은 proof '메타데이터'(claude:<session_id>)");
const integ = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, "integrity.json"), "utf8")).events || []; } catch { return []; } })();
ok(integ.every((e) => e.kind !== "evidence-unseen"), "자연 축퇴 — rollout 부재=다룬 흔적 경보 0(허위 근거의심 없음)");
ok(!fs.existsSync(path.join(home, "evidence-challenges")) || fs.readdirSync(path.join(home, "evidence-challenges")).length === 0, "재확인 challenge 동결 0(codex 전용)");
const linksAfter = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, "links.json"), "utf8")); } catch { return {}; } })();
ok(!JSON.stringify(linksAfter).includes("fake-sess"), "링크 기록 0(연결 세션 장치 미사용)");
const dump = JSON.parse(fs.readFileSync(envDump, "utf8"));
ok(!dump.keys.some((k) => /^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PROJECT_DIR$/.test(k)), "환경 격리 — 호스트 훅·세션 변수 자식에 부재");
ok(dump.promptLen > 200, "프롬프트=stdin 전달(계약 주입 포함 실물)");

console.log("[4] 실패 처리 — is_error·비0 종료·JSON 파손=성공 소비 금지");
// ask-active 잔재 정리(직전 성공 ask의 활성 표식이 남아 있으면 재실행 거부) — 시험 편의로 상태 파일 제거
const clearActive = () => { try { fs.rmSync(path.join(home, "ask-active"), { recursive: true, force: true }); } catch { /* ignore */ } };
clearActive();
r = run(["ask", "실패 경로 검증"], { CODEX_BRIDGE_CLAUDE_BIN: fakeBin, FAKE_CLAUDE_MODE: "err" });
ok(r.status !== 0 && /Claude 검증자 실행 실패|Claude verifier failed/.test(r.stderr), "is_error+exit1=실패 처리·진단 출력");
ok(/is_error/.test(r.stderr) && /login required/.test(r.stderr), "진단에 오류 본문 동봉(다음 세션이 추측 안 하게)");
clearActive();
r = run(["ask", "파손 경로 검증"], { CODEX_BRIDGE_CLAUDE_BIN: fakeBin, FAKE_CLAUDE_MODE: "corrupt" });
ok(r.status !== 0 && /parse-failed/.test(r.stderr), "JSON 파손=실패(parse-failed 진단)");

console.log("[5] 스냅샷 동결 — 내구 job의 verifyProvider가 계약 전환을 이긴다");
// 계약을 codex로 되돌린 뒤, verifyProvider:"claude"가 동결된 정본 job으로 실행 → claude로 돌아야 한다.
run(["verifier-provider", "codex"]);
clearActive();
const jobId = "ask-vptest01-00aabbccdd";
const jobDir = path.join(home, "ask-jobs"); fs.mkdirSync(jobDir, { recursive: true });
const jobFile = path.join(jobDir, jobId + ".json");
fs.writeFileSync(jobFile, JSON.stringify({ schema: "ask-job-v1", id: jobId, state: "running", workspace: ws, execCwd: ws, flags: [], prompt: "동결 검증", timeoutMin: 7, createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 7 * 60 * 1000).toISOString(), workerPid: process.pid, childPid: null, exitCode: null, harnessMode: "claude-codex", verifyProfile: "core", verifyLang: "ko", verifyProvider: "claude", rejudgeSnap: "", campaignId: null }));
r = run(["ask", "동결 검증"], { CODEX_BRIDGE_CLAUDE_BIN: fakeBin, CODEX_BRIDGE_JOB_PROMPT_FILE: jobFile, CODEX_BRIDGE_ASK_JOB_ID: jobId });
ok(r.status === 0 && r.stdout.includes("# 검증자: Claude(무상태)"), "동결값(claude)이 현재 계약(codex)을 이김 — 실행 중 전환 무영향 stderr=" + (r.status !== 0 ? r.stderr.slice(-300) : ""));

console.log("[6] 소스 계약 — 꼬리 단일화·legacy job=codex 고정");
const src = fs.readFileSync(bridgeBin, "utf8");
ok((src.match(/finishVerifyRun\(/g) || []).length === 3 && src.includes("const finishVerifyRun = (answer, verifierSession"), "세 분기(resume·새 세션·claude) 전부 공유 꼬리 경유(호출 3+정의 1)");
ok(src.includes('durableEnv.job.verifyProvider)) ? durableEnv.job.verifyProvider : "codex"'), "legacy job(무필드)=codex 고정(계약 재판독 폴백 없음 — 세대 혼합 차단)");
ok(!/const proofBind = writeProof\(link\.codexSession/.test(src) && !/const proofBind = writeProof\(id,/.test(src), "구 인라인 꼬리 소멸(중복 0)");

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
