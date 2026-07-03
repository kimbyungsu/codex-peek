/*
 * brain-intent(src/brain-intent.ts → out/brain-intent.js) — cc-model 두뇌 drift의 '프로젝트별 의도(intent)' 해석.
 * 배경(사용자 실측 2026-07-04): /model 선택이 전역 settings.json 한 파일에 저장돼, 프로젝트 2개를 다른 모델로 동시에 쓰면
 * (P1=fable·P2=opus) P1의 /model이 P2의 '설정값'을 바꿔 P2에 구조적 거짓경고. 해법=의도를 그 대화 자신의 /model 기록에서.
 * 픽스처는 실제 transcript 형식 그대로(stdout형·args형·인용 함정 모두 실데이터에서 채집).
 * ※ out/brain-intent.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const { parseLastModelCommand, parseLastAssistantModel, parseSessionStartTs, resolveCcIntent } = require(path.join(__dirname, "..", "out", "brain-intent.js"));
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

console.log("[resolveCcIntent] ①이 대화의 /model → ②대화 시작 前 설정만 → ③skip(거짓경고 0)");
const T0 = Date.parse("2026-07-01T00:00:00Z"), T1 = Date.parse("2026-07-02T00:00:00Z");
let it = resolveCcIntent("claude-fable-5", "opus[1m]", T1, T0);
ok(it && it.model === "claude-fable-5" && it.source === "command", "① /model 기록이 설정보다 우선(전역 오염 무시)");
it = resolveCcIntent(null, "opus[1m]", T0, T1);
ok(it && it.model === "opus[1m]" && it.source === "settings", "② 설정 mtime<=대화시작 → 그 대화의 기본값으로 인정");
ok(resolveCcIntent(null, "opus[1m]", T1, T0) === null, "② 설정이 대화 도중 변경(mtime>시작) → skip — P1의 /model이 P2 설정을 바꾼 실측 케이스 차단");
ok(resolveCcIntent(null, "opus[1m]", null, T0) === null, "② mtime 산출 실패 → skip(추측 비교 금지)");
ok(resolveCcIntent(null, "opus[1m]", T0, null) === null, "② 시작시각 산출 실패 → skip(birthtime 대체 안 함)");
ok(resolveCcIntent(null, "", T0, T1) === null, "③ 설정 자체가 빈값 → skip");
ok(resolveCcIntent("  ", "opus", T0, T1) && resolveCcIntent("  ", "opus", T0, T1).source === "settings", "공백뿐인 cmd는 없는 것으로(설정 폴백)");

console.log("[사용자 시나리오 종합] P1=fable(/model)·P2=opus 동시 — 각 창 의도가 자기 대화 기준이라 거짓경고 0");
const fam = (m) => { m = (m || "").toLowerCase(); return m.includes("fable") ? "fable" : m.includes("opus") ? "opus" : ""; };
// P2: 자기 대화에 /model opus 기록 있음, 실제 답 opus, 전역 설정은 P1이 fable로 바꿈(mtime 최신)
const p2 = resolveCcIntent("claude-opus-4-8[1m]", "claude-fable-5[1m]", T1, T0);
ok(p2 && fam(p2.model) === "opus" && fam("claude-opus-4-8") === "opus", "P2: intent=opus==actual → 경고 없음(기존엔 설정 fable과 비교돼 거짓경고)");
// 진짜 drift: 이 대화에서 fable 골랐는데 답이 계속 opus
const p1 = resolveCcIntent("claude-fable-5[1m]", "claude-fable-5[1m]", T1, T0);
ok(p1 && fam(p1.model) === "fable" && fam(p1.model) !== fam("claude-opus-4-8"), "진짜 drift(고른 fable≠답 opus)는 여전히 잡힘");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
