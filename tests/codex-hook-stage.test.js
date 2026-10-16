"use strict";
/*
 * [AFTER-0.1.104-FIXES §2 설계 B] Codex 훅 경보 상태 구분 — 훅 기록이 없거나 옛 차례 것뿐일 때
 * 실패(빨강) · 확인 전(정보 한 줄 · 행동 요구 없음) · 구분 불가(지금 규칙 그대로 빨강+이유)로 나눈다.
 * 기준 시각 T=설치기가 지금 훅 항목을 훅 파일에 쓰기 직전 시각(소유 기록 writes · 옛 기록은 같은 설치의 백업 이름 시각).
 * 판정 함수 표 · 설치기(쓰기 시작 시각 순서·지문) · 기준 시각 계산 · 확장 산출물(판정 연결·경보·단계표) 실행.
 * 격리: 임시 폴더 · 실제 Codex·사용자 파일 무접촉.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");
const ROOT = path.join(__dirname, "..");
const H = require("../out/codex-hook-health.js");
const P = require("../bridge/codex-plugin-install.js");
const OUT = path.join(ROOT, "out", "extension.js");
const src = fs.readFileSync(OUT, "utf8");
const slice = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, "조각 " + a); return src.slice(i, j); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hook-stage-"));

let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);
const iso = (s) => new Date(s).toISOString();

t("판정 표 — 차례 시각=T 는 실패(경계는 실패 쪽) · T 뒤=실패 · T 앞·차례 없음=확인 전 · T 모름=install-time-unknown · 차례 시각 못 읽음=turn-time-unreadable", () => {
  const T0 = Date.parse("2026-10-15T10:00:00.000Z");
  const st = (wt, exists, ts) => H.stageCodexHookMiss({ writeTimeMs: wt, turnExists: exists, latestTurnTs: ts });
  assert.strictEqual(st(T0, true, "2026-10-15T10:00:00.000Z"), "failed", "★경계=실패");
  assert.strictEqual(st(T0, true, "2026-10-15T10:00:01.000Z"), "failed");
  assert.strictEqual(st(T0, true, "2026-10-15T09:59:59.999Z"), "pending");
  assert.strictEqual(st(T0, false, ""), "pending", "차례 아직 없음");
  assert.strictEqual(st(null, true, "2026-10-15T10:00:01.000Z"), "install-time-unknown");
  assert.strictEqual(st(NaN, false, ""), "install-time-unknown", "T 모름은 차례 유무보다 먼저(낮추지 않음)");
  assert.strictEqual(st(T0, true, ""), "turn-time-unreadable");
  assert.strictEqual(st(T0, true, "garbage"), "turn-time-unreadable");
  // [설계 검증 1회차 f-8a81f25a 반례] 10:00 설치 → 10:01 차례(훅 기록 없음) → 10:02 신뢰 조회 — 조회 시각은 입력이 아니다 → 실패
  assert.strictEqual(st(Date.parse("2026-10-15T10:00:00Z"), true, "2026-10-15T10:01:00Z"), "failed", "★늦은 신뢰 조회와 무관하게 실패");
});

// 시험용 훅 파일·소유 기록
const BR = path.join(TMP, "bridge"); fs.mkdirSync(BR, { recursive: true }); fs.writeFileSync(path.join(BR, "codex-hook.js"), "// runtime");
const MARK = path.join(BR, "codex-hooks-installed-by-extension");
const home = (tag) => { const d = path.join(TMP, "home-" + tag); fs.mkdirSync(d, { recursive: true }); return path.join(d, "hooks.json"); };
const readMark = () => JSON.parse(fs.readFileSync(MARK, "utf8"));

t("[설계 검증 2회차 f-8a81f25a 반례] 설치기 — 쓰기 시작 시각을 훅 파일·백업 공개 전에 잡고(소유 기록 writes) · installedAt 은 그 뒤 · 그 사이 차례(훅 기록 없음)=실패 · 항목 지문 기록", () => {
  const file = home("order");
  fs.writeFileSync(file, JSON.stringify({ hooks: {} }) + "\n"); // 이전 파일이 있어야 백업이 생김
  try { fs.unlinkSync(MARK); } catch {}
  const RealDate = Date, log = [];
  let tick = 0;
  const base = RealDate.parse("2026-10-15T10:00:00.000Z");
  class FakeDate extends RealDate { constructor(...a) { if (a.length) { super(...a); return; } tick++; super(base + tick * 1000); log.push("date:" + super.toISOString()); } static now() { return base + tick * 1000; } }
  const realRename = fs.renameSync;
  global.Date = FakeDate;
  fs.renameSync = function (from, to) { log.push("publish:" + path.basename(to)); return realRename.apply(fs, arguments); };
  let r;
  try { r = P.installCodexPeekOwnedUserHooks(file, BR, "node", MARK); } finally { global.Date = RealDate; fs.renameSync = realRename; }
  assert.ok(r.ok, JSON.stringify(r));
  const m = readMark();
  const w = m.writes.find((x) => path.normalize(x.file) === path.normalize(file));
  assert.ok(w && typeof w.entryFp === "string" && w.entryFp.length === 40, "항목 지문 기록 " + JSON.stringify(m));
  const iWrite = log.indexOf("date:" + w.writeStartedAt), iPub = log.indexOf("publish:hooks.json"), iInst = log.indexOf("date:" + m.installedAt);
  assert.ok(iWrite >= 0 && iPub > iWrite && iInst > iPub, "★쓰기 시작 시각 → 훅 파일 공개 → installedAt 순서 " + JSON.stringify(log));
  assert.ok(fs.existsSync(file + ".bak." + w.writeStartedAt.replace(/[:.]/g, "-")), "백업 이름도 쓰기 시작 시각");
  const wt = P.codexPeekHookWriteTime(MARK, file, BR);
  assert.ok(wt.ok && wt.how === "recorded" && wt.iso === w.writeStartedAt, JSON.stringify(wt));
  // 훅 파일 공개와 installedAt 사이의 차례(훅 기록 없음) — installedAt 을 기준으로 썼다면 '확인 전'으로 낮아졌을 차례
  const between = new Date(Date.parse(m.installedAt) - 1).toISOString();
  assert.ok(Date.parse(between) < Date.parse(m.installedAt) && Date.parse(between) >= wt.t);
  assert.strictEqual(H.stageCodexHookMiss({ writeTimeMs: wt.t, turnExists: true, latestTurnTs: between }), "failed", "★그 사이 차례=실패");
  assert.strictEqual(H.stageCodexHookMiss({ writeTimeMs: Date.parse(m.installedAt), turnExists: true, latestTurnTs: between }), "pending", "(대조) installedAt 기준이면 확인 전으로 낮아짐");
});

t("기준 시각 — 새 기록: 다른 사용자 훅이 더해져도·Codex 설정 파일이 바뀌어도 그대로 · 우리 항목이 다른 방법으로 바뀌면 믿지 않음 · 소유 기록 없음/깨짐/다른 파일/시각 깨짐=정할 수 없음 · 다시 설치하면 새 시각", () => {
  const file = home("rec");
  try { fs.unlinkSync(MARK); } catch {}
  assert.ok(P.installCodexPeekOwnedUserHooks(file, BR, "node", MARK).ok);
  const a = P.codexPeekHookWriteTime(MARK, file, BR);
  assert.ok(a.ok && a.how === "recorded", JSON.stringify(a));
  fs.writeFileSync(path.join(path.dirname(file), "config.toml"), "[hooks.state]\ntrusted_hash = \"x\"\n");
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).t, a.t, "Codex 설정 파일(신뢰 기록)이 바뀌어도 불변");
  const root = JSON.parse(fs.readFileSync(file, "utf8"));
  root.hooks.Stop.push({ hooks: [{ type: "command", command: "echo other-user-hook" }] });
  fs.writeFileSync(file, JSON.stringify(root, null, 2));
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).t, a.t, "다른 사용자 훅이 더해져도(우리 항목 그대로) 불변");
  const ours = root.hooks.Stop.find((g) => g.hooks.some((x) => P.isCodexPeekHookCommand(x.commandWindows || x.command, BR)));
  ours.hooks[0].timeout = 31;
  fs.writeFileSync(file, JSON.stringify(root, null, 2));
  assert.deepStrictEqual(P.codexPeekHookWriteTime(MARK, file, BR), { ok: false, reason: "entries-changed" }, "★우리 항목이 다른 방법으로 바뀜=믿지 않음");
  const before = Date.now(); while (Date.now() === before) { /* 1ms */ }
  assert.ok(P.installCodexPeekOwnedUserHooks(file, BR, "node", MARK).ok);
  const b = P.codexPeekHookWriteTime(MARK, file, BR);
  assert.ok(b.ok && b.t > a.t, "다시 설치=새 시각");
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, home("other"), BR).reason, "file-not-owned");
  const m = readMark(); m.writes[m.writes.length - 1].writeStartedAt = "not-a-time"; fs.writeFileSync(MARK, JSON.stringify(m));
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).reason, "time-invalid", "시각 깨짐");
  fs.writeFileSync(MARK, "{broken");
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).reason, "owner-unreadable", "소유 기록 깨짐");
  fs.unlinkSync(MARK);
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).reason, "owner-missing", "소유 기록 없음");
  // 옛 판이 읽는 칸(schema·bridgeDir·hookFiles·installedAt)은 그대로 — 새 칸은 더하기만
  assert.ok(P.installCodexPeekOwnedUserHooks(file, BR, "node", MARK).ok);
  const m2 = readMark();
  assert.ok(m2.schema === "codex-peek-user-hooks-v1" && Array.isArray(m2.hookFiles) && typeof m2.installedAt === "string" && Array.isArray(m2.writes));
  const o2 = P.readCodexPeekHookOwner(MARK, BR);
  assert.ok(o2.ok && o2.writes.length === 1, JSON.stringify(o2));
});

