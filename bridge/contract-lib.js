// 고정 계약(contract.json) 로더 + 주입 텍스트 빌더.
// Claude 훅(contract-inject.js)·Codex 브릿지(codex-bridge.js)·검증 훅(verify-guard.js)이 공유한다.
// 규칙은 "상수"로 매 턴 재주입 → 장기 세션/압축에도 잊지 않게.
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONTRACT_FILE = path.join(os.homedir(), ".codex-bridge", "contract.json");
const BRIDGE = path.join(os.homedir(), ".codex-bridge", "codex-bridge.js");

function loadContract() {
  let o = {};
  try {
    o = JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8"));
  } catch {
    o = {};
  }
  return {
    claude: Array.isArray(o.claude) ? o.claude : [],
    codex: Array.isArray(o.codex) ? o.codex : [],
    // 체크리스트 강제: 기본 true(기존 동작 보존). 해제 시 규약만 주입.
    claudeChecklist: o.claudeChecklist !== false,
    codexChecklist: o.codexChecklist !== false,
    // 검증 모드(구현→Codex 자동검증→보고): 기본 false(opt-in).
    verify: o.verify === true,
  };
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

// 검증 모드 ON일 때 Claude(구현모델)에게 매 턴 주입하는 2트랙 지시.
function buildVerifyDirective() {
  return [
    `[검증 모드 ON · 구현→검증 2트랙 · 사람이 턴을 중계하지 않음]`,
    `이번 턴에 파일을 생성/수정했다면, 사용자에게 완료를 보고하기 전에 반드시`,
    `\`node ${BRIDGE} ask "<무엇을 검증할지>"\` 로 Codex 검증을 받고,`,
    `그 결과(통과/실패+근거)를 요약·반영해서 보고하라. 검증을 건너뛴 완료 보고 금지.`,
  ].join("\n");
}

module.exports = { loadContract, buildInjection, buildVerifyDirective, CONTRACT_FILE, BRIDGE };
