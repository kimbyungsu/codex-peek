/*
 * 지도 보관함(scripts/scout-store.js) + 영향지도 게시판 배선 — 동작 테스트(임시 폴더 실 IO) + 소스 계약.
 * 핵심 계약: ①wsKey가 계약 키 규칙(sha1(normWs) 앞16자)과 동형 ②저장=md+json 쌍 ③프로젝트별 최근 10장 유지
 * ④러너 양쪽이 보관 호출 ⑤확장이 게시판·상태바 줄을 양언어로 배선 ⑥PRIVACY에 scouts 행 명시.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

// 임시 브릿지 홈에 격리(실 사용자 데이터 오염 금지) — require 전에 env를 세워야 모듈 상수가 이 경로를 잡는다.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "scout-store-test-"));
process.env.CODEX_BRIDGE_HOME = tmpHome;
const store = require(path.join(__dirname, "..", "scripts", "scout-store.js"));

console.log("[wsKey] 계약 키 규칙과 동형(sha1(normWs) 앞16자) — 어긋나면 게시판이 빈다");
// 네이티브 구분자로 구성(CI 리눅스에서 역슬래시는 구분자가 아님 — Windows 표기 동치는 win32에서만 성립하는 성질).
const sample = ["D:", "어떤 프로젝트", "Repo"].join(path.sep) + path.sep;
const expected = crypto.createHash("sha1").update(path.normalize(sample).replace(/[\\/]+$/, "").toLowerCase().normalize("NFC")).digest("hex").slice(0, 16);
ok(store.wsKeyFor(sample) === expected, "정규화(끝 구분자·대소문자·NFC) 후 sha1 앞16자");
ok(store.wsKeyFor(["d:", "어떤 프로젝트", "repo"].join(path.sep)) === expected, "끝 구분자·대소문자 달라도 같은 키(같은 프로젝트=같은 게시판)");
if (process.platform === "win32") {
  ok(store.wsKeyFor("d:/어떤 프로젝트/repo") === expected, "win32: 슬래시/역슬래시 표기가 같은 키로 수렴(확장 fsPath↔러너 인자 불일치 방지)");
} else {
  ok(store.wsKeyFor("d:/어떤 프로젝트/repo/") === store.wsKeyFor("D:/어떤 프로젝트/repo"), "POSIX: 슬래시 표기끼리 끝 구분자·대소문자 동치(역슬래시 동치는 win32 전용 성질)");
}

console.log("[saveMap/listMaps] md+json 쌍 저장 · 메타 보존 · 새것부터 나열");
const repo = "D:/데모/저장소";
store.saveMap(repo, "self", "# 지도 A", {});
const p2 = store.saveMap(repo, "deepseek", "# 지도 B", { usageIn: 7013, usageOut: 2798, model: "deepseek-v4-flash" });
ok(fs.existsSync(p2) && fs.existsSync(p2.replace(/\.md$/, ".json")), "지도 원문(.md)+메타(.json) 쌍 생성");
const list = store.listMaps(repo);
ok(list.length === 2 && list[0].arm === "deepseek" && list[1].arm === "self", "새것부터 나열(팔 구분)");
ok(list[0].usageIn === 7013 && list[0].usageOut === 2798 && list[0].model === "deepseek-v4-flash", "전송·수신 토큰과 모델 메타 보존('무엇이 나갔나' 표시 재료)");
fs.unlinkSync(list[1].file.replace(/\.md$/, ".json")); // 메타만 파손시켜 내성 확인
const list2 = store.listMaps(repo);
ok(list2.length === 2 && list2[1].model === null && list2[1].arm === "self", "메타 없는 지도도 목록 유지(은폐 금지 — 팔은 파일명에서 복원)");

console.log("[prune] 프로젝트별 최근 " + store.KEEP_PER_WS + "장만 유지(PRIVACY 명시와 일치)");
for (let i = 0; i < store.KEEP_PER_WS + 3; i++) store.saveMap(repo, "self", "지도 " + i, {});
const dir = path.join(store.SCOUTS_DIR, store.wsKeyFor(repo));
const mdCount = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
ok(mdCount === store.KEEP_PER_WS, "초과분 자동 삭제(현재 " + mdCount + "장)");
ok(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length <= store.KEEP_PER_WS, "메타도 같이 정리(고아 파일 없음)");

console.log("[러너 배선] self·DeepSeek 팔 모두 생성 직후 보관 호출(소스 계약)");
const selfSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-self.js"), "utf8");
const dsSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-deepseek.js"), "utf8");
ok(/saveMap\(repo, "self"/.test(selfSrc), "self 팔 보관 호출");
ok(/saveMap\(repo, "deepseek"/.test(dsSrc) && /\[usage\] in=/.test(dsSrc), "DeepSeek 팔 보관 호출 + 사용량 메타 파싱");
ok(/지도 보관 실패\(게시판에만 영향\)/.test(selfSrc) && /지도 보관 실패\(게시판에만 영향\)/.test(dsSrc), "보관 실패가 지도 출력 자체를 못 막음(advisory)");

console.log("[확장 배선] 게시판·상태바 줄(양언어)·읽기 전용 원칙(소스 계약)");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/scoutMaps: readScoutMaps\(ws\)/.test(ext), "상태 payload에 게시판 데이터(3트랙에서만)");
ok(/scoutMode !== "on"\) return null; \/\/ 2트랙 — 게시판/.test(ext), "2트랙이면 게시판 계산 자체를 안 함(무회귀)");
ok(/영향지도 게시판/.test(ext) && /Impact-map board/.test(ext), "게시판 카드 양언어");
ok(/아직 지도가 없어요/.test(ext) && /No maps yet/.test(ext) && /git 저장소가 아니라 지도를 만들 수 없어요/.test(ext), "빈 게시판·비-git 정직 안내(양언어)");
ok(/탐색: 3트랙 켜짐 · 지도/.test(ext) && /scouting: 3-track on/.test(ext), "상태바 툴팁 탐색 줄 양언어");
ok(/scout: scoutSb \|\| null/.test(ext), "탐색 상태가 상태바 갱신 키에 포함(낡은 지도 수 잔존 방지)");
ok(!/scoutMaps[^\n]*\.text[^\n]*innerHTML|innerHTML[^\n]*scoutMaps/.test(ext), "지도 본문은 textContent로만(HTML 주입 없음)");
const privacy = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
ok(/scouts\/<키>/.test(privacy) && /최근 10장만 유지/.test(privacy), "PRIVACY에 scouts 보관함 행 명시");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
