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
const INTEGRITY_FILE = path.join(BRIDGE_DIR, "integrity.json"); // 무결성 신호 채널(브릿지/verify-guard 기록 → 확장이 상태바/대시보드로 가시화). BRIDGE_DIR 직하(확장 fs.watch 안정).
const PHASE_FILE = path.join(BRIDGE_DIR, "phase.json"); // 검증 파이프라인 현재 단계(라이브 진행 표시). 훅/브릿지가 경계에서 기록 → 확장이 읽어 상태바·진행 스트립에 표시.
const PROOFS_DIR = path.join(BRIDGE_DIR, "proofs"); // 검증 증명(세션별). 시간 지나면 쌓이므로 TTL 정리 대상.
const ATTEMPTS_DIR = path.join(BRIDGE_DIR, "verify-attempts"); // 한 턴 재검증 횟수(세션별, 단명). TTL 정리 대상.
const ACTIVE_DIR = path.join(BRIDGE_DIR, "active"); // 세션별 active(연 폴더 앵커, active/<claudeSession>.json). 멀티창에서 단일 active.json이 덮이는 레이스 방지. TTL 정리 대상.
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
  sweep(path.join(BRIDGE_DIR, "scout-gate-attempts"), ATTEMPTS_TTL_MS); // 게이트 세션 카운터 — 검증 재시도와 같은 7일(단명 상태)
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
function appendIntegrityEvent(ev) {
  const events = readIntegrityEvents();
  const id = `${(ev && ev.ts) || ""}_${Math.random().toString(36).slice(2, 8)}`; // 일반 node(워크플로 아님)라 Math.random OK
  events.push(Object.assign({ id, ack: false }, ev));
  return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events: events.slice(-50) })); // 최근 50건 상한
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
  const events = readIntegrityEvents();
  const set = ids === "all" || !ids ? null : new Set(ids);
  for (const e of events) { if (!set || set.has(e.id)) e.ack = true; }
  return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events }));
}
// 같은 세션의 직전 특정 kind 신호를 '새 결과가 나왔으니' 대체(supersede)한다. verdict는 누적이 아니라 '최신 상태'다 —
// 한 턴에 실패→수정→통과로 해소되면 직전 실패/보류 노랑도 사라져야 한다(반복 검증이 무조건 노랑을 남기는 cry-wolf 방지).
// 미확인(ack 안 됨) + 같은 session + 같은 kind인 것만 제거한다(확인한 것·다른 세션·다른 kind는 보존). 세션 미상이면 안 건드림.
function supersedeIntegrity(session, kind) {
  if (!session) return false; // 세션 모르면 섣불리 안 지움 — 다른 대화의 신호를 잘못 지우지 않게
  const events = readIntegrityEvents();
  const kept = events.filter((e) => !(!e.ack && e.kind === kind && e.session === session));
  if (kept.length === events.length) return true; // 지울 것 없음(무변경 성공)
  return atomicWrite(INTEGRITY_FILE, JSON.stringify({ events: kept }));
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
  return opts.cwd || process.cwd();
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
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    // 체크리스트 강제: 기본 true(기존 동작 보존). 해제 시 규약만 주입.
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    // 검증 모드: off=꺼짐 / code=코드변경 시 / plancode=플랜확정(ExitPlanMode)+코드변경 시 / always=모든 턴.
    // 기본 off(opt-in). 구버전 verify:true는 code로 마이그레이션.
    verifyMode: normVerifyMode(o),
    // 사용자 계약 주입 시점: off / plan(플랜 모드일 때만) / always(기본·무회귀). 확장과 동일 규칙.
    claudeInjectMode: normInjectMode(o),
    // 트랙: off=2트랙(구현↔검증, 기본·무회귀) / on=3트랙(탐색 leg 켬 — 범위 장부 advisory. SCOPE-LEDGER.md).
    // 브릿지는 아직 미사용(확장 대시보드 전용)이나 스키마 정합을 위해 양쪽 normalize(한쪽만 빠지면 동작 갈림 — SCOUT-TRACK 교훈).
    scoutMode: normScoutMode(o),
    scoutGate: normScoutGate(o), // 게이트(⑥ 실험) — off|plan. 확장 saveContract는 이 필드를 보존해야 함(스키마 정합)
    scoutRepo: typeof o?.scoutRepo === "string" ? o.scoutRepo.trim() : "", // 정찰 대상 레포(P1 — cwd≠repo 해소). 빈 값=ws 그대로
  };
}

