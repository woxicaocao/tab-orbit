"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const RELEASE_FILES = Object.freeze([
  "manifest.json", "background.js", "content.js", "popup.html", "popup.css", "popup.js",
  "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png", "INSTALL.txt"
].sort());

function projectFile(relative) {
  assert.equal(typeof relative, "string", "资源路径必须为字符串");
  assert.ok(relative && !relative.includes("\\") && !relative.includes("\0"), "资源路径必须使用项目内的正斜杠路径");
  const absolute = path.resolve(root, relative);
  const within = path.relative(root, absolute);
  assert.ok(within && !within.startsWith(".." + path.sep) && within !== ".." && !path.isAbsolute(within), "资源不能指向项目目录之外：" + relative);
  let current = root;
  for (const part of relative.split("/")) {
    assert.ok(part && part !== "." && part !== "..", "非法资源路径：" + relative);
    assert.ok(fs.readdirSync(current).includes(part), "缺少资源或文件名大小写不匹配：" + relative);
    current = path.join(current, part);
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, "不接受符号链接资源：" + relative);
  }
  assert.ok(fs.statSync(absolute).isFile(), "资源必须为文件：" + relative);
  return absolute;
}

function checkExtension({ log = true } = {}) {
  const manifest = JSON.parse(fs.readFileSync(projectFile("manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(projectFile("package.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, "扩展必须使用 Manifest V3");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\.\d+)?$/, "扩展版本号格式错误");
  assert.equal(pkg.version, manifest.version, "package.json 与 manifest.json 版本必须一致");
  assert.deepEqual([...manifest.permissions].sort(), ["favicon", "storage", "tabs"], "请确认扩展权限变化后再调整验证规则");
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.equal(manifest.action?.default_popup, "popup.html");
  assert.equal(manifest.host_permissions, undefined, "扩展不需要单独的 host_permissions");
  assert.equal(manifest.externally_connectable, undefined, "扩展不开放外部消息入口");

  const references = new Set(["manifest.json", "background.js", "popup.html"]);
  for (const section of manifest.content_scripts || []) {
    assert.ok(Array.isArray(section.matches) && section.matches.length, "内容脚本必须声明匹配范围");
    assert.equal(section.all_frames, false, "轮盘仅在页面顶层注入");
    for (const file of [...(section.js || []), ...(section.css || [])]) references.add(file);
  }
  for (const icons of [manifest.icons, manifest.action.default_icon]) {
    for (const [size, relative] of Object.entries(icons || {})) {
      references.add(relative);
      const bytes = fs.readFileSync(projectFile(relative));
      assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "图标必须为有效 PNG：" + relative);
      assert.equal(bytes.readUInt32BE(16), Number(size), "PNG 图标宽度错误：" + relative);
      assert.equal(bytes.readUInt32BE(20), Number(size), "PNG 图标高度错误：" + relative);
    }
  }
  const html = fs.readFileSync(projectFile("popup.html"), "utf8");
  assert.doesNotMatch(html, /<script\b[^>]*>\s*[^<\s]/i, "弹窗脚本必须使用外部文件");
  assert.doesNotMatch(html, /\son\w+\s*=/i, "弹窗不得使用内联事件处理器");
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const resource = match[1];
    if (resource.startsWith("#")) continue;
    assert.doesNotMatch(resource, /^(?:[a-z][a-z\d+.-]*:|\/\/)/i, "弹窗只能引用本地资源：" + resource);
    references.add(resource);
  }
  for (const relative of references) {
    assert.ok(RELEASE_FILES.includes(relative), "运行资源未加入明确的发布清单：" + relative);
    projectFile(relative);
  }
  for (const relative of RELEASE_FILES) projectFile(relative);

  const scripts = new Set(["background.js", "content.js", "popup.js"]);
  for (const directory of ["scripts", "tests"]) {
    for (const file of fs.readdirSync(path.join(root, directory))) {
      if (/\.(?:cjs|js|mjs)$/.test(file)) scripts.add(directory + "/" + file);
    }
  }
  for (const relative of scripts) {
    const result = spawnSync(process.execPath, ["--check", projectFile(relative)], { encoding: "utf8" });
    assert.equal(result.status, 0, "JavaScript 语法检查失败：" + relative + "\n" + (result.stderr || result.error || ""));
  }
  if (log) console.log(`验证通过：Manifest V3 ${manifest.version}，${references.size} 个运行资源，${scripts.size} 个 JavaScript 文件。`);
  return { manifest, releaseFiles: [...RELEASE_FILES] };
}

module.exports = { root, projectFile, checkExtension, RELEASE_FILES };
if (require.main === module) {
  try { checkExtension(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
