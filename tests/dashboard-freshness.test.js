"use strict";
/*
 * 대시보드 신선도·복원 견고화(2026-07-10 양측 독립 감사 교차 대조 — 사용자 반복 보고 '리로드 직후 낡은 대시보드'):
 * 복원 입양 경로 폐기(닫고 새 생성)·ready 핸드셰이크·postedAt 스탬프·45초 끊김 배지·검증 카드 귀속 보정·
 * 탐색자 카드 시각·서랍 전환 고지. 웹뷰/vscode 의존이라 소스 계약+순수 집계 행동 테스트로 잠근다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");

console.log("[1] 복원 경로 단일화 — 입양(pendingRevive) 폐기·복원 탭은 닫고 검증된 새 생성 경로로(양 감사 합의)");
ok(!/pendingRevive/.test(ext), "입양 경로 잔재 0(pendingRevive 제거)");
ok(/deserializeWebviewPanel: async \(panel\) => \{[\s\S]{0,600}?panel\.dispose\(\)[\s\S]{0,300}?dashboard\.show\(col\)/.test(ext), "복원=dispose→같은 자리(viewColumn)에 새 생성");
ok(/registerWebviewPanelSerializer\("codexBridgeReconGuide"/.test(ext) && /registerWebviewPanelSerializer\("codexBridgeScoutHealth"/.test(ext), "정적 새탭 2종 복원 처리 — 가이드=재베이크·건강 리포트=닫기만(원 ws 저장 불가라 재베이크 금지, Codex 반례)");

console.log("[2] ready 핸드셰이크+신선도 스탬프+끊김 배지 — 침묵 실패 가시화");
ok(ext.includes('vscode.postMessage({type:"ready"})') && ext.includes('m?.type === "ready"'), "웹뷰 ready → 확장 즉시 post(초기 push 유실 방지)");
ok(/postedAt: number \}\)\.postedAt = Date\.now\(\)/.test(ext), "post()가 신선도 스탬프(postedAt)를 실음");
ok(ext.includes("마지막 갱신 ") && ext.includes("갱신 끊김(45초+)"), "웹뷰 '마지막 갱신' 상시 표시+45초 무갱신 배지");
ok(/dashboard push skipped — no panel/.test(ext), "패널 부재로 push를 버릴 때 관측 로그(optional chaining이 삼키던 관측 공백 보완)");
ok(ext.includes("데이터 불러오는 중…"), "초기 HTML이 실값처럼 보이지 않게 로딩 표지");

console.log("[3] 검증 카드 귀속 보정 — verdict 장부(ws 귀속)가 turn 기반 값보다 새로우면 채택(11시간 동결 실사고)");
ok(/function verdictActualFor/.test(ext) && /verdicts\.jsonl/.test(ext.slice(ext.indexOf("function verdictActualFor"), ext.indexOf("function verdictActualFor") + 1600)), "verdict 장부 판독기 존재");
ok(/귀속 보정.*두 감사 일치/.test(ext) && /verdictActualFor\(wsFilter/.test(ext), "sessionModelMeta 한 곳 보정 — brainActual·drift·현재값 세 소비처 공유");
ok(/fileCacheKey\(path\.join\(BRIDGE_DIR, "stats", "verdicts\.jsonl"\)\)/.test(ext), "캐시 키에 장부 상태 포함(보정 입력 변화 시 즉시 무효)");

console.log("[4] 탐색자 카드 시각 — 비용 장부 lastTs 기반(지도 10장 프루닝·top-5 사각과 무관)");
const VS = require(path.join(__dirname, "..", "out", "verify-stats.js"));
const now = Date.now();
const mk = (ts, arm, ws) => JSON.stringify({ ts: new Date(ts).toISOString(), workspace: ws || "D:/proj", arm, usageIn: 1, usageOut: 1 });
const raw = [mk(now - 3600e3, "deepseek"), mk(now - 7200e3, "self"), mk(now - 60e3, "ping", "")].join("\n");
const costs = VS.computeScoutCosts(raw, now, "D:/proj", (x) => String(x).toLowerCase());
ok(costs.byArm.deepseek && costs.byArm.deepseek.lastTs && Date.parse(costs.byArm.deepseek.lastTs) === now - 3600e3, "팔별 lastTs 집계(deepseek)");
ok(costs.byArm.self.lastTs && Date.parse(costs.byArm.self.lastTs) === now - 7200e3, "팔별 lastTs 집계(self)");
ok(ext.includes('id="scoutActualRo"') && /function scoutActualText/.test(ext) && /arm === "ping"\) continue/.test(ext), "탐색자 카드 슬롯+문구 조립(ping 제외)");

console.log("[5] 서랍 전환 고지 — '신뢰 0'이 삭제로 보이던 침묵 전환의 가시화");
ok(/prevDrawer: \{ entries: number; trusted: number; migrateCmd: string \} \| null/.test(ext) && /이전\(이 폴더\) 서랍에 /.test(ext) && /scope-ledger-migrate\.js "\$\{ws\}" "\$\{scoutTargetFor\(ws\)\.repo\}" --dry/.test(ext), "이전 서랍 요약+상시 안내 — 이관 명령이 실행 가능한 전체 인수(usage 오류 안내 반례 잠금 — Codex)");
ok(ext.includes("기존 일지는 이 폴더 서랍에 보존"), "대상 지정 토스트에도 보존 고지");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
