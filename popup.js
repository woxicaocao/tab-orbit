'use strict';

const $ = (id) => document.getElementById(id);
let state = { tabs: [], items: [], wheelItems: [], settings: { mode: 'custom' }, maxItems: 24, totalTabs: 0 };
let scope = 'current';
let busy = false;
let refreshTimer;
let toastTimer;
let loadRevision = 0;
const iconCache = new Map();

function notify(message, error = false) {
  clearTimeout(toastTimer);
  const element = $('status');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 4500 : 2000);
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展暂时没有响应，请重新打开面板。');
  return response;
}

function displayUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'chrome:') return `Chrome · ${parsed.hostname}`;
    if (parsed.protocol === 'file:') return `本地文件 · ${decodeURIComponent(parsed.pathname.split('/').pop() || parsed.pathname)}`;
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

function iconFor(item) {
  const icon = document.createElement('div');
  icon.className = 'favicon';
  icon.setAttribute('aria-hidden', 'true');
  const letter = (item.title || displayUrl(item.url) || '页').trim().charAt(0).toUpperCase();
  icon.textContent = letter;
  const tabId = item.tabId ?? item.id;
  if (Number.isInteger(tabId)) {
    const key = `${tabId}:${item.url}:${item.favIconUrl || ''}`;
    let pending = iconCache.get(key);
    if (!pending) {
      pending = request({ type: 'wheel:get-icon', tabId })
        .then((result) => typeof result.dataUrl === 'string' ? result.dataUrl : '')
        .catch(() => '');
      iconCache.set(key, pending);
      while (iconCache.size > 100) iconCache.delete(iconCache.keys().next().value);
    }
    pending.then((dataUrl) => {
      if (!dataUrl) {
        if (iconCache.get(key) === pending) iconCache.delete(key);
        return;
      }
      if (!icon.isConnected || dataUrl.length > 128 * 1024 || !/^data:image\/png;base64,/.test(dataUrl)) return;
      const image = document.createElement('img');
      image.alt = '';
      image.addEventListener('error', () => { icon.textContent = letter; }, { once: true });
      image.src = dataUrl;
      icon.replaceChildren(image);
    });
  }
  return icon;
}

function infoFor(item, current = false) {
  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = item.title || '未命名标签';
  title.title = item.title || item.url;
  if (current) {
    const mark = document.createElement('span');
    mark.className = 'current-mark';
    mark.textContent = '当前';
    title.append(mark);
  }
  const url = document.createElement('p');
  url.className = 'url';
  url.textContent = displayUrl(item.url);
  url.title = item.url;
  info.append(title, url);
  return info;
}

function iconButton(text, label, action, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled || busy;
  button.addEventListener('click', action);
  return button;
}

function renderMode() {
  const mode = state.settings?.mode === 'all' ? 'all' : 'custom';
  for (const name of ['custom', 'all']) {
    const button = $(`mode-${name}`);
    button.classList.toggle('selected', mode === name);
    button.setAttribute('aria-pressed', String(mode === name));
    button.disabled = busy;
  }
  $('mode-status').textContent = mode === 'all' ? `所有标签 · ${state.totalTabs} 个` : '自定义标签';
  $('mode-description').textContent = mode === 'all'
    ? `当前有 ${state.totalTabs} 个可切换标签，自动同步所有窗口。`
    : '只显示你添加的标签，较多标签自动分成两圈。';
  $('custom-edit-hint').hidden = mode !== 'all';
}

function renderWheel() {
  $('wheel-count').textContent = `${state.items.length} / ${state.maxItems}`;
  const container = $('wheel-items');
  container.replaceChildren();
  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty wheel-empty';
    const glyph = document.createElement('span');
    glyph.className = 'empty-icon';
    glyph.textContent = '◎';
    glyph.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = '打造你的专属轮盘';
    empty.append(glyph, title, '从下方添加常用标签，最多 24 个');
    container.append(empty);
    return;
  }
  state.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `wheel-row${item.available ? '' : ' closed'}`;
    const position = document.createElement('span');
    position.className = 'position';
    position.textContent = String(index + 1).padStart(2, '0');
    const target = document.createElement('div');
    target.className = 'saved-target';
    target.setAttribute('role', 'button');
    target.tabIndex = 0;
    target.title = item.available ? `切换到「${item.title}」` : '这个标签已关闭，重新打开同一网址后自动恢复';
    target.setAttribute('aria-label', target.title);
    const activate = async () => {
      if (busy) return;
      try {
        await request({ type: 'wheel:activate', itemId: item.id });
        window.close();
      } catch (error) {
        notify(error.message, true);
        scheduleRefresh();
      }
    };
    target.addEventListener('click', activate);
    target.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
    target.append(iconFor(item), infoFor(item));
    row.append(position, target);
    if (!item.available) {
      const badge = document.createElement('span');
      badge.className = 'closed-badge';
      badge.textContent = '已关闭';
      badge.title = '重新打开完全相同的网址后会自动恢复';
      row.append(badge);
    }
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(
      iconButton('↑', `将「${item.title}」往前移`, () => mutate({ type: 'wheel:move-item', itemId: item.id, direction: 'up' }), index === 0),
      iconButton('↓', `将「${item.title}」往后移`, () => mutate({ type: 'wheel:move-item', itemId: item.id, direction: 'down' }), index === state.items.length - 1)
    );
    const remove = iconButton('×', `从轮盘移除「${item.title}」`, () => mutate({ type: 'wheel:remove-item', itemId: item.id }, '已从轮盘移除'));
    remove.classList.add('remove');
    actions.append(remove);
    row.append(actions);
    container.append(row);
  });
}

