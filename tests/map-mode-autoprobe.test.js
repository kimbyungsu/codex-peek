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
  const fnBeg = ext.indexOf("async function runMapProbeFromUi(ws: string | null, only?: Set<string>)");
  const fnEnd = ext.indexOf("async function setScoutArmFromUi", fnBeg);
  const blk = fnBeg > 0 && fnEnd > fnBeg ? ext.slice(fnBeg, fnEnd) : "";
  ok(blk.length > 0, "실행부 블록 추출");
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
}

console.log("[4] 버튼은 '다시 점검'으로 — 선택만으로 끝난 줄 아는 오해 제거");
{
  ok(/pb\.textContent=T\("🔎 다시 점검","🔎 Re-check"\)/.test(ext), "버튼 이름=다시 점검");
  ok(/담당을 고르면 그 담당은 자동으로 점검돼요/.test(ext) && /Choosing a provider checks it automatically/.test(ext), "설명이 자동 점검을 먼저 밝힘(ko/en)");
  ok(!/자동 실행은 없어요\(이 버튼만\)/.test(ext), "구 문구('자동 실행 없음') 잔재 0");
  ok(/고른 담당만 실제로 호출합니다/.test(ext), "고른 담당만 호출한다는 사실 명시");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
