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
  BRIDGE_DIR, PROOFS_DIR, loadContract, loadLang, buildInjection, buildVerifyDirective, buildScoutDirective,
  registerCodexImplementer, codexImplementerSnapshot, codexRoleRevision, writeCodexActive, readCodexActive, atomicWrite, writePhase, resolveScoutRepo, scoutMapStatus,
  scoutHealthLine, maybeCleanupState, configWs,
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
function proofOk(sid, since) {
  const p = read(path.join(PROOFS_DIR, safe(sid) + ".json"));
  if (!p || p.status !== "success" || p.exit !== 0 || !(Number(p.answerChars) > 0)) return false;
  const ts = Date.parse(p.ts || ""); return Number.isFinite(ts) && ts >= since;
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
  save(stateFile(TURN_DIR,sid), { schema:"codex-turn-v1", turnId, workspace:ws, startedAt:Date.now(), lastActionAt:0, modified:false, permissionMode:j.permission_mode||"" });
  try { writePhase("codex-implementing", { round:0, session:sid, workspace:ws }); } catch { /* display only */ }
  context("UserPromptSubmit", implementerContext(j, ws, c));
}
function onTool(j, ws, sid, c) {
  if(!sameImplementer(ws,sid)) return;
  heartbeat(j, ws, sid, "PostToolUse");
  const f=stateFile(TURN_DIR,sid), s=read(f)||{turnId:j.turn_id||"",workspace:ws,startedAt:Date.now(),modified:false,lastActionAt:0};
  const name=String(j.tool_name||j.tool||"");
  // PostToolUse에는 사전 스냅샷이 없으므로 Bash/MCP는 보수적으로 변경 가능 신호로 본다. 실제 git dirty만
  // 보다가 같은 턴 commit이나 비-git 쓰기를 놓쳐 검증을 우회하는 것보다 필요 시 한 번 더 검증하는 편이 안전하다.
  if(/^(Bash|apply_patch|Edit|Write|MultiEdit|NotebookEdit)$/i.test(name)||/^mcp__/i.test(name)){s.modified=true;s.lastActionAt=Date.now();}
  save(f,s);
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
  if(!sameImplementer(ws,sid)) return;
  heartbeat(j, ws, sid, "Stop");
  const s=read(stateFile(TURN_DIR,sid))||{turnId:j.turn_id||"",startedAt:Date.now(),lastActionAt:0,modified:false};
  if(scoutGate(j,ws,sid,c,s)) return;
  const gitTs=gitChangedMaxMtime(ws); const edited=!!s.modified || gitTs>Number(s.startedAt||0);
  const planned=j.permission_mode==="plan";
  const needed=c.verifyMode==="always" || ((c.verifyMode==="code"||c.verifyMode==="plancode")&&edited) || (c.verifyMode==="plancode"&&planned);
  if(!needed){try{writePhase("done",{session:sid,workspace:ws});}catch{} return;}
  const since=Math.max(Number(s.startedAt||0),Number(s.lastActionAt||0),gitTs||0);
  if(proofOk(sid,since)){try{writePhase("rejudging",{session:sid,workspace:ws});}catch{} return;}
  const n=bump(ATTEMPT_DIR,sid,j.turn_id||s.turnId||"");
  if(n>MAX_VERIFY_ATTEMPTS){try{writePhase("incomplete",{session:sid,workspace:ws});}catch{} return;}
  block(t(`검증이 필요한 최종 상태인데 성공 증명이 없습니다(${n}/${MAX_VERIFY_ATTEMPTS}). 대시보드의 검증 대기시간을 따르는 내구 작업을 1개만 시작하세요: \`node "${path.join(BRIDGE_DIR,"codex-bridge.js")}" ask-start --allow-new "<검증 요청>"\`. 반환된 job id로 \`ask-wait <job-id>\`를 pending 동안 반복하고, 결과를 항목별 재판단한 뒤 종료하세요.`, `The final state requires verification but has no success proof (${n}/${MAX_VERIFY_ATTEMPTS}). Start exactly one durable job using the dashboard wait: \`node "${path.join(BRIDGE_DIR,"codex-bridge.js")}" ask-start --allow-new "<verification request>"\`. Repeat \`ask-wait <job-id>\` while pending, re-judge the result item by item, then stop.`));
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
  let c;try{c=loadContract(ws);}catch{return;} if(c.harnessMode!=="codex-codex")return;
  const ev=j.hook_event_name||"";
  if(ev==="SessionStart")return onSessionStart(j,ws,sid,c,roleRevision);
  if(ev==="UserPromptSubmit")return onPrompt(j,ws,sid,c,roleRevision);
  if(ev==="PreToolUse"||ev==="PostToolUse")return onTool(j,ws,sid,c);
  if(ev==="Stop")return onStop(j,ws,sid,c);
}
let buf="";process.stdin.on("data",d=>buf+=d);process.stdin.on("end",()=>{try{main(buf);}catch{process.exit(0);}});process.stdin.on("error",()=>process.exit(0));
