// 오래된 상태파일 정리(cleanupOldState/maybeCleanupState) 회귀 테스트.
// P2: proofs(90일)·verify-attempts(7일)를 TTL로 정리하되, 최근 파일·비-json은 안 건드리고, 하루 한 번만 실행.
// CODEX_BRIDGE_HOME을 require 전에 임시폴더로 → 실제 ~/.codex-bridge 오염 방지.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean_"));
process.env.CODEX_BRIDGE_HOME = dir;
const { cleanupOldState, maybeCleanupState, PROOFS_DIR, ATTEMPTS_DIR, ACTIVE_DIR } = require("../bridge/contract-lib.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };
const DAY = 86400000;
// 파일 생성 + 수정시각(mtime)을 ageDays 전으로 백데이트
const mk = (d, name, ageDays) => {
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, name);
  fs.writeFileSync(f, "{}", "utf8");
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(f, t, t);
  return f;
};
const exists = (f) => fs.existsSync(f);

console.log("[1] cleanupOldState — TTL 기준 삭제/보존");
const oldProof = mk(PROOFS_DIR, "old.json", 100);   // 100일 > 90일 → 삭제
const newProof = mk(PROOFS_DIR, "new.json", 1);      // 1일 → 보존
const oldAtt = mk(ATTEMPTS_DIR, "old.json", 10);     // 10일 > 7일 → 삭제
const newAtt = mk(ATTEMPTS_DIR, "new.json", 1);      // 1일 → 보존
const nonJson = mk(PROOFS_DIR, "keep.txt", 200);     // 비-json → 안 건드림
const oldActive = mk(ACTIVE_DIR, "sess-old.json", 40); // 40일 > 30일 → 삭제
const newActive = mk(ACTIVE_DIR, "sess-new.json", 1);  // 1일 → 보존
const removed = cleanupOldState(Date.now());
ck("오래된 proof(100일>90일) 삭제", !exists(oldProof));
ck("최근 proof(1일) 보존", exists(newProof));
ck("오래된 attempt(10일>7일) 삭제", !exists(oldAtt));
ck("최근 attempt(1일) 보존", exists(newAtt));
ck("오래된 active(40일>30일) 삭제", !exists(oldActive));
ck("최근 active(1일) 보존", exists(newActive));
ck("비-json 파일은 안 건드림", exists(nonJson));
ck("삭제 카운트 3", removed === 3);

console.log("[2] maybeCleanupState — 하루 한 번 가드");
const oldA = mk(PROOFS_DIR, "old2.json", 100);
maybeCleanupState(); // 마커 없음(처음) → 실행
ck("첫 호출: 오래된 파일 삭제 + 마커 생성", !exists(oldA) && exists(path.join(dir, ".last-cleanup")));
const oldB = mk(PROOFS_DIR, "old3.json", 100);
const r2 = maybeCleanupState(); // 마커 방금 생성됨(24h 안 지남) → skip
ck("둘째 호출: 24h 가드로 skip(삭제 안 함, 반환 0)", exists(oldB) && r2 === 0);

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
