/*
 * 지도 보관함 — 탐색 러너(self·DeepSeek 팔)가 생성한 영향지도를 브릿지 홈(scouts/)에 보관해,
 * 대시보드 '영향지도 게시판'이 읽는다(사용자 결정 2026-07-06: AI 역할의 시각적 확인을 위해 최소 게시판을 A/B 전에 당김).
 * 파일 규칙: scouts/<wsKey>/<ISO시각(파일명 안전형)>-<arm>.md + 같은 이름 .json(메타: 시각·팔·모델·토큰·repo).
 * wsKey = sha1(normWs(repo)) 앞 16자 — extension.ts·contract-lib.js의 프로젝트 계약 키와 **반드시 동일 규칙**
 * (한쪽만 바꾸면 러너가 저장한 지도를 대시보드가 못 찾는다).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const SCOUTS_DIR = path.join(BRIDGE_DIR, "scouts");
const KEEP_PER_WS = 10; // 프로젝트별 최근 10장만 유지(프라이버시·용량 — PRIVACY.md 명시와 일치해야 함)

// extension.ts normWs와 동일: normalize + 끝 구분자 제거 + 소문자 + NFC(유니코드 폼 차이 방지)
function normWs(p) {
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
}
function wsKeyFor(repo) {
  return crypto.createHash("sha1").update(normWs(repo)).digest("hex").slice(0, 16);
}

// 지도 1장 저장 + 오래된 것 정리. 반환: 저장된 md 경로.
let seq = 0; // 같은 밀리초 연속 저장(테스트 루프·연타)의 파일명 충돌 방지 — 이름 정렬상 시각 다음 자리
function saveMap(repo, arm, mapText, meta) {
  const dir = path.join(SCOUTS_DIR, wsKeyFor(repo));
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const base = now.toISOString().replace(/[:.]/g, "-") + "-" + String(seq++ % 100).padStart(2, "0") + "-" + arm; // ISO는 이름 정렬=시간 정렬
  fs.writeFileSync(path.join(dir, base + ".md"), String(mapText || ""));
  fs.writeFileSync(path.join(dir, base + ".json"), JSON.stringify({ ts: now.toISOString(), arm, repo, ...(meta || {}) }, null, 2));
  pruneDir(dir, KEEP_PER_WS);
  return path.join(dir, base + ".md");
}

function pruneDir(dir, keep) {
  let bases;
  try { bases = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().reverse(); } catch { return; }
  for (const b of bases.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, b + ".md")); } catch { /* 이미 없음 */ }
    try { fs.unlinkSync(path.join(dir, b + ".json")); } catch { /* 메타 없던 장 */ }
  }
}

// 최근 지도 목록(새것부터). meta 파손·부재도 목록에서 빼지 않는다(지도 은폐 금지) — 메타만 비운다.
function listMaps(repo, limit) {
  const dir = path.join(SCOUTS_DIR, wsKeyFor(repo));
  let bases;
  try { bases = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().reverse(); } catch { return []; }
  return bases.slice(0, limit || KEEP_PER_WS).map((b) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, b + ".json"), "utf8")); } catch { /* 메타 없음 */ }
    return { base: b, file: path.join(dir, b + ".md"), ts: meta.ts || null, arm: meta.arm || (b.split("-").pop() || ""), model: meta.model || null, usageIn: meta.usageIn ?? null, usageOut: meta.usageOut ?? null };
  });
}

// ── '지도 생성중' 라이브 신호 — 상태바가 실제 도는 동안만 '생성중'을 표시(거짓 신호 방지: 평시엔 파일 없음).
// 러너가 탐색자 호출 직전 mark, finally에서 clear. 비정상 종료로 잔존해도 읽는 쪽 TTL이 걸러낸다.
const LIVE_DIR = path.join(BRIDGE_DIR, "scout-live");
function markLive(repo, arm) {
  try { fs.mkdirSync(LIVE_DIR, { recursive: true }); fs.writeFileSync(path.join(LIVE_DIR, wsKeyFor(repo) + ".json"), JSON.stringify({ arm, startedAt: new Date().toISOString() })); } catch { /* 표시용 — 실패 무해 */ }
}
function clearLive(repo) {
  try { fs.unlinkSync(path.join(LIVE_DIR, wsKeyFor(repo) + ".json")); } catch { /* 이미 없음 */ }
}

module.exports = { normWs, wsKeyFor, saveMap, listMaps, pruneDir, markLive, clearLive, LIVE_DIR, SCOUTS_DIR, KEEP_PER_WS };
