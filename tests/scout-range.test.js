"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 4 · 4-가] 정찰 씨앗 범위(E8) · 지도 요약 항목 단위 추출(E9).
 *  E8: git 저장소면 씨앗=직전 지도 기준 커밋..HEAD 변경 파일 ∪ 작업트리 변경 · diff=기준 커밋 대비(작업트리 포함) ·
 *      기준 커밋이 없어졌거나 조상이 아니면 지금 방식+꾸러미·지도 메타에 사유 · 직전 지도 없음·무이력 지도·같은 HEAD=지금 방식.
 *  E9: 'high' 목록 머리 줄과 그보다 깊게 들여쓴 이어지는 줄이 한 항목(하위 불릿 "   - 경로: …"의 경로 포함) ·
 *      같거나 얕은 들여쓰기의 다음 줄·제목·구획 표기·빈 줄에서 끝 · 구획 규칙(①~④만)·줄 글자 상한 그대로.
 * 격리: 임시 CODEX_BRIDGE_HOME · 임시 git 저장소 — 실제 AI 호출 없음(정찰 담당은 목).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scout-range-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const SPK = require("../bridge/scope-package.js");
const SS = require("../bridge/scout-store.js");
const SP = require("../bridge/scout-providers.js");
const CL = require("../bridge/contract-lib.js");
const { renderPackageMarkdown } = require("../bridge/scope-package-core.js");

let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);
const mkRepo = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "scout-range-repo-"));
  const g = (...a) => { const x = cp.spawnSync("git", ["-c", "core.autocrlf=false", "-C", r, ...a], { encoding: "utf8", windowsHide: true }); assert.strictEqual(x.status, 0, a.join(" ") + ": " + x.stderr); return String(x.stdout || "").trim(); };
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.writeFileSync(path.join(r, "a.js"), "export const alpha = 1;\n"); g("add", "."); g("commit", "-qm", "init");
  return { r, g, w: (f, s) => { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), s); } };
};
const saveMapAt = (r, head) => SS.saveMap(r, "self", "## ① 직접 영향 후보\n\n1. **[high] a**\n   - 경로: `a.js`\n", { head, seedFiles: [] });

t("E8 — 직전 지도 없음=지금 방식(작업트리 변경만·간주 기준 줄 없음)", () => {
  const { r, w } = mkRepo();
  w("b.js", "b\n");
  const p = SPK.collectPackage(r);
  assert.deepStrictEqual(p.seeds, ["b.js"]);
  assert.strictEqual(p.basisNote, "");
  assert.deepStrictEqual(p.meta.seedRange, { mode: "worktree" });
});

t("E8 — ★직전 지도 뒤 커밋된 변경도 씨앗(작업트리 변경과 합침·중복 없음) · diff=기준 커밋 대비(커밋+스테이지+작업트리) · 간주 기준 줄 · 메타 기록", () => {
  const { r, g, w } = mkRepo();
  const h0 = g("rev-parse", "HEAD");
  saveMapAt(r, h0);
  w("b.js", "export function bravoCommitted() {}\n"); w("a.js", "export const alpha = 2;\n"); g("add", "."); g("commit", "-qm", "b");
  w("a.js", "export const alpha = 3;\n"); // 커밋 뒤 다시 고친 파일=작업트리와 겹침
  w("c.js", "c\n"); // 추적 안 됨
  w("d.js", "export const deltaStaged = 1;\n"); g("add", "d.js"); // 스테이지
  const p = SPK.collectPackage(r);
  const s = new Set(p.seeds);
  assert.ok(s.has("b.js") && s.has("a.js") && s.has("c.js") && s.has("d.js") && p.seeds.length === 4, "씨앗 " + JSON.stringify(p.seeds));
  assert.ok(p.seeds.indexOf("c.js") < p.seeds.indexOf("b.js"), "작업트리 변경이 먼저(지금 고치는 것 우선)");
  assert.ok(p.diff.includes("bravoCommitted") && p.diff.includes("alpha = 3") && p.diff.includes("deltaStaged"), "diff=기준 커밋 대비 — 커밋된 변경·작업트리·스테이지 모두");
  assert.ok(/^직전 지도\(기준 커밋 [0-9a-f]{7}\) 이후 커밋된 변경 2개\(작업트리와 겹치지 않는 것 1개\) \+ 작업트리 변경 3개/.test(p.basisNote), p.basisNote);
  assert.deepStrictEqual(p.meta.seedRange, { mode: "since-map", base: h0, committed: 2 });
  const md = renderPackageMarkdown(p, "ko");
  assert.ok(md.includes("(간주 기준: 직전 지도(기준 커밋 " + h0.slice(0, 7) + ")"), "꾸러미에 범위 표기");
  assert.ok(p.meta.seedHashes && typeof p.meta.seedHashes["b.js"] === "string", "커밋된 씨앗도 신선도 기준선에 포함");
});

