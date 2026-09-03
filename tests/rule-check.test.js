"use strict";
/*
 * [RULE-COMPLIANCE v5 §3 — 2026-09-03] 구현자 규칙 준수 구조 실행 시험(격리 CODEX_BRIDGE_HOME).
 * 계약: 하네스는 규칙 내용을 해석하지 않는다(개수·번호·목록 지문만). 체크리스트 옵션이 켜지고 규칙이 주입된 턴(required)은 마지막 답 끝에
 * [계약점검 <지문8>] 블록(규칙마다 n) 준수|위반|해당없음 — 근거)이 있어야 종료 — 없으면 규칙 원문을 실어 되돌린다. 옵션 꺼짐·주입 모드 off·규칙 0개=무검사.
 * 턴 중 규칙 편집=유효 설정 재계산·앵커 원자 교체·새 전문 동봉. 위반 표기 허용·장부(근거 지문만)·상한 해제=미기재+노랑 경보. 검증자 무관.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
process.env.CODEX_BRIDGE_HOME = HOME;
const CL = require("../bridge/contract-lib.js");
const GUARD = path.join(__dirname, "..", "bridge", "verify-guard.js");
const INJECT = path.join(__dirname, "..", "bridge", "contract-inject.js");
const CHOOK = path.join(__dirname, "..", "bridge", "codex-hook.js");
let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const NL = String.fromCharCode(10);
const RULES = ["기술용어를 제외하고 상황예시로 정리하라", "모든 수정 후 필요한 테스트까지 진행하라", "버전업은 사용자 승인 후"];
const block = (fp8, marks) => `[계약점검 ${fp8}]` + NL + marks.map((m, i) => `- ${i + 1}) ${m} — 이 답의 해당 부분을 직접 확인함`).join(NL);

t("유효 설정 — 옵션 켜짐∧주입됨∧규칙≥1=required(지문·개수) · 옵션 꺼짐/주입 off/규칙 0=disabled · plan 모드는 plan 턴만 · 미상(unknown)=주입됐을 수 있음(off만 disabled)", () => {
  const base = { claude: RULES, claudeChecklist: true, claudeInjectMode: "always" };
  const e1 = CL.effectiveRuleCheck(base, "claude", "normal");
  assert.ok(e1.mode === "required" && e1.rulesN === 3 && /^[0-9a-f]{40}$/.test(e1.rulesFp) && e1.rules.length === 3);
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claudeChecklist: false }, "claude", "normal").mode, "disabled");
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claudeInjectMode: "off" }, "claude", "normal").mode, "disabled");
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claude: [] }, "claude", "normal").mode, "disabled");
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claudeInjectMode: "plan" }, "claude", "normal").mode, "disabled");
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claudeInjectMode: "plan" }, "claude", "plan").mode, "required");
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claudeInjectMode: "plan" }, "claude", "unknown").mode, "required", "anchor unknown + plan mode → required (safe direction)");
  assert.strictEqual(CL.effectiveRuleCheck({ ...base, claudeInjectMode: "off" }, "claude", "unknown").mode, "disabled");
  const cx = { codexImplementer: RULES.slice(0, 2), codexImplementerChecklist: true, codexInjectMode: "always" };
  assert.ok(CL.effectiveRuleCheck(cx, "codex", "normal").mode === "required" && CL.effectiveRuleCheck(cx, "codex", "normal").rulesN === 2);
  assert.strictEqual(CL.rulesFpOf([" a ", "", "b"]), CL.rulesFpOf(["a", "b"]), "trim+empty removal only (no interpretation)");
  assert.notStrictEqual(CL.rulesFpOf(["a", "b"]), CL.rulesFpOf(["b", "a"]), "order matters (fingerprint of the ordered list)");
  assert.ok(CL.ruleCheckSame(e1, CL.effectiveRuleCheck(base, "claude", "plan")) && !CL.ruleCheckSame(e1, CL.effectiveRuleCheck({ ...base, claude: RULES.slice(0, 2) }, "claude", "normal")));
});

t("블록 파서·판정 — 마지막 블록 기준·지문 대조·번호 전부·근거 8~200자·민감정보 형태 거부·위반 표기 허용·영문 표기 인정·N 넘는 번호 무시", () => {
  const eff = CL.effectiveRuleCheck({ claude: RULES, claudeChecklist: true, claudeInjectMode: "always" }, "claude", "normal");
  const fp8 = CL.ruleCheckFp8(eff);
  assert.deepStrictEqual(CL.ruleCheckVerdict("점검 없음", eff).reason, "missing-block");
  assert.deepStrictEqual(CL.ruleCheckVerdict(block("deadbeef", ["준수", "준수", "준수"]), eff).reason, "fp-mismatch");
  const ok1 = CL.ruleCheckVerdict("본문" + NL + block(fp8, ["준수", "위반", "해당없음"]), eff);
  assert.ok(ok1.ok && ok1.marks.length === 3 && ok1.marks[1].mark === "violated" && ok1.marks[2].mark === "n/a" && /^[0-9a-f]{16}$/.test(ok1.marks[0].reasonFp), JSON.stringify(ok1));
  const inc = CL.ruleCheckVerdict(block(fp8, ["준수", "준수"]), eff);
  assert.ok(!inc.ok && inc.reason === "incomplete" && inc.missing.join() === "3", JSON.stringify(inc));
  const short = CL.ruleCheckVerdict(`[계약점검 ${fp8}]` + NL + "1) 준수 — 짧음" + NL + "2) 준수 — 충분히 긴 근거 문장" + NL + "3) 준수 — 충분히 긴 근거 문장", eff);
  assert.ok(!short.ok && short.bad.length === 1 && short.bad[0].n === 1 && short.bad[0].issue === "reason-short", JSON.stringify(short));
  const secret = CL.ruleCheckVerdict(`[계약점검 ${fp8}]` + NL + "1) 준수 — 토큰 sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 사용" + NL + "2) 준수 — 충분히 긴 근거 문장" + NL + "3) 준수 — 충분히 긴 근거 문장", eff);
  assert.ok(!secret.ok && secret.bad.some((b) => b.n === 1 && /sensitive/.test(b.issue)), JSON.stringify(secret));
  const en = CL.ruleCheckVerdict(`[Contract Check ${fp8}]` + NL + "1) complies — checked the examples in this reply" + NL + "2) n/a — no code change here" + NL + "3) violated — bumped without approval, noted", eff);
  assert.ok(en.ok && en.marks[2].mark === "violated");
  const two = CL.ruleCheckVerdict(block("00000000", ["준수", "준수", "준수"]) + NL + NL + block(fp8, ["준수", "준수", "준수"]) + NL + "4) 준수 — 존재하지 않는 규칙 번호는 무시", eff);
  assert.ok(two.ok && two.marks.length === 3, "last block wins; extra numbers ignored");
  // [1회차 blocker①] 답 끝·연속·구분자 강제
  assert.strictEqual(CL.ruleCheckVerdict(block(fp8, ["준수", "준수", "준수"]) + NL + NL + "그리고 일반 보고가 이어집니다.", eff).reason, "not-at-end", "prose after the block → not at end");
  assert.strictEqual(CL.ruleCheckVerdict(`[계약점검 ${fp8}]` + NL + "1) 준수 충분히 긴 근거 문장인데 구분자가 없음" + NL + "2) 준수 — 충분히 긴 근거 문장" + NL + "3) 준수 — 충분히 긴 근거 문장", eff).reason, "not-at-end", "missing separator → line is not a check line");
  assert.strictEqual(CL.ruleCheckVerdict(`[계약점검 ${fp8}]` + NL + "1) 준수 — 충분히 긴 근거 문장" + NL + "중간에 일반 문단이 끼어 있음" + NL + "2) 준수 — 충분히 긴 근거 문장" + NL + "3) 준수 — 충분히 긴 근거 문장", eff).reason, "not-at-end", "non-contiguous block → rejected");
  assert.ok(CL.ruleCheckVerdict("본문" + NL + NL + `[계약점검 ${fp8}]` + NL + NL + "1) 준수 — 충분히 긴 근거 문장" + NL + "2) 준수 — 충분히 긴 근거 문장" + NL + NL + "3) 준수 — 충분히 긴 근거 문장" + NL + NL, eff).ok, "blank lines inside/after are fine");
  assert.ok(CL.ruleCheckInstruction("ko", eff, { reason: "not-at-end" }, "not-at-end").includes("답의 맨 끝이어야"));
  assert.ok(CL.ruleCheckVerdict("아무 답", { mode: "disabled", rulesN: 0 }).ok, "disabled → ok");
  const ins = CL.ruleCheckInstruction("ko", eff, CL.ruleCheckVerdict(block(fp8, ["준수"]), eff), "incomplete");
  assert.ok(ins.startsWith("[규칙 자가점검] 빠지거나") && ins.includes("2, 3") && ins.includes(`[계약점검 ${fp8}]`) && ins.includes(JSON.stringify({ rules: RULES.map((r, i) => ({ n: i + 1, r })) })), ins.slice(0, 400));
  assert.ok(CL.ruleCheckInstruction("en", eff, null, "rules-changed").startsWith("[Rule self-check] The rule list changed") && CL.ruleCheckInstruction("ko", eff, null, "rules-changed").includes("규칙 목록이 바뀌었습니다"));
  const inj = CL.buildInjection(RULES, "Claude Code", true, "ko", fp8);
  assert.ok(inj.includes(`[계약점검 ${fp8}]`) && inj.includes("머리의 지문 그대로"), inj);
  assert.ok(!CL.buildInjection(RULES, "Claude Code", false, "ko", fp8).includes("계약점검"), "checklist off → no block request");
});

// ── 종료 훅 실행 반례(Claude) ──
function normWs(p) { return path.normalize(p || "").replace(/[\\/]+$/, "").toLowerCase().normalize("NFC"); }
function setup(name, contract) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc_" + name + "_"));
  const bridgeDir = path.join(dir, ".codex-bridge"); const ws = path.join(dir, "ws");
  fs.mkdirSync(path.join(bridgeDir, "contracts"), { recursive: true }); fs.mkdirSync(ws, { recursive: true });
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  const cf = path.join(bridgeDir, "contracts", key + ".json");
  fs.writeFileSync(cf, JSON.stringify(Object.assign({ verifyMode: "off", claude: RULES, claudeChecklist: true, claudeInjectMode: "always" }, contract || {})));
  return { dir, bridgeDir, ws, session: "sess-" + name, tx: path.join(dir, "tx.jsonl"), cf, setContract: (patch) => fs.writeFileSync(cf, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(cf, "utf8")), patch))) };
}
const T0 = "2026-09-03T10:00:00.000Z", TA = "2026-09-03T10:00:06.000Z";
const human = (sb) => ({ type: "user", sessionId: sb.session, timestamp: T0, message: { content: [{ type: "text", text: "고쳐줘" }] } });
const say = (sb, text) => ({ type: "assistant", sessionId: sb.session, timestamp: TA, message: { content: [{ type: "text", text }] } });
const putTx = (sb, entries) => fs.writeFileSync(sb.tx, entries.map((e) => JSON.stringify(e)).join(NL));
const env = (sb, extra) => Object.assign({}, process.env, { CODEX_BRIDGE_HOME: sb.bridgeDir, CLAUDE_CODE_SESSION_ID: sb.session, CLAUDE_PROJECT_DIR: sb.ws }, extra || {});
const runInject = (sb, prompt, pm) => cp.spawnSync(process.execPath, [INJECT], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sb.session, cwd: sb.ws, prompt: prompt || "안녕", permission_mode: pm || "default" }), encoding: "utf8", timeout: 30000, env: env(sb), windowsHide: true });
const runGuard = (sb) => cp.spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ transcript_path: sb.tx, cwd: sb.ws, session_id: sb.session, stop_hook_active: false }), encoding: "utf8", timeout: 30000, env: env(sb), windowsHide: true });
const reasonOf = (r) => { try { const o = JSON.parse((r.stdout || "").trim()); return o.decision === "block" ? String(o.reason) : ""; } catch { return ""; } };
const anchorOf = (sb) => { try { return JSON.parse(fs.readFileSync(path.join(sb.bridgeDir, "active", sb.session + ".json"), "utf8")); } catch { return null; } };
const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ""; } catch { return ""; } };
const wsKeyOf = (ws) => crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
const ledgerFile = (sb) => path.join(sb.bridgeDir, "rule-check", wsKeyOf(sb.ws) + ".jsonl");
const readRows = (sb) => { let raw = ""; try { raw = fs.readFileSync(ledgerFile(sb), "utf8"); } catch { return []; } const latest = new Map(); for (const l of raw.split(NL)) { if (!l.trim()) continue; const o = JSON.parse(l); latest.set([o.host, o.session, o.turnAnchor, o.rulesFp].join("|"), o); } return [...latest.values()]; };

t("주입 훅 — 첫 앵커 쓰기에 ruleCheck{mode,rulesFp,rulesN} 기록 · 규칙 주입문 머리에 지문 · 옵션 꺼짐/주입 off 턴도 disabled로 기록(출력 없어도)", () => {
  const a = setup("inj");
  const r = runInject(a, "첫 프롬프트");
  const an = anchorOf(a); const eff = CL.effectiveRuleCheck(JSON.parse(fs.readFileSync(a.cf, "utf8")), "claude", "normal");
  assert.ok(an && an.ruleCheck && an.ruleCheck.mode === "required" && an.ruleCheck.rulesFp === eff.rulesFp && an.ruleCheck.rulesN === 3, JSON.stringify(an && an.ruleCheck));
  assert.ok(ctxOf(r).includes(`[계약점검 ${CL.ruleCheckFp8(eff)}]`), ctxOf(r).slice(0, 300));
  const b = setup("injoff", { claudeInjectMode: "off", claudeChecklist: true });
  const rb = runInject(b, "x");
  assert.ok(String(rb.stdout || "").trim() === "" || !ctxOf(rb).includes("계약점검"), "no rules injected");
  const bn = anchorOf(b); assert.ok(bn && bn.ruleCheck && bn.ruleCheck.mode === "disabled" && bn.ruleCheck.rulesN === 0, "disabled recorded even without output: " + JSON.stringify(bn && bn.ruleCheck));
  const c = setup("injck", { claudeChecklist: false });
  runInject(c, "x"); assert.strictEqual(anchorOf(c).ruleCheck.mode, "disabled", "checklist off → disabled");
  const d = setup("injplan", { claudeInjectMode: "plan" });
  runInject(d, "x", "default"); assert.strictEqual(anchorOf(d).ruleCheck.mode, "disabled", "plan-only inject on a normal turn → disabled");
  runInject(d, "x", "plan"); assert.strictEqual(anchorOf(d).ruleCheck.mode, "required", "plan turn → required");
});

t("종료 훅 — required 턴: 블록 없음=규칙 원문 동봉 차단(검증 재촉 아님) · 블록 있음=종료+장부 행(근거 지문만) · 도구만 턴은 대상 아님 · 위반 표기도 종료", () => {
  const a = setup("guard");
  runInject(a, "고쳐줘");
  const eff = CL.effectiveRuleCheck(JSON.parse(fs.readFileSync(a.cf, "utf8")), "claude", "normal"); const fp8 = CL.ruleCheckFp8(eff);
  putTx(a, [human(a), say(a, "고쳤습니다. 점검표 없음.")]);
  const r1 = reasonOf(runGuard(a));
  assert.ok(r1.startsWith("[규칙 자가점검] 마지막 답에 점검 블록이 없습니다") && r1.includes(RULES[0]) && r1.includes(`[계약점검 ${fp8}]`) && !r1.includes("ask-start"), r1.slice(0, 300));
  putTx(a, [human(a), say(a, "고쳤습니다." + NL + block(fp8, ["준수", "위반", "해당없음"]))]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "block present (with a 'violated' mark) → allowed");
  const rows = readRows(a);
  assert.ok(rows.length === 1 && rows[0].host === "claude" && rows[0].closedBy === "check" && rows[0].marks.length === 3 && rows[0].marks[1].mark === "violated" && !JSON.stringify(rows[0]).includes("직접 확인함"), JSON.stringify(rows));
  putTx(a, [human(a)]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "tool-only turn (no reply) → not a target");
  putTx(a, [human(a), say(a, "다른 지문" + NL + block("00000000", ["준수", "준수", "준수"]))]);
  assert.ok(reasonOf(runGuard(a)).includes("다른 규칙 목록(00000000) 기준"), "fingerprint mismatch → block");
  assert.strictEqual(readRows(a).length, 1, "same turn re-checks fold into one row");
});

t("종료 훅 — 턴 중 규칙 편집: 같은 개수·2→3·3→0(=무검사) 모두 유효 설정 재계산·앵커 원자 교체·required면 새 전문 동봉 차단 1회 · 옵션 끄면 무검사", () => {
  const a = setup("edit");
  runInject(a, "시작");
  const eff0 = CL.effectiveRuleCheck(JSON.parse(fs.readFileSync(a.cf, "utf8")), "claude", "normal");
  putTx(a, [human(a), say(a, block(CL.ruleCheckFp8(eff0), ["준수", "준수", "준수"]))]);
  assert.strictEqual(reasonOf(runGuard(a)), "");
  a.setContract({ claude: ["새 규칙 A", "새 규칙 B", "새 규칙 C"] }); // 같은 개수·다른 문장
  const r1 = reasonOf(runGuard(a));
  const effA = CL.effectiveRuleCheck(JSON.parse(fs.readFileSync(a.cf, "utf8")), "claude", "normal");
  assert.ok(r1.includes("규칙 목록이 바뀌었습니다") && r1.includes("새 규칙 B") && r1.includes(CL.ruleCheckFp8(effA)), r1.slice(0, 300));
  assert.ok(anchorOf(a).ruleCheck.rulesFp === effA.rulesFp && anchorOf(a).ruleCheck.rulesN === 3, "anchor replaced atomically");
  putTx(a, [human(a), say(a, block(CL.ruleCheckFp8(effA), ["준수", "준수", "준수"]))]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "re-answer against the new list → allowed");
  a.setContract({ claude: ["새 규칙 A", "새 규칙 B", "새 규칙 C", "규칙 D"] }); // 3→4
  const r2 = reasonOf(runGuard(a)); assert.ok(r2.includes("규칙 목록이 바뀌었습니다") && r2.includes("규칙 D") && anchorOf(a).ruleCheck.rulesN === 4);
  putTx(a, [human(a), say(a, block(CL.ruleCheckFp8(CL.effectiveRuleCheck(JSON.parse(fs.readFileSync(a.cf, "utf8")), "claude", "normal")), ["준수", "준수", "준수"]))]);
  const r3 = reasonOf(runGuard(a)); assert.ok(r3.includes("빠지거나") && r3.includes("4"), "3 lines for 4 rules → incomplete: " + r3.slice(0, 200));
  a.setContract({ claude: [] }); // N→0
  assert.strictEqual(reasonOf(runGuard(a)), "", "rules removed → no check");
  assert.strictEqual(anchorOf(a).ruleCheck.mode, "disabled");
  a.setContract({ claude: RULES, claudeChecklist: false });
  putTx(a, [human(a), say(a, "점검 없음")]);
  assert.strictEqual(reasonOf(runGuard(a)), "", "checklist off → no check");
  a.setContract({ claudeChecklist: true });
  assert.ok(reasonOf(runGuard(a)).includes("규칙 목록이 바뀌었습니다"), "disabled→required mid-turn → re-read block once");
});

t("종료 훅 — 앵커 없음(주입 훅 미실행·turnKind 미상): 주입 모드 plan이어도 검사 적용(안전 방향)·off면 무검사 · 반복 누락 3회 뒤 해제=장부 '미기재'+노랑 경보 1건+다음 턴 1줄 안내", () => {
  const a = setup("noanchor", { claudeInjectMode: "plan" });
  putTx(a, [human(a), say(a, "점검 없음")]);
  assert.ok(reasonOf(runGuard(a)).startsWith("[규칙 자가점검]"), "anchor missing + plan mode → still required");
  const b = setup("noanchoroff", { claudeInjectMode: "off" });
  putTx(b, [human(b), say(b, "점검 없음")]);
  assert.strictEqual(reasonOf(runGuard(b)), "", "anchor missing + inject off → disabled");
  const c = setup("cap");
  runInject(c, "시작");
  putTx(c, [human(c), say(c, "끝까지 점검표 없음")]);
  const rs = [runGuard(c), runGuard(c), runGuard(c)].map(reasonOf);
  assert.ok(rs.every((x) => x.startsWith("[규칙 자가점검]")), "three blocks");
  const rel = runGuard(c);
  assert.strictEqual(reasonOf(rel), "", "4th → released (ab-6)");
  const rows = readRows(c);
  assert.ok(rows.length === 1 && rows[0].closedBy === "attempt-cap" && rows[0].marks.length === 0, JSON.stringify(rows));
  const ev = JSON.parse(fs.readFileSync(path.join(c.bridgeDir, "integrity.json"), "utf8")).events.filter((e) => e.kind === "rule-check-missed");
  assert.ok(ev.length === 1 && ev[0].severity === "warning" && normWs(ev[0].workspace) === normWs(c.ws), JSON.stringify(ev));
  const r2 = runInject(c, "다음 턴");
  assert.ok(ctxOf(r2).includes("[규칙 자가점검] 직전 턴이 점검 블록 없이 끝났습니다"), ctxOf(r2).slice(-400));
  fs.mkdirSync(CL.RULE_CHECK_DIR, { recursive: true }); fs.copyFileSync(ledgerFile(c), path.join(CL.RULE_CHECK_DIR, wsKeyOf(c.ws) + ".jsonl")); // 요약기는 시험 HOME 결속 — 픽스처 장부를 복사해 판독
  const sum = CL.ruleCheckSummary(c.ws, "claude", rows[0].rulesFp, 3, 30);
  assert.ok(sum.turns === 1 && sum.counts.length === 3 && sum.counts.every((x) => x.missing === 1), JSON.stringify(sum));
  assert.strictEqual(CL.ruleCheckSummary(c.ws, "codex", rows[0].rulesFp, 3, 30).turns, 0, "host filter — other implementer's rows are not summed (1회차 blocker②)");
  // [1회차 blocker③] 자가점검만 실패한 상한 해제 턴은 노랑 1건으로 끝난다 — 거짓 verify-incomplete 빨강 없음
  const evAll = JSON.parse(fs.readFileSync(path.join(c.bridgeDir, "integrity.json"), "utf8")).events;
  assert.ok(!evAll.some((e) => e.kind === "verify-incomplete" || e.kind === "verify-handoff-missing"), "no red alert for a rule-check-only release: " + JSON.stringify(evAll.map((e) => e.kind)));
  // [1회차 보완] 안내는 '직전 턴'에만 — 한 턴 더 지나면 침묵
  const r3 = runInject(c, "그 다음 턴");
  assert.ok(!ctxOf(r3).includes("직전 턴이 점검 블록 없이 끝났습니다"), "notice bound to the immediately previous turn only");
});

// ── 구현 Codex 쪽(codex-hook) ──
t("구현 Codex — 주입 heartbeat에 ruleCheck 기록·도구 이벤트 뒤 보존·Stop 검사(블록 없음=차단·있음=종료+장부 host codex) · 검증 off 모드도 적용", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc_cx_")); const ws = path.join(dir, "proj"); fs.mkdirSync(ws, { recursive: true });
  const envC = Object.assign({}, process.env, { CODEX_BRIDGE_HOME: dir }); delete envC.CLAUDE_PROJECT_DIR;
  const lib = CL; // 격리 HOME은 위에서 이미 결속됨 — codex-hook 스폰은 envC로 별도 결속
  const SID = "019f0000-3333-7222-8333-944455566677"; const rollout = path.join(dir, "rollout.jsonl");
  const RC = ["코덱스 규칙 하나", "코덱스 규칙 둘"];
  const contractDir = path.join(dir, "contracts"); fs.mkdirSync(contractDir, { recursive: true });
  const key = crypto.createHash("sha1").update(normWs(ws)).digest("hex").slice(0, 16);
  fs.writeFileSync(path.join(contractDir, key + ".json"), JSON.stringify({ harnessMode: "codex-codex", codexVerifyMode: "off", verifyMode: "off", codexImplementer: RC, codexImplementerChecklist: true, codexInjectMode: "always" }));
  const meta = { type: "session_meta", timestamp: new Date(Date.now() - 60000).toISOString(), payload: { id: SID, source: "vscode", thread_source: "user" } };
  const msg = (role, text) => JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  fs.writeFileSync(rollout, JSON.stringify(meta) + NL + msg("user", "구현 시작") + NL);
  const run = (ev, extra) => { const r = cp.spawnSync(process.execPath, [CHOOK], { input: JSON.stringify(Object.assign({ hook_event_name: ev, session_id: SID, cwd: ws, transcript_path: rollout, turn_id: "t-1" }, extra || {})), encoding: "utf8", timeout: 30000, env: envC, windowsHide: true }); let o = null; try { o = JSON.parse(r.stdout); } catch { o = null; } return { r, o, ctx: (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || "", reason: o && o.decision === "block" ? String(o.reason) : "" }; };
  const p1 = run("UserPromptSubmit", { prompt: "구현 시작" });
  const anchorFile = path.join(dir, "codex-active", SID + ".json");
  const an = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
  const eff = lib.effectiveRuleCheck({ codexImplementer: RC, codexImplementerChecklist: true, codexInjectMode: "always" }, "codex", "normal");
  assert.ok(an.ruleCheck && an.ruleCheck.mode === "required" && an.ruleCheck.rulesFp === eff.rulesFp && an.ruleCheck.rulesN === 2, JSON.stringify(an.ruleCheck) + " ctx=" + p1.ctx.slice(0, 200));
  assert.ok(p1.ctx.includes(`[계약점검 ${lib.ruleCheckFp8(eff)}]`), p1.ctx.slice(0, 400));
  run("PostToolUse", { tool_name: "shell", tool_input: {} });
  assert.ok(JSON.parse(fs.readFileSync(anchorFile, "utf8")).ruleCheck.rulesFp === eff.rulesFp, "tool heartbeat keeps ruleCheck (same turn)");
  fs.appendFileSync(rollout, msg("assistant", "고쳤습니다. 점검표 없음.") + NL);
  const s1 = run("Stop", {});
  assert.ok(s1.reason.startsWith("[규칙 자가점검]") && s1.reason.includes(RC[1]), s1.reason.slice(0, 300) || JSON.stringify(s1.o));
  fs.appendFileSync(rollout, msg("assistant", "고쳤습니다." + NL + block(lib.ruleCheckFp8(eff), ["준수", "해당없음"])) + NL);
  const s2 = run("Stop", {});
  assert.strictEqual(s2.reason, "", "block present → allowed: " + JSON.stringify(s2.o));
  const rows = readRows({ bridgeDir: dir, ws });
  assert.ok(rows.length === 1 && rows[0].host === "codex" && rows[0].closedBy === "check" && rows[0].marks.length === 2, JSON.stringify(rows));
});

t("소스 계약 — 세 칸 상수(REPORT_SECTIONS/reportShape*) 폐지·두 훅에 report 분기 없음·epoch에 유효 규칙 지문·검증자 요청 조립에 구현자 규칙 미동봉", () => {
  const vch = fs.readFileSync(path.join(__dirname, "..", "bridge", "verify-cap-handoff.js"), "utf8");
  const vg = fs.readFileSync(GUARD, "utf8"); const ch = fs.readFileSync(CHOOK, "utf8"); const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(!/const REPORT_SECTIONS =|function reportShapeCheck\(|function reportShapeInstruction\(/.test(vch) && !/세 칸 제목\(무엇이 바뀌었나/.test(vch), "constant removed");
  assert.ok(!/reportShape|closeReport|reportOk/.test(vg) && !/reportShape|closeReport|report\.ok/.test(ch), "hooks no longer reference the report guard");
  assert.ok(vg.includes('ruleCheck: [eff.mode, eff.rulesFp || "", eff.rulesN].join("|")') && ch.includes('ruleCheck:[eff.mode,eff.rulesFp||"",eff.rulesN].join("|")'), "epoch carries the effective rule fingerprint");
  assert.ok(vg.includes("if (anchorObj && !ruleCheckSame(prevRC, eff)) {") && ch.includes("if(anchorRC&&!ruleCheckSame(prevRC,eff)){"), "recompute-then-compare in both hooks");
  assert.ok(!/c\.claude\b.*verifierRules|verifierRules.*c\.claude\b/.test(cb), "verifier never receives implementer rules (user decision)");
});

t("대시보드 — 규칙 자가점검 카드(관찰 자료·개요 미합산·textContent·옵션 꺼짐/규칙 없음 안내)", () => {
  const ext = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.ok(ext.includes('ruleCheck: { host: "claude" | "codex"; checklist: boolean; rules: string[]; rulesFp: string; summary:'), "state type");
  assert.ok(ext.includes("lib.ruleCheckSummary(ws, host, rulesFp, rules.length, 30)") && ext.includes('c9 && c9.harnessMode === "codex-codex" ? "codex" : "claude"'), "computeState uses the ledger summary for the active host (host-filtered)");
  assert.ok(/<details id="ruleCheckSec" class="backlog-fold" style="display:none">/.test(ext) && /id="rcSummary"/.test(ext) && /id="rcList"/.test(ext), "card markup");
  const rBeg = ext.indexOf('const sec=$("ruleCheckSec")'); const rEnd = ext.indexOf("// [§7 4-2b] 결정 장부 카드", rBeg);
  assert.ok(rBeg > 0 && rEnd > rBeg, "renderer block");
  const blk = ext.slice(rBeg, rEnd);
  assert.ok(!/innerHTML/.test(blk) && blk.includes('if(!rc){ sec.style.display="none"; return; }') && blk.includes("체크리스트 옵션 꺼짐") && blk.includes("규칙 없음"), "renderer: null hides, off/empty explained, textContent only");
  const dBeg = ext.indexOf("function decideActs(d){"); const dEnd = ext.indexOf("function renderOverview(d){", dBeg);
  assert.ok(!/ruleCheck/.test(ext.slice(dBeg, dEnd)), "not summed into '지금 정할 것' (observation, not a decision)");
});

console.log(`\n결과: ${n} 통과 / 0 실패`);
