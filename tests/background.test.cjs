"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const tab = (id, extra = {}) => ({ id, windowId: 1, title: `标签 ${id}`, url: `https://example.test/${id}`, active: false, ...extra });
const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const iconResponse = (bytes = pngBytes, extra = {}) => ({
  ok: true, headers: { get: () => String(bytes.length) },
  async arrayBuffer() { return Uint8Array.from(bytes).buffer; }, ...extra
});
function event() {
  return { listeners: [], addListener(listener) { this.listeners.push(listener); }, fire(...args) { this.listeners.forEach(listener => listener(...args)); } };
}

// 直接执行分发版 service worker；仅 Chrome API 在内存中模拟。
function browser(options = {}) {
  const local = structuredClone(options.local || {});
  const session = structuredClone(options.session || {});
  const tabs = new Map((options.tabs || []).map(value => [value.id, structuredClone(value)]));
  const calls = { tabUpdates: [], windowUpdates: [], creates: [], warnings: [], iconFetches: [], tabMessages: [], runtimeMessages: [] };
  let rejectStorage = false;
  const area = data => ({
    async get(keys) {
      if (rejectStorage) { rejectStorage = false; throw new Error("模拟存储不可用"); }
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      return Object.fromEntries((keys || Object.keys(data)).map(key => [key, structuredClone(data[key])]));
    },
    async set(update) { await nextTurn(); Object.assign(data, structuredClone(update)); }
  });
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id: "tab-orbit-test", getURL: relative => "chrome-extension://tab-orbit-test/" + relative.replace(/^\//, ""),
      onMessage: event(), onInstalled: event(), onStartup: event(),
      async sendMessage(message) { calls.runtimeMessages.push(plain(message)); }
    },
    tabs: {
      onUpdated: event(), onRemoved: event(), onCreated: event(), onAttached: event(), onReplaced: event(), onMoved: event(), onDetached: event(), onActivated: event(),
      async query() { await nextTurn(); return [...tabs.values()].map(value => structuredClone(value)); },
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab with id " + id);
        return structuredClone(tabs.get(id));
      },
      async update(id, update) {
        if (options.failUpdate || !tabs.has(id)) throw new Error("No tab with id " + id);
        calls.tabUpdates.push({ id, ...plain(update) });
        Object.assign(tabs.get(id), plain(update));
        return structuredClone(tabs.get(id));
      },
      async create(details) { calls.creates.push(details); throw new Error("测试禁止新建标签"); },
      async sendMessage(id, message) { calls.tabMessages.push({ id, message: plain(message) }); }
    },
    windows: {
      async getLastFocused() { return { id: options.windowId || 1 }; },
      async update(id, update) {
        if (options.failWindow) throw new Error("No window with id " + id);
        calls.windowUpdates.push({ id, ...plain(update) });
      }
    }
  };
  const sender = { id: chrome.runtime.id, tab: { id: 1000, windowId: options.windowId || 1 } };
  const boot = () => {
    const context = vm.createContext({
      chrome, URL, crypto: { randomUUID }, AbortController, setTimeout, clearTimeout,
      btoa: value => Buffer.from(value, "binary").toString("base64"),
      fetch: async (url, request) => {
        calls.iconFetches.push(url);
        return options.fetchHook ? options.fetchHook(url, request, calls.iconFetches.length) : iconResponse();
      },
      console: { warn: (...args) => calls.warnings.push(args) }
    });
    vm.runInContext(source, context, { filename: "background.js" });
    const listener = chrome.runtime.onMessage.listeners.at(-1);
    return {
      send(type, fields = {}, origin = sender) {
        return new Promise((resolve, reject) => {
          try {
            const open = listener({ type, ...fields }, origin, value => resolve(plain(value)));
            if (open !== true) resolve({ ignored: true });
          } catch (error) { reject(error); }
        });
      }
    };
  };
  return { local, session, tabs, calls, chrome, sender, boot, rejectNextStorage() { rejectStorage = true; } };
}

