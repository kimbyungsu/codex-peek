// 고정 계약(contract.json) 로더 + 주입 텍스트 빌더.
// Claude 훅(contract-inject.js)·Codex 브릿지(codex-bridge.js)·검증 훅(verify-guard.js)이 공유한다.
// 규칙은 "상수"로 매 턴 재주입 → 장기 세션/압축에도 잊지 않게.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// CODEX_BRIDGE_HOME override(확장 호스트≠훅 home 환경 대비). 미설정이면 ~/.codex-bridge. 확장·codex-bridge.js와 동일 규칙.
const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const CONTRACT_FILE = path.join(BRIDGE_DIR, "contract.json"); // 레거시 전역 계약 — 더 이상 프로젝트에 상속 안 함(ws=null 저장 폴백/구버전 호환만)
const CONTRACTS_DIR = path.join(BRIDGE_DIR, "contracts"); // 프로젝트별 계약 파일들
const BRIDGE = path.join(BRIDGE_DIR, "codex-bridge.js");
const BASE_DIRECTIVE_FILE = path.join(BRIDGE_DIR, "base-directive.json"); // 기본 지침 사용자 오버라이드(없으면 코드 기본값) — 한국어 슬롯(레거시 그대로). 영어는 base-directive.en.json
const LANG_FILE = path.join(BRIDGE_DIR, "language.json"); // 전역 언어 설정({lang:"ko"|"en"}). 없으면 ko — 기존 사용자 무회귀. 대시보드 토글이 쓰고 확장·브릿지·훅이 읽음.
const LINKS_FILE_SHARED = path.join(BRIDGE_DIR, "links.json"); // 검증 대기시간 정본. codex-bridge·훅 지시가 같은 값을 읽는다.
const INTEGRITY_FILE = path.join(BRIDGE_DIR, "integrity.json"); // 무결성 신호 채널(브릿지/verify-guard 기록 → 확장이 상태바/대시보드로 가시화). BRIDGE_DIR 직하(확장 fs.watch 안정).
const PHASE_FILE = path.join(BRIDGE_DIR, "phase.json"); // 검증 파이프라인 현재 단계(라이브 진행 표시). 훅/브릿지가 경계에서 기록 → 확장이 읽어 상태바·진행 스트립에 표시.
const PROOFS_DIR = path.join(BRIDGE_DIR, "proofs"); // 검증 증명(세션별). 시간 지나면 쌓이므로 TTL 정리 대상.
const ATTEMPTS_DIR = path.join(BRIDGE_DIR, "verify-attempts"); // 한 턴 재검증 횟수(세션별, 단명). TTL 정리 대상.
const ACTIVE_DIR = path.join(BRIDGE_DIR, "active"); // 세션별 active(연 폴더 앵커, active/<claudeSession>.json). 멀티창에서 단일 active.json이 덮이는 레이스 방지. TTL 정리 대상.
const CODEX_ACTIVE_DIR = path.join(BRIDGE_DIR, "codex-active"); // Codex 구현자 세션별 프로젝트 앵커. CODEX_THREAD_ID로 작업 cwd와 설정 루트를 분리.
const CODEX_ACTIVE_FILE = path.join(BRIDGE_DIR, "codex-active.json");
const CLEANUP_MARKER = path.join(BRIDGE_DIR, ".last-cleanup"); // 마지막 정리 시각(파일 mtime) — 하루 한 번 가드.
const PROOF_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90일 — 검증 증명은 오래 보존(연결/재방문 가능성).
const ATTEMPTS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일 — 재검증 카운터는 한 턴 단명이라 짧게.
const ACTIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일 — 휴면 후 재개 대비 길게. 만료돼도 active.json/cwd로 폴백(무해).

// 오래된 상태파일 정리. 보수적 TTL + 파일 수정시각(mtime) 기준 — 진행 중/최근 세션 파일은 mtime이 새거라
// 절대 안 지워진다(연결·active 세션을 따로 대조할 필요 없음). now를 인자로 받아 테스트에서 결정적으로 동작.
function cleanupOldState(now) {
  let removed = 0;
  const sweep = (dir, ttl) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; } // 폴더 없음 = 정리할 것 없음
    for (const n of names) {
      if (!n.endsWith(".json")) continue; // 우리가 만든 상태파일만(.last-cleanup 등 비-json은 건드리지 않음)
      const f = path.join(dir, n);
      try { if (now - fs.statSync(f).mtimeMs > ttl) { fs.unlinkSync(f); removed++; } } catch { /* 잠김/사라짐 → 건너뜀 */ }
    }
  };
  sweep(PROOFS_DIR, PROOF_TTL_MS);
  sweep(ATTEMPTS_DIR, ATTEMPTS_TTL_MS);
  sweep(ACTIVE_DIR, ACTIVE_TTL_MS); // 세션별 active도 오래된 것 정리(휴면 종료된 대화)
  sweep(CODEX_ACTIVE_DIR, ACTIVE_TTL_MS);
  sweep(path.join(BRIDGE_DIR, "codex-recovery"), PROOF_TTL_MS); // 회수 영수증 — proof와 같은 수명(설계 v5.1)
  sweep(path.join(BRIDGE_DIR, "scout-gate-attempts"), ATTEMPTS_TTL_MS); // 게이트 세션 카운터 — 검증 재시도와 같은 7일(단명 상태)
  // P-3: C-C 훅이 만드는 세션 단명 상태 3서랍 — 세션 수만큼 무기한 누적되던 것을 TTL 편입.
  // 전부 턴/세션 단명 카운터·메타라 재검증 카운터와 같은 7일(휴면 재개는 새 턴이 새 파일을 만들므로 무해).
  sweep(path.join(BRIDGE_DIR, "codex-turns"), ATTEMPTS_TTL_MS);
  sweep(path.join(BRIDGE_DIR, "codex-verify-attempts"), ATTEMPTS_TTL_MS);
  sweep(path.join(BRIDGE_DIR, "codex-scout-attempts"), ATTEMPTS_TTL_MS);
  // P-12 2b: 손상 캠페인 카운터 '격리 서랍'만 7일 편입 — verify-campaigns 본체(current .json·history)는
  // 스윕 비대상(current 상시·history는 append 시 60일 자체 trim). 서랍 분리로 current 오삭제 경로 차단.
  sweep(path.join(BRIDGE_DIR, "verify-campaigns", "corrupt"), ATTEMPTS_TTL_MS);
  // P-8 2단(v10): 승인 사다리로 '격리된' 잠금 잔재(*.lock.stale-<ts>)만 TTL 청소 — 활성 .lock은 절대 sweep
  // 금지(자동 회수 없음 계약). 격리물은 이름에 시각이 있어도 mtime 기준 7일(단명 진단 재료).
  for (const dir of [CONTRACTS_DIR, BRIDGE_DIR]) { // BRIDGE_DIR=무폴더 창 전역 계약(contract.json)의 격리물(1차 blocker⑦)
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/\.lock\.stale-\d+$/.test(n)) continue;
        const f = path.join(dir, n);
        try { if (now - fs.statSync(f).mtimeMs > ATTEMPTS_TTL_MS) { fs.unlinkSync(f); removed++; } } catch { /* 잠김/사라짐 */ }
      }
    } catch { /* 폴더 없음 */ }
  }
  // P-2: 내구 검증 작업(ask-jobs)은 프롬프트(.json)·응답(.out)·오류(.err)를 담으므로 짧게 보존.
  // 회수·재판단은 그 턴 안에서 끝나고 deadline 상한이 60분이라, mtime 7일이면 살아있는 작업일 수 없다.
  // 공용 sweep은 .json만 보므로 부속물(.out/.err/.pid·비정상 잔존 .lock-*)까지 전용 스윕으로 함께 정리.
  try {
    const jobsDir = path.join(BRIDGE_DIR, "ask-jobs");
    for (const n of fs.readdirSync(jobsDir)) {
      const f = path.join(jobsDir, n);
      try { if (now - fs.statSync(f).mtimeMs > ATTEMPTS_TTL_MS) { fs.unlinkSync(f); removed++; } } catch { /* 잠김/사라짐 → 건너뜀 */ }
    }
  } catch { /* 폴더 없음 = 정리할 것 없음 */ }
  return removed;
}
// 하루 한 번만 best-effort 정리(마커 파일 mtime으로 가드). 훅/브릿지가 매 턴 불러도 실제 청소는 하루 1회.
function maybeCleanupState() {
  try {
    if (Date.now() - fs.statSync(CLEANUP_MARKER).mtimeMs < 24 * 60 * 60 * 1000) return 0; // 24h 안 지났으면 skip
  } catch { /* 마커 없음 = 처음 → 진행 */ }
  let removed = 0;
  try { removed = cleanupOldState(Date.now()); } catch { /* 정리 실패가 훅/검증 흐름을 막지 않음 */ }
  try { fs.mkdirSync(BRIDGE_DIR, { recursive: true }); fs.writeFileSync(CLEANUP_MARKER, new Date().toISOString(), "utf8"); } catch { /* ignore */ }
  return removed;
}

// 원자적 저장: 임시파일에 쓴 뒤 rename으로만 교체. 읽는 쪽은 '옛 파일' 또는 '새 파일'만 보고 반쪽(손상)
// 파일은 절대 못 본다(다중 창/프로세스 동시쓰기 대비). ⚠ 직접쓰기 폴백은 두지 않는다 — Windows에선 대상이
// 동시 읽기로 잠깐 열려 있으면 rename이 실패하는데, 그때 직접쓰기로 폴백하면 그게 바로 반쪽파일 손상의 원인이
// 된다(검증으로 확인). 대신 rename을 짧게 재시도하고, 끝내 실패하면 옛 파일(valid)을 그대로 두고 포기한다(손상 0 우선).
// (lost-update race 자체는 막지 않음 — 파일 잠금이 필요한 별도 문제. 여기 목적은 '손상 방지'.)
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    for (let i = 0; i < 12; i++) {
      try { fs.renameSync(tmp, file); return true; } catch {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* sync backoff best-effort */ }
      }
    }
  } catch { /* mkdir/tmp 쓰기 실패(권한·디스크 등) */ }
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  try { process.stderr.write(`[codex-bridge] atomicWrite: 저장 실패(손상 방지로 옛 파일 유지): ${file}\n`); } catch { /* ignore */ }
  return false;
}

// ── 전역 언어(ko/en) ──────────────────────────────────
// 언어는 '전역' 하나 — 프로젝트/창이 바뀌어도 유지(사용자 결정). UI 문자열·주입 지침(기본지침·검증 directive)의
// 언어를 함께 정한다(v1은 묶음). 규칙/기본지침 '내용'은 언어별 파일 슬롯으로 분리 저장(ko=레거시 파일 그대로).
const LANGS = ["ko", "en"];
function loadLang() {
  try {
    const o = JSON.parse(fs.readFileSync(LANG_FILE, "utf8"));
    if (o && LANGS.includes(o.lang)) return o.lang;
  } catch { /* 파일 없음/손상 → 기본 ko(기존 사용자 무회귀) */ }
  return "ko";
}
function saveLang(lang) {
  if (!LANGS.includes(lang)) return false;
  return atomicWrite(LANG_FILE, JSON.stringify({ lang }));
}

// 검증 대기시간 정본 — 대시보드가 links.json에 저장한 분 값을 브릿지 자식 프로세스와 구현자 주입문이
// 모두 여기서 읽는다. 환경변수는 자동화/진단용 1회 override. 정수 1~60분 규칙은 확장 UI와 동일하다.
function verifyTimeoutMin() {
  const env = Number(process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN);
  let min = Number.isFinite(env) && env > 0 ? env : NaN;
  if (!Number.isFinite(min)) {
    try {
      const o = JSON.parse(fs.readFileSync(LINKS_FILE_SHARED, "utf8"));
      const v = Number(o && o.settings && o.settings.verifyTimeoutMin);
      if (Number.isFinite(v) && v > 0) min = v;
    } catch { /* 기본값 */ }
  }
  if (!Number.isFinite(min)) min = 8;
  return Math.max(1, Math.min(60, Math.round(min)));
}

// ── 무결성 신호 채널 ──────────────────────────────────
// '검증이 침묵으로 넘어간' 사건(예: 검증이 필요했는데 끝내 미완)을 기록한다. 확장이 이 파일을 읽어
// 상태바 빨강 + 대시보드 목록으로 가시화한다. 단순 게이트(차단)로 끝내지 않고 사람에게 보이게 하는 채널.
function readIntegrityEvents() {
  try {
    const d = JSON.parse(fs.readFileSync(INTEGRITY_FILE, "utf8"));
    return Array.isArray(d.events) ? d.events : [];
  } catch {
    return [];
  }
}
// ev = { ts, session, workspace, kind, severity:"error"|"warning", detail }. id/ack는 자동 부여.
// integrity.json 동시 쓰기 잠금(P1-② — read-modify-write 3주체[브릿지·훅·확장]가 겹치면 rename이 파일 손상은
// 막아도 '먼저 추가된 경고'를 통째로 잃음, 감사 2026-07-10). 임계 구역이 수 ms라 짧은 재시도(최대 ~600ms)로 충분.
// 잠금 실패 시 무잠금 진행(fail-open — 종전과 동일한 위험이지 악화 아님: 안전 판정 자료라 기록 자체를 버리진 않음).
const INTEGRITY_LOCK = INTEGRITY_FILE + ".lock";
// v2(Codex 반례 반영): stale 잠금 '자동 삭제'는 두 회수자가 서로의 새 잠금을 지워 이중 진입하는 TOCTOU라 제거 —
// 잔존 잠금은 최대 ~600ms 대기 후 무잠금 진행(fail-open=종전 동작). 즉 이 잠금은 '정상 경합에서의 유실 방지'이지
// 비정상 잔존까지 포함한 완전 해결이 아니다(정직 주장 하향). 해제는 토큰 소유권 일치 시에만(타 잠금 오삭제 방지).
// 파일 잠금 일반형 — withIntegrityLock과 동일 규율(wx 선점·토큰 소유권·죽은 pid 즉시 degraded·자기 토큰만 해제·
// 잔존 잠금 자동 삭제 없음[상호 삭제 TOCTOU]). '정상 경합에서의 유실 방지'이지 완전 해결 아님(같은 한계 고지).
function withFileLock(lockPath, fn) {
  const token = process.pid + "-" + Math.random().toString(36).slice(2, 8);
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) {
    try { fs.writeFileSync(lockPath, token, { flag: "wx" }); locked = true; }
    catch {
      try { const pid = parseInt(String(fs.readFileSync(lockPath, "utf8")).split("-")[0], 10); if (pid) { try { process.kill(pid, 0); } catch { break; } } } catch { /* 판독 불가 — 재시도 */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* SAB 불가 — 즉시 재시도 */ }
    }
  }
  try { return fn(); }
  finally {
    if (locked) { try { if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath); } catch { /* 무해 */ } }
  }
}
function withIntegrityLock(fn) { return withFileLock(INTEGRITY_LOCK, fn); }
// 구현/검증 역할 링크를 바꾸는 모든 주체가 공유하는 잠금. 링크 보존과 동일세션 충돌 판정을
// 같은 임계구역에서 수행하기 위한 별도 채널이다.
function withRoleLock(fn) {
  const r=withFileLockStrict(LINKS_FILE_SHARED+".role.lock",fn);
  if(!r.ok)throw new Error(r.error||"role-lock-failed");
  return r.result;
}
// fail-closed 변형(Project MAP 정본 전용 — 설계검증 2026-07-10): 관찰 일지의 fail-open(기록을 버리지 않기 위한
// degraded)과 달리, 구조 정본(topology·decisions) 트랜잭션은 잠금 실패 시 '실행하지 않고' 실패를 알린다 —
// 두 적용자가 동시에 진입하면 CAS 이후 lost-update가 나기 때문. 반환: {ok, result?, error?}.
function withFileLockStrict(lockPath, fn) {
  const token = process.pid + "-" + Math.random().toString(36).slice(2, 8);
  let locked = false;
  for (let i = 0; i < 40 && !locked; i++) {
    try { fs.writeFileSync(lockPath, token, { flag: "wx" }); locked = true; }
    catch {
      // 사망 확정은 ESRCH만(4차 지적 3) — EPERM 등은 '존재하나 조회 권한 없음'일 수 있어 사망 단정·삭제 유도 금지(보유 중으로 보고 재시도)
      try { const pid = parseInt(String(fs.readFileSync(lockPath, "utf8")).split("-")[0], 10); if (pid) { try { process.kill(pid, 0); } catch (ke) { if (ke && ke.code === "ESRCH") return { ok: false, error: "dead-lock-holder: " + lockPath + " (pid " + pid + " 사망 — 잔존 잠금 수동 삭제 필요)" }; } } } catch { /* 판독 불가 — 재시도 */ }
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* 즉시 재시도 */ }
    }
  }
  if (!locked) return { ok: false, error: "lock-timeout: " + lockPath };
  try { return { ok: true, result: fn() }; }
  finally { try { if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath); } catch { /* 무해 */ } }
}
function appendIntegrityEvent(ev) {
  return withIntegrityLock(() => {
    const events = readIntegrityEvents();
    const id = `${(ev && ev.ts) || ""}_${Math.random().toString(36).slice(2, 8)}`; // 일반 node(워크플로 아님)라 Math.random OK
    events.push(Object.assign({ id, ack: false }, ev));
    return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events: events.slice(-50) })); // 최근 50건 상한
  });
}

// ── 검증 통계 누적(append-only) — 대시보드 탭2 통계 재료 ──
// integrity는 '최신 상태'(통과는 안 남고 supersede로 지움)라 통계가 안 된다. 그래서 검증 1건당 1줄을 별도 로그에 쌓는다.
// 원문(prompt/answer)은 저장하지 않고 메타만: ts/workspace/세션/verdict/answerChars + model/mode/codexTokens(검증 시점 모델·검증모드·이 검증 1회 토큰, flagVerdict가 append 시 채움). 과거 기록엔 이 필드들이 없을 수 있다('미상').
const STATS_DIR = path.join(BRIDGE_DIR, "stats");
const VERDICTS_FILE = path.join(STATS_DIR, "verdicts.jsonl");
// 검증 기록부 리텐션 — 60일 넘은 유효 줄과 깨진 JSON 줄을 정리해 무한 증가를 막는다(흐름 최대 창 28일 + 여유). best-effort.
// 깨진 JSON만 제거하고, ts가 이상(NaN)이거나 미래인 줄은 보존(집계측 computeVerifyStats가 별도로 걸러냄). 동시 append 유실은 드물고 통계만 영향 → 허용.
function trimVerdicts(maxDays = 60) {
  try {
    const raw = fs.readFileSync(VERDICTS_FILE, "utf8");
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const nonEmpty = [], kept = [];
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      nonEmpty.push(ln);
      let o; try { o = JSON.parse(ln); } catch { continue; } // 깨진/반쪽 줄 → kept 제외
      const ts = Date.parse(o.ts);
      if (Number.isFinite(ts) && ts < cutoff) continue; // 60일 초과(유효 ts) → kept 제외. NaN/미래는 보존(집계측 computeVerifyStats가 별도로 거름)
      kept.push(ln);
    }
    if (kept.length === nonEmpty.length) return kept.length; // 제거할 깨진·오래된 줄 없음 → rewrite 안 함(평소 read만 — IO·여러 창 동시 덮어쓰기 위험 최소화)
    fs.writeFileSync(VERDICTS_FILE, kept.length ? kept.join("\n") + "\n" : "", "utf8");
    return kept.length;
  } catch { return -1; } // 파일 없음 등 — best-effort(검증 흐름 안 막음)
}
// ── 정찰(3트랙) 비용 기록 — 2026-07-09 사용자 요구 "토큰·턴수를 투명하게, 비용 추정 가능하게" ──
// 지도 메타(.json)는 프로젝트당 최근 10장만 남아 누적 비용 산출이 불가(실사고 감사) → verdicts와 동일한
// append-only + 60일 트림 패턴의 별도 장부. 스키마: {ts, workspace, arm(self|deepseek|ping), model,
// usageIn, usageOut(토큰 — self는 null: claude -p text 출력이 사용량을 안 줌), pkgChars, mapChars(문자수 — self 추정 재료)}.
const SCOUT_USAGE_FILE = path.join(STATS_DIR, "scout-usage.jsonl");
function trimScoutUsage(maxDays = 60) {
  try {
    const raw = fs.readFileSync(SCOUT_USAGE_FILE, "utf8");
    const cut = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const kept = [];
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try { const o = JSON.parse(ln); const t = Date.parse(o.ts || ""); if (Number.isFinite(t) && t >= cut) kept.push(ln); } catch { /* 깨진 줄 폐기 */ }
    }
    fs.writeFileSync(SCOUT_USAGE_FILE, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  } catch { /* 파일 없음/잠김 — 다음 기회 */ }
}
function appendScoutUsage(ev) {
  try {
    if (!ev || !ev.arm) return false;
    fs.mkdirSync(STATS_DIR, { recursive: true });
    fs.appendFileSync(SCOUT_USAGE_FILE, JSON.stringify(ev) + "\n", "utf8");
    trimScoutUsage(60);
    return true;
  } catch { return false; } // best-effort — 비용 기록 실패가 지도 생성 흐름을 막지 않음
}

// ── P-8 2단(설계 동결 v10) — 계약 저장 단일 관문 updateContractPatch + 계약 전용 v10 잠금 ─────────────
// v10 잠금 계약: 토큰=구조화 JSON({v:1,pid,rnd,ts}) wx 선점 → '획득 직후 read-back fence'(내 토큰 재확인 —
// wx 경합·파일계 이상으로 남의 잠금 위에서 진행하는 것 차단) → 실패 시 상태 6분류로 종료(자동 stale 회수
// 없음 — 복구는 상태별 승인 사다리[확장 UI/CLI 안내]만): alive(보유자 생존·EPERM 포함)=재시도 후 timeout /
// dead-valid(정상 토큰+ESRCH 확정 사망) / invalid(신·구 형식 모두 아님 — 파싱 실패) / unreadable(fs 읽기
// 실패 — 격리 금지·조사 안내) / owner-unverified(pid 판정이 ESRCH·EPERM 외 오류) / absent(판정 중 ENOENT=
// 정상 해제 경합 — 즉시 재획득 재시도). 구형 토큰("pid-rnd" 평문)은 전환기 혼용 대비 유효로 인정(pid 판정).
function parseLockToken(raw) {
  const s = String(raw || "").trim();
  try {
    const o = JSON.parse(s);
    // 1차 blocker③: '정상 토큰'은 전 필드 엄격 — v===1·양의 정수 pid·비공백 rnd·비공백 ts 문자열.
    // 느슨하면 손상 잠금이 dead-valid/alive로 오분류돼 승인 사다리(2단)가 1클릭으로 약화된다.
    if (o && typeof o === "object" && o.v === 1 && Number.isInteger(o.pid) && o.pid > 0 && typeof o.rnd === "string" && o.rnd.trim() && typeof o.ts === "string" && o.ts.trim()) return { pid: o.pid, form: "v10" }; // 2차 blocker③: 공백뿐 필드=손상(invalid) — trim 검사
  } catch { /* 구형 폴백 */ }
  const m = /^(\d+)-[0-9a-z]+$/.exec(s);
  if (m) { const pid = parseInt(m[1], 10); if (pid > 0) return { pid, form: "legacy" }; }
  return null;
}
function withContractLockV10(lockPath, fn, maxTries) {
  const mine = JSON.stringify({ v: 1, pid: process.pid, rnd: Math.random().toString(36).slice(2, 10), ts: new Date().toISOString() });
  const N = Number.isInteger(maxTries) && maxTries >= 1 ? maxTries : 40; // CLI=동기 짧은 재시도(기본 40×15ms) / 확장=1회 시도+비동기 재시도(호스트 블록 금지 — v10)
  let lastState = "alive";
  for (let i = 0; i < N; i++) {
    let locked = false;
    try { fs.writeFileSync(lockPath, mine, { flag: "wx" }); locked = true; } catch { /* 경합 — 아래 분류 */ }
    if (locked) {
      // read-back fence(v10): 내가 방금 쓴 토큰이 실제로 파일에 있는지 재확인 — 아니면 획득 무효(재시도).
      // 2차 blocker④+4차: fence '읽기 실패'=unreadable 반환만 — 자동 삭제 없음(확인-후-삭제 TOCTOU 제거).
      // 내 잠금이 남으면 프로세스 생존 동안 정직한 alive 자기차단(희귀 일시 장애)·종료 후 dead-valid 사다리가 회수.
      let back = null, rerr = null; try { back = fs.readFileSync(lockPath, "utf8"); } catch (e) { rerr = e; }
      if (rerr) {
        // 4차 blocker: fence 판독 실패 시 자동 삭제 '없음' — 재판독~unlink 사이 교체 경합이 새 활성 잠금을 지울 수
        // 있어(3차의 조건부 삭제도 TOCTOU 잔존) 확인-후-삭제 자체를 폐기한다. 내 잠금이 남으면: 이 프로세스 생존
        // 동안은 alive(정직한 자기차단·희귀 일시 장애), 종료 후엔 dead-valid 1클릭 사다리가 사후 회수 경로.
        return { ok: false, state: "unreadable", lockPath, error: "lock-unreadable-after-acquire: " + lockPath };
      }
      if (back !== mine) { lastState = "alive"; continue; } // 남이 교체(극단 경합) — 내 잠금 아님(정리 불요·재시도)
      // fn에 '쓰기 직전 소유 재확인' 수단 제공(2차 blocker② 완화 — 격리 이중 경합으로 잠금이 옮겨져도 실제 쓰기 전에
      // 감지·중단. 재확인~쓰기 사이 미시적 간극은 P1 §5 동형 보장수준으로 명문화 — v10 정본 그대로).
      const stillMine = () => { try { return fs.readFileSync(lockPath, "utf8") === mine; } catch { return false; } };
      try { return { ok: true, result: fn(stillMine) }; }
      finally { try { if (fs.readFileSync(lockPath, "utf8") === mine) fs.unlinkSync(lockPath); } catch { /* 무해 */ } }
    }
    let raw = null;
    try { raw = fs.readFileSync(lockPath, "utf8"); }
    catch (e) {
      if (e && e.code === "ENOENT") { lastState = "absent"; continue; } // 정상 해제 경합 — 즉시 재획득
      return { ok: false, state: "unreadable", lockPath, error: "lock-unreadable: " + lockPath }; // 격리 금지·조사 안내
    }
    const tok = parseLockToken(raw);
    if (!tok) return { ok: false, state: "invalid", lockPath, error: "lock-invalid: " + lockPath }; // 형식 불명 — 2단 승인 사다리 대상
    try { process.kill(tok.pid, 0); lastState = "alive"; } // 생존 — 재시도
    catch (ke) {
      if (ke && ke.code === "ESRCH") return { ok: false, state: "dead-valid", lockPath, pid: tok.pid, error: "dead-lock-holder: " + lockPath + " (pid " + tok.pid + " 사망 — 승인 후 정리)" };
      if (ke && ke.code === "EPERM") lastState = "alive"; // 존재하나 조회 권한 없음 — 보유 중 취급(사망 단정 금지)
      else return { ok: false, state: "owner-unverified", lockPath, error: "lock-owner-unverified: " + lockPath };
    }
    if (N > 1) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); } catch { /* 즉시 재시도 */ } } // 1회 시도 모드는 대기 없이 즉시 반환(비동기 재시도는 호출자 몫)
  }
  return { ok: false, state: lastState === "absent" ? "absent" : "alive", lockPath, error: "lock-timeout: " + lockPath };
}
// 승인된 복구만 수행하는 격리(자동 경로에서 절대 호출 금지): 정리 직전 상태 재판정+expect(승인 시점 원문)
// 불변 확인 후 <lock>.stale-<ts>로 rename(삭제 아님 — 원문 보존·TTL 청소 대상). 상태가 바뀌었으면 중단.
function quarantineContractLock(lockPath, expectRaw, _testHookBeforeRename) {
  let raw = null;
  try { raw = fs.readFileSync(lockPath, "utf8"); }
  catch (e) { return { ok: false, reason: e && e.code === "ENOENT" ? "absent" : "unreadable" }; }
  if (typeof expectRaw === "string" && raw !== expectRaw) return { ok: false, reason: "changed" }; // 승인 사이에 내용 변경 — 오탈취 방지
  const tok = parseLockToken(raw);
  if (tok) { try { process.kill(tok.pid, 0); return { ok: false, reason: "alive" }; } catch (ke) { if (!(ke && ke.code === "ESRCH")) return { ok: false, reason: "owner-unverified" }; } }
  if (typeof _testHookBeforeRename === "function") _testHookBeforeRename(); // 테스트 전용 주입 — 판정~rename 사이 교체 경합 재현
  const dest = lockPath + ".stale-" + Date.now();
  try { fs.renameSync(lockPath, dest); } catch { return { ok: false, reason: "rename-failed" }; }
  // 1차 blocker②(TOCTOU): rename 뒤 '옮겨진 실물'이 승인 원문인지 재확인 — 판정~rename 사이 옛 잠금 해제+새
  // 활성 잠금 생성이면 우리가 새 잠금을 격리한 것 → 즉시 원위치 복원·중단(v10 '정리 중 새 잠금=중단·복원').
  let moved = null; try { moved = fs.readFileSync(dest, "utf8"); } catch { moved = null; }
  if (moved !== raw) {
    // 2차 blocker②: 복원은 '자리가 비어 있을 때만'(POSIX rename의 기존 목적지 무단 교체=제3 활성 잠금 삭제 금지).
    // 자리가 차 있으면 격리물을 그대로 두고 위치 보고 — 밀려난 작성자의 실제 쓰기는 관문의 '쓰기 직전 소유
    // 재확인'(stillMine)이 중단시키므로 동시 쓰기는 성립하지 않는다(이중 방어).
    // 3차 blocker②: 복원은 '원자적 무클로버'만 — link(dest→lockPath)는 목적지 존재 시 EEXIST로 실패해
    // (existsSync~rename 사이 경합에서 POSIX rename이 제3 활성 잠금을 교체하던 경로 제거) 성공 시에만 격리물 제거.
    let restored = false;
    try { fs.linkSync(dest, lockPath); try { fs.unlinkSync(dest); } catch { /* 링크 성공 후 잔재 — TTL이 정리 */ } restored = true; }
    catch { /* EEXIST(자리 참)·링크 미지원 — 클로버 시도 없이 위치 보고 */ }
    if (restored) return { ok: false, reason: "raced-restored" };
    return { ok: false, reason: "raced-unrestored", dest };
  }
  return { ok: true, dest };
}
// 단일 관문(v10): 전 작성자(전체저장·모드·정찰대상·scope-target·scope-gate·체크박스·modeSwitch)가 이 관문만
// 통과한다. ws=null(무폴더 창)=CONTRACT_FILE 폴백·잠금 키=최종 절대경로. patch=객체(재읽기-병합) 또는
// 함수(mutate(cur) — scope 스크립트의 삭제 포함 변형용·반환 무시). 손상 JSON=기록 거부(fail-closed)·
// ENOENT만 신설. 반환 {ok, state?, error?} — 실패 상태는 복구 사다리의 입력.
function updateContractPatch(ws, lang, patch, opts) {
  try {
    if (!patch || (typeof patch !== "object" && typeof patch !== "function") || Array.isArray(patch)) return { ok: false, state: "bad-input", error: "bad-patch" };
    const file = ws ? contractFileFor(ws, lang) : CONTRACT_FILE;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 잠금 wx가 ENOENT로 헛돌지 않게 — 실패 시 잠금이 실패 판정 */ }
    const r = withContractLockV10(path.resolve(file) + ".lock", (stillMine) => {
      let cur = {};
      try {
        cur = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false; // 형식 불명 → 기록 거부
      } catch (e) {
        if (!e || e.code !== "ENOENT") return false; // 손상·판독 불가 → 기록 거부(fail-closed — P-1 교훈)
        cur = {};
      }
      let next;
      if (typeof patch === "function") { next = { ...cur }; patch(next); }
      else next = { ...cur, ...patch };
      next.updatedAt = new Date().toISOString();
      if (ws) next.workspace = ws;
      // 2차 blocker②: 쓰기 '직전' 소유 재확인 — 승인 격리 이중 경합 등으로 내 잠금이 옮겨졌으면 기록 중단
      // (밀려난 작성자와 새 보유자의 동시 쓰기 차단 — 잔여 미시 간극은 P1 §5 동형 보장수준 명문화).
      if (typeof stillMine === "function" && !stillMine()) return false;
      return atomicWrite(file, JSON.stringify(next, null, 2));
    }, opts && opts.tries);
    if (!r.ok) return { ok: false, state: r.state, error: r.error, lockPath: r.lockPath };
    return r.result ? { ok: true } : { ok: false, state: "refused", error: "corrupt-or-write-failed" };
  } catch (e) { return { ok: false, state: "exception", error: String((e && e.message) || e) }; }
}
// P-8 1단(2026-07-15) 서명 유지 래퍼 — 기존 호출처(훅·테스트) 무변경. 실체는 단일 관문 updateContractPatch.
function patchContractFields(ws, lang, patch) {
  if (!ws) return false; // 기존 계약: 훅 경로는 ws 필수(무폴더 폴백은 관문 직접 호출자만)
  return updateContractPatch(ws, lang, patch).ok === true;
}

