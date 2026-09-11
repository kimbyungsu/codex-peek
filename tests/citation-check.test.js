/*
 * [HARNESS-STRUCTURE-2026-09-11 §B1] 인용 대조 — 검증자가 적은 "파일·줄·상세"를 실제 파일과 대조한다(읽기 추정 아님).
 * 판정 7종·본문 링크·CRLF·루트 밖 배제(ab-1)·토큰 원문 미기록(ab-7)·파서의 line·detail 보존·저장소 결속 갈아끼우기·배선.
 */
const fs = require("fs"), os = require("os"), path = require("path");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cite-check-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CC = require("../bridge/citation-check.js");
const CL = require("../bridge/contract-lib.js");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cite-check-root-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cite-check-outside-"));
fs.mkdirSync(path.join(root, "src"));
const body = ["const alpha = 1;", "function computeTotal(x) {", "  return x * 2;", "}", "const secretKey = \"sk-not-a-real-key\";", "module.exports = { computeTotal };"];
fs.writeFileSync(path.join(root, "src", "a.js"), body.join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(root, "src", "crlf.js"), body.join("\r\n") + "\r\n", "utf8");
fs.writeFileSync(path.join(outside, "far.js"), body.join("\n") + "\n", "utf8");
const resolvePath = (raw) => { const p = path.isAbsolute(raw) ? raw : path.join(root, raw); return fs.existsSync(p) ? p : null; };
const run = (findings, bodyText) => CC.citationCheck({ findings, bodyText: bodyText || "", roots: [root], resolvePath });
const kindOf = (r) => r.items[0] && r.items[0].kind;

console.log("[1] 판정 7종");
ok(kindOf(run([{ file: "src/a.js", line: 2, detail: "`computeTotal` 이 x*2 를 반환" }])) === "ok", "ok — 줄 범위 안·백틱 식별자가 그 줄 근처에 있음");
ok(kindOf(run([{ file: "src/a.js", line: 6, detail: "`alpha` 상수" }])) === "token-not-near-line", "token-not-near-line — 식별자가 ±3줄 밖(alpha 는 1줄, 인용 6줄)");
ok(kindOf(run([{ file: "src/a.js", line: 99, detail: "`computeTotal`" }])) === "line-out-of-range", "line-out-of-range — 줄 번호가 파일 줄 수 초과");
ok(run([{ file: "src/a.js", line: 99, detail: "`computeTotal`" }]).items[0].total === 7, "line-out-of-range 에 실제 줄 수(마지막 개행 포함 7)");
ok(kindOf(run([{ file: "src/missing.js", line: 1, detail: "`x`" }])) === "unresolved", "unresolved — 해석 불가(경보 아님 · cry-wolf 방지)");
{ const gone = path.join(root, "src", "gone.js"); fs.writeFileSync(gone, "x\n"); const r = CC.citationCheck({ findings: [{ file: gone, line: 1, detail: "`x`" }], bodyText: "", roots: [root], resolvePath: () => { fs.unlinkSync(gone); return gone; } }); ok(kindOf(r) === "file-missing", "file-missing — 해석은 됐으나 실물 없음"); }
ok(kindOf(run([{ file: "src/a.js", detail: "`computeTotal`" }])) === "no-location", "no-location — 줄 번호 없음(파일 실존만)");
ok(kindOf(run([{ file: "src/a.js", line: 2, detail: "설명만 있고 코드 스팬 없음" }])) === "no-token", "no-token — 상세에 식별자 없음");
ok(kindOf(run([{ file: "", line: 2, detail: "`computeTotal`" }])) === "no-location", "file 빈 값 → no-location");

console.log("[2] 루트 밖 배제(ab-1)·CRLF");
ok(kindOf(run([{ file: path.join(outside, "far.js"), line: 2, detail: "`computeTotal`" }])) === "outside-root", "허용 루트 밖 절대경로 → outside-root(흔적·경보 아님)");
ok(kindOf(run([{ file: "src/crlf.js", line: 2, detail: "`computeTotal`" }])) === "ok", "CRLF 파일도 줄 계산 동일");
ok(CC.underRoots(path.join(root, "src", "a.js"), [root]) === true && CC.underRoots(path.join(outside, "far.js"), [root]) === false, "underRoots — realpath 기준 포함 판정");

