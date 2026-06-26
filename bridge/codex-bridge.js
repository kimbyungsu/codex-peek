#!/usr/bin/env node
// Claude ↔ Codex 브릿지 (일시 대체제)
// - 연결 정보를 영속 저장(Claude 세션id + 워크스페이스 키) → 내 기억과 무관하게 유지.
// - ask: 연결된 Codex 세션으로 resume. 연결 없으면 "보고만"(새 세션 안 만듦). 첫 소통은 --allow-new로 명시 생성.
// - 정책은 스크립트가 강제하고, raw codex 직접호출은 PreToolUse 후크(codex-guard.js)가 차단한다.
//
// 사용:
//   node codex-bridge.js ask "<프롬프트>"          연결된 세션에 보내고 답 받기 (없으면 보고)
//   node codex-bridge.js ask --allow-new "<...>"   연결 없을 때 새 세션 생성+연결 후 보내기 (첫 소통)
//   node codex-bridge.js ask --force-new "<...>"   엉뚱 폴더 방어를 무릅쓰고 '이 폴더'에 새 세션 강제(--allow-new 함의)
//   node codex-bridge.js link <codex-session-id>   현재 Claude 세션을 기존 Codex 세션에 연결
//   node codex-bridge.js link --last               가장 최근(인덱스된) Codex 세션에 연결
//   node codex-bridge.js status                    현재 연결 상태
//   node codex-bridge.js find                       연결 후보(인덱스된 Codex 세션) 목록

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, buildInjection, loadBaseDirective, atomicWrite, readPhase, writePhase, appendIntegrityEvent, supersedeIntegrity, maybeCleanupState, extractVerdict, formatForClaude } = require("./contract-lib.js");

// 사용자 요청 앞에 [검증 기본 원칙](기본 지침, 오버라이드 가능) + Codex 고정 계약을 prepend(매 ask마다).
// 기본 지침은 contract-lib의 loadBaseDirective()에서 로드 → 대시보드에서 보기/수정/초기화 가능. 코드에 캐논 기본값 상존.
function withContract(prompt, ws) {
  const baseline = loadBaseDirective().verifyBaseline;
  let inj = "";
  try {
    // V9: Codex 계약도 이 ask의 워크스페이스로 '명시' 로드(인자 없으면 workspace()로 폴백). cmdAsk가
    // modelPref·가드·proof·withContract에 같은 ws 스냅샷을 넘겨 codex 계약이 다른 cwd로 새는 잠재 위험을 없앤다.
    // (resolveLink/recordLink는 내부 workspace() 사용 — 동기 프로세스 내 동일 값이라 동작 일치, V9 범위 밖.)
    const c = loadContract(ws || workspace());
    inj = buildInjection(c.codex, "Codex", c.codexChecklist);
  } catch {
    inj = "";
  }
  const head = inj ? `${baseline}\n\n${inj}` : baseline;
  return `${head}\n\n---\n[작업 요청]\n${prompt}`;
}

