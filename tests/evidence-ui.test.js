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
ok(/재확인 요청을 1회<\/b> 자동으로 보내요/.test(extSrc) && /one recheck request<\/b>/.test(extSrc), "힌트 ko/en — 1회 자동 발송 명시");
ok(/일치하면 경고가 자동으로 사라지고/.test(extSrc) && /어떤 판정도 바꾸지 않습니다/.test(extSrc) && /never changes any verdict/.test(extSrc), "힌트 — 자동 해소·판정 불변 명시");
ok(/추가 비용: 경고 1건당 Codex 호출 1회/.test(extSrc) && /one Codex call per warning/.test(extSrc), "힌트 — 추가 비용 고지(ko/en · PRIVACY와 일치)");
ok(/function evidenceChallengeLib\(\)/.test(extSrc) && /evidence-challenge\.js/.test(extSrc), "장부 모듈 lazy require 가드(부재=null)");
ok(/typeof ech\.listChallenges !== "function"/.test(extSrc) && /computeChallengeView\(ech\.listChallenges\(ws\), Date\.now\(\)\)/.test(extSrc), "상태 배선 — listChallenges→computeChallengeView(읽기 전용)");
ok(/challenges: \{ open: number; counts: Record<string, number>;/.test(extSrc), "BridgeState 타입 선언(null=구 설치본)");

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
    { bogus: true }, // challengeId 없는 오염 줄=무시
  ];
  const v = view(recs, now);
  ok(v.counts.resolved === 1 && v.counts.failed === 1 && v.counts.dispatched === 1 && v.counts.pending === 1, "상태별 집계 정확");
  ok(v.open === 2, "진행 중=pending+dispatched");
  ok(v.items.length === 4 && v.items[0].id === "ch-4", "오염 줄 무시·최신(경과 짧은) 순 정렬");
  const r1 = v.items.find((x) => x.id === "ch-1");
  ok(r1.files === 2 && r1.resolvedFiles === 2 && r1.ageMin === 2, "파일 수·일치 수·경과(분) 계산");
  const many = Array.from({ length: 15 }, (_, i) => ({ challengeId: "ch-m" + i, state: "resolved", settledAt: new Date(now - i * 1000).toISOString(), files: [] }));
  ok(view(many, now).items.length === 10, "표시 상한 10건");
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
    { id: "ch-a", state: "resolved", files: 2, resolvedFiles: 2, ageMin: 3 },
    { id: "ch-b", state: "failed", files: 1, resolvedFiles: 0, ageMin: 9 },
  ];
  n = runRender({ open: 1, counts: { resolved: 1, failed: 1 }, items }, "ko");
  ok(/총 2건/.test(n.chSummary.textContent) && /해소 1/.test(n.chSummary.textContent) && /유지 1/.test(n.chSummary.textContent) && /진행 1/.test(n.chSummary.textContent), "CH-4 요약 — 총/해소/유지/진행 집계");
  ok(n.chList.children.length === 2, "CH-5 목록 렌더 2건");
  const row0 = n.chList.children[0];
  ok(row0.children.some((c) => /해소\(원문 일치\)/.test(c.textContent)) && row0.children.some((c) => /파일 2\/2 일치/.test(c.textContent)), "CH-6 상태 라벨·파일 일치 수 표시");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
