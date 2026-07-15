// links.json 쓰기 단일 관문(updateLinks)의 CAS+재시도 회귀 테스트.
// P1b: 여러 쓰기 경로가 통째 덮어쓰던 lost-update를 막는다.
// CODEX_BRIDGE_HOME을 require 전에 임시폴더로 지정 → 실제 ~/.codex-bridge 오염 방지.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas_"));
process.env.CODEX_BRIDGE_HOME = dir;
const { updateLinks, loadLinks, LINKS_FILE, linksFileState } = require("../bridge/codex-bridge.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };
const readFile = () => { try { return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")); } catch { return null; } };

console.log("[1] 순차 쓰기 — 서로 다른 키가 둘 다 살아남음(통째 덮어쓰기 아님)");
updateLinks((o) => { o.modelPrefs = o.modelPrefs || {}; o.modelPrefs["wsA"] = { model: "m1" }; });
updateLinks((o) => { o.byWorkspace["wsB"] = { codexSession: "S2" }; });
const after2 = readFile();
ck("첫 쓰기(modelPrefs.wsA) 보존", after2 && after2.modelPrefs && after2.modelPrefs.wsA && after2.modelPrefs.wsA.model === "m1");
ck("둘째 쓰기(byWorkspace.wsB)도 존재", after2 && after2.byWorkspace && after2.byWorkspace.wsB && after2.byWorkspace.wsB.codexSession === "S2");

console.log("[2] CAS 재시도 — 읽기↔쓰기 사이 '다른 프로세스'가 끼어들어도 그 변경을 덮어쓰지 않음");
let firstPass = true;
updateLinks((o) => {
  o.byWorkspace["mine"] = { codexSession: "MINE" };
  if (firstPass) {
    firstPass = false;
    // updateLinks가 'before'를 읽은 뒤다. 외부 프로세스가 끼어들어 다른 키를 직접 저장한 것처럼 만든다.
    // → updateLinks가 쓰기 직전 재확인에서 변경을 감지하고 재시도해야 한다(이 mutator가 한 번 더 호출됨).
    const cur = (function () { try { return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")); } catch { return {}; } })();
    cur.byWorkspace = cur.byWorkspace || {};
    cur.byWorkspace["intruder"] = { codexSession: "INTRUDER" };
    fs.writeFileSync(LINKS_FILE, JSON.stringify(cur, null, 2), "utf8");
  }
});
const after3 = readFile();
ck("재시도가 한 번 일어남(mutator 2회 호출 → firstPass 소진)", firstPass === false);
ck("끼어든 외부 변경(intruder) 보존 — lost-update 아님", after3 && after3.byWorkspace && after3.byWorkspace.intruder && after3.byWorkspace.intruder.codexSession === "INTRUDER");
ck("내 변경(mine)도 최종 반영", after3 && after3.byWorkspace && after3.byWorkspace.mine && after3.byWorkspace.mine.codexSession === "MINE");
ck("앞 단계 키들도 그대로(wsA·wsB)", after3 && after3.modelPrefs.wsA && after3.byWorkspace.wsB);

console.log("[3] loadLinks 기본형 — 파일 없을 때도 bySession/byWorkspace 보장");
const fresh = loadLinks();
ck("loadLinks가 bySession/byWorkspace 객체를 줌", fresh && typeof fresh.bySession === "object" && typeof fresh.byWorkspace === "object");


console.log("[P-1] 손상 links.json은 어떤 기록자도 덮어쓰지 않는다(부재만 신규 — fail-closed)");
const CORRUPT = "{broken json!! " + Date.now();
fs.writeFileSync(LINKS_FILE, CORRUPT, "utf8");
ck("updateLinks가 손상 파일에서 기록 거부(false)", updateLinks((o) => { o.byWorkspace["wsX"] = { codexSession: "SX" }; }) === false);
ck("손상 바이트 그대로 보존(복구 기회 유지)", fs.readFileSync(LINKS_FILE, "utf8") === CORRUPT);
const lib = require("../bridge/contract-lib.js");
const reg = lib.registerCodexImplementer("D:/ws-p1", "aaaaaaaa-0000-0000-0000-000000000001", "m", "high");
ck("훅 자동 경로(registerCodexImplementer)도 기록 거부: " + (reg && reg.reason), !!reg && reg.ok === false && reg.reason === "links-corrupt");
ck("훅 경로 후에도 손상 바이트 보존", fs.readFileSync(LINKS_FILE, "utf8") === CORRUPT);
fs.unlinkSync(LINKS_FILE);
ck("부재(ENOENT)는 신규 파일로 정상 기록", updateLinks((o) => { o.byWorkspace["wsY"] = { codexSession: "SY" }; }) === true && !!readFile());
const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

// 의미 손상(구문은 유효): null·배열·문자열 루트, byWorkspace 타입 위반 — 전부 거부+바이트 보존(P-1 검증 반례)
for (const bad of ["null", "[]", "\"just-a-string\"", "0", "false", JSON.stringify({ byWorkspace: [] }), JSON.stringify({ bySession: "oops" })]) {
  fs.writeFileSync(LINKS_FILE, bad, "utf8");
  const wrote = updateLinks((o) => { o.byWorkspace["wsZ"] = { codexSession: "SZ" }; });
  ck("의미 손상 루트 거부: " + bad.slice(0, 24), wrote === false && fs.readFileSync(LINKS_FILE, "utf8") === bad);
  const reg2 = lib.registerCodexImplementer("D:/ws-p1b", "aaaaaaaa-0000-0000-0000-000000000002", "m", "high");
  ck("훅 경로도 의미 손상 거부: " + bad.slice(0, 24), !!reg2 && reg2.ok === false && fs.readFileSync(LINKS_FILE, "utf8") === bad);
}
// spawn 전 관문: 손상 links 상태에서 ask-start·ask는 아무 것도 만들지 않고 복구 안내로 중단(P-1 지적 2)
fs.writeFileSync(LINKS_FILE, "{broken-for-gate", "utf8");
const cp = require("child_process");
const gateEnv = { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: dir };
const g1 = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask-start", "--allow-new", "x"], { encoding: "utf8", env: gateEnv, timeout: 15000, windowsHide: true });
ck("손상 links에서 ask-start 중단+복구 안내", g1.status !== 0 && /links\.json/.test(String(g1.stderr || g1.stdout)));
ck("ask-start 중단 시 job 미생성", !fs.existsSync(path.join(dir, "ask-jobs")) || fs.readdirSync(path.join(dir, "ask-jobs")).filter((f) => f.endsWith(".json")).length === 0);
const g2 = cp.spawnSync(process.execPath, [path.join(__dirname, "..", "bridge", "codex-bridge.js"), "ask", "x"], { encoding: "utf8", env: gateEnv, timeout: 15000, windowsHide: true });
ck("손상 links에서 직접 ask도 실행 전 중단", g2.status !== 0 && /links\.json/.test(String(g2.stderr || g2.stdout)));
fs.unlinkSync(LINKS_FILE);


// 판독 실패(EACCES류) — 플랫폼 독립 monkey-patch로 unreadable 분기 고정(4차 보완: Windows ACL 조작 회피)
fs.writeFileSync(LINKS_FILE, JSON.stringify({ byWorkspace: { keep: { codexSession: "K" } } }), "utf8");
const realRead = fs.readFileSync;
fs.readFileSync = function (f, ...rest) { if (String(f) === String(LINKS_FILE)) { const e = new Error("EACCES: permission denied"); e.code = "EACCES"; throw e; } return realRead.call(fs, f, ...rest); };
try {
  ck("판독 실패=unreadable 상태", linksFileState() === "unreadable");
  ck("판독 실패 시 updateLinks 기록 거부", updateLinks((o) => { o.byWorkspace["wsE"] = { codexSession: "SE" }; }) === false);
} finally { fs.readFileSync = realRead; }
ck("판독 실패 동안 기존 내용 무손상", !!readFile() && !!readFile().byWorkspace.keep);
fs.unlinkSync(LINKS_FILE);

ck("확장 updateLinks도 동형 계약(소스 잠금)", extSrc.includes("손상·판독 실패=기록 거부(손상 바이트 보존 — P-1)"));

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
