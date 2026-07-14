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
  if(c.verifyMode!=="off") parts.push(buildVerifyDirective(c.verifyMode));
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

function pinImplementer(j, ws, sid, expectedSession) {
  const effort = effortOf(j, "");
  const turnId = j.turn_id || j.turnId || "";
  const reg = registerCodexImplementer(ws, sid, j.model || "", effort, expectedSession);
  if (!reg.ok) {
    if (reg.reason === "implementer-raced") return {
      ok:false,
      why:t("세션을 확인하는 동안 더 최신 Codex 대화가 구현 역할을 가져갔습니다. 이 오래된 훅은 최신 연결을 덮지 않았습니다.", "A newer Codex conversation became the implementer while this session was checked. This stale hook did not overwrite the latest link."),
    };
    const why = reg.reason === "verifier-conflict"
      ? t("현재 세션은 이미 검증 역할이라 구현 역할에도 연결할 수 없습니다. 구현·검증은 서로 다른 세션이어야 합니다.", "This session is already the verifier and cannot also be the implementer. The two roles require distinct sessions.")
      : t("현재 대화를 구현 세션으로 자동 고정하지 못했습니다. 링크 파일 쓰기 상태를 확인하세요.", "Could not auto-pin the current conversation as the implementer. Check the link-file write state.");
    return { ok:false, why };
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
function onPrompt(j, ws, sid, c, roleRevision) {
  const expectedSession = codexImplementerSnapshot(ws, roleRevision, HOOK_STARTED_AT);
  // UserPromptSubmit can also run in CLI/exec sessions. Never let those sessions take the
  // implementer role merely because they carry a prompt or inherited VS Code environment.
  if (!isVscodeUserSession(j, sid)) return;
  const pinned = pinImplementer(j, ws, sid, expectedSession);
  if (!pinned.ok) { context("UserPromptSubmit", "[Codex Bridge] " + pinned.why); return; }
  const turnId = pinned.turnId;
  heartbeat(j, ws, sid, "UserPromptSubmit");
  // 턴 상태 저장 실패를 무시하면 Stop이 turn-missing으로 차단될 때 원인을 알 수 없다 — 1회 재시도 후에도
  // 실패면 주입 컨텍스트에 고지(구현 검증 1차 지적: 상태 기록 실패의 침묵 금지).
  const turnState = { schema:"codex-turn-v1", turnId, workspace:ws, startedAt:Date.now(), lastActionAt:0, modified:false, permissionMode:j.permission_mode||"" };
  const turnSaved = save(stateFile(TURN_DIR,sid), turnState) || save(stateFile(TURN_DIR,sid), turnState);
  try { writePhase("codex-implementing", { round:0, session:sid, workspace:ws }); } catch { /* display only */ }
  const ctx = implementerContext(j, ws, c);
  context("UserPromptSubmit", turnSaved ? ctx : t("[Codex Bridge] 턴 상태 기록에 실패했습니다 — 이 턴 종료 시 검증 게이트가 턴 상태 재기록을 요구할 수 있습니다.\n\n","[Codex Bridge] Failed to record the turn state — the verification gate may ask to rewrite it when this turn stops.\n\n") + ctx);
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
  const needed=c.verifyMode==="always" || ((c.verifyMode==="code"||c.verifyMode==="plancode")&&edited) || (c.verifyMode==="plancode"&&planned);
  if(!needed){try{writePhase("done",{session:sid,workspace:ws});}catch{} return;}
  // 신선도에서 lastActionAt 제거(P-6 자기무효화 해소) — 검증 결과를 '회수하는' 도구 호출이 proof를 낡게
  // 만들지 않는다. 실제 파일 변경(dirty mtime)과 턴 시작만 본다. 커밋 은닉·회수 정당성은 durableProofGate의
  // HEAD OID·영수증 결속이 담당한다.
  const since=Math.max(Number(s.startedAt||0),gitTs||0);
  const gate=durableProofGate({ws,sid,eventTurnId:String(j.turn_id||""),stateTurnId:String(s.turnId||""),roleRevision:role.revision,since});
  if(gate.ok){try{writePhase("rejudging",{session:sid,workspace:ws});}catch{} return;}
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
  // 계약 파일이 '존재하는데 손상'이면 모드 권위를 판정할 수 없다 — loadContract의 기본값 축소로 C-C 훅
  // 전체가 조용히 꺼지는 fail-open 차단(구현 검증 2차 지적 2). 부재(absent)는 legacy 기본값으로 정상 진행.
  if(contractReadState(ws)==="corrupt"){ if(ev==="Stop")block(t("프로젝트 계약 파일이 손상되어 이번 종료를 판정할 수 없습니다. 대시보드에서 계약을 다시 저장한 뒤 종료를 재시도하세요.","The project contract file is corrupt, so this stop cannot be judged. Re-save the contract from the dashboard, then retry stopping.")); return; }
  let c;try{c=loadContract(ws);}catch{return;} if(c.harnessMode!=="codex-codex")return;
  if(ev==="SessionStart")return onSessionStart(j,ws,sid,c,roleRevision);
  if(ev==="UserPromptSubmit")return onPrompt(j,ws,sid,c,roleRevision);
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
