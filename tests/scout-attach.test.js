"use strict";
/*
 * Phase 3 테스트 — 지도 high 항목 구조화(extractMapHighlights) + 검증 요청 동봉(buildScoutAttach·withContract 통합).
 * node tests/scout-attach.test.js. CODEX_BRIDGE_HOME을 require 전에 임시폴더로 → 실사용 브릿지 홈 오염 없음.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa_"));
process.env.CODEX_BRIDGE_HOME = dir;
delete process.env.CLAUDE_PROJECT_DIR;

const { extractMapHighlights, buildScoutAttach, wsKeyFor, contractFileFor } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const { withContract } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] extractMapHighlights — ①~④의 high만, ⑤⑥ 제외, medium 제외, 버전숫자 오인 없음");
const MAP = [
  "# 영향범위 지도",
  "① 직접 영향 후보",
  "- `src/extension.ts` — 대시보드 카드 렌더 (high)",
  "- scripts/scout-store.js — 저장 규칙 (medium)",
  "② 간접 영향 후보",
  "- bridge/contract-lib.js (high) 훅 주입부",
  "- 버전 0.1.86 기준 (high)",
  "③ 반드시 확인할 테스트/동작",
  "- tests/scout-store.test.js — high",
  "④ 문서/설정/UI 영향",
  "- package.json — test 체인 (HIGH)",
  "⑤ 범위 밖으로 봐도 되는 것",
  "- docs/README.en.md (high — 무관)",
  "⑥ MAP patch 후보",
  "- a/b.ts ↔ c/d.ts (high)",
].join("\n");
const items = extractMapHighlights(MAP);
const paths = items.map((i) => i.path);
ok(paths.includes("src/extension.ts"), "① high 경로 추출(백틱 제거)");
ok(!paths.includes("scripts/scout-store.js"), "medium은 제외");
ok(paths.includes("bridge/contract-lib.js"), "② high 추출");
ok(paths.includes("tests/scout-store.test.js"), "③ high 추출");
ok(paths.includes("package.json"), "④ 단일 파일명(HIGH 대문자) 추출");
ok(!paths.some((p) => /README\.en\.md/i.test(p)), "⑤ 범위밖은 high여도 제외");
ok(!paths.some((p) => p.includes("a/b.ts") || p.includes("c/d.ts")), "⑥ MAP patch는 제외");
ok(!paths.some((p) => /^0\.1/.test(p)), "버전 숫자(0.1.86)를 경로로 오인하지 않음");

console.log("[1b] 구획 게이트 반례(Codex 지적 잠금) — 진입 전·미지 구획 제외, 자유서식 폴백, 한글 조사, 긴 줄 성능");
const preSection = extractMapHighlights("- stray/file.ts (high) before any section\n① 직접 영향 후보\n- src/real.ts (high)");
ok(!preSection.some((i) => i.path.includes("stray")) && preSection.some((i) => i.path === "src/real.ts"), "①~④ 진입 전 high는 제외(구획 있는 지도)");
const unknownSec = extractMapHighlights("① 직접\n- src/a.ts (high)\n⑦ 기타 의견\n- src/b.ts (high)");
ok(unknownSec.some((i) => i.path === "src/a.ts") && !unknownSec.some((i) => i.path === "src/b.ts"), "미지 구획(⑦)의 high는 제외");
const freeform = extractMapHighlights("확인 필요 목록\n- src/free.ts — 핵심 (high)\n- src/skip.ts (medium)");
ok(freeform.length === 1 && freeform[0].path === "src/free.ts", "구획 표기 없는 자유서식 → 전체 허용 폴백으로 추출");
const korean = extractMapHighlights("① 직접\n- src/extension.ts를 반드시 확인 (high)");
ok(korean.some((i) => i.path === "src/extension.ts"), "한글 조사 접미(...ts를) 제거 후 경로 추출");
const mixedLine = extractMapHighlights("① 후보 ⑤ 범위 밖 — bad/mix.ts (high)\n① 직접\n- src/after.ts (high)");
ok(!mixedLine.some((i) => i.path.includes("mix")) && mixedLine.some((i) => i.path === "src/after.ts"), "한 줄에 ①+⑤ 동시 등장 → 제외 우선, 다음 ①에서 재허용");
const freeformScope = extractMapHighlights("out of scope: old/gone.ts (high)\n- src/yes.ts (high)");
ok(!freeformScope.some((i) => i.path.includes("gone")) && freeformScope.some((i) => i.path === "src/yes.ts"), "자유서식 '범위 밖' 문구는 그 줄만 제외(고착 없음)");
const longLine = "① 직접\n- " + "x".repeat(50000) + " src/long.ts (high)";
const t0 = Date.now();
extractMapHighlights(longLine);
const elapsed = Date.now() - t0;
ok(elapsed < 2000, `5만자 한 줄 파싱이 폭주하지 않음(실측 ${elapsed}ms — 종전 백트래킹 3.4s 재발 방지)`);

console.log("[2] 상한·중복 제거");
const many = "① 직접\n" + Array.from({ length: 12 }, (_, i) => `- src/f${i}.ts (high)`).join("\n") + "\n- src/f0.ts (high)";
const capped = extractMapHighlights(many);
ok(capped.length === 8, `12+중복1 → 상한 8 (실제 ${capped.length})`);
ok(new Set(capped.map((i) => i.path)).size === capped.length, "중복 경로 없음");

console.log("[3] buildScoutAttach — 게이트(2트랙/지도없음/high없음=null) · 동봉 본문 · 낡음 라벨");
const ws = path.join(dir, "proj");
fs.mkdirSync(ws, { recursive: true });
ok(buildScoutAttach(ws, { scoutMode: "on" }) === null, "지도 없음 → null");
ok(buildScoutAttach(ws, { scoutMode: "off" }) === null, "2트랙(off) → null");
const mapsDir = path.join(dir, "scouts", wsKeyFor(ws));
fs.mkdirSync(mapsDir, { recursive: true });
const base = "2026-07-07T00-00-00-000Z-00-self";
fs.writeFileSync(path.join(mapsDir, base + ".md"), MAP);
fs.writeFileSync(path.join(mapsDir, base + ".json"), JSON.stringify({ ts: "2026-07-07T00:00:00.000Z", arm: "self", seedFiles: [] }));
const att = buildScoutAttach(ws, { scoutMode: "on" }, "ko");
ok(att && att.includes("[탐색 지도"), "3트랙+지도 → 동봉 블록 생성");
ok(att.includes("src/extension.ts") && att.includes("package.json"), "high 경로들이 본문에 포함");
ok(att.includes("판정 기준"), "advisory 명시(판정 기준 아님)");
ok(!att.includes("낡음"), "seed 변경 없음 → 낡음 라벨 없음");
// 낡음: 지도 생성(명백한 과거 ts — 시간대 무관) 후 seed 파일이 더 바뀐 상황
fs.writeFileSync(path.join(ws, "x.js"), "changed");
fs.writeFileSync(path.join(mapsDir, base + ".json"), JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", arm: "self", seedFiles: ["x.js"] }));
const attStale = buildScoutAttach(ws, { scoutMode: "on" }, "ko");
ok(attStale && attStale.includes("낡음"), "낡은 지도 → 버리지 않고 낡음 라벨로 고지");
const attEn = buildScoutAttach(ws, { scoutMode: "on" }, "en");
ok(attEn && attEn.includes("Scout impact map") && attEn.includes("STALE"), "영문 스냅샷 → 영문 블록(한/영 쌍)");

console.log("[4] 저장된 구조화 계층(meta.highlights) 우선");
fs.writeFileSync(path.join(mapsDir, base + ".json"), JSON.stringify({ ts: "2026-07-07T00:00:00.000Z", arm: "self", seedFiles: [], highlights: [{ path: "STORED_MARK.ts", note: "저장분" }] }));
const attStored = buildScoutAttach(ws, { scoutMode: "on" }, "ko");
ok(attStored.includes("STORED_MARK.ts") && !attStored.includes("src/extension.ts"), "meta.highlights 있으면 md 재파싱 대신 저장분 사용");

console.log("[4b] 깨진 메타([null]) 방어 — 크래시 없이 md 재파싱 폴백");
fs.writeFileSync(path.join(mapsDir, base + ".json"), JSON.stringify({ ts: "2026-07-07T00:00:00.000Z", arm: "self", seedFiles: [], highlights: [null, { note: "path 없음" }] }));
const attBroken = buildScoutAttach(ws, { scoutMode: "on" }, "ko");
ok(attBroken && attBroken.includes("src/extension.ts"), "highlights가 [null,...]이어도 크래시 없이 md에서 재추출");

console.log("[5] high 항목 0개면 동봉 안 함(주입 비용 0)");
const base2 = "2026-07-08T00-00-00-000Z-00-self"; // 이름 정렬상 최신
fs.writeFileSync(path.join(mapsDir, base2 + ".md"), "① 직접 영향 후보\n- src/only-medium.ts (medium)");
fs.writeFileSync(path.join(mapsDir, base2 + ".json"), JSON.stringify({ ts: "2026-07-08T00:00:00.000Z", arm: "self", seedFiles: [] }));
ok(buildScoutAttach(ws, { scoutMode: "on" }) === null, "high 0개 → null");

console.log("[6] withContract 통합 — 3트랙 계약이면 ask 본문에 동봉, 기본(2트랙)이면 무회귀");
fs.writeFileSync(path.join(mapsDir, base2 + ".md"), MAP); // 최신 지도에 high 복원
fs.mkdirSync(path.dirname(contractFileFor(ws)), { recursive: true });
fs.writeFileSync(contractFileFor(ws), JSON.stringify({ codex: [], verifyMode: "off", scoutMode: "on" }));
const out3 = withContract("MY_PROMPT", ws);
ok(out3.includes("[탐색 지도") && out3.includes("src/extension.ts"), "3트랙 → ask 프롬프트에 지도 high 동봉");
ok(out3.indexOf("[탐색 지도") < out3.indexOf("MY_PROMPT"), "동봉은 [작업 요청] 앞(지침부)에 위치");
const ws2 = path.join(dir, "proj2");
fs.mkdirSync(ws2, { recursive: true });
fs.writeFileSync(contractFileFor(ws2), JSON.stringify({ codex: [], verifyMode: "off" }));
ok(!withContract("MY_PROMPT", ws2).includes("[탐색 지도"), "scoutMode 미설정(2트랙 기본) → 동봉 없음(무회귀)");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시폴더 정리 실패 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
