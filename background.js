'use strict';

const MAX_ITEMS = 24;
const MAX_ICON_BYTES = 128 * 1024;
const MAX_ICON_CACHE = 100;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'chrome:', 'about:']);
const iconCache = new Map();
let queue = Promise.resolve();
let sessionPromise;
let tabsChangedTimer;

// Every state mutation is serialized, including event-driven metadata refreshes.
function serialized(work) {
  const result = queue.then(work);
  queue = result.catch(() => {});
  return result;
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 32768) return '';
  try {
    return SAFE_PROTOCOLS.has(new URL(value).protocol) ? value : '';
  } catch {
    return '';
  }
}

function safeIcon(value) {
  if (typeof value !== 'string' || value.length > 32768) return '';
  try {
    return ['http:', 'https:', 'chrome:'].includes(new URL(value).protocol) ? value : '';
  } catch {
    return '';
  }
}

function tabUrl(tab) {
  return safeUrl(tab.url || tab.pendingUrl || '');
}

function titleFor(tab, fallback = '') {
  return String(tab.title || fallback || tabUrl(tab) || '未命名标签').slice(0, 500);
}

async function fetchLocalIcon(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    // Read only Chrome's local favicon resource. Never fetch a site's icon URL.
    const endpoint = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_ICON_BYTES) return '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 8 || bytes.length > MAX_ICON_BYTES) return '';
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)) return '';
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const dataUrl = `data:image/png;base64,${btoa(binary)}`;
    return dataUrl.length <= MAX_ICON_BYTES ? dataUrl : '';
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function getIcon(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: true, dataUrl: '' };
  try {
    // Resolve the ID afresh; callers cannot provide arbitrary resource URLs.
    const tab = await chrome.tabs.get(tabId);
    const url = tabUrl(tab);
    if (!url) return { ok: true, dataUrl: '' };
    let pending = iconCache.get(url);
    if (pending) {
      iconCache.delete(url);
      iconCache.set(url, pending);
    } else {
      pending = fetchLocalIcon(url);
      iconCache.set(url, pending);
      while (iconCache.size > MAX_ICON_CACHE) iconCache.delete(iconCache.keys().next().value);
    }
    const dataUrl = await pending;
    if (!dataUrl && iconCache.get(url) === pending) iconCache.delete(url);
    return { ok: true, dataUrl };
  } catch {
    return { ok: true, dataUrl: '' };
  }
}

function sessionId() {
  if (!sessionPromise) {
    sessionPromise = chrome.storage.session.get('wheelSessionId').then(async (data) => {
      if (typeof data.wheelSessionId === 'string') return data.wheelSessionId;
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ wheelSessionId: id });
      return id;
    }).catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
  }
  return sessionPromise;
}

function cleanItems(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  return value.filter((item) => item && typeof item === 'object' && safeUrl(item.url))
    .slice(0, MAX_ITEMS).map((item) => {
      let id = typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID();
      if (ids.has(id)) id = crypto.randomUUID();
      ids.add(id);
      return {
        id,
        title: String(item.title || item.url).slice(0, 500),
        url: safeUrl(item.url),
        favIconUrl: safeIcon(item.favIconUrl),
        tabId: Number.isInteger(item.tabId) ? item.tabId : null,
        windowId: Number.isInteger(item.windowId) ? item.windowId : null,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        available: false
      };
    });
}

function publicItem(item) {
  const { sessionId: _sessionId, ...result } = item;
  return result;
}

