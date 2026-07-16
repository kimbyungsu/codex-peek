"use strict";
// [P-9 자동 전환] 질문 시작 호스트 기준 강제 모드 전환 — 실행 반례 테스트.
// 규칙(사용자 결정 2026-07-15): 옵션 모드 ≠ 실제 질문 호스트 → 경고 후 그 호스트의 모드로 전환.
// 안전 6조건: 4분류(vscode-user만 자격)·검증자 역할충돌·in-flight 검증 job·상대 턴 개연성(phase 25분)·
// 계약 fail-closed(손상=차단)·provenance(modeSwitch). 전환 불가 시 그 프롬프트 자체를 차단(fail-closed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p9-switch-"));
process.env.CODEX_BRIDGE_HOME = dir; // lib보다 먼저 — BRIDGE_DIR 결속
const lib = require("../bridge/contract-lib.js");
const ws = path.join(dir, "proj");
fs.mkdirSync(ws, { recursive: true });

let pass = 0, fail = 0;
function ck(name, cond) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }

const INJECT = path.join(__dirname, "..", "bridge", "contract-inject.js");
const CHOOK = path.join(__dirname, "..", "bridge", "codex-hook.js");
const env = { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws };
const contractFile = () => lib.contractFileFor ? lib.contractFileFor(ws, "ko") : null;
// contractFileFor 미수출 대비 — patch로 만들고 경로는 디렉터리 스캔으로 찾는다(계약 1개만 유지).
const CONTRACTS = path.join(dir, "contracts");
function readContract() {
  const f = fs.readdirSync(CONTRACTS).filter((x) => x.endsWith(".json"));
  if (f.length !== 1) throw new Error("contract file count=" + f.length);
  return { file: path.join(CONTRACTS, f[0]), o: JSON.parse(fs.readFileSync(path.join(CONTRACTS, f[0]), "utf8")) };
}
function setContract(mode, extra) {
  try { fs.rmSync(CONTRACTS, { recursive: true, force: true }); } catch { /* 없음 */ }
  const ok = lib.patchContractFields(ws, "ko", Object.assign({ harnessMode: mode, verifyMode: "always" }, extra || {}));
  if (!ok) throw new Error("setContract failed");
}
function clearState() {
  for (const d of ["ask-jobs"]) { try { fs.rmSync(path.join(dir, d), { recursive: true, force: true }); } catch { /* 없음 */ } }
  try { fs.rmSync(path.join(dir, "phase.json"), { force: true }); } catch { /* 없음 */ }
}
function runInject(payload) {
  const r = cp.spawnSync(process.execPath, [INJECT], { encoding: "utf8", env, input: JSON.stringify(payload), timeout: 30000, windowsHide: true });
  let out = null; try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { r, out };
}
function runChook(payload) {
  const r = cp.spawnSync(process.execPath, [CHOOK], { encoding: "utf8", env, input: JSON.stringify(payload), timeout: 30000, windowsHide: true });
  let out = null; try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { r, out };
}
const SID_CL = "claude-sess-1";
const futureIso = (ms) => new Date(Date.now() + ms).toISOString();

console.log("[A] Claude 프롬프트 × 설정=코덱스-코덱스 (contract-inject)");
// A1 — 가드 없음 → 전환 성공 + 고지 + provenance + phase
setContract("codex-codex"); clearState();
let { out } = runInject({ session_id: SID_CL, cwd: ws });
let ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || "";
ck("A1 전환 고지 주입(운용 모드 자동 전환)", ctx.includes("운용 모드 자동 전환") && ctx.includes("클로드-코덱스로 전환"));
let c = readContract();
ck("A1 계약이 claude-codex로 전환", c.o.harnessMode === "claude-codex");
ck("A1 provenance(modeSwitch: by/from/to/session/lang)", c.o.modeSwitch && c.o.modeSwitch.by === "claude-hook" && c.o.modeSwitch.from === "codex-codex" && c.o.modeSwitch.to === "claude-codex" && c.o.modeSwitch.session === SID_CL && c.o.modeSwitch.lang === "ko");
ck("A1 전환 후 CL-C 스위치(always)로 검증 지시도 주입", ctx.includes("검증"));
let ph = JSON.parse(fs.readFileSync(path.join(dir, "phase.json"), "utf8"));
ck("A1 phase=claude-working(전환 후 정상 전이 재개)", ph.phase === "claude-working" && ph.session === SID_CL);

// A2 — 진행 중 검증 job → 프롬프트 차단 + 계약 불변(fail-closed)
setContract("codex-codex"); clearState();
fs.mkdirSync(path.join(dir, "ask-jobs"), { recursive: true });
fs.writeFileSync(path.join(dir, "ask-jobs", "ask-live-1.json"), JSON.stringify({ id: "ask-live-1", state: "running", workspace: ws, deadlineAt: futureIso(10 * 60 * 1000) }), "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A2 진행 중 job → decision=block", out && out.decision === "block" && /검증 작업/.test(out.reason || ""));
ck("A2 계약 불변(codex-codex 유지)", readContract().o.harnessMode === "codex-codex");

