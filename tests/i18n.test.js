// i18n(ko/en) 1단계 검증 — 전역 언어 파일 + 언어 슬롯(계약·기본지침) + 이중언어 판독기 + 영문 지침/주입/차단문.
// 실제 contract-lib.js를 격리 temp BRIDGE_DIR로 검증(별도 프로세스라 env 오염 없음).
// ★불변: ko(기본)는 레거시 파일·기존 문구 그대로 = 기존 사용자 100% 무회귀.
const assert = require("assert"), os = require("os"), path = require("path"), fs = require("fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "i18n_"));
process.env.CODEX_BRIDGE_HOME = tmp;
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_CODE_SESSION_ID;
const L = require("../bridge/contract-lib.js");

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ── 1) 전역 언어 파일 ──
ok(L.loadLang() === "ko", "언어파일 없음 → 기본 ko(기존 사용자 무회귀)");
ok(L.saveLang("en") === true && L.loadLang() === "en", "saveLang(en) → loadLang=en");
ok(L.saveLang("xx") === false && L.loadLang() === "en", "미지원 언어 저장 거부(값 유지)");
fs.writeFileSync(L.LANG_FILE, "{broken", "utf8");
ok(L.loadLang() === "ko", "언어파일 손상 → ko 폴백");
L.saveLang("ko");

// ── 2) 계약 언어 슬롯: ko=레거시 <sha>.json 그대로 / en=<sha>.en.json ──
const WS = "D:\\Proj\\A";
ok(L.contractFileFor(WS, "ko") === L.contractFileFor(WS).replace(/\.en\.json$/, ".json"), "ko 파일명 형태 일관");
ok(!/\.en\.json$/.test(L.contractFileFor(WS, "ko")) && /[0-9a-f]{16}\.json$/.test(L.contractFileFor(WS, "ko")), "ko = 레거시 <sha>.json(접미사 없음 — 기존 파일 그대로)");
ok(/[0-9a-f]{16}\.en\.json$/.test(L.contractFileFor(WS, "en")), "en = <sha>.en.json");
// 레거시(=ko) 파일에 규칙 저장 → ko는 읽고, en은 빈 계약(한국어 규칙이 영어 슬롯으로 안 샘)
fs.mkdirSync(path.dirname(L.contractFileFor(WS, "ko")), { recursive: true });
fs.writeFileSync(L.contractFileFor(WS, "ko"), JSON.stringify({ claude: ["추측 금지"], verifyMode: "always" }));
ok(L.loadContract(WS, "ko").claude[0] === "추측 금지", "ko 슬롯 = 레거시 파일 읽음(기존 규칙 보존)");
ok(L.loadContract(WS, "en").claude.length === 0 && L.loadContract(WS, "en").verifyMode === "off", "en 슬롯 = 빈 계약(레거시 한국어 규칙이 영어로 새지 않음)");
fs.writeFileSync(L.contractFileFor(WS, "en"), JSON.stringify({ claude: ["No guessing"] }));
ok(L.loadContract(WS, "en").claude[0] === "No guessing" && L.loadContract(WS, "ko").claude[0] === "추측 금지", "언어별 분리 저장·독립 로드");
// lang 미지정 → 전역 언어를 따름
L.saveLang("en");
ok(L.loadContract(WS).claude[0] === "No guessing", "lang 미지정 시 전역 언어(en) 슬롯");
L.saveLang("ko");
ok(L.loadContract(WS).claude[0] === "추측 금지", "전역 ko로 되돌리면 레거시 슬롯");

