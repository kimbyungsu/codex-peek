"use strict";
// ── 범위 장부(SCOPE LEDGER) L0 — git 이력 co-change 채굴 (설계: 에이전트 활용/SCOPE-LEDGER.md) ──
// 질문: "이 파일을 건드리면, 과거에 무엇이 함께 바뀌었나?" — 요청 의미 분류 없이 산출물(파일) 키로만 조회.
// 원칙: ①발견은 코드가(결정론 — git 이력만 사용, AI 추론 0) ②표본이 빈약하면 침묵(오탐 대신 "데이터 없음")
//      ③기계 커밋(릴리스·lockfile 등)은 '함께 씀' 증거가 아니므로 제외 ④후보는 조언일 뿐 — high 확정은 검증층.
// vscode 의존 없음 — git 실행·파일 IO는 호출측(extension/scripts) 책임. 테스트가 out/scope-ledger.js를 직접 import.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCOPE_DEFAULTS = void 0;
exports.parseGitLog = parseGitLog;
exports.normPath = normPath;
exports.isMechanicalCommit = isMechanicalCommit;
exports.isNoiseFile = isNoiseFile;
exports.suggest = suggest;
exports.retroEvaluate = retroEvaluate;
exports.SCOPE_DEFAULTS = { minN: 3, topK: 10, halfLifeDays: 45, maxFilesPerCommit: 30 };
// `git log --no-merges --first-parent --pretty=format:%H|%ct|%s --name-only -n <N>` 출력 파싱.
// 형태: 헤더줄(해시|유닉스초|제목) 다음 파일 경로 줄들, 커밋 사이 빈 줄. 경로는 소문자·슬래시로 정규화(비교 일관).
function parseGitLog(text) {
    const out = [];
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        const m = /^([0-9a-f]{7,40})\|(\d+)\|(.*)$/.exec(line);
        if (m) {
            if (cur)
                out.push(cur);
            cur = { hash: m[1], ts: Number(m[2]) * 1000, subject: m[3], files: [] };
        }
        else if (line && cur) {
            cur.files.push(normPath(line));
        }
    }
    if (cur)
        out.push(cur);
    return out;
}
function normPath(p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
// '기계 커밋' = 함께 바뀌었어도 결합의 증거가 아닌 것. 범주 기준(구체어 최소):
//  ① 릴리스/버전 커밋(제목이 release 계열) ② 남는 파일이 전부 버전·lock·산출물뿐인 커밋.
// (예: 릴리스마다 package.json이 온갖 파일과 '함께' 바뀌어 과대표집 — 실측 2026-07-05: extension.ts 42커밋 중 package.json 26회의 주범)
const RELEASE_SUBJECT_RE = /^(chore\(release\)|release[:( ]|v?\d+\.\d+\.\d+$)/i;
const VERSIONISH_FILE_RE = /(^|\/)(package\.json|package-lock\.json|.*\.lock|yarn\.lock|pnpm-lock\.yaml)$|(^|\/)(dist|out|build|node_modules)\//;
function isMechanicalCommit(c) {
    if (RELEASE_SUBJECT_RE.test((c.subject || "").trim()))
        return true;
    return c.files.length > 0 && c.files.every((f) => VERSIONISH_FILE_RE.test(f));
}
// 버전·lock·산출물 파일은 후보에서도 제외(어느 커밋에 섞여 있든 '확인 후보'로서 정보가 없음).
function isNoiseFile(f) {
    return VERSIONISH_FILE_RE.test(normPath(f));
}
// 채굴: seed 파일(들)이 등장한 비기계 커밋에서 함께 바뀐 파일을 빈도(n)×최근성(반감기 가중)으로 랭킹.
// sparse 게이트: seed 관측이 minN 미만이면 후보를 내지 않는다(약한 데이터를 강한 조언처럼 보이지 않게 — 침묵+상위 승격).
function suggest(commits, seeds, opts) {
    const o = { ...exports.SCOPE_DEFAULTS, ...(opts || {}) };
    const now = opts && typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
    const seedSet = new Set(seeds.map(normPath));
    const halfLifeMs = o.halfLifeDays * 24 * 60 * 60 * 1000;
    const acc = {};
    let seedObservations = 0;
    for (const c of commits) {
        if (isMechanicalCommit(c))
            continue;
        if (c.files.length > o.maxFilesPerCommit)
            continue; // 초대형 커밋(전면 포맷팅 등)은 결합 증거로 부적합
        if (!c.files.some((f) => seedSet.has(f)))
            continue;
        seedObservations++;
        const w = Math.pow(0.5, Math.max(0, now - c.ts) / halfLifeMs); // 최근성 반감 — '신규 정보로 교체'가 자동으로 일어남
        for (const f of c.files) {
            if (seedSet.has(f) || isNoiseFile(f))
                continue;
            const a = (acc[f] = acc[f] || { n: 0, score: 0, lastTs: 0 });
            a.n++;
            a.score += w;
            if (c.ts > a.lastTs)
                a.lastTs = c.ts;
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
function retroEvaluate(commits, opts) {
    const o = { ...exports.SCOPE_DEFAULTS, maxEvals: 60, ...(opts || {}) };
    let evals = 0, pairs = 0, hit5 = 0, hit10 = 0, never = 0, sparseSeeds = 0, seedRuns = 0, shown = 0, shownHit = 0;
    let pairsP = 0, hit5P = 0, hit10P = 0;
    for (let i = 0; i < commits.length && evals < o.maxEvals; i++) {
        const c = commits[i];
        if (isMechanicalCommit(c))
            continue;
        const files = c.files.filter((f) => !isNoiseFile(f));
        if (files.length < 2 || files.length > o.maxFilesPerCommit)
            continue;
        evals++;
        const history = commits.slice(i + 1);
        const histFiles = new Set(); // 그 시점 이력에 존재했던 파일(예측가능성 판정용)
        for (const h of history) {
            if (!isMechanicalCommit(h))
                for (const f of h.files)
                    histFiles.add(f);
        }
        for (const seed of files) {
            const targets = files.filter((f) => f !== seed);
            const sug = suggest(history, [seed], { ...o, topK: 10, nowMs: c.ts }); // '그 시점' 기준 최근성
            seedRuns++;
            if (sug.sparse) {
                sparseSeeds++;
                pairs += targets.length;
                never += targets.length;
                continue;
            }
            const top10 = sug.candidates.map((x) => x.file);
            const top5 = top10.slice(0, 5);
            shown += top10.length;
            for (const t of targets) {
                pairs++;
                const predictable = histFiles.has(t); // 사상 처음 등장하는 파일은 어떤 이력 통계도 원리상 못 잡음
                if (predictable)
                    pairsP++;
                if (top5.includes(t)) {
                    hit5++;
                    if (predictable)
                        hit5P++;
                }
                if (top10.includes(t)) {
                    hit10++;
                    shownHit++;
                    if (predictable)
                        hit10P++;
                }
                else
                    never++; // 상위 후보 어디에도 없음 = 치명 누락 근사(커버리지 관점)
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
//# sourceMappingURL=scope-ledger.js.map