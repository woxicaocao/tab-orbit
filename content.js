(() => {
  "use strict";
  if (window !== window.top) return;

  const HOST_ID = "__tab_orbit_extension__";
  const PAGE_SIZE = 24;
  const CUSTOM_LIMIT = 24;
  let host, shadow, wheel, manager, toastTimer;
  let cache = [], wheelCache = [], mode = "custom", cacheReady = false;
  let gesture = null, selected = -1, nodes = [], layout = null;
  let suppressMenuUntil = 0, renderToken = 0, managerToken = 0;
  let cacheRevision = 0, refreshTimer;
  let managerOpen = false, filter = "", onlyCurrent = true, allTabs = [], previousFocus;
  let managerBusy = false;
  let swallowCompatibilityUp = false;
  const iconCache = new Map();

  const styles = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important; pointer-events: none !important; color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    button, input { font: inherit; }
    button { cursor: pointer; }
    button:focus-visible, input:focus-visible { outline: 2px solid #c5b7ff; outline-offset: 4px; }
    .surface { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: #f5f3ff; }
    [hidden] { display: none !important; }
    .veil { position: fixed; inset: 0; pointer-events: auto; background: radial-gradient(ellipse at var(--cx) var(--cy), #1415293d, #06071370); animation: veil-in 110ms ease-out; }
    .wheel { position: fixed; width: var(--size); height: var(--size); left: 0; top: 0; transform-origin: center; user-select: none; -webkit-user-select: none; }
    .track { position: absolute; border: 1px solid #bdb4ff28; border-radius: 50%; left: 50%; top: 50%; transform: translate(-50%, -50%); width: var(--diameter); height: var(--diameter); background: radial-gradient(circle, #12132600 55%, #b6a4ff06 85%); }
    .track::after { content: ""; position: absolute; border: 1px dashed #bdb4ff14; border-radius: 50%; inset: -22px; }
    .track.outer { border-color: #bdb4ff3b; }
    .track.outer::after { inset: -16px; }
    .spoke { position: absolute; height: 1px; background: linear-gradient(90deg, #baa8ff0a, #baa8ff6b); transform-origin: left; left: 50%; top: 50%; pointer-events: none; }
    .hub { position: absolute; width: 132px; height: 132px; border-radius: 50%; left: calc(50% - 66px); top: calc(50% - 66px); display: flex; align-items: center; justify-content: center; flex-direction: column; text-align: center; background: #121522ed; border: 1px solid #d6cfff30; box-shadow: 0 16px 70px #0005, inset 0 1px #ffffff0a; backdrop-filter: blur(16px); }
    .hub-logo { width: 24px; height: 24px; color: #bba9ff; margin-bottom: 5px; }
    .hub-title { max-width: 108px; font-size: 13px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hub-caption { font-size: 10px; color: #8f92aa; margin-top: 4px; letter-spacing: .4px; }
    .hub-mode { font-size: 9px; color: #baace8; margin-top: 5px; }
    .hub-order { font-size: 9px; color: #8b879e; margin-top: 3px; }
    .node { position: absolute; width: var(--node-width); height: var(--node-height); left: 50%; top: 50%; margin-left: calc(var(--node-width) / -2); margin-top: calc(var(--node-height) / -2); border: 1px solid #b7b3dd30; border-radius: 16px; background: #171a2bf2; box-shadow: 0 8px 24px #0004, inset 0 1px #ffffff08; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 5px; padding: 8px; color: #e5e3f2; transition: transform 130ms cubic-bezier(.2,.8,.2,1), border-color 130ms, background 130ms, box-shadow 130ms; will-change: transform; backdrop-filter: blur(18px); }
    .node.is-selected { z-index: 5; border-color: #d7c6ff; background: #504079fa; box-shadow: 0 0 0 4px #b698ff18, 0 12px 40px #0005, 0 0 36px #ab86ff35; }
    .node.is-closed { opacity: .5; }
    .node.add { border-style: dashed; color: #cabdff; background: #1d1c31ee; }
    .node.add.is-selected { background: #514079fa; }
    .node img { width: 22px; height: 22px; object-fit: contain; border-radius: 5px; }
    .favicon { width: 23px; height: 23px; border-radius: 6px; background: #b4a0f72e; color: #d4c5ff; display: grid; place-items: center; flex: none; font-size: 13px; font-weight: 700; }
    .node-title { max-width: 100%; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 11px; font-weight: 550; }
    .sequence-number { position: absolute; left: 7px; top: 5px; font-size: 9px; line-height: 12px; font-weight: 550; color: #8e87a7; font-variant-numeric: tabular-nums; pointer-events: none; }
    .node.is-selected .sequence-number { color: #e1d3ff; }
    .plus { width: 23px; height: 23px; font-size: 25px; font-weight: 300; line-height: 20px; }
    .wheel-tip { position: absolute; top: calc(var(--size) - 10px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 9px; white-space: nowrap; padding: 9px 16px; border: 1px solid #bcb5e322; border-radius: 30px; background: #10121fe8; color: #b9b6cc; font-size: 11px; backdrop-filter: blur(12px); }
    .page-indicator { color: #c3b4f1; }
    .key { border: 1px solid #b7b3dd3b; border-radius: 4px; padding: 0 4px; color: #e3dbff; font-size: 10px; }
    .manager-veil { position: fixed; inset: 0; background: #05061191; backdrop-filter: blur(7px); pointer-events: auto; display: grid; place-items: center; padding: 22px; }
    .panel { width: min(520px, 100%); max-height: min(720px, calc(100vh - 44px)); display: flex; flex-direction: column; border: 1px solid #b7a8ed36; background: #121421; border-radius: 24px; box-shadow: 0 24px 100px #0008; overflow: hidden; }
    .panel-head { padding: 23px 24px 16px; }
    .eyebrow { color: #ae9ee2; font-size: 10px; letter-spacing: 2px; font-weight: 650; margin-bottom: 7px; }
    .heading-row { display: flex; align-items: center; gap: 12px; }
    h2 { font-size: 23px; line-height: 1.3; letter-spacing: -.5px; margin: 0; font-weight: 650; }
    .count { font-size: 11px; padding: 3px 9px; border-radius: 20px; color: #c4b3ff; background: #a58af51b; }
    .close { margin-left: auto; width: 30px; height: 30px; border-radius: 50%; background: #ffffff08; color: #aaa6c1; border: 1px solid #ffffff12; font-size: 21px; line-height: 24px; }
    .description { color: #9995b0; font-size: 12px; margin: 10px 0 17px; }
    .mode-switch { display: flex; padding: 4px; border: 1px solid #b3a1ec29; border-radius: 11px; gap: 4px; background: #090b1670; margin: 12px 0; }
    .mode-option { flex: 1; border: 1px solid transparent; border-radius: 8px; color: #9991ad; background: transparent; padding: 8px 10px; font-size: 12px; }
    .mode-option[aria-pressed="true"] { color: #e0d3ff; background: #ac91ff22; border-color: #b3a1ec36; }
    .mode-option:disabled { cursor: wait; opacity: .65; }
    .search { width: 100%; border-radius: 11px; border: 1px solid #b2a7d329; padding: 10px 13px; color: #e8e3f8; background: #090b1670; outline: none; }
    .search::placeholder { color: #69667f; }
    .search:focus { border-color: #a997e5; }
    .filters { display: flex; gap: 6px; margin-top: 12px; }
    .filter { border: 1px solid transparent; background: transparent; color: #928da8; padding: 5px 11px; border-radius: 7px; font-size: 11px; }
    .filter[aria-pressed="true"] { border-color: #b3a1ec2a; color: #dbceff; background: #ac91ff15; }
    .tab-list { overflow-y: auto; padding: 0 13px 12px; min-height: 100px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #4a4164 transparent; }
    .tab-row { display: flex; width: 100%; gap: 11px; align-items: center; padding: 12px 11px; border-radius: 11px; border: 1px solid transparent; background: transparent; color: #e6e0f3; text-align: left; }
    .tab-row:hover { background: #a690e911; }
    .tab-row[aria-pressed="true"] { background: #a690e90e; }
    .tab-info { min-width: 0; flex: 1; }
    .tab-row > img { width: 23px; height: 23px; object-fit: contain; border-radius: 6px; flex: none; }
    .tab-name { white-space: nowrap; text-overflow: ellipsis; overflow: hidden; font-size: 12px; }
    .tab-url { color: #746e89; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; margin-top: 3px; }
    .check { width: 23px; height: 23px; display: grid; place-items: center; flex: none; border: 1px solid #c1b5e533; border-radius: 7px; color: #9587b6; font-size: 17px; }
    [aria-pressed="true"] > .check { background: #bca1ff; color: #211336; border-color: #bca1ff; font-size: 14px; }
    .panel-foot { border-top: 1px solid #b2a7d318; padding: 14px 24px; color: #8f879f; font-size: 11px; }
    .empty { color: #a39ab8; text-align: center; padding: 32px 12px; font-size: 12px; }
    .toast { pointer-events: none; position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); max-width: calc(100vw - 40px); padding: 12px 20px; color: #e7defa; background: #252035f5; border: 1px solid #c6abe75c; border-radius: 12px; box-shadow: 0 12px 40px #0005; font-size: 12px; }
    @keyframes veil-in { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensureUI() {
    if (!host) {
      host = el("div");
      host.id = HOST_ID;
      // 收藏标题和网址仅在扩展持有的封闭 Shadow DOM 中显示，网页不能读取。
      shadow = host.attachShadow({ mode: "closed" });
      const style = el("style");
      style.textContent = styles;
      shadow.append(style);
    }
    const parent = document.fullscreenElement || document.documentElement;
    if (parent && host.parentNode !== parent) parent.append(host);
    return Boolean(host.isConnected);
  }

  async function request(type, data = {}) {
    try {
      const response = await chrome.runtime.sendMessage({ type, ...data });
      if (!response?.ok) throw new Error(response?.error || "插件暂时没有响应，请稍后重试。");
      return response;
    } catch (error) {
      if (/context invalidated|receiving end|extension context/i.test(error.message)) {
        throw new Error("插件已更新，请刷新当前网页后再使用轮盘。");
      }
      throw error;
    }
  }

  function applyState(result) {
    const nextMode = result.settings?.mode === "all" ? "all" : "custom";
    const changed = nextMode !== mode;
    if (changed && gesture) {
      cancelGesture();
      showToast(`已切换到${nextMode === "all" ? "所有标签" : "自定义标签"}，请重新呼出轮盘。`);
    }
    mode = nextMode;
    if (Array.isArray(result.items)) cache = result.items;
    if (Array.isArray(result.wheelItems)) {
      wheelCache = result.wheelItems;
      cacheReady = true;
    } else if (mode === "custom") {
      wheelCache = cache;
      cacheReady = true;
    } else if (changed) {
      wheelCache = [];
      cacheReady = false;
    }
    if (gesture && !gesture.ready && cacheReady) {
      gesture.items = wheelCache.slice();
      gesture.pages = Math.max(1, Math.ceil(gesture.items.length / PAGE_SIZE));
      gesture.ready = true;
      if (gesture.moved) gesture.reselectFrom = { x: gesture.lastX, y: gesture.lastY };
      drawWheel();
    }
  }

  async function refreshCache() {
    const revision = ++cacheRevision;
    try {
      const result = await request("wheel:get-state");
      if (revision === cacheRevision) applyState(result);
    } catch { /* 首次唤起时再显示连接错误，普通浏览不打扰用户。 */ }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshCache();
      if (managerOpen && !managerBusy) loadManager();
    }, 60);
  }

  function favicon(item) {
    const fallback = el("span", "favicon", (item.title || "页").trim().slice(0, 1).toUpperCase());
    if (!Number.isInteger(item.tabId ?? item.id)) return fallback;
    // 仅使用后台从 Chrome 本地 favicon 缓存读取的 PNG，避免页面资源记录泄露其他标签域名。
    const key = `${item.tabId ?? item.id}:${item.url}:${item.favIconUrl || ""}`;
    if (!iconCache.has(key)) {
      if (iconCache.size >= 100) iconCache.delete(iconCache.keys().next().value);
      iconCache.set(key, request("wheel:get-icon", { tabId: item.tabId ?? item.id }).then(result => result.dataUrl || "").catch(() => ""));
    }
    const pending = iconCache.get(key);
    pending.then(dataUrl => {
      if (!dataUrl) { if (iconCache.get(key) === pending) iconCache.delete(key); return; }
      if (!dataUrl.startsWith("data:image/png;base64,")) return;
      const img = el("img");
      img.alt = "";
      img.src = dataUrl;
      img.addEventListener("error", () => { if (img.isConnected) img.replaceWith(fallback); }, { once: true });
      if (fallback.isConnected) fallback.replaceWith(img);
    });
    return fallback;
  }

  function showToast(message) {
    if (!ensureUI()) return;
    shadow.querySelector(".toast")?.remove();
    clearTimeout(toastTimer);
    const toast = el("div", "surface toast", message);
    toast.setAttribute("role", "status");
    shadow.append(toast);
    toastTimer = setTimeout(() => toast.remove(), 3600);
  }

  function fitLayout(count, origin, dual) {
    const size = dual ? 720 : 560;
    const radius = dual ? 152 : count > 6 ? 188 : 162;
    const outerRadius = dual ? 276 : radius;
    const scale = Math.max(.05, Math.min(1, (innerWidth - 24) / size, (innerHeight - 24) / (size + 40)));
    const half = size / 2;
    const margin = half * scale + 12;
    const bottom = (half + 40) * scale + 12;
    const cx = Math.max(margin, Math.min(innerWidth - margin, origin.x));
    const cy = Math.max(margin, Math.min(innerHeight - bottom, origin.y));
    return { cx, cy, scale, radius, outerRadius, size, half, dual, nodeWidth: dual ? 96 : 112, nodeHeight: dual ? 64 : 72, hoverScale: dual ? 1.14 : 1.17 };
  }

  function gestureEntries() {
    if (!gesture?.ready) return [];
    const items = gesture.items.slice(gesture.page * PAGE_SIZE, (gesture.page + 1) * PAGE_SIZE);
    if (gesture.mode === "custom" && gesture.items.length < CUSTOM_LIMIT) {
      items.push({ id: "__add__", title: "添加标签", add: true });
    }
    return items;
  }

  function defaultHubTitle() {
    if (!gesture?.ready) return "正在获取标签…";
    return gesture.mode === "all" ? "所有标签" : gesture.items.length ? "自定义标签" : "你的标签捷径";
  }

  function drawWheel() {
    if (!gesture || !ensureUI()) return;
    wheel?.remove();
    wheel = el("div", "surface veil");
    wheel.dataset.testid = "wheel-overlay";
    wheel.dataset.mode = gesture.mode;
    wheel.dataset.page = String(gesture.page + 1);
    wheel.dataset.pages = String(gesture.pages);
    if (gesture.rendered) wheel.style.animation = "none";
    gesture.rendered = true;
    const entries = gestureEntries();
    const dual = gesture.items.length + (gesture.mode === "custom" && gesture.items.length < CUSTOM_LIMIT ? 1 : 0) > 8;
    layout = fitLayout(entries.length, gesture, dual);
    wheel.dataset.rings = dual ? "2" : "1";
    wheel.style.setProperty("--cx", `${layout.cx}px`);
    wheel.style.setProperty("--cy", `${layout.cy}px`);
    const disc = el("div", "wheel");
    disc.setAttribute("role", "menu");
    disc.setAttribute("aria-label", "标签轮盘，松开右键选择，Esc 取消");
    disc.style.left = `${layout.cx - layout.half}px`;
    disc.style.top = `${layout.cy - layout.half}px`;
    disc.style.transform = `scale(${layout.scale})`;
    disc.style.setProperty("--size", `${layout.size}px`);
    disc.style.setProperty("--node-width", `${layout.nodeWidth}px`);
    disc.style.setProperty("--node-height", `${layout.nodeHeight}px`);
    const track = el("div", "track");
    track.dataset.ring = "inner";
    track.style.setProperty("--diameter", `${layout.radius * 2}px`);
    disc.append(track);
    if (dual) {
      const outer = el("div", "track outer");
      outer.dataset.ring = "outer";
      outer.style.setProperty("--diameter", `${layout.outerRadius * 2}px`);
      disc.append(outer);
    }
    const spoke = el("div", "spoke");
    spoke.hidden = true;
    disc.append(spoke);
    const hub = el("div", "hub");
    const logo = el("span", "hub-logo", "◎");
    logo.style.fontSize = "25px";
    logo.style.lineHeight = "24px";
    hub.append(logo, el("div", "hub-title", defaultHubTitle()), el("div", "hub-caption", gesture.reselectFrom ? "移动鼠标后选择" : "移回圆心取消"), el("div", "hub-mode", `${gesture.mode === "all" ? "所有" : "自定义"} · ${gesture.items.length} 个${gesture.pages > 1 ? ` · ${gesture.page + 1}/${gesture.pages}` : ""}`), el("div", "hub-order", dual && entries.length > 8 ? "顺时针 · 先内后外" : "从顶部顺时针"));
    disc.append(hub);
    // 固定前 8 个在内圈、后 16 个在外圈。保留空槽，增减标签时不重新均分或换圈。
    const innerCount = dual ? Math.min(8, entries.length) : entries.length;
    nodes = entries.map((item, index) => {
      const outer = index >= innerCount;
      const ringIndex = outer ? index - innerCount : index;
      const ringCount = dual ? (outer ? 16 : 8) : innerCount;
      const radius = outer ? layout.outerRadius : layout.radius;
      const angle = -Math.PI / 2 + ringIndex * 2 * Math.PI / ringCount;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const node = el("button", `node${item.add ? " add" : ""}${item.available === false ? " is-closed" : ""}`);
      node.type = "button";
      node.tabIndex = -1;
      node.dataset.itemId = item.id;
      node.dataset.ring = outer ? "outer" : "inner";
      if (Number.isInteger(item.tabId)) node.dataset.tabId = String(item.tabId);
      const order = gesture.page * PAGE_SIZE + index + 1;
      if (!item.add) {
        node.dataset.order = String(order);
        const number = el("span", "sequence-number", String(order).padStart(2, "0"));
        number.setAttribute("aria-hidden", "true");
        node.append(number);
      }
      node.setAttribute("role", "menuitem");
      node.setAttribute("aria-label", item.add ? "添加已打开的浏览器标签" : `${order}. ${item.title}${item.available === false ? "（已关闭）" : ""}`);
      node.title = item.add ? "松开右键，选择已打开的标签" : `第 ${order} 个 · ${item.title}\n${item.url || ""}`;
      node.append(item.add ? el("span", "plus", "+") : favicon(item));
      node.append(el("span", "node-title", item.available === false ? `已关闭 · ${item.title}` : item.title));
      node.style.transform = `translate(${x}px, ${y}px)`;
      disc.append(node);
      return { element: node, item, x, y, angle, radius };
    });
    const tip = el("div", "wheel-tip");
    if (gesture.pages > 1) {
      tip.append(el("span", "page-indicator", `第 ${gesture.page + 1} / ${gesture.pages} 页 · 共 ${gesture.items.length} 个标签`), el("span", "", "· 滚轮翻页"));
    } else {
      tip.append(el("span", "page-indicator", `${gesture.mode === "all" ? "所有标签" : "自定义标签"} · ${gesture.items.length} 个`), el("span", "", "· 按住右键滑动"));
    }
    tip.append(el("span", "", "· 松开切换"), el("span", "key", "Esc"), el("span", "", "取消"));
    disc.append(tip);
    wheel.append(disc);
    shadow.append(wheel);
    selected = -1;
    updateSelection(gesture.lastX, gesture.lastY);
  }

  function updateSelection(x, y) {
    if (!gesture || !wheel || !layout) return;
    const dx = (x - layout.cx) / layout.scale;
    const dy = (y - layout.cy) / layout.scale;
    let next = -1;
    if (gesture.moved && !gesture.reselectFrom && Math.hypot(dx, dy) > 76) {
      // 先保留已放大卡片的命中，再检测其他卡片，避免两圈相邻处来回跳选。
      const contains = (entry, scale = 1) => entry && Math.abs(dx - entry.x) <= layout.nodeWidth * scale / 2 + 2 && Math.abs(dy - entry.y) <= layout.nodeHeight * scale / 2 + 2;
      if (contains(nodes[selected], layout.hoverScale)) next = selected;
      else next = nodes.findIndex(entry => contains(entry));
    }
    if (next === selected) return;
    selected = next;
    nodes.forEach((entry, index) => {
      const active = index === selected;
      entry.element.classList.toggle("is-selected", active);
      entry.element.setAttribute("aria-current", active ? "true" : "false");
      entry.element.style.transform = `translate(${entry.x}px, ${entry.y}px) scale(${active ? layout.hoverScale : 1})`;
    });
    const choice = nodes[selected];
    wheel.querySelector(".hub-title").textContent = choice ? choice.item.title : defaultHubTitle();
    wheel.querySelector(".hub-caption").textContent = !choice ? gesture.reselectFrom ? "移动鼠标后选择" : "移回圆心取消" : choice.item.add ? "松开后选择标签" : choice.item.available === false ? "此标签已关闭" : "松开右键切换";
    const spoke = wheel.querySelector(".spoke");
    spoke.hidden = !choice;
    if (choice) {
      spoke.style.width = `${choice.radius - 36}px`;
      spoke.style.transform = `rotate(${choice.angle}rad)`;
    }
  }

  function cancelGesture() {
    renderToken++;
    gesture = null;
    selected = -1;
    nodes = [];
    wheel?.remove();
    wheel = null;
  }

  function changePage(direction) {
    if (!gesture || gesture.pages <= 1) return false;
    const page = Math.max(0, Math.min(gesture.pages - 1, gesture.page + direction));
    if (page === gesture.page) return false;
    gesture.page = page;
    // 翻页后必须再次移动，原地松手只关闭轮盘，避免误切到同一位置的新标签。
    gesture.reselectFrom = { x: gesture.lastX, y: gesture.lastY };
    gesture.moved = true;
    drawWheel();
    return true;
  }

  function closeManager() {
    if (!managerOpen) return;
    managerToken++;
    managerOpen = false;
    manager?.remove();
    manager = null;
    const restore = previousFocus;
    previousFocus = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }

  async function loadManager() {
    const token = ++managerToken;
    try {
      const result = await request("wheel:list-tabs");
      if (!managerOpen || token !== managerToken) return;
      allTabs = result.tabs || [];
      applyState(result);
      renderTabs();
    } catch (error) {
      if (managerOpen && token === managerToken) showToast(error.message);
    }
  }

  function tabIsSaved(tab) {
    return cache.some(item => item.available !== false && item.tabId === tab.id);
  }

  function renderTabs() {
    if (!managerOpen || !manager) return;
    const list = manager.querySelector(".tab-list");
    list.replaceChildren();
    manager.querySelector(".count").textContent = `${cache.length} / ${CUSTOM_LIMIT}`;
    manager.querySelectorAll(".mode-option").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
      button.disabled = managerBusy;
    });
    manager.querySelector(".description").textContent = mode === "all"
      ? "正在显示所有已打开的标签。下方选择会保留为你的自定义工作标签。"
      : "只显示你选择的工作标签，切换到所有标签不会清空这些选择。";
    const needle = filter.toLocaleLowerCase().trim();
    const visible = allTabs.filter(tab => (!onlyCurrent || tab.currentWindow) && (!needle || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(needle)));
    if (!visible.length) list.append(el("div", "empty", needle ? "没有匹配的标签，试试其他关键词。" : "当前没有可添加的标签。"));
    visible.forEach(tab => {
      const saved = tabIsSaved(tab);
      const row = el("button", "tab-row");
      row.type = "button";
      row.disabled = managerBusy;
      row.setAttribute("aria-pressed", String(saved));
      row.setAttribute("aria-label", `${saved ? "移除" : "添加"}：${tab.title}`);
      row.append(favicon(tab));
      const info = el("div", "tab-info");
      let site = tab.url;
      try { site = new URL(tab.url).hostname || tab.url; } catch { /* 保留原始地址文字。 */ }
      info.append(el("div", "tab-name", tab.title), el("div", "tab-url", `${tab.active ? "当前标签 · " : ""}${site}`));
      row.append(info, el("span", "check", saved ? "✓" : "+"));
      row.addEventListener("click", async event => {
        if (!event.isTrusted || managerBusy) return;
        managerBusy = true;
        renderTabs();
        try {
          const result = await request("wheel:toggle-tab", { tabId: tab.id });
          cache = result.items || [];
          await loadManager();
        } catch (error) { showToast(error.message); }
        finally { managerBusy = false; renderTabs(); }
      });
      list.append(row);
    });
  }

  function openManager() {
    if (!ensureUI()) return;
    if (managerOpen) return;
    cancelGesture();
    managerOpen = true;
    previousFocus = document.activeElement;
    filter = "";
    manager = el("div", "surface manager-veil");
    const panel = el("section", "panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "添加标签到轮盘");
    const head = el("div", "panel-head");
    head.append(el("div", "eyebrow", "TAB ORBIT / 标签轮盘"));
    const heading = el("div", "heading-row");
    const close = el("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭标签管理");
    close.addEventListener("click", event => { if (event.isTrusted) closeManager(); });
    heading.append(el("h2", "", "管理轮盘标签"), el("span", "count", `${cache.length} / ${CUSTOM_LIMIT}`), close);
    const modes = el("div", "mode-switch");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "选择轮盘标签来源");
    [["自定义标签", "custom"], ["所有标签", "all"]].forEach(([label, value]) => {
      const button = el("button", "mode-option", label);
      button.type = "button";
      button.dataset.mode = value;
      button.setAttribute("aria-pressed", String(mode === value));
      button.addEventListener("click", async event => {
        if (!event.isTrusted || managerBusy) return;
        managerBusy = true;
        renderTabs();
        try {
          applyState(await request("wheel:set-mode", { mode: value }));
        } catch (error) { showToast(error.message); }
        finally { managerBusy = false; renderTabs(); }
      });
      modes.append(button);
    });
    head.append(heading, modes, el("p", "description", "只显示你选择的工作标签，切换到所有标签不会清空这些选择。"));
    const search = el("input", "search");
    search.type = "search";
    search.placeholder = "搜索标签名称或网址…";
    search.setAttribute("aria-label", "搜索已打开的标签");
    search.addEventListener("input", () => { filter = search.value; renderTabs(); });
    head.append(search);
    const filters = el("div", "filters");
    [["当前窗口", true], ["所有窗口", false]].forEach(([label, value]) => {
      const button = el("button", "filter", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(onlyCurrent === value));
      button.addEventListener("click", event => {
        if (!event.isTrusted) return;
        onlyCurrent = value;
        [...filters.children].forEach((node, index) => node.setAttribute("aria-pressed", String(index === (value ? 0 : 1))));
        renderTabs();
      });
      filters.append(button);
    });
    head.append(filters);
    const list = el("div", "tab-list");
    list.append(el("div", "empty", "正在读取已打开的标签…"));
    panel.append(head, list, el("div", "panel-foot", "自定义最多 24 个 · 多标签自动分两圈 · 排序和清理请点击浏览器插件图标。"));
    manager.append(panel);
    manager.addEventListener("mousedown", event => { if (event.isTrusted && event.target === manager) closeManager(); });
    // 将键盘焦点限制在弹层，关闭后恢复原网页焦点。
    manager.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll("button:not(:disabled), input")];
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    shadow.append(manager);
    search.focus({ preventScroll: true });
    loadManager();
  }

  window.addEventListener("pointerdown", event => {
    if (event.isTrusted && !gesture && event.button === 2) swallowCompatibilityUp = false;
    if (!event.isTrusted || event.button !== 2 || !event.ctrlKey || event.altKey || event.metaKey || managerOpen) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressMenuUntil = Date.now() + 1200;
    swallowCompatibilityUp = true;
    cancelGesture();
    gesture = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY,
      mode, items: wheelCache.slice(), ready: cacheReady, page: 0, pages: Math.max(1, Math.ceil(wheelCache.length / PAGE_SIZE)) };
    drawWheel();
    const token = ++renderToken;
    const revision = ++cacheRevision;
    request("wheel:get-state").then(result => {
      if (!gesture || token !== renderToken || revision !== cacheRevision) return;
      applyState(result);
      // 菜单打开后冻结位置，避免慢响应让正在悬停的目标发生移动。
      if (gesture && token === renderToken && !gesture.moved) {
        gesture.items = wheelCache.slice();
        gesture.pages = Math.max(1, Math.ceil(gesture.items.length / PAGE_SIZE));
        gesture.page = Math.min(gesture.page, gesture.pages - 1);
        drawWheel();
      }
    }).catch(error => {
      if (gesture && token === renderToken) { cancelGesture(); showToast(error.message); }
    });
  }, true);

  window.addEventListener("pointermove", event => {
    if (!gesture || !event.isTrusted) return;
    if (!(event.buttons & 2)) { cancelGesture(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    gesture.moved ||= Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (gesture.reselectFrom && Math.hypot(event.clientX - gesture.reselectFrom.x, event.clientY - gesture.reselectFrom.y) >= 6) gesture.reselectFrom = null;
    updateSelection(event.clientX, event.clientY);
  }, true);

  window.addEventListener("wheel", event => {
    if (!gesture || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (Date.now() - (gesture.lastWheelAt || 0) < 220) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    gesture.scrollDelta = (gesture.scrollDelta || 0) + (event.deltaY || event.deltaX) * unit;
    if (Math.abs(gesture.scrollDelta) < 32) return;
    const direction = Math.sign(gesture.scrollDelta);
    gesture.scrollDelta = 0;
    if (changePage(direction)) gesture.lastWheelAt = Date.now();
  }, { capture: true, passive: false });

  window.addEventListener("pointerup", event => {
    if (!gesture || event.button !== 2 || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    updateSelection(event.clientX, event.clientY);
    const choice = nodes[selected]?.item;
    suppressMenuUntil = Date.now() + 650;
    cancelGesture();
    if (!choice) return;
    if (choice.add) { openManager(); return; }
    request("wheel:activate", { itemId: choice.id }).catch(error => showToast(error.message));
  }, true);

  // 同时拦截兼容鼠标事件，页面原有拖拽和鼠标处理器不会接收到轮盘手势。
  for (const type of ["mousedown", "mousemove", "mouseup"]) {
    window.addEventListener(type, event => {
      if (!event.isTrusted) return;
      if (gesture || (type === "mouseup" && event.button === 2 && swallowCompatibilityUp)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === "mouseup" && event.button === 2) swallowCompatibilityUp = false;
      }
    }, true);
  }
  window.addEventListener("pointercancel", cancelGesture, true);

  window.addEventListener("contextmenu", event => {
    if (gesture || Date.now() < suppressMenuUntil || (event.ctrlKey && !event.altKey && !event.metaKey && !managerOpen)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener("keydown", event => {
    if (event.isTrusted && gesture && ["PageDown", "PageUp", "ArrowRight", "ArrowLeft"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      changePage(["PageDown", "ArrowRight"].includes(event.key) ? 1 : -1);
      return;
    }
    if (event.isTrusted && event.key === "Escape" && (gesture || managerOpen)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelGesture();
      closeManager();
    }
  }, true);
  window.addEventListener("blur", cancelGesture);
  window.addEventListener("resize", cancelGesture);
  window.addEventListener("pagehide", () => { cancelGesture(); closeManager(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelGesture(); else refreshCache(); });
  document.addEventListener("fullscreenchange", () => { cancelGesture(); if (host) ensureUI(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.wheelItems && !changes.wheelSettings)) return;
    cacheRevision++;
    if (changes.wheelSettings) {
      applyState({ settings: { mode: changes.wheelSettings.newValue?.mode } });
    }
    scheduleRefresh();
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "wheel:open-manager") openManager();
    if (message?.type === "wheel:tabs-changed") scheduleRefresh();
  });
  refreshCache();
})();
