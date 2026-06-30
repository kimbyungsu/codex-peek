/*
 * appendVerdict — 검증 1건을 stats/verdicts.jsonl에 append-only로 누적(대시보드 탭2 통계 재료).
 * integrity는 '최신 상태'(통과 안 남김·supersede)라 통계가 안 되므로 별도 로그에 쌓는다. 원문 저장 안 하고 메타만.
 */
const os = require("os"), path = require("path"), fs = require("fs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vstat_"));
process.env.CODEX_BRIDGE_HOME = path.join(dir, ".bridge"); // require 전 — 실제 ~/.codex-bridge 오염 방지
const cl = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const VF = cl.VERDICTS_FILE;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const lines = () => { try { return fs.readFileSync(VF, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

console.log("[append] 검증 1건 → 1줄");
cl.appendVerdict({ ts: "t1", workspace: "/ws", claudeSession: "C1", codexSession: "X1", verdict: "pass", answerChars: 100 });
ok(lines().length === 1, "1건 append → 1줄");
ok(lines()[0].verdict === "pass" && lines()[0].workspace === "/ws", "메타 정확(verdict/workspace)");

console.log("[누적] 여러 건 → 줄 쌓임(integrity처럼 supersede/상한으로 안 지움)");
cl.appendVerdict({ ts: "t2", workspace: "/ws", claudeSession: "C1", codexSession: "X1", verdict: "fail", answerChars: 50 });
cl.appendVerdict({ ts: "t3", workspace: "/ws", claudeSession: "C1", codexSession: "X1", verdict: "pass-notes", answerChars: 80 });
ok(lines().length === 3, "3건 → 3줄(누적, 안 지움)");
ok(lines().map((l) => l.verdict).join(",") === "pass,fail,pass-notes", "순서·verdict 보존");

console.log("[원문 미저장] 메타만(prompt/answer 본문 없음)");
const keys = Object.keys(lines()[0]).sort().join(",");
ok(keys === "answerChars,claudeSession,codexSession,ts,verdict,workspace", "메타 키만(원문 필드 없음)");

console.log("[best-effort] 잘못된 입력에도 검증 흐름 안 막음(throw 안 함)");
let threw = false;
try { cl.appendVerdict(undefined); } catch { threw = true; }
ok(!threw, "appendVerdict(undefined)도 throw 안 함(best-effort)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
