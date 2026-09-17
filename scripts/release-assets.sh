#!/usr/bin/env bash
# 릴리스 자산 3종 구성(release.js 완주·태그 뒤 실행): codex-peek-<v>-installer.zip(git archive HEAD + out/*.js·map 쌍 + vsix) · vsix · SHA256SUMS.txt
# 사용(Git Bash): bash scripts/release-assets.sh  →  gh release create v<v> --notes-file … codex-peek-<v>-installer.zip codex-bridge-<v>.vsix SHA256SUMS.txt
# 기록(2026-09-16 · D-2026-09-16-release-assets-record): 이 절차는 예전에 임시 폴더의 스크립트로만 있었고, 작업 폴더 out/pkg 를 남겨 다음 tsc 를 깨뜨렸다(tsconfig 가 out/ 를 include).
#   → 저장소 안에 두고, 끝나면 out/pkg 를 반드시 지우며, tsconfig.json exclude 에 out 을 넣어 잔재가 있어도 컴파일이 깨지지 않게 했다.
# zip 은 bsdtar(Windows 내장 tar.exe -a)로 만든다 — PowerShell Compress-Archive 는 경로 구분자를 백슬래시로 써 리눅스·맥에서 잘못 풀린다.
set -euo pipefail
cd /d/codex-peek
V=$(node -p "require('./package.json').version")
VSIX="codex-bridge-$V.vsix"; [ -f "$VSIX" ] || { echo "vsix 없음: $VSIX"; exit 1; }
PKG=out/pkg; rm -rf "$PKG"; mkdir -p "$PKG"
git archive --format=tar --prefix="codex-peek-$V/" HEAD | tar -x -C "$PKG"
mkdir -p "$PKG/codex-peek-$V/out"; for m in out/*.js.map; do cp "$m" "${m%.map}" "$PKG/codex-peek-$V/out/"; done  # 컴파일 산출물(.js+.map 쌍)만 — out/ 의 스모크 스크립트·로그 제외
cp "$VSIX" "$PKG/codex-peek-$V/"
ZIP="codex-peek-$V-installer.zip"; rm -f "$ZIP"
(cd "$PKG" && /c/Windows/System32/tar.exe -a -cf "../../$ZIP" "codex-peek-$V")  # bsdtar zip — 경로 구분자 '/'(Compress-Archive 는 백슬래시를 써 리눅스·맥에서 잘못 풀림)
sha256sum "$ZIP" "$VSIX" > SHA256SUMS.txt
echo "== $ZIP entries: $(unzip -l "$ZIP" | tail -1)"; unzip -l "$ZIP" | awk '{print $4}' | grep -c "/out/" | sed 's/^/out files: /'
unzip -l "$ZIP" | awk '{print $4}' | grep -E "vsix|bridge/scout-providers.js|bridge/scope-package-core.js" ; cat SHA256SUMS.txt
rm -rf "$PKG"  # 작업 폴더 정리 — 남기면 tsc include 에 잡힌다(2026-09-16 실사고)
