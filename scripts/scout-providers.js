/*
 * P5 — 탐색 provider 공통 인터페이스(2026-07-22). 정본 SCOUT-TRACK.md는 레포 밖 로컬 문서라 HANDOFF 요지 기준:
 * "runScout→typed ScoutResult·self typed adapter[1-26]·deepseek probe[1-8]" + 1-26 부기(기본 정찰=Claude
 * 무과금·scoutArm은 '러너 선호' 한정 — P7 provider mode와 통합 금지·'키 없으면 강등' 규칙 P7 재사용 금지).
 *
 * 계약:
 * - 러너 2종(scope-scout-self/deepseek)의 공통 파이프라인(수집→렌더→호출→비용 장부→게시판 보관→관측 장부→
 *   지도 반환)을 여기로 추출 — 러너는 얇은 껍데기가 되고, P6(Codex Scout)은 어댑터 하나로 꽂힌다.
 - ScoutResult(형식화 — 아래 @typedef가 정본): 성공/실패 합타입. error.key ∈ not-git | provider-unavailable |
 *   call-failed (열거 — 러너·후속 소비층의 분기 재료. '빈 지도'는 provider별 기존 의미 보존: self=call-failed로
 *   invoke가 보고·deepseek=빈 stdout도 그대로 진행이 구 러너 동작이라 공통층이 새 실패를 신설하지 않는다).
 * - probe(가벼운 도달성 점검 — 지도 요청 아님): self=Claude CLI 존재 확인 / deepseek=bridge ping(키 없으면
 *   정직한 실패 반환 — 게이트 아님) / codex=codex --version(브릿지 resolveCodex 해석 재사용 — P6에서 실체화).
 * - 동작 보존: 기존 러너의 stdout(지도 본문)·stderr(보관/usage 알림)·exit 의미·장부 기록은 러너 껍데기가
 *   ScoutResult로부터 동일하게 재구성한다(바이트 수준 메시지 보존이 테스트 대상).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { collectPackage } = require("./scope-package.js");
const { saveMap, markLive, clearLive } = require("./scout-store.js");
const CL = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
const { renderPackageMarkdown } = require(path.join(__dirname, "..", "out", "scope-package.js"));

/**
 * typed ScoutResult — 판별 합타입(discriminant: ok). scripts/ 계층은 tsc 대상이 아니므로(레포 구조 계약)
 * 형식의 실효 강제는 ①이 JSDoc 정본 ②runScout의 런타임 경계(어댑터 예외·오형식을 전부 ScoutFailure로
 * 정규화 — 반쪽 형태·프로세스 예외로 이탈 금지) ③tests/scout-providers.test.js의 경계 실행 단언, 세 겹이다.
 *
 * @typedef {Object} ScoutSuccess
 * @property {true} ok
 * @property {string} provider - "self" | "deepseek" | (P6) "codex"
 * @property {string} map - 지도 본문(트림 — 빈 문자열 허용: 구 deepseek 러너 동작 보존)
 * @property {{in:number,out:number,model:(string|null)}|null} usage - 토큰 실측(없거나 오형식이면 null — 정직 강등)
 * @property {number} pkgChars - 전송 꾸러미 문자수(preface 포함 — 구 러너와 동일 산식)
 * @property {number} mapChars - 수신 문자수(deepseek=비트림 원문 길이 — 구 러너 보존)
 * @property {string} savedNote - 게시판 보관 md 경로("" = 실패, saveErr 참조)
 * @property {string} saveErr - 보관 실패 사유(성공 시 "")
 * @property {""|"ok"|"failed"} ledgerNote - 관측 장부 ⑥ 적재 결과(""=제안 없음·"failed"=append 실패 — 실제 반환값 기반)
 * @property {string} stderrPass - provider가 통과 전달한 stderr(딥시크 usage/안내 — 러너가 그대로 재출력)
 * @property {string|null} rawStdout - 비트림 원문(딥시크 — 최종 stdout 바이트 보존용)
 *
 * @typedef {Object} ScoutFailure
 * @property {false} ok
 * @property {string} provider
 * @property {{key:("not-git"|"provider-unavailable"|"call-failed"),detail:string}} error
 * @property {string} [stderrPass]
 *
 * @typedef {ScoutSuccess|ScoutFailure} ScoutResult
 *
 * @typedef {Object} ScoutProvider - 어댑터 계약(P6 Codex가 이 형태로 꽂힌다)
 * @property {string} id
 * @property {boolean} billed
 * @property {boolean} [handlesOutFile] - --out을 어댑터가 직접 처리(deepseek=브릿지 위임)
 * @property {() => boolean} available
 * @property {() => {ok:boolean,key?:string,detail?:string}} probe - 가벼운 도달성 점검(지도 요청 아님)
 * @property {(inp:{preface:string,md:string,lang:string,repo:string,outFile:(string|null)}) => ({ok:true,map:string,usage?:({in:number,out:number,model?:(string|null)}|null),stderrPass?:string,rawStdout?:string}|{ok:false,key?:("provider-unavailable"|"call-failed"),detail?:string,stderrPass?:string})} invoke - 실패 key는 열거 한정(그 외는 runScout가 call-failed로 정규화·detail은 문자열화)
 */

