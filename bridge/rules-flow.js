"use strict";
// [HARNESS-STRUCTURE-2026-09-11 §B3 · 사용자 결정 D4(개요 패널)] 수칙 흐름 4칸 — 항상 보이는 자료.
//   core      : 항상 적용되는 수칙(코어) 몇 항 · 실제로 주입되는 글자 수(비용 근거=실물 길이)
//   archive   : 관련될 때만 적용되는 수칙(서고) 몇 항/상한 · 선별 상한(항수·바이트) · 마지막 선별 영수증(시각·항수·askId)
//   proposals : 제안함 미승인 몇 건/상한 · 다음 검사 조건(훅 K회마다·지금 n회·N일 미사용 관측·마지막 검사 시각)
//   curator   : 정리 담당 마지막 실행(시각·결과·사유·트리거·제안 목록)
// 계산은 순수 함수(rulesFlow) — 판독기 결과를 인자로 받아 시험 가능. rulesFlowFor(ws) 가 브릿지 장부에서 재료를 모은다.
// 영수증 채택 규칙(ab-1·CURATION P6 동형): purpose!=="preview" 이고 wsKey 와 repoKey(현재 정찰 저장소) 가 '모두' 일치하는 마지막 행만.
const path = require("path");
function CL() { return require(path.join(__dirname, "contract-lib.js")); }
function CU() { return require(path.join(__dirname, "curation.js")); }

const AXES = ["supportedEnv", "alwaysBlocker", "outOfScope"];

