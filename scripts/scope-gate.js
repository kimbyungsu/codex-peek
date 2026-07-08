/*
 * 탐색 게이트 스위치(로드맵 ⑥ 실험) — 프로젝트 계약의 scoutGate(off|plan)를 켜고 끈다.
 * "plan"이면 scout-gate.js 훅이 플랜 확정 직전에 지도 preflight를 요구(없음/낡음 → 세션당 2회까지 차단).
 * ⚠ 기본 off 이유(정직): 지도 명중률 실측 48.1% < 사전등록 합격선 60% — 강제는 사용자 명시 선택만.
 * 언어 슬롯 분리(2026-07-09 사용자 결정): 한글 모드와 영어 모드는 사실상 다른 사용자 — 설정은 '현재 언어
 * 슬롯'에만 저장한다(규칙·기본지침과 동일 원칙 · API 키만 전역). 반대 슬롯에 다른 값이 있으면 고지만 한다.
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
const lang = loadLang();
const f = contractFileFor(repo, lang); // 현재 언어 슬롯에만 — 언어 슬롯 분리 원칙(2026-07-09)
let o = {};
try { o = JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch { /* 슬롯 파일 없으면 신설 */ }
o.scoutGate = target;
if (!atomicWrite(f, JSON.stringify({ ...o, updatedAt: new Date().toISOString() }, null, 2))) {
  console.error(tB(`저장 실패: ${f} (권한/디스크?) — 게이트 설정이 반영되지 않았을 수 있음`,`Save failed: ${f} (permission/disk?) — the gate setting may not have been applied`));
  process.exit(1);
}
console.log(tB(`scoutGate=${target} 저장(${lang} 언어 슬롯 — 다른 언어 모드는 별도 설정). `,`scoutGate=${target} saved (${lang} language slot — other language modes keep their own setting). `) + (target === "plan" ? tB("⚠ 훅은 새 Claude 세션부터 동작 — 실험 절차는 docs/HANDOFF.md ⑥ 참조","⚠ the hook takes effect from the next Claude session — see docs/HANDOFF.md ⑥") : tB("게이트 꺼짐(관측 로그만 유지)","gate off (observation log only)")));
// 반대 슬롯이 다른 값이면 고지(설정이 '사라진' 게 아니라 언어별로 따로임을 알림 — 소실 오해 방지)
try {
  const other = lang === "ko" ? "en" : "ko";
  const oo = JSON.parse(fs.readFileSync(contractFileFor(repo, other), "utf8"));
  const ov = normScoutGate(oo);
  if (ov !== target) console.log(tB(`ⓘ ${other} 언어 모드의 게이트는 ${ov} 그대로입니다(언어별 분리 저장).`,`ⓘ The ${other}-language gate stays ${ov} (settings are stored per language).`));
} catch { /* 반대 슬롯 없음 — 고지 불요 */ }
