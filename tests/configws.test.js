// configWs() 해석 검증 — '연 폴더(설정 기준)'를 active.json+세션ID 일치로 고정, 폴백은 cwd(무회귀).
// 실제 contract-lib.js의 configWs를 격리 temp BRIDGE_DIR로 검증(별도 프로세스라 env 오염 없음).
const assert = require("assert"), os = require("os"), path = require("path"), fs = require("fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfgws_"));
process.env.CODEX_BRIDGE_HOME = tmp;           // BRIDGE_DIR override (contract-lib가 load 시 읽음)
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
const { configWs } = require("../bridge/contract-lib.js");

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const writeActive = (o) => fs.writeFileSync(path.join(tmp, "active.json"), JSON.stringify(o));

// 1) active.json이 '이 세션' 것이면 그 workspace(=연 폴더) — 작업 cwd와 무관
writeActive({ workspace: "D:\\Opened\\Project", claudeSession: "sess-1", ts: "2026-06-29T00:00:00Z" });
ok(configWs({ sessionId: "sess-1", cwd: "D:\\Work\\Elsewhere" }) === "D:\\Opened\\Project",
  "세션 일치 → active.workspace(연 폴더), 작업 cwd가 달라도 연 폴더 반환");

// 2) active가 '다른 세션' 것이면 무시하고 cwd 폴백(멀티창 오집 방지)
ok(configWs({ sessionId: "other-sess", cwd: "D:\\Work\\Here" }) === "D:\\Work\\Here",
  "세션 불일치 → active 무시·cwd 폴백");

// 3) 세션ID 자체가 없으면 cwd 폴백
ok(configWs({ cwd: "D:\\Fallback" }) === "D:\\Fallback", "세션ID 없음 → cwd 폴백");

// 4) active.json 없음 → cwd 폴백(폴백 cwd 없으면 process.cwd)
fs.unlinkSync(path.join(tmp, "active.json"));
ok(configWs({ sessionId: "sess-1", cwd: "D:\\NoActive" }) === "D:\\NoActive", "active 없음 → cwd 폴백");

// 5) CLAUDE_PROJECT_DIR 명시 override가 최우선
writeActive({ workspace: "D:\\Opened\\Project", claudeSession: "sess-1" });
process.env.CLAUDE_PROJECT_DIR = "D:\\Explicit\\Override";
ok(configWs({ sessionId: "sess-1", cwd: "D:\\X" }) === "D:\\Explicit\\Override", "CLAUDE_PROJECT_DIR 최우선");
delete process.env.CLAUDE_PROJECT_DIR;

// 6) env CLAUDE_CODE_SESSION_ID로도 세션 매칭(opts 미지정 시 env 사용 — 브릿지 ask 경로)
process.env.CLAUDE_CODE_SESSION_ID = "sess-1";
ok(configWs() === "D:\\Opened\\Project", "env CLAUDE_CODE_SESSION_ID 매칭 → 연 폴더");
process.env.CLAUDE_CODE_SESSION_ID = "nope";
ok(configWs({ cwd: "D:\\EnvMismatch" }) === "D:\\EnvMismatch", "env 세션 불일치 → cwd 폴백");
delete process.env.CLAUDE_CODE_SESSION_ID;

// 7) workspace가 빈 문자열이면 무시하고 폴백(잘못 기록된 active 방어)
writeActive({ workspace: "   ", claudeSession: "sess-1" });
ok(configWs({ sessionId: "sess-1", cwd: "D:\\BlankWs" }) === "D:\\BlankWs", "active.workspace 공백 → 폴백");

// 8) 세션별 active(active/<sid>.json)가 1순위 — 다른 창이 단일 active.json을 덮어써도 이 세션 연 폴더 반환(레이스 없음)
const adir = path.join(tmp, "active");
fs.mkdirSync(adir, { recursive: true });
const writePer = (sid, o) => fs.writeFileSync(path.join(adir, sid + ".json"), JSON.stringify(o));
writePer("sess-1", { workspace: "D:\\PerSession\\A", claudeSession: "sess-1" });
writeActive({ workspace: "D:\\OtherWindow\\B", claudeSession: "other-window" }); // 다른 창이 단일 active 덮어쓴 상황
ok(configWs({ sessionId: "sess-1", cwd: "D:\\X" }) === "D:\\PerSession\\A",
  "세션별 active 1순위 — 단일 active.json이 다른 창 것으로 덮여도 이 세션의 연 폴더 반환(멀티창 레이스 없음)");

// 9) 세션별 active 없고 단일 active.json만 이 세션 것 → 레거시 폴백
fs.unlinkSync(path.join(adir, "sess-1.json"));
writeActive({ workspace: "D:\\Legacy\\C", claudeSession: "sess-1" });
ok(configWs({ sessionId: "sess-1", cwd: "D:\\X" }) === "D:\\Legacy\\C", "세션별 없음 → 레거시 active.json(세션 일치) 폴백");

// 10) 파일명 안전 — 이상 문자 세션ID도 traversal 없이(해당 파일 없으면 cwd 폴백)
ok(configWs({ sessionId: "../evil", cwd: "D:\\Safe" }) === "D:\\Safe", "이상 세션ID → 안전(파일 없음)·cwd 폴백");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log("configws: " + n + " assertions passed");
