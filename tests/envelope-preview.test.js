"use strict";
/*
 * [Envelope Selector v7 §4 — 4b-1] 이중 배달 Claude 경로 실행 시험: selector-preview CLI(영수증 purpose:preview)·
 * PreToolUse 게이트(무영수증=지속 차단·preview 명령 예외·미도입/스냅샷 부재=무발동)·구현자 주입(코어 ab 전문+
 * 턴 결속 선별 캐시/안내)·설치기 등록 핀·배포 누락 봉합(selector-runner) 핀.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "selpv-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
let n = 0;
const t = (name) => { n++; console.log(`  ✅ [${n}] ${name}`); };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "selpv-ws-"));
const CLI = path.join(__dirname, "..", "bridge", "codex-bridge.js");
const GATE = path.join(__dirname, "..", "bridge", "preview-gate.js");
const INJECT = path.join(__dirname, "..", "bridge", "contract-inject.js");

const coreObj = { schema: "verify-envelope-v1", supportedEnv: ["로컬"], alwaysBlocker: ["로컬 실패 시 무승인 원격 전달 금지"], outOfScope: ["다중 배포"] };
const coreRaw = JSON.stringify(coreObj, null, 1);
fs.writeFileSync(path.join(WS, CL.ENVELOPE_FILE), coreRaw);
assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, sha1(coreRaw)), 2);
const arcObj = { schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업을 남긴다", "고객 기록은 지우지 않는다"] };
const arcText = JSON.stringify(arcObj, null, 1);
fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), arcText);
const ARC_HASH = sha1(arcText);
assert.strictEqual(CL.setContractHashAllSlots(WS, "archiveHash", ARC_HASH), 2);

// 가짜 페이지 실행기(공용 루프는 실물) — 첫 항목 선택
const SELDIR = fs.mkdtempSync(path.join(os.tmpdir(), "selpv-fake-"));
const fakeSel = path.join(SELDIR, "fake-selector.js");
fs.writeFileSync(fakeSel, [
  "function runSelectorPage({arm,prompt,timeoutMs}){",
  "  const promise=new Promise((resolve)=>{setTimeout(()=>{",
  '    const ids=[...prompt.matchAll(/^(arc-\\d+): /gm)].map((m)=>m[1]);',
  '    resolve({ok:true,output:JSON.stringify({relevant:ids.slice(0,1)})});',
  "  },30);});",
  "  return {promise,cancel:()=>{}};",
  "}",
  "module.exports={runSelectorPage};",
].join("\n"));

// 구현 턴 스냅샷(활성 세션 앵커)
const SNAP = "이번 작업: 백업 정책 지키며 스크립트 수정";
const ANCHOR = "anchPv01";
fs.mkdirSync(path.dirname(CL.constraintTurnFileFor(WS, ANCHOR)), { recursive: true });
fs.writeFileSync(CL.constraintTurnFileFor(WS, ANCHOR), SNAP);
const SNAP_HASH = sha1(SNAP);
const SESS = "sessPreview01";
fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
const writeActive = () => fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: WS, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: ANCHOR, constraintSourceHash: SNAP_HASH }));
writeActive();
const ENV = { ...process.env, CODEX_BRIDGE_HOME: HOME, CODEX_BRIDGE_SELECTOR_RUNNER: fakeSel, CLAUDE_CODE_SESSION_ID: SESS };
const gatePayload = (tool, extra) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, session_id: SESS, cwd: WS, tool_input: extra || {} });
const runGate = (payload, env) => cp.spawnSync(process.execPath, [GATE], { encoding: "utf8", input: payload, env: env || ENV, timeout: 15000 });

// [1] 게이트: 활성+스냅샷+무영수증=변경 도구 지속 차단·preview 명령 예외·미도입/스냅샷 부재=무발동
{
  const rE = runGate(gatePayload("Edit", { file_path: "a.js" }));
  assert.strictEqual(rE.status, 2, "Edit 차단: " + rE.stderr);
  assert.match(rE.stderr, /selector-preview/);
  const rB = runGate(gatePayload("Bash", { command: "npm test" }));
  assert.strictEqual(rB.status, 2, "일반 Bash 차단(변경 가능 도구)");
  const rM = runGate(gatePayload("mcp__memento__remember", { x: 1 }));
  assert.strictEqual(rM.status, 2, "MCP 차단(이름으로 읽기/쓰기 구분 불가=보수 전종)");
  const rP = runGate(gatePayload("Bash", { command: `node "${CLI}" selector-preview` }));
  assert.strictEqual(rP.status, 0, "★허용 예외=preview 실행 명령 자체(전체 정확 일치)");
  // [1차 blocker② 반례] 지문을 '담기만 한' 일반 쓰기·연결 명령은 예외 아님(부분 문자열 검사 폐기)
  assert.strictEqual(runGate(gatePayload("Bash", { command: "echo node codex-bridge.js selector-preview > preview-note.txt" })).status, 2, "★지문 포함 쓰기 명령=차단");
  assert.strictEqual(runGate(gatePayload("Bash", { command: `node "${CLI}" selector-preview && rm -rf x` })).status, 2, "★연결 명령=차단(후행 실행 밀반입 금지)");
  // [2차 blocker② 반례] 토큰 정체=basename 정확 일치 — 유사 이름 실행 통과 금지
  assert.strictEqual(runGate(gatePayload("Bash", { command: "node fake-codex-bridge.js selector-preview" })).status, 2, "★유사 이름 스크립트=차단");
  assert.strictEqual(runGate(gatePayload("Bash", { command: "ts-node codex-bridge.js selector-preview" })).status, 2, "★유사 이름 실행기=차단");
  assert.strictEqual(runGate(gatePayload("Bash", { command: "notnode notcodex-bridge selector-preview" })).status, 2, "★접미사 위장=차단");
  const WSN = fs.mkdtempSync(path.join(os.tmpdir(), "selpv-nada-"));
  assert.strictEqual(runGate(JSON.stringify({ tool_name: "Edit", session_id: SESS, cwd: WSN, tool_input: {} })).status, 0, "미도입=무발동");
  assert.strictEqual(runGate(JSON.stringify({ tool_name: "Edit", session_id: "noActiveSess", cwd: WS, tool_input: {} })).status, 0, "스냅샷 부재=무발동(뒤 관문 fail-closed)");
  t("PreToolUse 게이트: 무영수증=Edit·Bash·MCP 지속 차단·preview 명령 예외·미도입/스냅샷 부재=무발동");
}
// [2] 주입(무영수증 국면): 코어 ab 전문+selector-preview 안내 줄
{
  const r = cp.spawnSync(process.execPath, [INJECT], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESS, cwd: WS, prompt: SNAP }), env: ENV, timeout: 20000 });
  const out = JSON.parse(r.stdout || "{}");
  const ctx = (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || "";
  assert.ok(ctx.includes("[수칙 인지 — 코어 절대 차단(ab) 전문") && ctx.includes("> ab-1: " + coreObj.alwaysBlocker[0]), "코어 ab 전문 상시 주입(구현자 인지)");
  assert.ok(ctx.includes("selector-preview"), "무영수증 국면=미리보기 안내 줄(관문 예고)");
  writeActive(); // 주입이 active를 갱신했으므로 앵커 픽스처 복원(아래 시험의 결정론)
  fs.writeFileSync(CL.constraintTurnFileFor(WS, ANCHOR), SNAP);
  t("구현자 주입: 코어 ab 전문 상시+무영수증=selector-preview 안내(이중 배달 ①)");
}
// [3] selector-preview CLI: 선별 목록 출력+영수증(purpose:preview·이 턴 스냅샷 결속)
{
  const r = cp.spawnSync(process.execPath, [CLI, "selector-preview"], { cwd: WS, encoding: "utf8", env: ENV, timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("[이번 작업 선별 수칙(참고") && r.stdout.includes("> arc-1: " + arcObj.alwaysBlocker[0]), "선별 목록 출력(구현자 인지 채널): " + r.stdout.slice(0, 200));
  const recs = CL.readSelectorUsage().filter((x) => x.purpose === "preview");
  assert.ok(recs.length === 1 && recs[0].snapshotHash === SNAP_HASH && recs[0].archiveHash === ARC_HASH && recs[0].askId === "" && recs[0].selectedIds.length === 1, "영수증 purpose:preview·이 턴 스냅샷+현행 서고 결속");
  assert.ok(recs[0].wsKey === CL.wsKeyFor(WS) && recs[0].turnAnchor === ANCHOR, "★영수증 4중 결속 필드(wsKey·turnAnchor — 1차 blocker①)");
  t("selector-preview: 같은 실행기·중립 입력으로 선별→목록 출력+영수증(read-back 관문)");
}
// [4] 영수증 후: 게이트 통과(무접촉)+재사용 반례(타 프로젝트·과거 턴=차단)+주입 캐시 절
{
  assert.strictEqual(runGate(gatePayload("Edit", { file_path: "a.js" })).status, 0, "★영수증 후=게이트 통과(이후 무접촉)");
  // [1차 blocker① 반례 a] 같은 서고·같은 문구의 '다른 프로젝트' — WS의 영수증이 WS2 게이트를 못 연다(wsKey 결속)
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "selpv-ws2-"));
  fs.writeFileSync(path.join(WS2, CL.ENVELOPE_FILE), coreRaw);
  CL.setEnvelopeHashAllSlots(WS2, sha1(coreRaw));
  fs.writeFileSync(path.join(WS2, CL.ARCHIVE_FILE), arcText);
  CL.setContractHashAllSlots(WS2, "archiveHash", ARC_HASH);
  fs.writeFileSync(CL.constraintTurnFileFor(WS2, ANCHOR), SNAP);
  const SESS2 = "sessPreviewOther";
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS2 + ".json"), JSON.stringify({ workspace: WS2, claudeSession: SESS2, ts: new Date().toISOString(), constraintAnchor: ANCHOR, constraintSourceHash: SNAP_HASH }));
  const rX = runGate(JSON.stringify({ tool_name: "Edit", session_id: SESS2, cwd: WS2, tool_input: {} }));
  assert.strictEqual(rX.status, 2, "★타 프로젝트 재사용 차단(같은 서고·같은 문구·같은 앵커라도 wsKey 불일치)");
  // [1차 blocker① 반례 b] 같은 프로젝트·같은 문구의 '다른 턴'(앵커 상이) — 과거 영수증 재사용 차단
  const ANCHOR2 = "anchPv02";
  fs.writeFileSync(CL.constraintTurnFileFor(WS, ANCHOR2), SNAP);
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, SESS + ".json"), JSON.stringify({ workspace: WS, claudeSession: SESS, ts: new Date().toISOString(), constraintAnchor: ANCHOR2, constraintSourceHash: SNAP_HASH }));
  assert.strictEqual(runGate(gatePayload("Edit", { file_path: "a.js" })).status, 2, "★같은 문구라도 다른 턴(앵커)=차단(턴마다 fresh 미리보기)");
  writeActive(); // 원 앵커 복원
  // [2차 blocker① 반례] 캐시도 4중 결속 — 같은 문구의 '새 턴'(inject가 새 앵커 발급)에는 과거 턴 선별이
  // '이 턴 결속'으로 위장 주입되지 않는다(안내 줄로 강등). 정방향은 같은 앵커 직접 호출로 확인.
  const rN = cp.spawnSync(process.execPath, [INJECT], { encoding: "utf8", input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESS, cwd: WS, prompt: SNAP }), env: ENV, timeout: 20000 });
  const ctxN = ((JSON.parse(rN.stdout || "{}").hookSpecificOutput || {}).additionalContext) || "";
  assert.ok(!ctxN.includes("[이번 작업 선별 수칙(참고") && ctxN.includes("selector-preview"), "★새 턴(새 앵커)=과거 영수증 캐시 미주입·안내로 강등: " + ctxN.slice(-200));
  writeActive(); fs.writeFileSync(CL.constraintTurnFileFor(WS, ANCHOR), SNAP);
  const pos = CL.implementerEnvelopeInject(WS, CL.loadContract(WS, "ko"), "ko", SNAP_HASH, ANCHOR);
  assert.ok(pos.includes("[이번 작업 선별 수칙(참고") && pos.includes("> arc-1: " + arcObj.alwaysBlocker[0]), "★같은 턴(앵커 일치)=캐시 절 주입(4중 결속 정방향)");
  const neg = CL.implementerEnvelopeInject(WS, CL.loadContract(WS, "ko"), "ko", SNAP_HASH, "anchOther99");
  assert.ok(!neg.includes("[이번 작업 선별 수칙(참고"), "다른 앵커=캐시 배제(직접 호출 반례)");
  t("영수증 후: 게이트 열림+캐시 4중 결속(같은 턴만 주입·새 턴/타 프로젝트=배제·이중 배달 ②)");
}
// [5] 드리프트·미도입 CLI 거동
{
  const keep = fs.readFileSync(path.join(WS, CL.ARCHIVE_FILE), "utf8");
  fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["바뀐 판"] }, null, 1));
  const rD = cp.spawnSync(process.execPath, [CLI, "selector-preview"], { cwd: WS, encoding: "utf8", env: ENV, timeout: 30000 });
  assert.notStrictEqual(rD.status, 0, "서고 드리프트=거부");
  fs.writeFileSync(path.join(WS, CL.ARCHIVE_FILE), keep);
  const WSN = fs.mkdtempSync(path.join(os.tmpdir(), "selpv-none-"));
  const rN = cp.spawnSync(process.execPath, [CLI, "selector-preview"], { cwd: WSN, encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: "" }, timeout: 30000 });
  assert.ok(rN.status === 0 && /미도입|not adopted/.test(rN.stdout), "미도입=정직 안내 후 무동작");
  t("selector-preview 방어: 서고 드리프트=거부·미도입=안내(빈 재료 선별 없음)");
}
// [6] 설치기·배포 편입·공용 루프 소스 핀
{
  const inst = fs.readFileSync(path.join(__dirname, "..", "install.js"), "utf8");
  assert.ok(inst.includes('"selector-runner.js"'), "★3a 신설분 selector-runner.js 배포 편입(누락=설치본 선별 deps 실패)");
  assert.ok(inst.includes('"preview-gate.js"') && inst.includes('matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*", script: "preview-gate.js"'), "게이트 훅 설치 등록(변경 도구 전종 matcher)");
  assert.ok(/OUR_SCRIPT_NAMES = \[[^\]]*"preview-gate\.js"/.test(inst), "우리 훅 식별 목록 등재(정리·중복 방지)");
  const worker = fs.readFileSync(path.join(__dirname, "..", "bridge", "ask-job-worker.js"), "utf8");
  assert.ok(worker.includes("SR.runSelectorPages({") && !/while \(\(next < pages\.length/.test(worker), "worker=공용 페이지 루프 사용(실행 규약 단일 출처)");
  const cb = fs.readFileSync(CLI, "utf8");
  assert.ok(cb.includes('case "selector-preview":') && cb.includes('purpose: "preview"'), "preview 명령·영수증 purpose 배선");
  assert.ok(cb.includes('r0.purpose==="preview"&&r0.wsKey===wk0&&r0.turnAnchor===constraintCtx.turnAnchor&&r0.snapshotHash===constraintCtx.sourceHash'), "ask-start=4중 결속(wsKey·turnAnchor·snapshot·archive) preview 영수증 선행 조건");
  const priv = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
  assert.ok(priv.includes("서고 수칙 자동 선별") && priv.includes("구현 턴과 같은 경로로만"), "PRIVACY 고지 확장(같은 provider 한정·목적·내용·기록)");
  t("설치기 등록·배포 편입 봉합·공용 루프·ask-start 조건·PRIVACY 소스 핀");
}
// [7] [4b-2] 공용 관문 판정기(previewGateDecision) — Claude·Codex가 같은 함수(런타임별 분기 없음)
{
  const base = { archiveHash: ARC_HASH, turnAnchor: ANCHOR, snapshotHash: SNAP_HASH, wsKey: CL.wsKeyFor(WS) };
  const rec = { purpose: "preview", wsKey: CL.wsKeyFor(WS), turnAnchor: ANCHOR, snapshotHash: SNAP_HASH, archiveHash: ARC_HASH };
  assert.strictEqual(CL.previewGateDecision({ ...base, archiveHash: "", toolName: "Edit" }), "allow-inactive", "미도입=무발동");
  assert.strictEqual(CL.previewGateDecision({ ...base, turnAnchor: "", toolName: "Edit" }), "allow-nosnapshot", "스냅샷 부재=무발동(ask-start fail-closed)");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "Read" }), "allow-readonly", "읽기 도구=허용");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "apply_patch", receipts: [] }), "block", "Codex 변경 도구(apply_patch)=차단");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "Bash", command: `node "${CLI}" selector-preview`, receipts: [] }), "allow-preview-cmd", "예외=미리보기 명령 전체 정확 일치");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "Bash", command: "node fake-codex-bridge.js selector-preview", receipts: [] }), "block", "유사 이름=차단(공용 판정)");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "Edit", receipts: [rec] }), "allow-receipt", "4중 결속 영수증=통과");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "Edit", receipts: [{ ...rec, turnAnchor: "otherTurn" }] }), "block", "다른 턴 영수증=차단");
  assert.strictEqual(CL.previewGateDecision({ ...base, toolName: "Edit", receipts: [{ ...rec, wsKey: "deadbeefdeadbeef" }] }), "block", "타 프로젝트 영수증=차단");
  const pg = fs.readFileSync(path.join(__dirname, "..", "bridge", "preview-gate.js"), "utf8");
  assert.ok(pg.includes("CL.previewGateDecision({") && !pg.includes("selector-preview\\b"), "Claude 게이트=공용 판정기 사용(자체 regex 사본 폐기)");
  t("공용 관문 판정기: 미도입/스냅샷/읽기/예외/4중 결속 전 분기+Claude 게이트 단일 출처");
}
// [8] [4b-2] Codex 경로: PreToolUse 표식·불신 플래그 왕복+등록 5종+배선 소스 핀
{
  const CH = require("../bridge/codex-hook.js");
  const PI = require("../bridge/codex-plugin-install.js");
  // [확인검증 blocker① 반례] 구현자 아닌 세션의 PreToolUse는 표식만 남기고 '불신 플래그를 지우지 못한다'
  // (타 세션 실측이 구현 세션의 중단을 풀어주는 경로 차단 — 해제는 sameImplementer 세션의 실측만).
  fs.mkdirSync(CH.PRETOOL_DIR, { recursive: true });
  fs.writeFileSync(CH.pretoolDistrustFileFor(WS), JSON.stringify({ schema: "codex-pretool-distrust-v1", ts: "T", session: "sX", tool: "Edit" }));
  CH.onPreTool({ tool_name: "Edit", turn_id: "t1" }, WS, "sessCodexPre01", CL.loadContract(WS, "ko"));
  assert.ok(fs.existsSync(CH.pretoolMarkerFile("sessCodexPre01")), "★PreToolUse 실측 표식 기록(세션별 파일)");
  assert.ok(fs.existsSync(CH.pretoolDistrustFileFor(WS)), "★비구현자 세션의 실측=불신 플래그 존속(교차 세션 해제 차단)");
  fs.rmSync(CH.pretoolDistrustFileFor(WS), { force: true });
  // 등록 5종(사전 관문 편입)
  assert.ok(PI.CODEX_PEEK_HOOK_EVENTS.includes("preToolUse") && PI.CODEX_PEEK_USER_HOOKS.some((h) => h.event === "PreToolUse" && /Bash\|apply_patch\|Edit\|Write\|MultiEdit\|NotebookEdit\|mcp__\.\*/.test(h.matcher)), "Codex 훅 등록=5종(사전 관문·변경 도구 matcher)");
  // 배선 소스 핀: dispatcher 분리·게이트=공용 판정기·미호출 감지·Stop 중단·주입 공용 함수
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  assert.ok(src.includes('if(ev==="PreToolUse")return onPreTool(') && src.includes("previewGateDecision({"), "사전 관문=공용 판정기(Claude와 동일 게이트 계약)");
  assert.ok(src.includes("if (!pretoolObserveMarker(sid, j))") && src.includes("pretoolDistrustFileFor(ws)"), "★미호출 감지=호출별 표식 대조+소비(같은 턴 이전 호출 표식이 뒤 호출을 못 가림 — 2차 확인검증 blocker)");
  assert.ok(/if \(!sameImplementer\(ws, sid\)\) return;\s*\n\s*try \{ if \(fs\.existsSync\(pretoolDistrustFileFor\(ws\)\)\)/.test(src), "★불신 해제=구현자 세션 실측 뒤에만(순서 소스 계약)");
  // [2차 확인검증 blocker 반례 — 실행] 호출별 결속+소비
  CH.onPreTool({ tool_name: "Edit", turn_id: "tA", tool_use_id: "call-A" }, WS, "sessPair01", CL.loadContract(WS, "ko"));
  assert.strictEqual(CH.pretoolObserveMarker("sessPair01", { turn_id: "tA", tool_use_id: "call-B" }), false, "★같은 턴 다른 호출(tool_use_id)=미호출 판정(이전 호출 표식이 뒤 호출을 못 가림)");
  assert.strictEqual(CH.pretoolObserveMarker("sessPair01", { turn_id: "tB", tool_use_id: "call-A" }), false, "다른 턴=미호출 판정");
  assert.strictEqual(CH.pretoolObserveMarker("sessPair01", { turn_id: "tA", tool_use_id: "call-A" }), true, "같은 호출·같은 턴=실측 인정");
  assert.strictEqual(CH.pretoolObserveMarker("sessPair01", { turn_id: "tA", tool_use_id: "call-A" }), false, "★소비 후 재사용 불가(사전 1회=사후 1회 — id 미제공 플랫폼도 호출 짝 강제)");
  assert.ok(src.includes("Codex 구현 작업을 중단합니다") && /if \(typeof c\.archiveHash === "string" && c\.archiveHash\) \{\s*\n\s*let dis9/.test(src), "★미호출=중단(Stop 차단·ask-start 후퇴 금지)+실측 회복 시 자동 재개");
  assert.ok(src.includes("implementerEnvelopeInject(ws, c, loadLang()"), "Codex 턴 시작 주입=Claude와 같은 함수(양 훅 공통)");
  t("Codex 경로: 표식/불신 왕복 실행·등록 5종·공용 판정기·미호출=중단·주입 공용(이중 배달 완성)");
}
console.log(`envelope-preview: ${n} groups passed`);
