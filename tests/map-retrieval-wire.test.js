// 검색 4조각 — 배선 · 정본 docs/MAP-RETRIEVAL-DESIGN.md 3단계 + SPEC §3
// 계약: 4축 선별(축 순서 고정·라운드로빈 재배분·중복=선점 축)·전 축 공백=fallback(무관 후보 채움 금지)·
// reqText 부재=기존 동작 그대로(무회귀)·fallback/truncated 고지·capsOverride 생산 미전달·배포 편입.
const path = require("path");
const fs = require("fs");
const os = require("os");
const ROOT = path.join(__dirname, "..");
process.env.CODEX_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mrwire_"));
const MR = require(path.join(ROOT, "bridge", "map-retrieval.js"));
const RD = require(path.join(ROOT, "bridge", "map-reader.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}
const mk = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

console.log("[1] selectCandidates — 축 배정·선점 소유·라운드로빈 재배분");
{
  const nodes = [
    { id: "nA", paths: ["src/a.js"] }, { id: "nB", paths: ["src/b.js"] },
    { id: "nC", paths: ["src/c.js"] }, { id: "nD", paths: ["src/d.js"] },
    { id: "nE", paths: ["src/e.js"] },
  ];
  const r = MR.selectCandidates({
    nodes,
    seedScores: new Map([["src/a.js", 5000], ["src/b.js", 2000]]),
    changedPaths: new Set(["src/b.js", "src/c.js"]),
    ledgerPaths: new Set(["src/d.js"]),
    edges: [{ from: "nA", to: "nE" }],
    cap: 8,
  });
  const axisOf = new Map(r.selected.map((s) => [s.id, s.axis]));
  ok(!r.fallback && r.selected.length === 5, "전 축 후보 5건 전부 선별(cap 안)");
  ok(axisOf.get("nA") === "intent" && r.selected[0].id === "nA", "의도 축 최고점=nA·첫 자리(점수 내림차순)");
  ok(axisOf.get("nB") === "changed", "nB=의도·변경 겹침 → 라운드로빈에서 먼저 뽑은 축 소유(변경)");
  ok(axisOf.get("nC") === "changed" || axisOf.get("nC") === undefined ? axisOf.get("nC") === "changed" : false, "nC=변경 축");
  ok(axisOf.get("nD") === "ledger", "nD=장부 축");
  ok(axisOf.get("nE") === "neighbor", "nE=인접 축(nA에서 1칸)");
}
{
  // 재배분: 의도 축만 후보 9개·cap 8 → 다른 축 몫이 의도 축으로 전부 재배분
  const nodes = Array.from({ length: 9 }, (_, i) => ({ id: "n" + i, paths: [`s/f${i}.js`] }));
  const r = MR.selectCandidates({ nodes, seedScores: new Map(nodes.map((n, i) => [n.paths[0], 1000 * (9 - i)])), changedPaths: new Set(), ledgerPaths: new Set(), edges: [], cap: 8 });
  ok(r.selected.length === 8 && r.selected.every((s) => s.axis === "intent"), "빈 축 몫 재배분 — 의도 축이 cap 8 전부 사용");
  const r0 = MR.selectCandidates({ nodes: [], seedScores: new Map(), changedPaths: new Set(), ledgerPaths: new Set(), edges: [], cap: 8 });
  ok(r0.fallback === true && r0.selected.length === 0, "전 축 공백=fallback(무관 후보 채움 없음)");
  const d1 = JSON.stringify(MR.selectCandidates({ nodes, seedScores: new Map([["s/f0.js", 100]]), changedPaths: new Set(["s/f1.js"]), ledgerPaths: new Set(), edges: [], cap: 3 }));
  const d2 = JSON.stringify(MR.selectCandidates({ nodes, seedScores: new Map([["s/f0.js", 100]]), changedPaths: new Set(["s/f1.js"]), ledgerPaths: new Set(), edges: [], cap: 3 }));
  ok(d1 === d2, "결정론 — 같은 입력 같은 선별");
}

console.log("[2] renderV2Slice 배선 — reqText 부재=기존 동작(무회귀 축)");
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mrwirews_"));
  for (let i = 0; i < 10; i++) mk(WS, `src/m${i}.js`, `내용 ${i}`);
  const proj = {
    ok: true, source: "v2", mapId: "m1", nodes: Array.from({ length: 10 }, (_, i) => ({ id: "N" + i, label: "노드" + i, anchors: [{ path: `src/m${i}.js` }] })),
    edges: [], approved: [], degraded: [], decisions: [],
  };
  const a = RD.renderV2Slice(WS, {}, "ko", proj);
  ok(a.mapItems.length === 8 && a.mapItems[0].path === "src/m0.js", "reqText 부재 — 투영 순 앞 8개(기존 동작)");
  ok(a.text.includes("이번 변경과 연결된"), "기존 머리글 유지");
  ok(!a.text.includes("선별") && !a.text.includes("씨앗"), "선별·고지 문구 전무(바이트 무회귀 축)");
  const b = RD.renderV2Slice(WS, {}, "ko", proj, "");
  ok(JSON.stringify(b) === JSON.stringify(a), "빈 reqText=부재와 동일");
}

console.log("[3] renderV2Slice 배선 — 요청 기준 선별 발동");
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mrwirews3_"));
  for (let i = 0; i < 10; i++) mk(WS, `src/m${i}.js`, i === 7 ? "targetFunc 구현" : `내용 ${i}`);
  const proj = {
    ok: true, source: "v2", mapId: "m1", nodes: Array.from({ length: 10 }, (_, i) => ({ id: "N" + i, label: "노드" + i, anchors: [{ path: `src/m${i}.js` }] })),
    edges: [{ id: "E1", from: "N7", to: "N3" }], approved: [], degraded: [], decisions: [],
  };
  const r = RD.renderV2Slice(WS, {}, "ko", proj, "targetFunc 를 고쳐줘 — `targetFunc` 확인");
  ok(r.mapItems[0].path === "src/m7.js", "씨앗이 걸린 노드가 첫 자리(투영 순서 밀림 — 기존이면 m0)");
  ok(r.mapItems.some((m) => m.path === "src/m3.js"), "인접 축 — 씨앗 노드에서 1칸(N3) 동봉");
  ok(r.text.includes("이번 요청·변경과 연결되어 선별된"), "선별 적용 머리글");
  ok(!r.text.includes("선별 미적용"), "fallback 고지 없음");
  ok(r.text.includes("선별 제외: node 8개"), "무축 노드 8개=선별 제외 고지(상한 생략 아님 — cap 미달)");
  ok(!r.text.includes("상한으로 생략"), "cap 미달이라 상한 생략 고지 없음");
}

