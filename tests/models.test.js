"use strict";
/*
 * 두뇌 설정 모델 드롭다운 옵션 생성 로직 테스트 (node tests/models.test.js).
 * 핵심: 모델은 하드코딩이 아니라 계정 캐시(models_cache.json→availModels)에서 와야 한다(코덱스 업데이트/등급 자동 반영).
 * 그리고 datalist→select 전환의 옵션 집합이 모델을 빠뜨리지 않는지(회귀 방지). 실제 datalist↔select '표시 필터' 차이는
 * 브라우저 동작이라 여기선 못 테스트 — 그건 reload 후 육안 + Codex 검토로. 여긴 옵션 '집합'이 완전한지만 본다.
 *
 * 아래 buildModelOptions는 src/extension.ts 웹뷰의 인라인 로직을 그대로 옮긴 것(웹뷰 문자열이라 직접 import 불가).
 */
function buildModelOptions(avail, knownModels, savedM) {
  const out = [{ v: "", t: "(코덱스 기본값)" }];
  const opts = avail.length ? avail.map((m) => ({ v: m.slug, t: m.name })) : (knownModels || []).map((s) => ({ v: s, t: s }));
  opts.forEach(({ v, t }) => out.push({ v, t: (t && t !== v) ? (t + " (" + v + ")") : v }));
  if (savedM && !opts.some((o) => o.v === savedM)) out.push({ v: savedM, t: savedM + " (저장된 값 · 현재 목록에 없음)" });
  return out;
}

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const vals = (o) => o.map((x) => x.v);

// 실제 계정 캐시(현재) 모양
const avail3 = [
  { slug: "gpt-5.5", name: "GPT-5.5" },
  { slug: "gpt-5.4", name: "GPT-5.4" },
  { slug: "gpt-5.4-mini", name: "GPT-5.4-mini" },
];

console.log("[1] 계정 캐시의 모든 모델 + 기본값이 옵션에 나온다(gpt5.5만 X — 버그 회귀 방지)");
let o = buildModelOptions(avail3, [], "gpt-5.5"); // 저장값 gpt-5.5(버그 상황)
ok(vals(o).includes("gpt-5.5") && vals(o).includes("gpt-5.4") && vals(o).includes("gpt-5.4-mini"), "3개 모델 모두 존재");
ok(vals(o)[0] === "", "첫 옵션 = (코덱스 기본값)");
ok(o.length === 4, "기본값 + 3모델 = 4옵션(저장값 gpt-5.5는 캐시에 있어 중복 안 생김)");

console.log("[2] 하드코딩 아님 — 미래 모델도 캐시에 있으면 자동 반영");
o = buildModelOptions([{ slug: "gpt-6", name: "GPT-6" }, { slug: "gpt-5.5", name: "GPT-5.5" }], [], "");
ok(vals(o).includes("gpt-6"), "캐시에 새 모델(gpt-6) 들어오면 자동으로 옵션에 뜸(업데이트 유연성)");

console.log("[3] 저장값이 현재 캐시에 없으면 보존 옵션 추가(조용히 안 바뀜)");
o = buildModelOptions(avail3, [], "gpt-5.3-legacy");
ok(vals(o).includes("gpt-5.3-legacy"), "목록 밖 저장값도 옵션으로 보존");
ok(o.length === 5, "기본값 + 3모델 + 보존 = 5");

console.log("[4] 캐시 실패 시 세션 사용이력(knownModels)로 폴백");
o = buildModelOptions([], ["gpt-5.4"], "");
ok(vals(o).includes("gpt-5.4") && o.length === 2, "캐시 비면 knownModels로(기본값+1)");

console.log("[5] 캐시·이력 모두 없으면 기본값만(콜드 스타트)");
o = buildModelOptions([], [], "");
ok(o.length === 1 && vals(o)[0] === "", "둘 다 없으면 (코덱스 기본값)만");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
