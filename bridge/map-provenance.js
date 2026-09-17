"use strict";
/*
 * 설계 경위 색인·선조회 (docs/MAP-PROVENANCE-DESIGN.md v1)
 * 발단: "정책 0 정상인가"류 경위(왜) 질문에서 답이 설계 문서에 있었음에도 코드 표면만 보고
 * 오판(3왕복 정정). 처방: 결정 1건=원자 항목의 docs/DECISIONS.md + 독자 낱말 매처(씨앗 엔진과
 * 분리 — 한글 자연어는 4모양 씨앗 규칙에서 0건이라는 설계검증 실측) + why 선조회(0건도 영수증).
 * 영수증은 별도 장부(provenance-usage.jsonl) — attach.jsonl은 대시보드가 최신 행을 '이번 검증에
 * 실린 기억'으로 읽으므로 무접촉(설계검증 blocker③).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CL = require(path.join(__dirname, "contract-lib.js"));

const INDEX_REL = path.join("docs", "DECISIONS.md");
const PROVENANCE_USAGE_FILE = path.join(CL.STATS_DIR, "provenance-usage.jsonl");
const USAGE_TRIM_AT = 200; // attach.jsonl과 같은 유계 규약
const ATTACH_MAX = 2;      // 경위 구획 상한(설계 §2 — 4축 라운드로빈 몫과 비공유)

function indexFileFor(repoRoot) { return path.join(String(repoRoot || ""), INDEX_REL); }

// 규약 어휘(FINDINGS_MARKERS 값) — 찾는말에 실리면 protoSeeds류 오염이라 항목 자체를 거부(설계 §1)
function protocolVocab() {
  const out = new Set();
  for (const M of [CL.FINDINGS_MARKERS, CL.FINDINGS_MARKERS_V2]) {
    for (const L of Object.values(M || {})) for (const v of Object.values(L || {})) out.add(String(v));
  }
  return out;
}

// ── 색인 파서: "## D-…" 블록 = 결정 1건(원자 항목) ─────────────────────────────
function parseDecisionsIndex(repoRoot) {
  const f = indexFileFor(repoRoot);
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch { return { ok: false, reason: "absent", entries: [] }; }
  const proto = protocolVocab();
  const entries = [], rejected = [];
  const blocks = raw.split(/\r?\n(?=## )/);
  for (const b of blocks) {
    const m = /^## (D-[0-9A-Za-z-]+)\s*—\s*(.+)$/m.exec(b);
    if (!m) continue;
    const id = m[1], title = m[2].trim();
    const line = (name) => { const r = new RegExp("^- " + name + ":\\s*(.+)$", "m").exec(b); return r ? r[1].trim() : ""; };
    // 결정·정본은 다줄 허용 — 항목 내 해당 불릿부터 다음 불릿 전까지
    const span = (name) => { const r = new RegExp("^- " + name + ":\\s*([\\s\\S]*?)(?=^- |$(?![\\s\\S]))", "m").exec(b); return r ? r[1].replace(/\s+/g, " ").trim() : ""; };
    const kw = line("찾는말").split(/[,·]/).map((s) => s.trim()).filter(Boolean);
    const decision = span("결정"), source = span("정본");
    // [v2] 사람 정정의 자동층 가림(reducer 5단계 — '가림: <subjectKey hex40>[, ...]' 선택 줄)
    const overrides = line("가림").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{40}$/.test(s));
    if (kw.some((k) => proto.has(k))) { rejected.push({ id, reason: "protocol-vocab" }); continue; } // 규약 어휘 거부
    entries.push({ id, title, decision, source, keywords: kw, overrides });
  }
  return { ok: true, entries, rejected, file: f };
}

// ── 낱말화(설계 §2): 한글·영문 2자+ / 숫자는 1자여도 유지("0" 탈락 반례 처방) ────
function tokenize(text) {
  const out = [];
  for (const t of String(text || "").split(/[^0-9A-Za-z가-힣]+/u)) {
    if (!t) continue;
    if (/^[0-9]+$/.test(t)) { out.push(t); continue; }
    if (t.length >= 2) out.push(t.toLowerCase());
  }
  return out;
}

// ── 매처(설계 §2): 정렬키 = 연속구 > 낱말 교집합 > 씨앗 가점 > 결정 ID 사전순 ────
function matchDecisions(entries, queryText, seeds) {
  const qTokens = tokenize(queryText);
  const qBigrams = [];
  for (let i = 0; i + 1 < qTokens.length; i++) qBigrams.push(qTokens[i] + " " + qTokens[i + 1]);
  const seedVals = (seeds || []).map((s) => String((s && s.value) || s || "")).filter(Boolean);
  const scored = [];
  for (const e of entries) {
    const vocabText = e.title + " " + e.keywords.join(" ");
    const vocab = new Set(tokenize(vocabText));
    // 연속구는 '토큰쌍 집합' 대조(구현검증 보완: 문자열 부분일치는 "재정책 0"이 "정책 0"에 오탐)
    const vTokens = tokenize(vocabText);
    const vBigrams = new Set();
    for (let i = 0; i + 1 < vTokens.length; i++) vBigrams.add(vTokens[i] + " " + vTokens[i + 1]);
    let phrase = 0;
    for (const bg of qBigrams) if (vBigrams.has(bg)) phrase++;
    let inter = 0;
    for (const t of new Set(qTokens)) if (vocab.has(t)) inter++;
    let seedHits = 0;
    for (const sv of seedVals) if ((e.decision && e.decision.includes(sv)) || (e.source && e.source.includes(sv))) seedHits++;
    if (phrase === 0 && inter === 0) continue; // 교집합·연속구 모두 0=매칭 없음(무관 동봉 0)
    scored.push({ entry: e, phrase, inter, seedHits });
  }
  scored.sort((a, b) => b.phrase - a.phrase || b.inter - a.inter || b.seedHits - a.seedHits || a.entry.id.localeCompare(b.entry.id));
  return scored;
}

// ── 영수증(별도 장부 — attach.jsonl 무접촉) ─────────────────────────────────────
// 구현검증 blocker(ab-5): append→전체 read→재작성 사이에 다른 창이 append하면 그 영수증이 옛
// 스냅샷 재작성에 덮여 소실(다중 창 실측 재현) — append와 트림을 같은 파일 잠금 안에서 수행.
// R2 blocker(fix-induced): withFileLockStrict는 보유자 사망(ESRCH 확정)을 'dead-lock-holder'로
// 보고만 하고 회수하지 않아, 강제 종료(sup-5) 한 번 뒤 모든 영수증이 조용히 영구 실패했다 —
// 사망 확정 잠금은 잔존 파일을 회수(unlink)하고 1회 재시도(확립된 dead=pid 확인 회수 규약의 적용).
// 공용 잠금 쓰기(v2 자동층과 공유): withFileLockStrict+사망 격리 회수+선회수 absent 재획득 —
// R2~R5 왕복으로 확정된 관용구의 단일 구현(경위 영수증·자동층 장부가 같은 정의를 참조).
function lockedWrite(lockF, fn) {
  const attempt = () => CL.withFileLockStrict(lockF, fn);
  let w = attempt();
  if (!w.ok && /dead-lock-holder/.test(String(w.error || ""))) {
    try {
      const raw = fs.readFileSync(lockF, "utf8");
      const q = CL.quarantineContractLock(lockF, raw);
      // 격리 성공+'이미 없음(absent — 타 창 선회수)'만 재획득 — changed/alive/owner-unverified는
      // 활성 잠금 불가침(회수·재시도 없이 실패 유지). 확립 관용구 단일 경로.
      if (q && (q.ok || q.reason === "absent")) w = attempt();
    } catch (e) {
      if (e && e.code === "ENOENT") w = attempt(); // 첫 판독 자체가 선회수 이후 — 정상 재획득만
    }
  }
  return w;
}
function appendProvenanceUsage(rec) {
  try {
    fs.mkdirSync(path.dirname(PROVENANCE_USAGE_FILE), { recursive: true });
    const lockF = PROVENANCE_USAGE_FILE + ".lock";
    const w = lockedWrite(lockF, () => {
      fs.appendFileSync(PROVENANCE_USAGE_FILE, JSON.stringify(rec) + "\n", "utf8");
      const lines = fs.readFileSync(PROVENANCE_USAGE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > USAGE_TRIM_AT) CL.atomicWrite(PROVENANCE_USAGE_FILE, lines.slice(-USAGE_TRIM_AT).join("\n") + "\n");
      return true;
    });
    return !!(w && w.ok);
  } catch { return false; }
}

// ── why 선조회(2트랙에서도 동작 — 색인 검색만·지도 부품 미접촉) ────────────────
function queryProvenance(repoRoot, queryText, opts) {
  // [v2] 병합 조회: 사람층+자동층(fresh만·사람 가림 우선 — reducer·지문 실효는 mergedEntriesFor 담당)
  const merged = mergedEntriesFor(repoRoot);
  const idx = { ok: merged.index === "ok", reason: merged.index, entries: merged.human.concat(merged.auto) };
  // 씨앗 가점을 why 경로에도 결속(구현검증 보완 — 동봉 경로와 정렬키 동형)
  let seeds = [];
  try { const MR = require(path.join(__dirname, "map-retrieval.js")); seeds = MR.extractSeeds(String(queryText || "")).seeds || []; } catch { seeds = []; }
  const matches = idx.ok ? matchDecisions(idx.entries, queryText, seeds) : [];
  const top = matches.slice(0, (opts && opts.limit) || 5);
  const receiptOk = appendProvenanceUsage({
    ts: new Date().toISOString(), kind: "query", repo: String(repoRoot || ""),
    // 구현검증 blocker(ab-7): 질의 원문은 비밀값·개인정보를 담을 수 있어 평문 기록 금지 —
    // 지문(sha1 16자)+길이만 기록(영수증 목적='찾아봤다'의 증명이라 원문 불요).
    queryFp: crypto.createHash("sha1").update(String(queryText || ""), "utf8").digest("hex").slice(0, 16),
    queryLen: String(queryText || "").length,
    index: idx.ok ? "ok" : idx.reason,
    matched: top.map((m) => m.entry.id), // 0건도 기록 — '찾아봤다'의 영수증(부재 증명의 얕은 종료 방지)
  });
  // R2 blocker: 영수증 실패를 조용히 삼키지 않는다 — 호출자(CLI)가 receiptOk=false를 고지.
  return { ok: true, index: idx.ok ? "ok" : idx.reason, matches: top, receiptOk };
}

// ── 동봉 구획(설계 §2 — 게이트 앞 독립·상한 2건·색인 부재=null=현행 바이트 동일) ──
function provenanceSectionFor(repoRoot, reqText, lang) {
  if (typeof reqText !== "string" || !reqText.trim()) return null;
  // [v2] 병합 동봉: 사람층+자동층(fresh만) — 색인·자동층 모두 비면 구획 부재(v1 무회귀)
  const merged = mergedEntriesFor(repoRoot);
  const idx = { ok: merged.index === "ok", entries: merged.human.concat(merged.auto) };
  if (!idx.ok || !idx.entries.length) return null;
  let seeds = [];
  try { const MR = require(path.join(__dirname, "map-retrieval.js")); seeds = MR.extractSeeds(reqText).seeds || []; } catch { seeds = []; }
  const top = matchDecisions(idx.entries, reqText, seeds).slice(0, ATTACH_MAX);
  if (!top.length) return null;
  const en = lang === "en";
  const head = en ? "[Design provenance] Related past decisions (advisory — verdict rules unaffected):"
                  : "[설계 경위] 관련 과거 결정(참고 — 판정 기준 아님):";
  const rows = top.map((m) => "- " + m.entry.id + " · " + m.entry.title + " — " + String(m.entry.decision || "").slice(0, 120)
    + (m.entry.source ? (en ? " (source: " : " (정본: ") + String(m.entry.source).slice(0, 160) + ")" : ""));
  appendProvenanceUsage({ ts: new Date().toISOString(), kind: "attach", repo: String(repoRoot || ""), matched: top.map((m) => m.entry.id) });
  return { text: [head, ...rows].join("\n"), items: top.map((m) => m.entry.id) };
}

// ── 진단 규율 안내(설계 §3 — scoutMode 독립·색인 존재 시에만 1줄·양 구현자 훅이 호출) ──
function buildProvenanceNotice(ws, c) {
  try {
    const repo = (CL.resolveScoutRepo ? (CL.resolveScoutRepo(ws, c || {}) || {}).repo : null) || ws;
    if (!repo || !fs.existsSync(indexFileFor(repo))) return null;
    const en = CL.loadLang() === "en";
    return en
      ? "[Design provenance] For why/history questions (past decisions, \"why is it like this\"), run `" + require(path.join(__dirname, "contract-lib.js")).bridgeCmd("codex-bridge.js") + " why \"<question>\"` before concluding — the query itself is receipted, even at 0 hits."
      : "[설계 경위] 경위(왜/결정 이력) 질문이면 결론 전에 `" + require(path.join(__dirname, "contract-lib.js")).bridgeCmd("codex-bridge.js") + " why \"<질문>\"` 선조회 — 0건이어도 조회 자체가 영수증으로 남습니다.";
  } catch { return null; }
}


// =============== v2 자동층 — 등재 자동화 (설계 V2-0~V2-6 · 5왕복 동결) ===============
// 권위 경계: 이 장부는 비정책·비차단 참고 뷰 — 수칙서·정책 op 권위와 무관(자동 승격 없음).
const AUTO_BASE = path.join(CL.BRIDGE_DIR, "map-provenance");
function repoKeyFor(repo) {
  let r = String(repo || "");
  try { r = fs.realpathSync(r); } catch { /* 실경로 불가=원문 키(결정론 유지) */ }
  return CL.wsKeyFor(r);
}
function autoLedgerFileFor(repoKey) { return path.join(AUTO_BASE, String(repoKey) + ".jsonl"); }

