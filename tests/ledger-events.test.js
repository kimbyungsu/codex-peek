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

console.log("[1c] 배선 계약(소스 검사) — P5: 공통 파이프라인이 saveMap 뒤 proposed 적재 + 러너 2종 위임(한쪽 누락 자체가 불가)");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scout-providers.js"), "utf8");
  ok(/appendLedgerEvent\([^)]*type:\s*"proposed"/.test(src), "scout-providers.js — proposed 적재 호출 존재");
  ok(src.indexOf("saveMap(repo, providerId") < src.search(/appendLedgerEvent\([^)]*type:\s*"proposed"/), "scout-providers.js — 적재는 saveMap 뒤(보관과 같은 흐름·순서 잠금)");
  for (const f of ["scope-scout-self.js", "scope-scout-deepseek.js"]) ok(/runScout\(repo, "(self|deepseek)"/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", f), "utf8")), f + " — runScout 위임");
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
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k1", cited: true, seen: "ok" })])[0];
ok(e.status === "verified", "명시 표기(claimed·정확 경로 인용·취급 확인)는 강한 증거라 1회면 승격");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k1" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k2" })])[0];
ok(e.status === "inferred", "인용 미동반(cited 아님) 표기는 몇 번이어도 승격 재료 아님(자기보고 단독 배제 — Codex 반례)");
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a", { grade: "co-cited", askId: "k1", seen: "ok" }), ev("confirmed", "a", { grade: "claimed", echoed: true, askId: "k2", cited: false, seen: "ok" })])[0];
ok(e.status === "inferred", "약한 공동 인용 1회+불완전 claimed 1회를 합쳐 승격하지 않음(등급별 집계)");
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
console.log("[2-1] 복권(rehab) — 반박 '이후' 확인만 인정: 사람·강한 명시 1회 / 공동 인용 2회 · 차단은 복권 불가");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r", { grade: "co-cited", askId: "k1", seen: "ok" })])[0];
ok(e.status === "disputed" && !e.rehabilitated, "반박 후 기계 확인 1회 → 아직 disputed(서로 다른 ask 2회 필요)");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r", { grade: "co-cited", askId: "k1", seen: "ok" }), ev("confirmed", "r", { grade: "co-cited", askId: "k2", seen: "ok" })])[0];
ok(e.status === "verified" && e.rehabilitated === true && e.lane === "trusted", "반박 후 서로 다른 ask 기계 확인 2회 → 복권(verified·신뢰 차선·rehabilitated 표기)");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r", { grade: "claimed", askId: "k1", cited: true, seen: "ok" })])[0];
ok(e.status === "verified" && e.rehabilitated === true, "반박 후 강한 명시 확인 1회 → 복권(동일 증거 강도 규칙)");
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
const bulkN = CL.LEDGER_EVENTS_TRIM_AT + 50;
const bulkRows = [];
for (let i = 0; i < bulkN; i++) bulkRows.push(JSON.stringify({ ts: "t" + i, type: "proposed", sig: "bulk" + i }));
fs.writeFileSync(CL.ledgerEventsFileFor(ws), bulkRows.join("\n") + "\n", "utf8");
CL.appendLedgerEvent(ws, { ts: "latest", type: "proposed", sig: "bulk-latest" });
const lines = CL.readLedgerEventsText(ws).split(/\r?\n/).filter(Boolean);
ok(lines.length <= CL.LEDGER_EVENTS_CAP, `확장 상한 트림 동작(현재 ${lines.length}줄 ≤ ${CL.LEDGER_EVENTS_CAP})`);
ok(JSON.parse(lines[lines.length - 1]).sig === "bulk-latest", "트림은 오래된 쪽을 자름(최신 보존)");

