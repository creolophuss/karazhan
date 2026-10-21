import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts/validation');
await mkdir(output, { recursive: true });
const fixture = await readFile(path.join(root, 'tests/fixtures/测试 报告.html'), 'utf8');
const dynamicFixture = await readFile(path.join(root, 'tests/fixtures/脚本 报告.html'), 'utf8');
const coreCode = await readFile(path.join(root, 'extension/core.js'), 'utf8');
const editorCode = await readFile(path.join(root, 'extension/editor.js'), 'utf8');
const saveCode = await readFile(path.join(root, 'extension/save.js'), 'utf8');
const handlesCode = await readFile(path.join(root, 'extension/handles.js'), 'utf8');
const saveHtml = await readFile(path.join(root, 'extension/save.html'), 'utf8');
const results = [], windows = [], dynamicEvidence = [], conversationEvidence = [];
const digest = value => createHash('sha256').update(value).digest('hex');
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

function environment(source = fixture, url = pathToFileURL(path.join(output, '测试 报告.html')).href, runScripts = 'outside-only') {
  const dom = new JSDOM(source, { url, runScripts, pretendToBeVisual: true });
  const { window } = dom;
  windows.push(window);
  window.structuredClone = structuredClone;
  window.TextEncoder = TextEncoder;
  Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
  window.Range.prototype.getBoundingClientRect = () => ({ left: 80, right: 360, top: 180, bottom: 210, width: 280, height: 30 });
  // jsdom does not implement dialog top-layer behavior. Native Edge checks remain separate.
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.eval(coreCode);
  return { window, document: window.document, core: window.LocalHtmlNotes };
}

function noteFor(env, exact, color = 'yellow') {
  const start = env.core.textIndex(env.document.body).text.indexOf(exact);
  assert.ok(start >= 0, `fixture contains ${exact}`);
  return env.core.capture(env.document, { start, end: start + exact.length }, color);
}

function addMessage(note, content, role = 'user') {
  const message = { id: webcrypto.randomUUID(), role, content, createdAt: new Date().toISOString() };
  note.messages.push(message);
  return message;
}

async function test(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
}

async function waitFor(predicate, description) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(description);
}

function fileHandle(filename, { denied = false, failWrite = false } = {}) {
  const stats = { opened: 0, aborted: 0, committed: 0 };
  return {
    name: path.basename(filename), stats,
    async getFile() {
      const bytes = await readFile(filename);
      return { name: path.basename(filename), async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
    async queryPermission() { return denied ? 'denied' : 'granted'; },
    async requestPermission() { return denied ? 'denied' : 'granted'; },
    async createWritable() {
      if (denied) throw new DOMException('Denied', 'NotAllowedError');
      stats.opened++;
      const temp = filename + '.test-tmp';
      return {
        async write(value) {
          if (failWrite) throw new Error('模拟磁盘写入失败');
          await writeFile(temp, value);
        },
        async close() { await rename(temp, filename); stats.committed++; },
        async abort() { await rm(temp, { force: true }); stats.aborted++; }
      };
    }
  };
}

// Model IndexedDB transactions across new page contexts. Opaque file handles are
// retained by reference; native structured cloning and permission persistence need Edge.
function handleDatabase() {
  const records = new Map(), operations = [];
  let initialized = false;
  const database = {
    records, operations, failOpen: false, failWrites: false,
    open(name, version) {
      assert.equal(name, 'local-html-file-access'); assert.equal(version, 1);
      const opening = {};
      setTimeout(() => {
        if (database.failOpen) { opening.error = new Error('模拟存储不可用'); opening.onerror(); return; }
        opening.result = {
          createObjectStore(name) { assert.equal(name, 'files'); initialized = true; },
          close() {},
          transaction(name, mode) {
            assert.equal(name, 'files');
            const transaction = { objectStore() {
              const operation = (action, key, value) => {
                const request = {};
                operations.push({ action, key, value, mode });
                setTimeout(() => {
                  if (database.failWrites && mode === 'readwrite') {
                    transaction.error = new Error('模拟存储提交失败'); transaction.onabort(); return;
                  }
                  if (action === 'put') records.set(key, value);
                  if (action === 'delete') records.delete(key);
                  request.result = action === 'get' ? records.get(key) : undefined;
                  transaction.oncomplete();
                }, 0);
                return request;
              };
              return { get: key => operation('get', key), put: (value, key) => operation('put', key, value), delete: key => operation('delete', key) };
            } };
            return transaction;
          }
        };
        if (!initialized) opening.onupgradeneeded();
        opening.onsuccess();
      }, 0);
      return opening;
    }
  };
  return database;
}

async function saveEnvironment(filename, database, { session = 'save-session', source, picker } = {}) {
  source ??= await readFile(filename, 'utf8');
  const env = environment(saveHtml, `chrome-extension://test-extension/save.html?tab=12&session=${session}`);
  const sent = [], activated = [], listeners = [];
  let snapshot = { source, hash: digest(source), notes: [structuredClone(diskNote)], revision: 1, name: path.basename(filename), url: pathToFileURL(filename).href };
  Object.defineProperty(env.window, 'indexedDB', { value: database });
  env.window.eval(handlesCode);
  env.window.chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener(listener) { listeners.push(listener); } } },
    tabs: {
      async sendMessage(id, message) {
        sent.push(message);
        if (message.type === 'ln-snapshot') return { ok: true, snapshot };
        if (message.type === 'ln-saved') snapshot = { ...snapshot, source: message.source, hash: message.hash };
        return { ok: true };
      },
      async update(id, options) { activated.push({ id, ...options }); }
    }
  };
  const picked = [];
  env.window.showOpenFilePicker = async options => {
    picked.push(options);
    if (picker) return picker();
    throw new Error('本测试不应重新选择文件');
  };
  env.window.eval(saveCode);
  await waitFor(() => !env.document.querySelector('#choose').disabled, '保存页应完成初始化');
  return { ...env, sent, activated, picked, listeners };
}

await test('跨行内标签与跨段落高亮，保留正文和原报告脚本', () => {
  const env = environment();
  const first = noteFor(env, '本季度收入增长 20%，研发投入保持稳定。');
  const text = env.core.textIndex(env.document.body).text;
  const start = text.indexOf('第二段用于测试');
  const end = text.indexOf('第三段保留独立内容') + '第三段保留独立内容'.length;
  const second = env.core.capture(env.document, { start, end }, 'green');
  const source = env.core.serialize(fixture, [first, second]);
  const reopened = environment(source);
  assert.equal(reopened.core.textIndex(reopened.document.body).text, text);
  assert.ok(reopened.document.querySelectorAll(`mark[data-note-id="${first.id}"]`).length >= 3);
  assert.equal(reopened.document.querySelector('strong').textContent, '20%');
  assert.ok(reopened.document.querySelectorAll(`mark[data-note-id="${second.id}"]`).length >= 2);
  assert.ok(source.startsWith('<!DOCTYPE html>'));
  assert.ok(source.includes("document.documentElement.dataset.reportReady = 'yes'"));
});

