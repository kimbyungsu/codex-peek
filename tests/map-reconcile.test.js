"use strict";
/*
 * stable MAP 제안층→확정층 테스트 — extractMapPatches(⑥ 파서) + scope-reconcile CLI(list/approve/reject).
 * node tests/map-reconcile.test.js. CODEX_BRIDGE_HOME 임시폴더 — 실사용 브릿지 홈 오염 없음.
 * Codex 반례 잠금: ⑥ 안 'MAP patch' 문구 보존 · 혼합 구획 종료 우선 · 번호 스냅샷(밀림 방어) · 실단언(|| true 금지).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr_"));
process.env.CODEX_BRIDGE_HOME = dir;

const { extractMapPatches } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const { saveMap, wsKeyFor } = require(path.join(__dirname, "..", "scripts", "scout-store.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] extractMapPatches — ⑥ 구획만, 다음 구획 중단, 자리표시·중복 제외, 상한");
const MAP = [
  "① 직접 영향 후보",
  "- src/a.ts (high)",
  "⑥ MAP patch 후보",
  "- proofs/ 쓰기 ↔ verify-guard 읽기 — 검증 증명 채널",
  "- `scouts/<wsKey>` 저장 ↔ 대시보드 게시판 읽기",
  "- proofs/ 쓰기 ↔ verify-guard 읽기 — 검증 증명 채널",
  "- (없음)",
  "② 간접",
  "- 여기는 ⑥ 아님 — 수집 금지",
].join("\n");
const patches = extractMapPatches(MAP);
ok(patches.length === 2, `⑥ 항목 2건 추출(중복·자리표시 제외 — 실제 ${patches.length})`);
ok(patches[0].includes("proofs/"), "제안 텍스트 원문 보존(백틱 제거)");
ok(!patches.some((t) => t.includes("수집 금지")), "다음 구획(②)에서 수집 중단");
ok(extractMapPatches("① 직접\n- x.ts (high)").length === 0, "⑥ 없는 지도 → 빈 배열");
const many = "⑥ MAP patch\n" + Array.from({ length: 15 }, (_, i) => `- 결합 ${i}: src/f${i}.ts ↔ docs/MAP.md 동기화`).join("\n");
ok(extractMapPatches(many).length === 10, "제안 상한 10(도배 방지)");

console.log("[1b] 반례 잠금(Codex 지적) — ⑥ 안 'MAP patch' 문구 보존 · 혼합 구획 종료 우선 · 자유서식 헤더");
const inner = extractMapPatches("⑥ MAP patch 후보\n- MAP patch naming ↔ docs/MAP.md — 이유");
ok(inner.length === 1 && inner[0].includes("MAP patch naming"), "⑥ 안의 'MAP patch' 포함 항목이 헤더로 오인되지 않고 보존");
const mixed = extractMapPatches("⑥ 후보 ⑦ 기타\n- lost ↔ item.ts 결합 제안");
ok(mixed.length === 0, "⑥+⑦ 혼합 헤더 줄 → 종료(다른 구획)가 이김");
const freeform = extractMapPatches("MAP patch 후보\n- src/free.ts ↔ docs/form.md 동기");
ok(freeform.length === 1 && freeform[0].includes("free"), "구획 표기 없는 'MAP patch' 헤더(비-불릿)로도 수집 시작");
ok(extractMapPatches("- MAP patch 언급일 뿐인 불릿\n- not ↔ collected.ts 후보줄").length === 0, "불릿 줄의 'MAP patch' 언급은 헤더 아님(수집 시작 안 함)");

console.log("[1c] 씨앗 위생 필터(2026-07-08 백필 실사고 잠금) — 무경로·초단문 부스러기는 장부 씨앗이 못 됨");
const dirty = extractMapPatches(["⑥ MAP patch 후보", "- yaml", "- blind spot**: 이 꾸러미엔 해당 파일 없음 — 실제 구현 완료 여부 미확인.", "- free ↔ form", "- **scoutMaps ↔ readScoutMaps**: src/extension.ts와 대시보드 결합", "- proofs/ 쓰기 ↔ verify-guard 읽기 — 검증 증명 채널"].join("\n"));
ok(dirty.length === 2, `경로 토큰 없는 줄('yaml'·설명문·free↔form) 전부 탈락, 경로 든 결합만 생존(실제 ${dirty.length})`);
ok(dirty.some((t) => t.includes("extension.ts")) && dirty.some((t) => t.includes("proofs/")), "생존분: 파일 경로 결합 + 디렉터리(끝 슬래시) 결합 — 둘 다 인정");
ok(!dirty.some((t) => t.includes("**")), "마크다운 굵게 표기(**)는 씨앗 텍스트에서 정리됨");

console.log("[2] reconcile CLI — list 선행 강제 → list → approve → 확정층 기록 → 재목록 제외");
const repo = path.join(dir, "repo");
fs.mkdirSync(repo, { recursive: true });
saveMap(repo, "self", MAP, { ts: new Date().toISOString(), mapPatches: extractMapPatches(MAP) });
const CLI = path.join(__dirname, "..", "scripts", "scope-reconcile.js");
const run = (...args) => spawnSync(process.execPath, [CLI, repo, ...args], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: dir } });
const noList = run("approve", "1");
ok(noList.status === 1 && /먼저 list/.test(noList.stderr), "list 실행 전 approve → 거부(번호 기준 없음)");
const l1 = run("list");
ok(l1.status === 0 && l1.stdout.includes("2건") && l1.stdout.includes("proofs/"), "list — 대기 제안 2건 표시(출처 포함)");
const ap = run("approve", "1");
ok(ap.status === 0 && ap.stdout.includes("승인"), "approve 1 — 성공");
const mapMd = fs.readFileSync(path.join(repo, "docs", "MAP.md"), "utf8");
ok(mapMd.includes("## 확정 결합(승인분)") && /- proofs\/ 쓰기.*<!-- 승인 \d{4}-\d{2}-\d{2} · 출처: self 지도/.test(mapMd), "확정층 docs/MAP.md 생성 + 1번(proofs) 항목·날짜·출처 기록");
const l2 = run("list");
ok(l2.stdout.includes("1건") && !l2.stdout.includes("proofs/"), "승인분은 목록에서 사라짐(scouts 1건만 남음)");

console.log("[3] reject — 기각분은 다시 안 보임 · 확정층에 기록되지 않음(실단언)");
const rj = run("reject", "1");
ok(rj.status === 0 && rj.stdout.includes("기각"), "reject 1 — 성공");
ok(run("list").stdout.includes("대기 중 제안 없음"), "기각 후 대기 0건");
const mapMd2 = fs.readFileSync(path.join(repo, "docs", "MAP.md"), "utf8");
ok(!mapMd2.includes("대시보드 게시판"), "기각된 항목(scouts)은 확정층에 없음");
const st = JSON.parse(fs.readFileSync(path.join(dir, "map-reconcile", wsKeyFor(repo) + ".json"), "utf8"));
ok(st.approved.length === 1 && st.rejected.length === 1, "상태 파일에 승인 1·기각 1 기록");

console.log("[4] 번호 밀림 방어 — list 스냅샷 기준 승인(사이에 새 제안이 끼어도 사용자가 본 번호 유지)");
saveMap(repo, "self", "⑥ MAP patch\n- z-알파벳상 뒤 결합 ↔ 대상A\n- 0순위로 정렬될 결합 ↔ 대상B", { ts: new Date().toISOString(), mapPatches: ["z-알파벳상 뒤 결합 ↔ 대상A"] });
run("list"); // 스냅샷: [z-...] 1건
saveMap(repo, "self", "⑥ MAP patch\n- 0순위로 정렬될 결합 ↔ 대상B", { ts: new Date().toISOString(), mapPatches: ["0순위로 정렬될 결합 ↔ 대상B"] }); // 정렬상 앞에 끼는 새 제안
const apDrift = run("approve", "1");
ok(apDrift.status === 0 && apDrift.stdout.includes("z-알파벳상"), "지도 갱신으로 새 제안이 앞에 끼어도 1번=마지막 목록의 1번(z-...)이 승인됨");
ok(!fs.readFileSync(path.join(repo, "docs", "MAP.md"), "utf8").includes("0순위"), "새 제안(0순위)은 승인되지 않음");
const bad = run("approve", "9");
ok(bad.status === 1 && /범위 밖/.test(bad.stderr), "스냅샷 범위 밖 번호 → 실패 + 재확인 안내");
const stale = run("approve", "1");
ok(stale.status === 1 && /이미 처리/.test(stale.stderr), "이미 승인된 번호 재승인 → 거부(중복 승격 방지)");

console.log("[5] 확정층에 이미 있는 문구는 제안 목록에 안 뜸");
saveMap(repo, "self", MAP, { ts: new Date().toISOString(), mapPatches: ["proofs/ 쓰기 ↔ verify-guard 읽기 — 검증 증명 채널"] });
const l5 = run("list");
ok(!l5.stdout.includes("proofs/"), "확정층 중복 제안 자동 제외");

console.log("[6] 인자 오류 — 숫자 아닌 인자가 섞이면 조용히 무시하지 않고 전체 중단(승격 명령의 안전)");
const badArg = run("approve", "1", "abc");
ok(badArg.status === 2 && /번호가 아닌 인자/.test(badArg.stderr), "approve 1 abc → 거부(부분 실행 없음)");

console.log("[7] 상태 저장 실패 주입 — 성공처럼 종료하지 않음(atomicWrite 반환값 확인)");
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "mr2_"));
fs.cpSync(path.join(dir, "scouts"), path.join(home2, "scouts"), { recursive: true }); // 지도(제안)는 그대로
fs.writeFileSync(path.join(home2, "map-reconcile"), "blocker"); // 상태 '폴더' 자리에 파일 → mkdir/쓰기 실패 유도
const failList = spawnSync(process.execPath, [CLI, repo, "list"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home2 } });
ok(failList.status === 1 && /스냅샷 저장 실패/.test(failList.stderr), "list의 스냅샷 저장 실패 → exit 1 + 사유(조용한 성공 금지)");
try { fs.rmSync(home2, { recursive: true, force: true }); } catch { /* 무해 */ }

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시폴더 정리 실패 무해 */ }
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
