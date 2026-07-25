// install.js의 pickVsix / buildInstallCmd 회귀 테스트.
// 자동설치가 빗나간 두 버그(잘못된 vsix 선택 / bare code 따옴표)를 고정한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pickVsix, currentVsix, buildInstallCmd, bridgeRuntimeParity } = require("../install.js");

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

console.log("[3] currentVsix — 현재 버전과 정확히 일치하는 vsix만 인정(옛 vsix 설치 사고 방지)");
ck("옛 vsix만 있고 현재 버전 없으면 null(→빌드 유도)", currentVsix(["codex-bridge-0.1.20.vsix"], "0.1.28") === null);
ck("현재 버전 vsix 있으면 그걸 반환", currentVsix(["codex-bridge-0.1.28.vsix"], "0.1.28") === "codex-bridge-0.1.28.vsix");
ck("옛것+현재것 섞여도 현재 버전 반환", currentVsix(["codex-bridge-0.1.20.vsix", "codex-bridge-0.1.28.vsix"], "0.1.28") === "codex-bridge-0.1.28.vsix");
ck("vsix 전무면 null", currentVsix([], "0.1.28") === null);
ck("version 비면 폴백 유지(하위호환, 최신 반환)", currentVsix(["codex-bridge-0.1.20.vsix"], "") === "codex-bridge-0.1.20.vsix");

console.log("[4] bridgeRuntimeParity — 리로드로 숨은 구 실행 파일을 status가 검출");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install_parity_"));
  const src = path.join(root, "src"), live = path.join(root, "live"), files = ["a.js", "b.js"];
  fs.mkdirSync(src); fs.mkdirSync(live);
  fs.writeFileSync(path.join(src, "a.js"), "A"); fs.writeFileSync(path.join(src, "b.js"), "B");
  fs.copyFileSync(path.join(src, "a.js"), path.join(live, "a.js")); fs.copyFileSync(path.join(src, "b.js"), path.join(live, "b.js"));
  const manifest = { schema: "deploy-manifest-v1", files: {} };
  for (const f of files) manifest.files[f] = crypto.createHash("sha1").update(fs.readFileSync(path.join(src, f))).digest("hex");
  fs.writeFileSync(path.join(live, "deploy-manifest.json"), JSON.stringify(manifest));
  ck("같은 실행 세대=정상", bridgeRuntimeParity(src, live, files).ok);
  fs.unlinkSync(path.join(live, "b.js"));
  const missing = bridgeRuntimeParity(src, live, files);
  ck("새 파일 누락=실패+파일명", !missing.ok && missing.missing.includes("b.js"));
  fs.copyFileSync(path.join(src, "b.js"), path.join(live, "b.js")); fs.writeFileSync(path.join(live, "a.js"), "OLD");
  const changed = bridgeRuntimeParity(src, live, files);
  ck("옛 내용=실패+파일명", !changed.ok && changed.changed.includes("a.js"));
  fs.copyFileSync(path.join(src, "a.js"), path.join(live, "a.js")); manifest.files["a.js"] = "0".repeat(40); fs.writeFileSync(path.join(live, "deploy-manifest.json"), JSON.stringify(manifest));
  const staleManifest = bridgeRuntimeParity(src, live, files);
  ck("실행 파일이 같아도 낡은 배포 목록=실패", !staleManifest.ok && staleManifest.manifest === "source-mismatch");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
