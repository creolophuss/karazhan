import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../../scripts/context-notify.mjs", import.meta.url));
const source = "10000000-0000-0000-0000-000000000001";
const codex = "10000000-0000-0000-0000-000000000002";
const claude = "10000000-0000-0000-0000-000000000003";
const unknown = "10000000-0000-0000-0000-000000000004";
const session = "20000000-0000-0000-0000-000000000002";
const surface = "20000000-0000-0000-0000-000000000003";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "karazhan-context-notify-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "sessions.json");
  const calls = join(root, "calls.jsonl");
  const body = join(root, "selected.md");
  const text = "只发送用户选择的第 1、3 段。\n$(touch SHOULD_NOT_EXIST) `literal` ; ' \"\n";
  writeFileSync(body, text);
  for (const name of ["codex", "cmux"]) {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const call = {command: ${JSON.stringify(name)}, args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8")};\n` +
      `fs.appendFileSync(process.env.NOTIFY_TEST_CALLS, JSON.stringify(call) + "\\n");\n` +
      `process.stdout.write("native output must not appear in the result");\n` +
      `process.exit(process.env.NOTIFY_TEST_FAIL === ${JSON.stringify(name)} ? 7 : 0);\n`);
    chmodSync(path, 0o700);
  }
  const run = (args, env = {}, input) => spawnSync(process.execPath, [cli, ...args, "--registry", registry], {
    cwd: root, encoding: "utf8",
    input,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, NOTIFY_TEST_CALLS: calls, ...env },
  });
  const register = (work, agent, address, extra = []) => run([
    "register", "--work", work, "--workspace", root, "--agent", agent,
    "--address", address, ...extra,
  ]);
  const sent = () => {
    try { return readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const send = ["send", "--source", source, "--to", codex, "--to", claude, "--file", body];
  return { root, registry, calls, body, text, run, register, sent, send };
}

function registerAll(f) {
  for (const args of [[source, "codex", source], [codex, "codex", session], [claude, "claude", surface]]) {
    const result = f.register(...args);
    assert.equal(result.status, 0, result.stderr);
  }
}

test("registration protects address changes and stale removal", (t) => {
  const f = fixture(t);
  assert.equal(f.register(source, "codex", source).status, 0);
  assert.equal(f.register(source, "codex", source).status, 0);
  assert.notEqual(f.register(source, "codex", session).status, 0);
  assert.equal(f.register(source, "codex", session, ["--replace"]).status, 0);
  assert.notEqual(f.run(["unregister", "--work", source, "--address", source]).status, 0);
  const list = f.run(["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].address, session);
  assert.equal(f.run(["unregister", "--work", source, "--address", session]).status, 0);
  assert.deepEqual(JSON.parse(f.run(["list"]).stdout), []);
  assert.deepEqual(f.sent(), []);
});

function workspace(f, work = source) {
  mkdirSync(join(f.root, ".workbench"), { recursive: true });
  writeFileSync(join(f.root, ".workbench", "task.yaml"), `schema_version: 1\nwork:\n  id: "${work}"\n  kind: project\nworkspace:\n  path: "${f.root}"\n`);
}

test("Codex self-registration reads its Work from the nearest manifest and its session from the environment", (t) => {
  const f = fixture(t);
  workspace(f);
  const nested = join(f.root, "repos", "app");
  mkdirSync(nested, { recursive: true });
  const result = f.run(["self-register", "--agent", "codex", "--workspace", nested], { CODEX_THREAD_ID: session });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { work: source, workspace: f.root, agent: "codex", address: session });
  const resumed = f.run(["self-register", "--agent", "codex"], { CODEX_THREAD_ID: surface });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(f.run(["list"]).stdout)[0].address, surface);
  assert.deepEqual(f.sent(), []);
});

test("native startup and resume hook input registers the runtime session, never transcript content", (t) => {
  const f = fixture(t);
  workspace(f);
  for (const [sourceName, address] of [["startup", session], ["resume", surface], ["fork", session], ["clear", surface]]) {
    const result = f.run(["self-register", "--agent", "codex", "--hook", "--workspace", f.root],
      { CODEX_THREAD_ID: unknown }, JSON.stringify({ hook_event_name: "SessionStart", source: sourceName, session_id: address, cwd: f.root, transcript_path: "DO_NOT_SAVE", private: "DO_NOT_SAVE" }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(f.run(["list"]).stdout)[0].address, address);
    assert.ok(!readFileSync(f.registry, "utf8").includes("DO_NOT_SAVE"));
  }
  const compact = f.run(["self-register", "--agent", "codex", "--hook"], {}, JSON.stringify({ hook_event_name: "SessionStart", source: "compact", session_id: unknown, cwd: f.root }));
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(JSON.parse(f.run(["list"]).stdout)[0].address, surface);
});

test("Claude self-registration uses the current cmux surface, not a Codex or Claude session id", (t) => {
  const f = fixture(t);
  workspace(f);
  const result = f.run(["self-register", "--agent", "claude", "--hook"], { CMUX_SURFACE_ID: surface, CODEX_THREAD_ID: unknown },
    JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: session, cwd: f.root }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(f.run(["list"]).stdout)[0].address, surface);
  assert.deepEqual(f.sent(), []);
});

test("missing identity or runtime address and foreign hook workspaces cannot create registrations", (t) => {
  const f = fixture(t);
  const env = { CODEX_THREAD_ID: "", CMUX_SURFACE_ID: "", CMUX_WORKSPACE_ID: surface };
  assert.notEqual(f.run(["self-register", "--agent", "codex"], env).status, 0);
  workspace(f);
  assert.notEqual(f.run(["self-register", "--agent", "codex"], env).status, 0);
  assert.notEqual(f.run(["self-register", "--agent", "claude"], env).status, 0);
  const child = join(f.root, "child");
  mkdirSync(join(child, ".workbench"), { recursive: true });
  writeFileSync(join(child, ".workbench", "task.yaml"), `work:\n  id: ${unknown}\n`);
  const foreign = f.run(["self-register", "--agent", "codex", "--hook", "--workspace", f.root], env,
    JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: child }));
  assert.notEqual(foreign.status, 0);
  assert.equal(existsSync(f.registry), false);
  assert.deepEqual(f.sent(), []);
});

