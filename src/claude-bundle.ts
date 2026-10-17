// [도우미 판 따라가기 · 2026-10-17] VS Code 에 올라온 Claude Code 확장이 품은 실행 파일 위치를 찾아 ~/.codex-bridge/claude-bin.txt 에 기록한다.
// 왜: 도우미 실행기(bridge/claude-helper.js)는 '지금 대화의 Claude Code 위치' 값을 물려받지 못한 실행(입력 제출 훅이 띄운 자동 분류·정리 담당,
//   확장이 띄운 자동 보강)에서 이 기록 파일을 쓴다. 그런데 훅 쪽 기록은 판 전환 두 번 모두 갱신되지 않았고(2026-10-16 2.1.296→2.1.301 ·
//   2026-10-17 2.1.301→2.1.295 되돌리기), 기록이 가리키는 옛 판 폴더를 VS Code 가 지우면 PATH 의 아주 옛 판으로 떨어진다.
//   codex 쪽(codex-bin.txt — 확장이 활성화 때 vscode API 로 찾은 위치를 기록)과 같은 방식으로, 이 창에 올라온 확장 기준 위치를 보강 기록한다.
// 한계: 확장이 알려 주는 위치는 Claude 확장이 실제로 띄우는 실행 파일을 보증하지 않는다(그 확장의 실행 감싸기 설정 등) — 그래서 찾은 위치도
//   도우미 실행기가 지금처럼 기능 확인(도움말 옵션)을 거친다. 기록 파일은 마지막 기록자 기준(여러 창·도구 실행이 섞이면 나중 기록이 이긴다).
// 판 번호·확장 이름으로 고정하지 않는다 — 실행 파일을 품은 확장을 폴더 모양으로 알아본다.
import * as path from "path";

export type ClaudeBundleExt = { id: string; extensionPath: string; isActive?: boolean };
export type ClaudeBundleHit = { path: string; id: string; active: boolean };
export type ClaudeBinIo = { read: (f: string) => string; write: (f: string, data: string) => boolean };
export type ClaudeBinSync = { state: "written" | "same" | "none" | "failed"; path: string; id: string };

// 확장 폴더 안의 실행 파일 — Claude Code 확장이 스스로 찾는 순서를 따른다: 플랫폼별 폴더(native-binaries/<플랫폼>-<칩>) →
// Windows arm64 는 x64 폴더 → 단일 폴더(native-binary). 없으면 빈 문자열.
// 차이 하나: 그 확장은 musl 여부를 판별해 플랫폼별 폴더를 하나만(<칩> 또는 <칩>-musl) 보지만, 여기서는 판별 없이 <칩> 다음 <칩>-musl 를 본다
// (확장 설치 파일은 플랫폼별이라 보통 한 폴더만 있음). 맞지 않는 판을 집으면 도우미 실행기의 기능 확인이 실패해 도우미 후보 목록의 다음 후보
// (PATH 등)로 넘어간다 — 이 함수가 건너뛴 다른 번들 폴더로 되돌아가지는 않는다.
export function bundledClaudeIn(extPath: string, platform: string, arch: string, exists: (p: string) => boolean): string {
  if (!extPath) return "";
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const dirs = [path.join("resources", "native-binaries", platform + "-" + arch), path.join("resources", "native-binaries", platform + "-" + arch + "-musl")];
  if (platform === "win32" && arch === "arm64") dirs.push(path.join("resources", "native-binaries", "win32-x64"));
  dirs.push(path.join("resources", "native-binary"));
  for (const d of dirs) {
    const p = path.join(extPath, d, exe);
    try { if (exists(p)) return p; } catch { /* 확인 실패=없음 */ }
  }
  return "";
}

// 실행 파일을 품은 확장 고르기 — 이 창에서 활성화된 것 우선, 없으면 목록 순서 첫째. 자기 자신은 제외.
export function pickClaudeBundle(exts: ClaudeBundleExt[], selfId: string, platform: string, arch: string, exists: (p: string) => boolean): ClaudeBundleHit | null {
  const self = String(selfId || "").toLowerCase();
  const hits: ClaudeBundleHit[] = [];
  for (const e of exts || []) {
    if (!e || !e.extensionPath) continue;
    if (self && String(e.id || "").toLowerCase() === self) continue;
    const p = bundledClaudeIn(e.extensionPath, platform, arch, exists);
    if (p) hits.push({ path: p, id: String(e.id || ""), active: !!e.isActive });
  }
  return hits.find((h) => h.active) || hits[0] || null;
}

// 기록 — 찾았고 지금 기록과 다를 때만 쓴다. 못 찾으면 기존 기록을 지우지 않는다(터미널에서 쓰는 Claude Code 처럼 도구 실행이 남긴 기록이
// 그 경우의 출처).
export function syncClaudeBinFrom(exts: ClaudeBundleExt[], opts: { file: string; selfId: string; platform: string; arch: string; exists: (p: string) => boolean; io: ClaudeBinIo }): ClaudeBinSync {
  const hit = pickClaudeBundle(exts, opts.selfId, opts.platform, opts.arch, opts.exists);
  if (!hit) return { state: "none", path: "", id: "" };
  let cur = "";
  try { cur = String(opts.io.read(opts.file) || "").trim(); } catch { cur = ""; }
  if (cur === hit.path) return { state: "same", path: hit.path, id: hit.id };
  let ok = false;
  try { ok = opts.io.write(opts.file, hit.path) !== false; } catch { ok = false; }
  return { state: ok ? "written" : "failed", path: hit.path, id: hit.id };
}