console.log("[3] 토큰 원문 미기록(ab-7)·따옴표 문자열 제외");
{ const r = run([{ file: "src/a.js", line: 5, detail: "비밀값 `\"sk-not-a-real-key\"` 노출 · `secretKey` 변수" }]);
  const txt = JSON.stringify(r) + CC.alertDetail(r.alerts, false) + CC.alertDetail(r.alerts, true) + CC.summaryLine(r, false);
  ok(!txt.includes("sk-not-a-real-key"), "따옴표 문자열 스팬은 토큰이 아니며 결과·문구 어디에도 원문 없음");
  ok(r.items[0].kind === "ok" && /^[0-9a-f]{8}$/.test(r.items[0].tokenFp) && !txt.includes("secretKey"), "식별자는 대조에만 쓰고 지문(sha1 8자)만 남김 — 원문 미기록"); }
ok(JSON.stringify(CC.tokensOf("`a.b` 와 `foo_bar` 그리고 `\"quoted\"`")) === JSON.stringify(["foo_bar"]) || CC.tokensOf("`a.b` 와 `foo_bar` 그리고 `\"quoted\"`").includes("foo_bar"), "tokensOf — 백틱 스팬 식별자만(따옴표 스팬 제외)");

console.log("[4] 본문 링크 — 정보 개수만(경보는 지적 행만)");
{ const r = run([], "본문 인용 (src/a.js:2) 와 (src/a.js:99) 그리고 (src/a.js:2) 중복"); const kinds = r.items.map((i) => i.src + ":" + i.kind);
  ok(r.items.length === 2 && r.items.every((i) => i.src === "link"), "본문 링크 2건(중복 제거): " + kinds.join(","));
  ok(r.alerts.length === 0, "본문 링크의 불일치는 alerts 에 들어가지 않음(evidence-mismatch 가 담당 · 이중 경보 금지)"); }

console.log("[5] 경보 문구·요약 줄");
{ const r = run([{ file: "src/a.js", line: 99, detail: "`computeTotal`", id: "f-12345678" }, { file: "src/a.js", line: 2, detail: "`computeTotal`" }, { file: "src/a.js", line: 6, detail: "`alpha`" }]);
  ok(r.alerts.length === 2 && r.alerts[0].findingId === "f-12345678", "경보=불일치 지적 행만(2건)·지적 id 결속");
  const ko = CC.alertDetail(r.alerts, false), en = CC.alertDetail(r.alerts, true);
  ok(ko.includes("a.js:99") && ko.includes("줄 범위 밖") && ko.includes("a.js:6") && ko.includes("식별자 없음") && !ko.includes("computeTotal"), "ko 문구: 파일·줄·종류만 · 토큰 원문 없음: " + ko);
  ok(en.includes("line beyond EOF") && !en.includes("computeTotal"), "en 문구 동형");
  const sum = CC.summaryLine(r, false);
  ok(sum.includes("지적 행 일치 1/3") && sum.includes("불일치 2") && !sum.includes("본문 링크"), "요약 줄(지적 행만): " + sum);
  const sum2 = CC.summaryLine(run([{ file: "src/a.js", line: 2, detail: "`computeTotal`" }], "본문 (src/a.js:2) (src/a.js:99)"), false);
  ok(sum2.includes("지적 행 일치 1/1") && sum2.includes("본문 링크 2(줄 확인만 · 범위 밖 1)"), "요약 줄(본문 링크 분리): " + sum2); }

console.log("[6] 파서 — line·detail 보존(형식 무효=드롭)");
{ const blk = ["[지적 목록 v2]", JSON.stringify({ tag: "보완", title: "t1", file: "src/a.js", line: 2, detail: "`computeTotal` 확인", origin: "new-evidence", supported: true }), JSON.stringify({ tag: "보완", title: "t2", file: "src/a.js", line: "2", detail: 42 }), "[지적 목록 끝]", "검증: 통과(보완)"].join("\n");
  const p = CL.parseFindingsBlock(blk);
  ok(p.present && p.ok && p.findings.length === 2, "블록 파싱 정상");
  ok(p.findings[0].line === 2 && p.findings[0].detail === "`computeTotal` 확인", "line·detail 보존");
  ok(p.findings[1].line === undefined && p.findings[1].detail === undefined, "형식 무효(문자열 line·숫자 detail)=드롭"); }