t("E8 — 직전 지도 뒤 커밋이 없으면(같은 HEAD) 지금 방식 · 무이력 지도·옛 메타(head 없음)도 지금 방식", () => {
  const { r, g, w } = mkRepo();
  saveMapAt(r, g("rev-parse", "HEAD"));
  w("b.js", "b\n");
  const p = SPK.collectPackage(r);
  assert.deepStrictEqual(p.seeds, ["b.js"]);
  assert.strictEqual(p.basisNote, "");
  assert.strictEqual(p.meta.seedRange.sameHead, true);
  saveMapAt(r, "0000000");
  assert.deepStrictEqual(SPK.collectPackage(r).meta.seedRange, { mode: "worktree" }, "무이력 지도");
  SS.saveMap(r, "self", "x", {});
  assert.deepStrictEqual(SPK.collectPackage(r).meta.seedRange, { mode: "worktree" }, "head 없는 옛 메타");
});

t("E8 — ★기준 커밋이 없어졌거나(이력 재작성) 지금 HEAD 의 조상이 아니면 지금 방식으로 떨어지고 사유를 꾸러미·메타에 적음", () => {
  const { r, g, w } = mkRepo();
  w("b.js", "b\n"); g("add", "."); g("commit", "-qm", "b");
  const h1 = g("rev-parse", "HEAD");
  saveMapAt(r, h1);
  g("reset", "-q", "--hard", "HEAD~1"); // 이력 재작성 — h1 은 남아 있지만 조상이 아님
  w("e.js", "e\n");
  const p = SPK.collectPackage(r);
  assert.deepStrictEqual(p.seeds, ["e.js"], "작업트리 변경만");
  assert.ok(p.basisNote.includes("직전 지도 기준 커밋 " + h1.slice(0, 7)) && p.basisNote.includes("조상이 아님") && p.basisNote.includes("작업트리 변경만 봤다"), p.basisNote);
  assert.strictEqual(p.meta.seedRange.mode, "worktree"); assert.strictEqual(p.meta.seedRange.prevHead, h1);
  assert.ok(!p.diff.includes("+b"), "diff 도 지금 방식");
  saveMapAt(r, "1234567890abcdef1234567890abcdef12345678"); // 없는 커밋
  const q = SPK.collectPackage(r);
  assert.ok(q.basisNote.includes("기준 커밋 없음") && q.meta.seedRange.fallback && q.seeds.length === 1, q.basisNote);
});

t("E8 — ★[실제 확인에서 발견] 범위가 길어 diff 가 커도 통째로 빠지지 않고, 지금 작업(작업트리) 부분이 먼저 남은 채 기존 글자 상한으로 잘림", () => {
  const { r, g, w } = mkRepo();
  saveMapAt(r, g("rev-parse", "HEAD"));
  w("big.js", Array.from({ length: 30000 }, (_, i) => "export const committedLine" + i + " = " + i + ";").join("\n") + "\n"); g("add", "."); g("commit", "-qm", "big"); // 커밋된 diff 1MiB 넘음
  w("a.js", "export const workInProgressMarker = 7;\n");
  const p = SPK.collectPackage(r);
  assert.ok(p.diff.length > 0, "diff 가 비지 않음(종전 버퍼 초과=0자)");
  assert.ok(p.diff.includes("workInProgressMarker"), "작업트리 부분이 먼저 남음");
  assert.ok(p.diff.includes("committedLine0"), "상한 안에서 커밋된 부분도 이어 붙음");
  assert.strictEqual(p.diff.length, 20000, "기존 글자 상한");
  assert.ok(p.meta.truncations.some((x) => /^diff \d+→20000자로 절단$/.test(x)), JSON.stringify(p.meta.truncations));
  assert.ok(p.seeds.includes("big.js") && p.seeds.includes("a.js"));
});

t("E8 — 범위 안에서 지운 파일도 씨앗(지운 것으로 기록) · 민감 범주 파일은 범위에서 와도 diff 에서 빠지고 꾸러미에서 이름이 가려짐", () => {
  const { r, g, w } = mkRepo();
  w("gone.js", "g\n"); g("add", "."); g("commit", "-qm", "g");
  saveMapAt(r, g("rev-parse", "HEAD"));
  fs.unlinkSync(path.join(r, "gone.js")); w(".env", "API_TOKEN=supersecretvalue123\n"); g("add", "-A"); g("commit", "-qm", "rm+env");
  const p = SPK.collectPackage(r);
  assert.ok(p.seeds.includes("gone.js") && p.meta.seedMissing.includes("gone.js"), "지운 파일=씨앗·지운 것으로 기록 " + JSON.stringify(p.meta.seedMissing));
  assert.ok(!p.diff.includes("supersecretvalue123"), "민감 범주 diff 제외");
  const md = renderPackageMarkdown(p, "ko");
  assert.ok(!md.includes("supersecretvalue123") && !/^- \.env$/m.test(md), "꾸러미에 민감 이름·값 없음");
});

