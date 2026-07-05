// 두뇌 drift → integrity reconcile 규칙 검증(멱등·해소·변경·ack 유지) + 모델 계열.
// ⚠ extension.ts(vscode 의존)의 syncBrainDrift/modelFamily 규칙을 동일 사양으로 검증(실함수는 Codex 코드검증+런타임).
const assert = require("assert");
const KIND = "brain-drift";

function modelFamily(m) { m = (m || "").toLowerCase(); if (m.includes("haiku")) return "haiku"; if (m.includes("sonnet")) return "sonnet"; if (m.includes("opus")) return "opus"; if (m.includes("fable")) return "fable"; return ""; }

let idn = 1000;
function reconcile(events, ws, drifts) {
  const wsMatch = (e) => !e.workspace || e.workspace === ws;
  const curSigs = new Set(drifts.map((d) => d.sig));
  const kept = events.filter((e) => e.kind !== KIND || !wsMatch(e) || curSigs.has(e.sig));
  const present = new Set(kept.filter((e) => e.kind === KIND && wsMatch(e)).map((e) => e.sig));
  for (const d of drifts) { if (present.has(d.sig)) continue; kept.push({ id: "n" + (idn++), ack: false, kind: KIND, workspace: ws, severity: "warning", detail: d.detail, sig: d.sig }); }
  return kept;
}
const bd = (sig, ack) => ({ id: "x" + sig, ack: !!ack, kind: KIND, workspace: "W", severity: "warning", detail: "d", sig });
const cnt = (evs) => evs.filter((e) => e.kind === KIND).length;

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 계열
ok(modelFamily("opus") === "opus" && modelFamily("claude-opus-4-8") === "opus", "계열: opus=claude-opus-4-8");
ok(modelFamily("haiku") === "haiku" && modelFamily("claude-haiku-4-5-20251001") === "haiku", "계열: haiku");
ok(modelFamily("") === "" && modelFamily("opusplan") === "opus", "계열: 빈값/opusplan");

// 1. 새 drift → 추가(unacked)
let r = reconcile([], "W", [{ sig: "A", detail: "a" }]);
ok(cnt(r) === 1 && r[0].sig === "A" && !r[0].ack, "새 drift 추가(unacked)");

// 2. 같은 drift(acked) → 재발행 안 함(확인 유지)
r = reconcile([bd("A", true)], "W", [{ sig: "A", detail: "a" }]);
ok(cnt(r) === 1 && r[0].ack === true, "같은 drift(acked) → 1개 유지·확인 보존(재발행 X)");

// 3. 같은 drift(unacked) → 중복 안 됨
r = reconcile([bd("A", false)], "W", [{ sig: "A", detail: "a" }]);
ok(cnt(r) === 1, "같은 drift(unacked) → 중복 추가 안 함");

// 4. drift 해소(sig 사라짐) → 제거(acked/unacked 모두 정리)
ok(cnt(reconcile([bd("A", false)], "W", [])) === 0, "해소 → unacked 제거");
ok(cnt(reconcile([bd("A", true)], "W", [])) === 0, "해소 → acked도 정리");

// 5. drift 변경(새 sig) → 옛것 제거 + 새것 추가
r = reconcile([bd("A", false)], "W", [{ sig: "B", detail: "b" }]);
ok(cnt(r) === 1 && r.some((e) => e.sig === "B") && !r.some((e) => e.sig === "A"), "변경 → A 제거·B 추가");

// 6. 타 워크스페이스 brain-drift 보존
r = reconcile([{ id: "o", ack: false, kind: KIND, workspace: "OTHER", severity: "warning", detail: "d", sig: "Z" }], "W", [{ sig: "A", detail: "a" }]);
ok(r.some((e) => e.sig === "Z") && r.some((e) => e.sig === "A"), "타 ws brain-drift 보존 + 이 ws 추가");

// 7. 비-brain-drift(검증 무결성) 이벤트 보존
r = reconcile([{ id: "v", ack: false, kind: "verdict-nonclean", workspace: "W", severity: "warning", detail: "v" }], "W", []);
ok(r.some((e) => e.kind === "verdict-nonclean"), "검증 무결성 이벤트는 안 건드림");