async function readState() {
  const [data, tabs, currentSession] = await Promise.all([
    chrome.storage.local.get(['wheelItems', 'wheelSettings']),
    chrome.tabs.query({}),
    sessionId()
  ]);
  const items = cleanItems(data.wheelItems);
  const usableTabs = tabs.filter((tab) => Number.isInteger(tab.id) && tabUrl(tab))
    .sort((a, b) => a.windowId - b.windowId || (a.index || 0) - (b.index || 0) || a.id - b.id);
  const byId = new Map(usableTabs.map((tab) => [tab.id, tab]));
  const claimed = new Set();
  const resolved = new Map();

  // A tab's ID is trusted only in the same browser/extension session.
  for (const item of items) {
    const tab = item.sessionId === currentSession ? byId.get(item.tabId) : undefined;
    if (tab && !claimed.has(tab.id)) {
      resolved.set(item.id, tab);
      claimed.add(tab.id);
    }
  }
  for (const item of items) {
    let tab = resolved.get(item.id);
    if (!tab) {
      tab = usableTabs.find((candidate) => candidate.id !== undefined &&
        !claimed.has(candidate.id) && tabUrl(candidate) === item.url);
      if (tab) claimed.add(tab.id);
    }
    if (tab) {
      Object.assign(item, {
        title: titleFor(tab, item.title),
        url: tabUrl(tab),
        favIconUrl: safeIcon(tab.favIconUrl),
        tabId: tab.id,
        windowId: tab.windowId,
        sessionId: currentSession,
        available: true
      });
    } else {
      item.tabId = null;
      item.windowId = null;
      item.sessionId = currentSession;
      item.available = false;
    }
  }

  const storedSettings = data.wheelSettings && typeof data.wheelSettings === 'object' && !Array.isArray(data.wheelSettings)
    ? data.wheelSettings : {};
  const settings = { ...storedSettings, mode: storedSettings.mode === 'all' ? 'all' : 'custom' };
  if (JSON.stringify(data.wheelItems || []) !== JSON.stringify(items)) {
    await chrome.storage.local.set({ wheelItems: items });
  }
  return { items, settings, tabs: usableTabs, currentSession };
}

function publicState(state) {
  const items = state.items.map(publicItem);
  const wheelItems = state.settings.mode === 'all'
    ? state.tabs.map((tab) => ({
      id: `tab:${state.currentSession}:${tab.id}`,
      tabId: tab.id,
      windowId: tab.windowId,
      title: titleFor(tab),
      url: tabUrl(tab),
      favIconUrl: safeIcon(tab.favIconUrl),
      available: true
    }))
    : items;
  return {
    ok: true,
    items,
    wheelItems,
    settings: state.settings,
    maxItems: MAX_ITEMS,
    totalTabs: state.tabs.length
  };
}

async function saveItems(items) {
  await chrome.storage.local.set({ wheelItems: items });
  return { ok: true, items: items.map(publicItem), maxItems: MAX_ITEMS };
}

async function currentWindowId(sender) {
  if (Number.isInteger(sender.tab?.windowId)) return sender.tab.windowId;
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return window.id;
  } catch {
    return null;
  }
}

