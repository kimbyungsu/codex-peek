"use strict";
/*
 * [2026-10-09 실사고] Codex↔Codex 모드에서 작업 전 관문(PreToolUse) 훅이 사용자 훅 파일에 '등록조차 안 된' 상태(8/23 설치 뒤 8/25 추가된 훅)를
 * 하네스가 '신뢰 안 됨'으로 오진하고, 종료 훅이 같은 차례에 126회 '승인하라'를 반복(모델은 사용자에게 승인했는지 되물음)한 결함의 봉합 시험.
 *  ① 갱신 감지: 우리 훅이 있는데 빠진 이벤트=갱신 필요(missingEvents) · 우리 훅 없음=새 설치(갱신 아님) · 다섯 다 있음=불필요
 *  ② 원인 판정: 등록 빠짐(missing) / 등록됨(registered) / 판독 불가(unknown)
 *  ③ 안내 문구: 원인별(등록 빠짐=다시 설치·신뢰 문제 아님 / 등록됨=신뢰 확인) · 종료용은 '한 번 알리고 마침·되묻지 말 것'
 *  ④ 종료 훅 실제 실행: 같은 차례 첫 종료만 막고 두 번째는 막지 않음(무한 반복 차단) · 새 차례에서 다시 1회
 * 격리: 임시 CODEX_BRIDGE_HOME · 임시 CODEX_HOME.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pretool-halt-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pretool-halt-codexhome-"));
fs.mkdirSync(path.join(CODEX_HOME, "sessions"), { recursive: true });
process.env.CODEX_HOME = CODEX_HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const PI = require("../bridge/codex-plugin-install.js");
const CH = require("../bridge/codex-hook.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const hooksFile = path.join(CODEX_HOME, "hooks.json");
const ourCmd = PI.codexPeekHookCommand("node", HOME);
function writeHooks(events) {
  const root = { hooks: {} };
  for (const h of PI.CODEX_PEEK_USER_HOOKS) if (events.includes(h.event)) root.hooks[h.event] = [{ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: ourCmd, commandWindows: ourCmd }] }];
  fs.writeFileSync(hooksFile, JSON.stringify(root, null, 2));
}
const FOUR = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]; // 실사고 모양(8/23 설치본)
const FIVE = PI.CODEX_PEEK_USER_HOOKS.map((h) => h.event);

t("갱신 감지 — 우리 훅이 있는데 PreToolUse 가 빠짐=갱신 필요(missingEvents) · 다섯 다 있음=불필요 · 우리 훅 없음=새 설치(갱신 아님)", () => {
  writeHooks(FOUR);
  const m1 = PI.detectCodexPeekHookMigration(hooksFile, HOME);
  assert.ok(m1.needed && m1.count === 0 && JSON.stringify(m1.missingEvents) === JSON.stringify(["PreToolUse"]), JSON.stringify(m1));
  writeHooks(FIVE);
  const m2 = PI.detectCodexPeekHookMigration(hooksFile, HOME);
  assert.ok(!m2.needed && m2.missingEvents.length === 0, JSON.stringify(m2));
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node other-tool.js" }] }] } }));
  const m3 = PI.detectCodexPeekHookMigration(hooksFile, HOME);
  assert.ok(!m3.needed && m3.missingEvents.length === 0, "남의 훅만 있으면 갱신 대상 아님 " + JSON.stringify(m3));
  // 설치기 재실행이 곧 갱신 경로 — 다섯 훅 전부 다시 씀
  writeHooks(FOUR);
  assert.ok(PI.installCodexPeekUserHooks(hooksFile, HOME, "node").ok);
  assert.ok(!PI.detectCodexPeekHookMigration(hooksFile, HOME).needed && PI.detectCodexPeekUserHooks(hooksFile, HOME).installed, "다시 설치=빠진 훅 추가");
});

t("원인 판정 — 등록 빠짐 / 등록됨 / 판독 불가(모름)", () => {
  writeHooks(FOUR);
  assert.strictEqual(CH.pretoolRegistration(), "missing");
  writeHooks(FIVE);
  assert.strictEqual(CH.pretoolRegistration(), "registered");
  fs.writeFileSync(hooksFile, "{ 깨진 json");
  assert.strictEqual(CH.pretoolRegistration(), "unknown");
});

t("안내 문구 — 원인별 처방 · 종료용은 '한 번 알리고 마침·되묻지 말 것' · 등록 빠짐을 신뢰 문제로 안내하지 않음", () => {
  const miss = CH.pretoolHaltText("missing", true);
  assert.ok(miss.includes("등록돼 있지 않습니다") && miss.includes("신뢰 승인 문제가 아님") && miss.includes("Codex 훅 설치(갱신)") && miss.includes("되묻지 마세요"), miss);
  const reg = CH.pretoolHaltText("registered", true);
  assert.ok(reg.includes("불리지 않는") && reg.includes("훅 파일에는 등록돼 있음") && !reg.includes("등록돼 있지 않습니다") && reg.includes("되묻지 마세요"), reg);
  const unk = CH.pretoolHaltText("unknown", false);
  assert.ok(!unk.includes("되묻지 마세요") && !unk.includes("훅 파일에는 등록돼 있음"), "턴 시작 고지용=종료 지시 없음·등록 여부 단정 없음");
});

t("종료 훅 실제 실행 — 같은 차례 첫 종료만 막고(원인별 문구) 두 번째는 막지 않음 · 새 차례에서 다시 1회 · 서고 꺼짐=무발동", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "pretool-halt-ws-"));
  const sid = "eeeeeeee-0000-1111-2222-" + String(Date.now()).slice(-12).padStart(12, "0");
  fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, harnessMode: "codex-codex", codexVerifyMode: "off", archiveHash: "a".repeat(40) }));
  fs.writeFileSync(path.join(HOME, "links.json"), JSON.stringify({ roleRevision: 1, byWorkspace: { [CL.normWs(ws)]: { workspace: ws, implementerSession: sid, implementerRevision: 1, implementerEventAt: Date.now() - 2000 } } }));
  const turnDir = path.join(HOME, "codex-turns"); fs.mkdirSync(turnDir, { recursive: true });
  const setTurn = (turnId) => fs.writeFileSync(path.join(turnDir, sid + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId, workspace: ws, startedAt: Date.now() - 1000, lastActionAt: 0, modified: false, permissionMode: "default" }));
  fs.mkdirSync(CH.PRETOOL_DIR, { recursive: true });
  fs.writeFileSync(CH.pretoolDistrustFileFor(ws), JSON.stringify({ schema: "codex-pretool-distrust-v1", ts: "T", session: sid, tool: "Bash" }));
  const run = (turnId) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-hook.js")], { input: JSON.stringify({ hook_event_name: "Stop", session_id: sid, turn_id: turnId, cwd: ws, permission_mode: "default" }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CODEX_HOME }), windowsHide: true });
  writeHooks(FOUR); // 실사고 모양
  setTurn("turn-1");
  const r1 = run("turn-1");
  assert.ok(r1.status === 0 && r1.stdout.includes('"decision":"block"') && r1.stdout.includes("등록돼 있지 않습니다"), "첫 종료=막음(등록 빠짐 문구) " + r1.stdout.slice(0, 200) + r1.stderr);
  const r2 = run("turn-1");
  assert.ok(r2.status === 0 && !r2.stdout.includes("PreToolUse"), "같은 차례 두 번째=막지 않음(무한 반복 차단) " + r2.stdout.slice(0, 200));
  const r3 = run("turn-1");
  assert.ok(!r3.stdout.includes("PreToolUse"), "세 번째도 막지 않음");
  writeHooks(FIVE);
  setTurn("turn-2");
  const r4 = run("turn-2");
  assert.ok(r4.stdout.includes('"decision":"block"') && r4.stdout.includes("불리지 않는") && r4.stdout.includes("훅 파일에는 등록돼 있음"), "새 차례=다시 1회 · 등록됨 문구 " + r4.stdout.slice(0, 200));
  assert.ok(!run("turn-2").stdout.includes("PreToolUse"), "새 차례 두 번째=막지 않음");
  // 서고 꺼짐=무발동(불신 표식이 있어도)
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, harnessMode: "codex-codex", codexVerifyMode: "off" }));
  setTurn("turn-3");
  assert.ok(!run("turn-3").stdout.includes("PreToolUse"), "서고 꺼짐=무발동");
});

t("배선 — 종료 분기가 차례당 상한 뒤 일반 관문으로 이어짐(되돌아가지 않음) · 턴 시작 고지도 원인별 문구", () => {
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  assert.strictEqual(CH.MAX_PRETOOL_HALT_BLOCKS, 1);
  assert.ok(/if \(nP9 !== null && nP9 <= MAX_PRETOOL_HALT_BLOCKS\) \{ block\(pretoolHaltText\(pretoolRegistration\(\), true\)\); return; \}\s*\n\s*\}\s*\n\s*\}\s*\n\s*if\(scoutGate\(/.test(src), "상한 뒤에는 막지 않고 다음 관문(scoutGate 이하)으로");
  assert.ok(src.includes("pretoolHaltText(pretoolRegistration(), false)"), "턴 시작 고지=원인별");
  assert.ok(!src.includes("Codex의 훅 신뢰 승인(/hooks)에서 codex-hook의 PreToolUse를 승인하세요"), "옛 문구(등록 빠짐을 신뢰 승인으로 안내) 없음");
});

// [검증 1회차 보완] 대시보드 갱신 제안 — 옛 명령 형식과 등록 빠짐이 겹치면 두 원인을 함께 안내(컴파일 산출물을 가짜 화면 함수로 실제 실행)
(async () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const cut = (head) => { const b = outSrc.indexOf(head); const e = outSrc.indexOf("\n}\n", b); assert.ok(b > 0 && e > b, "조각 추출 " + head); return outSrc.slice(b, e + 2); };
  const body = cut("function codexHookEventsKo(") + cut("async function offerCodexHookMigration(") + "\nreturn offerCodexHookMigration;";
  const run = async (count, missing, owned, pickFirst) => {
    const shown = []; let installed = 0;
    const vscode = { window: {
      showWarningMessage: async (msg, ...rest) => { const btns = rest.filter((b) => typeof b === "string"); shown.push({ kind: "warn", msg }); return pickFirst && btns.length ? btns[0] : undefined; }, // 모달 설정({modal:true})은 버튼이 아님
      showInformationMessage: async (msg) => { shown.push({ kind: "info", msg }); return undefined; },
      showErrorMessage: async (msg) => { shown.push({ kind: "error", msg }); return undefined; },
    } };
    const offer = new Function("vscode", "tE", "codexUserHooksOwned", "installCodexUserRuntimeHooks", "refreshCodexPeekHookTrust", "showCodexHookTrustWarning", "dashboardCodexHookTrustCwd", "codexUserHooksFile", body)(
      vscode, (ko) => ko, () => owned, () => { installed++; return { ok: true }; }, async () => ({ ready: true }), async () => {}, () => "", () => "C:/x/hooks.json");
    await offer("ROOT", count, missing);
    return { shown, installed, text: shown.map((x) => x.msg).join(" || ") };
  };
  n++;
  const both = await run(2, ["PreToolUse"], true, true);
  assert.ok(both.shown[0].msg.includes("옛 명령 형식") && both.shown[0].msg.includes("변경 도구 호출 전 관문(PreToolUse) 훅이 등록돼 있지 않습니다"), "겹침=경고에 두 원인 " + both.shown[0].msg);
  assert.ok(both.installed === 1 && both.text.includes("빠진 변경 도구 호출 전 관문(PreToolUse) 훅도 추가"), "완료 안내에 빠진 훅 추가 " + both.text);
  const manual = await run(1, ["PreToolUse"], false, true);
  assert.ok(manual.installed === 0 && manual.shown[1].msg.includes("빠진 변경 도구 호출 전 관문(PreToolUse) 훅도 같은 형식으로 추가"), "소유 표식 없음=수동 안내에 빠진 훅 추가 " + manual.shown[1].msg);
  const onlyFmt = await run(1, [], true, true);
  const onlyFmtManual = await run(1, [], false, true);
  assert.ok(onlyFmtManual.shown[1].msg.includes("형식으로 직접 바꾼 뒤 재신뢰") && !onlyFmtManual.shown[1].msg.includes("빠진"), "형식만·소유 표식 없음=종전 문구(바꾼 뒤) " + onlyFmtManual.shown[1].msg);
  assert.ok(!onlyFmt.text.includes("등록돼 있지 않습니다") && !onlyFmt.text.includes("빠진"), "형식만=빠진 훅 문구 없음");
  const onlyMiss = await run(0, ["PreToolUse"], true, true);
  assert.ok(onlyMiss.shown[0].msg.includes("등록돼 있지 않습니다") && !onlyMiss.shown[0].msg.includes("옛 명령 형식") && onlyMiss.installed === 1, "빠짐만=다시 설치 안내 " + onlyMiss.shown[0].msg);
  console.log(`  ✅ [${n}] 대시보드 갱신 제안(컴파일 산출물 실제 실행) — 옛 형식+등록 빠짐 겹침=두 원인 함께(경고·수동 안내·완료) · 형식만/빠짐만은 각자 문구`);
  console.log(`\n결과: ${n}/${n} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
