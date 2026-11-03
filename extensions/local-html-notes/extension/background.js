"use strict";

importScripts('core.js', 'handles.js');
const savingUrls = new Set();

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
  if (!['ln-read-source', 'ln-save', 'ln-open-save'].includes(message.type)) return;
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
    if (message.type === 'ln-save') {
      if (savingUrls.has(url)) throw new Error('正在保存此文件，请稍后再试。');
      savingUrls.add(url);
      try {
        const native = typeof chrome.runtime.sendNativeMessage === 'function';
        let handle;
        if (!native) {
          try { handle = await LocalHtmlHandles.get(url); }
          catch { return { needsAuthorization: true }; }
          if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
            return { needsAuthorization: true };
          }
        }
        const send = payload => chrome.tabs.sendMessage(sender.tab.id, { ...payload, session: message.session }, { frameId: 0 });
        const response = await send({ type: 'ln-snapshot', serialize: true });
        if (!response?.ok) throw new Error(response?.error || '原报告页已关闭或刷新，请重新保存。');
        const current = response.snapshot;
        if (htmlUrl(current.url) !== url || typeof current.serializedSource !== 'string') {
          throw new Error('报告页已变化，未覆盖文件，请刷新后重试。');
        }
        current.name = decodeURIComponent(new URL(url).pathname.split('/').pop());
        const ready = await send({ type: 'ln-saving' });
        if (!ready?.ok) throw new Error('原报告页已关闭或刷新，未写入文件。');
        let result;
        if (native) {
          let response;
          try {
            response = await chrome.runtime.sendNativeMessage('com.karazhan.local_html_notes', {
              operation: 'save', url, expectedHash: current.hash, source: current.serializedSource
            });
          } catch { throw new Error('无法连接本机保存助手。请按扩展使用说明安装或更新助手，再重新加载扩展。'); }
          if (!response?.ok) throw new Error(response?.error || '本机助手保存失败，未确认写入。');
          if (response.hash !== await LocalHtmlNotes.hash(current.serializedSource)) throw new Error('助手返回的内容摘要不一致。请重新打开原文件查看，勿直接重试覆盖。');
          result = { source: current.serializedSource, hash: response.hash };
        } else {
          result = await LocalHtmlNotes.writeFile(handle, current, current.serializedSource);
        }
        const acknowledgement = await send({ type: 'ln-saved', ...result, revision: current.revision }).catch(() => null);
        if (!acknowledgement?.ok) throw new Error('文件已写入，但报告页未确认。请重新打开文件查看，勿直接重试覆盖。');
        return {};
      } catch (error) {
        if (['NotAllowedError', 'NotFoundError'].includes(error.name)) return { needsAuthorization: true };
        throw error;
      } finally { savingUrls.delete(url); }
    }
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
