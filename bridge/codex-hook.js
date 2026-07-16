#!/usr/bin/env node
"use strict";
// Codex↔Codex 구현 역할 라이프사이클 훅. Codex 공식 SessionStart/UserPromptSubmit/PostToolUse/Stop 이벤트를 받아
// Claude 훅과 같은 계약·검증·3트랙 원칙을 적용한다. 다른 운용 모드/다른 역할 세션에서는 즉시 무동작.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
// Comparable across hook processes and captured by Node before this module (or any cleanup/config
// I/O) runs. It closes ordering gaps even if an older process is delayed during module startup.
const HOOK_STARTED_AT = require("perf_hooks").performance.timeOrigin;
const {
  BRIDGE_DIR, loadContract, loadLang, buildInjection, buildVerifyDirective, buildScoutDirective,
  registerCodexImplementer, codexImplementerSnapshot, codexRoleRevision, writeCodexActive, readCodexActive, atomicWrite, writePhase, resolveScoutRepo, scoutMapStatus,
  scoutHealthLine, maybeCleanupState, configWs, readImplementerRecordLocked, durableProofGate, readCodexTurnStrict, contractReadState,
  patchContractFields, activeAskJobFor, phaseBusy, contractLockIssue, withRoleLock, implementerRecordOf, validLinksShape,
} = require("./contract-lib.js");

const TURN_DIR = path.join(BRIDGE_DIR, "codex-turns");
const ATTEMPT_DIR = path.join(BRIDGE_DIR, "codex-verify-attempts");
const SCOUT_ATTEMPT_DIR = path.join(BRIDGE_DIR, "codex-scout-attempts");
const MAX_VERIFY_ATTEMPTS = 3, MAX_SCOUT_ATTEMPTS = 2;
function safe(s) { return String(s || "").replace(/[^0-9a-zA-Z._-]/g, "_"); }
function stateFile(dir, sid) { return path.join(dir, safe(sid) + ".json"); }
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function save(file, obj) { return atomicWrite(file, JSON.stringify(obj)); }
function t(ko, en) { return loadLang() === "en" ? en : ko; }
function jsonOut(obj) { process.stdout.write(JSON.stringify(obj)); }
function context(eventName, text) { if (text) jsonOut({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }); }
function block(reason) { jsonOut({ decision: "block", reason }); }

function readFirstJsonLine(file, maxBytes = 1024 * 1024) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const chunks = []; let pos = 0;
    while (pos < maxBytes) {
      const buf = Buffer.alloc(Math.min(64 * 1024, maxBytes - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const part = buf.subarray(0, n), nl = part.indexOf(10);
      chunks.push(nl >= 0 ? part.subarray(0, nl) : part);
      pos += nl >= 0 ? nl : n;
      if (nl >= 0) return JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""));
    }
  } catch { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
  return null;
}
function codexHome() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  try {
    const saved = fs.readFileSync(path.join(BRIDGE_DIR, "codex-home.txt"), "utf8").trim();
    if (saved) return saved;
  } catch { /* default */ }
  return path.join(require("os").homedir(), ".codex");
}
function rolloutForSession(j, sid) {
  const direct = String(j.transcript_path || j.transcriptPath || "");
  if (direct && fs.existsSync(direct)) return direct;
  let found = "";
  const walk = (dir, depth) => {
    if (found || depth > 6) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.includes(sid) && entry.name.endsWith(".jsonl")) found = full;
    }
  };
  walk(path.join(codexHome(), "sessions"), 0);
  return found;
}
function isVscodeUserSession(j, sid) {
  const file = rolloutForSession(j, sid); if (!file) return false;
  const meta = readFirstJsonLine(file), p = meta && meta.type === "session_meta" ? (meta.payload || {}) : null;
  return !!p && String(p.id || "") === sid && String(p.source || "") === "vscode" && String(p.thread_source || "") === "user";
}

function effortOf(j, fallback) {
  return j.reasoning_effort || j.effort || j.reasoning || j.collaboration_mode?.settings?.reasoning_effort || fallback || "";
}
function heartbeat(j, ws, sid, eventName) {
  const prev = readCodexActive(sid) || {};
  writeCodexActive(sid, ws, {
    source:"codex-hook", hookEvent:eventName, hookVersion:2,
    turnId:j.turn_id || j.turnId || prev.turnId || "",
    permissionMode:j.permission_mode || prev.permissionMode || "",
    model:j.model || prev.model || "",
    effort:effortOf(j, prev.effort),
  });
}
function implementerContext(j, ws, c) {
  const parts=[]; const plan=j.permission_mode==="plan";
  const inject=c.codexInjectMode==="always" || (c.codexInjectMode==="plan" && plan);
  if(inject){ const x=buildInjection(c.codexImplementer,"Codex Implementer",c.codexImplementerChecklist); if(x)parts.push(x); }
  if(c.codexVerifyMode!=="off") parts.push(buildVerifyDirective(c.codexVerifyMode, undefined, c.codexVerifyProfile)); // C-C 슬롯 스위치(모드별 분리 2026-07-15)·P-12 프로필(주입 시점 실효값)
  try { const x=buildScoutDirective(ws,c); if(x)parts.push(x); } catch { /* advisory */ }
  try { const x=require("./map-bootstrap.js").hookTick(ws); if(x)parts.push(x); } catch { /* advisory */ }
  return parts.join("\n\n");
}

