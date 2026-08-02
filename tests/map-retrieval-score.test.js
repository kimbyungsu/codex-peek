// 요청 기준 지도 검색 — 정수 채점기(구현 1조각) · 정본 docs/MAP-RETRIEVAL-SPEC.md §3
// 계약: 고정 벡터 20쌍 정확 일치 · 유효 영역 전수 단조성 · 소규모 말뭉치 미감점 · 바닥 1 ·
// 영역 밖=null · 동점 비교=슬래시 통일+NFC+코드 포인트(로캘·코드 유닛 금지).
const path = require("path");
const { idf1000, comparePaths, normPathForTie, IDF_CORPUS_MIN, IDF_N_MAX } = require(path.join(__dirname, "..", "bridge", "map-retrieval.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}

console.log("[1] 고정 벡터 20쌍 — 명세 값과 정확 일치(문서가 정본)");
{
  const VECTORS = [
    [20, 20, 1], [20, 10, 693], [20, 1, 2945], [100, 100, 1], [100, 99, 6],
    [100, 50, 693], [100, 25, 1386], [100, 10, 2252], [100, 1, 4547], [500, 400, 173],
    [500, 250, 693], [500, 100, 1559], [500, 7, 4238], [1000, 999, 1], [1000, 500, 693],
    [1000, 333, 1040], [1000, 100, 2252], [1500, 1500, 1], [1500, 750, 693], [1500, 1, 7252],
  ];
  let bad = 0;
  for (const [N, df, want] of VECTORS) if (idf1000(N, df) !== want) { bad++; console.log(`    불일치 ${N}/${df}: ${idf1000(N, df)} != ${want}`); }
  ok(bad === 0, "20쌍 전부 일치");
}

console.log("[2] 단조성 계약 — 유효 영역 전수(1<=df<=N<=1500)에서 df 감소 시 비감소");
{
  let bad = 0, checked = 0;
  for (let N = 1; N <= IDF_N_MAX; N++) {
    let prev = -1;
    for (let df = N; df >= 1; df--) {
      const v = idf1000(N, df);
      if (v < prev) bad++;
      prev = v; checked++;
    }
  }
  ok(bad === 0 && checked === 1125750, `전수 ${checked}건 · 단조성 위반 ${bad}건(0이어야 함)`);
}

console.log("[3] 경계 규칙 — 소규모 미감점·바닥·영역 밖 null");
{
  ok(idf1000(19, 1) === 1000 && idf1000(19, 19) === 1000 && idf1000(1, 1) === 1000, "말뭉치 20 미만=1000(감점 미적용·df 무관)");
  ok(idf1000(IDF_CORPUS_MIN, IDF_CORPUS_MIN) === 1, "경계 N=20·df=N → 바닥 1");
  ok(idf1000(100, 150) === 1, "df > N → 바닥 1(어디에나 있는 씨앗)");
  let zero = 0;
  for (let N = IDF_CORPUS_MIN; N <= 200; N++) for (let df = 1; df <= N; df++) if (idf1000(N, df) < 1) zero++;
  ok(zero === 0, "유효 영역에서 1 미만 값 없음(사라지지 않는다)");
  ok(idf1000(0, 1) === null && idf1000(100, 0) === null && idf1000(-5, 1) === null, "0·음수 = null");
  ok(idf1000(100.5, 2) === null && idf1000(100, 2.5) === null && idf1000(NaN, 1) === null, "비정수·NaN = null");
  ok(idf1000(IDF_N_MAX, 1) !== null && idf1000(IDF_N_MAX + 1, 1) === null, "N=1500 유효·1501=null(정밀도 보증 영역 밖 차단)");
}

console.log("[4] 동점 비교 — 슬래시 통일·NFC·코드 포인트·대소문자 보존");
{
  ok(comparePaths("src\\a\\b.ts", "src/a/b.ts") === 0, "역슬래시=슬래시 동일 취급");
  const nfd = "src/é.ts"; // e + 결합 액센트(NFD)
  const nfc = "src/é.ts";  // é(NFC)
  ok(comparePaths(nfd, nfc) === 0, "NFC 정규화 — 같은 문자 다른 인코딩=동일");
  ok(comparePaths("A.ts", "a.ts") === -1, "대소문자 보존 코드 포인트 순서(A(65) < a(97))");
  // 코드 유닛 함정: U+1F600(😀)은 서러게이트 쌍(0xD83D..)이라 코드 유닛 비교면 U+FB03(ﬃ)보다 앞서지만
  // 코드 포인트 비교면 0x1F600 > 0xFB03. 명세는 코드 포인트를 요구한다.
  ok(comparePaths("\u{1F600}", "ﬃ") === 1, "보충 평면 — 코드 포인트 순서(코드 유닛 비교였다면 -1로 어긋남)");
  ok("\u{1F600}" < "ﬃ" === true, "(대조) JS 문자열 < 는 코드 유닛이라 반대 — 함정 실재 증명");
  ok(comparePaths("src/a", "src/a/b") === -1 && comparePaths("src/a", "src/a") === 0, "접두 관계=짧은 쪽 우선·동일=0");
  ok(comparePaths(null, "") === 0 && comparePaths(undefined, "") === 0, "null·undefined=빈 문자열 취급(크래시 없음)");
  ok(normPathForTie("a\\\\b\\c") === "a/b/c", "연속 역슬래시 정규화");
}

console.log("[5] HL 복사값 잠금 — 명세 필수 반례(SPEC :324): 두 곳이 갈리면 여기서 깨져야 한다");
{
  // HL은 scope-package.js에서 export되지 않는다(명세 실측). IDF_N_MAX는 그 maxScanFiles의 '복사'이므로,
  // 원본이 바뀌었는데 이 모듈이 안 따라가면 정밀도 보증 영역과 검색 영역이 갈린다 — 원문에서 값을
  // 추출해 잠근다. 추출 실패(구조 변경)도 실패로 드러나게 한다(조용한 통과 금지).
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8");
  // 보관 1980e204 반영: const HL 선언 줄 안에서만 추출 — 주석·다른 객체의 동명 키 오매칭 차단
  const hlLine = [...src.matchAll(/^const HL = \{.*\};/gm)];
  ok(hlLine.length === 1, "const HL 선언 정확히 1곳");
  const m = hlLine.length === 1 ? [...hlLine[0][0].matchAll(/maxScanFiles:\s*(\d+)/g)] : [];
  ok(m.length === 1, "HL 선언 안에서 maxScanFiles 정확히 1곳 추출");
  ok(m.length === 1 && Number(m[0][1]) === IDF_N_MAX, `HL.maxScanFiles(${m.length ? m[0][1] : "?"}) === IDF_N_MAX(${IDF_N_MAX}) — 복사값 일치 잠금`);
}

console.log("[6] 결정론 — 같은 입력 반복 호출 동일값");
{
  let bad = 0;
  for (let i = 0; i < 5; i++) if (idf1000(1000, 333) !== 1040 || comparePaths("x/y", "x\\y") !== 0) bad++;
  ok(bad === 0, "반복 호출 5회 동일");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
