(() => {
  'use strict';
  function key(url) {
    const value = new URL(url);
    if (value.protocol !== 'file:' || !/\.html$/i.test(decodeURIComponent(value.pathname))) {
      throw new Error('只能记住本地 HTML 文件。');
    }
    value.search = ''; value.hash = '';
    return value.href;
  }
  function access(action, url, handle) {
    const fileUrl = key(url);
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open('local-html-file-access', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('files');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction('files', action === 'get' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore('files');
        let request;
        try { request = action === 'put' ? store.put(handle, fileUrl) : store[action](fileUrl); }
        catch (error) { db.close(); reject(error); return; }
        transaction.oncomplete = () => { db.close(); resolve(request.result); };
        transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  }
  globalThis.LocalHtmlHandles = {
    get: url => access('get', url),
    set: (url, handle) => access('put', url, handle),
    forget: url => access('delete', url)
  };
})();
