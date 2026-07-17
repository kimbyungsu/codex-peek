"use strict";
/*
 * P-12 1단(2026-07-17 · 설계 동결 v2.1) — 검증 강도 프로필 이원화(핵심/무결성).
 * 계약 ⓛ: 필드 정규화·상속·ko/en, 프리셋 선택(주입문 반영), ask 시작 시점 동결(job 저장→worker 소비 —
 * 생성 후 계약 전환에도 동결값 유지), legacy job=integrity·전역 언어, formatForClaude 동결 프로필 문구,
 * integrity 프리셋 1글자 불변·오버라이드 바이트 불변, 판독기·P-6 불변, '턴 중 전환 한계' 정확 고지 존재.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p12_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 필드 정규화·상속(계약 ⓐ)");
ok(CL.normVerifyProfile({}) === "integrity" && CL.normCodexVerifyProfile({}) === "integrity", "부재=integrity(무회귀)");
ok(CL.normVerifyProfile({ verifyProfile: "core" }) === "core" && CL.normVerifyProfile({ verifyProfile: "이상값" }) === "integrity", "유효값만 인정·무효=integrity");
ok(CL.normCodexVerifyProfile({ verifyProfile: "core" }) === "core", "C-C 전용값 부재 시 CL-C 상속(codexVerifyMode와 동형)");
ok(CL.normCodexVerifyProfile({ verifyProfile: "core", codexVerifyProfile: "integrity" }) === "integrity", "C-C 명시 저장 후엔 CL-C와 독립");
ok(CL.effectiveVerifyProfile({ harnessMode: "codex-codex", verifyProfile: "core" }) === "core" && CL.effectiveVerifyProfile({ harnessMode: "claude-codex", codexVerifyProfile: "core" }) === "integrity", "실효 프로필=운용 모드의 슬롯");
const wsA = "D:/p12-a";
fs.mkdirSync(path.dirname(CL.contractFileFor(wsA, "ko")), { recursive: true });
fs.writeFileSync(CL.contractFileFor(wsA, "ko"), JSON.stringify({ verifyProfile: "core" }));
ok(CL.loadContract(wsA, "ko").verifyProfile === "core" && CL.loadContract(wsA, "ko").codexVerifyProfile === "core", "loadContract가 정규화 필드 제공(상속 포함)");

console.log("[2] 프리셋 선택(계약 ⓑⓒⓓⓔ) — core=캐논 고정·integrity=현행+오버라이드");
const coreKo = CL.loadBaseDirective("ko", "core"), coreEn = CL.loadBaseDirective("en", "core");
ok(/핵심 프로필/.test(coreKo.verifyBaseline) && /\[백로그\]/.test(coreKo.verifyBaseline) && /blocker가 최소 1개/.test(coreKo.verifyBaseline), "core ko — 심각도 게이트·[백로그] 분리 규약 포함");
ok(/\[주의\]/.test(coreKo.verifyBaseline) && /보안·개인정보·데이터 손상·복구 불능·운영 오판/.test(coreKo.verifyBaseline) && /침묵 이관 금지/.test(coreKo.verifyBaseline), "core ko — [주의] 중간 딱지(v2.2): 보안 인접 비차단은 백로그가 아니라 구현모델 재판단 대상");
ok(/\[주의\]/.test(coreKo.rejudge) && /같은 루프에서 함께 고치고/.test(coreKo.rejudge) && /근거를 달아 사용자 보고로 승격/.test(coreKo.rejudge), "core ko 재판단 — [주의]=지금 고침(재검증 1회 동승) 또는 근거 승격(조용한 이관 금지)");
ok(/\[caution\]/.test(coreEn.verifyBaseline) && /\[caution\]/.test(coreEn.rejudge) && /never silently deferred/.test(coreEn.verifyBaseline), "core en — [caution] 쌍");
ok(!/blocker\(실패 사유\)만 고치고/.test(coreKo.rejudge) && !/Fix only blockers/.test(coreEn.rejudge) && /이번 루프 처리로 결정한 항목만 함께 고쳐/.test(coreKo.rejudge), "재판단 내부 모순 부재 — 'blocker만' 문장 제거·3단 양립형(주의 동승) 잠금");
ok(/구체 경로를 한 줄 명시하라/.test(coreKo.verifyBaseline) && /경로를 못 대면 \[백로그\]/.test(coreKo.verifyBaseline) && /one-line concrete path/.test(coreEn.verifyBaseline), "[주의] 남용 방지 — 위험 경로 1줄 필수(못 대면 백로그)");
ok(/실질 영향으로 판정/.test(coreKo.verifyBaseline) && /희귀 경합이라도/.test(coreKo.verifyBaseline), "blocker=종류 아닌 실질 영향(희귀 경합도 해당 시 blocker)");
ok(/'검증: 통과' \/ '검증: 통과\(보완\)' \/ '검증: 보류' \/ '검증: 실패'/.test(coreKo.verifyBaseline), "판정 4단 출력 형식은 integrity와 동일(판독기 불변 — 계약 ⓖ)");
ok(/Core profile/.test(coreEn.verifyBaseline) && /\[backlog\]/.test(coreEn.verifyBaseline) && /'Verdict: pass' \/ 'Verdict: pass \(notes\)' \/ 'Verdict: inconclusive' \/ 'Verdict: fail'/.test(coreEn.verifyBaseline), "core en — 동등 규약+영어 판독 문법 일치");
ok(/목표 \/ 인수조건/.test(coreKo.transmit) && /goal \/ acceptance criteria/.test(coreEn.transmit), "core 전달 원칙 — 요청문 구조화(ⓔ·한/영)");
ok(/재판단 단계에서는 수정하지 마라/.test(coreKo.rejudge) && /'보류'로 사용자에게 선택을 넘겨라/.test(coreKo.rejudge) && /무결성 프로필로 승격 검증 1회/.test(coreKo.rejudge), "core 재판단 — 백로그 자동수정 금지(재판단 단계 한정)·교착 시 보류 승격·승격 게이트 권장(ⓓⓗⓘ)");
// [v2.3 2026-07-17] 보류 3분류 의무 + 백로그 단계 경계(마감 선별 승격) — ko/en 대칭(사용자 승인 개정)
ok(/\[분쟁 보류\]/.test(coreKo.rejudge) && /\[미해결 결함 보류\]/.test(coreKo.rejudge) && /\[외부 결정 보류\]/.test(coreKo.rejudge) && /그냥 보류'는 금지/.test(coreKo.rejudge) && /대상 지적·최종 상태·사용자 선택지/.test(coreKo.rejudge), "v2.3 — 보류 이관은 3분류+근거 의무('그냥 보류' 금지)");
ok(/묶음 마감\(최종 커밋 전\)에는 열린 장부를 선별하라/.test(coreKo.rejudge) && /인수조건으로 승격해 한 번에 수정하고 최종 검증 1회/.test(coreKo.rejudge) && /처분 사유와 함께 장부에 유지/.test(coreKo.rejudge), "v2.3 — 백로그 소화=마감 선별(직접 관련·명시 선택만 승격·나머지는 사유와 유지)");
ok(/\[disputed hold\]/.test(coreEn.rejudge) && /\[unresolved-defect hold\]/.test(coreEn.rejudge) && /\[external-decision hold\]/.test(coreEn.rejudge) && /Never a bare hold/.test(coreEn.rejudge) && /At bundle close \(before the final commit\), triage the open ledger/.test(coreEn.rejudge), "v2.3 en — 동등 규약(3분류 보류·마감 선별)");
ok(/allowed immediately even with budget left/.test(coreEn.rejudge) && /예산·왕복이 남아도 즉시 가능/.test(coreKo.rejudge), "v2.3 — 외부 결정 보류는 예산 소진 전 즉시 가능(예산 소진=충분조건, 유일 정의 아님)");
ok(CL.loadBaseDirective("ko").verifyBaseline === CL.baseDefaultsFor("ko").verifyBaseline, "integrity(미지정)=현행 캐논 그대로(무회귀)");
ok(CL.loadBaseDirective("ko", "integrity").verifyBaseline === CL.loadBaseDirective("ko").verifyBaseline, "명시 integrity=미지정과 동일");
// integrity 프리셋 1글자 불변(스냅샷 대조 — 5항 실질 영향 원칙 문구 앵커)
const sha16 = (t) => require("crypto").createHash("sha256").update(t, "utf8").digest("hex").slice(0, 16);
ok(sha16(CL.BASE_DEFAULTS.verifyBaseline) === "09245598a6d8fa0f" && sha16(CL.BASE_DEFAULTS.transmit) === "10938882fe841e0d" && sha16(CL.BASE_DEFAULTS.rejudge) === "9050fc227f2039b6", "integrity ko 캐논 3축 전문 해시 불변(1글자 불변 — P-12 도입 시점 스냅샷)");
ok(sha16(CL.BASE_DEFAULTS_EN.verifyBaseline) === "3c48e8f0d56bd2b8" && sha16(CL.BASE_DEFAULTS_EN.transmit) === "9175bd8183f9bee2" && sha16(CL.BASE_DEFAULTS_EN.rejudge) === "4c19437bd47ef3cf", "integrity en 캐논 3축 전문 해시 불변");
// 오버라이드는 integrity에만 적용, core 전환이 오버라이드 파일 바이트를 건드리지 않음(ⓑ 불변 조건)
CL.saveBaseDirective({ verifyBaseline: "사용자 커스텀 원칙", transmit: "", rejudge: "" }, "ko");
const ovFile = CL.baseDirectiveFileFor("ko");
const ovBytes = fs.readFileSync(ovFile, "utf8");
ok(CL.loadBaseDirective("ko").verifyBaseline === "사용자 커스텀 원칙", "integrity 오버라이드 적용(현행 동작)");
ok(CL.loadBaseDirective("ko", "core").verifyBaseline === CL.BASE_CORE.verifyBaseline, "core는 오버라이드 미적용(캐논 고정 — 사용자 편집과 분리)");
ok(fs.readFileSync(ovFile, "utf8") === ovBytes && CL.loadBaseDirective("ko").verifyBaseline === "사용자 커스텀 원칙", "core 조회가 오버라이드 파일 바이트를 불변 유지·integrity 복귀 시 그대로 복원");
CL.resetBaseDirective("ko");

console.log("[3] formatForClaude — 동결 프로필 문구(계약 ⓓ)");
const ans = "본문 근거\n검증: 통과(보완)";
ok(CL.formatForClaude(ans, "ko").includes("[수용/반박/보류]로 최종 보고에서 처리하라"), "integrity(미지정) pass-notes=현행 문구(무회귀)");
ok(CL.formatForClaude(ans, "ko", "core").includes("'[주의]' 항목은 심각성을 재판단해") && CL.formatForClaude(ans, "ko", "core").includes("'[백로그]' 항목은 수정하지 말고"), "core pass-notes=[주의] 재판단+백로그 자동수정 금지(v2.2)");
ok(CL.formatForClaude("x\n검증: 실패", "ko", "core").includes("blocker(실패 사유)를 고치고") && CL.formatForClaude("x\n검증: 실패", "ko", "core").includes("'[주의]' 항목은 심각성을 재판단해"), "core fail=blocker 수정+[주의] 재판단 동승(v2.2)");
ok(CL.formatForClaude("x\nVerdict: fail", "en", "core").includes("fix the blockers") && CL.formatForClaude("x\nVerdict: fail", "en", "core").includes("[caution]"), "core en fail 문구(v2.2)");
ok(CL.formatForClaude(ans, "ko", "core").includes("검증: 통과(보완)"), "footer에 원문 판정 줄 보존(판독·재판단 원칙 불변)");
ok(CL.extractVerdict("x\n검증: 통과(보완)") === "pass-notes" && CL.extractVerdict("x\nVerdict: fail") === "fail", "판독기 4단 판정 불변(계약 ⓖ)");

console.log("[4] ask 시작 시점 동결(계약 ⓕ · 구현검증 1차 정정 반영)");
const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
ok(/const askLangSnap=loadLang\(\);/.test(src) && /const cSnap=loadContract\(ws, askLangSnap\);/.test(src) && /verifyProfile:effectiveVerifyProfile\(cSnap\),verifyLang:askLangSnap,/.test(src), "cmdAskStart — 언어 먼저 캡처→같은 슬롯 계약→job에 단일 스냅샷 동결(교차 슬롯 결합 차단)");
ok(/const durableEnv = process\.env\.CODEX_BRIDGE_JOB_PROMPT_FILE \? readCanonicalEnvJob\(ws\) : null;/.test(src), "cmdAsk — 내구 env는 '모드 무관' 정본 판독(readCanonicalEnvJob)만 신뢰(P-6 판독기는 C-C 전용이라 CL-C job을 job-mode 거부 — 2차 회귀 봉합)");
// 실행 검증: CL-C 정상 job의 동결값이 실제로 읽히고, legacy job=integrity+전역 언어, 비정본 경로=거부.
{
  const bridge = require(path.join(ROOT, "bridge", "codex-bridge.js"));
  const jobsDir = bridge.ASK_JOBS_DIR;
  fs.mkdirSync(jobsDir, { recursive: true });
  const mkJob = (id, extra) => {
    const f = path.join(jobsDir, id + ".json");
    fs.writeFileSync(f, JSON.stringify(Object.assign({ schema: "ask-job-v1", id, state: "running", workspace: wsA, prompt: "x", harnessMode: "claude-codex" }, extra)));
    return f;
  };
  const idA = "ask-p12clc-aaaaaaaaaa";
  process.env.CODEX_BRIDGE_JOB_PROMPT_FILE = mkJob(idA, { verifyProfile: "core", verifyLang: "en" });
  process.env.CODEX_BRIDGE_ASK_JOB_ID = idA;
  let r = bridge.readCanonicalEnvJob(wsA);
  ok(r.ok === true && r.job.verifyProfile === "core" && r.job.verifyLang === "en" && r.job.harnessMode === "claude-codex", "CL-C 정상 job — 정본 판독 통과·동결값(core/en) 회수(P-6 판독기였다면 job-mode 거부)");
  const idB = "ask-p12lgc-bbbbbbbbbb";
  process.env.CODEX_BRIDGE_JOB_PROMPT_FILE = mkJob(idB, {});
  process.env.CODEX_BRIDGE_ASK_JOB_ID = idB;
  r = bridge.readCanonicalEnvJob(wsA);
  const legacyProfile = CL.VERIFY_PROFILES.includes(r.job && r.job.verifyProfile) ? r.job.verifyProfile : "integrity";
  ok(r.ok === true && legacyProfile === "integrity", "legacy 정본 job(필드 없음) — cmdAsk 규칙으로 integrity 고정(계약 전환 무관)");
  const rogue = path.join(dir, "rogue.json");
  fs.writeFileSync(rogue, JSON.stringify({ schema: "ask-job-v1", id: idB, state: "running", workspace: wsA, verifyProfile: "core" }));
  process.env.CODEX_BRIDGE_JOB_PROMPT_FILE = rogue;
  ok(bridge.readCanonicalEnvJob(wsA).ok === false, "비정본 경로(조작 파일) — 거부(integrity fail-safe 경로)");
  const idC = "ask-p12done-cccccccccc";
  process.env.CODEX_BRIDGE_JOB_PROMPT_FILE = mkJob(idC, { state: "succeeded" });
  process.env.CODEX_BRIDGE_ASK_JOB_ID = idC;
  ok(bridge.readCanonicalEnvJob(wsA).ok === false, "running 아님 — 거부");
  delete process.env.CODEX_BRIDGE_JOB_PROMPT_FILE;
  delete process.env.CODEX_BRIDGE_ASK_JOB_ID;
}
ok(/VERIFY_PROFILES\.includes\(j\.verifyProfile\) \? j\.verifyProfile : "integrity"/.test(src) && /=== "ko" \|\| j\.verifyLang === "en"\) \? j\.verifyLang : loadLang\(\)/.test(src), "legacy 정본 job(필드 없음)=integrity+전역 언어 고정 — 생성 후 계약을 core로 바꿔도 legacy job은 core로 실행 안 됨(무회귀)");
ok(/if \(!durableEnv\.ok\) return \{ profile: "integrity", lang: loadLang\(\) \};/.test(src), "비정본 env=integrity fail-safe(조작 파일이 프로필 출처가 못 됨)");
ok(/const langSnap = jobFrozen \? jobFrozen\.lang : loadLang\(\);\s*\n\s*const contractSnap = loadContract\(ws, langSnap\)/.test(src), "직접 ask — 언어 먼저 캡처 후 같은 슬롯 계약 읽기(프로필·언어 단일 스냅샷)");
ok(/const profileSnap = jobFrozen \? jobFrozen\.profile : effectiveVerifyProfile\(contractSnap\);/.test(src), "직접 ask=시작 시점 계약 스냅샷·내구=job 동결값(계약 ⓕ)");
ok(/withContract\(prompt \+ \(net \? netNote\(langSnap\) : ""\), ws, langSnap, attCarrier, profileSnap\)/.test(src), "주입(withContract)이 동결 프로필 사용");
ok(src.split("formatForClaude(answer, langSnap, profileSnap)").length === 3, "footer 2경로(연결·새 세션) 모두 동결 프로필 사용 — 완료 시점 재읽기 없음");
const wk = fs.readFileSync(path.join(ROOT, "bridge", "ask-job-worker.js"), "utf8");
ok(/Object\.assign\(\{\}, cur, extra\)/.test(wk), "worker patch=기존 필드 보존 병합(동결 필드 불변)");

console.log("[5] 주입자·P-6·UI 배선(소스 잠금)");
ok(/buildVerifyDirective\(c\.codexVerifyMode, undefined, c\.codexVerifyProfile\)/.test(fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8")), "C-C 주입 — 그 시점 실효 프로필 전달");
ok(/buildVerifyDirective\(c\.verifyMode, undefined, c\.verifyProfile\)/.test(fs.readFileSync(path.join(ROOT, "bridge", "contract-inject.js"), "utf8")), "CL-C 주입 — 동일");
ok(/writeDurableProofV2/.test(src) && !/verifyProfile/.test(String((CL.writeDurableProofV2 || "").toString())), "P-6 proof 서명에 프로필 미포함(영수증 바이트 불변 — 계약 ⓖ)");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/id="segProfile"/.test(ext) && /data-vp="integrity"/.test(ext) && /data-vp="core"/.test(ext), "UI — 프로필 세그먼트(무결성 기본/핵심)");
ok(ext.split("m.verifyProfileTouched ?").length === 3 && !/^\s*codexVerifyProfile: normVerifyProfile/m.test(ext), "저장 — 사용자가 실제로 바꾼 저장에만 프로필 기록(굳힘 금지 ⓐ — 상속 실효값이 원시 필드로 물질화되는 회귀 차단)");
ok(/verifyProfileTouched: \(appVP!==null && curVP!==appVP\)/.test(ext), "웹뷰 — touched 플래그(선택값≠저장값일 때만 참)");
ok(/pVM=appVM, pIM=appIM, pSM=appSM, pVP=appVP;/.test(ext) && /\(pVP!==null&&curVP!==pVP\)/.test(ext), "상태 푸시 — 프로필만 바꾼 미저장 초안도 보존(dirty에 포함 — 조용한 원복 차단)");
ok(/모든 결함 부재를 보증하지는 않음/.test(ext) && /범위 밖 잔여 위험이 남을 수 있고/.test(ext) && /기계적 왕복 상한·자동수정 차단은 아직 없음\(2단\)/.test(ext), "정직 라벨 — 양쪽 프로필 과장 금지+프롬프트 규약 한계 명시(ⓙ)");
ok(/이후 시작되는 검증\(ask\)부터 즉시 적용/.test(ext) && /한 턴 안에서 규약이 섞일 수 있으니/.test(ext) && !/다음 사용자 턴부터/.test(ext), "전환 효력 정확 고지('다음 턴부터' 류 부정확 표현 부재 — ⓕ 한계 고지)");
ok(/does not guarantee absence of all defects/.test(ext) && /no mechanical round-trip cap/.test(ext), "정직 라벨 en 쌍");
ok(/appVP = \(ccMode \? d\.contract\.codexVerifyProfile : d\.contract\.verifyProfile\) \|\| "integrity"/.test(ext), "상태 채움 — 모드별 슬롯·부재=integrity");

console.log("[6] 기본 원칙 카드 — 실효 프로필의 '실제 주입 문안' 표시(사용자 지시 07-17)");
ok(/profile: string \}; \/\/ profile: 표시 중 문안의 실효 프로필/.test(ext) && /shownProfile = "core";/.test(ext), "computeBaseState — 실효 core면 core 캐논을 표시용으로 제공(profile 필드)");
ok(/Array\.isArray\(lib\.VERIFY_PROFILES\) && typeof lib\.loadBaseDirective === "function"/.test(ext), "구버전 판별 — VERIFY_PROFILES capability 확인(옛 로더가 2번째 인자를 무시하고 integrity를 core로 오표시하는 반례 차단)");
ok(/readOk: true \}/.test(ext) && /integrity 오버라이드 파일 손상과 무관/.test(ext), "core 캐논 신뢰=코드 내장 — integrity 오버라이드 손상과 분리(readOk 결합 해제)");
ok(/var baseCoreView = false;/.test(ext) && /e\.readOnly = on \|\| baseCoreView;/.test(ext), "core 표시 중 3칸 읽기 전용(정찰 ④칸은 무관)");
ok(ext.split("baseLocked: baseCoreView").length === 3, "저장·복원 전송에 baseLocked 스코핑 — 버튼은 살아 있고 ④ 정찰 칸 통로 유지(전면 잠금 반례 봉합)");
ok(/m\.baseLocked === true \? true : bridgeLib\(\)\?\.saveBaseDirective/.test(ext) && /m\.baseLocked === true \? true : bridgeLib\(\)\?\.resetBaseDirective/.test(ext), "호스트 — core 중 3칸 저장·복원 생략(무결성 오버라이드 불변)·정찰만 처리");
ok(/baseDraftStash = \{ v: /.test(ext) && /baseDirty\.verify = baseDraftStash\.d\.verify;/.test(ext), "무결성 미저장 초안 — core 진입 시 보관·복귀 시 복원(소실 금지)");
ok(ext.split("|| baseDraftStash").length === 5, "stash가 dirty 합성 4결선(호스트 보고·언어 버튼 가드·langHold·외부 언어 변경 holdB)에 편입 — 어느 경로의 웹뷰 재생성도 보관 초안을 파괴 못 함");
ok(/baseDirty\.scout \|\| baseDraftStash \|\|[\s\S]{0,40}document\.activeElement === \$\("bVerify"\)/.test(ext), "외부 언어 변경 상태 푸시(holdB)도 stash 유지(4번째 결선 — 3차 blocker)");
ok(/baseDraftStash = null; \/\/ P-12: '초안 폐기'는 core 표시 중 보관분\(stash\)도 폐기/.test(ext), "되돌리기=stash도 폐기(복귀 시 부활 방지)");
ok(/핵심 프로필 문안 표시 중\(코드 고정·읽기 전용/.test(ext) && /showing Core profile text/.test(ext), "배지 한/영 — 표시 중 문안의 정체 고지");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
