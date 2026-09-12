"use strict";
// [HARNESS-STRUCTURE-2026-09-11 §B1] 인용 대조 — 검증자가 적은 "파일·줄·상세"를 실제 파일과 대조한다.
// 읽기 추정(검증자 명령 기록에서 어떤 파일을 열었는지 추정 — 도구 출력 모양에 묶여 헛경보)이 아니라 결과 대조다.
// 학생이 "교과서 37쪽에 이렇게 써 있다"고 답하면 CCTV를 돌려보지 않고 37쪽을 펴서 그 말이 있는지 본다.
//
// 순수 계산(파일 읽기만·쓰기·이벤트 없음). 판정 종류:
//   ok                  파일 실존·줄 범위 안·상세의 식별자가 그 줄 ±window 에 '식별자로' 실제로 있음(단어 경계 정확 일치 · 문자열 안 제외)
//   outside-root        허용 루트(exec·ws·정찰 저장소) 밖 — 흔적도 경보도 아님(다른 저장소 파일 오귀속 차단 · ab-1)
//   file-missing        해석은 됐지만 파일이 없음/읽을 수 없음
//   line-out-of-range   줄 번호가 파일 줄 수를 넘음
//   token-not-near-line 줄은 있으나 상세의 식별자가 근처에 없음
//   no-location         줄 번호 없음(파일 실존만 확인 — 약한 근거)
//   no-token            상세에 식별자 없음(줄 범위까지만 확인)
//   unresolved          경로 해석 불가/모호 — 판정 보류(경보 아님 · cry-wolf 방지)
// 경보(alerts)=지적 행(src "finding")의 file-missing·line-out-of-range·token-not-near-line 만. 본문 링크(src "link")는 정보 개수로만
// (본문 링크의 EOF 초과는 기존 evidence-mismatch 가 담당 — 같은 사건 이중 경보 금지).
// ab-7: 토큰 원문은 결과에 싣지 않는다 — tokenFp(sha1 8자)만. 토큰은 상세의 백틱 코드 스팬 안 식별자만(따옴표 문자열 내부 제외).
// [구현 검증 1판 blocker] 식별자 대조는 (1) 상세 스팬과 파일 근처 줄 모두에서 따옴표 문자열 내용을 가린 뒤 (2) 단어 경계 정확 일치로만
// 인정한다 — `citation` 은 `citationCheck` 와 다르고, noop("realpathSafe") 안의 문자열은 식별자가 아니다.
const fs = require("fs");
const crypto = require("crypto");

const IDENT_RE = /[A-Za-z_$][\w$]{2,}/g;
const LINK_RE = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?\)/g; // checkCitedEvidence 와 같은 형태(경로.확장자:줄)
const ALERT_KINDS = ["file-missing", "line-out-of-range", "token-not-near-line"];
const DEFAULT_WINDOW = 3;