const HOME = os.homedir();
// 자체 namespace 폴더. CODEX_BRIDGE_HOME으로 override 가능(WSL/Remote/Container·포터블에서 확장 호스트와 훅이
// 같은 폴더를 보도록 명시 고정). 미설정이면 ~/.codex-bridge. ★모든 자체파일 경로는 이 BRIDGE_DIR 한 곳에서만 파생.
const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(HOME, ".codex-bridge");
// codex가 실제 쓰는 home을 확장이 'codex doctor'로 탐지해 적어둔 값(바이너리 codex-bin.txt 대칭).
// → CODEX_HOME 미설정/비표준 home·다중설치에서도 세션 폴더를 정확히 찾는다(V11). 없으면 ~/.codex 폴백.
function readPinnedHome() {
  try {
    const p = fs.readFileSync(path.join(BRIDGE_DIR, "codex-home.txt"), "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}
const CODEX_HOME = process.env.CODEX_HOME || readPinnedHome() || path.join(HOME, ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const LINKS_FILE = path.join(BRIDGE_DIR, "links.json");
// 검증 증명 폴더 — 실제로 Codex가 성공 응답했을 때만 기록(아래 writeProof). verify-guard가 이걸 읽어
// '명령 문자열을 쳤는가'가 아니라 '진짜 성공한 검증이 이번 턴에 있었는가'를 본다(V1: 흉내/실패/미연결 통과 차단).
const PROOFS_DIR = path.join(BRIDGE_DIR, "proofs");
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function nowIso() {
  return new Date().toISOString();
}
function claudeId() {
  return process.env.CLAUDE_CODE_SESSION_ID || "";
}
function workspace() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
// 검증 증명 기록 — 실제로 Codex가 성공(exit 0·비어있지 않은 응답)했을 때만 호출한다(cmdAsk의 성공 분기들).
// 한 Claude 세션당 1파일(최신 성공만 보존). verify-guard는 '이번 사용자 발화/변경 이후 ts + status/exit/answerChars'로 인정(workspace는 V1에서 게이트 제외 — 같은 세션 키로 격리).
// → 명령 문자열만 보던 V1 구멍(echo·실패·미연결도 통과)을 닫는다. claudeSession 미설정(수동 실행)이면 _nosession에 기록(무해).
function writeProof(codexSession, answer, ws) {
  // claudeSession: env 우선, 없으면 active.json(contract-inject가 hook.session_id로 기록) 폴백 →
  // verify-guard의 reader 키(env‖j.session_id‖transcript)와 같은 대화 id로 수렴(환경별 env 결측 대비).
  const cs = claudeId() || ((readActive() || {}).claudeSession) || "";
  const proof = {
    v: 1,
    claudeSession: cs,
    workspace: ws || workspace(), // V9: cmdAsk의 ws 스냅샷과 동일(인자 없으면 폴백)
    ts: nowIso(),
    codexSession: codexSession || "",
    exit: 0,
    status: "success",
    answerChars: (answer || "").length,
  };
  const key = (cs || "_nosession").replace(/[^0-9a-zA-Z._-]/g, "_"); // 파일명 안전(UUID는 본래 안전)
  atomicWrite(path.join(PROOFS_DIR, key + ".json"), JSON.stringify(proof)); // atomicWrite가 PROOFS_DIR 자동 생성
}

// 결정2-2단계: Codex 답의 인용 근거(파일:라인)를 보수적으로 점검. 거짓경보(cry-wolf) 회피 최우선 —
// 경로를 '자신 있게' 한 실제 파일로 해석할 수 있을 때만(절대존재 / ws 상대존재 / ws내 basename 유일) 평가하고,
// 라인이 파일 줄수를 '명백히 초과'할 때만 불일치로 본다. 해석 불가·모호·범위 내는 건너뜀(안 띄움). '코덱스가
// 실제로 안 열었나'(rollout 대조)는 fuzzy라 보류. → 불일치가 있으면 노랑(warning) 무결성 이벤트.
function findByBasename(root, base, maxDepth, maxFiles) {
  const hits = [];
  let count = 0;
  const walk = (d, depth) => {
    if (depth > maxDepth || count > maxFiles || hits.length > 1) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (hits.length > 1) return;
      const n = it.name;
      if (it.isDirectory()) {
        if (n === "node_modules" || n === ".git" || n === "out" || n.startsWith(".")) continue;
        walk(path.join(d, n), depth + 1);
      } else if (it.isFile()) {
        count++;
        if (n === base) hits.push(path.join(d, n));
      }
    }
  };
  walk(root, 0);
  return hits;
}
function resolveCitedPath(raw, ws) {
  let p = String(raw).replace(/\\/g, "/");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return null; // URL(https:// 등)은 로컬 파일 아님 → 건너뜀(cry-wolf 방지)
  const mnt = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/); // /mnt/d/... → d:/...
  if (mnt) p = mnt[1] + ":/" + mnt[2];
  try { if (path.isAbsolute(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* */ }
  try { const c = path.join(ws, p); if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* */ }
  const hits = findByBasename(ws, path.basename(p), 6, 5000);
  return hits.length === 1 ? hits[0] : null; // 유일할 때만(모호하면 skip — cry-wolf 방지)
}
function checkCitedEvidence(answer, ws) {
  const text = String(answer || "");
  // 마크다운 링크 (경로.확장자:라인[-라인]). 경로엔 드라이브 콜론(D:/...)·유니코드도 허용해야 하므로 괄호/공백만 제외.
  // '.확장자:숫자)'로 끝을 고정해 (3:00)·(텍스트:5) 같은 비-파일 인용은 거른다.
  const re = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?\)/g;
  const seen = new Set();
  const mism = [];
  let m;
  while ((m = re.exec(text))) {
    const rawPath = m[1];
    const line = parseInt(m[2], 10);
    if (!line) continue;
    const k = rawPath + ":" + line;
    if (seen.has(k)) continue;
    seen.add(k);
    const file = resolveCitedPath(rawPath, ws || workspace());
    if (!file) continue; // 해석 불가/모호 → 건너뜀
    let count = 0;
    try { count = fs.readFileSync(file, "utf8").split(/\n/).length; } catch { continue; }
    if (line > count) mism.push(`${path.basename(rawPath)}:${line}(실제 ${count}줄)`);
  }
  return mism;
}
// 인용된 파일 중 '실재(resolve)하는' 것들의 basename 집합. 모호/해석불가는 제외(cry-wolf 방지).
function citedResolvedBasenames(answer, ws) {
  const text = String(answer || "");
  const re = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?\)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text))) {
    const file = resolveCitedPath(m[1], ws || workspace());
    if (file) out.add(path.basename(file));
  }
  return out;
}
// 결정2-3: 인용한 (실재) 파일 중, '이 검증 세션' rollout의 도구 명령/출력 어디에도 basename이 안 나타난 것.
// = '이 검증에서 그 파일을 다룬 흔적을 확인 못함'(코덱스는 셸 명령으로 파일을 읽으므로 명령문/출력에 파일명이 남는다).
// 보수적: rollout을 못 읽거나·도구활동 자체가 없으면(이전 턴 맥락 등) 판단 보류(빈 배열) — 단정/오탐 방지.
function citedFilesUnseen(answer, ws, sessionId) {
  if (!sessionId) return [];
  let file;
  try { file = findRolloutById(sessionId); } catch { return []; }
  if (!file) return [];
  const remaining = citedResolvedBasenames(answer, ws);
  if (!remaining.size) return [];
  try { if (fs.statSync(file).size > 16 * 1024 * 1024) return []; } catch { return []; } // 비정상적으로 큰 rollout은 비용·신뢰 모두 보류
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { return []; }
  let hadTool = false;
  for (const ln of lines) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const p = o && typeof o.payload === "object" && o.payload ? o.payload : null;
    if (!p) continue;
    const t = p.type;
    if (t === "function_call" || t === "custom_tool_call") hadTool = true;
    if (t === "function_call" || t === "function_call_output" || t === "custom_tool_call" || t === "custom_tool_call_output") {
      const out = typeof p.output === "string" ? p.output : p.output ? JSON.stringify(p.output) : "";
      const hay = String(p.arguments || "") + "\n" + out + "\n" + String(p.input || "");
      for (const bn of [...remaining]) if (hay.includes(bn)) remaining.delete(bn);
      if (!remaining.size) break;
    }
  }
  if (!hadTool) return []; // 도구활동 없음 → 이전 턴 맥락 등으로 답했을 수 있음 → 경보 안 함
  return [...remaining];
}
function flagEvidence(answer, ws, sessionId) {
  try {
    const mism = checkCitedEvidence(answer, ws);
    if (mism.length) {
      appendIntegrityEvent({
        ts: nowIso(),
        session: claudeId() || ((readActive() || {}).claudeSession) || "",
        workspace: ws,
        kind: "evidence-mismatch",
        severity: "warning", // 노랑 — '의심'이지 '검증 미완(빨강)'은 아님
        detail: `검증 답의 인용 근거 ${mism.length}개가 실제 파일/라인과 불일치(존재하지 않는 줄): ${mism.slice(0, 3).join(" / ")}`,
      });
    }
    const unseen = citedFilesUnseen(answer, ws, sessionId);
    if (unseen.length) {
      appendIntegrityEvent({
        ts: nowIso(),
        session: claudeId() || ((readActive() || {}).claudeSession) || "",
        workspace: ws,
        kind: "evidence-unseen",
        severity: "warning", // 노랑(의심) — '안 읽음' 단정이 아니라 '기록에서 다룬 흔적 미확인'
        detail: `검증 답이 인용한 파일 ${unseen.length}개를 이 검증 기록에서 다룬 흔적을 확인하지 못했습니다(이전 턴에서 봤거나 기록 형식 차이일 수 있음 — '안 읽음' 단정 아님): ${unseen.slice(0, 3).join(" / ")}`,
      });
    }
  } catch { /* best-effort — 점검 실패가 검증 흐름을 막지 않음 */ }
}
// 비-깨끗한 결론을 사용자에게 '가시화'(노랑). 자동 차단 안 함(설계 경계 결론: 품질은 강제 말고 가시화).
// 핵심: verdict는 '최신 상태'다. 새 검증 결과가 나오면 같은 세션의 직전 verdict-nonclean을 먼저 대체(supersede)한다 →
// 실패→수정→재검증 통과로 해소되면 노랑도 사라진다(반복 검증이 무조건 노랑을 남기는 cry-wolf 방지). 그 뒤 실패/보류일 때만 새로 띄움.
// '통과'·'통과(보완)'은 새 노랑을 만들지 않는다(굿하트 '통과 도장' 안 만들기). 단 답은 있는데 마지막 판정 줄이 없으면(null)
// verdict-missing 노랑으로 '표지 누락'을 가시화한다(대시보드 색 분류 입력이 비기 때문). 빈/공백 답은 아무 신호도 안 건드린다. answer=마지막 메시지(-o).
function flagVerdict(answer, ws) {
  try {
    const text = String(answer || "");
    if (!text.trim()) return; // 빈/공백 답 → 직전 신호(표지 누락 포함)도 함부로 안 건드림(supersede도 안 함)
    const session = claudeId() || ((readActive() || {}).claudeSession) || "";
    supersedeIntegrity(session, "verdict-missing"); // 새 답 도착 → 직전 '표지 누락' 신호는 갱신 대상(최신 1건만 유지)
    const v = extractVerdict(text);
    if (!v) {
      // 답은 있는데 마지막 '검증:' 판정 줄이 없음 → 형식 위반 가시화. 별도 kind로 격리해 verdict-nonclean(실패/보류 노랑)은 안 건드린다.
      appendIntegrityEvent({
        ts: nowIso(),
        session,
        workspace: ws,
        kind: "verdict-missing",
        severity: "warning", // 노랑 — '통과 아님'이 아니라 '판정 표지가 없어 색 표시가 빔'
        detail: "Codex 답에 마지막 '검증: 통과/통과(보완)/보류/실패' 판정 줄이 없습니다 — 대시보드 색 표시가 비고, 결론을 직접 확인해야 합니다.",
      });
      return; // verdict-nonclean(직전 실패/보류 노랑)은 유지
    }
    supersedeIntegrity(session, "verdict-nonclean"); // 정상 판정 → 직전 비-깨끗 신호를 대체(통과면 그대로 해소)
    if (v !== "fail" && v !== "inconclusive") return; // 통과·통과(보완) → 새 노랑 없음(직전 것은 이미 supersede로 정리)
    appendIntegrityEvent({
      ts: nowIso(),
      session,
      workspace: ws,
      kind: "verdict-nonclean",
      severity: "warning", // 노랑 — '검증 미완(빨강)'이 아니라 'Codex 결론이 깨끗한 통과가 아님'
      detail: v === "fail"
        ? "Codex 결론이 '검증 실패'입니다 — 통과가 아닙니다. 대시보드 대화에서 결론과 근거를 확인하세요."
        : "Codex 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요.",
    });
  } catch { /* best-effort — 점검 실패가 검증 흐름을 막지 않음 */ }
}
// 지금 Claude 대화가 '실제로' 도는 폴더 — contract-inject 훅이 매 턴 active.json에 기록. 엉뚱 폴더 방어용.
function readActive() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "active.json"), "utf8"));
  } catch {
    return null;
  }
}
// 워크스페이스 키 정규화(대소문자/구분자/끝슬래시 차이 흡수) — 브릿지·확장 일치용.
function normWs(p) {
  // NFC: 환경별 유니코드 폼(NFC/NFD) 차이로 같은 경로가 다른 키 되는 것 방지. 브릿지·확장 3카피 '동일 규칙'이어야 함.
  return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC");
}
function lookupWorkspace(links, ws) {
  const n = normWs(ws);
  for (const k of Object.keys(links.byWorkspace || {})) {
    if (normWs(k) === n) return links.byWorkspace[k];
  }
  return null;
}