await test('相邻选区正确分割同一文字节点，四种颜色均可回显', () => {
  const env = environment();
  const notes = ['本季度', '收入增长 ', '20%', '，研发投入'].map((quote, i) => noteFor(env, quote, Object.keys(env.core.COLORS)[i]));
  const saved = environment(env.core.serialize(fixture, notes));
  for (const note of notes) {
    const marks = [...saved.document.querySelectorAll(`mark[data-note-id="${note.id}"]`)];
    assert.equal(marks.map(m => m.textContent).join(''), note.selector.exact);
    assert.ok(marks.every(m => m.className === `hl-${note.color}`));
  }
});

await test('评论安全编码，包含结束 script、HTML、换行和中文', () => {
  const env = environment();
  const note = noteFor(env, '研发投入保持稳定');
  const message = addMessage(note, '</script><script>window.injected=true</script>\n<img src=x onerror=alert(1)> 中文\u2028');
  const saved = env.core.serialize(fixture, [note]);
  const reopened = environment(saved);
  assert.equal(reopened.core.readNotes(reopened.document)[0].messages[0].content, message.content);
  assert.equal(reopened.document.querySelectorAll('img').length, 0);
  assert.equal(reopened.document.querySelectorAll('script').length, 3);
  assert.equal(reopened.document.querySelector('mark').title, env.core.threadSummary(note));
  assert.ok(reopened.document.querySelector('mark[data-ln-comment="1"]'));
});

await test('重复保存、改色、删除评论和高亮，不重复注入', () => {
  const env = environment();
  const note = noteFor(env, '本季度收入增长');
  addMessage(note, '初始评论');
  let saved = env.core.serialize(fixture, [note]);
  note.color = 'pink'; note.messages = [];
  saved = env.core.serialize(saved, [note]);
  const reopened = environment(saved);
  for (const id of ['notes-data', 'local-notes-style', 'local-notes-viewer']) assert.equal(reopened.document.querySelectorAll(`#${id}`).length, 1);
  assert.equal(reopened.document.querySelectorAll('mark mark').length, 0);
  assert.equal(reopened.document.querySelector('mark').className, 'hl-pink');
  assert.equal(reopened.document.querySelectorAll('[data-ln-comment]').length, 0);
  const removed = environment(env.core.serialize(saved, []));
  assert.equal(removed.document.querySelectorAll(env.core.MARKS).length, 0);
  assert.equal(removed.core.readNotes(removed.document).length, 0);
});