// ── 3) 기본지침 언어 슬롯 + 영문 기본값 ──
ok(L.baseDefaultsFor("en") === L.BASE_DEFAULTS_EN && L.baseDefaultsFor("ko") === L.BASE_DEFAULTS, "언어별 기본값 선택");
ok(/Verdict: pass/.test(L.BASE_DEFAULTS_EN.verifyBaseline) && /Verdict: fail/.test(L.BASE_DEFAULTS_EN.verifyBaseline) && /VERY LAST line/i.test(L.BASE_DEFAULTS_EN.verifyBaseline), "영문 지침이 판독기와 같은 판정 형식(Verdict: …)·verdict-last를 지시");
ok(/accept\/rebut\/hold/.test(L.BASE_DEFAULTS_EN.rejudge) && /my claim/.test(L.BASE_DEFAULTS_EN.transmit), "영문 재판단·전달 원칙 핵심 구문 존재");
ok(L.loadBaseDirective("en").verifyBaseline === L.BASE_DEFAULTS_EN.verifyBaseline, "en 기본지침 = 영문 기본값(오버라이드 없음)");
ok(L.loadBaseDirective("ko").verifyBaseline === L.BASE_DEFAULTS.verifyBaseline, "ko 기본지침 = 한국어 기본값");
// en 오버라이드는 en 파일에만, ko에 영향 없음
ok(L.saveBaseDirective({ verifyBaseline: "EN OVERRIDE" }, "en") === true, "en 오버라이드 저장");
ok(fs.existsSync(path.join(tmp, "base-directive.en.json")) && !fs.existsSync(path.join(tmp, "base-directive.json")), "en 오버라이드 → base-directive.en.json(레거시 파일 안 생김)");
ok(L.loadBaseDirective("en").verifyBaseline === "EN OVERRIDE" && L.loadBaseDirective("ko").verifyBaseline === L.BASE_DEFAULTS.verifyBaseline, "en 오버라이드가 ko에 안 섬");
ok(L.resetBaseDirective("en") === true && L.loadBaseDirective("en").verifyBaseline === L.BASE_DEFAULTS_EN.verifyBaseline, "en만 기본값 복원");
// 레거시 base-directive.json = ko 슬롯(기존 사용자 오버라이드 보존)
fs.writeFileSync(path.join(tmp, "base-directive.json"), JSON.stringify({ transmit: "KO LEGACY" }));
ok(L.loadBaseDirective("ko").transmit === "KO LEGACY" && L.loadBaseDirective("en").transmit === L.BASE_DEFAULTS_EN.transmit, "레거시 오버라이드 = ko 전용(en 미오염)");
fs.unlinkSync(path.join(tmp, "base-directive.json"));

// ── 4) 판독기: 영어 4단계 ──
ok(L.extractVerdict("body\nVerdict: pass") === "pass", "EN: Verdict: pass");
ok(L.extractVerdict("body\nVerdict: pass (notes)") === "pass-notes", "EN: pass (notes) → pass-notes");
ok(L.extractVerdict("body\nVerdict: pass — minor caveats on naming") === "pass-notes", "EN: pass+caveats → pass-notes");
ok(L.extractVerdict("body\nVerdict: inconclusive — insufficient information") === "inconclusive", "EN: inconclusive");
ok(L.extractVerdict("body\nVerdict: fail") === "fail", "EN: fail");
ok(L.extractVerdict("Verdict: passed") === "pass", "EN: 'Verdict: passed' 형태변형 수용");
ok(L.extractVerdict("Verdict: pass — no failures found") === "pass", "EN: 'no failures found' 부연이 fail로 오분류 안 됨");
ok(L.extractVerdict("Verdict: pass - no tests fail") === "pass", "EN(Codex 반례): 뒤쪽 'fail' 단어가 선언값 pass를 못 덮음(콜론 뒤 선언값 앵커)");
ok(L.extractVerdict("Verification passed locally, but deployment risk remains") === null, "EN(Codex 반례): 설명문은 선언 아님(Verdict: 콜론형만) → null");
ok(L.extractVerdict("Verification: passed") === null, "EN: Verification: 콜론형도 선언으로 안 봄(보수 게이트 — 지침 형식은 Verdict:)");
ok(L.extractVerdict("the tests pass and nothing fails") === null, "EN: 선언 줄 아님(게이트 없음) → null");
ok(L.extractVerdict("Verdict: fail\n...\nVerdict: pass") === "pass", "EN: 마지막 선언이 이김");
ok(L.extractVerdict("검증: 실패\nVerdict: pass") === "pass", "혼용: 한국어 선언 뒤 영어 선언 → 마지막(영어)이 이김");
// ── 5) 교차 오염 방지(기존 한국어 동작 보존) ──
ok(L.extractVerdict("검증: 통과 — fail-safe 처리 확인") === "pass", "KO 선언줄 속 우연한 영단어(fail-safe)가 fail로 오염 안 됨");
ok(L.extractVerdict("검증: 통과 — minor한 정리 여지") === "pass", "KO 선언줄 속 minor가 pass-notes로 오염 안 됨(한국어 단어만 분류)");
ok(L.extractVerdict("검증: 통과(보완) — 라벨 정리 권장") === "pass-notes", "KO: 통과(보완) 기존 동작 유지");
ok(L.extractVerdict("검증: 보류 — 정보 부족") === "inconclusive", "KO: 보류 기존 동작 유지");

