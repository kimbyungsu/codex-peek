"use strict";
/*
 * 탐색 담당(scoutArm — 2026-07-20 사용자 요청: 탐색자를 기본(현재 AI 겸임)/DeepSeek 중 고르는 옵션 표시).
 * 계약: 부재=self(비물질화) / raw=현재 언어 슬롯 우선·부재 시 반대 슬롯 상속(사실 성격 — scoutRepo P1-④ 동형) /
 * eff=deepseek 선택인데 키 없으면 self 정직 강등 / 자동 지시 러너가 선택을 반영(명시 deepseek=1순위·
 * 명시 self=재량 문구 없음·미지정+키=현행 재량 유지·강등=사유 고지) / ko-en 쌍 / 대시보드 행+핸들러 존재.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "scoutarm_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const KEY_FILE = path.join(process.env.CODEX_BRIDGE_HOME, "deepseek.json");
const setKey = (on) => { if (on) fs.writeFileSync(KEY_FILE, JSON.stringify({ apiKey: "sk-test" })); else { try { fs.unlinkSync(KEY_FILE); } catch { /* 없음 */ } } };
const mkWs = () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "scoutarm_ws_"));
  fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
  return ws;
};
const writeC = (ws, lang, o) => fs.writeFileSync(CL.contractFileFor(ws, lang), JSON.stringify({ workspace: ws, scoutMode: "on", ...o }));

console.log("[1] normScoutArm — 비물질화");
{
  ok(CL.normScoutArm({}) === "self" && CL.normScoutArm(null) === "self", "부재=self(기본)");
  ok(CL.normScoutArm({ scoutArm: "deepseek" }) === "deepseek" && CL.normScoutArm({ scoutArm: "self" }) === "self", "유효값 통과");
  ok(CL.normScoutArm({ scoutArm: "gpt" }) === "self", "미지값=self(침묵 수용 없음)");
  ok(JSON.stringify(CL.SCOUT_ARMS) === JSON.stringify(["self", "deepseek"]), "합타입 고정");
}

console.log("[2] scoutArmView — raw·상속·강등");
{
  CL.saveLang("ko");
  const ws = mkWs();
  writeC(ws, "ko", {});
  setKey(false);
  let v = CL.scoutArmView(ws);
  ok(v.raw === null && v.eff === "self" && v.hasKey === false, "미지정=raw null·eff self");
  writeC(ws, "ko", { scoutArm: "deepseek" });
  v = CL.scoutArmView(ws);
  ok(v.raw === "deepseek" && v.eff === "self" && v.degraded === "no-key", "deepseek 선택+키 없음=self 정직 강등(no-key)");
  setKey(true);
  v = CL.scoutArmView(ws);
  ok(v.raw === "deepseek" && v.eff === "deepseek" && v.hasKey === true, "키 등록 시 별도 재설정 없이 실효 deepseek");
  // 반대 언어 슬롯 상속: ko에만 설정하고 en 모드로 전환
  CL.saveLang("en");
  const vEn = CL.scoutArmView(ws);
  ok(vEn.raw === "deepseek" && vEn.eff === "deepseek", "반대 언어 슬롯 상속(사실 성격 — 언어 전환에 선택이 사라지지 않음)");
  // 현재 슬롯 명시값이 항상 우선
  writeC(ws, "en", { scoutArm: "self" });
  const vEn2 = CL.scoutArmView(ws);
  ok(vEn2.raw === "self" && vEn2.eff === "self", "현재 슬롯 명시 self가 상속보다 우선");
  CL.saveLang("ko");
}

