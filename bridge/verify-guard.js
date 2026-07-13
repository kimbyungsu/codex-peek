#!/usr/bin/env node
// Claude Code Stop 훅: 검증 모드 ON일 때, 이번 턴에 파일을 변경했는데
// Codex 검증(codex-bridge ask)을 안 받았으면 종료를 막고 검증을 강제한다.
// - 검증 모드 OFF → 통과
// - stop_hook_active(이미 한 번 막아 재진입) → 통과(무한루프 방지)
// - 변경 있음 + 브릿지 ask 없음 → block(검증 지시), 그 외 통과
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const { loadContract, BRIDGE, BRIDGE_DIR, atomicWrite, appendIntegrityEvent, writePhase, maybeCleanupState, loadLang, verifyTimeoutMin } = require("./contract-lib.js");
try { maybeCleanupState(); } catch { /* 오래된 상태파일 정리는 best-effort — 검증 흐름 방해 금지 */ } // 매 턴 끝(Stop 훅)에 들르되 실제 청소는 하루 1회
const PROOFS_DIR = path.join(BRIDGE_DIR, "proofs");
const ATTEMPTS_DIR = path.join(BRIDGE_DIR, "verify-attempts"); // V4: 한 턴 재검증 강제 횟수(무한정지 방지 바운드)
const MAX_ATTEMPTS = 3; // 한 턴에 검증을 강제(차단)하는 최대 횟수. 그 후엔 무한정지 방지로 종료 허용.

// V2: 도구(Write/Edit) 외 Bash 경유 변경(sed -i·cat>·생성기 등)도 감지하기 위해, git 저장소에서
// '지금 바뀐 파일들'의 최신 수정시각(mtime)을 본다. 키워드/정규식 나열(취약·안티패턴) 대신 실제 변경을 본다.
// 반환: null=비-git/실패(→도구 감지로 폴백), 0=변경 파일 없음, >0=가장 최근에 바뀐 파일의 mtime(ms).
// 삭제(rm·git rm·rm -r)는 파일이 사라져 stat 불가 → 존재하는 가장 가까운 조상 디렉터리 mtime으로 삭제 시각 근사
// (삭제 시 그 디렉터리 mtime이 갱신됨). gitignore된 파일·git status 타임아웃은 잡지 못함(도구 감지로 폴백).
// P1: Project MAP bootstrap 자동 생성물의 검증 트리거 예외(MAP-V2-DESIGN 1-32 원리 선적용 — decision marker는 P2).
// 판정: bootstrap run-state(phase done)의 기록 지문과 현재 파일 sha1이 '정확히 일치'하는 project-map 파일만 제외.
// run-state 부재·지문 불일치(사람 편집)·판독 실패 = 전부 보수적으로 '포함'(자동물을 잘못 제외하는 거짓 음성 금지).
// ⚠릴리스의 dirty-worktree 중단에는 이 예외를 적용하지 않는다(별도 계약 — 자동 생성물도 커밋 전 릴리스 불가가 정상).
function mapAutoExcluded(ws) {
  try { return require("./map-bootstrap.js").mapAutoExcluded(ws); } // 판정 본체는 map-bootstrap(순수 테스트 가능)
  catch { return new Set(); } // 구버전 브릿지(파일 부재) → 예외 없음(전부 포함 — 보수)
}
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
  let excluded = null; // project-map 줄을 만날 때만 lazy 계산(평소 비용 0)
  let max = 0;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let p = line.slice(3); // "XY " 다음이 경로
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4); // 이름변경 "old -> new" → 현재 파일(new)
    const posix = p.replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (posix === "project-map/" || posix.startsWith("project-map/")) {
      if (excluded === null) excluded = mapAutoExcluded(ws);
      // 판정 본체는 map-bootstrap.projectMapMtimeForStatus(순수 테스트 가능): null=전부 자동 생성물(건너뜀),
      // number=비자동물의 mtime 반영값. 구버전 브릿지(함수 부재)면 보수적으로 일반 처리(제외 없음).
      let handled = false;
      try {
        const mb = require("./map-bootstrap.js");
        if (typeof mb.projectMapMtimeForStatus === "function") {
          const m2 = mb.projectMapMtimeForStatus(ws, posix, excluded);
          if (m2 !== undefined) { if (typeof m2 === "number" && m2 > max) max = m2; handled = true; }
        }
      } catch { /* 보수: 일반 처리 */ }
      if (handled) continue;
    }
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