await test('拒绝损坏数据和 CSP；重叠、失配批注保留待定位', () => {
  const env = environment();
  const a = noteFor(env, '收入增长');
  const b = noteFor(env, '本季度收入增长');
  assert.equal(env.core.overlaps([a], b.position), true);
  assert.throws(() => env.core.applyNotes(env.document, [a, b]), /重叠/);
  const retained = environment(env.core.serialize(fixture, [a, b]));
  assert.equal(retained.core.readNotes(retained.document).length, 2);
  assert.equal(retained.core.resolveNotes(retained.document, [a, b]).unresolved.length, 1);
  assert.throws(() => env.core.parse(fixture.replace('</body>', '<script type="application/json" id="notes-data" data-ln-owned="1">{bad</script></body>')), /损坏/);
  assert.throws(() => env.core.parse(fixture.replace('</body>', '<script type="application/json" id="notes-data">{}</script></body>')), /不属于/);
  assert.throws(() => env.core.parse(fixture.replace('收入增长', '<mark data-ln-owned="1" data-note-id="lost">收入增长</mark>')), /数据丢失/);
  const invalid = structuredClone(a); invalid.position.start++;
  assert.equal(env.core.resolveNotes(env.document, [invalid]).resolved[0].position.start, a.position.start);
  assert.throws(() => env.core.parse(fixture.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="script-src none"></head>')), /安全策略/);
  assert.doesNotThrow(() => env.core.parse(fixture.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"></head>')));
  assert.throws(() => env.core.parse(fixture.replace('charset="utf-8"', 'charset="gbk"')), /UTF-8/);
});

await test('无扩展查看脚本：点击评论、纯文本显示和 Esc 关闭', async () => {
  const env = environment();
  const note = noteFor(env, '研发投入保持稳定');
  const message = addMessage(note, '<b>只作为文字</b>\n评论第二行');
  const saved = env.core.serialize(fixture, [note]);
  const offline = environment(saved);
  offline.window.eval(offline.document.querySelector('#local-notes-viewer').textContent);
  await turn();
  offline.document.querySelector('mark').click();
  const panel = offline.document.querySelector('[data-ln-ui="viewer"]');
  assert.ok(panel);
  assert.equal(panel.shadowRoot.querySelector('.message-body').textContent, message.content);
  assert.equal(panel.shadowRoot.querySelectorAll('b').length, 0);
  offline.document.dispatchEvent(new offline.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(offline.document.querySelector('[data-ln-ui="viewer"]'), null);
});

const diskFile = path.join(output, '测试 报告.html');
const diskEnv = environment();
const diskNote = noteFor(diskEnv, '本季度收入增长 20%');
addMessage(diskNote, '收入需要复核。');
let originalHash, savedHash;
await test('完整 HTML 写回真实测试路径，哈希改变，无 .bak', async () => {
  await writeFile(diskFile, fixture);
  originalHash = digest(await readFile(diskFile));
  const snapshot = { source: fixture, hash: originalHash, name: path.basename(diskFile), notes: [diskNote] };
  const handle = fileHandle(diskFile);
  const result = await diskEnv.core.writeFile(handle, snapshot);
  savedHash = digest(await readFile(diskFile));
  assert.notEqual(originalHash, savedHash);
  assert.equal(result.hash, savedHash);
  assert.equal(handle.stats.committed, 1);
  assert.ok(!(await readdir(output)).some(name => name.startsWith('测试 报告') && name.endsWith('.bak')));
  const reopened = environment(await readFile(diskFile, 'utf8'));
  assert.equal(reopened.core.readNotes(reopened.document)[0].messages[0].content, diskNote.messages[0].content);
});

await test('选错名称、外部修改、权限拒绝及写入失败不覆盖原文件', async () => {
  const filename = path.join(output, 'failure.html');
  await writeFile(filename, fixture);
  const original = digest(await readFile(filename));
  const snapshot = { source: fixture, hash: original, name: path.basename(filename), notes: [diskNote] };
  const wrong = fileHandle(filename);
  await assert.rejects(diskEnv.core.writeFile(wrong, { ...snapshot, name: 'wrong.html' }), /不一致/);
  assert.equal(wrong.stats.opened, 0);
  await writeFile(filename, fixture + '\n外部修改');
  await assert.rejects(diskEnv.core.writeFile(wrong, snapshot), /外部修改/);
  assert.equal(await readFile(filename, 'utf8'), fixture + '\n外部修改');
  await writeFile(filename, fixture);
  await assert.rejects(diskEnv.core.writeFile(fileHandle(filename, { denied: true }), snapshot), { name: 'NotAllowedError' });
  const broken = fileHandle(filename, { failWrite: true });
  await assert.rejects(diskEnv.core.writeFile(broken, snapshot), /模拟磁盘/);
  assert.equal(broken.stats.aborted, 1);
  assert.equal(digest(await readFile(filename)), original);
});

async function editorEnvironment(source = fixture, executeScripts = false, filename = '测试 报告.html') {
  const env = environment(source, pathToFileURL(path.join(output, filename)).href, executeScripts ? 'dangerously' : 'outside-only');
  const listeners = [], messages = [];
  env.window.chrome = {
    runtime: { id: 'test-extension',
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'ln-read-source') return { ok: true, source, hash: digest(source), name: filename };
        if (message.type === 'ln-open-save') return { ok: true, tabId: 99 };
      }
    }
  };
  env.window.eval(editorCode);
  for (let i = 0; i < 100 && !env.document.querySelector('[data-ln-ui="editor"]')?.shadowRoot.querySelector('#save:not(:disabled)'); i++) await turn();
  const shadow = env.document.querySelector('[data-ln-ui="editor"]').shadowRoot;
  assert.equal(shadow.querySelector('#save').disabled, false, shadow.querySelector('.state').textContent);
  return { ...env, shadow, messages, listeners };
}

function selectText(env, exact) {
  const index = env.core.textIndex(env.document.body);
  const start = index.text.indexOf(exact), end = start + exact.length;
  const first = index.nodes.find(n => n.end > start), last = index.nodes.find(n => n.end >= end);
  const range = env.document.createRange();
  range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
  env.window.getSelection().removeAllRanges(); env.window.getSelection().addRange(range);
  first.node.parentElement.dispatchEvent(new env.window.MouseEvent('mouseup', { bubbles: true }));
}

async function editorSnapshot(env) {
  env.shadow.querySelector('#save').click(); await turn();
  const session = env.messages.find(m => m.type === 'ln-open-save').session;
  const response = await new Promise(resolve => env.listeners[0]({ type: 'ln-snapshot', session }, { id: 'test-extension' }, resolve));
  assert.equal(response.ok, true);
  return response.snapshot;
}

// Simulate an external file-editing LLM. Replace JSON only, without serializing the HTML.
function appendAssistant(source, content) {
  const match = /(<script\b[^>]*\bid="notes-data"[^>]*>)([\s\S]*?)(<\/script>)/.exec(source);
  assert.ok(match);
  const data = JSON.parse(match[2]);
  assert.equal(data.version, 2);
  for (const note of data.notes) {
    if (note.messages.at(-1)?.role !== 'user') continue;
    const message = addMessage(note, content, 'assistant');
    note.updatedAt = message.createdAt;
  }
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const start = match.index + match[1].length;
  const end = start + match[2].length;
  const result = source.slice(0, start) + json + source.slice(end);
  assert.equal(result.slice(0, start), source.slice(0, start));
  assert.equal(result.slice(start + json.length), source.slice(end));
  return result;
}

await test('v1 单段评论迁移为稳定的用户消息，空评论不创建消息，保存为 v2', async () => {
  const env = environment();
  const a = noteFor(env, '收入增长'), b = noteFor(env, '第二段用于测试');
  const legacy = [a, b].map((note, i) => {
    const { messages, ...rest } = note;
    return { ...rest, comment: i === 0 ? '旧版评论\n保留换行' : '' };
  });
  const source = fixture.replace('</body>', `<script id="notes-data" data-ln-owned="1" type="application/json">${JSON.stringify({ format: 'local-html-notes', version: 1, notes: legacy })}</script></body>`);
  const loaded = environment(source);
  const migrated = loaded.core.readNotes(loaded.document);
  assert.equal(migrated[0].messages[0].role, 'user');
  assert.equal(migrated[0].messages[0].content, legacy[0].comment);
  assert.equal(migrated[0].messages[0].createdAt, a.updatedAt);
  assert.equal(migrated[1].messages.length, 0);
  for (const field of ['id', 'selector', 'position', 'domRange', 'createdAt', 'updatedAt']) {
    assert.deepEqual(structuredClone(migrated[0][field]), structuredClone(a[field]));
  }
  const saved = loaded.core.serialize(source, migrated);
  const reopened = environment(saved);
  assert.equal(JSON.parse(reopened.document.querySelector('#notes-data').textContent).version, 2);
  const again = reopened.core.readNotes(reopened.document);
  assert.deepEqual(structuredClone(again), structuredClone(migrated));
  assert.equal(Object.hasOwn(again[0], 'comment'), false);
  const twice = reopened.core.serialize(saved, again);
  const repeated = environment(twice);
  assert.deepEqual(structuredClone(repeated.core.readNotes(repeated.document)), structuredClone(migrated));
  assert.equal(twice.split('<!-- LOCAL_HTML_NOTES_LLM_PROTOCOL_V2\n').length - 1, 1);
  const editor = await editorEnvironment(source);
  editor.document.querySelector('mark').dispatchEvent(new editor.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(editor.shadow.querySelector('.message-body').textContent, legacy[0].comment);
});

await test('用户可编辑、删除自己的消息；LLM 只读；删除高亮删除完整对话', async () => {
  const coreEnv = environment();
  const note = noteFor(coreEnv, '收入增长');
  const user = addMessage(note, '请解释增长原因。');
  const assistant = addMessage(note, '需要查看收入构成。', 'assistant');
  const env = await editorEnvironment(coreEnv.core.serialize(fixture, [note]));
  env.document.querySelector('mark').dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(env.shadow.querySelectorAll('.message').length, 2);
  assert.equal(env.shadow.querySelectorAll('.message[data-role="assistant"] button').length, 0);
  assert.equal(env.shadow.querySelectorAll('[data-action="edit-message"]').length, 1);
  env.shadow.querySelector('#save-comment').click();
  assert.equal(env.shadow.querySelector('textarea').checkValidity(), false);
  assert.equal(env.shadow.querySelectorAll('.message').length, 2);
  env.shadow.querySelector('[data-action="edit-message"]').click();
  env.shadow.querySelector('textarea').value = '请解释收入增长原因。';
  env.shadow.querySelector('#save-comment').click();
  assert.equal(env.shadow.querySelector('dialog').open, true);
  assert.equal(env.shadow.querySelector('textarea').value, '');
  assert.equal(env.shadow.querySelector('.edited').textContent, '已编辑');
  let snapshot = await editorSnapshot(env);
  const edited = snapshot.notes[0].messages[0];
  assert.equal(edited.id, user.id);
  assert.equal(edited.createdAt, user.createdAt);
  assert.ok(edited.editedAt);
  assert.deepEqual(structuredClone(snapshot.notes[0].messages[1]), assistant);
  env.shadow.querySelector('[data-action="edit-message"]').click();
  env.shadow.querySelector('#cancel-edit').click();
  assert.equal(env.shadow.querySelector('textarea').value, '');
  env.shadow.querySelector('[data-action="delete-message"]').click();
  snapshot = await editorSnapshot(env);
  assert.equal(snapshot.notes[0].messages.length, 1);
  assert.equal(snapshot.notes[0].messages[0].id, assistant.id);
  assert.ok(env.document.querySelector('mark[data-ln-comment="1"]'));
  env.shadow.querySelector('dialog').close();
  env.window.getSelection().removeAllRanges();
  env.document.querySelector('mark').click();
  env.shadow.querySelector('#remove').click();
  snapshot = await editorSnapshot(env);
  assert.equal(snapshot.notes.length, 0);
  assert.equal(env.document.querySelectorAll(env.core.MARKS).length, 0);
});

await test('对话字段无效或消息 ID 重复时，停止保存且不打开写入流', async () => {
  const env = environment();
  const note = noteFor(env, '收入增长');
  addMessage(note, '有效消息');
  const mutations = [
    n => { n.messages[0].role = 'system'; },
    n => { n.messages[0].content = '  '; },
    n => { n.messages[0].id = '<bad>'; },
    n => { n.messages[0].createdAt = 'invalid'; },
    n => { n.messages[0].editedAt = 'invalid'; },
    n => { n.messages.push({ ...n.messages[0] }); },
    n => { n.comment = '旧字段不可混用'; },
    n => { delete n.messages; }
  ];
  const filename = path.join(output, 'invalid-thread.html');
  await writeFile(filename, fixture);
  for (const mutate of mutations) {
    const invalid = structuredClone(note); mutate(invalid);
    const handle = fileHandle(filename);
    await assert.rejects(env.core.writeFile(handle, { source: fixture, name: handle.name, hash: digest(fixture), notes: [invalid] }), /无效/);
    assert.equal(handle.stats.opened, 0);
    assert.equal(await readFile(filename, 'utf8'), fixture);
  }
});

await test('完整多轮往返：保存、外部追加 LLM、手动重开、用户追问、再追加和离线查看', async () => {
  const filename = '多轮 对话.html', filepath = path.join(output, filename);
  const env = await editorEnvironment(fixture, false, filename);
  selectText(env, '本季度收入增长 20%'); env.shadow.querySelector('[data-color="green"]').click();
  env.document.querySelector('mark').dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true }));
  env.shadow.querySelector('textarea').value = '这个增长如何计算？';
  env.shadow.querySelector('#save-comment').click();
  const first = await editorSnapshot(env);
  // Add an independent empty thread. It must not receive an assistant message.
  first.notes.push(noteFor(environment(), '第二段用于测试', 'blue'));
  await writeFile(filepath, fixture);
  const versions = [{ stage: 'original', hash: digest(fixture) }];
  const saved = await env.core.writeFile(fileHandle(filepath), first);
  versions.push({ stage: 'user-question', hash: saved.hash });
  const answered = appendAssistant(saved.source, '同比增长 =（本期收入 / 上期收入 − 1）× 100%。');
  assert.equal(appendAssistant(answered, '不能重复回复'), answered);
  await writeFile(filepath, answered);
  versions.push({ stage: 'assistant-answer', hash: digest(answered) });
  const refresh = await editorEnvironment(await readFile(filepath, 'utf8'), false, filename);
  refresh.document.querySelector('mark').dispatchEvent(new refresh.window.MouseEvent('dblclick', { bubbles: true }));
  assert.deepEqual([...refresh.shadow.querySelectorAll('.message header strong')].map(n => n.textContent), ['我', 'LLM']);
  refresh.shadow.querySelector('textarea').value = '还需要哪些原始数据？';
  refresh.shadow.querySelector('#save-comment').click();
  const followup = await editorSnapshot(refresh);
  assert.equal(followup.notes[0].messages.length, 3);
  assert.equal(followup.notes[0].messages[0].id, first.notes[0].messages[0].id);
  assert.equal(followup.notes[1].messages.length, 0);
  const second = await refresh.core.writeFile(fileHandle(filepath), followup);
  versions.push({ stage: 'user-followup', hash: second.hash });
  const final = appendAssistant(second.source, '需要本期和上期收入。\n</script><img src=x onerror=alert(1)> 作为纯文本。');
  await writeFile(filepath, final);
  versions.push({ stage: 'assistant-followup', hash: digest(final) });
  const offline = environment(final, pathToFileURL(filepath).href, 'dangerously');
  await waitFor(() => offline.document.querySelector('[data-ln-ui="comment-badge"]'), '离线显示评论角标');
  offline.document.querySelector('[data-ln-ui="comment-badge"]').click();
  const panel = offline.document.querySelector('[data-ln-ui="viewer"]').shadowRoot;
  assert.deepEqual([...panel.querySelectorAll('.message header strong')].map(n => n.textContent), ['我', 'LLM', '我', 'LLM']);
  assert.equal(panel.querySelectorAll('img,script').length, 0);
  assert.equal(panel.querySelectorAll('.message-actions').length, 0);
  assert.match(panel.querySelectorAll('.message-body')[3].textContent, /<\/script><img/);
  const notes = offline.core.readNotes(offline.document);
  assert.equal(notes[0].id, first.notes[0].id);
  assert.deepEqual(structuredClone(notes[0].selector), structuredClone(first.notes[0].selector));
  assert.deepEqual(structuredClone(notes[0].messages.slice(0, 3)), structuredClone(followup.notes[0].messages));
  assert.equal(notes[1].messages.length, 0);
  assert.equal(offline.document.documentElement.dataset.reportReady, 'yes');
  assert.ok(!final.includes('</script><img'));
  assert.ok(!(await readdir(output)).some(name => name.startsWith('多轮 对话') && name.endsWith('.bak')));
  conversationEvidence.push({ file: filepath, versions, coverage: 'two user/assistant rounds, JSON-only external edits with unchanged prefix/suffix, manual reopen, stable anchors and history, read-only offline display; external LLM replies simulated' });
});

await test('外部 LLM 改写后，旧页面保存被阻止；刷新后载入新回复', async () => {
  const filename = '外部 回复.html', filepath = path.join(output, filename);
  const env = environment();
  const note = noteFor(env, '收入增长'); addMessage(note, '待回答问题');
  const saved = env.core.serialize(fixture, [note]);
  const stale = await editorEnvironment(saved, false, filename);
  stale.document.querySelector('mark').dispatchEvent(new stale.window.MouseEvent('dblclick', { bubbles: true }));
  stale.shadow.querySelector('textarea').value = '旧页面中未保存的追问';
  stale.shadow.querySelector('#save-comment').click();
  const snapshot = await editorSnapshot(stale);
  const answered = appendAssistant(saved, '外部 LLM 回复');
  await writeFile(filepath, answered);
  const handle = fileHandle(filepath);
  await assert.rejects(stale.core.writeFile(handle, snapshot), /外部修改/);
  assert.equal(handle.stats.opened, 0);
  assert.equal(await readFile(filepath, 'utf8'), answered);
  assert.equal((await editorSnapshot(stale)).notes[0].messages.at(-1).content, '旧页面中未保存的追问');
  const refreshed = await editorEnvironment(answered, false, filename);
  const fresh = await editorSnapshot(refreshed);
  assert.equal(fresh.notes[0].messages.at(-1).content, '外部 LLM 回复');
  assert.equal(fresh.notes[0].messages.length, 2);
});

await test('脚本正文的多轮对话在重新渲染和离线重开后完整回显', async () => {
  const env = await editorEnvironment(dynamicFixture, true);
  await waitFor(() => env.document.querySelector('#income'), '等待动态正文');
  const note = noteFor(env, '脚本生成的季度收入增长 20%');
  addMessage(note, '动态报告问题'); addMessage(note, '动态报告回复', 'assistant'); addMessage(note, '继续追问');
  const saved = env.core.serialize(dynamicFixture, [note]);
  const offline = environment(saved, undefined, 'dangerously');
  await waitFor(() => offline.document.querySelector('#income mark'), '等待批注恢复');
  offline.window.renderReport('<p>新段落改变文字位置。</p>');
  await waitFor(() => offline.document.querySelector('#income mark'), '重新渲染恢复批注');
  offline.document.querySelector('[data-ln-ui="comment-badge"]').click();
  const panel = offline.document.querySelector('[data-ln-ui="viewer"]').shadowRoot;
  assert.deepEqual([...panel.querySelectorAll('.message-body')].map(n => n.textContent), Array.from(note.messages, m => m.content));
  assert.equal(offline.document.querySelectorAll('#income').length, 1);
});

await test('编辑界面：选区浮层、Esc、创建高亮、双击评论和改色', async () => {
  const env = await editorEnvironment();
  selectText(env, '本季度收入增长 20%');
  assert.equal(env.shadow.querySelector('.popover').hidden, false);
  env.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(env.shadow.querySelector('.popover').hidden, true);
  selectText(env, '本季度收入增长 20%');
  env.shadow.querySelector('[data-color="yellow"]').click();
  assert.ok(env.document.querySelector('mark.hl-yellow'));
  env.document.querySelector('mark').dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(env.shadow.querySelector('dialog').open, true);
  env.shadow.querySelector('textarea').value = '评论 UI 测试';
  env.shadow.querySelector('#save-comment').click();
  assert.match(env.document.querySelector('mark').title, /评论 UI 测试/);
  assert.equal(env.shadow.querySelector('dialog').open, true);
  assert.equal(env.shadow.querySelector('textarea').value, '');
  assert.equal(env.shadow.querySelectorAll('.message').length, 1);
  env.document.querySelector('[data-ln-ui="comment-badge"]').click();
  assert.equal(env.shadow.querySelector('dialog').open, true);
  env.shadow.querySelector('dialog').close();
  env.window.getSelection().removeAllRanges();
  env.document.querySelector('mark').click();
  env.shadow.querySelector('[data-color="green"]').click();
  assert.ok(env.document.querySelector('mark.hl-green'));
  selectText(env, '本季度收入增长');
  assert.match(env.shadow.querySelector('.notice').textContent, /重叠/);
  env.window.getSelection().removeAllRanges();
  env.document.querySelector('mark').click();
  env.shadow.querySelector('#remove').click();
  assert.equal(env.document.querySelectorAll(env.core.MARKS).length, 0);
});

await test('保存状态按内容版本确认，保存期间的新修改继续显示未保存', async () => {
  const env = await editorEnvironment();
  selectText(env, '收入增长'); env.shadow.querySelector('[data-color="blue"]').click();
  env.shadow.querySelector('#save').click(); await turn();
  const session = env.messages.find(m => m.type === 'ln-open-save').session;
  const dispatch = message => new Promise(resolve => env.listeners[0]({ ...message, session }, { id: 'test-extension' }, resolve));
  const snapshot = (await dispatch({ type: 'ln-snapshot' })).snapshot;
  selectText(env, '第二段用于测试'); env.shadow.querySelector('[data-color="pink"]').click();
  const saved = env.core.serialize(snapshot.source, snapshot.notes);
  await dispatch({ type: 'ln-saved', source: saved, hash: digest(saved), revision: snapshot.revision });
  assert.match(env.shadow.querySelector('.state').textContent, /未保存/);
  const next = (await dispatch({ type: 'ln-snapshot' })).snapshot;
  assert.equal(next.notes.length, 2);
  assert.equal(next.hash, digest(saved));
});

await test('复用授权快速保存完成后，不把成功状态覆盖成待授权；存储失败提示可见', async () => {
  const env = await editorEnvironment();
  selectText(env, '收入增长'); env.shadow.querySelector('[data-color="blue"]').click();
  const snapshot = await editorSnapshot(env);
  env.window.chrome.runtime.sendMessage = async message => {
    assert.equal(message.type, 'ln-open-save');
    const dispatch = payload => new Promise(resolve => env.listeners[0]({ ...payload, session: message.session }, { id: 'test-extension' }, resolve));
    await dispatch({ type: 'ln-saving' });
    const source = env.core.serialize(snapshot.source, snapshot.notes);
    await dispatch({ type: 'ln-saved', source, hash: digest(source), revision: snapshot.revision, warning: '无法记住文件授权。' });
    return { ok: true, tabId: 99 };
  };
  env.shadow.querySelector('#save').click(); await turn();
  assert.match(env.shadow.querySelector('.state').textContent, /^已保存/);
  assert.match(env.shadow.querySelector('.notice').textContent, /无法记住文件授权/);
});

await test('重开已保存 HTML 后编辑评论；批注层不重复接管', async () => {
  const source = await readFile(diskFile, 'utf8');
  const env = await editorEnvironment(source);
  assert.equal(env.document.querySelectorAll('#local-notes-style').length, 1);
  assert.equal(env.document.querySelectorAll('[data-ln-ui="editor"]').length, 1);
  env.document.querySelector('mark').dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(env.shadow.querySelector('.message-body').textContent, diskNote.messages[0].content);
  env.shadow.querySelector('[data-action="delete-message"]').click();
  assert.ok(env.document.querySelector('mark'));
  assert.equal(env.document.querySelector('mark').hasAttribute('data-ln-comment'), false);
});

await test('保存页：取消文件选择、拒绝授权，以及成功写回与确认', async () => {
  const filename = path.join(output, 'save-page.html');
  await writeFile(filename, fixture);
  const env = environment(saveHtml, 'chrome-extension://test-extension/save.html?tab=12&session=test-session');
  const sent = [];
  const snap = { source: fixture, hash: digest(fixture), notes: [diskNote], revision: 1, name: 'save-page.html', url: pathToFileURL(filename).href };
  env.window.chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener() {} } },
    tabs: { async sendMessage(id, message) { sent.push(message); return message.type === 'ln-snapshot' ? { ok: true, snapshot: snap } : { ok: true }; }, async update() {} }
  };
  env.window.showOpenFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
  Object.defineProperty(env.window, 'indexedDB', { value: handleDatabase() });
  env.window.eval(handlesCode);
  env.window.eval(saveCode);
  await waitFor(() => !env.document.querySelector('#choose').disabled, '首次保存初始化完成');
  env.document.querySelector('#choose').click(); await turn();
  assert.match(env.document.querySelector('#status').textContent, /取消/);
  assert.equal(digest(await readFile(filename)), digest(fixture));
  env.window.showOpenFilePicker = async () => [fileHandle(filename, { denied: true })];
  env.document.querySelector('#choose').click(); await turn();
  assert.match(env.document.querySelector('#status').textContent, /写权限/);
  env.window.showOpenFilePicker = async () => [fileHandle(filename)];
  env.document.querySelector('#choose').click();
  for (let i = 0; i < 100 && !env.document.querySelector('#status').textContent.startsWith('已保存'); i++) await turn();
  assert.match(env.document.querySelector('#status').textContent, /^已保存/);
  const writtenHash = digest(await readFile(filename));
  assert.ok(sent.some(m => m.type === 'ln-saved' && m.hash === writtenHash));
});

