// ── 범위 장부(SCOPE LEDGER) L0 — git 이력 co-change 채굴 (설계: 에이전트 활용/SCOPE-LEDGER.md) ──
// 질문: "이 파일을 건드리면, 과거에 무엇이 함께 바뀌었나?" — 요청 의미 분류 없이 산출물(파일) 키로만 조회.
// 원칙: ①발견은 코드가(결정론 — git 이력만 사용, AI 추론 0) ②표본이 빈약하면 침묵(오탐 대신 "데이터 없음")
//      ③기계 커밋(릴리스·lockfile 등)은 '함께 씀' 증거가 아니므로 제외 ④후보는 조언일 뿐 — high 확정은 검증층.
// vscode 의존 없음 — git 실행·파일 IO는 호출측(extension/scripts) 책임. 테스트가 out/scope-ledger.js를 직접 import.

export type ScopeCommit = { hash: string; ts: number; subject: string; files: string[] };
export type ScopeCandidate = { file: string; n: number; score: number; lastTs: number };
export type ScopeSuggestion = {
  candidates: ScopeCandidate[];
  seedObservations: number; // seed가 등장한 (비기계) 커밋 수 — 신뢰도의 분모
  sparse: boolean;          // 표본 부족 → 침묵해야 함("데이터 없음" 표시는 필수 안전장치)
};

export const SCOPE_DEFAULTS = { minN: 3, topK: 10, halfLifeDays: 45, maxFilesPerCommit: 30 };

