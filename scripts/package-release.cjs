"use strict";

// 仅使用 Node.js 内置模块生成标准 ZIP；固定清单、顺序、时间戳和文本换行。
const fs = require("node:fs");
const path = require("node:path");
const { deflateRawSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { root, projectFile, checkExtension } = require("./check-extension.cjs");

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const records = [], directory = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes, { level: 9 });
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名，无 data descriptor。
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01，忽略本机文件 mtime。
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    records.push(local, filename, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
}

function writeOnce(filename, bytes) {
  try { fs.writeFileSync(filename, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error("发布产物必须为普通文件：" + filename);
    if (!fs.readFileSync(filename).equals(bytes)) throw new Error("拒绝覆盖不同字节的已有发布产物：" + filename);
  }
}

function packageRelease() {
  const { manifest, releaseFiles } = checkExtension({ log: false });
  const entries = releaseFiles.map(name => {
    let bytes = fs.readFileSync(projectFile(name));
    if (/\.(?:json|js|css|html|txt)$/.test(name)) bytes = Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
    return { name, bytes };
  });
  const bytes = zip(entries);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const outputDirectory = path.join(root, "release");
  fs.mkdirSync(outputDirectory, { recursive: true });
  if (fs.lstatSync(outputDirectory).isSymbolicLink()) throw new Error("发布目录不能为符号链接。");
  const basename = `tab-orbit-v${manifest.version}.zip`;
  const output = path.join(outputDirectory, basename);
  writeOnce(output, bytes);
  writeOnce(output + ".sha256", Buffer.from(`${sha256}  ${basename}\n`, "utf8"));
  console.log(`发布包：${output}\n文件数：${entries.length}；大小：${bytes.length} 字节\nSHA-256：${sha256}`);
  return { output, sha256, entries: releaseFiles, bytes: bytes.length };
}

module.exports = { packageRelease };
if (require.main === module) {
  try { packageRelease(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
