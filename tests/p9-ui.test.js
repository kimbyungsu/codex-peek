"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.error("  ❌ " + name); }
}

console.log("[1] 상태 수집 — 3트랙에서만 sweep 뒤 최신 대시보드 판독");
ok(ext.includes("intent: any | null") && ext.includes("const MI9: any = require(path.join(BRIDGE_DIR, \"map-intent.js\"))"),
  "BridgeState와 설치본 map-intent 연결");
const sweepAt = ext.indexOf("sweep = MI9.sweepIntentAuto(repo9, recovery.mapId, { ws });");
const collectAt = ext.indexOf("dashboard = MI9.collectIntentDashboard(repo9, recovery.mapId);");
ok(ext.includes('if (loadContract(ws).scoutMode !== "on") return null; // 2트랙=파일·스윕·카드 0') && sweepAt >= 0 && collectAt > sweepAt,
  "2트랙 조기 종료·자동 sweep 후 최신 카드 수집 순서");

console.log("[2] 호스트 액션 — 단일-flight·재대조·정책 충돌/복구 배선");
ok(ext.includes('m?.type === "intentAct"') && ext.includes("private intentBusy = false") && ext.includes('type: "intentDone"'),
  "호스트와 웹뷰 양쪽 단일-flight 해제");
ok(ext.includes("finishIntentRequest(); return;") && ext.includes("const finishIntentRequest = () =>")
  && ext.includes("if (this.intentBusy)") && ext.includes("finishIntentRequest();"),
  "busy·2트랙·저장소 불일치 조기 종료도 intentDone 보장");
ok(ext.includes("MI9.recordPolicyConflictChoice") && ext.includes("MI9.resumePolicyConflictChoice") && ext.includes("MI9.sweepIntentAuto"),
  "정책 뜻 선기록→재개→후속 자동 확인");
ok(ext.includes('act === "conflict-retry"') && ext.includes('act === "delegation-retry"') && ext.includes("MI9.retryDelegation")
  && ext.includes("Retry parked choice") && ext.includes("Retry parked delegation"),
  "parked 선택·위임의 사용자 실행 가능한 명시 재시도 배선");
ok(ext.includes("MI9.prepareTopologyRecovery") && ext.includes("MI9.confirmTopologyRecovery") && ext.includes("MI9.recoverDeadPipelineLock"),
  "복구본 생성·명시 교체·사망 잠금 회수 연결");
ok(ext.includes("planId: String(m.planId") && ext.includes("nonce: String(m.nonce")
  && ext.includes("planId:prepared.planId,nonce:prepared.nonce"),
  "복구 확인 메시지가 내구 planId·nonce에 결속");
ok(ext.includes("달라지는 것:") && ext.includes("유지되는 것:") && ext.includes("Changes:") && ext.includes("Unchanged:"),
  "ko/en 모달에 변경점과 유지점 명시");

console.log("[3] 화면 계약 — 충돌만 선택·조사 정보·복구 2단");
ok(ext.includes('id="intentBox"') && ext.includes("MAP 대기 선택") && ext.includes("MAP choices & recovery"),
  "3트랙 대시보드 구역 ko/en");
ok(ext.includes("conflictCards") && ext.includes("information") && ext.includes("조사 필요(선택 버튼 없음)") && ext.includes("서로 반대인 정책"),
  "반대 정책은 선택 카드·조사 항목은 정보 행");
ok(ext.includes("복구본 만들기") && ext.includes("복구본으로 교체") && ext.includes("Create recovery copy") && ext.includes("Replace with recovery copy"),
  "복구 생성/교체 2단 버튼 ko/en");
ok(ext.includes("정책 충돌을 정리") && ext.includes("선택은 보존됐지만 자동 마무리가 멈췄어요")
  && ext.includes("Policy conflict resolved") && ext.includes("automatic completion stopped"),
  "결과 알림은 성공·부분 중단을 구분하는 사람 문장");

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