console.log("[6b] 트림 아카이브 — 잘린 원시 이벤트 보존(수칙서 ab-5 결속)+실패 시 트림 보류(fail-closed)");
{
  const af = CL.ledgerEventsFileFor(ws).replace(/\.jsonl$/, "") + ".archive.jsonl";
  ok(fs.existsSync(af), "아카이브 파일 생성됨");
  const aLines = fs.readFileSync(af, "utf8").split(/\r?\n/).filter(Boolean);
  const marker = JSON.parse(aLines[0]);
  ok(marker.type === "trim-archive" && marker.n > 0, "아카이브 머리 기록(type·건수)");
  const aOrig = aLines.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0);
  ok(aOrig.length === marker.n, `아카이브 실물 건수 일치(${aOrig.length}=${marker.n} — 마커·커밋 줄 제외)`);
  // [재검증 blocker] 전량 다중집합 동등: 트림 전 원문 전량(중복 포함) == 본 파일의 '원문 부분'(압축본 제외) + 아카이브 원문.
  // 부분 검사(첫 줄 하나)는 같은 줄을 n번 기록하는 오구현을 통과시킴 — 개수 맵으로 정확 비교.
  const preTrim = bulkRows.concat([JSON.stringify({ ts: "latest", type: "proposed", sig: "bulk-latest" })]);
  const count = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
  const mainOriginals = lines.filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const union = count(mainOriginals.concat(aOrig));
  const pre = count(preTrim);
  let msMatch = pre.size === union.size;
  if (msMatch) { for (const [k, v] of pre) if (union.get(k) !== v) { msMatch = false; break; } }
  ok(msMatch, `전량 다중집합 동등 — 트림 전 ${preTrim.length}줄 == 본 파일 원문 ${mainOriginals.length} + 아카이브 ${aLines.length - 1}(중복·누락 0)`);
  ok(aLines.some((l) => l.indexOf('"type":"trim-commit"') >= 0 && l.indexOf(marker.batchSha) >= 0), "재작성 성공 후 trim-commit 줄 기록(2단 커밋)");
  // [재검증 blocker] 크래시 재시도 중복 방지: append 후·재작성 전 죽은 상태(미커밋 배치+본문 무변경)를 재현 —
  // 커밋 줄만 지우고 본 파일을 트림 전 상태로 되돌린 뒤 재트림 → stale 배치가 절단되고 새 배치 1개만 남아야 함.
  {
    const aRaw = fs.readFileSync(af, "utf8").split(/\r?\n/).filter(Boolean);
    const noCommit = aRaw.filter((l) => l.indexOf('"type":"trim-commit"') < 0);
    fs.writeFileSync(af, noCommit.join("\n") + "\n", "utf8"); // 커밋 줄 제거=미커밋 배치 위장
    fs.writeFileSync(CL.ledgerEventsFileFor(ws), preTrim.join("\n") + "\n", "utf8"); // 본문을 트림 전 상태로(재작성 실패 재현)
    CL.appendLedgerEvent(ws, { ts: "retry", type: "proposed", sig: "bulk-retry" }); // 재트림 유발
    const a2 = fs.readFileSync(af, "utf8").split(/\r?\n/).filter(Boolean);
    const markers2 = a2.filter((l) => l.indexOf('"type":"trim-archive"') >= 0);
    ok(markers2.length === 1, `재시도 후 배치 마커 1개(중복 보관 없음 — 현재 ${markers2.length}개)`);
    const m2 = JSON.parse(markers2[0]);
    const lines2b = CL.readLedgerEventsText(ws).split(/\r?\n/).filter(Boolean);
    const mainOrig2 = lines2b.filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
    const pre2 = count(preTrim.concat([JSON.stringify({ ts: "retry", type: "proposed", sig: "bulk-retry" })]));
    const union2 = count(mainOrig2.concat(a2.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0)));
    let ms2 = pre2.size === union2.size;
    if (ms2) { for (const [k, v] of pre2) if (union2.get(k) !== v) { ms2 = false; break; } }
    ok(ms2, `재시도 후에도 전량 다중집합 동등(stale 배치 절단·유실 0 — 배치 ${m2.n}건)`);

    // [R6 blocker②-a] 2차 트림의 미커밋 회수가 '커밋된 1차 배치'를 바이트 단위로 보존하는지 —
    // 마커의 한글(from 필드) 때문에 문자열 인덱스로 절단하면 1차 배치 끝이 파괴된다(UTF-8 오프셋 반례).
    {
      const f1 = CL.ledgerEventsFileFor(ws);
      // 1차 배치+커밋이 정착된 현재 아카이브 스냅샷(바이트) 보존
      const aBefore = fs.readFileSync(af);
      // 본 파일을 다시 상한 초과로 채워 2차 트림 유발 → 2차 배치+커밋 생성
      const cur1 = fs.readFileSync(f1, "utf8").split(/\r?\n/).filter(Boolean);
      const extra = [];
      for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT - cur1.length + 10; i++) extra.push(JSON.stringify({ ts: "u" + i, type: "proposed", sig: "wave2-" + i }));
      fs.writeFileSync(f1, cur1.concat(extra).join("\n") + "\n", "utf8");
      CL.appendLedgerEvent(ws, { ts: "w2", type: "proposed", sig: "wave2-last" });
      const pre2nd = cur1.concat(extra).concat([JSON.stringify({ ts: "w2", type: "proposed", sig: "wave2-last" })]);
      // 2차 배치를 미커밋으로 위장(마지막 trim-commit 1줄만 제거)+본문을 2차 트림 전 상태로 원복 → 재트림(회수)
      const aAll = fs.readFileSync(af, "utf8").split(/\r?\n/).filter(Boolean);
      let lastCommit = -1;
      for (let i = aAll.length - 1; i >= 0; i--) if (aAll[i].indexOf('"type":"trim-commit"') >= 0) { lastCommit = i; break; }
      aAll.splice(lastCommit, 1);
      fs.writeFileSync(af, aAll.join("\n") + "\n", "utf8");
      fs.writeFileSync(f1, pre2nd.join("\n") + "\n", "utf8");
      CL.appendLedgerEvent(ws, { ts: "w3", type: "proposed", sig: "wave2-retry" });
      const aAfter = fs.readFileSync(af);
      ok(aAfter.length >= aBefore.length && aAfter.subarray(0, aBefore.length).equals(aBefore), "2차 회수 후에도 커밋된 1차 배치 구간 바이트 동일(UTF-8 절단 오염 없음)");
      const mk3 = fs.readFileSync(af, "utf8").split(/\r?\n/).filter((l) => l.indexOf('"type":"trim-archive"') >= 0);
      ok(mk3.length === 2, `배치 마커 2개(1차 보존+2차 재적재 — 현재 ${mk3.length}개)`);
    }
  }
  // [R6 blocker①] atomicWrite 실패=커밋 미기록 — 반환 검사 소스 계약 핀(실패 시 '미커밋 배치'로 남아 회수 규약이 처리)
  {
    const src9 = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
    ok(/if \(atomicWrite\(f, out2\.join\("\\n"\) \+ "\\n"\)\) \{/.test(src9), "본문 교체 성공 시에만 trim-commit 기록(반환 검사 핀)");
  }

console.log("[6c] R7 실행 반례 — atomicWrite 실패 실주입·보존 선정 변경(pinned)에도 중복·유실 0");
{
  const countM = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
  const msEq = (a, b) => { const A = countM(a), B = countM(b); if (A.size !== B.size) return false; for (const [k, v] of A) if (B.get(k) !== v) return false; return true; };
  // ① renameSync 실패 주입 → atomicWrite=false → 커밋 미기록·본문 무변조. 복구 후 재트림 → 회수·전량 보존.
  const ws3 = path.join(dir, "proj3");
  const rows3 = [];
  for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT + 10; i++) rows3.push(JSON.stringify({ ts: "t" + i, type: "proposed", sig: "c3-" + i, text: "T" + i }));
  fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(ws3)), { recursive: true });
  fs.writeFileSync(CL.ledgerEventsFileFor(ws3), rows3.join("\n") + "\n", "utf8");
  const af3 = CL.ledgerEventsFileFor(ws3).replace(/\.jsonl$/, "") + ".archive.jsonl";
  const evA = { ts: "x1", type: "proposed", sig: "c3-fail" };
  const origRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error("inject-rename-fail"); e.code = "EPERM"; throw e; };
  let ok1;
  try { ok1 = CL.appendLedgerEvent(ws3, evA); } finally { fs.renameSync = origRename; }
  ok(ok1 === true, "rename 실패 주입에도 적재 자체는 성공");
  const a3 = fs.readFileSync(af3, "utf8").split(/\r?\n/).filter(Boolean);
  ok(a3.some((l) => l.indexOf('"type":"trim-archive"') >= 0) && !a3.some((l) => l.indexOf('"type":"trim-commit"') >= 0), "재작성 실패 → 배치는 있으나 커밋 없음(거짓 커밋 차단)");
  const main3 = CL.readLedgerEventsText(ws3).split(/\r?\n/).filter(Boolean);
  ok(main3.length === rows3.length + 1, `본문은 옛 파일+신규 1줄 그대로(${main3.length}줄 — 무변조)`);
  // ② 복구 전 'pinned' 이벤트로 보존 선정을 변경(옛 proposed가 대표 원문으로 보존됨) → 구 규약(부분집합)이면
  //    거짓 커밋→중복이던 반례. 새 규약(postMainSha 접두)은 재작성 미발생을 정확 판별해 절단·재적재.
  const evB = { ts: "x2", type: "pinned", sig: "c3-5" };
  CL.appendLedgerEvent(ws3, evB);
  const a3b = fs.readFileSync(af3, "utf8").split(/\r?\n/).filter(Boolean);
  const mk3b = a3b.filter((l) => l.indexOf('"type":"trim-archive"') >= 0);
  ok(mk3b.length === 1, `회수 후 배치 마커 1개(중복 보관 없음 — 현재 ${mk3b.length}개)`);
  ok(a3b.some((l) => l.indexOf('"type":"trim-commit"') >= 0), "재작성 성공 후 커밋 기록");
  const main3b = CL.readLedgerEventsText(ws3).split(/\r?\n/).filter(Boolean);
  const mainOrig3 = main3b.filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const aOrig3 = a3b.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0);
  // pinned는 가역 이벤트라 원시가 압축본으로 대체(아카이브에 원문 보존) — 전량 비교는 pinned 원문 포함으로 수행
  const all3 = rows3.concat([JSON.stringify(evA), JSON.stringify(evB)]);
  ok(msEq(all3, mainOrig3.concat(aOrig3)), `보존 선정 변경 후에도 전량 다중집합 동등(본문 원문 ${mainOrig3.length}+아카이브 ${aOrig3.length} — 중복·유실 0)`);
}
  // fail-closed: 아카이브 경로를 디렉터리로 막으면 append 실패 → 트림이 보류되고 본 파일은 '바이트 단위' 무손실
  const ws2 = path.join(dir, "proj2");
  const rows2 = [];
  for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT + 10; i++) rows2.push(JSON.stringify({ ts: "t" + i, type: "proposed", sig: "b2-" + i }));
  fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(ws2)), { recursive: true });
  fs.writeFileSync(CL.ledgerEventsFileFor(ws2), rows2.join("\n") + "\n", "utf8");
  fs.mkdirSync(CL.ledgerEventsFileFor(ws2).replace(/\.jsonl$/, "") + ".archive.jsonl", { recursive: true }); // append 실패 유도(EISDIR)
  const beforeBytes = fs.readFileSync(CL.ledgerEventsFileFor(ws2), "utf8");
  const ev2 = { ts: "z", type: "proposed", sig: "b2-last" };
  ok(CL.appendLedgerEvent(ws2, ev2) === true, "적재 자체는 성공");
  const afterBytes = fs.readFileSync(CL.ledgerEventsFileFor(ws2), "utf8");
  ok(afterBytes === beforeBytes + JSON.stringify(ev2) + "\n", "아카이브 실패 시 트림 보류 — 기존 내용 바이트 동일+신규 1줄만 추가(변조·재작성 0)");
}

