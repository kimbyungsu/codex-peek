/*
 * SCOPE-LEDGER S0 소급 실측 — "그때의 변경에서, 함께 바뀐 파일들이 (그 시점 과거 이력만으로 만든) 후보 상위에 들었나".
 * 사용: node scripts/scope-retro.js <repo경로> [평가건수]
 * 지표: hit@5/@10(정답 동반파일이 상위 후보에 든 쌍 비율) · missNever(후보에 아예 없던 비율=치명 누락 근사)
 *      · sparseRate(표본 부족 침묵 비율) · precisionProxy@10(상위 후보 중 이번 정답 비율 — 소음률의 보수적 근사).
 * 성공/중단 기준(SCOPE-LEDGER.md §8 사전 등록): hit@10 ≥ 60% & 소음 근사 관찰, top-5 보조, 치명 누락 ≈ 0 지향.
 */
const path = require("path");
const { spawnSync } = require("child_process");
const { parseGitLog, retroEvaluate } = require(path.join(__dirname, "..", "out", "scope-ledger.js"));

const repo = process.argv[2];
const maxEvals = Number(process.argv[3] || 40);
if (!repo) { console.error("사용: node scripts/scope-retro.js <repo경로> [평가건수]"); process.exit(2); }

const r = spawnSync("git", ["-C", repo, "log", "--no-merges", "--first-parent", "--pretty=format:%H|%ct|%s", "--name-only", "-n", "500"], { encoding: "utf8", timeout: 30000 });
if (r.status !== 0 || r.error) { console.error("git log 실패:", r.error?.message || r.stderr); process.exit(1); }
const commits = parseGitLog(r.stdout);
const res = retroEvaluate(commits, { maxEvals });
const pct = (x) => (x * 100).toFixed(1) + "%";
console.log(`[${repo}] 커밋 ${commits.length}개 로드 · 평가 ${res.evals}건(파일쌍 ${res.pairs})`);
console.log(`  hit@5  = ${pct(res.hitAt5)}   (정답 동반파일이 상위 5 후보에 든 비율)`);
console.log(`  hit@10 = ${pct(res.hitAt10)}   ← 사전 등록 기준: ≥60%`);
console.log(`  치명누락(후보에 아예 없음) = ${pct(res.missNever)}`);
console.log(`  sparse(표본부족 침묵)      = ${pct(res.sparseRate)}`);
console.log(`  precision proxy@10         = ${pct(res.precisionProxyAt10)}  (소음률 상한 근사 — 후보가 이번에 안 바뀌었어도 확인가치 있을 수 있음)`);
console.log(`  ── 예측가능 부분집합(기술 성능): target이 그 시점 이력에 존재 + seed 비-sparse ──`);
console.log(`  예측가능 쌍 = ${res.pairsPredictable} (전체 ${res.pairs}의 ${pct(res.pairs ? res.pairsPredictable / res.pairs : 0)})`);
console.log(`  hit@5|predictable  = ${pct(res.hitAt5Predictable)}`);
console.log(`  hit@10|predictable = ${pct(res.hitAt10Predictable)}  ← L0이 '원리상 잡을 수 있는 것'을 잡는 비율`);
