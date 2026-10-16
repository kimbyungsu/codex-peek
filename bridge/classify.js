"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 2-나-2 §3-3·§3-4 — 2026-10-05] 사용자 말 분류 실행(독립).
 * 미분류 대기열(user-words)의 사용자 말을 구현 턴과 같은 회사의 독립 실행(selector-runner 페이지 1회 — 도구·MCP 전면 차단)에 넘겨
 * 말의 성격만 가른다. [RULE-SUPPLY-CORRECTION 묶음 2(⑤) §2 A — 2026-10-10] 성격 3종: boundary(판정 경계 — 수칙서 칸 제안+판정에 주는 영향 bounds 한 줄 필수)
 * · emphasis(이미 있는 항목을 다시 강조 — 항목 번호) · style(구현 담당의 일하는 방식 — 수칙서 아님 · 대시보드 알림만, D-a). 결과는 분류 결과 장부
 * (classify/<ws>.results.jsonl)에만 쓴다 — 수칙서 후보 장부·규칙 칸·결정 장부에 쓰지 않는다(수칙서로 올릴지는 구현 담당이 정함 — §2 B).
 * (정정 전에는 수칙서 칸 후보를 후보 장부에 직접 썼다 — 사용자 지적 2026-10-09 '수칙 노이즈': 일하는 방식 말이 수칙서 후보로 올라옴.)
 * [RULE-SUPPLY-CORRECTION 묶음 1 · §2 D] 옛 '사용자 규칙 칸 자리'·'결정 기록 자리'는 없앴다 — 규칙 칸은 사용자가 직접 쓰는 칸이고(체크박스 대상),
 * 결정 장부의 출처는 구현 담당 판단 하나뿐이다. 그 자리로 답이 오면 답 전체를 거부한다(자리 밖). 옛 자리 장부(classify/<ws>.seats.jsonl)는
 * 지우지도 바꾸지도 않고(덧붙이기 전용·ab-5) 판독만 한다 — 사용자가 안 올린 문장을 '이미 있는 것'으로 싣는 데에만 쓴다(새 행을 쓰는 곳 없음).
 * 원칙: 판단은 LLM(문구 감지·키워드 목록 없음) · 인용은 원문 연속 구절만(작문 차단 — 원문 대조) · 판정을 만드는 검증 입력에 넣지 않음(R2) ·
 *       승인 전 원문은 그 말이 나온 구현 턴과 같은 회사로만(R3 — Claude 차례 말=Claude 1회 호출 · Codex 차례 말=Codex 격리 실행) ·
 *       민감 형태는 입력에서 생략 표시로 바꿈(ab-7) · 실패=영수증+경보·대기열 보존(재시도 상한 뒤 '분류하지 못한 말'로 보류 — 조용한 누락 없음) ·
 *       실행 잠금 1개(ab-6 유계) · 모든 기록 덧붙이기 전용(ab-5) · 작업공간 키·저장소 표식 결속(ab-1).
 * 이 모듈은 도장(승인)을 찍지 않는다 — 수칙서 후보의 승인·안 올림은 기존 수칙 카드(후보 장부) 몫이다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const CL = require("./contract-lib.js");
const UW = require("./user-words.js");

const CLASSIFY_DIR = path.join(CL.BRIDGE_DIR, "classify");
const CLASSIFY_BATCH_WORDS = 20;       // 한 번에 넘기는 말 수 상한(나머지는 다음 계기 — 대기열 보존)
const CLASSIFY_BATCH_CHARS = 24000;    // 한 번에 넘기는 글자 수 상한(첫 말은 상한과 무관하게 1건은 싣는다)
const CLASSIFY_WORD_SHOW = 4000;       // 말 1건에서 보여 주는 앞부분 상한(인용 대조는 원문 전체로)
const CLASSIFY_MAX_PER_RUN = 5;        // 실행 1회당 후보 상한(소수 — 초과=답 전체 거부)
const CLASSIFY_RETRY_MAX = 3;          // 같은 말 분류 실패 반복 상한 → 보류(classify-failed)
const CLASSIFY_LIST_MAX = 60;          // '이미 있는 것' 목록 항목 상한(종류별)
const CLASSIFY_LOCK_STALE_MS = 15 * 60 * 1000;
const RULEBOOK_SEATS = ["supportedEnv", "alwaysBlocker", "outOfScope"];
const SEATS = [...RULEBOOK_SEATS]; // [RULE-SUPPLY-CORRECTION 묶음 1] 수칙서 칸만 — 옛 rule·decision 자리는 자리 밖(답 전체 거부)
const SEAT_STATUSES = ["proposed", "approved", "declined"];
const CLASSIFY_KINDS = ["boundary", "emphasis", "style"]; // [묶음 2(⑤)] 성격 3종(나머지=출력 없음)
const CLASSIFY_BOUNDS_MIN = 8, CLASSIFY_BOUNDS_MAX = 200; // boundary 의 '판정에 주는 영향' 한 줄(§3-1 1항 — 못 적으면 판정 경계가 아님)
// 분류 결과 상태: new(전달 전) · delivered(그 차례 구현 담당에게 전달됨 — deliveredTurn) · raised(구현 담당이 올림 — 후보 장부 fromResult 로도 판정) ·
// skipped(구현 담당이 안 올림 — 이유) · unhandled(두 번 전달받고도 판단 없음 — 종결) · expired(원문 만료 — 대시보드에만)
const RESULT_STATUSES = ["new", "delivered", "raised", "skipped", "unhandled", "expired"];
const SKIP_NOTE_MIN = 8; // 안 올림 이유 한 줄 하한(상한=CL.CONSTRAINT_WHY_MAX)
const RESULTS_VIEW_MAX = 20; // 화면 목록 상한(종류별 최근순)
const REDACTED = "[생략]";
const sha1 = (s) => crypto.createHash("sha1").update(String(s), "utf8").digest("hex");
const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const qNormOf = (q) => String(q).normalize("NFC").replace(/\s+/g, " ").trim();
function classifyFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".jsonl"); }
function seatsFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".seats.jsonl"); }
function resultsFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".results.jsonl"); } // [묶음 2(⑤)] 분류 결과 장부(덧붙이기 전용)
function classifyLockFileFor(ws) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + ".lock"); }
// 팔=그 말이 나온 구현 턴의 회사(R3) — 설정·교차 없음
function armForProvider(provider) { return provider === "codex" ? "codex" : "self"; }
function providerOf(w) { return w && w.provider === "codex" ? "codex" : "claude"; }
// 구현 담당 규칙 목록(사용자가 직접 쓰는 규칙 칸) — 회사별 칸(Claude=claude · Codex=codexImplementer). 분류 입력의 '이미 있는 것'으로만 읽는다(쓰지 않음).
function rulesFieldFor(provider) { return provider === "codex" ? "codexImplementer" : "claude"; }
function normRuleList(v) { return (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean); }

