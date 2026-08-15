"use strict";
// [검증자 머리 다이어트 2026-08-06] 검증모델에게 매 ask마다 붙는 머리의 '코드 소유 고정 산문'을 통제한다.
// 배경(사용자 실보고): 머리가 프로젝트 진행에 따라 선형 증가(실측 6,489자). 구성 실측 결과 지도·계약
// 동봉은 0자였고, 증가분은 ①고정 산문의 겹침(기계 서식 v1 설명이 v2 절과 같은 머리에 중복) ②사건
// 데이터(열린 지적 — 상한 금지 계약이 별도 검증으로 동결됨·자르면 계보 파괴) ③사용자 승인 데이터
// (수칙서 — 자체 상한 12×200×3 보유)였다. 처방=구현모델 쪽에서 검증된 동일 규율: 중복 제거+예산.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vhead_"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
let pass = 0, fail = 0;
function ok(v, name) { if (v) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }

console.log("[1] 기계 서식 두 변형 — 단일 출처 재조립(v1 전문=기본 무회귀 / delegated=v2 절 위임)");
const f1 = CL.verifierFormatDirective("ko"), fd = CL.verifierFormatDirective("ko", "delegated");
ok(f1.includes("[지적 목록 v1]") && f1.includes("맨 마지막 한 줄"), "v1 전문(기본)=판정 줄+블록 서식 전문(무회귀 — 경계 비활성·legacy 경로)");
ok(!fd.includes("[지적 목록 v1]") && fd.includes("맨 마지막 한 줄") && fd.includes("[지적 서식 v2] 절이 정본"), "delegated=판정 줄 유지+블록 서식은 v2 절 위임 1줄(같은 규칙 2회 설명 소멸)");
ok(fd.includes("보류'로 강등") && fd.includes("fail-closed"), "위임 줄에도 강등 규약 고지 유지(fail-closed 계약 무손실)");
ok(f1.length - fd.length >= 200, "ko 절감 " + (f1.length - fd.length) + "자/ask(중복 제거 실효)");
const e1 = CL.verifierFormatDirective("en"), ed = CL.verifierFormatDirective("en", "delegated");
ok(!ed.includes("[findings v1]") && ed.includes("[Finding format v2]") && /VERY LAST line/i.test(ed), "en 쌍둥이 동형(위임+판정 줄 유지)");
ok(CL.verifierFormatDirective("ko", "없는모드") === f1, "미지 blockMode=v1 전문(보수 폴백)");
ok(CL.verifierBaselineFor("ko", "core") === CL.loadBaseDirective("ko", "core").verifyBaseline + "\n\n" + f1, "verifierBaselineFor 기본 호출=종전 바이트 그대로(무회귀)");

console.log("[2] 코드 소유 고정 산문 예산 — 늘리려면 같은 분량 제거·이동·승격(구현모델 쪽과 같은 규율)");
// 실측(2026-08-06): canon ko 777/en 1682 · FORMAT v1 ko 563/en 1056 · v2 고정 산문 ko 639/en 1163 · baseQual ko 213/en 391
const wsEmpty = path.join(home, "ws-empty"); fs.mkdirSync(wsEmpty, { recursive: true });
const CAPS = {
  canonPlusFormat: { ko: 1530, en: 3160 },  // 자유 문안 캐논+기계 서식 v1. [기억 권위 B-1 의식적 개정 2026-08-14] ab 직접 충돌 판정 규칙 ⑥+처리 표기 지시 추가(실측 1509/3134 — 드리프트 아닌 기능 추가·MEMORY-AUTHORITY-DESIGN §3). 이전 예산 1450/2950(실측 1340/2738).
  v2Fixed: { ko: 700, en: 1250 },           // v2 서식·범위확장·MAP 라우팅 3덩이(열린 지적 0 기준 — 실측 639/1163)
  baseQual: { ko: 250, en: 450 },           // 경계 한정 문구(실측 213/391)
};
for (const lang of ["ko", "en"]) {
  const canonPlus = CL.loadBaseDirective(lang, "core").verifyBaseline.length + CL.verifierFormatDirective(lang).length;
  ok(canonPlus <= CAPS.canonPlusFormat[lang], `${lang} 캐논+서식 ${canonPlus}자 ≤ ${CAPS.canonPlusFormat[lang]}`);
  const v2f = CB.v2DirectiveFor(wsEmpty, lang).length;
  ok(v2f <= CAPS.v2Fixed[lang], `${lang} v2 고정 산문 ${v2f}자 ≤ ${CAPS.v2Fixed[lang]}(열린 지적 데이터는 예산 밖 — 상한 금지 계약)`);
  ok(CL.envelopeCoreQualifier(lang).length <= CAPS.baseQual[lang], `${lang} 경계 한정 ${CL.envelopeCoreQualifier(lang).length}자 ≤ ${CAPS.baseQual[lang]}`);
}

