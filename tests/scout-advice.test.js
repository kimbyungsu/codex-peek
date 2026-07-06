/*
 * 탐색(3트랙) 자동 지시(bridge/contract-lib.js buildScoutDirective) + 생성중 신호(scripts/scout-store.js) 동작 테스트.
 * 핵심 계약: ①지시는 '상태 서명'(지도 없음|최신 지도 이름) 기준 1회 — 시간 상수 0 ②지도가 갱신되면 서명이 바뀌어
 * 다음 낡음에 다시 1회 ③2트랙=지시 0 ④키 등록 시에만 DeepSeek 팔 언급(동의 모델) ⑤생성중 신호는 mark~clear 동안만.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

// 임시 브릿지 홈 격리 — require 전에 env(모듈 상수 고정)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "scout-advice-"));
process.env.CODEX_BRIDGE_HOME = tmpHome;
const lib = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const store = require(path.join(__dirname, "..", "scripts", "scout-store.js"));

// 가짜 프로젝트 폴더 + seed 파일
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "scout-advice-repo-"));
fs.writeFileSync(path.join(repo, "a.md"), "내용");
const cOn = { scoutMode: "on" };
const cOff = { scoutMode: "off" };

console.log("[지시 발화] 지도 없음 → 이 상태에 1회만");
const d1 = lib.buildScoutDirective(repo, cOn);
ok(!!d1 && /영향지도가 아직 없다/.test(d1) && /scope-scout-self\.js/.test(d1), "첫 지시: 지도 없음 사유 + self 팔 명령");
ok(/아무것도 막지 않는다/.test(d1) && /스킵해도 된다/.test(d1), "advisory 명시(게이트 아님·재량 허용)");
ok(!/deepseek/i.test(d1), "키 없으면 DeepSeek 팔 언급 없음(동의 모델)");
ok(lib.buildScoutDirective(repo, cOn) === null, "같은 상태(no-map) 재호출 → 재지시 없음(지시 피로 방지)");
ok(lib.buildScoutDirective(repo, cOff) === null, "2트랙이면 어떤 상태든 지시 없음(무회귀)");

console.log("[서명 갱신] 지도가 생기면 fresh → 침묵, seed가 더 바뀌면 stale → 새 서명으로 다시 1회");
store.saveMap(repo, "self", "# 지도", { seedFiles: ["a.md"] });
ok(lib.buildScoutDirective(repo, cOn) === null, "신선한 지도 → 지시 없음");
const st1 = lib.scoutMapStatus(repo);
ok(st1.state === "fresh" && !!st1.base, "상태 판독: fresh + 최신 지도 이름");
// 지도 메타 ts를 과거로 조작 → seed(a.md)가 지도 이후 수정된 것으로(낡음)
const dir = path.join(store.SCOUTS_DIR, store.wsKeyFor(repo));
const metaFile = fs.readdirSync(dir).find((f) => f.endsWith(".json"));
const meta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), "utf8"));
meta.ts = new Date(Date.now() - 3600 * 1000).toISOString();
fs.writeFileSync(path.join(dir, metaFile), JSON.stringify(meta));
const d2 = lib.buildScoutDirective(repo, cOn);
ok(!!d2 && /낡았다/.test(d2) && /1개가 더 바뀌어/.test(d2), "낡음 감지: 지도 자신의 근거 파일 기준(멀티 세션 오인 없음)");
ok(lib.buildScoutDirective(repo, cOn) === null, "같은 낡음 서명 재호출 → 재지시 없음");

console.log("[DeepSeek 동의 모델] 키 등록 시에만 비교 팔 언급");
fs.writeFileSync(path.join(tmpHome, "deepseek.json"), JSON.stringify({ apiKey: "sk-fake00fixture00fixture00" }));
store.saveMap(repo, "self", "# 지도2", { seedFiles: ["a.md"] }); // 새 지도 → 서명 리셋
const metaFile2 = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse()[0];
const meta2 = JSON.parse(fs.readFileSync(path.join(dir, metaFile2), "utf8"));
meta2.ts = new Date(Date.now() - 3600 * 1000).toISOString();
fs.writeFileSync(path.join(dir, metaFile2), JSON.stringify(meta2));
const d3 = lib.buildScoutDirective(repo, cOn);
ok(!!d3 && /scope-scout-deepseek\.js/.test(d3) && /키 등록=자동 호출 동의됨/.test(d3), "키 있으면 DeepSeek 팔 옵션+동의 근거 명시");

console.log("[생성중 신호] mark~clear 동안만 존재 + 러너 배선(소스 계약)");
store.markLive(repo, "self");
ok(fs.existsSync(path.join(store.LIVE_DIR, store.wsKeyFor(repo) + ".json")), "mark → 신호 파일 생성");
store.clearLive(repo);
ok(!fs.existsSync(path.join(store.LIVE_DIR, store.wsKeyFor(repo) + ".json")), "clear → 신호 파일 제거");
const selfSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-self.js"), "utf8");
const dsSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-deepseek.js"), "utf8");
ok(/markLive\(repo, "self"\)/.test(selfSrc) && /finally \{ clearLive\(repo\); \}/.test(selfSrc), "self 러너: 호출 직전 mark·finally clear");
ok(/markLive\(repo, "deepseek"\)/.test(dsSrc) && /finally \{ clearLive\(repo\); \}/.test(dsSrc), "DeepSeek 러너: 동일 배선");

console.log("[확장·훅 배선] 상태바 생성중 라벨·카드 반영·훅 주입(소스 계약)");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/readScoutLive/.test(ext) && /SCOUT_LIVE_TTL_MS = 10 \* 60 \* 1000/.test(ext) && /러너 자체 타임아웃/.test(ext), "생성중 판독 + TTL(러너 상한에서 유도 — 맹목 상수 아님 주석)");
ok(/지도 생성중… \(/.test(ext) && /generating map… \(/.test(ext) && /탐색중", "scouting"/.test(ext), "상태바: 생성 도는 동안만 '탐색중' 라벨(평시 아이콘만 — 거짓 신호 방지) 양언어");
ok(/지금: 지도 생성 중…/.test(ext) && /Now: generating a map…/.test(ext), "카드 '지금:' 줄에도 생성중 최우선 반영");
const inj = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-inject.js"), "utf8");
ok(/buildScoutDirective\(ws, c\)/.test(inj), "훅이 자동 지시를 주입(계약 재사용 — 중복 로드 없음)");
const privacy = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
ok(/자동 지시\(현재 동작\)/.test(privacy) && /지시문만/.test(privacy) && /키를 삭제하면 DeepSeek 자동 사용도 함께 꺼집니다/.test(privacy), "PRIVACY 현재형: 지시 주입=전송 주체 불변 + 동의 모델");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 정리 실패 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
