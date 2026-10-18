"use strict";
// [2026-10-18] 수칙서·사용자 말 카드 조각이 쓰는 공용 표식 함수(rfMarks·rfArmCo·rfArmModel·rfHelpers)를 컴파일 산출물에서 그대로 꺼내
// 카드 조각 실행 앞에 붙이는 시험 도우미 — 실제 화면에서는 같은 스크립트 범위에 있는 함수들이다(대역이 아니라 실물을 붙인다).
const fs = require("fs");
const path = require("path");
let cached = null;
function rulesMarkPrelude(outSrc) {
  const src = outSrc || fs.readFileSync(path.join(__dirname, "..", "out", "extension.js"), "utf8");
  const a = src.indexOf("function rfMarks("), b = src.indexOf("function rfCuratorSrc(", a);
  if (a < 0 || b < a) throw new Error("rf prelude: 표식 함수 조각을 산출물에서 찾지 못함");
  return src.slice(a, b) + "\n";
}
module.exports = { rulesMarkPrelude, get RFP() { if (cached === null) cached = rulesMarkPrelude(); return cached; } };
