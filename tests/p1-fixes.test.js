"use strict";
/*
 * P1 묶음(2026-07-10 교차 감사 백로그) — ④언어 슬롯 scoutRepo 폴백 ③recentFailures 소유 ws 귀속
 * ②integrity 동시 쓰기 잠금. 각각 행동 테스트로 잠근다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

console.log("[④] scoutRepo 언어 슬롯 폴백 — ko에만 설정 후 en 전환 시 축이 세션 폴더로 회귀하던 결함");
const ws = path.join(dir, "ws"); const repo = path.join(dir, "repo");
fs.mkdirSync(ws); fs.mkdirSync(repo);
fs.mkdirSync(path.dirname(CL.contractFileFor(ws)), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws), JSON.stringify({ scoutMode: "on", scoutRepo: repo, workspace: ws })); // ko 슬롯에만
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "en" }));
const rEn = CL.resolveScoutRepo(ws, CL.loadContract(ws));
ok(rEn.repo === repo && rEn.source === "contract-other-lang", "en 슬롯이 비면 반대(ko) 슬롯 값 폴백 — 출처 구분(contract-other-lang)");
fs.writeFileSync(CL.contractFileFor(ws, "en"), JSON.stringify({ scoutMode: "on", scoutRepo: ws })); // en 명시값
const rEn2 = CL.resolveScoutRepo(ws, CL.loadContract(ws, "en"));
ok(rEn2.repo === ws && rEn2.source === "contract", "현재 슬롯 명시값이 항상 우선(폴백은 비었을 때만 — 슬롯 분리 원칙 양립)");
fs.unlinkSync(CL.contractFileFor(ws, "en"));
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "ko" }));
const rKo = CL.resolveScoutRepo(ws, CL.loadContract(ws));
ok(rKo.repo === repo && rKo.source === "contract", "ko(설정 슬롯)에서는 기존 동작 그대로(무회귀)");
const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/contract-other-lang/.test(extSrc) && /scoutTargetFor/.test(extSrc), "확장 scoutTargetFor 동형(3카피 규약 — 소스 계약)");

console.log("[③] recentFailures 귀속 — 세션 ws 소유로 기록된 검증 실패가 대상 repo 꾸러미에 실림");
CL.appendIntegrityEvent({ ts: new Date().toISOString(), workspace: ws, kind: "verdict-nonclean", severity: "error", detail: "세션 ws 소유 실패", session: "s1" });
CL.appendIntegrityEvent({ ts: new Date().toISOString(), workspace: path.join(dir, "unrelated"), kind: "verdict-nonclean", severity: "error", detail: "무관 ws 실패", session: "s2" });
const { collectPackage } = require(path.join(__dirname, "..", "scripts", "scope-package.js"));
const pkg = collectPackage(repo); // repo는 비-git → 무이력 모드
ok(!!pkg && Array.isArray(pkg.recentFailures), "무이력 모드 꾸러미 생성");
ok(pkg.recentFailures.some((f) => /세션 ws 소유 실패/.test(f.detail || "")), "계약(scoutRepo)이 이 repo를 가리키는 세션 ws의 실패가 포함(소유 역추적 — 종전엔 0건이던 구멍)");
ok(!pkg.recentFailures.some((f) => /무관 ws 실패/.test(f.detail || "")), "무관 ws의 실패는 여전히 제외(귀속 확장이 무차별 아님)");
// 끝-끝(Codex 반례): CLI set이 workspace를 기록 안 하면 '새 계약' 경로에서 귀속이 여전히 실패 — 실제 CLI로 재현
{
  const ws2 = path.join(dir, "ws2"); const repo2 = path.join(dir, "repo2");
  fs.mkdirSync(ws2); fs.mkdirSync(repo2);
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-target.js"), ws2, "set", repo2], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
  ok(r.status === 0, "scope-target set 성공(끝-끝)");
  CL.appendIntegrityEvent({ ts: new Date().toISOString(), workspace: ws2, kind: "verify-incomplete", severity: "error", detail: "ws2 끝-끝 실패", session: "s3" });
  const pkg2 = collectPackage(repo2);
  ok(pkg2.recentFailures.some((f) => /ws2 끝-끝 실패/.test(f.detail || "")), "CLI set 경로도 workspace 기록 → 귀속 성립(미기록이면 영영 누락 — Codex 반례 잠금)");
}

console.log("[②-0] 잔존 잠금 degraded — 죽은 pid 잠금은 대기·삭제 없이 즉시 진행");
{
  const lockF = path.join(dir, "integrity.json.lock");
  fs.writeFileSync(lockF, "999999999-deadtok"); // 죽은 pid 잠금 잔존 시뮬레이션
  const t0 = Date.now();
  CL.appendIntegrityEvent({ ts: "t", workspace: "w", kind: "verify-incomplete", severity: "error", detail: "degraded-path", session: "d1" });
  const took = Date.now() - t0;
  ok(took < 300, `죽은 pid 잠금 → ~600ms 대기 없이 즉시 진행(실측 ${took}ms — 렌더당 1.2초 지연 반례 잠금)`);
  ok(fs.existsSync(lockF), "잔존 잠금은 삭제하지 않음(상호 삭제 TOCTOU 회피 — 보수 유지)");
  ok(CL.readIntegrityEvents().some((e) => e.detail === "degraded-path"), "무잠금 degraded로도 기록은 됨(fail-open)");
  fs.unlinkSync(lockF);
}
console.log("[②-1] 상속 문구 정합(소스 계약) — '별도 설정' 무조건 단정 잔재 0");
{
  const cl2 = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  const ext2 = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(!/다른 언어 모드는 별도 설정\)/.test(cl2) && /별도 지정이 없으면 이 값을 상속/.test(cl2), "자동 지시 — 상속 규칙과 일치(무조건 '별도 설정' 제거)");
  ok(/다른 명시값이 있어 그대로 유지/.test(ext2) && !/언어 모드는 별도 설정 — 언어별 분리 저장/.test(ext2), "원클릭 토스트 — 반대 슬롯 '명시값 있을 때만' 별도 고지(미설정=상속은 본문이 고지)");
}
console.log("[③-1] 무귀속 이벤트 제외 — workspace 없는 구버전 실패는 어느 꾸러미에도 안 실림");
{
  CL.appendIntegrityEvent({ ts: new Date().toISOString(), kind: "verify-incomplete", severity: "error", detail: "무귀속 실패", session: "s4" });
  const pkg3 = collectPackage(repo);
  ok(!pkg3.recentFailures.some((f) => /무귀속 실패/.test(f.detail || "")), "무귀속 이벤트 제외(타 프로젝트 혼입 방지 — PRIVACY 정합)");
}

console.log("[②] integrity 동시 쓰기 — 두 프로세스 병렬 append에서 유실 '정확히 0'(잠금·전용 홈)");
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "p1lock_")); // 전용 홈 — before=0으로 정확 단언(2건 유실을 허용하던 공백 보완, Codex 지적)
const N = 25;
const workerJs = `
  process.env.CODEX_BRIDGE_HOME = ${JSON.stringify(dir2)};
  const CL = require(${JSON.stringify(path.join(__dirname, "..", "bridge", "contract-lib.js"))});
  const tag = process.argv[1];
  for (let i = 0; i < ${N}; i++) CL.appendIntegrityEvent({ ts: "t", workspace: "w-" + tag, kind: "verify-incomplete", severity: "error", detail: tag + "-" + i, session: "cc-" + tag });
`;
const run = (tag) => new Promise((res) => { const p = spawn(process.execPath, ["-e", workerJs, tag], { stdio: "ignore" }); p.on("close", res); });
Promise.all([run("A"), run("B")]).then(() => {
  const evs = (JSON.parse(fs.readFileSync(path.join(dir2, "integrity.json"), "utf8")).events || []);
  const a = evs.filter((e) => /^A-/.test(e.detail)).length;
  const b = evs.filter((e) => /^B-/.test(e.detail)).length;
  ok(evs.length === 50 && a === 25 && b === 25, `유실 정확히 0 — A=${a}·B=${b}(각 25 필수) — read-modify-write 겹침이면 한쪽 다수 소멸(잠금 검증)`);
  ok(!fs.existsSync(path.join(dir2, "integrity.json.lock")), "잠금 파일은 정상 해제(잔존 0)");
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* 무해 */ }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
});
