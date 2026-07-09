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
ok(!!d2 && /낡았다/.test(d2) && /변경 신호 1건\(근거 파일 1/.test(d2), "낡음 감지: 지도 자신의 근거 파일 기준 + 신호 3종 분리 표기(2026-07-10 신선도 확장)");
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

console.log("[버킷 재알림 · 2026-07-08 점화 보수] 같은 지도라도 낡음 '정도'(1,2,4,8…)가 오르면 재지시, 하강·동일은 침묵");
["b.md", "c.md", "d.md"].forEach((n) => fs.writeFileSync(path.join(repo, n), "seed"));
store.saveMap(repo, "self", "# 지도4", { seedFiles: ["a.md", "b.md", "c.md", "d.md"] });
const metaFile4 = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse()[0];
const meta4 = JSON.parse(fs.readFileSync(path.join(dir, metaFile4), "utf8"));
meta4.ts = new Date(Date.now() - 3600 * 1000).toISOString();
fs.writeFileSync(path.join(dir, metaFile4), JSON.stringify(meta4));
// 시작 상태를 '전부 지도보다 오래됨'(낡음 0)으로 고정 — 씨앗 mtime을 지도 ts(1시간 전)보다 뒤로 두면 첫 판정부터 낡음 4가 돼버림
const old = new Date(Date.now() - 7200 * 1000);
["a.md", "b.md", "c.md", "d.md"].forEach((n) => fs.utimesSync(path.join(repo, n), old, old));
ok(lib.scoutMapStatus(repo).state === "fresh", "시작 상태: 씨앗 전부 지도 이전 → fresh");
const touch = (n) => fs.writeFileSync(path.join(repo, n), "갱신 " + Math.random());
touch("a.md");
ok(!!lib.buildScoutDirective(repo, cOn) && lib.scoutMapStatus(repo).staleCount === 1, "낡음 1(버킷1) — 새 지도 첫 지시");
ok(lib.buildScoutDirective(repo, cOn) === null, "같은 정도(1) 재호출 → 침묵");
touch("b.md");
const dB2 = lib.buildScoutDirective(repo, cOn);
ok(!!dB2 && /변경 신호 2건/.test(dB2), "낡음 2(버킷2 상승) → 재지시 1회");
touch("c.md");
ok(lib.scoutMapStatus(repo).staleCount === 3 && lib.buildScoutDirective(repo, cOn) === null, "낡음 3(버킷2 유지) → 침묵(도배 방지)");
touch("d.md");
const dB4 = lib.buildScoutDirective(repo, cOn);
ok(!!dB4 && /변경 신호 4건/.test(dB4), "낡음 4(버킷4 상승) → 재지시 1회");
fs.utimesSync(path.join(repo, "c.md"), old, old); // c.md mtime을 지도 이전으로 → staleCount 하강(4→3). ⚠삭제는 이제 '변경 신호'라 하강 시뮬레이션에 못 씀(2026-07-10 삭제 감지 — Codex 반례 수용)
ok(lib.scoutMapStatus(repo).staleCount === 3 && lib.buildScoutDirective(repo, cOn) === null, "하강(4→3, 버킷2≤최대4) → 재지시 없음(스팸 방지)");

console.log("[구형 기억 마이그레이션] {sig:'stale:<base>'} 파일은 maxBucket=1로 해석 — 정도 진행 시 재지시");
const adviceFile = path.join(tmpHome, "scout-advice", store.wsKeyFor(repo) + ".json");
fs.writeFileSync(adviceFile, JSON.stringify({ sig: "stale:" + lib.scoutMapStatus(repo).base, ts: new Date().toISOString() }));
const dMig = lib.buildScoutDirective(repo, cOn);
ok(!!dMig && /변경 신호 3건/.test(dMig), "구형 sig(=버킷1) + 현재 낡음 3(버킷2) → 재지시(마이그레이션 의도)");

console.log("[레거시 지도 · seedFiles 기록 없음] fresh 오판 대신 '판정 불가' 상태 + 재생성 권고 1회(실사고 2026-07-08 잠금)");
store.saveMap(repo, "self", "# 지도5", { seedFiles: ["a.md"] });
const metaFile5 = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse()[0];
const meta5 = JSON.parse(fs.readFileSync(path.join(dir, metaFile5), "utf8"));
delete meta5.seedFiles; // 구버전 러너가 만든 지도 재현(근거 기록 없음)
fs.writeFileSync(path.join(dir, metaFile5), JSON.stringify(meta5));
const stL = lib.scoutMapStatus(repo);
ok(stL.state === "legacy-no-seeds", `근거 기록 없는 지도 → legacy-no-seeds(실제 ${stL.state}) — fresh 오판 금지`);
const dL = lib.buildScoutDirective(repo, cOn);
ok(!!dL && /판정할 수 없다/.test(dL) && /재생성 권고/.test(dL), "레거시 지시: 낡음 단정 없이 '판정 불가' 정직 문구");
ok(lib.buildScoutDirective(repo, cOn) === null, "레거시 상태 재호출 → 침묵(상태당 1회)");
meta5.seedFiles = []; // 최신 러너가 '변경 없는 작업트리'에서 만드는 정상 형식(Codex 반례 잠금 — 구버전 오판 금지)
fs.writeFileSync(path.join(dir, metaFile5), JSON.stringify(meta5));
ok(lib.scoutMapStatus(repo).state === "fresh", "명시적 seedFiles:[] → legacy 아님(fresh — 방금 만든 지도에 재생성 권고 반복 금지)");
ok(lib.buildScoutDirective(repo, cOn) === null, "빈 근거 최신 지도 → 지시 없음");
const gateSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "scout-gate.js"), "utf8");
ok(/legacy-no-seeds/.test(gateSrc) && /구버전 지도/.test(gateSrc), "플랜 게이트도 레거시 문구 분기(낡음 거짓 단정 방지 — 소스 계약)");

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
