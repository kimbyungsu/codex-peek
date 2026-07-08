/*
 * 탐색 게이트 훅(로드맵 ⑥ — 실험 단계) — PreToolUse:ExitPlanMode에 등록되어,
 * "플랜을 확정하려는 순간"에 영향지도가 없거나 낡았으면 먼저 지도를 받으라고 1회 막는다(map preflight).
 *
 * ⚠ 실험 전제(정직): ExitPlanMode가 PreToolUse로 실제 가로채지는지는 공식 문서에 명시가 없다(전용 훅 요청
 * 이슈 존재). 그래서 이 훅은 '관측 로그'를 항상 남긴다 — 새 세션에서 플랜 확정을 시도해 로그에 이벤트가
 * 찍히는지가 실험의 판정 근거다(HANDOFF §6 ⑥ 프로토콜). 찍히지 않으면 게이트는 조용히 무해하다.
 *
 * 안전 원칙:
 *  - 기본 꺼짐: 계약(scoutGate)이 "plan"일 때만 게이트 동작(사전등록 60% 미달 — 사용자 명시 선택만).
 *  - fail-open: 어떤 오류에서도 exit 0(플랜 확정을 절대 잠그지 않음 — 게이트 실패가 작업을 막으면 안 됨).
 *  - 상한: 같은 세션에서 2회까지만 막고 이후 통과(경고 로그) — 지도 생성이 불가능한 환경에서 무한 차단 방지.
 *  - 로그는 내용이 아니라 형태만: tool_input의 '키 이름'만 기록(플랜 본문은 저장 안 함 — PRIVACY 참조).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, scoutMapStatus, wsKeyFor, atomicWrite } = require("./contract-lib.js");

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const LOG_DIR = path.join(BRIDGE_DIR, "scout-gate-log");
const ATTEMPTS_DIR = path.join(BRIDGE_DIR, "scout-gate-attempts");
const LOG_CAP = 500; // 관측 로그 상한(실험용 — 오래된 줄 잘림)
const BLOCKS_PER_SESSION = 2; // 세션당 차단 상한 — 무한 잠금 방지(초과 시 통과+경고 기록)

function logObservation(ws, rec) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = path.join(LOG_DIR, wsKeyFor(ws) + ".jsonl");
    fs.appendFileSync(f, JSON.stringify(rec) + "\n", "utf8");
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > LOG_CAP + 100) atomicWrite(f, lines.slice(-LOG_CAP).join("\n") + "\n");
  } catch { /* 관측 실패 무해 */ }
}

function main(raw) {
  let p = {};
  try { p = JSON.parse(raw); } catch { process.exit(0); } // 페이로드 불명 → fail-open
  const ws = process.env.CLAUDE_PROJECT_DIR || p.cwd || "";
  if (!ws) process.exit(0);
  const toolName = String(p.tool_name || "");
  const inputKeys = p.tool_input && typeof p.tool_input === "object" ? Object.keys(p.tool_input) : [];
  // 실험 관측: 이 훅이 실제로 불렸다는 사실 자체가 1차 데이터(플랜 본문은 기록 안 함)
  logObservation(ws, { ts: new Date().toISOString(), tool: toolName, inputKeys, session: String(p.session_id || "").slice(0, 12) });
  if (toolName !== "ExitPlanMode") process.exit(0); // matcher가 보장하지만 방어적으로
  let gate = "off";
  try { gate = (loadContract(ws) || {}).scoutGate || "off"; } catch { /* 계약 불명 → off */ }
  if (gate !== "plan") process.exit(0);
  let st = { state: "fresh", staleCount: 0 };
  try { st = scoutMapStatus(ws); } catch { process.exit(0); } // 판정 불가 → fail-open
  if (st.state === "fresh") process.exit(0);
  // 세션당 차단 상한
  const session = String(p.session_id || "nosession");
  const af = path.join(ATTEMPTS_DIR, session.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 32) + ".json"); // 훅 입력을 경로에 쓰므로 정규화(경로 이탈 방지 — Codex 지적)
  let n = 0;
  try { n = (JSON.parse(fs.readFileSync(af, "utf8")).n | 0) || 0; } catch { /* 첫 차단 */ }
  if (n >= BLOCKS_PER_SESSION) {
    logObservation(ws, { ts: new Date().toISOString(), tool: toolName, passThrough: true, reason: "세션 차단 상한 도달 — 통과(무한 잠금 방지)" });
    process.exit(0);
  }
  try { fs.mkdirSync(ATTEMPTS_DIR, { recursive: true }); atomicWrite(af, JSON.stringify({ n: n + 1, ts: new Date().toISOString() })); } catch { /* 기록 실패해도 차단은 진행(다음 번 상한 계산만 보수적) */ }
  const why = st.state === "no-map" ? "이 프로젝트에 영향지도가 아직 없다"
    : st.state === "legacy-no-seeds" ? "최신 지도에 근거 파일 기록이 없어 신선도를 판정할 수 없다(구버전 지도 — 재생성 필요)"
    : `최신 지도 생성 후 근거 파일 ${st.staleCount}개가 더 바뀌어 지도가 낡았다`;
  process.stderr.write(`[탐색 게이트 · plan 실험] 플랜 확정 전에 영향지도부터 — ${why}. codex-peek 소스 저장소에서 \`node scripts/scope-scout-self.js "${ws}"\` 실행 후 다시 플랜을 확정하라. (이 게이트는 세션당 ${BLOCKS_PER_SESSION}회까지만 막고 이후 통과 · 끄기: node scripts/scope-gate.js "${ws}" off)\n`);
  process.exit(2); // 차단 — stderr가 Claude에게 피드백됨(공식 문서 명시)
}

let buf = "";
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("end", () => { try { main(buf); } catch { process.exit(0); } }); // 어떤 예외도 fail-open
process.stdin.on("error", () => process.exit(0));
