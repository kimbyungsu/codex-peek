"use strict";

// ── 요청 기준 지도 검색 — 정수 채점기(구현 1조각) ──────────────────────────────────────────
// 정본: docs/MAP-RETRIEVAL-SPEC.md §3 '씨앗 규칙' — 확정 산식 4단계·단조성 계약·고정 벡터 20쌍.
// 순수 계층: fs·프로세스 상태 접근 없음. 부동소수 연산 없음(전부 정수) — 언어·플랫폼 무관 동일 값.
//
// idf1000(N, df): 말뭉치 N개 파일 중 df개에 나온 씨앗의 감점 가중치(1000배 고정소수점).
//   - N < 20            → 1000 (소규모 말뭉치는 감점 미적용 — 명세 '20개 미만')
//   - df >= N           → 1    (어디에나 있는 씨앗 — 바닥. 0이 되지 않아 '사라지지 않는다')
//   - 그 외 4단계 정수 산식:
//       q   = floor(N * 65536 / df)                 (Q16 몫 · df<=N이라 q>=65536)
//       b   = q의 최상위 비트 위치(= floor(log2 q))
//       f16 = floor((q - 2^b) * 65536 / 2^b)        (소수부 선형 근사 0..65535)
//       L   = (b - 16) * 65536 + f16                (Q16 log2(N/df))
//       idf = floor(L * 693 / 65536), 1 미만이면 1  (ln2×1000 ≈ 693)
//   근사값이므로 round(1000*ln(N/df))와 다를 수 있다 — 순위용 값이라 필요한 성질은 정확도가
//   아니라 단조성이고, 유효 영역 전수(1,125,750건)에서 위반 0건을 테스트가 잠근다.
//   유효 영역: 정수 1 <= df, 1 <= N <= 1500(검색 대상 파일 상한 HL.maxScanFiles와 동일).
//   영역 밖·비정수 = null — 호출자 결함을 조용히 점수로 바꾸지 않는다(정밀도 보증 밖 값 차단).
const IDF_CORPUS_MIN = 20;
const IDF_N_MAX = 1500;
function idf1000(N, df) {
  if (!Number.isInteger(N) || !Number.isInteger(df) || N < 1 || df < 1 || N > IDF_N_MAX) return null;
  if (N < IDF_CORPUS_MIN) return 1000;
  if (df >= N) return 1;
  const q = Math.floor((N * 65536) / df);
  const b = 31 - Math.clz32(q);
  const f16 = Math.floor(((q - 2 ** b) * 65536) / 2 ** b);
  const L = (b - 16) * 65536 + f16;
  const v = Math.floor((L * 693) / 65536);
  return v < 1 ? 1 : v;
}

