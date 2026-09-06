"use strict";
/*
 * [CURATION v3 §7 3·4단계 시험 — 2026-09-04 · 확인검증 1회차 blocker 5 반영] 격리 CODEX_BRIDGE_HOME.
 * 3단계(두 층): ⓐ 훅 curationHookTick=계약·잠금·tick 상태 3파일만(전수 판독 0)·최소 간격 지나면 `curate tick` detach·무고지 ⓑ 자식 curationTickJudge=꼬리 상한 판독으로
 *   신호 재계산(현재 세대·열린 지적만 — 옛 세대 해소 계보 반례)·마감 캠페인 누계=tick 상태(이력 60일 절단 무관·첫 tick은 기준선)·같은 신호 상태(tickFp) 1회·잠금·간격.
 *   CLI curate tick/run --auto|--button이 실행 행에 trigger·tickFp를 남기고 실행은 누계를 0으로.
 * 4단계: 요약·측정 4지표(채택률·서고 크기·선별 초과·미사용 수칙 수/일수)·현재 저장소(repoKey) 기준(전환 반례)·대시보드 상태/카드 줄/버튼/핸들러 소스 핀.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "curt-home-"));
process.env.CODEX_BRIDGE_HOME = HOME;
delete process.env.CLAUDE_PROJECT_DIR; delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CODEX_THREAD_ID;
const CL = require("../bridge/contract-lib.js");
const CU = require("../bridge/curation.js");
const sha1 = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const MIN = 60 * 1000;

const coreRaw = JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["윈도우 로컬"], alwaysBlocker: ["무승인 원격 전달 금지"], outOfScope: ["다중 서버 동시 배포"] }, null, 1);
const CORE_HASH = sha1(coreRaw);
const arcRaw = JSON.stringify({ schema: "verify-envelope-archive-v1", alwaysBlocker: ["배포 전 백업", "기록 삭제 금지"] }, null, 1);
const ARC_HASH = sha1(arcRaw);
function fixture(tag, withArchive) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "curt-" + tag + "-ws-")); const repo = fs.mkdtempSync(path.join(os.tmpdir(), "curt-" + tag + "-repo-"));
  fs.writeFileSync(path.join(repo, CL.ENVELOPE_FILE), coreRaw); assert.strictEqual(CL.setEnvelopeHashAllSlots(ws, CORE_HASH), 2); assert.ok(CL.updateContractPatch(ws, "ko", { scoutRepo: repo }).ok);
  if (withArchive) { fs.writeFileSync(path.join(repo, CL.ARCHIVE_FILE), arcRaw); assert.strictEqual(CL.setContractHashAllSlots(ws, "archiveHash", ARC_HASH), 2); }
  return { ws, repo, c: () => CL.loadContract(ws), wsKey: CL.wsKeyFor(ws), repoKey: CL.repoKeyOf(repo) };
}
const spawned = [];
const spawnFn = (bin, args, opts) => { spawned.push({ bin, args, opts }); return { unref() {} }; };
const hist = (ws, ids, ageMs, repoKey, fixedTs) => { const hf = CL.campaignHistoryFileFor(ws); fs.mkdirSync(path.dirname(hf), { recursive: true }); for (const id of ids) { const ts = fixedTs || new Date(Date.now() - (ageMs || 1000)).toISOString(); fs.appendFileSync(hf, JSON.stringify({ campaignId: id, count: 1, budget: 5, startedAt: ts, updatedAt: ts, ...(repoKey === null ? {} : { repoKey: repoKey || CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo) }) }) + "\n"); } };

t("훅 층 — 계약·잠금·tick 상태 3파일만: 수칙서 비활성=무실행 · 활성=`curate tick` detach(인자·cwd·CLAUDE_PROJECT_DIR) · 같은 간격 안 재훅=재spawn 없음 · 잠금 살아 있으면 무실행 · 항상 무고지(null)", () => {
  const F = fixture("hook", true);
  const WS0 = fs.mkdtempSync(path.join(os.tmpdir(), "curt-hook0-"));
  assert.strictEqual(CU.curationHookTick(WS0, { harnessMode: "claude-codex" }, { spawnFn }), null);
  assert.strictEqual(spawned.length, 0, "비활성=spawn 없음");
  assert.strictEqual(CU.curationHookTick(F.ws, F.c(), { spawnFn }), null, "훅은 항상 무고지");
  assert.strictEqual(spawned.length, 1);
  const s = spawned[0];
  assert.ok(s.bin === process.execPath && /codex-bridge\.js$/.test(s.args[0]) && s.args.slice(1).join(" ") === "curate tick", JSON.stringify(s.args));
  assert.ok(s.opts.detached === true && s.opts.stdio === "ignore" && CL.normWs(s.opts.cwd) === CL.normWs(F.ws) && CL.normWs(s.opts.env.CLAUDE_PROJECT_DIR) === CL.normWs(F.ws));
  const st = CU.readTickState(F.ws, F.repoKey); assert.ok(st && st.judgedAt && st.repoKey === F.repoKey, "detach 전에 상태를 찍음(repoKey 결속) " + JSON.stringify(st));
  CU.curationHookTick(F.ws, F.c(), { spawnFn }); assert.strictEqual(spawned.length, 1, "최소 간격 안=재spawn 없음");
  CU.curationHookTick(F.ws, F.c(), { spawnFn, now: Date.now() + 11 * MIN }); assert.strictEqual(spawned.length, 2, "간격 뒤=다시 spawn");
  const lf = CU.curateLockFileFor(F.ws); fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "live" }));
  CU.curationHookTick(F.ws, F.c(), { spawnFn, now: Date.now() + 30 * MIN }); assert.strictEqual(spawned.length, 2, "잠금 살아 있음=spawn 없음");
  fs.rmSync(lf, { force: true });
});

t("자식 판정 — 첫 tick은 이력을 기준선으로(k=0·spawn 없음) → 새 마감 캠페인 10건 누적=campaigns:10 · 이력 60일 절단과 무관(상태 파일 누계) · 실행 뒤 0 리셋", () => {
  const F = fixture("k", false);
  hist(F.ws, ["cl:old:1", "cl:old:2", "cl:old:3"]);
  let j = CU.curationTickJudge(F.ws, F.c());
  assert.ok(!j.spawn && j.reason === "below-threshold" && j.signals.k === 0 && CU.readTickState(F.ws, F.repoKey).seeded === true && CU.readTickState(F.ws, F.repoKey).hwm && CU.readTickState(F.ws, F.repoKey).hwmIds.length >= 1, "기준선 " + JSON.stringify(j));
  hist(F.ws, Array.from({ length: 9 }, (_, i) => "cl:new:" + i));
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 11 * MIN });
  assert.ok(!j.spawn && j.signals.k === 9, "9건=미달 " + JSON.stringify(j));
  // 60일 절단 흉내: 이력 파일에서 앞 행이 사라져도 누계는 상태 파일이 기억한다
  const hf = CL.campaignHistoryFileFor(F.ws); fs.writeFileSync(hf, "");
  hist(F.ws, ["cl:new:9"]);
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 22 * MIN });
  assert.ok(j.spawn && j.reason === "campaigns:10" && j.signals.k === 10 && /^[0-9a-f]{40}$/.test(j.tickFp), JSON.stringify(j));
  CU.resetTickK(F.ws, F.repoKey, new Date().toISOString());
  const st = CU.readTickState(F.ws, F.repoKey); assert.ok(st.k === 0 && st.hwm && st.ranAt, "리셋 뒤 k=0·워터마크 유지 " + JSON.stringify(st));
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 33 * MIN });
  assert.ok(!j.spawn && j.signals.k === 0, "리셋 뒤 이미 본 id는 다시 세지 않음 " + JSON.stringify(j));
  // ★반례(2회차 blocker②) — seen 상한(64) 절단 뒤 이력 변경 없이 유휴 판정을 반복해도 옛 id가 신규로 재계수되지 않는다(시각 워터마크)
  hist(F.ws, Array.from({ length: 70 }, (_, i) => "cl:bulk:" + i), 1); // 이력은 시간순 append — 기준선보다 나중 시각
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 44 * MIN });
  assert.strictEqual(j.signals.k, 70, "70건 신규 " + JSON.stringify(j.signals));
  for (let i = 0; i < 9; i++) { j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + (55 + 11 * i) * MIN }); assert.strictEqual(j.signals.k, 70, "유휴 판정 " + i + "회째 k 불변(재계수 없음)"); }
  // ★반례(3회차 blocker②) — 워터마크와 같은 밀리초의 새 캠페인도 센다(>= 비교) · 그 시각 id는 seen 절단 제외라 다음 판정에서 재계수 없음
  const hwmTs = CU.readTickState(F.ws, F.repoKey).hwm; assert.ok(hwmTs, "워터마크 존재");
  hist(F.ws, ["cl:same-ms"], 0, undefined, hwmTs);
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 170 * MIN });
  assert.strictEqual(j.signals.k, 71, "같은 밀리초 새 id=신규 1 " + JSON.stringify(j.signals));
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 181 * MIN });
  assert.strictEqual(j.signals.k, 71, "다음 판정=재계수 없음");
  hist(F.ws, ["cl:legacy-no-repo"], 0, null); // 표식 없는 옛 행=불산입
  j = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 192 * MIN });
  assert.strictEqual(j.signals.k, 71, "저장소 표식 없는 행은 세지 않는다");
  // ★반례(4회차 blocker②) — 워터마크와 같은 시각의 마감이 상한(64)을 넘어도 상태 재판독 뒤 재계수되지 않는다(상태=시각+개수 두 값)
  const G = fixture("hwm", false);
  const T0 = new Date(Date.now() - 3000).toISOString();
  hist(G.ws, ["cl:seed"], 0, undefined, T0);
  assert.strictEqual(CU.curationTickJudge(G.ws, G.c()).signals.k, 0, "기준선");
  hist(G.ws, Array.from({ length: 65 }, (_, i) => "cl:ms:" + i), 0, undefined, T0); // 전부 같은 시각
  let jg = CU.curationTickJudge(G.ws, G.c(), { now: Date.now() + 11 * MIN });
  assert.strictEqual(jg.signals.k, 65, "같은 시각 65건=신규 65 " + JSON.stringify(jg.signals));
  for (let i = 0; i < 3; i++) { jg = CU.curationTickJudge(G.ws, G.c(), { now: Date.now() + (22 + 11 * i) * MIN }); assert.strictEqual(jg.signals.k, 65, "재판독 뒤 " + i + "회째 재계수 없음"); }
  hist(G.ws, ["cl:ms:x"], 0, undefined, T0);
  jg = CU.curationTickJudge(G.ws, G.c(), { now: Date.now() + 60 * MIN });
  assert.strictEqual(jg.signals.k, 66, "같은 시각 1건 추가=+1");
  // ★반례(5회차 blocker②) — 같은 시각에서 옛 행 2개가 꼬리에서 사라지고 새 캠페인 1개가 들어오면(개수는 줄어도) 신규 1건을 정확히 센다
  const keep = fs.readFileSync(CL.campaignHistoryFileFor(G.ws), "utf8").split(/\r?\n/).filter(Boolean);
  const trimmed = keep.filter((l) => !/cl:ms:0"|cl:ms:1"/.test(l)); // 옛 행 2개 절단
  fs.writeFileSync(CL.campaignHistoryFileFor(G.ws), trimmed.join("\n") + "\n");
  hist(G.ws, ["cl:ms:new"], 0, undefined, T0); // 같은 시각 신규 1건
  jg = CU.curationTickJudge(G.ws, G.c(), { now: Date.now() + 71 * MIN });
  assert.strictEqual(jg.signals.k, 67, "절단 2 + 신규 1 → 신규만 +1 " + JSON.stringify(jg.signals));
  jg = CU.curationTickJudge(G.ws, G.c(), { now: Date.now() + 82 * MIN });
  assert.strictEqual(jg.signals.k, 67, "다음 판정=재계수 없음(사라진 행도 집합에 남음)");
});

t("자식 판정 — 같은 신호 상태(tickFp)는 마지막 실행 행과 같으면 무실행(same-tick) · 최소 간격 안=recent · 잠금=running · 상태 파일에 판정 사유 기록", () => {
  const F = fixture("same", false);
  CU.curationTickJudge(F.ws, F.c()); // 기준선
  hist(F.ws, Array.from({ length: 10 }, (_, i) => "cl:n:" + i));
  const j0 = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 11 * MIN });
  assert.ok(j0.spawn && j0.reason === "campaigns:10");
  CU.appendCurationRow(F.ws, { type: "run", repoKey: F.repoKey, trigger: "auto", tickFp: j0.tickFp, outcome: "skipped", reason: "no-signal", ts: new Date(Date.now() - 20 * MIN).toISOString() });
  const j1 = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 22 * MIN });
  assert.strictEqual(j1.reason, "same-tick");
  assert.strictEqual(CU.readTickState(F.ws, F.repoKey).reason, "same-tick");
  CU.appendCurationRow(F.ws, { type: "run", repoKey: F.repoKey, trigger: "manual", outcome: "none" }); // 방금
  assert.strictEqual(CU.curationTickJudge(F.ws, F.c()).reason, "recent");
  const lf = CU.curateLockFileFor(F.ws); fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "live" }));
  assert.strictEqual(CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 11 * MIN }).reason, "running");
  fs.rmSync(lf, { force: true });
});

t("자식 판정 — 신호 임계 각각 단독 실행 사유: 강등 반복 ≥2 · 계보 ≥3(열린 지적만) · 미사용 보관 수칙 30일(관측 0건=주장 없음·수/일수) · 선별 초과 3회", () => {
  const later = { now: Date.now() + 11 * MIN };
  const A = fixture("sigA", true);
  CU.curationTickJudge(A.ws, A.c());
  assert.strictEqual(CU.curationTickJudge(A.ws, A.c(), later).reason, "below-threshold");
  CL.appendSelectorUsage({ ts: new Date(Date.now() - 29 * 86400000).toISOString(), wsKey: A.wsKey, repoKey: A.repoKey, askId: "", purpose: "preview", turnAnchor: "t", archiveHash: ARC_HASH, selectedIds: ["arc-1"], arm: "self" });
  let j = CU.curationTickJudge(A.ws, A.c(), { now: Date.now() + 22 * MIN });
  assert.ok(!j.spawn && j.signals.unusedDays === 29 && j.signals.unusedCount === 1, JSON.stringify(j.signals));
  CL.appendSelectorUsage({ ts: new Date(Date.now() - 31 * 86400000).toISOString(), wsKey: A.wsKey, repoKey: A.repoKey, askId: "a1", turnAnchor: "t2", archiveHash: ARC_HASH, selectedIds: ["arc-1"], arm: "self" });
  j = CU.curationTickJudge(A.ws, A.c(), { now: Date.now() + 33 * MIN });
  assert.ok(j.spawn && /^unused-rule:3[01]d$/.test(j.reason) && j.signals.unusedCount === 1, JSON.stringify(j));
  const B = fixture("sigB", false);
  CU.curationTickJudge(B.ws, B.c());
  fs.mkdirSync(path.dirname(CL.ATTACH_USAGE_FILE), { recursive: true });
  for (let i = 0; i < 2; i++) fs.appendFileSync(CL.ATTACH_USAGE_FILE, JSON.stringify({ ts: new Date().toISOString(), ws: B.ws, repoKey: B.repoKey, askId: "a" + i, items: [], envelope: { hash: CORE_HASH }, selOver: { items: true, count: 13 } }) + "\n");
  fs.appendFileSync(CL.ATTACH_USAGE_FILE, JSON.stringify({ ts: new Date().toISOString(), ws: B.ws, repoKey: "0000000000000000", askId: "ax", items: [], envelope: { hash: CORE_HASH }, selOver: { items: true, count: 20 } }) + "\n"); // 같은 세대 지문·다른 저장소 행=불산입
  assert.strictEqual(CU.curationTickJudge(B.ws, B.c(), later).reason, "below-threshold");
  fs.appendFileSync(CL.ATTACH_USAGE_FILE, JSON.stringify({ ts: new Date().toISOString(), ws: B.ws, repoKey: B.repoKey, askId: "a9", items: [], envelope: { hash: CORE_HASH }, selOver: { items: true, count: 14 } }) + "\n");
  j = CU.curationTickJudge(B.ws, B.c(), { now: Date.now() + 22 * MIN });
  assert.ok(j.spawn && j.reason === "selover:3", JSON.stringify(j));
  const ts = new Date().toISOString();
  const camp = (F9, id) => { fs.mkdirSync(path.dirname(CL.campaignFileFor(F9.ws)), { recursive: true }); fs.writeFileSync(CL.campaignFileFor(F9.ws), JSON.stringify({ schema: "vcamp-1", campaignId: id, count: 1, budget: 5, startedAt: ts, updatedAt: ts, repoKey: F9.repoKey })); }; // 현재 캠페인=이 저장소
  const Cx = fixture("sigC", false);
  CU.curationTickJudge(Cx.ws, Cx.c()); camp(Cx, "c1");
  CL.appendFindingsLedger(Cx.ws, [
    { type: "finding", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "f1", demoted: true, oosId: "oos-2", titleNorm: "a", ts },
    { type: "finding", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "f2", demoted: true, oosId: "oos-2", titleNorm: "b", ts },
  ]);
  j = CU.curationTickJudge(Cx.ws, Cx.c(), later);
  assert.ok(j.spawn && j.reason === "oos-repeat:2", JSON.stringify(j));
  // ★반례(확인검증 ab-1) — 같은 캠페인 c1의 지적이라도 기록 시점 표식이 다른 저장소면 신호에 들어오지 않는다(캠페인 대리 매핑 폐기)
  const Cy = fixture("sigCy", false);
  CU.curationTickJudge(Cy.ws, Cy.c()); camp(Cy, "c1"); hist(Cy.ws, ["c1"], 1000, "0000000000000000"); // c1이 다른 저장소 이력에도 존재
  CL.appendFindingsLedger(Cy.ws, [
    { type: "finding", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "g1", demoted: true, oosId: "oos-2", titleNorm: "a", repoKey: "0000000000000000", ts },
    { type: "finding", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "g2", demoted: true, oosId: "oos-2", titleNorm: "b", repoKey: "0000000000000000", ts },
  ]);
  j = CU.curationTickJudge(Cy.ws, Cy.c(), later);
  assert.ok(!j.spawn && j.signals.oosRepeat === 0, "다른 저장소 표식의 지적=불산입 " + JSON.stringify(j.signals));
  const D = fixture("sigD", false);
  CU.curationTickJudge(D.ws, D.c()); camp(D, "c1");
  CL.appendFindingsLedger(D.ws, [
    { type: "finding", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "f1", titleNorm: "a", ts },
    { type: "occurrence", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "f1", round: 2, effectiveTag: "blocker", ts },
  ]);
  assert.strictEqual(CU.curationTickJudge(D.ws, D.c(), later).reason, "below-threshold", "재등장 1회(계보 2)=미달");
  CL.appendFindingsLedger(D.ws, [{ type: "occurrence", campaignId: "c1", envelopeHash: CORE_HASH, findingId: "f1", round: 3, effectiveTag: "blocker", ts }]);
  j = CU.curationTickJudge(D.ws, D.c(), { now: Date.now() + 22 * MIN });
  assert.ok(j.spawn && j.reason === "lineage:3", JSON.stringify(j));
});

t("★반례(1회차 blocker①) — 옛 세대·옛 캠페인의 해소된 계보(occurrence 2·3회+close)는 현재 세대 신호가 아니다 · 같은 세대라도 close 행이 있으면 계보에서 제외", () => {
  const later = { now: Date.now() + 11 * MIN };
  const F = fixture("old", false);
  CU.curationTickJudge(F.ws, F.c());
  const ts = new Date().toISOString(); const OLD = "f".repeat(40);
  hist(F.ws, ["old"], 2000); fs.writeFileSync(CL.campaignFileFor(F.ws), JSON.stringify({ schema: "vcamp-1", campaignId: "new", count: 1, budget: 5, startedAt: ts, updatedAt: ts, repoKey: F.repoKey })); // old·new 모두 이 저장소 캠페인
  CL.appendFindingsLedger(F.ws, [
    { type: "finding", campaignId: "old", envelopeHash: OLD, findingId: "f1", titleNorm: "a", ts },
    { type: "occurrence", campaignId: "old", envelopeHash: OLD, findingId: "f1", round: 2, effectiveTag: "blocker", ts },
    { type: "occurrence", campaignId: "old", envelopeHash: OLD, findingId: "f1", round: 3, effectiveTag: "blocker", ts },
    { type: "close", campaignId: "old", envelopeHash: OLD, findingId: "f1", closeReason: "resolved", ts },
    { type: "finding", campaignId: "new", envelopeHash: CORE_HASH, findingId: "f9", titleNorm: "z", ts },
  ]);
  const j = CU.curationTickJudge(F.ws, F.c(), later);
  assert.ok(!j.spawn && j.reason === "below-threshold" && j.signals.lineage === 0, "옛 세대 해소 계보 무시 " + JSON.stringify(j));
  CL.appendFindingsLedger(F.ws, [
    { type: "occurrence", campaignId: "new", envelopeHash: CORE_HASH, findingId: "f9", round: 2, effectiveTag: "blocker", ts },
    { type: "occurrence", campaignId: "new", envelopeHash: CORE_HASH, findingId: "f9", round: 3, effectiveTag: "blocker", ts },
    { type: "close", campaignId: "new", envelopeHash: CORE_HASH, findingId: "f9", closeReason: "resolved", ts },
  ]);
  const j2 = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 22 * MIN });
  assert.ok(!j2.spawn && j2.signals.lineage === 0, "현재 세대라도 해소(close)된 계보는 제외 " + JSON.stringify(j2));
  const tail = CU.readTailLines(CL.findingsLedgerFileFor(F.ws), 200);
  assert.ok(tail.length >= 1 && tail.every((l) => l.startsWith("{")), "꼬리 판독은 잘린 앞 조각을 버린다");
});

t("CLI — curate tick(판정→실행·trigger auto·tickFp·누계 0) · 직후 재tick=recent · curate run --button=button · 기본=manual · 요약·status --json 동일 원천", () => {
  const F = fixture("cli", true);
  const fakeMod = path.join(HOME, "fake-runner.js");
  fs.writeFileSync(fakeMod, 'module.exports = { runSelectorPage: () => ({ promise: Promise.resolve({ ok: true, output: JSON.stringify({ proposals: [] }) }), cancel() {} }) };');
  const env = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: F.ws, CODEX_BRIDGE_SELECTOR_RUNNER: fakeMod });
  const cli = path.join(__dirname, "..", "bridge", "codex-bridge.js");
  CU.curationTickJudge(F.ws, F.c()); // 기준선
  hist(F.ws, Array.from({ length: 10 }, (_, i) => "cl:x:" + i));
  fs.writeFileSync(CU.curationTickFileFor(F.ws, F.repoKey), JSON.stringify(Object.assign(CU.readTickState(F.ws, F.repoKey), { judgedAt: new Date(Date.now() - 20 * MIN).toISOString() })));
  const r1 = cp.spawnSync(process.execPath, [cli, "curate", "tick", "--json"], { env, encoding: "utf8", cwd: F.ws });
  const o1 = JSON.parse(r1.stdout.trim().split(/\r?\n/).pop());
  assert.ok(r1.status === 0 && o1.judge && o1.judge.spawn && o1.judge.reason === "campaigns:10" && (o1.st === "ok" || o1.st === "skipped"), r1.stdout + r1.stderr);
  let runs = CU.readCurationRows(F.ws).filter((x) => x.type === "run"); let last = runs[runs.length - 1];
  assert.ok(last.trigger === "auto" && last.tickFp === o1.judge.tickFp, JSON.stringify(last));
  assert.strictEqual(CU.readTickState(F.ws, F.repoKey).k, 0, "실행 뒤 누계 0");
  const r1b = cp.spawnSync(process.execPath, [cli, "curate", "tick", "--json"], { env, encoding: "utf8", cwd: F.ws });
  const o1b = JSON.parse(r1b.stdout.trim().split(/\r?\n/).pop());
  assert.ok(o1b.st === "no-run" && o1b.judge.reason === "recent", "직후 재tick=recent " + r1b.stdout);
  const r2 = cp.spawnSync(process.execPath, [cli, "curate", "run", "--button", "--force", "--json"], { env, encoding: "utf8", cwd: F.ws });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  runs = CU.readCurationRows(F.ws).filter((x) => x.type === "run"); last = runs[runs.length - 1];
  assert.ok(last.trigger === "button" && !last.tickFp, JSON.stringify(last));
  const r3 = cp.spawnSync(process.execPath, [cli, "curate", "run", "--force", "--json"], { env, encoding: "utf8", cwd: F.ws });
  assert.strictEqual(r3.status, 0, r3.stdout + r3.stderr);
  runs = CU.readCurationRows(F.ws).filter((x) => x.type === "run"); last = runs[runs.length - 1];
  assert.strictEqual(last.trigger, "manual");
  const sm = CU.curationSummary(F.ws);
  assert.ok(sm.lastTrigger === "manual" && sm.runs === 3 && sm.archiveSize === 2 && sm.adoptRate === 0 && sm.unusedCount === 0 && sm.running === false && sm.campaignsSince === 0, JSON.stringify(sm));
  const st = cp.spawnSync(process.execPath, [cli, "curate", "status", "--json"], { env, encoding: "utf8", cwd: F.ws });
  const o = JSON.parse(st.stdout.trim().split(/\r?\n/).pop());
  assert.ok(st.status === 0 && o.archiveSize === 2 && typeof o.unusedCount === "number", st.stdout + st.stderr);
});

t("★반례(1회차 blocker④ ab-1) — 정찰 대상 전환 뒤 요약은 현재 저장소 기록만: A의 실행·제안·채택이 B 카드에 합산되지 않는다 · running(잠금) 반영", () => {
  const F = fixture("repo", true);
  const repoA = F.repo;
  const idA = sha1("candA").slice(0, 16);
  CU.appendCurationRow(F.ws, { type: "run", repoKey: F.repoKey, trigger: "auto", outcome: "proposed", proposed: 1 });
  CU.appendCurationRow(F.ws, { type: "result", repoKey: F.repoKey, curationKey: "k1", boundaryGen: CORE_HASH, archiveGen: ARC_HASH, resultFp: "x", items: [idA] });
  CL.appendEnvelopeCandidates(F.ws, [{ candidateId: idA, envelopeHash: CORE_HASH, status: "adopted", applied: "h", kind: "curator", repoKey: F.repoKey, ts: new Date().toISOString() }]);
  let sm = CU.curationSummary(F.ws);
  assert.ok(sm.runs === 1 && sm.proposedTotal === 1 && sm.adopted === 1 && sm.adoptRate === 100, "A 기준 " + JSON.stringify(sm));
  // ★반례(2회차 blocker① ab-1) — A에서 선별 초과 3회·마감 캠페인 10건 누계 → B 전환 뒤 판정·카드는 B 기준(0·기준선)
  fs.mkdirSync(path.dirname(CL.ATTACH_USAGE_FILE), { recursive: true });
  for (let i = 0; i < 3; i++) fs.appendFileSync(CL.ATTACH_USAGE_FILE, JSON.stringify({ ts: new Date().toISOString(), ws: F.ws, repoKey: F.repoKey, askId: "sa" + i, items: [], envelope: { hash: CORE_HASH }, selOver: { items: true, count: 13 } }) + "\n");
  CU.curationTickJudge(F.ws, F.c()); hist(F.ws, Array.from({ length: 10 }, (_, i) => "cl:A:" + i));
  let jA = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 11 * MIN });
  assert.ok(jA.spawn && jA.signals.k === 10 && jA.signals.selOver === 3, "A 기준 신호 " + JSON.stringify(jA.signals));
  assert.strictEqual(CU.curationSummary(F.ws).selOverCount, 3);
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "curt-repoB-"));
  fs.writeFileSync(path.join(repoB, CL.ENVELOPE_FILE), coreRaw); assert.ok(CL.updateContractPatch(F.ws, "ko", { scoutRepo: repoB }).ok); CL.setContractHashAllSlots(F.ws, "archiveHash", ""); // ★B 수칙서=A와 바이트 동일(같은 세대 지문) — 내용 지문으로는 구분 불가
  const repoKeyB = CL.repoKeyOf(repoB);
  const jB = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 22 * MIN });
  assert.ok(!jB.spawn && jB.reason === "below-threshold" && jB.signals.k === 0 && jB.signals.selOver === 0, "B 전환=기준선·A 신호 미승계(같은 지문이어도) " + JSON.stringify(jB));
  // ★B에서 캠페인 10건 마감 → A 복귀 시 A 누계는 0이어야(3회차 반례) · B는 10
  hist(F.ws, Array.from({ length: 10 }, (_, i) => "cl:B:" + i), 500, repoKeyB);
  const jB2 = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 33 * MIN });
  assert.ok(jB2.spawn && jB2.signals.k === 10 && jB2.reason === "campaigns:10", "B 자기 캠페인 10=실행 " + JSON.stringify(jB2.signals));
  sm = CU.curationSummary(F.ws);
  assert.ok(sm.runs === 0 && sm.proposedTotal === 0 && sm.adopted === 0 && sm.adoptRate === 0 && sm.lastTs === "" && sm.lastTrigger === "" && sm.selOverCount === 0 && sm.campaignsSince === 10, "B로 전환=이전 저장소 실적 미합산(누계 10은 B 자신의 마감) " + JSON.stringify(sm));
  CL.setEnvelopeHashAllSlots(F.ws, CORE_HASH);
  assert.ok(CL.updateContractPatch(F.ws, "ko", { scoutRepo: repoA }).ok); CL.setContractHashAllSlots(F.ws, "archiveHash", ARC_HASH);
  assert.strictEqual(CU.curationSummary(F.ws).adopted, 1, "A로 복귀=다시 보임");
  assert.ok(CU.curationSummary(F.ws).selOverCount === 3 && CU.curationSummary(F.ws).campaignsSince === 10, "A 복귀=A 상태·신호 복원");
  const jA2 = CU.curationTickJudge(F.ws, F.c(), { now: Date.now() + 44 * MIN });
  assert.ok(jA2.signals.k === 10 && jA2.signals.selOver === 3, "A 복귀 판정: B의 마감 10건은 A 누계에 합산되지 않음(A는 자기 10건 그대로) " + JSON.stringify(jA2.signals));
  const lf = CU.curateLockFileFor(F.ws); fs.writeFileSync(lf, JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "x" }));
  assert.strictEqual(CU.curationSummary(F.ws).running, true);
  fs.rmSync(lf, { force: true });
});

t("소스 핀 — 훅 두 곳이 map-bootstrap tick 옆에서 curationHookTick(advisory) · 훅 층은 장부 판독 함수를 호출하지 않음 · 검증 훅·워커·ask-start 무접촉(P1) · 대시보드 상태/카드 4지표/버튼/핸들러 · 배포 목록·체인", () => {
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const ci = rd("bridge/contract-inject.js"), ch = rd("bridge/codex-hook.js");
  assert.ok(ci.includes('require("./curation.js").curationHookTick(ws, c)') && ci.indexOf("curationHookTick") > ci.indexOf('require("./map-bootstrap.js").hookTick(ws)'), "contract-inject tick 자리");
  assert.ok(ch.includes('require("./curation.js").curationHookTick(ws,c)') && ch.indexOf("curationHookTick") > ch.indexOf('require("./map-bootstrap.js").hookTick(ws)'), "codex-hook tick 자리");
  const cu = rd("bridge/curation.js");
  const hs = cu.indexOf("function curationHookTick(");
  const hb = cu.slice(hs, cu.indexOf("\n}\n", hs));
  assert.ok(!/readCurationRows|readFindingsLedger|readSelectorUsage|readTailJson|curationTickSignals|curationTickJudge|readdirSync/.test(hb) && hb.includes("readTickState(ws, repoKey)") && hb.includes("lockAlive(ws)") && hb.includes('"curate", "tick"'), "훅 층=상태·잠금 파일만+detach(ab-6)");
  for (const f of ["bridge/verify-guard.js", "bridge/ask-job-worker.js"]) assert.ok(!/curation/.test(rd(f)), f + " 큐레이션 무접촉(P1)");
  const cb = rd("bridge/codex-bridge.js");
  const asI = cb.indexOf("function cmdAskStart(rest)"); const asJ = cb.indexOf("\nfunction ", asI + 10);
  assert.ok(asI > 0 && asJ > asI && !/curation/i.test(cb.slice(asI, asJ)), "ask-start 무접촉(P1)");
  assert.ok(cb.includes('if (sub === "tick") {') && cb.includes('trigger: "auto", tickFp: j.tickFp') && cb.includes('(rest || []).includes("--auto") ? "auto"'), "CLI tick·트리거 플래그");
  const ext = rd("src/extension.ts");
  assert.ok(ext.includes("curation: { lastItems: Array<{ id: string; title: string; op: string; status: string }>; lastTs: string; lastOutcome: string;") && ext.includes("unusedCount: number") && ext.includes("CU9.curationSummary(ws)"), "상태(4지표+마지막 결과 항목 포함)");
  assert.ok(ext.includes('m?.type === "curationShow"') && !ext.includes('m?.type === "curationRun"') && !ext.includes('"curate", "run", "--button"') && ext.includes("CUq.curationSummary(wsQ)") && ext.includes("su.lastItems") && ext.includes("{ modal: true }"), "버튼 핸들러=마지막 결과 보기 모달(실행 없음 — 2026-09-06 개정: 실행은 자동 트리거·CLI만)");
  const beg = ext.indexOf("if(d.curation){"); const end = ext.indexOf("var actT=e9.act", beg);
  assert.ok(beg > 0 && end > beg, "카드 줄 블록");
  const blk = ext.slice(beg, end);
  assert.ok(!/innerHTML/.test(blk) && blk.includes("마지막 정리 결과 보기") && !blk.includes("정리 제안 받기") && blk.includes("cb9.disabled=!cu9.lastTs") && blk.includes("cu9.adoptRate") && blk.includes("cu9.archiveSize") && blk.includes("cu9.selOverCount") && blk.includes("cu9.unusedCount") && blk.includes('vscode.postMessage({type:"curationShow"})'), "카드 줄 4지표·버튼=마지막 결과 보기(textContent·이력 없으면 비활성)");
  const dBeg = ext.indexOf("function decideActs(d){"); const dEnd = ext.indexOf("function renderOverview(d){", dBeg);
  assert.ok(!/curation/.test(ext.slice(dBeg, dEnd)), "개요 '지금 정할 것' 미합산");
  const pk = JSON.parse(rd("package.json"));
  assert.ok(/curation-trigger\.test\.js/.test(pk.scripts.test), "체인 등록");
  for (const f of ["install.js", "src/hook-setup.ts", "bridge/map-cutover.js"]) assert.ok(/"curation\.js"/.test(rd(f)), f + " 배포 목록");
});

t("★반례(확인검증 3판 ab-1) — 검증 결과 처리: 같은 캠페인·세대에 B의 통과 판·열린 지적이 있어도 A의 첫 판은 discovery·round 1이고 B 지적을 닫지 않는다(판독도 시작 스냅샷 저장소만)", () => {
  const CB = require("../bridge/codex-bridge.js");
  const F = fixture("mfl", false);
  const CAMP = "cl:mfl:1"; const ts = new Date().toISOString();
  fs.mkdirSync(path.dirname(CL.campaignFileFor(F.ws)), { recursive: true });
  fs.writeFileSync(CL.campaignFileFor(F.ws), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 1, budget: 9, startedAt: ts, updatedAt: ts, repoKey: F.repoKey }));
  const old = process.env.CODEX_BRIDGE_ASK_JOB_ID; process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-mfl-1";
  try {
    assert.strictEqual(CL.writeEnvelopeFreeze(F.ws, CORE_HASH, "ask-mfl-1"), true);
    // B(다른 저장소 표식)의 통과 판 + 열린 지적 — 같은 캠페인·같은 세대 · ★그리고 업그레이드 이전 무표식(옛) 통과 판·열린 지적(4판 blocker①): 소속 불명=새 판정에서 제외
    assert.ok(CL.appendFindingsLedger(F.ws, [
      { type: "round", campaignId: CAMP, round: 1, roundType: "discovery", verdict: "pass", envelopeHash: CORE_HASH, repoKey: "0000000000000000", ts },
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-B", tag: "blocker", titleNorm: "b결함", status: "open", envelopeHash: CORE_HASH, repoKey: "0000000000000000", ts },
    ]));
    const legacyLines = [
      JSON.stringify({ type: "round", campaignId: CAMP, round: 1, roundType: "discovery", verdict: "pass", envelopeHash: CORE_HASH, ts }),
      JSON.stringify({ type: "finding", campaignId: CAMP, round: 1, findingId: "f-legacy", tag: "blocker", titleNorm: "옛결함", status: "open", envelopeHash: CORE_HASH, ts }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    fs.appendFileSync(CL.findingsLedgerFileFor(F.ws), legacyLines); // 관문을 거치지 않고 직접 append=표식 없는 옛 행 흉내
    const answer = "본문" + String.fromCharCode(10) + "[지적 목록 v2]" + String.fromCharCode(10) + "[지적 목록 끝]" + String.fromCharCode(10) + String.fromCharCode(10) + "검증: 통과" + String.fromCharCode(10);
    CB.machineFindingsLayer(answer, F.ws, "ko", "core", "claude-codex", "ask-mfl-1", CAMP, F.repoKey);
    const rows = CL.readFindingsLedger(F.ws);
    const myRound = rows.find((r) => r.type === "round" && r.repoKey === F.repoKey);
    assert.ok(myRound && myRound.round === 1 && myRound.roundType === "discovery", "A 첫 판=discovery·round 1(B 통과 판 미참조) " + JSON.stringify(myRound));
    assert.ok(!rows.some((r) => r.type === "close" && r.findingId === "f-B"), "★B 지적 f-B는 A 판이 닫지 않는다");
    assert.ok(!rows.some((r) => r.type === "close" && r.findingId === "f-legacy"), "★무표식 옛 지적 f-legacy도 A 판이 닫지 않는다(소속 불명=제외)");
    assert.ok(rows.filter((r) => r.type === "round" && r.repoKey === F.repoKey).length === 1, "A 판 1건만 기록");
    assert.ok(rows.filter((r) => r.repoKey === F.repoKey).every((r) => r.type !== "finding" || r.findingId !== "f-B"), "A 표식으로 기록된 행에 B 지적 없음");
    const stillOpenB = CL.openFindingsFromRows(rows.filter((r) => r.repoKey === "0000000000000000"), CAMP, CORE_HASH);
    assert.ok(stillOpenB.some((o) => o.id === "f-B"), "B 기준 판독에서 f-B는 여전히 열림");
  } finally { if (old === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = old; }
});

t("★반례(4판 blocker②) — B 표식의 되받아침(implementer-oos)이 A 입장 심사에서 같은 제목 blocker를 강등하지 않는다 · 검증 주입(v2DynamicData)에 B 열린 지적·되받아침 없음 · 관문·판단 명령도 같은 규칙(소스 핀)", () => {
  const CB = require("../bridge/codex-bridge.js");
  const F = fixture("rebut", false);
  const CAMP = "cl:rebut:1"; const ts = new Date().toISOString();
  fs.mkdirSync(path.dirname(CL.campaignFileFor(F.ws)), { recursive: true });
  fs.writeFileSync(CL.campaignFileFor(F.ws), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 1, budget: 9, startedAt: ts, updatedAt: ts, repoKey: F.repoKey }));
  const old = process.env.CODEX_BRIDGE_ASK_JOB_ID; process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-rb-1";
  try {
    assert.strictEqual(CL.writeEnvelopeFreeze(F.ws, CORE_HASH, "ask-rb-1", { oos: [{ id: "oos-1", title: "다중 서버 동시 배포" }] }), true);
    const tn = CL.normBacklogTitle("배포 스크립트가 원격에 무승인 전송한다");
    assert.ok(CL.appendFindingsLedger(F.ws, [
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-Bx", tag: "blocker", titleNorm: tn, title: "배포 스크립트가 원격에 무승인 전송한다", status: "open", envelopeHash: CORE_HASH, repoKey: "0000000000000000", ts },
      { type: "close", campaignId: CAMP, round: 1, findingId: "f-Bx", closeReason: "implementer-oos", oosId: "oos-1", envelopeHash: CORE_HASH, repoKey: "0000000000000000", ts },
    ]));
    // 주입: B의 열린 지적·되받아침이 A(현재 저장소) 프롬프트 재료에 실리지 않는다
    const dyn = String(CB.v2DynamicData(F.ws, "ko") || "");
    assert.ok(!dyn.includes("f-Bx") && !dyn.includes("배포 스크립트가 원격에"), "★검증 주입에 B 지적·되받아침 없음: " + dyn.slice(0, 200));
    // 입장 심사: A 검증자가 같은 제목의 blocker를 제출 — B의 되받아침으로 강등되면 안 됨
    const NL = String.fromCharCode(10);
    const answer = ["본문", "[지적 목록 v2]", JSON.stringify({ tag: "blocker", title: "배포 스크립트가 원격에 무승인 전송한다", origin: "baseline", supported: true }), "[지적 목록 끝]", "", "검증: 실패"].join(NL) + NL;
    CB.machineFindingsLayer(answer, F.ws, "ko", "core", "claude-codex", "ask-rb-1", CAMP, F.repoKey);
    const rows = CL.readFindingsLedger(F.ws);
    const mine = rows.filter((r) => r.type === "finding" && r.repoKey === F.repoKey && r.titleNorm === tn);
    assert.ok(mine.length === 1 && mine[0].tag === "blocker" && !mine[0].demoted, "★A blocker 유지(B 되받아침 미적용) " + JSON.stringify(mine));
    const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
    assert.ok(cb.includes("implementerRebuttalsFor(ws, camp, frozen, repoKeySnap)") && cb.includes("function implementerRebuttalsFor(ws, camp, gen, repoKey)"), "되받아침 판독 저장소 결속(소스 핀)");
    assert.ok(cb.includes('undisposedOpenFindingsFromRows(require("./contract-lib.js").ledgerRowsForRepo(st.rows, require("./contract-lib.js").repoKeyNow(ws)), camp, readFrozenEnvelope(ws))'), "시작 관문=현재 저장소 행만(소스 핀)");
    assert.ok(cb.includes('const rowsMine = require("./contract-lib.js").ledgerRowsForRepo(rows, rkCurJ);') && cb.includes('dispositionsFromRows(rowsMine, camp)') && (cb.match(/undisposedOpenFindingsFromRows\((rowsMine|require\("\.\/contract-lib\.js"\)\.ledgerRowsForRepo\(readFindingsLedger\(ws\), rkCurJ\)), camp, gen\)\.length/g) || []).length === 2, "finding-judge 처분·잔여·열린 목록=현재 저장소 행만(소스 핀)");
    const sm = cb.slice(cb.indexOf("const sameRepoM = "), cb.indexOf("\n", cb.indexOf("const sameRepoM = ")));
    assert.ok(!/repoKey === undefined/.test(sm), "결과 처리 필터=표식 일치만(무표식 포함 조항 제거)");
  } finally { if (old === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = old; }
});

t("★반례(5판 blocker①~④ ab-1) — 남은 활성 판독 4곳도 저장소 표식 일치 행만: finding-judge 유효성/fix-gap 누계 · 결과 부가 보고 3종 · rule-propose · MAP 수확기", () => {
  const CB = require("../bridge/codex-bridge.js");
  const MPV = require("../bridge/map-provenance.js");
  const F = fixture("tail", false);
  const CAMP = "cl:tail:1"; const ts = new Date().toISOString(); const B = "0000000000000000";
  fs.mkdirSync(path.dirname(CL.campaignFileFor(F.ws)), { recursive: true });
  fs.writeFileSync(CL.campaignFileFor(F.ws), JSON.stringify({ schema: "vcamp-1", campaignId: CAMP, count: 1, budget: 9, startedAt: ts, updatedAt: ts, repoKey: F.repoKey }));
  const old = process.env.CODEX_BRIDGE_ASK_JOB_ID; process.env.CODEX_BRIDGE_ASK_JOB_ID = "ask-tail-1";
  try {
    assert.strictEqual(CL.writeEnvelopeFreeze(F.ws, CORE_HASH, "ask-tail-1"), true);
    // ① A: f-x round 1 + fix-gap 처분(asOfRound 1) · B: 같은 id의 round 2 재등장 + B 자신의 fix-gap 처분 2건
    assert.ok(CL.appendFindingsLedger(F.ws, [
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-x", tag: "blocker", title: "A 결함 x", titleNorm: "a결함x", status: "open", envelopeHash: CORE_HASH, ts },
      { type: "disposition", campaignId: CAMP, findingId: "f-x", choice: "fix-gap", note: "보강", asOfRound: 1, ts },
    ], { repoKey: F.repoKey }));
    assert.ok(CL.appendFindingsLedger(F.ws, [
      { type: "occurrence", campaignId: CAMP, round: 2, findingId: "f-x", ts },
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-b1", tag: "blocker", title: "B1", titleNorm: "b1", status: "open", envelopeHash: CORE_HASH, ts },
      { type: "disposition", campaignId: CAMP, findingId: "f-b1", choice: "fix-gap", note: "보강", asOfRound: 1, ts },
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-b2", tag: "blocker", title: "B2", titleNorm: "b2", status: "open", envelopeHash: CORE_HASH, ts },
      { type: "disposition", campaignId: CAMP, findingId: "f-b2", choice: "fix-gap", note: "보강", asOfRound: 1, ts },
      // ② B의 범위 밖 강등 2건(같은 세대) — A 결과의 원인 분해·후보 재료·재심 재료에 섞이면 안 됨
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-bo1", tag: "blocker", title: "BO1", titleNorm: "bo1", status: "open", demoted: true, oosId: "oos-1", envelopeHash: CORE_HASH, ts },
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-bo2", tag: "blocker", title: "BO2", titleNorm: "bo2", status: "open", demoted: true, oosId: "oos-1", envelopeHash: CORE_HASH, ts },
      // ③ B의 해결된 blocker(rule-propose 자격 형태) · ④ B의 fix-fact 처분(sourceRefs 있음)
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-bres", tag: "blocker", title: "B 해결 지적 제목", titleNorm: "b해결지적제목", status: "open", envelopeHash: CORE_HASH, ts },
      { type: "close", campaignId: CAMP, findingId: "f-bres", closeReason: "resolved", round: 2, askId: "ask-b-9", envelopeHash: CORE_HASH, ts },
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-h", tag: "blocker", title: "H", titleNorm: "h", status: "open", envelopeHash: CORE_HASH, ts },
      { type: "disposition", campaignId: CAMP, findingId: "f-h", choice: "fix-fact", note: "사실", asOfRound: 1, sourceRefs: [{ file: "docs/x.md", anchor: "heading:근거", contentHash: "deadbeef", repoKey: B }], repoPath: F.repo, ts },
    ], { repoKey: B }));
    // A: 자기 해결 blocker(양성 대조) + f-h의 A 종결(B 처분과 결합 금지)
    assert.ok(CL.appendFindingsLedger(F.ws, [
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-ares", tag: "blocker", title: "A 해결 지적 제목", titleNorm: "a해결지적제목", status: "open", envelopeHash: CORE_HASH, ts },
      { type: "close", campaignId: CAMP, findingId: "f-ares", closeReason: "resolved", round: 2, askId: "ask-a-9", envelopeHash: CORE_HASH, ts },
      { type: "close", campaignId: CAMP, findingId: "f-h", closeReason: "resolved", round: 2, askId: "ask-a-9", envelopeHash: CORE_HASH, ts },
    ], { repoKey: F.repoKey }));
    const all = CL.readFindingsLedger(F.ws);
    const mine = CL.ledgerRowsForRepo(all, F.repoKey);
    // ① 유효성·fix-gap 누계
    const dA = CL.dispositionsFromRows(mine, CAMP).get("f-x");
    assert.strictEqual(CL.dispositionValid(all, CAMP, dA), false, "(전제) 전체 장부로 보면 B의 round 2 재등장이 A 처분을 낡게 만든다");
    assert.strictEqual(CL.dispositionValid(mine, CAMP, dA), true, "★A 행만 보면 A 처분(asOf 1 ≥ 활동 1) 유효");
    assert.strictEqual(CL.fixGapCount(F.ws, CAMP, F.repoKey), 1, "★fix-gap 누계=A 행만(B 2건 불산입·A 처분은 유효)");
    assert.strictEqual(CL.fixGapCount(F.ws, CAMP, B), 2, "B 기준=B 2건");
    // ② 결과 부가 보고 3종(시작 스냅샷 키)
    const res = { tracked: true, last: {} };
    const bd = String(CB.breakdownNoticeFor(F.ws, "ko", res, F.repoKey) || "");
    assert.ok(/범위 밖 강등 0/.test(bd) && /초기 결함 2/.test(bd), "★원인 분해=A 행만(강등 0·초기 결함 2=f-x·f-ares — f-h의 finding은 B 것) " + JSON.stringify(bd));
    assert.ok(/범위 밖 강등 2/.test(String(CB.breakdownNoticeFor(F.ws, "ko", res) || "")), "(전제) 키 없음=전체(B 강등 2 포함)");
    assert.strictEqual(String(CB.integrityReviewLine(F.ws, "ko", "integrity", F.repoKey) || ""), "", "★재심 재료=A 행만(A 강등 0=빈 줄)");
    assert.ok(/oos-1 ×2/.test(String(CB.integrityReviewLine(F.ws, "ko", "integrity") || "")), "(전제) 키 없음=B 강등 집계");
    const cand = String(CB.envelopeCandidateNoticeFor(F.ws, "ko", res, "core", F.repoKey) || "");
    assert.ok(cand && !/oos-repeat/.test(cand), "★후보 재료=A 행만(B의 oos-repeat 없음) " + JSON.stringify(cand));
    assert.ok(/oos-repeat/.test(String(CB.envelopeCandidateNoticeFor(F.ws, "ko", res, "core") || "")), "(전제) 키 없음=B의 oos-repeat 후보가 보임");
    // ③ rule-propose: 타 저장소 해결 지적=finding-not-found · 자기 저장소=성립
    const rp = CL.ruleProposeCandidate(F.ws, F.repo, { findingId: "f-bres", why: "이 상황은 늘 먼저 막아야 하는 관통 지침이다", campaignId: CAMP });
    assert.ok(rp && rp.ok === false && rp.reason === "finding-not-found", "★B 지적으로 A 후보 생성 거부 " + JSON.stringify(rp));
    const rpA = CL.ruleProposeCandidate(F.ws, F.repo, { findingId: "f-ares", why: "이 상황은 늘 먼저 막아야 하는 관통 지침이다", campaignId: CAMP });
    assert.ok(rpA && rpA.ok === true, "A 자기 지적=후보 성립(양성 대조) " + JSON.stringify(rpA));
    // ④ 수확기: A 종결 판의 저장소 행만 → B 처분이 안 보여 거부
    const hv = MPV.harvestFromResolvedFinding(F.ws, F.repo, CAMP, "f-h", F.repoKey);
    assert.ok(hv && hv.ok === false && hv.reason === "disposition", "★A 종결+B 처분 결합 불가(A 행에 처분 없음) " + JSON.stringify(hv));
    assert.notStrictEqual(MPV.harvestFromResolvedFinding(F.ws, F.repo, CAMP, "f-h").reason, "disposition", "(전제) 키 없음=B 처분이 보여 처분 관문을 통과한다");
    // 소스 핀 — 호출 지점이 시작 스냅샷/현재 저장소 키를 넘긴다
    const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
    assert.ok(cb.includes("const valid = dispositionValid(rowsMine, camp, d);") && cb.includes("const gaps = fixGapCount(ws, camp, rkCurJ);"), "finding-judge 유효성·fix-gap=현재 저장소 행");
    assert.ok(cb.includes("breakdownNoticeFor(ws, langSnap, budgetGate.res, repoKeySnap9)") && cb.includes("envelopeCandidateNoticeFor(ws, langSnap, budgetGate.res, profileSnap, repoKeySnap9)") && cb.includes("integrityReviewLine(ws, langSnap, profileSnap, repoKeySnap9);"), "부가 보고 3종=시작 스냅샷 키");
    assert.ok(cb.includes("MPV9.harvestFromResolvedFinding(ws, repo9, camp, r9.findingId, repoKeySnap);"), "수확기 호출=시작 스냅샷 키");
    const cl = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
    assert.ok(cl.includes("const rows = ledgerRowsForRepo(readFindingsLedger(ws), repoKeyOf(repo));"), "rule-propose=현재 대상 저장소 행");
  } finally { if (old === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = old; }
});

t("★반례(2차 캠페인 1판 blocker ab-1) — 판단 관문 마커·round-judgment의 저장소 결속: A 검증이 건 마커를 대상이 B로 바뀐 뒤 판단해도 A 표식으로 기록·B의 같은 askId 판단과 섞이지 않음", () => {
  const F = fixture("judge", false);
  const CAMP = "cl:judge:1"; const ASK = "ask-judge-1"; const B = "0000000000000000"; const ts = new Date().toISOString();
  // B 표식의 같은 (캠페인, askId) 판단 행이 먼저 있음(다른 선택) — A 마커 해소가 이를 '이미 판단됨' 상충으로 보면 안 된다
  assert.ok(CL.appendFindingsLedger(F.ws, [{ type: "round-judgment", campaignId: CAMP, askId: ASK, choice: "close-oos", note: "B 저장소의 판단", decisionId: "", reason: "scope-demoted", ts }], { repoKey: B }));
  assert.ok(CL.addJudgeRequired(F.ws, { askId: ASK, campaignId: CAMP, reason: "compacted-mid-ask", repoKey: F.repoKey }));
  const mk = CL.readJudgeRequired(F.ws);
  assert.ok(mk && mk.items.length === 1 && mk.items[0].repoKey === F.repoKey, "마커가 검증 시작 저장소 표식을 기억 " + JSON.stringify(mk));
  // 정찰 대상을 B 경로로 전환(현재 계약 저장소 ≠ 마커 저장소)
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "curt-judge-repoB-"));
  assert.ok(CL.updateContractPatch(F.ws, "ko", { scoutRepo: repoB }).ok);
  const rkB = CL.repoKeyOf(repoB); assert.notStrictEqual(rkB, F.repoKey);
  const r = CL.resolveJudgeRequired(F.ws, ASK, "re-verify", { note: "A 판정 재판 요청 — 저장소 결속 시험" });
  assert.ok(r && r.ok === true, "★B가 현재 대상이어도 A 마커 판단이 기록됨(B 행과 상충 오판 없음) " + JSON.stringify(r));
  const rows = CL.readFindingsLedger(F.ws).filter((x) => x.type === "round-judgment" && x.askId === ASK);
  const mine = rows.filter((x) => x.repoKey === F.repoKey);
  assert.ok(mine.length === 1 && mine[0].choice === "re-verify", "★판단 행=마커의 A 표식(현재 계약 B 아님) " + JSON.stringify(rows));
  assert.ok(!rows.some((x) => x.repoKey === rkB), "현재 계약 B 표식으로 기록된 판단 행 없음");
  assert.strictEqual(CL.readJudgeRequired(F.ws), null, "마커 제거됨");
  // 호출자 미전달 축퇴: repoKey 없이 마커를 걸면 관문 기본(현재 계약 저장소)으로 채운다
  assert.ok(CL.addJudgeRequired(F.ws, { askId: "ask-judge-2", campaignId: CAMP, reason: "scope-demoted" }));
  assert.strictEqual(CL.readJudgeRequired(F.ws).items[0].repoKey, rkB, "미전달=현재 계약 저장소(관문 스탬프와 동형)");
  // 소스 핀: 마커를 만드는 세 곳이 검증 시작 스냅샷 키를 넘긴다
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes('reason: "scope-demoted", repoKey: repoKey || ""') && cb.includes("armScopeDemotedJudge(ws, camp, askId, en, repoKeySnap)"), "전량 강등 마커=시작 스냅샷 키");
  assert.ok(cb.includes("applyPostflightHold(mfl, attCarrier, ws, askId, campSnap, langSnap, repoKeySnap9);") && cb.includes('reason: key, repoKey: repoKey || ""'), "압축 보류 마커=시작 스냅샷 키");
  assert.ok(cb.includes('reason: "dispute:" + String(f.contestOf || ""), repoKey: repoKeySnap || ""'), "분쟁 마커=시작 스냅샷 키");
  // ★2판 blocker①: 옛 무키 마커(업그레이드 이전) — 현재 계약 B로 찍으면 오귀속. 소속 불명은 표식 없이(이력만) 남기고 마커는 풀린다.
  fs.writeFileSync(CL.judgeFileFor(F.ws), JSON.stringify({ schema: "judge-required-v1", ws: String(F.ws), items: [{ askId: "ask-legacy-1", campaignId: CAMP, reason: "scope-demoted", ts }] }, null, 1));
  const rL = CL.resolveJudgeRequired(F.ws, "ask-legacy-1", "re-verify", { note: "옛 마커 해소 — 소속 불명 시험" });
  assert.ok(rL && rL.ok === true, "옛 무키 마커도 풀린다(턴 종료 차단 장치) " + JSON.stringify(rL));
  const rowL = CL.readFindingsLedger(F.ws).filter((x) => x.type === "round-judgment" && x.askId === "ask-legacy-1");
  assert.ok(rowL.length === 1 && !("repoKey" in rowL[0]) && rowL[0].repoUnknown === true, "★옛 마커의 판단 행=표식 없음(현재 계약 B로 찍지 않음·이력만) " + JSON.stringify(rowL));
  assert.ok(!CL.ledgerRowsForRepo(CL.readFindingsLedger(F.ws), rkB).some((x) => x.askId === "ask-legacy-1"), "B 저장소 활성 판독에 옛 마커 판단이 안 보임");
  assert.strictEqual(CL.readJudgeRequired(F.ws), null, "옛 마커 제거됨");
  // ★2판 blocker②: escalate 결정 결속 — B 저장소에서 만든 결정을 A 판정에 묶을 수 없다(같은 저장소 결정만)
  const specD = (q, rk) => ({ origin: "implementer", kind: "product", campaignId: CAMP, sourceAsk: "ask-judge-3", targetFp: "", question: q, why: "시험용 이유", noDefault: "구현자가 정할 수 없는 제품 방향 문제라서", choices: [{ key: "keep", label: "유지" }, { key: "change", label: "변경" }], recommend: "keep", repoKey: rk });
  const dB = CL.openDecision(F.ws, specD("B 저장소의 질문입니까?", B)); const dA = CL.openDecision(F.ws, specD("A 저장소의 질문입니까?", F.repoKey));
  assert.ok(dB.ok && dA.ok && dB.decisionId !== dA.decisionId, "결정 두 건(B·A 표식) " + JSON.stringify([dB, dA]));
  assert.ok(CL.addJudgeRequired(F.ws, { askId: "ask-judge-3", campaignId: CAMP, reason: "scope-demoted", repoKey: F.repoKey }));
  const rM = CL.resolveJudgeRequired(F.ws, "ask-judge-3", "escalate", { note: "다른 저장소 결정으로 올리기 시도", decisionId: dB.decisionId });
  assert.ok(rM && rM.ok === false && rM.reason === "decision-repo-mismatch", "★B 결정을 A 판정에 결속=거부 " + JSON.stringify(rM));
  assert.ok(CL.readJudgeRequired(F.ws) && CL.readJudgeRequired(F.ws).items.length === 1, "거부 시 마커 유지");
  const rOk = CL.resolveJudgeRequired(F.ws, "ask-judge-3", "escalate", { note: "같은 저장소 결정으로 올림", decisionId: dA.decisionId });
  assert.ok(rOk && rOk.ok === true && rOk.decisionId === dA.decisionId, "같은 저장소(A) 결정=기록 " + JSON.stringify(rOk));
  assert.ok(cb.includes('"decision-repo-mismatch": tB(') && cb.includes("[저장소 분할 단일 규칙 · escalate 결정 결속(2차 캠페인 2판 blocker·ab-1)]"), "finding-judge/round-judge 결정 저장소 대조 소스 핀");
});

t("★반례(2차 캠페인 3판 blocker ab-1) — 결정 장부의 생성·목록·선택·마감 동봉이 저장소별: A에서 만든 결정은 B 대상에서 안 보이고 종결도 거부, 같은 내용을 B에서 올리면 별도 항목", () => {
  const F = fixture("dec", false);
  const CAMP = "cl:dec:1"; const B = "0000000000000000";
  const spec = (q) => ({ origin: "implementer", kind: "product", campaignId: CAMP, sourceAsk: "ask-dec-1", targetFp: "", question: q, why: "시험", noDefault: "구현자가 정할 수 없는 제품 방향 문제라서", choices: [{ key: "keep", label: "유지" }, { key: "change", label: "변경" }], recommend: "keep" });
  const dA = CL.openDecision(F.ws, spec("A의 질문입니까?"));
  assert.ok(dA.ok && !dA.existed, JSON.stringify(dA));
  const rowA = CL.readDecisions(F.ws).latest.get(dA.decisionId);
  assert.strictEqual(rowA.repoKey, F.repoKey, "결정 행=현재 계약(A) 표식");
  // 현재 저장소(A) 기준 표면에는 보임
  assert.ok(CL.readDecisions(F.ws, { repoKey: F.repoKey }).open.some((d) => d.decisionId === dA.decisionId), "A 기준 목록에 있음");
  // 대상을 B로 전환 → 목록·마감 동봉에서 사라지고 종결 거부
  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "curt-dec-repoB-"));
  assert.ok(CL.updateContractPatch(F.ws, "ko", { scoutRepo: repoB }).ok);
  const rkB = CL.repoKeyOf(repoB);
  assert.ok(!CL.readDecisions(F.ws, { repoKey: rkB }).open.some((d) => d.decisionId === dA.decisionId), "★B 기준 목록에 A 결정 없음");
  const rB = CL.resolveDecision(F.ws, dA.decisionId, "keep", { by: "user", repoKey: rkB });
  assert.ok(rB && rB.ok === false && rB.reason === "repo-mismatch", "★B에서 A 결정 종결=거부 " + JSON.stringify(rB));
  assert.strictEqual(CL.readDecisions(F.ws).latest.get(dA.decisionId).status, "open", "거부 뒤에도 열린 상태 유지");
  // 같은 내용을 B에서 올리면 A id 재사용 없이 별도 항목(id 산식에 저장소 포함)
  const dB = CL.openDecision(F.ws, spec("A의 질문입니까?"));
  assert.ok(dB.ok && !dB.existed && dB.decisionId !== dA.decisionId, "★B에서 같은 내용 raise=별도 항목(existed 아님) " + JSON.stringify([dA.decisionId, dB.decisionId]));
  assert.strictEqual(CL.readDecisions(F.ws).latest.get(dB.decisionId).repoKey, rkB);
  // 마감 문맥 동봉도 현재 저장소(B)만
  const VH = require("../bridge/verify-cap-handoff.js");
  const ctx = VH.capHandoffContext(process.env.CODEX_BRIDGE_HOME, F.ws, CAMP);
  const ids = (ctx.decisions || []).map((d) => d.id);
  assert.ok(ids.includes(dB.decisionId) && !ids.includes(dA.decisionId), "★마감 동봉 결정=B 항목만 " + JSON.stringify(ids));
  // A로 되돌리면 A 결정만 보이고 A에서 종결 가능
  assert.ok(CL.updateContractPatch(F.ws, "ko", { scoutRepo: F.repo }).ok);
  assert.ok(CL.readDecisions(F.ws, { repoKey: F.repoKey }).open.some((d) => d.decisionId === dA.decisionId) && !CL.readDecisions(F.ws, { repoKey: F.repoKey }).open.some((d) => d.decisionId === dB.decisionId), "A 기준=A만");
  const rA = CL.resolveDecision(F.ws, dA.decisionId, "keep", { by: "user", repoKey: F.repoKey });
  assert.ok(rA && rA.ok === true, "A에서 A 결정 종결 " + JSON.stringify(rA));
  assert.strictEqual(CL.readDecisions(F.ws).rows.filter((r) => r.decisionId === dA.decisionId && r.status === "chosen")[0].repoKey, F.repoKey, "결과 행도 저장소 표식 승계");
  // 키 없는 호출(계약 모름)=종전 전체(축퇴) · 빈 키 결정은 표식 없는 이력
  assert.ok(CL.readDecisions(F.ws).latest.has(dA.decisionId) && CL.readDecisions(F.ws).latest.has(dB.decisionId), "무필터 판독=전체(축퇴)");
  // 소스 핀 — 표면 4곳이 현재 저장소 키를 넘긴다
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes('const rkDec = require("./contract-lib.js").repoKeyNow(ws);') && (cb.match(/readDecisions\(ws, decOpts\)/g) || []).length === 3 && cb.includes('resolveDecision(ws, id, key, { currentFp, by: "user", repoKey: rkDec })') && cb.includes("decisionMetrics(ws, camp, rkDec)"), "decisions CLI 표면=현재 저장소");
  const vh = fs.readFileSync(path.join(__dirname, "..", "bridge", "verify-cap-handoff.js"), "utf8");
  assert.ok(vh.includes("readDecisions(ws, rkD ? { repoKey: rkD } : undefined).open"), "마감 동봉=현재 저장소");
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(ext.includes("lib.readDecisions(ws, (typeof lib.repoKeyNow === \"function\" && lib.repoKeyNow(ws)) ? { repoKey: lib.repoKeyNow(ws) } : undefined)"), "대시보드 '지금 정할 것'=현재 저장소");
  // ★4판 blocker: 업그레이드 이전 두 창 경합으로 같은 id의 open(A)·open(B)가 남고 결과 행이 뒤따르는 옛 상태 — 결과 행은 표식 일치 원항목에만 합성·B는 자기 항목을 종결할 수 있어야 한다
  const X = "abcdef0123456789"; const tsX = new Date().toISOString();
  const openRow = (rk) => ({ schema: "decision-v1", decisionId: X, status: "open", wsKey: CL.wsKeyFor(F.ws), repoKey: rk, origin: "implementer", kind: "product", noDefault: "구현자가 정할 수 없는 제품 방향 문제라서", campaignId: CAMP, sourceAsk: "ask-old", targetFp: "", question: "옛 동일 id 질문?", why: "w", choices: [{ key: "keep", label: "유지" }, { key: "change", label: "변경" }], recommend: "keep", ts: tsX });
  fs.appendFileSync(CL.decisionsFileFor(F.ws), [openRow(F.repoKey), openRow(rkB), { schema: "decision-v1", decisionId: X, status: "chosen", wsKey: CL.wsKeyFor(F.ws), repoKey: F.repoKey, choice: "keep", by: "user", ts: tsX }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.strictEqual(CL.readDecisions(F.ws, { repoKey: F.repoKey }).latest.get(X).status, "chosen", "A 판독=A 결과 합성");
  const bView = CL.readDecisions(F.ws, { repoKey: rkB }).latest.get(X);
  assert.ok(bView && bView.status === "open" && bView.repoKey === rkB, "★B 판독=B 항목 열린 채(A 결과 행 미합성) " + JSON.stringify(bView));
  const rBX = CL.resolveDecision(F.ws, X, "change", { by: "user", repoKey: rkB });
  assert.ok(rBX && rBX.ok === true, "★B가 자기 동일 id 항목을 종결(필터 판독에서 대상 조회) " + JSON.stringify(rBX));
  assert.strictEqual(CL.readDecisions(F.ws, { repoKey: rkB }).latest.get(X).choice, "change", "B 결과=B 선택");
  assert.strictEqual(CL.readDecisions(F.ws, { repoKey: F.repoKey }).latest.get(X).choice, "keep", "A 결과는 그대로(B 결과 행이 A에 합성되지 않음)");
  // 무표식 옛 결과 행+동일 id가 두 저장소에 열림=귀속 불명 → 어느 저장소 판독에도 합성하지 않는다(다시 묻는 편이 거짓 종결보다 안전) · 무필터 판독은 종전 동작
  const Y = "fedcba9876543210";
  fs.appendFileSync(CL.decisionsFileFor(F.ws), [Object.assign(openRow(F.repoKey), { decisionId: Y }), Object.assign(openRow(rkB), { decisionId: Y }), { schema: "decision-v1", decisionId: Y, status: "chosen", wsKey: CL.wsKeyFor(F.ws), choice: "keep", by: "user", ts: tsX }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.strictEqual(CL.readDecisions(F.ws, { repoKey: F.repoKey }).latest.get(Y).status, "open", "★무표식 옛 결과 행은 A에 합성 안 함(귀속 불명)");
  assert.strictEqual(CL.readDecisions(F.ws, { repoKey: rkB }).latest.get(Y).status, "open", "★무표식 옛 결과 행은 B에도 합성 안 함");
  assert.strictEqual(CL.readDecisions(F.ws).latest.get(Y).status, "chosen", "무필터 판독=종전 합성(축퇴)");
  // 무표식 옛 결과 행이지만 동일 id가 한 저장소에만 열려 있으면 종전처럼 합성(옛 정상 기록 무회귀)
  const Z = "0123456789abcdef";
  fs.appendFileSync(CL.decisionsFileFor(F.ws), [Object.assign(openRow(F.repoKey), { decisionId: Z }), { schema: "decision-v1", decisionId: Z, status: "delegated", wsKey: CL.wsKeyFor(F.ws), choice: "delegate", by: "user", ts: tsX }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.strictEqual(CL.readDecisions(F.ws, { repoKey: F.repoKey }).latest.get(Z).status, "delegated", "단일 저장소 옛 결과 행=합성(무회귀)");
  const cu = fs.readFileSync(path.join(__dirname, "..", "bridge", "curation.js"), "utf8");
  assert.ok(cu.includes("const d = CL.readDecisions(ws, { repoKey });"), "큐레이션 입력도 필터 판독");
});

t("[2026-09-06 사용자 결정 묶음 핀] 정리 담당 팔=탐색 담당 유효 팔 · 재료 0=무호출 · refs 필수·울타리 1겹 · deepseek 팔=브릿지 page · 지적 블록 미수용 고지 · 고지문·결정 기록", () => {
  const rd2 = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const cu2 = rd2("bridge/curation.js");
  const fnBody = (src, sig) => { const i = src.indexOf(sig); assert.ok(i > 0, sig + " 존재"); return src.slice(i, src.indexOf("\n}\n", i)); };
  const armFn = fnBody(cu2, "function selectorArmForCuration(");
  assert.ok(armFn.includes("CL.scoutArmView(ws, cc)") && !/harnessMode/.test(armFn), "팔 결정=scoutArmView eff(운용 모드·새 설정 항목 없음)");
  const skipFn = fnBody(cu2, "function curationSkip(");
  assert.ok(skipFn.includes('if (input.signalCount === 0) return { skip: true, reason: "no-signal" };') && !/boundaryGen === input\.boundaryGen/.test(skipFn), "재료 0=무조건 생략(지난 실행·세대 비교 폐지)");
  assert.ok(cu2.includes('if (!refs.length) { drop("no-ref"); continue; }') && cu2.includes("^```[a-zA-Z0-9_-]*"), "refs 필수·울타리 1겹 벗김");
  assert.ok(/refs는 아래 신호 목록의 id를 최소 1개/.test(cu2) && /at least one id from the signal list/.test(cu2), "프롬프트 규칙 문장도 refs 최소 1개(양언어)");
  assert.ok(!rd2("bridge/selector-runner.js").includes("deepseek"), "선별 실행기(selector-runner)는 교차 팔 없음 그대로(envelope-selector 소스 계약·ab-7 경계 — 체인 첫 실행이 잡은 반례)");
  assert.ok(cu2.includes("function runCurationDeepseekPage(") && cu2.includes("CODEX_BRIDGE_DEEPSEEK_BRIDGE") && cu2.includes('[bridge, "page"]') && cu2.includes('arm === "deepseek" ? runCurationDeepseekPage'), "deepseek=정리 담당 전용 실행기(브릿지 page·env 스텁 주입점)·runCuration 분기");
  const ds = rd2("bridge/deepseek-bridge.js");
  assert.ok(ds.includes('cmd === "page"') && ds.includes('inheritedUsageContext("selector-page"') && /ping\|map\|capability\|enrich\|page/.test(ds), "deepseek-bridge page 명령+사용량 장부+사용법 문구");
  const cb2 = rd2("bridge/codex-bridge.js");
  assert.ok(cb2.includes("if (parse.present && !blockShaped) {") && cb2.includes("[지적 블록 미수용 — 사유 ") && cb2.includes("[findings block NOT accepted — reason "), "손상 지적 블록=미등록 사실 고지(양언어)");
  assert.ok(/정리 담당\(수칙 정리\) 실행 시/.test(rd2("PRIVACY.md")), "PRIVACY 정리 재료 전송 항목");
  assert.ok(/정리 재료/.test(rd2("src/extension.ts")) && /curation material/.test(rd2("src/extension.ts")), "정찰 카드 FAQ 고지(양언어)");
  assert.ok(/D-2026-09-06-curator-arm-follows-scout/.test(rd2("docs/DECISIONS.md")) && /D-2026-09-06-curator-arm-follows-scout/.test(rd2("docs/CURATION-DESIGN.md")) && /다섯 명령/.test(rd2("src/deepseek-config.ts")), "결정 기록·설계 정본·소스 계약 갱신");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
