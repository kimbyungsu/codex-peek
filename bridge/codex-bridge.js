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
//   node codex-bridge.js ask --force-resend "<...>" 같은 요청 진행 중 차단(중복 전송 가드)을 의식적으로 우회
//   node codex-bridge.js ask --net "<...>"          이 1회만 검증자 네트워크 허용(파일 읽기전용 유지) — 원격(GitHub 등) 직접 확인용
//   node codex-bridge.js link <codex-session-id>   현재 Claude 세션을 기존 Codex 세션에 연결
//   node codex-bridge.js link --last               가장 최근(인덱스된) Codex 세션에 연결
//   node codex-bridge.js status                    현재 연결 상태
//   node codex-bridge.js find                       연결 후보(인덱스된 Codex 세션) 목록

const { spawnSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadContract, buildInjection, buildScoutAttach, loadBaseDirective, atomicWrite, readPhase, writePhase, appendIntegrityEvent, supersedeIntegrity, maybeCleanupState, extractVerdict, formatForClaude, configWs, appendVerdict, loadLang, appendLedgerEvent, readLedgerEventsText, ledgerPathsFromText, resolveScoutRepo, appendScoutTargetEvidence, askInflightGuard, askInflightFileFor, claimAskInflight, reclaimAskInflight, overwriteAskInflight, clearAskInflight } = require("./contract-lib.js");

