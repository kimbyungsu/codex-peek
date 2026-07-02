/*
 * 확장 아이콘 생성기 — 외부 라이브러리 없이(node 내장 zlib) 256x256 PNG를 그린다.
 * 디자인: 어두운 바탕 라운드 사각 + 왼쪽 주황 원(Claude) ⇄ 오른쪽 흰 링(Codex) + 양방향 화살표(브릿지).
 * 4x 슈퍼샘플링으로 부드러운 경계. 산출물: docs/icon.png (package.json "icon"이 참조 → vsix·마켓 타일).
 * 사용: node scripts/make-icon.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256, S = 4, W = SIZE * S; // 논리 256, 슈퍼샘플 1024

// ── 색 ──
const BG = [16, 20, 32, 255];        // 어두운 남색 바탕
const ORANGE = [233, 123, 58, 255];  // Claude 주황
const WHITE = [237, 239, 244, 255];  // Codex 링
const ARROW = [159, 176, 198, 255];  // 브릿지 화살표(회청)

// ── 도형 판정(논리 좌표) ──
function inRoundRect(x, y) { // 전체 캔버스 라운드 사각(r=48)
  const r = 48, w = 256, h = 256;
  const cx = Math.max(r, Math.min(w - r, x)), cy = Math.max(r, Math.min(h - r, y));
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r) ? (x >= 0 && x <= w && y >= 0 && y <= h && ((x >= r && x <= w - r) || (y >= r && y <= h - r) || dx * dx + dy * dy <= r * r)) : false;
}
const dist2 = (x, y, cx, cy) => (x - cx) * (x - cx) + (y - cy) * (y - cy);
function inCircle(x, y, cx, cy, r) { return dist2(x, y, cx, cy) <= r * r; }
function inRing(x, y, cx, cy, rOut, rIn) { const d = dist2(x, y, cx, cy); return d <= rOut * rOut && d >= rIn * rIn; }
function inRect(x, y, x0, y0, x1, y1) { return x >= x0 && x <= x1 && y >= y0 && y <= y1; }
function inTriRight(x, y, tipX, tipY, baseX, half) { // 오른쪽을 가리키는 삼각형(밑변 baseX, 꼭짓점 tipX>baseX)
  if (x < baseX || x > tipX) return false;
  const t = (tipX - x) / (tipX - baseX); // tip에서 1→0
  return Math.abs(y - tipY) <= half * t;
}
function inTriLeft(x, y, tipX, tipY, baseX, half) { // 왼쪽을 가리키는 삼각형(tipX<baseX)
  if (x > baseX || x < tipX) return false;
  const t = (x - tipX) / (baseX - tipX);
  return Math.abs(y - tipY) <= half * t;
}

function colorAt(px, py) { // 논리 좌표(실수) → 색
  if (!inRoundRect(px, py)) return [0, 0, 0, 0]; // 모서리 밖 투명
  // 왼쪽 Claude 원 (70,128) r26
  if (inCircle(px, py, 70, 128, 26)) return ORANGE;
  // 오른쪽 Codex 링 (186,128) 바깥26/안16
  if (inRing(px, py, 186, 128, 26, 16)) return WHITE;
  // 위 화살표(→): 샤프트 x100..142 y112..120, 머리 tip(156,116) 밑변142 반높이10
  if (inRect(px, py, 100, 112, 142, 120) || inTriRight(px, py, 156, 116, 142, 10)) return ARROW;
  // 아래 화살표(←): 샤프트 x114..156 y136..144, 머리 tip(100,140) 밑변114 반높이10
  if (inRect(px, py, 114, 136, 156, 144) || inTriLeft(px, py, 100, 140, 114, 10)) return ARROW;
  return BG;
}

// ── 렌더(슈퍼샘플 → 다운샘플) ──
const img = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = colorAt(x + (sx + 0.5) / S, y + (sy + 0.5) / S);
      r += c[0]; g += c[1]; b += c[2]; a += c[3];
    }
    const n = S * S, i = (y * SIZE + x) * 4;
    img[i] = Math.round(r / n); img[i + 1] = Math.round(g / n); img[i + 2] = Math.round(b / n); img[i + 3] = Math.round(a / n);
  }
}

// ── PNG 인코딩(내장 zlib) ──
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) { raw[y * (SIZE * 4 + 1)] = 0; img.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "docs", "icon.png");
fs.writeFileSync(out, png);
console.log("아이콘 생성:", out, png.length, "bytes");
