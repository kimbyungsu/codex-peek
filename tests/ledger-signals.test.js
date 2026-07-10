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
process.env.CODEX_HOME = dir; // findRolloutById가 세션 픽스처(sessions/)를 보게 — require '전' 설정 필수(로드 시 해석)

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

console.log("[1] confirmed 적재(L1-A v2) — 통과+두 경로 실존 인용이면 '기록', 승격은 증거의 질이 결정");
const PASS_ANSWER = "검토 완료 — 근거: (src/alpha-channel.ts:2) 그리고 (lib/beta-consumer.ts:3)\n검증: 통과";
CB.flagLedgerConfirms(PASS_ANSWER, ws, "", ws);
ok(countType("confirmed") === 1, "두 경로 실존 인용 + 통과 → confirmed 1건");
{
  const e1 = eventsNow().find((e) => e.type === "confirmed");
  ok(e1.grade === "co-cited" && e1.seen === "unknown", "세션 미식별 → grade=co-cited·seen=unknown(취급 흔적 검사 불가를 이벤트에 정직 기록)");
  const d1 = LE.deriveLedger(eventsNow()).find((e) => e.sig === sig);
  ok(d1.status === "inferred", "seen=unknown은 승격 재료 아님 — 판정 불가가 확인 성공으로 흐르던 결함 봉합(Codex 설계검증)");
}
// 승격 경로(끝-끝): 세션 rollout에 '이번 턴' 취급 흔적을 만들어 seen=ok + 서로 다른 askId 2회 → verified
{
  const SESS = path.join(dir, "sessions");
  fs.mkdirSync(SESS, { recursive: true });
  const roll = (id) => fs.writeFileSync(path.join(SESS, `rollout-${id}.jsonl`), [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "검증 요청" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: "cat src/alpha-channel.ts lib/beta-consumer.ts" }) } }),
  ].map((s) => s).join("\n"), "utf8");
  roll("aaaa1111-e2e1"); roll("aaaa1111-e2e2");
  CB.flagLedgerConfirms(PASS_ANSWER, ws, "aaaa1111-e2e1", ws, { askId: "ask-1", attach: { mapItems: [], couplings: [] } });
  let d = LE.deriveLedger(eventsNow()).find((e) => e.sig === sig);
  ok(d.status === "inferred", "seen=ok 공동 인용 1회(askId 1개) → 아직 미승격(공동 인용≠결합 확인)");
  CB.flagLedgerConfirms(PASS_ANSWER, ws, "aaaa1111-e2e2", ws, { askId: "ask-2", attach: { mapItems: [], couplings: [] } });
  d = LE.deriveLedger(eventsNow()).find((e) => e.sig === sig);
  ok(d.status === "verified" && d.lane === "trusted", "서로 다른 ask 2회(비-echoed·seen=ok) → 검증됨 승격(끝-끝)");
  const last = eventsNow().filter((e) => e.type === "confirmed").pop();
  ok(last.seen === "ok" && last.askId === "ask-2" && last.echoed === false, "이벤트에 seen=ok·askId·echoed=false 기록");
}
console.log("[1-1] echo(항목 단위) — 동봉 '한 항목'이 그 경로 쌍을 노출했으면 echoed=true(승격 재료 아님)");
{
  const ws2 = path.join(dir, "proj-echo");
  fs.mkdirSync(path.join(ws2, "src"), { recursive: true });
  fs.mkdirSync(path.join(ws2, "lib"), { recursive: true });
  fs.writeFileSync(path.join(ws2, "src", "alpha-channel.ts"), "l1\nl2\n");
  fs.writeFileSync(path.join(ws2, "lib", "beta-consumer.ts"), "l1\nl2\nl3\n");
  CL.appendLedgerEvent(ws2, { ts: "t", type: "proposed", sig: CL.ledgerSig(TEXT), text: TEXT, from: "self 지도 T" });
  const attach = { mapItems: [{ path: "src/alpha-channel.ts", note: "lib/beta-consumer.ts와 결합" }], couplings: [] }; // 한 항목이 쌍을 함께 노출
  CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:1) (lib/beta-consumer.ts:2)\n검증: 통과", ws2, "", ws2, { askId: "e1", attach });
  const e = LE.parseEventsJsonl(CL.readLedgerEventsText(ws2)).events.find((x) => x.type === "confirmed");
  ok(e && e.echoed === true, "쌍을 노출한 동봉 항목 존재 → echoed=true");
  const attach2 = { mapItems: [{ path: "src/alpha-channel.ts", note: "" }, { path: "lib/beta-consumer.ts", note: "" }], couplings: [] }; // 서로 다른 항목 — 쌍 노출 아님
  CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:1) (lib/beta-consumer.ts:2)\n검증: 통과", ws2, "", ws2, { askId: "e2", attach: attach2 });
  const e2 = LE.parseEventsJsonl(CL.readLedgerEventsText(ws2)).events.filter((x) => x.type === "confirmed").pop();
  ok(e2 && e2.echoed === false, "경로들이 서로 다른 항목에만 있으면 echoed=false — 전역 합집합 과도 판정 폐기(Codex)");
}
console.log("[1-2] 명시 표기(claimed) — 행 단독만·상충 거부·인용 미동반은 기록만(승격/강등 재료 아님) — Codex 반례 왕복");
{
  const ws3 = path.join(dir, "proj-claim");
  fs.mkdirSync(path.join(ws3, "src"), { recursive: true });
  fs.mkdirSync(path.join(ws3, "lib"), { recursive: true });
  fs.writeFileSync(path.join(ws3, "src", "alpha-channel.ts"), "l1\nl2\n");
  fs.writeFileSync(path.join(ws3, "lib", "beta-consumer.ts"), "l1\nl2\nl3\n");
  const cpl = { id: "abc123", sig: "claim-sig", paths: ["src/alpha-channel.ts", "lib/beta-consumer.ts"] };
  const cpl2 = { id: "def456", sig: "claim-sig-2", paths: ["src/alpha-channel.ts", "lib/beta-consumer.ts"] };
  const cpl3 = { id: "aaa111", sig: "claim-sig-3", paths: ["src/alpha-channel.ts", "lib/beta-consumer.ts"] };
  const attach = { mapItems: [], couplings: [cpl, cpl2, cpl3] };
  const answer3 = [
    "이 답은 결합확인 #abc123 를 본문 문장 안에 인용만 했다(행 단독 아님 — 무시돼야).",
    "결합확인 #def456",             // 행 단독 — 유효(단 인용 미동반)
    "결합확인 #aaa111",             // 행 단독 + 아래에서 상충
    "결합반박 #aaa111",             // 상충 — 둘 다 거부
    "결합확인 #ffffff",             // 동봉 안 된 id — 무시
    "검증: 실패",
  ].join("\n");
  CB.flagLedgerConfirms(answer3, ws3, "", ws3, { askId: "c1", attach });
  const evs = LE.parseEventsJsonl(CL.readLedgerEventsText(ws3)).events;
  ok(!evs.some((x) => x.sig === "claim-sig"), "본문 속 표기(행 단독 아님) → 무시(부정문·예시 오인식 차단)");
  const e2 = evs.find((x) => x.type === "confirmed" && x.sig === "claim-sig-2");
  ok(!!e2 && e2.grade === "claimed" && e2.echoed === true && e2.cited === false, "행 단독 표기 → claimed 기록(실패 판정에서도) · 인용 미동반이라 cited=false");
  ok(!evs.some((x) => x.sig === "claim-sig-3"), "같은 id에 확인+반박 상충 → 둘 다 거부(자기모순 자기보고)");
  ok(!evs.some((x) => String(x.from || "").includes("ffffff")), "동봉 안 된 id(#ffffff)는 무시(임의 id 날조 차단)");
  // cited=false claimed는 승격 재료 아님 — 유도 확인
  CB.flagLedgerConfirms("결합확인 #def456\n검증: 실패", ws3, "", ws3, { askId: "c2", attach });
  const d3 = LE.deriveLedger(evsNow3(ws3)).find((x) => x.sig === "claim-sig-2");
  ok(d3 && d3.status === "inferred", "인용 미동반 표기 2회(서로 다른 askId) → 여전히 미승격(자기보고 단독 승격 차단)");
  // 인용 동반 표기 + seen=ok(세션 rollout에 이번 턴 취급 흔적) → cited=true → 서로 다른 askId 2회에 승격
  const SESS3 = path.join(dir, "sessions");
  fs.mkdirSync(SESS3, { recursive: true });
  const roll3 = (id) => fs.writeFileSync(path.join(SESS3, `rollout-${id}.jsonl`), [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "검증 요청" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: "cat src/alpha-channel.ts lib/beta-consumer.ts" }) } }),
  ].join("\n"), "utf8");
  roll3("cccc1111-cl03"); roll3("cccc1111-cl04"); roll3("cccc1111-cl05"); roll3("cccc1111-cl06");
  const citedAns = "근거: (src/alpha-channel.ts:1) (lib/beta-consumer.ts:2)\n결합확인 #abc123\n검증: 통과";
  CB.flagLedgerConfirms(citedAns, ws3, "cccc1111-cl03", ws3, { askId: "c3", attach });
  CB.flagLedgerConfirms(citedAns, ws3, "cccc1111-cl04", ws3, { askId: "c4", attach });
  const d4 = LE.deriveLedger(evsNow3(ws3)).find((x) => x.sig === "claim-sig");
  ok(d4 && d4.status === "verified", "인용 동반(cited=true)·seen=ok 표기가 서로 다른 askId 2회 → 승격");
  // 반박 표기: 인용 미동반이면 강등 재료 아님(기록만)
  CB.flagLedgerConfirms("결합반박 #abc123\n검증: 실패", ws3, "cccc1111-cl05", ws3, { askId: "c5", attach });
  const d5 = LE.deriveLedger(evsNow3(ws3)).find((x) => x.sig === "claim-sig");
  ok(d5 && d5.status === "verified", "인용 미동반 반박 표기 → 강등 안 됨(근거 없는 자기보고 한 줄이 즉시 disputed 만들던 결함 봉합)");
  CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:1) (lib/beta-consumer.ts:2)\n결합반박 #abc123\n검증: 실패", ws3, "cccc1111-cl06", ws3, { askId: "c6", attach });
  const d6 = LE.deriveLedger(evsNow3(ws3)).find((x) => x.sig === "claim-sig");
  ok(d6 && d6.status === "disputed", "인용 동반 반박 표기 → 강등(구체 근거 흔적 요구 충족)");
}
function evsNow3(w) { return LE.parseEventsJsonl(CL.readLedgerEventsText(w)).events; }