// 민감 경로 판정 — enrich-providers의 공용 정의를 참조(복사 금지·로드 실패=보수적으로 민감 취급)
function isSensitiveProvenancePath(p) {
  try { const EP = require(path.join(__dirname, "enrich-providers.js")); return !!EP.isSensitiveEnrichPath(p); }
  catch { return true; }
}

// sourceRef 안전 경계(V2-2 ab-7): repo 상대 경로만·절대/.. 거부·realpath containment·민감 제외
function validateSourceFile(repoRoot, file) {
  const f = String(file || "").replace(/\\/g, "/");
  if (!f || path.isAbsolute(f) || /^[A-Za-z]:/.test(f) || f.split("/").includes("..")) return { ok: false, reason: "path-form" };
  if (isSensitiveProvenancePath(f)) return { ok: false, reason: "sensitive" };
  let real, rootReal;
  try { real = fs.realpathSync(path.join(repoRoot, f)); } catch { return { ok: false, reason: "missing" }; }
  try { rootReal = fs.realpathSync(repoRoot); } catch { return { ok: false, reason: "repo-missing" }; }
  const rel = path.relative(rootReal, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: "escape" }; // symlink/junction 탈출 거부
  // R2 blocker①(ab-7): 선언 경로가 무해해도 실경로가 저장소 '내부 민감 파일'을 가리키는 별칭
  // (docs/public.md → .env symlink)을 우회 못 하게 — 실경로의 repo 상대 표기에 민감 판정 재적용.
  if (isSensitiveProvenancePath(rel.replace(/\\/g, "/"))) return { ok: false, reason: "sensitive-target" };
  return { ok: true, real: real };
}

