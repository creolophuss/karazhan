(() => {
  "use strict";
  function annotationRuntime() {
    const COLORS = { yellow: "黄色", green: "绿色", blue: "蓝色", pink: "粉色" };
    const OWNED = '[data-ln-owned="1"]';
    const MARKS = `mark[data-note-id]${OWNED}`;
    const SKIP = 'script,style,noscript,template,textarea,input,select,svg,math,canvas,iframe,[data-ln-ui],[contenteditable]:not([contenteditable="false"])';
    const THREAD_STYLE = `
.messages{max-height:38vh;overflow:auto;overscroll-behavior:contain;margin:12px 0 16px}.message{border:1px solid #e2dbcf;border-radius:9px;padding:12px;margin:10px 0;background:#fffefa}.message[data-role="assistant"]{background:#f0f5f2;border-color:#d5e1da}.message header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:12px}.message strong{font-size:13px}.message time,.message .edited{color:#81796c}.message .message-body{white-space:pre-wrap;overflow-wrap:anywhere;margin:9px 0 0;line-height:1.65}.message .message-actions{display:flex;gap:6px;margin-left:auto}.message .message-actions button{font-size:12px;padding:3px 7px}.messages .empty{color:#81796c;font-size:13px}
`;

    function textIndex(root) {
      const doc = root.ownerDocument || root;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let text = "";
      for (let node; (node = walker.nextNode());) {
        if (node.parentElement?.closest(SKIP)) continue;
        nodes.push({ node, start: text.length, end: text.length + node.length });
        text += node.data;
      }
      return { text, nodes };
    }

    function unmark(doc) {
      for (const badge of doc.querySelectorAll('[data-ln-ui="comment-badge"][data-ln-owned="1"]')) badge.remove();
      for (const mark of doc.querySelectorAll(MARKS)) mark.replaceWith(...mark.childNodes);
      doc.body.normalize();
    }

    function validateNotes(notes) {
      if (!Array.isArray(notes)) throw new Error('批注列表无效。');
      const ids = new Set(), messageIds = new Set();
      for (const note of notes) {
        const p = note?.position;
        if (!note || typeof note.id !== 'string' || !/^[\w-]+$/.test(note.id) || ids.has(note.id) ||
            !Object.hasOwn(COLORS, note.color) || !Array.isArray(note.messages) || Object.hasOwn(note, 'comment') ||
            typeof note.createdAt !== 'string' || typeof note.updatedAt !== 'string' ||
            note.selector?.type !== 'TextQuoteSelector' || typeof note.selector.exact !== 'string' ||
            !note.selector.exact.length || typeof note.selector.prefix !== 'string' ||
            typeof note.selector.suffix !== 'string' || !Number.isSafeInteger(p?.start) ||
            !Number.isSafeInteger(p?.end) || p.start < 0 || p.end <= p.start) {
          throw new Error('批注数据无效，停止保存。');
        }
        for (const message of note.messages) {
          if (!message || typeof message.id !== 'string' || !/^[\w-]+$/.test(message.id) || messageIds.has(message.id) ||
              !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() ||
              typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt)) ||
              (message.editedAt !== undefined && (typeof message.editedAt !== 'string' || !Number.isFinite(Date.parse(message.editedAt))))) {
            throw new Error('对话消息数据无效，停止保存。');
          }
          messageIds.add(message.id);
        }
        ids.add(note.id);
      }
      return structuredClone(notes);
    }

    function notesFromData(data) {
      if (data?.format !== 'local-html-notes' || ![1, 2].includes(data.version) || !Array.isArray(data.notes)) {
        throw new Error('不支持该批注数据版本，停止保存。');
      }
      if (data.version === 2) return validateNotes(data.notes);
      return validateNotes(data.notes.map(note => {
        if (typeof note?.comment !== 'string') throw new Error('旧批注数据无效，停止保存。');
        const { comment, ...rest } = note;
        return { ...rest, messages: comment.trim() ? [{ id: `legacy-${note.id}`, role: 'user', content: comment, createdAt: note.updatedAt }] : [] };
      }));
    }

    function threadSummary(note) {
      const last = note.messages[note.messages.length - 1];
      return last ? `${note.messages.length} 条消息 · ${last.role === 'user' ? '我' : 'LLM'}：${last.content.slice(0, 160)}${last.content.length > 160 ? '…' : ''}` : '';
    }

    function renderMessages(container, note, { onEdit, onDelete } = {}) {
      const doc = container.ownerDocument;
      container.replaceChildren();
      container.setAttribute('role', 'log');
      container.setAttribute('aria-label', '评论对话');
      if (!note.messages.length) {
        const empty = doc.createElement('p');
        empty.className = 'empty';
        empty.textContent = '暂无评论，添加第一条回复。';
        container.append(empty);
      }
      for (const message of note.messages) {
        const row = doc.createElement('article');
        row.className = 'message';
        row.dataset.messageId = message.id;
        row.dataset.role = message.role;
        const header = doc.createElement('header');
        const author = doc.createElement('strong');
        author.textContent = message.role === 'user' ? '我' : 'LLM';
        const time = doc.createElement('time');
        time.dateTime = message.createdAt;
        time.textContent = new Date(message.createdAt).toLocaleString('zh-CN');
        header.append(author, time);
        if (message.editedAt) {
          const edited = doc.createElement('span');
          edited.className = 'edited';
          edited.textContent = '已编辑';
          edited.title = new Date(message.editedAt).toLocaleString('zh-CN');
          header.append(edited);
        }
        if (message.role === 'user' && (onEdit || onDelete)) {
          const actions = doc.createElement('div');
          actions.className = 'message-actions';
          for (const [action, label, handler] of [['edit-message', '编辑', onEdit], ['delete-message', '删除', onDelete]]) {
            if (!handler) continue;
            const button = doc.createElement('button');
            button.type = 'button';
            button.dataset.action = action;
            button.textContent = label;
            button.onclick = () => handler(message.id);
            actions.append(button);
          }
          header.append(actions);
        }
        const body = doc.createElement('p');
        body.className = 'message-body';
        body.textContent = message.content;
        row.append(header, body);
        container.append(row);
      }
    }

    function applyNotes(doc, notes) {
      validateNotes(notes);
      const ordered = [...notes].sort((a, b) => a.position.start - b.position.start);
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].position.start < ordered[i - 1].position.end) throw new Error('高亮重叠，停止显示。');
      }
      const index = textIndex(doc.body);
      for (const note of notes) {
        if (note.position.end > index.text.length ||
            index.text.slice(note.position.start, note.position.end) !== note.selector.exact) {
          throw new Error('页面内容已更新，批注位置需要重新定位。');
        }
      }
      for (const note of [...notes].sort((a, b) => b.position.start - a.position.start)) {
        for (const entry of index.nodes) {
          const start = Math.max(entry.start, note.position.start);
          const end = Math.min(entry.end, note.position.end);
          if (end <= start) continue;
          const localStart = start - entry.start;
          const localEnd = end - entry.start;
          if (localEnd < entry.node.length) entry.node.splitText(localEnd);
          const selected = localStart ? entry.node.splitText(localStart) : entry.node;
          const mark = doc.createElement('mark');
          mark.className = `hl-${note.color}`;
          mark.dataset.noteId = note.id;
          mark.dataset.lnOwned = '1';
          if (note.messages.length) {
            mark.dataset.lnComment = '1';
            mark.title = threadSummary(note);
          }
          selected.replaceWith(mark);
          mark.append(selected);
        }
      }
      for (const note of notes) {
        if (!note.messages.length) continue;
        const marks = doc.querySelectorAll(`mark[data-ln-owned="1"][data-note-id="${note.id}"]`);
        const badge = doc.createElement('button');
        badge.type = 'button';
        badge.dataset.lnUi = 'comment-badge';
        badge.dataset.lnOwned = '1';
        badge.setAttribute('aria-label', '查看评论对话');
        badge.textContent = '•';
        marks[marks.length - 1].append(badge);
      }
    }

    function resolveNotes(doc, notes) {
      validateNotes(notes);
      const text = textIndex(doc.body).text;
      const resolved = [], unresolved = [];
      for (const note of notes) {
        const { exact, prefix, suffix } = note.selector;
        const candidates = [];
        for (let start = text.indexOf(exact); start !== -1; start = text.indexOf(exact, start + 1)) {
          const end = start + exact.length;
          let score = 0;
          for (let i = 1; i <= prefix.length && start >= i && text[start - i] === prefix[prefix.length - i]; i++) score++;
          for (let i = 0; i < suffix.length && text[end + i] === suffix[i]; i++) score++;
          candidates.push({ start, end, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        if (!best || (candidates.length > 1 && best.score === candidates[1].score)) {
          unresolved.push({ note, reason: best ? 'ambiguous' : 'missing' });
          continue;
        }
        if (resolved.some(other => best.start < other.position.end && best.end > other.position.start)) {
          unresolved.push({ note, reason: 'overlap' });
          continue;
        }
        resolved.push({ ...note, position: { type: 'TextPositionSelector', start: best.start, end: best.end } });
      }
      return { resolved, unresolved };
    }

    function watchNotes(doc, getNotes, onChange = () => {}) {
      let timer, previousText, marks = [];
      const observer = new MutationObserver(records => {
        const relevant = records.some(record => {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          return !target?.closest(SKIP);
        });
        if (!relevant) return;
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          if (!doc.body) return;
          if (textIndex(doc.body).text !== previousText || marks.some(mark => !doc.body.contains(mark))) refresh(true);
        }, 80);
      });
      function refresh(external = false) {
        observer.disconnect();
        let result;
        try {
          result = resolveNotes(doc, getNotes());
          unmark(doc);
          applyNotes(doc, result.resolved);
          previousText = textIndex(doc.body).text;
          marks = [...doc.querySelectorAll(MARKS)];
        } finally {
          observer.observe(doc.documentElement, { childList: true, characterData: true, subtree: true });
        }
        onChange(result, external);
        return result;
      }
      refresh();
      return { refresh, disconnect() { clearTimeout(timer); observer.disconnect(); } };
    }

    return { COLORS, MARKS, THREAD_STYLE, textIndex, unmark, validateNotes, notesFromData, threadSummary, renderMessages, applyNotes, resolveNotes, watchNotes };
  }
  const runtime = annotationRuntime();
  const { COLORS, MARKS, THREAD_STYLE, textIndex, unmark, validateNotes, notesFromData, threadSummary, renderMessages, applyNotes, resolveNotes, watchNotes } = runtime;
  const OWNED = '[data-ln-owned="1"]';
  const LLM_PROTOCOL = ` LOCAL_HTML_NOTES_LLM_PROTOCOL_V2
This HTML contains per-highlight conversations in script#notes-data (application/json).
The envelope is {"format":"local-html-notes","version":2,"notes":[...]}.
Each note has a stable id, a selector with exact/prefix/suffix text, and a messages array in conversation order.
When asked to reply, read the selected quote and the full conversation. Only reply if the last message has role "user". Skip empty threads and threads ending with "assistant"; do not duplicate a completed reply.
Append a new message: {"id":"a-new-unique-UUID","role":"assistant","content":"your plain-text reply","createdAt":"current UTC ISO-8601 timestamp"}. Set the note.updatedAt to that timestamp.
User messages use role "user". editedAt is optional and records edits. Keep existing messages, IDs and timestamps unchanged.
Only replace the JSON text inside script#notes-data. Preserve all other file bytes, scripts, styles, selectors, colors, and note IDs. Escape the less-than character as \\u003c in JSON to protect the script block. Write back to the same file. Do not create backups or sidecar files.
The user will refresh the page to read your reply and can append another user message.
`;

  const STYLE = `
mark[data-ln-owned="1"] { color:inherit!important; padding:0!important; border:0!important; border-radius:2px; box-decoration-break:clone; -webkit-box-decoration-break:clone; cursor:pointer; }
mark.hl-yellow[data-ln-owned="1"] { background:#ffe28a!important; }
mark.hl-green[data-ln-owned="1"] { background:#bfe6b2!important; }
mark.hl-blue[data-ln-owned="1"] { background:#b9ddfb!important; }
mark.hl-pink[data-ln-owned="1"] { background:#f6c5d8!important; }
button[data-ln-ui="comment-badge"] { all:unset!important; display:inline!important; color:#654b33!important; font-size:.8em!important; vertical-align:super!important; cursor:pointer!important; padding:0 2px!important; }
button[data-ln-ui="comment-badge"]:focus-visible { outline:2px solid #306c65!important; }
`;

  function readNotes(doc) {
    const blocks = doc.querySelectorAll('#notes-data');
    if (!blocks.length) {
      if (doc.querySelector(MARKS)) throw new Error('已有高亮的批注数据丢失，停止保存。');
      return [];
    }
    if (blocks.length !== 1 || blocks[0].getAttribute('data-ln-owned') !== '1') {
      throw new Error('已有 notes-data 不属于本工具，停止保存以保护原数据。');
    }
    let data;
    try { data = JSON.parse(blocks[0].textContent); }
    catch { throw new Error('批注数据损坏，停止保存。'); }
    return notesFromData(data);
  }

  function positionFromRange(doc, range) {
    if (!doc.body.contains(range.startContainer) || !doc.body.contains(range.endContainer)) {
      throw new Error('请选择正文文字。');
    }
    const prefix = doc.createRange();
    prefix.selectNodeContents(doc.body);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = textIndex(prefix.cloneContents()).text.length;
    prefix.setEnd(range.endContainer, range.endOffset);
    const end = textIndex(prefix.cloneContents()).text.length;
    return { start, end };
  }

  function nodePath(root, node) {
    const path = [];
    while (node !== root) {
      path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
      node = node.parentNode;
    }
    return path;
  }

  function capture(doc, position, color) {
    const index = textIndex(doc.body);
    const { start, end } = position;
    const first = index.nodes.find(n => n.end > start);
    const last = index.nodes.find(n => n.end >= end);
    const time = new Date().toISOString();
    return {
      id: crypto.randomUUID(), color, messages: [], createdAt: time, updatedAt: time,
      selector: { type: 'TextQuoteSelector', exact: index.text.slice(start, end),
        prefix: index.text.slice(Math.max(0, start - 32), start), suffix: index.text.slice(end, end + 32) },
      position: { type: 'TextPositionSelector', start, end },
      domRange: { start: { path: nodePath(doc.body, first.node), offset: start - first.start },
        end: { path: nodePath(doc.body, last.node), offset: end - last.start } }
    };
  }

  function overlaps(notes, position) {
    return notes.some(n => position.start < n.position.end && position.end > n.position.start);
  }

  function viewer(runtime) {
    function boot() {
      const block = document.getElementById('notes-data');
      if (!block) return;
      let notes;
      try { notes = runtime.notesFromData(JSON.parse(block.textContent)); } catch { return; }
      if (document.documentElement.dataset.lnEditing === '1') return;
      runtime.watchNotes(document, () => notes, result => {
        let pending = document.querySelector('[data-ln-ui="pending"]');
        if (!result.unresolved.length) { pending?.remove(); return; }
        if (!pending) {
          pending = document.createElement('div');
          pending.dataset.lnUi = 'pending';
          pending.setAttribute('role', 'status');
          pending.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#fffdf8;color:#6b5741;padding:8px 12px;border:1px solid #d6d0c4;border-radius:8px;font:13px/1.5 system-ui';
          document.documentElement.append(pending);
        }
        pending.textContent = `${result.unresolved.length} 条批注等待正文生成或唯一定位；批注数据已保留。`;
      });
      document.addEventListener('click', event => {
        if (document.documentElement.dataset.lnEditing === '1') return;
        const mark = event.target.closest?.('mark[data-ln-owned="1"][data-note-id]');
        const existing = document.querySelector('[data-ln-ui="viewer"]');
        existing?.remove();
        if (!mark) return;
        const note = notes.find(n => n.id === mark.dataset.noteId);
        if (!note?.messages.length) return;
        event.preventDefault();
        const host = document.createElement('div');
        host.dataset.lnUi = 'viewer';
        host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = ':host{all:initial}section{box-sizing:border-box;background:#fffdf8;color:#292722;border:1px solid #d6d0c4;border-radius:12px;box-shadow:0 8px 32px #0003;padding:18px;width:min(480px,90vw);font:14px/1.6 system-ui}button{font:inherit;cursor:pointer}' + runtime.THREAD_STYLE;
        const section = document.createElement('section');
        section.setAttribute('role', 'dialog');
        section.setAttribute('aria-label', '批注评论对话');
        const title = document.createElement('strong');
        title.textContent = '评论对话';
        const messages = document.createElement('div');
        messages.className = 'messages';
        runtime.renderMessages(messages, note);
        const close = document.createElement('button');
        close.textContent = '关闭';
        close.onclick = () => host.remove();
        section.append(title, messages, close);
        shadow.append(style, section);
        document.documentElement.append(host);
        close.focus();
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') document.querySelector('[data-ln-ui="viewer"]')?.remove();
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }

  function ownedNode(doc, tag, id) {
    const element = doc.createElement(tag);
    element.id = id;
    element.dataset.lnOwned = '1';
    return element;
  }

  function parse(source) {
    // DOMParser disables scripting and can move head/noscript fallback text into body.
    // Protect these blocks while leaving comments and raw-text elements unchanged.
    const noscripts = [], token = crypto.randomUUID();
    const protectedSource = source.replace(/<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|iframe|noembed|noframes)\b[^>]*>[\s\S]*?<\/\1\s*>|<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, html => {
      if (!/^<noscript\b/i.test(html)) return html;
      const index = noscripts.push(html) - 1;
      return `<script type="application/x-local-notes-placeholder" data-ln-noscript="${token}-${index}"></script>`;
    });
    const doc = new DOMParser().parseFromString(protectedSource, 'text/html');
    noscripts.forEach((html, index) => {
      const fallback = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.firstElementChild;
      doc.querySelector(`[data-ln-noscript="${token}-${index}"]`).replaceWith(doc.importNode(fallback, true));
    });
    for (const meta of doc.querySelectorAll('meta[charset],meta[http-equiv="content-type" i]')) {
      const charset = meta.getAttribute('charset') || /charset\s*=\s*([\w-]+)/i.exec(meta.content)?.[1];
      if (charset && !/^utf-?8$/i.test(charset)) throw new Error('本期仅支持 UTF-8 HTML，请先转换文件编码。');
    }
    for (const meta of doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]')) {
      const directives = new Map();
      for (const part of meta.content.split(';')) {
        const [key, ...values] = part.trim().split(/\s+/);
        if (!directives.has(key.toLowerCase())) directives.set(key.toLowerCase(), values);
      }
      for (const kind of ['script', 'style']) {
        const rule = [`${kind}-src-elem`, `${kind}-src`, 'default-src'].find(key => directives.has(key));
        if (!rule) continue;
        const values = directives.get(rule);
        if (!values.includes("'unsafe-inline'") || values.includes("'strict-dynamic'") || values.some(value => /^'(nonce-|sha(?:256|384|512)-)/.test(value))) {
          throw new Error('原 HTML 的内容安全策略阻止批注查看脚本或样式，本期不修改该策略。');
        }
      }
    }
    for (const id of ['local-notes-style', 'local-notes-viewer']) {
      const elements = doc.querySelectorAll(`#${id}`);
      if (elements.length > 1 || [...elements].some(e => e.dataset.lnOwned !== '1')) {
        throw new Error(`原文件的 ${id} 与批注组件重名，停止保存。`);
      }
    }
    readNotes(doc);
    return doc;
  }

  function serialize(source, notes) {
    validateNotes(notes);
    const doc = parse(source);
    unmark(doc);
    for (const el of doc.querySelectorAll(`#notes-data${OWNED},#local-notes-style${OWNED},#local-notes-viewer${OWNED},[data-ln-ui]`)) el.remove();
    const comments = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT), guides = [];
    for (let comment; (comment = comments.nextNode());) {
      if (comment.data.startsWith(' LOCAL_HTML_NOTES_LLM_PROTOCOL_V2\n')) guides.push(comment);
    }
    for (const guide of guides) guide.remove();
    delete doc.documentElement.dataset.lnEditing;
    applyNotes(doc, resolveNotes(doc, notes).resolved);
    const style = ownedNode(doc, 'style', 'local-notes-style');
    style.textContent = STYLE;
    const script = ownedNode(doc, 'script', 'local-notes-viewer');
    script.textContent = `(${viewer.toString()})((${annotationRuntime.toString()})());`;
    doc.head.append(style, script);
    const data = ownedNode(doc, 'script', 'notes-data');
    data.type = 'application/json';
    data.textContent = JSON.stringify({ format: 'local-html-notes', version: 2, notes })
      .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    doc.body.append(doc.createComment(LLM_PROTOCOL), data);
    const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + '\n' : '';
    return doctype + doc.documentElement.outerHTML;
  }

  async function hash(bytes) {
    const buffer = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  }

  async function writeFile(handle, snapshot) {
    const file = await handle.getFile();
    if (file.name !== snapshot.name || await hash(await file.arrayBuffer()) !== snapshot.hash) {
      throw new Error('所选文件与当前文档不一致，或文件已被外部修改。未覆盖，请重新打开原文件。');
    }
    const source = serialize(snapshot.source, snapshot.notes);
    let stream;
    try {
      stream = await handle.createWritable({ mode: 'exclusive' });
      await stream.write(source);
      await stream.close();
    } catch (error) {
      if (stream) { try { await stream.abort(); } catch {} }
      throw error;
    }
    return { source, hash: await hash(source) };
  }

  globalThis.LocalHtmlNotes = { COLORS, MARKS, STYLE, THREAD_STYLE, LLM_PROTOCOL, textIndex, unmark, readNotes, validateNotes, threadSummary, renderMessages,
    applyNotes, resolveNotes, watchNotes, positionFromRange, capture, overlaps, parse, serialize, hash, writeFile };
})();
