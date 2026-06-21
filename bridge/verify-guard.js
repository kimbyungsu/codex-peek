#!/usr/bin/env node
// Claude Code Stop 훅: 검증 모드 ON일 때, 이번 턴에 파일을 변경했는데
// Codex 검증(codex-bridge ask)을 안 받았으면 종료를 막고 검증을 강제한다.
// - 검증 모드 OFF → 통과
// - stop_hook_active(이미 한 번 막아 재진입) → 통과(무한루프 방지)
// - 변경 있음 + 브릿지 ask 없음 → block(검증 지시), 그 외 통과
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { loadContract, BRIDGE, BRIDGE_DIR } = require("./contract-lib.js");
const PROOFS_DIR = path.join(BRIDGE_DIR, "proofs");

// V2: 도구(Write/Edit) 외 Bash 경유 변경(sed -i·cat>·생성기 등)도 감지하기 위해, git 저장소에서
// '지금 바뀐 파일들'의 최신 수정시각(mtime)을 본다. 키워드/정규식 나열(취약·안티패턴) 대신 실제 변경을 본다.
// 반환: null=비-git/실패(→도구 감지로 폴백), 0=변경 파일 없음, >0=가장 최근에 바뀐 파일의 mtime(ms).
// 삭제(rm·git rm·rm -r)는 파일이 사라져 stat 불가 → 존재하는 가장 가까운 조상 디렉터리 mtime으로 삭제 시각 근사
// (삭제 시 그 디렉터리 mtime이 갱신됨). gitignore된 파일·git status 타임아웃은 잡지 못함(도구 감지로 폴백).
function gitChangedMaxMtime(ws) {
  let out;
  try {
    const r = cp.spawnSync("git", ["-C", ws, "--no-optional-locks", "-c", "core.quotepath=false", "status", "--porcelain"], {
      encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 * 64,
    });
    if (!r || r.status !== 0 || typeof r.stdout !== "string") return null; // 비-git/실패 → 폴백
    out = r.stdout;
  } catch {
    return null;
  }
  let max = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let p = line.slice(3); // "XY " 다음이 경로
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4); // 이름변경 "old -> new" → 현재 파일(new)
    const full = path.join(ws, p);
    let m = 0;
    try {
      m = fs.statSync(full).mtimeMs;
    } catch {
      // 삭제로 파일(또는 상위 폴더째 rm -r) 사라짐 → 존재하는 가장 가까운 조상 디렉터리 mtime으로 삭제 시각 근사.
      let d = path.dirname(full);
      for (let i = 0; i < 64; i++) {
        try { m = fs.statSync(d).mtimeMs; break; } catch { /* 더 위로 */ }
        const up = path.dirname(d);
        if (up === d) break; // 루트 도달
        d = up;
      }
    }
    if (m > max) max = m;
  }
  return max;
}

