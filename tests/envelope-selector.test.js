"use strict";
/*
 * [Envelope Selector v7 §3·§6] 구현 3a — 선별 순수 계약(페이지·strict 출력·합집합 상한·예산 산식·영수증 서랍)
 * +무부작용 runner(팔 고정·비동기 spawn·취소) 실행·소스 시험. 배선(worker selecting·drift·주입)은 3b.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "envsel-"));
process.env.CODEX_BRIDGE_HOME = HOME;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CODEX_THREAD_ID;
const CL = require("../bridge/contract-lib.js");
const SR = require("../bridge/selector-runner.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };

t("페이지 분할: 항목 수 상수 경계·arc-N=파일 순서 위치 결정론·빈 서고=0페이지", () => {
  const items = Array.from({ length: CL.SELECTOR_PAGE_ITEMS + 1 }, (_, i) => "규칙 " + i);
  const pages = CL.buildSelectorPages(items);
  assert.strictEqual(pages.length, 2, "상수+1항=2페이지");
  assert.strictEqual(pages[0].length, CL.SELECTOR_PAGE_ITEMS);
  assert.strictEqual(pages[1][0].id, "arc-" + (CL.SELECTOR_PAGE_ITEMS + 1), "id=파일 순서 연속(세대 결속 위치 결정론)");
  assert.strictEqual(CL.buildSelectorPages([]).length, 0, "빈 서고=0페이지(선별 생략 축퇴 재료)");
});

t("페이지 프롬프트: 중립 재료만 서명에 존재(검증 요청문 인자 자체가 없음)·JSON 한 줄 지시·재료 유계 절단", () => {
  const p = CL.buildSelectorPagePrompt({ snapshotText: "약속 원문", changedFiles: ["a.js"], diffText: "d".repeat(30000), pageItems: [{ id: "arc-1", text: "규칙" }] });
  assert.ok(p.includes("약속 원문") && p.includes("a.js") && p.includes("arc-1: 규칙"), "세 중립 재료+항목 id 병기");
  assert.ok(p.includes('{"relevant":["arc-3"]}') && p.includes("코드 펜스(```)·다른 텍스트·설명·마크다운 금지"), "strict 출력 지시(범주 지시 — 4b-2 실측 후 펜스 금지 명시)");
  assert.ok(p.length < 26000, "diff 유계 절단(20000자)");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(src.includes("buildSelectorPagePrompt({ snapshotText, changedFiles, diffText, pageItems })"), "★입력 서명에 검증 요청문 인자 없음 — 구현자 작문은 계약상 전달 불가(§3 입력 중립)");
});

t("strict 출력 판독: 정상·빈 배열 ok / 산문 섞임·미지 필드·비배열·범위 밖 id·중복 id=실패(부분 수용 없음)", () => {
  const valid = ["arc-1", "arc-2", "arc-3"];
  assert.deepStrictEqual(CL.parseSelectorPageOutput('{"relevant":["arc-3","arc-1"]}', valid).ids, ["arc-3", "arc-1"]);
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":[]}', valid).ok, true, "관련 없음=정상");
  assert.strictEqual(CL.parseSelectorPageOutput('선별 결과는 {"relevant":["arc-1"]} 입니다', valid).reason, "bad-json", "산문 섞임=실패(전체가 JSON 하나)");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":["arc-1"],"why":"x"}', valid).reason, "unknown-field");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":"arc-1"}', valid).reason, "unknown-field", "비배열=실패");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":["arc-9"]}', valid).reason, "invalid-id", "범위 밖 id=실패");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":["arc-1","arc-1"]}', valid).reason, "dup-id");
  assert.strictEqual(CL.parseSelectorPageOutput('["arc-1"]', valid).reason, "bad-json", "배열 루트=키 스캐너가 구조 이상으로 거부");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":[],"relevant":["arc-1"]}', valid).reason, "dup-key", "★중복 relevant 키=거부(JSON.parse 후승 삼킴 우회 — 재검증 blocker)");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relev' + '\\' + 'u0061nt":[],"relevant":["arc-1"]}', valid).reason, "dup-key", "이스케이프 키 해독 후에도 중복=거부(JSON escape 실바이트 — 확인검증 보완: JS 선해석 반례 무력화 교정)");
  assert.strictEqual(CL.parseSelectorPageOutput('{"relevant":' + String.fromCharCode(10) + ' ["arc-1"]}', valid).reason, "multiline", "★다중행 JSON=거부('한 줄' 계약 — 재검증 blocker)");
  // [4b-2 실전 스모크 실측] 실제 모델의 펜스 포장(```json) — '펜스 하나로 감싼 정확히 한 줄'만 결정론 언랩
  const NL = String.fromCharCode(10);
  assert.deepStrictEqual(CL.parseSelectorPageOutput("```json" + NL + '{"relevant":["arc-1"]}' + NL + "```", valid).ids, ["arc-1"], "★펜스 한 줄=언랩 후 정상(실측 포장 정규화)");
  assert.strictEqual(CL.parseSelectorPageOutput("```" + NL + '{"relevant":' + NL + '["arc-1"]}' + NL + "```", valid).reason, "multiline", "펜스 안 다중행=여전히 거부(strict 무변)");
  assert.strictEqual(CL.parseSelectorPageOutput("선택 결과:" + NL + "```json" + NL + '{"relevant":["arc-1"]}' + NL + "```", valid).reason, "multiline", "산문+펜스=여전히 거부(부분 수용 없음)");
  assert.strictEqual(CL.parseSelectorPageOutput("```json" + NL + NL + '{"relevant":["arc-1"]}' + NL + "```", valid).reason, "multiline", "★펜스 안 선행 빈 줄=거부(\\s가 개행을 삼키던 확인검증 blocker② 반례)");
});

t("합집합 상한 관문: K 이내=선별 전문(파일 순서 정렬)·K+1=overflow-items·바이트 초과=overflow-bytes(절단·요약 금지)", () => {
  const items = Array.from({ length: 20 }, (_, i) => "규칙 " + i);
  const u1 = CL.selectorUnion([["arc-3"], ["arc-1", "arc-3"]], items);
  assert.ok(u1.ok && u1.selected.map((s) => s.id).join(",") === "arc-1,arc-3", "dedupe+파일 순서 정렬");
  const over = CL.selectorUnion([Array.from({ length: CL.SELECTOR_UNION_MAX + 1 }, (_, i) => "arc-" + (i + 1))], items);
  assert.strictEqual(over.reason, "overflow-items", "K+1=정직 중단 재료(조용한 절단 금지)");
  const fat = ["가".repeat(190), "나".repeat(190)]; // 2항 합계 UTF-8 1140B×2 — 기본 4000B 안이므로 상한 축소 검증은 항 수로
  const bigItems = Array.from({ length: 12 }, () => "가".repeat(150));
  const u2 = CL.selectorUnion([bigItems.map((_, i) => "arc-" + (i + 1))], bigItems);
  assert.strictEqual(u2.reason, "overflow-bytes", "바이트 상한(UTF-8) 초과=정직 중단");
  assert.ok(fat.length === 2, "정보");
});

t("예산 산식: ceil(pages/P)×페이지timeout+여유 — 서고 상한 96항 전제 유한", () => {
  const maxPages = Math.ceil(CL.ARCHIVE_ITEM_MAX / CL.SELECTOR_PAGE_ITEMS);
  const ms = CL.selectorDeadlineMsFor(maxPages);
  assert.strictEqual(ms, Math.ceil(maxPages / CL.SELECTOR_PARALLEL) * CL.SELECTOR_PAGE_TIMEOUT_MS + 60 * 1000);
  assert.ok(ms <= 17 * 60 * 1000, "최대 서고에서도 유한(96항=6페이지/P3=2배치×8분+1분)");
  assert.strictEqual(CL.selectorDeadlineMsFor(0), 60 * 1000, "0페이지=여유만(빈 서고 축퇴)");
});

t("선별 영수증 서랍: 무유실 계보(배타 생성·기록 경로에 삭제 없음)·read-back 재료·TTL 스윕 등재", () => {
  const nm = CL.appendSelectorUsage({ ts: "T1", wsKey: "k", askId: "ask-1", archiveHash: "a".repeat(40), selectedIds: ["arc-1"], pages: 1, arm: "self", durationMs: 10 });
  assert.ok(typeof nm === "string" && nm.endsWith(".json"), "기록=파일명 반환(read-back 관문 재료)");
  const rows = CL.readSelectorUsage();
  assert.ok(rows.some((r) => r._file === nm && r.askId === "ask-1"), "재판독으로 기록 실물 확인 가능");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  const fnBody = src.slice(src.indexOf("function appendSelectorUsage"), src.indexOf("function readSelectorUsage"));
  assert.ok(!/rmSync|renameSync|unlinkSync|withFileLockStrict|atomicWrite/.test(fnBody) && fnBody.includes('{ flag: "wx" }'), "★기록 경로에 삭제·재작성·잠금 부재+배타 생성(constraint-usage 무유실 계보 상속)");
  assert.ok(src.includes('sweep(path.join(STATS_DIR, "selector-usage"), PROOF_TTL_MS)'), "삭제=일일 스윕 90일 TTL만");
});

t("runner 팔 고정: 구현 턴 provider 자동 결정·설정 인자 없음·둘 다 없음=null(fail-closed 재료)", () => {
  assert.strictEqual(SR.selectorArmForTurn({}), null, "판독 불가=null");
  assert.strictEqual(SR.selectorArmForTurn({ CLAUDE_CODE_SESSION_ID: "s1" }), "self", "Claude 턴=self 팔");
  assert.strictEqual(SR.selectorArmForTurn({ CODEX_THREAD_ID: "t1" }), "codex", "Codex 턴=codex 팔");
  assert.strictEqual(SR.selectorArmForTurn({ CLAUDE_CODE_SESSION_ID: "s1", CODEX_THREAD_ID: "t1" }), "self", "동시 존재=구현 훅이 세팅하는 Claude 우선(결정론)");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "selector-runner.js"), "utf8");
  assert.ok(!src.includes("deepseek") && !src.includes("loadContract") && !src.includes("saveScoutCodexPrefs"), "★deepseek 팔·설정 판독 경로 자체가 없음 — 팔은 턴 env로만 결정(교차 불가 소스 계약·ab-7 경계)");
  assert.ok(!src.includes("scope-package") && !src.includes("project-map") && !src.includes("map-ledger"), "무부작용(scope 수집·MAP 기록 require 부재 — 1차 보완)");
  assert.ok(src.includes('"--strict-mcp-config"'), "self 팔=사용자 MCP 전면 무효(--strict-mcp-config·--mcp-config 미전달)");
  assert.ok(src.includes("CODEX_HOME: tmpHome") && src.includes('copyFileSync(path.join(realHome, "auth.json")') && src.includes("__tmpHome"), "★codex 팔=격리 홈(인증만 복사·config.toml 부재=MCP 0)+홈째 삭제 — 빈 표 병합(-c mcp_servers={})은 기존 서버가 남는 실측으로 폐기(재확인 blocker ab-7)");
  assert.ok(!src.includes("mcp_servers={}"), "무효했던 병합 오버라이드 잔존 금지");
});

async function asyncTests() {
  await (async () => {
    n++;
  const bad = SR.runSelectorPage({ arm: "nope", prompt: "x", timeoutMs: 5000 });
  const rb = await bad.promise;
  assert.strictEqual(rb.key, "bad-arm");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "selector-runner.js"), "utf8");
  assert.ok(!src.includes("spawnSync(target"), "★페이지 실행에 spawnSync 없음(비동기 — 실행 중 intent 관측 가능·3차 blocker④)");
  assert.ok(src.includes('taskkill', 0) && src.includes('"/T", "/F"'), "Windows 프로세스 트리 종료");
  // 실프로세스 취소: node 자식(장기 sleep 동형)을 self 팔 대신 직접 스폰하는 대신 — killTree 실측
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { windowsHide: true });
  const waited = new Promise((res) => child.on("close", (c, s) => res({ c, s })));
  SR.killTree(child.pid);
  const r = await Promise.race([waited, new Promise((res) => setTimeout(() => res(null), 10000))]);
  assert.ok(r !== null, "★killTree가 실프로세스를 실제 종료(60초 대기 자식이 10초 내 close)");

    console.log(`  ✅ [${n}] runner 실행 계약: 비동기 spawn+cancel(트리 종료)+timeout — bad-arm 즉시 실패·killTree 실프로세스 종료`);
  })();
}
asyncTests().then(() => { console.log(`결과: ${n}/${n} 통과`); }).catch((e) => { console.error(e); process.exit(1); });