// ── 민감 형태 생략(ab-7) — 분류 입력에만 적용(원문 파일·인용 대조는 원문 그대로). 범주 규칙(contract-lib 자동 제목 규칙과 같은 범주):
// 드라이브·네트워크·절대 경로 / 이메일 / 알려진 비밀값 머리 / 32자 이상 연속 토큰 덩어리 / 제어 문자(줄바꿈·탭 제외).
const B9 = "(^|[\\s\"'`“”‘’()\\[\\]{}<>=:,;])";
const REDACT_RULES = [
  { re: /[A-Za-z]:[\\/][^\s"'`<>|]*/g, keep: false },
  { re: /\\\\[^\s"'`<>|]*/g, keep: false },
  { re: new RegExp(B9 + "//[^\\s/]+/[^\\s]*", "g"), keep: true },
  { re: new RegExp(B9 + "/[^\\s/]+/[^\\s]*", "g"), keep: true },
  { re: new RegExp(B9 + "~[^\\s]*/[^\\s]*", "g"), keep: true },
  { re: /[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, keep: false },
  { re: /\beyJ[A-Za-z0-9_-]{8,}/g, keep: false },
  { re: /\bAKIA[0-9A-Z]{8,}/g, keep: false },
  { re: /\bghp_[A-Za-z0-9]{8,}/g, keep: false },
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, keep: false },
  { re: /\bxox[a-z]?-[A-Za-z0-9-]{8,}/g, keep: false },
  { re: /[A-Za-z0-9+/=_-]{32,}/g, keep: false },
];
function redactSensitiveForms(text) {
  let s = String(text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  for (const r of REDACT_RULES) s = s.replace(r.re, (m, g1) => (r.keep ? String(g1 || "") : "") + REDACTED);
  return s;
}

// ── 장부(실행 행) ──
function readClassifyRows(ws) {
  try { return String(fs.readFileSync(classifyFileFor(ws), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.schema === "classify-v1" && r.wsKey === CL.wsKeyFor(ws)); } catch { return []; }
}
function appendClassifyRow(ws, row) {
  const rec = Object.assign({ schema: "classify-v1", wsKey: CL.wsKeyFor(ws), ts: new Date().toISOString() }, row);
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); fs.appendFileSync(classifyFileFor(ws), CL.appendLeadFor(classifyFileFor(ws)) + JSON.stringify(rec) + "\n"); return true; } catch { return false; } // 꼬리 보호(끊긴 마지막 줄과 합쳐지지 않게)
}
// ── 옛 자리 장부(없앤 '규칙 칸·결정 기록' 자리 — 판독 전용) — 같은 id 의 마지막 유효 행이 이김. 판독 오류=readError(빈 장부로 위장 금지).
function readSeatsState(ws) {
  let raw;
  try { raw = String(fs.readFileSync(seatsFileFor(ws), "utf8")); } catch (e) { return { rows: [], latest: new Map(), readError: !(e && e.code === "ENOENT") }; }
  const wk = CL.wsKeyFor(ws);
  const rows = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.schema === "user-seat-v1" && r.wsKey === wk && typeof r.candidateId === "string" && /^[0-9a-f]{16}$/.test(r.candidateId) && SEAT_STATUSES.includes(r.status));
  const meta = new Map(), latest = new Map();
  for (const r of rows) { if (!meta.has(r.candidateId) && r.status === "proposed" && r.quote) meta.set(r.candidateId, r); latest.set(r.candidateId, r); }
  for (const [id, r] of latest) latest.set(id, Object.assign({}, meta.get(id) || {}, r)); // 상태 행이 문안을 안 실어도 첫 행에서 회수
  return { rows, latest, readError: false };
}
// ── [묶음 2(⑤)] 분류 결과 장부 — 같은 resultId 의 마지막 유효 행이 이김(상태 행이 문안을 안 실어도 첫 행에서 회수). 판독 오류=readError(빈 장부로 위장 금지).
function readClassifyResults(ws) {
  let raw;
  try { raw = String(fs.readFileSync(resultsFileFor(ws), "utf8")); } catch (e) { return { rows: [], latest: new Map(), readError: !(e && e.code === "ENOENT") }; }
  const wk = CL.wsKeyFor(ws);
  const rows = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.schema === "classify-result-v1" && r.wsKey === wk && typeof r.resultId === "string" && /^[0-9a-f]{16}$/.test(r.resultId) && CLASSIFY_KINDS.includes(r.kind) && RESULT_STATUSES.includes(r.status));
  const meta = new Map(), latest = new Map();
  for (const r of rows) { if (!meta.has(r.resultId) && r.quote) meta.set(r.resultId, r); latest.set(r.resultId, r); }
  for (const [id, r] of latest) latest.set(id, Object.assign({}, meta.get(id) || {}, r));
  return { rows, latest, readError: false };
}
function appendClassifyResults(ws, rows) {
  if (!rows.length) return true;
  const f = resultsFileFor(ws);
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); fs.appendFileSync(f, CL.appendLeadFor(f) + rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return true; } catch { return false; } // 꼬리 보호
}
function classifyResultIdFor(ws, repoKey, kind, quote, wordId) { return sha1(CL.wsKeyFor(ws) + "|" + repoKey + "|" + kind + "|" + qNormOf(quote) + "|" + String(wordId || "")).slice(0, 16); }
// ── [⑤ 2단계] 판단 — 올림(constraint add --from)·안 올림(classify skip). 대상=그 차례에 전달됐고 아직 판단하지 않은, 같은 회사·같은 저장소의 판정 경계 결과만.
// '올림'은 결과 장부의 raised 행 또는 후보 장부의 fromResult 둘 중 하나로 판정(한쪽 기록 실패에도 같은 결과를 두 번 올리지 않게). 판독 오류=null(빈 목록 위장 금지).
function raisedResultIds(ws) {
  const cst = CL.readEnvelopeCandidatesState(ws);
  if (cst.readError) return null;
  const out = new Set(); for (const r of cst.rows) if (r && typeof r.fromResult === "string") out.add(r.fromResult);
  for (const [id, cl] of claimDecisions(ws)) if (cl.decision === "raised") out.add(id); // 표식만 있고 기록이 아직 빠진 올림도 올림
  return out;
}
function deliveredUndecided(ws, ctx) {
  const c = ctx || {};
  const rk = typeof c.repoKey === "string" && /^[0-9a-f]{16}$/.test(c.repoKey) ? c.repoKey : null;
  if (!rk || !c.turnAnchor) return [];
  const rs = readClassifyResults(ws); if (rs.readError) return null;
  const raised = raisedResultIds(ws); if (raised === null) return null;
  return [...rs.latest.values()].filter((r) => r.kind === "boundary" && r.status === "delivered" && r.deliveredTurn === c.turnAnchor && r.repoKey === rk && String(r.provider || "") === String(c.provider || "") && !raised.has(r.resultId) && !hasClaim(ws, r.resultId));
}
// [⑤ 2단계-가 · 검증 1~3회차 blocker] 결과 판단 표식(claim) — 한 결과의 판단(올림·안 올림)은 결과마다 하나인 표식 파일을 '없을 때만 만들기(wx)'로
// 만든 쪽만 기록한다. 운영체제가 단 한 번만 성공시키는 동작이라 동시 실행·잠금 회수 경합과 무관하게 한 결과=한 판단이다(잠금·회수 없음 — 판단은 한 번
// 내려지면 끝이라 회수할 것이 없다). 표식 안에 남길 기록(후보 행·결과 행)을 담아 두고, 표식만 만들고 기록 전에 꺼진 경우는 다음 판단·전달 기록 때
// repairClaims 가 빠진 기록을 채운다(sup-5 — 읽기 함수에는 부작용 없음). 표식 판독 불가=판단된 것으로 본다(fail-closed).
const CLAIMS_DIR = path.join(CLASSIFY_DIR, "claims");
function claimDirFor(ws) { return path.join(CLAIMS_DIR, CL.wsKeyFor(ws)); }
function claimFileFor(ws, resultId) { return path.join(claimDirFor(ws), String(resultId || "").replace(/[^0-9a-f]/g, "") + ".json"); }
function hasClaim(ws, resultId) { try { fs.statSync(claimFileFor(ws, resultId)); return true; } catch (e) { return !(e && e.code === "ENOENT"); } }
// 반환 "claimed"(내가 판단) | "taken"(이미 판단됨) | "io"(표식을 만들 수 없음)
// [검증 4회차 blocker] 표식 자리에 바로 쓰면 '파일 생성 → 내용 쓰기' 사이에 꺼질 때 빈 표식이 남아(판단됨으로 막히는데 채울 내용 없음) 결과가 영구히 소비된다 —
// 내용을 임시 파일에 다 쓴 뒤 '없을 때만 연결하기(link — 이미 있으면 EEXIST, 덮어쓰기 없음)'로 표식 자리에 붙인다. 연결 전 꺼짐=임시 파일만 남음(판단 안 됨 ·
// 쓰레기는 repairClaims 가 치움) · 연결 뒤 꺼짐=완성된 표식.
function claimResult(ws, resultId, claim) {
  try { fs.mkdirSync(claimDirFor(ws), { recursive: true }); } catch { /* 아래가 판정 */ }
  const fin = claimFileFor(ws, resultId);
  const tmp = fin + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try { fs.writeFileSync(tmp, JSON.stringify(claim), { flag: "wx" }); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* 무해 */ } return "io"; }
  try { fs.linkSync(tmp, fin); return "claimed"; }
  catch (e) { return e && e.code === "EEXIST" ? "taken" : "io"; }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* 남은 임시 파일=다음 채우기 때 정리 */ } }
}
// 표식 목록(판독 불가 표식=claim null — 판단된 것으로 셈)
// [검증 6회차 blocker] 부재와 판독 불가를 구분 — 폴더 없음=표식 없음 · 폴더·파일 판독 오류=readError(일시적일 수 있으니 '없음'으로 줄이지 않음 — 회복 뒤
// 채워질 판단을 놓친다) · 내용 형식 불량=claim null(표식은 완성된 내용으로만 연결되고 다시 쓰이지 않으므로 형식 불량은 영구 — 채울 내용이 없어 늦게 덧붙지도 않음).
function readClaimsState(ws) {
  const out = []; let names = [];
  try { names = fs.readdirSync(claimDirFor(ws)); } catch (e) { return { claims: out, readError: !(e && e.code === "ENOENT") }; }
  let readError = false;
  for (const n of names) {
    if (!/^[0-9a-f]{16}\.json$/.test(n)) continue;
    let raw; try { raw = fs.readFileSync(path.join(claimDirFor(ws), n), "utf8"); } catch { readError = true; out.push({ resultId: n.slice(0, 16), claim: null, readFailed: true }); continue; }
    let o = null; try { o = JSON.parse(raw); } catch { o = null; }
    out.push({ resultId: n.slice(0, 16), claim: o && typeof o === "object" ? o : null });
  }
  return { claims: out, readError };
}
function readClaims(ws) { return readClaimsState(ws).claims; }
function claimDecisions(ws) { const m = new Map(); for (const c of readClaims(ws)) m.set(c.resultId, c.claim ? c.claim : { decision: "unknown" }); return m; }
// [⑥ 묶음 3(C) · 검증 1회차 blocker] 판정 경계 결과의 유효 상태 — 장부 상태에 판단 표식을 반영(안 올림·올림이 표식에만 남고 장부 기록이 아직 빠진 경우 포함).
// 올림(후보 장부 fromResult·결과 raised)=raised · 표식 안 올림=skipped · 표식 올림=raised · 표식이 있는데 내용을 못 읽음=decided-unknown(판단됨 — 다시 넘기지 않음) · 그 밖=장부 상태.
function effectiveResultStatus(r, raised, claims) {
  if (!r) return "";
  if (raised && raised.has(r.resultId)) return "raised";
  const cv = claims && claims.get(r.resultId);
  if (cv) return cv.decision === "skipped" ? "skipped" : cv.decision === "raised" ? "raised" : "decided-unknown";
  return String(r.status || "");
}
// 표식은 있는데 기록이 빠진 판단을 채운다(이미 있으면 건너뜀). 쓰기 경로(판단·전달)에서만 부른다.
// [검증 4회차 blocker] 채우기가 겹치거나 원래 작성자가 늦게 깨어나 같은 결과 행이 두 번 붙어도, 장부 판독은 같은 결과의 첫 상신 행만 쓴다(contract-lib
// readEnvelopeCandidatesState) — 늦은 덧붙임은 그 사이의 거절·재상신을 되돌리지 못한다. 채운 행에는 감사용 표지(repaired)만 단다(권위 차이 없음).
// 결과 장부의 판단 행(올림·안 올림)은 끝 상태라 늦게 붙어도 상태가 같다.
const CLAIM_TMP_STALE_MS = 60 * 60 * 1000;
function repairClaims(ws) {
  try { for (const n of fs.readdirSync(claimDirFor(ws))) { if (!n.endsWith(".tmp")) continue; const fp = path.join(claimDirFor(ws), n); try { if (Date.now() - fs.statSync(fp).mtimeMs > CLAIM_TMP_STALE_MS) fs.rmSync(fp, { force: true }); } catch { /* 무해 */ } } } catch { /* 폴더 없음 */ }
  const cl = readClaims(ws).filter((c) => c.claim);
  if (!cl.length) return { repaired: 0 };
  const cst = CL.readEnvelopeCandidatesState(ws), rs = readClassifyResults(ws);
  if (cst.readError || rs.readError) return { repaired: 0, readError: true };
  let n = 0;
  for (const { resultId, claim } of cl) {
    if (claim.decision === "raised" && claim.candidateRow && !cst.rows.some((r) => r && r.fromResult === resultId)) { if (CL.appendEnvelopeCandidates(ws, [Object.assign({}, claim.candidateRow, { repaired: true, repairedAt: new Date().toISOString() })])) n++; }
    const lr = rs.latest.get(resultId);
    if (claim.resultRow && !(lr && lr.status === claim.decision)) { if (appendClassifyResults(ws, [claim.resultRow])) n++; }
  }
  return { repaired: n };
}
// [검증 5회차 blocker] 그 후보의 '올림' 표식 가운데 후보 장부에 아직 반영되지 않은 것(결과 id 목록) — 장부 판독 오류=null(알 수 없음).
// 채우기가 실패한 채 같은 후보의 새 상신을 받으면, 나중에 채워지는 옛 판단 행이 그 결과의 첫 행이라 새 상신 칸을 덮는다 — 상신 쪽이 이것으로 막는다.
// 표식 폴더·파일을 읽지 못하면(일시적일 수 있음) null — 놓친 표식이 회복 뒤 채워질 수 있으므로 '없음'으로 보지 않는다. 내용 형식이 불량한 표식은 채울 내용이
// 없어 늦게 덧붙을 수 없으므로 세지 않는다(영구 불량 표식 하나가 모든 상신을 막지 않게).
function unfilledRaisedClaims(ws, candidateId) {
  const st = readClaimsState(ws);
  if (st.readError) return null;
  const mine = st.claims.filter((c) => c.claim && c.claim.decision === "raised" && c.claim.candidateId === candidateId);
  if (!mine.length) return [];
  const cst = CL.readEnvelopeCandidatesState(ws);
  if (cst.readError) return null;
  return mine.filter((c) => !cst.rows.some((r) => r && r.fromResult === c.resultId)).map((c) => c.resultId);
}
function resultStatusRow(ws, res, status, extra) { return Object.assign({ schema: "classify-result-v1", wsKey: CL.wsKeyFor(ws), repoKey: res.repoKey, resultId: res.resultId, kind: res.kind, status, ts: new Date().toISOString() }, extra || {}); }
function markResultRaised(ws, res, candidateId, ctx) { return appendClassifyResults(ws, [resultStatusRow(ws, res, "raised", { candidateId: String(candidateId || ""), by: "implementer", turnAnchor: String((ctx && ctx.turnAnchor) || "") })]); }
// 안 올림 — 이유 한 줄(8자~·민감 형태 금지) · 자체 상신 한도와 무관 · 거부=무기록
function skipResult(ws, resultId, note, ctx, testHooks) {
  const n = typeof note === "string" ? note.trim() : "";
  if (!ctx || !ctx.ok) return { ok: false, reason: (ctx && ctx.reason) || "no-turn-anchor" };
  if (n.length < SKIP_NOTE_MIN || n.length > CL.CONSTRAINT_WHY_MAX || /[\r\n\u2028\u2029]/.test(note)) return { ok: false, reason: "note-format" };
  const ns = CL.safeBacklogAutoTitle(n); if (!ns.ok) return { ok: false, reason: "note-sensitive-" + ns.reasonKey };
  try { repairClaims(ws); } catch { /* 최선 노력 */ }
  const du = deliveredUndecided(ws, ctx);
  if (du === null) return { ok: false, reason: "results-unreadable" };
  const res = du.find((r) => r.resultId === String(resultId || ""));
  if (!res) return { ok: false, reason: "not-delivered" };
  const row = resultStatusRow(ws, res, "skipped", { note: n, by: "implementer", turnAnchor: String(ctx.turnAnchor) });
  if (testHooks && typeof testHooks.beforeClaim === "function") testHooks.beforeClaim(); // 시험 전용 — 미판단 확인~표식 사이 끼어들기 재현
  const cr = claimResult(ws, res.resultId, { schema: "classify-claim-v1", resultId: res.resultId, decision: "skipped", resultRow: row, by: "implementer", turnAnchor: String(ctx.turnAnchor), ts: row.ts });
  if (cr === "taken") return { ok: false, reason: "not-delivered" }; // 그 사이 다른 판단이 먼저(무기록)
  if (cr !== "claimed") return { ok: false, reason: "claim-io" };
  if (!appendClassifyResults(ws, [row])) return { ok: true, resultId: res.resultId, pendingRepair: true }; // 판단은 표식에 남음 — 다음 판단 때 기록을 채움
  return { ok: true, resultId: res.resultId };
}
// 전달 기록(전달 횟수 누적) — 다음 묶음(전달)이 부른다. 반환=쓰기 성공 여부.
function markResultsDelivered(ws, results, ctx) {
  const c = ctx || {};
  try { repairClaims(ws); } catch { /* 최선 노력 */ }
  if (!results || !results.length) return true;
  return appendClassifyResults(ws, results.map((r) => resultStatusRow(ws, r, "delivered", { deliveredTurn: String(c.turnAnchor || ""), deliveries: (Number(r.deliveries) || 0) + 1, provider: String(c.provider || r.provider || ""), sessionId: String(c.sessionId || "") })));
}
// ── [⑤ 2단계-나] 전달 — 판정 경계 결과를 분류가 끝난 다음 '사람의 차례'에 그 회사의 구현 담당에게 넘긴다(§2 B · §3-1 2·6·7).
// 한 차례에 한 번만 · 미판단이면 다음 사람의 차례에 한 번 더(전달 2회) · 2회째에도 미판단=종결 '구현 담당 미처리'(더 넘기지 않음 · 안 올림 아님) ·
// 원문 만료=종결 '원문 만료'(넘기지 않음 · 대시보드에만) · 만료 전인데 원문을 못 읽음=읽기 보류(이번 차례엔 넘기지 않고 상태도 그대로 — 다음 차례에 다시 읽음).
// 전달 기록(markResultsDelivered)은 주입문이 실제로 나간 뒤에만 훅이 남긴다 — 이 함수는 넘길 목록과 종결 전이만 정한다(종결 전이는 출력과 무관한 사실이라 여기서 기록).
// 판독 오류(결과 장부·후보 장부)=null(아무것도 넘기지 않음 · 빈 목록 위장 금지). 사용자 말 장부 판독 오류=전부 읽기 보류.
const DELIVERY_MAX = 2;
const DELIVER_PER_TURN = CLASSIFY_MAX_PER_RUN; // 한 차례 전달 상한(나머지는 '새 결과'로 남아 다음 사람의 차례에 — 전달 횟수 미소비)
// [⑥ 묶음 3(C)] 다시 강조=자료 줄(판단할 것 없음 · 종료 관문 대상 아님 · 한 번만 — 전달되면 delivered) · 판정 경계 전달 한도와 따로 센다.
const EMPHASIS_PER_TURN = CLASSIFY_MAX_PER_RUN;
// 같은 대상 열쇠 — 수칙서 항목(본문·관련될 때)은 문안 지문 하나로(같은 문장이 자리를 옮겨도 같은 항목) · 제안=후보 id · 결과=결과 id · 그 밖=문안 지문.
function emphasisKeyOf(r) {
  const t = (r && r.target) || {};
  if ((t.type === "core" || t.type === "archive") && t.fp) return "rb:" + t.fp;
  if ((t.type === "candidate" || t.type === "declined-candidate") && t.candidateId) return "cand:" + t.candidateId;
  if (t.type === "result" && t.resultId) return "res:" + t.resultId;
  if (t.fp) return String(t.type || "x") + ":" + t.fp;
  return "text:" + sha1(CL.normBacklogTitle(String((r && r.itemText) || "")));
}
// 다시 강조 몇 번째인지 — 같은 저장소의 다시 강조 결과를 장부에 처음 나타난 순서로 대상별로 센다.
function emphasisOrdinals(rs, repoKey) {
  const seen = new Set(), cnt = new Map(), nth = new Map();
  for (const r of rs.rows) {
    if (!r || r.kind !== "emphasis" || r.repoKey !== repoKey || seen.has(r.resultId)) continue;
    seen.add(r.resultId);
    const k = emphasisKeyOf(r); const n = (cnt.get(k) || 0) + 1; cnt.set(k, n); nth.set(r.resultId, n);
  }
  return nth;
}
function planDelivery(ws, ctx) {
  const c = ctx || {};
  const rk = /^[0-9a-f]{16}$/.test(String(c.repoKey || "")) ? String(c.repoKey) : null;
  const prov = c.provider === "codex" || c.provider === "claude" ? c.provider : null;
  if (!rk || !prov || !c.turnAnchor) return { deliver: [], transitions: 0, held: 0 };
  try { repairClaims(ws); } catch { /* 최선 노력 — 표식만 남은 판단의 기록 채우기 */ }
  const rs = readClassifyResults(ws); if (rs.readError) return null;
  const raised = raisedResultIds(ws); if (raised === null) return null;
  const firstTs = new Map(); for (const r of rs.rows) if (!firstTs.has(r.resultId)) firstTs.set(r.resultId, String(r.ts || ""));
  // [⑥ 묶음 3(C)] 다시 강조 자료 — 같은 회사·같은 저장소의 아직 넘기지 않은 결과만(R3) · 원문을 다시 읽지 않음(결과에 남은 인용만) · 다시 넘긴 판정 경계가 있으면 표시
  const nth9 = emphasisOrdinals(rs, rk);
  const resumedBy9 = new Set(); for (const r of rs.latest.values()) if (r.kind === "boundary" && r.emphasisOf) resumedBy9.add(String(r.emphasisOf));
  // [검증 1회차 blocker] 차례당 한도는 이번 호출이 아니라 그 차례에 이미 넘긴 다시 강조 수를 뺀 나머지(같은 차례에 계획이 다시 돌아도 누적 5건)
  const emphTurn9 = new Set(); for (const r of rs.rows) if (r.kind === "emphasis" && r.status === "delivered" && String(r.deliveredTurn || "") === String(c.turnAnchor)) emphTurn9.add(r.resultId);
  const emph = [...rs.latest.values()]
    .filter((r) => r.kind === "emphasis" && r.repoKey === rk && String(r.provider || "") === prov && r.status === "new")
    .sort((a, b) => String(firstTs.get(a.resultId) || "").localeCompare(String(firstTs.get(b.resultId) || "")))
    .slice(0, Math.max(0, EMPHASIS_PER_TURN - emphTurn9.size))
    .map((r) => Object.assign({}, r, { nth: nth9.get(r.resultId) || 1, ...(resumedBy9.has(r.resultId) ? { resumed: true } : {}) }));
  const cands = [...rs.latest.values()]
    .filter((r) => r.kind === "boundary" && r.repoKey === rk && String(r.provider || "") === prov && (r.status === "new" || r.status === "delivered") && !raised.has(r.resultId) && !hasClaim(ws, r.resultId))
    .sort((a, b) => String(firstTs.get(a.resultId) || "").localeCompare(String(firstTs.get(b.resultId) || "")));
  if (!cands.length) return { deliver: emph, transitions: 0, held: 0 };
  const uw = UW.readUserWordsState(ws);
  const now = Date.now();
  // [검증 1회차 blocker] 한 차례 상한은 이번 호출이 아니라 '이번 차례에 이미 넘긴 결과 수'(장부의 전달 행 — 그 뒤 판단돼 상태가 바뀐 결과도 셈)를 뺀 나머지
  const thisTurn = new Set(); for (const r of rs.rows) if (r.kind === "boundary" && r.status === "delivered" && String(r.deliveredTurn || "") === String(c.turnAnchor)) thisTurn.add(r.resultId); // [⑥] 다시 강조 자료는 판정 경계 한도에 세지 않음
  const room = Math.max(0, DELIVER_PER_TURN - thisTurn.size);
  const deliver = [], trans = []; let held = 0;
  for (const r of cands) {
    if (r.status === "delivered" && r.deliveredTurn === String(c.turnAnchor)) continue; // 이번 차례에 이미 넘김(같은 글을 같은 차례에 되풀이하지 않음)
    const n = r.status === "delivered" ? (Number(r.deliveries) || 0) : 0;
    if (n >= DELIVERY_MAX) { trans.push(resultStatusRow(ws, r, "unhandled", { deliveries: n, by: "harness", reason: "delivered-twice-undecided", turnAnchor: String(c.turnAnchor) })); continue; }
    if (uw.readError) { held++; continue; }
    const w = uw.words.get(String(r.wordId || ""));
    const tRes = Date.parse(String(firstTs.get(r.resultId) || r.ts || ""));
    const expired = w ? UW.wordExpired(w, now) : (!Number.isFinite(tRes) || now - tRes > CL.ATTEMPTS_TTL_MS); // 말 기록이 없으면 결과가 생긴 시각으로(말은 그보다 먼저)
    if (expired) { trans.push(resultStatusRow(ws, r, "expired", { by: "harness", reason: "word-expired", deliveries: n })); continue; }
    if (!w || UW.wordText(ws, w, now) === null) { held++; continue; } // 읽기 보류
    if (deliver.length < room) deliver.push(Object.assign({}, r, { deliveries: n }));
  }
  if (trans.length) { try { appendClassifyResults(ws, trans); } catch { /* 기록 실패=다음 사람의 차례에 같은 판정을 다시 */ } }
  return { deliver: deliver.concat(emph), transitions: trans.length, held };
}
// 전달 블록(구현 담당 주입문) — 자료+명령 한 줄. 매 턴 고정 조각이 아니라 전달이 있는 차례에만 붙는다(분류 실행 뒤 많아야 두 차례).
const DELIVER_QUOTE_SHOW = 200, DELIVER_NOTE_SHOW = 140;
function oneLineOf(s, max) { const t = String(s || "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim(); return t.length > max ? t.slice(0, max) + "…" : t; }
// [⑥ 묶음 3(C)] 다시 강조 자료 줄 — 판단할 것 없음(명령 없음) · '사용자가 ○○를 다시 강조함(n번째)'.
function emphasisBlock(items, en) {
  const tyKo = { core: "수칙서 본문 항목을", archive: "수칙서(관련될 때) 항목을", rule: "규칙 칸을", candidate: "사용자 확인 대기 중인 제안을", "declined-candidate": "사용자가 안 올린 제안을", "declined-seat": "사용자가 안 올린 제안을", result: "앞선 판정 경계 결과를" }; // 조사까지(받침에 맞춤)
  const tyEn = { core: "rulebook item", archive: "rulebook item (when relevant)", rule: "rule box", candidate: "proposal awaiting the user's approval", "declined-candidate": "proposal the user declined", "declined-seat": "proposal the user declined", result: "earlier judgement-boundary result" };
  const head = en ? `[User-words classification — re-emphasis ${items.length} · for information, nothing to decide]` : `[사용자 말 분류 결과 — 다시 강조 ${items.length}건 · 자료(판단할 것 없음)]`;
  const lines = items.map((r) => {
    const ty = String((r.target && r.target.type) || "");
    const lab = en ? (tyEn[ty] || "item already present") : (tyKo[ty] || "이미 있는 항목을");
    const res = r.resumed ? (en ? " — passed to you again with the new words (a judgement result above/next)" : " — 새로 하신 말로 다시 넘김(판단 대상)") : "";
    return en
      ? `- the user re-emphasised ${lab} (time #${r.nth || 1}): "${oneLineOf(r.itemText, 100)}"${res}\n  words: "${oneLineOf(r.quote, DELIVER_QUOTE_SHOW)}"`
      : `- 사용자가 ${lab} 다시 강조함(${r.nth || 1}번째): "${oneLineOf(r.itemText, 100)}"${res}\n  하신 말: "${oneLineOf(r.quote, DELIVER_QUOTE_SHOW)}"`;
  });
  return [head, ...lines].join("\n");
}
function deliveryBlock(results, lang) {
  if (!results || !results.length) return "";
  const en = lang === "en";
  const emp = results.filter((r) => r.kind === "emphasis"); // [⑥] 다시 강조=자료 줄(아래) · 그 밖=판정 경계(판단 대상)
  results = results.filter((r) => r.kind !== "emphasis");
  if (!results.length) return emphasisBlock(emp, en);
  const seatKo = { supportedEnv: "지원 환경", alwaysBlocker: "항상 막을 것", outOfScope: "범위 밖" };
  const seatEn = { supportedEnv: "supported environment", alwaysBlocker: "always block", outOfScope: "out of scope" };
  const head = en ? `[User-words classification — decide ${results.length} this turn]` : `[사용자 말 분류 결과 — 이번 차례 판단 ${results.length}건]`;
  const items = results.map((r) => {
    const k = (Number(r.deliveries) || 0) + 1;
    const seat = r.seat ? (en ? seatEn[r.seat] || r.seat : seatKo[r.seat] || r.seat) + "(" + r.seat + ")" : "";
    return en
      ? `- ${r.resultId} · suggested section ${seat} · delivery ${k}/${DELIVERY_MAX}\n  words: "${oneLineOf(r.quote, DELIVER_QUOTE_SHOW)}"\n  effect on judging: ${oneLineOf(r.bounds, DELIVER_NOTE_SHOW)} · why: ${oneLineOf(r.why, DELIVER_NOTE_SHOW)}`
      : `- ${r.resultId} · 제안 칸 ${seat} · 전달 ${k}/${DELIVERY_MAX}회째\n  말: "${oneLineOf(r.quote, DELIVER_QUOTE_SHOW)}"\n  판정 영향: ${oneLineOf(r.bounds, DELIVER_NOTE_SHOW)} · 이유: ${oneLineOf(r.why, DELIVER_NOTE_SHOW)}`;
  });
  const raise = CL.bridgeCmd("codex-bridge.js", 'constraint add --quote "' + (en ? "<a phrase inside the words above>" : "<위 말 안의 구절>") + '" --rule "' + (en ? "<the rulebook line in plain words: who/what, when>" : "<수칙서에 들어갈 문안 — 쉬운 말·누가/무엇에·언제>") + '" --bounds "' + (en ? "<how it changes judging, one line>" : "<판정에 미치는 영향 한 줄>") + '" --why "' + (en ? "<one-line reason>" : "<근거 한 줄>") + '" --from <id> [--axis supportedEnv|alwaysBlocker|outOfScope]'); // [④ 묶음 6(H)] 올림에는 문안·영향 칸 필수
  const skip = CL.bridgeCmd("codex-bridge.js", 'classify skip <id> --note "' + (en ? "<one-line reason>" : "<이유 한 줄>") + '"');
  const cmd = en
    ? `Raise: ${raise} · Not raise: ${skip} — commands only, without listing these in the conversation or asking the user (the user approves on the dashboard).`
    : `올림: ${raise} · 안 올림: ${skip} — 대화에 늘어놓거나 사용자에게 묻지 않고 이 명령으로만(승인은 사용자가 대시보드에서).`;
  return [head, ...items, cmd].join("\n") + (emp.length ? "\n" + emphasisBlock(emp, en) : "");
}
// ── [⑤ 3단계] 종료 관문(판단 강제 · §3-1 6) — 이번 차례에 넘겨받고 아직 판단하지 않은 결과가 있으면 그 차례를 끝내지 못한다.
// 다른 종료 조건(검증·판단 관문·규칙 자가점검·상한 마감)이 모두 통과한 뒤에만 부른다 — 검증 안내가 먼저 보이게(두 Stop 훅 공통).
// 반복 상한: 같은 상태(같은 차례·같은 미판단 목록)로 STOP_GATE_MAX 번 막은 뒤에는 막지 않고 노랑 경보 1건으로 끝낸다(무한 종료 막기 방지 —
// 사용량 보호 · 그 결과들은 다음 사람의 차례에 한 번 더 넘어가고 그때도 미판단이면 '구현 담당 미처리'). 하나라도 판단하면 상태가 바뀌어 다시 셈.
// 판독 오류(장부)=관문 없음(판단 강제는 검증 위조 방지 장치가 아니라 공급 흐름 — 못 읽는 장부로 턴 종료를 막지 않음) · 단 관문 기록은 그대로 둔다
// (못 읽음≠없음 — [검증 1회차 blocker] 지우면 회복 뒤 같은 상태를 1부터 다시 막고 경보를 또 씀). 관문 기록 자체를 못 읽으면(없음과 구분) 저장 실패와 같이
// 막지 않고 경보 — [검증 1회차 blocker] 못 읽는 횟수를 매번 1로 세면 끝없이 막는다. 경보는 같은 상태(회사·세션·상태 지문)당 1건만(gateKey — 닫은 경보를 되살리지 않음).
const STOP_GATE_MAX = 3;
const STOP_GATE_DIR = path.join(CLASSIFY_DIR, "stop-gate");
function stopGateFileFor(provider, sessionId) { return path.join(STOP_GATE_DIR, String(provider || "x") + "-" + String(sessionId || "nosession").replace(/[^0-9a-zA-Z._-]/g, "_") + ".json"); }
function stopGateText(pending, lang) {
  const en = lang === "en";
  const list = pending.map((r) => r.resultId + ' "' + oneLineOf(r.quote, 60) + '"').join(", ");
  const raise = CL.bridgeCmd("codex-bridge.js", 'constraint add --quote "' + (en ? "<a phrase inside those words>" : "<그 말 안의 구절>") + '" --rule "' + (en ? "<the rulebook line in plain words: who/what, when>" : "<수칙서에 들어갈 문안 — 쉬운 말·누가/무엇에·언제>") + '" --bounds "' + (en ? "<how it changes judging, one line>" : "<판정에 미치는 영향 한 줄>") + '" --why "' + (en ? "<one-line reason>" : "<근거 한 줄>") + '" --from <id> [--axis supportedEnv|alwaysBlocker|outOfScope]'); // [④ 묶음 6(H)]
  const skip = CL.bridgeCmd("codex-bridge.js", 'classify skip <id> --note "' + (en ? "<one-line reason>" : "<이유 한 줄>") + '"');
  return en
    ? `[User-words classification gate] ${pending.length} classification result(s) handed to you this turn are still undecided, so this turn cannot end: ${list}. Raise: ${raise} · Not raise: ${skip} — commands only, without listing these in the conversation or asking the user.`
    : `[분류 결과 판단 관문] 이번 차례에 넘겨받은 사용자 말 분류 결과 ${pending.length}건을 아직 판단하지 않아 이 턴을 끝낼 수 없다: ${list}. 올림: ${raise} · 안 올림: ${skip} — 대화에 늘어놓거나 사용자에게 묻지 않고 이 명령으로만.`;
}
// [검증 1회차 보완] 경보 문구는 남은 전달 횟수에 맞춘다 — 이미 두 번째로 넘겨받은 결과는 다음 차례에 더 넘어가지 않고 '구현 담당 미처리'로 끝난다(planDelivery).
function stopGateWarnText(pending, why, lang) {
  const ids = pending.map((r) => r.resultId).join(", ");
  const last = pending.filter((r) => (Number(r.deliveries) || 0) >= DELIVERY_MAX).length, again = pending.length - last;
  if (lang === "en") {
    const tail = [again ? `${again} can be handed over once more on the next human turn (if still undecided then, 'not handled by the implementer')` : "", last ? `${last} were already on their second hand-over and remain as 'not handled by the implementer' on the next human turn` : ""].filter(Boolean).join("; ");
    return `The implementer ended this turn without deciding ${pending.length} user-words classification result(s) handed over in it (${ids}) (${why}) — ${tail}.`;
  }
  const tail = [again ? `${again}건은 다음 사람의 차례에 한 번 더 넘어갈 수 있고(그때도 판단이 없으면 '구현 담당 미처리')` : "", last ? `${last}건은 이미 두 번째로 넘겨받은 것이라 다음 사람의 차례에 '구현 담당 미처리'로 남습니다` : ""].filter(Boolean).join(" · ");
  return `이번 차례에 넘겨받은 사용자 말 분류 결과 ${pending.length}건(${ids})을 구현 담당이 판단하지 않은 채 턴이 끝났습니다(${why}) — ${tail}.`;
}
function stopGateWarnOnce(ws, c, pending, epoch, whyKo, whyEn, lang) {
  const gateKey = sha1(String(c.provider || "") + "|" + String(c.sessionId || "") + "|" + epoch);
  try { if (CL.readIntegrityEvents().some((e) => e && e.kind === "classify-undecided" && e.gateKey === gateKey)) return; } catch { /* 못 읽음=아래에서 씀(경보 누락보다 중복이 낫다) */ }
  const ko = stopGateWarnText(pending, whyKo, "ko"), en = stopGateWarnText(pending, whyEn, "en");
  try { CL.appendIntegrityEvent({ ts: new Date().toISOString(), session: String(c.sessionId || ""), workspace: ws, kind: "classify-undecided", severity: "warning", gateKey, detail: lang === "en" ? en : ko, detailKo: ko, detailEn: en }, { supersedeSameKindWs: true }); } catch { /* 경보 실패=종료는 그대로 */ }
}
// 반환 { block: 안내문 } | null(막지 않음). ctx={turnAnchor, repoKey, provider, sessionId}. opts={lang}
function classifyStopGate(ws, ctx, opts) {
  const c = ctx || {}, o = opts || {};
  let pending = null;
  try { pending = deliveredUndecided(ws, c); } catch { pending = null; }
  const f = stopGateFileFor(c.provider, c.sessionId);
  if (pending === null) return null; // 장부 판독 오류=관문 없음 · 관문 기록 보존(못 읽음≠없음)
  if (!pending.length) { try { fs.rmSync(f, { force: true }); } catch { /* 무해 */ } return null; } // 넘겨받은 미판단이 실제로 없음을 확인했을 때만 정리
  const epoch = sha1(JSON.stringify({ turn: String(c.turnAnchor || ""), ids: pending.map((r) => r.resultId).sort() }));
  let prev = null, unreadable = false;
  try { const v = JSON.parse(fs.readFileSync(f, "utf8")); if (v && typeof v === "object" && !Array.isArray(v)) prev = v; else unreadable = true; }
  catch (e) { if (!(e && (e.code === "ENOENT" || e.code === "ENOTDIR"))) unreadable = true; } // 없음(경로 중간이 폴더가 아님 포함 — 운영체제마다 다르게 알림)
  if (unreadable) { // 횟수를 확인할 수 없음=막지 않음(저장 실패와 같은 처리) · 읽을 수 있는 기록으로 갈아 두어 다음 종료부터는 '놓아줌'으로 조용히 통과
    stopGateWarnOnce(ws, c, pending, epoch, "횟수 기록 판독 실패", "count read failed", o.lang);
    try { CL.atomicWrite(f, JSON.stringify({ epoch, n: STOP_GATE_MAX + 1, gaveUp: true, ts: new Date().toISOString() })); } catch { /* 무해 — 다음 종료도 막지 않음 */ }
    return null;
  }
  if (prev && prev.epoch === epoch && prev.gaveUp === true) return null; // 이 상태는 이미 상한으로 놓아줌(경보 기록됨) — 같은 상태로 다시 막기를 시작하지 않음
  const n = prev && prev.epoch === epoch ? (Number(prev.n) || 0) + 1 : 1;
  let saved = false; try { fs.mkdirSync(STOP_GATE_DIR, { recursive: true }); saved = CL.atomicWrite(f, JSON.stringify({ epoch, n, ts: new Date().toISOString() })) === true; } catch { saved = false; }
  if (!saved || n > STOP_GATE_MAX) { // 횟수를 못 세면(저장 실패) 막지 않는다 — 셀 수 없는 차단은 끝없는 차단이 될 수 있음
    stopGateWarnOnce(ws, c, pending, epoch, saved ? "반복 종료 막기 상한" : "횟수 기록 실패", saved ? "repeat stop-block limit" : "count write failed", o.lang);
    if (saved) { try { CL.atomicWrite(f, JSON.stringify({ epoch, n, gaveUp: true, ts: new Date().toISOString() })); } catch { /* 기록 실패=다음 종료에서 다시 셈(유한) */ } } // 같은 상태로 막기→놓아주기가 되풀이되지 않게
    return null;
  }
  return { block: stopGateText(pending, o.lang), n, pending: pending.map((r) => r.resultId) };
}
function userConstraintIdFor(ws, repoKey, quote) { return CL.envelopeCandidateId("user-constraint", CL.wsKeyFor(ws) + "|" + repoKey + "|" + sha1(qNormOf(quote))); } // constraintAdd 와 같은 산식(같은 말=같은 후보)

// ── 입력 집계 ── 반환 {ok, empty?, wsKey, repoKey, gen, virtual, provider, arm, items[], unavailable[], existing{...}, inputFp} | {ok:false, reason}
function classifyInput(ws, repo, opts) {
  const o = opts || {};
  const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!c) return { ok: false, reason: "contract-unreadable" };
  const wsKey = CL.wsKeyFor(ws), repoKey = CL.repoKeyOf(repo);
  let g = null; try { g = CL.envelopeGenFor(ws, repo, c); } catch { g = null; }
  if (!g || !g.gen) return { ok: false, reason: "envelope-inactive", detail: g ? String(g.st || "") : "" }; // 수칙서 승인 전·손상=수칙서 자리 후보를 받을 수 없음 — 대기열 보존(소모 안 함)
  const q = UW.queuedWords(ws, repoKey);
  if (q === null) return { ok: false, reason: "queue-unreadable" };
  const base = { ok: true, wsKey, repoKey, gen: g.gen, virtual: !!g.virtual };
  if (!q.length) return Object.assign(base, { empty: true, items: [], unavailable: [], pastedOnly: [] });
  const provider = providerOf(q[0]); // 가장 오래된 말의 회사부터(한 실행=한 회사 — R3)
  const items = [], unavailable = [], pastedOnly = [];
  let chars = 0;
  for (const w of q) {
    if (providerOf(w) !== provider) continue;
    if (items.length >= CLASSIFY_BATCH_WORDS) break;
    const t = UW.wordText(ws, w);
    if (t === null) { unavailable.push(w.id); continue; } // 보존 기간 밖·변조·소실=분류 불가(보류로 표면)
    if (!t.trim()) { pastedOnly.push(w.id); continue; } // [RULE-SUPPLY-CORRECTION 묶음 5(G)] 사용자가 쓴 부분이 빔(붙여 넣은 글뿐)=분류 담당에게 보내지 않음
    const red = redactSensitiveForms(t);
    const shown = red.length > CLASSIFY_WORD_SHOW ? red.slice(0, CLASSIFY_WORD_SHOW) + "\n" + REDACTED + "(" + (red.length - CLASSIFY_WORD_SHOW) + ")" : red;
    if (items.length && chars + shown.length > CLASSIFY_BATCH_CHARS) break;
    chars += shown.length;
    items.push({ ref: "u" + (items.length + 1), id: w.id, source: w.source, text: t, shown, retries: Number(w.retries) || 0, turnAnchor: String(w.turnAnchor || ""), sessionId: String(w.sessionId || ""), sourceHash: String(w.sourceHash || ""), kind: String(w.kind || "") });
  }
  // '이미 있는 것' — 같은 뜻 재상신 방지 재료(판단은 LLM — 문구 대조 금지 · §3-4b)
  // [⑥ 묶음 3(C)] 목록 항목마다 '가리키는 대상'(refMeta)을 함께 둔다 — 항목 번호는 실행마다 바뀌므로 다시 강조 결과에는 번호가 아니라 이 대상을 남긴다.
  //  수칙서 항목=정규화 문안 지문(대시보드 수칙 줄·빼기 결속과 같은 식 — 수칙서가 바뀌어도 같은 문장에만 따라가고 같은 자리의 다른 문장에는 붙지 않음) +
  //  그때의 축·번호·세대(감사용) · 대기/안 올린 제안=후보 id · 앞선 판정 경계 결과=결과 id · 규칙 칸·옛 자리=문안 지문.
  const fpOf = (x) => sha1(CL.normBacklogTitle(String(x)));
  const rulebook = [];
  try { const ev = CL.readVerifyEnvelope(repo); if (ev && ev.st === "ok") for (const ax of RULEBOOK_SEATS) (ev.data[ax] || []).forEach((x, i) => rulebook.push({ t: ax + ": " + x, m: { type: "core", axis: ax, index: i, fp: fpOf(x), gen: String(ev.sha1 || "") } })); } catch { /* 0세대·판독 실패=빈 목록 */ }
  try { const ah = typeof c.archiveHash === "string" && c.archiveHash ? c.archiveHash : ""; if (ah) { const ar = CL.readVerifyEnvelopeArchive(repo); if (ar.st === "ok" && ar.sha1 === ah) ar.data.alwaysBlocker.forEach((x, i) => rulebook.push({ t: "alwaysBlocker(관련될 때): " + x, m: { type: "archive", axis: "alwaysBlocker", index: i, fp: fpOf(x), gen: String(ar.sha1 || "") } })); } } catch { /* 서고 없음 */ }
  const rules = normRuleList(c[rulesFieldFor(provider)]).map((x) => ({ t: x, m: { type: "rule", provider, fp: fpOf(x) } }));
  // [검증 1회차 f-7ccbb34a · R3] 확인 대기·안 올림 목록의 문장도 '승인 전 사용자 원문'이다 — 이번 실행 회사의 말만 싣는다(회사 표기 없는 옛 행=제외).
  // 승인된 수칙서 문안·결정 기록·그 회사 규칙 칸은 승인 뒤 문장이라 그대로. 다른 회사 거절분의 같은 말은 커밋 단계의 후보 id 거절 기억이 여전히 막는다.
  const sameCo = (r) => String((r && r.provider) || "") === provider;
  const pending = [], declined = [];
  try {
    const cst = CL.readEnvelopeCandidatesState(ws);
    if (!cst.readError) {
      const seen = new Set();
      const firstOf = new Map(); for (const r of cst.rows) if (r && r.candidateId && !firstOf.has(r.candidateId) && r.kind === "user-constraint") firstOf.set(r.candidateId, r); // 상태 행은 회사 표기가 없을 수 있어 첫 행 기준
      for (const r of cst.rows) {
        if (!r || r.kind !== "user-constraint" || r.repoKey !== repoKey || seen.has(r.candidateId)) continue;
        if (!sameCo(firstOf.get(r.candidateId))) continue;
        seen.add(r.candidateId);
        if (CL.userDeclinedCandidate(cst.rows, r.candidateId)) declined.push({ t: r.title, m: { type: "declined-candidate", candidateId: r.candidateId } });
        else { const cur = cst.latest.get(r.candidateId + "@" + g.gen); if (cur && cur.status === "proposed") pending.push({ t: r.title, m: { type: "candidate", candidateId: r.candidateId } }); }
      }
    }
  } catch { /* 없음 */ }
  // 옛 자리 장부: 사용자가 안 올린 문장만 '안 올림'으로 싣는다(같은 말을 수칙서 후보로 다시 올리지 않게) · 대기 중이던 옛 자리 제안은 승인 길이 없어 싣지 않음(D-d)
  try { const ss = readSeatsState(ws); if (!ss.readError) for (const r of ss.latest.values()) { if (r.repoKey !== repoKey || !sameCo(r)) continue; if (r.status === "declined") declined.push({ t: r.quote, m: { type: "declined-seat", fp: fpOf(r.quote) } }); } } catch { /* 없음 */ }
  // [묶음 2(⑤)] 구현 담당 판단을 기다리는 판정 경계 결과(같은 회사·같은 저장소 — 승인 전 원문이라 R3) — 같은 뜻 반복을 다시 판정 경계로 내지 않게
  const waiting = [], skippedL = [];
  const rs = readClassifyResults(ws);
  if (rs.readError) return { ok: false, reason: "results-unreadable" }; // 판독 오류=빈 목록으로 줄이지 않음(같은 뜻 결과 중복 생성 방지 — 대기열 보존)
  const raised9 = raisedResultIds(ws);
  if (raised9 === null) return { ok: false, reason: "candidates-unreadable" };
  // [⑥ 묶음 3(C) · §3-1 5·6] '구현 담당 미처리'(두 번 넘겨받고도 판단 없음)도 판단을 기다리는 것으로 · 구현 담당이 안 올린 판정 경계는 따로(S) — 사용자가 같은 뜻을
  //  다시 말하면(다시 강조) 새 전달 주기로 다시 넘기는 재료(commitClassify).
  const clS9 = readClaimsState(ws);
  if (clS9.readError) return { ok: false, reason: "claims-unreadable" }; // [검증 1회차 blocker] 판단 표식을 못 읽음=유효 상태를 모름 — 빈 것으로 줄이지 않고 입력 거절(말 보존)
  const claims9 = new Map(); for (const cl of clS9.claims) claims9.set(cl.resultId, cl.claim ? cl.claim : { decision: "unknown" });
  for (const r of rs.latest.values()) {
    if (r.kind !== "boundary" || r.repoKey !== repoKey || !sameCo(r)) continue;
    const st = effectiveResultStatus(r, raised9, claims9); // 판단 표식 반영(표식에만 남은 안 올림=S)
    if (st === "new" || st === "delivered" || st === "unhandled") waiting.push({ t: r.quote, m: { type: "result", resultId: r.resultId } });
    else if (st === "skipped") skippedL.push({ t: r.quote, m: { type: "result", resultId: r.resultId } });
  }
  const capM = (arr) => arr.filter((x) => x && x.t).slice(0, CLASSIFY_LIST_MAX);
  const lists = { rulebook: capM(rulebook), rules: capM(rules), pending: capM(pending), declined: capM(declined), waiting: capM(waiting), skipped: capM(skippedL) };
  const existing = {}; for (const k of Object.keys(lists)) existing[k] = lists[k].map((x) => oneLine(redactSensitiveForms(x.t), 200));
  // 항목 번호(다시 강조의 itemRef 대상) — 종류별 머리글자+순번. 결과에는 번호·그 문장·가리키는 대상(refMeta)을 함께 남긴다(번호는 실행마다 바뀔 수 있음).
  const refs = {}, refMeta = {};
  const lab = (pre, k) => lists[k].map((x, i) => { const id = pre + (i + 1); refs[id] = existing[k][i]; refMeta[id] = x.m; return id; });
  const labels = { rulebook: lab("B", "rulebook"), rules: lab("R", "rules"), pending: lab("P", "pending"), declined: lab("N", "declined"), waiting: lab("W", "waiting"), skipped: lab("S", "skipped") };
  const inputFp = sha1(JSON.stringify({ ids: items.map((x) => x.id), existing }));
  return Object.assign(base, { provider, arm: armForProvider(provider), items, unavailable, pastedOnly, existing, labels, refs, refMeta, inputFp });
}

// ── 프롬프트 — 범주 정의만(구체 예시·키워드 없음 — 경직성 금지) ──
function buildClassifyPrompt(input, lang) {
  const en = lang === "en";
  const L = [];
  L.push(en ? "You are an independent classifier of a user's words. Below are things the user said to an AI implementer in one project. You only decide what KIND of statement each relevant sentence is — you do not write anything anywhere. Most messages are one-off requests, questions, confirmations or reactions and are none of the kinds below — no result is better than a weak one. At most " + CLASSIFY_MAX_PER_RUN + "."
    : "당신은 독립 '사용자 말 분류' 담당입니다. 아래는 한 프로젝트에서 사용자가 구현 담당(AI)에게 한 말입니다. 당신은 관련 문장이 어떤 '성격'인지만 가릅니다 — 어디에도 직접 쓰지 않습니다. 대부분의 말은 이번 작업 요청·질문·확인·감상이라 아래 어느 성격도 아닙니다 — 약한 결과보다 무결과가 낫습니다. 최대 " + CLASSIFY_MAX_PER_RUN + "건.");
  L.push(en ? "Kinds: boundary = a standard for JUDGING this project that keeps applying to the whole of the following work; it decides what a verifier must treat as out of scope or as always a defect. You must be able to state in one line (bounds) how it changes a verdict — if you cannot, it is not a boundary. seat = supportedEnv (environment/target/range the project is judged against) | alwaysBlocker (always a defect when violated) | outOfScope (not covered now, must not be flagged). emphasis = the user says again what an item in the 'already present' lists already says — itemRef = that item's label; if the repeat also adds a NEW condition that item does not have (a new target, range or exception), output the emphasis AND a separate boundary that quotes only the new-condition passage (do not merge them). style = a lasting request about HOW the implementer works or talks (order of steps, reporting format, what to do directly instead of handing to the user, wording, etc.) — this is not a rulebook item; the user decides whether to write it into their own rule box."
    : "성격: boundary(판정 경계) = 이 프로젝트를 검증할 때 이후 작업 전체에 계속 적용되는 판정 기준 — 검증 담당이 무엇을 범위 밖으로 돌려야 하는지 또는 무엇을 언제나 결함으로 봐야 하는지를 정하는 말. 그것이 판정을 어떻게 바꾸는지 한 줄(bounds)로 적을 수 있어야 하며, 적을 수 없으면 판정 경계가 아닙니다. seat=supportedEnv(판정 기준이 되는 실행 환경·대상·범위) | alwaysBlocker(어기면 언제나 결함) | outOfScope(지금 다루지 않아 결함으로 잡지 말 것). emphasis(다시 강조) = 아래 '이미 있는 것' 목록의 한 항목과 같은 뜻을 사용자가 다시 말함 — itemRef=그 항목 번호. 다시 말하면서 그 항목에 없던 새 조건(새 대상·범위·예외)을 더했으면 emphasis 하나와, 새 조건 구절만 인용한 boundary 하나를 따로 냅니다(섞지 않음). style(일하는 방식) = 구현 담당이 일하거나 말하는 방식에 대한 지속 요구(진행 순서·보고 형식·사용자에게 넘기지 않고 직접 할 일·말투 등) — 수칙서 항목이 아니며, 규칙 칸에 적을지는 사용자가 정합니다.");
  L.push(en ? "Rules: quote = an UNCHANGED contiguous passage of that message (12–200 chars, one line) — no summary, translation or stitching; a single changed character is rejected. Never quote a passage containing " + REDACTED + ". why = one line (8–120 chars) on why it has this kind. bounds (boundary only) = one line (8–200 chars) on how it changes a verdict. No secrets/personal data. A sentence that means the same as an 'already present' item is emphasis, never a new boundary. One-off instructions for the current task, questions and feelings are none of the kinds."
    : "규칙: quote=그 말 원문에서 바꾸지 않은 연속 구절(12~200자·한 줄) — 요약·번역·이어 붙이기 금지, 한 글자라도 다르면 거부됩니다. " + REDACTED + " 표시가 들어간 구절은 쓰지 마세요. why=왜 그 성격인지 한 줄(8~120자). bounds(boundary 만)=판정을 어떻게 바꾸는지 한 줄(8~200자). 비밀값·개인정보 금지. '이미 있는 것'의 한 항목과 같은 뜻이면 새 판정 경계가 아니라 emphasis 입니다. 이번 작업에만 해당하는 지시·질문·감정 표현은 어느 성격도 아닙니다.");
  L.push(en ? "Output exactly one JSON object and nothing else: {\"results\":[{\"ref\":\"u1\",\"kind\":\"boundary\",\"quote\":\"…\",\"seat\":\"supportedEnv|alwaysBlocker|outOfScope\",\"why\":\"…\",\"bounds\":\"…\"},{\"ref\":\"u2\",\"kind\":\"emphasis\",\"quote\":\"…\",\"itemRef\":\"B1\",\"why\":\"…\"},{\"ref\":\"u3\",\"kind\":\"style\",\"quote\":\"…\",\"why\":\"…\"}]} — none: {\"results\":[]}."
    : "출력은 JSON 객체 하나뿐(다른 글 금지): {\"results\":[{\"ref\":\"u1\",\"kind\":\"boundary\",\"quote\":\"…\",\"seat\":\"supportedEnv|alwaysBlocker|outOfScope\",\"why\":\"…\",\"bounds\":\"…\"},{\"ref\":\"u2\",\"kind\":\"emphasis\",\"quote\":\"…\",\"itemRef\":\"B1\",\"why\":\"…\"},{\"ref\":\"u3\",\"kind\":\"style\",\"quote\":\"…\",\"why\":\"…\"}]} — 없음은 {\"results\":[]}.");
  L.push("");
  const ex = input.existing, lb = input.labels || {};
  const dump = (label, key) => { const arr = ex[key] || [], ids = lb[key] || []; L.push(label + (arr.length ? "" : (en ? " (none)" : " (없음)"))); arr.forEach((x, i) => L.push("- " + (ids[i] ? ids[i] + ": " : "") + x)); };
  dump(en ? "[Already present — rulebook]" : "[이미 있는 것 — 수칙서]", "rulebook");
  dump(en ? "[Already present — rule box the user writes]" : "[이미 있는 것 — 사용자가 직접 쓰는 규칙 칸]", "rules");
  dump(en ? "[Already present — waiting for the user]" : "[이미 있는 것 — 사용자 확인 대기]", "pending");
  dump(en ? "[Already present — the user chose not to adopt]" : "[이미 있는 것 — 사용자가 안 올림]", "declined");
  dump(en ? "[Already present — earlier results waiting for the implementer]" : "[이미 있는 것 — 구현 담당 판단을 기다리는 앞선 결과]", "waiting");
  dump(en ? "[Already present — earlier results the implementer chose not to raise]" : "[이미 있는 것 — 구현 담당이 올리지 않은 앞선 결과]", "skipped"); // [⑥ 묶음 3(C)]
  L.push("");
  L.push(en ? "[User's words — oldest first]" : "[사용자 말 — 오래된 것부터]");
  for (const it of input.items) {
    const src = it.source === "choice" ? (en ? "typed into a choice prompt" : "선택지에 직접 입력") : (en ? "chat input" : "입력창");
    L.push("<<" + it.ref + " · " + src + ">>");
    L.push(it.shown);
    L.push("<</" + it.ref + ">>");
  }
  return L.join("\n");
}

// ── 정해진 틀(AFTER-0.1.104-FIXES 설계 A-1 · A3) — Claude 도우미가 이 모양으로만 답하게 한다. 판독기(아래)는 그대로 엄격 — 틀은 판독기 앞에서
// 모양만 강제하고, 길이·원문 대조·민감 형식 같은 의미 검사는 판독기 몫(틀로 옮기지 않음). 목록이 비면 열거를 두지 않는다(빈 열거=틀 손상).
function classifySchema(input) {
  const refs = Object.keys((input && input.refs) || {});
  const words = ((input && input.items) || []).map((it) => String(it.ref));
  const props = {
    ref: words.length ? { type: "string", enum: words } : { type: "string" },
    kind: { type: "string", enum: CLASSIFY_KINDS.slice() },
    quote: { type: "string" },
    why: { type: "string" },
    seat: { type: "string", enum: SEATS.slice() },
    bounds: { type: "string" },
    itemRef: refs.length ? { type: "string", enum: refs } : { type: "string" },
  };
  return { type: "object", additionalProperties: false, required: ["results"], properties: { results: { type: "array", maxItems: CLASSIFY_MAX_PER_RUN, items: { type: "object", additionalProperties: false, required: ["ref", "kind", "quote", "why"], properties: props } } } };
}

// ── 파서 — 손상(JSON 아님·배열 아님·상한 초과·자리 밖·필수 형식 위반)=전량 거부(fail-closed). 의미 거부(원문 불일치·민감·형식)=항목 탈락+사유.
function parseClassifyOutput(raw, input) {
  let text = String(raw || "").trim();
  { const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/.exec(text); if (m) text = m[1].trim(); } // 코드 울타리 1겹(정리 담당과 같은 관용)
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, reason: "no-json" };
  let o = null; try { o = JSON.parse(text); } catch { return { ok: false, reason: "bad-json" }; }
  if (!o || typeof o !== "object" || !Array.isArray(o.results)) return { ok: false, reason: "no-results-array" };
  if (Object.keys(o).some((k) => k !== "results")) return { ok: false, reason: "unknown-top-key" }; // [검증 1회차 blocker] 옛 담기 이름(candidates) 등이 섞인 답=전량 거부(받아들이면 그 안의 결과가 버려진 채 말이 분류 완료로 소모됨)
  if (o.results.length > CLASSIFY_MAX_PER_RUN) return { ok: false, reason: "too-many" };
  const byRef = new Map(input.items.map((it) => [it.ref, it]));
  const refs = (input && input.refs) || {};
  const vocab = [CL.FINDINGS_MARKERS.ko, CL.FINDINGS_MARKERS.en, CL.FINDINGS_MARKERS_V2.ko, CL.FINDINGS_MARKERS_V2.en].flatMap((m) => [m.start, m.end]);
  const oneLineOk = (v, min, max) => typeof v === "string" && !/[\r\n\u2028\u2029]/.test(v) && v.trim().length >= min && v.trim().length <= max;
  const items = [], dropped = [];
  const seen = new Set();
  for (const p of o.results) {
    if (!p || typeof p !== "object") return { ok: false, reason: "row-not-object" };
    const kind = String(p.kind || "");
    if (!CLASSIFY_KINDS.includes(kind)) return { ok: false, reason: "bad-kind" }; // 성격 밖(옛 자리 이름 포함)=답 손상 — 전량 거부
    if (typeof p.quote !== "string" || typeof p.why !== "string" || typeof p.ref !== "string") return { ok: false, reason: "bad-row" };
    // 형식(한 줄·길이) 위반=답 손상 — 전량 거부(항목 탈락으로 처리하면 말이 재시도 없이 분류 완료로 소모된다 — 검증 1회차 f-25b85198)
    if (!oneLineOk(p.why, 8, CL.CONSTRAINT_WHY_MAX)) return { ok: false, reason: "bad-why" };
    let seat = "", bounds = "", itemRef = "";
    if (kind === "boundary") {
      seat = String(p.seat || "");
      if (!SEATS.includes(seat)) return { ok: false, reason: "bad-seat" };
      if (!oneLineOk(p.bounds, CLASSIFY_BOUNDS_MIN, CLASSIFY_BOUNDS_MAX)) return { ok: false, reason: "bad-bounds" }; // §3-1 1항 — 판정 영향을 못 적으면 판정 경계가 아님
      bounds = p.bounds.trim();
    } else if (kind === "emphasis") {
      itemRef = String(p.itemRef || "");
      if (!Object.prototype.hasOwnProperty.call(refs, itemRef)) return { ok: false, reason: "bad-itemref" }; // 목록에 없는 번호=답 손상
    }
    const drop = (reason) => { dropped.push({ ref: p.ref, kind, ...(seat ? { seat } : {}), reason }); };
    const it = byRef.get(p.ref);
    if (!it) { drop("unknown-ref"); continue; }
    const q = p.quote;
    if (q.trim().length < CL.CONSTRAINT_QUOTE_MIN) { drop("too-short"); continue; }
    if (q.length > CL.CONSTRAINT_QUOTE_MAX) { drop("too-long"); continue; }
    if (/[\r\n\u2028\u2029]/.test(q)) { drop("multiline"); continue; }
    if (q.includes(REDACTED)) { drop("redacted-span"); continue; }
    if (!it.text.includes(q)) { drop("not-in-words"); continue; } // 원문 대조(작문 차단) — 보여 준 부분이 아니라 사용자가 쓴 부분 전체(붙여 넣은 구간 제외 — 묶음 5(G))
    if (vocab.some((v) => q.includes(v))) { drop("protocol-vocab"); continue; }
    const qs = CL.safeBacklogAutoTitle(q); if (!qs.ok) { drop("sensitive-" + qs.reasonKey); continue; }
    const why = p.why.trim();
    const ws9 = CL.safeBacklogAutoTitle(why); if (!ws9.ok) { drop("why-sensitive-" + ws9.reasonKey); continue; }
    if (bounds) { const bs9 = CL.safeBacklogAutoTitle(bounds); if (!bs9.ok) { drop("bounds-sensitive-" + bs9.reasonKey); continue; } }
    const dk = kind + "|" + qNormOf(q); if (seen.has(dk)) { drop("duplicate-in-run"); continue; } seen.add(dk);
    items.push({ ref: p.ref, wordId: it.id, kind, quote: q, why, ...(seat ? { seat } : {}), ...(bounds ? { bounds } : {}), ...(itemRef ? { itemRef, itemText: String(refs[itemRef]), ...(input.refMeta && input.refMeta[itemRef] ? { target: Object.assign({}, input.refMeta[itemRef]) } : {}) } : {}) });
  }
  return { ok: true, items, dropped };
}