test("首次使用为空，不擅自收藏或打开任何标签", async () => {
  const env = browser({ tabs: [tab(1)] });
  const response = await env.boot().send("wheel:get-state");
  assert.equal(response.ok, true);
  assert.deepEqual(response.items, []);
  assert.equal(response.maxItems, 24);
  assert.equal(response.settings.mode, "custom");
  assert.deepEqual(response.wheelItems, []);
  assert.deepEqual(env.calls.tabUpdates, []);
  assert.deepEqual(env.calls.creates, []);
});

test("收藏已打开标签后持久化；再次点选同一标签会移除", async () => {
  const env = browser({ tabs: [tab(1, { title: '<img src=x onerror=alert(1)> 中文', favIconUrl: "javascript:alert(1)" })] });
  const worker = env.boot();
  const added = await worker.send("wheel:toggle-tab", { tabId: 1 });
  assert.equal(added.ok, true);
  assert.equal(added.items.length, 1);
  assert.equal(added.items[0].title, '<img src=x onerror=alert(1)> 中文');
  assert.equal(added.items[0].favIconUrl, "");
  assert.equal(added.items[0].available, true);
  assert.equal(env.local.wheelItems[0].sessionId, env.session.wheelSessionId);
  assert.equal("sessionId" in added.items[0], false);
  assert.equal((await worker.send("wheel:toggle-tab", { tabId: 1 })).items.length, 0);
});

test("并发添加不会互相覆盖，并严格限制最多 24 个收藏", async () => {
  const env = browser({ tabs: Array.from({ length: 29 }, (_, i) => tab(i + 1)) });
  const worker = env.boot();
  const results = await Promise.all(Array.from({ length: 29 }, (_, i) => worker.send("wheel:toggle-tab", { tabId: i + 1 })));
  assert.equal(results.filter(result => result.ok).length, 24);
  assert.equal(results.filter(result => !result.ok).length, 5);
  assert.match(results.find(result => !result.ok).error, /24/);
  assert.equal(env.local.wheelItems.length, 24);
  assert.equal(new Set(env.local.wheelItems.map(item => item.id)).size, 24);
  assert.deepEqual(env.local.wheelItems.map(item => item.tabId), Array.from({ length: 24 }, (_, i) => i + 1));
});

test("已满时仍可移除收藏，再添加新标签", async () => {
  const env = browser({ tabs: Array.from({ length: 25 }, (_, i) => tab(i + 1)) });
  const worker = env.boot();
  for (let id = 1; id <= 24; id++) await worker.send("wheel:toggle-tab", { tabId: id });
  assert.equal((await worker.send("wheel:toggle-tab", { tabId: 25 })).ok, false);
  assert.equal((await worker.send("wheel:toggle-tab", { tabId: 6 })).items.length, 23);
  const response = await worker.send("wheel:toggle-tab", { tabId: 25 });
  assert.equal(response.items.length, 24);
  assert.equal(response.items.at(-1).tabId, 25);
});

test("收藏顺序移动、边界保持和按 ID 删除正确持久化", async () => {
  const env = browser({ tabs: [tab(1), tab(2), tab(3)] });
  const worker = env.boot();
  let response;
  for (let id = 1; id <= 3; id++) response = await worker.send("wheel:toggle-tab", { tabId: id });
  const [a, b, c] = response.items;
  response = await worker.send("wheel:move-item", { itemId: c.id, direction: "up" });
  assert.deepEqual(response.items.map(item => item.id), [a.id, c.id, b.id]);
  response = await worker.send("wheel:move-item", { itemId: a.id, direction: "up" });
  assert.deepEqual(response.items.map(item => item.id), [a.id, c.id, b.id]);
  response = await worker.send("wheel:move-item", { itemId: a.id, direction: "down" });
  assert.deepEqual(response.items.map(item => item.id), [c.id, a.id, b.id]);
  response = await worker.send("wheel:remove-item", { itemId: a.id });
  assert.deepEqual(response.items.map(item => item.id), [c.id, b.id]);
  assert.deepEqual(env.local.wheelItems.map(item => item.id), [c.id, b.id]);
});