// 자기 팔(1-26): 사용자의 Claude Code 기본 모델 1회 호출 — 추가 과금 없음. 꾸러미'만' 근거(도구 전면 차단 —
// DeepSeek 팔과 같은 입력 조건: 공정성 계약 D2).
const SELF_DENY = "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite,KillShell,TaskOutput";

/** @type {Record<string, ScoutProvider>} */
const PROVIDERS = {
  self: {
    id: "self",
    billed: false, // 1-26: 무과금(구독 Claude 재사용)
    available: () => true,
    probe: () => {
      const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true, shell: process.platform === "win32" });
      return r.error || r.status !== 0 ? { ok: false, key: "cli-missing", detail: (r.error && r.error.message) || `exit=${r.status}` } : { ok: true, detail: String(r.stdout || "").trim().slice(0, 60) };
    },
    invoke: ({ preface, md }) => {
      const r = spawnSync("claude", ["-p", "--output-format", "text", "--disallowedTools", SELF_DENY], {
        input: preface + md,
        encoding: "utf8",
        timeout: 8 * 60 * 1000,
        windowsHide: true,
        shell: process.platform === "win32", // npm 전역 셔틀(claude.cmd) 대응
      });
      if (r.error || r.status !== 0 || !String(r.stdout || "").trim()) return { ok: false, key: "call-failed", detail: ((r.error && r.error.message) || `exit=${r.status}`) + " " + String(r.stderr || "").slice(-300) };
      // self 팔(claude -p text)은 토큰을 안 알려줘 usage=null(정직: 문자수만 추정 재료 — §6-12 후속 유지)
      return { ok: true, map: r.stdout.trim(), usage: null, stderrPass: "" };
    },
  },
  deepseek: {
    id: "deepseek",
    billed: true,
    handlesOutFile: true, // --out은 브릿지가 직접 씀(구 러너 계약 보존 — 공통층 이중 쓰기 금지)
    available: () => true, // 키 유무는 probe/invoke가 정직 보고(게이트 아님 — 1-26 부기: '키 없으면 강등' 규칙의 P7 재사용 금지)
    probe: () => {
      const bridge = path.join(__dirname, "..", "bridge", "deepseek-bridge.js");
      const r = spawnSync(process.execPath, [bridge, "ping"], { encoding: "utf8", timeout: 45000, windowsHide: true });
      return r.error || r.status !== 0 ? { ok: false, key: "probe-failed", detail: ((r.error && r.error.message) || `exit=${r.status}`) + " " + String(r.stderr || "").slice(-200) } : { ok: true, detail: String(r.stdout || r.stderr || "").trim().slice(0, 80) };
    },
    invoke: ({ md, outFile }) => {
      const bridge = path.join(__dirname, "..", "bridge", "deepseek-bridge.js"); // repo 정본 직접 실행(설치본 드리프트 회피 — 기존 계약)
      const args = [bridge, "map"];
      if (outFile) args.push("--out", outFile);
      const r = spawnSync(process.execPath, args, { input: md, encoding: "utf8", timeout: 5 * 60 * 1000, windowsHide: true });
      const stderrPass = String(r.stderr || ""); // usage/오류 안내 통과 전달(키 원문은 브릿지가 애초에 안 찍음)
      if (r.error || r.status !== 0) return { ok: false, key: "call-failed", detail: (r.error && r.error.message) || `exit=${r.status}`, stderrPass };
      const um = stderrPass.match(/\[usage\] in=(\d+) out=(\d+)(?: \((.+?)\))?/);
      return { ok: true, map: String(r.stdout || "").trim(), usage: um ? { in: Number(um[1]), out: Number(um[2]), model: um[3] || null } : null, stderrPass, rawStdout: String(r.stdout || "") };
    },
  },
  // Codex 정찰(P6 2026-07-22 — 구 '예정' 소켓의 실체): 검증 세션과 분리된 독립 codex exec 1회.
  // 실행 해석은 브릿지 정본 resolveCodex 재사용(CODEX_BIN→codex-bin.txt 핀→PATH — 중복 구현 금지).
  codex: {
    id: "codex",
    billed: true, // Codex 플랜 사용량 소모(토큰 단가 청구형은 아님 — 정직 표기. 검증 축과 같은 계정을 쓴다)
    available: () => true, // 검증 축이 이미 codex 실행파일에 의존 — 별도 가용성 게이트 없음(실패=정직 보고)
    probe: () => {
      let inv;
      try { inv = require(path.join(__dirname, "..", "bridge", "codex-bridge.js")).resolveCodex(); }
      catch (e) { return { ok: false, key: "probe-failed", detail: "bridge-load: " + ((e && e.message) || "") }; }
      const r = spawnSync(inv.file, [...inv.args, "--version"], { encoding: "utf8", timeout: 30000, windowsHide: true, shell: !!inv.shell });
      return r.error || r.status !== 0 ? { ok: false, key: "probe-failed", detail: (r.error && r.error.message) || `exit=${r.status}` } : { ok: true, detail: String(r.stdout || "").trim().slice(0, 60) };
    },
    invoke: ({ preface, md }) => {
      // 독립 세션 계약: resume이 아닌 새 codex exec 1회 + cwd=빈 임시 폴더 —
      // ①꾸러미'만' 근거(빈 폴더로 저장소 탐색 억제 — 단 read-only 샌드박스는 절대경로 '읽기'를 물리
      //   차단하진 못한다: 정직 한계, preface의 codex 각주(탐색 금지 지시)로 보강. 통신은 read-only가 차단)
      // ②검증 세션 오링크 방지의 정본은 --ephemeral(rollout 무잔재 — 아래 인자 주석)·cwd=임시 폴더는 부차 방어.
      let inv;
      try { inv = require(path.join(__dirname, "..", "bridge", "codex-bridge.js")).resolveCodex(); }
      catch (e) { return { ok: false, key: "call-failed", detail: "bridge-load: " + ((e && e.message) || "") }; }
      const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "scout-codex-"));
      const outFile = path.join(tmpCwd, "map-out.txt");
      try {
        // 인자 조립=공용 빌더 CL.codexScoutExecArgs (P7 — 준비 점검(probe)과 실제 정찰이 같은 조립을 쓰는
        // 계약: 설계검증 2차 blocker '준비 오판' 차단). 내용은 종전과 동일:
        // --sandbox read-only 강제(P6 1차 blocker① — preface 사실 문장과 실행 일치)·--ephemeral(P6 2차
        // blocker② — rollout 무잔재로 검증 세션 오링크 원천 차단·구버전 codex면 실패=정직 보고)·
        // 정찰 전용 두뇌 설정 -c 오버라이드(P6b — scoutCodexArgs, 빈 값=codex 기본).
        const r = spawnSync(inv.file, [...inv.args, ...CL.codexScoutExecArgs(outFile)], {
          input: preface + md,
          cwd: tmpCwd,
          stdio: ["pipe", "ignore", "pipe"],
          encoding: "utf8",
          timeout: 8 * 60 * 1000, // self 팔과 동일 상한
          windowsHide: true,
          shell: !!inv.shell,
          maxBuffer: 1024 * 1024 * 64,
        });
        let map = "";
        try { map = fs.readFileSync(outFile, "utf8").trim(); } catch { /* 아래 실패 판정으로 */ }
        if (r.error || r.status !== 0 || !map) return { ok: false, key: "call-failed", detail: ((r.error && r.error.message) || `exit=${r.status}`) + " " + String(r.stderr || "").slice(-300) };
        // codex exec은 토큰 실측을 안 내놓는다 → usage null(정직 — self 팔과 동일 규약·문자수만 장부에)
        return { ok: true, map, usage: null, stderrPass: "" };
      } finally { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* 임시 잔재 — 무해 */ } }
    },
  },
};