// ── 커밋 — [묶음 2(⑤)] 분류 결과 장부에만 쓴다(수칙서 후보 장부·규칙 칸·결정 장부 무접촉), 그다음 말 상태(classified). 중간 중단=말이 queued 로 남아
// 다음 실행이 다시 분류하고, 같은 결과 id(작업공간·저장소·성격·인용·말 id)는 건너뛴다(멱등). 반환 {ok, resultIds, counts, dropped, reason?}
function commitClassify(ws, input, parsed, meta) {
  const m = meta || {};
  const runId = String(m.runId || "");
  const byWord = new Map(input.items.map((it) => [it.id, it]));
  const rs = readClassifyResults(ws);
  if (rs.readError) return { ok: false, reason: "results-unreadable" };
  const cst = CL.readEnvelopeCandidatesState(ws); // 판정 경계의 거절 기억·이미 있는 후보 확인용(읽기만)
  if (cst.readError) return { ok: false, reason: "candidates-unreadable" };
  const sameQuote = new Set(); for (const r of rs.latest.values()) if (r.kind === "boundary" && r.repoKey === input.repoKey) sameQuote.add(qNormOf(r.quote));
  const out = [], dropped = parsed.dropped.slice();
  const counts = { boundary: 0, emphasis: 0, style: 0 };
  const ts = new Date().toISOString();
  for (const it of parsed.items) {
    const w = byWord.get(it.wordId);
    const dr = (reason) => dropped.push({ ref: it.ref, kind: it.kind, ...(it.seat ? { seat: it.seat } : {}), reason });
    if (!CLASSIFY_KINDS.includes(it.kind)) { dr("bad-kind"); continue; } // 판독기가 이미 막지만 직접 호출 방어
    if (it.kind === "boundary") {
      if (!RULEBOOK_SEATS.includes(it.seat) || !it.bounds) { dr("bad-seat"); continue; }
      const cid = userConstraintIdFor(ws, input.repoKey, it.quote);
      if (CL.userDeclinedCandidate(cst.rows, cid)) { dr("user-declined"); continue; } // 사용자 거절=세대 무관 기억(2-가)
      if (cst.latest.get(cid + "@" + input.gen)) { dr("duplicate"); continue; } // 이 세대에 이미 후보로 있음(대기·채택·정리)
      if (sameQuote.has(qNormOf(it.quote))) { dr("duplicate-result"); continue; } // 같은 인용의 판정 경계 결과가 이미 있음(구현 담당 판단은 그 결과로)
      sameQuote.add(qNormOf(it.quote));
    }
    const resultId = classifyResultIdFor(ws, input.repoKey, it.kind, it.quote, it.wordId);
    if (rs.latest.has(resultId)) { dr("duplicate-result"); continue; } // 같은 말·같은 인용·같은 성격=이미 기록(재실행 멱등)
    out.push({ schema: "classify-result-v1", wsKey: CL.wsKeyFor(ws), repoKey: input.repoKey, resultId, status: "new", kind: it.kind, quote: it.quote, why: it.why,
      ...(it.seat ? { seat: it.seat } : {}), ...(it.bounds ? { bounds: it.bounds } : {}), ...(it.itemRef ? { itemRef: it.itemRef, itemText: it.itemText } : {}), ...(it.target ? { target: it.target } : {}),
      gen: input.gen, ...(input.virtual ? { virtualGen: true } : {}), provider: input.provider, sessionId: w.sessionId, turnAnchor: w.turnAnchor, sourceHash: w.sourceHash,
      quoteSource: w.source, wordId: w.id, ...(runId ? { runId } : {}), ts });
    counts[it.kind]++;
  }
  // [⑥ 묶음 3(C) · §3-1 5·6] 다시 강조가 '구현 담당 미처리'·'구현 담당이 안 올림' 판정 경계 결과를 가리키면 새 전달 주기 — 새로 하신 말(다시 강조 인용)로
  //  새 판정 경계 결과를 만든다(칸·판정 영향 승계 · resumedFrom · 전달 횟수 0부터). 옛 결과는 그대로(판단 표식·이력 보존 — 한 결과=한 판단).
  //  대기·전달 중·올림 결과=횟수만(이미 흐름 안). 같은 인용의 후보·거절 기억·판정 경계 결과가 있으면 만들지 않음(일반 판정 경계와 같은 탈락 규칙).
  //  [검증 1회차 blocker] 판정은 장부 상태가 아니라 유효 상태(판단 표식 반영 — 표식에만 남은 안 올림도 다시 넘김 · 표식 내용을 못 읽으면 판단된 것으로 보고 넘기지 않음).
  //  표식·후보 장부를 못 읽으면 커밋 거절(말 보존 — 다음 실행이 다시 분류) — 다시 넘길 기회를 판독 오류로 잃지 않게.
  let raisedC9 = null, claimsC9 = null;
  if (out.some((e) => e.kind === "emphasis" && e.target && e.target.type === "result")) {
    raisedC9 = raisedResultIds(ws);
    if (raisedC9 === null) return { ok: false, reason: "candidates-unreadable" };
    const clC9 = readClaimsState(ws);
    if (clC9.readError) return { ok: false, reason: "claims-unreadable" };
    claimsC9 = new Map(); for (const cl of clC9.claims) claimsC9.set(cl.resultId, cl.claim ? cl.claim : { decision: "unknown" });
  }
  for (const e of out.slice()) {
    if (e.kind !== "emphasis" || !e.target || e.target.type !== "result") continue;
    const old = rs.latest.get(String(e.target.resultId || ""));
    if (!old || old.kind !== "boundary" || old.repoKey !== input.repoKey) continue;
    const stOld = effectiveResultStatus(old, raisedC9, claimsC9);
    if (stOld !== "unhandled" && stOld !== "skipped") continue;
    if (!RULEBOOK_SEATS.includes(old.seat) || !old.bounds) continue;
    const cid = userConstraintIdFor(ws, input.repoKey, e.quote);
    if (CL.userDeclinedCandidate(cst.rows, cid) || cst.latest.get(cid + "@" + input.gen) || sameQuote.has(qNormOf(e.quote))) continue;
    const rid = classifyResultIdFor(ws, input.repoKey, "boundary", e.quote, e.wordId);
    if (rs.latest.has(rid) || out.some((x) => x.resultId === rid)) continue;
    sameQuote.add(qNormOf(e.quote));
    out.push({ schema: "classify-result-v1", wsKey: e.wsKey, repoKey: input.repoKey, resultId: rid, status: "new", kind: "boundary", quote: e.quote, why: old.why, seat: old.seat, bounds: old.bounds,
      resumedFrom: old.resultId, emphasisOf: e.resultId, gen: input.gen, ...(input.virtual ? { virtualGen: true } : {}), provider: e.provider, sessionId: e.sessionId, turnAnchor: e.turnAnchor, sourceHash: e.sourceHash,
      quoteSource: e.quoteSource, wordId: e.wordId, ...(runId ? { runId } : {}), ts });
    counts.boundary++;
  }
  if (out.length && !appendClassifyResults(ws, out)) return { ok: false, reason: "results-write" };
  if (!UW.setWordStatus(ws, input.items.map((x) => x.id), "classified", runId ? { runId } : {})) return { ok: false, reason: "words-write" };
  return { ok: true, resultIds: out.map((r) => r.resultId), counts, dropped };
}

