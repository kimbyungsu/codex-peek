/*
 * Project MAP CLI(얇은 래퍼 — P0.5에서 본체가 bridge/map-runtime.js로 이관됨: VSIX가 scripts/**를 제외하므로
 * 마켓 설치본에서도 동작해야 하는 런타임은 배포 모듈에 산다. 이 파일은 개발 레포용 진입점).
 * 사용: node <브릿지 홈>/scope-map.js <repo> [inventory|init|status|render|migrate]
 */
const path = require("path");
const SELF_CMD = 'node "' + String(process.argv[1] || __filename).replace(/\\/g, "/") + '"'; // 실행 안내=실제로 부른 경로(설치본·래퍼 어느 쪽이든 그대로) — 정찰 층 이관 2026-09-16
process.exit(require(path.join(__dirname, "map-runtime.js")).runCli(process.argv[2], process.argv[3], process.argv.slice(4), { selfCmd: SELF_CMD }));