// 공통 파이프라인 — 러너 2종의 본체. providerId 외 주입(deps)은 테스트 전용(실 AI 호출 없이 조립 검증).
/**
 * @param {string} repo - 정찰 대상 레포 경로
 * @param {string} providerId - PROVIDERS 키("self"|"deepseek"|"codex") 또는 테스트 주입 키
 * @param {{outFile?:(string|null),_providers?:Record<string,ScoutProvider>}} [opts]
 * @returns {ScoutResult}
 */
function runScout(repo, providerId, opts) {
  const o = opts || {};
  const P = (o._providers || PROVIDERS)[providerId];
  if (!P) return { ok: false, provider: providerId, error: { key: "provider-unavailable", detail: "unknown" } };
  // 런타임 경계(검증 1차 blocker①): 어댑터의 available/probe/invoke가 던지거나 오형식을 내도 전부
  // ScoutFailure로 정규화한다 — 반쪽 형태로 파이프라인 진입·프로세스 예외로 이탈 금지(합타입 보장).
  let avail = false;
  try { avail = !!P.available(); } catch { avail = false; }
  if (!avail) {
    let det = "";
    try { det = String(((P.probe() || {}).detail) || ""); } catch { det = "probe-threw"; }
    return { ok: false, provider: providerId, error: { key: "provider-unavailable", detail: det } };
  }
  const pkg = collectPackage(repo);
  if (!pkg) return { ok: false, provider: providerId, error: { key: "not-git", detail: "" } };
  const lang = CL.loadLang(); // 지도 '원문' 언어 — 전역 언어(§6-8 후속(c) 계약 유지)
  // 신선도 기준선은 수집기가 seed 확정 직후 캡처한 것을 '전달만'(러너 재조사 금지 — Codex 반례 2026-07-10 계약 유지)
  const baseline = pkg.meta && typeof pkg.meta.basisTs === "string"
    ? { basisTs: pkg.meta.basisTs, ...(Array.isArray(pkg.meta.seedMissing) ? { seedMissing: pkg.meta.seedMissing } : {}), ...(pkg.meta.seedHashes && typeof pkg.meta.seedHashes === "object" ? { seedHashes: pkg.meta.seedHashes } : {}), ...(pkg.meta.nonGitFiles && typeof pkg.meta.nonGitFiles === "object" ? { nonGitFiles: pkg.meta.nonGitFiles } : {}) }
    : {};
  const md = renderPackageMarkdown(pkg, lang);
  const preface = providerId === "self" || providerId === "codex" ? CL.buildScoutPreface(providerId, lang) + "\n\n" : ""; // deepseek preface는 브릿지 buildMapRequest가 같은 슬롯에서 읽음(기존 계약) · codex는 CLI 팔이라 self와 같은 자리에서 주입(P6)
  markLive(repo, providerId); // 상태바 '지도 생성중…' — 호출 동안만
  let call;
  try { call = P.invoke({ preface, md, lang, repo, outFile: o.outFile || null }); }
  catch (e) { call = { ok: false, key: "call-failed", detail: "invoke-threw: " + ((e && e.message) || String(e)) }; } // 경계 정규화(예외→ScoutFailure)
  finally { clearLive(repo); }
  const sp = call && typeof call.stderrPass === "string" ? call.stderrPass : "";
  if (!call || call.ok !== true) {
    // 실패 결과도 검증(2차 잔여 f-710a3f76): key는 허용 열거로 정규화(미지 키=call-failed)·detail은 문자열화 —
    // 오형식 실패가 ScoutFailure 선언을 깨고 통과하는 경로 차단(합타입 런타임 보장 완결).
    const kRaw = call && typeof call.key === "string" ? call.key : "";
    const key = kRaw === "provider-unavailable" || kRaw === "not-git" || kRaw === "call-failed" ? kRaw : "call-failed";
    const detail = call && typeof call.detail === "string" ? call.detail : call && call.detail != null ? String(call.detail) : "";
    return { ok: false, provider: providerId, error: { key, detail }, stderrPass: sp };
  }
  // 성공 형태 검증(오형식 어댑터 정규화 — map은 문자열 필수·rawStdout은 주면 문자열): 반쪽 성공으로 진입 금지
  if (typeof call.map !== "string" || (call.rawStdout != null && typeof call.rawStdout !== "string")) {
    return { ok: false, provider: providerId, error: { key: "call-failed", detail: "invalid-adapter-result: " + (typeof call.map !== "string" ? "map" : "rawStdout") }, stderrPass: sp };
  }
  const map = call.map;
  // usage 형태 검증 — in/out이 유한 숫자가 아니면 null로 강등(정직: 오형식을 장부·메타에 싣지 않는다)
  const usage = call.usage && Number.isFinite(call.usage.in) && Number.isFinite(call.usage.out)
    ? { in: call.usage.in, out: call.usage.out, model: typeof call.usage.model === "string" ? call.usage.model : null }
    : null;
  // 추출·문자수는 provider가 원문을 주면 원문 기준(구 deepseek 러너=비트림 r.stdout — 동작 보존), 아니면 트림 지도 기준(self)
  const exSrc = call.rawStdout != null ? call.rawStdout : map;
  // 비용 장부(60일) — usage 없으면 null 그대로(정직: 토큰 아님·문자수만)
  try { CL.appendScoutUsage({ ts: new Date().toISOString(), workspace: repo, arm: providerId, model: usage ? usage.model : null, usageIn: usage ? usage.in : null, usageOut: usage ? usage.out : null, pkgChars: (preface + md).length, mapChars: exSrc.length }); } catch { /* 무해 */ }
  // --out: 브릿지가 직접 쓰는 팔(deepseek)은 위임 유지, 그 외는 여기서 씀(구 self 러너와 같은 위치·같은 비포획 —
  // 쓰기 실패는 구 러너처럼 그대로 전파되어 러너가 비정상 종료한다. 조용한 삼킴으로 바꾸지 않는다.)
  if (o.outFile && !P.handlesOutFile) fs.writeFileSync(o.outFile, map);
  // 게시판 보관 — 실패는 게시판에만 영향(기존 계약)
  let savedNote = "", saveErr = "";
  try {
    const meta = { ...(usage ? { usageIn: usage.in, usageOut: usage.out, model: usage.model } : {}), ...CL.scoutPromptSignature(lang), highlights: CL.extractMapHighlights(exSrc), mapPatches: CL.extractMapPatches(exSrc), basis: pkg.basisNote || (pkg.historyless ? "" : "git-status"), seedFiles: pkg.seeds, ...baseline, head: (pkg.meta && pkg.meta.head) || "" };
    savedNote = saveMap(repo, providerId, map, meta);
  } catch (e) { saveErr = (e && e.message) || "save-failed"; }
  // 관측 장부: ⑥(MAP patch) 제안 적재 — 실패가 지도 출력 흐름을 막지 않되(기존 계약), 결과 보고는 실제
  // 반환값 기반(검증 1차 blocker②: appendLedgerEvent는 실패 시 false — 무조건 "ok" 표기 금지).
  let ledgerNote = "";
  try {
    const now = new Date().toISOString();
    let anyFail = false, n = 0;
    for (const t of CL.extractMapPatches(exSrc)) { n++; if (CL.appendLedgerEvent(repo, { ts: now, type: "proposed", sig: CL.ledgerSig(t), text: t, from: providerId + " 지도 " + now }) === false) anyFail = true; }
    ledgerNote = n === 0 ? "" : anyFail ? "failed" : "ok";
  } catch { ledgerNote = "failed"; }
  return { ok: true, provider: providerId, map, usage, pkgChars: (preface + md).length, mapChars: exSrc.length, savedNote, saveErr, ledgerNote, stderrPass: sp, rawStdout: call.rawStdout != null ? call.rawStdout : null };
}

module.exports = { PROVIDERS, runScout, SELF_DENY };