t("E8 — 정찰 실행(목 담당) 뒤 저장된 지도 메타에 씨앗 범위·간주 기준이 남고, 다음 정찰은 그 지도의 기준 커밋부터", () => {
  const { r, g, w } = mkRepo();
  const mock = { id: "mock", available: () => true, probe: () => ({ ok: true }), invoke: () => ({ ok: true, map: "## ① 직접\n- a.js (high)", usage: null }) };
  assert.ok(SP.runScout(r, "mock", { _providers: { mock } }).ok);
  w("b.js", "b\n"); g("add", "."); g("commit", "-qm", "b");
  assert.ok(SP.runScout(r, "mock", { _providers: { mock } }).ok);
  const m = SS.latestMapMeta(r);
  assert.ok(m.seedRange && m.seedRange.mode === "since-map" && m.seedRange.committed === 1 && /이후 커밋된 변경 1개/.test(m.basis) && m.seedFiles.includes("b.js"), JSON.stringify(m).slice(0, 400));
  assert.strictEqual(m.head, g("rev-parse", "HEAD"), "이번 지도의 기준 커밋=지금 HEAD");
  const p = SPK.collectPackage(r);
  assert.deepStrictEqual(p.meta.seedRange.sameHead, true, "다음 정찰은 방금 지도의 기준 커밋부터(새 커밋 없으면 지금 방식)");
});

t("E8 — 지도 보관 모듈이 빠진 낡은 배포(부분 사본)에서도 꾸러미 수집이 죽지 않고 지금 방식으로", () => {
  const { r, g, w } = mkRepo();
  saveMapAt(r, g("rev-parse", "HEAD"));
  w("b.js", "b\n"); g("add", "."); g("commit", "-qm", "b");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "scout-range-tree-"));
  for (const f of ["scope-package.js", "scope-package-core.js", "scope-ledger-core.js", "ledger-events-core.js", "contract-lib.js"]) fs.copyFileSync(path.join(__dirname, "..", "bridge", f), path.join(tree, f));
  const x = cp.spawnSync(process.execPath, ["-e", "const P=require(process.argv[1]);const p=P.collectPackage(process.argv[2]);process.stdout.write(JSON.stringify({seeds:p.seeds,range:p.meta.seedRange}))", path.join(tree, "scope-package.js"), r], { encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }) });
  assert.strictEqual(x.status, 0, x.stderr);
  assert.deepStrictEqual(JSON.parse(x.stdout), { seeds: [], range: { mode: "worktree" } }, "scout-store.js 없음=직전 지도 미판독=지금 방식");
});

// ── E9 ──
// 이 저장소 실제 정찰 보고서(2026-08-04 · ① 1~4 · ② 5~6 항목 · 구조 그대로) 고정 표본 — 'high' 머리 줄엔 경로가 없고 하위 불릿에 있음
const REAL = [
  "# 영향범위 지도", "", "후보 10개, 확인필요도 high 5개.", "", "## ① 직접 영향 후보", "",
  "1. **[high] Enrich 요청문의 증거 관문 계약**",
  "   - 경로: `bridge/enrich-providers.js`, `tests/p8-enrich-wire.test.js`",
  "   - 확인 동작: 요청문에 `project-map.js`의 `CODE_EVIDENCE_KINDS` 전체가 반영되고, 문서·압축·산출물만 인용하면 거부된다는 조건이 실제 판정 규칙과 일치하는지.", "",
  "2. **[high] 답변 가능성 판정과 신규 라운드 호출 차단**", "   - 경로: `bridge/map-enrich.js`", "",
  "4. **[low] 배포 산출물 무결성 결합**", "   - 경로: `SHA256SUMS.txt`, `codex-peek-0.1.89-installer.zip`", "",
  "## ② 간접 영향 후보", "",
  "5. **[high] 증거 종류 정본과 분류 함수의 일관성**", "   - 경로: `bridge/project-map.js`, `bridge/enrich-providers.js`, `bridge/map-enrich.js`", "",
  "6. **[medium] 보류 사유 소비자의 열거형 호환성**", "   - 경로: `bridge/map-router.js`, `bridge/map-intent.js`", "",
].join("\n");
const P = (md, lim) => CL.extractMapHighlights(md, lim).map((x) => x.path);

