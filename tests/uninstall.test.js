/*
 * uninstall(src/uninstall.ts → out/uninstall.js) + hook-setup.removeHooks — 확장 '완전 제거' 시 정리.
 * 원칙 고정: 표식 있는 것만 정리(확장이 설치한 훅·엔진), 타인 훅·사용자 데이터(links 등)는 보존, 표식 없으면(레포 설치) 무개입.
 */
const os = require("os"), path = require("path"), fs = require("fs");
const hs = require(path.join(__dirname, "..", "out", "hook-setup.js"));
const un = require(path.join(__dirname, "..", "out", "uninstall.js"));
const pi = require(path.join(__dirname, "..", "bridge", "codex-plugin-install.js"));
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

console.log("[doUninstall] Codex 홈 변경 — 표식에 기록된 모든 hooks.json 정리");
dir = mk();
const BR4=path.join(dir,"bridge"),CL4=path.join(dir,"claude"),HOME_A=path.join(dir,"codex-a"),HOME_B=path.join(dir,"codex-b"),HOME_NOW=path.join(dir,"codex-now");
fs.mkdirSync(BR4,{recursive:true});fs.mkdirSync(CL4,{recursive:true});
const codexFlag=path.join(BR4,"codex-hooks-installed-by-extension");
fs.writeFileSync(path.join(BR4,"codex-hook.js"),"// runtime","utf8");
pi.installCodexPeekOwnedUserHooks(path.join(HOME_A,"hooks.json"),BR4,"node",codexFlag);
pi.installCodexPeekOwnedUserHooks(path.join(HOME_B,"hooks.json"),BR4,"node",codexFlag);
for(const f of hs.BRIDGE_SCRIPTS)fs.writeFileSync(path.join(BR4,f),"//x","utf8");
fs.writeFileSync(path.join(BR4,".bridge-deployed-by.json"),'{"version":"x"}',"utf8");
res=un.doUninstall(BR4,CL4,HOME_NOW);
ok(res.codexHooksRemoved&&res.bridgeRemoved,"현재 홈과 달라도 기록된 Codex 훅과 브릿지 정리");
ok(pi.detectCodexPeekUserHooks(path.join(HOME_A,"hooks.json"),BR4).missing.length===4&&pi.detectCodexPeekUserHooks(path.join(HOME_B,"hooks.json"),BR4).missing.length===4,"옛·새 Codex 홈 양쪽에서 우리 훅 제거");
ok(!fs.existsSync(codexFlag),"모든 훅 제거 확인 뒤 Codex 소유 표식 제거");

console.log("[doUninstall] Codex 소유 표식 손상 — 런타임 보존");
dir=mk();const BR5=path.join(dir,"bridge"),CL5=path.join(dir,"claude");fs.mkdirSync(BR5,{recursive:true});fs.mkdirSync(CL5,{recursive:true});
fs.writeFileSync(path.join(BR5,"codex-hooks-installed-by-extension"),"timestamp-only","utf8");for(const f of hs.BRIDGE_SCRIPTS)fs.writeFileSync(path.join(BR5,f),"//x","utf8");fs.writeFileSync(path.join(BR5,".bridge-deployed-by.json"),'{"version":"x"}',"utf8");
res=un.doUninstall(BR5,CL5);
ok(!res.codexHooksRemoved&&!res.bridgeRemoved,"손상된 표식은 실패로 닫고 브릿지를 남김");
ok(fs.existsSync(path.join(BR5,"codex-hook.js"))&&fs.existsSync(path.join(BR5,"codex-hooks-installed-by-extension")),"실행 대상과 재관리 표식 보존");