async function handleMessage(message, sender) {
  const state = await readState();
  let windowId = null;
  if (['wheel:get-state', 'wheel:list-tabs', 'wheel:set-mode'].includes(message.type)) {
    windowId = await currentWindowId(sender);
    // Keep each window's tab-strip order; only move the invoking window first.
    // Do this after resolving saved items so custom ordering stays untouched.
    if (Number.isInteger(windowId)) {
      state.tabs = [
        ...state.tabs.filter((tab) => tab.windowId === windowId),
        ...state.tabs.filter((tab) => tab.windowId !== windowId)
      ];
    }
  }
  const { items, tabs, settings, currentSession } = state;
  switch (message.type) {
    case 'wheel:get-state':
      return publicState(state);
    case 'wheel:set-mode': {
      if (message.mode !== 'custom' && message.mode !== 'all') throw new Error('请选择“自定义标签”或“所有标签”模式。');
      const nextSettings = { ...settings, mode: message.mode };
      if (settings.mode !== message.mode) await chrome.storage.local.set({ wheelSettings: nextSettings });
      return publicState({ ...state, settings: nextSettings });
    }
    case 'wheel:list-tabs': {
      return {
        ...publicState(state),
        tabs: tabs.map((tab) => ({
          id: tab.id,
          windowId: tab.windowId,
          title: titleFor(tab),
          url: tabUrl(tab),
          favIconUrl: safeIcon(tab.favIconUrl),
          active: Boolean(tab.active),
          currentWindow: tab.windowId === windowId
        }))
      };
    }
    case 'wheel:toggle-tab': {
      const tab = tabs.find((candidate) => candidate.id === message.tabId);
      if (!tab) throw new Error('这个标签已关闭，或该类型的页面暂不支持添加。');
      const index = items.findIndex((item) => item.available && item.tabId === tab.id);
      if (index >= 0) {
        items.splice(index, 1);
      } else {
        if (items.length >= MAX_ITEMS) throw new Error('自定义轮盘最多放 24 个标签，请先移除一个。');
        items.push({
          id: crypto.randomUUID(),
          title: titleFor(tab), url: tabUrl(tab),
          favIconUrl: safeIcon(tab.favIconUrl),
          tabId: tab.id, windowId: tab.windowId,
          sessionId: currentSession, available: true
        });
      }
      return saveItems(items);
    }
    case 'wheel:remove-item': {
      const index = items.findIndex((item) => item.id === message.itemId);
      if (index < 0) throw new Error('这个标签已从轮盘中移除。');
      items.splice(index, 1);
      return saveItems(items);
    }
    case 'wheel:move-item': {
      const index = items.findIndex((item) => item.id === message.itemId);
      if (index < 0) throw new Error('找不到这个轮盘标签。');
      const next = index + (message.direction === 'up' ? -1 : message.direction === 'down' ? 1 : 0);
      if (next >= 0 && next < items.length && next !== index) {
        [items[index], items[next]] = [items[next], items[index]];
      }
      return saveItems(items);
    }
    case 'wheel:activate': {
      let item = items.find((candidate) => candidate.id === message.itemId);
      if (!item && typeof message.itemId === 'string' && message.itemId.startsWith('tab:')) {
        const prefix = `tab:${currentSession}:`;
        const value = message.itemId.startsWith(prefix) ? message.itemId.slice(prefix.length) : '';
        if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
          throw new Error('这个标签已失效，请重新呼出轮盘。');
        }
        try {
          const tab = await chrome.tabs.get(Number(value));
          if (!tabUrl(tab) || tab.id !== Number(value)) throw new Error('invalid tab');
          item = { tabId: tab.id, windowId: tab.windowId, available: true };
        } catch {
          throw new Error('这个标签已关闭，请重新呼出轮盘。');
        }
      }
      if (!item?.available || !Number.isInteger(item.tabId)) {
        throw new Error('这个标签已关闭。重新打开同一网址后，它会自动恢复。');
      }
      try {
        // Never navigate or create tabs: activate exactly the resolved live tab.
        await chrome.tabs.update(item.tabId, { active: true });
        await chrome.windows.update(item.windowId, { focused: true });
      } catch {
        await readState();
        throw new Error('标签刚刚关闭或窗口已不可用，请重新呼出轮盘。');
      }
      return { ok: true };
    }
    default:
      throw new Error('未知的轮盘操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('wheel:')) return false;
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === 'wheel:get-icon') {
    getIcon(message.tabId).then(sendResponse);
    return true;
  }
  serialized(() => handleMessage(message, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || '操作失败，请稍后重试。' }));
  return true;
});

function refreshMetadata() {
  serialized(readState).catch((error) => console.warn('标签轮盘状态更新失败', error));
  scheduleTabsChanged();
}

function scheduleTabsChanged() {
  clearTimeout(tabsChangedTimer);
  tabsChangedTimer = setTimeout(async () => {
    // Notifications carry no tab metadata and never create storage writes.
    chrome.runtime.sendMessage({ type: 'wheel:tabs-changed' }).catch(() => {});
    try {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && /^(https?:|file:)/.test(tabUrl(tab)))
        .map((tab) => chrome.tabs.sendMessage(tab.id, { type: 'wheel:tabs-changed' }).catch(() => {})));
    } catch { /* A window may disappear during notification. */ }
  }, 150);
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab && ('url' in changeInfo || 'favIconUrl' in changeInfo)) iconCache.delete(tabUrl(tab));
  if (['title', 'url', 'favIconUrl', 'status'].some((key) => key in changeInfo)) refreshMetadata();
});
chrome.tabs.onRemoved.addListener(refreshMetadata);
chrome.tabs.onCreated.addListener(refreshMetadata);
chrome.tabs.onAttached.addListener(refreshMetadata);
chrome.tabs.onDetached.addListener(refreshMetadata);
chrome.tabs.onMoved.addListener(refreshMetadata);
chrome.tabs.onActivated.addListener(scheduleTabsChanged);
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  serialized(async () => {
    const [data, currentSession] = await Promise.all([
      chrome.storage.local.get('wheelItems'), sessionId()
    ]);
    const items = cleanItems(data.wheelItems);
    for (const item of items) {
      if (item.sessionId === currentSession && item.tabId === removedTabId) item.tabId = addedTabId;
    }
    await chrome.storage.local.set({ wheelItems: items });
    await readState();
    scheduleTabsChanged();
  }).catch((error) => console.warn('标签轮盘标签替换失败', error));
});
chrome.runtime.onInstalled.addListener(refreshMetadata);
chrome.runtime.onStartup.addListener(refreshMetadata);
