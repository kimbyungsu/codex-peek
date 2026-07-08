/*
 * scripts/scope-ledger-backfill.js — 관측 장부 씨앗 백필(점화기) 동작 테스트.
 * 배경(2026-07-08 실사고): proposed 적재 코드 도입 전에 만들어진 지도들의 후보가 장부에 없어 이벤트 0건.
 * 계약: ①러너와 같은 파서(extractMapPatches — 위생 필터 포함) ②repo는 지도 메타에서(불명이면 skip+보고)
 *      ③재실행 멱등(같은 sig 중복 적재 없음) ④--dry는 아무것도 안 씀.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-"));
process.env.CODEX_BRIDGE_HOME = tmpHome;
const store = require(path.join(__dirname, "..", "scripts", "scout-store.js"));
const lib = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-repo-"));
const MAP = ["⑥ MAP patch 후보", "- src/a.ts ↔ docs/MAP.md — 스키마 동기화 결합", "- yaml", "- proofs/ 쓰기 ↔ verify-guard 읽기 — 검증 증명 채널"].join("\n");
store.saveMap(repo, "self", MAP, {});                 // repo는 saveMap이 메타에 자동 기록
store.saveMap(repo, "deepseek", MAP, {});             // 다른 지도, 같은 후보 → 중복 스킵 대상
// repo 불명 지도 재현: 메타에서 repo 제거
const dir = path.join(store.SCOUTS_DIR, store.wsKeyFor(repo));
const anyMeta = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()[0];
const m0 = JSON.parse(fs.readFileSync(path.join(dir, anyMeta), "utf8"));
const orphanDir = path.join(store.SCOUTS_DIR, "0000000000000000");
fs.mkdirSync(orphanDir, { recursive: true });
fs.writeFileSync(path.join(orphanDir, "x.md"), MAP);
fs.writeFileSync(path.join(orphanDir, "x.json"), JSON.stringify({ ts: m0.ts, arm: "self" })); // repo 없음

const CLI = path.join(__dirname, "..", "scripts", "scope-ledger-backfill.js");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmpHome } });
const eventsFile = path.join(tmpHome, "map-ledger-events", store.wsKeyFor(repo) + ".jsonl");

console.log("[--dry] 미적재 미리보기 — 파일 생성 없음");
const dry = run("--dry");
ok(dry.status === 0 && /dry — 미적재/.test(dry.stdout), "dry 실행·표기");
ok(!fs.existsSync(eventsFile), "dry는 장부 파일을 만들지 않음");

console.log("[적재] 위생 필터 통과분만 proposed로, 지도 간 같은 후보는 1회");
const r1 = run();
ok(r1.status === 0 && /적재 2건/.test(r1.stdout), `두 지도 합산 유효 후보 2건(yaml 탈락·지도 간 중복 1회) — 실제: ${(r1.stdout.match(/적재 \d+건/) || [])[0]}`);
ok(/repo 불명 스킵 1장/.test(r1.stdout), "메타에 repo 없는 지도는 skip + 사유 보고");
const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(lines.length === 2 && lines.every((e) => e.type === "proposed" && /^backfill /.test(e.from)), "이벤트 형식: type=proposed·from=backfill <지도명>");
ok(!lines.some((e) => e.text === "yaml"), "무경로 부스러기('yaml')는 씨앗이 안 됨(파서 위생 공유)");

console.log("[멱등] 재실행 — 중복 0 적재");
const r2 = run();
ok(/적재 0건/.test(r2.stdout) && /중복 스킵 4건/.test(r2.stdout), "같은 sig는 재적재 없음(재실행 안전 — 두 지도 2건씩 전부 스킵)");
ok(fs.readFileSync(eventsFile, "utf8").trim().split("\n").length === 2, "장부 줄 수 불변");

console.log("[점화 확인] 백필된 씨앗이 confirmed 자동 적재의 전제(비어있지 않은 장부)를 채움");
ok(String(lib.readLedgerEventsText(repo)).trim().length > 0, "readLedgerEventsText가 비어있지 않음 — 공회전 해소");

try { fs.rmSync(tmpHome, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