await test('深层中文目录只选择一次，关闭保存页、刷新后自动复用并返回报告', async () => {
  const filename = path.join(output, '深层 目录/报告/授权 测试.html');
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, fixture);
  const database = handleDatabase(), handle = fileHandle(filename);
  const first = await saveEnvironment(filename, database, { picker: () => [handle] });
  first.document.querySelector('#choose').click();
  await waitFor(() => !first.document.querySelector('#choose').disabled, '首次选择后保存完成');
  assert.match(first.document.querySelector('#status').textContent, /^已保存/);
  assert.equal(first.picked[0].id, 'local-html-original');
  assert.equal(database.records.get(pathToFileURL(filename).href), handle);
  assert.ok(first.activated.some(tab => tab.id === 12 && tab.active));
  first.window.close();
  const reopened = await saveEnvironment(filename, database, { session: 'after-refresh' });
  assert.match(reopened.document.querySelector('#status').textContent, /^已保存/);
  assert.equal(reopened.picked.length, 0);
  assert.equal(handle.stats.committed, 2);
  assert.ok(reopened.activated.some(tab => tab.id === 12 && tab.active));
  assert.equal(database.records.size, 1);
  assert.ok(database.operations.filter(op => op.action === 'put').every(op => op.value === handle));
  assert.equal(database.operations.filter(op => op.action === 'put').length, 1, '数据库只保存授权句柄，不保存源码或批注');
});

