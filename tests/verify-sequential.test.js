"use strict";
// 검증 회차 안내·Stop 안전밸브 회귀: 동시에 최대 1개, 완료 뒤 순차 N/M, 진행 시 Stop 카운터 리셋.
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "verify-seq_"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require("../bridge/contract-lib.js");
const CB = require("../bridge/codex-bridge.js");
const VH = require("../bridge/verify-cap-handoff.js");
let pass = 0, fail = 0;
function ok(v, name) { if (v) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name); } }
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

console.log("[1] 공통 지시와 최종 출력은 실제 N/5·순차 실행을 명시");
const d = CL.buildVerifyDirective("always", "ko", "integrity", { tracked: true, count: 2, budget: 5 });
ok(d.includes("동시에 최대 1개") && !d.includes("정확히 1개 시작"), "동시 작업 상한은 최대 1개");
ok(d.includes("2/5") && d.includes("다음 회차를 순차적으로") && d.includes("통과하면 멈춰라"), "현재 N/5와 후속 행동 명시");
const notice = CB.budgetNoticeLines({ tracked: true, n: 2, budget: 5 }, "ko", "integrity");
ok(notice.includes("검증 왕복 2/5") && notice.includes("호출 직전에 예약"), "중간 회차 ask-wait 출력에도 권위 있는 N/5 표시");

console.log("[2] 캠페인 진행이 생기면 Stop 반복 안전밸브가 새 진행으로 리셋");
const ws = path.join(home, "ws"), sid = "seq-session", turnTs = "2026-07-25T01:02:03.000Z";
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(home, "contracts"), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ verifyMode: "always", verifyBudget: 5 }));
fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
fs.writeFileSync(path.join(CL.ACTIVE_DIR, sid + ".json"), JSON.stringify({ workspace: ws, claudeSession: sid, ts: turnTs }));
const tx = path.join(home, "turn.jsonl");
fs.writeFileSync(tx, JSON.stringify({ type: "user", sessionId: sid, timestamp: turnTs, message: { content: [{ type: "text", text: "검증해" }] } }) + "\n");
const guard = path.join(__dirname, "..", "bridge", "verify-guard.js");
const run = () => cp.spawnSync(process.execPath, [guard], {
  input: JSON.stringify({ transcript_path: tx, cwd: ws, session_id: sid, stop_hook_active: true }), encoding: "utf8",
  env: { ...process.env, CODEX_BRIDGE_HOME: home, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: ws },
});
const blocked = (r) => { try { return JSON.parse(r.stdout.trim()).decision === "block"; } catch { return false; } };
ok(blocked(run()) && blocked(run()) && blocked(run()), "진행 없는 같은 상태는 유한 횟수 차단");
const campaignId = "cl:" + sid + ":" + turnTs;
fs.mkdirSync(CL.CAMPAIGN_DIR, { recursive: true });
fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId, count: 1, budget: 5, startedAt: turnTs, updatedAt: new Date().toISOString() }));
const afterProgress = run();
ok(blocked(afterProgress), "실제 예약이 0/5→1/5로 전진하면 Stop 안내 횟수가 리셋돼 계속 보호");
ok(String(JSON.parse(afterProgress.stdout).reason).includes("실제 회차 1/5"), "Stop 안내에는 내부 반복 1/3 대신 실제 1/5 표시");

console.log("[3] 5/5 소진 뒤에는 새 작업을 제안하지 않음");
fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId, count: 5, budget: 5, startedAt: turnTs, updatedAt: new Date().toISOString() }));
const capped = JSON.parse(run().stdout).reason;
ok(capped.includes("실제 회차 5/5") && !capped.includes("ask-start"), "5/5에서는 새 검증 대신 보류·선택지 보고");

