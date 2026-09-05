"use strict";
/*
 * [CURATION v3 — 독립 큐레이션(HARNESS-REALIGNMENT §7 5번) · 2026-09-03 구현 1·2단계]
 * 헌법: 수칙을 넣고 빼자고 제안하는 쪽은 답안 쓴 사람이 아니라 장부를 읽는 독립 실행이고, 제안은 소수이며, 자격은 이력이 아니라 성격이다.
 * 사용자는 승인·빼기만 한다. 검증 경로는 이 실행을 기다리지도 참조하지도 않는다(P1).
 *
 * 부품 B 입력 집계기 curationInput(ws, repo) — 전부 장부 판독(코드·소스 판독 없음)·개인정보 원문 없음(제목·id·횟수·지문).
 * 부품 C 제안기 — selector-runner 페이지 1회(purpose:"curate")·팔=계약 유래 selectorArmForCuration(ws, c)·출력 JSON·손상=전량 거부.
 * 부품 D 커밋 — 후보 장부 2단(provisional → 결과 행 → proposed)+selectorUsage 영수증(purpose:"curate"·turnAnchor=curationKey).
 *   승인 시 변환(add·oos-add·remove)은 contract-lib.draftCuratorCandidate — 기존 초안 관문(repoKey·세대·중복·title) 완화 없음.
 * 유계: 회당 제안 ≤ CURATION_MAX_PER_RUN(3)·미승인 누적 ≤ CURATION_MAX_PENDING(6) — 초과=보류·영수증만. "제안 없음"도 영수증.
 * 팔 실행 잠금 curate.lock(구조화 토큰·죽은 소유자만 회수)·동시 1개·같은 ws. 실패=영수증+경보(curation-failed)·검증 무영향.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require("./contract-lib.js");

const CURATION_DIR = path.join(CL.BRIDGE_DIR, "curation");
const CURATION_MAX_PER_RUN = 3;     // P2 소수 강제 — 실행 1회당 제안 상한
const CURATION_MAX_PENDING = 6;     // P2 — 미승인(proposed) 누적 상한(초과=새 제안 보류·영수증만)
const CURATION_WHY_MIN = 8;
const CURATION_WHY_MAX = CL.CONSTRAINT_WHY_MAX;        // 120 — 약속 발화 why와 같은 상한
const CURATION_EXPLAIN_MAX = 200;                       // 사용자 표현 4요소 각 상한
const CURATION_OPERATIONS = ["add", "oos-add", "remove", "toggle"]; // toggle=1차 보류 표시(연결쌍은 2차)
const CURATION_UNUSED_DAYS = 30;    // unused-rule 신호 임계(트리거용 — 입력에는 일수만 실림)
const CURATION_ITEM_MAX = 200;      // 문안 상한(ENVELOPE_CHAR_MAX와 동형)
const ENVELOPE_AXES = ["supportedEnv", "alwaysBlocker", "outOfScope"];
const RULE_REDACTED = "[민감 형태 — 문안 생략]"; // ab-7: 수칙·질문 원문 대체 표식(프롬프트·후보 title)
const CURATE_LOCK_STALE_MS = 15 * 60 * 1000; // 산 pid라도 이 시간 넘은 잠금은 손상으로 본다(페이지 timeout 8분+여유)

function sha1(s) { return crypto.createHash("sha1").update(String(s), "utf8").digest("hex"); }
function itemFpOf(text) { return sha1(CL.normBacklogTitle(String(text))); } // 초안 관문 removeItems[].itemFp와 같은 규칙
function curationFileFor(ws) { return path.join(CURATION_DIR, CL.wsKeyFor(ws) + ".jsonl"); }
function curateLockFileFor(ws) { return path.join(CURATION_DIR, CL.wsKeyFor(ws) + ".lock"); }
function oneLine(s, max) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, max); }

// ── 팔 결정(P4) — 구현 턴 환경변수가 아니라 계약의 운용 모드로: claude-codex→self(claude 격리) · codex-codex→codex(빈 임시 폴더·읽기 전용).
function selectorArmForCuration(ws, c) {
  const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  return cc && cc.harnessMode === "codex-codex" ? "codex" : "self";
}

// ── 큐레이션 장부(실행·결과 행 — 후보 행은 후보 장부에) ──
function readCurationRows(ws) {
  let rows = [];
  try { rows = String(fs.readFileSync(curationFileFor(ws), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.schema === "curation-v1" && r.wsKey === CL.wsKeyFor(ws)); } catch { rows = []; }
  return rows;
}
function appendCurationRow(ws, row) {
  const rec = Object.assign({ schema: "curation-v1", wsKey: CL.wsKeyFor(ws), ts: new Date().toISOString() }, row);
  const line = JSON.stringify(rec) + "\n";
  try { fs.mkdirSync(CURATION_DIR, { recursive: true }); fs.appendFileSync(curationFileFor(ws), line); } catch { return { ok: false, reason: "write-failed" }; }
  try { if (!String(fs.readFileSync(curationFileFor(ws), "utf8")).endsWith(line)) return { ok: false, reason: "read-back-mismatch" }; } catch { return { ok: false, reason: "read-back-failed" }; }
  return { ok: true, rec };
}

// ── 부품 B 입력 집계기 ──
// 반환 {ok:true, wsKey, repoKey, boundaryGen, archiveGen, rules:{core[], archive[]}, signals:{...}, decisions:{open[], answered[]}, signalCount, inputFp}
//     | {ok:false, reason}
// 민감정보 형태 문자열은 입력·프롬프트·장부 어디에도 원문으로 싣지 않는다(ab-7) — 제목은 생략, 질문은 표식으로 대체.
function safeText(s, max) { const v = oneLine(s, max); if (!v) return ""; const r = CL.safeBacklogAutoTitle(v); return r.ok ? v : ""; }
// 신호 ①~④ 산출 함수 — 기본은 codex-bridge.computeEnvelopeCandidatesFor. CLI 실행처럼 순환 require로 부재이면 호출자가 opts.computeCandidates로 넘긴다(1회차 blocker①).
function resolveComputeCandidates(opts) {
  if (opts && typeof opts.computeCandidates === "function") return opts.computeCandidates;
  try { const CB = require("./codex-bridge.js"); if (typeof CB.computeEnvelopeCandidatesFor === "function") return CB.computeEnvelopeCandidatesFor; } catch { /* 아래 null */ }
  return null;
}
function curationInput(ws, repo, opts) {
  const c = (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!c) return { ok: false, reason: "contract-unreadable" };
  let cur; try { cur = CL.resolveScoutRepo(ws, c).repo; } catch { return { ok: false, reason: "repo-mismatch" }; }
  if (CL.normWs(String(cur || "")) !== CL.normWs(String(repo || ""))) return { ok: false, reason: "repo-mismatch" }; // P6·ab-1: 정찰 대상 결속
  const wsKey = CL.wsKeyFor(ws), repoKey = CL.repoKeyOf(repo);
  const gen = typeof c.envelopeHash === "string" && c.envelopeHash ? c.envelopeHash : null;
  if (!gen) return { ok: false, reason: "envelope-inactive" };
  const env = CL.readVerifyEnvelope(repo);
  if (!env || env.st !== "ok" || env.sha1 !== gen) return { ok: false, reason: "envelope-drift" }; // 미승인 변경=공급 보류(주입 규칙과 동형)
  const arcHash = typeof c.archiveHash === "string" && c.archiveHash ? c.archiveHash : null;
  const ar = CL.readVerifyEnvelopeArchive(repo);
  if (arcHash) { if (ar.st !== "ok" || ar.sha1 !== arcHash) return { ok: false, reason: "archive-drift" }; }
  else if (ar.st !== "absent") return { ok: false, reason: "archive-unstamped" }; // 도장 없는 서고 파일=무단·손상 — 판독 거부(보수)
  // 수칙 원문도 민감 형태면 생략(ab-7 — 2회차 blocker②): 프롬프트·remove 후보 title에는 표식만, itemFp는 원문 기준(3중 대조 무변).
  const ruleItem = (t) => { const v = safeText(t, CURATION_ITEM_MAX); return v ? { text: v, redacted: false } : { text: RULE_REDACTED, redacted: true }; };
  const core = [];
  for (const ax of ENVELOPE_AXES) (env.data[ax] || []).forEach((t, i) => core.push(Object.assign({ axis: ax, index: i, itemFp: itemFpOf(t) }, ruleItem(t))));
  const archive = arcHash ? ar.data.alwaysBlocker.map((t, i) => Object.assign({ id: "arc-" + (i + 1), axis: "alwaysBlocker", index: i, itemFp: itemFpOf(t) }, ruleItem(t))) : [];
  // 신호 ①~④ — 대시보드 '참고 신호'와 같은 산출(computeEnvelopeCandidatesFor.signals — 캠페인·세대 결속)
  const sig = { oosRepeat: [], lineage: [], escalation: [], unusedOos: [], unusedRules: [], rebutUsed: [], selOver: { count: 0, lastTs: "" } };
  let signalsGen = null;
  const computeCandidates = resolveComputeCandidates(opts);
  if (!computeCandidates) return { ok: false, reason: "signals-unavailable" }; // 핵심 신호 산출 불가=입력 실패(신호 0으로 위장 금지 — 1회차 blocker①)
  let cc = null;
  try { cc = computeCandidates(ws, { rowFilter: (r) => r && r.repoKey === repoKey }); } catch { return { ok: false, reason: "signals-failed" }; } // 행의 repoKey===현재 저장소만(ab-1 — 집계기 내부의 캠페인 id·세대 필터로는 창 교대 오귀속을 못 막음)
  signalsGen = cc && cc.gen ? cc.gen : null;
  // [ab-1] 현재 캠페인 카운터의 저장소 표식이 이 저장소일 때만 캠페인 신호를 받는다(표식 없음·다른 저장소=0 — 같은 작업 폴더에서 정찰 대상을 오간 경우)
  const campRepoOk = (() => { try { const o = JSON.parse(fs.readFileSync(CL.campaignFileFor(ws), "utf8")); return !!(o && o.repoKey === repoKey); } catch { return false; } })();
  if (cc && campRepoOk && (cc.gen || null) === gen) for (const s of (cc.signals || [])) {
    const row = { id: s.kind + ":" + String(s.key || ""), key: String(s.key || ""), n: Number(s.n) || 1, titles: (s.titles || []).map((t) => safeText(t, 120)).filter(Boolean).slice(0, 3) }; // 민감 형태 제목=생략(ab-7)
    if (s.kind === "oos-repeat") sig.oosRepeat.push(row); else if (s.kind === "lineage") sig.lineage.push(row); else if (s.kind === "escalation") sig.escalation.push(row); else if (s.kind === "unused-oos") sig.unusedOos.push(row);
  }
  // ⑤ 미사용 보관 수칙 — 미리보기(purpose:"preview")와 검증 선별(askId 있는 행·purpose 없음) 둘 다 '사용'으로 셈. 관측 0건이면 주장하지 않는다.
  if (arcHash && archive.length) {
    try {
      const recs = CL.readSelectorUsage().filter((r) => r && r.wsKey === wsKey && r.repoKey === repoKey && r.archiveHash === arcHash && (r.purpose === "preview" || (!r.purpose && typeof r.askId === "string" && r.askId))); // repoKey 결속(표식 없는 옛 영수증=불산입 — ab-1)
      if (recs.length) {
        const used = new Set(); let earliest = null;
        for (const r of recs) { for (const id of (Array.isArray(r.selectedIds) ? r.selectedIds : [])) used.add(String(id)); const t = Date.parse(String(r.ts || "")); if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t; }
        const days = earliest === null ? 0 : Math.floor((Date.now() - earliest) / 86400000);
        for (const it of archive) if (!used.has(it.id)) sig.unusedRules.push({ id: "unused-rule:" + it.id, itemId: it.id, index: it.index, itemFp: it.itemFp, receipts: recs.length, days });
      }
    } catch { /* 영수증 판독 실패=신호 생략 */ }
  }
  // ⑥ 되받아침에 쓰인 제외 칸(P12) — 처분 장부 rebut(oosId) 횟수 · 행의 기록 시점 저장소 표식(repoKey)이 이 저장소인 것만(ab-1: 캠페인 id 대리 매핑은 한 캠페인이 두 저장소에 속하는 창 교대에서 무너짐 — 확인검증 반례)
  try {
    const byOos = new Map();
    for (const r of CL.readFindingsLedger(ws)) if (r && r.type === "disposition" && r.choice === "rebut" && typeof r.oosId === "string" && r.oosId && r.repoKey === repoKey) byOos.set(r.oosId, (byOos.get(r.oosId) || 0) + 1);
    for (const [oosId, n] of byOos) sig.rebutUsed.push({ id: "rebut:" + oosId, oosId, n });
  } catch { /* 장부 판독 실패=생략 */ }
  // ⑦ 선별 정상 범위 초과(attach 장부 selOver — 같은 작업 폴더)
  try {
    const wsN = CL.normWs(String(ws));
    for (const l of String(fs.readFileSync(CL.ATTACH_USAGE_FILE, "utf8")).split(/\r?\n/)) {
      if (!l) continue; let o = null; try { o = JSON.parse(l); } catch { continue; }
      if (o && o.selOver && CL.normWs(String(o.ws || "")) === wsN && o.repoKey === repoKey) { sig.selOver.count++; sig.selOver.lastTs = String(o.ts || sig.selOver.lastTs); } // 저장소 표식 결속(표식 없는 옛 행=불산입 — ab-1)
    }
  } catch { /* 장부 없음=0 */ }
  // ⑧ 결정 장부(방향 힌트 — 제안 근거로만) · 행의 기록 시점 저장소 표식(repoKey)이 이 저장소인 결정만(ab-1 — 캠페인 대리 매핑 폐기·표식 없는 옛 결정=제외·보수)
  const decisions = { open: [], answered: [] };
  try {
    const d = CL.readDecisions(ws, { repoKey }); // 4판 blocker: 필터 판독(같은 id가 두 저장소에 열린 옛 상태에서 무필터 latest는 이 저장소 항목을 먼저 잃음)
    for (const r of d.latest.values()) {
      if (String(r.repoKey || "") !== repoKey) continue;
      const q9 = safeText(r.question, 200);
      const row = { id: "decision:" + r.decisionId, decisionId: r.decisionId, kind: String(r.kind || ""), question: q9 || RULE_REDACTED }; // ab-7: 질문 원문이 민감 형태면 표식만
      if (r.status === "open") decisions.open.push(row); else decisions.answered.push(Object.assign(row, { choice: String(r.choice || "") }));
    }
    decisions.open = decisions.open.slice(-20); decisions.answered = decisions.answered.slice(-20);
  } catch { /* 장부 없음 */ }
  const signalCount = sig.oosRepeat.length + sig.lineage.length + sig.escalation.length + sig.unusedOos.length + sig.unusedRules.length + sig.rebutUsed.length + (sig.selOver.count ? 1 : 0);
  // 입력 표 지문 — 시각 성분 없이(같은 입력=같은 키·멱등)
  const fpSrc = { repoKey, gen, arcHash, core: core.map((x) => x.axis + ":" + x.itemFp), archive: archive.map((x) => x.itemFp),
    s: { a: sig.oosRepeat.map((x) => x.id + "#" + x.n), b: sig.lineage.map((x) => x.id + "#" + x.n), c: sig.escalation.map((x) => x.id), d: sig.unusedOos.map((x) => x.id), e: sig.unusedRules.map((x) => x.id), f: sig.rebutUsed.map((x) => x.id + "#" + x.n), g: sig.selOver.count },
    dec: decisions.open.map((x) => x.decisionId).concat(decisions.answered.map((x) => x.decisionId + "=" + x.choice)) };
  return { ok: true, wsKey, repoKey, boundaryGen: gen, archiveGen: arcHash, signalsGen, rules: { core, archive }, signals: sig, decisions, signalCount, inputFp: sha1(JSON.stringify(fpSrc)) };
}
function curationKeyOf(input) { return sha1("curation:" + input.wsKey + "|" + input.repoKey + "|" + input.boundaryGen + "|" + String(input.archiveGen || "") + "|" + input.inputFp); }

