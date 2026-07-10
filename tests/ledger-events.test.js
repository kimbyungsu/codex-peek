"use strict";
/*
 * 관측 장부(로드맵 ①②③) 테스트 — 이벤트 파싱·약한 상태 전이·꾸러미 선별·append 상한·서명 패리티·렌더 동봉.
 * node tests/ledger-events.test.js. CODEX_BRIDGE_HOME 임시폴더 — 실사용 브릿지 홈 오염 없음.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "le_"));
process.env.CODEX_BRIDGE_HOME = dir;

const LE = require(path.join(__dirname, "..", "out", "ledger-events.js"));
const ML = require(path.join(__dirname, "..", "out", "map-ledger.js"));
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const SP = require(path.join(__dirname, "..", "out", "scope-package.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const ev = (type, sig, extra) => JSON.stringify({ ts: "2026-07-07T00:00:00.000Z", type, sig, ...extra });

console.log("[1] 이벤트 파싱 — 깨진 줄은 건너뛰고 개수 보고(침묵 삼킴 금지)");
const parsed = LE.parseEventsJsonl([ev("proposed", "a", { text: "A ↔ B" }), "{broken", ev("confirmed", "a"), JSON.stringify({ ts: "t", type: "x" })].join("\n"));
ok(parsed.events.length === 2 && parsed.dropped === 2, `유효 2·탈락 2 (실제 ${parsed.events.length}/${parsed.dropped})`);

console.log("[1b] type 허용값 검증 — 미지 type은 counts 오염 대신 dropped(Codex 반례 잠금)");
const badType = LE.parseEventsJsonl([ev("nonsense", "a"), ev("proposed", "a", { text: "A" })].join("\n"));
ok(badType.events.length === 1 && badType.dropped === 1, "type:'nonsense' → dropped(이벤트로 안 들어감)");

console.log("[1c] 배선 계약(소스 검사) — 두 팔 러너 모두 saveMap 뒤 proposed 적재(한쪽 누락이 조용히 지나가지 않게)");
for (const f of ["scope-scout-self.js", "scope-scout-deepseek.js"]) {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", f), "utf8");
  ok(/appendLedgerEvent\([^)]*type:\s*"proposed"/.test(src), f + " — proposed 적재 호출 존재");
  ok(src.indexOf("saveMap(repo,") < src.search(/appendLedgerEvent\([^)]*type:\s*"proposed"/), f + " — 적재는 saveMap 뒤(보관과 같은 흐름·순서 잠금)");
}
ok(/appendLedgerEvent\([^)]*type:\s*"attached"/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8")), "scope-package.js — 꾸러미 주입분 attached 적재 호출 존재");

console.log("[2] 약한 상태 전이 — 우선순위(banned>superseded>tombstone>disputed>verified>inferred)·pinned 차선 오버라이드");
const D = (lines) => LE.deriveLedger(LE.parseEventsJsonl(lines.join("\n")).events);
let e = D([ev("proposed", "a", { text: "A ↔ B", from: "self 지도 T" })])[0];
ok(e.status === "inferred" && e.lane === "reference", "제안만 → 추정됨(참고 차선)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "co-cited", askId: "k1", seen: "ok" })])[0];
ok(e.status === "inferred" && e.reinterpreted !== true, "공동 인용 1회 → 아직 추정(공동 인용≠결합 확인 — L1-A v2. 신규 등급 이벤트라 재해석 표기 아님)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "co-cited", askId: "k1", seen: "ok" }), ev("confirmed", "a", { grade: "co-cited", askId: "k2", seen: "ok" })])[0];
ok(e.status === "verified" && e.lane === "trusted", "비-echoed 공동 인용이 서로 다른 ask 2회 → 검증됨(신뢰 차선)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "co-cited", askId: "k1", seen: "ok" }), ev("confirmed", "a", { grade: "co-cited", askId: "k1", seen: "ok" })])[0];
ok(e.status === "inferred", "같은 askId 반복은 1회로 셈(같은 요청 재실행 뻥튀기 차단)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k1", cited: true, seen: "ok" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k2", cited: true, seen: "ok" })])[0];
ok(e.status === "verified", "명시 표기(claimed·인용 동반)는 태생적 echoed지만 서로 다른 ask 2회면 승격");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k1" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k2" })])[0];
ok(e.status === "inferred", "인용 미동반(cited 아님) 표기는 몇 번이어도 승격 재료 아님(자기보고 단독 배제 — Codex 반례)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "co-cited", echoed: true, askId: "k1", seen: "ok" }), ev("confirmed", "a", { grade: "co-cited", echoed: true, askId: "k2", seen: "ok" })])[0];
ok(e.status === "inferred", "echoed 공동 인용은 몇 번이어도 승격 재료 아님(동봉이 유도한 인용 — 노출 관측만)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "co-cited", askId: "k1", seen: "unknown" }), ev("confirmed", "a", { grade: "co-cited", askId: "k2", seen: "unknown" })])[0];
ok(e.status === "inferred", "seen=unknown(취급 흔적 검사 불가)은 승격 재료 아님(기록만)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("user_confirm", "a")])[0];
ok(e.status === "verified", "사람 확인 1회 → 즉시 검증(사람 결정 보존)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a"), JSON.stringify({ ts: "2026-07-07T01:00:00.000Z", type: "confirmed", sig: "a" })])[0];
ok(e.status === "verified", "구형(grade 없음 legacy) 확인은 서로 다른 시각 2회면 유지(노출 미상 — 1회 단독 승격은 폐기)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a")])[0];
ok(e.status === "inferred" && e.reinterpreted === true, "legacy 확인 1회 → v2 재해석 강등+reinterpreted 표기(조용한 강등 금지)");
e = D([ev("proposed", "a", { text: "A" }), ev("confirmed", "a"), ev("user_dispute", "a")])[0];
ok(e.status === "disputed" && e.lane === "excluded", "확인 있어도 반박 오면 강등(반박된 지식은 권위 차선 밖 — tg 정책)");
e = D([ev("proposed", "a", { text: "A" }), ev("user_dispute", "a"), ev("pinned", "a")])[0];
ok(e.status === "disputed" && e.pinned && e.lane === "trusted", "사람 고정(pin)은 반박보다 위 — 차선만 신뢰로(상태는 정직하게 disputed 유지)");
e = D([ev("proposed", "a", { text: "A" }), ev("pinned", "a"), ev("unpinned", "a")])[0];
ok(!e.pinned && e.lane === "reference", "고정 후 해제 → 순 계산(net)으로 원복");
console.log("[2-1] 복권(rehab) — 반박 '이후' 확인만 인정: 사람 1회 / 검증 2회 · 차단은 복권 불가");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r", { grade: "co-cited", askId: "k1", seen: "ok" })])[0];
ok(e.status === "disputed" && !e.rehabilitated, "반박 후 기계 확인 1회 → 아직 disputed(서로 다른 ask 2회 필요)");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r", { grade: "co-cited", askId: "k1", seen: "ok" }), ev("confirmed", "r", { grade: "co-cited", askId: "k2", seen: "ok" })])[0];
ok(e.status === "verified" && e.rehabilitated === true && e.lane === "trusted", "반박 후 서로 다른 ask 기계 확인 2회 → 복권(verified·신뢰 차선·rehabilitated 표기)");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("user_confirm", "r")])[0];
ok(e.status === "verified" && e.rehabilitated === true, "반박 후 사용자 재확인 1회 → 즉시 복권(사람 발화는 사람 반박과 동급)");
e = D([ev("proposed", "r", { text: "R" }), ev("confirmed", "r"), ev("confirmed", "r"), ev("user_dispute", "r")])[0];
ok(e.status === "disputed", "반박 '이전' 확인 2회는 복권에 안 침(이미 반박에게 진 증거) — 순서 기준");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r"), ev("confirmed", "r"), ev("user_dispute", "r")])[0];
ok(e.status === "disputed", "복권 후 재반박 → 카운터 리셋되어 다시 disputed(진동 허용 — 마지막 판정이 이김)");
e = D([ev("proposed", "r", { text: "R" }), ev("banned", "r"), ev("user_confirm", "r"), ev("confirmed", "r"), ev("confirmed", "r")])[0];
ok(e.status === "banned", "차단(사람 오버라이드)은 확인이 아무리 쌓여도 복권 불가(해제는 unban만)");
e = D([ev("proposed", "a", { text: "A" }), ev("confirmed", "a"), ev("banned", "a"), ev("pinned", "a")])[0];
ok(e.status === "banned" && e.lane === "excluded", "차단(ban)은 최우선 — 고정보다도 위(사람의 명시 제외)");
e = D([ev("proposed", "a", { text: "A" }), ev("superseded", "a", { newSig: "b" })])[0];
ok(e.status === "superseded" && e.supersededBy === "b" && e.lane === "excluded", "대체됨 — 원본 보존+대체 링크(직접 되돌리기 금지)");
e = D([ev("proposed", "a", { text: "A" }), ev("tombstone", "a")])[0];
ok(e.status === "tombstone" && e.lane === "excluded", "묘비(파일 소멸) → 제외");

console.log("[3] 꾸러미 선별 — 씨앗 교집합 우선·상한·틀림판명 차선(pin 제외)");
const mk = (i, extra) => LE.deriveLedger(LE.parseEventsJsonl([ev("proposed", "s" + i, { text: extra }), ev("confirmed", "s" + i, { grade: "co-cited", askId: "p1", seen: "ok" }), ev("confirmed", "s" + i, { grade: "co-cited", askId: "p2", seen: "ok" })].join("\n")).events)[0];
const entries = [];
for (let i = 0; i < 12; i++) entries.push(mk(i, i === 11 ? "scripts/scope-package.js ↔ tests/scope-package.test.js — 결합" : "etc" + i + "/file" + i + ".ts ↔ other — 결합"));
const sel = LE.selectForPackage(entries, ["scripts/scope-package.js"]);
ok(sel.trusted.length === 8, `신뢰 상한 8 (실제 ${sel.trusted.length})`);
ok(sel.trusted[0].text.includes("scope-package"), "씨앗과 겹치는 항목이 상한 안에서 최우선");
const disputedEntry = D([ev("proposed", "d1", { text: "D ↔ X" }), ev("user_dispute", "d1")])[0];
const pinnedDisputed = D([ev("proposed", "d2", { text: "D2 ↔ X" }), ev("user_dispute", "d2"), ev("pinned", "d2")])[0];
const sel2 = LE.selectForPackage([disputedEntry, pinnedDisputed], []);
ok(sel2.disputed.length === 1 && sel2.disputed[0].sig === "d1" && sel2.trusted.some((x) => x.sig === "d2"), "틀림판명 각주엔 비고정 반박분만 — 고정분은 신뢰 차선으로");

console.log("[3-1] 별칭(alias) — 사람 승인 병합만·원장 보존·해제 가능(L1-B: 자동 canonical 병합 폐기)");
{
  const lines = [
    ev("proposed", "p1", { text: "src/foo-module.ts ↔ tests/foo-module.test.js — 결합" }),
    ev("proposed", "p2", { text: "결합: src/foo-module.ts 그리고 tests/foo-module.test.js (다른 문구)" }),
    ev("confirmed", "p1", { grade: "co-cited", askId: "a1", seen: "ok" }),
    ev("confirmed", "p2", { grade: "co-cited", askId: "a2", seen: "ok" }),
  ];
  let es = D(lines);
  ok(es.length === 2 && es.every((x) => x.status === "inferred"), "병합 전 — 서로 다른 항목·확인 이력이 흩어져 각각 미승격(문구 요동이 이력을 쪼갬)");
  const cands = LE.computeAliasCandidates(es);
  ok(cands.length === 1 && cands[0].sigs.length === 2, "같은 endpoint+방향의 다른 문구 → 별칭 후보 1묶음(자동 '제시'만)");
  es = D([...lines, ev("alias", "p1", { aliasSig: "p2" })]);
  ok(es.length === 1 && es[0].sig === "p1" && (es[0].aliases || []).includes("p2"), "사람 승인 alias → 한 항목으로 병합(별칭 기록)");
  ok(es[0].status === "verified", "병합 후 흩어졌던 확인(서로 다른 askId 2개)이 합산돼 승격 — 병합의 실익");
  es = D([...lines, ev("alias", "p1", { aliasSig: "p2" }), ev("unalias", "p1", { aliasSig: "p2" })]);
  ok(es.length === 2, "unalias(순계 0) → 병합 해제(원장 이벤트는 그대로 — 재해석일 뿐)");
  ok(LE.parseEventsJsonl(ev("alias", "p1", {})).dropped === 1, "aliasSig 없는 alias는 불량(파싱 탈락)");
  // 순환·초장 체인(Codex 실측 반례): 고정 홉 상한의 침묵 분열 폐기
  {
    const chain = [];
    for (let i = 0; i <= 11; i++) chain.push(ev("proposed", "c" + i, { text: "chain " + i }));
    for (let i = 0; i < 11; i++) chain.push(ev("alias", "c" + (i + 1), { aliasSig: "c" + i })); // c0→c1→…→c11
    const es11 = D(chain);
    ok(es11.length === 1 && es11[0].sig === "c11", `11홉 체인 → 한 항목으로 병합(실제 ${es11.length} — 고정 상한이면 둘로 분열)`);
    const cyc = D([ev("proposed", "x1", { text: "X1" }), ev("proposed", "x2", { text: "X2" }), ev("alias", "x1", { aliasSig: "x2" }), ev("alias", "x2", { aliasSig: "x1" })]);
    ok(cyc.length === 1 && cyc[0].sig === "x1", "순환(x1↔x2) → 고리 내 사전순 최소가 결정적 루트(병합 유지 — 침묵 무효화 아님)");
  }
}
console.log("[3-1b] 표식 반박의 강등 재료 조건 — 인용 미동반(cited=false) refuted는 기록만");
{
  let es = D([ev("proposed", "q", { text: "src/q-module.ts ↔ tests/q-module.test.js" }), ev("user_confirm", "q"), ev("refuted", "q", { grade: "claimed", cited: false, askId: "r1", seen: "ok" })]);
  ok(es[0].status === "verified" && (es[0].counts.refuted || 0) === 1, "근거 없는 표식 반박 → 기록은 남되(counts) 강등 안 됨");
  es = D([ev("proposed", "q", { text: "src/q-module.ts ↔ tests/q-module.test.js" }), ev("user_confirm", "q"), ev("refuted", "q", { grade: "claimed", cited: true, askId: "r1", seen: "ok" })]);
  ok(es[0].status === "disputed", "인용 동반 표식 반박 → 강등(구체 근거 흔적)");
}
console.log("[3-2] autoEligible — 실제 확인기와 동형 규칙(고유 8자+ basename 2개)·분모 왜곡 방지");
{
  ok(LE.autoConfirmEligible("src/foo-module.ts ↔ tests/foo-module.test.js") === true, "고유 긴 basename 2개 → 기계 확인 가능");
  ok(LE.autoConfirmEligible("proofs/ 쓰기 ↔ verify-guard 읽기") === false, "경로꼴 2개 미만 → 불가(확인기와 동형)");
  ok(LE.autoConfirmEligible("src/a.ts ↔ lib/a.ts — 같은 basename") === false, "basename이 같으면(8자 미만 포함) 확인기가 한 증거로만 봄 — 불가");
  const h = LE.computeScoutHealth(D([
    ev("proposed", "m1", { text: "src/foo-module.ts ↔ tests/foo-module.test.js" }), ev("attached", "m1"), ev("confirmed", "m1", { grade: "co-cited", askId: "x1", seen: "ok" }),
    ev("proposed", "m2", { text: "개념 결합(경로 없음) ↔ 개념" }), ev("attached", "m2"),
  ]));
  ok(h.reusedDen === 2 && h.autoDen === 1 && h.autoNum === 1, "지표 분리 — 전체 재사용 분모 2 vs 기계확인가능 분모 1(경로<2 항목이 기계 지표 분모를 왜곡하지 않음)");
}

console.log("[4] 경로 추출 — 버전숫자 오인 없음(선별 교집합의 안전)");
ok(LE.extractPathsFromText("0.1.86 버전 (high)").length === 0, "0.1.86 → 경로 아님");
ok(LE.extractPathsFromText("`src/a.ts`를 확인").includes("src/a.ts"), "백틱·조사 제거 후 추출");

console.log("[5] 서명 패리티 — contract-lib.ledgerSig ≡ map-ledger.normSig(복사 유지 잠금)");
for (const s of ["A  ↔  B — 이유", " proofs/ 쓰기 ↔ verify-guard 읽기 ", "MiXeD Case\tTAB"]) {
  ok(CL.ledgerSig(s) === ML.normSig(s), `"${s.slice(0, 20)}…" 동일 서명`);
}

console.log("[6] appendLedgerEvent — 왕복·불량 거부·상한 트림(최신 보존)");
const ws = path.join(dir, "proj");
ok(CL.appendLedgerEvent(ws, { ts: "t", type: "proposed", sig: "x", text: "X" }) === true, "정상 append");
ok(CL.readLedgerEventsText(ws).includes('"sig":"x"'), "읽기 왕복");
ok(CL.appendLedgerEvent(ws, { ts: "t", type: "proposed" }) === false, "sig 없는 이벤트 거부");
for (let i = 0; i < 2500; i++) CL.appendLedgerEvent(ws, { ts: "t" + i, type: "proposed", sig: "bulk" + i });
const lines = CL.readLedgerEventsText(ws).split(/\r?\n/).filter(Boolean);
ok(lines.length <= 2400 && lines.length >= 2000, `상한 트림 동작(현재 ${lines.length}줄 — 2000~2400 창)`);
ok(JSON.parse(lines[lines.length - 1]).sig === "bulk2499", "트림은 오래된 쪽을 자름(최신 보존)");

console.log("[7] 렌더 동봉 — §7.5 3차선, 장부 없으면 구획 자체가 없음(주입 0)");
const base = { repo: "r", head: "abcdef0", seeds: ["s.ts"], diffText: "", tokenHits: [], coChange: null, tests: [], recentFailures: [], mapContent: null };
const md1 = SP.renderPackageMarkdown(SP.buildPackage({ ...base, ledger: { trusted: [{ text: "T1 ↔ T2" }], reference: [{ text: "R1 ↔ R2" }], disputed: [{ text: "D1 ↔ D2" }] } }));
ok(md1.includes("7.5 자동 관측 장부") && md1.includes("확인됨") && md1.includes("T1 ↔ T2"), "신뢰 차선 렌더");
ok(md1.includes("미검증 제안") && md1.includes("틀림 판명") && md1.includes("반박 이후 무엇이 바뀌었는지") && !md1.includes("다시 내지 마라"), "틀림판명 각주 — 전면 금지가 아니라 '근거 있는 재주장 허용'(2026-07-09 사용자 결정: 지식 진화)");
ok(md1.indexOf("판정 기준 아님") > 0, "advisory 명시");
const md0 = SP.renderPackageMarkdown(SP.buildPackage({ ...base, ledger: null }));
ok(!md0.includes("7.5"), "장부 없음 → 구획 없음");
const mdEmpty = SP.renderPackageMarkdown(SP.buildPackage({ ...base, ledger: { trusted: [], reference: [], disputed: [] } }));
ok(!mdEmpty.includes("7.5"), "전 차선 빈 장부 → 구획 없음(주입 0)");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