// 이번 턴에 '진짜로 성공한 Codex 검증'이 있었는지 = 브릿지(codex-bridge ask)가 성공 시 남긴 proof로 판정.
// 명령 문자열(echo도 통과)이 아니라 실제 성공(status/exit)과 '이번 사용자 발화 이후' 시각을 본다(V1).
// 식별 키 = claudeSession(대화당 유일 UUID, 파일명) + ts(이번 턴). workspace는 게이트에 쓰지 않는다 —
// 브릿지는 cwd 기반, Stop 훅은 훅 env 기반이라 둘이 달라질 수 있어(예: 하위 폴더 실행) 멀쩡한 검증을
// 거짓 차단하기 때문. 대화별 격리는 세션 키가 이미 보장(다른 세션 proof는 파일이 다름). 기록용 workspace는 proof에 남김.
function checkProof(claudeSession, sinceTs) {
  if (!claudeSession) return false;
  if (!Number.isFinite(sinceTs) || sinceTs <= 0) return false; // 턴 경계 확정 못하면 보수적 미인정(1회 차단→재진입 통과)
  const key = claudeSession.replace(/[^0-9a-zA-Z._-]/g, "_");
  let p;
  try {
    p = JSON.parse(fs.readFileSync(path.join(PROOFS_DIR, key + ".json"), "utf8"));
  } catch {
    return false; // proof 없음 = 이번 턴 성공 검증 없음
  }
  if (!p || p.status !== "success" || p.exit !== 0) return false;
  if (!(Number(p.answerChars) > 0)) return false; // 실제 응답이 있었는지(빈 응답·malformed proof 거름) — V1 '응답 존재'
  const pts = Date.parse(p.ts || "");
  if (!Number.isFinite(pts)) return false;
  return pts >= sinceTs; // 이번 사용자 발화 + 마지막 변경 이후에 성공한 검증만 인정(이전 턴·변경 전 proof는 거름)
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let j = {};
  try {
    j = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  // 계약(verifyMode)을 이 턴의 작업 폴더 기준으로 로드 — contract-inject와 동일 해석(프로젝트별).
  const ws = process.env.CLAUDE_PROJECT_DIR || j.cwd || process.cwd();
  let c;
  try {
    c = loadContract(ws);
  } catch {
    process.exit(0);
  }
  if (c.verifyMode === "off") process.exit(0); // 검증 모드 off
  if (j.stop_hook_active) process.exit(0); // 재진입 → 통과(루프 방지)

  const tp = j.transcript_path;
  if (!tp || !fs.existsSync(tp)) process.exit(0);
  let lines;
  try {
    lines = fs.readFileSync(tp, "utf8").trim().split(/\r?\n/);
  } catch {
    process.exit(0);
  }

  // 마지막 '사람' user 메시지 위치 + 그 시각(이번 턴 경계). 도구 결과 user는 제외.
  // sessionId도 같이 줍는다(CLAUDE_CODE_SESSION_ID env가 없을 때 proof 키 폴백).
  let lastUser = -1;
  let lastUserTs = 0;
  let sessionIdFromTx = "";
  for (let i = 0; i < lines.length; i++) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.sessionId && !sessionIdFromTx) sessionIdFromTx = o.sessionId;
    if (o.type === "user" && o.message) {
      const ct = o.message.content;
      const isToolResult = Array.isArray(ct) && ct.some((x) => x && x.type === "tool_result");
      const isHuman = typeof ct === "string" || (Array.isArray(ct) && ct.some((x) => x && x.type === "text"));
      if (isHuman && !isToolResult) {
        lastUser = i;
        const t = Date.parse(o.timestamp || "");
        if (Number.isFinite(t)) lastUserTs = t;
      }
    }
  }

  // 마지막 사람 발화 이후: 파일 변경(edited)·플랜 확정(planned) + '마지막 변경/플랜 시각'(lastActionTs).
  // 검증 여부는 명령이 아니라 proof로 판정(아래). 검증은 마지막 변경 '이후'여야 '검증=최종상태'가 보장된다.
  let edited = false;
  let planned = false;
  let lastActionTs = 0;
  for (let i = lastUser + 1; i < lines.length; i++) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !o.message || !Array.isArray(o.message.content)) continue;
    const ots = Date.parse(o.timestamp || "");
    for (const b of o.message.content) {
      if (!b || b.type !== "tool_use") continue;
      const n = b.name || "";
      const isEdit = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(n);
      if (isEdit) edited = true;
      if (n === "ExitPlanMode") planned = true; // 플랜 확정 신호(추론 없이 결정적)
      if ((isEdit || n === "ExitPlanMode") && Number.isFinite(ots)) lastActionTs = Math.max(lastActionTs, ots);
    }
  }

  // V2: 실제 작업트리 변경(도구 외 Bash 경유 포함)도 감지. git이면 '이번 턴에 바뀐 파일'의 최신 mtime을 본다.
  // fsChangeTs = 사용자 발화 이후에 바뀐 파일이 있으면 그 최신 시각(없거나 비-git이면 0).
  const gitMax = gitChangedMaxMtime(ws);
  const fsChangeTs = gitMax && gitMax > lastUserTs ? gitMax : 0;
  const editedReal = edited || fsChangeTs > 0; // 도구 편집 또는 파일시스템 변경(Bash 포함)

  // 검증 인정 = '명령을 쳤는가'가 아니라 '브릿지가 실제 Codex 성공 응답을 기록(proof)했는가'(V1).
  // claudeSession은 env 우선(브릿지가 proof 쓸 때 쓰는 값과 동일) → 훅 입력 → transcript 순으로 폴백.
  // proof는 '사용자 발화 + 마지막 변경(도구·Bash 모두)' 이후여야 인정 → 검증 후 또 고치면(rejudge) 재검증 강제.
  const claudeSession = process.env.CLAUDE_CODE_SESSION_ID || j.session_id || sessionIdFromTx || "";
  const sinceTs = Math.max(lastUserTs, lastActionTs, fsChangeTs);
  const verified = checkProof(claudeSession, sinceTs);

  // 모드별 트리거: always=모든 턴 / plancode=플랜확정 or 변경 / code=변경. (변경=도구 또는 Bash 경유 실제 파일변경)
  const needVerify =
    c.verifyMode === "always" ? true :
    c.verifyMode === "plancode" ? (editedReal || planned) :
    editedReal;

  if (needVerify && !verified) {
    const what = planned && !editedReal ? "플랜을 확정했는데" : editedReal ? "파일을 변경했는데" : "이번 턴에";
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          `[검증 모드:${c.verifyMode}] ${what} 이번 턴에 Codex 검증의 '성공 응답'이 없다. ` +
          `종료하지 말고 지금 \`node "${BRIDGE}" ask "<무엇을 검증할지>"\` 로 Codex 검증을 받아라 ` +
          `(빈 명령·실패·미연결은 인정되지 않는다 — 실제 응답이 와야 검증으로 친다). ` +
          `그 결과(통과/실패+근거)를 사용자에게 보고한 뒤 종료하라. (연결이 없어 보고만 된다면 그 사실을 보고하라)`,
      }),
    );
  }
  process.exit(0);
});
