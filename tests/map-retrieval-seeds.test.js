// 씨앗 추출기(구현 2조각) · 정본 docs/MAP-RETRIEVAL-SPEC.md §3 '추출 대상'
// 계약: 모양 4종 · 다양성 3종 미만 드롭 · JS/TS 예약어·기본 리터럴 제외(흔한 일반어는 보존 — 감점은
// 검색 단계 몫) · 상한 8=HL.maxSeeds(원문 잠금) · 선별=구체성 내림차순+출현 순 · 넘침=개수 보고 ·
// 순수 함수(출력 0 — sink 금지의 전제).
const path = require("path");
const fs = require("fs");
const { extractSeeds, SEED_MAX, JS_RESERVED } = require(path.join(__dirname, "..", "bridge", "map-retrieval.js"));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label); }
}
const values = (r) => r.seeds.map((s) => s.value);
const shapes = (r) => r.seeds.map((s) => s.shape);

console.log("[1] 모양 4종 — 명세 예시 그대로");
{
  const r = extractSeeds('src/extension.ts 를 고치고 `withContract` 와 mapAttachSurface, verify_guard 를 보고 "설치 안내 문구" 를 확인해');
  ok(values(r).includes("src/extension.ts") && r.seeds.find((s) => s.value === "src/extension.ts").shape === "path", "경로(확장자 상대경로)");
  ok(values(r).includes("withContract") && r.seeds.find((s) => s.value === "withContract").shape === "backtick", "백틱 토큰");
  ok(values(r).includes("mapAttachSurface") && values(r).includes("verify_guard"), "식별자 — 낙타등·밑줄");
  ok(values(r).includes("설치 안내 문구") && r.seeds.find((s) => s.value === "설치 안내 문구").shape === "quote", "따옴표 인용문");
}

console.log("[2] 필터 — 예약어·리터럴만 제외, 흔한 일반어는 보존(감점은 검색 단계 몫)");
{
  const r = extractSeeds("`true` `error` `test` `null` `aaa` `if` `undefined` 확인");
  ok(!values(r).includes("true") && !values(r).includes("null") && !values(r).includes("undefined") && !values(r).includes("if"), "예약어·기본 리터럴 제외");
  ok(!values(r).includes("aaa"), "문자 다양성 3종 미만 드롭");
  ok(values(r).includes("error") && values(r).includes("test"), "흔한 토큰(error·test)은 보존 — 명세: 모양으로 안 거르고 흔함 감점으로");
  ok(JS_RESERVED.has("true") && !JS_RESERVED.has("error"), "예약어 집합 자체 검증");
  const r2 = extractSeeds('"고쳐줘" 라고만 왔을 때');
  ok(values(r2).includes("고쳐줘"), "일반어 인용문도 추출 단계에선 보존(명세 명시)");
}

console.log("[3] 중복·구분자 — 같은 값은 구체성 높은 모양 하나로, 역슬래시 경로 통일");
{
  const r = extractSeeds("`withContract` 안의 withContract 식별자");
  ok(values(r).filter((v) => v === "withContract").length === 1 && r.seeds.find((s) => s.value === "withContract").shape === "backtick", "백틱·식별자 중복=백틱 1건");
  const r2 = extractSeeds("bridge\\map-reader.js 파일");
  ok(values(r2).includes("bridge/map-reader.js"), "역슬래시 경로=슬래시 통일 저장");
}

console.log("[4] 상한·선별 — 8개=HL.maxSeeds, 구체성 내림차순+출현 순, 넘침 보고");
{
  const many = "aXa1 bXb1 cXc1 dXd1 eXe1 fXf1 gXg1 hXh1 iXi1 jXj1 그리고 src/last.ts";
  const r = extractSeeds(many);
  ok(r.seeds.length === SEED_MAX && r.dropped === 3, `상한 ${SEED_MAX}·넘침 3 보고(침묵 절단 금지)`);
  ok(values(r)[0] === "src/last.ts", "출현이 늦어도 경로가 식별자보다 앞(구체성 내림차순)");
  ok(values(r).slice(1, 4).join(",") === "aXa1,bXb1,cXc1", "같은 모양 안에서는 출현 순");
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "scope-package.js"), "utf8");
  const hlLine = [...src.matchAll(/^const HL = \{.*\};/gm)];
  ok(hlLine.length === 1, "const HL 선언 정확히 1곳(잠금 정규식 범위 한정 — 보관 1980e204)");
  const m = hlLine.length === 1 ? [...hlLine[0][0].matchAll(/maxSeeds:\s*(\d+)/g)] : [];
  ok(m.length === 1 && Number(m[0][1]) === SEED_MAX, `HL.maxSeeds(${m.length ? m[0][1] : "?"}) === SEED_MAX(${SEED_MAX}) — 복사값 잠금`);
}