console.log("[6d] R7 blocker③ 실행 반례 — 16MB 판독 창 시작이 한글 문자 '중간'이어도 절단 오프셋 바이트 정확(선행 커밋 배치 무손상)");
{
  const countM = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
  const msEq = (a, b) => { const A = countM(a), B = countM(b); if (A.size !== B.size) return false; for (const [k, v] of A) if (B.get(k) !== v) return false; return true; };
  const ws4 = path.join(dir, "proj4");
  const rows4 = [];
  for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT + 10; i++) rows4.push(JSON.stringify({ ts: "u" + i, type: "proposed", sig: "c4-" + i, text: "U" + i }));
  fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(ws4)), { recursive: true });
  fs.writeFileSync(CL.ledgerEventsFileFor(ws4), rows4.join("\n") + "\n", "utf8");
  const af4 = CL.ledgerEventsFileFor(ws4).replace(/\.jsonl$/, "") + ".archive.jsonl";
  // 사전 적재: [커밋 완료 배치 A(거대 한글 줄로 16MB 초과 유도)] + [미커밋 stale 마커 B(재작성 미발생 — 절단 대상)]
  const shaA = "a".repeat(40), shaB = "b".repeat(40);
  const mkA = JSON.stringify({ ts: "pA", type: "trim-archive", n: 1, batchSha: shaA, preMainSha: "p", postLines: 1, postMainSha: "q", from: "seed" });
  const hugeHead = '{"ts":"g","type":"proposed","text":"';
  const runChars = 5800000; // 가(3바이트)×5.8M ≈ 17.4MB — 판독 창(16MB) 시작이 이 줄 내부에 떨어짐
  const huge = hugeHead + "가".repeat(runChars) + '"}';
  const cmA = JSON.stringify({ ts: "pC", type: "trim-commit", batchSha: shaA });
  const mkB = JSON.stringify({ ts: "pB", type: "trim-archive", n: 2, batchSha: shaB, preMainSha: "r", postLines: 3, postMainSha: "f".repeat(40), from: "stale" });
  const stale1 = JSON.stringify({ ts: "s1", type: "proposed", sig: "st-1", text: "한글 잔여" });
  const prefix = mkA + "\n" + huge + "\n" + cmA + "\n";
  const runStart = Buffer.byteLength(mkA + "\n" + hugeHead, "utf8");
  const W = 16 << 20;
  // 패딩으로 창 시작 바이트를 '가' 3바이트의 중간(비정렬)으로 강제 — 전제 단언으로 시나리오 성립을 보증
  const stale2For = (k) => JSON.stringify({ ts: "s2", type: "proposed", sig: "st-2", text: "잔여 둘" + "x".repeat(k) });
  const bodyFor = (k) => prefix + mkB + "\n" + stale1 + "\n" + stale2For(k) + "\n";
  const rem0 = ((Buffer.byteLength(bodyFor(0), "utf8") - W) - runStart) % 3;
  const kPad = ((1 - rem0) % 3 + 3) % 3;
  const body = bodyFor(kPad);
  const szB = Buffer.byteLength(body, "utf8");
  const boundary = szB - W;
  ok(boundary > runStart && boundary < runStart + 3 * runChars && (boundary - runStart) % 3 !== 0,
    `전제: 판독 창 시작(${boundary})이 한글 3바이트 문자의 중간(런 시작 ${runStart}·오프셋 나머지 ${(boundary - runStart) % 3})`);
  fs.writeFileSync(af4, body, "utf8");
  // 트림 발동 → 회수기가 stale 마커 B를 '정확한 바이트 위치'에서 절단해야 함(문자열 환산이면 어긋남)
  const evC = { ts: "x4", type: "proposed", sig: "c4-new" };
  ok(CL.appendLedgerEvent(ws4, evC) === true, "적재 성공");
  const abuf = fs.readFileSync(af4);
  const pbuf = Buffer.from(prefix, "utf8");
  ok(abuf.length > pbuf.length && Buffer.compare(abuf.slice(0, pbuf.length), pbuf) === 0,
    "선행 커밋 배치가 바이트 그대로(창 경계 디코딩 오차로 인한 경계 오염 0)");
  const rest = abuf.slice(pbuf.length).toString("utf8").split(/\r?\n/).filter(Boolean);
  ok(!rest.some((l) => l.indexOf(shaB) >= 0), "미커밋 stale 배치(마커·원시줄) 절단 완료(잔재 0)");
  let mk4 = null;
  try { mk4 = JSON.parse(rest[0]); } catch { mk4 = null; }
  ok(!!mk4 && mk4.type === "trim-archive" && Number.isInteger(mk4.postLines) && typeof mk4.postMainSha === "string",
    "절단 지점에 새 배치 마커가 정확히 접합(postLines·postMainSha 결속)");
  ok(rest[rest.length - 1].indexOf('"trim-commit"') >= 0 && rest[rest.length - 1].indexOf(mk4.batchSha) >= 0, "재작성 성공 후 커밋 기록");
  const mainL4 = CL.readLedgerEventsText(ws4).split(/\r?\n/).filter(Boolean).filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const arch4 = rest.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0);
  const all4 = rows4.concat([JSON.stringify(evC)]);
  ok(msEq(all4, mainL4.concat(arch4)), `전량 다중집합 동등(본문 원문 ${mainL4.length}+아카이브 신규분 ${arch4.length} — 중복·유실 0)`);
}