await test('授权按完整文件 URL 区分，忽略页内锚点，不串用其他目录的同名文件', async () => {
  const database = handleDatabase(), env = environment(saveHtml);
  Object.defineProperty(env.window, 'indexedDB', { value: database });
  env.window.eval(handlesCode);
  const a = 'file:///work/deep-a/%E6%8A%A5%E5%91%8A%20one.html';
  const b = 'file:///work/deep-b/%E6%8A%A5%E5%91%8A%20one.html';
  const handle = fileHandle(path.join(output, 'save-page.html'));
  await env.window.LocalHtmlHandles.set(a + '?view=1#part', handle);
  assert.equal(await env.window.LocalHtmlHandles.get(a + '#other'), handle);
  assert.equal(await env.window.LocalHtmlHandles.get(b), undefined);
  assert.throws(() => env.window.LocalHtmlHandles.set('https://example.com/a.html', handle), /本地 HTML/);
  assert.equal(database.records.size, 1);
});

await test('权限失效时只显示确认按钮，点击时请求授权；拒绝不写入、不重新选文件', async () => {
  const filename = path.join(output, 'renew-permission.html');
  await writeFile(filename, fixture);
  const database = handleDatabase(), handle = fileHandle(filename);
  let permission = 'prompt', requests = 0, grant = true;
  handle.queryPermission = async () => permission;
  handle.requestPermission = async () => { requests++; return permission = grant ? 'granted' : 'denied'; };
  database.records.set(pathToFileURL(filename).href, handle);
  const env = await saveEnvironment(filename, database);
  assert.equal(requests, 0);
  assert.equal(handle.stats.opened, 0);
  assert.equal(env.document.querySelector('#again').textContent, '确认授权并保存');
  env.document.querySelector('#again').click();
  assert.equal(requests, 1, '授权请求直接来自点击事件');
  await waitFor(() => !env.document.querySelector('#choose').disabled, '授权保存完成');
  assert.match(env.document.querySelector('#status').textContent, /^已保存/);
  assert.equal(env.picked.length, 0);
  permission = 'prompt'; grant = false;
  const denied = await saveEnvironment(filename, database, { session: 'denied-permission' });
  const before = digest(await readFile(filename));
  denied.document.querySelector('#again').click();
  await waitFor(() => !denied.document.querySelector('#choose').disabled, '拒绝授权后恢复操作');
  assert.match(denied.document.querySelector('#status').textContent, /未获得文件写权限/);
  assert.equal(digest(await readFile(filename)), before);
  assert.equal(handle.stats.committed, 1);
  assert.equal(denied.picked.length, 0);
});

