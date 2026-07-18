"use strict";
/*
 * P-6b ③ fallback↔훅 경합(설계 확인 4왕복 동결) — '테스트로 노출 후 처리' 계약.
 * 경합: 다른 세션 첫 프롬프트에서 확장 fallback이 먼저 교체 기록(eventAt=rollout promptTs)하면 늦게 재개된
 * 훅의 CAS(currentEventAt>expectedEventAt)가 implementer-raced로 정당한 첫 프롬프트를 차단.
 * 해소: 동일 턴 한정 인계(auto-pin 출처+turnHint 일치 시만 합류·eventAt=훅 anchor)+힌트 수명주기(N+1 교체·
 * 훅 성공 시 소거)+확장 위생 게이트(훅 흔적=지연·침묵 20초 grace — 정확성 아닌 빈도 축소).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "p6br_"));
process.env.CODEX_BRIDGE_HOME = H;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const AP = require(path.join(ROOT, "out", "implementer-auto-pin.js")); // npm test compile 산출물 — 단독 실행 시 npm run compile 선행

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const WS = path.join(H, "proj");
fs.mkdirSync(WS, { recursive: true });
const LINKS = path.join(H, "links.json");
const writeLinks = (rec, roleRev) => fs.writeFileSync(LINKS, JSON.stringify({ byWorkspace: { [WS]: { workspace: WS, ...rec } }, roleRevision: roleRev }, null, 2));
const readRec = () => JSON.parse(fs.readFileSync(LINKS, "utf8")).byWorkspace[Object.keys(JSON.parse(fs.readFileSync(LINKS, "utf8")).byWorkspace)[0]];
// fallback이 S1→S2 교체를 먼저 기록한 상태(훅 스냅샷은 그 '전' S1 기준): eventAt=rollout promptTs(2000)>훅 anchor(1500)
const fallbackState = () => writeLinks({ implementerSession: "S2", implementerRevision: 6, implementerEventAt: 2000, implementerLastSeenAt: "2026-07-19T10:00:02.000Z", implementerLinkSource: "rollout-user-prompt", implementerTurnHint: "T1" }, 8);
const hookSnapshot = { session: "S1", revision: 6, roleRevision: 8, eventStartedAt: 1500 }; // fallback 이전에 잡힌 스냅샷(같은 턴의 훅 — P-6b 실측: 훅 턴 기록이 rollout ts보다 선행)

console.log("[1] 경합 노출 — turnId 미전달(구경로) 훅은 fallback 선기록에 raced(eventAt 축)");
{
  fallbackState();
  const r = CL.registerCodexImplementer(WS, "S2", "m", "e", hookSnapshot);
  ok(!r.ok && r.reason === "implementer-raced", "fallback eventAt(2000)>훅 anchor(1500) — 정당한 첫 프롬프트 차단 실체(현행 경합 노출): " + r.reason);
}

console.log("[2] 동일 턴 인계 — turnId 일치 훅은 합류·eventAt=훅 anchor·출처 승격·힌트 소거");
{
  fallbackState();
  const r = CL.registerCodexImplementer(WS, "S2", "m", "e", hookSnapshot, "T1");
  const rec = readRec();
  ok(r.ok === true, "합류 성공(raced 아님 — 20초+ 늦은 재개도 턴 결속으로 동일): " + (r.reason || ""));
  ok(rec.implementerEventAt === 1500, "eventAt=훅 자신의 anchor(1500 — fallback rollout ts 2000이 max로 살아남지 않음: turn-before-link ms 역전 차단)");
  ok(rec.implementerLinkSource === "hook" && !("implementerTurnHint" in rec), "출처 'hook' 승격+턴 힌트 소거(1회성 인계)");
  ok(rec.implementerRevision === 7, "합류도 정상 등록(revision 전진 — 기존 훅 계약)");
}

console.log("[3] 같은 세션 '다른 턴' 훅 — 예외 불성립·기존 역행 보호 유지");
{
  fallbackState();
  const r = CL.registerCodexImplementer(WS, "S2", "m", "e", hookSnapshot, "T0");
  ok(!r.ok && r.reason === "implementer-raced", "지연된 옛 턴(T0) 훅 — eventAt 후행 거부 유지(시간 역행 보호)");
}

console.log("[4] 힌트 수명주기 — N+1 관측=힌트 교체(세대 불변) → 늦은 N 거부·N+1 합류");
{
  fallbackState();
  const cur = readRec();
  const upd = AP.applyAutoPinUpdate(cur, { id: "S2", promptTs: "2026-07-19T10:00:05.000Z", turnId: "T2" }); // 같은 세션 더 새 프롬프트(N+1)
  ok(upd.generationAdvanced === false && upd.next.implementerTurnHint === "T2" && upd.next.implementerRevision === 6 && upd.next.implementerEventAt === 2000, "같은 세션 N+1 관측 — 세대·eventAt 불변·힌트만 T2로(4차 ⑴)");
  writeLinks({ ...upd.next }, 8);
  let r = CL.registerCodexImplementer(WS, "S2", "m", "e", hookSnapshot, "T1");
  ok(!r.ok && r.reason === "implementer-raced", "늦은 N(T1) 훅 — 힌트 불일치로 거부(예외 재사용 차단)");
  r = CL.registerCodexImplementer(WS, "S2", "m", "e", hookSnapshot, "T2");
  ok(r.ok === true && readRec().implementerLinkSource === "hook", "N+1(T2) 훅 — 합류(완료 순서 역전에서 N 거부·N+1 보존)");
}

console.log("[5] 인계 소거 후 — 늦은 옛 훅이 예외를 재사용하지 못함");
{
  // [4] 종료 상태: source=hook·힌트 없음·eventAt=1500. 더 옛 anchor(1400)의 지각 훅:
  const r = CL.registerCodexImplementer(WS, "S2", "m", "e", { session: "S2", revision: readRec().implementerRevision, roleRevision: 9, eventStartedAt: 1400 }, "T1");
  ok(!r.ok && r.reason === "implementer-raced", "소거 후 옛 턴 훅 — 힌트 부재=예외 불성립·기존 CAS 거부");
}

console.log("[6] 다른 세션 보호 불변 — turnId가 있어도 예외는 같은 세션만");
{
  fallbackState();
  const r = CL.registerCodexImplementer(WS, "S3", "m", "e", hookSnapshot, "T1");
  ok(!r.ok && r.reason === "implementer-raced", "다른 세션(S3) — 스냅샷 불일치 거부 유지(예외 무관)");
}

console.log("[7] 확장 위생 게이트 — 훅 흔적=지연·침묵 20초 grace·그 외 허용");
{
  const G = AP.autoPinReplacementReady, NOW = 100000, T = 70000;
  ok(G(T, null, NOW) === true, "훅 흔적 없음+30초 경과 — 안전망 허용");
  ok(G(NOW - 5000, null, NOW) === false, "흔적 없음+5초 — 지연(훅 기회)");
  ok(G(T, T + 100, NOW) === false, "훅 흔적이 프롬프트 이후 — 영구 지연(pin은 훅 몫)");
  ok(G(T, T - 60000, NOW) === true, "훅 흔적이 프롬프트보다 과거(이전 턴) — grace 경과 시 허용(훅 침묵 판단)");
  ok(G(0, null, NOW) === false, "프롬프트 시각 불명 — 불허(보수)");
  ok(typeof AP.AUTO_PIN_HOOK_GRACE_MS === "number" && AP.AUTO_PIN_HOOK_GRACE_MS === 20000, "grace 정책값 20초 명시");
  ok(G(NOW - 20000, null, NOW) === true && G(NOW - 19999, null, NOW) === false, "경계값 — 정확히 20초=허용·미만=지연");
  // 1차 B1 — 훅 흔적의 프로젝트·세션 귀속 결속(타 프로젝트 heartbeat로 안전망 영구 지연 차단)
  const HT = AP.hookActiveTsForGate, nw = (p) => String(p || "").toLowerCase();
  ok(HT({ codexSession: "S2", workspace: "/a", ts: "2026-07-19T10:00:00.000Z" }, "S2", "/a", nw) !== null, "이 프로젝트·이 세션 기록 — 인정");
  ok(HT({ codexSession: "S2", workspace: "/b", ts: "2026-07-19T10:00:00.000Z" }, "S2", "/a", nw) === null, "같은 세션·타 프로젝트 heartbeat — 불인정(안전망 영구 지연 차단·프로젝트 분리)");
  ok(HT({ codexSession: "S9", workspace: "/a", ts: "2026-07-19T10:00:00.000Z" }, "S2", "/a", nw) === null && HT(null, "S2", "/a", nw) === null && HT({ codexSession: "S2", workspace: "/a", ts: "bad" }, "S2", "/a", nw) === null, "타 세션·부재·시각 불명 — 불인정");
}

console.log("[7b] 연결 제거 실행 — 출처·턴 힌트 포함 잔존 0(수명주기 ⑸·1차 B2·2차 blocker: 실행 증명)");
{
  // 공용 정본 함수를 '실행' — auto-pin 출처·턴 힌트가 있는 구현 연결 레코드에서 전 구현자 필드 소거·비구현자 보존.
  const rec = { workspace: "/a", codexSession: "V1", linkedAt: "t", implementerSession: "S2", implementerLinkedAt: "t1", implementerLastSeenAt: "t2", implementerRevision: 6, implementerEventAt: 2000, implementerModel: "m", implementerEffort: "e", implementerLinkSource: "rollout-user-prompt", implementerTurnHint: "T1" };
  AP.clearImplementerLinkFields(rec);
  ok(!("implementerLinkSource" in rec) && !("implementerTurnHint" in rec) && !("implementerSession" in rec) && !("implementerRevision" in rec) && !("implementerEventAt" in rec), "해제 실행 — 출처·힌트·세대 전부 소거(고아 메타 0)");
  ok(rec.codexSession === "V1" && rec.workspace === "/a" && rec.linkedAt === "t", "비구현자 필드(검증 연결 등) — 불변");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok((ext.match(/if\(cur\.implementerSession===id\)\{clearImplementerLinkFields\(cur\);\}/g) || []).length === 2, "해제 경로 2곳(워크스페이스 한정+전역) 모두 공용 정본 함수 호출(중복 목록 드리프트 차단)");
}

console.log("[8] 배선 — 확장 게이트·훅 turnId 전달·필드 계약");
{
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/if \(best\.id !== String\(before\.implementerSession \|\| ""\)\) \{/.test(ext) && /autoPinReplacementReady\(Date\.parse\(best\.promptTs \|\| ""\) \|\| 0, hookTs, Date\.now\(\)\)/.test(ext), "확장 — '다른 세션 교체'에만 위생 게이트(같은 세션 관측은 무관)");
  ok(/hookActiveTsForGate\(bridgeLib\(\)\?\.readCodexActive\?\.\(best\.id\), best\.id, ws, normWs\)/.test(ext), "게이트 훅 흔적 소스 — 후보 세션 codex-active를 세션·프로젝트 결속 판독으로만(1차 B1)");
  const hk = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  ok(/registerCodexImplementer\(ws, sid, j\.model \|\| "", effort, expectedSession, turnId\)/.test(hk), "훅 — turnId 전달(동일 턴 인계 재료)");
  const ap = fs.readFileSync(path.join(ROOT, "src", "implementer-auto-pin.ts"), "utf8");
  ok(/implementerTurnHint: best\.turnId \|\| ""/.test(ap) && /cur\.implementerLinkSource === "rollout-user-prompt" && best\.turnId\) next\.implementerTurnHint = best\.turnId;/.test(ap), "auto-pin — 교체 시 힌트 기록·같은 세션 N+1 관측 시 힌트 교체");
  const cl = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  ok(/const sameTurnJoin = enforceCas && currentSession === sessionId/.test(cl) && /next\.implementerLinkSource = "hook";\s*\n\s*delete next\.implementerTurnHint;/.test(cl), "브릿지 — 동일 턴 한정 예외+성공 시 승격·소거");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