console.log("[4] renderV2Slice 배선 — 전 축 공백=fallback 고지·잘림 고지");
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mrwirews4_"));
  for (let i = 0; i < 4; i++) mk(WS, `src/m${i}.js`, `내용 ${i}`);
  const proj = {
    ok: true, source: "v2", mapId: "m1", nodes: Array.from({ length: 4 }, (_, i) => ({ id: "N" + i, label: "노드" + i, anchors: [{ path: `src/m${i}.js` }] })),
    edges: [], approved: [], degraded: [], decisions: [],
  };
  const r = RD.renderV2Slice(WS, {}, "ko", proj, "아무 데도 안 걸리는 `missingToken` 요청");
  // [요청 축 게이트 2026-08-06] 의도 축 0=동봉 전체 생략+1줄 고지(종전 fallback '기본 순서 동봉' 계약 대체 —
  // 비코드 검증에 무관 지도 ~2.9천자 실리던 실측 봉합·사용자 승인 처방)
  ok(r.text.includes("[Project MAP 동봉 생략]") && r.text.includes("의도 축 0"), "의도 축 0=게이트 발동·1줄 고지(침묵 생략 아님)");
  ok(r.mapItems.length === 0 && !r.text.includes("- src/m0.js"), "다른 축이 자리를 채우지 않음(기본 순서 동봉 소멸)");
  ok(!r.text.includes("[결합 확인 요청") && !r.text.includes("[정찰 관찰 신호") && !r.text.includes("확인 항목"), "부속 블록 2종도 함께 생략(게이트 결속 — 고지문 언급과 실제 블록 머리글 구분)");
  mk(WS, "big.js", "x".repeat(600 * 1024)); // 파일당 상한(512KiB) 초과 → 검색 truncated
  const t = RD.renderV2Slice(WS, {}, "ko", proj, "`missingToken` 재요청");
  ok(t.text.includes("[Project MAP 동봉 생략]") && t.text.includes("씨앗 검색이 상한에 걸려 잘렸다"), "게이트에서도 검색 잘림 고지 불소실(지표 unknown 안내)");
  // 확인 검증 [보완] 반영 — 핵심 반례: '변경 축만 후보'(의도 0+최근 변경 있음 — 실사고 재현 조건).
  // 대량 푸시 직후의 무관 질문 상황: 종전에는 변경 축이 자리를 전부 채워 무관 지도가 실렸다.
  const fs9 = require("fs");
  fs9.writeFileSync(path.join(WS, "src", "m1.js"), "변경된 내용"); // changedFilesFor가 잡을 실변경
  const c9 = RD.renderV2Slice(WS, {}, "ko", proj, "원격 브랜치 상태만 확인해줘 — 코드 무관");
  ok(c9.text.includes("[Project MAP 동봉 생략]") && c9.mapItems.length === 0, "변경 축만 후보(의도 0)=게이트 발동 — 변경 축이 자리를 채우지 않음(실사고 조건 재현)");
}