// 경로 하나를 실행형으로 포장: .js 런처면 node로 실행, 네이티브면 그대로 exec.
function wrapCodexPath(p, how) {
  if (/\.js$/i.test(p)) return { file: process.execPath, args: [p], how };
  if (/\.(cmd|bat)$/i.test(p)) return { file: p, args: [], how, shell: true }; // win 셰임(.cmd/.bat)은 셸 경유 필요
  return { file: p, args: [], how };
}

// codex-peek 확장이 기록해 둔 codex 실행 경로. 확장이 vscode API로 '사용자가 실제 쓰는 codex'
// (설정 지정값 또는 설치된 Codex 확장 내부)를 활성화 때마다 찾아 적는다.
// → 포터블/설치형·버전 폴더 변경과 무관하게 항상 현재 위치(자동추적 = 범용성·편의성의 핵심).
function readPinnedCodex() {
  try {
    const p = fs.readFileSync(path.join(BRIDGE_DIR, "codex-bin.txt"), "utf8").trim();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* ignore */
  }
  return null;
}

// codex 실행 방법 해석. 반환 { file, args, how, shell? } → spawn(file, [...args, ...], { shell, input }).
// 우선순위(전부 override·doctor 표시 가능):
//   1) CODEX_BIN(env)       — 비-VSCode/CLI 에서 직접 지정
//   2) codex-bin.txt(확장)  — 사용자 설정값 또는 자동탐색 결과(포터블/설치형·버전 무관)
//   3) PATH 의 codex         — CLI 설치 표준(win은 셸로 .cmd/PATHEXT 해석; 프롬프트는 stdin이라 따옴표 안전)
// 경로를 직접 뒤지지 않는다 — 위치 추적은 확장이 vscode API로 담당(설치형태/버전에 안 깨짐).
function resolveCodex() {
  const isWin = process.platform === "win32";
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return wrapCodexPath(process.env.CODEX_BIN, "CODEX_BIN");
  const pinned = readPinnedCodex();
  if (pinned) return wrapCodexPath(pinned, "vscode-ext");
  return { file: "codex", args: [], how: "PATH", shell: isWin };
}