// V4: 한 턴 재검증 강제 횟수 관리. 옛 코드는 stop_hook_active면 무조건 통과(1회 리마인더) → 다시 멈추면 바이패스.
// 이제 재진입에서도 검증을 재확인하되, 무한정지 방지로 한 턴 MAX_ATTEMPTS회까지만 차단한다(카운터로 바운드).
function attemptsPath(session) { return path.join(ATTEMPTS_DIR, session.replace(/[^0-9a-zA-Z._-]/g, "_") + ".json"); }
function clearAttempts(session) { if (!session) return; try { fs.unlinkSync(attemptsPath(session)); } catch { /* 없으면 무시 */ } }
// 이번 턴 차단 횟수를 1 올려 반환. turnTs(이번 사용자 발화 시각)가 저장된 것보다 새로우면 이전 턴 카운터로 보고 리셋.
// 반환: 이번 턴 차단 횟수(>=1), 또는 null = 카운터 추적 불가(세션키 없음 또는 저장 실패).
// null이면 호출부가 옛 안전밸브(재진입=통과)로 폴백 → 카운터를 못 믿는 경우에도 무한 차단이 없게 한다.
function bumpAttempts(session, turnTs) {
  if (!session) return null; // 세션키 없음 → 카운트 불가
  let a = { ts: 0, count: 0 };
  try { a = JSON.parse(fs.readFileSync(attemptsPath(session), "utf8")); } catch { /* 없음=새로 */ }
  // 유효 발화시각이고 저장된 게 이전 턴이면 리셋. turnTs<=0(턴 경계 불명)이면 리셋하지 않고 '누적'해서라도
  // MAX로 바운드한다 — 매번 리셋하면 count가 1에 머물러 MAX에 영영 도달 못 해 무한 차단되기 때문.
  if (turnTs > 0 && Number(a.ts) < turnTs) a = { ts: turnTs, count: 0 };
  a.count = (Number(a.count) || 0) + 1;
  if (!atomicWrite(attemptsPath(session), JSON.stringify(a))) return null; // 저장 실패 → 카운터 신뢰 불가
  return a.count;
}

