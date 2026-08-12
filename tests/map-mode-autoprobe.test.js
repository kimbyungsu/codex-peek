/*
 * 담당 선택과 준비 점검의 일원화(2026-08-04 사용자 실보고 봉합):
 *  ① 점검은 '고른 담당'만 호출한다 — 정밀형을 골랐는데 DeepSeek(경제형)까지 불러 잔액 부족 실패가
 *     뜨고 무관한 과금이 나던 문제. self는 무과금이라 항상 함께 본다.
 *  ② 담당을 고르면 그 자리에서 자동으로 점검한다 — "선택했는데 왜 점검을 또 눌러야 하나 · 선택만으로
 *     설정이 끝난 줄 안다"는 이원화 제거. 이미 준비된 담당은 다시 부르지 않는다(불필요 과금 방지).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");

console.log("[1] 대상 선정 — 고른 담당만(컴파일 산출물 실행)");
{
  const b = outSrc.indexOf("function probeTargetsFor(");
  const e = outSrc.indexOf("\nasync function runMapProbeFromUi", b);
  ok(b > 0 && e > b, "판단 함수 추출 가능");
  // bridgeLib()만 주입해 모드별 대상 집합을 실제로 계산시킨다
  const mk = (mode) => new Function("bridgeLib", outSrc.slice(b, e) + "\nreturn probeTargetsFor;")(() => ({ mapModeView: () => ({ mode }) }))("D:/x");
  ok([...mk("self")].join(",") === "self", "self=self만");
  ok([...mk("precision")].sort().join(",") === "precision,self", "precision=precision(+self) — 경제형 미호출");
  ok([...mk("economy")].sort().join(",") === "economy,self", "economy=economy(+self) — 정밀형 미호출");
  ok([...mk("auto")].sort().join(",") === "economy,precision,self", "auto=둘 다(+self)");
  // 계약 판독 실패=self만(과금 담당을 추측으로 부르지 않음)
  const broken = new Function("bridgeLib", outSrc.slice(b, e) + "\nreturn probeTargetsFor;")(() => { throw new Error("x"); })("D:/x");
  ok([...broken].join(",") === "self", "계약 판독 실패=self만(추측 과금 금지)");
}

console.log("[2] 점검 실행부 — 대상에 없는 담당은 호출 자체를 안 한다");
{
  const fnBeg = ext.indexOf("async function runMapProbeFromUi(ws: string | null, only?: Set<string>, opts?: { auto?: boolean })");
  const fnEnd = ext.indexOf("async function setScoutArmFromUi", fnBeg);
  const blk = fnBeg > 0 && fnEnd > fnBeg ? ext.slice(fnBeg, fnEnd) : "";
  ok(blk.length > 0, "실행부 블록 추출");
  // 재검증 blocker①: 자동 경로는 모달 없이(모달=사람 클릭 반복+닫으면 예약 소진·영구 보류), 수동 경로는 모달 유지
  ok(/if \(!\(opts && opts\.auto\)\) \{[\s\S]{0,600}showWarningMessage[\s\S]{0,900}modal: true/.test(blk), "비용 모달=수동 경로만(자동 경로는 무모달)");
  const iModal = blk.indexOf("점검 진행");
  const iBusy = blk.indexOf("mapProbeBusy = true");
  ok(iModal > 0 && iBusy > iModal, "모달 응답 뒤에만 실행 잠금(취소=실행 0)");
  ok(/opts && opts\.auto[\s\S]{0,120}설정 변경을 감지해 준비 점검을 자동으로 다시 했어요/.test(blk) && blk.includes("readiness was re-checked automatically"), "자동 실행 결과도 알림으로 고지(과금 투명성·ko/en)");
  ok(/const want = only \|\| probeTargetsFor\(ws\);/.test(blk), "대상 집합 결정(호출자 지정 우선)");
  ok(/if \(want\.has\("self"\)\) try \{[\s\S]{0,120}probeSelf/.test(blk), "self 게이트");
  ok(/if \(want\.has\("economy"\)\) try \{[\s\S]{0,160}probeEconomy/.test(blk), "economy 게이트(안 고르면 DeepSeek 미호출=과금 0)");
  ok(/if \(want\.has\("precision"\)\) try \{[\s\S]{0,200}probePrecision/.test(blk), "precision 게이트");
  ok(/선택한 담당\(\$\{\[\.\.\.want\]\.join\(", "\)\}\)의 준비 상태를 실제로 점검합니다/.test(blk) && /고르지 않은 담당은 부르지 않아요/.test(blk), "비용 모달이 실제 대상만 밝힌다(ko)");
  ok(/providers you did not choose are not called/.test(blk), "영문 문안 쌍");
}

console.log("[3] 선택=자동 점검(이원화 제거)");
{
  const fnBeg = ext.indexOf("async function setMapModeFromUi(");
  const fnEnd = ext.indexOf("// P8 증분 4 — 자동 보강 발동", fnBeg);
  const blk = fnBeg > 0 && fnEnd > fnBeg ? ext.slice(fnBeg, fnEnd) : "";
  ok(blk.length > 0, "선택 처리부 블록 추출");
  ok(/await runMapProbeFromUi\(ws, new Set\(pending\)\)/.test(blk), "선택 저장 직후 자동 점검 호출");
  ok(/const pending = need\.filter\(\(k\) => !\(rv && rv\[k\] && rv\[k\]\.ok\)\)/.test(blk), "이미 준비된 담당은 제외(불필요 과금 방지)");
  ok(/const need = mode === "auto" \? \["economy", "precision"\] : \[mode\];/.test(blk), "auto는 두 담당·그 외는 고른 담당만");
  const iSave = blk.indexOf("patchContractRetryExt(ws, lang, { mapMode: mode })");
  const iProbe = blk.indexOf("runMapProbeFromUi(ws, new Set(pending))");
  ok(iSave > 0 && iProbe > iSave, "저장 성공 뒤에 점검(저장 실패면 점검 안 함)");
  ok(/catch \{ \/\* 점검 실패는 선택 저장을 되돌리지 않는다/.test(blk), "점검 실패가 선택을 되돌리지 않음(정직 표시는 카드가 담당)");
  // 사용자 실보고: 이미 준비된 담당을 고르면 아무 반응이 없어 '된 건지 안 된 건지' 구분 불가였다
  ok(/else vscode\.window\.showInformationMessage/.test(blk) && /이미 준비돼 있어요 — 새로 점검하지 않았습니다/.test(blk), "점검이 불필요한 경우에도 결과를 말한다(무반응 금지·ko)");
  ok(/is already ready — no new check was run/.test(blk), "영문 문안 쌍");
}

console.log("[3-1] auto도 선택 가능 — '고르면 점검' 흐름에 도달한다(확인 검증 blocker)");
{
  ok(/mk\("auto", T\("자동형","Auto"\), autoOk\?T\("준비됨","ready"\):reasonT\(autoRd\|\|\{reason:"not-probed"\}\), false,/.test(ext), "auto 버튼 비활성 인자=false(경제형·정밀형과 같은 규칙)");
  ok(/고르면 아직 준비 안 된 담당을 그 자리에서 점검해요/.test(ext) && /choosing it checks whichever provider is not ready yet/.test(ext), "안내가 '고르면 점검'을 밝힘(ko/en)");
  ok(!/자동형은 경제형·정밀형이 모두 준비돼야 선택할 수 있어요/.test(ext), "구 '선택 불가' 문구 잔재 0");
  // 클릭 핸들러가 비활성일 때만 무시하므로, dis=false면 setMapMode 메시지가 실제로 나간다
  ok(/b\.addEventListener\("click", function\(\)\{ if\(dis\) return;/.test(ext), "비활성 시에만 클릭 무시(활성=선택 메시지 전송)");
}

console.log("[3-2] 수동 '다시 점검'은 미준비 담당만 — 준비된 유료 담당 재호출 금지(확인 검증 보완)");
{
  const b = outSrc.indexOf("function pendingTargetsFor(");
  const e = outSrc.indexOf("\nasync function runMapProbeFromUi", b);
  ok(b > 0 && e > b, "대상 축소 함수 추출 가능");
  const mkFn = (mode, rv) => new Function("bridgeLib", "precisionFpNowExt", "selfFpNowExt",
    outSrc.slice(outSrc.indexOf("function probeTargetsFor("), outSrc.indexOf("\nasync function runMapProbeFromUi")) + "\nreturn pendingTargetsFor;")
    (() => ({ mapModeView: () => ({ mode }), mapReadinessView: () => rv }), () => null, () => null)("D:/x");
  ok([...mkFn("auto", { self: { ok: true }, economy: { ok: true }, precision: { ok: false } })].join(",") === "precision", "auto·정밀형만 미준비=정밀형만 재호출");
  ok([...mkFn("auto", { self: { ok: true }, economy: { ok: false }, precision: { ok: false } })].sort().join(",") === "economy,precision", "둘 다 미준비=둘 다");
  ok([...mkFn("auto", { self: { ok: true }, economy: { ok: true }, precision: { ok: true } })].sort().join(",") === "economy,precision,self", "전부 준비=명시 재확인으로 전체");
  ok([...mkFn("precision", { self: { ok: true }, economy: { ok: false }, precision: { ok: true } })].sort().join(",") === "precision,self", "고르지 않은 담당은 애초에 대상 밖(경제형 미준비 무관)");
  ok(/runMapProbeFromUi\(wsP, pendingTargetsFor\(wsP\)\)/.test(ext), "버튼이 축소 대상을 실제로 넘김");
}

console.log("[4] 버튼은 '다시 점검'으로 — 선택만으로 끝난 줄 아는 오해 제거");
{
  ok(/pb\.textContent=T\("🔎 다시 점검","🔎 Re-check"\)/.test(ext), "버튼 이름=다시 점검");
  ok(/담당을 고르면 그 담당은 자동으로 점검돼요/.test(ext) && /Choosing a provider checks it automatically/.test(ext), "설명이 자동 점검을 먼저 밝힘(ko/en)");
  ok(!/자동 실행은 없어요\(이 버튼만\)/.test(ext), "구 문구('자동 실행 없음') 잔재 0");
  ok(/고른 담당만 실제로 호출합니다/.test(ext), "고른 담당만 호출한다는 사실 명시");
}

console.log("[6] 지문=내용 기반(2026-08-12) — 같은 내용 재기록이 거짓 '설정 변경'을 못 낸다(기능 실행)");
{
  const os = require("os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fp_home_"));
  process.env.CODEX_BRIDGE_HOME = home;
  const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
  const scFile = path.join(home, "scout-codex.json");
  const binFile = path.join(home, "codex-bin.txt");
  fs.writeFileSync(scFile, '{"model":"gpt-5"}'); fs.writeFileSync(binFile, "C:/codex.exe");
  const inv = { file: "C:/codex.exe", args: [] };
  const fp1 = CL.precisionExecFp(inv);
  // 같은 내용 재기록+mtime 강제 전진(설치기·경로 재확인 재현) — 지문 불변이어야 반복 보류가 사라진다
  fs.writeFileSync(scFile, '{"model":"gpt-5"}'); fs.writeFileSync(binFile, "C:/codex.exe");
  const past = new Date(Date.now() + 5000);
  fs.utimesSync(scFile, past, past); fs.utimesSync(binFile, past, past);
  const fp2 = CL.precisionExecFp(inv);
  ok(fp1 === fp2, "같은 내용 재기록(mtime 전진)=지문 불변(거짓 '설정 변경' 소멸)");
  fs.writeFileSync(scFile, '{"model":"gpt-5-mini"}');
  const fp3 = CL.precisionExecFp(inv);
  ok(fp3 !== fp1, "내용이 실제로 바뀌면 지문 변경(재점검 요구는 그대로 정확)");
  const lib = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
  ok(!lib.includes("mtimeSig"), "mtime 서명 잔재 0(economy·precision 모두 contentSig)");
}

console.log("[7] 지문 변경=자동 재점검(fp당 1회) — 사람 클릭 반복 제거 배선");
{
  const b = ext.indexOf("function maybeAutoReprobe(");
  const e = ext.indexOf("\nasync function runMapProbeFromUi", b) > 0 ? ext.indexOf("\nasync function runMapProbeFromUi", b) : ext.indexOf("\nfunction ", b + 10);
  const fn = b > 0 ? ext.slice(b, e) : "";
  ok(fn.length > 0, "maybeAutoReprobe 존재");
  ok(fn.includes('"config-changed"') && fn.includes('"probe-ver-changed"') && !fn.includes('"not-probed"') && !fn.includes('"probe-failed"'), "자동 대상=설정 변경·계약 개정만(최초·실패는 기존 경로 — 추측 과금 금지)");
  ok(fn.includes("autoReprobeTried.has(sig)") && fn.includes("autoReprobeTried.add(sig)"), "창 내 빠른 경로 — 상태 계산마다 잠금 파일을 두드리지 않음");
  // 재검증 blocker③: '1회'의 권위=전역 예약(파일 잠금). 예약 실패(다른 창 선점·잠금 실패)=실행 양보
  const iClaim = fn.indexOf("if (!CLs.claimAutoReprobe(sig)) return;");
  const iRun = fn.indexOf("runMapProbeFromUi(ws, new Set(need), { auto: true })");
  ok(iClaim > 0 && iRun > iClaim, "전역 예약 성공 후에만 자동 실행(예약이 실행보다 먼저)");
  ok(fn.includes('typeof CLs.claimAutoReprobe !== "function"') && fn.indexOf("claimAutoReprobe") < fn.indexOf("sig"), "구 배포본(예약 함수 없음)=자동 진입 자체를 안 함(기존 수동 경로 무회귀)");
  ok(fn.includes("probeTargetsFor(ws)") && iRun > 0, "고른 담당의 필요분만 재점검(기존 단일-flight 재사용) — 자동 경로 표식 동봉");
  ok(/maybeAutoReprobe\(ws, rv9\); return rv9;/.test(ext), "computeState 결속 — 상태 계산 때 자동 발동");
}

console.log("[8] 전역 예약(claimAutoReprobe) — 다중 창에서도 fp당 1회(기능 실행·재검증 blocker③)");
{
  const CL = require(path.join(ROOT, "bridge", "contract-lib.js")); // [6]의 tmp 홈 재사용
  ok(CL.claimAutoReprobe("sig-A") === true, "첫 예약=실행 권한");
  ok(CL.claimAutoReprobe("sig-A") === false, "같은 창 재시도=거부");
  const key = require.resolve(path.join(ROOT, "bridge", "contract-lib.js"));
  delete require.cache[key];
  const CL2 = require(path.join(ROOT, "bridge", "contract-lib.js")); // 두 번째 창 재현(독립 모듈 인스턴스 — 검증자 반례 구도)
  ok(CL2.claimAutoReprobe("sig-A") === false, "다른 창(독립 인스턴스)도 거부 — 중복 과금 점검 0");
  ok(CL2.claimAutoReprobe("sig-B") === true, "새 fp 조합=새 예약 1회");
  ok(CL2.claimAutoReprobe("") === false && CL2.claimAutoReprobe(null) === false, "빈 서명=예약 거부(fail-closed)");
}

console.log("[9] 실행·증명 결속 — 지문과 실행 인자는 같은 스냅샷(A→B→A 오결속 차단·재검증 blocker②)");
{
  const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
  const home = process.env.CODEX_BRIDGE_HOME;
  const scFile = path.join(home, "scout-codex.json");
  const inv = { file: "C:/codex.exe", args: [] };
  fs.writeFileSync(scFile, '{"model":"model-a"}');
  const snap = CL.readPrecisionConfigSnapshot();
  const fpA = CL.precisionExecFpFrom(inv, snap);
  fs.writeFileSync(scFile, '{"model":"model-b"}'); // 실행 직전 다른 창이 설정 교체(경합 재현)
  const argsS = CL.codexScoutExecArgsFromSnapshot(snap, "OUT").join(" ");
  ok(argsS.includes("model=model-a") && !argsS.includes("model-b"), "실행 인자=스냅샷(디스크가 B여도 A로 실행 — 지문과 같은 판독)");
  ok(CL.precisionExecFp(inv) !== fpA, "신선 판독은 B를 정직 반영(기록 시점 재대조가 불일치 기록을 폐기)");
  fs.writeFileSync(scFile, '{"model":"model-a"}');
  ok(CL.precisionExecFp(inv) === fpA, "A 복귀=지문 동일 — 실제 실행도 스냅샷(A) 인자였으므로 기록 유효가 '정확'");
  // economy도 같은 결속: 지문은 스냅샷에서, 자식(capability)에는 같은 원문을 env로 전달
  const dsFile = path.join(home, "deepseek.json");
  fs.writeFileSync(dsFile, '{"apiKey":"k-a"}');
  const snapE = CL.readEconomySnapshot();
  const fpEA = CL.economyConfigFpFrom(snapE);
  fs.writeFileSync(dsFile, '{"apiKey":"k-b"}');
  ok(CL.economyConfigFpFrom(snapE) === fpEA && CL.economyConfigFp() !== fpEA, "economy 지문도 스냅샷 고정(신선 판독은 변경 정직 반영)");
  const mp = fs.readFileSync(path.join(ROOT, "bridge", "map-probe.js"), "utf8");
  ok(/readPrecisionConfigSnapshot\(\)/.test(mp) && /precisionExecFpFrom\(inv, snapP\)/.test(mp) && /codexScoutExecArgsFromSnapshot\(snapP, outF\)/.test(mp) && !/CL\.codexScoutExecArgs\(outF\)/.test(mp), "probePrecision=스냅샷 경유(실행 직전 재판독 잔재 0)");
  ok(/readEconomySnapshot\(\)/.test(mp) && /economyConfigFpFrom\(snapE\)/.test(mp) && /\[CL\.DS_SNAPSHOT_ENV\]/.test(mp), "probeEconomy=스냅샷 지문+자식에 같은 원문 주입");
  const db = fs.readFileSync(path.join(ROOT, "bridge", "deepseek-bridge.js"), "utf8");
  ok(/CODEX_PEEK_DS_SNAPSHOT/.test(db) && /snap !== undefined/.test(db), "deepseek-bridge가 스냅샷 env를 존중(있으면 파일 재판독 안 함)");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