await test('忘记此文件会移除记忆；重开后不再自动写入', async () => {
  const filename = path.join(output, 'forget-file.html');
  await writeFile(filename, fixture);
  const database = handleDatabase(), handle = fileHandle(filename);
  database.records.set(pathToFileURL(filename).href, handle);
  const env = await saveEnvironment(filename, database);
  assert.equal(handle.stats.committed, 1);
  const before = digest(await readFile(filename));
  env.document.querySelector('#forget').click();
  await waitFor(() => !env.document.querySelector('#choose').disabled, '忘记操作完成');
  assert.equal(database.records.size, 0);
  assert.equal(env.document.querySelector('#again').hidden, true);
  assert.equal(digest(await readFile(filename)), before);
  const reopened = await saveEnvironment(filename, database, { session: 'forgotten' });
  assert.match(reopened.document.querySelector('#status').textContent, /首次保存/);
  assert.equal(handle.stats.committed, 1);
  assert.equal(reopened.picked.length, 0);
});

await test('存储不可用或提交失败不阻止当前保存，报告页收到未记住授权提示', async () => {
  for (const failure of ['failOpen', 'failWrites']) {
    const filename = path.join(output, `storage-${failure}.html`);
    await writeFile(filename, fixture);
    const database = handleDatabase(), handle = fileHandle(filename);
    database[failure] = true;
    const env = await saveEnvironment(filename, database, { picker: () => [handle] });
    env.document.querySelector('#choose').click();
    await waitFor(() => !env.document.querySelector('#choose').disabled, '存储失败仍完成当前保存');
    assert.match(env.document.querySelector('#status').textContent, /^已保存/);
    assert.match(env.document.querySelector('#storage-status').textContent, /无法记住/);
    assert.ok(env.sent.some(m => m.type === 'ln-saved' && /无法记住/.test(m.warning)));
    assert.equal(handle.stats.committed, 1);
    assert.equal(database.records.size, 0);
    env.listeners[0]({ type: 'ln-save-now', session: 'save-session' }, { id: 'test-extension' });
    await waitFor(() => !env.document.querySelector('#choose').disabled, '内存授权仍可继续保存');
    assert.equal(handle.stats.committed, 2);
    assert.equal(env.picked.length, 1);
  }
});

