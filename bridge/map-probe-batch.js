#!/usr/bin/env node
/*
 * 자동 재점검 배치 실행기(3차 blocker② ab-6): probe는 spawnSync 기반이라 확장 호스트에서 직접 돌리면
 * self 20s·economy 150s·precision 120s 동안 UI 전체가 멈춘다 — 자동 경로(maybeAutoReprobe)는 이 파일을
 * 비동기 자식으로 띄워 호스트 무정지. 수동 경로(모달 승인)는 기존 확장 내 실행 유지(사용자가 명시한 대기).
 * stdin: JSON {targets:[self|economy|precision...], adapterHint, inv, prompt, (테스트 주입) claudeCmd/claudeArgs/shell/bridgeDir}
 * stdout: JSON {self:{ok,detail,write,ver}, economy:{ok|skipped,...}, precision:{...}} — 표시는 호출자(확장)가 언어 슬롯으로.
 * 기록(writeMapReadinessGuarded)은 map-probe 내부에서 담당별로 즉시 일어나므로, 이 프로세스가 도중에
 * 죽어도 이미 끝난 담당의 기록은 정직하게 남는다(완료 표식은 호출자가 정상 종료 때만 찍음).
 */
const path = require("path");
const MP = require(path.join(__dirname, "map-probe.js"));

let buf = "";
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("end", () => {
  let p = null;
  try { p = JSON.parse(buf); } catch { process.stderr.write("bad-payload"); process.exit(2); }
  const t = new Set(Array.isArray(p && p.targets) ? p.targets : []);
  const out = {};
  // self — 무과금. ver는 호출자가 버전 캐시에 반영(실패=null 리셋 계약 — probeSelf 주석 참조).
  if (t.has("self")) {
    try {
      const r = MP.probeSelf({ adapterHint: p.adapterHint, claudeCmd: p.claudeCmd, claudeArgs: p.claudeArgs, shell: p.shell });
      out.self = { ok: r.rec.ok, detail: r.rec.detail, write: r.write, ver: r.ver };
    } catch (e) { out.self = { ok: false, err: String(e && e.message) }; }
  }
  // economy — 이 프로세스는 이미 node(ELECTRON_RUN_AS_NODE 상속)라 execPath 전달로 충분.
  if (t.has("economy")) {
    try {
      const r = MP.probeEconomy({ nodeBin: process.execPath, bridgeDir: p.bridgeDir || __dirname, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      out.economy = r.skipped ? { skipped: true } : { ok: r.rec.ok, detail: r.rec.detail, write: r.write };
    } catch (e) { out.economy = { ok: false, err: String(e && e.message) }; }
  }
  // precision — 실행 해석(inv)은 호출자(확장)가 주입(수동 경로와 동일 조립).
  if (t.has("precision")) {
    try {
      const r = MP.probePrecision({ inv: p.inv, prompt: p.prompt, env: p.inv && p.inv.electronNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env });
      out.precision = { ok: r.rec.ok, detail: r.rec.detail, write: r.write };
    } catch (e) { out.precision = { ok: false, err: String(e && e.message) }; }
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
