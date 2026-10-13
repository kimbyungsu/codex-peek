"use strict";
/*
 * [RULE-SUPPLY-CORRECTION ⑦ 묶음 4(E) · 사용자 결정 D-c — 2026-10-13] 옛 코드로 수칙서·후보 장부를 쓰는 일 막기.
 *  ① 판정(out/bridge-stale.js bridgeWriteStale): 관측 기반 + 모듈이 내보낸 '읽힌 순간 지문' — 읽기와 첫 관측 사이에 바뀐 경우도 이전 판 · 지문 없는 모듈=관측만 · 파일 없음=이전 판
 *  ② 실제 모듈: 수칙 라이브러리(contract-lib)를 임시 브릿지 홈에 두고 읽은 뒤 파일을 바꾸면(설치본 교체) 첫 관측보다 먼저 바뀌어도 이전 판으로 잡힘
 *  ③ 컴파일 산출물 차단 장치 실제 실행: 같으면 통과 · 바뀌면 쓰지 않음(막힘)+다시 불러오기 안내·버튼 → 창 다시 로드 · 판정 실패=막힘
 *  ④ 위치 고정: 수칙서·후보 장부에 쓰는 화면 동작 7개(시작)와 확인 창 뒤 도장 직전 3곳에서 차단 검사가 쓰기보다 먼저
 *     [검증 1회차] + 확인 창 뒤 초안 취소·승인 취소 뒤 자동 정리·마지막 승인 목록 복구 쓰기 직전 · ⑤ 화면 갱신 중 쓰기(후보 장부 정리·승인 지문 칸)도 옛 판이면 생략
 * ※ out/*.js 는 npm test 의 tsc 산출물 — 단독 실행 시 `npx tsc -p ./` 먼저.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "swg-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const BS = require(path.join(ROOT, "out", "bridge-stale.js"));

const pending = [];
const t = (name, fn) => { pending.push([name, fn]); };
const statOf = (p) => { try { const s = fs.statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } };
const identOf = (p) => { try { const ex = (require.cache[p] || {}).exports; const id = ex && ex.LOADED_IDENT; return id && typeof id.mtimeMs === "number" ? { mtimeMs: id.mtimeMs, size: id.size } : null; } catch { return null; } };
// 설치본 교체 재현 — 내용 덧붙임 + 수정 시각을 확실히 뒤로(파일 시스템 시각 해상도와 무관하게)
function replaceInstalled(file) { fs.appendFileSync(file, "\n// installed again\n"); const t9 = new Date(Date.now() + 5000); fs.utimesSync(file, t9, t9); }

t("① 판정 — 읽힌 순간 지문이 다르면 첫 관측이 바뀐 뒤여도 이전 판 · 지문 없는 모듈=관측 기반만 · 파일 없음=이전 판 · 브릿지 홈 밖·하위 폴더 무시", () => {
  const dir = "C:\\home\\b";
  const stats = { "C:\\home\\b\\contract-lib.js": { mtimeMs: 200, size: 21 }, "C:\\home\\b\\map-enrich.js": { mtimeMs: 100, size: 10 }, "C:\\other\\x.js": { mtimeMs: 1, size: 1 }, "C:\\home\\b\\node_modules\\y.js": { mtimeMs: 1, size: 1 } };
  const ids = { "C:\\home\\b\\contract-lib.js": { mtimeMs: 200, size: 20 } }; // 읽힐 때는 20바이트였고 지금은 21바이트(읽기와 첫 관측 사이에 교체)
  const cached = Object.keys(stats);
  const sOf = (p) => stats[p] || null, iOf = (p) => ids[p] || null;
  const obs = BS.observeBridgeStale(cached, dir, new Map(), sOf);
  assert.strictEqual(obs.stale, false, "(대조) 관측 기반만으로는 첫 관측이 교체 뒤라 놓침");
  const r = BS.bridgeWriteStale(cached, dir, new Map(), sOf, iOf);
  assert.ok(r.stale && r.changed.join(",") === "contract-lib.js", "★읽힌 순간 지문으로 잡음 " + JSON.stringify(r));
  // 지문 없는 모듈=관측 기반만(첫 관측=정상 · 이후 바뀌면 이전 판)
  const loaded = new Map();
  const ids2 = { "C:\\home\\b\\contract-lib.js": { mtimeMs: 200, size: 21 } };
  assert.strictEqual(BS.bridgeWriteStale(cached, dir, loaded, sOf, (p) => ids2[p] || null).stale, false, "같으면 정상");
  stats["C:\\home\\b\\map-enrich.js"] = { mtimeMs: 101, size: 10 };
  const r2 = BS.bridgeWriteStale(cached, dir, loaded, sOf, (p) => ids2[p] || null);
  assert.ok(r2.stale && r2.changed.join(",") === "map-enrich.js", "★지문 없는 모듈은 관측 기반으로 " + JSON.stringify(r2));
  // 파일 없음=이전 판 · 브릿지 홈 밖·하위 폴더는 지문이 달라도 무시
  delete stats["C:\\home\\b\\contract-lib.js"];
  const r3 = BS.bridgeWriteStale(cached, dir, new Map(), sOf, (p) => ({ mtimeMs: 0, size: 0 }));
  assert.ok(r3.changed.includes("contract-lib.js") && !r3.changed.includes("x.js") && !r3.changed.includes("y.js"), "★파일 없음=이전 판 · 밖·하위 무시 " + JSON.stringify(r3));
  // [검증 1회차 blocker] 자기 지문이 없는 모듈의 첫 관측에서도 지금 파일을 못 읽으면 이전 판
  const r4 = BS.bridgeWriteStale(["C:\\home\\b\\gone.js"], dir, new Map(), () => null, () => null);
  assert.ok(r4.stale && r4.changed.join(",") === "gone.js", "★첫 관측·지문 없음·파일 없음=이전 판 " + JSON.stringify(r4));
});

// 실제 수칙 라이브러리를 임시 브릿지 홈에 설치한 모양
const BDIR = fs.mkdtempSync(path.join(os.tmpdir(), "swg-bridge-"));
const LIB = path.join(BDIR, "contract-lib.js");
fs.copyFileSync(path.join(ROOT, "bridge", "contract-lib.js"), LIB);

t("② 실제 모듈 — 수칙 라이브러리를 읽은 뒤 설치본이 바뀌면(첫 관측보다 먼저 바뀌어도) 이전 판", () => {
  const CLt = require(LIB);
  const st0 = statOf(LIB);
  assert.ok(CLt.LOADED_IDENT && CLt.LOADED_IDENT.mtimeMs === st0.mtimeMs && CLt.LOADED_IDENT.size === st0.size, "★읽힌 순간 지문=그때 파일 " + JSON.stringify(CLt.LOADED_IDENT));
  const loaded = new Map();
  assert.strictEqual(BS.bridgeWriteStale(Object.keys(require.cache), BDIR, loaded, statOf, identOf).stale, false, "바뀌기 전=정상");
  replaceInstalled(LIB);
  const loaded2 = new Map(); // 첫 관측이 교체 뒤에 처음 일어나는 창(빈틈)
  assert.strictEqual(BS.observeBridgeStale(Object.keys(require.cache), BDIR, loaded2, statOf).stale, false, "(대조) 관측 기반만으로는 놓침");
  const r = BS.bridgeWriteStale(Object.keys(require.cache), BDIR, new Map(), statOf, identOf);
  assert.ok(r.stale && r.changed.includes("contract-lib.js"), "★읽힌 순간 지문으로 잡음 " + JSON.stringify(r));
  assert.ok(BS.bridgeWriteStale(Object.keys(require.cache), BDIR, loaded, statOf, identOf).stale, "먼저 관측해 둔 창도 이전 판");
});

t("③ 컴파일 산출물 차단 장치 실제 실행 — 같으면 통과 · 바뀌면 쓰지 않음+다시 불러오기 안내·버튼 · 판정 실패=막힘", async () => {
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf("function bridgeWriteGuard() {"), e = outSrc.indexOf("async function promptBridgeReload(", b);
  assert.ok(b > 0 && e > b && outSrc.slice(b, e).includes("function staleWriteBlocked(en) {"), "차단 장치 조각");
  const mkVscode = (pick) => { const v = { warns: [], cmds: [], window: { showWarningMessage: (msg, ...btns) => { v.warns.push({ msg, btns }); return Promise.resolve(pick === "first" ? btns[0] : undefined); } }, commands: { executeCommand: (c) => { v.cmds.push(c); return Promise.resolve(); } } }; return v; };
  const load = (vs, bsMod, dir) => new Function("fs", "require", "BRIDGE_DIR", "bridgeLoadedIdents", "bridge_stale_1", "vscode", outSrc.slice(b, e) + "\nreturn { bridgeWriteGuard, staleWriteBlocked };")(fs, require, dir, new Map(), bsMod, vs);
  // 새 브릿지 홈 — 읽은 뒤 바뀌지 않음=통과
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), "swg-bridge2-"));
  const L2 = path.join(D2, "contract-lib.js");
  fs.copyFileSync(path.join(ROOT, "bridge", "contract-lib.js"), L2);
  require(L2);
  const v1 = mkVscode("first");
  const g1 = load(v1, BS, D2);
  assert.strictEqual(g1.staleWriteBlocked(false), false, "★같으면 막지 않음");
  assert.strictEqual(v1.warns.length, 0, "안내 없음");
  // 설치본 교체 → 막힘 + 안내 + 버튼 → 창 다시 로드
  replaceInstalled(L2);
  assert.strictEqual(g1.staleWriteBlocked(false), true, "★바뀌면 막음(호출자는 쓰지 않고 돌아감)");
  assert.ok(v1.warns.length === 1 && v1.warns[0].msg.startsWith("적용하지 않았어요") && v1.warns[0].msg.includes("contract-lib.js") && v1.warns[0].btns[0] === "지금 다시 로드", "★안내·버튼 " + JSON.stringify(v1.warns));
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(v1.cmds, ["workbench.action.reloadWindow"], "★버튼=창 다시 로드");
  const v2 = mkVscode(undefined);
  const g2 = load(v2, BS, D2);
  assert.strictEqual(g2.staleWriteBlocked(true), true);
  assert.ok(v2.warns[0].msg.startsWith("Not applied") && v2.warns[0].btns[0] === "Reload now", "영어판");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(v2.cmds.length, 0, "버튼을 안 누르면 다시 로드 안 함");
  // 판정 자체가 실패하면 막는다(쓰기 안전 우선)
  const v3 = mkVscode(undefined);
  const g3 = load(v3, { bridgeWriteStale: () => { throw new Error("boom"); } }, D2);
  assert.strictEqual(g3.staleWriteBlocked(false), true, "★판정 실패=막힘");
});

t("④ 위치 고정 — 쓰기 동작 7개(시작)와 확인 창 뒤 도장 직전 3곳에서 차단 검사가 쓰기보다 먼저", () => {
  const out = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const WRITES = ["draftEnvelopeRevision(", "draftEnvelopeInitial(", "draftCuratorCandidate(", "appendEnvelopeCandidates(", "discardEnvelopeProposalRestoring(", "discardEnvelopeProposal(", "recordApprovalWithStamp(", "stampEnvelopeAllSlots(", "applyEnvelopeTransition(", "recoverEnvelopeTransition(", "runProposalApprove(", "markCandidate", "candidateMark("];
  const firstWrite = (seg) => { let k = -1; for (const w of WRITES) { const i = seg.indexOf(w); if (i >= 0 && (k < 0 || i < k)) k = i; } return k; };
  const GUARD = "staleWriteBlocked(";
  const handler = (type) => { const a = out.indexOf('m?.type === "' + type + '"'); assert.ok(a > 0, type); const z = out.indexOf('if (m?.type === "', a + 20); return out.slice(a, z < 0 ? undefined : z); };
  for (const type of ["candMark", "candBatch", "envelopeRevise", "envelopeApprove", "proposalDiscard", "proposalRecover"]) {
    const seg = handler(type), g = seg.indexOf(GUARD), w = firstWrite(seg);
    assert.ok(g > 0 && w > 0 && g < w, "★" + type + " — 차단 검사가 첫 쓰기보다 먼저 (검사 " + g + " · 쓰기 " + w + ")");
  }
  // 초안 승인 버튼(proposalApprove)=runProposalApprove 로 위임 — 그 본문 시작과 확인 창 뒤 도장 직전
  assert.ok(handler("proposalApprove").includes("this.runProposalApprove("), "초안 승인 위임");
  const meth = (sig) => { const a = out.indexOf(sig); assert.ok(a > 0, sig); const z = out.indexOf("\n    }\n", a); return out.slice(a, z); };
  const rp = meth("runProposalApprove(repoMsg, langMsg, autoDiscardOnCancel, chain) {");
  const g1 = rp.indexOf(GUARD), modal = rp.indexOf("modal: true"), g2 = rp.indexOf(GUARD, g1 + 1), st = rp.indexOf("recordApprovalWithStamp(");
  assert.ok(g1 > 0 && g1 < modal && modal < g2 && g2 < st, "★초안 승인 — 시작·확인 창 뒤 도장 직전 (" + [g1, modal, g2, st].join(",") + ")");
  const ea = handler("envelopeApprove");
  const e1 = ea.indexOf(GUARD), em = ea.indexOf("modal: true"), e2 = ea.indexOf(GUARD, e1 + 1), es = ea.indexOf("recordApprovalWithStamp(");
  assert.ok(e1 > 0 && e1 < em && em < e2 && e2 < es, "★수칙서 승인 — 시작·확인 창 뒤 도장 직전 (" + [e1, em, e2, es].join(",") + ")");
  const sc = meth("stampEnvelopeCurrent(repoAt, target, lang, shaAt) {");
  const s1 = sc.indexOf(GUARD), ss = sc.indexOf("recordApprovalWithStamp(");
  assert.ok(s1 > 0 && s1 < ss, "★지금 파일 승인 — 도장 직전");
  // [검증 1회차 blocker] 확인 창 뒤의 쓰기 — 초안 취소 · 초안 승인 확인 창에서 취소한 뒤 자동 정리 · 마지막 승인 목록으로 복구
  const pd = handler("proposalDiscard");
  const d1 = pd.indexOf(GUARD), dm = pd.indexOf("modal: true"), d2 = pd.indexOf(GUARD, d1 + 1), dw = pd.indexOf("discardEnvelopeProposalRestoring(");
  assert.ok(d1 > 0 && d1 < dm && dm < d2 && d2 < dw, "★초안 취소 — 시작·확인 창 뒤 쓰기 직전 (" + [d1, dm, d2, dw].join(",") + ")");
  const cancelAt = rp.indexOf("if (autoDiscardOnCancel) {"), cg = rp.indexOf(GUARD, cancelAt), cw = rp.indexOf("discardEnvelopeProposalRestoring(", cancelAt);
  assert.ok(cancelAt > modal && cg > cancelAt && cg < cw, "★초안 승인 확인 창에서 취소 — 자동 정리 직전 (" + [cancelAt, cg, cw].join(",") + ")");
  // 승인을 고른 뒤의 쓰기 직전 검사 — 취소 정리(cw) 뒤 · 승인 쪽 재검사(wsNow2) 앞에 따로 있어야 함(취소 쪽 검사로 대신할 수 없음)
  const w2 = rp.indexOf("const wsNow2 = dashboardWorkspace();"), ga = rp.lastIndexOf(GUARD, w2);
  assert.ok(w2 > cw && ga > cw && ga < w2 && w2 < st, "★초안 승인 — 승인 선택 뒤 도장 직전 검사가 따로 (" + [cw, ga, w2, st].join(",") + ")");
  const dr = handler("envelopeDriftShow");
  const rm = dr.indexOf("modal: true"), rg = dr.indexOf(GUARD), rw = dr.indexOf("restoreEnvelopeApproved(");
  assert.ok(rm > 0 && rg > rm && rg < rw, "★마지막 승인 목록으로 복구 — 확인 창 뒤 쓰기 직전 (" + [rm, rg, rw].join(",") + ")");
  assert.strictEqual((out.match(/staleWriteBlocked\(/g) || []).length, 14, "정의 1 + 13곳");
});

t("⑤ [검증 1회차] 화면 갱신 중 쓰기(후보 장부 정리·승인 지문 칸 맞추기)도 옛 판이면 생략 — 컴파일 산출물 문장 실제 실행", () => {
  const out = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const a = out.indexOf('if (typeof CL9.reconcileMemoryCandidates === "function" && !bridgeWriteGuard().stale)'), z = out.indexOf(";", out.indexOf("CL9.reconcileMemoryCandidates(ws, repo9, genC9)", a)) + 1;
  assert.ok(a > 0 && z > a, "정리 문장");
  const runRecon = (stale) => { const calls = []; new Function("CL9", "bridgeWriteGuard", "ws", "repo9", "genC9", out.slice(a, z))({ reconcileMemoryCandidates: (...x) => calls.push(x) }, () => ({ stale, changed: [] }), "W", "R", "G"); return calls.length; };
  assert.strictEqual(runRecon(false), 1, "같은 판=정리함(종전)");
  assert.strictEqual(runRecon(true), 0, "★옛 판=화면 갱신 중 후보 장부 정리 안 함");
  const b = out.indexOf("if (oh9 && oh9 === evv.sha1 && typeof CL9.setEnvelopeHashAllSlots"), e = out.indexOf("\n", b);
  assert.ok(b > 0 && e > b && out.slice(b, e).includes("!bridgeWriteGuard().stale"), "지문 칸 맞추기 문장");
  const runSync = (stale) => { const calls = []; new Function("CL9", "bridgeWriteGuard", "ws", "oh9", "evv", "hash9", out.slice(b, e) + " hash9 = oh9; return calls9;".replace("calls9", "hash9"))({ setEnvelopeHashAllSlots: (...x) => { calls.push(x); return 2; } }, () => ({ stale, changed: [] }), "W", "H", { sha1: "H" }, null); return calls.length; };
  assert.strictEqual(runSync(false), 1, "같은 판=맞춤(종전)");
  assert.strictEqual(runSync(true), 0, "★옛 판=승인 지문 칸 안 씀");
});

(async () => {
  let n = 0;
  for (const [name, fn] of pending) {
    try { await fn(); n++; console.log("  ✅ [" + n + "] " + name); }
    catch (e) { console.error("  ❌ " + name); console.error(e); process.exit(1); }
  }
  console.log("\n결과: " + n + "/" + pending.length + " 통과");
})();