// codex가 실제 쓰는 home을 'codex doctor'로 탐지해 codex-home.txt에 기록(바이너리 자동추적 대칭).
// doctor 출력의 "CODEX_HOME   <경로> (dir)" 줄을 파싱. sessions = home/sessions.
function detectCodexHome() {
  const inv = resolveCodex();
  const r = spawnSync(inv.file, [...inv.args, "doctor"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1000 * 30,
    windowsHide: true,
    encoding: "utf8",
    shell: !!inv.shell,
  });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  // 줄 단위 앵커: 'CODEX_HOME  <경로> (dir)' 한 줄만 잡음(줄바꿈·다른 (dir) 줄 오탐 방지).
  // ⚠ 세션찾기 고장 시 1순위 점검: codex 업데이트로 doctor 출력 형식이 바뀌면 이 정규식이 안 맞아 home 탐지가 깨진다.
  const m = out.match(/^\s*CODEX_HOME\s+([^\r\n]+?)\s*\(dir\)\s*$/m);
  const home = m ? m[1].trim() : "";
  const f = path.join(BRIDGE_DIR, "codex-home.txt");
  let ok = false;
  try {
    if (home && fs.existsSync(home)) {
      ok = atomicWrite(f, home); // 저장 성공 여부를 그대로 — 거짓 성공 방지(doctor/탐지 신뢰성)
    }
  } catch {
    /* ignore */
  }
  return { home, ok };
}
function cmdDetectHome() {
  const { home, ok } = detectCodexHome();
  if (ok) process.stdout.write(`codex home 탐지·기록: ${home}\n  sessions = ${path.join(home, "sessions")}\n`);
  else process.stderr.write(`codex home 탐지 실패: 'codex doctor'에서 CODEX_HOME 줄을 못 읽음.\n  → codex 업데이트로 출력 형식이 바뀌었을 수 있음(detectCodexHome 정규식 확인). 현재 폴백 = ${CODEX_HOME}\n`);
}

function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return { bySession: {}, byWorkspace: {} };
  }
}
function saveLinks(links) {
  return atomicWrite(LINKS_FILE, JSON.stringify(links, null, 2));
}
// links.json 쓰기 단일 관문(CAS+재시도): 최신본을 읽어 mutate로 '내 부분'만 바꾸고, 쓰기 직전 파일이 그새
// 바뀌었으면(확장·다른 ask 프로세스가 저장) 최신본으로 다시 적용해 재시도한다 → 마지막 글쓴이가 남의 변경을
// 통째로 덮어쓰는 lost-update를 크게 줄인다. ⚠ 완전한 lock은 아님(재읽기↔쓰기 사이 미세 경쟁 잔존 — 문서화된 한계).
function readLinksRaw() { try { return fs.readFileSync(LINKS_FILE, "utf8"); } catch { return ""; } }
function updateLinks(mutate, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    const before = readLinksRaw();
    let o; try { o = before ? JSON.parse(before) : {}; } catch { o = {}; }
    o.bySession = o.bySession || {};
    o.byWorkspace = o.byWorkspace || {};
    mutate(o);
    if (readLinksRaw() !== before) continue; // 그새 누가 저장함 → 최신본으로 재적용(재시도)
    return saveLinks(o);
  }
  // 재시도 소진(계속 경합) — 최신본에 한 번 더 적용해 best-effort 저장(드롭보다 나음)
  let o; try { o = JSON.parse(readLinksRaw()); } catch { o = {}; }
  o.bySession = o.bySession || {};
  o.byWorkspace = o.byWorkspace || {};
  mutate(o);
  return saveLinks(o);
}

// 연결 조회: 세션id 우선, 없으면 워크스페이스 폴백.
// 워크스페이스 링크를 우선한다(대시보드가 기록하는 것 = 사용자 명시 선택). bySession은 폴백.
// 과거엔 bySession을 우선해서, 한 번 --allow-new로 만들어진 세션이 박히면 대시보드로 다시
// 연결해도 안 먹고 엉뚱한 세션으로 검증이 가는 버그가 있었다 → 대시보드와 브릿지가 같은 기준을 보게 통일.
function resolveLink(links) {
  const ws = workspace();
  const wsLink = lookupWorkspace(links, ws);
  if (wsLink) return { ...wsLink, via: wsLink.via === "ui" ? "workspace·UI지정" : "workspace" };
  // bySession 폴백은 '그 항목의 워크스페이스가 현재와 같을 때만'. 다른 워크스페이스의 stale 링크가
  // byWorkspace 미스 시 새어드는 교차오염(검증이 엉뚱한 세션으로 감)을 막는다. (Codex 검증 #4)
  const cid = claudeId();
  const sLink = cid ? links.bySession[cid] : null;
  if (sLink && normWs(sLink.workspace || "") === normWs(ws)) return { ...sLink, via: "session(폴백)" };
  return null;
}
// 연결 기록은 CAS 관문(updateLinks)을 통과 — ask 도중 확장/다른 프로세스가 links.json을 바꿔도
// 그 변경을 덮어쓰지 않는다. 연결 성공이므로 이 워크스페이스의 autoNewFailed 폭증방지 플래그도 함께 해제한다.
function recordLink(codexSession) {
  const wsNow = workspace();
  const claude = claudeId();
  const nk = normWs(wsNow);
  const entry = { codexSession, workspace: wsNow, claudeSession: claude, linkedAt: nowIso() };
  return updateLinks((links) => {
    if (claude) links.bySession[claude] = entry;
    // 정규화 키로 저장 + 동일 워크스페이스의 옛 키(대소문자 다름 등) 정리.
    for (const k of Object.keys(links.byWorkspace)) {
      if (normWs(k) === nk) delete links.byWorkspace[k];
    }
    links.byWorkspace[nk] = entry;
    if (links.autoNewFailed) delete links.autoNewFailed[nk]; // 연결됨 → 폭증방지 플래그 해제(호출부 중복 제거)
  });
}

// ── 모델/생각강도 선택(프로젝트별) — links.json modelPrefs[normWs] = {model, reasoning} ──
// 런타임 검증(2026-06-20): 모델/생각강도는 세션에 고정 저장되지 않고 '호출별'이라, 매 resume/새세션
// 호출마다 -c로 다시 실어야 적용된다. 값은 TOML 파싱 실패 시 raw 문자열로 쓰여 따옴표 없이 model=gpt-5.5 안전.
function modelPrefFor(links, ws) {
  return (links.modelPrefs && links.modelPrefs[normWs(ws)]) || {};
}
function modelArgs(pref) {
  const a = [];
  if (pref && typeof pref.model === "string" && pref.model.trim()) a.push("-c", `model=${pref.model.trim()}`);
  if (pref && typeof pref.reasoning === "string" && pref.reasoning.trim()) a.push("-c", `model_reasoning_effort=${pref.reasoning.trim()}`);
  return a;
}

// sessions 폴더에서 특정 uuid의 rollout 파일 경로 찾기.
function findRolloutById(uuid) {
  let found = null;
  const walk = (d, depth) => {
    if (found || depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (found) return;
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && it.name.includes(uuid) && it.name.endsWith(".jsonl")) found = full;
    }
  };
  walk(SESSIONS_DIR, 0);
  return found;
}