// A2b — 마감 1분 이상 지난 잔재 job은 차단 근거 아님 → 전환 진행
fs.writeFileSync(path.join(dir, "ask-jobs", "ask-live-1.json"), JSON.stringify({ id: "ask-live-1", state: "running", workspace: ws, deadlineAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }), "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A2b 만료 잔재 job은 무시하고 전환", readContract().o.harnessMode === "claude-codex");

// A2c — 손상 job 파일은 '활성 아님'(전환을 영구 차단하면 안 됨 — P-4 몫)
setContract("codex-codex"); clearState();
fs.mkdirSync(path.join(dir, "ask-jobs"), { recursive: true });
fs.writeFileSync(path.join(dir, "ask-jobs", "ask-broken.json"), "{broken", "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A2c 손상 job은 무시하고 전환", readContract().o.harnessMode === "claude-codex");

// A3 — 구현 Codex 쪽 진행 흔적(phase 신선·다른 세션) → 차단 / 같은 세션 흔적이면 전환
setContract("codex-codex"); clearState();
lib.writePhase("codex-implementing", { session: "impl-sess-9", workspace: ws });
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A3 상대 턴 흔적(codex-implementing) → block", out && out.decision === "block" && /구현 Codex/.test(out.reason || ""));
ck("A3 계약 불변", readContract().o.harnessMode === "codex-codex");
lib.writePhase("rejudging", { session: SID_CL, workspace: ws }); // P-9 원사건: 자기 세션이 남긴 '반영중'은 차단 근거 아님
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A3b 자기 세션의 rejudging 흔적은 통과(원사건 자가 복구 유지)", readContract().o.harnessMode === "claude-codex");

// A3c — 오래된 흔적(25분 초과)은 차단 근거 아님
setContract("codex-codex"); clearState();
fs.writeFileSync(path.join(dir, "phase.json"), JSON.stringify({ phase: "codex-implementing", session: "impl-sess-9", workspace: ws, ts: new Date(Date.now() - 26 * 60 * 1000).toISOString() }), "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A3c 25분 지난 흔적은 무시하고 전환", readContract().o.harnessMode === "claude-codex");

// A4 — 계약 파일 손상 → 프롬프트 차단(모드 권위 판정 불가 fail-closed) + 바이트 보존
setContract("codex-codex"); clearState();
let cf = readContract().file;
fs.writeFileSync(cf, "{broken-contract", "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A4 손상 계약 → block(재저장 안내)", out && out.decision === "block" && /손상/.test(out.reason || ""));
ck("A4 손상 바이트 보존(복구 기회)", fs.readFileSync(cf, "utf8") === "{broken-contract");

// A5 — 정상 CL-C 회귀: 전환 경로 미개입
setContract("claude-codex"); clearState();
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || "";
ck("A5 CL-C 정상 턴은 자동 전환 미개입(고지 없음·검증 지시만)", !ctx.includes("자동 전환") && ctx.includes("검증"));
ck("A5 계약에 modeSwitch 없음", !readContract().o.modeSwitch);

// A6 — 직접 ask(ask-active) 실행 중(부모 프로세스 생존) → 차단(구현검증 1차 지적 1)
setContract("codex-codex"); clearState();
fs.mkdirSync(path.join(dir, "ask-active"), { recursive: true });
fs.writeFileSync(lib.askActiveFileFor(ws), JSON.stringify({ schema: "ask-active-v1", pid: process.pid, childPid: null, startedAt: new Date().toISOString() }), "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A6 직접 ask 생존 중 → block", out && out.decision === "block" && /검증 작업/.test(out.reason || ""));
ck("A6 계약 불변", readContract().o.harnessMode === "codex-codex");

// A7 — 직접 ask abandoned(부모·자식 모두 사망)는 전환을 막지 않음(재전송 차단은 ask-active guard의 몫)
fs.writeFileSync(lib.askActiveFileFor(ws), JSON.stringify({ schema: "ask-active-v1", pid: 999999999, childPid: null, startedAt: new Date().toISOString() }), "utf8");
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A7 abandoned ask-active는 무시하고 전환", readContract().o.harnessMode === "claude-codex");
try { fs.rmSync(path.join(dir, "ask-active"), { recursive: true, force: true }); } catch { /* 없음 */ }

// A8 — codex-verifying 흔적(직접 ask 표시·다른 세션)도 차단 근거
setContract("codex-codex"); clearState();
lib.writePhase("codex-verifying", { session: "impl-sess-9", workspace: ws });
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A8 codex-verifying 흔적 → block", out && out.decision === "block");
ck("A8 계약 불변", readContract().o.harnessMode === "codex-codex");

