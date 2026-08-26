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
  ok(/recordApprovalWithStamp\(tgtNow2, \{ envelopeHash: hashAt, target: targetA, sourceRefs: \[\], \.\.\.\(cRefsA\.length \? \{ candidateRefs: cRefsA \} : \{\}\) \}/.test(ext10) && /if \(!bindA \|\| !bindA\.recorded\) \{[^}]*return;/.test(ext10), "개정 승인 경로도 같은 잠금 결속+실패=중단(경로 2종 동형 — 재편 A §2-2: target+candidateRefs 결속)");
  // [재편 A §2-2] 후보 계보=별도 candidateRefs(지문만·sourceRefs 무접촉)+why 보유 kind는 whyFp 필수 —
  // 결속 실패=도장 중단(fail-closed·1차 검증 blocker② 반례). 빼기 전용(후보 0)만 생략 정당.
  ok(/const sha1A = \(s: string\) => crypto\.createHash\("sha1"\)/.test(ext10) && /refsFailA = "title-missing"/.test(ext10) && /refsFailA = "why-missing"/.test(ext10) && /refsFailA = "ledger-read"/.test(ext10), "candidateRefs — title 필수·why 보유 kind는 why 필수·판독 실패 분류(지문만 저장)");
  ok(/if \(refsFailA\) \{ vscode\.window\.showWarningMessage[\s\S]{0,300}this\.post\(\); return; \}/.test(ext10), "★결속 실패=도장 중단(fail-closed — 빈 참조 도장 금지)");
  // [확인검증 2차 blocker f-daf2d02f] 메타=초안 후보 세대 결속+같은 세대 최신 우선 — 교차 세대 과거 why 오결속 차단
  ok(/const gen2A = String\(\(pr2 as any\)\.candidateGeneration/.test(ext10) && /String\(r\.envelopeHash \|\| ""\) !== gen2A\) continue;/.test(ext10) && /refsFailA = "gen-missing"/.test(ext10) && /if \(r\.title\) m0\.title = r\.title;/.test(ext10), "★메타 세대 결속(candidateGeneration 필터·최신 우선·세대 미상=중단)");
  // R2 blocker⑥: 값 없는 --source=즉시 거부(침묵 통과 금지) — 실제 CLI 실행 반례
  const { spawnSync: sp10 } = require("child_process");
  const rNoVal = sp10(process.execPath, [path.join(ROOT, "bridge", "codex-bridge.js"), "finding-judge", "f-zzzz", "fix-fact", "--note", "열두자넘는근거문장입니다", "--source"], { encoding: "utf8", env: { ...process.env, CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME } });
  ok(rNoVal.status === 2 && /--source에 값이 없습니다|--source needs a value/.test(rNoVal.stdout + rNoVal.stderr), "★값 없는 --source=형식 오류 즉시 거부(처분 미기록 — R2 반례의 정방향)");
}