// 코어: 항수(축별·합계)·주입 글자 수(injection=envelopeInjectionFor 결과 — text 없으면 0·st 로 사유)
function coreFlow(envelope, injection) {
  const st = envelope && envelope.st ? envelope.st : "absent";
  const count = { supportedEnv: 0, alwaysBlocker: 0, outOfScope: 0, total: 0 };
  if (st === "ok" && envelope.data) for (const ax of AXES) { count[ax] = Array.isArray(envelope.data[ax]) ? envelope.data[ax].length : 0; count.total += count[ax]; }
  const text = injection && typeof injection.text === "string" ? injection.text : null;
  return { st: injection && injection.st ? injection.st : st, count, injectedChars: text ? text.length : 0 };
}
// 마지막 선별 영수증 — wsKey·repoKey 둘 다 일치(둘 중 하나라도 없거나 다르면 제외 — 타 프로젝트·타 저장소 실적 오귀속 금지).
// 영수증 서랍은 종류가 섞여 있다: 검증 선별(ask-job-worker: purpose 없음·askId 있음) · 미리보기(purpose:"preview") · 정리 담당(purpose:"curate"·askId 빈 값·
// selectedIds=후보 id). '검증에 실린 수칙'은 검증 선별 행만이다 — 구조 표식(purpose 없음 && askId 있음)으로 고른다(curation.js 137 의 미사용 판정과 같은 규칙 ·
// 구현 검증 1판 blocker: preview 만 빼면 정리 영수증의 후보 개수가 '실린 수칙 항수'로 오표시된다).
function isVerifySelectionRow(x) { return !!(x && !x.purpose && String(x.askId || "") && Array.isArray(x.selectedIds)); }
function lastSelectionOf(rows, wsKey, repoKey) {
  const w = String(wsKey || ""), r = String(repoKey || "");
  if (!w || !r) return null;
  for (let i = (rows || []).length - 1; i >= 0; i--) {
    const x = rows[i];
    if (!isVerifySelectionRow(x)) continue;
    if (String(x.wsKey || "") !== w || String(x.repoKey || "") !== r) continue;
    return { ts: String(x.ts || ""), selectedCount: x.selectedIds.length, askId: String(x.askId || "") };
  }
  return null;
}
function archiveFlow(a) {
  const ar = a.archive || { st: "absent" };
  const max = Number(a.archiveMax) || 96;
  let state = "unknown", count = 0;
  if (!a.archiveHash) state = ar.st === "absent" ? "none" : "stray";
  else if (ar.st !== "ok" || ar.sha1 !== a.archiveHash) state = "broken";
  else { state = "active"; count = Array.isArray(ar.data && ar.data.alwaysBlocker) ? ar.data.alwaysBlocker.length : 0; }
  return { state, count, max, selectCap: { items: Number(a.selectCap && a.selectCap.items) || 0, bytes: Number(a.selectCap && a.selectCap.bytes) || 0 }, lastSelection: lastSelectionOf(a.usage, a.wsKey, a.repoKey) };
}
function proposalsFlow(cu, tick, consts) {
  const c = consts || {};
  return {
    pending: cu ? Number(cu.pending) || 0 : 0,
    max: Number(c.maxPending) || (cu ? Number(cu.maxPending) || 0 : 0),
    nextCheck: { tickK: Number(c.tickK) || 0, tickCount: tick ? Number(tick.k) || 0 : (cu ? Number(cu.campaignsSince) || 0 : 0), unusedDays: Number(c.unusedDays) || 0, lastTickTs: tick ? String(tick.judgedAt || tick.ranAt || "") : "" },
  };
}
function curatorFlow(cu) {
  const metrics = { adoptRate: cu ? Number(cu.adoptRate) || 0 : 0, proposedTotal: cu ? Number(cu.proposedTotal) || 0 : 0, adopted: cu ? Number(cu.adopted) || 0 : 0, declined: cu ? Number(cu.declined) || 0 : 0, archiveSize: cu ? Number(cu.archiveSize) || 0 : 0, selOverCount: cu ? Number(cu.selOverCount) || 0 : 0, unusedCount: cu ? Number(cu.unusedCount) || 0 : 0 }; // CURATION v3 §3 F 4지표(채택률·서고 크기·선별 초과·미사용) 유지
  if (!cu) return { lastTs: "", lastOutcome: "", lastReason: "", lastTrigger: "", running: false, lastItems: [], metrics };
  return { lastTs: String(cu.lastTs || ""), lastOutcome: String(cu.lastOutcome || ""), lastReason: String(cu.lastReason || ""), lastTrigger: String(cu.lastTrigger || ""), running: cu.running === true, metrics, lastItems: Array.isArray(cu.lastItems) ? cu.lastItems.map((it) => ({ id: String(it.id || ""), title: String(it.title || ""), op: String(it.op || ""), status: String(it.status || "") })) : [] };
}
// 순수: inp={ envelope, injection, archive, archiveHash, archiveMax, selectCap, usage, wsKey, repoKey, curation, tick, consts }
function rulesFlow(inp) {
  const i = inp || {};
  return { core: coreFlow(i.envelope, i.injection), archive: archiveFlow(i), proposals: proposalsFlow(i.curation, i.tick, i.consts), curator: curatorFlow(i.curation) };
}
// 브릿지 장부에서 재료 수집(판독 실패=그 칸만 비움·전체를 막지 않음)
function rulesFlowFor(ws, opts) {
  const cl = CL(); const cu = CU();
  const o = opts || {};
  let c = null; try { c = cl.loadContract(ws, o.lang); } catch { c = null; }
  let repo = ws; try { repo = cl.resolveScoutRepo(ws, c || {}).repo || ws; } catch { repo = ws; }
  let envelope = { st: "absent" }; try { envelope = cl.readVerifyEnvelope(repo); } catch { envelope = { st: "corrupt" }; }
  let injection = null; try { injection = cl.envelopeInjectionFor(repo, c ? c.envelopeHash : null, o.lang); } catch { injection = null; }
  let archive = { st: "absent" }; try { archive = cl.readVerifyEnvelopeArchive(repo); } catch { archive = { st: "corrupt" }; }
  let usage = []; try { usage = cl.readSelectorUsage() || []; } catch { usage = []; }
  let curation = null; try { curation = cu.curationSummary(ws); } catch { curation = null; }
  let repoKey = ""; try { repoKey = cl.repoKeyOf(repo); } catch { repoKey = ""; }
  let tick = null; try { tick = repoKey ? cu.readTickState(ws, repoKey) : null; } catch { tick = null; }
  return rulesFlow({
    envelope, injection, archive, archiveHash: c && typeof c.archiveHash === "string" ? c.archiveHash : null, archiveMax: cl.ARCHIVE_ITEM_MAX,
    selectCap: { items: cl.SELECTOR_UNION_MAX, bytes: cl.SELECTOR_UNION_BYTES_MAX }, usage, wsKey: cl.wsKeyFor(ws), repoKey, curation, tick,
    consts: { tickK: cu.CURATION_TICK_K, maxPending: cu.CURATION_MAX_PENDING, unusedDays: cu.CURATION_UNUSED_DAYS },
  });
}
module.exports = { AXES, coreFlow, isVerifySelectionRow, lastSelectionOf, archiveFlow, proposalsFlow, curatorFlow, rulesFlow, rulesFlowFor };