// 시스템이 transcript의 'user' 슬롯에 주입하는 '비-발화' 이벤트를 구조 표식으로 식별한다. 본문 텍스트 매칭(취약:
// 사용자가 같은 문구를 붙여넣으면 오제외, 포맷이 바뀌면 누락)이 아니라 실측한 구조 필드로만 판정한다.
//   - Stop 훅 차단 피드백      : isMeta === true
//   - 대화 압축 요약(이어가기)  : isCompactSummary === true
//   - 백그라운드 작업완료 알림  : origin.kind === "task-notification"  (진짜 사용자 발화엔 origin이 없다)
// 이들이 '마지막 사람 발화'로 잡히면 그 시각이 proof보다 뒤가 돼 checkProof가 영영 false → 무한 차단 +
// turnTs가 밀려 재검증 카운터까지 리셋되던 버그의 원인이었다. (ide_opened_file 등 구조 표식이 없는 주입은
// 실측상 진짜 발화와 구조가 동일해 여기서 못 거른다 — 단 차단마다 누적되진 않아 무한 차단은 만들지 않는다.)
function isInjectedUserEvent(o) {
  if (!o || typeof o !== "object") return false;
  if (o.isMeta === true) return true;
  if (o.isCompactSummary === true) return true;
  if (o.origin && o.origin.kind === "task-notification") return true;
  return false;
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
  if (c.harnessMode === "codex-codex") process.exit(0); // 실행 주체는 Codex Stop 훅. Claude 훅 중복 개입 금지.
  if (c.verifyMode === "off") {
    // 검증 모드 off라도 진행 phase는 정리해야 'Claude 작업중'이 다음 턴/15분까지 잔존하지 않음(라이브 오표시 방지).
    try { writePhase("done", { session: process.env.CLAUDE_CODE_SESSION_ID || j.session_id || "", workspace: ws }); } catch { /* best-effort */ }
    process.exit(0);
  }
  // (옛 코드: 재진입(stop_hook_active)이면 무조건 통과 → '다시 멈추기'로 검증 바이패스 가능했음. V4: 아래 카운터로 바운드.)

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
    // 진짜 사람 발화만 '턴 경계'로 본다. 시스템 주입 이벤트(차단 피드백·작업완료 알림·압축 요약)는 구조 표식으로
    // 제외한다(isInjectedUserEvent — 본문 텍스트가 아니라 구조 필드 기준이라 사용자가 같은 문구를 붙여넣어도 오제외 없음).
    if (o.type === "user" && o.message && !isInjectedUserEvent(o)) {
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
  // 재검증 카운터 키: 세션키가 있으면 그것, 없으면 transcript 경로 해시(이 시점 tp는 반드시 존재 — 위에서 검사).
  // → 세션키 결손 환경에서도 카운터가 동작해 MAX로 바운드(stop_hook_active 의존을 최소화).
  const attemptKey = claudeSession || ("tx-" + crypto.createHash("sha1").update(String(tp)).digest("hex").slice(0, 16));

  // 모드별 트리거: always=모든 턴 / plancode=플랜확정 or 변경 / code=변경. (변경=도구 또는 Bash 경유 실제 파일변경)
  const needVerify =
    c.verifyMode === "always" ? true :
    c.verifyMode === "plancode" ? (editedReal || planned) :
    editedReal;

  // 검증 불필요 또는 검증됨 → 통과 + 이번 턴 재검증 카운터 리셋.
  if (!needVerify || verified) {
    clearAttempts(attemptKey);
    try { writePhase("done", { session: claudeSession, workspace: ws }); } catch { /* 진행표시 best-effort */ } // 턴 정상 종료(완료)
    process.exit(0);
  }

  // 검증 필요 + 미검증 → 재검증 강제. 단 무한정지 방지로 한 턴 MAX_ATTEMPTS회까지만 차단(V4).
  // 재진입(stop_hook_active)이어도 검증을 다시 확인하므로 '다시 멈추기'로 바이패스되지 않는다.
  // 카운터를 못 믿는 경우(세션키 없음/저장 실패=null)엔 옛 안전밸브로 폴백: 재진입이면 통과(무한 차단 방지).
  const n = bumpAttempts(attemptKey, lastUserTs);
  if (n === null) {
    if (j.stop_hook_active) process.exit(0); // 저장 실패 등 카운트 불가 + 재진입 → 통과(무한 차단 방지)
  } else if (n > MAX_ATTEMPTS) {
    // 충분히 강제했으나 여전히 미검증(예: Codex 미응답·연결 없음) → 무한정지 방지로 종료 허용.
    // 단 '침묵'으로 넘기지 않는다: 무결성 이벤트로 기록해 확장이 상태바 빨강 + 대시보드로 사용자에게 보인다(결정2 가시화 1단계).
    process.stderr.write(`[verify-guard] 검증을 ${MAX_ATTEMPTS}회 강제했으나 완료되지 않음 — 무한정지 방지로 종료를 허용합니다.\n`);
    try {
      appendIntegrityEvent({
        ts: new Date().toISOString(),
        session: claudeSession || "",
        workspace: ws,
        kind: "verify-incomplete",
        severity: "error",
        // detailKo/detailEn 동시 저장 — 확장 표시부가 현재 언어를 고름. detail은 구버전 판독 폴백.
        detail: loadLang() === "en"
          ? `Verify mode:${c.verifyMode} — forced ${MAX_ATTEMPTS} times, but this turn ended without a completed verification (this turn's result is UNVERIFIED).`
          : `검증 모드:${c.verifyMode} — ${MAX_ATTEMPTS}회 강제했으나 검증이 완료되지 않은 채 이 턴이 종료됨(이 턴 결과는 미검증).`,
        detailKo: `검증 모드:${c.verifyMode} — ${MAX_ATTEMPTS}회 강제했으나 검증이 완료되지 않은 채 이 턴이 종료됨(이 턴 결과는 미검증).`,
        detailEn: `Verify mode:${c.verifyMode} — forced ${MAX_ATTEMPTS} times, but this turn ended without a completed verification (this turn's result is UNVERIFIED).`,
      });
    } catch { /* 이벤트 기록 실패는 종료를 막지 않음 */ }
    try { writePhase("incomplete", { session: claudeSession, workspace: ws }); } catch { /* best-effort */ } // 검증 미완 종료
    clearAttempts(attemptKey); // 카운터 키와 일치(세션키 없을 때 no-op 방지)
    process.exit(0);
  }
  const shown = n === null ? "?" : n;
  const en = loadLang() === "en"; // 차단 사유는 Claude(모델)가 읽는 지시문 — 전역 언어를 따른다
  const waitMin = verifyTimeoutMin(); // 대시보드 전역값 정본 — Claude↔Codex와 Codex↔Codex가 같은 deadline 사용
  const what = en
    ? (planned && !editedReal ? "You confirmed a plan, but" : editedReal ? "You modified files, but" : "In this turn,")
    : (planned && !editedReal ? "플랜을 확정했는데" : editedReal ? "파일을 변경했는데" : "이번 턴에");
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: en
        ? `[Verify mode:${c.verifyMode} · attempt ${shown}/${MAX_ATTEMPTS}] ${what} there is no successful Codex verification response this turn. ` +
          `Do not finish — start exactly one durable verification via \`node "${BRIDGE}" ask-start --allow-new "<what to verify>"\`, then repeat \`node "${BRIDGE}" ask-wait <job-id>\` while pending. ` +
          `The dashboard verification wait (${waitMin} min) is the actual deadline; never start a second job. (A linked verifier is resumed and a new session is created only when none is linked.) ` +
          `(An empty command, a failure, or no link does not count — an actual response must come back). ` +
          `Report the result (pass/fail + evidence) to the user, then finish. (If there is no link and only a report is possible, report that fact. After ${MAX_ATTEMPTS} attempts, finishing is allowed.)`
        : `[검증 모드:${c.verifyMode} · ${shown}/${MAX_ATTEMPTS}회] ${what} 이번 턴에 Codex 검증의 '성공 응답'이 없다. ` +
          `종료하지 말고 지금 \`node "${BRIDGE}" ask-start --allow-new "<무엇을 검증할지>"\` 로 내구 검증을 정확히 1개 시작하고, pending이면 \`node "${BRIDGE}" ask-wait <job-id>\` 를 반복하라. ` +
          `대시보드 검증 대기시간(${waitMin}분)이 실제 deadline이며 두 번째 job은 만들지 마라. (연결된 검증 세션은 이어가고 연결이 전혀 없을 때만 새 세션을 만든다.) ` +
          `(빈 명령·실패·미연결은 인정되지 않는다 — 실제 응답이 와야 검증으로 친다). ` +
          `그 결과(통과/실패+근거)를 사용자에게 보고한 뒤 종료하라. (연결이 없어 보고만 된다면 그 사실을 보고하라. ${MAX_ATTEMPTS}회 후엔 종료가 허용된다)`,
    }),
  );
  process.exit(0);
});
