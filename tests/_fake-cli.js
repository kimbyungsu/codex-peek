/*
 * 시험 전용 — 가짜 명령줄(claude·codex 등)을 임시 폴더에 만들어 PATH 앞에 붙인다.
 * 배경(2026-09-18 CI 실패): 정찰 담당 준비 점검(scoutArmReadiness — 명령줄이 PATH 에 실제로 있어야 '준비')이 생기자
 * claude/codex 가 없는 CI 러너에서 플랜 게이트·자동 지시가 fail-open 으로 통과해 '차단을 기대하는' 시험 8건이 깨졌다.
 * 개발 PC 에는 실물이 있어 국소 실행만으로는 안 보이던 환경 의존 — 차단을 기대하는 시험은 이 헬퍼로 '담당 준비됨' 환경을 명시한다.
 * 미준비를 시험하는 사례는 PATH 를 빈 폴더로 덮어써야 한다(scout-arm [4c]·scout-gate·p3b-stage1 참조).
 * 실행 파일은 즉시 종료하는 껍데기다 — 실제 호출이 일어나면 실패가 보이게 stderr 에 표식을 남긴다.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function installFakeClis(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cli-"));
  for (const n of names || ["claude", "codex"]) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(dir, n + ".cmd"), "@echo off\r\necho fake-" + n + " (test stub) 1>&2\r\nexit /b 0\r\n");
    } else {
      const f = path.join(dir, n);
      fs.writeFileSync(f, "#!/bin/sh\necho 'fake-" + n + " (test stub)' 1>&2\nexit 0\n");
      fs.chmodSync(f, 0o755);
    }
  }
  const cur = process.env.PATH || process.env.Path || "";
  const next = dir + path.delimiter + cur;
  process.env.PATH = next;
  if (process.platform === "win32") process.env.Path = next; // Node 는 대소문자 별개 키로 둘 다 노출할 수 있다
  return dir;
}

module.exports = { installFakeClis };
