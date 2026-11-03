import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { frame, HOST, MAX_MESSAGE, saveOriginal } from '../native/host.mjs';
import { install } from '../native/install.mjs';

const origin = 'chrome-extension://' + 'a'.repeat(32) + '/';
const hash = value => createHash('sha256').update(value).digest('hex');
const initial = '<!doctype html><html><body>原报告</body></html>';
const updated = '<!doctype html><html><body>批注已保存</body></html>';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'local-html-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '中文 报告.html');
  await writeFile(filename, initial);
  const config = path.join(directory, 'host.json');
  await writeFile(config, JSON.stringify({ allowed_origins: [origin] }));
  return { directory, filename, config, request: { operation: 'save', url: pathToFileURL(filename).href, expectedHash: hash(initial), source: updated } };
}

async function invoke(program, args, bytes, { fragment = false } = {}) {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), 5_000);
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => {});
  if (fragment) {
    child.stdin.write(bytes.subarray(0, 2));
    await new Promise(resolve => setTimeout(resolve, 15));
    child.stdin.write(bytes.subarray(2));
    // The browser keeps stdin open while it awaits the response.
  } else child.stdin.end(bytes);
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, Buffer.concat(stderr).toString());
    const output = Buffer.concat(stdout);
    const length = endianness() === 'LE' ? output.readUInt32LE() : output.readUInt32BE();
    assert.equal(output.length, length + 4, 'stdout contains exactly one framed reply');
    assert.ok(length < 1024 * 1024, 'reply stays below the browser limit');
    return JSON.parse(output.subarray(4).toString());
  } finally { clearTimeout(timer); child.kill(); }
}

const host = fileURLToPath(new URL('../native/host.mjs', import.meta.url));

test('native process saves the original from a fragmented frame and exits without stdin EOF', async t => {
  const f = await fixture(t);
  await chmod(f.filename, 0o640);
  const result = await invoke(process.execPath, [host, f.config, origin], frame(f.request), { fragment: true });
  assert.deepEqual(result, { ok: true, hash: hash(updated) });
  assert.equal(await readFile(f.filename, 'utf8'), updated);
  assert.equal((await stat(f.filename)).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(f.directory)).sort(), ['host.json', '中文 报告.html']);
});

test('large HTML uses a small native reply rather than echoing file contents', async t => {
  const f = await fixture(t);
  const source = '<html>' + 'large report '.repeat(130_000) + '</html>';
  const result = await invoke(process.execPath, [host, f.config, origin], frame({ ...f.request, source }));
  assert.deepEqual(result, { ok: true, hash: hash(source) });
  assert.equal(await readFile(f.filename, 'utf8'), source);
});

test('unapproved origin, external modifications and unsupported targets never overwrite', async t => {
  const f = await fixture(t);
  const denied = await invoke(process.execPath, [host, f.config, origin.replaceAll('a', 'b')], frame(f.request));
  assert.equal(denied.ok, false);
  await writeFile(f.filename, initial + '外部修改');
  const conflict = await invoke(process.execPath, [host, f.config, origin], frame(f.request));
  assert.equal(conflict.ok, false); assert.match(conflict.error, /外部修改/);
  for (const url of ['https://example.com/report.html', 'file:///tmp/report.pdf', f.request.url + '?other=1']) {
    await assert.rejects(saveOriginal({ ...f.request, url }));
  }
  assert.equal(await readFile(f.filename, 'utf8'), initial + '外部修改');
  assert.deepEqual((await readdir(f.directory)).sort(), ['host.json', '中文 报告.html']);
});

test('symbolic links, hard links, read-only and missing files are rejected', async t => {
  const f = await fixture(t);
  const linked = path.join(f.directory, 'link.html');
  await symlink(f.filename, linked);
  await assert.rejects(saveOriginal({ ...f.request, url: pathToFileURL(linked).href }), /链接/);
  await rm(linked); await link(f.filename, linked);
  await assert.rejects(saveOriginal(f.request), /链接/);
  await rm(linked); await chmod(f.filename, 0o444);
  await assert.rejects(saveOriginal(f.request));
  await chmod(f.filename, 0o600); await rm(f.filename);
  await assert.rejects(saveOriginal(f.request), { code: 'ENOENT' });
  assert.equal((await readdir(f.directory)).includes('中文 报告.html'), false);
});

test('invalid UTF-8 and lock conflicts leave the original intact', async t => {
  const f = await fixture(t);
  const lock = path.join(f.directory, '.中文 报告.html.local-html-notes.lock');
  await writeFile(lock, 'another writer');
  await assert.rejects(saveOriginal(f.request), /正在保存/);
  assert.equal(await readFile(lock, 'utf8'), 'another writer');
  await rm(lock);
  await writeFile(f.filename, Buffer.from([0xff, 0xfe]));
  await assert.rejects(saveOriginal({ ...f.request, expectedHash: hash(Buffer.from([0xff, 0xfe])) }));
  assert.deepEqual(await readFile(f.filename), Buffer.from([0xff, 0xfe]));
  assert.equal((await readdir(f.directory)).some(name => /\.tmp$|\.lock$/.test(name)), false);
});

test('truncated, oversized and invalid native messages produce framed failures', async t => {
  const f = await fixture(t);
  const oversized = frame({});
  if (endianness() === 'LE') oversized.writeUInt32LE(MAX_MESSAGE + 1);
  else oversized.writeUInt32BE(MAX_MESSAGE + 1);
  for (const bytes of [Buffer.from([1, 2]), oversized, frame({ operation: 'run-shell' })]) {
    const result = await invoke(process.execPath, [host, f.config, origin], bytes);
    assert.equal(result.ok, false);
  }
  assert.equal(await readFile(f.filename, 'utf8'), initial);
});

test('installer registers the exact ID and its launcher works with spaces and shell metacharacters', async t => {
  const f = await fixture(t);
  const home = path.join(f.directory, "user's home $(touch SHOULD_NOT_EXIST)");
  await mkdir(home);
  const installed = await install({ extensionId: 'a'.repeat(32), home });
  const manifest = JSON.parse(await readFile(installed.manifestPath));
  assert.equal(manifest.name, HOST); assert.deepEqual(manifest.allowed_origins, [origin]);
  assert.equal(manifest.path, installed.launcher);
  const result = await invoke(installed.launcher, [origin], frame(f.request));
  assert.equal(result.ok, true);
  assert.equal(await readFile(f.filename, 'utf8'), updated);
  await install({ extensionId: 'a'.repeat(32), home });
  await install({ extensionId: 'b'.repeat(32), home });
  assert.deepEqual(JSON.parse(await readFile(installed.manifestPath)).allowed_origins, [origin.replaceAll('a', 'b')]);
  await writeFile(installed.manifestPath, JSON.stringify({ ...manifest, path: '/another/program' }));
  await assert.rejects(install({ extensionId: 'b'.repeat(32), home }), /未覆盖/);
  await assert.rejects(install({ extensionId: '*', home }));
  assert.equal((await readdir(f.directory)).includes('SHOULD_NOT_EXIST'), false);
});
