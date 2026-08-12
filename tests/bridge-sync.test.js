// 혼합 설치 세대 불일치 봉합(2026-08-12) — 마켓 업데이트가 실행부를 못 덮어 고착되던 실사고의 구조 처방.
// ① 판정 순수 함수 추출 실행(무수정+구세대=자동 / 수정·판정불가=경보 / 동세대=none) ② 배선 소스 계약.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");

let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] 판정 순수 함수 — 컴파일 산출물에서 추출 실행");
{
  const b1 = outSrc.indexOf("function versionLt(");
  const e1 = outSrc.indexOf("\nfunction ", b1 + 10);
  const b2 = outSrc.indexOf("function decideManualBridgeSync(");
  const e2 = outSrc.indexOf("\nfunction ", b2 + 10);
  ok(b1 > 0 && b2 > 0, "두 함수 추출 가능");
  const mod = new Function(outSrc.slice(b1, e1) + "\n" + outSrc.slice(b2, e2) + "\nreturn { versionLt, decideManualBridgeSync };")();
  ok(mod.versionLt("0.1.88", "0.1.96") === true && mod.versionLt("0.1.96", "0.1.96") === false && mod.versionLt("0.2.0", "0.1.99") === false, "세대 비교(x.y.z 숫자)");
  ok(mod.versionLt("dev", "0.1.96") === false && mod.versionLt("0.1", "0.1.96") === false, "해석 불가=자동 덮기 금지 방향(false)");
  ok(mod.decideManualBridgeSync(0, null, null, "0.1.96") === "none", "동세대=none(승격만)");
  ok(mod.decideManualBridgeSync(3, 0, "0.1.88", "0.1.96") === "auto", "무수정 설치기 배포본+구세대=자동 동기화");
  ok(mod.decideManualBridgeSync(3, 1, "0.1.88", "0.1.96") === "notice", "파일 1개라도 수정 감지=자동 금지·경보");
  ok(mod.decideManualBridgeSync(3, 0, "0.1.96", "0.1.96") === "notice", "동버전 manifest(세대 우열 없음)=자동 금지");
  ok(mod.decideManualBridgeSync(3, 0, "0.2.0", "0.1.96") === "notice", "개발자의 더 새로운 수동 빌드=절대 안 덮음");
  ok(mod.decideManualBridgeSync(3, null, null, "0.1.96") === "notice", "manifest 부재(구식 설치)=경보(조용한 고착 금지)");
}

console.log("[2] 배치 흐름 ④ 재작성 — 무조건 존중 폐기·판정 분기");
{
  const b = src.indexOf("function deployBridgeRuntime(");
  const e = src.indexOf("\nfunction ", b + 10);
  const fn = src.slice(b, e);
  ok(!/return false;\s*\/\/ 정상 수동 설치 존중/.test(fn), "구 '무조건 존중' 분기 소멸");
  ok(fn.includes("decideManualBridgeSync(drift.length, mismatch,") && fn.includes('decision === "auto"'), "판정 함수 경유(자동 경로)");
  ok(/syncBridgeDriftEvents\(wsA, \[\{[\s\S]{0,80}sig: `bridge-drift:\$\{ver\}:\$\{drift\.length\}`/.test(fn), "자동 불가=가시 경보 발행(재발행 방지 sig)");
  ok(/drift\.length === 0[\s\S]{0,120}writeStamp = true/.test(fn), "동세대=관리 모드 승격(다음 업데이트부터 자동)");
  ok(fn.includes("syncBridgeDriftEvents(wsA, [])"), "해소 경로=드리프트 경보 자기치유 소거");
}

console.log("[3] 1클릭 복구·배너·manifest 세대 기록");
{
  ok(/m\?\.type === "syncBridge"/.test(src) && src.includes("forceSyncBridgeRuntime(this.uri.fsPath)"), "syncBridge 핸들러(사용자 클릭 경로)");
  const b = src.indexOf("function forceSyncBridgeRuntime(");
  const e = src.indexOf("\nfunction ", b + 10);
  const fn = src.slice(b, e);
  ok(/runtime-backup-/.test(fn) && fn.indexOf("copyFileSync") < fn.indexOf("atomicWriteFile(path.join(BRIDGE_DIR, f), body)"), "복구=백업 먼저, 그다음 배치(파괴적 덮기 금지)");
  ok(fn.includes("writeDeployManifest(src)") && fn.includes("BRIDGE_STAMP"), "복구 후 관리 모드 전환(stamp+manifest — 이후 자동)");
  ok(/e\.kind==="bridge-drift"/.test(src) && src.includes('vscode.postMessage({type:"syncBridge"})') && src.includes("실행부 맞추기(백업 후 갱신)") && src.includes("Sync runtime (backup first)"), "배너 버튼 ko/en(드리프트 경보 있을 때만)");
  ok(/version: mVer, ts: new Date\(\)\.toISOString\(\), files/.test(inst), "install.js manifest에 배포 세대(version) 기록");
  ok((src.match(/version: mVer, ts: new Date\(\)\.toISOString\(\), files/g) || []).length === 1, "확장 manifest에도 동일 규약으로 세대 기록");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