test("标签在原标签页内导航或更名，收藏随之更新而不指向同网址的另一个页", async () => {
  const env = browser({ tabs: [tab(1), tab(2, { url: tab(1).url })] });
  const worker = env.boot();
  const saved = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items[0];
  Object.assign(env.tabs.get(1), { url: "https://example.test/new", title: "新标题", windowId: 8 });
  env.chrome.tabs.onUpdated.fire(1, { title: "新标题", url: "https://example.test/new" });
  const state = await worker.send("wheel:get-state");
  assert.equal(state.items[0].id, saved.id);
  assert.equal(state.items[0].tabId, 1);
  assert.equal(state.items[0].title, "新标题");
  assert.equal(state.items[0].windowId, 8);
  assert.equal(state.items[0].url, "https://example.test/new");
});

test("service worker 重建后仍保持同一会话的标签身份", async () => {
  const env = browser({ tabs: [tab(1)] });
  const saved = (await env.boot().send("wheel:toggle-tab", { tabId: 1 })).items[0];
  env.tabs.get(1).url = "https://example.test/after-navigation";
  const state = await env.boot().send("wheel:get-state");
  assert.equal(state.items[0].id, saved.id);
  assert.equal(state.items[0].tabId, 1);
  assert.equal(state.items[0].url, "https://example.test/after-navigation");
});

test("浏览器会话重启后的 tab ID 复用不会切到错误网站", async () => {
  const old = browser({ tabs: [tab(1)] });
  const saved = (await old.boot().send("wheel:toggle-tab", { tabId: 1 })).items[0];
  const restored = browser({ local: old.local, tabs: [tab(1, { url: "https://other.test/" }), tab(7, { url: tab(1).url })] });
  const worker = restored.boot();
  const state = await worker.send("wheel:get-state");
  assert.equal(state.items[0].id, saved.id);
  assert.equal(state.items[0].tabId, 7);
  assert.equal((await worker.send("wheel:activate", { itemId: saved.id })).ok, true);
  assert.deepEqual(restored.calls.tabUpdates, [{ id: 7, active: true }]);
});

test("关闭的收藏保留为不可用，激活不创建页面；重新打开原网址后恢复", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  const item = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items[0];
  env.tabs.delete(1);
  env.chrome.tabs.onRemoved.fire(1, { windowId: 1 });
  let state = await worker.send("wheel:get-state");
  assert.equal(state.items[0].available, false);
  assert.equal(state.items[0].tabId, null);
  assert.equal((await worker.send("wheel:activate", { itemId: item.id })).ok, false);
  assert.deepEqual(env.calls.tabUpdates, []);
  assert.deepEqual(env.calls.creates, []);
  env.tabs.set(55, tab(55, { url: item.url }));
  env.chrome.tabs.onCreated.fire(env.tabs.get(55));
  state = await worker.send("wheel:get-state");
  assert.equal(state.items[0].id, item.id);
  assert.equal(state.items[0].tabId, 55);
  assert.equal(state.items[0].available, true);
});

test("同一网址的两个已收藏标签保持独立，关闭一个不会重复占用另一个", async () => {
  const env = browser({ tabs: [tab(1), tab(2, { url: tab(1).url })] });
  const worker = env.boot();
  await worker.send("wheel:toggle-tab", { tabId: 1 });
  await worker.send("wheel:toggle-tab", { tabId: 2 });
  env.tabs.delete(1);
  const state = await worker.send("wheel:get-state");
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].available, false);
  assert.equal(state.items[1].tabId, 2);
  assert.equal(state.items[1].available, true);
});

