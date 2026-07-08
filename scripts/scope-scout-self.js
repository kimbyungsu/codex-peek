/*
 * Phase 2 'self 팔' — 결정론 꾸러미를 **구현 대화와 분리된 Claude 1회 호출**에 먹여 영향범위 지도를 받는다(D5 A/B의 무비용 팔).
 * 사용: node scripts/scope-scout-self.js <repo경로> [--out <파일>]
 * 공정성 계약(D2 프롬프트형): 탐색자는 꾸러미'만' 근거로 답해야 한다 — 파일 탐색 도구를 CLI 옵션으로 차단하고
 *   (DeepSeek 팔과 같은 입력 조건), 지시문에도 명시한다. 모델은 사용자의 Claude Code 기본 모델을 그대로 쓴다(추가 과금 없음·구독).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { collectPackage } = require("./scope-package.js");
const { saveMap, markLive, clearLive } = require("./scout-store.js");
const { extractMapHighlights, extractMapPatches, appendLedgerEvent, ledgerSig, buildScoutPreface, scoutPromptSignature, loadLang, appendScoutUsage } = require(path.join(__dirname, "..", "bridge", "contract-lib.js")); // 지도 high 구조화(Phase 3) + 프롬프트 단일 출처(§6-11) + 비용 장부
const { renderPackageMarkdown } = require(path.join(__dirname, "..", "out", "scope-package.js"));

const repo = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(EN 자동지시가 이 스크립트 실행을 지시 — 감사 D)
if (!repo) { console.error(tB("사용: node scripts/scope-scout-self.js <repo경로> [--out <파일>]","Usage: node scripts/scope-scout-self.js <repo path> [--out <file>]")); process.exit(2); }

const pkg = collectPackage(repo);
if (!pkg) { console.error(tB("git 저장소가 아니거나 git 실패","Not a git repository, or git failed")); process.exit(1); }
const lang = loadLang(); // 지도 '원문' 언어 — 전역 언어를 따름(§6-8 후속(c) 해소)
const md = renderPackageMarkdown(pkg, lang);

// 탐색 전용 1회 호출 — 파일 탐색 도구 전면 차단(꾸러미 밖을 못 보게 = DeepSeek 팔과 동일 시야).
const DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";
const preface = buildScoutPreface("self", lang) + "\n\n"; // 태도층 슬롯(사용자 편집 가능) + self 팔 도구 차단 각주 — 단일 출처(§6-11 P1)
markLive(repo, "self"); // 상태바 '지도 생성중…' 신호 — 탐색자 호출 동안만(finally에서 해제)
let r;
try {
  r = spawnSync("claude", ["-p", "--output-format", "text", "--disallowedTools", DENY], {
    input: preface + md,
    encoding: "utf8",
    timeout: 8 * 60 * 1000,
    windowsHide: true,
    shell: process.platform === "win32", // npm 전역 셔틀(claude.cmd) 대응
  });
} finally { clearLive(repo); }
if (r.error || r.status !== 0 || !String(r.stdout || "").trim()) {
  console.error(tB("self 탐색 호출 실패:","self scout call failed:"), r.error?.message || `exit=${r.status}`, String(r.stderr || "").slice(-300));
  process.exit(1);
}
const map = r.stdout.trim();
// 비용 장부 기록(60일 보존) — self 팔(claude -p text)은 토큰을 안 알려줘 usage는 null, 문자수(입력 꾸러미·출력 지도)만
// 추정 재료로 기록(정직: 토큰 아님). 실측 토큰은 --output-format json 전환 시 후속(HANDOFF §6-12).
try { appendScoutUsage({ ts: new Date().toISOString(), workspace: repo, arm: "self", model: null, usageIn: null, usageOut: null, pkgChars: (preface + md).length, mapChars: map.length }); } catch { /* 무해 */ }
if (outFile) fs.writeFileSync(outFile, map);
// 대시보드 '영향지도 게시판'용 보관(브릿지 홈 scouts/ — 프로젝트별 최근 10장). stderr로 알림(stdout=지도 본문 유지).
// 메타에 basis·seedFiles 기록 — 물때표(다음 지도의 기준)와 무이력 낡음 배지의 재료(멀티 세션 오인 방지 — Codex 보완).
try { console.error(tB("지도 보관(게시판): ","Map archived (board): ") + saveMap(repo, "self", map, { ...scoutPromptSignature(lang), highlights: extractMapHighlights(map), mapPatches: extractMapPatches(map), basis: pkg.basisNote || (pkg.historyless ? "" : "git-status"), seedFiles: pkg.seeds })); } catch (e) { console.error(tB("지도 보관 실패(게시판에만 영향): ","Map archive failed (affects the board only): ") + (e && e.message)); }
// 관측 장부: 지도가 낸 ⑥(MAP patch) 제안을 사실로 적재 — 상태 전이는 out/ledger-events.js가 유도(로드맵 ①단계)
try { const now = new Date().toISOString(); for (const t of extractMapPatches(map)) appendLedgerEvent(repo, { ts: now, type: "proposed", sig: ledgerSig(t), text: t, from: "self 지도 " + now }); } catch { /* 장부 실패가 지도 출력 흐름을 막지 않음 */ }
process.stdout.write(map + "\n");
