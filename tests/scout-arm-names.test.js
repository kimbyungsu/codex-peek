/*
 * 정찰 담당 표시명 정본(2026-09-21 문구 감사 · D-2026-09-21-scout-wording-mode-default).
 * 배경: 화면·안내문 곳곳이 '키 없으면 Claude 가 기본 정찰로 전부 동작' · '자동 지시를 받은 Claude 가 실행' 으로 적혀 있었으나
 * 실제 기본 담당은 모드별(contract-lib defaultScoutArmFor: Codex↔Codex=codex)이고 자동 지시는 Codex 훅도 넣는다(codex-hook.js buildScoutDirective).
 * 계약: (1) 이름은 bridge/contract-lib.js scoutArmLabel/scoutArmNames 한 곳에서만 짓는다 (2) 확장·웹뷰·자동 지시는 그 이름을 받아 쓴다
 *       (3) 동작 단정 문구(F-1)·실행 주체 단정 문구(F-3)는 소스·문서에 남지 않는다 (4) 의미 보강 담당의 '기본(Claude)'은 별개 축이라 유지된다.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

console.log("[1] 정본 헬퍼 — 모드 기본에 따라 Claude 담당 이름이 바뀐다(한/영)");
{
  ok(CL.scoutArmLabel("self", "self", "ko") === "기본 정찰(Claude)" && CL.scoutArmLabel("self", "self", "en") === "default scout (Claude)", "Claude↔Codex(기본=self): '기본 정찰(Claude)' / 'default scout (Claude)'");
  ok(CL.scoutArmLabel("self", "codex", "ko") === "Claude 정찰" && CL.scoutArmLabel("self", "codex", "en") === "Claude scout", "Codex↔Codex(기본=codex): Claude 담당은 '기본'이 아니라 'Claude 정찰' / 'Claude scout'");
  ok(CL.scoutArmLabel("codex", "self", "ko") === "Codex 정찰" && CL.scoutArmLabel("deepseek", "codex", "en") === "DeepSeek scout", "Codex·DeepSeek 이름은 모드와 무관");
  ok(/기본 정찰\(Claude · 별도 결제 없음\)/.test(CL.scoutDefaultArmText("self", "ko")) && /Codex 정찰\(쓰시는 Codex 계정 사용량 범위\)/.test(CL.scoutDefaultArmText("codex", "ko")) && /this mode's default scout, the Codex scout/.test(CL.scoutDefaultArmText("codex", "en")), "키 없음·강등 안내 구절: 모드 기본 담당의 이름+비용(동작 단정 없음)");
  const n = CL.scoutArmNames("codex");
  ok(n.defaultArm === "codex" && n.ko.self === "Claude 정찰" && n.ko.selfShort === "Claude 정찰" && n.en.selfShort === "Claude" && n.ko.codex === "Codex 정찰" && typeof n.en.defaultText === "string" && n.en.defaultText.length > 10, "scoutArmNames(codex): 한/영 묶음(self·deepseek·codex·selfShort·defaultText)");
  const n2 = CL.scoutArmNames("self");
  ok(n2.defaultArm === "self" && n2.ko.selfShort === "기본 정찰" && n2.en.selfShort === "Default" && n2.ko.self === "기본 정찰(Claude)", "scoutArmNames(self): 선택 버튼 짧은 이름 '기본 정찰'/'Default'");
  ok(CL.scoutArmNames("bogus").defaultArm === "self", "알 수 없는 기본값은 self 로 정규화");
  // 4판 blocker: 안내는 '실제 실행될 담당'을 말해야 하므로 담당별 구절이 따로 있다 — 그 모드의 기본이면 '기본/이 모드의 기본', 아니면 '선택하신'
  ok(CL.scoutArmText("self", "self", "ko") === "기본 정찰(Claude · 별도 결제 없음)" && CL.scoutArmText("self", "codex", "ko") === "선택하신 Claude 정찰(별도 결제 없음)" && CL.scoutArmText("codex", "codex", "en") === "this mode's default scout, the Codex scout (within your existing Codex account usage)" && CL.scoutArmText("codex", "self", "en") === "the Codex scout you selected (within your existing Codex account usage)" && /DeepSeek/.test(CL.scoutArmText("deepseek", "self", "ko")), "scoutArmText: 담당×모드 기본 → 이름+비용 구절(기본/선택 구분)");
  ok(n.ko.selfText === "선택하신 Claude 정찰(별도 결제 없음)" && n.ko.codexText === "이 모드의 기본 담당인 Codex 정찰(쓰시는 Codex 계정 사용량 범위)" && n2.en.selfText === n2.en.defaultText, "scoutArmNames 에 selfText/codexText/deepseekText 동봉 · defaultText=기본 담당의 구절");
}

console.log("[2] 자동 지시 러너 문구 — 이름은 정본에서 · codex 분기는 '설정된 담당'/'모드 기본'/'강등'을 구분");
{
  const fn = CL.buildScoutDirective.toString();
  ok(fn.includes('scoutArmLabel("self", armV.defaultArm, "en")') && fn.includes('scoutArmLabel("self", armV.defaultArm, "ko")'), "self 담당 이름을 scoutArmLabel(모드 기본 반영)에서 받음");
  ok(!fn.includes("(default scout (Claude)") && !fn.includes("실행(기본 정찰(Claude)") && !fn.includes("the default scout scope-scout-self.js") && !fn.includes("기본 정찰 scope-scout-self.js"), "러너 문구에 'default scout (Claude)'/'기본 정찰' 리터럴 0 — Codex↔Codex 에서 'Claude 정찰'로 자연 표기");
  ok(fn.includes("이 모드의 기본 담당인 Codex 정찰로 진행") && fn.includes("이 모드의 기본 담당: Codex 정찰") && fn.includes("대시보드에 설정된 탐색 담당: Codex 정찰") && fn.includes("this mode's default scout: Codex"), "codex 분기: 명시 선택 / 미지정(모드 기본) / DeepSeek 강등 을 구분해 적음(대시보드 설정 단정 제거)");
  const at = CL.buildScoutAttach.toString();
  ok(at.includes('scoutArmLabel(meta.arm === "deepseek" ? "deepseek" : meta.arm === "codex" ? "codex" : "self", defaultScoutArmFor(normHarnessMode(c)), en ? "en" : "ko")') && !at.includes("기본 Claude 정찰") && !at.includes("default Claude scout"), "검증 프롬프트 동봉 머리(buildScoutAttach)도 이름 정본 — '기본 Claude 정찰'/'default Claude scout' 리터럴 0(4판 지적)");
}

console.log("[3] 확장 배선 — 상태에 이름 묶음이 실리고 화면·상태바·모달이 그 이름만 쓴다");
{
  const src = read("src/extension.ts");
  ok(/function scoutNamesExt\(ws: string \| null\): ScoutNames/.test(src) && /typeof lib\.scoutArmNames === "function"/.test(src) && /\n\s*scoutNames: scoutNamesExt\(ws\),/.test(src), "호스트: scoutNamesExt(배포 브릿지 정본 위임·구 설치본=담당 id) → 상태 scoutNames(정찰 on/off 무관)");
  ok(/scoutNames: ScoutNames;/.test(src), "상태 타입에 scoutNames");
  ok(/scoutNameExt\(ws, "defaultText", "ko"\)/.test(src) && /scoutNameExt\(ws, "defaultText", "en"\)/.test(src), "DeepSeek 키 없이 저장 모달: 저장 슬롯 언어의 모드 기본 담당 구절");
  ok(/키 없이도 정찰은 " \+ defKo \+ "이 맡아요" \+ readyKo/.test(src) && /recon is handled by " \+ defEn \+ readyEn/.test(src) && /armK && !armK\.hasKey && armK\.ready === false \? "\(지금은 준비 안 됨/.test(src) && /const armNoKey: "self" \| "codex" = armK \? armK\.noKeyArm : "self";/.test(src) && /scoutArmTextExt\(wsK, armNoKey, "ko"\)/.test(src), "3트랙 켤 때 키 없음 모달: 키 없을 때 실제 실행될 담당(실효 뷰 noKeyArm — 명시 self/codex 우선) + 준비 안 됨 표기(키 없음일 때만)(4판 blocker)");
  ok(/const noKeyArm: "self" \| "codex" = raw === "self" \|\| raw === "codex" \? raw : defaultArm;/.test(src), "noKeyArm 규칙(실효 뷰 안): 명시 self/codex 는 그 선택, DeepSeek 선택·미지정은 모드 기본(scoutArmView 강등 규칙과 동형)");
  ok((src.match(/" \+ defKo \+ "은 영향받지 않아요/g) || []).length === 3 && (src.match(/" \+ defEn \+ " is unaffected/g) || []).length === 3, "연결 점검 실패 안내 3곳: 기본 담당은 영향받지 않음(Claude 겸임 계속 동작 단정 제거)");
  ok(/const armLabel = scoutNameExt\(ws, best\.arm === "deepseek" \? "deepseek" : best\.arm === "codex" \? "codex" : "self"\);/.test(src), "마지막 지도 담당 라벨: 정본");
  ok(/const scoutLiveArmName = scoutLiveNow \? scoutNameExt\(ws, /.test(src) && (src.match(/\$\{scoutLiveArmName\}/g) || []).length >= 4 && /const armN = scoutNameExt\(ws, live\.arm/.test(src), "상태바·호버·흐름 툴팁의 실행 중 담당 라벨: 정본");
  ok(/var scoutNames9 = null;/.test(src) && /function scoutName\(k\)\{/.test(src) && /function armName\(arm\)\{/.test(src) && /scoutNames9 = d\.scoutNames \|\| null;/.test(src), "웹뷰: 상태의 이름 묶음을 표시 언어로 고르는 헬퍼(scoutName/armName) — 매 상태 갱신");
  ok((src.match(/armName\(/g) || []).length >= 8 && (src.match(/armText\(noKeyArm9\(d\.scoutArm\)\)/g) || []).length >= 4 && /armText\(d\.scoutArm\.eff\)/.test(src) && /armText\(av\.eff\)/.test(src) && /mk\("self", scoutName\("selfShort"\)/.test(src), "웹뷰 표면(지도 목록·최신 지도·생성 중·API 비교·키 안내·선택 버튼)이 헬퍼만 사용 — 키 없음 안내는 실효/키 없을 때 실행될 담당(armText(eff)·noKeyArm9) 기준(4판 blocker)");
  ok(/function noKeyArm9\(av\)\{ if\(av && \(av\.noKeyArm==="self"\|\|av\.noKeyArm==="codex"\)\) return av\.noKeyArm; var d9 = \(scoutNames9 && scoutNames9\.defaultArm\) \|\| \(av && av\.defaultArm\) \|\| "self"; return av && \(av\.raw==="self"\|\|av\.raw==="codex"\) \? av\.raw : d9; \}/.test(src), "웹뷰 noKeyArm9: 호스트 계산값(scoutArm.noKeyArm) 우선 · 같은 규칙 폴백(명시 self/codex 우선 · 정찰 off 면 모드 기본)");
  // 5판 blocker: '키 없음' 비교 문구의 준비 상태는 키 없을 때 실행될 담당의 것 — 키 있는 DeepSeek 의 ready 를 빌리지 않는다
  ok(/lib\.scoutArmReadinessOf\(noKeyArm, hasKey\)\.ready !== false/.test(src) && /return \{ raw, eff, hasKey, slot, defaultArm, ready, reason, noKeyArm, noKeyReady \};/.test(src), "호스트 scoutArmViewExt: noKeyArm 과 그 담당의 준비 상태(noKeyReady — 키 있으면 가정 담당을 브릿지 scoutArmReadinessOf 로 따로 점검)를 상태에 실음");
  ok(/function noKeyReady9\(av\)\{ return !\(av && av\.noKeyReady===false\); \}/.test(src) && (src.match(/noKeyReady9\(d\.scoutArm\)/g) || []).length >= 6 && !/\(d\.scoutArm&&d\.scoutArm\.ready===false\) \? T\("지금 이대로/.test(src), "웹뷰: API 비교 박스 머리·정찰 AI 줄·정찰 카드 안내·dsState 가 noKeyReady9(키 없을 때 실행될 담당의 준비) 기준 — eff 의 ready 차용 0");
  ok(typeof CL.scoutArmReadinessOf === "function" && CL.scoutArmReadinessOf("deepseek", false).reason === "no-key" && CL.scoutArmReadinessOf("deepseek", true).ready === true && typeof CL.scoutArmReadinessOf("self", false).ready === "boolean" && CL.scoutArmReadinessOf("codex", true).cli !== null, "브릿지 scoutArmReadinessOf(arm, hasKey): 담당 하나의 준비 점검(scoutArmReadiness 가 실효 담당에 대해 같은 함수를 씀)");
  ok(/const impl9 = \(d\.contract&&d\.contract\.harnessMode==="codex-codex"\) \? T\("구현 Codex","the implementer Codex"\) : "Claude";/.test(src) && /3트랙 자동 지시를 받은 "\+impl9\+"가/.test(src), "지도 게시판 안내: 자동 지시 수신자=현재 모드의 구현 담당(Claude 또는 구현 Codex)");
  ok(/구현 담당\(운용 모드에 따라 Claude 또는 구현 Codex\)이 실행\(조건:/.test(src) && /the implementer of the current mode \(Claude, or an implementer Codex\) runs it on the 3-track auto-directive/.test(src), "고급설정 키 카드 본문: 실행 주체=구현 담당(모드별)");
  ok(/모드 기본 담당\(클로드-코덱스=Claude 정찰·별도 과금 없음 \/ 코덱스-코덱스=Codex 정찰\)의 영향지도는 동작해요/.test(src), "고급설정 키 카드 머리(정적 HTML): 모드별 기본 규칙을 적음(특정 담당 단정 없음)");
  // F-1/F-3 잔재 0 — 동작·실행 주체 단정 문구
  const stale = [/기본 정찰\(Claude 겸임\)/, /쓰시던 Claude가 겸임/, /Claude doubles as scout/, /자동 지시를 받은 Claude가/, /by Claude on the 3-track auto-directive/, /Claude runs it on the 3-track/, /기본=Claude/, /default=Claude/, /"기본 정찰 Claude"/, /"default scout \(Claude\)"/, /"기본 정찰\(Claude\)"/, /기본 정찰\(Claude\)로 동작/, /the default scout \(Claude\) runs/, /구현 Claude가 코드를 바꾸면/, /전부 동작 — 비교 정찰만 잠김/, /fully works — only the comparison scout/, /\(별도 과금 없음 — 쓰시던 Claude로 실행\)/, /no separate billing — runs on the Claude you already use/];
  const left = stale.filter((re) => re.test(src)).map(String);
  ok(left.length === 0, "확장 소스에 동작·실행 주체 단정 문구 잔재 0" + (left.length ? " — " + left.join(" ") : ""));
  ok(/기본\(Claude\) 담당의 '자동 의미 보강'/.test(src) && /"기본", "Default", "Claude"/.test(src), "의미 보강 담당(mapMode)의 '기본(Claude)'은 별개 축(항상 self)이라 유지(과교정 방지)");
  const out = fs.existsSync(path.join(ROOT, "out", "extension.js")) ? read("out/extension.js") : "";
  ok(!out || (out.includes("function scoutNamesExt(") && out.includes("scoutNames: scoutNamesExt(ws)")), "컴파일 산출물에도 배선(있을 때만 검사)");
}

console.log("[4] 문서 — PRIVACY·README(ko/en): 실행 주체=모드별 구현 담당 · 기본 담당=모드별 · 담당 이름은 'Claude 정찰'");
{
  const priv = read("PRIVACY.md"), rd = read("README.md"), en = read("docs/README.en.md");
  ok(!/자동 지시를 받은 Claude가/.test(priv) && !/자동 지시를 받은 Claude가/.test(rd) && !/Claude runs it under the 3-track/.test(en), "'자동 지시를 받은 Claude 가 실행' 단정 0(ko/en)");
  ok((priv.match(/3트랙 자동 지시를 받은 구현 담당\(운용 모드에 따라 Claude 또는 구현 Codex\)이/g) || []).length === 3 && /구현 담당\(운용 모드에 따라 Claude 또는 구현 Codex — 각자의 훅이 같은 지시를 넣음\)에게/.test(priv), "PRIVACY: 전송 경로 ⑵·deepseek.json 행·DeepSeek 실행 경로·자동 지시 절이 구현 담당(모드별)으로");
  ok(/기본 정찰 담당은 운용 모드를 따릅니다 — 클로드-코덱스 모드=Claude 정찰\(별도 과금 없음·쓰시던 사용량 범위\) · 코덱스-코덱스 모드=Codex 정찰/.test(priv) && !/기본은 기본 정찰\(Claude 겸임/.test(priv), "PRIVACY 자동 지시 절: 기본 담당=모드별(+담당 미준비면 실행 요구 없음)");
  ok(!/기본 정찰\(Claude/.test(priv) && !/기본 정찰\(Claude/.test(rd) && !/default scout \(Claude\)/.test(en) && /Claude 정찰\(키 불필요 · 클로드-코덱스 모드의 기본 담당\)/.test(priv) && /Claude 정찰=별도 과금 없음\(쓰던 사용량 범위 · 클로드-코덱스 모드의 기본\)/.test(rd) && /Claude scout = no separate billing, within the usage you already have \(the default in Claude↔Codex mode\)/.test(en), "담당 이름: 'Claude 정찰'(+어느 모드의 기본인지) — '기본 정찰(Claude)' 단정 0");
  ok(/외부로 나가는 경로는 네 갈래/.test(rd) && /외부로 나가는 경로는 정확히 네 갈래/.test(priv), "네 갈래 모델 문구 유지(무회귀)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
