// Task2(즉시연결) race 방어 검증: newestRolloutSinceForWs가 'cwd 일치 + since 이후 최신'만 고르는지.
// (동시에 다른 폴더 세션이 더 최신이어도 그걸 잘못 링크하지 않아야 함 = 즉시연결의 핵심 안전장치)
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");

const tmp = path.join(os.tmpdir(), "cb-imm-" + process.pid + "-" + Date.now());
const sessions = path.join(tmp, "sessions", "2026", "06", "28");
fs.mkdirSync(sessions, { recursive: true });
process.env.CODEX_HOME = tmp; // SESSIONS_DIR = tmp/sessions (require 전에 설정)

const { newestRolloutSinceForWs } = require("../bridge/codex-bridge.js");

const BASE = 1700000000000; // 2023 — epoch 근처 mtime FS 엣지 회피
function mkRollout(uuid, cwd, mtimeMs) {
  const f = path.join(sessions, `rollout-2026-06-28T00-00-00-${uuid}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: "session_meta", payload: { cwd, id: uuid, timestamp: "t" } }) + "\n" +
    JSON.stringify({ type: "turn_context", payload: {} }) + "\n");
  fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
}
const WS = "D:\\proj\\alpha", OTHER = "D:\\proj\\beta";
mkRollout("11111111-1111-1111-1111-111111111111", WS, BASE + 2000);    // 같은 cwd, 오래됨
mkRollout("22222222-2222-2222-2222-222222222222", WS, BASE + 5000);    // 같은 cwd, 최신 ← 정답
mkRollout("33333333-3333-3333-3333-333333333333", OTHER, BASE + 9000); // 다른 cwd, 더 최신(무시돼야)
// cwd 없는(깨진 메타) 파일도 무시돼야
const broken = path.join(sessions, "rollout-2026-06-28T00-00-00-44444444-4444-4444-4444-444444444444.jsonl");
fs.writeFileSync(broken, "not-json\n"); fs.utimesSync(broken, (BASE + 9999) / 1000, (BASE + 9999) / 1000);

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const r = newestRolloutSinceForWs(BASE + 1000, WS);
ok(r && r.includes("22222222"), "cwd 일치 중 최신을 고름 (다른 cwd의 더 최신·깨진 메타는 무시)");
ok(newestRolloutSinceForWs(BASE + 1000, "D:\\proj\\gamma") === null, "일치 cwd 없으면 null");
ok(newestRolloutSinceForWs(BASE + 99999, WS) === null, "since 이후 없으면 null (오래된 것 안 집음)");
ok(newestRolloutSinceForWs(BASE + 1000, "") === null, "빈 ws → null (엉뚱 링크 방지)");
// 대소문자/슬래시 정규화(normWs)로 같은 폴더 인식
ok((newestRolloutSinceForWs(BASE + 1000, "d:\\proj\\alpha") || "").includes("22222222"), "normWs로 대소문자 차이도 같은 cwd로 인식");

console.log("immediate-link: " + n + " assertions passed");
