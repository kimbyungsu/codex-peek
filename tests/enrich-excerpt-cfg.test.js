#!/usr/bin/env node
/**
 * 묶음 3 — 발췌 범위 옵션(D3) 시험.
 * 순수: 정규화·저장 관문·프리셋·문구·상수 동형 · 계약 뷰: 이 슬롯/반대 슬롯/기본값·이형 · 선정·판독: 파일 수·파일당 글자가 옵션대로 · 프롬프트 자료 줄 ·
 * e2e: 실행기가 주체의 계약값을 관문·스냅샷·어댑터 입력·시도 기록에 같은 값으로 쓰고(보내지 않은 파일 인용=제외), 재개는 동결 주체의 계약(ab-1) ·
 * 변환 재검사=시도에 영속된 cfg(옛 기록 부재=도입 전 상수) · 배선(소스 검사): 확장·배포 목록·README·체인.
 * 계획: docs/ENRICH-NEXT-AXES-PLAN-2026-09-20.md §2-3 · 결정 D-2026-09-20-enrich-excerpt-options.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p8xc_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MB = require("../bridge/map-bootstrap.js");
const ME = require("../bridge/map-enrich.js");
const MP = require("../bridge/map-pipeline.js");
const EP = require("../bridge/enrich-providers.js");
const EX = require("../bridge/enrich-excerpt-cfg.js");
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const READY = { selfReady: true, economyReady: true, precisionReady: true, autoReady: true };
const g = (repo, args) => cp.spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", windowsHide: true });
const lines = (n, tag) => Array.from({ length: n }, (_, i) => "// " + tag + " line " + (i + 1)).join("\n") + "\n";
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

console.log("[1] 순수 — 정규화·저장 관문·프리셋·문구·상수 동형");
{
  ok(EX.validExcerptCfg({ files: 10, charsPerFile: 3000 }) && !EX.validExcerptCfg({ files: 10 }) && !EX.validExcerptCfg({ files: 10, charsPerFile: 3000, x: 1 }) && !EX.validExcerptCfg({ files: 0, charsPerFile: 3000 }) && !EX.validExcerptCfg({ files: 21, charsPerFile: 3000 }) && !EX.validExcerptCfg({ files: 10, charsPerFile: 499 }) && !EX.validExcerptCfg({ files: 10, charsPerFile: 4001 }) && !EX.validExcerptCfg({ files: 10.5, charsPerFile: 3000 }) && !EX.validExcerptCfg(null) && !EX.validExcerptCfg([]), "닫힌 모양: 정확히 두 정수 키·범위(1~20 · 500~4,000)");
  ok(JSON.stringify(EX.normMapExcerpt({ mapExcerpt: { files: 8, charsPerFile: 2000 } })) === JSON.stringify({ files: 8, charsPerFile: 2000 }) && EX.normMapExcerpt({ mapExcerpt: { files: 99, charsPerFile: 2000 } }) === null && EX.normMapExcerpt({}) === null && EX.normMapExcerpt(null) === null, "계약 판독: 유효=사본·상한 밖/이형/부재=null(비슷한 값으로 고쳐 쓰지 않음)");
  const pi = EX.parseExcerptInput("12", "2500");
  ok(pi.ok && pi.cfg.files === 12 && pi.cfg.charsPerFile === 2500, "저장 관문: 문자열 숫자 입력 승인");
  ok(EX.parseExcerptInput("0", "3000").reason === "files-range" && EX.parseExcerptInput("21", "3000").reason === "files-range" && EX.parseExcerptInput("10", "499").reason === "chars-range" && EX.parseExcerptInput("10", "4001").reason === "chars-range" && EX.parseExcerptInput("a", "3000").reason === "not-integer" && EX.parseExcerptInput("1.5", "3000").reason === "not-integer" && EX.parseExcerptInput("", "3000").reason === "not-integer" && EX.parseExcerptInput(10, 3000).ok === true, "저장 관문: 상한 밖·정수 아님=사유와 함께 거부(저장 안 함)");
  ok(EX.MAP_EXCERPT_PRESETS.length === 4 && EX.presetKeyFor({ files: 8, charsPerFile: 2000 }) === "light" && EX.presetKeyFor({ files: 10, charsPerFile: 3000 }) === "recommended" && EX.presetKeyFor({ files: 15, charsPerFile: 4000 }) === "large" && EX.presetKeyFor({ files: 20, charsPerFile: 4000 }) === "max" && EX.presetKeyFor({ files: 9, charsPerFile: 3000 }) === null, "프리셋 4종(8/2,000 · 10/3,000 · 15/4,000 · 20/4,000)·직접 지정=null");
  ok(EX.MAP_EXCERPT_DEFAULT.files === 10 && EX.MAP_EXCERPT_DEFAULT.charsPerFile === 3000 && EX.presetKeyFor(EX.MAP_EXCERPT_DEFAULT) === "recommended", "기본값=권장 프리셋(사용자 결정 2026-09-20)");
  ok(EX.LEGACY_EXCERPT_CFG.files === EP.FILES_MAX && EX.LEGACY_EXCERPT_CFG.charsPerFile === EP.FILE_EXCERPT_MAX && EX.EXCERPT_FILES_MAX === EP.FILES_MAX && EX.EXCERPT_CHARS_MAX === EP.FILE_EXCERPT_MAX, "도입 전 상수·하드 상한=enrich-providers 상수와 동형(20·4,000)");
  ok(JSON.stringify(EX.cfgOrLegacy(undefined)) === JSON.stringify({ files: 20, charsPerFile: 4000 }) && JSON.stringify(EX.cfgOrLegacy({ files: 3, charsPerFile: 600 })) === JSON.stringify({ files: 3, charsPerFile: 600 }) && JSON.stringify(EX.effectiveExcerptCfg(undefined)) === JSON.stringify({ files: 10, charsPerFile: 3000 }), "판독 폴백=도입 전 상수 · 화면 폴백=기본값");
  ok(EX.excerptCfgText({ files: 10, charsPerFile: 3000 }, "ko") === "발췌 범위: 10파일 · 파일당 3,000자(권장)" && EX.excerptCfgText({ files: 10, charsPerFile: 3000 }, "en") === "Excerpt scope: 10 files · 3,000 chars per file (Recommended)" && /직접 지정/.test(EX.excerptCfgText({ files: 9, charsPerFile: 3000 }, "ko")) && /custom/.test(EX.excerptCfgText({ files: 9, charsPerFile: 3000 }, "en")), "문구 ko/en(프리셋 이름·직접 지정)");
  const frozen = (() => { try { EX.MAP_EXCERPT_DEFAULT.files = 1; return EX.MAP_EXCERPT_DEFAULT.files === 10; } catch { return true; } })();
  ok(frozen, "기본값·프리셋 상수는 동결(실행 중 변형 불가)");
}

console.log("[2] 계약 뷰 — 이 슬롯 우선·반대 언어 슬롯 상속·기본값·이형");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8xc_view_"));
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  const cf = (w, slot) => CL.contractFileFor(w, slot);
  const v0 = EX.mapExcerptView(ws, "ko", cf);
  ok(v0.raw === null && v0.source === "default" && v0.eff.files === 10 && v0.eff.charsPerFile === 3000 && v0.presetKey === "recommended" && v0.slot === "ko", "저장값 없음=기본값(권장)·출처 default");
  fs.writeFileSync(cf(ws, "en"), JSON.stringify({ scoutMode: "on", mapExcerpt: { files: 15, charsPerFile: 4000 } }));
  const v1 = EX.mapExcerptView(ws, "ko", cf);
  ok(v1.source === "other" && v1.eff.files === 15 && v1.presetKey === "large", "이 슬롯에 없고 반대 슬롯에 있으면 상속(프로젝트 사실 성격 — mapMode 동형)");
  fs.writeFileSync(cf(ws, "ko"), JSON.stringify({ scoutMode: "on", claude: ["규칙"], mapExcerpt: { files: 8, charsPerFile: 2000 } }));
  const v2 = EX.mapExcerptView(ws, "ko", cf);
  ok(v2.source === "own" && v2.eff.files === 8 && v2.eff.charsPerFile === 2000 && v2.presetKey === "light", "이 슬롯 명시값 우선");
  fs.writeFileSync(cf(ws, "ko"), JSON.stringify({ scoutMode: "on", mapExcerpt: { files: 50, charsPerFile: 2000 } }));
  const v3 = EX.mapExcerptView(ws, "ko", cf);
  ok(v3.source === "other" && v3.eff.files === 15, "이 슬롯 값이 상한 밖(이형)이면 미지정 취급 → 반대 슬롯/기본값(조용한 변형 없음)");
  fs.writeFileSync(cf(ws, "ko"), "{broken");
  ok(EX.mapExcerptView(ws, "ko", cf).source === "other", "손상 계약=미지정(실행 계속)");
  ok(EX.mapExcerptView(ws, "ko", () => { throw new Error("x"); }).source === "default" && EX.mapExcerptView(null, "ko", cf).source === "default" && EX.mapExcerptView(ws, "ko", null).source === "default", "경로 해석 실패·ws 없음·해석 함수 없음=기본값");
  ok(ME.excerptCfgFor(ws, "en").files === 15 && ME.excerptCfgFor(ws, "ko").files === 15, "실행기 판독(excerptCfgFor)=같은 뷰(en 슬롯 명시 15 · ko 는 상속)");
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "p8xc_viewB_"));
  ok(EX.mapExcerptView(wsB, "ko", cf).source === "default" && ME.excerptCfgFor(wsB, "ko").files === 10, "다른 프로젝트의 저장값은 섞이지 않는다(프로젝트별 분리)");
}

console.log("[3] 선정·판독 — 파일 수·파일당 글자가 옵션대로 · 프롬프트 자료 줄(침묵 상한 금지)");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p8xc_sel_"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  const files = Array.from({ length: 12 }, (_, i) => "src/m" + i + ".js");
  for (const f of files) fs.writeFileSync(path.join(repo, f), lines(60, f));
  const topo = { mapId: U(1), nodes: [{ id: U(2), label: "L", entityType: "module", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: files.map((p9) => ({ kind: "code", path: p9 })) }], edges: [] };
  ok(EP.excerptFilesFor(topo, files).length === 12 && EP.excerptFilesFor(topo, files, { files: 3, charsPerFile: 600 }).length === 3 && EP.excerptFilesFor(topo, files, { files: 99, charsPerFile: 600 }).length === 12, "파일 수=옵션(하드 상한 20 안) · cfg 없음=도입 전 상수(20) · 이형 cfg=도입 전 상수");
  ok(JSON.stringify(EP.excerptFilesFor(topo, files, { files: 3, charsPerFile: 600 })) === JSON.stringify(EP.excerptFilesFor(topo, files).slice(0, 3)), "옵션은 같은 순서(slice 앵커 우선)의 앞부분만 자른다(선정 규칙 무변경)");
  const rh = EP.excerptBodyFor(repo, "src/m0.js", { charsMax: 600 });
  ok(rh.ok && rh.mode === "head" && rh.body.length === 600 && EP.excerptBodyFor(repo, "src/m0.js").body.length === lines(60, "src/m0.js").length, "파일당 글자(첫머리)=charsMax · 미지정=하드 상한(원문이 그보다 짧으면 전체)");
  ok(EP.excerptBodyFor(repo, "src/m0.js", { charsMax: 99999 }).body.length === lines(60, "src/m0.js").length && EP.excerptBodyFor(repo, "src/m0.js", { charsMax: 99999 }).body.length <= EP.FILE_EXCERPT_MAX, "charsMax 는 하드 상한을 넘지 못한다");
  // 창 모드도 같은 글자 상한
  g(repo, ["init", "-q"]); g(repo, ["config", "user.email", "t@t"]); g(repo, ["config", "user.name", "t"]); g(repo, ["add", "-A"]); g(repo, ["commit", "-qm", "c1"]);
  const base = g(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const arr = lines(60, "src/m1.js").split("\n"); arr[29] = "// src/m1.js line 30 CHANGED"; fs.writeFileSync(path.join(repo, "src", "m1.js"), arr.join("\n"));
  const rw = EP.excerptBodyFor(repo, "src/m1.js", { baseRef: base, charsMax: 500 });
  const rwFull = EP.excerptBodyFor(repo, "src/m1.js", { baseRef: base });
  ok(rw.ok && rw.mode === "changed" && rw.body.length <= 500 && /\(일부\)$/.test(rw.label) && rwFull.mode === "changed" && !/\(일부\)/.test(rwFull.label) && rwFull.body.length > 500, "바뀐 부분 주변 창도 파일당 글자 상한=옵션(절단 시 제목에 '(일부)')");
  const pr = EP.buildEnrichPrompt({ repo, topo, changed: files, excerptCfg: { files: 3, charsPerFile: 600 } });
  const heads = (pr.match(/^### (.+)$/gm) || []).map((l) => l.slice(4).replace(/ \(.*\)$/, ""));
  ok(heads.length === 3 && pr.includes("(발췌 범위 3파일·파일당 600자 — 프로젝트 설정: 후보 12건 중 3건만 실림)"), "프롬프트=옵션 파일 수만 싣고 밀려난 후보를 자료 줄로 고지 " + JSON.stringify(heads));
  const prAll = EP.buildEnrichPrompt({ repo, topo, changed: files, excerptCfg: { files: 20, charsPerFile: 4000 } });
  ok((prAll.match(/^### (.+)$/gm) || []).length === 12 && !prAll.includes("(발췌 범위 ") && !/\(발췌 범위/.test(EP.buildEnrichPrompt({ repo, topo, changed: files })), "밀려난 후보가 없으면 자료 줄 없음(cfg 없음도 동일)");
  const body600 = pr.slice(pr.indexOf("### src/m0.js"), pr.indexOf("### src/m1.js"));
  ok(body600.includes("// src/m0.js line 1") && !body600.includes("// src/m0.js line 60"), "프롬프트 본문도 파일당 글자 상한대로(600자 안)");
  // 관문도 같은 cfg: 코드 파일이 옵션 상한 밖으로 밀리면 답 불가
  const docs = Array.from({ length: 4 }, (_, i) => "notes-" + i + ".md");
  for (const d of docs) fs.writeFileSync(path.join(repo, d), "# n\n");
  const topoD = { mapId: U(1), nodes: [{ id: U(2), label: "L", entityType: "module", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/m0.js" }] }], edges: [] };
  ok(ME.answerableInput(repo, topoD, [...docs, "src/m5.js"], { cfg: { files: 3, charsPerFile: 600 } }) === false && ME.answerableInput(repo, topoD, [...docs, "src/m5.js"], { cfg: { files: 20, charsPerFile: 4000 } }) === true && ME.answerableInput(repo, topoD, [...docs, "src/m5.js"]) === true, "관문: 옵션 3파일이면 문서 4개 뒤 코드는 발췌 밖=답 불가 · 20파일이면 가능 · cfg 없음=도입 전 상수");
}

// e2e 공통 준비: git 저장소 + 3트랙 계약 + topology + 큐 + self 동의
function setupWs(tag, mapExcerpt) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p8xc_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(ws, "src", "f" + i + ".js"), lines(30, "f" + i));
  g(ws, ["init", "-q"]); g(ws, ["config", "user.email", "t@t"]); g(ws, ["config", "user.name", "t"]);
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c1"]);
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on", ...(mapExcerpt ? { mapExcerpt } : {}) }));
  MB.grantConsent(ws, "test");
  const r0 = MR.initTopologyForBootstrap(ws);
  if (r0.st !== "created") throw new Error("init 실패: " + r0.st);
  const nodeId = MR.readTopoExFor(ws).topo.nodes[0].id;
  if (MB.ensureQueue(ws, PM) !== true) throw new Error("queue");
  ME.grantEnrichConsent(ws, { ws, slot: "ko", selfAuto: true, paidMode: null });
  return { ws, nodeId };
}
const touchAll = (ws) => { for (let i = 0; i < 5; i++) { const arr = lines(30, "f" + i).split("\n"); arr[14] = "// f" + i + " line 15 CHANGED"; fs.writeFileSync(path.join(ws, "src", "f" + i + ".js"), arr.join("\n")); } };

console.log("[4] e2e — 실행기: 주체 계약의 옵션이 관문·스냅샷·어댑터 입력·시도 기록에 같은 값 · 보내지 않은 파일 인용=제외");
{
  const { ws, nodeId } = setupWs("run", { files: 2, charsPerFile: 600 });
  touchAll(ws);
  let seen = null;
  const ad = (ctx) => {
    seen = { cfg: ctx.excerptCfg, files: ctx.excerptBodies instanceof Map ? [...ctx.excerptBodies.keys()] : null, lens: ctx.excerptBodies instanceof Map ? [...ctx.excerptBodies.values()].map((b) => (typeof b === "string" ? b.length : -1)) : null, prompt: EP.buildEnrichPrompt(ctx) };
    const sent = seen.files;
    const unsent = ["src/f0.js", "src/f1.js", "src/f2.js", "src/f3.js", "src/f4.js"].find((f) => !sent.includes(f));
    return { ok: true, result: { schema: "enrich-result-v1", items: [
      { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: sent[0], note: "in" } }, evidence: [{ file: sent[0], quote: sent[0].replace("src/", "// ").replace(".js", "") + " line 15 CHANGED" }] },
      { op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: unsent, note: "unsent" } }, evidence: [{ file: unsent, quote: unsent.replace("src/", "// ").replace(".js", "") + " line 15 CHANGED" }] },
    ] } };
  };
  const r = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: { self: ad }, trigger: "test" });
  const j = ME.readEnrichJob(ws); const a = j.st === "ok" && j.job.attempts.length ? j.job.attempts[j.job.attempts.length - 1] : null;
  ok(r.outcome === "applied" && r.applied === 1, "실행 완주·보낸 파일 인용 항목 적용 (" + r.outcome + "/" + r.reason + ")");
  ok(!!seen && seen.cfg && seen.cfg.files === 2 && seen.cfg.charsPerFile === 600 && seen.files.length === 2 && seen.lens.every((n) => n >= 0 && n <= 600), "어댑터 입력=계약 옵션(2파일·600자): 스냅샷 2건·각 600자 이하 " + JSON.stringify(seen && { cfg: seen.cfg, files: seen.files, lens: seen.lens }));
  ok(!!seen && (seen.prompt.match(/^### (.+)$/gm) || []).length === 2 && seen.prompt.includes("(발췌 범위 2파일·파일당 600자 — 프로젝트 설정: 후보 5건 중 2건만 실림)"), "발송문=2건+밀려난 후보 고지");
  ok(!!a && a.excerptCfg && a.excerptCfg.files === 2 && a.excerptCfg.charsPerFile === 600 && Object.keys(a.excerptCfg).length === 2, "시도 기록에 발송 시점 옵션(excerptCfg) 영속");
  ok(!!a && Array.isArray(a.droppedItems) && a.droppedItems.length === 1 && a.droppedItems[0].detail && a.droppedItems[0].detail.kind === "evidence-outside" && a.droppedItems[0].detail.sent === false, "옵션 상한에 밀려 보내지 않은 파일의 인용=제외(sent:false)");
  ok(!!a && a.citation && a.citation.filesSent === 2, "인용 측정의 보낸 파일 수=옵션(2)");
  ok(j.st === "ok", "strict 판독 정상(excerptCfg 포함)");
  // 저장값 없음 → 기본값(권장 10·3,000)이 시도에 남는다
  const { ws: ws2, nodeId: n2 } = setupWs("def", null);
  touchAll(ws2);
  let seen2 = null;
  const ad2 = (ctx) => { seen2 = { cfg: ctx.excerptCfg, n: ctx.excerptBodies instanceof Map ? ctx.excerptBodies.size : -1 }; return { ok: true, result: { schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: n2, payload: { evidence: { kind: "code", ref: "src/f0.js", note: "d" } }, evidence: [{ file: "src/f0.js", quote: "// f0 line 15 CHANGED" }] }] } }; };
  const r2 = ME.runEnrich(ws2, { ws: ws2, slot: "ko", mode: "self", readiness: READY, adapters: { self: ad2 }, trigger: "test" });
  const a2 = ME.readEnrichJob(ws2).job.attempts.slice(-1)[0];
  ok(r2.outcome === "applied" && seen2 && seen2.cfg.files === 10 && seen2.cfg.charsPerFile === 3000 && seen2.n === 5 && a2.excerptCfg.files === 10 && a2.excerptCfg.charsPerFile === 3000, "저장값 없음=기본값(권장 10·3,000)이 어댑터 입력·시도 기록에 실림(변경 5건 전부 발송)");
}

console.log("[5] 재개(ab-1) — 다른 프로젝트 창(호출자)이 이어받아도 작업에 동결된 주체의 옵션을 쓴다");
{
  const { ws: wsA, nodeId } = setupWs("subjA", { files: 2, charsPerFile: 600 });
  touchAll(wsA);
  const okA = ME.runEnrich(wsA, { ws: wsA, slot: "ko", mode: "self", readiness: READY, adapters: { self: () => ({ ok: true, result: { schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/f0.js", note: "a" } }, evidence: [{ file: "src/f0.js", quote: "// f0 line 15 CHANGED" }] }] } }) }, trigger: "test" });
  ok(okA.outcome === "applied", "(전제) 주체 A(옵션 2파일)로 1라운드 완주");
  // 사망 창 재현: 마지막 self 시도가 running 인 채 죽음 → 재개는 self 중단 재실행(같은 실행에서 새 시도) — 호출자는 다른 창(B: 옵션 5파일)
  const jS = ME.readEnrichJob(wsA).job;
  const rewound = { ...jS, phase: "open", attempts: jS.attempts.map((a) => { const b = { attemptId: a.attemptId, provider: a.provider, consentGen: a.consentGen, phase: "running", startedAt: a.startedAt, excerptBase: a.excerptBase, excerptCfg: a.excerptCfg }; return b; }) };
  delete rewound.sourceFp; delete rewound.finishedAt;
  ok(ME.validateJob(rewound) === null, "(전제) running 시도 되감기=strict 승인");
  fs.writeFileSync(ME.jobFileFor(wsA), JSON.stringify(rewound, null, 1));
  ok(MB.ensureQueue(wsA, PM) === true, "(전제) 큐 재작성");
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "p8xc_subjB_"));
  fs.writeFileSync(CL.contractFileFor(wsB, "ko"), JSON.stringify({ scoutMode: "on", mapExcerpt: { files: 5, charsPerFile: 4000 } }));
  ME.grantEnrichConsent(wsA, { ws: wsB, slot: "ko", selfAuto: true, paidMode: null }); // 호출자 B 도 동의가 있어야 '동의 때문에' 멈추지 않는다 — 옵션만 갈라 본다
  let seenB = null;
  const adB = (ctx) => { seenB = { cfg: ctx.excerptCfg, n: ctx.excerptBodies instanceof Map ? ctx.excerptBodies.size : -1 }; return { ok: true, result: { schema: "enrich-result-v1", items: [{ op: "add_evidence", targetId: nodeId, payload: { evidence: { kind: "code", ref: "src/f0.js", note: "b" } }, evidence: [{ file: "src/f0.js", quote: "// f0 line 15 CHANGED" }] }] } }; };
  const rB = ME.runEnrich(wsA, { ws: wsB, slot: "ko", mode: "self", readiness: READY, adapters: { self: adB }, trigger: "test" });
  const jB = ME.readEnrichJob(wsA); const aB = jB.st === "ok" ? jB.job.attempts.slice(-1)[0] : null;
  ok(!!seenB && seenB.cfg.files === 2 && seenB.cfg.charsPerFile === 600 && seenB.n === 2, "재개 호출의 어댑터 입력=동결 주체 A 의 옵션(2파일) — 호출자 B(5파일) 아님 (" + rB.outcome + "/" + rB.reason + " · " + JSON.stringify(seenB) + ")");
  ok(!!aB && aB.excerptCfg && aB.excerptCfg.files === 2 && CL.normWs(jB.job.configWs) === CL.normWs(wsA), "새 시도 기록도 주체 A 의 옵션·작업 주체 불변");
}

console.log("[6] 변환 재검사 — 시도에 영속된 옵션(옛 기록 부재=도입 전 상수)");
{
  const { ws } = setupWs("conv", null);
  // 첫 600자가 빈 줄이고 그 뒤에 코드가 있는 파일(첫머리 판독: 500자면 비어 보이고 4,000자면 코드가 보인다) — 기준점 없음(excerptBase null=첫머리 판독)
  fs.writeFileSync(path.join(ws, "src", "deep.js"), "\n".repeat(600) + "module.exports = 7;\n");
  g(ws, ["add", "-A"]); g(ws, ["commit", "-qm", "c2"]);
  if (MB.ensureQueue(ws, PM) !== true) throw new Error("queue");
  const topoB = MR.readTopoExFor(ws).topo;
  const idxB = MP.decisionIndexFor(ws, topoB.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topoB), idxB);
  const gen = ME.findGrant(ME.readEnrichConsent(ws), ws, "ko").gen;
  const startedAt = new Date().toISOString();
  const jobKey = ME.jobKeyOf(topoB.mapId, ah, null);
  const fileNode = (id) => ({ op: "add_node", payload: { node: { id, label: "깊은 파일", entityType: "file", roles: [], state: { lifecycle: "active", implementation: "runtime", confidence: "candidate" }, anchors: [{ kind: "code", path: "src/deep.js" }] } }, evidence: [{ file: "src/deep.js", quote: "module.exports = 7;" }] });
  const mkJob = (attemptExtra) => ({ schema: "enrich-job-v2", jobKey, mapId: topoB.mapId, authorityHash: ah, decisionContextHash: null, mode: "self", configWs: CL.normWs(ws), slot: "ko", phase: "open", startedAt, attempts: [{ attemptId: 0, provider: "self", consentGen: gen, phase: "applying", startedAt, excerptBase: null, ...attemptExtra, results: { schema: "enrich-result-v1", items: [fileNode("11111111-2222-4333-8444-555555555555")] }, cursor: { nextIndex: 0, rev: 0, appliedPatchIds: [] } }] });
  ok(ME.validateJob(mkJob({ excerptCfg: { files: 1, charsPerFile: 500 } })) === null && ME.validateJob(mkJob({})) === null && ME.validateJob(mkJob({ excerptCfg: { files: 1 } })) !== null && ME.validateJob(mkJob({ excerptCfg: { files: 1, charsPerFile: 9999 } })) !== null && ME.validateJob(mkJob({ excerptCfg: null })) !== null, "strict: excerptCfg=닫힌 모양만 승인·부재(옛 기록) 허용·이형/상한 밖/null=손상");
  const noCall = { self: () => { throw new Error("호출되면 안 됨"); } };
  ok(ME.updateEnrichJob(ws, () => mkJob({ excerptCfg: { files: 1, charsPerFile: 500 } })).ok === true, "(전제) 결과 영속 직후 상태(발송 시점 옵션 500자)");
  const r1 = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: noCall, trigger: "test" });
  const j1 = ME.readEnrichJob(ws).job; const a1 = j1.attempts[0];
  ok(r1.outcome !== "applied" && Array.isArray(a1.droppedItems) && a1.droppedItems.length === 1 && /convert-invalid: add_node: anchor 판독 불가·빈 본문/.test(a1.droppedItems[0].reason), "발송 시점 옵션이 500자면 변환 재검사도 500자 첫머리(빈 본문)로 본다 — 담당이 받은 발췌와 같은 규칙 (" + r1.outcome + "/" + r1.reason + " · " + JSON.stringify(a1.droppedItems) + ")");
  if (MB.ensureQueue(ws, PM) !== true) throw new Error("queue2");
  ok(ME.updateEnrichJob(ws, () => mkJob({})).ok === true, "(전제) 옛 기록(excerptCfg 부재) 재현");
  const r2 = ME.runEnrich(ws, { ws, slot: "ko", mode: "self", readiness: READY, adapters: noCall, trigger: "test" });
  ok(r2.outcome === "applied" && r2.applied === 1 && MR.readTopoExFor(ws).topo.nodes.some((n) => n.entityType === "file" && n.id === ME.detFileNodeId(topoB.mapId, "src/deep.js")), "옛 기록(옵션 부재)=도입 전 상수(4,000자)로 재검사 → 코드가 보여 적용 (" + r2.outcome + "/" + r2.reason + ")");
}

console.log("[7] 배선(소스 검사) — 실행기 단일 경로·확장·배포 목록 3사본·README ko/en·체인");
{
  const me = fs.readFileSync(path.join(ROOT, "bridge", "map-enrich.js"), "utf8");
  const gateCalls = me.split("\n").filter((l) => /answerableInput\(repo, (topo|st\.topo), /.test(l) && !/^function /.test(l));
  ok(gateCalls.length === 4 && gateCalls.every((c) => /cfg: (excerptCfgFor\(|cfg9)/.test(c)), "실행기의 관문 호출 4곳 전부 발췌 범위 cfg 전달(" + gateCalls.length + "곳)");
  ok(/excerptCfg: \{ files: cfg9\.files, charsPerFile: cfg9\.charsPerFile \}/.test(me) && /excerptFilesFor\(st\.topo, st\.changed, cfg9\)/.test(me) && /excerptBaseRef: baseRef9, excerptCfg: cfg9 \}/.test(me) && /baseRef: baseRef9, excerptCfg: cfg9 \}, \{ perItem: true \}/.test(me), "runAttempt: 시도 영속·스냅샷·어댑터 입력·응답 검증이 같은 cfg9");
  ok(/excerptCfg: a\.excerptCfg \}/.test(me) && /"excerptCfg", "sourceFp"/.test(me) && /return "attempt excerptCfg"/.test(me), "변환=시도의 excerptCfg · ATTEMPT_KEYS·strict 검사");
  const ep = fs.readFileSync(path.join(ROOT, "bridge", "enrich-providers.js"), "utf8");
  ok(/function excerptSelectionFor\(topo, changed, cfg\)/.test(ep) && /function excerptFilesFor\(topo, changed, cfg\)/.test(ep) && /excerptSelectionFor\(ctx\.topo, ctx\.changed, ctx\.excerptCfg\)/.test(ep) && /charsMax: cfgP\.charsPerFile/.test(ep), "프롬프트·선정·판독이 cfg 를 소비");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(ext.includes('m?.type === "setMapExcerpt"') && ext.includes("async function setMapExcerptFromUi(") && ext.includes("EX9.parseExcerptInput(input.files, input.charsPerFile)") && ext.includes("if (input === null) patch = { mapExcerpt: { files: EX9.MAP_EXCERPT_DEFAULT.files, charsPerFile: EX9.MAP_EXCERPT_DEFAULT.charsPerFile } };"), "확장: 저장 핸들러(관문 거부·권장 기본값 명시 저장)");
  ok(ext.includes('mapExcerpt: (() => { if (!ws) return null; try { if (loadContract(ws).scoutMode !== "on") return null;') && ext.includes("EX9.mapExcerptView(ws, loadLangExt(), contractFileFor)"), "확장: 상태에 옵션 뷰(3트랙에서만)");
  ok(ext.includes('T("발췌 범위 — 담당에게 보내는 파일 수와 파일당 글자","Excerpt scope — how many files and how many characters per file go to the provider")') && ext.includes('vscode.postMessage({type:"setMapExcerpt", files: fi.value, charsPerFile: ci.value') && ext.includes('vscode.postMessage({type:"setMapExcerpt", reset:true') && ext.includes('T("프리셋:","Presets:")'), "웹뷰: 담당 줄 아래 발췌 범위 줄(ko/en·프리셋·저장·기본값)");
  ok(ext.includes("const excerptOptionNote = (() => { try {") && ext.includes('tE("발췌 범위 —", "Excerpt scope —")'), "모드 안내 패널에 옵션 문단(상수에서 문장 생성)");
  const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");
  const hs = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8");
  const mc = fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8");
  ok(inst.includes('"enrich-excerpt-cfg.js"') && hs.includes('"enrich-excerpt-cfg.js"') && mc.includes('"enrich-excerpt-cfg.js"') && fs.existsSync(path.join(ROOT, "bridge", "enrich-excerpt-cfg.js")), "배포 목록 3사본+실물");
  const rk = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const re = fs.readFileSync(path.join(ROOT, "docs", "README.en.md"), "utf8");
  ok(rk.includes("**발췌 범위**") && rk.includes("권장 10/3,000(기본값)") && re.includes("**Excerpt scope**") && re.includes("Recommended 10/3,000 (default)"), "README ko/en 한 줄(프리셋·기본값)");
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  ok(pkg.includes("node tests/enrich-excerpt-cfg.test.js"), "체인 등록");
  const dec = fs.readFileSync(path.join(ROOT, "docs", "DECISIONS.md"), "utf8");
  ok(dec.includes("## D-2026-09-20-enrich-excerpt-options"), "결정 장부 항목");
}

console.log("[8] 화면 전이(웹뷰 조각을 메모리 DOM 으로 실행) — 초안 보존·저장 슬롯 결속·권장 기본값 명시 저장(검증 1판 blocker 3건)");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8").split(/\r?\n/);
  const a0 = ext.findIndex((l) => l.includes("묶음 3(D3) — 발췌 범위(담당에게"));
  const b0 = ext.findIndex((l, i) => i > a0 && l.trim() === "});" && ext[i - 1].includes("row.appendChild(pr);"));
  ok(a0 > 0 && b0 > a0, "(전제) 웹뷰 조각 추출 " + a0 + "-" + b0);
  const frag = ext.slice(a0, b0 + 1).join("\n");
  const mkEl = (tag) => ({ tag, children: [], style: {}, _h: {}, value: "", id: "", textContent: "", classList: { add() {}, toggle() {} }, appendChild(c) { this.children.push(c); return c; }, replaceChildren() { this.children = []; }, addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); }, fire(t) { (this._h[t] || []).forEach((f) => f()); } });
  const posted = [];
  const mkRow = () => mkEl("div");
  const findAll = (el, pred, acc = []) => { for (const c of el.children || []) { if (pred(c)) acc.push(c); findAll(c, pred, acc); } return acc; };
  const byId = (root, id) => findAll(root, (c) => c.id === id)[0];
  const btn = (root, txt) => findAll(root, (c) => c.tag === "button" && c.textContent === txt)[0];
  const textOf = (root) => findAll(root, () => true).map((c) => c.textContent || c.text || "").join(" ");
  const script = "var mxDraft=null; return function render(d, row, UI_EN){ " + frag + " return mxDraft; };";
  const render = new Function("document", "T", "safe", "vscode", script)(
    { createElement: mkEl, createTextNode: (t) => ({ text: t, textContent: t }) },
    (ko, en) => ko, (f) => f(), { postMessage: (m) => posted.push(m) });
  const base = (over) => ({ mapExcerpt: { ws: "D:/proj/A", slot: "ko", raw: null, source: "default", eff: { files: 10, charsPerFile: 3000 }, presetKey: "recommended", bounds: { filesMin: 1, filesMax: 20, charsMin: 500, charsMax: 4000 }, presets: EX.MAP_EXCERPT_PRESETS, ...(over || {}) } });
  // ② 편집 → 주기 갱신(같은 상태 재전달) → 입력 유지 → 저장 메시지=편집값
  let row = mkRow(); render(base(), row, false);
  const fi1 = byId(row, "mxFiles"), ci1 = byId(row, "mxChars");
  ok(fi1 && ci1 && fi1.value === "10" && ci1.value === "3000", "첫 렌더=실효값 10/3000");
  fi1.value = "8"; fi1.fire("input"); ci1.value = "2000"; ci1.fire("input");
  row = mkRow(); const draft1 = render(base(), row, false);
  const fi2 = byId(row, "mxFiles"), ci2 = byId(row, "mxChars");
  ok(fi2.value === "8" && ci2.value === "2000" && draft1 && draft1.files === "8" && /미저장 입력 있음/.test(textOf(row)), "같은 상태가 다시 와도(15초 갱신) 편집값 유지·미저장 표시");
  btn(row, "저장").fire("click");
  const m1 = posted[posted.length - 1];
  ok(m1 && m1.type === "setMapExcerpt" && m1.files === "8" && m1.charsPerFile === "2000" && m1.lang === "ko" && m1.ws === "D:/proj/A", "저장 메시지=편집값·저장 슬롯=표시 데이터 슬롯(ko)·저장 프로젝트=표시 프로젝트 " + JSON.stringify(m1));
  // 저장이 확인되면(정본=초안) 초안 소거
  row = mkRow(); const draft2 = render(base({ raw: { files: 8, charsPerFile: 2000 }, source: "own", eff: { files: 8, charsPerFile: 2000 }, presetKey: "light" }), row, false);
  ok(draft2 === null && byId(row, "mxFiles").value === "8" && !/미저장 입력 있음/.test(textOf(row)), "저장값이 초안과 같아지면 초안 소거·미저장 표시 사라짐");
  // 프리셋 클릭=초안(갱신에도 유지)
  btn(row, "대형 · 15/4,000").fire("click");
  row = mkRow(); const draft3 = render(base({ raw: { files: 8, charsPerFile: 2000 }, source: "own", eff: { files: 8, charsPerFile: 2000 }, presetKey: "light" }), row, false);
  ok(draft3 && draft3.files === "15" && byId(row, "mxFiles").value === "15" && byId(row, "mxChars").value === "4000", "프리셋 클릭도 초안으로 남아 갱신에 유지");
  // ① 언어 전환 보류: 한국어 HTML(UI_EN=false)인데 en 슬롯 데이터가 오면 저장 슬롯=en(표시 데이터 슬롯)·초안(ko)은 버림·안내
  row = mkRow(); const draft4 = render(base({ slot: "en", raw: { files: 20, charsPerFile: 4000 }, source: "own", eff: { files: 20, charsPerFile: 4000 }, presetKey: "max" }), row, false);
  ok(draft4 === null && byId(row, "mxFiles").value === "20" && /저장 대상: en 슬롯/.test(textOf(row)), "슬롯이 바뀌면 다른 슬롯 초안은 버리고 저장 대상 슬롯을 안내");
  btn(row, "저장").fire("click");
  const m2 = posted[posted.length - 1];
  ok(m2.lang === "en" && m2.files === "20" && m2.charsPerFile === "4000", "언어 전환 보류 중 저장=표시 데이터의 슬롯(en)에만 — ko 저장값을 덮지 않음 " + JSON.stringify(m2));
  // ③ 권장 기본값 버튼=명시 저장 메시지(reset)·초안 소거 · 핸들러는 권장값을 이 슬롯에 명시 저장(소스)·효과=반대 슬롯 값이 있어도 권장값
  fi1.value = "9"; // (이전 렌더 입력 — 무관)
  row = mkRow(); render(base(), row, false); byId(row, "mxFiles").value = "9"; byId(row, "mxFiles").fire("input");
  btn(row, "권장 기본값으로").fire("click");
  const m3 = posted[posted.length - 1];
  row = mkRow(); const draft5 = render(base(), row, false);
  ok(m3.type === "setMapExcerpt" && m3.reset === true && m3.lang === "ko" && draft5 === null, "권장 기본값 버튼=reset 메시지(표시 슬롯)·초안 소거 " + JSON.stringify(m3));
  const extSrc = ext.join("\n");
  ok(extSrc.includes("if (input === null) patch = { mapExcerpt: { files: EX9.MAP_EXCERPT_DEFAULT.files, charsPerFile: EX9.MAP_EXCERPT_DEFAULT.charsPerFile } };") && !extSrc.includes("patch = { mapExcerpt: undefined }"), "핸들러: reset=권장 기본값을 이 슬롯에 명시 저장(키 삭제 아님)");
  const wsR = fs.mkdtempSync(path.join(os.tmpdir(), "p8xc_reset_"));
  fs.writeFileSync(CL.contractFileFor(wsR, "ko"), JSON.stringify({ scoutMode: "on", claude: ["규칙"], mapExcerpt: { files: 8, charsPerFile: 2000 } }));
  fs.writeFileSync(CL.contractFileFor(wsR, "en"), JSON.stringify({ scoutMode: "on", mapExcerpt: { files: 20, charsPerFile: 4000 } }));
  ok(CL.updateContractPatch(wsR, "ko", { mapExcerpt: { files: EX.MAP_EXCERPT_DEFAULT.files, charsPerFile: EX.MAP_EXCERPT_DEFAULT.charsPerFile } }).ok === true, "(전제) 핸들러와 같은 patch 로 ko 저장");
  const vR = EX.mapExcerptView(wsR, "ko", CL.contractFileFor);
  const koC = JSON.parse(fs.readFileSync(CL.contractFileFor(wsR, "ko"), "utf8"));
  ok(vR.source === "own" && vR.eff.files === 10 && vR.eff.charsPerFile === 3000 && JSON.stringify(koC.claude) === JSON.stringify(["규칙"]) && koC.scoutMode === "on" && EX.mapExcerptView(wsR, "en", CL.contractFileFor).eff.files === 20, "효과: 반대 슬롯(en 20/4,000)이 있어도 ko 는 권장 10/3,000 · 다른 필드 보존(ab-2) · en 슬롯 불변");
  // 확인 검증 2판 blocker(ab-1): 멀티루트 창에서 대시보드 대상이 A→B 로 바뀌면 A 의 초안은 버려지고 저장 메시지는 표시 프로젝트를 싣는다
  row = mkRow(); render(base(), row, false); byId(row, "mxFiles").value = "8"; byId(row, "mxFiles").fire("input"); byId(row, "mxChars").value = "2000"; byId(row, "mxChars").fire("input");
  row = mkRow(); const draftB = render(base({ ws: "D:/proj/B", raw: { files: 5, charsPerFile: 1000 }, source: "own", eff: { files: 5, charsPerFile: 1000 }, presetKey: null }), row, false);
  ok(draftB === null && byId(row, "mxFiles").value === "5" && byId(row, "mxChars").value === "1000" && !/미저장 입력 있음/.test(textOf(row)), "프로젝트가 바뀌면(A→B) A 의 미저장 초안은 버리고 B 의 저장값을 보인다");
  btn(row, "저장").fire("click");
  const mB = posted[posted.length - 1];
  ok(mB.ws === "D:/proj/B" && mB.files === "5" && mB.charsPerFile === "1000" && mB.lang === "ko", "B 화면의 저장 메시지=B 프로젝트·B 값(A 초안 아님) " + JSON.stringify(mB));
  ok(extSrc.includes("setMapExcerptFromUi(displayedProjectWs(m.ws),") && extSrc.includes("function displayedProjectWs(wsIn: unknown): string | null {") && extSrc.includes("return folders.some((f) => normWs(f) === normWs(wsIn)) ? wsIn : null;") && extSrc.includes('if (typeof wsIn !== "string" || !wsIn) return dashboardWorkspace();'), "핸들러: 저장 대상=메시지의 표시 프로젝트(이 창의 폴더일 때만 · 아니면 저장 안 함·안내 · 표식 없으면 대시보드 대상)");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
