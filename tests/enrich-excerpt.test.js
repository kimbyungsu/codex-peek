#!/usr/bin/env node
/**
 * 묶음 2 — 바뀐 부분 주변 발췌(D2)·인용 결속(D1) 시험.
 * 순수: hunk 헤더 파싱·창 병합/절단 · 판독: git 기준점~작업 트리 창·폴백(새 파일·git 실패·비-git) · 프롬프트 제목 표기 ·
 * e2e: git 기반 큐에서 깊은 줄 변경 → 창 안 인용 통과·창 밖(파일 첫머리) 인용 제외.
 * 기준점 별칭 금지(확인 검증 2판 blocker): 호출 도중·재개 뒤 커밋으로 HEAD 가 움직여도 재검사·변환은 발송 시점 커밋 id 를 본다.
 * 계획: docs/ENRICH-NEXT-AXES-PLAN-2026-09-20.md §2-2 · 결정 D-2026-09-20-enrich-next-axes.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p8ex_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MB = require("../bridge/map-bootstrap.js");
const ME = require("../bridge/map-enrich.js");
const MP = require("../bridge/map-pipeline.js");
const EP = require("../bridge/enrich-providers.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const READY = { selfReady: true, economyReady: true, precisionReady: true, autoReady: true };
const g = (repo, args) => cp.spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", windowsHide: true });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => "// " + tag + " line " + (i + 1)).join("\n") + "\n";

console.log("[1] hunk 헤더 파싱(순수) — 개수 생략·삭제만·복수");
{
  const r = EP.parseHunkRanges("diff --git a/x b/x\n@@ -1,3 +1,4 @@\n+a\n@@ -10 +12,0 @@\n-b\n@@ -20,2 +25 @@\n c\n@@ -0,0 +1,5 @@\n");
  ok(JSON.stringify(r) === JSON.stringify([{ start: 1, end: 4 }, { start: 12, end: 12 }, { start: 25, end: 25 }, { start: 1, end: 5 }]), "범위=새 파일 기준(개수 생략=1줄·삭제만=그 자리 1줄·새 파일=1..n) " + JSON.stringify(r));
  ok(EP.parseHunkRanges("").length === 0 && EP.parseHunkRanges(null).length === 0, "빈 입력=범위 0");
}

console.log("[2] 창 병합·절단(순수)");
{
  const text = lines(300, "t");
  const w = EP.windowedBody(text, [{ start: 150, end: 152 }, { start: 170, end: 170 }, { start: 290, end: 300 }], 40, 100000);
  ok(w.windows.length === 2 && w.windows[0].start === 110 && w.windows[0].end === 210 && w.windows[1].start === 250 && w.windows[1].end === 300, "겹치는 창 병합·파일 끝 절단 " + JSON.stringify(w.windows));
  ok(w.label === "변경 주변 L110–210, L250–300" && !w.truncated, "제목 표기");
  ok(w.text.includes("// t line 210\n") && w.text.endsWith("// t line 300\n") && w.text.includes("// t line 210\n\n// t line 250\n"), "창 끝 개행 보존(원문 그대로 — 인용 결속용)·창 사이 빈 줄 하나");
  ok(EP.windowedBody("a\nb\nc", [{ start: 3, end: 3 }], 0, 4000).text === "c" && EP.windowedBody("a\nb\nc\n", [{ start: 3, end: 3 }], 0, 4000).text === "c\n", "파일 끝 줄=원문에 개행이 있을 때만 개행");
  ok(w.text.includes("// t line 110") && w.text.includes("// t line 210") && !w.text.includes("// t line 109\n") && !w.text.includes("// t line 211"), "본문=창 안 줄만");
  const small = EP.windowedBody(text, [{ start: 150, end: 152 }, { start: 290, end: 300 }], 40, 300);
  ok(small.truncated && /\(일부\)$/.test(small.label) && small.text.length <= 300, "글자 상한=순서대로 싣고 초과분 절단·제목에 (일부)");
  ok(EP.windowedBody(text, [], 40, 4000).text === "" && EP.windowedBody(text, [], 40, 4000).label === "", "범위 없음=빈 본문");
  ok(EP.windowedBody(text, [{ start: 500, end: 510 }], 40, 4000).windows.length === 0, "파일 밖 범위=무시");
}

console.log("[3] 판독 — git 기준점~작업 트리 창 · 폴백(새 파일·git 실패·비-git·기준점 없음)");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p8ex_git_"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "deep.js"), lines(300, "d"));
  g(repo, ["init", "-q"]); g(repo, ["config", "user.email", "t@t"]); g(repo, ["config", "user.name", "t"]);
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "c1"]);
  const base = g(repo, ["rev-parse", "HEAD"]).stdout.trim();
  // 150~152줄 수정(작업 트리·미커밋)
  const arr = lines(300, "d").split("\n"); arr[149] = "// d line 150 CHANGED"; arr[150] = "// d line 151 CHANGED"; arr[151] = "// d line 152 CHANGED";
  fs.writeFileSync(path.join(repo, "src", "deep.js"), arr.join("\n"));
  const cr = EP.changedRangesFor(repo, "src/deep.js", base);
  ok(cr.ok && cr.ranges.length === 1 && cr.ranges[0].start === 150 && cr.ranges[0].end === 152, "변경 줄 범위(기준점 커밋 vs 작업 트리) " + JSON.stringify(cr));
  const r = EP.excerptBodyFor(repo, "src/deep.js", { baseRef: base });
  ok(r.ok && r.mode === "changed" && r.label === "변경 주변 L110–192" && r.body.includes("// d line 150 CHANGED") && r.body.includes("// d line 110") && !r.body.includes("// d line 1\n") && !r.body.includes("// d line 300"), "발췌=바뀐 부분 주변 창(첫머리 아님) " + r.label);
  // 커밋된 변경도 기준점 기준이면 창에 든다
  g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "c2"]);
  const r2 = EP.excerptBodyFor(repo, "src/deep.js", { baseRef: base });
  ok(r2.ok && r2.mode === "changed" && r2.label === "변경 주변 L110–192", "커밋된 변경(기준점~HEAD)도 창");
  ok(EP.excerptBodyFor(repo, "src/deep.js", { baseRef: "HEAD" }).mode === "head", "HEAD 기준이면 커밋 뒤 변경 없음=첫머리 폴백");
  // 새 파일(미추적)=첫머리 폴백·표기
  fs.writeFileSync(path.join(repo, "src", "fresh.js"), lines(50, "f"));
  const r3 = EP.excerptBodyFor(repo, "src/fresh.js", { baseRef: base });
  ok(r3.ok && r3.mode === "head" && r3.label === "앞부분" && r3.body.startsWith("// f line 1"), "새 파일=첫머리 폴백(제목 표기)");
  // git 실패(존재하지 않는 기준점)=폴백
  const r4 = EP.excerptBodyFor(repo, "src/deep.js", { baseRef: "0123456789abcdef0123456789abcdef01234567" });
  ok(r4.ok && r4.mode === "head" && r4.label === "앞부분", "기준점 소실=첫머리 폴백(실행 계속)");
  // 기준점 없음(historyless)=첫머리
  ok(EP.excerptBodyFor(repo, "src/deep.js").mode === "head" && EP.excerptBodyFor(repo, "src/deep.js", {}).label === "앞부분", "기준점 없음=첫머리");
  // 비-git 폴더
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "p8ex_plain_"));
  fs.writeFileSync(path.join(plain, "x.js"), "// x\n");
  ok(EP.excerptBodyFor(plain, "x.js", { baseRef: "HEAD" }).mode === "head", "git 아님=첫머리 폴백");
  ok(EP.excerptBodyFor(repo, "src/none.js", { baseRef: base }).ok === false, "판독 불가=ok false(종전)");
  // 프롬프트 제목 표기(스냅샷 없이 직접 조립·스냅샷 라벨)
  fs.writeFileSync(path.join(repo, "src", "a.js"), "// a\n");
  const topo = { mapId: "00000000-0000-4000-8000-000000000001", nodes: [{ id: "00000000-0000-4000-8000-000000000002", label: "n", entityType: "module", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/deep.js" }] }], edges: [] };
  const arr2 = fs.readFileSync(path.join(repo, "src", "deep.js"), "utf8").split("\n"); arr2[200] = "// d line 201 AGAIN"; fs.writeFileSync(path.join(repo, "src", "deep.js"), arr2.join("\n"));
  const pr = EP.buildEnrichPrompt({ repo, topo, changed: ["src/deep.js"], excerptBaseRef: base });
  ok(pr.includes("### src/deep.js (변경 주변 L110–241)") && pr.includes("발췌 밖 원문·보내지 않은 파일의 인용은 그 항목이 자동 제외된다"), "프롬프트 제목에 위치 표기·계약 문구 고지");
  const prS = EP.buildEnrichPrompt({ repo, topo, changed: ["src/deep.js"], excerptBodies: new Map([["src/deep.js", "SNAP BODY"]]), excerptLabels: new Map([["src/deep.js", "변경 주변 L1–2"]]) });
  ok(prS.includes("### src/deep.js (변경 주변 L1–2)\n```\nSNAP BODY\n```"), "스냅샷+라벨이 있으면 그대로 실음");
}

console.log("[4] e2e — git 기반 큐: 깊은 줄 변경 → 창 안 인용 통과·첫머리(창 밖) 인용 제외");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8ex_e2e_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.writeFileSync(path.join(ws, "src", "deep.js"), lines(300, "e"));
  g(ws, ["init", "-q"]); g(ws, ["config", "user.email", "t@t"]); g(ws, ["config", "user.name", "t"]);
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c1"]);
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const r0 = MR.initTopologyForBootstrap(ws);
  if (r0.st !== "created") throw new Error("init 실패: " + r0.st);
  const nodeId = MR.readTopoExFor(ws).topo.nodes[0].id;
  ok(MB.ensureQueue(ws, PM) === true, "(전제) git 기반 큐");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  const arr = lines(300, "e").split("\n"); arr[199] = "// e line 200 DEEP CHANGE"; fs.writeFileSync(path.join(ws, "src", "deep.js"), arr.join("\n"));
  let seenLabel = "", seenBody = "";
  const ad = (ctx) => {
    seenLabel = ctx.excerptLabels instanceof Map ? String(ctx.excerptLabels.get("src/deep.js") || "") : "";
    seenBody = ctx.excerptBodies instanceof Map ? String(ctx.excerptBodies.get("src/deep.js") || "") : "";
    return { ok: true, result: { schema: "enrich-result-v1", items: [
      { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/deep.js", note: "in-window" } }, evidence: [{ file: "src/deep.js", quote: "// e line 200 DEEP CHANGE" }] },
      { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/deep.js", note: "head-outside" } }, evidence: [{ file: "src/deep.js", quote: "// e line 1\n" }] },
    ] } };
  };
  const r = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: ad }, trigger: "test" });
  ok(r.outcome === "applied", "실행 완주 (" + r.outcome + "/" + r.reason + ")");
  ok(/^변경 주변 L160–240/.test(seenLabel) && seenBody.includes("// e line 200 DEEP CHANGE") && !seenBody.includes("// e line 1\n"), "담당이 받은 발췌=바뀐 줄 주변 창(첫머리 없음) · 표기 " + seenLabel);
  const j = ME.readEnrichJob(ws).job; const a = j.attempts[j.attempts.length - 1];
  ok(Array.isArray(a.droppedItems) && a.droppedItems.length === 1 && a.droppedItems[0].index === 1 && a.droppedItems[0].detail && a.droppedItems[0].detail.kind === "evidence-outside" && a.droppedItems[0].detail.sent === true && /^변경 주변/.test(a.droppedItems[0].detail.excerpt), "창 밖(첫머리) 인용=그 항목만 제외·제외 사유에 위치 표기 " + JSON.stringify(a.droppedItems));
  ok(a.citation && a.citation.total === 1 && a.citation.inExcerpt === 1, "통과 항목의 인용 측정=창 안 1/1");
  // 검증 1판 blocker: 창 마지막 줄 개행을 포함한 정상 인용 · 첫머리가 비고 깊은 곳만 코드인 파일도 관문 통과(신규 라운드 관문의 기준점)
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  fs.writeFileSync(path.join(ws, "src", "one.js"), "const a = 1;\n");
  fs.writeFileSync(path.join(ws, "src", "blankhead.js"), "\n".repeat(4100) + "module.exports = 42;\n"); // 첫 4,000자는 빈 줄 — 이 파일이 '기준점 안'에 있어야 깊은 변경만 hunk 가 된다
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c2"]);
  fs.writeFileSync(path.join(ws, "src", "one.js"), "const a = 1;\nconst b = 2;\n"); // 변경(2줄째 추가) → 창=L1–2
  const adNl = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/one.js", note: "nl" } }, evidence: [{ file: "src/one.js", quote: "const b = 2;\n" }] },
  ] } });
  const rNl = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: adNl }, trigger: "test" });
  const jNl = ME.readEnrichJob(ws).job; const aNl = jNl.attempts[jNl.attempts.length - 1];
  ok(rNl.outcome === "applied" && !(aNl.droppedItems || []).length, "창 끝 개행 포함 인용=통과 (" + rNl.outcome + "/" + rNl.reason + " · " + JSON.stringify(aNl.droppedItems || []) + ")");
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  const base2 = ME.readConsumedBaseline(ws); // 위 실행이 done 되며 기준점=c2(blankhead.js 포함)
  ok(!!base2 && base2.head === g(ws, ["rev-parse", "HEAD"]).stdout.trim(), "(전제) 소화 기준점=c2");
  fs.writeFileSync(path.join(ws, "src", "blankhead.js"), "\n".repeat(4100) + "module.exports = 43;\n"); // 깊은 곳만 변경(첫머리 판독은 비어 보인다)
  let calledBh = 0;
  const adBh = () => { calledBh++; return { ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/blankhead.js", note: "deep" } }, evidence: [{ file: "src/blankhead.js", quote: "module.exports = 43;" }] },
  ] } }; };
  const rBh = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: adBh }, trigger: "test" });
  { const jB = ME.readEnrichJob(ws); const aB = jB.st === "ok" && jB.job.attempts.length ? jB.job.attempts[jB.job.attempts.length - 1] : null; ok(rBh.outcome === "applied" && calledBh === 1, "첫머리가 빈 파일의 깊은 변경=신규 라운드 관문 통과(창 판독)·호출 1·적용 (" + rBh.outcome + "/" + rBh.reason + " · called=" + calledBh + " · last=" + JSON.stringify(aB && { code: aB.failureCode, stage: aB.failureStage, dropped: aB.droppedItems, detail: aB.failureDetail }) + ")"); }
  ok(ME.answerableInput(ws, MR.readTopoExFor(ws).topo, ["src/blankhead.js"], { baseRef: base2.head }) === true && ME.answerableInput(ws, MR.readTopoExFor(ws).topo, ["src/blankhead.js"]) === false, "관문: 기준점 있으면 창 판독=답 가능·없으면 첫머리=불가(구별 실측)");
  // 불일치 진단의 발췌 위치=발송 스냅샷(검증 1판 보완): 창 안 원문을 줄 끝만 바꿔 인용 → 거부되되 inExcerpt true
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  fs.writeFileSync(path.join(ws, "src", "blankhead.js"), "\n".repeat(4100) + "module.exports = 44;\n");
  const adCr = () => ({ ok: true, result: { schema: "enrich-result-v1", items: [
    { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/blankhead.js", note: "crlf" } }, evidence: [{ file: "src/blankhead.js", quote: "module.exports = 44;\r\n" }] },
  ] } });
  const rCr = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: adCr }, trigger: "test" });
  const jCr = ME.readEnrichJob(ws).job; const aCr = jCr.attempts[jCr.attempts.length - 1];
  ok(rCr.outcome !== "applied" && aCr.failureCode === "evidence-mismatch" && aCr.failureDetail && aCr.failureDetail.matchAfter === "crlf" && aCr.failureDetail.inExcerpt === true, "줄 끝만 다른 창 안 인용=거부(종전)·진단 inExcerpt=발송 스냅샷 기준 true (" + JSON.stringify(aCr.failureDetail) + ")");
  ok(ME.quoteInExcerpt("// e line 160\n// e line 161", "// e line 1\n") === false && ME.quoteInExcerpt("  x\n  y", "x\ny") === true && ME.quoteInExcerpt("a\r\nb", "a\nb") === true, "발췌 안 판정=줄 구조 보존 단계만(공백 접기 가짜 일치 배제)");
  const base = ME.readConsumedBaseline(ws);
  ok(!!base && base.head && ME.excerptBaseRefFor(ws, { basis: { kind: "git" } }) === base.head && ME.excerptBaseRefFor(ws, { basis: { kind: "historyless" } }) === null, "발췌 기준점=소화 기준점 커밋(git 큐)·historyless=없음");
}

console.log("[5] 기준점 별칭 금지(확인 검증 2판 blocker) — 호출 중 커밋·재개 뒤 커밋에도 재검사·변환은 발송 시점 커밋 id 를 본다");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8ex_alias_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n");
  fs.writeFileSync(path.join(ws, "src", "blankhead.js"), "\n".repeat(4100) + "module.exports = 42;\n"); // 첫 4,000자는 빈 줄
  g(ws, ["init", "-q"]); g(ws, ["config", "user.email", "t@t"]); g(ws, ["config", "user.name", "t"]);
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c1"]);
  const c1 = g(ws, ["rev-parse", "HEAD"]).stdout.trim();
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" }));
  MB.grantConsent(ws, "test");
  const r0 = MR.initTopologyForBootstrap(ws);
  if (r0.st !== "created") throw new Error("init 실패: " + r0.st);
  ok(MB.ensureQueue(ws, PM) === true, "(전제) git 기반 큐");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  // (a) 순수: 소화 기준점 없음 → 별칭 "HEAD" 가 아니라 한 번 해석한 커밋 id · 호출자가 캡처한 HEAD 우선 · 해석 실패=null
  const q = { basis: { kind: "git" } };
  ok(ME.readConsumedBaseline(ws) === null && ME.excerptBaseRefFor(ws, q) === c1, "기준점 없음=지금 HEAD 를 한 번 해석한 커밋 id(별칭 아님)");
  const fakeOid = "0123456789abcdef0123456789abcdef01234567";
  ok(ME.excerptBaseRefFor(ws, q, { head: fakeOid }) === fakeOid && ME.excerptBaseRefFor(ws, q, { head: "HEAD" }) === c1 && ME.excerptBaseRefFor(ws, q, { head: null }) === c1, "호출자가 캡처한 HEAD(커밋 id)가 있으면 그 값(재조회 없음)·형식 아니면 해석");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "p8ex_nogit_"));
  ok(ME.excerptBaseRefFor(plain, q) === null && ME.excerptBaseRefFor(plain, q, { head: "HEAD" }) === null, "해석 실패(git 아님)=null(첫머리 판독 — 실행 계속·별칭 없음)");
  // (b) e2e: 깊은 변경 발송 → 담당 응답을 기다리는 사이 사용자가 그 변경을 커밋(본문 불변·HEAD 이동) → add_node 앵커 재검사·변환 재검사 통과
  fs.writeFileSync(path.join(ws, "src", "blankhead.js"), "\n".repeat(4100) + "module.exports = 43;\n");
  const fileNode = (id, p9, quote) => ({ op: "add_node", payload: { node: { id, label: "깊은 파일", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: p9 }] } }, evidence: [{ file: p9, quote }] });
  let seenBase = "";
  const adMid = (ctx) => {
    seenBase = String(ctx.excerptBaseRef || "");
    g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "mid"]); // 호출 도중 커밋(본문은 그대로)
    return { ok: true, result: { schema: "enrich-result-v1", items: [fileNode("11111111-2222-4333-8444-555555555555", "src/blankhead.js", "module.exports = 43;")] } };
  };
  const rMid = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: adMid }, trigger: "test" });
  const c2 = g(ws, ["rev-parse", "HEAD"]).stdout.trim();
  const jM = ME.readEnrichJob(ws); const aM = jM.st === "ok" && jM.job.attempts.length ? jM.job.attempts[jM.job.attempts.length - 1] : null;
  ok(c2 !== c1 && rMid.outcome === "applied" && rMid.applied === 1, "호출 중 커밋에도 정상 add_node 적용(별칭이면 새 HEAD 기준 '변경 없음'→첫머리 폴백→빈 본문 오판) (" + rMid.outcome + "/" + rMid.reason + " · " + JSON.stringify(aM && { code: aM.failureCode, dropped: aM.droppedItems, detail: aM.failureDetail }) + ")");
  ok(seenBase === c1 && !!aM && aM.excerptBase === c1, "담당이 받은 기준점=시도에 영속된 기준점(excerptBase)=발송 시점 커밋 id");
  ok(jM.st === "ok" && MR.readTopoExFor(ws).topo.nodes.some((n) => n.entityType === "file" && n.id === ME.detFileNodeId(jM.job.mapId, "src/blankhead.js")), "file 노드 실재");
  ok((ME.readConsumedBaseline(ws) || {}).head === c1, "소화 기준점=입력 계산 시점 커밋(호출 중 커밋으로 전진 금지 — 종전 규칙 유지)");
  // (c) 재개 경로: results 영속 직후 죽음(변환 전) → 죽어 있는 동안 사용자가 커밋(HEAD 이동) → 재개의 변환 재검사는 시도에 영속된 발송 시점 기준점을 쓴다
  try { fs.unlinkSync(ME.consumedFileFor(ws)); } catch { /* (b)가 세워졌으면 기준점 자체가 없다 */ } // 첫 라운드가 done 전에 죽은 상태(소화 기준점 없음 — 별칭이 문제되는 조건) 재현
  fs.writeFileSync(path.join(ws, "src", "deep2.js"), "\n".repeat(4100) + "module.exports = 1;\n");
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c3"]);
  const c3 = g(ws, ["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(ws, "src", "deep2.js"), "\n".repeat(4100) + "module.exports = 2;\n"); // 발송 시점 작업 트리=깊은 변경
  ok(MB.ensureQueue(ws, PM) === true, "(전제) 큐 재작성");
  const topoB = MR.readTopoExFor(ws).topo;
  const idxB = MP.decisionIndexFor(ws, topoB.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topoB), idxB);
  const gen = ME.findGrant(ME.readEnrichConsent(ws), ws, "ko").gen;
  const startedAt = new Date().toISOString();
  const jobKey = ME.jobKeyOf(topoB.mapId, ah, null);
  const itemsR = [fileNode("22222222-3333-4444-8555-666666666666", "src/deep2.js", "module.exports = 2;")];
  const mkJob = (excerptBase) => ({ schema: "enrich-job-v2", jobKey, mapId: topoB.mapId, authorityHash: ah, decisionContextHash: null, mode: "self", configWs: CL.normWs(ws), slot: "ko", phase: "open", startedAt, attempts: [{ attemptId: 0, provider: "self", consentGen: gen, phase: "applying", startedAt, ...(excerptBase === undefined ? {} : { excerptBase }), results: { schema: "enrich-result-v1", items: itemsR }, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [] } }] });
  ok(ME.validateJob(mkJob(c3)) === null && ME.validateJob(mkJob(null)) === null && ME.validateJob(mkJob(undefined)) === null, "strict: excerptBase=커밋 id·null(첫머리)·부재(옛 기록) 승인");
  ok(ME.validateJob(mkJob("HEAD")) !== null && ME.validateJob(mkJob(12)) !== null && ME.validateJob(mkJob("abc")) !== null, "strict: 별칭·이형=손상");
  const wJ = ME.updateEnrichJob(ws, () => mkJob(c3));
  ok(wJ.ok === true, "(전제) results 영속 직후 죽은 상태(applying·nextIndex 0·excerptBase=발송 시점 커밋)");
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c4"]); // 죽어 있는 동안 사용자가 그 변경을 커밋(HEAD 이동·본문 불변)
  const c4 = g(ws, ["rev-parse", "HEAD"]).stdout.trim();
  ok(c4 !== c3 && EP.excerptBodyFor(ws, "src/deep2.js", { baseRef: c4 }).body.trim() === "" && EP.excerptBodyFor(ws, "src/deep2.js", { baseRef: c3 }).mode === "changed", "(대조) 새 HEAD 기준이면 빈 첫머리·발송 시점 커밋 기준이면 창");
  let calledR = 0;
  const rR = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: () => { calledR++; return { ok: false, detail: "호출되면 안 됨" }; } }, trigger: "test" });
  const jR = ME.readEnrichJob(ws);
  ok(rR.outcome === "applied" && rR.applied === 1 && calledR === 0, "재개=새 호출 0·변환 재검사가 시도의 발송 시점 기준점(창)으로 통과·적용 (" + rR.outcome + "/" + rR.reason + " · " + JSON.stringify(jR.st === "ok" ? jR.job.attempts[0].droppedItems : jR.st) + ")");
  ok(MR.readTopoExFor(ws).topo.nodes.some((n) => n.entityType === "file" && n.id === ME.detFileNodeId(topoB.mapId, "src/deep2.js")), "file 노드 실재(재개 변환)");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
