"use strict";
/*
 * 로드맵 ④ 테스트 — 검증 답변 기반 confirmed 자동 적재(flagLedgerConfirms, 보수 규칙)와
 * 발화 기록 CLI(scope-ledger-note), 경로 추출 패리티. CODEX_BRIDGE_HOME 임시폴더.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls_"));
process.env.CODEX_BRIDGE_HOME = dir;

const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const CB = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
const LE = require(path.join(__dirname, "..", "out", "ledger-events.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[0] 경로 추출 패리티 — contract-lib.ledgerPathsFromText ≡ out/ledger-events.extractPathsFromText");
for (const s of ["`src/alpha-channel.ts` ↔ lib/beta-consumer.ts — 채널", "0.1.86 (high)", "a/b.ts와 c\\d.js를"]) {
  ok(JSON.stringify(CL.ledgerPathsFromText(s)) === JSON.stringify(LE.extractPathsFromText(s)), `"${s.slice(0, 24)}…" 동일 추출`);
}

// 픽스처: 실제 파일이 있는 작업 폴더(인용 해석이 실존 파일을 요구) + 장부에 결합 항목 1건
const ws = path.join(dir, "proj");
fs.mkdirSync(path.join(ws, "src"), { recursive: true });
fs.mkdirSync(path.join(ws, "lib"), { recursive: true });
fs.writeFileSync(path.join(ws, "src", "alpha-channel.ts"), "l1\nl2\nl3\nl4\n");
fs.writeFileSync(path.join(ws, "lib", "beta-consumer.ts"), "l1\nl2\nl3\nl4\nl5\n");
const TEXT = "src/alpha-channel.ts ↔ lib/beta-consumer.ts — 한쪽이 쓰고 다른쪽이 읽는 채널";
const sig = CL.ledgerSig(TEXT);
CL.appendLedgerEvent(ws, { ts: "2026-07-07T00:00:00.000Z", type: "proposed", sig, text: TEXT, from: "self 지도 T" });

const eventsNow = () => LE.parseEventsJsonl(CL.readLedgerEventsText(ws)).events;
const countType = (t) => eventsNow().filter((e) => e.type === t).length;

console.log("[1] confirmed 적재 — 통과 판정 + 두 경로 실존 인용일 때만");
const PASS_ANSWER = "검토 완료 — 근거: (src/alpha-channel.ts:2) 그리고 (lib/beta-consumer.ts:3)\n검증: 통과";
CB.flagLedgerConfirms(PASS_ANSWER, ws, "", ws);
ok(countType("confirmed") === 1, "두 경로 실존 인용 + 통과 → confirmed 1건");
const derived = LE.deriveLedger(eventsNow()).find((e) => e.sig === sig);
ok(derived.status === "verified" && derived.lane === "trusted", "유도 결과: 검증됨(신뢰 차선) 승격");

console.log("[2] 보수 규칙 — 다음 경우엔 적재 안 됨");
CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:2) (lib/beta-consumer.ts:3)\n검증: 실패", ws, "", ws);
ok(countType("confirmed") === 1, "실패 판정 → 추가 없음");
CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:2)뿐\n검증: 통과", ws, "", ws);
ok(countType("confirmed") === 1, "경로 1개만 인용 → 추가 없음(결합의 양쪽 요구)");
CB.flagLedgerConfirms("본문에 src/alpha-channel.ts 와 lib/beta-consumer.ts 를 언급만(인용 형식·라인 없음)\n검증: 통과", ws, "", ws);
ok(countType("confirmed") === 1, "텍스트 메아리(라인 인용 없음) → 추가 없음(자기강화 차단)");
CB.flagLedgerConfirms("(src/alpha-channel.ts:999) (lib/beta-consumer.ts:3)\n검증: 통과", ws, "", ws);
ok(countType("confirmed") === 1, "라인 초과 인용이 낀 파일은 확인 근거에서 제외 — 파일만 실재하는 헛인용 차단(보수 강화)");
// 짧은 basename(8자 미만)은 우연 일치 위험 → 제외
fs.writeFileSync(path.join(ws, "a.ts"), "x\n");
fs.writeFileSync(path.join(ws, "b.ts"), "x\n");
const SHORT = "a.ts ↔ b.ts — 짧은 이름";
CL.appendLedgerEvent(ws, { ts: "2026-07-07T00:01:00.000Z", type: "proposed", sig: CL.ledgerSig(SHORT), text: SHORT, from: "self 지도 T" });
CB.flagLedgerConfirms("(a.ts:1) (b.ts:1)\n검증: 통과", ws, "", ws);
ok(!eventsNow().some((e) => e.type === "confirmed" && e.sig === CL.ledgerSig(SHORT)), "8자 미만 basename만의 결합 → 확인 제외(index.ts류 오탐 방지)");

console.log("[3] 반박/차단 이력 있는 항목은 확인 대상에서 제외(보수적)");
CL.appendLedgerEvent(ws, { ts: "2026-07-07T00:02:00.000Z", type: "user_dispute", sig, text: TEXT, from: "사용자 발화: 그 결합 아님" });
CB.flagLedgerConfirms(PASS_ANSWER, ws, "", ws);
ok(countType("confirmed") === 1, "반박된 항목 → confirmed 추가 없음(누계 1 유지)");

console.log("[4] 발화 기록 CLI — 유일 매칭만 기록·모호/무일치 중단·신분 즉시 보고");
const CLI = path.join(__dirname, "..", "scripts", "scope-ledger-note.js");
const run = (...args) => spawnSync(process.execPath, [CLI, ws, ...args], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
const l = run("list");
ok(l.status === 0 && l.stdout.includes("alpha-channel"), "list — 장부 항목 표시");
const amb = run("confirm", ".ts");
ok(amb.status === 1 && /좁혀라/.test(amb.stderr), "모호한 조각(2건 일치) → 중단+후보 표시");
const none = run("confirm", "존재하지-않는-조각");
ok(none.status === 1 && /일치 항목 없음/.test(none.stderr), "무일치 → 중단+현재 장부 표시");
const conf = run("confirm", "beta-consumer", "--why", "사용자가 '그 결합 확실하다'고 확정 발화");
ok(conf.status === 0 && /기록됨: user_confirm/.test(conf.stdout), "유일 매칭 → user_confirm 기록");
ok(/현재 신분: disputed/.test(conf.stdout), "신분 즉시 보고(반박 이력이 있어 disputed 유지 — 확인 1회로 안 뒤집힘·정직)");
const pin = run("pin", "beta-consumer", "--why", "사용자 지시로 고정");
ok(pin.status === 0 && /신뢰|trusted/.test(pin.stdout), "pin → 차선 trusted(사람 오버라이드)");
const badCmd = run("erase", "x");
ok(badCmd.status === 2, "미지 명령 거부");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