test("hook installation merges both hosts without replacing existing handlers or creating duplicates", (t) => {
  const f = fixture(t);
  workspace(f);
  mkdirSync(join(f.root, ".codex"));
  mkdirSync(join(f.root, ".claude"));
  const codexPath = join(f.root, ".codex", "hooks.json");
  const claudePath = join(f.root, ".claude", "settings.local.json");
  const original = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing-hook" }] }], Stop: [{ hooks: [{ type: "command", command: "stop-hook" }] }] }, description: "preserve me" };
  writeFileSync(codexPath, JSON.stringify(original));
  writeFileSync(claudePath, JSON.stringify({ ...original, permissions: { allow: ["Read"] } }));
  for (let i = 0; i < 2; i++) assert.equal(f.run(["install-hooks"]).status, 0);
  for (const path of [codexPath, claudePath]) {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(settings.description, "preserve me");
    assert.deepEqual(settings.hooks.Stop, original.hooks.Stop);
    const handlers = settings.hooks.SessionStart.flatMap((group) => group.hooks);
    assert.equal(handlers.length, 2);
    assert.equal(handlers[0].command, "existing-hook");
    const managed = handlers[1];
    assert.match(managed.command, /self-register --agent (codex|claude) --hook/);
    const event = { hook_event_name: "SessionStart", source: "startup", session_id: session, cwd: f.root };
    const result = spawnSync("/bin/sh", ["-c", managed.command], { cwd: f.root, encoding: "utf8", input: JSON.stringify(event), env: { ...process.env, CMUX_SURFACE_ID: surface } });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(JSON.parse(readFileSync(claudePath, "utf8")).permissions, { allow: ["Read"] });
  assert.deepEqual(f.sent(), []);
});

test("invalid existing hook settings prevent any installation writes", (t) => {
  const f = fixture(t);
  workspace(f);
  mkdirSync(join(f.root, ".claude"));
  const path = join(f.root, ".claude", "settings.local.json");
  writeFileSync(path, "{broken");
  assert.notEqual(f.run(["install-hooks"]).status, 0);
  assert.equal(readFileSync(path, "utf8"), "{broken");
  assert.equal(existsSync(join(f.root, ".codex", "hooks.json")), false);
});

test("simultaneous self-registration for different Workspaces preserves all routes", async (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 8 }, (_, i) => `30000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  await Promise.all(ids.map((id, i) => {
    const directory = join(f.root, `work-${i}`);
    mkdirSync(join(directory, ".workbench"), { recursive: true });
    writeFileSync(join(directory, ".workbench", "task.yaml"), `work:\n  id: ${id}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "self-register", "--agent", "codex", "--registry", f.registry], { cwd: directory, env: { ...process.env, CODEX_THREAD_ID: session } });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
  }));
  assert.deepEqual(JSON.parse(f.run(["list"]).stdout).map((entry) => entry.work).sort(), ids.sort());
});

