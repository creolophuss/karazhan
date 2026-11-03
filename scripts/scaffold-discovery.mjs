import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// JSON-RPC over MCP stdio. This client exposes queries only.
export async function workspaceBindings(command, database) {
  const child = spawn(command, [], { env: { ...process.env, KARAZHAN_DATABASE_PATH: database }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let serial = 0, buffer = '', stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  function fail(error) { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', () => fail(new Error(`MCP discovery stopped: ${stderr}`)));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('Invalid MCP response')); continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    }
  });
  const timeout = setTimeout(() => { fail(new Error('MCP discovery timed out')); child.kill(); }, 15_000);
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const call = (method, params) => new Promise((resolveCall, reject) => {
    const id = ++serial; pending.set(id, { resolve: resolveCall, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'karazhan-scaffold-discovery', version: '1' } });
    notify('notifications/initialized', {});
    async function query(request) {
      const response = await call('tools/call', { name: 'karazhan_query', arguments: { request } });
      if (response.isError) throw new Error(response.content?.[0]?.text || 'MCP query failed');
      return JSON.parse(response.content.find(item => item.type === 'text').text).payload;
    }
    const nodes = [...await query({ type: 'list_projects' }), ...await query({ type: 'list_tasks' })];
    const found = [], warnings = [];
    for (const node of nodes) {
      const bindings = await query({ type: 'list_resource_bindings', node_id: node.id });
      const workspaces = bindings.filter(binding => binding.kind === 'workspace' && binding.is_primary);
      if (!workspaces.length) warnings.push(`No Workspace binding for ${node.id}`);
      for (const binding of workspaces) {
        found.push({ path: binding.locator, work: node.id });
        if (binding.availability !== 'available') warnings.push(`Workspace availability needs local verification for ${node.id}: ${binding.locator}`);
      }
    }
    return { found, warnings };
  } finally { clearTimeout(timeout); child.stdin.end(); child.kill(); }
}

export function nearestWorkspace(path) {
  let root = resolve(path);
  while (!existsSync(join(root, '.workbench/task.yaml'))) {
    if (dirname(root) === root) return null;
    root = dirname(root);
  }
  return root;
}
export async function discover(workspaces, profiles, { home = homedir(), cwd = process.cwd() } = {}) {
  const warnings = [], found = workspaces.map(path => ({ path }));
  const explicit = workspaces.length > 0 || profiles.length > 0;
  if (!explicit) {
    const here = nearestWorkspace(cwd);
    if (here) found.push({ path: here });
    let database = process.env.KARAZHAN_DATABASE_PATH;
    if (!database) {
      const config = spawnSync(process.env.KARAZHAN_HERMES_COMMAND || 'hermes', ['-p', 'medivh', 'config', 'get', 'mcp_servers.karazhan.env.KARAZHAN_DATABASE_PATH'], { encoding: 'utf8', timeout: 5000 });
      if (config.status === 0) database = config.stdout.trim().replace(/^['"]|['"]$/g, '');
    }
    const command = process.env.KARAZHAN_MCP_COMMAND || join(home, '.local/bin/karazhan-mcp');
    if (!database) warnings.push('Karazhan discovery unavailable: no configured database path. Supply --workspace or configure Medivh MCP.');
    else try {
      if (!isAbsolute(database) || !existsSync(database) || !statSync(database).isFile()) throw new Error('Configured database must be an existing regular file at an absolute path; MCP was not started');
      const result = await workspaceBindings(command, database);
      found.push(...result.found); warnings.push(...result.warnings);
    } catch (error) { warnings.push(`Karazhan discovery unavailable: ${error.message}`); }
  }
  const queue = [...found], seen = new Set();
  while (queue.length) {
    const entry = queue.shift(), root = resolve(entry.path);
    const key = `${root}:${entry.work || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Explicit target flags select only those targets.
    if (explicit || !existsSync(join(root, '.workbench/task.yaml'))) continue;
    const related = [];
    const children = join(root, 'children');
    if (existsSync(children)) for (const child of readdirSync(children, { withFileTypes: true })) {
      if (child.isDirectory() && existsSync(join(children, child.name, '.workbench/task.yaml'))) related.push({ path: join(children, child.name) });
    }
    const index = join(root, 'context/index.md');
    if (existsSync(index)) {
      let navigation = false, navigationId = null, workspaceColumn = -1;
      for (const line of readFileSync(index, 'utf8').split('\n')) {
        if (/^## /.test(line)) { navigation = /^## (Owner|Parent|Direct Children|Children|Workspace identity)\s*$/i.test(line); navigationId = null; workspaceColumn = -1; }
        if (!navigation) continue;
        const lineId = line.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
        if (/Work ID:/i.test(line)) navigationId = lineId;
        const columns = /^\|/.test(line) ? line.split('|').map(cell => cell.trim()) : [];
        const header = columns.findIndex(cell => /^(?:Workspace|Workspace path|工作区|工作目录)$/i.test(cell));
        if (header >= 0) { workspaceColumn = header; continue; }
        const candidates = columns.length ? (workspaceColumn >= 0 ? [columns[workspaceColumn]] : []) : /Workspace:/i.test(line) ? [line.replace(/^.*?Workspace:\s*/i, '').trim()] : [];
        for (let candidate of candidates) {
          candidate = candidate.replace(/^`|`$/g, '');
          const link = candidate.match(/^\[[^\]]*\]\((\/.*)\)$/);
          if (link) candidate = link[1];
          if (!isAbsolute(candidate)) continue;
          const relatedRoot = resolve(candidate);
          if (relatedRoot && !/(?:^|\/)(?:artifacts|repos|legacy-workspace)(?:\/|$)/.test(relatedRoot)) related.push({ path: relatedRoot, work: lineId || navigationId });
        }
      }
    }
    for (const item of related) if (!found.some(existing => resolve(existing.path) === item.path && existing.work === item.work)) { found.push(item); queue.push(item); }
  }
  if (!explicit) {
    const stateRoot = process.env.KARAZHAN_INSTALL_STATE_DIR || join(home, '.local/share/karazhan-installer');
    const installedPath = join(stateRoot, 'medivh-profile-path');
    const installed = existsSync(installedPath) ? readFileSync(installedPath, 'utf8').trim() : null;
    let launcherProfile = null;
    const launcher = join(process.env.KARAZHAN_INSTALL_BIN_DIR || join(home, '.local/bin'), 'medivh');
    if (existsSync(launcher)) {
      // Read the installer's literal assignment; never source or execute the launcher.
      const literal = readFileSync(launcher, 'utf8').match(/^PROFILE_DIR='([^'\n]+)'$/m);
      launcherProfile = literal?.[1];
    }
    const candidates = [process.env.KARAZHAN_MEDIVH_PROFILE_DIR, installed, launcherProfile, join(home, '.hermes/profiles/medivh')].filter(Boolean);
    for (const profile of new Set(candidates)) {
      if (existsSync(profile)) profiles.push(profile);
      else warnings.push(`Medivh Profile not found: ${profile}`);
    }
  }
  return { found, profiles, warnings };
}
