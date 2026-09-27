import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createKarazhanClient } from "../src/lib/karazhan-client.ts";

test("the client maps the shared contract to the three Tauri commands", async () => {
  const calls = [];
  const invoke = async (command, arguments_) => {
    calls.push([command, arguments_]);
    return { type: "mutation", payload: { revision: 1, replayed: false } };
  };
  const client = createKarazhanClient(invoke);
  const command = {
    type: "add_today",
    payload: {
      node_id: "task-1",
      position: 0,
      event_id: "event-1",
      context: {
        idempotency_key: "request-1",
        actor_type: "user",
        actor_ref: null,
        channel: "ui",
      },
    },
  };
  const query = { type: "list_today" };

  await client.execute(command);
  await client.query(query);
  await client.openInZed("task-1");

  assert.deepEqual(calls, [
    ["execute_command", { command }],
    ["run_query", { query }],
    ["open_in_zed", { nodeId: "task-1" }],
  ]);
});

test("structured Tauri errors pass through unchanged", async () => {
  const error = { code: "revision_conflict", message: "stale revision" };
  const client = createKarazhanClient(async () => {
    throw error;
  });

  await assert.rejects(client.query({ type: "list_today" }), (actual) => {
    assert.equal(actual, error);
    return true;
  });
});

test("React modules never import native APIs directly", async () => {
  const sourceDirectory = new URL("../src/", import.meta.url);
  const entries = await readdir(sourceDirectory, { recursive: true });
  const modules = entries.filter((entry) => /\.(ts|tsx)$/.test(entry));

  for (const module of modules) {
    const source = await readFile(join(sourceDirectory.pathname, module), "utf8");
    if (module === "lib/karazhan-client.ts") {
      assert.match(source, /@tauri-apps\/api\/core/);
      continue;
    }
    assert.doesNotMatch(source, /@tauri-apps\/api|invoke\s*\(/, module);
    assert.doesNotMatch(source, /node:fs|node:child_process|sqlite/i, module);
  }
});

test("Projects membership changes refresh the mounted Today page state", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const projectsSource = await readFile(
    new URL("../src/components/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    appSource,
    /<ProjectsPage onTodayChanged=\{acceptRefreshedToday\}/,
  );
  assert.match(projectsSource, /onTodayChanged\(todayItems\)/);
});

test("visible Today and Projects pages promptly refresh external writes", async () => {
  const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const projectsSource = await readFile(
    new URL("../src/components/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );

  for (const source of [appSource, projectsSource]) {
    assert.match(source, /PAGE_REFRESH_INTERVAL_MS = 1_000/);
    assert.match(source, /window\.setInterval/);
    assert.match(source, /window\.addEventListener\("focus"/);
    assert.match(source, /document\.addEventListener\("visibilitychange"/);
    assert.match(source, /refreshing/);
  }

  assert.match(appSource, /activePage !== "today"/);
  assert.match(projectsSource, /setExpandedNodeIds\(\(current\)/);
});
