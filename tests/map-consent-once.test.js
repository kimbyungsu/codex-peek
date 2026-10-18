"use strict";
/*
 * [2026-10-19 사용자 실보고 · D-2026-10-19-map-consent-once] 3트랙을 켤 때마다 '지도 폴더(project-map/)가 만들어집니다' 동의 창이 다시 떴다.
 * 이 저장소에 영속 동의 기록(map-bootstrap consent-<repoKey>.json)이 있으면 묻지 않고, 없을 때(첫 동의·다른 저장소·판독 불가)만 묻는다.
 * 구현 검증 1판 blocker(결속): 동의 기록은 '이번 흐름에서 사용자가 창으로 동의한 저장소'에만 남긴다 — 다른 저장소의 옛 동의로 창을 건너뛴 뒤
 * 동의한 적 없는 저장소에 기록이 생기면 안 된다(언어 칸 어긋남·저장 중 대상 변경 반례).
 * 확장 산출물(out/extension.js)의 실제 함수·저장 처리 조각을 실제 브릿지 모듈(격리 홈) 위에서 실행한다.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "consent-once-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const MB = require("../bridge/map-bootstrap.js");
const OUT = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, "조각 " + a.slice(0, 50)); return s.slice(i, j); };
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);
const BRIDGE_DIR = "/fake-bridge";
const tE = (ko) => ko;

// ── 실물 함수 3개 ──
const targetSrc = between(OUT, "function mapConsentTargetExt(", "\nasync function askMapConsentExt(");
const askSrc = between(OUT, "async function askMapConsentExt(", "\nfunction trySpawnMapBootstrap(");
const spawnSrc = between(OUT, "function trySpawnMapBootstrap(", "\n// [구현검증 7차 지적 2");
function targetFn(over) {
  const o = over || {};
  const req = (p) => { if (o.requireThrows) throw new Error("no module"); if (p === path.join(BRIDGE_DIR, "map-bootstrap.js")) return o.mb || MB; return require(p); };
  return new Function("require", "path", "BRIDGE_DIR", "bridgeLib", "loadContract", targetSrc + "\nreturn mapConsentTargetExt;")(req, path, BRIDGE_DIR, () => (o.cl === undefined ? CL : o.cl), (ws, lang) => CL.loadContract(ws, lang));
}
function askFn(pick) {
  const seen = [];
  const vscode = { window: { showWarningMessage: (msg, opt, ...btns) => { seen.push({ msg: String(msg), modal: !!(opt && opt.modal), btns }); return Promise.resolve(typeof pick === "function" ? pick(btns) : pick); } } };
  const f = new Function("vscode", "tE", askSrc + "\nreturn askMapConsentExt;")(vscode, tE);
  return { f, seen };
}
function spawnFn() {
  const log = { granted: [], spawned: 0, warned: [] };
  const mbw = { parentSignals: (ws) => MB.parentSignals(ws), grantConsent: (r, from) => { log.granted.push(r); return MB.grantConsent(r, from); }, maybeSpawnBootstrap: () => { log.spawned++; return { spawned: false }; } };
  const vscode = { window: { showWarningMessage: (m) => { log.warned.push(m); } } };
  const f = new Function("require", "path", "BRIDGE_DIR", "vscode", "tE", "bridgeCmd", spawnSrc + "\nreturn trySpawnMapBootstrap;")((p) => (p === path.join(BRIDGE_DIR, "map-bootstrap.js") ? mbw : require(p)), path, BRIDGE_DIR, vscode, tE, (x) => x);
  return { f, log };
}
// 저장 처리의 동의 창 조각 — grantRepos 를 돌려준다(취소면 undefined)
const gateSrc = between(OUT, "const grantRepos = [];", "// 물질화 계약(2026-07-15): 일반 저장도");
async function runGate(o) {
  const log = { info: [], posted: [], asked: [] };
  const vscode = { window: { showInformationMessage: (msg) => { log.info.push(String(msg)); return Promise.resolve(undefined); } } };
  const self = { panel: { webview: { postMessage: (x) => log.posted.push(x) } } };
  const ask = o.ask || (async (repo, stage) => { log.asked.push([repo, stage]); return o.approve === true; });
  const fn = new AsyncFunction("vscode", "tE", "mapConsentTargetExt", "askMapConsentExt", "dashboardWorkspace", "slotLang", "m", "wantScoutOn", "prevScoutOn", gateSrc + "\nreturn grantRepos;");
  const res = await fn.call(self, vscode, tE, o.target, ask, () => o.ws || "D:/w", o.slotLang || "ko", { reqId: "r1" }, o.want, o.prev);
  return { res, log };
}
// 정찰 대상 확인 단계(저장 직후 내부 비동기 블록) — 새 대상을 고른 경우의 동의 처리
const tgtBeg = OUT.lastIndexOf("await (async () => {", OUT.indexOf("const ws2 = dashboardWorkspace();"));
const tgtEnd = OUT.indexOf("})().catch(() => { });", tgtBeg); // 컴파일 산출물은 catch 안 주석을 지운다
assert.ok(tgtBeg > 0 && tgtEnd > tgtBeg, "대상 확인 조각");
const tgtSrc = "return " + OUT.slice(tgtBeg + "await ".length, tgtEnd) + "})();";
async function runTarget(o) {
  const log = { asked: [], set: [] };
  const vscode = { window: {
    showWarningMessage: () => Promise.resolve("다른 폴더 지정…"),
    showOpenDialog: () => Promise.resolve([{ fsPath: o.newRepo }]),
  } };
  const fsStub = { readFileSync: () => "{}" };
  const req = (p) => (p === "child_process" ? { spawnSync: () => ({ status: 1 }) } : require(p));
  const fn = new AsyncFunction("vscode", "tE", "dashboardWorkspace", "slotLang", "loadLangExt", "fs", "contractFileFor", "require", "setScoutTargetFromUi", "mapConsentTargetExt", "askMapConsentExt", "grantRepos", "path", "normWs", tgtSrc);
  // readBack=저장 뒤 계약을 다시 읽었을 때의 대상(기본=사용자가 고른 것 · 다른 창의 변경·저장 실패 반례는 다른 값)
  await fn.call({ post() {} }, vscode, tE, () => "D:/w", "ko", () => "ko", fsStub, () => "x", req, async (ws, p) => { log.set.push(p); }, () => ({ repo: o.readBack || path.resolve(o.newRepo), consented: !!o.newConsented }),
    async (repo, stage) => { log.asked.push([repo, stage]); return o.approve === true; }, o.grantRepos, path, normWsReal);
  return log;
}
const normWsReal = new Function("path", between(OUT, "function normWs(", "\nfunction ") + "\nreturn normWs;")(path);

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "consent-ws-"));
const A = fs.mkdtempSync(path.join(os.tmpdir(), "consent-A-"));
const B = fs.mkdtempSync(path.join(os.tmpdir(), "consent-B-"));
const put = (lang, o) => fs.writeFileSync(CL.contractFileFor(WS, lang), JSON.stringify(o));
fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });

t("판독: 저장하는 언어 칸의 정찰 대상 저장소와 그 동의 여부 · 다른 저장소=새로 묻기 · 판독 불가=묻기(안전 쪽)", () => {
  put("ko", { scoutRepo: A });
  const f = targetFn();
  let r = f(WS, "ko"); assert.ok(path.resolve(r.repo) === path.resolve(A) && r.consented === false, JSON.stringify(r));
  MB.grantConsent(A, "dashboard-toggle");
  r = f(WS, "ko"); assert.strictEqual(r.consented, true);
  put("ko", { scoutRepo: B }); assert.strictEqual(f(WS, "ko").consented, false, "다른 저장소");
  put("ko", { scoutRepo: A }); assert.strictEqual(f(WS, "ko").consented, true, "되돌리면 다시 동의 있음");
  const cf = MB.consentFileFor(A), keep = fs.readFileSync(cf, "utf8");
  try { fs.writeFileSync(cf, "{}"); assert.strictEqual(f(WS, "ko").consented, false, "기록 내용 손상"); } finally { fs.writeFileSync(cf, keep); }
  assert.deepStrictEqual(targetFn({ mb: {} })(WS, "ko"), { repo: null, consented: false }, "구 브릿지");
  assert.deepStrictEqual(targetFn({ cl: null })(WS, "ko"), { repo: null, consented: false }, "계약 모듈 없음");
  assert.deepStrictEqual(targetFn({ requireThrows: true })(WS, "ko"), { repo: null, consented: false }, "모듈 판독 예외");
  assert.deepStrictEqual(targetFn()(null, "ko"), { repo: null, consented: false }, "작업 폴더 없음");
});
t("동의 창: 저장 전 창은 지도 폴더가 생길 저장소 경로·'다시 묻지 않음'을 보여 주고 '켜고 계속'만 동의 · 새 대상 창은 '지도 만들기'만 동의('나중에'=보류)", async () => {
  let a = askFn((btns) => btns[0]);
  assert.strictEqual(await a.f("D:/repoA", "before-save"), true);
  assert.ok(a.seen[0].modal && /정찰 대상 저장소\(D:\/repoA\) 안에 구조 지도 폴더\(project-map\/\)가 만들어집니다/.test(a.seen[0].msg) && /한 번 동의하면 이 저장소에서는 다시 묻지 않아요/.test(a.seen[0].msg), a.seen[0].msg);
  a = askFn(undefined); assert.strictEqual(await a.f("D:/repoA", "before-save"), false, "닫기=취소");
  a = askFn((btns) => btns[0]); assert.strictEqual(await a.f("D:/repoR", "after-target"), true);
  assert.ok(/새로 고른 정찰 대상 저장소\(D:\/repoR\)에는 아직 지도 폴더 동의가 없어요/.test(a.seen[0].msg) && a.seen[0].btns.join("|") === "지도 만들기|나중에", a.seen[0].msg);
  a = askFn((btns) => btns[1]); assert.strictEqual(await a.f("D:/repoR", "after-target"), false, "나중에=보류");
});
t("저장 처리 조각: 꺼짐→켜짐·동의 있음=창 없이 진행·기록 대상 없음 / 동의 없음=창 → 켜고 계속=그 저장소만 기록 대상 · 취소=저장 중단 / 이미 켜짐·끄기=창 없음", async () => {
  let r = await runGate({ want: true, prev: false, target: () => ({ repo: A, consented: true }) });
  assert.deepStrictEqual(r.res, []); assert.strictEqual(r.log.asked.length, 0);
  r = await runGate({ want: true, prev: false, target: () => ({ repo: A, consented: false }), approve: true });
  assert.deepStrictEqual(r.res, [A]); assert.deepStrictEqual(r.log.asked, [[A, "before-save"]]);
  r = await runGate({ want: true, prev: false, target: () => ({ repo: A, consented: false }), approve: false });
  assert.strictEqual(r.res, undefined); assert.ok(/취소됨/.test(r.log.info[0]) && r.log.posted[0].ok === false && r.log.posted[0].reqId === "r1");
  for (const [want, prev] of [[true, true], [false, true], [false, false]]) {
    r = await runGate({ want, prev, target: () => { throw new Error("판독하면 안 됨"); } });
    assert.deepStrictEqual(r.res, [], want + "/" + prev); assert.strictEqual(r.log.asked.length, 0);
  }
  r = await runGate({ want: true, prev: false, target: () => ({ repo: null, consented: false }), approve: true });
  assert.deepStrictEqual(r.res, [""], "저장소 해석 실패 뒤 동의=빈 표식(기동 쪽 해석 저장소 — 종전 동작)");
});
t("지도 생성 시작: 넘겨받은 저장소에만 동의 기록 · 빈 목록이면 아무 기록 없이 시작만(동의 없는 저장소는 자동 생성 관문이 막음)", () => {
  put("ko", { scoutMode: "on", scoutRepo: B }); put("en", {}); CL.saveLang("ko");
  assert.strictEqual(MB.hasConsent(B), false);
  let s = spawnFn(); s.f(WS, []);
  assert.deepStrictEqual(s.log.granted, []); assert.strictEqual(s.log.spawned, 1); assert.strictEqual(MB.hasConsent(B), false, "B 에 기록 안 생김");
  const sig = MB.parentSignals(WS); assert.ok(sig && path.resolve(sig.repo) === path.resolve(B) && sig.consent === false, "자동 생성 관문=동의 없음(pending-consent 로 막힘)");
  s = spawnFn(); s.f(WS, [A]);
  assert.deepStrictEqual(s.log.granted, [A]); assert.strictEqual(MB.hasConsent(B), false, "A 만 기록 · B 는 그대로");
  s = spawnFn(); s.f(WS, [""]);
  assert.deepStrictEqual(s.log.granted.map((x) => path.resolve(x)), [path.resolve(B)], "빈 표식=기동이 해석한 저장소(종전 동작)");
  fs.rmSync(MB.consentFileFor(B), { force: true });
});
t("[구현 검증 1판 반례 ①] 한국어 칸(꺼짐·대상 A·동의 있음)을 보며 켜는데 전역 언어는 영어(켜짐·대상 B·동의 없음) — 창 없음 · B 에 동의 기록이 생기지 않음", async () => {
  put("ko", { scoutMode: "off", scoutRepo: A }); put("en", { scoutMode: "on", scoutRepo: B }); CL.saveLang("en");
  assert.strictEqual(MB.hasConsent(A), true); assert.strictEqual(MB.hasConsent(B), false);
  const g = await runGate({ want: true, prev: false, slotLang: "ko", ws: WS, target: targetFn() });
  assert.deepStrictEqual(g.res, []); assert.strictEqual(g.log.asked.length, 0);
  const s = spawnFn(); s.f(WS, g.res);
  assert.deepStrictEqual(s.log.granted, []); assert.strictEqual(MB.hasConsent(B), false, "동의한 적 없는 B 에 기록 없음");
  const sig = MB.parentSignals(WS); assert.ok(sig && path.resolve(sig.repo) === path.resolve(B) && sig.consent === false, "B 의 자동 생성은 동의 없음으로 막힘");
  CL.saveLang("ko");
});
t("[구현 검증 1판 반례 ②] 같은 언어에서 동의 확인 뒤 저장 사이에 대상이 A→B 로 바뀌어도 B 에 기록이 생기지 않음", async () => {
  put("ko", { scoutMode: "off", scoutRepo: A }); put("en", {});
  const g = await runGate({ want: true, prev: false, slotLang: "ko", ws: WS, target: targetFn() });
  assert.deepStrictEqual(g.res, []);
  put("ko", { scoutMode: "on", scoutRepo: B }); // 다른 창이 저장 사이에 대상을 바꿈
  const s = spawnFn(); s.f(WS, g.res);
  assert.deepStrictEqual(s.log.granted, []); assert.strictEqual(MB.hasConsent(B), false);
});
t("정찰 대상 확인 단계에서 새 저장소를 직접 고르면: 이번 흐름에서 이미 창으로 동의했으면 새 저장소도 기록(종전 동작) · 옛 동의로 건너뛰었으면 새 저장소만 따로 묻기 · 이미 동의된 저장소면 묻지 않음", async () => {
  const R = path.resolve("D:/R");
  let gr = [A];
  let l = await runTarget({ newRepo: "D:/R", newConsented: false, grantRepos: gr });
  assert.deepStrictEqual(gr, [A, R]); assert.strictEqual(l.asked.length, 0); assert.deepStrictEqual(l.set, [R]);
  gr = [];
  l = await runTarget({ newRepo: "D:/R", newConsented: false, grantRepos: gr, approve: true });
  assert.deepStrictEqual(l.asked, [[R, "after-target"]]); assert.deepStrictEqual(gr, [R]);
  gr = [];
  l = await runTarget({ newRepo: "D:/R", newConsented: false, grantRepos: gr, approve: false });
  assert.deepStrictEqual(gr, [], "나중에=기록 없음(보류)");
  gr = [];
  l = await runTarget({ newRepo: "D:/R", newConsented: true, grantRepos: gr });
  assert.strictEqual(l.asked.length, 0); assert.deepStrictEqual(gr, []);
});
t("[구현 검증 2판 반례] 새 대상 R 을 골랐는데 저장과 재판독 사이 다른 창이 대상을 B 로 바꿨거나 저장이 실패해 옛 대상이 남으면: 아무것도 넣지 않고 묻지도 않음(B 를 보여 준 동의 창 없이 B 기록 금지)", async () => {
  const Bp = path.resolve("D:/B");
  let gr = [A];
  let l = await runTarget({ newRepo: "D:/R", readBack: Bp, newConsented: false, grantRepos: gr });
  assert.deepStrictEqual(gr, [A], "이번 흐름 동의가 있어도 B 는 넣지 않음"); assert.strictEqual(l.asked.length, 0);
  gr = [];
  l = await runTarget({ newRepo: "D:/R", readBack: Bp, newConsented: false, grantRepos: gr, approve: true });
  assert.deepStrictEqual(gr, []); assert.strictEqual(l.asked.length, 0, "B 에 대해 묻지도 않음");
  gr = [A];
  l = await runTarget({ newRepo: "D:/R", readBack: path.resolve("D:/w"), newConsented: false, grantRepos: gr });
  assert.deepStrictEqual(gr, [A], "저장 실패로 옛 대상이 남은 경우도 추가 없음");
  gr = [A];
  l = await runTarget({ newRepo: "d:\\R\\", readBack: path.resolve("D:/R"), newConsented: false, grantRepos: gr });
  assert.deepStrictEqual(gr, [A, path.resolve("D:/R")], "대소문자·끝 구분자만 다른 같은 경로는 같은 저장소(normWs)");
});
t("배선: 저장 뒤 지도 생성 시작은 이번 흐름의 동의 저장소 목록을 넘긴다 · 다시 해석한 저장소에 무조건 기록하던 옛 코드 없음", () => {
  assert.ok(OUT.includes("trySpawnMapBootstrap(wsB, grantRepos);"), "호출부");
  assert.ok(!/mb\.grantConsent\(sig\.repo, "dashboard-toggle"\)/.test(OUT), "옛 무조건 기록 제거");
  assert.ok(!OUT.includes("mapConsentGivenExt"), "옛 판독 함수 이름 없음");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\nmap-consent-once 결과: ${n} 통과 / 0 실패`);
})().catch((e) => { console.error("❌", e && e.stack || e); process.exit(1); });
