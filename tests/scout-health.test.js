/*
 * Scout Health(정찰 관찰 신호) — 정본(src/ledger-events.ts computeScoutHealth) 경계 + 배포 미니 사본
 * (bridge/contract-lib.js computeScoutHealthMini) 패리티 + 동봉 줄(scoutHealthLine) 계약.
 * 배경(사용자 결정 2026-07-09): 전역 임계값(60% 합격선류)은 프로젝트 구조별로 의미가 달라 고정 불가 —
 * 프로젝트별 장부 신호가 그 자리를 대신한다(advisory 전용 · 자동 강제 0 · '정확도' 용어 금지).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "scout-health-"));
process.env.CODEX_BRIDGE_HOME = tmpHome;
const LE = require(path.join(__dirname, "..", "out", "ledger-events.js"));
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const ev = (type, sig, extra) => JSON.stringify({ ts: "t", type, sig, ...(extra || {}) });

console.log("[정본 경계] entry 단위 집계 — 이벤트 반복이 한 항목을 과대 반영하지 못함");
const raw1 = [
  ev("proposed", "a", { text: "src/a.ts ↔ docs/A.md" }), ev("attached", "a"), ev("attached", "a"), ev("confirmed", "a"), ev("confirmed", "a"), ev("confirmed", "a"),
  ev("proposed", "b", { text: "b" }), ev("attached", "b"),
  ev("proposed", "c", { text: "c" }), ev("user_dispute", "c"),
  ev("proposed", "d", { text: "d" }), ev("refuted", "d"), ev("user_confirm", "d"), // 복권(사람 1회)
  ev("proposed", "e", { text: "e" }), ev("banned", "e"),
].join("\n");
const h1 = LE.computeScoutHealth(LE.deriveLedger(LE.parseEventsJsonl(raw1).events));
ok(h1.entries === 5, `항목 5(실제 ${h1.entries})`);
ok(h1.verified === 2 && h1.rehabilitated === 1, `신뢰 2(a·복권 d) — confirmed 3회 반복이 1항목으로만(실제 v=${h1.verified} r=${h1.rehabilitated})`);
ok(h1.reusedDen === 2 && h1.reusedNum === 1, `재사용 분모=attached 있는 항목 2(a·b), 분자=그중 확인 1(a) — 이벤트 수 비율 아님(실제 ${h1.reusedNum}/${h1.reusedDen})`);
ok(h1.disputedEntries === 2, `반박 이력 항목 2(c·d — 복권돼도 이력은 남음, 실제 ${h1.disputedEntries})`);

console.log("[패리티] 배포 미니 사본 = 정본 (같은 JSONL → 같은 수치 · 복권 규칙 동형)");
const raw2 = raw1 + "\n" + [ev("proposed", "f", { text: "f" }), ev("refuted", "f"), ev("confirmed", "f"), ev("confirmed", "f")].join("\n"); // 검증 2회 복권
for (const raw of [raw1, raw2, ""]) {
  const a = LE.computeScoutHealth(LE.deriveLedger(LE.parseEventsJsonl(raw).events));
  const b = CL.computeScoutHealthMini(raw);
  ok(JSON.stringify(a) === JSON.stringify(b), `패리티(${raw ? raw.split("\n").length + "줄" : "빈 장부"}): ${JSON.stringify(b)}`);
}
ok(CL.HEALTH_MIN_SAMPLE === LE.HEALTH_MIN_SAMPLE, "표본 게이트 상수 동일(정본·사본)");
const rawUnknown = raw1 + "\n" + JSON.stringify({ ts: "t", type: "future_type", sig: "z" }) + "\n" + JSON.stringify({ ts: "t", type: "??", sig: "y" });
ok(JSON.stringify(LE.computeScoutHealth(LE.deriveLedger(LE.parseEventsJsonl(rawUnknown).events))) === JSON.stringify(CL.computeScoutHealthMini(rawUnknown)), "미지 타입 패리티 — 사본도 allowlist로 버려 표본 수가 안 부풀음(Codex 반례 잠금)");

console.log("[동봉 줄] bounded·표본 게이트·용어 잠금('정확도' 금지)");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "scout-health-repo-"));
ok(CL.scoutHealthLine(repo, false) === null, "장부 없음 → 블록 생략(주입 비용 0)");
fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(repo)), { recursive: true });
for (const ln of raw1.split("\n").slice(0, 4)) fs.appendFileSync(CL.ledgerEventsFileFor(repo), ln + "\n"); // 항목 1개(a)뿐
const small = CL.scoutHealthLine(repo, false);
ok(!!small && /아직 작음/.test(small) && /후보로만/.test(small) && !/\d+\/\d+/.test(small), "표본 부족(항목<5) → 비율 없는 1줄(과신 방지)");
fs.writeFileSync(CL.ledgerEventsFileFor(repo), raw2 + "\n");
const full = CL.scoutHealthLine(repo, false);
ok(!!full && /확인 항목 3\/6/.test(full) && /반박 3건\(수동 기록 기준\)/.test(full) && /복권 2건/.test(full), `표본 충분 → 항목 수치(라벨='확인 항목' — 신뢰/pinned lane과 혼동 금지, 실제: ${(full || "").slice(0, 60)}…)`);
ok(!/재사용 항목 중 확인 이력 \d/.test(full), "재사용 분모<5면 그 비율은 숨김(지표별 게이트 — Codex 보완)");
for (const f of ["bridge/contract-lib.js", "src/ledger-events.ts", "src/extension.ts", "docs/HANDOFF.md"]) {
  const s = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  ok(!/재사용 후 확인/.test(s) && !/confirmed after reuse/.test(s), f + " — 순서 주장 문구 잔재 0(코드가 증명 못 하는 인과 '후' 금지 — 문서 포함, Codex 반례 잠금)");
}
ok(/보수적/.test(full) && /안전 보장이 아니다/.test(full) && /독립 확인/.test(full), "상시 한계 문구(보수 집계·후보일 뿐·독립 확인 유지)");
ok(!/정확도/.test(full) && !(/accuracy/.test(CL.scoutHealthLine(repo, true) || "")), "'정확도/accuracy' 용어 금지(관찰 신호로만)");
const en = CL.scoutHealthLine(repo, true);
ok(!!en && /Scout observation signal/.test(en) && /manually recorded/.test(en), "영문 동등 품질");

console.log("[attach 배선] 지도 동봉 꼬리에 신호 줄 — 실패해도 지도 동봉 불침(소스 계약)");
const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
ok(/scoutHealthLine\(target, en\)/.test(src) && /health \? \[health\] : \[\]/.test(src), "buildScoutAttach가 target(정찰 대상) 기준으로 신호 줄 첨부");
ok(/신호 실패가 지도 동봉을 막지 않음/.test(src), "실패 격리 주석·catch");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/health: computeScoutHealth\(derived\)/.test(ext) && /관찰 신호\(이 프로젝트\)/.test(ext) && /표본 아직 작음/.test(ext), "대시보드 관찰 일지 카드에 신호 1줄(표본 게이트 포함)");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
