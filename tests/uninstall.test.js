/*
 * uninstall(src/uninstall.ts → out/uninstall.js) + hook-setup.removeHooks — 확장 '완전 제거' 시 정리.
 * 원칙 고정: 표식 있는 것만 정리(확장이 설치한 훅·엔진), 타인 훅·사용자 데이터(links 등)는 보존, 표식 없으면(레포 설치) 무개입.
 */
const os = require("os"), path = require("path"), fs = require("fs");
const hs = require(path.join(__dirname, "..", "out", "hook-setup.js"));
const un = require(path.join(__dirname, "..", "out", "uninstall.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "uni_"));

console.log("[removeHooks] 우리 훅만 제거·타인 보존·백업");
let dir = mk(); let SET = path.join(dir, "settings.json");
hs.installHooks(SET, "/b", "node");
let s = JSON.parse(fs.readFileSync(SET, "utf8"));
s.hooks.Stop.unshift({ matcher: "", hooks: [{ type: "command", command: "node /x/memento.js" }] });
fs.writeFileSync(SET, JSON.stringify(s), "utf8");
let r = hs.removeHooks(SET);
ok(r.ok && r.backup && fs.existsSync(r.backup), "제거 ok + 백업 생성");
s = JSON.parse(fs.readFileSync(SET, "utf8"));
const all = Object.keys(s.hooks || {}).flatMap((e) => (s.hooks[e] || []).flatMap((g) => (g.hooks || []).map((x) => x.command)));
ok(!all.some((c) => hs.isOurHookCmd(c)), "우리 훅 전부 제거");
ok(all.some((c) => c.indexOf("memento.js") >= 0), "타인 훅 보존");
ok(!s.hooks.UserPromptSubmit, "우리만 있던 이벤트 키는 정리");
r = hs.removeHooks(SET);
ok(r.ok && !r.backup, "제거할 것 없으면 무변경(백업도 안 만듦)");
fs.writeFileSync(SET, "{broken", "utf8");
r = hs.removeHooks(SET);
ok(!r.ok && fs.readFileSync(SET, "utf8") === "{broken", "깨진 JSON → 안 건드리고 중단");
ok(hs.removeHooks(path.join(dir, "none.json")).ok, "파일 없음 → ok(제거할 것 없음)");

console.log("[doUninstall] 표식 기반 정리 — 확장 설치분만");
dir = mk();
const BR = path.join(dir, "bridge"), CL = path.join(dir, "claude");
fs.mkdirSync(BR, { recursive: true }); fs.mkdirSync(CL, { recursive: true });
SET = path.join(CL, "settings.json");
// 확장 설치 상태 재현: 훅 설치+표식, 브릿지 배치+stamp, 사용자 데이터
hs.installHooks(SET, BR, "node");
fs.writeFileSync(path.join(BR, "hooks-installed-by-extension"), "t", "utf8");
for (const f of hs.BRIDGE_SCRIPTS) fs.writeFileSync(path.join(BR, f), "//x", "utf8");
fs.writeFileSync(path.join(BR, ".bridge-deployed-by.json"), '{"version":"x"}', "utf8");
fs.writeFileSync(path.join(BR, "links.json"), "{}", "utf8"); // 사용자 데이터
let res = un.doUninstall(BR, CL);
ok(res.hooksRemoved && res.bridgeRemoved, "표식 있음 → 훅·브릿지 정리 보고");
s = JSON.parse(fs.readFileSync(SET, "utf8"));
ok(!Object.keys(s.hooks || {}).length, "설정에서 우리 훅 제거됨");
ok(!fs.existsSync(path.join(BR, "codex-bridge.js")) && !fs.existsSync(path.join(BR, ".bridge-deployed-by.json")), "브릿지 스크립트+stamp 삭제");
ok(fs.existsSync(path.join(BR, "links.json")), "사용자 데이터(links.json) 보존");
ok(!fs.existsSync(path.join(BR, "hooks-installed-by-extension")), "훅 표식 제거");

console.log("[doUninstall] 표식 없음(레포 설치) → 무개입");
dir = mk();
const BR2 = path.join(dir, "bridge"), CL2 = path.join(dir, "claude");
fs.mkdirSync(BR2, { recursive: true }); fs.mkdirSync(CL2, { recursive: true });
hs.installHooks(path.join(CL2, "settings.json"), BR2, "node"); // install.js가 설치한 상황(표식 없음)
for (const f of hs.BRIDGE_SCRIPTS) fs.writeFileSync(path.join(BR2, f), "//x", "utf8");
res = un.doUninstall(BR2, CL2);
ok(!res.hooksRemoved && !res.bridgeRemoved, "표식 없음 → 아무것도 안 함");
s = JSON.parse(fs.readFileSync(path.join(CL2, "settings.json"), "utf8"));
ok(Object.keys(s.hooks).length === 3, "레포 설치 훅 그대로 보존");
ok(fs.existsSync(path.join(BR2, "codex-bridge.js")), "레포 설치 브릿지 그대로 보존");

console.log("[doUninstall] 훅 제거 실패(깨진 설정) → 브릿지도 보존(고아 훅 방지)");
dir = mk();
const BR3 = path.join(dir, "bridge"), CL3 = path.join(dir, "claude");
fs.mkdirSync(BR3, { recursive: true }); fs.mkdirSync(CL3, { recursive: true });
fs.writeFileSync(path.join(CL3, "settings.json"), "{broken", "utf8"); // removeHooks가 실패할 상황
fs.writeFileSync(path.join(BR3, "hooks-installed-by-extension"), "t", "utf8");
for (const f of hs.BRIDGE_SCRIPTS) fs.writeFileSync(path.join(BR3, f), "//x", "utf8");
fs.writeFileSync(path.join(BR3, ".bridge-deployed-by.json"), '{"version":"x"}', "utf8");
res = un.doUninstall(BR3, CL3);
ok(!res.hooksRemoved && !res.bridgeRemoved, "훅 정리 실패 → 브릿지 삭제도 중단");
ok(fs.existsSync(path.join(BR3, "codex-bridge.js")) && fs.existsSync(path.join(BR3, ".bridge-deployed-by.json")), "브릿지 스크립트+stamp 보존(설정의 훅이 계속 동작)");
ok(fs.existsSync(path.join(BR3, "hooks-installed-by-extension")), "훅 표식도 보존(재설치 시 재관리)");
ok(fs.readFileSync(path.join(CL3, "settings.json"), "utf8") === "{broken", "깨진 설정은 안 건드림");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
