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
// preface는 태도층 슬롯(contract-lib buildScoutPreface — 사용자 편집분·언어 반영)에서 읽음(§6-11 단일 출처화).
function buildMapRequest(pkgMd, model) {
  let preface = "너는 '탐색자'다. 아래 꾸러미가 유일한 근거다 — 꾸러미 밖 추측으로 파일을 지어내지 마라. 꾸러미 끝의 [탐색자 지시] 형식을 정확히 따르라.";
  // SCOUT_PREFACE_FIXED=1: 실측 러너(ab-retro)용 — 사용자 수정·언어를 무시하고 위 '기본 문구 원문'을 그대로 쓴다
  // (사전등록 실측(48.1%)과의 비교 안정성 — self 팔의 고정 프롬프트와 대칭. Codex 반례 2026-07-09).
  if (process.env.SCOUT_PREFACE_FIXED !== "1") {
    try { preface = require(path.join(__dirname, "contract-lib.js")).buildScoutPreface("deepseek"); } catch { /* 단독 배포 등 예외 시 기본 문구 폴백 — 지도 생성을 막지 않음 */ }
  }
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

const NO_KEY_MSG = "DeepSeek 키 없음 — 잠기는 건 'DeepSeek 비교 팔'뿐입니다(기초 탐색과 무료 self 팔 지도는 키 없이 동작: node scripts/scope-scout-self.js <repo>). 키 등록: 대시보드 ⚙️고급설정 탭 또는 DEEPSEEK_API_KEY env";

// P7(1-8) capability 판정(순수 — 테스트가 직접 실행): 정확한 JSON 객체 하나만·크기 상한 2,000자.
// 코드펜스·설명 문장 동반=실패(strict — typed 경로에 쓸 수 있는지의 실증이므로 관대 파싱 금지).
function validateCapability(txt) {
  const t = String(txt || "").trim();
  if (!t || t.length > 2000) return false;
  let o;
  try { o = JSON.parse(t); } catch { return false; }
  return !!(o && typeof o === "object" && !Array.isArray(o) && o.capability === "ok" && o.n === 7 && Object.keys(o).length === 2);
}

async function main() {
  const cmd = process.argv[2];
  const cfg = loadConfig();
  if (cmd === "ping" || cmd === "test") {
    if (!cfg.apiKey) { console.error(NO_KEY_MSG); process.exit(1); }
    // ping의 목적은 키·주소·모델의 실응답 확인 — 본문 유무는 묻지 않는다(추론 모델은 짧은 상한에서 content가 비는 게 정상).
    const r = await callChat(cfg, { model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 128, temperature: 0, stream: false }, 30000, { allowEmptyContent: true });
    // 연결 점검도 과금 대상 호출 — 비용 장부에 기록(ws 무관 전역 · contract-lib은 같은 폴더 배포, 실패는 무해)
    if (r.usage) { try { require(path.join(__dirname, "contract-lib.js")).appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "ping", model: r.model || cfg.model, usageIn: r.usage.prompt_tokens ?? null, usageOut: r.usage.completion_tokens ?? null }); } catch { /* 무해 */ } }
    console.log(`ok — ${r.model} 응답 수신(${r.content ? "본문" : r.reasoning ? "추론만(정상 — 상한 내)" : "빈 응답"})${r.usage ? ` tokens in=${r.usage.prompt_tokens} out=${r.usage.completion_tokens}` : ""}`);
    return;
  }
  if (cmd === "capability") {
    // P7(1-8) — typed capability probe: '지시대로 정확한 JSON만 내놓을 수 있는가'를 실검증(ping은 증거 아님).
    // strict validator+크기 상한+bounded repair(원격 재호출 1회) — 최대 2회 과금(UI 고지와 일치)·호출별 usage 기록.
    if (!cfg.apiKey) { console.error(NO_KEY_MSG); process.exit(1); }
    const capReq = { model: cfg.model, messages: [{ role: "user", content: '다음 JSON만 정확히 출력하라(설명·코드펜스 금지): {"capability":"ok","n":7}' }], max_tokens: 64, temperature: 0, stream: false };
    const recordUse = (r9) => { if (r9 && r9.usage) { try { require(path.join(__dirname, "contract-lib.js")).appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "capability", model: r9.model || cfg.model, usageIn: r9.usage.prompt_tokens ?? null, usageOut: r9.usage.completion_tokens ?? null }); } catch { /* 무해 */ } } };
    let r1 = await callChat(cfg, capReq, 60000, { allowEmptyContent: true });
    recordUse(r1);
    let ok = validateCapability(r1.content || "");
    if (!ok) { // bounded repair — 원격 재호출 정확히 1회
      const r2 = await callChat(cfg, { ...capReq, messages: [...capReq.messages, { role: "assistant", content: r1.content || "" }, { role: "user", content: "형식이 틀렸다. 요구한 JSON 객체만 정확히 다시 출력하라." }] }, 60000, { allowEmptyContent: true });
      recordUse(r2);
      ok = validateCapability(r2.content || "");
    }
    console.log(ok ? "capability-ok" : "capability-fail");
    process.exit(ok ? 0 : 2);
  }
  if (cmd === "enrich") {
    // P8 증분 4 — 의미 보강 typed 호출(capability 문법 동형: strict 형태 표지+bounded repair 원격 1회 —
    // 합타입·실존·근거 실증은 실행기[validateEnrichResult+quote 대조]가 수행·여기서는 'JSON 형태' 회복만).
    if (!cfg.apiKey) { console.error(NO_KEY_MSG); process.exit(1); }
    let prompt = "";
    try { prompt = fs.readFileSync(0, "utf8"); } catch { /* stdin 없음 */ }
    if (!prompt.trim()) { console.error("stdin으로 보강 프롬프트를 넣어라(enrich-providers가 조립)"); process.exit(2); }
    const shapeOk = (txt) => { try { const o = JSON.parse(txt); return !!(o && typeof o === "object" && !Array.isArray(o) && o.schema === "enrich-result-v1" && Array.isArray(o.items)); } catch { return false; } };
    const strip = (txt) => { const m = String(txt || "").match(/```(?:json)?\s*([\s\S]*?)```/); return (m ? m[1] : String(txt || "")).trim(); }; // 코드펜스 제거만(bounded 추출)
    const recordUse9 = (r9) => { if (r9 && r9.usage) { try { require(path.join(__dirname, "contract-lib.js")).appendScoutUsage({ ts: new Date().toISOString(), workspace: "", arm: "enrich", model: r9.model || cfg.model, usageIn: r9.usage.prompt_tokens ?? null, usageOut: r9.usage.completion_tokens ?? null }); } catch { /* 무해 */ } } };
    const req1 = { model: cfg.model, messages: [{ role: "user", content: prompt }], max_tokens: 4096, temperature: 0, stream: false };
    let r1 = await callChat(cfg, req1, 4 * 60 * 1000);
    recordUse9(r1);
    let body = strip(r1.content || "");
    if (!shapeOk(body)) { // bounded repair — 원격 재호출 정확히 1회
      const r2 = await callChat(cfg, { ...req1, messages: [...req1.messages, { role: "assistant", content: r1.content || "" }, { role: "user", content: "형식이 틀렸다. schema \"enrich-result-v1\"과 items 배열을 가진 JSON 객체만(설명·코드펜스 금지) 다시 출력하라." }] }, 4 * 60 * 1000);
      recordUse9(r2);
      body = strip(r2.content || "");
      if (!shapeOk(body)) { console.error("enrich-shape-fail"); process.exit(2); }
    }
    process.stdout.write(body + require("os").EOL);
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
  console.error("사용: node deepseek-bridge.js <ping|map|capability|enrich> [--out <파일>]");
  process.exit(2);
}

module.exports = { resolveDeepseekConfig, buildMapRequest, DEEPSEEK_DEFAULTS, validateCapability };
if (require.main === module) main().catch((e) => { console.error("deepseek-bridge 실패:", (e && e.message) || e); process.exit(1); });
