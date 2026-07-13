#!/usr/bin/env node
"use strict";
// 플러그인은 작은 launcher만 배포하고 실제 정본은 VS Code 확장/install.js가 동기화한 bridge runtime을 사용한다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const runtime = path.join(process.env.CODEX_BRIDGE_HOME || path.join(os.homedir(), ".codex-bridge"), "codex-hook.js");
if (!fs.existsSync(runtime)) process.exit(0); // 런타임 미설치 프로젝트에서 다른 Codex 작업을 방해하지 않음
require(runtime);
