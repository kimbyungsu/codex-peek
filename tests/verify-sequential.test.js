"use strict";
// 검증 회차 안내·Stop 안전밸브 회귀: 동시에 최대 1개, 완료 뒤 순차 N/M, 진행 시 Stop 카운터 리셋.
// 주입 구조화 이후: '진행 규칙'의 정본은 Stop 훅 차단문이고 매 턴 주입문은 그것을 되풀이하지 않는다.
// → [1]은 '주입문에서 빠졌다', [2]는 '훅이 실제로 말한다'를 각각 고정한다(둘이 짝).
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

console.log("[1] 매 턴 주입문은 훅이 강제하는 진행 규칙을 되풀이하지 않는다(기계가 못 잡는 것만 남김)");
const d = CL.buildVerifyDirective("always", "ko", "integrity", { tracked: true, count: 2, budget: 5 });
ok(!d.includes("동시에 최대 1개") && !d.includes("통과하면 멈춰라") && !d.includes("연결된 검증 세션이 있으면") && !d.includes("정확히 1개 시작"),
  "훅이 차단하며 알려주는 진행 규칙 산문이 주입문에서 빠짐");
ok(d.includes("종료 훅과 예약기가 실제로 막고"), "대신 한 줄 표지가 어디서 알려주는지 가리킴");
// 1차 검증 blocker① 반영: '통과하면 멈춰라'는 어떤 장치도 강제하지 않는다(훅은 통과 증명이 있으면 그냥
// 종료를 허용하고, 예약기는 판정이 아니라 횟수만 본다). 따라서 이 한 줄은 뺄 수 없다.
ok(d.includes("통과 판정을 받으면 거기서 멈춰라"), "통과 후 중지는 기계가 안 막으므로 주입문에 남김");
ok(d.includes("ask-start --allow-new") && d.includes("ask-wait <job-id>"),
  "먼저 스스로 시작할 수 있도록 실행 명령은 남김(훅은 턴 끝에만 작동)");
ok(d.includes("2/5") && !d.includes("권위 있는 N/M은"), "현재 진행은 남기되 '권위 있는 회차' 설명은 판정 답 하단에 위임");
ok(d.includes("선택지 도구로 제시하라"), "기계가 못 잡는 질문 형식 규칙은 그대로 유지");
const dEn = CL.buildVerifyDirective("always", "en", "integrity", { tracked: true, count: 2, budget: 5 });
ok(!dEn.includes("At most one durable") && !dEn.includes("start the next round sequentially only after") && !dEn.includes("path is quoted"),
  "영문 주입문도 같은 중복이 빠짐");
ok(dEn.includes("enforced by the stop hook") && dEn.includes("ask-start --allow-new") && dEn.includes("choice tool") && dEn.includes("Stop on a pass verdict"),
  "영문도 표지·실행 명령·질문 형식·통과 후 중지는 유지");
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
const reasonOf = (r) => { try { return String(JSON.parse(r.stdout.trim()).reason || ""); } catch { return ""; } };
const first = run();
ok(blocked(first) && blocked(run()) && blocked(run()), "진행 없는 같은 상태는 유한 횟수 차단");
// [1]의 짝: 주입문에서 뺀 진행 규칙이 실제로 훅 차단문에 살아 있어야 한다(양쪽 다 없으면 규칙이 사라진 것).
const r1 = reasonOf(first);
ok(r1.includes("동시에 최대 1개") && r1.includes("ask-start --allow-new") && r1.includes("ask-wait <job-id>"),
  "Stop 훅 차단문이 동시 1개 제한과 실행 명령을 직접 전달");
ok(r1.includes("순차적으로") && r1.includes("통과하면 멈춰라") && r1.includes("새 검증 세션을 만든다"),
  "Stop 훅 차단문이 순차 진행·정지·세션 연결 규칙을 직접 전달");
