import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { endianness } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = 'com.karazhan.local_html_notes';
export const MAX_MESSAGE = 64 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readLength = bytes => endianness() === 'LE' ? bytes.readUInt32LE() : bytes.readUInt32BE();

export function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(bytes.length);
  else header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

async function readRequest(input) {
  let bytes = Buffer.alloc(0), size;
  for await (const chunk of input) {
    bytes = Buffer.concat([bytes, chunk]);
    if (size === undefined && bytes.length >= 4) {
      size = readLength(bytes);
      if (!size || size > MAX_MESSAGE) throw new Error('保存消息过大或无效。');
    }
    if (size !== undefined && bytes.length >= size + 4) {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, size + 4)));
    }
  }
  throw new Error('保存消息不完整。');
}

export async function saveOriginal(request) {
  if (request?.operation !== 'save' || typeof request.source !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedHash)) {
    throw new Error('保存请求无效。');
  }
  const url = new URL(request.url);
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) throw new Error('只能保存当前本地 HTML。');
  const filename = fileURLToPath(url);
  if (path.extname(filename).toLowerCase() !== '.html') throw new Error('只能覆盖 .html 文件。');
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('只能覆盖普通 HTML 文件，不能覆盖链接。');
  await access(filename, constants.W_OK);
  if (!(before.mode & 0o222)) throw new Error('原文件不可写。');
  const lockPath = path.join(path.dirname(filename), `.${path.basename(filename)}.local-html-notes.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('此文件正在保存，或上次保存中断。请检查临时锁文件后重试。');
    throw error;
  }
  let temporary;
  try {
    const original = await readFile(filename);
    new TextDecoder('utf-8', { fatal: true }).decode(original);
    if (hash(original) !== request.expectedHash) throw new Error('文件已被外部修改。未覆盖，请刷新原文件。');
    const candidate = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    const stream = await open(candidate, 'wx', before.mode & 0o777);
    temporary = candidate;
    try {
      await stream.writeFile(request.source, 'utf8');
      await stream.chmod(before.mode & 0o777);
      await stream.sync();
    } finally { await stream.close(); }
    const latest = await lstat(filename);
    if (!latest.isFile() || latest.ino !== before.ino || latest.dev !== before.dev || latest.nlink !== 1 || hash(await readFile(filename)) !== request.expectedHash) {
      throw new Error('文件已被外部修改。未覆盖，请刷新原文件。');
    }
    await rename(temporary, filename);
    temporary = null;
    return { ok: true, hash: hash(Buffer.from(request.source)) };
  } finally {
    try { if (temporary) await unlink(temporary); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}

async function main() {
  let reply;
  try {
    const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
    if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(process.argv[3]) || !config.allowed_origins?.includes(process.argv[3])) {
      throw new Error('此扩展未获本机助手授权，请重新安装助手。');
    }
    reply = await saveOriginal(await readRequest(process.stdin));
  } catch (error) {
    const message = ({ ENOENT: '原文件已移动或删除，未保存。', EACCES: '没有文件或目录写权限，未保存。', EPERM: '系统拒绝写入，未保存。' })[error.code] || error.message;
    reply = { ok: false, error: message };
  }
  // Native Messaging permits only framed JSON on stdout. Exit after one response.
  process.stdin.destroy();
  process.stdout.write(frame(reply), () => process.exit(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => null)) await main();
