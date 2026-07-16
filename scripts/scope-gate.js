/*
 * 탐색 게이트 스위치 — 프로젝트 계약의 scoutGate(off|plan)를 켜고 끈다.
 * "plan"이면 scout-gate.js 훅이 플랜 확정 직전에 지도 preflight를 요구(없음/낡음 → 세션당 2회까지 차단).
 * 기본 승격(2026-07-09): 3트랙(scoutMode on)은 미설정 기본이 plan — 재실측(관찰 일지 주입) 70.5% > 합격선 60%,
 * 차단 문구에 프로젝트별 관찰 신호 동반. 2트랙은 항상 비활성(명시 plan이 있어도 — 게이트는 지도 전제·무회귀).
 * 언어 슬롯 분리(2026-07-09 사용자 결정): 한글 모드와 영어 모드는 사실상 다른 사용자 — 설정은 '현재 언어
 * 슬롯'에만 저장한다(규칙·기본지침과 동일 원칙 · API 키만 전역). 반대 슬롯에 다른 값이 있으면 고지만 한다.
 *
 * 사용: node scripts/scope-gate.js <repo> [status|on|off]
 */
const fs = require("fs");
const path = require("path");
const { contractFileFor, loadContract, atomicWrite, normScoutGate, normScoutMode, loadLang, withFileLockStrict } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
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
  const eff = normScoutGate(c); // 실효값(3트랙 미설정=plan 승격 · 2트랙=무조건 off)
  let raw; // 저장값 — 실효와 구분해 보여줘야 '기본인지 내가 정했는지'가 안 헷갈림(Codex 지적)
  try { raw = (JSON.parse(fs.readFileSync(contractFileFor(repo, loadLang()), "utf8")) || {}).scoutGate; } catch { /* 슬롯 파일 없음 */ }
  const rawNote = raw === "plan" || raw === "off" ? tB(`명시 ${raw}`, `explicit ${raw}`) : tB("미설정", "not set");
  console.log(`scoutGate: ${eff} (${rawNote} · scoutMode: ${c.scoutMode || "off"})`);
  console.log(eff === "plan"
    ? (raw === "plan"
      ? tB("→ 켜짐(직접 설정) — 플랜 확정 전 지도 preflight 요구(없음/낡음 → 세션당 2회까지 차단 후 통과). 관측 로그: 브릿지 홈 scout-gate-log/","→ on (explicitly set) — requires a map preflight before plan confirmation (missing/stale → blocks up to 2×/session, then passes). Observation log: bridge home scout-gate-log/")
      : tB("→ 켜짐(3트랙 기본 — 재실측 70.5%>60% 승격) — 플랜 확정 전 지도 preflight 요구(세션당 2회까지 차단 후 통과 · 차단 문구에 이 프로젝트의 관찰 신호 동반). 끄기: off","→ on (3-track default — promoted on re-measured 70.5%>60%) — requires a map preflight before plan confirmation (blocks up to 2×/session, then passes · block message carries this project's observation signal). Turn off: off"))
    : (c.scoutMode !== "on"
      ? tB(`→ 비활성(2트랙 — 게이트는 지도 전제라 3트랙에서만 동작${raw === "plan" ? " · 저장된 명시 plan은 3트랙을 켜면 적용됨" : ""})`, `→ inactive (2-track — the gate presupposes maps, so it only runs in 3-track${raw === "plan" ? " · the stored explicit plan applies once 3-track is on" : ""})`)
      : tB("→ 꺼짐(직접 끄심) — 훅은 관측 로그만 남기고 아무것도 막지 않음. 켜기: on","→ off (explicitly turned off) — the hook only logs observations and blocks nothing. Turn on: on")));
  process.exit(0);
}
const target = cmd === "on" ? "plan" : "off";
const lang = loadLang();
const f = contractFileFor(repo, lang); // 현재 언어 슬롯에만 — 언어 슬롯 분리 원칙(2026-07-09)
// [P-9 2차 지적 1] 계약 잠금 프로토콜 참여 + fail-closed(무잠금 RMW가 자동 전환·대시보드 저장을 되돌리고
// 손상 JSON을 {}로 축소 덮어쓰던 경로 차단 — P-1 계열)
try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* 잠금 wx가 ENOENT로 헛돌지 않게 */ }
let o = {};
const wr = withFileLockStrict(f + ".lock", () => {
  try {
    o = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!o || typeof o !== "object" || Array.isArray(o)) return false; // 형식 불명 → 기록 거부
  } catch (e) {
    if (!e || e.code !== "ENOENT") return false; // 손상·판독 불가 → 기록 거부(바이트 보존·복구 기회)
    o = {};
  }
  o.scoutGate = target;
  return atomicWrite(f, JSON.stringify({ ...o, updatedAt: new Date().toISOString() }, null, 2));
});
if (!(wr && wr.ok && wr.result)) {
  console.error(tB(`저장 실패: ${f} (잠금/손상/권한 — .lock 잔존 시 보유 프로세스 종료 확인 후 삭제) — 게이트 설정이 반영되지 않았을 수 있음`,`Save failed: ${f} (lock/corruption/permission — if a stale .lock remains, verify the owner is gone and delete it) — the gate setting may not have been applied`));
  process.exit(1);
}
console.log(tB(`scoutGate=${target} 저장(${lang} 언어 슬롯 — 다른 언어 모드는 별도 설정). `,`scoutGate=${target} saved (${lang} language slot — other language modes keep their own setting). `) + (target === "plan" ? tB("⚠ 훅은 새 Claude 세션부터 동작 — 상세는 docs/HANDOFF.md ⑥ 참조","⚠ the hook takes effect from the next Claude session — see docs/HANDOFF.md ⑥") : tB("게이트 꺼짐(관측 로그만 유지)","gate off (observation log only)")));
if (normScoutMode(o) !== "on") console.log(tB("ⓘ 이 프로젝트는 2트랙(scoutMode off) — 게이트는 지도 전제라 3트랙을 켜기 전까지는 어떤 값이든 비활성입니다.","ⓘ This project is 2-track (scoutMode off) — the gate presupposes maps, so any value stays inactive until 3-track is on."));
// 반대 슬롯이 다른 값이면 고지(설정이 '사라진' 게 아니라 언어별로 따로임을 알림 — 소실 오해 방지)
try {
  const other = lang === "ko" ? "en" : "ko";
  const oo = JSON.parse(fs.readFileSync(contractFileFor(repo, other), "utf8"));
  const ov = normScoutGate(oo);
  if (ov !== target) console.log(tB(`ⓘ ${other} 언어 모드의 게이트는 ${ov} 그대로입니다(언어별 분리 저장).`,`ⓘ The ${other}-language gate stays ${ov} (settings are stored per language).`));
} catch { /* 반대 슬롯 없음 — 고지 불요 */ }