// 실패 처리 — 이번 묶음의 말은 queued 로 남기고 재시도 횟수만 올린다. 상한 도달=보류(classify-failed · 화면 '분류하지 못한 사용자 말').
function bumpRetries(ws, items, reason) {
  const back = [], held = [];
  for (const it of items) { const n = (Number(it.retries) || 0) + 1; if (n >= CLASSIFY_RETRY_MAX) held.push(it.id); else back.push({ id: it.id, n }); }
  for (const b of back) UW.setWordStatus(ws, [b.id], "queued", { retries: b.n, lastFail: String(reason || "") });
  if (held.length) UW.setWordStatus(ws, held, "held", { reason: "classify-failed", lastFail: String(reason || "") });
  return { retried: back.length, held: held.length };
}

function writeClassifyReceipt(ws, input, fields) {
  const rec = Object.assign({ ts: new Date().toISOString(), wsKey: CL.wsKeyFor(ws), repoKey: input ? input.repoKey : "", askId: "", purpose: "classify", turnAnchor: input ? String(input.inputFp || "") : "", archiveHash: "", envelopeHash: input ? String(input.gen || "") : "", itemCount: input && input.items ? input.items.length : 0, pages: 0, selectedIds: [], arm: "", durationMs: 0 }, fields || {});
  const name = CL.appendSelectorUsage(rec);
  return { ok: !!name, name };
}
function alarm(ws, ko, en) {
  try { CL.appendIntegrityEvent({ ts: new Date().toISOString(), session: "", workspace: ws, kind: "classify-failed", severity: "warning", detail: ko, detailKo: ko, detailEn: en }, { supersedeSameKindWs: true }); } catch { /* best-effort */ }
}

