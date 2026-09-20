#!/usr/bin/env node
/**
 * 발췌 범위 옵션(묶음 3 · 사용자 결정 D3 — docs/ENRICH-NEXT-AXES-PLAN-2026-09-20.md §2-3 · 결정 D-2026-09-20-enrich-excerpt-options).
 * 자동 의미 보강이 담당에게 보내는 '파일 수'와 '파일당 글자 수'를 프로젝트(워크스페이스)별 계약 파일의 `mapExcerpt` 로 고른다.
 * 순수 계산+계약 파일 판독(경로 해석 함수는 호출자가 넘긴다 — contract-lib 순환 의존 없음). 화면(extension.ts)·실행기(map-enrich.js)·
 * 프롬프트(enrich-providers.js)가 이 한 모듈의 상수·정규화를 쓴다(복제 드리프트 금지).
 *  - 프리셋 4종(가벼움 8·2,000 / 권장 10·3,000 / 대형 15·4,000 / 최대 20·4,000) · 기본값=권장(사용자 결정 2026-09-20). 수치는 실사용 카드 측정을 보고 사용자가 조정한다.
 *  - 저장 관문(parseExcerptInput)은 상한 밖 값을 거부한다(검증 왕복 상한과 같은 관례) · 판독(normMapExcerpt)은 이형·상한 밖=미지정(기본값).
 *  - 옛 시도 기록(excerptCfg 부재)의 재검사는 옵션 도입 전 상수(LEGACY_EXCERPT_CFG)로 — 그때 실제로 보낸 발췌와 같은 규칙.
 */
"use strict";
const fs = require("fs");

const EXCERPT_FILES_MIN = 1;
const EXCERPT_FILES_MAX = 20; // 종전 상한(enrich-providers FILES_MAX)과 같은 값 — 하드 상한은 늘리지 않는다
const EXCERPT_CHARS_MIN = 500;
const EXCERPT_CHARS_MAX = 4000; // 종전 상한(enrich-providers FILE_EXCERPT_MAX)과 같은 값
const MAP_EXCERPT_PRESETS = Object.freeze([
  Object.freeze({ key: "light", files: 8, charsPerFile: 2000, ko: "가벼움", en: "Light", noteKo: "소형 저장소·비용 최소", noteEn: "small repos · lowest cost" }),
  Object.freeze({ key: "recommended", files: 10, charsPerFile: 3000, ko: "권장", en: "Recommended", noteKo: "일상 개발(기본값)", noteEn: "daily development (default)" }),
  Object.freeze({ key: "large", files: 15, charsPerFile: 4000, ko: "대형", en: "Large", noteKo: "대형 프로젝트", noteEn: "large projects" }),
  Object.freeze({ key: "max", files: 20, charsPerFile: 4000, ko: "최대", en: "Max", noteKo: "종전 상한 그대로", noteEn: "previous ceiling" }),
]);
const MAP_EXCERPT_DEFAULT = Object.freeze({ files: 10, charsPerFile: 3000 }); // 사용자 결정(2026-09-20): 기본값=권장 프리셋
const LEGACY_EXCERPT_CFG = Object.freeze({ files: 20, charsPerFile: 4000 }); // 옵션 도입 전 고정 상수 — 옛 시도 기록(excerptCfg 부재) 재검사 전용