console.log("[11] v2 2차 — 자동층 compaction(soft cap·트림 아카이브 관용구·의미 전량 보존)");
{
  const rk11 = "compact-test-key";
  const f11 = MPV.autoLedgerFileFor(rk11);
  const af11 = f11.replace(/\.jsonl$/, "") + ".archive.jsonl";
  // 의미 레코드 5(entry 3·tombstone 1·retract 1)+정확 중복 2+손상 1을 만들고 낮은 상한으로 트림 유도
  const e11 = (n) => JSON.stringify({ kind: "entry", id: "A-e" + n, subjectKey: "s".repeat(0) + String(n).padStart(40, "0"), gen: 1, ts: "t" + n, title: "제목" + n, source: { file: "docs/x.md", anchor: "lines:1-1", excerptSha: "0".repeat(40) }, excerpt: "본문", keywords: [], origin: { eventKind: "x", eventRef: "ev" + n, repoKey: rk11, registeredAt: "t" + n } });
  const tb11 = JSON.stringify({ kind: "tombstone", tombstoneId: "11111111-2222-3333-4444-555555555555", subjectKey: "0".repeat(40), scope: "subject", ts: "t9" });
  const rt11 = JSON.stringify({ kind: "tombstone-retract", subjectKey: "0".repeat(40), targetTombstoneId: "11111111-2222-3333-4444-555555555555", ts: "t10" });
  fs.mkdirSync(path.dirname(f11), { recursive: true });
  fs.writeFileSync(f11, [e11(1), e11(2), e11(1), "손상{{{", e11(3), e11(2), tb11, rt11].join("\n") + "\n", "utf8");
  const okA = MPV.appendAutoRecords(rk11, [JSON.parse(e11(4))], { trimAt: 5, step: 3 });
  ok(okA === true, "상한 초과 append=적재 성공+compaction 발동");
  const after11 = fs.readFileSync(f11, "utf8").split(/\r?\n/).filter(Boolean);
  const parsed11 = after11.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  ok(parsed11[0] && parsed11[0].kind === "trim-rewrite" && String(parsed11[0].nonce || "").length >= 16, "재작성 증표(nonce)가 본문 맨 앞");
  const kinds11 = parsed11.filter(Boolean).map((r) => r.kind);
  ok(kinds11.filter((k) => k === "entry").length === 4 && kinds11.includes("tombstone") && kinds11.includes("tombstone-retract"), "★의미 레코드 전량 보존(entry 4·tombstone·retract — 철회된 tombstone도 절대 미제거)");
  ok(!after11.some((l) => l.indexOf("손상{{{") >= 0) && after11.filter((l) => l === e11(1)).length === 1, "손상 줄·정확 중복만 본문에서 절단");
  const arch11 = fs.readFileSync(af11, "utf8");
  const aLines11 = arch11.split(/\r?\n/).filter((l) => l.length);
  const payloads11 = aLines11.filter((l) => l.startsWith('"')).map((l) => JSON.parse(l)); // 원시줄=JSON 문자열 프레이밍(복원=parse 1회)
  ok(arch11.indexOf('"type":"trim-archive"') >= 0 && arch11.indexOf('"type":"trim-commit"') >= 0 && payloads11.includes("손상{{{") && payloads11.includes(e11(1)), "★잘린 원시줄=아카이브 무손실 보존(문자열 프레이밍·복원 가능)+2단 커밋(trim-archive→trim-commit)");
  // reducer 의미 동일: compaction 전후 활성 판정 불변(tombstone 철회로 subject 전부 생존)
  const red11 = MPV.reduceAutoCandidates(MPV.readAutoLedger(rk11));
  ok(red11.length === 4, "compaction 후 reducer 결과=활성 subject 4(의미 불변)");
  // 히스테리시스: STEP 미만 추가 append는 재트림하지 않음(증표 줄 수 유지)
  const linesBefore = after11.length;
  MPV.appendAutoRecords(rk11, [JSON.parse(e11(5))], { trimAt: 5, step: 3 });
  const after11b = fs.readFileSync(f11, "utf8").split(/\r?\n/).filter(Boolean);
  ok(after11b.length === linesBefore + 1 && after11b.filter((l) => l.indexOf('"kind":"trim-rewrite"') >= 0).length === 1, "히스테리시스 — STEP 미만 새 줄에선 재작성 없음(증표 1개 유지)");
  // 2단 커밋 회수: 미커밋 배치(마커만·본문에 그 nonce 없음)=절단 후 재적재 — 중복 보관 없음
  const preArch = fs.readFileSync(af11, "utf8");
  fs.appendFileSync(af11, JSON.stringify({ ts: "tX", type: "trim-archive", n: 1, batchSha: "f".repeat(40), nonce: "deadbeefdeadbeefdeadbeefdeadbeef", preLines: 9, postLines: 9, from: "auto-ledger-trim(원시 보존)" }) + "\n" + JSON.stringify("유령배치줄") + "\n", "utf8");
  fs.writeFileSync(f11, [e11(1), e11(2), e11(3), e11(4), e11(5), tb11, rt11, e11(6), e11(7), e11(8)].join("\n") + "\n", "utf8"); // 증표 없는 본문(재작성 미실행 상태 재현)
  MPV.appendAutoRecords(rk11, [JSON.parse(e11(9))], { trimAt: 5, step: 3 });
  const arch11c = fs.readFileSync(af11, "utf8");
  ok(arch11c.indexOf("유령배치줄") < 0 && arch11c.indexOf(preArch.trim().split("\n")[0]) === 0, "★미커밋 배치=절단 후 재적재(nonce 부재⇔미교체 판별 — 이전 커밋 배치는 무접촉)");
  // R1 blocker①(ab-5) 정방향: 보존 원시줄이 '마커 모양'(type:trim-archive·batchSha 포함)이어도 문자열
  // 프레이밍이라 회수기가 마커로 오인하지 않는다 — 두 번째 compaction 진입 후에도 아카이브에 생존
  const rk11b = "compact-test-key-b";
  const f11b = MPV.autoLedgerFileFor(rk11b);
  const af11b = f11b.replace(/\.jsonl$/, "") + ".archive.jsonl";
  const markerLike = JSON.stringify({ kind: "legacy-x", type: "trim-archive", batchSha: "a".repeat(40), nonce: "cafebabecafebabecafebabecafebabe", payload: "must-survive" }); // 미지 kind=절단 대상·내용은 마커 모양(오인 유도)
  fs.mkdirSync(path.dirname(f11b), { recursive: true });
  fs.writeFileSync(f11b, [e11(1), e11(2), markerLike, e11(3), e11(1), e11(2)].join("\n") + "\n", "utf8");
  MPV.appendAutoRecords(rk11b, [JSON.parse(e11(4))], { trimAt: 4, step: 2 }); // 1차: markerLike가 아카이브로
  const aMid = fs.readFileSync(af11b, "utf8");
  ok(aMid.split(/\r?\n/).filter((l) => l.startsWith('"')).map((l) => JSON.parse(l)).includes(markerLike), "마커 모양 원시줄=1차 compaction에서 문자열로 보존(전제)");
  MPV.appendAutoRecords(rk11b, [JSON.parse(e11(5)), JSON.parse(e11(6))], { trimAt: 4, step: 2 }); // 2차 진입(회수기 통과)
  const aEnd = fs.readFileSync(af11b, "utf8");
  ok(aEnd.split(/\r?\n/).filter((l) => l.startsWith('"')).map((l) => JSON.parse(l)).includes(markerLike) && aEnd.indexOf("must-survive") >= 0, "★마커 모양 보존 원시줄이 2차 compaction 회수를 통과해 생존(오인 절단 소멸 — R1 반례의 정방향)");
  // R1 blocker② 정방향: 활성 의미 상태가 상한 초과(soft cap 예외)여도 STEP 미만 append는 재작성하지 않음
  const nonceOf = (file) => { const l0 = fs.readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.indexOf('"kind":"trim-rewrite"') >= 0); return l0 ? JSON.parse(l0).nonce : null; };
  const rk11c = "compact-test-key-c";
  const f11c = MPV.autoLedgerFileFor(rk11c);
  fs.mkdirSync(path.dirname(f11c), { recursive: true });
  fs.writeFileSync(f11c, [e11(1), e11(2), e11(3), e11(4), e11(5), e11(6)].join("\n") + "\n", "utf8"); // 전부 의미(중복·손상 0)=상한 초과 상태
  MPV.appendAutoRecords(rk11c, [JSON.parse(e11(7))], { trimAt: 4, step: 3 }); // 첫 재작성(절단분 0·증표만)
  const n1 = nonceOf(f11c);
  ok(typeof n1 === "string" && n1.length >= 16, "soft cap 예외 상태 첫 재작성=증표 기준점(전제)");
  MPV.appendAutoRecords(rk11c, [JSON.parse(e11(8))], { trimAt: 4, step: 3 });
  MPV.appendAutoRecords(rk11c, [JSON.parse(e11(9))], { trimAt: 4, step: 3 });
  ok(nonceOf(f11c) === n1, "★상한 초과 상태에서 STEP 미만 append=재작성 없음(nonce 불변 — 매 append 전량 재작성 반례의 정방향)");
  MPV.appendAutoRecords(rk11c, [JSON.parse(e11(10))], { trimAt: 4, step: 3 }); // postLines 기준 +3 도달
  ok(nonceOf(f11c) !== n1, "STEP 도달 시에만 재작성(증표 postLines 기준 추가분 계수)");
}

