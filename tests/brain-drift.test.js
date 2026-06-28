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

console.log("brain-drift: " + n + " assertions passed");