ok(/실제 deadline/.test(r1), "Stop 훅 차단문이 실제 마감시간을 직접 전달");
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
[잔여 위험 판단]
다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.
[경고등 의미]
verdict-nonclean 빨간 경고는 통과 인증이 없다는 뜻이라 남습니다. verify-handoff-missing 빨강은 이 마감문으로 해소되지만, 이 마감 자체는 검증 통과가 아닙니다.
[권장]
사용자가 끝난 작업으로 오인하는 위험을 막기 위해 선택 2로 다음 턴에 다시 확인하는 것을 권장합니다.`;
ok(VH.validateCapHandoff(handoffKo).ok, "필수 내용을 채운 한국어 상한 인계문 판독");
// [잔여 위험 판단 2026-08-29] 절 부재·셋 밖 시작·이유 없음·'즉시 재검증'인데 권장이 검증을 말하지 않음=거부 / 정상 3종=승인
ok(!VH.validateCapHandoff(handoffKo.replace(/\[잔여 위험 판단\]\n[^\n]*\n/, "")).ok, "잔여 위험 판단 절 부재=거부(판단 없이 사실 적시만 하는 마감 차단)");
ok(!VH.validateCapHandoff(handoffKo.replace("다음 캠페인 도장 — 이유:", "나중에 보자 — 이유:")).ok, "셋 밖 문구로 시작=거부");
ok(!VH.validateCapHandoff(handoffKo.replace("다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.", "다음 캠페인 도장 — 그냥 그렇게 하겠습니다 이번엔 넘어갑니다")).ok, "이유 없음=거부");
ok(!VH.validateCapHandoff(handoffKo.replace("다음 캠페인 도장 — 이유:", "즉시 재검증 — 이유:")).ok, "즉시 재검증인데 권장 절이 새 검증을 말하지 않음=거부(판단과 권장 불일치)");
{ const nowKo = handoffKo.replace("다음 캠페인 도장 — 이유:", "즉시 재검증 — 이유:").replace(/\[권장\]\n[^\n]*/, "[권장]\n이 턴에서 새 검증 캠페인을 바로 시작하기를 권장합니다(경계 수정이 미검증이기 때문).");
  const rNow = VH.validateCapHandoff(nowKo); ok(rNow.ok && rNow.residualRisk === "now", "즉시 재검증+권장 일치=승인·판정 반환");
  const rIgn = VH.validateCapHandoff(handoffKo.replace("다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.", "무시 가능 — 이유: 마지막 판정 뒤 코드 수정이 없고 보고 문구만 바뀌었습니다.")); ok(rIgn.ok && rIgn.residualRisk === "ignore", "무시 가능+이유=승인");
  ok(VH.capHandoffInstruction("ko", "5/5", "실패").includes("[잔여 위험 판단]") && VH.capHandoffInstruction("en", "5/5", "fail").includes("[Residual risk call]"), "안내문 ko/en에 절 포함"); }
ok(VH.validateCapHandoff(handoffKo).needsUserDecision, "실제 선택 항목이 있을 때만 사용자 판단 대기로 분류");
ok(!VH.validateCapHandoff("[검증 상한 인계]\n[사용자 판단 필요]").ok, "제목·내용이 빠진 형식 흉내는 거부");
ok(!VH.validateCapHandoff(VH.capHandoffInstruction("ko", "5/5", "실패")).ok, "훅 안내문을 그대로 되풀이한 것은 실제 판단 인계로 인정하지 않음");
const editedEchoKo = VH.capHandoffInstruction("ko", "5/5", "실패").replace("없으면 없음.", "없음.");
ok(!VH.validateCapHandoff(editedEchoKo).ok, "보류 선택지만 지운 수정 안내문 echo도 실제 판단 인계로 인정하지 않음");
const partialEchoKo = handoffKo.replace("EVIDENCE-UNAVAILABLE — 대상: 저장한 선택값.", "각 근거는 아래 네 절 중 정확히 한 곳에만 두고 대상: 저장한 선택값.");
ok(!VH.validateCapHandoff(partialEchoKo).ok, "안내문 한 절만 남은 부분 echo도 거부");
const fillerEn = `[Verification cap closeout]\n[Accepted and handled]\nplaceholder content here\n[Rebutted and closed]\nplaceholder content here\n[Parked]\nplaceholder content here\n[User decision required]\nplaceholder content here\n[Residual risk call]\nNext campaign — Reason: the unverified edit is a single test wording line covered by regression tests.\n[Alert meaning]\nplaceholder content here\n[Recommendation]\nplaceholder content here`;
ok(!VH.validateCapHandoff(fillerEn).ok, "모든 절을 일반 filler로 채운 형식 흉내 거부");
const genericEn = `[Verification cap closeout]\n[Accepted and handled]\nNone\n[Rebutted and closed]\nNone\n[Parked]\nNone\n[User decision required]\nTarget: a problem. Scenario: a situation may cause an issue. Risk: this problem could create a risk. Option 1: keep it. Option 2: change it.\n[Residual risk call]\nNext campaign — Reason: the unverified edit is a single test wording line covered by regression tests.\n[Alert meaning]\nThe red alert remains because there is no pass certification.\n[Recommendation]\nThe recommended action is to fix it because a risk exists.`;
ok(!VH.validateCapHandoff(genericEn).ok, "문제·상황·위험 키워드만 배치한 대상 없는 일반론 거부");
const handoffEn = `[Verification cap closeout]\n[Accepted and handled]\nNone\n[Rebutted and closed]\nNone\n[Parked]\nNone\n[User decision required]\n- EVIDENCE-UNAVAILABLE — Target: the saved dashboard choice. Scenario: it may disappear after reopening. Risk: the user could mistake unfinished work for completion. Option 1: keep the known risk. Option 2: inspect and fix it next turn.\n[Residual risk call]\nNext campaign — Reason: the unverified edit is a single test wording line covered by regression tests.\n[Alert meaning]\nThe red alert remains because there is no pass certification; this closeout does not clear that verdict.\n[Recommendation]\nI recommend option 2 because it avoids a false completion signal.`;
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
[잔여 위험 판단]
다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.
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
const connectorOnlyEn = `[Verification cap closeout]\n[Accepted and handled]\n- R5-F1 저장한 선택값이 화면 재진입 뒤 사라진다 — Change: the issue was fixed somehow; Check: it was checked successfully; Evidence: tests/verify-sequential.test.js\n[Rebutted and closed]\nNone\n[Parked]\nNone\n[User decision required]\nNone\n[Residual risk call]\nNext campaign — Reason: the unverified edit is a single test wording line covered by regression tests.\n[Alert meaning]\nThe verdict-nonclean red alert remains because this closeout is not a verification pass and clears after a later pass.\n[Recommendation]\nNo user decision is needed because the item was handled.`;
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
const manyCloseout = `[검증 상한 인계]\n[수용·처리]\n${manyAccepted}\n[반박·종결]\n없음\n[보관함 이관]\n없음\n[사용자 판단 필요]\n없음\n[잔여 위험 판단]\n다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.\n[경고등 의미]\nverdict-nonclean 빨강은 마지막 검증의 통과 인증이 없음을 남기며 이 마감은 통과가 아닙니다. 사용자 행동은 필요 없고 나중 통과 때 해소됩니다.\n[권장]\n사용자 판단 없이 처리 결과를 유지하고 다음 정상 검증에서 확인하기를 권장합니다.`;
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

console.log("[3b] 마감문 '즉시 재검증' 판단=다음 턴 종료 차단 → 그 캠페인 id를 담은 통과 검증이 결속돼야 해소");
{
  const nowClose = acceptedCloseout.replace("다음 캠페인 도장 — 이유:", "즉시 재검증 — 이유:").replace(/\[권장\]\n[^\n]*/, "[권장]\n이 턴에서 새 검증 캠페인을 바로 시작하기를 권장합니다(경계 수정이 미검증이기 때문).");
  fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: "2026-07-25T01:03:20.000Z", message: { content: [{ type: "text", text: nowClose }] } }) + "\n");
  const rNow = run();
  const resF = path.join(home, "verify-findings", CL.wsKeyFor(ws) + ".residual-now.json");
  ok(rNow.stdout === "" && fs.existsSync(resF), "즉시 재검증 마감=이 턴은 정상 종결(캠페인=턴이라 같은 턴 재검증 불가)+마커 기록");
  const marker = JSON.parse(fs.readFileSync(resF, "utf8"));
  ok(marker.schema === "residual-now-v2" && marker.items.length === 1 && marker.items[0].campaignId === campaignId && Array.isArray(marker.items[0].evidence) && marker.items[0].evidence.length >= 1, "마커(목록형)=직전 캠페인 id+미검증 지적 결속");
  ok(CL.readIntegrityEvents().some((e) => e.kind === "verify-residual-now" && e.severity === "warning"), "대시보드 노랑 경보(즉시 재검증 대기)");
  // 다음 턴: 새 발화·새 캠페인(0/5)·proof까지 있어도 잔여 재검증이 결속되지 않으면 종료 차단
  const turn2 = "2026-07-25T02:00:00.000Z";
  fs.writeFileSync(path.join(CL.ACTIVE_DIR, sid + ".json"), JSON.stringify({ workspace: ws, claudeSession: sid, ts: turn2 }));
  fs.appendFileSync(tx, JSON.stringify({ type: "user", sessionId: sid, timestamp: turn2, message: { content: [{ type: "text", text: "다음 진행해" }] } }) + "\n");
  const campaign2 = "cl:" + sid + ":" + turn2;
  fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId: campaign2, count: 1, budget: 5, startedAt: turn2, updatedAt: new Date().toISOString() }));
  fs.mkdirSync(path.join(home, "proofs"), { recursive: true });
  fs.writeFileSync(path.join(home, "proofs", sid + ".json"), JSON.stringify({ v: 1, claudeSession: sid, workspace: ws, ts: "2026-07-25T02:00:30.000Z", codexSession: "x", exit: 0, status: "success", answerChars: 120 }));
  const rBlocked = run();
  ok(blocked(rBlocked) && reasonOf(rBlocked).includes("잔여 재검증") && reasonOf(rBlocked).includes(campaignId) && reasonOf(rBlocked).includes("ask-start --allow-new"), "★proof가 있어도 잔여 재검증 미결속=차단(정확한 요청 형식·캠페인 id 안내)");
  // 엉뚱한 통과(캠페인 id 미포함)로는 소비 불가
  fs.writeFileSync(path.join(evidenceDir, "ask-resid-000000000001.json"), JSON.stringify({ id: "ask-resid-000000000001", state: "succeeded", workspace: ws, campaignId: campaign2, verifyRound: 1, prompt: "다른 질문 검증", finishedAt: "2026-07-25T02:00:31.000Z" }));
  fs.writeFileSync(path.join(evidenceDir, "ask-resid-000000000001.out"), "[지적 목록 v2]\n[지적 목록 끝]\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: 검증: 통과\n");
  ok(blocked(run()), "★캠페인 id 없는 통과 job은 잔여 재검증을 소비하지 못함(식별자 결속)");
  // 캠페인 id를 담은 실패 job도 소비 불가
  fs.writeFileSync(path.join(evidenceDir, "ask-resid-000000000002.json"), JSON.stringify({ id: "ask-resid-000000000002", state: "succeeded", workspace: ws, campaignId: campaign2, verifyRound: 2, prompt: "[잔여 재검증 " + campaignId + "] 확인", finishedAt: "2026-07-25T02:00:32.000Z" }));
  fs.writeFileSync(path.join(evidenceDir, "ask-resid-000000000002.out"), "[지적 목록 v1]\n{\"tag\":\"blocker\",\"title\":\"아직 남음\"}\n[지적 목록 끝]\n검증: 실패\n");
  ok(blocked(run()), "캠페인 id를 담았어도 실패 판정은 소비 불가");
  // 캠페인 id를 담은 통과 job → 해소·마커 소멸·경보 해소
  fs.writeFileSync(path.join(evidenceDir, "ask-resid-000000000003.json"), JSON.stringify({ id: "ask-resid-000000000003", state: "succeeded", workspace: ws, campaignId: campaign2, verifyRound: 3, prompt: "[잔여 재검증 " + campaignId + "] 미검증분 확인", finishedAt: "2026-07-25T02:00:33.000Z" }));
  fs.writeFileSync(path.join(evidenceDir, "ask-resid-000000000003.out"), "[지적 목록 v2]\n[지적 목록 끝]\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: 검증: 통과\n");
  const rOk = run();
  ok(rOk.stdout === "" && !fs.existsSync(resF), "★캠페인 id 결속 통과=종료 허용·마커 소비");
  ok(!CL.readIntegrityEvents().some((e) => e.kind === "verify-residual-now" && !e.ack), "경보 해소");
  ok(run().stdout === "", "소비 뒤 재실행에도 재차단 없음");
}
console.log("[3c] 목록형 마커 — 뒤 캠페인 마감이 앞 캠페인 미검증분을 덮지 않음·finishedAt 전용·탈출 시 전용 빨강만·기록 실패=마감 미수락");
{
  const nowClose2 = acceptedCloseout.replace("다음 캠페인 도장 — 이유:", "즉시 재검증 — 이유:").replace(/\[권장\]\n[^\n]*/, "[권장]\n이 턴에서 새 검증 캠페인을 바로 시작하기를 권장합니다(경계 수정이 미검증이기 때문).");
  const resF = path.join(home, "verify-findings", CL.wsKeyFor(ws) + ".residual-now.json");
  const failAns = `[지적 목록 v1]\n{"tag":"blocker","title":"저장한 선택값이 화면 재진입 뒤 사라진다"}\n[지적 목록 끝]\n검증: 실패\n`;
  const passOut = "[지적 목록 v2]\n[지적 목록 끝]\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: 검증: 통과\n";
  const newTurn = (ts, cid, count) => { fs.writeFileSync(path.join(CL.ACTIVE_DIR, sid + ".json"), JSON.stringify({ workspace: ws, claudeSession: sid, ts })); fs.appendFileSync(tx, JSON.stringify({ type: "user", sessionId: sid, timestamp: ts, message: { content: [{ type: "text", text: "이어서" }] } }) + "\n"); fs.writeFileSync(CL.campaignFileFor(ws), JSON.stringify({ schema: "vcamp-1", campaignId: cid, count, budget: 5, startedAt: ts, updatedAt: new Date().toISOString() })); };
  const say = (ts, text) => fs.appendFileSync(tx, JSON.stringify({ type: "assistant", sessionId: sid, timestamp: ts, message: { content: [{ type: "text", text }] } }) + "\n");
  // A: 캠페인3 상한 마감(즉시 재검증) → 마커 [c3]
  const t3 = "2026-07-25T03:00:00.000Z", c3 = "cl:" + sid + ":" + t3;
  newTurn(t3, c3, 5); writeEvidenceJob("ask-c3-0000000005", c3, 5, failAns); say("2026-07-25T03:00:10.000Z", nowClose2);
  ok(run().stdout === "" && JSON.parse(fs.readFileSync(resF, "utf8")).items.map((x) => x.campaignId).join() === c3, "캠페인3 즉시 재검증 마감=마커 [c3]");
  // B: 캠페인3 미이행인 채 캠페인4도 상한 마감(즉시 재검증) → 마커 [c3, c4](덮어쓰기 없음)
  const t4 = "2026-07-25T04:00:00.000Z", c4 = "cl:" + sid + ":" + t4;
  newTurn(t4, c4, 5); writeEvidenceJob("ask-c4-0000000005", c4, 5, failAns); say("2026-07-25T04:00:10.000Z", nowClose2);
  ok(run().stdout === "" && JSON.parse(fs.readFileSync(resF, "utf8")).items.map((x) => x.campaignId).join() === c3 + "," + c4, "★뒤 캠페인 마감이 앞 캠페인 마커를 덮지 않음(목록 누적)");
  // C: 다음 턴 — 차단문에 두 캠페인 id 모두
  const t5 = "2026-07-25T05:00:00.000Z", c5 = "cl:" + sid + ":" + t5;
  newTurn(t5, c5, 1); fs.writeFileSync(path.join(home, "proofs", sid + ".json"), JSON.stringify({ v: 1, claudeSession: sid, workspace: ws, ts: "2026-07-25T05:00:30.000Z", codexSession: "x", exit: 0, status: "success", answerChars: 120 }));
  const rb = run(); ok(blocked(rb) && reasonOf(rb).includes(c3) && reasonOf(rb).includes(c4), "두 미검증 캠페인 id 모두 차단문에 명시");
  // finishedAt 없는 통과 job(startedAt만)=소비 불가
  fs.writeFileSync(path.join(evidenceDir, "ask-c3fin-00000000001.json"), JSON.stringify({ id: "ask-c3fin-00000000001", state: "succeeded", workspace: ws, campaignId: c5, verifyRound: 1, prompt: "[잔여 재검증 " + c3 + "] 확인", startedAt: "2026-07-25T05:00:31.000Z" }));
  fs.writeFileSync(path.join(evidenceDir, "ask-c3fin-00000000001.out"), passOut);
  ok(blocked(run()) && fs.existsSync(resF) && JSON.parse(fs.readFileSync(resF, "utf8")).items.length === 2, "★finishedAt 없는 job은 소비 불가(startedAt 대체 금지)");
  // c3 결속 통과 → c3만 소비, c4 남음 → 여전히 차단
  fs.writeFileSync(path.join(evidenceDir, "ask-c3fin-00000000002.json"), JSON.stringify({ id: "ask-c3fin-00000000002", state: "succeeded", workspace: ws, campaignId: c5, verifyRound: 2, prompt: "[잔여 재검증 " + c3 + "] 확인", finishedAt: "2026-07-25T05:00:32.000Z" }));
  fs.writeFileSync(path.join(evidenceDir, "ask-c3fin-00000000002.out"), passOut);
  const rPartial = run();
  ok(blocked(rPartial) && JSON.parse(fs.readFileSync(resF, "utf8")).items.map((x) => x.campaignId).join() === c4 && reasonOf(rPartial).includes(c4) && !reasonOf(rPartial).includes("[" + c3 + "]"), "부분 소비: c3만 빠지고 c4는 계속 차단");
  // MAX 탈출: 전용 빨강(verify-residual-now error)만 — 일반 verify-incomplete 병기 없음·마커 유지
  const incBefore = CL.readIntegrityEvents().filter((e) => e.kind === "verify-incomplete").length;
  run(); run(); const esc = run();
  const incAfter = CL.readIntegrityEvents().filter((e) => e.kind === "verify-incomplete").length;
  ok(esc.stdout === "" && incAfter === incBefore && CL.readIntegrityEvents().some((e) => e.kind === "verify-residual-now" && e.severity === "error" && !e.ack) && fs.existsSync(resF), "★탈출 시 전용 빨강만(일반 미검증 병기 없음)·마커 유지");
  // c4 결속 통과 → 전량 소비·해소
  const t6 = "2026-07-25T06:00:00.000Z", c6 = "cl:" + sid + ":" + t6;
  newTurn(t6, c6, 1); fs.writeFileSync(path.join(home, "proofs", sid + ".json"), JSON.stringify({ v: 1, claudeSession: sid, workspace: ws, ts: "2026-07-25T06:00:30.000Z", codexSession: "x", exit: 0, status: "success", answerChars: 120 }));
  fs.writeFileSync(path.join(evidenceDir, "ask-c4fin-00000000001.json"), JSON.stringify({ id: "ask-c4fin-00000000001", state: "succeeded", workspace: ws, campaignId: c6, verifyRound: 1, prompt: "[잔여 재검증 " + c4 + "] 확인", finishedAt: "2026-07-25T06:00:31.000Z" }));
  fs.writeFileSync(path.join(evidenceDir, "ask-c4fin-00000000001.out"), passOut);
  ok(run().stdout === "" && !fs.existsSync(resF) && !CL.readIntegrityEvents().some((e) => e.kind === "verify-residual-now" && !e.ack), "전량 소비=종료 허용·마커 소멸·경보 해소");
  // 마커 기록 실패(경로가 디렉터리)=마감 미수락(차단문 '기록 실패')·제거 후 재출력=수락
  const t7 = "2026-07-25T07:00:00.000Z", c7 = "cl:" + sid + ":" + t7;
  newTurn(t7, c7, 5); writeEvidenceJob("ask-c7-0000000005", c7, 5, failAns); say("2026-07-25T07:00:10.000Z", nowClose2);
  fs.mkdirSync(resF, { recursive: true });
  const rFail = run();
  ok(blocked(rFail) && reasonOf(rFail).includes("마커 기록 실패"), "★마커 기록 실패=마감 미수락(fail-closed)");
  fs.rmSync(resF, { recursive: true, force: true });
  ok(run().stdout === "" && JSON.parse(fs.readFileSync(resF, "utf8")).items.map((x) => x.campaignId).join() === c7, "장애 제거 후 같은 마감문 재판독=수락·마커 기록");
  fs.rmSync(resF, { force: true });
  // [2회차 blocker①] 노랑 경보 기록 실패(integrity.json이 디렉터리)=마감 미수락·복구 후 수락
  const t8 = "2026-07-25T08:00:00.000Z", c8 = "cl:" + sid + ":" + t8;
  newTurn(t8, c8, 5); writeEvidenceJob("ask-c8-0000000005", c8, 5, failAns); say("2026-07-25T08:00:10.000Z", nowClose2);
  const integF = path.join(home, "integrity.json"); const integBak = integF + ".bak";
  if (fs.existsSync(integF)) fs.renameSync(integF, integBak);
  fs.mkdirSync(integF, { recursive: true });
  const rAlert = run();
  ok(blocked(rAlert) && reasonOf(rAlert).includes("기록 실패"), "★노랑 경보 기록 실패=마감 미수락(마커만 성공해도 불충분)");
  fs.rmSync(integF, { recursive: true, force: true }); if (fs.existsSync(integBak)) fs.renameSync(integBak, integF);
  ok(run().stdout === "" && JSON.parse(fs.readFileSync(resF, "utf8")).items.map((x) => x.campaignId).join() === c8 && CL.readIntegrityEvents().some((e) => e.kind === "verify-residual-now" && e.severity === "warning" && !e.ack), "장애 제거 후 재판독=마커+경보 모두 기록·수락");
  fs.rmSync(resF, { force: true }); // 뒤 시험 무접촉
}
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
{ // [잔여 재검증 강제] Codex↔Codex Stop도 같은 정본 마커(1회차 [주의]) — 즉시 재검증 마감=마커+노랑 경보
  const nowCloseC = acceptedCloseout.replace("다음 캠페인 도장 — 이유:", "즉시 재검증 — 이유:").replace(/\[권장\]\n[^\n]*/, "[권장]\n이 턴에서 새 검증 캠페인을 바로 시작하기를 권장합니다(경계 수정이 미검증이기 때문).");
  fs.appendFileSync(rollout, msg("assistant", nowCloseC) + "\n");
  const resC = path.join(home, "verify-findings", CL.wsKeyFor(wsC) + ".residual-now.json");
  ok(runC().stdout === "" && fs.existsSync(resC) && JSON.parse(fs.readFileSync(resC, "utf8")).items[0].campaignId === campC, "C-C 즉시 재검증 마감=같은 정본 마커(캠페인 id 결속)");
  ok(CL.readIntegrityEvents().some((e) => e.workspace && CL.normWs(e.workspace) === CL.normWs(wsC) && e.kind === "verify-residual-now" && e.severity === "warning"), "C-C 노랑 경보");
  const hookSrc2 = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  ok(hookSrc2.includes("if(gate.ok&&residualOk)") && hookSrc2.includes("residualPending(ws,Number(s.startedAt||0))") && hookSrc2.includes('[잔여 재검증 미이행 · 실제 회차'), "C-C 다음 턴 종료도 잔여 결속 통과 전엔 차단(소스 계약 — 정본 헬퍼 공유)");
  // [2회차 blocker②] 다음 턴이 '검증 불필요'(codexVerifyMode=code·수정 없음)여도 잔여 미소비면 종료 차단 → 결속 통과로 소비
  fs.writeFileSync(CL.contractFileFor(wsC, "ko"), JSON.stringify({ workspace: wsC, harnessMode: "codex-codex", codexVerifyMode: "code", codexVerifyBudget: 5 }));
  const turnN = "turn-next"; const startN = Date.now();
  fs.writeFileSync(path.join(turnDir, sidC + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: turnN, workspace: wsC, startedAt: startN, lastActionAt: 0, modified: false, permissionMode: "default" }));
  fs.writeFileSync(CL.campaignFileFor(wsC), JSON.stringify({ schema: "vcamp-1", campaignId: "cc:" + sidC + ":" + turnN, count: 0, budget: 5, startedAt: new Date(startN).toISOString(), updatedAt: new Date().toISOString() }));
  const runCN = () => cp.spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: "Stop", session_id: sidC, turn_id: turnN, cwd: wsC, permission_mode: "default" }), encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_HOME: codexHome } });
  const rN = runCN();
  ok(rN.stdout.includes("잔여 재검증 미이행") && rN.stdout.includes(campC), "★C-C 검증 불필요 턴(needed=false)도 잔여 미소비면 차단(캠페인 id 안내)");
  fs.writeFileSync(path.join(evidenceDir, "ask-ccres-000000000001.json"), JSON.stringify({ id: "ask-ccres-000000000001", state: "succeeded", workspace: wsC, campaignId: "cc:" + sidC + ":" + turnN, verifyRound: 1, prompt: "[잔여 재검증 " + campC + "] 확인", finishedAt: new Date(startN + 1000).toISOString() }));
  fs.writeFileSync(path.join(evidenceDir, "ask-ccres-000000000001.out"), "[지적 목록 v2]\n[지적 목록 끝]\n\n---\n[Claude 처리 안내 — 색 라벨이 아니라 다음 행동]\nCodex 선언: 검증: 통과\n");
  ok(runCN().stdout === "" && !fs.existsSync(resC), "C-C 결속 통과=종료 허용·마커 소비");
  fs.rmSync(resC, { force: true });
}

console.log("[PASS-사례] 2026-08-05 이중 실패 봉합 — 통과·지적 0을 not-pass/판독불가로 둔갑시키지 않는다");
{
  const passId = "ask-passcase-0000000001", passCamp = "cl:passcase:turn";
  // 실사고 재현 픽스처: 마지막 회차가 깨끗한 통과(지적 목록 비어 있음) — ask-mse8h8mi와 동형
  writeEvidenceJob(passId, passCamp, 5, "본문 근거...\n[지적 목록 v2]\n[지적 목록 끝]\n검증: 통과\n");
  const passCtx = VH.capHandoffContext(home, ws, passCamp);
  ok(passCtx.verdict === "pass" && passCtx.passNoFindings === true && passCtx.unavailable === false, "문맥=판정 동봉·통과+지적0=passNoFindings(판독 실패로 조작 금지)");
  ok(passCtx.alertKind === "verify-incomplete", "경고 종류=잔여 미검증(보류 계열) — 인계 누락·판정 오염으로 위장하지 않음");
  const passMsg = VH.capHandoffInstruction("ko", "5/5", (passCtx && passCtx.verdict) || "not-pass", passCtx);
  ok(passMsg.includes("(마지막 판정: 통과)") && !passMsg.includes("not-pass") && !passMsg.includes("통과 아님"), "인계문=실제 판정 라벨(하드코딩 not-pass 거짓 전달 소멸)");
  ok(passMsg.includes("PASS-NO-FINDINGS") && !passMsg.includes("- EVIDENCE-UNAVAILABLE"), "근거 줄=PASS-NO-FINDINGS(지적을 읽지 못했다는 조작 표기 소멸)");
  // 전 절 없음 + 경고 키 명시 마감문이 승인되는지(지적이 없으니 행선지 요구도 없어야 함)
  const passClose = "[검증 상한 인계]\n[수용·처리]\n없음\n[반박·종결]\n없음\n[보관함 이관]\n없음\n[사용자 판단 필요]\n없음\n[잔여 위험 판단]\n다음 캠페인 도장 — 이유: 미검증 수정은 시험 한 줄 문구뿐이라 회귀 시험이 덮습니다.\n[경고등 의미]\n현재 경고 키 verify-incomplete — 마지막 판정은 통과였고 통과 이후 수정만 미검증이라 이 마감은 검증 통과가 아니며, 남은 노랑에 사용자 행동은 필요 없고 다음 턴 검증이 해소합니다.\n[권장]\n다음 턴 첫 검증으로 잔여 수정을 닫는 것을 권장합니다 — 사용자 판단 없음.";
  ok(VH.validateCapHandoff(passClose, passCtx).ok === true, "통과-잔여 마감문(전 절 없음)=승인(가짜 사용자 질문 강요 없음)");
  // 무회귀: 실패 사례는 종전대로 실제 판정 라벨 실패+지적 결속
  const failMsg = VH.capHandoffInstruction("ko", "5/5", evidenceCtx.verdict || "not-pass", evidenceCtx);
  ok(failMsg.includes("(마지막 판정: 실패)") && failMsg.includes("R5-F1"), "실패 사례=실패 라벨+실지적 결속(무회귀)");
  // 재확인 blocker① — 손상된 지적 블록은 통과여도 판독 불가(깨끗한 무지적 승격 금지)
  // 확인 검증 보완②: job id는 정본 형식(마지막 16진 10자리)이어야 id 검사 전에 탈락하지 않고 목표 분기(파싱 실패)에 실제로 도달한다.
  const corruptId = "ask-passcorrupt-0000000001", corruptCamp = "cl:passcorrupt:turn";
  writeEvidenceJob(corruptId, corruptCamp, 5, ["본문...", "[지적 목록 v2]", "{깨진 JSON", "[지적 목록 끝]", "검증: 통과", ""].join("\n"));
  const corruptCtx = VH.capHandoffContext(home, ws, corruptCamp);
  ok(corruptCtx.verdict === "pass" && corruptCtx.unavailable === true && !corruptCtx.passNoFindings, "통과+블록 손상=판독 불가(승격 금지 — 판정 동봉으로 id 검사 통과·파싱 실패 분기 도달 입증)");
  // 확인 검증 보완③: 손상-통과의 안내 경고 키는 실제 Stop 경보와 같은 verify-handoff-missing(문맥·이벤트 불일치 금지)
  ok(corruptCtx.alertKind === "verify-handoff-missing", "손상-통과 경고 키=실제 Stop 이벤트와 동일(verify-incomplete는 깨끗한 통과·지적 0 전용)");
  // 재확인 blocker② — passNoFindings 문맥에서 허구 키·가짜 사용자 판단 거부
  const passCtx2 = VH.capHandoffContext(home, ws, "cl:passcase:turn");
  const fakeUser = ["[Verification cap closeout]", "[Accepted and handled]", "None", "[Rebutted and closed]", "None", "[Parked]", "None", "[User decision required]", "- R1-F1 fabricated finding — Target: the saved choice. Scenario: it may vanish. Risk: false completion. Option 1: keep. Option 2: fix next turn.", "[Alert meaning]", "The verify-incomplete yellow remains; this closeout is not a verification pass.", "[Recommendation]", "I recommend option 2 because it avoids a false signal."].join("\n");
  ok(VH.validateCapHandoff(fakeUser, passCtx2).ok === false, "허구 키의 가짜 사용자 판단=거부(빈 허용 목록 무사통과 구멍 봉합)");
  const fakeAccept = fakeUser.replace("- R1-F1 fabricated finding — Target: the saved choice. Scenario: it may vanish. Risk: false completion. Option 1: keep. Option 2: fix next turn.", "None").replace("[Accepted and handled]\nNone", "[Accepted and handled]\n- R1-F1 fabricated — Change: `x.js` tweak; Check: test=ok 1 case; Evidence: `x.js`");
  ok(VH.validateCapHandoff(fakeAccept, passCtx2).ok === false, "허구 키의 가짜 수용 처리=거부");
  // 재확인 blocker③·보완 — 소스 계약: codex-hook·guard의 상한 경보가 passNoFindings 진실화(종류·문구)
  const hookSrc9 = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  ok((hookSrc9.match(/kind:\(handoffCtx&&handoffCtx\.passNoFindings\)\?"verify-incomplete":"verify-handoff-missing"/g) || []).length === 2, "codex-hook — 두 상한 경보 모두 통과-잔여=verify-incomplete");
  ok((hookSrc9.match(/마지막 판정은 통과였고 열린 지적도 없지만/g) || []).length === 2, "codex-hook — 진실 문구 2곳");
  const guardSrc9 = fs.readFileSync(path.join(__dirname, "..", "bridge", "verify-guard.js"), "utf8");
  ok((guardSrc9.match(/passNoFindings\) \? "verify-incomplete" : "verify-handoff-missing"/g) || []).length >= 1 && (guardSrc9.match(/마지막 판정은 통과였고 열린 지적도 없지만/g) || []).length >= 2, "verify-guard — 카운트 실패 분기 포함 종류·문구 진실화");
}
console.log("[주입 구조화 3단계] 요청문 뼈대 — 코드 소유 단일 출처 검사기(경고 단계)");
{
  const shaped = "확인 검증(직전 blocker 반영 — 커밋 abc). 저장소 D:\\x.\n[인수조건] 해소+회귀 없음이면 성공.\n[직접 범위] bridge/a.js 변경분(새 비차단은 미반영 보고 대상).";
  ok(CL.askShapeCheck(shaped).ok === true, "실전형 요청문(회차 선언+인수조건+직접 범위+미반영)=통과");
  const bare = CL.askShapeCheck("그냥 전체적으로 잘 됐는지 봐줘");
  ok(bare.ok === false && bare.missing.length === 4, "무형식 요청문=네 절 전부 누락 검출");
  const enShaped = CL.askShapeCheck("Goal: confirm the fix.\nAcceptance: all four resolved.\nScope: bridge/a.js only.\nOut of scope: new non-blockers.");
  ok(enShaped.ok === true, "영문 제목(Goal/Acceptance/Scope/Out of scope)도 인정(혼용 세션 안전)");
  const partial = CL.askShapeCheck("목표: 검증.\n인수조건: 통과.");
  ok(partial.ok === false && partial.missing.map((m) => m.id).sort().join(",") === "exclusions,scope", "빠진 절만 정확히 특정");
  // 재검증 blocker① — '절 제목'이지 '단어 출현'이 아니다: 본문 속 단어 나열·교차 매칭 배제
  const wordList = CL.askShapeCheck("goal acceptance scope exclusions 전부 확인해줘");
  ok(wordList.ok === false && wordList.missing.length === 4, "절 제목 없는 단어 나열=네 절 전부 누락(단어 출현 오인 소멸)");
  const crossScope = CL.askShapeCheck("Goal: confirm.\nAcceptance: resolved.\nOut of scope: new non-blockers.");
  ok(crossScope.ok === false && crossScope.missing.map((m) => m.id).join(",") === "scope", "'Out of scope' 제목이 scope 절을 겸하지 못함(교차 매칭 배제)");
  ok(CL.askShapeCheck("본문 중간에 인수조건이라는 말과 직접 범위라는 말만 스치는 문장").missing.some((m) => m.id === "acceptance"), "줄 머리 앵커 — 본문 속 스치는 언급은 제목이 아님");
  const noticeKo = CL.askShapeNotice(bare.missing, "ko"), noticeEn = CL.askShapeNotice(bare.missing, "en");
  // 재검증 blocker② — 안내문 속 '전체 절 열거'까지 표에서 생성(표 밖 명칭 재하드코딩 금지)
  ok(noticeKo.includes(CL.ASK_SHAPE_SECTIONS.map((x) => x.ko).join("/")) && noticeEn.includes(CL.ASK_SHAPE_SECTIONS.map((x) => x.en).join(" / ")), "전체 절 열거=표 조인 그대로(단일 출처 완전화)");
  ok(CL.ASK_SHAPE_SECTIONS.every((x) => noticeKo.includes(x.ko)) && CL.ASK_SHAPE_SECTIONS.every((x) => noticeEn.includes(x.en)), "누락 목록도 같은 표에서 생성");
  ok(noticeKo.includes("경고 단계") && noticeKo.includes("그대로 시작") && noticeEn.includes("warn-only"), "경고 단계 명시(거부 아님)");
  // 통합: 실제 ask-start가 경고를 stderr로 내고(기계 stdout 오염 없이) 관측 기록을 남긴다 — 손상 links로 뒤 단계 조기 중단
  const homeS = fs.mkdtempSync(path.join(os.tmpdir(), "askshape_"));
  fs.writeFileSync(path.join(homeS, "links.json"), "{broken!!", "utf8");
  const bridgeBin = path.join(__dirname, "..", "bridge", "codex-bridge.js");
  const runStart = (p) => cp.spawnSync(process.execPath, [bridgeBin, "ask-start", "--allow-new", p], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: homeS, CLAUDE_PROJECT_DIR: ws }, timeout: 15000, windowsHide: true });
  const rBare = runStart("전체적으로 봐줘");
  ok(rBare.status !== 0 && rBare.stderr.includes("요청문 뼈대 안내"), "무형식 시작=경고 출력(작업 자체는 뒤 단계 사유로 중단된 것 — 경고는 차단 아님)");
  const shapeLog = path.join(homeS, "stats", "ask-shape.jsonl");
  ok(fs.existsSync(shapeLog) && JSON.parse(fs.readFileSync(shapeLog, "utf8").trim().split(/\n/)[0]).missing.length === 4, "관측 기록(ask-shape.jsonl)=거부 승격 판단 재료");
  const rShaped = runStart(shaped);
  ok(!rShaped.stderr.includes("요청문 뼈대 안내"), "정형 요청문=경고 없음");
  try { fs.rmSync(homeS, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log("[주입 구조화 4단계] 코드 소유 주입분 길이 예산 — 사용자 편집분(transmit)은 계산 제외");
{
  const CAPS = { ko: 1000, en: 1800 }; // 실측(2026-08-05) 최장 ko 936(always)/en 1727 수준 — 넘기려면 같은 분량 제거·사건 자리 이동·검사 승격 중 하나(플랜 4단계)
  for (const lang of ["ko", "en"]) {
    for (const mode of ["always", "code", "plancode"]) { // 재검증 [보완] — 최장 분기(plancode)까지 전 모드 고정
      const lens = [];
      for (const prof of ["core", "integrity"]) {
        const d = CL.buildVerifyDirective(mode, lang, prof, { tracked: true, count: 2, budget: 5 });
        const b = CL.loadBaseDirective(lang, prof);
        ok(d.includes(b.transmit), `${lang}/${mode}/${prof} — transmit 포함(제외 계산의 전제)`);
        lens.push(d.length - b.transmit.length);
        ok(d.length - b.transmit.length <= CAPS[lang], `${lang}/${mode}/${prof} — 코드 소유분 ${d.length - b.transmit.length}자 ≤ 예산 ${CAPS[lang]}`);
      }
      ok(lens[0] === lens[1], `${lang}/${mode} — 코드 소유분은 프로필 불변(사용자 편집분만 프로필 차이)`);
    }
  }
}

console.log("[PASS-사례 e2e] 실제 codex-hook Stop 경로 — 통과-잔여 상한이 verify-incomplete 이벤트로 기록된다");
{
  // 확인 검증 blocker(f-32e8b1ec) 해소: 소스 문자열 검사가 아니라 codex-hook.js를 실프로세스로 Stop 반복 실행해
  // ①실제 C-C 캠페인 job 선택 ②기록 이벤트=verify-incomplete ③verify-handoff-missing 미기록 ④한·영 문구·결속 보존을 입증한다.
  const wsCc = path.join(home, "ws-cc"); fs.mkdirSync(wsCc, { recursive: true });
  const sidCc = "dddddddd-1111-2222-3333-555555555555", turnCc = "turn-cc-1";
  const ccCamp = "cc:" + sidCc + ":" + turnCc;
  fs.writeFileSync(CL.contractFileFor(wsCc, "ko"), JSON.stringify({ workspace: wsCc, harnessMode: "codex-codex", verifyMode: "always" }));
  fs.writeFileSync(path.join(home, "links.json"), JSON.stringify({ byWorkspace: { [CL.normWs(wsCc)]: { workspace: wsCc, implementerSession: sidCc, implementerRevision: 3, implementerEventAt: Date.now() - 50 } }, roleRevision: 3 }));
  const turnsDirCc = path.join(home, "codex-turns"); fs.mkdirSync(turnsDirCc, { recursive: true });
  fs.writeFileSync(path.join(turnsDirCc, sidCc + ".json"), JSON.stringify({ schema: "codex-turn-v1", turnId: turnCc, workspace: wsCc, startedAt: Date.now() - 1000, lastActionAt: 0, modified: true, permissionMode: "default" }));
  fs.mkdirSync(CL.CAMPAIGN_DIR, { recursive: true });
  fs.writeFileSync(CL.campaignFileFor(wsCc), JSON.stringify({ schema: "vcamp-1", campaignId: ccCamp, count: 5, budget: 5, startedAt: turnTs, updatedAt: turnTs }));
  // 마지막 회차=깨끗한 통과 job(지적 0) — 실제 캠페인 결속으로 passNoFindings 문맥이 만들어져야 한다
  writeEvidenceJob("ask-ccpass-0000000001", ccCamp, 5, "본문 근거...\n[지적 목록 v2]\n[지적 목록 끝]\n검증: 통과\n", "ask-ccpass-0000000001", wsCc);
  // rollout 격리: 실사용자 홈의 Codex 세션을 걷지 않도록 빈 codex-home 지정(마감문 없음=capCloseout 실패 경로 고정)
  const codexHomeCc = path.join(home, "codex-home-empty"); fs.mkdirSync(path.join(codexHomeCc, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, "codex-home.txt"), codexHomeCc);
  const hookBin = path.join(__dirname, "..", "bridge", "codex-hook.js");
  const runHook = () => cp.spawnSync(process.execPath, [hookBin], { input: JSON.stringify({ hook_event_name: "Stop", session_id: sidCc, turn_id: turnCc, cwd: wsCc, permission_mode: "default" }), encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home }, timeout: 20000, windowsHide: true });
  const h1 = runHook();
  let h1o = null; try { h1o = JSON.parse(h1.stdout.trim()); } catch { h1o = null; }
  ok(!!h1o && h1o.decision === "block", "상한 도달 1회차=차단(마감 지시) " + (h1o ? "" : "stdout=" + h1.stdout + " stderr=" + h1.stderr));
  const rCc = h1o ? String(h1o.reason || "") : "";
  ok(rCc.includes("(마지막 판정: 통과)") && rCc.includes("PASS-NO-FINDINGS") && rCc.includes("ask-ccpass-0000000001"), "실경로 인계문=실제 캠페인 job 결속+통과 라벨+PASS-NO-FINDINGS");
  runHook(); runHook();
  const h4 = runHook();
  ok(!/"decision":"block"/.test(String(h4.stdout || "")), "반복 초과(4회차)=차단 대신 경보 기록으로 전환");
  const integEvs = (JSON.parse(fs.readFileSync(CL.INTEGRITY_FILE, "utf8")).events || []).filter((e) => e && e.session === sidCc);
  const incEvs = integEvs.filter((e) => e.kind === "verify-incomplete");
  ok(incEvs.length >= 1, "기록된 이벤트 종류=verify-incomplete(통과-잔여 진실 경보)");
  ok(integEvs.every((e) => e.kind !== "verify-handoff-missing"), "verify-handoff-missing(인계 누락 거짓 경보)은 기록되지 않음");
  const eCc = incEvs[incEvs.length - 1] || {};
  ok(CL.normWs(String(eCc.workspace || "")) === CL.normWs(wsCc) && eCc.session === sidCc, "이벤트가 작업장·세션에 결속");
  ok(String(eCc.detailKo || "").includes("마지막 판정은 통과였고 열린 지적도 없지만") && String(eCc.detailEn || "").includes("no open findings"), "한·영 진실 문구가 실제 이벤트에 보존");
}
try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