await test('选错文件不会记住授权；复用授权时仍检查外部修改', async () => {
  const filename = path.join(output, 'correct-file.html'), wrongFile = path.join(output, 'wrong-file.html');
  await writeFile(filename, fixture); await writeFile(wrongFile, fixture);
  const database = handleDatabase(), wrong = fileHandle(wrongFile);
  const first = await saveEnvironment(filename, database, { picker: () => [wrong] });
  first.document.querySelector('#choose').click();
  await waitFor(() => !first.document.querySelector('#choose').disabled, '选错文件停止保存');
  assert.match(first.document.querySelector('#status').textContent, /不一致/);
  assert.equal(wrong.stats.opened, 0);
  assert.equal(database.records.size, 0);
  const handle = fileHandle(filename);
  database.records.set(pathToFileURL(filename).href, handle);
  const changed = fixture + '\n<!-- external LLM update -->';
  await writeFile(filename, changed);
  const stale = await saveEnvironment(filename, database, { source: fixture, session: 'stale-page' });
  assert.match(stale.document.querySelector('#status').textContent, /外部修改/);
  assert.equal(await readFile(filename, 'utf8'), changed);
  assert.equal(handle.stats.opened, 0);
  assert.equal(stale.picked.length, 0);
  assert.equal(stale.sent.some(m => m.type === 'ln-saved'), false);
  const refreshed = await saveEnvironment(filename, database, { session: 'refreshed-page' });
  assert.match(refreshed.document.querySelector('#status').textContent, /^已保存/);
  assert.equal(handle.stats.committed, 1);
});

await test('同步脚本生成正文可批注；源码中的 noscript 和脚本字符串保持完整', async () => {
  const source = dynamicFixture.replace('setTimeout(() => renderReport(), 30);', 'renderReport();');
  const env = await editorEnvironment(source, true);
  assert.ok(env.document.querySelector('#income'));
  selectText(env, '脚本生成的季度收入增长 20%');
  env.shadow.querySelector('[data-color="blue"]').click();
  assert.ok(env.document.querySelector('#income mark.hl-blue'));
  const parsed = env.core.parse(source);
  assert.equal(parsed.querySelector('head noscript').textContent, '请启用 JavaScript 查看报告。');
  assert.ok(!env.core.textIndex(parsed.body).text.includes('请启用 JavaScript'));
  const scriptString = '<!doctype html><head><meta charset="utf-8"></head><body><p>正文</p><script>window.template="<noscript>保留字符串</noscript>";</script></body>';
  assert.ok(env.core.serialize(scriptString, []).includes('window.template="<noscript>保留字符串</noscript>"'));
});

await test('异步脚本正文：高亮、评论、真实文件写入及无扩展重开回显', async () => {
  const filename = '动态 测试.html';
  const env = await editorEnvironment(dynamicFixture, true, filename);
  await waitFor(() => env.document.querySelector('#income'), '异步报告应生成正文');
  selectText(env, '脚本生成的季度收入增长 20%');
  env.shadow.querySelector('[data-color="green"]').click();
  const mark = env.document.querySelector('#income mark');
  assert.ok(mark);
  mark.dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true }));
  env.shadow.querySelector('textarea').value = '这是脚本生成正文上的评论。';
  env.shadow.querySelector('#save-comment').click();
  env.shadow.querySelector('#save').click(); await turn();
  const session = env.messages.find(m => m.type === 'ln-open-save').session;
  const snapshot = await new Promise(resolve => env.listeners[0]({ type: 'ln-snapshot', session }, { id: 'test-extension' }, resolve));
  const filenameOnDisk = path.join(output, filename);
  await writeFile(filenameOnDisk, dynamicFixture);
  const before = digest(await readFile(filenameOnDisk));
  const result = await env.core.writeFile(fileHandle(filenameOnDisk), snapshot.snapshot);
  const after = digest(await readFile(filenameOnDisk));
  assert.equal(result.hash, after);
  assert.notEqual(before, after);
  assert.equal(env.core.parse(result.source).querySelector('#report').children.length, 0, '原始生成容器不保存渲染快照');
  assert.ok(result.source.includes('window.renderReport = function'));
  const offline = environment(result.source, pathToFileURL(filenameOnDisk).href, 'dangerously');
  await waitFor(() => offline.document.querySelector('#income mark[data-ln-comment="1"]'), '无扩展重开应在脚本生成正文后恢复高亮和评论');
  assert.equal(offline.document.querySelectorAll('#income').length, 1);
  assert.match(offline.document.querySelector('mark').title, /这是脚本生成正文上的评论。/);
  offline.document.querySelector('[data-ln-ui="comment-badge"]').click();
  assert.equal(offline.document.querySelector('[data-ln-ui="viewer"]').shadowRoot.querySelector('.message-body').textContent, '这是脚本生成正文上的评论。');
  await writeFile(path.join(output, '动态 已批注.html'), result.source);
  dynamicEvidence.push({ file: filenameOnDisk, retainedAnnotatedFile: path.join(output, '动态 已批注.html'), before, after, coverage: 'asynchronous render, annotation, comment, filesystem write, script-enabled reopen without extension' });
});

await test('页面重新渲染并插入段落后自动恢复批注，不重复运行报告脚本', async () => {
  const source = await readFile(path.join(output, '动态 已批注.html'), 'utf8');
  const env = environment(source, undefined, 'dangerously');
  await waitFor(() => env.document.querySelector('#income mark'), '应先恢复高亮');
  const id = env.document.querySelector('mark').dataset.noteId;
  env.window.renderReport('<p>新增内容使文字位置发生变化。</p>');
  assert.equal(env.document.querySelector('#income mark'), null);
  await waitFor(() => env.document.querySelector('#income mark'), '重渲染后应恢复高亮');
  assert.equal(env.document.querySelector('mark').dataset.noteId, id);
  assert.equal(env.document.querySelectorAll('#income').length, 1);
  assert.equal(env.document.querySelectorAll('#notes-data').length, 1);
  assert.ok(!env.document.querySelector('[data-ln-ui="pending"]'));
});

