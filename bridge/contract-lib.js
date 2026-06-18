// 고정 계약(contract.json) 로더 + 주입 텍스트 빌더.
// Claude 훅(contract-inject.js)·Codex 브릿지(codex-bridge.js)·검증 훅(verify-guard.js)이 공유한다.
// 규칙은 "상수"로 매 턴 재주입 → 장기 세션/압축에도 잊지 않게.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const BRIDGE_DIR = path.join(os.homedir(), ".codex-bridge");
const CONTRACT_FILE = path.join(BRIDGE_DIR, "contract.json"); // 전역 기본값(상속 시드 · 레거시 호환)
const CONTRACTS_DIR = path.join(BRIDGE_DIR, "contracts"); // 프로젝트별 계약 파일들
const BRIDGE = path.join(BRIDGE_DIR, "codex-bridge.js");
const BASE_DIRECTIVE_FILE = path.join(BRIDGE_DIR, "base-directive.json"); // 기본 지침 사용자 오버라이드(없으면 코드 기본값)

// 워크스페이스 정규화 — 확장(src/extension.ts)·브릿지(codex-bridge.js)와 반드시 동일 규칙이어야 함.
function normWs(p) {
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase();
}
// 프로젝트별 계약 파일 경로. 키 = normWs의 sha1 앞 16자(파일명 안전·플랫폼 무관). 확장 contractFileFor와 동일.
function contractFileFor(ws) {
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  return path.join(CONTRACTS_DIR, key + ".json");
}
// 호출 측(contract-inject·verify-guard·codex-bridge)이 도는 Claude 작업 폴더.
function currentWs() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// 프로젝트별 계약을 읽는다. 미설정이면 전역 기본값(CONTRACT_FILE)을 상속. ws 미지정 시 현재 폴더 기준.
function loadContract(ws) {
  const read = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const o = read(contractFileFor(ws || currentWs())) || read(CONTRACT_FILE) || {};
  return {
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    // 체크리스트 강제: 기본 true(기존 동작 보존). 해제 시 규약만 주입.
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    // 검증 모드: off=꺼짐 / code=코드변경 시 / plancode=플랜확정(ExitPlanMode)+코드변경 시 / always=모든 턴.
    // 기본 off(opt-in). 구버전 verify:true는 code로 마이그레이션.
    verifyMode: normVerifyMode(o),
  };
}

const VERIFY_MODES = ["off", "code", "plancode", "always"];
function normVerifyMode(o) {
  if (o && VERIFY_MODES.includes(o.verifyMode)) return o.verifyMode;
  if (o && o.verify === true) return "code"; // 레거시 호환
  return "off";
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
    "4) 첫 줄에 결론(검증: 통과/실패)을 쓰되, 그 전에 직접 연 파일을 기준으로 독립 점검하고 본문에 항목별 근거(경로·라인)를 달라.",
  ].join("\n"),
  // 구현모델(Claude)에게 — 검증모델에 '전달'할 때의 원칙.
  transmit: [
    "[전달 원칙] 검증모델에게 검증을 맡길 때:",
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
    "- 검증을 건너뛴 완료 보고 금지.",
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
    try { fs.unlinkSync(BASE_DIRECTIVE_FILE); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(BASE_DIRECTIVE_FILE, JSON.stringify(out, null, 2), "utf8");
  }
}
function resetBaseDirective() {
  try { fs.unlinkSync(BASE_DIRECTIVE_FILE); } catch { /* ignore */ }
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
    `${cond}, 사용자에게 완료를 보고하기 전에 반드시 \`node ${BRIDGE} ask "..."\` 로 Codex 검증을 받아라.`,
    b.transmit,
    b.rejudge,
  ].join("\n");
}

module.exports = { loadContract, buildInjection, buildVerifyDirective, VERIFY_MODES, CONTRACT_FILE, CONTRACTS_DIR, contractFileFor, normWs, BRIDGE, BASE_DEFAULTS, BASE_DIRECTIVE_FILE, loadBaseDirective, saveBaseDirective, resetBaseDirective };
