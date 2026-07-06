/*
 * 탐색 게이트 스위치(로드맵 ⑥ 실험) — 프로젝트 계약의 scoutGate(off|plan)를 켜고 끈다.
 * "plan"이면 scout-gate.js 훅이 플랜 확정 직전에 지도 preflight를 요구(없음/낡음 → 세션당 2회까지 차단).
 * ⚠ 기본 off 이유(정직): 지도 명중률 실측 48.1% < 사전등록 합격선 60% — 강제는 사용자 명시 선택만.
 * 언어 슬롯(ko/en) 계약 파일이 둘 다 있으면 둘 다 갱신(한쪽만 바꾸면 언어 전환 시 설정이 사라져 보임).
 *
 * 사용: node scripts/scope-gate.js <repo> [status|on|off]
 */
const fs = require("fs");
const path = require("path");
const { contractFileFor, loadContract, atomicWrite, normScoutGate } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const repoArg = process.argv[2];
const cmd = process.argv[3] || "status";
if (!repoArg || !["status", "on", "off"].includes(cmd)) {
  console.error("사용: node scripts/scope-gate.js <repo> [status|on|off]");
  process.exit(2);
}
const repo = path.resolve(repoArg);

if (cmd === "status") {
  const c = loadContract(repo);
  console.log(`scoutGate: ${normScoutGate(c)} (scoutMode: ${c.scoutMode || "off"})`);
  console.log(normScoutGate(c) === "plan"
    ? "→ 플랜 확정 전 지도 preflight 요구(없음/낡음 → 세션당 2회까지 차단 후 통과). 실험 관측 로그: 브릿지 홈 scout-gate-log/"
    : "→ 게이트 꺼짐 — 훅은 관측 로그만 남기고 아무것도 막지 않음");
  process.exit(0);
}
const target = cmd === "on" ? "plan" : "off";
const files = [contractFileFor(repo, "ko"), contractFileFor(repo, "en")];
let touched = 0;
for (const f of files) {
  let o = null;
  try { o = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* 이 슬롯 파일 없음 */ }
  if (!o) {
    if (f !== files[0]) continue; // en 슬롯은 있을 때만 갱신 — 없는 슬롯을 만들면 언어 전환 로직이 오해
    o = {};
  }
  o.scoutGate = target;
  if (!atomicWrite(f, JSON.stringify({ ...o, updatedAt: new Date().toISOString() }, null, 2))) {
    console.error(`저장 실패: ${f} (권한/디스크?) — 게이트 설정이 반영되지 않았을 수 있음`);
    process.exit(1);
  }
  touched++;
}
console.log(`scoutGate=${target} 저장(계약 파일 ${touched}개 갱신). ${target === "plan" ? "⚠ 훅은 새 Claude 세션부터 동작 — 실험 절차는 docs/HANDOFF.md ⑥ 참조" : "게이트 꺼짐(관측 로그만 유지)"}`);