test("跨窗口切换会激活精确标签并将目标窗口置前", async () => {
  const env = browser({ tabs: [tab(1, { windowId: 99 })] });
  const worker = env.boot();
  const item = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items[0];
  assert.equal((await worker.send("wheel:activate", { itemId: item.id })).ok, true);
  assert.deepEqual(env.calls.tabUpdates, [{ id: 1, active: true }]);
  assert.deepEqual(env.calls.windowUpdates, [{ id: 99, focused: true }]);
  assert.deepEqual(env.calls.creates, []);
});

test("标签刚关闭或窗口不可用时给出可读失败，后续操作仍可完成", async () => {
  for (const failure of ["failUpdate", "failWindow"]) {
    const env = browser({ tabs: [tab(1)], [failure]: true });
    const worker = env.boot();
    const item = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items[0];
    const result = await worker.send("wheel:activate", { itemId: item.id });
    assert.equal(result.ok, false);
    assert.match(result.error, /关闭|不可用/);
    assert.equal((await worker.send("wheel:get-state")).ok, true);
  }
});

test("列表包含所有窗口，并正确标记当前窗口与过滤不可收藏页面", async () => {
  const env = browser({ tabs: [tab(1), tab(2, { windowId: 2 }), tab(3, { url: "javascript:alert(1)" }), tab(4, { url: "chrome-extension://other/popup.html" })] });
  const worker = env.boot();
  const result = await worker.send("wheel:list-tabs");
  assert.deepEqual(result.tabs.map(value => [value.id, value.currentWindow]), [[1, true], [2, false]]);
  const popupResult = await worker.send("wheel:list-tabs", {}, { id: env.chrome.runtime.id });
  assert.equal(popupResult.tabs[0].currentWindow, true);
  assert.equal((await worker.send("wheel:toggle-tab", { tabId: 3 })).ok, false);
  assert.equal((await worker.send("wheel:toggle-tab", { tabId: "1" })).ok, false);
});

test("拒绝来自外部扩展的消息，且不接管其他消息命名空间", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  assert.deepEqual(await worker.send("wheel:toggle-tab", { tabId: 1 }, { id: "other-extension" }), { ignored: true });
  assert.deepEqual(await worker.send("unrelated:message"), { ignored: true });
  assert.equal(env.local.wheelItems, undefined);
});

test("异常和恶意的存储记录被清理，重复收藏 ID 修复且不超过 24 条", async () => {
  const items = [null, {}, { id: "unsafe", url: "javascript:alert(1)" }, ...Array.from({ length: 29 }, (_, i) => ({ id: "same-id", url: `https://example.test/${i}`, title: "x".repeat(600), favIconUrl: "data:image/png;base64,x", tabId: "1" }))];
  const env = browser({ local: { wheelItems: items } });
  const result = await env.boot().send("wheel:get-state");
  assert.equal(result.items.length, 24);
  assert.equal(new Set(result.items.map(item => item.id)).size, 24);
  assert.ok(result.items.every(item => item.title.length <= 500 && item.favIconUrl === "" && item.tabId === null));
});

test("Chrome prerender 替换标签 ID 后仍追踪替换后的具体页面", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  const item = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items[0];
  env.tabs.delete(1);
  env.tabs.set(20, tab(20, { url: "https://example.test/prerendered" }));
  env.chrome.tabs.onReplaced.fire(20, 1);
  const result = await worker.send("wheel:get-state");
  assert.equal(result.items[0].id, item.id);
  assert.equal(result.items[0].tabId, 20);
  assert.equal(result.items[0].url, "https://example.test/prerendered");
});

test("一次存储故障不会堵塞后台后续消息队列", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  env.rejectNextStorage();
  const failed = await worker.send("wheel:get-state");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /存储/);
  assert.equal((await worker.send("wheel:toggle-tab", { tabId: 1 })).ok, true);
});

