/*
 * P7 — 의미 보강 모드(mapMode)·readiness 행렬(정본 MAP-V2-DESIGN 'P7 상세 설계' v4 — 사용자 승인 확정) 계약 테스트.
 * 핵심: ①mapMode 4값(명시 self=반대 슬롯 override·부재=비물질화 기본 self) ②readiness — 부재/손상/세대(probeVer)/
 * 지문 재대조(1-8·TOCTOU guarded write) ③economy 지문=실효 해석(env 키 우선) ④공용 빌더=실제 정찰과 동일 조립
 * ⑤capability validator(strict) ⑥UI 배선(별개 축·조용한 전환 금지·자동형 게이트·과금 고지·명시 버튼만).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "p7-mode-test-"));
process.env.CODEX_BRIDGE_HOME = tmpHome;
delete process.env.DEEPSEEK_API_KEY;
const ROOT = path.join(__dirname, "..");
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const DB = require(path.join(ROOT, "bridge", "deepseek-bridge.js"));

console.log("[1] mapMode — 4값·명시 self override·비물질화 기본");
ok(JSON.stringify(CL.MAP_MODES) === JSON.stringify(["self", "economy", "precision", "auto"]), "합타입 4값(1-34·명시 self 포함 — 설계 1차 blocker①)");
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "p7-ws-"));
CL.saveLang("ko");
ok(JSON.stringify(CL.mapModeView(ws)) === JSON.stringify({ raw: null, mode: "self" }), "모두 부재 → 미지정·기본 self(1-33)");
fs.mkdirSync(path.dirname(CL.contractFileFor(ws, "en")), { recursive: true });
fs.writeFileSync(CL.contractFileFor(ws, "en"), JSON.stringify({ workspace: ws, mapMode: "economy" }));
ok(CL.mapModeView(ws).mode === "economy" && CL.mapModeView(ws).raw === "economy", "현재 슬롯 부재 → 반대 언어 슬롯 상속('사실' 성격)");
fs.writeFileSync(CL.contractFileFor(ws, "ko"), JSON.stringify({ workspace: ws, mapMode: "self" }));
ok(CL.mapModeView(ws).mode === "self" && CL.mapModeView(ws).raw === "self", "명시 self가 반대 슬롯 economy를 override(설계 1차 blocker① 반례 봉합)");
ok(CL.normMapMode({ mapMode: "nonsense" }) === undefined && CL.normMapMode({ mapMode: "auto" }) === "auto", "이형 값=미지정 강등·유효값 보존(raw)");
ok(CL.loadContract(ws).mapMode === "self", "loadContract에 raw 보존(비물질화 — norm으로 안 굳힘)");

console.log("[2] readiness 영속 상태 — 부재/손상/세대/guarded write(TOCTOU)");
let v = CL.mapReadinessView({});
ok(!v.damaged && v.self.reason === "not-probed" && v.economy.reason === "not-probed" && v.auto.ok === false, "부재={} → 전 provider not-probed(auto=미준비)");
const w1 = CL.writeMapReadinessGuarded("precision", { ok: true, probedAt: "T1", fp: "FP-A" }, () => "FP-A");
ok(w1.ok === true, "guarded write — 잠금 안 지문 일치 시 기록");
v = CL.mapReadinessView({ precisionFpNow: "FP-A" });
ok(v.precision.ok === true && v.precision.probedAt === "T1", "기록+지문 일치 → precision 준비됨");
v = CL.mapReadinessView({ precisionFpNow: "FP-B" });
ok(v.precision.ok === false && v.precision.reason === "config-changed", "지문 상이(설정 변경) → 무효(config-changed — 재점검 요구)");
const w2 = CL.writeMapReadinessGuarded("precision", { ok: true, probedAt: "T2", fp: "FP-OLD" }, () => "FP-NEW");
ok(w2.ok === false && w2.reason === "fp-mismatch", "실행 중 설정 변경(캡처 FP-OLD≠현재 FP-NEW) → 결과 폐기(설계 3차 blocker TOCTOU)");
ok(JSON.parse(fs.readFileSync(CL.MAP_READINESS_FILE, "utf8")).precision.probedAt === "T1", "폐기 시 기존 레코드 불변(부분 오염 없음)");
fs.writeFileSync(CL.MAP_READINESS_FILE, "{corrupt");
v = CL.mapReadinessView({ precisionFpNow: "FP-A" });
ok(v.damaged === true && v.precision.ok === false && v.precision.reason === "state-damaged", "손상 파일 → 전 provider unknown(기본값 위장 금지)");
CL.writeMapReadinessGuarded("precision", { ok: true, probedAt: "T3", fp: "FP-A" }, () => "FP-A"); // 손상 위 기록=새로 시작
const rawJ = JSON.parse(fs.readFileSync(CL.MAP_READINESS_FILE, "utf8"));
ok(rawJ.version === CL.MAP_READINESS_VER && rawJ.probeVer === CL.MAP_PROBE_VER, "손상 후 기록=신뢰 재구축(version·probeVer 재설정)");
fs.writeFileSync(CL.MAP_READINESS_FILE, JSON.stringify({ ...rawJ, probeVer: 0 }));
v = CL.mapReadinessView({ precisionFpNow: "FP-A" });
ok(v.precision.ok === false && v.precision.reason === "probe-ver-changed", "probeVer 불일치 → 전 레코드 무효(점검 계약 개정)");
// 구현검증 3차 blocker(f-5d8a090f): v1 계약(economy 출력 미검증·Electron 오실행 가능)에서 만든 성공 레코드는
// 계약 개정(v2) 후 반드시 무효 — '구 버전 성공'이 정확히 probe-ver-changed로 강등되는지 명시 잠금.
ok(CL.MAP_PROBE_VER >= 2, "probe 계약 개정 시 MAP_PROBE_VER 상향(v2+) — 상향 없는 계약 변경 금지");
fs.writeFileSync(CL.MAP_READINESS_FILE, JSON.stringify({ version: CL.MAP_READINESS_VER, probeVer: 1, economy: { ok: true, probedAt: "T-v1", fp: "FP-V1" } }));
v = CL.mapReadinessView({});
ok(v.economy.ok === false && v.economy.reason === "probe-ver-changed", "구계약 v1 성공 레코드 → 무효(위조 가능 세대 전량 강등 — 지문 대조 이전에 판정)");
// 4차 blocker(f-5d8a090f 재지적): v1 파일 '위에' v2 결과를 기록할 때 기존 파일을 펼쳐 병합하면 구 성공이
// 보존된 채 파일 세대만 v2로 승격 → 세대 불일치 병합 금지(새 컨테이너)를 파일 바이트로 잠금.
const wV2 = CL.writeMapReadinessGuarded("self", { ok: true, probedAt: "T-v2", fp: "FP-S" }, () => "FP-S");
const afterV2 = JSON.parse(fs.readFileSync(CL.MAP_READINESS_FILE, "utf8"));
ok(wV2.ok === true && afterV2.probeVer === CL.MAP_PROBE_VER && !("economy" in afterV2), "v1 파일 위 v2 기록 → 구 v1 레코드 병합 금지(새 컨테이너 — 세대 승격 위조 차단)");
v = CL.mapReadinessView({});
ok(v.economy.ok === false && v.economy.reason === "not-probed", "병합 금지 후 economy=not-probed(구 성공이 '준비됨'으로 부활하지 않음)");

console.log("[2c] 실행기(map-probe.js) 실제 실행 — 가짜 CODEX_BIN·성공/실패·TOCTOU(구현검증 1·2차 blocker 잠금)");
const MP = require(path.join(ROOT, "bridge", "map-probe.js"));
{
  // 성공 경로: 가짜 codex(즉시 -o 기록) → probePrecision 전체(공용 빌더·usage 기록·guarded 기록)까지 실행
  const stubOk = path.join(tmpHome, "codex-ok-stub.js");
  fs.writeFileSync(stubOk, ['const fs=require("fs");', 'const o=process.argv.indexOf("-o");', 'fs.writeFileSync(process.argv[o+1], "ready");', "process.exit(0);"].join("\n"));
  const invOk = { file: process.execPath, args: [stubOk], how: "test" };
  const rp1 = MP.probePrecision({ inv: invOk, prompt: "p" });
  ok(rp1.rec.ok === true && rp1.write.ok === true, "실행기 성공 경로 — 실 spawn·-o 회수·guarded 기록");
  const vP = CL.mapReadinessView({ precisionFpNow: CL.precisionExecFp(invOk) });
  ok(vP.precision.ok === true, "기록 후 뷰 재대조 — precision 준비됨");
  const capRows0 = fs.readFileSync(path.join(tmpHome, "stats", "scout-usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.arm === "codex-probe");
  ok(capRows0.length === 1 && capRows0[0].pkgChars === 1, "codex-probe 비용 장부 기록(문자수 정직 — 1차 blocker④ '실행' 증거)");
  // TOCTOU 정본 필수 반례: 스텁 '자신'이 실행 중 전역 설정을 바꿈 → 실행기 내부 guarded 기록이 결과 폐기
  const stubMut = path.join(tmpHome, "codex-mutate-stub.js");
  const scFile = path.join(tmpHome, "scout-codex.json").replace(/\\/g, "/");
  fs.writeFileSync(stubMut, ['const fs=require("fs");', 'fs.writeFileSync("' + scFile + '", JSON.stringify({model:"m-B",reasoning:""}));', 'const o=process.argv.indexOf("-o");', 'fs.writeFileSync(process.argv[o+1], "ready");', "process.exit(0);"].join("\n"));
  CL.saveScoutCodexPrefs({ model: "m-A", reasoning: "" });
  const rp2 = MP.probePrecision({ inv: { file: process.execPath, args: [stubMut], how: "test" }, prompt: "p" });
  ok(rp2.rec.ok === true && rp2.write.ok === false && rp2.write.reason === "fp-mismatch", "실행 중 설정 A→B 변경(가짜 CODEX_BIN이 직접 변경) → 성공 결과 폐기(정본 필수 반례를 '실행기 경유'로 실행)");
  CL.saveScoutCodexPrefs({ model: "", reasoning: "" });
  // 실패 경로: exit 2 스텁 → 실패 레코드 '기록됨'(guard는 실패 레코드의 지문 검사 생략 — 2차 blocker② 핵심)
  const stubBad = path.join(tmpHome, "codex-bad-stub.js");
  fs.writeFileSync(stubBad, "process.exit(2);");
  const rp3 = MP.probePrecision({ inv: { file: process.execPath, args: [stubBad], how: "test" }, prompt: "p" });
  ok(rp3.rec.ok === false && rp3.write.ok === true, "같은 설정의 '방금 실패'는 기록(이전 성공을 덮음 — 화면에서 준비됨으로 잔존 금지)");
  const vP2 = CL.mapReadinessView({ precisionFpNow: "whatever" });
  ok(vP2.precision.ok === false && vP2.precision.reason === "probe-failed", "실패 기록 후 뷰=probe-failed(이전 성공 잔존 소멸)");
  // 3차 [주의] 다중 창 경합: 창 A가 구 설정으로 점검 시작(지연) → 창 B가 설정 변경 후 성공 기록 → A의 늦은
  // 실패는 구 세대 지문이므로 폐기(최신 성공을 실패로 오판·자동형 불필요 차단 방지). 지문 null 실패는 예외 기록.
  const wOkNow = CL.writeMapReadinessGuarded("precision", { ok: true, probedAt: "T-B", fp: "FP-NEW" }, () => "FP-NEW");
  const wStale = CL.writeMapReadinessGuarded("precision", { ok: false, probedAt: "T-A-late", fp: "FP-STALE" }, () => "FP-NEW");
  ok(wOkNow.ok === true && wStale.ok === false && wStale.reason === "fp-mismatch", "구 세대 늦은 실패 → 폐기(최신 성공 보존)");
  ok(JSON.parse(fs.readFileSync(CL.MAP_READINESS_FILE, "utf8")).precision.probedAt === "T-B", "폐기 후 파일에 창 B 성공 레코드 불변");
  const wNullFp = CL.writeMapReadinessGuarded("precision", { ok: false, probedAt: "T-nofp", fp: null }, () => "FP-NEW");
  ok(wNullFp.ok === true, "지문 null 실패(CLI 부재 등 지문 생성 불가) → 기록 허용(옛 성공 잔존 차단 유지)");
}
{
  // probeSelf 실행: 가짜 claude(버전 출력) → 성공, 존재하지 않는 명령 → 실패 레코드 기록+ver null 반환(캐시 리셋 계약)
  const fakeClaude = path.join(tmpHome, "fake-claude.js");
  fs.writeFileSync(fakeClaude, 'console.log("9.9.9 (fake)"); process.exit(0);');
  const rs1 = MP.probeSelf({ claudeCmd: process.execPath, claudeArgs: [fakeClaude], adapterHint: path.join(ROOT, "scripts", "scout-providers.js"), shell: false });
  ok(rs1.ver === "9.9.9 (fake)" && rs1.rec.ok === true && rs1.write.ok === true, "probeSelf 성공 경로 실행 — 버전 캡처+어댑터 지문 결속+guarded 기록");
  const rs2 = MP.probeSelf({ claudeCmd: path.join(tmpHome, "no-such-cli-xyz.exe"), adapterHint: path.join(ROOT, "scripts", "scout-providers.js"), shell: false });
  ok(rs2.ver === null && rs2.rec.ok === false && rs2.write.ok === true, "CLI 부재 → ver null 반환(호출자 캐시 리셋 계약)+실패 레코드 기록(2차 blocker②)");
  ok(typeof rs1.rec.startedAt === "string" && typeof rs2.rec.startedAt === "string", "probe 레코드에 시작 시각 탑재(늦은-패자 규칙 입력 — 4차 [주의])");
  const vS = CL.mapReadinessView({ selfFpNow: null });
  ok(vS.self.ok === false, "실패 기록+캐시 리셋 후 뷰=미준비(옛 성공 부활 없음)");
  // 4차 [주의](f-871aa1de): fp:null 실패도 '시작 시각'이 기존 성공 기록보다 앞서면(그 사이 다른 창이 성공
  // 기록) 구 세대 실행 — 폐기. 성공 이후에 시작한 '방금 실패'는 기록(f-c27944f3 무회귀).
  const wB2 = CL.writeMapReadinessGuarded("self", { ok: true, probedAt: "2026-01-02T00:00:00.000Z", fp: "FP-S2" }, () => "FP-S2");
  const wLate = CL.writeMapReadinessGuarded("self", { ok: false, probedAt: "2026-01-02T00:00:05.000Z", startedAt: "2026-01-01T23:59:00.000Z", fp: null }, () => null);
  ok(wB2.ok === true && wLate.ok === false && wLate.reason === "stale-loser", "구 세대 시작 fp:null 늦은 실패 → 폐기(창 B 최신 성공 보존)");
  ok(JSON.parse(fs.readFileSync(CL.MAP_READINESS_FILE, "utf8")).self.ok === true, "폐기 후 파일에 창 B 성공 레코드 불변");
  const wFresh = CL.writeMapReadinessGuarded("self", { ok: false, probedAt: "2026-01-02T00:01:00.000Z", startedAt: "2026-01-02T00:00:30.000Z", fp: null }, () => null);
  ok(wFresh.ok === true, "성공 '이후' 시작한 fp:null 실패 → 기록(같은 창 '방금 실패' 유지 — 무회귀)");
}

console.log("[3] economy 지문 — 실효 해석(env 키가 파일 키를 이김·키 원문 미포함)");
ok(CL.economyConfigFp() === null, "설정 없음 → null(economyReady 1조건 미충족)");
fs.writeFileSync(path.join(tmpHome, "deepseek.json"), JSON.stringify({ apiKey: "sk-file-key", model: "m1" }));
const fpFile = CL.economyConfigFp();
process.env.DEEPSEEK_API_KEY = "sk-env-key";
const fpEnv = CL.economyConfigFp();
delete process.env.DEEPSEEK_API_KEY;
ok(fpFile && fpEnv && fpFile !== fpEnv, "env 키 오버라이드 → 지문 상이(설계 1차 blocker② 반례 — '키 유무'만으론 못 잡던 교체 감지)");
ok(!String(fpFile).includes("sk-file-key"), "지문에 키 원문 미포함");
v = CL.mapReadinessView({});
ok(v.auto.ok === false && (v.auto.reason === "economy-not-ready" || v.auto.reason === "precision-not-ready"), "autoReady=AND(1-34 — 미성립 사유 표시)");

console.log("[4] 공용 빌더 — probe와 실제 정찰의 동일 조립(설계 2차 blocker)");
const args0 = CL.codexScoutExecArgs("O1");
ok(JSON.stringify(args0) === JSON.stringify(["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-o", "O1"]), "기본(두뇌 설정 없음) — P6 인라인과 동일 인자");
CL.saveScoutCodexPrefs({ model: "m-정찰", reasoning: "high" });
const args1 = CL.codexScoutExecArgs("O2");
ok(args1.includes("model=m-정찰") && args1.includes("model_reasoning_effort=high") && args1.indexOf("-o") === args1.length - 2, "정찰 두뇌 설정이 빌더에 실림(잘못된 설정이면 probe도 같이 실패하는 구조)");
const fpP1 = CL.precisionExecFp({ file: "C:/x/codex.exe", args: [], how: "pin" });
const fpP2 = CL.precisionExecFp({ file: "C:/x/codex.exe", args: [], how: "pin" });
CL.saveScoutCodexPrefs({ model: "", reasoning: "" });
const fpP3 = CL.precisionExecFp({ file: "C:/x/codex.exe", args: [], how: "pin" });
ok(fpP1 === fpP2 && fpP1 !== fpP3, "precision 지문 — 두뇌 설정 변경이 지문을 바꿈(execFp 재대조 재료·설계 2차 보완)");
ok(CL.precisionExecFp(null) === null, "실행 해석 부재 → null(정직)");

console.log("[5] capability validator(1-8 strict — 순수 함수)");
ok(DB.validateCapability('{"capability":"ok","n":7}') === true, "정확한 JSON만 → 통과");
ok(DB.validateCapability('설명입니다: {"capability":"ok","n":7}') === false, "설명 동반 → 실패(strict — 관대 파싱 금지)");
ok(DB.validateCapability('```json\n{"capability":"ok","n":7}\n```') === false, "코드펜스 → 실패");
ok(DB.validateCapability('{"capability":"ok","n":7,"extra":1}') === false, "추가 키 → 실패(정확 일치)");
ok(DB.validateCapability("x".repeat(2001)) === false, "크기 상한 초과 → 실패");
const dbSrc = fs.readFileSync(path.join(ROOT, "bridge", "deepseek-bridge.js"), "utf8");
ok(/cmd === "capability"/.test(dbSrc) && /bounded repair — 원격 재호출 정확히 1회/.test(dbSrc) && /arm: "capability"/.test(dbSrc), "capability 명령 — repair 1회 한정·호출별 usage 기록(최대 2회 과금 고지와 일치)");

console.log("[5b] capability 흐름 실행(가짜 API 서버) — 1차 실패→repair 수신→2차 정상=exit 0 / 2차도 실패=exit 2·usage 2건");
const capFlow = () => new Promise((resolve) => {
  const http = require("http");
  const cpX = require("child_process");
  let calls = 0; let sawRepair = false; let mode = "repair-ok";
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls++;
      if (/형식이 틀렸다/.test(body)) sawRepair = true;
      const content = calls === 1 ? "설명: 안됨" : (mode === "repair-ok" ? '{"capability":"ok","n":7}' : "여전히 틀림");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 }, model: "m-t" }));
    });
  });
  srv.listen(0, "127.0.0.1", () => {
    const port = srv.address().port;
    fs.writeFileSync(path.join(tmpHome, "deepseek.json"), JSON.stringify({ apiKey: "sk-test-cap", baseUrl: "http://127.0.0.1:" + port, model: "m-t" }));
    const run = (cb) => {
      const ch = cpX.spawn(process.execPath, [path.join(ROOT, "bridge", "deepseek-bridge.js"), "capability"], { windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: tmpHome } });
      let out = ""; ch.stdout.on("data", (d) => { out += d; });
      ch.on("close", (code) => cb(code, out));
    };
    run((code1, out1) => {
      ok(code1 === 0 && /capability-ok/.test(out1), "1차 형식 실패→repair 1회→정상 JSON → exit 0(bounded repair 실행 흐름)");
      ok(calls === 2 && sawRepair, "원격 호출 정확히 2회(최대 2회 과금 고지와 일치)+repair 프롬프트 실수신");
      const usageRows = fs.readFileSync(path.join(tmpHome, "stats", "scout-usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.arm === "capability");
      ok(usageRows.length === 2 && usageRows[0].usageIn === 5, "호출별 usage 기록(arm=capability — 2건)");
      calls = 0; sawRepair = false; mode = "repair-fail";
      run((code2, out2) => {
        ok(code2 === 2 && /capability-fail/.test(out2) && calls === 2, "repair도 실패 → exit 2·추가 재시도 없음(정확히 1회 한정)");
        // 실행기(probeEconomy) 경유 — 성공 경로는 '자식 프로세스'에서(부모 spawnSync가 이벤트 루프를 막아
        // 같은 프로세스의 스텁 서버가 응답 못 하는 교착 회피)+출력 검증 반례(2차 blocker③ 실행 증거)
        calls = 0; sawRepair = false; mode = "repair-ok";
        const helper = path.join(tmpHome, "run-probe-economy.js");
        fs.writeFileSync(helper, 'const MP=require(process.argv[2]); const r=MP.probeEconomy({ bridgeDir: process.argv[3] }); console.log(JSON.stringify({ ok: r.rec ? r.rec.ok : null, w: r.write ? r.write.ok : null, skipped: !!r.skipped }));');
        const hch = cpX.spawn(process.execPath, [helper, path.join(ROOT, "bridge", "map-probe.js"), path.join(ROOT, "bridge")], { windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: tmpHome } });
        let hout = ""; hch.stdout.on("data", (d) => { hout += d; });
        hch.on("close", () => {
          let hr = null; try { hr = JSON.parse(hout.trim()); } catch { /* 아래 단언이 잡음 */ }
          ok(!!hr && hr.ok === true && hr.w === true, "probeEconomy 실행(자식) — capability 흐름 통과 시 economy 기록: " + hout.trim().slice(0, 80));
          const fakeBridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "p7-fakebridge-"));
          fs.writeFileSync(path.join(fakeBridgeDir, "deepseek-bridge.js"), "process.exit(0);"); // exit 0인데 capability-ok 출력 없음
          const re2 = MP.probeEconomy({ nodeBin: process.execPath, bridgeDir: fakeBridgeDir });
          ok(re2.rec && re2.rec.ok === false, "exit 0이어도 stdout capability-ok 없으면 실패(위조 성공 차단 — 2차 blocker③ 후단)");
          srv.close(() => resolve());
        });
        return;
      });
    });
  });
});