// 8. cc(Claude)=계열 비교 / cx(Codex)=정규화 raw 비교 — Codex 모델은 modelFamily가 ""라 family로 비교하면 영영 안 잡힌다.
const norm = (s) => (s || "").trim().toLowerCase();
const ccModelDrift = (set, tr) => { const a = modelFamily(set), b = modelFamily(tr); return !!(a && b && a !== b); };
const cxModelDrift = (pref, roll) => { const a = norm(pref), b = norm(roll); return !!(a && b && a !== b); };
ok(ccModelDrift("opus[1m]", "claude-opus-4-8") === false, "cc: 별칭 opus ↔ full claude-opus-4-8 = 같은 계열(드리프트 아님)");
ok(ccModelDrift("haiku", "claude-opus-4-8") === true, "cc: haiku ↔ opus = 계열 다름(드리프트)");
ok(ccModelDrift("", "claude-opus-4-8") === false, "cc: 빈 설정은 스킵(오탐 방지)");
ok(modelFamily("gpt-5.5-codex") === "" && cxModelDrift("gpt-5.5-codex", "gpt-5.1") === true, "cx: gpt-*는 family가 ''라 raw로만 잡힌다(gpt-5.5-codex≠gpt-5.1=드리프트)");
ok(cxModelDrift("GPT-5.5 ", "gpt-5.5") === false, "cx: 대소문자/공백 정규화 후 같으면 드리프트 아님");
ok(cxModelDrift("", "gpt-5.1") === false, "cx: pref 미설정은 스킵");

// ── 워크스페이스 격리(cwd 필터): 공유 세션/전역 기록에서 '이 폴더(cwd)의 답'만 보고 비교 → 거짓 두뇌-drift 차단 ──
// 경로 비교는 실제 normWs와 동일 규칙(path.normalize+trailing제거+lowercase+NFC) — 모델용 norm(trim+lowercase)과 구분.
const path = require("path");
const normPath = (p) => path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
// sessionModelMeta(file, ws) 미러: turn_context 순회, cwd==ws인 것만 현재 model/effort에 반영, models는 전부(knownModels).
function lastCtxForWs(entries, ws) {
  const want = normPath(ws); const models = new Set(); let model = "", effort = "";
  for (const e of entries) {
    if (e.model) models.add(e.model);
    if (want && normPath(e.cwd) !== want) continue;
    if (e.model) model = e.model;
    if (e.effort) effort = e.effort;
  }
  return { model, effort, models: [...models] };
}
const cxEffortDrift = (pref, last) => !!(pref && last && pref !== last);

// 사용자 실제 버그 재현: 한 코덱스 세션을 A(xhigh)·B(설정없음→high)가 공유, 마지막 turn이 B(high)에서 옴.
const shared = [
  { cwd: "D:\\A", model: "gpt-5.5", effort: "xhigh" },
  { cwd: "D:\\A", model: "gpt-5.5", effort: "xhigh" },
  { cwd: "D:\\B", model: "gpt-5.5", effort: "high" },  // 형제 폴더(예: 검증 ask)가 만든 high
];
ok(lastCtxForWs(shared, "D:\\A").effort === "xhigh", "cwd필터: A의 최근 effort=xhigh (B의 high가 안 샘)");
ok(lastCtxForWs(shared, "D:\\B").effort === "high", "cwd필터: B의 최근 effort=high");
ok(cxEffortDrift("xhigh", lastCtxForWs(shared, "D:\\A").effort) === false, "★버그수정: A는 pref=xhigh·실제=xhigh → 드리프트 없음(세션 전역 마지막 high와 비교 안 함)");
ok(cxEffortDrift("xhigh", lastCtxForWs(shared, "D:\\C").effort) === false, "cwd필터: C는 이 세션 turn 0개 → effort='' → 가드(&& mEffort)로 경고 억제");
ok(lastCtxForWs(shared, "D:\\B").models.join() === "gpt-5.5", "models(knownModels)는 cwd 필터와 무관하게 세션 전체 수집");
ok(lastCtxForWs(shared, "D:\\a").effort === "xhigh", "cwd필터: 대소문자 달라도 normWs로 같은 폴더 매칭(toLowerCase, 전 OS)");
// 슬래시(/)↔백슬래시(\) 통일은 path.normalize의 Windows 전용 동작 → Windows에서만 검증(리눅스 cwd는 '/'만 쓰므로 무관). 이 분리로 리눅스 CI 실패 해소.
if (path.sep === "\\") ok(lastCtxForWs(shared, "d:/a").effort === "xhigh", "cwd필터(Win): 슬래시 달라도 normWs로 같은 폴더 매칭");

