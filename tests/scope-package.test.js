/*
 * 자료 패키지 빌더(src/scope-package.ts → out/scope-package.js) — Phase 1 결정론 꾸러미.
 * 핵심 계약: ①diff 토큰 추출이 채널/사본 결합의 씨앗이 됨(하드코딩 0) ②캡 초과는 '절단 고지'로 정직
 * ③'이 꾸러미가 못 보는 것' 각주가 항상 포함 ④렌더에 판정 금지·경로만 지시가 들어감(SCOUT-TRACK §5와 짝).
 * ※ out/*.js는 npm test의 tsc 산출물.
 */
const path = require("path");
const { extractDiffTokens, buildPackage, renderPackageMarkdown, redactSensitiveDiff, isSensitivePath, PKG_DEFAULTS } = require(path.join(__dirname, "..", "out", "scope-package.js"));
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

console.log("[민감 범주 diff 제외] 꾸러미는 외부 탐색자까지 가므로 비밀값 파일 섹션은 통째로 빠져야 함(§3.2) + 정직 고지");
const secretDiff = [
  "diff --git a/src/app.ts b/src/app.ts", "index 111..222 100644", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "+const appLogic = 1;",
  "diff --git a/.env b/.env", "index 333..444 100644", "--- a/.env", "+++ b/.env", "@@ -1 +1 @@", "+API_SECRET=realvalue",
  "diff --git a/config/credentials.json b/config/credentials.json", "--- a/config/credentials.json", "+++ b/config/credentials.json", "+{\"pw\":1}",
  "diff --git a/certs/server.key b/certs/server.key", "--- a/certs/server.key", "+++ b/certs/server.key", "+PRIVATE",
].join("\n") + "\n";
const red = redactSensitiveDiff(secretDiff);
ok(/appLogic/.test(red.text) && !/realvalue/.test(red.text) && !/PRIVATE/.test(red.text) && !/"pw"/.test(red.text), "일반 파일 유지 · .env/credentials/.key 내용 전부 제외");
ok(red.excluded.length === 3 && red.excluded.includes(".env"), "제외 목록에 경로만 남음(내용 아님)");
ok(isSensitivePath("secrets/prod.yaml") && isSensitivePath("id_rsa") && isSensitivePath("node_modules/x/a.js"), "범주 패턴: secrets 디렉터리·SSH 개인키·vendor류");
ok(isSensitivePath(".envrc") && isSensitivePath(".npmrc") && isSensitivePath("cfg/.env.production") && isSensitivePath("apple/AuthKey.p8"), "범주 보강: .envrc/.npmrc/.env.*/.p8 (Codex 지적 반영)");
ok(!isSensitivePath("src/tokenizer.ts") && !isSensitivePath("src/scope-package.ts") && !isSensitivePath("hotkeys.json") && !isSensitivePath("src/environment.ts"), "경계 오탐 없음(tokenizer·hotkeys·environment 등 도메인 파일은 유지)");
const quoted = 'diff --git "a/\\353\\271\\204\\353\\260\\200/secrets.txt" "b/\\353\\271\\204\\353\\260\\200/secrets.txt"\n--- x\n+++ y\n+HIDDEN\ndiff --git a/src/ok.ts b/src/ok.ts\n+keepMe\n';
const redQ = redactSensitiveDiff(quoted);
ok(!/HIDDEN/.test(redQ.text) && /keepMe/.test(redQ.text) && redQ.excluded.length === 1, "따옴표(특수문자 경로) 헤더도 제외 — 비ASCII 경로의 민감 파일 누락 방지");
const pSens = buildPackage({ ...base, diffText: "d", recentFailures: [], sensitiveExcluded: [".env", "certs/server.key"] });
ok(pSens.meta.truncations.some((t) => /민감 범주.*\.env/.test(t)), "제외 사실이 꾸러미 고지에 표기(은폐 금지)");
ok(/민감 범주 파일 diff 제외/.test(renderPackageMarkdown(pSens)), "렌더에도 고지 노출(탐색자가 빠진 부분을 인지)");
const drvSrc = require("fs").readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8");
ok(/redactSensitiveDiff\(raw\)/.test(drvSrc) && drvSrc.indexOf("redactSensitiveDiff(raw)") < drvSrc.indexOf("extractDiffTokens(diffText)"), "드라이버가 토큰 추출 '전'에 제외(비밀값이 역참조 씨앗으로 새지 않음)");