// ── 6) formatForClaude 언어별 footer ──
const fmtEn = L.formatForClaude("evidence body\nVerdict: pass (notes)", "en");
ok(/Codex declared: Verdict: pass \(notes\)/.test(fmtEn) && /Obligation:/.test(fmtEn) && !/처리 의무/.test(fmtEn), "en footer: Codex declared/Obligation(한국어 없음)");
ok(!/^Verdict:/m.test(fmtEn.split("---")[0]), "en: 판정 선언 줄은 본문에서 제거(footer로 이동)");
const fmtKo = L.formatForClaude("근거 본문\n검증: 통과(보완)", "ko");
ok(/처리 의무:/.test(fmtKo) && /Codex 선언: 검증: 통과\(보완\)/.test(fmtKo), "ko footer 기존 형식 유지");

// ── 7) 검증 directive·주입문 영어판 ──
const dirEn = L.buildVerifyDirective("always", "en");
ok(/Verify Mode ON\(always\)/.test(dirEn) && dirEn.includes(L.BRIDGE) && /Transmission Principles/.test(dirEn) && /Re-judgment/.test(dirEn), "en directive: 헤더+브릿지 경로+전달/재판단 포함");
ok(/검증 모드 ON\(always\)/.test(L.buildVerifyDirective("always", "ko")), "ko directive 기존 형식 유지");
const injEn = L.buildInjection(["rule one"], "Claude Code", true, "en");
ok(/Standing Contract/.test(injEn) && /\[Contract Check\]/.test(injEn) && /complies\|violated\|n\/a/.test(injEn), "en 체크리스트 주입문");
ok(/고정 계약/.test(L.buildInjection(["규칙"], "Claude Code", true, "ko")), "ko 주입문 기존 형식 유지");
ok(/Standing Rules/.test(L.buildInjection(["rule"], "Claude Code", false, "en")) && /고정 규약/.test(L.buildInjection(["규칙"], "Claude Code", false, "ko")), "체크 해제형 양언어");

