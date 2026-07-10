"use strict";
/*
 * L1(2026-07-10 설계검증 반영) 전용 잠금 — A claim-provenance / B sig 별칭 / C 제어 안전성 중
 * 다른 테스트가 안 덮는 지점: 신선도 v2 세부(headLost·내용 지문·비-git 스캔·unknown)·성분별 버킷 재지시·
 * reconcile alias CLI 끝-끝·결합 확인 요청 동봉(ledgerCouplingCandidates).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const home = fs.mkdtempSync(path.join(os.tmpdir(), "l1_"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const store = require(path.join(__dirname, "..", "scripts", "scout-store.js"));
const git = (repo, args) => spawnSync("git", ["-c", "safe.directory=*", "-C", repo, ...args], { encoding: "utf8", windowsHide: true });
const bump = (f) => { const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); };

console.log("[C-1] 비-git 대상 — seed 밖 변경 유계 스캔(사각 해소)·전수 확인 불가면 unknown(fresh 사칭 금지)");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_nongit_"));
  fs.writeFileSync(path.join(repo, "a.md"), "seed");
  // basisTs에 +2s 여유 — 같은 밀리초 쓰기에서 mtimeMs 소수부 > ISO ms 절사값이 되는 경계 플레이크 방지
  store.saveMap(repo, "self", "① 후보\n- a.md — high", { seedFiles: ["a.md"], basisTs: new Date(Date.now() + 2000).toISOString(), seedMissing: [] });
  ok(CL.scoutMapStatus(repo).state === "fresh", "변경 없음 → fresh(비-git도 판정)");
  fs.writeFileSync(path.join(repo, "other-file.ts"), "seed 밖 새 파일");
  { const t = new Date(Date.now() + 10000); fs.utimesSync(path.join(repo, "other-file.ts"), t, t); } // basisTs(+2s)보다 확실히 뒤
  const st = CL.scoutMapStatus(repo);
  ok(st.state === "stale" && st.dirtyChanged >= 1, `비-git seed 밖 변경 감지(dirtyChanged=${st.dirtyChanged}) — 'seed 8개만 감시' 사각 해소(L1-C)`);
}
{
  // 상한 도달 + 신호 0 → unknown: nonGitChangedSince를 직접 검증(스캔 상한을 인위로 낮춰)
  const big = fs.mkdtempSync(path.join(os.tmpdir(), "l1_big_"));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(big, "f" + i + ".txt"), "x");
  const r = CL.nonGitChangedSince(big, Date.now() + 3600 * 1000, new Set(), 10, 6); // 미래 기준 → 변경 0·상한 10 → 미완
  ok(r.changed === 0 && r.complete === false, "상한 도달·신호 0 → complete=false(호출자가 unknown 처리 — 판정 불가≠신선)");
}

console.log("[C-1b] 비-git 실경로(수집기→러너 전달→판독) — 기준선과 현재 스캔의 seed 제외 집합 일치(Codex 2차 #1: 불일치면 새 지도가 즉시 stale)");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_e2e_"));
  // 무이력 seed=최근 수정 상위 8개 — 삭제 대상은 '가장 오래된' 파일로 만들어 seed 밖(인벤토리 전용 감시 영역)에 둔다
  fs.writeFileSync(path.join(repo, "gone-1.txt"), "삭제될 파일(비-seed)");
  { const t = new Date(Date.now() - 3600e3); fs.utimesSync(path.join(repo, "gone-1.txt"), t, t); }
  for (let i = 0; i < 9; i++) {
    const f = path.join(repo, "recent-" + i + ".md");
    fs.writeFileSync(f, "내용 " + i);
    const t = new Date(Date.now() - 60e3 + i * 1000); fs.utimesSync(f, t, t);
  }
  const { collectPackage } = require(path.join(__dirname, "..", "scripts", "scope-package.js"));
  const pkg = collectPackage(repo); // 비-git → 무이력 경로(seed=최근 수정 파일·nonGitFiles 기준선 기록)
  ok(!!pkg && pkg.meta && pkg.meta.nonGitFiles && pkg.meta.nonGitFiles.complete === true, "수집기 — 유계 인벤토리 기준선 기록(nonGitFiles)");
  // 러너 전달 로직 그대로(basisTs·seedMissing·seedHashes·nonGitFiles 골라 담기) — 러너와 같은 필드 집합
  const baseline = { basisTs: pkg.meta.basisTs, ...(Array.isArray(pkg.meta.seedMissing) ? { seedMissing: pkg.meta.seedMissing } : {}), ...(pkg.meta.seedHashes ? { seedHashes: pkg.meta.seedHashes } : {}), ...(pkg.meta.nonGitFiles ? { nonGitFiles: pkg.meta.nonGitFiles } : {}) };
  store.saveMap(repo, "self", "① 후보\n- seed-file.md — high", { seedFiles: pkg.seeds, ...baseline });
  const st0 = CL.scoutMapStatus(repo);
  ok(st0.state === "fresh", `생성 직후 fresh(실제 ${st0.state}/dirty=${st0.dirtyChanged}) — 기준선·현재 스캔의 seed 제외 집합 일치(불일치면 seed 수만큼 즉시 stale)`);
  fs.unlinkSync(path.join(repo, "gone-1.txt")); // 비-seed 파일 삭제
  const st1 = CL.scoutMapStatus(repo);
  ok(st1.state === "stale" && st1.dirtyChanged >= 1, `비-seed 삭제 감지 → stale(dirty=${st1.dirtyChanged}) — mtime만으로는 원리상 불가능하던 신호(인벤토리 비교)`);
}

console.log("[C-2] 이력 재작성 — 기록 기준 커밋 소실은 stale 신호(historyLost) — rev-list 실패를 0으로 삼키지 않음");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_git_"));
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "t@t"]); git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "a.md"), "v1");
  git(repo, ["add", "-A"]); git(repo, ["commit", "-qm", "c1"]);
  store.saveMap(repo, "self", "① 후보\n- a.md — high", { seedFiles: ["a.md"], basisTs: new Date().toISOString(), seedMissing: [], head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }); // 존재하지 않는 커밋 = 이력 재작성 후 상황
  const st = CL.scoutMapStatus(repo);
  ok(st.state === "stale" && st.historyLost === 1, `기준 커밋 없음 → historyLost=1·stale(실제 ${st.state}/${st.historyLost}) — 거짓 fresh 봉합`);
  // 무이력 지도(head=0000000)는 historyLost 아님
  store.saveMap(repo, "self", "① 후보\n- a.md — high", { seedFiles: ["a.md"], basisTs: new Date(Date.now() + 5000).toISOString(), seedMissing: [], head: "0000000" });
  const st2 = CL.scoutMapStatus(repo);
  ok(st2.historyLost === 0, "무이력 표지(0000000)는 검사 제외 — 모든 비-git 지도가 historyLost가 되는 오탐 없음(Codex)");
}

console.log("[C-3] 내용 지문 — mtime만 새것(빌드 touch)은 변경 아님·내용이 바뀌면 변경(부분 해시 아님 — 전체)");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_hash_"));
  const seed = path.join(repo, "s.ts");
  fs.writeFileSync(seed, "content-v1");
  const crypto = require("crypto");
  const h1 = crypto.createHash("sha1").update(fs.readFileSync(seed)).digest("hex");
  store.saveMap(repo, "self", "① 후보\n- s.ts — high", { seedFiles: ["s.ts"], basisTs: new Date().toISOString(), seedMissing: [], seedHashes: { "s.ts": h1 } });
  bump(seed); // mtime만 갱신(내용 동일)
  const st = CL.scoutMapStatus(repo);
  ok(st.state === "fresh" && st.seedChanged === 0, "touch(내용 동일) → 변경 아님(거짓 stale 봉합)");
  fs.writeFileSync(seed, "content-v2"); bump(seed);
  const st2 = CL.scoutMapStatus(repo);
  ok(st2.state === "stale" && st2.seedChanged === 1, "내용 변경 → stale(지문 불일치)");
}

console.log("[C-4] 재지시 버킷 — 성분별(이질 단위 합산 폐기): 한 성분만 커져도 재지시·구형 기억은 1회 재알림");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_bkt_"));
  fs.writeFileSync(path.join(repo, "a.md"), "x");
  store.saveMap(repo, "self", "① 후보\n- a.md — high", { seedFiles: ["a.md"], basisTs: new Date(Date.now() - 3600e3).toISOString(), seedMissing: [] });
  const c = { scoutMode: "on" };
  bump(path.join(repo, "a.md")); // seed 1 변경 → seed 버킷 1
  ok(!!CL.buildScoutDirective(repo, c), "낡음 첫 지시");
  ok(CL.buildScoutDirective(repo, c) === null, "같은 성분 정도 → 침묵");
  // seed 성분은 그대로(버킷 1), dirty 성분만 상승 → 성분별 규칙이라 재지시
  fs.writeFileSync(path.join(repo, "n1.ts"), "x"); bump(path.join(repo, "n1.ts"));
  const d = CL.buildScoutDirective(repo, c);
  ok(!!d, "다른 성분(작업트리) 버킷 상승 → 재지시(합산이었으면 1+1=2 버킷 상승과 구분 불가)");
  // 구형(v0) 기억 형식 → 성분 배정 불가 → 1회 재알림 허용(정직 업그레이드)
  const af = path.join(home, "scout-advice", CL.wsKeyFor(repo) + ".json");
  fs.writeFileSync(af, JSON.stringify({ sig: "stale:whatever" }));
  ok(!!CL.buildScoutDirective(repo, c), "구형 기억(합산 maxBucket) → 스키마 업그레이드 1회 재알림");
}

console.log("[B-1] reconcile alias CLI 끝-끝 — 후보 표시(스냅샷 번호)→승인(alias 이벤트)→병합·dismiss 숨김");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_alias_"));
  const t1 = "src/foo-module.ts ↔ tests/foo-module.test.js — 결합";
  const t2 = "결합: src/foo-module.ts 그리고 tests/foo-module.test.js";
  CL.appendLedgerEvent(repo, { ts: "t1", type: "proposed", sig: CL.ledgerSig(t1), text: t1, from: "지도A" });
  CL.appendLedgerEvent(repo, { ts: "t2", type: "proposed", sig: CL.ledgerSig(t2), text: t2, from: "지도B" });
  const CLI = path.join(__dirname, "..", "scripts", "scope-reconcile.js");
  const run = (...a) => spawnSync(process.execPath, [CLI, repo, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home } });
  const ls = run("aliases");
  ok(ls.status === 0 && /별칭 후보 1묶음/.test(ls.stdout) && /대표: /.test(ls.stdout), "후보 1묶음 표시(같은 endpoint+방향·다른 문구)");
  const ap = run("alias-approve", "1");
  ok(ap.status === 0 && /병합 승인/.test(ap.stdout), "승인 → alias 이벤트 기록");
  const evs = CL.readLedgerEventsText(repo);
  ok(/"type":"alias"/.test(evs), "원장에 alias 이벤트(append-only — 원본 이벤트 보존)");
  const LE = require(path.join(__dirname, "..", "out", "ledger-events.js"));
  const entries = LE.deriveLedger(LE.parseEventsJsonl(evs).events);
  ok(entries.length === 1 && (entries[0].aliases || []).length === 1, "유도 결과 한 항목으로 병합(별칭 기록)");
  ok(run("aliases").stdout.includes("별칭 후보 없음"), "병합 후 후보 목록에서 사라짐");
  // 해제(unalias) 끝-끝 — 잘못 승인의 되돌림(Codex #3: undo 없으면 append-only 정정 계약 불성립)
  const ald = run("aliased");
  ok(ald.status === 0 && /병합\(활성 직접 간선\) 1건/.test(ald.stdout), "aliased — 현재 병합 목록(활성 직접 간선·번호 스냅샷)");
  const un = run("unalias", "1");
  ok(un.status === 0 && /병합 해제/.test(un.stdout), "unalias → unalias 이벤트 기록");
  {
    const es2 = LE.deriveLedger(LE.parseEventsJsonl(CL.readLedgerEventsText(repo)).events);
    ok(es2.length === 2, "해제 후 두 항목으로 복귀(원장 보존 — 재해석만)");
    ok(run("aliased").stdout.includes("병합(별칭)이 없음"), "해제 후 aliased 목록 비움");
  }
  // dismiss 경로 — 해제(unalias)로 foo 묶음도 후보에 복귀한 상태이므로 두 묶음 다 숨겨야 '없음'
  const t3 = "src/bar-module.ts ↔ tests/bar-module.test.js";
  const t4 = "src/bar-module.ts ↔ tests/bar-module.test.js (다른 표현)";
  CL.appendLedgerEvent(repo, { ts: "t3", type: "proposed", sig: CL.ledgerSig(t3), text: t3 });
  CL.appendLedgerEvent(repo, { ts: "t4", type: "proposed", sig: CL.ledgerSig(t4), text: t4 });
  const ls2 = run("aliases");
  ok(/별칭 후보 2묶음/.test(ls2.stdout), "해제된 foo 묶음+새 bar 묶음 = 후보 2(해제가 후보 복귀로 재해석됨)");
  const dm = run("alias-dismiss", "1", "2");
  ok(dm.status === 0 && run("aliases").stdout.includes("별칭 후보 없음"), "dismiss → 후보에서 숨김(병합 없음·이벤트 없음)");
  // 체인(A←B←C)에서 aliased 목록은 '활성 직접 간선'만 — 유도 후손(A–C 표시)을 그대로 해제하면 헛동작(Codex 2차 #3 실측)
  {
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "l1_chain_"));
    for (const [sig, text] of [["A", "src/ch-alpha.ts ↔ tests/ch-alpha.test.js"], ["B", "결합 B"], ["C", "결합 C"]]) CL.appendLedgerEvent(repo2, { ts: "t", type: "proposed", sig, text });
    CL.appendLedgerEvent(repo2, { ts: "t", type: "alias", sig: "A", aliasSig: "B" });
    CL.appendLedgerEvent(repo2, { ts: "t", type: "alias", sig: "B", aliasSig: "C" });
    const run2 = (...a) => spawnSync(process.execPath, [CLI, repo2, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home } });
    const out = run2("aliased").stdout;
    ok(/병합\(활성 직접 간선\) 2건/.test(out), "체인 A←B←C → 직접 간선 2건(B→A·C→B)만 표시(유도 후손 A–C 아님)");
    // C의 실제 간선(C→B)을 해제 — 유도 결과 C가 분리돼야 함(간접 쌍을 해제 대상으로 삼으면 아무것도 안 풀리던 반례)
    const list = JSON.parse(fs.readFileSync(path.join(home, "map-reconcile", CL.wsKeyFor(repo2) + ".json"), "utf8")).unaliasList;
    const idx = list.findIndex((pr) => pr.child === "C");
    const un2 = run2("unalias", String(idx + 1));
    ok(un2.status === 0, "C→B 간선 해제 성공");
    const es3 = require(path.join(__dirname, "..", "out", "ledger-events.js")).deriveLedger(require(path.join(__dirname, "..", "out", "ledger-events.js")).parseEventsJsonl(CL.readLedgerEventsText(repo2)).events);
    ok(es3.length === 2 && es3.some((x) => x.sig === "C") && es3.some((x) => x.sig === "A" && (x.aliases || []).includes("B")), "해제 후 C 분리·A←B 유지(실제 간선이 풀림 — 헛동작 아님)");
  }
}

console.log("[A-1] 결합 확인 요청 동봉 — 기계 확인 가능 항목만·id 표기·buildScoutAttach envelope에 couplings");
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "l1_cpl_"));
  const good = "src/alpha-module.ts ↔ lib/beta-consumer.ts — 결합";
  CL.appendLedgerEvent(repo, { ts: "t1", type: "proposed", sig: CL.ledgerSig(good), text: good });
  CL.appendLedgerEvent(repo, { ts: "t2", type: "proposed", sig: "concept", text: "개념 결합(경로 없음)" });
  const cands = CL.ledgerCouplingCandidates(repo, 3);
  ok(cands.length === 1 && /^[0-9a-f]{6}$/.test(cands[0].id) && cands[0].paths.length === 2, "후보=기계 확인 가능 항목만·6자 id·경로 동봉");
  // attach 본문에 결합 확인 요청 블록 — 지도가 있어야 동봉 자체가 생성됨
  fs.writeFileSync(path.join(repo, "a.md"), "x");
  store.saveMap(repo, "self", "① 후보\n- a.md — high", { seedFiles: ["a.md"], basisTs: new Date(Date.now() + 5000).toISOString(), seedMissing: [] });
  const att = CL.buildScoutAttach(repo, { scoutMode: "on", scoutRepo: repo }, "ko");
  ok(!!att && att.text.includes("[결합 확인 요청") && att.text.includes("#" + cands[0].id) && att.text.includes("결합반박 #id"), "동봉 본문에 확인 요청 블록+id+반박 표기 안내");
  ok(Array.isArray(att.couplings) && att.couplings.some((cp) => cp.id === cands[0].id), "envelope.couplings — flagLedgerConfirms의 명시 표기 귀속 입력");
}

console.log("[B-3] 트림 동형성(Codex 3차 반례 2종) — 기록 전용 이벤트가 경계/보존을 왜곡해 트림 전후 상태가 변하면 안 됨");
{
  const LE3 = require(path.join(__dirname, "..", "out", "ledger-events.js"));
  const derive = (w) => LE3.deriveLedger(LE3.parseEventsJsonl(CL.readLedgerEventsText(w)).events).find((x) => x.sig === "tt");
  // 반례 A: verified 상태에서 '기록 전용 반박'(cited:true지만 seen:unknown)+채움 → 트림 후에도 verified 유지
  const wA = path.join(home, "trim-eq-a");
  fs.mkdirSync(wA, { recursive: true });
  const seedA = [
    JSON.stringify({ ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }),
    JSON.stringify({ ts: "t1", type: "user_dispute", sig: "tt" }),
    JSON.stringify({ ts: "t2", type: "confirmed", sig: "tt", grade: "co-cited", askId: "a1", seen: "ok" }),
    JSON.stringify({ ts: "t3", type: "confirmed", sig: "tt", grade: "co-cited", askId: "a2", seen: "ok" }),
    JSON.stringify({ ts: "t4", type: "refuted", sig: "tt", grade: "claimed", cited: true, seen: "unknown", askId: "a3" }), // 기록 전용(승격/강등 재료 아님)
  ];
  const fillA = [];
  for (let i = 0; i < 2450; i++) fillA.push(JSON.stringify({ ts: "f" + i, type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }));
  fs.writeFileSync(CL.ledgerEventsFileFor(wA), seedA.concat(fillA).join("\n") + "\n");
  const beforeA = derive(wA);
  CL.appendLedgerEvent(wA, { ts: "tz", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }); // 트림 유발
  const afterA = derive(wA);
  ok(beforeA.status === "verified" && afterA.status === "verified", `기록 전용 반박이 경계가 되지 않음 — 트림 전 ${beforeA.status} = 후 ${afterA.status}(유효 확인 2건 보존)`);
  // 반례 B: disputed 상태에서 '기록 전용 확인'(claimed·cited:false) 홍수 → 트림 후에도 disputed 유지(실제 반박 보존)
  const wB = path.join(home, "trim-eq-b");
  fs.mkdirSync(wB, { recursive: true });
  const seedB = [
    JSON.stringify({ ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }),
    JSON.stringify({ ts: "t1", type: "user_dispute", sig: "tt" }),
  ];
  const fillB = [];
  for (let i = 0; i < 2450; i++) fillB.push(JSON.stringify({ ts: "g" + i, type: "confirmed", sig: "tt", grade: "claimed", cited: false, echoed: true, askId: "x" + i, seen: "ok" }));
  fs.writeFileSync(CL.ledgerEventsFileFor(wB), seedB.concat(fillB).join("\n") + "\n");
  CL.appendLedgerEvent(wB, { ts: "tz", type: "confirmed", sig: "tt", grade: "claimed", cited: false, echoed: true, askId: "xz", seen: "ok" });
  const afterB = derive(wB);
  ok(afterB.status === "disputed", `기록 전용 확인 홍수가 실제 반박을 밀어내지 않음 — 트림 후 ${afterB.status}(user_dispute 보존)`);
  // 반례 C(Codex 4차): '기록 전용 반박' 홍수 — STATE 무조건 보존이면 이것들 2,000건이 실제 user_dispute를 밀어냄
  const wC = path.join(home, "trim-eq-c");
  fs.mkdirSync(wC, { recursive: true });
  const seedC = [
    JSON.stringify({ ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }),
    JSON.stringify({ ts: "t1", type: "user_dispute", sig: "tt" }),
  ];
  const fillC = [];
  for (let i = 0; i < 2450; i++) fillC.push(JSON.stringify({ ts: "h" + i, type: "refuted", sig: "tt", grade: "claimed", cited: false, seen: "ok", askId: "y" + i }));
  fs.writeFileSync(CL.ledgerEventsFileFor(wC), seedC.concat(fillC).join("\n") + "\n");
  CL.appendLedgerEvent(wC, { ts: "tz", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" });
  const rawC = CL.readLedgerEventsText(wC);
  ok(/"user_dispute"/.test(rawC), "기록 전용 반박 홍수가 실제 반박(user_dispute)을 밀어내지 않음(조건화 보존)");
  const afterC = derive(wC);
  ok(afterC.status === "disputed", `트림 후에도 disputed 유지(실제 ${afterC.status})`);
  // 반례 D(Codex 5차): 가역쌍 교대 홍수 — 개수 절단은 접두를 잘라 '순계'를 뒤집는다 → 순계 압축으로 보존
  const mkAlt = (name, evenType, oddType, extra) => {
    const w = path.join(home, "trim-eq-" + name);
    fs.mkdirSync(w, { recursive: true });
    const rows = [JSON.stringify({ ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" })];
    for (let i = 0; i < 2401; i++) rows.push(JSON.stringify({ ts: "a" + i, type: i % 2 === 0 ? evenType : oddType, sig: "tt", ...(extra || {}) }));
    fs.writeFileSync(CL.ledgerEventsFileFor(w), rows.join("\n") + "\n");
    CL.appendLedgerEvent(w, { ts: "tz", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" });
    return derive(w);
  };
  const dBan = mkAlt("ban", "banned", "unbanned");   // 순계 +1(banned로 시작·홀수 회) → 트림 후에도 banned여야
  ok(dBan && dBan.status === "banned", `ban/unban 2,401회 교대 → 트림 후 순계 보존(banned — 실제 ${dBan && dBan.status})`);
  const dPin = mkAlt("pin", "pinned", "unpinned");
  ok(dPin && dPin.pinned === true, "pin/unpin 2,401회 교대 → 트림 후 고정 유지(순계 압축)");
  {
    const w = path.join(home, "trim-eq-al");
    fs.mkdirSync(w, { recursive: true });
    const rows = [
      JSON.stringify({ ts: "t0", type: "proposed", sig: "P", text: "tq-alpha.ts ↔ tq-beta.ts" }),
      JSON.stringify({ ts: "t1", type: "proposed", sig: "S", text: "결합 S(별칭)" }),
    ];
    for (let i = 0; i < 2401; i++) rows.push(JSON.stringify({ ts: "a" + i, type: i % 2 === 0 ? "alias" : "unalias", sig: "P", aliasSig: "S" }));
    fs.writeFileSync(CL.ledgerEventsFileFor(w), rows.join("\n") + "\n");
    CL.appendLedgerEvent(w, { ts: "tz", type: "proposed", sig: "P", text: "tq-alpha.ts ↔ tq-beta.ts" });
    const LEx = require(path.join(__dirname, "..", "out", "ledger-events.js"));
    const es = LEx.deriveLedger(LEx.parseEventsJsonl(CL.readLedgerEventsText(w)).events);
    ok(es.length === 1 && es.some((x) => (x.aliases || []).includes("S")), `alias/unalias 2,401회 교대 → 트림 후 병합 유지(순계 +1 압축 — 실제 ${es.length}항목)·원문 proposed도 생존`);
  }
  // 반례 E/G(Codex 6·7차): '압축이 먼저 확정된 뒤' 미래 역이벤트 — 트림 유발과 역이벤트를 분리(같은 append면
  // 역이벤트가 압축 전에 반영돼 부호-only 압축도 통과하는 무효 검사 — Codex 7차 #3).
  const trimThenReverse = (name, stateEvents, reverseEvent) => {
    const w = path.join(home, "trim-eq-" + name);
    fs.mkdirSync(w, { recursive: true });
    const rows = stateEvents.map((e) => JSON.stringify(e));
    for (let i = 0; i < 2450; i++) rows.push(JSON.stringify({ ts: "f" + i, type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }));
    fs.writeFileSync(CL.ledgerEventsFileFor(w), rows.join("\n") + "\n");
    CL.appendLedgerEvent(w, { ts: "tn", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" }); // 중립 이벤트로 트림 확정
    ok(/trim-compact/.test(CL.readLedgerEventsText(w)), name + " — 압축 확정(trim-compact 존재) 후에야 미래 명령 적용");
    CL.appendLedgerEvent(w, { ts: "tz", ...reverseEvent }); // 압축된 이력 위에 별도 append(파일이 상한 아래라 재트림 없음)
    return w;
  };
  {
    const w = trimThenReverse("n2", [
      { ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" },
      { ts: "t1", type: "banned", sig: "tt" }, { ts: "t2", type: "banned", sig: "tt" }, // 순계 +2
    ], { type: "unbanned", sig: "tt" });
    const d = derive(w);
    ok(d && d.status === "banned", `+2 압축 '후' unban 1건 → 원본과 같은 +1(banned 유지 — 부호만 보존하면 inferred: 실제 ${d && d.status})`);
  }
  {
    const w = trimThenReverse("neg", [
      { ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" },
      { ts: "t1", type: "unbanned", sig: "tt" }, { ts: "t2", type: "unbanned", sig: "tt" }, // 순계 -2
    ], { type: "banned", sig: "tt" });
    const d = derive(w);
    ok(d && d.status !== "banned", `음수 순계(-2)도 압축 보존 — 이후 ban 1건이면 -1(차단 아님 · 실제 ${d && d.status}) — 음수 폐기면 즉시 banned(Codex 7차 #2)`);
  }
  {
    const w = trimThenReverse("pin2", [
      { ts: "t0", type: "proposed", sig: "tt", text: "tq-alpha.ts ↔ tq-beta.ts" },
      { ts: "t1", type: "pinned", sig: "tt" }, { ts: "t2", type: "pinned", sig: "tt" },
    ], { type: "unpinned", sig: "tt" });
    const d = derive(w);
    ok(d && d.pinned === true, "pin 순계 +2 압축 '후' unpin 1건 → 여전히 고정(+1) — 미래 역연산 보존");
  }
  // 반례 F(Codex 6·7차): 열세 양수 간선 보존+CLI 가중 표시 — 압축 '후' 우세 간선 unalias 시 열세 부모 승계
  {
    const w = path.join(home, "trim-eq-edges");
    fs.mkdirSync(w, { recursive: true });
    const rows = [];
    for (let i = 0; i < 2450; i++) rows.push(JSON.stringify({ ts: "f" + i, type: "proposed", sig: "Z", text: "tz-alpha.ts ↔ tz-beta.ts" }));
    rows.push(
      JSON.stringify({ ts: "t0", type: "proposed", sig: "Z", text: "tz-alpha.ts ↔ tz-beta.ts" }),
      JSON.stringify({ ts: "t1", type: "proposed", sig: "A", text: "ta-alpha.ts ↔ ta-beta.ts" }),
      JSON.stringify({ ts: "t2", type: "proposed", sig: "S", text: "결합 S" }),
      JSON.stringify({ ts: "t3", type: "alias", sig: "Z", aliasSig: "S" }), JSON.stringify({ ts: "t4", type: "alias", sig: "Z", aliasSig: "S" }), // Z→S 순계 2(우세)
      JSON.stringify({ ts: "t5", type: "alias", sig: "A", aliasSig: "S" })); // A→S 순계 1(열세)
    fs.writeFileSync(CL.ledgerEventsFileFor(w), rows.join("\n") + "\n");
    CL.appendLedgerEvent(w, { ts: "tn", type: "proposed", sig: "Z", text: "tz-alpha.ts ↔ tz-beta.ts" }); // 중립 트림 확정
    ok(/trim-compact/.test(CL.readLedgerEventsText(w)), "edges — 압축 확정 후 진행");
    // CLI 가중 표시(Codex 7차 #1): 압축본(n=2·1) 위에서 aliased가 정본과 같은 우세 부모(Z)를 보여야
    const runW = (...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "scope-reconcile.js"), w, ...a], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: home } });
    const aldW = runW("aliased");
    ok(/S[\s\S]{0,120}→ (대표|primary) sig: Z/.test(aldW.stdout) || /→ 대표 sig: Z/.test(aldW.stdout), "CLI aliased — 가중 해석으로 우세 부모 Z 표시(1:1 동률 오표시면 잘못된 unalias 유도 — Codex 7차 #1)");
    CL.appendLedgerEvent(w, { ts: "tz", type: "unalias", sig: "Z", aliasSig: "S" }); // 압축 후 우세 간선 1 감산 → Z:1 vs A:1 동률 → 사전순 A 승계
    const LEy = require(path.join(__dirname, "..", "out", "ledger-events.js"));
    const es = LEy.deriveLedger(LEy.parseEventsJsonl(CL.readLedgerEventsText(w)).events);
    const aEntry = es.find((x) => x.sig === "A");
    ok(!!aEntry && (aEntry.aliases || []).includes("S"), "압축 '후' 우세 간선 감산 → 열세 부모(A) 승계 — 열세 간선을 버렸으면 S가 고아(Codex 반례)");
  }
}

console.log("[B-4] 압축 극단(Codex 8차) — 압축본이 예산을 채워도 항목 정체성(대표 원문) 보존·재압축 유예");
{
  // 활성 alias 2,000개(부모·자식 proposed 포함 6,000줄) → 트림 후에도 유도 항목이 사라지지 않아야
  const w = path.join(home, "trim-ident");
  fs.mkdirSync(w, { recursive: true });
  const rows = [];
  for (let i = 0; i < 2000; i++) {
    rows.push(JSON.stringify({ ts: "p" + i, type: "proposed", sig: "P" + i, text: "id-alpha-" + i + ".ts ↔ id-beta-" + i + ".ts" }));
    rows.push(JSON.stringify({ ts: "c" + i, type: "proposed", sig: "C" + i, text: "별칭 문구 " + i }));
    rows.push(JSON.stringify({ ts: "a" + i, type: "alias", sig: "P" + i, aliasSig: "C" + i }));
  }
  fs.writeFileSync(CL.ledgerEventsFileFor(w), rows.join("\n") + "\n");
  CL.appendLedgerEvent(w, { ts: "tn", type: "proposed", sig: "P0", text: "id-alpha-0.ts ↔ id-beta-0.ts" }); // 트림 유발
  const LEz = require(path.join(__dirname, "..", "out", "ledger-events.js"));
  const es = LEz.deriveLedger(LEz.parseEventsJsonl(CL.readLedgerEventsText(w)).events);
  ok(es.length >= 2000, `트림 후 유도 항목 보존(${es.length}건 ≥ 2000) — 압축본만 남아 항목이 0이 되던 반례(Codex 8차 #1) 봉합`);
  ok(es.filter((x) => (x.aliases || []).length === 1).length >= 2000, "병합 상태(간선)도 전부 유지");
  // 재압축 유예: 압축 직후 일반 append 몇 건은 재정리(재작성)를 트리거하지 않음 — 원시 줄이 꼬리에 그대로 남는다
  const linesBefore = CL.readLedgerEventsText(w).split(/\r?\n/).filter(Boolean).length;
  CL.appendLedgerEvent(w, { ts: "s1", type: "proposed", sig: "P0", text: "id-alpha-0.ts ↔ id-beta-0.ts" });
  CL.appendLedgerEvent(w, { ts: "s2", type: "proposed", sig: "P0", text: "id-alpha-0.ts ↔ id-beta-0.ts" });
  const tail2 = CL.readLedgerEventsText(w).split(/\r?\n/).filter(Boolean);
  ok(tail2.length === linesBefore + 2 && /"ts":"s2"/.test(tail2[tail2.length - 1]), "압축 직후 연속 append 2건 → 재정리 없이 꼬리에 원시 보존(유예 임계 400 미만 — 매 append 전량 재작성 반복 차단: Codex 8차 #2)");
}

console.log("[B-5] 장부 동시 쓰기(Codex 9차) — 트림 임계 직전 원장에 두 프로세스 병렬 append → 고유 이벤트 유실 0");
{
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "l1lock_")); // 전용 홈 — 정확 단언
  const w = path.join(home2, "proj");
  fs.mkdirSync(w, { recursive: true });
  // 임계 직전(2,390줄) 원장 준비 — 병렬 append 중 트림이 실제로 발동하는 경계
  const seedRows = [];
  for (let i = 0; i < 2390; i++) seedRows.push(JSON.stringify({ ts: "s" + i, type: "proposed", sig: "seed" + i, text: "sd-alpha-" + i + ".ts ↔ sd-beta-" + i + ".ts" }));
  const N = 25;
  const workerJs = `
    process.env.CODEX_BRIDGE_HOME = ${JSON.stringify(home2)};
    const CL = require(${JSON.stringify(path.join(__dirname, "..", "bridge", "contract-lib.js"))});
    const tag = process.argv[1];
    for (let i = 0; i < ${N}; i++) CL.appendLedgerEvent(${JSON.stringify(w)}, { ts: "t-" + tag + "-" + i, type: "user_dispute", sig: "race-" + tag + "-" + i });
  `;
  const envH = { ...process.env, CODEX_BRIDGE_HOME: home2 };
  const CLH = path.join(__dirname, "..", "bridge", "contract-lib.js");
  // 원장 파일은 이 프로세스에서 직접 작성(argv로 350KB를 넘기면 Windows 명령줄 상한에 걸림) —
  // 경로 파생은 wsKeyFor 재사용(ledgerEventsFileFor와 동일 규칙: BRIDGE_DIR/map-ledger-events/<sha1 16자>.jsonl)
  const f2 = path.join(home2, "map-ledger-events", CL.wsKeyFor(w) + ".jsonl");
  fs.mkdirSync(path.dirname(f2), { recursive: true });
  fs.writeFileSync(f2, seedRows.join("\n") + "\n");
  ok(fs.existsSync(f2), "경계 원장 준비");
  // 병렬 실행(경합 재현) — 마감은 파일 꼬리의 비동기 종료가 담당
  const { spawn } = require("child_process");
  const runP = (tag) => new Promise((res) => { const c = spawn(process.execPath, ["-e", workerJs, tag], { stdio: "ignore", env: envH }); c.on("close", res); });
  global.__b5 = Promise.all([runP("A"), runP("B")]).then(() => {
    const readBack = spawnSync(process.execPath, ["-e", `process.env.CODEX_BRIDGE_HOME=${JSON.stringify(home2)};const CL=require(${JSON.stringify(CLH)});process.stdout.write(CL.readLedgerEventsText(${JSON.stringify(w)}));`], { encoding: "utf8", env: envH });
    const races = (readBack.stdout.match(/race-[AB]-\d+/g) || []);
    const uniq = new Set(races);
    ok(uniq.size === N * 2, `병렬 append 고유 이벤트 유실 정확히 0 — ${uniq.size}/${N * 2}(user_dispute는 판정군 우선 보존이라 트림에도 안 잘림 — 잠금 없으면 트림 read~replace 경계에서 소실)`);
    ok(!fs.existsSync(f2 + ".lock"), "정상 종료 후 잠금 파일 잔존 0(토큰 소유권 해제 — 회귀 잠금)");
    try { fs.rmSync(home2, { recursive: true, force: true }); } catch { /* 무해 */ }
  });
}