function gitChangedMaxMtime(ws) {
  try {
    const r = cp.spawnSync("git", ["-c", "safe.directory=*", "-C", ws, "status", "--porcelain"], { encoding:"utf8", timeout:10000, windowsHide:true });
    if (r.status !== 0) return 0;
    let max = 0;
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let p = line.slice(3); const arrow = p.indexOf(" -> "); if (arrow >= 0) p = p.slice(arrow + 4);
      let f = path.join(ws, p.replace(/^"|"$/g, ""));
      for (let i=0;i<64;i++) {
        try { max = Math.max(max, fs.statSync(f).mtimeMs); break; } catch { const up=path.dirname(f); if(up===f) break; f=up; }
      }
    }
    return max;
  } catch { return 0; }
}
function bump(dir, sid, turnId) {
  const f = stateFile(dir, sid); let o = read(f) || { turnId:"", n:0 };
  if (turnId && o.turnId !== turnId) o = { turnId, n:0 };
  o.n = (Number(o.n) || 0) + 1; o.ts = new Date().toISOString(); save(f,o); return o.n;
}
function sameImplementer(ws, sid) {
  try {
    const home = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
    const o = JSON.parse(fs.readFileSync(path.join(home,"links.json"),"utf8"));
    const norm = (p) => path.normalize(p||"").replace(/[\\/]+$/,"").toLowerCase().normalize("NFC");
    const k = Object.keys(o.byWorkspace||{}).find((x)=>norm(x)===norm(ws));
    return !!k && o.byWorkspace[k].implementerSession === sid;
  } catch { return false; }
}
// [P-9 자동 전환] 이 세션이 이 프로젝트의 '검증자'로 연결돼 있는가 — 전환 前 역할 충돌 사전 판정(설계 ⑵).
// links 판독 실패는 true(충돌 취급) — 불확실한 상태에서 검증자를 구현자로 승격시키는 쪽이 더 위험(fail-closed).
function linkedVerifier(ws, sid) {
  try {
    const home = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
    const raw = fs.readFileSync(path.join(home, "links.json"), "utf8");
    const o = JSON.parse(raw);
    const norm = (p) => path.normalize(p||"").replace(/[\\/]+$/,"").toLowerCase().normalize("NFC");
    const k = Object.keys(o.byWorkspace||{}).find((x)=>norm(x)===norm(ws));
    if (!k) return false;
    return o.byWorkspace[k].codexSession === sid || o.byWorkspace[k].codexCodexSession === sid;
  } catch (e) { return !(e && e.code === "ENOENT"); }
}

// [P-9 자동 전환] 세션 출처 4분류(설계 ⑴ 명시 구현 — 구현검증 2차 지적 4): vscode-user만 전환 자격.
// exec(검증자 실행 — 훅 발화가 실측된 사실)·other(CLI 등 확정 비대상)는 침묵, unknown(rollout 미생성·판독
// 불가·id 불일치)은 '실사용자일 수도 있는 판정 불가'라 fail-closed(차단) — 침묵으로 합치면 rollout 생성
// 경합 시 실제 사용자 질문이 무게이트로 새는 우회가 된다.
function classifyPromptSource(j, sid) {
  const file = rolloutForSession(j, sid);
  if (!file) return "unknown";
  const meta = readFirstJsonLine(file);
  const p = meta && meta.type === "session_meta" ? (meta.payload || {}) : null;
  if (!p || String(p.id || "") !== sid) return "unknown";
  const src = String(p.source || ""), th = String(p.thread_source || "");
  if (src === "vscode" && th === "user") return "vscode-user";
  if (src === "exec" || src === "cli") return "exec";              // 확정 비대상(브릿지 검증 실행·CLI)
  if (src === "vscode" && th && th !== "user") return "other";      // VS Code의 확정 비사용자 스레드
  return "unknown"; // 그 외 전부(출처·스레드 미상/누락 — 예: source=vscode인데 thread_source 누락)는 허용목록 밖 → fail-closed(3차 지적 2)
}
// [P-9 3차 지적 1 → 7차 지적 1] 고정 실패 시 원복 후보 여부 — role-lock-unavailable(역할 전이 진행 중일 수
// 있음·재확인도 같은 잠금이라 불가)만 무조건 원복 금지. ★raced도 원복 후보★: 등록기의 raced에는 '무관
// 프로젝트의 역할 변경(전역 roleRevision 드리프트)'가 섞여 있어(실행 반증 — 로컬 불변인데 raced), 무조건
// 모드 유지하면 C-C 잔존+미고정 프롬프트가 무게이트로 샐 수 있다. 진짜 경합인지 여부는
// revertSwitchIfRoleUnchanged의 로컬 세대 CAS가 원복 '시점'에 판정한다: 로컬 전진=진짜 경합(원복 거부·모드
// 유지 — 새 C-C 턴 게이트 보존), 로컬 불변=전역 드리프트(원복 수행·CL-C 복귀·재전송 안내).
function revertOnPinFailure(reason) { return reason !== "role-lock-unavailable"; }
// [P-9 4차 지적 1] 역할 세대 CAS 원복 — role lock 아래에서 links를 1회 읽어, 전환 시작 시점 스냅샷(expected)
// 에서 구현자 세션·세대가 전진하지 않았을 때만 계약을 원복한다. 전진=새 C-C 턴 관측(모드 유지), 판독 불가=
// 불확실(원복 보류·모드 유지 — 그 상태의 상대 Stop은 role 판독 fail-closed가 차단). role lock→contract lock
// 순서 고정(역순 획득자 없음 — 교착 없음). registerCodexImplementer도 같은 role lock에서 직렬화되므로
// '재확인과 원복' 사이에 다른 등록이 끼어들 수 없다.
function revertSwitchIfRoleUnchanged(ws, lang, sid, expected) {
  try {
    return withRoleLock(() => {
      const home = process.env.CODEX_BRIDGE_HOME || path.join(require("os").homedir(), ".codex-bridge");
      let raw = null;
      try { raw = fs.readFileSync(path.join(home, "links.json"), "utf8"); }
      catch (e) { if (!(e && e.code === "ENOENT")) return { done: false, reason: "role-unreadable" }; }
      let cur = { session: "", revision: 0, eventAt: 0 };
      if (raw !== null) {
        let o; try { o = JSON.parse(raw); } catch { return { done: false, reason: "role-unreadable" }; }
        // 의미 손상(null·배열·원시·{byWorkspace:[]}·현재 ws 레코드 손상)을 빈 상태로 축소하면 손상 중 원복 실행(5·6차 지적 3)
        if (!validLinksShape(o, ws)) return { done: false, reason: "role-unreadable" };
        const rec = implementerRecordOf(o, ws);
        if (rec) cur = { session: rec.session, revision: rec.revision, eventAt: Number(rec.eventAt) || 0 };
      }
      // 비교는 ★현재 프로젝트의 session/revision/eventAt★(6차: 전역 roleRevision 비교는 교차 프로젝트
      // 오거부·이중 판독이라 폐기 / 8차: eventAt도 등록기 raced 조건과 동형으로 비교 — 스냅샷을 늦게 읽은
      // 오래된 훅은 session/revision이 '방금 읽은 최신 상태'와 같아 보여도 currentEventAt>eventStartedAt으로
      // raced가 되는데, 원복이 이를 '불변'으로 오판하면 진행 중인 최신 턴을 CL-C로 원복해 게이트를 해제한다
      // — 실행 반증 수용).
      if (cur.session !== String(expected.session || "") || Number(cur.revision || 0) !== Number(expected.revision || 0)
        || (Number(expected.eventStartedAt || 0) && cur.eventAt > Number(expected.eventStartedAt || 0))) {
        return { done: false, reason: "role-advanced" };
      }
      const ok = patchContractFields(ws, lang, {
        harnessMode: "claude-codex",
        modeSwitch: { by: "codex-hook", from: "claude-codex", to: "claude-codex", at: new Date().toISOString(), session: sid, lang, reverted: "pin-failed" },
      });
      return { done: ok, reason: ok ? "" : "patch-failed" };
    });
  } catch { return { done: false, reason: "role-lock-unavailable" }; }
}