// 동점 비교(명세 §3): 슬래시 통일 · NFC 정규화 후, 대소문자를 보존한 채 '코드 포인트' 순서.
// 로캘 의존 비교(localeCompare) 금지 — 환경마다 순위가 갈린다. 문자열 < 비교도 쓰지 않는다:
// UTF-16 코드 유닛 순서라 서러게이트 쌍(보충 평면)에서 코드 포인트 순서와 어긋난다.
function normPathForTie(p) {
  return String(p == null ? "" : p).replace(/\\+/g, "/").normalize("NFC");
}
function comparePaths(a, b) {
  const A = Array.from(normPathForTie(a));
  const B = Array.from(normPathForTie(b));
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const ca = A[i].codePointAt(0);
    const cb = B[i].codePointAt(0);
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

// ── 씨앗 추출(명세 §3 '추출 대상' — 구현 2조각) ────────────────────────────────────────────
// '의미'가 아니라 '글자'다(설계 문서 정직 표기): 요청문에서 네 모양만 뽑는다 — 경로·백틱 토큰·
// 식별자(낙타등/밑줄)·따옴표 인용문. 일반어 억제는 여기서 하지 않는다(그건 검색 단계의 흔함
// 감점=idf1000 몫). 여기서 버리는 것은 둘뿐: 문자 다양성 3종 미만(aaa·=== 류)·JS/TS 예약어와
// 기본 리터럴(언어 명세 고정 집합 — 프로젝트마다 늘어나지 않는다).
// 상한 초과 선별=모양 구체성 내림차순(경로>백틱>식별자>인용)·같은 모양=출현 순·넘침은 개수로
// 보고(침묵 절단 금지). 순수 함수 — 파일·프로세스 상태·출력 없음(씨앗 sink 금지의 전제).
const SEED_MAX = 8; // HL.maxSeeds 복사 — 테스트가 scope-package.js 원문 대조로 잠근다
const SEED_SHAPES = ["path", "backtick", "identifier", "quote"]; // 구체성 내림차순
// ECMAScript 예약어(엄격 모드 포함)+기본 리터럴. 대소문자 그대로 비교(JS가 그렇다 — True는 예약어 아님).
const JS_RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true",
  "try", "typeof", "var", "void", "while", "with", "yield", "let", "static", "await",
  "implements", "interface", "package", "private", "protected", "public",
  "undefined", "NaN", "Infinity",
]);
function seedEligible(value) {
  if (typeof value !== "string") return false;
  if (JS_RESERVED.has(value)) return false;
  return new Set(value).size >= 3; // 문자 다양성 — 근거 없는 값임을 명세가 정직 표기(실측 후 조정)
}
function extractSeeds(text) {
  // URL은 경로 씨앗이 아니다(1차 검증 반례: example.com/docs/api.js 오인) — 추출 전 통째로 치운다.
  // 자리 길이는 보존해 at(출현 위치)이 원문과 어긋나지 않게 한다. 정지 문자는 공백·따옴표·쉼표·
  // 세미콜론·<>뿐(괄호·대괄호는 URL의 일부 — IPv6 [::1]·경로 (a)). 'url(word)'처럼 공백 없이 붙은
  // 토큰은 URL 꼬리다(인접 보존=쉼표·공백 케이스).
  // 7차 확정: URL 문법을 정규식으로 흉내 내지 않는다 — 어휘 스캔으로 후보만 뜨고 '유효성 판정은
  // Node URL 파서에 위임'한다(과소·과잉 마스킹의 근원 제거·순수/결정론 유지). 상대(//…) 후보는
  // 유효 URL이면서 호스트에 점(도메인)·콜론(IPv6)이 있을 때만 URL — 단일 라벨(//fooBar)은 코드
  // 주석으로 보존한다(모든 단일 토큰이 기술상 유효 호스트라 파서만으로는 주석과 못 가른다).
  const blank = (u) => " ".repeat(u.length);
  const tryUrl = (s) => { try { return new URL(s); } catch { return null; } };
  const src = String(text == null ? "" : text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>,;]+/gi, (u) => (tryUrl(u) ? blank(u) : u))
    .replace(/(?<![\w:])\/\/[^\s"'`<>,;]+/g, (u) => {
      const p = tryUrl("http:" + u);
      return p && (p.hostname.includes(".") || p.hostname.includes(":")) ? blank(u) : u;
    });
  const found = []; // { value, shape, at } — at=원문 출현 위치(같은 모양 안 출현 순 정렬 재료)
  const push = (value, shape, at) => { if (seedEligible(value)) found.push({ value, shape, at }); };
  // ① 경로 — 확장자를 가진 상대경로(구분자 혼용·다점 파일명 global.d.ts·유니코드 이름 src/설정.ts·
  //    숨김 파일 .env.local 허용·저장은 슬래시 통일). 확장자는 1~8자 영숫자이되 글자 1개 이상
  //    (.c·.7z 허용, 버전 문자열 1.2.3의 순숫자 꼬리 배제). 경계는 \b 대신 lookaround(유니코드·선행점).
  //    3차 반례 반영: 좌측 경계 — 앞이 구분자·콜론이면 절대경로(/src/…)·드라이브(C:\…)·URL 꼬리라
  //    상대경로가 아니다(명세 :283 '상대경로' 계약). 문자 집합에 결합문자 \p{M} 허용(NFD 경로).
  //    좌측 경계는 경로 구성 문자 전체 제외(한 글자 밀린 재진입 차단) — 단 콜론은 제외하지 않는다
  //    (4차 반례: '경로:src/a.ts' 라벨 뒤 상대경로는 정상. 절대(/)·드라이브(C:\)는 구분자 차단으로
  //    충분하고 file: 등 스킴 URL은 위에서 선제 마스킹됨). 우측 경계는 ASCII 단어문자·_-·구분자를
  //    막아 접두 절단(src/a.ts_extra→src/a.ts)을 차단하되, 한글 조사 직결(src/a.ts를)은 허용한다.
  //    5차 반례: 드라이브 상대경로(C:src\a.ts — 한 글자+콜론)는 차단하되 라벨 콜론(label:)은 허용 —
  //    '콜론 앞이 단독 한 글자인가'를 중첩 lookbehind로 판정.
  for (const m of src.matchAll(/(?<!(?<![\p{L}\p{N}])[A-Za-z]:)(?<![\p{L}\p{M}\p{N}_.\\/-])(?:[\p{L}\p{M}\p{N}_.-]+[\\/])+[\p{L}\p{M}\p{N}_.-]*\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_\p{M}\\/-])|(?<!(?<![\p{L}\p{N}])[A-Za-z]:)(?<![\p{L}\p{M}\p{N}_.\\/-])\.?[\p{L}\p{M}\p{N}_-]+(?:\.[\p{L}\p{M}\p{N}_-]+)*\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_\p{M}\\/-])/gu)) {
    const ext = m[0].slice(m[0].lastIndexOf(".") + 1);
    if (/[A-Za-z]/.test(ext)) push(m[0].replace(/\\+/g, "/"), "path", m.index);
  }
  // ② 백틱 토큰 — 공백 없는 2~80자
  for (const m of src.matchAll(/`([^\s`]{2,80})`/g)) push(m[1].replace(/\\+/g, "/"), "backtick", m.index);
  // ③ 식별자 — 낙타등 또는 밑줄 연결, 3자 이상. 유니코드 토큰을 훑고 코드로 판정한다(1차 검증
  //    반례: parseURL처럼 전이로 끝나는 낙타등·사용자_설정처럼 비ASCII 밑줄을 정규식 한 방이 놓침).
  //    2차 반례 반영: 첫 글자 숫자 금지(123_value·1parseURL은 식별자가 아니다) — lookbehind로 토큰
  //    중간 진입도 차단.
  for (const m of src.matchAll(/(?<![\p{L}\p{M}\p{N}_$])[\p{L}_$][\p{L}\p{M}\p{N}_$]{2,}/gu)) {
    const t = m[0];
    const camel = /[a-z0-9][A-Z]/.test(t) || /[A-Z][a-z]/.test(t.slice(1)); // 내부 전이(첫 글자 대문자만인 일반어 제외)
    const snake = /[^\s_]_[^\s_]/.test(t); // 밑줄이 양쪽 글자를 잇는 경우(순수 밑줄·가장자리 제외)
    if (camel || snake) push(t, "identifier", m.index);
  }
  // ④ 따옴표 인용문 — 3~80자(줄바꿈 제외·곧은/굽은 큰·작은따옴표 4쌍)
  for (const m of src.matchAll(/"([^"\n]{3,80})"|'([^'\n]{3,80})'|“([^”\n]{3,80})”|‘([^’\n]{3,80})’/g)) {
    push((m[1] || m[2] || m[3] || m[4]).trim(), "quote", m.index);
  }
  // 중복 제거 — 키는 슬래시 정규화 값(1차 검증 반례: "bridge\map-reader.js" 인용문이 정규화된 경로와
  // 별건으로 계상). 같은 키는 구체성 높은 모양 하나로(모양 순위, 같으면 먼저 나온 것).
  const rank = new Map(SEED_SHAPES.map((s, i) => [s, i]));
  const byValue = new Map();
  for (const s of found) {
    const key = s.value.replace(/\\+/g, "/");
    const prev = byValue.get(key);
    if (!prev || rank.get(s.shape) < rank.get(prev.shape) || (s.shape === prev.shape && s.at < prev.at)) byValue.set(key, s);
  }
  // 선별 — 모양 구체성 내림차순 · 같은 모양=출현 순 · 상한 8 · 넘침은 개수 보고
  const ordered = [...byValue.values()].sort((a, b) => rank.get(a.shape) - rank.get(b.shape) || a.at - b.at);
  const seeds = ordered.slice(0, SEED_MAX).map(({ value, shape }) => ({ value, shape }));
  return { seeds, dropped: Math.max(0, ordered.length - SEED_MAX) };
}

// ── 로컬 검색기(명세 §3 '상한'·'점수' — 구현 3조각) ─────────────────────────────────────────
// 씨앗으로 저장소 파일을 찾는다. 읽기 전용·출력 0(씨앗 sink 금지)·결정론(fs 상태 고정 시).
// 상한 5종은 기존 정찰 HL 값의 복사(테스트가 원문 대조로 잠금 — 시간 상한은 명세대로 미확정):
// 파일 1,500·깊이 6·파일당 512KiB·총 읽기 16MiB·(씨앗 8은 추출기 몫). 상한 도달=truncated로 남긴다
// (조용히 자르지 않는다 — 그 회차 지표는 소비처에서 unknown 처리).
// 민감 경로·건너뛸 디렉터리·바이너리 확장자도 기존 규칙의 복사다(각각 원문 대조 잠금).
// fs는 여기서만 쓴다 — 위 추출·채점 함수들은 순수 유지.
const SEARCH_CAPS = { maxScanFiles: 1500, maxDepth: 6, maxFileBytes: 512 * 1024, scanBudgetBytes: 16 * 1024 * 1024 };
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", "out", ".vscode", ".idea", "__pycache__", ".venv", "venv"]);
const SEARCH_BIN_RE = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|7z|rar|exe|dll|vsix|woff2?|ttf|otf|mp3|mp4|mov|iso|bin|class|pyc|jar|db|sqlite)$/i;
// src/scope-package.ts SENSITIVE_PATH_RE의 복사 — 갈리면 잠금 테스트가 깨진다
const SEARCH_SENSITIVE_RE = /(^|\/)\.(env[^/]*|netrc|npmrc|pgpass|htpasswd)$|(^|[/._-])(secrets?|credentials?|tokens?|api[_-]?keys?|passwords?|passwd)([/._-]|$)|\.(pem|key|p12|pfx|jks|keystore|der|p8|ppk)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|(^|\/)(node_modules|dist|build|vendor)\//i;
const SEED_WEIGHTS = { path: 3, backtick: 2, identifier: 2, quote: 1 }; // 명세 '점수' 절 고정값

// capsOverride는 테스트 전용이다(작은 픽스처로 상한 동작을 재현하기 위한 축소만) — 배선(생산 호출)은
// 전달 금지가 계약이고, 배선 조각의 테스트가 이를 반례로 잠근다.
function searchSeeds(rootDir, seeds, capsOverride) {
  const caps = { ...SEARCH_CAPS, ...(capsOverride || {}) };
  const root = String(rootDir == null ? "" : rootDir);
  const list = Array.isArray(seeds) ? seeds.filter((s) => s && typeof s.value === "string" && SEED_SHAPES.includes(s.shape)) : [];
  const fs = require("fs");
  const path = require("path");
  // ① 목록화 — 기존 walkFiles와 같은 규칙(상한 도달=truncated·민감/바이너리/스킵 디렉터리 제외)
  const files = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > caps.maxDepth) { truncated = true; return; }
    if (files.length >= caps.maxScanFiles) { truncated = true; return; }
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { truncated = true; return; } // 접근 실패=부분 목록(검증 [주의] — 완료 위장 금지)
    for (const it of items) {
      if (files.length >= caps.maxScanFiles) { truncated = true; return; }
      const abs = path.join(dir, it.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (it.isDirectory()) { if (!SEARCH_SKIP_DIRS.has(it.name) && !it.name.startsWith(".")) walk(abs, depth + 1); continue; }
      if (!it.isFile() || SEARCH_BIN_RE.test(it.name) || SEARCH_SENSITIVE_RE.test(rel)) continue;
      try { const st = fs.statSync(abs); if (st.size <= caps.maxFileBytes) files.push({ rel, abs, size: st.size }); else truncated = true; } catch { truncated = true; } // 접근 실패 제외도 잘림이다(검증 [주의]) // 파일당 상한 초과 제외도 잘림이다(검증 반례: src/extension.ts 846KB) — 부분 검색을 완료로 위장하지 않는다
    }
  };
  if (root) walk(root, 0);
  // ② 매칭 — 경로 씨앗은 상대경로(그 자체·조각 경계 접미)로도, 모든 씨앗은 내용 부분 문자열로.
  //    총 읽기 예산 소진=truncated(남은 파일은 내용 미대조·경로 대조는 유지 — 읽지 않은 것을 읽은
  //    것처럼 세지 않는다).
  let budget = caps.scanBudgetBytes;
  const dfBySeed = new Map(list.map((s) => [s, 0]));
  const hitsByFile = new Map(); // rel → Set<seed>
  for (const f of files) {
    let content = null;
    if (budget >= f.size) {
      try { content = fs.readFileSync(f.abs, "utf8"); budget -= f.size; } catch { content = null; truncated = true; } // 읽기 실패=내용 미대조(검증 [주의])
    } else { truncated = true; }
    for (const s of list) {
      const pathHit = s.shape === "path" && (f.rel === s.value || f.rel.endsWith("/" + s.value));
      const contentHit = content !== null && content.includes(s.value);
      if (pathHit || contentHit) {
        dfBySeed.set(s, dfBySeed.get(s) + 1);
        if (!hitsByFile.has(f.rel)) hitsByFile.set(f.rel, new Set());
        hitsByFile.get(f.rel).add(s);
      }
    }
  }
  // ③ 점수 — Σ(모양 가중치 × idf1000). N=목록화된 파일 수(상한 내). 동점=코드 포인트 경로 순.
  const N = files.length;
  const matches = [];
  for (const [rel, hitSeeds] of hitsByFile) {
    let score = 0;
    for (const s of hitSeeds) {
      const idf = idf1000(N, dfBySeed.get(s));
      if (idf !== null) score += (SEED_WEIGHTS[s.shape] || 0) * idf;
    }
    if (score > 0) matches.push({ path: rel, score });
  }
  matches.sort((a, b) => b.score - a.score || comparePaths(a.path, b.path));
  return { matches, corpus: N, truncated };
}

module.exports = { idf1000, comparePaths, normPathForTie, IDF_CORPUS_MIN, IDF_N_MAX, extractSeeds, SEED_MAX, SEED_SHAPES, JS_RESERVED, searchSeeds, SEARCH_CAPS, SEED_WEIGHTS, SEARCH_SKIP_DIRS, SEARCH_BIN_RE, SEARCH_SENSITIVE_RE };
