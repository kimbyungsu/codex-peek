"use strict";
/*
 * [RULE-SUPPLY-REDESIGN 묶음 4-나] E10 지도 파일 목록 표기 · E11 일지 갈라짐 표면.
 *  E10: MAP.md·status 의 인벤토리 수치를 '생성 당시(날짜) 기준 — 이후 갱신 안 됨'으로 표기(정본·지문 무변경 — D4 표시 정정만) ·
 *       옛 표기로 렌더된 그대로인 MAP.md 는 수동 수정이 아님(status 는 정보 한 줄) · 표기 변경 전에 준비된 지도 거래를 변경 뒤 복구해도 지문이 맞음.
 *  E11: 이미 있는 병합 후보 계산(computeAliasCandidates)을 대시보드 관찰 신호 줄(갈라진 묶음 수)·정찰 건강 리포트(목록)에 — 자동 병합 없음.
 * 격리: 임시 CODEX_BRIDGE_HOME·임시 저장소 · 확장 산출물(out/extension.js) 조각을 대역으로 실행.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "maplabel_home_"));
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const CL = require("../bridge/contract-lib.js");
const MR = require("../bridge/map-runtime.js");
const MP = require("../bridge/map-pipeline.js");
const MB = require("../bridge/map-bootstrap.js");
const PM = MR.PM;
const LE = require("../out/ledger-events.js");
const OUT = path.join(__dirname, "..", "out", "extension.js");
const src = fs.readFileSync(OUT, "utf8");
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const CLI = path.join(__dirname, "..", "scripts", "scope-map.js");

let n = 0;
const pending = [];
const t = (name, fn) => pending.push([name, fn]);
const mkRepo = (tag) => { const ws = fs.mkdtempSync(path.join(os.tmpdir(), "maplabel_" + tag + "_")); fs.mkdirSync(path.join(ws, "src"), { recursive: true }); fs.writeFileSync(path.join(ws, "src", "a.js"), "// a\n"); return ws; };
const setScoutOn = (ws) => { fs.mkdirSync(CL.CONTRACTS_DIR, { recursive: true }); fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ scoutMode: "on" })); };
const initTopo = (ws) => { const r = MR.initTopologyForBootstrap(ws); assert.strictEqual(r.st, "created"); return MR.readTopoExFor(ws).topo; };
const invLine = (md) => md.split("\n").find((l) => l.includes("인벤토리"));

t("E10 — 새 표기='인벤토리(생성 당시 YYYY-MM-DD 기준 — 이후 갱신 안 됨)' · 옛 표기 판은 종전 그대로 · 날짜 없음=날짜 미상 · 정본 지문 무변경 · 옛/새 둘 다 '정본과 맞음' · 손댄 문서는 아님", () => {
  const ws = mkRepo("label");
  const topo = initTopo(ws);
  const now = PM.renderMapMd(topo), old = PM.renderMapMdLegacy(topo);
  assert.ok(invLine(now).startsWith("- 인벤토리(생성 당시 " + topo.createdAt.slice(0, 10) + " 기준 — 이후 갱신 안 됨): 파일 " + topo.inventory.filesSeen + "개 순회 완료"), invLine(now));
  assert.ok(invLine(old).startsWith("- 인벤토리: 파일 " + topo.inventory.filesSeen + "개 순회 완료"), "옛 표기 판=종전 줄 " + invLine(old));
  assert.deepStrictEqual(now.split("\n").filter((l) => !l.includes("인벤토리")), old.split("\n").filter((l) => !l.includes("인벤토리")), "다른 줄은 같음(인벤토리 줄만 다름)");
  assert.ok(invLine(PM.renderMapMd(Object.assign({}, topo, { createdAt: "" }))).includes("생성 당시 날짜 미상 기준"));
  assert.ok(PM.mapMdMatches(now, topo) && PM.mapMdMatches(old, topo), "둘 다 정본과 맞음");
  assert.ok(!PM.mapMdIsLegacy(now, topo) && PM.mapMdIsLegacy(old, topo), "옛 표기 판별");
  assert.ok(!PM.mapMdMatches(old + "\n낙서\n", topo) && !PM.mapMdIsLegacy(old + "\n낙서\n", topo), "손댄 문서는 어느 쪽도 아님");
  const fp0 = PM.mapHashOf(topo);
  PM.renderMapMd(topo);
  assert.strictEqual(PM.mapHashOf(topo), fp0, "정본 지문 무변경(표시만)");
  assert.strictEqual(fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8"), now, "새로 만드는 지도=새 표기");
});

t("E10 — status: 인벤토리 줄에 '생성 당시 날짜 기준' · 옛 표기 MAP.md=정보 한 줄(불일치 경고 아님) · 손댄 MAP.md=종전 불일치 경고 · render 뒤 둘 다 없음", () => {
  const ws = mkRepo("status");
  const topo = initTopo(ws);
  const run = (...a) => spawnSync(process.execPath, [CLI, ws, ...a], { encoding: "utf8", env: { ...process.env } });
  const mdF = path.join(ws, "project-map", "MAP.md");
  fs.writeFileSync(mdF, PM.renderMapMdLegacy(topo));
  const s1 = run("status");
  assert.strictEqual(s1.status, 0, s1.stderr);
  assert.ok(s1.stdout.includes("인벤토리(생성 당시 " + topo.createdAt.slice(0, 10) + " 기준 — 이후 갱신 안 됨): 파일 " + topo.inventory.filesSeen), s1.stdout);
  assert.ok(/옛 표기/.test(s1.stdout) && !/불일치/.test(s1.stdout), "옛 표기=정보 줄·경고 없음 " + s1.stdout);
  fs.appendFileSync(mdF, "\n수동 낙서\n");
  const s2 = run("status");
  assert.ok(/불일치/.test(s2.stdout) && !/옛 표기/.test(s2.stdout), "손댄 문서=종전 경고");
  assert.strictEqual(run("render").status, 0);
  const s3 = run("status");
  assert.ok(!/불일치/.test(s3.stdout) && !/옛 표기/.test(s3.stdout) && fs.readFileSync(mdF, "utf8") === PM.renderMapMd(topo), "render=새 표기");
  // [구현 검증 4-나 1회차 blocker] 영어 status 도 같은 표기(생성 날짜·이후 갱신 안 됨·날짜 미상) — 옛 표기 정보 줄도 영어로
  assert.ok(CL.saveLang("en"), "(전제) 영어");
  try {
    fs.writeFileSync(mdF, PM.renderMapMdLegacy(topo));
    const e1 = run("status");
    assert.ok(e1.stdout.includes("Inventory (as of creation " + topo.createdAt.slice(0, 10) + " — not updated since): " + topo.inventory.filesSeen + " file(s)"), e1.stdout);
    // 한국어가 없어야 하는 곳=바꾼 표기(인벤토리 줄의 첫 마디)와 옛 표기 정보 줄 — 줄 끝의 신선도 메모는 정본에 저장된 문장이라 종전대로
    const invEn = (e1.stdout.split("\n").find((l) => l.startsWith("Inventory")) || "").split(" · ")[0];
    const oldEn = e1.stdout.split("\n").filter((l) => /older wording/.test(l)).join("");
    assert.ok(oldEn && !/does not match/.test(e1.stdout) && !/[가-힣]/.test(invEn + oldEn), "영어 옛 표기 정보 줄·표기 " + e1.stdout);
    const tp = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "topology.json"), "utf8"));
    assert.ok(/^\d{4}-\d{2}-\d{2}/.test(tp.createdAt), "(전제) 날짜꼴");
  } finally { CL.saveLang("ko"); }
  // 날짜 미상 — 실제 status 를 거치지 않고 같은 문구 규칙만(정본 createdAt 은 스키마상 문자열이라 status 로는 만들기 어려움)
  const rtSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-runtime.js"), "utf8");
  assert.ok(rtSrc.includes('${asOf9 || "날짜 미상"} 기준 — 이후 갱신 안 됨') && rtSrc.includes('${asOf9 || "date unknown"} — not updated since'), "두 언어 모두 날짜 미상 대체");
});

// 지도 거래(WAL) — 표기 변경 전(옛 판)에 준비·적용된 거래를 변경 뒤(새 판) 복구
function mkLivePatch(ws, op, fields) {
  const topo = MR.readTopoExFor(ws).topo;
  const idx = MP.decisionIndexFor(ws, topo.mapId);
  const pol = MP.policyStateFor(ws, topo.mapId);
  const { ah } = MP.authorityOf(PM.mapHashOf(topo), idx);
  const base = { schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: topo.mapId, basis: MP.patchBasisFor(ws, topo), baseMapHash: PM.mapHashOf(topo), baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: op, payload: {}, readSet: {}, rationale: "test", evidence: [{ kind: "code", ref: "src/a.js" }], ...fields };
  base.readSet = MP.buildReadSetFor(topo, base, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
  return { patch: base, topo };
}
function applyUnderOldWording(ws, cond) {
  setScoutOn(ws); MB.grantConsent(ws, "test");
  const topo = initTopo(ws);
  fs.writeFileSync(path.join(ws, "project-map", "MAP.md"), PM.renderMapMdLegacy(topo)); // 옛 판에서 만든 지도 문서
  const mdBefore = fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8");
  const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition: cond } });
  MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
  const keep = PM.renderMapMd;
  PM.renderMapMd = PM.renderMapMdLegacy; // ★옛 판 흉내 — 준비·적용 때 MAP.md 를 옛 표기로 렌더
  let ap; try { ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true }); } finally { PM.renderMapMd = keep; }
  assert.ok(ap.ok, "(전제) 옛 판 적용 " + JSON.stringify(ap).slice(0, 200));
  const d = MP.dirsFor(ws, patch.mapId);
  const wal = JSON.parse(fs.readFileSync(path.join(d.walComplete, ap.decisionId + ".json"), "utf8"));
  return { patch, ap, d, did: ap.decisionId, wal, mdBefore };
}

t("E10 — ★[지도 거래 호환] 옛 판에서 준비된 거래가 MAP.md 쓰기 전에 끊긴 뒤(t7) 새 판으로 복구 → 기대 지문에 맞는 옛 표기로 써서 복구 완료 · 다시 돌려도 혼합 충돌 없음", () => {
  const ws = mkRepo("walt7");
  const { patch, d, did, wal, mdBefore } = applyUnderOldWording(ws, "t7");
  const mdF = path.join(ws, "project-map", "MAP.md");
  assert.strictEqual(sha(fs.readFileSync(mdF, "utf8")), wal.expectedMapMdAfterHash, "(전제) 옛 판 기대 지문=옛 표기 문서");
  // 끊김 재현(t7 ⓪): topology=after 그대로 · MAP.md=before · decision·marker 없음 · WAL 활성
  fs.writeFileSync(mdF, mdBefore);
  fs.unlinkSync(path.join(ws, "project-map", "decisions", did + ".json"));
  fs.unlinkSync(path.join(d.markers, did + ".json"));
  fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
  const r = MP.recoverWal(ws, patch.mapId);
  assert.ok(r.length === 1 && r[0].verdict === "recovered", JSON.stringify(r));
  assert.strictEqual(sha(fs.readFileSync(mdF, "utf8")), wal.expectedMapMdAfterHash, "★복구가 쓴 MAP.md=기대 지문(옛 표기)");
  fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
  const r2 = MP.recoverWal(ws, patch.mapId);
  assert.ok(r2[0].verdict === "recovered", "다시 돌려도 'D 이후 MAP 혼합' 충돌 없음 " + JSON.stringify(r2));
});

t("E10 — ★[지도 거래 호환] 옛 판에서 준비된 거래가 적용 전 상태로 끊긴 뒤(t5 재적용) 새 판으로 복구 → 옛 표기로 재적용·기대 지문 일치", () => {
  const ws = mkRepo("walt5");
  const { patch, d, did, wal, mdBefore } = applyUnderOldWording(ws, "t5");
  const snap = JSON.parse(fs.readFileSync(path.join(d.snapshots, did + ".json"), "utf8"));
  fs.writeFileSync(path.join(ws, "project-map", "topology.json"), PM.canonicalSerialize(snap.topology));
  fs.writeFileSync(path.join(ws, "project-map", "MAP.md"), mdBefore);
  fs.unlinkSync(path.join(ws, "project-map", "decisions", did + ".json"));
  fs.unlinkSync(path.join(d.markers, did + ".json"));
  fs.renameSync(path.join(d.walComplete, did + ".json"), path.join(d.wal, did + ".json"));
  const r = MP.recoverWal(ws, patch.mapId);
  assert.ok(r.length === 1 && r[0].verdict === "recovered", JSON.stringify(r));
  assert.strictEqual(sha(fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8")), wal.expectedMapMdAfterHash, "재적용 MAP.md=기대 지문");
});

t("E10 — 새 판에서 준비된 거래는 그대로 새 표기(복구 쓰기도 새 표기) · 복구 쓰기 자리 두 곳이 같은 함수", () => {
  const ws = mkRepo("walnew");
  setScoutOn(ws); MB.grantConsent(ws, "test");
  const topo = initTopo(ws);
  const { patch } = mkLivePatch(ws, "add_condition", { targetId: topo.nodes[0].id, payload: { condition: "n" } });
  MP.proposePatch(ws, patch); MP.classifyPatch(ws, patch.mapId, patch.patchId);
  const ap = MP.applyPatch(ws, patch.mapId, patch.patchId, { preCutover: true });
  assert.ok(ap.ok);
  const md = fs.readFileSync(path.join(ws, "project-map", "MAP.md"), "utf8");
  assert.ok(/생성 당시 .* 기준 — 이후 갱신 안 됨/.test(invLine(md)) && md === PM.renderMapMd(MR.readTopoExFor(ws).topo));
  const ps = fs.readFileSync(path.join(__dirname, "..", "bridge", "map-pipeline.js"), "utf8");
  assert.strictEqual((ps.match(/renderMapMdForExpected\(/g) || []).length, 3, "정의 1+사용 2(writeM·t5 재적용)");
  assert.ok(!/const txt = PM\.renderMapMd\(rt\.topo\)/.test(ps) && !/const md5 = PM\.renderMapMd\(/.test(ps), "복구 쓰기 자리에 직접 렌더 남지 않음");
});

// ── E11 ──
const ev = (type, text, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), type, sig: CL.ledgerSig(text), text, from: "test" });
function ledgerOf(lines) { return LE.deriveLedger(LE.parseEventsJsonl(lines.join("\n")).events); }

t("E11 — 병합 후보 계산: 같은 끝점·같은 방향의 다른 문장=한 묶음 · 방향이 다르면 다른 묶음 · 경로 1개·차단 항목은 제외 · 확장 상태에 그 결과가 실림(배선)", () => {
  const d = ledgerOf([
    ev("proposed", "bridge/a.js ↔ bridge/b.js 저장 형식 결합", 1),
    ev("proposed", "bridge/b.js ↔ bridge/a.js 판독 규칙이 같아야 함", 2),
    ev("proposed", "bridge/a.js → bridge/c.js 호출", 3),
    ev("proposed", "bridge/c.js → bridge/a.js 역방향", 4),
    ev("proposed", "bridge/a.js 단독 메모", 5),
  ]);
  const g = LE.computeAliasCandidates(d);
  assert.strictEqual(g.length, 1, JSON.stringify(g));
  assert.strictEqual(g[0].texts.length, 2);
  const ts = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(ts.includes("aliasGroups: computeAliasCandidates(derived).map((g) => ({ n: g.texts.length, texts: g.texts.slice(0, 4).map((x) => String(x || \"\").slice(0, 160)) })),"), "확장 상태 배선");
  assert.ok(!/alias.*appendLedgerEvent|appendLedgerEvent.*alias/.test(ts), "자동 병합(alias 사건 기록) 없음");
});

const mkEl = (tag) => ({ tag, children: [], style: {}, attrs: {}, textContent: "", className: "", title: "", innerHTML: "", appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; } });
const textOf = (root) => { const out = []; const w = (x) => { out.push(x.textContent || ""); (x.children || []).forEach(w); }; w(root); return out.join(""); };

t("E11 — 대시보드 관찰 신호 줄: 갈라진 묶음이 있으면 '갈라진 묶음 N' 칩(설명=자동으로 합치지 않음) · 표본이 작아도 · 없으면 칩 없음 — 확장 산출물 실행", () => {
  const i = src.indexOf("        const h=ml.health; if(!h||!h.entries) return;");
  const start = src.lastIndexOf("safe(function(){", i);
  const end = src.indexOf("\n      // 건강 리포트 새탭", i);
  assert.ok(i > 0 && start > 0 && end > i, "조각");
  const run = (entries, groups) => {
    const card = mkEl("div");
    const ml = { health: { entries, verified: 1, reusedDen: 0, reusedNum: 0, autoDen: 0, autoNum: 0, reinterpreted: 0, disputedEntries: 0, rehabilitated: 0 }, aliasGroups: groups };
    new Function("document", "T", "ml", "card", "safe", src.slice(start, end))({ createElement: mkEl, createTextNode: (x) => Object.assign(mkEl("#text"), { textContent: String(x) }) }, (ko) => ko, ml, card, (f) => f());
    return card;
  };
  const big = run(8, [{ n: 2, texts: ["a", "b"] }, { n: 3, texts: ["c", "d", "e"] }]);
  assert.ok(/갈라진 묶음 2/.test(textOf(big)), textOf(big));
  const chip = JSON.stringify(big).includes("자동으로 합치지 않습니다");
  assert.ok(chip, "설명");
  const small = run(3, [{ n: 2, texts: ["a", "b"] }]);
  assert.ok(/표본 아직 작음/.test(textOf(small)) && /갈라진 묶음 1/.test(textOf(small)), "표본이 작아도 묶음 수 " + textOf(small));
  assert.ok(!/갈라진 묶음/.test(textOf(run(8, []))), "없으면 칩 없음");
});

t("E11 — 정찰 건강 리포트: 갈라진 묶음 목록(묶음당 앞 4문장 · 20묶음 상한 · 글자 이스케이프 · 자동으로 합치지 않음) · 없으면 '없음' — 확장 산출물 실행", () => {
  const body = src.slice(src.indexOf("function openScoutHealthReport("), src.indexOf("\n// 두뇌 '실제 답' 평시 정보 문구"));
  assert.ok(body.length > 100, "조각");
  const run = (groups) => {
    let html = "";
    const vscode = { window: { showInformationMessage() {}, showWarningMessage() {}, createWebviewPanel: () => ({ webview: { set html(v) { html = v; }, get html() { return html; } } }) }, ViewColumn: { Beside: 2 } };
    const ml = { health: { entries: 0 }, timeline: [], dropped: 0, aliasGroups: groups };
    new Function("vscode", "tE", "readMapLedgerUncached", "effectiveScoutGate", "scoutTargetFor", "normWs", "ledger_events_1", "bridgeCmd", body + "\nreturn openScoutHealthReport;")(vscode, (ko) => ko, () => ml, () => ({ eff: "plan", raw: null }), () => ({ repo: "C:/r" }), (x) => x, LE, () => "node bridge")("C:/r");
    return html;
  };
  const many = Array.from({ length: 22 }, (_, k) => ({ n: k === 0 ? 6 : 2, texts: k === 0 ? ["<script>x</script> a.js ↔ b.js", "2", "3", "4"] : ["x", "y"] }));
  const h = run(many);
  assert.ok(/갈라진 묶음 — 같은 연결이 다른 문장으로 따로 쌓임/.test(h) && /묶음 22개/.test(h) && /자동으로 합치지 않습니다/.test(h), "머리·설명");
  assert.ok(h.includes("&lt;script&gt;") && !h.includes("<script>x"), "이스케이프");
  assert.ok(/… 외 2건/.test(h) && /… 외 2묶음/.test(h), "묶음 안 나머지·20묶음 상한 고지");
  assert.strictEqual((h.match(/<tr><td class="ty">\d+건<\/td>/g) || []).length, 20, "20묶음까지만");
  assert.ok(/없음 — 같은 연결이 다른 문장으로 따로 쌓인 묶음이 없어요/.test(run([])), "없음");
});

(async () => {
  for (const [name, fn] of pending) { n++; await fn(); console.log(`  ✅ [${n}] ${name}`); }
  console.log(`\n결과: ${n}/${pending.length} 통과`);
})().catch((e) => { console.error(e); process.exit(1); });
