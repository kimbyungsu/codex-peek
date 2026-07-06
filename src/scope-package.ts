// ── 자료 패키지 빌더(Phase 1) — 탐색자(LLM 또는 self)에게 줄 '결정론 증거 꾸러미' (설계: SCOUT-TRACK.md §4, 순서: §14 D6) ──
// 원칙(§4·SCOPE-LEDGER): ①발견은 코드가 — 후보 수집을 AI 프롬프트 이행에 안 맡김 ②탐색자 가시성 역설 회피 —
//   구현모델의 '요약'이 아니라 하네스가 모은 원자료를 줌 ③채널 키를 하드코딩하지 않음 — diff에서 바뀐 식별자(토큰)를
//   뽑아 저장소 전역을 되짚는다(예: writeProof를 고치면 'writeProof' 토큰 grep이 checkProof 파일을 찾아냄 — 구체어 등록 불필요)
//   ④캡·정직성 — 자른 것은 잘랐다고 명시, 못 담는 것("이 꾸러미가 못 보는 것")을 꾸러미 자체에 적는다.
// vscode 의존 없음 — git/grep/파일 IO는 드라이버(scripts/scope-package.js·추후 extension) 책임. 테스트는 out/scope-package.js import.

import { ScopeSuggestion } from "./scope-ledger";

export const PKG_DEFAULTS = {
  maxTokens: 30,        // diff에서 뽑는 식별자 상한(빈도순)
  maxGrepFilesPerToken: 12,
  maxDiffChars: 20000,  // 꾸러미에 싣는 diff 본문 상한
  maxMapChars: 8000,
  maxFailures: 8,
  minTokenLen: 4,
};

