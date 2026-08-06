// [UI 개편 2차] 동봉 기록부(stats/attach.jsonl) — 개요 '이번 검증에 실린 기억' 카드의 자료 계약.
// ① 기능: append/trim/깨진 줄 내성 ② 배선: withContract의 동봉 try 안에서 best-effort 호출(실패해도 ask 무중단).
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "attach_home_"));
process.env.CODEX_BRIDGE_HOME = home;

const CL = require("../bridge/contract-lib.js");

let pass = 0, fail = 0;
const ck = (n, c) => { (c ? pass++ : fail++); console.log((c ? "  ✅ " : "  ❌ ") + n); };

console.log("[1] append — 한 줄 JSONL·폴더 자동 생성");
{
  const ok1 = CL.appendAttachUsage({ ts: "2026-08-07T00:00:00.000Z", ws: "d:/w1", items: [{ path: "src/a.ts", note: "메모" }], couplings: 2, omitted: false });
  ck("기록 성공", ok1 === true && fs.existsSync(CL.ATTACH_USAGE_FILE));
  const j = JSON.parse(fs.readFileSync(CL.ATTACH_USAGE_FILE, "utf8").trim());
  ck("필드 보존(ws·items·couplings·omitted)", j.ws === "d:/w1" && j.items.length === 1 && j.items[0].path === "src/a.ts" && j.couplings === 2 && j.omitted === false);
}

console.log("[2] trim — 상한 초과 시 최신만 보존(무한 성장 차단)");
{
  for (let i = 0; i < 230; i++) CL.appendAttachUsage({ ts: "t" + i, ws: "d:/w1", items: [], couplings: 0, omitted: true });
  const lines = fs.readFileSync(CL.ATTACH_USAGE_FILE, "utf8").split("\n").filter(Boolean);
  ck("상한(200) 이하 유지", lines.length <= 200);
  ck("최신 줄 보존", JSON.parse(lines[lines.length - 1]).ts === "t229");
}

console.log("[3] 내성 — 깨진 줄이 있어도 append는 계속");
{
  fs.appendFileSync(CL.ATTACH_USAGE_FILE, "{broken json\n", "utf8");
  ck("깨진 줄 후에도 기록 성공", CL.appendAttachUsage({ ts: "after", ws: "d:/w2", items: [], couplings: 0, omitted: false }) === true);
  const lines = fs.readFileSync(CL.ATTACH_USAGE_FILE, "utf8").split("\n").filter(Boolean);
  ck("마지막 줄=새 기록", JSON.parse(lines[lines.length - 1]).ws === "d:/w2");
}

console.log("[4] 배선 소스 계약 — withContract 동봉 try 안·best-effort·게이트 생략 표기");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "bridge", "codex-bridge.js"), "utf8");
  const b = src.indexOf("function withContract(");
  const e = src.indexOf("\nfunction ", b + 10);
  const fn = src.slice(b, e);
  ck("동봉 스냅샷을 기록(carrier 채운 직후)", /carrier\.couplings = att\.couplings \|\| \[\];[\s\S]{0,400}appendAttachUsage\(\{/.test(fn));
  ck("자체 try — 기록 실패가 ask를 못 막음", /try \{ appendAttachUsage\(/.test(fn));
  ck("게이트 생략(omitted)을 양언어 고지문으로 판정", fn.includes("동봉 생략|omitted"));
  ck("항목 상한·메모 절단(무한 팽창 차단)", fn.includes(".slice(0, 12)") && fn.includes(".slice(0, 160)"));
}

console.log(`결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