console.log("[무이력(비-git) 모드] 이력 없는 폴더도 지도를 만든다 — 최근 수정 파일 기준·정직 각주(사용자 결정 2026-07-06)");
const hp = buildPackage({ ...base, diffText: "### a.md (수정 ...)\n내용", recentFailures: [], historyless: true });
ok(hp.historyless === true && hp.blindSpots.some((b) => /최근 수정된 파일'을 변경으로 간주/.test(b)) && hp.blindSpots.some((b) => /전후 비교\(diff\)가 없다/.test(b)), "무이력 맹점 각주 3종 추가(간주 근사·diff 없음·통계 불가)");
const hmd = renderPackageMarkdown(hp);
ok(/\[무이력 모드 — 비-git\]/.test(hmd) && /최근 수정된 파일\(변경으로 간주/.test(hmd) && /최근 수정 파일 발췌 \(전후 비교 불가/.test(hmd), "렌더 라벨이 '변경'을 사칭하지 않음(간주·발췌 명시)");
ok(!/```diff/.test(hmd), "무이력 발췌는 diff 코드블록 라벨을 안 씀(거짓 형식 방지)");
// 통합: 진짜 비-git 임시 폴더에서 폴백 경로 실행(파일 2개 — 하나는 방금 수정, 하나는 참조 파일)
const os2 = require("os");
const tmpNg = require("fs").mkdtempSync(path.join(os2.tmpdir(), "hless-"));
require("fs").writeFileSync(path.join(tmpNg, "노트.md"), "프로젝트결정사항 memoAlpha 정리");
require("fs").writeFileSync(path.join(tmpNg, "참조.md"), "여기도 memoAlpha 언급");
const old = new Date(Date.now() - 2 * 24 * 3600 * 1000); // 참조 파일은 '옛 파일'이어야 seed가 아니라 역참조 대상이 됨
require("fs").utimesSync(path.join(tmpNg, "참조.md"), old, old);
const { collectPackage: collectPkgHl } = require(path.join(__dirname, "..", "scripts", "scope-package.js"));
const hpkg = collectPkgHl(tmpNg);
ok(!!hpkg && hpkg.historyless === true && hpkg.seeds.includes("노트.md"), "비-git 폴백 발동 + 최근 수정 파일이 seed로");
ok(hpkg.tokenHits.some((h) => h.token === "memoAlpha" && h.files.includes("참조.md")), "Node 스캔 역참조가 git grep 자리를 대체(memoAlpha→참조.md)");
try { require("fs").rmSync(tmpNg, { recursive: true, force: true }); } catch { /* 정리 실패 무해 */ }
const drvSrc2 = require("fs").readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8");
ok(/파일 탐색이 상한/.test(drvSrc2) && /capped/.test(drvSrc2), "파일 탐색 상한 도달도 절단 고지(침묵 과소보고 방지 — Codex 보완)");

console.log("[collectPackage 통합] 드라이버가 이 저장소에서 완전한 꾸러미 형태를 반환(CI 얕은 클론에서도 구조 유지)");
const { collectPackage } = require(path.join(__dirname, "..", "scripts", "scope-package.js"));
const live = collectPackage(path.join(__dirname, ".."));
ok(!!live && typeof live.meta.head === "string" && live.meta.head.length >= 7, "git head 수집");
ok(Array.isArray(live.seeds) && Array.isArray(live.tokenHits) && Array.isArray(live.droppedTokens) && Array.isArray(live.tests), "구조 키 전부 배열");
ok(live.blindSpots.length >= 5, "정직성 각주 5종 유지");
ok(live.tests.some((t) => /npm test/.test(t)), "테스트 체인 발견");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