// ── P-12 2a 백로그 장부(설계 동결 ⓚ) — 검증의 비차단 지적([백로그]·[주의] 승격분)이 답변에만 남고
// 증발하는 부채 누적 구조를 막는 프로젝트별 할 일 장부. append-only jsonl + 줄 순서 fold(ts=표시용),
// 전 명령 <파일>.lock 직렬화(재작성 경합 차단·실패=기록 거부), 손상 줄=건너뛰되 개수 가시화(fail-visible),
// TTL 자동 삭제 '비대상'(사용자 할 일 — 수동 clear만).
const BACKLOG_DIR = path.join(BRIDGE_DIR, "verify-backlog");
const BACKLOG_TAGS = ["주의", "백로그"];
// 정규화·id([백로그] 항목의 구현 확정): 제목=NFC→공백 압축→trim→200자 절단(저장값과 동일) →
// 해시는 절단 '후' 값의 소문자. 경로=NFC→trim→구분자 / 통일, 해시는 소문자(win 대소문자 무시).
function normBacklogTitle(t) {
  let x = String(t || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (x.length > 200) x = x.slice(0, 200); // 민감 최소화 — 200자 상한(설계 ⓚ)
  return x;
}
// 파일 경로 민감 최소화(설계 ⓚ 강제): ws 내부=상대화, 외부=basename+"(외부)" — 사용자명 등 로컬 식별정보가
// 무기한 잔존하는 경로 차단. 상대·절대 모두 ws 기준으로 실제 위치를 확정 후 포함 검사(구현검증 2차 blocker:
// '../…' 상대경로가 외부 축소를 우회하던 구멍).
function normBacklogFile(f, ws) {
  if (!f) return "";
  const x = String(f).normalize("NFC").trim().replace(/\\/g, "/");
  // 2c 구현검증 3차 blocker: file: URI와 '반대 OS' 절대경로(예: POSIX에서 드라이브 경로)는 현 OS의
  // path.isAbsolute가 절대로 인식하지 못해 ws 기준 상대 결합으로 원문(사용자 디렉터리 포함)이 보존되던 우회 —
  // 현 OS 문법과 무관하게 '절대경로 형태'를 먼저 식별해, 현 OS가 해석 못 하는 형태는 즉시 basename 외부 축소.
  const lastSeg = (s) => { const parts = s.replace(/[?#].*$/, "").split("/").filter(Boolean); return parts.length ? parts[parts.length - 1] : s; };
  if (/^file:/i.test(x)) {
    // 4차 blocker: %2F·%5C 등 퍼센트 인코딩 구분자가 lastSeg를 우회해 전체 경로 문자열이 보존되던 구멍 —
    // 해독 후 축소하고, 해독 불능·이중 인코딩 잔존은 원문을 '전혀' 보존하지 않는 상수로 축소(fail-closed).
    let u = x.replace(/[?#].*$/, "");
    try { u = decodeURIComponent(u); } catch { return "(외부 URI)"; }
    if (u.includes("%")) return "(외부 URI)"; // 해독 후 % 잔존=다중 인코딩 가능성(3중 %25255C가 %255C로 통과하던 5차 blocker) — 깊이 불문 원문 비보존(리터럴 % 파일명 오탐=안전 방향)
    return lastSeg(u.replace(/\\/g, "/")) + " (외부)"; // file:// URI — 경로 원문 비보존
  }
  const foreignAbs = /^[A-Za-z]:\//.test(x) || /^\/\//.test(x) || x.startsWith("/"); // 드라이브·UNC(//)·루트 — OS 무관 절대 형태
  if (foreignAbs && !path.isAbsolute(x)) return lastSeg(x) + " (외부)"; // 현 OS가 절대로 못 읽는 이형 절대경로
  const abs = path.isAbsolute(x) ? x : path.resolve(String(ws || ""), x);
  const rel = path.relative(String(ws || ""), abs).replace(/\\/g, "/");
  if (rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)) return rel; // 세그먼트 단위 경계(3차 blocker: ..notes/ 같은 내부 정상 디렉터리 오판·항목 병합 방지)
  return path.basename(abs) + " (외부)";
}
function backlogId(title, file) {
  return crypto.createHash("sha256").update(normBacklogTitle(title).toLowerCase() + "|" + String(file || "").toLowerCase(), "utf8").digest("hex").slice(0, 16);
}
function backlogFileFor(ws) { return path.join(BACKLOG_DIR, wsKeyFor(ws) + ".jsonl"); }
// fold=파일 append 순서(잠금 직렬화가 순서를 권위로 — ts 정렬은 시계 역전·동일 ms 역전 위험이라 표시용).
// 전이표(동결): 신규 add=open · 기존 id add/seen=lastSeen·seenCount·tag 단조 승격(백로그→주의만)·
// lang/mode/profile/source 최신화·status=open(재발견=reopen) · status 줄=지정 상태. add 없는 seen/status·
// 스키마 불일치=손상으로 계수(침묵 유실 금지).
function foldBacklogRaw(raw) {
  const map = new Map(); const lines = []; let corrupt = 0;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o = null; try { o = JSON.parse(line); } catch { corrupt++; lines.push({ line, id: null, bad: true }); continue; }
    // 의미 검증(구현검증 1차 blocker): id 16hex·ts 존재·이벤트별 필수 필드·add의 id=재계산 해시 일치 —
    // 스키마 불일치는 정상 항목으로 수용하지 않고 손상으로 계수(침묵 수용 금지).
    const okBase = o && typeof o === "object" && o.schema === "vbl-1" && typeof o.id === "string" && /^[a-f0-9]{16}$/.test(o.id) && typeof o.ts === "string" && o.ts;
    const okShape = okBase && (
      (o.ev === "add" && BACKLOG_TAGS.includes(o.tag) && typeof o.title === "string" && normBacklogTitle(o.title) && o.id === backlogId(o.title, o.file)) ||
      (o.ev === "seen" && BACKLOG_TAGS.includes(o.tag)) ||
      (o.ev === "status" && (o.status === "done" || o.status === "dismissed"))
    );
    if (!okShape) { corrupt++; lines.push({ line, id: okBase ? o.id : null, bad: true }); continue; }
    const cur = map.get(o.id);
    if (o.ev === "add" && !cur) {
      map.set(o.id, { id: o.id, tag: o.tag === "주의" ? "주의" : "백로그", title: normBacklogTitle(o.title), file: String(o.file || ""), lang: String(o.lang || ""), mode: String(o.mode || ""), profile: String(o.profile || ""), source: String(o.source || ""), firstSeen: String(o.ts || ""), lastSeen: String(o.ts || ""), seenCount: 1, status: "open" });
      lines.push({ line, id: o.id, bad: false }); continue;
    }
    if ((o.ev === "add" || o.ev === "seen") && cur) {
      cur.lastSeen = String(o.ts || cur.lastSeen); cur.seenCount++;
      if (o.tag === "주의") cur.tag = "주의"; // 단조 승격 — 하향 없음
      if (o.lang) cur.lang = String(o.lang); if (o.mode) cur.mode = String(o.mode);
      if (o.profile) cur.profile = String(o.profile); if (o.source) cur.source = String(o.source);
      cur.status = "open"; // 재발견=reopen
      lines.push({ line, id: o.id, bad: false }); continue;
    }
    if (o.ev === "status" && cur && (o.status === "done" || o.status === "dismissed")) {
      cur.status = o.status; lines.push({ line, id: o.id, bad: false }); continue;
    }
    corrupt++; lines.push({ line, id: typeof o.id === "string" ? o.id : null, bad: true }); // add 없는 seen/status 등
  }
  return { items: [...map.values()], corrupt, lines };
}
function readBacklog(ws) {
  let raw = "";
  try { raw = fs.readFileSync(backlogFileFor(ws), "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { items: [], corrupt: 0 }; // 장부 미생성=진짜 빈 상태
    return { items: [], corrupt: 0, readError: true }; // 권한·잠금 등 판독 실패 — '비어 있음'으로 위장 금지(확인 판정 [주의] 수용 2026-07-18)
  }
  const f = foldBacklogRaw(raw); return { items: f.items, corrupt: f.corrupt };
}
// 기록: 잠금 직렬화 — 실패=false(기록 거부·fail-closed). 반환 {ok, id, existed}.
function backlogAdd(ws, opts) {
  const title = normBacklogTitle(opts && opts.title);
  if (!title) return { ok: false, error: "empty-title" };
  const tag = opts && opts.tag === "주의" ? "주의" : "백로그";
  const file = normBacklogFile(opts && opts.file, ws);
  const id = backlogId(title, file);
  const target = backlogFileFor(ws);
  try { fs.mkdirSync(BACKLOG_DIR, { recursive: true }); } catch { /* append에서 드러남 */ }
  const r = withFileLockStrict(target + ".lock", () => {
    let raw = ""; try { raw = fs.readFileSync(target, "utf8"); } catch { /* 신규 */ }
    const existed = foldBacklogRaw(raw).items.some((x) => x.id === id);
    const base = { schema: "vbl-1", id, tag, lang: String(opts && opts.lang || ""), mode: String(opts && opts.mode || ""), profile: String(opts && opts.profile || ""), source: String(opts && opts.source || ""), ts: new Date().toISOString() };
    const ev = existed ? { ...base, ev: "seen" } : { ...base, ev: "add", title, file };
    fs.appendFileSync(target, JSON.stringify(ev) + "\n", "utf8");
    return existed;
  });
  if (!r.ok) return { ok: false, error: r.error || "lock" };
  return { ok: true, id, existed: r.result === true };
}
function backlogSetStatus(ws, id, status) {
  if (status !== "done" && status !== "dismissed") return { ok: false, error: "bad-status" };
  const target = backlogFileFor(ws);
  const r = withFileLockStrict(target + ".lock", () => {
    let raw = ""; try { raw = fs.readFileSync(target, "utf8"); } catch { return "missing"; }
    if (!foldBacklogRaw(raw).items.some((x) => x.id === id)) return "missing";
    fs.appendFileSync(target, JSON.stringify({ schema: "vbl-1", id, ev: "status", status, ts: new Date().toISOString() }) + "\n", "utf8");
    return "ok";
  });
  if (!r.ok) return { ok: false, error: r.error || "lock" };
  return r.result === "ok" ? { ok: true } : { ok: false, error: "not-found" };
}
// 닫힌 항목만 물리 정리 — 손상 줄은 '원문 그대로 보존 복사'(조용한 제거 금지·fail-visible),
// open 항목의 줄 전부 보존. 잠금 안 재작성(atomicWrite — 크래시 안전).
function backlogClearDone(ws) {
  const target = backlogFileFor(ws);
  const r = withFileLockStrict(target + ".lock", () => {
    let raw = ""; try { raw = fs.readFileSync(target, "utf8"); } catch { return { removed: 0, corrupt: 0 }; }
    const f = foldBacklogRaw(raw);
    const closed = new Set(f.items.filter((x) => x.status !== "open").map((x) => x.id));
    const kept = f.lines.filter((l) => l.bad || !l.id || !closed.has(l.id)).map((l) => l.line);
    if (!atomicWrite(target, kept.length ? kept.join("\n") + "\n" : "")) return { error: "write" };
    return { removed: closed.size, corrupt: f.corrupt };
  });
  if (!r.ok) return { ok: false, error: r.error || "lock" };
  if (r.result && r.result.error) return { ok: false, error: r.result.error };
  return { ok: true, removed: r.result.removed, corrupt: r.result.corrupt };
}

// ── P-12 2b 왕복 예산(설계 동결 v6) — '정상 추적 상태의 기계적 상한'. 앵커·잠금·기록 실패 시엔 미집계로
// 느슨해지되 반드시 가시화한다(절대 상한 주장 금지). 캠페인 키=사용자 턴 결속, 카운터 초기화 금지,
// 소진 시 자동 통과 금지. 예약 위치는 자식 cmdAsk의 검증 모델 호출 공통 래퍼 1곳(codex-bridge.js).
const CAMPAIGN_DIR = path.join(BRIDGE_DIR, "verify-campaigns");
const CAMPAIGN_CORRUPT_DIR = path.join(CAMPAIGN_DIR, "corrupt"); // 손상 카운터 격리 서랍 — 공용 sweep(.json)과 분리해 current 오삭제 차단, P-3 7일 스윕 편입
const CAMPAIGN_HISTORY_DAYS = 60;
function campaignFileFor(ws) { return path.join(CAMPAIGN_DIR, wsKeyFor(ws) + ".json"); }
function campaignHistoryFileFor(ws) { return path.join(CAMPAIGN_DIR, wsKeyFor(ws) + ".history.jsonl"); }
// CL-C 캠페인 앵커 판독 권위(5차 blocker — 멀티 창 미끼 차단): 전역 active.json 단독 판독 금지.
// ①CLAUDE_CODE_SESSION_ID의 세션별 active/<safe-sid>.json 우선 ②내용 claudeSession===sid·유효 ts 검증
// ③전역 active.json 폴백은 '내용이 같은 세션일 때만' ④실패=미집계(untracked) 진행. configWs 판독 권위와 동형.
function claudeCampaignAnchor(sid) {
  const s = String(sid || process.env.CLAUDE_CODE_SESSION_ID || "");
  if (!s) return { ok: false, reason: "no-session-env" };
  const safe = s.replace(/[^a-zA-Z0-9_-]/g, "");
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const valid = (a) => !!(a && a.claudeSession === s && typeof a.ts === "string" && Number.isFinite(Date.parse(a.ts)));
  let a = safe ? readJson(path.join(ACTIVE_DIR, safe + ".json")) : null;
  if (!valid(a)) { const g = readJson(path.join(BRIDGE_DIR, "active.json")); a = valid(g) ? g : null; }
  if (!a) return { ok: false, reason: "anchor-unreadable" };
  return { ok: true, campaignId: "cl:" + s + ":" + a.ts };
}
// history append+trim — 반드시 카운터 잠금 '안에서만' 호출(같은 임계구역·순서 고정: ①append ②current 교체).
// crash 중복은 '같은 campaignId가 마지막 줄이면 그 줄을 최신 레코드로 갱신'(3차 [보완]: skip 서술은 옛 구현 —
// skip이면 더 큰 count가 은폐돼 복원이 상한을 되감는다). trim 판단 필드=Date.parse(record.updatedAt)
// (5차 [주의]: trimVerdicts의 o.ts를 문자 복제하면 전 줄 NaN=영구 보존 오구현) — NaN=보존+경고 계수,
// 미래 시각=보존(시계 보정 관용). 재작성은 같은 잠금 아래 atomicWrite(무잠금 직접 rewrite 복제 금지).
function appendCampaignHistoryLocked(ws, rec) {
  const hf = campaignHistoryFileFor(ws);
  let raw = "";
  try { raw = fs.readFileSync(hf, "utf8"); }
  catch (e) {
    if (!e || e.code !== "ENOENT") return { readFailed: true }; // 2차 B4': 판독 실패를 '신규'로 축소하면 기존 이력을 빈 파일로 원자 교체해 유실 — 교체 중단 신호
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  let lastId = null;
  if (lines.length) { try { lastId = JSON.parse(lines[lines.length - 1]).campaignId; } catch { /* 손상 줄 — 보존 */ } }
  // 같은 캠페인이 마지막 줄이면 '최신 레코드로 갱신'(2차 B1': skip만 하면 더 큰 count가 은폐돼 복원이 상한을
  // 되감음). crash 재시도(동일 레코드)는 자기 자신으로의 갱신이라 중복도 없다.
  if (lastId === rec.campaignId) lines[lines.length - 1] = JSON.stringify(rec);
  else lines.push(JSON.stringify(rec));
  const cutoff = Date.now() - CAMPAIGN_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  let warn = 0;
  const kept = lines.filter((l) => {
    let t = NaN; try { t = Date.parse(JSON.parse(l).updatedAt); } catch { /* 파싱 불가 줄 → NaN */ }
    if (!Number.isFinite(t)) { warn++; return true; } // 무효 시각=보존(침묵 삭제 금지)+경고 계수(호출자가 안내 1줄로 가시화)
    return t >= cutoff; // 미래 시각 포함 보존
  });
  const writeFailed = !atomicWrite(hf, kept.length ? kept.join("\n") + "\n" : "");
  return { warn, writeFailed }; // writeFailed=이 append가 유실됨 — 호출자는 교체를 중단해 이전 캠페인 레코드를 보존해야 한다(1차 B4)
}
// 교대 복귀 캠페인 조회(1차 B1 — '카운터 초기화 금지'의 물질화): history를 끝에서부터 훑어 같은 campaignId의
// 최신 레코드를 찾는다. 반드시 카운터 잠금 안에서만 호출. A→B→A 교대(멀티 창 등)에서 복귀 캠페인이
// count=0으로 리셋돼 상한을 우회하는 경로를 닫는다(count·동결 budget·startedAt 복원).
function findCampaignInHistory(ws, campaignId) {
  let raw = "";
  try { raw = fs.readFileSync(campaignHistoryFileFor(ws), "utf8"); }
  catch (e) { return (!e || e.code !== "ENOENT") ? { readFailed: true } : null; } // 2차 B4': 판독 실패≠부재 — count 0 재시작으로 축소 금지
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let o = null; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o && o.campaignId === campaignId && Number.isInteger(o.count) && o.count >= 0 && Number.isInteger(o.budget) && o.budget >= 0) return o;
  }
  return null;
}
// 예약(임계구역 전체 — 판독·비교·증가·history·교체를 <wsKey>.json.lock 하나에서):
//  ⑴ 오프바이원 확정: next=count+1; 유한 예산이고 next>M이면 '증가 없이 거부'(rejected). next==M이면 예고(last).
//  ⑵ 기록 순서·권위: ①next 계산·거부 판정 ②persistFn(정본 영수증 — [내구] job patch/[직접] 로컬 예약)
//     성공 시에만 ③counter 기록. ②실패=예약 취소(counter 미증가·호출은 untracked 진행),
//     ③실패=counterFailedAfterReceipt(호출자가 budgetUntracked 승격+N/M 표시 억제).
//  ⑶ budget(M)은 캠페인 최초 예약 시점 동결 — 같은 캠페인 중 설정 변경은 다음 캠페인부터.
//  ⑷ 손상 카운터=원자 격리(corrupt 서랍·원문 보존)+새 캠페인+quarantined 플래그. 격리 실패=미집계.
//  ⑸ 잠금 실패=미집계(untracked:"lock")·ask 진행 — 검증 접근 차단이 더 해로움.
function reserveVerifyCampaign(ws, campaignId, budget, persistFn) {
  if (typeof campaignId !== "string" || !campaignId) return { tracked: false, untracked: "no-campaign" };
  const M0 = Number.isInteger(budget) && budget >= 1 ? budget : 0;
  const file = campaignFileFor(ws);
  try { fs.mkdirSync(CAMPAIGN_DIR, { recursive: true }); } catch { /* 잠금/쓰기에서 드러남 */ }
  const r = withFileLockStrict(file + ".lock", () => {
    let cur = null, quarantined = false;
    let raw = null;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (e) { if (!e || e.code !== "ENOENT") return { tracked: false, untracked: "counter-unreadable" }; }
    if (raw !== null) {
      let o = null; try { o = JSON.parse(raw); } catch { o = null; }
      const okShape = !!(o && typeof o === "object" && !Array.isArray(o) && o.schema === "vcamp-1" && typeof o.campaignId === "string" && o.campaignId && Number.isInteger(o.count) && o.count >= 0 && Number.isInteger(o.budget) && o.budget >= 0);
      if (okShape) cur = o;
      else {
        try {
          fs.mkdirSync(CAMPAIGN_CORRUPT_DIR, { recursive: true });
          fs.renameSync(file, path.join(CAMPAIGN_CORRUPT_DIR, wsKeyFor(ws) + "-" + Date.now() + ".json"));
          quarantined = true;
        } catch { return { tracked: false, untracked: "counter-corrupt-unquarantined" }; }
      }
    }
    const nowIso = new Date().toISOString();
    let M = M0, count = 0, startedAt = nowIso, historyWarn = 0;
    const switching = !(cur && cur.campaignId === campaignId);
    if (!switching) { M = cur.budget; count = cur.count; startedAt = cur.startedAt || nowIso; }
    else {
      const back = findCampaignInHistory(ws, campaignId); // 1차 B1: 교대 복귀 — history에서 count·동결 budget 복원
      if (back && back.readFailed) return { tracked: false, untracked: "history-read-failed" }; // 2차 B4': 복원 불능=미집계(count 0 재시작 금지)
      if (back) { M = back.budget; count = back.count; startedAt = back.startedAt || nowIso; }
    }
    // 2차 B1' 순서 재배열: 거부·영수증 실패는 history·current를 '건드리기 전에' 반환 — 거부된 교체 시도가
    // history에 옛 레코드를 남겨 dedupe·복원을 오염시키던 경로 제거(교체는 진행 확정 후에만).
    const next = count + 1;
    if (M >= 1 && next > M) return { tracked: false, rejected: true, count, budget: M, campaignId, quarantined };
    if (typeof persistFn === "function" && persistFn(next, M, campaignId) !== true)
      return { tracked: false, untracked: "receipt-persist-failed", count, budget: M, campaignId, quarantined };
    if (switching && cur) {
      const h = appendCampaignHistoryLocked(ws, cur); // 진행 확정 — ①history(이전 캠페인 보존) ②current 교체 순서 고정
      if (h.readFailed) return { tracked: false, untracked: "history-read-failed", counterFailedAfterReceipt: true, budget: M, campaignId, quarantined };
      if (h.writeFailed) return { tracked: false, untracked: "history-write-failed", counterFailedAfterReceipt: true, budget: M, campaignId, quarantined }; // 1차 B4: 교체 중단(current 불변)
      historyWarn = h.warn;
    }
    if (!atomicWrite(file, JSON.stringify({ schema: "vcamp-1", campaignId, count: next, budget: M, startedAt, updatedAt: nowIso })))
      return { tracked: false, untracked: "counter-write-failed", counterFailedAfterReceipt: true, n: next, budget: M, campaignId, quarantined };
    return { tracked: true, n: next, budget: M, campaignId, last: M >= 1 && next === M, quarantined, historyWarn };
  });
  if (!r.ok) return { tracked: false, untracked: "lock" };
  return r.result;
}

// ── P-12 2c 기계 판독 딱지(설계 동결 5왕복 v2~v5) ─────────────────────────────────
// 검증자 답의 '판정 줄 바로 앞' 구조화 지적 블록을 기계가 판독해 ①판정↔blocker 정합 확인(불일치·파싱
// 실패=보류 강등 fail-closed·비차단 있는 깨끗한 통과=통과(보완) 상향 정정) ②[백로그] 자동 장부 등록.
// proof·raw answer·rollout은 불변 — 강등은 판정·경보 계층(footer·flagVerdict·통계 메타)만(proof=실행 영수증 계약 유지).
const FINDINGS_MARKERS = {
  ko: { start: "[지적 목록 v1]", end: "[지적 목록 끝]" },
  en: { start: "[findings v1]", end: "[findings end]" },
};
// 태그 정규화: en 동의어→ko 정본. 미지 태그=null(손상).
function normFindingTag(t) {
  const s = typeof t === "string" ? t.trim().toLowerCase() : "";
  if (s === "blocker") return "blocker";
  if (s === "주의" || s === "caution") return "주의";
  if (s === "보완" || s === "notes") return "보완";
  if (s === "백로그" || s === "backlog") return "백로그";
  return null;
}
// 순수 판독기 — 구조만 반환(id·ws 무관). corrupt 진단은 원문 비복사 계약: {count, items:[{lineNo, reasonKey}]}만
// (reasonKey∈bad-json|not-object|bad-tag|bad-title|bad-file|marker — 손상 줄에 비밀값이 있어도 어디로도 전파 안 됨).
// 문법(동결 C-2): 마커=행 전체 정확 일치·시작/종료 같은 언어 쌍·'마지막 시작 마커' 뒤 정확히 1개의 종료 마커·
// 종료 마커 뒤에는 빈 줄 제외 판정 선언 1줄만 허용·그 이후 잔여 마커(미완·중복)=ok:false·ok:false면 자동 등록 0건.
function parseFindingsBlock(text) {
  const out = { present: false, ok: false, findings: [], corrupt: { count: 0, items: [] }, tailVerdictLine: "" };
  const lines = String(text || "").split(/\r?\n/);
  const isStart = (l) => l === FINDINGS_MARKERS.ko.start || l === FINDINGS_MARKERS.en.start;
  const isEnd = (l) => l === FINDINGS_MARKERS.ko.end || l === FINDINGS_MARKERS.en.end;
  let s = -1;
  for (let i = 0; i < lines.length; i++) if (isStart(lines[i])) s = i;
  if (s < 0) return out;
  out.present = true;
  const langEnd = lines[s] === FINDINGS_MARKERS.ko.start ? FINDINGS_MARKERS.ko.end : FINDINGS_MARKERS.en.end;
  const bad = (lineNo, reasonKey) => { out.corrupt.count++; out.corrupt.items.push({ lineNo, reasonKey }); };
  // 마지막 시작 마커 뒤의 모든 마커 줄 수집 — 정확히 1개여야 하고 같은 언어의 종료 마커여야 한다.
  const after = [];
  for (let i = s + 1; i < lines.length; i++) if (isStart(lines[i]) || isEnd(lines[i])) after.push(i);
  if (after.length !== 1 || lines[after[0]] !== langEnd) {
    for (const i of after) bad(i + 1, "marker");
    if (!after.length) bad(s + 1, "marker"); // 종료 마커 자체가 없음
    return out; // ok:false — 목록 전체 불신(부분 수용 금지)
  }
  const e = after[0];
  // 본문 행: 줄당 JSON 1개 — plain object만(배열·중첩 file 거부), title=비공백 문자열, file=부재 또는 문자열.
  for (let i = s + 1; i < e; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { bad(i + 1, "bad-json"); continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { bad(i + 1, "not-object"); continue; }
    const tag = normFindingTag(o.tag);
    if (!tag) { bad(i + 1, "bad-tag"); continue; }
    if (typeof o.title !== "string" || !o.title.trim() || /[\r\n\u2028\u2029]/.test(o.title)) { bad(i + 1, "bad-title"); continue; } // '1줄' 계약 — JSON \n 디코딩 다행 제목 거부(구현검증 1차 blocker②)
    if (o.file !== undefined && typeof o.file !== "string") { bad(i + 1, "bad-file"); continue; }
    out.findings.push({ tag, title: o.title.trim(), file: typeof o.file === "string" ? o.file : "" });
  }
  // 종료 마커 뒤: 빈 줄 제외 '판정 선언 1줄'만 허용(그 외 본문·잉여 줄=marker 손상). 그 선언 줄을 tailVerdictLine으로
  // 보존한다 — 정합 판정은 이 '블록 뒤 판정'에만 결속(블록 앞 본문의 옛 판정 줄을 전체 재판독으로 재사용하면
  // 위치 결속이 깨짐 — 구현검증 1차 blocker①). 선언이 없으면 tailVerdictLine=""(정합기에서 no-verdict-line 강등).
  let declSeen = 0;
  for (let i = e + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    if (extractVerdict(ln) !== null && declSeen === 0) { declSeen = 1; out.tailVerdictLine = ln.trim(); continue; }
    bad(i + 1, "marker");
  }
  out.ok = out.corrupt.count === 0;
  return out;
}
// 정합 판정(동결 C-1 행렬) — 적용 게이트(core 프로필)는 호출자가 건다. verdict=extractVerdict 결과(null 허용).
// 반환 effective∈pass|pass-notes|inconclusive|fail. 강등=보류(fail-closed), 유일한 상향 정정=통과→통과(보완).
function judgeMachineVerdict(verdict, parse) {
  const keep = (v) => ({ effective: v, demoted: false, corrected: false, reasonKey: "" });
  const demote = (k) => ({ effective: "inconclusive", demoted: true, corrected: false, reasonKey: k });
  if (verdict === "inconclusive") return keep("inconclusive"); // 보류 선언은 '블록 상태 무관' 고유 의미 유지(행렬 정본 — 부재/손상 검사보다 선행: 이미 보류인 답에 강등 footer·경보를 덧씌우지 않음 · 구현검증 2차 blocker②)
  if (!parse || !parse.present) return demote("block-missing");
  if (!parse.ok) return demote("block-corrupt");
  if (verdict === null) return demote("no-verdict-line");
  const blockers = parse.findings.filter((f) => f.tag === "blocker").length;
  const nonblock = parse.findings.length - blockers;
  if (blockers >= 1) return verdict === "fail" ? keep("fail") : demote("pass-with-blocker");
  if (verdict === "fail") return demote("fail-without-blocker"); // blocker 0인데 실패 선언
  if (nonblock >= 1 && verdict === "pass") return { effective: "pass-notes", demoted: false, corrected: true, reasonKey: "pass-with-notes" }; // 상향 정정(처리 의무 약화 차단)
  return keep(verdict); // 빈 블록=통과 정합·통과(보완)는 유지 관용(항목 0개 보완 의무=공집합)
}
// 자동 등록 제목 민감 방어(동결 D-2 v5) — 원칙: 열거가 아니라 형태 '일반형'·오탐은 수동 폴백이 흡수(안전 방향).
// 거부 시 호출자는 제목 원문을 장부·경고·통계·무결성 detail 어디에도 복사하지 않는다(항목 순번·태그만 노출).
const AUTO_TITLE_BOUNDARY = "(^|[\\s\"'`“”‘’()\\[\\]{}<>=:,;])";
const AUTO_TITLE_RULES = [
  { reasonKey: "control", re: /[\u0000-\u001f\u007f]/ },
  { reasonKey: "path", re: /[A-Za-z]:[\\/]/ },                                        // 드라이브 경로
  { reasonKey: "path", re: /\\\\/ },                                                   // UNC(\\server\share·\\?\ 장경로 포함)
  { reasonKey: "path", re: new RegExp(AUTO_TITLE_BOUNDARY + "//[^\\s/]+/[^\\s]") },    // //host/share
  { reasonKey: "path", re: new RegExp(AUTO_TITLE_BOUNDARY + "/[^\\s/]+/[^\\s]") },     // 유닉스 절대경로 일반형(/root/x·/etc/passwd — 세그먼트 2+)
  { reasonKey: "path", re: new RegExp(AUTO_TITLE_BOUNDARY + "~[^\\s]*/") },            // 물결 홈(~/·~계정/)
  { reasonKey: "email", re: /[^\s@]+@[^\s@]+\.[^\s@]{2,}/ },
  { reasonKey: "token", re: /\beyJ[A-Za-z0-9_-]{8,}/ },                                // JWT
  { reasonKey: "token", re: /\bAKIA[0-9A-Z]{8,}/ },
  { reasonKey: "token", re: /\bghp_[A-Za-z0-9]{8,}/ },
  { reasonKey: "token", re: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { reasonKey: "token", re: /\bxox[a-z]?-[A-Za-z0-9-]{8,}/ },
  { reasonKey: "token", re: /[A-Za-z0-9+/=_-]{32,}/ },                                 // 32+ 연속 base64/hex 덩어리
];
// 제목·file 공용 스캐너(7·8차 blocker — 대칭 강제): 원문 전체 규칙 검사 → 유효 %HH가 있으면 해독본도 같은
// 규칙으로 재검사 → 해독 불능·해독 후 %HH 잔존(다중·손상 인코딩)=보수 거부 'encoded'(오탐=수동 폴백 흡수).
// includePathRules=false면 경로 형태 규칙 제외(file은 경로가 정상 — 절대경로 최소화는 normBacklogFile 담당).
function backlogAutoScan(s, includePathRules) {
  const check = (v) => { for (const r of AUTO_TITLE_RULES) { if (!includePathRules && r.reasonKey === "path") continue; if (r.re.test(v)) return r.reasonKey; } return ""; };
  let k = check(s);
  if (k) return k;
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    let d;
    try { d = decodeURIComponent(s); } catch { return "encoded"; }
    k = check(d);
    if (k) return k;
    if (/%[0-9A-Fa-f]{2}/.test(d)) return "encoded";
  }
  return "";
}
function safeBacklogAutoTitle(title) {
  const k = backlogAutoScan(String(title || ""), true);
  return k ? { ok: false, reasonKey: k } : { ok: true, reasonKey: "" };
}
// file 필드용 민감 방어(구현검증 2차 blocker③·8차 대칭 통일): 비경로 비밀형(토큰·이메일·제어문자)+인코딩
// fail-closed — 상대경로에 %HH를 겹쳐 감춘 비밀형도 제목과 같은 규칙으로 거부된다.
function safeBacklogAutoFile(file) {
  const s = String(file || "");
  if (!s) return { ok: true, reasonKey: "" };
  const k = backlogAutoScan(s, false);
  return k ? { ok: false, reasonKey: k } : { ok: true, reasonKey: "" };
}

function appendVerdict(ev) {
  try {
    fs.mkdirSync(STATS_DIR, { recursive: true });
    fs.appendFileSync(VERDICTS_FILE, JSON.stringify(ev) + "\n", "utf8");
    trimVerdicts(60); // 추가 후 오래된·깨진 줄 정리(검증당 1회, 파일 작아 부담 적음)
    return true;
  } catch { return false; } // best-effort — 통계 실패가 검증 흐름을 막지 않음
}
// ids="all"이면 전체, 배열이면 그 id들만 ack 처리(확인함). 확장이 호출.
function ackIntegrityEvents(ids) {
  return withIntegrityLock(() => {
    const events = readIntegrityEvents();
    const set = ids === "all" || !ids ? null : new Set(ids);
    for (const e of events) { if (!set || set.has(e.id)) e.ack = true; }
    return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events }));
  });
}
// 같은 세션의 직전 특정 kind 신호를 '새 결과가 나왔으니' 대체(supersede)한다. verdict는 누적이 아니라 '최신 상태'다 —
// 한 턴에 실패→수정→통과로 해소되면 직전 실패/보류 노랑도 사라져야 한다(반복 검증이 무조건 노랑을 남기는 cry-wolf 방지).
// 미확인(ack 안 됨) + 같은 session + 같은 kind인 것만 제거한다(확인한 것·다른 세션·다른 kind는 보존). 세션 미상이면 안 건드림.
// ws(선택·3축 감사 blocker 2026-07-19): C-C 실행은 CLAUDE_CODE_SESSION_ID가 없어 세션 폴백이 전역 active의
// '다른 프로젝트' 세션을 집을 수 있다 — 그 세션+kind만으로 지우면 프로젝트 B의 검증이 프로젝트 A의 미확인
// 경보를 삭제한다. ws를 주면 '그 워크스페이스 이벤트'만 supersede(다른 ws 이벤트 보존·workspace 없는 구
// 이벤트=기존 동작대로 대상). 미전달=기존 동작(다른 호출처 무회귀).
function supersedeIntegrity(session, kind, ws) {
  if (!session && !ws) return false; // 세션·ws 둘 다 모르면 섣불리 안 지움 — 다른 대화의 신호를 잘못 지우지 않게
  const wsN = ws ? normWs(ws) : "";
  return withIntegrityLock(() => {
    const events = readIntegrityEvents();
    // ws가 있으면 '그 프로젝트' 기준으로 갱신(판정 경보는 프로젝트 단위 최신 1건 — C-C 세션 폴백이 창마다
    // 달라져도 같은 프로젝트의 해소된 경보가 잔존하지 않음 · 확인 검증 blocker). workspace 없는 구 이벤트만
    // 세션 기준 유지. ws 미전달=기존 세션 기준(다른 호출처 무회귀).
    const hit = (e) => !e.ack && e.kind === kind && (wsN
      ? (e.workspace ? normWs(e.workspace) === wsN : (!!session && e.session === session))
      : e.session === session);
    const kept = events.filter((e) => !hit(e));
    if (kept.length === events.length) return true; // 지울 것 없음(무변경 성공)
    return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events: kept }));
  });
}