console.log("[2] 보수 규칙 — 다음 경우엔 적재 안 됨");
const cBase = countType("confirmed"); // 앞 구획(승격 끝-끝)까지의 누계 기준 — 이후는 delta로 단언
CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:2) (lib/beta-consumer.ts:3)\n검증: 실패", ws, "", ws);
ok(countType("confirmed") === cBase, "실패 판정 → 추가 없음");
CB.flagLedgerConfirms("근거: (src/alpha-channel.ts:2)뿐\n검증: 통과", ws, "", ws);
ok(countType("confirmed") === cBase, "경로 1개만 인용 → 추가 없음(결합의 양쪽 요구)");
CB.flagLedgerConfirms("본문에 src/alpha-channel.ts 와 lib/beta-consumer.ts 를 언급만(인용 형식·라인 없음)\n검증: 통과", ws, "", ws);
ok(countType("confirmed") === cBase, "텍스트 메아리(라인 인용 없음) → 추가 없음(자기강화 차단)");
CB.flagLedgerConfirms("(src/alpha-channel.ts:999) (lib/beta-consumer.ts:3)\n검증: 통과", ws, "", ws);
ok(countType("confirmed") === cBase, "라인 초과 인용이 낀 파일은 확인 근거에서 제외 — 파일만 실재하는 헛인용 차단(보수 강화)");
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
ok(countType("confirmed") === cBase + 1, "반박된 항목에도 confirmed 기록(문전 폐기 폐지 — 승격은 유도기 복권 규칙이 판정)");
const midEntry = LE.deriveLedger(LE.parseEventsJsonl(CL.readLedgerEventsText(ws)).events).find((x) => x.sig === sig);
ok(midEntry && midEntry.status === "disputed", "반박 후 확인 1회(그마저 seen=unknown)로는 disputed 유지 — 보수성");
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
