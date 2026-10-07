"use strict";
/*
 * [RULE-SUPPLY-CORRECTION 묶음 5(G) · 사용자 결정 D-f 2026-10-07] 붙여 넣은 글은 사용자 말이 아니다.
 * 사용자가 다른 AI 의 평가글 같은 남의 글을 붙여 넣으면, 그 안의 문장은 수칙 후보의 근거(사용자 원문)가 되지 못한다
 * (LTE 실사례: 수칙서 후보 4건 전부가 붙여 넣은 글 출처 — 주어가 '에이전트'이거나 빠지고 기술어가 섞임).
 * 가르는 기준은 입력 도구가 붙이는 '구조 표지'뿐이다(문구 목록·의미 판단 없음 — 경직성 금지).
 *  ① Claude Code: <pasted_content …> ~ </pasted_content …> 구간.
 *     닫는 표지가 없으면 여는 표지부터 끝까지, 여는 표지 없이 닫는 표지만 있으면 지금 위치부터 그 닫는 표지까지를 붙여 넣은 글로 본다(사용자 말로 잘못 세지 않는 쪽).
 *  ② Codex VS Code 확장: 붙여 넣은 글은 첨부 파일(pasted-text.txt)로 가고, 입력에는 IDE 문맥 머리('# Context from my IDE setup' ·
 *     '# Files mentioned by the user' — 첨부의 첫 줄 미리보기 포함) 뒤에 '## My request for Codex:' 줄이 온다(대화 기록 실측 2026-10-08).
 *     그 줄이 있으면 마지막 그 줄 뒤만 사용자 말이다. 훅 입력에 이 머리가 실리는지는 미확인 — 실리지 않으면 이 규칙은 아무것도 바꾸지 않는다.
 * 빠진 구간 자리에는 줄바꿈을 둔다 — 사용자 원문 인용은 한 줄이라, 빠진 구간 양쪽 글을 이어 붙인 구절이 사용자 원문으로 인정되지 않는다.
 * 원문 파일·지문은 건드리지 않는다(판독·대조 시점 계산 — 지문은 원문 전체 그대로).
 */
const PASTE_OPEN_RE = /<pasted_content\b[^>]*>/;
const PASTE_CLOSE_RE = /<\/pasted_content\b[^>]*>/;
const CODEX_REQUEST_HEAD_RE = /^## My request for Codex:[ \t]*\r?$/gm;

// 사용자가 직접 쓴 부분만 — 붙여 넣은 구간은 줄바꿈 하나로 바뀐다.
// 순서(검증 1회차 blocker): 붙여 넣은 구간을 먼저 빼고, 남은 사용자 부분에서만 Codex 요청 머리를 찾는다 — 붙여 넣은 글 안에 그 머리 모양 줄이
// 있어도 바깥 경계(여는 표지)를 지우지 못하게(남의 문장이 사용자 말로 인정되거나 사용자 문장이 잘려 나가는 일 차단).
function userAuthoredText(text) {
  const s = stripPastedBlocks(String(text == null ? "" : text));
  CODEX_REQUEST_HEAD_RE.lastIndex = 0;
  let last = null, m;
  while ((m = CODEX_REQUEST_HEAD_RE.exec(s)) !== null) { last = m; if (m[0].length === 0) CODEX_REQUEST_HEAD_RE.lastIndex++; }
  return last ? s.slice(last.index + last[0].length) : s;
}
// Claude Code 붙여 넣기 표지 구간만 뺀다(빠진 자리=줄바꿈).
function stripPastedBlocks(s) {
  let out = "", i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const o = PASTE_OPEN_RE.exec(rest), c = PASTE_CLOSE_RE.exec(rest);
    if (c && (!o || c.index < o.index)) { out += "\n"; i += c.index + c[0].length; continue; } // 짝 없는 닫는 표지=지금 위치부터 거기까지 붙여 넣은 글
    if (!o) { out += rest; break; }
    out += rest.slice(0, o.index) + "\n";
    const afterOpen = i + o.index + o[0].length;
    const c2 = PASTE_CLOSE_RE.exec(s.slice(afterOpen));
    if (!c2) break; // 닫는 표지 없음=끝까지 붙여 넣은 글
    i = afterOpen + c2.index + c2[0].length;
  }
  return out;
}
// 이 글에 붙여 넣은 부분(또는 Codex IDE 문맥 머리)이 있는가 — 판별 결과로 원문과 사용자 부분이 다르면 참
function hasNonUserParts(text) { const s = String(text == null ? "" : text); return userAuthoredText(s) !== s; }

module.exports = { PASTE_OPEN_RE, PASTE_CLOSE_RE, CODEX_REQUEST_HEAD_RE, userAuthoredText, stripPastedBlocks, hasNonUserParts };