console.log("[4b] 재검증 반례 잠금 — 공유 anchor edge 누출·선별 제외 고지 분리");
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mrwirews4b_"));
  mk(WS, "src/shared.js", "leakToken 구현");
  mk(WS, "src/other.js", "무관");
  const proj = {
    ok: true, source: "v2", mapId: "m1",
    nodes: [
      { id: "N0", label: "선별됨", anchors: [{ path: "src/shared.js" }] },
      { id: "N8", label: "미선별-공유anchor", anchors: [{ path: "src/shared.js" }] },
    ],
    edges: [{ id: "E-leak", from: "N8", to: "N0", relation: "should-not-leak" }],
    approved: [], degraded: [], decisions: [],
  };
  const r = RD.renderV2Slice(WS, {}, "ko", proj, "`leakToken` 확인");
  // N0·N8 둘 다 씨앗 축 후보(같은 경로)라 둘 다 선별될 수 있음 — 미선별 상황을 강제하려면 cap을 채운다:
  // 대신 결속 검사 자체를 본다: 선별 발동 시 edge는 '선별된 id'에만 걸린다(경로 역매칭 아님).
  // 검증자 반례 재현: N8은 씨앗 파일(src/s0.js)을 '공유'하지만 첫 경로(zz)가 정렬 끝이라 상한(8) 밖 —
  // 미선별인데 공유 anchor 역매칭이면 E-leak edge가 실린다(id 결속이면 안 실린다).
  const proj2 = {
    ok: true, source: "v2", mapId: "m2",
    nodes: [
      ...Array.from({ length: 9 }, (_, i) => ({ id: "S" + i, label: "씨앗" + i, anchors: [{ path: `src/s${i}.js` }] })),
      { id: "N8", label: "미선별-공유anchor", anchors: [{ path: "src/zz-unselected.js" }, { path: "src/s0.js" }] },
    ],
    // E-leak의 양끝(N8·S8) 모두 미선별 — 경로 역매칭이면 N8이 s0.js 공유로 shownIds에 들어가 실리고,
    // id 결속이면 안 실린다. (선별 노드에 '인접'한 edge는 계약상 정당 표시라 반례가 못 된다)
    edges: [{ id: "E-leak", from: "N8", to: "S8", relation: "should-not-leak" }],
    approved: [], degraded: [], decisions: [],
  };
  for (let i = 0; i < 9; i++) mk(WS, `src/s${i}.js`, "seedTok 구현");
  const r2 = RD.renderV2Slice(WS, {}, "ko", proj2, "`seedTok` 확인");
  ok(r2.mapItems.length === 8 && !r2.mapItems.some((m) => m.note.includes("미선별")), "의도 축 10후보 중 8선별 — N8은 상한 밖(첫 경로 정렬 끝)");
  ok(r2.text.includes("s0.js"), "(전제) 공유 anchor 경로 s0.js는 화면에 실려 있음 — 역매칭이면 누출됐을 조건");
  ok(!r2.text.includes("should-not-leak"), "미선별 노드의 edge는 공유 anchor여도 미동봉(id 결속)");
  // 재확인 지적 반영: S8·N8은 '축 후보인데 cap 탈락' — 상한 생략으로 고지(무축 제외 아님)
  ok(r2.text.includes("상한으로 생략: node 2개"), "cap 탈락 축 후보=상한 생략 고지");
  ok(!r2.text.includes("선별 제외"), "무축 노드 없음 — 선별 제외 고지 없음");
}

console.log("[4c] 빈 후보 조기 반환 — 고지 불소실(정합 점검 blocker 잠금)");
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), "mrwirews4c_"));
  mk(WS, "src/only.js", "내용");
  // 전 노드 부적격(앵커 없음) → eligible 0 → top 0 → 기존 동봉 위임. reqText가 있으면 고지 합류.
  const proj = { ok: true, source: "v2", mapId: "m1", nodes: [{ id: "N0", label: "무앵커", anchors: [] }], edges: [], approved: [], degraded: [], decisions: [] };
  const r = RD.renderV2Slice(WS, {}, "ko", proj, "아무 축에도 안 걸리는 `missingTok` 요청");
  ok(String(r && r.text || "").includes("[Project MAP 동봉 생략]"), "빈 후보+reqText=게이트 발동(기본 동봉 위임으로 새지 않음)");
  mk(WS, "big.js", "x".repeat(600 * 1024));
  const t = RD.renderV2Slice(WS, {}, "ko", proj, "`missingTok` 재요청");
  ok(String(t && t.text || "").includes("씨앗 검색이 상한에 걸려 잘렸다"), "게이트에서도 검색 잘림 고지 실림");
  const noReq = RD.renderV2Slice(WS, {}, "ko", proj);
  ok(!String(noReq && noReq.text || "").includes("선별"), "reqText 부재면 조기 반환 무변(무회귀)");
}

console.log("[5] 생산 경로 잠금 — capsOverride 미전달·배포 편입");
{
  const rd = fs.readFileSync(path.join(ROOT, "bridge", "map-reader.js"), "utf8");
  ok(/MR\.searchSeeds\(target, seeds\)/.test(rd), "searchSeeds 호출=정확히 2인자(테스트 전용 상한 우회 미전달)");
  ok(!/searchSeeds\([^)]*,[^)]*,[^)]*\)/.test(rd), "map-reader에 3인자 searchSeeds 호출 전무");
  ok(fs.readFileSync(path.join(ROOT, "install.js"), "utf8").includes('"map-retrieval.js"'), "install.js 배포 목록 편입");
  ok(fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8").includes('"map-retrieval.js"'), "hook-setup BRIDGE_SCRIPTS 편입");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