// 특정 시각 이후 생성/수정된 rollout 중 최신 → 방금 만든 세션 식별용.
function newestRolloutSince(sinceMs) {
  let best = null;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        let m;
        try {
          m = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (m >= sinceMs && (!best || m > best.m)) best = { full, m };
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return best?.full || null;
}

// 세션 식별용: 그 세션의 첫 '실제' 사용자 발화를 짧게 뽑는다.
function firstUserSnippet(file) {
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n")) {
      const s = l.trim();
      if (!s || s[0] !== "{") continue;
      let o;
      try {
        o = JSON.parse(s);
      } catch {
        continue;
      }
      if (o.type === "response_item" && o.payload?.type === "message" && o.payload.role === "user") {
        const t = (o.payload.content || []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
        if (t && !/^<(environment_context|user_instructions|system)/i.test(t)) {
          return t.replace(/\s+/g, " ").slice(0, 70);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return "(내용 미상)";
}

// 최근 rollout(헤드리스 포함) 목록 — 최신 수정순.
// 숨긴 세션(대시보드 후보에서 제외). ~/.codex-bridge/sessions-meta.json (id→{state}). 원본 rollout은 안 건드림(§5.1).
function hiddenSessions() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, "sessions-meta.json"), "utf8"));
    return new Set(Object.keys(o).filter((k) => o[k] && (o[k].state === "hidden" || o[k] === "hidden")));
  } catch {
    return new Set();
  }
}

