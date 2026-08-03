// 근거 재확인(evidence challenge) 순수 계층 — docs/EVIDENCE-RECONFIRM-DESIGN.md §2·§4·§5 실행 반례.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "evch_home_"));
process.env.CODEX_BRIDGE_HOME = home;
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "evch_ws_"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "evch_out_"));

const ch = require("../bridge/evidence-challenge.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

// 필수 결속(§5): verifier session·모드/언어 동결·campaign/ask ID — 전 동결 호출에 공통 주입
const BIND = { verifierSession: "vs-0199", mode: "claude-codex", lang: "ko", campaignId: "cl:sess:2026", askId: "ask-t1" };

// 다양성 있는 본문 생성기(적격 통과용 — 반복 없는 의사 코드 텍스트)
const richText = (n) => {
  let s = "";
  for (let i = 0; s.length < n; i++) s += `const line${i} = fn(${i * 7}, "v${i}", opt${i % 13});\n`;
  return s.slice(0, n);
};

console.log("[1] 구간 적격성(§2) — 저정보·반복·공백 판정");
ck("16바이트 미만=too-short", ch.spanIneligible(Buffer.from("short")) === "too-short");
ck("고유 바이트 8종 미만=low-info", ch.spanIneligible(Buffer.from("aabbccdd".repeat(4))) === "low-info");
ck("공백 90% 이상=low-info", ch.spanIneligible(Buffer.from(" \t\n\r".repeat(30) + "abcdefgh")) === "low-info");
ck("true 반복=부적격", ch.spanIneligible(Buffer.from("true".repeat(16))) === "low-info");
ck("abcd 반복=부적격", ch.spanIneligible(Buffer.from("abcd".repeat(16))) === "low-info");
ck("abcdefgh×8(주기 8 완전 반복)=부적격 — 일반 주기 판정", ch.spanIneligible(Buffer.from("abcdefgh".repeat(8))) === "low-info");
ck("주기 32 완전 반복도 부적격(길이/2 이내 전 주기)", ch.spanIneligible(Buffer.from("abcdefgh01234567ABCDEFGH!@#$%^&*".repeat(2))) === "low-info");
ck("다양성 있는 비반복 본문=적격", ch.spanIneligible(Buffer.from(richText(200))) === "");

console.log("[2] 구간 선택(§2) — 기노출 제외·소형 파일·no-safe-span");
{
  const buf = Buffer.from(richText(1000));
  const span = ch.pickSpan(buf, []);
  ck("적격 구간 선택 성공(64~512B·범위 내)", !!span && span.len >= 64 && span.len <= 512 && span.off + span.len <= buf.length);
  ck("선택 구간 자체가 적격", !!span && ch.spanIneligible(buf.slice(span.off, span.off + span.len)) === "");
  // 기노출: 파일 전체가 답변에 노출됐으면 어떤 구간도 못 고른다
  ck("전체 기노출=no-safe-span", ch.pickSpan(buf, [buf]) === null);
  const small = Buffer.from(richText(40));
  const s2 = ch.pickSpan(small, []);
  ck("소형(16~63B) 파일=전체 구간", !!s2 && s2.off === 0 && s2.len === 40);
  ck("소형 파일도 기노출이면 no-safe-span", ch.pickSpan(small, [Buffer.concat([Buffer.from("x"), small])]) === null);
  ck("16B 미만 파일=항상 no-safe-span", ch.pickSpan(Buffer.from("tiny too small"), []) === null);
  ck("반복 내용 파일=no-safe-span", ch.pickSpan(Buffer.from("ab".repeat(500)), []) === null);
}

console.log("[3] 동결(§2) — 단일 읽기·루트 결속·상한·사유 기록");
const wfile = (rel, content) => { const p = path.join(ws, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); return p; };
const fA = wfile("src/a.js", richText(800));
const fB = wfile("src/b.js", richText(700));
const fOut = path.join(outside, "secret.txt"); fs.writeFileSync(fOut, richText(300));
const fRep = wfile("rep.txt", "abcd".repeat(100));
const fBig = wfile("big.bin", Buffer.alloc(ch.CH_MAX_FILE_BYTES + 1, 7));
{
  ck("필수 결속 결손=동결 거부(fail-closed)", ch.freezeChallenge({ eventId: "ev0", ws, execCwd: ws, roots: [ws], files: [fA], exposedTexts: [], mode: "claude-codex", lang: "ko", campaignId: "c", askId: "a" }) === null);
  const rec = ch.freezeChallenge({
    ...BIND, eventId: "ev1", ws, execCwd: ws, roots: [ws],
    files: [fA, fB, fOut, fRep, fBig, path.join(ws, "no-such.js")],
    exposedTexts: ["질문 본문", "답변 본문"],
  });
  ck("필수 결속이 최상위 필드로 저장", rec.verifierSession === BIND.verifierSession && rec.campaignId === BIND.campaignId && rec.askId === BIND.askId && rec.mode === BIND.mode && rec.lang === BIND.lang);
  ck("pathId=16헥사·챌린지 내 고유", rec.files.every((f) => /^p[0-9a-f]{16}$/.test(f.pathId)) && new Set(rec.files.map((f) => f.pathId)).size === rec.files.length);
  const by = (p) => rec.files.find((f) => f.path === p || f.path.toLowerCase() === String(p).toLowerCase().replace(/\\/g, "\\"));
  const byName = (name) => rec.files.find((f) => f.path.includes(name));
  ck("정상 파일 2건=pending(동결 필드 완비)", ["a.js", "b.js"].every((n) => { const f = byName(n); return f && f.status === "pending" && f.pathId && f.fileSha && f.spanSha && f.len >= 64; }));
  ck("루트 밖 파일=out-of-root(발송 제외)", byName("secret.txt").status === "skipped" && byName("secret.txt").reason === "out-of-root");
  ck("반복 내용=no-safe-span", byName("rep.txt").reason === "no-safe-span");
  ck("파일별 상한 초과=too-large", byName("big.bin").reason === "too-large");
  ck("소멸 파일=read-fail", byName("no-such.js").reason === "read-fail");
  ck("전체 상태=pending(발송할 것 있음)", rec.state === "pending");
  // 동결 digest가 실제 파일 바이트와 일치(단일 읽기 결속)
  const fa = byName("a.js"), buf = fs.readFileSync(fA);
  ck("전체 SHA=실파일 일치", fa.fileSha === sha(buf));
  ck("구간 digest=같은 바이트에서 계산", fa.spanSha === sha(buf.slice(fa.off, fa.off + fa.len)));
  ck("원문 바이트는 저장 안 함(digest·범위만)", !JSON.stringify(rec).includes(buf.slice(fa.off, fa.off + fa.len).toString("base64")));

  console.log("[4] 파일 수·총량 상한(§2)");
  const many = Array.from({ length: ch.CH_MAX_FILES + 2 }, (_, i) => wfile(`m/m${i}.js`, richText(600)));
  const rec2 = ch.freezeChallenge({ ...BIND, eventId: "ev2", ws, execCwd: ws, roots: [ws], files: many, exposedTexts: [] });
  ck("파일 수 상한 초과분=cap-exceeded", rec2.files.filter((f) => f.reason === "cap-exceeded").length === 2 && rec2.files.filter((f) => f.status === "pending").length === ch.CH_MAX_FILES);

  console.log("[5] 장부 상태기계(§5) — pending→dispatched(1회)→종결·복구");
  ch.writeChallenge(rec);
  ck("기록·재판독 일치", ch.readChallenge(ws, rec.challengeId).challengeId === rec.challengeId);
  const d1 = ch.markDispatched(ws, rec.challengeId);
  ck("dispatched 선기록 성공(attempt=1)", d1.ok === true && d1.rec.state === "dispatched" && d1.rec.attempt === 1);
  ck("재발송 거부(시도 최대 1)", ch.markDispatched(ws, rec.challengeId).ok === false);
  // 응답·판정
  const live = d1.rec.files.filter((f) => f.status === "pending");
  const bufA = fs.readFileSync(fA);
  const fa2 = live.find((f) => f.path.includes("a.js"));
  const good = `CH ${rec.challengeId} ${fa2.pathId} ${bufA.slice(fa2.off, fa2.off + fa2.len).toString("base64")}`;
  const parsed = ch.parseChallengeResponse(good + "\n무관한 줄\n", d1.rec);
  ck("정상 응답 줄 파싱", parsed.byPath.size === 1 && parsed.byPath.has(fa2.pathId));
  const judged = ch.judgeChallenge(d1.rec, parsed);
  ck("일치 파일=resolved", judged.files.find((f) => f.pathId === fa2.pathId).status === "resolved");
  ck("무응답+파일 불변=failed(태만)", judged.files.find((f) => f.pathId !== fa2.pathId).status === "failed");
  ck("전체 판정=failed(하나라도 태만)", judged.overall === "failed");
  const st = ch.settleChallenge(ws, rec.challengeId, judged);
  ck("종결 기록(파일별 상태 반영)", st.ok === true && st.rec.state === "failed" && st.rec.files.find((f) => f.pathId === fa2.pathId).status === "resolved");
  ck("종결 후 재종결 거부", ch.settleChallenge(ws, rec.challengeId, judged).ok === false);
  ck("이벤트 전체 해소 아님(태만·skipped 잔존)", ch.eventFullyResolved(st.rec) === false);

  console.log("[5-1] create-only 장부(§5) — 덮어쓰기로 attempt 리셋 불가");
  ck("같은 challengeId 재기록 거부(EEXIST)", ch.writeChallenge(rec) === null);
  const afterOverwriteTry = ch.readChallenge(ws, rec.challengeId);
  ck("기존 레코드 불변(상태·attempt 유지)", afterOverwriteTry.state === "failed" && afterOverwriteTry.attempt === 1);
  ck("재기록 시도 후에도 재발송 불가", ch.markDispatched(ws, rec.challengeId).ok === false);

  console.log("[5-2] 읽기 후 상한 재검사(§2) — stat 이후 팽창 우회 차단");
  {
    const big = Buffer.alloc(ch.CH_MAX_FILE_BYTES + 1, 65);
    const r = ch.freezeChallenge({ ...BIND, eventId: "ev-grow", ws, execCwd: ws, roots: [ws], files: [fA], exposedTexts: [], readFile: () => big });
    ck("읽은 바이트가 상한 초과=too-large(발송 제외)", r.files[0].reason === "too-large" && r.state === "no-dispatch");
  }

  console.log("[5-3] 결정론 폴백(§2) — 무작위가 빗나가도 격자 스윕이 적격 후보 발견");
  {
    // 대부분 반복(부적격) + 한 곳(오프셋 4096)에만 다양성 있는 96B 창 — 무작위 len 추첨은 창보다
    // 큰 구간을 뽑으면 전부 부적격이라 폴백 스윕(len=64·보폭 32)이 실질 발견 경로
    const noisy = Buffer.concat([Buffer.from("xy".repeat(2048)), Buffer.from(richText(96)), Buffer.from("xy".repeat(2048))]);
    const span = ch.pickSpan(noisy, []);
    // 무작위 32회는 확률적(구 코드는 실패 가능·flaky) — 폴백 스윕이 있으면 항상 발견된다.
    ck("적격 창을 결정론적으로 발견", !!span && ch.spanIneligible(noisy.slice(span.off, span.off + span.len)) === "");
  }

  console.log("[6] 복구(§5) — dispatched 잔존=outcome-unknown·재발송 금지");
  const rec3 = ch.freezeChallenge({ ...BIND, eventId: "ev3", ws, execCwd: ws, roots: [ws], files: [fB], exposedTexts: [] });
  ch.writeChallenge(rec3);
  ch.markDispatched(ws, rec3.challengeId);
  const ou = ch.markOutcomeUnknown(ws, rec3.challengeId);
  ck("outcome-unknown 수렴", ou.ok === true && ou.rec.state === "outcome-unknown");
  ck("이후 재발송 불가", ch.markDispatched(ws, rec3.challengeId).ok === false);
}

console.log("[7] 응답 거부 경로(§4) — challengeId 불일치·미지·중복 pathId·상한");
{
  const rec = ch.freezeChallenge({ ...BIND, eventId: "ev4", ws, execCwd: ws, roots: [ws], files: [fA, fB], exposedTexts: [] });
  const [pA, pB] = rec.files.map((f) => f.pathId);
  const bufA = fs.readFileSync(fA);
  const fa = rec.files[0];
  const b64 = bufA.slice(fa.off, fa.off + fa.len).toString("base64");
  ck("challengeId 불일치 줄 거부", ch.parseChallengeResponse(`CH ch-딴거 ${pA} ${b64}`, rec).byPath.size === 0);
  ck("미지 pathId 줄 거부", ch.parseChallengeResponse(`CH ${rec.challengeId} p없는거 ${b64}`, rec).byPath.size === 0);
  const dupTxt = `CH ${rec.challengeId} ${pA} ${b64}\nCH ${rec.challengeId} ${pA} QUJD\nCH ${rec.challengeId} ${pB} QUJD`;
  const pd = ch.parseChallengeResponse(dupTxt, rec);
  ck("중복 pathId=그 파일 전체 누락 처리(다른 파일은 유지)", !pd.byPath.has(pA) && pd.byPath.has(pB));
  const over = ch.parseChallengeResponse("x".repeat(ch.CH_MAX_RESP_BYTES + 10), rec);
  ck("총 응답 상한 초과=전체 누락(overCap)", over.overCap === true && over.byPath.size === 0);
  // 대조는 '동결 스냅샷' 기준: 파일이 바뀌어도 동결 구간 원문이 오면 resolved
  const changedRead = () => Buffer.from("완전히 다른 내용 " + richText(100));
  const j2 = ch.judgeChallenge(rec, ch.parseChallengeResponse(`CH ${rec.challengeId} ${pA} ${b64}`, rec), changedRead);
  ck("동결 구간 일치=resolved(현재 파일과 무관)", j2.files.find((f) => f.pathId === pA).status === "resolved");
  ck("무응답+파일 변경=indeterminate(태만 아님)", j2.files.find((f) => f.pathId === pB).status === "indeterminate");
  ck("전체=indeterminate(태만 없음·미해소)", j2.overall === "indeterminate");
  // 전부 일치 → resolved + 이벤트 해소 성립
  const bufB = fs.readFileSync(fB);
  const fb = rec.files[1];
  const both = `CH ${rec.challengeId} ${pA} ${b64}\nCH ${rec.challengeId} ${pB} ${bufB.slice(fb.off, fb.off + fb.len).toString("base64")}`;
  const j3 = ch.judgeChallenge(rec, ch.parseChallengeResponse(both, rec));
  ck("전부 일치=overall resolved", j3.overall === "resolved");
  ch.writeChallenge(rec); ch.markDispatched(ws, rec.challengeId);
  const st3 = ch.settleChallenge(ws, rec.challengeId, j3);
  ck("이벤트 전체 해소 성립(전 파일 resolved)", ch.eventFullyResolved(st3.rec) === true);
}

console.log("[8] 수명(§5) — 미종결 삭제 금지·종결만 보존기간 후 정리");
{
  const rec = ch.freezeChallenge({ ...BIND, eventId: "ev5", ws, execCwd: ws, roots: [ws], files: [fA], exposedTexts: [] });
  ch.writeChallenge(rec); // pending(미종결)
  const old = ch.freezeChallenge({ ...BIND, eventId: "ev6", ws, execCwd: ws, roots: [ws], files: [fB], exposedTexts: [] });
  old.state = "resolved"; old.settledAt = new Date(Date.now() - 200 * 86400_000).toISOString();
  ch.writeChallenge(old);
  const removed = ch.cleanupSettled(ws, 90);
  ck("오래된 종결 1건만 정리", removed === 1 && ch.readChallenge(ws, old.challengeId) === null);
  ck("미종결(pending)은 보존", ch.readChallenge(ws, rec.challengeId) !== null);
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
