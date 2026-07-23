/*
 * P8 증분 1 — 결정론 라우터(bridge/map-router.js) 전 행렬 테스트.
 * 정본: MAP-V2-DESIGN 'P8 상세 설계 v10' P8-1 — 우선순위 전순서 9행과 1:1(재해석 금지).
 * 전수 행렬: mode 4(+이형)×ready 조합×corridor 3(+이형)×economyFailed×precisionFailed×conflict.
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "bridge", "map-router.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}
const READY_ALL = { selfReady: true, economyReady: true, precisionReady: true, autoReady: true };
const READY_NONE = { selfReady: false, economyReady: false, precisionReady: false, autoReady: false };
const d = (over) => R.decideRoute({ mode: "auto", ready: READY_ALL, corridor: "mapped", economyFailed: false, precisionFailed: false, conflict: false, ...over });

console.log("[1] 1행 — 이형 입력=park(invalid-input)·던지지 않는다");
ok(d({ mode: "nonsense" }).reason === "invalid-input", "미지 mode=park(invalid-input)");
ok(d({ mode: undefined }).reason === "invalid-input", "mode 부재=park(정규화는 호출자 소관 — 라우터는 실효값만)");
ok(d({ corridor: "weird" }).reason === "invalid-input", "미지 corridor=park");
ok(d({ economyFailed: "yes" }).reason === "invalid-input", "비불리언 플래그=park");
ok(d({ conflict: 1 }).reason === "invalid-input", "비불리언 conflict=park");
// 구현검증 1차 blocker: 이형 readiness가 conflict·self 분기를 우회하던 반례 — 1행 최우선 oracle 잠금
ok(d({ mode: "self", ready: null }).reason === "invalid-input", "ready=null은 self 단락보다 먼저 park(1행 최우선)");
ok(d({ ready: null, conflict: true }).reason === "invalid-input", "ready=null은 conflict보다도 먼저 park(이형=2행 진입 금지)");
ok(d({ ready: { ...READY_ALL, autoReady: "true" } }).reason === "invalid-input", "readiness 필드 비불리언=park(auto-not-ready로 위장 금지)");
ok(d({ ready: [] }).reason === "invalid-input", "ready 배열=park");
ok(d({ ready: { autoReady: true } }).reason === "invalid-input", "readiness 필드 누락(부분 객체)=park(strict — P7 뷰는 4필드 전부 산출)");
let threw = false;
try { R.decideRoute(null); R.decideRoute(undefined); R.decideRoute({ ready: null }); } catch { threw = true; }
ok(!threw && R.decideRoute(null).route === "park", "null·undefined 입력에도 절대 던지지 않는다(park)");

console.log("[2] 2행 — conflict=adjudicate(모드 무관 최상향 — 3차 f-4a71aa53)");
ok(d({ conflict: true }).route === "adjudicate" && d({ conflict: true }).reason === "provider-conflict", "auto+conflict=adjudicate");
ok(d({ mode: "self", conflict: true }).route === "adjudicate", "self 모드도 conflict=adjudicate(1-26 단락은 provider 선택에 대한 것 — 충돌 해소 면제 아님)");
ok(d({ mode: "economy", conflict: true }).route === "adjudicate", "명시 economy도 conflict=adjudicate(1-34에 모드 제한 없음)");
ok(d({ mode: "precision", conflict: true }).route === "adjudicate", "명시 precision도 conflict=adjudicate");
ok(d({ conflict: true, ready: READY_NONE }).route === "adjudicate", "conflict가 not-ready를 이긴다(충돌=사후 사건·해소 주체=Verifier — readiness 무관)");
ok(d({ conflict: true, economyFailed: true, precisionFailed: true }).route === "adjudicate", "conflict가 both-failed보다 우선");

console.log("[3] 3행 — self 단락(1-26·이하 플래그 무시)");
ok(d({ mode: "self" }).route === "self" && d({ mode: "self" }).reason === "mode-self", "self=self");
ok(d({ mode: "self", ready: READY_NONE }).route === "self", "self는 readiness 무관(무과금 기본 — 강등·게이트 없음)");
ok(d({ mode: "self", economyFailed: true, precisionFailed: true }).route === "self", "self는 실패 플래그 무시(승격 표 밖)");

console.log("[4] 4행 — 명시 모드(실패=park·15차 모드 경계: 승격도 전환)");
ok(d({ mode: "economy" }).route === "economy" && d({ mode: "economy" }).reason === "mode-economy", "명시 economy+준비=economy");
ok(d({ mode: "economy", economyFailed: true }).reason === "economy-failed", "명시 economy 실패=park(승격 아님)");
ok(d({ mode: "economy", ready: { ...READY_ALL, economyReady: false } }).reason === "economy-not-ready", "명시 economy 미준비=park");
ok(d({ mode: "economy", precisionFailed: true }).route === "economy", "명시 economy는 정밀 실패 플래그와 무관");
ok(d({ mode: "precision" }).route === "precision", "명시 precision+준비=precision");
ok(d({ mode: "precision", precisionFailed: true }).reason === "precision-failed", "명시 precision 실패=park");
ok(d({ mode: "precision", ready: { ...READY_ALL, precisionReady: false } }).reason === "precision-not-ready", "명시 precision 미준비=park");

console.log("[5] 5~8행 — auto 준비·실패·승격");
ok(d({ ready: { ...READY_ALL, autoReady: false } }).reason === "auto-not-ready", "auto 미성립=park(사유 표시)");
ok(d({ economyFailed: true, precisionFailed: true }).reason === "both-failed", "양쪽 실패=park(무한 승격 없음)");
ok(d({ economyFailed: true }).route === "precision" && d({ economyFailed: true }).reason === "escalated-from-economy", "경제 실패=정밀 승격(자동형만·정확 1회)");
ok(d({ economyFailed: true, corridor: "delta" }).route === "precision", "승격은 corridor보다 우선(7행>9행)");
ok(d({ precisionFailed: true, corridor: "delta" }).reason === "precision-failed", "정밀 선실패(delta 경로)=park");

console.log("[6] 9행 — corridor 라우팅");
ok(d({}).route === "economy" && d({}).reason === "corridor-mapped", "mapped=경제형");
ok(d({ corridor: "delta" }).route === "precision" && d({ corridor: "delta" }).reason === "corridor-delta", "delta=정밀형");
ok(d({ corridor: "unknown" }).route === "park" && d({ corridor: "unknown" }).reason === "corridor-unknown", "unknown=park(임의 기본값 금지)");

console.log("[7] 전수 스윕 — 어떤 조합도 던지지 않고 유효 route·reason을 반환");
{
  const modes = ["self", "economy", "precision", "auto", "junk", undefined];
  const readies = [READY_ALL, READY_NONE, { autoReady: true }, null];
  const corridors = ["mapped", "delta", "unknown", "junk"];
  const bools = [true, false, "junk"];
  let n = 0, bad = 0;
  for (const mode of modes) for (const ready of readies) for (const corridor of corridors)
    for (const eF of bools) for (const pF of bools) for (const cf of bools) {
      n++;
      let r;
      try { r = R.decideRoute({ mode, ready, corridor, economyFailed: eF, precisionFailed: pF, conflict: cf }); }
      catch { bad++; continue; }
      if (!r || !R.MAP_ROUTES.includes(r.route) || typeof r.reason !== "string" || !r.reason) bad++;
    }
  ok(bad === 0, "전수 " + n + "조합 — 예외 0·유효 반환(라우터 불투과 불변식)");
}

console.log("[8] corridorOf(1-6 — node 소속·정직 unknown)");
{
  const proj = (nodes) => ({ ok: true, source: "v2", nodes });
  const N = (id, anchors) => ({ id, anchors });
  // 구현검증 1차 보완: fixture anchor kind를 실스키마(ANCHOR_KINDS=code|test|config|doc)로 — 디렉터리형 없음
  const P1 = proj([N("n1", [{ kind: "code", path: "src/a.js" }]), N("n2", [{ kind: "code", path: "lib/index.js" }])]);
  ok(R.corridorOf(P1, []) === "mapped", "변경 공집합=mapped(초회 보강 — 전칭 조건의 자명 사례)");
  ok(R.corridorOf(P1, ["src/b.js"]) === "mapped", "node 파일 anchor의 부모 디렉터리 소속=mapped");
  ok(R.corridorOf(P1, ["lib/other.js"]) === "mapped", "code anchor(lib/index.js)의 디렉터리 경계 소속=mapped");
  ok(R.corridorOf(P1, ["lib/deep/x.js"]) === "mapped", "경계 디렉터리의 하위 경로도 소속=mapped");
  ok(R.corridorOf(P1, ["src/a.js", "docs/new.md"]) === "delta", "하나라도 경계 밖=delta");
  ok(R.corridorOf(P1, ["libx/evil.js"]) === "delta", "접두 유사 디렉터리(lib vs libx)는 소속 아님=delta(경계 정확 대조)");
  ok(R.corridorOf(P1, null) === "unknown", "변경 산출 실패(null)=unknown(임의 추정 금지)");
  ok(R.corridorOf({ ok: false, source: "blocked" }, []) === "unknown", "proj blocked=unknown");
  ok(R.corridorOf({ ok: true, source: "legacy", nodes: [] }, []) === "unknown", "legacy=unknown(위임 — v2만 판정)");
  ok(R.corridorOf(proj([]), ["a.js"]) === "delta", "node 경계 0개면 변경은 전부 delta");
  ok(R.corridorOf(proj([N("r", [{ kind: "code", path: "root.js" }])]), ["other.js"]) === "mapped", "루트 파일 anchor → 루트 경계(하위 디렉터리 아닌 파일만 소속)");
  ok(R.corridorOf(proj([N("r", [{ kind: "code", path: "root.js" }])]), ["sub/x.js"]) === "delta", "루트 경계에 하위 디렉터리 파일은 비소속=delta");
  ok(R.corridorOf(P1, ["src\\win.js"]) === "mapped", "윈도우 구분자 정규화 후 판정");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
