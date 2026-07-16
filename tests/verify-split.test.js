"use strict";
/*
 * 검증 스위치 모드별 분리(2026-07-15/16 — CODEX-DUAL-PENDING P-9 소절 설계 계약 ⓐ~ⓖ) + P-10(카드 초안 모드 교차 오염).
 * 핵심 계약:
 *  ⓐ verifyMode=CL-C 슬롯 / codexVerifyMode=C-C 슬롯
 *  ⓑ fallback: codexVerifyMode 유효값 우선, 부재 시 normVerifyMode(o) 전체 재사용(verify:true→code 레거시 보존)
 *  ⓒ 물질화: 모드 전환·CL-C 일반 저장은 codexVerifyMode를 만들지 않음 — 명시적 C-C 저장에서만
 *  ⓓ 소비처: C-C 게이트=codexVerifyMode / CL-C 게이트(verify-guard·contract-inject)=verifyMode(음성 회귀)
 *  ⓕ UI: dirty·저장대기 중 모드 전환 잠금(P-10 공통), 외부 전환 hold(renderedMode), 명시적 되돌리기
 */
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsplit_"));
process.env.CODEX_BRIDGE_HOME = tmp;
const codexHome = path.join(tmp, "codex-home"), sessions = path.join(codexHome, "sessions");
process.env.CODEX_HOME = codexHome; fs.mkdirSync(sessions, { recursive: true });
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const rawC = (ws, lang) => JSON.parse(fs.readFileSync(CL.contractFileFor(ws, lang), "utf8"));

console.log("[1] fallback 의미(ⓑ) — 부재=CL-C 상속·verify:true 레거시·명시값 독립(양방향)");
const ws = path.join(tmp, "proj");
fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verifyMode: "always" }));
ok(CL.loadContract(ws, "ko").codexVerifyMode === "always", "부재 시 CL-C 값 상속(always)");
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verify: true }));
let c1 = CL.loadContract(ws, "ko");
ok(c1.verifyMode === "code" && c1.codexVerifyMode === "code", "구형 verify:true → 양쪽 다 code(원시 폴백이면 off로 회귀했을 반례)");
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verifyMode: "off", codexVerifyMode: "always" }));
c1 = CL.loadContract(ws, "ko");
ok(c1.verifyMode === "off" && c1.codexVerifyMode === "always", "CL-C off / C-C always — CL-C가 C-C 명시값을 무시(독립)");
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verifyMode: "always", codexVerifyMode: "off" }));
c1 = CL.loadContract(ws, "ko");
ok(c1.verifyMode === "always" && c1.codexVerifyMode === "off", "역방향 — C-C가 CL-C 명시값을 무시(독립)");
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verifyMode: "code", codexVerifyMode: "이상한값" }));
ok(CL.loadContract(ws, "ko").codexVerifyMode === "code", "무효 명시값은 fallback(정규화)");

console.log("[2] 물질화 금지(ⓒ) — 모드 전환·CL-C형 저장이 codexVerifyMode를 만들지 않음 + 언어 슬롯 독립");
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verifyMode: "always" }));
ok(CL.patchContractFields(ws, "ko", { harnessMode: "codex-codex" }) === true, "모드 전환=harnessMode 단일 patch");
ok(!("codexVerifyMode" in rawC(ws, "ko")) && rawC(ws, "ko").harnessMode === "codex-codex", "전환 후에도 원시 파일에 codexVerifyMode 없음(상속 과도 상태 보존)");
ok(CL.patchContractFields(ws, "ko", { claude: ["r"], codex: ["v"], claudeInjectMode: "always", verifyMode: "code", scoutMode: "off" }) === true, "CL-C형 일반 저장 patch");
ok(!("codexVerifyMode" in rawC(ws, "ko")), "CL-C 일반 저장도 codexVerifyMode 비물질화");
ok(CL.loadContract(ws, "ko").codexVerifyMode === "code", "상속 과도 상태 — CL-C 변경(code)이 C-C 실효값도 따라 바뀜(문서 명시 한계)");
ok(CL.patchContractFields(ws, "ko", { codexVerifyMode: "always" }) === true, "명시적 C-C 저장에서만 물질화");
c1 = CL.loadContract(ws, "ko");
ok(rawC(ws, "ko").codexVerifyMode === "always" && c1.verifyMode === "code" && c1.codexVerifyMode === "always", "물질화 후 독립 정본 — CL-C(code)/C-C(always) 공존");
CL.patchContractFields(ws, "ko", { harnessMode: "claude-codex" });
CL.patchContractFields(ws, "ko", { harnessMode: "codex-codex" });
c1 = CL.loadContract(ws, "ko");
ok(c1.verifyMode === "code" && c1.codexVerifyMode === "always", "모드 왕복에도 두 스위치 그대로(왕복 독립 보존)");
ok(!fs.existsSync(CL.contractFileFor(ws, "en")) || rawC(ws, "en").codexVerifyMode === undefined, "en 언어 슬롯 불침(언어별 독립)");

