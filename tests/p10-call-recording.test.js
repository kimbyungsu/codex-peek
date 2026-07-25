/* P10 증분 1 — 실제 API 시작 뒤 throw/usage 없음/부분 usage도 호출 행 1건, 호출 전 중단은 0건. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "p10-call-"));
process.env.CODEX_BRIDGE_HOME = home;
const CL = require(path.join(ROOT, "bridge", "contract-lib.js"));
const DS = require(path.join(ROOT, "bridge", "deepseek-bridge.js"));
const SP = require(path.join(ROOT, "scripts", "scout-providers.js"));
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }
const cfg = { apiKey: "synthetic", baseUrl: "https://invalid.test", model: "stub" };
const ctx = { scope: "project", repoKey: "0123456789abcdef", flow: "map-enrich", charsIn: 9, runId: crypto.randomUUID(), jobKey: "a".repeat(40), jobRunId: "b".repeat(40) };
const req = { model: "stub", messages: [{ role: "user", content: "fixture" }] };
const rows = () => { try { return fs.readFileSync(CL.SCOUT_USAGE_FILE, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };

(async () => {
  console.log("[1] DeepSeek 실제 fetch 경계");
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error("network-down"); };
  let threw = false; try { await DS.callChat(cfg, req, 1000, { usageContext: ctx }); } catch { threw = true; }
  let got = rows();
  ok(threw && got.length === 1 && got[0].tokenIn === null && got[0].charsOut === 0, "fetch 시작 뒤 throw도 token null 호출 1건");
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }], model: "stub" }) });
  await DS.callChat(cfg, req, 1000, { usageContext: ctx });
  got = rows();
  ok(got.length === 2 && got[1].tokenIn === null && got[1].tokenOut === null && got[1].charsOut > 0, "usage 없는 정상 응답도 호출 1건·token null");
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: null }, model: "stub" }) });
  await DS.callChat(cfg, req, 1000, { usageContext: ctx });
  got = rows();
  ok(got.length === 3 && got[2].tokenIn === null && got[2].tokenOut === null && new Set(got.map((x) => x.callId)).size === 3, "부분 usage는 두 token 모두 null·각 호출 callId 독립");
  global.fetch = oldFetch;

  console.log("[2] 실제 호출 전 중단");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p10-precall-"));
  fs.writeFileSync(path.join(repo, "x.js"), "x");
  const before = rows().length;
  const r = SP.runScout(repo, "self", { _providers: { self: { id: "self", available: () => false, probe: () => ({ ok: false }), invoke: () => { throw new Error("must-not-run"); } } } });
  ok(r.ok === false && rows().length === before, "available 단계 중단은 외부 호출 행 0건");

  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
