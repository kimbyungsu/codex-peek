"use strict";
/*
 * [HARNESS-REALIGNMENT §7 4-2b — 2026-09-02] P9 설계 경위 등재 · 대시보드 '지금 정할 것' 결정 장부 합류(+카드) · 서고 카드 초과 표기.
 * 계약: DECISIONS.md 13항이 파서를 통과하고 why 매처가 찾는다 · 상태 decisions(open+렌더 블록)·개요 합산에 결정 장부 항목 · attach 장부 행의 selOver가
 * 수칙 카드 정보 줄로(정보 — 경보 아님) · 카드는 읽기 전용(답은 CLI).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "p42b-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const MP = require("../bridge/map-provenance.js");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NEW_IDS = ["D-2026-07-22-open-search-bounded-blocker", "D-2026-07-24-cap-rulebook-candidates", "D-2026-07-24-plain-language-choices", "D-2026-08-29-rulebook-is-boundary",
  "D-2026-08-29-rebuttal-oos-only", "D-2026-08-29-curation-independent", "D-2026-08-29-defaults-close-decisions", "D-2026-08-30-decision-ledger",
  "D-2026-08-30-report-three-sections", "D-2026-08-30-once-per-session-directives", "D-2026-08-31-rules-all-included", "D-2026-09-01-anchor-guards", "D-2026-09-01-round-count-ledger"];

t("P9 — 결정 색인에 문서 3편의 13항이 원자 항목으로 등재·파서 통과(거부 0)·결정/정본/찾는말 전부 채움", () => {
  const idx = MP.parseDecisionsIndex(ROOT);
  assert.ok(idx.ok, "index parses");
  assert.deepStrictEqual(idx.rejected, [], "no protocol-vocab rejection");
  const byId = new Map(idx.entries.map((e) => [e.id, e]));
  for (const id of NEW_IDS) {
    const e = byId.get(id);
    assert.ok(e, "missing " + id);
    assert.ok(e.decision.length > 80 && e.source.length > 10 && e.keywords.length >= 5 && e.title.length > 10, id + " fields");
    assert.ok(/docs\/(VERIFY-GOVERNANCE|REJUDGE-AUTHORITY-DESIGN|HARNESS-REALIGNMENT-2026-08-29)\.md/.test(e.source), id + " source points at one of the three docs");
  }
  // [1회차 blocker] 문체 계약 — 코드 식별자·명령·플래그·파일명은 '정본' 줄에만(다른 줄엔 백틱·플래그·파일 확장자·camelCase 호출 금지)
  const raw = fs.readFileSync(path.join(ROOT, "docs", "DECISIONS.md"), "utf8");
  for (const id of NEW_IDS) {
    const at = raw.indexOf("## " + id); assert.ok(at > 0, id);
    const next = raw.indexOf("\n## ", at + 3); const block = raw.slice(at, next > 0 ? next : raw.length);
    const lines = block.split("\n").filter((l) => !/^- 정본:/.test(l));
    for (const l of lines) assert.ok(!/`|--[a-z]|[A-Za-z0-9_-]+\.(js|ts|md)\b|\b[a-z]+[A-Z][A-Za-z]*\(|\bdecisions (choose|delegate)\b/.test(l), id + " code token outside 정본: " + l);
  }
});

t("P9 — why 매처가 경위 질문으로 새 항목을 찾는다(규약 1회 전달·되받아침·회차 손셈·앵커 이탈)", () => {
  const idx = MP.parseDecisionsIndex(ROOT);
  const top = (q) => { const m = MP.matchDecisions(idx.entries, q, []); const first = Array.isArray(m) && m.length ? m[0] : null; return first ? String(first.id || (first.entry && first.entry.id) || JSON.stringify(first)) : ""; };
  assert.ok(top("왜 규약 전달을 세션에 한 번만 하나 세대").includes("once-per-session-directives"), top("왜 규약 전달을 세션에 한 번만 하나 세대"));
  assert.ok(top("되받아침 제외 칸 번호 반증 재소환").includes("rebuttal-oos-only"));
  assert.ok(top("회차 손셈 장부 5/5 마감문 거부").includes("round-count-ledger"));
  assert.ok(top("이 대화의 폴더 앵커 이탈 기본값 고지").includes("anchor-guards"));
});

t("대시보드 상태 — decisions(open+렌더 블록)·usedMemory.selOver 배선(소스 계약)", () => {
  assert.ok(ext.includes("decisions: { open: number; items: Array<{ id: string; question: string; kind: string; origin: string; ts: string; block: string }> } | null;"), "state type");
  assert.ok(ext.includes("typeof lib.readDecisions !== \"function\") return null;") && ext.includes("lib.renderDecisionBlock(x, en)") && ext.includes("return { open: open.length, items };"), "computeState decisions block");
  const dcBeg = ext.indexOf("decisions: (() => {"); const dcEnd = ext.indexOf("uiTheme: loadUiTheme(),", dcBeg);
  assert.ok(dcBeg > 0 && dcEnd > dcBeg && !/\.slice\(0, \d+\)/.test(ext.slice(dcBeg, dcEnd)) && ext.slice(dcBeg, dcEnd).includes("const items = open.map("), "no silent truncation — every open decision reaches the card (1회차 blocker)");
  assert.ok(ext.includes("selOver: j.selOver && typeof j.selOver === \"object\" ? { count: Number(j.selOver.count || 0), bytesTotal: Number(j.selOver.bytesTotal || 0), itemsMax: Number(j.selOver.itemsMax || 0), bytesMax: Number(j.selOver.bytesMax || 0) } : null"), "usedMemory.selOver from attach row");
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes("itemsMax: SELECTOR_UNION_MAX, bytesMax: SELECTOR_UNION_BYTES_MAX }") && cb.includes("...(so9 ? { selOver: so9 } : {}) });"), "bridge writes selOver into the attach row only when over");
});

t("개요 합산 — 결정 장부 열린 항목이 '지금 정할 것'에 합류(순수 함수 실행 반례)·없으면 0·다른 항목 무회귀", () => {
  const b3 = outSrc.indexOf("function decideActs(d){");
  const e3 = outSrc.indexOf("function renderOverview(d){", b3);
  assert.ok(b3 > 0 && e3 > b3, "compiled decideActs extractable");
  const acts = new Function("var T=function(a,b){return a;};\n" + outSrc.slice(b3, e3) + "\nreturn decideActs;")();
  const sum = (d) => acts(d).reduce((s, a) => s + a.n, 0);
  assert.strictEqual(sum({ decisions: { open: 2, items: [] } }), 2, "two open decisions → 2");
  assert.strictEqual(sum({ decisions: { open: 0, items: [] } }), 0);
  assert.strictEqual(sum({ decisions: null }), 0);
  assert.strictEqual(sum({}), 0, "no decisions field → no regression");
  const a = acts({ decisions: { open: 1, items: [] } })[0];
  assert.ok(a.tab === "verify" && a.el === "#decisionsSec" && /결정 장부/.test(a.label), JSON.stringify(a));
  assert.strictEqual(sum({ decisions: { open: 1, items: [] }, integrity: [{ ack: false, kind: "bridge-drift" }] }), 2, "coexists with alerts (no double count)");
});

t("카드 — #decisionsSec 읽기 전용(답은 CLI 안내)·빈 장부는 '비어 있음'·null만 숨김 · 수칙 카드 초과 정보 줄(경보 아님·전량 동봉 명시)", () => {
  assert.ok(/<details id="decisionsSec" class="backlog-fold" style="display:none">/.test(ext) && /id="dcSummary"/.test(ext) && /id="dcList"/.test(ext), "card markup");
  assert.ok(ext.includes("답하기</b> 줄 명령으로 고르거나 '네가 정해라'로 넘기면") && !/decisionsChoose|decisionChoose|postMessage\(\{type:"decision/.test(ext), "read-only: no choose button/message channel");
  const rBeg = ext.indexOf('const sec=$("decisionsSec")'); const rEnd = ext.indexOf("// P-12 v2.4: 보관함 카드", rBeg);
  assert.ok(rBeg > 0 && rEnd > rBeg, "renderer block");
  const blk = ext.slice(rBeg, rEnd);
  assert.ok(blk.includes('if(!dc){ sec.style.display="none"; return; }') && blk.includes("비어 있음 — 구현자가 못 정하는 것이 생기면") && blk.includes("pre.textContent=it.block||\"\"") && !/innerHTML/.test(blk), "renderer: null hides, empty shows, textContent only");
  assert.ok(ext.includes("if(d.usedMemory&&d.usedMemory.selOver){") && ext.includes("전량 동봉(누락 없음) · 서고 정리 권장") && ext.includes("all included · consider tidying the archive"), "archive card over-limit info line (ko/en)");
  const s = ext.slice(ext.indexOf("if(d.usedMemory&&d.usedMemory.selOver){"), ext.indexOf("if(d.usedMemory&&d.usedMemory.selOver){") + 700);
  assert.ok(/editorWarning-foreground/.test(s) && !/appendIntegrityEvent|integrity\.push/.test(s), "info styling, not an alert");
});

t("결정 장부 실데이터 — openDecision → readDecisions.open 1 → 렌더 블록에 답하기 명령(대시보드 상태 계산과 같은 경로)", () => {
  const ws = path.join(HOME, "ws"); fs.mkdirSync(ws, { recursive: true });
  const r = CL.openDecision(ws, { origin: "implementer", kind: "product", campaignId: "c1", sourceAsk: "", targetFp: "", question: "저장 방식을 바꿀까요?", why: "재진입 시 값이 사라짐", noDefault: "제품 방향이라 구현자가 대신 정할 수 없음", choices: [{ key: "keep", label: "유지", ifChosen: "그대로" }, { key: "persist", label: "영속", ifChosen: "다음 검증에서 확인" }], recommend: "persist" });
  assert.ok(r && r.ok !== false && r.decisionId, JSON.stringify(r));
  const rd = CL.readDecisions(ws);
  assert.strictEqual(rd.open.length, 1);
  const block = CL.renderDecisionBlock(rd.open[0], false);
  assert.ok(block.includes(r.decisionId) && /decisions choose/.test(block) && /저장 방식을 바꿀까요/.test(block), block);
  for (let i = 0; i < 32; i++) CL.openDecision(ws, { origin: "implementer", kind: "product", campaignId: "c1", sourceAsk: "", targetFp: "", question: "질문 " + i + "번째를 어떻게 할까요?", why: "이유", noDefault: "구현자가 정할 수 없는 제품 방향", choices: [{ key: "a", label: "가", ifChosen: "x" }, { key: "b", label: "나", ifChosen: "y" }], recommend: "a" });
  assert.strictEqual(CL.readDecisions(ws).open.length, 33, "33 open decisions in the ledger (no ledger cap) — the dashboard state must carry all of them");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
