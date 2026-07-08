"use strict";
/*
 * CLI·훅 이중언어(한/영 쌍) 잠금 — 2026-07-09 사용자 지적("구현·수정이 전부 한글뿐")의 재발 방지.
 * ① 실행 검증: 전역 언어 en이면 CLI 출력이 영어, 언어 파일 없으면 ko 기본(기존 사용자 무회귀).
 * ② 소스 잠금: 5개 CLI + scout-gate 훅 + buildScoutDirective가 tB/loadLang 한/영 쌍 패턴을 유지.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

// 픽스처: en 브릿지 홈(language.json {lang:"en"}) / ko 브릿지 홈(언어 파일 없음 → 기본 ko)
const homeEn = fs.mkdtempSync(path.join(os.tmpdir(), "bl_en_"));
const homeKo = fs.mkdtempSync(path.join(os.tmpdir(), "bl_ko_"));
fs.writeFileSync(path.join(homeEn, "language.json"), JSON.stringify({ lang: "en" }));
const ws = path.join(homeEn, "ws"); // 비-git 세션 폴더(상태 조회만 하므로 이력 불요)
fs.mkdirSync(ws, { recursive: true });

const run = (home, args) => spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true, cwd: ROOT, env: { ...process.env, CODEX_BRIDGE_HOME: home } });
const cli = (name) => path.join(ROOT, "scripts", name);

console.log("[1] 실행 — 전역 언어 en이면 CLI 출력이 영어(4종)");
const tgt = run(homeEn, [cli("scope-target.js"), ws, "status"]);
ok(tgt.status === 0 && /Scout target:/.test(tgt.stdout) && /not set — session folder as-is/.test(tgt.stdout), "scope-target status → 영어(Scout target · not set)");
ok(/historyless mode/.test(tgt.stdout) && !/정찰 대상/.test(tgt.stdout), "scope-target — git 라벨도 영어·한글 혼입 없음");
const gate = run(homeEn, [cli("scope-gate.js"), ws, "status"]);
ok(gate.status === 0 && /gate off — the hook only logs observations/.test(gate.stdout), "scope-gate status → 영어(gate off)");
const note = run(homeEn, [cli("scope-ledger-note.js"), ws, "list"]);
ok(note.status === 0 && /Journal empty/.test(note.stdout), "scope-ledger-note list → 영어(Journal empty)");
const rec = run(homeEn, [cli("scope-reconcile.js"), ws, "list"]);
ok(rec.status === 0 && /No pending proposals/.test(rec.stdout), "scope-reconcile list → 영어(No pending proposals)");
const mig = run(homeEn, [cli("scope-ledger-migrate.js")]);
ok(mig.status === 2 && /Usage: node scripts\/scope-ledger-migrate\.js/.test(mig.stderr), "scope-ledger-migrate 인자 없음 → 영어 usage");

console.log("[2] 실행 — 언어 파일 없으면 ko 기본(기존 사용자 무회귀)");
const wsKo = path.join(homeKo, "ws");
fs.mkdirSync(wsKo, { recursive: true });
const gateKo = run(homeKo, [cli("scope-gate.js"), wsKo, "status"]);
ok(gateKo.status === 0 && /게이트 꺼짐/.test(gateKo.stdout), "scope-gate status → 한국어 기본(게이트 꺼짐)");
const tgtKo = run(homeKo, [cli("scope-target.js"), wsKo, "status"]);
ok(tgtKo.status === 0 && /정찰 대상:/.test(tgtKo.stdout), "scope-target status → 한국어 기본(정찰 대상)");

console.log("[3] 소스 잠금 — tB/loadLang 한/영 쌍 패턴 유지(문구 단일화 회귀 방지)");
for (const f of ["scope-target.js", "scope-gate.js", "scope-ledger-migrate.js", "scope-ledger-note.js", "scope-reconcile.js", "scope-scout-self.js", "scope-scout-deepseek.js"]) {
  const s = fs.readFileSync(cli(f), "utf8");
  ok(/const tB = \(ko, en\) => \(loadLang\(\) === "en" \? en : ko\)/.test(s) && /loadLang/.test(s), `${f}: tB(ko,en) 헬퍼 + loadLang 연동`);
  const badLines = s.split(/\r?\n/).filter((l) => /(console\.(log|error)|process\.std(out|err)\.write)\(/.test(l) && /[가-힣]/.test(l) && !/tB\(/.test(l));
  ok(badLines.length === 0, `${f}: 출력 호출 줄에 tB 없는 한글 없음(연결·삼항·stderr 포함 — Codex 보완)` + (badLines.length ? " ← " + badLines[0].trim().slice(0, 70) : ""));
}
const sg = fs.readFileSync(path.join(ROOT, "bridge", "scout-gate.js"), "utf8");
ok(/const tB = \(ko, en\)/.test(sg) && /this project has no impact map yet/.test(sg), "scout-gate 훅: tB + 차단 사유 영어 변형");
const sgBad = sg.split(/\r?\n/).filter((l) => /(console\.(log|error)|process\.std(out|err)\.write)\(/.test(l) && /[가-힣]/.test(l) && !/tB\(/.test(l));
ok(sgBad.length === 0, "scout-gate 훅: 출력 호출 줄에 tB 없는 한글 없음(stderr 차단문 포함)" + (sgBad.length ? " ← " + sgBad[0].trim().slice(0, 70) : ""));
const clsrc = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
ok(/const en = loadLang\(\) === "en"/.test(clsrc) && /\[Recon \(3-track\) auto-directive · once per state\]/.test(clsrc), "buildScoutDirective: 자동지시 en 변형(훅 주입문도 언어 준수)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