t("기준 시각 — 옛 기록(writes 없음): 같은 설치의 백업 이름 시각 · installedAt 이하 중 가장 늦은 것 · 백업 없음=정할 수 없음 · 항목이 빠졌으면=정할 수 없음", () => {
  const file = home("legacy"), dir = path.dirname(file);
  assert.ok(P.installCodexPeekUserHooks(file, BR, "node").ok); // 항목만 씀(처음 설치 — 백업 없음)
  for (const nm of fs.readdirSync(dir)) if (nm.startsWith("hooks.json.bak")) fs.unlinkSync(path.join(dir, nm));
  fs.writeFileSync(MARK, JSON.stringify({ schema: "codex-peek-user-hooks-v1", bridgeDir: BR, hookFiles: [file], installedAt: "2026-10-09T23:19:50.125Z" }));
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).reason, "no-backup", "★백업 없음(처음 설치)=정할 수 없음");
  for (const nm of ["hooks.json.bak.2026-08-23T07-38-44-759Z", "hooks.json.bak.2026-10-09T23-19-50-123Z", "hooks.json.bak.2026-10-10T00-00-00-000Z", "hooks.json.bak-20260714", "other.json.bak.2026-10-09T23-19-50-124Z"]) fs.writeFileSync(path.join(dir, nm), "{}");
  const r = P.codexPeekHookWriteTime(MARK, file, BR);
  assert.deepStrictEqual(r, { ok: true, t: Date.parse("2026-10-09T23:19:50.123Z"), iso: "2026-10-09T23:19:50.123Z", how: "backup" }, "★installedAt 이하 중 가장 늦은 백업(뒤 백업·다른 이름·옛 형식 무시) " + JSON.stringify(r));
  assert.strictEqual(P.parseHookBackupStamp("hooks.json.bak.2026-10-09T23-19-50-123Z", "hooks.json"), Date.parse("2026-10-09T23:19:50.123Z"));
  assert.ok(Number.isNaN(P.parseHookBackupStamp("hooks.json.bak-20260714", "hooks.json")));
  P.removeCodexPeekUserHooks(file, BR);
  assert.strictEqual(P.codexPeekHookWriteTime(MARK, file, BR).reason, "entries-incomplete", "옛 기록은 항목이 빠짐없이 있을 때만");
});

