"use strict";
/*
 * [HARNESS-STRUCTURE §B2 3차 · 2026-09-12] 배경 작업 완료 알림은 사람의 발화가 아니다 — UserPromptSubmit 훅이 알림 봉투(<task-notification>)로
 * 시작하는 프롬프트를 받으면 같은 세션의 직전 앵커(ts·스냅샷 지문)를 잇고 라이브 라운드를 리셋하지 않는다.
 * 실측 사고(2026-09-12): 긴 시험을 배경에서 돌린 턴에서 알림마다 앵커가 새로 찍혀 캠페인 회차 상한이 매번 0 으로 되돌아가고(같은 세션에 캠페인 6개·전부 1회차),
 * 선별 관문이 알림마다 다시 닫혔으며 화면 라운드가 '준비'에 고착됐다. 격리 CODEX_BRIDGE_HOME 실행 시험.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "na-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const INJECT = path.join(__dirname, "..", "bridge", "contract-inject.js");
const A = path.join(HOME, "projA"); fs.mkdirSync(A, { recursive: true });
const SID = "notify-sess-1";
const envBase = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME });
delete envBase.CLAUDE_PROJECT_DIR; delete envBase.CLAUDE_CODE_SESSION_ID;
const anchorFile = path.join(HOME, "active", SID + ".json");
const readAnchor = () => JSON.parse(fs.readFileSync(anchorFile, "utf8"));
const runInject = (prompt, extra) => cp.spawnSync(process.execPath, [INJECT], { input: JSON.stringify(Object.assign({ hook_event_name: "UserPromptSubmit", session_id: SID, cwd: A, prompt, permission_mode: "default" }, extra || {})), cwd: A, encoding: "utf8", timeout: 30000, env: envBase });
const NOTICE = "<task-notification>\n<task-id>bg123</task-id>\n<status>completed</status>\n<summary>Background command \"npm test\" completed (exit code 0)</summary>\n</task-notification>";
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

t("판별(순수): origin.kind 또는 본문 전체가 <task-notification> 봉투만인 프롬프트만 알림 — 봉투 앞뒤에 사람의 글이 있으면(중간 인용 포함) 발화", () => {
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE }), true);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: "  \n" + NOTICE }), true);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: "x", origin: { kind: "task-notification" } }), true);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: "알림이 이렇게 왔어: " + NOTICE }), false);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: "고쳐줘" }), false);
  assert.strictEqual(CL.isSystemNotificationHook(null), false);
});

t("세션 첫 훅이 알림이면(이을 앵커 없음) 보통 턴으로 앵커를 쓴다", () => {
  const r = runInject(NOTICE);
  assert.strictEqual(r.status, 0, r.stderr);
  const a = readAnchor();
  assert.ok(a.claudeSession === SID && typeof a.ts === "string", "anchor written");
});

let a1 = null;
t("사람의 발화 → 새 앵커(ts·스냅샷 지문 갱신) + 라이브 라운드 0", () => {
  const before = readAnchor();
  const r = runInject("첫 요청입니다");
  assert.strictEqual(r.status, 0, r.stderr);
  a1 = readAnchor();
  assert.ok(a1.ts !== before.ts || a1.constraintAnchor !== before.constraintAnchor, "new turn anchor");
  assert.ok(a1.constraintAnchor && a1.constraintSourceHash, "snapshot bound");
  assert.strictEqual(CL.claudeCampaignAnchor(SID).campaignId, "cl:" + SID + ":" + a1.ts);
});

t("알림 훅 → 같은 세션의 직전 앵커를 잇는다(ts·스냅샷 지문 동일 → 캠페인 키·선별 관문 결속 유지)", () => {
  CL.writePhase("codex-verifying", { round: 3, session: SID, workspace: A }); // 라운드가 진행 중인 화면 상태 재현
  const r = runInject(NOTICE);
  assert.strictEqual(r.status, 0, r.stderr);
  const a2 = readAnchor();
  assert.strictEqual(a2.ts, a1.ts, "ts carried");
  assert.strictEqual(a2.constraintAnchor, a1.constraintAnchor, "turn anchor carried");
  assert.strictEqual(a2.constraintSourceHash, a1.constraintSourceHash, "snapshot hash carried (no new snapshot)");
  assert.strictEqual(CL.claudeCampaignAnchor(SID).campaignId, "cl:" + SID + ":" + a1.ts, "campaign id unchanged");
  const ph = JSON.parse(fs.readFileSync(path.join(HOME, "phase.json"), "utf8"));
  assert.strictEqual(ph.round, 3, "live round not reset by a notification");
  assert.strictEqual(ph.phase, "codex-verifying", "phase not reset by a notification");
});

t("알림 뒤 다시 사람의 발화 → 새 앵커·라운드 0(알림이 턴 경계를 대신하지 않는다)", () => {
  const r = runInject("두 번째 요청");
  assert.strictEqual(r.status, 0, r.stderr);
  const a3 = readAnchor();
  assert.ok(a3.ts >= a1.ts && a3.constraintAnchor !== a1.constraintAnchor, "new turn after a real prompt");
  const ph = JSON.parse(fs.readFileSync(path.join(HOME, "phase.json"), "utf8"));
  assert.strictEqual(ph.round, 0);
  assert.strictEqual(ph.phase, "claude-working");
});

t("origin.kind 표식만 있는 입력(본문 봉투 없음)도 알림으로 잇는다", () => {
  const before = readAnchor();
  const r = runInject("Background command finished", { origin: { kind: "task-notification" } });
  assert.strictEqual(r.status, 0, r.stderr);
  const a4 = readAnchor();
  assert.strictEqual(a4.ts, before.ts);
  assert.strictEqual(a4.constraintAnchor, before.constraintAnchor);
});

t("[구현 검증 1판 blocker] 봉투 밖에 사람의 글이 있으면 발화 — 선두 태그만으로 알림 판정 금지", () => {
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: "<task-notification> 이 내용을 설명해줘" }), false);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE + "\n이거 뭐야?" }), false);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE + "\n\n" + NOTICE }), true, "봉투 두 개(연속 알림)는 알림");
  const before = readAnchor();
  const r = runInject("<task-notification> 이 내용을 설명해줘");
  assert.strictEqual(r.status, 0, r.stderr);
  const a = readAnchor();
  assert.notStrictEqual(a.constraintAnchor, before.constraintAnchor, "사람 발화 → 새 앵커");
});

t("transcript 에 같은 원문의 human 레코드가 있으면(사용자가 알림 원문을 통째로 붙여넣음) 발화 — verify-guard 와 같은 구조 표식이 권위", () => {
  const tx = path.join(HOME, "tx-human.jsonl");
  const rec = (origin, text) => JSON.stringify({ type: "user", sessionId: SID, timestamp: new Date().toISOString(), ...(origin ? { origin: { kind: origin } } : {}), message: { role: "user", content: [{ type: "text", text }] } });
  fs.writeFileSync(tx, [rec("human", "앞선 질문"), JSON.stringify({ type: "assistant", message: { content: [] } }), rec("human", NOTICE)].join("\n") + "\n");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE, transcript_path: tx }), false);
  const before = readAnchor();
  const r = runInject(NOTICE, { transcript_path: tx });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(readAnchor().constraintAnchor, before.constraintAnchor, "human 레코드가 있는 봉투 원문=발화 → 새 앵커");
  // 같은 원문이 task-notification 레코드면 알림 · 기록에 없으면(마지막 텍스트 user 가 다른 원문) 봉투 규칙으로 알림
  fs.writeFileSync(tx, [rec("human", "앞선 질문"), rec("task-notification", NOTICE)].join("\n") + "\n");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE, transcript_path: tx }), true);
  fs.writeFileSync(tx, [rec("human", "앞선 질문")].join("\n") + "\n");
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE, transcript_path: tx }), true);
  assert.strictEqual(CL.isSystemNotificationHook({ prompt: NOTICE, transcript_path: path.join(HOME, "missing.jsonl") }), true, "transcript 없음=봉투 규칙");
  // 꼬리 판독: 큰 파일에서도 마지막 텍스트 user 레코드만 본다(전체 판독 없음)
  const big = path.join(HOME, "tx-big.jsonl");
  const filler = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(4000) }] } });
  fs.writeFileSync(big, Array.from({ length: 800 }, () => filler).join("\n") + "\n" + rec("human", NOTICE) + "\n");
  const got = CL.lastTextUserRecordOf(big, 64 * 1024);
  assert.ok(got && got.text === NOTICE && got.origin && got.origin.kind === "human", "tail read finds the last text user record");
});

console.log(`notify-anchor: ${n} passed`);
