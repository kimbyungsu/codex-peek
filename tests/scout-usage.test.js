"use strict";
/*
 * 정찰(3트랙) 비용 투명 기록(2026-07-09 사용자 요구 "토큰·건수로 비용 추정 가능하게") + 상태바 flow 정찰 표시.
 * 감사 확정 결함: 비용 영구 기록 0(지도 10장 프루닝과 운명 공동체)·self 팔 미측정·ping 미기록·flow 모드 표시 전멸.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "su_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const VS = require(path.join(ROOT, "out", "verify-stats.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 비용 장부 — append-only·60일 트림(verdicts 패턴)");
ok(CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "D:/proj", arm: "deepseek", model: "deepseek-v4-flash", usageIn: 1000, usageOut: 200, pkgChars: 5000, mapChars: 900 }) === true, "deepseek 지도 기록 성공");
CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "D:/proj", arm: "self", usageIn: null, usageOut: null, pkgChars: 4000, mapChars: 800 });
CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "ping", model: "deepseek-v4-flash", usageIn: 10, usageOut: 3 });
CL.appendScoutUsage({ ts: new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString(), workspace: "D:/proj", arm: "deepseek", usageIn: 99999, usageOut: 99999 });
CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: "D:/other", arm: "deepseek", usageIn: 777, usageOut: 77 });
const rawLog = fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8");
ok(!rawLog.includes("99999"), "60일 지난 기록은 트림(오래된 비용은 잘림 — 정직 고지 대상)");
ok(CL.appendScoutUsage({ arm: "" }) === false && CL.appendScoutUsage(null) === false, "무효 이벤트 거부");

console.log("[2] 집계(computeScoutCosts) — 프로젝트 필터·ping 전역·팔별 합계·28일");
const costs = VS.computeScoutCosts(fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8"), Date.now(), "D:/proj", (s) => String(s).toLowerCase());
ok(costs.byArm.deepseek && costs.byArm.deepseek.count === 1 && costs.byArm.deepseek.usageIn === 1000 && costs.byArm.deepseek.usageOut === 200, "deepseek — 이 프로젝트 것만(타 프로젝트 777 제외)·실측 토큰 합");
ok(costs.byArm.self && costs.byArm.self.count === 1 && costs.byArm.self.pkgChars === 4000 && costs.byArm.self.mapChars === 800 && costs.byArm.self.usageIn === 0, "self — 문자수만 합산(토큰 null은 0 유지 — 거짓 토큰 안 만듦)");
ok(costs.byArm.ping && costs.byArm.ping.count === 1 && costs.byArm.ping.usageIn === 10, "ping — 프로젝트 무관 전역 포함(3트랙 켤 때 1회 점검)");
ok(costs.total === 3, "28일 총 건수(트림 전 오래된 건·타 프로젝트 제외)");
const empty = VS.computeScoutCosts("", Date.now(), "D:/proj", (s) => s);
ok(empty.total === 0 && Object.keys(empty.byArm).length === 0, "기록 없음 → 빈 집계(0 표시용)");

console.log("[3] 생산자 배선(소스 잠금) — 러너 2종·ping이 실제로 장부에 쓴다");
const selfSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-self.js"), "utf8");
const dsSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-deepseek.js"), "utf8");
const brSrc = fs.readFileSync(path.join(ROOT, "bridge", "deepseek-bridge.js"), "utf8");
ok(/appendScoutUsage\(\{ ts: new Date\(\)\.toISOString\(\), workspace: repo, arm: "deepseek"/.test(dsSrc), "deepseek 러너 — 지도마다 기록(workspace=정찰 대상 레포)");
ok(/appendScoutUsage\(\{ ts: new Date\(\)\.toISOString\(\), workspace: repo, arm: "self"/.test(selfSrc) && /usageIn: null/.test(selfSrc), "self 러너 — 문자수 추정 재료 기록(토큰 null 정직)");
ok(/arm: "ping"/.test(brSrc) && /appendScoutUsage/.test(brSrc), "연결 점검(ping)도 과금 호출로 기록");

console.log("[4] 통계 탭 표시(소스 잠금) — 정찰 비용 구획·정직 각주");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/scoutCostRows/.test(ext) && /정찰\(3트랙\) 비용 — 최근 28일/.test(ext) && /Recon \(3-track\) cost — last 28 days/.test(ext), "통계 탭 '정찰 비용' 구획(한/영)");
ok(/장부는 60일 보존/.test(ext) && !/영구 장부/.test(ext) && /log kept 60 days/.test(ext), "보존 기간 표현 정직 — '영구' 금지(실제 60일 트림과 일치 · Codex 반례 잠금)");
ok(/글자 수'만 기록해요\(토큰 아님/.test(ext) && /not tokens — rough estimation only/.test(ext), "self 팔 정직 각주 — 글자 수는 토큰이 아님·별도 결제 없음");
ok(/readScoutCosts/.test(ext) && /scoutCosts: readScoutCosts\(ws\)/.test(ext) && /scoutTargetFor\(ws\)\.repo/.test(ext), "판독기 — 정찰 대상(P1) 기준 필터로 상태에 실림");
ok(/연결 점검\(3트랙 켤 때 1회·전역\)/.test(ext) && /별도 결제 없음/.test(ext), "행 라벨 — ping 전역·self 무과금 명시");

console.log("[5] 상태바(소스 잠금) — 감사 B 반영: flow 병기·툴팁 분기·게이트·평시 분기·워처");
ok(/const scoutOn = !!ws && \(\(\) => \{ try \{ return loadContract\(ws\)\.scoutMode === "on"; \}/.test(ext), "scoutMode 게이트 일원화 — 2트랙 잔존 live 파일이 정찰 문구 노출 못 함");
ok(/mode === "linked" \|\| mode === "unlinked" \|\| mode === "flow"\) \? readScoutLive\(ws\) : null/.test(ext), "flow 모드에서도 정찰 라이브 읽음(자동 지시 주 경로 — 표시 전멸 해소)");
ok(/const flowScout = scoutLiveNow/.test(ext) && /이 턴 안에서 실행/.test(ext) && /running inside this turn/.test(ext), "flow 3박스 툴팁에 정찰 지도 생성 병기(한/영)");
ok(/scoutLiveNow \? " \$\(telescope\) " \+ tE\("탐색중","scouting"\)/.test(ext) && /·DeepSeek/.test(ext), "flow 화살표에 '탐색중(·DeepSeek)' 글자 라벨 — 아이콘·툴팁만으론 부족(2026-07-09 사용자 정정: 2트랙 작업중/검증중과 같은 시각 문법)");
ok(/const flowLlm = toCodex/.test(ext) && /Claude가 검증 답을 반영 중/.test(ext) && !/fArrow\.tooltip = new vscode\.MarkdownString\(tE\(`\*\*검증 진행 — `,`\*\*verify progress — `\) \+ `\$\{live\.label\}\*\*` \+ `\$\{live\.round \? tE\(` \(라운드 \$\{live\.round\}\)`,` \(round \$\{live\.round\}\)`\) : ""\}` \+ tE\(`\\n\\n⚡ LLM 호출 중: Codex 검증`/.test(ext), "툴팁 LLM 문구 단계별 분기 — 전 단계 'Codex 검증' 단정 제거");
ok(/tE\("지금 실행 중인 LLM 호출 없음", "no LLM call running now"\)/.test(ext), "2트랙 평시 줄 — 정찰 기능(변경 감지·일지) 설명 뗌(사실 아님)");
ok(/fs\.watch\(liveDir, \(\) => scheduleRender\(\)\)/.test(ext), "scout-live 전용 워처 — 생성중 표시 등장·해제 15초 지연 해소");

console.log("[6] 문서 정합(감사 C 반영 잠금)");
const privacy = fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8");
ok(/scout-baseline\.json/.test(privacy) && /scout-live\/<키>\.json/.test(privacy) && /stats\/scout-usage\.jsonl/.test(privacy), "PRIVACY — 새 파일 3종(태도 슬롯·라이브 신호·비용 장부) 기재");
ok(/판정·복권 증거 이벤트\[반박·차단·고정·대체·소멸·사람 재확인·반박 이후 확인\]는 우선 보존/.test(privacy), "PRIVACY — 트림 서술을 판정 보존 구현에 맞춤");
ok(/반박 뒤 재확인\(사람 1회·검증 2회\)이 쌓이면 복권/.test(ext) && /rehabilitated on later re-confirms/.test(ext), "가이드 — 복권 경로 반영(틀림=영구 제외 서술 폐기)");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const readmeEn = fs.readFileSync(path.join(ROOT, "docs", "README.en.md"), "utf8");
ok(/3트랙 기여\(관찰 신호\)/.test(readme) && /정찰\(3트랙\) 비용/.test(readme), "README ko — 통계 절에 기여 카드·비용 구획");
ok(/단계별 기본 원칙\*\* 섹션에서/.test(readme) && /④ 정찰 기본 원칙/.test(readme) && !/🔒 기본 지침\*\* 섹션/.test(readme), "README ko — 옛 명칭 정리+④칸 안내");
ok(/scout-baseline\.en\.json/.test(readme) && /지도 원문 언어도 전역 언어를 따릅니다/.test(readme), "README ko — 언어 절에 정찰 슬롯·지도 언어");
ok(/3-track contribution card/.test(readmeEn) && /recon cost log/.test(readmeEn) && /per-language slots/.test(readmeEn), "README en — 대응 절 갱신");

console.log("[7] 리팩토링(감사 D 반영 잠금) — 고아 제거·version 실사용·러너 i18n");
ok(!/m\?\.type === "saveScoutBaseline"/.test(ext) && !/target: "scoutBase"/.test(ext), "고아 메시지 핸들러(웹뷰가 더는 안 보내는 saveScoutBaseline/reset) 제거");
ok(!/function currentWorkspace\(\)/.test(ext), "미사용 currentWorkspace() 제거");
ok(/형식 버전 /.test(ext) && /format version /.test(ext), "scoutPrompt.version — ④-형식 계약 표시에 실사용");
ok(/const tB = \(ko, en\) => \(loadLang\(\) === "en" \? en : ko\)/.test(selfSrc) && /const tB = \(ko, en\) => \(loadLang\(\) === "en" \? en : ko\)/.test(dsSrc), "러너 2종 CLI 출력 tB 이중언어화(EN 자동지시가 실행을 지시하는 노출 경로)");
// '팔' 은어 잔재 0 잠금(2026-07-09 사용자: 일반인 이해 불가 — 사용자 표면 전수 교체. '명령 팔레트'는 무관 어휘라 허용)
const uiArm = ext.split(String.fromCharCode(10)).filter((l) => /팔/.test(l) && !/팔레트/.test(l));
ok(uiArm.length === 0, "확장 사용자 표면 '팔' 잔재 0" + (uiArm.length ? " ← " + uiArm[0].trim().slice(0, 60) : ""));
ok(!/ arm runs| arm stays| either arm|comparison arm|self arm|self-arm/.test(ext), "확장 영어 'arm' 잔재 0(식별자 제외)");

console.log("[8] 실행 — en 홈에서 러너 usage 출력이 영어(끝-끝 · 비-git은 무이력 폴백으로 실제 LLM을 부르므로 usage 경로로 검증)");
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "en" }));
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-scout-self.js")], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(r.status === 2 && /Usage: node scripts\/scope-scout-self\.js/.test(r.stderr), "self 러너 인자 없음 → 영어 usage(한글 단일 출력 회귀 방지)");
const r2 = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-scout-deepseek.js")], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(r2.status === 2 && /Usage: node scripts\/scope-scout-deepseek\.js/.test(r2.stderr), "deepseek 러너 인자 없음 → 영어 usage");
try { fs.unlinkSync(path.join(dir, "language.json")); } catch { /* 무해 */ }

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