// 확장 산출물 — codexHookHealth 와 보조 함수(대역 주입)
const healthSlice = slice("function codexHookHealth(", "\nfunction verifierLinkForMode(");
function runHealth(o) {
  const outReq = createRequire(OUT);
  const req = (m) => (/codex-plugin-install\.js$/.test(m) ? { codexPeekHookWriteTime: () => o.wt } : outReq(m));
  const fn = new Function("loadContract", "codexHookTrustForWorkspace", "codex_hook_health_1", "workspaceLink", "loadLinks", "findRolloutById", "readCodexActiveRecord", "sessionTurnSignalForProject", "codexUserHooksOwnerFile", "codexUserHooksFile", "BRIDGE_DIR", "rolloutAccFor", "projectWorkspaceCandidates", "normWs", "path", "require",
    healthSlice + "\nreturn codexHookHealth;")(() => ({ harnessMode: "codex-codex" }), () => (o.trust || { queried: true, ready: true }), H, () => ({ implementerSession: "sid-1" }), () => ({}), () => o.file || path.join(TMP, "rollout-2026-07-14T04-48-10-sid-1.jsonl"),
    () => o.active || null, (file, ws) => (o.acc ? o.acc.turnByCwd.get(ws) || { turnId: "", ts: "" } : o.latest || { turnId: "", ts: "" }), () => "M", () => "F", "B", () => o.acc || ({ turnAtByCwd: o.byCwd || new Map() }), (ws) => o.cands || [ws], (x) => x, path, req);
  return fn("C:/ws");
}

