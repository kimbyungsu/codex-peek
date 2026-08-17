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
ok(ext.includes('if (contract.scoutMode !== "on") return null;') && sweepAt >= 0 && collectAt > sweepAt,
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

console.log("[6] 실적 표시·유계 조사 목록(2026-08-17 사용자 결정 — 진단 검증 3왕복 귀결)");
{
  const os = require("os");
  const MI = require(path.join(ROOT, "bridge", "map-intent.js"));
  // 의미 지문 — 실행 세대 필드(patchId·basis·readSet·provider·rationale) 무관: 같은 내용 재제안=같은 지문
  const base = { patchId: "11111111-1111-1111-1111-111111111111", basis: { baseHead: "aaa" }, readSet: { targets: [{ id: "x" }] }, provider: "precision", rationale: "r1", operation: "add_anchor", targetId: "t-1", payload: { anchor: { file: "src/a.ts" } } };
  const regen = { ...base, patchId: "22222222-2222-2222-2222-222222222222", basis: { baseHead: "bbb" }, readSet: { targets: [] }, rationale: "r2" };
  ok(MI.semanticFpOf(base) === MI.semanticFpOf(regen), "재제안(세대 필드만 상이)=같은 의미 지문(확인 검증 보완 — opHashV2는 patchId 포함이라 불가)");
  ok(MI.semanticFpOf(base) !== MI.semanticFpOf({ ...base, payload: { anchor: { file: "src/b.ts" } } }), "payload 다르면 다른 지문(별개 제안 오은닉 금지 — 주의 반영)");
  // payload 힌트 — 범주 규칙: 경로류 > 이름류 > 서술류 > 첫 문자열 잎(op별 하드코딩 없음)
  ok(MI.payloadHintOf(base) === "src/a.ts", "힌트=경로류(ref/file/path) 우선");
  ok(MI.payloadHintOf({ payload: { x: { note: "긴 설명", label: "이름표" } } }) === "이름표", "경로 없으면 이름류(label/name/title)");
  ok(MI.payloadHintOf({ payload: { deep: { misc: "잎 문자열" } } }) === "잎 문자열", "계층 없으면 첫 문자열 잎");
  ok(MI.payloadHintOf({ payload: {} }) === "" && MI.payloadHintOf(null) === "", "빈 payload=빈 힌트(예외 없음)");
  // 결정 장부 실적 집계 — 픽스처 repo·캐시(파일 수 동일=재사용, 추가=재계산)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p9auto_"));
  const dd = path.join(tmp, "project-map", "decisions");
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, "1.json"), JSON.stringify({ classification: "auto" }));
  fs.writeFileSync(path.join(dd, "2.json"), JSON.stringify({ classification: "verifier-resolved" }));
  fs.writeFileSync(path.join(dd, "3.json"), JSON.stringify({ classification: "intent-choice" }));
  const s1 = MI.decisionAutomationSummary(tmp);
  ok(!!s1 && s1.total === 3 && s1.auto === 1 && s1.verifierResolved === 1 && s1.policy === 1, "결정 장부 classification 집계(sweep 아님 — 확인 검증 보완 반영)");
  fs.writeFileSync(path.join(dd, "4.json"), JSON.stringify({ classification: "auto" }));
  const s2 = MI.decisionAutomationSummary(tmp);
  ok(s2.total === 4 && s2.auto === 2, "파일 수 변화=재계산(불변 append 전용이라 수=세대 신호)");
  ok(MI.decisionAutomationSummary(path.join(tmp, "no-such")) !== null && MI.decisionAutomationSummary(path.join(tmp, "no-such")).total === 0, "결정 폴더 없음=0 집계(예외 없음)");
  // 배선 핀 — 브릿지: information에 지문·힌트, 대시보드에 automation
  const mi = fs.readFileSync(path.join(ROOT, "bridge", "map-intent.js"), "utf8");
  ok(/fp: semanticFpOf\(rec\.patch\), hint: payloadHintOf\(rec\.patch\)/.test(mi), "information 항목에 지문·힌트 결속");
  ok(/automation: decisionAutomationSummary\(repo\)/.test(mi), "대시보드 응답에 실적 집계 결속");
  // 배선 핀 — 웹뷰: 실적 줄 대체(정책은 생기면만 병기)·의미 지문 묶음·최근 5 외 접기
  ok(ext.includes("info.fp||info.patchId") && ext.includes("같은 제안 반복 ×"), "웹뷰 — 의미 지문 묶음+반복 횟수 표기");
  ok(ext.includes('keyedDetails("intentInfoMore"') && ext.includes("var VIS=5;"), "웹뷰 — 최근 5묶음 외 '더 보기' 접기(기록 무손실)");
  ok(ext.includes("자동 반영 ") && ext.includes("dv.policySummary.activeLeafCount>0"), "웹뷰 — 정책 카운터 대신 실적 줄(정책은 생기면만 병기)");
  ok(!ext.includes('ps.textContent=T("현재 재사용 정책 ')," 구 정책 단독 줄 잔재 0(automation 부재 폴백 분기만 허용)");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