// [P-9 자동 전환·사례 ②③] 설정=클로드-코덱스인데 질문이 Codex(VS Code 사용자 대화)에서 시작 — 질문 호스트가
// 사용자 의도의 기준점(사용자 결정 2026-07-15). 가드 실패는 block(전환 불가+경고만으로 진행하면 무게이트 턴 —
// 설계 ⓓ fail-closed. Codex가 프롬프트 block을 지원하지 않아 무시하면 현행(무동작)과 동일해 악화는 없음).
function autoSwitchToCodex(j, ws, sid, ev, lang, roleRevision) {
  if (ev !== "UserPromptSubmit") return { ok: false, silent: true }; // '질문 시작'만 기준 — SessionStart·도구·Stop은 물러남 유지
  const source = classifyPromptSource(j, sid);
  if (source === "exec" || source === "other") return { ok: false, silent: true }; // 확정 비대상 — 진행 중 검증 실행 보호
  if (source === "unknown") {
    block(t("이 Codex 대화의 정체(사용자 대화/검증 실행)를 판정할 수 없어 운용 모드를 결정하지 못했습니다(세션 기록 파일 미생성/판독 불가). 잠시 후 프롬프트를 다시 보내거나, 대시보드에서 모드를 직접 전환하세요.",
      "Cannot classify this Codex conversation (user chat vs verification run) — its session record is missing/unreadable, so the harness mode cannot be decided. Resend the prompt shortly, or switch the mode from the dashboard."));
    return { ok: false };
  }
  if (linkedVerifier(ws, sid)) {
    block(t("이 대화는 이 프로젝트의 검증 역할로 연결돼 있어 구현 모드로 전환할 수 없습니다(자기검증 방지). 다른 Codex 대화에서 질문을 시작하거나, 대시보드에서 검증자를 먼저 재배치하세요.",
      "This conversation is linked as this project's verifier and cannot switch to the implementer mode (self-verification guard). Start from another Codex conversation, or relink the verifier from the dashboard first."));
    return { ok: false };
  }
  const job = activeAskJobFor(ws);
  if (job) {
    block(t(`운용 모드가 클로드-코덱스인데 이 질문은 Codex에서 시작됐습니다. 자동 전환하려 했으나 진행 중인 검증 작업(${job.id})이 있어 전환하면 그 검증이 무효가 됩니다. 작업이 끝난 뒤 다시 보내거나, 대시보드에서 모드를 직접 전환하세요.`,
      `The harness mode is Claude-Codex but this prompt started in Codex. Auto-switch was halted because a verification job (${job.id}) is in flight and switching would invalidate it. Resend after it finishes, or switch the mode from the dashboard.`));
    return { ok: false };
  }
  const busy = phaseBusy(ws, ["claude-working", "rejudging", "codex-verifying"], 25 * 60 * 1000); // codex-verifying: 직접 ask 실행 중 표시(구현검증 1차 지적 1)
  if (busy && busy.session && busy.session !== sid) {
    block(t(`운용 모드가 클로드-코덱스인데 이 질문은 Codex에서 시작됐습니다. 자동 전환하려 했으나 Claude 쪽 진행 흔적(${busy.phase})이 최근에 있어 전환하면 그 턴의 게이트가 무장해제됩니다. Claude 턴이 끝난 뒤 다시 보내거나, 대시보드에서 모드를 직접 전환하세요.`,
      `The harness mode is Claude-Codex but this prompt started in Codex. Auto-switch was halted because the Claude side shows recent activity (${busy.phase}); switching would disarm that turn's gate. Resend after the Claude turn ends, or switch the mode from the dashboard.`));
    return { ok: false };
  }
  // 순서(구현검증 2차 지적 2·3): 패치 先 → 고정(pin) 後 → 고정 실패 시 패치 원복.
  // pin 先은 links(implementerSession·revision·전역 roleRevision)를 먼저 바꿔 패치 실패 시 '비 inert'
  // 잔재(configWs 앵커·기존 구현 세션 밀어냄·세대 전진)를 남긴다(실측 반증). 패치 先이면 실패 잔재가
  // 계약 1개 필드뿐이고 원복이 결정론적(잠금 보호 patch 1회). 고정 결과는 onPrompt에 전달해 재사용 —
  // 이중 등록의 세대 이중 전진(같은 sid도 revision 증가 실측)과 사이 경합을 제거.
  // 잠금 진단(3차 지적 3 → 4차 5상태): 삭제 안내는 dead(ESRCH 확정)에만 — EPERM·손상·판독 실패에 삭제를
  // 권하면 활성 저장의 잠금을 지우도록 오도(4차 지적 3 실행 반증).
  const lockHintNow = () => {
    const li = contractLockIssue(ws, lang);
    if (!li) return t(" (잠금 파일 없음 — 권한/손상 계열일 수 있습니다.)", " (No lock file found — likely permission/corruption.)");
    if (li.state === "alive") return t(` 다른 저장이 진행 중입니다: ${li.lockPath} (프로세스 ${li.pid} 실행 중) — 잠시 후 재시도하세요.`, ` Another save is in progress: ${li.lockPath} (process ${li.pid} running) — retry shortly.`);
    if (li.state === "dead") return t(` 잔존 잠금: ${li.lockPath} (보유 프로세스 ${li.pid} 종료 확인됨) — 이 파일을 삭제한 뒤 재시도하세요.`, ` Stale lock: ${li.lockPath} (owner process ${li.pid} confirmed gone) — delete this file and retry.`);
    if (li.state === "owner-unverified") return t(` 잠금 보유자 확인 불가: ${li.lockPath} (프로세스 ${li.pid} — 다른 사용자의 프로세스일 수 있음). 파일을 삭제하지 말고 그 프로세스 종료 후 재시도하세요.`, ` Lock owner unverified: ${li.lockPath} (process ${li.pid} — may belong to another user). Do not delete the file; retry after that process ends.`);
    return t(` 잠금 파일 상태를 판독할 수 없습니다: ${li.lockPath} — 임의 삭제하지 말고 잠시 후 재시도하세요.`, ` Lock file state unreadable: ${li.lockPath} — do not delete it; retry shortly.`);
  };
  // ★스냅샷은 패치 '전'에 확보(5차 지적 1)★ — 패치 후 스냅샷이면 '패치~스냅샷' 사이에 등록한 B가 스냅샷에
  // 이미 반영돼, 이후 원복 CAS가 'B=전환 시작 상태'로 오판하고 원복해 B의 C-C 턴 게이트를 해제한다(실행 반증).
  // 패치 전 스냅샷이면 이 프로젝트의 어떤 후속 등록도 로컬 session/revision/eventAt 차이로 관측된다
  // (원복 CAS는 로컬만 비교 — 6차: 전역 roleRevision 비교는 교차 프로젝트 오판이라 폐기 / 8차: 같은 세션의
  // 더 최신 프롬프트는 eventAt 전진으로 관측).
  const expected = codexImplementerSnapshot(ws, roleRevision, HOOK_STARTED_AT);
  const patched = patchContractFields(ws, lang, {
    harnessMode: "codex-codex",
    modeSwitch: { by: "codex-hook", from: "claude-codex", to: "codex-codex", at: new Date().toISOString(), session: sid, lang },
  });
  if (!patched) {
    block(t("운용 모드 자동 전환에 실패했습니다(계약 파일 기록 불가 — 잠금/권한/손상). 대시보드에서 모드를 직접 전환한 뒤 프롬프트를 다시 보내세요.",
      "Failed to auto-switch the harness mode (contract file not writable — lock/permission/corruption). Switch the mode from the dashboard, then resend the prompt.") + lockHintNow());
    return { ok: false };
  }
  const pinned = pinImplementer(j, ws, sid, expected);
  if (!pinned.ok) {
    if (!revertOnPinFailure(pinned.reason)) {
      // role-lock-unavailable: 역할 전이 진행 중일 수 있고 재확인(CAS)도 같은 잠금이라 불가 — 원복 보류.
      block(t("운용 모드는 코덱스-코덱스로 전환됐지만, 역할 잠금을 얻지 못해 구현 고정 여부를 확정할 수 없습니다(다른 역할 전이 진행 중일 수 있음 — 원복 보류). 잠시 후 프롬프트를 다시 보내거나 대시보드에서 정리하세요.",
        "The harness mode switched to Codex-Codex, but the role lock was unavailable so the pin state is uncertain (another role transition may be in progress — revert withheld). Resend shortly or tidy up from the dashboard."));
      return { ok: false };
    }
    // 원복 '시점'의 역할 세대를 role lock 아래 재확인(CAS) — 실패 반환~원복 사이에 links 복구+타 세션 등록이
    // 끼면 그 새 C-C 턴의 게이트를 지키기 위해 원복하지 않는다(4차 지적 1 실행 반증 봉합).
    const rb = revertSwitchIfRoleUnchanged(ws, lang, sid, expected);
    if (rb.done) {
      block(t("운용 모드 자동 전환을 취소했습니다 — 이 대화를 구현 역할로 고정하지 못했습니다: ", "Harness-mode auto-switch cancelled — this conversation could not be pinned as the implementer: ") + pinned.why);
      return { ok: false };
    }
    const tail = rb.reason === "role-advanced"
      ? t(" 그 사이 더 최신 Codex 프롬프트 또는 다른 대화가 구현 역할을 가져가 모드는 코덱스-코덱스로 유지했습니다 — 그쪽 턴에서 계속하세요.", " Meanwhile a newer Codex prompt or another conversation took the implementer role, so the mode stays Codex-Codex — continue in that turn.")
      : rb.reason === "patch-failed"
      ? t(" ⚠ 모드 원복 기록에 실패했습니다 — 대시보드에서 운용 모드를 확인하세요.", " ⚠ Reverting the mode failed to save — check the harness mode on the dashboard.") + lockHintNow()
      : t(" 역할 상태를 확정할 수 없어 원복을 보류했습니다(모드=코덱스-코덱스 유지). links.json 상태를 확인·복구한 뒤 다시 보내거나 대시보드에서 정리하세요.", " The role state could not be confirmed, so the revert was withheld (mode stays Codex-Codex). Check/repair links.json, then resend or tidy up from the dashboard.");
    block(t("이 대화를 구현 역할로 고정하지 못했습니다: ", "This conversation could not be pinned as the implementer: ") + pinned.why + tail);
    return { ok: false };
  }
  let c2 = null;
  try { c2 = loadContract(ws, lang); } catch { c2 = null; }
  if (!c2 || c2.harnessMode !== "codex-codex") {
    block(t("운용 모드 자동 전환 결과를 확인하지 못했습니다. 대시보드에서 모드를 확인·전환한 뒤 프롬프트를 다시 보내세요.",
      "Could not confirm the auto-switched harness mode. Check/switch the mode from the dashboard, then resend the prompt."));
    return { ok: false };
  }
  const notice = t("[Codex Bridge] 운용 모드 자동 전환: 설정은 클로드-코덱스였지만 이 질문이 Codex에서 시작되어 코덱스-코덱스로 전환했습니다(질문 호스트 기준). 의도와 다르면 대시보드에서 되돌리세요. 이번 턴부터 코덱스-코덱스 규칙·검증 설정이 적용됩니다.",
    "[Codex Bridge] Harness mode auto-switched: the setting was Claude-Codex, but this prompt started in Codex, so it switched to Codex-Codex (prompt host wins). Revert from the dashboard if unintended. Codex-Codex rules and verification apply from this turn.");
  return { ok: true, contract: c2, notice: notice + "\n\n", pinned };
}

