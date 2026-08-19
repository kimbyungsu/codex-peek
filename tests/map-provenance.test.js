"use strict";
/*
 * 설계 경위 색인·선조회(MAP-PROVENANCE-DESIGN v1) — 매처 실행 반례(설계검증 1~3차 계보)·
 * 별도 영수증 장부·게이트 앞 구획·훅 2종 결속·배포 편입.
 */
process.env.CODEX_BRIDGE_HOME = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "prov_home_"));
const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MPV = require(path.join(ROOT, "bridge", "map-provenance.js"));
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));

let pass = 0, fail = 0;
const ok = (c, n) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

// 픽스처 repo + 색인(설계 §1 형식 — 본 저장소 초기 색인과 동형)
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "prov_repo_"));
fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
const IDX = [
  "# 설계 결정 색인", "",
  "## D-2026-07-24-intent-auto — MAP 대기 변경은 승인 카드 대신 자동화",
  "- 날짜: 2026-07-24 · 종류: 개정 · 상태: 유효",
  "- 결정: 비정책 의미 제안은 verifier-resolved로 처리, 비정책 카드는 폐기.",
  "- 정본: docs/MAP-V2-DESIGN.md 관련 절.",
  "- 찾는말: 정책 0, 자동 승인, 카드 없음, 왜 정책이 안 생기나, intent policy", "",
  "## D-2026-01-01-policy-alpha — 정책 관련 다른 결정(동점 유도용)",
  "- 날짜: 2026-01-01 · 종류: 확정 · 상태: 유효",
  "- 결정: 정책 표시 형식을 확정.",
  "- 정본: docs/OTHER.md.",
  "- 찾는말: 정책 표시, 형식", "",
].join("\n");
fs.writeFileSync(path.join(repo, "docs", "DECISIONS.md"), IDX, "utf8");

console.log("[1] 파서 — 원자 항목·찾는말·규약 어휘 거부");
{
  const idx = MPV.parseDecisionsIndex(repo);
  ok(idx.ok && idx.entries.length === 2, "항목 2건 파싱");
  ok(idx.entries[0].keywords.includes("정책 0") && /verifier-resolved/.test(idx.entries[0].decision), "찾는말·결정 본문 결속");
  const marker = Object.values(Object.values(CL.FINDINGS_MARKERS_V2 || CL.FINDINGS_MARKERS)[0])[0];
  fs.writeFileSync(path.join(repo, "docs", "DECISIONS.md"), IDX + "\n## D-2026-09-01-bad — 오염 항목\n- 결정: x.\n- 찾는말: " + marker + "\n", "utf8");
  const idx2 = MPV.parseDecisionsIndex(repo);
  ok(idx2.entries.length === 2 && idx2.rejected.length === 1 && idx2.rejected[0].reason === "protocol-vocab", "규약 어휘 찾는말=항목 거부(protoSeeds 오염 원천 차단)");
  fs.writeFileSync(path.join(repo, "docs", "DECISIONS.md"), IDX, "utf8");
}

console.log("[2] 매처 — 설계검증 실측 반례의 정방향 재현(발단 사고)");
{
  const { entries } = MPV.parseDecisionsIndex(repo);
  ok(MPV.tokenize("정책 0 정상인가").includes("0"), "숫자 토큰은 1자여도 유지(2차 blocker① — '0' 탈락 반례)");
  const m1 = MPV.matchDecisions(entries, "정책 0 정상인가");
  ok(m1.length >= 1 && m1[0].entry.id === "D-2026-07-24-intent-auto" && m1[0].phrase >= 1, "★'정책 0 정상인가' → 연속구 가점으로 intent-auto 1위 도달(일반어 동점 밀림 차단)");
  const m2 = MPV.matchDecisions(entries, "왜 정책이 안 생기나");
  ok(m2.length >= 1 && m2[0].entry.id === "D-2026-07-24-intent-auto", "'왜 정책이 안 생기나' → 찾는말 교집합 도달(1차 blocker① — 씨앗 0건 질의)");
  ok(MPV.matchDecisions(entries, "전혀 무관한 주제 이야기").length === 0, "교집합·연속구 0=매칭 없음(무관 동봉 0)");
  // 정렬키 결정론: 연속구>교집합>씨앗>ID — '정책'만 겹치는 동점은 ID 사전순
  const tie = MPV.matchDecisions(entries, "정책");
  ok(tie.length === 2 && tie[0].entry.id < tie[1].entry.id, "동점=결정 ID 사전순(결정론)");
  // 연속구는 토큰쌍 '집합' 대조(구현검증 보완 실측: 부분 문자열이면 "재정책 0"이 "정책 0"에 오탐)
  const fake = [{ id: "D-x", title: "무제", decision: "", source: "", keywords: ["재정책 0"] }];
  const fp = MPV.matchDecisions(fake, "정책 0 문제");
  ok(fp.length === 1 && fp[0].phrase === 0, "'재정책 0' 어휘에 '정책 0' 연속구 오탐 없음(phrase=0·교집합 '0'만)");
}