console.log("[6] UI·배선 소스 계약 — 별개 축·조용한 전환 금지·자동형 게이트·명시 버튼만");
const ext = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
ok(/mapModeRow/.test(ext) && /setMapMode/.test(ext) && /runMapProbe/.test(ext), "모드 행·저장·준비 점검 배선");
ok(ext.includes('MAP_MODES_EXT = ["self", "economy", "precision", "auto"]'), "확장 화이트리스트=contract-lib MAP_MODES 동일");
ok(ext.includes("의미 보강 담당(Project MAP) — 영향지도 탐색 담당과 별개") && ext.includes("separate from the impact-map scout"), "별개 축 라벨 ko/en(1-26 부기 — scoutArm과 통합 금지)");
ok(ext.includes("자동 보강 실행 담당") && ext.includes("runs automatic enrichment") && !ext.includes("routing applies from P8"), "실적용 문구(P8 증분 4 — 구 'P8부터' 배지 ko/en 모두 제거·발동 배선 완료)");
ok(ext.includes("자동형은 경제형·정밀형이 모두 준비돼야 선택할 수 있어요(1-34)"), "자동형 선택 게이트(1-34 autoReady=AND — 유일한 비활성 버튼)");
ok(ext.includes("선택은 그대로 유지·자동 전환 없음") && !/mapMode[^\n]*강등|mapMode[^\n]*degrade.*self/.test(ext), "조용한 전환 금지 — degraded 배지만·강등 코드 없음(scoutArm no-key 규칙 재사용 금지)");
ok(ext.includes("DeepSeek 소형 요청 최대 2회") && ext.includes("Codex 계정 사용량 1회") && ext.includes("자동 실행은 없어요"), "과금 고지(최대 2회 — 설계 1차 [주의])+자동 probe 금지 명문");
ok(/mapProbeBusy/.test(ext) && ext.includes("writeMapReadinessGuarded"), "probe 단일-flight+guarded 기록(TOCTOU) 사용");
ok(ext.includes("precisionFpNowExt") && ext.includes("codexInvForProbe"), "precision 지문=호스트 실행 해석 주입(probe·뷰 동일 계산)");
ok(ext.includes('require(path.join(BRIDGE_DIR, "map-probe.js"))') && ext.includes("MP.probeSelf(") && ext.includes("MP.probeEconomy(") && ext.includes("MP.probePrecision("), "probe 실행부=vscode 무관 계층(map-probe.js) 위임 — 테스트가 같은 실행기를 실행(2차 blocker④)");
ok(ext.includes("process.env.CODEX_BIN"), "probe 실행 해석 — CODEX_BIN 우선(구현 1차 blocker③: 실제 정찰 resolveCodex와 같은 순서)");
ok(ext.includes("codex-bin.txt"), "probe 실행 해석 — codex-bin.txt pin 2순위");
ok((ext.match(/ELECTRON_RUN_AS_NODE: "1"/g) || []).length >= 2, "Electron→node 전환 env — precision(.js 해석)+economy(브릿지 실행) 모두(2차 blocker③)");
ok(ext.includes("cachedClaudeVer = rs.ver;") && ext.includes("selfFpNow: selfFpNowExt()"), "self 버전 캐시=실패 포함 반영(null 리셋 — 2차 blocker②)·뷰 재대조 주입");
ok(fs.readFileSync(path.join(ROOT, "bridge", "map-probe.js"), "utf8").includes('arm: "codex-probe"'), "Codex 점검 비용 기록은 실행기 소관(1차 blocker④ — [2c]에서 실행 검증)");
ok(ext.includes('w.reason === "fp-mismatch" ?'), "저장 실패 사유 분리(설정 변경 vs 잠금/쓰기 — 1차 [보완])");
ok(ext.includes('rs.write.ok ? (rs.rec.ok ? "OK" : detS) : wNote(rs.write)')
  && !ext.includes('rs.rec.ok && rs.write.ok ? "OK" : rs.rec.ok ? wNote(rs.write) : detS'),
  "self 점검 결과 실패와 준비 기록 실패를 각각 숨김없이 표시");
