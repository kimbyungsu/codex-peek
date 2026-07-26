"use strict";
/*
 * 정찰 대상 어긋남 자기진단(구조 해법 2026-07-10) — 세션 폴더≠개발 레포일 때 scoutRepo 미설정이면 정찰 축이
 * 조용히 엉뚱한 폴더를 보던 실사고의 재발 방지. 임시처방(이 PC 설정)·고지-only가 아니라: 증거 수집(검증 인용의
 * git 레포 귀속) → 보수 판정 → 자동 지시(에이전트가 스스로 교정) + 대시보드 행동 카드 + 게이트 문구 교정.
 * 신선도 사각(seed 8개만 감시 — 대상을 바로잡아도 seed 밖 변경엔 영영 침묵) 해소도 같은 묶음.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));

const ws = path.join(dir, "session-folder"); // 세션 폴더(비-git — 실사고 재현)
const devRepo = path.join(dir, "dev-repo");  // 실제 개발 레포
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(devRepo, { recursive: true });

console.log("[1] 증거 링버퍼 — 최근 10건만·무효 거부·실패 무해");
ok(CL.appendScoutTargetEvidence(ws, null) === false && CL.appendScoutTargetEvidence(ws, { ts: "t", repos: [] }) === false, "무효 관측 거부");
for (let i = 0; i < 13; i++) CL.appendScoutTargetEvidence(ws, { ts: "t" + i, repos: [{ repo: devRepo, n: 2 }] });
const ev1 = CL.readScoutTargetEvidence(ws);
ok(ev1.obs.length === CL.EVIDENCE_KEEP && ev1.obs[0].ts === "t3", `링버퍼 ${CL.EVIDENCE_KEEP}건 유지(옛 관측 탈락 — 실제 ${ev1.obs.length}·첫=${ev1.obs[0].ts})`);

console.log("[2] 판정(순수·보수) — 표본<3 침묵·70% 경계·대상 일치 침묵·소멸 레포 침묵");
const mk = (n, repo) => ({ obs: Array.from({ length: n }, (_, i) => ({ ts: "t" + i, repos: [{ repo, n: 2 }] })) });
ok(CL.detectScoutTargetDrift(ws, mk(2, devRepo)).drift === false, "관측 2건 → 침묵(표본 무주장 원칙과 동형)");
ok(CL.detectScoutTargetDrift(ws, mk(3, devRepo)).drift === true, "관측 3건 전부 다른 레포 → 검출");
const mixed = { obs: [...mk(2, devRepo).obs, { ts: "x", repos: [{ repo: ws, n: 5 }] }] }; // 2/3=0.66 < 0.7
ok(CL.detectScoutTargetDrift(ws, mixed).drift === false, "2/3(66%) → 침묵(70% 경계)");
ok(CL.detectScoutTargetDrift(devRepo, mk(5, devRepo)).drift === false, "증거가 현재 대상과 일치 → 침묵");
ok(CL.detectScoutTargetDrift(ws, mk(5, path.join(dir, "ghost"))).drift === false, "제안 레포가 사라짐 → 침묵(cry-wolf 방지)");
const det = CL.detectScoutTargetDrift(ws, mk(4, devRepo));
ok(det.drift && det.repo === devRepo && det.sample === 4 && det.agree === 4, "검출 결과에 표본·동의 수 포함(문구 재료)");
// 공동 1위(동률) 관측은 모호 → 관측째 제외(Codex 반례: 현재 1+타 1 동률 3회가 점유 100%로 오판되던 것)
const tie = { obs: Array.from({ length: 3 }, (_, i) => ({ ts: "t" + i, repos: [{ repo: devRepo, n: 1 }, { repo: ws, n: 1 }] })) };
ok(CL.detectScoutTargetDrift(ws, tie).drift === false && CL.detectScoutTargetDrift(ws, tie).reason === "sample", "동률 3관측 → 전부 제외돼 표본 미달 침묵(Codex 반례 잠금)");
// git 정체성 비교(Codex 반례: 대상=worktree 하위 폴더·모노레포 중첩 저장소)
ok(CL.detectScoutTargetDrift(path.join(devRepo, "bridge"), mk(4, devRepo), { targetRoot: devRepo }).drift === false, "대상이 같은 저장소의 하위 폴더 → 일치(경로 문자열이 아니라 git root 비교)");
ok(CL.detectScoutTargetDrift(devRepo, mk(4, path.join(devRepo, "nested-pkg")), { targetRoot: devRepo, existsFn: () => true }).drift === false, "대상 저장소 '안'의 중첩 저장소 인용 → 자동 교정 금지(모노레포 오탐 방지)");

console.log("[3] 자동 지시 — 어긋남이 '신선도보다 우선'(fresh여도 나감 — Codex 설계검증 반례 잠금) + 같은 제안 1회 + set 문법");
// 대상(ws)의 지도를 fresh로 깔아둠(seedFiles 빈 배열 = 최신 형식·변경 없음 → fresh)
const scoutsDir = path.join(dir, "scouts", CL.wsKeyFor(ws));
fs.mkdirSync(scoutsDir, { recursive: true });
fs.writeFileSync(path.join(scoutsDir, "2026-07-09T00-00-00-000Z-00-self.md"), "① 후보\n- x.md — high (지도)");
fs.writeFileSync(path.join(scoutsDir, "2026-07-09T00-00-00-000Z-00-self.json"), JSON.stringify({ ts: new Date(Date.now() + 60_000).toISOString(), arm: "self", seedFiles: [] }));
ok(CL.scoutMapStatus(ws).state === "fresh", "전제: 대상(세션 폴더) 지도는 fresh");
const c3 = { scoutMode: "on" };
const d1 = CL.buildScoutDirective(ws, c3);
ok(!!d1 && /대상 어긋남 의심/.test(d1), "fresh인데도 어긋남 지시가 나감(조기 반환보다 우선)");
ok(d1.includes(`scope-target.js "${ws}" set "${devRepo}"`), "지시 명령이 실제 CLI 문법(set) — 잘못된 문법이면 자기교정 중심 명령이 실패(Codex 반례 잠금)");
ok(d1.includes(`scope-scout-self.js "${devRepo}"`) && /언어 슬롯/.test(d1), "후속 지도 명령은 '의심 레포' 기준 + 언어 슬롯 저장 효과 명시(무동의 자동 쓰기와 구분)");
ok(CL.buildScoutDirective(ws, c3) === null, "같은 제안 두 번째 → 침묵(1회 규칙 — 스팸 방지)");
const ev2 = CL.readScoutTargetEvidence(ws);
ok(ev2.advisedKeys && Object.keys(ev2.advisedKeys).length === 1 && Object.keys(ev2.advisedKeys)[0].split("|").length === 3, "제안 기억 키=언어|현재 대상|제안 대상(언어 슬롯 전환 시 영구 침묵 — Codex 라이브 반례 잠금)");
// ★언어 슬롯 전환 실행 재현(Codex 라이브 반례): 같은 ws·같은 증거에서 언어만 en으로 바꾸면 다시 1회 제안
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "en" }));
const dEn = CL.buildScoutDirective(ws, c3);
ok(!!dEn && /target mismatch suspected/.test(dEn), "언어 전환(ko→en) → 같은 제안이라도 키가 달라 재발화(영구 침묵 반례 잠금)");
const evEn = CL.readScoutTargetEvidence(ws);
ok(Object.keys(evEn.advisedKeys || {}).length === 2 && !("advisedRepo" in evEn), "advisedKeys 2건(ko·en)+구형 advisedRepo 필드는 쓰기 시 제거");
ok(CL.buildScoutDirective(ws, c3) === null, "en에서도 두 번째는 침묵(언어별 1회)");
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "ko" })); // 이후 케이스는 ko 문구 기준
// 상한 20키 행동 — 21개째 제안이 기록되면 가장 오래된 키가 정리되고, 관측 append도 구형 필드를 정리
{
  const f = CL.scoutEvidenceFileFor(ws);
  const cur = JSON.parse(fs.readFileSync(f, "utf8"));
  const many = {}; for (let i = 0; i < 20; i++) many["ko|t" + i + "|r" + i] = new Date(1000 + i).toISOString();
  fs.writeFileSync(f, JSON.stringify({ ...cur, advisedKeys: many, advisedRepo: "legacy", advisedTs: "t" }));
  CL.buildScoutDirective(ws, c3); // 새 제안 침묵 여부와 무관 — ko 키는 이미 있어 침묵. en으로 다시 발화시켜 21개째 기록
  fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "en" }));
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), advisedKeys: many })); // en 키 제거 상태로 재구성
  CL.buildScoutDirective(ws, c3); // en 제안 1회 → 21개째 키 기록 → 상한 정리
  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  ok(Object.keys(after.advisedKeys).length === 20 && !("ko|t0|r0" in after.advisedKeys), "제안 기억 상한 20키 — 가장 오래된 키부터 정리(행동 테스트, Codex 보완)");
  ok(!("advisedRepo" in after) && !("advisedTs" in after), "구형 단일 기억 필드는 쓰기 시 정리");
  CL.appendScoutTargetEvidence(ws, { ts: "tX", repos: [{ repo: devRepo, n: 1 }] });
  const after2 = JSON.parse(fs.readFileSync(f, "utf8"));
  ok(!("advisedRepo" in after2), "관측 append 경로도 구형 필드 정리(제안 재발 없는 프로젝트 영구 잔존 반례 잠금)");
  fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "ko" }));
}
const d1b = CL.buildScoutDirective(path.join(dir, "other-target-ws"), { scoutMode: "on" }); // 다른 ws는 증거 없음 — 어긋남 지시가 안 나가는지 확인
ok(!!d1b && !/대상 어긋남/.test(d1b), "증거 없는 ws는 어긋남 지시 없이 기존 신선도 지시(no-map)만");

console.log("[4] 신선도 사각 해소 — 지도 메타 head 이후 새 커밋·seed 밖 작업트리 변경이 stale 신호(비-git 무회귀)");
const g = (args, cwd) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", windowsHide: true });
g(["init"], devRepo);
fs.writeFileSync(path.join(devRepo, "seed-file-a.txt"), "a");
g(["add", "-A"], devRepo); g(["commit", "-m", "c1"], devRepo);
const head1 = String(g(["rev-parse", "HEAD"], devRepo).stdout).trim();
const dScouts = path.join(dir, "scouts", CL.wsKeyFor(devRepo));
fs.mkdirSync(dScouts, { recursive: true });
const past = new Date(Date.now() - 60_000).toISOString(); // 지도가 1분 전 생성됐다고 기록(이후 변경이 신호로 잡히게)
fs.writeFileSync(path.join(dScouts, "2026-07-09T00-00-01-000Z-00-self.md"), "① 후보\n- x.md — high (지도)");
fs.writeFileSync(path.join(dScouts, "2026-07-09T00-00-01-000Z-00-self.json"), JSON.stringify({ ts: past, arm: "self", seedFiles: ["seed-file-a.txt", "already-gone.txt"], seedMissing: ["already-gone.txt"], head: head1 })); // seedMissing=생성 당시 이미 없던 seed(삭제 diff — Codex 반례: 이걸 기준선 없이 세면 새 지도가 즉시 stale)
fs.writeFileSync(path.join(devRepo, "not-a-seed.txt"), "b"); // seed 밖 새 파일(작업트리 신호)
g(["add", "-A"], devRepo); g(["commit", "-m", "c2"], devRepo); // head 이후 커밋 1(커밋 신호)
fs.writeFileSync(path.join(devRepo, "untracked-later.txt"), "c"); // dirty(untracked)
const st4 = CL.scoutMapStatus(devRepo);
ok(st4.state === "stale" && st4.commitsAfter >= 1, `head 이후 커밋 → stale(commitsAfter=${st4.commitsAfter})`);
ok(st4.dirtyChanged >= 1, `seed 밖 작업트리 변경도 신호(dirtyChanged=${st4.dirtyChanged}) — 'seed 8개만 감시' 사각 해소`);
ok(st4.staleCount === st4.seedChanged + st4.commitsAfter + st4.dirtyChanged, "staleCount = 세 신호의 합(의미 분리 — Codex 보완)");
ok(CL.scoutMapStatus(ws).state === "fresh", "비-git 대상은 기존 seed 기준 그대로(무회귀·fail-open)");
// 삭제 변경(Codex 반례: 지도 후 tracked 파일 하나만 지우고 미커밋이면 모든 신호 0 → fresh 오판이던 것)
fs.unlinkSync(path.join(devRepo, "seed-file-a.txt")); // seed 삭제(지도 당시 존재 기록)
const st4b = CL.scoutMapStatus(devRepo);
ok(st4b.seedChanged >= 1, `당시 존재했던 seed의 소실 = 변경 신호(seedChanged=${st4b.seedChanged}) — 삭제만으로도 stale`);
ok(st4.seedChanged === 1, "생성 당시 이미 없던 seed(already-gone.txt)는 기준선(seedMissing) 덕에 신호 아님(mtime 갱신된 seed 1건만 — 기준선 없었으면 2) — 새 지도 즉시 stale 오탐 차단(Codex 반례 잠금)");
g(["add", "-A"], devRepo); g(["commit", "-m", "c3"], devRepo);
fs.unlinkSync(path.join(devRepo, "not-a-seed.txt")); // seed 밖 tracked 파일 삭제(미커밋 — porcelain 'D')
const st4c = CL.scoutMapStatus(devRepo);
ok(st4c.dirtyChanged >= 1, `seed 밖 tracked 삭제(미커밋)도 상태 코드 D로 신호(dirtyChanged=${st4c.dirtyChanged}) — mtime 없는 변경`);

console.log("[5] 게이트 — 어긋남 의심이면 '엉뚱한 레포 지도를 만들라'고 안내하지 않음(대상 지정 먼저)");
const HOOK = path.join(__dirname, "..", "bridge", "scout-gate.js");
const ws5 = path.join(dir, "gate-ws");
fs.mkdirSync(ws5, { recursive: true });
fs.mkdirSync(path.dirname(CL.contractFileFor(ws5)), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws5), JSON.stringify({ scoutMode: "on" })); // 3트랙(게이트 기본 plan) + 지도 없음
for (let i = 0; i < 3; i++) CL.appendScoutTargetEvidence(ws5, { ts: "t" + i, repos: [{ repo: devRepo, n: 2 }] });
const r5 = spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ tool_name: "ExitPlanMode", tool_input: { plan: "..." }, session_id: "sess-D", cwd: ws5 }),
  encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: ws5 },
});
ok(r5.status === 2 && /대상 어긋남 의심/.test(r5.stderr) && r5.stderr.includes(`set "${devRepo}"`), "차단 문구에 '대상 지정 먼저'+set 문법");
ok(r5.stderr.includes(`scope-scout-self.js "${devRepo}"`) && !r5.stderr.includes(`scope-scout-self.js "${ws5}"`), "지도 명령이 의심 레포 기준(엉뚱한 레포 안내 금지 — Codex 반례 잠금)");

console.log("[6] 수집 배선·동형·문서 — 소스 계약");
const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
ok(/function collectScoutTargetEvidence/.test(bridgeSrc) && (bridgeSrc.match(/collectScoutTargetEvidence\(answer, ws, exec\)/g) || []).length === 3, "ask 3분기 전부에서 증거 수집(성공 resume·새 세션·id 미식별)");
ok(/scoutMode !== "on"\) return;/.test(bridgeSrc.slice(bridgeSrc.indexOf("function collectScoutTargetEvidence"), bridgeSrc.indexOf("function collectScoutTargetEvidence") + 800)), "2트랙은 수집 0(무회귀)");
ok(/resolveCitedPath\(m\[1\], execCwd \|\| ws\)/.test(bridgeSrc), "인용 해석은 execCwd 기준(세션 폴더 기준이면 어긋난 상황에서 증거가 빈 값 — Codex 반례 잠금)");
ok(/rev-parse", "--show-toplevel"/.test(bridgeSrc), "git root 귀속(레포 단위 증거)");
const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/function detectScoutTargetDriftExt/.test(extSrc) && /DRIFT_MIN_OBS = 3, DRIFT_SHARE = 0\.7/.test(extSrc), "확장 동형 판정(상수 동일 — 3카피 규약)");
ok(/정찰 대상: \(미지정 — 이 폴더 기준\)/.test(extSrc), "대상 '상시' 표시 — 미지정 침묵 해소(differs일 때만 보이던 실사고 원인)");
ok(/setScoutTarget/.test(extSrc) && /setScoutTargetFromUi/.test(extSrc) && !/saveContract\(ws, \{ \.\.\..*scoutRepo/.test(extSrc), "원클릭 설정은 전용 경로(setScoutTargetFromUi) — saveContract 스키마 오염 금지(Codex 권고)");
ok(/정찰 대상 확인 — 이 폴더/.test(extSrc) && /showOpenDialog/.test(extSrc), "3트랙 켜는 순간 대상 확인 스텝(발원지 차단)");
ok(/head: \(pkg\.meta && pkg\.meta\.head\) \|\| ""/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", "scout-providers.js"), "utf8")), "공통 파이프라인(P5)이 메타에 head 기록(커밋 신호 재료)");
ok(/runScout\(repo, "self"/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-self.js"), "utf8")) && /runScout\(repo, "deepseek"/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-scout-deepseek.js"), "utf8")), "러너 2종 runScout 위임(패리티는 구조 보장)");
const priv = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
ok(/scout-target-evidence/.test(priv) && /제안 이력 키/.test(priv) && /최근 20키/.test(priv), "PRIVACY에 새 로컬 저장소 명시 — 실제 저장 필드(advisedKeys 언어·대상별 이력·상한 20)와 일치(Codex 반례: 과소 고지→구조 변경 반영)");
ok(/asks-inflight/.test(priv), "PRIVACY에 중복 전송 차단 표식 파일 명시(지문·시각·pid만)");

console.log("[7] 같은 요청 중복 전송 차단(2026-07-10 실사고 — 원인미상 비정상 종료를 실패로 오판 재전송→동일 요청 중복 실행[실측: 같은 해시 2건])");
const rec = { hash: "abcd", ts: new Date().toISOString(), pid: process.pid };
ok(CL.askInflightGuard(null, "abcd", Date.now(), () => true).block === false, "표식 없음 → 통과");
ok(CL.askInflightGuard(rec, "efgh", Date.now(), () => true).block === false, "다른 내용 지문 → 통과");
ok(CL.askInflightGuard(rec, "abcd", Date.now(), () => true).block === true, "같은 내용+프로세스 생존 → 차단(재전송 거부)");
ok(CL.askInflightGuard(rec, "abcd", Date.now(), () => false).block === false && CL.askInflightGuard(rec, "abcd", Date.now(), () => false).reason === "dead", "같은 내용이지만 프로세스 사망 → 통과(진짜 실패 후 재시도 허용)");
ok(CL.askInflightGuard({ ...rec, ts: new Date(Date.now() - 91 * 60 * 1000).toISOString() }, "abcd", Date.now(), () => true).block === false, "TTL(90분 — 검증 대기 최대 60분보다 큼·pid 생존이 1차) 초과만 보조 통과(Codex 반례: 30분이면 정상 장기 검증 후반 무방비)");
// A→B→A 우회(Codex 반례: ws당 표식 1개면 B가 A를 덮어써 A 재전송이 통과) — 지문별 파일로 차단
const c1 = CL.claimAskInflight(ws, "hashA");
ok(c1.claimed === true, "A 선점(wx 원자 생성)");
ok(CL.claimAskInflight(ws, "hashB").claimed === true, "다른 내용 B는 병렬 선점 허용(파일 분리)");
const c2 = CL.claimAskInflight(ws, "hashA");
ok(c2.claimed === false && CL.askInflightGuard(c2.rec, "hashA", Date.now(), () => true).block === true, "B 이후에도 A 재전송은 차단(A→B→A 우회 봉쇄 — Codex 반례 잠금)");
// 소유 토큰 — 남의 표식은 해제 못 함(먼저 끝난 프로세스가 강행 요청 표식을 지우던 반례)
CL.clearAskInflight(ws, "hashA", "wrong-token");
ok(fs.existsSync(CL.askInflightFileFor(ws, "hashA")), "토큰 불일치 해제 시도 → 표식 유지");
CL.clearAskInflight(ws, "hashA", c1.rec.token);
ok(!fs.existsSync(CL.askInflightFileFor(ws, "hashA")), "자기 토큰 → 해제");
ok(/--force-resend/.test(bridgeSrc) && /claimAskInflight\(ws, promptHash\)/.test(bridgeSrc) && /process\.on\("exit", \(\) => clearAskInflight/.test(bridgeSrc), "브릿지 배선 — wx 선점+의식적 강행 탈출구+자기 표식만 해제(소스 계약)");
ok(/rollout/.test(bridgeSrc.slice(bridgeSrc.indexOf("같은 검증 요청이 이미 진행"), bridgeSrc.indexOf("같은 검증 요청이 이미 진행") + 400)), "차단 문구가 '재전송 말고 rollout/대시보드에서 읽어라'를 안내(행동 지시 — 고지-only 아님)");

for (const f of ["bridge/codex-bridge.js", "bridge/contract-lib.js", "tests/scout-drift.test.js", "docs/HANDOFF.md"]) {
  const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const banned = [["병렬 ", "3중"].join(""), ["자체 시간 상한", "으로 죽"].join("")]; // 조립 — 이 테스트 소스 자신이 스윕에 걸리지 않게
  ok(banned.every((w) => !src.includes(w)), f + " — 사고 서사가 실측(3분29초 원인미상 종료·동일 해시 2건)과 다른 옛 표현 잔재 0(Codex 시간순 반증 잠금)");
}

console.log("[8] 죽은 표식 회수 — 잠금 아래 재검증(늦은 회수자가 승자의 새 표식을 지우던 TOCTOU — Codex 반례)");
const deadRec = { hash: "hashD", ts: new Date().toISOString(), pid: 999999999, token: "deadtok" };
fs.writeFileSync(CL.askInflightFileFor(ws, "hashD"), JSON.stringify(deadRec));
const rA = CL.reclaimAskInflight(ws, "hashD", deadRec);
ok(rA.claimed === true, "죽은 표식 관측자 → 잠금 회수·wx 재선점 성공");
const rB = CL.reclaimAskInflight(ws, "hashD", deadRec);
ok(rB.claimed === false && rB.reason === "changed", "늦은 회수자(같은 옛 관측) → 승자의 새 표식 보존(changed)");
ok(JSON.parse(fs.readFileSync(CL.askInflightFileFor(ws, "hashD"), "utf8")).token === rA.rec.token, "표식은 첫 승자 것 그대로(제3 선점자 보존 규칙 동일 경로)");
fs.writeFileSync(CL.askInflightFileFor(ws, "hashE"), JSON.stringify(deadRec));
fs.writeFileSync(CL.askInflightFileFor(ws, "hashE") + ".reclaim", JSON.stringify({ pid: process.pid, token: "othertok", ts: new Date().toISOString() }));
ok(CL.reclaimAskInflight(ws, "hashE", deadRec).reason === "lock-busy", "회수 잠금 경합 → 보수적 중단(호출부가 차단 — 동시 회수 중복 실행 봉쇄)");
// 잔존 잠금은 나이·pid와 무관하게 자동 해제하지 않음(Codex 반례: 동시 강제 해제가 서로의 새 잠금을 지워
// 임계 구역 이중 진입 — 평면 fs에 원자적 소유권 이전 없음 → 보수 차단, 탈출구는 --force-resend·수동 삭제)
const oldLock = CL.askInflightFileFor(ws, "hashE") + ".reclaim";
const tOld = new Date(Date.now() - 120 * 1000);
fs.utimesSync(oldLock, tOld, tOld);
ok(CL.reclaimAskInflight(ws, "hashE", deadRec).reason === "lock-busy", "낡은 잠금도 자동 해제 없이 차단(동시 회수 이중 진입 봉쇄 — Codex 반례 잠금)");
const ovr = CL.overwriteAskInflight(ws, "hashE"); // 강행 탈출구는 잠금 미경유
ok(!!ovr.token && JSON.parse(fs.readFileSync(CL.askInflightFileFor(ws, "hashE"), "utf8")).token === ovr.token, "--force-resend 경로(overwrite)는 잠금과 무관하게 선점(잔존 잠금의 탈출구)");
fs.unlinkSync(oldLock);
// 표식 판독 실패는 fail-closed — 디렉터리로 바꿔 EISDIR 유발(ENOENT 아님)
fs.unlinkSync(CL.askInflightFileFor(ws, "hashE"));
fs.mkdirSync(CL.askInflightFileFor(ws, "hashE"));
const rU = CL.reclaimAskInflight(ws, "hashE", deadRec);
ok(rU.claimed === false && rU.reason === "unreadable" && fs.existsSync(CL.askInflightFileFor(ws, "hashE")), "표식 판독 실패(비ENOENT) → 회수 중단·표식 보존(fail-closed — EACCES류를 삭제·재선점하던 Codex 반례 잠금)");
fs.rmdirSync(CL.askInflightFileFor(ws, "hashE"));
const junk = path.join(CL.ASKS_INFLIGHT_DIR, "zz-half-written.json");
fs.writeFileSync(junk, "{half");
CL.claimAskInflight(ws, "hashF");
ok(fs.existsSync(junk), "최신(쓰는 중일 수 있는) 판독불가 형제는 청소가 보존(mtime<TTL — Codex 반례)");
const oldT = new Date(Date.now() - 95 * 60 * 1000);
fs.utimesSync(junk, oldT, oldT);
CL.claimAskInflight(ws, "hashG");
ok(!fs.existsSync(junk), "TTL 지난 판독불가 형제만 청소");

console.log("[9] 기준 시점 계약 — 기준선은 수집기가 seed '확정 직후' 캡처·ENOENT만 없음·러너는 전달만(소스 계약)");
const pkgSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8");
ok(/function captureSeedBaseline/.test(pkgSrc) && /ENOENT/.test(pkgSrc), "수집기에 기준선 캡처 함수(ENOENT만 '없음'·그 외 오류=seedMissing만 생략)");
ok((pkgSrc.match(/= captureSeedBaseline\(repo, /g) || []).length === 2, "git·무이력 두 경로 모두 seed 확정 직후 캡처(러너 사후 재조사는 수집~응답 사이 삭제를 오분류 — Codex 반례)");
ok(pkgSrc.indexOf("captureSeedBaseline(repo, seeds)") < pkgSrc.indexOf('git(["diff"])'), "git 경로 — 캡처가 diff/grep/log 수집보다 앞");
for (const rp of ["scripts/scout-providers.js", "scripts/scope-scout-self.js", "scripts/scope-scout-deepseek.js"]) {
  const rs = fs.readFileSync(path.join(__dirname, "..", rp), "utf8");
  ok((rp !== "scripts/scout-providers.js" || /pkg\.meta\.basisTs/.test(rs)) && !/new Date\(\)\.toISOString\(\), seedMissing/.test(rs), rp + " — 기준선은 수집기 것 전달만(자체 재조사 금지 — P5: 전달은 공통층 한 곳)");
}
// 기준선 캡처 오류 — basisTs는 항상 반환(삭제 판정만 불가). 파일을 디렉터리처럼 참조해 ENOTDIR 유발
const SP = require(path.join(__dirname, "..", "scripts", "scope-package.js"));
const okB = SP.captureSeedBaseline(devRepo, ["untracked-later.txt"]);
ok(typeof okB.basisTs === "string" && Array.isArray(okB.seedMissing), "정상 캡처 — basisTs+seedMissing");
const badB = SP.captureSeedBaseline(devRepo, [12345]); // 비문자열 seed → path.join TypeError(비ENOENT 오류의 결정적 재현 — Windows는 ENOTDIR가 ENOENT로 매핑됨)
ok(typeof badB.basisTs === "string" && !("seedMissing" in badB), "stat 오류(비ENOENT) → seedMissing만 생략·basisTs는 유지(시각까지 버리면 저장 시각 폴백=false-fresh — Codex 반례 잠금)");
// 신선도가 basisTs를 우선 사용(저장 시각 ts가 미래여도 수집 시점 기준으로 stale)
fs.writeFileSync(path.join(dScouts, "2026-07-09T00-00-02-000Z-00-self.md"), "① 후보\n- x.md — high (지도B)");
fs.writeFileSync(path.join(dScouts, "2026-07-09T00-00-02-000Z-00-self.json"), JSON.stringify({ ts: new Date(Date.now() + 3600 * 1000).toISOString(), basisTs: past, arm: "self", seedFiles: ["untracked-later.txt"], seedMissing: [] }));
const stB = CL.scoutMapStatus(devRepo);
ok(stB.state === "stale" && stB.seedChanged >= 1, "mtime 비교 기준=basisTs(지도가 본 입력 시점) — 저장 시각 ts로는 fresh였을 케이스가 stale(Codex 반례 잠금)");

console.log("[10] Codex 런타임 주입 블록 필터 — recommended_plugins 노출 실사고(2026-07-10 사용자 발견) 잠금");
const extFilterSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const brFilterSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
for (const [nm, src] of [["extension isInjected", extFilterSrc], ["bridge 주제 필터", brFilterSrc]]) {
  const m = src.match(/\^<\(environment_context\|[^/]*\//); // 소스에서 실제 정규식 본문 추출 → '실행'으로 검증(존재 검사만으론 회귀 못 잡음 — Codex 보완)
  ok(!!m, nm + " — 필터 정규식 존재");
  const re = new RegExp(m[0].slice(0, -1), "i");
  ok(re.test("<recommended_plugins>\nHere is a list…</recommended_plugins><environment_context>…"), nm + " — Codex 런타임 결합 블록(추천+환경, 사용자가 본 형태) 차단");
  ok(re.test("<environment_context>\n<cwd>D:/x</cwd>"), nm + " — 환경 블록 단독도 차단(기존 동작 유지)");
  ok(!re.test("<recommended_plugins_custom> 태그에 대해 질문"), nm + " — 유사 사용자 문자열 보존(닫는 > 경계 — Codex 보완)");
  ok(!re.test("본문 중간에 <recommended_plugins> 태그를 인용한 정상 발화"), nm + " — 시작 앵커(^) — 본문 중간 인용은 보존");
}

console.log("[11] 논리 점검(2026-07-10) — 선별 자기고정 해소·⑥ 2경로 위생·경로:라인 추출");
const LE2 = require(path.join(__dirname, "..", "out", "ledger-events.js"));
const d11 = LE2.deriveLedger(LE2.parseEventsJsonl([
  JSON.stringify({ ts: "2026-01-01T00:00:00Z", type: "proposed", sig: "s1", text: "src/alpha-file.ts ↔ docs/beta-doc.md" }),
  JSON.stringify({ ts: "2026-01-05T00:00:00Z", type: "attached", sig: "s1" }),
].join("\n")).events);
ok(d11[0].lastTs === "2026-01-01T00:00:00Z" && d11[0].counts.attached === 1, "attached는 lastTs 미갱신 — 선별(최신순)이 자기 선별을 최신으로 만들던 고착 해소(재사용 지표 재료는 유지, 논리 점검 #7)");
ok(CL.ledgerPathsFromText("src/alpha-file.ts:120 ↔ docs/beta-doc.md").length === 2, "경로:라인 표기도 경로로 추출 — ⑥ 위생과 추출기 불일치 해소(논리 점검 #6)");
const p11 = CL.extractMapPatches("⑥ 기억할 결합(MAP patch 후보)\n- src/solo-only-file.ts 는 아주 아주 중요한 파일임\n- src/alpha-file.ts ↔ docs/beta-doc.md — 같이 움직임\n- proofs/ 쓰기 ↔ verify-guard 읽기 — 채널 결합");
ok(p11.length === 2 && /alpha-file/.test(p11[0]) && /verify-guard/.test(p11[1]) && !p11.some((t) => /solo-only-file/.test(t)), "⑥ 위생 — 조각(단일 경로 서술)은 탈락·경로쌍과 채널 결합(↔)은 보존(원문까지 잠금 — 개수만 검사하던 공백 보완, Codex 지적)");
ok(CL.ledgerPathsFromText(p11[0]).length === 2 && CL.ledgerPathsFromText(p11[1]).length === 0, "보존된 채널 결합은 추출 경로 0개 = 자동 확인 불가 — 이 분모 왜곡은 L1(자동확인 가능성 구분 상태)로 잔존함을 정직 기록");
const p11b = CL.extractMapPatches("⑥ 기억할 결합(MAP patch 후보)\n- src/one-file.ts → 중요한 개념 흐름");
ok(p11b.length === 1 && CL.ledgerPathsFromText(p11b[0]).length === 1, "결합 표기+경로 1개 항목도 보존됨(자동 확인 불가 잔존 범위는 경로 0뿐 아니라 <2 전체 — Codex 지적 잠금)");

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