console.log("[doUninstall] 기록된 hooks.json이 이미 없으면 잔존 없음 확인 후 정리");
dir=mk();const BR6=path.join(dir,"bridge"),CL6=path.join(dir,"claude"),HOME6=path.join(dir,"codex");fs.mkdirSync(BR6,{recursive:true});fs.mkdirSync(CL6,{recursive:true});const flag6=path.join(BR6,"codex-hooks-installed-by-extension");fs.writeFileSync(path.join(BR6,"codex-hook.js"),"// runtime","utf8");pi.installCodexPeekOwnedUserHooks(path.join(HOME6,"hooks.json"),BR6,"node",flag6);fs.unlinkSync(path.join(HOME6,"hooks.json"));for(const f of hs.BRIDGE_SCRIPTS)fs.writeFileSync(path.join(BR6,f),"//x","utf8");fs.writeFileSync(path.join(BR6,".bridge-deployed-by.json"),'{"version":"x"}',"utf8");
res=un.doUninstall(BR6,CL6);
ok(res.codexHooksRemoved&&res.bridgeRemoved,"removed 0이어도 실제 잔존 훅이 없을 때만 정리 성공");

console.log("[doUninstall] 실제 제거와 후발 설치 경합 — 같은 owner lock 경계");
dir=mk();const BR7=path.join(dir,"bridge"),CL7=path.join(dir,"claude"),HOME7=path.join(dir,"codex"),LATE7=path.join(dir,"late-codex","hooks.json");fs.mkdirSync(BR7,{recursive:true});fs.mkdirSync(CL7,{recursive:true});for(const f of hs.BRIDGE_SCRIPTS)fs.writeFileSync(path.join(BR7,f),"//x","utf8");fs.writeFileSync(path.join(BR7,".bridge-deployed-by.json"),'{"version":"x"}',"utf8");const flag7=path.join(BR7,"codex-hooks-installed-by-extension");pi.installCodexPeekOwnedUserHooks(path.join(HOME7,"hooks.json"),BR7,"node",flag7);
const worker7=path.join(dir,"race-worker.js"),entered7=path.join(dir,"uninstall-entered"),release7=path.join(dir,"release"),attempt7=path.join(dir,"install-attempted"),doneUn7=path.join(dir,"uninstall-done"),doneIn7=path.join(dir,"install-done");
fs.writeFileSync(worker7,`
const fs=require("fs"),un=require(${JSON.stringify(path.join(__dirname,"..","out","uninstall.js"))}),pi=require(${JSON.stringify(path.join(__dirname,"..","bridge","codex-plugin-install.js"))});
const [mode,br,cl,hook,entered,release,done]=process.argv.slice(2);let r;
if(mode==="uninstall")r=un.doUninstall(br,cl,undefined,{onCodexOwnerLock(){fs.writeFileSync(entered,"1");while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});
else{fs.writeFileSync(entered,"attempted");r=pi.installCodexPeekOwnedUserHooks(hook,br,"node",require("path").join(br,"codex-hooks-installed-by-extension"));}
fs.writeFileSync(done,JSON.stringify(r));
`);
const waitForFile=(f,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end&&!fs.existsSync(f))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return fs.existsSync(f);};
require("child_process").spawn(process.execPath,[worker7,"uninstall",BR7,CL7,"-",entered7,release7,doneUn7],{stdio:"ignore"});ok(waitForFile(entered7),"실제 doUninstall이 owner lock 안에 진입");require("child_process").spawn(process.execPath,[worker7,"install",BR7,CL7,LATE7,attempt7,"-",doneIn7],{stdio:"ignore"});ok(waitForFile(attempt7),"후발 설치가 같은 lock을 시도");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);ok(!fs.existsSync(doneIn7),"제거가 lock을 쥔 동안 후발 설치 완료 불가");fs.writeFileSync(release7,"1");ok(waitForFile(doneUn7)&&waitForFile(doneIn7),"제거 완료 후 후발 설치가 순서대로 종료");const actualUn=JSON.parse(fs.readFileSync(doneUn7)),actualIn=JSON.parse(fs.readFileSync(doneIn7));ok(actualUn.codexHooksRemoved&&actualUn.bridgeRemoved,"실제 uninstall이 훅 잔존 확인 후 runtime 삭제");ok(actualIn.ok===false&&!fs.existsSync(LATE7),"후발 설치는 runtime 부재로 거부되어 dangling hook 없음");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