t("E9 — ★실제 보고서 표본: 'high' 항목 아래 하위 불릿의 경로를 읽음 · low·medium 항목의 하위 불릿은 안 읽음 · 머리 줄 앞(구획 전) 'high' 문장 제외", () => {
  const got = P(REAL, 24);
  for (const want of ["bridge/enrich-providers.js", "tests/p8-enrich-wire.test.js", "bridge/map-enrich.js", "bridge/project-map.js"]) assert.ok(got.includes(want), want + " " + JSON.stringify(got));
  for (const no of ["SHA256SUMS.txt", "codex-peek-0.1.89-installer.zip", "bridge/map-router.js", "bridge/map-intent.js"]) assert.ok(!got.includes(no), no);
  const it = CL.extractMapHighlights(REAL, 24).find((x) => x.path === "tests/p8-enrich-wire.test.js");
  assert.ok(/Enrich 요청문의 증거 관문 계약/.test(it.note), "설명=항목 머리 줄 " + it.note);
});

t("E9 — 항목 끝: 같은 들여쓰기의 다음 목록 머리 · 얕은 일반 줄 · 빈 줄 · 제목 · 제외 구획(⑤) · 자유서식 '범위 밖' 줄 / 이어짐: 깊게 들여쓴 연속 문장·탭 들여쓰기", () => {
  assert.deepStrictEqual(P("① 직접\n1. [high] A\n   - 경로: x/a.ts\n2. [medium] B\n   - 경로: x/b.ts"), ["x/a.ts"], "같은 수준 다음 항목에서 끝");
  assert.deepStrictEqual(P("① 직접\n- [high] A\n  - x/a.ts\nplain x/b.ts\n  - x/c.ts"), ["x/a.ts"], "얕은 일반 줄에서 끝(뒤의 깊은 줄도 안 이어짐)");
  assert.deepStrictEqual(P("① 직접\n- [high] A\n\n   - x/c.ts"), [], "빈 줄에서 끝");
  assert.deepStrictEqual(P("① 직접\n- [high] A\n### 메모\n   - x/d.ts"), [], "제목에서 끝");
  assert.deepStrictEqual(P("① 직접\n- [high] A\n   - x/a.ts\n⑤ 범위 밖\n- [high] B\n   - x/e.ts"), ["x/a.ts"], "⑤ 구획의 high 항목·하위 줄 제외");
  assert.deepStrictEqual(P("- [high] A\n   - x/a.ts\n   - out of scope: x/f.ts\n   - x/g.ts"), ["x/a.ts"], "자유서식 '범위 밖' 줄은 그 줄 제외·항목도 끝");
  assert.deepStrictEqual(P("① 직접\n1. [high] A\n   경로는 x/h.ts 이다"), ["x/h.ts"], "깊게 들여쓴 연속 문장=같은 항목");
  assert.deepStrictEqual(P("① 직접\n- [high] A\n\t- x/i.ts"), ["x/i.ts"], "탭 들여쓰기");
  assert.deepStrictEqual(P("① 직접\n  - [high] 들여쓴 항목\n  - x/j.ts\n    - x/k.ts"), [], "머리와 같은 들여쓰기의 다음 불릿=다른 항목(high 아니면 안 읽음)");
  assert.deepStrictEqual(P("① 직접\n- 일반 항목\n   - [high] 하위 불릿 x/l.ts\n      - x/m.ts"), ["x/l.ts", "x/m.ts"], "하위 불릿이 high 머리면 그 아래만 그 항목");
  assert.deepStrictEqual(P("① 직접\n- x/n.ts (high)\n   - x/o.ts"), ["x/n.ts", "x/o.ts"], "종전 꼴(머리 줄 끝 high)도 항목");
});

t("E9 — 상한·중복은 항목 안에서도 그대로 · 긴 줄 비용 고정", () => {
  const many = "① 직접\n1. [high] A\n" + Array.from({ length: 12 }, (_, i) => `   - x/f${i}.ts`).join("\n");
  const got = P(many);
  assert.strictEqual(got.length, 8, "기본 상한 8");
  assert.strictEqual(P("① 직접\n1. [high] A\n   - x/a.ts, x/a.ts\n   - X/A.ts").length, 1, "중복 없음(대소문자 무시)");
  const t0 = Date.now(); P("① 직접\n1. [high] A\n   - " + "y".repeat(50000) + " x/long.ts"); assert.ok(Date.now() - t0 < 2000, "긴 줄");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