console.log("[3] 영수증 — 별도 장부만 기록·0건도 기록·유계");
{
  const before = fs.existsSync(CL.ATTACH_USAGE_FILE) ? fs.readFileSync(CL.ATTACH_USAGE_FILE, "utf8") : null;
  const r0 = MPV.queryProvenance(repo, "전혀 무관한 주제");
  ok(r0.ok && r0.matches.length === 0, "0건 질의");
  const r1 = MPV.queryProvenance(repo, "정책 0 정상인가");
  ok(r1.matches.length >= 1, "매칭 질의");
  const lines = fs.readFileSync(MPV.PROVENANCE_USAGE_FILE, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  ok(lines.length >= 2 && lines[lines.length - 2].matched.length === 0 && lines[lines.length - 1].matched.includes("D-2026-07-24-intent-auto"), "0건·매칭 양쪽 영수증(부재 증명의 얕은 종료 방지)");
  // 구현검증 blocker(ab-7): 질의 원문 평문 금지 — 지문 16자+길이만
  const q9 = lines[lines.length - 1];
  ok(q9.query === undefined && /^[0-9a-f]{16}$/.test(q9.queryFp) && Number.isInteger(q9.queryLen), "질의 원문 미기록 — 지문(sha1 16자)+길이만(비밀값·개인정보 로그 잔존 차단)");
  // 구현검증 blocker(ab-5): append·트림이 같은 파일 잠금 안 — 다중 창 lost-update 차단(소스 계약 핀)
  const mpvSrc = fs.readFileSync(path.join(ROOT, "bridge", "map-provenance.js"), "utf8");
  ok(/const lockF = PROVENANCE_USAGE_FILE \+ "\.lock"/.test(mpvSrc) && /withFileLockStrict\(lockF,/.test(mpvSrc), "영수증 append+트림=단일 파일 잠금(withFileLockStrict — 옛 스냅샷 재작성 덮어쓰기 차단)");
  ok(/extractSeeds\(String\(queryText \|\| ""\)\)/.test(mpvSrc), "why 경로도 씨앗 가점 결속(동봉 경로와 정렬키 동형 — 보완 반영)");
  const after = fs.existsSync(CL.ATTACH_USAGE_FILE) ? fs.readFileSync(CL.ATTACH_USAGE_FILE, "utf8") : null;
  ok(before === after, "attach.jsonl 바이트 무변경(1차 blocker③ — 대시보드 '실린 기억' 카드 무회귀)");
  for (let i = 0; i < MPV.USAGE_TRIM_AT + 20; i++) MPV.appendProvenanceUsage({ ts: "t" + i, kind: "query", matched: [] });
  const n = fs.readFileSync(MPV.PROVENANCE_USAGE_FILE, "utf8").split(/\r?\n/).filter(Boolean).length;
  ok(n <= MPV.USAGE_TRIM_AT, "장부 유계(" + n + " ≤ " + MPV.USAGE_TRIM_AT + ")");
  // R2 blocker 실행 반례: 강제 종료가 남긴 '사망 pid' 잠금 → 격리 관용구로 회수+재시도로 영수증 지속
  const lockF = MPV.PROVENANCE_USAGE_FILE + ".lock";
  fs.writeFileSync(lockF, "999999-deadbeef", "utf8"); // 존재할 수 없는 pid=사망 확정 잠금 재현
  const okDead = MPV.appendProvenanceUsage({ ts: "dead-reclaim", kind: "query", matched: [] });
  ok(okDead === true && !fs.existsSync(lockF), "★사망 잠금 잔존 → 격리 회수+재시도로 영수증 기록 지속(강제 종료 후 조용한 영구 중단 차단)");
  for (const n of fs.readdirSync(path.dirname(lockF))) if (n.includes(".lock.stale-")) fs.unlinkSync(path.join(path.dirname(lockF), n)); // 격리 잔재 청소(다음 단언 독립)
  const rr = MPV.queryProvenance(repo, "정책 0 정상인가");
  ok(rr.receiptOk === true, "queryProvenance가 영수증 성패를 반환(조용한 삼킴 금지 — CLI가 실패 시 [주의] 고지)");
  // R3 TOCTOU 반례: '살아있는' 잠금(내 pid)은 절대 회수·삭제되지 않는다 — append는 실패로 끝나고 잠금은 원형 보존
  const liveTok = process.pid + "-livetok";
  fs.writeFileSync(lockF, liveTok, "utf8");
  const okLive = MPV.appendProvenanceUsage({ ts: "live-blocked", kind: "query", matched: [] });
  ok(okLive === false && fs.readFileSync(lockF, "utf8") === liveTok, "★활성 잠금 불가침 — 회수·삭제 없이 실패 반환(TOCTOU 오탈취 경로 소멸)");
  ok(/quarantineContractLock\(lockF, raw\)/.test(fs.readFileSync(path.join(ROOT, "bridge", "map-provenance.js"), "utf8")), "회수=확립 격리 관용구 단일 경로(직접 unlink 잔재 0)");
  fs.unlinkSync(lockF);
  // R5 blocker 인터리빙 재현: 첫 판독 뒤·격리 내부 판독 전에 타 창이 선회수(absent) → 그래도 재획득·기록
  fs.writeFileSync(lockF, "999999-deadbeef", "utf8");
  const origQ = CL.quarantineContractLock;
  CL.quarantineContractLock = (lp, raw) => { try { fs.unlinkSync(lp); } catch { /* 이미 없음 */ } return origQ(lp, raw); }; // 타 창 선회수를 격리 직전에 주입 → 내부 판독=absent
  let okAbsent;
  try { okAbsent = MPV.appendProvenanceUsage({ ts: "absent-race", kind: "query", matched: [] }); }
  finally { CL.quarantineContractLock = origQ; }
  ok(okAbsent === true, "★선회수(absent) 인터리빙에도 재획득·영수증 기록(누락 0 — R5 반례의 정방향)");
  // R5 보완: STATS_DIR 격리물(.lock.stale-*)이 TTL 청소 대상에 편입
  const staleF = MPV.PROVENANCE_USAGE_FILE + ".lock.stale-1";
  fs.writeFileSync(staleF, "999999-old", "utf8");
  const old9 = Date.now() / 1000 - 8 * 24 * 3600;
  fs.utimesSync(staleF, old9, old9); // 8일 전 mtime
  CL.cleanupOldState(Date.now());
  ok(!fs.existsSync(staleF), "경위 잠금 격리물이 7일 TTL 청소로 정리(stats 서랍 편입 — 무기한 누적 차단)");
}

console.log("[3b] why CLI 실행(문자열 배선이 아니라 실제 프로세스) — R3 blocker② 재발 방지");
{
  const { spawnSync } = require("child_process");
  const r1 = spawnSync(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "why", "전혀 무관한 주제"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME } });
  ok(r1.status === 0 && !/ReferenceError|is not defined/.test(String(r1.stderr || "")), "why CLI 실행 종료코드 0(참조 오류 없음 — 실행 시험으로 잠금)");
  ok(/조회 영수증 기록됨|query receipted/.test(String(r1.stdout || "")), "성공 시 '기록됨' 한 가지만 고지(성패 모순 문구 없음)");
}