function realpathSafe(p) { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } }
function normKey(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
// 루트 안 판정 — realpath 기준(심볼릭 링크·8.3 짧은 이름 표기 차이를 흡수). 루트 자체 또는 그 하위만.
function underRoots(fileReal, roots) {
  const f = normKey(realpathSafe(fileReal) || fileReal); // 파일 쪽도 realpath — 호출자가 짧은 이름(RUNNER~1)·심볼릭 링크 표기로 넘겨도 루트와 같은 기준(CI Windows 러너 실측 2026-09-12)
  if (!f) return false;
  for (const r of roots || []) {
    if (!r) continue;
    const rr = realpathSafe(r);
    if (!rr) continue;
    const k = normKey(rr);
    if (f === k || f.startsWith(k + "/")) return true;
  }
  return false;
}
// 따옴표 문자열 내용을 가린다(문자열 경계만 남김) — 삼중 따옴표 블록("""…"""·'''…''')·템플릿 리터럴(`…`)은 **여러 줄**을 허용하고,
// "…"·'…' 은 한 줄. 이스케이프된 따옴표는 문자열 안으로 본다. 줄 수를 보존해야 하므로 가린 자리의 개행은 그대로 남긴다(줄 번호 대조 불변).
// [확인 검증 blocker] 여러 줄 템플릿 문자열 안의 식별자가 줄별 가림에서 살아남던 반례 → 파일 전체를 먼저 가린 뒤 줄을 나눈다.
function maskStrings(s) {
  return String(s || "").replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => {
    const q = m.startsWith('"""') || m.startsWith("'''") ? m.slice(0, 3) : m[0];
    const nl = (m.match(/\n/g) || []).length;
    return q + " " + "\n".repeat(nl) + q;
  });
}
// 상세(detail)에서 식별자 토큰 — 백틱 코드 스팬 안만. 스팬 안의 따옴표 문자열 내용은 가린 뒤 추출(비밀값 형태 가능성 · ab-7).
function tokensOf(detail) {
  const out = new Set();
  const s = String(detail || "");
  const re = /`([^`\n]{1,200})`/g;
  let m;
  while ((m = re.exec(s))) {
    const span = maskStrings(m[1].trim());
    for (const id of span.match(IDENT_RE) || []) out.add(id);
  }
  return [...out];
}
function tokenFp(t) { return crypto.createHash("sha1").update(String(t), "utf8").digest("hex").slice(0, 8); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// 단어 경계 정확 일치 — 앞뒤가 식별자 문자([\w$])가 아닐 때만. 대조 대상 텍스트는 문자열 내용을 가린 뒤 넘긴다.
function hasIdentifier(text, token) {
  const re = new RegExp("(^|[^\\w$])" + escapeRe(token) + "(?![\\w$])");
  return re.test(text);
}
// 본문의 마크다운 링크 (경로.확장자:줄) — 중복 제거·순서 보존
function bodyLinks(text) {
  const out = [];
  const seen = new Set();
  let m;
  const re = new RegExp(LINK_RE.source, "g");
  while ((m = re.exec(String(text || "")))) {
    const k = m[1] + ":" + m[2];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file: m[1], line: parseInt(m[2], 10) });
  }
  return out;
}
function checkOne(src, file, line, detail, opts) {
  const item = { src, file: String(file || ""), line: Number.isInteger(line) && line > 0 ? line : null, kind: "", tokenFp: null };
  if (!item.file) { item.kind = "no-location"; return item; }
  let resolved = null;
  try { resolved = opts.resolvePath ? opts.resolvePath(item.file) : null; } catch { resolved = null; }
  if (!resolved) { item.kind = "unresolved"; return item; }
  const real = realpathSafe(resolved);
  if (!real) { item.kind = "file-missing"; return item; }
  if (!underRoots(real, opts.roots)) { item.kind = "outside-root"; return item; }
  let text;
  try { text = fs.readFileSync(real, "utf8"); } catch { item.kind = "file-missing"; return item; }
  const lines = text.split(/\r?\n/);
  if (item.line === null) { item.kind = "no-location"; return item; }
  if (item.line > lines.length) { item.kind = "line-out-of-range"; item.total = lines.length; return item; }
  const toks = tokensOf(detail);
  if (!toks.length) { item.kind = "no-token"; return item; }
  const w = Number.isInteger(opts.window) ? opts.window : DEFAULT_WINDOW;
  const lo = Math.max(0, item.line - 1 - w), hi = Math.min(lines.length, item.line + w);
  const maskedLines = maskStrings(text.replace(/\r\n/g, "\n")).split("\n"); // 파일 전체를 먼저 가림(여러 줄 문자열 포함 · 줄 수 보존) → 창 대조
  const near = maskedLines.slice(lo, hi).join("\n");
  const hit = toks.find((t) => hasIdentifier(near, t));
  if (hit) { item.kind = "ok"; item.tokenFp = tokenFp(hit); return item; }
  item.kind = "token-not-near-line"; item.tokenFp = tokenFp(toks[0]); return item;
}
// 입력: { findings:[{file,line,detail,id?,prevId?}], parsedOk?, bodyText, roots:[...], resolvePath:(raw)=>abs|null, window? }
// 출력: { items, counts, alerts, parsedOk } — alerts=지적 행 불일치만(경보 재료), items 에는 토큰 원문 없음.
function citationCheck(input) {
  const opts = { roots: (input && input.roots) || [], resolvePath: input && input.resolvePath, window: input && input.window };
  const items = [];
  for (const f of (input && input.findings) || []) {
    if (!f || typeof f !== "object") continue;
    const it = checkOne("finding", f.file, f.line, f.detail, opts);
    if (typeof f.id === "string" && f.id) it.findingId = f.id;
    if (typeof f.prevId === "string" && f.prevId) it.prevId = f.prevId;
    items.push(it);
  }
  for (const l of bodyLinks(input && input.bodyText)) items.push(checkOne("link", l.file, l.line, "", opts));
  const counts = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  const alerts = items.filter((it) => it.src === "finding" && ALERT_KINDS.includes(it.kind));
  return { items, counts, alerts, parsedOk: !!(input && input.parsedOk) };
}
// 이전 미확인 citation-mismatch 이벤트가 이번 답으로 해소됐는가(순수 판정) — 반환 "lineage-ok"|"recheck-clean"|null.
//  lineage-ok   : 이전 경보의 지적 계보(findingId)가 이번 답의 지적 행(id 또는 prevId)에 전부 있고 그 행이 모두 ok
//  recheck-clean: 이번 답의 지적 블록이 정상 파싱됐고 불일치 경보가 0건(같은 저장소의 이전 불일치는 현재 답 기준으로 해소)
function resolvedByNext(prevEvent, cc) {
  if (!prevEvent || !cc) return null;
  const prevIds = ((prevEvent.items || []).map((i) => i && i.findingId).filter(Boolean));
  if (prevIds.length) {
    const byLineage = (pid) => (cc.items || []).some((it) => it.src === "finding" && it.kind === "ok" && (it.findingId === pid || it.prevId === pid));
    if (prevIds.every(byLineage)) return "lineage-ok";
  }
  if (cc.parsedOk && (cc.alerts || []).length === 0) return "recheck-clean";
  return null;
}
// 경보 문구 — 파일 이름·줄·판정 종류만(토큰 원문 없음 · ab-7). 앞 3건만 열거.
function alertDetail(alerts, en) {
  const base = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();
  const one = (a) => {
    const loc = base(a.file) + (a.line ? ":" + a.line : "");
    if (a.kind === "file-missing") return loc + (en ? "(file missing)" : "(파일 없음)");
    if (a.kind === "line-out-of-range") return loc + (en ? `(line beyond EOF · ${a.total} lines)` : `(줄 범위 밖 · 실제 ${a.total}줄)`);
    return loc + (en ? "(identifier from the finding detail not found near that line)" : "(그 줄 근처에 지적 상세의 식별자 없음)");
  };
  const head = en ? `${alerts.length} cited location(s) in the findings do not match the real file: ` : `지적 목록의 인용 ${alerts.length}건이 실제 파일과 맞지 않습니다: `;
  return head + alerts.slice(0, 3).map(one).join(" / ") + (alerts.length > 3 ? (en ? ` … (+${alerts.length - 3})` : ` … (외 ${alerts.length - 3}건)`) : "");
}
// 정보 줄(경보 아님) — 지적 행과 본문 링크를 나눠 센다: "[인용 대조] 지적 행 일치 k/n · 약한 근거 w · 불일치 m · 본문 링크 j(줄 확인만) · 루트 밖 x 제외"
function summaryLine(cc, en) {
  const items = (cc && cc.items) || [];
  const fin = items.filter((i) => i.src === "finding" && i.kind !== "outside-root" && i.kind !== "unresolved");
  const links = items.filter((i) => i.src === "link" && i.kind !== "outside-root" && i.kind !== "unresolved");
  const outside = items.filter((i) => i.kind === "outside-root").length;
  if (!fin.length && !links.length) return "";
  const ok = fin.filter((i) => i.kind === "ok").length;
  const weak = fin.filter((i) => i.kind === "no-location" || i.kind === "no-token").length;
  const mis = ((cc && cc.alerts) || []).length;
  const parts = [];
  if (fin.length) parts.push(en ? `findings matched ${ok}/${fin.length} · weak(no line/identifier) ${weak} · mismatched ${mis}` : `지적 행 일치 ${ok}/${fin.length} · 약한 근거(줄·식별자 없음) ${weak} · 불일치 ${mis}`);
  if (links.length) { const bad = links.filter((i) => i.kind === "line-out-of-range" || i.kind === "file-missing").length; parts.push(en ? `body links ${links.length} (line range only · ${bad} beyond EOF)` : `본문 링크 ${links.length}(줄 확인만 · 범위 밖 ${bad})`); }
  if (outside) parts.push(en ? `outside-root ${outside} excluded` : `루트 밖 ${outside} 제외`);
  return (en ? "[citation check] " : "[인용 대조] ") + parts.join(" · ");
}
module.exports = { citationCheck, resolvedByNext, tokensOf, maskStrings, hasIdentifier, bodyLinks, underRoots, alertDetail, summaryLine, ALERT_KINDS, DEFAULT_WINDOW };
