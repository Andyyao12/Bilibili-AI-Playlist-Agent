// 零依赖图标生成器。
//
// 直接用 node:zlib 手写 PNG 字节流，避免把二进制图片提交进仓库（不可 review、易冲突），
// 同时保证任何人 clone 后 npm run build 都能得到完整可加载的扩展。
//
// 图形：圆角方块 + 粉→青蓝渐变 + 白色播放三角，4x4 超采样做抗锯齿。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PINK = [251, 114, 153];
const BLUE = [0, 174, 236];
const WHITE = [255, 255, 255];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function insideRoundedRect(x, y, size, radius) {
  const min = 0;
  const max = size;
  if (x < min || y < min || x > max || y > max) return false;
  const r = radius;
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点是否落在播放三角内（指向右）。 */
function insidePlayTriangle(x, y, cx, cy, size) {
  const left = cx - size * 0.26;
  const right = cx + size * 0.34;
  const top = cy - size * 0.36;
  const bottom = cy + size * 0.36;
  if (x < left || x > right) return false;
  const progress = (x - left) / (right - left);
  const halfHeight = ((bottom - top) / 2) * (1 - progress);
  return y >= cy - halfHeight && y <= cy + halfHeight;
}

/** 单点采样，返回 [r, g, b, a]。 */
function sample(x, y, size) {
  if (!insideRoundedRect(x, y, size, size * 0.22)) return [0, 0, 0, 0];

  const gradientT = (x / size + y / size) / 2;
  const base = mix(PINK, BLUE, gradientT);
  if (insidePlayTriangle(x, y, size / 2, size / 2, size)) return [...WHITE, 255];
  return [...base, 255];
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const sub = 4;
  const step = 1 / sub;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          const alpha = sa / 255;
          r += sr * alpha;
          g += sg * alpha;
          b += sb * alpha;
          a += sa;
        }
      }
      const samples = sub * sub;
      const alphaOut = a / samples;
      const offset = (y * size + x) * 4;
      const weight = alphaOut > 0 ? a / 255 : 1;
      rgba[offset] = Math.round(r / weight);
      rgba[offset + 1] = Math.round(g / weight);
      rgba[offset + 2] = Math.round(b / weight);
      rgba[offset + 3] = Math.round(alphaOut);
    }
  }

  return encodePng(size, rgba);
}

export function generateIcons(outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const size of [16, 48, 128]) {
    const file = join(outDir, `icon${size}.png`);
    writeFileSync(file, renderIcon(size));
    written.push(file);
  }
  return written;
}

if (process.argv[1] && process.argv[1].endsWith('gen-icons.mjs')) {
  const target = process.argv[2] ?? join(process.cwd(), 'dist', 'icons');
  for (const file of generateIcons(target)) {
    console.log(`[icons] ${file}`);
  }
}