// A9 — 성공 Stop은 done 종결(후보③ — rejudging 잔존이 다음 Claude 질문을 25분 오차단하던 원인 제거)
const hookSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
ck("A9 성공 Stop=done 종결(소스 계약)", /if\(gate\.ok\)\{try\{writePhase\("done",\{session:sid,workspace:ws\}\);\}catch\{\} return;\}/.test(hookSrc));
setContract("codex-codex"); clearState();
lib.writePhase("done", { session: "impl-sess-9", workspace: ws }); // 정상 완료 직후의 Claude 질문 — 오차단 없어야 함
({ out } = runInject({ session_id: SID_CL, cwd: ws }));
ck("A9 정상 완료(done) 직후 Claude 질문은 즉시 전환", readContract().o.harnessMode === "claude-codex");

// 잠금 — 계약 patch가 파일별 잠금을 쓰고(브릿지·확장 동형), 성공 후 잔존 잠금이 없다
const libSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
ck("잠금 — patchContractFields가 withFileLockStrict(<파일>.lock) 사용", /withFileLockStrict\(file \+ "\.lock", \(\) => \{/.test(libSrc));
const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ck("잠금 — 확장 patchContractExt도 동형 잠금(withContractLockExt)", /withContractLockExt\(file \+ "\.lock", \(\) => \{/.test(extSrc) && /function withContractLockExt<T>\(lockPath: string, fn: \(\) => T\): T \| false/.test(extSrc));
ck("잠금 — 성공 patch 후 잔존 .lock 없음", !fs.readdirSync(CONTRACTS).some((f) => f.endsWith(".lock")));
// 잠금 보유 중 patch는 기록 거부(fail-closed) — 죽은 보유자가 아닌 살아있는 보유자(내 pid) 시나리오
{
  const cfLock = readContract().file + ".lock";
  fs.writeFileSync(cfLock, process.pid + "-zzzzzz", "utf8");
  const before = fs.readFileSync(readContract().file, "utf8");
  ck("잠금 — 보유 중이면 patch 거부+원본 불변", lib.patchContractFields(ws, "ko", { verifyMode: "off" }) === false && fs.readFileSync(readContract().file, "utf8") === before);
  fs.unlinkSync(cfLock);
}

// 대시보드 경고 채널(동결 ⑹) — modeSwitch 통과(표시 전용)+모드 버튼 아래 신선(30분) 고지
ck("대시보드 — Contract.modeSwitch 통과(normalize 검증형)+표시 전용 명시", /modeSwitch\?: \{ by: string; from: string; to: string; at: string; session: string; reverted\?: string \};/.test(extSrc) && /저장 페이로드·exact patch 허용목록에 절대 미포함/.test(extSrc));
ck("대시보드 — modeSwitchNote 신선 고지(30분)", /id="modeSwitchNote"/.test(extSrc) && /age>=0&&age<30\*60\*1000/.test(extSrc) && /자동 전환됨: /.test(extSrc));

console.log("[B] Codex 프롬프트 × 설정=클로드-코덱스 (codex-hook)");
const SID_CX = "019f0000-1111-7222-8333-944455566677";
const rollout = path.join(dir, "rollout-cx.jsonl");
function writeRollout(source, threadSource) {
  fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: SID_CX, source, thread_source: threadSource } }) + "\n", "utf8");
}
const cxPayload = () => ({ hook_event_name: "UserPromptSubmit", session_id: SID_CX, cwd: ws, turn_id: "t-1", transcript_path: rollout });

// B1 — vscode-user + 가드 없음 → 전환 + 고지 + 구현자 고정 + provenance
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
let rb = runChook(cxPayload());
ctx = rb.out && rb.out.hookSpecificOutput && rb.out.hookSpecificOutput.additionalContext || "";
ck("B1 전환 고지 주입(코덱스-코덱스로 전환)", ctx.includes("운용 모드 자동 전환") && ctx.includes("코덱스-코덱스로 전환"));
c = readContract();
ck("B1 계약이 codex-codex로 전환 + provenance", c.o.harnessMode === "codex-codex" && c.o.modeSwitch && c.o.modeSwitch.by === "codex-hook" && c.o.modeSwitch.session === SID_CX);
let links = JSON.parse(fs.readFileSync(path.join(dir, "links.json"), "utf8"));
let wsKey = Object.keys(links.byWorkspace || {})[0];
ck("B1 전환 직후 이 대화가 구현자로 고정", !!wsKey && links.byWorkspace[wsKey].implementerSession === SID_CX);
// 2차 지적 2 — 한 프롬프트=한 등록: autoSwitch의 고정 결과를 onPrompt가 재사용(이중 등록이면 revision 2)
ck("B1 고정 세대는 정확히 1회 전진(이중 pin 없음)", Number(links.byWorkspace[wsKey].implementerRevision) === 1);

