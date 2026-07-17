"use strict";
/*
 * P-12 2a — 검증 백로그 장부(설계 동결 ⓚ 2a).
 * 계약: append-only jsonl·<파일>.lock 전 명령 직렬화(실패=기록 거부)·fold=append 줄 순서(ts=표시용)·
 * 전이표(add=open·재등록=lastSeen/seenCount/tag 단조 승격/최신 좌표·재발견=reopen·status 줄)·
 * 손상 줄=건너뛰되 개수 가시화+clear 재작성 시 원문 보존·민감 최소화(제목 200자·경로 상대화/외부 basename).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p12bl_"));
process.env.CODEX_BRIDGE_HOME = dir;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const WS = "D:/bl-proj";

console.log("[1] 정규화·id([백로그] 확정: NFC→공백 압축→trim→200자 절단→소문자 해시)");
ok(CL.normBacklogTitle("  여러   공백\t지적  ") === "여러 공백 지적", "제목 정규화 — 공백 압축·trim");
ok(CL.normBacklogTitle("가".repeat(300)).length === 200, "제목 200자 절단(민감 최소화)");
ok(CL.backlogId("  테스트  지적 ", "SRC/A.TS") === CL.backlogId("테스트 지적", "src/a.ts"), "id — 정규화 후 동일(공백·대소문자 무시)");
ok(CL.backlogId("가".repeat(300), "") === CL.backlogId("가".repeat(200), ""), "id — 절단 '후' 해시(저장값과 일치)");
ok(CL.normBacklogFile("D:\\bl-proj\\src\\x.ts", WS) === "src/x.ts", "ws 내부 절대경로 — 강제 상대화(구분자 / 통일)");
ok(CL.normBacklogFile("C:/Users/someone/secret.txt", WS) === "secret.txt (외부)", "외부 절대경로 — basename만+(외부) 표시(로컬 식별정보 차단)");
ok(CL.normBacklogFile("src/y.ts", WS) === "src/y.ts", "내부 상대경로는 그대로");
ok(CL.normBacklogFile("../Users/someone/secret.txt", WS) === "secret.txt (외부)", "../ 상대경로의 외부 탈출 — basename 축소(구현검증 2차 blocker: 우회 봉합)");
ok(CL.normBacklogFile("..notes/a.ts", WS) === "..notes/a.ts" && CL.normBacklogFile("..hidden/b.ts", WS) === "..hidden/b.ts", "..으로 시작하는 내부 정상 디렉터리 — 외부 오판 없음(세그먼트 단위 경계 · 3차 blocker: 서로 다른 지적의 id 병합 방지)");

console.log("[2] 전이표 실동작 — add·재등록(승격·좌표 최신화)·reopen·status");
let r = CL.backlogAdd(WS, { tag: "백로그", title: "지적 A", file: "src/a.ts", lang: "ko", mode: "claude-codex", profile: "core", source: "ask-1" });
ok(r.ok && !r.existed && /^[a-f0-9]{16}$/.test(r.id), "신규 add — id 영수증(16hex)");
const idA = r.id;
r = CL.backlogAdd(WS, { tag: "주의", title: "지적 A", file: "src/a.ts", lang: "en", mode: "codex-codex", profile: "integrity", source: "ask-2" });
ok(r.ok && r.existed && r.id === idA, "같은 제목·파일 재등록 — 기존 항목 갱신(seen)");
let b = CL.readBacklog(WS);
let itA = b.items.find((x) => x.id === idA);
ok(itA.tag === "주의" && itA.seenCount === 2, "tag 단조 승격(백로그→주의) + seenCount");
ok(itA.lang === "en" && itA.mode === "codex-codex" && itA.profile === "integrity" && itA.source === "ask-2", "재등록 시 lang·mode·profile·source 최신화(4차 [주의] 반영)");
r = CL.backlogAdd(WS, { tag: "백로그", title: "지적 A", file: "src/a.ts" });
itA = CL.readBacklog(WS).items.find((x) => x.id === idA);
ok(itA.tag === "주의", "주의→백로그 하향 없음(승격 소실 차단)");
ok(CL.backlogSetStatus(WS, idA, "done").ok && CL.readBacklog(WS).items.find((x) => x.id === idA).status === "done", "status 줄 — done 전이");
CL.backlogAdd(WS, { tag: "백로그", title: "지적 A", file: "src/a.ts" });
ok(CL.readBacklog(WS).items.find((x) => x.id === idA).status === "open", "done 후 재발견 — 자동 reopen(재발견=미해결)");
ok(CL.backlogSetStatus(WS, "없는아이디0000000", "done").ok === false, "없는 id status — 거부(not-found)");
ok(CL.backlogAdd(WS, { tag: "주의", title: "   " }).ok === false, "빈 제목 — 기록 거부");

console.log("[3] 손상 줄 fail-visible + clear 원문 보존 + fold=append 순서");
const file = CL.backlogFileFor(WS);
fs.appendFileSync(file, "{깨진 줄\n", "utf8");
fs.appendFileSync(file, JSON.stringify({ schema: "vbl-1", ev: "seen", id: "노애드시드0000000", tag: "백로그", ts: "2026-01-01" }) + "\n", "utf8");
b = CL.readBacklog(WS);
ok(b.corrupt === 2, "손상 2줄(파싱 불가 1+add 없는 seen 1) 계수 — 침묵 유실 금지");
CL.backlogAdd(WS, { tag: "백로그", title: "지적 B" });
const idB = CL.backlogId("지적 B", "");
CL.backlogSetStatus(WS, idB, "dismissed");
const cr = CL.backlogClearDone(WS);
ok(cr.ok && cr.removed >= 1 && cr.corrupt === 2, "clear — 닫힌 항목 정리+손상 계수 보고");
const after = fs.readFileSync(file, "utf8");
ok(after.includes("{깨진 줄"), "clear 재작성이 손상 줄 원문을 그대로 보존(조용한 제거 금지)");
ok(!after.includes("지적 B") && after.includes("지적 A"), "닫힌 항목 줄만 제거·open 항목 줄 보존");
// ts 역전이 있어도 append 순서가 권위 — 나중 줄(과거 ts)의 status가 이긴다
fs.appendFileSync(file, JSON.stringify({ schema: "vbl-1", ev: "status", id: idA, status: "done", ts: "2000-01-01" }) + "\n", "utf8");
ok(CL.readBacklog(WS).items.find((x) => x.id === idA).status === "done", "fold=append 줄 순서(ts는 표시용 — 시계 역전 무영향)");

console.log("[3b] 의미 손상 add — 위조 id(재계산 해시 불일치)는 수용 금지(지속 반례 · 백로그 816820f0 소화)");
{
  const before = CL.readBacklog(WS).corrupt;
  fs.appendFileSync(file, JSON.stringify({ schema: "vbl-1", ev: "add", id: "1234567890abcdef", tag: "백로그", title: "위조 id 지적", ts: "2026-01-02" }) + "\n", "utf8");
  const b2 = CL.readBacklog(WS);
  ok(b2.corrupt === before + 1 && !b2.items.find((x) => x.id === "1234567890abcdef"), "id≠sha256(제목|경로) add 줄 — 항목 수용 안 함+손상 계수(fail-visible)");
  fs.appendFileSync(file, JSON.stringify({ schema: "vbl-1", ev: "add", id: "zz-not-hash", tag: "백로그", title: "형식 위반 id", ts: "2026-01-02" }) + "\n", "utf8");
  ok(CL.readBacklog(WS).corrupt === before + 2, "16hex 형식 위반 id add 줄 — 동일 거부");
}

console.log("[4] 잠금 직렬화 — 실패=기록 거부(fail-closed)");
fs.writeFileSync(file + ".lock", process.pid + "-hold", "utf8"); // 살아있는 이 프로세스가 보유한 잠금
ok(CL.backlogAdd(WS, { tag: "백로그", title: "잠금 중 등록" }).ok === false, "잠금 보유 중 add — 기록 거부");
ok(CL.backlogClearDone(WS).ok === false, "잠금 보유 중 clear — 거부");
fs.unlinkSync(file + ".lock");
ok(CL.backlogAdd(WS, { tag: "백로그", title: "잠금 해제 후 등록" }).ok === true, "해제 후 정상");

console.log("[4b] 실제 자식 프로세스 경합 — 부모 보유 잠금 동안 자식 CLI add/clear 거부(백로그 c2bbff67 소화)");
{
  const cp = require("child_process");
  const CLI = path.join(ROOT, "bridge", "codex-bridge.js");
  const env = { ...process.env, CODEX_BRIDGE_HOME: dir, CLAUDE_PROJECT_DIR: WS };
  fs.writeFileSync(file + ".lock", process.pid + "-parent-hold", "utf8"); // 살아있는 부모가 보유
  const beforeRaw = fs.readFileSync(file, "utf8");
  const c1 = cp.spawnSync(process.execPath, [CLI, "backlog", "add", "--tag", "백로그", "--title", "자식 경합 등록"], { encoding: "utf8", env, timeout: 20000, windowsHide: true });
  ok(c1.status !== 0 && fs.readFileSync(file, "utf8") === beforeRaw, "자식 add — 비0 종료+장부 바이트 불변(잠금 직렬화가 프로세스 경계 넘어 유효)");
  const c2 = cp.spawnSync(process.execPath, [CLI, "backlog", "clear", "--done", "--confirm"], { encoding: "utf8", env, timeout: 20000, windowsHide: true });
  ok(c2.status !== 0 && fs.readFileSync(file, "utf8") === beforeRaw, "자식 clear — 거부+재작성 없음(add vs clear 경합 차단)");
  fs.unlinkSync(file + ".lock");
  const c3 = cp.spawnSync(process.execPath, [CLI, "backlog", "add", "--tag", "백로그", "--title", "자식 경합 등록"], { encoding: "utf8", env, timeout: 20000, windowsHide: true });
  ok(c3.status === 0 && /id: [a-f0-9]{16}/.test(c3.stdout), "해제 후 자식 add 성공(id 영수증)");
}

console.log("[5] 배선 — CLI·rejudge 규약·TTL 비대상");
const src = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
ok(/case "backlog":/.test(src) && /function cmdBacklog\(rest\)/.test(src), "CLI 등록(add/list/done/dismiss/clear)");
ok(/backlog add --tag/.test(CL.BASE_CORE.rejudge) && /출력된 id를 보고에 인용하라/.test(CL.BASE_CORE.rejudge) && /backlog add --tag/.test(CL.BASE_CORE_EN.rejudge), "core 재판단 규약 — 장부 기록+id 영수증 인용(ko/en · 기록 누락 가시화)");
ok(/비밀값·개인정보 원문 금지/.test(CL.BASE_CORE.rejudge) && /never secret\/PII originals/.test(CL.BASE_CORE_EN.rejudge), "제목 민감 최소화 규약(ko/en)");
const cl = fs.readFileSync(path.join(ROOT, "bridge", "contract-lib.js"), "utf8");
ok(!/verify-backlog/.test(cl.split("function cleanupOldState")[1].split("function maybeCleanupState")[0] || ""), "TTL 스윕 비대상 — 사용자 할 일은 자동 삭제 안 함(수동 clear만)");


// [v2.3 2026-07-17] 대시보드 부채 카드 — 소스 계약+★실행 반례★(컴파일 산출물에서 순수 함수 추출·의존성 없음)
{
  const extSrc = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/typeof lib\.readBacklog !== "function"/.test(extSrc) && /표시 전용 휴리스틱/.test(extSrc), "카드 상태 배선 — readBacklog+표시 전용 휴리스틱 명시(캐논/게이트 미사용)");
  ok(/id="backlogSec"/.test(extSrc) && /id="blSummary"/.test(extSrc) && /id="blList"/.test(extSrc) && /backlog done\|dismiss/.test(extSrc), "카드 HTML — backlogSec·blSummary·blList·CLI 처분 안내(읽기 전용)");
  const rBeg = extSrc.indexOf('const sec=$("backlogSec")'); const rEnd = extSrc.indexOf("// ⑤ 범위 장부 카드", rBeg);
  const renderBlk = rBeg > 0 && rEnd > rBeg ? extSrc.slice(rBeg, rEnd) : "";
  ok(renderBlk.length > 0 && !/innerHTML/.test(renderBlk) && /replaceChildren\(\)/.test(renderBlk) && /bl\.corrupt\?T\(" · 손상 "/.test(renderBlk), "카드 렌더 — 동적 값 innerHTML 부재(텍스트 조립만)·손상 줄 경고");
  ok(/if\(!bl\)\{ sec\.style\.display="none"; return; \}/.test(renderBlk) && /비어 있음 — 검증에서 범위 밖 제안/.test(renderBlk), "빈 보관함=카드 유지+비어 있음 표시(기능 발견 가능 — 숨김은 무폴더/구 런타임만)");
  // ★실행 반례★ — 렌더 블록을 추출 실행해 표시 계약을 상태별로 잠근다(확인 판정 [보완] 수용 2026-07-18:
  // 소스 정규식만으로는 '카드 유지·빈 분기 조건·영문 문구·corrupt-only 경로'를 회귀 방지하지 못함).
  {
    const bodyEnd = renderBlk.lastIndexOf("});"); // safe(function(){...}) 닫힘 직전까지가 완결 문장 목록
    const body = bodyEnd > 0 ? renderBlk.slice(0, bodyEnd) : "";
    ok(body.length > 0, "렌더 블록 본문 추출 가능(safe 닫힘 절단)");
    const runRender = (backlog, lang) => {
      const mkNode = () => ({ style: {}, children: [], textContent: "", className: "", appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; } });
      const nodes = { backlogSec: mkNode(), blSummary: mkNode(), blList: mkNode() };
      const fn = new Function("$", "T", "el", "d", body);
      fn((id) => nodes[id], (ko, en) => (lang === "en" ? en : ko), (tag, cls, text) => { const n = mkNode(); n.className = cls || ""; if (text != null) n.textContent = text; return n; }, { backlog });
      return nodes;
    };
    let n = runRender(null, "ko");
    ok(n.backlogSec.style.display === "none", "RB-1 bl=null(무폴더·구 런타임) — 카드 숨김 유지");
    n = runRender({ caution: 0, backlog: 0, corrupt: 0, items: [] }, "ko");
    ok(n.backlogSec.style.display === "" && n.blSummary.textContent.startsWith("비어 있음"), "RB-2 정상 빈 상태 — 카드 표시+'비어 있음'(ko · 실사고 2026-07-18 반례)");
    n = runRender({ caution: 0, backlog: 0, corrupt: 0, items: [] }, "en");
    ok(n.blSummary.textContent.startsWith("empty — out-of-scope"), "RB-3 정상 빈 상태 — 영문 문구 존재(ko/en 쌍)");
    n = runRender({ caution: 0, backlog: 0, corrupt: 2, items: [] }, "ko");
    ok(n.backlogSec.style.display === "" && /손상 2줄/.test(n.blSummary.textContent) && !/비어 있음/.test(n.blSummary.textContent), "RB-4 corrupt-only(open 0) — 빈 문구가 아니라 손상 요약");
    n = runRender({ caution: 1, backlog: 0, corrupt: 0, readError: true, items: [] }, "ko");
    ok(n.backlogSec.style.display === "" && /불러올 수 없음/.test(n.blSummary.textContent) && n.blList.children.length === 0, "RB-5 판독 실패 — '비어 있음' 위장 금지+'불러올 수 없음' 표시([주의] 수용분)");
    n = runRender({ caution: 1, backlog: 0, corrupt: 0, items: [{ id: "a".repeat(16), tag: "주의", title: "t", file: "f", seenCount: 1, ageDays: 1, due: false }] }, "ko");
    ok(/열림 1건/.test(n.blSummary.textContent) && n.blList.children.length === 1, "RB-6 항목 존재 — 요약·목록 렌더 정상(회귀 앵커)");
  }
  // readBacklog 판독 실패 구분 — ENOENT=빈 상태·그 외=readError(위장 차단의 데이터 원천)
  {
    const wsE = "D:/bl-readerr";
    fs.mkdirSync(CL.backlogFileFor(wsE), { recursive: true }); // 파일 자리에 디렉터리 → EISDIR(비-ENOENT 판독 실패 재현)
    const rE = CL.readBacklog(wsE);
    ok(rE.readError === true && rE.items.length === 0, "readBacklog 비-ENOENT 실패 — readError:true(빈 상태로 축소 금지)");
    ok(CL.readBacklog("D:/bl-noexist").readError === undefined, "readBacklog ENOENT(미생성) — readError 없음(진짜 빈 상태)");
  }
  ok(/if\(text!=null\)e\.textContent=text;/.test(extSrc), "공용 el() 헬퍼 — textContent 조립 계약(향후 innerHTML 회귀 방어)");
  // 실행 반례 — out/extension.js에서 computeBacklogView 추출(체인은 tsc 선행)
  const outFile = path.join(ROOT, "out", "extension.js");
  ok(fs.existsSync(outFile), "out/extension.js 존재(없으면 npm run compile 또는 npx tsc -p ./ 후 재실행)");
  if (fs.existsSync(outFile)) {
    const outSrc = fs.readFileSync(outFile, "utf8");
    const b = outSrc.indexOf("function computeBacklogView("); const e = outSrc.indexOf("\nfunction ", b + 10);
    ok(b > 0 && e > b, "컴파일 산출물에서 computeBacklogView 추출 가능");
    const view = new Function(outSrc.slice(b, e) + "\nreturn computeBacklogView;")();
    const DAY = 86400000; const now = 1800000000000;
    const mk = (o) => Object.assign({ id: "aaaaaaaaaaaaaaaa", tag: "백로그", title: "t", file: "f", status: "open", seenCount: 1, firstSeen: new Date(now - DAY).toISOString(), lastSeen: new Date(now - DAY).toISOString() }, o);
    let v = view([mk({}), mk({ id: "b", status: "done" })], now);
    ok(v.items.length === 1 && v.items[0].id === "aaaaaaaaaaaaaaaa", "CB-V1 open만 포함(done 제외)");
    v = view([mk({ id: "c", firstSeen: new Date(now - 40 * DAY).toISOString(), lastSeen: new Date(now - 1 * DAY).toISOString(), seenCount: 2 })], now);
    ok(v.items[0].ageDays === 40 && v.items[0].due === true, "CB-V2 나이=firstSeen 기준(재발견이 40일 항목을 D+1로 되감지 못함 — 1차 blocker 반례)");
    v = view([mk({ id: "d", seenCount: 3 })], now);
    ok(v.items[0].due === true, "CB-V3 재발견 3회=검토 기한");
    v = view([mk({ id: "e1", firstSeen: new Date(now - 5 * DAY).toISOString() }), mk({ id: "e2", firstSeen: new Date(now - 45 * DAY).toISOString() }), mk({ id: "e3", firstSeen: new Date(now - 10 * DAY).toISOString(), seenCount: 4 })], now);
    ok(v.items[0].id === "e2" && v.items[1].id === "e3" && v.items[2].id === "e1", "CB-V4 정렬=검토기한 우선→오래된 순");
    const many = []; for (let i = 0; i < 35; i++) many.push(mk({ id: "m" + i, title: "t" + i }));
    v = view(many, now);
    ok(v.items.length === 30 && v.backlog === 35, "CB-V5 표시 30건 절단·집계는 전체(35)");
    v = view([mk({ id: "x", tag: "주의" }), mk({ id: "y" })], now);
    ok(v.caution === 1 && v.backlog === 1, "CB-V6 태그별 집계");
  }
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
