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
const { contractFileFor, loadContract, atomicWrite, normScoutGate, loadLang } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const tB = (ko, en) => (loadLang() === "en" ? en : ko); // CLI 출력도 한/영 쌍(2026-07-09)

const repoArg = process.argv[2];
const cmd = process.argv[3] || "status";
if (!repoArg || !["status", "on", "off"].includes(cmd)) {
  console.error(tB("사용: node scripts/scope-gate.js <repo> [status|on|off]","Usage: node scripts/scope-gate.js <repo> [status|on|off]"));
  process.exit(2);
}
const repo = path.resolve(repoArg);

if (cmd === "status") {
  const c = loadContract(repo);
  console.log(`scoutGate: ${normScoutGate(c)} (scoutMode: ${c.scoutMode || "off"})`);
  console.log(normScoutGate(c) === "plan"
    ? tB("→ 플랜 확정 전 지도 preflight 요구(없음/낡음 → 세션당 2회까지 차단 후 통과). 실험 관측 로그: 브릿지 홈 scout-gate-log/","→ requires a map preflight before plan confirmation (missing/stale → blocks up to 2×/session, then passes). Observation log: bridge home scout-gate-log/")
    : tB("→ 게이트 꺼짐 — 훅은 관측 로그만 남기고 아무것도 막지 않음","→ gate off — the hook only logs observations and blocks nothing"));
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
    console.error(tB(`저장 실패: ${f} (권한/디스크?) — 게이트 설정이 반영되지 않았을 수 있음`,`Save failed: ${f} (permission/disk?) — the gate setting may not have been applied`));
    process.exit(1);
  }
  touched++;
}
console.log(tB(`scoutGate=${target} 저장(계약 파일 ${touched}개 갱신). `,`scoutGate=${target} saved (${touched} contract file(s) updated). `) + (target === "plan" ? tB("⚠ 훅은 새 Claude 세션부터 동작 — 실험 절차는 docs/HANDOFF.md ⑥ 참조","⚠ the hook takes effect from the next Claude session — see docs/HANDOFF.md ⑥") : tB("게이트 꺼짐(관측 로그만 유지)","gate off (observation log only)")));
