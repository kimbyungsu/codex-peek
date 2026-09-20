/*
 * 브릿지 판 어긋남 감지(src/bridge-stale.ts → out/bridge-stale.js) + 대시보드 배선 소스 검사.
 * 실사고(2026-09-19): 브릿지 갱신 뒤 창 미로드 → 옛 판독기가 새 장부를 '손상'으로 표시·조치 안내 없음.
 * ※ out/bridge-stale.js 는 npm test 의 tsc 산출물 — 단독 실행 시 `npm run compile` 먼저.
 */
const fs = require("fs");
const path = require("path");
const { observeBridgeStale } = require(path.join(__dirname, "..", "out", "bridge-stale.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[1] 첫 관측=지문 기록·변화 없음=정상");
{
  const loaded = new Map();
  const stats = { "C:\\home\\b\\map-enrich.js": { mtimeMs: 100, size: 10 }, "C:\\home\\b\\contract-lib.js": { mtimeMs: 200, size: 20 } };
  const statOf = (p) => stats[p] || null;
  const cached = ["C:\\home\\b\\map-enrich.js", "C:\\home\\b\\contract-lib.js", "C:\\other\\x.js", "C:\\home\\b\\node_modules\\y.js", "C:\\home\\b\\data.json"];
  const r1 = observeBridgeStale(cached, "C:\\home\\b", loaded, statOf);
  ok(r1.stale === false && r1.changed.length === 0 && r1.tracked === 2, "첫 관측: 브릿지 홈 바로 아래 .js 2개만 추적·정상 (" + JSON.stringify(r1) + ")");
  const r2 = observeBridgeStale(cached, "C:\\home\\b", loaded, statOf);
  ok(r2.stale === false && r2.tracked === 2, "변화 없으면 계속 정상");
}

console.log("[2] 디스크 지문이 바뀐 모듈=이전 판(stale)·파일명 보고·대소문자/구분자 무관");
{
  const loaded = new Map();
  const stats = { "c:/home/b/map-enrich.js": { mtimeMs: 100, size: 10 }, "c:/home/b/contract-lib.js": { mtimeMs: 200, size: 20 } };
  const statOf = (p) => stats[String(p).replace(/\\/g, "/").toLowerCase()] || null;
  const cached = ["C:\\Home\\B\\map-enrich.js", "C:\\home\\b\\contract-lib.js"];
  observeBridgeStale(cached, "c:/home/b/", loaded, statOf);
  stats["c:/home/b/map-enrich.js"] = { mtimeMs: 101, size: 10 }; // install 로 갱신
  const r = observeBridgeStale(cached, "C:\\home\\b", loaded, statOf);
  ok(r.stale === true && r.changed.join(",") === "map-enrich.js", "mtime 변화=stale·바뀐 파일명만 (" + JSON.stringify(r) + ")");
  stats["c:/home/b/contract-lib.js"] = { mtimeMs: 200, size: 21 };
  const r3 = observeBridgeStale(cached, "C:\\home\\b", loaded, statOf);
  ok(r3.changed.join(",") === "contract-lib.js,map-enrich.js", "size 변화도 감지·정렬된 목록");
  delete stats["c:/home/b/contract-lib.js"];
  const r4 = observeBridgeStale(cached, "C:\\home\\b", loaded, statOf);
  ok(r4.stale === true && r4.changed.includes("contract-lib.js"), "파일이 사라져도 이전 판으로 본다");
}

console.log("[3] 새로 캐시된 모듈은 그 시점 지문으로 합류(이미 stale 인 다른 모듈과 독립)");
{
  const loaded = new Map();
  const stats = { "c:/h/a.js": { mtimeMs: 1, size: 1 } };
  const statOf = (p) => stats[String(p).replace(/\\/g, "/").toLowerCase()] || null;
  observeBridgeStale(["c:/h/a.js"], "c:/h", loaded, statOf);
  stats["c:/h/a.js"] = { mtimeMs: 2, size: 1 };
  stats["c:/h/b.js"] = { mtimeMs: 5, size: 5 };
  const r = observeBridgeStale(["c:/h/a.js", "c:/h/b.js"], "c:/h", loaded, statOf);
  ok(r.stale === true && r.changed.join(",") === "a.js" && r.tracked === 2, "a.js 만 stale·b.js 는 새 지문으로 합류");
  ok(observeBridgeStale([], "", loaded, statOf).stale === false, "브릿지 홈 미지정=정상(fail-open)");
}

console.log("[4] 대시보드 배선(소스 검사) — 배너·다시 로드 메시지·상태 필드·문구 사실화");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  ok(src.includes('id="bridgeStaleBanner"'), "배너 요소");
  ok(/m\?\.type === "reloadWindow"/.test(src) && src.includes('vscode.postMessage({type:"reloadWindow"})'), "웹뷰→호스트 '창 다시 로드' 메시지와 핸들러");
  ok(/bridgeStale: bridgeStaleView\(\)/.test(src) && /bridgeStale: \{ stale: boolean; changed: string\[\] \} \| null/.test(src), "상태 필드 bridgeStale 계산·타입");
  ok(src.includes("observeBridgeStale(") && src.includes("promptBridgeReload("), "관측 헬퍼·1회 알림 배선");
  ok(!src.includes("자동 실행 정지"), "'자동 실행 정지' 문구 제거(실행기는 damaged 에도 계속 시도)");
  ok(src.includes("이 창의 판독기가 이전 판이라") && src.includes("손상 여부 확인이 필요해요"), "판독 불확실(재로드 전)과 손상 확인 필요를 갈라 말한다");
  // 확인 검증 blocker: 작업 장부뿐 아니라 동의·확인 대기 장부의 damaged 도 stale 이면 손상 단정 금지
  ok(/if\(en9\.consentSt==="damaged"\) msg=staleR9\?staleMsg9:/.test(src) && /else if\(en9\.deferredSt==="damaged"\) msg=staleR9\?staleMsg9:/.test(src), "동의·확인 대기 장부의 damaged 도 stale 두 갈래");
  ok(!/동의 기록 손상 — 수동 복구 필요|확인 대기 기록 손상 — 수동 복구 필요|자동 실행이 멈춰 있어요|상태 파일 손상 — 재점검 필요/.test(src), "재로드 전 단정 문구 잔존 없음");
  // 마지막 판 blocker: 준비 상태(state-damaged)도 stale 이면 손상 단정 금지
  ok(/"state-damaged":\(\(d\.bridgeStale&&d\.bridgeStale\.stale\)\?/.test(src), "준비 상태 state-damaged 도 stale 두 갈래");
  // 사용자 결정 2026-09-20: 실행기 spawn 게이트는 '판독이 믿을 만할 때'만 동의를 검사하고, damaged·stale 이면 실행기에게 넘긴다
  ok(/const c9 = ME9\.readEnrichConsent\(repo9\);\s+const stale9 = bridgeStaleView\(\)\.stale;\s+if \(c9\.st === "ok" && !stale9\) \{/.test(src), "spawn 게이트: 동의 판독 ok·비stale 일 때만 동의 검사");
  ok(src.includes('e.kind==="enrich-quarantined"') && src.includes('e.kind === "enrich-quarantined"'), "배너·상태바가 격리 알림을 자동 보강 알림으로 분류");
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