// ── 8) 확장(extension.ts) 로직 미러 — vscode 의존이라 규칙을 동일 사양으로 검증(브릿지와 파일 규칙 공유) ──
// (a) 첫 실행 언어 초기화: VS Code UI 언어가 ko*면 ko, 그 외 전부 en. 이미 language.json 있으면 손 안 댐.
const initLang = (uiLang) => (String(uiLang || "").toLowerCase().startsWith("ko") ? "ko" : "en");
ok(initLang("ko") === "ko" && initLang("ko-KR") === "ko", "첫실행: ko/ko-KR → ko");
ok(initLang("en-US") === "en" && initLang("ja") === "en" && initLang("") === "en", "첫실행: 비한국어(en-US/ja/빈값) → en");
// (a-2) 언어 영속(마지막 설정 유지): 한 번 저장한 언어는 재로드·프로젝트 전환과 무관하게 유지(전역 파일 단일 소스).
L.saveLang("en");
ok(L.loadLang() === "en" && L.loadContract("D:\\Brand\\New\\Project").claude.length === 0, "영속: en 저장 후 '신규 프로젝트'를 열어도 전역 언어는 en 유지(언어는 프로젝트별이 아님)");
ok(/[0-9a-f]{16}\.en\.json$/.test(L.contractFileFor("D:\\Brand\\New\\Project")), "신규 프로젝트도 현재 전역 언어(en) 슬롯 파일을 씀");
L.saveLang("ko");
ok(L.loadLang() === "ko", "영속: ko로 되돌리면 ko 유지");
// (a-3) 첫 실행 초기화는 '파일 없을 때만' — 이미 설정된 언어를 절대 안 덮음(확장 ensureLangInitialized 미러).
const initIfMissing = (exists, cur, uiLang) => (exists ? cur : (String(uiLang||"").toLowerCase().startsWith("ko") ? "ko" : "en"));
ok(initIfMissing(true, "en", "ko-KR") === "en", "초기화: 파일 존재(en 설정) → VS Code가 한국어여도 안 덮음(마지막 설정 승리)");
ok(initIfMissing(false, null, "ko-KR") === "ko" && initIfMissing(false, null, "en-US") === "en", "초기화: 파일 없을 때만 UI 언어로(ko*→ko, 그 외→en)");
// (a-4) 상태바 멱등 가드 key에 언어 포함 미러 — 언어만 바뀌어도 key가 달라져 재렌더(옛 언어 잔존 버그 방지).
const sbKey = (mode, lang) => JSON.stringify({ mode, lang });
ok(sbKey("linked", "ko") !== sbKey("linked", "en"), "상태바 key: 표시상태 동일해도 언어가 다르면 key 상이 → 갱신 스킵 안 함");
// (b) '반대 슬롯에만 규칙 있음' 안내: 현재 슬롯 기준 반대 언어 파일에 claude/codex 규칙이 있으면 true.
const hasRules = (o) => (Array.isArray(o.claude) && o.claude.length > 0) || (Array.isArray(o.codex) && o.codex.length > 0);
ok(hasRules({ claude: ["r"] }) && hasRules({ codex: ["r"] }) && !hasRules({ claude: [], codex: [] }) && !hasRules({}), "슬롯 규칙 유무 판정(claude/codex 규칙만, 모드 기본값 무시)");
// (c) 실파일로: ko 레거시에 규칙 있고 en 비었을 때 — en 모드에서 반대(ko) 슬롯 읽으면 규칙 발견(안내 뜸)
const koFile = L.contractFileFor(WS, "ko"), enFile = L.contractFileFor(WS, "en");
ok(hasRules(JSON.parse(fs.readFileSync(koFile, "utf8"))), "실파일: ko 슬롯 규칙 존재 → en 모드에서 안내 조건 성립");
ok(fs.existsSync(enFile), "(전제) en 슬롯 파일도 위 테스트에서 생성됨");

// ── 9) 주제(snippet) 보일러플레이트 제거 미러 — 상태바/호버/후보 목록의 '주제'가 주입 지침 머리말로 보이지 않게 ──
const strip = (text) => { for (const mk of ["\n---\n[작업 요청]\n", "\n---\n[Work Request]\n"]) { const i = text.lastIndexOf(mk); if (i >= 0) return text.slice(i + mk.length); } return text; };
ok(strip("[검증 기본 원칙 · 항상 적용]\n1) …지침…\n\n---\n[작업 요청]\n결제 모듈 리팩터 검증해줘") === "결제 모듈 리팩터 검증해줘", "주제: KO 지침 보일러플레이트 제거 → 실제 요청만");
ok(strip("[Verification Baseline · always applies]\n1) …\n\n---\n[Work Request]\nverify the payment refactor") === "verify the payment refactor", "주제: EN 보일러플레이트 제거");
ok(strip("그냥 일반 대화 첫 문장") === "그냥 일반 대화 첫 문장", "주제: 마커 없으면(비-브릿지 세션) 원문 그대로");
ok(strip("본문에 \n[작업 요청]\n 이 문구만 있고 --- 없으면 안 잘림") === "본문에 \n[작업 요청]\n 이 문구만 있고 --- 없으면 안 잘림", "주제: '---' 없는 우연 문구는 구분자로 안 봄(엄밀 마커)");
ok(strip("지침\n---\n[작업 요청]\n1차\n---\n[작업 요청]\n진짜 본문") === "진짜 본문", "주제: lastIndexOf라 마지막 구분자 기준");

console.log("i18n: " + n + " assertions passed");