// `git log --no-merges --first-parent --pretty=format:%H|%ct|%s --name-only -n <N>` 출력 파싱.
// 형태: 헤더줄(해시|유닉스초|제목) 다음 파일 경로 줄들, 커밋 사이 빈 줄. 경로는 소문자·슬래시로 정규화(비교 일관).
export function parseGitLog(text: string): ScopeCommit[] {
  const out: ScopeCommit[] = [];
  let cur: ScopeCommit | null = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^([0-9a-f]{7,40})\|(\d+)\|(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { hash: m[1], ts: Number(m[2]) * 1000, subject: m[3], files: [] };
    } else if (line && cur) {
      cur.files.push(normPath(line));
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function normPath(p: string): string {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// '기계 커밋' = 함께 바뀌었어도 결합의 증거가 아닌 것. 범주 기준(구체어 최소):
//  ① 릴리스/버전 커밋(제목이 release 계열) ② 남는 파일이 전부 버전·lock·산출물뿐인 커밋.
// (예: 릴리스마다 package.json이 온갖 파일과 '함께' 바뀌어 과대표집 — 실측 2026-07-05: extension.ts 42커밋 중 package.json 26회의 주범)
const RELEASE_SUBJECT_RE = /^(chore\(release\)|release[:( ]|v?\d+\.\d+\.\d+$)/i;
const VERSIONISH_FILE_RE = /(^|\/)(package\.json|package-lock\.json|.*\.lock|yarn\.lock|pnpm-lock\.yaml)$|(^|\/)(dist|out|build|node_modules)\//;
export function isMechanicalCommit(c: ScopeCommit): boolean {
  if (RELEASE_SUBJECT_RE.test((c.subject || "").trim())) return true;
  return c.files.length > 0 && c.files.every((f) => VERSIONISH_FILE_RE.test(f));
}

// 버전·lock·산출물 파일은 후보에서도 제외(어느 커밋에 섞여 있든 '확인 후보'로서 정보가 없음).
export function isNoiseFile(f: string): boolean {
  return VERSIONISH_FILE_RE.test(normPath(f));
}

// 채굴: seed 파일(들)이 등장한 비기계 커밋에서 함께 바뀐 파일을 빈도(n)×최근성(반감기 가중)으로 랭킹.
// sparse 게이트: seed 관측이 minN 미만이면 후보를 내지 않는다(약한 데이터를 강한 조언처럼 보이지 않게 — 침묵+상위 승격).
export function suggest(commits: ScopeCommit[], seeds: string[], opts?: Partial<typeof SCOPE_DEFAULTS> & { nowMs?: number }): ScopeSuggestion {
  const o = { ...SCOPE_DEFAULTS, ...(opts || {}) };
  const now = opts && typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
  const seedSet = new Set(seeds.map(normPath));
  const halfLifeMs = o.halfLifeDays * 24 * 60 * 60 * 1000;
  const acc: Record<string, { n: number; score: number; lastTs: number }> = {};
  let seedObservations = 0;
  for (const c of commits) {
    if (isMechanicalCommit(c)) continue;
    if (c.files.length > o.maxFilesPerCommit) continue; // 초대형 커밋(전면 포맷팅 등)은 결합 증거로 부적합
    if (!c.files.some((f) => seedSet.has(f))) continue;
    seedObservations++;
    const w = Math.pow(0.5, Math.max(0, now - c.ts) / halfLifeMs); // 최근성 반감 — '신규 정보로 교체'가 자동으로 일어남
    for (const f of c.files) {
      if (seedSet.has(f) || isNoiseFile(f)) continue;
      const a = (acc[f] = acc[f] || { n: 0, score: 0, lastTs: 0 });
      a.n++; a.score += w; if (c.ts > a.lastTs) a.lastTs = c.ts;
    }
  }
  const sparse = seedObservations < o.minN;
  const candidates = sparse ? [] : Object.entries(acc)
    .filter(([, v]) => v.n >= o.minN)
    .map(([file, v]) => ({ file, n: v.n, score: v.score, lastTs: v.lastTs }))
    .sort((a, b) => b.score - a.score || b.n - a.n)
    .slice(0, o.topK);
  return { candidates, seedObservations, sparse };
}

// ── S0 소급 평가 — "그때의 변경에서, 함께 바뀐 파일들이 (그 시점 과거 이력만으로 만든) 후보 상위에 들었나" ──
// 평가 커밋 i의 각 파일을 seed로, 같은 커밋의 나머지 파일들을 '실제 필요했던 동반 변경'(정답)으로 본다.
// 이력은 commits[i+1..](그 시점의 과거)만 사용 — 미래 누출 없음.
// 지표: hit@5/@10(정답이 상위 후보에 든 쌍 비율) · missNever(정답이 후보에 아예 없던 비율 = 치명 누락 근사)
//      · sparseRate(표본 부족으로 침묵한 seed 비율) · precisionProxy(상위 후보 중 이번 정답이었던 비율 — 소음률의 보수적 근사:
//        후보가 '이번에' 안 바뀌었어도 확인 가치가 있을 수 있어 진짜 소음의 상한임을 문서화).
// 지표를 두 층으로 분리(정직성): ①전체(커버리지) — 모든 쌍 기준. 사상 처음 등장하는 파일(원리적 예측 불가)과
// 정직한 침묵(sparse)까지 '누락'으로 세므로 낮게 나오는 게 정상이고, 이 낮음이 곧 "L0 혼자로는 부족(→MAP·L2 필요)"의 근거.
// ②예측가능 부분집합(기술 성능) — target이 그 시점 이력에 1회 이상 등장했고 seed가 sparse가 아닌 쌍만.
//   L0이 '원리상 잡을 수 있는 것'을 실제로 잡는지의 측정 — 도구 존폐 판단은 이 수치와 커버리지를 함께 본다.
export type RetroResult = {
  evals: number; pairs: number;
  hitAt5: number; hitAt10: number; missNever: number; sparseRate: number; precisionProxyAt10: number;
  pairsPredictable: number;      // target이 이력에 존재 + seed 비-sparse(원리상 잡을 수 있던 쌍)
  hitAt5Predictable: number; hitAt10Predictable: number;
};
export function retroEvaluate(commits: ScopeCommit[], opts?: Partial<typeof SCOPE_DEFAULTS> & { maxEvals?: number }): RetroResult {
  const o = { ...SCOPE_DEFAULTS, maxEvals: 60, ...(opts || {}) };
  let evals = 0, pairs = 0, hit5 = 0, hit10 = 0, never = 0, sparseSeeds = 0, seedRuns = 0, shown = 0, shownHit = 0;
  let pairsP = 0, hit5P = 0, hit10P = 0;
  for (let i = 0; i < commits.length && evals < o.maxEvals; i++) {
    const c = commits[i];
    if (isMechanicalCommit(c)) continue;
    const files = c.files.filter((f) => !isNoiseFile(f));
    if (files.length < 2 || files.length > o.maxFilesPerCommit) continue;
    evals++;
    const history = commits.slice(i + 1);
    const histFiles = new Set<string>(); // 그 시점 이력에 존재했던 파일(예측가능성 판정용)
    for (const h of history) { if (!isMechanicalCommit(h)) for (const f of h.files) histFiles.add(f); }
    for (const seed of files) {
      const targets = files.filter((f) => f !== seed);
      const sug = suggest(history, [seed], { ...o, topK: 10, nowMs: c.ts }); // '그 시점' 기준 최근성
      seedRuns++;
      if (sug.sparse) { sparseSeeds++; pairs += targets.length; never += targets.length; continue; }
      const top10 = sug.candidates.map((x) => x.file);
      const top5 = top10.slice(0, 5);
      shown += top10.length;
      for (const t of targets) {
        pairs++;
        const predictable = histFiles.has(t); // 사상 처음 등장하는 파일은 어떤 이력 통계도 원리상 못 잡음
        if (predictable) pairsP++;
        if (top5.includes(t)) { hit5++; if (predictable) hit5P++; }
        if (top10.includes(t)) { hit10++; shownHit++; if (predictable) hit10P++; }
        else never++; // 상위 후보 어디에도 없음 = 치명 누락 근사(커버리지 관점)
      }
    }
  }
  return {
    evals, pairs,
    hitAt5: pairs ? hit5 / pairs : 0,
    hitAt10: pairs ? hit10 / pairs : 0,
    missNever: pairs ? never / pairs : 0,
    sparseRate: seedRuns ? sparseSeeds / seedRuns : 0,
    precisionProxyAt10: shown ? shownHit / shown : 0,
    pairsPredictable: pairsP,
    hitAt5Predictable: pairsP ? hit5P / pairsP : 0,
    hitAt10Predictable: pairsP ? hit10P / pairsP : 0,
  };
}
