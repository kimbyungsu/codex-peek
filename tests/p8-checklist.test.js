"use strict";
/*
 * P-8 1단(2026-07-15) — 체크리스트 강제 체크박스 즉시 저장.
 * 증상: 상태 푸시가 저장 클릭 전에 체크박스를 계약값으로 되돌려 옛값이 저장됨(C-C 모드 실사고).
 * 1단 계약: 토글=즉시 저장 · 호스트 재읽기-단일필드 병합 · 손상 JSON fail-closed(P-1 교훈) ·
 * 프로젝트×언어 독립+요청 서술자 결속(사용자 추가 요구) · 잠금 없음 — 진짜 동시 저장(읽기-읽기 겹침)은 서로 다른
 * 필드를 포함해 유실 가능(명시된 한계 · 2단 잠금이 해소). 순차 저장은 재읽기-병합이 보존.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p8_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const readC = (ws, lang) => JSON.parse(fs.readFileSync(CL.contractFileFor(ws, lang), "utf8"));

console.log("[1] 재읽기-단일필드 병합 — 다른 필드·규칙 불침");
const wsA = "D:/proj-a";
fs.mkdirSync(path.dirname(CL.contractFileFor(wsA, "ko")), { recursive: true });
fs.writeFileSync(CL.contractFileFor(wsA, "ko"), JSON.stringify({ harnessMode: "codex-codex", codexImplementer: ["규칙1"], codexVerifier: ["규칙2"], codexImplementerChecklist: true, codexVerifierChecklist: true, scoutMode: "on", scoutGate: "plan" }));
ok(CL.patchContractFields(wsA, "ko", { codexVerifierChecklist: false }) === true, "C-C 검증 체크리스트 false 패치 성공");
let c = readC(wsA, "ko");
ok(c.codexVerifierChecklist === false && c.codexImplementerChecklist === true && c.codexImplementer[0] === "규칙1" && c.scoutGate === "plan" && c.harnessMode === "codex-codex", "그 필드만 변경 — 규칙·다른 체크리스트·게이트·모드 전부 보존");

console.log("[2] 멀티창 '순차' 저장 보존 — 완료된 선행 저장은 재읽기가 보존(정직: 진짜 동시[읽기-읽기 겹침]는 타 필드도 유실 가능 — 무잠금 1단 한계·2단 잠금이 해소)");
CL.patchContractFields(wsA, "ko", { claudeChecklist: false });       // 창1: 다른 모드 필드 저장
CL.patchContractFields(wsA, "ko", { codexImplementerChecklist: false }); // 창2: 그 사이 다른 필드 저장
c = readC(wsA, "ko");
ok(c.claudeChecklist === false && c.codexImplementerChecklist === false && c.codexVerifierChecklist === false, "순차 저장 모두 생존(뒤 쓰기가 앞의 '완료된' 쓰기를 안 덮음 — 필드 단위 병합)");

console.log("[3] 프로젝트×언어 독립 — 다른 프로젝트·다른 언어 슬롯 불침");
const wsB = "D:/proj-b";
CL.patchContractFields(wsB, "ko", { claudeChecklist: false });
ok(readC(wsB, "ko").claudeChecklist === false && readC(wsA, "ko").codexVerifierChecklist === false, "프로젝트별 파일 분리 — 서로 불침");
CL.patchContractFields(wsA, "en", { claudeChecklist: false });
ok(fs.existsSync(CL.contractFileFor(wsA, "en")) && readC(wsA, "ko").claudeChecklist === false && readC(wsA, "en").claudeChecklist === false && readC(wsA, "en").codexVerifierChecklist === undefined, "언어 슬롯 분리 — en 패치가 ko를 안 건드리고 en에 ko 값이 새지 않음");

console.log("[4] 안전 — 손상 JSON은 기록 거부(fail-closed · P-1 교훈), 부재만 신설");
const wsC = "D:/proj-c";
fs.mkdirSync(path.dirname(CL.contractFileFor(wsC, "ko")), { recursive: true });
fs.writeFileSync(CL.contractFileFor(wsC, "ko"), "{깨진 JSON");
ok(CL.patchContractFields(wsC, "ko", { claudeChecklist: false }) === false, "손상 파일 → false(기록 거부)");
ok(fs.readFileSync(CL.contractFileFor(wsC, "ko"), "utf8") === "{깨진 JSON", "손상 원본 그대로 — {}로 축소해 덮어쓰지 않음");
fs.writeFileSync(CL.contractFileFor(wsC, "ko"), JSON.stringify(["배열"]));
ok(CL.patchContractFields(wsC, "ko", { claudeChecklist: false }) === false, "형식 불명(배열) → 기록 거부");
const wsD = "D:/proj-d";
ok(CL.patchContractFields(wsD, "ko", { claudeChecklist: false }) === true && readC(wsD, "ko").claudeChecklist === false, "파일 부재(ENOENT)만 신설 인정");
ok(CL.patchContractFields("", "ko", { a: 1 }) === false && CL.patchContractFields(wsD, "ko", null) === false && CL.patchContractFields(wsD, "ko", [1]) === false, "무효 입력 거부");

console.log("[5] 배선(소스 잠금) — 즉시 저장 경로가 유일 작성 경로");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/m\?\.type === "saveChecklist"/.test(ext) && /patchContractFields\?\.\(wsCk, slotLang, \{ \[field\]: !!m\.value \}\)/.test(ext), "호스트 saveChecklist 핸들러 — 재읽기-단일필드 병합 호출");
ok(/modeCk === "codex-codex"\s*\n\s*\? \(box === "codex" \? "codexVerifierChecklist" : "codexImplementerChecklist"\)/.test(ext), "필드 결정은 '저장된 운용모드' 기준(모드별 4필드 정확 매핑 — C-C 실사고 커버)");
ok(/dashboardWorkspace\(\);\s*\n\s*const box/.test(ext) && /프로젝트별·언어별 독립/.test(ext), "창별 자기 워크스페이스 앵커(프로젝트×언어 독립 근거 주석)");
ok(!/codexImplementerChecklist: !!m\.claudeChecklist/.test(ext) && !/claudeChecklist: !!m\.claudeChecklist/.test(ext), "큰 저장(rolePatch)에서 체크리스트 제외 — 낡은 화면값이 버튼 저장에 실리는 재발 경로 차단");
ok(!/claudeChecklist: \$\("ckClaude"\)\.checked/.test(ext), "웹뷰 저장 페이로드에서도 체크리스트 제거");
ok(/type: "saveChecklist", box: pr\[1\], value: el\.checked, lang: renderedLangC \|\| undefined/.test(ext) && /if \(!ckM\[pr\[1\]\]\.idle\(\) \|\| ckModeLock\) return;/.test(ext), "토글 change → 즉시 저장 전송 + 상태기 단일-flight(대기 중·모드 잠금 중 입력 차단)");
ok(/if \(ckM\.claude\.state\(\)\.act === "fill"\) \{ \$\("ckClaude"\)\.checked/.test(ext) && /if \(ckM\.codex\.state\(\)\.act === "fill"\) \{ \$\("ckCodex"\)\.checked/.test(ext), "상태 푸시는 상태기 허가(fill)로만 채움+재활성 — 대기 중(skip) 되돌림 불가(증상의 구조 제거)·hold 복구도 이 경로만");
ok(/var ckR = ckM\[ckKey\]\.result\(ev\.data, ckExpectedField\(ckKey\), renderedLangC \|\| null\);/.test(ext) && /if \(ckR\.act === "ignore"\) return;/.test(ext) && /clearTimeout\(ckR\.pd\.timer\)/.test(ext), "응답 수신 — 소비 시점의 화면 좌표(기대 field·현재 lang)를 상태기에 전달해 소비(불일치=완전 no-op·매칭 시 타이머 해제)");
ok(/if \(ckR\.act === "commit"\) \{/.test(ext) && /if \(ckEl\) \{ if \(!ckModeLock\) ckEl\.disabled = false;/.test(ext) && !/appCkX !== null \? appCkX : ckEl\.checked/.test(ext), "성공(commit)만 재활성+기준선 — 실패 경로의 '옛 기준선 되돌림+재활성' 제거(Codex 5차 반례: 모드 바뀐 화면에 옛 모드 값 노출)");
ok(/disabled 유지, ready로 정본 state를 요청해 채움에 위임/.test(ext) && /try \{ vscode\.postMessage\(\{ type: "ready" \}\); \} catch\(e\)\{\}\s*\n\s*\}\s*\n\s*return;/.test(ext), "실패·거부(hold) — 재활성 없이 ready로 정본 재렌더 요청(값·활성화는 state 채움 전담)");
ok(/act: resp\.ok \?/.test(ext) === false && /pd\.field !== curField \|\| pd\.lang !== curLang\) return \{ act: "hold", pd: pd \};/.test(ext), "성공 응답도 화면 좌표 불일치면 hold — 옛 모드/언어 값이 새 화면 기준선을 오염 못 함(Codex 6차 대칭 반례)");
ok(/!renderedMode \|\| renderedMode !== modeCk/.test(ext) && /staleMode: true/.test(ext), "모드 결속 fail-closed — 모드 누락도 거부(null 통과 금지·Codex 3차)+불일치 시 기록 거부+재렌더");
ok(/mode: harnessMode/.test(ext) && /ckModeLock = true; if\(\$\("ckClaude"\)\) \$\("ckClaude"\)\.disabled = true/.test(ext) && /ckModeLock = false;/.test(ext), "전송에 렌더 모드 동봉 + 모드 클릭 시 잠금 set·state 도착 시 해제(잠금의 양끝 배선)");
ok(/ckM\[pr\[1\]\]\.begin\(rid, ckExpectedField\(pr\[1\]\), renderedLangC \|\| null, setTimeout\(function\(\)\{ ckExpire\(pr\[1\], rid\); \}, 5000\)\)/.test(ext), "전송 시 요청 서술자(reqId+field+lang+유실 타이머) 기록 — 만료는 '그 요청' 한정");
ok(/var ckDoc = "\$\{nonce\}";/.test(ext) && /var rid = ckDoc \+ ":" \+ ckSeq;/.test(ext), "reqId 세대 유일성 — 문서마다 새 CSP nonce 접두+문서 내 카운터(ko→en→ko 재생성 뒤 reqId 재사용 충돌 차단 · Codex 4차)");
ok(/function ckExpire\(box, rid\)\{\s*\n\s*if \(ckM\[box\]\.expire\(rid\)\.act !== "hold"\) return;\s*\n\s*try \{ vscode\.postMessage\(\{ type: "ready" \}\); \} catch\(e\)\{\}/.test(ext), "응답 유실 liveness — 만료=hold(재활성·되돌림 없음)+ready 재렌더 요청, pending이 비어 다음 어떤 state든 복구(영구 disabled 경로 없음)");
ok(/reqId: rid/.test(ext) && /ok, reqId \}/.test(ext) && /staleMode: true, reqId \}/.test(ext) && /typeof m\.reqId === "string" && m\.reqId \? m\.reqId : null/.test(ext), "reqId 왕복 — 호스트가 문자열 reqId를 두 응답 경로 모두에 에코");
ok(/id="ckClaude" disabled/.test(ext) && /id="ckCodex" disabled/.test(ext) && /\$\("ckClaude"\)\.disabled = false/.test(ext), "최초 렌더 전 disabled(동결 설계 항목) — 첫 state 도착 시 해제");
ok(ext.includes("진짜 동시 저장(읽기-읽기 겹침)은") && ext.includes("서로 다른 필드끼리도 유실될 수 있다"), "호스트 주석 — 무잠금 한계 정직 서술(과장 금지)");
ok(/체크리스트 강제는 켜고 끄는 즉시 저장/.test(ext) && /checklist enforcement saves instantly on toggle/.test(ext) && /체크리스트 강제는 즉시 저장/.test(ext), "저장 버튼 안내 문구 정정(한/영·양 모드)");
const cl = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
ok(/P-1 교훈: \{\}로 축소해 덮어쓰면 계약 전체 유실/.test(cl) && /updateContractPatch로 승격 예정/.test(cl), "도우미 주석 — fail-closed 근거·2단 승격 경로 명시");

console.log("[6] 순서 반례 실행 — 웹뷰의 ckMachine(순수 상태기)을 추출해 그대로 실행(Codex 5차 요구)");
const mBeg = ext.indexOf("function ckMachine()"), mEnd = ext.indexOf("// [P8-CKM-END]");
ok(ext.indexOf("[P8-CKM-BEGIN]") > 0 && mBeg > 0 && mEnd > mBeg, "추출 마커·상태기 블록 존재");
const ckMachine = new Function("return (" + ext.slice(mBeg, mEnd).trim() + ")")();

// 반례 A(멀티창 모드 경합): 창A 토글 pending 중 창B가 모드 변경 → 호스트가 state(새 모드) 먼저, staleMode 거부 응답 나중.
// 요구: 새 모드 state가 pending에 막혀도(skip), 거부 응답이 '재활성·옛 기준선 복원'을 하지 않고(hold),
//       후속 정본 state에서만 새 모드 필드값으로 채움+활성화(fill) — 옛 모드 값이 새 모드 화면에 노출되지 않는다.
let A = ckMachine();
A.begin("docA:1", "claudeChecklist", "ko", 0);
ok(A.state().act === "skip", "A① pending 중 도착한 state(새 모드)는 채움 생략 — 미응답 저장 보호");
let rA = A.result({ reqId: "docA:1", field: null, lang: "ko", ok: false, staleMode: true }, "codexImplementerChecklist", "ko");
ok(rA.act === "hold" && rA.pd.id === "docA:1", "A② staleMode 거부 응답 → hold(재활성·되돌림 금지 — 새 모드 화면에 옛 모드 값 노출 차단)");
ok(A.state().act === "fill", "A③ 후속 정본 state에서만 채움+활성화 허가 — 새 모드 필드값 적용");

// 반례 A′(6차 대칭): 옛 모드 저장이 '성공'하고 그 응답이 모드 변경을 건너온 경우 — 실패가 아니라 성공이어도
// 소비 시점의 화면 기대 field가 다르면 commit이 아닌 hold(옛 값이 새 화면 기준선으로 오염되는 경로 차단).
let A2 = ckMachine();
A2.begin("docA:9", "claudeChecklist", "ko", 0);
ok(A2.state().act === "skip", "A′① 옛 모드 필드 기록 성공 직후 창B 모드 변경 → 새 모드 state는 skip");
let rA2 = A2.result({ reqId: "docA:9", field: "claudeChecklist", lang: "ko", ok: true }, "codexImplementerChecklist", "ko");
ok(rA2.act === "hold", "A′② 성공 응답이지만 화면 기대 field가 새 모드 — hold(재활성·기준선 오염 금지)");
ok(A2.state().act === "fill", "A′③ 후속 정본 state가 새 모드 필드값으로 채움+활성화");
let A3 = ckMachine();
A3.begin("docA:10", "claudeChecklist", "ko", 0);
ok(A3.result({ reqId: "docA:10", field: "claudeChecklist", lang: "ko", ok: true }, "claudeChecklist", "en").act === "hold", "A′④ 언어 슬롯이 그 사이 바뀐 성공 응답도 hold(대칭 — lang 좌표)");

// 반례 B(응답 유실): 매칭 saveResult 유실 → 5초 만료 → ready로 요청한 정본 state 수신.
let B = ckMachine();
B.begin("docA:2", "codexVerifierChecklist", "ko", 0);
ok(B.result({ reqId: "docA:1", field: "codexVerifierChecklist", lang: "ko", ok: true }, "codexVerifierChecklist", "ko").act === "ignore", "B① 낡은 reqId 응답은 ignore — 새 요청의 single-flight를 못 풂");
ok(B.state().act === "skip", "B② 유실 대기 중 state는 skip — 미응답 저장 보호 유지");
ok(B.expire("docA:2").act === "hold", "B③ 만료 → hold(pending 해제·재활성은 안 함)");
ok(B.expire("docA:2").act === "ignore" && B.result({ reqId: "docA:2", field: "codexVerifierChecklist", lang: "ko", ok: true }, "codexVerifierChecklist", "ko").act === "ignore", "B④ 이중 만료·만료 후 뒤늦은 응답 모두 ignore(무해)");
ok(B.state().act === "fill", "B⑤ ready로 받은 정본 state가 값·활성화 적용 — 영구 disabled 없음");

// 반례 C(문서 세대·응답 정합): ko→en→ko 재생성 뒤 카운터 재사용 — nonce 접두가 다르면 불일치.
let C = ckMachine();
C.begin("docB:1", "claudeChecklist", "ko", 0);
ok(C.result({ reqId: "docA:1", field: "claudeChecklist", lang: "ko", ok: true }, "claudeChecklist", "ko").act === "ignore", "C① 이전 문서(docA:1) 응답은 새 문서(docB:1) pending과 불일치 — 세대 충돌 차단");
ok(C.result({ reqId: "docB:1", field: "codexChecklist", lang: "ko", ok: true }, "claudeChecklist", "ko").act === "ignore", "C② reqId가 맞아도 field 불일치면 ignore(호스트 이상 방어)");
ok(C.result({ reqId: "docB:1", field: "claudeChecklist", lang: "en", ok: true }, "claudeChecklist", "ko").act === "ignore", "C③ lang 불일치도 ignore(타 언어 슬롯 응답 차단)");
let rC = C.result({ reqId: "docB:1", field: "claudeChecklist", lang: "ko", ok: true }, "claudeChecklist", "ko");
ok(rC.act === "commit" && rC.pd.lang === "ko", "C④ 전부 일치+화면 좌표 일치하는 매칭 성공만 commit — 기준선·재활성·표시 허가");
ok(C.result({ reqId: "docB:1", field: "claudeChecklist", lang: "ko", ok: true }, "claudeChecklist", "ko").act === "ignore", "C⑤ 소비 후 재도착(중복 응답)은 ignore");
// 만료 뒤 매칭 응답이 왔던 상황의 역순: 응답 먼저 소비되면 만료 타이머는 ignore
let D = ckMachine();
D.begin("docB:2", "claudeChecklist", "ko", 0);
D.result({ reqId: "docB:2", field: "claudeChecklist", lang: "ko", ok: true }, "claudeChecklist", "ko");
ok(D.expire("docB:2").act === "ignore", "C⑥ 매칭 응답이 먼저 소비되면 만료 타이머는 ignore(경합 무해)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