console.log("[6e] R8 실행 반례 — 보존 우선 이벤트가 앞쪽을 차지해 '재작성 전 접두=postMainSha'인 정상 입력에서 거짓 커밋 없음+커밋 보수 경로");
{
  const crypto = require("crypto");
  const sha1s = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");
  const countM = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
  const msEq = (a, b) => { const A = countM(a), B = countM(b); if (A.size !== B.size) return false; for (const [k, v] of A) if (B.get(k) !== v) return false; return true; };
  // ① 검증자 반례: 보존군(STATE) 10,000줄 + 일반 2,001줄 — 선정 결과 out이 '재작성 전 본문의 접두'와
  //    정확히 일치하는 정상 입력. postMainSha 접두 단독 판별이면 재작성 실패 후 다음 트림이 거짓 커밋→중복.
  const ws5 = path.join(dir, "proj5");
  const rows5 = [];
  for (let i = 0; i < CL.LEDGER_EVENTS_CAP; i++) rows5.push(JSON.stringify({ ts: "k" + i, type: "superseded", sig: "d5-" + i }));
  for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT - CL.LEDGER_EVENTS_CAP + 1; i++) rows5.push(JSON.stringify({ ts: "n" + i, type: "proposed", sig: "e5-" + i, text: "N" + i }));
  fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(ws5)), { recursive: true });
  fs.writeFileSync(CL.ledgerEventsFileFor(ws5), rows5.join("\n") + "\n", "utf8");
  const af5 = CL.ledgerEventsFileFor(ws5).replace(/\.jsonl$/, "") + ".archive.jsonl";
  const evD = { ts: "y1", type: "proposed", sig: "e5-fail" };
  const origRename5 = fs.renameSync;
  fs.renameSync = () => { const e = new Error("inject-rename-fail"); e.code = "EPERM"; throw e; };
  try { ok(CL.appendLedgerEvent(ws5, evD) === true, "재작성 실패 주입 적재 성공"); } finally { fs.renameSync = origRename5; }
  {
    const a5 = fs.readFileSync(af5, "utf8").split(/\r?\n/).filter(Boolean);
    ok(a5.some((l) => l.indexOf('"type":"trim-archive"') >= 0) && !a5.some((l) => l.indexOf('"type":"trim-commit"') >= 0), "전제: 미커밋 배치+본문 미교체(접두=postMainSha 상태)");
  }
  const evE = { ts: "y2", type: "proposed", sig: "e5-next" };
  CL.appendLedgerEvent(ws5, evE);
  const a5b = fs.readFileSync(af5, "utf8").split(/\r?\n/).filter(Boolean);
  ok(!a5b.some((l) => l.indexOf('"from":"recover(커밋 보수)"') >= 0), "거짓 커밋 없음(preMainSha 우선 판별이 '미교체'를 확정)");
  ok(a5b.filter((l) => l.indexOf('"type":"trim-archive"') >= 0).length === 1, "stale 배치 절단 후 재적재 — 배치 마커 1개");
  ok(a5b.some((l) => l.indexOf('"type":"trim-commit"') >= 0), "재작성 성공 후 커밋 기록");
  const mainL5 = CL.readLedgerEventsText(ws5).split(/\r?\n/).filter(Boolean).filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const arch5 = a5b.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0);
  ok(msEq(rows5.concat([JSON.stringify(evD), JSON.stringify(evE)]), mainL5.concat(arch5)),
    `전량 다중집합 동등 — 중복 보관 없음(본문 ${mainL5.length}+아카이브 ${arch5.length})`);
  // ② 커밋 보수 경로: 본문은 재작성됐고(접두=postMainSha·pre는 불일치) 커밋 줄만 유실된 마커 →
  //    절단 금지(유일 사본)+recover(커밋 보수) 줄 보수. stale 배치 원시줄은 바이트 그대로 남아야 함.
  const ws6 = path.join(dir, "proj6");
  const rows6 = [];
  for (let i = 0; i < CL.LEDGER_EVENTS_CAP; i++) rows6.push(JSON.stringify({ ts: "k" + i, type: "superseded", sig: "d6-" + i }));
  for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT - CL.LEDGER_EVENTS_CAP + 1; i++) rows6.push(JSON.stringify({ ts: "n" + i, type: "proposed", sig: "e6-" + i, text: "M" + i }));
  fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(ws6)), { recursive: true });
  fs.writeFileSync(CL.ledgerEventsFileFor(ws6), rows6.join("\n") + "\n", "utf8");
  const af6 = CL.ledgerEventsFileFor(ws6).replace(/\.jsonl$/, "") + ".archive.jsonl";
  const shaC = "c".repeat(40);
  const staleLines = [0, 1, 2].map((i) => JSON.stringify({ ts: "s6" + i, type: "proposed", sig: "st6-" + i, text: "옛 한글 배치 " + i }));
  const mkC = JSON.stringify({ ts: "p6", type: "trim-archive", n: 3, batchSha: shaC, preLines: 13000, preMainSha: "z".repeat(40), postLines: rows6.length, postMainSha: sha1s(rows6.join("\n") + "\n"), from: "commit-lost" });
  fs.writeFileSync(af6, mkC + "\n" + staleLines.join("\n") + "\n", "utf8");
  const evF = { ts: "y3", type: "proposed", sig: "e6-new" };
  ok(CL.appendLedgerEvent(ws6, evF) === true, "적재 성공");
  const a6 = fs.readFileSync(af6, "utf8").split(/\r?\n/).filter(Boolean);
  ok(a6.some((l) => l.indexOf('"from":"recover(커밋 보수)"') >= 0 && l.indexOf(shaC) >= 0), "커밋 줄만 유실된 배치 → 절단 없이 커밋 보수");
  ok(staleLines.every((s) => a6.indexOf(s) >= 0), "유일 사본(stale 배치 원시줄 3) 바이트 그대로 보존");
  const mainL6 = CL.readLedgerEventsText(ws6).split(/\r?\n/).filter(Boolean).filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const arch6 = a6.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0 && l.indexOf('"from":"recover(커밋 보수)"') < 0 && staleLines.indexOf(l) < 0);
  ok(msEq(rows6.concat([JSON.stringify(evF)]), mainL6.concat(arch6)),
    `보수 후 신규 배치도 전량 동등(본문 ${mainL6.length}+아카이브 신규분 ${arch6.length})`);
}