// ── 잠금(정리 담당과 같은 구조) ──
function pidAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } }
function acquireClassifyLock(ws) {
  const f = classifyLockFileFor(ws);
  const token = crypto.randomBytes(8).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token, host: os.hostname() });
  try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); } catch { /* wx 가 판정 */ }
  for (let k = 0; k < 2; k++) {
    try { fs.writeFileSync(f, payload, { flag: "wx" }); return { ok: true, token }; }
    catch (e) {
      if (!(e && e.code === "EEXIST")) return { ok: false, reason: "lock-io" };
      let cur = null; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { cur = null; }
      const age = cur && cur.ts ? Date.now() - Date.parse(cur.ts) : Infinity;
      const dead = !cur || !pidAlive(Number(cur.pid)) || !(age < CLASSIFY_LOCK_STALE_MS);
      if (!dead) return { ok: false, reason: "running", holder: cur };
      try { fs.renameSync(f, f + ".stale-" + Date.now()); } catch { return { ok: false, reason: "reclaim-failed" }; }
    }
  }
  return { ok: false, reason: "lock-contended" };
}
function releaseClassifyLock(ws, token) {
  const f = classifyLockFileFor(ws);
  try { const cur = JSON.parse(fs.readFileSync(f, "utf8")); if (cur && cur.token === token) fs.rmSync(f, { force: true }); } catch { /* 이미 없음·타인 소유 */ }
}