console.log("[5] 1차 검증 반례 잠금 — 경로 절단·URL 오인·전이 끝 낙타등·비ASCII·굽은 작은따옴표·async·중복 계상");
{
  const r = extractSeeds("main.c 와 archive.7z 와 global.d.ts 와 types.test.ts 확인");
  ok(values(r).includes("main.c") && values(r).includes("archive.7z"), "1자·숫자 포함 확장자(main.c·archive.7z) 추출");
  ok(values(r).includes("global.d.ts") && values(r).includes("types.test.ts") && !values(r).includes("d.ts") && !values(r).includes("types.test"), "다점 파일명 절단 없음");
  const rUrl = extractSeeds("https://example.com/docs/api.js 를 참고");
  ok(!values(rUrl).some((v) => v.includes("example.com")), "URL은 경로 씨앗으로 오인하지 않음");
  ok(!values(extractSeeds("버전 1.2.3 으로 올려")).includes("1.2.3"), "버전 문자열(순숫자 확장자)은 경로 아님");
  const rId = extractSeeds("parseURL 과 사용자_설정 을 확인");
  ok(values(rId).includes("parseURL"), "대문자 전이로 끝나는 낙타등(parseURL)");
  ok(values(rId).includes("사용자_설정"), "비ASCII 밑줄 식별자(사용자_설정)");
  ok(values(extractSeeds("‘설치 안내 문구’ 를 확인")).includes("설치 안내 문구"), "굽은 작은따옴표 인용문");
  ok(values(extractSeeds("`async` 함수")).includes("async"), "async는 문맥 키워드=유효 식별자 — 제외하지 않음(let async=1 실행 가능)");
  const rDup = extractSeeds('"bridge\\map-reader.js" 파일');
  ok(values(rDup).filter((v) => v.replace(/\\+/g, "/") === "bridge/map-reader.js").length === 1 && rDup.seeds.find((s) => s.value === "bridge/map-reader.js").shape === "path", "역슬래시 인용문↔경로 중복=경로 1건(정규화 키 중복 제거)");
}

console.log("[5b] 2차 검증 반례 잠금 — 유니코드·숨김 경로, URL 인접·대문자·상대, 숫자 시작 토큰");
{
  const r = extractSeeds("src/설정.ts 와 .env.local 을 확인");
  ok(values(r).includes("src/설정.ts"), "유니코드 이름 경로(src/설정.ts)");
  ok(values(r).includes(".env.local") && !values(r).includes("env.local"), "숨김 파일 선행점 보존(.env.local)");
  const rAdj = extractSeeds("https://example.com/a.js,parseURL 을 확인");
  ok(values(rAdj).includes("parseURL") && !values(rAdj).some((v) => v.includes("example.com")), "URL 뒤 쉼표 인접 씨앗 보존+URL 미추출");
  ok(!values(extractSeeds("HTTPS://EXAMPLE.COM/A.JS 참조")).some((v) => v.toLowerCase().includes("example.com")), "대문자 스킴 URL도 제거");
  ok(!values(extractSeeds("//example.com/a.js 참조")).some((v) => v.includes("example.com")), "상대 URL(//호스트.점) 제거");
  ok(values(extractSeeds("코드에 //fooBar 주석")).includes("fooBar"), "점 없는 //토큰(주석)은 지우지 않음 — 씨앗 보존");
  const rNum = extractSeeds("123_value 와 1parseURL 는 식별자가 아님, $fooBar 는 식별자");
  ok(!values(rNum).includes("123_value") && !values(rNum).includes("1parseURL"), "숫자 시작 토큰=식별자 아님(수정 유발 회귀 봉합)");
  ok(values(rNum).includes("$fooBar"), "$ 시작 식별자는 유효");
}

