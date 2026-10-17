import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync, realpathSync, statSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commands = {
  register: { work: "string", workspace: "string", agent: "string", address: "string", replace: "boolean" },
  "self-register": { workspace: "string", agent: "string", hook: "boolean" },
  "install-hooks": { workspace: "string" },
  list: {},
  unregister: { work: "string", address: "string" },
  send: { source: "string", to: "multiple", file: "string", confirm: "boolean" },
};
const usage = `Usage: node scripts/context-notify.mjs <command> [--registry <path>] [options]
  register   --work UUID --workspace /absolute/path --agent codex|claude --address UUID [--replace]
  self-register --agent codex|claude [--workspace <directory>] [--hook]
  install-hooks [--workspace <directory>]
  list
  unregister --work UUID --address UUID
  send       --source UUID --to UUID [--to UUID ...] --file <selected-text-file> [--confirm]

Send previews by default. Use --confirm only after user approval of this content and these targets.
Registry: --registry, KARAZHAN_CONTEXT_REGISTRY, or ~/.local/state/karazhan/context-notify/sessions.json (XDG_STATE_HOME supported).
Self-registration reads work.id from the nearest Workspace manifest and the address from runtime input.
Registration does not verify online status. Concurrent registration writes use a bounded file lock.
Accepted means the native command succeeded; it does not mean read or adopted. No automatic retries.`;

function requireValue(value, name) {
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function requireUuid(value, name) {
  requireValue(value, name);
  if (!uuid.test(value)) throw new Error(`${name} must be an exact UUID`);
  return value.toLowerCase();
}

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error("Invalid registry entry");
  entry.work = requireUuid(entry.work, "work");
  entry.address = requireUuid(entry.address, "address");
  if (!["codex", "claude"].includes(entry.agent)) throw new Error("Supported agents: codex, claude; Hermes is not enabled");
  if (typeof entry.workspace !== "string" || !isAbsolute(entry.workspace)) {
    throw new Error("workspace must be an absolute directory path");
  }
  return { work: entry.work, workspace: entry.workspace, agent: entry.agent, address: entry.address };
}

function readRegistry(path) {
  let entries;
  try { entries = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("Cannot read registry: expected a readable JSON array");
  }
  if (!Array.isArray(entries)) throw new Error("Registry must be a JSON array");
  entries = entries.map(validateEntry);
  if (new Set(entries.map((entry) => entry.work)).size !== entries.length) {
    throw new Error("Registry contains multiple sessions for one Work; select one explicitly");
  }
  return entries;
}

function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function updateRegistry(path, update) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Registration lock is busy; no changes made. Check for another writer or a stale .lock directory");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const entries = readRegistry(path);
    const result = update(entries);
    writeJson(path, entries);
    return result;
  } finally { rmSync(lock, { recursive: true }); }
}

function register(path, entry, replace) {
  return updateRegistry(path, (entries) => {
    const index = entries.findIndex((candidate) => candidate.work === entry.work);
    if (index !== -1 && JSON.stringify(entries[index]) !== JSON.stringify(entry) && !replace) {
      throw new Error("Work already has another registration; verify the new session and use --replace");
    }
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    return entry;
  });
}

