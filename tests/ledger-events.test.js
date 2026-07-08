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
e = D([ev("proposed", "a", { text: "A ↔ B" }), ev("confirmed", "a")])[0];
ok(e.status === "verified" && e.lane === "trusted", "확인 1회 → 검증됨(신뢰 차선) — v1 최약 임계");
e = D([ev("proposed", "a", { text: "A" }), ev("confirmed", "a"), ev("user_dispute", "a")])[0];
ok(e.status === "disputed" && e.lane === "excluded", "확인 있어도 반박 오면 강등(반박된 지식은 권위 차선 밖 — tg 정책)");
e = D([ev("proposed", "a", { text: "A" }), ev("user_dispute", "a"), ev("pinned", "a")])[0];
ok(e.status === "disputed" && e.pinned && e.lane === "trusted", "사람 고정(pin)은 반박보다 위 — 차선만 신뢰로(상태는 정직하게 disputed 유지)");
e = D([ev("proposed", "a", { text: "A" }), ev("pinned", "a"), ev("unpinned", "a")])[0];
ok(!e.pinned && e.lane === "reference", "고정 후 해제 → 순 계산(net)으로 원복");
console.log("[2-1] 복권(rehab) — 반박 '이후' 확인만 인정: 사람 1회 / 검증 2회 · 차단은 복권 불가");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r")])[0];
ok(e.status === "disputed" && !e.rehabilitated, "반박 후 검증 확인 1회 → 아직 disputed(기계 확인은 2회 필요)");
e = D([ev("proposed", "r", { text: "R" }), ev("user_dispute", "r"), ev("confirmed", "r"), ev("confirmed", "r")])[0];
ok(e.status === "verified" && e.rehabilitated === true && e.lane === "trusted", "반박 후 검증 확인 2회 → 복권(verified·신뢰 차선·rehabilitated 표기)");
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
const mk = (i, extra) => LE.deriveLedger(LE.parseEventsJsonl([ev("proposed", "s" + i, { text: extra }), ev("confirmed", "s" + i)].join("\n")).events)[0];
const entries = [];
for (let i = 0; i < 12; i++) entries.push(mk(i, i === 11 ? "scripts/scope-package.js ↔ tests/scope-package.test.js — 결합" : "etc" + i + "/file" + i + ".ts ↔ other — 결합"));
const sel = LE.selectForPackage(entries, ["scripts/scope-package.js"]);
ok(sel.trusted.length === 8, `신뢰 상한 8 (실제 ${sel.trusted.length})`);
ok(sel.trusted[0].text.includes("scope-package"), "씨앗과 겹치는 항목이 상한 안에서 최우선");
const disputedEntry = D([ev("proposed", "d1", { text: "D ↔ X" }), ev("user_dispute", "d1")])[0];
const pinnedDisputed = D([ev("proposed", "d2", { text: "D2 ↔ X" }), ev("user_dispute", "d2"), ev("pinned", "d2")])[0];
const sel2 = LE.selectForPackage([disputedEntry, pinnedDisputed], []);
ok(sel2.disputed.length === 1 && sel2.disputed[0].sig === "d1" && sel2.trusted.some((x) => x.sig === "d2"), "틀림판명 각주엔 비고정 반박분만 — 고정분은 신뢰 차선으로");

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
