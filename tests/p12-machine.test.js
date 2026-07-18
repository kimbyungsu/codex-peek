"use strict";
/*
 * P-12 2c — 기계 판독 딱지(설계 동결 5왕복 v2~v5).
 * 계약: 판정 줄 바로 앞 구조화 지적 블록(엄격 마커 문법·plain object JSONL) → 정합 행렬(불일치·파싱 실패=
 * 보류 강등 fail-closed·비차단 있는 깨끗한 통과=통과(보완) 상향 정정) → [백로그]만 자동 장부 등록(민감 제목
 * 거부=원문 비복사) → 반복 회수 무부작용(stdout·stderr·exit 동일·장부 줄 수·무결성 이벤트 수 불변).
 * proof·raw answer 불변(proof=실행 영수증 계약 — 강등은 판정·경보 계층만).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p12mc_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const KO = { s: "[지적 목록 v1]", e: "[지적 목록 끝]" };
const EN = { s: "[findings v1]", e: "[findings end]" };
const row = (tag, title, file) => JSON.stringify(file === undefined ? { tag, title } : { tag, title, file });
const ans = (rows, verdict) => [KO.s, ...rows, KO.e, verdict === undefined ? "검증: 통과" : verdict].filter((x) => x !== null).join("\n");

console.log("[1] 파서 — 엄격 마커 문법(동결 C-2)");
{
  let p = CL.parseFindingsBlock("본문\n검증: 통과");
  ok(p.present === false && p.ok === false, "마커 쌍 부재 — present:false(강등 재료)");
  p = CL.parseFindingsBlock(ans([], undefined));
  ok(p.present && p.ok && p.findings.length === 0, "빈 블록 — 정상(지적 0건)");
  p = CL.parseFindingsBlock([EN.s, row("backlog", "en block finding"), EN.e, "Verdict: pass"].join("\n"));
  ok(p.ok && p.findings[0].tag === "백로그", "EN 블록·EN 태그 동의어 → ko 정본 정규화");
  p = CL.parseFindingsBlock([KO.s, row("백로그", "혼합"), EN.e, "검증: 통과"].join("\n"));
  ok(p.present && !p.ok, "혼합 언어 쌍(ko 시작·en 종료) — ok:false");
  p = CL.parseFindingsBlock([KO.s, row("백로그", "a"), KO.s, row("백로그", "b"), KO.e, "검증: 통과"].join("\n"));
  ok(p.ok && p.findings.length === 1 && p.findings[0].title === "b", "이중 시작 — 마지막 시작 마커 권위(앞 블록 무시)");
  p = CL.parseFindingsBlock([KO.s, row("백로그", "a"), KO.e, KO.e, "검증: 통과"].join("\n"));
  ok(!p.ok, "종료 마커 중복(마지막 시작 뒤 마커 2개) — ok:false");
  p = CL.parseFindingsBlock([KO.s, row("백로그", "a"), KO.e, "추가 본문 줄", "검증: 통과"].join("\n"));
  ok(!p.ok && p.corrupt.items.some((x) => x.reasonKey === "marker"), "종료 마커 뒤 비어 있지 않은 본문 — ok:false(위치 결속)");
  p = CL.parseFindingsBlock([KO.s, row("백로그", "a"), KO.e, "", "검증: 통과"].join("\n"));
  ok(p.ok, "종료 마커 뒤 빈 줄+판정 1줄 — 허용");
  p = CL.parseFindingsBlock([KO.s, row("백로그", "a"), KO.e].join("\n"));
  ok(p.ok && p.tailVerdictLine === "", "판정 줄 없음 — 문법상 허용·tailVerdictLine 빈값(강등은 정합기 몫 no-verdict-line)");
  p = CL.parseFindingsBlock(["본문 중간의 옛 선언 검증: 통과", KO.s, row("백로그", "a"), KO.e, "검증: 실패"].join("\n"));
  ok(p.ok && p.tailVerdictLine === "검증: 실패", "tail 결속 — 정합용 판정=종료 마커 '뒤' 선언(블록 앞 옛 선언 미사용 · 구현검증 1차 blocker①)");
  ok(CL.judgeMachineVerdict(CL.extractVerdict(CL.parseFindingsBlock(["검증: 통과", KO.s, row("보완", "x"), KO.e].join("\n")).tailVerdictLine || ""), CL.parseFindingsBlock(["검증: 통과", KO.s, row("보완", "x"), KO.e].join("\n"))).reasonKey === "no-verdict-line", "블록 앞에만 판정 존재 — tail 부재로 보류 강등(옛 판정 누수 차단)");
  p = CL.parseFindingsBlock([" " + KO.s, row("백로그", "a"), KO.e, "검증: 통과"].join("\n"));
  ok(p.present === false, "마커 앞 공백 — 행 전체 정확 일치 아님(시작 인정 안 함)");
}

console.log("[2] 파서 — JSON 행 스키마(plain object·title·file) + 원문 비복사 진단");
{
  const secret = "ghp_ABCDEFGHIJKLMNOP1234";
  let p = CL.parseFindingsBlock(ans(["[1,2]"]));
  ok(!p.ok && p.corrupt.items[0].reasonKey === "not-object", "배열 행 — not-object");
  p = CL.parseFindingsBlock(ans([JSON.stringify({ tag: "백로그", title: "x", file: { a: 1 } })]));
  ok(!p.ok && p.corrupt.items[0].reasonKey === "bad-file", "file 중첩 객체 — bad-file");
  p = CL.parseFindingsBlock(ans([row("몰라", "x")]));
  ok(!p.ok && p.corrupt.items[0].reasonKey === "bad-tag", "미지 태그 — bad-tag");
  p = CL.parseFindingsBlock(ans([row("백로그", "   ")]));
  ok(!p.ok && p.corrupt.items[0].reasonKey === "bad-title", "공백 제목 — bad-title");
  p = CL.parseFindingsBlock(ans([JSON.stringify({ tag: "blocker", title: "first\nsecond" })]));
  ok(!p.ok && p.corrupt.items[0].reasonKey === "bad-title", "다행 제목(JSON \\n 디코딩) — bad-title('1줄' 계약 · 구현검증 1차 blocker②)");
  p = CL.parseFindingsBlock(ans([JSON.stringify({ tag: "백로그", title: "a b" })]));
  ok(!p.ok && p.corrupt.items[0].reasonKey === "bad-title", "U+2028 줄 구분 제목 — bad-title");
  p = CL.parseFindingsBlock(ans(["{broken " + secret]));
  const flat = JSON.stringify(p);
  ok(!p.ok && !flat.includes(secret), "손상 줄에 토큰이 있어도 파서 반환 어디에도 원문 비복사({lineNo,reasonKey}만)");
  ok(p.corrupt.items[0].lineNo === 2 && p.corrupt.items[0].reasonKey === "bad-json", "진단은 좌표·사유 키만");
}

console.log("[3] 정합 행렬(동결 C-1) — 전 칸");
{
  const J = (v, rows) => CL.judgeMachineVerdict(v, CL.parseFindingsBlock(ans(rows, v === null ? null : "검증: 통과")));
  const blk = row("blocker", "차단 결함");
  const note = row("보완", "국소 결함");
  ok(CL.judgeMachineVerdict("pass", { present: false, ok: false, findings: [], corrupt: { count: 0, items: [] } }).reasonKey === "block-missing", "블록 부재 → 보류(block-missing)");
  ok(CL.judgeMachineVerdict("pass", CL.parseFindingsBlock(ans(["{bad"]))).reasonKey === "block-corrupt", "블록 손상 → 보류(block-corrupt)");
  ok(CL.judgeMachineVerdict(null, CL.parseFindingsBlock(ans([]))).reasonKey === "no-verdict-line", "표지 없음 → 보류(no-verdict-line — core 기계 판정 구멍 봉합)");
  ok(CL.judgeMachineVerdict("inconclusive", CL.parseFindingsBlock(ans([blk]))).demoted === false, "보류 선언 — 블록 상태 무관 고유 의미 유지");
  ok(CL.judgeMachineVerdict("inconclusive", CL.parseFindingsBlock("블록 없음")).demoted === false, "보류 선언+블록 부재 — 강등 안 함(행렬 정본·2차 blocker②)");
  ok(CL.judgeMachineVerdict("inconclusive", CL.parseFindingsBlock(ans(["{bad"]))).demoted === false, "보류 선언+블록 손상 — 강등 안 함(이미 보류인 답에 경보 미부착)");
  ok(CL.judgeMachineVerdict("fail", CL.parseFindingsBlock(ans([blk]))).demoted === false, "blocker≥1+실패 선언 — 정합 유지");
  ok(CL.judgeMachineVerdict("pass", CL.parseFindingsBlock(ans([blk]))).reasonKey === "pass-with-blocker", "blocker≥1+통과 선언 — 보류 강등");
  ok(CL.judgeMachineVerdict("pass-notes", CL.parseFindingsBlock(ans([blk]))).reasonKey === "pass-with-blocker", "blocker≥1+통과(보완) 선언 — 보류 강등");
  ok(CL.judgeMachineVerdict("fail", CL.parseFindingsBlock(ans([note]))).reasonKey === "fail-without-blocker", "blocker 0+실패 선언 — 보류 강등");
  const c = CL.judgeMachineVerdict("pass", CL.parseFindingsBlock(ans([note])));
  ok(c.effective === "pass-notes" && c.corrected && !c.demoted, "비차단≥1+깨끗한 통과 — '통과(보완)' 상향 정정(처리 의무 약화 차단)");
  ok(CL.judgeMachineVerdict("pass-notes", CL.parseFindingsBlock(ans([note]))).demoted === false, "비차단≥1+통과(보완) — 정합 유지");
  ok(CL.judgeMachineVerdict("pass", CL.parseFindingsBlock(ans([]))).demoted === false, "빈 블록+통과 — 깨끗한 통과 정합");
  ok(CL.judgeMachineVerdict("pass-notes", CL.parseFindingsBlock(ans([]))).demoted === false, "빈 블록+통과(보완) — 유지 관용(항목 0개 의무=공집합)");
}

console.log("[4] 민감 제목 방어(동결 D-2 v5) — 형태 일반형·오탐=수동 폴백 흡수");
{
  const S = CL.safeBacklogAutoTitle;
  ok(S("영문 라벨 혼용 정리 필요").ok, "정상 제목 — 통과");
  ok(S("src/a.ts와 b/c 경계 비교").ok, "상대경로 형태 — 통과(a/b 세그먼트 1단 상대형)");
  ok(!S("C:\\Users\\someone\\x 노출").ok, "드라이브 경로 — 거부");
  ok(!S("경로 /root/x 잔존").ok && !S("/etc/passwd 참조").ok && !S("/var/log/app.log 인용").ok, "유닉스 절대경로 일반형(/root·/etc·/var — 열거 아님) — 거부");
  ok(!S("경로=/opt/secret/f 주입").ok && !S("경로:/opt/x/y").ok && !S("\"/srv/a/b\" 인용").ok, "= : 따옴표 경계 뒤 경로 — 거부(공백 경계 한정 아님 · 4차 blocker 봉합)");
  ok(!S("\\\\server\\share\\f 접근").ok && !S("//server/share/f 접근").ok && !S("\\\\?\\C:\\x 장경로").ok, "UNC 3형(백슬래시·슬래시 2연속·\\\\?\\) — 거부");
  ok(!S("~/secrets/k 노출").ok, "물결 홈 — 거부");
  ok(!S("답장은 someone@example.com 으로").ok, "이메일 — 거부");
  ok(!S("토큰 eyJhbGciOiJIUzI1NiJ9 노출").ok && !S("AKIAABCDEFGHIJKLMNOP 키").ok && !S("ghp_ABCDEFGHIJKLMNOP 키").ok && !S("sk-abcdefghijklmnop 키").ok, "비밀형 접두(eyJ·AKIA·ghp_·sk-) — 거부");
  ok(!S("덩어리 0123456789abcdef0123456789abcdef 포함").ok, "32+ 연속 hex/base64 — 거부");
  ok(!S("제어\t문자").ok, "제어문자(탭 U+0009) — 거부");
  // 7차 blocker: 제목의 %HH 인코딩 우회 — 해독본 재검사·다중 인코딩/해독 불능=보수 거부.
  ok(!S("토큰 ghp%5FABCDEFGHIJKLMNOP 노출").ok, "인코딩 토큰 제목(ghp%5F) — 해독본 검사로 거부");
  ok(!S("메일 someone%40example.com 회신").ok && !S("탭 a%09b 포함").ok, "인코딩 이메일·제어문자 제목 — 거부");
  ok(!S("이중 ghp%255FABCDEFGHIJKLMNOP 인코딩").ok && !S("깨진 %E0%A4 인코딩").ok, "다중 인코딩 잔존·해독 불능 — 보수 거부(encoded)");
  ok(S("실패율 50% 초과 케이스").ok, "비인코딩 %(퍼센트 숫자 아님) — 통과(오탐 최소)");
  const F = CL.safeBacklogAutoFile;
  ok(F("src/a.ts").ok && F("C:/proj/src/a.ts").ok && F("").ok, "file — 경로 형태는 정상(절대경로 최소화는 normBacklogFile 담당·2차 blocker③)");
  ok(!F("eyJhbGciOiJIUzI1NiJ9").ok && !F("someone@example.com").ok && !F("파일\t명").ok, "file — 비경로 비밀형(토큰·이메일·제어문자) 거부");
  // 3차 blocker: file: URI·'반대 OS' 절대경로는 현 OS path.isAbsolute를 우회해 원문 경로가 장부에 남던 구멍 — 외부 축소 지속 반례.
  const NBW = "D:/bl-proj";
  ok(CL.normBacklogFile("file:///C:/Users/someone/secret.txt", NBW) === "secret.txt (외부)", "file:// URI — basename 외부 축소(사용자 디렉터리 비보존)");
  ok(CL.normBacklogFile("file:///C:/Users/someone/x.ts?line=3#L4", NBW) === "x.ts (외부)", "URI 쿼리·프래그먼트 절단 후 축소");
  if (process.platform === "win32") {
    ok(CL.normBacklogFile("/etc/passwd", NBW) === "passwd (외부)", "윈도에서 루트형 절대경로 — 외부 축소(현 OS 해석 경로)");
  } else {
    ok(CL.normBacklogFile("D:\\Users\\someone\\x.ts", "/bl-proj") === "x.ts (외부)", "POSIX에서 윈도 드라이브 절대경로 — 이형 절대 식별·외부 축소");
  }
  ok(CL.normBacklogFile("//server/share/f.ts", NBW) === "f.ts (외부)", "UNC(슬래시 2연속) — 외부 축소");
  // 4차 blocker: 퍼센트 인코딩 구분자(%2F·%5C)가 lastSeg를 우회해 사용자 디렉터리 계층 전체가 보존되던 구멍.
  ok(CL.normBacklogFile("file:C:%5CUsers%5Csomeone%5Csecret.txt", NBW) === "secret.txt (외부)", "인코딩 백슬래시 URI — 해독 후 basename 축소");
  ok(CL.normBacklogFile("file:%2F%2F%2FC:%2FUsers%2Fsomeone%2Fsecret.txt", NBW) === "secret.txt (외부)", "인코딩 슬래시 URI — 해독 후 basename 축소");
  ok(CL.normBacklogFile("file:C:%252FUsers%252Fsomeone", NBW) === "(외부 URI)", "이중 인코딩 잔존 — 원문 전체 비보존 상수");
  ok(CL.normBacklogFile("file:C:%25255CUsers%25255Csomeone%25255Csecret.txt", NBW) === "(외부 URI)" && CL.normBacklogFile("file:C:%2525255CUsers", NBW) === "(외부 URI)", "3중·4중 인코딩 — 해독 후 % 잔존=깊이 불문 비보존(5차 blocker)");
  ok(CL.normBacklogFile("file:C:%ZZbroken", NBW) === "(외부 URI)", "해독 불능 URI — 원문 전체 비보존 상수(fail-closed)");
  // 6차 blocker: 저장 직전 해독으로 인코딩된 비밀형이 검사(원문 기준)를 우회하던 순서 구멍 — 검사가 해독본도 본다.
  ok(!F("file:///x/ghp%5FABCDEFGHIJKLMNOP").ok, "인코딩된 토큰(ghp%5F→ghp_) — 해독본 검사로 거부");
  ok(!F("file:///x/someone%40example.com").ok, "인코딩된 이메일(%40→@) — 거부");
  ok(!F("file:///x/a%09b.ts").ok, "인코딩된 제어문자(%09→탭) — 거부");
  ok(F("file:///proj/src/a.ts").ok, "정상 file URI — 통과(경로 축소는 normBacklogFile 담당)");
  // 8차 blocker: URI 아닌 '상대 file'의 다중·손상 인코딩 — 제목과 대칭인 encoded fail-closed.
  ok(!F("src/ghp%255FABCDEFGHIJKLMNOP.ts").ok, "상대 file 이중 인코딩 토큰 — 거부(encoded·해독 후 %HH 잔존)");
  ok(!F("src/someone%2540example.com.ts").ok && !F("src/a%2509b.ts").ok, "상대 file 이중 인코딩 이메일·제어 — 거부");
  ok(!F("src/ghp%5FABCDEFGHIJKLMNOP%E0.ts").ok, "유효 비밀형+깨진 % 혼합(전체 해독 실패 유도) — 거부(encoded)");
  ok(F("src/50% done.ts").ok, "비인코딩 %(뒤가 16진 쌍 아님) — 통과(오탐 최소)");
}

console.log("[5] formatForClaude 4번째 인자 — 강등·정정 footer·무전달=바이트 동일");
{
  const noteAns = ans([row("보완", "국소 결함")], "검증: 통과");
  const base = CL.formatForClaude(noteAns, "ko", "core");
  ok(base === CL.formatForClaude(noteAns, "ko", "core", undefined), "machine 미전달 — 기존 호출과 바이트 동일(무회귀)");
  const m = { ...CL.judgeMachineVerdict("pass", CL.parseFindingsBlock(noteAns)), parse: CL.parseFindingsBlock(noteAns) };
  const out = CL.formatForClaude(noteAns, "ko", "core", m);
  ok(/기계 판독: 비차단 지적 존재 — '통과' 선언을 '통과\(보완\)'로 정정/.test(out) && /보완 의견 있음/.test(out), "정정 — footer 사유 줄+통과(보완) 처리 의무로 교체");
  const badAns = "본문만 있고 블록 없음\n검증: 통과";
  const m2 = { ...CL.judgeMachineVerdict("pass", CL.parseFindingsBlock(badAns)), parse: CL.parseFindingsBlock(badAns) };
  const out2 = CL.formatForClaude(badAns, "ko", "core", m2);
  ok(/기계 판독: 기계 판독용 지적 블록 없음 — 판정을 '보류'로 강등/.test(out2) && /추가 확인 필요/.test(out2), "강등 — 보류 처리 의무+사유 줄(fail-closed)");
  const noDecl = ans([], null).replace(/\n검증: 통과$/, "");
  const m3 = { ...CL.judgeMachineVerdict(null, CL.parseFindingsBlock(noDecl)), parse: CL.parseFindingsBlock(noDecl) };
  ok(/추가 확인 필요/.test(CL.formatForClaude(noDecl, "ko", "core", m3)), "표지 줄 없음+machine — 원문 방치 대신 보류 footer 강제(구멍 봉합)");
  // 2차 blocker①: 블록 '앞'에만 옛 판정이 있고 tail이 없으면 footer의 'Codex 선언'도 옛 판정을 재노출하지 않는다.
  const frontOnly = ["Verdict: pass", KO.s, KO.e].join("\n");
  const pf = CL.parseFindingsBlock(frontOnly);
  const m4 = { ...CL.judgeMachineVerdict(CL.extractVerdict(pf.tailVerdictLine || ""), pf), parse: pf };
  const out4 = CL.formatForClaude(frontOnly, "ko", "core", m4);
  ok(/Codex 선언: \(표지 줄 없음\)/.test(out4) && !/Codex 선언: Verdict: pass/.test(out4) && /판정 표지 줄 없음 — 판정을 '보류'로 강등/.test(out4), "footer tail 결속 — 블록 앞 옛 선언을 'Codex 선언'으로 재노출하지 않음(2차 blocker①)");
}

console.log("[6] 내구 e2e(실 child) — 자동 등록 1회·반복 회수 3축 동일·경보·proof 불변");
{
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "p12mc_e2e_"));
  fs.mkdirSync(path.join(H, "ask-jobs"), { recursive: true });
  const act = path.join(H, "active"); fs.mkdirSync(act, { recursive: true });
  const SID = "sess-mc-01", TS = "2026-07-18T10:00:00.000Z";
  fs.writeFileSync(path.join(act, SID + ".json"), JSON.stringify({ claudeSession: SID, workspace: H, ts: TS }));
  fs.mkdirSync(path.join(H, "contracts"), { recursive: true });
  const wsKey = CL.wsKeyFor(H);
  fs.writeFileSync(path.join(H, "contracts", wsKey + ".json"), JSON.stringify({ workspace: H, verifyProfile: "core" }));
  // 가짜 codex: --json류 stdout에 thread.started를 내보내고 -o 파일에 '블록+판정' 답을 쓴다(즉시연결 경로 성립).
  const UUID = "12345678-1234-4123-8123-123456789abc";
  const answer = [KO.s, row("백로그", "영문 라벨 정리 후보"), row("백로그", "토큰 eyJhbGciOiJIUzI1NiJ9 포함 제목"), row("보완", "국소 문구"), KO.e, "검증: 통과(보완)"].join("\n");
  const fakeCodex = path.join(H, "fake-codex.js");
  fs.writeFileSync(fakeCodex, [
    "const fs=require('fs');",
    "const i=process.argv.indexOf('-o');",
    "if(i>=0)fs.writeFileSync(process.argv[i+1]," + JSON.stringify(answer) + ");",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'" + UUID + "'})+'\\n');",
  ].join("\n"));
  // 가짜 CODEX_HOME — 연결 판정(findRolloutById)이 실제 rollout 파일 존재를 요구하므로 생성해 둔다.
  const CH = path.join(H, "codex-home");
  const sess = path.join(CH, "sessions", "2026", "07", "18");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, "rollout-2026-07-18T10-00-00-" + UUID + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id: UUID, cwd: H } }) + "\n");
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const env = { ...process.env, CODEX_BRIDGE_HOME: H, CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PROJECT_DIR: H, CODEX_BIN: fakeCodex, CODEX_HOME: CH, CODEX_BRIDGE_VERIFY_TIMEOUT_MIN: "7" };
  delete env.CODEX_BRIDGE_JOB_PROMPT_FILE; delete env.CODEX_BRIDGE_ASK_JOB_ID; delete env.CODEX_BRIDGE_WORKER_BRIDGE;
  const rs = cp.spawnSync(process.execPath, [cli, "ask-start", "--allow-new", "machine-e2e"], { cwd: H, encoding: "utf8", env, timeout: 30000, windowsHide: true });
  ok(rs.status === 0, "ask-start=queued 성공: " + (rs.stderr || "").slice(0, 150));
  const jid = (rs.stdout.match(/"jobId": "([^"]+)"/) || [])[1] || "";
  const jf = path.join(H, "ask-jobs", jid + ".json");
  let done = null;
  for (let i = 0; i < 150; i++) { try { done = JSON.parse(fs.readFileSync(jf, "utf8")); if (["succeeded", "failed"].includes(done.state)) break; } catch { } cp.execSync(process.platform === "win32" ? "ping -n 1 127.0.0.1 > NUL" : "sleep 0.2"); }
  ok(done && done.state === "succeeded", "worker→child 성공(가짜 codex 답 소비): state=" + (done && done.state));
  const blFile = path.join(H, "verify-backlog", wsKey + ".jsonl");
  const integFile = path.join(H, "integrity.json"); // 실제 무결성 이벤트 파일(INTEGRITY_FILE — 1차 blocker④: 없는 파일명 -1===-1 통과 봉합)
  const integRaw = () => { try { return fs.readFileSync(integFile, "utf8"); } catch { return ""; } };
  const integCount = () => { const s = integRaw(); if (!s) return 0; try { const o = JSON.parse(s); return Array.isArray(o) ? o.length : (o && Array.isArray(o.events) ? o.events.length : s.length); } catch { return s.length; } };
  const wait1 = cp.spawnSync(process.execPath, [cli, "ask-wait", jid], { encoding: "utf8", env: { ...env, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  const lines1 = fs.existsSync(blFile) ? fs.readFileSync(blFile, "utf8").split("\n").filter(Boolean).length : 0;
  const integ1 = integCount();
  const wait2 = cp.spawnSync(process.execPath, [cli, "ask-wait", jid], { encoding: "utf8", env: { ...env, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  const lines2 = fs.existsSync(blFile) ? fs.readFileSync(blFile, "utf8").split("\n").filter(Boolean).length : 0;
  const integ2 = integCount();
  ok(/\[장부 자동 등록\] [a-f0-9]{16}/.test(wait1.stdout), "자동 등록 영수증 id — 회수 출력에 존재");
  // 원문 비복사 계약은 '거부 경고 줄·장부·이벤트'에 대한 것 — 답 본문(블록 원문 에코)에는 검증자가 쓴 제목이 그대로 있다.
  const refLine = wait1.stdout.split("\n").find((l) => l.includes("[장부 자동 등록 거부]")) || "";
  ok(/2번째 \[백로그\] 항목: 민감 가능 제목\(token\)/.test(refLine) && !refLine.includes("eyJhbGciOiJIUzI1NiJ9"), "민감 제목(JWT) — 거부 경고 줄에 원문 비복사(순번·태그·사유 키만)");
  ok(/'통과' 선언을 '통과\(보완\)'로 정정/.test(wait1.stdout) === false && /통과\(보완\)/.test(answer), "통과(보완) 선언+비차단 지적 — 정합 유지(정정·강등 없음)");
  const bl = fs.existsSync(blFile) ? fs.readFileSync(blFile, "utf8") : "";
  ok(/영문 라벨 정리 후보/.test(bl) && !bl.includes("eyJhbGciOiJIUzI1NiJ9"), "장부 — 안전 제목 1건만 등록·민감 제목 원문 미저장");
  ok(!bl.includes("국소 문구"), "[보완]·blocker는 자동 등록 비대상([백로그]만 — 1차 blocker④: 상시 참 단언 교체)");
  const addEv = bl.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.ev === "add");
  ok(addEv && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(addEv.source || "")), "장부 source=askId(실행별 UUID) — 어느 검증 실행의 관측인지 귀속(1차 blocker③: 상수 machine-2c 아님)");
  ok(wait1.status === wait2.status && wait1.stdout === wait2.stdout && wait1.stderr === wait2.stderr, "반복 회수 — stdout·stderr·exit 3축 바이트 동일(2차 blocker⑦)");
  ok(lines1 === lines2, "반복 회수 — 장부 원시 append 줄 수 불변(seenCount 인플레 없음)");
  ok(integ1 === integ2, "반복 회수 — 무결성 이벤트 수 불변(실파일 integrity.json 실측·강등 이벤트 실증은 아래 job2)");
  const proofDir = path.join(H, "proofs");
  ok(fs.existsSync(proofDir) && fs.readdirSync(proofDir).length >= 1, "proof 존재 — 실행 영수증 계약 유지(강등·정정과 무관)");

  // 파싱 실패(블록 없음) job — 등록 0건+보류 강등 footer
  const answer2 = "블록 없는 답\n검증: 통과";
  fs.writeFileSync(fakeCodex, [
    "const fs=require('fs');",
    "const i=process.argv.indexOf('-o');",
    "if(i>=0)fs.writeFileSync(process.argv[i+1]," + JSON.stringify(answer2) + ");",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'" + UUID + "'})+'\\n');",
  ].join("\n"));
  const rs2 = cp.spawnSync(process.execPath, [cli, "ask-start", "machine-e2e-2"], { cwd: H, encoding: "utf8", env, timeout: 30000, windowsHide: true });
  ok(rs2.status === 0, "2번째 ask-start(연결 재사용) 성공");
  const jid2 = (rs2.stdout.match(/"jobId": "([^"]+)"/) || [])[1] || "";
  const jf2 = path.join(H, "ask-jobs", jid2 + ".json");
  let done2 = null;
  for (let i = 0; i < 150; i++) { try { done2 = JSON.parse(fs.readFileSync(jf2, "utf8")); if (["succeeded", "failed"].includes(done2.state)) break; } catch { } cp.execSync(process.platform === "win32" ? "ping -n 1 127.0.0.1 > NUL" : "sleep 0.2"); }
  const w3 = cp.spawnSync(process.execPath, [cli, "ask-wait", jid2], { encoding: "utf8", env: { ...env, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  const lines3 = fs.existsSync(blFile) ? fs.readFileSync(blFile, "utf8").split("\n").filter(Boolean).length : 0;
  ok(/기계 판독: 기계 판독용 지적 블록 없음 — 판정을 '보류'로 강등/.test(w3.stdout) && /추가 확인 필요/.test(w3.stdout), "블록 없음 — 보류 강등 footer(fail-closed)");
  ok(lines3 === lines2, "블록 없음 — 자동 등록 0건(장부 불변)");
  // 강등 이벤트 실증(worker의 child 실행에서 이미 기록됨) + 반복 회수 무증가 — 실파일 실측(1차 blocker④).
  const integA = integCount();
  ok(integRaw().includes("machine-verdict"), "강등 — machine-verdict 무결성 이벤트 실재(경보 가시화)");
  const w4 = cp.spawnSync(process.execPath, [cli, "ask-wait", jid2], { encoding: "utf8", env: { ...env, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  ok(w4.status === w3.status && w4.stdout === w3.stdout && w4.stderr === w3.stderr && integCount() === integA, "강등 job 반복 회수 — 3축 동일+이벤트 수 불변");

  // 자동 등록 실패 e2e(동결 F-2) — 부모(테스트)가 장부 잠금을 보유한 채 3번째 내구 job 실행 → 등록 실패 fail-visible.
  const answer3 = [KO.s, JSON.stringify({ tag: "백로그", title: "잠금 중 자동 등록 시도" }), KO.e, "검증: 통과(보완)"].join("\n");
  fs.writeFileSync(fakeCodex, [
    "const fs=require('fs');",
    "const i=process.argv.indexOf('-o');",
    "if(i>=0)fs.writeFileSync(process.argv[i+1]," + JSON.stringify(answer3) + ");",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'" + UUID + "'})+'\\n');",
  ].join("\n"));
  fs.mkdirSync(path.dirname(blFile), { recursive: true });
  fs.writeFileSync(blFile + ".lock", process.pid + "-hold", "utf8"); // 살아있는 부모 보유 잠금 — child의 backlogAdd 거부 유도
  const rs3 = cp.spawnSync(process.execPath, [cli, "ask-start", "machine-e2e-3"], { cwd: H, encoding: "utf8", env, timeout: 30000, windowsHide: true });
  const jid3 = (rs3.stdout.match(/"jobId": "([^"]+)"/) || [])[1] || "";
  const jf3 = path.join(H, "ask-jobs", jid3 + ".json");
  let done3 = null;
  for (let i = 0; i < 150; i++) { try { done3 = JSON.parse(fs.readFileSync(jf3, "utf8")); if (["succeeded", "failed"].includes(done3.state)) break; } catch { } cp.execSync(process.platform === "win32" ? "ping -n 1 127.0.0.1 > NUL" : "sleep 0.2"); }
  const w5 = cp.spawnSync(process.execPath, [cli, "ask-wait", jid3], { encoding: "utf8", env: { ...env, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  const w6 = cp.spawnSync(process.execPath, [cli, "ask-wait", jid3], { encoding: "utf8", env: { ...env, CODEX_BRIDGE_JOB_WAIT_SLICE_MS: "0" }, timeout: 15000, windowsHide: true });
  fs.unlinkSync(blFile + ".lock");
  ok(/\[장부 자동 등록 실패\] 1번째 \[백로그\] 항목\(/.test(w5.stdout) && /수동 등록/.test(w5.stdout), "등록 실패 — fail-visible 경고+수동 명령 안내(사유 키=backlogAdd error 필드)");
  const failLine = w5.stdout.split("\n").find((l) => l.includes("[장부 자동 등록 실패]")) || "";
  ok(/\([a-z0-9-]{1,32}\)/.test(failLine) && !failLine.includes(H), "등록 실패 사유 — 짧은 키만(잠금 절대경로 등 로컬 정보 비복사 실측 · 2차 blocker③)");
  ok(!fs.readFileSync(blFile, "utf8").includes("잠금 중 자동 등록 시도"), "등록 실패 — 장부 미기록(잠금 직렬화 존중)");
  ok(w5.status === w6.status && w5.stdout === w6.stdout && w5.stderr === w6.stderr, "등록 실패 응답 반복 회수 — 3축 동일(동결 F-2)");
}

console.log("[6b] 직접 ask e2e(CL-C — 동결 F-1 ⑸) — 같은 규칙·영수증·proof");
{
  const H = fs.mkdtempSync(path.join(os.tmpdir(), "p12mc_dir_"));
  const act = path.join(H, "active"); fs.mkdirSync(act, { recursive: true });
  const SID = "sess-mc-dir", TS = "2026-07-18T11:00:00.000Z";
  fs.writeFileSync(path.join(act, SID + ".json"), JSON.stringify({ claudeSession: SID, workspace: H, ts: TS }));
  fs.mkdirSync(path.join(H, "contracts"), { recursive: true });
  const wsKey = CL.wsKeyFor(H);
  fs.writeFileSync(path.join(H, "contracts", wsKey + ".json"), JSON.stringify({ workspace: H, verifyProfile: "core" }));
  const UUID = "22345678-1234-4123-8123-123456789abc";
  const answer = [KO.s, row("백로그", "직접 ask 자동 등록 반례"), KO.e, "검증: 통과(보완)"].join("\n");
  const fakeCodex = path.join(H, "fake-codex.js");
  fs.writeFileSync(fakeCodex, [
    "const fs=require('fs');",
    "const i=process.argv.indexOf('-o');",
    "if(i>=0)fs.writeFileSync(process.argv[i+1]," + JSON.stringify(answer) + ");",
    "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'" + UUID + "'})+'\\n');",
  ].join("\n"));
  const CH = path.join(H, "codex-home");
  const sess = path.join(CH, "sessions", "2026", "07", "18");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, "rollout-2026-07-18T11-00-00-" + UUID + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id: UUID, cwd: H } }) + "\n");
  const cli = path.join(ROOT, "bridge", "codex-bridge.js");
  const env = { ...process.env, CODEX_BRIDGE_HOME: H, CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PROJECT_DIR: H, CODEX_BIN: fakeCodex, CODEX_HOME: CH };
  delete env.CODEX_BRIDGE_JOB_PROMPT_FILE; delete env.CODEX_BRIDGE_ASK_JOB_ID; delete env.CODEX_BRIDGE_WORKER_BRIDGE;
  const r = cp.spawnSync(process.execPath, [cli, "ask", "--allow-new", "direct-machine"], { cwd: H, encoding: "utf8", env, timeout: 60000, windowsHide: true });
  ok(r.status === 0 && /\[장부 자동 등록\] [a-f0-9]{16}/.test(r.stdout), "직접 ask — 자동 등록 영수증(내구와 같은 규칙): " + (r.stderr || "").slice(0, 120));
  ok(/보완 의견 있음/.test(r.stdout), "직접 ask — 통과(보완) 처리 의무 footer");
  const bl = fs.readFileSync(path.join(H, "verify-backlog", wsKey + ".jsonl"), "utf8");
  ok(bl.includes("직접 ask 자동 등록 반례"), "직접 ask — 장부 실기록");
  ok(fs.existsSync(path.join(H, "proofs")) && fs.readdirSync(path.join(H, "proofs")).length >= 1, "직접 ask — proof 유지(실행 영수증 계약)");
}

console.log("[7] 배선 소스 계약 — 양 분기·flagVerdict machine·같은 통계 행·supersede");
{
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  const askBody = src.slice(src.indexOf("async function cmdAsk(rest)"), src.indexOf("function cmdLink"));
  ok((askBody.match(/machineFindingsLayer\(answer, ws, langSnap, profileSnap, harnessModeSnap, askId\)/g) || []).length === 2, "resume/new 양 분기가 같은 소비 계층 1곳을 지남(+askId 귀속 — 1차 blocker③)");
  ok(/source: askId \? String\(askId\) : "machine-2c"/.test(src), "장부 source=askId(실행 귀속·폴백 상수)");
  ok(/const vAlert = machine && machine\.effective \? machine\.effective : v;/.test(src) && /severity: vAlert === "fail"/.test(src), "경보 축=실효 판정 권위 — 강등된 실패가 빨강으로 병존하지 않음(1차 [주의] 동승)");
  ok(/\/\^\[a-z0-9-\]\{1,32\}\$\/\.test\(r\.error\) \? r\.error : "write-refused"/.test(src), "등록 실패 사유 키 — 짧은 키 화이트리스트(절대 잠금 경로 등 로컬 정보 비복사 · 2차 blocker③)");
  ok(/safeBacklogAutoFile\(f\.file\)/.test(src), "file 민감 방어 — 비경로 비밀형 거부 배선(2차 blocker③)");
  ok(/if \(m && m\.parse && m\.parse\.present && m\.parse\.ok\) verdictLine = m\.parse\.tailVerdictLine \|\| "";/.test(fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8")), "footer 'Codex 선언'도 tail 결속(2차 blocker①)");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/machine-verdict/.test(ext) && /기계 판독 강등·정정/.test(ext), "확장 경보 분류 — machine-verdict를 '근거 의심'과 분리(2차 [주의])");
  ok(/machine\.reasonKey !== "no-verdict-line"/.test(src), "자동 등록 게이트 — 블록 뒤 판정 존재 시에만(형태 깨진 답 무부작용)");
  ok((askBody.match(/formatForClaude\(answer, langSnap, profileSnap, mfl\.machine\)/g) || []).length === 2, "footer — 실효 판정으로 처리 의무 선택(양 분기)");
  ok((askBody.match(/flagVerdict\(answer, ws, [^,]+, modeSnap, mfl\.machine\)/g) || []).length === 2, "flagVerdict에 machine 전달(양 분기)");
  ok(/supersedeIntegrity\(session, "machine-verdict"\)/.test(src), "machine 경보 — 새 답마다 최신 1건 supersede 수명주기(2차 [주의])");
  ok(/machineEffective: machine\.effective, machineDemoted: !!machine\.demoted, machineCorrected: !!machine\.corrected/.test(src), "통계 — 같은 appendVerdict 행에 machine 필드 추가(이중 집계 없음)");
  ok(/if \(profileSnap !== "core"\) return \{ machine: null, notice: "" \};/.test(src), "core 게이트 — integrity·legacy 무회귀(null)");
  ok(/f\.tag !== "백로그"\) continue;/.test(src), "자동 등록 대상 — [백로그]만(동결 D-1)");
  const canon = CL.BASE_CORE.verifyBaseline;
  ok(canon.includes("[지적 목록 v1]") && canon.includes("[지적 목록 끝]") && /보류'로 강등한다\(fail-closed\)/.test(canon), "core 캐논 ko — 5) 블록 형식+강등 고지");
  ok(CL.BASE_CORE_EN.verifyBaseline.includes("[findings v1]") && CL.BASE_CORE_EN.verifyBaseline.includes("[findings end]"), "core 캐논 en — 5) 블록 형식");
  ok(/지적이 하나도 없으면 판정은 '검증: 통과'/.test(canon), "캐논 3) — 지적 0건=통과·비차단≥1=통과(보완) 정정(2차 [보완])");
  ok(/\[장부 자동 등록\]/.test(CL.BASE_CORE.rejudge) && /ledger auto-record/.test(CL.BASE_CORE_EN.rejudge), "재판단 규약 — 자동 등록 영수증 인용 의무로 개정");
  ok(/보고에는 선택지를 명시하세요: ① 추가 검증 승인 ② 이 상태로 두기 ③ 상한 변경\(다음 지시부터\)\./.test(src) && (src.match(/State the user's options in the report/g) || []).length >= 2, "동승 — 2b 마지막 왕복 예고 4벌에 선택지 3종 명시");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