// ── 실행기 — 검증 무관·유계. opts: {pageRunner(시험 주입), lang, contract, timeoutMs, trigger}
async function runClassify(ws, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const trigger = o.trigger === "auto" || o.trigger === "button" ? o.trigger : "manual";
  const runId = sha1(CL.wsKeyFor(ws) + "|" + t0 + "|" + process.pid + "|" + Math.random()).slice(0, 12);
  const row = (r) => appendClassifyRow(ws, Object.assign({ type: "run", runId, trigger }, r));
  const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!c) { row({ outcome: "contract-unreadable", durationMs: Date.now() - t0 }); alarm(ws, "사용자 말 분류를 시작하지 못했습니다(설정 판독 실패) — 검증에는 영향이 없습니다.", "Classifying the user's words could not start (contract unreadable) — verification is unaffected."); return { st: "contract-unreadable" }; }
  let repo; try { repo = CL.resolveScoutRepo(ws, c).repo; } catch { repo = null; }
  if (!repo) { row({ outcome: "repo-unresolved", durationMs: Date.now() - t0 }); return { st: "repo-unresolved" }; }
  const borrowed = typeof o.lockToken === "string" && lockHeldBy(ws, o.lockToken); // 자동 계기 자식이 잡은 잠금을 이어 씀(판정·소비·실행이 한 잠금 안)
  const lk = borrowed ? { ok: true, token: o.lockToken } : acquireClassifyLock(ws);
  if (!lk.ok) { row({ repoKey: CL.repoKeyOf(repo), outcome: "locked", reason: lk.reason, durationMs: Date.now() - t0 }); return { st: "locked", reason: lk.reason }; }
  try {
    const input = classifyInput(ws, repo, { contract: c });
    if (!input.ok) {
      row({ repoKey: CL.repoKeyOf(repo), outcome: "input-failed", reason: input.reason, durationMs: Date.now() - t0 });
      if (input.reason !== "envelope-inactive") alarm(ws, "사용자 말 분류 입력을 만들 수 없었습니다(" + input.reason + ") — 모아 둔 말은 그대로 남아 있고 검증에는 영향이 없습니다.", "Could not build the classification input (" + input.reason + ") — the collected words are kept; verification is unaffected.");
      return { st: "input-failed", reason: input.reason };
    }
    if (input.unavailable.length) UW.setWordStatus(ws, input.unavailable, "held", { reason: "text-unavailable" }); // 원문을 읽을 수 없는 말=보류(표면)
    if (input.pastedOnly && input.pastedOnly.length) UW.setWordStatus(ws, input.pastedOnly, "classified", { skipped: "pasted-only" }); // [묶음 5(G)] 붙여 넣은 글뿐인 말=분류 대상 아님(처리됨)
    if (!input.items.length) { row({ repoKey: input.repoKey, outcome: "empty", unavailable: input.unavailable.length, pastedOnly: (input.pastedOnly || []).length, durationMs: Date.now() - t0 }); return { st: "empty", unavailable: input.unavailable.length, pastedOnly: (input.pastedOnly || []).length }; }
    const lang = o.lang || CL.loadLang();
    const runner = typeof o.pageRunner === "function" ? o.pageRunner : require("./selector-runner.js").runSelectorPage;
    const h = runner({ arm: input.arm, prompt: buildClassifyPrompt(input, lang), timeoutMs: Number(o.timeoutMs) || CL.SELECTOR_PAGE_TIMEOUT_MS, schema: classifySchema(input) });
    const r = await h.promise;
    // [설계 A-1 · A5] 도우미 실행 방식(새/옛)·Claude Code 판을 실행 기록에 남기고, 옛 방식·너무 오래됨이면 대시보드 경보(새 방식이면 지움)
    // [묶음 A-3] 실행 방식 기록에 거절 칸(거절이 있었을 때만 — 다른 모델 재시도 결과 포함)
    const CHx = require("./claude-helper.js");
    const runnerMeta = CHx.runnerMetaOf(r);
    if (input.arm === "self" && r) { try { CHx.reportHelperTier(ws, r); } catch { /* 경보 실패=실행 결과 무영향 */ } }
    const common = Object.assign({ repoKey: input.repoKey, gen: input.gen, arm: input.arm, words: input.items.length, inputFp: input.inputFp }, runnerMeta ? { runner: runnerMeta } : {});
    if (!r || !r.ok) {
      const key = (r && r.key) || "call-failed";
      const b = bumpRetries(ws, input.items, key);
      row(Object.assign({ outcome: "failed", reason: key, retried: b.retried, held: b.held, durationMs: Date.now() - t0 }, common));
      writeClassifyReceipt(ws, input, { arm: input.arm, ...(runnerMeta ? { runner: runnerMeta } : {}), pages: 1, outcome: "failed:" + key, durationMs: Date.now() - t0 });
      if (key === "refused") { const nt = CHx.refusalNote(r); alarm(ws, "사용자 말 분류 중 도우미 모델이 안전상 이유로 답을 거절했고, " + nt.ko + " — 모아 둔 말은 남아 있고 다음 실행에서 다시 시도합니다(검증 무영향).", "While classifying the user's words the helper model declined to answer for safety reasons, and " + nt.en + " — the words are kept and retried next time (verification unaffected)."); }
      else alarm(ws, "사용자 말 분류 실행이 실패했습니다(" + key + ") — 모아 둔 말은 남아 있고 다음 실행에서 다시 시도합니다(검증 무영향).", "Classifying the user's words failed (" + key + ") — the words are kept and retried next time (verification unaffected).");
      return { st: "call-failed", reason: key, arm: input.arm, retried: b.retried, held: b.held };
    }
    const parsed = parseClassifyOutput(r.output, input);
    if (!parsed.ok) {
      const b = bumpRetries(ws, input.items, "parse:" + parsed.reason);
      row(Object.assign({ outcome: "failed", reason: "parse:" + parsed.reason, retried: b.retried, held: b.held, durationMs: Date.now() - t0 }, common));
      writeClassifyReceipt(ws, input, { arm: input.arm, ...(runnerMeta ? { runner: runnerMeta } : {}), pages: 1, outcome: "parse-failed:" + parsed.reason, durationMs: Date.now() - t0 });
      alarm(ws, "사용자 말 분류 답을 읽을 수 없어 전량 거부했습니다(" + parsed.reason + ") — 다음 실행에서 다시 분류합니다.", "The classification answer was unreadable and rejected as a whole (" + parsed.reason + ") — reclassified next time.");
      return { st: "parse-failed", reason: parsed.reason, arm: input.arm };
    }
    const cm = commitClassify(ws, input, parsed, { runId });
    if (!cm.ok) {
      const b = bumpRetries(ws, input.items, "commit:" + cm.reason);
      row(Object.assign({ outcome: "failed", reason: "commit:" + cm.reason, retried: b.retried, held: b.held, durationMs: Date.now() - t0 }, common));
      writeClassifyReceipt(ws, input, { arm: input.arm, ...(runnerMeta ? { runner: runnerMeta } : {}), pages: 1, outcome: "commit-failed:" + cm.reason, durationMs: Date.now() - t0 });
      alarm(ws, "사용자 말 분류 기록이 중단됐습니다(" + cm.reason + ") — 다음 실행이 다시 시도합니다.", "Classification commit aborted (" + cm.reason + ") — the next run retries.");
      return { st: "commit-failed", reason: cm.reason, arm: input.arm };
    }
    const nRes = cm.resultIds.length;
    row(Object.assign({ outcome: nRes ? "results" : "none", resultIds: cm.resultIds, counts: cm.counts, dropped: cm.dropped, durationMs: Date.now() - t0 }, common));
    const rc = writeClassifyReceipt(ws, input, { arm: input.arm, ...(runnerMeta ? { runner: runnerMeta } : {}), pages: 1, selectedIds: cm.resultIds.slice(), outcome: nRes ? "results:" + nRes : "none", durationMs: Date.now() - t0 });
    return { st: "ok", arm: input.arm, words: input.items.length, unavailable: input.unavailable.length, resultIds: cm.resultIds, counts: cm.counts, dropped: cm.dropped, receipt: rc.ok, runId };
  } finally { if (!borrowed) releaseClassifyLock(ws, lk.token); }
}

