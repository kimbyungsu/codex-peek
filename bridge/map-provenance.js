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
    if (kw.some((k) => proto.has(k))) { rejected.push({ id, reason: "protocol-vocab" }); continue; } // 규약 어휘 거부
    entries.push({ id, title, decision, source, keywords: kw });
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
function appendProvenanceUsage(rec) {
  try {
    fs.mkdirSync(path.dirname(PROVENANCE_USAGE_FILE), { recursive: true });
    const lockF = PROVENANCE_USAGE_FILE + ".lock";
    const attempt = () => CL.withFileLockStrict(lockF, () => {
      fs.appendFileSync(PROVENANCE_USAGE_FILE, JSON.stringify(rec) + "\n", "utf8");
      const lines = fs.readFileSync(PROVENANCE_USAGE_FILE, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > USAGE_TRIM_AT) CL.atomicWrite(PROVENANCE_USAGE_FILE, lines.slice(-USAGE_TRIM_AT).join("\n") + "\n");
      return true;
    });
    let w = attempt();
    if (!w.ok && /dead-lock-holder/.test(String(w.error || ""))) {
      // R3 TOCTOU 반례: 판정~삭제 사이에 다른 창이 사망 잠금을 회수하고 '새 활성 잠금'을 만들면
      // 직접 unlink가 그 활성 잠금을 지운다(실측 deletedToken:"live-B") — 회수는 확립된 격리
      // 관용구(quarantineContractLock: 원문 expect 대조+사망 재판정+rename 후 실물 재확인+무클로버
      // 복원)로만 수행하고, 실패(changed/alive 등)면 회수 없이 실패로 끝낸다(활성 잠금 불가침).
      try {
        const raw = fs.readFileSync(lockF, "utf8");
        const q = CL.quarantineContractLock(lockF, raw);
        // R5 blocker: 격리 성공뿐 아니라 '이미 없음(absent — 타 창이 먼저 회수)'도 재획득 시도 —
        // 첫 판독과 격리 내부 판독 사이의 선회수 창에서 영수증이 누락되던 인터리빙 봉합.
        // changed/alive/owner-unverified는 활성 잠금 불가침 — 회수·재시도 없이 실패 유지.
        if (q && (q.ok || q.reason === "absent")) w = attempt();
      } catch (e) {
        if (e && e.code === "ENOENT") w = attempt(); // 첫 판독 자체가 선회수 이후 — 정상 재획득 시도만
      }
    }
    return !!(w && w.ok);
  } catch { return false; }
}

// ── why 선조회(2트랙에서도 동작 — 색인 검색만·지도 부품 미접촉) ────────────────
function queryProvenance(repoRoot, queryText, opts) {
  const idx = parseDecisionsIndex(repoRoot);
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
  const idx = parseDecisionsIndex(repoRoot);
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
      ? "[Design provenance] For why/history questions (past decisions, \"why is it like this\"), run `node codex-bridge.js why \"<question>\"` before concluding — the query itself is receipted, even at 0 hits."
      : "[설계 경위] 경위(왜/결정 이력) 질문이면 결론 전에 `node codex-bridge.js why \"<질문>\"` 선조회 — 0건이어도 조회 자체가 영수증으로 남습니다.";
  } catch { return null; }
}

module.exports = {
  INDEX_REL, PROVENANCE_USAGE_FILE, USAGE_TRIM_AT, ATTACH_MAX,
  indexFileFor, parseDecisionsIndex, tokenize, matchDecisions,
  appendProvenanceUsage, queryProvenance, provenanceSectionFor, buildProvenanceNotice,
};
