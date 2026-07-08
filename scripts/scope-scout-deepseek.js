/*
 * Phase 2 'DeepSeek 팔' — self 팔(scope-scout-self.js)과 **같은 결정론 꾸러미**를 DeepSeek(deepseek-bridge)로
 * 보내 영향범위 지도를 받는다(D5 A/B의 반대쪽 팔 — 같은 입력·같은 지시·같은 §5 형식).
 * 사용: node scripts/scope-scout-deepseek.js <repo경로> [--out <파일>]
 * ⚠ 외부 전송 발생 지점: 꾸러미(민감 범주 diff는 빌더가 사전 제외)가 DeepSeek API로 전송된다 —
 *   PRIVACY.md '외부로 나가는 것' 참조. 키 없으면 정직한 안내 후 종료(게이트 아님).
 */
const path = require("path");
const { spawnSync } = require("child_process");
const { collectPackage } = require("./scope-package.js");
const { saveMap, markLive, clearLive } = require("./scout-store.js");
const { extractMapHighlights, extractMapPatches, appendLedgerEvent, ledgerSig, scoutPromptSignature, loadLang, appendScoutUsage } = require(path.join(__dirname, "..", "bridge", "contract-lib.js")); // 지도 high 구조화(Phase 3) + 프롬프트 서명(§6-11 P4) + 비용 장부
const { renderPackageMarkdown } = require(path.join(__dirname, "..", "out", "scope-package.js"));

const repo = process.argv[2];
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(EN 자동지시가 이 스크립트를 언급 — 감사 D)
if (!repo) { console.error(tB("사용: node scripts/scope-scout-deepseek.js <repo경로> [--out <파일>]","Usage: node scripts/scope-scout-deepseek.js <repo path> [--out <file>]")); process.exit(2); }

const pkg = collectPackage(repo);
if (!pkg) { console.error(tB("git 저장소가 아니거나 git 실패","Not a git repository, or git failed")); process.exit(1); }
const lang = loadLang(); // 지도 '원문' 언어 — 전역 언어를 따름(preface는 브릿지 buildMapRequest가 같은 슬롯에서 읽음)
const md = renderPackageMarkdown(pkg, lang);

// 브릿지는 repo 정본을 직접 실행(개발용 스크립트 — 설치본(~/.codex-bridge)과의 버전 드리프트 회피).
const bridge = path.join(__dirname, "..", "bridge", "deepseek-bridge.js");
const args = [bridge, "map"];
if (outFile) args.push("--out", outFile);
markLive(repo, "deepseek"); // 상태바 '지도 생성중…' 신호 — 전송·수신 동안만(finally에서 해제)
let r;
try {
  r = spawnSync(process.execPath, args, { input: md, encoding: "utf8", timeout: 5 * 60 * 1000, windowsHide: true });
} finally { clearLive(repo); }
// usage/오류 안내는 브릿지 stderr를 그대로 전달(키 원문은 브릿지가 애초에 안 찍음 — 통과 출력이라 번역 대상 아님)
if (r.stderr) process.stderr.write(r.stderr);
if (r.error || r.status !== 0) { console.error(tB("DeepSeek 탐색 호출 실패:","DeepSeek scout call failed:"), (r.error && r.error.message) || `exit=${r.status}`); process.exit(1); }
// 대시보드 '영향지도 게시판'용 보관 — 브릿지가 stderr로 알려준 사용량 메타([usage] in=.. out=.. (모델))를 함께 기록.
const um = String(r.stderr || "").match(/\[usage\] in=(\d+) out=(\d+)(?: \((.+?)\))?/);
const meta = um ? { usageIn: Number(um[1]), usageOut: Number(um[2]), model: um[3] || null } : {};
// 비용 장부 기록(60일 보존) — 지도 메타는 최근 10장 프루닝으로 사라지므로 별도 장부에 누적(60일 · 사용자 비용 추정용)
try { appendScoutUsage({ ts: new Date().toISOString(), workspace: repo, arm: "deepseek", model: meta.model || null, usageIn: meta.usageIn ?? null, usageOut: meta.usageOut ?? null, pkgChars: md.length, mapChars: r.stdout.length }); } catch { /* 무해 */ }
try { console.error(tB("지도 보관(게시판): ","Map archived (board): ") + saveMap(repo, "deepseek", r.stdout.trim(), { ...meta, ...scoutPromptSignature(lang), highlights: extractMapHighlights(r.stdout), mapPatches: extractMapPatches(r.stdout), basis: pkg.basisNote || (pkg.historyless ? "" : "git-status"), seedFiles: pkg.seeds })); } catch (e) { console.error(tB("지도 보관 실패(게시판에만 영향): ","Map archive failed (affects the board only): ") + (e && e.message)); }
// 관측 장부: 지도가 낸 6번(MAP patch) 제안을 사실로 적재 — 상태 전이는 out/ledger-events.js가 유도(로드맵 1단계)
try { const now = new Date().toISOString(); for (const t of extractMapPatches(r.stdout)) appendLedgerEvent(repo, { ts: now, type: "proposed", sig: ledgerSig(t), text: t, from: "deepseek 지도 " + now }); } catch { /* 장부 실패가 지도 출력 흐름을 막지 않음 */ }
process.stdout.write(r.stdout);