function renderTabs() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const tabs = state.tabs.filter((tab) => (scope === 'all' || tab.currentWindow) &&
    (!query || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(query)));
  const container = $('open-tabs');
  container.replaceChildren();
  $('tabs-count').textContent = `${tabs.length} 个标签`;
  if (!tabs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query ? '没有找到匹配的标签' : '这个窗口还没有可添加的标签';
    container.append(empty);
    return;
  }
  tabs.forEach((tab) => {
    const selected = state.items.some((item) => item.available && item.tabId === tab.id);
    const row = document.createElement('div');
    row.className = 'tab-row';
    row.append(iconFor(tab), infoFor(tab, tab.active && tab.currentWindow));
    const button = document.createElement('button');
    button.className = `add-button${selected ? ' added' : ''}`;
    button.type = 'button';
    button.textContent = selected ? '✓ 已添加' : '＋ 添加';
    button.setAttribute('aria-label', `${selected ? '从轮盘移除' : '添加到轮盘'}「${tab.title}」`);
    button.title = selected ? '点击从轮盘移除' : state.items.length >= state.maxItems ? '轮盘已满，请先移除一个标签' : '添加到轮盘';
    button.disabled = busy;
    button.addEventListener('click', () => mutate({ type: 'wheel:toggle-tab', tabId: tab.id }, selected ? '已从轮盘移除' : '已添加到轮盘'));
    row.append(button);
    container.append(row);
  });
}

function render() {
  const wheelScroll = $('wheel-items').scrollTop;
  const tabsScroll = $('open-tabs').scrollTop;
  renderMode();
  renderWheel();
  renderTabs();
  $('wheel-items').scrollTop = wheelScroll;
  $('open-tabs').scrollTop = tabsScroll;
}

async function refresh() {
  if (busy) { scheduleRefresh(); return; }
  const revision = ++loadRevision;
  try {
    const response = await request({ type: 'wheel:list-tabs' });
    if (revision !== loadRevision) return;
    state = response;
    render();
  } catch (error) {
    if (revision !== loadRevision) return;
    notify(error.message, true);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 90);
}

async function mutate(message, successMessage) {
  if (busy) return;
  ++loadRevision;
  busy = true;
  render();
  try {
    const response = await request(message);
    ++loadRevision;
    state = { ...state, ...response, maxItems: response.maxItems || 24 };
    if (successMessage) notify(successMessage);
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    render();
    scheduleRefresh();
  }
}

$('search').addEventListener('input', renderTabs);
for (const mode of ['custom', 'all']) {
  $(`mode-${mode}`).addEventListener('click', () => {
    mutate({ type: 'wheel:set-mode', mode }, mode === 'all' ? '已切换：所有已开标签会自动显示在轮盘中' : '已切换：轮盘只显示自定义标签');
  });
}
for (const name of ['current', 'all']) {
  $(`scope-${name}`).addEventListener('click', () => {
    scope = name;
    for (const other of ['current', 'all']) {
      $(`scope-${other}`).classList.toggle('selected', other === name);
      $(`scope-${other}`).setAttribute('aria-pressed', String(other === name));
    }
    renderTabs();
    $('open-tabs').scrollTop = 0;
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    $('search').focus();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.wheelItems || changes.wheelSettings)) scheduleRefresh();
});
chrome.tabs.onUpdated.addListener(scheduleRefresh);
chrome.tabs.onCreated.addListener(scheduleRefresh);
chrome.tabs.onRemoved.addListener(scheduleRefresh);
chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onAttached.addListener(scheduleRefresh);
chrome.tabs.onDetached.addListener(scheduleRefresh);
chrome.tabs.onMoved.addListener(scheduleRefresh);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'wheel:tabs-changed') scheduleRefresh();
});
$('open-manager').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^(https?:|file:)/.test(tab.url || '')) {
      throw new Error('请先切换到普通网页，再打开页面内管理。');
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'wheel:open-manager' });
    window.close();
  } catch (error) {
    const known = error.message?.startsWith('请先');
    notify(known ? error.message : '请刷新当前网页后再试。Chrome 受限页面无法打开页面内管理。', true);
  }
});
refresh();
