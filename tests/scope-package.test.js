/*
 * 자료 패키지 빌더(src/scope-package.ts → out/scope-package.js) — Phase 1 결정론 꾸러미.
 * 핵심 계약: ①diff 토큰 추출이 채널/사본 결합의 씨앗이 됨(하드코딩 0) ②캡 초과는 '절단 고지'로 정직
 * ③'이 꾸러미가 못 보는 것' 각주가 항상 포함 ④렌더에 판정 금지·경로만 지시가 들어감(SCOUT-TRACK §5와 짝).
 * ※ out/*.js는 npm test의 tsc 산출물.
 */
const path = require("path");
const { extractDiffTokens, buildPackage, renderPackageMarkdown, PKG_DEFAULTS } = require(path.join(__dirname, "..", "out", "scope-package.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[extractDiffTokens] +/- 줄의 식별자만 · 불용어/짧은 것/헤더 제외 · 빈도순");
const diff = [
  "--- a/bridge/codex-bridge.js",
  "+++ b/bridge/codex-bridge.js",
  "@@ -1,3 +1,4 @@",
  "+function writeProof(sessionId) {",
  "+  const proofPayload = buildProofPayload(sessionId);",
  "-  return oldWriteProof(sessionId);",
  " context line writeProof untouched", // 컨텍스트 줄(+/- 아님) — 무시
  "+  if (true) return proofPayload;",
].join("\n");
const tk = extractDiffTokens(diff);
const names = tk.map((t) => t.token);
ok(names.includes("writeProof") && names.includes("proofPayload") && names.includes("sessionId"), "바뀐 식별자 추출(writeProof·proofPayload·sessionId)");
ok(!names.includes("function") && !names.includes("const") && !names.includes("return") && !names.includes("true"), "예약어/불용어 제외(범주 필터 — 도메인 단어는 유지)");
ok(tk.find((t) => t.token === "sessionId").count === 3, "빈도 집계(+/- 줄만: sessionId 3회 — 컨텍스트 줄 미집계)");
ok(!names.includes("a"), "짧은 토큰(<4자) 제외");
const many = extractDiffTokens(Array.from({ length: 100 }, (_, i) => `+ tokenName${i} tokenName${i}`).join("\n"));
ok(many.length === PKG_DEFAULTS.maxTokens, "토큰 상한(빈도순 상위만)");

console.log("[buildPackage] 캡 초과=절단 고지 · 정직성 각주 상시 포함");
const base = { repo: "D:/r", head: "abcdef1234567", seeds: ["src/a.ts"], diffText: "x".repeat(25000), tokenHits: [], coChange: null, tests: ["npm test"], recentFailures: Array.from({ length: 12 }, (_, i) => ({ ts: "t" + i, kind: "verify-incomplete", detail: "d" })), mapContent: null };
const p = buildPackage(base);
ok(p.diff.length === PKG_DEFAULTS.maxDiffChars && p.meta.truncations.some((t) => /diff/.test(t)), "diff 캡 + 절단 고지");
ok(p.recentFailures.length === PKG_DEFAULTS.maxFailures && p.meta.truncations.some((t) => /실패/.test(t)), "실패 기록 캡 + 고지");
ok(p.blindSpots.length >= 4 && p.blindSpots.some((b) => /MAP이 없다/.test(b)), "각주 4종 + MAP 부재 명시(맹점 은폐 금지)");
const p2 = buildPackage({ ...base, diffText: "짧음", recentFailures: [], mapContent: "# MAP" });
ok(p2.meta.truncations.length === 0 && !p2.blindSpots.some((b) => /MAP이 없다/.test(b)), "캡 미달=고지 없음 · MAP 있으면 부재 문구 없음");

console.log("[renderPackageMarkdown] 섹션 구조 + 탐색자 지시(판정 금지·경로만) + high 상한");
const md = renderPackageMarkdown(buildPackage({ ...base, diffText: "+ writeProof", tokenHits: [{ token: "writeProof", files: ["bridge/verify-guard.js"], truncated: false }], coChange: { candidates: [{ file: "tests/a.test.js", n: 4, score: 1, lastTs: 0 }], seedObservations: 5, sparse: false }, recentFailures: [{ ts: "t", kind: "verify-incomplete", detail: "미완" }] }));
ok(/## 1\. 지금 바뀌는 파일/.test(md) && /## 3\./.test(md) && /## 4\./.test(md) && /## 5\./.test(md) && /## 6\./.test(md), "6개 섹션 렌더");
ok(/`writeProof` → bridge\/verify-guard\.js/.test(md), "토큰 역참조가 파일채널 결합(writeProof→verify-guard)을 드러냄");
ok(/함께 변경 4회/.test(md), "co-change 통계 표기");
ok(/판정 금지/.test(md) && /수정 지시 금지/.test(md) && /high 최대 5/.test(md), "탐색자 지시: 판정·수정 금지 + high/전체 상한(SCOUT-TRACK §5)");
ok(/⑥MAP patch 후보/.test(md) && /제안일 뿐/.test(md), "지시 6항목에 MAP patch 후보 포함(§5 스키마 완전 일치 — reconcile 축 누락 방지)");
ok(/이 꾸러미가 못 보는 것/.test(md), "정직성 각주 섹션 필수 포함");
ok(/untracked/.test(md), "각주에 'tracked 한정 grep — 새 파일 참조 누락 가능' 명시(과소보고 위험 은폐 금지)");
const mdSparse = renderPackageMarkdown(buildPackage({ ...base, diffText: "d", recentFailures: [], coChange: { candidates: [], seedObservations: 1, sparse: true } }));
ok(/표본 부족.*침묵/.test(mdSparse), "co-change 표본 부족 → '침묵' 정직 표기");

console.log("[편재 토큰 제외] 어디에나 있는 말은 결합 증거가 아님 — 실측(참조 수) 기준 제외 + 정직 표기");
const mdDrop = renderPackageMarkdown(buildPackage({ ...base, diffText: "d", recentFailures: [], droppedTokens: ["test", "node"] }));
ok(/제외된 편재 토큰.*test, node/.test(mdDrop), "제외 목록이 꾸러미에 표기(은폐 없음)");
ok(!/`test` →/.test(mdDrop), "제외 토큰은 역참조 목록에 없음");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