// cc-model 미러: lastModelInFile(f, ws) — cwd==ws인 entry의 모델만, "<synthetic>" 스킵.
function lastModelForWs(entries, ws) {
  const want = normPath(ws); let m = "";
  for (const e of entries) {
    if (want && normPath((e && e.cwd) || "") !== want) continue; // strict: cwd 없거나 불일치 배제(sessionModelMeta와 동일)
    if (e.model && e.model !== "<synthetic>") m = e.model;
  }
  return m;
}
const ccTrans = [
  { cwd: "D:\\A", model: "claude-opus-4-8" },
  { cwd: "D:\\B", model: "claude-sonnet-4-6" }, // 다른 프로젝트의 최근 답
  { cwd: "D:\\A", model: "<synthetic>" },         // 합성 메시지(스킵 대상)
  { model: "claude-haiku-4-5" },                  // cwd 없음 — strict 필터 시 배제 대상(타 프로젝트 누수 방지)
];
ok(lastModelForWs(ccTrans, "D:\\A") === "claude-opus-4-8", "cc cwd필터(strict): A의 최근 실모델=opus (<synthetic>·cwd없는 haiku·B의 sonnet 모두 안 샘)");
ok(lastModelForWs(ccTrans, null) === "claude-haiku-4-5", "cc 필터 없으면(무회귀): 마지막 실모델=haiku(cwd-less도 포함)");
ok(ccModelDrift("opus[1m]", lastModelForWs(ccTrans, "D:\\A")) === false, "★cc 교차프로젝트 거짓경고 차단: A서 설정 opus·실제 opus → 드리프트 없음");
ok(ccModelDrift("opus[1m]", lastModelForWs(ccTrans, "D:\\B")) === true, "cc: B 기준이면 실제 sonnet → 계열 다름 — 폴더별로 정확히 분리됨");

// ── 신선도(age) 가드: 옛 모델/세션이 '최근값'으로 잡혀 거짓 drift 내는 것 차단(cc·cx 대칭) ──
// 실제 사용자 버그: 같은 프로젝트에 ~19일 전 fable 답이 남아 있어, cwd 필터만으로는 그 옛 fable이 '최근 답'으로 잡혀
//   설정 opus와 'opus vs fable' 거짓 경고를 냈다. 신선도 가드는 옛 답/옛 연결세션을 stale로 제외한다.
// 창 = 7일(v0.1.80, 사용자 결정): 병행 개발에선 3일+ 텀이 일상이라 24h는 하루만 쉬어도 즉시 경고를 전멸시키는 과잉 억제.
//   19일급 옛 기록(원래 차단 대상)은 7일 창에서도 여전히 제외 — 아래 케이스가 양쪽 경계를 잠근다.
const DRIFT_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
// lastModelInFile(f, ws, maxAgeMs) 미러: 마지막 모델 entry의 timestamp가 창 밖이면 stale("") — ts 없으면 인정(과잉억제 회피).
function lastModelFresh(entries, ws, now, maxAgeMs) {
  const want = normPath(ws);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (want && normPath((e && e.cwd) || "") !== want) continue;
    const m = e && e.model;
    if (m && m !== "<synthetic>") {
      if (maxAgeMs) { const ts = Date.parse((e && e.timestamp) || ""); if (Number.isFinite(ts) && now - ts > maxAgeMs) return ""; }
      return m;
    }
  }
  return "";
}
const NOW = Date.parse("2026-06-30T00:00:00Z");
const oldTs = "2026-06-11T00:00:00Z";   // ~19일 전(창 밖)
const freshTs = "2026-06-29T18:00:00Z"; // 최근(창 안)
ok(lastModelFresh([{ cwd: "D:\\A", model: "claude-fable-5", timestamp: oldTs }], "D:\\A", NOW, DRIFT_FRESH_MS) === "", "신선도: 19일 전 fable 마지막답 → stale 제외(거짓 fable 경고 차단 — 7일 창에서도 여전히 차단)");
ok(lastModelFresh([{ cwd: "D:\\A", model: "claude-opus-4-8", timestamp: freshTs }], "D:\\A", NOW, DRIFT_FRESH_MS) === "claude-opus-4-8", "신선도: 최근 opus 답 → 정상 반영");
const d3Ts = new Date(NOW - 3 * 864e5).toISOString(); // 3일 전 — 병행 개발 실사용 케이스(사용자: 3일+ 텀 일상)
const d8Ts = new Date(NOW - 8 * 864e5).toISOString(); // 8일 전 — 창 밖
ok(lastModelFresh([{ cwd: "D:\\A", model: "claude-fable-5", timestamp: d3Ts }], "D:\\A", NOW, DRIFT_FRESH_MS) === "claude-fable-5", "신선도(7일 창): 3일 전 답도 비교 대상(24h였다면 하루만 쉬어도 경고 전멸 — 과잉 억제 해소)");
ok(lastModelFresh([{ cwd: "D:\\A", model: "claude-fable-5", timestamp: d8Ts }], "D:\\A", NOW, DRIFT_FRESH_MS) === "", "신선도(7일 창): 8일 전 답은 stale 제외(경계)");
ok(lastModelFresh([{ cwd: "D:\\A", model: "claude-fable-5" }], "D:\\A", NOW, DRIFT_FRESH_MS) === "claude-fable-5", "신선도: timestamp 없으면 검사 불가 → 인정(과잉 억제 회피)");
ok(lastModelFresh([{ cwd: "D:\\A", model: "claude-fable-5", timestamp: oldTs }], "D:\\A", NOW, 0) === "claude-fable-5", "신선도: maxAgeMs 미지정(1순위 경로)이면 옛 답도 인정");