ok(ext.includes("어댑터 미배포 — 정찰 스크립트는 마켓 설치본에 없어요"), "VSIX 미배포=정직 미준비 사유 표시(f-15d2907b 재판단: 러너 자체가 마켓 빌드에 없는 현 단계 사실 — 거짓 준비 표시가 더 나쁨)");
const deployLists = [fs.readFileSync(path.join(ROOT, "bridge", "map-cutover.js"), "utf8"), fs.readFileSync(path.join(ROOT, "src", "hook-setup.ts"), "utf8"), fs.readFileSync(path.join(ROOT, "install.js"), "utf8")];
ok(deployLists.every((s9) => s9.includes('"map-probe.js"')), "map-probe.js 배포 3카피 등록(EXPECTED·hook-setup·install 패리티)");

console.log("[7] 정본 확정 표기 — 사용자 승인(2026-07-23) 반영");
const design = fs.readFileSync(path.join(ROOT, "docs", "MAP-V2-DESIGN.md"), "utf8");
ok(design.includes("개정 확정 2026-07-23 — 사용자 승인 ⓑ") && design.includes("사용자 승인 ⓑ 채택"), "1-33 개정 확정(재개 발동=실행기 배포 Phase)");
ok((design.match(/개정 확정 2026-07-23\(사용자 승인\)/g) || []).length === 2, "1-34 precisionReady·P7 로드맵 supersession 확정 표기 2곳");
ok(design.includes("**구현 착수 가능.**"), "미결 해소 명문");

capFlow().then(() => {
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
});