test("图标仅从 Chrome 扩展本地 favicon 接口读取，相同 URL 并发与后续请求复用缓存", async () => {
  const env = browser({ tabs: [tab(1, { favIconUrl: "https://tracking.test/icon.png" }), tab(2, { url: tab(1).url })] });
  const worker = env.boot();
  const results = await Promise.all([worker.send("wheel:get-icon", { tabId: 1 }), worker.send("wheel:get-icon", { tabId: 2 })]);
  assert.equal(results[0].dataUrl, "data:image/png;base64," + Buffer.from(pngBytes).toString("base64"));
  assert.deepEqual(results[1], results[0]);
  assert.equal(env.calls.iconFetches.length, 1);
  const endpoint = new URL(env.calls.iconFetches[0]);
  assert.equal(endpoint.origin, "null"); // Node URL 对 chrome-extension scheme 没有 Web origin。
  assert.equal(endpoint.protocol, "chrome-extension:");
  assert.equal(endpoint.hostname, env.chrome.runtime.id);
  assert.equal(endpoint.pathname, "/_favicon/");
  assert.equal(endpoint.searchParams.get("pageUrl"), tab(1).url);
  await worker.send("wheel:get-icon", { tabId: 1 });
  assert.equal(env.calls.iconFetches.length, 1);
  assert.equal(env.local.wheelItems, undefined, "图标不写入持久化收藏数据");
});

test("危险网页、关闭标签和非整数 ID 的图标请求安全返回空值且不 fetch", async () => {
  const env = browser({ tabs: [tab(1, { url: "javascript:alert(1)" }), tab(2, { url: "chrome-extension://other/private.html" })] });
  const worker = env.boot();
  for (const id of [1, 2, 999, -1, "1", null]) assert.deepEqual(await worker.send("wheel:get-icon", { tabId: id }), { ok: true, dataUrl: "" });
  assert.deepEqual(env.calls.iconFetches, []);
});

test("图标响应必须是受大小限制的 PNG，HTTP 失败和恶意 HTML 均降级为空值", async () => {
  const largePng = new Uint8Array(100 * 1024); largePng.set(pngBytes);
  const responses = [
    iconResponse(pngBytes, { ok: false }),
    iconResponse(Buffer.from("<svg onload=alert(1)>")),
    iconResponse(pngBytes, { headers: { get: () => "9999999" } }),
    iconResponse(new Uint8Array(140 * 1024), { headers: { get: () => null } }),
    iconResponse(largePng) // 原始文件低于限制，但编码后的 data URL 超限。
  ];
  for (const response of responses) {
    const env = browser({ tabs: [tab(1)], fetchHook: () => response });
    assert.deepEqual(await env.boot().send("wheel:get-icon", { tabId: 1 }), { ok: true, dataUrl: "" });
  }
});

test("图标读取失败不污染缓存，下次请求可重试成功", async () => {
  const env = browser({ tabs: [tab(1)], fetchHook: (_url, _request, count) => {
    if (count === 1) throw new Error("缓存暂未就绪");
    return iconResponse();
  } });
  const worker = env.boot();
  assert.equal((await worker.send("wheel:get-icon", { tabId: 1 })).dataUrl, "");
  assert.match((await worker.send("wheel:get-icon", { tabId: 1 })).dataUrl, /^data:image\/png;base64,/);
  assert.equal(env.calls.iconFetches.length, 2);
});

test("缓慢图标读取不会阻塞轮盘的标签激活消息", async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const env = browser({ tabs: [tab(1)], fetchHook: () => response });
  const worker = env.boot();
  const item = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items[0];
  const icon = worker.send("wheel:get-icon", { tabId: 1 });
  let deadline;
  try {
    const activate = worker.send("wheel:activate", { itemId: item.id });
    const result = await Promise.race([activate, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("图标阻塞标签激活")), 500); })]);
    assert.equal(result.ok, true);
    assert.deepEqual(env.calls.tabUpdates, [{ id: 1, active: true }]);
  } finally { clearTimeout(deadline); finish(iconResponse()); await icon; }
});