console.log("[5c] 3·4차 검증 반례 잠금 — URL 내부/경계·절대/file: 경로·NFD 결합문자");
{
  // 4차 확정 계약: 괄호는 URL의 일부(IPv6·괄호 경로가 유효 URL) — 공백 없이 붙은 토큰은 URL 꼬리로
  // 취급되어 씨앗이 아니다. 인접 보존은 쉼표([5b])·공백 구분 케이스만.
  const rIn = extractSeeds("https://example.com/(parseURL) 와 https://[2001:db8::1]/mapAttach 확인");
  ok(!values(rIn).includes("parseURL") && !values(rIn).includes("mapAttach") && !values(rIn).some((v) => v.includes("example.com") || v.includes("2001")), "괄호 경로·IPv6 URL 내부는 씨앗으로 새지 않음");
  ok(values(extractSeeds("https://example.com/a.js (parseURL) 확인")).includes("parseURL"), "공백으로 구분된 괄호 씨앗은 보존");
  const ra = extractSeeds("/src/setting.ts 와 C:\\src\\setting.ts 와 file:///src/setting.ts 는 절대·URL");
  ok(!values(ra).includes("src/setting.ts") && !values(ra).some((v) => v.includes("setting.ts")), "절대경로·드라이브·file: 꼬리를 상대경로로 오인하지 않음");
  ok(values(extractSeeds("상대경로 src/setting.ts 는 추출")).includes("src/setting.ts"), "(대조) 진짜 상대경로는 그대로 추출");
  const nfd = "src/e\u0301.ts"; // é를 e+결합 액센트로 쓴 NFD 경로
  ok(values(extractSeeds(nfd + " 확인")).includes(nfd), "NFD 결합문자 경로 추출(정준 동등 파일명 지원)");
  // 4차 반례: 경로 양쪽 경계
  ok(values(extractSeeds("경로:src/a.ts 를 봐")).includes("src/a.ts"), "라벨 콜론 뒤 상대경로는 정상 추출(콜론 과차단 해소)");
  const rTrunc = extractSeeds("src/a.ts_extra 와 src/a.ts-more 와 src/a.ts/more 는 경로 아님");
  ok(!values(rTrunc).includes("src/a.ts"), "비경로 토큰의 접두 절단 없음(src/a.ts_extra 등)");
  ok(values(extractSeeds("src/a.ts를 바로 확인")).includes("src/a.ts"), "한글 조사 직결(src/a.ts를)은 경로 추출 유지");
  // 5~7차 반례: 상대 URL 판정=Node URL 파서 위임(유효+점/콜론 호스트=마스킹·무효/단일 라벨=보존)
  ok(values(extractSeeds("//[2001:db8::1]/parseURL 확인")).length === 0, "프로토콜 상대 IPv6 URL 내부 미노출");
  ok(values(extractSeeds("//user@[2001:db8::1]/parseURL 확인")).length === 0, "사용자정보 붙은 상대 IPv6 URL도 미노출");
  ok(values(extractSeeds("//@[2001:db8::1]/parseURL 확인")).length === 0, "빈 사용자정보(@만)도 Node 유효=미노출");
  ok(values(extractSeeds("//user@name@[2001:db8::1]/parseURL 확인")).length === 0, "이중 @ 사용자정보도 Node 유효=미노출");
  ok(values(extractSeeds("//[TODO]/parseURL 확인")).includes("parseURL"), "비IPv6 대괄호(//[TODO])=Node 무효 — 과잉 마스킹 없이 씨앗 보존");
  ok(values(extractSeeds("//[DEAD]/parseURL 확인")).includes("parseURL"), "전부 16진 문자여도 [DEAD]=Node 무효 — 보존(모양 흉내가 아니라 파서 판정)");
  ok(values(extractSeeds("//[2001:db8::1]:99999/parseURL 확인")).includes("parseURL"), "포트 초과=Node 무효 — 보존");
  const rDrv = extractSeeds(String.raw`C:src\a.ts 와 C:src/a.ts 는 드라이브 상대경로`);
  ok(!values(rDrv).some((v) => v.includes("a.ts")), "드라이브 상대경로(역슬래시·슬래시 양형)의 접두 소실 오인 없음");
  ok(values(extractSeeds("label:src/a.ts 도 봐")).includes("src/a.ts"), "(대조) 여러 글자 라벨 콜론은 여전히 정상 추출");
}

console.log("[6] 순수성 — 출력 0바이트·비문자열 무해·결정론");
{
  const outs = [];
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { outs.push(c); return true; };
  process.stderr.write = (c) => { outs.push(c); return true; };
  extractSeeds('민감한 "비밀 문구" 와 `secretToken` src/a.ts');
  process.stdout.write = so; process.stderr.write = se;
  ok(outs.length === 0, "추출 중 stdout·stderr 0바이트(씨앗 sink 금지의 전제)");
  ok(extractSeeds(null).seeds.length === 0 && extractSeeds(undefined).dropped === 0, "null·undefined=빈 결과(크래시 없음)");
  const a = JSON.stringify(extractSeeds("같은 `input` 반복")), b = JSON.stringify(extractSeeds("같은 `input` 반복"));
  ok(a === b, "결정론 — 같은 입력 같은 결과");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
