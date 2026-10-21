"use strict";

function htmlUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'file:' || !/\.html$/i.test(decodeURIComponent(url.pathname))) {
    throw new Error('请打开本地 .html 文件。');
  }
  url.hash = '';
  url.search = '';
  return url.href;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['ln-read-source', 'ln-open-save'].includes(message.type)) return;
  (async () => {
    if (!sender.tab || sender.frameId !== 0) throw new Error('无效的页面请求。');
    const url = htmlUrl(sender.tab.url);
    if (message.type === 'ln-read-source') {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('无法读取原 HTML，请检查文件访问权限并刷新页面。');
      const bytes = await response.arrayBuffer();
      let source;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('本期仅支持 UTF-8 HTML，请先转换文件编码。'); }
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
      return { source, hash, name: decodeURIComponent(new URL(url).pathname.split('/').pop()) };
    }
    if (!/^[\w-]+$/.test(message.session)) throw new Error('无效的保存会话。');
    const saveUrl = chrome.runtime.getURL(`save.html?tab=${sender.tab.id}&session=${message.session}`);
    if (Number.isInteger(message.saveTabId)) {
      const existing = await chrome.tabs.get(message.saveTabId).catch(() => null);
      if (existing?.url === saveUrl) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.runtime.sendMessage({ type: 'ln-save-now', session: message.session }).catch(() => {});
        return { tabId: existing.id };
      }
    }
    const tab = await chrome.tabs.create({ url: saveUrl });
    return { tabId: tab.id };
  })().then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('save.html') });
});