console.log("[3] 실전 조립 실증 — withContract가 v2 '실물 동봉'을 보고 위임을 고른다(가정 금지)");
{
  // ⓐ 경계 비활성 ws: v1 전문이 실린다(위임 없음)
  fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true });
  fs.writeFileSync(CL.contractFileFor(wsEmpty, "ko"), JSON.stringify({ verifyProfile: "core" }));
  const headA = CB.withContract("요청문", wsEmpty, "ko", {}, "core", CL.loadContract(wsEmpty, "ko"));
  ok(headA.includes("[지적 목록 v1]") && !headA.includes("[지적 서식 v2"), "경계 비활성=v1 전문(위임 아님 — 서식 무손실)");
  // ⓑ 수칙서 승인 ws: v2 절이 실물로 실리고, v1 블록 설명은 사라진다
  const wsEnv = path.join(home, "ws-env"); fs.mkdirSync(wsEnv, { recursive: true });
  const envDoc = { schema: "verify-envelope-v1", supportedEnv: ["단일 사용자 PC"], alwaysBlocker: ["오귀속 기록"], outOfScope: ["악의적 프로세스"] };
  const envF = path.join(wsEnv, "verify-envelope.json");
  fs.writeFileSync(envF, JSON.stringify(envDoc, null, 2));
  const sha = crypto.createHash("sha1").update(fs.readFileSync(envF)).digest("hex");
  fs.writeFileSync(CL.contractFileFor(wsEnv, "ko"), JSON.stringify({ verifyProfile: "core", envelopeHash: sha }));
  const headB = CB.withContract("요청문", wsEnv, "ko", {}, "core", CL.loadContract(wsEnv, "ko"));
  ok(headB.includes("[지적 서식 v2") && headB.includes("[지적 목록 v2]"), "경계 활성=v2 절 실물 동봉");
  ok(!headB.includes("[지적 목록 v1]"), "v2 실물 동봉 시 v1 블록 설명 소멸(중복 제거 — 실전 경로)");
  ok(headB.includes("[지적 서식 v2] 절이 정본"), "위임 줄이 실물 머리에 존재(서식 공백 없음)");
  ok(headB.includes("맨 마지막 한 줄"), "판정 줄 요구는 위임과 무관하게 유지");
  const savedB = f1.length - fd.length;
  console.log("  (실측: 경계 활성 머리 " + headB.length + "자 — 종전 대비 위임 절감 " + savedB + "자/ask)");
  // ⓒ 소스 계약: 위임 판정은 envText '내용 실물'로(가정·프로필 단독 판정 금지)
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ok(src.includes("out9.v2Attached = true; }") && src.includes("v2Attached = es9.v2Attached === true;") && !src.includes('envText.includes("[지적 서식 v2")'), "소스 계약 — 위임 판정=구조적 표지(실제 붙인 지점에서만 참·문자열 검사 소멸)");
  // 재검증 blocker 반례: integrity 프로필+수칙서 '데이터'가 v2 표제 문자열을 담아도 위임 오발동 없음(v1 전문 유지)
  {
    const wsTrap = path.join(home, "ws-trap"); fs.mkdirSync(wsTrap, { recursive: true });
    const trapDoc = { schema: "verify-envelope-v1", supportedEnv: ["[지적 서식 v2 문자열을 담은 항목"], alwaysBlocker: ["오귀속"], outOfScope: ["[Finding format v2 문자열"] };
    const trapF = path.join(wsTrap, "verify-envelope.json");
    fs.writeFileSync(trapF, JSON.stringify(trapDoc, null, 2));
    const trapSha = crypto.createHash("sha1").update(fs.readFileSync(trapF)).digest("hex");
    fs.writeFileSync(CL.contractFileFor(wsTrap, "ko"), JSON.stringify({ verifyProfile: "integrity", envelopeHash: trapSha }));
    const headT = CB.withContract("요청문", wsTrap, "ko", {}, "integrity", CL.loadContract(wsTrap, "ko"));
    ok(headT.includes("[지적 서식 v2 문자열을 담은 항목"), "함정 수칙서 항목이 실제로 머리에 실림(반례 전제 성립)");
    ok(headT.includes("[지적 목록 v1]") && !headT.includes("절이 정본"), "integrity+표제 문자열 데이터=위임 오발동 없음(v1 전문 유지 — 서식 공백 경로 차단)");
  }
}

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