t("판정 연결(확장 산출물 실행) — 기록 전무+T 뒤 차례=실패(f-3e9556e0) · 차례 없음/T 앞=확인 전 · 옛 차례 기록+T 뒤 새 차례=실패 · T 모름·차례 시각 못 읽음=지금 규칙 · 정상·번호 못 읽음·신뢰 전은 그대로", () => {
  const T0 = { ok: true, t: Date.parse("2026-10-15T10:00:00Z"), iso: "2026-10-15T10:00:00.000Z" };
  const turn = (ts) => new Map([["C:/ws", { turnId: "x", ts }]]);
  const a = runHealth({ wt: T0, byCwd: turn("2026-10-15T10:01:00Z"), latest: { turnId: "t9", ts: "2026-10-15T10:01:00Z" } });
  assert.ok(!a.ready && a.reason === "heartbeat-missing" && a.stage === "failed" && a.hookWriteAt === T0.iso && a.lastTurnAt === "2026-10-15T10:01:00Z", "★기록 전무+T 뒤 차례=실패 " + JSON.stringify(a));
  const sa = new Date(a.sessionStartedAt); assert.ok(sa.getFullYear() === 2026 && sa.getMonth() === 6 && sa.getDate() === 14 && sa.getHours() === 4 && sa.getMinutes() === 48, "연결된 대화 시작=파일 이름의 날짜·시각(이 PC 시각 7월 14일 04:48) " + a.sessionStartedAt);
  const b = runHealth({ wt: T0 });
  assert.ok(!b.ready && b.required && b.reason === "hook-pending" && b.stage === "pending", "차례 없음=확인 전 " + JSON.stringify(b));
  const c = runHealth({ wt: T0, byCwd: turn("2026-10-15T09:59:00Z"), latest: { turnId: "t1", ts: "2026-10-15T09:59:00Z" } });
  assert.strictEqual(c.reason, "hook-pending", "T 앞 차례=확인 전");
  const old = { source: "codex-hook", hookEvent: "UserPromptSubmit", turnId: "t1", ts: "2026-10-15T09:00:00Z" };
  const d = runHealth({ wt: T0, active: old, byCwd: turn("2026-10-15T10:05:00Z"), latest: { turnId: "t2", ts: "2026-10-15T10:05:00Z" } });
  assert.ok(d.reason === "heartbeat-stale" && d.stage === "failed", "★옛 차례 기록+T 뒤 새 차례=실패 " + JSON.stringify(d));
  const e = runHealth({ wt: T0, active: old, byCwd: turn("2026-10-15T09:30:00Z"), latest: { turnId: "t2", ts: "2026-10-15T09:30:00Z" } });
  assert.strictEqual(e.reason, "hook-pending", "옛 기록+T 앞 새 차례=확인 전");
  const f = runHealth({ wt: { ok: false, reason: "owner-missing" }, byCwd: turn("2026-10-15T09:30:00Z"), latest: { turnId: "t2", ts: "2026-10-15T09:30:00Z" } });
  assert.ok(f.reason === "heartbeat-missing" && f.stage === "install-time-unknown" && !f.ready, "★T 모름=지금 규칙(빨강) " + JSON.stringify(f));
  const f2 = runHealth({ wt: { ok: false, reason: "owner-missing" } });
  assert.ok(f2.reason === "heartbeat-missing" && f2.stage === "install-time-unknown", "T 모름이면 차례가 없어도 낮추지 않음");
  const g = runHealth({ wt: T0, byCwd: turn(""), latest: { turnId: "", ts: "" } });
  assert.ok(g.reason === "heartbeat-missing" && g.stage === "turn-time-unreadable", "차례 시각 못 읽음=지금 규칙 " + JSON.stringify(g));
  const h = runHealth({ wt: T0, active: { source: "codex-hook", hookEvent: "SessionStart", ts: "2026-10-15T11:00:00Z" }, byCwd: turn("2026-10-15T10:30:00Z"), latest: { turnId: "t3", ts: "2026-10-15T10:30:00Z" } });
  assert.ok(h.ready && h.reason === "healthy" && !h.stage, "대화 시작 기록이 마지막 차례보다 늦음=정상(그대로)");
  const i = runHealth({ wt: T0, active: { source: "codex-hook", hookEvent: "Stop", turnId: "t3" }, byCwd: turn("2026-10-15T10:30:00Z"), latest: { turnId: "t3", ts: "2026-10-15T10:30:00Z" } });
  assert.ok(i.ready && !i.stage, "그 차례 기록=정상");
  const j = runHealth({ wt: T0, active: { source: "codex-hook", hookEvent: "UserPromptSubmit", turnId: "t3" }, byCwd: turn("2026-10-15T09:00:00Z"), latest: { turnId: "", ts: "" } });
  assert.ok(j.reason === "turn-unverifiable" && !j.stage, "차례 번호 못 읽음=손대지 않음");
  const RS = require("../out/rollout-scan.js");
  const mk = RS.makeRolloutAcc(() => false, (x) => String(x || ""));
  const acc = mk.init();
  mk.merge(acc, JSON.stringify({ timestamp: "2026-10-15T09:00:00.000Z", type: "turn_context", payload: { cwd: "C:/ws", turn_id: "old", model: "m" } }));
  mk.merge(acc, JSON.stringify({ type: "turn_context", payload: { cwd: "C:/ws", turn_id: "new", model: "m" } }));
  assert.strictEqual(acc.byCwd.get("C:/ws").ts, "2026-10-15T09:00:00.000Z", "(전제) 종전 기록은 앞 차례 시각을 승계");
  assert.deepStrictEqual(acc.turnAtByCwd.get("C:/ws"), { turnId: "new", ts: "" }, "새 기록은 이 차례 시각 그대로(없으면 빈 값)");
  const v1 = runHealth({ wt: T0, acc });
  assert.ok(v1.reason === "heartbeat-missing" && v1.stage === "turn-time-unreadable" && !v1.ready, "★[구현 검증 B 1회차 blocker 반례] 시각 없는 새 차례=판독 불가(빨강) — 확인 전으로 낮추지 않음 " + JSON.stringify(v1));
  // 프로젝트 후보가 둘(프로젝트·매핑 저장소)이고 그중 하나의 마지막 차례 시각을 못 읽으면 판독 불가
  const two = new Map([["C:/ws", { turnId: "a", ts: "2026-10-15T09:00:00.000Z" }], ["C:/repo", { turnId: "b", ts: "" }]]);
  const v2 = runHealth({ wt: T0, byCwd: two, cands: ["C:/ws", "C:/repo"] });
  assert.strictEqual(v2.stage, "turn-time-unreadable", "후보 하나라도 판독 불가=판독 불가");
  const three = new Map([["C:/ws", { turnId: "a", ts: "2026-10-15T09:00:00.000Z" }], ["C:/repo", { turnId: "b", ts: "2026-10-15T10:30:00.000Z" }]]);
  const v3 = runHealth({ wt: T0, byCwd: three, cands: ["C:/ws", "C:/repo"] });
  assert.ok(v3.stage === "failed" && v3.lastTurnAt === "2026-10-15T10:30:00.000Z", "후보 중 가장 늦은 차례 " + JSON.stringify(v3));
  const k = runHealth({ wt: T0, trust: { queried: true, ready: false } });
  assert.strictEqual(k.reason, "hooks-untrusted", "신뢰 판정은 그대로");
});