// ── [1회차 blocker④] 중단 복구 — 결과 행(type result)이 있는데 fresh 후보가 활성화(proposed) 전에 종료됐으면 provisional 행에서 proposed 행을 재발급한다.
// 결과 행이 복구 표지: 같은 curationKey의 fresh id 중 닫힌 status 열거 행이 하나도 없는(=latest에 없는) 후보만 대상. 멱등(재실행 무해).
function recoverCurationProvisional(ws) {
  let rows; try { rows = String(fs.readFileSync(CL.envelopeCandidatesFileFor(ws), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return { recovered: 0 }; }
  const { latest } = CL.readEnvelopeCandidates(ws);
  const out = [];
  for (const res of readCurationRows(ws)) {
    if (res.type !== "result" || !Array.isArray(res.fresh)) continue;
    for (const cid of res.fresh) {
      if (latest.has(cid + "@" + String(res.boundaryGen || ""))) continue; // 활성화(또는 이후 전이) 행 존재=복구 불필요
      const prov = rows.find((r) => r && r.candidateId === cid && r.status === "provisional" && String(r.envelopeHash || "") === String(res.boundaryGen || "") && r.curationKey === res.curationKey);
      if (!prov) continue;
      out.push(Object.assign({}, prov, { status: "proposed", note: "중단 복구 — 결과 행 표지로 활성화", ts: new Date().toISOString() }));
    }
  }
  if (out.length && !CL.appendEnvelopeCandidates(ws, out)) return { recovered: 0, failed: out.length };
  return { recovered: out.length };
}

// ── 실행 생략 규칙(§3 B): 모든 신호가 0이고 코어·서고 세대가 마지막 실행과 같으면 페이지 호출 없이 "제안 없음" 영수증. 같은 입력 표(curationKey)의 결과가 이미 있으면 멱등 생략.
function curationSkip(ws, input) {
  const rows = readCurationRows(ws).filter((r) => r.repoKey === input.repoKey);
  const key = curationKeyOf(input);
  if (rows.some((r) => r.type === "result" && r.curationKey === key)) return { skip: true, reason: "same-input" };
  if (input.signalCount === 0) {
    const last = [...rows].reverse().find((r) => r.type === "run" && r.outcome !== "skipped");
    if (last && last.boundaryGen === input.boundaryGen && String(last.archiveGen || "") === String(input.archiveGen || "")) return { skip: true, reason: "no-signal" };
  }
  return { skip: false };
}

// ── 부품 C 제안기 프롬프트 — 범주 지시·중립 재료(장부 표+수칙 전문에 axis·index·itemFp 병기). 검증 요청문(구현자 작문)은 입력 아님.
function buildCurationPrompt(input, lang) {
  const en = lang === "en";
  const L = [];
  L.push(en ? "You are an independent rulebook curator. You read ledgers only (no code) and propose at most 3 changes to the project's rulebook — or none."
    : "당신은 독립 수칙 정리 담당입니다. 코드가 아니라 장부만 읽고, 프로젝트 수칙서에 대한 변경을 최대 3건 제안하거나 — 아무것도 제안하지 않습니다.");
  L.push(en ? "Constitution: a rule qualifies by its NATURE (a principle that spans the whole project), never by history alone (a bug that was fixed). Prefer no proposal over a weak one."
    : "헌법: 수칙 자격은 '성격'(프로젝트를 관통하는 지침)이지 이력(고쳐진 결함)이 아닙니다. 약한 제안보다 무제안이 낫습니다.");
  L.push(en ? "Operations: add (new archive rule, target archive/alwaysBlocker) · oos-add (new out-of-scope line, target core/outOfScope) · remove (drop the item you cite by axis+index+itemFp exactly as listed) · toggle (move between core and archive — recorded as held, not acted on)."
    : "작업 종류: add(서고에 새 수칙 — target archive·axis alwaysBlocker) · oos-add(코어 제외 칸에 새 줄 — target core·axis outOfScope) · remove(아래 목록의 axis·index·itemFp를 그대로 인용해 빼기) · toggle(코어↔서고 전환 — 보류로만 기록됨).");
  L.push(en ? "Rules: why ≤120 chars, one line, no secrets/personal data. refs must be ids from the signal list below (do not invent). Wording that duplicates an existing item is rejected. Do not quote code."
    : "규칙: why는 한 줄 120자 이내·비밀값·개인정보 금지. refs는 아래 신호 목록의 id만(지어내지 말 것). 기존 항목과 같은 문안은 거부됩니다. 코드 인용 금지.");
  L.push(en ? "Output exactly one JSON object and nothing else: {\"proposals\":[{\"operation\":\"add|oos-add|remove|toggle\",\"target\":\"core|archive\",\"axis\":\"supportedEnv|alwaysBlocker|outOfScope\",\"title\":\"<rule text, ≤200 chars — required for add/oos-add>\",\"index\":<number — remove/toggle>,\"itemFp\":\"<40 hex — remove/toggle>\",\"why\":\"<nature>\",\"refs\":[\"<signal id>\"],\"recommend\":\"always|related\",\"explain\":{\"happened\":\"…\",\"ifAdopted\":\"…\",\"ifNot\":\"…\",\"recommend\":\"…\"}}]} — use {\"proposals\":[]} for none. explain fields are plain-language situations (no jargon), each ≤200 chars."
    : "출력은 JSON 객체 하나뿐(다른 글 금지): {\"proposals\":[{\"operation\":\"add|oos-add|remove|toggle\",\"target\":\"core|archive\",\"axis\":\"supportedEnv|alwaysBlocker|outOfScope\",\"title\":\"<수칙 문안 200자 이내 — add/oos-add 필수>\",\"index\":<번호 — remove/toggle>,\"itemFp\":\"<40자 hex — remove/toggle>\",\"why\":\"<성격>\",\"refs\":[\"<신호 id>\"],\"recommend\":\"항상|관련\",\"explain\":{\"happened\":\"있었던 일\",\"ifAdopted\":\"올리면 달라지는 것\",\"ifNot\":\"안 올리면 유지되는 것\",\"recommend\":\"권장과 근거\"}}]} — 제안 없음은 {\"proposals\":[]}. explain 4칸은 기술용어 없는 상황 설명(각 200자 이내).");
  L.push("");
  L.push(en ? "[Current rulebook — core (axis · index · itemFp · text)]" : "[현재 수칙서 — 코어(axis · index · itemFp · 문안)]");
  if (!input.rules.core.length) L.push("(none)");
  for (const it of input.rules.core) L.push(`${it.axis} ${it.index} ${it.itemFp} ${it.text}`);
  L.push(en ? "[Current rulebook — archive (id · index · itemFp · text)]" : "[현재 수칙서 — 서고(id · index · itemFp · 문안)]");
  if (!input.rules.archive.length) L.push(en ? "(no archive)" : "(서고 없음)");
  for (const it of input.rules.archive) L.push(`${it.id} ${it.index} ${it.itemFp} ${it.text}`);
  L.push("");
  L.push(en ? "[Signals — ledger aggregates; ids are the only valid refs]" : "[신호 — 장부 집계 · id만 refs로 유효]");
  const s = input.signals;
  const dump = (label, arr, f) => { L.push(label + (arr.length ? "" : (en ? " (none)" : " (없음)"))); for (const x of arr) L.push("- " + f(x)); };
  dump(en ? "repeated out-of-scope demotions:" : "범위 밖 강등 반복:", s.oosRepeat, (x) => `${x.id} ×${x.n}${x.titles.length ? " — " + x.titles.join(" / ") : ""}`);
  dump(en ? "repeated blocker lineages:" : "같은 계보 blocker 반복:", s.lineage, (x) => `${x.id} ×${x.n}${x.titles.length ? " — " + x.titles.join(" / ") : ""}`);
  dump(en ? "admission-escalated scope expansions:" : "입장 심사 승격 확장:", s.escalation, (x) => `${x.id}${x.titles.length ? " — " + x.titles.join(" / ") : ""}`);
  dump(en ? "never-triggered out-of-scope items (30+ items only):" : "한 번도 발동 안 한 제외 칸(30항 이상일 때만):", s.unusedOos, (x) => `${x.id}${x.titles.length ? " — " + x.titles.join(" / ") : ""}`);
  dump(en ? "archive rules never selected:" : "한 번도 선별되지 않은 보관 수칙:", s.unusedRules, (x) => `${x.id} (index ${x.index}, ${x.receipts} receipts over ${x.days} days)`);
  dump(en ? "out-of-scope lines used in rebuttals:" : "되받아침에 쓰인 제외 칸:", s.rebutUsed, (x) => `${x.id} ×${x.n}`);
  L.push((en ? "selection over normal range: " : "선별 정상 범위 초과: ") + s.selOver.count + (s.selOver.lastTs ? " (last " + s.selOver.lastTs + ")" : ""));
  L.push("");
  L.push(en ? "[Decisions — direction hints only]" : "[결정 장부 — 방향 힌트로만]");
  dump(en ? "open:" : "미답:", input.decisions.open, (x) => `${x.id} [${x.kind}] ${x.question}`);
  dump(en ? "answered:" : "답함:", input.decisions.answered, (x) => `${x.id} [${x.kind}] ${x.question} → ${x.choice}`);
  return L.join("\n");
}

// ── 파서 — 손상(JSON 아님·proposals 배열 아님·3건 초과·작업 종류 밖·필수 필드 형식 위반)=전량 거부(fail-closed). 의미 거부(중복·민감·미지 refs)=항목 탈락+사유 기록.
function parseCurationOutput(raw, input) {
  const text = String(raw || "").trim();
  // "JSON 객체 하나뿐" — 앞뒤 산문·코드 울타리 등 다른 글이 있으면 손상(1회차 blocker②). 첫 글자 '{'·끝 글자 '}'가 아니면 거부.
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, reason: "no-json" };
  let o = null; try { o = JSON.parse(text); } catch { return { ok: false, reason: "bad-json" }; }
  if (!o || typeof o !== "object" || !Array.isArray(o.proposals)) return { ok: false, reason: "no-proposals-array" };
  if (o.proposals.length > CURATION_MAX_PER_RUN) return { ok: false, reason: "too-many" };
  const known = new Set();
  const s = input.signals;
  for (const arr of [s.oosRepeat, s.lineage, s.escalation, s.unusedOos, s.unusedRules, s.rebutUsed]) for (const x of arr) known.add(x.id);
  if (s.selOver.count) known.add("selover");
  for (const x of input.decisions.open.concat(input.decisions.answered)) known.add(x.id);
  const existing = new Set();
  for (const it of input.rules.core) if (!it.redacted) existing.add(CL.normBacklogTitle(it.text));
  for (const it of input.rules.archive) if (!it.redacted) existing.add(CL.normBacklogTitle(it.text));
  const items = [], held = [], dropped = [];
  const seen = new Set();
  for (const p of o.proposals) {
    if (!p || typeof p !== "object") return { ok: false, reason: "row-not-object" };
    const op = String(p.operation || "");
    if (!CURATION_OPERATIONS.includes(op)) return { ok: false, reason: "bad-operation" };
    const target = op === "add" ? "archive" : op === "oos-add" ? "core" : (p.target === "archive" ? "archive" : p.target === "core" ? "core" : "");
    if (!target) return { ok: false, reason: "bad-target" };
    const axis = op === "add" ? "alwaysBlocker" : op === "oos-add" ? "outOfScope" : String(p.axis || "");
    if (target === "archive" ? axis !== "alwaysBlocker" : !ENVELOPE_AXES.includes(axis)) return { ok: false, reason: "bad-axis" };
    if (typeof p.why !== "string" || /[\r\n\u2028\u2029]/.test(p.why)) return { ok: false, reason: "bad-why" }; // 한 줄 계약 — 개행=손상(공백 치환 관용 없음)
    const why = p.why.trim();
    if (why.length < CURATION_WHY_MIN || why.length > CURATION_WHY_MAX) return { ok: false, reason: "bad-why" };
    const ex = p.explain && typeof p.explain === "object" ? p.explain : null;
    if (!ex) return { ok: false, reason: "no-explain" };
    const explain = {};
    for (const k of ["happened", "ifAdopted", "ifNot", "recommend"]) { if (typeof ex[k] !== "string" || /[\r\n\u2028\u2029]/.test(ex[k])) return { ok: false, reason: "bad-explain" }; const v = ex[k].trim(); if (!v || v.length > CURATION_EXPLAIN_MAX) return { ok: false, reason: "bad-explain" }; explain[k] = v; }
    const refs = Array.isArray(p.refs) ? p.refs.map((x) => String(x)) : [];
    const rec = { operation: op, target, axis, why, refs, explain, recommend: (p.recommend === "always" || p.recommend === "항상") ? "항상" : (p.recommend === "related" || p.recommend === "관련") ? "관련" : "" };
    // 의미 검사
    const drop = (reason) => { dropped.push({ operation: op, target, axis, reason }); };
    const ws9 = CL.safeBacklogAutoTitle(why); if (!ws9.ok) { drop("why-sensitive-" + ws9.reasonKey); continue; }
    { let bad9 = null; for (const k of Object.keys(explain)) { const e9 = CL.safeBacklogAutoTitle(explain[k]); if (!e9.ok) { bad9 = k + "-" + e9.reasonKey; break; } } if (bad9) { drop("explain-sensitive-" + bad9); continue; } } // ab-7: 설명 4칸도 장부에 남는 글
    if (refs.some((r) => !known.has(r))) { drop("unknown-ref"); continue; }
    if (op === "add" || op === "oos-add") {
      const title = typeof p.title === "string" ? p.title.replace(/\s+/g, " ").trim() : "";
      if (!title || title.length > CURATION_ITEM_MAX) { drop("bad-title"); continue; }
      const ts9 = CL.safeBacklogAutoTitle(title); if (!ts9.ok) { drop("title-sensitive-" + ts9.reasonKey); continue; }
      const tn = CL.normBacklogTitle(title);
      if (title === RULE_REDACTED) { drop("bad-title"); continue; } // 표식 문안을 새 수칙으로 올리는 것=무의미
      if (existing.has(tn)) { drop("duplicate"); continue; }
      const dk = op + "|" + target + "|" + axis + "|" + tn; if (seen.has(dk)) { drop("duplicate-in-run"); continue; } seen.add(dk);
      existing.add(tn);
      items.push(Object.assign(rec, { title, occurrence: "-" }));
      continue;
    }
    // remove·toggle — 제안 시점 번호+항목 지문이 목록과 정확히 일치해야(같은 문안 두 줄이면 번호가 구분)
    const list = target === "archive" ? input.rules.archive : input.rules.core.filter((x) => x.axis === axis);
    const idx = Number.isInteger(p.index) ? p.index : -1;
    const hit = list.find((x) => x.index === idx);
    if (!hit || String(p.itemFp || "") !== hit.itemFp) { drop("target-mismatch"); continue; }
    const dk = op + "|" + target + "|" + axis + "|" + idx; if (seen.has(dk)) { drop("duplicate-in-run"); continue; } seen.add(dk);
    const row = Object.assign(rec, { title: hit.text, index: idx, itemFp: hit.itemFp, occurrence: axis + "#" + idx });
    if (op === "toggle") held.push(row); else items.push(row);
  }
  return { ok: true, items, held, dropped };
}

// ── 부품 D 커밋 — 후보 장부 2단(provisional → 결과 행 → proposed) + 영수증. 반환 {ok, candidateIds, deferred, heldToggles, dropped, pending, reason?}
function curationPendingCount(ws, repoKey, gen) {
  let n = 0;
  try { for (const rec of CL.readEnvelopeCandidates(ws).latest.values()) if (rec && rec.kind === "curator" && rec.status === "proposed" && String(rec.envelopeHash || "") === String(gen) && rec.repoKey === repoKey) n++; } catch { n = 0; }
  return n;
}
function readCandidateFileRaw(ws) { try { return String(fs.readFileSync(CL.envelopeCandidatesFileFor(ws), "utf8")); } catch { return ""; } }
function commitCuration(ws, input, parsed, meta) {
  const m = meta || {};
  const curationKey = curationKeyOf(input);
  const gen = input.boundaryGen;
  const pending = curationPendingCount(ws, input.repoKey, gen);
  const room = Math.max(0, CURATION_MAX_PENDING - pending);
  const take = parsed.items.slice(0, Math.min(CURATION_MAX_PER_RUN, room));
  const deferred = parsed.items.length - take.length;
  const ts = new Date().toISOString();
  const rowsCommon = take.map((it) => {
    const titleNorm = sha1(CL.normBacklogTitle(it.title));
    const candidateId = CL.envelopeCandidateId("curator", curationKey + "|" + it.operation + "|" + it.target + "|" + it.axis + "|" + it.occurrence + "|" + titleNorm);
    return { candidateId, envelopeHash: gen, kind: "curator", origin: "curator", policyVersion: 2, repoKey: input.repoKey, archiveHash: input.archiveGen || "",
      operation: it.operation, target: it.target, axis: it.axis, ...(it.operation === "remove" ? { index: it.index, itemFp: it.itemFp } : {}),
      expectedTargetHash: it.target === "archive" ? String(input.archiveGen || "") : gen,
      title: it.title, why: it.why, refs: it.refs, recommend: it.recommend, explain: it.explain, curationKey };
  });
  // 멱등: 같은 (candidateId, 세대) 행이 이미 있으면 재기록하지 않음
  const { latest } = CL.readEnvelopeCandidates(ws);
  const fresh = rowsCommon.filter((r) => !latest.has(r.candidateId + "@" + gen));
  const ids = fresh.map((r) => r.candidateId);
  // 결과 지문=후보 id 배열(연산·대상·축·번호·문안 지문의 함수). 같은 curationKey에 '다른 후보 집합'이 오면 result-conflict(첫 결과 권위) —
  // why·refs·explain만 다른 재응답은 같은 후보라 충돌이 아니다(첫 후보 행이 그대로 남는다 · 확인검증 [보완] f-68d4b93e 범위 명시).
  const resultFp = sha1(JSON.stringify(rowsCommon.map((r) => r.candidateId)));
  // 결과 행 중복 대조(같은 curationKey의 다른 결과=fail-closed)
  const prevRes = readCurationRows(ws).find((r) => r.type === "result" && r.curationKey === curationKey);
  if (prevRes && prevRes.resultFp !== resultFp) return { ok: false, reason: "result-conflict", curationKey };
  if (fresh.length) {
    // ① provisional(비노출 — 닫힌 status 열거 밖이라 latest 판독이 무시) → read-back(원시 행)
    const prov = fresh.map((r) => Object.assign({}, r, { status: "provisional", ts }));
    if (!CL.appendEnvelopeCandidates(ws, prov)) return { ok: false, reason: "provisional-write", curationKey };
    const raw1 = readCandidateFileRaw(ws);
    for (const r of prov) if (!raw1.includes(JSON.stringify(r) + "\n")) return { ok: false, reason: "provisional-read-back", curationKey };
  }
  // ② 결과 행(큐레이션 장부)
  const res = appendCurationRow(ws, { type: "result", repoKey: input.repoKey, curationKey, boundaryGen: gen, archiveGen: input.archiveGen || "", resultFp, items: rowsCommon.map((r) => r.candidateId), fresh: ids, deferred, heldToggles: parsed.held.map((h) => ({ target: h.target, axis: h.axis, index: h.index, itemFp: h.itemFp, why: h.why })), dropped: parsed.dropped, pendingBefore: pending, arm: m.arm || "", durationMs: Number(m.durationMs) || 0 });
  if (!res.ok) return { ok: false, reason: "result-" + res.reason, curationKey };
  // ③ 활성화 행 proposed(같은 필드 전부 재기록) → read-back
  if (fresh.length) {
    const act = fresh.map((r) => Object.assign({}, r, { status: "proposed", ts: new Date().toISOString() }));
    if (!CL.appendEnvelopeCandidates(ws, act)) return { ok: false, reason: "proposed-write", curationKey };
    const raw2 = readCandidateFileRaw(ws);
    for (const r of act) if (!raw2.includes(JSON.stringify(r) + "\n")) return { ok: false, reason: "proposed-read-back", curationKey };
  }
  return { ok: true, curationKey, candidateIds: ids, proposed: rowsCommon.length, deferred, heldToggles: parsed.held.length, dropped: parsed.dropped.length, pending: pending + ids.length, resultFp };
}
// ④ 영수증 — selectorUsage(purpose:"curate"·turnAnchor=curationKey). read-back 실패=false(호출자가 경보).
function writeCurationReceipt(ws, input, fields) {
  const rec = Object.assign({ ts: new Date().toISOString(), wsKey: CL.wsKeyFor(ws), repoKey: input ? input.repoKey : "", askId: "", purpose: "curate", turnAnchor: input ? curationKeyOf(input) : "", archiveHash: input ? (input.archiveGen || "") : "", envelopeHash: input ? input.boundaryGen : "", itemCount: input ? input.rules.core.length + input.rules.archive.length : 0, pages: 0, selectedIds: [], arm: "", durationMs: 0 }, fields || {});
  const name = CL.appendSelectorUsage(rec);
  if (!name) return { ok: false };
  try { const back = JSON.parse(fs.readFileSync(path.join(CL.SELECTOR_USAGE_DIR, name), "utf8")); if (JSON.stringify(back) !== JSON.stringify(rec)) return { ok: false }; } catch { return { ok: false }; }
  return { ok: true, name };
}

// ── 잠금(ab-6): 구조화 토큰·wx 생성·죽은 소유자(또는 stale)만 회수 ──
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } }
function acquireCurateLock(ws) {
  const f = curateLockFileFor(ws);
  const token = crypto.randomBytes(8).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token, host: os.hostname() });
  try { fs.mkdirSync(CURATION_DIR, { recursive: true }); } catch { /* wx가 판정 */ }
  for (let k = 0; k < 2; k++) {
    try { fs.writeFileSync(f, payload, { flag: "wx" }); return { ok: true, token }; }
    catch (e) {
      if (!(e && e.code === "EEXIST")) return { ok: false, reason: "lock-io" };
      let cur = null; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { cur = null; }
      const age = cur && cur.ts ? Date.now() - Date.parse(cur.ts) : Infinity;
      const dead = !cur || !pidAlive(Number(cur.pid)) || !(age < CURATE_LOCK_STALE_MS);
      if (!dead) return { ok: false, reason: "running", holder: cur };
      try { fs.renameSync(f, f + ".stale-" + Date.now()); } catch { return { ok: false, reason: "reclaim-failed" }; } // 죽은 소유자 격리 후 재선점
    }
  }
  return { ok: false, reason: "lock-contended" };
}
function releaseCurateLock(ws, token) {
  const f = curateLockFileFor(ws);
  try { const cur = JSON.parse(fs.readFileSync(f, "utf8")); if (cur && cur.token === token) fs.rmSync(f, { force: true }); } catch { /* 이미 없음·타인 소유=무접촉 */ }
}

