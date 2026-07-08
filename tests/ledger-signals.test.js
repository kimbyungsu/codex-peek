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

console.log("[3] 반박 이력 항목에도 확인은 '기록'된다(복권 재료 — 2026-07-09) · 차단(ban)만 기록 제외");
CL.appendLedgerEvent(ws, { ts: "2026-07-07T00:02:00.000Z", type: "user_dispute", sig, text: TEXT, from: "사용자 발화: 그 결합 아님" });
CB.flagLedgerConfirms(PASS_ANSWER, ws, "", ws);
ok(countType("confirmed") === 2, "반박된 항목에도 confirmed 기록(누계 2 — 문전 폐기 폐지, 승격은 유도기 복권 규칙이 판정)");
const midEntry = LE.deriveLedger(LE.parseEventsJsonl(CL.readLedgerEventsText(ws)).events).find((x) => x.sig === sig);
ok(midEntry && midEntry.status === "disputed", "검증 확인 1회로는 아직 disputed(복권은 기계 확인 2회부터 — 보수성 유지)");
// ban 항목 텍스트는 PASS_ANSWER가 실제 인용하는 경로와 일치시켜 'dead가 아니면 확인됐을' 상황을 만든다(무효 단언 방지 — Codex 반례)
CL.appendLedgerEvent(ws, { ts: "2026-07-07T00:03:00.000Z", type: "banned", sig: "ban-sig", text: "src/alpha-channel.ts ↔ lib/beta-consumer.ts (차단 대상)" });
CB.flagLedgerConfirms(PASS_ANSWER, ws, "", ws);
ok(!eventsNow().some((e) => e.type === "confirmed" && e.sig === "ban-sig"), "차단 중(사람 오버라이드) 항목은 기록 제외 — 인용이 일치해도");
CL.appendLedgerEvent(ws, { ts: "2026-07-07T00:04:00.000Z", type: "unbanned", sig: "ban-sig" });
CB.flagLedgerConfirms(PASS_ANSWER, ws, "", ws);
ok(eventsNow().some((e) => e.type === "confirmed" && e.sig === "ban-sig"), "차단 해제(unban) 후엔 확인 기록 재개 — 순계산(차단 해제된 지식도 진화)");

