"use strict";
/*
 * 정찰 프롬프트 노출(§6-11 2026-07-09) — 태도층 슬롯(P1)·형식층 잠금 노출(P2)·이중언어(P3)·메타 서명(P4)·
 * 노출 위치(P5)의 계약 잠금. 2트랙 '단계별 기본 원칙'과 대칭이되, 형식 계약(①~⑥/high)은 파서 배선이라 편집 불가.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spr_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const SP = require(path.join(ROOT, "out", "scope-package.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 태도층 슬롯 — 기본값·저장·복원·언어 슬롯 분리(P1)");
let b = CL.loadScoutBaseline();
ok(b.overridden === false && /탐색자/.test(b.text) && /\[탐색자 지시\]/.test(b.text), "기본값 로드(수정 안 됨·탐색자 역할문)");
ok(CL.saveScoutBaseline("나만의 정찰 태도: 문서 영향을 특히 꼼꼼히 보라.") === true, "커스텀 저장 성공");
b = CL.loadScoutBaseline();
ok(b.overridden === true && /문서 영향/.test(b.text), "저장 후 로드 — overridden 표기");
ok(CL.loadScoutBaseline("en").overridden === false && /scout/.test(CL.loadScoutBaseline("en").text), "en 슬롯은 불가침(언어별 분리 — ko 수정이 안 번짐)");
ok(CL.saveScoutBaseline(CL.scoutBaselineDefaultFor("ko"), "ko") === true && CL.loadScoutBaseline("ko").overridden === false, "기본값과 같은 내용 저장 = 초기화(오버라이드 파일 삭제)");
CL.saveScoutBaseline("커스텀A", "ko");
ok(CL.resetScoutBaseline("ko") === true && CL.loadScoutBaseline("ko").overridden === false, "resetScoutBaseline → 기본값 복원");

console.log("[2] 공용 preface — 두 팔 단일 출처·self만 도구 차단 각주·언어 반영");
ok(/도구는 차단/.test(CL.buildScoutPreface("self")) && !/도구는 차단/.test(CL.buildScoutPreface("deepseek")), "self 팔만 도구 차단 각주(API 모델엔 성립 안 하는 문장 — D5 공정성 유지)");
ok(CL.buildScoutPreface("deepseek") === CL.loadScoutBaseline().text, "deepseek preface = 태도층 원문 그대로(단일 출처)");
ok(/Tools are blocked/.test(CL.buildScoutPreface("self", "en")) && /scout/.test(CL.buildScoutPreface("self", "en")), "en preface — 영어 태도층+영어 도구 각주");
CL.saveScoutBaseline("커스텀 태도문", "ko");
ok(/커스텀 태도문/.test(CL.buildScoutPreface("self", "ko")), "사용자 수정분이 preface에 반영(두 팔 공통)");
CL.resetScoutBaseline("ko");

console.log("[3] 프롬프트 서명(P4) — 기본/수정 구분·형식 버전(실측 통계 오염 방지)");
let sig = CL.scoutPromptSignature("ko");
ok(sig.baselineCustom === false && sig.formatVersion === CL.SCOUT_FORMAT_VERSION && /^[0-9a-f]{12}$/.test(sig.baselineHash) && sig.promptLang === "ko", "기본 프롬프트 서명(custom=false·버전·해시 12자)");
const defaultHash = sig.baselineHash;
CL.saveScoutBaseline("수정된 태도", "ko");
sig = CL.scoutPromptSignature("ko");
ok(sig.baselineCustom === true && sig.baselineHash !== defaultHash, "수정 후 서명 — custom=true·해시 변화(사전등록 48.1% 실측군과 구분 가능)");
CL.resetScoutBaseline("ko");

console.log("[4] 꾸러미 프롬프트층 이중언어(P3) — 형식 기호(①~⑥·high)는 언어 중립 불변");
const base = { repo: "D:/r", head: "abcdef1234567", seeds: ["src/a.ts"], diffText: "+ x", tokenHits: [], coChange: null, tests: [], recentFailures: [], mapContent: null, ledger: { trusted: [{ text: "T1 ↔ T2" }], reference: [], disputed: [{ text: "D1 ↔ D2" }] } };
const mdKo = SP.renderPackageMarkdown(SP.buildPackage(base));
const mdEn = SP.renderPackageMarkdown(SP.buildPackage(base), "en");
ok(/\[탐색자 지시\]/.test(mdKo) && /지도는 한국어로 작성하라/.test(mdKo), "ko 지시 — 출력 언어 명시(한국어)");
ok(/\[Scout directive\]/.test(mdEn) && /Write the map in English/.test(mdEn) && !/\[탐색자 지시\]/.test(mdEn), "en 지시 — 영어 변형(§6-8 후속(c): 지도 원문 언어가 전역 언어를 따름)");
for (const m of [mdKo, mdEn]) ok(/①/.test(m) && /⑥/.test(m) && /high\/medium\/low/.test(m), "형식 기호 ①~⑥·high 표기는 양 언어 동일(파서 계약 불변)");
ok(/Judged wrong/.test(mdEn) && /Confirmed \(verified or human-pinned/.test(mdEn), "en 각주 — 신뢰/틀림 취급 지시 영어 변형");
ok(/틀림 판명\(과거에 반박된 결합/.test(mdKo), "ko 각주 무회귀");

console.log("[5] 러너·브릿지 단일 출처(소스 잠금) + ab-retro 고정 사유");
const selfSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-self.js"), "utf8");
const dsSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-scout-deepseek.js"), "utf8");
const brSrc = fs.readFileSync(path.join(ROOT, "bridge", "deepseek-bridge.js"), "utf8");
const abSrc = fs.readFileSync(path.join(ROOT, "scripts", "scope-ab-retro.js"), "utf8");
ok(/buildScoutPreface\("self"/.test(selfSrc) && !/const preface = "너는 '탐색자'다/.test(selfSrc), "self 러너 — 하드코딩 폐기·단일 출처");
ok(/buildScoutPreface\("deepseek"\)/.test(brSrc), "deepseek-bridge — 같은 슬롯에서 preface(폴백 포함)");
ok(/scoutPromptSignature\(lang\)/.test(selfSrc) && /scoutPromptSignature\(lang\)/.test(dsSrc), "두 러너 지도 메타에 프롬프트 서명 기록(P4)");
ok(/renderPackageMarkdown\(pkg, lang\)/.test(selfSrc) && /renderPackageMarkdown\(pkg, lang\)/.test(dsSrc), "두 러너 꾸러미 렌더에 언어 전달");
ok(/의도적 고정\(§6-11\)/.test(abSrc) && /너는 '탐색자'다/.test(abSrc), "ab-retro — 실측 비교 안정성 위해 기본 문구 고정(사유 주석 잠금)");
ok(/SCOUT_PREFACE_FIXED: "1"/.test(abSrc) && /SCOUT_PREFACE_FIXED !== "1"/.test(brSrc), "ab-retro deepseek 팔도 고정 스위치로 사용자 수정 미반영(실측 오염 차단 — Codex 반례 잠금)");
const fixedEnv = { ...process.env, SCOUT_PREFACE_FIXED: "1" };
const fx = spawnSync(process.execPath, ["-e", "const b=require(process.argv[1]);console.log(b.buildMapRequest('pkg','m').messages[0].content.split('\\n')[0])", path.join(ROOT, "bridge", "deepseek-bridge.js")], { encoding: "utf8", windowsHide: true, env: fixedEnv });
ok(/너는 '탐색자'다\. 아래 꾸러미가 유일한 근거다/.test(fx.stdout), "고정 스위치 실행 — 커스텀·언어 무시하고 기본 원문");

console.log("[6] UI 노출(P2·P5 — 소스 계약)");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/keyedDetails\("scoutPrompt"/.test(ext) && /spBase/.test(ext) && /spSave/.test(ext) && /spReset/.test(ext), "정찰 카드 — 프롬프트 패널(태도층 편집·저장·복원)");
ok(/saveScoutBaseline/.test(ext) && /resetScoutBaseline/.test(ext), "저장/복원 메시지 배선");
ok(/형식 계약\(잠금 · 버전/.test(ext) && /Format contract \(locked · version/.test(ext), "형식층은 잠금 표기와 함께 읽기 전용 노출(한/영)");
ok(/notes: \[notes\.header, notes\.trusted, notes\.reference, notes\.disputed\]/.test(ext) && /각주 전문/.test(ext), "각주는 틀림 예시만이 아니라 3차선 전문 노출(설계 설명과 일치 — Codex 반례 잠금)");
ok(/사전등록 실측과 비교 불가로 표시/.test(ext), "수정 상태 고지 — 수정본이면 '실측 비교 불가'를 상시 표시(저장 전 동의 모달 아님 — 정확 표현, Codex 보완)");
ok(/정찰 카드의 '🧭 정찰에게 주는 지시'에서/.test(ext), "'단계별 기본 원칙' 패널에 위치 링크(P5)");

console.log("[7] 실행 — en 홈에서 꾸러미 CLI 산출물의 지시가 영어(무이력 폴백 포함 끝-끝)");
const wsEn = path.join(dir, "pkg-en");
fs.mkdirSync(wsEn, { recursive: true });
fs.writeFileSync(path.join(wsEn, "one-module.ts"), "export const a = 1;\n");
fs.writeFileSync(path.join(dir, "language.json"), JSON.stringify({ lang: "en" }));
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-package.js"), wsEn], { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
ok(r.status === 0 && /\[Scout directive\]/.test(r.stdout) && /Write the map in English/.test(r.stdout), "CLI 끝-끝 — 전역 언어 en이면 꾸러미 지시가 영어");
try { fs.unlinkSync(path.join(dir, "language.json")); } catch { /* 무해 */ }

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