// ── 검증 파이프라인 라이브 단계 ───────────────────────
// phase ∈ claude-working | codex-verifying | rejudging | done | incomplete. 확장이 이걸 + 코덱스 rollout 성장 +
// staleness로 사용자에게 진행을 보여준다(토큰 스트림 아님, 파일변화 기반 ≈1초). extra로 round/session/workspace 등 병합.
function readPhase() {
  try { return JSON.parse(fs.readFileSync(PHASE_FILE, "utf8")) || {}; } catch { return {}; }
}
function writePhase(phase, extra) {
  const data = Object.assign({ round: 0 }, readPhase(), { phase, ts: new Date().toISOString() }, extra || {});
  return atomicWrite(PHASE_FILE, JSON.stringify(data));
}

// 워크스페이스 정규화 — 확장(src/extension.ts)·브릿지(codex-bridge.js)와 반드시 동일 규칙이어야 함.
function normWs(p) {
  // NFC: 환경별 유니코드 폼(NFC/NFD) 차이로 같은 경로가 다른 키 되는 것 방지. 브릿지·확장 3카피 '동일 규칙'이어야 함.
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
}
// ── P-9 자동 전환(질문 호스트 기준) 안전 판정 ─────────────────────────────────────────────
// 활성 검증 작업 존재 = 전환 금지 신호: 모드가 바뀌면 진행 중 내구 job이 완료 시점 stale로 무효화된다
// (codex-bridge writeProof의 모드 검사). 손상 job 파일은 '활성 아님'으로 취급 — 손상 1개가 전환을 영구
// 차단하면 안 되고, 손상 job 자체는 P-4의 몫. 마감(deadlineAt)이 1분 이상 지난 잔재도 차단 근거로 안 쓴다.
function activeAskJobFor(ws) {
  try {
    const dir = path.join(BRIDGE_DIR, "ask-jobs");
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      if (!j || (j.state !== "queued" && j.state !== "running")) continue;
      if (normWs(j.workspace) !== normWs(ws)) continue;
      const dl = Date.parse(j.deadlineAt || "");
      if (Number.isFinite(dl) && dl < now - 60000) continue;
      return { id: j.id || f.replace(/\.json$/, ""), state: j.state };
    }
  } catch { /* 디렉터리 부재 = 활성 없음 */ }
  // 직접 ask(ask-active) — 동결 조건 ⑶은 내구 job만이 아니라 ask-active도 요구(구현검증 1차 지적 1).
  // 부모/자식 프로세스가 '살아 있는' 실행만 활성으로 본다: abandoned(둘 다 사망)는 전환으로 무효화될 실행이
  // 없고, 그 상태의 재전송 차단은 askActiveGuard 자신의 몫(명시 clear 전 보수 차단)이라 전환까지 막지 않는다.
  try {
    const rec = readAskActive(ws);
    if (rec) {
      const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
      if (alive(rec.pid) || alive(rec.childPid)) return { id: "ask-active", state: "direct-ask" };
    }
  } catch { /* 판독 실패 = 활성 없음 취급(손상은 P-4 몫) */ }
  return null;
}
// 상대 호스트 턴이 '진행 중일 개연성' 판정 — phase.json은 마지막 기록자 파일이라 정확한 턴 신호가 아니고
// (성공 종료도 rejudging으로 남는 별도 결함 있음), 신선도 창(기본 25분 — 대시보드 stale 숨김 상한과 동일)
// 을 씌운 보수 휴리스틱이다. 같은 세션(session===sid)의 흔적은 '상대'가 아니므로 호출자가 걸러야 한다.
function phaseBusy(ws, phases, maxAgeMs) {
  try {
    const p = readPhase();
    if (!p || !phases.includes(p.phase)) return null;
    if (normWs(p.workspace || "") !== normWs(ws)) return null;
    const ts = Date.parse(p.ts || "");
    if (!Number.isFinite(ts) || Date.now() - ts > (maxAgeMs || 25 * 60 * 1000)) return null;
    return { phase: p.phase, session: String(p.session || "") };
  } catch { return null; }
}

// [P-9 3차 지적 3 → 4차 지적 3] 계약 잠금 상태 진단 — 저장 실패 시 '어떤 파일·어떤 프로세스·어떤 상태'인지
// 정확히 안내. 상태 분리(4차): alive(생존—재시도) / dead(ESRCH 확정 사망—삭제 안내 허용) /
// owner-unverified(EPERM 등—타 사용자 프로세스일 수 있어 삭제 금지) / invalid(토큰 손상—삭제 금지) /
// unreadable(판독 실패—삭제 금지) / null(파일 없음—잠금 문제 아님). 삭제 안내는 dead에만 허용:
// kill(pid,0)의 모든 예외를 사망으로 합치면 활성 저장의 잠금을 사용자가 지우도록 오도한다(실행 반증).
function contractLockIssue(ws, lang) {
  const lockPath = contractFileFor(ws, lang) + ".lock";
  let raw;
  try { raw = fs.readFileSync(lockPath, "utf8"); }
  catch (e) { return (e && e.code === "ENOENT") ? null : { state: "unreadable", lockPath, pid: 0 }; }
  const m = /^(\d+)-/.exec(String(raw).trim());
  if (!m) return { state: "invalid", lockPath, pid: 0 };
  const pid = parseInt(m[1], 10);
  try { process.kill(pid, 0); return { state: "alive", lockPath, pid }; }
  catch (e) { return { state: (e && e.code === "ESRCH") ? "dead" : "owner-unverified", lockPath, pid }; }
}

// 프로젝트별 계약 파일 경로. 키 = normWs의 sha1 앞 16자(파일명 안전·플랫폼 무관). 확장 contractFileFor와 동일.
// 언어 슬롯: ko = 레거시 <키>.json '그대로'(기존 사용자 규칙 무회귀·마이그레이션 불필요) / en = <키>.en.json.
// → 언어를 나눠도 기존 파일을 재명명/이동하지 않는다(비파괴). lang 미지정 시 전역 언어(loadLang()).
function contractFileFor(ws, lang) {
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  const l = LANGS.includes(lang) ? lang : loadLang();
  return path.join(CONTRACTS_DIR, key + (l === "ko" ? "" : "." + l) + ".json");
}
// 호출 측(contract-inject·verify-guard·codex-bridge)이 도는 Claude 작업 폴더(=execCwd, 실제 실행 위치).
function currentWs() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
// ★configWs: '이 대화가 연 폴더'(설정 기준). 사용자가 VS Code에서 연 폴더에 건 계약·두뇌설정·링크가, 작업이
// 외부/다른 cwd에서 돌아도 일관 적용되게 한다. 해석 우선순위:
//  1) CLAUDE_PROJECT_DIR(명시 override)
//  2) 세션별 active(active/<claudeSession>.json) — 다른 창이 단일 active.json을 덮어써도 '이 대화'의 연 폴더를 직접 읽음(멀티창 레이스 없음)
//  3) 레거시 단일 active.json — claudeSession==이 세션일 때만(멀티창 오집 방지)
//  4) 폴백 cwd(무회귀).
// 세션ID 일치가 핵심 가드 — 멀티창에서 다른 대화의 active를 잘못 집지 않는다. opts로 훅(session_id·cwd) 주입 가능(verify-guard용).
function configWs(opts) {
  opts = opts || {};
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const sid = opts.sessionId || process.env.CLAUDE_CODE_SESSION_ID || "";
  if (sid) {
    // 2순위: 세션별 active. 파일명=sid이지만 내용 claudeSession도 한 번 더 확인(손상/오기록 방어). 파일명은 traversal 방지로 안전 문자만.
    const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, "");
    if (safe) {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, safe + ".json"), "utf8"));
        if (a && a.claudeSession === sid && typeof a.workspace === "string" && a.workspace.trim()) return a.workspace;
      } catch { /* 세션별 파일 없음/불일치 → 레거시/폴백 */ }
    }
    // 3순위: 레거시 단일 active.json — 이 세션 것일 때만(claudeSession 일치). 멀티창 오집 방지.
    try {
      const a = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "active.json"), "utf8"));
      if (a && a.claudeSession === sid && typeof a.workspace === "string" && a.workspace.trim()) return a.workspace;
    } catch { /* active 없음/파싱불가 → 폴백 */ }
  }
  // Codex 구현자 경로: 공식 훅 session_id와 도구 프로세스의 CODEX_THREAD_ID가 동일하다. 세션별 파일을
  // 우선해 여러 Codex 창이 있어도 다른 프로젝트 active를 집지 않는다. 실제 작업 cwd가 다른 폴더여도 이 앵커 유지.
  const codexSid = opts.codexSessionId || process.env.CODEX_THREAD_ID || "";
  if (codexSid) {
    const safe = String(codexSid).replace(/[^a-zA-Z0-9_-]/g, "");
    if (safe) try {
      const a = JSON.parse(fs.readFileSync(path.join(CODEX_ACTIVE_DIR, safe + ".json"), "utf8"));
      if (a && a.codexSession === codexSid && typeof a.workspace === "string" && a.workspace.trim()) return a.workspace;
    } catch { /* 폴백 cwd */ }
    // 플러그인/확장 재설치 직후처럼 active 앵커가 아직 없더라도, 대시보드가 이미 이 세션을 구현 역할로
    // 고정했다면 그 연결이 더 강한 프로젝트 정본이다. 실제 작업 cwd로 떨어져 다른 계약을 읽고 훅 전체가
    // 무동작하는 복구 실패를 막는다. 여러 프로젝트에 잘못 중복 연결된 경우는 임의 선택하지 않고 cwd로 폴백.
    try {
      const links = JSON.parse(fs.readFileSync(LINKS_FILE_SHARED, "utf8"));
      const matches = [];
      for (const [key, rec] of Object.entries((links && links.byWorkspace) || {})) {
        if (rec && rec.implementerSession === codexSid) matches.push(String(rec.workspace || key || ""));
      }
      const unique = [...new Set(matches.filter(Boolean).map((x) => normWs(x)))];
      if (unique.length === 1) return matches.find((x) => normWs(x) === unique[0]) || unique[0];
    } catch { /* 링크 없음/손상 → cwd 폴백 */ }
    // 새 Codex 대화에는 아직 session_id 앵커가 없다. 이때 현재 cwd가 프로젝트 폴더 또는 그 프로젝트가
    // 명시한 실제 작업 저장소(scoutRepo) 안에 있으면 논리 프로젝트를 역추적한다. 정확히 한 프로젝트만
    // 일치할 때만 채택해, 한 실제 저장소를 여러 프로젝트가 공유하는 모호한 경우의 오귀속을 막는다.
    try {
      const cwd = path.resolve(opts.cwd || process.cwd());
      const matches = [];
      const projects = new Map();
      const contains = (root, child) => {
        const rel = path.relative(path.resolve(root), child);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      };
      // 연결이 이미 있으면 links가 가장 싼 색인이다.
      try {
        const links = JSON.parse(fs.readFileSync(LINKS_FILE_SHARED, "utf8"));
        for (const [key, rec] of Object.entries((links && links.byWorkspace) || {})) {
          const logical = String((rec && rec.workspace) || key || "");
          if (logical) projects.set(normWs(logical), logical);
        }
      } catch { /* 최초 연결 전일 수 있음 */ }
      // 최초 verifier/implementer 연결 전에도 대시보드가 저장한 계약의 workspace 필드가 논리 프로젝트 정본이다.
      // 파일명은 해시라 역산할 수 없으므로 내용의 workspace만 읽고, 없는 레거시 계약은 오귀속 없이 건너뛴다.
      try {
        for (const ent of fs.readdirSync(CONTRACTS_DIR, { withFileTypes: true })) {
          if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
          try {
            const saved = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, ent.name), "utf8"));
            const logical = typeof saved?.workspace === "string" ? saved.workspace.trim() : "";
            if (logical) projects.set(normWs(logical), logical);
          } catch { /* 다른 계약 계속 */ }
        }
      } catch { /* 계약 폴더 없음 */ }
      for (const logical of projects.values()) {
        if (!logical) continue;
        let contract;
        try { contract = loadContract(logical); } catch { continue; }
        if (contract.harnessMode !== "codex-codex") continue;
        const roots = [logical];
        try {
          const mapped = resolveScoutRepo(logical, contract).repo;
          if (mapped && !roots.some((x) => normWs(x) === normWs(mapped))) roots.push(mapped);
        } catch { /* 논리 프로젝트 경로만 비교 */ }
        if (roots.some((root) => contains(root, cwd))) matches.push(logical);
      }
      const unique = [...new Map(matches.map((x) => [normWs(x), x])).values()];
      if (unique.length === 1) return unique[0];
    } catch { /* 역추적 불가/모호 → cwd 폴백 */ }
  }
  return opts.cwd || process.cwd();
}

function codexActiveFileFor(sessionId) {
  const safe = String(sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return safe ? path.join(CODEX_ACTIVE_DIR, safe + ".json") : "";
}
function writeCodexActive(sessionId, ws, extra) {
  if (!sessionId || !ws) return false;
  const payload = Object.assign({ schema: "codex-active-v1", codexSession: sessionId, workspace: ws, ts: new Date().toISOString() }, extra || {});
  const file = codexActiveFileFor(sessionId);
  const a = file && atomicWrite(file, JSON.stringify(payload));
  const b = atomicWrite(CODEX_ACTIVE_FILE, JSON.stringify(payload));
  return !!(a && b);
}
function readCodexActive(sessionId) {
  const file = sessionId ? codexActiveFileFor(sessionId) : CODEX_ACTIVE_FILE;
  try { const o = JSON.parse(fs.readFileSync(file, "utf8")); return o && typeof o === "object" ? o : null; } catch { return null; }
}

// Snapshot immediately before a hook performs the slower rollout identity read. The later
// role-locked CAS prevents an older event that finishes late from overwriting a newer chat.
function codexRoleRevision() {
  try { return Number((JSON.parse(fs.readFileSync(LINKS_FILE_SHARED, "utf8")) || {}).roleRevision) || 0; }
  catch { return 0; }
}
function codexImplementerSnapshot(ws, roleRevision, eventStartedAt) {
  if (!ws) return { session: "", revision: 0, roleRevision: Number(roleRevision) || 0, eventStartedAt: Number(eventStartedAt) || 0 };
  try {
    const o = JSON.parse(fs.readFileSync(LINKS_FILE_SHARED, "utf8")) || {};
    const key = normWs(ws);
    const found = Object.keys(o.byWorkspace || {}).find((k) => normWs(k) === key);
    const cur = found ? (o.byWorkspace[found] || {}) : {};
    return { session: String(cur.implementerSession || ""), revision: Number(cur.implementerRevision) || 0, roleRevision: arguments.length >= 2 ? (Number(roleRevision) || 0) : (Number(o.roleRevision) || 0), eventStartedAt: Number(eventStartedAt) || 0 };
  } catch { return { session: "", revision: 0, roleRevision: Number(roleRevision) || 0, eventStartedAt: Number(eventStartedAt) || 0 }; }
}
function codexImplementerSession(ws) { return codexImplementerSnapshot(ws).session; }

// Codex 구현자 역할 자동등록. VS Code의 SessionStart 또는 실제 프롬프트로 확인된 현재 대화가 구현 역할을 넘겨받는다.
// 하네스가 세션을 새로 만들거나 임의 후보를 고르는 경로가 아니라 UserPromptSubmit의 실제 session_id만
// 쓰므로, 검증 세션 자동생성 안전규칙과는 별개다. verifier와 같은 세션만 자기검증 방지로 거부한다.
function registerCodexImplementer(ws, sessionId, model, effort, expectedSession, hookTurnId) {
  if (!ws || !sessionId) return { ok: false, reason: "missing" };
  const enforceCas = arguments.length >= 5;
  return withRoleLock(() => {
    // P-1: 손상 links.json을 {}로 축소해 전체 덮어쓰면 다른 워크스페이스 연결·verifier 링크·설정이 통째로
    // 유실된다(훅이 매 프롬프트 자동 호출이라 다음 대화가 유실 트리거). 부재(ENOENT)만 신규 파일로 인정,
    // 손상·판독 실패는 기록 거부(fail-closed — 손상 바이트 보존, 복구 기회 유지).
    let raw = null;
    try { raw = fs.readFileSync(LINKS_FILE_SHARED, "utf8"); }
    catch (e) { if (!(e && e.code === "ENOENT")) return { ok: false, reason: "links-unreadable" }; }
    let o = {};
    if (raw !== null) {
      try { o = JSON.parse(raw); } catch { return { ok: false, reason: "links-corrupt" }; }
      // 의미 검증: null·배열·원시값 루트는 파싱 '성공'이라 구문 검사만으론 {}로 축소·덮어쓰기됨(P-1 반례).
      // 공용기(validLinksShape)에 ws까지 전달 — 현재 ws 레코드가 배열 등으로 손상이면 기록 거부(P-9 7차
      // 지적 2: Stop 판독은 corrupt인데 등록은 손상 레코드를 새 객체로 덮어쓰는 불일치+바이트 보존 위반).
      if (!validLinksShape(o, ws)) return { ok: false, reason: "links-corrupt" };
    }
    o.byWorkspace = o.byWorkspace || {};
    const key = normWs(ws);
    let foundKey = Object.keys(o.byWorkspace).find((k) => normWs(k) === key) || key;
    const cur = o.byWorkspace[foundKey] || {};
    if (cur.codexSession === sessionId || cur.codexCodexSession === sessionId) return { ok: false, reason: "verifier-conflict", existing: sessionId };
    const currentSession = String(cur.implementerSession || "");
    const currentRevision = Number(cur.implementerRevision) || 0;
    const currentRoleRevision = Number(o.roleRevision) || 0;
    const currentEventAt = Number(cur.implementerEventAt) || 0;
    const expectedIsSnapshot = !!expectedSession && typeof expectedSession === "object";
    const expectedId = expectedIsSnapshot ? String(expectedSession.session || "") : String(expectedSession || "");
    const expectedRevision = expectedIsSnapshot ? (Number(expectedSession.revision) || 0) : currentRevision;
    const expectedRoleRevision = expectedIsSnapshot ? (Number(expectedSession.roleRevision) || 0) : currentRoleRevision;
    const expectedEventAt = expectedIsSnapshot ? (Number(expectedSession.eventStartedAt) || 0) : Date.now();
    // 같은 대상 세션 이벤트는 revision·roleRevision 불일치에 한해 가환(시간 순서까지 무조건 가환 아님 —
    // eventAt 후행 거부는 같은 세션의 '옛' 이벤트 역행 보호로 유지). 스냅샷 이후 다른 세션이 역할을 가져갔으면
    // 이 이벤트는 stale — 아무것도 쓰지 않는다.
    // [경합 인계 예외 — 설계 동결 v3~v4(2026-07-19)] 확장 fallback이 '같은 후보 세션·같은 턴'을 먼저 기록한
    // 경우(implementerLinkSource=rollout-user-prompt+implementerTurnHint 일치)에만 eventAt 후행 거부를 면제하고
    // 늦게 재개된 훅이 정상 '합류'한다(fallback의 rollout promptTs가 훅 앵커를 앞질러 정당한 첫 프롬프트가
    // implementer-raced로 차단되던 경합 해소). 다른 턴·다른 세션·힌트 부재는 전부 기존 보호 그대로.
    const sameTurnJoin = enforceCas && currentSession === sessionId
      && cur.implementerLinkSource === "rollout-user-prompt"
      && !!hookTurnId && String(cur.implementerTurnHint || "") === String(hookTurnId);
    if (enforceCas && !sameTurnJoin && ((expectedEventAt && currentEventAt > expectedEventAt) || (currentSession !== sessionId && (currentSession !== expectedId || currentRevision !== expectedRevision || currentRoleRevision !== expectedRoleRevision)))) {
      return { ok: false, reason: "implementer-raced", existing: currentSession || null };
    }
    const same = cur.implementerSession === sessionId;
    const replaced = !!cur.implementerSession && !same;
    const next = Object.assign({}, cur, {
      workspace: ws,
      implementerSession: sessionId,
      implementerLinkedAt: same ? (cur.implementerLinkedAt || new Date().toISOString()) : new Date().toISOString(),
      implementerLastSeenAt: new Date().toISOString(),
      implementerRevision: currentRevision + 1,
      // 합류(sameTurnJoin) 시 eventAt='훅 자신의 anchor' — fallback이 넣은 rollout promptTs(훅 턴 기록 시각보다
      // ms 단위 후행 — P-6b 실측 200ms)가 max로 살아남아 turn-before-link ms 역전을 재발시키는 것 차단
      // ('턴 기록자=eventAt 기록자' 쌍 복원). 그 외는 기존 monotonic 유지.
      implementerEventAt: sameTurnJoin ? (expectedEventAt || Date.now()) : Math.max(currentEventAt, expectedEventAt || Date.now()),
      // 최초 자동 고정값을 기준선으로 유지한다. 이후 훅 입력으로 덮지 않아 실제 모델·추론 변경을 경고할 수 있다.
      // 구버전 링크에 effort가 없을 때만 같은 구현 세션의 첫 관측값으로 한 번 보충한다.
      implementerModel: same ? (cur.implementerModel || model || "") : (model || ""),
      // 같은 세션의 후속 훅 값으로 빈 기준선을 채우지 않는다. 훅 effort가 없던 최초 턴은 확장이
      // linkedAt 이후 '첫 실제 rollout'을 찾아 보충한다(후속 모델 변경이 기준선으로 둔갑하는 경합 차단).
      implementerEffort: same ? (cur.implementerEffort || "") : (effort || ""),
    });
    // 힌트 수명주기(설계 4차 ⑶): 모든 정상 훅 성공(합류·일반 등록 공통)=출처 'hook' 승격+턴 힌트 소거(1회성
    // 인계 — 이후 늦은 옛 훅이 예외를 재사용할 수 없음·연결 교체 시에도 잔존 0).
    next.implementerLinkSource = "hook";
    delete next.implementerTurnHint;
    if (foundKey !== key) delete o.byWorkspace[foundKey];
    o.byWorkspace[key] = next;
    o.roleRevision = currentRoleRevision + 1;
    const ok = atomicWrite(LINKS_FILE_SHARED, JSON.stringify(o, null, 2));
    return { ok, reason: ok ? (same ? "same" : replaced ? "relinked" : "linked") : "write-failed", existing: cur.implementerSession || null };
  });
}

// ── P-6: Codex-Codex 내구 검증의 '회수 영수증' 계약 (설계 v5.1 — 2026-07-14) ─────────────────
// 문제: 검증 결과를 회수하는 도구 호출 자체가 PostToolUse로 lastActionAt을 갱신해 proof를 영구
// 무효화(자기무효화 → '검증 미완 4라운드'). 해법: 시각 경합 대신 결속 체인 —
// job 생성 시 구현 컨텍스트(sid·turnId·revision)를 불변 동결 → proof가 그 스냅샷을 복사(v2, 기록
// 직전 같은 role lock 안에서 현재 상태 재검사) → ask-wait 성공 시 receipt(모든 필드 job/proof 복사,
// ts=job.finishedAt 결정론 — 동시 회수도 같은 바이트로 수렴) → Stop 게이트는 lastActionAt 없이
// proof·receipt·현재 역할·이벤트 turnId의 4중 결속으로 판정한다.
const CODEX_TURNS_DIR = path.join(BRIDGE_DIR, "codex-turns"); // codex-hook.js TURN_DIR과 같은 폴더(계약 공유)
const CODEX_RECOVERY_DIR = path.join(BRIDGE_DIR, "codex-recovery"); // 회수 영수증 — jobId 단위 파일
function safeStateName(s) { return String(s || "").replace(/[^0-9a-zA-Z._-]/g, "_"); }
function askJobIdOk(id) { return /^ask-[a-z0-9]+-[0-9a-f]{10}$/.test(String(id || "")); }
function recoveryReceiptFileFor(jobId) { return askJobIdOk(jobId) ? path.join(CODEX_RECOVERY_DIR, jobId + ".json") : ""; }
function proofFileForSession(sid) { return path.join(PROOFS_DIR, safeStateName(sid || "_nosession") + ".json"); }
function sha256Hex(buf) { return require("crypto").createHash("sha256").update(buf).digest("hex"); }

// links.json 1회 파싱에서 workspace 레코드를 꺼낸다(잠금은 호출자가 잡는다 — Stop·freeze가 같은 판독을 공유).
function implementerRecordOf(linksObj, ws) {
  const key = normWs(ws);
  const by = (linksObj && linksObj.byWorkspace) || {};
  const found = Object.keys(by).find((k) => normWs(k) === key);
  const cur = found ? (by[found] || {}) : null;
  if (!cur) return null;
  return {
    session: String(cur.implementerSession || ""),
    revision: Number(cur.implementerRevision) || 0,
    eventAt: Number(cur.implementerEventAt) || 0,
  };
}
// [P-9 5차 지적 3 → 6차 지적 3] links 의미 검증 공용기 — 루트·byWorkspace·bySession 컨테이너 검사(P-1
// register 검사와 동형) + ws를 주면 ★현재 워크스페이스의 레코드 값★까지 일반 객체인지 검사. 컨테이너만
// 보면 {byWorkspace:{현재키:[]}} 같은 한 단계 안쪽 손상이 빈 역할로 축소돼 원복·Stop 판독이 fail-open
// (실행 반증 — implementerRecordOf가 session:"" 반환). 검사 범위를 현재 ws 레코드로 한정하는 이유:
// 무관 프로젝트의 레코드 손상이 이 프로젝트의 Stop까지 전부 차단하는 교차 프로젝트 간섭 방지(6차 지적 1과
// 같은 패턴 — 판정은 로컬 상태만으로).
function validLinksShape(o, ws) {
  const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!plain(o)) return false;
  if (o.byWorkspace !== undefined && !plain(o.byWorkspace)) return false;
  if (o.bySession !== undefined && !plain(o.bySession)) return false;
  if (ws !== undefined && plain(o.byWorkspace)) {
    const key = normWs(ws);
    const found = Object.keys(o.byWorkspace).find((k) => normWs(k) === key);
    if (found !== undefined && !plain(o.byWorkspace[found])) return false;
  }
  return true;
}
// role lock 아래에서 links를 정확히 1회 읽어 레코드를 반환. 잠금 실패는 예외(fail-closed는 호출자 몫).
// '파일 없음'(구현자 미지정=정상)과 '판독·파싱·의미 실패'(손상=차단 대상)를 합타입으로 구분한다 — 손상을 빈
// 객체로 축소하면 Stop 게이트가 검증 없이 통과하는 fail-open이 된다(구현 검증 1차 지적·P-9 5차 지적 3).
function readImplementerRecordLocked(ws) {
  return withRoleLock(() => {
    let raw = null;
    try { raw = fs.readFileSync(LINKS_FILE_SHARED, "utf8"); }
    catch (e) { return (e && e.code === "ENOENT") ? { ok: true, record: null } : { ok: false, reason: "links-unreadable" }; }
    let o; try { o = JSON.parse(raw); } catch { return { ok: false, reason: "links-corrupt" }; }
    if (!validLinksShape(o, ws)) return { ok: false, reason: "links-corrupt" }; // 현재 ws 레코드 손상까지 검사(6차 지적 3)
    return { ok: true, record: implementerRecordOf(o, ws) };
  });
}
// codex-turns/<sid>.json 정확 판독 — 정확 키 집합·타입까지 검증(구현 검증 2차 지적 4: modified 누락 JSON이
// false로 평가돼 verifyMode=code 게이트를 건너뛰는 통로 차단). 턴 파일은 단명 내부 상태라 느슨 호환 실익 없음.
const CODEX_TURN_KEYS = ["schema", "turnId", "workspace", "startedAt", "lastActionAt", "modified", "permissionMode"];
function readCodexTurnStrict(sid, ws) {
  let o = null;
  try { o = JSON.parse(fs.readFileSync(path.join(CODEX_TURNS_DIR, safeStateName(sid) + ".json"), "utf8")); } catch { return { ok: false, reason: "turn-missing" }; }
  if (!exactKeys(o, CODEX_TURN_KEYS) || o.schema !== "codex-turn-v1") return { ok: false, reason: "turn-schema" };
  if (typeof o.turnId !== "string" || !o.turnId) return { ok: false, reason: "turn-id-empty" };
  if (normWs(String(o.workspace || "")) !== normWs(ws)) return { ok: false, reason: "turn-workspace" };
  if (!(Number(o.startedAt) > 0)) return { ok: false, reason: "turn-startedAt" };
  if (typeof o.modified !== "boolean" || !(Number(o.lastActionAt) >= 0) || typeof o.permissionMode !== "string") return { ok: false, reason: "turn-fields" };
  return { ok: true, turn: o };
}
// 계약 파일 판독 상태 — 부재(legacy 기본값=정상)와 '존재하는데 손상'(모드 권위 판정 불가=차단 대상)을 구분.
// loadContract는 손상을 기본 claude-codex로 축소해 C-C 훅 전체가 조용히 꺼진다(구현 검증 2차 지적 2).
function contractReadState(ws, lang) {
  const file = contractFileFor(ws || currentWs(), lang);
  let raw = null;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) { return (e && e.code === "ENOENT") ? "absent" : "corrupt"; }
  try { const o = JSON.parse(raw); return o && typeof o === "object" && !Array.isArray(o) ? "ok" : "corrupt"; } catch { return "corrupt"; }
}
// 미회수 판정용: job에 결속된 '유효한' 영수증이 실존하는가 — 존재만 보면 빈 파일·타 내용 영수증을 회수 완료로
// 오인해 이전 proof를 덮을 수 있다(구현 검증 2차 지적 3). 스키마·5필드 결속에 더해 현재 proof 원문과의
// 지문·시각 결속(proofTs·proofSha·ts=finishedAt·ts>=proofTs)까지 성립해야 회수 완료(3차 지적 1 — 임의
// proofTs/proofSha 영수증이 settled로 오인되는 반례 차단).
function receiptSettled(job) {
  const jr = durableJobSnapshotOk(job);
  if (!jr.ok) return false;
  let r = null;
  try { r = JSON.parse(fs.readFileSync(recoveryReceiptFileFor(job.id), "utf8")); } catch { return false; }
  if (!strictReceiptV1(r).ok) return false;
  if (!(r.jobId === job.id && r.implementerSession === job.implementerSession && r.turnId === job.implementerTurnId
    && Number(r.implementerRevision) === Number(job.implementerRevision) && normWs(r.workspace) === normWs(String(job.workspace || "")))) return false;
  if (r.ts !== job.finishedAt) return false;
  // 자체 불변식(역사적 분기 포함 — 4차 보완): 성공 job만 결제 대상이고 영수증 시각은 자기 proofTs보다 앞설 수 없다.
  if (job.state !== "succeeded" || job.exitCode !== 0) return false;
  if (!(Date.parse(r.ts) >= Date.parse(r.proofTs))) return false;
  // 현재 proof와의 지문 사슬 — 사례 분리(같은 턴 '순차 다중 검증'을 깨지 않기 위해):
  //  ① proof가 아직 이 job의 것 → 전체 결속(proofTs·proofSha·시각 순서) 요구. 위조 영수증으로 새 시작을
  //     허용시켜 이 proof를 덮는 공격(3차 지적 1)이 여기서 차단된다.
  //  ② proof가 이미 다른 job의 것(뒤이은 합법 검증이 덮음) → 이 영수증은 그 시점에 결속 검증을 통과해야만
  //     기록될 수 있었으므로 역사적 결제로 인정(재지문 불가). 위조로 이 상태를 만들려면 새 job 시작이
  //     필요한데, 그 시작 자체가 ①에서 막힌다.
  //  ③ proof 부재·손상 → 보호할 대상이 없으므로 결속 영수증만으로 결제 인정(영구 잠금 방지).
  let raw = null; try { raw = fs.readFileSync(proofFileForSession(job.implementerSession)); } catch { raw = null; }
  if (raw !== null) {
    let proof = null; try { proof = JSON.parse(raw.toString("utf8")); } catch { proof = null; }
    if (proof && strictProofV2(proof).ok && proof.jobId === job.id) {
      if (proof.turnId !== job.implementerTurnId || Number(proof.implementerRevision) !== Number(job.implementerRevision)
        || proof.implementerSession !== job.implementerSession || normWs(proof.workspace) !== normWs(String(job.workspace || ""))) return false;
      if (r.proofTs !== proof.ts || r.proofSha !== sha256Hex(raw)) return false;
      if (!(Date.parse(r.ts) >= Date.parse(proof.ts))) return false;
    }
  }
  return true;
}
// ask-start 시점 동결: ask-job lock '안'에서 호출된다(잠금 순서 고정 ask-job → role, 유일한 중첩 지점).
// 부재·중간 상태는 전부 거부(fail-closed) — 잘못된 상태에서 검증을 시작하지 않는다.
function freezeImplementerContext(ws) {
  let rec, turnRes;
  try {
    return withRoleLock(() => {
      let raw = null;
      try { raw = fs.readFileSync(LINKS_FILE_SHARED, "utf8"); }
      catch (e) { if (!(e && e.code === "ENOENT")) return { ok: false, reason: "links-unreadable" }; }
      let o = {};
      if (raw !== null) { try { o = JSON.parse(raw) || {}; } catch { return { ok: false, reason: "links-corrupt" }; } }
      rec = implementerRecordOf(o, ws);
      if (!rec || !rec.session) return { ok: false, reason: "no-implementer" };
      if (!(rec.revision > 0)) return { ok: false, reason: "no-revision" };
      if (!(rec.eventAt > 0)) return { ok: false, reason: "no-eventAt" }; // 부재=구버전/중간 상태 — 생략 금지(설계 v5.1)
      turnRes = readCodexTurnStrict(rec.session, ws);
      if (!turnRes.ok) return { ok: false, reason: turnRes.reason };
      // 링크 갱신 후 turn 기록 전의 창: 새 revision + 이전 turn 조합은 여기서 걸린다.
      if (!(Number(turnRes.turn.startedAt) >= rec.eventAt)) return { ok: false, reason: "turn-before-link" };
      return { ok: true, implementerSession: rec.session, implementerTurnId: turnRes.turn.turnId, implementerRevision: rec.revision };
    });
  } catch { return { ok: false, reason: "role-lock" }; }
}
// git 4상태 판독기(설계 v5.1 — 기존 dirty-mtime 판독기와 별도): 정상 git=HEAD OID / 명확한 non-git=null 허용 /
// 저장소인데 최초 커밋 전='no-head' 정상 상태 / 실행 부재·timeout·권한·손상=unreadable(차단).
function gitHeadState(ws) {
  const run = (args) => {
    try { return require("child_process").spawnSync("git", ["-c", "safe.directory=*", "-C", ws, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true }); }
    catch (e) { return { error: e }; }
  };
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error || inside.signal) return { state: "unreadable" };
  const insideOut = String(inside.stdout || "").trim();
  if (inside.status !== 0) {
    return /not a git repository/i.test(String(inside.stderr || "")) ? { state: "non-git" } : { state: "unreadable" };
  }
  if (insideOut !== "true") return { state: "non-git" };
  const head = run(["rev-parse", "--verify", "HEAD"]);
  if (head.error || head.signal) return { state: "unreadable" };
  const oid = String(head.stdout || "").trim();
  if (head.status === 0 && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) return { state: "git", oid };
  if (/(unknown revision|ambiguous argument|Needed a single revision|bad revision)/i.test(String(head.stderr || "") + String(head.stdout || ""))) return { state: "no-head" };
  return { state: "unreadable" };
}
// 정확 키 집합 검증기 — 초과·누락 키 전부 거부(설계 v3~v5: 확장 검사 수준이 아니라 별도 strict validator).
function exactKeys(o, keys) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  const ks = Object.keys(o);
  return ks.length === keys.length && keys.every((k) => ks.includes(k));
}
const PROOF_V2_KEYS = ["v", "implementerSession", "workspace", "ts", "codexSession", "exit", "status", "answerChars", "jobId", "turnId", "implementerRevision", "headState", "headOid"];
function strictProofV2(p) {
  if (!exactKeys(p, PROOF_V2_KEYS)) return { ok: false, reason: "proof-keys" };
  if (p.v !== 2) return { ok: false, reason: "proof-version" };
  if (typeof p.implementerSession !== "string" || !p.implementerSession) return { ok: false, reason: "proof-session" };
  if (typeof p.workspace !== "string" || !p.workspace) return { ok: false, reason: "proof-workspace" };
  if (!Number.isFinite(Date.parse(p.ts || ""))) return { ok: false, reason: "proof-ts" };
  if (p.exit !== 0 || p.status !== "success") return { ok: false, reason: "proof-status" };
  if (!(Number(p.answerChars) > 0)) return { ok: false, reason: "proof-answer" };
  if (!askJobIdOk(p.jobId)) return { ok: false, reason: "proof-jobId" };
  if (typeof p.turnId !== "string" || !p.turnId) return { ok: false, reason: "proof-turnId" };
  if (!(Number(p.implementerRevision) > 0)) return { ok: false, reason: "proof-revision" };
  if (!["git", "non-git", "no-head"].includes(p.headState)) return { ok: false, reason: "proof-headState" };
  if (p.headState === "git" ? !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(p.headOid || "")) : p.headOid !== null) return { ok: false, reason: "proof-headOid" };
  return { ok: true };
}
const RECEIPT_V1_KEYS = ["schema", "jobId", "implementerSession", "turnId", "implementerRevision", "workspace", "ts", "proofTs", "proofSha"];
function strictReceiptV1(r) {
  if (!exactKeys(r, RECEIPT_V1_KEYS)) return { ok: false, reason: "receipt-keys" };
  if (r.schema !== "cbx-recovery-v1") return { ok: false, reason: "receipt-schema" };
  if (!askJobIdOk(r.jobId)) return { ok: false, reason: "receipt-jobId" };
  if (typeof r.implementerSession !== "string" || !r.implementerSession) return { ok: false, reason: "receipt-session" };
  if (typeof r.turnId !== "string" || !r.turnId) return { ok: false, reason: "receipt-turnId" };
  if (!(Number(r.implementerRevision) > 0)) return { ok: false, reason: "receipt-revision" };
  if (typeof r.workspace !== "string" || !r.workspace) return { ok: false, reason: "receipt-workspace" };
  if (!Number.isFinite(Date.parse(r.ts || ""))) return { ok: false, reason: "receipt-ts" };
  if (!Number.isFinite(Date.parse(r.proofTs || ""))) return { ok: false, reason: "receipt-proofTs" };
  if (!/^[0-9a-f]{64}$/.test(String(r.proofSha || ""))) return { ok: false, reason: "receipt-proofSha" };
  return { ok: true };
}
// 내구 job의 불변 스냅샷 필드 정확 검사(C-C 전용 — 부재=구버전 job, 새 검증 필요).
function durableJobSnapshotOk(job) {
  if (!job || job.schema !== "ask-job-v1") return { ok: false, reason: "job-schema" };
  if (!askJobIdOk(job.id)) return { ok: false, reason: "job-id" };
  if (job.harnessMode !== "codex-codex") return { ok: false, reason: "job-mode" };
  if (typeof job.implementerSession !== "string" || !job.implementerSession) return { ok: false, reason: "job-session" };
  if (typeof job.implementerTurnId !== "string" || !job.implementerTurnId) return { ok: false, reason: "job-turnId" };
  if (!(Number(job.implementerRevision) > 0)) return { ok: false, reason: "job-revision" };
  return { ok: true };
}
// proof v2 기록(내구 C-C 전용) — 기록 '직전 재검사'와 기록이 같은 role-lock callback 안에서 끝난다(설계 v5.1).
// 현재 역할·turn이 job 스냅샷과 다르면 stale(기록 없이 실패) — '내구 성공'과 '현재 턴 사용가능'의 괴리 차단.
function writeDurableProofV2(ws, job, answer, codexSession) {
  const jr = durableJobSnapshotOk(job);
  if (!jr.ok) return { ok: false, reason: jr.reason };
  if (normWs(String(job.workspace || "")) !== normWs(ws)) return { ok: false, reason: "job-workspace" };
  const head = gitHeadState(ws);
  if (head.state === "unreadable") return { ok: false, reason: "git-unreadable" };
  try {
    return withRoleLock(() => {
      let o = {}; try { o = JSON.parse(fs.readFileSync(LINKS_FILE_SHARED, "utf8")) || {}; } catch { o = {}; }
      const rec = implementerRecordOf(o, ws);
      if (!rec || rec.session !== job.implementerSession || rec.revision !== Number(job.implementerRevision)) return { ok: false, reason: "stale-role" };
      const turnRes = readCodexTurnStrict(rec.session, ws);
      if (!turnRes.ok) return { ok: false, reason: turnRes.reason };
      if (turnRes.turn.turnId !== job.implementerTurnId) return { ok: false, reason: "stale-turn" };
      const proof = {
        v: 2,
        implementerSession: job.implementerSession,
        workspace: ws,
        ts: new Date().toISOString(),
        codexSession: String(codexSession || ""),
        exit: 0,
        status: "success",
        answerChars: (answer || "").length,
        jobId: job.id,
        turnId: job.implementerTurnId,
        implementerRevision: Number(job.implementerRevision),
        headState: head.state,
        headOid: head.state === "git" ? head.oid : null,
      };
      const file = proofFileForSession(job.implementerSession);
      if (!atomicWrite(file, JSON.stringify(proof))) return { ok: false, reason: "proof-write" };
      return { ok: true, file };
    });
  } catch { return { ok: false, reason: "role-lock" }; }
}
// 회수 영수증 기록(ask-wait의 succeeded 분기 전용). 모든 필드가 job/proof 복사값이고 ts=job.finishedAt이라
// 어떤 프로세스가 기록해도 raw bytes가 같다 — 동시 회수는 수렴, conflict는 진짜 불일치에서만.
function writeRecoveryReceipt(job) {
  const jr = durableJobSnapshotOk(job);
  if (!jr.ok) return { ok: false, reason: jr.reason };
  if (job.state !== "succeeded" || job.exitCode !== 0) return { ok: false, reason: "job-not-succeeded" };
  if (!Number.isFinite(Date.parse(job.finishedAt || ""))) return { ok: false, reason: "job-finishedAt" };
  const pf = proofFileForSession(job.implementerSession);
  let raw; try { raw = fs.readFileSync(pf); } catch { return { ok: false, reason: "proof-missing" }; }
  let proof; try { proof = JSON.parse(raw.toString("utf8")); } catch { return { ok: false, reason: "proof-parse" }; }
  const pv = strictProofV2(proof);
  if (!pv.ok) return { ok: false, reason: pv.reason };
  if (proof.jobId !== job.id) return { ok: false, reason: "bind-jobId" };
  if (proof.implementerSession !== job.implementerSession) return { ok: false, reason: "bind-session" };
  if (proof.turnId !== job.implementerTurnId) return { ok: false, reason: "bind-turnId" };
  if (Number(proof.implementerRevision) !== Number(job.implementerRevision)) return { ok: false, reason: "bind-revision" };
  if (normWs(proof.workspace) !== normWs(String(job.workspace || ""))) return { ok: false, reason: "bind-workspace" };
  if (!(Date.parse(job.finishedAt) >= Date.parse(proof.ts))) return { ok: false, reason: "finished-before-proof" };
  const receipt = {
    schema: "cbx-recovery-v1",
    jobId: job.id,
    implementerSession: job.implementerSession,
    turnId: job.implementerTurnId,
    implementerRevision: Number(job.implementerRevision),
    workspace: job.workspace,
    ts: job.finishedAt,
    proofTs: proof.ts,
    proofSha: sha256Hex(raw),
  };
  const expected = JSON.stringify(receipt);
  const file = recoveryReceiptFileFor(job.id);
  if (!file) return { ok: false, reason: "receipt-path" };
  let existing = null; try { existing = fs.readFileSync(file, "utf8"); } catch { /* 최초 기록 */ }
  if (existing !== null && existing !== expected) return { ok: false, reason: "receipt-conflict" };
  if (existing === expected) return { ok: true, file }; // 멱등 재회수
  const wrote = atomicWrite(file, expected);
  // 동시 회수 수렴: rename이 일시 실패해도 이미 같은 바이트가 있으면 성공(설계 v5.1 보완).
  let back = null; try { back = fs.readFileSync(file, "utf8"); } catch { /* 아래 판정 */ }
  if (back === expected) return { ok: true, file };
  return { ok: false, reason: wrote ? "receipt-readback" : "receipt-write" };
}
// Stop 게이트 판정기(codex-hook onStop 전용) — lastActionAt을 쓰지 않는다. 결속 체인 전체가 성립해야 통과.
// role 판독은 호출자가 role lock 아래 1회 파싱으로 얻은 값을 넘긴다(sameImplementer 이중 판독 ABA 제거).
function durableProofGate(opts) {
  const { ws, sid, eventTurnId, stateTurnId, roleRevision, since } = opts || {};
  if (typeof eventTurnId !== "string" || !eventTurnId) return { ok: false, reason: "event-turnId" }; // fail-closed(설계 v4-4)
  if (typeof stateTurnId !== "string" || !stateTurnId) return { ok: false, reason: "state-turnId" };
  if (eventTurnId !== stateTurnId) return { ok: false, reason: "turn-mismatch" };
  let raw; try { raw = fs.readFileSync(proofFileForSession(sid)); } catch { return { ok: false, reason: "proof-missing" }; }
  let proof; try { proof = JSON.parse(raw.toString("utf8")); } catch { return { ok: false, reason: "proof-parse" }; }
  const pv = strictProofV2(proof);
  if (!pv.ok) return { ok: false, reason: pv.reason };
  if (proof.implementerSession !== sid) return { ok: false, reason: "proof-session-mismatch" };
  if (proof.turnId !== eventTurnId) return { ok: false, reason: "proof-turn-mismatch" };
  if (Number(proof.implementerRevision) !== Number(roleRevision)) return { ok: false, reason: "proof-revision-mismatch" };
  if (normWs(proof.workspace) !== normWs(ws)) return { ok: false, reason: "proof-workspace-mismatch" };
  if (!(Date.parse(proof.ts) >= Number(since || 0))) return { ok: false, reason: "proof-stale" };
  const head = gitHeadState(ws);
  if (head.state === "unreadable") return { ok: false, reason: "git-unreadable" };
  if (head.state !== proof.headState) return { ok: false, reason: "head-state-changed" };
  if (head.state === "git" && head.oid !== proof.headOid) return { ok: false, reason: "head-oid-changed" }; // 커밋 은닉 차단
  let rraw; try { rraw = fs.readFileSync(recoveryReceiptFileFor(proof.jobId), "utf8"); } catch { return { ok: false, reason: "receipt-missing" }; }
  let receipt; try { receipt = JSON.parse(rraw); } catch { return { ok: false, reason: "receipt-parse" }; }
  const rv = strictReceiptV1(receipt);
  if (!rv.ok) return { ok: false, reason: rv.reason };
  if (receipt.jobId !== proof.jobId) return { ok: false, reason: "receipt-jobId-mismatch" };
  if (receipt.implementerSession !== sid) return { ok: false, reason: "receipt-session-mismatch" };
  if (receipt.turnId !== eventTurnId) return { ok: false, reason: "receipt-turn-mismatch" };
  if (Number(receipt.implementerRevision) !== Number(roleRevision)) return { ok: false, reason: "receipt-revision-mismatch" };
  if (normWs(receipt.workspace) !== normWs(ws)) return { ok: false, reason: "receipt-workspace-mismatch" };
  if (receipt.proofTs !== proof.ts) return { ok: false, reason: "receipt-proofTs-mismatch" };
  if (receipt.proofSha !== sha256Hex(raw)) return { ok: false, reason: "receipt-proofSha-mismatch" };
  if (!(Date.parse(receipt.ts) >= Date.parse(proof.ts))) return { ok: false, reason: "receipt-before-proof" };
  return { ok: true };
}

