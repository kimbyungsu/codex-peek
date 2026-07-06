"use strict";
/*
 * src/map-ledger.ts(→ out/map-ledger.js) 순수부 테스트 — 확장 카드와 CLI(scope-reconcile)가 공유하는
 * 단일 형식(서명·승인 줄·뼈대·제안 계산)의 왕복 보장. ※ out/*.js는 npm test의 tsc 단계 산출물.
 */
const path = require("path");
const assert = require("assert");
const { normSig, approvedLine, parseApprovedFromMap, appendApproved, computePending, mapSkeleton, MAP_SECTION_HEADER } = require(path.join(__dirname, "..", "out", "map-ledger.js"));

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 서명 — 공백 요동만 무시(내용 같으면 같은 제안)");
ok(normSig("A  ↔  B — 이유") === normSig("a ↔ b — 이유"), "공백·대소문자 정규화");
ok(normSig("A ↔ B") !== normSig("A ↔ C"), "내용 다르면 다른 서명");

console.log("[2] 승인 줄 ↔ 파싱 왕복(무엇을 언제·어디서 승인했는지 되읽기)");
const line = approvedLine("proofs/ 쓰기 ↔ verify-guard 읽기", "self 지도 2026-07-07T00:00:00.000Z", "2026-07-07T12:34:56.000Z");
const rt = parseApprovedFromMap(line);
ok(rt.approved.length === 1 && rt.approved[0].text === "proofs/ 쓰기 ↔ verify-guard 읽기", "text 왕복");
ok(rt.approved[0].date === "2026-07-07" && rt.approved[0].from.startsWith("self 지도"), "날짜·출처 왕복");

console.log("[3] appendApproved — 빈 문서=뼈대 생성, 헤더 없는 기존 문서=헤더 보충, 있는 문서=끝에 추가");
const fresh = appendApproved("", [{ text: "a ↔ b", from: "self 지도 T" }], "2026-07-07T00:00:00.000Z");
ok(fresh.startsWith("# MAP") && fresh.includes(MAP_SECTION_HEADER) && fresh.includes("- a ↔ b  <!--"), "빈 문서 → 뼈대+헤더+승인 줄");
const manual = appendApproved("# 내 지도\n- 손으로 쓴 항목\n", [{ text: "c ↔ d", from: "self 지도 T" }], "2026-07-07T00:00:00.000Z");
ok(manual.includes("# 내 지도") && manual.includes(MAP_SECTION_HEADER) && manual.includes("- c ↔ d  <!--"), "기존 문서 보존 + 헤더 보충 + 추가");
const p1 = parseApprovedFromMap(manual);
ok(p1.totalItems === 2 && p1.approved.length === 1, "전체 항목 수(손 항목 포함) vs 승인 줄 수 분리 집계(정직 표기)");

console.log("[4] computePending — 최신 지도 출처 승리·처리분/장부 중복 제외·결정적 정렬·비정상 입력 무해");
const pending = computePending(
  [
    { patches: ["B ↔ C", "A ↔ B"], from: "새 지도" },
    { patches: ["A ↔ B", "D ↔ E", 123, "  "], from: "옛 지도" },
    { patches: "not-array", from: "깨진 메타" },
  ],
  [normSig("D ↔ E")],
  "# MAP\n- B ↔ C  <!-- 승인 2026-07-06 · 출처: x -->\n"
);
ok(pending.length === 1 && pending[0].text === "A ↔ B", "기각(D↔E)·장부 중복(B↔C) 제외 → A↔B만");
ok(pending[0].from === "새 지도", "같은 제안이 여러 지도에 있으면 최신(먼저 온) 지도의 출처");
const sorted = computePending([{ patches: ["나 ↔ 다", "가 ↔ 나"], from: "m" }], [], "");
ok(sorted[0].text === "가 ↔ 나", "텍스트 기준 결정적 정렬(CLI 번호·대시보드 순서 일치)");

console.log("[5] 뼈대 — 승격 원칙(사람 승인·자동 반영 없음) + 두 경로(CLI·대시보드) 모두 명시");
ok(mapSkeleton().includes("자동 반영 없음") && mapSkeleton().includes("사람 승인"), "뼈대에 승격 원칙 명시");
ok(mapSkeleton().includes("scope-reconcile approve") && mapSkeleton().includes("대시보드"), "승격 경로 두 가지(CLI·대시보드 버튼) 모두 안내 — 한쪽만 적으면 오도");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