const handoffKo = `[검증 상한 인계]
[수용·처리]
없음
[반박·종결]
없음
[보관함 이관]
없음
[사용자 판단 필요]
- EVIDENCE-UNAVAILABLE — 대상: 저장한 선택값. 상황: 화면을 다시 열면 그 선택이 사라질 수 있습니다. 위험: 사용자가 끝난 작업으로 오해할 수 있습니다. 선택 1: 위험을 감수하고 현재 상태를 유지합니다. 선택 2: 다음 턴에 원인을 다시 확인하고 수정합니다.
[경고등 의미]
verdict-nonclean 빨간 경고는 통과 인증이 없다는 뜻이라 남습니다. verify-handoff-missing 빨강은 이 마감문으로 해소되지만, 이 마감 자체는 검증 통과가 아닙니다.
[권장]
사용자가 끝난 작업으로 오인하는 위험을 막기 위해 선택 2로 다음 턴에 다시 확인하는 것을 권장합니다.`;
ok(VH.validateCapHandoff(handoffKo).ok, "필수 내용을 채운 한국어 상한 인계문 판독");
ok(VH.validateCapHandoff(handoffKo).needsUserDecision, "실제 선택 항목이 있을 때만 사용자 판단 대기로 분류");
ok(!VH.validateCapHandoff("[검증 상한 인계]\n[사용자 판단 필요]").ok, "제목·내용이 빠진 형식 흉내는 거부");
ok(!VH.validateCapHandoff(VH.capHandoffInstruction("ko", "5/5", "실패")).ok, "훅 안내문을 그대로 되풀이한 것은 실제 판단 인계로 인정하지 않음");
const editedEchoKo = VH.capHandoffInstruction("ko", "5/5", "실패").replace("없으면 없음.", "없음.");
ok(!VH.validateCapHandoff(editedEchoKo).ok, "보류 선택지만 지운 수정 안내문 echo도 실제 판단 인계로 인정하지 않음");
const partialEchoKo = handoffKo.replace("EVIDENCE-UNAVAILABLE — 대상: 저장한 선택값.", "각 근거는 아래 네 절 중 정확히 한 곳에만 두고 대상: 저장한 선택값.");
ok(!VH.validateCapHandoff(partialEchoKo).ok, "안내문 한 절만 남은 부분 echo도 거부");
const fillerEn = `[Verification cap closeout]\n[Accepted and handled]\nplaceholder content here\n[Rebutted and closed]\nplaceholder content here\n[Parked]\nplaceholder content here\n[User decision required]\nplaceholder content here\n[Alert meaning]\nplaceholder content here\n[Recommendation]\nplaceholder content here`;
ok(!VH.validateCapHandoff(fillerEn).ok, "모든 절을 일반 filler로 채운 형식 흉내 거부");
const genericEn = `[Verification cap closeout]\n[Accepted and handled]\nNone\n[Rebutted and closed]\nNone\n[Parked]\nNone\n[User decision required]\nTarget: a problem. Scenario: a situation may cause an issue. Risk: this problem could create a risk. Option 1: keep it. Option 2: change it.\n[Alert meaning]\nThe red alert remains because there is no pass certification.\n[Recommendation]\nThe recommended action is to fix it because a risk exists.`;
ok(!VH.validateCapHandoff(genericEn).ok, "문제·상황·위험 키워드만 배치한 대상 없는 일반론 거부");
const handoffEn = `[Verification cap closeout]\n[Accepted and handled]\nNone\n[Rebutted and closed]\nNone\n[Parked]\nNone\n[User decision required]\n- EVIDENCE-UNAVAILABLE — Target: the saved dashboard choice. Scenario: it may disappear after reopening. Risk: the user could mistake unfinished work for completion. Option 1: keep the known risk. Option 2: inspect and fix it next turn.\n[Alert meaning]\nThe red alert remains because there is no pass certification; this closeout does not clear that verdict.\n[Recommendation]\nI recommend option 2 because it avoids a false completion signal.`;
ok(VH.validateCapHandoff(handoffEn).ok, "영어 슬롯도 같은 내용의 상한 인계문을 판독");
const evidenceDir = path.join(home, "ask-jobs"), evidenceId = "ask-evidence-0000000001", evidenceCampaign = "cc:evidence:turn";
fs.mkdirSync(evidenceDir, { recursive: true });
const writeEvidenceJob = (id, campaignId, roundNo, answer, innerId = id, jobWs = ws) => {
  fs.writeFileSync(path.join(evidenceDir, id + ".json"), JSON.stringify({ id: innerId, state: "succeeded", workspace: jobWs, campaignId, verifyRound: roundNo, finishedAt: `2026-07-25T01:02:${String(roundNo).padStart(2, "0")}.000Z` }));
  if (answer !== null) fs.writeFileSync(path.join(evidenceDir, innerId + ".out"), answer);
};
writeEvidenceJob(evidenceId, evidenceCampaign, 5, `[지적 목록 v1]\n{"tag":"blocker","title":"저장한 선택값이 화면 재진입 뒤 사라진다"}\n[지적 목록 끝]\n검증: 실패\n`);
const parkReceipt = CL.backlogAdd(ws, { tag: "백로그", title: "저장한 선택값이 화면 재진입 뒤 사라진다", lang: "ko", mode: "test", profile: "core", source: "verify-sequential" });
const evidenceCtx = VH.capHandoffContext(home, ws, evidenceCampaign);
ok(evidenceCtx.evidence.length === 1 && evidenceCtx.evidence[0].key === "R5-F1" && evidenceCtx.alertKind === "verdict-nonclean" && !evidenceCtx.unavailable, "실제 캠페인 검증 출력에서 근거 키·제목·경고 종류를 결속");
const evidenceHandoff = handoffKo
  .replace("EVIDENCE-UNAVAILABLE — 대상: 저장한 선택값.", "R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 대상: 저장한 선택값.")
  .replace("verify-handoff-missing 빨강은 이 마감문으로 해소되지만", "verify-handoff-missing 빨강은 없고 verdict-nonclean은 나중의 통과 검증으로 해소되며");
