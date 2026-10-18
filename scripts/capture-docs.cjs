"use strict";

// 用独立浏览器和演示标签拍摄真实扩展；不读取用户正在使用的浏览器。
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require(process.env.TAB_ORBIT_PLAYWRIGHT || "playwright");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "docs", "assets");
const names = ["项目工作台", "设计灵感库", "产品路线图", "开发文档", "今日待办", "阅读清单", "团队日历", "视觉参考", "研究笔记", "交互原型", "素材收藏", "需求评审", "工作日志", "品牌规范", "数据看板", "知识空间", "创作草稿", "音乐收藏"];
const colors = ["#b4a4ff", "#83d3d4", "#eca9be", "#92afff", "#d4c29b", "#b3c6ad"];
const fixture = index => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${names[index]}</title><link rel="icon" href="/favicon-${index}.svg"><style>
*{box-sizing:border-box}body{margin:0;background:#111522;color:#e0e2ef;font-family:"Segoe UI","Microsoft YaHei",sans-serif}header{height:86px;border-bottom:1px solid #ffffff09;padding:0 64px;display:flex;align-items:center;justify-content:space-between;font-size:12px;letter-spacing:2px;color:#7f879f}.brand{color:#c6c4de;font-weight:600;letter-spacing:4px}.layout{display:grid;grid-template-columns:190px 1fr;min-height:calc(100vh - 86px)}aside{padding:52px 32px;border-right:1px solid #ffffff07;color:#667088;font-size:12px;line-height:3.4}.current{color:#bbaaf9}main{padding:72px 84px;max-width:1120px}.eyebrow{color:#a397ca;letter-spacing:2px;font-size:10px}h1{margin:18px 0 16px;font-size:44px;font-weight:550;letter-spacing:-1px;line-height:1.25}p{color:#7d859d;font-size:13px;line-height:1.9}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:64px}.card{height:200px;padding:26px;border:1px solid #ffffff0b;border-radius:17px;background:linear-gradient(140deg,#9e8df307,#ffffff01)}.tag{font-size:9px;letter-spacing:1px;color:#968cac}h3{font-size:16px;font-weight:500;color:#bfc1d3;margin:36px 0 12px}.line{height:3px;background:#ffffff08;border-radius:5px;width:70%;margin-top:11px}.line.short{width:46%}.bottom{margin-top:44px;color:#606a83;font-size:11px;display:flex;gap:22px}
</style><header><span class="brand">ORBIT / WORKSPACE</span><span>你的日常，自在切换</span></header><div class="layout"><aside><div class="current">◎　项目工作台</div><div>▦　灵感收藏</div><div>▧　项目资料</div><div>◷　阅读清单</div><div>↗　最近打开</div></aside><main><div class="eyebrow">A LITTLE LESS SEARCHING.</div><h1>把专注，留给正在做的事。</h1><p>灵感、资料和正在推进的项目，<br>都在你熟悉的位置。</p><div class="cards"><div class="card"><span class="tag">THIS WEEK</span><h3>产品路线图</h3><div class="line"></div><div class="line short"></div></div><div class="card"><span class="tag">IN PROGRESS</span><h3>交互设计</h3><div class="line"></div><div class="line short"></div></div><div class="card"><span class="tag">COLLECTION</span><h3>视觉参考</h3><div class="line"></div><div class="line short"></div></div></div><div class="bottom"><span>18 个标签已就绪</span><span>·</span><span>按住 Ctrl + 右键，下一站就在鼠标旁。</span></div></main></div></html>`;

async function waitFor(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error("等待演示界面超时。");
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const server = http.createServer((request, response) => {
    const icon = /favicon-(\d+)/.exec(request.url);
    if (icon) {
      const index = Number(icon[1]);
      const glyphs = ['<path d="M11 13h18v14H11z" fill="none" stroke="#242237" stroke-width="2.4"/><path d="M11 18h18" stroke="#242237" stroke-width="2.4"/>', '<path d="m20 9 11 11-11 11L9 20z" fill="none" stroke="#242237" stroke-width="2.6"/>', '<circle cx="20" cy="20" r="10" fill="none" stroke="#242237" stroke-width="2.6"/><path d="M20 13v7l5 4" fill="none" stroke="#242237" stroke-width="2.6"/>'];
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="${colors[index % colors.length]}"/>${glyphs[index % glyphs.length]}</svg>`);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture(Number(/tab\/(\d+)/.exec(request.url)?.[1] || 0)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(root, "test-artifacts", `docs-profile-${Date.now()}`), {
      ...(process.env.TAB_ORBIT_CHROME ? { executablePath: process.env.TAB_ORBIT_CHROME } : { channel: "chromium" }),
      headless: true, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5,
      ignoreDefaultArgs: ["--disable-extensions"], args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).hostname;
    const pages = [];
    for (let i = 0; i < names.length; i++) { const page = i === 0 && context.pages()[0] ? context.pages()[0] : await context.newPage(); await page.goto(`${base}/tab/${i}`); pages.push(page); }
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 440, height: 600 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const request = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
    const listed = await request({ type: "wheel:list-tabs" });
    for (const tab of listed.tabs.filter(tab => tab.url.startsWith(base)).slice(0, 5)) await request({ type: "wheel:toggle-tab", tabId: tab.id });
    const source = pages[0];
    const cdp = await context.newCDPSession(source);
    let shadow;
    async function read(selector) {
      if (!shadow) {
        const { root: doc } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
        const find = node => {
          const attr = node.attributes || [];
          for (let i = 0; i < attr.length; i += 2) if (attr[i] === "id" && attr[i + 1] === "__tab_orbit_extension__") return node;
          for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const hit = find(child); if (hit) return hit; }
        };
        const found = find(doc)?.shadowRoots?.[0];
        if (!found) return null;
        shadow = (await cdp.send("DOM.resolveNode", { backendNodeId: found.backendNodeId })).object.objectId;
      }
      const result = await cdp.send("Runtime.callFunctionOn", { objectId: shadow, returnByValue: true,
        functionDeclaration: "function(selector) { const n = this.querySelector(selector); if(!n)return null; const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,opacity:getComputedStyle(n).opacity}; }",
        arguments: [{ value: selector }] });
      return result.result.value;
    }
    async function open() {
      await source.bringToFront(); await source.mouse.move(850, 480); await source.keyboard.down("Control"); await source.mouse.down({ button: "right" });
      await waitFor(async () => { const value = await read(".veil"); return value && Number(value.opacity) > .98; });
    }
    async function hover(selector) {
      const b = await waitFor(() => read(selector)); await source.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
      await source.waitForTimeout(180);
    }
    async function cancel() { await source.keyboard.press("Escape"); await source.mouse.up({ button: "right" }); await source.keyboard.up("Control"); }
    await open(); await hover(".node:not(.add)");
    await source.screenshot({ path: path.join(out, "wheel-custom.png") }); await cancel();
    await popup.bringToFront(); await popup.locator("#mode-all").click();
    await waitFor(async () => (await request({ type: "wheel:get-state" })).settings.mode === "all");
    await popup.locator("#status").waitFor({ state: "hidden" });
    await popup.evaluate(() => document.querySelector("main").scrollTo(0, 0));
    await popup.screenshot({ path: path.join(out, "popup.png"), clip: { x: 0, y: 0, width: 440, height: 600 } });
    await open(); await hover('.node[data-ring="outer"]');
    await waitFor(() => read('.node[data-ring="outer"].is-selected'));
    await source.screenshot({ path: path.join(out, "wheel-double.png") }); await cancel();
    console.log(JSON.stringify({ browser: context.browser().version(), screenshots: ["wheel-custom.png", "wheel-double.png", "popup.png"], demoTabs: names.length, userData: false }, null, 2));
  } finally { if (context) await context.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