// 사용자 요청 앞에 [검증 기본 원칙](기본 지침, 오버라이드 가능) + Codex 고정 계약을 prepend(매 ask마다).
// 기본 지침은 contract-lib의 loadBaseDirective()에서 로드 → 대시보드에서 보기/수정/초기화 가능. 코드에 캐논 기본값 상존.
// 호출 시점 전역 언어의 문자열 선택(무결성 detail·CLI 안내 등). ask 본문 흐름은 langSnap 사용.
function tB(ko, en) { return loadLang() === "en" ? en : ko; }
function withContract(prompt, ws, lang, carrier) {
  // lang: 언어 스냅샷(cmdAsk의 langSnap) — 미지정 시 전역 언어. 주입(기본지침·계약 지시문)과 헤더/footer 언어를 한 스냅샷으로 일관.
  // carrier(L1-A): 호출자가 준 객체에 '이번 ask에 실제로 실린 동봉 스냅샷'(mapItems·couplings)을 담아 준다 —
  // 확인 판정(flagLedgerConfirms)이 '지금 다시 계산한 동봉'이 아니라 '전송된 그 동봉'으로 echo를 판정하게(Codex 설계검증).
  const baseline = loadBaseDirective(lang).verifyBaseline;
  let inj = "", scout = "", c = null;
  try {
    // 계약은 '연 폴더(configWs)' 기준으로 로드 — cmdAsk가 modelPref·proof·라벨·withContract에 같은 configWs 스냅샷(ws)을
    // 넘겨, 작업 cwd가 외부 폴더로 흔들려도 사용자가 연 폴더에 건 계약이 일관 적용된다(인자 없으면 configWs()로 폴백).
    // (resolveLink/recordLink도 configWs 기준 — 세션은 작업 cwd가 아니라 이 대화의 연 폴더에 묶인다.)
    c = loadContract(ws || configWs(), lang);
    inj = buildInjection(c.codex, "Codex", c.codexChecklist, lang);
  } catch {
    inj = "";
  }
  // Phase 3 동봉은 별도 try — 새 기능(지도 동봉) 실패가 기존 계약 주입(inj)까지 지우지 않게(모든 ask의 급소 분리).
  try {
    const att = c ? buildScoutAttach(ws || configWs(), c, lang) : null;
    if (att && typeof att === "object") {
      scout = att.text || "";
      if (carrier && typeof carrier === "object") { carrier.mapItems = att.mapItems || []; carrier.couplings = att.couplings || []; }
    } else scout = att || ""; // 구형 문자열 반환 호환(테스트 목·부분 배포)
  } catch { scout = ""; }
  const head = [baseline, inj, scout].filter(Boolean).join("\n\n");
  const reqLabel = (lang || loadLang()) === "en" ? "[Work Request]" : "[작업 요청]";
  return `${head}\n\n---\n${reqLabel}\n${prompt}`;
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
// (구 workspace()=CLAUDE_PROJECT_DIR||cwd 제거: configWs(연 폴더, 설정 기준)와 process.cwd()(execCwd, 실행 기준)로 분리됨.)
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
    workspace: ws || configWs(), // 라벨=연 폴더(인자 없으면 폴백). cmdAsk의 ws 스냅샷과 동일
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
    const file = resolveCitedPath(rawPath, ws || process.cwd());
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
    const file = resolveCitedPath(m[1], ws || process.cwd());
    if (file) out.add(path.basename(file));
  }
  return out;
}
// 결정2-3(L1-A 개정): 인용한 (실재) 파일 중, '이번 턴'(rollout 마지막 사용자 메시지 이후)의 도구 명령/출력
// 어디에도 basename이 안 나타난 것. 세션 '전체' 스캔은 이전 턴에서 다룬 파일을 이번 확인의 근거로 인정하는
// 결함(Codex 설계검증). 반환은 삼상태 — {checked:false}=검사 자체가 불가(세션 미식별·대형 기록·경계 미발견·
// 도구활동 0)로, '미확인 파일 없음'(checked:true·unseen:[])과 구분된다. 판정 불가를 빈 배열로 돌려주면
// 소비자가 확인 성공으로 오독해 승격으로 흐른다(같은 지적).
function citedFilesUnseen(answer, ws, sessionId) {
  const unknown = { checked: false, unseen: [] };
  if (!sessionId) return unknown;
  let file;
  try { file = findRolloutById(sessionId); } catch { return unknown; }
  if (!file) return unknown;
  const remaining = citedResolvedBasenames(answer, ws);
  if (!remaining.size) return { checked: true, unseen: [] };
  try { if (fs.statSync(file).size > 16 * 1024 * 1024) return unknown; } catch { return unknown; } // 비정상적으로 큰 rollout은 비용·신뢰 모두 보류
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { return unknown; }
  // 턴 경계: 마지막 '사용자 메시지'(response_item message user) 줄 — 그 이후만 이번 ask의 활동.
  let lastUser = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || ln.indexOf('"message"') < 0) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o && o.type === "response_item" && o.payload && o.payload.type === "message" && o.payload.role === "user") lastUser = i;
  }
  if (lastUser < 0) return unknown; // 경계 미발견 — 세션 전체를 근거로 쓰지 않는다(판단 보류)
  let hadTool = false;
  for (let i = lastUser + 1; i < lines.length; i++) {
    const ln = lines[i];
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
  if (!hadTool) return unknown; // 이번 턴 도구활동 없음 → 이전 턴 맥락 등으로 답했을 수 있음 → 판단 보류
  return { checked: true, unseen: [...remaining] };
}
// ws=configWs(이벤트 workspace 라벨 — 대시보드 귀속), execCwd=실제 실행 폴더(인용 상대경로 해석 기준).
// 분리 이유: 코덱스 답의 '(경로:라인)' 인용은 코덱스가 돈 폴더(execCwd) 기준 상대경로라, 라벨용 연 폴더로 해석하면 오탐.
function flagEvidence(answer, ws, sessionId, execCwd) {
  const pathWs = execCwd || ws; // 경로 해석은 실행 폴더 기준(미지정 시 ws로 폴백=무회귀)
  try {
    const mism = checkCitedEvidence(answer, pathWs);
    if (mism.length) {
      appendIntegrityEvent({
        ts: nowIso(),
        session: claudeId() || ((readActive() || {}).claudeSession) || "",
        workspace: ws,
        kind: "evidence-mismatch",
        severity: "warning", // 노랑 — '의심'이지 '검증 미완(빨강)'은 아님
        // detailKo/detailEn 동시 저장(동적 목록 포함) — 표시부가 현재 언어 선택. detail은 구버전 판독 폴백.
        detail: tB(`검증 답의 인용 근거 ${mism.length}개가 실제 파일/라인과 불일치(존재하지 않는 줄): ${mism.slice(0, 3).join(" / ")}`, `${mism.length} cited evidence item(s) do not match real files/lines (nonexistent lines): ${mism.slice(0, 3).join(" / ")}`),
        detailKo: `검증 답의 인용 근거 ${mism.length}개가 실제 파일/라인과 불일치(존재하지 않는 줄): ${mism.slice(0, 3).join(" / ")}`,
        detailEn: `${mism.length} cited evidence item(s) do not match real files/lines (nonexistent lines): ${mism.slice(0, 3).join(" / ")}`,
      });
    }
    const seenChk = citedFilesUnseen(answer, pathWs, sessionId);
    const unseen = seenChk.checked ? seenChk.unseen : []; // 판단 보류(checked=false)는 경보 안 함 — 종전과 동일한 보수성
    if (unseen.length) {
      appendIntegrityEvent({
        ts: nowIso(),
        session: claudeId() || ((readActive() || {}).claudeSession) || "",
        workspace: ws,
        kind: "evidence-unseen",
        severity: "warning", // 노랑(의심) — '안 읽음' 단정이 아니라 '기록에서 다룬 흔적 미확인'
        // detailKo/detailEn 동시 저장(동적 목록 포함) — 표시부가 현재 언어 선택. detail은 구버전 판독 폴백.
        detail: tB(`검증 답이 인용한 파일 ${unseen.length}개를 이 검증 기록에서 다룬 흔적을 확인하지 못했습니다(이전 턴에서 봤거나 기록 형식 차이일 수 있음 — '안 읽음' 단정 아님): ${unseen.slice(0, 3).join(" / ")}`, `${unseen.length} cited file(s) show no trace of being handled in this verification log (may be from an earlier turn or a log-format difference — not asserting 'unread'): ${unseen.slice(0, 3).join(" / ")}`),
        detailKo: `검증 답이 인용한 파일 ${unseen.length}개를 이 검증 기록에서 다룬 흔적을 확인하지 못했습니다(이전 턴에서 봤거나 기록 형식 차이일 수 있음 — '안 읽음' 단정 아님): ${unseen.slice(0, 3).join(" / ")}`,
        detailEn: `${unseen.length} cited file(s) show no trace of being handled in this verification log (may be from an earlier turn or a log-format difference — not asserting 'unread'): ${unseen.slice(0, 3).join(" / ")}`,
      });
    }
  } catch { /* best-effort — 점검 실패가 검증 흐름을 막지 않음 */ }
}
// 관측 장부 확인 신호(로드맵 ④ — L1-A v2) — 증거의 질을 이벤트에 남긴다(승격 판정은 유도기 DERIVE_V2):
//  claimed  = 답의 '결합확인 #id' 명시 표기(동봉 결합 후보의 id — 기계 판정 확실. 동봉이 유도하므로 태생적 echoed)
//  co-cited = 통과류 답 전체에서 항목의 서로 다른 경로 2개가 각각 실존 인용(약한 공동 인용 — 공동 인용≠결합 확인)
//  echoed   = 이번 ask 동봉의 '한 항목 안에' 그 경로 쌍이 함께 노출됐음(항목 단위 — 전역 합집합은 과도[Codex])
//  seen     = 이번 턴 취급 흔적 검사 삼상태("ok"/"unknown" — 판정 불가를 확인 성공으로 오독 금지)
//  askId    = ask 실행 UUID('서로 다른 ask 실행' 판정 재료 — '독립 턴' 주장 아님)
// 반박은 명시 표기('결합반박 #id')만 자동 적재(기계 추측 반박 없음 — 발화 기록 CLI는 별도).
// 텍스트 메아리(항목 문구가 답에 보임)로는 확인 안 됨 — 자기강화 순환 차단. 실패가 검증 흐름을 절대 막지 않음.
function flagLedgerConfirms(answer, ws, sessionId, execCwd, extra) {
  try {
    const askId = extra && extra.askId ? String(extra.askId) : "";
    const attach = extra && extra.attach && typeof extra.attach === "object" ? extra.attach : { mapItems: [], couplings: [] };
    const verdict = extractVerdict(answer);
    // P1: 확인 신호는 '정찰 대상' 장부로 — 세션 폴더가 비-git 부모여도 개발 레포 장부에 쌓인다.
    // (인용 경로 해석은 계속 execCwd 기준 — 실제 모델이 본 파일 기준. 장부 '기록 대상'만 재해석 — Codex 합의)
    let target = ws;
    try { target = resolveScoutRepo(ws, loadContract(ws)).repo; } catch { /* ws 유지(fail-open) */ }
    const now = nowIso();
    const seenChk = citedFilesUnseen(answer, execCwd || ws, sessionId);
    const seenState = seenChk.checked ? "ok" : "unknown";
    const unseen = new Set((seenChk.checked ? seenChk.unseen : []).map((b) => b.toLowerCase()));
    // 실존 인용 집합(라인 실재까지) — 표식(claimed)의 cited 판정과 공동 인용(co-cited) 둘 다의 재료.
    const cited = new Set([...citedResolvedBasenames(answer, execCwd || ws)].map((b) => b.toLowerCase()));
    for (const m of checkCitedEvidence(answer, execCwd || ws)) cited.delete(String(m).split(":")[0].toLowerCase());
    const citedPairOk = (paths) => {
      const bns = [...new Set((paths || []).map((p) => String(p).split("/").pop() || ""))].filter((b) => b.length >= 8);
      return bns.filter((b) => cited.has(b.toLowerCase()) && !unseen.has(b.toLowerCase())).length >= 2;
    };
    // ① 명시 표기(claimed) — 표식은 검증자의 '자기보고'라 방어 3겹(Codex 반례 왕복):
    //    ⑴ 행 단독만 인정(부정문 "…표기를 쓰지 않았다"·본문 예시 오인식 차단)
    //    ⑵ 같은 id에 확인·반박이 함께 오면 상충 — 둘 다 거부
    //    ⑶ 승격·강등 '재료'가 되려면 그 항목의 경로 2개가 답에서 실제 인용(라인 실재·미확인 아님)돼야 함(cited 필드
    //       — 인용 0개 답의 표식만으로 verified/disputed가 움직이는 것 차단. 기록 자체는 남김: 자기보고도 사실).
    //    id는 이번 ask에 실제 동봉된 결합 후보의 것만 인정(임의 id 날조 무시). 반박 표기는 실패 답에서도 유효.
    const byId = new Map((attach.couplings || []).map((cp) => [String(cp.id), cp]));
    if (byId.size) {
      const marks = new Map(); // id → Set(kinds)
      for (const line of String(answer || "").split(/\r?\n/)) {
        const m = line.match(/^\s*결합(확인|반박)\s*#([0-9a-f]{6})\s*$/);
        if (!m || !byId.has(m[2])) continue;
        let set = marks.get(m[2]);
        if (!set) { set = new Set(); marks.set(m[2], set); }
        set.add(m[1] === "확인" ? "confirmed" : "refuted");
      }
      for (const [id, kinds] of marks) {
        if (kinds.size > 1) continue; // 상충(확인+반박) — 자기모순 자기보고는 기록하지 않음
        const kind = [...kinds][0];
        const cp = byId.get(id);
        // cited='그 답이 항목 경로 2개를 실제(라인 실재) 인용했다'는 사실 기록 — 승격은 유도기에서 cited && seen=ok
        // 이중 게이트(promotableConfirm)로 판정되므로 여기서 seen을 겹쳐 걸지 않는다(기록의 의미를 순수하게).
        const citedOk = citedPairOk(cp.paths);
        appendLedgerEvent(target, { ts: now, type: kind, sig: cp.sig, grade: "claimed", echoed: true, askId, seen: seenState, cited: citedOk, from: `verify ${sessionId || "?"} ${verdict || "?"} — 명시 표기 #${id}${citedOk ? "" : " (인용 미동반 — 기록만)"}` });
      }
    }
    // ② 공동 인용(co-cited) — 통과류 판정에서만.
    if (verdict !== "pass" && verdict !== "pass-notes") return;
    const raw = readLedgerEventsText(target);
    if (!raw || !raw.trim()) return;
    // 원시 이벤트에서 sig→text 최소 집계(배포 사본은 out/ 유도기를 require 못 함).
    // 제외는 '현재 차단 중'(banned-unbanned 순계산 — 해제된 차단은 되살림, Codex 반례 2026-07-09)·대체·소멸만.
    // 반박 이력 항목에도 확인은 '기록'한다(2026-07-09 사용자 결정: 복권 재료를 문 앞에서 버리면 지식이 진화 못 함.
    // 승격 여부는 유도기의 복권 규칙[반박 이후 확인만 인정]이 판정).
    const texts = new Map(); const dead = new Set(); const banNet = new Map();
    for (const ln of raw.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (!o || !o.sig) continue;
      if (o.text && !texts.has(o.sig)) texts.set(o.sig, o.text);
      if (o.type === "banned") banNet.set(o.sig, (banNet.get(o.sig) || 0) + 1);
      else if (o.type === "unbanned") banNet.set(o.sig, (banNet.get(o.sig) || 0) - 1);
      else if (o.type === "superseded" || o.type === "tombstone") dead.add(o.sig);
    }
    for (const [s, n] of banNet) { if (n > 0) dead.add(s); }
    if (!texts.size) return;
    // cited(라인 실재 인용)·unseen은 위에서 표식 판정과 함께 계산됨(같은 재료 공유).
    if (cited.size < 2) return;
    // echo 판정용: 동봉 '항목 단위' basename 집합(경로+노트 안 경로들) — 전역 합집합 아님.
    const itemSets = (attach.mapItems || []).map((it) => {
      const bs = new Set();
      for (const p of ledgerPathsFromText(String(it.path || "") + " " + String(it.note || ""))) { const b = p.split("/").pop() || ""; if (b) bs.add(b.toLowerCase()); }
      return bs;
    });
    for (const cp of attach.couplings || []) {
      const bs = new Set();
      for (const p of cp.paths || []) { const b = String(p).split("/").pop() || ""; if (b) bs.add(b.toLowerCase()); }
      if (bs.size) itemSets.push(bs); // 결합 후보 동봉 자체도 '그 쌍의 노출'
    }
    for (const [sig, text] of texts) {
      if (dead.has(sig)) continue;
      // basename 8자 미만은 우연 일치 위험(index.ts류) → 제외(지도 채점기의 8자 규칙과 동일 근거)
      const bns = [...new Set(ledgerPathsFromText(text).map((p) => path.basename(p)))].filter((b) => b.length >= 8);
      const hit = bns.filter((b) => cited.has(b) && !unseen.has(b));
      if (hit.length < 2) continue;
      const lows = hit.map((b) => b.toLowerCase());
      const echoed = itemSets.some((set) => lows.filter((b) => set.has(b)).length >= 2);
      appendLedgerEvent(target, { ts: now, type: "confirmed", sig, grade: "co-cited", echoed, askId, seen: seenState, from: `verify ${sessionId || "?"} ${verdict} — 실존 인용: ${hit.slice(0, 3).join(", ")}` });
    }
  } catch { /* best-effort — 장부 실패가 검증 흐름을 막지 않음 */ }
}
// 정찰 대상 어긋남 자기진단의 '증거 수집'(구조 해법 2026-07-10 — buildScoutDirective의 detectScoutTargetDrift가 소비).
// 이 답이 실존 인용한 파일들이 어느 git 레포 소속인지 관측 1건으로 적재. 판정과 무관(어긋남은 실패 답에서도 보인다),
// 3트랙일 때만(2트랙 무회귀), 경로 해석은 execCwd 기준(세션 폴더 기준으로 풀면 어긋난 상황에서 증거 자체가 빈 값 —
// Codex 설계검증 2026-07-10). git root 탐지는 rev-parse --show-toplevel(디렉터리별 캐시·3s·실패 skip).
// safe.directory=* 는 이 발견 호출 1회 한정(레포 루트를 아직 모르는 단계라 특정 경로를 못 박음 — 읽기 전용 조회).
function collectScoutTargetEvidence(answer, ws, execCwd) {
  try {
    const c = loadContract(ws);
    if (!c || c.scoutMode !== "on") return;
    const re = /\(([^()\s]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?\)/g; // citedResolvedBasenames와 동일 파서(같은 신호원)
    const text = String(answer || "");
    const files = new Set();
    let m;
    while ((m = re.exec(text)) && files.size < 40) { const f = resolveCitedPath(m[1], execCwd || ws); if (f) files.add(f); } // 파일 상한 40(비용 상수화 — Codex 보완)
    if (!files.size) return;
    const topCache = new Map(); const counts = new Map();
    for (const f of files) {
      const d = path.dirname(f);
      let top = topCache.get(d);
      if (top === undefined) {
        if (topCache.size >= 12) continue; // 서로 다른 디렉터리 git 조회 상한(동기 3s 누적 방지 — Codex 보완)
        try {
          const r = spawnSync("git", ["-c", "safe.directory=*", "-C", d, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, windowsHide: true });
          top = r.status === 0 && String(r.stdout).trim() ? String(r.stdout).trim() : null;
        } catch { top = null; }
        topCache.set(d, top);
      }
      if (!top) continue; // git 밖 파일은 레포 증거가 아님
      const k = normWs(top);
      const cur = counts.get(k) || { repo: top, n: 0 };
      cur.n++; counts.set(k, cur);
    }
    if (!counts.size) return;
    appendScoutTargetEvidence(ws, { ts: nowIso(), repos: [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 5) });
  } catch { /* best-effort — 수집 실패가 검증 흐름을 막지 않음 */ }
}
// rollout 끝에서 '마지막 turn의 모델 + 그 turn 1회 토큰(last_token_usage)'을 읽는다 — 검증 1건의 모델·비용 기록용.
// usage-monitor 구조: type==='turn_context'의 payload.model, payload.type==='token_count'의 info.last_token_usage. 파일 끝 256KB만(검증=보통 마지막 1턴). 못 찾으면 빈/ null(통계는 '미상').
function readLastTurnTail(file, bytes) {
  let raw = "";
  const fd = fs.openSync(file, "r");
  try {
    const sz = fs.fstatSync(fd).size;
    const start = Math.max(0, sz - bytes);
    const len = Math.min(sz, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    raw = buf.toString("utf8");
  } finally { fs.closeSync(fd); }
  let model = "", effort = "", last = null;
  for (const ln of raw.split(/\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (o && o.type === "turn_context" && o.payload) {
      const m = o.payload.model || (o.payload.collaboration_mode && o.payload.collaboration_mode.settings && o.payload.collaboration_mode.settings.model);
      if (m) model = String(m); // 뒤로 갈수록 최신 turn 모델
      const ef = o.payload.effort || (o.payload.collaboration_mode && o.payload.collaboration_mode.settings && o.payload.collaboration_mode.settings.reasoning_effort);
      if (ef) effort = String(ef); // 추론강도(low/medium/high/xhigh) — turn_context.effort 또는 collaboration_mode.settings.reasoning_effort
    } else if (o && o.payload && o.payload.type === "token_count" && o.payload.info && o.payload.info.last_token_usage) {
      last = o.payload.info.last_token_usage; // 마지막 token_count의 1회 사용량
    }
  }
  const n = (x) => (typeof x === "number" && isFinite(x) ? x : 0);
  const g = (s, c) => n(last[s] != null ? last[s] : last[c]); // snake 우선, camel 폴백
  const tokens = last ? { input: g("input_tokens", "inputTokens"), cachedInput: g("cached_input_tokens", "cachedInputTokens"), output: g("output_tokens", "outputTokens"), reasoning: g("reasoning_output_tokens", "reasoningOutputTokens"), total: g("total_tokens", "totalTokens") } : null;
  return { model: model, effort: effort, tokens: tokens };
}
function parseLastTurn(file) {
  try {
    let r = readLastTurnTail(file, 256 * 1024);
    if (!r.model || !r.tokens) { const big = readLastTurnTail(file, 2 * 1024 * 1024); r = { model: r.model || big.model, effort: r.effort || big.effort, tokens: r.tokens || big.tokens }; } // 끝 256KB에 모델·토큰이 안 잡히면 더 크게 재시도(누락 줄임)
    return r;
  } catch { return { model: "", effort: "", tokens: null }; }
}
// 비-깨끗한 결론을 사용자에게 '가시화'(실패=빨강·보류·불가=노랑). 자동 차단 안 함(설계 경계 결론: 품질은 강제 말고 가시화).
// 핵심: verdict는 '최신 상태'다. 새 검증 결과가 나오면 같은 세션의 직전 verdict-nonclean을 먼저 대체(supersede)한다 →
// 실패→수정→재검증 통과로 해소되면 그 경보도 사라진다(반복 검증이 무조건 경보를 남기는 cry-wolf 방지). 그 뒤 실패(빨강)·보류·불가(노랑)일 때만 새로 띄움.
// '통과'·'통과(보완)'은 새 경보를 만들지 않는다(굿하트 '통과 도장' 안 만들기). 단 답은 있는데 마지막 판정 줄이 없으면(null)
// verdict-missing 노랑으로 '표지 누락'을 가시화한다(대시보드 색 분류 입력이 비기 때문). 빈/공백 답은 아무 신호도 안 건드린다. answer=마지막 메시지(-o).
function flagVerdict(answer, ws, codexSession, modeSnapshot) {
  try {
    const text = String(answer || "");
    if (!text.trim()) return; // 빈/공백 답 → 직전 신호(표지 누락 포함)도 함부로 안 건드림(supersede도 안 함)
    const session = claudeId() || ((readActive() || {}).claudeSession) || "";
    supersedeIntegrity(session, "verdict-missing"); // 새 답 도착 → 직전 '표지 누락' 신호는 갱신 대상(최신 1건만 유지)
    const v = extractVerdict(text);
    // 2순위: 모델·검증모드·이 검증 1회 토큰 수집(모델별/모드별 통계 재료). 못 읽으면 빈값/null → 통계에서 '미상' 처리. 과거 기록엔 이 필드들이 없다.
    let model = "", mode = modeSnapshot || "", codexTok = null, effort = ""; // mode는 cmdAsk 시작 시점 스냅샷(검증 중 사용자가 바꿔도 trigger 모드 보존)
    try { if (codexSession) { const f = findRolloutById(codexSession); if (f) { const lt = parseLastTurn(f); model = lt.model; effort = lt.effort || ""; codexTok = lt.tokens; } } } catch { /* rollout 파싱 best-effort */ }
    // 통계 누적(append-only, stats/verdicts.jsonl) — 대시보드 탭2 재료. 원문 저장 안 함(메타만). best-effort.
    try { appendVerdict({ ts: nowIso(), workspace: ws, claudeSession: session, codexSession: codexSession || "", verdict: v || "unparsed", answerChars: text.length, model: model, mode: mode, effort: effort, codexTokens: codexTok }); } catch { /* 통계 실패가 검증 흐름을 막지 않음 */ }
    if (!v) {
      // 답은 있는데 마지막 '검증:' 판정 줄이 없음 → 형식 위반 가시화. 별도 kind로 격리해 verdict-nonclean(실패 빨강·보류 노랑)은 안 건드린다.
      appendIntegrityEvent({
        ts: nowIso(),
        session,
        workspace: ws,
        kind: "verdict-missing",
        severity: "warning", // 노랑 — '통과 아님'이 아니라 '판정 표지가 없어 색 표시가 빔'
        // detailKo/detailEn 동시 저장 — 확장 표시부(readVisibleIntegrity)가 '그때그때 현재 언어'를 고른다(기록 시점 언어로 굳는 것 방지). detail은 구버전 판독 폴백.
        detail: tB("Codex 답에 마지막 '검증: 통과/통과(보완)/보류/실패' 판정 줄이 없습니다 — 대시보드 색 표시가 비고, 결론을 직접 확인해야 합니다.", "Codex's answer has no final verdict line ('Verdict: pass/pass (notes)/inconclusive/fail') — the dashboard chip stays empty; check the conclusion yourself."),
        detailKo: "Codex 답에 마지막 '검증: 통과/통과(보완)/보류/실패' 판정 줄이 없습니다 — 대시보드 색 표시가 비고, 결론을 직접 확인해야 합니다.",
        detailEn: "Codex's answer has no final verdict line ('Verdict: pass/pass (notes)/inconclusive/fail') — the dashboard chip stays empty; check the conclusion yourself.",
      });
      return; // verdict-nonclean(직전 실패 빨강·보류 노랑)은 유지
    }
    supersedeIntegrity(session, "verdict-nonclean"); // 정상 판정 → 직전 비-깨끗 신호를 대체(통과면 그대로 해소)
    if (v !== "fail" && v !== "inconclusive") return; // 통과·통과(보완) → 새 경보 없음(직전 것은 이미 supersede로 정리)
    appendIntegrityEvent({
      ts: nowIso(),
      session,
      workspace: ws,
      kind: "verdict-nonclean",
      // 실패=빨강(error) — 대시보드 칩(실패=빨강)과 일치, '고쳐야 함'의 명확한 신호. 보류·불가=노랑(warning) — '검토하라'.
      // 빨강이어도 kind는 verdict-nonclean이라 재검증 통과 시 supersede로 자동 해소(검증 미완 빨강과 달리 ack 안 해도 사라짐).
      severity: v === "fail" ? "error" : "warning",
      // detailKo/detailEn 동시 저장 — 확장 표시부가 현재 언어를 고름. detail은 구버전 판독 폴백.
      detail: v === "fail"
        ? tB("Codex 결론이 '검증 실패'입니다 — 통과가 아닙니다. 대시보드 대화에서 결론과 근거를 확인하세요.", "Codex's verdict is FAIL — not a pass. Check the conclusion and evidence in the dashboard conversation.")
        : tB("Codex 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요.", "Codex's verdict is not a pass (hold/unable/insufficient info — no conclusion). Check the conclusion in the dashboard conversation."),
      detailKo: v === "fail"
        ? "Codex 결론이 '검증 실패'입니다 — 통과가 아닙니다. 대시보드 대화에서 결론과 근거를 확인하세요."
        : "Codex 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요.",
      detailEn: v === "fail"
        ? "Codex's verdict is FAIL — not a pass. Check the conclusion and evidence in the dashboard conversation."
        : "Codex's verdict is not a pass (hold/unable/insufficient info — no conclusion). Check the conclusion in the dashboard conversation.",
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
  const ws = configWs(); // 링크 해석 기준 = 연 폴더(작업 cwd가 흔들려도 이 대화의 세션을 찾음)
  const wsLink = lookupWorkspace(links, ws);
  if (wsLink) return { ...wsLink, via: wsLink.via === "ui" ? tB("workspace·UI지정","workspace·UI-set") : "workspace" };
  // bySession 폴백은 '그 항목의 워크스페이스가 현재와 같을 때만'. 다른 워크스페이스의 stale 링크가
  // byWorkspace 미스 시 새어드는 교차오염(검증이 엉뚱한 세션으로 감)을 막는다. (Codex 검증 #4)
  const cid = claudeId();
  const sLink = cid ? links.bySession[cid] : null;
  if (sLink && normWs(sLink.workspace || "") === normWs(ws)) return { ...sLink, via: tB("session(폴백)","session (fallback)") };
  return null;
}
// 연결 기록은 CAS 관문(updateLinks)을 통과 — ask 도중 확장/다른 프로세스가 links.json을 바꿔도
// 그 변경을 덮어쓰지 않는다. 연결 성공이므로 이 워크스페이스의 autoNewFailed 폭증방지 플래그도 함께 해제한다.
function recordLink(codexSession) {
  const wsNow = configWs(); // 링크 기록 기준 = 연 폴더(세션은 작업 cwd가 아니라 이 대화의 연 폴더에 묶인다)
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

// ask --net 옵트인: 이 검증 1회에 한해 '파일 읽기전용 유지 + 외부 통신 허용' 권한 프로필을 -c 오버라이드로 주입.
// config.toml은 건드리지 않음(전역 기본은 현행 통신 차단 유지 — 검증자 안전설계). 기본 read-only 샌드박스는 죽은 프록시
// (127.0.0.1:9)를 하위 셸에 심어 통신을 끊는데, 이 프로필이 그걸 대체한다(0.118 실측: 프록시 해제·git ls-remote 성공·쓰기 여전히 거부).
// 도메인 allowlist(network.domains)는 Windows에서 미집행 실측(예: example.com 직결 성공)이라 넣지 않는다 — 거짓 안전감 방지.
// 즉 --net = "그 1회, 파일은 못 쓰지만 인터넷 전체가 열린다"가 정직한 계약.
function netArgs() {
  return [
    "-c", "default_permissions=netverify",
    "-c", 'permissions.netverify.extends=":read-only"',
    "-c", "permissions.netverify.network.enabled=true",
    "-c", "permissions.netverify.network.mode=limited",
  ];
}
// --net일 때 프롬프트 끝에 붙는 안내 — 검증자가 통신 가능함을 알고, Windows 인증서 함정(schannel)을 우회하게 한다(실측: openssl 백엔드는 성공).
function netNote(lang) {
  return lang === "en"
    ? "\n\n[Network enabled for this request (opt-in) — outbound access is allowed; filesystem stays read-only. On Windows, if git/curl fail with schannel certificate errors (SEC_E_NO_CREDENTIALS), retry with `git -c http.sslBackend=openssl ...` or use Python/Node HTTP.]"
    : "\n\n[이 요청은 네트워크 허용(옵트인) — 외부 통신 가능, 파일은 여전히 읽기전용. Windows에서 git/curl이 schannel 인증서 오류(SEC_E_NO_CREDENTIALS)를 내면 `git -c http.sslBackend=openssl ...`로 재시도하거나 Python/Node HTTP를 사용하라.]";
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

// since 이후 rollout 중 '이 워크스페이스(session_meta.cwd 일치)'의 최신 → 즉시연결 시 동시 다른 폴더 세션을
// 잘못 링크하지 않게 한다(race 방어). cwd를 못 읽는 rollout은 제외(엉뚱 링크보다 미검출이 안전 — 폴백이 받아줌).
function newestRolloutSinceForWs(sinceMs, ws) {
  const want = normWs(ws || "");
  if (!want) return null;
  let best = null;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!(it.isFile() && /^rollout-.*\.jsonl$/.test(it.name))) continue;
      let m;
      try { m = fs.statSync(full).mtimeMs; } catch { continue; }
      if (m < sinceMs || (best && m <= best.m)) continue;
      let cwd = "";
      try {
        const fd = fs.openSync(full, "r");
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);
        const line = buf.toString("utf8", 0, n).split(/\r?\n/)[0];
        const o = JSON.parse(line);
        cwd = (o.payload && o.payload.cwd) || o.cwd || "";
      } catch { continue; } // 첫 줄(session_meta) 못 읽으면 제외
      if (normWs(cwd) === want) best = { full, m };
    }
  };
  walk(SESSIONS_DIR, 0);
  return best ? best.full : null;
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
        let t = (o.payload.content || []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("").trim();
        if (t && !/^<(environment_context|user_instructions|system|recommended_plugins>)/i.test(t)) { // recommended_plugins>=Codex 실행 런타임 주입(닫는 > 요구 — 정상 유사 문자열 보존·확장 isInjected와 동형, 2026-07-10 실사고)
          // 주제 표시용: withContract가 붙인 지침 보일러플레이트를 걷어내고 '실제 요청 본문'만(확장 stripInjectedPreamble과 동일 규칙).
          for (const marker of ["\n---\n[작업 요청]\n", "\n---\n[Work Request]\n"]) {
            const i = t.lastIndexOf(marker);
            if (i >= 0) { t = t.slice(i + marker.length); break; }
          }
          return t.replace(/\s+/g, " ").trim().slice(0, 70);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return tB("(내용 미상)","(content unknown)");
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
      tB(`\n[브릿지 진단] codex 실행방식=`, `\n[bridge diagnostics] codex invocation=`) + `${inv.how} · file=${path.basename(inv.file)}` +
      (inv.args.length ? ` · launcher=${path.basename(inv.args[0])}` : "") +
      `\n  spawn=${r.error ? r.error.code || r.error.message : "ok"} · exit=${r.status} · signal=${r.signal || "-"}` +
      tB(`\n  (자세한 점검: node "${__filename}" doctor)`, `\n  (details: node "${__filename}" doctor)`);
  }
  return { answer, error: r.error, status: r.status, stderr: (r.stderr || "").toString() + diag };
}

// 새 세션 전용 비동기 실행 — 답을 기다리는 동안 rollout이 생기는 '즉시' onDetect(sessionId)를 호출(생성 즉시 연결).
// resume 경로는 기존 동기 runCodex 그대로(무위험). 반환 shape은 runCodex와 동일(+detected). cwd 일치 rollout만 조기 감지(race 방어).
function runCodexNewSessionAsync(extraArgs, prompt, sinceMs, ws, onDetect) {
  const inv = resolveCodex();
  const outFile = path.join(os.tmpdir(), `codex_bridge_${process.pid}_${Date.now()}.txt`);
  const codexArgs = [...inv.args, "exec", "--skip-git-repo-check", "-o", outFile, ...extraArgs];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.file, codexArgs, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, shell: !!inv.shell });
    } catch (e) {
      return resolve({ answer: "", error: e, status: null, stderr: "", detected: null });
    }
    let stderr = "";
    let detected = null;
    let timedOut = false;
    let done = false;
    const detect = () => {
      try {
        const f = newestRolloutSinceForWs(sinceMs, ws); // cwd 일치만(동시 다른 폴더 세션 오링크 방지)
        const mm = f && f.match(UUID_RE);
        if (mm) { detected = mm[1]; try { onDetect && onDetect(mm[1]); } catch { /* 다음 폴서 재시도 */ } } // onDetect 자체 멱등(연결 성공시만 멈춤) → recordLink 재시도 허용
      } catch { /* ignore */ }
    };
    if (child.stderr) child.stderr.on("data", (d) => { if (stderr.length < 4 * 1024 * 1024) stderr += d.toString(); });
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* ignore */ }
    const poll = setInterval(detect, 700);                                  // 답 도중 rollout 생기면 즉시 링크
    const killer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ignore */ } }, verifyTimeoutMin() * 60 * 1000);
    const finish = (status, err) => {
      if (done) return; done = true;
      clearInterval(poll); clearTimeout(killer);
      detect();                                                              // 마지막 한 번 더(폴링이 놓쳤을 수도)
      let answer = "";
      try { answer = fs.readFileSync(outFile, "utf8").trim(); } catch { /* ignore */ }
      try { fs.unlinkSync(outFile); } catch { /* ignore */ }
      let diag = "";
      const badExit = typeof status === "number" && status !== 0;
      if (err || !answer || badExit || timedOut) {
        diag = tB(`\n[브릿지 진단] codex 실행방식=`, `\n[bridge diagnostics] codex invocation=`) + `${inv.how} · file=${path.basename(inv.file)}` +
          `\n  spawn=${err ? err.code || err.message : "ok"} · exit=${status} · timeout=${timedOut}` +
          tB(`\n  (자세한 점검: node "${__filename}" doctor)`, `\n  (details: node "${__filename}" doctor)`);
      }
      resolve({ answer, error: err || (timedOut ? new Error("timeout") : null), status, stderr: stderr + diag, detected });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code, null));
  });
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