function alarm(ws, kind, ko, en) {
  try { CL.appendIntegrityEvent({ ts: new Date().toISOString(), session: "", workspace: ws, kind, severity: "warning", detail: ko, detailKo: ko, detailEn: en }, { supersedeSameKindWs: true }); } catch { /* best-effort */ }
}

// ── 실행기 — 검증 무관·유계. opts: {force, pageRunner(시험 주입), lang, contract, timeoutMs}
async function runCuration(ws, opts) {
  const o = opts || {};
  const t0 = Date.now();
  // [§3 A] 실행 행에 트리거 종류(manual|auto|button)와 tick 지문 — 자동 판정이 '같은 신호 상태'를 두 번 실행하지 않게(tickFp 대조).
  const trig9 = o.trigger === "auto" || o.trigger === "button" ? o.trigger : "manual";
  const runRow9 = (row) => appendCurationRow(ws, Object.assign({ type: "run", trigger: trig9 }, typeof o.tickFp === "string" && o.tickFp ? { tickFp: o.tickFp } : {}, row));
  // 실패=영수증+경보(인수조건 6) — 시작 단계 실패도 같은 길(1회차 blocker⑦). 잠금 '실행 중'(running)만 정상 경합이라 영수증만 남기고 경보 없음.
  const failEarly = (st, reason, repoKey9, alarmOn) => {
    runRow9({ repoKey: repoKey9 || "", outcome: st, reason: reason || "", durationMs: Date.now() - t0 });
    writeCurationReceipt(ws, null, { repoKey: repoKey9 || "", outcome: st + (reason ? ":" + reason : ""), durationMs: Date.now() - t0 });
    if (alarmOn) alarm(ws, "curation-failed", "정리 제안 실행이 시작 단계에서 실패했습니다(" + st + (reason ? ": " + reason : "") + ") — 검증에는 영향이 없습니다.", "Curation run failed before start (" + st + (reason ? ": " + reason : "") + ") — verification is unaffected.");
    return { st, reason: reason || "" };
  };
  const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!c) return failEarly("contract-unreadable", "", "", true);
  let repo; try { repo = CL.resolveScoutRepo(ws, c).repo; } catch { return failEarly("repo-unresolved", "", "", true); }
  const lk = acquireCurateLock(ws);
  if (!lk.ok) return failEarly("locked", lk.reason, CL.repoKeyOf(repo), lk.reason !== "running");
  try {
    const rec9 = recoverCurationProvisional(ws); // 중단 복구 먼저(생략 판정이 결과 행만 보고 건너뛰기 전에)
    if (rec9.failed) { // 복구 쓰기 실패=이번 실행 실패(생략으로 위장 금지 — 2회차 blocker③④). 후보는 다음 실행이 다시 복구 시도.
      runRow9({ repoKey: CL.repoKeyOf(repo), outcome: "recover-failed", reason: String(rec9.failed), durationMs: Date.now() - t0 });
      writeCurationReceipt(ws, null, { repoKey: CL.repoKeyOf(repo), outcome: "recover-failed:" + rec9.failed, durationMs: Date.now() - t0 });
      alarm(ws, "curation-failed", "중단된 정리 제안 " + rec9.failed + "건을 다시 살리는 기록에 실패했습니다 — 다음 실행에서 재시도합니다(검증 무영향).", "Failed to re-activate " + rec9.failed + " interrupted curation proposal(s) — retried on the next run (verification unaffected).");
      return { st: "recover-failed", failed: rec9.failed };
    }
    resetTickK(ws, CL.repoKeyOf(repo)); // 이 시점부터 실행 행이 남는다(입력 실패·생략·실패·완주 전부) — "마지막 큐레이션 이후"의 기준점 갱신(K 리셋)
    const input = curationInput(ws, repo, { computeCandidates: o.computeCandidates });
    if (!input.ok) {
      runRow9({ repoKey: CL.repoKeyOf(repo), outcome: "input-failed", reason: input.reason, durationMs: Date.now() - t0 });
      writeCurationReceipt(ws, null, { repoKey: CL.repoKeyOf(repo), outcome: "input-failed:" + input.reason, durationMs: Date.now() - t0 });
      alarm(ws, "curation-failed", "정리 제안 입력을 만들 수 없었습니다(" + input.reason + ") — 수칙서·서고 상태를 확인하세요. 검증에는 영향이 없습니다.", "Curation input unavailable (" + input.reason + ") — check the rulebook/archive state; verification is unaffected.");
      return { st: "input-failed", reason: input.reason, recovered: rec9.recovered };
    }
    const skip = curationSkip(ws, input);
    if (skip.skip && !o.force) {
      runRow9({ repoKey: input.repoKey, curationKey: curationKeyOf(input), boundaryGen: input.boundaryGen, archiveGen: input.archiveGen || "", outcome: "skipped", reason: skip.reason, signalCount: input.signalCount, durationMs: Date.now() - t0 });
      writeCurationReceipt(ws, input, { outcome: "skipped:" + skip.reason, durationMs: Date.now() - t0 });
      return { st: "skipped", reason: skip.reason, curationKey: curationKeyOf(input), signalCount: input.signalCount, recovered: rec9.recovered };
    }
    const arm = selectorArmForCuration(ws, c);
    const lang = o.lang || CL.loadLang();
    const runner = typeof o.pageRunner === "function" ? o.pageRunner : require("./selector-runner.js").runSelectorPage;
    const h = runner({ arm, prompt: buildCurationPrompt(input, lang), timeoutMs: Number(o.timeoutMs) || CL.SELECTOR_PAGE_TIMEOUT_MS });
    const r = await h.promise;
    if (!r || !r.ok) {
      const key = (r && r.key) || "call-failed";
      runRow9({ repoKey: input.repoKey, curationKey: curationKeyOf(input), boundaryGen: input.boundaryGen, archiveGen: input.archiveGen || "", outcome: "failed", reason: key, arm, signalCount: input.signalCount, durationMs: Date.now() - t0 });
      writeCurationReceipt(ws, input, { arm, pages: 1, outcome: "failed:" + key, durationMs: Date.now() - t0 });
      alarm(ws, "curation-failed", "정리 제안 실행이 실패했습니다(" + key + ") — 검증에는 영향이 없고, 다음 실행에서 다시 시도합니다.", "Curation run failed (" + key + ") — verification is unaffected; it will retry on the next run.");
      return { st: "call-failed", reason: key, arm };
    }
    const parsed = parseCurationOutput(r.output, input);
    if (!parsed.ok) {
      runRow9({ repoKey: input.repoKey, curationKey: curationKeyOf(input), boundaryGen: input.boundaryGen, archiveGen: input.archiveGen || "", outcome: "failed", reason: "parse:" + parsed.reason, arm, signalCount: input.signalCount, durationMs: Date.now() - t0 });
      writeCurationReceipt(ws, input, { arm, pages: 1, outcome: "parse-failed:" + parsed.reason, durationMs: Date.now() - t0 });
      alarm(ws, "curation-failed", "정리 제안 답을 읽을 수 없어 전량 거부했습니다(" + parsed.reason + ") — 다음 실행에서 재발급합니다.", "Curation output was unreadable and rejected as a whole (" + parsed.reason + ") — reissued on the next run.");
      return { st: "parse-failed", reason: parsed.reason, arm };
    }
    const cm = commitCuration(ws, input, parsed, { arm, durationMs: Date.now() - t0 });
    if (!cm.ok) {
      runRow9({ repoKey: input.repoKey, curationKey: curationKeyOf(input), boundaryGen: input.boundaryGen, archiveGen: input.archiveGen || "", outcome: "failed", reason: "commit:" + cm.reason, arm, signalCount: input.signalCount, durationMs: Date.now() - t0 });
      writeCurationReceipt(ws, input, { arm, pages: 1, outcome: "commit-failed:" + cm.reason, durationMs: Date.now() - t0 });
      alarm(ws, "curation-failed", "정리 제안 기록이 중단됐습니다(" + cm.reason + ") — 화면에 반영되지 않았고, 다음 실행이 다시 시도합니다.", "Curation commit aborted (" + cm.reason + ") — nothing shown; the next run retries.");
      return { st: "commit-failed", reason: cm.reason, arm };
    }
    runRow9({ repoKey: input.repoKey, curationKey: cm.curationKey, boundaryGen: input.boundaryGen, archiveGen: input.archiveGen || "", outcome: cm.proposed ? "proposed" : "none", proposed: cm.proposed, fresh: cm.candidateIds.length, deferred: cm.deferred, heldToggles: cm.heldToggles, dropped: cm.dropped, arm, signalCount: input.signalCount, durationMs: Date.now() - t0 });
    const rc = writeCurationReceipt(ws, input, { arm, pages: 1, selectedIds: cm.candidateIds, outcome: cm.proposed ? "proposed:" + cm.proposed : "none", resultFp: cm.resultFp, durationMs: Date.now() - t0 });
    if (!rc.ok) alarm(ws, "curation-failed", "정리 제안 영수증 기록에 실패했습니다 — 제안은 남았지만 실행 기록이 비었습니다.", "Curation receipt write failed — proposals were stored but the run receipt is missing.");
    return Object.assign({ st: "ok", arm, receipt: rc.ok, recovered: rec9.recovered }, cm);
  } finally { releaseCurateLock(ws, lk.token); }
}