// 경보 — 기존 시험과 같은 방식(확장 산출물의 syncCodexHookHealth 실행)
const syncBody = slice("function syncCodexHookHealth(", "\n// 대시보드 프로젝트와 실제 작업 저장소가 다를 수 있다");
const chk = slice("function codexHookTrustChecking(", "\nfunction codexHookHealth(");
const hookText = slice("function codexHookAt(", "\nfunction verifierLinkForMode(");
const pendingLine = new Function(hookText + "\nreturn codexHookPendingLine;")();
function runSync(health, existing) {
  const cache = new H.CodexHookTrustCache();
  let written = null;
  const fn = new Function("codexHomeIsReady", "withIntegrityLockExt", "readIntegrity", "normWs", "codexHookHealth", "tE", "codexHookEventsKo", "CODEX_PEEK_HOOK_NAME_LIST", "atomicWrite", "INTEGRITY_FILE", "codexHookTrustForWorkspace", "codexHookTrustCache", "codexHookTrustCwd",
    chk + "\n" + hookText + "\n" + syncBody + "\nreturn syncCodexHookHealth;")(true, (f) => f(), () => (existing || []).slice(), (x) => x, () => health, (ko) => ko, () => "", "", (f, data) => { written = JSON.parse(data); }, "INTEG", () => ({ queried: true, ready: true }), cache, (x) => x);
  fn("C:/ws");
  return written ? written.events.filter((e) => e.kind === "codex-hook-missing") : (existing || []).filter((e) => e.kind === "codex-hook-missing");
}