function workspaceAt(directory) {
  let root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error("workspace must be a directory");
  while (true) {
    let manifest;
    try { manifest = readFileSync(join(root, ".workbench", "task.yaml"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (manifest !== undefined) {
      // The Workspace contract uses a top-level work mapping with a two-space id scalar.
      const blocks = [...manifest.matchAll(/^work:[ \t]*(?:#.*)?\r?\n((?:[ \t]+[^\n]*\n?|\r?\n)*)/gm)];
      const ids = blocks.length === 1 ? [...blocks[0][1].matchAll(/^  id:[ \t]*(['"]?)([0-9a-f-]+)\1[ \t]*(?:#.*)?\r?$/gmi)] : [];
      if (ids.length !== 1 || [...blocks[0][1].matchAll(/^  id:/gm)].length !== 1) throw new Error("Manifest must contain one work.id scalar in the Workspace contract format");
      return { work: requireUuid(ids[0][2], "work.id"), workspace: root };
    }
    const parent = dirname(root);
    if (parent === root) throw new Error("No Workspace .workbench/task.yaml found above the current directory");
    root = parent;
  }
}

function selfRegister(path, values) {
  if (!["codex", "claude"].includes(values.agent)) throw new Error("Select --agent codex or claude");
  let event;
  if (values.hook) {
    try { event = JSON.parse(readFileSync(0, "utf8")); }
    catch { throw new Error("Expected native Hook JSON on stdin"); }
    if (event?.hook_event_name !== "SessionStart") throw new Error("Expected a SessionStart event");
    if (event.source === "compact") return;
    if (!["startup", "resume", "clear", "fork"].includes(event.source)) throw new Error("Unsupported SessionStart source");
    if (typeof event.cwd !== "string" || !isAbsolute(event.cwd)) throw new Error("Hook cwd must be an absolute path");
  }
  const owner = workspaceAt(values.workspace ?? event?.cwd ?? process.cwd());
  if (event && workspaceAt(event.cwd).workspace !== owner.workspace) {
    throw new Error("Hook cwd belongs to another Workspace; registration was not changed");
  }
  const address = values.agent === "codex" ? (event ? event.session_id : process.env.CODEX_THREAD_ID) : process.env.CMUX_SURFACE_ID;
  const entry = validateEntry({ ...owner, agent: values.agent, address: requireUuid(address, values.agent === "codex" ? "Codex session UUID" : "CMUX_SURFACE_ID") });
  register(path, entry, true);
  if (!values.hook) return entry;
}

function installHooks(path, directory) {
  const owner = workspaceAt(directory ?? process.cwd());
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const script = fileURLToPath(import.meta.url);
  const files = [["codex", ".codex/hooks.json"], ["claude", ".claude/settings.local.json"]].map(([agent, relative]) => {
    const destination = join(owner.workspace, relative);
    let config = {};
    try { config = JSON.parse(readFileSync(destination, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error(`Cannot merge hook settings: ${destination}`); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid hook settings: ${destination}`);
    config.hooks ??= {};
    if (typeof config.hooks !== "object" || Array.isArray(config.hooks)) throw new Error(`Invalid hooks mapping: ${destination}`);
    const groups = config.hooks.SessionStart ?? [];
    if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks))) throw new Error(`Invalid SessionStart handlers: ${destination}`);
    const prefix = `node ${quote(script)} self-register --agent ${agent} --hook`;
    const retained = groups.map((group) => ({ ...group, hooks: group.hooks.filter((handler) => !handler.command?.startsWith(prefix)) })).filter((group) => group.hooks.length);
    config.hooks.SessionStart = [...retained, { matcher: "startup|resume|clear|fork", hooks: [{ type: "command", command: `${prefix} --workspace ${quote(owner.workspace)} --registry ${quote(path)}`, timeout: 10 }] }];
    return { destination, config };
  });
  for (const { destination, config } of files) {
    mkdirSync(dirname(destination), { recursive: true });
    writeJson(destination, config);
  }
  return { workspace: owner.workspace, registry: path, files: files.map((file) => file.destination), note: "Local hooks installed. Native trust review remains required where prompted; existing sessions need self-register or restart." };
}

function findWork(entries, work) {
  const entry = entries.find((candidate) => candidate.work === work);
  if (!entry) throw new Error(`Work is not registered: ${work}`);
  return entry;
}

function send(target, source, message) {
  const command = target.agent === "codex" ? "codex" : "cmux";
  const args = target.agent === "codex"
    ? ["queue", "--thread", target.address, "--message", message]
    : ["agent", "message", target.address, "--from", source.work, "--", "-"];
  const result = spawnSync(command, args, {
    cwd: source.workspace,
    encoding: "utf8",
    input: target.agent === "claude" ? message : "",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const accepted = !result.error && result.status === 0;
  const output = { work: target.work, agent: target.agent, address: target.address, status: accepted ? "accepted" : "failed" };
  if (!accepted) {
    // Native output may contain the body. Keep it out of ordinary send results.
    output.error = result.error
      ? `${command}: ${result.error.code ?? "execution error"}; acceptance unknown, no retry`
      : `${command}: exit ${result.status ?? result.signal}; no retry`;
  }
  return output;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  if (!Object.hasOwn(commands, command)) throw new Error("Unknown command; use --help");
  const options = { registry: { type: "string" } };
  for (const [key, type] of Object.entries(commands[command])) {
    options[key] = type === "multiple" ? { type: "string", multiple: true } : { type };
  }
  const { values } = parseArgs({ args, options, allowPositionals: false });
  const path = resolve(values.registry ?? process.env.KARAZHAN_CONTEXT_REGISTRY ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "karazhan", "context-notify", "sessions.json"));
  if (command === "self-register") return selfRegister(path, values);
  if (command === "install-hooks") return installHooks(path, values.workspace);
  if (command === "list") return readRegistry(path);

  if (command === "register") {
    requireValue(values.workspace, "workspace");
    if (!isAbsolute(values.workspace)) throw new Error("workspace must be an absolute directory path");
    const workspace = realpathSync(values.workspace);
    if (!statSync(workspace).isDirectory()) throw new Error("workspace must be a directory");
    const entry = validateEntry({ ...values, workspace });
    return register(path, entry, values.replace);
  }

  if (command === "unregister") {
    const work = requireUuid(values.work, "work");
    const address = requireUuid(values.address, "address");
    return updateRegistry(path, (entries) => {
      const entry = findWork(entries, work);
      if (entry.address !== address) throw new Error("Address changed; registration was not removed");
      entries.splice(entries.indexOf(entry), 1);
      return { removed: work };
    });
  }

  const entries = readRegistry(path);
  const source = findWork(entries, requireUuid(values.source, "source"));
  if (!values.to?.length) throw new Error("Select at least one --to Work");
  const targets = [...new Set(values.to.map((value) => requireUuid(value, "to")))].map((work) => findWork(entries, work));
  const body = readFileSync(requireValue(values.file, "file"), "utf8");
  if (!body.trim()) throw new Error("Selected text is empty");
  if (body.includes("\0")) throw new Error("Selected text contains a NUL character; use a text file");
  const message = `[Context update]\nSource Work: ${source.work}\nSource Workspace: ${source.workspace}\n` +
    "Assess this source material under your own Context and approval rules. No reply is required.\n\n" + body;
  if (!values.confirm) return { mode: "preview", source, targets, message };
  const results = targets.map((target) => send(target, source, message));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
  return { mode: "send", results };
}

try {
  const result = main();
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`context-notify: ${error.message}`);
  process.exitCode = 1;
}
