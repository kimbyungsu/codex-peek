/*
 * P7 — readiness probe 실행기(구현검증 2차 blocker④: 확장 핸들러에 갇혀 있으면 테스트가 실행 못 함 →
 * vscode 무관 순수 계층으로 추출. 확장은 실행 해석(inv)·어댑터 힌트·env만 주입하고 모달/알림만 담당).
 * 계약(정본 'P7 상세 설계' v4): 실행 직전 지문 캡처→실행→잠금 안 재확인 기록(guarded — 성공 레코드만 지문
 * 검사·실패 레코드는 상태 기록 자체가 목적). 비용: economy=capability(브릿지가 usage 기록)·precision=
 * codex-probe(여기서 문자수 기록)·self=무과금.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const CL = require(path.join(__dirname, "contract-lib.js"));

// self — claude --version+어댑터 지문 결속. 반환 ver=null이면 호출자는 버전 캐시를 반드시 null로 리셋
// (2차 blocker②: 실패 후 이전 캐시가 살아 있으면 view 재대조가 옛 성공을 '준비됨'으로 되살린다).
function probeSelf(opts) {
  const o = opts || {};
  const startedAt = new Date().toISOString(); // 늦은-패자 규칙 입력(4차 [주의] — 실행 전 캡처)
  const cmd = o.claudeCmd || "claude";
  const rv = spawnSync(cmd, [...(o.claudeArgs || []), "--version"], { encoding: "utf8", timeout: 20000, windowsHide: true, shell: o.shell !== undefined ? o.shell : process.platform === "win32" }); // claudeArgs=테스트 주입 프리픽스(가짜 CLI 스크립트 실행용 — 실경로는 빈 배열)
  const ver = !rv.error && rv.status === 0 ? String(rv.stdout || "").trim().slice(0, 60) : null;
  const fp = ver ? CL.selfExecFp(ver, o.adapterHint) : null;
  const okS = !!ver && fp !== null;
  const rec = { ok: okS, probedAt: new Date().toISOString(), startedAt, fp, cliVer: ver || "", detail: okS ? "" : !ver ? ((rv.error && rv.error.message) || `exit=${rv.status}`) : "adapter-missing" };
  const w = CL.writeMapReadinessGuarded("self", rec, () => CL.selfExecFp(ver, o.adapterHint));
  return { rec, write: w, ver };
}
// economy — 브릿지 capability 명령을 node로 실행(호출자가 nodeBin·env 주입 — 확장은 Electron이라
// ELECTRON_RUN_AS_NODE=1을 env에 실어야 한다: 2차 blocker③). 성공=exit 0 '그리고' stdout capability-ok
// (출력 미확인이면 엉뚱한 프로세스의 exit 0이 typed 증명으로 위조될 수 있음 — 2차 blocker③ 후단).
function probeEconomy(opts) {
  const o = opts || {};
  const fpE = CL.economyConfigFp();
  if (fpE === null) return { skipped: true, reason: "not-configured" };
  const startedAt = new Date().toISOString();
  const rc = spawnSync(o.nodeBin || process.execPath, [path.join(o.bridgeDir || __dirname, "deepseek-bridge.js"), "capability"], { encoding: "utf8", timeout: 150000, windowsHide: true, env: o.env || process.env });
  const okE = !rc.error && rc.status === 0 && /capability-ok/.test(String(rc.stdout || ""));
  const rec = { ok: okE, probedAt: new Date().toISOString(), startedAt, fp: fpE, detail: okE ? "" : String(rc.stdout || rc.stderr || ((rc.error && rc.error.message) || "")).trim().slice(-160) };
  const w = CL.writeMapReadinessGuarded("economy", rec, () => CL.economyConfigFp());
  return { rec, write: w };
}
// precision — 실제 정찰과 동일 조립(공용 빌더)·빈 임시 cwd·소형 프롬프트. 비용은 codex-probe로 문자수 기록.
function probePrecision(opts) {
  const o = opts || {};
  const inv = o.inv;
  const fpP = CL.precisionExecFp(inv);
  const startedAt = new Date().toISOString();
  const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "map-probe-"));
  const outF = path.join(tmpC, "probe-out.txt");
  let okP = false, detP = "", inLen = 0, outLen = 0;
  try {
    const probeIn = o.prompt || "아무 도구도 쓰지 말고 'ready'라고만 답하라.";
    inLen = probeIn.length;
    const rp = spawnSync(inv.file, [...(inv.args || []), ...CL.codexScoutExecArgs(outF)], { input: probeIn, cwd: tmpC, encoding: "utf8", timeout: o.timeoutMs || 120000, windowsHide: true, shell: !!inv.shell, stdio: ["pipe", "ignore", "pipe"], env: o.env || process.env });
    let outTxt = ""; try { outTxt = fs.readFileSync(outF, "utf8").trim(); } catch { /* 실패 판정 */ }
    outLen = outTxt.length;
    okP = !rp.error && rp.status === 0 && !!outTxt;
    detP = okP ? "" : ((rp.error && rp.error.message) || `exit=${rp.status}`) + " " + String(rp.stderr || "").slice(-160);
  } finally { try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch { /* 무해 */ } }
  try { CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "codex-probe", model: null, usageIn: null, usageOut: null, pkgChars: inLen, mapChars: outLen }); } catch { /* 무해 */ }
  const rec = { ok: okP, probedAt: new Date().toISOString(), startedAt, fp: fpP, detail: detP };
  const w = CL.writeMapReadinessGuarded("precision", rec, () => CL.precisionExecFp(inv));
  return { rec, write: w };
}

module.exports = { probeSelf, probeEconomy, probePrecision };