test("标签 favicon 变更会使本地图标缓存失效并重新读取", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  await worker.send("wheel:get-icon", { tabId: 1 });
  env.chrome.tabs.onUpdated.fire(1, { favIconUrl: "https://example.test/new.png" }, env.tabs.get(1));
  await worker.send("wheel:get-icon", { tabId: 1 });
  assert.equal(env.calls.iconFetches.length, 2);
});

test("旧版收藏默认继续使用自定义模式，原 ID 和排列不变", async () => {
  const legacy = Array.from({ length: 12 }, (_, index) => ({ id: `legacy-${index}`, url: tab(index + 1).url, title: `旧收藏 ${index}`, tabId: index + 1 }));
  const env = browser({ local: { wheelItems: legacy, wheelSettings: { otherPreference: "保留" } }, tabs: Array.from({ length: 15 }, (_, i) => tab(i + 1)) });
  const result = await env.boot().send("wheel:get-state");
  assert.equal(result.settings.mode, "custom");
  assert.equal(result.totalTabs, 15);
  assert.deepEqual(result.items.map(item => item.id), legacy.map(item => item.id));
  assert.deepEqual(result.wheelItems, result.items);
  assert.equal(result.settings.otherPreference, "保留");
});

test("切换所有标签和自定义模式会持久化，并保持旧收藏独立且顺序完整", async () => {
  const env = browser({ tabs: [tab(1), tab(2), tab(3)], local: { wheelSettings: { otherPreference: 8 } } });
  const worker = env.boot();
  await worker.send("wheel:toggle-tab", { tabId: 2 });
  const custom = (await worker.send("wheel:toggle-tab", { tabId: 1 })).items;
  const stored = structuredClone(env.local.wheelItems);
  const all = await worker.send("wheel:set-mode", { mode: "all" });
  assert.equal(all.ok, true);
  assert.equal(all.settings.mode, "all");
  assert.equal(env.local.wheelSettings.mode, "all");
  assert.equal(env.local.wheelSettings.otherPreference, 8);
  assert.deepEqual(env.local.wheelItems, stored);
  const restart = await env.boot().send("wheel:get-state");
  assert.equal(restart.settings.mode, "all");
  assert.equal(restart.wheelItems.length, 3);
  assert.deepEqual(restart.items, custom);
  const list = await worker.send("wheel:list-tabs");
  assert.equal(list.settings.mode, "all");
  assert.equal(list.totalTabs, 3);
  const restored = await worker.send("wheel:set-mode", { mode: "custom" });
  assert.equal(restored.ok, true);
  const customState = await worker.send("wheel:get-state");
  assert.deepEqual(customState.wheelItems, custom);
  assert.deepEqual(customState.items, custom);
});

test("非法模式请求不会覆盖有效模式；异常存储值安全回退自定义", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  for (const mode of ["ALL", "", "favorites", null, 1, {}, ["all"]]) {
    assert.equal((await worker.send("wheel:set-mode", { mode })).ok, false);
    assert.equal((await worker.send("wheel:get-state")).settings.mode, "all");
  }
  const corrupted = browser({ local: { wheelSettings: { mode: "unknown" } } });
  assert.equal((await corrupted.boot().send("wheel:get-state")).settings.mode, "custom");
});

