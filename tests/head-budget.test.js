"use strict";
/*
 * [HARNESS-REALIGNMENT §7 3-2a · 개선 4 (a)(b)(c) + §4-B ④ — 2026-08-31] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 총량=조각 상한의 합(파생·마법 숫자 없음) · 절단은 참고 자료만·순서 고정(경위→지도→결합→정찰)·권위 자료 절단 0 ·
 * 열린 지적은 예산 밖·캠페인 유계(판당 행 상한=서식 손상 재발급) · 서고 선별 12항/4,000바이트 초과=실패 아님·전량 동봉+정보 행+참고 예산 차감 ·
 * 제외 칸 본문만 파일 참조(제목 60자 인라인·전제·절대 차단 전문) · 지도 씨앗은 요청문 [직접 범위] 절에 결속(절 없음=종전).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NL = String.fromCharCode(10);

t("(c) 파생 총량 — HEAD_BUDGET 합=headBudgetTotal · 계약 상한은 같은 출처(CONTRACT_INJ_MAX) · 참고 예산=조각 합", () => {
  const sum = Object.values(CL.HEAD_BUDGET).reduce((a, v) => a + v, 0);
  assert.strictEqual(CL.headBudgetTotal(), sum);
  assert.strictEqual(CL.HEAD_BUDGET.reference, CL.REF_ORDER.reduce((a, k) => a + CL.REF_BUDGET[k], 0));
  assert.deepStrictEqual(CL.REF_ORDER, ["provenance", "map", "coupling", "scout"]);
  assert.deepStrictEqual(CL.REF_BUDGET, { provenance: 300, map: 1500, coupling: 400, scout: 200 });
  assert.strictEqual(CL.HEAD_BUDGET.envelope, 3 * 12 * 200 + 600);
  assert.strictEqual(CL.HEAD_BUDGET.fixedProse, 5200, "fixed prose = max over languages of the verifier-head caps (en 3500+1250+450)");
  assert.deepStrictEqual(CL.FIXED_PROSE_CAPS, { canonPlusFormat: { ko: 1720, en: 3500 }, v2Fixed: { ko: 700, en: 1250 }, baseQual: { ko: 250, en: 450 } });
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(src.includes("const CONTRACT_INJ_MAX = HEAD_BUDGET.contract;") && src.includes("const HEAD_SOFT_LIMIT = headBudgetTotal();"), "no magic totals in the bridge");
  assert.ok(!src.includes("HEAD_SOFT_LIMIT = 12000"), "old literal gone");
});

t("(c) 참고 자료 예산 — 조각별 상한·초과=절단+고지(참고용)·순서 고정·권위 자료는 이 함수를 거치지 않음", () => {
  const big = (k, n9) => (k + " ").repeat(Math.ceil(n9 / (k.length + 1))).slice(0, n9);
  const parts = { provenance: big("경위", 900), map: big("지도", 4000), coupling: big("결합", 100), scout: big("정찰", 500) };
  const r = CL.applyReferenceBudgets(parts, "ko");
  assert.deepStrictEqual(r.clipped.map((c) => [c.part, c.from, c.to]), [["provenance", 900, 300], ["map", 4000, 1500], ["scout", 500, 200]]);
  assert.ok(r.text.includes("(설계 경위 참고 자료 예산으로 절단: 900 → 300자 — 참고용)") && r.text.includes("(지도 조각 참고 자료 예산으로 절단: 4000 → 1500자 — 참고용)") && r.text.includes("(정찰 신호 참고 자료 예산으로 절단: 500 → 200자 — 참고용)"), r.text.slice(-300));
  assert.ok(r.text.indexOf("경위") < r.text.indexOf("지도") && r.text.indexOf("지도") < r.text.indexOf("결합") && r.text.indexOf("결합 ") < r.text.indexOf("정찰"), "fixed order");
  assert.ok(r.text.length <= CL.HEAD_BUDGET.reference, "total within the reference budget — notices and separators live INSIDE the cap sum");
  const pieces = CL.applyReferenceBudgets({ map: big("지도", 4000) }, "ko");
  assert.ok(pieces.text.length <= CL.REF_BUDGET.map && pieces.text.endsWith("— 참고용)"), "clipped piece incl. notice ≤ its cap (" + pieces.text.length + ")");
  const piecesEn = CL.applyReferenceBudgets({ provenance: big("hist", 2000) }, "en");
  assert.ok(piecesEn.text.length <= CL.REF_BUDGET.provenance && piecesEn.text.includes("advisory only)"));
  // 선별 초과분 차감: 경위 예산부터 순서대로 줄어든다
  const r2 = CL.applyReferenceBudgets({ provenance: big("경위", 250), map: big("지도", 1400) }, "ko", { shrinkBytes: 500 });
  assert.deepStrictEqual(r2.caps, { provenance: 0, map: 1300, coupling: 400, scout: 200 });
  assert.deepStrictEqual(r2.clipped.map((c) => [c.part, !!c.omitted]), [["provenance", true], ["map", false]]);
  assert.ok(r2.text.length <= 1300 + 400 + 200, "total ≤ remaining caps");
  // [확인 검증 2회차 blocker②] 극단: 차감이 상한 전부를 먹으면 출력 0 · 10자만 남으면 짧은 표지만 · 차감 없이 네 조각 만재면 개행 포함 ≤ 2,400
  const four = { provenance: big("경위", 900), map: big("지도", 4000), coupling: big("결합", 900), scout: big("정찰", 900) };
  assert.strictEqual(CL.applyReferenceBudgets(four, "ko", { shrinkBytes: 2400 }).text, "");
  assert.deepStrictEqual(CL.applyReferenceBudgets(four, "ko", { shrinkBytes: 2400 }).clipped.map((c) => c.omitted), [true, true, true, true]);
  const ten = CL.applyReferenceBudgets(four, "ko", { shrinkBytes: 2390 });
  assert.ok(ten.text.length <= 10 && ten.text.length > 0, "tiny remaining budget → short marker only (" + ten.text.length + ")");
  const full4 = CL.applyReferenceBudgets(four, "ko");
  assert.ok(full4.text.length <= CL.HEAD_BUDGET.reference, "four oversized pieces incl. separators ≤ 2,400 (" + full4.text.length + ")");
  assert.ok(full4.text.split(NL).filter((l) => l.includes("참고 자료 예산으로 절단")).length === 4, "each clipped piece still announces its clipping");
  const en4 = CL.applyReferenceBudgets(four, "en");
  assert.ok(en4.text.length <= CL.HEAD_BUDGET.reference && en4.text.includes("advisory only)"));
  // legacy(조각 분리 불가)=합계 상한 1개
  const r3 = CL.applyReferenceBudgets({ map: big("옛", 5000) }, "ko", { singleCap: true });
  assert.deepStrictEqual(r3.clipped, [{ part: "legacy", from: 5000, to: CL.HEAD_BUDGET.reference }]);
  assert.ok(r3.text.length <= CL.HEAD_BUDGET.reference, "legacy clipped incl. notice ≤ total reference cap");
  assert.strictEqual(CL.applyReferenceBudgets({ map: "짧다" }, "en").text, "짧다");
});

t("(b) 요청문 [직접 범위] 절 본문 추출 — 절이 있으면 그 본문만·없으면 빈 문자열(호출자가 전체로 폴백) · map-reader가 이 절에 씨앗 결속", () => {
  const req = ["[구현 검증 요청]", "목표: 잠금 경합 봉합", "[직접 범위] bridge/contract-lib.js", "  tests/head-budget.test.js 도", "[제외 범위] docs/*.md", "본문 뒤 문장"].join(NL);
  assert.strictEqual(CL.askSectionBody(req, "scope"), "bridge/contract-lib.js" + NL + "  tests/head-budget.test.js 도");
  assert.strictEqual(CL.askSectionBody(req, "exclusions"), "docs/*.md" + NL + "본문 뒤 문장");
  assert.strictEqual(CL.askSectionBody("자유 문장 bridge/x.js 만", "scope"), null, "absent section = null (caller falls back to the whole request)");
  assert.strictEqual(CL.askSectionBody(req, "acceptance"), null);
  // [확인 검증 blocker②] 임의의 대괄호/마크다운 제목도 절의 끝 · 빈 직접 범위=""(전체로 폴백하지 않음)
  const req2 = ["[직접 범위] bridge/a.js", "[형식 주의] tests/not-scope.js", "[고지] docs/not-scope.md"].join(NL);
  assert.strictEqual(CL.askSectionBody(req2, "scope"), "bridge/a.js");
  const req3 = ["[직접 범위]", "## 참고", "docs/x.md"].join(NL);
  assert.strictEqual(CL.askSectionBody(req3, "scope"), "");
  const req4 = ["[직접 범위]", "[제외 범위] docs/*.md"].join(NL);
  assert.strictEqual(CL.askSectionBody(req4, "scope"), "", "empty scope stays empty (seeds 0 → map omitted)");
  // [확인 검증 2회차 blocker①] 대괄호가 제목이 아닌 정당한 본문 줄(색인·경로·마크다운 링크)은 절 안에 남는다
  const req5 = ["[직접 범위]", "[0] bridge/a.js", "[src/a.js]", "[bridge/a.js](설명)", "[1.2] tests/x.test.js", "[Note] 여기서 끝"].join(NL);
  assert.strictEqual(CL.askSectionBody(req5, "scope"), "[0] bridge/a.js" + NL + "[src/a.js]" + NL + "[bridge/a.js](설명)" + NL + "[1.2] tests/x.test.js", "index/path/link brackets are body; a title-word bracket ends the section");
  assert.ok(!CL.GENERIC_HEAD_RE.test("[0] bridge/a.js") && !CL.GENERIC_HEAD_RE.test("[src/a.js]") && !CL.GENERIC_HEAD_RE.test("[bridge/a.js](설명)") && CL.GENERIC_HEAD_RE.test("[형식 주의] x") && CL.GENERIC_HEAD_RE.test("## 참고") && CL.GENERIC_HEAD_RE.test("[Out of scope]"));
  // [확인 검증 3회차] 허용 문자 양성 열거 — 배열/코드/식별자 표기 대괄호([foo, bar]·[foo:bar]·[foo_bar]·[a|b]·[k=v]·["q"])는 전부 본문
  const req6 = ["[직접 범위]", "[foo, bar] 를 고치고", "[foo:bar] 키", "[foo_bar] 식별자", "[a|b] 분기", "[k=v] 설정", "[\"quoted\"] 문자열", "[Note] 끝"].join(NL);
  assert.strictEqual(CL.askSectionBody(req6, "scope"), ["[foo, bar] 를 고치고", "[foo:bar] 키", "[foo_bar] 식별자", "[a|b] 분기", "[k=v] 설정", "[\"quoted\"] 문자열"].join(NL), "array/code-shaped brackets stay in the body");
  for (const s of ["[foo, bar] x", "[foo:bar]", "[foo_bar]", "[a;b]", "[1차 지적] x", "[v2]"]) assert.ok(!CL.GENERIC_HEAD_RE.test(s), "not a heading: " + s);
  for (const s of ["[Goal]", "[제외 범위]", "[Re-judgment notes]", "[검증 기본 원칙 · 핵심]", "# 제목"]) assert.ok(CL.GENERIC_HEAD_RE.test(s), "heading: " + s);
  const mr = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-reader.js"), "utf8");
  assert.ok(mr.includes('CL.askSectionBody(reqText, "scope")') && mr.includes("MR.extractSeeds(seedText)") && mr.includes("const seedText = scopeBody9 === null ? reqText : scopeBody9;"), "seeds come from the scope section when present; empty section does NOT fall back to the whole request");
  assert.ok(mr.includes('withParts({ text, mapItems: top, couplings }, { map: mapText, coupling: coupling.text || "", scout: health || "" })') && mr.includes("{ provenance: prov.text, ...(r.parts || { map: r.text }) }"), "attachment parts split for budgets (text unchanged)");
  assert.ok(mr.includes('Object.defineProperty(env, "parts", { value: parts, enumerable: false'), "parts is non-enumerable — envelope shape {text,mapItems,couplings} unchanged");
});

t("④ 열린 지적 캠페인 유계 — 판당 행 상한 초과=서식 손상(too-many-rows)·전체 불신(재발급) · 상한 이내=정상", () => {
  const rows = (k) => Array.from({ length: k }, (_, i) => JSON.stringify({ tag: "보완", title: "항목 " + i }));
  const okB = CL.parseFindingsBlock(["[지적 목록 v2]", ...rows(CL.FINDINGS_ROWS_MAX), "[지적 목록 끝]", "검증: 통과(보완)"].join(NL));
  assert.strictEqual(okB.ok, true); assert.strictEqual(okB.findings.length, CL.FINDINGS_ROWS_MAX);
  const bad = CL.parseFindingsBlock(["[지적 목록 v2]", ...rows(CL.FINDINGS_ROWS_MAX + 1), "[지적 목록 끝]", "검증: 통과(보완)"].join(NL));
  assert.strictEqual(bad.ok, false); assert.strictEqual(bad.findings.length, 0);
  assert.deepStrictEqual(bad.corrupt.items[0], { lineNo: 1, reasonKey: "too-many-rows" });
  assert.strictEqual(CL.FINDINGS_ROWS_MAX, 40);
  // [확인 검증 blocker④] 사유가 기계 판정·안내까지 전달된다: judgeMachineVerdict 고유 키 + 사유 문장(상한·분할 안내) + 서식 안내에 상한 명시
  const mv = CL.judgeMachineVerdict("pass-notes", bad);
  assert.strictEqual(mv.effective, "inconclusive"); assert.strictEqual(mv.reasonKey, "too-many-rows");
  assert.ok(CL.machineReasonText(mv, false).includes("판당 행 상한(40)") && CL.machineReasonText(mv, false).includes("40행 이하로 나눠 다시 제출"), CL.machineReasonText(mv, false));
  assert.ok(CL.machineReasonText(mv, true).includes("at most 40 rows"));
  assert.ok(CB.v2StaticDirective("ko").includes("한 판 최대 40행") && CB.v2StaticDirective("en").includes("at most 40 rows per round"), "static directive states the cap up front");
  const mvC = CL.judgeMachineVerdict("pass-notes", CL.parseFindingsBlock(["[지적 목록 v2]", "{broken", "[지적 목록 끝]", "검증: 통과(보완)"].join(NL)));
  assert.strictEqual(mvC.reasonKey, "block-corrupt", "other corruption keeps the generic key");
});

t("④ 서고 선별 초과=실패 아님 — worker·브릿지 모두 전량 동봉+정보 행(정직 표기) · 참고 예산 차감 배선", () => {
  const worker = fs.readFileSync(path.join(__dirname, "..", "bridge", "ask-job-worker.js"), "utf8");
  assert.ok(!worker.includes("selector union over cap") && worker.includes("above the normal range") && worker.includes('selectorOutcome: "selector-union"'), "worker no longer fails the job on overflow");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(!src.includes('failSel(en9 ? "the selection exceeds the injection caps"'), "bridge no longer aborts on selection caps");
  assert.ok(src.includes("out9.selOver = { items: shown9.length > SELECTOR_UNION_MAX") && src.includes('const selBytes9 = shown9.reduce((a, t) => a + Buffer.byteLength(String(t), "utf8"), 0);') && src.includes("전량 동봉 — 누락 없음") && src.includes("shrinkBytes: carrier.selOver ? carrier.selOver.excessBytes : 0"), "over flags computed from the texts actually injected (en=translation) → info row + reference budget shrink");
  assert.ok(src.includes("[서고 수칙] 관련 수칙 ${attCarrier.selOver.count}항") , "verdict-side info row (not an alert)");
});

t("(a) 제외 칸 본문 참조 — 60자 초과 항목만 제목+참조, 짧은 항목·전제·절대 차단은 전문 그대로", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hb-repo-"));
  const long = "서버 두 대에 동시 배포하면서 같은 장부 파일을 두 프로세스가 번갈아 쓰는 경우(운영 배포 파이프라인 병렬 실행)".slice(0, 120);
  assert.ok(long.length > CL.ENVELOPE_OOS_TITLE_MAX);
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: [long], alwaysBlocker: [long], outOfScope: [long, "짧은 제외"] }));
  const sha = CL.readVerifyEnvelope(repo).sha1;
  const inj = CL.envelopeInjectionFor(repo, sha, "ko");
  assert.ok(inj.text.includes("> sup-1: " + long) && inj.text.includes("> ab-1: " + long), "premise/blocker full text kept");
  const absRef = path.resolve(repo, "verify-envelope.json");
  assert.ok(inj.text.includes("> oos-1: " + long.slice(0, 60) + "… — 본문: " + absRef + " outOfScope[0]"), "reference is the TARGET repo's absolute path (verifier cwd may differ): " + inj.text.split(NL).find((l) => l.startsWith("> oos-1")));
  assert.ok(inj.text.includes("> oos-2: 짧은 제외") && !inj.text.includes("outOfScope[1]"), "short item unchanged");
  const en = CL.envelopeInjectionFor(repo, sha, "en");
  assert.ok(en.text.includes("full text: " + absRef + " outOfScope[0]"));
});

t("(c) 구성 시험 — 권위 조각을 상한까지 채워도(경계 3축×12×200 · 계약 ≈4,000) 열린 지적 제외 머리 ≤ 파생 상한 · 열린 지적은 측정 밖", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hb-repo2-"));
  const item = (k, i) => (k + i + " ").repeat(60).slice(0, 200);
  const axis = (k) => Array.from({ length: 12 }, (_, i) => item(k, i));
  fs.writeFileSync(path.join(repo, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: axis("전제"), alwaysBlocker: axis("차단"), outOfScope: axis("제외") }));
  const sha = CL.readVerifyEnvelope(repo).sha1;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "hb-ws-"));
  const rules = Array.from({ length: 14 }, (_, i) => ("규칙 " + i + " 상황예시로 말하라 ").repeat(6).slice(0, 240));
  CL.updateContractPatch(ws, "ko", { envelopeHash: sha, scoutRepo: repo, codex: rules, scoutMode: "off" }, { tries: 3 });
  const c = CL.loadContract(ws, "ko");
  const injLen = CL.buildInjection(c.codex, "Codex", c.codexChecklist, "ko").length;
  assert.ok(injLen > 1000 && injLen <= CL.HEAD_BUDGET.contract, "contract injection within its cap (" + injLen + ")"); // 저장 관문이 규칙을 정규화해 상한까지 못 채움 — 아래에서 '상한까지 채웠다면'의 여유분을 더해 검산
  const carrier = {};
  const head = CB.withContract("요청 본문", ws, "ko", carrier, "core", c, "ask-hb");
  const es = CB.envelopeSliceFor(ws, "ko", "core", c);
  const measured = head.length - es.v2Data.length;
  const slackContract = CL.HEAD_BUDGET.contract - injLen; // 계약이 상한까지 찼을 때를 가정한 여유분까지 더해도 파생 상한 안
  assert.ok(measured + slackContract <= CL.headBudgetTotal(), `head(excl. open findings) ${measured} + contract slack ${slackContract} must be ≤ derived cap ${CL.headBudgetTotal()}`);
  assert.ok(head.includes("> ab-12:") && head.includes("> sup-12:") && head.includes("> oos-12:"), "authority data complete (no truncation)");
  assert.ok(head.includes(JSON.stringify({ n: 14, r: rules[13].trim() }).slice(1, -1)), "user rules complete");
  // 열린 지적 200행을 만들어도 측정에서 제외되고 데이터는 전량 실린다
  process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-hb";
  CL.writeEnvelopeFreeze(ws, sha, "ask-hb", {});
  let opened = 0;
  for (let r9 = 0; r9 < 5; r9++) {
    const rows = Array.from({ length: 40 }, (_, i) => JSON.stringify({ tag: "blocker", title: "지적 " + r9 + "-" + i, origin: "baseline" }));
    const res = CB.machineFindingsLayer(["본문", "[지적 목록 v2]", ...rows, "[지적 목록 끝]", "", "검증: 실패"].join(NL), ws, "ko", "core", "claude-codex", "ask-hb-" + r9);
    opened += res.machine.admission ? res.machine.admission.kept : 0;
  }
  const opens = CL.openFindingsFor(ws, "no-campaign", sha);
  assert.ok(opens.length >= 40, "open findings accumulated (" + opens.length + ")");
  const head2 = CB.withContract("요청 본문", ws, "ko", {}, "core", c, "ask-hb2");
  const es2 = CB.envelopeSliceFor(ws, "ko", "core", c);
  assert.ok(es2.v2Data.length > 1000 && head2.includes("[열린 지적 —"), "open findings carried in full (outside the budget) — v2Data " + es2.v2Data.length);
  assert.ok(head2.length - es2.v2Data.length <= CL.headBudgetTotal(), "measured head still within the derived cap");
  for (const p9 of CL.judgeRequiredPending(ws)) CL.resolveJudgeRequired(ws, p9.askId, "re-verify", { note: "시험 정리 — 잔여 관문 종결" });
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
