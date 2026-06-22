// links.json 쓰기 단일 관문(updateLinks)의 CAS+재시도 회귀 테스트.
// P1b: 여러 쓰기 경로가 통째 덮어쓰던 lost-update를 막는다.
// CODEX_BRIDGE_HOME을 require 전에 임시폴더로 지정 → 실제 ~/.codex-bridge 오염 방지.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas_"));
process.env.CODEX_BRIDGE_HOME = dir;
const { updateLinks, loadLinks, LINKS_FILE } = require("../bridge/codex-bridge.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };
const readFile = () => { try { return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")); } catch { return null; } };

console.log("[1] 순차 쓰기 — 서로 다른 키가 둘 다 살아남음(통째 덮어쓰기 아님)");
updateLinks((o) => { o.modelPrefs = o.modelPrefs || {}; o.modelPrefs["wsA"] = { model: "m1" }; });
updateLinks((o) => { o.byWorkspace["wsB"] = { codexSession: "S2" }; });
const after2 = readFile();
ck("첫 쓰기(modelPrefs.wsA) 보존", after2 && after2.modelPrefs && after2.modelPrefs.wsA && after2.modelPrefs.wsA.model === "m1");
ck("둘째 쓰기(byWorkspace.wsB)도 존재", after2 && after2.byWorkspace && after2.byWorkspace.wsB && after2.byWorkspace.wsB.codexSession === "S2");

console.log("[2] CAS 재시도 — 읽기↔쓰기 사이 '다른 프로세스'가 끼어들어도 그 변경을 덮어쓰지 않음");
let firstPass = true;
updateLinks((o) => {
  o.byWorkspace["mine"] = { codexSession: "MINE" };
  if (firstPass) {
    firstPass = false;
    // updateLinks가 'before'를 읽은 뒤다. 외부 프로세스가 끼어들어 다른 키를 직접 저장한 것처럼 만든다.
    // → updateLinks가 쓰기 직전 재확인에서 변경을 감지하고 재시도해야 한다(이 mutator가 한 번 더 호출됨).
    const cur = (function () { try { return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")); } catch { return {}; } })();
    cur.byWorkspace = cur.byWorkspace || {};
    cur.byWorkspace["intruder"] = { codexSession: "INTRUDER" };
    fs.writeFileSync(LINKS_FILE, JSON.stringify(cur, null, 2), "utf8");
  }
});
const after3 = readFile();
ck("재시도가 한 번 일어남(mutator 2회 호출 → firstPass 소진)", firstPass === false);
ck("끼어든 외부 변경(intruder) 보존 — lost-update 아님", after3 && after3.byWorkspace && after3.byWorkspace.intruder && after3.byWorkspace.intruder.codexSession === "INTRUDER");
ck("내 변경(mine)도 최종 반영", after3 && after3.byWorkspace && after3.byWorkspace.mine && after3.byWorkspace.mine.codexSession === "MINE");
ck("앞 단계 키들도 그대로(wsA·wsB)", after3 && after3.modelPrefs.wsA && after3.byWorkspace.wsB);

console.log("[3] loadLinks 기본형 — 파일 없을 때도 bySession/byWorkspace 보장");
const fresh = loadLinks();
ck("loadLinks가 bySession/byWorkspace 객체를 줌", fresh && typeof fresh.bySession === "object" && typeof fresh.byWorkspace === "object");

console.log("\n결과: " + pass + " 통과 / " + fail + " 실패");
process.exit(fail ? 1 : 0);