ok(VH.validateCapHandoff(evidenceHandoff, evidenceCtx).ok, "인계문이 실제 지적 키·제목과 경고에 결속되면 승인");
ok(!VH.validateCapHandoff(handoffKo, evidenceCtx).ok, "형식이 완전해도 실제 지적 키·제목이 없으면 승인하지 않음");
const acceptedCloseout = `[검증 상한 인계]
[수용·처리]
- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 변경: \`restoreSavedChoice\` 복원 분기를 수정했습니다; 확인: 시험:재진입-회귀에서 선택값 유지 결과를 확인했습니다; 근거: tests/verify-sequential.test.js
[반박·종결]
없음
[보관함 이관]
없음
[사용자 판단 필요]
없음
[경고등 의미]
verdict-nonclean 빨강은 마지막 검증이 통과가 아니었음을 남기며 이번 마감은 통과 인증이 아닙니다. 사용자 행동은 필요 없고 나중의 정상 검증 통과 때 해소됩니다.
[권장]
사용자 판단 없이 처리 내용을 유지하고 다음 변경의 정상 검증에서 다시 확인하기를 권장합니다.`;
const acceptedResult = VH.validateCapHandoff(acceptedCloseout, evidenceCtx);
ok(acceptedResult.ok && !acceptedResult.needsUserDecision, "수용해 이미 처리한 지적만 있으면 사용자 질문 없이 자동 정리");
const rebuttedCloseout = acceptedCloseout
  .replace("[수용·처리]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 변경: `restoreSavedChoice` 복원 분기를 수정했습니다; 확인: 시험:재진입-회귀에서 선택값 유지 결과를 확인했습니다; 근거: tests/verify-sequential.test.js\n[반박·종결]\n없음", "[수용·처리]\n없음\n[반박·종결]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 관측: 재진입 시험 20회에서 값이 모두 유지됐습니다; 이유: `savedChoice` 소실 재현 0회라 종결합니다; 근거: 재진입 시험 20회");
ok(VH.validateCapHandoff(rebuttedCloseout, evidenceCtx).ok, "측정 반례와 이유를 남긴 반박은 사용자에게 떠넘기지 않고 종결");
const parkedCloseout = acceptedCloseout
  .replace("[수용·처리]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 변경: `restoreSavedChoice` 복원 분기를 수정했습니다; 확인: 시험:재진입-회귀에서 선택값 유지 결과를 확인했습니다; 근거: tests/verify-sequential.test.js\n[반박·종결]\n없음\n[보관함 이관]\n없음", `[수용·처리]\n없음\n[반박·종결]\n없음\n[보관함 이관]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 범위 밖 백로그로 이관했고 보관함 영수증 ${parkReceipt.id}를 기록했습니다.`);
