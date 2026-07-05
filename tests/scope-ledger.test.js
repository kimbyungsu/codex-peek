/*
 * 범위 장부 L0(src/scope-ledger.ts → out/scope-ledger.js) — git 이력 co-change 채굴.
 * 설계(에이전트 활용/SCOPE-LEDGER.md): 결정론 발견·표본 게이트(빈약하면 침묵)·기계 커밋 필터·최근성 감쇠.
 * ※ out/scope-ledger.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const { parseGitLog, isMechanicalCommit, isNoiseFile, suggest, retroEvaluate } = require(path.join(__dirname, "..", "out", "scope-ledger.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const DAY = 864e5;
const NOW = Date.parse("2026-07-05T00:00:00Z");
const sec = (ms) => Math.floor(ms / 1000);
// git log --pretty=format:%H|%ct|%s --name-only 형태의 픽스처 생성기
const C = (hash, daysAgo, subject, files) => [`${hash}|${sec(NOW - daysAgo * DAY)}|${subject}`, ...files].join("\n");

console.log("[parseGitLog] 헤더|파일들|빈 줄 구분 파싱 + 경로 정규화");
const logText = [
  C("aaaa111", 1, "feat: A", ["src\\Extension.ts", "bridge/codex-bridge.js"]),
  "",
  C("bbbb222", 2, "fix: B", ["./src/extension.ts", "README.md"]),
].join("\n");
const cs = parseGitLog(logText);
ok(cs.length === 2 && cs[0].files[0] === "src/extension.ts" && cs[1].files[0] === "src/extension.ts", "2커밋 · 백슬래시/./ 접두 · 대소문자 정규화");
ok(cs[0].ts === NOW - 1 * DAY && cs[0].subject === "feat: A", "ts(ms)·subject 파싱");

console.log("[기계 커밋] 릴리스 제목·버전/lock 전용 커밋은 결합 증거에서 제외");
ok(isMechanicalCommit({ hash: "x", ts: 0, subject: "chore(release): v0.1.76", files: ["a.ts"] }), "chore(release) 제목");
ok(isMechanicalCommit({ hash: "x", ts: 0, subject: "정리", files: ["package.json", "package-lock.json"] }), "버전·lock 전용 파일 커밋");
ok(!isMechanicalCommit({ hash: "x", ts: 0, subject: "feat: 기능", files: ["src/a.ts", "package.json"] }), "일반 커밋(버전 파일 동반)은 커밋 자체는 유효");
ok(isNoiseFile("package.json") && isNoiseFile("dist/x.js") && !isNoiseFile("src/a.ts"), "후보 단계에서 버전/산출물 파일은 소음으로 제외");

console.log("[suggest] 동반 빈도×최근성 랭킹 + 표본수 게이트");
const mk = (n, daysAgo, files) => ({ hash: "h" + n, ts: NOW - daysAgo * DAY, subject: "feat: " + n, files: files.map((f) => f.toLowerCase()) });
const commits = [
  mk(1, 1, ["src/a.ts", "src/b.ts", "docs/readme.md"]),
  mk(2, 3, ["src/a.ts", "src/b.ts"]),
  mk(3, 5, ["src/a.ts", "src/b.ts", "tests/a.test.js"]),
  mk(4, 7, ["src/a.ts", "tests/a.test.js"]),
  mk(5, 9, ["src/a.ts", "tests/a.test.js"]),
  mk(6, 11, ["src/z.ts", "src/b.ts"]), // seed 무관 커밋
  { hash: "rel", ts: NOW - 2 * DAY, subject: "chore(release): v1", files: ["src/a.ts", "package.json", "readme.md"] }, // 기계 — 제외돼야
];
const s1 = suggest(commits, ["src/a.ts"], { nowMs: NOW });
ok(!s1.sparse && s1.seedObservations === 5, "seed 관측 5회(기계 커밋 제외)");
ok(s1.candidates.length === 2 && s1.candidates[0].file === "src/b.ts" && s1.candidates[0].n === 3, "b.ts(n=3, 최근) 1위 — 최근성 가중");
ok(s1.candidates[1].file === "tests/a.test.js" && s1.candidates[1].n === 3, "테스트 파일 동반(n=3) 2위");
ok(!s1.candidates.some((c) => c.file === "docs/readme.md"), "n=1(<minN=3) 후보는 게이트에 걸러짐");
ok(!s1.candidates.some((c) => c.file === "package.json"), "릴리스 커밋의 package.json 동반은 애초에 미집계");

console.log("[침묵 게이트] 신생 영역(표본<3) → 후보 0 + sparse 플래그(오탐 대신 정직한 침묵)");
const s2 = suggest(commits, ["src/새폴더/new.ts"], { nowMs: NOW });
ok(s2.sparse === true && s2.candidates.length === 0 && s2.seedObservations === 0, "관측 0 → sparse·후보 없음");
const s3 = suggest([mk(1, 1, ["src/y.ts", "src/x.ts"]), mk(2, 2, ["src/y.ts", "src/x.ts"])], ["src/y.ts"], { nowMs: NOW });
ok(s3.sparse === true, "관측 2(<3) → 여전히 침묵(약한 데이터를 강한 조언처럼 안 보임)");

console.log("[최근성 감쇠] 같은 n이면 최근 동반이 위 — '신규 정보로 교체' 자동");
const rc = [
  mk(1, 1, ["s.ts", "recent.ts"]), mk(2, 2, ["s.ts", "recent.ts"]), mk(3, 3, ["s.ts", "recent.ts"]),
  mk(4, 300, ["s.ts", "old.ts"]), mk(5, 301, ["s.ts", "old.ts"]), mk(6, 302, ["s.ts", "old.ts"]),
];
const sr = suggest(rc, ["s.ts"], { nowMs: NOW });
ok(sr.candidates[0].file === "recent.ts" && sr.candidates[1].file === "old.ts", "n 동률(3:3)에서 최근 쪽 승리");

console.log("[초대형 커밋 제외] 전면 포맷팅류(파일 수>상한)는 결합 증거로 안 씀");
const big = mk(9, 1, ["s2.ts", ...Array.from({ length: 40 }, (_, i) => `f${i}.ts`)]);
const sb = suggest([big, mk(1, 1, ["s2.ts", "pair.ts"]), mk(2, 2, ["s2.ts", "pair.ts"]), mk(3, 3, ["s2.ts", "pair.ts"])], ["s2.ts"], { nowMs: NOW });
ok(sb.seedObservations === 3 && sb.candidates[0].file === "pair.ts", "40파일 커밋 무시·정상 쌍만 채굴");

console.log("[retroEvaluate] 소급 평가 — 미래 누출 없이 '그때 과거'만으로 정답 재현");
// 패턴: a.ts와 b.ts가 늘 함께(6회) → 최신 커밋을 평가하면 과거 5회로 top 후보에 b.ts가 있어야 hit
const hist = Array.from({ length: 6 }, (_, i) => mk(i, i * 2 + 1, ["src/a.ts", "src/b.ts"]));
const r = retroEvaluate(hist, { maxEvals: 3 });
ok(r.evals === 3 && r.pairs > 0, "평가 커밋 3건 수행");
ok(r.hitAt10 > 0.9 && r.hitAt5 > 0.9, "일관된 쌍 → hit@5/@10 ≈ 1");
ok(r.missNever < 0.1, "치명 누락 근사 ≈ 0");
// 무관 파일들만 있는 이력 → sparse 지배
const rnd = Array.from({ length: 8 }, (_, i) => mk(i, i + 1, [`src/u${i}.ts`, `src/v${i}.ts`]));
const r2 = retroEvaluate(rnd, { maxEvals: 4 });
ok(r2.sparseRate > 0.9 && r2.hitAt10 === 0, "이력 없는 쌍 → 침묵(sparse)로 처리, 거짓 hit 없음");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