// B2 — 검증자 세션의 질문 → 역할 충돌 차단 + 계약 불변
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
fs.writeFileSync(path.join(dir, "links.json"), JSON.stringify({ byWorkspace: { [ws]: { codexSession: SID_CX } }, bySession: {} }), "utf8");
rb = runChook(cxPayload());
ck("B2 검증자 세션 → block(자기검증 방지·재배치 안내)", rb.out && rb.out.decision === "block" && /검증 역할/.test(rb.out.reason || ""));
ck("B2 계약 불변(claude-codex 유지)", readContract().o.harnessMode === "claude-codex");

// B3 — exec 세션(검증자 실행)·미상 세션은 절대 전환 금지(무출력·불변)
setContract("claude-codex"); clearState(); writeRollout("exec", "user");
try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
rb = runChook(cxPayload());
ck("B3 exec 세션은 침묵(전환·출력 없음)", !rb.out && readContract().o.harnessMode === "claude-codex");

// B4 — 진행 중 검증 job → 차단
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
fs.mkdirSync(path.join(dir, "ask-jobs"), { recursive: true });
fs.writeFileSync(path.join(dir, "ask-jobs", "ask-live-2.json"), JSON.stringify({ id: "ask-live-2", state: "queued", workspace: ws, deadlineAt: futureIso(10 * 60 * 1000) }), "utf8");
rb = runChook(cxPayload());
ck("B4 진행 중 job → block", rb.out && rb.out.decision === "block" && /검증 작업/.test(rb.out.reason || ""));
ck("B4 계약 불변", readContract().o.harnessMode === "claude-codex");

// B5 — Claude 쪽 진행 흔적(claude-working 신선·다른 세션) → 차단
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
lib.writePhase("claude-working", { session: SID_CL, workspace: ws });
rb = runChook(cxPayload());
ck("B5 Claude 턴 흔적 → block", rb.out && rb.out.decision === "block" && /Claude 쪽 진행 흔적/.test(rb.out.reason || ""));
ck("B5 계약 불변", readContract().o.harnessMode === "claude-codex");

// B6 — 정상 C-C 회귀: 전환 경로 미개입(고지 없음)
setContract("codex-codex"); clearState(); writeRollout("vscode", "user");
try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
rb = runChook(cxPayload());
ctx = rb.out && rb.out.hookSpecificOutput && rb.out.hookSpecificOutput.additionalContext || "";
ck("B6 C-C 정상 턴은 자동 전환 미개입(고지 없음)", !ctx.includes("자동 전환"));
ck("B6 계약에 modeSwitch 없음", !readContract().o.modeSwitch);

// B7 — SessionStart는 '질문 시작'이 아님 — CL-C에서 전환 금지(침묵)
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
rb = runChook({ hook_event_name: "SessionStart", session_id: SID_CX, cwd: ws, transcript_path: rollout });
ck("B7 SessionStart는 전환하지 않음(침묵·불변)", !rb.out && readContract().o.harnessMode === "claude-codex");

// B8 — 손상 계약 + vscode-user 질문 → 차단(Claude 측 A4와 대칭 fail-closed). exec 프롬프트는 침묵 유지.
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
cf = readContract().file;
fs.writeFileSync(cf, "{broken-contract", "utf8");
rb = runChook(cxPayload());
ck("B8 손상 계약+사용자 질문 → block(재저장 안내)", rb.out && rb.out.decision === "block" && /손상/.test(rb.out.reason || ""));
ck("B8 손상 바이트 보존", fs.readFileSync(cf, "utf8") === "{broken-contract");
writeRollout("exec", "user");
rb = runChook(cxPayload());
ck("B8b 손상 계약+exec 프롬프트는 침묵(진행 중 검증 실행 보호)", !rb.out);

// B9 — 의미 손상 links({byWorkspace:[]}): linkedVerifier는 통과하지만 고정(register)이 links-corrupt로 거부.
//      5차 확정 의미론: 손상 중엔 역할 상태를 확정할 수 없어 ★원복도 보류★(모드=C-C 유지)+차단+복구 안내 —
//      손상을 빈 상태로 축소해 원복하면 손상 창에서 게이트 보증이 사라진다(5차 지적 3). links 바이트는 보존.
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
fs.writeFileSync(path.join(dir, "links.json"), JSON.stringify({ byWorkspace: [] }), "utf8");
rb = runChook(cxPayload());
c = readContract();
ck("B9 고정 실패(links 의미 손상) → block+원복 보류(C-C 유지)", rb.out && rb.out.decision === "block" && /고정/.test(rb.out.reason || "") && /원복을 보류/.test(rb.out.reason || "") && c.o.harnessMode === "codex-codex");
ck("B9 원복 미수행(reverted 없음)", !(c.o.modeSwitch && c.o.modeSwitch.reverted));
ck("B9 links 바이트 보존(register fail-closed)", fs.readFileSync(path.join(dir, "links.json"), "utf8") === JSON.stringify({ byWorkspace: [] }));
try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }

// B11 — unknown(rollout 미생성/판독 불가)은 침묵이 아니라 차단(2차 지적 4 — 실사용자 프롬프트가 rollout 생성
//       경합으로 unknown이면 침묵 시 무게이트 우회가 된다). 계약 불변.
setContract("claude-codex"); clearState();
rb = runChook({ hook_event_name: "UserPromptSubmit", session_id: SID_CX, cwd: ws, turn_id: "t-u", transcript_path: path.join(dir, "no-such-rollout.jsonl") });
ck("B11 unknown 세션 질문 → block(판정 불가 fail-closed)", rb.out && rb.out.decision === "block" && /판정할 수 없/.test(rb.out.reason || ""));
ck("B11 계약 불변", readContract().o.harnessMode === "claude-codex");

// B12 — 손상 계약 + unknown 세션 질문도 차단(3차 지적 2 — 손상 분기가 vscode-user만 차단하면 unknown 실사용자가 무게이트 통과)
setContract("claude-codex"); clearState();
cf = readContract().file;
fs.writeFileSync(cf, "{broken-contract", "utf8");
rb = runChook({ hook_event_name: "UserPromptSubmit", session_id: SID_CX, cwd: ws, turn_id: "t-u2", transcript_path: path.join(dir, "no-such-rollout.jsonl") });
ck("B12 손상 계약+unknown 질문 → block", rb.out && rb.out.decision === "block" && /손상/.test(rb.out.reason || ""));
ck("B12 손상 바이트 보존", fs.readFileSync(cf, "utf8") === "{broken-contract");

// B13 — source=vscode인데 thread_source 누락 = 허용목록 밖 → unknown 차단(3차 지적 2 — other 과대허용 금지)
setContract("claude-codex"); clearState();
fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: SID_CX, source: "vscode" } }) + "\n", "utf8");
rb = runChook(cxPayload());
ck("B13 vscode+thread_source 누락 → unknown 차단", rb.out && rb.out.decision === "block" && /판정할 수 없/.test(rb.out.reason || ""));
ck("B13 계약 불변", readContract().o.harnessMode === "claude-codex");
// B13b — vscode의 확정 비사용자 스레드(thread_source 명시≠user)는 침묵(확정 비대상)
fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: SID_CX, source: "vscode", thread_source: "subagent" } }) + "\n", "utf8");
rb = runChook(cxPayload());
ck("B13b vscode 비사용자 스레드는 침묵·불변", !rb.out && readContract().o.harnessMode === "claude-codex");

// B14 — 원복 라우팅(3·4·7차 확정): role-lock-unavailable만 무조건 보류, raced 포함 그 외는 CAS가 원복 시점에 판정
{
  const hs = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  ck("B14 revertOnPinFailure — role-lock-unavailable만 무조건 무원복(raced는 CAS로 판정 — 7차)", /function revertOnPinFailure\(reason\) \{ return reason !== "role-lock-unavailable"; \}/.test(hs));
  ck("B14 배선 — 무원복 사유는 모드 유지+차단, 그 외는 세대 CAS 원복", /if \(!revertOnPinFailure\(pinned\.reason\)\)/.test(hs) && /revertSwitchIfRoleUnchanged\(ws, lang, sid, expected\)/.test(hs));
  ck("B14 pin이 role lock 예외를 사유로 흡수(fail-open 봉합)", /catch \{ reg = \{ ok: false, reason: "role-lock-unavailable" \}; \}/.test(hs));
}

// B16 — 등록기도 현재 ws 레코드 손상 거부(7차 지적 2): 같은 바이트가 Stop=corrupt인데 등록=정상 덮어쓰기면
//        판정 불일치+P-1 바이트 보존 위반. 실행 반례: {byWorkspace:{현재키:[]}} 등록 거부+바이트 보존.
{
  const badLinks = JSON.stringify({ byWorkspace: { [ws]: [] } });
  fs.writeFileSync(path.join(dir, "links.json"), badLinks, "utf8");
  const regC = lib.registerCodexImplementer(ws, "sid-c-0000-0000-0000-000000000000", "m", "high");
  ck("B16 현재 ws 레코드 손상 → 등록 거부(links-corrupt)", !!regC && regC.ok === false && regC.reason === "links-corrupt");
  ck("B16 손상 바이트 보존", fs.readFileSync(path.join(dir, "links.json"), "utf8") === badLinks);
  try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
}