function pinImplementer(j, ws, sid, expectedSession) {
  const effort = effortOf(j, "");
  const turnId = j.turn_id || j.turnId || "";
  // withRoleLock은 잠금 실패를 예외로 던진다(구현검증 4차 지적 2 — 예외가 최외곽 방벽에 삼켜지면 프롬프트
  // 이벤트가 차단 없이 통과하는 fail-open). 불확실 사유로 변환해 호출자가 반드시 차단하게 한다.
  let reg;
  try { reg = registerCodexImplementer(ws, sid, j.model || "", effort, expectedSession); }
  catch { reg = { ok: false, reason: "role-lock-unavailable" }; }
  if (!reg.ok) {
    if (reg.reason === "role-lock-unavailable") return {
      ok:false, reason:reg.reason,
      why:t("역할 잠금을 얻지 못해 구현 고정 여부를 확정할 수 없습니다. 잠시 후 프롬프트를 다시 보내세요.", "Could not acquire the role lock, so the implementer pin state is uncertain. Resend the prompt shortly."),
    };
    if (reg.reason === "implementer-raced") return {
      ok:false, reason:reg.reason,
      why:t("세션을 확인하는 동안 더 최신 Codex 프롬프트 또는 다른 대화가 구현 역할을 가져갔습니다. 이 오래된 훅은 최신 연결을 덮지 않았습니다.", "A newer Codex prompt or another conversation became the implementer while this session was checked. This stale hook did not overwrite the latest link."),
    };
    const why = reg.reason === "verifier-conflict"
      ? t("현재 세션은 이미 검증 역할이라 구현 역할에도 연결할 수 없습니다. 구현·검증은 서로 다른 세션이어야 합니다.", "This session is already the verifier and cannot also be the implementer. The two roles require distinct sessions.")
      : (reg.reason === "links-corrupt" || reg.reason === "links-unreadable")
      ? t(`links.json이 ${reg.reason === "links-corrupt" ? "손상" : "판독 불가"} 상태라 유실 방지를 위해 기록하지 않았습니다. 파일을 백업 후 복구(유효한 JSON)하거나 삭제(초기화)한 뒤 새 프롬프트로 다시 고정하세요.`, `links.json is ${reg.reason === "links-corrupt" ? "corrupt" : "unreadable"}, so nothing was written to prevent data loss. Back up and repair the file (valid JSON) or delete it (reset), then re-pin with a new prompt.`)
      : t("현재 대화를 구현 세션으로 자동 고정하지 못했습니다. 링크 파일 쓰기 상태를 확인하세요.", "Could not auto-pin the current conversation as the implementer. Check the link-file write state.");
    return { ok:false, reason:reg.reason, why };
  }
  return { ok:true, turnId };
}
function onSessionStart(j, ws, sid, c, roleRevision) {
  const expectedSession = codexImplementerSnapshot(ws, roleRevision, HOOK_STARTED_AT);
  // originator/environment values can be inherited by an exec verifier. The rollout's immutable
  // session_meta identity is authoritative; if it is not readable yet, fail closed and let the
  // first real user prompt retry after the rollout has appeared.
  if (!isVscodeUserSession(j, sid)) return;
  const pinned = pinImplementer(j, ws, sid, expectedSession);
  if (!pinned.ok) { context("SessionStart", "[Codex Bridge] " + pinned.why); return; }
  heartbeat(j, ws, sid, "SessionStart");
  try { writePhase("codex-implementing", { round:0, session:sid, workspace:ws }); } catch { /* display only */ }
  context("SessionStart", implementerContext(j, ws, c));
}
function onPrompt(j, ws, sid, c, roleRevision, preface, prePinned) {
  preface = preface || ""; // [P-9] 자동 전환 고지 — 이 턴 주입의 최상단에 붙는다
  const expectedSession = codexImplementerSnapshot(ws, roleRevision, HOOK_STARTED_AT);
  // UserPromptSubmit can also run in CLI/exec sessions. Never let those sessions take the
  // implementer role merely because they carry a prompt or inherited VS Code environment.
  if (!isVscodeUserSession(j, sid)) return;
  // [P-9] 자동 전환이 방금 고정을 마쳤으면 재사용 — 이중 등록은 같은 sid여도 revision·roleRevision을
  // 한 번 더 전진시키고(실측), 두 등록 사이 경합이 raced 과도 상태를 만든다(구현검증 2차 지적 2).
  const pinned = prePinned || pinImplementer(j, ws, sid, expectedSession);
  if (!pinned.ok) { context("UserPromptSubmit", preface + "[Codex Bridge] " + pinned.why); return; }
  const turnId = pinned.turnId;
  heartbeat(j, ws, sid, "UserPromptSubmit");
  // 턴 상태 저장 실패를 무시하면 Stop이 turn-missing으로 차단될 때 원인을 알 수 없다 — 1회 재시도 후에도
  // 실패면 주입 컨텍스트에 고지(구현 검증 1차 지적: 상태 기록 실패의 침묵 금지).
  const turnState = { schema:"codex-turn-v1", turnId, workspace:ws, startedAt:Date.now(), lastActionAt:0, modified:false, permissionMode:j.permission_mode||"" };
  const turnSaved = save(stateFile(TURN_DIR,sid), turnState) || save(stateFile(TURN_DIR,sid), turnState);
  try { writePhase("codex-implementing", { round:0, session:sid, workspace:ws }); } catch { /* display only */ }
  const ctx = implementerContext(j, ws, c);
  const body = turnSaved ? ctx : t("[Codex Bridge] 턴 상태 기록에 실패했습니다 — 이 턴 종료 시 검증 게이트가 턴 상태 재기록을 요구할 수 있습니다.\n\n","[Codex Bridge] Failed to record the turn state — the verification gate may ask to rewrite it when this turn stops.\n\n") + ctx;
  context("UserPromptSubmit", preface ? preface + body : body); // [P-9] body가 비어도 전환 고지는 단독 출력
}
function onTool(j, ws, sid, c) {
  if(!sameImplementer(ws,sid)) return;
  heartbeat(j, ws, sid, "PostToolUse");
  const f=stateFile(TURN_DIR,sid), s=read(f)||{schema:"codex-turn-v1",turnId:j.turn_id||"",workspace:ws,startedAt:Date.now(),lastActionAt:0,modified:false,permissionMode:j.permission_mode||""};
  const name=String(j.tool_name||j.tool||"");
  // PostToolUse에는 사전 스냅샷이 없으므로 Bash/MCP는 보수적으로 변경 가능 신호로 본다. 실제 git dirty만
  // 보다가 같은 턴 commit이나 비-git 쓰기를 놓쳐 검증을 우회하는 것보다 필요 시 한 번 더 검증하는 편이 안전하다.
  if(/^(Bash|apply_patch|Edit|Write|MultiEdit|NotebookEdit)$/i.test(name)||/^mcp__/i.test(name)){s.modified=true;s.lastActionAt=Date.now();}
  if(!save(f,s))save(f,s); // 저장 실패 침묵 금지 — 1회 재시도(끝내 실패하면 Stop의 정확 판독이 차단으로 잡는다)
}
function scoutGate(j, ws, sid, c, s) {
  if(c.scoutMode!=="on" || j.permission_mode!=="plan") return false;
  let target=ws, st=null;
  try { target=resolveScoutRepo(ws,c).repo; st=scoutMapStatus(target); } catch { return false; }
  if(!st || st.state==="fresh") return false;
  const n=bump(SCOUT_ATTEMPT_DIR,sid,j.turn_id||s.turnId||""); if(n>MAX_SCOUT_ATTEMPTS)return false;
  let health=""; try{health=scoutHealthLine(target,loadLang()==="en")||"";}catch{}
  block(t(`플랜 확정 전 3트랙 지도가 ${st.state} 상태입니다. \`node scripts/scope-scout-self.js "${target}"\`로 공용 지도·일지를 갱신한 뒤 계속하세요. ${health}`, `Before finalizing the plan, the shared 3-track map is ${st.state}. Run \`node scripts/scope-scout-self.js "${target}"\`, update the shared map/journal, then continue. ${health}`));
  return true;
}
function onStop(j, ws, sid, c) {
  // P-6(설계 v5.1): 역할 판독은 role lock 아래 links 1회 파싱 — sameImplementer의 독립 재판독은 같은 sid로
  // 갔다 돌아온 ABA를 revision과 다른 시점에 읽는 경합이 있어 폐기. 잠금 실패가 훅 최상위 catch(성공 삼킴)로
  // 새면 게이트가 fail-open이므로 여기서 명시 block(fail-closed·재시도 유도).
  let roleRes = null, roleErr = false;
  try { roleRes = readImplementerRecordLocked(ws); } catch { roleErr = true; }
  // 잠금 실패뿐 아니라 links.json 손상·판독 실패도 차단(fail-closed) — 손상을 '구현자 아님'으로 축소하면
  // 검증 없이 통과하는 fail-open이 된다(구현 검증 1차 지적). '파일 없음'만 정상(record=null)으로 조용히 종료.
  if (roleErr || !roleRes || roleRes.ok === false) { block(t(`역할 상태를 판정할 수 없습니다(${roleErr ? "잠금 실패" : (roleRes && roleRes.reason) || "판독 실패"}). links.json 상태를 확인·복구한 뒤 종료를 다시 시도하세요.`, `Cannot judge the role state (${roleErr ? "lock failure" : (roleRes && roleRes.reason) || "read failure"}). Check/repair links.json, then retry stopping.`)); return; }
  const role = roleRes.record;
  if (!role || role.session !== sid) return;
  heartbeat(j, ws, sid, "Stop");
  // 턴 상태도 정확 판독 — 부재·손상 시 startedAt=now 기본값을 만들면 edited=false → needed=false로 durable
  // 게이트를 건너뛰는 fail-open 통로가 된다(구현 검증 1차 지적). 구현 세션의 Stop인데 턴 상태가 없다면
  // 기록 유실·손상이므로 차단하고 재기록을 유도한다.
  const sRes = readCodexTurnStrict(sid, ws);
  if (!sRes.ok) { block(t(`이번 턴 상태를 읽을 수 없습니다(${sRes.reason}). 구현 대화에서 새 프롬프트를 한 번 보내 턴 상태를 재기록한 뒤 이어가세요.`, `Cannot read this turn's state (${sRes.reason}). Send one new prompt in the implementer conversation to rewrite the turn state, then continue.`)); return; }
  const s = sRes.turn;
  if(scoutGate(j,ws,sid,c,s)) return;
  const gitTs=gitChangedMaxMtime(ws); const edited=!!s.modified || gitTs>Number(s.startedAt||0);
  const planned=j.permission_mode==="plan";
  const vmCc=c.codexVerifyMode; // C-C 슬롯 스위치(모드별 분리 2026-07-15) — CL-C의 verifyMode와 독립
  const needed=vmCc==="always" || ((vmCc==="code"||vmCc==="plancode")&&edited) || (vmCc==="plancode"&&planned);
  if(!needed){try{writePhase("done",{session:sid,workspace:ws});}catch{} return;}
  // 신선도에서 lastActionAt 제거(P-6 자기무효화 해소) — 검증 결과를 '회수하는' 도구 호출이 proof를 낡게
  // 만들지 않는다. 실제 파일 변경(dirty mtime)과 턴 시작만 본다. 커밋 은닉·회수 정당성은 durableProofGate의
  // HEAD OID·영수증 결속이 담당한다.
  const since=Math.max(Number(s.startedAt||0),gitTs||0);
  const gate=durableProofGate({ws,sid,eventTurnId:String(j.turn_id||""),stateTurnId:String(s.turnId||""),roleRevision:role.revision,since});
  // [P-9 후보③ 2026-07-16] 성공 Stop은 done으로 '종결'한다 — 종전 rejudging 기록은 ①다음 프롬프트가 없으면
  // '반영중' 고아 잔존(모드 불일치 없이도) ②자동 전환 가드(phaseBusy)가 정상 완료 직후를 활성 턴으로 오인해
  // 다음 Claude 질문을 최대 25분 오차단(구현검증 1차 지적 2)의 원인. 검증 답 회수~Stop 사이의 '반영중'은
  // cmdAsk가 그대로 기록하므로 표시 흐름은 유지된다.
  if(gate.ok){try{writePhase("done",{session:sid,workspace:ws});}catch{} return;}
  const n=bump(ATTEMPT_DIR,sid,j.turn_id||s.turnId||"");
  if(n>MAX_VERIFY_ATTEMPTS){try{writePhase("incomplete",{session:sid,workspace:ws});}catch{} return;}
  block(t(`검증이 필요한 최종 상태인데 이번 턴에 결속된 성공 증명이 없습니다(${n}/${MAX_VERIFY_ATTEMPTS} · 판정: ${gate.reason}). 대시보드의 검증 대기시간을 따르는 내구 작업을 1개만 시작하세요: \`node "${path.join(BRIDGE_DIR,"codex-bridge.js")}" ask-start --allow-new "<검증 요청>"\`. 반환된 job id로 \`ask-wait <job-id>\`를 pending 동안 반복하고(완료 회수까지 같은 턴에서), 결과를 항목별 재판단한 뒤 종료하세요.`, `The final state requires verification but has no success proof bound to this turn (${n}/${MAX_VERIFY_ATTEMPTS} · verdict: ${gate.reason}). Start exactly one durable job using the dashboard wait: \`node "${path.join(BRIDGE_DIR,"codex-bridge.js")}" ask-start --allow-new "<verification request>"\`. Repeat \`ask-wait <job-id>\` while pending (retrieve within the same turn), re-judge the result item by item, then stop.`));
}