// ── [§3 A 트리거 ②③ · 3단계] 훅 tick — 두 층으로 나눈다(확인검증 1회차 blocker ab-6):
//  ⓐ 훅 안(curationHookTick): 계약·잠금·tick 상태 파일 3개만 보고(전수 판독 0) 최소 간격이 지났으면 `curate tick`을 detach — 판정 자체를 훅에서 하지 않는다.
//  ⓑ 자식(curationTickJudge → 필요 시 runCuration): 꼬리 바이트 상한 판독으로 신호를 재계산(현재 세대·열린 지적만)·마감 캠페인 누계는 tick 상태 파일에 누적
//     (캠페인 이력 60일 절단과 무관 — 1회차 blocker②)·같은 신호 상태(tickFp)는 마지막 실행과 대조해 한 번만.
const CURATION_TICK_K = 10;
const CURATION_TICK_MIN_GAP_MS = 10 * 60 * 1000;
const CURATION_TICK_THRESHOLDS = { oosRepeat: 2, lineage: 3, unusedDays: CURATION_UNUSED_DAYS, selOver: 3 };
const TICK_TAIL_BYTES = 256 * 1024;      // 장부 꼬리 판독 상한(행 단위로 앞 조각은 버림)
const TICK_RECEIPTS_MAX = 300;           // 선별 영수증 파일 판독 상한(최신순)
// [4·5회차 blocker②] 전체 seen 배열(절단됨)도, 그 시각의 '개수'(절단과 추가가 상쇄됨)도 아니다 — 워터마크 시각(hwm)과 **그 시각에 마감된 캠페인 id 집합**(hwmIds)을 보관한다.
// 같은 밀리초에 마감된 캠페인만 담기므로 실사용에서 1~2개이고(절단 상한 없음·정직), 신규 판정은 집합 차로 한다.
// tick 상태=(작업 폴더, 정찰 대상 저장소) 결속(2회차 blocker ab-1): 정찰 대상이 바뀌면 다른 파일=새 기준선 — 이전 저장소의 누계·판정이 새 저장소로 넘어가지 않는다(P6).
function curationTickFileFor(ws, repoKey) { return path.join(CURATION_DIR, CL.wsKeyFor(ws) + "." + String(repoKey || "norepo") + ".tick.json"); }
function readTickState(ws, repoKey) {
  try {
    const o = JSON.parse(fs.readFileSync(curationTickFileFor(ws, repoKey), "utf8"));
    if (o && typeof o === "object" && String(o.repoKey || "") === String(repoKey || "")) {
      const seeded = o.seeded === true && Array.isArray(o.hwmIds); // 구조 이전 상태(hwmIds 없음)=재기준선(값 유실 없이 다시 기준만 잡음)
      return { repoKey: String(repoKey || ""), k: Number.isInteger(o.k) && o.k >= 0 ? o.k : 0, hwm: String(o.hwm || ""), hwmIds: Array.isArray(o.hwmIds) ? o.hwmIds.map(String) : [], judgedAt: String(o.judgedAt || ""), ranAt: String(o.ranAt || ""), tickFp: String(o.tickFp || ""), reason: String(o.reason || ""), seeded };
    }
  } catch { /* 없음·손상=초기 */ }
  return null;
}
function writeTickState(ws, repoKey, st) { try { fs.mkdirSync(CURATION_DIR, { recursive: true }); return CL.atomicWrite(curationTickFileFor(ws, repoKey), JSON.stringify(Object.assign({}, st, { repoKey: String(repoKey || "") }))); } catch { return false; } }
// 꼬리 판독 — 마지막 maxBytes만 읽고 첫 부분 조각(잘린 행)은 버린다. 부재=[].
function readTailLines(file, maxBytes) {
  let fd = null;
  try {
    const st = fs.statSync(file); if (!st.size) return [];
    const len = Math.min(st.size, maxBytes); const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r"); fs.readSync(fd, buf, 0, len, st.size - len);
    let s = buf.toString("utf8"); if (len < st.size) { const nl = s.indexOf("\n"); s = nl >= 0 ? s.slice(nl + 1) : ""; }
    return s.split(/\r?\n/).filter(Boolean);
  } catch { return []; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } } }
}
function readTailJson(file, maxBytes) { return readTailLines(file, maxBytes).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function lockAlive(ws) {
  let cur = null; try { cur = JSON.parse(fs.readFileSync(curateLockFileFor(ws), "utf8")); } catch { return false; }
  const age = cur && cur.ts ? Date.now() - Date.parse(cur.ts) : Infinity;
  return !!(cur && pidAlive(Number(cur.pid)) && age < CURATE_LOCK_STALE_MS);
}
// 최근 선별 영수증(최신 TICK_RECEIPTS_MAX개) — 전체 디렉터리 판독 대신 이름순 꼬리
function readRecentSelectorUsage(max) {
  let names; try { names = fs.readdirSync(CL.SELECTOR_USAGE_DIR).filter((x) => x.endsWith(".json")).sort().slice(-max); } catch { return []; }
  const out = [];
  for (const nm of names) { try { const o = JSON.parse(fs.readFileSync(path.join(CL.SELECTOR_USAGE_DIR, nm), "utf8")); if (o && typeof o === "object") out.push(o); } catch { /* 손상=무시 */ } }
  return out;
}
// 신호(유계) — ③-a 반복 신호는 대시보드 산출과 같은 규칙을 '현재 세대(envelopeHash)·그 세대의 마지막 캠페인·열린 지적'으로 한정(1회차 blocker①):
// 강등 반복=같은 oosId의 강등 finding 2+(닫힘이 정상이라 open 조건 없음) · 계보=close 행이 없는 finding의 blocker 등장 고유 라운드 2+(원 등장 포함 3회).
// 이 저장소에 속한 캠페인 id 집합 — 캠페인 카운터·이력 행의 repoKey(표식 없는 옛 캠페인=불포함 — 다른 저장소 신호의 유입 차단, ab-1)
function repoCampaignIds(ws, repoKey) {
  const ids = new Set();
  try { const o = JSON.parse(fs.readFileSync(CL.campaignFileFor(ws), "utf8")); if (o && o.repoKey === repoKey && typeof o.campaignId === "string") ids.add(o.campaignId); } catch { /* 없음 */ }
  for (const h of readTailJson(CL.campaignHistoryFileFor(ws), 64 * 1024)) if (h && h.repoKey === repoKey && typeof h.campaignId === "string") ids.add(h.campaignId);
  return ids;
}
function curationTickSignals(ws, wsKey, repoKey, gen, arcHash, archiveN) {
  const s = { oosRepeat: 0, lineage: 0, unusedDays: 0, unusedCount: 0, selOver: 0 };
  try {
    const rows = readTailJson(CL.findingsLedgerFileFor(ws), TICK_TAIL_BYTES).filter((r) => r && r.repoKey === repoKey); // 행의 기록 시점 저장소 표식으로만(ab-1 — 캠페인 대리 매핑 폐기·표식 없는 옛 행=불산입)
    let camp = ""; for (const r of rows) if (r && r.type === "finding" && typeof r.campaignId === "string" && (r.envelopeHash || null) === (gen || null)) camp = r.campaignId;
    if (camp) {
      const inGen = (r) => r && r.campaignId === camp && (r.envelopeHash || null) === (gen || null);
      const closed = new Set(); for (const r of rows) if (inGen(r) && r.type === "close" && r.findingId) closed.add(r.findingId);
      const byOos = new Map(), byF = new Map();
      for (const r of rows) {
        if (!inGen(r)) continue;
        if (r.type === "finding" && r.demoted && r.oosId) byOos.set(r.oosId, (byOos.get(r.oosId) || 0) + 1);
        if (r.type === "occurrence" && r.findingId && r.effectiveTag === "blocker" && !closed.has(r.findingId)) { const st = byF.get(r.findingId) || new Set(); st.add(r.round); byF.set(r.findingId, st); }
      }
      for (const n of byOos.values()) s.oosRepeat = Math.max(s.oosRepeat, n);
      for (const st of byF.values()) s.lineage = Math.max(s.lineage, st.size + 1);
    }
  } catch { /* 장부 없음=0 */ }
  // ③-b 미사용 보관 수칙 — 미리보기+검증 선별 영수증(최신 상한 개) 합집합. 관측 0건이면 주장 안 함(수=0·일수=0).
  if (arcHash && archiveN > 0) {
    try {
      const recs = readRecentSelectorUsage(TICK_RECEIPTS_MAX).filter((r) => r && r.wsKey === wsKey && r.repoKey === repoKey && r.archiveHash === arcHash && (r.purpose === "preview" || (!r.purpose && typeof r.askId === "string" && r.askId))); // repoKey 결속(ab-1)
      if (recs.length) {
        const used = new Set(); let earliest = null;
        for (const r of recs) { for (const id of (Array.isArray(r.selectedIds) ? r.selectedIds : [])) used.add(String(id)); const t = Date.parse(String(r.ts || "")); if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t; }
        for (let i = 1; i <= archiveN; i++) if (!used.has("arc-" + i)) s.unusedCount++;
        if (s.unusedCount && earliest !== null) s.unusedDays = Math.floor((Date.now() - earliest) / 86400000);
      }
    } catch { /* 생략 */ }
  }
  // ③-c 선별 정상 범위 초과 횟수(attach 장부는 쓰기 측이 200행으로 절단 — 꼬리 판독) — 같은 작업 폴더 ∧ 그 검증에 실린 수칙서 세대=현재 세대(저장소별 파일 지문 — 전환 뒤 이전 저장소 행 배제·2회차 blocker ab-1)
  try { const wsN = CL.normWs(String(ws)); for (const o of readTailJson(CL.ATTACH_USAGE_FILE, 64 * 1024)) if (o && o.selOver && CL.normWs(String(o.ws || "")) === wsN && o.repoKey === repoKey) s.selOver++; } catch { /* 0 */ } // 저장소 표식 결속(표식 없는 옛 행=불산입 — ab-1)
  return s;
}
// 마감 캠페인 누계(② K) — tick 상태에 '본 적 있는 캠페인 id'를 기억하고 새 id만 k에 더한다. 첫 tick(상태 없음)은 현재 이력을 기준선으로 삼고 k=0(설치 이전 마감은 세지 않음).
// 새 마감 = (워터마크보다 나중 시각의 캠페인 전부) + (워터마크와 같은 시각의 캠페인 중 그 시각 집합에 없던 것).
// 상태는 hwm(시각)·hwmIds(그 시각에 마감된 캠페인 id 집합)이며, 집합은 그 밀리초에 실제로 마감된 수만큼만 자란다(절단 없음).
// 이력이 뒤로 짧아져도 워터마크는 되감기지 않고(Math.max), 사라진 행이 있어도 집합 차라서 남은 신규만 정확히 센다(5회차 blocker②).
// 같은 캠페인이 나중에 다시 마감되면(A→B→A) 새 시각의 마감 사건으로 한 번 더 센다 — 정직한 계수.
function tickCampaignCount(ws, st, repoKey) {
  const latest = new Map(); // campaignId → 마지막 마감 시각(같은 id 여러 행=최신만)
  for (const h of readTailJson(CL.campaignHistoryFileFor(ws), 64 * 1024)) {
    if (!(h && typeof h.campaignId === "string" && h.campaignId && h.repoKey === repoKey)) continue; // 이 저장소의 마감만(표식 없는 옛 행=불산입 — ab-1)
    const t = Date.parse(String(h.updatedAt || "")); if (!Number.isFinite(t)) continue;
    const prev = latest.get(h.campaignId); if (prev === undefined || t > prev) latest.set(h.campaignId, t);
  }
  let hwmMs = st && st.hwm ? Date.parse(st.hwm) : NaN; if (!Number.isFinite(hwmMs)) hwmMs = -Infinity;
  const hwmIds = new Set(st && Array.isArray(st.hwmIds) ? st.hwmIds : []);
  let maxT = -Infinity; for (const t of latest.values()) if (t > maxT) maxT = t;
  const newHwmMs = Math.max(Number.isFinite(hwmMs) ? hwmMs : -Infinity, Number.isFinite(maxT) ? maxT : -Infinity); // 되감김 금지(이력 절단으로 최신이 사라져도 유지)
  const atNewIds = []; for (const [id, t] of latest) if (t === newHwmMs) atNewIds.push(id);
  // 워터마크가 그대로면 그 시각의 옛 집합을 잃지 않게 합집합(꼬리에서 사라진 행도 '이미 센 것'으로 남는다)
  const nextIds = (Number.isFinite(hwmMs) && newHwmMs === hwmMs) ? [...new Set([...hwmIds, ...atNewIds])] : atNewIds;
  const out = (k) => ({ k, hwm: Number.isFinite(newHwmMs) ? new Date(newHwmMs).toISOString() : "", hwmIds: nextIds });
  if (!st || !st.seeded) return out(0); // 첫 판정=기준선(설치 이전 마감은 세지 않음)
  let k = st.k;
  for (const [, t] of latest) if (t > hwmMs) k++;                                     // 워터마크보다 나중=전부 신규
  if (Number.isFinite(hwmMs) && newHwmMs === hwmMs) for (const id of atNewIds) if (!hwmIds.has(id)) k++; // 같은 시각=집합에 없던 것만(절단과 무관)
  return out(k);
}
function curationTickJudge(ws, c, opts) {
  const o = opts || {};
  const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!cc) return { spawn: false, reason: "contract-unreadable" };
  const gen = typeof cc.envelopeHash === "string" && cc.envelopeHash ? cc.envelopeHash : null;
  if (!gen) return { spawn: false, reason: "envelope-inactive" };
  let repo; try { repo = CL.resolveScoutRepo(ws, cc).repo; } catch { return { spawn: false, reason: "repo-unresolved" }; }
  const wsKey = CL.wsKeyFor(ws), repoKey = CL.repoKeyOf(repo);
  if (lockAlive(ws)) return { spawn: false, reason: "running" };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const st0 = readTickState(ws, repoKey);
  const runs = readTailJson(curationFileFor(ws), TICK_TAIL_BYTES).filter((r) => r && r.schema === "curation-v1" && r.wsKey === wsKey && r.type === "run" && (!r.repoKey || r.repoKey === repoKey));
  const last = runs.length ? runs[runs.length - 1] : null;
  const lastTs = last ? Date.parse(String(last.ts || "")) : NaN;
  const kc = tickCampaignCount(ws, st0, repoKey);
  const persist = (extra) => { writeTickState(ws, repoKey, Object.assign({ k: kc.k, hwm: kc.hwm, hwmIds: kc.hwmIds, seeded: true, judgedAt: new Date(now).toISOString(), ranAt: st0 ? st0.ranAt : "" }, extra || {})); };
  if (Number.isFinite(lastTs) && now - lastTs < CURATION_TICK_MIN_GAP_MS) { persist({ reason: "recent" }); return { spawn: false, reason: "recent" }; }
  const arcHash = typeof cc.archiveHash === "string" && cc.archiveHash ? cc.archiveHash : null;
  let archiveN = 0; if (arcHash) { try { const ar = CL.readVerifyEnvelopeArchive(repo); if (ar.st === "ok" && ar.sha1 === arcHash) archiveN = ar.data.alwaysBlocker.length; } catch { archiveN = 0; } }
  const s = curationTickSignals(ws, wsKey, repoKey, gen, arcHash, archiveN); s.k = kc.k;
  const tickFp = sha1(JSON.stringify({ gen, arcHash: arcHash || "", k: s.k, o: s.oosRepeat, l: s.lineage, u: s.unusedDays >= CURATION_TICK_THRESHOLDS.unusedDays, so: s.selOver }));
  if (last && last.tickFp === tickFp) { persist({ tickFp, reason: "same-tick" }); return { spawn: false, reason: "same-tick", tickFp, signals: s }; }
  const T = CURATION_TICK_THRESHOLDS;
  const why = s.k >= CURATION_TICK_K ? "campaigns:" + s.k : s.oosRepeat >= T.oosRepeat ? "oos-repeat:" + s.oosRepeat : s.lineage >= T.lineage ? "lineage:" + s.lineage : s.unusedDays >= T.unusedDays ? "unused-rule:" + s.unusedDays + "d" : s.selOver >= T.selOver ? "selover:" + s.selOver : "";
  persist({ tickFp, reason: why || "below-threshold" });
  if (!why) return { spawn: false, reason: "below-threshold", tickFp, signals: s };
  return { spawn: true, reason: why, tickFp, signals: s };
}
// 실행이 끝나면 마감 캠페인 누계를 0으로(마지막 큐레이션 이후만 센다) — 실행 행을 쓰는 모든 경로가 호출
function resetTickK(ws, repoKey, ranAtIso) {
  const st = readTickState(ws, repoKey);
  writeTickState(ws, repoKey, Object.assign({ k: 0, hwm: "", hwmIds: [], seeded: true, judgedAt: "", tickFp: "", reason: "" }, st || {}, { k: 0, ranAt: ranAtIso || new Date().toISOString() }));
}
// 훅 진입(ⓐ) — 전수 판독 0: 계약(호출자 전달)·잠금 파일·tick 상태 파일만. 최소 간격이 지났으면 `curate tick`을 detach(판정·실행은 자식). 반환=null(무고지 — 결과는 대시보드 카드).
function curationHookTick(ws, c, opts) {
  const o = opts || {};
  try {
    const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
    if (!cc || !(typeof cc.envelopeHash === "string" && cc.envelopeHash)) return null;
    if (lockAlive(ws)) return null;
    let repoKey; try { repoKey = CL.repoKeyOf(CL.resolveScoutRepo(ws, cc).repo); } catch { return null; } // 경로 결정만(파일 판독 없음·existsSync 1회)
    const st = readTickState(ws, repoKey);
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const lastAct = st ? Math.max(Date.parse(st.judgedAt || "") || 0, Date.parse(st.ranAt || "") || 0) : 0;
    if (lastAct && now - lastAct < CURATION_TICK_MIN_GAP_MS) return null;
    // detach 전에 상태를 먼저 찍어 같은 간격 안의 다음 훅이 또 띄우지 않게(자식이 죽어도 다음 간격에 재시도)
    writeTickState(ws, repoKey, Object.assign({ k: 0, hwm: "", hwmIds: [], seeded: false, ranAt: "", tickFp: "", reason: "" }, st || {}, { judgedAt: new Date(now).toISOString() }));
    const args = [path.join(__dirname, "codex-bridge.js"), "curate", "tick"];
    const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: String(ws) });
    const sp = typeof o.spawnFn === "function" ? o.spawnFn : require("child_process").spawn;
    const child = sp(process.execPath, args, { cwd: String(ws), detached: true, stdio: "ignore", windowsHide: true, env });
    if (child && typeof child.unref === "function") child.unref();
  } catch { return null; }
  return null;
}

