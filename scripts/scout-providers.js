// 얇은 래퍼 — 본체는 bridge/scout-providers.js (마켓 설치본에도 배포되는 모듈 · 2026-09-16 이관). 레포 사용자 명령·require 무회귀.
module.exports = require(require("path").join(__dirname, "..", "bridge", "scout-providers.js"));