// 닫힌 모양: 정확히 두 정수 키(files·charsPerFile)·각 범위 안. 장부 strict 검사·계약 판독·저장 관문이 같은 판정을 쓴다.
function validExcerptCfg(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== 2 || !keys.includes("files") || !keys.includes("charsPerFile")) return false;
  return Number.isInteger(x.files) && x.files >= EXCERPT_FILES_MIN && x.files <= EXCERPT_FILES_MAX
    && Number.isInteger(x.charsPerFile) && x.charsPerFile >= EXCERPT_CHARS_MIN && x.charsPerFile <= EXCERPT_CHARS_MAX;
}
// 계약 객체에서 옵션 판독 — 유효하면 사본, 아니면 null(미지정=기본값). 이형·상한 밖 값을 '비슷한 값'으로 고쳐 쓰지 않는다(조용한 변형 금지).
function normMapExcerpt(o) {
  const v = o && typeof o === "object" ? o.mapExcerpt : undefined;
  return validExcerptCfg(v) ? { files: v.files, charsPerFile: v.charsPerFile } : null;
}
// 저장 관문 입력 해석(화면·CLI 공용): 두 값 모두 정수·범위 안이어야 ok. 아니면 사유와 함께 거부(저장하지 않는다).
function parseExcerptInput(filesIn, charsIn) {
  const toInt = (v) => { if (typeof v === "number") return Number.isInteger(v) ? v : NaN; const s = String(v == null ? "" : v).trim(); return /^\d+$/.test(s) ? Number(s) : NaN; };
  const f = toInt(filesIn), c = toInt(charsIn);
  if (!Number.isInteger(f) || !Number.isInteger(c)) return { ok: false, reason: "not-integer" };
  if (f < EXCERPT_FILES_MIN || f > EXCERPT_FILES_MAX) return { ok: false, reason: "files-range" };
  if (c < EXCERPT_CHARS_MIN || c > EXCERPT_CHARS_MAX) return { ok: false, reason: "chars-range" };
  return { ok: true, cfg: { files: f, charsPerFile: c } };
}
function presetKeyFor(cfg) {
  if (!validExcerptCfg(cfg)) return null;
  const p = MAP_EXCERPT_PRESETS.find((x) => x.files === cfg.files && x.charsPerFile === cfg.charsPerFile);
  return p ? p.key : null;
}
// 실효 뷰(mapModeView 동형 — 프로젝트 '사실' 성격이라 현재 슬롯 명시값 우선·부재 시 반대 언어 슬롯 상속·그래도 없으면 기본값).
// contractFileFor(ws, slot)=계약 파일 경로 해석(contract-lib 또는 확장의 동형 함수). 판독 실패=기본값(실행을 멈추지 않는다).
function mapExcerptView(ws, slot, contractFileFor) {
  const s = slot === "en" ? "en" : "ko";
  let raw = null, source = "default";
  const readCfg = (p) => { try { return normMapExcerpt(JSON.parse(fs.readFileSync(p, "utf8"))); } catch { return null; } };
  if (ws && typeof contractFileFor === "function") {
    try { const own = readCfg(contractFileFor(ws, s)); if (own) { raw = own; source = "own"; } } catch { /* 경로 해석 실패=미지정 */ }
    if (!raw) { try { const oo = readCfg(contractFileFor(ws, s === "en" ? "ko" : "en")); if (oo) { raw = oo; source = "other"; } } catch { /* 반대 슬롯 없음 */ } }
  }
  const eff = raw ? { files: raw.files, charsPerFile: raw.charsPerFile } : { files: MAP_EXCERPT_DEFAULT.files, charsPerFile: MAP_EXCERPT_DEFAULT.charsPerFile };
  return { raw, eff, source, slot: s, presetKey: presetKeyFor(eff) };
}
// 화면·문구용 유효값(cfg 가 유효하면 사본, 아니면 기본값=권장). '저장값 없음→기본값' 판정은 mapExcerptView 한 곳(실행기 excerptCfgFor)에서만 일어난다.
function effectiveExcerptCfg(cfg) {
  if (validExcerptCfg(cfg)) return { files: cfg.files, charsPerFile: cfg.charsPerFile };
  return { files: MAP_EXCERPT_DEFAULT.files, charsPerFile: MAP_EXCERPT_DEFAULT.charsPerFile };
}
// 판독 규칙용(선정·판독·재검사·변환 — enrich-providers·map-enrich): cfg 가 유효하면 사본, 없거나 이형이면 '옵션 도입 전 상수'(하드 상한 20·4,000).
// 실행기는 항상 시도에 스냅샷한 cfg 를 넘기므로 여기 폴백은 ① 옛 시도 기록(excerptCfg 부재)의 재검사 ② cfg 없이 직접 부르는 호출(시험·도구)에만 닿는다 —
// 그때 '더 좁은 기본값'을 몰래 적용하면 옛 기록이 실제로 받은 발췌보다 좁게 재검사돼 정상 항목이 제외될 수 있어 하드 상한으로 둔다.
function cfgOrLegacy(cfg) {
  if (validExcerptCfg(cfg)) return { files: cfg.files, charsPerFile: cfg.charsPerFile };
  return { files: LEGACY_EXCERPT_CFG.files, charsPerFile: LEGACY_EXCERPT_CFG.charsPerFile };
}
const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// 사람이 읽는 한 줄(ko/en) — 카드·안내·프롬프트 자료 줄 공용. 프리셋과 일치하면 이름을 덧붙인다.
function excerptCfgText(cfg, lang) {
  const e = effectiveExcerptCfg(cfg);
  const key = presetKeyFor(e);
  const p = key ? MAP_EXCERPT_PRESETS.find((x) => x.key === key) : null;
  if (lang === "en") return "Excerpt scope: " + e.files + " files · " + fmtN(e.charsPerFile) + " chars per file" + (p ? " (" + p.en + ")" : " (custom)");
  return "발췌 범위: " + e.files + "파일 · 파일당 " + fmtN(e.charsPerFile) + "자" + (p ? "(" + p.ko + ")" : "(직접 지정)");
}

module.exports = { EXCERPT_FILES_MIN, EXCERPT_FILES_MAX, EXCERPT_CHARS_MIN, EXCERPT_CHARS_MAX, MAP_EXCERPT_PRESETS, MAP_EXCERPT_DEFAULT, LEGACY_EXCERPT_CFG, validExcerptCfg, normMapExcerpt, parseExcerptInput, presetKeyFor, mapExcerptView, effectiveExcerptCfg, cfgOrLegacy, excerptCfgText };