// B17 — 전역 드리프트 raced의 종단 흐름(7차 지적 1): 무관 프로젝트 변경으로 raced가 나도(로컬 불변)
//        CAS 원복이 CL-C로 복귀시켜 'C-C 잔존+미고정' 공백이 남지 않는다.
{
  const chook2 = require("../bridge/codex-hook.js");
  setContract("codex-codex"); // 패치까지 끝난 상태
  try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
  const regD = lib.registerCodexImplementer(ws, SID_CX, "m", "high", { session: "", revision: 0, roleRevision: 999, eventStartedAt: Date.now() });
  ck("B17 전역 세대 불일치 스냅샷 → 등록기 raced(로컬은 불변)", !!regD && regD.ok === false && regD.reason === "implementer-raced");
  const rv2 = chook2.revertSwitchIfRoleUnchanged(ws, "ko", SID_CX, { session: "", revision: 0 });
  ck("B17 로컬 불변 → CAS 원복 수행(CL-C 복귀·공백 없음)", rv2 && rv2.done === true && readContract().o.harnessMode === "claude-codex");
}

// B18 — eventAt 전진도 '로컬 전진'(8차 지적 1): 스냅샷을 늦게 읽은 오래된 훅은 session/revision이 최신
//        상태와 같아 보여도 currentEventAt>eventStartedAt으로 raced가 되는데, 원복이 이를 불변으로 오판하면
//        진행 중인 최신 턴을 CL-C로 원복해 게이트 해제(실행 반증 시나리오 — 같은 세션·다른 세션 모두 잠금).
{
  const chook3 = require("../bridge/codex-hook.js");
  for (const sidX of [SID_CX, "sid-n-0000-0000-0000-000000000000"]) {
    setContract("codex-codex");
    try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
    lib.registerCodexImplementer(ws, sidX, "m", "high"); // 최신 턴 N의 등록(eventAt=now)
    const lk = JSON.parse(fs.readFileSync(path.join(dir, "links.json"), "utf8"));
    const rec = lk.byWorkspace[Object.keys(lk.byWorkspace)[0]];
    const stale = { session: rec.implementerSession, revision: rec.implementerRevision, eventStartedAt: Number(rec.implementerEventAt) - 1000 };
    const rv3 = chook3.revertSwitchIfRoleUnchanged(ws, "ko", sidX, stale);
    ck("B18 eventAt 전진(" + (sidX === SID_CX ? "같은" : "다른") + " 세션) → 원복 거부(role-advanced)", rv3 && rv3.done === false && rv3.reason === "role-advanced" && readContract().o.harnessMode === "codex-codex");
  }
}