test("the shared registry default honors XDG_STATE_HOME without writing to the real user state", (t) => {
  const f = fixture(t);
  workspace(f);
  const env = { ...process.env, XDG_STATE_HOME: join(f.root, "state"), CODEX_THREAD_ID: session };
  delete env.KARAZHAN_CONTEXT_REGISTRY;
  const result = spawnSync(process.execPath, [cli, "self-register", "--agent", "codex"], { cwd: f.root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const path = join(f.root, "state", "karazhan", "context-notify", "sessions.json");
  assert.equal(JSON.parse(readFileSync(path, "utf8"))[0].work, source);
});

test("preview includes selected content and addresses without invoking either channel", (t) => {
  const f = fixture(t);
  registerAll(f);
  const result = f.run(f.send);
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.mode, "preview");
  assert.deepEqual(preview.targets.map((entry) => entry.address), [session, surface]);
  assert.ok(preview.message.includes(f.text));
  assert.ok(preview.message.includes(source));
  assert.ok(preview.message.includes(f.root));
  assert.deepEqual(f.sent(), []);
  assert.ok(!readFileSync(f.registry, "utf8").includes(f.text));
});

test("confirmed sends route exact content through argv and stdin without a shell", (t) => {
  const f = fixture(t);
  registerAll(f);
  const preview = JSON.parse(f.run(f.send).stdout);
  const result = f.run([...f.send, "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.sent();
  assert.deepEqual(calls.map((entry) => entry.command), ["codex", "cmux"]);
  assert.deepEqual(calls[0].args, ["queue", "--thread", session, "--message", preview.message]);
  assert.deepEqual(calls[1].args, ["agent", "message", surface, "--from", source, "--", "-"]);
  assert.equal(calls[1].stdin, preview.message);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.results.map((entry) => entry.status), ["accepted", "accepted"]);
  assert.ok(!result.stdout.includes(f.text));
  assert.ok(!result.stdout.includes("native output"));
  assert.deepEqual(f.run(["list"]).status, 0);
});

test("only selected targets receive messages, including once when listed twice", (t) => {
  const f = fixture(t);
  registerAll(f);
  const result = f.run(["send", "--source", source, "--to", claude, "--to", claude, "--file", f.body, "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].command, "cmux");
});

test("unknown targets and unsupported registry entries fail before any channel runs", (t) => {
  const f = fixture(t);
  registerAll(f);
  assert.notEqual(f.run([...f.send, "--to", unknown, "--confirm"]).status, 0);
  assert.notEqual(f.run(["send", "--source", unknown, "--to", codex, "--file", f.body, "--confirm"]).status, 0);
  const entries = JSON.parse(readFileSync(f.registry, "utf8"));
  entries.find((entry) => entry.work === claude).agent = "hermes";
  writeFileSync(f.registry, JSON.stringify(entries));
  assert.notEqual(f.run([...f.send, "--confirm"]).status, 0);
  assert.deepEqual(f.sent(), []);
});

test("a native failure is reported per target without retrying or hiding other results", (t) => {
  const f = fixture(t);
  registerAll(f);
  const result = f.run([...f.send, "--confirm"], { NOTIFY_TEST_FAIL: "codex" });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.results.map((entry) => entry.status), ["failed", "accepted"]);
  assert.match(output.results[0].error, /7/);
  assert.equal(f.sent().length, 2);
  assert.ok(!readFileSync(f.registry, "utf8").includes("status"));
});

test("invalid addresses, unsupported agents, missing or empty content, and bad flags never send", (t) => {
  const f = fixture(t);
  assert.notEqual(f.register(source, "hermes", source).status, 0);
  assert.notEqual(f.register(source, "claude", "workspace:2").status, 0);
  registerAll(f);
  assert.notEqual(f.run([...f.send, "--confirm", "--bogus"]).status, 0);
  rmSync(f.body);
  assert.notEqual(f.run([...f.send, "--confirm"]).status, 0);
  writeFileSync(f.body, "   \n");
  assert.notEqual(f.run([...f.send, "--confirm"]).status, 0);
  writeFileSync(f.body, "invalid\0body");
  assert.notEqual(f.run([...f.send, "--confirm"]).status, 0);
  assert.deepEqual(f.sent(), []);
});

test("a missing native command reports unknown acceptance without leaking the body", (t) => {
  const f = fixture(t);
  registerAll(f);
  rmSync(join(f.root, "codex"));
  const result = f.run(["send", "--source", source, "--to", codex, "--file", f.body, "--confirm"], { PATH: f.root });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.results[0].status, "failed");
  assert.match(output.results[0].error, /ENOENT/);
  assert.ok(!result.stdout.includes(f.text));
  assert.deepEqual(f.sent(), []);
});

test("corrupt and ambiguous registries do not cause sends or get overwritten", (t) => {
  const f = fixture(t);
  registerAll(f);
  const entries = JSON.parse(readFileSync(f.registry, "utf8"));
  const duplicate = JSON.stringify([...entries, { ...entries[1], address: surface }]);
  for (const invalid of ["{incomplete", duplicate]) {
    writeFileSync(f.registry, invalid);
    assert.notEqual(f.run([...f.send, "--confirm"]).status, 0);
    assert.notEqual(f.register(source, "codex", source).status, 0);
    assert.equal(readFileSync(f.registry, "utf8"), invalid);
  }
  assert.deepEqual(f.sent(), []);
});