t("경보 — 확인 전=경보 줄 없음(있던 빨강도 지움 · 한 줄은 온보딩 4단계에) · 실패=빨강+마지막 차례·설치 시각+흔한 원인 · 구분 불가=빨강+이유 · 표지에 갈래 · 문구(시각)가 바뀌면 새 줄", () => {
  const base = { required: true, ready: false, latestTurnId: "", heartbeatTurnId: "", hookWriteAt: "2026-10-15T01:00:00.000Z", sessionStartedAt: "2026-07-14T04:48:10.000Z" };
  // 기대 문구도 이 PC 시각으로 계산(시간대가 다른 PC·CI 에서도 같은 규칙)
  const pad = (x) => String(x).padStart(2, "0");
  const dayKo = (x) => { const d = new Date(x); return (d.getMonth() + 1) + "월 " + d.getDate() + "일"; };
  const atKo = (x) => { const d = new Date(x); return dayKo(x) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const pendH = Object.assign({}, base, { reason: "hook-pending", stage: "pending", lastTurnAt: "" });
  assert.strictEqual(runSync(pendH).length, 0, "★확인 전=경보 줄 없음");
  const line = pendingLine(pendH);
  assert.ok(line.ko.includes("훅 설치(" + atKo(base.hookWriteAt) + ") 뒤 아직 Codex 구현 차례가 없습니다(연결된 대화: " + dayKo(base.sessionStartedAt) + " 시작)") && /자동으로 확인합니다/.test(line.ko) && /started/.test(line.en), line.ko);
  assert.ok(!/프롬프트를 보내|다시 열거나|하세요/.test(line.ko), "★확인 전 한 줄은 사용자 행동을 요구하지 않음");
  const f = runSync(Object.assign({}, base, { reason: "heartbeat-missing", stage: "failed", lastTurnAt: "2026-10-15T02:00:00.000Z" }));
  assert.ok(f.length === 1 && f[0].severity === "error" && f[0].sig === "codex-hook:heartbeat-missing:failed", JSON.stringify(f));
  assert.ok(f[0].detailKo.includes("마지막 차례(" + atKo("2026-10-15T02:00:00.000Z") + ")가 훅 설치(" + atKo(base.hookWriteAt) + ") 뒤인데 그 차례에 훅 실행 기록이 없습니다") && /① 훅을 신뢰하기 전에 진행된 차례 ② 설치·신뢰 뒤 창을 다시 불러오기 전/.test(f[0].detailKo) && f[0].detailKo.includes("(" + dayKo(base.sessionStartedAt) + " 시작)"), f[0].detailKo);
  const fs2 = runSync(Object.assign({}, base, { reason: "heartbeat-stale", stage: "failed", lastTurnAt: "2026-10-15T02:00:00.000Z" }));
  assert.ok(/이전 차례 기록만 있음/.test(fs2[0].detailKo) && fs2[0].severity === "error");
  const u = runSync(Object.assign({}, base, { reason: "heartbeat-missing", stage: "install-time-unknown", hookWriteAt: "", lastTurnAt: "2026-10-15T02:00:00.000Z" }));
  assert.ok(u[0].severity === "error" && /실제 lifecycle 훅 실행 기록이 없습니다/.test(u[0].detailKo) && /훅 설치 시각을 확인할 수 없어 아직 안 쓴 상태인지 구분하지 못합니다 — 훅 설치\(갱신\)를 다시 하면 구분됩니다/.test(u[0].detailKo), "★구분 불가=지금 문구+이유(빨강) " + u[0].detailKo);
  const us = runSync(Object.assign({}, base, { reason: "heartbeat-stale", stage: "turn-time-unreadable", lastTurnAt: "" }));
  assert.ok(us[0].severity === "error" && /최신 턴에서 lifecycle 훅 실행이 확인되지 않았습니다/.test(us[0].detailKo) && /마지막 차례 시각을 읽지 못해/.test(us[0].detailKo));
  // 단계가 없던 종전 판정(예: 덮어쓰기 없이 들어온 heartbeat-missing)=종전 문구 그대로
  const legacy = runSync({ required: true, ready: false, reason: "heartbeat-missing", latestTurnId: "", heartbeatTurnId: "" });
  assert.ok(legacy[0].sig === "codex-hook:heartbeat-missing" && /실제 lifecycle 훅 실행 기록이 없습니다/.test(legacy[0].detailKo) && !/구분하지 못합니다/.test(legacy[0].detailKo));
  // 문구(시각)가 바뀌면 새 줄 · 같으면 그대로(다시 쓰지 않음)
  const f3 = runSync(Object.assign({}, base, { reason: "heartbeat-missing", stage: "failed", lastTurnAt: "2026-10-15T03:00:00.000Z" }), f);
  assert.ok(f3.length === 1 && f3[0].id !== f[0].id && f3[0].detailKo !== f[0].detailKo, "시각이 바뀌면 새 줄");
  const same = runSync(Object.assign({}, base, { reason: "heartbeat-missing", stage: "failed", lastTurnAt: "2026-10-15T02:00:00.000Z" }), f);
  assert.ok(same.length === 1 && same[0].id === f[0].id, "같으면 그대로");
  // 빨강(실패·구분 불가) 뒤 다시 설치해 확인 전이 되면 빨강이 지워짐 · 정상이면 사라짐
  assert.strictEqual(runSync(pendH, f).length, 0, "★빨강 → 확인 전=지워짐");
  assert.strictEqual(runSync(pendH, u).length, 0);
  assert.strictEqual(runSync({ required: true, ready: true, reason: "healthy", latestTurnId: "t", heartbeatTurnId: "t" }, f).length, 0);
});

const mkEl = (tag) => ({ tag, children: [], style: {}, attrs: {}, textContent: "", className: "", innerHTML: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; } });
t("대시보드 단계표 4단계 — 확인 전이면 '설치됨 — 확인 전 · <설치 시각·연결된 대화 날짜 한 줄>'(판정→상태→화면 연결) · 완료로 승인하지 않음 · 설치 버튼·설치 안내 없음 · 미확인은 종전 그대로", () => {
  const i = src.indexOf('    safe(function(){\n      const ob=$("onboard");');
  const j = src.indexOf("\n    // 기본지침도 언어 전환 hold", i);
  assert.ok(i > 0 && j > i, "단계표 조각");
  const run = (reason, note) => {
    const els = {};
    const $ = (id) => (els[id] = els[id] || mkEl("div"));
    const d = { contract: { harnessMode: "codex-codex", codexVerifyMode: "always" }, codexReady: true, linkedId: "v", implementerId: "i", codexHookReady: false, codexHookReason: reason, codexHookChecking: false, onboardDismissed: true, codexHookNote: note || null };
    new Function("document", "$", "T", "d", "safe", src.slice(i, j))({ createElement: mkEl }, $, (ko) => ko, d, (f) => f());
    return { ob4: els.ob4, title: els.obTitle ? els.obTitle.textContent : "" };
  };
  // 판정(확장 산출물)이 만든 상태 → 상태 푸시의 한 줄 함수 → 단계표: 설치 시각·연결된 대화 날짜가 실제로 보임
  const hP = runHealth({ wt: { ok: true, t: Date.parse("2026-10-15T01:00:00.000Z"), iso: "2026-10-15T01:00:00.000Z" } });
  assert.strictEqual(hP.reason, "hook-pending");
  const ln = pendingLine(hP);
  const p = run("hook-pending", ln);
  const d0 = new Date("2026-10-15T01:00:00.000Z"), s0 = new Date(hP.sessionStartedAt);
  const wantW = (d0.getMonth() + 1) + "월 " + d0.getDate() + "일 " + String(d0.getHours()).padStart(2, "0") + ":" + String(d0.getMinutes()).padStart(2, "0"), wantS = (s0.getMonth() + 1) + "월 " + s0.getDate() + "일 시작";
  assert.ok(/Codex 강제 훅 설치됨 — 확인 전 · /.test(p.ob4.innerHTML) && p.ob4.innerHTML.includes(wantW) && p.ob4.innerHTML.includes(wantS) && /todo/.test(p.ob4.className), "★확인 전 한 줄(설치 시각·연결된 대화 날짜)이 단계표에 보임·미완료 " + p.ob4.innerHTML);
  const p0 = run("hook-pending");
  assert.ok(/설치 뒤 아직 Codex 구현 차례 없음/.test(p0.ob4.innerHTML), "한 줄이 없을 때의 기본 문구");
  assert.ok(!/data-cmd="installCodexHooks"/.test(p.ob4.innerHTML) && !/Codex 훅 설치·훅 전부 신뢰/.test(p.ob4.innerHTML), "★설치 버튼·설치 안내 없음");
  assert.ok(!/준비 끝/.test(p.title), "완료로 승인하지 않음");
  const m = run("heartbeat-missing");
  assert.ok(/Codex 강제 훅 미확인/.test(m.ob4.innerHTML) && /data-cmd="installCodexHooks"/.test(m.ob4.innerHTML), "미확인=종전(버튼 있음)");
});