console.log("[12] v2 2차 — sweep 수확 배선·대시보드 표면 핀(소스 계약)");
{
  const mi12 = fs.readFileSync(path.join(ROOT, "bridge", "map-intent.js"), "utf8");
  ok(/harvestFromIntentChoices\(repo\)/.test(mi12) && mi12.indexOf("provenanceHarvested") >= 0, "sweepIntentAuto 말미 intent 수확 자동 배선(advisory)");
  const ext12 = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
  ok(/provReject/.test(ext12) && /provRetract/.test(ext12) && /appendTombstone\(repoH/.test(ext12) && /retractTombstone\(repoR/.test(ext12), "대시보드 거부(scope)·철회 핸들러 배선");
  ok(/repoKeyFor\(repoH\)\) !== m\.repoKey/.test(ext12) && /repoKeyFor\(repoR\)\) !== m\.repoKey/.test(ext12), "핸들러 2종 모두 repoKey 스냅샷 재대조(대상 전환 오귀속 차단 — B-3 전례)");
  ok(/provCard/.test(ext12) && /provAutoRows/.test(ext12) && /provTombRows/.test(ext12) && /provenance: any \| null/.test(ext12), "MAP 패널 카드·상태 인터페이스 선언 동기");
  // 병합 행에 거부 결속 필드(eventRef·gen) 노출 — 기능 확인(repo8 픽스처 재사용 없이 독립 실행)
  const repo12 = fs.mkdtempSync(path.join(os.tmpdir(), "prov12_"));
  fs.mkdirSync(path.join(repo12, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo12, "docs", "z.md"), "# 결정\n내용 한 줄\n", "utf8");
  const rv12 = MPV.resolveAnchor(repo12, "docs/z.md", "lines:1-2");
  const r12 = MPV.registerAutoEntries(repo12, [{ file: "docs/z.md", anchor: "lines:1-2", contentHash: MPV.excerptShaOf(rv12.text), repoKey: MPV.repoKeyFor(repo12) }], { eventKind: "finding-resolved", eventRef: "f-z12", title: "제목" });
  ok(r12.ok === true, "독립 등재 성공(전제)");
  const m12 = MPV.mergedEntriesFor(repo12);
  ok(m12.auto.length === 1 && m12.auto[0].eventRef === "f-z12" && m12.auto[0].gen === 1, "병합 행에 eventRef·gen 노출(거부 버튼 결속 재료)");
}

