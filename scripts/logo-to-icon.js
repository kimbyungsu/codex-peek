/*
 * 로고 → 확장 아이콘 변환기 — 외부 라이브러리 없이(내장 zlib) PNG를 읽어 256x256으로 박스 평균 축소해 docs/icon.png 생성.
 * 지원: 8bit RGB(colortype 2)/RGBA(colortype 6), 비인터레이스. (사용자 확정 로고 원본 = docs/logo.png)
 * '가짜 투명' 보정: 이미지 생성기가 투명 표시용 체크무늬를 실제 픽셀로 구워낸 RGB 원본이면(모서리가 무채색 밝은 체크),
 *   첫 행에서 라운드 반경을 측정해 라운드 사각 '밖'을 진짜 투명(alpha 0)으로 마스킹한다(다운샘플 평균으로 가장자리 자연스러움).
 * 사용: node scripts/logo-to-icon.js [원본경로] [출력경로]   (기본: docs/logo.png → docs/icon.png)
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SRC = process.argv[2] || path.join(__dirname, "..", "docs", "logo.png");
const OUT = process.argv[3] || path.join(__dirname, "..", "docs", "icon.png");
const SIZE = 256;

// ── PNG 디코드(청크 파싱 → inflate → 필터 역적용) ──
const buf = fs.readFileSync(SRC);
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("PNG 아님");
let pos = 8, W = 0, H = 0, colorType = 0, idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8);
  const data = buf.slice(pos + 8, pos + 8 + len);
  if (type === "IHDR") {
    W = data.readUInt32BE(0); H = data.readUInt32BE(4);
    const bitDepth = data[8]; colorType = data[9];
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error(`미지원 PNG 형식(depth=${bitDepth}, color=${colorType}, interlace=${data[12]})`);
  } else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  pos += 12 + len;
}
const bpp = colorType === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = W * bpp;
const px = Buffer.alloc(W * H * bpp);
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
for (let y = 0; y < H; y++) {
  const f = raw[y * (stride + 1)];
  const row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const out = px.slice(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.slice((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const left = i >= bpp ? out[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const ul = prev && i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    if (f === 1) v += left; else if (f === 2) v += up; else if (f === 3) v += (left + up) >> 1; else if (f === 4) v += paeth(left, up, ul);
    out[i] = v & 0xff;
  }
}

// ── '구워진 체크무늬'(가짜 투명) → 진짜 투명 보정 ──
// 이미지 생성기가 투명 표시용 체크무늬를 실제 픽셀로 구운 RGB 원본 대응: 테두리에서 시작해 '무채색 밝은' 픽셀만 타고
// 번지는 채우기(flood fill)로 바깥 체크영역을 투명 처리. 크림색 본문(R-B 노란기)·색 요소에서 멈추므로 그림 내부는 안전.
const isChecker = (r, g, b) => Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && r > 175;
function pxAt(x, y) { const i = (y * W + x) * bpp; return [px[i], px[i + 1], px[i + 2]]; }
let alphaArr = null; // null=보정 없음, Uint8Array(W*H)=픽셀별 알파
{
  const corner = isChecker(...pxAt(2, 2)) || isChecker(...pxAt(W - 3, 2)) || isChecker(...pxAt(2, H - 3)) || isChecker(...pxAt(W - 3, H - 3));
  if (corner) {
    alphaArr = new Uint8Array(W * H).fill(255);
    const visited = new Uint8Array(W * H);
    const stack = [];
    const push = (x, y) => {
      const idx = y * W + x;
      if (visited[idx]) return;
      visited[idx] = 1;
      if (isChecker(...pxAt(x, y))) { alphaArr[idx] = 0; stack.push(idx); }
    };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (stack.length) {
      const idx = stack.pop(); const x = idx % W, y = (idx / W) | 0;
      if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1);
    }
    let cnt = 0; for (let i = 0; i < alphaArr.length; i++) if (alphaArr[i] === 0) cnt++;
    console.log(`가짜 투명(체크무늬) 감지 → 테두리 연결 ${cnt}px 투명 처리`);
  }
}

// ── 박스 평균 축소(임의 비율) → 256 RGBA ──
const img = Buffer.alloc(SIZE * SIZE * 4);
for (let ty = 0; ty < SIZE; ty++) {
  const y0 = Math.floor(ty * H / SIZE), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * H / SIZE));
  for (let tx = 0; tx < SIZE; tx++) {
    const x0 = Math.floor(tx * W / SIZE), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * W / SIZE));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * bpp;
      const av = alphaArr ? alphaArr[y * W + x] : (bpp === 4 ? px[i + 3] : 255);
      if (av > 0) { r += px[i]; g += px[i + 1]; b += px[i + 2]; } // 투명 픽셀 색은 평균에 안 섞음(가장자리 회색띠 방지)
      a += av; n++;
    }
    const o = (ty * SIZE + tx) * 4;
    if (a === 0) { img[o] = 0; img[o + 1] = 0; img[o + 2] = 0; img[o + 3] = 0; continue; }
    const nOpq = Math.max(1, Math.round(a / 255)); // 색 평균 분모 = 불투명 픽셀 수(투명 픽셀 색을 안 섞음)
    img[o] = Math.round(r / nOpq); img[o + 1] = Math.round(g / nOpq); img[o + 2] = Math.round(b / nOpq); img[o + 3] = Math.round(a / n);
  }
}

// ── PNG 인코딩(make-icon.js와 동일 방식) ──
function crc32(bf) {
  let c, table = crc32.table;
  if (!table) { table = crc32.table = new Int32Array(256); for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } }
  c = 0xffffffff;
  for (let i = 0; i < bf.length; i++) c = table[(c ^ bf[i]) & 0xff] ^ (c >>> 8);
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
ihdr[8] = 8; ihdr[9] = 6;
const scan = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) { scan[y * (SIZE * 4 + 1)] = 0; img.copy(scan, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(scan, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]));
console.log(`아이콘 생성: ${OUT} (원본 ${W}x${H} → ${SIZE}x${SIZE})`);
