"use strict";
/*
 * P-12 2a — 검증 백로그 장부(설계 동결 ⓚ 2a).
 * 계약: append-only jsonl·<파일>.lock 전 명령 직렬화(실패=기록 거부)·fold=append 줄 순서(ts=표시용)·
 * 전이표(add=open·재등록=lastSeen/seenCount/tag 단조 승격/최신 좌표·재발견=reopen·status 줄)·
 * 손상 줄=건너뛰되 개수 가시화+clear 재작성 시 원문 보존·민감 최소화(제목 200자·경로 상대화/외부 basename).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p12bl_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const WS = "D:/bl-proj";

console.log("[1] 정규화·id([백로그] 확정: NFC→공백 압축→trim→200자 절단→소문자 해시)");
ok(CL.normBacklogTitle("  여러   공백\t지적  ") === "여러 공백 지적", "제목 정규화 — 공백 압축·trim");
ok(CL.normBacklogTitle("가".repeat(300)).length === 200, "제목 200자 절단(민감 최소화)");
ok(CL.backlogId("  테스트  지적 ", "SRC/A.TS") === CL.backlogId("테스트 지적", "src/a.ts"), "id — 정규화 후 동일(공백·대소문자 무시)");
ok(CL.backlogId("가".repeat(300), "") === CL.backlogId("가".repeat(200), ""), "id — 절단 '후' 해시(저장값과 일치)");
ok(CL.normBacklogFile("D:\\bl-proj\\src\\x.ts", WS) === "src/x.ts", "ws 내부 절대경로 — 강제 상대화(구분자 / 통일)");
ok(CL.normBacklogFile("C:/Users/someone/secret.txt", WS) === "secret.txt (외부)", "외부 절대경로 — basename만+(외부) 표시(로컬 식별정보 차단)");
ok(CL.normBacklogFile("src/y.ts", WS) === "src/y.ts", "내부 상대경로는 그대로");
ok(CL.normBacklogFile("../Users/someone/secret.txt", WS) === "secret.txt (외부)", "../ 상대경로의 외부 탈출 — basename 축소(구현검증 2차 blocker: 우회 봉합)");
ok(CL.normBacklogFile("..notes/a.ts", WS) === "..notes/a.ts" && CL.normBacklogFile("..hidden/b.ts", WS) === "..hidden/b.ts", "..으로 시작하는 내부 정상 디렉터리 — 외부 오판 없음(세그먼트 단위 경계 · 3차 blocker: 서로 다른 지적의 id 병합 방지)");

console.log("[2] 전이표 실동작 — add·재등록(승격·좌표 최신화)·reopen·status");
let r = CL.backlogAdd(WS, { tag: "백로그", title: "지적 A", file: "src/a.ts", lang: "ko", mode: "claude-codex", profile: "core", source: "ask-1" });
ok(r.ok && !r.existed && /^[a-f0-9]{16}$/.test(r.id), "신규 add — id 영수증(16hex)");
const idA = r.id;
r = CL.backlogAdd(WS, { tag: "주의", title: "지적 A", file: "src/a.ts", lang: "en", mode: "codex-codex", profile: "integrity", source: "ask-2" });
ok(r.ok && r.existed && r.id === idA, "같은 제목·파일 재등록 — 기존 항목 갱신(seen)");
let b = CL.readBacklog(WS);
let itA = b.items.find((x) => x.id === idA);
ok(itA.tag === "주의" && itA.seenCount === 2, "tag 단조 승격(백로그→주의) + seenCount");
ok(itA.lang === "en" && itA.mode === "codex-codex" && itA.profile === "integrity" && itA.source === "ask-2", "재등록 시 lang·mode·profile·source 최신화(4차 [주의] 반영)");
r = CL.backlogAdd(WS, { tag: "백로그", title: "지적 A", file: "src/a.ts" });
itA = CL.readBacklog(WS).items.find((x) => x.id === idA);
ok(itA.tag === "주의", "주의→백로그 하향 없음(승격 소실 차단)");
ok(CL.backlogSetStatus(WS, idA, "done").ok && CL.readBacklog(WS).items.find((x) => x.id === idA).status === "done", "status 줄 — done 전이");
CL.backlogAdd(WS, { tag: "백로그", title: "지적 A", file: "src/a.ts" });
ok(CL.readBacklog(WS).items.find((x) => x.id === idA).status === "open", "done 후 재발견 — 자동 reopen(재발견=미해결)");
ok(CL.backlogSetStatus(WS, "없는아이디0000000", "done").ok === false, "없는 id status — 거부(not-found)");
ok(CL.backlogAdd(WS, { tag: "주의", title: "   " }).ok === false, "빈 제목 — 기록 거부");

console.log("[3] 손상 줄 fail-visible + clear 원문 보존 + fold=append 순서");
const file = CL.backlogFileFor(WS);
fs.appendFileSync(file, "{깨진 줄\n", "utf8");
fs.appendFileSync(file, JSON.stringify({ schema: "vbl-1", ev: "seen", id: "노애드시드0000000", tag: "백로그", ts: "2026-01-01" }) + "\n", "utf8");
b = CL.readBacklog(WS);
ok(b.corrupt === 2, "손상 2줄(파싱 불가 1+add 없는 seen 1) 계수 — 침묵 유실 금지");
CL.backlogAdd(WS, { tag: "백로그", title: "지적 B" });
const idB = CL.backlogId("지적 B", "");
CL.backlogSetStatus(WS, idB, "dismissed");
const cr = CL.backlogClearDone(WS);
ok(cr.ok && cr.removed >= 1 && cr.corrupt === 2, "clear — 닫힌 항목 정리+손상 계수 보고");
const after = fs.readFileSync(file, "utf8");
ok(after.includes("{깨진 줄"), "clear 재작성이 손상 줄 원문을 그대로 보존(조용한 제거 금지)");
ok(!after.includes("지적 B") && after.includes("지적 A"), "닫힌 항목 줄만 제거·open 항목 줄 보존");
// ts 역전이 있어도 append 순서가 권위 — 나중 줄(과거 ts)의 status가 이긴다
fs.appendFileSync(file, JSON.stringify({ schema: "vbl-1", ev: "status", id: idA, status: "done", ts: "2000-01-01" }) + "\n", "utf8");
ok(CL.readBacklog(WS).items.find((x) => x.id === idA).status === "done", "fold=append 줄 순서(ts는 표시용 — 시계 역전 무영향)");

console.log("[4] 잠금 직렬화 — 실패=기록 거부(fail-closed)");
fs.writeFileSync(file + ".lock", process.pid + "-hold", "utf8"); // 살아있는 이 프로세스가 보유한 잠금
ok(CL.backlogAdd(WS, { tag: "백로그", title: "잠금 중 등록" }).ok === false, "잠금 보유 중 add — 기록 거부");
ok(CL.backlogClearDone(WS).ok === false, "잠금 보유 중 clear — 거부");
fs.unlinkSync(file + ".lock");
ok(CL.backlogAdd(WS, { tag: "백로그", title: "잠금 해제 후 등록" }).ok === true, "해제 후 정상");

console.log("[5] 배선 — CLI·rejudge 규약·TTL 비대상");
const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
ok(/case "backlog":/.test(src) && /function cmdBacklog\(rest\)/.test(src), "CLI 등록(add/list/done/dismiss/clear)");
ok(/backlog add --tag/.test(CL.BASE_CORE.rejudge) && /출력된 id를 보고에 인용하라/.test(CL.BASE_CORE.rejudge) && /backlog add --tag/.test(CL.BASE_CORE_EN.rejudge), "core 재판단 규약 — 장부 기록+id 영수증 인용(ko/en · 기록 누락 가시화)");
ok(/비밀값·개인정보 원문 금지/.test(CL.BASE_CORE.rejudge) && /never secret\/PII originals/.test(CL.BASE_CORE_EN.rejudge), "제목 민감 최소화 규약(ko/en)");
const cl = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
ok(!/verify-backlog/.test(cl.split("function cleanupOldState")[1].split("function maybeCleanupState")[0] || ""), "TTL 스윕 비대상 — 사용자 할 일은 자동 삭제 안 함(수동 clear만)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
