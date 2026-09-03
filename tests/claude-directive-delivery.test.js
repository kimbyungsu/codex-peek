"use strict";
/*
 * [HARNESS-REALIGNMENT §7 3-2b · §4-B ① Claude 쪽 규약 1회 전달 + ③ 하네스 문장→훅 장부 + 개선 4 (e)(d) — 2026-08-31] 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 매 턴 주입=사용자 규칙(그대로)+명령 줄(slim)+상태 줄+동적 신호 · 정적 지시(규칙 문장·원격 확인·전달 원칙·수칙 인지·설계 경위·재판단 규약)는
 * 세션 첫 턴·세션 시작 훅 리셋(압축/재개)·세대 변경에만 전문 · 판정 꼬리의 재판단 규약은 전달 지문과 같으면 포인터 1줄 ·
 * 지시문에서 뺀 문장은 DIRECTIVE_MOVED 장부(훅·시험 결속)에만 · 사용자 글(transmit·규칙)은 바이트 그대로.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cdlv-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const INJECT = path.join(__dirname, "..", "bridge", "contract-inject.js");
const SSTART = path.join(__dirname, "..", "bridge", "session-start.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NL = String.fromCharCode(10);
const sha16 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cdlv-repo-"));
fs.writeFileSync(path.join(repo, "verify-envelope.json"), JSON.stringify({ schema: "verify-envelope-v1", supportedEnv: ["혼자 쓰는 로컬 PC"], alwaysBlocker: ["기록이 남의 장부에 적히는 일", "설정이 사라지는 일"], outOfScope: ["서버 두 대에 동시 배포"] }));
const sha = CL.readVerifyEnvelope(repo).sha1;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cdlv-ws-"));
const RULES = ["기술용어를 제외하고 상황예시로 정리하라", "모든 수정 후 테스트까지 진행하라"];
CL.updateContractPatch(ws, "ko", { envelopeHash: sha, scoutRepo: repo, claude: RULES, claudeInjectMode: "always", verifyMode: "always", verifyProfile: "core", verifyBudget: 5 }, { tries: 3 });
const SID = "cdlv-session-0001";
const runInject = (prompt, sid) => {
  const r = cp.spawnSync(process.execPath, [INJECT], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sid || SID, cwd: ws, prompt, permission_mode: "default" }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws, CLAUDE_CODE_SESSION_ID: sid || SID }), cwd: ws });
  assert.strictEqual(r.status, 0, r.stderr);
  const o = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return o && o.hookSpecificOutput ? String(o.hookSpecificOutput.additionalContext || "") : "";
};
const anchor = (sid) => JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, (sid || SID) + ".json"), "utf8"));

t("문장 조각 단일 출처 — full=slim+static 구성·훅으로 옮긴 문장은 어느 쪽에도 없음·사용자 글(transmit) 바이트 그대로·기존 핀 문장 유지", () => {
  for (const lang of ["ko", "en"]) {
    const full = CL.buildVerifyDirective("always", lang, "core", { tracked: true, count: 2, budget: 5 });
    const slim = CL.buildVerifyDirectiveSlim("always", lang, "core", { tracked: true, count: 2, budget: 5 });
    const stat = CL.buildVerifyDirectiveStatic("always", lang, "core");
    const pieces = CL.verifyDirectivePieces("always", lang, "core", null);
    assert.ok(full.includes(pieces.header) && full.includes(pieces.rules) && full.includes(pieces.remote) && full.includes(pieces.transmit) && full.includes(pieces.rejudgeLine));
    assert.ok(slim.startsWith(pieces.header) && slim.includes("ask-start --allow-new") && slim.includes("ask-wait") && !slim.includes(pieces.rules) && !slim.includes("[원격 확인]") && !slim.includes("[Remote checks]"), "slim = header+commands+progress only");
    assert.ok(stat.includes(pieces.rules) && stat.includes(pieces.remote) && stat.includes(pieces.transmit) && stat.includes(pieces.rejudgeLine) && !stat.includes("ask-start --allow-new"), "static = rules+remote+transmit+rejudge line");
    const base = CL.loadBaseDirective(lang, "core");
    assert.ok(stat.includes(base.transmit) && full.includes(base.transmit), "user-editable transmit text byte-identical");
    for (const m of CL.DIRECTIVE_MOVED) { const sent = lang === "en" ? m.en : m.ko; assert.ok(!full.includes(sent) && !slim.includes(sent) && !stat.includes(sent), "moved sentence absent: " + m.id); }
    assert.ok(slim.length <= 700, `${lang} slim ${slim.length} ≤ 700 (개선 4 (e): 명령 줄+진행도만 — ko ≈450·en ≈610)`);
  }
  assert.ok(CL.buildVerifyDirective("always", "ko").includes("물을 때는 반드시 선택지 도구로 제시하라") && CL.buildVerifyDirective("always", "ko").includes("유일한 제동"), "non-hook-enforceable sentences stay (pins)");
});

t("§4-B ③ 장부 — 행이 있으면 문장마다 훅·실행 반례 시험이 실존(파일 존재+제목 문자열)·현재 0행(후보 문장은 훅이 모든 경로를 막지 못해 지시문 유지)", () => {
  assert.ok(Array.isArray(CL.DIRECTIVE_MOVED));
  assert.strictEqual(CL.DIRECTIVE_MOVED.length, 0, "no sentence is removed until a hook blocks its violation on every path");
  assert.ok(CL.buildVerifyDirectiveStatic("always", "ko", "core").includes("사용자 판단 항목이 있을 때만 한 번에 묻고, 없으면 선택지를 만들지 마라.") && CL.buildVerifyDirectiveStatic("always", "en", "core").includes("Ask one combined question only when a genuine user-decision item exists"), "the candidate sentence stays in the standing directives");
  for (const m of CL.DIRECTIVE_MOVED) {
    assert.ok(m.id && m.ko && m.en && Array.isArray(m.hooks) && m.hooks.length && Array.isArray(m.tests) && m.tests.length, "ledger row shape: " + m.id);
    for (const ts of m.tests) {
      const f = path.join(__dirname, "..", ts.file);
      assert.ok(fs.existsSync(f), "test file exists: " + ts.file);
      assert.ok(fs.readFileSync(f, "utf8").includes(ts.needle), "test needle present: " + ts.file + " :: " + ts.needle);
    }
    const base = CL.loadBaseDirective("ko", "core");
    assert.ok(!base.transmit.includes(m.ko) && !base.rejudge.includes(m.ko), "moved sentence is harness-owned, not user text");
  }
});

t("첫 턴=정적 지시 전문+명령 줄+상태 줄(사유: 첫 턴) · 앵커에 전달 기록 · 사용자 규칙은 매 턴 그대로", () => {
  const out = runInject("첫 질문 — 잠금 경합을 고쳐라");
  assert.ok(out.includes("[규약 전달 · Claude] 세대 ") && out.includes("이번 턴 정적 지시 전문 전송(사유: 이 세션 첫 턴(전달 기록 없음))"), out.split(NL).find((l) => l.startsWith("[규약 전달")));
  assert.ok(out.includes("[검증 모드 ON(always)") && out.includes("ask-start --allow-new") && out.includes("[원격 확인]") && out.includes("[전달 원칙") && out.includes("[재판단 규약 — 이 세션에 1회 전달") && out.includes("[수칙 인지 —") && out.includes("> ab-2: 설정이 사라지는 일"), "full static block present");
  assert.ok(out.includes(JSON.stringify({ n: 1, r: RULES[0] }).slice(1, -1)) && out.includes(JSON.stringify({ n: 2, r: RULES[1] }).slice(1, -1)), "user rules verbatim");
  const a = anchor();
  assert.ok(a.directive && typeof a.directive.gen === "string" && a.directive.parts && a.directive.parts.rejudge === sha16(CL.safeLoadRejudge("ko", "core")) && a.directive.sentAt, "anchor delivery record with part fingerprints");
  assert.strictEqual(a.workspace, ws, "anchor still carries the workspace (per-project separation)");
});

let slimLen = 0;
t("둘째 턴=명령 줄+상태 줄(재전송 없음)+사용자 규칙+동적 신호만 — 정적 지시 없음 · 하네스 소유 매 턴 주입 ≤ 1,500자(예산 상수·사용자 규칙 제외) · 앵커 기록 유지", () => {
  const out = runInject("둘째 질문 — 시험 추가");
  assert.ok(out.includes("[규약 전달 · Claude] 세대 ") && out.includes("재전송 없음 — 정적 지시는 이 세션"), out.split(NL).find((l) => l.startsWith("[규약 전달")));
  assert.ok(out.includes("[검증 모드 ON(always)") && out.includes("ask-start --allow-new"), "slim command lines every turn");
  assert.ok(!out.includes("[원격 확인]") && !out.includes("[전달 원칙") && !out.includes("[재판단 규약") && !out.includes("[수칙 인지 —") && !out.includes("유일한 제동"), "static directives not resent");
  assert.ok(out.includes(JSON.stringify({ n: 1, r: RULES[0] }).slice(1, -1)), "user rules still every turn (user's own setting)");
  // [확인 검증 1회차 blocker①] 사용자 규칙은 사용자 글이라 예산 밖(길이 제한 없음 — 그 사용자의 선택). 하네스 소유분(명령 줄+상태 줄+동적 신호)만 잰다.
  const cRB = CL.loadContract(ws, "ko"); const effRB = CL.effectiveRuleCheck(cRB, "claude", "normal"); // [RULE-COMPLIANCE §3 A] 점검 블록 머리에 규칙 목록 지문(required일 때)
  const rulesBlock = CL.buildInjection(RULES, "Claude Code", cRB.claudeChecklist, "ko", effRB.mode === "required" ? CL.ruleCheckFp8(effRB) : "");
  assert.ok(out.includes(rulesBlock), "user rules block present verbatim");
  slimLen = out.length - rulesBlock.length;
  assert.ok(slimLen <= CL.claudeTurnBudgetTotal(), `harness-owned per-turn injection ${slimLen} ≤ ${CL.claudeTurnBudgetTotal()} (user rules excluded — user text, unbounded by design)`);
  // [확인 검증 2회차] 안내(지도 상태 신호)가 붙는 slim 턴도 예산 안 — 정찰 켜고 지도 없음 → '지도 없음' 안내가 실제로 붙는 턴에서 측정
  CL.updateContractPatch(ws, "ko", { scoutMode: "on" }, { tries: 3 });
  const outS = runInject("지도 없는 상태의 질문");
  assert.ok(outS.includes("재전송 없음"), "still slim (static gen unchanged by scout mode)");
  const rulesS = CL.buildInjection(RULES, "Claude Code", CL.loadContract(ws, "ko").claudeChecklist, "ko");
  const envDynS = (() => { const ep = CL.implementerEnvelopeInjectParts(ws, CL.loadContract(ws, "ko"), "ko", "", ""); return ep && ep.dyn ? String(ep.dyn).replace(/^\n+/, "") : ""; })();
  const harnessS = outS.length - rulesS.length - (envDynS && outS.includes(envDynS) ? envDynS.length : 0);
  assert.ok(/지도|MAP|scout|정찰/.test(outS.replace(rulesS, "")), "an advisory (map/scout signal) is present in this turn");
  assert.ok(harnessS <= CL.claudeTurnBudgetTotal(), `harness-owned incl. advisory ${harnessS} ≤ ${CL.claudeTurnBudgetTotal()}`);
  CL.updateContractPatch(ws, "ko", { scoutMode: "off" }, { tries: 3 });
  // [확인 검증 3회차] 조립 '전체'(전환 고지+slim+상태 줄+안내+구분자) ≤ 1,500 — 단위 반례: 경계 입력·전환 고지 동반·큰 고정 조각
  const T9 = CL.claudeTurnBudgetTotal(); assert.strictEqual(T9, 1500);
  const assembled = (fixed, r) => [...fixed, ...r.texts].join(NL + NL).length;
  const big = "x".repeat(2000);
  const f1 = ["x".repeat(600), "y".repeat(200)];
  const b1 = CL.applyClaudeTurnBudget({ fixed: f1, advisories: [big, "짧은 안내"] }, "ko");
  assert.ok(assembled(f1, b1) <= T9 && b1.texts[0].includes("(안내가 매 턴 예산으로 절단: 2000 → ") && b1.clipped[1].omitted === true, JSON.stringify({ len: assembled(f1, b1), clipped: b1.clipped }));
  const fEdge = ["s".repeat(300), "x".repeat(700), "y".repeat(250)]; // 전환 고지·slim·상태 줄 각 상한 — 구분자까지 세어도 총량 안
  const bE = CL.applyClaudeTurnBudget({ fixed: fEdge, advisories: ["a".repeat(550), "b".repeat(50)] }, "ko");
  assert.ok(assembled(fEdge, bE) <= T9, "boundary inputs incl. separators ≤ 1,500 (" + assembled(fEdge, bE) + ")");
  const fReal = [CL.harnessModeSwitchNotice("en"), "x".repeat(575), "y".repeat(137)]; // 검증자가 잰 실제 값(전환 고지 256·slim 575·상태 137)
  const bR = CL.applyClaudeTurnBudget({ fixed: fReal, advisories: ["a".repeat(550)] }, "en");
  assert.ok(assembled(fReal, bR) <= T9, "switch notice counted (" + assembled(fReal, bR) + ")");
  const bOver = CL.applyClaudeTurnBudget({ fixed: ["x".repeat(1600)], advisories: ["안내"] }, "ko");
  assert.ok(bOver.overflow === true && bOver.texts.length === 0 && bOver.clipped[0].omitted === true, "fixed over the total → overflow flag + advisories omitted");
  assert.deepStrictEqual(CL.applyClaudeTurnBudget({ fixed: ["x".repeat(500), "y".repeat(100)], advisories: ["a", "b"] }, "en").texts, ["a", "b"]);
  // 고정 조각의 구성 상한(코드 소유 문장 — 시험이 보장): slim ≤700(모드·언어·진행도 전부), 상태 줄 ≤250(사유 전부), 전환 고지 ≤300
  for (const lang of ["ko", "en"]) {
    for (const mode of ["always", "plancode", "code"]) for (const prof of ["core", "integrity"]) {
      assert.ok(CL.buildVerifyDirectiveSlim(mode, lang, prof, { tracked: true, count: 99, budget: 99 }).length <= CL.CLAUDE_TURN_BUDGET.slim, `slim ${lang}/${mode}/${prof} ≤ 700`);
    }
    const parts9 = CL.claudeStaticParts(ws, CL.loadContract(ws, "ko"), lang, { provenance: "p" });
    const plans = [CL.claudeDeliveryPlan(null, null, parts9), CL.claudeDeliveryPlan(null, { source: "compact", ts: "t" }, parts9), CL.claudeDeliveryPlan({ gen: "0000000000000000", parts: {} }, null, parts9), CL.claudeDeliveryPlan(CL.claudeStaticGen(parts9), null, parts9)];
    for (const pl of plans) assert.ok(CL.claudeDeliveryStatusLine(pl, lang, "2026-08-31T00:00:00.000Z").length <= CL.CLAUDE_TURN_BUDGET.status, `status ${lang}/${pl.reason} ≤ 250 (${CL.claudeDeliveryStatusLine(pl, lang, "2026-08-31T00:00:00.000Z").length})`);
    assert.ok(CL.harnessModeSwitchNotice(lang).length <= 300, `switch notice ${lang} ≤ 300`);
  }
  const ci9 = fs.readFileSync(INJECT, "utf8");
  assert.ok(ci9.includes("switchNotice = harnessModeSwitchNotice(lang);") && ci9.includes("fixed: [...(switchNotice ? [switchNotice] : []), slimText9, statusText9]"), "switch notice is a fixed piece of the per-turn budget");
  assert.ok(anchor().directive && anchor().directive.gen, "record kept across turns");
});

t("세대 변경 — 사용자가 기본 지침(전달 원칙)을 고치면 다음 턴 전문+상태 줄에 바뀐 성분 표기 · 프로필 전환도 성분 표기", () => {
  const base = CL.loadBaseDirective("ko", "core");
  assert.strictEqual(CL.saveBaseDirective({ ...base, transmit: base.transmit + "\n- 파일·라인을 근거로 대라(프로젝트 추가)" }, "ko", "core"), true, "saveBaseDirective(obj, lang, profile) → true");
  const out = runInject("셋째 질문");
  assert.ok(out.includes("전문 전송(사유: 규약 변경: 검증 지시·원격 확인·전달 원칙)"), out.split(NL).find((l) => l.startsWith("[규약 전달")));
  assert.ok(out.includes("파일·라인을 근거로 대라(프로젝트 추가)"), "edited user text sent verbatim");
  CL.saveBaseDirective(base, "ko", "core"); // 원복 → 다시 세대 변경(전문)
  const out2 = runInject("넷째 질문");
  assert.ok(out2.includes("전문 전송(사유: 규약 변경:"), "restoring the text is a change too (gen-bound)");
  const out3 = runInject("다섯째 질문");
  assert.ok(out3.includes("재전송 없음"), "then slim again");
  CL.updateContractPatch(ws, "ko", { verifyProfile: "integrity" }, { tries: 3 });
  const out4 = runInject("여섯째 질문");
  assert.ok(out4.includes("전문 전송(사유: 규약 변경:") && out4.includes("프로필"), out4.split(NL).find((l) => l.startsWith("[규약 전달")));
  CL.updateContractPatch(ws, "ko", { verifyProfile: "core" }, { tries: 3 });
  runInject("일곱째 질문"); // gen back → full once
  assert.ok(runInject("여덟째 질문").includes("재전송 없음"));
});

t("세션 시작 훅(compact/resume) — 앵커 기록 리셋 → 다음 턴 전문(사유: 세션 compact) · 앵커 없는 세션은 무동작", () => {
  const r = cp.spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SID, source: "compact", cwd: ws }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }) });
  assert.strictEqual(r.status, 0, r.stderr);
  const a = anchor();
  assert.strictEqual(a.directive, null); assert.strictEqual(a.directiveReset.source, "compact"); assert.strictEqual(a.workspace, ws, "anchor workspace preserved");
  const out = runInject("압축 뒤 질문");
  assert.ok(out.includes("전문 전송(사유: 세션 compact(세션 시작 훅이 감지한 압축/재개/시작))") && out.includes("[원격 확인]") && out.includes("[재판단 규약 — 이 세션에 1회 전달"), out.split(NL).find((l) => l.startsWith("[규약 전달")));
  assert.ok(!anchor().directiveReset, "reset flag consumed");
  assert.ok(runInject("그 다음 질문").includes("재전송 없음"));
  const r2 = cp.spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "no-anchor-session", source: "startup" }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }) });
  assert.strictEqual(r2.status, 0); assert.ok(!fs.existsSync(path.join(CL.ACTIVE_DIR, "no-anchor-session.json")), "no anchor → nothing written");
  // [확인 검증 1회차 blocker③] 앵커 쓰기 실패=마커 폴백(다음 턴 전문)·둘 다 실패=ok:false(훅 비0 종료)
  runInject("마커 시험 전 정상 턴"); // 기록 있음(slim 상태)
  const anchorFile = path.join(CL.ACTIVE_DIR, SID + ".json");
  const origAtomic = CL.atomicWrite;
  let calls = 0; CL.__setAtomicWriteForTest && CL.__setAtomicWriteForTest(null);
  // atomicWrite를 직접 대체할 수 없으므로 실물 폴백은 '앵커 파일을 디렉터리로 바꿔' rename 실패를 유도한다
  const backup = fs.readFileSync(anchorFile, "utf8");
  fs.unlinkSync(anchorFile); fs.mkdirSync(anchorFile); fs.writeFileSync(path.join(anchorFile, "x"), "x");
  // [확인 검증 2회차] 부재가 아닌 판독 오류(EISDIR·손상)는 no-anchor가 아니다 — 옛 기록이 살아날 수 있으므로 마커 채널로 리셋
  const rr = CL.resetClaudeDirectiveDelivery(SID, "compact");
  assert.strictEqual(rr.via, "marker", "read error (not ENOENT) → marker fallback: " + JSON.stringify(rr));
  assert.ok(fs.existsSync(CL.claudeDirectiveResetMarkerFor(SID)));
  fs.rmSync(anchorFile, { recursive: true, force: true }); fs.writeFileSync(anchorFile, backup); // 옛 앵커(기록 있음) 복구 — 마커가 살아 있어야 다음 턴이 전문
  const outR = runInject("판독 오류 복구 뒤 질문");
  assert.ok(outR.includes("전문 전송(사유: 세션 compact(") && !fs.existsSync(CL.claudeDirectiveResetMarkerFor(SID)), "recovered stale anchor + marker → full, marker consumed: " + outR.split(NL).find((l) => l.startsWith("[규약 전달")));
  assert.strictEqual(CL.resetClaudeDirectiveDelivery("cdlv-never-existed", "compact").via, "no-anchor", "ENOENT only = no-anchor");
  void origAtomic; void calls;
  // 단위 반례: 앵커 폴더 자체를 읽기 전용 파일로 막을 수 없으니 마커 채널을 직접 검증 — 마커만 있어도 다음 턴은 전문이고 소거된다
  fs.writeFileSync(CL.claudeDirectiveResetMarkerFor(SID), JSON.stringify({ schema: "claude-directive-reset-v1", session: SID, source: "resume", ts: new Date().toISOString() }));
  const outM = runInject("마커 뒤 질문");
  assert.ok(outM.includes("전문 전송(사유: 세션 resume(") && outM.includes("[원격 확인]"), outM.split(NL).find((l) => l.startsWith("[규약 전달")));
  assert.ok(!fs.existsSync(CL.claudeDirectiveResetMarkerFor(SID)), "marker consumed after delivery");
  assert.ok(runInject("마커 소거 뒤 질문").includes("재전송 없음"));
  const src9 = fs.readFileSync(SSTART, "utf8");
  assert.ok(src9.includes("if (!r.ok) {") && src9.includes("process.exit(1);") && src9.includes("directive delivery reset FAILED"), "hook exits non-zero with a message when both channels fail (no silent fail-open)");
  // 다른 세션 id=다른 앵커(세션 단위 분리) → 그 세션의 첫 턴은 전문
  assert.ok(runInject("다른 세션 첫 질문", "cdlv-session-0002").includes("사유: 이 세션 첫 턴"));
});

t("판정 꼬리 — 이 세션에 전달된 재판단 규약과 같은 지문이면 포인터 1줄, 아니면(리셋·다른 세션·다른 문안) 전문", () => {
  const CB = require("../bridge/codex-bridge.js");
  const rj = CL.safeLoadRejudge("ko", "core");
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  const a = anchor(); assert.strictEqual(a.directive.parts.rejudge, sha16(rj));
  const ptr = CB.rejudgeTailFor(rj, "ko");
  assert.ok(ptr.startsWith("세대 " + a.directive.gen.slice(0, 8) + " — 이 세션 " + a.directive.sentAt + " 턴에 전달된 규약 문안 그대로"), ptr);
  const tail = CL.formatForClaude("x" + NL + "검증: 실패", "ko", "core", null, ptr);
  assert.ok(tail.includes("[재판단 규약 — 이 검증이 시작될 때 확정된 문안]" + NL + "세대 ") && !tail.includes("- 모든 지적(blocker 포함)을"), "tail carries the pointer, not the full protocol");
  assert.ok(tail.length < CL.formatForClaude("x" + NL + "검증: 실패", "ko", "core", null, rj).length - 1000, "tail shrinks by >1,000 chars");
  assert.strictEqual(CB.rejudgeTailFor(rj + " 변경", "ko"), rj + " 변경", "different text → full");
  process.env.CLAUDE_CODE_SESSION_ID = "cdlv-session-9999";
  assert.strictEqual(CB.rejudgeTailFor(rj, "ko"), rj, "no anchor for this session → full");
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  cp.spawnSync(process.execPath, [SSTART], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: SID, source: "compact" }), encoding: "utf8", env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME }) });
  assert.strictEqual(CB.rejudgeTailFor(rj, "ko"), rj, "after a compaction reset → full until the next turn re-delivers");
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

t("전달 기록은 '출력이 실제로 전달된 뒤'에만 — stdout 파이프가 닫힌 채 실행되면 기록이 남지 않아 다음 턴이 전문을 보낸다", () => {
  // [확인 검증 1회차 blocker②] 출력 전 종료·파이프 실패 반례: 부모가 읽기 끝을 즉시 닫는다 → 자식의 write는 실패/미전달 → 기록 없음
  const sidP = "cdlv-session-pipe";
  const child = cp.spawn(process.execPath, [INJECT], { env: Object.assign({}, process.env, { CODEX_BRIDGE_HOME: HOME, CLAUDE_PROJECT_DIR: ws, CLAUDE_CODE_SESSION_ID: sidP }), cwd: ws, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.destroy(); // 읽기 끝 즉시 폐기(EPIPE/EOF 유도)
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sidP, cwd: ws, prompt: "파이프 시험", permission_mode: "default" }));
  const done = cp.spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 1500)"]); void done; // 자식 종료 대기(단순 지연)
  const a = fs.existsSync(path.join(CL.ACTIVE_DIR, sidP + ".json")) ? JSON.parse(fs.readFileSync(path.join(CL.ACTIVE_DIR, sidP + ".json"), "utf8")) : null;
  assert.ok(!a || !a.directive, "no delivery record when the output could not be delivered: " + JSON.stringify(a && a.directive));
  const outN = runInject("파이프 뒤 정상 턴", sidP);
  assert.ok(outN.includes("이번 턴 정적 지시 전문 전송"), "next successful turn sends the full directives");
  const ci = fs.readFileSync(INJECT, "utf8");
  assert.ok(ci.indexOf("const outJson = JSON.stringify(") < ci.indexOf("const finalize = (err) => {") && ci.includes("process.stdout.write(outJson, (err) => finalize(err));") && ci.indexOf("writeAnchors(JSON.stringify({ ...anchorBase, directive: dlvPlan.record }))") > ci.indexOf("const finalize = (err) => {"), "record write lives inside the stdout write callback");
});

t("설치 정합 — SessionStart 훅·session-start.js가 설치기·hook-setup 양쪽 목록에 있고 스크립트가 배포 목록에 포함", () => {
  const inst = require("../install.js");
  assert.ok(inst.OUR_HOOKS.some((h) => h.event === "SessionStart" && h.script === "session-start.js") && inst.BRIDGE_SCRIPTS.includes("session-start.js") && inst.isOurHookCmd('node "C:/u/.codex-bridge/session-start.js"'), "installer knows the SessionStart hook script");
  const hs = fs.readFileSync(path.join(__dirname, "..", "src", "hook-setup.ts"), "utf8");
  assert.ok(hs.includes('{ event: "SessionStart", matcher: "", script: "session-start.js" }') && hs.includes('"preview-gate.js", "session-start.js"]'));
  assert.ok(fs.existsSync(SSTART));
  const ci = fs.readFileSync(INJECT, "utf8");
  assert.ok(ci.includes("buildVerifyDirectiveSlim(c.verifyMode, undefined, c.verifyProfile, progress9)") && ci.includes("if (dlvPlan.mode === \"full\") parts.push(claudeStaticBlock(sp9, lang));") && ci.includes("writeAnchors(JSON.stringify({ ...anchorBase, directive: dlvPlan.record }))"), "injector wiring");
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(ext.includes("훅으로 옮긴 규칙 ") && ext.includes("DIRECTIVE_MOVED"), "dashboard fold reads the same ledger");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
