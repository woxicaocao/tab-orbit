"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([bytes, data])));
  return Buffer.concat([size, bytes, data, crc]);
}
function png(size) {
  const aa = 3, s = size * aa;
  const pixels = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const nx = (x + .5) / s, ny = (y + .5) / s;
    const dx = nx - .5, dy = ny - .5, r = Math.hypot(dx, dy);
    const round = Math.hypot(Math.max(Math.abs(dx) - .28, 0), Math.max(Math.abs(dy) - .28, 0)) < .19;
    let color = round ? [28, 24, 46, 255] : [0, 0, 0, 0];
    if (Math.abs(r - .27) < .015) color = [163, 131, 233, 255];
    if (r < .067) color = [229, 215, 255, 255];
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / 5;
      const nr = Math.hypot(dx - Math.cos(angle) * .27, dy - Math.sin(angle) * .27);
      if (nr < (i === 1 ? .086 : .064)) color = i === 1 ? [221, 200, 255, 255] : [175, 146, 244, 255];
    }
    pixels.set(color, (y * s + x) * 4);
  }
  const scan = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < 4; c++) {
    let sum = 0;
    for (let a = 0; a < aa; a++) for (let b = 0; b < aa; b++) sum += pixels[(((y * aa + a) * s + x * aa + b) * 4) + c];
    scan[y * (size * 4 + 1) + 1 + x * 4 + c] = Math.round(sum / (aa * aa));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(scan)), chunk("IEND", Buffer.alloc(0))]);
}
const dir = path.resolve(__dirname, "../icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `icon${size}.png`), png(size));
console.log("已生成 16 / 32 / 48 / 128 像素轮盘图标。");