ok(VH.validateCapHandoff(parkedCloseout, evidenceCtx).ok, "실제 형식의 보관함 영수증이 있는 보류는 사용자 질문 없이 이관");
ok(!VH.validateCapHandoff(parkedCloseout.replace(parkReceipt.id, "0123456789abcdef"), evidenceCtx).ok, "실제 장부에 없는 영수증으로 보관했다고 주장하는 마감은 거부");
const otherReceipt = CL.backlogAdd(ws, { tag: "백로그", title: "현재 지적과 관계없는 다른 보관 항목", lang: "ko", mode: "test", profile: "core", source: "verify-sequential" });
const otherReceiptCtx = VH.capHandoffContext(home, ws, evidenceCampaign);
ok(!VH.validateCapHandoff(parkedCloseout.replace(parkReceipt.id, otherReceipt.id), otherReceiptCtx).ok, "다른 지적의 실제 열린 영수증도 현재 지적에 재사용할 수 없음");
const duplicatedCloseout = acceptedCloseout.replace("[반박·종결]\n없음", "[반박·종결]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — 관측: 재현 시험 20회에서 값 유지가 관측됐습니다; 이유: `savedChoice` 소실 재현 0회라 종결합니다; 근거: 재진입 시험 20회");
ok(!VH.validateCapHandoff(duplicatedCloseout, evidenceCtx).ok, "같은 지적을 수용과 반박 두 갈래에 중복 배치하면 거부");
const extraPastFinding = acceptedCloseout.replace("[사용자 판단 필요]\n없음", "[사용자 판단 필요]\n- R4-F1 과거 회차의 이미 고친 지적 — 대상: 이전 화면. 상황: 다시 열 때. 위험: 불필요한 질문이 생깁니다. 선택 1: 유지. 선택 2: 다시 확인.");
ok(!VH.validateCapHandoff(extraPastFinding, evidenceCtx).ok, "최신 근거 집합 밖의 과거·임의 지적을 사용자 판단에 덧붙이면 거부");
const genericAccepted = acceptedCloseout.replace("변경: `restoreSavedChoice` 복원 분기를 수정했습니다; 확인: 시험:재진입-회귀에서 선택값 유지 결과를 확인했습니다; 근거: tests/verify-sequential.test.js", "변경: 해당 문제는 어떻게든 수정됐습니다; 확인: 성공적으로 확인됐습니다; 근거: 어떤 근거");
ok(!VH.validateCapHandoff(genericAccepted, evidenceCtx).ok, "대상·결과 없는 수용 일반론은 자동 정리로 승인하지 않음");
const genericRebutted = rebuttedCloseout.replace("관측: 재진입 시험 20회에서 값이 모두 유지됐습니다; 이유: `savedChoice` 소실 재현 0회라 종결합니다; 근거: 재진입 시험 20회", "관측: 어떤 결과가 관측됐습니다; 이유: 근거 때문에 이유가 있습니다; 근거: 어떤 근거");
ok(!VH.validateCapHandoff(genericRebutted, evidenceCtx).ok, "관측 결과·종결 이유 없는 반박 일반론은 승인하지 않음");
const connectorOnlyEn = `[Verification cap closeout]\n[Accepted and handled]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — Change: the issue was fixed somehow; Check: it was checked successfully; Evidence: tests/verify-sequential.test.js\n[Rebutted and closed]\nNone\n[Parked]\nNone\n[User decision required]\nNone\n[Alert meaning]\nThe verdict-nonclean red alert remains because this closeout is not a verification pass and clears after a later pass.\n[Recommendation]\nNo user decision is needed because the item was handled.`;
ok(!VH.validateCapHandoff(connectorOnlyEn, evidenceCtx).ok, "유효한 파일 근거를 빌려도 변경·확인 자체가 연결어뿐이면 거부");
const quotedPlaceholderEn = connectorOnlyEn.replace("Evidence: tests/verify-sequential.test.js", "Evidence: `some evidence`");
ok(!VH.validateCapHandoff(quotedPlaceholderEn, evidenceCtx).ok, "백틱으로 감싼 some evidence도 식별 근거로 승인하지 않음");
const quotedAllEn = connectorOnlyEn.replace("Change: the issue was fixed somehow; Check: it was checked successfully; Evidence: tests/verify-sequential.test.js", 'Change: "the issue was fixed"; Check: "it was checked"; Evidence: "the proof"');
ok(!VH.validateCapHandoff(quotedAllEn, evidenceCtx).ok, "큰따옴표 일반론·none·unknown·the proof는 기계 근거로 승인하지 않음");
ok(!VH.validateCapHandoff(quotedAllEn.replace('"the proof"', '"none"'), evidenceCtx).ok && !VH.validateCapHandoff(quotedAllEn.replace('"the proof"', '"unknown"'), evidenceCtx).ok, "큰따옴표 none·unknown placeholder도 모두 거부");
const punctuationTicksEn = connectorOnlyEn.replace("Change: the issue was fixed somehow; Check: it was checked successfully; Evidence: tests/verify-sequential.test.js", "Change: `--` fixed; Check: `??` tested; Evidence: `..`");
ok(!VH.validateCapHandoff(punctuationTicksEn, evidenceCtx).ok, "문자·숫자 없는 백틱 구두점은 식별자로 승인하지 않음");
const punctuationKeysEn = connectorOnlyEn.replace("Change: the issue was fixed somehow; Check: it was checked successfully; Evidence: tests/verify-sequential.test.js", "Change: test:?? changed; Check: config:-- tested; Evidence: symbol:..");
ok(!VH.validateCapHandoff(punctuationKeysEn, evidenceCtx).ok, "test·config·symbol 값이 구두점뿐이면 명시 키 근거로 승인하지 않음");
const concreteEn = connectorOnlyEn.replace("the issue was fixed somehow; Check: it was checked successfully; Evidence: tests/verify-sequential.test.js", "`savedChoiceRestore` keeps the persisted value; Check: test:reopen-regression preserved the selected value; Evidence: tests/verify-sequential.test.js");
ok(VH.validateCapHandoff(concreteEn, evidenceCtx).ok, "파일·시험을 식별한 영문 수용 근거는 정상 승인");
fs.appendFileSync(CL.backlogFileFor(ws), "{broken backlog line\n", "utf8");
const damagedBacklogCtx = VH.capHandoffContext(home, ws, evidenceCampaign);
ok(!damagedBacklogCtx.backlogHealthy && !VH.validateCapHandoff(parkedCloseout, damagedBacklogCtx).ok, "보관함 장부가 손상되면 열린 영수증처럼 자동 종결하지 않음");
const missingCampaign = "cc:missing-latest:turn";
writeEvidenceJob("ask-missingr4-0000000004", missingCampaign, 4, `[지적 목록 v1]\n{"tag":"blocker","title":"이전 회차 저장 오류"}\n[지적 목록 끝]\n검증: 실패\n`);
writeEvidenceJob("ask-missingr5-0000000005", missingCampaign, 5, null);
const missingCtx = VH.capHandoffContext(home, ws, missingCampaign);
ok(missingCtx.unavailable && missingCtx.source === "ask-missingr5-0000000005" && missingCtx.evidence.length === 0, "최신 성공 출력 누락은 과거 근거로 은폐하거나 되살리지 않음");
const missingHandoffWithoutFlag = handoffKo.replace("EVIDENCE-UNAVAILABLE — ", "");
ok(!VH.validateCapHandoff(missingHandoffWithoutFlag, missingCtx).ok, "최신 출력 누락 시 EVIDENCE-UNAVAILABLE 없는 인계 승인 거부");
const corruptCampaign = "cc:partial-corrupt:turn";
writeEvidenceJob("ask-partial-0000000005", corruptCampaign, 5, `[지적 목록 v1]\n{"tag":"blocker","title":"첫 지적"}\n{broken json\n[지적 목록 끝]\n검증: 실패\n`);
const corruptCtx = VH.capHandoffContext(home, ws, corruptCampaign);
ok(corruptCtx.unavailable && corruptCtx.evidence.length === 0, "부분 손상 findings 블록은 읽힌 앞줄만 정상 근거로 위장하지 않음");
const mismatchCampaign = "cc:id-mismatch:turn";
writeEvidenceJob("ask-local-0000000001", mismatchCampaign, 5, `[지적 목록 v1]\n{"tag":"blocker","title":"바꿔치기 지적"}\n[지적 목록 끝]\n검증: 실패\n`, "ask-other-0000000002");
const mismatchCtx = VH.capHandoffContext(home, ws, mismatchCampaign);
ok(mismatchCtx.unavailable && mismatchCtx.evidence.length === 0, "ask-job 파일명과 내부 id 불일치는 출력 바꿔치기로 거부");
const latestOnlyCampaign = "cc:latest-only:turn";
writeEvidenceJob("ask-latestr4-0000000004", latestOnlyCampaign, 4, `[지적 목록 v1]\n{"tag":"blocker","title":"4회차에서 이미 고친 과거 지적"}\n[지적 목록 끝]\n검증: 실패\n`);
writeEvidenceJob("ask-latestr5-0000000005", latestOnlyCampaign, 5, `[지적 목록 v1]\n{"tag":"blocker","title":"5회차에 실제로 남은 현재 지적"}\n[지적 목록 끝]\n검증: 실패\n`);
const latestOnlyCtx = VH.capHandoffContext(home, ws, latestOnlyCampaign);
ok(latestOnlyCtx.evidence.length === 1 && latestOnlyCtx.evidence[0].title === "5회차에 실제로 남은 현재 지적", "앞 회차에서 사라진 지적은 상한 마감에 부활하지 않고 마지막 회차만 분류");
const manyCampaign = "cc:thirteen:turn";
const manyLines = Array.from({ length: 13 }, (_, i) => JSON.stringify({ tag: "blocker", title: `서로 다른 지적 ${i + 1}` })).join("\n");
writeEvidenceJob("ask-thirteen-0000000005", manyCampaign, 5, `[지적 목록 v1]\n${manyLines}\n[지적 목록 끝]\n검증: 실패\n`);
const manyCtx = VH.capHandoffContext(home, ws, manyCampaign);
ok(!manyCtx.unavailable && manyCtx.evidence.length === 13 && manyCtx.evidence[12].key === "R5-F13", "13개 지적을 12개에서 침묵 절단하지 않고 전부 결속");
const manyAccepted = manyCtx.evidence.map((e, i) => `- ${e.key} ${e.title} — 변경: ${i + 1}번 저장 분기의 복원 조건을 수정했습니다; 확인: ${i + 1}번 재진입 시험에서 값 유지 결과를 확인했습니다; 근거: tests/verify-sequential.test.js`).join("\n");
const manyCloseout = `[검증 상한 인계]\n[수용·처리]\n${manyAccepted}\n[반박·종결]\n없음\n[보관함 이관]\n없음\n[사용자 판단 필요]\n없음\n[경고등 의미]\nverdict-nonclean 빨강은 마지막 검증의 통과 인증이 없음을 남기며 이 마감은 통과가 아닙니다. 사용자 행동은 필요 없고 나중 통과 때 해소됩니다.\n[권장]\n사용자 판단 없이 처리 결과를 유지하고 다음 정상 검증에서 확인하기를 권장합니다.`;
ok(VH.validateCapHandoff(manyCloseout, manyCtx).ok, "R5-F1과 R5-F10을 포함한 13개 정상 마감도 부분문자열 충돌 없이 승인");
const holdCampaign = "cc:hold-verdict:turn";
writeEvidenceJob("ask-hold-0000000005", holdCampaign, 5, `[findings v1]\n{"tag":"blocker","title":"A concrete held finding"}\n[findings end]\nVerdict: inconclusive\n`);
const holdCtx = VH.capHandoffContext(home, ws, holdCampaign);
ok(holdCtx.alertKind === "verdict-nonclean" && !holdCtx.unavailable, "보류 판정도 공용 판독 의미대로 verdict-nonclean 경고에 결속");
ok(VH.verdictFromAnswer(`[지적 목록 끝]\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: 검증: 실패`) === "fail"
  && VH.verdictFromAnswer(`[findings end]\n\n---\n[Claude handling note — next action, not a color label]\nCodex declared: Verdict: inconclusive`) === "inconclusive", "브릿지가 재배치한 실제 .out의 실패·보류도 공용 판독기로 복원");
