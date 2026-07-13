/*
 * ask --net 옵트인 — 검증 1회 한정 '파일 읽기전용 유지 + 네트워크 허용' 권한 프로필 주입.
 * 배경(실측 2026-07-02, codex-cli 0.118 · Windows): 기본 read-only 샌드박스는 죽은 프록시(127.0.0.1:9)를 하위 셸에
 * 심어 통신을 끊는다. -c 로 permissions 프로필(extends=:read-only + network.enabled)을 주면 프록시가 해제되고
 * git ls-remote가 성공하며 파일 쓰기는 여전히 거부된다. 도메인 allowlist는 Windows 미집행 실측이라 안 넣는다(거짓 안전감 방지).
 */
const path = require("path");
const fs = require("fs");
const { netArgs, netNote, askRequest } = require(path.join(__dirname, "..", "bridge", "codex-bridge.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

console.log("[netArgs] -c 오버라이드 구성 — config.toml 무접촉 원칙");
const a = netArgs();
ok(a.length === 8 && a.filter((x) => x === "-c").length === 4, "-c 4쌍 구조");
ok(a.includes("default_permissions=netverify"), "프로필 지정(default_permissions)");
ok(a.includes('permissions.netverify.extends=":read-only"'), "파일시스템은 읽기전용 상속(:read-only)");
ok(a.includes("permissions.netverify.network.enabled=true"), "네트워크 허용");
ok(a.includes("permissions.netverify.network.mode=limited"), "mode=limited(실측 성공 조합 고정)");
ok(!a.some((x) => /domains/.test(x)), "도메인 allowlist 미포함(Windows 미집행 실측 — 거짓 안전감 방지)");
ok(!a.some((x) => /workspace-write|danger/.test(x)), "쓰기 샌드박스로 격상하지 않음");

console.log("[netNote] 검증자에게 주는 안내 — 양언어 + Windows 인증서(schannel) 우회 힌트");
ok(/읽기전용/.test(netNote("ko")) && /sslBackend=openssl/.test(netNote("ko")), "KO: 읽기전용 유지 + openssl 힌트");
ok(/read-only/.test(netNote("en")) && /sslBackend=openssl/.test(netNote("en")), "EN: read-only + openssl 힌트");

console.log("[지시문] 매 턴 주입되는 검증 지시가 구현모델에게 --net의 존재·사용 기준을 양언어로 알리는지");
const { buildVerifyDirective } = require(path.join(__dirname, "..", "bridge", "contract-lib.js"));
for (const m of ["always", "plancode", "code"]) {
  const ko = buildVerifyDirective(m, "ko"), en = buildVerifyDirective(m, "en");
  ok(/\[원격 확인\]/.test(ko) && /ask.*--net|--net.*ask|`--net`/.test(ko) && /읽기 전용/.test(ko), `KO(${m}): [원격 확인] 단락 + --net + 읽기전용 유지 명시`);
  ok(/\[Remote checks\]/.test(en) && /`--net`/.test(en) && /read-only/.test(en), `EN(${m}): [Remote checks] + --net + read-only 명시`);
  ok(/로컬 파일로 충분한 검증엔 --net을 쓰지 마라/.test(ko) && /Do not use --net when local files suffice/.test(en), `양언어(${m}): 남용 금지 기준 포함`);
}

console.log("[배선] cmdAsk가 --net을 인식하고 resume·새세션 양쪽에 주입하는지(소스 검사)");
const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
ok(/const net = rest\.includes\("--net"\)/.test(src), "--net 플래그 파싱");
const parsed = askRequest(["--allow-new", "--net", "검증", "본문"]);
ok(parsed.flags.includes("--net") && parsed.flags.includes("--allow-new") && parsed.prompt === "검증 본문", "--net과 제어 플래그가 프롬프트 본문에서 제거됨");
ok((src.match(/net \? netArgs\(\) : \[\]/g) || []).length === 2, "resume + 새 세션 두 호출 모두 주입");
ok((src.match(/net \? netNote\(langSnap\) : ""/g) || []).length === 2, "두 경로 모두 프롬프트에 netNote 첨부");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