console.log("[7] 저장소 결속 갈아끼우기(ab-1) — 같은 종류·같은 폴더라도 repoKey 가 다르면 보존");
{ const ws = path.join(HOME, "ws"); fs.mkdirSync(ws);
  const base = { ts: new Date().toISOString(), workspace: ws, kind: "citation-mismatch", severity: "warning", detail: "d" };
  CL.appendIntegrityEvent({ ...base, repoKey: "aaaaaaaaaaaaaaaa" }, { supersedeSameKindWs: true, repoKey: "aaaaaaaaaaaaaaaa" });
  CL.appendIntegrityEvent({ ...base, repoKey: "bbbbbbbbbbbbbbbb" }, { supersedeSameKindWs: true, repoKey: "bbbbbbbbbbbbbbbb" });
  let evs = CL.readIntegrityEvents().filter((e) => e.kind === "citation-mismatch");
  ok(evs.length === 2, "다른 저장소 표식의 미확인 경보는 갈아끼우지 않음(2건 보존)");
  CL.appendIntegrityEvent({ ...base, repoKey: "aaaaaaaaaaaaaaaa", detail: "d2" }, { supersedeSameKindWs: true, repoKey: "aaaaaaaaaaaaaaaa" });
  evs = CL.readIntegrityEvents().filter((e) => e.kind === "citation-mismatch");
  ok(evs.length === 2 && evs.filter((e) => e.repoKey === "aaaaaaaaaaaaaaaa").length === 1 && evs.find((e) => e.repoKey === "aaaaaaaaaaaaaaaa").detail === "d2", "같은 표식은 갈아끼움(a 1건=최신·b 1건 보존)"); }

console.log("[8] 배선 — flagEvidence 대조 위치·정보 줄 조립·evidence-unseen 등급 info·대시보드 repoKey 필터");
const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
const iC = src.indexOf('kind: "citation-mismatch"'), iU = src.indexOf("const seenChk = citedFilesUnseen(answer, pathWs, sessionId);");
ok(iC > 0 && iU > 0 && iC < iU, "citation-mismatch 는 읽기 추정보다 앞(독립 검사)");
ok(src.includes("{ supersedeSameKindWs: true, repoKey: rk9 }"), "같은 종류 갈아끼우기가 repoKey 결속");
ok(src.includes("+ evidenceInfoLine(answer, exec, verifierSession, citeRootsE9, langSnap)"), "답 하단 정보 줄 조립(대조 루트)");
ok(src.includes('severity: "info", // [D3'), "evidence-unseen 표시 등급=info");
ok(src.includes("repoKey: repoKeySnapE9, citeRoots: citeRootsE9, // [§B1]") && src.includes("const repoKeySnapE9 = (() => { try { return repoKeyOf(resolveScoutRepo(ws, contractSnap).repo); } catch { return \"\"; } })();"), "flagEvidence 에 검증 시작 저장소 표식 전달(루트 계산과 분리)");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(ext.includes('.filter((e) => e.kind !== "citation-mismatch" || (!!rkNow && String(e.repoKey || "") === rkNow))'), "대시보드: citation-mismatch 는 현재 정찰 저장소 표식 일치만 표시(ab-1)");
ok(ext.includes('e.severity==="info"?"info":"warn"') && ext.includes(".sevdot.info{"), "대시보드: info 등급 점 표시");