// 프로젝트별 계약을 읽는다. ★전역 상속 없음★ — 계약은 프로젝트 전용(최신성: 비우면 주입 0·바꾸면 그 프로젝트만 유지).
// 파일 없으면 빈 계약. ws 미지정 시 현재 폴더 기준. (전역 기본값/상속/복원은 별개 층인 base-directive.json만 — §5.3 2공간 분리.)
function loadContract(ws, lang) {
  const read = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const o = read(contractFileFor(ws || currentWs(), lang)) || {}; // CONTRACT_FILE(전역) 폴백 제거 — 미설정 프로젝트는 빈 계약(상속 X). lang=언어 슬롯(ko=레거시 파일)
  return {
    harnessMode: normHarnessMode(o),
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    // Codex↔Codex 슬롯은 기존 Claude↔Codex 슬롯과 분리한다. verifier는 최초 전환 시 기존 codex 규칙을
    // fallback으로 보여주되, 저장 후엔 codexVerifier가 독립 정본이다(모드 왕복 시 덮어쓰기 방지).
    codexImplementer: Array.isArray(o.codexImplementer) ? o.codexImplementer : [],
    codexVerifier: Array.isArray(o.codexVerifier) ? o.codexVerifier : (Array.isArray(o.codex) ? o.codex : []),
    // 체크리스트 강제: 기본 true(기존 동작 보존). 해제 시 규약만 주입.
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    codexImplementerChecklist: o.codexImplementerChecklist !== false,
    codexVerifierChecklist: o.codexVerifierChecklist !== false,
    // 검증 모드: off=꺼짐 / code=코드변경 시 / plancode=플랜확정(ExitPlanMode)+코드변경 시 / always=모든 턴.
    // 기본 off(opt-in). 구버전 verify:true는 code로 마이그레이션.
    verifyMode: normVerifyMode(o),
    verifyProfile: normVerifyProfile(o),   // P-12: CL-C 슬롯 검증 강도(부재=integrity)
    codexVerifyProfile: normCodexVerifyProfile(o), // P-12: C-C 슬롯(부재 시 verifyProfile 상속)
    verifyBudget: normVerifyBudget(o),         // P-12 2b: CL-C 왕복 예산(0=무제한)
    codexVerifyBudget: normCodexVerifyBudget(o), // P-12 2b: C-C 슬롯(부재=CL-C 상속)
    // [모드별 검증 스위치 분리 2026-07-15] verifyMode=CL-C 슬롯 / codexVerifyMode=C-C 슬롯.
    // 부재 시 normVerifyMode(o) '전체'로 fallback(원시 o.verifyMode 아님 — verify:true→code 레거시 호환 보존).
    // codexVerifier 규칙과 동일 전례: 최초엔 CL-C 값을 상속해 보여주고, 명시적 C-C 저장 후엔 독립 정본.
    codexVerifyMode: normCodexVerifyMode(o),
    // 사용자 계약 주입 시점: off / plan(플랜 모드일 때만) / always(기본·무회귀). 확장과 동일 규칙.
    claudeInjectMode: normInjectMode(o),
    codexInjectMode: normCodexInjectMode(o),
    // 트랙: off=2트랙(구현↔검증, 기본·무회귀) / on=3트랙(탐색 leg 켬 — 범위 장부 advisory. SCOPE-LEDGER.md).
    // 브릿지는 아직 미사용(확장 대시보드 전용)이나 스키마 정합을 위해 양쪽 normalize(한쪽만 빠지면 동작 갈림 — SCOUT-TRACK 교훈).
    scoutMode: normScoutMode(o),
    scoutGate: normScoutGate(o), // 게이트(⑥ 실험) — off|plan. 확장 saveContract는 이 필드를 보존해야 함(스키마 정합)
    scoutRepo: typeof o?.scoutRepo === "string" ? o.scoutRepo.trim() : "", // 정찰 대상 레포(P1 — cwd≠repo 해소). 빈 값=ws 그대로
  };
}

const HARNESS_MODES = ["claude-codex", "codex-codex"];
function normHarnessMode(o) {
  return o && HARNESS_MODES.includes(o.harnessMode) ? o.harnessMode : "claude-codex";
}

const VERIFY_MODES = ["off", "code", "plancode", "always"];
function normVerifyMode(o) {
  if (o && VERIFY_MODES.includes(o.verifyMode)) return o.verifyMode;
  if (o && o.verify === true) return "code"; // 레거시 호환
  return "off";
}
// C-C 슬롯 검증 스위치 — 유효 명시값 우선, 부재 시 CL-C 정규화 전체 재사용(설계검증 확정: 원시 폴백 금지).
function normCodexVerifyMode(o) {
  if (o && VERIFY_MODES.includes(o.codexVerifyMode)) return o.codexVerifyMode;
  return normVerifyMode(o);
}

// P-12 1단(설계 동결 v2.1): 검증 강도 프로필 — integrity=현행(넓은 탐색·기본), core=핵심(직접 영향 중심).
// '언제 검증하나'(verifyMode)와 독립인 '어떻게 검증하나' 축. 부재=integrity(무회귀), C-C 부재 시 CL-C 상속.
const VERIFY_PROFILES = ["integrity", "core"];
function normVerifyProfile(o) {
  if (o && VERIFY_PROFILES.includes(o.verifyProfile)) return o.verifyProfile;
  return "integrity";
}
function normCodexVerifyProfile(o) {
  if (o && VERIFY_PROFILES.includes(o.codexVerifyProfile)) return o.codexVerifyProfile;
  return normVerifyProfile(o); // C-C 전용값 없으면 CL-C 상속(codexVerifyMode와 동형 규칙)
}
// 실효 프로필: 현재 운용 모드의 슬롯 값.
function effectiveVerifyProfile(c) {
  return (c && c.harnessMode === "codex-codex") ? normCodexVerifyProfile(c) : normVerifyProfile(c);
}

// P-12 2b(설계 동결 v6 ⑴): 왕복 예산 — 1 이상 정수=상한, 그 외=무제한(0으로 정규화·무회귀).
// C-C 슬롯은 '부재'만 CL-C 상속 — 명시 정수 0은 '이 슬롯만 무제한'(구현검증 1차 B3: CL-C 유한+C-C 무제한을
// 표현할 유일한 값 — 0을 부재와 뭉개면 C-C 독립 무제한이 불가능해진다).
function normVerifyBudget(o) {
  const v = o && o.verifyBudget;
  return (typeof v === "number" && Number.isInteger(v) && v >= 1) ? v : 0;
}
function normCodexVerifyBudget(o) {
  const v = o && o.codexVerifyBudget;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
  if (v === 0) return 0; // 명시 무제한(상속 차단)
  return normVerifyBudget(o); // 부재·무효=상속
}
function effectiveVerifyBudget(c) {
  return (c && c.harnessMode === "codex-codex") ? normCodexVerifyBudget(c) : normVerifyBudget(c);
}

const INJECT_MODES = ["off", "plan", "always"];
function normInjectMode(o) {
  if (o && INJECT_MODES.includes(o.claudeInjectMode)) return o.claudeInjectMode;
  return "always"; // 기본=항상(무회귀). 누락 시 기존 동작 유지.
}
function normCodexInjectMode(o) {
  if (o && INJECT_MODES.includes(o.codexInjectMode)) return o.codexInjectMode;
  return "always";
}

const SCOUT_MODES = ["off", "on"];
function normScoutMode(o) {
  if (o && SCOUT_MODES.includes(o.scoutMode)) return o.scoutMode;
  return "off"; // 기본=2트랙(무회귀 — 미설정 프로젝트는 기존과 100% 동일)
}

// 탐색 게이트 — "plan"=플랜 확정 전 지도 preflight를 훅이 요구(scout-gate.js).
// 기본 승격(2026-07-09 사용자 결정): 3트랙(scoutMode on)에서는 미설정 기본이 "plan" — 재실측(관찰 일지 주입
// ablation) 70.5%가 사전등록 합격선 60%를 처음 넘었고, 차단 문구에 프로젝트별 관찰 신호(scoutHealthLine)를
// 함께 실어 전역 수치 맹신을 막는다(카드와 한 묶음 조건). 규칙 순서가 안전의 핵심:
//   ① scoutMode≠on → 무조건 off(게이트는 지도 전제 — 2트랙은 명시 plan이 남아 있어도 비활성: 완전 무회귀)
//   ② 3트랙에서 명시값(off|plan)은 그대로 존중(과거 CLI로 끈 프로젝트는 영원히 꺼짐)
//   ③ 3트랙 + 미설정 → plan(승격). normalize 층 기본값이라 계약 파일에 쓰지 않는다(명시화 오염 방지).
const SCOUT_GATES = ["off", "plan"];
function normScoutGate(o) {
  if (normScoutMode(o) !== "on") return "off";
  if (o && SCOUT_GATES.includes(o.scoutGate)) return o.scoutGate;
  return "plan";
}

// ── 정찰(3트랙) 프롬프트 — 태도층 슬롯 + 공용 preface + 서명(§6-11 P1·P4, 2026-07-09) ──
// 태도층(편집 가능·언어 슬롯별)과 형식 계약([탐색자 지시] — scope-package가 단일 출처·잠금)을 분리한다.
// preface 사본이 3벌(self 러너·deepseek-bridge·ab-retro)이던 것을 단일 출처화 — 단 ab-retro는 사전등록
// 실측(48.1%)과의 비교 안정성을 위해 '고정 문구'를 유지한다(사용자 수정·언어 미반영 — 해당 파일 주석 참조).
const SCOUT_FORMAT_VERSION = "f1"; // [탐색자 지시] 형식 계약 버전 — ①~⑥/high 구조가 바뀌면 올림(지도 메타 서명·통계 구분)
const SCOUT_BASE_DEFAULTS = "너는 '탐색자'다. 아래 꾸러미가 유일한 근거다 — 꾸러미 밖 추측으로 파일을 지어내지 마라. 꾸러미 끝의 [탐색자 지시] 형식을 정확히 따르라.";
const SCOUT_BASE_DEFAULTS_EN = "You are the 'scout'. The package below is your only evidence — do not invent files beyond it. Follow the [Scout directive] format at the end of the package exactly.";
function scoutBaselineDefaultFor(lang) { return (LANGS.includes(lang) ? lang : loadLang()) === "en" ? SCOUT_BASE_DEFAULTS_EN : SCOUT_BASE_DEFAULTS; }
function scoutBaselineFileFor(lang) {
  const l = LANGS.includes(lang) ? lang : loadLang();
  return path.join(BRIDGE_DIR, l === "ko" ? "scout-baseline.json" : ("scout-baseline." + l + ".json"));
}
function loadScoutBaseline(lang) {
  let o = {};
  try { o = JSON.parse(fs.readFileSync(scoutBaselineFileFor(lang), "utf8")); } catch { o = {}; }
  const D = scoutBaselineDefaultFor(lang);
  const text = o && typeof o.baseline === "string" && o.baseline.trim() ? o.baseline : D;
  return { text, overridden: text.trim() !== D.trim() };
}
function saveScoutBaseline(text, lang) { // 기본값과 같으면 오버라이드 파일 삭제(=초기화) — saveBaseDirective와 동일 규칙
  const D = scoutBaselineDefaultFor(lang);
  const file = scoutBaselineFileFor(lang);
  const v = typeof text === "string" ? text : "";
  try { fs.mkdirSync(BRIDGE_DIR, { recursive: true }); } catch { /* 아래 쓰기에서 판정 */ }
  if (!v.trim() || v.trim() === D.trim()) {
    try { fs.unlinkSync(file); } catch (e) { if (e && e.code !== "ENOENT") return false; }
    return true;
  }
  return atomicWrite(file, JSON.stringify({ baseline: v }, null, 2));
}
function resetScoutBaseline(lang) { return saveScoutBaseline("", lang); }
// 두 정찰(기본 Claude·DeepSeek) 공용 preface — 기본 정찰만 '도구 차단' 사실 문장을 덧붙임(API 모델은 도구가 원래 없어 그 문장이 성립 안 함 — D5 공정성 근거 유지).
function buildScoutPreface(arm, lang) {
  const en = (LANGS.includes(lang) ? lang : loadLang()) === "en";
  const toolNote = arm === "self" ? (en ? " (Tools are blocked for this call.)" : " (이 호출에서 도구는 차단되어 있다.)") : "";
  return loadScoutBaseline(lang).text + toolNote;
}
// 지도 메타 프롬프트 서명(P4) — 수정된 프롬프트로 만든 지도가 사전등록 실측(기본 프롬프트 48.1%)과 섞이지 않게 구분.
function scoutPromptSignature(lang) {
  const l = LANGS.includes(lang) ? lang : loadLang();
  const b = loadScoutBaseline(l);
  return { promptLang: l, baselineHash: crypto.createHash("sha1").update(b.text).digest("hex").slice(0, 12), baselineCustom: b.overridden, formatVersion: SCOUT_FORMAT_VERSION };
}

// ── 탐색(3트랙) 자동 지시(지시 주입형 — 사용자 승인 2026-07-06) ──
// 원리: 하네스는 '지도가 없거나 낡았다'는 사실을 매 턴 판정해 구현 Claude에게 갱신 '지시'만 넣는다(실행·전송은
// Claude가 수행 — 지도 꾸러미는 확장/훅이 직접 전송하지 않음. 단 3트랙 켤 때의 연결 점검 1회는 확장이 직접 트리거 — PRIVACY '예외 둘', 2026-07-09 정정). 재지시 억제는 시간이 아니라 '상태 서명'(지도 없음 | 최신 지도 이름):
// 같은 상태엔 딱 1회만 지시하고, 지도가 갱신되면 서명이 바뀌어 다음 낡음에 다시 1회(시간 상수 0 — 24h/15분류 재발 방지).
const SCOUTS_DIR = path.join(BRIDGE_DIR, "scouts");           // 지도 보관함(scripts/scout-store.js와 동일 규칙)
const SCOUT_ADVICE_DIR = path.join(BRIDGE_DIR, "scout-advice"); // 상태 서명 기억(프로젝트별 1파일)
function wsKeyFor(ws) { // 계약 키·지도 보관함 키와 반드시 동일 규칙(sha1(normWs) 앞 16자)
  return crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
}
// ── 정찰 대상(scoutRepo) 해석(P1 — 세션 폴더≠개발 레포 해소) ──────────────
// 계약의 scoutRepo(사용자 명시 지정)가 유효하면 정찰 계열(지도·꾸러미 대상·장부·확인신호·게이트)의 기준 경로가 된다.
// 검증·연결·계약의 '연 폴더' 앵커는 불변 — 정찰 계열만 재해석. 무효(삭제·비존재)면 ws로 폴백(fail-open — 정찰이 죽지 않게).
// git 여부는 여기서 판정하지 않음: 비-git 대상은 꾸러미 빌더가 무이력 모드로 정직 처리(기존 경로 그대로).
function resolveScoutRepo(ws, c) {
  try {
    let raw = c && typeof c.scoutRepo === "string" ? c.scoutRepo.trim() : "";
    let source = "contract";
    if (!raw) {
      // 반대 언어 슬롯 폴백(P1-④, 2026-07-10 감사): scoutRepo는 언어 '내용'(규칙·지침)이 아니라 '사실'(개발 레포
      // 위치)이라, ko에만 설정한 뒤 en으로 전환하면 정찰 축 전체가 세션 폴더로 조용히 회귀하던 결함. 현재 슬롯
      // 명시값이 항상 우선이고, 현재 슬롯이 비었을 때만 반대 슬롯 값을 빌린다(언어 슬롯 분리 원칙과 양립).
      try {
        const other = loadLang() === "en" ? "ko" : "en";
        const oo = JSON.parse(fs.readFileSync(contractFileFor(ws, other), "utf8"));
        if (oo && typeof oo.scoutRepo === "string" && oo.scoutRepo.trim()) { raw = oo.scoutRepo.trim(); source = "contract-other-lang"; }
      } catch { /* 반대 슬롯 없음 */ }
    }
    if (!raw) return { repo: ws, source: "ws" };
    if (!path.isAbsolute(raw)) return { repo: ws, source: "ws-fallback-invalid" }; // 상대경로 금지 — 훅·확장·CLI의 cwd가 제각각이라 기준이 흔들림(절대경로만 허용)
    const abs = path.resolve(raw);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { repo: abs, source };
    return { repo: ws, source: "ws-fallback-invalid" }; // 지정값이 사라짐 — 정직 표시(소비자가 고지 가능)
  } catch { return { repo: ws, source: "ws" }; }
}