function currentRepoKey(ws) { try { return CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo); } catch { return ""; } }
// ── 요약(CLI·화면) — 현재 저장소 기준: 대기열 수·보류 수(이 저장소+출처 불명)·마지막 실행
function classifySummary(ws) {
  let repoKey = "";
  try { repoKey = CL.repoKeyOf(CL.resolveScoutRepo(ws, CL.loadContract(ws)).repo); } catch { repoKey = ""; }
  const q = repoKey ? UW.queuedWords(ws, repoKey) : null;
  const held = repoKey ? UW.heldWords(ws, repoKey, { unknown: true }) : null;
  const runs = readClassifyRows(ws).filter((r) => r.type === "run" && (!repoKey || !r.repoKey || r.repoKey === repoKey));
  const last = runs.length ? runs[runs.length - 1] : null;
  // [묶음 2(⑤)] 분류 결과 수(이 저장소) — 판독 오류=null(0 으로 위장 금지)
  let results = null;
  let boundaryStatus = null;
  if (repoKey) { const rs = readClassifyResults(ws); const raisedS = raisedResultIds(ws); if (!rs.readError && raisedS !== null) { results = { boundary: 0, emphasis: 0, style: 0 }; boundaryStatus = { waiting: 0, raised: 0, skipped: 0, unhandled: 0, expired: 0 };
    const claimsS = claimDecisions(ws);
    for (const r of rs.latest.values()) { if (r.repoKey !== repoKey) continue; results[r.kind]++; if (r.kind !== "boundary") continue; const cS = claimsS.get(r.resultId); const st = raisedS.has(r.resultId) ? "raised" : (cS && cS.decision === "skipped" ? "skipped" : r.status); if (st === "new" || st === "delivered") boundaryStatus.waiting++; else if (boundaryStatus[st] !== undefined) boundaryStatus[st]++; } } }
  return { repoKey, queued: q ? q.length : null, held: held ? held.length : null, heldReasons: held ? held.reduce((a, w) => { const k = w.heldReason || "?"; a[k] = (a[k] || 0) + 1; return a; }, {}) : {},
    lastTs: last ? String(last.ts || "") : "", lastOutcome: last ? String(last.outcome || "") : "", lastReason: last ? String(last.reason || "") : "", runs: runs.length, results, boundaryStatus };
}

// ── [묶음 2-나-2 2단계] 자동 계기(설계 §3-3 R4·§7 D2) — 캠페인 마감(검증 통과 마감 또는 상한 소진 마감) 때 대기열에 말이 있으면 실행.
// 두 층(정리 담당과 같은 구조 — ab-6): ⓐ 훅(classifyHookTick)=계약·잠금·tick 상태 파일만 보고 최소 간격(10분)이 지났으면 `classify tick` 을 detach
// ⓑ 자식(classifyTick)=분류 실행 잠금을 먼저 잡고(죽은 소유자는 회수) 그 안에서 판정·마감 소비·실행을 차례로 한다 — 두 자식이 같은 상태를 읽고
//   같은 마감으로 두 번 실행하는 교차를 막는다(구현 검증 1회차 blocker: 판정과 실행권 확보 분리).
// 마감 사건(검증 1회차 blocker: 회차 번호는 수칙서 세대마다 다시 1부터라 상한과 비교할 수 없음):
//   · 통과 마감=판정 행(type round · 기록 시점 저장소 표식 일치) 결과 pass·pass-notes — 열쇠 pass:캠페인:세대:회차:시각
//   · 상한 소진 마감=캠페인 카운터·이력 기록(저장소 표식 일치)의 누적 횟수(count)가 왕복 상한(budget ≥1)에 닿음 — 열쇠 cap:캠페인
// 새 마감 판별은 시각 크기가 아니라 '본 적 있는 열쇠'로(검증 1회차 blocker: 시계가 조금 뒤로 가면 새 마감을 영구 누락). 본 열쇠=지금 보이는 사건 열쇠 전부(꼬리 판독이라 유계).
// 하루 상한 없음(D2 확정 — 자동 실행 수 ≤ 마감 수). 첫 판정=기준선(설치 이전 마감은 세지 않음 — 다른 어떤 조건보다 먼저). 같은 마감은 한 번만.
const CLASSIFY_TICK_MIN_GAP_MS = 10 * 60 * 1000;
const TICK_TAIL_BYTES = 256 * 1024;
const SEEN_KEYS_MAX = 2000; // 본 마감 열쇠 기억 상한(마감 1건=1개 — 하루 수~수십 건 기준 수개월분)
function classifyTickFileFor(ws, repoKey) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + "." + String(repoKey || "norepo") + ".tick.json"); }
// 본 마감 기억 판독 — 부재=null(처음) / 판독 오류={unreadable:true}(검증 3회차: 판독 실패를 처음 상태로 보면 기준선을 다시 잡아 새 마감을 실행 없이 소비 —
// 호출자는 이때 아무것도 쓰지 않는다) / 형식 깨짐·다른 저장소 기록: 기본은 판독 전용({unreadable:true, corrupt:true} — 아무것도 바꾸지 않음),
// opts.quarantine=true(분류 실행 잠금을 쥔 판정만)일 때만 격리(.corrupt-시각) 후 null(처음 — 그동안의 마감을 건너뛸 수는 있어도 두 번 실행하지는 않는 방향).
// (검증 4회차: 격리가 판독 함수에 있으면 잠금 없는 훅이 읽기만 해도 파일을 옮겨, 자식이 잠금 안에서 막 복구한 정상 기억까지 치울 수 있었다)
function readClassifyTick(ws, repoKey, opts) {
  const f = classifyTickFileFor(ws, repoKey);
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return e && e.code === "ENOENT" ? null : { unreadable: true, repoKey: String(repoKey || ""), seeded: false, seenKeys: [], judgedAt: "", ranAt: "", reason: "" }; }
  let o = null; try { o = JSON.parse(raw); } catch { o = null; }
  if (o && typeof o === "object" && String(o.repoKey || "") === String(repoKey || "")) {
    const seen = Array.isArray(o.seenKeys) ? o.seenKeys.map(String) : null;
    return { repoKey: String(repoKey || ""), seeded: o.seeded === true && seen !== null, seenKeys: seen || [], judgedAt: String(o.judgedAt || ""), ranAt: String(o.ranAt || ""), reason: String(o.reason || "") };
  }
  if (!(opts && opts.quarantine === true)) return { unreadable: true, corrupt: true, repoKey: String(repoKey || ""), seeded: false, seenKeys: [], judgedAt: "", ranAt: "", reason: "" }; // 판독 전용 — 격리는 잠금 안 판정만
  try { fs.renameSync(f, f + ".corrupt-" + Date.now()); } catch { return { unreadable: true, repoKey: String(repoKey || ""), seeded: false, seenKeys: [], judgedAt: "", ranAt: "", reason: "" }; } // 격리 실패=판독 오류와 같게(덮어쓰지 않음)
  return null;
}
function writeClassifyTick(ws, repoKey, st) { try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); return CL.atomicWrite(classifyTickFileFor(ws, repoKey), JSON.stringify(Object.assign({}, st, { repoKey: String(repoKey || "") }))); } catch { return false; } }
// 꼬리 판독 — 부재(ENOENT)·빈 파일=[] / 판독 오류=null(검증 2회차: 오류를 빈 목록으로 줄이면 본 마감 기억이 지워져 같은 마감을 다시 실행)
function readTailJson(file, maxBytes) {
  let fd = null;
  try {
    try { fd = fs.openSync(file, "r"); } catch (e) { return e && e.code === "ENOENT" ? [] : null; }
    const st = fs.fstatSync(fd); // 연 파일 기준(검증 3회차: 경로로 크기를 잰 뒤 열기 전에 원자 교체로 줄면 이전 크기로 EOF 너머를 읽어 빈 목록이 됨)
    if (!st.isFile()) return null;
    if (!st.size) return [];
    const len = Math.min(st.size, maxBytes); const buf = Buffer.alloc(len);
    let got = 0; while (got < len) { const n = fs.readSync(fd, buf, got, len - got, st.size - len + got); if (!n) break; got += n; }
    if (got !== len) return null; // 짧은 읽기=판독 오류(빈 목록으로 확정 금지)
    let s = buf.toString("utf8"); if (len < st.size) { const nl = s.indexOf("\n"); s = nl >= 0 ? s.slice(nl + 1) : ""; }
    return s.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 무해 */ } } }
}
// 이 저장소의 마감 사건 — [{key, ts, campaignId, kind:"pass"|"cap"}] (열쇠 중복 없음) · 어느 출처든 판독 오류면 null(빈 목록으로 줄이지 않음).
// 저장소 표식 없는 옛 행·기록=불산입(ab-1).
function closeEventsFor(ws, repoKey) {
  const out = [], keys = new Set();
  const add = (e) => { if (!keys.has(e.key)) { keys.add(e.key); out.push(e); } };
  const led = readTailJson(CL.findingsLedgerFileFor(ws), TICK_TAIL_BYTES);
  if (led === null) return null;
  for (const r of led) {
    if (!(r && r.type === "round" && r.repoKey === repoKey && typeof r.ts === "string")) continue;
    if (r.verdict === "pass" || r.verdict === "pass-notes") add({ key: "pass:" + String(r.campaignId || "") + ":" + String(r.envelopeHash || "") + ":" + String(r.round) + ":" + r.ts, ts: r.ts, campaignId: String(r.campaignId || ""), kind: "pass" });
  }
  const recs = readTailJson(CL.campaignHistoryFileFor(ws), 64 * 1024);
  if (recs === null) return null;
  { let raw = null; try { raw = fs.readFileSync(CL.campaignFileFor(ws), "utf8"); } catch (e) { if (!(e && e.code === "ENOENT")) return null; }
    if (raw !== null) { let o = null; try { o = JSON.parse(raw); } catch { return null; } recs.push(o); } } // 현재 캠페인 기록 판독·형식 오류=알 수 없음(빈 것으로 줄이지 않음)
  for (const o of recs) {
    if (!(o && typeof o.campaignId === "string" && o.campaignId && o.repoKey === repoKey)) continue;
    if (Number.isInteger(o.budget) && o.budget >= 1 && Number.isInteger(o.count) && o.count >= o.budget) add({ key: "cap:" + o.campaignId, ts: String(o.updatedAt || ""), campaignId: o.campaignId, kind: "cap" });
  }
  return out;
}
function classifyLockAlive(ws) {
  let cur = null; try { cur = JSON.parse(fs.readFileSync(classifyLockFileFor(ws), "utf8")); } catch { return false; }
  const age = cur && cur.ts ? Date.now() - Date.parse(cur.ts) : Infinity;
  return !!(cur && pidAlive(Number(cur.pid)) && age < CLASSIFY_LOCK_STALE_MS);
}
function lockHeldBy(ws, token) { try { const cur = JSON.parse(fs.readFileSync(classifyLockFileFor(ws), "utf8")); return !!(cur && token && cur.token === token); } catch { return false; } }
// 판정 — 반환 {spawn, reason, kind?}. opts.lockToken=호출자가 잡은 분류 실행 잠금(있어야 '실행 중' 판정을 건너뛰고 소비를 확정한다).
// 마감 소비 기록이 실패하면 실행하지 않는다(state-write — 같은 마감 재실행 방지가 기록에 기대므로).
function classifyTickJudge(ws, c, opts) {
  const o = opts || {};
  const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
  if (!cc) return { spawn: false, reason: "contract-unreadable" };
  let repo; try { repo = CL.resolveScoutRepo(ws, cc).repo; } catch { return { spawn: false, reason: "repo-unresolved" }; }
  const repoKey = CL.repoKeyOf(repo);
  let g = null; try { g = CL.envelopeGenFor(ws, repo, cc); } catch { g = null; }
  if (!g || !g.gen) return { spawn: false, reason: "envelope-inactive" }; // 승인 전·손상=말 소모 없이 대기(수동 실행과 같은 태도)
  const held = typeof o.lockToken === "string" && lockHeldBy(ws, o.lockToken);
  if (!held) return { spawn: false, reason: classifyLockAlive(ws) ? "running" : "lock-required" }; // 판정(=본 마감 기록 갱신)은 분류 실행 잠금을 쥔 경우에만 — 모든 소비 분기 보호(검증 2회차)
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const st0 = readClassifyTick(ws, repoKey, { quarantine: true }); // 잠금 보유 판정만 격리 가능(위 held 확인 뒤)
  if (st0 && st0.unreadable) return { spawn: false, reason: "state-unreadable" }; // 기억 판독 실패=아무것도 쓰지 않음(검증 3회차 — 처음 상태로 보지 않는다)
  const persist = (extra) => writeClassifyTick(ws, repoKey, Object.assign({ seeded: true, seenKeys: st0 ? st0.seenKeys : [], ranAt: st0 ? st0.ranAt : "" }, extra || {}, { judgedAt: new Date(now).toISOString() }));
  const ev = closeEventsFor(ws, repoKey);
  if (ev === null) { persist({ seeded: !!(st0 && st0.seeded), reason: "events-unreadable" }); return { spawn: false, reason: "events-unreadable" }; } // 판독 오류=본 마감 기억 보존·판정 보류(첫 판정이면 기준선도 미뤄 둠 — 다음 판정 재시도)
  // 본 마감 기억=이전 기억∪지금 보이는 열쇠(지우지 않고 더함 · 오래된 것부터 상한 밖으로) — 일부만 읽히는 판독이 기억을 줄이지 않게
  // 순서=지금 안 보이는 옛 기억 → 지금 보이는 열쇠(상한으로 잘릴 때 보이는 열쇠가 먼저 버려져 '새 마감'으로 되살아나지 않게 — 보이는 열쇠 수는 꼬리 판독이라 상한보다 훨씬 작음)
  const evKeys = ev.map((e) => e.key), evSet = new Set(evKeys);
  const visible = [...new Set([...(st0 ? st0.seenKeys : []).filter((k) => !evSet.has(k)), ...evKeys])].slice(-SEEN_KEYS_MAX);
  if (!st0 || !st0.seeded) { persist({ seenKeys: visible, reason: "baseline" }); return { spawn: false, reason: "baseline" }; } // 기준선이 다른 어떤 조건보다 먼저(검증 1회차 blocker)
  const seen = new Set(st0.seenKeys);
  const fresh = ev.filter((e) => !seen.has(e.key));
  // 최근 실행(최소 간격 10분) — 실행 기록 판독 오류는 '이력 없음'이 아니라 알 수 없음(간격 약속을 깨는 실행 금지 · 마감은 소비하지 않고 남김)
  let runsRaw = null, runsExist = false; try { runsRaw = fs.readFileSync(classifyFileFor(ws), "utf8"); runsExist = true; } catch (e) { if (!(e && e.code === "ENOENT")) { persist({ reason: "runs-unreadable" }); return { spawn: false, reason: "runs-unreadable" }; } runsRaw = ""; }
  const wk9 = CL.wsKeyFor(ws);
  const runs = String(runsRaw).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.schema === "classify-v1" && r.wsKey === wk9 && r.type === "run" && r.repoKey === repoKey);
  // 최근 실행 시각=읽힌 마지막 실행 행 시각과 실행 기록 파일의 마지막 변경 시각 중 늦은 쪽 — 실행 기록은 분류 실행만 쓰므로 파일 변경=실행 활동이며,
  // 마지막 행이 쓰다 끊겨 버려져도 간격 약속(10분)이 지켜진다(검증 5회차: 끊긴 최신 행을 버려 간격 안에서 다시 실행)
  // 빈 파일도 '있음'으로 변경 시각 반영(만든 직후 첫 글자 전에 끊긴 경우 — 검증 새 캠페인 1회차)
  let mtime9 = NaN; if (runsExist) { try { mtime9 = fs.statSync(classifyFileFor(ws)).mtimeMs; } catch (e) { if (!(e && e.code === "ENOENT")) { persist({ reason: "runs-unreadable" }); return { spawn: false, reason: "runs-unreadable" }; } } }
  const lastParsed = runs.length ? Date.parse(String(runs[runs.length - 1].ts || "")) : NaN;
  const lastRun = Math.max(Number.isFinite(lastParsed) ? lastParsed : -Infinity, Number.isFinite(mtime9) ? mtime9 : -Infinity);
  if (Number.isFinite(lastRun) && now - lastRun < CLASSIFY_TICK_MIN_GAP_MS) { persist({ reason: "recent" }); return { spawn: false, reason: "recent" }; } // 새 마감은 소비하지 않고 남김
  if (!fresh.length) { persist({ seenKeys: visible, reason: "no-close" }); return { spawn: false, reason: "no-close" }; }
  const q = UW.queuedWords(ws, repoKey);
  if (q === null) { persist({ reason: "queue-unreadable" }); return { spawn: false, reason: "queue-unreadable" }; } // 판독 오류=마감 사건을 소모하지 않음(다음 판정 재시도)
  if (!q.length) { persist({ seenKeys: visible, reason: "queue-empty" }); return { spawn: false, reason: "queue-empty" }; }
  const kind = fresh[fresh.length - 1].kind;
  if (!persist({ seenKeys: visible, reason: "close:" + kind })) return { spawn: false, reason: "state-write" }; // 소비 기록 실패=실행 안 함(같은 마감 재실행 방지가 이 기록에 기댐)
  return { spawn: true, reason: "close:" + kind, kind };
}
function markClassifyRan(ws, repoKey) { const st = readClassifyTick(ws, repoKey); if (st && st.unreadable) return false; return writeClassifyTick(ws, repoKey, Object.assign({ seeded: false, seenKeys: [], judgedAt: "" }, st || {}, { ranAt: new Date().toISOString() })); } // 판독 실패=기억을 덮어쓰지 않음
// 자식 진입점 — 분류 실행 잠금(죽은 소유자 회수) → 판정(잠금 보유) → 실행(같은 잠금 이어 사용) → 해제. 반환 {st, judge, ...runClassify 결과}
async function classifyTick(ws, opts) {
  const o = opts || {};
  const lk = acquireClassifyLock(ws);
  if (!lk.ok) return { st: "no-run", judge: { spawn: false, reason: lk.reason === "running" ? "running" : "lock-" + lk.reason } };
  try {
    const c = o.contract || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
    const j = classifyTickJudge(ws, c, { now: o.now, lockToken: lk.token });
    if (!j.spawn) return { st: "no-run", judge: j };
    const r = await runClassify(ws, Object.assign({}, o, { trigger: "auto", contract: c, lockToken: lk.token }));
    try { markClassifyRan(ws, CL.repoKeyOf(CL.resolveScoutRepo(ws, c).repo)); } catch { /* 기록 실패=다음 훅 간격만 짧아짐 */ }
    return Object.assign({ judge: j }, r);
  } finally { releaseClassifyLock(ws, lk.token); }
}
function hookStampFileFor(ws, repoKey) { return path.join(CLASSIFY_DIR, CL.wsKeyFor(ws) + "." + String(repoKey || "norepo") + ".hook.json"); }
function readHookStamp(ws, repoKey) { try { const o = JSON.parse(fs.readFileSync(hookStampFileFor(ws, repoKey), "utf8")); return { spawnedAt: String((o && o.spawnedAt) || "") }; } catch { return { spawnedAt: "" }; } }
function writeHookStamp(ws, repoKey, iso) { try { fs.mkdirSync(CLASSIFY_DIR, { recursive: true }); return CL.atomicWrite(hookStampFileFor(ws, repoKey), JSON.stringify({ spawnedAt: iso, repoKey: String(repoKey || "") })); } catch { return false; } }
// 훅 층 — 전수 판독 0(계약 전달·잠금 파일·tick 상태 파일·수칙서 지문 1회). 최소 간격이 지났으면 `classify tick` 을 detach. 반환=null(무고지).
function classifyHookTick(ws, c, opts) {
  const o = opts || {};
  try {
    const cc = c || (() => { try { return CL.loadContract(ws); } catch { return null; } })();
    if (!cc) return null;
    let repoKey; try { repoKey = CL.repoKeyOf(CL.resolveScoutRepo(ws, cc).repo); } catch { return null; }
    const st = readClassifyTick(ws, repoKey);
    const hs = readHookStamp(ws, repoKey);
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const lastAct = Math.max(st ? (Date.parse(st.judgedAt || "") || 0) : 0, st ? (Date.parse(st.ranAt || "") || 0) : 0, Date.parse(hs.spawnedAt || "") || 0);
    if (lastAct && now - lastAct < CLASSIFY_TICK_MIN_GAP_MS) return null; // 간격 먼저(가장 싼 판정 — 대부분의 턴은 여기서 끝)
    if (classifyLockAlive(ws)) return null;
    let g = null; try { g = CL.envelopeGenFor(ws, null, cc); } catch { g = null; }
    if (!g || !g.gen) return null;
    // detach 전에 '띄운 시각'을 훅 전용 파일에 찍어 같은 간격 안의 다음 훅이 또 띄우지 않게 — 자식이 쓰는 판정 상태 파일(본 마감 목록)은 건드리지 않는다
    // (검증 1회차: 훅이 판정 상태를 다시 쓰면 자식이 방금 기록한 마감 소비를 옛 값으로 덮어 같은 마감을 다시 실행할 틈이 생김)
    if (!writeHookStamp(ws, repoKey, new Date(now).toISOString())) return null;
    const args = [path.join(__dirname, "codex-bridge.js"), "classify", "tick"];
    const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: String(ws) });
    const sp = typeof o.spawnFn === "function" ? o.spawnFn : require("child_process").spawn;
    const child = sp(process.execPath, args, { cwd: String(ws), detached: true, stdio: "ignore", windowsHide: true, env });
    if (child && typeof child.unref === "function") child.unref();
  } catch { return null; }
  return null;
}