t("배선 — 확장의 기준 시각은 Codex 훅 파일·소유 기록·브릿지 폴더로 설치기 함수를 부름 · 배포 목록에 설치기 포함(옛 사본 아님)", () => {
  const ts = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  assert.ok(ts.includes(".codexPeekHookWriteTime(codexUserHooksOwnerFile(), codexUserHooksFile(), BRIDGE_DIR)"), "기준 시각 호출");
  assert.ok(ts.includes('codexHookNote: hookHealth.reason === "hook-pending" ? codexHookPendingLine(hookHealth) : null,'), "상태 푸시에 확인 전 한 줄");
  assert.ok(ts.includes('health.reason !== "implementer-missing" && health.reason !== "hook-pending";'), "확인 전=경보 아님");
  assert.ok(ts.includes("const v = acc.turnAtByCwd.get(normWs(candidate));") && !/acc\.byCwd\.get\(normWs\(candidate\)\)/.test(ts.slice(ts.indexOf("function sessionAnyTurnForProject("), ts.indexOf("function codexHookAt("))), "마지막 차례 시각=승계 없는 기록");
  assert.ok(fs.readFileSync(path.join(ROOT, "install.js"), "utf8").includes('"codex-plugin-install.js"'), "설치기 배포");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 임시 잔재 무해 */ }
})().catch((e) => { console.error(e); process.exit(1); });