// B15 — ★역할 세대 CAS 원복 실행 반례(4차 지적 1 시나리오)★: pin 실패(links 손상) 후 links가 복구되고
//        다른 세션 B가 구현 역할을 가져간 '뒤'의 원복 시도 — 세대 전진을 관측하고 원복하지 않아야
//        B의 C-C 턴 게이트가 산다. (두 프로세스 없이 결정 함수를 순차 호출해 결정론 재현)
{
  const chook = require("../bridge/codex-hook.js"); // require.main 가드 — stdin 미구동·결정 함수만 노출
  setContract("codex-codex"); clearState(); // '패치까지 끝난' 상태 재현
  const expectedSnap = { session: "", revision: 0 }; // 전환 시작 시점: 구현자 없음
  // 시나리오 전반: links 복구+B 등록(세대 전진)
  try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
  const regB = lib.registerCodexImplementer(ws, "sid-b-0000-0000-0000-000000000000", "m", "high");
  ck("B15 사전조건 — B 등록 성공(세대 1)", !!regB && regB.ok === true);
  let rv = chook.revertSwitchIfRoleUnchanged(ws, "ko", SID_CX, expectedSnap);
  ck("B15 세대 전진 관측 → 원복 거부(role-advanced)", rv && rv.done === false && rv.reason === "role-advanced");
  ck("B15 계약은 codex-codex 유지(B의 턴 게이트 보존)", readContract().o.harnessMode === "codex-codex");
  // 대조: 로컬 세대(세션·revision)가 전환 시점 그대로면 원복 수행
  rv = chook.revertSwitchIfRoleUnchanged(ws, "ko", SID_CX, { session: "sid-b-0000-0000-0000-000000000000", revision: 1 });
  ck("B15b 세대 불변 → 원복 수행+reverted provenance", rv && rv.done === true && readContract().o.harnessMode === "claude-codex" && readContract().o.modeSwitch.reverted === "pin-failed");
  // 교차 프로젝트 무간섭(6차 지적 1): 무관 프로젝트의 역할 변경(전역 세대 전진)은 이 프로젝트의 원복을 막지 않음
  const ws2 = path.join(dir, "proj2"); fs.mkdirSync(ws2, { recursive: true });
  setContract("codex-codex");
  lib.registerCodexImplementer(ws2, "sid-other-000-0000-0000-000000000000", "m", "high"); // 전역 roleRevision 전진
  rv = chook.revertSwitchIfRoleUnchanged(ws, "ko", SID_CX, { session: "sid-b-0000-0000-0000-000000000000", revision: 1 });
  ck("B15b2 무관 프로젝트 역할 변경에도 로컬 불변이면 원복 수행(교차 오판 제거)", rv && rv.done === true && readContract().o.harnessMode === "claude-codex");
  // 대조 2: links 판독 불가(구문 손상)·의미 손상(배열 루트 등) 모두 불확실 — 원복 보류(5차 지적 3)
  for (const bad of ["{broken-links", "[]", "null", JSON.stringify({ byWorkspace: [] })]) {
    setContract("codex-codex");
    fs.writeFileSync(path.join(dir, "links.json"), bad, "utf8");
    rv = chook.revertSwitchIfRoleUnchanged(ws, "ko", SID_CX, expectedSnap);
    ck("B15c 손상 links(" + bad.slice(0, 12) + ") → 원복 보류+모드 유지", rv && rv.done === false && rv.reason === "role-unreadable" && readContract().o.harnessMode === "codex-codex");
  }
  // Stop 판독도 같은 의미 검증(공용기) — 의미 손상을 record:null(정상 무구현자)로 축소하면 Stop 무음 통과(5차 실증)
  fs.writeFileSync(path.join(dir, "links.json"), "[]", "utf8");
  let rr = lib.readImplementerRecordLocked(ws);
  ck("B15d Stop 판독 — 의미 손상=links-corrupt(fail-closed)", rr && rr.ok === false && rr.reason === "links-corrupt");
  // 6차 지적 3: 레코드 단위 손상({byWorkspace:{현재키:[]}})도 현재 ws 판정에선 corrupt — 단 무관 ws 레코드
  // 손상은 이 프로젝트를 차단하지 않음(교차 간섭 방지 — 검사 범위=현재 ws 레코드)
  fs.writeFileSync(path.join(dir, "links.json"), JSON.stringify({ byWorkspace: { [ws]: [] } }), "utf8");
  rr = lib.readImplementerRecordLocked(ws);
  ck("B15d2 현재 ws 레코드 손상=links-corrupt", rr && rr.ok === false && rr.reason === "links-corrupt");
  fs.writeFileSync(path.join(dir, "links.json"), JSON.stringify({ byWorkspace: { [path.join(dir, "elsewhere")]: [] } }), "utf8");
  rr = lib.readImplementerRecordLocked(ws);
  ck("B15d3 무관 ws 레코드 손상은 이 프로젝트 판정을 막지 않음", rr && rr.ok === true && rr.record === null);
  setContract("codex-codex");
  fs.writeFileSync(path.join(dir, "links.json"), JSON.stringify({ byWorkspace: { [ws]: [] } }), "utf8");
  rv = chook.revertSwitchIfRoleUnchanged(ws, "ko", SID_CX, expectedSnap);
  ck("B15d4 원복 판독도 현재 ws 레코드 손상=보류", rv && rv.done === false && rv.reason === "role-unreadable");
  ck("B15e 공용기 validLinksShape 계약", lib.validLinksShape({}) === true && lib.validLinksShape({ byWorkspace: {} }) === true && lib.validLinksShape([]) === false && lib.validLinksShape(null) === false && lib.validLinksShape({ byWorkspace: [] }) === false && lib.validLinksShape({ bySession: "x" }) === false && lib.validLinksShape({ byWorkspace: { w: [] } }, "w") === false && lib.validLinksShape({ byWorkspace: { w: [] } }, "other") === true);
  try { fs.rmSync(path.join(dir, "links.json"), { force: true }); } catch { /* 없음 */ }
  // 순서 소스 계약(5차 지적 1·2): expected 스냅샷 확보가 C-C 패치보다 '앞'
  const hs5 = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  const iSnap = hs5.indexOf("const expected = codexImplementerSnapshot(ws, roleRevision, HOOK_STARTED_AT);");
  const iPatch = hs5.indexOf('harnessMode: "codex-codex",');
  ck("B15f 운영 순서 — 스냅샷이 패치보다 앞(패치~스냅샷 오판 창 제거)", iSnap > 0 && iPatch > 0 && iSnap < iPatch);
  // 6차 지적 1·2: 전역 roleRevision 비교는 폐기(교차 프로젝트 오판·이중 판독 축소) — 부재를 계약으로 고정
  ck("B15g 원복 CAS는 로컬 세대만 비교(전역 roleRevision 비교 없음)", !/codexRoleRevision\(\)\) !== Number\(expected\.roleRevision/.test(hs5));
}