const VERIFY_MODES = ["off", "code", "plancode", "always"];
function normVerifyMode(o) {
  if (o && VERIFY_MODES.includes(o.verifyMode)) return o.verifyMode;
  if (o && o.verify === true) return "code"; // 레거시 호환
  return "off";
}

const INJECT_MODES = ["off", "plan", "always"];
function normInjectMode(o) {
  if (o && INJECT_MODES.includes(o.claudeInjectMode)) return o.claudeInjectMode;
  return "always"; // 기본=항상(무회귀). 누락 시 기존 동작 유지.
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
    const raw = c && typeof c.scoutRepo === "string" ? c.scoutRepo.trim() : "";
    if (!raw) return { repo: ws, source: "ws" };
    if (!path.isAbsolute(raw)) return { repo: ws, source: "ws-fallback-invalid" }; // 상대경로 금지 — 훅·확장·CLI의 cwd가 제각각이라 기준이 흔들림(절대경로만 허용)
    const abs = path.resolve(raw);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return { repo: abs, source: "contract" };
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
// TTL은 pid 생존 판정의 '보조'(좀비·pid 재사용 방어)일 뿐이며 검증 대기 최대치(60분)보다 커야 한다 —
// Codex 반례: 30분이면 살아있는 정상 장기 검증의 후반이 무방비.
const INFLIGHT_TTL_MS = 90 * 60 * 1000;
// 파일은 ws+요청 지문별 1개(Codex 반례: ws당 1개면 A 진행→B 기록→A 재전송이 통과) — 다른 내용 병렬은 파일이 달라 자연 허용.
function askInflightFileFor(ws, hash) { return path.join(ASKS_INFLIGHT_DIR, wsKeyFor(ws) + "-" + String(hash || "") + ".json"); }
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
function scoutMapStatus(ws) {
  const dir = path.join(SCOUTS_DIR, wsKeyFor(ws));
  let bases = [];
  try { bases = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().reverse(); } catch { /* 보관함 없음 */ }
  if (!bases.length) return { state: "no-map", base: null, staleCount: 0, seedChanged: 0, commitsAfter: 0, dirtyChanged: 0 };
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, bases[0] + ".json"), "utf8")); } catch { /* 메타 없음 — 낡음 판정 불가 → fresh 취급(과잉 지시 방지) */ }
  const ts = Date.parse(meta.basisTs || meta.ts || "") || 0; // basisTs=꾸러미 수집 시점(지도가 본 입력) — AI 응답 대기(수 분) 중 변경을 놓치지 않게(Codex 반례). 구형 메타는 ts 폴백
  // legacy 판정은 '기록 자체가 없던 구버전'만 — seedFiles 속성 부재/비배열. 명시적 빈 배열([])은 최신 러너가
  // '변경 없는 작업트리'에서 정상적으로 만들 수 있는 형식이라 legacy가 아니다(Codex 반례 2026-07-08: 빈 배열을
  // 구버전으로 오판하면 방금 만든 지도에 '재생성 권고'를 반복하는 거짓 안내가 됨) → fresh 취급(판정 근거 없음=과잉 지시 방지).
  if (ts && !Array.isArray(meta.seedFiles)) return { state: "legacy-no-seeds", base: bases[0], staleCount: 0, seedChanged: 0, commitsAfter: 0, dirtyChanged: 0 };
  const seeds = (meta.seedFiles || []).slice(0, 8);
  let seedChanged = 0;
  // 삭제 판정 기준선: seedFiles에는 '지도 생성 당시 이미 삭제돼 있던 경로'(삭제 diff의 seed)도 들어간다 —
  // 무조건 '없음=지도 뒤 삭제'로 세면 새 지도가 즉시 stale(Codex 반례). 신형 메타(seedMissing 기록)만
  // '당시 존재했던 seed의 소실'을 변경으로 세고, 구형 메타는 옛 동작(제외 — 무회귀·과잉 지시 방지).
  const missingAtMap = new Set(Array.isArray(meta.seedMissing) ? meta.seedMissing : null);
  for (const s of seeds) {
    try { if (fs.statSync(path.join(ws, s)).mtimeMs > ts) seedChanged++; }
    catch { if (Array.isArray(meta.seedMissing) && !missingAtMap.has(s)) seedChanged++; }
  }
  let commitsAfter = 0;
  if (ts && typeof meta.head === "string" && /^[0-9a-f]{7,40}$/i.test(meta.head)) {
    try {
      const r = require("child_process").spawnSync("git", ["-c", "safe.directory=" + String(ws).replace(/\\/g, "/"), "-C", ws, "rev-list", "--count", meta.head + "..HEAD"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      if (r.status === 0) commitsAfter = Math.min(parseInt(String(r.stdout).trim(), 10) || 0, 999);
    } catch { /* git 없음/실패 — 신호 0 */ }
  }
  let dirtyChanged = 0;
  if (ts) {
    const seedSet = new Set(seeds.map((s) => { try { return normWs(path.join(ws, s)); } catch { return s; } }));
    for (const e of changedEntriesFor(ws)) {
      const abs = path.join(ws, e.rel);
      if (seedSet.has(normWs(abs))) continue; // seed와 중복 카운트 방지
      if (/D/.test(e.code)) { dirtyChanged++; continue; } // 삭제는 mtime이 없음 — 상태 코드로 판정(Codex 반례)
      try { if (fs.statSync(abs).mtimeMs > ts) dirtyChanged++; } catch { dirtyChanged++; /* stat 실패(방금 사라짐 등)도 변경 신호 */ }
    }
  }
  const staleCount = seedChanged + commitsAfter + dirtyChanged;
  return { state: ts && staleCount > 0 ? "stale" : "fresh", base: bases[0], staleCount, seedChanged, commitsAfter, dirtyChanged };
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
      const cur = rs.source === "contract"
        ? (en2 ? "the contract-set target " + target : "계약에 지정된 " + target)
        : (en2 ? "unset, so the session folder (" + target + ") is being used" : "미지정이라 세션 폴더(" + target + ") 기준");
      if (en2) return "[Recon (3-track) auto-directive · target mismatch suspected · this suggestion once] In the last " + drift.sample + " verification(s), " + drift.agree + " cited mostly files under " + drift.repo + ", but the scout target is " + cur + ". If " + drift.repo + " is the actual dev repo, run from the codex-peek source repo: `node scripts/scope-target.js \"" + ws + "\" set \"" + drift.repo + "\"` (this writes scoutRepo into this project's contract file for the current language slot — other language modes are configured separately), then `node scripts/scope-scout-self.js \"" + drift.repo + "\"` for a map. If not, ignore this (advisory — nothing is blocked).";
      return "[탐색(3트랙) 자동 지시 · 대상 어긋남 의심 · 이 제안 1회만] 최근 검증 " + drift.sample + "회 중 " + drift.agree + "회가 " + drift.repo + " 소속 파일을 주로 인용했는데, 정찰 대상은 " + cur + "다. 실제 개발 레포가 " + drift.repo + " 가 맞으면 codex-peek 소스 저장소에서 `node scripts/scope-target.js \"" + ws + "\" set \"" + drift.repo + "\"` 를 실행해 대상을 지정하고(이 프로젝트 계약 파일의 현재 언어 슬롯에 scoutRepo가 저장됨 — 다른 언어 모드는 별도 설정), 이어서 `node scripts/scope-scout-self.js \"" + drift.repo + "\"` 로 지도를 받아라. 아니라면 무시해도 된다(참고용 — 아무것도 막지 않는다).";
    }
  } catch { /* 자기진단 실패가 기존 신선도 지시를 못 막음 */ }
  const st = scoutMapStatus(target);
  if (st.state === "fresh") return null;
  const bucket = st.state === "stale" ? scoutBucket(st.staleCount) : 0;
  const f = path.join(SCOUT_ADVICE_DIR, wsKeyFor(target) + ".json");
  let prev = null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    if (raw && typeof raw === "object") {
      if (typeof raw.sig === "string") { // 구버전 형식 해석
        prev = raw.sig === "no-map" ? { state: "no-map", base: null, maxBucket: 0 }
          : raw.sig.startsWith("stale:") ? { state: "stale", base: raw.sig.slice(6), maxBucket: 1 }
          : raw.sig.startsWith("legacy:") ? { state: "legacy-no-seeds", base: raw.sig.slice(7), maxBucket: 0 }
          : null;
      } else if (typeof raw.state === "string") prev = { state: raw.state, base: raw.base || null, maxBucket: (raw.maxBucket | 0) || 0 };
    }
  } catch { /* 첫 지시 */ }
  if (prev && prev.state === st.state && prev.base === st.base && bucket <= prev.maxBucket) return null; // 같은 상태·정도 이하 → 침묵
  if (prev && prev.state === st.state && prev.base === st.base && st.state !== "stale") return null;      // no-map/legacy는 상태당 1회
  try { atomicWrite(f, JSON.stringify({ state: st.state, base: st.base, maxBucket: Math.max(bucket, prev && prev.base === st.base ? prev.maxBucket : 0), ts: new Date().toISOString() })); } catch { /* 기억 실패 시 다음 턴 재지시 — 무해 */ }
  let hasKey = false;
  try { const j = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "deepseek.json"), "utf8")); hasKey = !!(j && typeof j.apiKey === "string" && j.apiKey.trim()); } catch { /* 키 없음 */ }
  const en = loadLang() === "en"; // 훅 주입문도 전역 언어 준수(한/영 쌍 규칙 — 2026-07-09 사용자 지적)
  const why = st.state === "no-map"
    ? (en ? "this project has no impact map yet" : "이 프로젝트에 영향지도가 아직 없다")
    : st.state === "legacy-no-seeds"
    ? (en ? "the latest map has no basis-file record, so freshness cannot be judged (map predates basis tracking) — regeneration recommended" : "최신 지도에 근거 파일 기록이 없어 신선한지 낡았는지 판정할 수 없다(근거 기록 도입 전의 구버전 지도) — 재생성 권고")
    : (en ? st.staleCount + " change signal(s) since the latest map (basis files " + st.seedChanged + " · new commits " + st.commitsAfter + " · working tree " + st.dirtyChanged + ") — the map is stale" : "최신 지도 이후 변경 신호 " + st.staleCount + "건(근거 파일 " + st.seedChanged + " · 새 커밋 " + st.commitsAfter + " · 작업트리 " + st.dirtyChanged + ") — 지도가 낡았다");
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
    fs.appendFileSync(f, JSON.stringify(ev) + "\n", "utf8");
    try {
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length > LEDGER_EVENTS_TRIM_AT) {
        // 판정·복권 증거를 '우선' 보존(2026-07-09 확정 결함 2건 방지): ①판정(반박·차단·고정·대체·소멸류)만 잘리고
        // 재제안이 남으면 '틀림' 딱지가 부활 ②반대로 반박만 보존되고 복권 증거(사람 재확인·반박 이후 검증 확인)가
        // 잘리면 복권이 조용히 풀림(Codex 반례) — 사람 재확인(user_confirm)은 판정군과 동급 보존, 기계 확인(confirmed)은
        // '그 항목의 마지막 반박 이후'만 복권 증거로 보존(전부 보존하면 확인 홍수가 상한을 삼킴).
        // 단 총량은 상한(2000)을 절대 넘지 않는다(PRIVACY '약 2,000줄 보존' 고지 불침 — 극단에선 보존군도 최신순).
        const STATE = new Set(["user_dispute", "refuted", "banned", "unbanned", "pinned", "unpinned", "superseded", "tombstone", "user_confirm"]);
        const parsedLines = lines.map((ln) => { try { return JSON.parse(ln); } catch { return null; } });
        const lastDisputeIdx = new Map();
        parsedLines.forEach((o, i) => { if (o && (o.type === "user_dispute" || o.type === "refuted")) lastDisputeIdx.set(o.sig, i); });
        const isKeepFirst = parsedLines.map((o, i) => {
          if (!o) return false;
          if (STATE.has(o.type)) return true;
          return o.type === "confirmed" && lastDisputeIdx.has(o.sig) && i > lastDisputeIdx.get(o.sig); // 복권 증거
        });
        let firstKeep = Math.min(isKeepFirst.filter(Boolean).length, LEDGER_EVENTS_CAP);
        let othersKeep = LEDGER_EVENTS_CAP - firstKeep;
        const kept = [];
        for (let i = lines.length - 1; i >= 0; i--) {
          if (isKeepFirst[i]) { if (firstKeep > 0) { kept.push(lines[i]); firstKeep--; } }
          else if (othersKeep > 0) { kept.push(lines[i]); othersKeep--; }
        }
        atomicWrite(f, kept.reverse().join("\n") + "\n");
      }
    } catch { /* 트림 실패 — 다음 append에서 재시도(적재 자체는 성공) */ }
    return true;
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
    ? (en ? ` · STALE: ${st.staleCount} change signal(s) since (basis ${st.seedChanged} · commits ${st.commitsAfter} · working tree ${st.dirtyChanged})` : ` · 낡음: 생성 후 변경 신호 ${st.staleCount}건(근거 ${st.seedChanged} · 커밋 ${st.commitsAfter} · 작업트리 ${st.dirtyChanged})`)
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
  return [head, ...items.map((i) => `- ${i.path}${i.note && String(i.note) !== i.path ? ` — ${String(i.note).slice(0, 120)}` : ""}`), tail, ...(health ? [health] : [])].join("\n");
}

