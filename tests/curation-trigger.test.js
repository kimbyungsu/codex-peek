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
  assert.ok(ext.includes("curation: { lastTs: string; lastOutcome: string;") && ext.includes("unusedCount: number") && ext.includes("CU9.curationSummary(ws)"), "상태(4지표 포함)");
  assert.ok(ext.includes('m?.type === "curationRun"') && ext.includes('"curate", "run", "--button"') && ext.includes("CLAUDE_PROJECT_DIR: wsQ"), "버튼 핸들러=detach curate run --button");
  const beg = ext.indexOf("if(d.curation){"); const end = ext.indexOf("var actT=e9.act", beg);
  assert.ok(beg > 0 && end > beg, "카드 줄 블록");
  const blk = ext.slice(beg, end);
  assert.ok(!/innerHTML/.test(blk) && blk.includes("정리 제안 받기") && blk.includes("cu9.adoptRate") && blk.includes("cu9.archiveSize") && blk.includes("cu9.selOverCount") && blk.includes("cu9.unusedCount") && blk.includes('vscode.postMessage({type:"curationRun"})'), "카드 줄 4지표·버튼(textContent)");
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
    // B(다른 저장소 표식)의 통과 판 + 열린 지적 — 같은 캠페인·같은 세대
    assert.ok(CL.appendFindingsLedger(F.ws, [
      { type: "round", campaignId: CAMP, round: 1, roundType: "discovery", verdict: "pass", envelopeHash: CORE_HASH, repoKey: "0000000000000000", ts },
      { type: "finding", campaignId: CAMP, round: 1, findingId: "f-B", tag: "blocker", titleNorm: "b결함", status: "open", envelopeHash: CORE_HASH, repoKey: "0000000000000000", ts },
    ]));
    const answer = "본문" + String.fromCharCode(10) + "[지적 목록 v2]" + String.fromCharCode(10) + "[지적 목록 끝]" + String.fromCharCode(10) + String.fromCharCode(10) + "검증: 통과" + String.fromCharCode(10);
    CB.machineFindingsLayer(answer, F.ws, "ko", "core", "claude-codex", "ask-mfl-1", CAMP, F.repoKey);
    const rows = CL.readFindingsLedger(F.ws);
    const myRound = rows.find((r) => r.type === "round" && r.repoKey === F.repoKey);
    assert.ok(myRound && myRound.round === 1 && myRound.roundType === "discovery", "A 첫 판=discovery·round 1(B 통과 판 미참조) " + JSON.stringify(myRound));
    assert.ok(!rows.some((r) => r.type === "close" && r.findingId === "f-B"), "★B 지적 f-B는 A 판이 닫지 않는다");
    assert.ok(rows.filter((r) => r.repoKey === F.repoKey).every((r) => r.type !== "finding" || r.findingId !== "f-B"), "A 표식으로 기록된 행에 B 지적 없음");
    const stillOpenB = CL.openFindingsFromRows(rows.filter((r) => r.repoKey === "0000000000000000"), CAMP, CORE_HASH);
    assert.ok(stillOpenB.some((o) => o.id === "f-B"), "B 기준 판독에서 f-B는 여전히 열림");
  } finally { if (old === undefined) delete process.env.CODEX_BRIDGE_ASK_JOB_ID; else process.env.CODEX_BRIDGE_ASK_JOB_ID = old; }
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
