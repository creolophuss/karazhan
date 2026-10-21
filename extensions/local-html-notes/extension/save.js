(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tab'));
  const session = params.get('session');
  const choose = document.querySelector('#choose');
  const again = document.querySelector('#again');
  const back = document.querySelector('#return');
  const forget = document.querySelector('#forget');
  const status = document.querySelector('#status');
  let handle = null, busy = false, currentUrl, remembered = false, storageWarning = '';

  function show(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function message(type, payload = {}) {
    return chrome.tabs.sendMessage(tabId, { type, session, ...payload });
  }
  function storageFailed() {
    storageWarning = '无法记住文件授权。当前仍可保存；关闭保存页后可能需要重新选择文件。';
    document.querySelector('#storage-status').textContent = storageWarning;
  }
  async function reportError(error) {
    const text = error.name === 'AbortError' ? '已取消选择，批注尚未保存。' :
      error.name === 'NotAllowedError' ? '未获得文件写权限，请点击「确认授权并保存」，或重新选择原文件。' :
      error.name === 'NotFoundError' ? '原文件已移动或删除，请重新选择当前报告的原文件。' : error.message;
    show(text, true);
    await message('ln-save-error', { error: text }).catch(() => {});
  }
  async function snapshot() {
    const response = await message('ln-snapshot');
    if (!response?.ok) throw new Error(response?.error || '原报告页已关闭或刷新，请从报告页重新保存。');
    return response.snapshot;
  }
  async function save(renewPermission = false) {
    if (busy || !handle) return;
    busy = true; choose.disabled = true; again.disabled = true; forget.disabled = true;
    try {
      // Permission renewal runs directly from the confirmation button's user gesture.
      const permission = await handle[renewPermission ? 'requestPermission' : 'queryPermission']({ mode: 'readwrite' });
      if (permission !== 'granted') {
        again.hidden = false;
        again.textContent = '确认授权并保存';
        throw new DOMException('需要重新确认文件写权限。', 'NotAllowedError');
      }
      const current = await snapshot();
      await message('ln-saving');
      show('正在写入原文件，请保持本页打开…');
      const result = await LocalHtmlNotes.writeFile(handle, current);
      if (!remembered) {
        try {
          await LocalHtmlHandles.set(currentUrl, handle);
          remembered = true;
          storageWarning = '';
          document.querySelector('#storage-status').textContent = '';
        } catch { storageFailed(); }
      }
      const acknowledgement = await message('ln-saved', { ...result, revision: current.revision, warning: storageWarning });
      if (!acknowledgement?.ok) {
        throw new Error('文件已写入，但报告页未确认。请重新打开文件查看，勿直接重试覆盖。');
      }
      again.hidden = false;
      again.textContent = '保存当前修改';
      forget.hidden = false;
      show(`已保存 · ${current.notes.length} 条高亮`);
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    } catch (error) {
      await reportError(error);
    } finally {
      busy = false; choose.disabled = false; again.disabled = false; forget.disabled = false;
    }
  }

  choose.onclick = async () => {
    if (busy) return;
    busy = true; choose.disabled = true; again.disabled = true; forget.disabled = true;
    try {
      // The picker must be the first awaited operation after this user click.
      const [selected] = await showOpenFilePicker({
        id: 'local-html-original',
        multiple: false, types: [{ description: 'HTML 文件', accept: { 'text/html': ['.html'] } }], excludeAcceptAllOption: true
      });
      if (await selected.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new DOMException('未获得写权限。', 'NotAllowedError');
      }
      handle = selected;
      remembered = false;
      busy = false;
      await save();
    } catch (error) {
      await reportError(error);
    } finally {
      busy = false; choose.disabled = false; again.disabled = false; forget.disabled = false;
    }
  };
  again.onclick = () => save(true);
  back.onclick = () => chrome.tabs.update(tabId, { active: true });
  forget.onclick = async () => {
    if (busy) return;
    busy = true; choose.disabled = true; again.disabled = true; forget.disabled = true;
    try {
      await LocalHtmlHandles.forget(currentUrl);
      handle = null; remembered = false;
      again.hidden = true; forget.hidden = true;
      show('已忘记此文件。下次保存需要重新选择原文件。');
    } catch { storageFailed(); show('未能忘记文件授权，请重试。', true); }
    finally { busy = false; choose.disabled = false; again.disabled = false; forget.disabled = false; }
  };
  chrome.runtime.onMessage.addListener((event, sender) => {
    if (sender.id === chrome.runtime.id && event.type === 'ln-save-now' && event.session === session) {
      if (handle) void save();
      else show('请选择当前报告的原 HTML 文件，并允许写入。');
    }
  });
  window.addEventListener('beforeunload', event => {
    if (busy) { event.preventDefault(); event.returnValue = ''; }
  });

  if (session && Number.isInteger(tabId) && tabId > 0) {
    snapshot().then(async current => {
      currentUrl = current.url;
      document.querySelector('#filename').textContent = decodeURIComponent(new URL(currentUrl).pathname);
      if (typeof showOpenFilePicker !== 'function') throw new Error('当前 Edge 环境不支持文件选择器，请使用新版桌面 Edge。');
      try { handle = await LocalHtmlHandles.get(currentUrl); remembered = !!handle; }
      catch { storageFailed(); }
      back.hidden = false;
      if (!handle) { choose.disabled = false; show('首次保存请选择上面的原 HTML 文件。以后会记住授权。'); return; }
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      choose.disabled = false; again.hidden = false; forget.hidden = false;
      if (permission === 'granted') await save();
      else {
        again.textContent = '确认授权并保存';
        show('已记住原文件。点击「确认授权并保存」即可继续，无需重新选择文件。');
      }
    }).catch(error => { choose.disabled = false; return reportError(error); });
  }
})();