// diff의 +/- 줄에서 '바뀐 식별자' 후보를 뽑는다(파일 헤더 +++/--- 제외). 언어 공통의 범주 필터:
// 짧은 토큰·순수 숫자·범용 예약어/불용어(어느 코드에나 흔해 결합 증거가 안 되는 것)만 거른다 — 도메인 단어는 거르지 않는다.
const STOP = new Set([
  "const", "function", "return", "import", "export", "require", "module", "exports", "default",
  "string", "number", "boolean", "object", "true", "false", "null", "undefined", "void",
  "this", "await", "async", "class", "interface", "type", "enum", "public", "private", "readonly",
  "if", "else", "for", "while", "switch", "case", "break", "continue", "throw", "catch", "finally", "try", "new", "typeof", "instanceof",
  "console", "length", "push", "slice", "split", "join", "trim", "replace", "includes", "filter", "some", "every", "forEach",
  "self", "none", "elif", "print", "import", "from", "pass", "lambda", // python 흔한 것
]);
// 외부 전송 안전장치(SCOUT-TRACK §3.2) — 꾸러미가 탐색자(외부 API 포함)에게 나가기 전에, 민감 '범주'
// 경로의 diff 섹션을 통째로 제외한다. 특정 파일명이 아니라 범주 패턴(비밀값을 담는 파일 종류)이며,
// 과잉 제외가 안전한 방향(제외 사실은 buildPackage가 꾸러미에 정직 표기). 경로만 남고 내용은 안 나감.
const SENSITIVE_PATH_RE = /(^|\/)\.(env[^/]*|netrc|npmrc|pgpass|htpasswd)$|(^|[/._-])(secrets?|credentials?|tokens?|api[_-]?keys?|passwords?|passwd)([/._-]|$)|\.(pem|key|p12|pfx|jks|keystore|der|p8|ppk)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|(^|\/)(node_modules|dist|build|vendor)\//i;
export function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_RE.test(String(p || "").replace(/\\/g, "/"));
}
export function redactSensitiveDiff(diffText: string): { text: string; excluded: string[] } {
  const parts = String(diffText || "").split(/^(?=diff --git )/m); // 파일 섹션 단위(첫 조각은 헤더 이전 잔여)
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const part of parts) {
    const m = part.match(/^diff --git (.+?)\r?\n/);
    if (m) {
      // git은 특수문자 경로를 따옴표 헤더("a/…")로 낸다 — 따옴표/비따옴표 모두에서 경로 조각을 뽑아 검사.
      // 공백 경로의 비따옴표 헤더는 조각으로 갈라질 수 있으나, 조각 하나라도 민감이면 제외(과잉 제외가 안전한 방향).
      const raw = m[1].match(/"[^"]+"|\S+/g) || [];
      const paths = raw.map((s) => s.replace(/^"|"$/g, "").replace(/^[ab]\//, ""));
      if (paths.some((p) => isSensitivePath(p))) { excluded.push(paths[paths.length - 1] || m[1]); continue; }
    }
    kept.push(part);
  }
  return { text: kept.join(""), excluded: Array.from(new Set(excluded)) };
}

export type DiffToken = { token: string; count: number };
export function extractDiffTokens(diffText: string, opts?: Partial<typeof PKG_DEFAULTS>): DiffToken[] {
  const o = { ...PKG_DEFAULTS, ...(opts || {}) };
  const counts: Record<string, number> = {};
  for (const raw of String(diffText).split(/\r?\n/)) {
    if (!(raw.startsWith("+") || raw.startsWith("-"))) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const m = raw.slice(1).match(/[A-Za-z_][A-Za-z0-9_-]*/g);
    if (!m) continue;
    for (const t of m) {
      if (t.length < o.minTokenLen) continue;
      if (STOP.has(t.toLowerCase())) continue;
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || (a.token < b.token ? -1 : 1))
    .slice(0, o.maxTokens);
}

// 꾸러미 스키마 — 드라이버가 결정론 수집한 원자료를 받아 조립(이 함수 자체는 순수).
export type TokenHit = { token: string; files: string[]; truncated: boolean };
export type ScopePackage = {
  meta: { repo: string; head: string; generatedBy: string; caps: typeof PKG_DEFAULTS; truncations: string[] };
  seeds: string[];                 // 지금 바뀌는 파일들(작업트리) — '무엇을 바꾸는가'
  diff: string;                    // 실제 변경 내용(상한 적용)
  tokenHits: TokenHit[];           // 바뀐 식별자를 참조하는 다른 파일들 — 파일채널·사본 결합의 결정론 후보
  droppedTokens: string[];         // 편재 토큰(참조 파일이 상한 초과 = 어디에나 있어 결합 증거가 안 됨) — 단어 목록 하드코딩 대신 실측 기준 제외, 제외 사실은 정직 표기
  coChange: ScopeSuggestion | null;// 과거 함께 변경 통계(L0 — SCOPE-LEDGER 채굴기, sparse면 후보 없음)
  tests: string[];                 // 이 저장소의 테스트 목록(실행 후보)
  recentFailures: { ts?: string; kind?: string; detail?: string }[]; // 최근 검증 실패/미완(무결성 기록)
  map: string | null;              // stable MAP(있으면 — 의미 결합의 확정층)
  blindSpots: string[];            // ★이 꾸러미가 못 보는 것 — 탐색자·소비자에게 강제로 전달되는 정직성 각주
};

export function buildPackage(input: {
  repo: string; head: string;
  seeds: string[]; diffText: string;
  tokenHits: TokenHit[]; droppedTokens?: string[]; coChange: ScopeSuggestion | null;
  tests: string[]; recentFailures: { ts?: string; kind?: string; detail?: string }[];
  mapContent: string | null;
  sensitiveExcluded?: string[]; // redactSensitiveDiff가 제외한 민감 범주 파일(경로만) — 은폐 금지, 고지로 표기
}, opts?: Partial<typeof PKG_DEFAULTS>): ScopePackage {
  const o = { ...PKG_DEFAULTS, ...(opts || {}) };
  const truncations: string[] = [];
  if (input.sensitiveExcluded && input.sensitiveExcluded.length) truncations.push(`민감 범주 파일 diff 제외(외부 전송 안전): ${input.sensitiveExcluded.join(", ")}`);
  let diff = String(input.diffText || "");
  if (diff.length > o.maxDiffChars) { diff = diff.slice(0, o.maxDiffChars); truncations.push(`diff ${input.diffText.length}→${o.maxDiffChars}자로 절단`); }
  let map = input.mapContent;
  if (map && map.length > o.maxMapChars) { map = map.slice(0, o.maxMapChars); truncations.push(`MAP ${input.mapContent!.length}→${o.maxMapChars}자로 절단`); }
  const failures = (input.recentFailures || []).slice(0, o.maxFailures);
  if ((input.recentFailures || []).length > o.maxFailures) truncations.push(`최근 실패 ${input.recentFailures.length}→${o.maxFailures}건`);
  return {
    meta: { repo: input.repo, head: input.head, generatedBy: "scope-package v1 (deterministic)", caps: o as typeof PKG_DEFAULTS, truncations },
    seeds: input.seeds,
    diff,
    tokenHits: input.tokenHits,
    droppedTokens: input.droppedTokens || [],
    coChange: input.coChange,
    tests: input.tests,
    recentFailures: failures,
    map,
    blindSpots: [
      "처음 생기는 결합(이력·참조 어디에도 아직 없음)은 이 꾸러미에 없다",
      "실행해봐야 드러나는 동작(OS별 차이·타이밍·권한)은 담기지 않는다",
      "의미적 연쇄(코드에 글자로 안 남는 규칙)는 MAP에 없으면 없다" + (input.mapContent ? "" : " — 이 저장소는 아직 MAP이 없다"),
      "grep은 문자열 일치만 — 리네임·간접 호출·동적 키는 놓칠 수 있다",
      "역참조 grep은 git이 추적(tracked)하는 파일만 본다 — 새(untracked) 파일의 내용과 그 안의 참조는 이 꾸러미에 빠질 수 있다(새 파일 중심 변경이면 과소보고 가능)",
    ],
  };
}

// LLM/self 탐색자에게 먹일 마크다운 렌더 — 판정·수정 지시 금지, '확인할 경로' 제안만 요구(§5 스키마와 짝).
export function renderPackageMarkdown(p: ScopePackage): string {
  const L: string[] = [];
  L.push(`# 영향범위 자료 꾸러미 (결정론 수집 — ${p.meta.repo} @ ${p.meta.head.slice(0, 7)})`);
  L.push(`\n## 1. 지금 바뀌는 파일(seed)\n${p.seeds.length ? p.seeds.map((s) => `- ${s}`).join("\n") : "(작업트리 변경 없음)"}`);
  L.push(`\n## 2. 변경 내용(diff)\n\`\`\`diff\n${p.diff || "(없음)"}\n\`\`\``);
  L.push(`\n## 3. 바뀐 식별자를 참조하는 다른 파일들 (문자열 일치 — 파일채널/사본 결합 후보)`);
  if (p.tokenHits.length) for (const h of p.tokenHits) L.push(`- \`${h.token}\` → ${h.files.join(", ")}${h.truncated ? " (…더 있음)" : ""}`);
  else L.push("(seed 밖에서 참조되는 바뀐 식별자 없음)");
  if (p.droppedTokens.length) L.push(`\n(제외된 편재 토큰 — 참조가 너무 흔해 결합 증거가 안 됨: ${p.droppedTokens.join(", ")})`);
  L.push(`\n## 4. 과거 '함께 변경' 통계 (이 저장소 git 이력)`);
  if (!p.coChange) L.push("(git 이력 없음)");
  else if (p.coChange.sparse) L.push(`(표본 부족 — seed 관측 ${p.coChange.seedObservations}회 <3 → 통계는 침묵. 신생 영역이면 정상)`);
  else L.push(p.coChange.candidates.map((c) => `- ${c.file} (함께 변경 ${c.n}회)`).join("\n") || "(문턱 이상 후보 없음)");
  L.push(`\n## 5. 이 저장소의 테스트\n${p.tests.length ? p.tests.map((t) => `- ${t}`).join("\n") : "(발견된 테스트 없음)"}`);
  L.push(`\n## 6. 최근 검증 실패/미완 기록\n${p.recentFailures.length ? p.recentFailures.map((f) => `- [${f.ts || "?"}] ${f.kind || ""}: ${(f.detail || "").slice(0, 160)}`).join("\n") : "(없음)"}`);
  if (p.map) L.push(`\n## 7. stable MAP(확정 지식층)\n${p.map}`);
  if (p.meta.truncations.length) L.push(`\n## 절단 고지\n${p.meta.truncations.map((t) => `- ${t}`).join("\n")}`);
  L.push(`\n## ⚠ 이 꾸러미가 못 보는 것\n${p.blindSpots.map((b) => `- ${b}`).join("\n")}`);
  L.push(`\n---\n[탐색자 지시] 위 자료만 근거로 '영향범위 지도'를 작성하라 — ①직접 영향 후보 ②간접 영향 후보 ③반드시 확인할 테스트/동작 ④문서/설정/UI 영향 ⑤범위 밖으로 봐도 되는 것 ⑥MAP patch 후보(stable MAP에 추가/수정할 의미 결합 — 제안일 뿐, 자동 반영 아님). 각 항목(①~④)에 확인필요도 high/medium/low를 달아라(high 최대 5·전체 후보 최대 10). 최종 통과/실패 판정 금지 · 수정 지시 금지 · 확인할 경로만.`);
  return L.join("\n");
}