// [RULE-SUPPLY-CORRECTION 묶음 2(I) · D-e] 구현 담당 주입문에 넣던 '[사용자 확인 대기] n건' 한 줄(pendingNoticeFor·pendingUserWordIds·noticeFileFor)은 없앴다 —
// 수칙서 후보의 대기 표시는 대시보드 수칙 카드·개요 '지금 정할 것'에만 있다(대화에 후보 이야기를 끌어들이지 않음).

// ── 분류하지 못한 말 — 사용자 처리(화면): 다시 분류(대기열로 · 재시도 0) / 버리기(분류 대상에서 제외). 이 저장소 말만 다시 분류 가능(출처 불명 말은 버리기만).
function heldWordAction(ws, id, action) {
  const st = UW.readUserWordsState(ws);
  if (st.readError) return { ok: false, reason: "words-unreadable" };
  const w = st.words.get(String(id || ""));
  if (!w) return { ok: false, reason: "not-found" };
  const s = st.status.get(w.id);
  if (!s || s.status !== "held") return { ok: false, reason: "not-held" };
  const rk = currentRepoKey(ws);
  const mine = !!w.repoKey && w.repoKey === rk;
  if (action === "requeue") {
    if (!mine) return { ok: false, reason: w.repoKey ? "repo-mismatch" : "origin-unknown" };
    if (!UW.setWordStatus(ws, [w.id], "queued", { retries: 0, by: "user" })) return { ok: false, reason: "words-write" };
  } else if (action === "dismiss") {
    if (w.repoKey && !mine) return { ok: false, reason: "repo-mismatch" };
    if (!UW.setWordStatus(ws, [w.id], "classified", { dismissed: true, by: "user" })) return { ok: false, reason: "words-write" };
  } else return { ok: false, reason: "bad-action" };
  const after = UW.readUserWordsState(ws).status.get(w.id);
  const want = action === "requeue" ? "queued" : "classified";
  if (!after || after.status !== want) return { ok: false, reason: "words-unsettled" };
  return { ok: true };
}

// ── 화면 자료 — 자리 후보(전달처 표시 재료 포함)·분류하지 못한 말(원문 일부)·요약. 판독 불가=null 칸(화면이 '판독 불가'로 표기).
const HELD_TEXT_SHOW = 400;
// [⑥ 묶음 3(C)] 다시 강조 집계(화면) — 같은 저장소의 다시 강조 결과를 대상별로: 수칙서 항목=문안 지문(byFp — 대시보드 수칙 줄의 itemFp 와 같은 식) ·
//  제안=후보 id · 앞선 결과=결과 id. 두 회사 결과 모두(사용자의 반복 횟수 — 원문은 싣지 않음). 판독 오류=null.
function emphasisTally(ws, repoKey) {
  const rs = readClassifyResults(ws); if (rs.readError) return null;
  const out = { byFp: {}, byCandidate: {}, byResult: {} };
  const seen = new Set();
  for (const r of rs.rows) {
    if (!r || r.kind !== "emphasis" || r.repoKey !== repoKey || seen.has(r.resultId)) continue;
    seen.add(r.resultId);
    const t = r.target || {}, ts = String(r.ts || "");
    const bump = (m, k) => { const e = m[k] || (m[k] = { n: 0, last: "" }); e.n++; if (ts > e.last) e.last = ts; };
    if ((t.type === "core" || t.type === "archive") && t.fp) bump(out.byFp, t.fp);
    else if ((t.type === "candidate" || t.type === "declined-candidate") && t.candidateId) bump(out.byCandidate, t.candidateId);
    else if (t.type === "result" && t.resultId) bump(out.byResult, t.resultId);
  }
  return out;
}
function userWordsView(ws) {
  const sm = classifySummary(ws);
  const rk = sm.repoKey;
  const held = rk ? UW.heldWords(ws, rk, { unknown: true }) : null;
  // [묶음 2(⑤)] 분류 결과 — 판정 경계(구현 담당 판단 재료) · 일하는 방식(D-a 알림만 — 쓰기·승인 버튼 없음). 최근순·종류별 상한. 판독 오류=null.
  let results = null;
  if (rk) {
    const rs = readClassifyResults(ws);
    if (!rs.readError) {
      const raisedV = raisedResultIds(ws) || new Set(); // 판독 실패=후보 장부 표시만 빠짐(결과 장부 상태는 그대로)
      const claimsV = claimDecisions(ws); // 표식만 있고 기록이 빠진 판단도 화면에 그 판단으로
      const firstTs = new Map(); for (const r of rs.rows) if (!firstTs.has(r.resultId)) firstTs.set(r.resultId, String(r.ts || ""));
      const mine = [...rs.latest.values()].filter((r) => r.repoKey === rk).sort((a, b) => String(firstTs.get(b.resultId) || "").localeCompare(String(firstTs.get(a.resultId) || "")));
      const st9 = (r) => { if (r.status !== "raised" && raisedV.has(r.resultId)) return "raised"; const cv = claimsV.get(r.resultId); if (cv && cv.decision === "skipped" && r.status !== "skipped") return "skipped"; return r.status; };
      const note9 = (r) => (r.status === "skipped" && r.note) ? String(r.note) : (() => { const cv = claimsV.get(r.resultId); return cv && cv.decision === "skipped" && cv.resultRow && cv.resultRow.note ? String(cv.resultRow.note) : ""; })();
      const pick = (k) => mine.filter((r) => r.kind === k).slice(0, RESULTS_VIEW_MAX).map((r) => ({ id: r.resultId, status: st9(r), quote: r.quote, why: r.why, ts: String(firstTs.get(r.resultId) || r.ts || ""), ...(r.seat ? { seat: r.seat } : {}), ...(r.bounds ? { bounds: r.bounds } : {}), ...(r.itemRef ? { itemText: String(r.itemText || "") } : {}), ...(r.target && r.target.type ? { targetType: String(r.target.type) } : {}), ...(r.resumedFrom ? { resumed: true } : {}), ...(note9(r) ? { note: note9(r) } : {}) }));
      results = { boundary: pick("boundary"), emphasis: pick("emphasis"), style: pick("style") };
    }
  }
  return {
    wsKey: CL.wsKeyFor(ws), repoKey: rk, summary: sm, results,
    held: held === null ? null : held.map((w) => { const t = UW.wordText(ws, w); return { id: w.id, source: w.source, reason: String(w.heldReason || ""), ts: String(w.ts || ""), text: t === null ? "" : (t.length > HELD_TEXT_SHOW ? t.slice(0, HELD_TEXT_SHOW) + "…" : t), canRequeue: !!w.repoKey && w.repoKey === rk }; }),
  };
}

module.exports = { stopGateWarnText,
  CLASSIFY_TICK_MIN_GAP_MS, classifyTickFileFor, readClassifyTick, writeClassifyTick, closeEventsFor, classifyTickJudge, markClassifyRan, classifyTick, classifyHookTick, classifyLockAlive, readHookStamp, hookStampFileFor,
  heldWordAction, userWordsView,
  CLASSIFY_DIR, CLASSIFY_BATCH_WORDS, CLASSIFY_BATCH_CHARS, CLASSIFY_WORD_SHOW, CLASSIFY_MAX_PER_RUN, CLASSIFY_RETRY_MAX, RULEBOOK_SEATS, SEATS, REDACTED,
  CLASSIFY_KINDS, CLASSIFY_BOUNDS_MIN, CLASSIFY_BOUNDS_MAX, RESULT_STATUSES,
  classifyFileFor, seatsFileFor, resultsFileFor, classifyLockFileFor, armForProvider, rulesFieldFor, redactSensitiveForms,
  readClassifyRows, readSeatsState, readClassifyResults, appendClassifyResults, classifyResultIdFor, userConstraintIdFor,
  raisedResultIds, deliveredUndecided, markResultRaised, skipResult, markResultsDelivered, planDelivery, deliveryBlock, DELIVERY_MAX, DELIVER_PER_TURN, EMPHASIS_PER_TURN, emphasisKeyOf, emphasisOrdinals, emphasisBlock, emphasisTally, classifyStopGate, stopGateText, STOP_GATE_MAX, stopGateFileFor, SKIP_NOTE_MIN, resultStatusRow,
  CLAIMS_DIR, claimFileFor, hasClaim, claimResult, readClaims, readClaimsState, claimDecisions, effectiveResultStatus, repairClaims, unfilledRaisedClaims,
  classifyInput, buildClassifyPrompt, classifySchema, parseClassifyOutput, commitClassify, bumpRetries, acquireClassifyLock, releaseClassifyLock,
  runClassify, classifySummary,
};