console.log("[3] C-C 게이트 기능 반례(ⓓ) — 훅이 자기 슬롯(codexVerifyMode)만 따름");
const sid = "aaaaaaaa-1111-2222-3333-444444444444";
fs.writeFileSync(path.join(sessions, "rollout-t-" + sid + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id: sid, source: "vscode", thread_source: "user", cwd: ws } }) + "\n");
fs.writeFileSync(path.join(tmp, "links.json"), JSON.stringify({ byWorkspace: {}, bySession: {}, modelPrefs: {}, settings: {} }));
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ harnessMode: "codex-codex", codexImplementer: ["IMPL_RULE"], verifyMode: "off", codexVerifyMode: "always" }));
const hook = path.join(ROOT, "bridge", "codex-hook.js");
const env = { ...process.env, CODEX_BRIDGE_HOME: tmp, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode" };
const run = (input) => cp.spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8", env, timeout: 10000 });
let r = run({ hook_event_name: "UserPromptSubmit", session_id: sid, turn_id: "t1", cwd: ws, model: "m", permission_mode: "default" });
ok(/IMPL_RULE/.test(r.stdout) && /ask-start/.test(r.stdout), "CL-C=off·C-C=always → 구현 주입에 검증 지시 포함(C-C 슬롯 승리)");
r = run({ hook_event_name: "Stop", session_id: sid, turn_id: "t1", cwd: ws, permission_mode: "default" });
ok(/"decision":"block"/.test(r.stdout), "CL-C=off여도 C-C=always면 Stop 강제(분리 핵심 반례)");
CL.patchContractFields(ws, "ko", { verifyMode: "always", codexVerifyMode: "off" });
r = run({ hook_event_name: "UserPromptSubmit", session_id: sid, turn_id: "t2", cwd: ws, model: "m", permission_mode: "default" });
ok(/IMPL_RULE/.test(r.stdout) && !/ask-start/.test(r.stdout), "C-C=off면 CL-C=always여도 주입에 검증 지시 없음");
r = run({ hook_event_name: "Stop", session_id: sid, turn_id: "t2", cwd: ws, permission_mode: "default" });
ok(r.stdout === "", "C-C=off → Stop 통과(CL-C 명시값이 C-C 게이트로 새지 않음)");

console.log("[4] 음성 회귀(ⓓ 소스 계약) — CL-C 경로는 verifyMode만, C-C 경로는 codexVerifyMode만");
const vg = fs.readFileSync(path.join(ROOT, "bridge", "verify-guard.js"), "utf8");
const ci = fs.readFileSync(path.join(ROOT, "bridge", "contract-inject.js"), "utf8");
const ch = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
const clSrc = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
ok(!vg.includes("codexVerifyMode") && /c\.verifyMode === "off"/.test(vg), "verify-guard(CL-C 전용) — codexVerifyMode 미사용(누출 없음)");
ok(!ci.includes("codexVerifyMode") && /c\.verifyMode && c\.verifyMode !== "off"/.test(ci), "contract-inject(CL-C 전용) — codexVerifyMode 미사용");
ok(/c\.codexVerifyMode!=="off"/.test(ch) && /const vmCc=c\.codexVerifyMode/.test(ch), "codex-hook(C-C) — 주입·Stop 판정 모두 codexVerifyMode");
ok(/harnessModeSnap === "codex-codex" \? contractSnap\.codexVerifyMode : contractSnap\.verifyMode/.test(cb), "브릿지 통계 스냅샷 — 현재 운용 모드 슬롯 선택");
const stFn = cb.slice(cb.indexOf("function cmdStatus()"), cb.indexOf("function cmdAskActive"));
ok(/cST\.harnessMode === "codex-codex" \? cST\.codexVerifyMode : cST\.verifyMode/.test(stFn) && /CL-C=\$\{cST\.verifyMode\} \/ C-C=\$\{cST\.codexVerifyMode\}/.test(stFn), "CLI status 명령 본체 — 현재 모드 실효값+양 슬롯 병기(1차 지적 5: doctor만 있던 공백)");
ok(/c\.harnessMode === "codex-codex" \? c\.codexVerifyMode : c\.verifyMode/.test(cb) && /CL-C=\$\{c\.verifyMode\} \/ C-C=\$\{c\.codexVerifyMode\}/.test(cb), "CLI doctor — 동일 계약 병기");
// 기능: status를 실제 실행해 현재 모드 실효값+양 슬롯이 출력되는지(계약 상태는 [3] 마지막 patch — C-C 모드·CL-C=always/C-C=off)
const stRun = cp.spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "status"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: tmp, CLAUDE_PROJECT_DIR: ws }, timeout: 15000 });
ok(/검증 모드: off \(현재 Codex-Codex 모드 기준 · CL-C=always \/ C-C=off\)/.test(stRun.stdout), "status 실행 — 현재 모드 실효값(off)+양 슬롯 병기 실출력" + (stRun.error ? " [spawn 불가 환경: " + stRun.error.code + "]" : ""));
ok(/function normCodexVerifyMode\(o\) \{\s*\n\s*if \(o && VERIFY_MODES\.includes\(o\.codexVerifyMode\)\) return o\.codexVerifyMode;\s*\n\s*return normVerifyMode\(o\);/.test(clSrc), "contract-lib — 정규화가 normVerifyMode 전체 재사용(원시 폴백 금지)");
ok(/"codexVerifyMode": "off"/.test(fs.readFileSync(path.join(ROOT, "bridge", "contract.example.json"), "utf8")), "예제 스키마에 신규 필드");

console.log("[5] 확장 소스 계약(ⓒⓔ) — exact patch·비물질화·모드 전환 단일 patch·reqId 왕복");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/function normCodexVerifyMode\(o: any\): VerifyMode \{\s*\n\s*if \(o && VERIFY_MODES\.includes\(o\.codexVerifyMode\)\) return o\.codexVerifyMode;\s*\n\s*return normVerifyMode\(o\);/.test(ext), "확장 normCodexVerifyMode — 브릿지와 동형(스키마 정합)");
ok(/codexVerifyMode: VerifyMode;/.test(ext) && /codexVerifyMode: normCodexVerifyMode\(o\),/.test(ext), "Contract 인터페이스+normalize에 신규 필드");
ok(!/function saveContract\(/.test(ext), "옛 saveContract(정규화 전체 병합 기록) 제거 — 봉인(물질화 누출 경로 폐쇄)");
ok(/function patchContractExt\(ws: string \| null, lang: Lang \| undefined, patch: Record<string, unknown>\): boolean/.test(ext) && /const file = ws \? contractFileFor\(ws, lang\) : CONTRACT_FILE;/.test(ext), "patchContractExt — 무폴더 창 CONTRACT_FILE fallback 포함");
ok(/if \(!e \|\| e\.code !== "ENOENT"\) return false;/.test(ext) && /if \(!cur \|\| typeof cur !== "object" \|\| Array\.isArray\(cur\)\) return false;/.test(ext), "patchContractExt — 손상 fail-closed·부재만 신설(P-1 규약)");
ok(/patchContractExt\(dashboardWorkspace\(\), slotLang, \{ harnessMode: m\.mode \}\)/.test(ext), "모드 전환=harnessMode 단일 patch(정규화 전체 재저장 제거)");
ok(/codexVerifyMode: normVerifyMode\(\{ verifyMode: m\.verifyMode \}\),/.test(ext) && /C-C 검증 스위치의 유일 물질화 지점/.test(ext), "C-C 일반 저장 분기에서만 codexVerifyMode 기록");
const ccBranch = ext.slice(ext.indexOf('const patch: Record<string, unknown> = mode === "codex-codex"'), ext.indexOf("const ok = patchContractExt(dashboardWorkspace(), slotLang, patch);"));
ok(ccBranch.length > 0 && !ccBranch.includes("harnessMode:") && !/\.\.\.prev/.test(ccBranch), "일반 저장 patch에 harnessMode·prev 전개 없음(외부 전환 미되돌림+비물질화)");
ok((ccBranch.match(/scoutMode: normScoutMode/g) || []).length === 2 && !ccBranch.includes("Checklist:"), "공용 허용목록=scoutMode뿐·체크리스트 제외(즉시 저장 소유)");
ok(/target: "contract", ok, reqId: typeof m\.reqId === "string" \? m\.reqId : null/.test(ext) && /target: "contract", ok: false, reqId: typeof m\.reqId === "string" \? m\.reqId : null/.test(ext), "계약 saveResult 두 경로(성공/취소) 모두 reqId 에코");

console.log("[6] 웹뷰 배선(ⓕ) — 모드별 표시·잠금·되돌리기·hold 표시 계약");
ok(/appVM = \(ccMode \? d\.contract\.codexVerifyMode : d\.contract\.verifyMode\) \|\| "off";/.test(ext), "카드 적용값 — 렌더 모드의 슬롯 스위치");
ok(/d\.contract\.harnessMode==="codex-codex" \? d\.contract\.codexVerifyMode : d\.contract\.verifyMode/.test(ext), "상태줄·온보딩 — 현재 운용 모드 실효값");
ok(/if \(cardM\.saving\(\)\) return;/.test(ext) && /var beg = cardM\.beginSave\(rid, \{imCh:imCh, vmCh:vmCh\}\);/.test(ext) && /harnessMode: beg\.mode, reqId: rid/.test(ext), "저장 — single-flight+대상 슬롯 동결(beg.mode)+reqId");
ok(/if \(!cardM\.canSwitch\(cardDirtyNow\(\)\)\)/.test(ext), "모드 버튼 — dirty·저장대기 전환 잠금(P-10 카드 전체 한 계약)");
ok(/\$\("revertC"\)\.addEventListener/.test(ext) && /cardM\.revert\(\)\.act !== "reload"/.test(ext) && /id="revertC"/.test(ext), "명시적 되돌리기 버튼(초안 폐기+재적재) — 잠금 해제 수단");
ok(/var cr = cardM\.result\(ev\.data\);\s*\n\s*if \(cr\.act === "ignore"\) return;/.test(ext), "계약 saveResult — cardM이 유일 권위(타 저장·낡은 응답 no-op)");
ok(/var cm = cardM\.renderedMode\(\) \|\| harnessMode;/.test(ext), "체크박스 필드 좌표도 렌더된 슬롯 기준");
ok(/var ccCard = holdMode \? cardStLast\.renderedMode === "codex-codex" : cc;/.test(ext) && /\$\("implRulesTitle"\)\.textContent=ccCard\?/.test(ext), "hold 중 카드 라벨=renderedMode 고정(표시 계약)");
ok(/cardStLast\.act === "hold"/.test(ext) && /cardNotice\(T\("운용 모드가 "/.test(ext), "hold 안내 — 런타임 모드 vs 카드 슬롯 구분 표기");
ok(/const forceSync = cardStLast\.first === true && !first;/.test(ext), "되돌리기 후 저장값 강제 동기화 경로");
// 구현검증 1차 지적 1~4 봉합 배선
ok(/function cardInputLock\(on\)\{/.test(ext) && /cardInputLock\(true\); \/\/ 응답 전 재편집 차단/.test(ext) && /cardInputLock\(false\); \/\/ 응답 도착/.test(ext) && /if \(cardM\.expire\(rid\)\.act === "fail"\) \{ cardInputLock\(false\);/.test(ext), "지적1 — 저장 대기 중 카드 입력 잠금(시작·응답·만료 3지점 배선, 무음 소실 봉합)");
ok((ext.match(/if\(cardM\.saving\(\)\) return; const b=ev\.target\.closest/g) || []).length === 4, "지적1 — 세그 4종(검증 모드·주입·트랙·P-12 프로필)도 저장 대기 중 입력 차단");
ok(/var baseDirtyAny = !!\(baseM\.locked\(\) \|\| baseDirty\.verify \|\| baseDirty\.transmit \|\| baseDirty\.rejudge \|\| baseDirty\.scout\);/.test(ext) && /if \(cardDirtyNow\(\) \|\| cardM\.saving\(\) \|\| baseDirtyAny\) \{/.test(ext), "지적2 — 언어 전환도 미저장 초안·저장 대기 중 차단(HTML 재생성이 초안·상태기 파괴 — base 잠금 포함)");
// [2차 지적 1] 자기치유는 fill 내부가 아니라 hold 판정 '전'(라벨 블록)에서, 렌더 슬롯(renderedMode) 기준으로 실행 —
// 외부 전환 hold 중에도 디스크가 초안을 따라잡으면 dirty가 풀려 hold가 자연 해소된다(영구 잠금 차단).
ok(/dirty 자기치유\(구현검증 2차 지적 1 — hold 판정보다 먼저\)/.test(ext) && /contractDirty\.claude = false;/.test(ext) && ext.indexOf("dirty 자기치유(구현검증 2차 지적 1") < ext.indexOf("cardStLast = d.contract ?"), "지적3→2차1 — 자기치유가 hold 판정 전·렌더 슬롯 기준으로 실행");
ok(/if \(appVM!==null && curVM!==appVM && curVM===preVM\) appVM = curVM;/.test(ext) && /if \(appIM!==null && curIM!==appIM && curIM===preIM\) appIM = curIM;/.test(ext), "2차1 — 세그 기준선 따라잡기(hold 중 fill이 못 하는 appX 승격)");
ok(/\(!renderedLangC \|\| !d\.lang \|\| d\.lang === renderedLangC\)/.test(ext), "2차1 — 언어 슬롯이 갈린 동안은 비교 생략(타 언어 우연 일치로 옛 슬롯 초안 소실 방지)");
ok(!/value === inC\) contractDirty\.claude = false/.test(ext), "2차1 — fill 내부의 옛 자기치유 제거(이중 로직 금지 — 라벨 블록 단일 담당)");
// [2차 지적 2] 다른 창발 전역 언어 변경의 HTML 재생성(초안·상태기 파괴)을 호스트가 dirty 결속으로 보류
ok(/m\?\.type === "cardDirtyState"/.test(ext) && /this\.cardDirty = !!m\.dirty; this\.cardDirtyAt = Date\.now\(\)/.test(ext), "2차2 — 호스트가 웹뷰 초안/저장대기 상태를 결속 수신");
ok(/const dirtyHold = this\.cardDirty && Date\.now\(\) - this\.cardDirtyAt < 15 \* 60 \* 1000;/.test(ext) && /if \(!dirtyHold\) this\.panel\.webview\.html = this\.html\(this\.panel\.webview\);/.test(ext), "2차2 — post()의 언어 HTML 재생성을 dirty 동안 보류(15분 신선도 백스톱)");
// [3차 지적 1] ready는 만료·되돌리기·복구의 '정본 재요청'으로 재사용된다 — dirty 리셋은 부팅(boot:true) 1회에만.
ok(/if \(m\.boot === true\) \{ this\.cardDirty = false; this\.cardDirtyAt = 0; \}/.test(ext), "3차1 — 결속 리셋은 boot:true에서만(일반 ready는 dirty 불변)");
ok(/\{type:"ready", boot:true\}/.test(ext) && (ext.match(/, boot:true\}/g) || []).length === 1, "3차1 — boot 신호는 문서 부팅 핸드셰이크 1곳뿐(재요청 ready와 분리)");
ok(/reportCardDirty\(\); \/\/ 결속 갱신을 ready보다 먼저/.test(ext) && /reportCardDirty\(\); \/\/ ready보다 먼저/.test(ext), "3차1 — 되돌리기 2종 모두 결속 갱신을 ready보다 먼저 전송(순서 보장)");
// [3차 지적 2] 15분 백스톱의 의미 교정 — dirty=true 동안 매 data 푸시 심박으로 cardDirtyAt 신선 유지(살아있는
// 장시간 편집은 절대 소실 안 됨 · 죽은 웹뷰=초안도 이미 소멸이라 fail-open 무해).
ok(/function reportCardDirty\(hb\)\{/.test(ext) && /if \(v === lastReportedDirty && !\(hb && v\)\) return;/.test(ext) && /reportCardDirty\(true\); \}\);/.test(ext), "3차2 — dirty 심박(매 푸시 재전송)으로 백스톱이 '죽은 웹뷰'만 놓음");
// [3차 지적 3] 자기치유 비교=저장 페이로드와 동일 정규화(trim·빈 줄 제거) — 후행 공백만으로 영구 dirty 차단
ok(/function normLines\(s\)\{ return String\(s\|\|""\)\.split\("\\\\n"\)\.map\(function\(x\)\{ return x\.trim\(\); \}\)\.filter\(Boolean\)\.join\("\\\\n"\); \}/.test(ext), "3차3 — normLines(저장 toLines와 동일 규칙)");
ok(/normLines\(\$\("cClaude"\)\.value\) === normLines\(preC\)/.test(ext) && /normLines\(\$\("cCodex"\)\.value\) === normLines\(preX\)/.test(ext), "3차3 — 자기치유가 정규화 비교 사용");
// [3차 지적 4] 보류 중 언어 표시 권위 — 버튼 선택=렌더 언어(UI_EN) 기준 + 보류 사실 안내(langhold)
ok(/var uiLangNow = UI_EN \? "en" : "ko";/.test(ext) && /lk\.classList\.toggle\("on", uiLangNow==="ko"\)/.test(ext), "3차4 — 언어 버튼 표시는 렌더 언어 기준(새 언어 선택+옛 화면 혼합 차단)");
ok(/if \(d\.lang !== uiLangNow && cardNoticeKind !== "hold"\)/.test(ext) && /"langhold"\)/.test(ext), "3차4 — 보류 중 '기존 언어 유지' 안내(모드 hold 안내와 겹침 방지 우선순위)");
// [4차 지적 1 → 5차 재구성] base 저장·복원 전용 single-flight를 순수 상태기 baseMachine으로 — 공유 pendingSave는
// 모델·타임아웃·DeepSeek 저장이 덮어 권위가 못 됨(경합 실반례). 성공은 refillWait로 넘어가 '정본 fill'에서만 해제.
ok(/function baseMachine\(\)\{/.test(ext) && ext.indexOf("[P9V-BASE-BEGIN]") > 0 && ext.indexOf("// [P9V-BASE-END]") > ext.indexOf("function baseMachine()"), "4차1 — baseMachine 순수 상태기(마커 추출 가능)");
ok(/function baseInputLock\(on\)\{/.test(ext) && /\["saveB","resetB"\]\.forEach/.test(ext) && /\["bVerify","bTransmit","bRejudge","bScout"\]\.forEach/.test(ext) && /rv\.disabled = baseM\.saving\(\);/.test(ext), "4차1 — 저장·복원 버튼+4필드 입력을 정본 확인까지 잠금(되돌리기는 응답 대기만 — 복구 수단)");
ok(/type:"saveBase", reqId: rid/.test(ext) && /type:"resetBase", reqId: rid/.test(ext), "4차1 — saveB·resetB 모두 reqId 동봉");
ok((ext.match(/target: "base", ok, reqId: typeof m\.reqId === "string" \? m\.reqId : null/g) || []).length === 2, "4차1 — 호스트가 saveBase·resetBase 두 응답 모두 reqId 에코");
ok(/var br = baseM\.result\(ev\.data\);\s*\n\s*if \(br\.act === "ignore"\) return;/.test(ext), "4차1 — 웹뷰 소비도 reqId 대조(낡은·타 응답 no-op — 잠금 권위 불변)");
ok(/if \(baseM\.saving\(\)\) \{ cardNotice\(T\("기본 원칙 저장 응답/.test(ext) && !/pendingSave && pendingSave\.target === "base"/.test(ext), "4차1 — revertB 잠금 권위를 전용 상태로 교체(응답 대기만 잠금 — refillWait 복구 수단으로 허용·6차1)");
ok(/baseM\.locked\(\) \|\| baseDirty\.verify/.test(ext), "4차1 — 결속 합성·언어 가드·langhold에 base 잠금 포함");
// [5차 지적 1 + 6차 지적 1] 성공/만료 후 저장 경로는 '정본 fill'에서만 회복 — 강제 해제(forceUnlock) 백스톱 제거
ok(/if \(baseM\.fill\(\)\.act === "unlock"\) \{ baseInputLock\(false\); reportCardDirty\(\); \}/.test(ext) && !/forceUnlock/.test(ext) && !/baseRefillTimer/.test(ext), "5차1+6차1 — 정본 fill에서만 잠금 해제(강제 해제 경로 완전 제거)");
ok(/const scoutSettled = !\(d\.contract && d\.contract\.scoutMode === "on"\) \|\| !!d\.scoutPrompt \|\| !d\.workspace;/.test(ext) && /if \(d\.baseDirective && !holdB && scoutSettled && baseCanon\) \{/.test(ext), "6차4+7차1 — 3트랙 정찰 정본 확인·무폴더 예외(전역 3트랙 영구 잠금 교착 제거)·판독 불신 보류");
// [7차2 → 8차 지적 3·4] strict 단일 판독 — 같은 바이트에서 신뢰+데이터 산출, 의미 손상(비객체 루트·비문자열 필드)도 불신
ok(/function readCanonFile\(file: string, fields: string\[\]\): \{ ok: boolean; o: any \}/.test(ext) && /return \{ ok: !!e && e\.code === "ENOENT", o: \{\} \};/.test(ext) && /if \(!p \|\| typeof p !== "object" \|\| Array\.isArray\(p\)\) return \{ ok: false, o: \{\} \};/.test(ext) && /if \(p\[f\] !== undefined && typeof p\[f\] !== "string"\) return \{ ok: false, o: \{\} \};/.test(ext), "8차3 — readCanonFile(부재=정상·파싱/의미 손상=불신·단일 판독)");
ok(/function computeBaseState\(ws: string \| null, contract: Contract, lang: Lang\)/.test(ext) && /baseReadOk: b\.readOk && \(!scoutRelevant \|\| scoutOk\),/.test(ext) && /const scoutRelevant = !!ws && contract\.scoutMode === "on";/.test(ext), "8차4 — base 축 단일 조립(신뢰·데이터 같은 푸시 결속, 정찰 신뢰는 3트랙+ws만 합성)");
ok(/const r = readCanonFile\(file, \["verifyBaseline", "transmit", "rejudge"\]\);/.test(ext) && /readCanonFile\(lib\.scoutBaselineFileFor\(lang\), \["baseline"\]\)/.test(ext) && !/baseReadOkNow/.test(ext), "8차4 — 로더도 같은 strict 판독 사용(이중 판독 probe 제거)");
ok(/const baseCanon = d\.baseReadOk !== false;/.test(ext) && /if \(baseCanon && d\.baseDirective && \(!renderedLangB/.test(ext) && /if \(d\.baseDirective && !holdB && baseCanon\)\{/.test(ext) && /!holdB && baseCanon && document\.activeElement !== \$\("bScout"\)/.test(ext), "7차2 — 불신 동안 자기치유·본문 fill·정찰 fill 보류");
// [8차 지적 1 → 9차 지적 1] ④칸 노출=scoutPrompt 실존 결속(무폴더·구 런타임·조립 실패 전부 — 빈 bScout 저장=전역 기준선 삭제 경로 차단)
ok(/const on = !!\(d\.contract && d\.contract\.scoutMode === "on"\) && !!d\.workspace && !!d\.scoutPrompt;/.test(ext), "9차1 — 정찰 칸은 scoutPrompt 실존 시에만(페이로드 구조 제외)");
ok(/scoutOk = false;\s*\n\s*\}\s*\n\s*\}\s*\n\s*\} catch \{ sp = null; scoutOk = false; \}/.test(ext) && /구 런타임\(helper 부재\)/.test(ext), "9차1 — 구 런타임·조립 예외는 정찰 신뢰 fail-closed(3트랙이면 저장 잠김)");
// [9차 지적 2] 언어 슬롯 단일 스냅샷 — 계약·기본값·파일 경로·라벨·lang 필드가 같은 캡처
ok(/const langSnap = loadLangExt\(\);/.test(ext) && /const contract = loadContract\(ws, langSnap\);/.test(ext) && /\.\.\.computeBaseState\(ws, contract, langSnap\),/.test(ext) && /lang: langSnap,/.test(ext), "9차2 — computeState가 언어를 1회 캡처해 전 축에 전달");
ok(/function loadBaseDirectiveSafe\(lang\?: Lang\)/.test(ext) && /lib\.baseDefaultsFor\(l\)/.test(ext) && /lib\.scoutBaselineFileFor\(lang\)/.test(ext) && /lib\.scoutBaselineDefaultFor\(lang\)/.test(ext), "9차2 — 파일·기본값 helper 모두 같은 슬롯 인자");
// [8차 지적 2] 판독 불신 동안 저장·복원 버튼도 차단(안내와 실동작 일치 — 저장기는 신뢰 판독 없이 덮거나 삭제)
ok(/\$\("saveB"\)\.disabled = !baseOk \|\| baseM\.locked\(\) \|\| !baseCanon;/.test(ext) && /\$\("resetB"\)\.disabled = !baseOk \|\| baseM\.locked\(\) \|\| !baseCanon;/.test(ext), "8차2 — !baseCanon이면 저장·복원 비활성(fail-closed)");
// [8차 지적 5] 안내 우선순위 — 모드 hold(P-10)·언어 hold가 판독 안내를 덮이지 않음
ok(/if \(cardNoticeKind !== "hold" && cardNoticeKind !== "langhold"\) cardNotice\(T\("기본 원칙 쪽 정본을 신뢰할 수 없어/.test(ext) && /브릿지 런타임이 오래된 경우/.test(ext), "8차5+10차2 — basecanon 안내는 상위 hold를 안 덮고, 원인 후보에 구 런타임(업데이트 필요)도 명시");
ok(/function otherSlotHasRules\(ws: string \| null, lang\?: Lang\)/.test(ext) && /otherSlotHasRules\(ws, langSnap\)/.test(ext), "10차1 — 반대 슬롯 안내도 langSnap 단일 스냅샷");

console.log("[6c] computeBaseState 실행 반례(10차 보완 3 — 컴파일 산출물 추출·의존성 주입)");
const outFile = path.join(ROOT, "out", "extension.js");
ok(fs.existsSync(outFile), "out/extension.js 존재(체인은 tsc 선행 — 없으면 npm run compile 또는 npx tsc -p ./ 후 재실행)");
if (fs.existsSync(outFile)) {
  const outSrc = fs.readFileSync(outFile, "utf8");
  const cbBeg = outSrc.indexOf("function computeBaseState(");
  const cbEnd = outSrc.indexOf("\nfunction ", cbBeg + 10);
  ok(cbBeg > 0 && cbEnd > cbBeg, "컴파일 산출물에서 computeBaseState 추출 가능");
  // 컴파일 산출물은 scoutLedgerNotes/scoutDirectiveText를 모듈 한정자(scope_package_1.*)로 참조 — 그 이름으로 주입.
  const mk = (deps) => new Function("loadBaseDirectiveSafe", "bridgeLib", "readCanonFile", "scope_package_1",
    outSrc.slice(cbBeg, cbEnd) + "\nreturn computeBaseState;")(
    deps.base || (() => ({ verifyBaseline: "v", transmit: "t", rejudge: "r", overridden: false, readOk: true })),
    deps.lib, deps.read || (() => ({ ok: true, o: {} })),
    { scoutLedgerNotes: () => ({ header: "h", trusted: "t", reference: "r", disputed: "d" }), scoutDirectiveText: () => "dir" });
  const oldLib = { loadScoutBaseline: () => ({ text: "x", overridden: false }) }; // 구 런타임 — 신규 helper 부재
  const newLib = { scoutBaselineDefaultFor: () => "DEF", scoutBaselineFileFor: () => "f", SCOUT_FORMAT_VERSION: "f1" };
  let cbr = mk({ lib: () => oldLib })("D:/ws", { scoutMode: "on" }, "ko");
  ok(cbr.baseReadOk === false && cbr.scoutPrompt === null, "CB① 3트랙+ws+구 런타임 → fail-closed(저장 잠김)+칸 숨김(sp null)");
  cbr = mk({ lib: () => oldLib })("D:/ws", { scoutMode: "off" }, "ko");
  ok(cbr.baseReadOk === true, "CB② 2트랙은 구 런타임이어도 base 저장에 비전파(scoutRelevant=false)");
  cbr = mk({ lib: () => newLib, read: () => ({ ok: false, o: {} }) })("D:/ws", { scoutMode: "on" }, "ko");
  ok(cbr.baseReadOk === false && cbr.scoutPrompt && cbr.scoutPrompt.baseline === "DEF", "CB③ 정찰 파일 의미 손상 → 칸은 기본값으로 보이되 신뢰=false(저장은 baseCanon이 잠금)");
  cbr = mk({ lib: () => ({ ...newLib, scoutBaselineFileFor: () => { throw new Error("x"); } }) })("D:/ws", { scoutMode: "on" }, "ko");
  ok(cbr.baseReadOk === false && cbr.scoutPrompt === null, "CB④ 조립 예외 → fail-closed+칸 숨김");
  cbr = mk({ lib: () => newLib })(null, { scoutMode: "on" }, "ko");
  ok(cbr.baseReadOk === true && cbr.scoutPrompt === null, "CB⑤ 무폴더는 정찰 무관(교착·삭제 경로 모두 구조 제외)");
}
// [6차 지적 2] 만료=결과 불확실 — 저장 경로 잠금 유지+복원(reset) 만료는 초안 폐기(지각 성공 시 옛 초안 오도 차단)
ok(/act: "uncertain", pd: pd/.test(ext) && /if \(ex\.pd && ex\.pd\.kind === "reset"\) \{ baseDirty = \{\};/.test(ext), "6차2 — 만료 uncertain 계약+reset 만료 초안 폐기");
ok(/baseBegin\(null, "save"\)/.test(ext) && /, "reset"\); if \(!rid\) return;/.test(ext), "6차2 — 저장/복원 의도(kind)를 요청에 결속");
// [5차 지적 2] 언어 hold 결속 — holdB에 저장 대기, langhold 안내에 baseM.locked 포함
ok(/const holdB = langChangedB && \(baseM\.saving\(\) \|\|/.test(ext), "5차2 — holdB에 base 저장 대기 포함(초안 없는 복원 대기의 언어 혼합 차단)");
// [5차 부수] 버튼 표시 회귀 — state 푸시의 재활성이 잠금을 덮지 않음 / base 자기치유(trim 동등성 — 6차3)
ok(/\$\("saveB"\)\.disabled = !baseOk \|\| baseM\.locked\(\) \|\| !baseCanon;/.test(ext) && /\$\("revertB"\)\.disabled = baseM\.saving\(\);/.test(ext), "5차 — 버튼 재활성이 baseM 잠금·판독 신뢰와 OR(되돌리기는 saving만)");
ok(/\$\("bVerify"\)\.value\.trim\(\) === \(d\.baseDirective\.verifyBaseline\|\|""\)\.trim\(\)\) baseDirty\.verify = false;/.test(ext) && /d\.scoutPrompt && \$\("bScout"\)\.value\.trim\(\) === \(d\.scoutPrompt\.baseline\|\|""\)\.trim\(\)\) baseDirty\.scout = false;/.test(ext), "5차+6차3 — base dirty 자기치유(4필드·trim 동등성 — 저장기 정규화와 일치)");

console.log("[6b] baseMachine 실행 반례(5차 요구 — 정규식 아닌 상태 전이)");
const bBeg = ext.indexOf("function baseMachine()"), bEnd = ext.indexOf("// [P9V-BASE-END]");
const baseMachineX = new Function("return (" + ext.slice(bBeg, bEnd).trim() + ")")();
let BM = baseMachineX();
ok(BM.begin("b1", "복원됨", "reset") !== null && BM.begin("b2") === null && BM.saving() === true && BM.locked() === true, "B① begin=단일-flight(대기 중 재시작 거부)+잠금");
ok(BM.result({ reqId: "다른저장", ok: true }).act === "ignore" && BM.locked() === true, "B② 타 reqId 응답은 잠금 못 풂(공유 pendingSave 경합의 구조 제거)");
let bres = BM.result({ reqId: "b1", ok: true });
ok(bres.act === "commit" && bres.pd.msg === "복원됨" && bres.pd.kind === "reset" && BM.saving() === false && BM.locked() === true, "B③ 성공=commit이어도 잠금 유지(refillWait — '복원됨 ✓' 아래 옛 값 재저장 창 제거)");
ok(BM.begin("b3") === null, "B④ refillWait 동안도 새 저장 거부(옛 DOM 값 재기록 차단)");
ok(BM.fill().act === "unlock" && BM.locked() === false && BM.fill().act === "none", "B⑤ 정본 fill에서만 해제(이중 fill 무해)");
let BM2 = baseMachineX();
BM2.begin("b5", null, "save");
ok(BM2.result({ reqId: "b5", ok: false }).act === "fail" && BM2.locked() === false, "B⑥ 실패=즉시 해제(초안 유지·재시도 가능)");
let BM3 = baseMachineX();
BM3.begin("b6", null, "reset");
ok(BM3.expire("낡은").act === "ignore" && BM3.locked() === true, "B⑦-1 낡은 rid 만료는 무시(잠금 불변)");
let bex = BM3.expire("b6");
ok(bex.act === "uncertain" && bex.pd.kind === "reset" && BM3.saving() === false && BM3.locked() === true, "B⑦-2 만료=uncertain — 결과 불확실 동안 저장 경로 잠금 유지(6차1: 즉시 해제가 옛 값 재저장 창을 열던 회귀 제거)");
ok(BM3.result({ reqId: "b6", ok: true }).act === "ignore" && BM3.locked() === true, "B⑧ 만료 후 지각 성공 ignore — 잠금은 정본 fill이 회복");
ok(BM3.fill().act === "unlock" && BM3.locked() === false, "B⑨ 만료 후에도 정본 fill이 유일한 회복 경로(강제 해제 없음)");
// [4차 보완 2] 동일 안내 재호출(매 푸시 hold/langhold)은 펄스·스크롤 반복 금지
ok(/var same = cardNoticeKind === \(kind \|\| "warn"\) && n\.textContent === msg && n\.style\.display !== "none";/.test(ext) && /if \(same\) return;/.test(ext), "4차2 — 같은 안내 재호출 시 flashNode·scroll 생략(15초마다 깜빡임 제거)");
ok((ext.match(/reportCardDirty\(/g) || []).length >= 10, "2차2 — 웹뷰가 전이 시 결속 전송(입력·세그·저장 시작/응답/만료·되돌리기 2종·base·push 심박 배선)");
// [2차 지적 3] 기본 원칙 되돌리기 + 안내 가시화
ok(/id="revertB"/.test(ext) && /\$\("revertB"\)\.addEventListener/.test(ext) && /baseDirty = \{\};/.test(ext), "2차3 — 기본 원칙 되돌리기 신설('저장 또는 되돌리기' 안내가 거짓이 되지 않게)");
ok(/n\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\)/.test(ext), "2차3 — 차단 안내로 스크롤(상단 버튼 옆 비가시 문제)");
ok(/\$\("flowImplRules"\)\.innerHTML=ccCard\?/.test(ext) && /\$\("flowImplMono"\)\.textContent=ccCard\?/.test(ext) && /\$\("baseTransmitTo"\)\.textContent=ccCard\?/.test(ext), "지적4 — 흐름도·단계원칙 라벨도 카드 슬롯(ccCard) 권위로 통일");
ok(/const vOn = !!\(vmEffOb && vmEffOb!=="off"\);/.test(ext) && !/holdC \? !!\(appVM && appVM!=="off"\)/.test(ext), "지적4 — 온보딩은 런타임 단일 권위(옛 appVM 혼합 제거)");

console.log("[7] cardMachine 순수 상태기 실행 반례(ⓕ·ⓖ)");
const mBeg = ext.indexOf("function cardMachine()"), mEnd = ext.indexOf("// [P9V-CARD-END]");
ok(ext.indexOf("[P9V-CARD-BEGIN]") > 0 && mBeg > 0 && mEnd > mBeg, "추출 마커·상태기 블록 존재");
const cardMachine = new Function("return (" + ext.slice(mBeg, mEnd).trim() + ")")();

// E1 미저장 초안 전환 잠금 + E2 저장 대기 전환 잠금
let M = cardMachine();
ok(M.state("claude-codex", false).act === "fill" && M.renderedMode() === "claude-codex", "E1① 최초 state=fill·렌더 슬롯 확정");
ok(M.canSwitch(true) === false && M.canSwitch(false) === true, "E1② dirty면 전환 잠금·깨끗하면 허용");
let beg = M.beginSave("r1", { vmCh: true });
ok(beg && beg.mode === "claude-codex" && M.beginSave("r2") === null, "E2① 저장 시작(대상=렌더 슬롯)+중복 저장 거부(single-flight)");
ok(M.canSwitch(false) === false, "E2② 저장 응답 대기 중엔 dirty 아니어도 전환 잠금");

// E3/E4 외부 전환 hold — pending만으로도 hold(4차 추가 반례), 저장 대상은 renderedMode 동결
ok(M.state("codex-codex", false).act === "hold", "E3① contractSavePending 중 외부 전환 → hold(dirty 아님에도)");
ok(M.renderedMode() === "claude-codex", "E3② hold 중 렌더 슬롯 유지(라벨·저장 대상 권위)");
let res = M.result({ reqId: "다른저장", ok: true });
ok(res.act === "ignore" && M.saving() === true, "E3③ 타 저장 응답(reqId 불일치)은 잠금 못 풂(pending 권위 불변)");
res = M.result({ reqId: "r1", ok: true });
ok(res.act === "commit" && res.pd.meta.vmCh === true && M.saving() === false, "E3④ 매칭 성공만 commit(+플래시 의도 meta 회수)");
ok(M.state("codex-codex", false).act === "fill" && M.renderedMode() === "codex-codex", "E3⑤ 저장 완료·초안 없음 → 다음 state가 새 모드 채움(hold 해소)");

// E5 dirty hold → 저장이 옛 슬롯으로
let H = cardMachine();
H.state("claude-codex", false);
ok(H.state("codex-codex", true).act === "hold", "E5① 미저장 초안 중 외부 전환 → hold");
let hb = H.beginSave("r3");
ok(hb.mode === "claude-codex", "E5② hold 중 저장해도 대상은 옛(렌더) 슬롯 — 새 모드 오염 없음");
H.result({ reqId: "r3", ok: true });
ok(H.state("codex-codex", false).act === "fill" && H.renderedMode() === "codex-codex", "E5③ 저장 후 hold 해소 — 새 슬롯 재적재");

// E6 되돌리기
let R = cardMachine();
R.state("claude-codex", false);
R.beginSave("r4");
ok(R.revert().act === "ignore", "E6① 저장 대기 중 되돌리기 불가");
R.result({ reqId: "r4", ok: false });
ok(R.saving() === false, "E6② 실패 응답 — 잠금 해제(초안 유지는 호출자 계약)");
ok(R.revert().act === "reload", "E6③ 되돌리기 — 초안 폐기 지시");
let st = R.state("codex-codex", false);
ok(st.act === "fill" && st.first === true, "E6④ 되돌리기 뒤 state는 무조건 fill(first) — 현재 모드 슬롯 강제 재적재");

// E7 만료·지각 응답·중복
let X = cardMachine();
X.state("claude-codex", false);
X.beginSave("r5");
ok(X.expire("낡은rid").act === "ignore" && X.saving() === true, "E7① 낡은 rid 만료는 무시");
ok(X.expire("r5").act === "fail" && X.saving() === false, "E7② 만료=fail(잠금 해제 — 영구 잠금 경로 없음)");
ok(X.result({ reqId: "r5", ok: true }).act === "ignore", "E7③ 만료 후 지각 성공 응답은 ignore(디스크 저장은 유효 — state가 정합)");
ok(X.expire("r5").act === "ignore", "E7④ 이중 만료 무해");

// E8 모드 왕복 추적
let W = cardMachine();
W.state("claude-codex", false);
W.state("codex-codex", false);
W.state("claude-codex", false);
ok(W.renderedMode() === "claude-codex", "E8 깨끗한 왕복은 렌더 슬롯이 런타임을 따라감");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
