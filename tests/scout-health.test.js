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
// v2 증거 규칙(L1-A): 구형(grade 없음 legacy) 확인은 '서로 다른 시각' 2회부터 승격 — 같은 ts 반복은 1회로 셈.
const raw1 = [
  ev("proposed", "a", { text: "src/a.ts ↔ docs/A.md" }), ev("attached", "a"), ev("attached", "a"), ev("confirmed", "a", { ts: "t1" }), ev("confirmed", "a", { ts: "t2" }), ev("confirmed", "a", { ts: "t3" }),
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
const raw2 = raw1 + "\n" + [ev("proposed", "f", { text: "f" }), ev("refuted", "f"), ev("confirmed", "f", { ts: "t1" }), ev("confirmed", "f", { ts: "t2" })].join("\n"); // 반박 후 서로 다른 시각 legacy 확인 2회 → 복권
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
ok(/양방향/.test(full) && /안전 보장이 아니다/.test(full) && /독립 확인/.test(full) && !/유용성은 더 높/.test(full), "상시 한계 문구 — 편향 양방향(반박 과소·노출 확인 과대) 정직화, '보수 단방향' 주장 제거(논리 점검 #8 잠금)");
ok(!/정확도/.test(full) && !(/accuracy/.test(CL.scoutHealthLine(repo, true) || "")), "'정확도/accuracy' 용어 금지(관찰 신호로만)");
const en = CL.scoutHealthLine(repo, true);
ok(!!en && /Scout observation signal/.test(en) && /manually recorded/.test(en) && /both ways/.test(en) && !/usefulness may be higher/.test(en), "영문 동등 품질 — 양방향 편향 문구 포함·옛 단방향 주장 제거(Codex 반례 잠금)");

console.log("[attach 배선] 지도 동봉 꼬리에 신호 줄 — 실패해도 지도 동봉 불침(소스 계약)");
const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
ok(/scoutHealthLine\(target, en\)/.test(src) && /health \? \[health\] : \[\]/.test(src), "buildScoutAttach가 target(정찰 대상) 기준으로 신호 줄 첨부");
ok(/신호 실패가 지도 동봉을 막지 않음/.test(src), "실패 격리 주석·catch");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/health: computeScoutHealth\(derived\)/.test(ext) && /관찰 신호/.test(ext) && /표본 아직 작음/.test(ext) && /양방향일 수 있어요/.test(ext) && !/보수 집계라 실제 유용성/.test(ext), "대시보드 관찰 일지 카드 신호 — 지표 칩 행+편향 툴팁(2026-07-20 문장 나열→칩 개정·표본 게이트 유지)");

console.log("[건강 리포트 새탭] 대시보드 포화 대응(2026-07-09 사용자 지시) — 스크립트 없음·열 때 베이크·동적 데이터 esc");
const repStart = ext.indexOf("function openScoutHealthReport");
ok(repStart > -1, "openScoutHealthReport 존재");
const rep = ext.slice(repStart, repStart + 24000);
ok(rep.includes("enableScripts: false") && rep.includes("default-src 'none'"), "새탭 — 스크립트 원천 차단(openReconGuide와 동일 안전 패턴)");
ok(rep.includes("readMapLedgerUncached(ws)"), "열 때 캐시(5초) 우회 판독 — '열 때 기준' 문구가 거짓이 안 됨(Codex 사전검증 권고)");
ok(/esc\(target\)/.test(rep) && /esc\(it\.text\)/.test(rep) && /esc\(it\.type\)/.test(rep), "동적 데이터(경로·타임라인 원문) esc 이스케이프 — 정적 안내탭과 달리 필수");
ok(rep.includes("HEALTH_MIN_SAMPLE"), "표본 게이트 상수 공유 — ask 동봉·대시보드 줄과 같은 기준(항목<5 비율 무주장)");
ok(ext.includes('type:"openScoutHealthReport"') && ext.includes('m?.type === "openScoutHealthReport"'), "관찰 일지 카드 버튼 → 핸들러 배선");

console.log("[역할 명시(2026-07-09 사용자 지적 2)] 리포트에 '어디서 생기고 어디에 반영되나' 구조 + '고정값 아님' 차별점");
ok(rep.includes("관찰 신호의 역할") && rep.includes("role of observation signals"), "역할 섹션 제목(한/영 쌍)");
ok(rep.includes("1. 감지") && rep.includes("2. 기록") && rep.includes("3. 해석") && rep.includes("4. 반영"), "감지→기록→해석→반영 4단 흐름 카드");
ok(rep.includes("고정값이 아니라 따라가는 값") && rep.includes("관측치") && !/스스로 좁혀/.test(rep), "차별점 — 관측치임을 명시(자기학습 제어 장치 과장 제거 — 논리 점검 #9 잠금)");
ok(rep.includes("셋은 그 순간 장부에서 새로 계산") && rep.includes("짧은 캐시로 따라잡음") && !/넷 다 그 순간/.test(rep) && !/언어별로 따로 쌓/.test(rep), "반영 4곳 실시간성 정확 서술 — 대시보드 1줄은 5초 캐시 경유라 '넷 다 즉시' 과장 금지(Codex 반례 잠금) · 장부가 언어별 분리라는 과잉 주장 없음(일지는 프로젝트별 단일 — 언어 슬롯 분리는 설정 쪽)");
ok(ext.includes("신호의 역할·수치의 뜻"), "대시보드 버튼 라벨에 '신호의 역할' 명시");

console.log("[④줄 ✓ + ping 전환 게이트(2026-07-09 사용자 지적 1·3)]");
ok(/if \(on\) setStage\(row, true,/.test(ext), "④ 정찰 기본 원칙 줄 — 3트랙이면 ①~③과 같은 ✓ 마크(setStage 미호출 누락 수정)");
ok(/prevScoutOn/.test(ext) && /&& !prevScoutOn/.test(ext), "3트랙 안내·연결 점검(ping)은 꺼짐→켜짐 전환에만 — '켤 때 1회' 라벨과 실동작 일치(매 저장 중복 ping 교정)");

console.log("[게이트 연동] 실효 게이트 동형+대시보드 고지 — '카드와 한 묶음' 사용자 조건");
ok(/function effectiveScoutGate/.test(ext) && /normScoutMode\(o\) !== "on"/.test(ext), "확장 실효 게이트 — bridge normScoutGate와 동일 규칙(2트랙 선조건)");
const ctBlock = ext.slice(ext.indexOf("interface Contract"), ext.indexOf("}", ext.indexOf("interface Contract")));
ok(!/scoutGate/.test(ctBlock), "Contract 스키마에 scoutGate 없음 — saveContract가 기본값을 명시값으로 굳히는 오염 방지(보존 병합만·표시는 effectiveScoutGate)");
ok(ext.includes("플랜 게이트: 켜짐(3트랙 기본)") && ext.includes("플랜 게이트: 꺼짐(직접 끄심)"), "대시보드 게이트 상태 줄 — 기본/직접 구분(informed consent)");
const gateSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "scout-gate.js"), "utf8");
ok(/scoutHealthLine\(target, loadLang\(\) === "en"\)/.test(gateSrc) && /신호 실패 무해/.test(gateSrc), "차단 문구에 관찰 신호 인용 + 실패 격리(신호 실패가 차단 문구를 못 막음)");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
