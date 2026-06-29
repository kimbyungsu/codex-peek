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
const BASE_DIRECTIVE_FILE = path.join(BRIDGE_DIR, "base-directive.json"); // 기본 지침 사용자 오버라이드(없으면 코드 기본값)
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
function contractFileFor(ws) {
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  return path.join(CONTRACTS_DIR, key + ".json");
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
function loadContract(ws) {
  const read = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const o = read(contractFileFor(ws || currentWs())) || {}; // CONTRACT_FILE(전역) 폴백 제거 — 미설정 프로젝트는 빈 계약(상속 X)
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

// rules(문자열 배열) → 매 턴 주입 텍스트. checklist=false면 규약만, true면 [계약점검] 강제.
// 비어 있으면 "" 반환(주입 비용 0).
function buildInjection(rules, who, checklist) {
  const r = (rules || []).map((s) => String(s).trim()).filter(Boolean);
  if (!r.length) return "";
  const json = JSON.stringify({ rules: r.map((t, i) => ({ n: i + 1, r: t })) });
  if (!checklist) {
    // 체크 해제: 규약/지침만 상수로 주입 (TODO 강제 없음).
    return [`[고정 규약 · ${who} · 매 턴 적용되는 상수 — 무시·생략 금지]`, json].join("\n");
  }
  // 체크: TODO 리스트로 펼쳐 각 항목 준수/위반+근거 강제.
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
    "- 검증 요청을 요약/생략하지 마라. 관련 파일 경로·확인 지점을 구체적으로 적어 검증모델이 원본을 직접 열게 하라.",
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

// 기본 지침 로드: 오버라이드 파일의 비지 않은 항목만 기본값을 대체.
function loadBaseDirective() {
  let o = {};
  try {
    o = JSON.parse(fs.readFileSync(BASE_DIRECTIVE_FILE, "utf8"));
  } catch {
    o = {};
  }
  const pick = (k) => (o && typeof o[k] === "string" && o[k].trim() ? o[k] : BASE_DEFAULTS[k]);
  return { verifyBaseline: pick("verifyBaseline"), transmit: pick("transmit"), rejudge: pick("rejudge") };
}
// 기본값과 같은 항목은 저장하지 않음(빈 오버라이드=기본값). 전부 기본이면 파일 삭제(=초기화).
function saveBaseDirective(obj) {
  const out = {};
  for (const k of ["verifyBaseline", "transmit", "rejudge"]) {
    const v = obj && typeof obj[k] === "string" ? obj[k] : "";
    if (v.trim() && v.trim() !== BASE_DEFAULTS[k].trim()) out[k] = v;
  }
  fs.mkdirSync(BRIDGE_DIR, { recursive: true });
  if (Object.keys(out).length === 0) {
    // 전부 기본값이면 오버라이드 파일을 지움 = 초기화. 이미 없으면(ENOENT) 그것도 성공(원하는 상태).
    try { fs.unlinkSync(BASE_DIRECTIVE_FILE); } catch (e) { if (e && e.code !== "ENOENT") return false; }
    return true;
  }
  return atomicWrite(BASE_DIRECTIVE_FILE, JSON.stringify(out, null, 2));
}
function resetBaseDirective() {
  // 오버라이드 파일 삭제 = 기본값 복원. 이미 없으면(ENOENT) 그것도 성공(원하는 상태). 권한 오류만 false.
  try { fs.unlinkSync(BASE_DIRECTIVE_FILE); } catch (e) { if (e && e.code !== "ENOENT") return false; }
  return true;
}

// 검증 모드 ON일 때 Claude(구현모델)에게 매 턴 주입하는 2트랙 지시. 전달원칙·재판단은 기본 지침에서 로드(오버라이드 가능).
function buildVerifyDirective(mode) {
  const cond =
    mode === "always" ? "이번 턴(모든 응답)" :
    mode === "plancode" ? "이번 턴에 플랜을 확정(ExitPlanMode)했거나 파일을 생성/수정했다면" :
    "이번 턴에 파일을 생성/수정했다면"; // code
  const b = loadBaseDirective();
  return [
    `[검증 모드 ON(${mode}) · 구현→검증 2트랙 · 사람이 턴을 중계하지 않음]`,
    `${cond}, 사용자에게 완료를 보고하기 전에 반드시 \`node "${BRIDGE}" ask --allow-new "..."\` 로 Codex 검증을 받아라. (연결된 Codex 세션이 있으면 그 세션으로 이어가고, 없으면 새 세션을 만들어 연결한다.) [경로에 공백이 있어도 되도록 따옴표로 감쌌음]`,
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
function extractVerdict(text) {
  if (!text) return null;
  let v = null;
  for (const ln of String(text).split(/\r?\n/)) {
    if (!VERDICT_DECL_RE.test(ln)) continue;
    // 선언 줄 확정 → 줄 전체로 4단계 분류. 우선순위: 실패 > 보류·불가 > 통과+보완(통과·보완) > 깨끗한 통과.
    if (/실패/.test(ln)) v = "fail";
    else if (/불가|보류|정보\s*부족/.test(ln)) v = "inconclusive"; // 통과 없는 보류·불가·정보부족 = 통과 못 함
    else if (/통과/.test(ln) && /보완|조건부|정정|추가|미세|단서/.test(ln)) v = "pass-notes"; // 통과지만 보완·추가의견
    else if (/통과/.test(ln)) v = "pass"; // 깨끗한 통과
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
// P1b: Claude 소비용 stdout 재배치. 대시보드/proof/rollout은 원문(answer) 그대로 쓰고, Claude에게 주는 것만 바꾼다.
// findings-first(P1a)로 받은 답에서 '마지막 검증: 선언 줄'을 본문에서 떼어, 라벨 대신 '처리 의무' footer로 옮긴다.
// → Claude가 '통과(보완)'의 '통과'에 앵커링해 보완을 건너뛰는 것 방지(가시성 색칩은 사람용 대시보드가 담당).
// 떼어낸 원문 줄을 footer에 그대로 보여줘 '정확한 결론 인용'(재판단 원칙)도 보존. 게이트가 아니라 nudge.
function formatForClaude(answer) {
  const text = String(answer || "");
  const action = VERDICT_ACTION[extractVerdict(text)];
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
  return `${body}\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: ${verdictLine || "(표지 줄 없음)"}\n처리 의무: ${action}`;
}

module.exports = { loadContract, buildInjection, buildVerifyDirective, VERIFY_MODES, CONTRACT_FILE, CONTRACTS_DIR, contractFileFor, normWs, currentWs, configWs, BRIDGE, BRIDGE_DIR, BASE_DEFAULTS, BASE_DIRECTIVE_FILE, loadBaseDirective, saveBaseDirective, resetBaseDirective, atomicWrite, INTEGRITY_FILE, readIntegrityEvents, appendIntegrityEvent, ackIntegrityEvents, supersedeIntegrity, PHASE_FILE, readPhase, writePhase, PROOFS_DIR, ATTEMPTS_DIR, ACTIVE_DIR, PROOF_TTL_MS, ATTEMPTS_TTL_MS, ACTIVE_TTL_MS, cleanupOldState, maybeCleanupState, extractVerdict, formatForClaude };