async function cmdAsk(rest) {
  const forceNew = rest.includes("--force-new"); // 엉뚱 폴더 방어를 무릅쓰고 '이 폴더'에 새 세션 강제
  const allowNew = rest.includes("--allow-new") || forceNew;
  const net = rest.includes("--net"); // 이 1회만 네트워크 허용(파일 읽기전용 유지) — netArgs 주석 참조
  const forceResend = rest.includes("--force-resend"); // 중복 전송 차단(아래 가드)을 의식적으로 우회
  const prompt = rest.filter((x) => x !== "--allow-new" && x !== "--force-new" && x !== "--net" && x !== "--force-resend").join(" ").trim();
  if (!prompt) die('사용법: ask "<프롬프트>"', 2);

  try { maybeCleanupState(); } catch { /* 오래된 상태파일 정리 best-effort(Stop 훅 미설치 환경 대비) — 하루 1회 */ }
  const links = loadLinks();
  const link = resolveLink(links);
  // configWs/execCwd 분리: 설정 기준(계약·생각강도·링크·proof·이벤트 라벨)은 '연 폴더'(ws), 코덱스 실행·새세션 탐지·인용
  // 근거 경로 해석은 '작업 폴더'(exec=실제 실행 cwd). 사용자가 연 폴더에 건 설정이 외부 폴더 작업에도 일관 적용되게 한다.
  const ws = configWs();        // 연 폴더(설정 기준)
  // 같은 요청 중복 전송 차단(2026-07-10 실사고: 첫 호출이 3분29초 만에 원인미상 비정상 종료되자 원인 확인 없이 '전송 실패' 오판 재전송 →
  // 동일 요청 중복 실행 — 실측: rollout 같은 해시 2건). 같은 내용이 살아있는 프로세스에서 진행 중이면 거부 — 답은 rollout/대시보드에서 확인하라.
  const promptHash = crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 16);
  let inflightRec = null;
  if (forceResend) {
    inflightRec = overwriteAskInflight(ws, promptHash); // 의식적 강행 — 자기 소유 토큰으로 재선점
  } else {
    const cl = claimAskInflight(ws, promptHash); // 원자적 wx 선점(검사-후-기록 분리의 동시 통과 구멍 차단 — Codex 반례)
    if (cl.claimed) inflightRec = cl.rec;
    else {
      const blockMsg = () => die(loadLang() === "en"
        ? `⚠️ The same verification request is already in flight. Do NOT resend — wait for it to finish and read the answer in the dashboard verification chat (or the Codex rollout). If your capture window died, the answer still arrives there. Conscious override: --force-resend`
        : `⚠️ 같은 검증 요청이 이미 진행 중입니다. 재전송하지 마세요 — 완료를 기다렸다가 대시보드 검증 대화(또는 Codex rollout)에서 답을 읽으면 됩니다. 호출 창이 죽었어도 답은 거기 도착합니다. 의식적 강행: --force-resend`, 3);
      if (!cl.rec) blockMsg(); // 표식은 있는데 판독 불가(재시도 후에도) — 보수적 '진행 중' 처리(죽은 표식처럼 덮어쓰면 동시 재시도 중복 — Codex 반례)
      const g = askInflightGuard(cl.rec, promptHash, Date.now(), (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (g.block) blockMsg();
      // 죽은/만료 표식 회수 — 삭제 후 wx 재선점(동시 재시도 중 하나만 승자 — 단순 덮어쓰기는 둘 다 통과, Codex 반례).
      const rc = reclaimAskInflight(ws, promptHash, cl.rec); // 관측했던 죽은 레코드를 넘겨 잠금 아래 재검증(TOCTOU 차단)
      if (rc.claimed) inflightRec = rc.rec;
      else {
        const g2 = askInflightGuard(rc.rec, promptHash, Date.now(), (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
        if (g2.block || !rc.rec) blockMsg(); // 경쟁 승자가 진행 중(또는 판독 불가) — 차단
        inflightRec = overwriteAskInflight(ws, promptHash); // 극단(승자도 즉사) — 강행보다 좁은 창, 진행
      }
    }
  }
  process.on("exit", () => clearAskInflight(ws, promptHash, inflightRec && inflightRec.token)); // 자기 표식만 해제(SIGKILL 잔존은 pid 생존 검사가 무시)
  const modeSnap = (loadContract(ws) || {}).verifyMode || ""; // 검증 트리거 모드 스냅샷(검증 중 사용자가 바꿔도 오염 안 되게) → flagVerdict로 전달
  const langSnap = loadLang(); // 언어 스냅샷 — ask 실행 중(수 분) 언어를 바꿔도 주입 언어와 헤더/footer 언어가 엇갈리지 않게(modeSnap과 동일 원칙)
  const exec = process.cwd();   // 작업 폴더(실행/탐지/근거경로 기준) — 코덱스 spawn은 cwd 미지정이라 실제로 여기서 돈다
  const mArgs = modelArgs(modelPrefFor(links, ws)); // 선택한 모델/생각강도를 매 호출 -c로 재적용(연 폴더 pref → 작업이 어디든 일관)

  if (link) {
    const file = findRolloutById(link.codexSession);
    if (!file) {
      // 연결은 있으나 세션이 사라짐 → 보고만, 새로 안 만듦.
      die(
        tB(`⚠️ 연결된 Codex 세션(${link.codexSession})을 찾을 수 없습니다(삭제됨?).\n→ 새로 시작하려면: ask --allow-new "..."  /  다른 세션에 붙이려면: link <id>`,
           `⚠️ Linked Codex session (${link.codexSession}) not found (deleted?).\n→ To start fresh: ask --allow-new "..."  /  to attach another: link <id>`),
      );
    }
    try { writePhase("codex-verifying", { round: (readPhase().round || 0) + 1, session: claudeId(), workspace: ws }); } catch { /* 진행표시 best-effort */ }
    const askId = require("crypto").randomUUID(); // L1-A: '서로 다른 ask 실행' 판정 재료(지문·verdict ts는 재실행 구분에 부적합 — Codex)
    const attCarrier = {};                        // L1-A: 이번 ask에 실제로 실린 동봉 스냅샷(재계산 아님)
    const { answer, error, status, stderr } = runCodex(["resume", link.codexSession, ...mArgs, ...(net ? netArgs() : [])], withContract(prompt + (net ? netNote(langSnap) : ""), ws, langSnap, attCarrier));
    if (error || !answer || (typeof status === "number" && status !== 0)) {
      try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // ask 실패 → 진행표시 codex-verifying 잔존 방지(Claude로 복귀)
      die(tB(`Codex resume 실패: `,`Codex resume failed: `) + `${error?.message || ""}\n${stderr.slice(-500)}`);
    }
    try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // 검증 답 수신 → Claude 반영중
    writeProof(link.codexSession, answer, ws); // 실제 성공 → 검증 증명 기록(verify-guard가 인정)
    flagEvidence(answer, ws, link.codexSession, exec); // 결정2: 인용 근거 존재성+다룬 흔적 점검(경로해석=작업폴더 exec). 라벨=연 폴더 ws
    flagLedgerConfirms(answer, ws, link.codexSession, exec, { askId, attach: attCarrier }); // 로드맵 ④ L1-A: 등급·echo·askId·seen을 이벤트에
    collectScoutTargetEvidence(answer, ws, exec); // 정찰 대상 자기진단 증거(2026-07-10 — 판정 무관·3트랙만·실패 무해)
    flagVerdict(answer, ws, link.codexSession, modeSnap); // 비-깨끗한 결론이면 실패=빨강·보류·불가=노랑, 답에 판정 줄이 없으면 표지 누락 노랑 가시화(자동 차단 X)
    process.stdout.write(`${langSnap === "en" ? "# Linked session" : "# 연결 세션"} ${link.codexSession} (${link.via})\n\n${formatForClaude(answer, langSnap)}\n`);
    return;
  }

  // 연결 전무 = 진짜 첫 소통.
  if (!allowNew) {
    // (나) 정책: 보고만 하고 멈춤. 멋대로 새 세션 안 만듦.
    die(
      tB(`🔌 이 Claude 세션/워크스페이스에 연결된 Codex 세션이 없습니다.\n   - 기존 세션에 연결:   node codex-bridge.js link <codex-session-id>   (목록: find)\n   - 가장 최근에 연결:   node codex-bridge.js link --last\n   - 새로 시작(첫 소통): node codex-bridge.js ask --allow-new "..."\n※ 새 세션을 임의로 만들지 않았습니다.`,
         `🔌 No Codex session is linked to this Claude session/workspace.\n   - Link an existing session:  node codex-bridge.js link <codex-session-id>   (list: find)\n   - Link the most recent:      node codex-bridge.js link --last\n   - Start fresh (first contact): node codex-bridge.js ask --allow-new "..."\n※ No new session was created on its own.`),
      3,
    );
  }

  // 엉뚱 폴더 방어(레거시): 원래는 '엉뚱한 cwd에서 새 세션 만들어 목록 오염'을 막던 차단이었다.
  // 이제 ws=configWs(연 폴더)·recordLink도 configWs라 새 세션은 항상 '이 대화의 연 폴더'에 묶인다 → 고아 세션이 원천적으로 안 생긴다.
  // 그래서 here(=configWs)는 activeIsThisConv일 때 active.workspace와 같아 이 차단은 사실상 no-op(configWs 앵커가 목적을 흡수).
  // (남겨둔 이유: CLAUDE_PROJECT_DIR 명시 override 등 폴백 경로의 안전망. --force-new로 우회.)
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
      tB(
        `⚠️ 새 Codex 세션을 만들 '이 폴더'가 지금 이 Claude 대화가 도는 폴더와 다릅니다.\n   - 이 폴더(실행 위치): ${here}\n   - 이 대화의 폴더:     ${active.workspace}\n   엉뚱한 폴더에서 돌렸을 가능성이 큽니다. 새 세션을 만들지 않았습니다.\n   → 그 대화 폴더에서 실행하거나, CLAUDE_PROJECT_DIR을 그 폴더로 설정하세요.\n   → 정말 '${here}'에 새 세션을 만들려면: ask --force-new "..."`,
        `⚠️ The folder for the new Codex session differs from this Claude conversation's folder.\n   - this folder (exec cwd): ${here}\n   - conversation folder:    ${active.workspace}\n   This looks like a wrong-folder run. No new session was created.\n   → Run from that conversation folder, or set CLAUDE_PROJECT_DIR to it.\n   → To really create one in '${here}': ask --force-new "..."`,
      ),
      3,
    );
  }

  // 폭증 방지: 직전 --allow-new가 세션을 만들고도 연결 기록에 실패했으면, 또 만들지 않는다(수동 link 유도).
  // 게이트는 시작 시점 스냅샷이 아니라 '지금' 상태로 본다 — 그새 다른 창이 수동 연결로 플래그를 해제했을 수 있음.
  const wsKey = normWs(ws);
  const freshAutoFail = (loadLinks() || {}).autoNewFailed;
  if (freshAutoFail && freshAutoFail[wsKey]) {
    die(
      tB(`⚠️ 직전에 새 Codex 세션을 만들었지만 연결 기록에 실패했습니다(세션id 식별 실패).\n   무한 생성 방지를 위해 자동 생성을 멈춥니다.\n   - 만든 세션 연결: node codex-bridge.js find  →  node codex-bridge.js link <id>\n   - 폴더 탐지 점검: node codex-bridge.js doctor`,
         `⚠️ A new Codex session was just created but linking failed (session id unresolved).\n   Auto-creation is paused to prevent runaway session creation.\n   - Link the created session: node codex-bridge.js find  →  node codex-bridge.js link <id>\n   - Check folder detection:  node codex-bridge.js doctor`),
      3,
    );
  }

  // --allow-new: 새 세션 생성 + '생성 즉시' 연결(답을 기다리는 동안 rollout 뜨면 바로 link → 8분 답 끝까지 안 기다림).
  const since = Date.now() - 2000;
  try { writePhase("codex-verifying", { round: (readPhase().round || 0) + 1, session: claudeId(), workspace: ws }); } catch { /* 진행표시 best-effort */ }
  let earlyLinked = null;
  // recordLink가 '성공(true)'일 때만 earlyLinked 확정 → 저장 실패(CAS/잠금/권한)면 미연결로 두고 다음 폴/최종 단계서 재시도.
  // detected(세션 발견)와 linked(저장 성공)를 분리해 "즉시연결" 거짓보고를 막는다(Codex 지적).
  const onDetect = (id) => { if (earlyLinked) return; try { if (recordLink(id)) earlyLinked = id; } catch { /* 다음 폴/최종 단계서 재시도 */ } };
  const askId = require("crypto").randomUUID(); // L1-A: '서로 다른 ask 실행' 판정 재료
  const attCarrier = {};                        // L1-A: 이번 ask에 실제로 실린 동봉 스냅샷
  const { answer, error, status, stderr } = await runCodexNewSessionAsync([...mArgs, ...(net ? netArgs() : [])], withContract(prompt + (net ? netNote(langSnap) : ""), ws, langSnap, attCarrier), since, exec, onDetect); // 탐지=작업폴더(코덱스 session_meta.cwd와 일치)
  // cwd 일치 우선, 못 찾으면 원래 방식(무회귀) — 최종 식별용 폴백.
  const resolveNew = () => { const f = newestRolloutSinceForWs(since, exec) || newestRolloutSince(since); const mm = f && f.match(UUID_RE); return mm ? mm[1] : ""; }; // 탐지=작업폴더
  if (error || !answer || (typeof status === "number" && status !== 0)) {
    // 실패: 이미 '생성 즉시 연결'됐으면 고아 아님 → autoNewFailed 안 검(다음 시도는 그 세션 resume). 미연결일 때만 폭증방지/식별 시도.
    if (!earlyLinked) {
      const nid = resolveNew();
      if (nid && recordLink(nid)) earlyLinked = nid; // 실패해도 세션이 생겼으면 연결(고아 방지)
      else if (nid) updateLinks((o) => { o.autoNewFailed = o.autoNewFailed || {}; o.autoNewFailed[wsKey] = true; });
    }
    try { writePhase("claude-working", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // ask 실패 → 진행표시 정리(Claude로 복귀)
    die(tB(`Codex 새 세션 ${earlyLinked ? `(연결됨 ${earlyLinked}) ` : ""}실패: `, `Codex new session ${earlyLinked ? `(linked ${earlyLinked}) ` : ""}failed: `) + `${error?.message || ""}\n${stderr.slice(-500)}\n` + (earlyLinked ? tB("(세션은 연결됐으니 다시 검증하면 그 세션을 이어갑니다.)", "(the session is linked — re-verifying continues it.)") : tB("(세션 파일이 생겼다면 'find'→'link <id>'로 연결하세요.)", "(if a session file appeared, link it via 'find' → 'link <id>'.)")));
  }
  try { writePhase("rejudging", { session: claudeId(), workspace: ws }); } catch { /* best-effort */ } // 검증 답 수신 → Claude 반영중
  let id = earlyLinked;
  if (!id) { const nid = resolveNew(); if (nid && recordLink(nid)) id = nid; } // 즉시연결 못했으면 지금 찾아 연결
  if (id) {
    writeProof(id, answer, ws); // 실제 성공 → 검증 증명 기록
    flagEvidence(answer, ws, id, exec); // 결정2: 인용 근거 존재성+다룬 흔적(경로해석=작업폴더 exec, 라벨=연 폴더 ws)
    flagLedgerConfirms(answer, ws, id, exec, { askId, attach: attCarrier }); // 로드맵 ④ L1-A: 등급·echo·askId·seen
    collectScoutTargetEvidence(answer, ws, exec); // 정찰 대상 자기진단 증거(2026-07-10)
    flagVerdict(answer, ws, id, modeSnap); // 비-깨끗한 결론이면 실패=빨강·보류·불가=노랑, 표지 누락도 노랑 가시화(자동 차단 X)
    const en = langSnap === "en";
    const head = earlyLinked
      ? (en ? `# New Codex session created·linked immediately: ${id}` : `# 새 Codex 세션 생성·즉시연결: ${id}`)
      : (en ? `# New Codex session created·linked: ${id}` : `# 새 Codex 세션 생성·연결: ${id}`);
    process.stdout.write(`${head}\n\n${formatForClaude(answer, langSnap)}\n`);
  } else {
    updateLinks((o) => { o.autoNewFailed = o.autoNewFailed || {}; o.autoNewFailed[wsKey] = true; }); // 다음 자동 생성 차단 플래그
    writeProof("", answer, ws); // Codex는 성공 응답함(세션id만 미식별) → 검증은 인정
    flagEvidence(answer, ws, "", exec); // 세션id 미식별 → 존재성 점검만(경로해석=작업폴더 exec, 라벨=연 폴더 ws)
    flagLedgerConfirms(answer, ws, "", exec, { askId, attach: attCarrier }); // 로드맵 ④ L1-A: 세션 미식별 → seen=unknown으로 기록만(승격 재료 아님)
    collectScoutTargetEvidence(answer, ws, exec); // 정찰 대상 자기진단 증거(2026-07-10)
    flagVerdict(answer, ws, "", modeSnap);
    process.stdout.write(`${langSnap === "en" ? "# New session created (session id unresolved) — auto-creation is paused to avoid session sprawl. Use 'find' then 'link <id>'." : "# 새 세션 생성됨(세션id 식별 실패) — 폭증 방지로 다음 자동 생성은 멈춥니다. 'find'로 찾아 'link <id>' 하세요."}\n\n${formatForClaude(answer, langSnap)}\n`);
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
      `: Claude(${claudeId() || "?"}) + ${configWs()}  →  Codex ${id}\n` +
      (file ? `   세션 파일: ${path.basename(file)}\n` : `   ⚠️ 해당 세션 rollout 파일이 안 보임(추후 resume 시 실패할 수 있음)\n`),
  );
}

// 모델/생각강도 선택 보기·설정·해제(프로젝트별). 대시보드가 links.json을 직접 쓰지만, CLI로도 점검/테스트 가능.
function cmdPref(rest) {
  const ws = configWs(); // 설정 저장 기준 = 연 폴더(ask가 configWs로 읽으므로 CLI 저장도 같은 키여야 일치). 대시보드(연 폴더 저장)와도 정합.
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
  { const cfg = configWs(), ex = process.cwd();
    process.stdout.write(`Claude 세션: ${claudeId() || "(env 없음)"}\n워크스페이스(설정 기준): ${cfg}\n` +
      (normWs(cfg) !== normWs(ex) ? `실행 폴더(작업 cwd): ${ex}\n` : "")); }
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
    c = loadContract(configWs());
  } catch {
    /* ignore */
  }
  process.stdout.write(`검증 모드      : ${c ? c.verifyMode : "(계약 로드 실패)"}\n`);
  process.stdout.write(`Claude 세션    : ${claudeId() || "(env 없음)"}\n`);
  process.stdout.write(`워크스페이스   : ${configWs()} (설정 기준=연 폴더)\n`);
  process.stdout.write(`실행 폴더(cwd) : ${process.cwd()}\n`);
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
    case "ask": {
      const p = cmdAsk(rest); // 새 세션 경로는 async(즉시연결). resume는 동기 흐름이라 즉시 resolve.
      if (p && typeof p.then === "function") p.catch((e) => die(tB("ask 오류: ", "ask error: ") + (e && e.message ? e.message : String(e))));
      return p;
    }
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
          '  node codex-bridge.js ask --net "<프롬프트>"        (이 1회만 네트워크 허용 — 파일은 읽기전용 유지, 원격 확인용)\n' +
          '  node codex-bridge.js ask --force-resend "<프롬프트>" (같은 요청 진행 중 차단을 의식적으로 우회)\n' +
          "  node codex-bridge.js link <id> | link --last\n" +
          "  node codex-bridge.js status | find | doctor | detect-home\n" +
          "  node codex-bridge.js pref [set model=<m> reasoning=<low|medium|high> | clear]\n",
      );
  }
}

if (require.main === module) main(); // CLI로 직접 실행할 때만. require 시엔 테스트용 export만.
module.exports = { withContract, checkCitedEvidence, resolveCitedPath, flagEvidence, flagVerdict, flagLedgerConfirms, updateLinks, loadLinks, saveLinks, LINKS_FILE, verifyTimeoutMin, citedResolvedBasenames, citedFilesUnseen, newestRolloutSinceForWs, parseLastTurn, netArgs, netNote };
