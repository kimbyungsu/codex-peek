"use strict";
/*
 * 정찰(3트랙) 비용 투명 기록(2026-07-09 사용자 요구 "토큰·건수로 비용 추정 가능하게") + 상태바 flow 정찰 표시.
 * 감사 확정 결함: 비용 영구 기록 0(지도 10장 프루닝과 운명 공동체)·self 팔 미측정·ping 미기록·flow 모드 표시 전멸.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const VS = require(path.join(ROOT, "out", "verify-stats.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 비용 장부 — append-only·60일 트림(verdicts 패턴)");
ok(CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "D:/proj", arm: "deepseek", model: "deepseek-v4-flash", usageIn: 1000, usageOut: 200, pkgChars: 5000, mapChars: 900 }) === true, "deepseek 지도 기록 성공");
CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "D:/proj", arm: "self", usageIn: null, usageOut: null, pkgChars: 4000, mapChars: 800 });
CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "ping", model: "deepseek-v4-flash", usageIn: 10, usageOut: 3 });
CL.appendScoutUsage({ ts: new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString(), workspace: "D:/proj", arm: "deepseek", usageIn: 99999, usageOut: 99999 });
CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "D:/other", arm: "deepseek", usageIn: 777, usageOut: 77 });
const rawLog = fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8");
ok(!rawLog.includes("99999"), "60일 지난 기록은 트림(오래된 비용은 잘림 — 정직 고지 대상)");
ok(CL.appendScoutUsage({ arm: "" }) === false && CL.appendScoutUsage(null) === false, "무효 이벤트 거부");

console.log("[2] 집계(computeScoutCosts) — 프로젝트 필터·ping 전역·팔별 합계·28일");
const costs = VS.computeScoutCosts(fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8"), Date.now(), "D:/proj", (s) => String(s).toLowerCase());
ok(costs.byArm.deepseek && costs.byArm.deepseek.count === 1 && costs.byArm.deepseek.usageIn === 1000 && costs.byArm.deepseek.usageOut === 200, "deepseek — 이 프로젝트 것만(타 프로젝트 777 제외)·실측 토큰 합");
ok(costs.byArm.self && costs.byArm.self.count === 1 && costs.byArm.self.pkgChars === 4000 && costs.byArm.self.mapChars === 800 && costs.byArm.self.usageIn === 0, "self — 문자수만 합산(토큰 null은 0 유지 — 거짓 토큰 안 만듦)");
ok(costs.byArm.ping && costs.byArm.ping.count === 1 && costs.byArm.ping.usageIn === 10, "ping — 프로젝트 무관 전역 포함(3트랙 켤 때 1회 점검)");
ok(costs.total === 3, "28일 총 건수(트림 전 오래된 건·타 프로젝트 제외)");
const empty = VS.computeScoutCosts("", Date.now(), "D:/proj", (s) => s);
ok(empty.total === 0 && Object.keys(empty.byArm).length === 0, "기록 없음 → 빈 집계(0 표시용)");

console.log("[3] 생산자 배선(소스 잠금) — 러너 2종·ping이 실제로 장부에 쓴다");
const selfSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-self.js"), "utf8");
const dsSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-deepseek.js"), "utf8");
const brSrc = fs.readFileSync(path.join(ROOT, "bridge", "deepseek-bridge.js"), "utf8");
const provSrc = fs.readFileSync(path.join(ROOT, "scripts", "scout-providers.js"), "utf8");
ok(/schema: "scout-usage-v2"/.test(provSrc) && /repoKey: CL\.repoKeyForStats\(repo\)/.test(provSrc) && /flow: "map-scout"/.test(provSrc), "공통 파이프라인(P10) — 실제 저장소 키·목적별 v2 호출 기록");
ok(/tokenIn: both9 \? u9\.in : null/.test(provSrc) && /usage: null/.test(provSrc), "self 어댑터 — 토큰 미제공 시 null 정직(문자수와 분리)");
ok(/runScout\(repo, "self"/.test(selfSrc) && /runScout\(repo, "deepseek"/.test(dsSrc), "러너 2종은 runScout 위임(장부 배선은 공통층 한 곳)");
ok(/inheritedUsageContext\("readiness"/.test(brSrc) && /schema: "scout-usage-v2"/.test(brSrc) && /callId/.test(brSrc), "연결·형식 점검 API도 실제 호출별 v2 행으로 기록");

console.log("[4] 통계 탭 표시(소스 잠금) — P10 목적별 사용량·정직 각주");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/목적별 외부 호출·사용량/.test(ext) && /External calls and usage by purpose/.test(ext), "통계 탭 목적별 사용량 구획(한/영)");
ok(/원장은 60일 보존/.test(ext) && !/영구 장부/.test(ext) && /logs are kept for 60 days/.test(ext), "보존 기간 표현 정직 — '영구' 금지(실제 60일 트림과 일치)");
ok(/토큰 미제공 호출의 입력/.test(ext) && /calls without tokens/.test(ext), "토큰 미제공 호출은 글자 수로 별도 표시");
ok(/collectMapHistoryState\(contract\.scoutMode === "on", mapActualRepo/.test(ext) && /repoKeyForStats\(repo\)/.test(ext), "판독기 — actual repo 익명 키 기준·3트랙 게이트로 상태에 실림");
ok(/전역 준비 점검 \(현재 프로젝트 비용과 분리\)/.test(ext) && /Global readiness checks \(separate from current-project usage\)/.test(ext), "준비 점검은 현재 프로젝트 비용과 분리");

console.log("[4b] 모델 이름이 기록에 없을 때 '지금 설정'을 대신 보여줌(2026-07-28 사용자 요청 — Claude·Codex 정찰은 호출이 모델을 안 돌려줌)");
ok(/scoutModelNow: \{ claude: string; codex: string; deepseek: string \}/.test(ext), "상태에 담당별 '지금 설정' 모델 슬롯 존재");
ok(/claude: readClaudeSettingsModel\(\)/.test(ext), "Claude 정찰은 대화창 선택이 아니라 설정 파일 기본 모델을 쓰므로 그 값을 표시(별도 프로세스 실행 경로와 일치)");
ok(/codex: scoutCodexPrefs\.model/.test(ext) && /deepseek: dsView\.model/.test(ext), "Codex는 정찰 두뇌 설정, DeepSeek는 고급설정 모델을 그대로 표시");
ok(/const dsView = readDeepseekView\(\)/.test(ext) && /const scoutCodexPrefs = readScoutCodexPrefsExt\(\)/.test(ext) && !/scoutCodex: readScoutCodexPrefsExt\(\)/.test(ext), "같은 설정 파일을 한 번만 읽어 재사용(상태 조립마다 중복 판독 없음)");
// 2026-07-28 사용자 지적: 이 담당들은 매번 고르는 게 아니라 설정값으로 고정돼 도니, '기록이 없다'로 시작하면
// 실제 상황을 잘못 전달한다. 고정 사실을 앞에 두고 기록에 안 남는 이유는 괄호로 덧붙인다.
ok(/지금 설정한 모델로 고정됩니다: /.test(ext) && /Fixed to the model set right now: /.test(ext), "지정이 있으면 '지금 설정한 모델로 고정' 문구가 먼저 온다(한/영 — '지금'으로 시점 명시)");
ok(/지금은 기본값으로 고정됩니다 \(따로 지정 안 함/.test(ext) && /Right now it is fixed to the default \(nothing specified/.test(ext), "지정이 없으면 '지금은 기본값으로 고정' 문구(빈칸·추측 금지)");
ok(/호출이 모델을 알려주지 않아 기록엔 안 남아요/.test(ext) && /the call does not report a model, so records have none/.test(ext), "기록이 비는 이유를 함께 밝힘(기록 위장 금지)");
// 1차 [보완] 수용: 표시값은 '지금 설정'인데 카드는 과거 기록을 집계하므로, 지난 호출이 그때 설정을 따랐음을 함께 밝힌다.
ok(/지난 호출은 그때 설정을 따랐어요/.test(ext) && /past calls followed the setting at that time/.test(ext), "과거 호출이 현재 설정으로 돌았다고 읽히지 않게 시점 구분을 명시");
ok(!/이 기록엔 모델 이름이 없어요/.test(ext) && !/모델 이름 기록 없음/.test(ext), "'기록 없음'으로 시작하던 옛 문구 잔재 0");

console.log("[4c] 자동 보강 보류 사유를 사람 말로(2026-07-28 사용자 지적 — 화면에 영문 코드가 그대로 떴다)");
ok(/var PARK_REASONS=\{/.test(ext) && /function parkReasonText\(raw, readiness\)/.test(ext), "보류 사유 표+변환 함수 존재(현재 준비 상태도 함께 받음)");
// 실사고 2026-08-04: 준비 점검만으로는 이미 보류된 작업이 열리지 않는다 — 순서를 그 자리에서 안내한다.
ok(/먼저 위의 🔎 준비 점검을 통과시킨 뒤 '다시 시도'를 눌러야 열립니다/.test(ext) && /then press Retry \(the check alone does not resume it\)/.test(ext), "보류+담당 미준비=점검→다시 시도 순서 안내(ko/en)");
ok(/if\(modeNow!=="self" && curRd0 && curRd0\.ok!==true\)/.test(ext), "순서 안내는 self 아님+미준비일 때만(정상 상태 잡음 금지)");
ok(/parkReasonText\(en9\.job\.parkedReason, d\.mapReadiness\)/.test(ext) && !/\+\(en9\.job\.parkedReason\|\|""\)/.test(ext), "보강 상태 줄이 원시 코드 대신 변환을 거침(직결 잔재 0)");
ok(/"precision-not-ready": \["정밀형 담당이 아직 준비되지 않았어요"/.test(ext), "실제로 발생한 사유(정밀형 미준비)가 표에 있음");
// 1차 [보완] 수용 2건: provider-conflict는 '설정 불일치'가 아니라 '결과 충돌'이고, 사유 목록은 닫혀 있지 않다.
ok(/"provider-conflict": \["담당들이 낸 결과가 서로 충돌해요"/.test(ext) && !/담당 지정이 서로 어긋나요/.test(ext), "provider-conflict를 결과 충돌로 옮김(설정 불일치 오역 잔재 0)");
ok(/'자주 나오는 사유'만/.test(ext) && !/닫힌 목록이라 표로 옮기되/.test(ext), "표가 전체 사유를 담는다는 서술 제거(실행기가 동적 사유도 만든다)");
{
  // 흐름 실행: 모르는 코드는 사라지지 않고 그대로, 공급자가 붙은 형태는 앞부분만 옮기고 뒤는 괄호로 남는다.
  const src2 = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const st = src2.indexOf("function parkReasonText(");
  let i = src2.indexOf("{", st), d2 = 0, fnTxt = "";
  for (; i < src2.length; i++) { if (src2[i] === "{") d2++; else if (src2[i] === "}") { d2--; if (d2 === 0) { fnTxt = src2.slice(st, i + 1); break; } } }
  const tblSt = src2.indexOf("var PARK_REASONS=");
  const tblTxt = src2.slice(tblSt, src2.indexOf("};", tblSt) + 2);
  const f = new Function("T", tblTxt + "\n" + fnTxt + "\nreturn parkReasonText;")((ko) => ko);
  ok(f("precision-not-ready") === "정밀형 담당이 아직 준비되지 않았어요", "표에 있는 코드는 사람 말로 옮겨짐");
  ok(f("adapter-missing:codex") === "그 담당을 실행할 방법이 없어요 (codex)", "공급자가 붙은 형태는 앞부분 변환+뒤는 괄호 보존");
  ok(f("brand-new-code") === "brand-new-code", "모르는 코드는 사라지지 않고 그대로 보임(정보 손실 금지)");
  ok(f("") === "사유 기록 없음", "사유가 비면 빈칸 대신 그렇다고 밝힘");
}

console.log("[4d] 0회인 이유·멈춤 사유의 현재 상태(2026-07-29 사용자: 숫자만 보고는 이해할 수 없었다)");
ok(/var why=zeroReason\(prefix\)/.test(ext) && /T\("0회인 이유","Why zero"\)/.test(ext), "0회 줄 옆에 이유 줄을 함께 표시");
ok(/if\(prefix!=="map-enrich"&&prefix!=="map-adjudicate"\) return "";/.test(ext), "이유 표시는 의미 보강·검증 담당 판정 두 칸에만(다른 칸 오염 금지)");
ok(/이 판정은 자동 보강이 도는 중에만 생겨요/.test(ext) && /This adjudication only happens while auto-enrichment runs/.test(ext), "검증 담당 판정이 보강에 딸린 것임을 밝힘(한/영)");
// 2026-07-29 설계 상의 반영: 실패 기록이 있으면 그 실패를 그대로 말하고, 없을 때만 '시도 기록 전/후'로 가른다.
ok(/자동 보강이 담당을 부르기 전에 멈췄어요/.test(ext) && /자동 보강이 담당 시도가 기록된 뒤 멈췄어요/.test(ext), "담당 시도 기록 전후를 구분해 표시(provider만으로 '호출 완료'를 단정하지 않음)");
ok(/정찰 구역의 '다시 시도'를 눌러야 다시 진행돼요/.test(ext), "멈춤 상태와 다음 행동(다시 시도)을 함께 안내");
ok(/자동 보강 기록이 손상돼 자동 실행이 멈춰 있어요/.test(ext), "손상 상태를 미시작과 구분해 표시");
{
  // 멈춘 사유는 '그때'의 사실이다. 그 사이 준비가 끝났으면 지금 상태를 함께 말해야 한다
  // (실사고: 7/24에 정밀형 미준비로 멈춘 문구가 준비가 끝난 뒤에도 그대로 떠 있었다).
  const src3 = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const st3 = src3.indexOf("function parkReasonText(");
  let i3 = src3.indexOf("{", st3), d3 = 0, fn3 = "";
  for (; i3 < src3.length; i3++) { if (src3[i3] === "{") d3++; else if (src3[i3] === "}") { d3--; if (d3 === 0) { fn3 = src3.slice(st3, i3 + 1); break; } } }
  const tbl3 = src3.slice(src3.indexOf("var PARK_REASONS="), src3.indexOf("};", src3.indexOf("var PARK_REASONS=")) + 2);
  const g = new Function("T", tbl3 + "\n" + fn3 + "\nreturn parkReasonText;")((ko) => ko);
  ok(g("precision-not-ready", { precision: { ok: true } }).includes("지금은 준비돼 있어요 — 다시 시도해 볼 수 있어요"), "그 사이 준비가 끝났으면 '지금은 준비됨·다시 시도해 볼 수 있음'까지만 덧붙임(1차 [보완] — 실행 보장 문구 금지)");
  ok(!g("precision-not-ready", { precision: { ok: false } }).includes("지금은 준비돼 있어요"), "아직 준비 안 됐으면 덧붙이지 않음");
  ok(!g("precision-not-ready", {}).includes("지금은 준비돼 있어요"), "준비 상태를 모르면 덧붙이지 않음(추측 금지)");
  ok(g("precision-not-ready", { precision: { ok: true } }).startsWith("정밀형 담당이 아직 준비되지 않았어요"), "그때의 사유 자체는 지우지 않음(기록 왜곡 금지)");
}
ok(/if\(c\.models&&c\.models\.length\) models\.textContent=T\("기록된 모델: "/.test(ext), "기록이 있으면 종전대로 기록된 모델 우선(무회귀)");

console.log("[4e] 실패를 '호출 실패'와 '답 거부'로 갈라 표시(2026-07-29 설계 상의 결론 — 사용자 실사고)");
{
  const jobBlk = ext.slice(ext.indexOf("job: job9 ?"), ext.indexOf("awaitingVerification"));
  ok(/lastFailure: last9 && last9\.failureCode/.test(ext), "구조 필드가 있으면 그대로 싣는다");
  // 구형 기록 폴백(2026-08-04 실사고): failReason '존재 여부'만 보고 일반 코드로 바꾼다 —
  // 자유 문자열 자체는 여전히 화면 상태로 나가지 않아야 한다.
  ok(/code: "legacy-unstructured"/.test(jobBlk), "구형 기록도 사유가 있었음을 일반 코드로 전달");
  ok(!/failReason: /.test(jobBlk) && !/last9\.failReason(?!\s*===|\s*\.trim|\s*\))/.test(jobBlk.replace(/typeof last9\.failReason/g, "")), "자유 문자열 값 자체는 상태에 안 실림(존재 검사·접두 판별만)");
  ok(/"legacy-unstructured": \[/.test(ext), "구형 코드의 사람 문구가 표에 존재(알 수 없는 실패로 뭉개지 않음)");
}
ok(/"evidence-mismatch": \["답은 돌아왔지만 근거로 든 인용이 실제 파일과 맞지 않아 버렸어요"/.test(ext), "인용 불일치 문구(이번 실사고의 실제 사유)");
ok(/"evidence-unreadable": \["답은 돌아왔지만 근거 파일을 읽어 확인하지 못했어요"/.test(ext) && /"parse-invalid":/.test(ext) && /"schema-invalid":/.test(ext), "결과 거부를 형식·구조·근거로 갈라 표시(한 덩어리로 뭉치지 않음)");
ok(/"process-failed": \["담당 호출을 끝내지 못했어요"/.test(ext) && !/담당을 부르지 못했어요/.test(ext), "호출 실패는 '끝내지 못했어요'(프로세스가 뜬 뒤 실패했을 수 있음)");
ok(/사용량 소모/.test(ext) && /uses quota/.test(ext), "재시도 안내에 추가 사용량 발생을 명시([주의] 수용 — 비용 오판 방지)");
// 3차 [보완] 반영: 멈춤 사유가 '실행이 실패'라고 먼저 말하면 뒤의 '답은 돌아왔지만…'과 모순된다.
ok(/"precision-failed": \["정밀형 담당에서 더 진행하지 못했어요"/.test(ext) && !/정밀형 담당 실행이 실패했어요/.test(ext), "담당 실패 사유를 중립 표현으로(호출 실패 단정 잔재 0)");
ok(/이미 사용량이 들었을 수 있고, 다시 시도하면 또 들 수 있어요/.test(ext), "호출 단계 실패에도 이미 든 사용량·추가 사용량 가능성 명시");
ok(/답은 돌아왔지만 결과를 읽거나 형식을 맞출 수 없어 버렸어요/.test(ext), "담당이 읽기 실패와 형식 불일치를 한 신호로 주는 경우를 함께 담는 문구");
ok(/function safeShowFile\(v: any\): string \| null/.test(ext) && /file: safeShowFile\(last9\.failureFile\)/.test(ext), "옛 기록의 위험한 파일 표기는 화면으로 나가기 전에 한 번 더 거름");
ok(/T\(" · 마지막 시도: "," · last attempt: "\)/.test(ext), "영어 문구도 앞 공백을 지켜 붙임(구분 공백 누락 회귀 차단)");
// 4차 [보완]: 영어 조언이 앞 문장에 붙어 "(...js)A retry"처럼 보였다.
ok(/" Check the provider's executable/.test(ext) && /" A retry may produce a different answer/.test(ext), "영어 실패 안내도 앞 공백을 지켜 붙임");
ok(/replace\(\/\\\\\/g, "\/"\)/.test(ext), "safeShowFile이 단일 역슬래시를 정규화(윈도 표기의 상위 탈출도 걸러짐)");
{
  const src5 = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const s5 = src5.indexOf("function safeShowFile(");
  let i5 = src5.indexOf("{", s5), d5 = 0, fn5 = "";
  for (; i5 < src5.length; i5++) { if (src5[i5] === "{") d5++; else if (src5[i5] === "}") { d5--; if (d5 === 0) { fn5 = src5.slice(s5, i5 + 1); break; } } }
  const safeShowFile = new Function(fn5 + "\nreturn safeShowFile;")();
  ok(safeShowFile("src/a.js") === "src/a.js", "정상 상대경로는 그대로 통과");
  ok(safeShowFile("..\\..\\secret.js") === null, "윈도 표기 상위 탈출 차단");
  ok(safeShowFile("safe\\..\\secret.js") === null, "중간에 낀 윈도 표기 상위 탈출 차단");
  ok(safeShowFile("D:/x/secret.js") === null && safeShowFile("/etc/passwd") === null, "절대경로 차단");
  ok(safeShowFile("src/a.js" + String.fromCharCode(10) + "(연결 정상)") === null, "여러 줄 값 차단");
}
ok(/담당 실행 파일·설정·연결을 먼저 확인해 주세요/.test(ext), "호출 실패와 답 거부의 다음 행동을 갈라 안내");
ok(/이 숫자는 담당을 부른 횟수예요 — 그 답이 채택됐다는 뜻은 아니에요/.test(ext) && /it does not mean the answers were accepted/.test(ext), "의미 보강 숫자의 뜻을 못박음(호출 수 ≠ 채택 수)");
{
  // 흐름 실행: 코드별 문구·안내가 실제로 갈리는지, 모르는 코드는 사라지지 않는지.
  const src4 = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const pick = (name) => { const s0 = src4.indexOf("function " + name + "("); let i = src4.indexOf("{", s0), d = 0; for (; i < src4.length; i++) { if (src4[i] === "{") d++; else if (src4[i] === "}") { d--; if (d === 0) return src4.slice(s0, i + 1); } } return ""; };
  const tbl4 = src4.slice(src4.indexOf("var FAIL_TEXT="), src4.indexOf("};", src4.indexOf("var FAIL_TEXT=")) + 2);
  const M = new Function("T", tbl4 + "\n" + pick("failureText") + "\n" + pick("failureAdvice") + "\nreturn {failureText, failureAdvice};")((ko) => ko);
  ok(M.failureText({ code: "evidence-mismatch", file: "scripts/make-icon.js", stage: "validation" }).includes("scripts/make-icon.js"), "근거 불일치는 어느 파일인지 함께 보여줌");
  ok(M.failureText({ code: "process-failed", stage: "call" }) !== M.failureText({ code: "evidence-mismatch", stage: "validation" }), "호출 실패와 답 거부의 문구가 서로 다름");
  ok(M.failureAdvice({ code: "process-failed", stage: "call" }).includes("설정") && !M.failureAdvice({ code: "process-failed", stage: "call" }).includes("사용량 소모"), "호출 실패 안내는 설정·연결 쪽(재시도 비용 문구 아님)");
  ok(M.failureAdvice({ code: "evidence-mismatch", stage: "validation" }).includes("사용량 소모"), "답 거부 안내에는 재시도 비용 명시");
  ok(M.failureText({ code: "brand-new-code", stage: "validation" }).includes("brand-new-code"), "모르는 코드는 사라지지 않고 그대로 보임");
  ok(M.failureText(null) === "" && M.failureAdvice(null) === "", "실패 기록이 없으면 아무 말도 만들지 않음");
}

console.log("[5] 상태바(소스 잠금) — 감사 B 반영: flow 병기·툴팁 분기·게이트·평시 분기·워처");
ok(/const scoutOn = !!ws && \(\(\) => \{ try \{ return loadContract\(ws\)\.scoutMode === "on"; \}/.test(ext), "scoutMode 게이트 일원화 — 2트랙 잔존 live 파일이 정찰 문구 노출 못 함");
ok(/mode === "linked" \|\| mode === "unlinked" \|\| mode === "flow"\) \? readScoutLive\(ws\) : null/.test(ext), "flow 모드에서도 정찰 라이브 읽음(자동 지시 주 경로 — 표시 전멸 해소)");
ok(/const flowScout = scoutLiveNow/.test(ext) && /이 턴 안에서 실행/.test(ext) && /running inside this turn/.test(ext), "flow 3박스 툴팁에 정찰 지도 생성 병기(한/영)");
ok(/scoutLiveNow \? " \$\(telescope\) " \+ tE\("탐색중","scouting"\)/.test(ext) && /·DeepSeek/.test(ext), "flow 화살표에 '탐색중(·DeepSeek)' 글자 라벨 — 아이콘·툴팁만으론 부족(2026-07-09 사용자 정정: 2트랙 작업중/검증중과 같은 시각 문법)");
ok(/const flowLlm = toCodex/.test(ext) && /Claude가 검증 답을 반영 중/.test(ext) && !/fArrow\.tooltip = new vscode\.MarkdownString\(tE\(`\*\*검증 진행 — `,`\*\*verify progress — `\) \+ `\$\{live\.label\}\*\*` \+ `\$\{live\.round \? tE\(` \(라운드 \$\{live\.round\}\)`,` \(round \$\{live\.round\}\)`\) : ""\}` \+ tE\(`\\n\\n⚡ LLM 호출 중: Codex 검증`/.test(ext), "툴팁 LLM 문구 단계별 분기 — 전 단계 'Codex 검증' 단정 제거");
ok(/tE\("지금 실행 중인 LLM 호출 없음", "no LLM call running now"\)/.test(ext), "2트랙 평시 줄 — 정찰 기능(변경 감지·일지) 설명 뗌(사실 아님)");
ok(/fs\.watch\(liveDir, \(\) => scheduleRender\(\)\)/.test(ext), "scout-live 전용 워처 — 생성중 표시 등장·해제 15초 지연 해소");

console.log("[6] 문서 정합(감사 C 반영 잠금)");
const privacy = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
ok(/scout-baseline\.json/.test(privacy) && /scout-live\/<키>\.json/.test(privacy) && /stats\/scout-usage\.jsonl/.test(privacy), "PRIVACY — 새 파일 3종(태도 슬롯·라이브 신호·비용 장부) 기재");
ok(/판정·복권 증거 이벤트\(반박·대체·소멸·사람 재확인·반박 이후 유효 확인\)는 우선 보존/.test(privacy) && /순계 압축/.test(privacy), "PRIVACY — 트림 서술을 현행(판정 보존+가역쌍 순계 압축) 구현에 맞춤");
ok(/반박 뒤 재확인\(사람 1회·검증 2회\)이 쌓이면 복권/.test(ext) && /rehabilitated if re-confirmed after \(1 human \/ 2 verify\)/.test(ext), "가이드 — 복권 경로 반영(틀림=영구 제외 서술 폐기)");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const readmeEn = fs.readFileSync(path.join(ROOT, "docs", "README.en.md"), "utf8");
ok(/3트랙 기여\(관찰 신호\)/.test(readme) && /Project MAP 운영 현황/.test(readme) && /목적별 외부 호출·사용량/.test(readme), "README ko — 통계 절에 기여 카드·P10 목적별 사용량");
ok(/단계별 기본 원칙\*\* 섹션에서/.test(readme) && /④ 정찰 기본 원칙/.test(readme) && !/🔒 기본 지침\*\* 섹션/.test(readme), "README ko — 옛 명칭 정리+④칸 안내");
ok(/scout-baseline\.en\.json/.test(readme) && /지도 원문 언어도 전역 언어를 따릅니다/.test(readme), "README ko — 언어 절에 정찰 슬롯·지도 언어");
ok(/3-track contribution card/.test(readmeEn) && /Project MAP operations/.test(readmeEn) && /per-language slots/.test(readmeEn), "README en — 대응 절 갱신");

console.log("[7] 리팩토링(감사 D 반영 잠금) — 고아 제거·version 실사용·러너 i18n");
ok(!/m\?\.type === "saveScoutBaseline"/.test(ext) && !/target: "scoutBase"/.test(ext), "고아 메시지 핸들러(웹뷰가 더는 안 보내는 saveScoutBaseline/reset) 제거");
ok(!/function currentWorkspace\(\)/.test(ext), "미사용 currentWorkspace() 제거");
ok(/형식 버전 /.test(ext) && /format version /.test(ext), "scoutPrompt.version — ④-형식 계약 표시에 실사용");
ok(/const tB = \(ko, en\) => \(loadLang\(\) === "en" \? en : ko\)/.test(selfSrc) && /const tB = \(ko, en\) => \(loadLang\(\) === "en" \? en : ko\)/.test(dsSrc), "러너 2종 CLI 출력 tB 이중언어화(EN 자동지시가 실행을 지시하는 노출 경로)");
// '팔' 은어 잔재 0 잠금(2026-07-09 사용자: 일반인 이해 불가 — 사용자 표면 전수 교체. '명령 팔레트'는 무관 어휘라 허용)
const uiArm = ext.split(String.fromCharCode(10)).filter((l) => /팔/.test(l) && !/팔레트/.test(l));
ok(uiArm.length === 0, "확장 사용자 표면 '팔' 잔재 0" + (uiArm.length ? " ← " + uiArm[0].trim().slice(0, 60) : ""));
ok(!/ arm runs| arm stays| either arm|comparison arm|self arm|self-arm/.test(ext), "확장 영어 'arm' 잔재 0(식별자 제외)");

console.log("[8] 실행 — en 홈에서 러너 usage 출력이 영어(끝-끝 · 비-git은 무이력 폴백으로 실제 LLM을 부르므로 usage 경로로 검증)");
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "en" }));
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-scout-self.js")], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(r.status === 2 && /Usage: node scripts\/scope-scout-self\.js/.test(r.stderr), "self 러너 인자 없음 → 영어 usage(한글 단일 출력 회귀 방지)");
const r2 = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-scout-deepseek.js")], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(r2.status === 2 && /Usage: node scripts\/scope-scout-deepseek\.js/.test(r2.stderr), "deepseek 러너 인자 없음 → 영어 usage");
try { fs.unlinkSync(path.join(dir, "language.json")); } catch { /* 무해 */ }

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