console.log("[6f] R9 실행 반례 — 재작성 성공 후 이관 재복사가 잘린 원시줄을 본문에 재구성해도 nonce 증표가 '재작성됨'을 결정(절단 유실 0)");
{
  const countM = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
  const msEq = (a, b) => { const A = countM(a), B = countM(b); if (A.size !== B.size) return false; for (const [k, v] of A) if (B.get(k) !== v) return false; return true; };
  const ws7 = path.join(dir, "proj7");
  const rows7 = [];
  for (let i = 0; i < CL.LEDGER_EVENTS_CAP; i++) rows7.push(JSON.stringify({ ts: "k" + i, type: "superseded", sig: "d7-" + i }));
  for (let i = 0; i < CL.LEDGER_EVENTS_TRIM_AT - CL.LEDGER_EVENTS_CAP + 1; i++) rows7.push(JSON.stringify({ ts: "n" + i, type: "proposed", sig: "e7-" + i, text: "P" + i }));
  fs.mkdirSync(path.dirname(CL.ledgerEventsFileFor(ws7)), { recursive: true });
  fs.writeFileSync(CL.ledgerEventsFileFor(ws7), rows7.join("\n") + "\n", "utf8");
  const af7 = CL.ledgerEventsFileFor(ws7).replace(/\.jsonl$/, "") + ".archive.jsonl";
  const evG = { ts: "z1", type: "proposed", sig: "e7-last" };
  ok(CL.appendLedgerEvent(ws7, evG) === true, "정상 트림(재작성 성공·커밋 기록)");
  // 크래시 재현: 커밋 줄만 유실(재작성은 성공 — 본문에 nonce 증표 존재)
  {
    const a7 = fs.readFileSync(af7, "utf8").split(/\r?\n/).filter(Boolean);
    ok(a7[a7.length - 1].indexOf('"type":"trim-commit"') >= 0, "전제: 말미가 커밋 줄");
    fs.writeFileSync(af7, a7.slice(0, -1).join("\n") + "\n", "utf8");
  }
  // 이관기 재복사 재현: 잘린 원시줄(일반 2,001+evG)이 본문에 없다고 판단돼 그대로 재append —
  // 본문이 '보존군+재복사 원시줄' 형태로 pre를 실질 재구성(검증자 반례). 단 nonce 증표 줄은 남아 있음.
  const recopy = rows7.slice(CL.LEDGER_EVENTS_CAP).concat([JSON.stringify(evG)]);
  fs.appendFileSync(CL.ledgerEventsFileFor(ws7), recopy.join("\n") + "\n", "utf8");
  const staleMk = JSON.parse(fs.readFileSync(af7, "utf8").split(/\r?\n/).filter(Boolean).filter((l) => l.indexOf('"type":"trim-archive"') >= 0)[0]);
  ok(typeof staleMk.nonce === "string" && staleMk.nonce.length >= 16, "전제: 마커에 nonce 증표");
  // 다음 트림 → 회수: 본문 접두가 무엇으로 재구성됐든 nonce 존재=재작성 성공 → 절단 금지·커밋 보수
  const evH = { ts: "z2", type: "proposed", sig: "e7-after" };
  ok(CL.appendLedgerEvent(ws7, evH) === true, "적재 성공");
  const a7b = fs.readFileSync(af7, "utf8").split(/\r?\n/).filter(Boolean);
  ok(a7b.some((l) => l.indexOf('"from":"recover(커밋 보수)"') >= 0 && l.indexOf(staleMk.batchSha) >= 0), "nonce 증표로 재작성 성공 판별 → 절단 없이 커밋 보수");
  ok(a7b.filter((l) => l.indexOf('"type":"trim-archive"') >= 0).length === 2, "1차 배치 보존+2차 배치 적재(마커 2개 — 세대 유실 0)");
  // 전량 다중집합: 두 세대(원 발생분+재복사 발생분) 모두 보존 — 발생 횟수까지 정확히 일치
  const mainL7 = CL.readLedgerEventsText(ws7).split(/\r?\n/).filter(Boolean).filter((l) => l.indexOf('"from":"trim-compact') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const arch7 = a7b.filter((l) => l.indexOf('"type":"trim-archive"') < 0 && l.indexOf('"type":"trim-commit"') < 0 && l.indexOf('"type":"trim-rewrite"') < 0);
  const all7 = rows7.concat([JSON.stringify(evG)]).concat(recopy).concat([JSON.stringify(evH)]);
  ok(msEq(all7, mainL7.concat(arch7)), `두 세대 전량 다중집합 동등(본문 ${mainL7.length}+아카이브 ${arch7.length} — 유실·추가 0)`);
}

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