const demoteRaw = `[findings v1]\n{"tag":"blocker","title":"A blocker contradicts pass"}\n[findings end]\nVerdict: pass`;
const demoteParse = CL.parseFindingsBlock(demoteRaw);
const demoteMachine = CL.judgeMachineVerdict(CL.extractVerdict(demoteRaw), demoteParse);
const demoteFormatted = CL.formatForClaude(demoteRaw, "en", "core", demoteMachine);
ok(demoteMachine.effective === "inconclusive" && VH.verdictFromAnswer(demoteFormatted) === "inconclusive", "실제 formatForClaude pass→기계 보류 강등은 원 선언보다 실효 판정을 우선");
fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: "2026-07-25T01:02:30.000Z", message: { content: [{ type: "text", text: fillerEn }] } }) + "\n");
ok(blocked(run()), "CL-C 실제 transcript에서도 filler 인계는 held로 우회하지 못함");
fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: "2026-07-25T01:02:40.000Z", message: { content: [{ type: "text", text: genericEn }] } }) + "\n");
ok(blocked(run()), "CL-C 실제 transcript에서도 키워드형 일반론은 held로 우회하지 못함");
writeEvidenceJob("ask-clcloseout-0000000005", campaignId, 5, `[지적 목록 v1]\n{"tag":"blocker","title":"저장한 선택값이 화면 재진입 뒤 사라진다"}\n[지적 목록 끝]\n검증: 실패\n`);
fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: "2026-07-25T01:03:00.000Z", message: { content: [{ type: "text", text: evidenceHandoff }] } }) + "\n");
ok(run().stdout === "", "5/5 뒤 완전한 인계문이 있으면 정상 종료");
const heldPhase = JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8"));
ok(heldPhase.phase === "held" && heldPhase.round === 5, "정상 상한 종결은 미검증이 아니라 사용자 판단 대기");
fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: "2026-07-25T01:03:10.000Z", message: { content: [{ type: "text", text: acceptedCloseout }] } }) + "\n");
ok(run().stdout === "" && JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8")).phase === "cap-settled", "사용자 판단 항목이 없으면 자동 정리 완료(통과 아님)로 구분");
ok([run(), run(), run(), run()].every((x) => x.stdout === ""), "인계 뒤 Stop을 반복해도 다시 차단하거나 오경고하지 않음");
ok(!CL.readIntegrityEvents().some((e) => e.kind === "verify-handoff-missing" || e.kind === "verify-incomplete"), "정상 상한 인계에는 빨간 누락·미검증 경고 0건");

console.log("[4] Codex↔Codex Stop 경로도 같은 캠페인 진행값을 사용");
const hookSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
ok(hookSrc.includes("verifyCampaignProgress(ws,campaignId,effectiveVerifyBudget(c))")
  && hookSrc.includes("bump(ATTEMPT_DIR,sid,turnId,progressEpoch)"), "C-C Stop도 실제 캠페인 진행 세대로 반복 상태를 리셋");
ok(!hookSrc.includes("${n}/${MAX_VERIFY_ATTEMPTS}"), "C-C 사용자 안내에 내부 Stop 재촉 횟수를 검증 N/M으로 노출하지 않음");

console.log("[5] Codex↔Codex도 실제 대화의 인계문을 확인한 뒤 판단 대기로 종료");
const wsC = path.join(home, "ws-codex"), sidC = "cccccccc-1111-2222-3333-444444444444", turnC = "turn-cap";
fs.mkdirSync(wsC, { recursive: true });
fs.writeFileSync(CL.contractFileFor(wsC, "ko"), JSON.stringify({ workspace: wsC, harnessMode: "codex-codex", codexVerifyMode: "always", codexVerifyBudget: 5 }));
fs.writeFileSync(path.join(home, "links.json"), JSON.stringify({ roleRevision: 1, byWorkspace: { [CL.normWs(wsC)]: { workspace: wsC, implementerSession: sidC, implementerRevision: 1, implementerEventAt: Date.now() - 1000 } } }));
const turnDir = path.join(home, "codex-turns"); fs.mkdirSync(turnDir, { recursive: true });
fs.writeFileSync(path.join(turnDir, sidC + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: turnC, workspace: wsC, startedAt: Date.now() - 500, lastActionAt: 0, modified: false, permissionMode: "default" }));
const campC = "cc:" + sidC + ":" + turnC;
fs.writeFileSync(CL.campaignFileFor(wsC), JSON.stringify({ schema: "vcamp-1", campaignId: campC, count: 5, budget: 5, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
const codexHome = path.join(home, "codex-home"), rolloutDir = path.join(codexHome, "sessions", "2026", "07", "25");
fs.mkdirSync(rolloutDir, { recursive: true });
const rollout = path.join(rolloutDir, "rollout-" + sidC + ".jsonl");
const msg = (role, text) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: sidC, source: "vscode", thread_source: "user" } }) + "\n" + msg("user", "상한 동작 확인") + "\n");
const hook = path.join(__dirname, "..", "bridge", "codex-hook.js");
const runC = () => cp.spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: "Stop", session_id: sidC, turn_id: turnC, cwd: wsC, permission_mode: "default" }), encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_HOME: codexHome } });
const capC = runC();
ok(capC.stdout.includes("[검증 상한 인계]") && !capC.stdout.includes("ask-start"), "C-C 5/5도 새 검증 대신 정확한 인계 양식을 요구");
runC(); runC(); const escapedC = runC();
const missedC = CL.readIntegrityEvents().filter((e) => e.workspace && CL.normWs(e.workspace) === CL.normWs(wsC));
ok(escapedC.stdout === "" && missedC.some((e) => e.kind === "verify-handoff-missing") && !missedC.some((e) => e.kind === "verify-incomplete"), "인계문을 끝내 쓰지 못했을 때만 별도 빨강을 남기고 일반 미검증으로 오분류하지 않음");
fs.appendFileSync(rollout, msg("assistant", fillerEn) + "\n");
runC();
const fillerPhaseC = JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8"));
ok(fillerPhaseC.phase !== "held" && CL.readIntegrityEvents().some((e) => e.workspace && CL.normWs(e.workspace) === CL.normWs(wsC) && e.kind === "verify-handoff-missing"), "C-C 실제 rollout에서도 filler 인계는 held로 우회하거나 누락 빨강을 지우지 못함");
fs.appendFileSync(rollout, msg("assistant", genericEn) + "\n");
runC();
const genericPhaseC = JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8"));
ok(genericPhaseC.phase !== "held" && CL.readIntegrityEvents().some((e) => e.workspace && CL.normWs(e.workspace) === CL.normWs(wsC) && e.kind === "verify-handoff-missing"), "C-C 실제 rollout에서도 키워드형 일반론은 held로 우회하거나 누락 빨강을 지우지 못함");
fs.appendFileSync(rollout, msg("assistant", handoffKo) + "\n");
ok(runC().stdout === "", "C-C 실제 rollout에 인계문이 생기면 정상 종료");
const heldC = JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8"));
ok(heldC.phase === "held" && heldC.round === 5 && CL.normWs(heldC.workspace) === CL.normWs(wsC), "C-C도 사용자 판단 대기로 표시");
writeEvidenceJob("ask-cccloseout-0000000005", campC, 5, `[지적 목록 v1]\n{"tag":"blocker","title":"저장한 선택값이 화면 재진입 뒤 사라진다"}\n[지적 목록 끝]\n검증: 실패\n`, "ask-cccloseout-0000000005", wsC);
fs.appendFileSync(rollout, msg("assistant", acceptedCloseout) + "\n");
ok(runC().stdout === "" && JSON.parse(fs.readFileSync(CL.PHASE_FILE, "utf8")).phase === "cap-settled", "C-C 실제 rollout도 사용자 판단 없는 마감을 자동 정리 완료(통과 아님)로 표시");
ok(!CL.readIntegrityEvents().some((e) => e.workspace && CL.normWs(e.workspace) === CL.normWs(wsC) && (e.kind === "verify-handoff-missing" || e.kind === "verify-incomplete")), "인계문이 완성되면 누락 빨강이 자동 해소되고 일반 미검증도 없음");

try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
