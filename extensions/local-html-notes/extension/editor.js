(() => {
  'use strict';
  if (location.protocol !== 'file:' || !/\.html$/i.test(decodeURIComponent(location.pathname))) return;
  const claim = () => { if (document.documentElement) document.documentElement.dataset.lnEditing = '1'; };
  claim();
  if (!document.documentElement) {
    const observer = new MutationObserver(() => { claim(); if (document.documentElement) observer.disconnect(); });
    observer.observe(document, { childList: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  async function boot() {
    const core = globalThis.LocalHtmlNotes;
    const session = crypto.randomUUID();
    let source, baselineHash, name, notes = [], revision = 0, savedRevision = 0;
    let selection = null, activeNote = null, editingMessageId = null, saveTabId, ready = false, writing = false;
    let watcher, unresolvedCount = 0;
    document.querySelector('[data-ln-ui="viewer"]')?.remove();
    const host = document.createElement('div');
    host.dataset.lnUi = 'editor';
    host.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial;color-scheme:light}*{box-sizing:border-box}button,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}
        .bar,.popover,dialog{pointer-events:auto;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#302c26;background:#fffdf7;border:1px solid #d9d2c4;box-shadow:0 6px 24px #29201524;border-radius:12px}
        .bar{position:absolute;right:16px;top:14px;display:flex;align-items:center;gap:12px;padding:9px 12px;max-width:calc(100vw - 32px)}
        .brand{font-weight:650;white-space:nowrap}.state{font-size:12px;max-width:330px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        button{border:1px solid #d8d0c1;border-radius:7px;background:#fffdf7;color:inherit;padding:6px 10px}button:hover{background:#f4efe4}button:focus-visible,textarea:focus-visible{outline:2px solid #306c65;outline-offset:2px}
        .primary{background:#306c65;color:white;border-color:#306c65}.primary:hover{background:#25564f}.danger{color:#a13232}
        .popover{position:absolute;padding:9px;display:flex;gap:7px;align-items:center;max-width:calc(100vw - 16px);flex-wrap:wrap}.popover[hidden]{display:none}
        .swatch{width:28px;height:28px;padding:0;border-radius:50%;border:1px solid #0003}.swatch:hover{outline:2px solid #776c5c;outline-offset:2px}
        [data-color="yellow"]{background:#ffe28a}[data-color="green"]{background:#bfe6b2}[data-color="blue"]{background:#b9ddfb}[data-color="pink"]{background:#f6c5d8}
        dialog{position:fixed;margin:auto;width:min(560px,calc(100vw - 32px));padding:22px;max-height:85vh;overflow:auto}dialog::backdrop{background:#16120c40}
        h2{font-size:18px;margin:0 0 12px}blockquote{margin:0 0 14px;padding-left:12px;border-left:3px solid #d6cbb7;color:#756956;max-height:90px;overflow:auto;white-space:pre-wrap}
        label{display:block;margin-bottom:6px}textarea{display:block;resize:vertical;min-height:120px;width:100%;padding:10px;border:1px solid #ccc3b3;border-radius:7px;color:#302c26;background:white}
        .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}.notice{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);background:#302c26;color:#fffdf7;padding:10px 16px;border-radius:9px;pointer-events:auto;font:14px/1.5 system-ui}.notice[hidden]{display:none}
        .reply-hint{font-size:12px;color:#81796c;margin:9px 0 0}[hidden]{display:none!important}
        ${core.THREAD_STYLE}
        @media(max-width:600px){.brand{display:none}.state{max-width:45vw}}
      </style>
      <div class="bar" aria-label="HTML 批注工具">
        <span class="brand">HTML 批注</span><span class="state" role="status">正在读取原文件…</span>
        <button class="primary" id="save" disabled>保存</button>
      </div>
      <div class="popover" hidden role="toolbar" aria-label="高亮颜色">
        ${Object.entries(core.COLORS).map(([color, label]) => `<button class="swatch" data-color="${color}" aria-label="${label}高亮" title="${label}"></button>`).join('')}
        <button id="comment" hidden>评论</button><button id="remove" class="danger" hidden>删除高亮</button>
      </div>
      <dialog aria-labelledby="comment-title"><form method="dialog">
        <h2 id="comment-title">评论对话</h2><blockquote></blockquote>
        <div class="messages" aria-live="polite"></div>
        <label for="note" id="reply-label">回复</label><textarea id="note" placeholder="输入你的回复…"></textarea>
        <p class="reply-hint">添加后请关闭对话并保存文件。LLM 写回回复后，刷新报告页查看。</p>
        <div class="actions"><button type="button" id="cancel-edit" hidden>取消编辑</button><button value="close">关闭</button><button type="button" class="primary" id="save-comment">添加回复</button></div>
      </form></dialog>
      <div class="notice" role="alert" hidden></div>`;
    document.documentElement.append(host);
    const status = shadow.querySelector('.state');
    const save = shadow.querySelector('#save');
    const popover = shadow.querySelector('.popover');
    const dialog = shadow.querySelector('dialog');
    const textarea = shadow.querySelector('textarea');
    const messages = shadow.querySelector('.messages');
    const notice = shadow.querySelector('.notice');
    let noticeTimer;

    function setStatus(text) { status.textContent = text; status.title = text; }
    function tell(text) {
      notice.textContent = text;
      notice.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { notice.hidden = true; }, 6500);
    }
    function hidePopover() { popover.hidden = true; selection = null; }
    function annotationStatus() {
      if (writing) return;
      const state = revision !== savedRevision ? '未保存' : savedRevision ? '已保存' : notes.length ? '已载入' : '选中文字开始批注';
      setStatus(unresolvedCount ? `${state} · ${unresolvedCount} 条批注待定位，数据已保留` : notes.length ? `${state} · ${notes.length} 条高亮` : state);
    }
    function render() {
      watcher.refresh();
    }
    function changed() {
      revision++;
      render();
      annotationStatus();
      hidePopover();
    }
    function positionPopover(rect) {
      popover.hidden = false;
      const box = popover.getBoundingClientRect();
      popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`;
      popover.style.top = `${Math.max(8, Math.min(rect.top > box.height + 12 ? rect.top - box.height - 8 : rect.bottom + 8, innerHeight - box.height - 8))}px`;
    }
    function showNote(id, rect) {
      activeNote = id;
      selection = null;
      shadow.querySelector('#comment').hidden = false;
      shadow.querySelector('#remove').hidden = false;
      positionPopover(rect);
    }
    function resetComposer() {
      editingMessageId = null;
      textarea.value = '';
      textarea.setCustomValidity('');
      shadow.querySelector('#reply-label').textContent = '回复';
      shadow.querySelector('#save-comment').textContent = '添加回复';
      shadow.querySelector('#cancel-edit').hidden = true;
    }
    function paintThread() {
      const note = notes.find(n => n.id === activeNote);
      if (!note) return;
      core.renderMessages(messages, note, {
        onEdit(id) {
          const message = note.messages.find(m => m.id === id && m.role === 'user');
          if (!message) return;
          editingMessageId = id;
          textarea.value = message.content;
          textarea.setCustomValidity('');
          shadow.querySelector('#reply-label').textContent = '编辑你的消息';
          shadow.querySelector('#save-comment').textContent = '保存修改';
          shadow.querySelector('#cancel-edit').hidden = false;
          textarea.focus();
        },
        onDelete(id) {
          if (!note.messages.some(m => m.id === id && m.role === 'user')) return;
          note.messages = note.messages.filter(m => m.id !== id);
          note.updatedAt = new Date().toISOString();
          if (editingMessageId === id) resetComposer();
          changed();
          paintThread();
        }
      });
      messages.scrollTop = messages.scrollHeight;
    }
    function editComment(id) {
      const note = notes.find(n => n.id === id);
      if (!note) return;
      activeNote = id;
      hidePopover();
      shadow.querySelector('blockquote').textContent = note.selector.exact;
      resetComposer();
      paintThread();
      if (!dialog.open) dialog.showModal();
      messages.scrollTop = messages.scrollHeight;
      textarea.focus();
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'ln-read-source' });
      if (!response?.ok) throw new Error(response?.error || '无法读取文件，请允许访问文件 URL 并刷新。');
      ({ source, hash: baselineHash, name } = response);
      const original = core.parse(source);
      notes = core.readNotes(original);
      const existingStyle = document.getElementById('local-notes-style');
      if (!existingStyle) {
        const style = document.createElement('style');
        style.id = 'local-notes-style';
        style.dataset.lnOwned = '1';
        style.textContent = core.STYLE;
        document.head.append(style);
      }
      watcher = core.watchNotes(document, () => notes, (result, external) => {
        unresolvedCount = result.unresolved.length;
        if (external) hidePopover();
        annotationStatus();
      });
      ready = true;
      save.disabled = false;
      annotationStatus();
    } catch (error) {
      delete document.documentElement.dataset.lnEditing;
      setStatus(error.message);
      tell(error.message);
    }

    document.addEventListener('mouseup', event => {
      if (!ready || event.composedPath().includes(host) || dialog.open) return;
      const selected = getSelection();
      if (!selected?.rangeCount || selected.isCollapsed || !selected.toString().trim()) return;
      const range = selected.getRangeAt(0);
      if (range.startContainer.parentElement?.closest('[contenteditable],textarea,input,[data-ln-ui]') ||
          range.endContainer.parentElement?.closest('[contenteditable],textarea,input,[data-ln-ui]')) return;
      try {
        const position = core.positionFromRange(document, range);
        if (position.start === position.end) return;
        if (core.overlaps(core.resolveNotes(document, notes).resolved, position)) {
          hidePopover();
          tell('选区与已有高亮重叠。请点击已有高亮修改颜色或评论。');
          return;
        }
        activeNote = null;
        selection = { range: range.cloneRange(), text: core.textIndex(document.body).text };
        shadow.querySelector('#comment').hidden = true;
        shadow.querySelector('#remove').hidden = true;
        positionPopover(range.getBoundingClientRect());
      } catch (error) { tell(error.message); }
    });

    document.addEventListener('pointerdown', event => {
      if (!event.composedPath().includes(host)) hidePopover();
    });
    document.addEventListener('click', event => {
      if (!ready || event.composedPath().includes(host) || !getSelection()?.isCollapsed) return;
      const mark = event.target.closest?.(core.MARKS);
      if (mark) {
        event.preventDefault();
        if (event.target.closest('[data-ln-ui="comment-badge"]')) editComment(mark.dataset.noteId);
        else showNote(mark.dataset.noteId, mark.getBoundingClientRect());
      }
    });
    document.addEventListener('dblclick', event => {
      if (!ready) return;
      const mark = event.target.closest?.(core.MARKS);
      if (mark) { event.preventDefault(); getSelection()?.removeAllRanges(); editComment(mark.dataset.noteId); }
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hidePopover(); });
    document.addEventListener('scroll', hidePopover, true);
    window.addEventListener('resize', hidePopover);
    popover.addEventListener('mousedown', event => event.preventDefault());
    popover.addEventListener('click', event => {
      const color = event.target.closest('[data-color]')?.dataset.color;
      if (!color) return;
      try {
        if (selection) {
          if (core.textIndex(document.body).text !== selection.text) throw new Error('选区内的页面内容已更新，请重新选择文字。');
          const position = core.positionFromRange(document, selection.range);
          if (core.overlaps(core.resolveNotes(document, notes).resolved, position)) throw new Error('选区与已有高亮重叠。');
          notes.push(core.capture(document, position, color));
        } else {
          const note = notes.find(n => n.id === activeNote);
          if (!note) return;
          note.color = color;
          note.updatedAt = new Date().toISOString();
        }
        getSelection()?.removeAllRanges();
        changed();
      } catch (error) { tell(error.message); }
    });
    shadow.querySelector('#comment').onclick = () => editComment(activeNote);
    shadow.querySelector('#remove').onclick = () => { notes = notes.filter(n => n.id !== activeNote); changed(); };
    shadow.querySelector('#cancel-edit').onclick = () => { resetComposer(); textarea.focus(); };
    textarea.oninput = () => textarea.setCustomValidity('');
    dialog.addEventListener('close', resetComposer);
    shadow.querySelector('#save-comment').onclick = () => {
      const note = notes.find(n => n.id === activeNote);
      if (!note) return;
      const content = textarea.value;
      if (!content.trim()) {
        textarea.setCustomValidity('请输入回复内容。');
        textarea.reportValidity();
        return;
      }
      const time = new Date().toISOString();
      if (editingMessageId) {
        const message = note.messages.find(m => m.id === editingMessageId && m.role === 'user');
        if (!message) return;
        message.content = content;
        message.editedAt = time;
      } else {
        note.messages.push({ id: crypto.randomUUID(), role: 'user', content, createdAt: time });
      }
      note.updatedAt = time;
      resetComposer();
      changed();
      paintThread();
      textarea.focus();
    };

    save.onclick = async () => {
      try {
        if (!writing) setStatus('请在保存页授权或确认保存');
        const response = await chrome.runtime.sendMessage({ type: 'ln-open-save', session, saveTabId });
        if (!response?.ok) throw new Error(response?.error || '无法打开保存页。');
        saveTabId = response.tabId;
      } catch (error) { tell(error.message); }
    };
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.id !== chrome.runtime.id || message.session !== session) return;
      try {
        if (message.type === 'ln-snapshot') {
          if (!ready) throw new Error('批注工具尚未就绪。');
          reply({ ok: true, snapshot: { source, hash: baselineHash, notes: structuredClone(notes), revision, name, url: location.href } });
        } else if (message.type === 'ln-saving') {
          writing = true; save.disabled = true; setStatus('保存中…'); reply({ ok: true });
        } else if (message.type === 'ln-saved') {
          source = message.source;
          baselineHash = message.hash;
          savedRevision = message.revision;
          writing = false; save.disabled = false;
          annotationStatus();
          if (message.warning) tell(message.warning);
          reply({ ok: true });
        } else if (message.type === 'ln-save-error') {
          writing = false; save.disabled = false;
          setStatus(message.error);
          tell(message.error); reply({ ok: true });
        }
      } catch (error) { reply({ ok: false, error: error.message }); }
      return false;
    });
    window.addEventListener('beforeunload', event => {
      if (revision !== savedRevision || writing) { event.preventDefault(); event.returnValue = ''; }
    });
  }
})();
