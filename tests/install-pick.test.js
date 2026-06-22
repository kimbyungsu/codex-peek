// install.js의 pickVsix / buildInstallCmd 회귀 테스트.
// 자동설치가 빗나간 두 버그(잘못된 vsix 선택 / bare code 따옴표)를 고정한다.
const { pickVsix, buildInstallCmd } = require("../install.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] pickVsix — codex-bridge-* 만, 최신 버전");
ck("잔재 codex-peek-*.vsix는 무시(우리 것만)", pickVsix(["codex-bridge-0.1.18.vsix", "codex-peek-0.1.0.vsix"]) === "codex-bridge-0.1.18.vsix");
ck("0.1.9 vs 0.1.18 → 최신 0.1.18(사전식 아님)", pickVsix(["codex-bridge-0.1.9.vsix", "codex-bridge-0.1.18.vsix"]) === "codex-bridge-0.1.18.vsix");
ck("0.2.0 > 0.1.18(메이저/마이너 비교)", pickVsix(["codex-bridge-0.1.18.vsix", "codex-bridge-0.2.0.vsix"]) === "codex-bridge-0.2.0.vsix");
ck("preferVersion 정확 일치 최우선", pickVsix(["codex-bridge-0.1.9.vsix", "codex-bridge-0.1.18.vsix"], "0.1.9") === "codex-bridge-0.1.9.vsix");
ck("우리 vsix 없으면 null", pickVsix(["codex-peek-0.1.0.vsix", "foo.vsix"]) === null);
ck("빈 목록 null", pickVsix([]) === null);

console.log("[2] buildInstallCmd — bare 명령 따옴표 금지, 경로는 따옴표");
ck("bare 'code'는 따옴표 안 씌움(Windows PATHEXT 9009 방지)", buildInstallCmd("code", "C:/x.vsix") === 'code --install-extension "C:/x.vsix" --force');
ck("vsix 경로는 공백 있어도 항상 따옴표", /--install-extension "C:\/path with space\/x\.vsix" --force$/.test(buildInstallCmd("code", "C:/path with space/x.vsix")));
ck("절대경로 code(공백 포함)는 따옴표", buildInstallCmd("C:/Program Files/x/code.cmd", "C:/x.vsix") === '"C:/Program Files/x/code.cmd" --install-extension "C:/x.vsix" --force');
ck("백슬래시 경로도 슬래시로 통일(셸 안전)", buildInstallCmd("code", "C:\\a\\x.vsix") === 'code --install-extension "C:/a/x.vsix" --force');

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
