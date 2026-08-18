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

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