// 대시보드·CLI 요약 — 현재 정찰 대상(repoKey) 기준(1회차 blocker④ ab-1): 마지막 실행·제안 n·미승인 m + 측정 4지표(§3 F: 채택률·서고 크기·선별 초과·미사용 수칙 수)
function curationSummary(ws) {
  let repoKey = null, gen = null, arcHash = null, repo = null;
  try { const c = CL.loadContract(ws); repo = CL.resolveScoutRepo(ws, c).repo; repoKey = CL.repoKeyOf(repo); gen = c.envelopeHash || null; arcHash = typeof c.archiveHash === "string" && c.archiveHash ? c.archiveHash : null; } catch { /* 요약만 */ }
  const rows = readCurationRows(ws).filter((r) => !repoKey || !r.repoKey || r.repoKey === repoKey);
  const runs = rows.filter((r) => r.type === "run" && (!repoKey || r.repoKey === repoKey));
  const last = runs.length ? runs[runs.length - 1] : null;
  const results = rows.filter((r) => r.type === "result" && (!repoKey || r.repoKey === repoKey));
  const ids = new Set(); for (const r of results) for (const id of (Array.isArray(r.items) ? r.items : [])) ids.add(id);
  const proposedTotal = ids.size;
  let adopted = 0, declined = 0;
  try {
    const { rows: crows } = CL.readEnvelopeCandidates(ws);
    const st = new Map();
    for (const r of crows) if (r && ids.has(r.candidateId) && (r.status === "adopted" || r.status === "declined" || r.status === "proposed")) st.set(r.candidateId, r.status === "adopted" && r.applied ? "applied" : r.status);
    for (const v of st.values()) { if (v === "applied") adopted++; else if (v === "declined") declined++; }
  } catch { /* 0 */ }
  let archiveSize = 0; if (repo && arcHash) { try { const ar = CL.readVerifyEnvelopeArchive(repo); if (ar.st === "ok" && ar.sha1 === arcHash) archiveSize = ar.data.alwaysBlocker.length; } catch { archiveSize = 0; } }
  const s = repoKey ? curationTickSignals(ws, CL.wsKeyFor(ws), repoKey, gen, arcHash, archiveSize) : { selOver: 0, unusedDays: 0, unusedCount: 0 };
  const tk = repoKey ? readTickState(ws, repoKey) : null;
  return { lastTs: last ? last.ts : "", lastOutcome: last ? last.outcome : "", lastReason: last ? (last.reason || "") : "", lastTrigger: last ? (last.trigger || "manual") : "", runs: runs.length, proposedTotal, adopted, declined, adoptRate: proposedTotal ? Math.round((adopted / proposedTotal) * 100) : 0, pending: repoKey && gen ? curationPendingCount(ws, repoKey, gen) : 0, running: lockAlive(ws), archiveSize, selOverCount: s.selOver, unusedCount: s.unusedCount, unusedDays: s.unusedDays, campaignsSince: tk ? tk.k : 0, maxPerRun: CURATION_MAX_PER_RUN, maxPending: CURATION_MAX_PENDING, tickK: CURATION_TICK_K };
}

