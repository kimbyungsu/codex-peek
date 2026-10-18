"use strict";
/*
 * [2026-10-18 사용자 요청 · D-2026-10-18-curator-2track-follows-mode] 수칙 흐름이 화면에서 보이게:
 *   ① 한눈에 보기 수칙 줄(누가·어디서·어떤 모델) ② 수칙서·사용자 말 카드·개요 정리 담당 칸의 표식 ③ 2트랙에서 탐색·의미 보강 줄이 남던 결함
 *   ④ 고급설정 '이 프로젝트에서 지금 쓰는 곳' ⑤ 수칙 흐름 안내 새탭.
 * 확장 산출물(out/extension.js)의 실제 화면 조각·함수를 가짜 화면 요소 위에서 실행한다(문구 존재만 보는 단언은 반대로 동작하는 구현을 못 잡는다).
 * 격리: VS Code·브릿지 홈·사용자 설정 무접촉.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const OUT = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, "조각 " + a.slice(0, 50)); return s.slice(i, j); };
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const T = (ko) => ko;

// ── 가짜 화면 요소 ──
function mkEl(tag) {
  const e = { tag, className: "", id: "", style: {}, textContent: "", title: "", kids: [], attrs: {}, disabled: false,
    appendChild(c) { this.kids.push(c); return c; }, replaceChildren() { this.kids = []; },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {},
    classList: { _s: new Set(), add(x) { this._s.add(x); }, remove(x) { this._s.delete(x); }, toggle(x, on) { if (on === undefined ? !this._s.has(x) : on) this._s.add(x); else this._s.delete(x); }, contains(x) { return this._s.has(x); } },
    querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, "innerHTML", { set() { e.kids = []; e.textContent = ""; }, get() { return ""; } });
  return e;
}
const document = { createElement: mkEl, createTextNode: (s) => ({ textContent: String(s), kids: [] }) };
const textOf = (e) => (e ? String(e.textContent || "") + (e.kids || []).map(textOf).join("") : "");
function domWith(ids) { const m = {}; ids.forEach((id) => { m[id] = mkEl("div"); m[id].id = id; }); return { m, $: (id) => m[id] || null }; }
const el = (tag, cls, text) => { const e = mkEl(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ── ①②④ 수칙 줄·개요 칸·고급설정 줄 — rfWhen ~ renderRulesFlow 조각 실행 ──
const rfSrc = between(OUT, "function rfWhen(ts){", "function decideActs(d){");
function rfApi($) {
  return new Function("T", "$", "document", "el", rfSrc + "\nreturn { renderRulesMap, renderRulesFlow, rfCuratorWhen, rfHelpers, rfMarks, rfArmCo, rfArmModel };")(T, $, document, el);
}
const MAP_IDS = ["rfmClsWho", "rfmClsModel", "rfmSelWho", "rfmSelModel", "rfmImpl", "rfmImplWho", "rfmCurWho", "rfmCurSrc", "rfmCurWhen", "scUse", "dsUse"];
const nc0 = { tickK: 10, tickCount: 2, unusedDays: 30, lastTickTs: "", th: { oosRepeat: 2, lineage: 3, selOver: 3 } };
const baseD = (helpers, extra) => Object.assign({ scoutCodex: { model: "gpt-x", reasoning: "high" }, deepseek: { model: "deepseek-v4-flash" }, contract: { harnessMode: helpers && helpers.mode, scoutMode: helpers && helpers.track === 3 ? "on" : "off" },
  rulesFlow: { helpers, proposals: { pending: 0, max: 6, nextCheck: nc0 } } }, extra || {});

t("2트랙·클로드-코덱스 — 분류·선별=회사 규칙+두 회사 모델(단정 안 함) · 정리 담당=Claude(운용 모드를 따름·고를 수 없음) · 구현 대화 칸=Claude · Codex 설정은 'Codex 대화가 있을 때'만 · DeepSeek 없음", () => {
  const { m, $ } = domWith(MAP_IDS); const api = rfApi($);
  api.renderRulesMap(baseD({ mode: "claude-codex", track: 2, impl: "self", curator: { arm: "self", source: "mode", raw: null, degraded: null } }));
  assert.strictEqual(m.rfmClsWho.textContent, "말이 나온 대화와 같은 회사"); assert.strictEqual(m.rfmSelWho.textContent, "그 차례 구현 담당과 같은 회사");
  assert.strictEqual(m.rfmClsModel.textContent, "Claude → Claude Code 기본 모델 · Codex → gpt-x · high"); assert.strictEqual(m.rfmSelModel.textContent, m.rfmClsModel.textContent);
  assert.strictEqual(m.rfmCurWho.textContent, "Claude · Claude Code 기본 모델");
  assert.ok(/운용 모드\(클로드-코덱스\)를 따름 · 고를 수 없음/.test(m.rfmCurSrc.textContent), m.rfmCurSrc.textContent);
  assert.strictEqual(m.rfmImpl.className, "fnode actor claude"); assert.strictEqual(m.rfmImplWho.textContent, "Claude 구현 대화");
  assert.ok(/검증 묶음 마감 2\/10회/.test(m.rfmCurWhen.title) && /같은 범위 밖 항목으로 지적이 2번/.test(m.rfmCurWhen.title) && /30일간/.test(m.rfmCurWhen.title), "계기 설명=브릿지 숫자 " + m.rfmCurWhen.title);
  assert.ok(/2트랙 · 클로드-코덱스\)에서 지금 쓰는 곳: Codex 대화가 있을 때의 사용자 말 분류·서고 선별$/.test(m.scUse.textContent) && /지금 쓰는 곳: 없음/.test(m.dsUse.textContent), m.scUse.textContent);
});

t("2트랙·코덱스-코덱스 — 분류·선별·정리 담당=Codex(정찰 설정 모델) · 구현 대화 칸=Codex · Codex 설정 쓰는 곳 3개", () => {
  const { m, $ } = domWith(MAP_IDS); const api = rfApi($);
  api.renderRulesMap(baseD({ mode: "codex-codex", track: 2, impl: "codex", curator: { arm: "codex", source: "mode", raw: null, degraded: null } }));
  assert.strictEqual(m.rfmClsWho.textContent, "말이 나온 대화와 같은 회사");
  assert.strictEqual(m.rfmCurWho.textContent, "Codex · gpt-x · high");
  assert.ok(/운용 모드\(코덱스-코덱스\)를 따름/.test(m.rfmCurSrc.textContent));
  assert.strictEqual(m.rfmImpl.className, "fnode actor codex");
  assert.ok(/사용자 말 분류 · 서고 선별 · 정리 담당$/.test(m.scUse.textContent), m.scUse.textContent);
});

t("3트랙·클로드-코덱스·탐색 담당 DeepSeek·의미 보강 정밀형 — 정리 담당=DeepSeek(탐색 담당 선택을 따름) · DeepSeek 쓰는 곳=정리 담당·정찰 · Codex 쓰는 곳=의미 보강", () => {
  const { m, $ } = domWith(MAP_IDS); const api = rfApi($);
  api.renderRulesMap(baseD({ mode: "claude-codex", track: 3, impl: "self", curator: { arm: "deepseek", source: "scout", raw: "deepseek", degraded: null } }, { scoutArm: { eff: "deepseek" }, mapMode: { mode: "precision" } }));
  assert.strictEqual(m.rfmCurWho.textContent, "DeepSeek · deepseek-v4-flash");
  assert.strictEqual(m.rfmCurSrc.textContent, "3트랙의 탐색 담당 선택을 따름");
  assert.ok(/정리 담당 · 정찰\(영향지도\)$/.test(m.dsUse.textContent) && /의미 보강$/.test(m.scUse.textContent), m.dsUse.textContent + " / " + m.scUse.textContent);
});

t("3트랙·키 없는 DeepSeek 강등 — 출처 줄에 '키가 없어 모드 기본이 대신 맡음' · 2트랙에서 남은 탐색 담당 값은 쓰는 곳 계산에 안 들어감", () => {
  const { m, $ } = domWith(MAP_IDS); const api = rfApi($);
  api.renderRulesMap(baseD({ mode: "claude-codex", track: 3, impl: "self", curator: { arm: "self", source: "scout", raw: "deepseek", degraded: "no-key" } }));
  assert.ok(/키가 없어 모드 기본이 대신 맡음/.test(m.rfmCurSrc.textContent));
  const b = domWith(MAP_IDS); rfApi(b.$).renderRulesMap(baseD({ mode: "claude-codex", track: 2, impl: "self", curator: { arm: "self", source: "mode" } }, { scoutArm: { eff: "codex" }, mapMode: { mode: "precision" } }));
  assert.ok(!/정찰|의미 보강/.test(b.m.scUse.textContent), "2트랙=정찰·의미 보강(해소 판정 포함) 미산입 " + b.m.scUse.textContent);
});

t("구 브릿지(helpers 없음) — 회사를 지어내지 않고 '회사 확인 불가'·다시 로드 안내 · 분류/선별은 계약 모드로", () => {
  const { m, $ } = domWith(MAP_IDS); const api = rfApi($);
  const d = baseD(null); d.contract = { harnessMode: "codex-codex", scoutMode: "off" };
  api.renderRulesMap(d);
  assert.strictEqual(m.rfmCurWho.textContent, "회사 확인 불가");
  assert.ok(/읽지 못했어요/.test(m.rfmCurSrc.textContent));
  assert.strictEqual(m.rfmClsWho.textContent, "말이 나온 대화와 같은 회사"); assert.strictEqual(m.rfmClsModel.textContent, "Claude → Claude Code 기본 모델 · Codex → gpt-x · high");
});

t("[구현 검증 1판 blocker f-6dade34f 반례] 어떤 모드·트랙에서도 분류·선별 칸은 한 회사로 단정하지 않는다(Codex 대화에서 모인 말이 남은 채 클로드-코덱스로 바꿔도 화면이 'Claude'로 단정하지 않음)", () => {
  for (const h of [{ mode: "claude-codex", track: 2, impl: "self", curator: { arm: "self", source: "mode" } }, { mode: "codex-codex", track: 3, impl: "codex", curator: { arm: "deepseek", source: "scout" } }, null]) {
    const { m, $ } = domWith(MAP_IDS); rfApi($).renderRulesMap(baseD(h));
    assert.ok(m.rfmClsWho.textContent === "말이 나온 대화와 같은 회사" && m.rfmSelWho.textContent === "그 차례 구현 담당과 같은 회사" && /Claude → .* · Codex → /.test(m.rfmClsModel.textContent), JSON.stringify(h));
    if (!h || h.impl !== "codex") assert.ok(/Codex 대화가 있을 때의 사용자 말 분류·서고 선별/.test(m.scUse.textContent), "Claude 모드도 Codex 사용 가능성을 숨기지 않음 " + m.scUse.textContent);
  }
});

t("[구현 검증 1판 blocker f-2e2d7712 반례] 3트랙 의미 보강 기본형·경제형이어도 Codex 설정 쓰는 곳에 '충돌·해소 판정(필요할 때)' · 정밀형·자동형은 '의미 보강' 하나(중복 없음) · DeepSeek 쓰는 곳은 경제형·자동형만", () => {
  const H3 = { mode: "claude-codex", track: 3, impl: "self", curator: { arm: "self", source: "scout" } };
  const use = (mode) => { const { m, $ } = domWith(MAP_IDS); rfApi($).renderRulesMap(baseD(H3, { scoutArm: { eff: "self" }, mapMode: { mode } })); return m; };
  for (const mode of ["self", "economy"]) assert.ok(/의미 보강 결과의 충돌·해소 판정\(필요할 때\)/.test(use(mode).scUse.textContent), mode);
  for (const mode of ["precision", "auto"]) { const t9 = use(mode).scUse.textContent; assert.ok(/의미 보강$/.test(t9) && !/해소 판정/.test(t9), mode + " " + t9); }
  assert.ok(/의미 보강$/.test(use("economy").dsUse.textContent) && /지금 쓰는 곳: 없음/.test(use("self").dsUse.textContent));
});

t("개요 '수칙 흐름' — 제안함 칸에 옛 '훅 K회마다' 설명 없음·들어오는 곳 표시 · 정리 담당 칸 첫 두 줄=누가(별도 1회 실행·회사·모델·출처)·언제(실제 계기)", () => {
  const cells = {}; ["rfCore", "rfArchive", "rfProposals", "rfCurator", "ovRulesFlow"].forEach((id) => { const c = mkEl("div"); const body = mkEl("div"); c.querySelector = () => body; c.body = body; cells[id] = c; });
  const api = rfApi((id) => cells[id] || null);
  const d = baseD({ mode: "claude-codex", track: 2, impl: "self", curator: { arm: "self", source: "mode" } });
  d.rulesFlow.core = { st: "absent", count: {}, injectedChars: 0 }; d.rulesFlow.archive = { state: "none" };
  d.rulesFlow.curator = { lastTs: "", running: false, metrics: { adoptRate: 0, proposedTotal: 0, adopted: 0, declined: 0, archiveSize: 0, selOverCount: 0, unusedCount: 0 }, lastItems: [] };
  api.renderRulesFlow(d);
  const pr = textOf(cells.rfProposals.body), cu = cells.rfCurator.body.kids.map(textOf);
  assert.ok(!/훅/.test(pr) && /들어오는 곳: 사용자 말/.test(pr) && /👤 사용자 도장만/.test(pr), pr);
  assert.ok(/^⚙ 별도 1회 실행 · Claude · Claude Code 기본 모델 — 운용 모드\(클로드-코덱스\)를 따름 · 고를 수 없음$/.test(cu[0]), cu[0]);
  assert.ok(/^언제 도나: 검증 묶음 마감 2\/10회 · /.test(cu[1]) && /아직 검사 없음$/.test(cu[1]), cu[1]);
  assert.ok(/신호가 없으면 부르지 않아요/.test(cu[2]) && !/비용 없음/.test(cu.join("|")), "옛 '(비용 없음)' 제거 — 정리 담당은 호출이 있음 " + cu[2]);
});

// ── ③ 2트랙 잔류 결함 — 3트랙 카드 조각(연결 상태 줄·탐색 담당·의미 보강 줄) 실행 ──
const mk = OUT.indexOf("// [2026-10-18 2트랙 잔류 결함]");
assert.ok(mk > 0, "결함 표식");
const iifeBeg = OUT.lastIndexOf("(function(){", mk), iifeEnd = OUT.indexOf("// P9 — 정책 충돌은", mk);
const iife = OUT.slice(iifeBeg, iifeEnd);
function runTrackCard(on, d) {
  const { m, $ } = domWith(["scoutApiLine", "scoutArmRow", "mapModeRow"]);
  ["scoutApiLine", "scoutArmRow", "mapModeRow"].forEach((id) => { m[id].style.display = ""; }); // 3트랙에서 보이던 상태
  new Function("$", "on", "d", "safe", "T", "document", "UI_EN", "armText", "scoutName", "vscode", iife)($, on, d, (f) => f(), T, document, false, () => "기본 정찰(Claude)", () => "기본 정찰", { postMessage() {} });
  return m;
}
t("3트랙에서 보이던 화면을 2트랙으로 저장 — 연결 상태 줄·탐색 담당 줄·의미 보강 줄이 모두 숨음(옛 결함: 두 담당 줄이 남음)", () => {
  const m = runTrackCard(false, { scoutArm: { raw: "codex", eff: "codex", hasKey: false }, mapMode: { mode: "precision", raw: "precision" }, deepseek: { hasKey: false } });
  assert.deepStrictEqual([m.scoutApiLine.style.display, m.scoutArmRow.style.display, m.mapModeRow.style.display], ["none", "none", "none"]);
});
t("3트랙 켜짐·담당 자료 없음 — 연결 상태 줄은 보이고 두 담당 줄은 숨음(각 줄이 자기 조건만 본다)", () => {
  const m = runTrackCard(true, { scoutArm: null, mapMode: null, deepseek: { hasKey: false } });
  assert.deepStrictEqual([m.scoutApiLine.style.display, m.scoutArmRow.style.display, m.mapModeRow.style.display], ["", "none", "none"]);
});

// ── ② 사용자 말 카드·수칙서 카드 표식 — 실제 조각 실행 ──
t("사용자 말 카드 — 긴 설명 대신 흐름 표식(언제·분류=별도 1회 실행·회사·모델·거름=구현 대화·결정=사용자) · 일하는 방식 안내 한 줄", () => {
  const blk = between(OUT, 'safe(function(){ var uc=$("uwCard")', 'safe(function(){ var n=$("vBudgetNote")');
  const { m, $ } = domWith(["uwCard"]);
  const d = baseD({ mode: "codex-codex", track: 2, impl: "codex", curator: { arm: "codex", source: "mode" } });
  d.userWords = { held: [], summary: { queued: 2, lastTs: "2026-10-18T01:00:00.000Z", lastOutcome: "results" }, results: { boundary: [], emphasis: [], style: [] }, wsKey: "w" };
  new Function("$", "d", "T", "document", "vscode", "safe", require("./_rf-prelude.js").RFP + blk)($, d, T, document, { postMessage() {} }, (f) => f());
  const txt = textOf(m.uwCard);
  assert.strictEqual(m.uwCard.style.display, "block");
  assert.ok(/분류 ⚙ 별도 1회 실행 · 말이 나온 대화와 같은 회사\(Claude → Claude Code 기본 모델 · Codex → gpt-x · high\)/.test(txt) && /거름 🧑 구현 대화가 올림\/안 올림/.test(txt) && /결정 👤 위 '수칙' 카드에서 승인/.test(txt) && /언제 검증 묶음이 끝날 때/.test(txt), txt);
  assert.ok(!/독립 분류 담당이 살펴보고/.test(txt) && /일하는 방식에 관한 말은 아래에 알리기만/.test(txt) && /성격만 나눠요/.test(txt) && /구현 담당 규칙 칸에 직접/.test(txt), "옛 긴 문장 제거·한 줄 유지");
});
t("수칙서 카드 — 머리 아래 '판정 🔍 검증 대화 · 바꾸기 👤 사용자 도장만 · 구현 대화엔 알림으로'", () => {
  const blk = between(OUT, 'safe(function(){ var ec=$("envCard")', 'safe(function(){ var uc=$("uwCard")');
  const { m, $ } = domWith(["envCard"]);
  const api = rfApi($);
  const d = { envelope: { label: "승인된 수칙서 사용 중", tone: "ok" }, lang: "ko" };
  new Function("$", "d", "T", "document", "vscode", "rfMarks", "wbGen", "wbAdds", "wbRemoves", "gotoEl", "safe", blk + "\n;")($, d, T, document, { postMessage() {} }, api.rfMarks, null, new Set(), new Set(), () => {}, (f) => f());
  const txt = textOf(m.envCard);
  assert.ok(/판정 🔍 검증 대화/.test(txt) && /바꾸기 👤 사용자 도장만/.test(txt) && /구현 대화엔 알림으로/.test(txt), txt);
});

// ── ⑤ 수칙 흐름 안내 새탭 — 실제 함수 실행(호출 없음·스크립트 없음·동적 값 이스케이프) ──
const guideSrc = between(OUT, "function openRulesFlowGuide() {", "\nfunction ");
function openGuide(rfOut) {
  let panel = null, opts = null;
  const vscode = { ViewColumn: { Beside: 2 }, window: { createWebviewPanel: (id, title, col, o) => { opts = o; panel = { title, webview: {} }; return panel; } } };
  const req = () => ({ rulesFlowFor: () => { if (rfOut instanceof Error) throw rfOut; return rfOut; } });
  new Function("vscode", "tE", "loadLangExt", "require", "path", "BRIDGE_DIR", "dashboardWorkspace", "readScoutCodexPrefsExt", "readDeepseekView", guideSrc + "\nopenRulesFlowGuide();")(
    vscode, (ko) => ko, () => "ko", req, path, "/tmp/bridge", () => "D:/w", () => ({ model: "gpt<x>", reasoning: "high" }), () => ({ hasKey: false, masked: "", model: "deepseek-v4-flash" }));
  return { html: panel.webview.html, opts };
}
t("안내 새탭 — 지금 이 프로젝트(2트랙·코덱스-코덱스·정리 담당 Codex·운용 모드를 따름) · 계기 숫자=브릿지 자료 · 모델명 이스케이프 · 스크립트 없음", () => {
  const { html, opts } = openGuide({ helpers: { mode: "codex-codex", track: 2, impl: "codex", curator: { arm: "codex", source: "mode" } }, proposals: { nextCheck: nc0 } });
  assert.strictEqual(opts.enableScripts, false);
  assert.ok(!/<script/i.test(html) && /default-src 'none'/.test(html));
  assert.ok(/2트랙 · 코덱스-코덱스/.test(html) && /정리 담당 = <b>Codex<\/b>\(gpt&lt;x&gt; · high · 운용 모드를 따름 · 고를 수 없음\)/.test(html), "지금 이 프로젝트 줄");
  assert.ok(!html.includes("gpt<x>"), "동적 값 이스케이프");
  assert.ok(/사용자 말 분류 = <b>말이 나온 대화의 회사<\/b> · 서고 선별 = <b>그 차례 구현 담당의 회사<\/b>\(이 모드의 구현 담당 = Codex · Claude → Claude Code 기본 모델 · Codex → gpt&lt;x&gt; · high\)/.test(html), "분류·선별=규칙(단정 없음 — 1판 blocker)");
  assert.ok(/어느 방식이든 결과가 부딪치거나 판정이 필요하면 Codex 가 해소 판정/.test(html), "해소 판정(1판 blocker)");
  assert.ok(/검증 묶음 마감 10회\(지금 2회\)/.test(html) && /같은 결함 지적이 3회차까지/.test(html) && /정상 범위를 3번 넘음/.test(html), "계기 숫자");
  assert.ok(/판단하는 곳은 네 군데/.test(html) && /2트랙과 3트랙 — 무엇이 달라지나/.test(html) && /운용 모드의 구현 담당 회사 · 고를 수 없음/.test(html), "네 곳·트랙 차이 표");
});
t("안내 새탭 — 브릿지 판독 실패면 회사를 지어내지 않고 '읽지 못했어요' · 계기는 숫자 없는 일반 문장", () => {
  const { html } = openGuide(new Error("boom"));
  assert.ok(/지금 이 프로젝트의 회사·모델을 읽지 못했어요/.test(html) && /장부 신호\(검증 묶음 마감 누계/.test(html));
});

// ── 구조 — 화면 요소·배선·문구 ──
t("한눈에 보기: 줄 머리표(구현·검증/수칙=2·3트랙 공통 · 정찰=3트랙만) · 수칙 줄 요소 · 새탭 버튼 배선 · 고급설정 제목·쓰는 곳 줄", () => {
  assert.ok(SRC.includes('<div class="rfmap" id="rulesMap">') && MAP_IDS.filter((id) => !["scUse", "dsUse"].includes(id)).every((id) => SRC.includes('id="' + id + '"')), "수칙 줄 요소");
  assert.ok((SRC.match(/t\("2·3트랙 공통", "2- and 3-track"\)/g) || []).length === 2 && SRC.includes('t("3트랙만", "3-track only")'), "머리표");
  assert.ok(SRC.includes('vscode.postMessage({type:"openRulesFlowGuide"})') && SRC.includes('if (m?.type === "openRulesFlowGuide") openRulesFlowGuide();'), "새탭 배선");
  assert.ok(!SRC.includes("정찰(3트랙) 고급 단계용") && SRC.includes('id="scUse"') && SRC.includes('id="dsUse"'), "고급설정 제목·쓰는 곳 줄");
  assert.ok(SRC.includes("safe(function(){ renderRulesMap(d); });"), "렌더 배선");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