console.log("[13] 재편 A §2-2 — 승인 수확 자격 target-aware(서고 사건=archiveHash 대조·legacy 무회귀)");
{
  const wsH = fs.mkdtempSync(path.join(os.tmpdir(), "mp13-ws-"));
  const repoH = fs.mkdtempSync(path.join(os.tmpdir(), "mp13-rp-"));
  const HC13 = "c0".repeat(20), HA13 = "ab".repeat(20);
  CL.updateContractPatch(wsH, undefined, { envelopeHash: HC13, archiveHash: HA13 });
  const fakeRef = { repoKey: "rk", contentHash: "ch", file: "f.js", anchor: "a" };
  ok(MPV.appendApprovalEvent(repoH, { envelopeHash: HC13, sourceRefs: [fakeRef] }), "core 사건(legacy 무 target) 기록");
  ok(MPV.appendApprovalEvent(repoH, { envelopeHash: HA13, target: "archive", sourceRefs: [fakeRef] }), "archive 사건(target 명시) 기록");
  ok(MPV.appendApprovalEvent(repoH, { envelopeHash: HA13, sourceRefs: [fakeRef] }), "archive 지문인데 target 없는 사건(legacy 형식) 기록");
  const rH = MPV.harvestFromApprovals(wsH, repoH);
  ok(rH.ok === true && Array.isArray(rH.results) && rH.results.length === 2, "자격=core(legacy 대조 무회귀)+archive(target 대조 신설) 2건 — 무 target archive 지문은 미자격(위조 승인 차단): " + (rH.results || []).length);
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
