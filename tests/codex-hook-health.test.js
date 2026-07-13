const assert = require("assert");
const { assessCodexHookHeartbeat, assessCodexHookTrust, CodexHookTrustCache } = require("../out/codex-hook-health.js");

assert.deepStrictEqual(assessCodexHookTrust(null),{ready:false,reason:"hooks-unverified"},"최초 hooks/list 조회 전도 준비 완료로 승인하지 않음");
assert.deepStrictEqual(assessCodexHookTrust({queried:false,ready:false,error:"timeout"}),{ready:false,reason:"hooks-unverified"},"hooks/list 실패도 fail-closed");
assert.deepStrictEqual(assessCodexHookTrust({queried:true,ready:false}),{ready:false,reason:"hooks-untrusted"},"조회된 미신뢰 훅 차단");
assert.deepStrictEqual(assessCodexHookTrust({queried:true,ready:true}),{ready:true,reason:"trusted"},"조회된 전체 신뢰만 통과");
const cache=new CodexHookTrustCache(),qa=Promise.resolve({id:"a"}),qb=Promise.resolve({id:"b"});cache.markStarted("a",100);cache.setSnapshot("a",{id:"a"});cache.setQuery("a",qa);cache.markStarted("b",200);cache.setSnapshot("b",{id:"b"});cache.setQuery("b",qb);assert.deepStrictEqual(cache.getSnapshot("a"),{id:"a"});assert.deepStrictEqual(cache.getSnapshot("b"),{id:"b"},"다른 CWD snapshot을 재사용하지 않음");assert.strictEqual(cache.getQuery("a"),qa);assert.strictEqual(cache.getQuery("b"),qb,"다른 CWD in-flight 요청도 격리");assert.deepStrictEqual(cache.getFresh("a",120,30),{id:"a"});assert.strictEqual(cache.getFresh("a",131,30),undefined,"CWD별 TTL 적용");

assert.deepStrictEqual(
  assessCodexHookHeartbeat(undefined, "turn-1"),
  { ready: false, reason: "heartbeat-missing", heartbeatTurnId: "" },
  "활성 파일이 없으면 구현 훅을 정상으로 간주하지 않는다",
);
assert.strictEqual(
  assessCodexHookHeartbeat({ source: "runtime-sync", turnId: "turn-1" }, "turn-1").reason,
  "heartbeat-missing",
  "대시보드 동기화 기록을 실제 훅 생존 신호로 오인하지 않는다",
);
assert.deepStrictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "UserPromptSubmit", turnId: "turn-2" },
    "turn-2",
  ),
  { ready: true, reason: "healthy", heartbeatTurnId: "turn-2" },
  "현재 턴과 일치하는 UserPromptSubmit 신호만 정상이다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "PostToolUse", turnId: "turn-2" },
    "turn-2",
  ).ready,
  true,
  "현재 턴의 실제 PostToolUse도 구현 훅 생존을 증명한다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "Stop", turnId: "turn-2" },
    "turn-2",
  ).ready,
  true,
  "현재 턴의 Stop은 검증 게이트 실행을 직접 증명한다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "SessionStart", turnId: "", ts: "2026-07-13T05:10:00.000Z" },
    "previous-turn",
    "2026-07-13T05:00:00.000Z",
  ).ready,
  true,
  "최신 기존 턴 뒤의 SessionStart는 프롬프트 전 대화 진입 생존 신호다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "SessionStart", turnId: "", ts: "2026-07-13T05:00:00.000Z" },
    "new-turn",
    "2026-07-13T05:10:00.000Z",
  ).reason,
  "heartbeat-stale",
  "SessionStart 뒤 새 턴이 시작되면 그 턴의 실제 훅 신호를 다시 요구한다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "SessionStart", turnId: "", ts: "2026-07-13T05:10:00.000Z" },
    "new-turn-within-tolerance",
    "2026-07-13T05:10:00.500Z",
  ).reason,
  "heartbeat-stale",
  "SessionStart 직후 1초 안에 시작된 새 턴도 실제 턴 훅 없이는 정상 승인하지 않는다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "UserPromptSubmit", turnId: "turn-1" },
    "turn-2",
  ).reason,
  "heartbeat-stale",
  "이전 턴의 훅 신호는 현재 세션 생존 증거가 아니다",
);
assert.strictEqual(
  assessCodexHookHeartbeat(
    { source: "codex-hook", hookEvent: "UserPromptSubmit", turnId: "legacy-turn" },
    "",
  ).reason,
  "turn-unverifiable",
  "최신 rollout turn id를 읽지 못하면 과거 heartbeat를 정상으로 승인하지 않는다",
);

console.log("codex hook health tests passed");