// currentTranscriptForWs(구 readClaudeModels) 1순위 미러: active가 신선+이 ws의 세션이면 '현재 대화'를 옛 기록보다 우선.
// (v0.1.77: intent/actual을 같은 대화에서 읽도록 재구성 — 이 선택 규칙 자체는 동일 사양 유지. intent 해석은 brain-intent.test.js가 정본 import로 검증.)
function ccPrimary(active, now, curModel, wsFilter) {
  const ats = Date.parse((active && active.ts) || "");
  const afresh = Number.isFinite(ats) && now - ats < DRIFT_FRESH_MS;
  const wsMatch = !wsFilter || normPath((active && active.workspace) || "") === normPath(wsFilter);
  if (active && active.claudeSession && afresh && wsMatch) return curModel; // 현재 대화 transcript 모델
  return null; // → 폴백(ws 최근 + 신선도)
}
ok(ccPrimary({ claudeSession: "S", ts: freshTs, workspace: "D:\\A" }, NOW, "claude-opus-4-8", "D:\\A") === "claude-opus-4-8", "cc 1순위: 신선한 active+ws일치 → 현재 대화(opus) 우선(옛 fable 무시)");
ok(ccPrimary({ claudeSession: "S", ts: oldTs, workspace: "D:\\A" }, NOW, "claude-opus-4-8", "D:\\A") === null, "cc 1순위: stale active → 폴백(옛 active로 옛 대화 안 읽음)");
ok(ccPrimary({ ts: freshTs, workspace: "D:\\A" }, NOW, "x", "D:\\A") === null, "cc 1순위: 세션id 없으면 폴백");
ok(ccPrimary({ claudeSession: "S", ts: freshTs, workspace: "D:\\B" }, NOW, "x", "D:\\A") === null, "cc 1순위: active가 다른 ws면 폴백(교차-프로젝트 누수 방지)");

// cx 신선도 게이트 미러: 연결 rollout '이 폴더 마지막 turn 시각'(sm.ts, 파일 mtime 아님)이 창 밖이면 비교 안 함(mModel/mEffort="").
function cxFreshGate(lastTurnTs, now) { const t = Date.parse(lastTurnTs || ""); return Number.isFinite(t) && now - t < DRIFT_FRESH_MS; }
ok(cxFreshGate(freshTs, NOW) === true, "cx 신선도: 최근 turn의 연결세션 → 비교함");
ok(cxFreshGate(oldTs, NOW) === false, "cx 신선도: 오래된 turn의 연결세션 → 비교 안 함(옛 effort 거짓 drift 차단)");
ok(cxFreshGate("", NOW) === false, "cx 신선도: 이 폴더 turn 기록 없음(sm.ts='') → 비교 안 함(데이터 없으면 경고 안 함)");
ok(cxEffortDrift("xhigh", cxFreshGate(oldTs, NOW) ? "high" : "") === false, "cx: stale 세션이면 mEffort='' → 가드로 경고 억제(설정 xhigh여도)");
ok(cxModelDrift("gpt-5.5", cxFreshGate(oldTs, NOW) ? "gpt-5.1" : "") === false, "cx: stale 세션이면 mModel='' → 모델 가드로도 억제");

console.log("brain-drift: " + n + " assertions passed");
