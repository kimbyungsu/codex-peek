/*
 * P6 'Codex 팔'(2026-07-22) — self·DeepSeek 팔과 **같은 결정론 꾸러미**를 Codex(독립 codex exec 1회)에 먹여
 * 영향범위 지도를 받는다. 검증 세션과 완전히 분리된 새 세션이며(resume 아님), 빈 임시 폴더에서 실행된다.
 * 사용: node scripts/scope-scout-codex.js <repo경로> [--out <파일>]
 * 파이프라인 본체는 scout-providers.js runScout("codex") — 이 파일은 CLI 껍데기(self 러너와 동형).
 * 통신은 codex CLI 자체의 동작(사용자의 codex 계정·PRIVACY '외부로 나가는 것' 원리 문단 참조).
 */
const path = require("path");
const { runScout } = require("./scout-providers.js");
const { loadLang } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const repo = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(EN 자동지시가 이 스크립트 실행을 지시 — 감사 D)
if (!repo) { console.error(tB("사용: node scripts/scope-scout-codex.js <repo경로> [--out <파일>]","Usage: node scripts/scope-scout-codex.js <repo path> [--out <file>]")); process.exit(2); }

const res = runScout(repo, "codex", { outFile });
if (!res.ok) {
  if (res.error.key === "not-git") { console.error(tB("git 저장소가 아니거나 git 실패","Not a git repository, or git failed")); process.exit(1); }
  console.error(tB("Codex 탐색 호출 실패:","Codex scout call failed:"), res.error.detail);
  process.exit(1);
}
if (res.saveErr) console.error(tB("지도 보관 실패(게시판에만 영향): ","Map archive failed (affects the board only): ") + res.saveErr);
else console.error(tB("지도 보관(게시판): ","Map archived (board): ") + res.savedNote);
process.stdout.write(res.map + "\n");
