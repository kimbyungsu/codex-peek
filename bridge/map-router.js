/*
 * P8 — 결정론 라우터(정본 MAP-V2-DESIGN 'P8 상세 설계 v10' P8-1 · 1-34 규범 판정표의 기계 인코딩).
 * 재해석 금지: decideRoute의 분기는 설계 v10의 우선순위 전순서 9행과 1:1이다 — 행 추가·순서 변경은
 * 설계 개정으로만. 상태 없는 순수 함수(파일·환경 접근 0)·절대 던지지 않는다(이형 입력=park).
 * corridorOf(1-6): mapped corridor 판정은 'node 소속'(node가 대표하는 디렉터리 경계 포함) 기준만 —
 * anchor 일치 기준은 의미 보강으로 밀도가 오른 뒤에만 활성(비활성 유지). 변경 공집합=mapped(전칭
 * 조건의 자명 사례 — 초회 보강. 설계검증 1차 성립 확인).
 */

const MAP_ROUTES = ["self", "economy", "precision", "park", "adjudicate"];
const CORRIDORS = ["mapped", "delta", "unknown"];

// 우선순위 전순서(설계 v10 P8-1 — 위가 이김). 입력: mode(정규화된 mapMode 실효값 self|economy|precision|auto),
// ready={selfReady,economyReady,precisionReady,autoReady}, corridor(mapped|delta|unknown),
// economyFailed/precisionFailed/conflict(불리언 — 관측 후 세워 재호출).
function decideRoute(inp) {
  const i = inp || {};
  const mode = i.mode;
  const ready = i.ready;
  const corridor = i.corridor;
  const eF = i.economyFailed, pF = i.precisionFailed, cf = i.conflict;
  // 1행: 이형 입력=park — conflict·self 분기보다 '항상' 먼저(구현검증 1차 blocker: ready=null이 {}로
  // 완충되면 이형 입력이 2·3행으로 흘러 1행 최우선 계약이 깨진다). ready는 P7 뷰 산출물이라 4필드 전부
  // 불리언이 정상 — strict 검사(비객체·비불리언 필드=invalid-input). 라우터는 절대 던지지 않는다.
  if (!["self", "economy", "precision", "auto"].includes(mode)) return { route: "park", reason: "invalid-input" };
  if (!CORRIDORS.includes(corridor)) return { route: "park", reason: "invalid-input" };
  if (!ready || typeof ready !== "object" || Array.isArray(ready)) return { route: "park", reason: "invalid-input" };
  for (const k of ["selfReady", "economyReady", "precisionReady", "autoReady"]) if (typeof ready[k] !== "boolean") return { route: "park", reason: "invalid-input" };
  for (const b of [eF, pF, cf]) if (typeof b !== "boolean") return { route: "park", reason: "invalid-input" };
  // 2행: conflict → adjudicate — 모드 무관(설계검증 3차 f-4a71aa53: 1-34의 '두 provider 충돌→Verifier'에는
  // 모드 제한이 없다[모드 제한은 '승격'에만 — 15차]. 충돌은 두 결과가 이미 존재하는 사후 사건·해소 주체=
  // Verifier라 self 단락·명시 모드·readiness 전부보다 우선).
  if (cf) return { route: "adjudicate", reason: "provider-conflict" };
  // 3행: self 단락(1-26 — 부재·비물질화 기본 포함. 이하 플래그 무시: self는 승격 표 밖)
  if (mode === "self") return { route: "self", reason: "mode-self" };
  // 4행: 명시 모드 — 실패=park(15차 모드 경계: 승격도 전환)·미준비=park
  if (mode === "economy") {
    if (eF) return { route: "park", reason: "economy-failed" };
    if (ready.economyReady !== true) return { route: "park", reason: "economy-not-ready" };
    return { route: "economy", reason: "mode-economy" };
  }
  if (mode === "precision") {
    if (pF) return { route: "park", reason: "precision-failed" };
    if (ready.precisionReady !== true) return { route: "park", reason: "precision-not-ready" };
    return { route: "precision", reason: "mode-precision" };
  }
  // 5행: auto 미준비
  if (ready.autoReady !== true) return { route: "park", reason: "auto-not-ready" };
  // 6행: 양쪽 실패=park(무한 승격 없음)
  if (eF && pF) return { route: "park", reason: "both-failed" };
  // 7행: 경제 실패 → 정밀 승격(자동형에서만·정확 1회 — 승격 후 실패는 6행)
  if (eF) return { route: "precision", reason: "escalated-from-economy" };
  // 8행: 정밀 선실패(corridor=delta 경로에서 정밀형이 먼저 실패) → park
  if (pF) return { route: "park", reason: "precision-failed" };
  // 9행: corridor 라우팅
  if (corridor === "mapped") return { route: "economy", reason: "corridor-mapped" };
  if (corridor === "delta") return { route: "precision", reason: "corridor-delta" };
  return { route: "park", reason: "corridor-unknown" };
}

// ── corridor 판정(1-6 — node 소속) ─────────────────────────────────────────────
// proj=readMapProjection 반환(v2 성공만 판정 가능 — blocked/error/legacy/none=unknown).
// changedFiles=basis 이후 변경 파일 상대경로 배열(산출 실패=null 전달 → unknown).
// node 경계: node.anchors의 path에서 디렉터리 경계를 유도(anchor path가 파일이면 그 부모 디렉터리·
// 디렉터리형이면 그 자체). 변경 파일 전부가 어떤 node 경계 안이면 mapped / 하나라도 밖=delta.
function normRel(p) { return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""); }
function nodeDirsOf(proj) {
  const dirs = new Set();
  for (const n of (proj && proj.nodes) || []) {
    for (const a of (n && n.anchors) || []) {
      if (!a || !a.path) continue;
      const rp = normRel(a.path);
      // anchor는 항상 파일 경로(ANCHOR_KINDS=code|test|config|doc — 전부 파일형·구현검증 1차 보완:
      // 디렉터리형 kind는 스키마에 없어 분기 자체가 도달 불가): 부모 디렉터리가 node의 경계(1-6).
      dirs.add(rp.includes("/") ? rp.slice(0, rp.lastIndexOf("/")) : "");
    }
  }
  return dirs;
}
function corridorOf(proj, changedFiles) {
  if (!proj || proj.ok !== true || proj.source !== "v2") return "unknown"; // blocked·error·legacy·none=판정 불가(정직)
  if (!Array.isArray(changedFiles)) return "unknown"; // 변경 산출 실패=unknown(임의 추정 금지)
  if (changedFiles.length === 0) return "mapped"; // 초회 보강 — 전칭 조건의 자명 사례(공집합)
  const dirs = nodeDirsOf(proj);
  if (dirs.size === 0) return "delta"; // node 경계가 하나도 없으면 어떤 변경도 소속 불가
  for (const f of changedFiles) {
    const rf = normRel(f);
    let inside = false;
    for (const d of dirs) {
      if (d === "" ? !rf.includes("/") : rf === d || rf.startsWith(d + "/")) { inside = true; break; }
    }
    if (!inside) return "delta"; // 하나라도 밖=delta
  }
  return "mapped";
}

module.exports = { decideRoute, corridorOf, nodeDirsOf, MAP_ROUTES, CORRIDORS };