// 잠금 진단 5상태(4차 지적 3) — dead(ESRCH)만 삭제 안내, EPERM=owner-unverified(삭제 금지), 손상 토큰=invalid
{
  setContract("codex-codex");
  const lp = readContract().file + ".lock";
  fs.writeFileSync(lp, process.pid + "-alive", "utf8");
  let li = lib.contractLockIssue(ws, "ko");
  ck("잠금5 — 생존 보유자=alive", li && li.state === "alive" && li.pid === process.pid);
  fs.writeFileSync(lp, "999999999-dead", "utf8");
  li = lib.contractLockIssue(ws, "ko");
  ck("잠금5 — 확정 사망=dead(삭제 안내 허용 유일 상태)", li && li.state === "dead");
  fs.writeFileSync(lp, "not-a-token", "utf8");
  li = lib.contractLockIssue(ws, "ko");
  ck("잠금5 — 손상 토큰=invalid(삭제 금지)", li && li.state === "invalid");
  const realKill = process.kill;
  process.kill = function (pid, sig) { if (sig === 0 && pid === 424242) { const e = new Error("EPERM"); e.code = "EPERM"; throw e; } return realKill.apply(process, arguments); };
  fs.writeFileSync(lp, "424242-x", "utf8");
  try { li = lib.contractLockIssue(ws, "ko"); } finally { process.kill = realKill; }
  ck("잠금5 — EPERM=owner-unverified(사망 단정·삭제 유도 금지)", li && li.state === "owner-unverified");
  fs.unlinkSync(lp);
  ck("잠금5 — 파일 없음=null", lib.contractLockIssue(ws, "ko") === null);
  const cl4 = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  const ext4 = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ck("잠금5 — 획득기도 ESRCH만 사망 확정(브릿지·확장 동형)", /if \(ke && ke\.code === "ESRCH"\) return \{ ok: false, error: "dead-lock-holder/.test(cl4) && /if \(ke && ke\.code === "ESRCH"\) return false;/.test(ext4));
  ck("잠금5 — 확장 힌트도 5상태(owner-unverified 삭제 금지)", /다른 사용자의 프로세스일 수 있음/.test(ext4) && /임의 삭제하지 말고/.test(ext4));
}

// 잠금 진단 표면(3차 지적 3) — 실패 메시지에 정확한 잠금 경로·보유 PID·생존 여부
{
  const cl3 = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  ck("잠금 진단 — contractLockIssue(경로·pid·생존) export", /function contractLockIssue\(ws, lang\)/.test(cl3) && /module\.exports\.contractLockIssue = contractLockIssue;/.test(cl3));
  const ext3 = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ck("잠금 진단 — 확장 토스트 3곳이 contractLockHintExt 사용", (ext3.match(/contractLockHintExt\(/g) || []).length >= 4);
}

// A10 — 살아있는 보유자가 계약 잠금을 쥔 동안 Claude 전환 → 기록 거부+차단+.lock 복구 안내(2차 지적 5)
setContract("codex-codex"); clearState();
{
  const cfLock2 = readContract().file + ".lock";
  fs.writeFileSync(cfLock2, process.pid + "-zzzzzz", "utf8");
  ({ out } = runInject({ session_id: SID_CL, cwd: ws }));
  ck("A10 잠금 보유 중 전환 → block+.lock 안내", out && out.decision === "block" && /\.lock/.test(out.reason || ""));
  ck("A10 계약 불변", readContract().o.harnessMode === "codex-codex");
  fs.unlinkSync(cfLock2);
}

// 교차 작성자 잠금 참여(2차 지적 1) — 소스 계약: 확장 setScoutTargetFromUi=patchContractExt 경유,
// scripts(scope-target/scope-gate)=withFileLockStrict+fail-closed(무잠금 keep-병합·{} 축소 덮어쓰기 제거)
const extSrc2 = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ck("교차 작성자 — setScoutTargetFromUi가 patchContractExt 경유", /patchContractExt\(ws, lang, \{ scoutRepo: abs \}\)/.test(extSrc2) && !/\.\.\.keep, scoutRepo: abs/.test(extSrc2));
const st2 = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-target.js"), "utf8");
const sg2 = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-gate.js"), "utf8");
ck("교차 작성자 — scope-target 잠금+fail-closed", /withFileLockStrict\(f \+ "\.lock"/.test(st2) && /기록 거부/.test(st2));
ck("교차 작성자 — scope-gate 잠금+fail-closed", /withFileLockStrict\(f \+ "\.lock"/.test(sg2) && /기록 거부/.test(sg2));
// 대시보드 — 복귀(현재 모드≠to)·원복(reverted) 상태에선 자동 전환 안내 숨김(2차 부수 지적)
ck("대시보드 — 안내는 to===현재 모드·비원복일 때만", /msw\.to===harnessMode&&!msw\.reverted/.test(extSrc2));

// B10 — codex-verifying 흔적(다른 세션의 직접 ask 표시) → 차단
setContract("claude-codex"); clearState(); writeRollout("vscode", "user");
lib.writePhase("codex-verifying", { session: SID_CL, workspace: ws });
rb = runChook(cxPayload());
ck("B10 codex-verifying 흔적 → block", rb.out && rb.out.decision === "block");
ck("B10 계약 불변", readContract().o.harnessMode === "claude-codex");

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 잠금 무해 */ }
process.exit(fail ? 1 : 0);