module.exports = { RULE_REDACTED, recoverCurationProvisional, resolveComputeCandidates, safeText, CURATION_DIR, CURATION_MAX_PER_RUN, CURATION_MAX_PENDING, CURATION_UNUSED_DAYS, CURATION_OPERATIONS, curationFileFor, curateLockFileFor, itemFpOf, selectorArmForCuration, readCurationRows, appendCurationRow, curationInput, curationKeyOf, curationSkip, buildCurationPrompt, parseCurationOutput, curationPendingCount, commitCuration, writeCurationReceipt, acquireCurateLock, releaseCurateLock, runCuration, curationSummary };
module.exports.CURATION_TICK_K = CURATION_TICK_K;
module.exports.CURATION_TICK_MIN_GAP_MS = CURATION_TICK_MIN_GAP_MS;
module.exports.CURATION_TICK_THRESHOLDS = CURATION_TICK_THRESHOLDS;
module.exports.curationTickSignals = curationTickSignals;
module.exports.repoCampaignIds = repoCampaignIds;
module.exports.tickCampaignCount = tickCampaignCount;
module.exports.curationTickJudge = curationTickJudge;
module.exports.curationHookTick = curationHookTick; // [§3 A ②③] 훅=3파일 판독+detach(curate tick) · 판정은 자식
module.exports.curationTickFileFor = curationTickFileFor;
module.exports.readTickState = readTickState;
module.exports.writeTickState = writeTickState;
module.exports.readTailLines = readTailLines;
module.exports.resetTickK = resetTickK;
