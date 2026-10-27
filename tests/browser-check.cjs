"use strict";

// 真正加载 MV3 扩展，并用 Playwright 生成 isTrusted 鼠标事件。
// 使用独立 Chrome for Testing 和全新的 profile，不连接用户正在使用的 Chrome。
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const extensionDir = path.resolve(__dirname, "..");
const playwrightPath = process.argv[2] || process.env.TAB_ORBIT_PLAYWRIGHT || "playwright";
const { chromium } = require(playwrightPath);
const browserPath = process.env.TAB_ORBIT_CHROME;
const runDir = path.join(extensionDir, "test-artifacts", "run-" + new Date().toISOString().replace(/[:.]/g, "-"));
const nodeSelector = id => `.node[data-item-id="${id}"]`;
const names = ["灵感画板 · 项目 A", "设计参考 · 项目 B", "今天的待办 · 项目 C", "跨窗口工作台", "产品规划", "视觉资料库", "研究笔记", "开发文档", "音乐收藏", "项目日历", "团队空间", "阅读清单"];
const html = index => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${names[index] || "独立验证页面 " + (index + 1)}</title><link rel="icon" href="/favicon.svg"><style>
*{box-sizing:border-box}body{margin:0;padding:52px 6%;background:#101522;color:#e9ecf7;font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif}header{display:flex;justify-content:space-between;border-bottom:1px solid #ffffff16;padding-bottom:24px;letter-spacing:2px}header span{color:#a699e8;font-size:12px}main{max-width:1120px;margin:70px auto}h1{font-size:60px;letter-spacing:-2px;line-height:1.15;margin:16px 0 22px;font-weight:600}p{max-width:650px;color:#9da8c0;font-size:17px}.eyebrow{color:#a99ae6;font-size:11px;letter-spacing:3px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:40px}.card{height:180px;border:1px solid #ffffff17;border-radius:18px;padding:24px;background:linear-gradient(140deg,#7d72ad16,#111827)}.card b{display:block;font-size:36px;color:#9688c4}.card span{font-size:13px;color:#a7aec0}input{width:100%;max-width:450px;margin-top:30px;padding:14px 18px;background:#ffffff07;color:#e1def1;border:1px solid #ffffff20;border-radius:12px;font:14px system-ui}button{background:hotpink;color:green}
</style></head><body><header><strong>STUDIO / WORKSPACE</strong><span>标签轮盘 · 独立 Chrome 验证</span></header><main><div class="eyebrow">MAKE SPACE FOR YOUR IDEAS</div><h1>想去哪里，<br>一滑即达。</h1><p>按住 Ctrl 和鼠标右键，沿着圆环选择已打开的标签。鼠标悬停时放大，松开即可抵达。</p><div class="cards"><div class="card"><b>01</b><span>保持专注 / Focus</span></div><div class="card"><b>02</b><span>自由切换 / Flow</span></div><div class="card"><b>03</b><span>心有所向 / Orbit</span></div></div><input id="original-input" value="保留网页里正在编辑的原文"><input id="second-input" value="第二个输入框继续编辑"></main><script>window.fixtureEvents={rightDown:0,contextmenu:0,pointerDown:0};document.addEventListener('pointerdown',e=>{if(e.button===2){fixtureEvents.pointerDown++;e.preventDefault()}});document.addEventListener('mousedown',e=>{if(e.button===2)fixtureEvents.rightDown++});document.addEventListener('contextmenu',()=>fixtureEvents.contextmenu++);</script></body></html>`;

async function until(check, message, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(message + "；最后结果：" + JSON.stringify(last));
}

// CDP 可在开发测试中读取 closed shadow root。网页自身无法获得此对象。
// 所有交互仍使用真实 mouse/keyboard；这里的 callFunctionOn 仅查询 DOM。
const shadowSessions = new WeakMap();
async function shadowRead(page, selector, action = "count", argument) {
  let session = shadowSessions.get(page);
  if (!session) {
    session = { cdp: await page.context().newCDPSession(page), objectId: null };
    shadowSessions.set(page, session);
  }
  if (!session.objectId) {
    const { root } = await session.cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    function find(node) {
      const attributes = node.attributes || [];
      for (let i = 0; i < attributes.length; i += 2) {
        if (attributes[i] === "id" && attributes[i + 1] === "__tab_orbit_extension__") return node;
      }
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const result = find(child);
        if (result) return result;
      }
      return null;
    }
    const target = find(root)?.shadowRoots?.[0];
    if (!target) return action === "count" ? 0 : null;
    session.objectId = (await session.cdp.send("DOM.resolveNode", { backendNodeId: target.backendNodeId })).object.objectId;
  }
  const result = await session.cdp.send("Runtime.callFunctionOn", {
    objectId: session.objectId,
    functionDeclaration: `function(selector, action, argument) {
      const nodes = [...this.querySelectorAll(selector)];
      const node = nodes[0];
      const box = value => {
        const r = value.getBoundingClientRect(), badge = value.querySelector('.sequence-number');
        const badgeStyle = badge ? getComputedStyle(badge) : null, badgeBox = badge?.getBoundingClientRect();
        return { id: value.dataset.itemId, tabId: value.dataset.tabId, ring: value.dataset.ring,
          order: value.dataset.order ? Number(value.dataset.order) : null,
          sequence: badge?.textContent ?? null,
          sequenceVisible: Boolean(badge && badgeStyle.display !== 'none' && badgeStyle.visibility !== 'hidden' && badgeBox.width > 0 && badgeBox.height > 0),
          x:r.x, y:r.y, width:r.width, height:r.height };
      };
      if (action === 'count') return nodes.length;
      if (action === 'box') return node ? box(node) : null;
      if (action === 'boxes') return nodes.map(box);
      if (action === 'attribute') return node?.getAttribute(argument) ?? null;
      if (action === 'sources') return nodes.map(node => node.getAttribute('src'));
      if (action === 'text') return node?.textContent || '';
      if (action === 'scale') return node ? new DOMMatrix(getComputedStyle(node).transform).a : 0;
      if (action === 'visible') return node ? getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0 && (!node.classList.contains('veil') || Number(getComputedStyle(node).opacity) > .98) : false;
      return null;
    }`,
    arguments: [{ value: selector }, { value: action }, { value: argument ?? null }],
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
const waitShadow = (page, selector, visible = true) => until(async () => visible ? shadowRead(page, selector, "visible") : (await shadowRead(page, selector)) === 0, "Shadow DOM 状态不符合预期：" + selector);
async function clickShadow(page, selector) {
  await waitShadow(page, selector);
  const box = await shadowRead(page, selector, "box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function verifyClockwiseOrder(page, name, expectedIds, { offset = 0 } = {}) {
  await until(async () => {
    const current = await shadowRead(page, ".node", "boxes");
    return JSON.stringify(current?.filter(box => box.id !== "__add__").map(box => box.id)) === JSON.stringify(expectedIds);
  }, name + " 标签顺序未与预期原列表一致");
  const boxes = await shadowRead(page, ".node", "boxes");
  const items = boxes.filter(box => box.id !== "__add__");
  assert.deepEqual(items.map(box => box.id), expectedIds, name + " DOM 顺序应对应原列表");
  const hub = await shadowRead(page, ".hub", "box");
  assert.ok(hub, name + " 缺少圆心");
  const cx = hub.x + hub.width / 2, cy = hub.y + hub.height / 2;
  const dual = await shadowRead(page, ".veil", "attribute", "data-rings") === "2";
  const nodeGeometry = boxes.map((box, index) => {
    const ring = dual && index >= 8 ? "outer" : "inner";
    const slot = ring === "outer" ? index - 8 : index;
    const slots = dual ? ring === "inner" ? 8 : 16 : boxes.length;
    const dx = box.x + box.width / 2 - cx, dy = box.y + box.height / 2 - cy;
    const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
    const expected = slot * Math.PI * 2 / slots;
    const difference = Math.abs(Math.atan2(Math.sin(angle - expected), Math.cos(angle - expected)));
    assert.equal(box.ring, ring, name + " 前 8 个必须在内圈，之后在外圈：" + box.id);
    assert.ok(difference < .012, name + " 必须从 12 点按固定角槽顺时针排列：" + JSON.stringify({ id: box.id, angle, expected }));
    return { ...box, angle, radius: Math.hypot(dx, dy) };
  });
  for (const [index, box] of items.entries()) {
    const expectedOrder = offset + index + 1;
    assert.equal(box.order, expectedOrder, name + " 全局 data-order 序号错误");
    assert.equal(box.sequence, String(expectedOrder).padStart(2, "0"), name + " 可见编号错误");
    assert.equal(box.sequenceVisible, true, name + " 编号应真实可见");
  }
  const add = boxes.find(box => box.id === "__add__");
  if (add) {
    assert.equal(boxes.at(-1).id, "__add__", name + " 添加入口应位于最后");
    assert.equal(add.sequence, null, name + " 添加入口不参与编号");
  }
  const orderHint = await shadowRead(page, ".hub-order", "text");
  assert.match(orderHint, /顺时针/, name + " 应提供顺时针阅读提示");
  if (dual && nodeGeometry.some(box => box.ring === "outer")) assert.match(orderHint, /先内后外/, name + " 双圈应说明先内后外");
  return { dual, nodes: nodeGeometry };
}

(async () => {
  await fsp.mkdir(runDir, { recursive: true });
  const server = http.createServer((request, response) => {
    if (request.url === "/favicon.svg") {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="11" fill="#a996e5"/><circle cx="20" cy="20" r="10" fill="none" stroke="#241d43" stroke-width="3"/><circle cx="29" cy="13" r="4" fill="#f3edff"/></svg>');
      return;
    }
    const csp = "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'";
    if (request.url === "/fixture.css" || request.url === "/fixture.js") {
      const css = request.url === "/fixture.css";
      const body = html(0).match(css ? /<style>([\s\S]*?)<\/style>/ : /<script>([\s\S]*?)<\/script>/)[1];
      response.writeHead(200, { "Content-Type": css ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "Content-Security-Policy": csp });
      response.end(body);
      return;
    }
    const match = /^\/tab\/(\d+)/.exec(request.url || "");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp });
    response.end(html(match ? Number(match[1]) : 0).replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/fixture.css">').replace(/<script>[\s\S]*?<\/script>/, '<script src="/fixture.js"></script>'));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const checks = [], errors = [], layouts = [];
  const pass = text => { checks.push(text); console.log("通过：" + text); };
  let context, worker, popup, extensionId;
  let failure;
  try {
    context = await chromium.launchPersistentContext(path.join(runDir, "profile"), {
      ...(browserPath ? { executablePath: browserPath } : { channel: "chromium" }),
      headless: process.env.TAB_ORBIT_HEADLESS !== "false",
      viewport: { width: 1440, height: 1000 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--no-first-run", "--no-default-browser-check"]
    });
    context.on("page", page => page.on("pageerror", error => errors.push({ url: page.url(), message: error.message })));
    worker = context.serviceWorkers().find(value => value.url().includes("background.js")) || await context.waitForEvent("serviceworker", { timeout: 20000 });
    extensionId = new URL(worker.url()).hostname;
    console.log("浏览器：" + context.browser().version() + "；扩展：" + extensionId);
    popup = await context.newPage();
    await popup.setViewportSize({ width: 460, height: 940 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator("#wheel-count").waitFor();
    const request = (type, data = {}) => popup.evaluate(async message => chrome.runtime.sendMessage(message), { type, ...data });
    const getState = () => request("wheel:get-state");
    const getItems = async () => (await getState()).items;
    async function setPopupMode(mode) {
      await popup.bringToFront();
      await popup.locator(`#mode-${mode}`).click();
      await until(async () => (await getState()).settings.mode === mode, "弹窗切换模式未保存");
      await until(async () => await popup.locator(`#mode-${mode}`).getAttribute("aria-pressed") === "true", "弹窗模式高亮未更新");
    }
    const getTab = async page => {
      const result = await request("wheel:list-tabs");
      return result.tabs.find(tab => tab.url === page.url());
    };
    const browserTabsOrdered = preferredWindowId => worker.evaluate(async preferredWindowId => {
      const tabs = await chrome.tabs.query({});
      const protocols = new Set(["http:", "https:", "file:", "chrome:", "about:"]);
      return tabs.filter(tab => {
        try { return Number.isInteger(tab.id) && protocols.has(new URL(tab.url || tab.pendingUrl || "").protocol); }
        catch { return false; }
      }).sort((a, b) => Number(b.windowId === preferredWindowId) - Number(a.windowId === preferredWindowId) || a.windowId - b.windowId || a.index - b.index || a.id - b.id)
        .map(tab => ({ id: tab.id, windowId: tab.windowId, index: tab.index }));
    }, preferredWindowId);
    const pageA = await context.newPage(); await pageA.goto(base + "/tab/0");
    const pageB = await context.newPage(); await pageB.goto(base + "/tab/1");
    const pageC = await context.newPage(); await pageC.goto(base + "/tab/2");
    const tabA = await getTab(pageA), tabB = await getTab(pageB), tabC = await getTab(pageC);
    assert.ok(tabA && tabB && tabC);
    const activeIn = windowId => worker.evaluate(async windowId => (await chrome.tabs.query({ active: true, windowId }))[0]?.id, windowId);
    const sameActive = async expected => until(async () => await activeIn(expected.windowId) === expected.id, "未切换至预期标签");
    async function openWheel(page, position = { x: 720, y: 480 }) {
      await page.bringToFront();
      await page.keyboard.down("Control");
      await page.mouse.move(position.x, position.y);
      await page.mouse.down({ button: "right" });
      await waitShadow(page, ".veil");
    }
    async function moveTo(page, selector) {
      await waitShadow(page, selector);
      const box = await shadowRead(page, selector, "box");
      assert.ok(box, "目标应可见：" + selector);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      return box;
    }
    async function release(page) {
      await page.mouse.up({ button: "right" });
      await page.keyboard.up("Control");
      await waitShadow(page, ".veil", false);
    }
    async function cancel(page) {
      await page.keyboard.press("Escape");
      await page.mouse.up({ button: "right" });
      await page.keyboard.up("Control");
      await waitShadow(page, ".veil", false);
    }
    const original = () => pageA.evaluate(() => ({ value: document.querySelector("#original-input").value, background: getComputedStyle(document.body).backgroundColor, h1: getComputedStyle(document.querySelector("h1")).fontSize, color: getComputedStyle(document.querySelector("#original-input")).color }));
    const originalSnapshot = await original();
    await pageA.bringToFront();
    await pageA.mouse.click(700, 450, { button: "right" });
    assert.equal(await shadowRead(pageA, ".veil"), 0);
    assert.equal(await pageA.evaluate(() => fixtureEvents.contextmenu), 1);
    assert.equal(await pageA.evaluate(() => fixtureEvents.pointerDown), 1, "网页阻止 pointerdown 默认行为的处理器已运行");
    const normalEvents = await pageA.evaluate(() => ({ ...fixtureEvents }));
    await pageA.keyboard.press("Escape");
    pass("普通右键保留网页原菜单事件，只有 Ctrl + 右键触发轮盘");

    assert.equal((await getState()).settings.mode, "custom");
    await setPopupMode("all");
    const automatic = await getState();
    assert.deepEqual(automatic.items, [], "所有标签模式不需要提前收藏");
    assert.ok(automatic.wheelItems.length >= 3);
    await openWheel(pageA);
    await until(async () => await shadowRead(pageA, ".node") === automatic.wheelItems.length, "所有标签未自动出现在轮盘");
    assert.equal(await shadowRead(pageA, ".veil", "attribute", "data-mode"), "all");
    assert.equal(await shadowRead(pageA, ".veil", "attribute", "data-rings"), "1", "少量标签使用单圈");
    assert.equal(await shadowRead(pageA, '.node[data-ring="outer"]'), 0);
    assert.equal(await shadowRead(pageA, nodeSelector("__add__")), 0);
    assert.deepEqual(automatic.wheelItems.map(item => item.tabId), (await browserTabsOrdered(tabA.windowId)).map(tab => tab.id));
    await verifyClockwiseOrder(pageA, "少量所有标签", automatic.wheelItems.map(item => item.id));
    await pageA.screenshot({ path: path.join(runDir, "wheel-all-initial.png") });
    await cancel(pageA);
    await setPopupMode("custom");
    pass("弹窗切换两种模式；所有标签无需收藏自动呈现，切回自定义仍保持空收藏");

    await openWheel(pageA);
    assert.equal(await shadowRead(pageA, ".node"), 1);
    assert.equal(await pageA.evaluate(() => document.querySelector("#__tab_orbit_extension__").shadowRoot), null);
    assert.equal(await shadowRead(pageA, ".veil", "visible"), true);
    assert.ok((await shadowRead(pageA, ".node", "box")).width > 60, "严格 CSP 页面仍应获得扩展 Shadow 样式");
    await moveTo(pageA, nodeSelector("__add__"));
    await release(pageA);
    await waitShadow(pageA, ".manager-veil");
    await waitShadow(pageA, `.tab-row[aria-label="添加：${names[1]}"]`);
    await clickShadow(pageA, `.tab-row[aria-label="添加：${names[1]}"]`);
    await until(async () => (await getItems()).length === 1, "页面内添加未保存");
    await waitShadow(pageA, `.tab-row[aria-pressed="true"][aria-label="移除：${names[1]}"]`);
    await pageA.screenshot({ path: path.join(runDir, "manager.png") });
    await clickShadow(pageA, '[aria-label="关闭标签管理"]');
    const itemB = (await getItems())[0];
    assert.equal(itemB.tabId, tabB.id);
    pass("严格 CSP 页面可见并可操作；closed Shadow DOM 不向网页暴露标签；空轮盘内添加保存成功");

    await openWheel(pageA);
    await moveTo(pageA, nodeSelector(itemB.id));
    await waitShadow(pageA, nodeSelector(itemB.id) + ".is-selected");
    await until(async () => (await shadowRead(pageA, nodeSelector(itemB.id), "scale")) > 1.16, "悬停标签没有放大");
    await pageA.screenshot({ path: path.join(runDir, "wheel-hover.png") });
    assert.equal(await activeIn(tabA.windowId), tabA.id, "按住时不能提前切换");
    await release(pageA);
    await sameActive(tabB);
    assert.deepEqual(await pageA.evaluate(() => ({ ...fixtureEvents })), normalEvents, "轮盘手势不应泄漏为网页原有 pointer/mouse/contextmenu 事件");
    pass("真实 Ctrl + 右键悬停放大，按住不切换，松开右键切至目标标签");
    pass("网页 pointerdown.preventDefault 不妨碍轮盘，且原网页处理器不会收到轮盘手势");

    await pageA.bringToFront();
    await pageA.locator("#original-input").click();
    await openWheel(pageA);
    await moveTo(pageA, nodeSelector("__add__"));
    await release(pageA);
    await waitShadow(pageA, ".manager-veil");
    await clickShadow(pageA, '[aria-label="关闭标签管理"]');
    assert.equal(await pageA.evaluate(() => document.activeElement.id), "original-input", "关闭管理后恢复最初焦点");
    await pageA.locator("#second-input").click();
    await openWheel(pageA);
    await cancel(pageA);
    assert.equal(await pageA.evaluate(() => document.activeElement.id), "second-input", "普通轮盘取消不应恢复之前管理弹层记住的旧输入框");
    pass("关闭管理后恢复输入焦点；后来在第二输入框按 Esc 取消不会跳回旧焦点");

    await openWheel(pageA);
    await moveTo(pageA, nodeSelector(itemB.id));
    await moveTo(pageA, ".hub");
    await release(pageA);
    await sameActive(tabA);
    assert.equal(await shadowRead(pageA, ".manager-veil"), 0);
    await openWheel(pageA);
    await moveTo(pageA, nodeSelector(itemB.id));
    await cancel(pageA);
    await sameActive(tabA);
    pass("移回圆心或按 Esc 取消，不激活已悬停的标签");

    await openWheel(pageA);
    await moveTo(pageA, nodeSelector(itemB.id));
    assert.equal((await request("wheel:set-mode", { mode: "all" })).ok, true);
    await waitShadow(pageA, ".veil", false);
    await release(pageA);
    await sameActive(tabA);
    await setPopupMode("custom");
    assert.equal((await getItems())[0].id, itemB.id);
    pass("按住右键悬停时模式发生变化会取消当前手势，松开不误切且自定义收藏保留");

    assert.equal((await request("wheel:toggle-tab", { tabId: tabC.id })).ok, true);
    await until(async () => (await getItems()).length === 2, "外部收藏未保存");
    await openWheel(pageA);
    await until(async () => await shadowRead(pageA, ".node") === 3, "storage 更新未同步轮盘");
    await cancel(pageA);
    await openWheel(pageA, { x: 100, y: 500 });
    await release(pageA);
    await sameActive(tabA);
    assert.equal(await shadowRead(pageA, ".manager-veil"), 0);
    assert.deepEqual(await original(), originalSnapshot);
    pass("storage 更新同步到网页；边缘原地按下松开安全取消；输入原文和网页样式不变");

    await popup.bringToFront();
    await popup.locator("#search").fill("项目 C");
    await popup.locator("#open-tabs .tab-row").filter({ hasText: names[2] }).waitFor();
    assert.equal(await popup.locator("#open-tabs .tab-row").count(), 1);
    const beforeMove = await getItems();
    await popup.getByRole("button", { name: `将「${names[2]}」往前移`, exact: true }).click();
    await until(async () => (await getItems())[0].tabId === tabC.id, "弹窗排序未保存");
    await popup.locator("#wheel-items").getByRole("button", { name: `从轮盘移除「${names[2]}」`, exact: true }).click();
    await until(async () => (await getItems()).length === beforeMove.length - 1, "弹窗移除未保存");
    await popup.locator("#search").fill("");
    await until(async () => await popup.locator("#status").isHidden(), "等待弹窗临时提示消失");
    await popup.screenshot({ path: path.join(runDir, "popup.png"), clip: { x: 0, y: 0, width: 440, height: 600 } });
    const popupDimensions = await popup.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(popupDimensions.scrollWidth <= popupDimensions.width);
    pass("管理弹窗真实加载，搜索、排序、移除可用且没有横向溢出");

    const localIcon = await request("wheel:get-icon", { tabId: tabA.id });
    assert.equal(localIcon.ok, true);
    assert.match(localIcon.dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual([...Buffer.from(localIcon.dataUrl.split(",")[1], "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    pass("真实 Chrome 本地 favicon 接口返回 PNG 图标数据");

    const crossWindow = await worker.evaluate(async url => {
      const result = await chrome.windows.create({ url, focused: false, type: "normal", width: 1000, height: 800 });
      return { windowId: result.id, tabId: result.tabs[0].id };
    }, base + "/tab/3");
    await until(async () => (await request("wheel:list-tabs")).tabs.some(tab => tab.id === crossWindow.tabId), "第二窗口未出现");
    const crossResult = await request("wheel:toggle-tab", { tabId: crossWindow.tabId });
    assert.equal(crossResult.ok, true);
    const crossItem = crossResult.items.find(item => item.tabId === crossWindow.tabId);
    await openWheel(pageA);
    await moveTo(pageA, nodeSelector(crossItem.id));
    await release(pageA);
    await sameActive({ id: crossWindow.tabId, windowId: crossWindow.windowId });
    const focused = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
    assert.equal(focused, crossWindow.windowId);
    pass("跨窗口轮盘选择激活目标标签，并将目标 Chrome 窗口置前");

    // 填满自定义轮盘，核验内八外十六以及窄窗口/边缘的位置可达性。
    const extraPages = [];
    for (let i = 4; i < 24; i++) {
      const page = await context.newPage(); await page.goto(base + "/tab/" + i); extraPages.push(page);
    }
    const orderSnapshots = new Map();
    for (const page of [pageA, pageC, ...extraPages]) {
      const target = await getTab(page);
      const result = await request("wheel:toggle-tab", { tabId: target.id });
      assert.equal(result.ok, true);
      if ([9, 12].includes(result.items.length)) {
        await openWheel(pageA);
        await until(async () => await shadowRead(pageA, ".node") === result.items.length + 1, "中间数量的双圈未刷新");
        const snapshot = await verifyClockwiseOrder(pageA, `${result.items.length} 个自定义标签`, result.items.map(item => item.id));
        assert.equal(await shadowRead(pageA, '.node[data-ring="inner"]'), 8);
        assert.equal(await shadowRead(pageA, '.node[data-ring="outer"]'), result.items.length + 1 - 8);
        orderSnapshots.set(result.items.length, snapshot);
        layouts.push({ name: `${result.items.length} 标签顺序`, ...snapshot });
        await pageA.screenshot({ path: path.join(runDir, `wheel-order-${result.items.length}.png`) });
        await cancel(pageA);
      }
    }
    assert.equal((await getItems()).length, 24);
    const customSaved = (await getItems()).map(item => ({ id: item.id, tabId: item.tabId }));
    await openWheel(pageA);
    await until(async () => await shadowRead(pageA, ".node") === 24, "24 个收藏应完整显示");
    assert.equal(await shadowRead(pageA, nodeSelector("__add__")), 0, "满 24 收藏时隐藏添加入口");
    assert.equal(await shadowRead(pageA, '.node[data-ring="inner"]'), 8);
    assert.equal(await shadowRead(pageA, '.node[data-ring="outer"]'), 16);
    const fullOrder = await verifyClockwiseOrder(pageA, "24 个自定义标签", customSaved.map(item => item.id));
    for (const [count, snapshot] of orderSnapshots) {
      for (const previous of snapshot.nodes.filter(node => node.id !== "__add__")) {
        const current = fullOrder.nodes.find(node => node.id === previous.id);
        assert.ok(current);
        assert.equal(current.ring, previous.ring, `从 ${count} 增至 24 时不能移圈`);
        const delta = current.angle - previous.angle;
        assert.ok(Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) < .0001, `从 ${count} 增至 24 时不能改变已有标签的角槽`);
      }
    }
    assert.equal(orderSnapshots.size, 2);
    pass("9、12、24 个自定义标签固定前 8 在内圈，余下在外圈；各圈从 12 点按序顺时针且已有槽位不跳动");
    await pageA.screenshot({ path: path.join(runDir, "wheel-twentyfour.png") });
    await moveTo(pageA, nodeSelector(itemB.id));
    await until(async () => (await shadowRead(pageA, nodeSelector(itemB.id), "scale")) > 1.13, "双圈预览悬停放大未完成");
    await until(async () => (await shadowRead(pageA, ".node img")) > 0, "轮盘没有收到本地 PNG 图标");
    assert.ok((await shadowRead(pageA, ".node img", "sources")).every(src => src.startsWith("data:image/png;base64,")), "轮盘图标只显示后台本地 PNG 数据");
    await pageA.screenshot({ path: path.join(runDir, "wheel-double-ring-preview.png") });
    await moveTo(pageA, ".hub");
    async function verifyGeometry(page, name, expectedCount = 24) {
      const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const boxes = await shadowRead(page, ".node", "boxes");
      assert.equal(boxes.length, expectedCount);
      for (const box of boxes) {
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= dimensions.width + 1 && box.y + box.height <= dimensions.height + 1, name + " 节点越界：" + JSON.stringify(box));
      }
      // 使用真实 mousemove 逐个悬停，不用 dispatchEvent 跳过手势判断。
      for (const box of boxes) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        assert.equal(await shadowRead(page, nodeSelector(box.id), "attribute", "aria-current"), "true", name + " 节点不可选：" + box.id);
      }
      layouts.push({ name, dimensions, boxes });
    }
    await verifyGeometry(pageA, "24 自定义标签双圈");
    await cancel(pageA);
    await pageA.setViewportSize({ width: 640, height: 720 });
    await openWheel(pageA, { x: 320, y: 340 });
    await verifyGeometry(pageA, "窄窗口");
    await pageA.screenshot({ path: path.join(runDir, "wheel-narrow.png") });
    await cancel(pageA);
    await openWheel(pageA, { x: 625, y: 705 });
    await verifyGeometry(pageA, "右下角呼出");
    await pageA.screenshot({ path: path.join(runDir, "wheel-edge.png") });
    await cancel(pageA);
    await pageA.setViewportSize({ width: 1440, height: 1000 });
    await sameActive(tabA);
    pass("24 自定义标签以内 8 外 16 双圈显示，完整/窄窗口/右下角呼出均可逐个真实悬停选中");

    for (const ring of ["inner", "outer"]) {
      await openWheel(pageA);
      const boxes = await shadowRead(pageA, `.node[data-ring="${ring}"]`, "boxes");
      const target = boxes.find(box => Number(box.tabId) !== tabA.id);
      assert.ok(target, ring + " 环应有可切换的物理标签");
      const item = (await getItems()).find(item => item.id === target.id);
      assert.ok(item);
      await moveTo(pageA, nodeSelector(target.id));
      assert.equal(await shadowRead(pageA, nodeSelector(target.id), "attribute", "aria-current"), "true");
      await release(pageA);
      await sameActive({ id: item.tabId, windowId: item.windowId });
    }
    pass("双圈的内环和外环都能真实悬停并在松开右键后切到精确标签");

    // 创建超过一页的全部标签，但不将这些新页面加入自定义收藏。
    for (let i = 24; i < 32; i++) {
      const page = await context.newPage(); await page.goto(base + "/tab/" + i);
    }
    await setPopupMode("all");
    const beforeDrag = await browserTabsOrdered(tabA.windowId);
    const dragged = beforeDrag.filter(tab => tab.windowId === tabA.windowId && tab.id !== tabA.id).at(-1);
    assert.ok(dragged);
    await worker.evaluate(async tabId => chrome.tabs.move(tabId, { index: 0 }), dragged.id);
    const afterDrag = await browserTabsOrdered(tabA.windowId);
    assert.equal(afterDrag[0].id, dragged.id, "真实浏览器标签应已经移到最左侧");
    assert.notDeepEqual(afterDrag.map(tab => tab.id), beforeDrag.map(tab => tab.id));
    await openWheel(pageA);
    const reordered = await getState();
    assert.deepEqual(reordered.wheelItems.map(item => item.tabId), afterDrag.map(tab => tab.id));
    await verifyClockwiseOrder(pageA, "真实标签拖动后的所有模式", reordered.wheelItems.slice(0, 24).map(item => item.id));
    await pageA.screenshot({ path: path.join(runDir, "wheel-browser-order.png") });
    await cancel(pageA);
    await pageB.bringToFront();
    assert.deepEqual((await getState()).wheelItems.map(item => item.tabId), afterDrag.map(tab => tab.id), "切换 active 页面不能改成最近使用顺序");
    pass("真实 chrome.tabs.move 改变浏览器 index 后，所有标签从左到右顺时针呈现，active 变化不改成最近使用顺序");

    await setPopupMode("custom");
    assert.deepEqual((await getItems()).map(item => ({ id: item.id, tabId: item.tabId })), customSaved);
    await openWheel(pageA);
    await verifyClockwiseOrder(pageA, "浏览器拖动后的自定义模式", customSaved.map(item => item.id));
    await cancel(pageA);
    pass("真实浏览器拖动标签后，自定义仍保持用户的收藏顺序和顺时针编号");
    await setPopupMode("all");

    const crossPage = await until(async () => context.pages().find(page => page.url() === base + "/tab/3"), "跨窗口测试页面不可用");
    await openWheel(crossPage);
    const crossExpected = await browserTabsOrdered(crossWindow.windowId);
    const crossState = await getState();
    // popup 没有 sender.tab；这里只借用其全量 item ID 映射，实际窗口顺序读取 crossPage。
    const crossItemsByTab = new Map(crossState.wheelItems.map(item => [item.tabId, item.id]));
    const crossVisibleTabs = crossExpected.slice(0, 24).map(tab => tab.id);
    await until(async () => {
      const nodes = await shadowRead(crossPage, ".node", "boxes");
      return JSON.stringify(nodes?.map(node => Number(node.tabId))) === JSON.stringify(crossVisibleTabs);
    }, "跨窗口轮盘节点未按呼出页面所在窗口的浏览器 index 排列");
    assert.deepEqual((await shadowRead(crossPage, ".node", "boxes")).map(node => Number(node.tabId)), crossVisibleTabs);
    assert.equal(crossExpected[0].windowId, crossWindow.windowId);
    const crossVisibleItems = crossVisibleTabs.map(tabId => {
      assert.ok(crossItemsByTab.has(tabId), "跨窗口标签应存在于全量映射中");
      return crossItemsByTab.get(tabId);
    });
    await verifyClockwiseOrder(crossPage, "另一窗口呼出的所有模式", crossVisibleItems);
    await cancel(crossPage);
    pass("从另一浏览器窗口呼出时优先该窗口，窗口内仍按浏览器 index 顺时针");
    await popup.bringToFront();
    const allState = await getState();
    const pageCount = Math.ceil(allState.wheelItems.length / 24);
    assert.ok(allState.totalTabs > 24);
    assert.equal(allState.wheelItems.length, allState.totalTabs, "所有标签模式应返回所有标签，不能截断到 24");
    assert.deepEqual(allState.items.map(item => ({ id: item.id, tabId: item.tabId })), customSaved);
    await openWheel(pageA);
    await until(async () => await shadowRead(pageA, ".veil", "attribute", "data-mode") === "all", "轮盘模式未更新为所有标签");
    assert.equal(await shadowRead(pageA, ".node"), 24);
    assert.equal(await shadowRead(pageA, '.node[data-ring="inner"]'), 8);
    assert.equal(await shadowRead(pageA, '.node[data-ring="outer"]'), 16);
    assert.equal(await shadowRead(pageA, ".veil", "attribute", "data-page"), "1");
    assert.equal(await shadowRead(pageA, ".veil", "attribute", "data-pages"), String(pageCount));
    await verifyClockwiseOrder(pageA, "所有标签第一页", allState.wheelItems.slice(0, 24).map(item => item.id));
    const firstPage = await shadowRead(pageA, ".node", "boxes");
    await moveTo(pageA, nodeSelector(firstPage[0].id));
    const cursor = await shadowRead(pageA, nodeSelector(firstPage[0].id), "box");
    await pageA.mouse.wheel(0, 620);
    await until(async () => await shadowRead(pageA, ".veil", "attribute", "data-page") === "2", "右键按住时滚轮未翻页");
    assert.equal(await shadowRead(pageA, ".node.is-selected"), 0, "翻页之后必须清空旧选中项");
    await pageA.mouse.move(cursor.x + cursor.width / 2 + 3, cursor.y + cursor.height / 2);
    assert.equal(await shadowRead(pageA, ".node.is-selected"), 0, "翻页后不足 6 像素的微移不能选中不同标签");
    await release(pageA);
    await sameActive(tabA);
    pass("所有标签超过 24 时可按住右键滚轮翻页；原地或微移后松手安全取消");

    await openWheel(pageA);
    for (let number = 2; number <= pageCount; number++) {
      await pageA.mouse.wheel(0, 620);
      await until(async () => await shadowRead(pageA, ".veil", "attribute", "data-page") === String(number), "未到达最后一页标签");
    }
    const lastPage = await shadowRead(pageA, ".node", "boxes");
    assert.deepEqual(lastPage.map(box => box.id), allState.wheelItems.slice((pageCount - 1) * 24).map(item => item.id));
    await verifyClockwiseOrder(pageA, "所有标签最后一页", allState.wheelItems.slice((pageCount - 1) * 24).map(item => item.id), { offset: (pageCount - 1) * 24 });
    await verifyGeometry(pageA, "所有标签最后一页", lastPage.length);
    await pageA.screenshot({ path: path.join(runDir, "wheel-all-last-page.png") });
    const lastTarget = allState.wheelItems.at(-1);
    await moveTo(pageA, nodeSelector(lastTarget.id));
    assert.equal(await shadowRead(pageA, nodeSelector(lastTarget.id), "attribute", "aria-current"), "true");
    await release(pageA);
    await sameActive({ id: lastTarget.tabId, windowId: lastTarget.windowId });
    pass("所有标签模式能到达最后一页，并真实悬停松手切换到最后一个标签");

    await setPopupMode("custom");
    assert.deepEqual((await getItems()).map(item => ({ id: item.id, tabId: item.tabId })), customSaved);
    await openWheel(pageA);
    assert.equal(await shadowRead(pageA, ".veil", "attribute", "data-mode"), "custom");
    assert.equal(await shadowRead(pageA, ".node"), 24);
    await cancel(pageA);
    pass("所有标签模式浏览与分页后切回自定义，原 24 个收藏及顺序完整保留");

    await pageB.close();
    await until(async () => (await getItems()).find(item => item.id === itemB.id)?.available === false, "关闭标签状态未更新");
    const failed = await request("wheel:activate", { itemId: itemB.id });
    assert.equal(failed.ok, false);
    const restored = await context.newPage(); await restored.goto(base + "/tab/1");
    await until(async () => (await getItems()).find(item => item.id === itemB.id)?.available === true, "同网址重新打开后未恢复");
    pass("关闭标签后显示不可用，重新打开相同网址自动恢复已有轮盘位置");
    assert.deepEqual(errors, []);
    pass("测试网页、扩展管理页均无未捕获 JavaScript 异常");
  } catch (error) {
    failure = { name: error.name, message: error.message, stack: error.stack };
    if (context) {
      for (const [index, page] of context.pages().entries()) {
        if (page.isClosed()) continue;
        try { await page.screenshot({ path: path.join(runDir, `failure-${index}.png`) }); } catch { /* 保留已有诊断。 */ }
      }
    }
    throw error;
  } finally {
    const report = { browserPath, version: context?.browser()?.version(), extensionId, passed: !failure, checks, errors, layouts, failure, note: "使用独立 Chrome for Testing 完整加载 MV3 扩展；真实鼠标键盘事件；本地模拟网页。popup 作为扩展页面加载，浏览器工具栏气泡的原生焦点/高度行为需人工验收。profile 保留用于排查。" };
    await fsp.writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    console.log("测试产物：" + runDir);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