console.log("[9] 식별자 대조 — 문자열 가림·단어 경계 정확 일치(구현 검증 1판 blocker)");
{ fs.writeFileSync(path.join(root, "src", "b.js"), ["function citationCheck(x) {", "  return noop(\"realpathSafe\") + x;", "}", "const alphaBeta = 2;"].join("\n") + "\n", "utf8");
  ok(kindOf(run([{ file: "src/b.js", line: 1, detail: "`citation` 을 호출" }])) === "token-not-near-line", "부분 문자열 금지 — `citation` 은 `citationCheck` 와 다름");
  ok(kindOf(run([{ file: "src/b.js", line: 2, detail: "`realpathSafe` 가 여기서 쓰임" }])) === "token-not-near-line", "문자열 안 식별자 무시 — noop(\"realpathSafe\") 는 식별자가 아님");
  ok(kindOf(run([{ file: "src/b.js", line: 1, detail: "`citationCheck` 함수" }])) === "ok", "정확 일치는 ok");
  ok(kindOf(run([{ file: "src/b.js", line: 2, detail: "`noop(\"realpathSafe\")` 호출" }])) === "ok", "스팬 안 문자열은 가리고 남은 식별자(noop)로 대조 → ok");
  ok(JSON.stringify(CC.tokensOf("`noop(\"realpathSafe\")`")) === JSON.stringify(["noop"]), "tokensOf — 스팬 안 따옴표 문자열 내용 제외: " + JSON.stringify(CC.tokensOf("`noop(\"realpathSafe\")`")));
  ok(CC.hasIdentifier("a.alphaBeta = 1", "alphaBeta") && !CC.hasIdentifier("alphaBetaGamma", "alphaBeta") && !CC.hasIdentifier("x_alphaBeta", "alphaBeta"), "hasIdentifier — 앞뒤 식별자 문자면 불일치");
  // [확인 검증 blocker] 여러 줄 문자열 — 템플릿 리터럴·삼중 따옴표 블록 안의 식별자는 대조 근거가 아니다(줄 수 보존)
  // 1~3줄=여러 줄 템플릿(안에 realpathSafe) · 8줄=실제 호출(2줄의 창 ±3 밖) · 9~11줄=삼중 따옴표 블록(안에 secretIdent)
  fs.writeFileSync(path.join(root, "src", "m.js"), ["const t = `first line", "  realpathSafe inside template", "  still inside`;", "const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const after = realpathSafe();", "x = \"\"\"", "  tripleQuoted secretIdent", "\"\"\"", "const last = 1;"].join("\n") + "\n", "utf8");
  ok(kindOf(run([{ file: "src/m.js", line: 2, detail: "`realpathSafe` 사용" }])) === "token-not-near-line", "여러 줄 템플릿 문자열 안의 식별자는 불일치(창 1~5줄에 문자열 밖 호출 없음)");
  ok(kindOf(run([{ file: "src/m.js", line: 10, detail: "`secretIdent` 참조" }])) === "token-not-near-line", "삼중 따옴표 블록 안의 식별자는 불일치");
  ok(kindOf(run([{ file: "src/m.js", line: 8, detail: "`realpathSafe` 호출" }])) === "ok", "문자열 밖의 실제 호출(8줄)은 ok");
  ok(CC.maskStrings("a `x\ny` b").split("\n").length === 2 && !CC.maskStrings("a `x\ny` b").includes("x"), "maskStrings — 여러 줄 백틱을 가리되 줄 수 보존"); }

