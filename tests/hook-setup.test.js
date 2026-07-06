/*
 * hook-setup(src/hook-setup.ts → out/hook-setup.js) — 마켓 설치 경로의 '훅 1클릭 설치' 정본 로직.
 * install.js와 같은 규칙(훅 4개·명령 표기·우리훅 식별·타인 훅 보존)을 이 테스트로 고정.
 * ※ out/hook-setup.js는 npm test의 tsc 단계 산출물.
 */
const os = require("os"), path = require("path"), fs = require("fs");
const hs = require(path.join(__dirname, "..", "out", "hook-setup.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hks_"));
const SET = path.join(dir, "settings.json");
const BR = "/home/u/.codex-bridge";
const read = () => JSON.parse(fs.readFileSync(SET, "utf8"));

console.log("[isOurHookCmd] 우리 훅 식별(경계 매칭)");
ok(hs.isOurHookCmd('node "C:/Users/u/.codex-bridge/verify-guard.js"'), "verify-guard 매칭");
ok(!hs.isOurHookCmd("node myverify-guard.js.bak"), "유사 파일명 비매칭");
ok(hs.isOurHookCmd("node contract-inject.js; echo x"), "복합 명령 매칭");

console.log("[detectHooks] 파일 없음/깨짐/부분/완비");
let st = hs.detectHooks(SET);
ok(!st.installed && st.missing.length === 4 && st.unreadable === null, "파일 없음 → 미설치·4개 누락(scout-gate 포함)");
fs.writeFileSync(SET, "{broken", "utf8");
st = hs.detectHooks(SET);
ok(!st.installed && st.unreadable !== null, "JSON 깨짐 → unreadable 표시");
fs.unlinkSync(SET);

console.log("[installHooks] 새 파일 생성(백업 없음) + 3훅 등록");
let r = hs.installHooks(SET, BR, "node");
ok(r.ok && !r.backup, "파일 없던 경우 ok·백업 없음");
let s = read();
ok(Array.isArray(s.hooks.UserPromptSubmit) && Array.isArray(s.hooks.PreToolUse) && Array.isArray(s.hooks.Stop), "3개 이벤트 배열 생성");
ok(s.hooks.PreToolUse[0].matcher === "Bash" && s.hooks.PreToolUse[0].hooks[0].command.indexOf("codex-guard.js") >= 0, "PreToolUse=Bash matcher+codex-guard");
ok(hs.detectHooks(SET).installed, "설치 후 detectHooks=installed");

console.log("[병합] 타인 훅 보존 + 우리 옛 엔트리 교체(중복 없음)");
s = read();
s.hooks.Stop.unshift({ matcher: "", hooks: [{ type: "command", command: "node /x/memento.js" }] }); // 타인 훅
fs.writeFileSync(SET, JSON.stringify(s), "utf8");
r = hs.installHooks(SET, BR, '"C:/Program Files/nodejs/node.exe"');
ok(r.ok && r.backup && fs.existsSync(r.backup), "기존 파일 → 백업 생성");
s = read();
const stopCmds = s.hooks.Stop.flatMap((g) => g.hooks.map((e) => e.command));
ok(stopCmds.some((c) => c.indexOf("memento.js") >= 0), "타인 훅 보존");
ok(stopCmds.filter((c) => c.indexOf("verify-guard.js") >= 0).length === 1, "우리 훅 중복 없이 1개(교체)");
ok(stopCmds.find((c) => c.indexOf("verify-guard.js") >= 0).indexOf('"C:/Program Files/nodejs/node.exe"') === 0, "새 node 토큰으로 갱신");

console.log("[멱등] 재실행해도 이벤트당 우리 훅 1개");
r = hs.installHooks(SET, BR, "node");
s = read();
ok(s.hooks.UserPromptSubmit.flatMap((g) => g.hooks).filter((e) => hs.isOurHookCmd(e.command)).length === 1, "재실행 후에도 1개");

console.log("[손상 방지] 깨진 JSON·이상 형식이면 안 건드리고 중단");
fs.writeFileSync(SET, "{broken", "utf8");
r = hs.installHooks(SET, BR, "node");
ok(!r.ok && fs.readFileSync(SET, "utf8") === "{broken", "깨진 JSON → 실패·원본 그대로");
fs.writeFileSync(SET, JSON.stringify({ hooks: [] }), "utf8");
r = hs.installHooks(SET, BR, "node");
ok(!r.ok, "hooks가 배열(이상 형식) → 중단");

console.log("[hookCommand] install.js와 같은 표기(node토큰 + \"슬래시 경로\")");
ok(hs.hookCommand("node", "C:\\Users\\u\\.codex-bridge", "verify-guard.js") === 'node "C:/Users/u/.codex-bridge/verify-guard.js"', "역슬래시→슬래시·따옴표");

console.log("[resolveNodeToken] 실제 node로 검증(이 테스트가 node로 도니 process.execPath는 진짜 node)");
const tok = hs.resolveNodeToken([process.execPath]);
ok(tok && tok.token.indexOf('"') === 0, "절대경로 후보 → 따옴표 토큰으로 검증 성공");
ok(hs.resolveNodeToken(["Z:/no/such/node.exe"]) === null, "가짜 경로만 → null");

console.log("[install.js 패리티] 두 정본(레포 설치기 ↔ hook-setup)의 규칙 동일성 고정(드리프트 방지)");
const inst = require(path.join(__dirname, "..", "install.js"));
ok(JSON.stringify(inst.OUR_HOOKS) === JSON.stringify(hs.OUR_HOOKS), "OUR_HOOKS(이벤트·matcher·스크립트) 동일");
ok(JSON.stringify(inst.BRIDGE_SCRIPTS) === JSON.stringify(hs.BRIDGE_SCRIPTS), "BRIDGE_SCRIPTS 동일");
const samples = ['node "C:/u/.codex-bridge/verify-guard.js"', "node myverify-guard.js.bak", "node contract-inject.js; echo x", "x codex-guard.js", "unrelated", 'node "verify-guard.js";rm x'];
ok(samples.every((c) => inst.isOurHookCmd(c) === hs.isOurHookCmd(c)), "isOurHookCmd 동작 동일(샘플 6종)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
