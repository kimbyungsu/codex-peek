"use strict";
/*
 * [약속 발화 포착] CONSTRAINT-CAPTURE-DESIGN v3 §1 부품 A — 훅 턴 스냅샷·상신 게이트·내구 영수증 실행 시험.
 * 격리: 임시 CODEX_BRIDGE_HOME(파일 실주입·모킹 없음). 검수 기준 §6 부품 A: 성공+거부 반례 전종 — 각 거부의
 * 내구 영수증 실존(원문 비복사·provider/wsKey 실림)·turnAnchor 결정성.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ccap-"));
process.env.CODEX_BRIDGE_HOME = HOME;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CODEX_THREAD_ID;
const CL = require("../bridge/contract-lib.js");

let n = 0;
const t = (name, fn) => { n++; fn(); console.log(`  ✅ [${n}] ${name}`); };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "ccap-ws-"));
const SID = "sess-ccap-0001";
const TS = "2026-08-23T00:00:00.000Z";
const ANCHOR = CL.turnAnchorOf(SID, TS);
const PROMPT = "고객 차단 기록은 지우지 마, 그리고 오래된 것들은 30일 뒤에 지워지게 해! 이건 앞으로 계속 지켜야 하는 약속이야.";
const QUOTE = "고객 차단 기록은 지우지 마, 그리고 오래된 것들은 30일 뒤에 지워지게 해!";
const GEN = "a".repeat(40);
const usageText = () => JSON.stringify(CL.readConstraintUsage()); // 서랍 전체를 직렬화(원문 비복사 검사용)
const lastUsage = () => { const L = CL.readConstraintUsage(); return L.length ? L[L.length - 1] : null; };
const RKC = CL.repoKeyOf(CL.resolveScoutRepo(WS, CL.loadContract(WS)).repo); // [ab-1] 원문 턴의 정찰 대상 지문(동결 문맥에 실림)
const ctxOk = { ok: true, provider: "claude", sessionId: SID, turnAnchor: ANCHOR, sourceHash: sha1(PROMPT), repoKey: RKC };

t("turnAnchor 결정성: 같은 (sessionId, ts)=같은 앵커·다른 턴=다른 앵커·16hex", () => {
  assert.strictEqual(CL.turnAnchorOf(SID, TS), ANCHOR);
  assert.ok(/^[0-9a-f]{16}$/.test(ANCHOR));
  assert.notStrictEqual(CL.turnAnchorOf(SID, "2026-08-23T00:00:01.000Z"), ANCHOR, "다른 active.ts=다른 앵커");
  assert.notStrictEqual(CL.turnAnchorOf("sess-other", TS), ANCHOR, "다른 세션=다른 앵커");
});

t("스냅샷 기록: 원문 그대로 저장+sourceHash=전문 sha1·빈 입력=거부", () => {
  const w = CL.writeConstraintTurnSnapshot(WS, ANCHOR, PROMPT);
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.sourceHash, sha1(PROMPT));
  assert.strictEqual(fs.readFileSync(CL.constraintTurnFileFor(WS, ANCHOR), "utf8"), PROMPT, "원문 무변 저장(정규화·절단 금지)");
  assert.strictEqual(CL.writeConstraintTurnSnapshot(WS, "", PROMPT).ok, false, "앵커 없음=거부");
  assert.strictEqual(CL.writeConstraintTurnSnapshot(WS, ANCHOR, "").ok, false, "빈 원문=거부");
});

t("문맥 해석(Claude 경로): active의 constraintAnchor/sourceHash 판독·부재=snapshot-missing·세션 없음=no-session", () => {
  assert.strictEqual(CL.constraintTurnContext().reason, "no-session", "세션 env 부재");
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  try {
    assert.strictEqual(CL.constraintTurnContext().reason, "no-turn-anchor", "active 기록 부재");
    const af = path.join(CL.ACTIVE_DIR, SID.replace(/[^a-zA-Z0-9_-]/g, "") + ".json");
    fs.mkdirSync(CL.ACTIVE_DIR, { recursive: true });
    fs.writeFileSync(af, JSON.stringify({ workspace: WS, claudeSession: SID, ts: TS }));
    const cf = CL.constraintTurnContext();
    assert.strictEqual(cf.reason, "snapshot-missing", "앵커 필드 없는 구훅 턴=상신 불가(fail-closed)");
    assert.ok(cf.provider === "claude" && cf.sessionId === SID, "실패 반환에도 식별 가능 신원 동반(blocker②)");
    fs.writeFileSync(af, JSON.stringify({ workspace: WS, claudeSession: SID, ts: TS, constraintAnchor: ANCHOR, constraintSourceHash: sha1(PROMPT) }));
    const c = CL.constraintTurnContext();
    assert.deepStrictEqual({ ok: c.ok, provider: c.provider, turnAnchor: c.turnAnchor, sourceHash: c.sourceHash }, { ok: true, provider: "claude", turnAnchor: ANCHOR, sourceHash: sha1(PROMPT) });
  } finally { delete process.env.CLAUDE_CODE_SESSION_ID; }
});

t("상신 성공: 후보 레코드(kind/원문/why/출처 결속)+registered 영수증·영수증은 원문 비복사", () => {
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WS, GEN), 2, "수칙서 활성 픽스처(양 슬롯)");
  const r = CL.constraintAdd(WS, QUOTE, "지켜진 약속은 사건을 안 만들어 자동 채널에 안 잡힘", "", ctxOk);
  assert.strictEqual(r.ok, true, "상신 성공: " + (r.reason || ""));
  const { latest } = CL.readEnvelopeCandidates(WS);
  const rec = latest.get(r.candidateId + "@" + GEN);
  assert.strictEqual(rec.kind, "user-constraint");
  assert.strictEqual(rec.status, "proposed");
  assert.strictEqual(rec.title, QUOTE, "문안=인용 원문 그대로(자동 작문 금지)");
  assert.ok(rec.why && rec.provider === "claude" && rec.turnAnchor === ANCHOR && rec.sourceHash === sha1(PROMPT), "출처 결속 필드");
  const u = lastUsage();
  assert.strictEqual(u.outcome, "registered");
  assert.ok(u.quoteFp === sha1(QUOTE).slice(0, 16) && u.quoteLen === QUOTE.length && u.wsKey && u.provider === "claude", "영수증=지문+길이+출처");
  assert.ok(!usageText().includes("고객 차단"), "★영수증 원문 비복사(ab-7 계보)");
  const RK = CL.repoKeyOf(CL.resolveScoutRepo(WS, CL.loadContract(WS)).repo); // [ab-1] 후보=태어난 정찰 대상에 결속(ID 파티션+레코드 repoKey)
  const expectId = CL.envelopeCandidateId("user-constraint", CL.wsKeyFor(WS) + "|" + RK + "|" + sha1(QUOTE.normalize("NFC").replace(/\s+/g, " ").trim()));
  assert.strictEqual(r.candidateId, expectId, "candidateId=전체 원문 지문(scope 미포함)");
});

t("거부 반례 전종 A — 형식·민감·why·scope(각각 사유별 영수증)", () => {
  const cases = [
    ["짧다", "근거근거근거", "", "too-short"],
    ["가".repeat(201), "근거근거근거", "", "too-long"],
    ["줄바꿈이 들어간\n약속 문장입니다", "근거근거근거", "", "multiline"],
    ["이 약속에는 [지적 목록 v2] 마커가 들어 있다", "근거근거근거", "", "protocol-vocab"],
    ["연락은 admin@example.com 으로만 받겠다는 약속", "근거근거근거", "", "sensitive-email"],
    [QUOTE + " 이건", "", "", "why-missing"],
    [QUOTE + " 이건", "근\n거", "", "why-format"],
    [QUOTE + " 이건", "너".repeat(121), "", "why-format"],
    [QUOTE + " 이건", "근거근거근거", "레포지토리 mail admin@example.com", "scope-sensitive-email"],
  ];
  for (const [q, w, s, want] of cases) {
    const r = CL.constraintAdd(WS, q, w, s, ctxOk);
    assert.strictEqual(r.ok, false, want + " 케이스가 통과됨");
    assert.strictEqual(r.reason, want);
    assert.strictEqual(lastUsage().reason, want, "거부 영수증 실존: " + want);
  }
});

t("거부 반례 전종 B — 원문 결속(스냅샷 부재·지문 불일치·비연속 구절=작문 차단)", () => {
  const r1 = CL.constraintAdd(WS, "스냅샷에 없는 새로 작문한 요구 문장입니다", "근거근거근거", "", ctxOk);
  assert.strictEqual(r1.reason, "not-in-prompt", "구현모델 작문=거부(설계 §1 핵심)");
  const r2 = CL.constraintAdd(WS, QUOTE + " 이건", "근거근거근거", "", { ...ctxOk, sourceHash: "f".repeat(40) });
  assert.strictEqual(r2.reason, "snapshot-mismatch");
  const r3 = CL.constraintAdd(WS, QUOTE + " 이건", "근거근거근거", "", { ...ctxOk, turnAnchor: CL.turnAnchorOf(SID, "2026-08-23T09:00:00.000Z") });
  assert.strictEqual(r3.reason, "snapshot-missing", "다른 턴 앵커=스냅샷 부재");
  const r4 = CL.constraintAdd(WS, QUOTE + " 이건", "근거근거근거", "", { ok: false, reason: "snapshot-missing", provider: "claude", sessionId: SID });
  assert.strictEqual(r4.reason, "snapshot-missing", "문맥 실패도 같은 영수증 채널");
  const u4 = lastUsage();
  assert.ok(u4.reason === "snapshot-missing" && u4.provider === "claude" && u4.sessionId === SID && u4.wsKey, "★거부 영수증에도 신원 실림(blocker② — §1 공통 스키마)");
});

t("거부 반례 전종 C — 중복 지문·거부권(declined=같은 세대 억제)·턴당 상한", () => {
  const r1 = CL.constraintAdd(WS, QUOTE, "근거근거근거", "", ctxOk);
  assert.strictEqual(r1.reason, "duplicate", "같은 원문 지문 재상신=거부");
  const q2 = "이건 앞으로 계속 지켜야 하는 약속이야.";
  const id2 = CL.envelopeCandidateId("user-constraint", CL.wsKeyFor(WS) + "|" + CL.repoKeyOf(CL.resolveScoutRepo(WS, CL.loadContract(WS)).repo) + "|" + sha1(q2.normalize("NFC").replace(/\s+/g, " ").trim()));
  CL.appendEnvelopeCandidates(WS, [{ candidateId: id2, envelopeHash: GEN, status: "declined", kind: "user-constraint", ts: "T" }]);
  const r2 = CL.constraintAdd(WS, q2, "근거근거근거", "", ctxOk);
  assert.strictEqual(r2.reason, "declined-suppressed", "사용자 거절 문안=같은 승인 세대 재상신 금지(§4 거부권)");
  // 턴당 상한: 새 턴 앵커에서 2건 성공 후 3건째 거부 — 스냅샷에 실존하는 서로 다른 구절 3개 사용
  const TS2 = "2026-08-23T10:00:00.000Z";
  const A2 = CL.turnAnchorOf(SID, TS2);
  const P2 = "첫째 백업은 매일 자정에 자동으로 남겨야 한다. 둘째 백업 파일은 절대 덮어쓰지 않는다. 셋째 복구 시험은 매주 한 번 돌린다.";
  CL.writeConstraintTurnSnapshot(WS, A2, P2);
  const ctx2 = { ok: true, provider: "claude", sessionId: SID, turnAnchor: A2, sourceHash: sha1(P2), repoKey: RKC };
  assert.strictEqual(CL.constraintAdd(WS, "첫째 백업은 매일 자정에 자동으로 남겨야 한다.", "근거근거근거", "", ctx2).ok, true);
  assert.strictEqual(CL.constraintAdd(WS, "둘째 백업 파일은 절대 덮어쓰지 않는다.", "근거근거근거", "", ctx2).ok, true);
  const r3 = CL.constraintAdd(WS, "셋째 복구 시험은 매주 한 번 돌린다.", "근거근거근거", "", ctx2);
  assert.strictEqual(r3.reason, "turn-cap", "턴당 " + CL.CONSTRAINT_TURN_CAP + "건 상한(남발 억제 §1-⑦)");
});

t("거부 반례 전종 D — 수칙서 비활성=안내(A-6 경계)·pending 합산 상한 12", () => {
  const WSI = fs.mkdtempSync(path.join(os.tmpdir(), "ccap-inactive-"));
  CL.writeConstraintTurnSnapshot(WSI, ANCHOR, PROMPT);
  const rI = CL.constraintAdd(WSI, QUOTE, "근거근거근거", "", ctxOk);
  assert.strictEqual(rI.reason, "envelope-inactive", "승인 지문 없는 작업공간=후보 대신 안내");
  const WSP = fs.mkdtempSync(path.join(os.tmpdir(), "ccap-pending-"));
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WSP, GEN), 2);
  CL.writeConstraintTurnSnapshot(WSP, ANCHOR, PROMPT);
  const pad = [];
  for (let i = 0; i < CL.MEMORY_CANDIDATE_PENDING_MAX; i++) pad.push({ candidateId: sha1("pad" + i).slice(0, 16), envelopeHash: GEN, status: "proposed", kind: "resolved-blocker", ts: "T" });
  CL.appendEnvelopeCandidates(WSP, pad);
  const rP = CL.constraintAdd(WSP, QUOTE, "근거근거근거", "", ctxOk);
  assert.strictEqual(rP.reason, "pending-cap", "A/B 합산 12 상한(kind 무관 — §1-⑦)");
});

t("TTL 스윕: constraint-turns의 7일 지난 .txt만 청소(최근 파일 보존)", () => {
  const oldF = CL.constraintTurnFileFor(WS, "0".repeat(16));
  fs.writeFileSync(oldF, "옛 턴 원문");
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldF, past, past);
  CL.cleanupOldState(Date.now());
  assert.ok(!fs.existsSync(oldF), "8일 경과=삭제(원문 민감 최소화)");
  assert.ok(fs.existsSync(CL.constraintTurnFileFor(WS, ANCHOR)), "최근 스냅샷=보존");
});

t("Codex heartbeat 실행 반례(blocker①): 도구 이벤트가 결속 필드를 안 지우고·새 턴에서만 폐기", () => {
  const HB = require("../bridge/codex-hook.js").heartbeat;
  assert.strictEqual(typeof HB, "function", "테스트 주입구(require.main 가드) 경유 export");
  const XS = "codex-sess-cc-01";
  const WSX = fs.mkdtempSync(path.join(os.tmpdir(), "ccap-cx-"));
  const P9 = "배포 전에는 반드시 백업부터 남겨야 해. 이건 약속이야.";
  const w9 = CL.writeConstraintTurnSnapshot(WSX, "turn-cc-1", P9);
  HB({ turn_id: "turn-cc-1" }, WSX, XS, "UserPromptSubmit", { constraintAnchor: "turn-cc-1", constraintSourceHash: w9.sourceHash });
  HB({ turn_id: "turn-cc-1" }, WSX, XS, "PostToolUse"); // 같은 턴 도구 이벤트 — 검증자 실행 반례 재현
  const a1 = CL.readCodexActive(XS);
  assert.ok(a1.constraintAnchor === "turn-cc-1" && a1.constraintSourceHash === w9.sourceHash, "★같은 턴 heartbeat=결속 필드 승계(첫 도구 이후 상신 가능)");
  process.env.CODEX_THREAD_ID = XS;
  try {
    const c1 = CL.constraintTurnContext();
    assert.ok(c1.ok && c1.provider === "codex" && c1.turnAnchor === "turn-cc-1", "도구 이벤트 후에도 문맥 생존");
    const rX = CL.constraintAdd(WSX, "배포 전에는 반드시 백업부터 남겨야 해.", "근거근거근거", "", c1);
    assert.strictEqual(rX.reason, "envelope-inactive", "수칙서 비활성 ws라 안내 단계까지 도달(=스냅샷 게이트 통과)");
    HB({ turn_id: "turn-cc-2" }, WSX, XS, "UserPromptSubmit"); // 새 턴·스냅샷 실패 가정(extras 없음)
    const c2 = CL.constraintTurnContext();
    assert.ok(!c2.ok && c2.reason === "snapshot-missing" && c2.provider === "codex" && c2.sessionId === XS, "★턴 교체=결속 폐기(옆 턴 원문 오결속 방지)·신원은 동반");
  } finally { delete process.env.CODEX_THREAD_ID; }
});
t("영수증 무유실(blocker③ ab-5 최종): append 경로에 삭제 코드 자체가 없음 — 405건 전량 보존", () => {
  for (let i = 0; i < 405; i++) assert.strictEqual(CL.appendConstraintUsage({ ts: "T" + i, provider: "claude", wsKey: "k", outcome: "rejected", reason: "pad", seq: i }), true);
  const rows = CL.readConstraintUsage();
  const seqs = new Set(rows.map((r) => r.seq).filter((x) => Number.isInteger(x)));
  for (let i = 0; i < 405; i++) assert.ok(seqs.has(i), "★전량 보존(seq " + i + ") — 기록 경로에 어떤 정리·유계 로직도 없음");
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(!src.includes("CONSTRAINT_USAGE_FILE"), "★공유 영수증 파일 자체가 없음(재작성·회전 경합 전 계급 원천 제거)");
  const fnBody = src.slice(src.indexOf("function appendConstraintUsage"), src.indexOf("function readConstraintUsage"));
  assert.ok(!/rmSync|renameSync|unlinkSync|withFileLockStrict|atomicWrite/.test(fnBody), "★append 함수 본문에 삭제·재작성(rename 교체 포함)·잠금 부재(성공 반환 영수증을 지우거나 덮을 코드 경로 없음 — 소스 계약)");
  assert.ok(fnBody.includes('{ flag: "wx" }') && fnBody.includes('e.code === "EEXIST"'), "★기록=배타 생성(존재하면 실패·EEXIST=새 이름 재시도) — 이름 충돌이 기존 영수증을 교체하는 경로 원천 부재(5차 blocker②)");
});
t("유계=TTL 스윕만(blocker③ 최종 정방향): 90일 지난 영수증만 일일 스윕이 삭제·방금 쓴 것과 낙오자(mtime 최신)는 면역", () => {
  const D = CL.CONSTRAINT_USAGE_DIR;
  // 시계 역행 낙오자 동형: '아주 오래된 이름'이지만 mtime은 방금인 파일 — 이름은 삭제 판단에 안 쓰이므로 생존해야 함
  fs.writeFileSync(path.join(D, "00000000000001-0000000001-000000-strg.json"), JSON.stringify({ marker: "straggler" }));
  // 진짜 오래된 영수증: mtime을 91일 과거로
  const oldF = path.join(D, "00000000000002-0000000001-000000-aged.json");
  fs.writeFileSync(oldF, JSON.stringify({ marker: "aged" }));
  const past = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldF, past, past);
  CL.cleanupOldState(Date.now());
  assert.ok(!fs.existsSync(oldF), "90일 경과 mtime=삭제(유계의 유일한 경로)");
  assert.ok(fs.existsSync(path.join(D, "00000000000001-0000000001-000000-strg.json")), "★이름이 아무리 낡아도 mtime이 최신이면 생존 — 이름·벽시계 기반 최신성 판정 자체가 없음(4연속 TOCTOU 계보의 정방향)");
  assert.ok(CL.readConstraintUsage().some((r) => r.marker === "straggler"), "낙오자 판독 가능");
});
t("부품 C 합류: 상신된 약속이 후보 계산기 live에 kind·원문·근거와 함께 나타남·declined=스킵", () => {
  const CB = require("../bridge/codex-bridge.js");
  CL.writeEnvelopeFreeze(WS, GEN, "ask-cc-1"); // 계산기 gen=동결 파일
  const cc = CB.computeEnvelopeCandidatesFor(WS);
  const mine = (cc.live || []).find((c) => c.titles && c.titles[0] === QUOTE);
  assert.ok(mine, "★상신 후보가 대시보드 계산기 live에 합류(장부 단독 적재 공백의 kind 확장)");
  assert.strictEqual(mine.kind, "user-constraint");
  assert.ok(typeof mine.why === "string" && mine.why.length > 0, "why 동봉(§1 사람 표면 보조 줄 재료)");
  const q2 = "이건 앞으로 계속 지켜야 하는 약속이야.";
  assert.ok(!(cc.live || []).some((c) => c.titles && c.titles[0] === q2), "declined 문안=live 제외(거부권 — 기존 필터 공유)");
});
t("부품 B 파서: 부재=정상·정상 2행·빈 블록 ok·위치(지적 블록 앞) 규격", () => {
  assert.strictEqual(CL.parseConstraintBlock("본문뿐").present, false, "블록 부재=정상(선택 절)");
  const B = CL.CONSTRAINT_BLOCK_MARKERS;
  const row = (q, w) => JSON.stringify({ quote: q, why: w });
  const good = "본문\n" + B.start + "\n" + row("약속 하나", "근거") + "\n" + row("약속 둘", "근거") + "\n" + B.end + "\n[지적 목록 v2]\n[지적 목록 끝]\n\n검증: 통과\n";
  const p1 = CL.parseConstraintBlock(good);
  assert.ok(p1.present && p1.ok && p1.items.length === 2 && p1.items[0].quote === "약속 하나", "정상 2행 판독");
  const empty = B.start + "\n" + B.end + "\n";
  assert.ok(CL.parseConstraintBlock(empty).ok, "빈 블록=무해 ok");
  const after = "[지적 목록 v2]\n[지적 목록 끝]\n" + B.start + "\n" + row("약속", "근거") + "\n" + B.end;
  const pA = CL.parseConstraintBlock(after);
  assert.ok(pA.present && !pA.ok && pA.reason === "position", "지적 블록 '뒤' 위치=전량 거부(지적 파서 손상 유발 차단)");
});
t("부품 B 파서: 손상 하나=블록 전량 거부(부분 수용 없음) — 5행·미지 필드·개행 값·중복 키·JSON 파손·1KB 초과", () => {
  const B = CL.CONSTRAINT_BLOCK_MARKERS;
  const row = (q, w) => JSON.stringify({ quote: q, why: w });
  const wrap = (body) => B.start + "\n" + body + "\n" + B.end;
  const five = wrap([1, 2, 3, 4, 5].map((i) => row("약속 " + i, "근거")).join("\n"));
  assert.strictEqual(CL.parseConstraintBlock(five).reason, "too-many-rows", "최대 4행");
  assert.strictEqual(CL.parseConstraintBlock(wrap('{"quote":"약속","why":"근거","x":1}')).reason, "unknown-field", "미지 필드=전량 거부");
  assert.strictEqual(CL.parseConstraintBlock(wrap('{"quote":"약\\n속","why":"근거"}')).reason, "newline-value", "개행 값=거부");
  assert.strictEqual(CL.parseConstraintBlock(wrap('{"quote":"a","quote":"b","why":"근거"}')).reason, "dup-or-missing-key", "중복 키=거부(파서가 삼키기 전 원문 검사)");
  assert.strictEqual(CL.parseConstraintBlock(wrap('{"quote":"first","quo\\u0074e":"second","why":"reason"}')).reason, "dup-or-missing-key", "★이스케이프 중복 키(quo\\u0074e)도 해독 후 거부(확인검증 blocker 정방향)");
  assert.strictEqual(CL.parseConstraintBlock(wrap('{"quote":"약속" "why"')).reason, "dup-or-missing-key", "행 형식 파손=거부");
  assert.strictEqual(CL.parseConstraintBlock(wrap('{"quote":"' + "가".repeat(1024) + '","why":"근거"}')).reason, "line-too-long", "행당 1KB 상한");
  const kr400 = JSON.stringify({ quote: "가".repeat(400), why: "근거" });
  assert.ok(kr400.length < 1024 && Buffer.byteLength(kr400, "utf8") > 1024, "반례 전제: 코드 단위<1024·UTF-8 바이트>1024");
  assert.strictEqual(CL.parseConstraintBlock(wrap(kr400)).reason, "line-too-long", "★1KB 상한=UTF-8 바이트 기준(한글 행 우회 봉합 — 확인검증 blocker 정방향)");
  assert.ok(CL.parseConstraintBlock(wrap('{ "quote" : "공백 있는 정상 행", "why" : "근거" }')).ok, "키 사이 공백=정상 수용(스캐너가 형식 아닌 키 의미를 검사)");
});
t("부품 B 회수: 훅 스냅샷만 대조 권위 — 정상 적재+작문/지문 불일치/직접 ask 반례·구현자 상신과 지문 dedupe 합류", () => {
  const WSB = fs.mkdtempSync(path.join(os.tmpdir(), "ccap-b-"));
  assert.strictEqual(CL.setEnvelopeHashAllSlots(WSB, GEN), 2);
  const TSB = "2026-08-23T12:00:00.000Z";
  const AB = CL.turnAnchorOf(SID, TSB);
  const PB = "약속 하나를 지켜야 한다 — 배포 전 백업. 그리고 약속 둘 — 고객 기록 보존. 셋째 약속 — 복구 시험 매주.";
  const wB = CL.writeConstraintTurnSnapshot(WSB, AB, PB);
  const ctxB = { provider: "claude", sessionId: SID, turnAnchor: AB, sourceHash: wB.sourceHash, repoKey: CL.repoKeyOf(CL.resolveScoutRepo(WSB, CL.loadContract(WSB)).repo) }; // [ab-1] job 동결 문맥에 실린 원문 턴 저장소 지문
  const B = CL.CONSTRAINT_BLOCK_MARKERS;
  const row = (q, w) => JSON.stringify({ quote: q, why: w });
  // 정상 3행(턴당 2건 상한 비적용 확인 — via=verifier-block은 블록 4행 유계가 상한)
  const ans1 = "검토 본문\n" + B.start + "\n" + row("약속 하나를 지켜야 한다 — 배포 전 백업.", "지속 약속") + "\n" + row("그리고 약속 둘 — 고객 기록 보존.", "지속 약속") + "\n" + row("셋째 약속 — 복구 시험 매주.", "지속 약속") + "\n" + B.end + "\n[지적 목록 v2]\n[지적 목록 끝]\n\n검증: 통과\n";
  const h1 = CL.constraintHarvestFromAnswer(WSB, ans1, ctxB);
  assert.ok(h1.present && h1.ok && h1.accepted === 3 && h1.rejected === 0, "★정상 적재 3건(턴당 2건 상한 비적용 — A 채널과 별개): " + JSON.stringify(h1));
  const { latest: lB } = CL.readEnvelopeCandidates(WSB);
  const recB = [...lB.values()].find((r) => r.title === "그리고 약속 둘 — 고객 기록 보존.");
  assert.ok(recB && recB.kind === "user-constraint" && recB.via === "verifier-block" && recB.turnAnchor === AB, "후보 레코드=같은 장부·출처 결속+via 표기");
  // 작문 반례(§6): 검증 요청문에 새로 쓴 문장=스냅샷에 없음 → 행 거부(전량 아님 — 행별 게이트)
  const ans2 = B.start + "\n" + row("검증 요청문에서 가져온 것처럼 보이는 새 문장이다.", "위장") + "\n" + B.end;
  const h2 = CL.constraintHarvestFromAnswer(WSB, ans2, ctxB);
  assert.ok(h2.ok && h2.accepted === 0 && h2.rejected === 1, "구현자 작문·주입문 위장=거부(대조 권위=훅 스냅샷뿐)");
  assert.strictEqual(lastUsage().reason, "not-in-prompt");
  // job 결속: sourceHash 불일치=전량 거부 단일 영수증
  const h3 = CL.constraintHarvestFromAnswer(WSB, ans1, { ...ctxB, sourceHash: "f".repeat(40) });
  assert.ok(h3.present && !h3.ok && h3.reason === "snapshot-mismatch", "지문 불일치=블록 전량 거부");
  assert.strictEqual(lastUsage().reason, "block-snapshot-mismatch");
  // 직접 ask(ctx 없음)=전량 무시+direct-ask 영수증
  const h4 = CL.constraintHarvestFromAnswer(WSB, ans1, null);
  assert.ok(h4.present && h4.ignored && h4.reason === "direct-ask", "직접 ask=블록 무시(의식적 한정)");
  assert.ok(lastUsage().reason === "direct-ask" && lastUsage().via === "verifier-block", "direct-ask 거부 영수증 실존");
  // dedupe 자연 합류: 같은 원문 재회수=duplicate 거부(중복 후보 없음)
  const h5 = CL.constraintHarvestFromAnswer(WSB, ans1, ctxB);
  assert.ok(h5.ok && h5.accepted === 0 && h5.rejected === 3, "재회수=지문 dedupe로 전건 duplicate(자연 합류)");
});
t("소스 계약: CLI 스위치·훅 배선(양 경로)·anchor 필드 결속", () => {
  const cb = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cb.includes('case "constraint":') && cb.includes("function cmdConstraint(rest)") && cb.includes("constraintTurnContext()"), "CLI 스위치+문맥 해석 경유");
  const ci = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-inject.js"), "utf8");
  assert.ok(ci.includes("writeConstraintTurnSnapshot(ws, anc, ptxt)") && ci.includes("turnAnchorOf(sid, activeTs)") && ci.includes("constraintAnchor, constraintSourceHash"), "Claude 훅: 스냅샷+active 병기(캠페인 앵커 동일 원천)");
  const ch = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-hook.js"), "utf8");
  const cbB = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  assert.ok(cbB.includes("constraintCtx={provider:cc9.provider,sessionId:cc9.sessionId,turnAnchor:cc9.turnAnchor,sourceHash:cc9.sourceHash,repoKey:constraintRepoKeyFor(ws,cSnap)}") && cbB.includes("rejudgeSnap,campaignId,constraintCtx,"), "부품 B: ask 생성 시 턴 원문 결속을 job에 동결(완료 시점 재판독 금지)");
  assert.ok(cbB.includes("if (ctx && ctx.ok) ctx.repoKey = constraintRepoKeyFor(ws, null);") && fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8").includes('repoKey: ctx.repoKey, via: "verifier-block"'), "[ab-1 5회차] CLI 상신·회수 경로 모두 동결/턴 repoKey를 constraintAdd에 전달(재계산 없음)");
  assert.ok(cbB.includes("constraintHarvestFromAnswer(ws, answer, ccJob9)") && cbB.includes("durableEnv.job.constraintCtx"), "부품 B: finishVerifyRun 회수 배선=내구 job 동결 ctx만 권위");
  const clB = fs.readFileSync(path.join(__dirname, "..", "bridge", "contract-lib.js"), "utf8");
  assert.ok(clB.includes("VERIFIER_FORMAT_CONSTRAINT_KO") && clB.includes("tail9"), "부품 B: 검증자 서식 범주 규칙 1줄(두 blockMode 공통 — 위임 모드 소실 금지)");
  assert.ok(CL.verifierFormatDirective("ko").includes("[제약 후보 v1]") && CL.verifierFormatDirective("ko", "delegated").includes("[제약 후보 v1]"), "서식 실출력 양 모드에 범주 규칙 실림");
  assert.ok(ch.includes("writeConstraintTurnSnapshot(ws, turnId, ptxt)") && ch.includes("constraintAnchor: String(turnId)") && ch.includes('heartbeat(j, ws, sid, "UserPromptSubmit", capFields)') && ch.includes("keepCap"), "Codex 훅: turnId 앵커+heartbeat 결속+같은 턴 승계");
});

t("[ab-1 5회차 blocker] 원문 저장소 결속=동결 문맥 권위 — 응답 대기 중 정찰 대상 A→B 전환에도 A 원문 후보는 A 표식·B 화면 미합류; 표식 없는 문맥=거부", () => {
  const CB = require("../bridge/codex-bridge.js");
  const wsQ = fs.mkdtempSync(path.join(os.tmpdir(), "cc-repo-ws-"));
  const rpA = fs.mkdtempSync(path.join(os.tmpdir(), "cc-repo-A-"));
  const rpB = fs.mkdtempSync(path.join(os.tmpdir(), "cc-repo-B-"));
  const sidQ = "sess-repo-q"; const tsQ = "2026-08-29T00:00:00.000Z"; const ancQ = CL.turnAnchorOf(sidQ, tsQ);
  const PQ = "배포 전에는 반드시 백업을 남겨! 이건 계속 지켜야 하는 약속이야.";
  const QQ = "배포 전에는 반드시 백업을 남겨!";
  CL.writeConstraintTurnSnapshot(wsQ, ancQ, PQ);
  const eQ = { schema: "verify-envelope-v1", supportedEnv: ["공통 전제"], alwaysBlocker: ["공통 금지"], outOfScope: [] };
  const rawQ = JSON.stringify(eQ, null, 1); fs.writeFileSync(path.join(rpA, CL.ENVELOPE_FILE), rawQ); fs.writeFileSync(path.join(rpB, CL.ENVELOPE_FILE), rawQ);
  const HQ = sha1(rawQ); CL.setEnvelopeHashAllSlots(wsQ, HQ); CL.updateContractPatch(wsQ, undefined, { scoutRepo: rpA }); CL.writeEnvelopeFreeze(wsQ, HQ, "ask-repo-q");
  const keyA = CL.repoKeyOf(rpA);
  // 원문 턴(A)에서 동결된 문맥 — 응답을 기다리는 사이 사용자가 정찰 대상을 B로 바꿈
  const ctxFrozen = { ok: true, provider: "claude", sessionId: sidQ, turnAnchor: ancQ, sourceHash: sha1(PQ), repoKey: keyA };
  CL.updateContractPatch(wsQ, undefined, { scoutRepo: rpB });
  const r = CL.constraintAdd(wsQ, QQ, "사용자 약속", "", ctxFrozen);
  assert.strictEqual(r.ok, true, "회수 기록: " + (r.reason || ""));
  const rec = CL.readEnvelopeCandidates(wsQ).latest.get(r.candidateId + "@" + HQ);
  assert.strictEqual(rec.repoKey, keyA, "★기록 표식=원문 당시 A(현재 B 재계산 아님)");
  assert.strictEqual(r.candidateId, CL.envelopeCandidateId("user-constraint", CL.wsKeyFor(wsQ) + "|" + keyA + "|" + sha1(QQ)), "ID 파티션도 A");
  assert.ok(!(CB.computeEnvelopeCandidatesFor(wsQ).live || []).some((c) => c.candidateId === r.candidateId), "★B 화면 미합류");
  CL.updateContractPatch(wsQ, undefined, { scoutRepo: rpA });
  assert.ok((CB.computeEnvelopeCandidatesFor(wsQ).live || []).some((c) => c.candidateId === r.candidateId), "A로 돌아오면 보임");
  // 표식 없는 문맥(구형 job 동결·판독 불가)=기록 거부
  const QQ2 = "이건 계속 지켜야 하는 약속이야."; // 원문에 있는 구절(원문 결속 통과 → 저장소 결속 검사까지 도달)
  const r0 = CL.constraintAdd(wsQ, QQ2, "사용자 약속", "", { ok: true, provider: "claude", sessionId: sidQ, turnAnchor: ancQ, sourceHash: sha1(PQ) });
  assert.strictEqual(r0.reason, "repo-unknown", "무표기 문맥=거부(무표기 생산 0)");
  assert.strictEqual(CL.constraintAdd(wsQ, QQ2, "사용자 약속", "", { ...ctxFrozen, repoKey: "not-hex" }).reason, "repo-unknown", "형식 이상=거부");
});
console.log(`결과: ${n}/${n} 통과`);
