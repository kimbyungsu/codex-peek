/*
 * Phase 2 'self 팔' — 결정론 꾸러미를 **구현 대화와 분리된 Claude 1회 호출**에 먹여 영향범위 지도를 받는다(D5 A/B의 무비용 팔).
 * 사용: node scripts/scope-scout-self.js <repo경로> [--out <파일>]
 * P5(2026-07-22): 파이프라인 본체(수집→호출→장부→보관→관측)는 scout-providers.js runScout("self")로 이동 —
 * 이 파일은 CLI 껍데기(인자 파싱+메시지·exit 재구성)만 남는다. 공정성 계약(D2)·도구 차단(DENY)·무과금 조건은
 * providers의 self 어댑터가 그대로 보유한다.
 */
const path = require("path");
const { runScout } = require("./scout-providers.js");
const { loadLang } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const repo = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(EN 자동지시가 이 스크립트 실행을 지시 — 감사 D)
if (!repo) { console.error(tB("사용: node scripts/scope-scout-self.js <repo경로> [--out <파일>]","Usage: node scripts/scope-scout-self.js <repo path> [--out <file>]")); process.exit(2); }

const res = runScout(repo, "self", { outFile });
if (!res.ok) {
  if (res.error.key === "not-git") { console.error(tB("git 저장소가 아니거나 git 실패","Not a git repository, or git failed")); process.exit(1); }
  console.error(tB("self 탐색 호출 실패:","self scout call failed:"), res.error.detail);
  process.exit(1);
}
// 대시보드 '영향지도 게시판' 보관 결과 알림 — stderr(stdout=지도 본문 유지, 구 러너와 같은 문구)
if (res.saveErr) console.error(tB("지도 보관 실패(게시판에만 영향): ","Map archive failed (affects the board only): ") + res.saveErr);
else console.error(tB("지도 보관(게시판): ","Map archived (board): ") + res.savedNote);
process.stdout.write(res.map + "\n");