console.log("[A-2] 소스 계약 — askId·envelope 배선·전역 합집합 echo 부재·러너 지문 전달(끝단)");
{
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  ok((cb.match(/flagLedgerConfirms\([^)]*\{ askId, attach: attCarrier \}/g) || []).length >= 3, "세 호출부 전부 askId+동봉 스냅샷 전달");
  ok(/randomUUID\(\)/.test(cb), "askId=UUID('서로 다른 ask 실행' 재료 — 지문·ts 아님)");
  ok(/itemSets\.some/.test(cb), "echo는 '항목 단위' 판정(전역 합집합 과도 판정 폐기 — Codex)");
  // 러너 끝단 배선(Codex #2 반례: 수집기는 지문을 만드는데 러너가 안 넘기면 판독기 비교가 영영 미실행)
  for (const f of ["scope-scout-self.js", "scope-scout-deepseek.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "scripts", f), "utf8");
    ok(/seedHashes: pkg\.meta\.seedHashes/.test(src) && /nonGitFiles: pkg\.meta\.nonGitFiles/.test(src), f + " — 지문·인벤토리를 지도 메타로 전달");
  }
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(/m0\.seedHashes/.test(ext) && /m0\.nonGitFiles/.test(ext), "확장 판독(readScoutMaps)도 지문·인벤토리 필드 포함(끝단 판독)");
}
console.log("[B-2] 트리머 병합 인지 — 별칭 자식의 반박 뒤 '부모 sig의 복권 확인'도 트림에서 보존");
{
  const wsT = path.join(home, "trim-alias");
  fs.mkdirSync(wsT, { recursive: true });
  const tf = CL.ledgerEventsFileFor(wsT);
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  const seed = [
    JSON.stringify({ ts: "t0", type: "proposed", sig: "parent", text: "pa-alpha.ts ↔ pa-beta.ts" }),
    JSON.stringify({ ts: "t1", type: "proposed", sig: "child", text: "결합: pa-alpha.ts 그리고 pa-beta.ts" }),
    JSON.stringify({ ts: "t2", type: "alias", sig: "parent", aliasSig: "child" }),
    JSON.stringify({ ts: "t3", type: "user_dispute", sig: "child" }),                                  // 자식 sig로 반박
    JSON.stringify({ ts: "t4", type: "confirmed", sig: "parent", grade: "co-cited", askId: "a1", seen: "ok" }),     // 부모 sig로 복권 확인 2회
    JSON.stringify({ ts: "t5", type: "confirmed", sig: "parent", grade: "co-cited", askId: "a2", seen: "ok" }),
  ];
  const filler = [];
  for (let i = 0; i < 2450; i++) filler.push(JSON.stringify({ ts: "f" + i, type: "proposed", sig: "parent", text: "pa-alpha.ts ↔ pa-beta.ts" }));
  fs.writeFileSync(tf, seed.concat(filler).join("\n") + "\n");
  CL.appendLedgerEvent(wsT, { ts: "tz", type: "proposed", sig: "parent", text: "pa-alpha.ts ↔ pa-beta.ts" }); // 트림 유발
  const LE2 = require(path.join(__dirname, "..", "out", "ledger-events.js"));
  const after = LE2.deriveLedger(LE2.parseEventsJsonl(CL.readLedgerEventsText(wsT)).events).find((x) => x.sig === "parent");
  ok(after && after.status === "verified" && after.rehabilitated === true, "트림 후에도 복권 유지 — 반박(자식)과 복권 확인(부모)을 병합 기준으로 함께 보존(Codex #5)");
}

(global.__b5 || Promise.resolve()).then(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 무해 */ }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
});
