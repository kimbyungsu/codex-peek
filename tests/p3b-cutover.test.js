"use strict";
/*
 * P3b 증분 2 — cutover 명령 본체 (설계 동결: docs/MAP-P3B-DESIGN.md §C·§E cutover 부분).
 * 계약: C-1 게이트(scoutMode·권위 분기·manifest·topology·WAL·미이관 N·스냅샷·배포 세대·quiescence) /
 * C-2 잠금 안 재검사+frozen-fp 'receipt 직전'→receipt→marker→read-back→C-5 배너 / C-3 재개(승인 조건만
 * 생략) / v2 멱등+tail 보충(플래그 선행·흡수 금지) / B-1 frozen probe(지문 대조=경보 축·미이관=정보 배지) /
 * 자동 적용(v2 무플래그·preCutover 필드 생략)은 기존 p3b-stage1이 소유 — 여기선 cutover 산 v2로 실측.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "p3bc_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const MR = require(path.join(ROOT, "bridge", "map-runtime.js"));
const MP = require(path.join(ROOT, "bridge", "map-pipeline.js"));
const MB = require(path.join(ROOT, "bridge", "map-bindings.js"));
const MBoot = require(path.join(ROOT, "bridge", "map-bootstrap.js"));
const CO = require(path.join(ROOT, "bridge", "map-cutover.js"));
const PM = MR.PM;

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const sha = (t) => crypto.createHash("sha1").update(t).digest("hex");

// 배포 사본 준비(C-1 7 통과 재료): BRIDGE_SCRIPTS 전체를 홈에 복사(레포와 바이트 동일)
const LIST = require(path.join(ROOT, "install.js")).BRIDGE_SCRIPTS;
for (const f of LIST) fs.copyFileSync(path.join(ROOT, "bridge", f), path.join(process.env.CODEX_BRIDGE_HOME, f));

function mkWs(tag, opts) {
  const o = opts || {};
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p3bc_" + tag + "_"));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "a.js"), "console.log(1);\n");
  if (o.track3 !== false) {
    fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "ko")), { recursive: true });
    fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, scoutMode: "on" }));
    MBoot.grantConsent(ws, "test");
    if (MR.initTopologyForBootstrap(ws).st !== "created") throw new Error("init 실패");
  }
  return ws;
}
const ledgerLine = (text, date, from) => "- " + text + "  <!-- 승인 " + date + " · 출처: " + from + " -->";
// validBindingRec 정확 계약(BINDING_KEYS 10키·legacy-map origin·entryFp 재계산 결속)에 맞는 실물 binding 조립
function mkBinding(ws, rel, row, sig, targetId) {
  const srcFp = sha(fs.readFileSync(path.join(ws, rel), "utf8"));
  return { sig, endpointsKey: null, kind: "node", origin: { kind: "legacy-map", sourceRel: rel, sourceFp: srcFp },
    originals: [{ text: row.text, date: row.date, from: row.from, entryFp: MB.entryFpLegacy(row) }],
    rebound: [], source: "user-confirmed", targetId, candidateFp: sha("cand"), ts: "2026-07-03T00:00:00.000Z" };
}
function runCut(ws, args) { // runCli 경유(콘솔 캡처 — 자식 프로세스)
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, "scripts", "scope-map.js"), ws, "cutover", ...(args || [])], { encoding: "utf8", env: { ...process.env } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

console.log("[1] 게이트 — 2트랙·quiescence·topology·manifest");
{
  const ws0 = mkWs("g0", { track3: false });
  const r0 = runCut(ws0, ["--confirm-windows-reloaded"]);
  ok(r0.code === 2 && /3트랙|3-track/.test(r0.out), "2트랙=거부(최선행)");
  ok(!fs.existsSync(path.join(ws0, "project-map")), "2트랙=파일 생성 0");
  const ws1 = mkWs("g1");
  const r1 = runCut(ws1, []);
  ok(r1.code === 2 && /--confirm-windows-reloaded/.test(r1.out) && /지속 약속|ongoing commitment/.test(r1.out), "quiescence 플래그 부재=거부+지속 약속 문구");
  ok(/구세대 writer|old-generation writer/.test(r1.out) && /cutover 완료|cutover completes/.test(r1.out), "안내가 전체 지속 조건 포함(6차 #2 문구 잠금)");
  // topology 손상=거부
  const topoF = path.join(ws1, "project-map", "topology.json");
  const orig = fs.readFileSync(topoF, "utf8");
  fs.writeFileSync(topoF, "null", "utf8");
  const r2 = runCut(ws1, ["--confirm-windows-reloaded"]);
  ok(r2.code === 1 && /topology/.test(r2.out), "비객체 topology=거부");
  fs.writeFileSync(topoF, orig, "utf8");
}

console.log("[2] 성공 경로 — receipt→marker 순서·read-back·스냅샷·frozen-fp·배너·보고");
{
  const ws = mkWs("okp");
  // legacy 확정층 2행(1행은 binding 결속·1행은 미이관) 구성
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  const L1 = ledgerLine("결합확인 src/a.js는 진입점  ", "2026-07-01", "verify");
  const L2 = ledgerLine("미이관 항목 문구", "2026-07-02", "verify");
  fs.writeFileSync(path.join(ws, "docs", "MAP.md"), L1 + "\n" + L2 + "\n", "utf8");
  const topo = MR.readTopoExFor(ws).topo;
  // L1을 binding으로 결속(수동 구성 — validBindingRec 계약 준수)
  const e1 = { text: "결합확인 src/a.js는 진입점  ".trim(), date: "2026-07-01", from: "verify" };
  // parseApprovedCopy는 trim된 text를 주므로 실제 파싱 결과로 확인
  const parsed = MB.parseApprovedCopy(fs.readFileSync(path.join(ws, "docs", "MAP.md"), "utf8"));
  ok(parsed.approved.length === 2, "(전제) 확정층 2행 파싱");
  const row1 = parsed.approved[0];
  const sig1 = CL.ledgerSig(row1.text);
  fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ schema: "map-bindings-v1", mapId: topo.mapId, bindings: [mkBinding(ws, "docs/MAP.md", row1, sig1, topo.nodes[0].id)] }, null, 1), "utf8");
  ok(MB.readBindingsFor(ws, topo.mapId).st === "ok", "(전제) bindings 유효");
  // 미이관 1건 → 무플래그 거부·정확 수만 통과
  const rA = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(rA.code === 1 && /--confirm-unmigrated 1/.test(rA.out) && /unbound|entry-diverged/.test(rA.out), "미이관 N=1 무확인=거부+목록(사유)");
  const rB = runCut(ws, ["--confirm-windows-reloaded", "--confirm-unmigrated", "2"]);
  ok(rB.code === 1, "오수(2)=거부(정확 수 일치 요구)");
  const rC = runCut(ws, ["--confirm-windows-reloaded", "--confirm-unmigrated", "1"]);
  ok(rC.code === 0 && /cutover 완결|cutover complete/.test(rC.out), "정확 수(1)=성공: " + rC.out.split("\n")[0]);
  ok(/리로드 필수|Reload every/.test(rC.out), "성공 보고에 전 창 리로드 고지");
  // 산출물: marker·receipt·상호 결속
  const marker = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "authority.json"), "utf8"));
  ok(marker.schema === "map-authority-v1" && marker.cutover === true && marker.mapId === topo.mapId, "marker 형식·mapId 결속");
  const rec = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "authority-history", marker.decisionRef + ".json"), "utf8"));
  ok(MB.validReceipt(rec, marker.decisionRef + ".json") && rec.authorityFileFp === sha(JSON.stringify(marker, null, 1)), "receipt 유효+marker 지문 결속(receipt→marker 순서의 증명)");
  ok(MB.authorityStateFor(ws).st === "v2", "read-back: 권위=v2");
  // 스냅샷·frozen-fp
  const sdir = CO.snapDirFor(ws, marker.decisionRef);
  ok(fs.existsSync(path.join(sdir, "topology.json")) && fs.existsSync(path.join(sdir, "manifest.json")), "스냅샷 실존(topology·manifest)");
  const fro = JSON.parse(fs.readFileSync(path.join(sdir, "frozen-ledger-fp.json"), "utf8"));
  const nowText = fs.readFileSync(path.join(ws, "docs", "MAP.md"), "utf8");
  ok(CO.bannerPresent(nowText), "C-5 동결 배너 삽입");
  ok(fro.fp === sha(Buffer.from(nowText, "utf8").toString("binary") === nowText ? nowText : nowText), "frozen-fp=배너 삽입 후 최종 바이트 지문(정합)");
  ok(fro.fp === crypto.createHash("sha1").update(Buffer.from(nowText, "utf8")).digest("hex"), "지문 바이트 정확(버퍼 기준)");
  // 멱등(2회차=no-op·배너 중복 없음)
  const r2 = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(r2.code === 0 && /이미 전환됨|Already cut over/.test(r2.out), "멱등 no-op");
  ok(fs.readFileSync(path.join(ws, "docs", "MAP.md"), "utf8") === nowText, "배너 멱등(중복 삽입 없음)");
  // probe: ok → 변조 4종=violated → 정보 배지
  const p0 = CO.frozenLedgerProbeFor(ws);
  ok(p0.state === "ok" && p0.unmigratedTotal === 1, "probe=ok+미이관 정보 배지 1");
  const frozenText = nowText;
  const variants = [
    ["행 추가", frozenText + ledgerLine("후발 추가", "2026-07-04", "x") + "\n"],
    ["결속 행 재기록", frozenText.replace("진입점", "진입점 수정")],
    ["행 삭제", frozenText.split("\n").filter((l) => !l.includes("미이관")).join("\n")],
    ["동수 치환", frozenText.replace("미이관 항목 문구", "동수치환 항목 문구")],
  ];
  for (const [tag, txt] of variants) {
    fs.writeFileSync(path.join(ws, "docs", "MAP.md"), txt, "utf8");
    ok(CO.frozenLedgerProbeFor(ws).state === "violated", "probe 동결 위반 — " + tag + "(5차 #1 반례 전수)");
  }
  fs.writeFileSync(path.join(ws, "docs", "MAP.md"), frozenText, "utf8");
  ok(CO.frozenLedgerProbeFor(ws).state === "ok", "(대조) 원문 복원=ok(지문 재일치)");
  // 기준선 판독 실패='기준선 불명'(경보 억제 없음·위장 없음)
  const fpFile = path.join(sdir, "frozen-ledger-fp.json");
  const fpRaw = fs.readFileSync(fpFile, "utf8");
  fs.writeFileSync(fpFile, "{corrupt", "utf8");
  ok(CO.frozenLedgerProbeFor(ws).state === "baseline-unknown", "기준선 손상='기준선 불명' 경고(억제·위장 없음)");
  fs.writeFileSync(fpFile, fpRaw, "utf8");
  // cutover 후 자동 적용: v2 무플래그 apply 통과+preCutover 필드 부재(C-4)
  {
    const t2 = MR.readTopoExFor(ws).topo;
    const idx = MP.decisionIndexFor(ws, t2.mapId), pol = MP.policyStateFor(ws, t2.mapId);
    const { ah } = MP.authorityOf(PM.mapHashOf(t2), idx);
    const patch = { schema: "map-patch-v2", patchId: crypto.randomUUID(), mapId: t2.mapId, basis: MP.patchBasisFor(ws, t2), baseMapHash: PM.mapHashOf(t2), baseAuthorityHash: ah, baseDecisionContextHash: PM.decisionContextHashOf(ah, pol.pfh), baseDirtyFp: "", operation: "add_condition", targetId: t2.nodes[0].id, payload: { condition: "post-cutover" }, readSet: {}, rationale: "t", evidence: [{ kind: "code", ref: "src/a.js" }] };
    patch.readSet = MP.buildReadSetFor(t2, patch, { idx, pol, repoRoot: ws, fileHashOf: (ref) => { try { return sha(fs.readFileSync(path.join(ws, ref), "utf8")); } catch { return null; } } });
    MP.proposePatch(ws, patch); MP.classifyPatch(ws, t2.mapId, patch.patchId);
    const ap = MP.applyPatch(ws, t2.mapId, patch.patchId, {}); // 무플래그
    ok(ap.ok === true, "cutover 후 무플래그 apply 통과(자동 적용 활성화 1-30): " + (ap.error || ""));
    const dec = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "decisions", ap.decisionId + ".json"), "utf8"));
    ok(!("preCutover" in dec), "decision에 preCutover 필드 부재(v2 무플래그 — validator '부재=cutover 후' 정합)");
  }
}

console.log("[3] tail 내구(6차 #1·7차 #1) — marker 성공·배너 전 중단 재현");
{
  const ws = mkWs("tail");
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "docs", "MAP.md"), ledgerLine("유일 결속 행", "2026-07-01", "v") + "\n", "utf8");
  const topo = MR.readTopoExFor(ws).topo;
  const row = MB.parseApprovedCopy(fs.readFileSync(path.join(ws, "docs", "MAP.md"), "utf8")).approved[0];
  const sig = CL.ledgerSig(row.text);
  fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ schema: "map-bindings-v1", mapId: topo.mapId, bindings: [mkBinding(ws, "docs/MAP.md", row, sig, topo.nodes[0].id)] }, null, 1), "utf8");
  const r = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(r.code === 0, "(전제) cutover 성공");
  // 중단 재현: 배너를 제거해 'marker 성공·배너 전 종료' 상태로 되돌림(기준선은 배너 포함 지문)
  const led = path.join(ws, "docs", "MAP.md");
  const withBanner = fs.readFileSync(led, "utf8");
  const noBanner = withBanner.split("\n").slice(1).join("\n");
  fs.writeFileSync(led, noBanner, "utf8");
  // 플래그 부재=쓰기 0(안내만)
  const rNo = runCut(ws, []);
  ok(rNo.code === 0 && /미완 tail|Incomplete tail/.test(rNo.out), "플래그 부재=보충 없이 안내만");
  ok(fs.readFileSync(led, "utf8") === noBanner, "쓰기 0 실측");
  // 플래그 동반=잠금 안 결정론 보충+지문 정합
  const rYes = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(rYes.code === 0 && /배너 보충 완료|banner completed/.test(rYes.out), "플래그 동반=배너 결정론 보충");
  ok(fs.readFileSync(led, "utf8") === withBanner, "보충 결과=원 기준선 바이트(지문 정합)");
  // 기준선 부재 중 변경=흡수 금지(경보 안내)
  const marker = JSON.parse(fs.readFileSync(path.join(ws, "project-map", "authority.json"), "utf8"));
  const fpFile = path.join(CO.snapDirFor(ws, marker.decisionRef), "frozen-ledger-fp.json");
  const fpRaw = fs.readFileSync(fpFile, "utf8");
  fs.unlinkSync(fpFile);
  fs.writeFileSync(led, noBanner + "변조\n", "utf8");
  const rAb = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(rAb.code === 0 && /기준선 불명|baseline unknown/.test(rAb.out), "기준선 부재=현재 바이트 흡수 금지·안내만(6차 #1)");
  ok(/변조/.test(fs.readFileSync(led, "utf8")) && !CO.bannerPresent(fs.readFileSync(led, "utf8")), "흡수 금지 실측(파일 무변경)");
  fs.writeFileSync(fpFile, fpRaw, "utf8");
  // 기준선 존재+바이트 상이=동결 위반 경보·보충 없음
  const rMis = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(rMis.code === 0 && /동결 위반|freeze violation/i.test(rMis.out), "지문 불일치=동결 위반 경보(흡수 금지)");
  fs.writeFileSync(led, noBanner, "utf8");
  ok(runCut(ws, ["--confirm-windows-reloaded"]).code === 0 && fs.readFileSync(led, "utf8") === withBanner, "(대조) 원문 복원=보충 재성공");
}

console.log("[4] 재개(C-3) — receipt-only에서 marker 보충+배너 완결·손상/복수 receipt=거부");
{
  const ws = mkWs("resume");
  fs.mkdirSync(path.join(ws, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ws, "docs", "MAP.md"), ledgerLine("재개 픽스처 행", "2026-07-01", "v") + "\n", "utf8");
  {
    const topo = MR.readTopoExFor(ws).topo;
    const row = MB.parseApprovedCopy(fs.readFileSync(path.join(ws, "docs", "MAP.md"), "utf8")).approved[0];
    fs.writeFileSync(MB.bindingsFileFor(ws), JSON.stringify({ schema: "map-bindings-v1", mapId: topo.mapId, bindings: [mkBinding(ws, "docs/MAP.md", row, CL.ledgerSig(row.text), topo.nodes[0].id)] }, null, 1), "utf8");
  }
  const r = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(r.code === 0, "(전제) cutover 성공(확정층 결속 1행·미이관 0)");
  const markerF = path.join(ws, "project-map", "authority.json");
  const marker = JSON.parse(fs.readFileSync(markerF, "utf8"));
  const ledF = path.join(ws, "docs", "MAP.md");
  const withBanner = fs.readFileSync(ledF, "utf8");
  ok(CO.bannerPresent(withBanner), "(전제) 배너 삽입됨");
  // 미배너 receipt-only 중단 재현(1차 blocker③ 검출 픽스처): marker 삭제+배너 제거
  fs.unlinkSync(markerF);
  fs.writeFileSync(ledF, withBanner.split("\n").slice(1).join("\n"), "utf8");
  ok(MB.authorityStateFor(ws).st === "blocked", "(전제) receipt-only=blocked");
  const r2 = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(r2.code === 0 && /재개 완결|resumed & completed/.test(r2.out), "재개=marker 보충 완결");
  const marker2 = JSON.parse(fs.readFileSync(markerF, "utf8"));
  ok(marker2.decisionRef === marker.decisionRef, "새 receipt 미생성(기존 decisionId 재사용)");
  ok(MB.authorityStateFor(ws).st === "v2", "재개 read-back=v2(잠금 안 판정)");
  ok(fs.readFileSync(ledF, "utf8") === withBanner, "재개가 C-5 배너까지 완결(1차 blocker③ — 미배너 잔존 소멸)");
  ok(CO.frozenLedgerProbeFor(ws).state === "ok", "재개 직후 probe=ok(동결 위반 오경보 없음)");
  // 손상 receipt 공존=거부(1차 blocker② — 유효 1개여도 손상 존재는 거부: 자동 선택·삭제 금지)
  fs.unlinkSync(markerF);
  const histD = path.join(ws, "project-map", "authority-history");
  fs.writeFileSync(path.join(histD, crypto.randomUUID() + ".json"), "{corrupt", "utf8");
  {
    const rC2 = runCut(ws, ["--confirm-windows-reloaded"]);
    ok(rC2.code === 1 && /손상 1|corrupt 1/.test(rC2.out), "유효 1+손상 1=거부(손상 무시 금지)");
    for (const f9 of fs.readdirSync(histD)) if (!MB.validReceipt((() => { try { return JSON.parse(fs.readFileSync(path.join(histD, f9), "utf8")); } catch { return null; } })(), f9)) fs.unlinkSync(path.join(histD, f9));
    ok(runCut(ws, ["--confirm-windows-reloaded"]).code === 0, "(대조) 손상 제거(수동)=재개 성공");
    fs.unlinkSync(markerF); // 다음 반례 준비
  }
  // 복수 유효 receipt=거부(자동 선택 금지)
  const hist = path.join(ws, "project-map", "authority-history");
  const otherId = crypto.randomUUID();
  const ao2 = { schema: "map-authority-v1", cutover: true, mapId: marker.mapId, decisionRef: otherId, ts: new Date().toISOString() };
  const rec2 = { schema: "map-cutover-receipt-v1", decisionId: otherId, mapId: marker.mapId, authorityMode: { from: "legacy", to: "v2" }, authorityObject: ao2, authorityFileFp: sha(JSON.stringify(ao2, null, 1)), ts: ao2.ts };
  fs.writeFileSync(path.join(hist, otherId + ".json"), JSON.stringify(rec2, null, 1), "utf8");
  const r3 = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(r3.code === 1 && /재개 조건 불충족|resume conditions unmet/.test(r3.out) && /2/.test(r3.out), "복수 유효 receipt=거부(자동 선택·삭제 금지)");
  fs.unlinkSync(path.join(hist, otherId + ".json"));
  ok(runCut(ws, ["--confirm-windows-reloaded"]).code === 0, "(대조) 단일 receipt 복귀=재개 성공");
}

console.log("[5] 잠금 안 재검사·배포 세대·manifest 스텁");
{
  // 배포 세대: 사본 1개 변조=거부(잠금 밖 1차에서 걸림 — 안내 문구)
  const ws = mkWs("gen");
  const target = path.join(process.env.CODEX_BRIDGE_HOME, "map-reader.js");
  const keep = fs.readFileSync(target);
  fs.writeFileSync(target, Buffer.concat([keep, Buffer.from("\n// stale\n")]));
  const r = runCut(ws, ["--confirm-windows-reloaded"]);
  ok(r.code === 1 && /배포 사본 세대|deployed copy generation/.test(r.out) && /install\.js/.test(r.out), "배포 사본 불일치=거부+install 안내");
  fs.writeFileSync(target, keep);
  // manifest ready 스텁: REQUIRED_SURFACES에 잉여 표면 주입 → 집합 불일치 거부
  const AD = require(path.join(ROOT, "bridge", "map-adapters.js"));
  AD.REQUIRED_SURFACES.push({ id: "stub-extra", ownerPhase: "PX", legacyFile: "x", legacyFn: "x", v2: null });
  const sc = CO.safetyChecks(ws);
  AD.REQUIRED_SURFACES.pop();
  ok(!!sc.fail && /manifest/.test(sc.fail), "manifest 표면 집합 불일치=거부(스텁 주입 — 직접 함수 축)");
  ok(!CO.safetyChecks(ws).fail, "(대조) 원복=통과");
  { // ready=false(E절 명시): 기존 표면의 v2 함수명을 임시로 미존재로 변조 → 집합 일치·ready=false → 거부
    const keepV2 = AD.REQUIRED_SURFACES[0].v2;
    AD.REQUIRED_SURFACES[0].v2 = "__missing_fn__";
    const scR = CO.safetyChecks(ws);
    AD.REQUIRED_SURFACES[0].v2 = keepV2;
    ok(!!scR.fail && /ready/.test(scR.fail), "manifest ready=false=거부(스텁 — E절)");
    ok(!CO.safetyChecks(ws).fail, "(대조) 원복=통과");
  }
  { // 활성 WAL=거부(E절): 파이프라인 WAL 서랍에 활성 파일 주입
    const MPx = require(path.join(ROOT, "bridge", "map-pipeline.js"));
    const topoW = MR.readTopoExFor(ws).topo;
    const dW = MPx.ensureDirs(ws, topoW.mapId);
    const wid = crypto.randomUUID();
    fs.writeFileSync(path.join(dW.wal, wid + ".json"), "{}", "utf8");
    const scW = CO.safetyChecks(ws);
    fs.unlinkSync(path.join(dW.wal, wid + ".json"));
    ok(!!scW.fail && /WAL/.test(scW.fail), "활성 WAL=거부(recoverWal 안내)");
  }
  { // 비UUID mapId=거부(E절 — validateTopology 관문·별도 UUID 검사 이중)
    const topoF9 = path.join(ws, "project-map", "topology.json");
    const raw9 = fs.readFileSync(topoF9, "utf8");
    fs.writeFileSync(topoF9, raw9.replace(/"mapId": ?"[0-9a-f-]+"/, '"mapId": "not-a-uuid"'), "utf8");
    const scU = CO.safetyChecks(ws);
    fs.writeFileSync(topoF9, raw9, "utf8");
    ok(!!scU.fail && /mapId|UUID|스키마|schema/i.test(scU.fail), "비UUID mapId=거부");
  }
  { // 스냅샷 후 원문 변경=잠금 안 재검사 중단(E절 TOCTOU — afterSnapshot 주입점·프로덕션 분기 없음)
    const wsT9 = mkWs("toctou");
    fs.mkdirSync(path.join(wsT9, "docs"), { recursive: true });
    fs.writeFileSync(path.join(wsT9, "docs", "MAP.md"), ledgerLine("toctou 행", "2026-07-01", "v") + "\n", "utf8");
    const topo9 = MR.readTopoExFor(wsT9).topo;
    const row9 = MB.parseApprovedCopy(fs.readFileSync(path.join(wsT9, "docs", "MAP.md"), "utf8")).approved[0];
    fs.writeFileSync(MB.bindingsFileFor(wsT9), JSON.stringify({ schema: "map-bindings-v1", mapId: topo9.mapId, bindings: [mkBinding(wsT9, "docs/MAP.md", row9, CL.ledgerSig(row9.text), topo9.nodes[0].id)] }, null, 1), "utf8");
    const code9 = CO.runCutover(wsT9, { confirmWindowsReloaded: true, confirmUnmigrated: null }, {
      afterSnapshot: () => { fs.appendFileSync(path.join(wsT9, "docs", "MAP.md"), ledgerLine("스냅샷 후 침입", "2026-07-02", "x") + "\n"); },
    });
    ok(code9 === 1, "스냅샷 후 확정층 변경=잠금 안 재검사 중단(TOCTOU 봉합 실측)");
    ok(!fs.existsSync(path.join(wsT9, "project-map", "authority.json")), "중단=marker 미기록(아무것도 전환되지 않음)");
    ok(CO.runCutover(wsT9, { confirmWindowsReloaded: true, confirmUnmigrated: null }) === 1, "재실행=침입 행이 미이관 1로 잡혀 정확 수 재확인 요구(항상참 단언 제거 — 2차 [보완])");
    ok(CO.runCutover(wsT9, { confirmWindowsReloaded: true, confirmUnmigrated: 1 }) === 0, "(대조) 정확 수 동의=재실행 성공(재실행 가능 상태 실증)");
  }
  { // 2차 blocker②-ⓐ: 재개 잠금 경합 — 사전 판별 후·잠금 전 marker 출현=잠금 안 재검사 중단
    const wsR2 = mkWs("race2");
    const rOk = runCut(wsR2, ["--confirm-windows-reloaded"]);
    ok(rOk.code === 0, "(전제) cutover 성공");
    const mF = path.join(wsR2, "project-map", "authority.json");
    const mRaw = fs.readFileSync(mF, "utf8");
    fs.unlinkSync(mF); // receipt-only
    const code = CO.runCutover(wsR2, { confirmWindowsReloaded: true, confirmUnmigrated: null }, {
      afterEligibility: () => { fs.writeFileSync(mF, mRaw, "utf8"); }, // 경합 주입: 판별 후 marker 출현
    });
    ok(code === 1, "재개 조건 변동(잠금 안 재검사)=중단(2차 blocker② 경합 실측)");
    ok(MB.authorityStateFor(wsR2).st === "v2", "(사후) 출현한 marker가 정본으로 유지(이중 기록 없음)");
  }
  { // 2차 blocker①: 재개 중 확정층 소실(기준선=존재형) — 경보와 함께 성공(침묵 성공 소멸)
    const wsV9 = mkWs("vanish");
    fs.mkdirSync(path.join(wsV9, "docs"), { recursive: true });
    fs.writeFileSync(path.join(wsV9, "docs", "MAP.md"), ledgerLine("소실 픽스처", "2026-07-01", "v") + "\n", "utf8");
    const topoV = MR.readTopoExFor(wsV9).topo;
    const rowV = MB.parseApprovedCopy(fs.readFileSync(path.join(wsV9, "docs", "MAP.md"), "utf8")).approved[0];
    fs.writeFileSync(MB.bindingsFileFor(wsV9), JSON.stringify({ schema: "map-bindings-v1", mapId: topoV.mapId, bindings: [mkBinding(wsV9, "docs/MAP.md", rowV, CL.ledgerSig(rowV.text), topoV.nodes[0].id)] }, null, 1), "utf8");
    ok(runCut(wsV9, ["--confirm-windows-reloaded"]).code === 0, "(전제) cutover 성공(존재형 기준선)");
    fs.unlinkSync(path.join(wsV9, "project-map", "authority.json"));
    fs.unlinkSync(path.join(wsV9, "docs", "MAP.md")); // 재개 전 확정층 소실
    const rV = runCut(wsV9, ["--confirm-windows-reloaded"]);
    ok(rV.code === 0 && /사라짐|vanished/.test(rV.out), "재개 성공하되 '확정층 사라짐(기준선=존재)' 경보 동반(침묵 성공 소멸 — 2차 blocker①)");
    // 3차 blocker: parse 가능한 손상 기준선({})+확정층 부재 재개=조건 없이 '기준선 불명' 경고(침묵 소멸·probe와 동형)
    fs.unlinkSync(path.join(wsV9, "project-map", "authority.json"));
    const mk3 = JSON.parse(fs.readFileSync(path.join(wsV9, "project-map", "authority-history", fs.readdirSync(path.join(wsV9, "project-map", "authority-history"))[0]), "utf8"));
    fs.writeFileSync(path.join(CO.snapDirFor(wsV9, mk3.decisionId), "frozen-ledger-fp.json"), "{}", "utf8");
    const rB3 = runCut(wsV9, ["--confirm-windows-reloaded"]);
    ok(rB3.code === 0 && /기준선 불명|baseline unknown/.test(rB3.out), "손상(parse 가능) 기준선+확정층 부재=기준선 불명 경고 동반(3차 blocker 소멸)");
  }
  { // 2차 blocker②-ⓑ: 영문 quiescence 전체 지속 조건 문구(en 슬롯 실행)
    CL.saveLang("en");
    const wsE9 = mkWs("enq");
    fs.writeFileSync(CL.contractFileFor(wsE9, "en"), JSON.stringify({ workspace: wsE9, scoutMode: "on" })); // en 슬롯 계약(게이트는 현재 슬롯 판정)
    const rE = runCut(wsE9, []);
    CL.saveLang("ko");
    ok(rE.code === 2 && /ongoing commitment/.test(rE.out) && /old-generation writer/.test(rE.out) && /cutover completes/.test(rE.out) && /after cutover you will not use/.test(rE.out), "en 슬롯 — quiescence 전체 지속 조건 문구 실행 단언");
  }
  { // B1 다중집합(1차 blocker①): 같은 문구·같은 날짜/출처 중복 행 2개 vs originals 1개 → 미이관 1
    const wsM = mkWs("multiset");
    fs.mkdirSync(path.join(wsM, "docs"), { recursive: true });
    const LN = ledgerLine("중복 문구 동일", "2026-07-01", "v");
    fs.writeFileSync(path.join(wsM, "docs", "MAP.md"), LN + "\n" + LN + "\n", "utf8");
    const topoM = MR.readTopoExFor(wsM).topo;
    const rowM = MB.parseApprovedCopy(fs.readFileSync(path.join(wsM, "docs", "MAP.md"), "utf8")).approved[0];
    fs.writeFileSync(MB.bindingsFileFor(wsM), JSON.stringify({ schema: "map-bindings-v1", mapId: topoM.mapId, bindings: [mkBinding(wsM, "docs/MAP.md", rowM, CL.ledgerSig(rowM.text), topoM.nodes[0].id)] }, null, 1), "utf8");
    const um9 = CO.unmigratedRowsFor(wsM, topoM.mapId);
    ok(um9.ok && um9.n === 1 && um9.rows[0].why === "entry-diverged", "같은 fp 중복 행=수량 소비로 초과분 1건 계상(1차 blocker① — 직전 n:0 반례 소멸)");
  }
  // 잠금 안 재검사: 스냅샷 후 확정층 변조=중단 — 잠금 보유로 재현 불가하므로 확정층을 검사 사이 바꾸는
  // 대신 '잠금 보유 중 cutover=잠금 실패'로 임계구역 실존을 실측(동시 apply와 같은 잠금 프로토콜)
  const lockPath = MR.ctxFor ? null : null;
  const ws2 = mkWs("lockin");
  const ctx2 = require(path.join(ROOT, "bridge", "map-runtime.js"));
  const lk = ctx2.withMapLock(ws2, () => { // 잠금 보유 중 자식 cutover — strict lock이라 대기 후 실패
    const rr = runCut(ws2, ["--confirm-windows-reloaded"]);
    return rr;
  });
  ok(lk.ok === true && lk.result.code === 1 && /잠금|lock/i.test(lk.result.out), "정본 잠금 보유 중 cutover=실패(임계구역 상호 배제 실측)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
