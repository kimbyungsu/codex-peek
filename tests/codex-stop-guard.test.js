"use strict";
/*
 * [2026-10-09 실사고 — 사용량 보호] Codex 종료 훅의 '종료 막기' 공통 안전장치 시험.
 * 종료를 막으면 모델이 한 번 더 응답한다(매번 대화 전체를 다시 읽는 비용) — 실사고에서 상한 없는 중단 안내가 같은 차례에 126회 반복돼
 * 주간 사용량이 급감했다. 관문마다가 아니라 막기 출구 하나에서:
 *  ① 같은 차례·그 사이 작업 없음·같은 사유=연속 3회까지만 막고 4회째부터 막지 않음(미완 경보 1건 · 검증 통과 아님)
 *  ② 그 사이 작업(사후 훅의 마지막 도구 사용 시각 변화)이 있으면 반복으로 세지 않음 — 정상 작업 흐름은 그대로 막힘
 *  ③ 새 차례=다시 셈 · ④ 차례당 막기 총수 상한(사유가 매번 달라도) · ⑤ 전처리 예외 경로도 같은 안전장치
 *  ⑥ 상한 없던 실제 경로(역할 판독 불가)를 실제 종료 훅 실행으로 재현
 * 격리: 임시 CODEX_BRIDGE_HOME · 임시 CODEX_HOME.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stop-guard-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stop-guard-codexhome-"));
fs.mkdirSync(path.join(CODEX_HOME, "sessions"), { recursive: true });
process.env.CODEX_HOME = CODEX_HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const CH = require("../bridge/codex-hook.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stop-guard-ws-"));
const sid = "ffffffff-0000-1111-2222-" + String(Date.now()).slice(-12).padStart(12, "0");
fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, harnessMode: "codex-codex", codexVerifyMode: "off" }));
const turnDir = path.join(HOME, "codex-turns"); fs.mkdirSync(turnDir, { recursive: true });
const setTurn = (turnId, lastActionAt) => fs.writeFileSync(path.join(turnDir, sid + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId, workspace: ws, startedAt: Date.now() - 1000, lastActionAt: lastActionAt || 0, modified: !!lastActionAt, permissionMode: "default" }));
const run = (payload) => cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-hook.js")], { input: JSON.stringify(payload), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CODEX_HOME }), windowsHide: true });
const stop = (turnId) => run({ hook_event_name: "Stop", session_id: sid, turn_id: turnId, cwd: ws, permission_mode: "default" });
const blocked = (r) => r.status === 0 && r.stdout.includes('"decision":"block"');
const capEvents = () => CL.readIntegrityEvents().filter((e) => e.kind === "stop-block-loop-cap" && e.session === sid);

// 상한 없던 실제 경로 재현: links.json 손상=역할 판독 불가 → 종전엔 매 종료를 막음
fs.writeFileSync(path.join(HOME, "links.json"), "{ 손상된 links");

t("★실사고 모양 — 같은 차례·작업 없음·같은 사유: 연속 3회만 막고 4회째부터 막지 않음 · 미완 경보 정확히 1건(검증 통과 아님)", () => {
  setTurn("turn-1", 0);
  for (let i = 1; i <= 3; i++) { const r = stop("turn-1"); assert.ok(blocked(r) && r.stdout.includes("역할 상태"), `${i}회째=막음 ` + r.stdout.slice(0, 160) + r.stderr.slice(0, 200)); }
  const r4 = stop("turn-1");
  assert.ok(r4.status === 0 && !r4.stdout.includes('"decision":"block"'), "4회째=막지 않음 " + r4.stdout.slice(0, 160));
  const r5 = stop("turn-1");
  assert.ok(!r5.stdout.includes('"decision":"block"'), "5회째도 막지 않음");
  const ev = capEvents();
  assert.strictEqual(ev.length, 1, "경보는 차례당 1건 " + JSON.stringify(ev.map((e) => e.detailKo)));
  assert.ok(ev[0].severity === "error" && /미완/.test(ev[0].detailKo) && /검증 통과 아님/.test(ev[0].detailKo) && /역할 상태/.test(ev[0].detailKo), ev[0].detailKo);
});

t("그 사이 작업이 있으면 반복으로 세지 않음 — 작업 4번 사이사이 종료는 모두 막힘 · 작업이 멈춘 뒤 연속 3회까지만", () => {
  let act = Date.now();
  setTurn("turn-2", 0);
  for (let i = 1; i <= 4; i++) { const r = stop("turn-2"); assert.ok(blocked(r), `작업 사이 ${i}회째=막음`); act += 1000; setTurn("turn-2", act); }
  for (let i = 1; i <= 3; i++) assert.ok(blocked(stop("turn-2")), `작업 멈춘 뒤 ${i}회째=막음`);
  assert.ok(!stop("turn-2").stdout.includes('"decision":"block"'), "작업 멈춘 뒤 4회째=막지 않음");
});

t("새 차례=다시 셈(앞 차례 상한이 새 차례로 번지지 않음)", () => {
  setTurn("turn-3", 0);
  assert.ok(blocked(stop("turn-3")), "새 차례 첫 종료=막음");
});

t("차례당 막기 총수 상한 — 사유가 매번 달라도 MAX_STOP_BLOCKS_PER_TURN 을 넘으면 막지 않음", () => {
  const g = { sid: sid + "-direct", ws, turnKey: "tk-total" };
  let allowed = 0;
  for (let i = 0; i < CH.MAX_STOP_BLOCKS_PER_TURN; i++) if (CH.stopGuardAllows(g, "사유-" + i)) allowed++;
  assert.strictEqual(allowed, CH.MAX_STOP_BLOCKS_PER_TURN, "상한까지는 모두 막음");
  assert.strictEqual(CH.stopGuardAllows(g, "사유-끝"), false, "상한 초과=막지 않음");
  assert.ok(CH.MAX_IDLE_STOP_REPEATS === 2 && CH.MAX_STOP_BLOCKS_PER_TURN === 40);
});

t("최외곽 처리부 경로(실제 훅 실행 — 비문자열 작업 폴더로 전처리 예외)도 같은 안전장치 — 같은 차례 연속 3회만 막음 · 경보 프로젝트 값은 문자열만", () => {
  const bad = { hook_event_name: "Stop", session_id: sid + "-int", turn_id: "turn-int", cwd: 123, permission_mode: "default" }; // 비문자열 작업 폴더 → 전처리 예외(최외곽 처리부 — 실측)
  for (let i = 1; i <= 3; i++) { const r = run(bad); assert.ok(blocked(r) && /internal-error/.test(r.stdout) && /Stop pre-dispatch error/.test(r.stderr), `${i}회째=막음(최외곽 처리부) ` + r.stdout.slice(0, 160) + r.stderr.slice(0, 160)); }
  assert.ok(!run(bad).stdout.includes('"decision":"block"'), "4회째=막지 않음");
  const ev = CL.readIntegrityEvents().filter((e) => e.kind === "stop-block-loop-cap" && e.session === sid + "-int");
  assert.ok(ev.length === 1 && ev[0].workspace === "", "비문자열 작업 폴더=경보 프로젝트 값 비움 " + JSON.stringify(ev.map((e) => e.workspace)));
});

t("최외곽 처리부(전처리 미지 예외) 판단 — Stop 만 internal-error · 같은 차례 연속 3회 뒤 null(막지 않음) · 다른 이벤트·깨진 입력=null", () => {
  const p = JSON.stringify({ hook_event_name: "Stop", session_id: sid + "-pre", turn_id: "turn-pre", cwd: ws });
  const err = new Error("시험용 전처리 예외");
  const se = process.stderr.write; process.stderr.write = () => true; // 진단 출력 숨김
  try {
    for (let i = 1; i <= 3; i++) assert.ok(/internal-error/.test(String(CH.preDispatchStopBlock(p, err))), `${i}회째=막기 사유`);
    assert.strictEqual(CH.preDispatchStopBlock(p, err), null, "4회째=막지 않음");
    assert.ok(/internal-error/.test(String(CH.preDispatchStopBlock(JSON.stringify({ hook_event_name: "Stop", session_id: sid + "-pre", turn_id: "turn-pre-2", cwd: ws }), err))), "새 차례=다시 막음");
    assert.strictEqual(CH.preDispatchStopBlock(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sid }), err), null, "다른 이벤트=null");
    assert.strictEqual(CH.preDispatchStopBlock("{ 깨진", err), null, "깨진 입력=null(이벤트 미상)");
  } finally { process.stderr.write = se; }
});

// ── [검증 1회차 blocker 2건] 기록 실패는 막기 유지 · 경보는 차례 결속 식별자로 한 번만(실패·중단 뒤 재시도) ──
// 같은 프로세스 안에서 특정 경로 쓰기만 실패시킨다(저장 함수는 실패하면 예외 대신 false 를 돌려준다 — 그 경로를 그대로 탄다).
const realWrite = fs.writeFileSync;
let failPrefix = null, failNth = 0, failSeen = 0; // failNth>0 이면 경로가 맞는 N번째 쓰기만 실패
fs.writeFileSync = function (file, ...rest) { if (failPrefix && String(file).startsWith(failPrefix)) { failSeen++; if (!failNth || failSeen === failNth) { const e = new Error("시험 주입 쓰기 실패"); e.code = "EIO"; throw e; } } return realWrite.call(fs, file, ...rest); };
const quiet = (fn) => { const se = process.stderr.write; process.stderr.write = () => true; try { return fn(); } finally { process.stderr.write = se; } };
const alarmsFor = (s) => CL.readIntegrityEvents().filter((e) => e.kind === "stop-block-loop-cap" && e.session === s);
const GUARD_DIR = CH.STOP_GUARD_DIR;
const INTEG = path.join(HOME, "integrity.json");

t("★횟수 저장 실패=막기 유지(상한이어도) · 경보 없음 — 저장이 회복되면 그때 상한·경보 1건", () => {
  const g = { sid: sid + "-savefail", ws, turnKey: "tk-sf" };
  for (let i = 1; i <= 3; i++) assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), true, `${i}회째=막음`);
  failPrefix = path.join(GUARD_DIR, ""); // 횟수 기록 경로만 실패
  try {
    assert.strictEqual(quiet(() => CH.stopGuardAllows(g, "같은 사유")), true, "4회째·저장 실패=막기 유지");
    assert.strictEqual(quiet(() => CH.stopGuardAllows(g, "같은 사유")), true, "5회째·저장 실패=막기 유지");
  } finally { failPrefix = null; }
  assert.strictEqual(alarmsFor(g.sid).length, 0, "저장 실패 동안 경보 없음");
  assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), false, "저장 회복=상한(막지 않음)");
  assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), false);
  assert.strictEqual(alarmsFor(g.sid).length, 1, "경보 정확히 1건");
});

t("★경보 기록 실패=막기 유지(다음 종료가 같은 식별자로 재시도) · 회복 뒤 경보 정확히 1건 · 그 뒤 중복 없음", () => {
  const g = { sid: sid + "-alarmfail", ws, turnKey: "tk-af" };
  for (let i = 1; i <= 3; i++) assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), true);
  failPrefix = INTEG; // 경보 장부 쓰기만 실패
  try {
    assert.strictEqual(quiet(() => CH.stopGuardAllows(g, "같은 사유")), true, "상한인데 경보 실패=막기 유지");
    assert.strictEqual(quiet(() => CH.stopGuardAllows(g, "같은 사유")), true, "재시도도 실패=막기 유지");
  } finally { failPrefix = null; }
  assert.strictEqual(alarmsFor(g.sid).length, 0);
  assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), false, "경보 회복=막지 않음");
  assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), false);
  assert.strictEqual(alarmsFor(g.sid).length, 1, "경보 정확히 1건(재시도 중복 없음)");
});

t("★경보를 남긴 뒤 차례 기록(alerted) 저장만 실패 + 경보 장부가 다른 경보 50건으로 밀려남 → 같은 차례 다음 종료에서 다시 기록하지 않음(보낸 경보 표식)", () => {
  const s1 = sid + "-trunc";
  const g = { sid: s1, ws, turnKey: "tk-tr" };
  for (let i = 1; i <= 3; i++) assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), true);
  failPrefix = path.join(GUARD_DIR, s1 + ".json"); failNth = 2; failSeen = 0; // 이 호출의 첫 쓰기(횟수)는 성공 · 두 번째(경보 뒤 alerted 표식)만 실패
  try { assert.strictEqual(quiet(() => CH.stopGuardAllows(g, "같은 사유")), false, "경보 남김=막지 않음"); } finally { failPrefix = null; failNth = 0; }
  assert.strictEqual(alarmsFor(s1).length, 1, "경보 1건");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(GUARD_DIR, s1 + ".json"), "utf8")).alerted, false, "(전제) 표식 저장 실패로 alerted=false 남음");
  for (let i = 0; i < 50; i++) CL.appendIntegrityEvent({ ts: new Date().toISOString(), session: "other-" + i, workspace: ws, kind: "test-filler", severity: "info", detail: "x" });
  assert.strictEqual(alarmsFor(s1).length, 0, "(전제) 장부 절삭으로 원래 경보가 밀려남");
  assert.ok(fs.existsSync(CH.stopAlarmSentFile(CH.stopCapAlarmId(s1, { turnKey: "tk-tr", firstAt: JSON.parse(fs.readFileSync(path.join(GUARD_DIR, s1 + ".json"), "utf8")).firstAt }))), "보낸 경보 표식 있음");
  assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), false, "같은 차례 다음 종료=막지 않음");
  assert.strictEqual(alarmsFor(s1).length, 0, "★같은 식별자 경보를 다시 기록하지 않음");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(GUARD_DIR, s1 + ".json"), "utf8")).alerted, true, "표식 복구");
});

t("★경보 실패로 막기를 유지한 뒤 그 차례가 정상으로 끝나면 — 상한은 확정되지 않았으므로 다음 차례에 거짓 '미완' 경보가 생기지 않음 · 경보 없이 종료가 풀리는 상태 없음", () => {
  const s2 = sid + "-noghost";
  const g = { sid: s2, ws, turnKey: "tk-a" };
  for (let i = 1; i <= 3; i++) assert.strictEqual(CH.stopGuardAllows(g, "같은 사유"), true);
  failPrefix = INTEG;
  try { assert.strictEqual(quiet(() => CH.stopGuardAllows(g, "같은 사유")), true, "경보 실패=막기 유지"); } finally { failPrefix = null; }
  const rec = JSON.parse(fs.readFileSync(path.join(GUARD_DIR, s2 + ".json"), "utf8"));
  assert.ok(rec.capped === false && rec.alerted === false, "상한 미확정 " + JSON.stringify(rec));
  // 그 뒤 구현 담당이 일해 이 차례가 정상으로 끝났다고 치고(안전장치 미호출) 다음 차례로
  assert.strictEqual(CH.stopGuardAllows({ sid: s2, ws, turnKey: "tk-b" }, "새 사유"), true, "다음 차례 첫 종료=막음");
  assert.strictEqual(alarmsFor(s2).length, 0, "★앞 차례에 대한 거짓 미완 경보 없음");
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  assert.ok(!/pendingAlarms/.test(src), "앞 차례 경보 되살림 장치 없음(필요 없는 구조)");
  assert.ok(/if \(!stopCapAlarm\(g\.sid, \{[^\n]*\}\)\) return true;[^\n]*\n\s*o\.capped = true; o\.alerted = true;/.test(src), "상한 확정은 경보가 남은 뒤에만(동시 확정)");
});
void INTEG;

t("배선 — 안전장치는 종료 처리 중에만 켜짐(작업 전 관문·프롬프트 막기는 무관) · 막기 출구 하나를 거침", () => {
  const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  assert.ok(/if\(ev==="Stop"\) stopGuardCtx=\{ sid, ws:typeof ws==="string"\?ws:"", turnKey:String\(j\.turn_id\|\|""\) \};/.test(src), "Stop 에서만 설정");
  assert.strictEqual((src.match(/stopGuardCtx\s*=/g) || []).length, 2, "선언 1 + Stop 설정 1 외 다른 설정 없음");
  assert.ok(/function block\(reason\) \{\n  if \(stopGuardCtx\)/.test(src), "막기 출구가 안전장치를 거침");
  assert.strictEqual((src.match(/jsonOut\(\{ ?decision: ?"block"/g) || []).length, 2, "막기 직접 출력은 block() 안과 최외곽 처리부(안전장치 경유) 두 곳뿐");
});

console.log(`\n결과: ${n}/${n} 통과`);
