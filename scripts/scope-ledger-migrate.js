/*
 * 관찰 일지(관측 장부) 이관 CLI(P1) — 세션 폴더 서랍에 잘못 쌓인 이벤트를 정찰 대상 레포 서랍으로 '복사'한다.
 * 원칙(검증모델 합의 2026-07-08): 조용한 병합 금지 — --dry로 원본/대상/이벤트 수/중복을 먼저 보여주고,
 * 실행 시에도 원본은 지우지 않는다(복사·보존 — 감사 추적 유지). 중복(ts+type+sig 동일)은 건너뜀 → 멱등.
 *
 * 사용: node scripts/scope-ledger-migrate.js <fromWs> <toRepo> [--dry]
 */
const fs = require("fs");
const path = require("path");
const { readLedgerEventsText, appendLedgerEvent, ledgerEventsFileFor } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const fromArg = process.argv[2];
const toArg = process.argv[3];
const DRY = process.argv.includes("--dry");
if (!fromArg || !toArg) { console.error("사용: node scripts/scope-ledger-migrate.js <fromWs> <toRepo> [--dry]"); process.exit(2); }
const from = path.resolve(fromArg);
const to = path.resolve(toArg);
if (!fs.existsSync(to) || !fs.statSync(to).isDirectory()) { console.error(`대상이 존재하지 않거나 폴더가 아님: ${to}`); process.exit(1); }

const parse = (raw) => raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
const srcEvents = parse(readLedgerEventsText(from)).filter(Boolean);
if (!srcEvents.length) { console.log(`원본 서랍이 비어 있음: ${ledgerEventsFileFor(from)}`); process.exit(0); }
const dstKeys = new Set(parse(readLedgerEventsText(to)).filter(Boolean).map((e) => `${e.ts}|${e.type}|${e.sig}`));

const dstLoose = new Set(parse(readLedgerEventsText(to)).filter(Boolean).map((e) => `${e.type}|${e.sig}`));
let copy = 0, dup = 0, loose = 0;
const toCopy = [];
for (const e of srcEvents) {
  if (dstKeys.has(`${e.ts}|${e.type}|${e.sig}`)) { dup++; continue; }
  if (dstLoose.has(`${e.type}|${e.sig}`)) loose++; // 시각만 다른 같은 사건 — 복사는 하되 수량을 정직 고지(카운트 부풀림 경고)
  toCopy.push(e); copy++;
}
console.log(`원본: ${ledgerEventsFileFor(from)} (${srcEvents.length}건)`);
console.log(`대상: ${ledgerEventsFileFor(to)}`);
console.log(`복사 예정 ${copy}건 · 중복 스킵 ${dup}건 · 원본은 보존(삭제 없음)`);
if (loose) console.log(`ⓘ 그중 ${loose}건은 대상에 '같은 유형·같은 항목'이 다른 시각으로 이미 있음 — 복사되면 제안/동봉 횟수가 그만큼 늘어남(상태 전이엔 무해·임계 튜닝 때 참고)`);
if (DRY) { console.log("(dry — 아무것도 쓰지 않음)"); process.exit(0); }
let written = 0;
for (const e of toCopy) { if (appendLedgerEvent(to, e)) written++; }
if (written !== copy) { console.error(`⚠ 일부 기록 실패: ${written}/${copy}건만 기록됨(권한/디스크?) — 재실행은 멱등(중복 스킵)이라 안전`); process.exit(1); }
console.log(`완료: ${written}건 복사.`);
