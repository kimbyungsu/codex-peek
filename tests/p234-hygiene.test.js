"use strict";
/*
 * P-2·P-3·P-4(2026-07-17) — 상태 위생 3종.
 * P-2: ask-jobs(프롬프트·응답 보존) 7일 TTL 정리(부속물 .out/.err/.pid 포함)+PRIVACY 고지.
 * P-3: codex-turns/·codex-verify-attempts/·codex-scout-attempts/ TTL 편입(7일)+PRIVACY 고지.
 * P-4: 손상 job 파일 존재 시 ask-start 신규 생성 차단(중복 worker 방지·fail-closed).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p234_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const bridge = require(path.join(ROOT, "bridge", "codex-bridge.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const NOW = Date.now();
const OLD = NOW - 8 * 24 * 60 * 60 * 1000;   // 8일 전(7일 TTL 초과)
const FRESH = NOW - 1 * 24 * 60 * 60 * 1000; // 1일 전(보존)
function mkFile(rel, mtimeMs) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ x: 1 }));
  fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}

console.log("[1] P-3 — 신규 서랍 3종 TTL 편입(8일=삭제·1일=보존)");
const drawers = ["codex-turns", "codex-verify-attempts", "codex-scout-attempts"];
const oldFiles = drawers.map((d) => mkFile(d + "/s-old.json", OLD));
const freshFiles = drawers.map((d) => mkFile(d + "/s-new.json", FRESH));
console.log("[2] P-2 — ask-jobs 프롬프트·응답 7일 정리(부속물 포함)");
const jold = ["ask-jobs/ask-old.json", "ask-jobs/ask-old.out", "ask-jobs/ask-old.err", "ask-jobs/ask-old.pid", "ask-jobs/.lock-stale"].map((r) => mkFile(r, OLD));
const jnew = ["ask-jobs/ask-newfrsh-aaaaaaaaaa.json", "ask-jobs/ask-newfrsh-aaaaaaaaaa.out"].map((r) => mkFile(r, FRESH));
// 신선 .json은 의미 검증(2a — schema·id↔파일명·state)까지 통과하는 정본 형태로 재기입(뒤 [3]의 '정상 상태' 전제)
fs.writeFileSync(jnew[0], JSON.stringify({ schema: "ask-job-v1", id: "ask-newfrsh-aaaaaaaaaa", state: "succeeded", workspace: "D:/x" }));
fs.utimesSync(jnew[0], new Date(FRESH), new Date(FRESH));
const removed = CL.cleanupOldState(NOW);
ok(oldFiles.every((f) => !fs.existsSync(f)), "P-3: 세 서랍의 7일 초과 파일 전부 삭제");
ok(freshFiles.every((f) => fs.existsSync(f)), "P-3: 신선한 파일은 보존(TTL=재검증 카운터와 동일 7일)");
ok(jold.every((f) => !fs.existsSync(f)), "P-2: ask-jobs 7일 초과분 삭제 — .json뿐 아니라 .out/.err/.pid·잔존 .lock까지(공용 sweep의 .json 한정을 전용 스윕으로 보완)");
ok(jnew.every((f) => fs.existsSync(f)), "P-2: 진행 가능성 있는 신선분 보존(deadline 상한 60분 — 7일 mtime이면 살아있는 작업 불가)");
ok(removed >= 8, "정리 카운트가 삭제 건수를 반영");

console.log("[3] P-4 — 손상 job 진단·신규 생성 차단");
const jobsDir = bridge.ASK_JOBS_DIR;
ok(path.dirname(jobsDir + path.sep) !== "", "ASK_JOBS_DIR 노출(테스트 전제)");
fs.mkdirSync(jobsDir, { recursive: true });
ok(bridge.corruptAskJobFiles().length === 0, "정상 상태 — 손상 없음");
fs.writeFileSync(path.join(jobsDir, "ask-broken.json"), "{깨진");
fs.writeFileSync(path.join(jobsDir, "ask-array.json"), "[1,2]");
const bad = bridge.corruptAskJobFiles();
ok(bad.includes("ask-broken.json") && bad.includes("ask-array.json") && bad.length === 2, "파싱 불가·비객체 job을 손상으로 진단");
fs.writeFileSync(path.join(jobsDir, "ask-okjob-aaaaaaaaaa.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-okjob-aaaaaaaaaa", state: "succeeded", workspace: "D:/x" }));
ok(bridge.corruptAskJobFiles().length === 2, "정상 job은 손상 목록에 안 들어감");
const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
ok(/const corrupt=corruptAskJobFiles\(\);\s*\n\s*if\(corrupt\.length\)throw/.test(src), "ask-start — 손상 존재 시 신규 생성 차단(fail-closed·임계구역 안)");
ok(/ask-job clear <id> --confirm/.test(src.split("corruptAskJobFiles();")[2] || src) && /판독 불가\(손상\) 검증 작업 파일/.test(src) && /Unreadable \(corrupt\) verification job file/.test(src), "차단 안내 — 진단·해소 절차(한/영)");
fs.unlinkSync(path.join(jobsDir, "ask-broken.json"));
fs.unlinkSync(path.join(jobsDir, "ask-array.json"));

console.log("[4] PRIVACY 고지 정합(P-2·P-3)");
const priv = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
ok(/`ask-jobs\/<id>\.json` · `\.out`\/`\.err`\/`\.pid`/.test(priv) && /7일 보존/.test(priv), "표에 ask-jobs 위치·내용·수명 명시");
ok(/`codex-turns\/<세션>\.json`/.test(priv) && /`codex-verify-attempts\/<세션>\.json` · `codex-scout-attempts\/<세션>\.json`/.test(priv), "표에 신규 서랍 3종 명시");
ok(/`codex-active\/<세션>\.json`/.test(priv) && /30일 보존/.test(priv) && /`codex-recovery\/<작업>\.json`/.test(priv), "codex-active(30일)·회수 영수증(90일)도 열거");
ok(/내구 검증\(ask-start\/ask-wait\)\*\*은 예외/.test(priv) && !/받을 출력만\*\* 잠깐 임시 폴더의 파일을 거친 뒤 읽고 곧 지웁니다\.$/m.test(priv), "임시파일 단정 문구 정정 — 내구 경로의 디스크 기록·보존·즉시 삭제 방법 고지");

console.log("[5] P-4 심화(2a 동결 계약) — 의미 손상·격리 시한부·clear 보호");
fs.writeFileSync(path.join(jobsDir, "ask-sem1.json"), JSON.stringify({ id: "ask-sem1", state: "running" }));
fs.writeFileSync(path.join(jobsDir, "ask-sem2.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-other", state: "running" }));
fs.writeFileSync(path.join(jobsDir, "ask-sem3.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-sem3" }));
{
  const bad2 = bridge.corruptAskJobFiles();
  ok(bad2.includes("ask-sem1.json") && bad2.includes("ask-sem2.json") && bad2.includes("ask-sem3.json"), "의미 손상(스키마 부재·id≠파일명·state 부재) — 활성 판정 우회 못 함(3차 blocker 봉합)");
}
fs.writeFileSync(path.join(jobsDir, "ask-sem4-aaaaaaaaaa.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-sem4-aaaaaaaaaa", state: "banana", workspace: "D:/x" }));
fs.writeFileSync(path.join(jobsDir, "ask-sem5-aaaaaaaaaa.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-sem5-aaaaaaaaaa", state: "running" }));
fs.writeFileSync(path.join(jobsDir, "ask-sem6-aaaaaaaaaa.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-sem6-aaaaaaaaaa", state: "running", workspace: "D:/x" }));
fs.writeFileSync(path.join(jobsDir, "ask-sem7-aaaaaaaaaa.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-sem7-aaaaaaaaaa", state: "succeeded", workspace: "   " }));
{
  const bad3 = bridge.corruptAskJobFiles();
  ok(bad3.includes("ask-sem4-aaaaaaaaaa.json") && bad3.includes("ask-sem5-aaaaaaaaaa.json") && bad3.includes("ask-sem6-aaaaaaaaaa.json"), "상태 오타·workspace 소실·진행형 deadline 부재 — 전부 차단(활성 판정 우회 봉합·재검증 1차 blocker)");
  ok(bad3.includes("ask-sem7-aaaaaaaaaa.json"), "공백뿐 workspace — 차단(재검증 2차 blocker: trim 검사)");
}
fs.unlinkSync(path.join(jobsDir, "ask-sem7-aaaaaaaaaa.json"));
for (const n of ["ask-sem1.json", "ask-sem2.json", "ask-sem3.json", "ask-sem4-aaaaaaaaaa.json", "ask-sem5-aaaaaaaaaa.json", "ask-sem6-aaaaaaaaaa.json"]) fs.unlinkSync(path.join(jobsDir, n));
fs.writeFileSync(path.join(jobsDir, "ask-q1.json.corrupt-" + Date.now()), "{깨진");
ok(bridge.corruptAskJobFiles().length === 1, "격리 직후 — 약 60분(시스템 timeout 상한)까지 신규 생성 차단 유지(살아있는 worker 중복 창 폐쇄)");
fs.readdirSync(jobsDir).filter((n) => n.includes(".corrupt-")).forEach((n) => fs.unlinkSync(path.join(jobsDir, n)));
fs.writeFileSync(path.join(jobsDir, "ask-q2.json.corrupt-" + (Date.now() - 61 * 60 * 1000)), "{깨진");
ok(bridge.corruptAskJobFiles().length === 0, "격리 60분 경과 — 자동 비차단(파일은 보존 — 수동 검토용)");
fs.readdirSync(jobsDir).filter((n) => n.includes(".corrupt-")).forEach((n) => fs.unlinkSync(path.join(jobsDir, n)));
fs.writeFileSync(path.join(jobsDir, "ask-q3.json.corrupt-" + (Date.now() + 24 * 60 * 60 * 1000)), "{깨진");
ok(bridge.corruptAskJobFiles().length === 0, "미래 시각 격리 파일(시계 역행·조작) — 무기한 차단이 되지 않음(|now-ts|<60분 · 재검증 2차 blocker)");
fs.readdirSync(jobsDir).filter((n) => n.includes(".corrupt-")).forEach((n) => fs.unlinkSync(path.join(jobsDir, n)));
const cp = require("child_process");
const runCli = (args) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), ...args], { encoding: "utf8", env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: "D:/p234-ws" }) });
const qid = "ask-p234q-aaaaaaaaaa";
fs.writeFileSync(path.join(jobsDir, qid + ".json"), JSON.stringify({ schema: "ask-job-v1", id: qid, state: "queued", workspace: "D:/p234-ws", deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }));
let rc = runCli(["ask-job", "clear", qid, "--confirm"]);
ok(rc.status === 3 && fs.existsSync(path.join(jobsDir, qid + ".json")) && /queued/.test(rc.stderr + rc.stdout), "queued+deadline 미경과 — PID 유무 무관 삭제 거부(생성 공백 경합 봉합·1차 blocker)");
fs.writeFileSync(path.join(jobsDir, qid + ".json"), JSON.stringify({ schema: "ask-job-v1", id: qid, state: "queued", workspace: "D:/p234-ws", deadlineAt: new Date(Date.now() - 60 * 1000).toISOString() }));
rc = runCli(["ask-job", "clear", qid, "--confirm"]);
ok(rc.status === 0 && !fs.existsSync(path.join(jobsDir, qid + ".json")), "deadline 경과 queued+무생존 — 삭제 허용");
const cid = "ask-p234c-bbbbbbbbbb";
fs.writeFileSync(path.join(jobsDir, cid + ".json"), "{깨진 JSON");
rc = runCli(["ask-job", "clear", cid, "--confirm"]);
{
  const quarantined = fs.readdirSync(jobsDir).filter((n) => n.startsWith(cid + ".json.corrupt-"));
  ok(rc.status === 0 && !fs.existsSync(path.join(jobsDir, cid + ".json")) && quarantined.length === 1 && /격리|Quarantined/.test(rc.stdout), "손상 job — 삭제 아닌 원자 격리(원문 보존·해소 명령이 실제로 작동 — 2차 blocker 봉합)");
  ok(fs.readFileSync(path.join(jobsDir, quarantined[0]), "utf8") === "{깨진 JSON", "격리 원문 바이트 보존");
  quarantined.forEach((n) => fs.unlinkSync(path.join(jobsDir, n)));
}
const aid = "ask-p234a-cccccccccc";
fs.writeFileSync(path.join(jobsDir, aid + ".json"), JSON.stringify({ schema: "ask-job-v1", id: aid, state: "running", workspace: "D:/p234-ws", workerPid: null, deadlineAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }));
fs.writeFileSync(path.join(jobsDir, aid + ".pid"), String(process.pid));
rc = runCli(["ask-job", "clear", aid, "--confirm"]);
ok(rc.status === 3 && fs.existsSync(path.join(jobsDir, aid + ".json")), "별도 .pid 생존 — 삭제 거부(queued 외 상태도 이중 생존 검사)");
fs.writeFileSync(path.join(jobsDir, aid + ".pid"), "999999999");
rc = runCli(["ask-job", "clear", aid, "--confirm"]);
ok(rc.status === 0 && !fs.existsSync(path.join(jobsDir, aid + ".json")) && !fs.existsSync(path.join(jobsDir, aid + ".pid")), "무생존 확인 후 부속물 포함 삭제");
fs.writeFileSync(path.join(jobsDir, "ask-vict1m-aaaaaaaaaa.json"), JSON.stringify({ schema: "ask-job-v1", id: "ask-vict1m-aaaaaaaaaa", state: "succeeded", workspace: "D:/p234-ws" }));
rc = runCli(["ask-job", "clear", "ask-vict1m-aaaaaaaaaa!", "--confirm"]);
ok(rc.status === 2 && fs.existsSync(path.join(jobsDir, "ask-vict1m-aaaaaaaaaa.json")), "id 문법 밖 clear — 거부(문자 제거 축소로 다른 정상 job 오삭제 차단·재검증 1차 blocker)+수동 안내");
fs.unlinkSync(path.join(jobsDir, "ask-vict1m-aaaaaaaaaa.json"));

console.log("[6] PRIVACY — 백로그 장부 고지(2a)");
ok(/verify-backlog\/<프로젝트 키>\.jsonl/.test(priv) && /수동 정리/.test(priv), "표에 verify-backlog 위치·내용·수명(수동) 명시");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