function main(raw){
  let j={};try{j=JSON.parse(raw)||{};}catch{return;}
  const sid=j.session_id||process.env.CODEX_THREAD_ID||""; if(!sid)return;
  // Capture before cleanup, config/workspace discovery, and rollout I/O. Each of those can be
  // slow enough for a newer conversation to change the role while this older hook is waiting.
  const roleRevision=codexRoleRevision();
  try{maybeCleanupState();}catch{}
  // 첫 턴에는 cwd로 프로젝트를 정하고 writeCodexActive가 세션별 앵커를 만든다. 이후 실제 작업 폴더가
  // 달라져도 같은 세션은 그 앵커를 우선한다(Claude configWs와 동일한 프로젝트 추적 불변조건).
  const ws=configWs({codexSessionId:sid,cwd:j.cwd||process.cwd()});
  const ev=j.hook_event_name||"";
  // [P-9 자동 전환] 언어 슬롯 1회 스냅샷 — 손상 판정·계약 판독·(전환 시) 패치가 같은 슬롯에 결속(설계 ⓖ,
  // 구현검증 1차 지적 5: 한 슬롯의 손상을 보고 다른 슬롯을 전환하는 어긋남 차단).
  const lang=loadLang();
  // 계약 파일이 '존재하는데 손상'이면 모드 권위를 판정할 수 없다 — loadContract의 기본값 축소로 C-C 훅
  // 전체가 조용히 꺼지는 fail-open 차단(구현 검증 2차 지적 2). 부재(absent)는 legacy 기본값으로 정상 진행.
  // Stop뿐 아니라 '사람이 시작한 질문'(vscode-user UserPromptSubmit)도 차단(1차 지적 3a — Claude 측 손상
  // 차단과 대칭). exec/미상 세션 프롬프트는 침묵 유지: 브릿지가 모는 검증 실행까지 차단하면 손상 복구 중
  // 진행 중 검증이 죽는다.
  if(contractReadState(ws,lang)==="corrupt"){
    if(ev==="Stop")block(t("프로젝트 계약 파일이 손상되어 이번 종료를 판정할 수 없습니다. 대시보드에서 계약을 다시 저장한 뒤 종료를 재시도하세요.","The project contract file is corrupt, so this stop cannot be judged. Re-save the contract from the dashboard, then retry stopping."));
    // 손상 분기도 4분류(3차 지적 2): vscode-user뿐 아니라 unknown(판정 불가 — 실사용자일 수 있음)도 차단.
    // exec/other(확정 비대상)만 침묵 — 손상 복구 중 브릿지가 모는 진행 검증 실행을 죽이지 않기 위함.
    else if(ev==="UserPromptSubmit"){
      const src=classifyPromptSource(j,sid);
      if(src==="vscode-user"||src==="unknown")block(t("프로젝트 계약 파일이 손상되어 운용 모드·검증 설정을 판정할 수 없습니다. 대시보드에서 계약을 다시 저장한 뒤 프롬프트를 다시 보내세요.","The project contract file is corrupt, so the harness mode and verification settings cannot be judged. Re-save the contract from the dashboard, then resend the prompt."));
    }
    return;
  }
  let c;try{c=loadContract(ws,lang);}catch{return;}
  let preface="",prePinned=null;
  if(c.harnessMode!=="codex-codex"){
    const sw=autoSwitchToCodex(j,ws,sid,ev,lang,roleRevision);
    if(!sw.ok)return; // silent(자격 없음) 또는 block/안내 출력 완료 — 물러남 유지
    c=sw.contract; preface=sw.notice; prePinned=sw.pinned||null;
  }
  if(ev==="SessionStart")return onSessionStart(j,ws,sid,c,roleRevision);
  if(ev==="UserPromptSubmit")return onPrompt(j,ws,sid,c,roleRevision,preface,prePinned);
  if(ev==="PreToolUse"||ev==="PostToolUse")return onTool(j,ws,sid,c);
  if(ev==="Stop"){
    // 검증 게이트만은 미지 예외도 성공으로 새면 안 된다(sReal 잔재 ReferenceError 무음 통과 실사고 —
    // 구현 검증 2차 지적 1). 상세는 stderr, 사용자에겐 사유 코드만.
    try{return onStop(j,ws,sid,c);}
    catch(e){try{process.stderr.write("codex-hook Stop internal error: "+String(e&&e.stack||e)+"\n");}catch{/* 진단 실패 무해 */}
      block(t("Stop 판정 내부 오류(internal-error) — 잠시 후 종료를 다시 시도하세요.","Internal error while judging Stop (internal-error) — retry stopping shortly."));return;}
  }
}
// 최외곽 예외 처리 — Stop 이벤트만은 전처리(configWs·계약 판독 등)의 미지 예외도 성공으로 새면 안 된다
// (구현 검증 3차 지적 2: cwd 비문자열 페이로드로 전처리 예외→exit 0 실측). 그 외 이벤트는 기존대로 무해 종료.
// [P-9 4차] 테스트 주입구: 훅 실행(require.main)일 때만 stdin을 구동 — 테스트는 require로 내부 결정 함수
// (역할 세대 CAS 원복 등)를 실행 반례로 검증한다(두 프로세스 경합을 단일 프로세스에서 결정론 재현).
if (require.main !== module) {
  module.exports = { classifyPromptSource, revertOnPinFailure, revertSwitchIfRoleUnchanged };
} else {
let buf="";process.stdin.on("data",d=>buf+=d);process.stdin.on("end",()=>{try{main(buf);}catch(e){
  try{
    let ev="";try{ev=String((JSON.parse(buf)||{}).hook_event_name||"");}catch{/* 파싱 불가면 이벤트 미상 */}
    if(ev==="Stop"){
      try{process.stderr.write("codex-hook Stop pre-dispatch error: "+String(e&&e.stack||e)+"\n");}catch{/* 진단 실패 무해 */}
      let msg="Stop 판정 내부 오류(internal-error) — 잠시 후 종료를 다시 시도하세요.";
      try{msg=t("Stop 판정 내부 오류(internal-error) — 잠시 후 종료를 다시 시도하세요.","Internal error while judging Stop (internal-error) — retry stopping shortly.");}catch{/* 언어 판독 실패=ko 고정 */}
      jsonOut({decision:"block",reason:msg});
    }
  }catch{/* 마지막 방벽 — 어떤 실패도 훅 프로세스를 비정상 종료시키지 않음 */}
  process.exit(0);
}});process.stdin.on("error",()=>process.exit(0));
}
