import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const custodianSkills = ['workspace-provisioning', 'karazhan-mcp-collaboration'];
export const medivhSkills = ['workspace-provisioning', 'medivh-karazhan-registration'];
export const retiredSkill = 'answer-me-with-html';
export const sha = value => createHash('sha256').update(value).digest('hex');
export function files(root, exclude = []) {
  const found = [];
  function visit(path) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlink in managed content: ${path}`);
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!exclude.includes(relative(root, path))) found.push(path);
  }
  visit(root);
  return found.sort((a, b) => Buffer.compare(Buffer.from(relative(root, a)), Buffer.from(relative(root, b))));
}
// Keep the existing installer's portable shasum manifest format.
export function digest(path, exclude = []) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isDirectory()) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Managed symlink: ${path}`);
    return sha(readFileSync(path));
  }
  return sha(files(path, exclude).map(file => `${sha(readFileSync(file))}  ./${relative(path, file).split('\\').join('/')}\n`).join(''));
}
export function sourceVersion(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (git('rev-parse', '--is-shallow-repository') !== 'false') throw new Error('Complete Git history is required for scaffold versions');
  const base = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'))).version.split('.').slice(0, 2).join('.');
  return { commit: git('rev-parse', 'HEAD'), version: `${base}.${git('rev-list', '--count', 'HEAD')}`, state: git('status', '--porcelain', '--', 'blueprints') ? 'modified' : 'clean' };
}
export function makePackage(root, destination, source = sourceVersion(root)) {
  mkdirSync(destination, { recursive: true });
  for (const skill of custodianSkills) cpSync(join(root, 'blueprints/skills', skill), join(destination, skill), { recursive: true });
  writeFileSync(join(destination, 'PACKAGE.md'), `# Custodian startup kit\n\n- Install version: ${source.version}\n- Source repository: ${root}\n- Source commit: ${source.commit}\n- Source state: ${source.state}\n- Skills digest (SHA-256): ${digest(destination)}\n- Installed Skills: ${custodianSkills.join(', ')}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , command, root, destination, version, commit, state] = process.argv;
  if (command !== 'package') throw new Error('Expected package <repository> <destination> <version> <commit> <state>');
  makePackage(root, destination, { version, commit, state });
}