console.log("[3] 자동 지시 러너 분기 — 선택 반영·ko/en 쌍");
{
  const dirFor = (armField, key, lang) => {
    setKey(key);
    CL.saveLang(lang);
    const ws = mkWs(); // 새 ws=지도 없음(no-map 상태 — 상태당 1회 기억도 초기)
    writeC(ws, lang, armField);
    const c = JSON.parse(fs.readFileSync(CL.contractFileFor(ws, lang), "utf8"));
    return CL.buildScoutDirective(ws, c) || "";
  };
  // 명시 deepseek(키 있음)=DeepSeek 러너 1순위
  let d = dirFor({ scoutArm: "deepseek" }, true, "ko");
  ok(d.includes("scope-scout-deepseek.js") && d.indexOf("scope-scout-deepseek.js") < (d.indexOf("scope-scout-self.js") + 1 || Infinity) && d.includes("탐색 담당"), "ko — 명시 deepseek=DeepSeek 1순위+선호 표기");
  d = dirFor({ scoutArm: "deepseek" }, true, "en");
  ok(d.includes("scope-scout-deepseek.js") && d.includes("preference"), "en — 명시 deepseek 쌍(preference 표기)");
  // 명시 self=재량 문구 없음(키 있어도)
  d = dirFor({ scoutArm: "self" }, true, "ko");
  ok(d.includes("scope-scout-self.js") && !d.includes("scope-scout-deepseek.js"), "ko — 명시 self=DeepSeek 재량 문구 제거(선택 존중)");
  d = dirFor({ scoutArm: "self" }, true, "en");
  ok(d.includes("scope-scout-self.js") && !d.includes("scope-scout-deepseek.js"), "en — 명시 self 쌍");
  // 미지정+키=현행 재량 문구 유지(무회귀)
  d = dirFor({}, true, "ko");
  ok(d.includes("scope-scout-self.js") && d.includes("scope-scout-deepseek.js") && d.includes("비교"), "ko — 미지정+키=기본 우선·비교 재량(현행 무회귀)");
  d = dirFor({}, true, "en");
  ok(d.includes("scope-scout-self.js") && d.includes("scope-scout-deepseek.js") && d.includes("comparison"), "en — 미지정+키 쌍");
  // 미지정+키 없음=재량 문구도 없음
  d = dirFor({}, false, "ko");
  ok(d.includes("scope-scout-self.js") && !d.includes("scope-scout-deepseek.js"), "ko — 미지정+키 없음=기본만");
  // 강등: deepseek 선택+키 없음=기본으로 진행+사유
  d = dirFor({ scoutArm: "deepseek" }, false, "ko");
  ok(d.includes("scope-scout-self.js") && d.includes("키 미등록"), "ko — 강등 시 기본 진행+사유 고지");
  d = dirFor({ scoutArm: "deepseek" }, false, "en");
  ok(d.includes("scope-scout-self.js") && d.includes("no key is registered"), "en — 강등 쌍");
  // 2차 blocker①: 대상 어긋남 조기 반환 분기도 선택 반영(실행 반례 — evidence 주입으로 drift 유도)
  {
    setKey(true); CL.saveLang("ko");
    const ws = mkWs(); writeC(ws, "ko", { scoutArm: "deepseek" });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "scoutarm_drift_"));
    const obs = [];
    for (let i = 0; i < 6; i++) obs.push({ ts: "2026-07-19T00:00:0" + i + ".000Z", repos: [{ repo: other, n: 3 }] });
    fs.mkdirSync(CL.SCOUT_TARGET_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(CL.scoutEvidenceFileFor(ws), JSON.stringify({ obs }));
    const c = JSON.parse(fs.readFileSync(CL.contractFileFor(ws, "ko"), "utf8"));
    const dd = CL.buildScoutDirective(ws, c) || "";
    ok(dd.includes("대상 어긋남"), "(전제) 어긋남 분기 발동");
    ok(dd.includes("scope-scout-deepseek.js") && !dd.includes("scope-scout-self.js"), "어긋남 지시의 지도 명령도 DeepSeek 선택 반영(2차 blocker① — 직전 hasDeepseek:false 반례 소멸)");
    setKey(false);
  }
  CL.saveLang("ko");
}

