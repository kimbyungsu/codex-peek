/*
 * Phase 2 'DeepSeek 팔' — self 팔(scope-scout-self.js)과 **같은 결정론 꾸러미**를 DeepSeek(deepseek-bridge)로
 * 보내 영향범위 지도를 받는다(D5 A/B의 반대쪽 팔 — 같은 입력·같은 지시·같은 §5 형식).
 * 사용: node scripts/scope-scout-deepseek.js <repo경로> [--out <파일>]
 * ⚠ 외부 전송 발생 지점: 꾸러미(민감 범주 diff는 빌더가 사전 제외)가 DeepSeek API로 전송된다 —
 *   PRIVACY.md '외부로 나가는 것' 참조. 키 없으면 정직한 안내 후 종료(게이트 아님).
 * P5(2026-07-22): 파이프라인 본체는 scout-providers.js runScout("deepseek")로 이동 — 이 파일은 CLI 껍데기.
 * 브릿지 stderr(usage/오류 안내) 통과 전달·비트림 stdout 그대로 출력·--out 브릿지 위임은 구 러너 계약 그대로다.
 */
const path = require("path");
const { runScout } = require("./scout-providers.js");
const { loadLang } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const repo = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(EN 자동지시가 이 스크립트를 언급 — 감사 D)
if (!repo) { console.error(tB("사용: node scripts/scope-scout-deepseek.js <repo경로> [--out <파일>]","Usage: node scripts/scope-scout-deepseek.js <repo path> [--out <file>]")); process.exit(2); }

const res = runScout(repo, "deepseek", { outFile });
// usage/오류 안내는 브릿지 stderr를 그대로 전달(키 원문은 브릿지가 애초에 안 찍음 — 통과 출력이라 번역 대상 아님)
if (res.stderrPass) process.stderr.write(res.stderrPass);
if (!res.ok) {
  if (res.error.key === "not-git") { console.error(tB("git 저장소가 아니거나 git 실패","Not a git repository, or git failed")); process.exit(1); }
  console.error(tB("DeepSeek 탐색 호출 실패:","DeepSeek scout call failed:"), res.error.detail);
  process.exit(1);
}
if (res.saveErr) console.error(tB("지도 보관 실패(게시판에만 영향): ","Map archive failed (affects the board only): ") + res.saveErr);
else console.error(tB("지도 보관(게시판): ","Map archived (board): ") + res.savedNote);
process.stdout.write(res.rawStdout != null ? res.rawStdout : res.map);
