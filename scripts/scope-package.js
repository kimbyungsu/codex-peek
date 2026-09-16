// 얇은 래퍼 — 본체는 bridge/scope-package.js (마켓 설치본에도 배포되는 모듈 · 2026-09-16 이관). 레포 사용자 명령·require 무회귀.
const m = require(require("path").join(__dirname, "..", "bridge", "scope-package.js"));
module.exports = m;
if (require.main === module) m.cliMain();
