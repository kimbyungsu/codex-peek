// 근거 재확인 대시보드 카드(증분 4b) — 소스 계약 + 컴파일 산출물 순수 함수 실행 + 렌더 블록 실행 반례.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

const extSrc = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");

console.log("[1] 소스 계약 — 카드 HTML·상태 배선·읽기 전용");
ok(/<details id="chSec" class="backlog-fold" style="display:none">/.test(extSrc) && !/<details id="chSec"[^>]*\sopen(?:\s|=|>)/.test(extSrc), "카드=기본 닫힘 details(chSec·open 없음)");
ok(/id="chSummary"/.test(extSrc) && /id="chList"/.test(extSrc), "요약·목록 노드 실재");
ok(/재확인 요청을 최대 1회<\/b> 보낼 수 있어요/.test(extSrc) && /at most one recheck request<\/b>/.test(extSrc), "힌트 ko/en — 조건부 최대 1회(단정 금지)");
ok(/마감 임박·발송할 안전 구간 없음 등이면 안 보냄/.test(extSrc) && /추가 비용: 발송된 경고당 최대 Codex 호출 1회/.test(extSrc), "힌트 — 미발송 조건·비용 상한 표현(정본 PRIVACY와 동일 계열)");
ok(/경고 1건당 최대 1회/.test(fs.readFileSync(path.join(ROOT, "PRIVACY.md"), "utf8")), "PRIVACY 정본도 최대 1회 표현(교차 대조)");
ok(/전 항목이 일치해야 경고가 자동으로 사라지고/.test(extSrc) && /어떤 판정도 바꾸지 않습니다/.test(extSrc) && /never changes any verdict/.test(extSrc), "힌트 — 자동 해소·판정 불변 명시");
ok(/at most one Codex call per dispatched warning/.test(extSrc), "힌트 en — 비용 상한 표현");
ok(/function evidenceChallengeLib\(\)/.test(extSrc) && /evidence-challenge\.js/.test(extSrc), "장부 모듈 lazy require 가드(부재=null)");
ok(/typeof ech\.listChallenges !== "function"/.test(extSrc) && /computeChallengeView\(ech\.listChallenges\(ws\), Date\.now\(\), unacked\)/.test(extSrc) && /readIntegrity\(\)\.filter\(\(e\) => e && e\.ack !== true/.test(extSrc), "상태 배선 — listChallenges+미ack 이벤트 결속→computeChallengeView(읽기 전용)");
ok(/challenges: \{ open: number; cleared: number; kept: number;/.test(extSrc), "BridgeState 타입 선언(cleared·kept 포함)");

console.log("[2] 순수 함수 실행 — 컴파일 산출물에서 computeChallengeView 추출");
{
  const outSrc = fs.readFileSync(path.join(ROOT, "out", "extension.js"), "utf8");
  const b = outSrc.indexOf("function computeChallengeView(");
  const e = outSrc.indexOf("\nfunction ", b + 10);
  ok(b > 0 && e > b, "컴파일 산출물에서 추출 가능");
  const view = new Function(outSrc.slice(b, e) + "\nreturn computeChallengeView;")();
  const now = Date.now();
  const empty = view([], now);
  ok(empty.open === 0 && empty.items.length === 0 && Object.keys(empty.counts).length === 0, "빈 장부=전부 0");
  const recs = [
    { challengeId: "ch-1", state: "resolved", settledAt: new Date(now - 120000).toISOString(), files: [{ status: "resolved" }, { status: "resolved" }] },
    { challengeId: "ch-2", state: "failed", settledAt: new Date(now - 60000).toISOString(), files: [{ status: "resolved" }, { status: "failed" }] },
    { challengeId: "ch-3", state: "dispatched", dispatchedAt: new Date(now - 300000).toISOString(), files: [{ status: "pending" }] },
    { challengeId: "ch-4", state: "pending", createdAt: new Date(now - 30000).toISOString(), files: [{ status: "pending" }] },
    { challengeId: "ch-5", state: "resolved", settledAt: new Date(now - 90000).toISOString(), files: [{ status: "resolved" }, { status: "skipped", reason: "no-safe-span" }] }, // skip 혼합+실검증 1 — 해소(2026-08-06 정렬)
    { challengeId: "ch-8", state: "resolved", settledAt: new Date(now - 150000).toISOString(), files: [{ status: "skipped" }, { status: "skipped" }] }, // 전량 skipped=실검증 0 — 해소 아님
    { challengeId: "ch-6", state: "resolved", eventId: "ev-open-1", settledAt: new Date(now - 45000).toISOString(), files: [{ status: "resolved" }] }, // 전 파일 일치인데 경고 미ack(반영 대기)
    { challengeId: "ch-7", state: "failed", eventId: "ev-acked-1", settledAt: new Date(now - 40000).toISOString(), files: [{ status: "failed" }] }, // 실패했지만 사용자가 경고를 수동 확인함
    { bogus: true }, // challengeId 없는 오염 줄=무시
  ];
  const unacked = new Set(["ev-open-1"]); // ch-6의 경고만 아직 미ack(ev-acked-1은 수동 확인됨·eventId 없는 구 레코드=열림 아님)
  const v = view(recs, now, unacked);
  ok(v.counts.resolved === 4 && v.counts.failed === 2 && v.counts.dispatched === 1 && v.counts.pending === 1, "상태별 집계 정확");
  ok(v.open === 2, "진행 중=pending+dispatched");
  ok(v.cleared === 2 && v.kept === 1, "cleared=검증 가능분 일치(skip 제외)+실제 ack만 · kept=경고가 실제로 열린 종결분만(수동 확인·구 레코드 제외)");
  const ra = v.items.find((x) => x.id === "ch-7");
  ok(ra.warnOpen === false && ra.cleared === false, "실패+수동 확인=경고 열림 아님(유지로 과대 표시 금지 재료)");
  const rw = v.items.find((x) => x.id === "ch-6");
  ok(rw.matchedAll === true && rw.cleared === false, "전 파일 일치라도 경고 미ack면 해소 표시 금지(반영 대기)");
  const rp = v.items.find((x) => x.id === "ch-5");
  ok(rp.cleared === true && rp.matchedAll === true && rp.resolvedFiles === 1 && rp.files === 2, "skip 혼합+실검증≥1=해소 표시(브릿지 eventFullyResolved 정렬 2026-08-06)");
  const rz = v.items.find((x) => x.id === "ch-8");
  ok(rz.matchedAll === false && rz.cleared === false, "전량 skipped(실검증 0)=해소 표시 금지");
  ok(v.items.length === 8 && v.items[0].id === "ch-4", "오염 줄 무시·최신(경과 짧은) 순 정렬");
  const r1 = v.items.find((x) => x.id === "ch-1");
  ok(r1.files === 2 && r1.resolvedFiles === 2 && r1.ageMin === 2, "파일 수·일치 수·경과(분) 계산");
  const many = Array.from({ length: 15 }, (_, i) => ({ challengeId: "ch-m" + i, state: "resolved", settledAt: new Date(now - i * 1000).toISOString(), files: [] }));
  ok(view(many, now).items.length === 10, "표시 상한 10건");
  // 재확인 불가 표시(보관함 채택 2026-08-11): no-dispatch의 eventId 집합은 표시 상한(10) '전' 전량 기준
  {
    const ndMany = Array.from({ length: 12 }, (_, i) => ({ challengeId: "ch-nd" + i, state: "no-dispatch", eventId: "ev-nd-" + i, createdAt: new Date(now - i * 1000).toISOString(), files: [{ status: "skipped" }] }));
    const vnd = view(ndMany, now);
    ok(vnd.items.length === 10 && Array.isArray(vnd.ndEventIds) && vnd.ndEventIds.length === 12 && vnd.ndEventIds.includes("ev-nd-11"), "ndEventIds=상한 전 전량(12건 — 잘린 목록에 안 걸림)");
    ok(vnd.items.every((x) => typeof x.eventId === "string"), "items에 eventId 결속 키 동봉");
  }
}

console.log("[3b] 배너 '재확인 불가' 결속 — 같은 상태 푸시의 ndEventIds로 그 줄에 표시");
{
  ok(/const nd9 = \{\}; \(\(d\.challenges && d\.challenges\.ndEventIds\) \|\| \[\]\)/.test(extSrc), "배너가 재확인 뷰의 전량 집합과 결속(경보 배열 자체는 무가공)");
  ok(/e\.kind === "evidence-unseen" && e\.id && nd9\[e\.id\]/.test(extSrc), "evidence-unseen이면서 no-dispatch 결속된 줄에만 표시(타 경보 오염 금지)");
  ok(extSrc.includes("재확인 불가 항목(인용 파일이 검증 범위 밖이라 자동 해소 없음 · '확인함'으로 정리)") && extSrc.includes("recheck not possible (cited files outside the verifiable scope"), "안내 문구 ko/en 쌍");
}

console.log("[3] 렌더 블록 실행 반례 — 숨김/빈 상태/요약·목록·상태 라벨");
{
  const rBeg = extSrc.indexOf('const sec=$("chSec")');
  const rEnd = extSrc.indexOf("// ⑤ 범위 장부 카드", rBeg);
  const renderBlk = rBeg > 0 && rEnd > rBeg ? extSrc.slice(rBeg, rEnd) : "";
  ok(renderBlk.length > 0 && !/innerHTML/.test(renderBlk) && /replaceChildren\(\)/.test(renderBlk), "렌더 블록 추출·동적 innerHTML 부재(XSS 안전)");
  const bodyEnd = renderBlk.lastIndexOf("});");
  const body = bodyEnd > 0 ? renderBlk.slice(0, bodyEnd) : "";
  const runRender = (challenges, lang) => {
    const mkNode = () => ({ style: {}, children: [], textContent: "", className: "", appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; } });
    const nodes = { chSec: mkNode(), chSummary: mkNode(), chList: mkNode() };
    const fn = new Function("$", "T", "el", "d", body);
    fn((id) => nodes[id], (ko, en) => (lang === "en" ? en : ko), (tag, cls, text) => { const n = mkNode(); n.className = cls || ""; if (text != null) n.textContent = text; return n; }, { challenges });
    return nodes;
  };
  let n = runRender(null, "ko");
  ok(n.chSec.style.display === "none", "CH-1 ch=null(구 설치본) — 카드 숨김");
  n = runRender({ open: 0, counts: {}, items: [] }, "ko");
  ok(n.chSec.style.display === "" && n.chSummary.textContent.startsWith("비어 있음"), "CH-2 빈 장부 — 카드 유지+'비어 있음'(ko)");
  n = runRender({ open: 0, counts: {}, items: [] }, "en");
  ok(n.chSummary.textContent.startsWith("empty — recheck records"), "CH-3 빈 장부 — 영문 문구(ko/en 쌍)");
  const items = [
    { id: "ch-a", state: "resolved", files: 2, resolvedFiles: 2, ageMin: 3, cleared: true, matchedAll: true, warnOpen: false },
    { id: "ch-a2", state: "resolved", files: 1, resolvedFiles: 1, ageMin: 4, cleared: false, matchedAll: true, warnOpen: true },
    { id: "ch-b", state: "resolved", files: 5, resolvedFiles: 1, ageMin: 5, cleared: true, matchedAll: true, warnOpen: false }, // skip 혼합 해소(2026-08-06 정렬)
    { id: "ch-b2", state: "resolved", files: 2, resolvedFiles: 0, ageMin: 6, cleared: false, matchedAll: false, warnOpen: true }, // 전량 범위 밖=실검증 0
    { id: "ch-c", state: "failed", files: 1, resolvedFiles: 0, ageMin: 9, cleared: false, matchedAll: false, warnOpen: true },
    { id: "ch-c2", state: "failed", files: 1, resolvedFiles: 0, ageMin: 10, cleared: false, matchedAll: false, warnOpen: false },
    { id: "ch-d", state: "no-dispatch", files: 1, resolvedFiles: 0, ageMin: 12, cleared: false, matchedAll: false, warnOpen: true },
  ];
  n = runRender({ open: 0, cleared: 2, kept: 4, counts: { resolved: 4, failed: 2, "no-dispatch": 1 }, items }, "ko");
  ok(/총 7건/.test(n.chSummary.textContent) && /해소 2/.test(n.chSummary.textContent) && /경고 유지 4/.test(n.chSummary.textContent), "CH-4 요약 — 해소=cleared만·경고 유지=실제 열린 종결분만");
  ok(n.chList.children.length === 7, "CH-5 목록 렌더 7건");
  const row0 = n.chList.children[0];
  ok(row0.children.some((c) => /해소\(전 항목 일치/.test(c.textContent)) && row0.children.some((c) => /파일 2\/2 일치/.test(c.textContent)), "CH-6 전부 일치=해소 라벨");
  const rowW = n.chList.children[1];
  ok(rowW.children.some((c) => /전 항목 일치 · 해소 반영 대기/.test(c.textContent)), "CH-7a 전 파일 일치+미ack=반영 대기 라벨(해소 과대 표시 금지)");
  const row1 = n.chList.children[2];
  ok(row1.children.some((c) => /해소\(검증 가능분 일치·범위 밖 4건 제외/.test(c.textContent)), "CH-7 skip 혼합 해소=범위 밖 제외 건수 명시(전 항목 일치 과대 표시 금지)");
  const rowB2 = n.chList.children[3];
  ok(rowB2.children.some((c) => /실검증 0\(전량 범위 밖\) · 경고 유지/.test(c.textContent)), "CH-7c 전량 범위 밖=실검증 0 라벨+경고 유지 접미");
  const rowAck = n.chList.children[5];
  ok(rowAck.children.some((c) => /불일치·무응답 · 경고 닫힘\(현재 열린 경고 없음\)/.test(c.textContent)), "CH-7b 실패+경고 닫힘=원인 중립 접미(확인 이력 단정·유지 과대 표시 금지)");
  const row3 = n.chList.children[6];
  ok(row3.children.some((c) => /미발송\(안전 구간 없음/.test(c.textContent)), "CH-8 no-dispatch=현지화 라벨(원시 문자열 노출 금지)");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