console.log("[10] 다음 답 해소 — 이전 미확인 citation-mismatch 를 계보 일치(lineage-ok)·정상 재대조(recheck-clean)로 자동 확인");
{ const prev = { items: [{ findingId: "f-aaaaaaaa", kind: "line-out-of-range" }] };
  const okNext = { parsedOk: true, alerts: [], items: [{ src: "finding", kind: "ok", findingId: "f-aaaaaaaa" }] };
  ok(CC.resolvedByNext(prev, okNext) === "lineage-ok", "같은 지적 id 가 ok 로 재대조 → lineage-ok");
  ok(CC.resolvedByNext(prev, { parsedOk: true, alerts: [], items: [{ src: "finding", kind: "ok", prevId: "f-aaaaaaaa", findingId: "f-bbbbbbbb" }] }) === "lineage-ok", "prevId 계보로도 해소");
  ok(CC.resolvedByNext(prev, { parsedOk: true, alerts: [], items: [] }) === "recheck-clean", "계보 없음+정상 파싱+불일치 0 → recheck-clean");
  ok(CC.resolvedByNext(prev, { parsedOk: false, alerts: [], items: [] }) === null, "블록 파싱 실패면 해소 아님");
  ok(CC.resolvedByNext(prev, { parsedOk: true, alerts: [{}], items: [] }) === null, "불일치가 남으면 해소 아님(갈아끼우기가 처리)");
  ok(CC.resolvedByNext({ items: [] }, { parsedOk: true, alerts: [], items: [] }) === "recheck-clean", "계보 정보 없는 옛 이벤트도 정상 재대조로 해소");
  // 실행 경로: flagEvidence 가 새 경보 없이 이전 경보를 ack 하는지(같은 ws+repoKey)
  const B = require("../bridge/codex-bridge.js");
  const ws2 = path.join(HOME, "ws2"); fs.mkdirSync(ws2); fs.writeFileSync(path.join(ws2, "c.js"), "const one = 1;\nconst two = 2;\n", "utf8");
  const ctx = { roots: [ws2], citeRoots: [ws2], promptText: "p", mode: "claude-codex", lang: "ko", campaignId: "cl:t", askId: "ask-c1", repoKey: "rk-test-0001" };
  const bad = ["설명", "[지적 목록 v2]", JSON.stringify({ id: "f-cccccccc", tag: "보완", title: "t", file: "c.js", line: 99, detail: "`two`", origin: "new-evidence", supported: true }), "[지적 목록 끝]", "검증: 통과(보완)"].join("\n");
  B.flagEvidence(bad, ws2, "no-session", ws2, ctx);
  let evs = CL.readIntegrityEvents().filter((e) => e.kind === "citation-mismatch" && e.repoKey === "rk-test-0001");
  ok(evs.length === 1 && evs[0].ack !== true && evs[0].items[0].findingId === "f-cccccccc" && !JSON.stringify(evs[0]).includes("\"two\""), "불일치 경보 1건 생성(지적 id 결속·토큰 원문 없음)");
  const good = ["설명", "[지적 목록 v2]", JSON.stringify({ id: "f-cccccccc", tag: "보완", title: "t", file: "c.js", line: 2, detail: "`two`", origin: "new-evidence", supported: true }), "[지적 목록 끝]", "검증: 통과(보완)"].join("\n");
  B.flagEvidence(good, ws2, "no-session", ws2, ctx);
  evs = CL.readIntegrityEvents().filter((e) => e.kind === "citation-mismatch" && e.repoKey === "rk-test-0001");
  ok(evs.length === 1 && evs[0].ack === true && evs[0].autoAcked === "lineage-ok", "다음 답이 같은 지적을 맞게 고치면 자동 확인(lineage-ok): " + JSON.stringify(evs[0].autoAcked));
  B.flagEvidence(bad, ws2, "no-session", ws2, { ...ctx, repoKey: "rk-test-0002" });
  B.flagEvidence(["[지적 목록 v2]", "[지적 목록 끝]", "검증: 통과"].join("\n"), ws2, "no-session", ws2, { ...ctx, repoKey: "rk-test-0002" });
  const e2 = CL.readIntegrityEvents().filter((e) => e.kind === "citation-mismatch" && e.repoKey === "rk-test-0002");
  ok(e2.length === 1 && e2[0].ack === true && e2[0].autoAcked === "recheck-clean", "빈 정상 블록의 다음 답도 이전 불일치를 해소(recheck-clean)");
  B.flagEvidence(bad, ws2, "no-session", ws2, { ...ctx, repoKey: "rk-test-0003" });
  B.flagEvidence(["[지적 목록 v2]", "[지적 목록 끝]", "검증: 통과"].join("\n"), ws2, "no-session", ws2, { ...ctx, repoKey: "rk-test-0004" });
  const e3 = CL.readIntegrityEvents().filter((e) => e.kind === "citation-mismatch" && e.repoKey === "rk-test-0003");
  ok(e3.length === 1 && e3[0].ack !== true, "다른 저장소 표식의 정상 답은 해소하지 않음(ab-1)"); }

console.log("[11] 배선 — 대조 루트는 상속 저장소 포함(repoKey 와 같은 해석)·재확인 루트 규칙 불변");
ok(src.includes("const citeRootsE9 = (() => { const r = [exec, ws]; try { const sr = resolveScoutRepo(ws, contractSnap).repo;"), "citeRootsE9=exec·ws·resolveScoutRepo(상속 포함)");
ok(src.includes("repoKey: repoKeySnapE9, citeRoots: citeRootsE9,") && src.includes("evidenceInfoLine(answer, exec, verifierSession, citeRootsE9, langSnap)"), "flagEvidence·정보 줄 모두 대조 루트 사용");
ok(src.includes("const roots9 = chCtx && Array.isArray(chCtx.citeRoots) && chCtx.citeRoots.length ? chCtx.citeRoots"), "flagEvidence 는 citeRoots 우선");
ok(src.indexOf("const citeRootsE9") < src.indexOf("const chRoots = [exec, ws];"), "대조 루트 계산은 재확인 루트 계산 앞(evidence-dispatch 소스 규칙과 무충돌)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