// ── 정찰 대상 어긋남 자기진단(구조 해법 2026-07-10) ──────────────────────────
// 배경(실사고): 세션 폴더≠개발 레포인데 scoutRepo 미설정이면 정찰 축 전체(지도·지시·장부·확인신호)가 조용히
// 엉뚱한 폴더를 본다 — '설정을 아는 사용자'가 아니라 아무것도 모르는 사용자의 환경에서도 축이 스스로 어긋남을
// 발견해야 한다(사용자 제약: 임시처방·고지-only 금지). 신호원 = 검증 답의 실파일 인용이 속한 git 레포(브릿지가
// execCwd 기준으로 해석·수집 — ask 실행 폴더는 원인 그 자체라 신호원이 될 수 없음, Codex 설계검증 2026-07-10).
const SCOUT_TARGET_EVIDENCE_DIR = path.join(BRIDGE_DIR, "scout-target-evidence");
const EVIDENCE_KEEP = 10; // 최근 관측(ask 단위) 링버퍼 — 옛 습관이 새 판단을 지배하지 않게
function scoutEvidenceFileFor(ws) { return path.join(SCOUT_TARGET_EVIDENCE_DIR, wsKeyFor(ws) + ".json"); }
function readScoutTargetEvidence(ws) {
  try { const o = JSON.parse(fs.readFileSync(scoutEvidenceFileFor(ws), "utf8")); return o && Array.isArray(o.obs) ? o : { obs: [] }; } catch { return { obs: [] }; }
}
function appendScoutTargetEvidence(ws, obs) { // obs={ts, repos:[{repo(절대경로 — 수집 시 git root 검증됨), n}]}
  try {
    if (!ws || !obs || !Array.isArray(obs.repos) || !obs.repos.length) return false;
    const cur = readScoutTargetEvidence(ws);
    const next = { ...cur, obs: cur.obs.concat([obs]).slice(-EVIDENCE_KEEP) };
    delete next.advisedRepo; delete next.advisedTs; // 구형 단일 기억 필드 — 어떤 쓰기 경로든 정리(제안 재발 없는 프로젝트에 영구 잔존하던 Codex 반례)
    fs.mkdirSync(SCOUT_TARGET_EVIDENCE_DIR, { recursive: true });
    return atomicWrite(scoutEvidenceFileFor(ws), JSON.stringify(next));
  } catch { return false; } // 수집 실패가 ask 흐름을 못 막음
}
// 대상 폴더의 git 최상위(없으면 null) — 판정의 'git 정체성 비교' 재료. safe.directory=* 는 이 읽기 조회 1회 한정.
function gitTopLevelFor(dir) {
  try {
    const r = require("child_process").spawnSync("git", ["-c", "safe.directory=*", "-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    return r.status === 0 && String(r.stdout).trim() ? String(r.stdout).trim() : null;
  } catch { return null; }
}
// 판정(보수 — 표본 미달은 무주장): ①'유일한 최다 레포'가 있는 관측 ≥3(공동 1위는 모호 → 관측째 제외 — Codex 반례:
// 현재 1+타 1 동률 3회가 100% 점유로 오판) ②그중 ≥70%가 같은 레포 ③실존 ④경로 문자열이 아니라 git 정체성으로
// 비교(Codex 반례: 대상=worktree 하위 폴더, 증거=그 루트 → 같은 저장소인데 drift 오판): 대상의 git root와 같으면
// 일치, 대상이 git repo인데 증거가 그 '안'의 중첩 저장소면 자동 교정 금지(nested — 모노레포 오탐 방지),
// 대상이 비-git 부모이고 증거가 다른 곳이면 원래 의도대로 drift. opts.targetRoot로 주입 가능(테스트·소비자 캐시).
const DRIFT_MIN_OBS = 3, DRIFT_SHARE = 0.7;
function detectScoutTargetDrift(target, evidence, opts) {
  const o2 = opts || {};
  const ex = o2.existsFn || ((p) => { try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; } });
  const raw = (evidence && Array.isArray(evidence.obs) ? evidence.obs : []).filter((o) => o && Array.isArray(o.repos) && o.repos.length);
  const obs = raw.filter((o) => { // 유일한 최다 레포가 있는 관측만(동률=모호 → 제외)
    const sorted = o.repos.slice().sort((a, b) => ((b && b.n) | 0) - ((a && a.n) | 0));
    return sorted.length === 1 || ((sorted[0] && sorted[0].n) | 0) > ((sorted[1] && sorted[1].n) | 0);
  });
  if (obs.length < DRIFT_MIN_OBS) return { drift: false, reason: "sample", sample: obs.length };
  const tally = new Map();
  for (const o of obs) {
    const top = o.repos.slice().sort((a, b) => ((b && b.n) | 0) - ((a && a.n) | 0))[0];
    if (!top || typeof top.repo !== "string" || !top.repo) continue;
    const k = normWs(top.repo);
    const cur = tally.get(k) || { n: 0, display: top.repo };
    cur.n++; tally.set(k, cur);
  }
  let bestK = null, best = null;
  for (const [k, v] of tally) if (!best || v.n > best.n) { bestK = k; best = v; }
  if (!best) return { drift: false, reason: "sample", sample: obs.length };
  const share = best.n / obs.length;
  if (share < DRIFT_SHARE) return { drift: false, reason: "mixed", sample: obs.length };
  const tRoot = o2.targetRoot !== undefined ? o2.targetRoot : gitTopLevelFor(target);
  if (bestK === normWs(target) || (tRoot && bestK === normWs(tRoot))) return { drift: false, reason: "match", sample: obs.length };
  if (tRoot && (bestK + path.sep).startsWith(normWs(tRoot) + path.sep)) return { drift: false, reason: "nested", sample: obs.length }; // 대상 저장소 안의 중첩 저장소 — 자동 교정 금지
  if (!ex(best.display)) return { drift: false, reason: "gone", sample: obs.length };
  return { drift: true, repo: best.display, share, sample: obs.length, agree: best.n };
}

// ── 같은 검증 요청 중복 전송 차단(2026-07-10 실사고) ──────────────────────────
// 첫 호출이 3분29초 만에 원인미상 비정상 종료되자 구현모델이 원인 확인 없이 '전송 실패'로 오판, 동일 프롬프트를 재전송 → Codex가 같은
// 일을 중복 수행(실측: 동일 해시 2건). 구조 방어: 같은 내용의 ask가 '살아있는 프로세스'에서 아직 진행 중이면 두 번째 전송을 거부
// (--force-resend로만 강행). 판정 1차 기준은 pid 생존(정확) — TTL은 시계 이상·좀비 방어 보조. 판정은 순수 함수.
const ASKS_INFLIGHT_DIR = path.join(BRIDGE_DIR, "asks-inflight");
// 워크스페이스 전체 직렬화(2026-07-12 실사고): 요청 지문별 가드만으로는 A가 진행 중일 때 문구를 조금 바꾼 B가
// 통과한다. 특히 호출 창의 외부 timeout이 브릿지의 사용자 설정 timeout보다 짧으면, A가 실제로는 계속 실행 중인데
// 호출자가 실패로 오판해 B를 새 세션으로 보내는 고아 세션 폭증 경로가 된다. 따라서 hash별 가드보다 먼저 ws당
// 정확히 1개의 active 표식을 선점한다. 비정상 종료 잔재는 자동 회수하지 않는다 — 답이 rollout/대시보드에 이미
// 도착했을 수 있으므로, 사용자가 확인한 뒤 명시 clear해야 한다(재전송보다 보수적인 방향).
const ASK_ACTIVE_DIR = path.join(BRIDGE_DIR, "ask-active");
// TTL은 pid 생존 판정의 '보조'(좀비·pid 재사용 방어)일 뿐이며 검증 대기 최대치(60분)보다 커야 한다 —
// Codex 반례: 30분이면 살아있는 정상 장기 검증의 후반이 무방비.
const INFLIGHT_TTL_MS = 90 * 60 * 1000;
// 파일은 ws+요청 지문별 1개(동일 요청의 내구 추적용). 2026-07-12부터 실제 ask 진입은 별도 ws 전체
// ASK_ACTIVE_DIR이 먼저 직렬화하므로 다른 내용 병렬도 허용하지 않는다. 이 계층은 같은 요청 재전송의 2차 방어로 존치.
function askInflightFileFor(ws, hash) { return path.join(ASKS_INFLIGHT_DIR, wsKeyFor(ws) + "-" + String(hash || "") + ".json"); }
function askActiveFileFor(ws) { return path.join(ASK_ACTIVE_DIR, wsKeyFor(ws) + ".json"); }
function readAskActive(ws) {
  try { const r = JSON.parse(fs.readFileSync(askActiveFileFor(ws), "utf8")); return r && typeof r === "object" && !Array.isArray(r) ? r : null; }
  catch { return null; }
}
function askActiveGuard(rec, pidAlive) {
  if (!rec) return { block: false, reason: "none" };
  const alive = (pid) => Number.isInteger(pid) && pid > 0 && typeof pidAlive === "function" && !!pidAlive(pid);
  if (alive(rec.pid)) return { block: true, reason: "parent-alive", rec };
  if (alive(rec.childPid)) return { block: true, reason: "child-alive", rec };
  // 부모·자식이 모두 끝났어도 자동 재전송 금지. 부모가 결과를 수거하기 전에 죽었지만 Codex rollout에는 답이
  // 완료된 경우와 진짜 실패를 기계적으로 구분할 수 없다. 명시 clear 전까지 abandoned로 보수 차단한다.
  return { block: true, reason: "abandoned", rec };
}
function claimAskActive(ws, hash, mode) {
  const rec = { schema: "ask-active-v1", hash: String(hash || ""), mode: mode === "new" ? "new" : "resume", startedAt: new Date().toISOString(), pid: process.pid, childPid: null, sessionId: null, token: crypto.randomBytes(8).toString("hex") };
  const f = askActiveFileFor(ws);
  try { fs.mkdirSync(ASK_ACTIVE_DIR, { recursive: true }); }
  catch (e) { return { claimed: false, rec: null, error: "active-dir: " + String(e && e.message || e) }; }
  try { fs.writeFileSync(f, JSON.stringify(rec), { flag: "wx" }); return { claimed: true, rec }; }
  catch (e) {
    if (!(e && e.code === "EEXIST")) return { claimed: false, rec: null, error: "active-write: " + String(e && e.message || e) };
    for (let i = 0; i < 3; i++) { try { return { claimed: false, rec: JSON.parse(fs.readFileSync(f, "utf8")) }; } catch { /* 쓰는 중일 수 있어 재시도 */ } }
    return { claimed: false, rec: null, error: "active-unreadable" };
  }
}
function updateAskActive(ws, token, patch) {
  if (!token || !patch || typeof patch !== "object") return false;
  const f = askActiveFileFor(ws);
  try {
    const cur = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!cur || cur.token !== token || cur.pid !== process.pid) return false;
    return atomicWrite(f, JSON.stringify(Object.assign({}, cur, patch)));
  } catch { return false; }
}
function clearAskActive(ws, token, opts) {
  const f = askActiveFileFor(ws);
  try {
    const cur = JSON.parse(fs.readFileSync(f, "utf8"));
    const manual = !!(opts && opts.manual === true);
    if (!manual && (!token || cur.token !== token || cur.pid !== process.pid)) return false;
    if (manual && !(opts && opts.confirm === true)) return false;
    fs.unlinkSync(f); return true;
  } catch { return false; }
}
function askInflightGuard(rec, hash, nowMs, pidAlive) {
  if (!rec || rec.hash !== hash) return { block: false, reason: "none" };
  const alive = typeof pidAlive === "function" ? !!pidAlive(rec.pid) : false;
  if (!alive) return { block: false, reason: "dead" }; // 진짜 실패(프로세스 사망) 후 재시도 허용 — pid 생존이 1차 기준
  const age = nowMs - (Date.parse(rec.ts || "") || 0);
  if (!(age >= 0 && age < INFLIGHT_TTL_MS)) return { block: false, reason: "stale" }; // 좀비/pid 재사용 방어(보조)
  return { block: true, reason: "inflight", ts: rec.ts };
}
// 표식 선점(원자적 'wx' 생성 — 검사-후-기록 분리의 동시성 구멍 차단): 성공=선점, EEXIST=기존 레코드 반환.
// 소유 토큰(난수) 기록 — 해제는 자기 것(pid+token 일치)만(Codex 반례: 먼저 끝난 프로세스가 강행 요청 표식을 지움).
function claimAskInflight(ws, hash) {
  const rec = { hash, ts: new Date().toISOString(), pid: process.pid, token: crypto.randomBytes(8).toString("hex") };
  const f = askInflightFileFor(ws, hash);
  try { fs.mkdirSync(ASKS_INFLIGHT_DIR, { recursive: true }); } catch { /* 아래 wx가 실패로 알려줌 */ }
  try {
    fs.writeFileSync(f, JSON.stringify(rec), { flag: "wx" });
    // 기회적 청소 — .json만 대상(.reclaim 잠금 불침), 판독 실패 파일은 '쓰는 중'일 수 있어 mtime이 TTL보다
    // 오래된 경우에만 삭제(형제 정상 표식을 open→write 사이에 읽고 지우던 Codex 반례).
    try { for (const b of fs.readdirSync(ASKS_INFLIGHT_DIR)) { if (!b.endsWith(".json")) continue; const p2 = path.join(ASKS_INFLIGHT_DIR, b); try { const r2 = JSON.parse(fs.readFileSync(p2, "utf8")); if (!(Date.now() - (Date.parse(r2.ts || "") || 0) < INFLIGHT_TTL_MS)) fs.unlinkSync(p2); } catch { try { if (!(Date.now() - fs.statSync(p2).mtimeMs < INFLIGHT_TTL_MS)) fs.unlinkSync(p2); } catch { /* 무해 */ } } } } catch { /* 기회적 청소 실패 무해 */ }
    return { claimed: true, rec };
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // 다른 프로세스가 막 쓰는 극히 짧은 구간의 불완전 JSON — 즉시 재시도 3회, 그래도 판독 불가면 rec:null
      // (호출부는 null을 '진행 중'으로 보수 처리 — 죽은 표식처럼 덮어쓰면 동시 재시도 중복 구멍, Codex 반례).
      for (let i = 0; i < 3; i++) { try { return { claimed: false, rec: JSON.parse(fs.readFileSync(f, "utf8")) }; } catch { /* 재시도 */ } }
      return { claimed: false, rec: null };
    }
    return { claimed: true, rec }; // 표식 기록 실패(권한 등) — 가드만 비활성(ask 흐름 불침)
  }
}
// 죽은/만료 표식 회수 — 무조건 삭제→재선점은 '늦은 회수자가 승자의 새 표식(W1)까지 지우는' TOCTOU(Codex 반례).
// 절차: ①회수 잠금(.reclaim, wx — 잠금 승자만 진행, 잔존 잠금은 자동 해제 없이 차단[탈출구=--force-resend·수동 삭제]) ②잠금 아래 현재
// 레코드 재판독 — '관측했던 죽은 레코드(pid+token) 그대로'일 때만 삭제(그 사이 새 선점자·제3 정상 선점자면 중단)
// ③wx 재선점 ④잠금 해제. 진 쪽/중단 쪽은 호출부가 보수적으로 차단(--force-resend가 탈출구).
function reclaimAskInflight(ws, hash, deadRec) {
  const f = askInflightFileFor(ws, hash);
  const lock = f + ".reclaim";
  const myLock = { pid: process.pid, token: crypto.randomBytes(8).toString("hex"), ts: new Date().toISOString() };
  // 잠금은 wx 1회 — stale 잠금의 '자동' 강제 해제는 두지 않는다(Codex 반례: read→unlink→wx로는 죽은 잠금을
  // 두 회수자가 동시에 지우고 서로의 새 잠금까지 지워 임계 구역 이중 진입. 평면 파일시스템에서 원자적 소유권
  // 이전이 불가하므로 보수 선택 — 잔존 잠금은 차단으로 남고, 탈출구는 --force-resend[잠금 미경유]·수동 삭제).
  let locked = false;
  try { fs.writeFileSync(lock, JSON.stringify(myLock), { flag: "wx" }); locked = true; }
  catch { return { claimed: false, rec: null, reason: "lock-busy" }; }
  try {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) {
      // 판독 실패는 fail-closed(Codex 반례: EACCES류를 '사라짐'으로 오인해 삭제·재선점하면 중복 실행) —
      // 진짜 사라짐(ENOENT)만 회수 계속(그 표식은 이미 해제된 것 — 바로 선점 시도).
      if (!(e && e.code === "ENOENT")) return { claimed: false, rec: null, reason: "unreadable" };
    }
    if (cur && (!deadRec || cur.pid !== deadRec.pid || cur.token !== deadRec.token)) return { claimed: false, rec: cur, reason: "changed" }; // 새 선점자 보존
    try { fs.unlinkSync(f); } catch { /* 이미 없음 */ }
    return claimAskInflight(ws, hash);
  } finally {
    if (locked) { // 자기 잠금만 해제(토큰 일치 — 어떤 경위로든 주인이 바뀐 잠금을 옛 보유자가 지우는 것 방지)
      try { const lr = JSON.parse(fs.readFileSync(lock, "utf8")); if (lr && lr.token === myLock.token) fs.unlinkSync(lock); } catch { /* 무해 */ }
    }
  }
}
function overwriteAskInflight(ws, hash) { // --force-resend '전용'(의식적 강행) — 죽은 표식 회수는 reclaim이 담당
  const rec = { hash, ts: new Date().toISOString(), pid: process.pid, token: crypto.randomBytes(8).toString("hex") };
  try { fs.mkdirSync(ASKS_INFLIGHT_DIR, { recursive: true }); atomicWrite(askInflightFileFor(ws, hash), JSON.stringify(rec)); } catch { /* 무해 */ }
  return rec;
}
function clearAskInflight(ws, hash, token) {
  if (!token) return; // 소유 토큰 필수 — 계약을 함수 차원에서 고정(pid 재사용 오삭제 방지, Codex 보완)
  try {
    const f = askInflightFileFor(ws, hash);
    const r = JSON.parse(fs.readFileSync(f, "utf8"));
    if (r && r.hash === hash && r.pid === process.pid && r.token === token) fs.unlinkSync(f); // 자기 표식만 해제
  } catch { /* 이미 없음 */ }
}

// 최신 지도 상태: no-map(없음) / fresh(신선) / stale(지도 이후 변경 신호 — 낡음)
// / legacy-no-seeds(메타는 있으나 근거 파일 기록이 없어 신선도 판정 자체가 불가 — seedFiles 기록 도입 前 구버전 지도.
//   실사고 2026-07-08: codex-peek 7/6 지도가 이 케이스라 'fresh' 오판 → 자동 지시 영구 침묵 → 장부 점화 실패).
// 변경 신호 3종(2026-07-10 신선도 사각 해소 — seed 8개만 보던 것을 확장. 사각의 실증: 대상을 바로잡아도
// seed 밖 파일만 바뀌면 지시가 영영 침묵해 '일지가 늘 그대로'가 재발): ①seedChanged=지도 자신의 근거 파일(앞 8개)
// 변경 ②commitsAfter=메타 head 이후 새 커밋 수(메타에 head가 기록된 신형 지도만) ③dirtyChanged=작업트리 변경
// 파일 중 지도 ts 이후 mtime(seed 중복 제외). 비-git·git 실패·구형 메타는 해당 신호 0(무회귀·fail-open).
// 비-git 대상의 유계 변경 스캔(L1-C: 비-git 비-seed 미탐 해소) — 수집기(scope-package)와 같은 제외 규칙,
// 항목 상한·깊이 상한. '신호 존재'가 목적이라 changed가 상한(9)에 닿으면 조기 종료. complete=false는
// '전수 확인 못 함'(상한 도달/판독 실패) — 이때 changed 0을 fresh로 단정하면 같은 미탐이 남으므로(Codex)
// 호출자가 unknown으로 처리한다.
const NONGIT_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", "out", ".vscode", ".idea", "__pycache__", ".venv", "venv"]);
function nonGitChangedSince(root, ts, skipAbs, capEntries = 1500, maxDepth = 6) {
  let seen = 0, changed = 0, files = 0, complete = true;
  const skip = skipAbs || new Set();
  const walk = (dir, depth) => {
    if (changed >= 9 || seen >= capEntries) { complete = false; return; }
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { complete = false; return; }
    for (const it of items) {
      if (changed >= 9 || seen >= capEntries) { complete = false; return; }
      seen++;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (depth < maxDepth && !NONGIT_SKIP_DIRS.has(it.name) && !it.name.startsWith(".")) walk(abs, depth + 1);
        else if (depth >= maxDepth) complete = false; // 더 깊은 곳은 못 봤음
        continue;
      }
      if (skip.has(normWs(abs))) continue; // seed 자신은 seedChanged가 담당(중복 카운트 방지)
      files++;
      try { if (fs.statSync(abs).mtimeMs > ts) changed++; } catch { complete = false; } // 판독 실패=전수 확인 실패(무시하면 다른 신호 0일 때 거짓 fresh — Codex #6)
    }
  };
  walk(root, 0);
  return { changed, complete, files }; // files=본 파일 수(비-git 삭제 감지용 유계 인벤토리)
}
// 지도 형식 계약(품질 최소선 — L1-C: '판독 가능한데 알맹이 없음' 지도가 게이트를 통과하던 결함).
// 파싱 가능한 후보(high 항목 또는 ⑥ 후보)가 하나라도 있거나, 형식 구획 표기(①~⑥)가 보이면 유효.
// '영향 없음'을 정직하게 쓴 지도도 구획 표기는 있으므로 invalid가 아니다. 읽기 실패는 판정하지 않는다(fail-open).
function mapLooksValid(md) {
  const s = String(md || "");
  if (/[①②③④⑤⑥]/.test(s)) return true;
  try { if (extractMapHighlights(s, 24).length > 0 || extractMapPatches(s).length > 0) return true; } catch { /* 파서 실패 → 아래 판정 */ }
  return false;
}
// 상태: no-map | legacy-no-seeds | invalid(형식 계약 미충족) | unknown(전수 확인 불가 — fresh 단정 금지)
//      | stale | fresh. 성분: seedChanged / commitsAfter / dirtyChanged / historyLost(기록 기준 커밋 소실).
function scoutMapStatus(ws) {
  const dir = path.join(SCOUTS_DIR, wsKeyFor(ws));
  let bases = [];
  try { bases = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().reverse(); } catch { /* 보관함 없음 */ }
  const zero = { staleCount: 0, seedChanged: 0, commitsAfter: 0, dirtyChanged: 0, historyLost: 0 };
  if (!bases.length) return { state: "no-map", base: null, ...zero };
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, bases[0] + ".json"), "utf8")); } catch { /* 메타 없음 — 낡음 판정 불가 → fresh 취급(과잉 지시 방지) */ }
  // 품질(형식 계약): md가 '읽히는데' 형식 불명이면 invalid — fresh로 흘러 게이트·동봉이 빈 지도를 신뢰하는 것 차단.
  try {
    const md = fs.readFileSync(path.join(dir, bases[0] + ".md"), "utf8");
    // 단 메타의 저장 계층(highlights·mapPatches)에 내용이 있으면 invalid 아님 — md 파싱 0건이어도 저장분 폴백으로
    // 동봉이 존속하는 문서화된 경로(구형 지도 무회귀).
    const metaHasContent = (Array.isArray(meta.highlights) && meta.highlights.some((i) => i && typeof i.path === "string" && i.path.trim()))
      || (Array.isArray(meta.mapPatches) && meta.mapPatches.length > 0);
    if (!mapLooksValid(md) && !metaHasContent) return { state: "invalid", base: bases[0], ...zero };
  } catch { /* 읽기 실패 — 품질 판정 보류(fail-open: 아래 신선도 판정 계속) */ }
  const ts = Date.parse(meta.basisTs || meta.ts || "") || 0; // basisTs=꾸러미 수집 시점(지도가 본 입력) — AI 응답 대기(수 분) 중 변경을 놓치지 않게(Codex 반례). 구형 메타는 ts 폴백
  // legacy 판정은 '기록 자체가 없던 구버전'만 — seedFiles 속성 부재/비배열. 명시적 빈 배열([])은 최신 러너가
  // '변경 없는 작업트리'에서 정상적으로 만들 수 있는 형식이라 legacy가 아니다(Codex 반례 2026-07-08: 빈 배열을
  // 구버전으로 오판하면 방금 만든 지도에 '재생성 권고'를 반복하는 거짓 안내가 됨) → fresh 취급(판정 근거 없음=과잉 지시 방지).
  if (ts && !Array.isArray(meta.seedFiles)) return { state: "legacy-no-seeds", base: bases[0], ...zero };
  const seeds = (meta.seedFiles || []).slice(0, 8);
  let seedChanged = 0;
  // 삭제 판정 기준선: seedFiles에는 '지도 생성 당시 이미 삭제돼 있던 경로'(삭제 diff의 seed)도 들어간다 —
  // 무조건 '없음=지도 뒤 삭제'로 세면 새 지도가 즉시 stale(Codex 반례). 신형 메타(seedMissing 기록)만
  // '당시 존재했던 seed의 소실'을 변경으로 세고, 구형 메타는 옛 동작(제외 — 무회귀·과잉 지시 방지).
  const missingAtMap = new Set(Array.isArray(meta.seedMissing) ? meta.seedMissing : null);
  const hashes = meta.seedHashes && typeof meta.seedHashes === "object" ? meta.seedHashes : {};
  for (const s of seeds) {
    try {
      const abs = path.join(ws, s);
      const st0 = fs.statSync(abs);
      if (st0.mtimeMs <= ts) continue;
      // mtime이 새것이어도 내용 지문이 같으면 변경 아님(빌드 touch류 거짓 stale — L1-C). 지문은 예산(2MB) 이내
      // '전체' 해시만 기록돼 있고, 해시 도중 파일이 또 바뀌면(전후 stat 불일치) 보수적으로 변경으로 센다.
      if (typeof hashes[s] === "string" && st0.size <= 2 * 1024 * 1024) {
        try {
          const h = require("crypto").createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
          const st1 = fs.statSync(abs);
          if (st1.size === st0.size && st1.mtimeMs === st0.mtimeMs && h === hashes[s]) continue;
        } catch { /* 지문 비교 실패 → 변경으로 취급(보수) */ }
      }
      seedChanged++;
    } catch { if (Array.isArray(meta.seedMissing) && !missingAtMap.has(s)) seedChanged++; }
  }
  let commitsAfter = 0, historyLost = 0;
  const isGit = !!gitTopLevelFor(ws);
  if (ts && isGit && typeof meta.head === "string" && /^[0-9a-f]{7,40}$/i.test(meta.head) && !/^0+$/.test(meta.head)) {
    // 기록 기준 커밋의 '존재'부터 검사(L1-C: rev-list 실패를 0으로 삼키면 이력 재작성이 거짓 fresh).
    // 무이력 지도(head=0000000)는 검사 대상 아님. git 자체 부재는 isGit에서 이미 걸러짐.
    try {
      const sd = "safe.directory=" + String(ws).replace(/\\/g, "/");
      const ex = require("child_process").spawnSync("git", ["-c", sd, "-C", ws, "cat-file", "-e", meta.head + "^{commit}"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (ex.error) { /* git 실행 실패 — 신호 0(과잉 지시 방지) */ }
      else if (ex.status !== 0) historyLost = 1; // 저장소는 살아 있는데 기준 커밋이 없음 — 이력 재작성/교체 의심
      else {
        const r = require("child_process").spawnSync("git", ["-c", sd, "-C", ws, "rev-list", "--count", meta.head + "..HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true });
        if (r.status === 0) commitsAfter = Math.min(parseInt(String(r.stdout).trim(), 10) || 0, 999);
      }
    } catch { /* git 없음/실패 — 신호 0 */ }
  }
  let dirtyChanged = 0;
  let scanIncomplete = false;
  if (ts) {
    if (isGit) {
      const seedSet = new Set(seeds.map((s) => { try { return normWs(path.join(ws, s)); } catch { return s; } }));
      for (const e of changedEntriesFor(ws)) {
        const abs = path.join(ws, e.rel);
        if (seedSet.has(normWs(abs))) continue; // seed와 중복 카운트 방지
        if (/D/.test(e.code)) { dirtyChanged++; continue; } // 삭제는 mtime이 없음 — 상태 코드로 판정(Codex 반례)
        try { if (fs.statSync(abs).mtimeMs > ts) dirtyChanged++; } catch { dirtyChanged++; /* stat 실패(방금 사라짐 등)도 변경 신호 */ }
      }
    } else {
      // 비-git 대상: seed 8개 밖 변경이 영영 미탐이던 사각(L1-C) — 유계 스캔. seed 자신의 변경은 seedChanged가 담당.
      const seedSet = new Set(seeds.map((s) => normWs(path.join(ws, s))));
      const r = nonGitChangedSince(ws, ts, seedSet);
      dirtyChanged = r.changed;
      // 삭제 감지(Codex #6): 지도 생성 시 유계 인벤토리(nonGitFiles)가 있고 양쪽 스캔이 완전하면, 파일 수 감소=삭제 신호.
      const inv = meta.nonGitFiles && typeof meta.nonGitFiles === "object" ? meta.nonGitFiles : null;
      if (inv && inv.complete === true && r.complete && Number.isFinite(inv.n) && r.files < inv.n) dirtyChanged += (inv.n - r.files);
      if (!r.complete && r.changed === 0) scanIncomplete = true; // 신호 0인데 전수 확인 못 함 — fresh 단정 금지
    }
  }
  const staleCount = seedChanged + commitsAfter + dirtyChanged + historyLost;
  if (ts && staleCount > 0) return { state: "stale", base: bases[0], staleCount, seedChanged, commitsAfter, dirtyChanged, historyLost };
  if (scanIncomplete) return { state: "unknown", base: bases[0], staleCount: 0, seedChanged, commitsAfter, dirtyChanged, historyLost };
  return { state: "fresh", base: bases[0], staleCount: 0, seedChanged, commitsAfter, dirtyChanged, historyLost };
}
// 3트랙이고 지도가 없/낡았으며 이 상태에 아직 지시한 적 없으면 지시문 반환, 아니면 null. c=이미 로드된 계약(중복 로드 방지).
// 재지시 정책(2026-07-08 점화 보수): 같은 지도라도 낡음 '정도'가 커지면(2의 거듭제곱 버킷 1,2,4,8… 상승) 다시 1회 지시.
// 기억은 {state, base, maxBucket} — 버킷 하강(파일 삭제 등으로 staleCount 감소)은 재지시 안 함(스팸 방지·시간 상수 0).
// 구버전 기억({sig:"stale:<base>"})은 maxBucket=1로 해석(정도 진행 시 재지시 — 마이그레이션 의도 그대로).
function scoutBucket(n) { let b = 1; while (b * 2 <= n) b *= 2; return n > 0 ? b : 0; } // 1,2,4,8,… (n<1이면 0)
function buildScoutDirective(ws, c) {
  if (!ws || normScoutMode(c) !== "on") return null;
  const rs = resolveScoutRepo(ws, c); // P1: 정찰 계열은 계약 지정 대상 기준(지도 상태·재지시 기억·명령 경로 전부)
  const target = rs.repo;
  // ⓪ 대상 어긋남 자기진단이 신선도보다 '먼저'(Codex 설계검증 지적 2026-07-10: 엉뚱한 대상의 지도가 fresh면
  // 아래 조기 반환에 막혀 어긋남 지시가 영영 안 나감). 같은 제안엔 1회만 — 기억은 증거 파일의 advisedKeys(언어|현재 대상|제안 대상 키·상한 20).
  try {
    const ev = readScoutTargetEvidence(ws);
    const drift = detectScoutTargetDrift(target, ev);
    // 제안 1회 기억의 키 = 언어|현재 대상|제안 대상 — ws 단위 문자열 하나면 언어 슬롯 전환(같은 ws·다른 실효 대상)
    // 상황에서 '예전에 같은 레포를 제안했다'는 이유로 영구 침묵(Codex 라이브 반례 2026-07-10). 구형 advisedRepo는 무시(1회 재제안 무해).
    const adviseKey = loadLang() + "|" + normWs(target) + "|" + normWs(drift.repo || "");
    const advised = ev.advisedKeys && typeof ev.advisedKeys === "object" ? ev.advisedKeys : {};
    if (drift.drift && !advised[adviseKey]) {
      // 상한 20키(오래된 시각부터 정리 — PRIVACY 고지와 일치)·구형 advisedRepo 필드는 쓰기 시 제거(이중 기억 방지)
      const merged = { ...advised, [adviseKey]: new Date().toISOString() };
      const keys = Object.keys(merged).sort((x, y) => (Date.parse(merged[x]) || 0) - (Date.parse(merged[y]) || 0));
      for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete merged[k];
      const next = { ...ev, advisedKeys: merged }; delete next.advisedRepo; delete next.advisedTs;
      try { atomicWrite(scoutEvidenceFileFor(ws), JSON.stringify(next)); } catch { /* 기억 실패 시 다음 턴 재제안 — 무해 */ }
      const en2 = loadLang() === "en";
      const inh = rs.source === "contract-other-lang";
      const cur = rs.source === "contract" || inh
        ? (en2 ? (inh ? "the target inherited from the other language slot: " + target : "the contract-set target " + target) : (inh ? "반대 언어 슬롯에서 상속된 " + target : "계약에 지정된 " + target))
        : (en2 ? "unset, so the session folder (" + target + ") is being used" : "미지정이라 세션 폴더(" + target + ") 기준");
      if (en2) return "[Recon (3-track) auto-directive · target mismatch suspected · this suggestion once] In the last " + drift.sample + " verification(s), " + drift.agree + " cited mostly files under " + drift.repo + ", but the scout target is " + cur + ". If " + drift.repo + " is the actual dev repo, run from the codex-peek source repo: `node scripts/scope-target.js \"" + ws + "\" set \"" + drift.repo + "\"` (this writes scoutRepo into this project's contract file for the current language slot — the other language mode inherits it unless it sets its own), then `node scripts/scope-scout-self.js \"" + drift.repo + "\"` for a map. If not, ignore this (advisory — nothing is blocked).";
      return "[탐색(3트랙) 자동 지시 · 대상 어긋남 의심 · 이 제안 1회만] 최근 검증 " + drift.sample + "회 중 " + drift.agree + "회가 " + drift.repo + " 소속 파일을 주로 인용했는데, 정찰 대상은 " + cur + "다. 실제 개발 레포가 " + drift.repo + " 가 맞으면 codex-peek 소스 저장소에서 `node scripts/scope-target.js \"" + ws + "\" set \"" + drift.repo + "\"` 를 실행해 대상을 지정하고(이 프로젝트 계약 파일의 현재 언어 슬롯에 scoutRepo가 저장됨 — 다른 언어 모드는 별도 지정이 없으면 이 값을 상속), 이어서 `node scripts/scope-scout-self.js \"" + drift.repo + "\"` 로 지도를 받아라. 아니라면 무시해도 된다(참고용 — 아무것도 막지 않는다).";
    }
  } catch { /* 자기진단 실패가 기존 신선도 지시를 못 막음 */ }
  const st = scoutMapStatus(target);
  if (st.state === "fresh") return null;
  // 재지시 버킷 v2(L1-C): staleCount 합산은 파일 수+커밋 수의 이질 단위 합산이라 폐기 — 성분별 버킷이
  // '어느 하나라도' 상승하면 재지시. 기억 스키마 v2(buckets 성분별) — 구형 기억(maxBucket 합산)은 성분 배정이
  // 불가능하므로 업그레이드 시 1회 재알림을 정직하게 허용(Codex 설계검증 합의).
  const comp = st.state === "stale"
    ? { seed: scoutBucket(st.seedChanged), commits: scoutBucket(st.commitsAfter), dirty: scoutBucket(st.dirtyChanged), history: scoutBucket(st.historyLost || 0) }
    : { seed: 0, commits: 0, dirty: 0, history: 0 };
  const f = path.join(SCOUT_ADVICE_DIR, wsKeyFor(target) + ".json");
  let prev = null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (raw && typeof raw === "object" && typeof raw.state === "string") {
      prev = { state: raw.state, base: raw.base || null, buckets: raw.buckets && typeof raw.buckets === "object" ? raw.buckets : null };
    } else if (raw && typeof raw.sig === "string") { // v0 형식 — 성분 배정 불가(buckets=null → 1회 재알림)
      prev = raw.sig === "no-map" ? { state: "no-map", base: null, buckets: null }
        : raw.sig.startsWith("stale:") ? { state: "stale", base: raw.sig.slice(6), buckets: null }
        : raw.sig.startsWith("legacy:") ? { state: "legacy-no-seeds", base: raw.sig.slice(7), buckets: null }
        : null;
    }
  } catch { /* 첫 지시 */ }
  if (prev && prev.state === st.state && prev.base === st.base) {
    if (st.state !== "stale") return null; // no-map/legacy/invalid/unknown은 상태당 1회
    if (prev.buckets && ["seed", "commits", "dirty", "history"].every((k) => comp[k] <= ((prev.buckets[k] | 0) || 0))) return null; // 모든 성분이 정도 이하 → 침묵
  }
  const mergedBuckets = {};
  for (const k of ["seed", "commits", "dirty", "history"]) mergedBuckets[k] = Math.max(comp[k], prev && prev.base === st.base && prev.buckets ? ((prev.buckets[k] | 0) || 0) : 0);
  try { atomicWrite(f, JSON.stringify({ state: st.state, base: st.base, buckets: mergedBuckets, ts: new Date().toISOString() })); } catch { /* 기억 실패 시 다음 턴 재지시 — 무해 */ }
  let hasKey = false;
  try { const j = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "deepseek.json"), "utf8")); hasKey = !!(j && typeof j.apiKey === "string" && j.apiKey.trim()); } catch { /* 키 없음 */ }
  const en = loadLang() === "en"; // 훅 주입문도 전역 언어 준수(한/영 쌍 규칙 — 2026-07-09 사용자 지적)
  const staleWhyKo = "최신 지도 이후 변경 신호 " + st.staleCount + "건(근거 파일 " + st.seedChanged + " · 새 커밋 " + st.commitsAfter + " · 작업트리 " + st.dirtyChanged + (st.historyLost ? " · 기록 기준 커밋 소실(이력 재작성?) " + st.historyLost : "") + ") — 지도가 낡았다";
  const staleWhyEn = st.staleCount + " change signal(s) since the latest map (basis files " + st.seedChanged + " · new commits " + st.commitsAfter + " · working tree " + st.dirtyChanged + (st.historyLost ? " · recorded base commit missing (history rewritten?) " + st.historyLost : "") + ") — the map is stale";
  const why = st.state === "no-map"
    ? (en ? "this project has no impact map yet" : "이 프로젝트에 영향지도가 아직 없다")
    : st.state === "legacy-no-seeds"
    ? (en ? "the latest map has no basis-file record, so freshness cannot be judged (map predates basis tracking) — regeneration recommended" : "최신 지도에 근거 파일 기록이 없어 신선한지 낡았는지 판정할 수 없다(근거 기록 도입 전의 구버전 지도) — 재생성 권고")
    : st.state === "invalid"
    ? (en ? "the latest map file has no recognizable structure (no parsable items, no section markers) — regeneration needed" : "최신 지도 파일에서 형식을 알아볼 수 없다(파싱 가능한 항목·구획 표기 없음) — 재생성 필요")
    : st.state === "unknown"
    ? (en ? "freshness cannot be fully judged (non-git target too large to scan completely) — if you changed files here, refreshing the map is recommended" : "신선도를 전수 판정할 수 없다(비-git 대상이 커서 스캔 상한 도달) — 이 폴더의 파일을 바꿨다면 지도 갱신을 권고")
    : (en ? staleWhyEn : staleWhyKo);
  if (en) return "[Recon (3-track) auto-directive · once per state] " + why + ". If this turn involves file changes, refresh the impact map before concluding — run `node scripts/scope-scout-self.js \"" + target + "\"` from the codex-peek source repo (default Claude scout first — no separate billing"
    + (hasKey ? " · scope-scout-deepseek.js (DeepSeek scout) available if comparison seems useful — key registration = consent to auto calls" : "")
    + "). Trivial turns (a question, a one-line doc edit) may skip — the map is advisory and blocks nothing.";
  return "[탐색(3트랙) 자동 지시 · 이 상태에 1회만] " + why + ". 이번 턴이 파일 변경을 동반하면 결론 전에 영향지도를 갱신하라 — codex-peek 소스 저장소에서 `node scripts/scope-scout-self.js \"" + target + "\"` 실행(기본 정찰[Claude 겸임·별도 과금 없음] 우선"
    + (hasKey ? " · 비교가 필요하다고 판단되면 scope-scout-deepseek.js(DeepSeek 정찰) 사용 가능 — 키 등록=자동 호출 동의됨" : "")
    + "). 사소한 턴(질문·문서 한 줄)이면 스킵해도 된다 — 지도는 참고용이며 아무것도 막지 않는다.";
}

