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
console.log("implementer-auto-pin tests: ok");
