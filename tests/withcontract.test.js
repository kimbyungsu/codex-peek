"use strict";
/*
 * withContract(prompt, ws) 워크스페이스 명시 로드 테스트 (V9) — node tests/withcontract.test.js.
 * cmdAsk가 넘기는 ws에 따라 'Codex 계약'이 그 프로젝트 것으로 로드되는지(cwd 암묵 의존이 아니라) 확인.
 * CODEX_BRIDGE_HOME을 require 전에 임시폴더로 지정 → 브릿지/계약 파일을 임시폴더에서 읽게 한다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc_"));
process.env.CODEX_BRIDGE_HOME = dir; // require 전에 설정해야 BRIDGE_DIR이 임시폴더로 잡힘
delete process.env.CLAUDE_PROJECT_DIR; // 명시 ws만으로 검증(폴백은 별도 케이스에서)

const { contractFileFor } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const { withContract } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js")); // require.main 가드라 CLI 안 돎

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const wsA = path.join(dir, "projA");
const wsB = path.join(dir, "projB");
fs.mkdirSync(path.dirname(contractFileFor(wsA)), { recursive: true }); // contracts 디렉터리
fs.writeFileSync(contractFileFor(wsA), JSON.stringify({ codex: ["V9_MARKER_A"], verifyMode: "off" }));
fs.writeFileSync(contractFileFor(wsB), JSON.stringify({ codex: ["V9_MARKER_B"], verifyMode: "off" }));

console.log("[1] 명시 ws에 따라 그 프로젝트 Codex 계약 로드");
const outA = withContract("MY_PROMPT", wsA);
const outB = withContract("MY_PROMPT", wsB);
ok(outA.includes("V9_MARKER_A") && !outA.includes("V9_MARKER_B"), "wsA → wsA 계약(MARKER_A)만");
ok(outB.includes("V9_MARKER_B") && !outB.includes("V9_MARKER_A"), "wsB → wsB 계약(MARKER_B)만");
ok(outA.includes("MY_PROMPT"), "프롬프트가 본문에 포함");

console.log("[2] ws 생략 시 workspace()(CLAUDE_PROJECT_DIR)로 폴백");
process.env.CLAUDE_PROJECT_DIR = wsB;
const outDefault = withContract("MY_PROMPT");
ok(outDefault.includes("V9_MARKER_B"), "ws 생략 → workspace()=wsB 계약 로드");
delete process.env.CLAUDE_PROJECT_DIR;

console.log("[3] 계약 없는 ws는 안전(빈 주입, 크래시 없음)");
const wsNone = path.join(dir, "projNone");
const outNone = withContract("MY_PROMPT", wsNone);
ok(typeof outNone === "string" && outNone.includes("MY_PROMPT"), "계약 없어도 baseline+프롬프트 반환");
ok(!outNone.includes("V9_MARKER_A") && !outNone.includes("V9_MARKER_B"), "다른 프로젝트 계약이 새지 않음");

console.log("[4] 전역 contract.json이 있어도 미설정 ws엔 상속 안 됨(계약=프로젝트 전용)");
fs.writeFileSync(path.join(dir, "contract.json"), JSON.stringify({ codex: ["GLOBAL_LEAK_MARKER"], verifyMode: "always" }));
const wsFresh = path.join(dir, "projFresh");
const outFresh = withContract("MY_PROMPT", wsFresh);
ok(!outFresh.includes("GLOBAL_LEAK_MARKER"), "전역 계약 규칙이 미설정 프로젝트에 새지 않음(상속 제거)");

console.log("[5] 빈 칸 프로젝트는 규칙 0·규칙 있는 프로젝트는 자기 규칙 — 프로젝트별 독립(A빈칸/B규칙 분리)");
const wsEmpty = path.join(dir, "projEmpty");
fs.writeFileSync(contractFileFor(wsEmpty), JSON.stringify({ codex: [], verifyMode: "off" }));
const outEmpty = withContract("MY_PROMPT", wsEmpty);
ok(!outEmpty.includes("V9_MARKER_") && !outEmpty.includes("GLOBAL_LEAK_MARKER"), "빈 계약 프로젝트 → 사용자 codex 규칙 0(baseline만)");
ok(withContract("MY_PROMPT", wsB).includes("V9_MARKER_B"), "동시에 wsB(규칙 있음)는 자기 규칙 그대로 주입 — A빈칸·B규칙 독립 적용");

// ── 검증자 프롬프트 머리의 상한(2026-07-30) ─────────────────────────────────────────
// 이 머리는 매 회차 검증자에게 통째로 실려 간다. 총량 상한이 없어 계약 규칙·열린 지적·지도 이름이
// 늘면 계속 부풀고 정작 사용자 요청문이 뒤로 밀렸다. 조각별로 막되 조용히 자르지 않는다.
console.log("[상한] 계약 규칙이 지나치게 길면 프롬프트를 만들지 않고 멈춘다(빼고 진행 금지)");
{
  const wsCap = path.join(dir, "projCap");
  fs.mkdirSync(wsCap, { recursive: true });
  const huge = "규칙 " + "가".repeat(5000);
  fs.writeFileSync(contractFileFor(wsCap), JSON.stringify({ codex: [huge], verifyMode: "off" }));
  // 규칙을 빼고 진행하면 '그 규칙이 적용되지 않은 통과'가 된다 — 검증 통과 위조 경로다(검증 blocker).
  // 그래서 잘라 붙이지도, 빼고 진행하지도 않고 ask 자체를 멈춘다.
  let threw = null;
  try { withContract("MY_PROMPT", wsCap); } catch (e) { threw = e; }
  ok(threw !== null, "상한 초과 계약이면 프롬프트를 만들지 않고 멈춘다(빼고 진행 금지)");
  ok(threw && threw.exitCode === 3 && threw.contractTooLong === true, "호출자가 구분할 수 있는 정직 실패로 올린다");
  // 문구는 '왕복도 쓰지 않았다'까지 말해야 한다 — 예약 뒤에 막으면 계약을 줄여도 그 캠페인에서
  // 검증을 못 하는데, 안내만 '시작 안 함'이면 사실과 어긋난다(검증 blocker).
  ok(threw && /검증을 시작하지 않았고 왕복도 쓰지 않았습니다/.test(String(threw.message)), "검증도 왕복도 쓰지 않았음을 분명히 말한다");
  ok(threw && /적용되지 않은 통과/.test(String(threw.message)) && /대시보드에서 줄인 뒤/.test(String(threw.message)), "왜 위험한지와 고칠 자리를 알려준다");

  // 상한 이하면 기존대로 원문이 실린다(무회귀).
  const wsOk = path.join(dir, "projCapOk");
  fs.mkdirSync(wsOk, { recursive: true });
  fs.writeFileSync(contractFileFor(wsOk), JSON.stringify({ codex: ["CAP_OK_MARKER"], verifyMode: "off" }));
  const out2 = withContract("MY_PROMPT", wsOk);
  ok(out2.includes("CAP_OK_MARKER") && !out2.includes("[계약 규칙 미첨부]"), "상한 이하 계약 규칙은 종전대로 원문 주입");

  // 핵심: 검사가 '예약보다 앞'이어야 한다. withContract 안에서만 막으면 이미 왕복이 예약된 뒤라,
  // 마지막 허용 왕복에서 걸리면 계약을 줄여도 그 캠페인에서 검증을 못 한다(검증 blocker).
  // ⚠ 파일 전체에서 찾으면 '함수 선언'이 먼저 걸려, 실제 호출을 지워도 통과한다(검증 [보완]).
  // cmdAsk 본문만 잘라 '호출'을 세고 위치를 비교한다.
  const cbSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  const bodyStart = cbSrc.indexOf("async function cmdAsk(rest) {");
  const bodyEnd = cbSrc.indexOf("\nfunction main()", bodyStart);
  const body = bodyStart >= 0 && bodyEnd > bodyStart ? cbSrc.slice(bodyStart, bodyEnd) : "";
  ok(body.length > 0, "cmdAsk 본문을 잘라냈다(전제 확인)");
  const callCount = body.split("assertContractInjectionFits(").length - 1;
  const iAssert = body.indexOf("assertContractInjectionFits(");
  const iReserve = body.indexOf("reserveVerifyBudgetGate(");
  const iAttempt = body.indexOf("beginVerifyAttempt(");
  // 사전 검사는 두 분기(resume·신규)가 갈리기 '전'에 딱 한 번 있어야 한다 — 한 분기 안으로 옮기면
  // 다른 분기는 검사 없이 예약한다(검증 [보완]).
  ok(callCount === 1, "사전 검사 호출이 공통 지점에 정확히 1개다(분기 안으로 옮기면 실패)");
  ok(iReserve > 0 && iAttempt > 0, "예약·시도 기록 호출이 존재한다(전제 확인)");
  ok(iAssert >= 0 && iAssert < iReserve && iAssert < iAttempt, "사전 검사가 왕복 예약·시도 기록보다 먼저 실행된다");
  ok(iAssert < body.indexOf("if (link) {"), "사전 검사가 resume/신규 분기가 갈리기 전에 있다");
  ok(cbSrc.indexOf("검증을 시작하지 않았고 왕복도 쓰지 않았습니다") >= 0, "두 자리(사전 검사·이중 방어)가 같은 문구를 쓴다");
  // 사전 검사와 조립이 '같은 계약 스냅샷'을 봐야 한다 — 각자 읽으면 그 사이 저장으로 판정이 갈린다.
  // 두 조립 호출 '각각'이 스냅샷을 받아야 한다(하나만 받으면 다른 분기가 옛 결함으로 되돌아간다).
  const asmAll = body.split("withContract(").length - 1;
  // [기억 권위 C-1 2026-08-14] 조립 호출이 askId(실행 UUID)까지 전달 — 스냅샷+askId 짝을 함께 핀.
  const asmSnap = body.split("profileSnap, contractSnap, askId)").length - 1;
  // [VerifierProvider Phase1] claude 분기 추가로 조립 호출 3개 — 여전히 전부 같은 스냅샷이어야 한다.
  ok(asmAll === 3 && asmSnap === 3, "조립 호출 3개(resume·new·claude)가 '모두' 같은 스냅샷+askId를 넘겨받는다(실측 " + asmSnap + "/" + asmAll + ")");
  ok(cbSrc.indexOf("contractSnap && typeof contractSnap === \"object\" ? contractSnap : loadContract(") >= 0, "스냅샷이 오면 withContract가 계약을 다시 읽지 않는다");

  // 사전 검사가 실제로 상한을 넘는 계약에서 발동하는지(문자열이 아니라 동작으로).
  const CB2 = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
  if (typeof CB2.assertContractInjectionFits === "function") {
    let died = null;
    const realExit = process.exit, realErr = process.stderr.write;
    process.exit = (code) => { throw Object.assign(new Error("exit"), { _code: code }); };
    process.stderr.write = () => true;
    try { CB2.assertContractInjectionFits(wsCap, { codex: [huge] }, "claude-codex", "ko"); } catch (e) { died = e; }
    process.exit = realExit; process.stderr.write = realErr;
    ok(died && died._code === 3, "사전 검사가 상한 초과에서 종료코드 3으로 멈춘다");
    let ok2 = true;
    try { CB2.assertContractInjectionFits(wsOk, { codex: ["CAP_OK_MARKER"] }, "claude-codex", "ko"); } catch { ok2 = false; }
    ok(ok2, "상한 이하에서는 사전 검사가 통과시킨다");
  } else ok(false, "assertContractInjectionFits를 불러오지 못함(반례가 동작을 못 봄)");

  // 경합 반례: 사전 검사 뒤 대시보드가 계약을 늘려도, 조립은 넘겨받은 스냅샷을 써서 흔들리지 않는다.
  // (스냅샷을 안 넘기던 때는 여기서 예약 뒤 중단 → '왕복도 쓰지 않았다'가 거짓이 됐다.)
  const wsRace = path.join(dir, "projRace");
  fs.mkdirSync(wsRace, { recursive: true });
  fs.writeFileSync(contractFileFor(wsRace), JSON.stringify({ codex: ["RACE_SMALL"], verifyMode: "off" }));
  const snap = require(path.join(__dirname, "..", "bridge", "contract-lib.js")).loadContract(wsRace, "ko");
  fs.writeFileSync(contractFileFor(wsRace), JSON.stringify({ codex: ["규칙 " + "나".repeat(5000)], verifyMode: "off" })); // 그 사이 저장
  let raceThrew = null, raceOut = "";
  try { raceOut = withContract("MY_PROMPT", wsRace, "ko", {}, "core", snap); } catch (e) { raceThrew = e; }
  ok(raceThrew === null && raceOut.includes("RACE_SMALL"), "스냅샷을 넘기면 사후 저장에 흔들리지 않고 검사 시점 계약으로 조립한다");
  ok(!raceOut.includes("나".repeat(100)), "사후 저장된 긴 규칙이 새어 들어가지 않는다");
  // 스냅샷을 안 넘기면 예전처럼 재판독해 중단된다(이 경로가 남아 있으면 같은 결함이 되살아난다).
  let noSnapThrew = null;
  try { withContract("MY_PROMPT", wsRace, "ko", {}, "core"); } catch (e) { noSnapThrew = e; }
  ok(noSnapThrew && noSnapThrew.contractTooLong === true, "스냅샷 없이 부르면 재판독해 중단된다(이중 방어는 살아 있음)");
}

console.log("[상한] 지도 조각은 이름·경로 길이를 제한하고 생략 개수를 밝힌다");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-reader.js"), "utf8");
  ok(src.indexOf("const PATH_MAX = 200, NOTE_MAX = 120;") >= 0, "경로 200·설명 120 상한이 있다(legacy 동봉과 같은 값)");
  ok(src.indexOf("filter((p) => p.length <= PATH_MAX)") >= 0 && src.indexOf("NOTE_MAX)") >= 0, "경로는 상한 초과 시 제외하고(자르지 않음) 설명만 상한으로 자른다");
  ok(src.indexOf("clip(nd.label || nd.id.slice(0, 8), NOTE_MAX)") >= 0, "edge 줄에 쓰는 이름에도 적용된다(여기가 빠지면 우회로가 된다)");
  ok(/상한으로 생략: node/.test(src) && /omitted by caps/.test(src), "상한에 걸려 빠진 개수를 ko/en 모두 밝힌다");
  ok(/이 조각은 지도 전체가 아니다/.test(src), "목록을 전부로 오해하지 않게 못박는다");

  // 소스 문자열만 보면 '적용되는지'를 증명하지 못한다 — 실제로 실행해 유계임을 확인한다.
  const MR = require(path.join(__dirname, "..", "bridge", "map-reader.js"));
  const LONG = "L".repeat(600);
  const nodes = [], edges = [];
  for (let i = 0; i < 14; i++) nodes.push({ id: "n" + i, label: "이름" + LONG, anchors: [{ path: "src/" + LONG + "/f" + i + ".ts" }] });
  for (let i = 0; i < 11; i++) edges.push({ id: "e" + i, from: "n0", to: "n" + (i + 1), relation: "관계" + LONG });
  const wsSlice = path.join(dir, "projSlice");
  fs.mkdirSync(wsSlice, { recursive: true });
  const r = MR.renderV2Slice(wsSlice, {}, "ko", { ok: true, source: "v2", nodes, edges });
  ok(r && String(r.text).indexOf("미첨부") >= 0 && String(r.text).indexOf("node 14개") >= 0, "경로가 전부 상한 초과면 조용히 되돌아가지 않고 미첨부 사실과 개수를 밝힌다");

  // 폴백에 '실물이 있는' 갈래도 확인한다 — 기존 방식 지도가 실렸는데 '지도 없음'이라고 하면
  // 화면과 실제 입력이 갈린다(검증 [주의] f-19d46bb5의 직접 회귀 반례).
  const CLmod = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
  const realAttach = CLmod.buildScoutAttach;
  CLmod.buildScoutAttach = () => ({ text: "[탐색 지도 · 참고] LEGACY_MAP_MARKER", mapItems: [{ path: "legacy.ts", note: "n" }], couplings: [] });
  let rFb = null;
  try { rFb = MR.renderV2Slice(wsSlice, {}, "ko", { ok: true, source: "v2", nodes, edges }); } finally { CLmod.buildScoutAttach = realAttach; }
  ok(rFb && String(rFb.text).indexOf("LEGACY_MAP_MARKER") >= 0, "폴백 실물이 그대로 실린다");
  ok(rFb && String(rFb.text).indexOf("기존 방식 동봉이며 v2 조각이 아니다") >= 0, "실물이 있으면 '지도 없음'이 아니라 '기존 방식 동봉'이라고 말한다");
  ok(rFb && String(rFb.text).indexOf("이 요청에는 지도가 실리지 않았다") < 0, "실물이 있는데 '지도 미첨부'라고 말하지 않는다(안내·실물 상충 금지)");
  ok(rFb && Array.isArray(rFb.mapItems) && rFb.mapItems.length === 1 && rFb.mapItems[0].path === "legacy.ts", "폴백의 결속 필드가 보존된다(후속 판정이 쓰는 값)");

  // 경로를 자르면 실존하지 않는 파일이 된다 — 신선도 라벨은 붙은 채라 검증자가 없는 파일을 찾는다.
  // 그래서 자르지 않고 '항목 제외'로 처리하는지 실행으로 확인한다(긴 것 7 + 짧은 것 7).
  const mixed = [], mEdges = [];
  for (let i = 0; i < 7; i++) mixed.push({ id: "ln" + i, label: "긴것" + LONG, anchors: [{ path: "src/" + LONG + "/f" + i + ".ts" }] });
  for (let i = 0; i < 7; i++) mixed.push({ id: "sn" + i, label: "짧은것" + LONG, anchors: [{ path: "src/ok" + i + ".ts" }] });
  for (let i = 0; i < 11; i++) mEdges.push({ id: "e" + i, from: "sn0", to: "sn" + (i % 6), relation: "관계" + LONG });
  const r2 = MR.renderV2Slice(wsSlice, {}, "ko", { ok: true, source: "v2", nodes: mixed, edges: mEdges });
  ok(r2.mapItems.every((i) => i.path.indexOf("…") < 0), "경로를 잘라 실존하지 않는 값으로 만들지 않는다");
  ok(r2.mapItems.every((i) => i.path.startsWith("src/ok")), "상한을 넘는 경로의 node는 제외되고 쓸 수 있는 것만 실린다");
  ok(r2.text.indexOf("상한으로 생략: node 7개") >= 0, "제외한 개수를 생략 고지에 더한다(조용히 버리지 않음)");
  ok(r2.mapItems.every((i) => i.note.length <= 121), "설명은 자연어라 상한으로 자른다(식별자가 아님)");
  ok(r2.text.split("\n").filter((l) => l.startsWith("- [edge]")).length === 6, "edge는 6개만 실린다");
  ok(r2.text.length < 6000, "긴 이름이 섞여도 조각 전체가 유계다(실측 " + r2.text.length + "자)");
}

// 열린 지적 목록은 예외다 — 여기만은 상한을 두면 안 된다. 자르면 숨은 지적의 id를 인용할 수 없고
// 규약상 '미인용=신규 취급'이라 이력이 끊긴다. 이 계약을 되돌리려던 시도를 기존 반례가 막았다(2026-07-30).
console.log("[예외] 열린 지적 목록에는 상한을 두지 않는다 — 자르면 이력이 끊긴다");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ok(src.indexOf("OPEN_FINDINGS_MAX") < 0 || src.indexOf("상한을 두지 않는다") >= 0, "개수 상한 상수를 되살리지 않았다");
  ok(src.indexOf("for (const o of opens) L.push") >= 0, "열린 지적은 전부 주입한다(구현모델 선별 금지)");
  ok(src.indexOf("미인용=신규 취급") >= 0, "인용 규약이 그대로 살아 있다");
  ok(src.indexOf("여기에 개수 상한을 두면 안 된다") >= 0, "왜 자르면 안 되는지가 그 자리에 남아 있다(다음 사람이 같은 시도를 하지 않게)");

  // 소스 문자열 단언만으로는 '조회 자리에 .slice(0,N)을 붙이는' 다른 형태의 상한을 못 잡는다(검증 [보완]).
  // 30개를 넘겨 실제로 만들고, 처음과 마지막 id가 둘 다 실리는지 실행으로 비교한다.
  const CB = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
  if (typeof CB.v2DirectiveFor === "function") {
    const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
    const wsOF = path.join(dir, "projOpens");
    fs.mkdirSync(wsOF, { recursive: true });
    const N = 35, camp = "cl:opens-test:2026-07-30T00:00:00.000Z";
    const rows = [];
    for (let i = 0; i < N; i++) {
      rows.push({ type: "finding", findingId: "f-open" + String(i).padStart(3, "0"), campaignId: camp, round: 1, tag: "blocker", titleNorm: "지적 " + i, origin: "new-evidence", oosId: "", envelopeHash: null, demoted: false, status: "open", closeReason: "", ts: new Date(Date.UTC(2026, 6, 30, 0, 0, i)).toISOString() });
    }
    let wrote = false;
    try {
      CL.appendFindingsLedger(wsOF, rows);
      // v2DirectiveFor는 자기 캠페인 id로 조회한다 — 그 전제를 맞춰야 실제 주입 경로를 탄다.
      fs.mkdirSync(path.dirname(CL.campaignFileFor(wsOF)), { recursive: true });
      fs.writeFileSync(CL.campaignFileFor(wsOF), JSON.stringify({ schema: "vcamp-1", campaignId: camp, count: 1, budget: 5, startedAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z" }));
      wrote = true;
    } catch { wrote = false; }
    if (wrote) {
      const opens = CL.openFindingsFor(wsOF, camp, null);
      ok(opens.length === N, "열린 지적 " + N + "건이 실제로 조회된다(전제 확인 — 실측 " + opens.length + ")");
      const outDir = CB.v2DirectiveFor(wsOF, "ko");
      const has = (id) => String(outDir).indexOf(id) >= 0;
      ok(has("f-open000") && has("f-open034"), "30개를 넘겨도 첫 id와 마지막 id가 모두 실린다(조회 자리 절단 회귀도 잡힘)");
      ok(opens.every((o) => has(o.id)), "빠진 id가 하나도 없다");
    } else ok(false, "열린 지적 장부를 기록하지 못함(반례 전제 실패)");
  } else ok(false, "v2DirectiveFor를 불러오지 못함(반례가 실행 비교를 못 함)");
}

console.log("[상한] 총량은 막지 않고 어느 조각이 부풀었는지 알린다");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ok(src.indexOf("const HEAD_SOFT_LIMIT = 12000;") >= 0 && src.indexOf("검증자 프롬프트 머리가") >= 0, "총량이 크면 조각별 길이를 알려 사람이 줄일 자리를 알게 한다");
  ok(src.indexOf("head = head.slice(") < 0, "총량으로 통째 잘라내지 않는다(승인 정책 같은 계약이 사라지면 안 됨)");
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