console.log("[4] 동봉 구획 — 게이트 앞 독립·상한 2·색인 부재=null(무회귀)");
{
  const s = MPV.provenanceSectionFor(repo, "정책 0 정상인가 확인 요청", "ko");
  ok(!!s && /\[설계 경위\]/.test(s.text) && s.items.includes("D-2026-07-24-intent-auto"), "매칭 시 구획 생성");
  ok(s.items.length <= MPV.ATTACH_MAX, "상한 " + MPV.ATTACH_MAX + "건(4축 몫 비공유)");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "prov_empty_"));
  ok(MPV.provenanceSectionFor(empty, "정책 0 정상인가", "ko") === null, "색인 부재=null(현행 바이트 동일 — 무회귀)");
  ok(MPV.provenanceSectionFor(repo, "", "ko") === null, "요청문 없음=null");
  // 게이트 앞 결속(map-reader): withProv가 세 반환 경로 전부를 감싼다(의도 축 0 조기 반환에도 부착)
  const mr = fs.readFileSync(path.join(ROOT, "bridge", "map-reader.js"), "utf8");
  ok(/withProv\(renderV2Slice\(/.test(mr) && /withProv\(CL\.buildScoutAttach\(/.test(mr) && /return withProv\(\{\s*\n\s*text: \[mapNotice/.test(mr), "buildMapAttach 세 경로 전부 경위 구획 결속(게이트 앞 — 2차 blocker②)");
  ok(mr.indexOf("provenanceSectionFor(target") < mr.indexOf("readMapProjection(target)"), "경위 구획은 지도 판독보다 먼저 계산(게이트 무관)");
}

console.log("[4b] 구현검증 blocker 실행 반례 — 기존 동봉이 null이어도 경위 매칭이 있으면 단독 봉투");
{
  const MRD = require(path.join(ROOT, "bridge", "map-reader.js"));
  const origProj = MRD.readMapProjection, origAttach = CL.buildScoutAttach;
  MRD.readMapProjection = () => ({ ok: true, source: "none" });   // 지도 없는 정상 프로젝트
  CL.buildScoutAttach = () => null;                                // 기존 동봉=무동봉(null)
  let out;
  try { out = MRD.buildMapAttach(repo, { scoutMode: "on" }, "ko", "정책 0 정상인가 확인 요청"); }
  finally { MRD.readMapProjection = origProj; CL.buildScoutAttach = origAttach; }
  ok(!!out && /\[설계 경위\]/.test(out.text) && Array.isArray(out.mapItems) && out.mapItems.length === 0, "★지도 무동봉(null) 경로에서 경위 구획 단독 봉투 부착(구현검증 실행 반례의 정방향)");
  // 경위 매칭도 없으면 여전히 null(무회귀)
  MRD.readMapProjection = () => ({ ok: true, source: "none" });
  CL.buildScoutAttach = () => null;
  let out2;
  try { out2 = MRD.buildMapAttach(repo, { scoutMode: "on" }, "ko", "전혀 무관한 주제 이야기"); }
  finally { MRD.readMapProjection = origProj; CL.buildScoutAttach = origAttach; }
  ok(out2 === null, "경위 매칭 없음+지도 무동봉=null 유지(무회귀)");
}

console.log("[5] 진단 안내 — scoutMode 독립·색인 존재 시만·훅 2종 결속");
{
  ok(MPV.buildProvenanceNotice(repo, { scoutMode: "off" }) !== null, "2트랙(scoutMode off)에서도 안내 생성(buildScoutDirective 편승 불가 반례)");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "prov_empty2_"));
  ok(MPV.buildProvenanceNotice(empty, {}) === null, "색인 부재=안내 없음(소음 0)");
  const ci = fs.readFileSync(path.join(ROOT, "bridge", "contract-inject.js"), "utf8");
  const ch = fs.readFileSync(path.join(ROOT, "bridge", "codex-hook.js"), "utf8");
  ok(/map-provenance\.js"\)\.buildProvenanceNotice\(ws, c\)/.test(ci), "Claude 훅(contract-inject.js) 결속");
  ok(/map-provenance\.js"\)\.buildProvenanceNotice\(ws,c\)/.test(ch), "Codex 훅(codex-hook.js implementerContext) 결속(3차 blocker — 한쪽 결속 금지)");
}

console.log("[6] CLI·배포·후보 나열");
{
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(/case "why": \{/.test(cb) && /queryProvenance\(repo9, q\)/.test(cb), "why CLI 배선");
  const inst = fs.readFileSync(path.join(ROOT, "install.js"), "utf8");
  ok(inst.includes('"map-provenance.js"'), "배포 목록(manifest) 편입 — 설치본 로드 보장");
  const scan = require(path.join(ROOT, "scripts", "provenance-scan.js")).scan();
  ok(Array.isArray(scan) && scan.length > 0 && scan.some((r) => /MAP-V2-DESIGN/.test(r)), "후보 나열이 기존 설계 문서의 결정 표지를 찾음(" + scan.length + "건)");
}


console.log("[8] v2 자동층 — 안전 경계·anchor·reducer·수확 자격(설계 5왕복 동결의 실행 반례)");
{
  const os8 = require("os");
  const repo8 = fs.mkdtempSync(path.join(os8.tmpdir(), "prov8_"));
  fs.mkdirSync(path.join(repo8, "docs"), { recursive: true });
  const rk8 = MPV.repoKeyFor(repo8);
  // 안전 경계(ab-7): 절대경로·..·민감 경로 거부
  ok(MPV.validateSourceFile(repo8, "C:/x/a.md").ok === false, "절대경로 거부");
  ok(MPV.validateSourceFile(repo8, "../out.md").ok === false, ".. 탈출 거부");
  ok(MPV.validateSourceFile(repo8, ".env").ok === false && MPV.validateSourceFile(repo8, "config/credentials.json").ok === false, "민감 경로 거부(공용 판정기 — enrich-providers 참조)");
  // symlink 탈출(containment): repo 밖을 가리키는 링크 — 만들 수 있는 환경에서만 검사(권한 없으면 생략 고지)
  const outside8 = fs.mkdtempSync(path.join(os8.tmpdir(), "prov8out_"));
  fs.writeFileSync(path.join(outside8, "secret.md"), "# 밖\n", "utf8");
  let linked8 = false;
  try { fs.symlinkSync(path.join(outside8, "secret.md"), path.join(repo8, "link.md"), "file"); linked8 = true; } catch { /* 권한 제한 환경 */ }
  if (linked8) ok(MPV.validateSourceFile(repo8, "link.md").ok === false, "symlink로 repo 밖을 가리키면 realpath containment가 거부");
  else console.log("  (symlink 생성 권한 없음 — containment 반례는 상대경로 검사로 대체 확인됨)");
  // R2 blocker①(ab-7): 저장소 '내부' 민감 파일을 가리키는 별칭 — 선언 경로가 무해해도 실경로 재판정으로 거부
  fs.writeFileSync(path.join(repo8, ".env"), "SECRET=1\n", "utf8");
  let linkedIn8 = false;
  try { fs.symlinkSync(path.join(repo8, ".env"), path.join(repo8, "docs", "public.md"), "file"); linkedIn8 = true; } catch { /* 권한 제한 */ }
  if (linkedIn8) ok(MPV.validateSourceFile(repo8, "docs/public.md").reason === "sensitive-target", "★내부 민감 파일 별칭(docs/public.md→.env)=실경로 민감 재판정 거부(R2 반례의 정방향)");
  else console.log("  (symlink 권한 없음 — 내부 별칭 반례 생략·실경로 재판정 코드는 소스 핀으로 확인)");
  ok(/isSensitiveProvenancePath\(rel\.replace/.test(fs.readFileSync(path.join(ROOT, "bridge", "map-provenance.js"), "utf8")), "실경로 상대 표기에 민감 판정 재적용(소스 계약)");
  // anchor 해석: 중복 헤딩=서수 필수·lines=끝줄 포함+개행 바이트
  const doc8 = "# 머리\n본문A\n## 결정\n내용1\n## 결정\n내용2\n## 끝\n마지막";
  fs.writeFileSync(path.join(repo8, "docs", "d.md"), doc8, "utf8");
  ok(MPV.resolveAnchor(repo8, "docs/d.md", "heading:결정").reason === "anchor-ambiguous", "중복 헤딩+서수 없음=모호 거부");
  const h2 = MPV.resolveAnchor(repo8, "docs/d.md", "heading:결정#2");
  ok(h2.ok && h2.text === "## 결정\n내용2\n", "서수 결속=2번째 구간(다음 동급 헤딩 전까지·개행 포함)");
  const ln = MPV.resolveAnchor(repo8, "docs/d.md", "lines:2-3");
  ok(ln.ok && ln.text === "본문A\n## 결정\n", "lines=끝줄 포함(inclusive)+개행 바이트 포함");
  const lnEnd = MPV.resolveAnchor(repo8, "docs/d.md", "lines:8-8");
  ok(lnEnd.ok && lnEnd.text === "마지막", "마지막 줄 무개행=원문 그대로(개행 미추가)");
  ok(MPV.resolveAnchor(repo8, "docs/d.md", "lines:8-9").reason === "anchor-range", "범위 초과 거부");
  // 등재·멱등·gen: 같은 사건·같은 내용=중복 생략, 내용 갱신+새 사건=새 세대
  const mkRef = (anchor) => { const rv = MPV.resolveAnchor(repo8, "docs/d.md", anchor); return { file: "docs/d.md", anchor, contentHash: MPV.excerptShaOf(rv.text), repoKey: rk8 }; };
  const r1 = MPV.registerAutoEntries(repo8, [mkRef("heading:결정#1")], { eventKind: "finding-resolved", eventRef: "f-t1", title: "결정 제목" });
  ok(r1.ok && r1.results[0].gen === 1, "자동 등재 1세대");
  const r1b = MPV.registerAutoEntries(repo8, [mkRef("heading:결정#1")], { eventKind: "finding-resolved", eventRef: "f-t1", title: "결정 제목" });
  ok(r1b.results[0].skipped === "dup", "같은 사건·같은 내용=멱등(중복 등재 0)");
  // repoKey 불일치=후보 대기(ab-1)
  const rBad = MPV.registerAutoEntries(repo8, [{ file: "docs/d.md", anchor: "heading:결정#1", contentHash: "0".repeat(40), repoKey: "다른키" }], { eventKind: "x", eventRef: "e", title: "t" });
  ok(rBad.results[0].reason === "repo-mismatch", "repoKey 불일치=자격 없음(후보 대기)");
  // R2 blocker②: contentHash 누락=거부(옛 사건이 '현재' 바이트를 재수확하는 승계 경로 원천 차단)
  const rNoHash = MPV.registerAutoEntries(repo8, [{ file: "docs/d.md", anchor: "heading:결정#1", repoKey: rk8 }], { eventKind: "x", eventRef: "e-nh", title: "t" });
  ok(rNoHash.results[0].reason === "no-content-hash", "★contentHash 없는 참조=등재 거부(증명 바이트 미상 — R2 반례의 정방향)");
  // 기록 시점 지문과 현재가 다르면 등재 거부(옛 증명 승계 금지 — 재수확 게이트)
  const staleRef = Object.assign(mkRef("heading:결정#1"), { contentHash: "0".repeat(40) });
  const rDrift = MPV.registerAutoEntries(repo8, [staleRef], { eventKind: "x", eventRef: "e2", title: "t" });
  ok(rDrift.results[0].reason === "content-drift", "기록 시점 지문≠현재 구간=등재 거부(content-drift — 옛 증명을 새 내용에 승계 금지)");
  // 지문 실효: 정본 구간 개정 → merged에서 auto 제외(stale)
  const before8 = MPV.mergedEntriesFor(repo8);
  fs.writeFileSync(path.join(repo8, "docs", "d.md"), doc8.replace("내용1", "내용1-개정"), "utf8");
  const after8 = MPV.mergedEntriesFor(repo8);
  ok(before8.auto.length === 1 && after8.auto.length === 0 && after8.staleCount === 1, "정본 개정=자동 실효(매칭 제외·stale 집계)");
  // 재수확은 '새 사건'만: 같은 사건 재등재는 지문 갱신돼도 dup 아님(내용 다름)·새 eventRef로 새 세대
  const r2 = MPV.registerAutoEntries(repo8, [mkRef("heading:결정#1")], { eventKind: "finding-resolved", eventRef: "f-t2", title: "결정 제목" });
  ok(r2.ok && r2.results[0].gen === 2, "새 사건(새 eventRef)+새 내용=새 세대(gen 2) 재수확");
  ok(MPV.mergedEntriesFor(repo8).auto.length === 1, "재수확 후 fresh 1건 복귀");
  // R2 blocker③: 정본이 '이전 검증 내용'으로 회귀 — 최신 gen2는 stale이지만 gen1이 fresh → gen1 생존
  fs.writeFileSync(path.join(repo8, "docs", "d.md"), doc8, "utf8"); // gen1이 증명한 원문으로 복원
  const mBack = MPV.mergedEntriesFor(repo8);
  ok(mBack.auto.length === 1 && mBack.auto[0].id.endsWith("-g1"), "★정본 회귀 시 이전 fresh 세대(gen1) 선발(최신 gen 단독 확정 반례의 정방향 — fresh 우선)");
  // R2 확인 blocker: intent 증명 바이트=사건 레코드 유도(수확 시점 현재 파일 아님) — 서식만 바뀐
  // 정책 파일(canonical 동일=done 판독 유지)을 옛 사건이 재수확하는 승계 경로 차단
  const pol8 = { policyId: "pol-1", predicateDescription: "설명" };
  fs.mkdirSync(path.join(repo8, "project-map", "policies"), { recursive: true });
  const polFile8 = path.join(repo8, "project-map", "policies", "pol-1.json");
  fs.writeFileSync(polFile8, JSON.stringify(pol8, null, 1), "utf8"); // 파이프라인 기록기와 동일 서식
  const refI = MPV.intentPolicyRefFor(repo8, pol8);
  const rI1 = MPV.registerAutoEntries(repo8, [refI], { eventKind: "intent-choice", eventRef: "card-old", title: "정책" });
  ok(rI1.ok && rI1.results[0].gen === 1, "파이프라인 서식 그대로=사건 유도 지문이 파일 바이트와 일치 → 등재");
  fs.writeFileSync(polFile8, JSON.stringify(pol8, null, 2), "utf8"); // 서식만 변경(canonical 동일)
  const rI2 = MPV.registerAutoEntries(repo8, [MPV.intentPolicyRefFor(repo8, pol8)], { eventKind: "intent-choice", eventRef: "card-old", title: "정책" });
  ok(rI2.results[0].reason === "content-drift", "★서식만 바뀐 정책 파일=옛 사건으로 재수확 거부(지문은 사건에서 유도 — R2 확인 반례의 정방향)");
  ok(MPV.readAutoLedger(rk8).filter((r) => (!r.kind || r.kind === "entry") && String((r.origin || {}).eventRef) === "card-old").length === 1, "재수확 거부 시 새 세대·새 subject 항목 미생성(장부 불변)");
  const provSrc8 = fs.readFileSync(path.join(ROOT, "bridge", "map-provenance.js"), "utf8");
  const harvBody8 = provSrc8.slice(provSrc8.indexOf("function harvestFromIntentChoices"), provSrc8.indexOf("function approvalEventsFileFor"));
  ok(/intentPolicyRefFor\(repoRoot, policy\)/.test(harvBody8) && !/readFileSync/.test(harvBody8), "intent 수확기=사건 유도 지문만 사용(현재 파일 판독 없음 — 소스 계약)");
}

console.log("[9] v2 reducer 5단 — append 순서 무관 결정론(gen 수치·tombstoneId 철회·scope 2종)");
{
  const E = (sk, gen, ev, ts) => ({ kind: "entry", id: "A-" + sk.slice(0, 4) + "-g" + gen, subjectKey: sk, gen, ts, title: "t", source: { file: "f", anchor: "a", excerptSha: "s" }, excerpt: "x", keywords: [], origin: { eventKind: "k", eventRef: ev, repoKey: "r", registeredAt: ts } });
  const SK = "a".repeat(40), SK2 = "b".repeat(40);
  // gen 수치 비교: 10 > 2 (사전순이면 2가 이김 — R3 반례)
  const recs1 = [E(SK, 2, "e2", "2026-01-02"), E(SK, 10, "e10", "2026-01-10")];
  ok(MPV.reduceAutoEntries(recs1)[0].gen === 10, "gen=10이 gen=2를 이김(수치 비교 — 사전순 반례 차단)");
  ok(MPV.reduceAutoEntries([...recs1].reverse())[0].gen === 10, "append 순서 뒤섞기에도 같은 결과(결정론)");
  // subject tombstone=전체 억제·철회는 tombstoneId 결속
  const tb1 = { kind: "tombstone", tombstoneId: "tb-1", subjectKey: SK, scope: "subject", ts: "2026-01-11" };
  ok(MPV.reduceAutoEntries([...recs1, tb1]).length === 0, "subject tombstone=자동층 억제");
  const rt1 = { kind: "tombstone-retract", subjectKey: SK, targetTombstoneId: "tb-1", ts: "2026-01-12" };
  ok(MPV.reduceAutoEntries([...recs1, tb1, rt1])[0].gen === 10, "철회(targetTombstoneId 결속)=억제 해제");
  ok(MPV.reduceAutoEntries([rt1, tb1, ...recs1])[0].gen === 10, "철회·tombstone·항목 순서 뒤섞기에도 동일(결정론)");
  // event tombstone=그 사건 세대만 제거(같은 결정의 다른 사건은 생존)
  const tbE = { kind: "tombstone", tombstoneId: "tb-2", subjectKey: SK, scope: "event", eventRef: "e10", ts: "2026-01-13" };
  ok(MPV.reduceAutoEntries([...recs1, tbE])[0].gen === 2, "event tombstone=그 사건(e10)만 제거·다른 사건(e2) 생존");
  // scope=event인데 eventRef 부재=무효 tombstone(항목 생존)
  const tbBad = { kind: "tombstone", tombstoneId: "tb-3", subjectKey: SK2, scope: "event", ts: "2026-01-14" };
  ok(MPV.reduceAutoEntries([E(SK2, 1, "e1", "2026-01-01"), tbBad]).length === 1, "eventRef 없는 event tombstone=무효(유효성 조건)");
}

console.log("[10] v2 수확 자격 — close 라운드 게이트·dispositionValid·병합 사람 우선(배선 핀 포함)");
{
  const os10 = require("os");
  process.env.CODEX_BRIDGE_HOME = process.env.CODEX_BRIDGE_HOME; // 기존 홈 유지(위 [3]에서 설정됨)
  const repo10 = fs.mkdtempSync(path.join(os10.tmpdir(), "prov10_"));
  fs.mkdirSync(path.join(repo10, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo10, "docs", "dd.md"), "## 근거\n원문\n", "utf8");
  const ws10 = fs.mkdtempSync(path.join(os10.tmpdir(), "prov10ws_"));
  const camp = "cl:test:1";
  const led = CL.findingsLedgerFileFor(ws10);
  fs.mkdirSync(path.dirname(led), { recursive: true });
  const rk10 = MPV.repoKeyFor(repo10);
  const ref10 = (() => { const rv = MPV.resolveAnchor(repo10, "docs/dd.md", "heading:근거"); return { file: "docs/dd.md", anchor: "heading:근거", contentHash: MPV.excerptShaOf(rv.text), repoKey: rk10 }; })();
  const W = (rows) => fs.writeFileSync(led, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const base10 = [
    { type: "finding", findingId: "f-x", campaignId: camp, round: 1, title: "제목X", status: "open", ts: "t1" },
    { type: "disposition", campaignId: camp, findingId: "f-x", choice: "fix-fact", note: "n", asOfRound: 1, sourceRefs: [ref10], repoKey: rk10, repoPath: repo10, ts: "t2" },
    { type: "close", campaignId: camp, findingId: "f-x", closeReason: "resolved", round: 2, ts: "t3" },
  ];
  W(base10);
  const h1 = MPV.harvestFromResolvedFinding(ws10, repo10, camp, "f-x");
  ok(h1.ok === true, "정상 계보(처분 유효+close.round 2 ≥ 활동 1)=수확 성공");
  // R2 blocker⑤(ab-1): close 시점 '현재 대상'이 다른 저장소여도 사건에 저장된 repoPath로 수확
  const other10 = fs.mkdtempSync(path.join(os10.tmpdir(), "prov10other_"));
  const hSwitch = MPV.harvestFromResolvedFinding(ws10, other10, camp, "f-x");
  ok(hSwitch.ok === true && hSwitch.results[0].skipped === "dup", "★대상 전환 후 close돼도 사건 저장소(repoPath)로 수확(현재 대상 무관 — 멱등 중복 확인)");
  ok(MPV.readAutoLedger(MPV.repoKeyFor(other10)).length === 0, "전환된 현재 대상 파티션에는 미기록(오귀속 0)");
  // R4 반례: 재등장(round 3) 후 새 fix-fact(asOfRound 3)인데 close는 옛 round 2 → 거부
  W([...base10,
    { type: "occurrence", campaignId: camp, findingId: "f-x", round: 3, ts: "t4" },
    { type: "disposition", campaignId: camp, findingId: "f-x", choice: "fix-fact", note: "n2", asOfRound: 3, sourceRefs: [ref10], ts: "t5" },
  ]);
  ok(MPV.harvestFromResolvedFinding(ws10, repo10, camp, "f-x").reason === "close-round", "★재등장 후 옛 close 재사용=거부(R4 실행 반례의 정방향)");
  // 새 종결(round 4) 도착=허용
  W([...base10,
    { type: "occurrence", campaignId: camp, findingId: "f-x", round: 3, ts: "t4" },
    { type: "disposition", campaignId: camp, findingId: "f-x", choice: "fix-fact", note: "n2", asOfRound: 3, sourceRefs: [ref10], ts: "t5" },
    { type: "close", campaignId: camp, findingId: "f-x", closeReason: "resolved", round: 4, ts: "t6" },
  ]);
  ok(MPV.harvestFromResolvedFinding(ws10, repo10, camp, "f-x").ok === true, "새 close(round 4)=수확 허용");
  // sourceRefs 없음=후보 대기
  W([
    { type: "finding", findingId: "f-y", campaignId: camp, round: 1, title: "Y", status: "open", ts: "t1" },
    { type: "disposition", campaignId: camp, findingId: "f-y", choice: "fix-fact", note: "n", asOfRound: 1, ts: "t2" },
    { type: "close", campaignId: camp, findingId: "f-y", closeReason: "resolved", round: 2, ts: "t3" },
  ]);
  ok(MPV.harvestFromResolvedFinding(ws10, repo10, camp, "f-y").reason === "no-source", "sourceRefs 없는 사건=후보 대기(휴리스틱 추측 금지)");
  // 병합 사람 우선: 사람 항목의 '가림'이 자동 항목 억제
  const sk10 = MPV.subjectKeyOf("docs/dd.md", "heading:근거");
  fs.writeFileSync(path.join(repo10, "docs", "DECISIONS.md"), "# 색인\n\n## D-2026-01-01-human — 사람 정정\n- 결정: 사람이 쓴 정정본.\n- 정본: docs/dd.md\n- 찾는말: 근거\n- 가림: " + sk10 + "\n", "utf8");
  const m10 = MPV.mergedEntriesFor(repo10);
  ok(m10.human.length === 1 && m10.auto.length === 0, "사람 '가림' 항목=자동층 억제(reducer 5단계·사람 우선 불변)");
  // keywords 안전(ab-7): 자동 항목 keywords에 질의류 원문이 아닌 발췌·제목 토큰만
  const recs10 = MPV.readAutoLedger(rk10).filter((r) => r.kind === "entry");
  ok(recs10.length >= 1 && recs10.every((r) => Array.isArray(r.keywords) && r.keywords.every((k) => typeof k === "string")), "자동 keywords=발췌·구조 필드 토큰(질의 원문 채널 부재 — 코드 경로상 질의 미전달)");
  // 배선 핀: fix-fact --source 생산자·close 수확 호출·승인 사건 선기록
  const cb = fs.readFileSync(path.join(ROOT, "bridge", "codex-bridge.js"), "utf8");
  ok(cb.includes('=== "--source"') && /resolveAnchor\(repo9, file, anchor\)/.test(cb), "fix-fact --source 생산자 결속(검증 실패=거부)");
  ok(/harvestFromResolvedFinding\(ws, repo9, camp, r9\.findingId\)/.test(cb), "해소 마감 직후 수확기 호출(advisory)");
  // R2 확인 blocker: 승인 사건·도장 '같은 잠금 구간' 원자 결속 — 도장 함수가 잠금 보유 중 실행됨을
  // 실측(잠금 파일 실존)·도장 실패/예외에도 사건 잔존·잠금 정상 해제
  const evF10 = MPV.approvalEventsFileFor(MPV.repoKeyFor(repo10));
  const nEv = () => { try { return fs.readFileSync(evF10, "utf8").split(/\r?\n/).filter(Boolean).length; } catch { return 0; } };
  const beforeEv = nEv();
  let lockSeen10 = false;
  const b1 = MPV.recordApprovalWithStamp(repo10, { envelopeHash: "h1" }, () => { lockSeen10 = fs.existsSync(evF10 + ".lock"); return true; });
  ok(b1.ok && b1.recorded && b1.stamped && lockSeen10, "★도장 함수가 승인 사건 잠금 보유 '안'에서 실행(같은 잠금 구간 — R2 확인 반례의 정방향)");
  const b2 = MPV.recordApprovalWithStamp(repo10, { envelopeHash: "h2" }, () => false);
  ok(b2.recorded === true && b2.stamped === false, "도장 실패=사건 잔존(미완 표지)·stamped=false 보고");
  const b3 = MPV.recordApprovalWithStamp(repo10, { envelopeHash: "h3" }, () => { throw new Error("x"); });
  ok(b3.recorded === true && b3.stamped === false, "도장 예외=사건 잔존·잠금 정상 해제(후속 기록 가능)");
  ok(nEv() === beforeEv + 3, "세 사건 모두 append(선기록은 도장 성패와 무관하게 남음)");
  const ext10 = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/recordApprovalWithStamp\(tgtNow, \{ envelopeHash: shaAt, sourceRefs: \[\] \}/.test(ext10), "직접 승인 — 사건·도장 같은 잠금 결속 호출");
  ok(/if \(!bind9 \|\| !bind9\.recorded\) \{[^}]*return;/.test(ext10) && /승인 사건 기록에 실패해 승인을 중단/.test(ext10), "직접 승인 — 사건 기록 실패=도장 진행 금지");
  ok(/recordApprovalWithStamp\(tgtNow2, \{ envelopeHash: hashAt, sourceRefs: \[\] \}/.test(ext10) && /if \(!bindA \|\| !bindA\.recorded\) \{[^}]*return;/.test(ext10), "개정 승인 경로도 같은 잠금 결속+실패=중단(경로 2종 동형)");
  // R2 blocker⑥: 값 없는 --source=즉시 거부(침묵 통과 금지) — 실제 CLI 실행 반례
  const { spawnSync: sp10 } = require("child_process");
  const rNoVal = sp10(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "finding-judge", "f-zzzz", "fix-fact", "--note", "열두자넘는근거문장입니다", "--source"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME } });
  ok(rNoVal.status === 2 && /--source에 값이 없습니다|--source needs a value/.test(rNoVal.stdout + rNoVal.stderr), "★값 없는 --source=형식 오류 즉시 거부(처분 미기록 — R2 반례의 정방향)");
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
