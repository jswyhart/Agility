// Generates build/icon.png (1024×1024), which electron-builder converts into
// .icns / .ico / Linux icon sets, and the MSIX logos in build/appx. Run with: npm run icon
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const N = 1024; // design size of the artwork
const SS = 3; // supersamples per axis for anti-aliasing

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// Page with a folded top-right corner.
const inPage = (x, y) => x >= 320 && x <= 736 && y >= 190 && y <= 834 && !(x > 736 - 150 + (y - 190) && y < 340);
const inFold = (x, y) => x >= 586 && y <= 340 && x - 586 <= y - 190 && x <= 736 && y >= 190;
const inLine = (x, y, x0, x1, yc) => y >= yc - 18 && y <= yc + 18 && x >= x0 - 18 && x <= x1 + 18 &&
  (x >= x0 && x <= x1 || (x - (x < x0 ? x0 : x1)) ** 2 + (y - yc) ** 2 <= 324);

function sample(x, y) {
  if (!inRoundRect(x, y, 64, 64, 960, 960, 200)) return null;
  if (inFold(x, y)) return [243, 197, 199];
  if (inPage(x, y)) {
    if (inLine(x, y, 410, 646, 470) || inLine(x, y, 410, 646, 570) || inLine(x, y, 410, 560, 670)) return [210, 58, 64];
    return [255, 255, 255];
  }
  const t = (x + y) / (2 * N);
  return [242 - t * 58, 85 - t * 47, 90 - t * 46];
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Draw the artwork `size` pixels square, centered on a width×height transparent canvas.
function render(width, height, size) {
  const px = Buffer.alloc(width * height * 4);
  const left = (width - size) / 2;
  const top = (height - size) / 2;
  const scale = N / size;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS - left) * scale, (y + (sy + 0.5) / SS - top) * scale);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (y * width + x) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (a / (SS * SS)) * 255; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const build = path.join(__dirname, '..', 'build');
fs.writeFileSync(path.join(build, 'icon.png'), render(N, N, N));

// MSIX logos at 100% and 200% display scaling. Tiles keep Windows' recommended
// margin around the artwork; the small logos fill their square.
const appx = path.join(build, 'appx');
fs.mkdirSync(appx, { recursive: true });
const logos = [['StoreLogo', 50, 50, 50], ['Square44x44Logo', 44, 44, 44], ['Square150x150Logo', 150, 150, 100], ['Wide310x150Logo', 310, 150, 100]];
for (const [name, w, h, size] of logos) {
  for (const scale of [100, 200]) {
    fs.writeFileSync(path.join(appx, `${name}.scale-${scale}.png`), render((w * scale) / 100, (h * scale) / 100, (size * scale) / 100));
  }
}
console.log(`Wrote ${build}/icon.png and ${logos.length * 2} MSIX logos`);