// anchor 해석(V2-2): heading:<원문>[#k](유일 또는 서수) | lines:<s>-<e>(끝줄 포함·개행 바이트 포함)
function resolveAnchor(repoRoot, file, anchor) {
  const v = validateSourceFile(repoRoot, file);
  if (!v.ok) return { ok: false, reason: v.reason };
  let raw; try { raw = fs.readFileSync(v.real, "utf8"); } catch { return { ok: false, reason: "unreadable" }; }
  const hasTrail = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (hasTrail) lines.pop();
  const joinSpan = (s, e) => lines.slice(s, e).join("\n") + (e < lines.length || hasTrail ? "\n" : "");
  const a = String(anchor || "");
  if (a.startsWith("heading:")) {
    let h = a.slice(8), k = 0;
    const om = /^(.*)#([0-9]+)$/.exec(h);
    if (om) { h = om[1]; k = parseInt(om[2], 10); }
    const idxs = [];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].replace(/\r$/, "");
      if (/^#{1,6}\s/.test(L) && L.replace(/^#{1,6}\s+/, "").trim() === h.trim()) idxs.push(i);
    }
    if (!idxs.length) return { ok: false, reason: "anchor-missing" };
    if (idxs.length > 1 && !om) return { ok: false, reason: "anchor-ambiguous" }; // 중복 헤딩=서수 필수
    if (om && (k < 1 || k > idxs.length)) return { ok: false, reason: "anchor-ordinal" };
    const s = idxs[om ? k - 1 : 0];
    const lvl = (lines[s].match(/^#+/) || ["#"])[0].length;
    let e = lines.length;
    for (let i = s + 1; i < lines.length; i++) {
      const mm = lines[i].replace(/\r$/, "").match(/^(#{1,6})\s/);
      if (mm && mm[1].length <= lvl) { e = i; break; }
    }
    return { ok: true, text: joinSpan(s, e) };
  }
  const lm = /^lines:([0-9]+)-([0-9]+)$/.exec(a);
  if (lm) {
    const s = parseInt(lm[1], 10), e = parseInt(lm[2], 10);
    if (!(s >= 1 && e >= s)) return { ok: false, reason: "anchor-form" };
    if (e > lines.length) return { ok: false, reason: "anchor-range" };
    return { ok: true, text: joinSpan(s - 1, e) };
  }
  return { ok: false, reason: "anchor-form" };
}

function excerptShaOf(text) { return crypto.createHash("sha1").update(String(text), "utf8").digest("hex"); }
function subjectKeyOf(file, anchor) {
  return crypto.createHash("sha1").update(String(file || "").replace(/\\/g, "/") + "#" + String(anchor || ""), "utf8").digest("hex");
}

function readAutoLedger(repoKey) {
  try {
    return fs.readFileSync(autoLedgerFileFor(repoKey), "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
// 자동층 soft cap(V2-4·V2-5): 상한 진입 시 compaction — 의미 레코드(entry·tombstone·tombstone-retract)는
// '전부' 본문에 보존하고(활성 판독=본문 담당·fresh 후보 전열까지 필요해 어떤 세대도 못 버림),
// 잘리는 원시줄(형식 손상·정확 중복·옛 재작성 증표)만 트림 아카이브 관용구(별도 archive 파일·
// 2단 커밋·nonce 재작성 증표 — 일지 :2955 계보)로 무손실 보관한다. 활성 의미 상태가 상한을 넘는
// 극단에선 보존 우선 예외(파일은 사람·사건 결정 속도로만 성장). 히스테리시스: 마지막 재작성 증표
// 이후 STEP만큼 새 줄이 쌓이기 전엔 재진입하지 않는다(매 append 전량 재작성 방지).
const AUTO_TRIM_AT = 2000;
const AUTO_TRIM_STEP = 400;
const AUTO_KINDS = new Set(["entry", "tombstone", "tombstone-retract"]);
function compactAutoLedgerLocked(f, opts) {
  const o = opts || {};
  const trimAt = Number.isInteger(o.trimAt) ? o.trimAt : AUTO_TRIM_AT;
  const step = Number.isInteger(o.step) ? o.step : AUTO_TRIM_STEP;
  let raw; try { raw = fs.readFileSync(f, "utf8"); } catch { return; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= trimAt) return;
  // 히스테리시스(R1 blocker②): 증표는 재작성 직후 '전체 줄 수'(postLines)를 기록하고, 재진입은
  // '현재 줄 수 − postLines ≥ STEP'(마지막 재작성 이후 실제 추가분)일 때만. 증표 위치(항상 맨 앞)로
  // 세면 활성 의미 상태가 상한을 넘는 soft cap 예외 상태에서 매 append 전량 재작성이 된다(반례 실측).
  let lastMk = null;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].indexOf('"kind":"trim-rewrite"') >= 0) {
    try { const p = JSON.parse(lines[i]); if (p && p.kind === "trim-rewrite") lastMk = p; } catch { /* 손상 증표=무시 */ }
    break;
  }
  if (lastMk && Number.isInteger(lastMk.postLines) && lines.length - lastMk.postLines < step) return;
  const af = f.replace(/\.jsonl$/, "") + ".archive.jsonl";
  const nowTs = new Date().toISOString();
  // 아카이브 프레이밍(R1 blocker① ab-5): 마커(trim-archive/trim-commit)는 '{'로 시작하는 JSON 객체 줄,
  // 보존 원시줄은 JSON.stringify(원문 줄) — 항상 '"'로 시작하는 문자열 줄. 원시줄이 어떤 내용이든
  // (마커 모양 포함) 문자열로 감싸져 마커와 구조적으로 절대 혼동되지 않는다(복원=JSON.parse 1회 —
  // 무손실). 문자열 검색(lastIndexOf) 기반 마커 탐지는 보존 payload 오인·절단 사고라 금지.
  // 2단 커밋 회수: 말미 마커가 미커밋이면 — 본문에 그 nonce의 재작성 증표 존재⇔커밋 보수 /
  // 부재⇔미교체(그 배치를 절단 후 재적재 — 잘린 줄들이 본문에 그대로 있어 유실 없음).
  try {
    if (fs.existsSync(af)) {
      const aLines = fs.readFileSync(af, "utf8").split(/\r?\n/).filter((l) => l.length);
      let mi = -1, mk = null;
      for (let i = aLines.length - 1; i >= 0; i--) {
        if (!aLines[i].startsWith("{")) continue; // 원시줄('"' 시작)은 구조상 마커 후보에서 제외
        let p = null; try { p = JSON.parse(aLines[i]); } catch { p = null; }
        if (p && p.type === "trim-archive" && p.batchSha) { mi = i; mk = p; break; }
      }
      if (mk) {
        const committed = aLines.slice(mi + 1).some((l) => {
          if (!l.startsWith("{")) return false;
          try { const p = JSON.parse(l); return p && p.type === "trim-commit" && p.batchSha === mk.batchSha; } catch { return false; }
        });
        if (!committed) {
          const nTok = '"nonce":"' + String(mk.nonce || "") + '"';
          const rewriteHappened = typeof mk.nonce === "string" && mk.nonce.length >= 16
            && lines.some((l) => l.indexOf('"kind":"trim-rewrite"') >= 0 && l.indexOf(nTok) >= 0);
          if (rewriteHappened) fs.appendFileSync(af, JSON.stringify({ ts: nowTs, type: "trim-commit", batchSha: mk.batchSha, from: "recover(커밋 보수)" }) + "\n", "utf8");
          else fs.writeFileSync(af, aLines.slice(0, mi).map((l) => l + "\n").join(""), "utf8"); // 미교체 배치만 절단(앞선 커밋 배치 무접촉)
        }
      }
    }
  } catch { return; } // 회수 실패=이번 트림 보류(원본 무손실)
  const seen = new Set();
  const kept = [], dropped = [];
  for (const l of lines) {
    let rec = null; try { rec = JSON.parse(l); } catch { rec = null; }
    const semantic = rec && AUTO_KINDS.has(String(rec.kind || "entry")); // kind 부재=초기 entry 호환
    if (semantic && !seen.has(l)) { seen.add(l); kept.push(l); } else dropped.push(l); // 손상·미지 kind(옛 증표 포함)·정확 중복만 절단
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  const outHead = (n) => JSON.stringify({ kind: "trim-rewrite", nonce, postLines: n, ts: nowTs });
  const out = [outHead(kept.length + 1)].concat(kept); // postLines=재작성 직후 전체 줄 수(증표 포함)
  try {
    if (dropped.length) {
      const batchSha = excerptShaOf(dropped.join("\n"));
      fs.appendFileSync(af, JSON.stringify({ ts: nowTs, type: "trim-archive", n: dropped.length, batchSha, nonce, preLines: lines.length, postLines: out.length, from: "auto-ledger-trim(원시 보존)" }) + "\n"
        + dropped.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
      if (CL.atomicWrite(f, out.join("\n") + "\n")) {
        try { fs.appendFileSync(af, JSON.stringify({ ts: nowTs, type: "trim-commit", batchSha }) + "\n", "utf8"); } catch { /* 다음 트림이 보수 */ }
      }
    } else CL.atomicWrite(f, out.join("\n") + "\n"); // 절단분 0 — 증표만 심어 히스테리시스 기준점(soft cap 예외 상태)
  } catch { /* 아카이브 실패=트림 보류(fail-closed — 적재는 이미 성공) */ }
}
function appendAutoRecords(repoKey, recs, opts) {
  const f = autoLedgerFileFor(repoKey);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { return false; }
  const w = lockedWrite(f + ".lock", () => {
    fs.appendFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    try { compactAutoLedgerLocked(f, opts); } catch { /* compaction 실패는 적재 성공을 바꾸지 않음 */ }
    return true;
  });
  return !!(w && w.ok);
}

// 병합 reducer(V2-4 — 5단·append 순서 무관 결정론). 순수 함수(시험이 직접 실행).
function reduceAutoCandidates(records) {
  const retracted = new Set(records.filter((r) => r && r.kind === "tombstone-retract").map((r) => String(r.targetTombstoneId)));
  const tombs = records.filter((r) => r && r.kind === "tombstone" && !retracted.has(String(r.tombstoneId)))
    .filter((r) => !(r.scope === "event" && !r.eventRef)); // 유효성: event scope는 eventRef 필수
  const bySubject = new Map();
  for (const r of records) {
    if (!r || (r.kind && r.kind !== "entry") || !r.subjectKey) continue;
    if (!bySubject.has(r.subjectKey)) bySubject.set(r.subjectKey, []);
    bySubject.get(r.subjectKey).push(r);
  }
  const out = [];
  for (const [sk, list] of bySubject) {
    if (tombs.some((tb) => tb.subjectKey === sk && tb.scope === "subject")) continue; // (2) subject 억제
    const evT = tombs.filter((tb) => tb.subjectKey === sk && tb.scope === "event");
    const cands = list.filter((e) => !evT.some((tb) =>
      String(tb.eventRef) === String((e.origin || {}).eventRef) && (tb.gen === undefined || Number(tb.gen) === Number(e.gen)))); // (3) event 세대 제거
    if (!cands.length) continue;
    // (4) gen 수치 내림차순(사전순 금지 — 10>2)·동률 (subjectKey,eventRef,ts) 사전순 tie-break
    cands.sort((a, b) => (Number(b.gen) - Number(a.gen))
      || String((a.origin || {}).eventRef).localeCompare(String((b.origin || {}).eventRef))
      || String(a.ts).localeCompare(String(b.ts)));
    out.push(cands);
  }
  return out.sort((a, b) => String(a[0].subjectKey).localeCompare(String(b[0].subjectKey)));
}
// subject별 대표 1건(순수 논리 시험용) — 선발 순서만: freshness는 mergedEntriesFor가 후보 전열에서 판정
function reduceAutoEntries(records) { return reduceAutoCandidates(records).map((c) => c[0]); }

// 등재(수확 공용 꼬리): repoKey 재검증(ab-1)·지문 대조(기록 시점과 다르면 대기 — 옛 증명 승계 금지)·멱등
function registerAutoEntries(repoRoot, refs, origin) {
  const rkNow = repoKeyFor(repoRoot);
  const results = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (String((ref && ref.repoKey) || "") !== rkNow) { results.push({ ok: false, reason: "repo-mismatch" }); continue; }
    // R2 blocker②: contentHash는 필수 — 없으면 사건이 어떤 바이트를 증명했는지 알 수 없어
    // 과거 사건이 '현재' 원문을 재수확하는 승계 경로가 열린다(설계 V2-2 계약).
    if (!/^[0-9a-f]{40}$/.test(String((ref && ref.contentHash) || ""))) { results.push({ ok: false, reason: "no-content-hash" }); continue; }
    const rv = resolveAnchor(repoRoot, ref.file, ref.anchor);
    if (!rv.ok) { results.push({ ok: false, reason: rv.reason }); continue; }
    const sha = excerptShaOf(rv.text);
    if (ref.contentHash !== sha) { results.push({ ok: false, reason: "content-drift" }); continue; } // 새 사건 결속만(재수확 게이트)
    const sk = subjectKeyOf(ref.file, ref.anchor);
    const recs = readAutoLedger(rkNow);
    const dupe = recs.some((r) => (!r.kind || r.kind === "entry") && r.subjectKey === sk
      && String((r.origin || {}).eventRef) === String(origin.eventRef) && (r.source || {}).excerptSha === sha);
    if (dupe) { results.push({ ok: true, skipped: "dup" }); continue; } // 멱등(같은 사건·같은 내용)
    const gen = recs.filter((r) => (!r.kind || r.kind === "entry") && r.subjectKey === sk)
      .reduce((m, r) => Math.max(m, Number(r.gen) || 0), 0) + 1;
    const entry = {
      kind: "entry", id: "A-" + sk.slice(0, 8) + "-g" + gen, subjectKey: sk, gen, ts: new Date().toISOString(),
      title: String(origin.title || "").slice(0, 200),
      source: { file: String(ref.file).replace(/\\/g, "/"), anchor: String(ref.anchor), excerptSha: sha },
      excerpt: rv.text.slice(0, 240), // 표시용 절단(지문은 구간 전체 — V2-2)
      // keywords 안전 원천(ab-7): 발췌 토큰+사건 구조 필드만 — 질의 원문 토큰 금지
      keywords: [...new Set([...tokenize(rv.text.slice(0, 400)), ...tokenize(String(origin.title || ""))])].slice(0, 24),
      origin: { eventKind: String(origin.eventKind || ""), eventRef: String(origin.eventRef || ""), repoKey: rkNow, registeredAt: new Date().toISOString() },
    };
    results.push(appendAutoRecords(rkNow, [entry]) ? { ok: true, id: entry.id, gen } : { ok: false, reason: "write" });
  }
  return { ok: results.every((x) => x.ok !== false), results };
}

// 사람 거부·철회(V2-4 — 대시보드·시험 표면)
function appendTombstone(repoRoot, opts) {
  const o = opts || {};
  if (o.scope !== "event" && o.scope !== "subject") return { ok: false, reason: "scope" };
  if (o.scope === "event" && !o.eventRef) return { ok: false, reason: "eventRef-required" };
  if (!/^[0-9a-f]{40}$/.test(String(o.subjectKey || ""))) return { ok: false, reason: "subjectKey" };
  const rec = { kind: "tombstone", tombstoneId: crypto.randomUUID(), subjectKey: o.subjectKey, scope: o.scope };
  if (o.eventRef) rec.eventRef = String(o.eventRef);
  if (Number.isInteger(o.gen)) rec.gen = o.gen;
  rec.ts = new Date().toISOString();
  return appendAutoRecords(repoKeyFor(repoRoot), [rec]) ? { ok: true, tombstoneId: rec.tombstoneId } : { ok: false, reason: "write" };
}
function retractTombstone(repoRoot, targetTombstoneId) {
  const rk = repoKeyFor(repoRoot);
  const recs = readAutoLedger(rk);
  const target = recs.find((r) => r.kind === "tombstone" && String(r.tombstoneId) === String(targetTombstoneId));
  if (!target) return { ok: false, reason: "target-missing" }; // 철회는 실존 tombstoneId 결속(V2-1 유효성)
  const rec = { kind: "tombstone-retract", subjectKey: target.subjectKey, targetTombstoneId: String(targetTombstoneId), ts: new Date().toISOString() };
  return appendAutoRecords(rk, [rec]) ? { ok: true } : { ok: false, reason: "write" };
}

// 병합 조회(사람층 우선·자동층은 fresh만 — 지문 불일치=자동 실효·매칭 제외·재수확은 새 사건만)
function mergedEntriesFor(repoRoot) {
  const idx = parseDecisionsIndex(repoRoot);
  const human = idx.ok ? idx.entries : [];
  const hidden = new Set();
  for (const h of human) for (const s of h.overrides || []) hidden.add(s);
  const rk = repoKeyFor(repoRoot);
  const perSubject = reduceAutoCandidates(readAutoLedger(rk));
  const auto = [];
  let stale = 0;
  for (const cands of perSubject) {
    if (hidden.has(cands[0].subjectKey)) continue; // (5) 사람 가림 우선
    // R2 blocker③: 최신 gen 1건만 보지 않고 후보 전열에서 '첫 fresh'를 선발 — 정본이 이전 검증
    // 내용으로 되돌아온 정상 흐름에서 이전 fresh 세대가 살아남는다. 전부 stale일 때만 실효 집계.
    let picked = null;
    for (const e of cands) {
      const rv = resolveAnchor(repoRoot, (e.source || {}).file, (e.source || {}).anchor);
      if (rv.ok && excerptShaOf(rv.text) === (e.source || {}).excerptSha) { picked = e; break; }
    }
    if (!picked) { stale++; continue; }
    const e = picked;
    auto.push({ id: e.id, title: e.title, decision: String(e.excerpt || ""),
      source: (e.source || {}).file + " " + (e.source || {}).anchor, keywords: e.keywords || [], subjectKey: e.subjectKey, auto: true,
      eventRef: String((e.origin || {}).eventRef || ""), gen: Number(e.gen) || 0 }); // 대시보드 거부(scope) 결속용(V2-4 표면)
  }
  return { index: (idx.ok || auto.length) ? "ok" : idx.reason, human, auto, staleCount: stale };
}

// 수확기 (a): 해소 완결 finding(자격=최신 처분 fix-fact+dispositionValid+resolved close.round>=최신 활동)
function harvestFromResolvedFinding(ws, repoRoot, campaignId, findingId, repoKey) {
  try {
    // [저장소 분할 단일 규칙 · 5판 blocker④(ab-1)] 처분·종결·활동 라운드는 호출자(종결 판)의 저장소 표식 행에서만 조합 —
    // B의 fix-fact 처분이 A의 종결과 결합해 B 지도에 자동 항목을 쓰는 경로 차단(빈 키=종전 전체 축퇴 — 구 호출 호환).
    const rows = CL.ledgerRowsForRepo(CL.readFindingsLedger(ws), repoKey);
    const disps = rows.filter((r) => r.type === "disposition" && r.campaignId === campaignId && r.findingId === findingId);
    const latest = disps[disps.length - 1];
    if (!latest || latest.choice !== "fix-fact") return { ok: false, reason: "disposition" };
    if (!CL.dispositionValid(rows, campaignId, latest)) return { ok: false, reason: "disposition-stale" };
    const closes = rows.filter((r) => r.type === "close" && r.campaignId === campaignId && r.findingId === findingId && r.closeReason === "resolved");
    const lastClose = closes[closes.length - 1];
    const act = CL.findingActivityRound(rows, campaignId, findingId);
    if (!lastClose || !(Number(lastClose.round) >= act)) return { ok: false, reason: "close-round" }; // 옛 close 재사용 차단(R4)
    const refs = Array.isArray(latest.sourceRefs) ? latest.sourceRefs : [];
    if (!refs.length) return { ok: false, reason: "no-source" }; // 후보 대기(휴리스틱 추측 금지)
    // R2 blocker⑤(ab-1): 수확 대상=사건에 저장된 저장소(처분 기록 시점 repoPath·repoKey) —
    // close 시점의 '현재 정찰 대상'이 아님(A에서 처분→정상적으로 B 전환 후 close돼도 A 사건은
    // A 저장소로 수확). repoKey 지문 재검증으로 경로 이동·오귀속 차단(불일치=후보 대기).
    const evRepo = String(latest.repoPath || repoRoot || "");
    if (!evRepo) return { ok: false, reason: "no-repo" };
    if (latest.repoKey && repoKeyFor(evRepo) !== String(latest.repoKey)) return { ok: false, reason: "repo-mismatch" };
    const f0 = rows.filter((r) => r.type === "finding" && r.findingId === findingId).pop();
    return registerAutoEntries(evRepo, refs, { eventKind: "finding-resolved", eventRef: findingId, title: (f0 && f0.title) || findingId });
  } catch { return { ok: false, reason: "exception" }; }
}

// intent 사건의 증명 참조 — 증명 바이트=사건 레코드(선택 시점 canonical 정책)의 파이프라인 직렬화
// (map-pipeline 정책 기록기와 동일 서식 JSON.stringify(policy,null,1)·무꼬리개행 — lines:1-N은 그런
// 파일의 전체 바이트와 정확히 일치). 수확 시점의 '현재 파일'은 지문 원천이 아니라 등재 게이트의
// 대조 대상일 뿐: 서식만 바뀐 파일(canonical 동일=done 판독은 유지)은 content-drift로 후보 대기가
// 되고, 옛 사건이 새 원문 바이트를 증명하는 경로가 없다. 직렬화가 어긋난 정상 파일도 미수확(후보
// 대기)으로만 기울며 거짓 증명 방향으로는 열리지 않는다(fail-closed).
function intentPolicyRefFor(repoRoot, policy) {
  const expected = JSON.stringify(policy, null, 1);
  return { file: "project-map/policies/" + policy.policyId + ".json", anchor: "lines:1-" + expected.split("\n").length,
    contentHash: excerptShaOf(expected), repoKey: repoKeyFor(repoRoot) };
}

// 수확기 (b): intent-choice 완결(자격=phase=done+applied decision·정책 파일 일치 — 완결 판독기 재사용)
function harvestFromIntentChoices(repoRoot) {
  try {
    const MI = require(path.join(__dirname, "map-intent.js"));
    const read = MI.readConflictChoices(repoRoot);
    if (!read || read.st !== "ok") return { ok: false, reason: "choices-" + String(read && read.st) };
    const results = [];
    for (const rec of read.records || []) {
      if (rec.phase !== "done") continue;
      const done = MI.completedConflictDecisionFor(repoRoot, rec);
      if (!done || !done.ok) continue; // 적용·정책 파일 일치 전=자격 없음
      const policy = rec.patchCanonical && rec.patchCanonical.payload && rec.patchCanonical.payload.policy;
      if (!policy || !policy.policyId) continue;
      const ref = intentPolicyRefFor(repoRoot, policy); // 지문=사건 유도(현재 파일 판독 없음)
      const title = String(policy.predicateDescription || policy.policyId).slice(0, 200);
      results.push(registerAutoEntries(repoRoot, [ref], { eventKind: "intent-choice", eventRef: rec.cardId, title }));
    }
    return { ok: true, results };
  } catch { return { ok: false, reason: "exception" }; }
}

// 수확기 (c): 수칙서 승인 사건 — 승인 시 선기록된 append-only 사건 레코드(도장 실존 검사는 수확 시)
function approvalEventsFileFor(repoKey) { return path.join(AUTO_BASE, String(repoKey) + ".approvals.jsonl"); }
// 승인 원자 결속(설계 V2-2): 사건 append와 도장을 '같은 잠금 구간'에서 선기록→도장. 도장 함수는
// 잠금 보유 중 실행되며(중첩 순서는 승인 사건 잠금→계약/전이 잠금 한 방향뿐 — 역순 획득 지점이
// 없어 교착 불가), 도장 실패·예외여도 사건은 잔존한다(계약의 도장 지문과 불일치=수확 미자격이
// 그 자체로 미완 표지 — harvestFromApprovals가 승인 지문 일치를 재확인).
function recordApprovalWithStamp(repoRoot, ev, stampFn) {
  const rk = repoKeyFor(repoRoot);
  const f = approvalEventsFileFor(rk);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { return { ok: false, recorded: false, stamped: false }; }
  // [재편 A §2-2] target(core|archive)·candidateRefs{candidateId,titleFp,whyFp?}를 스키마에 편입 —
  // whyFp는 why 보유 kind만(legacy=부재가 정상 표식). 지문만 저장(전문은 후보 장부가 정본·ab-7 최소화).
  const cRefs = Array.isArray(ev && ev.candidateRefs)
    ? ev.candidateRefs.filter((r) => r && typeof r.candidateId === "string" && r.candidateId)
      .map((r) => ({ candidateId: r.candidateId, ...(typeof r.titleFp === "string" && r.titleFp ? { titleFp: r.titleFp } : {}), ...(typeof r.whyFp === "string" && r.whyFp ? { whyFp: r.whyFp } : {}) }))
    : [];
  const rec = { approvalTs: new Date().toISOString(), envelopeHash: String((ev && ev.envelopeHash) || ""),
    candidateId: (ev && ev.candidateId) || null, askId: (ev && ev.askId) || null, repoKey: rk,
    ...(ev && (ev.target === "archive" || ev.target === "core") ? { target: ev.target } : {}),
    ...(cRefs.length ? { candidateRefs: cRefs } : {}),
    sourceRefs: Array.isArray(ev && ev.sourceRefs) ? ev.sourceRefs : [] };
  const w = lockedWrite(f + ".lock", () => {
    fs.appendFileSync(f, JSON.stringify(rec) + "\n", "utf8");
    let stamped = false;
    try { stamped = typeof stampFn === "function" ? !!stampFn() : true; } catch { stamped = false; }
    return { recorded: true, stamped };
  });
  if (!(w && w.ok)) return { ok: false, recorded: false, stamped: false };
  return { ok: true, recorded: true, stamped: !!(w.result && w.result.stamped) };
}
function appendApprovalEvent(repoRoot, ev) { return recordApprovalWithStamp(repoRoot, ev, () => true).recorded; }
function harvestFromApprovals(ws, repoRoot) {
  try {
    const rk = repoKeyFor(repoRoot);
    let rows = [];
    try {
      rows = fs.readFileSync(approvalEventsFileFor(rk), "utf8").split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return { ok: true, results: [] }; }
    const c = CL.loadContract(ws);
    // [재편 A §2-2] 자격 대조 target-aware — 서고(target archive) 승인 사건의 지문은 archiveHash와 대조해야
    // 한다(코어 지문 단일 대조는 서고 사건을 영구 미자격으로 만들던 결함). target 없는 legacy 사건=코어 대조(무회귀).
    const stampedCore = String((c && c.envelopeHash) || ""); // 도장 실존: 승인 지문 일치 사건만 자격(선기록 후 도장 실패=미자격)
    const stampedArc = String((c && c.archiveHash) || "");
    const results = [];
    for (const ev of rows) {
      const want = ev.target === "archive" ? stampedArc : stampedCore;
      if (!ev.envelopeHash || !want || ev.envelopeHash !== want) continue;
      if (!Array.isArray(ev.sourceRefs) || !ev.sourceRefs.length) continue; // 후보 대기
      results.push(registerAutoEntries(repoRoot, ev.sourceRefs, { eventKind: "envelope-approval", eventRef: ev.envelopeHash.slice(0, 16), title: "검증 경계 승인 결정" }));
    }
    return { ok: true, results };
  } catch { return { ok: false, reason: "exception" }; }
}

module.exports = {
  INDEX_REL, PROVENANCE_USAGE_FILE, USAGE_TRIM_AT, ATTACH_MAX, AUTO_BASE, AUTO_TRIM_AT, AUTO_TRIM_STEP,
  indexFileFor, parseDecisionsIndex, tokenize, matchDecisions, lockedWrite,
  appendProvenanceUsage, queryProvenance, provenanceSectionFor, buildProvenanceNotice,
  // v2 자동층
  repoKeyFor, autoLedgerFileFor, approvalEventsFileFor, validateSourceFile, resolveAnchor, excerptShaOf, subjectKeyOf,
  readAutoLedger, appendAutoRecords, reduceAutoEntries, reduceAutoCandidates, registerAutoEntries,
  appendTombstone, retractTombstone, mergedEntriesFor,
  harvestFromResolvedFinding, intentPolicyRefFor, harvestFromIntentChoices,
  recordApprovalWithStamp, appendApprovalEvent, harvestFromApprovals,
};
