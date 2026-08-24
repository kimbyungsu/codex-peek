"use strict";
// [Envelope Selector v7 §3] 무부작용 선별 실행기 — 정찰 계층에서 '공급자 해석·격리 exec·사용량 기록'만
// 추출(설계검증 1차 보완: runScout 재사용 금지 — 그 함수는 scope 수집·MAP 기록 부작용 내장).
// 팔 고정=구현 턴과 같은 provider(3차 blocker②⑥): Claude 턴→self(claude)·Codex 턴→codex — 자동 결정·설정
// 없음(교차·외부 API 팔은 v1 제외: 원문이 이미 가 있는 서비스 밖으로 원문 불전송이 경계 그 자체).
// 실행 형태(3차 blocker④): 비동기 spawn — 호출자(worker)가 실행 '중'에도 cancel-intent를 관측하고
// cancel()로 프로세스 트리를 종료할 수 있다(spawnSync 5~8분 블록 금지).
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const CL = require("./contract-lib.js");

// 팔 결정 — 구현 턴 provider 판독(constraintTurnContext와 같은 env 계보). 교차를 만들 설정 인자는 없다(소스 계약).
function selectorArmForTurn(env) {
  const e = env || process.env;
  if (typeof e.CLAUDE_CODE_SESSION_ID === "string" && e.CLAUDE_CODE_SESSION_ID) return "self";
  if (typeof e.CODEX_THREAD_ID === "string" && e.CODEX_THREAD_ID) return "codex";
  return null; // 판독 불가=선별 불가(호출자가 fail-closed)
}

const SELF_DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";

// Windows 포함 프로세스 트리 종료 — 자식(셔틀 경유 손자 포함)까지. 종료 확인은 호출자 promise 정착으로.
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 }); } catch { /* 종료 실패=promise가 timeout으로 정착 */ }
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료 */ } }
  }
}

// 페이지 1회 실행 — 반환 {promise, cancel}. promise는 {ok, output, key, detail, durationMs, cancelled}로 정착.
// 격리: self=도구 전면 차단 stdin 1회 호출 / codex=빈 임시 폴더·read-only·ephemeral(정찰 exec 인자 재사용).
function runSelectorPage({ arm, prompt, timeoutMs }) {
  const t0 = Date.now();
  let child = null, cancelled = false, settled = false;
  const cancel = () => { cancelled = true; if (child && !settled) killTree(child.pid); };
  const promise = new Promise((resolve) => {
    const done = (r) => { if (!settled) { settled = true; resolve({ ...r, durationMs: Date.now() - t0, cancelled }); } };
    let target, args, opts, tmpCwd = null, outFile = null;
    try {
      if (arm === "self") {
        target = CL.resolveExecutableForSpawn("claude", process.env);
        if (!target) return done({ ok: false, key: "cli-missing", detail: "claude-not-found" });
        // --strict-mcp-config(+--mcp-config 미전달)=사용자 설정 MCP 전면 무효(3a 재검증 blocker ab-7 —
        // 내장 도구 차단만으로는 사용자 MCP로 원문·diff가 외부 전송될 수 있음).
        args = ["-p", "--output-format", "text", "--disallowedTools", SELF_DENY, "--strict-mcp-config"];
        opts = { windowsHide: true, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] };
      } else if (arm === "codex") {
        const inv = require("./codex-bridge.js").resolveCodex();
        target = CL.resolveExecutableForSpawn(inv.file, process.env);
        if (!target) return done({ ok: false, key: "cli-missing", detail: "codex-not-found" });
        tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "selector-codex-"));
        outFile = path.join(tmpCwd, "selector-out.txt");
        // [3a 확인검증 blocker ab-7] 사용자 config.toml(MCP 포함) 무효화의 정본=격리 홈 — 빈 표 -c 오버라이드는
        // '병합'이라 기존 서버가 enabled로 남는 것이 실측됨(폐기). 임시 CODEX_HOME에 인증 파일만 복사해
        // 설정 파일 자체가 없는 홈에서 실행(MCP 0·기본 설정). 인증 사본은 아래 close에서 홈째 삭제.
        const realHome = (() => {
          let h = process.env.CODEX_HOME || "";
          try { if (!h) h = fs.readFileSync(path.join(CL.BRIDGE_DIR, "codex-home.txt"), "utf8").trim(); } catch { /* 미기록 */ }
          return h || path.join(os.homedir(), ".codex");
        })();
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "selector-codex-home-"));
        try { fs.copyFileSync(path.join(realHome, "auth.json"), path.join(tmpHome, "auth.json")); }
        catch { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 잔재 무해 */ } try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 잔재 무해 */ } return done({ ok: false, key: "auth-missing", detail: "codex auth.json unreadable" }); }
        tmpCwd = tmpCwd; // (가독) cwd=빈 임시 폴더 유지
        args = [...inv.args, ...CL.codexScoutExecArgs(outFile)]; // read-only·--ephemeral·출력 파일 — 정찰 격리 인자 재사용
        opts = { cwd: tmpCwd, env: { ...CL.codexScoutExecEnv(process.env, "selector"), CODEX_HOME: tmpHome }, windowsHide: true, shell: !!inv.shell, stdio: ["pipe", "ignore", "pipe"] };
        opts.__tmpHome = tmpHome;
      } else return done({ ok: false, key: "bad-arm", detail: String(arm) });
    } catch (e) { return done({ ok: false, key: "spawn-prep-failed", detail: String((e && e.message) || e) }); }
    let out = "", err = "";
    try { child = spawn(target, args, opts); } catch (e) { return done({ ok: false, key: "spawn-failed", detail: String((e && e.message) || e) }); }
    const timer = setTimeout(() => { killTree(child.pid); }, Math.max(1000, Number(timeoutMs) || 1000));
    if (child.stdout) child.stdout.on("data", (d) => { out += String(d); });
    if (child.stderr) child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, key: "spawn-failed", detail: String((e && e.message) || e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = out;
      if (outFile) { try { text = fs.readFileSync(outFile, "utf8"); } catch { text = ""; } }
      if (tmpCwd) { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 임시 잔재 무해 */ } }
      if (opts && opts.__tmpHome) { try { fs.rmSync(opts.__tmpHome, { recursive: true, force: true }); } catch { /* 인증 사본 잔재 — TTL temp 정리 대상 */ } }
      if (cancelled) return done({ ok: false, key: "cancelled", detail: "" });
      if (code !== 0 || !String(text || "").trim()) return done({ ok: false, key: "call-failed", detail: `exit=${code} ` + String(err || "").slice(-200) });
      done({ ok: true, output: String(text).trim() });
    });
    try { child.stdin.end(prompt); } catch { /* close 핸들러가 실패 정착 */ }
  });
  return { promise, cancel };
}

module.exports = { selectorArmForTurn, runSelectorPage, killTree, SELF_DENY };
