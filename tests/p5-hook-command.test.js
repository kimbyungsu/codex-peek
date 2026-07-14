"use strict";
/*
 * P-5(2026-07-15) — Codex 훅 명령 PS·cmd 이중 호환 + 사전검사 + Reload UX + 마이그레이션 + 창로드 오경고.
 * 확정 원인: Codex는 Windows에서 훅을 '감지된 기본 셸(대개 PowerShell) -NoProfile -Command'로 실행하는데,
 * 설치기가 만들던 `"<node절대경로>" "<script>"`는 PS에서 문자열 나열=ParserError 즉사(무로그) — cmd로만
 * 검증하던 사전검사(shell:true)가 이 무효 문자열을 통과시켰다. 훅 실행은 창 리로드 후에만 반영(app-server
 * 가 설치 이전 설정 스냅샷 유지).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const pi = require(path.join(ROOT, "bridge", "codex-plugin-install.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const fwd = (p) => String(p).replace(/\\/g, "/");

console.log("[1] 명령 생성·마이그레이션 판정(순수)");
const BD = "C:/Users/tester/.codex-bridge";
const good = pi.codexPeekHookCommand("node", BD);
ok(good === 'node "C:/Users/tester/.codex-bridge/codex-hook.js"', "bare node + 따옴표 스크립트 경로(슬래시 통일) — PS·cmd 양쪽 유효 형식");
ok(pi.isCodexPeekHookCommand(good, BD) && !pi.codexPeekHookCommandNeedsMigration(good, BD), "새 형식은 우리 훅으로 인식되고 마이그레이션 불필요");
const legacy = '"C:/Program Files/nodejs/node.exe" "C:/Users/tester/.codex-bridge/codex-hook.js"';
ok(pi.isCodexPeekHookCommand(legacy, BD) && pi.codexPeekHookCommandNeedsMigration(legacy, BD), "옛 형식(따옴표 절대경로 시작)은 마이그레이션 필요로 판정");
ok(!pi.codexPeekHookCommandNeedsMigration('"C:/x/node.exe" "C:/elsewhere/other.js"', BD), "우리 훅이 아니면 옛 형식이어도 건드리지 않음(타인 훅 보호)");

console.log("[2] hooks.json 마이그레이션 감지");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p5_"));
const hooksFile = path.join(dir, "hooks.json");
function writeHooks(cmd) {
  const root = { hooks: {} };
  for (const h of pi.CODEX_PEEK_USER_HOOKS) root.hooks[h.event] = [{ hooks: [{ type: "command", command: cmd, commandWindows: cmd }] }];
  fs.writeFileSync(hooksFile, JSON.stringify(root, null, 2));
}
writeHooks(legacy.replace("C:/Users/tester/.codex-bridge", fwd(dir)));
let mig = pi.detectCodexPeekHookMigration(hooksFile, dir);
ok(mig.needed && mig.count === 4, "옛 형식 4훅 → needed·count=4");
writeHooks(pi.codexPeekHookCommand("node", dir));
mig = pi.detectCodexPeekHookMigration(hooksFile, dir);
ok(!mig.needed && mig.count === 0, "새 형식 → 마이그레이션 불필요");
ok(!pi.detectCodexPeekHookMigration(path.join(dir, "none.json"), dir).needed, "파일 부재 → 불필요(fail-open 아님 — 설치 자체가 없음)");
const inst = pi.installCodexPeekUserHooks(hooksFile, dir, "node");
ok(inst.ok && !pi.detectCodexPeekHookMigration(hooksFile, dir).needed, "설치기 재실행이 곧 마이그레이션 경로(우리 훅 제거 후 새 형식 재기입)");
const beforeBytes = fs.readFileSync(hooksFile, "utf8");
const rejected = pi.installCodexPeekUserHooks(hooksFile, dir, '"C:/Program Files/nodejs/node.exe"');
ok(rejected.ok === false && fs.readFileSync(hooksFile, "utf8") === beforeBytes, "writer 불변조건 — 따옴표 시작 토큰은 어떤 호출자도 기입 불가(거부+파일 바이트 불변 · PS 즉사 형식 재발 차단)");
ok(pi.installCodexPeekUserHooks(hooksFile, dir, "").ok === false && pi.installCodexPeekUserHooks(hooksFile, dir, "  ").ok === false, "writer 불변조건 — 빈 토큰 거부");

console.log("[3] 실제 셸 검증(전제 실측) — 옛 형식은 PowerShell에서 실행 불가, bare node는 양쪽 통과");
if (process.platform === "win32") {
  const nodeExeTok = '"' + fwd(process.execPath) + '"'; // 이 테스트를 돌리는 node 자체의 절대경로
  ok(pi.nodeTokenRunsInShell(nodeExeTok, "cmd") === true, "따옴표 절대경로 토큰 — cmd에서는 실행됨(옛 사전검사가 통과시킨 이유)");
  ok(pi.nodeTokenRunsInShell(nodeExeTok, "powershell") === false, "같은 토큰 — PowerShell에서는 실행 안 됨(ParserError·확정 원인 ② 실측)");
  ok(pi.nodeTokenDualShellOk(nodeExeTok) === false, "dual 판정 — 절대경로 토큰 탈락(PS 즉사 형식이 hooks.json에 못 들어감)");
  ok(pi.nodeTokenRunsInShell("node", "powershell") === true && pi.nodeTokenRunsInShell("node", "cmd") === true && pi.nodeTokenDualShellOk("node") === true, "bare node — PS·cmd 양쪽 실행·dual 통과");
} else {
  ok(pi.nodeTokenDualShellOk("node") === true, "posix — 단일 셸 검증 통과");
}

console.log("[4] hook-setup 사전검사 보강(컴파일 산출물 실행)");
const hs = require(path.join(ROOT, "out", "hook-setup.js"));
ok(typeof hs.shellRunsNodePowerShell === "function" && typeof hs.resolveNodeTokenDual === "function", "PS 검증·dual 해석기 내보냄");
if (process.platform === "win32") {
  ok(hs.shellRunsNode('"' + fwd(process.execPath) + '"') === true, "옛 사전검사(shell:true=cmd)는 절대경로 토큰을 여전히 통과시킴 — 이것만으론 부족(보강 근거)");
  ok(hs.shellRunsNodePowerShell('"' + fwd(process.execPath) + '"') === false, "PS 사전검사는 같은 토큰을 탈락시킴");
  const dual = hs.resolveNodeTokenDual(["node", process.execPath]);
  ok(dual !== null && dual.token === "node", "dual 해석 — bare node 첫 후보 채택(절대경로가 앞에 와도 PS 검증에서 자연 탈락)");
  const dualAbs = hs.resolveNodeTokenDual([process.execPath]);
  ok(dualAbs === null, "후보가 절대경로뿐이면 null — 설치가 명시 경고로 중단(PS 즉사 형식을 쓰지 않음)");
}

console.log("[5] 확장 배선(소스 잠금)");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/resolveNodeTokenDual\(\["node",\.\.\.nodeTokenCandidates\(\)\]\)/.test(ext), "Codex 훅 설치 — bare node 첫 후보+dual 검증(확정 원인 ③의 절대경로 우선 순서 제거)");
ok(/PATH의 node가 PowerShell·cmd 양쪽 셸에서 실행되지 않습니다/.test(ext) && /does not run in both PowerShell and cmd/.test(ext), "PATH 미해소 시 명시 경고(한/영)");
ok(/observeCodexHookTrustForReload\(s\);return s;/.test(ext), "모든 신뢰 조회 결과가 리로드 관찰을 거침(계약 ④ — 나중 신뢰 전이도 포착)");
ok(/codexHooksGenAtLoad=codexHooksFileHash\(\); \/\/ 이 창이 로드될 때의 훅 파일 세대/.test(ext), "창 로드 시 훅 파일 세대 캡처(계약 ③ 기준점)");
ok(typeof pi.createCodexHookOfferGate === "function" && typeof pi.createCodexHookReloadTracker === "function", "순서 계약 상태기 2종(게이트·추적기)이 vscode 무의존 라이브러리에 존재 — [6]절이 같은 팩토리를 실행 검증(같은 세대 반복 요구 방지 포함)");
ok(/workbench\.action\.reloadWindow/.test(ext) && /지금 리로드/.test(ext) && /Reload now/.test(ext), "리로드 직접 실행 버튼(계약 ②·한/영)");
ok(/창을 리로드하기 전까지 훅이 실행되지 않습니다/.test(ext) && /hooks will not execute until the window reloads/.test(ext), "리로드 필요 명시(계약 ①·한/영)");
ok(/if\(!queried\)return\{prompt:false,gen:""\};/.test(fs.readFileSync(path.join(ROOT, "bridge", "codex-plugin-install.js"), "utf8")), "조회 실패는 세대·전이 판단 재료에서 제외(추적기 첫 관문 — fail-closed 소비는 유지)");
ok(/if\(auto&&!trust\.queried\)\{codexHookOfferGate\.silentAutoFail\(\);return;\}/.test(ext) && /maybeOfferCodexHookSetup\(context\.extensionUri\.fsPath,true\)/.test(ext), "창로드 오경고 방지 — 자동 진입의 조회 실패는 팝업 없이 게이트만 되돌림(fail-closed는 대시보드 경보 유지), 활성화 경로만 auto");
ok(/const e=codexHookOfferGate\.enter\(auto\);/.test(ext) && /if\(e\.act==="queued"\)\{codexHookOfferQueuedRoot=extensionRoot;return;\}/.test(ext) && /if\(f\.act==="rerun"\)\{const root=codexHookOfferQueuedRoot\|\|extensionRoot;codexHookOfferQueuedRoot=null;await maybeOfferCodexHookSetup\(root,false\);\}/.test(ext), "동시성 배선 — 진입·종료·재실행이 전부 순수 게이트 판정을 소비(손배선 latch 제거)");
ok(/async function maybeOfferCodexHookSetupBody\(extensionRoot:string,auto:boolean\)[\s\S]{0,700}const mig=codexHookMigrationStatus\(\);\s*\n\s*if\(mig\.needed\)\{await offerCodexHookMigration\(extensionRoot,mig\.count\);return;\}[\s\S]{1,600}codexPeekPluginState\(extensionRoot\)/.test(ext), "자동 제안 — 마이그레이션 검사가 플러그인 상태·installed(4/4) 판정보다 앞(플러그인 부재·부분 legacy도 소유권 판정 경로 · Codex 반례)");
ok(/\{const mig=codexHookMigrationStatus\(\);if\(mig\.needed\)\{await offerCodexHookMigration\(extensionRoot,mig\.count\);return false;\}\}\s*\n\s*const existing=await codexPeekPluginState/.test(ext), "설치 흐름 — 동일하게 마이그레이션 최선행(일반 설치 모달의 소유권 인수+재기입에 도달 불가)");
ok(/codexHookReloadTracker\.observe\(s\.queried,s\.ready,codexHooksFileHash\(\),codexHooksGenAtLoad,s\.trusted,s\.untrusted\)/.test(ext) && /if\(r\.prompt\)void promptCodexHookReload\(\);/.test(ext), "리로드 관찰 배선 — 모든 조회 결과가 순수 추적기 판정을 소비");
ok(/설정상 네 훅의 신뢰가 확인됐습니다/.test(ext) && /confirmed trusted in configuration/.test(ext) && !/신뢰된 실행 상태로 확인됐습니다/.test(ext), "재확인 성공 문구 — hooks\/list는 설정상 신뢰만 증명(현재 코어 runnable 단정 제거·한/영)");
ok(/훅 설치·신뢰·창 리로드가 끝난 상태라면/.test(ext) && /installed, trusted, and the window reloaded/.test(ext), "C-C 모드 클릭 안내 — 무조건 자동 고정 단정 제거(한/영)");
ok(/훅이 설치·신뢰되고 창 리로드로 반영된 상태에서/.test(ext) && /applied via a window reload/.test(ext), "구현 미고정 경보 — 훅 선행조건 명시(한/영)");
ok(/async function maybeOfferCodexHookSetup\(extensionRoot:string,auto=false\)/.test(ext), "명시 진입(모드 클릭 등)은 auto=false — 조회 실패도 안내");
ok(/if\(!state\.queried\)\{/.test(ext) && /훅 설정이 바뀐 것도 아닙니다/.test(ext) && /does not mean your hooks changed/.test(ext), "조회 실패 문구 분리 — 재신뢰로 오도하지 않음(한/영)");
ok(/codexHookMigrationStatus\(\)/.test(ext) && /offerCodexHookMigration\(extensionRoot,mig\.count\)/.test(ext) && ext.split("offerCodexHookMigration(extensionRoot,mig.count)").length === 3, "마이그레이션 — 자동 제안·설치 흐름 두 입구 모두 선확인");
ok(/소유 표식이 없어 자동으로 바꾸지 않습니다/.test(ext) && /no ownership marker/.test(ext), "소유 표식 없으면 자동 교체 금지(타 설치 경로 보호·한/영)");
ok(/다시 신뢰한 뒤 창을 리로드하세요/.test(ext) && /re-trust the four hooks/.test(ext), "마이그레이션 후 재신뢰+리로드 안내(한/영)");
ok(/사용자 훅\(hooks\.json\)이 등록돼 있지만/.test(ext) && /user hooks \(hooks\.json\) are registered/.test(ext), "경고 주어를 실제 실행 권위(사용자 hooks.json)로 정정(P-5 머리 항목·한/영)");
ok(/플러그인 설치·네 훅 신뢰·창 리로드/.test(ext) && /trust all four hooks, reload the window/.test(ext), "온보딩 힌트에 창 리로드 단계 명시(문구 정정 ⑤·한/영)");
ok(/신뢰를 마친 뒤 창을 리로드해야 훅이 실행되며/.test(ext) && /reload the window so the hooks actually execute/.test(ext), "신뢰 방법 안내에 리로드 조건(한/영)");
const hsSrc = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8");
ok(/shellRunsNodePowerShell/.test(hsSrc) && /-NoProfile/.test(hsSrc) && /resolveNodeTokenDual/.test(hsSrc), "hook-setup 사전검사에 PowerShell 검증 추가(ⓑ)");

console.log("[6] 순서 계약 실행 — 확장이 소비하는 '같은 팩토리'를 직접 구동(Codex 요구: 정규식만으론 경합 의미 변화를 못 잠금)");
// 게이트: auto 실행 중 명시 진입 큐→종료 후 정확히 1회 재실행, auto 1회 제한, 조용 실패는 auto 재시도 허용
let g = pi.createCodexHookOfferGate();
ok(g.enter(true).act === "run", "G① 최초 auto 진입=run");
ok(g.enter(false).act === "queued" && g.state().queued === true, "G② 실행 중 명시 진입=queued(즉시 실행 금지 — 경합 유실 반례 봉합)");
ok(g.enter(true).act === "skip", "G③ 실행 중 auto 재진입=skip(큐에 안 쌓임)");
ok(g.finish().act === "rerun" && g.state().queued === false, "G④ 종료 시 rerun 지시+큐 소비(정확히 1회)");
ok(g.enter(false).act === "run" && g.finish().act === "idle", "G⑤ 재실행은 명시 진입으로 run — 두 번째 finish는 idle(큐 중복 소비 없음)");
ok(g.enter(true).act === "skip", "G⑥ 안내를 이미 보여준 창의 auto 재진입=skip(창당 1회)");
ok(g.enter(false).act === "run", "G⑦ 명시 진입은 latch 무관 항상 run(사용자 행동)");
g.silentAutoFail(); g.finish();
ok(g.enter(true).act === "run", "G⑧ 조용 실패(무팝업) 후엔 auto 재시도 허용(안내를 못 받은 창이 영구 침묵하지 않음)");
g.finish();
// 추적기: 최초 ready 무권고·설치(해시 변경) 권고 1회·재신뢰 전이마다 권고·같은 세대 중복 금지·조회 실패 무시
let tr = pi.createCodexHookReloadTracker();
ok(tr.observe(false, true, "h1", "h1", 4, 0).prompt === false, "T① 조회 실패(queried=false)는 무시 — 세대 판단 재료 아님");
ok(tr.observe(true, true, "h1", "h1", 4, 0).prompt === false, "T② 최초 관측이 ready+파일 그대로 → 무권고(이미 반영된 창에 불필요한 재시작 요구 금지 · 계약 ③)");
ok(tr.observe(true, true, "h2", "h1", 4, 0).prompt === true, "T③ 훅 파일이 창 로드 후 변경(설치·마이그레이션)+ready → 권고(계약 ①)");
ok(tr.observe(true, true, "h2", "h1", 4, 0).prompt === false, "T④ 같은 세대 재관측 → 중복 권고 없음(계약 ③)");
ok(tr.observe(true, false, "h2", "h1", 3, 1).prompt === false, "T⑤ 신뢰 해제(unready) → 권고 없음");
ok(tr.observe(true, true, "h2", "h1", 4, 0).prompt === true, "T⑥ 재신뢰(unready→ready 재전이) → 새 세대로 다시 권고(Codex 반례: 두 번째 전이 누락)");
ok(tr.observe(true, false, "h2", "h1", 3, 1).prompt === false && tr.observe(true, true, "h2", "h1", 4, 0).prompt === true, "T⑦ 세 번째 전이도 각각 권고");
let tr2 = pi.createCodexHookReloadTracker();
ok(tr2.observe(true, false, "h1", "h1", 2, 2).prompt === false && tr2.observe(true, true, "h1", "h1", 4, 0).prompt === true, "T⑧ 최초 관측이 미준비였던 창 — 이후 ready에서 권고(계약 ④: 신뢰가 나중에 완료)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
