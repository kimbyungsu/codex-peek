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
function writeDeployManifest() { // install.js와 동일 규약(deploy-manifest-v1) — deployed-self 전수 대조 기준
  const files = {};
  for (const f of LIST) files[f] = crypto.createHash("sha1").update(fs.readFileSync(path.join(process.env.CODEX_BRIDGE_HOME, f))).digest("hex");
  fs.writeFileSync(path.join(process.env.CODEX_BRIDGE_HOME, "deploy-manifest.json"), JSON.stringify({ schema: "deploy-manifest-v1", ts: new Date().toISOString(), files }, null, 1));
}
writeDeployManifest();

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

console.log("[6] C-7 자동화 계층 — auto 모드·deployed-self·배선 계약");
{
  // auto+미이관 0=quiescence 플래그 없이 자동 전환 성공(동의할 내용 없음)
  const wsA = mkWs("auto0");
  const rA = runCut(wsA, ["--auto"]);
  ok(rA.code === 0 && rA.out.trim() === "", "auto+미이관 0=플래그 없이 자동 전환 성공+침묵(출력 0 — detach/폴 로그 오염 방지)");
  ok(MB.authorityStateFor(wsA).st === "v2", "자동 전환 후 권위=v2");
  // auto+미이관 N>0=조용히 물러남(exit 3·쓰기 0 — 카드 소관)
  const wsB = mkWs("autoN");
  fs.mkdirSync(path.join(wsB, "docs"), { recursive: true });
  fs.writeFileSync(path.join(wsB, "docs", "MAP.md"), ledgerLine("미이관 자동거부", "2026-07-01", "v") + "\n", "utf8");
  const rB = runCut(wsB, ["--auto"]);
  ok(rB.code === 3 && rB.out.trim() === "", "auto+미이관 1=exit 3+침묵(카드 소관 — 코드로만 판정)");
  ok(!fs.existsSync(path.join(wsB, "project-map", "authority.json")), "auto 물러남=쓰기 0(marker 미기록)");
  // autoCutoverAssess 합타입
  ok(CO.autoCutoverAssess(wsB).state === "card" && CO.autoCutoverAssess(wsB).n === 1, "assess=card+N(원클릭 카드 재료)");
  ok(CO.autoCutoverAssess(wsA).state === "no", "assess(v2)=no(멱등 — 재시도 소음 없음)");
  const wsC2 = mkWs("assessAuto");
  ok(CO.autoCutoverAssess(wsC2).state === "auto", "assess(legacy·미이관 0)=auto");
  // 수동 경로 무회귀: auto 아닌 실행은 여전히 quiescence 플래그 필수
  ok(runCut(wsC2, []).code === 2, "수동 경로=플래그 필수 유지(자동화가 수동 검사를 완화하지 않음)");
  // deployed-self: BRIDGE_DIR 사본에서 실행하면 배포 세대 검사=자기 정합 통과
  const rSelf = cp.spawnSync(process.execPath, ["-e",
    "const MR=require(process.argv[1]); process.exit(MR.runCli(process.argv[2], 'cutover', ['--auto']));",
    path.join(process.env.CODEX_BRIDGE_HOME, "map-runtime.js"), wsC2], { encoding: "utf8", env: { ...process.env } });
  ok(rSelf.status === 0 && MB.authorityStateFor(wsC2).st === "v2", "설치본 실행=deploy-manifest 전수 대조 통과·자동 전환 성공: " + (rSelf.stderr || "").split("\n")[0]);
  { // 2차 blocker②: '섞인 세대'(1파일만 다른 배포) — manifest 지문 불일치로 거부
    const wsMix = mkWs("mixgen");
    const tgt9 = path.join(process.env.CODEX_BRIDGE_HOME, "scout-gate.js");
    const keep9 = fs.readFileSync(tgt9);
    fs.writeFileSync(tgt9, Buffer.concat([keep9, Buffer.from("\n// stale-gen\n")]));
    const rMix = cp.spawnSync(process.execPath, ["-e",
      "const MR=require(process.argv[1]); process.exit(MR.runCli(process.argv[2], 'cutover', ['--auto']));",
      path.join(process.env.CODEX_BRIDGE_HOME, "map-runtime.js"), wsMix], { encoding: "utf8", env: { ...process.env } });
    fs.writeFileSync(tgt9, keep9);
    ok(rMix.status !== 0 && !fs.existsSync(path.join(wsMix, "project-map", "authority.json")), "섞인 세대(소비처 1파일 변조)=거부·쓰기 0(자기 경로 확인만으로 통과하던 구멍 소멸)");
    ok(runCut(wsMix, ["--auto"]).code === 0, "(대조) 세대 복원=자동 전환 성공");
  }
  { // 3차 blocker②: 축소 manifest({files:{}} 등)=집합 불일치 거부(자기 서술만 믿던 구멍 소멸)
    const wsSh = mkWs("shrink");
    const manF9 = path.join(process.env.CODEX_BRIDGE_HOME, "deploy-manifest.json");
    const manKeep9 = fs.readFileSync(manF9, "utf8");
    fs.writeFileSync(manF9, JSON.stringify({ schema: "deploy-manifest-v1", ts: "2026-07-21T00:00:00.000Z", files: {} }), "utf8");
    const rSh = cp.spawnSync(process.execPath, ["-e",
      "const MR=require(process.argv[1]); process.exit(MR.runCli(process.argv[2], 'cutover', ['--auto']));",
      path.join(process.env.CODEX_BRIDGE_HOME, "map-runtime.js"), wsSh], { encoding: "utf8", env: { ...process.env } });
    fs.writeFileSync(manF9, manKeep9, "utf8");
    ok(rSh.status !== 0 && !fs.existsSync(path.join(wsSh, "project-map", "authority.json")), "축소 manifest(빈 files)=거부·쓰기 0(키 집합=EXPECTED 정확 일치 강제)");
  }
  { // EXPECTED_DEPLOY_FILES 3카피 패리티(install.js·hook-setup.ts와 동일 집합)
    const hs = fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8");
    const m9 = hs.match(/BRIDGE_SCRIPTS = \[(.*?)\]/s);
    const hsList = m9 ? m9[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter((x) => x && !x.startsWith("//")) : [];
    ok(JSON.stringify([...CO.EXPECTED_DEPLOY_FILES].sort()) === JSON.stringify([...LIST].sort()), "EXPECTED=install.js BRIDGE_SCRIPTS(패리티)");
    ok(JSON.stringify([...CO.EXPECTED_DEPLOY_FILES].sort()) === JSON.stringify([...hsList].sort()), "EXPECTED=hook-setup.ts BRIDGE_SCRIPTS(패리티 — 3카피 규약)");
  }
  { // manifest 부재=거부(설치 재실행 안내 축)
    const wsNoM = mkWs("noman");
    const manF = path.join(process.env.CODEX_BRIDGE_HOME, "deploy-manifest.json");
    const manKeep = fs.readFileSync(manF, "utf8");
    fs.unlinkSync(manF);
    const rNoM = cp.spawnSync(process.execPath, ["-e",
      "const MR=require(process.argv[1]); process.exit(MR.runCli(process.argv[2], 'cutover', ['--auto']));",
      path.join(process.env.CODEX_BRIDGE_HOME, "map-runtime.js"), wsNoM], { encoding: "utf8", env: { ...process.env } });
    fs.writeFileSync(manF, manKeep, "utf8");
    ok(rNoM.status !== 0, "deploy-manifest 부재=거부(전수 대조 기준 없음 — fail-closed)");
  }
  { // 2차 blocker⑤: auto는 blocked(재개)에서 침묵 물러남(exit 3·quiescence 우회 없음)
    const wsBk = mkWs("autoblk");
    ok(runCut(wsBk, ["--confirm-windows-reloaded"]).code === 0, "(전제) cutover 성공");
    fs.unlinkSync(path.join(wsBk, "project-map", "authority.json")); // receipt-only=blocked
    const rBk = runCut(wsBk, ["--auto"]);
    ok(rBk.code === 3 && rBk.out.trim() === "" && !fs.existsSync(path.join(wsBk, "project-map", "authority.json")), "auto+blocked(재개)=exit 3·침묵·쓰기 0(재개는 판단 필요 — 수동·카드 소관)");
    ok(runCut(wsBk, ["--confirm-windows-reloaded"]).code === 0, "(대조) 수동 재개=성공(플래그 요구 유지)");
  }
  { // 4차 blocker②: auto 성공=notice 파일 기록(bootstrap 침묵 경로의 리로드 고지 전달 재료)+ack 왕복
    const wsNt = mkWs("notice");
    ok(runCut(wsNt, ["--auto"]).code === 0, "(전제) auto 전환 성공");
    let nt = null;
    try { nt = JSON.parse(fs.readFileSync(path.join(wsNt, "project-map", "cutover-notice.json"), "utf8")); } catch { nt = null; }
    ok(!!nt && nt.schema === "map-cutover-notice-v1" && nt.mode === "auto" && nt.pending === true && typeof nt.decisionRef === "string" && nt.decisionRef.length > 0, "auto 성공=notice 기록(schema·mode·pending·decisionRef 결속)");
    ok(CO.autoNoticePendingFor(wsNt).pending === true, "autoNoticePendingFor=pending(확장 v2 관측이 소비할 재료)");
    ok(CO.ackAutoCutoverNotice(wsNt) === true && CO.autoNoticePendingFor(wsNt).pending === false, "ack=pending 해제(리로드 후 재고지 없음)");
    ok(JSON.parse(fs.readFileSync(path.join(wsNt, "project-map", "cutover-notice.json"), "utf8")).pending === false, "ack는 파일에 내구(deliveredTs 기록)");
    const wsNm = mkWs("noticeman");
    ok(runCut(wsNm, ["--confirm-windows-reloaded"]).code === 0 && !fs.existsSync(path.join(wsNm, "project-map", "cutover-notice.json")), "수동 cutover=notice 없음(고지는 CLI 완료 문구가 담당 — auto 전용)");
    ok(CO.autoNoticePendingFor(wsNm).pending === false, "notice 부재=pending 아님(손상/부재=고지 없음 방향)");
  }
  // 배선 계약(소스 단언): bootstrap 완료 훅·확장 자동 시도·원클릭 카드·모달
  const bs = fs.readFileSync(path.join(ROOT, "bridge", "map-bootstrap.js"), "utf8");
  ok(/finishDone[^]{0,3000}runCutover\(repo, \{ auto: true/.test(bs) || /okRs\) \{ try \{ const CO = require[^]{0,200}auto: true/.test(bs), "bootstrap 완결 직후 자동 전환 시도 배선(신규 프로젝트 자연 경로)");
  const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(ext.includes("autoCutoverAssess") && /aa\.state === "auto"[^]{0,200}auto: true/.test(ext), "대시보드 legacy 관측=auto 시도 배선(기존 프로젝트 경로)");
  ok(ext.includes("mapCutoverCard") && ext.includes('type === "cutoverConfirm"') && ext.includes("확인했고 전환 진행"), "원클릭 카드+확인 모달 배선(CLI 타이핑 제거)");
  ok(/code9 === 0[^]{0,700}approvedViewFor\(targetRepo\)/.test(ext), "auto 성공=같은 응답에서 어댑터 재판독(marker 후 legacy 공급·캐시 창 제거 — 2차 blocker③·3차 blocked 선강등 포함)");
  ok(ext.includes("repo: targetRepo }; // 2차 blocker④") || /mapCutoverCard = \{ n: aa\.n[^]{0,80}repo: targetRepo/.test(ext), "카드에 대상 repo 결속");
  ok(/normWs\(targetC7\) !== normWs\(m\.repo\)/.test(ext) && ext.includes("정찰 대상이 바뀌었어요"), "핸들러=전송 repo와 현재 재해석 대조(불일치=기록 0 — 2차 blocker④)");
  ok(ext.includes("function writeDeployManifest") && ext.includes("ensureDeployManifest(src)"), "확장 배포 경로도 manifest 기록+조기 반환 시 사후 보충(3차 blocker① — 기록 조건은 4차 단언이 강제)");
  ok(/writeDeployManifest\(src: string\)[^]{0,700}fs\.readFileSync\(path\.join\(src, f\)\)/.test(ext) && !/writeDeployManifest\(src: string\)[^]{0,700}readFileSync\(path\.join\(BRIDGE_DIR, f\)\)/.test(ext), "확장 manifest 지문=번들 원본 바이트(설치본 재판독 금지 — 5차 blocker TOCTOU)");
  ok(/mapSource = "blocked"; mapBlockedReason = mapReasonText\("runtime-outdated"[^]{0,400}av2\.source === "v2"/.test(ext), "auto 성공 후 재판독 실패=blocked 강등(legacy 복귀 금지 — 3차 blocker③)");
  ok(/targetNow = dashboardWorkspace\(\)[^]{0,200}normWs\(targetNow\) !== normWs\(targetC7\)/.test(ext) && ext.includes("전환하지 않았습니다"), "모달 callback 시점 대상 재해석 재대조(3차 blocker④)");
  ok(ext.includes("autoCutoverNotified") && ext.includes("자동 전환됨") && ext.includes("switched automatically"), "자동 전환 리로드 고지 — 알림 1회+카드 표시 ko/en(3차 blocker⑤)");
  ok(ext.includes("mapAutoCutoverDone"), "카드 '리로드 필요' 표시 재료 배선");
  ok(/absent\.length === 0 && stamp\.version === ver && bundleDriftFiles\(src\)\.length === 0/.test(ext), "같은 버전 조기 반환도 번들 전수 대조 통과 시에만 manifest 보충(드리프트=전체 재배치 — 4차 blocker①)");
  ok(ext.includes("if (allOk && writeStamp) writeDeployManifest(src)"), "manifest는 전체 재배치 후에만 — 부분 보충(수동 모드)의 혼합 세대 정본화 금지(4차 blocker①)");
  { // 5차 blocker 실행 반례: install.js 지문=레포 원본 바이트 — '대조 후 설치본 교체' 경합을 재현하면 manifest가 교체본과 불일치=cutover 거부(승인 창 소멸)
    const ins = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");
    ok(/files\[f\] = crypto\.createHash\("sha1"\)\.update\(fs\.readFileSync\(path\.join\(SRC_BRIDGE, f\)\)\)/.test(ins) && !/files\[f\] = crypto\.createHash\("sha1"\)\.update\(fs\.readFileSync\(path\.join\(BRIDGE_DIR, f\)\)\)/.test(ins), "install.js manifest 지문=레포 원본(목적지 재판독 금지 — 5차 blocker)");
    const wsRc = mkWs("race");
    const tgtR = path.join(process.env.CODEX_BRIDGE_HOME, "scout-gate.js");
    const keepR = fs.readFileSync(tgtR);
    fs.writeFileSync(tgtR, Buffer.concat([keepR, Buffer.from("\n// racer-gen\n")])); // manifest(원본 세대) 기록 '후' 설치본이 교체된 경합의 최종 상태
    const rRc = cp.spawnSync(process.execPath, ["-e",
      "const MR=require(process.argv[1]); process.exit(MR.runCli(process.argv[2], 'cutover', ['--auto']));",
      path.join(process.env.CODEX_BRIDGE_HOME, "map-runtime.js"), wsRc], { encoding: "utf8", env: { ...process.env } });
    fs.writeFileSync(tgtR, keepR);
    ok(rRc.status !== 0 && !fs.existsSync(path.join(wsRc, "project-map", "authority.json")), "경합 최종 상태(원본 지문 manifest+교체 설치본)=거부·쓰기 0(혼합 승인 창 소멸 — fail-closed 방향)");
  }
  { // 9차(8차 검증 blocker 2건 — 프로토콜 교체): wx 파일 잠금(contract-lock v10 계보) — 자동 탈환 전면 폐기
    const lockF = path.join(process.env.CODEX_BRIDGE_HOME, ".deploy.lock");
    { // 무경합 획득·해제
      const rA = CO.withDeployLock(() => "ok");
      ok(rA.ok === true && rA.result === "ok" && !fs.existsSync(lockF), "무경합 획득=성공·해제(잠금 파일 소멸)");
    }
    { // 활성 보유자(생존 pid)=유한 타임아웃·잠금 보존 — CLI cutover도 fail-closed
      fs.writeFileSync(lockF, JSON.stringify({ v: 1, pid: process.pid, rnd: "x", ts: new Date().toISOString() }));
      process.env.CODEX_DEPLOY_LOCK_TIMEOUT_MS = "300";
      const t9 = Date.now();
      const rB = CO.withDeployLock(() => "never");
      ok(rB.ok === false && rB.key === "deploy-lock-timeout" && Date.now() - t9 < 5000 && fs.existsSync(lockF), "활성 잠금=유한 시간 내 타임아웃(무한 busy-loop 없음)·타인 잠금 보존");
      const wsLk9 = mkWs("lockbusy");
      const rC = runCut(wsLk9, ["--auto"]);
      ok(rC.code !== 0 && !fs.existsSync(path.join(wsLk9, "project-map", "authority.json")), "잠금 보유 중 cutover=거부·쓰기 0(검사기 fail-closed)");
      delete process.env.CODEX_DEPLOY_LOCK_TIMEOUT_MS;
      fs.unlinkSync(lockF);
      ok(runCut(wsLk9, ["--auto"]).code === 0, "(대조) 잠금 해제 후=자동 전환 성공");
    }
    { // 사망 보유자=자동 삭제 '없음'(확인-후-삭제 TOCTOU 폐기) — stale 검출 실패+복구 안내
      fs.writeFileSync(lockF, JSON.stringify({ v: 1, pid: 999999999, rnd: "d", ts: "2026-01-01T00:00:00.000Z" }));
      process.env.CODEX_DEPLOY_LOCK_TIMEOUT_MS = "300";
      const rD = CO.withDeployLock(() => "never");
      delete process.env.CODEX_DEPLOY_LOCK_TIMEOUT_MS;
      ok(rD.ok === false && rD.key === "deploy-lock-stale" && fs.existsSync(lockF), "사망 pid 잔존=자동 탈환 없이 검출 실패(이중 진입 벡터 원천 소멸·fail-closed)");
      ok(String(rD.detail || "").includes("999999999"), "stale 안내에 pid·경로 동봉(수동 복구 판단 재료)");
      fs.unlinkSync(lockF);
    }
    { // 임계구역 중 외부 개입(내용 교체)=상실 검출+타인 내용 비삭제(조건부 해제)
      const rE = CO.withDeployLock(() => { fs.writeFileSync(lockF, "hijacker"); return "ran"; });
      ok(rE.ok === false && rE.key === "deploy-lock-lost" && fs.readFileSync(lockF, "utf8") === "hijacker", "소유권 상실=검출된 실패·외부 잠금 비삭제");
      fs.unlinkSync(lockF);
    }
    const ins9 = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");
    const ext9 = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
    const co9 = fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8");
    ok([ins9, ext9, co9].every((t9) => t9.includes('".deploy.lock"') && t9.includes('flag: "wx"')), "wx 원자 획득(생성=신원 한 시스템콜) 3카피 패리티");
    ok([ins9, ext9, co9].every((t9) => !t9.includes(".deploy-lock.d") && !t9.includes('".steal-"') && !t9.includes("renameSync(lockDir")), "디렉터리 잠금·자동 탈환 경로 전면 제거 3카피(원복 공백·null 세대 동치 소멸)");
    ok([ins9, ext9, co9].every((t9) => /for \(;;\) \{\s*\n\s*if \(Date\.now\(\) - t0 > timeoutMs\)/.test(t9)), "루프 머리 타임아웃 3카피(무한 busy-loop 봉합 유지)");
    ok([ins9, co9].every((t9) => t9.includes('ke.code === "ESRCH"')), "사망 보유자 분류(ESRCH만 사망 단정) — 검사기·installer 카피");
  }
  ok(/autoNoticePendingFor\(targetRepo\)\.pending/.test(ext) && ext.includes("ackAutoCutoverNotice"), "v2 관측 시 notice 소비(알림 1회+ack) — bootstrap 침묵 자동 전환 고지 전달(4차 blocker②)");
  ok(ext.includes("Confirmed — proceed") && ext.includes("Confirm & switch"), "카드·모달 ko/en 쌍");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
