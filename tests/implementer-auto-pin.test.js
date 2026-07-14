"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { autoPinCandidateIsCurrent, autoPinWriteAllowed, chooseImplementerAutoPin, resolvePromptProject } = require("../out/implementer-auto-pin.js");

const c = (id, ts, extra = {}) => ({
  id, promptTs: ts, turnId: `turn-${id}`, model: "gpt-5.6-sol", effort: "xhigh",
  sessionSource: "vscode", threadSource: "user", ...extra,
});

assert.strictEqual(chooseImplementerAutoPin([
  c("old", "2026-07-12T23:00:00Z"), c("new", "2026-07-12T23:17:45Z"),
], []).id, "new", "가장 최근 실제 앱 프롬프트가 구현 역할을 받음");
assert.strictEqual(chooseImplementerAutoPin([
  c("human", "2026-07-12T23:00:00Z"), c("verifier", "2026-07-12T23:20:00Z", { sessionSource: "exec" }),
], []).id, "human", "exec 검증 세션은 최신이어도 자동고정 제외");
assert.strictEqual(chooseImplementerAutoPin([
  c("human", "2026-07-12T23:00:00Z"), c("verify-role", "2026-07-12T23:20:00Z"),
], ["verify-role"]).id, "human", "연결된 검증 역할은 앱 대화여도 구현자로 승격하지 않음");
assert.strictEqual(chooseImplementerAutoPin([
  c("subagent", "2026-07-12T23:20:00Z", { threadSource: "subagent" }),
], []), null, "하위 에이전트 대화는 자동고정 제외");

const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const contains = (root, child) => {
  const r = norm(root), c = norm(child);
  return c === r || c.startsWith(r + "/");
};
const projects = [
  { project: "D:/logical", roots: ["D:/logical", "D:/repo"] },
  { project: "D:/repo/nested", roots: ["D:/repo/nested"] },
];
assert.strictEqual(resolvePromptProject("D:/repo/src/deep", projects, norm, contains), "D:/logical", "scoutRepo 하위 작업 폴더도 같은 논리 프로젝트로 귀속");
assert.strictEqual(resolvePromptProject("D:/repo/nested", projects, norm, contains), "D:/repo/nested", "중첩 프로젝트는 정확 일치를 containment보다 우선");
assert.strictEqual(resolvePromptProject("D:/shared/src", [
  { project: "A", roots: ["D:/shared"] }, { project: "B", roots: ["D:/shared"] },
], norm, contains), null, "한 실제 루트를 여러 프로젝트가 공유하면 임의 귀속하지 않음");
assert.strictEqual(autoPinCandidateIsCurrent("2026-07-12T23:17:45Z", "2026-07-12T23:10:00Z", "2026-07-12T23:20:00Z"), true, "지연된 옛 훅 처리시각보다 실제 prompt 시간축을 우선");
assert.strictEqual(autoPinCandidateIsCurrent("2026-07-12T23:09:00Z", "2026-07-12T23:10:00Z", "2026-07-12T23:20:00Z"), false, "현재 구현 대화보다 오래된 prompt는 역할을 되돌리지 않음");
assert.strictEqual(autoPinWriteAllowed("A", "B", "2026-07-12T23:17:45Z", "2026-07-12T23:10:00Z", "2026-07-12T23:20:00Z"), false, "잠금 대기 중 구현 snapshot이 바뀌면 최신 역할을 덮지 않고 fail-closed");
assert.strictEqual(autoPinWriteAllowed("A", "A", "2026-07-12T23:17:45Z", "2026-07-12T23:10:00Z", "2026-07-12T23:20:00Z"), true, "snapshot 동일+더 최신 실제 prompt일 때만 쓰기 허용");

