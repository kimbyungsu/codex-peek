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

// 검증 모드 ON일 때 Claude(구현모델)에게 매 턴 주입하는 2트랙 지시. 모드별로 트리거 조건을 명시.
function buildVerifyDirective(mode) {
  const cond =
    mode === "always" ? "이번 턴(모든 응답)" :
    mode === "plancode" ? "이번 턴에 플랜을 확정(ExitPlanMode)했거나 파일을 생성/수정했다면" :
    "이번 턴에 파일을 생성/수정했다면"; // code
  return [
    `[검증 모드 ON(${mode}) · 구현→검증 2트랙 · 사람이 턴을 중계하지 않음]`,
    `${cond}, 사용자에게 완료를 보고하기 전에 반드시 \`node ${BRIDGE} ask "..."\` 로 Codex 검증을 받아라.`,
    // (b) 요약 금지 · 실제 경로 전달 → Codex가 원본을 직접 읽게
    `[전달 원칙] 검증 요청을 요약/생략하지 마라. 변경한 실제 파일 경로와 확인 지점(함수·라인·기대 동작)을 구체적으로 적어, Codex가 원본 파일을 직접 열어 검증하게 하라. "대충 됨" 식 요약 전달 금지이며, Codex에게 '빠르게/대충/요약/생략' 식 축약 검증을 요청하지도 마라.`,
    // (a) 재판단 강제 → 앵무새 금지 + 코드 기준 근거
    `[재판단] Codex 답을 그대로 옮기지 마라. 그 지적이 타당한지 네가 다시 점검해 동의/반박을 근거와 함께 판단하고, 최종 결론(통과/실패 + 사유)을 네 책임으로 정리해 보고하라. 근거는 논리 추정이 아니라 코드/파일에서 직접 확인 가능한 사실(경로·라인·실제 출력/동작)로 제시하고, Codex와 의견이 갈리면 그 이유를 명시하라.`,
    `검증을 건너뛴 완료 보고 금지.`,
  ].join("\n");
}

module.exports = { loadContract, buildInjection, buildVerifyDirective, VERIFY_MODES, CONTRACT_FILE, CONTRACTS_DIR, contractFileFor, normWs, BRIDGE };
