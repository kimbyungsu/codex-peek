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
const { saveMap } = require("./scout-store.js");
const { renderPackageMarkdown } = require(path.join(__dirname, "..", "out", "scope-package.js"));

const repo = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
if (!repo) { console.error("사용: node scripts/scope-scout-self.js <repo경로> [--out <파일>]"); process.exit(2); }

const pkg = collectPackage(repo);
if (!pkg) { console.error("git 저장소가 아니거나 git 실패"); process.exit(1); }
const md = renderPackageMarkdown(pkg);

// 탐색 전용 1회 호출 — 파일 탐색 도구 전면 차단(꾸러미 밖을 못 보게 = DeepSeek 팔과 동일 시야).
const DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";
const preface = "너는 '탐색자'다. 아래 꾸러미가 유일한 근거다 — 도구는 차단되어 있고, 꾸러미 밖 추측으로 파일을 지어내지 마라. 꾸러미 끝의 [탐색자 지시] 형식을 정확히 따르라.\n\n";
const r = spawnSync("claude", ["-p", "--output-format", "text", "--disallowedTools", DENY], {
  input: preface + md,
  encoding: "utf8",
  timeout: 8 * 60 * 1000,
  windowsHide: true,
  shell: process.platform === "win32", // npm 전역 셔틀(claude.cmd) 대응
});
if (r.error || r.status !== 0 || !String(r.stdout || "").trim()) {
  console.error("self 탐색 호출 실패:", r.error?.message || `exit=${r.status}`, String(r.stderr || "").slice(-300));
  process.exit(1);
}
const map = r.stdout.trim();
if (outFile) fs.writeFileSync(outFile, map);
// 대시보드 '영향지도 게시판'용 보관(브릿지 홈 scouts/ — 프로젝트별 최근 10장). stderr로 알림(stdout=지도 본문 유지).
// 메타에 basis·seedFiles 기록 — 물때표(다음 지도의 기준)와 무이력 낡음 배지의 재료(멀티 세션 오인 방지 — Codex 보완).
try { console.error("지도 보관(게시판): " + saveMap(repo, "self", map, { basis: pkg.basisNote || (pkg.historyless ? "" : "git-status"), seedFiles: pkg.seeds })); } catch (e) { console.error("지도 보관 실패(게시판에만 영향): " + (e && e.message)); }
process.stdout.write(map + "\n");
