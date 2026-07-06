#!/usr/bin/env node
/*
 * DeepSeek 탐색 팔(SCOUT-TRACK §3.3) — 자료 꾸러미(MD)를 OpenAI 호환 POST /chat/completions로 보내
 * 영향범위 지도를 받는다. advisory 단계이므로 어떤 실패(키 없음·네트워크·타임아웃·이상 응답)도
 * 게이트를 막지 않는다 — 명확한 오류 메시지 + exit 1로 '지도 못 받음'만 가시화.
 *
 * 사용:
 *   node deepseek-bridge.js ping                 — 키·주소·모델이 실제 응답하는지 1회 확인
 *   node deepseek-bridge.js map [--out <파일>]   — stdin으로 꾸러미(MD)를 받아 지도 출력
 *
 * 키 해석(§14 D4): env DEEPSEEK_API_KEY → ~/.codex-bridge/deepseek.json(대시보드 ⚙️고급설정 탭이 쓰는 파일).
 * ⚠ 외부 전송 지점: map은 stdin으로 받은 꾸러미 전문을 DeepSeek API로 보낸다(꾸러미 빌더가 민감 범주
 *   diff를 사전 제외 — PRIVACY.md '외부로 나가는 것' 참조). 키 원문은 어떤 출력에도 찍지 않는다.
 * Node 18+ 필요(내장 fetch) — 미만이면 정직한 오류로 중단(§3.3의 '버전 체크' 선택지 채택: 이 도구의
 *   설치·CI 환경이 전부 18+라 https 폴백의 복잡도가 비용 대비 무가치).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const BRIDGE_DIR = process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge");
const DEEPSEEK_FILE = path.join(BRIDGE_DIR, "deepseek.json");
const DEEPSEEK_DEFAULTS = { model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com" };

// 설정 해석(순수) — env 키가 파일 키보다 우선(D4), model/baseUrl은 파일 → 기본값. 테스트가 직접 import.
function resolveDeepseekConfig(env, fileJson) {
  const f = fileJson && typeof fileJson === "object" ? fileJson : {};
  const apiKey = String((env && env.DEEPSEEK_API_KEY) || f.apiKey || "").trim();
  return {
    apiKey,
    model: typeof f.model === "string" && f.model.trim() ? f.model.trim() : DEEPSEEK_DEFAULTS.model,
    baseUrl: (typeof f.baseUrl === "string" && f.baseUrl.trim() ? f.baseUrl.trim() : DEEPSEEK_DEFAULTS.baseUrl).replace(/\/+$/, ""),
  };
}

// 지도 요청 본문(순수) — self 팔(scope-scout-self.js)과 같은 꾸러미·같은 지시 앞머리(D5 A/B 공정성).
// 문구 차이는 '도구 차단' 언급 하나뿐: self 팔은 CLI 도구를 실제로 차단해야 해서 그 사실을 알리지만,
// API 모델은 도구가 원래 없어 해당 문장이 성립하지 않는다(없는 것을 있다고 말하면 오히려 조건 불일치).
function buildMapRequest(pkgMd, model) {
  const preface = "너는 '탐색자'다. 아래 꾸러미가 유일한 근거다 — 꾸러미 밖 추측으로 파일을 지어내지 마라. 꾸러미 끝의 [탐색자 지시] 형식을 정확히 따르라.";
  return {
    model,
    messages: [{ role: "user", content: preface + "\n\n" + String(pkgMd || "") }],
    temperature: 0, // A/B 비교 대상이라 무작위성 최소화(재현성)
    max_tokens: 8000, // 추론 모델은 reasoning이 상한을 먼저 먹음 — 지도 본문이 잘리지 않게 여유(v4-flash 출력 단가 저렴)
    stream: false,
  };
}

function loadConfig() {
  let fileJson = null;
  try { fileJson = JSON.parse(fs.readFileSync(DEEPSEEK_FILE, "utf8")); } catch { /* 파일 없음/파손 — env만으로 진행 */ }
  return resolveDeepseekConfig(process.env, fileJson);
}

async function callChat(cfg, body, timeoutMs, opts) {
  if (typeof fetch !== "function") throw new Error("Node 18 이상이 필요합니다(내장 fetch 없음) — node -v 확인");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 300)}`);
    let j;
    try { j = JSON.parse(text); } catch { throw new Error("응답이 JSON이 아님: " + text.slice(0, 200)); }
    const msg = j && j.choices && j.choices[0] ? j.choices[0].message : null;
    if (!msg) throw new Error("응답에 choices/message 없음: " + text.slice(0, 200));
    // v4-flash는 추론 모델 — reasoning_content를 먼저 채우고 본문(content)은 그 뒤에 온다(라이브 실측).
    // 상한이 추론에 다 소진되면 content가 빈 채로 오므로, 그 경우를 구분해 정직하게 알린다.
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    const reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content.trim() : "";
    if (!content && !(opts && opts.allowEmptyContent)) {
      throw new Error(reasoning
        ? "본문 없이 추론(reasoning_content)만 도착 — max_tokens가 추론에 소진된 것(출력 상한을 늘려 재시도)"
        : "응답에 content 없음: " + text.slice(0, 200));
    }
    return { content, reasoning, usage: j.usage || null, model: j.model || body.model };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`타임아웃(${Math.round(timeoutMs / 1000)}s) — 네트워크/응답 지연`);
    throw e;
  } finally { clearTimeout(timer); }
}

const NO_KEY_MSG = "DeepSeek 키 없음 — 대시보드 ⚙️고급설정 탭에서 입력하거나 DEEPSEEK_API_KEY env 설정(LLM 지도 단계만 잠김 — 기초 탐색은 무관)";

async function main() {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  if (cmd === "ping" || cmd === "test") {
    if (!cfg.apiKey) { console.error(NO_KEY_MSG); process.exit(1); }
    // ping의 목적은 키·주소·모델의 실응답 확인 — 본문 유무는 묻지 않는다(추론 모델은 짧은 상한에서 content가 비는 게 정상).
    const r = await callChat(cfg, { model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 128, temperature: 0, stream: false }, 30000, { allowEmptyContent: true });
    console.log(`ok — ${r.model} 응답 수신(${r.content ? "본문" : r.reasoning ? "추론만(정상 — 상한 내)" : "빈 응답"})${r.usage ? ` tokens in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens}` : ""}`);
    return;
  }
  if (cmd === "map") {
    if (!cfg.apiKey) { console.error(NO_KEY_MSG); process.exit(1); }
    let md = "";
    try { md = fs.readFileSync(0, "utf8"); } catch { /* stdin 없음 */ }
    if (!md.trim()) { console.error("stdin으로 꾸러미(MD)를 넣어라 — 예: node scripts/scope-package.js <repo> | node bridge/deepseek-bridge.js map"); process.exit(2); }
    const r = await callChat(cfg, buildMapRequest(md, cfg.model), 4 * 60 * 1000);
    const outIdx = process.argv.indexOf("--out");
    if (outIdx > 0 && process.argv[outIdx + 1]) fs.writeFileSync(process.argv[outIdx + 1], r.content);
    process.stdout.write(r.content + "\n");
    if (r.usage) console.error(`[usage] in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens} (${r.model})`); // stderr — 지도 본문(stdout) 오염 방지
    return;
  }
  console.error("사용: node deepseek-bridge.js <ping|map> [--out <파일>]");
  process.exit(2);
}

module.exports = { resolveDeepseekConfig, buildMapRequest, DEEPSEEK_DEFAULTS };
if (require.main === module) main().catch((e) => { console.error("deepseek-bridge 실패:", (e && e.message) || e); process.exit(1); });