console.log("[4] 발화 기록 CLI — 유일 매칭만 기록·모호/무일치 중단·신분 즉시 보고");
const CLI = path.join(__dirname, "..", "scripts", "scope-ledger-note.js");
const run = (...args) => spawnSync(process.execPath, [CLI, ws, ...args], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
const l = run("list");
ok(l.status === 0 && l.stdout.includes("alpha-channel"), "list — 장부 항목 표시");
const amb = run("confirm", ".ts");
ok(amb.status === 1 && /좁혀라/.test(amb.stderr), "모호한 조각(2건 일치) → 중단+후보 표시");
const none = run("confirm", "존재하지-않는-조각");
ok(none.status === 1 && /일치 항목 없음/.test(none.stderr), "무일치 → 중단+현재 장부 표시");
const conf = run("confirm", "읽는 채널", "--why", "사용자가 '그 결합 확실하다'고 확정 발화");
ok(conf.status === 0 && /기록됨: user_confirm/.test(conf.stdout), "유일 매칭 → user_confirm 기록");
ok(/현재 신분: verified/.test(conf.stdout), "사용자 재확인 → 즉시 복권(verified) 보고 — 사람 발화는 사람 반박과 동급(2026-07-09 복권 규칙)");
const pin = run("pin", "읽는 채널", "--why", "사용자 지시로 고정");
ok(pin.status === 0 && /신뢰|trusted/.test(pin.stdout), "pin → 차선 trusted(사람 오버라이드)");
const badCmd = run("erase", "x");
ok(badCmd.status === 2, "미지 명령 거부");

console.log("[4-1] 트림 판정 보존 — 이벤트 상한 초과 시 오래된 '반박'이 잘려 틀림 딱지가 부활하는 결함 방지(2026-07-09)");
const wsT = path.join(dir, "trim-ws");
fs.mkdirSync(wsT, { recursive: true });
const tf = CL.ledgerEventsFileFor(wsT);
fs.mkdirSync(path.dirname(tf), { recursive: true });
const oldLines = [JSON.stringify({ ts: "t0", type: "proposed", sig: "keep", text: "old-alpha.ts ↔ old-beta.ts" }), JSON.stringify({ ts: "t1", type: "user_dispute", sig: "keep", from: "사용자 정정" })];
for (let i = 0; i < 2450; i++) oldLines.push(JSON.stringify({ ts: "t" + (i + 2), type: "proposed", sig: "keep", text: "old-alpha.ts ↔ old-beta.ts" }));
fs.writeFileSync(tf, oldLines.join("\n") + "\n");
CL.appendLedgerEvent(wsT, { ts: "tz", type: "proposed", sig: "keep", text: "old-alpha.ts ↔ old-beta.ts" });
const trimmed = CL.readLedgerEventsText(wsT).split(/\r?\n/).filter(Boolean);
ok(trimmed.length <= CL.LEDGER_EVENTS_CAP, "트림 후 총량은 상한(2000) 이내 — PRIVACY '약 2,000줄 보존' 고지 불침");
ok(trimmed.some((l) => l.includes('"user_dispute"')), "가장 오래된 판정(반박) 이벤트가 트림에서 살아남음(판정 보존)");
const afterTrim = LE.deriveLedger(LE.parseEventsJsonl(CL.readLedgerEventsText(wsT)).events).find((x) => x.sig === "keep");
ok(afterTrim && afterTrim.status === "disputed", "트림 후에도 신분 disputed 유지 — 조용한 부활 없음");
// 반대 방향(Codex 반례): 복권 증거(반박 이후 확인)도 트림에서 살아남아 복권이 유지된다
const wsT3 = path.join(dir, "trim-ws3");
fs.mkdirSync(wsT3, { recursive: true });
const tf3 = CL.ledgerEventsFileFor(wsT3);
const rehabLines = [
  JSON.stringify({ ts: "t0", type: "proposed", sig: "rh", text: "rh-alpha.ts ↔ rh-beta.ts" }),
  JSON.stringify({ ts: "t1", type: "user_dispute", sig: "rh" }),
  JSON.stringify({ ts: "t2", type: "confirmed", sig: "rh" }),
  JSON.stringify({ ts: "t3", type: "confirmed", sig: "rh" }),
];
for (let i = 0; i < 2450; i++) rehabLines.push(JSON.stringify({ ts: "t" + (i + 4), type: "proposed", sig: "rh", text: "rh-alpha.ts ↔ rh-beta.ts" }));
fs.writeFileSync(tf3, rehabLines.join("\n") + "\n");
CL.appendLedgerEvent(wsT3, { ts: "tz", type: "proposed", sig: "rh", text: "rh-alpha.ts ↔ rh-beta.ts" });
const afterTrim3 = LE.deriveLedger(LE.parseEventsJsonl(CL.readLedgerEventsText(wsT3)).events).find((x) => x.sig === "rh");
ok(afterTrim3 && afterTrim3.status === "verified" && afterTrim3.rehabilitated === true, "가장 오래된 자리의 '반박 이후 확인 2건'도 보존 → 트림 후 복권 유지(반박만 남고 증거만 잘리는 비대칭 없음)");
// 극단: 판정 이벤트가 상한을 넘게 쌓여도 총량 상한은 지켜진다(판정도 최신순 — Codex 반례 잠금)
const wsT2 = path.join(dir, "trim-ws2");
fs.mkdirSync(wsT2, { recursive: true });
const tf2 = CL.ledgerEventsFileFor(wsT2);
const manyState = [];
for (let i = 0; i < 2450; i++) manyState.push(JSON.stringify({ ts: "s" + i, type: "user_dispute", sig: "s" + i }));
fs.writeFileSync(tf2, manyState.join("\n") + "\n");
CL.appendLedgerEvent(wsT2, { ts: "sz", type: "proposed", sig: "s0", text: "x-alpha.ts ↔ x-beta.ts" });
const trimmed2 = CL.readLedgerEventsText(wsT2).split(/\r?\n/).filter(Boolean);
ok(trimmed2.length <= CL.LEDGER_EVENTS_CAP, "판정 이벤트만 2450건인 극단에서도 총량 ≤ 상한(판정도 최신순 컷)");

console.log("[5] 대시보드 배선(소스 검사) — 승인 큐 제거·관측 개입(ledgerAct)·런타임 재사용(⑤ 역할 전환 잠금)");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(ext.includes('m?.type === "ledgerAct"'), "ledgerAct 핸들러 존재(고정/차단/해제/내보내기)");
ok(!ext.includes('"mapApprove"') && !ext.includes('"mapReject"'), "승인 큐 메시지 타입(\"mapApprove\"/\"mapReject\") 잔재 없음 — 필드명 mapApproved(확정층 줄 수)와 구분");
ok(ext.includes("lib?.appendLedgerEvent") || ext.includes("lib.appendLedgerEvent"), "이벤트 적재는 배포 런타임(contract-lib) 재사용 — 형식 복사 없음");
ok(/act === "export"[\s\S]{0,400}lane !== "trusted"/.test(ext), "내보내기는 신뢰 차선만(게이트 소스 잠금)");
ok(/record\("exported"[\s\S]{0,300}기록됐지만/.test(ext), "export의 이벤트 적재 실패 문구는 '장부 파일은 기록됐다'는 사실을 말함(거짓 '무반영' 금지 — Codex 반례 잠금)");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