const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const block = ext.slice(ext.indexOf("function syncCodexImplementerAutoPin"), ext.indexOf("function firstImplementerMetaForProject"));
assert.ok(block.indexOf("rolloutSessionIdentity") < block.indexOf("rolloutAccFor(r.file)"), "session_meta 머리로 exec/subagent를 본문 파싱 전에 제외");
assert.match(block, /scan\.length >= 16/, "자동고정 scan 상한이 rolloutAcc 캐시 20보다 작아 반복 축출 thrash 방지");
assert.match(block, /autoPinWriteAllowed\(/, "잠금 안 역할 snapshot 변경과 prompt 시간축을 실행 검증된 단일 가드로 판정");
const rootsBlock = ext.slice(ext.indexOf("function knownCodexProjectRoots"), ext.indexOf("function pathContains"));
assert.doesNotMatch(rootsBlock, /harnessMode\s*!==/, "소유권 경계는 Claude-Codex 프로젝트도 제외하지 않음");
assert.match(rootsBlock, /\["ko", "en"\]/, "한·영 두 계약 슬롯의 scoutRepo를 모두 소유권 경계에 포함");

// ── P-6b: 같은 세션 재관측=세대 불변(훅 CAS 이중 기록원 경합 제거) ──────────────────────────
const { applyAutoPinUpdate } = require("../out/implementer-auto-pin.js");
{
  const cur = { workspace: "D:/ws", implementerSession: "sid-1", implementerRevision: 7, implementerEventAt: 1000, implementerLinkedAt: "2026-07-14T00:00:00.000Z", implementerLastSeenAt: "2026-07-14T00:00:00.000Z", implementerModel: "m", implementerEffort: "high" };
  const same = applyAutoPinUpdate(cur, { id: "sid-1", promptTs: "2026-07-14T00:05:00.000Z", model: "m2", effort: "low" });
  assert.strictEqual(same.generationAdvanced, false, "같은 세션 재관측=세대 비전진");
  assert.strictEqual(same.next.implementerRevision, 7, "revision 불변");
  assert.strictEqual(same.next.implementerEventAt, 1000, "eventAt 불변(turn-before-link 경합 제거의 핵심)");
  assert.strictEqual(same.next.implementerLastSeenAt, "2026-07-14T00:05:00.000Z", "관측 시각만 갱신");
  assert.strictEqual(same.next.implementerModel, "m", "같은 세션 재관측이 모델 기준선을 덮지 않음");
  const older = applyAutoPinUpdate(cur, { id: "sid-1", promptTs: "2026-07-13T23:00:00.000Z" });
  assert.strictEqual(older.next.implementerLastSeenAt, cur.implementerLastSeenAt, "더 오래된 관측=무변화");
  const swap = applyAutoPinUpdate(cur, { id: "sid-2", promptTs: "2026-07-14T00:06:00.000Z", model: "m3", effort: "xhigh" });
  assert.strictEqual(swap.generationAdvanced, true, "다른 세션 교체=세대 전진(ABA 검출 보존)");
  assert.strictEqual(swap.next.implementerRevision, 8);
  assert.strictEqual(swap.next.implementerEventAt, Date.parse("2026-07-14T00:06:00.000Z"));
  assert.strictEqual(swap.next.implementerLinkSource, "rollout-user-prompt");
}
// 배선·쌍둥이 필터 소스 계약
{
  const extSrc = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(extSrc.includes("applyAutoPinUpdate(cur, best)"), "확장 자동 고정이 순수 판정기를 사용");
  assert.ok(extSrc.includes("hook_prompt[\\s>]"), "isInjected가 Stop 차단 피드백(hook_prompt)을 프롬프트로 오인하지 않음");
  const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(bridgeSrc.includes("hook_prompt[\\s>]"), "bridge 쌍둥이 필터도 동형 유지");
}
// 스캐너 기능 검증: hook_prompt user message는 프롬프트 신호(promptByCwd)에 잡히지 않는다
{
  const { makeRolloutAcc } = require("../out/rollout-scan.js");
  const isInjected = (t) => /^<(environment_context|user_instructions|system|recommended_plugins>|hook_prompt[\s>])/i.test(String(t).trimStart());
  const normWs2 = (p2) => String(p2 || "").toLowerCase();
  const h = makeRolloutAcc(isInjected, normWs2);
  const acc = h.init();
  h.merge(acc, JSON.stringify({ type: "turn_context", payload: { cwd: "d:/ws", turn_id: "t1", model: "m" } }));
  h.merge(acc, JSON.stringify({ type: "response_item", timestamp: "2026-07-14T00:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<hook_prompt hook_run_id=\"stop:1\">검증하세요</hook_prompt>" }] } }));
  assert.strictEqual(acc.promptByCwd.size, 0, "차단 피드백은 사용자 프롬프트 신호가 아님");
  h.merge(acc, JSON.stringify({ type: "response_item", timestamp: "2026-07-14T00:02:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "진짜 질문" }] } }));
  assert.strictEqual(acc.promptByCwd.size, 1, "정상 프롬프트는 신호로 남음(필터 과잉 방지)");
  const sig = acc.promptByCwd.get("d:/ws");
  assert.strictEqual(sig.turnId, "t1", "프롬프트 신호의 turnId 정확");
  assert.strictEqual(sig.ts, "2026-07-14T00:02:00Z", "프롬프트 신호의 시각=정상 프롬프트의 것(차단 쪽지 시각 아님)");
  // roleRevision 조건부 증가 배선 잠금(4차 보완): 세대 비전진이면 전역 revision도 비전진
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8").includes("if (upd.generationAdvanced) o.roleRevision"), "확장이 generationAdvanced일 때만 roleRevision 증가");
}

console.log("implementer-auto-pin tests: ok");
