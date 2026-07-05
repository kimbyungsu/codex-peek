/*
 * brain-intent(src/brain-intent.ts → out/brain-intent.js) — cc-model 두뇌 drift의 '프로젝트별 의도(intent)' 해석.
 * 배경(사용자 실측 2026-07-04): /model 선택이 전역 settings.json 한 파일에 저장돼, 프로젝트 2개를 다른 모델로 동시에 쓰면
 * (P1=fable·P2=opus) P1의 /model이 P2의 '설정값'을 바꿔 P2에 구조적 거짓경고. 해법=의도를 그 대화 자신의 /model 기록에서.
 * 픽스처는 실제 transcript 형식 그대로(stdout형·args형·인용 함정 모두 실데이터에서 채집).
 * ※ out/brain-intent.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const { parseLastModelCommand, parseLastAssistantModel, parseSessionStartTs, resolveCcIntent, modelFamily, shouldAttributeSettingsChange, pruneIntentMap } = require(path.join(__dirname, "..", "out", "brain-intent.js"));
function normWs(p) { return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const J = (o) => JSON.stringify(o);
const WS = "D:\\A";
// 실데이터 형식 그대로의 엔트리 생성기
const stdoutEntry = (model, over) => J({ type: "user", cwd: "D:\\A", timestamp: "2026-07-04T00:10:00Z", message: { role: "user", content: `<local-command-stdout>Set model to ${model}</local-command-stdout>` }, ...over });
const argsEntry = (args) => J({ type: "user", cwd: "D:\\A", timestamp: "2026-07-04T00:10:00Z", message: { role: "user", content: `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${args}</command-args>` } });

console.log("[stdout형 확정 기록] 마지막 /model을 잡는다 — [1m] 접미 유/무 모두(실데이터 두 형태)");
let r = parseLastModelCommand([stdoutEntry("claude-opus-4-8[1m]"), stdoutEntry("claude-fable-5")].join("\n"), WS, normWs);
ok(r && r.model === "claude-fable-5", "역방향 스캔 — 마지막 기록(fable) 승리");
r = parseLastModelCommand(stdoutEntry("claude-opus-4-8[1m]"), WS, normWs);
ok(r && r.model === "claude-opus-4-8[1m]", "[1m] 접미 붙은 형태도 그대로 추출(계열 비교라 무해)");
ok(parseLastModelCommand(stdoutEntry("opus") + "\n" + '{"broken json', WS, normWs).model === "opus", "깨진 줄(tail 경계) skip 후 유효 기록");

console.log("[args형은 안 씀] <command-args>는 취소/미확정일 수 있어 무시(stdout만 신뢰 — 과소경고 감수)");
ok(parseLastModelCommand(argsEntry("claude-fable-5[1m]"), WS, normWs) === null, "args형 단독 → null");
r = parseLastModelCommand([argsEntry("claude-fable-5[1m]"), stdoutEntry("claude-fable-5")].join("\n"), WS, normWs);
ok(r && r.model === "claude-fable-5", "args+stdout 쌍(실데이터 순서)이면 stdout이 잡힘");

console.log("[★인용 함정] 사용자 메시지가 /model 기록을 '인용'해도(본문 중간 태그) 의도로 오인하지 않는다 — 실발생 케이스");
const quoted = J({ type: "user", cwd: "D:\\A", timestamp: "2026-07-04T00:20:00Z", message: { role: "user", content: "전턴 요청->\"좋아\"\n<local-command-stdout>Set model to claude-opus-4-8[1m]</local-command-stdout>\n=> 뭐가 어떻게 된거지?" } });
ok(parseLastModelCommand(quoted, WS, normWs) === null, "본문 중간 태그(시작 앵커 불일치) → 배제");
r = parseLastModelCommand([stdoutEntry("claude-fable-5"), quoted].join("\n"), WS, normWs);
ok(r && r.model === "claude-fable-5", "인용이 더 최신이어도 진짜 기록(fable)만 인정");

console.log("[격리] cwd 불일치·사이드체인·비 user 엔트리 배제");
ok(parseLastModelCommand(J({ type: "user", cwd: "D:\\B", timestamp: "t", message: { content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }), WS, normWs) === null, "다른 폴더(cwd) 배제");
ok(parseLastModelCommand(J({ type: "user", timestamp: "t", message: { content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }), WS, normWs) === null, "cwd 없는 엔트리 배제(strict)");
ok(parseLastModelCommand(J({ type: "user", cwd: "D:\\A", isSidechain: true, message: { content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }), WS, normWs) === null, "사이드체인 배제");
ok(parseLastModelCommand(J({ type: "assistant", cwd: "D:\\A", message: { content: "<local-command-stdout>Set model to opus</local-command-stdout>" } }), WS, normWs) === null, "assistant 엔트리 배제");

console.log("[content 배열형] text 블록 안의 확정 기록도 인식(Codex 보완 케이스)");
const arrEntry = J({ type: "user", cwd: "D:\\A", timestamp: "2026-07-04T00:30:00Z", message: { role: "user", content: [{ type: "text", text: "<local-command-stdout>Set model to claude-fable-5</local-command-stdout>" }] } });
r = parseLastModelCommand(arrEntry, WS, normWs);
ok(r && r.model === "claude-fable-5", "배열 content의 text 블록에서 추출");

console.log("[parseLastAssistantModel] 실제 답 모델 — cwd strict·synthetic 제외·ts 동반(증분 스캔 조각용)");
const ans = (model, cwd, ts) => J({ type: "assistant", cwd: cwd || "D:\\A", timestamp: ts || "2026-07-04T00:40:00Z", message: { model } });
let am = parseLastAssistantModel([ans("claude-opus-4-8"), ans("claude-fable-5")].join("\n"), WS, normWs);
ok(am && am.model === "claude-fable-5" && am.ts === Date.parse("2026-07-04T00:40:00Z"), "마지막 답 모델+ts");
ok(parseLastAssistantModel(ans("claude-fable-5", "D:\\B"), WS, normWs) === null, "다른 폴더 답 배제(cwd strict)");
ok(parseLastAssistantModel(ans("<synthetic>"), WS, normWs) === null, "<synthetic> 제외");
ok(parseLastAssistantModel(J({ type: "assistant", cwd: "D:\\A", isSidechain: true, message: { model: "claude-fable-5" } }), WS, normWs) === null, "사이드체인 답 제외");
// 증분 병합 시맨틱(extension scanCcTranscript의 '새 조각 우선, 없으면 이전 지식' — 순수 부분만 검증)
const prevKnowledge = parseLastAssistantModel(ans("claude-opus-4-8"), WS, normWs);
const newChunkNone = parseLastAssistantModel("도구 출력만 있는 새 조각(모델 답 없음)", WS, normWs);
ok((newChunkNone || prevKnowledge).model === "claude-opus-4-8", "새 조각에 답 없으면 이전 지식 유지(병합 규칙)");

console.log("[parseSessionStartTs] 머리 텍스트 첫 timestamp = 대화 시작 시각");
ok(parseSessionStartTs([J({ timestamp: "2026-07-01T00:00:00Z" }), J({ timestamp: "2026-07-02T00:00:00Z" })].join("\n")) === Date.parse("2026-07-01T00:00:00Z"), "첫 timestamp 반환");
ok(parseSessionStartTs(['{"broken', J({ timestamp: "2026-07-01T09:00:00Z" })].join("\n")) === Date.parse("2026-07-01T09:00:00Z"), "깨진 줄 skip");
ok(parseSessionStartTs("no json lines") === null, "timestamp 전무 → null(→settings 폴백 포기)");

console.log("[modelFamily 정본] 확장·격자·테스트가 같은 함수 import(사본 드리프트 방지)");
ok(modelFamily("opus[1m]") === "opus" && modelFamily("claude-opus-4-8") === "opus", "계열: 별칭↔정식ID 동일");
ok(modelFamily("claude-fable-5[1m]") === "fable" && modelFamily("") === "" && modelFamily("gpt-5.5") === "", "계열: fable/빈값/비-Claude");

console.log("[resolveCcIntent v3] 후보(①/model ②포커스 귀속) 최신 ts 승리 → ③대화 시작 前 설정 → ④skip");
const T0 = Date.parse("2026-07-01T00:00:00Z"), T1 = Date.parse("2026-07-02T00:00:00Z"), T2 = Date.parse("2026-07-03T00:00:00Z");
// (cmdModel, cmdTs, attrModel, attrTs, settingsModel, settingsMtimeMs, sessionStartTs)
let it = resolveCcIntent("claude-fable-5", T1, "claude-opus-4-8[1m]", T2, "x", null, null);
ok(it && it.source === "attributed" && it.model === "claude-opus-4-8[1m]", "attr(UI 피커 귀속)이 cmd보다 최신 → attr 승리(전환 즉시 경고 UX의 근거)");
it = resolveCcIntent("claude-fable-5", T2, "claude-opus-4-8[1m]", T1, "x", null, null);
ok(it && it.source === "command" && it.model === "claude-fable-5", "cmd(/model)가 attr보다 최신 → cmd 승리");
it = resolveCcIntent("claude-fable-5", T1, null, null, "opus[1m]", T2, T0);
ok(it && it.source === "command" && it.model === "claude-fable-5", "attr 없음 → cmd가 의도(타 창이 설정을 나중에 바꿔도 이 ws 의도 유지 — 침묵 전환 시 진짜 경고 가능, v0.1.78 가드 폐기)");
it = resolveCcIntent(null, null, "claude-opus-4-8[1m]", T1, "x", null, null);
ok(it && it.source === "attributed", "cmd 없음 → attr 단독 의도(UI 피커만 쓰는 사용자)");
it = resolveCcIntent(null, null, null, null, "opus[1m]", T0, T1);
ok(it && it.model === "opus[1m]" && it.source === "settings", "③ 후보 전무+설정 mtime<=대화시작 → 그 대화의 기본값으로 인정");
ok(resolveCcIntent(null, null, null, null, "opus[1m]", T1, T0) === null, "③ 설정이 대화 도중 변경(귀속 없음: 비포커스·외부 편집·구버전) → skip");
ok(resolveCcIntent(null, null, null, null, "opus[1m]", null, T0) === null, "③ mtime 산출 실패 → skip(추측 비교 금지)");
ok(resolveCcIntent(null, null, null, null, "opus[1m]", T0, null) === null, "③ 시작시각 산출 실패 → skip(birthtime 대체 안 함)");
ok(resolveCcIntent(null, null, null, null, "", T0, T1) === null, "④ 설정 자체가 빈값 → skip");
ok(resolveCcIntent("  ", null, "  ", null, "opus", T0, T1).source === "settings", "공백뿐인 cmd/attr는 없는 것으로(설정 폴백)");

console.log("[사용자 실측 시나리오 종합]");
// (1) 침묵 전환 감지: P2 의도=fable(/model 또는 귀속), P1이 전역을 opus로 바꿈(P2엔 귀속 없음) → P2 의도 유지 → 새 답이 opus로 오면 경고
const p2 = resolveCcIntent("claude-fable-5", T1, null, null, "claude-opus-4-8[1m]", T2, T0);
ok(p2 && modelFamily(p2.model) === "fable" && modelFamily(p2.model) !== modelFamily("claude-opus-4-8"), "P2 침묵 전환: 의도 fable 유지 → opus 답에서 진짜 경고(v0.1.78이 죽이던 것 복원)");
// (2) 이 창 UI 전환 즉시 경고: 귀속(opus, 최신) vs 최근 답(fable) → 어긋남 → 답 오기 전에도 경고
const ui = resolveCcIntent("claude-fable-5", T0, "claude-opus-4-8[1m]", T2, "x", null, null);
ok(ui && modelFamily(ui.model) === "opus" && modelFamily(ui.model) !== modelFamily("claude-fable-5"), "이 창 UI 전환: 귀속이 의도 → 옛 fable 답과 어긋나 즉시 경고(구버전 UX 복원)");
// (3) 타 창 전환은 이 창 무반응: 이 창 의도(fable)==이 창 답(fable), 전역만 opus
const iso = resolveCcIntent("claude-fable-5", T1, null, null, "claude-opus-4-8[1m]", T2, T0);
ok(iso && modelFamily(iso.model) === modelFamily("claude-fable-5[1m]"), "타 창 전환: 이 창 의도·답 일치 → 경고 없음(분리 유지)");

console.log("[shouldAttributeSettingsChange] '이 변경은 내 창의 조작인가' — 포커스 구간 판정");
const N = 1000000; // now
ok(shouldAttributeSettingsChange(N - 100, N - 5000, null, N, "fable", "opus") === true, "포커스 중 변경 → 귀속");
ok(shouldAttributeSettingsChange(N - 100, N - 5000, N - 200, N, "fable", "opus") === true, "변경 직후 포커스 잃음(지연 여유 2s 내) → 귀속");
ok(shouldAttributeSettingsChange(N - 100, N - 5000, N - 4000, N, "fable", "opus") === false, "포커스 잃고 한참 뒤 변경 → 비귀속(타 창 조작)");
ok(shouldAttributeSettingsChange(N - 100, N - 50, null, N, "fable", "opus") === false, "변경이 내 포커스 시작 '전' → 비귀속(변경 후 포커스 받은 창의 오귀속 차단 — Codex race 보완)");
ok(shouldAttributeSettingsChange(N - 100, null, null, N, "fable", "opus") === false, "포커스 이력 없음 → 비귀속");
ok(shouldAttributeSettingsChange(N - 100, N - 5000, null, N, "opus", "opus") === false, "모델 값 무변화(다른 키 변경·중복 이벤트) → 기록 안 함");
ok(shouldAttributeSettingsChange(N - 100, N - 5000, null, N, "fable", "") === false, "새 값 빈값 → 기록 안 함");

console.log("[pruneIntentMap] 30일 지난 프로젝트 귀속 정리");
const pm = pruneIntentMap({ a: { model: "x", ts: N - 1000 }, b: { model: "y", ts: N - 31 * 864e5 }, c: { ts: "bad" } }, N);
ok(pm.a && !pm.b && !pm.c, "신선 유지·만료 제거·손상 항목 제거");

console.log("[배선 계약] TTL 읽기 적용 + 즉시성(소스 검사 — Codex 실패 지적 2건 잠금)");
const fs3 = require("fs");
const extSrc2 = fs3.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/readCcIntentFor[\s\S]{0,600}pruneIntentMap\(\{ v:/.test(extSrc2), "읽기에서도 TTL 적용(pruneIntentMap 동일 기준) — 낡은 귀속이 영구 의도로 남는 것 차단");
ok(/writeCcIntentFor\(ws, cur\);\s*\n\s*lastDriftSync = 0/.test(extSrc2), "귀속 기록 성공 시 drift throttle 리셋 — 전환 몇 초 내 경고 보장");

console.log("[배선·안전장치] extension.ts 증분 스캐너 계약(소스 검사)");
const fs2 = require("fs");
const extSrc = fs2.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
ok(/st\.size - base\.size > CC_SCAN_BACKFILL\) base = null/.test(extSrc), "갭 상한: 델타>백필창이면 이전 지식 폐기(놓친 구간의 더 새로운 기록을 옛 지식으로 오인→거짓경고 방지)");
ok(/scan\.actual && Date\.now\(\) - scan\.actual\.ts < DRIFT_FRESH_MS/.test(extSrc), "actual은 신선도(DRIFT_FRESH_MS=7일) 통과분만 채택");
ok(/const DRIFT_FRESH_MS = 7 \* 24 \* 60 \* 60 \* 1000/.test(extSrc), "신선도 창=7일(사용자 결정 2026-07-05: 병행 개발 3일+ 텀 — 24h는 과잉 억제)");
ok(/parseLastModelCommand\(chunk, ws, normWs\) \|\| \(base \? base\.cmd : null\)/.test(extSrc), "병합 규칙: 새 조각 우선, 없으면 이전 지식(연속 스캔 보장 하)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
