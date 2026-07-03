/*
 * logo-to-icon.js — 로고→아이콘 변환의 '가짜 투명(구워진 체크무늬) 보정'을 고정한다.
 * 실제 커밋된 원본(docs/logo.png, RGB·체크무늬 구움)을 임시 출력으로 변환해:
 *  ① 네 모서리 alpha=0(진짜 투명) ② 중앙 alpha=255(본문 보존) ③ 256x256 RGBA 를 확인.
 */
const os = require("os"), path = require("path"), fs = require("fs"), zlib = require("zlib"), cp = require("child_process");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } }

const root = path.join(__dirname, "..");
const src = path.join(root, "docs", "logo.png");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "icon_")), "icon.png");
const r = cp.spawnSync(process.execPath, [path.join(root, "scripts", "logo-to-icon.js"), src, out], { encoding: "utf8", timeout: 120000 });
ok(r.status === 0, "변환 스크립트 exit 0");
ok(fs.existsSync(out), "출력 파일 생성");

// PNG 디코드(테스트 자체 검증용 최소 디코더)
const b = fs.readFileSync(out);
let pos = 8, W = 0, H = 0, ct = 0, idat = [];
while (pos < b.length) {
  const len = b.readUInt32BE(pos), t = b.toString("ascii", pos + 4, pos + 8);
  const d = b.slice(pos + 8, pos + 8 + len);
  if (t === "IHDR") { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
  else if (t === "IDAT") idat.push(d); else if (t === "IEND") break;
  pos += 12 + len;
}
ok(W === 256 && H === 256 && ct === 6, "256x256 RGBA");
const bpp = 4, raw = zlib.inflateSync(Buffer.concat(idat)), stride = W * bpp, px = Buffer.alloc(W * H * bpp);
const paeth = (a, b2, c) => { const p = a + b2 - c, pa = Math.abs(p - a), pb = Math.abs(p - b2), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c; };
for (let y = 0; y < H; y++) {
  const f = raw[y * (stride + 1)], row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const o = px.slice(y * stride, (y + 1) * stride), prev = y > 0 ? px.slice((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const l = i >= bpp ? o[i - bpp] : 0, u = prev ? prev[i] : 0, ul = prev && i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    if (f === 1) v += l; else if (f === 2) v += u; else if (f === 3) v += (l + u) >> 1; else if (f === 4) v += paeth(l, u, ul);
    o[i] = v & 0xff;
  }
}
const A = (x, y) => px[(y * W + x) * 4 + 3];
ok(A(3, 3) === 0 && A(252, 3) === 0 && A(3, 252) === 0 && A(252, 252) === 0, "네 모서리 진짜 투명(alpha 0) — 구워진 체크무늬 제거");
ok(A(128, 128) === 255, "중앙 본문 불투명 보존");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
