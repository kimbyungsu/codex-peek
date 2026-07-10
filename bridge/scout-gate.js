/*
 * 탐색 게이트 훅(로드맵 ⑥ — 2026-07-09 3트랙 기본 승격) — PreToolUse:ExitPlanMode에 등록되어,
 * "플랜을 확정하려는 순간"에 영향지도가 없거나 낡았으면 먼저 지도를 받으라고 1회 막는다(map preflight).
 *
 * ⚠ 실험 전제(정직): ExitPlanMode가 PreToolUse로 실제 가로채지는지는 공식 문서에 명시가 없다(전용 훅 요청
 * 이슈 존재). 그래서 이 훅은 '관측 로그'를 항상 남긴다 — 새 세션에서 플랜 확정을 시도해 로그에 이벤트가
 * 찍히는지가 실험의 판정 근거다(HANDOFF §6 ⑥ 프로토콜). 찍히지 않으면 게이트는 조용히 무해하다.
 *
 * 안전 원칙:
 *  - 3트랙 기본 켜짐(2026-07-09 승격): 실효 게이트는 normScoutGate — scoutMode≠on이면 무조건 off(2트랙 무회귀),
 *    3트랙 명시 off는 존중, 3트랙 미설정은 plan(근거: 재실측 70.5%>합격선 60% + 차단 문구에 프로젝트별 관찰 신호 동반).
 *  - fail-open: 어떤 오류에서도 exit 0(플랜 확정을 절대 잠그지 않음 — 게이트 실패가 작업을 막으면 안 됨).
 *  - 상한: 같은 세션에서 2회까지만 막고 이후 통과(경고 로그) — 지도 생성이 불가능한 환경에서 무한 차단 방지.
 *  - 로그는 내용이 아니라 형태만: tool_input의 '키 이름'만 기록(플랜 본문은 저장 안 함 — PRIVACY 참조).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, scoutMapStatus, wsKeyFor, atomicWrite, resolveScoutRepo, loadLang, scoutHealthLine, readScoutTargetEvidence, detectScoutTargetDrift } = require("./contract-lib.js");
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // 훅 문구도 한/영 쌍(2026-07-09 사용자 지적)

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
  // P1: 신선도·지시 경로는 '정찰 대상'(계약 scoutRepo — 세션 폴더≠개발 레포 해소) 기준. 계약 불명이면 ws 그대로.
  let contract = {};
  try { contract = loadContract(ws) || {}; } catch { /* 계약 불명 → 기본값 */ }
  const target = (() => { try { return resolveScoutRepo(ws, contract).repo; } catch { return ws; } })();
  // 실험 관측: 이 훅이 실제로 불렸다는 사실 자체가 1차 데이터(플랜 본문은 기록 안 함). 세션 폴더와 대상을 둘 다 남김.
  logObservation(ws, { ts: new Date().toISOString(), tool: toolName, inputKeys, session: String(p.session_id || "").slice(0, 12), ...(target !== ws ? { target } : {}) });
  if (toolName !== "ExitPlanMode") process.exit(0); // matcher가 보장하지만 방어적으로
  // loadContract가 normScoutGate로 정규화한 실효값 — 3트랙 기본 plan / 2트랙 무조건 off(명시 plan 잔재도 비활성).
  const gate = contract.scoutGate || "off";
  if (gate !== "plan") process.exit(0);
  let st = { state: "fresh", staleCount: 0 };
  try { st = scoutMapStatus(target); } catch { process.exit(0); } // 판정 불가 → fail-open
  if (st.state === "fresh") process.exit(0);
  if (st.state === "unknown") {
    // 전수 확인 불가(비-git 스캔 상한) — 낡음을 증명 못 했으므로 막지 않는다(fail-open 원칙). 단 fresh를
    // 사칭하지 않도록 관측 기록에 남김(L1-C: 판정 불가와 신선을 구분 — 조용한 fresh 승격 금지).
    logObservation(ws, { ts: new Date().toISOString(), tool: toolName, passThrough: true, reason: tB("신선도 판정 불가(스캔 상한) — 차단 없이 통과", "freshness unknown (scan cap) — passing without block") });
    process.exit(0);
  }
  // 세션당 차단 상한
  const session = String(p.session_id || "nosession");
  const af = path.join(ATTEMPTS_DIR, session.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 32) + ".json"); // 훅 입력을 경로에 쓰므로 정규화(경로 이탈 방지 — Codex 지적)
  let n = 0;
  try { n = (JSON.parse(fs.readFileSync(af, "utf8")).n | 0) || 0; } catch { /* 첫 차단 */ }
  if (n >= BLOCKS_PER_SESSION) {
    logObservation(ws, { ts: new Date().toISOString(), tool: toolName, passThrough: true, reason: tB("세션 차단 상한 도달 — 통과(무한 잠금 방지)", "session block cap reached — passing through (no hard-lock)") });
    process.exit(0);
  }
  try { fs.mkdirSync(ATTEMPTS_DIR, { recursive: true }); atomicWrite(af, JSON.stringify({ n: n + 1, ts: new Date().toISOString() })); } catch { /* 기록 실패해도 차단은 진행(다음 번 상한 계산만 보수적) */ }
  const why = st.state === "no-map" ? tB("이 프로젝트에 영향지도가 아직 없다", "this project has no impact map yet")
    : st.state === "legacy-no-seeds" ? tB("최신 지도에 근거 파일 기록이 없어 신선도를 판정할 수 없다(구버전 지도 — 재생성 필요)", "the latest map has no basis-file record, so freshness cannot be judged (legacy map — regeneration needed)")
    : st.state === "invalid" ? tB("최신 지도 파일에서 형식을 알아볼 수 없다(파싱 가능한 항목·구획 표기 없음 — 빈/불량 지도는 신뢰 입력이 아님) — 재생성 필요", "the latest map file has no recognizable structure (no parsable items or section markers — an empty/broken map is not a trusted input) — regeneration needed")
    : tB(`최신 지도 이후 변경 신호 ${st.staleCount}건(근거 파일 ${st.seedChanged} · 새 커밋 ${st.commitsAfter} · 작업트리 ${st.dirtyChanged}${st.historyLost ? ` · 기록 기준 커밋 소실 ${st.historyLost}` : ""}) — 지도가 낡았다`, `${st.staleCount} change signal(s) since the latest map (basis ${st.seedChanged} · commits ${st.commitsAfter} · working tree ${st.dirtyChanged}${st.historyLost ? ` · base commit missing ${st.historyLost}` : ""}) — it is stale`);
  // 프로젝트별 관찰 신호 동반(사용자 조건 '카드와 한 묶음' — 게이트가 전역 수치가 아니라 이 프로젝트의 장부를 근거로
  // 말하게 한다). 별도 try — 신호 계산 실패가 차단 문구 출력 자체를 막으면 안 됨.
  let healthTail = "";
  try { const hl = scoutHealthLine(target, loadLang() === "en"); if (hl) healthTail = hl + "\n"; } catch { /* 신호 실패 무해 */ }
  // 대상 어긋남 의심이면 '엉뚱한 레포의 지도를 만들라'고 안내하면 안 된다(Codex 설계검증 2026-07-10) —
  // 대상 지정을 먼저 시키고, 지도 명령도 의심 레포 기준으로 바꾼다. 진단 실패는 기존 안내 유지(fail-open).
  let cmd = `node scripts/scope-scout-self.js "${target}"`;
  let driftNote = "";
  try {
    const drift = detectScoutTargetDrift(target, readScoutTargetEvidence(ws));
    if (drift.drift) {
      driftNote = tB(
        ` ⚠ 대상 어긋남 의심: 최근 검증 인용 다수가 ${drift.repo} 소속 — 먼저 \`node scripts/scope-target.js "${ws}" set "${drift.repo}"\` 로 정찰 대상을 지정하라(현재 언어 슬롯).`,
        ` ⚠ Target mismatch suspected: recent verification citations mostly live under ${drift.repo} — first run \`node scripts/scope-target.js "${ws}" set "${drift.repo}"\` to set the scout target (current language slot).`);
      cmd = `node scripts/scope-scout-self.js "${drift.repo}"`;
    }
  } catch { /* 자기진단 실패 — 기존 안내 유지 */ }
  process.stderr.write(tB(
    `[탐색 게이트 · plan] 플랜 확정 전에 영향지도부터 — ${why}.${driftNote} codex-peek 소스 저장소에서 \`${cmd}\` 실행 후 다시 플랜을 확정하라. (이 게이트는 세션당 ${BLOCKS_PER_SESSION}회까지만 막고 이후 통과 · 끄기: node scripts/scope-gate.js "${ws}" off)\n`,
    `[Recon gate · plan] Get an impact map before confirming the plan — ${why}.${driftNote} Run \`${cmd}\` from the codex-peek source repo, then confirm the plan again. (This gate blocks at most ${BLOCKS_PER_SESSION}× per session, then passes · turn off: node scripts/scope-gate.js "${ws}" off)\n`) + healthTail);
  process.exit(2); // 차단 — stderr가 Claude에게 피드백됨(공식 문서 명시)
}

let buf = "";
process.stdin.on("data", (d) => { buf += d; });
process.stdin.on("end", () => { try { main(buf); } catch { process.exit(0); } }); // 어떤 예외도 fail-open
process.stdin.on("error", () => process.exit(0));