test("所有标签无需收藏即全量返回，超过 24 个也不截断", async () => {
  const env = browser({ tabs: [...Array.from({ length: 57 }, (_, i) => tab(i + 1, { windowId: i % 3 + 1, index: i })), tab(100, { url: "javascript:alert(1)" })] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  const result = await worker.send("wheel:get-state");
  assert.deepEqual(result.items, []);
  assert.equal(result.totalTabs, 57);
  assert.equal(result.wheelItems.length, 57);
  assert.equal(new Set(result.wheelItems.map(item => item.id)).size, 57);
  assert.deepEqual(new Set(result.wheelItems.map(item => item.tabId)), new Set(Array.from({ length: 57 }, (_, i) => i + 1)));
  assert.ok(result.wheelItems.every(item => item.available && item.id === `tab:${env.session.wheelSessionId}:${item.tabId}`));
  assert.deepEqual(env.local.wheelItems || [], [], "所有标签列表不能写入自定义收藏");
});

test("所有模式同网址不同物理标签分别保留，并可跨窗口激活精确标签", async () => {
  const env = browser({ tabs: [tab(1, { windowId: 2, index: 1 }), tab(2, { windowId: 99, index: 0, url: tab(1).url })] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  const result = await worker.send("wheel:get-state");
  assert.equal(result.wheelItems.length, 2);
  assert.equal(new Set(result.wheelItems.map(item => item.id)).size, 2);
  const target = result.wheelItems.find(item => item.tabId === 2);
  assert.equal((await worker.send("wheel:activate", { itemId: target.id })).ok, true);
  assert.deepEqual(env.calls.tabUpdates, [{ id: 2, active: true }]);
  assert.deepEqual(env.calls.windowUpdates, [{ id: 99, focused: true }]);
  assert.deepEqual(env.calls.creates, []);
});

test("所有模式关闭标签后旧 ID 不能激活，其他同网址标签不会代替它", async () => {
  const env = browser({ tabs: [tab(1), tab(2, { url: tab(1).url })] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  const item = (await worker.send("wheel:get-state")).wheelItems.find(value => value.tabId === 1);
  env.tabs.delete(1);
  const result = await worker.send("wheel:activate", { itemId: item.id });
  assert.equal(result.ok, false);
  assert.deepEqual(env.calls.tabUpdates, []);
  assert.deepEqual(env.calls.windowUpdates, []);
  const state = await worker.send("wheel:get-state");
  assert.equal(state.wheelItems.length, 1);
  assert.equal(state.wheelItems[0].tabId, 2);
});

test("所有模式的旧浏览器会话 ID 在 tab ID 被复用时仍拒绝激活", async () => {
  const old = browser({ tabs: [tab(1)] });
  const oldWorker = old.boot();
  await oldWorker.send("wheel:set-mode", { mode: "all" });
  const oldItem = (await oldWorker.send("wheel:get-state")).wheelItems[0];
  const fresh = browser({ local: old.local, tabs: [tab(1, { url: "https://other.test/reused-id" })] });
  const worker = fresh.boot();
  const state = await worker.send("wheel:get-state");
  assert.notEqual(state.wheelItems[0].id, oldItem.id);
  assert.equal((await worker.send("wheel:activate", { itemId: oldItem.id })).ok, false);
  assert.deepEqual(fresh.calls.tabUpdates, []);
  assert.equal((await worker.send("wheel:activate", { itemId: state.wheelItems[0].id })).ok, true);
  assert.deepEqual(fresh.calls.tabUpdates, [{ id: 1, active: true }]);
});

test("所有模式实时反映新增、导航和跨窗口移动，收藏列表仍独立", async () => {
  const env = browser({ tabs: [tab(1)] });
  const worker = env.boot();
  await worker.send("wheel:toggle-tab", { tabId: 1 });
  await worker.send("wheel:set-mode", { mode: "all" });
  const before = await worker.send("wheel:get-state");
  env.tabs.set(2, tab(2, { windowId: 8 }));
  Object.assign(env.tabs.get(1), { title: "新的标题", url: "https://example.test/new", windowId: 9 });
  env.chrome.tabs.onCreated.fire(env.tabs.get(2));
  env.chrome.tabs.onAttached.fire(1, { newWindowId: 9, newPosition: 0 });
  const after = await worker.send("wheel:get-state");
  assert.equal(after.totalTabs, 2);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].id, before.items[0].id);
  const changed = after.wheelItems.find(item => item.tabId === 1);
  assert.equal(changed.id, before.wheelItems[0].id);
  assert.equal(changed.title, "新的标题");
  assert.equal(changed.url, "https://example.test/new");
  assert.equal(changed.windowId, 9);
});

test("所有模式依据浏览器 index 排序，不依赖 query 返回顺序或标签 ID", async () => {
  const env = browser({ windowId: 9, tabs: [tab(80, { windowId: 9, index: 2 }), tab(90, { windowId: 9, index: 0 }), tab(3, { windowId: 9, index: 1 })] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  const state = await worker.send("wheel:get-state");
  assert.deepEqual(state.wheelItems.map(item => item.tabId), [90, 3, 80]);
});

test("所有模式优先当前窗口，窗口内从左到右，其他窗口也保持 index 顺序", async () => {
  const env = browser({ windowId: 9, tabs: [tab(91, { windowId: 9, index: 1 }), tab(21, { windowId: 2, index: 1 }), tab(30, { windowId: 3, index: 0 }), tab(90, { windowId: 9, index: 0 }), tab(20, { windowId: 2, index: 0 })] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  assert.deepEqual((await worker.send("wheel:get-state")).wheelItems.map(item => item.tabId), [90, 91, 20, 21, 30]);
  const otherSender = { id: env.chrome.runtime.id, tab: { id: 1000, windowId: 2 } };
  assert.deepEqual((await worker.send("wheel:get-state", {}, otherSender)).wheelItems.map(item => item.tabId), [20, 21, 30, 90, 91]);
  const list = await worker.send("wheel:list-tabs", {}, otherSender);
  assert.deepEqual(list.tabs.map(item => item.id), [20, 21, 30, 90, 91]);
  assert.deepEqual(list.wheelItems.map(item => item.tabId), [20, 21, 30, 90, 91]);
  assert.deepEqual(list.tabs.filter(item => item.currentWindow).map(item => item.id), [20, 21]);
  const popup = { id: env.chrome.runtime.id };
  assert.deepEqual((await worker.send("wheel:get-state", {}, popup)).wheelItems.map(item => item.tabId), [90, 91, 20, 21, 30]);
});

test("仅切换 active 标签不会将所有模式改成最近使用顺序", async () => {
  const env = browser({ tabs: [tab(3, { index: 2, active: true }), tab(1, { index: 0 }), tab(2, { index: 1 })] });
  const worker = env.boot();
  await worker.send("wheel:set-mode", { mode: "all" });
  const before = (await worker.send("wheel:get-state")).wheelItems.map(item => item.tabId);
  for (const target of [2, 1, 3]) {
    for (const value of env.tabs.values()) value.active = value.id === target;
    env.chrome.tabs.onActivated.fire({ tabId: target, windowId: 1 });
    assert.deepEqual((await worker.send("wheel:get-state")).wheelItems.map(item => item.tabId), before);
  }
  assert.deepEqual(before, [1, 2, 3]);
});

test("浏览器拖动改变 index 只改变所有模式，自定义继续保持用户排序", async () => {
  const env = browser({ tabs: [tab(1, { index: 0 }), tab(2, { index: 1 }), tab(3, { index: 2 })] });
  const worker = env.boot();
  for (const id of [3, 1, 2]) await worker.send("wheel:toggle-tab", { tabId: id });
  const original = (await worker.send("wheel:get-state")).items;
  env.tabs.get(2).index = 0;
  env.tabs.get(1).index = 1;
  env.tabs.get(3).index = 2;
  env.chrome.tabs.onMoved.fire(2, { windowId: 1, fromIndex: 1, toIndex: 0 });
  const custom = await worker.send("wheel:get-state");
  assert.deepEqual(custom.wheelItems.map(item => item.tabId), [3, 1, 2]);
  assert.deepEqual(custom.items.map(item => item.id), original.map(item => item.id));
  await worker.send("wheel:set-mode", { mode: "all" });
  const all = await worker.send("wheel:get-state");
  assert.deepEqual(all.wheelItems.map(item => item.tabId), [2, 1, 3]);
  assert.deepEqual(all.items.map(item => item.id), original.map(item => item.id));
});
