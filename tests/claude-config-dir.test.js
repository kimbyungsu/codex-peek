// CLAUDE_CONFIG_DIR 환경 적응 — 이슈#1의 CODEX_HOME 자동탐지와 '동일하게'.
// 해석 순서(확장): env CLAUDE_CONFIG_DIR → claude-home.txt(contract-inject 훅이 transcript_path로 자동탐지) → ~/.claude.
// ⚠ extension.ts/contract-inject.js는 vscode·훅 의존이라 동일 사양(순수 함수)을 실제 temp 폴더로 검증한다.
const assert = require("assert"), os = require("os"), path = require("path"), fs = require("fs");

// (A) 확장의 CLAUDE_HOME 해석 미러: env → pinned(실재 시) → ~/.claude. (CODEX_HOME과 동형)
function resolveClaudeHome(HOME, env, pinned) {
  return env || (pinned && fs.existsSync(pinned) ? pinned : "") || path.join(HOME, ".claude");
}
// (B) 훅(contract-inject)의 transcript_path → CLAUDE_HOME 도출 미러: <HOME>/projects/<proj>/<id>.jsonl → <HOME> (projects 구조 확인).
function deriveFromTranscript(tp) {
  if (!tp) return "";
  const projectsDir = path.dirname(path.dirname(tp));
  if (path.basename(projectsDir) !== "projects") return "";
  return path.dirname(projectsDir);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccd_"));
const HOME = path.join(dir, "home");
const ALT = path.join(dir, "alt"); // CLAUDE_CONFIG_DIR / pinned 후보
fs.mkdirSync(ALT, { recursive: true });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 1. env·pinned 둘 다 없음 → ~/.claude (무회귀)
ok(resolveClaudeHome(HOME, "", "") === path.join(HOME, ".claude"), "env·pinned 없음 → ~/.claude (무회귀)");
// 2. env 설정 → 최우선
ok(resolveClaudeHome(HOME, ALT, "") === ALT, "env 설정 → CLAUDE_CONFIG_DIR 최우선");
// 3. ★env 없고 pinned(실재) → 훅 탐지값 사용 = 확장이 env를 못 봐도 동작(이번 갭의 핵심)
ok(resolveClaudeHome(HOME, "", ALT) === ALT, "env 없고 claude-home.txt(실재) → 훅 자동탐지값 사용(env 비가시 환경 구제)");
// 4. pinned 경로가 실재 안 함 → ~/.claude 폴백(유령 pin 무시)
ok(resolveClaudeHome(HOME, "", path.join(dir, "ghost")) === path.join(HOME, ".claude"), "pinned 경로 부재 → ~/.claude (유령 pin 무시)");
// 5. env가 pinned보다 우선
ok(resolveClaudeHome(HOME, ALT, path.join(dir, "other")) === ALT, "env가 pinned보다 우선");

// 6. 훅 도출: 정상 transcript 구조 → CLAUDE_HOME (= projects의 부모)
ok(deriveFromTranscript(path.join(ALT, "projects", "encoded-cwd", "sess.jsonl")) === ALT, "transcript_path(.../projects/<p>/<id>.jsonl) → CLAUDE_HOME 도출");
// 7. projects 구조 아님 / 빈 입력 → 도출 안 함(엉뚱 기록 방지)
ok(deriveFromTranscript(path.join(ALT, "weird", "x.jsonl")) === "", "projects 구조 아니면 도출 안 함");
ok(deriveFromTranscript("") === "", "transcript 없으면 도출 안 함");

// 8. ★런타임 적응(Codex 지적 반영): 확장이 매 읽기마다 claude-home.txt를 재해석하므로, 활성화 후 훅이 처음 기록해도 reload 없이 반영.
//    같은 resolver를 '파일 쓰기 전/후'로 호출해 잠근다(정적 const였으면 쓰기 전 값에 고정됨).
const lateHome = path.join(dir, "late"); fs.mkdirSync(lateHome, { recursive: true });
const chf = path.join(dir, "claude-home-late.txt");
const dyn = () => resolveClaudeHome(HOME, "", fs.existsSync(chf) ? fs.readFileSync(chf, "utf8").trim() : "");
ok(dyn() === path.join(HOME, ".claude"), "런타임 적응: claude-home.txt 생성 전엔 ~/.claude");
fs.writeFileSync(chf, lateHome); // 활성화 뒤 훅이 처음 기록한 상황
ok(dyn() === lateHome, "런타임 적응: claude-home.txt 생성 후 같은 resolver가 즉시 그 값 사용(reload 불필요)");

console.log("claude-config-dir: " + n + " assertions passed");
