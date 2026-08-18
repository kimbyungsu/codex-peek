#!/usr/bin/env node
"use strict";
/*
 * 설계 경위 색인 후보 나열(docs/MAP-PROVENANCE-DESIGN.md §1) — 결정 표지 헤더를 후보로만
 * 출력한다. 색인 등재는 사람이 확정(자동 승격 없음 — 요지 재서술 오염 방지).
 */
const fs = require("fs");
const path = require("path");
const ROOT = process.argv[2] || path.resolve(__dirname, "..");
const MARK = /(개정|확정|폐기|지시 부기|사용자 지시|결정)/;
const rows = [];
for (const name of fs.readdirSync(path.join(ROOT, "docs"))) {
  if (!name.endsWith(".md") || name === "DECISIONS.md") continue;
  const f = path.join(ROOT, "docs", name);
  let lines; try { lines = fs.readFileSync(f, "utf8").split(/\r?\n/); } catch { continue; }
  lines.forEach((ln, i) => { if (/^#{2,4} /.test(ln) && MARK.test(ln)) rows.push("docs/" + name + ":" + (i + 1) + "  " + ln.replace(/^#+\s*/, "")); });
}
if (require.main === module) {
  console.log("결정 표지 후보 " + rows.length + "건 — 색인 등재는 docs/DECISIONS.md에 사람이 확정:");
  for (const r of rows) console.log("  " + r);
}
module.exports = { scan: () => rows };
