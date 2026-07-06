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
ok(/const scoutMaps = readScoutMaps\(ws\)/.test(ext) && /^\s*scoutMaps,/m.test(ext), "상태 payload에 게시판 데이터(3트랙에서만 — 낡음 계산과 공유)");
ok(/scoutMode !== "on"\) return null; \/\/ 2트랙 — 게시판/.test(ext), "2트랙이면 게시판 계산 자체를 안 함(무회귀)");
ok(/영향지도 게시판/.test(ext) && /Impact-map board/.test(ext), "게시판 카드 양언어");
ok(/아직 지도가 없어요/.test(ext) && /No maps yet/.test(ext) && /git 저장소가 아니라 지도를 만들 수 없어요/.test(ext), "빈 게시판·비-git 정직 안내(양언어)");
ok(/탐색\(3트랙\): /.test(ext) && /scouting \(3-track\): /.test(ext), "상태바 툴팁 탐색 줄 양언어");
ok(/scout: scoutSb \|\| null/.test(ext), "탐색 상태가 상태바 갱신 키에 포함(낡은 지도 수 잔존 방지)");
ok(!/scoutMaps[^\n]*\.text[^\n]*innerHTML|innerHTML[^\n]*scoutMaps/.test(ext), "지도 본문은 textContent로만(HTML 주입 없음)");
const privacy = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
ok(/scouts\/<키>/.test(privacy) && /최근 10장만 유지/.test(privacy), "PRIVACY에 scouts 보관함 행 명시");

console.log("[한눈에 보기·복원] 탐색 둘째 줄(검증과 별개 축) + 히어로 카드 + 리로드 복원 탭 되살리기(소스 계약)");
ok(/id="scoutFlow" style="display:none/.test(ext) && /id="heroScout" style="display:none"/.test(ext), "탐색 줄·히어로 카드는 기본 숨김(2트랙=기존 모습 그대로)");
ok(/증거 봉투 꾸림", "packs evidence"/.test(ext) && /지도 반환", "returns map"/.test(ext) && /영향지도<br>게시판/.test(ext), "둘째 줄 배선=Claude→탐색자→게시판(검증 후 탐색으로 오독되던 일렬 제거 — 사용자 지적 반영)");
ok(!/Codex<small>\$\{t\("검증", "verify"\)\}<\/small>\s*<\/div>\s*<div class="farrow off" id="faScout"/.test(ext), "Codex 뒤 일렬 탐색자 배선이 남아있지 않음");
ok(/"탐색자", "Scout"/.test(ext) && /"영향지도", "impact map"/.test(ext) && /켜짐 · 지도는 수동 실행","on · maps via manual runs"/.test(ext), "탐색자 표기 양언어 + '수동 실행' 명시");
ok(/shownSM===appSM/.test(ext) && /appSM==="on"/.test(ext), "탐색 토글이 지도 렌더 가드에 포함(저장 반영 시 갱신)");
ok(/scoutMapStale: computeScoutMapStale\(ws, scope, scoutMaps\)/.test(ext) && /최신 지도 생성 이후 파일 /.test(ext) && /file\(s\) changed after the latest map/.test(ext), "낡은 지도 배지(신선도) — 계산+게시판 표기 양언어");
ok(/키 없이도 기초 탐색/.test(ext) && /무료 self 팔/.test(ext) && !/LLM 영향지도 단계가 잠겨/.test(ext) && !/LLM impact-map stage of 3-track is locked/.test(ext), "무키 문구 정정 — self 팔이 무키로 지도 가능함을 반영(과소 안내 제거)");

console.log("[탐색 가시성] 상태 요약 줄·세그먼트 연결 표시·상태바 신호(침묵을 상태로 번역 — 사용자 지적)");
ok(/checkedAt: string; logCount: number/.test(ext) && /지금: 기초 탐색 동작 중 — 최근 채굴 /.test(ext) && /basic scouting active — last mined /.test(ext), "탐색 상태 요약 줄(채굴 시각·검토 건수·후보 수) 양언어");
ok(/지금: 대기 — 이 폴더는 이력\(git\)이 없어/.test(ext) && /지금: 대기 — 작업트리에 변경이 없어요/.test(ext), "대기 상태도 사유와 다음 행동을 명시(비-git·변경 없음)");
ok(/id="scoutApiLine"/.test(ext) && /x\.arm==="deepseek"/.test(ext) && /마지막 성공 통신 /.test(ext) && /last successful call /.test(ext), "세그먼트 아래 DeepSeek 연결 줄 — 키 상태+마지막 성공 증거(deepseek 팔만 필터)");
ok(/ⓘ 영향지도 = /.test(ext) && /Impact map = a checklist/.test(ext), "'영향지도란?' 설명 양언어(게시판 상단)");
ok(/\$\(telescope\)/.test(ext) && /기초 탐색 동작 중 — 후보 /.test(ext) && /지도 낡음/.test(ext) && /map stale/.test(ext), "상태바: 3트랙 아이콘 신호 + 툴팁에 흐름 요약(탐색 상태·지도 수·낡음)");
const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "deepseek-bridge.js"), "utf8");
ok(/잠기는 건 'DeepSeek 비교 팔'뿐/.test(bridgeSrc) && !/LLM 지도 단계만 잠김/.test(bridgeSrc), "CLI 무키 안내도 정정(5번째 지점 — Codex 지적)");
ok(/registerWebviewPanelSerializer\("codexBridge"/.test(ext) && /dashboard\.revive\(panel\)/.test(ext), "리로드 복원 탭 되살리기 등록(미등록=영구 빈 화면 — 사용자 실측)");
ok(/revive\(panel: vscode\.WebviewPanel\)/.test(ext) && /pendingRevive/.test(ext), "복원 탭이 새 패널과 같은 배선(html·리스너·post)을 탐");
const pj = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
ok(pj.activationEvents.includes("onWebviewPanel:codexBridge"), "복원 탭이 확장을 깨우는 activation event 선언(Codex 지적 — serializer만으론 불완전)");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 임시 폴더 정리 실패는 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
