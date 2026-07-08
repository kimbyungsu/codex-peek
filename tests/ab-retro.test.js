/*
 * scope-ab-retro.js 불변식 고정 테스트(정적) — 실제 사고·검증 지적에서 나온 3가지.
 * 스크립트가 최상위에서 즉시 실행되는 러너라 require 불가 → 소스 텍스트로 불변식을 검사한다.
 *  ① 본 저장소(repo)를 변이시키는 git 호출 금지(checkout/clean/apply/reset/restore) — 실제로 본 저장소 HEAD가 detach된 사고(2026-07-07).
 *  ② S0 추출은 coChange.candidates(정본 형태) — 존재하지 않는 .items를 읽어 S0이 항상 0이던 버그.
 *  ③ worktree 복원(checkout·clean) 실패 시 채점을 계속하지 않는다(조용한 측정 오염 방지) + clean은 -fdx.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-ab-retro.js"), "utf8");

// ① repo에 대한 변이 명령 금지 — git(repo, ["checkout"...]) 류가 소스에 없어야 한다(worktree add/remove·log·diff는 메타/읽기라 허용)
assert.ok(!/git\(\s*repo\s*,\s*\[\s*["'](checkout|clean|apply|reset|restore)/.test(src), "본 저장소(repo)를 변이시키는 git 호출이 소스에 존재");
// slice() 꼼수로 -C가 잘려나가던 원사고 형태도 금지
assert.ok(!/\]\s*\.slice\(/.test(src), "git 인자 배열 slice() 사용 — -C 대상이 잘려나가는 원사고 패턴");

// ② S0 추출 형태 — candidates를 읽고, 낡은 .items 접근이 없어야 한다
assert.ok(src.includes("coChange.candidates"), "S0 추출이 coChange.candidates를 읽지 않음");
assert.ok(!src.includes("coChange.items"), "존재하지 않는 coChange.items 접근이 남아 있음");

// ③ 복원 실패 게이트 — checkout/clean 결과를 받아 !ok면 continue/skip, clean은 -fdx
assert.ok(/const\s+co\s*=\s*git\(\s*wt\s*,\s*\[\s*["']checkout["']/.test(src), "worktree checkout 결과를 변수로 받지 않음");
assert.ok(/!co\.ok\s*\|\|\s*!cl\.ok/.test(src), "checkout/clean 실패 게이트(!co.ok || !cl.ok)가 없음");
assert.ok(src.includes('"-fdx"'), "clean이 -fdx가 아님(ignored 잔재가 다음 커밋 채점에 섞일 수 있음)");

// ④ 장부 주입(2026-07-09) — 실측도 실사용처럼 기억을 보되, 시간 절단·비오염
assert.ok(/pkg\.ledger = evts\.length \? LE\.selectForPackage/.test(src) && /t < commitMs/.test(src), "본 레포 일지 주입+커밋 시각 이전 이벤트만(순환·미래 누출 방지)이 없음");
assert.ok(src.includes("attached 재적재는 안 함") && !/ledgerForPackage\(repo/.test(src), "실측의 실장부 비오염(attached 미적재) 보장이 없음");

console.log("ab-retro invariants OK (repo 변이 금지 · candidates 형태 · 복원 실패 게이트 · 장부 주입 시간절단)");