function recentRollouts(limit) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try {
      items = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        const m = it.name.match(UUID_RE);
        if (!m) continue;
        let mt = 0;
        try {
          mt = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        out.push({ id: m[1], file: full, mtime: mt });
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  const hidden = hiddenSessions();
  return out.filter((r) => !hidden.has(r.id)).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function indexedSessions() {
  try {
    return fs
      .readFileSync(INDEX_FILE, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// codex exec 실행(헤드리스). stdin 닫음(멈춤 방지), 최종 메시지는 -o 파일에서 회수.
// 검증(codex exec) 대기시간(분). 깊은 추론이 기본 8분을 넘는 경우가 있어 사용자가 늘릴 수 있게 한다.
// 우선순위: 환경변수 CODEX_BRIDGE_VERIFY_TIMEOUT_MIN > links.json settings.verifyTimeoutMin > 기본 8.
// 1~60분으로 제한 — 너무 짧으면 정상 검증을 실패 처리하고, 너무 길면 한 턴이 무한정 묶인다.
function verifyTimeoutMin() {
  const env = Number(process.env.CODEX_BRIDGE_VERIFY_TIMEOUT_MIN);
  let min = Number.isFinite(env) && env > 0 ? env : NaN;
  if (!Number.isFinite(min)) {
    try { const s = (loadLinks() || {}).settings; const v = Number(s && s.verifyTimeoutMin); if (Number.isFinite(v) && v > 0) min = v; } catch { /* 기본값 */ }
  }
  if (!Number.isFinite(min)) min = 8;
  return Math.max(1, Math.min(60, Math.round(min))); // 정수 분으로 통일(UI 보정과 일치 — 수동 편집의 소수도 반올림)
}
function runCodex(extraArgs, prompt) {
  const inv = resolveCodex();
  const outFile = path.join(os.tmpdir(), `codex_bridge_${process.pid}_${Date.now()}.txt`);
  // 프롬프트는 인자가 아니라 stdin으로 전달 → 따옴표/줄바꿈/셸(.cmd) 무관하게 안전(범용).
  const codexArgs = [...inv.args, "exec", "--skip-git-repo-check", "-o", outFile, ...extraArgs];
  const r = spawnSync(inv.file, codexArgs, {
    input: prompt,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: verifyTimeoutMin() * 60 * 1000,
    windowsHide: true,
    encoding: "utf8",
    shell: !!inv.shell,
    // 무거운 검증(코덱스가 파일을 많이 읽으면 stderr가 커짐)에서 기본 1MB를 넘으면 Windows가 ENOBUFS로
    // spawn을 죽여 검증이 결과 없이 실패한다 → 천장을 크게 올려 출력량 때문에 검증이 깨지지 않게 한다.
    maxBuffer: 1024 * 1024 * 256,
  });
  let answer = "";
  try {
    answer = fs.readFileSync(outFile, "utf8").trim();
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* ignore */
  }
  // 종료코드 nonzero는 -o 파일이 남아도 실패로 본다(부분/오류 출력이 성공처럼 소비되지 않게).
  const badExit = typeof r.status === "number" && r.status !== 0;
  // 실패 시 "무엇으로 어떻게 실패했는지"를 붙인다 — 다음 세션이 추측으로 헤매지 않게.
  let diag = "";
  if (r.error || !answer || badExit) {
    diag =
      `\n[브릿지 진단] codex 실행방식=${inv.how} · file=${path.basename(inv.file)}` +
      (inv.args.length ? ` · launcher=${path.basename(inv.args[0])}` : "") +
      `\n  spawn=${r.error ? r.error.code || r.error.message : "ok"} · exit=${r.status} · signal=${r.signal || "-"}` +
      `\n  (자세한 점검: node "${__filename}" doctor)`;
  }
  return { answer, error: r.error, status: r.status, stderr: (r.stderr || "").toString() + diag };
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function cmdAsk(rest) {
  const forceNew = rest.includes("--force-new"); // 엉뚱 폴더 방어를 무릅쓰고 '이 폴더'에 새 세션 강제
  const allowNew = rest.includes("--allow-new") || forceNew;
  const prompt = rest.filter((x) => x !== "--allow-new" && x !== "--force-new").join(" ").trim();
  if (!prompt) die('사용법: ask "<프롬프트>"', 2);

  try { maybeCleanupState(); } catch { /* 오래된 상태파일 정리 best-effort(Stop 훅 미설치 환경 대비) — 하루 1회 */ }
  const links = loadLinks();
  const link = resolveLink(links);
  const ws = workspace(); // V9: 이 ask 전체가 '하나의 워크스페이스 스냅샷'을 공유(modelPref·가드·proof·codex계약 일관)
  const mArgs = modelArgs(modelPrefFor(links, ws)); // 선택한 모델/생각강도를 매 호출 -c로 재적용(호출별이라 필수)

  if (link) {
    const file = findRolloutById(link.codexSession);
    if (!file) {
      // 연결은 있으나 세션이 사라짐 → 보고만, 새로 안 만듦.
      die(
        `⚠️ 연결된 Codex 세션(${link.codexSession})을 찾을 수 없습니다(삭제됨?).\n` +
          `→ 새로 시작하려면: ask --allow-new "..."  /  다른 세션에 붙이려면: link <id>`,
      );
    }
    try { writePhase("codex-verifying", { round: (readPhase().round || 0) + 1, session: claudeId(), workspace: ws }); } catch { /* 진행표시 best-effort */ }
    const { answer, error, status, stderr } = runCodex(["resume", link.codexSession, ...mArgs], withContract(prompt, ws));
    if (error || !answer || (typeof status === "number" && status !== 0)) {
      try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // ask 실패 → 진행표시 codex-verifying 잔존 방지(Claude로 복귀)
      die(`Codex resume 실패: ${error?.message || ""}\n${stderr.slice(-500)}`);
    }
    try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // 검증 답 수신 → Claude 반영중
    writeProof(link.codexSession, answer, ws); // 실제 성공 → 검증 증명 기록(verify-guard가 인정)
    flagEvidence(answer, ws, link.codexSession); // 결정2: 인용 근거 존재성 + 이 세션에서 다룬 흔적 점검 → 불일치/미확인이면 노랑
    flagVerdict(answer, ws); // 비-깨끗한 결론(실패/불가/보류)이면 노랑, 답에 판정 줄이 없으면 표지 누락 노랑 가시화(자동 차단 X)
    process.stdout.write(`# 연결 세션 ${link.codexSession} (${link.via})\n\n${formatForClaude(answer)}\n`);
    return;
  }

  // 연결 전무 = 진짜 첫 소통.
  if (!allowNew) {
    // (나) 정책: 보고만 하고 멈춤. 멋대로 새 세션 안 만듦.
    die(
      `🔌 이 Claude 세션/워크스페이스에 연결된 Codex 세션이 없습니다.\n` +
        `   - 기존 세션에 연결:   node codex-bridge.js link <codex-session-id>   (목록: find)\n` +
        `   - 가장 최근에 연결:   node codex-bridge.js link --last\n` +
        `   - 새로 시작(첫 소통): node codex-bridge.js ask --allow-new "..."\n` +
        `※ 새 세션을 임의로 만들지 않았습니다.`,
      3,
    );
  }

  // 엉뚱 폴더 방어: 새 세션을 만들기 '직전', 지금 실행 폴더가 실제 Claude 대화가 도는 폴더(active.json)와
  // 다르면 십중팔구 엉뚱한 폴더(터미널 cwd)에서 돌린 것 → 조용히 새 세션을 만들어 목록을 오염시키지 말고 막는다.
  // 정상 흐름(대화 폴더에서 실행)은 here==active.workspace라 안 막힘. 정말 여기 만들려면 --force-new.
  // (NFC 정규화로 한글 등 경로의 NFC/NFD 차이로 인한 오탐 방지 — 전역 normWs는 건드리지 않음.)
  const here = ws;
  const active = readActive();
  const myClaude = claudeId();
  const sameWs = (a, b) => normWs(a) === normWs(b); // normWs가 이미 NFC 정규화하므로 단순 비교로 충분
  // active.json은 전역 1개 파일이라 멀티 창에선 '마지막에 프롬프트 넣은 대화'가 덮어쓴다. 그래서 workspace만 보고
  // 막으면 다른 창/오래된 active로 정상 폴더를 오탐 차단할 수 있다. → active가 '바로 이 Claude 대화'의 것일 때만
  // (active.claudeSession == 현재 CLAUDE_CODE_SESSION_ID) 강한 차단. 불일치/세션id 없음/active 없음이면 차단 안 함(오탐 방지).
  const activeIsThisConv = active && active.claudeSession && myClaude && active.claudeSession === myClaude;
  if (!forceNew && activeIsThisConv && active.workspace && !sameWs(active.workspace, here)) {
    die(
      `⚠️ 새 Codex 세션을 만들 '이 폴더'가 지금 이 Claude 대화가 도는 폴더와 다릅니다.\n` +
        `   - 이 폴더(실행 위치): ${here}\n` +
        `   - 이 대화의 폴더:     ${active.workspace}\n` +
        `   엉뚱한 폴더에서 돌렸을 가능성이 큽니다. 새 세션을 만들지 않았습니다.\n` +
        `   → 그 대화 폴더에서 실행하거나, CLAUDE_PROJECT_DIR을 그 폴더로 설정하세요.\n` +
        `   → 정말 '${here}'에 새 세션을 만들려면: ask --force-new "..."`,
      3,
    );
  }

  // 폭증 방지: 직전 --allow-new가 세션을 만들고도 연결 기록에 실패했으면, 또 만들지 않는다(수동 link 유도).
  // 게이트는 시작 시점 스냅샷이 아니라 '지금' 상태로 본다 — 그새 다른 창이 수동 연결로 플래그를 해제했을 수 있음.
  const wsKey = normWs(ws);
  const freshAutoFail = (loadLinks() || {}).autoNewFailed;
  if (freshAutoFail && freshAutoFail[wsKey]) {
    die(
      `⚠️ 직전에 새 Codex 세션을 만들었지만 연결 기록에 실패했습니다(세션id 식별 실패).\n` +
        `   무한 생성 방지를 위해 자동 생성을 멈춥니다.\n` +
        `   - 만든 세션 연결: node codex-bridge.js find  →  node codex-bridge.js link <id>\n` +
        `   - 폴더 탐지 점검: node codex-bridge.js doctor`,
      3,
    );
  }

  // --allow-new: 새 세션 생성 + 연결 기록.
  const since = Date.now() - 2000;
  try { writePhase("codex-verifying", { round: (readPhase().round || 0) + 1, session: claudeId(), workspace: ws }); } catch { /* 진행표시 best-effort */ }
  const { answer, error, status, stderr } = runCodex([...mArgs], withContract(prompt, ws));
  if (error || !answer || (typeof status === "number" && status !== 0)) {
    // 응답은 실패했지만 세션 파일이 생겼을 수 있음 → 폭증 방지 플래그를 걸어 다음 자동 생성을 막고 종료.
    if (newestRolloutSince(since)) {
      updateLinks((o) => { o.autoNewFailed = o.autoNewFailed || {}; o.autoNewFailed[wsKey] = true; });
    }
    try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // ask 실패 → 진행표시 정리(Claude로 복귀)
    die(`Codex 새 세션 실패: ${error?.message || ""}\n${stderr.slice(-500)}\n(세션 파일이 생겼다면 'find'→'link <id>'로 연결하세요.)`);
  }
  try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // 검증 답 수신 → Claude 반영중
  const newFile = newestRolloutSince(since);
  const m = newFile && newFile.match(UUID_RE);
  if (m) {
    const ok = recordLink(m[1]); // CAS 저장 + autoNewFailed[wsKey] 해제 포함
    writeProof(m[1], answer, ws); // 실제 성공 → 검증 증명 기록
    flagEvidence(answer, ws, m[1]); // 결정2: 인용 근거 존재성 + 이 세션에서 다룬 흔적 점검
    flagVerdict(answer, ws); // 비-깨끗한 결론(실패/불가/보류)이면 노랑, 답에 판정 줄이 없으면 표지 누락 노랑 가시화(자동 차단 X)
    // 머리말도 실패를 반영 — stdout만 보는 호출자가 성공으로 오해하지 않게(stderr 경고와 함께).
    const head = ok
      ? `# 새 Codex 세션 생성·연결: ${m[1]}`
      : `# 새 Codex 세션 생성됨(${m[1]}) — ⚠️ 연결 기록 저장 실패(권한/잠금?), 'node codex-bridge.js link ${m[1]}'로 다시 연결하세요`;
    process.stdout.write(`${head}\n\n${formatForClaude(answer)}\n`);
    if (!ok) process.stderr.write(`⚠️ 연결 기록 저장 실패(권한/잠금?) — 세션 ${m[1]}은 생성됨. 'node codex-bridge.js link ${m[1]}'로 다시 연결하세요.\n`);
  } else {
    updateLinks((o) => { o.autoNewFailed = o.autoNewFailed || {}; o.autoNewFailed[wsKey] = true; }); // 다음 자동 생성 차단 플래그
    writeProof("", answer, ws); // Codex는 성공 응답함(세션id만 미식별) → 검증은 인정
    flagEvidence(answer, ws, ""); // 세션id 미식별 → 존재성 점검만(다룬-흔적 점검은 rollout 못 찾아 자동 보류)
    flagVerdict(answer, ws); // 비-깨끗한 결론(실패/불가/보류)이면 노랑, 답에 판정 줄이 없으면 표지 누락 노랑 가시화(자동 차단 X)
    process.stdout.write(`# 새 세션 생성됨(세션id 식별 실패) — 폭증 방지로 다음 자동 생성은 멈춥니다. 'find'로 찾아 'link <id>' 하세요.\n\n${formatForClaude(answer)}\n`);
  }
}

function cmdLink(rest) {
  let id;
  if (rest[0] === "--last") {
    const rec = recentRollouts(1);
    if (!rec.length) die("Codex 세션이 없습니다. (find로 확인)");
    id = rec[0].id;
  } else if (rest[0] && UUID_RE.test(rest[0])) {
    id = rest[0].match(UUID_RE)[1];
  } else {
    die('사용법: link <codex-session-id> | link --last   (후보: find)', 2);
  }
  const file = findRolloutById(id);
  const ok = recordLink(id); // CAS 저장 + autoNewFailed 해제 포함(수동 연결도 동일 관문)
  process.stdout.write(
    (ok ? `✅ 연결됨` : `⚠️ 연결 기록 저장 실패(권한/잠금?) — 다시 시도하세요`) +
      `: Claude(${claudeId() || "?"}) + ${workspace()}  →  Codex ${id}\n` +
      (file ? `   세션 파일: ${path.basename(file)}\n` : `   ⚠️ 해당 세션 rollout 파일이 안 보임(추후 resume 시 실패할 수 있음)\n`),
  );
}

// 모델/생각강도 선택 보기·설정·해제(프로젝트별). 대시보드가 links.json을 직접 쓰지만, CLI로도 점검/테스트 가능.
function cmdPref(rest) {
  const ws = workspace();
  const key = normWs(ws);
  let ok = true;
  if (rest[0] === "set") {
    ok = updateLinks((o) => {
      o.modelPrefs = o.modelPrefs || {};
      const cur = o.modelPrefs[key] || {};
      for (const kv of rest.slice(1)) {
        const i = kv.indexOf("=");
        if (i < 0) continue;
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (k === "model") cur.model = v;
        else if (k === "reasoning") cur.reasoning = v;
      }
      o.modelPrefs[key] = cur;
    });
  } else if (rest[0] === "clear") {
    ok = updateLinks((o) => { if (o.modelPrefs) delete o.modelPrefs[key]; });
  }
  if (!ok) process.stderr.write(`⚠️ 모델 선택 저장 실패(권한/잠금?) — 다시 시도하세요.\n`);
  const pref = (loadLinks().modelPrefs || {})[key] || {};
  process.stdout.write(
    `워크스페이스: ${ws}\n` +
      `선택값: model=${pref.model || "(기본)"} · 생각강도=${pref.reasoning || "(기본)"}\n` +
      `다음 ask 주입 인자: ${modelArgs(pref).join(" ") || "(없음 — codex config 기본값 사용)"}\n`,
  );
}

function cmdStatus() {
  const links = loadLinks();
  const link = resolveLink(links);
  process.stdout.write(`Claude 세션: ${claudeId() || "(env 없음)"}\n워크스페이스: ${workspace()}\n`);
  if (!link) {
    process.stdout.write("연결: 없음 (ask 하면 보고만 함, 또는 link/--allow-new)\n");
    return;
  }
  const file = findRolloutById(link.codexSession);
  process.stdout.write(
    `연결: Codex ${link.codexSession} (${link.via})  · 파일 ${file ? "있음" : "없음(삭제됨?)"}\n`,
  );
}

function cmdFind() {
  const links = loadLinks();
  const link = resolveLink(links);
  const list = recentRollouts(12);
  if (!list.length) {
    process.stdout.write("Codex 세션 없음.\n");
    return;
  }
  process.stdout.write("최근 Codex 세션(연결 후보 — 첫 사용자 발화로 식별):\n");
  for (const s of list) {
    const mark = link && link.codexSession === s.id ? "  ★현재 연결됨" : "";
    const when = s.mtime ? new Date(s.mtime).toLocaleString() : "";
    process.stdout.write(`  ${s.id}${mark}\n     ${when} · ${firstUserSnippet(s.file)}\n`);
  }
  process.stdout.write('\n연결 바꾸기: node codex-bridge.js link <id>\n');
}

// 진단 전용(doctor에서만 호출): CODEX_HOME 하위에서 '실제 rollout이 떨어진 폴더'를 관찰한다(archived_sessions 제외).
// SESSIONS_DIR(=CODEX_HOME/sessions) 가정이 어긋났는지(미래 codex layout 변경 등) '진단'만 — 자동 전환은 안 한다
// (archived 등 오탐 위험). 비용 제한 위해 깊이 제한. 없으면 null.
function observeRolloutDir() {
  let best = null, bestMt = 0;
  const walk = (d, depth) => {
    if (depth > 7) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (it.name === "archived_sessions") continue; // active 세션 아님 → 오탐 제외
        walk(path.join(d, it.name), depth + 1);
      } else if (it.isFile() && /^rollout-.*\.jsonl$/.test(it.name)) {
        let mt = 0;
        try { mt = fs.statSync(path.join(d, it.name)).mtimeMs; } catch { /* ignore */ }
        if (mt > bestMt) { bestMt = mt; best = d; }
      }
    }
  };
  walk(CODEX_HOME, 0);
  return best;
}

// 점검: codex를 실제로 실행 가능한지 + 연결/검증 상태를 한눈에. 검증이 안 될 때 추측 대신 이걸 본다.
function cmdDoctor() {
  const inv = resolveCodex();
  const runnable = inv.shell ? null : fs.existsSync(inv.file) && (!inv.args.length || fs.existsSync(inv.args[0]));
  process.stdout.write("=== codex-bridge doctor ===\n");
  process.stdout.write(`codex 실행방식 : ${inv.how}\n`);
  process.stdout.write(`실행 명령      : ${inv.file}${inv.args.length ? " " + inv.args.join(" ") : ""}${inv.shell ? "   (PATH 셸 해석)" : ""}\n`);
  process.stdout.write(`실행 가능?     : ${inv.shell ? "PATH 의존(런타임 확인)" : runnable ? "예" : "아니오  ← 검증 불가의 직접 원인"}\n`);
  let c = null;
  try {
    c = loadContract();
  } catch {
    /* ignore */
  }
  process.stdout.write(`검증 모드      : ${c ? c.verifyMode : "(계약 로드 실패)"}\n`);
  process.stdout.write(`Claude 세션    : ${claudeId() || "(env 없음)"}\n`);
  process.stdout.write(`워크스페이스   : ${workspace()}\n`);
  // 자체 폴더(브릿지 home) 진단: 확장과 훅이 같은 폴더를 보는지의 핵심. 훅이 active.json을 다른 BRIDGE_DIR에 쓰면
  // 여기서 '활성 대화기록 없음'으로 드러난다(=확장↔훅 home 불일치 or 훅 미동작).
  const bridgeSrc = process.env.CODEX_BRIDGE_HOME ? "env CODEX_BRIDGE_HOME" : "기본 ~/.codex-bridge";
  const active = readActive();
  process.stdout.write(`브릿지 폴더    : ${BRIDGE_DIR}  (출처: ${bridgeSrc})\n`);
  process.stdout.write(`활성 대화기록  : ${active ? `있음 (대화폴더: ${active.workspace || "?"})` : "없음 ← 훅 미동작이거나 확장↔훅이 다른 폴더를 봄(CODEX_BRIDGE_HOME 일치 확인)"}\n`);
  const homeSrc = process.env.CODEX_HOME ? "env CODEX_HOME" : readPinnedHome() ? "codex-home.txt(자동탐지)" : "기본 ~/.codex";
  process.stdout.write(`Codex home     : ${CODEX_HOME}  (출처: ${homeSrc})\n`);
  process.stdout.write(`세션 폴더      : ${SESSIONS_DIR} · ${fs.existsSync(SESSIONS_DIR) ? "있음" : "없음 ← 세션 안 보이면 1순위 의심"}\n`);
  const links = loadLinks();
  const link = resolveLink(links);
  if (link) {
    const file = findRolloutById(link.codexSession);
    process.stdout.write(`연결           : Codex ${link.codexSession} (${link.via}) · 세션파일 ${file ? "있음" : "없음(삭제됨?)"}\n`);
  } else {
    process.stdout.write(`연결           : 없음 (ask=보고만 / 첫 소통=ask --allow-new)\n`);
  }
  if (!inv.shell && !runnable) {
    process.stdout.write(`\n해결: CODEX_BIN 환경변수에 codex 실행파일 또는 bin/codex.js 경로를 지정하세요.\n`);
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    process.stdout.write(
      `\n⚠ 세션 폴더가 없음. 세션 목록/연결/검증/삭제가 안 되면 1차 의심:\n` +
        `  codex 업데이트로 'codex doctor'의 CODEX_HOME 출력 형식이 바뀌어 home 자동탐지가 깨졌을 수 있음.\n` +
        `  → 'node codex-bridge.js detect-home' 재실행. 그래도 실패면 detectCodexHome()의 파싱 규칙(정규식) 확인.\n`,
    );
  }
  // layout 변경 진단: 세션 폴더가 없거나 비었는데 CODEX_HOME 하위 다른 곳에 rollout이 있으면 알린다(자동 전환은 안 함).
  if (!fs.existsSync(SESSIONS_DIR) || !newestRolloutSince(0)) {
    const obs = observeRolloutDir();
    // 'obs가 SESSIONS_DIR 하위인가'를 path.relative로 경계 있게 판정(단순 prefix는 sessions_backup·sessions2 형제를
    // 하위로 오판). rel이 ""(같음)이거나 ".."로 시작 안 하고 절대경로 아니면 하위 → 그 경우만 알림 억제.
    const rel = obs ? path.relative(normWs(SESSIONS_DIR), normWs(obs)) : "..";
    const underSessions = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (obs && !underSessions) {
      process.stdout.write(
        `\n↪ 단, CODEX_HOME 하위 다른 곳에 rollout이 있음:\n   ${obs}\n` +
          `   → codex가 세션 위치를 바꿨을 수 있음(layout 변경). 이 경로 기준으로 CODEX_HOME/세션 폴더 해석을 점검하세요.\n` +
          `   (자동 전환은 하지 않음 — archived 등 오탐 방지. 필요 시 CODEX_HOME을 위 경로의 상위로 맞추세요.)\n`,
      );
    }
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "ask":
      return cmdAsk(rest);
    case "link":
      return cmdLink(rest);
    case "status":
      return cmdStatus();
    case "find":
      return cmdFind();
    case "doctor":
      return cmdDoctor();
    case "detect-home":
      return cmdDetectHome();
    case "pref":
      return cmdPref(rest);
    default:
      process.stdout.write(
        "codex-bridge: ask | link | status | find | doctor | detect-home | pref\n" +
          '  node codex-bridge.js ask "<프롬프트>"\n' +
          '  node codex-bridge.js ask --allow-new "<프롬프트>"\n' +
          '  node codex-bridge.js ask --force-new "<프롬프트>"  (엉뚱 폴더 방어 무시, 이 폴더에 새 세션 강제)\n' +
          "  node codex-bridge.js link <id> | link --last\n" +
          "  node codex-bridge.js status | find | doctor | detect-home\n" +
          "  node codex-bridge.js pref [set model=<m> reasoning=<low|medium|high> | clear]\n",
      );
  }
}

if (require.main === module) main(); // CLI로 직접 실행할 때만. require 시엔 테스트용 export만.
module.exports = { withContract, checkCitedEvidence, resolveCitedPath, flagEvidence, flagVerdict, updateLinks, loadLinks, saveLinks, LINKS_FILE, verifyTimeoutMin, citedResolvedBasenames, citedFilesUnseen };