// ── Phase 3: 지도 high 항목 구조화 + 검증 요청 동봉 ──────────────
// 탐색자 지도는 LLM 자유서식 텍스트 — '확인필요도 high' 항목만 관대하게 구조화한다.
// 구획 규칙: ①~④만 '확인 후보'(⑤범위밖·⑥MAP patch는 high 표기가 있어도 제외 — ⑥은 stable MAP 단계의 입력).
function extractMapHighlights(mapText, limit) {
  const LIM = Number.isFinite(limit) && limit > 0 ? limit : 8; // 기본 8(기존 소비자 무회귀) — 동봉 재랭킹 경로만 후보군 확대
  const lines = String(mapText || "").split(/\r?\n/);
  // 구획 표기(①~⑩)가 있는 지도면 ①~④ '진입 후'에만 추출(진입 전·⑤⑥·미지 구획 전부 제외 — Codex 반례 잠금).
  // 구획 표기가 아예 없는 자유서식 지도는 전체 허용으로 관대 폴백(놓쳐도 '동봉 없음'으로 퇴화할 뿐 잘못된 강제 없음).
  const sectioned = lines.some((l) => /[①②③④⑤⑥⑦⑧⑨⑩]/.test(l));
  const out = []; const seen = new Set();
  let allowed = !sectioned;
  for (const raw of lines) {
    const line = raw.replace(/`/g, "").trim().slice(0, 500); // 줄 상한 — 초장문 줄의 파서 비용 상수화(모든 ask 앞단 급소)
    if (!line) continue;
    if (sectioned) {
      // 제외 표기 우선 — 한 줄에 ①과 ⑤가 같이 오는 기형에서도 제외가 이긴다(Codex 반례 잠금). 제외 구획 줄 자체도 건너뜀.
      if (/[⑤⑥⑦⑧⑨⑩]/.test(line) || /범위 *밖|MAP\s*patch|out\s*of\s*scope/i.test(line)) { allowed = false; continue; }
      if (/[①②③④]/.test(line)) allowed = true;
    } else if (/범위 *밖|MAP\s*patch|out\s*of\s*scope/i.test(line)) continue; // 자유서식: 그 줄만 제외(전체 허용 폴백 유지 — 비활성 고착 없음)
    if (!allowed || !/\bhigh\b/i.test(line)) continue;
    // 경로 토큰: 공백류 분할 후 토큰별 검사 — 백트래킹 정규식 제거(긴 줄 초선형 지연 실측 → 토큰 상한 200자로 비용 고정).
    for (const tok of line.split(/[\s,;|"'<>{}()[\]—·↔]+/)) {
      // 한글 조사 등 비경로 문자를 양끝에서 제거("src/a.ts를 확인" → "src/a.ts") + 끝 문장부호 제거
      const t = tok.replace(/^[^A-Za-z0-9_.\\/-]+|[^A-Za-z0-9_.\\/-]+$/g, "").replace(/[.,;:]+$/, "");
      if (!t || t.length > 200 || !/^[A-Za-z0-9_.\\/-]+$/.test(t)) continue;
      const hasSep = /[\\/]/.test(t);
      if (!hasSep && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue; // 단일 파일명은 확장자에 글자 필수(0.1.86류 버전 오인 방지)
      if (hasSep && !/[A-Za-z]/.test(t.split(/[\\/]/).pop() || "")) continue; // 경로꼴이라도 마지막 구획에 글자 없으면(1/2 등) 제외
      const key = t.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: t, note: line.replace(/^[-*#\s①②③④]+/, "").slice(0, 120) });
      if (out.length >= LIM) return out; // 지시 스펙(high 최대 5)+여유 — 상한은 호출부 목적별(동봉 재랭킹은 24: 조기 컷이 재랭킹을 무효화하던 Codex 반례)
    }
  }
  return out;
}
// 지도의 ⑥(MAP patch 후보 — stable MAP 제안층) 항목 추출. ⑥ 헤더(또는 'MAP patch' 문구) 이후의 내용 줄을
// 다음 구획 헤더까지 수집한다. 제안은 자유서식 의미 결합("a ↔ b — 이유")이라 텍스트 그대로 보존(구조 강제 없음).
// 줄에 '경로 토큰'(구분자 있는 경로 또는 글자 확장자 파일명)이 하나라도 있는지 — 장부 씨앗 위생의 최소 기준.
// extractMapHighlights의 토큰 규칙과 동일 취지(관대하되 'yaml'·'blind spot' 같은 무경로 부스러기는 결합 제안이 아님).
function hasPathToken(line) {
  for (const tok of String(line || "").split(/[\s,;|"'<>{}()[\]—·↔:]+/)) {
    const t = tok.replace(/^[^A-Za-z0-9_.\\/-]+|[^A-Za-z0-9_.\\/-]+$/g, "").replace(/[.,;:]+$/, "");
    if (!t || t.length > 200 || !/^[A-Za-z0-9_.\\/-]+$/.test(t)) continue;
    const hasSep = /[\\/]/.test(t);
    if (!hasSep && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue; // 파일명은 글자 확장자 필수(0.1.86류 버전 오인 방지)
    if (hasSep) {
      const segs = t.split(/[\\/]/).filter(Boolean); // "proofs/" 같은 디렉터리 표기 — 끝 슬래시 뒤 빈 구획은 건너뛰고 실구획 검사
      if (!segs.length || !/[A-Za-z]/.test(segs[segs.length - 1])) continue; // 마지막 실구획에 글자 없으면(1/2 등) 제외
    }
    return true;
  }
  return false;
}
function extractMapPatches(mapText) {
  const out = []; const seen = new Set();
  let inPatch = false;
  for (const raw of String(mapText || "").split(/\r?\n/)) {
    const line = raw.replace(/`/g, "").trim().slice(0, 200); // 줄 상한 — 파서 비용 상수화
    if (!line) continue;
    // 구획 판정 순서(Codex 반례 잠금): 다른 구획 표기가 있으면(⑥·'MAP patch'와 혼합돼도) 종료가 이긴다.
    if (/[①②③④⑤⑦⑧⑨⑩]/.test(line)) { inPatch = false; continue; }
    if (/⑥/.test(line)) { inPatch = true; continue; } // ⑥ 헤더 — 항목은 다음 줄부터
    // 자유서식 헤더('MAP patch'로 시작하는 비-불릿 줄)만 인정 — ⑥ 안의 내용 줄에 'MAP patch' 문구가 있어도 항목으로 보존
    if (!inPatch && /^[#>\s]*MAP\s*patch/i.test(line)) { inPatch = true; continue; }
    if (!inPatch) continue;
    const text = line.replace(/^[-*#\s]+/, "").replace(/\*\*/g, "").trim();
    if (!text || /^\(.*없음.*\)$|^none$/i.test(text)) continue; // "(없음)"류 자리표시는 제안 아님
    // 씨앗 위생(백필 도입 시 실측: 'yaml'·'blind spot'·근거 설명줄이 후보로 새던 결함) — 결합 제안의 최소 실체는
    // '경로가 든 문장'. 경로 토큰 1개 이상 + 최소 길이. 러너·백필이 같은 이 함수를 쓰므로 기준은 단일.
    if (text.length < 16 || !hasPathToken(text)) continue;
    // ⑥은 '결합' 기록 — 결합 형태가 아닌 조각(단일 경로 서술·함수 표기·정규식 조각)은 씨앗 매칭·자동 확인이
    // 원리상 불가능한데 선별 상한·건강 분모만 차지한다(논리 점검 #6 — 라이브 장부 실존). 위생 = 추출 가능한 경로
    // 2개 이상 '또는' 결합 표기(↔/→) 존재 — 확장자 없는 채널 결합("proofs/ 쓰기 ↔ verify-guard 읽기")은 결합
    // 표기로 살리고, 표기도 경로쌍도 없는 서술만 거른다(2경로 단독 요구는 정당한 결합 지식을 소실 — 테스트 반례).
    if (ledgerPathsFromText(text).length < 2 && !/[↔→]/.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 10) break; // 제안층 상한 — 한 지도가 장부를 도배하지 못하게
  }
  return out;
}
// ── 관측 장부 이벤트(append-only) — 제안/동봉/확인/반박/오버라이드를 사실로만 적재(상태는 out/ledger-events.js가 유도) ──
// ⚠ ledgerSig는 src/map-ledger.ts normSig와 반드시 동일 규칙(공백 요동만 무시) — 한쪽만 바꾸면 같은 항목이 두 개가 된다
//   (배포 사본은 out/을 require 못 해 복사 유지 — tests/ledger-events.test.js 패리티 단언이 고정).
function ledgerSig(t) { return String(t || "").replace(/\s+/g, " ").trim().toLowerCase(); }
const LEDGER_EVENTS_DIR = path.join(BRIDGE_DIR, "map-ledger-events");
function ledgerEventsFileFor(ws) { return path.join(LEDGER_EVENTS_DIR, wsKeyFor(ws) + ".jsonl"); }
const LEDGER_EVENTS_CAP = 2000;   // 보존 상한(감사 추적 vs 무한 증가의 절충 — 정직 고지: 이보다 오래된 이벤트는 잘림)
const LEDGER_EVENTS_TRIM_AT = 2400; // 히스테리시스 — 매 append마다 rewrite하지 않게
function appendLedgerEvent(ws, ev) {
  try {
    if (!ws || !ev || !ev.sig || !ev.type) return false;
    fs.mkdirSync(LEDGER_EVENTS_DIR, { recursive: true });
    const f = ledgerEventsFileFor(ws);
    // 프로젝트별 장부 잠금(Codex 9차): append→read→trim→replace가 잠금 밖이면 트림 경계에서 타 프로세스의
    // append가 유실된다(브릿지 확인기·꾸러미 빌더·러너 2종·CLI·확장이 서로 다른 프로세스로 기록). 규율은
    // integrity 잠금과 동일(P1-② 검증됨) — '정상 경합 유실 방지'로 한정(죽은 pid=즉시 degraded).
    return withFileLock(f + ".lock", () => {
    fs.appendFileSync(f, JSON.stringify(ev) + "\n", "utf8");
    try {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > LEDGER_EVENTS_TRIM_AT) {
        // 재압축 유예(Codex 8차 #2): 마지막 압축 세대 이후 '새 이벤트'가 임계(TRIM_AT-CAP=400)만큼 쌓이기 전엔
        // 재정리하지 않는다 — 상한 초과 극단에서 매 append마다 전량 파싱·재작성이 반복되는 비용 차단(문자열 검사만 — 파싱 없음).
        {
          let lastCompact = -1;
          for (let i9 = lines.length - 1; i9 >= 0; i9--) { if (lines[i9].indexOf('"from":"trim-compact') >= 0) { lastCompact = i9; break; } }
          if (lastCompact >= 0 && (lines.length - 1 - lastCompact) < (LEDGER_EVENTS_TRIM_AT - LEDGER_EVENTS_CAP)) return true;
        }
        // 판정·복권 증거를 '우선' 보존(2026-07-09 확정 결함 2건 방지) + 가역쌍은 '순계 압축'(Codex 5차 반례:
        // ban/unban 2,401회 교대처럼 개수 기반 절단은 접두를 잘라 순계를 뒤집는다 — 개수 보존이 아니라 순계 보존이 계약).
        // 총량은 상한(2000)을 절대 넘지 않는다(PRIVACY '약 2,000줄 보존' 고지 불침).
        const parsedLines = lines.map((ln) => { try { return JSON.parse(ln); } catch { return null; } });
        // ① 가역쌍(banned/unbanned·pinned/unpinned·alias/unalias) 순계 압축 — 전량에서 순계·활성 간선을 계산해
        //    압축 이벤트(from: trim-compact)로 대체. 원시 가역 이벤트는 트림에서 제거(순계는 압축본이 정확히 재현).
        //    alias는 '전체 양수 간선'을 가중(n)과 함께 남긴다 — 우세 간선만 남기면 이후 unalias 의미가 바뀜(Codex 6차 #2).
        const banN = new Map(), pinN = new Map(), aliasN = new Map();
        for (const o of parsedLines) {
          if (!o) continue;
          if (o.type === "banned") banN.set(o.sig, (banN.get(o.sig) || 0) + (Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 1));
          else if (o.type === "unbanned") banN.set(o.sig, (banN.get(o.sig) || 0) - (Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 1));
          else if (o.type === "pinned") pinN.set(o.sig, (pinN.get(o.sig) || 0) + (Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 1));
          else if (o.type === "unpinned") pinN.set(o.sig, (pinN.get(o.sig) || 0) - (Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 1));
          else if ((o.type === "alias" || o.type === "unalias") && o.aliasSig) {
            let per = aliasN.get(o.aliasSig);
            if (!per) { per = new Map(); aliasN.set(o.aliasSig, per); }
            per.set(o.sig, (per.get(o.sig) || 0) + (o.type === "alias" ? 1 : -1) * (Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 1));
          }
        }
        const compactTs = new Date().toISOString();
        const compact = [];
        for (const [s2, n] of banN) if (n !== 0) compact.push(JSON.stringify({ ts: compactTs, type: n > 0 ? "banned" : "unbanned", sig: s2, n: Math.abs(n), from: "trim-compact(순계 보존)" })); // 음수 순계도 보존 — 폐기하면 이후 반대 방향 1건의 의미가 달라짐(Codex 7차 #2)
        for (const [s2, n] of pinN) if (n !== 0) compact.push(JSON.stringify({ ts: compactTs, type: n > 0 ? "pinned" : "unpinned", sig: s2, n: Math.abs(n), from: "trim-compact(순계 보존)" }));
        for (const [child, per] of aliasN) {
          for (const [par, n] of per) if (n !== 0) compact.push(JSON.stringify({ ts: compactTs, type: n > 0 ? "alias" : "unalias", sig: par, aliasSig: child, n: Math.abs(n), from: "trim-compact(순계 보존)" })); // 전체 간선(양·음수)+가중 — 열세/음수 간선을 버리면 이후 unalias/alias 의미가 바뀜(Codex 6·7차)
        }
        const REVERSIBLE = new Set(["banned", "unbanned", "pinned", "unpinned", "alias", "unalias"]);
        // 압축 관련 sig의 '대표 원문'(첫 text 보유 비가역 이벤트) 예약(Codex 8차 #1): 간선·상태 압축본만 남고
        // 항목 자체가 유도기에서 사라지는 소실 방지 — 유도기는 alias/unalias를 항목 생성에서 건너뛰므로
        // 정체성은 원문 이벤트가 들고 있어야 한다.
        const identitySigs = new Set();
        for (const [s9, n9] of banN) if (n9 !== 0) identitySigs.add(s9);
        for (const [s9, n9] of pinN) if (n9 !== 0) identitySigs.add(s9);
        for (const [child9, per9] of aliasN) for (const [par9, n9] of per9) if (n9 !== 0) { identitySigs.add(child9); identitySigs.add(par9); }
        const identityIdx = new Set();
        { const seen9 = new Set(); for (let i9 = 0; i9 < parsedLines.length; i9++) { const o9 = parsedLines[i9]; if (!o9 || !o9.text || !o9.sig || seen9.has(o9.sig) || !identitySigs.has(o9.sig)) continue; if (o9.type === "alias" || o9.type === "unalias") continue; seen9.add(o9.sig); identityIdx.add(i9); } }
        // ② 비가역 판정군 우선 보존 — 루트 해석은 '압축 전 전량'의 활성 간선으로(자식 반박↔부모 확인 복권 보존).
        const STATE = new Set(["user_dispute", "superseded", "tombstone", "user_confirm"]);
        const trimBest = new Map();
        for (const [child, per] of aliasN) { const best = [...per.entries()].filter(([, n]) => n > 0).sort((a2, b2) => b2[1] - a2[1] || a2[0].localeCompare(b2[0]))[0]; if (best) trimBest.set(child, best[0]); }
        const trimRoot = (sig) => { let cur = sig; const vis = new Set([cur]); for (;;) { const pp = trimBest.get(cur); if (!pp || pp === cur) return cur; if (vis.has(pp)) { let mn = pp, c3 = trimBest.get(pp); while (c3 !== pp) { if (c3 < mn) mn = c3; c3 = trimBest.get(c3); } return mn; } vis.add(pp); cur = pp; } };
        // 경계·보존군 판정은 유도기 promotableDispute/promotableConfirm과 '완전 동형'(3·4차 반례 — 기록 전용
        // 반박/확인 홍수가 실제 판정·복권 증거를 밀어내지 못하게).
        const trimDispute = (o) => o.type === "user_dispute" || (o.type === "refuted" && (!o.grade || (o.cited === true && o.seen === "ok" && o.askId)));
        const trimPromotable = (o) => o.type === "confirmed" && (!o.grade || ((o.grade === "claimed" ? o.cited === true : o.grade === "co-cited" && !o.echoed) && o.seen === "ok" && o.askId));
        const lastDisputeIdx = new Map();
        parsedLines.forEach((o, i2) => { if (o && trimDispute(o)) lastDisputeIdx.set(trimRoot(o.sig), i2); });
        const isKeepFirst = parsedLines.map((o, i) => {
          if (!o || REVERSIBLE.has(o.type)) return false; // 가역쌍 원시 이벤트는 압축본이 대체
          if (STATE.has(o.type)) return true;
          if (o.type === "refuted") return trimDispute(o); // 강등 재료 반박만 우선 보존(기록 전용은 일반 최신 이벤트로)
          return trimPromotable(o) && lastDisputeIdx.has(trimRoot(o.sig)) && i > lastDisputeIdx.get(trimRoot(o.sig)); // 복권 증거 — 승격 가능 종류만
        });
        const budget = Math.max(0, LEDGER_EVENTS_CAP - compact.length - identityIdx.size); // 압축본+대표 원문 자리 선확보. ⚠활성 상태가 상한을 넘는 극단에선 상한 예외(의미 보존 우선 — PRIVACY 고지)
        let firstKeep = Math.min(isKeepFirst.filter(Boolean).length, budget);
        let othersKeep = budget - firstKeep;
        const kept = [];
        for (let i = lines.length - 1; i >= 0; i--) {
          const o = parsedLines[i];
          if (identityIdx.has(i)) { kept.push(lines[i]); continue; } // 대표 원문 — 예산과 무관 보존
          if (o && REVERSIBLE.has(o.type)) continue; // 압축본으로 대체됨
          if (isKeepFirst[i]) { if (firstKeep > 0) { kept.push(lines[i]); firstKeep--; } }
          else if (othersKeep > 0) { kept.push(lines[i]); othersKeep--; }
        }
        const out = kept.reverse().concat(compact);
        // 무익 재작성 생략(Codex 7차 #4): 활성 상태가 상한을 넘는 극단에선 압축해도 줄지 않는다 — 매 append마다
        // 같은 전량 재작성을 반복하는 낭비 차단(파일은 사람 개입 속도로만 성장 — 의미 보존 우선·PRIVACY 상한 예외 고지).
        if (out.length < lines.length) atomicWrite(f, out.join("\n") + "\n");
      }
    } catch { /* 트림 실패 — 다음 append에서 재시도(적재 자체는 성공) */ }
    return true;
    });
  } catch { return false; } // best-effort — 장부 실패가 본 흐름(지도 저장·검증)을 막지 않음
}
function readLedgerEventsText(ws) {
  try { return fs.readFileSync(ledgerEventsFileFor(ws), "utf8"); } catch { return ""; }
}
// 항목 텍스트에서 경로꼴 토큰 추출 — ⚠ src/ledger-events.ts extractPathsFromText와 반드시 동일 규칙
// (배포 사본은 out/을 require 못 해 복사 유지 — tests/ledger-signals.test.js 패리티 단언이 고정).
function ledgerPathsFromText(text) {
  const out = [];
  for (const tok of String(text || "").replace(/`/g, "").split(/[\s,;|"'<>{}()[\]—·↔]+/)) {
    // 경로:라인 표기(src/a.ts:120)의 콜론 꼬리 제거 — ⑥ 후보 위생은 이 표기를 받는데 이 추출기가 못 읽어
    // '경로 0개' 항목이 되던 불일치(논리 점검 #6, 2026-07-10). 계약은 저장소 상대경로(절대경로·조사 접미 미지원).
    const noLine = tok.replace(/:(\d+)(?:-\d+)?$/, "");
    const t = noLine.replace(/^[^A-Za-z0-9_.\\/-]+|[^A-Za-z0-9_.\\/-]+$/g, "").replace(/[.,;:]+$/, "");
    if (!t || t.length > 200 || !/^[A-Za-z0-9_.\\/-]+$/.test(t)) continue;
    const hasSep = /[\\/]/.test(t);
    if (!hasSep && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(t)) continue;
    if (hasSep && !/[A-Za-z]/.test(t.split(/[\\/]/).pop() || "")) continue;
    out.push(t.replace(/\\/g, "/").toLowerCase());
  }
  return out;
}

// 검증 요청(ask)에 동봉할 지도 블록. 3트랙 프로젝트 + 지도 존재 + high 항목 있을 때만(그 외 null — 주입 비용 0·무회귀).
// 낡은 지도는 버리지 않고 '낡음' 라벨로 정직 고지(시간 상수 0 — scoutMapStatus의 seed mtime 판정 재사용).
// 동봉 항목 재랭킹(§6-7-1 — 2026-07-09 사용자 관찰 "참고 블록이 늘 비슷하다" 개선): 순수 함수(테스트 가능).
// (a) 지금 바뀐 파일과 겹치는 항목 우선(경로 꼬리 일치 또는 8자 이상 basename 일치 — 지도 채점기와 동일 보수 규칙)
// (b) 실존 파일만(파서 소음 '/arm'류 제거 — 패턴 목록이 아니라 '실존'이라는 범주 규칙). 단 전멸하면 원본 유지(fail-open)
// (c) 중복 경로 제거 후 상한 적용은 호출부에서 — 재랭킹이 cap보다 먼저라 하단 새 항목이 안 밀린다.
function rankScoutItems(items, changedFiles, existsFn) {
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  const seen = new Set();
  const deduped = [];
  for (const i of items) { const k = norm(i.path); if (!seen.has(k)) { seen.add(k); deduped.push(i); } }
  let pool = deduped;
  if (typeof existsFn === "function") {
    const existing = deduped.filter((i) => { try { return existsFn(i.path) === true; } catch { return false; } });
    if (existing.length) pool = existing; // 전멸 시 원본 유지 — 실존 판정 실패가 동봉 자체를 죽이지 않게
  }
  const ch = (changedFiles || []).map(norm).filter(Boolean);
  if (!ch.length) return pool;
  const hits = ch.map((f) => ({ full: f, base: f.split("/").pop() || "" }));
  const rel = (i) => {
    const p = norm(i.path); const b = p.split("/").pop() || "";
    return hits.some((h) => h.full.endsWith(p) || p.endsWith(h.full) || (b.length >= 8 && h.base === b));
  };
  return [...pool.filter(rel), ...pool.filter((i) => !rel(i))]; // 관련 우선·안정 정렬(원순서 보존)
}
// 정찰 대상의 '지금 바뀐 항목'(git status --porcelain -z) — 상태 코드 포함(-z: 한글·공백 경로가 따옴표로 감싸져
// statSync가 실패하던 함정 해소 — Codex 반례 2026-07-10). rename(R/C)은 -z에서 '새경로\0옛경로' 2필드 — 새 경로만.
function changedEntriesFor(repo) {
  try {
    const r = require("child_process").spawnSync("git", ["-c", "safe.directory=" + String(repo).replace(/\\/g, "/"), "-C", repo, "status", "--porcelain", "-z"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (r.status !== 0 || r.error) return [];
    const toks = String(r.stdout || "").split("\0");
    const out = [];
    for (let i = 0; i < toks.length && out.length < 200; i++) {
      const t = toks[i];
      if (!t || t.length < 4) continue;
      const code = t.slice(0, 2);
      const rel = t.slice(3);
      if (!rel) continue;
      out.push({ code, rel });
      if (/[RC]/.test(code)) i++; // 다음 토큰은 옛 경로 — 소비 안 함(⚠양쪽 열 다 검사: worktree rename " R"을 code[0]만 보면 옛 경로가 가짜 항목이 됨 — Codex 반례 2026-07-10)
    }
    return out;
  } catch { return []; }
}
// 경로만 필요한 기존 소비자(재랭킹)용 — ask마다 1회·3초 상한·실패는 빈 배열(재정렬만 포기, 동봉은 유지).
function changedFilesFor(repo) { return changedEntriesFor(repo).map((e) => e.rel); }

function buildScoutAttach(ws, c, lang) {
  if (!ws || normScoutMode(c) !== "on") return null;
  const target = resolveScoutRepo(ws, c).repo; // P1: 지도 조회도 정찰 대상 기준(세션 폴더가 비-git 부모여도 레포 지도를 씀)
  const st = scoutMapStatus(target);
  if (st.state === "no-map" || !st.base) return null;
  if (st.state === "invalid") return null; // 형식 불명(빈/불량) 지도는 신뢰 입력으로 주입하지 않는다(L1-C 품질 — 게이트와 같은 판정 소비)
  const dir = path.join(SCOUTS_DIR, wsKeyFor(target));
  let md = "", meta = {};
  try { md = fs.readFileSync(path.join(dir, st.base + ".md"), "utf8"); } catch { return null; }
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, st.base + ".json"), "utf8")); } catch { /* 메타 없어도 지도는 사용 가능 */ }
  // 저장된 구조화 계층 우선 — 단 항목 검증(깨진 메타 [null]류가 아래 i.path 접근을 못 깨게). 유효분 없으면 md 재파싱 폴백.
  const valid = (a) => (Array.isArray(a) ? a.filter((i) => i && typeof i.path === "string" && i.path.trim()) : []);
  // §6-7-1 재랭킹: 후보군은 지도 원문 재파싱(상한 24 — 저장 계층 meta.highlights는 8개 조기 컷이 박혀 있어
  // 재랭킹 후보로 부족: 9번째 항목이 지금 바뀐 파일이어도 못 들어오던 Codex 반례). 파싱 0건이면 저장 계층 폴백.
  let items = valid(extractMapHighlights(md, 24));
  if (!items.length) items = valid(meta.highlights);
  // 실존 필터(소음 제거) → 지금 바뀐 파일과의 교집합 우선 → 그 다음에야 동봉 상한 8(하단 새 항목 안 밀림)
  items = rankScoutItems(items, changedFilesFor(target), (p) => { try { return fs.existsSync(path.join(target, p)); } catch { return false; } });
  items = items.slice(0, 8);
  if (!items.length) return null;
  const en = (LANGS.includes(lang) ? lang : loadLang()) === "en";
  const staleNote = st.state === "stale"
    ? (en ? ` · STALE: ${st.staleCount} change signal(s) since (basis ${st.seedChanged} · commits ${st.commitsAfter} · working tree ${st.dirtyChanged}${st.historyLost ? ` · base commit missing ${st.historyLost}` : ""})` : ` · 낡음: 생성 후 변경 신호 ${st.staleCount}건(근거 ${st.seedChanged} · 커밋 ${st.commitsAfter} · 작업트리 ${st.dirtyChanged}${st.historyLost ? ` · 기록 기준 커밋 소실 ${st.historyLost}` : ""})`)
    : st.state === "unknown"
    ? (en ? ` · freshness not fully judged (non-git scan cap)` : ` · 신선도 전수 판정 불가(비-git 스캔 상한)`)
    : "";
  const head = en
    ? `[Scout impact map · reference — not a verdict rule] The latest impact map of this project (created ${meta.ts || "?"}, ${meta.arm === "deepseek" ? "DeepSeek scout" : "default Claude scout"}${staleNote}) flagged these high-priority paths:`
    : `[탐색 지도 · 참고 — 판정 기준 아님] 이 프로젝트 최신 영향지도(생성 ${meta.ts || "?"} · ${meta.arm === "deepseek" ? "DeepSeek 정찰" : "기본 Claude 정찰"}${staleNote})가 꼽은 확인필요도 high 경로:`;
  // ⚠ 앵커링 방어(2026-07-09 사용자 우려 "검증모델이 탐색 경로를 맹신하면?"): 목록은 시작점일 뿐 한계가 아님을
  // 명시 — 검증 기본원칙 3('범위를 스스로 넓혀 반례를 찾으라')과 같은 문법으로, 동봉이 검증 시야를 좁히지 못하게.
  const tail = en
    ? `While verifying, check whether these paths were considered; if a path above is impacted but unaddressed, point it out. The map is a scout LLM's advisory opinion — use it as a checklist source only. This list is a starting point, NOT a boundary: do not narrow your own search for counterexamples outside it.`
    : `검증 시 위 경로들이 고려/영향받았는지 확인하고, 영향을 받는데 다뤄지지 않은 경로가 있으면 지적하라. 지도는 탐색자(LLM)의 참고 의견이다 — 확인 목록으로만 쓰고 판정 기준은 바꾸지 마라. 이 목록은 시작점일 뿐 한계가 아니다: 목록 밖 반례 탐색을 줄이지 마라.`;
  const health = scoutHealthLine(target, en); // 프로젝트별 관찰 신호(전역 임계값 대체 — 사용자 결정 2026-07-09) — 실패해도 지도 동봉 불침
  // 결합확인 표기 채널(L1-A claimed 등급) — 장부의 기계 확인 가능 후보 소수를 id와 함께 싣고, '실제로 확인/반박한
  // 경우에만' 명시 표기를 요구. 공동 인용의 애매함(같은 답에 우연히 둘 다 등장)과 달리 표기는 기계 판정이 확실.
  // 별도 try — 후보 계산 실패가 지도 동봉을 막지 않음.
  let couplings = [];
  try { couplings = ledgerCouplingCandidates(target, 3); } catch { couplings = []; }
  const coupleBlock = couplings.length
    ? (en
      ? ["[Coupling check requests — reply markers]", ...couplings.map((cp) => `- (#${cp.id}) ${String(cp.text).slice(0, 200)}`), `Only if you actually verified one of these couplings during this verification, write \`결합확인 #id\` on its own line; if you actually found it wrong, write \`결합반박 #id\`. If you did not check it, write nothing about it (no guessing).`]
      : ["[결합 확인 요청 — 답 표기]", ...couplings.map((cp) => `- (#${cp.id}) ${String(cp.text).slice(0, 200)}`), `이번 검증에서 위 결합을 '실제로 확인'한 경우에만 \`결합확인 #id\` 를 한 줄로 명시하고, '실제로 틀렸음을 확인'했다면 \`결합반박 #id\` 를 명시하라. 확인하지 않았다면 아무것도 쓰지 마라(추측 금지).`]).join("\n")
    : "";
  const text = [head, ...items.map((i) => `- ${i.path}${i.note && String(i.note) !== i.path ? ` — ${String(i.note).slice(0, 120)}` : ""}`), tail, ...(coupleBlock ? [coupleBlock] : []), ...(health ? [health] : [])].join("\n");
  // envelope(L1-A): '이번 ask에 실제로 실린 것'의 스냅샷 — echo 판정은 전역 합집합이 아니라 '항목 단위'로
  // (지도에서 A·B가 서로 다른 항목이면 그 결합이 노출된 게 아니다 — Codex 설계검증). 소비자는 flagLedgerConfirms.
  return {
    text,
    mapItems: items.map((i) => ({ path: String(i.path), note: i.note ? String(i.note).slice(0, 120) : "" })),
    couplings,
  };
}

// ── Scout Health 미니 집계(배포 사본 — 정본은 src/ledger-events.ts computeScoutHealth. out/을 require 못 하는
// 배포 관례상 원시 JSONL을 직접 항목(entry) 단위로 집계하며, tests/scout-health.test.js가 정본과 패리티를 잠근다).
// 용어 잠금: '정확도' 금지 — '관찰 신호'. attached는 '다음 꾸러미 재동봉' 사건(검증자 열람 인과 아님)이고 이벤트 선후도 안 보므로 순서('후')를 주장하지 않는 지표명만 쓴다.
const HEALTH_EVENT_TYPES = new Set(["proposed", "attached", "confirmed", "refuted", "user_confirm", "user_dispute", "pinned", "unpinned", "banned", "unbanned", "superseded", "tombstone", "exported", "alias", "unalias"]); // 정본 parseEventsJsonl의 allowlist와 동형 — 미지 타입이 표본 수를 부풀리지 못하게(Codex 반례)
// 기계 확인 '승격 가능' 판정(정본 promotableMachineAskIds와 동형): 명시 표기(claimed)거나 비-echoed 공동 인용,
// 취급 흔적 검사 불가(seen=unknown)는 제외. 서로 다른 askId(구형은 ts)만 센다 — '서로 다른 ask 실행' 기준.
// 기계 확인 '승격 가능' 판정(정본 promotableConfirm과 동형): claimed는 '실제 인용 동반(cited)'일 때만
// (표식은 자기보고 — 단독 승격 금지), co-cited는 비-echoed만, seen=unknown 제외.
// 가중 해석(정본 evWeight 동형) — 트림 순계 압축본(n>1)과 일반 이벤트(1)를 한 규칙으로.
function evW(e) { return Number.isFinite(e.n) && e.n > 0 ? Math.floor(e.n) : 1; }
function miniPromotableConfirm(e) {
  if (e.type !== "confirmed") return false;
  if (e.grade !== "claimed" && e.grade !== "co-cited") return false;
  if (e.seen !== "ok" || !e.askId) return false; // 명시 요구(필드 누락 통과 금지 — Codex 2차 #7)
  if (e.grade === "claimed") return e.cited === true;
  return !e.echoed;
}
// 반박이 강등 재료인가(정본 promotableDispute 동형) — 표식 반박은 인용 동반만.
function miniPromotableDispute(e) {
  if (e.type === "user_dispute") return true;
  if (e.type !== "refuted") return false;
  if (!e.grade) return true;
  return e.cited === true && e.seen === "ok" && !!e.askId; // 확인과 동일 명시 조건(부정이 더 약한 조건이면 안 됨)
}
function miniPromoteIds(confs) {
  const ids = new Set();
  for (const e of confs) if (miniPromotableConfirm(e)) ids.add(e.askId || e.ts || "");
  ids.delete("");
  return ids.size;
}
// 자동(기계) 확인 가능성 — 정본 autoConfirmEligible과 동형(확인기 flagLedgerConfirms의 증거 키와 같은 규칙).
function miniAutoEligible(text) {
  const bns = new Set(ledgerPathsFromText(String(text || "")).map((p) => p.split("/").pop() || "").filter((b) => b.length >= 8));
  return bns.size >= 2;
}
// 공용 미니 집계 빌더 — 헬스(computeScoutHealthMini)와 동봉 결합 후보(ledgerCouplingCandidates)가 같은
// 판정을 쓴다(두 벌이면 후보와 신호가 서로 다른 상태를 말하게 됨). 정본은 src/ledger-events.ts deriveLedger.
function miniLedgerEntries(raw) {
  const events = [];
  for (const ln of String(raw || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (!o || !o.sig || !o.type || !HEALTH_EVENT_TYPES.has(o.type)) continue;
    if ((o.type === "alias" || o.type === "unalias") && !(typeof o.aliasSig === "string" && o.aliasSig && o.aliasSig !== o.sig)) continue;
    events.push(o);
  }
  // alias 순계(사람 승인 병합) — 정본 deriveLedger와 동형: S→P 우세 부모, 체인 10홉 상한.
  const aliasNet = new Map();
  for (const e of events) {
    if (e.type !== "alias" && e.type !== "unalias") continue;
    let per = aliasNet.get(e.aliasSig);
    if (!per) { per = new Map(); aliasNet.set(e.aliasSig, per); }
    per.set(e.sig, (per.get(e.sig) || 0) + (e.type === "alias" ? evW(e) : -evW(e)));
  }
  const parent = new Map();
  for (const [s, per] of aliasNet) {
    const best = [...per.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) parent.set(s, best[0]);
  }
  // 방문 집합(정본 동형 — Codex 2차 반례: 정본만 고치면 대시보드=1항목·ask 동봉=2항목으로 갈라짐):
  // 체인 길이 무관 병합, 순환은 고리 내 사전순 최소 sig가 결정적 루트.
  const rootOf = (sig) => {
    let cur = sig;
    const visited = new Set([cur]);
    for (;;) {
      const p2 = parent.get(cur);
      if (!p2 || p2 === cur) return cur;
      if (visited.has(p2)) {
        let mn = p2, c3 = parent.get(p2);
        while (c3 !== p2) { if (c3 < mn) mn = c3; c3 = parent.get(c3); }
        return mn;
      }
      visited.add(p2);
      cur = p2;
    }
  };
  const per = new Map(); // 루트 sig → 집계
  const textFromRoot = new Set();
  for (const o of events) {
    if (o.type === "alias" || o.type === "unalias") continue;
    const key = rootOf(o.sig);
    let e = per.get(key);
    if (!e) { e = { sig: key, att: 0, confAll: 0, userConf: 0, confs: [], after: [], afterU: 0, disp: 0, ban: 0, unban: 0, sup: 0, tomb: 0, everDisp: false, text: "", lastTs: o.ts || "" }; per.set(key, e); }
    if (o.text) { if (o.sig === key && !textFromRoot.has(key)) { e.text = o.text; textFromRoot.add(key); } else if (!e.text) e.text = o.text; }
    if (o.ts && o.type !== "attached") e.lastTs = o.ts; // 정본과 동형 — attached는 최신성 제외(자기고정 방지)
    if (o.type === "attached") e.att++;
    else if (o.type === "confirmed") { e.confAll++; e.confs.push(o); if (e.everDisp) e.after.push(o); }
    else if (o.type === "user_confirm") { e.confAll++; e.userConf++; if (e.everDisp) e.afterU++; }
    else if (o.type === "user_dispute" || o.type === "refuted") { e.refAny = true; if (miniPromotableDispute(o)) { e.disp++; e.everDisp = true; e.after = []; e.afterU = 0; } } // refAny=기록 기준(지표)·everDisp=강등 기준(상태) 분리 — Codex 2차 #5
    else if (o.type === "banned") e.ban += evW(o);
    else if (o.type === "unbanned") e.unban += evW(o);
    else if (o.type === "superseded") e.sup++;
    else if (o.type === "tombstone") e.tomb++;
  }
  const legacyRepeats = (confs) => new Set(confs.filter((e) => !e.grade).map((e) => e.ts || "")).size;
  const out = [];
  for (const e of per.values()) {
    e.dead = (e.ban - e.unban) > 0 || e.sup > 0 || e.tomb > 0;
    const machineOk = miniPromoteIds(e.confs) >= 2 || legacyRepeats(e.confs) >= 2; // DERIVE_V2와 동형(패리티 테스트 잠금)
    e.rehab = e.everDisp && !e.dead && (e.afterU >= 1 || miniPromoteIds(e.after) >= 2 || legacyRepeats(e.after) >= 2);
    e.verified = !e.dead && (e.everDisp ? e.rehab : (e.userConf >= 1 || machineOk));
    e.autoEligible = miniAutoEligible(e.text);
    e.machineEvidence = e.confs.some((x) => miniPromotableConfirm(x) || !x.grade); // 정본 동형 — 기계 지표 과대 표시 방지(Codex #7)
    e.reinterpreted = !e.dead && !e.everDisp && !e.verified && e.confs.some((x) => !x.grade); // 구형(grade 없음) 확인이 있는 미승격만 — 정본 동형
    out.push(e);
  }
  return out;
}
function computeScoutHealthMini(raw) {
  const entries = miniLedgerEntries(raw);
  const h = { entries: entries.length, verified: 0, reusedDen: 0, reusedNum: 0, autoDen: 0, autoNum: 0, disputedEntries: 0, rehabilitated: 0, reinterpreted: 0 };
  for (const e of entries) {
    if (e.verified) h.verified++;
    if (e.att > 0) {
      h.reusedDen++;
      if (e.confAll > 0) h.reusedNum++;
      if (e.autoEligible) { h.autoDen++; if (e.machineEvidence) h.autoNum++; } // 승격 가능 종류만(과대 표시 금지 — Codex #7)
    }
    if (e.refAny) h.disputedEntries++; // 라벨 '반박 이력'=기록 기준(정본 동형 — 강등 여부와 무관)
    if (e.rehab) h.rehabilitated++;
    if (e.reinterpreted) h.reinterpreted++;
  }
  return h;
}
// 결합확인 표기(claimed) 후보 — 동봉 블록에 id와 함께 실려, 답의 '결합확인 #id / 결합반박 #id'가 귀속된다.
// 기계 확인 가능(autoEligible)하고 죽지 않은 항목만. 미확정(inferred) 우선(확인이 필요한 것부터), 반박 이력
// 항목도 뒤순위로 포함(복권 재료를 문 앞에서 버리지 않기 — 2026-07-09 사용자 결정). id=sig sha1 앞 6자.
function ledgerItemId(sig) { return require("crypto").createHash("sha1").update(String(sig)).digest("hex").slice(0, 6); }
function ledgerCouplingCandidates(target, cap = 3) {
  const entries = miniLedgerEntries(readLedgerEventsText(target)).filter((e) => e.autoEligible && !e.dead && e.text);
  const rank = (e) => (e.verified ? 2 : e.everDisp ? 1 : 0); // inferred(0) 우선 — verified는 재확인 가치 낮음
  entries.sort((a, b) => rank(a) - rank(b) || String(b.lastTs).localeCompare(String(a.lastTs)));
  return entries.slice(0, cap).map((e) => ({ id: ledgerItemId(e.sig), sig: e.sig, text: e.text, paths: ledgerPathsFromText(e.text) }));
}
const HEALTH_MIN_SAMPLE = 5; // 정본(src/ledger-events.ts)과 동일 상수 — 표본 미만이면 비율 표시 금지(과신 방지)
// 동봉용 1~2줄(bounded — 주입 비용 상한). 표본 부족이면 '근거 부족' 1줄, 충분하면 항목 수치+상시 한계 문구.
function scoutHealthLine(target, en) {
  try {
    const h = computeScoutHealthMini(readLedgerEventsText(target));
    if (!h.entries) return null; // 장부 없음 — 블록 자체 생략(비용 0)
    if (h.entries < HEALTH_MIN_SAMPLE) {
      return en
        ? `[Scout observation signal] This project's journal is still small (${h.entries} item(s)) — treat the map strictly as candidates.`
        : `[정찰 관찰 신호] 이 프로젝트의 관찰 일지가 아직 작음(항목 ${h.entries}건) — 지도는 후보로만 취급하라.`;
    }
    // 순서 무주장 문구(Codex 반례: 확인이 재동봉보다 먼저인 항목도 셈에 든다) — 인과를 암시하는 지표명 금지.
    // 지표 분리(L1-A): '확인 이력'(사람 포함 전체)과 '기계 확인'(기계 확인 가능 항목만 분모 — 경로<2 항목 섞으면 분모 왜곡)은 다른 지표.
    const ratio = h.reusedDen >= HEALTH_MIN_SAMPLE ? ` · ${en ? "reused items with a confirm on record" : "재사용 항목 중 확인 이력"} ${h.reusedNum}/${h.reusedDen}` : "";
    const autoRatio = h.autoDen >= HEALTH_MIN_SAMPLE ? ` · ${en ? "machine-checkable reused items with a machine confirm" : "기계 확인 가능 재사용 항목 중 기계 확인"} ${h.autoNum}/${h.autoDen}` : "";
    const reint = h.reinterpreted > 0 ? (en ? ` · ${h.reinterpreted} item(s) stepped down by the 2026-07 evidence-rule reinterpretation (recorded, not deleted)` : ` · 증거 규칙 재해석(2026-07)으로 내려온 항목 ${h.reinterpreted}건(삭제 아님 — 기록 유지)`) : "";
    return en
      ? `[Scout observation signal — this project] confirmed items ${h.verified}/${h.entries}${ratio}${autoRatio}${reint} · disputed ${h.disputedEntries} (manually recorded) · rehabilitated ${h.rehabilitated}. Bias can go both ways (no automatic dispute extraction = disputes undercounted; map-attached exposure = confirms overcounted — logic audit 2026-07-10) — still, the map is a candidate list, not a safety guarantee: keep independent checks outside it.`
      : `[정찰 관찰 신호 — 이 프로젝트 기준] 확인 항목 ${h.verified}/${h.entries}${ratio}${autoRatio}${reint} · 반박 ${h.disputedEntries}건(수동 기록 기준) · 복권 ${h.rehabilitated}건. 집계 편향은 양방향일 수 있다(자동 반박이 없어 반박은 적게 잡히고, 지도에 실려 노출된 항목은 확인이 잘 잡힘 — 논리 점검 2026-07-10) — 지도는 후보 목록이지 안전 보장이 아니다: 지도 밖 독립 확인을 유지하라.`;
  } catch { return null; /* 신호 실패가 지도 동봉을 막지 않음 */ }
}

// rules(문자열 배열) → 매 턴 주입 텍스트. checklist=false면 규약만, true면 [계약점검] 강제.
// 비어 있으면 "" 반환(주입 비용 0). lang: 주입 지시문 언어(규칙 '내용'은 사용자가 쓴 그대로).
function buildInjection(rules, who, checklist, lang) {
  const r = (rules || []).map((s) => String(s).trim()).filter(Boolean);
  if (!r.length) return "";
  const json = JSON.stringify({ rules: r.map((t, i) => ({ n: i + 1, r: t })) });
  const en = (LANGS.includes(lang) ? lang : loadLang()) === "en";
  if (!checklist) {
    // 체크 해제: 규약/지침만 상수로 주입 (TODO 강제 없음).
    return en
      ? [`[Standing Rules · ${who} · constants applied every turn — do not ignore or omit]`, json].join("\n")
      : [`[고정 규약 · ${who} · 매 턴 적용되는 상수 — 무시·생략 금지]`, json].join("\n");
  }
  // 체크: TODO 리스트로 펼쳐 각 항목 준수/위반+근거 강제.
  if (en) {
    return [
      `[Standing Contract · ${who} · constants applied every turn — do not ignore or omit]`,
      json,
      `Instruction: this response MUST include the [Contract Check] block below. Do not skip items.`,
      `[Contract Check]`,
      ...r.map((_, i) => `- ${i + 1}) <complies|violated|n/a> — <one-line reason>`),
      `The rules are constants. If you violated one, do not hide it — mark it 'violated' and state why.`,
    ].join("\n");
  }
  return [
    `[고정 계약 · ${who} · 매 턴 적용되는 상수 — 무시·생략 금지]`,
    json,
    `지시: 이번 응답 안에 아래 [계약점검] 블록을 반드시 포함하라. 항목을 건너뛰지 말 것.`,
    `[계약점검]`,
    ...r.map((_, i) => `- ${i + 1}) <준수|위반|해당없음> — <한 줄 근거>`),
    `규칙은 상수다. 위반했다면 숨기지 말고 '위반'으로 표기하고 이유를 적어라.`,
  ].join("\n");
}

// ── 기본 지침(base directive) — 하네스 최소 동작 보장용 고정 규약. 사용자 고정계약(contract)과 별개. ──
// 코드에 캐논 기본값을 두고, ~/.codex-bridge/base-directive.json 오버라이드가 있으면 그 항목만 대체.
// 대시보드에서 보기/수정/초기화 가능. 항목이 비거나 파일이 없으면 항상 기본값으로 동작(초기화=복구).
const BASE_DEFAULTS = {
  // 검증모델(Codex)에게 매 ask마다 prepend되는 기본 원칙.
  verifyBaseline: [
    "[검증 기본 원칙 · 항상 적용]",
    "1) 논리 구조만으로 단정하지 말고, 코드·파일을 실제로 열어 확인해 검증하라.",
    "2) 검증 수행 생략·요약·축약 금지. '빠르게/대충' 요청을 받더라도 충실히 검증하라.",
    "3) 요청자가 지정한 파일·범위는 '시작점'일 뿐 한계가 아니다. 요청자의 결론을 전제로 받아들이지 말고, 필요하면 호출부·테스트·문서·배포 경로까지 범위를 스스로 넓혀 반례를 찾으라.",
    "4) 본문에 검토 내용·항목별 근거(경로·라인)·보완/정정/추가 확인 사항·실패 사유를 '먼저' 상세히 작성하라(본문 축약 금지). 판정 결론은 반드시 '맨 마지막 한 줄'에만 다음 4가지 중 정확히 하나로 출력하라: '검증: 통과'(보완·주의·수정 항목 없음) / '검증: 통과(보완)'(통과지만 보완·정정·추가 의견 있음) / '검증: 보류'(정보 부족·불가 등으로 결론 못 냄) / '검증: 실패'. 마지막 줄 외에는 '검증:'으로 시작하는 줄을 쓰지 마라(근거를 먼저 적고 결론을 마지막에 두어야 결론이 그 근거에 맞춰진다 — 성급한 머리말 오라벨 방지).",
    "5) 판정 기준은 '실질 영향'이다. 오작동·명세 불일치·회귀 위험·사용자/운영 판단을 오도할 표현·작아 보여도 반복·확장 시 결함으로 번질 구조는 사소하지 않으니 잡아라. 반대로 결과·동작·다음 판단을 바꾸지 않는 취향·형식·미세 문구만으로 통과를 막지 마라.",
  ].join("\n"),
  // 구현모델(Claude)에게 — 검증모델에 '전달'할 때의 원칙.
  transmit: [
    "[전달 원칙] 검증모델에게 검증을 맡길 때:",
    "- 검증 대상은 코드 변경만이 아니다 — 설계 판단·적절성 의견·제안 문구 등 사용자에게 보고할 '결론'이면, 구현이 없어도 '내 주장'으로 검증모델에 던져 공격받아라. (단 code/plancode 모드의 ask 트리거 자체는 코드·플랜 기준 그대로.)",
    "- 검증 요청을 요약/생략하지 마라. 관련 파일 경로·확인 지점을 구체적으로 적어 검증모델이 원본을 직접 열게 하고 받을 답변도 축약하도록 지시하지 마라. (판정 표지누락 유도 방지)", // 사용자 v3 문안(2026-07-08) 원문 그대로 — 축약 요청('N문장 이내로' 류)이 표지없음 경보를 오염시킨 실사고 재발 방지. 괄호는 '목적' 부연(결과형 '유도'는 극성 오독 잔여 위험)
    "- '여기만 봐라 / 이렇게 해라' 식 좁은 명령을 하지 마라. 대신 내가 무엇을 했고·왜 했고·어떤 근거를 봤고·어디가 불안한지를 주고, 내 결론은 '내 주장'으로 표시해 검증모델이 공격하게 하라.",
    "- 파일·라인은 시작점으로만 제시하고, 검토 범위 확장은 검증모델의 판단에 맡겨라.",
  ].join("\n"),
  // 구현모델(Claude)에게 — 검증모델 답을 받은 뒤 '재판단'할 때의 원칙.
  rejudge: [
    "[재판단] 검증모델 답을 그대로 옮기지 마라. 항목별로 재판단하라:",
    "- 검증모델의 지적을 항목으로 나눠, 각 항목에 [수용/반박/보류] + 근거(파일·라인) + 사유를 달라.",
    "- 수용하는 항목엔 반드시 근거(직접 확인한 파일·라인)가 있어야 한다. 짧은 '동의/이견없음'으로 뭉개지 마라(반박·보류는 그 자체가 재판단 증거).",
    "- 근거는 논리 추정이 아니라 코드/파일에서 직접 확인 가능한 사실(경로·라인·실제 출력/동작)로. 검증모델과 의견이 갈리면 이유를 명시하라.",
    "- 완료 보고는 Codex 판정이 '통과' 또는 '통과(보완)'인 검증 결과를 반영한 뒤에만 하라. 예시 하나·분기 하나·테스트 몇 개·구체어 덧붙임을 '전체 해결'로 포장하지 마라 — 그 자체는 완료가 아니다.",
    "- 검증 후 추가로 수정했으면(검증모델 권고를 적용한 수정 포함) 보고·커밋 전에 그 최종본을 다시 검증하라. 검증받은 상태가 곧 배포 상태다.",
  ].join("\n"),
};

// P-12 core(핵심) 프리셋 — 직접 영향 중심 검증. 판정 4단 문자열·findings-first 형식은 integrity와 동일
// (extractVerdict 판독기 불변 — 계약 ⓖ). 사용자 오버라이드(base-directive*.json)는 integrity에만 적용되고
// core는 코드 캐논 고정(1단 — 프리셋 전환이 사용자 편집을 덮지 않게 분리, core 커스텀은 2단 custom).
const BASE_CORE = {
  verifyBaseline: [
    "[검증 기본 원칙 · 핵심 프로필 — 직접 영향 중심]",
    "1) 논리 구조만으로 단정하지 말고, 코드·파일을 실제로 열어 확인해 검증하라.",
    "2) 검증 대상은 '요청이 선언한 목표·인수조건과 그 직접 영향'이다. 지정된 파일·범위는 시작점이되, 범위 밖 확장은 직접 의존이나 안전 불변식 위반 의심 같은 구체 사유가 있을 때만 하고 그 사유를 해당 항목에 표기하라.",
    "3) 판정 규약(핵심 프로필): '검증: 실패'는 미해결 blocker가 최소 1개일 때만 쓴다. blocker는 항목의 종류가 아니라 실질 영향으로 판정한다 — ①선언된 인수조건 안에서 재현 가능하거나 신뢰할 수 있는 오작동 경로 ②데이터·보안·역할·증명 무결성 훼손(희귀 경합이라도 여기 해당하면 blocker) ③명시 요구사항 위반 ④핵심 인수조건을 입증할 실행 증거 부재 ⑤직접 연관된 고위험 회귀. 이에 해당하지 않는 지적은 세 갈래로 표기하라: '[주의]'=blocker는 아니지만 보안·개인정보·데이터 손상·복구 불능·운영 오판 위험에 '인접'(그 위험으로 이어지는 구체 경로 1줄 필수 — 경로를 못 대면 다른 갈래로. 구현모델이 심각성을 재판단해 이번 루프 처리 여부를 결정한다 — 침묵 이관 금지 대상) / '[보완]'=지적이 구체적이고 국소 수정으로 끝나며 새 설계 선택이 필요 없는 것(문구·라벨·수치·명백 소결함 — 구현모델이 이번 루프에서 일괄 반영할 것을 기대) / '[백로그]'=범위 밖 제안(선언된 인수조건 밖이고, 현재 결과물의 재현 가능한 명세 위반이 아니며, 불변식 훼손의 구체 경로가 없고, 채택하려면 새 시나리오·정책·아키텍처 범위를 열어야 하는 것 — 추가 방어·커버리지 확장 포함). 이름만 '저확률·경합·테스트 보강'이라고 [백로그]로 보내지 마라 — 무결성을 훼손하는 저확률 경합은 blocker고, 핵심 인수조건 입증에 필요한 테스트 부재도 blocker다. 지적이 하나도 없으면 판정은 '검증: 통과', blocker 없이 비차단 지적([주의]/[보완]/[백로그])이 1건이라도 있으면 '검증: 통과(보완)'.",
    "4) 본문에 검토 내용·항목별 근거(경로·라인)를 '먼저' 상세히 작성하라. 판정 결론은 반드시 '맨 마지막 한 줄'에만 다음 4가지 중 정확히 하나로 출력하라: '검증: 통과' / '검증: 통과(보완)' / '검증: 보류' / '검증: 실패'. 마지막 줄 외에는 '검증:'으로 시작하는 줄을 쓰지 마라.",
    "5) 판정 줄 '바로 앞'에 기계 판독용 지적 블록을 붙여라: '[지적 목록 v1]' 한 줄(그 문자열 그대로 행 전체) → 본문에서 제기한 모든 지적을 줄당 JSON 1개로 {\"tag\":\"blocker|주의|보완|백로그\",\"title\":\"지적 1줄(비밀값·개인정보·절대경로 원문 금지)\",\"file\":\"관련 파일 경로(선택)\"} → '[지적 목록 끝]' 한 줄. 지적이 없으면 마커 두 줄만(빈 블록). 종료 마커와 마지막 판정 줄 사이에는 빈 줄 외에 아무것도 쓰지 마라. 블록이 없거나 손상되거나 판정과 모순이면(예: blocker를 나열하고 '통과' 선언) 하네스가 판정을 '보류'로 강등한다(fail-closed).",
  ].join("\n"),
  transmit: [
    "[전달 원칙 · 핵심 프로필] 검증모델에게 검증을 맡길 때:",
    "- 요청문을 구조화하라: 목표 / 인수조건(무엇이 되면 성공인가) / 직접 범위 / 제외 범위 / 필요한 증거를 명시한다.",
    "- 파일·라인은 시작점으로만 제시하고, 내 결론은 '내 주장'으로 표시해 검증모델이 공격하게 하라.",
    "- 검증 요청을 요약/생략하지 말고, 받을 답변을 축약하도록 지시하지 마라(판정 표지누락 유도 방지).",
  ].join("\n"),
  rejudge: [
    "[재판단 · 핵심 프로필] 검증모델 답을 그대로 옮기지 마라 — 그리고 지적이라는 이유만으로 수용하지도 마라:",
    "- 모든 지적(blocker 포함)을 항목으로 나눠 [수용/반박/보류] + 근거(파일·라인)로 재판단하라. 수용에는 직접 확인한 근거가, 반박에는 실측 반례가 필요하다. 반박이 성립하면 그 근거를 다음 검증 요청에 실어 보내라 — 수동적 전건 흡수는 검증 폭주의 원료다.",
    "- '[주의]' 항목(보안·데이터 인접)은 심각성을 스스로 재판단하라: 실질 위험이 있다고 보면 blocker 수정과 같은 루프에서 함께 고치고(추가 재검증은 1회에 동승), 아니라고 보면 그 근거를 달아 사용자 보고로 승격하라 — 근거 없는 조용한 백로그 이관 금지.",
    "- 재판단에서 수용한 '[보완]'(기계적 보완: 지적이 구체적이고, 수정이 국소적이며, 스키마·상태·동시성·보안·역할·증명의 설계 선택을 새로 만들지 않고, 좁은 테스트로 결과를 확정할 수 있는 것)은 이번 루프에서 일괄 반영하고 확인 검증 1회로 마감하라. 확인 범위는 그 변경과 직접 회귀로 한정한다 — 일괄 반영 대상은 '첫 판정에서 수용한 [보완]'뿐이며, 확인 단계에서 새로 나온 비차단 지적([보완] 포함)은 반영하지 않고 사용자 최종 보고에 미반영 상태로 명시한다(범위 밖 제안은 보관함으로). 추가 왕복은 새 blocker에만 허용한다. 첫 판정의 [보완]을 보관함으로 미루지 마라.",
    "- '[백로그]'(범위 밖 제안)는 이 루프에서 수정하지 마라 — 보관함에 기록하고 사용자 최종 보고에 목록으로 전달한다. 보관함 항목에는 갚을 의무가 없다 — 사용자·구현모델이 채택할 때만 작업이 된다(대형 실작업은 보관함이 아니라 정식 계획 문서에 등재). 보관함은 범위 밖 제안([백로그])과 사용자 판단 대기로 승격한 [주의] 두 종류만 담는다.",
    "- '[백로그]' 항목은 하네스가 검증자 지적 블록에서 자동으로 보관함에 등록한다 — 회수 출력의 '[장부 자동 등록]' 영수증 id를 보고에 인용하라. '[장부 자동 등록 거부/실패]' 경고가 보이면 그 항목만 제목을 일반화해 수동 등록하고, 사용자 승격으로 결정한 '[주의]' 항목은 직접 \`node \"" + BRIDGE + "\" backlog add --tag 백로그|주의 --title \"<지적 1줄 — 비밀값·개인정보 원문 금지>\" [--file <경로>]\`로 기록해 출력된 id를 보고에 인용하라(기록 누락이 보고에서 드러나게).",
    "- blocker(실패 사유)는 반박이 성립하지 않는 한 반드시 고치고, '[주의]'는 위 재판단에서 이번 루프 처리로 결정한 항목만 함께 고쳐 재검증하라. 완료 보고는 '통과'/'통과(보완)' 후에만.",
    "- 최종(마감) 검증 요청에는 처리표를 첨부하라: ①즉시 수정한 항목 ②범위 밖 보관 항목+제외 근거 ③정식 계획으로 승격한 대형 작업 ④사용자가 수용한 위험. 검증자는 직접 영향이나 안전 불변식 훼손 경로가 있는 항목의 '보관' 분류를 기각할 수 있다.",
    "- 재검증이 반복·교착되는데 blocker가 잔존하면 통과로 포장하지 말고 '보류'로 사용자에게 선택을 넘겨라. 단 '그냥 보류'는 금지 — 반드시 분류와 근거를 붙인다: [분쟁 보류]=코드·테스트·명세 실측 근거로 반박했으나 검증자가 유지(반박 근거·왕복 이력 첨부 — 과잉 검증 여부는 사용자가 판단) / [미해결 결함 보류]=결함 인정·해소 실패(시도 내역·잔여 위험 첨부) / [외부 결정 보류]=사용자 정책·자격증명 등 사용자 입력 없이 진행 불가(필요한 결정 명시 — 예산·왕복이 남아도 즉시 가능). 공통 첨부: 대상 지적·최종 상태·사용자 선택지.",
    "- 묶음 완성·로컬 커밋 후 push·배포 전에 무결성 프로필로 승격 검증 1회를 권장한다.",
  ].join("\n"),
};
const BASE_CORE_EN = {
  verifyBaseline: [
    "[Verification Baseline · Core profile — direct-impact focused]",
    "1) Do not conclude from logical structure alone — actually open and inspect the code/files to verify.",
    "2) The verification target is the declared goal/acceptance criteria and their direct impact. The given files/scope are a starting point; expand beyond them only with a concrete reason (direct dependency, suspected safety-invariant violation) and note that reason on the item.",
    "3) Verdict rule (core profile): use 'Verdict: fail' only when at least one unresolved blocker exists. A blocker is judged by real impact, not category — (1) a reproducible or credible malfunction path within the declared acceptance criteria, (2) damage to data/security/role/proof integrity (even a rare race, if it qualifies), (3) violation of an explicit requirement, (4) missing executable evidence for a core acceptance criterion, (5) directly related high-risk regression. Mark non-blocking findings in three ways: '[caution]' = adjacent to security/privacy/data-loss/unrecoverable-state/operational-misjudgment risk (a one-line concrete path to that risk is mandatory — no path, use another class; the implementer re-judges severity and decides in-loop handling — never silently deferred) / '[notes]' = concrete, locally fixable, requiring no new design choice (wording, labels, counts, obvious small defects — the implementer is expected to apply them in this loop as a batch) / '[backlog]' = out-of-scope proposal (outside the declared acceptance criteria, not a reproducible spec violation of the current result, no concrete invariant-damaging path, and adopting it would open a new scenario/policy/architecture scope — including extra hardening/coverage expansion). Never send an item to '[backlog]' merely because it is named 'low-probability/race/test-hardening' — a low-probability race that damages integrity is a blocker, and a missing test needed to prove a core acceptance criterion is a blocker. With zero findings the verdict is 'Verdict: pass'; with no blocker but at least one non-blocking finding ('[caution]'/'[notes]'/'[backlog]') it is 'Verdict: pass (notes)'.",
    "4) Write the review details FIRST in the body with per-item evidence (path·line). Output the verdict only as the VERY LAST line, as exactly one of: 'Verdict: pass' / 'Verdict: pass (notes)' / 'Verdict: inconclusive' / 'Verdict: fail'. Do not write any other line starting with 'Verdict:'.",
    "5) Immediately BEFORE the verdict line, attach a machine-readable findings block: a line '[findings v1]' (that exact string as the whole line) → every finding you raised, one JSON object per line as {\"tag\":\"blocker|caution|notes|backlog\",\"title\":\"one line (never secret/PII/absolute-path originals)\",\"file\":\"related file path (optional)\"} → a line '[findings end]'. With no findings, output just the two marker lines (empty block). Between the end marker and the final verdict line write nothing but blank lines. If the block is missing, corrupt, or contradicts the verdict (e.g. blockers listed under 'pass'), the harness demotes the verdict to 'inconclusive' (fail-closed).",
  ].join("\n"),
  transmit: [
    "[Transmission Principles · Core profile] When handing work to the verifier model:",
    "- Structure the request: goal / acceptance criteria (what counts as success) / direct scope / exclusions / required evidence.",
    "- Present files/lines only as starting points, and mark your conclusion as 'my claim' so the verifier can attack it.",
    "- Do not summarize or omit the request, and do not instruct the verifier to abbreviate its reply (avoids verdict-line omission).",
  ].join("\n"),
  rejudge: [
    "[Re-judgment · Core profile] Do not copy the verifier's answer verbatim — and never accept a point merely because the verifier raised it:",
    "- Re-judge every point (blockers included) as items with [accept/rebut/hold] + evidence (file·line). Acceptance needs evidence you checked yourself; a rebuttal needs a measured counterexample. When a rebuttal stands, carry its evidence into the next verification request — passive wholesale absorption is the fuel of verification explosion.",
    "- Re-judge the severity of '[caution]' items (security/data-adjacent) yourself: if you judge the risk real, fix them in the same loop as the blockers (any extra re-verification rides along once); if not, escalate them to the user's report with your reasoning — never silently defer them to the backlog.",
    "- Apply accepted '[notes]' (mechanical: the finding is concrete, the fix is local, it creates no new schema/state/concurrency/security/role/proof design choice, and a narrow test can settle it) in this loop as one batch, closed by a single confirmation verification. Scope that confirmation to the change and its direct regressions — the batch covers only '[notes]' accepted from the first verdict; new non-blocking findings surfacing during confirmation (including '[notes]') are NOT applied and are reported to the user as unapplied (out-of-scope proposals go to the parking lot). Extra round-trips are allowed only for new blockers. Never defer first-verdict '[notes]' to the parking lot.",
    "- Do NOT fix '[backlog]' (out-of-scope proposal) items in this loop — record them in the parking lot and pass the list to the user's final report. Parked items carry no repayment duty — they become work only when the user/implementer adopts them (large real work belongs in the formal plan document, not the parking lot). The parking lot holds exactly two kinds: out-of-scope proposals ('[backlog]') and '[caution]' items escalated to await the user's judgment.",
    "- '[backlog]' items are auto-recorded in the parking lot by the harness from the verifier's findings block — cite the '[ledger auto-record]' receipt ids from the retrieval output in your report. If an '[ledger auto-record refused/failed]' warning appears, register just that item manually with a generalized title; user-escalated '[caution]' items you record yourself with \`node \"" + BRIDGE + "\" backlog add --tag 백로그|주의 --title \"<one line — never secret/PII originals>\" [--file <path>]\` and cite the printed id (so omissions are visible).",
    "- Fix every blocker unless a rebuttal stands, plus only those '[caution]' items you decided above to handle in this loop, then re-verify. Report completion only after 'pass' or 'pass (notes)'.",
    "- Attach a disposition table to the final (closing) verification request: (1) items fixed now, (2) items parked as out-of-scope with the exclusion reason, (3) large work promoted to the formal plan, (4) risks the user accepted. The verifier may reject a 'parked' classification for any item with direct impact or a concrete invariant-damaging path.",
    "- If re-verification stalls with blockers remaining, do not package it as a pass — escalate to the user as 'inconclusive/hold'. Never a bare hold: attach a class and evidence — [disputed hold]=you rebutted the blocker with code/test/spec evidence but the verifier maintains it (attach the rebuttal and round-trip history — the user judges over-verification) / [unresolved-defect hold]=defect acknowledged but unfixed (attach attempts and residual risk) / [external-decision hold]=cannot proceed without user input such as policy or credentials (state the needed decision — allowed immediately even with budget left). Common attachments: the finding, final state, and the user's options.",
    "- After the bundle is complete and locally committed, one integrity-profile escalation verification before push/deploy is recommended.",
  ].join("\n"),
};

// 영문 기본 지침 — 한국어 캐논의 '동등 품질' 영어판(직역 아님). 출력 형식(findings-first / verdict-last ·
// 4단계 판정 문자열)은 아래 extractVerdict의 영어 문법과 반드시 일치해야 한다(지침이 시키는 형식 = 판독기가 읽는 형식).
const BASE_DEFAULTS_EN = {
  verifyBaseline: [
    "[Verification Baseline · always applies]",
    "1) Do not conclude from logical structure alone — actually open and inspect the code/files to verify.",
    "2) Never skip, summarize, or abbreviate the verification work. Even if asked to be 'quick/rough', verify thoroughly.",
    "3) The files/scope given by the requester are a starting point, not a boundary. Do not accept the requester's conclusion as a premise; widen the scope yourself — call sites, tests, docs, deployment paths — to hunt for counterexamples.",
    "4) Write the review details FIRST in the body: per-item evidence (path·line), supplements/corrections/follow-ups, and failure reasons (do not abbreviate the body). Output the verdict only as the VERY LAST line, as exactly one of: 'Verdict: pass' (no supplements/cautions/fixes) / 'Verdict: pass (notes)' (passes, but with supplements/corrections/additional opinions) / 'Verdict: inconclusive' (cannot conclude — insufficient information etc.) / 'Verdict: fail'. Do not write any other line starting with 'Verdict:' (writing evidence first and the conclusion last keeps the conclusion anchored to the evidence — prevents premature mislabeling).",
    "5) Judge by REAL impact. Malfunctions, spec mismatches, regression risks, wording that could mislead users/operations, and structures that look small but will grow into defects when repeated or extended are not minor — catch them. Conversely, do not block a pass over taste, formatting, or micro-wording that changes no outcome, behavior, or next decision.",
  ].join("\n"),
  transmit: [
    "[Transmission Principles] When handing work to the verifier model:",
    "- Verification targets are not only code changes — any 'conclusion' you will report to the user (design judgments, adequacy opinions, proposed wording) must be thrown to the verifier as 'my claim' to be attacked, even without an implementation. (The ask trigger itself in code/plancode modes still follows code/plan criteria.)",
    "- Do not summarize or omit the verification request. Include concrete file paths and checkpoints so the verifier opens the originals itself, and do not instruct the verifier to abbreviate its reply (to avoid inducing verdict-line omission).",
    "- No narrow orders like 'look only here / do it this way'. Instead, state what you did, why, what evidence you saw, and where you feel uncertain; mark your conclusion as 'my claim' so the verifier can attack it.",
    "- Present files/lines only as starting points; leave scope expansion to the verifier's judgment.",
  ].join("\n"),
  rejudge: [
    "[Re-judgment] Do not copy the verifier's answer verbatim. Re-judge item by item:",
    "- Split the verifier's points into items; attach [accept/rebut/hold] + evidence (file·line) + reasoning to each.",
    "- Accepted items must carry evidence you checked yourself (file·line). Do not blur with a short 'agree/no objection' (rebut/hold are themselves proof of re-judgment).",
    "- Evidence must be facts directly verifiable in code/files (paths, lines, actual output/behavior), not logical conjecture. If you disagree with the verifier, state why.",
    "- Report completion only after reflecting a verification whose verdict is 'pass' or 'pass (notes)'. Never package one example, one branch, a few tests, or an added specific as a 'full resolution' — that alone is not completion.",
    "- If you modified anything after verification (including applying the verifier's advice), re-verify the final state before reporting/committing. The verified state is the shipped state.",
  ].join("\n"),
};

// 언어별 기본값/오버라이드 파일 선택. ko=레거시 base-directive.json 그대로(기존 사용자 오버라이드 보존), en=base-directive.en.json.
function baseDefaultsFor(lang) {
  return (LANGS.includes(lang) ? lang : loadLang()) === "en" ? BASE_DEFAULTS_EN : BASE_DEFAULTS;
}
function baseDirectiveFileFor(lang) {
  const l = LANGS.includes(lang) ? lang : loadLang();
  return l === "ko" ? BASE_DIRECTIVE_FILE : path.join(BRIDGE_DIR, `base-directive.${l}.json`);
}
// 기본 지침 로드: 오버라이드 파일의 비지 않은 항목만 기본값을 대체. lang=언어 슬롯(오버라이드·기본값 모두 그 언어 것).
// P-12: profile="core"면 core 캐논 고정(오버라이드 미적용 — 프리셋 전환이 사용자 편집을 덮거나 섞지 않게 분리,
// integrity 오버라이드 파일 바이트는 불변·복귀 시 그대로). 미지정/기타=integrity(현행 동작 그대로 — 무회귀).
function loadBaseDirective(lang, profile) {
  if (profile === "core") {
    const C = (LANGS.includes(lang) ? lang : loadLang()) === "en" ? BASE_CORE_EN : BASE_CORE;
    return { verifyBaseline: C.verifyBaseline, transmit: C.transmit, rejudge: C.rejudge };
  }
  let o = {};
  try {
    o = JSON.parse(fs.readFileSync(baseDirectiveFileFor(lang), "utf8"));
  } catch {
    o = {};
  }
  const D = baseDefaultsFor(lang);
  const pick = (k) => (o && typeof o[k] === "string" && o[k].trim() ? o[k] : D[k]);
  return { verifyBaseline: pick("verifyBaseline"), transmit: pick("transmit"), rejudge: pick("rejudge") };
}
// 기본값과 같은 항목은 저장하지 않음(빈 오버라이드=기본값). 전부 기본이면 파일 삭제(=초기화).
function saveBaseDirective(obj, lang) {
  const D = baseDefaultsFor(lang);
  const file = baseDirectiveFileFor(lang);
  const out = {};
  for (const k of ["verifyBaseline", "transmit", "rejudge"]) {
    const v = obj && typeof obj[k] === "string" ? obj[k] : "";
    if (v.trim() && v.trim() !== D[k].trim()) out[k] = v;
  }
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  if (Object.keys(out).length === 0) {
    // 전부 기본값이면 오버라이드 파일을 지움 = 초기화. 이미 없으면(ENOENT) 그것도 성공(원하는 상태).
    try { fs.unlinkSync(file); } catch (e) { if (e && e.code !== "ENOENT") return false; }
    return true;
  }
  return atomicWrite(file, JSON.stringify(out, null, 2));
}
function resetBaseDirective(lang) {
  // 오버라이드 파일 삭제 = 기본값 복원. 이미 없으면(ENOENT) 그것도 성공(원하는 상태). 권한 오류만 false.
  try { fs.unlinkSync(baseDirectiveFileFor(lang)); } catch (e) { if (e && e.code !== "ENOENT") return false; }
  return true;
}

// 검증 모드 ON일 때 Claude(구현모델)에게 매 턴 주입하는 2트랙 지시. 전달원칙·재판단은 기본 지침에서 로드(오버라이드 가능).
function buildVerifyDirective(mode, lang, profile) {
  const l = LANGS.includes(lang) ? lang : loadLang();
  const b = loadBaseDirective(l, profile); // P-12: 주입 시점의 실효 프로필(미지정=integrity — 무회귀)
  if (l === "en") {
    const cond =
      mode === "always" ? "This turn (every response)" :
      mode === "plancode" ? "If this turn confirmed a plan (ExitPlanMode) or created/modified files" :
      "If this turn created/modified files"; // code
    return [
      `[Verify Mode ON(${mode}) · implement→verify two-track · no human relays between the models]`,
      `${cond}, you MUST get Codex verification before reporting completion. Start exactly one durable job with \`node "${BRIDGE}" ask-start --allow-new "..."\`, then run \`node "${BRIDGE}" ask-wait <job-id>\` repeatedly while it reports pending. Never start a second job while the first is queued/running. The dashboard verification wait (${verifyTimeoutMin()} min) is the actual Codex deadline; short outer tool windows do not terminate the verifier. (A linked verifier session is resumed; a new one is created only when none is linked.) [path is quoted so spaces are safe]`,
      `[Remote checks] The verifier runs with network blocked by default (read-only sandbox). If the verification itself must confirm remote state (e.g., GitHub push/CI/remote refs, registries, live URLs), add \`--net\` to that one ask — that single run allows outbound network while files stay read-only. Do not use --net when local files suffice.`,
      b.transmit,
      b.rejudge,
    ].join("\n");
  }
  const cond =
    mode === "always" ? "이번 턴(모든 응답)" :
    mode === "plancode" ? "이번 턴에 플랜을 확정(ExitPlanMode)했거나 파일을 생성/수정했다면" :
    "이번 턴에 파일을 생성/수정했다면"; // code
  return [
    `[검증 모드 ON(${mode}) · 구현→검증 2트랙 · 사람이 턴을 중계하지 않음]`,
    `${cond}, 사용자에게 완료를 보고하기 전에 반드시 \`node "${BRIDGE}" ask-start --allow-new "..."\` 로 내구 작업을 정확히 1개 시작하고, pending이면 \`node "${BRIDGE}" ask-wait <job-id>\` 를 반복해 Codex 검증 결과를 받아라. 첫 작업이 queued/running인 동안 두 번째 작업을 시작하지 마라. 대시보드 검증 대기시간(${verifyTimeoutMin()}분)이 실제 Codex 마감시간이며, 바깥 도구의 짧은 실행창이 검증자를 종료시키지 않는다. (연결된 검증 세션이 있으면 이어가고, 연결이 전혀 없을 때만 새 세션을 만들어 연결한다.) [경로에 공백이 있어도 되도록 따옴표로 감쌌음]`,
    `[원격 확인] 검증자는 기본적으로 네트워크가 차단된 채(읽기 전용 샌드박스) 돈다. 검증 자체가 원격 상태 확인을 요구하면(예: GitHub 푸시/CI/원격 ref, 패키지 저장소, 라이브 URL) 그 1회의 ask에 \`--net\`을 붙여라 — 그 실행만 외부 통신이 허용되고 파일은 여전히 읽기 전용이다. 로컬 파일로 충분한 검증엔 --net을 쓰지 마라.`,
    b.transmit,
    b.rejudge,
  ].join("\n");
}

// Codex 답에서 '결론(verdict)'을 보수적으로 분류한다. '첫 줄'이 아니라 '검증'을 포함한 줄을 모두 훑어
// 마지막 결론 줄로 판정한다 — codex exec 한 턴은 파일 읽는 작업 narration이 앞에 깔리고 진짜 결론은
// 마지막 메시지에 오므로, 첫 줄만 보면 거의 빗나간다(대시보드 그린불 오작동의 근본 원인). 마지막-우선이라
// 앞쪽 서두의 우연한 '통과/실패' 언급은 진짜 결론 줄이 덮어쓴다.
// 반환(4단계): "pass"(깨끗한 통과) | "pass-notes"(통과지만 보완·정정·추가의견 있음 — 엄연히 통과) |
//   "inconclusive"(보류·불가·정보부족 = 통과 못 함) | "fail"(실패) | null(결론 표지 못 찾음 → 중립). ※extractVerdict 자체는 경고 안 함. 단 flagVerdict는 비어있지 않은 null 답엔 verdict-missing 노랑을 띄운다(표지 누락 가시화).
// '통과·보완'을 '보류/불가'와 분리한다 — 통과인데 챙길 게 있는 것과 통과 못 한 것은 다르다(사용자 지적 반영).
// ⚠️ src/extension.ts의 동명 함수(대시보드 표시용 TS 사본)와 로직이 반드시 동일해야 한다. 한쪽만 고치지 말 것.
// '결론 선언 줄' 정규식: (마크다운 기호/공백 뒤) '검증'으로 시작 + (콜론이거나 곧바로 결론어).
// 콜론형("검증: …")은 무조건 선언으로 인정(정보 부족·판단 보류 등 포괄). 콜론 없으면 결론어가 와야 함.
// → 서두("검증 요청으로…": 콜론X·요청은 결론어X)·본문("…이 검증에서 실패…", "(검증 아님)": 검증으로 시작X)을 배제.
// 이 정규식은 '후보 줄' 필터일 뿐 — 최종 판정은 아래 분류 분기가 결정한다("검증: 설명문"처럼 판정어 없으면 null).
// formatForClaude는 이 정규식을 직접 안 쓰고 extractVerdict(줄)!==null로 '판정 분류되는 줄'만 떼어내 더 보수적이다.
const VERDICT_DECL_RE = /^[\s#>*\-]*검증\s*(?:[:：]|통과|실패|불가|보류|판단|조건부|보완|정보)/;
// 영어 선언 줄: 'Verdict:' 콜론형만(영문 기본지침이 시키는 정확한 형식). 'Verification passed locally, but…' 같은
// 본문 설명문이 판정으로 오인되지 않게 게이트를 좁게 유지(Codex 검증 반례 반영). 판독은 언어 설정과 무관하게
// '항상' 한/영 둘 다 받는다(혼용 세션·전환 직후 안전).
// 분류는 '단어 스캔'이 아니라 '콜론 바로 뒤 선언값'을 앵커로 한다 — "Verdict: pass - no tests fail"의 뒤쪽
// fail이 선언값(pass)을 덮어쓰지 못하게(Codex 검증 반례 반영). pass 뒤 나머지에 보완어가 있으면 pass-notes.
const VERDICT_DECL_RE_EN = /^[\s#>*\-]*verdict\s*[:：]\s*(pass(?:ed|es)?|fail(?:ed|s)?|inconclusive)\b(.*)$/i;
// 한국어 분류는 기존 로직 그대로(무회귀) — 그 줄이 한국어 선언일 때 한국어 단어로만(교차 오염 방지:
// 판정줄 속 우연한 영단어 fail-safe·minor 등이 오분류를 못 낸다).
function classifyVerdictKo(ln) {
  if (/실패/.test(ln)) return "fail";
  if (/불가|보류|정보\s*부족/.test(ln)) return "inconclusive"; // 통과 없는 보류·불가·정보부족 = 통과 못 함
  if (/통과/.test(ln) && /보완|조건부|정정|추가|미세|단서/.test(ln)) return "pass-notes"; // 통과지만 보완·추가의견
  if (/통과/.test(ln)) return "pass"; // 깨끗한 통과
  return null;
}
function classifyVerdictEn(ln) {
  const m = VERDICT_DECL_RE_EN.exec(ln);
  if (!m) return null;
  const declared = m[1].toLowerCase();
  if (declared.startsWith("fail")) return "fail";
  if (declared === "inconclusive") return "inconclusive";
  // 선언값 pass — 나머지(선언값 뒤 텍스트)에 보완어가 있으면 pass-notes. 'Verdict: pass (notes)' 형식 포함.
  const rest = m[2] || "";
  if (/\bnotes?\b|\bcaveats?\b|\bminor\b|\bconditional\b|\breservations?\b|\bremarks?\b|\bsupplements?\b/i.test(rest)) return "pass-notes";
  return "pass";
}
function extractVerdict(text) {
  if (!text) return null;
  let v = null;
  for (const ln of String(text).split(/\r?\n/)) {
    // 선언 줄 확정 → 그 언어의 규칙으로만 분류. KO 우선순위: 실패 > 보류·불가 > 통과+보완 > 통과(기존 그대로).
    // EN: 콜론 뒤 선언값 앵커. 마지막 선언이 이김(마지막 줄 결론 원칙).
    let r = null;
    if (VERDICT_DECL_RE.test(ln)) r = classifyVerdictKo(ln);
    else r = classifyVerdictEn(ln);
    if (r) v = r;
  }
  return v;
}

// verdict 코드 → Claude '처리 의무' 문장(색 라벨이 아니라 다음 행동). pass도 '단, 본문 우선' 단서로 Codex 오라벨(P2) 전파를 줄인다.
const VERDICT_ACTION = {
  pass: "조치 없음 — 단, 본문에 보완·주의·수정 항목이 보이면 선언 결론보다 본문 항목을 우선 처리하라.",
  "pass-notes": "보완 의견 있음 — 본문의 보완·정정·추가 항목을 각각 [수용/반박/보류]로 최종 보고에서 처리하라.",
  inconclusive: "추가 확인 필요 — 판단 보류 사유와 다음 확인 지점을 보고하라.",
  fail: "수정 필요 — 실패 사유를 반영해 고친 뒤 재검증하라.",
};
const VERDICT_ACTION_EN = {
  pass: "No action — but if the body contains supplement/caution/fix items, prioritize those body items over the declared verdict.",
  "pass-notes": "Supplements present — handle each supplement/correction/addition from the body as [accept/rebut/hold] in the final report.",
  inconclusive: "Further verification needed — report the reason for the hold and the next checkpoints.",
  fail: "Fix required — address the failure reasons, then re-verify.",
};
// P1b: Claude 소비용 stdout 재배치. 대시보드/proof/rollout은 원문(answer) 그대로 쓰고, Claude에게 주는 것만 바꾼다.
// findings-first(P1a)로 받은 답에서 '마지막 검증: 선언 줄'을 본문에서 떼어, 라벨 대신 '처리 의무' footer로 옮긴다.
// → Claude가 '통과(보완)'의 '통과'에 앵커링해 보완을 건너뛰는 것 방지(가시성 색칩은 사람용 대시보드가 담당).
// 떼어낸 원문 줄을 footer에 그대로 보여줘 '정확한 결론 인용'(재판단 원칙)도 보존. 게이트가 아니라 nudge.
// P-12 core 처리 의무(v2.4): blocker=반박 불성립 시 수정·첫 판정의 [보완]=일괄 반영+확인 1회(확인 판정은 미반영 보고)·[백로그]=보관함(의무 없음) — 동결된 프로필 인자로만 선택
// (완료 시점 계약 재읽기 금지 — 계약 ⓓ). 미지정=integrity 문구(무회귀).
const VERDICT_ACTION_CORE = {
  pass: "조치 없음 — 단, 본문에 보완·주의·수정 항목이 보이면 선언 결론보다 본문 항목을 우선 처리하라.",
  "pass-notes": "보완 의견 있음 — 각 항목을 [수용/반박/보류]로 재판단하라(지적이라는 이유만으로 수용 금지·반박=실측 반례). 이 답이 '첫 판정'이면: 수용한 '[보완]'을 일괄 반영하고 확인 검증 1회로 마감하라. 이 답이 그 '확인 검증'의 판정이면: 새로 나온 비차단 지적([보완] 포함)은 반영하지 말고 미반영 상태로 사용자 보고에 명시하라(범위 밖 제안은 보관함으로 — 추가 왕복은 새 blocker만). '[주의]'는 심각성을 재판단해 지금 고치거나(확인 1회 동승) 근거와 함께 사용자 판단으로 승격해 보관함에 기록하라(조용한 이관 금지). '[백로그]'(범위 밖 제안)는 수정하지 말고 보관함에 기록 후 목록으로 전달하라 — 갚을 의무 없음.",
  inconclusive: "추가 확인 필요 — 판단 보류 사유와 다음 확인 지점을 보고하라. blocker가 잔존한 교착이면 [분쟁|미해결 결함|외부 결정] 분류+근거를 붙여 사용자에게 선택을 넘겨라.",
  fail: "수정 필요 — blocker(실패 사유)는 반박이 성립하지 않는 한 고치고, '[주의]'는 심각성을 재판단해 같은 루프 처리 여부를 결정, 수용한 '[보완]'은 일괄 동승 반영한 뒤 재검증하라(단 이 답이 '확인 검증'의 판정이면 새 blocker만 고치고, 새 비차단 지적은 미반영 보고). '[백로그]'(범위 밖 제안)는 수정하지 말고 보관함에 기록 후 전달하라.",
};
const VERDICT_ACTION_CORE_EN = {
  pass: "No action — but if the body contains supplement/caution/fix items, prioritize those body items over the declared verdict.",
  "pass-notes": "Notes present — re-judge every item as [accept/rebut/hold] (never accept merely because it was raised; a rebuttal needs a measured counterexample). If this is the FIRST verdict: apply accepted '[notes]' as one batch closed by a single confirmation verification. If this is that CONFIRMATION's verdict: do NOT apply newly surfaced non-blocking findings (including '[notes]') — report them to the user as unapplied (out-of-scope proposals go to the parking lot; extra round-trips only for new blockers). Re-judge each '[caution]': fix it now (rides the confirmation once) or escalate it to the user's judgment and record it in the parking lot (never defer silently). Do NOT fix '[backlog]' (out-of-scope proposals); record them in the parking lot and pass the list — no repayment duty.",
  inconclusive: "Further verification needed — report the hold reason and next checkpoints. If blockers remain in a stalemate, escalate to the user with a [disputed|unresolved-defect|external-decision] class and evidence.",
  fail: "Fix required — fix the blockers unless a rebuttal stands, re-judge each '[caution]' for same-loop handling, apply accepted '[notes]' in the same batch, then re-verify (but if this is a CONFIRMATION verdict, fix only new blockers and report new non-blocking findings as unapplied). Do not fix '[backlog]' (out-of-scope proposals); record them in the parking lot and pass them through.",
};
// P-12 2c: 강등·정정 사유 키 → 사람 문장(원문 비복사 — 손상 줄 내용은 절대 안 담김. corrupt는 개수·좌표만).
function machineReasonText(machine, en) {
  const n = machine && machine.parse && machine.parse.corrupt ? machine.parse.corrupt.count : 0;
  const M = {
    "block-missing": en ? "no machine-readable findings block" : "기계 판독용 지적 블록 없음",
    "block-corrupt": en ? `findings block corrupt (${n} line(s))` : `지적 블록 손상(${n}줄)`,
    "no-verdict-line": en ? "no final verdict line" : "판정 표지 줄 없음",
    "fail-without-blocker": en ? "'fail' declared but zero blocker findings" : "'실패' 선언인데 blocker 지적 0건",
    "pass-with-blocker": en ? "pass-class verdict declared but blocker findings listed" : "통과류 선언인데 blocker 지적 존재",
    "pass-with-notes": en ? "non-blocking findings listed" : "비차단 지적 존재",
  };
  return M[machine && machine.reasonKey] || (en ? "verdict/findings mismatch" : "판정·지적 불일치");
}
// machine(선택 4번째 인자·P-12 2c): judgeMachineVerdict 결과({effective, demoted, corrected, reasonKey, parse}).
// 전달되면 처리 의무를 '실효 판정'으로 선택하고 강등·정정 사유 줄을 footer에 넣는다(core에서만 호출자가 전달 —
// 미전달 호출은 기존과 바이트 동일=무회귀). 강등 시 표지 줄이 없어도 footer를 강제한다(fail-closed 구멍 봉합).
function formatForClaude(answer, lang, profile, machine) {
  const text = String(answer || "");
  const en = (LANGS.includes(lang) ? lang : loadLang()) === "en";
  const table = profile === "core" ? (en ? VERDICT_ACTION_CORE_EN : VERDICT_ACTION_CORE) : (en ? VERDICT_ACTION_EN : VERDICT_ACTION);
  const m = machine && typeof machine === "object" && machine.effective ? machine : null;
  const action = table[m ? m.effective : extractVerdict(text)];
  if (!action) return text; // 결론 표지 못 찾음(null)·machine 없음 → 원문 그대로(나서서 자르지 않음)
  const lines = text.split(/\r?\n/);
  // '판정으로 분류되는 줄'만 선언으로 본다 = 그 줄 하나로 extractVerdict가 non-null. VERDICT_DECL_RE 단독 매칭보다 보수적 —
  // "검증: 이 함수는 A 경로에서만 호출됨"처럼 검증:로 시작해도 판정어(통과/실패/보류/불가…)가 없는 설명 줄은 본문에 보존한다.
  // extractVerdict(전체)와 같은 기준이라 '판정에 쓰인 줄 = 제거되는 줄'로 일관(footer엔 마지막 선언 원문 보존). 대시보드는 rollout 원문이라 손실 없음.
  const isDecl = (l) => extractVerdict(l) !== null;
  let verdictLine = "";
  for (const l of lines) if (isDecl(l)) verdictLine = l.trim(); // 마지막 판정 선언 줄(extractVerdict 전체 결과를 만든 그 줄)
  // 2c tail 결속(구현검증 2차 blocker①): machine이 오면 'Codex 선언'도 블록 뒤 판정만 표시 — 블록 앞 옛 선언을
  // 권위 있는 선언처럼 재노출하지 않는다(tail 부재='(표지 줄 없음)' — 강등 사유와 일관).
  if (m && m.parse && m.parse.present && m.parse.ok) verdictLine = m.parse.tailVerdictLine || "";
  // 판정 선언 줄만 제거하고 끝의 빈 줄만 정돈한다. 전역 공백/개행 정규화는 하지 않는다(md hard break·코드블록·의도적 공백 보존).
  const body = lines.filter((l) => !isDecl(l)).join("\n").trimEnd();
  let machineLine = "";
  if (m && m.demoted) machineLine = en
    ? `\nMachine reading: ${machineReasonText(m, true)} — verdict demoted to 'inconclusive' (fail-closed).`
    : `\n기계 판독: ${machineReasonText(m, false)} — 판정을 '보류'로 강등(fail-closed).`;
  else if (m && m.corrected) machineLine = en
    ? `\nMachine reading: ${machineReasonText(m, true)} — 'pass' corrected to 'pass (notes)'.`
    : `\n기계 판독: ${machineReasonText(m, false)} — '통과' 선언을 '통과(보완)'로 정정.`;
  return en
    ? `${body}\n\n---\n[Claude handling note — next action, not a color label]\nCodex declared: ${verdictLine || "(no verdict line)"}${machineLine}\nObligation: ${action}`
    : `${body}\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: ${verdictLine || "(표지 줄 없음)"}${machineLine}\n처리 의무: ${action}`;
}

module.exports = { loadContract, patchContractFields, buildInjection, buildVerifyDirective, buildScoutDirective, rankScoutItems, changedFilesFor, computeScoutHealthMini, scoutHealthLine, HEALTH_MIN_SAMPLE, SCOUT_FORMAT_VERSION, scoutBaselineDefaultFor, scoutBaselineFileFor, loadScoutBaseline, saveScoutBaseline, resetScoutBaseline, buildScoutPreface, scoutPromptSignature, extractMapHighlights, extractMapPatches, buildScoutAttach, resolveScoutRepo, withFileLockStrict, withRoleLock, ledgerCouplingCandidates, ledgerItemId, miniLedgerEntries, mapLooksValid, nonGitChangedSince, ledgerSig, appendLedgerEvent, readLedgerEventsText, ledgerPathsFromText, ledgerEventsFileFor, LEDGER_EVENTS_DIR, LEDGER_EVENTS_CAP, LEDGER_EVENTS_TRIM_AT, scoutMapStatus, wsKeyFor, BACKLOG_DIR, backlogFileFor, normBacklogTitle, normBacklogFile, backlogId, foldBacklogRaw, readBacklog, backlogAdd, backlogSetStatus, backlogClearDone, updateContractPatch, withContractLockV10, quarantineContractLock, parseLockToken, SCOUTS_DIR, SCOUT_ADVICE_DIR, VERIFY_MODES, HARNESS_MODES, normHarnessMode, VERIFY_PROFILES, normVerifyProfile, normCodexVerifyProfile, effectiveVerifyProfile, normVerifyBudget, normCodexVerifyBudget, effectiveVerifyBudget, CAMPAIGN_DIR, CAMPAIGN_CORRUPT_DIR, CAMPAIGN_HISTORY_DAYS, campaignFileFor, campaignHistoryFileFor, claudeCampaignAnchor, reserveVerifyCampaign, findCampaignInHistory, BASE_CORE, BASE_CORE_EN, FINDINGS_MARKERS, normFindingTag, parseFindingsBlock, judgeMachineVerdict, safeBacklogAutoTitle, safeBacklogAutoFile, machineReasonText, SCOUT_MODES, SCOUT_GATES, normScoutGate, normScoutMode, readScoutTargetEvidence, appendScoutTargetEvidence, detectScoutTargetDrift, gitTopLevelFor, changedEntriesFor, scoutEvidenceFileFor, askInflightGuard, askInflightFileFor, claimAskInflight, reclaimAskInflight, overwriteAskInflight, clearAskInflight, ASKS_INFLIGHT_DIR, INFLIGHT_TTL_MS, askActiveFileFor, readAskActive, askActiveGuard, claimAskActive, updateAskActive, clearAskActive, ASK_ACTIVE_DIR, SCOUT_TARGET_EVIDENCE_DIR, EVIDENCE_KEEP, CONTRACT_FILE, CONTRACTS_DIR, contractFileFor, normWs, currentWs, configWs, codexActiveFileFor, writeCodexActive, readCodexActive, registerCodexImplementer, CODEX_ACTIVE_DIR, CODEX_ACTIVE_FILE, BRIDGE, BRIDGE_DIR, BASE_DEFAULTS, BASE_DEFAULTS_EN, baseDefaultsFor, baseDirectiveFileFor, BASE_DIRECTIVE_FILE, loadBaseDirective, saveBaseDirective, resetBaseDirective, LANG_FILE, LANGS, loadLang, saveLang, verifyTimeoutMin, atomicWrite, INTEGRITY_FILE, readIntegrityEvents, appendIntegrityEvent, ackIntegrityEvents, supersedeIntegrity, withIntegrityLock, PHASE_FILE, readPhase, writePhase, PROOFS_DIR, ATTEMPTS_DIR, ACTIVE_DIR, PROOF_TTL_MS, ATTEMPTS_TTL_MS, ACTIVE_TTL_MS, cleanupOldState, maybeCleanupState, extractVerdict, formatForClaude, appendVerdict, trimVerdicts, appendScoutUsage, trimScoutUsage, SCOUT_USAGE_FILE, STATS_DIR, VERDICTS_FILE };
module.exports.codexImplementerSession = codexImplementerSession;
module.exports.codexImplementerSnapshot = codexImplementerSnapshot;
// P-6 회수 영수증 계약(설계 v5.1)
module.exports.CODEX_TURNS_DIR = CODEX_TURNS_DIR;
module.exports.CODEX_RECOVERY_DIR = CODEX_RECOVERY_DIR;
module.exports.askJobIdOk = askJobIdOk;
module.exports.recoveryReceiptFileFor = recoveryReceiptFileFor;
module.exports.proofFileForSession = proofFileForSession;
module.exports.implementerRecordOf = implementerRecordOf;
module.exports.readImplementerRecordLocked = readImplementerRecordLocked;
module.exports.readCodexTurnStrict = readCodexTurnStrict;
module.exports.freezeImplementerContext = freezeImplementerContext;
module.exports.gitHeadState = gitHeadState;
module.exports.strictProofV2 = strictProofV2;
module.exports.strictReceiptV1 = strictReceiptV1;
module.exports.durableJobSnapshotOk = durableJobSnapshotOk;
module.exports.writeDurableProofV2 = writeDurableProofV2;
module.exports.writeRecoveryReceipt = writeRecoveryReceipt;
module.exports.durableProofGate = durableProofGate;
module.exports.sha256Hex = sha256Hex;
module.exports.contractReadState = contractReadState;
// P-9 자동 전환(질문 호스트 기준) 안전 판정
module.exports.activeAskJobFor = activeAskJobFor;
module.exports.phaseBusy = phaseBusy;
module.exports.contractLockIssue = contractLockIssue;
module.exports.validLinksShape = validLinksShape;
module.exports.receiptSettled = receiptSettled;
module.exports.codexRoleRevision = codexRoleRevision;