// ── Scout Health 미니 집계(배포 사본 — 정본은 src/ledger-events.ts computeScoutHealth. out/을 require 못 하는
// 배포 관례상 원시 JSONL을 직접 항목(entry) 단위로 집계하며, tests/scout-health.test.js가 정본과 패리티를 잠근다).
// 용어 잠금: '정확도' 금지 — '관찰 신호'. attached는 '다음 꾸러미 재동봉' 사건(검증자 열람 인과 아님)이고 이벤트 선후도 안 보므로 순서('후')를 주장하지 않는 지표명만 쓴다.
const HEALTH_EVENT_TYPES = new Set(["proposed", "attached", "confirmed", "refuted", "user_confirm", "user_dispute", "pinned", "unpinned", "banned", "unbanned", "superseded", "tombstone", "exported"]); // 정본 parseEventsJsonl의 allowlist와 동형 — 미지 타입이 표본 수를 부풀리지 못하게(Codex 반례)
function computeScoutHealthMini(raw) {
  const per = new Map(); // sig → {att, conf, disp, status 재료}
  for (const ln of String(raw || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (!o || !o.sig || !o.type || !HEALTH_EVENT_TYPES.has(o.type)) continue;
    let e = per.get(o.sig);
    if (!e) { e = { att: 0, conf: 0, disp: 0, ban: 0, unban: 0, sup: 0, tomb: 0, afterV: 0, afterU: 0, everDisp: false }; per.set(o.sig, e); }
    if (o.type === "attached") e.att++;
    else if (o.type === "confirmed") { e.conf++; if (e.everDisp) e.afterV++; }
    else if (o.type === "user_confirm") { e.conf++; if (e.everDisp) e.afterU++; }
    else if (o.type === "user_dispute" || o.type === "refuted") { e.disp++; e.everDisp = true; e.afterV = 0; e.afterU = 0; }
    else if (o.type === "banned") e.ban++;
    else if (o.type === "unbanned") e.unban++;
    else if (o.type === "superseded") e.sup++;
    else if (o.type === "tombstone") e.tomb++;
  }
  const h = { entries: per.size, verified: 0, reusedDen: 0, reusedNum: 0, disputedEntries: 0, rehabilitated: 0 };
  for (const e of per.values()) {
    const dead = (e.ban - e.unban) > 0 || e.sup > 0 || e.tomb > 0;
    const rehab = e.everDisp && !dead && (e.afterU >= 1 || e.afterV >= 2); // DERIVE_V1 복권 규칙과 동형(패리티 테스트 잠금)
    const verified = !dead && (e.everDisp ? rehab : e.conf >= 1);
    if (verified) h.verified++;
    if (e.att > 0) { h.reusedDen++; if (e.conf > 0) h.reusedNum++; }
    if (e.everDisp) h.disputedEntries++;
    if (rehab) h.rehabilitated++;
  }
  return h;
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
    const ratio = h.reusedDen >= HEALTH_MIN_SAMPLE ? ` · ${en ? "reused items with a confirm on record" : "재사용 항목 중 확인 이력"} ${h.reusedNum}/${h.reusedDen}` : "";
    return en
      ? `[Scout observation signal — this project] confirmed items ${h.verified}/${h.entries}${ratio} · disputed ${h.disputedEntries} (manually recorded) · rehabilitated ${h.rehabilitated}. Bias can go both ways (no automatic dispute extraction = disputes undercounted; map-attached exposure = confirms overcounted — logic audit 2026-07-10) — still, the map is a candidate list, not a safety guarantee: keep independent checks outside it.`
      : `[정찰 관찰 신호 — 이 프로젝트 기준] 확인 항목 ${h.verified}/${h.entries}${ratio} · 반박 ${h.disputedEntries}건(수동 기록 기준) · 복권 ${h.rehabilitated}건. 집계 편향은 양방향일 수 있다(자동 반박이 없어 반박은 적게 잡히고, 지도에 실려 노출된 항목은 확인이 잘 잡힘 — 논리 점검 2026-07-10) — 지도는 후보 목록이지 안전 보장이 아니다: 지도 밖 독립 확인을 유지하라.`;
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
function loadBaseDirective(lang) {
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
function buildVerifyDirective(mode, lang) {
  const l = LANGS.includes(lang) ? lang : loadLang();
  const b = loadBaseDirective(l);
  if (l === "en") {
    const cond =
      mode === "always" ? "This turn (every response)" :
      mode === "plancode" ? "If this turn confirmed a plan (ExitPlanMode) or created/modified files" :
      "If this turn created/modified files"; // code
    return [
      `[Verify Mode ON(${mode}) · implement→verify two-track · no human relays between the models]`,
      `${cond}, you MUST get Codex verification via \`node "${BRIDGE}" ask --allow-new "..."\` before reporting completion to the user. (If a Codex session is linked, it continues that session; otherwise it creates and links a new one.) [path is quoted so spaces are safe]`,
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
    `${cond}, 사용자에게 완료를 보고하기 전에 반드시 \`node "${BRIDGE}" ask --allow-new "..."\` 로 Codex 검증을 받아라. (연결된 Codex 세션이 있으면 그 세션으로 이어가고, 없으면 새 세션을 만들어 연결한다.) [경로에 공백이 있어도 되도록 따옴표로 감쌌음]`,
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
function formatForClaude(answer, lang) {
  const text = String(answer || "");
  const en = (LANGS.includes(lang) ? lang : loadLang()) === "en";
  const action = (en ? VERDICT_ACTION_EN : VERDICT_ACTION)[extractVerdict(text)];
  if (!action) return text; // 결론 표지 못 찾음(null) → 원문 그대로(나서서 자르지 않음)
  const lines = text.split(/\r?\n/);
  // '판정으로 분류되는 줄'만 선언으로 본다 = 그 줄 하나로 extractVerdict가 non-null. VERDICT_DECL_RE 단독 매칭보다 보수적 —
  // "검증: 이 함수는 A 경로에서만 호출됨"처럼 검증:로 시작해도 판정어(통과/실패/보류/불가…)가 없는 설명 줄은 본문에 보존한다.
  // extractVerdict(전체)와 같은 기준이라 '판정에 쓰인 줄 = 제거되는 줄'로 일관(footer엔 마지막 선언 원문 보존). 대시보드는 rollout 원문이라 손실 없음.
  const isDecl = (l) => extractVerdict(l) !== null;
  let verdictLine = "";
  for (const l of lines) if (isDecl(l)) verdictLine = l.trim(); // 마지막 판정 선언 줄(extractVerdict 전체 결과를 만든 그 줄)
  // 판정 선언 줄만 제거하고 끝의 빈 줄만 정돈한다. 전역 공백/개행 정규화는 하지 않는다(md hard break·코드블록·의도적 공백 보존).
  const body = lines.filter((l) => !isDecl(l)).join("\n").trimEnd();
  return en
    ? `${body}\n\n---\n[Claude handling note — next action, not a color label]\nCodex declared: ${verdictLine || "(no verdict line)"}\nObligation: ${action}`
    : `${body}\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: ${verdictLine || "(표지 줄 없음)"}\n처리 의무: ${action}`;
}

module.exports = { loadContract, buildInjection, buildVerifyDirective, buildScoutDirective, rankScoutItems, changedFilesFor, computeScoutHealthMini, scoutHealthLine, HEALTH_MIN_SAMPLE, SCOUT_FORMAT_VERSION, scoutBaselineDefaultFor, scoutBaselineFileFor, loadScoutBaseline, saveScoutBaseline, resetScoutBaseline, buildScoutPreface, scoutPromptSignature, extractMapHighlights, extractMapPatches, buildScoutAttach, resolveScoutRepo, ledgerSig, appendLedgerEvent, readLedgerEventsText, ledgerPathsFromText, ledgerEventsFileFor, LEDGER_EVENTS_DIR, LEDGER_EVENTS_CAP, LEDGER_EVENTS_TRIM_AT, scoutMapStatus, wsKeyFor, SCOUTS_DIR, SCOUT_ADVICE_DIR, VERIFY_MODES, SCOUT_MODES, SCOUT_GATES, normScoutGate, normScoutMode, readScoutTargetEvidence, appendScoutTargetEvidence, detectScoutTargetDrift, gitTopLevelFor, changedEntriesFor, scoutEvidenceFileFor, askInflightGuard, askInflightFileFor, claimAskInflight, reclaimAskInflight, overwriteAskInflight, clearAskInflight, ASKS_INFLIGHT_DIR, INFLIGHT_TTL_MS, SCOUT_TARGET_EVIDENCE_DIR, EVIDENCE_KEEP, CONTRACT_FILE, CONTRACTS_DIR, contractFileFor, normWs, currentWs, configWs, BRIDGE, BRIDGE_DIR, BASE_DEFAULTS, BASE_DEFAULTS_EN, baseDefaultsFor, baseDirectiveFileFor, BASE_DIRECTIVE_FILE, loadBaseDirective, saveBaseDirective, resetBaseDirective, LANG_FILE, LANGS, loadLang, saveLang, atomicWrite, INTEGRITY_FILE, readIntegrityEvents, appendIntegrityEvent, ackIntegrityEvents, supersedeIntegrity, PHASE_FILE, readPhase, writePhase, PROOFS_DIR, ATTEMPTS_DIR, ACTIVE_DIR, PROOF_TTL_MS, ATTEMPTS_TTL_MS, ACTIVE_TTL_MS, cleanupOldState, maybeCleanupState, extractVerdict, formatForClaude, appendVerdict, trimVerdicts, appendScoutUsage, trimScoutUsage, SCOUT_USAGE_FILE, STATS_DIR, VERDICTS_FILE };