await test('页面持续更新时，批注恢复不会一直等待更新结束', async () => {
  const env = environment(await readFile(path.join(output, '动态 已批注.html'), 'utf8'), undefined, 'dangerously');
  await waitFor(() => env.document.querySelector('#income mark'), '应先恢复高亮');
  env.window.renderReport('<p id="counter">持续更新 0</p>');
  let count = 0;
  const timer = env.window.setInterval(() => { env.document.querySelector('#counter').textContent = `持续更新 ${++count}`; }, 15);
  try {
    await waitFor(() => env.document.querySelector('#income mark'), '持续更新期间也应恢复高亮');
    assert.ok(count > 0);
  } finally { env.window.clearInterval(timer); }
});

await test('动态文件重开后继续编辑颜色和评论、删除，再写回原文件', async () => {
  const filename = '动态 测试.html', filepath = path.join(output, filename);
  const env = await editorEnvironment(await readFile(filepath, 'utf8'), true, filename);
  await waitFor(() => env.document.querySelector('#income mark'), '扩展编辑模式应恢复动态高亮');
  env.document.querySelector('[data-ln-ui="comment-badge"]').click();
  env.shadow.querySelector('[data-action="edit-message"]').click();
  env.shadow.querySelector('textarea').value = '修改后的动态评论';
  env.shadow.querySelector('#save-comment').click();
  env.window.getSelection().removeAllRanges();
  env.document.querySelector('mark').click();
  env.shadow.querySelector('[data-color="pink"]').click();
  assert.ok(env.document.querySelector('mark.hl-pink'));
  env.document.querySelector('mark').click();
  env.shadow.querySelector('#remove').click();
  env.shadow.querySelector('#save').click(); await turn();
  const session = env.messages.find(m => m.type === 'ln-open-save').session;
  const snapshot = await new Promise(resolve => env.listeners[0]({ type: 'ln-snapshot', session }, { id: 'test-extension' }, resolve));
  const result = await env.core.writeFile(fileHandle(filepath), snapshot.snapshot);
  dynamicEvidence.push({ file: filepath, before: snapshot.snapshot.hash, after: result.hash, coverage: 'reopen, edit comment and color, delete, write back same file' });
  const offline = environment(result.source, pathToFileURL(filepath).href, 'dangerously');
  await waitFor(() => offline.document.querySelector('#income'), '删除后报告脚本仍可生成正文');
  assert.equal(offline.core.readNotes(offline.document).length, 0);
  assert.equal(offline.document.querySelectorAll(offline.core.MARKS).length, 0);
});

await test('未生成、无法唯一定位的批注保留；正文稍后出现时自动恢复', async () => {
  const env = environment();
  const note = noteFor(env, '研发投入保持稳定');
  addMessage(note, '正文暂时不可见时仍应保留');
  const pendingSource = env.core.serialize('<!doctype html><head><meta charset="utf-8"></head><body><main></main></body>', [note]);
  const offline = environment(pendingSource, undefined, 'dangerously');
  await waitFor(() => offline.document.querySelector('[data-ln-ui="pending"]'), '缺少正文时显示待定位数量');
  assert.equal(offline.core.readNotes(offline.document).length, 1);
  offline.document.querySelector('main').textContent = '研发投入保持稳定';
  await waitFor(() => offline.document.querySelector('mark'), '正文出现后自动恢复批注');
  assert.equal(offline.document.querySelector('[data-ln-ui="pending"]'), null);
  const duplicate = environment('<!doctype html><body><p>研发投入保持稳定</p><p>研发投入保持稳定</p></body>');
  const ambiguous = { ...note, selector: { ...note.selector, prefix: '', suffix: '' } };
  assert.equal(duplicate.core.resolveNotes(duplicate.document, [ambiguous]).resolved.length, 0);
  assert.equal(duplicate.core.resolveNotes(duplicate.document, [ambiguous]).unresolved[0].reason, 'ambiguous');
});

await test('扩展后台：只读取顶层本地 HTML，拒绝 PDF 与非页面请求', async () => {
  let listener, lastFetch;
  const context = {
    URL, TextDecoder, crypto: webcrypto,
    fetch: async url => {
      lastFetch = url;
      const bytes = new TextEncoder().encode(fixture);
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    },
    chrome: {
      runtime: { onMessage: { addListener(value) { listener = value; } }, getURL: name => 'chrome-extension://test/' + name },
      action: { onClicked: { addListener() {} } }
    }
  };
  vm.runInNewContext(await readFile(path.join(root, 'extension/background.js'), 'utf8'), context);
  const invoke = sender => new Promise(resolve => listener({ type: 'ln-read-source' }, sender, resolve));
  const good = await invoke({ frameId: 0, tab: { id: 12, url: 'file:///work/%E6%8A%A5%E5%91%8A%20one.html?x=1#section' } });
  assert.equal(good.ok, true);
  assert.equal(good.name, '报告 one.html');
  assert.equal(good.hash, digest(fixture));
  assert.equal(lastFetch, 'file:///work/%E6%8A%A5%E5%91%8A%20one.html');
  for (const sender of [{}, { frameId: 1, tab: { url: 'file:///work/report.html' } }, { frameId: 0, tab: { url: 'file:///work/report.pdf' } }]) {
    assert.equal((await invoke(sender)).ok, false);
  }
});

const codeFiles = ['extension/manifest.json', 'extension/core.js', 'extension/editor.js', 'extension/background.js', 'extension/save.html', 'extension/save.css', 'extension/save.js', 'extension/handles.js', 'tests/run.mjs', 'tests/fixtures/测试 报告.html', 'tests/fixtures/脚本 报告.html', 'package.json', 'package-lock.json', 'README.md'];
const sourceHashes = {};
for (const name of codeFiles) sourceHashes[name] = digest(await readFile(path.join(root, name)));
const report = {
  createdAt: new Date().toISOString(), command: 'node tests/run.mjs', node: process.version,
  environment: 'jsdom 29.1.1; DOM events and extension/file APIs simulated; real workspace test file writes',
  simulations: ['DOM geometry and dialog top-layer', 'chrome.runtime and chrome.tabs', 'file picker and write permission', 'FileSystemFileHandle adapter using temporary file and rename', 'IndexedDB transactions and opaque handle persistence across new page contexts; native FileSystemHandle structured cloning and permission persistence require Edge'],
  sourceHashes, originalFile: diskFile, originalHash, savedHash, dynamicEvidence, conversationEvidence, results,
  limitations: ['Native Edge extension loading, native file-picker permission and second-browser rendering remain manual acceptance; DOM mocks are not native-browser proof.']
};
await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
for (const window of windows) window.close();
console.log(`${results.filter(r => r.status === 'passed').length}/${results.length} passed. Evidence: artifacts/validation/results.json`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