console.log("[4] 대시보드 표면 — 행·핸들러·ko/en 쌍(소스 계약)");
{
  const src = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(src.includes('id="scoutArmRow"'), "정찰 카드에 탐색 담당 행 존재");
  ok(src.includes('type === "setScoutArm"') || src.includes('type:"setScoutArm"'), "setScoutArm 메시지 배선(수신·발신)");
  ok(src.includes("scoutArmViewExt"), "실효 뷰(강등 표시) 계산 존재");
  ok(src.includes("기본 정찰(Claude — 추가 과금 없음)") && src.includes("Default scout (Claude — no extra billing)"), "선택지 라벨 ko/en 쌍(1차 blocker① — self=별도 Claude 호출이라 '현재 AI 겸임' 표기 금지)");
  ok(src.includes("DeepSeek 정찰") && src.includes("DeepSeek scout"), "DeepSeek 선택지 ko/en 쌍");
  ok(src.includes("키 미등록 — 키 등록") || src.includes("키 미등록"), "강등 안내(키 없음) 존재");
  ok(src.includes("{ modal: true }") && /modal: true[^]{0,300}그래도 저장/.test(src), "키 없는 deepseek 선택=저장 전 모달 확인(1차 blocker④)");
  ok(src.includes('lang:(UI_EN?"en":"ko")'), "전송 슬롯=표시 화면 언어(UI_EN 베이크 — 1차 blocker⑤ 언어 전환 경계 오염 차단)");
  ok(/patchContractRetryExt\(ws, lang, \{ scoutArm: arm \}\);[^]{0,200}codexBridge\.refresh/.test(src), "저장 성공 후 즉시 재렌더(1차 [보완])");
  ok(src.includes("slotIn || loadLangExt()"), "slot=계산과 원자 결속(3차 blocker — 1회 캡처·사후 재판독 금지)");
  // 3차 blocker 실행 반례: 컴파일 산출물에서 실제 함수를 추출해, '계산 도중 전역 언어가 en→ko로 바뀌는'
  // 판독기를 주입 — slot 표지가 값을 계산한 슬롯(en)을 말해야 한다(직전: 값=en·slot=ko로 잠금 우회).
  {
    const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
    const stIdx = outSrc.indexOf("function scoutArmViewExt(");
    const enIdx = outSrc.indexOf(String.fromCharCode(10) + "}", stIdx);
    const fnText = stIdx >= 0 && enIdx > stIdx ? outSrc.slice(stIdx, enIdx + 2) : "";
    ok(!!fnText, "(전제) 산출물에서 함수 추출");
    const wsX = mkWs();
    fs.writeFileSync(CL.contractFileFor(wsX, "en"), JSON.stringify({ workspace: wsX, scoutArm: "deepseek" }));
    fs.writeFileSync(CL.contractFileFor(wsX, "ko"), JSON.stringify({ workspace: wsX }));
    let calls = 0;
    const loadLangStub = () => (++calls === 1 ? "en" : "ko"); // 첫 판독 후 전역이 ko로 전환되는 경합 재현
    const fn = new Function("fs", "contractFileFor", "loadLangExt", "readDeepseekView", "ws", "return (" + fnText + ")(ws);");
    const r = fn(fs, (w, l) => CL.contractFileFor(w, l), loadLangStub, () => ({ hasKey: true }), wsX);
    ok(r.slot === "en" && r.raw === "deepseek", "계산 중 언어 전환에도 slot=실계산 슬롯(en)·값 일치(3차 반례 소멸): " + JSON.stringify(r));
    ok(calls === 1, "언어 판독 1회 캡처(원자 결속의 실체): calls=" + calls);
  }
  ok(src.includes("slotMismatch") && src.includes("av.slot && av.slot !== uiSlot"), "데이터 슬롯≠표시 슬롯이면 조작 잠금(hold 창 오염 차단)");
  ok(src.includes("언어 전환 반영 중") && src.includes("language switch in progress"), "잠금 안내 ko/en 쌍");
  ok(src.includes('lang === "en" ? enM : koM'), "모달 문구=저장 슬롯 기준(전역 tE와 갈리는 창 제거)");
  const out = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  ok(out.includes("scoutArmRow") && out.includes("setScoutArm"), "컴파일 산출물에도 배선 존재(설치본 정합)");
}

console.log("[5] 게이트 소비 경로 — 선택 반영(1차 blocker③)");
{
  const gate = fs.readFileSync(path.join(ROOT, "bridge", "scout-gate.js"), "utf8");
  ok(gate.includes("scoutArmView") && gate.includes("scope-scout-deepseek.js"), "Claude 플랜 게이트 안내 명령이 scoutArm 실효를 반영");
  ok(gate.includes("scripts/${runner}"), "정상·대상 어긋남 안내 모두 러너 변수 사용(고정 self 제거)");
  const ch = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  ok(ch.includes("scoutArmView") && ch.includes("scope-scout-deepseek.js") && ch.includes("scripts/${runner}"), "C-C 게이트도 동일 반영");
  setKey(true); CL.saveLang("ko");
  const ws9 = mkWs(); writeC(ws9, "ko", { scoutArm: "deepseek" });
  ok(CL.scoutArmView(ws9).eff === "deepseek", "(전제) 게이트 분기 입력=deepseek 실효");
  setKey(false);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
