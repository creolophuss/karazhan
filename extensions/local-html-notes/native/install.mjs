import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST } from './host.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export async function install({ extensionId, home = homedir(), node = process.execPath }) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('请提供 edge://extensions 中的 32 位扩展 ID。');
  const directory = path.join(home, 'Library/Application Support/Karazhan Local HTML Notes');
  const manifestDirectory = path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts');
  const manifestPath = path.join(manifestDirectory, HOST + '.json');
  const launcher = path.join(directory, 'launch.sh');
  const configPath = path.join(directory, 'host.json');
  const manifest = { name: HOST, description: 'Save local HTML notes', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  try {
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (previous.name !== HOST || previous.path !== launcher || previous.type !== 'stdio') {
      throw new Error('已有助手登记指向其他程序，未覆盖。请先检查已有安装。');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(path.join(directory, 'host.mjs'), await readFile(new URL('./host.mjs', import.meta.url)), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(directory, 'host.mjs'))} ${quote(configPath)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return { manifestPath, launcher, extensionId };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => null)) {
  try {
    if (process.platform !== 'darwin') throw new Error('此安装命令目前仅支持 macOS Edge。');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('本机助手需要 Node.js 24 或更高版本。');
    if (process.argv.length !== 4 || process.argv[2] !== '--extension-id') throw new Error('用法：node native/install.mjs --extension-id <32 位扩展 ID>');
    const result = await install({ extensionId: process.argv[3] });
    console.log(`本机助手已安装：${result.manifestPath}\n请在 edge://extensions 重新加载扩展，并刷新报告页。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
