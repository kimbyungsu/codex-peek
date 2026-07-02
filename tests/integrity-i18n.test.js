/*
 * localizeIntegrityDetail(src/integrity-i18n.ts → out/integrity-i18n.js) — 무결성 경고문 '표시 시점 현재 언어' 선택.
 * 배경(실측): integrity.json의 detail은 기록 시점 언어로 저장돼, EN 전환 후에도 상태바 툴팁·대시보드 배너 경고가 한국어로 남았다.
 * 규칙: ①detailKo/detailEn 있으면 그걸(신규 이벤트) ②kind/severity/sig로 문구가 정해지는 종류는 재생성(과거 이벤트도 현재 언어)
 *      ③둘 다 아니면 저장된 detail 그대로(정직 폴백 — 번역을 지어내지 않음).
 * ※ out/integrity-i18n.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const { localizeIntegrityDetail } = require(path.join(__dirname, "..", "out", "integrity-i18n.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const L = localizeIntegrityDetail;

console.log("[① 신규 이벤트] detailKo/detailEn이 있으면 현재 언어 것을 그대로");
const ev1 = { kind: "evidence-mismatch", severity: "warning", detail: "한국어 원문", detailKo: "한국어 원문", detailEn: "English text with a.ts:3" };
ok(L(ev1, true) === "English text with a.ts:3", "EN 모드 → detailEn");
ok(L(ev1, false) === "한국어 원문", "KO 모드 → detailKo");

console.log("[② 과거 이벤트 — 정적 문구 kind] detail이 한 언어뿐이어도 kind/severity/sig로 현재 언어 재생성");
const holdKo = { kind: "verdict-nonclean", severity: "warning", detail: "Codex 결론이 '통과'가 아닙니다(보류·불가·정보 부족 등 — 결론을 못 냄). 대시보드 대화에서 결론을 확인하세요." };
ok(/not a pass/.test(L(holdKo, true)), "보류(warning) 한국어 저장 → EN 모드에서 영어(사용자 실측 케이스)");
ok(L(holdKo, false) === holdKo.detail, "같은 이벤트 KO 모드 → 한국어(자구 일치)");
const failKo = { kind: "verdict-nonclean", severity: "error", detail: "옛 한국어" };
ok(/FAIL/.test(L(failKo, true)) && /검증 실패/.test(L(failKo, false)), "실패(error)도 양방향 재생성");
const miss = { kind: "verdict-missing", severity: "warning", detail: "옛 한국어" };
ok(/no final verdict line/.test(L(miss, true)), "판정표지 누락 → EN 재생성");
const smB = { kind: "session-missing", severity: "error", sig: "session-missing:blocked", detail: "옛 한국어" };
const smN = { kind: "session-missing", severity: "error", sig: "session-missing:normal", detail: "옛 한국어" };
ok(/auto-creation is paused/.test(L(smB, true)) && /created and linked automatically/.test(L(smN, true)), "세션 없음(blocked/normal) sig별 EN 재생성");

console.log("[② 과거 이벤트 — brain-drift] sig의 비교값 두 개로 문구 재생성");
const bdc = { kind: "brain-drift", severity: "warning", sig: "cc-model:opus!fable", detail: "옛 한국어" };
ok(/configured model is 'opus'/.test(L(bdc, true)) && /'fable'/.test(L(bdc, true)), "cc-model sig → EN 재생성(값 보존)");
ok(/설정한 모델은 'opus'/.test(L(bdc, false)), "cc-model sig → KO 재생성");
const bdx = { kind: "brain-drift", severity: "warning", sig: "cx-effort:high!medium", detail: "옛 한국어" };
ok(/configured reasoning is 'high'/.test(L(bdx, true)), "cx-effort sig → EN 재생성");
ok(/Codex: configured model is 'gpt-5.5'/.test(L({ kind: "brain-drift", sig: "cx-model:gpt-5.5!gpt-5", detail: "x" }, true)), "cx-model sig → EN 재생성");

console.log("[② 과거 이벤트 — verify-incomplete] 저장 원문에서 모드·횟수를 되읽어 반대 언어 재생성(Codex 보완)");
const viKo = { kind: "verify-incomplete", severity: "error", detail: "검증 모드:always — 3회 강제했으나 검증이 완료되지 않은 채 이 턴이 종료됨(이 턴 결과는 미검증)." };
ok(/Verify mode:always — forced 3 times/.test(L(viKo, true)), "KO 저장 → EN 재생성(모드·횟수 보존)");
const viEn = { kind: "verify-incomplete", severity: "error", detail: "Verify mode:code — forced 3 times, but this turn ended without a completed verification (this turn's result is UNVERIFIED)." };
ok(/검증 모드:code — 3회 강제/.test(L(viEn, false)), "EN 저장 → KO 재생성");
ok(L({ kind: "verify-incomplete", detail: "형식이 다른 원문" }, true) === "형식이 다른 원문", "형식 안 맞으면 원문 유지(억지 번역 없음)");

console.log("[③ 정직 폴백] 동적 목록 포함 과거 이벤트·모르는 kind는 저장된 원문 유지(번역을 지어내지 않음)");
const dyn = { kind: "evidence-mismatch", severity: "warning", detail: "검증 답의 인용 근거 2개가 실제 파일/라인과 불일치(존재하지 않는 줄): a.ts:99" };
ok(L(dyn, true) === dyn.detail, "과거 evidence-mismatch(단일 detail) → EN 모드여도 원문(목록은 재생성 불가)");
ok(L({ kind: "future-kind", detail: "원문" }, true) === "원문", "모르는 kind → 원문");
ok(L({ kind: "brain-drift", sig: "이상한형식", detail: "원문" }, true) === "원문", "brain-drift인데 sig 형식이 아니면 원문");
ok(L({}, true) === "", "빈 이벤트 → 빈 문자열(크래시 없음)");

console.log("[기록부 계약] 신규 이벤트 기록부가 detailKo/detailEn을 함께 저장하는지(소스 검사)");
const fs = require("fs");
const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
const guardSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "verify-guard.js"), "utf8");
const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok((bridgeSrc.match(/detailKo:/g) || []).length >= 4 && (bridgeSrc.match(/detailEn:/g) || []).length >= 4, "브릿지 4곳(verdict-missing/nonclean·evidence-mismatch/unseen) 양언어 저장");
ok(guardSrc.includes("detailKo:") && guardSrc.includes("detailEn:"), "verify-guard(verify-incomplete) 양언어 저장");
ok((extSrc.match(/detailKo:/g) || []).length >= 3, "확장(brain-drift·session-missing) 양언어 저장 + 타입 선언");
ok(extSrc.includes("localizeIntegrityDetail(e, en)"), "확장 표시 단일 지점(readVisibleIntegrity)에서 현지화 적용");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
