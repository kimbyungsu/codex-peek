"use strict";
/*
 * P1(정찰 대상 scoutRepo) 테스트 — resolveScoutRepo 해석·폴백, 자동지시/동봉/게이트/confirm의 대상 반영,
 * scope-target CLI(보수적 자동 감지), scope-ledger-migrate(dry·중복 스킵·복사 보존·멱등), 확장 패리티(소스 계약).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st_"));
process.env.CODEX_BRIDGE_HOME = dir;

const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

// 픽스처: ws(비-git 부모) + 그 아래 repo(실제 git 이력 — auto의 usable 판정이 rev-parse 기반이라 진짜 커밋 필요)
const ws = path.join(dir, "parent");
const repo = path.join(ws, "myrepo");
fs.mkdirSync(repo, { recursive: true });
const g = (args, cwd) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
g(["init", "-q"], repo); g(["commit", "-q", "--allow-empty", "-m", "seed"], repo);

console.log("[1] resolveScoutRepo — 지정 없음=ws / 유효 지정=대상 / 무효 지정=ws 폴백(정직 표시)");
ok(CL.resolveScoutRepo(ws, {}).repo === ws && CL.resolveScoutRepo(ws, {}).source === "ws", "지정 없음 → ws");
const r1 = CL.resolveScoutRepo(ws, { scoutRepo: repo });
ok(r1.repo === path.resolve(repo) && r1.source === "contract", "유효 지정 → 대상 절대경로");
const r2 = CL.resolveScoutRepo(ws, { scoutRepo: path.join(ws, "없는폴더") });
ok(r2.repo === ws && r2.source === "ws-fallback-invalid", "무효 지정 → ws 폴백 + 사유 표시");
ok(CL.loadContract(ws).scoutRepo === "", "loadContract 기본값 — 빈 문자열(스키마 정합)");
const rRel = CL.resolveScoutRepo(ws, { scoutRepo: "myrepo" });
ok(rRel.repo === ws && rRel.source === "ws-fallback-invalid", "상대경로 지정 → 무효(프로세스 cwd 기준으로 풀리는 위험 차단 — 절대경로만)");

console.log("[2] 자동지시·동봉·게이트가 대상을 따름 — 지도가 '대상 서랍'에 있으면 ws 서랍이 비어도 인식");
fs.mkdirSync(path.dirname(CL.contractFileFor(ws)), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws), JSON.stringify({ scoutMode: "on", scoutGate: "plan", scoutRepo: repo, codex: [] }));
const repoKey = CL.wsKeyFor(repo);
const mapsDir = path.join(dir, "scouts", repoKey);
fs.mkdirSync(mapsDir, { recursive: true });
fs.writeFileSync(path.join(repo, "seed.js"), "x");
const base = "2026-07-08T00-00-00-000Z-00-self";
fs.writeFileSync(path.join(mapsDir, base + ".md"), "① 직접\n- `src/deep-alpha.ts` (high)");
fs.writeFileSync(path.join(mapsDir, base + ".json"), JSON.stringify({ ts: new Date(Date.now() + 60_000).toISOString(), arm: "self", seedFiles: ["seed.js"], highlights: [{ path: "src/deep-alpha.ts", note: "결합" }] }));
const c = CL.loadContract(ws);
ok(CL.buildScoutDirective(ws, c) === null, "대상 지도가 fresh → 자동지시 침묵(ws 서랍이 비어 있어도 no-map 오판 없음)");
const att = (CL.buildScoutAttach(ws, c, "ko") || {}).text; // v2 envelope 계약 — 본문은 .text
ok(!!att && att.includes("deep-alpha"), "검증 동봉 — 대상 서랍의 지도를 사용");

console.log("[3] scout-gate — 신선도는 대상 기준·지시 명령도 대상 경로·로그에 ws/target 병기");
const HOOK = path.join(__dirname, "..", "bridge", "scout-gate.js");
const runHook = (session) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "ExitPlanMode", tool_input: { plan: "p" }, session_id: session, cwd: ws }), encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws } });
ok(runHook("s1").status === 0, "대상 지도 fresh → 게이트 통과");
fs.writeFileSync(path.join(repo, "seed.js"), "changed-later"); // 대상 seed를 지도 ts 이후로... (지도 ts가 미래라 fresh 유지 — stale 유도 위해 지도 ts를 과거로 교체)
fs.writeFileSync(path.join(mapsDir, base + ".json"), JSON.stringify({ ts: "2020-01-01T00:00:00.000Z", arm: "self", seedFiles: ["seed.js"] }));
const blocked = runHook("s2");
ok(blocked.status === 2 && blocked.stderr.includes(repo), "대상 낡음 → 차단 + 지시 명령이 '대상 레포' 경로");
const gateLog = fs.readFileSync(path.join(dir, "scout-gate-log", CL.wsKeyFor(ws) + ".jsonl"), "utf8");
ok(gateLog.includes('"target"'), "관측 로그에 대상(target) 병기(세션 ws 파일에 기록)");

console.log("[4] confirm 신호 — 대상 장부로 적재(flagLedgerConfirms)");
const CB = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "deep-alpha.ts"), "l1\nl2\n");
fs.writeFileSync(path.join(repo, "src", "deep-beta.ts"), "l1\nl2\n");
const TEXT = "src/deep-alpha.ts ↔ src/deep-beta.ts — 채널";
CL.appendLedgerEvent(repo, { ts: "t", type: "proposed", sig: CL.ledgerSig(TEXT), text: TEXT, from: "테스트" });
CB.flagLedgerConfirms("근거 (src/deep-alpha.ts:1) (src/deep-beta.ts:2)\n검증: 통과", ws, "", repo);
const repoLedger = CL.readLedgerEventsText(repo);
ok(repoLedger.includes('"confirmed"'), "confirmed가 ws가 아니라 '대상' 서랍에 적재");
ok(!CL.readLedgerEventsText(ws).includes('"confirmed"'), "ws 서랍엔 안 쌓임(분산 종결)");

console.log("[5] scope-target CLI — status/set/auto(보수적)/clear");
const TG = path.join(__dirname, "..", "scripts", "scope-target.js");
const runTg = (...a) => spawnSync(process.execPath, [TG, ws, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(/계약 지정/.test(runTg("status").stdout), "status — 지정 표시");
ok(runTg("clear").status === 0 && /세션 폴더 기준으로 복귀/.test(runTg("clear").stdout || "복귀"), "clear — 해제");
const auto1 = runTg("auto");
ok(auto1.status === 0 && /유일 후보 감지/.test(auto1.stdout) && JSON.parse(fs.readFileSync(CL.contractFileFor(ws), "utf8")).scoutRepo === path.resolve(repo), "auto — 직하위 유일 git 루트 자동 지정");
const repo2 = path.join(ws, "repo2");
fs.mkdirSync(repo2, { recursive: true });
g(["init", "-q"], repo2); g(["commit", "-q", "--allow-empty", "-m", "seed"], repo2);
const auto2 = runTg("auto");
ok(auto2.status === 1 && /후보가 2개/.test(auto2.stdout), "auto — 복수 후보면 자동 지정 거부(나열만)");
ok(runTg("set", path.join(ws, "없는폴더")).status === 1, "set — 비존재 경로 거부");
// 실사고 잠금: 세션 폴더에 커밋 0개짜리 빈 .git이 있어도 auto가 '지정 불요'로 오판하지 않는다
fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
const autoEmpty = runTg("auto");
ok(!/지정이 필요 없습니다/.test(autoEmpty.stdout) && /커밋 이력이 없어/.test(autoEmpty.stdout), "빈 .git(이력 0) → 지정 불요 오판 없이 하위 탐색 진행");
// Codex 반례 잠금: ws 자신이 이력 있는 git인데 '기존 지정'이 남아 있으면 — '지정 불요'로 뭉개지 않고 명시 행동 요구
g(["commit", "-q", "--allow-empty", "-m", "seed"], ws); // ws에 이력 부여(위에서 init된 빈 .git에 커밋 추가는 불가하므로 init 재수행)
g(["init", "-q"], ws); g(["commit", "-q", "--allow-empty", "-m", "seed"], ws);
runTg("set", repo); // 기존 지정 존재 상태 재현
const autoStale = runTg("auto");
ok(autoStale.status === 1 && /기존 지정이 남아 있습니다/.test(autoStale.stdout) && /clear/.test(autoStale.stdout), "ws가 이력 있는 git + 기존 지정 잔존 → 현 지정 표시+clear 안내(조용한 유지·오도 금지)");

console.log("[5-1] 언어 슬롯 분리(2026-07-09 사용자 결정) — set/clear는 현재(ko) 슬롯만, en 슬롯 불가침 + 고지");
fs.writeFileSync(CL.contractFileFor(ws, "en"), JSON.stringify({ scoutRepo: "D:/EnOnly/repo" }));
const setKo = runTg("set", repo);
ok(setKo.status === 0 && JSON.parse(fs.readFileSync(CL.contractFileFor(ws, "en"), "utf8")).scoutRepo === "D:/EnOnly/repo", "set — en 슬롯의 다른 지정을 안 건드림(한/영 생활권 분리 · API 키만 전역)");
ok(/ⓘ/.test(setKo.stdout) && /EnOnly/.test(setKo.stdout), "반대 슬롯이 다른 값이면 고지(설정 소실 오해 방지)");
ok(runTg("clear").status === 0 && JSON.parse(fs.readFileSync(CL.contractFileFor(ws, "en"), "utf8")).scoutRepo === "D:/EnOnly/repo", "clear — en 슬롯 보존");
fs.rmSync(CL.contractFileFor(ws, "en")); // 이후 auto/migrate 단계는 en 슬롯 없는 원래 픽스처로
runTg("set", repo); // [6]이 기대하는 지정 상태 복원

console.log("[6] scope-ledger-migrate — dry 미기록·복사 보존·중복 스킵·멱등");
CL.appendLedgerEvent(ws, { ts: "m1", type: "proposed", sig: "mig-a", text: "A ↔ B" });
CL.appendLedgerEvent(ws, { ts: "m2", type: "proposed", sig: "mig-b", text: "C ↔ D" });
const MG = path.join(__dirname, "..", "scripts", "scope-ledger-migrate.js");
const runMg = (...a) => spawnSync(process.execPath, [MG, ws, repo, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
const dry = runMg("--dry");
ok(dry.status === 0 && /복사 예정 2건/.test(dry.stdout) && !CL.readLedgerEventsText(repo).includes("mig-a"), "dry — 수량 보고만, 기록 없음");
ok(runMg().status === 0 && CL.readLedgerEventsText(repo).includes("mig-a"), "실행 — 대상에 복사");
ok(CL.readLedgerEventsText(ws).includes("mig-a"), "원본 보존(삭제 없음 — 감사 추적)");
const again = runMg();
ok(again.status === 0 && /복사 예정 0건 · 중복 스킵 2건/.test(again.stdout), "재실행 — 전부 중복 스킵(멱등)");
CL.appendLedgerEvent(ws, { ts: "m3-다른시각", type: "proposed", sig: "mig-a", text: "A ↔ B" }); // 같은 유형·항목, 시각만 다름
const loose = runMg("--dry");
ok(/1건은 대상에 '같은 유형·같은 항목'이 다른 시각으로/.test(loose.stdout), "시각만 다른 같은 사건 → 카운트 부풀림 정직 고지(회귀 잠금)");

console.log("[7] 확장 패리티(소스 계약) — scoutTargetFor가 resolveScoutRepo와 동일 규칙 + 정찰 판독기들이 대상 사용");
const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/function scoutTargetFor[\s\S]{0,900}ws-fallback-invalid/.test(ext) && /function scoutTargetFor[\s\S]{0,900}contract-other-lang/.test(ext), "scoutTargetFor 존재 + 무효 폴백·언어 슬롯 폴백 규칙 동일(P1-④ 동형)");
for (const fn of ["readScopeState", "readScoutMaps", "readMapLedgerUncached"]) ok(new RegExp(fn + "[\\s\\S]{0,700}scoutTargetFor").test(ext), fn + " — 대상 해석 사용");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
