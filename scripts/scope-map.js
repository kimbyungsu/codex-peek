/*
 * Project MAP CLI(얇은 래퍼 — P0.5에서 본체가 bridge/map-runtime.js로 이관됨: VSIX가 scripts/**를 제외하므로
 * 마켓 설치본에서도 동작해야 하는 런타임은 배포 모듈에 산다. 이 파일은 개발 레포용 진입점).
 * 사용: node scripts/scope-map.js <repo> [inventory|init|status|render|migrate]
 */
const path = require("path");
process.exit(require(path.join(__dirname, "..", "bridge", "map-runtime.js")).runCli(process.argv[2], process.argv[3], process.argv.slice(4)));
