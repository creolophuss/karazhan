import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const databasePath = process.env.KARAZHAN_ACCEPTANCE_DATABASE_PATH;
const mode = process.argv[2];

if (!databasePath || !["seed", "verify"].includes(mode)) {
  console.error(
    "usage: KARAZHAN_ACCEPTANCE_DATABASE_PATH=/path/karazhan.sqlite3 " +
      "node scripts/acceptance-workflow.mjs <seed|verify>",
  );
  process.exit(2);
}

const ids = {
  project: "10000000-0000-0000-0000-00000000a101",
  taskA: "20000000-0000-0000-0000-00000000a201",
  taskB: "20000000-0000-0000-0000-00000000a202",
  child: "20000000-0000-0000-0000-00000000a203",
  progress: "44000000-0000-0000-0000-00000000a401",
};

const mcp = spawn("target/debug/karazhan-mcp", [], {
  cwd: process.cwd(),
  env: { ...process.env, KARAZHAN_DATABASE_PATH: databasePath },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
let stderr = "";
mcp.stderr.setEncoding("utf8");
mcp.stderr.on("data", (chunk) => {
  stderr += chunk;
});
let requestId = 0;

async function exchange(method, params) {
  requestId += 1;
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  const next = await lines.next();
  assert.equal(next.done, false, "MCP stdout ended before a response");
  const response = JSON.parse(next.value);
  assert.equal(response.id, requestId);
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}

async function tool(name, request) {
  const result = await exchange("tools/call", {
    name,
    arguments: { request },
  });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function context(key) {
  return {
    idempotency_key: `acceptance:${key}`,
    actor_type: "work_assistant",
    actor_ref: "work-assistant:desktop-acceptance",
    channel: "mcp",
  };
}

async function command(type, payload) {
  return tool("karazhan_command", { type, payload });
}

async function query(request) {
  return tool("karazhan_query", request);
}

async function initialize() {
  await exchange("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "karazhan-desktop-acceptance", version: "0.1.0" },
  });
  mcp.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
}

async function seed() {
  await command("create_project", {
    id: ids.project,
    parent_id: "00000000-0000-0000-0000-000000000001",
    key: "acceptance-project",
    title: "Acceptance Project",
    position: 0,
    slug: null,
    context_path: null,
    context: context("create-project"),
  });
  await command("create_task", {
    id: ids.taskA,
    parent_id: ids.project,
    key: "persistence-task",
    title: "Persistence Task",
    position: 0,
    context: context("create-task-a"),
  });
  await command("create_task", {
    id: ids.taskB,
    parent_id: ids.project,
    key: "reorder-task",
    title: "Reorder Task",
    position: 1,
    context: context("create-task-b"),
  });
  await command("create_task", {
    id: ids.child,
    parent_id: ids.taskA,
    key: "restart-verification",
    title: "Restart Verification",
    position: 0,
    context: context("create-child"),
  });
  await command("append_progress", {
    node_id: ids.taskA,
    event_id: ids.progress,
    event_kind: "progress",
    summary: "Created through Work Assistant MCP",
    expected_revision: 1,
    context: context("append-progress"),
  });

  const tree = await query({ type: "list_project_task_tree" });
  assert.equal(tree.type, "project_task_tree");
  assert.deepEqual(
    tree.payload.map(({ id, parent_id, title }) => ({ id, parent_id, title })),
    [
      { id: ids.project, parent_id: "00000000-0000-0000-0000-000000000001", title: "Acceptance Project" },
      { id: ids.taskA, parent_id: ids.project, title: "Persistence Task" },
      { id: ids.taskB, parent_id: ids.project, title: "Reorder Task" },
      { id: ids.child, parent_id: ids.taskA, title: "Restart Verification" },
    ],
  );
  console.log(JSON.stringify({ phase: "seed", databasePath, ids, tree: tree.payload }, null, 2));
}

async function verify() {
  const task = await query({ type: "get_task", id: ids.taskA });
  const today = await query({ type: "list_today" });
  const timeline = await query({ type: "progress_timeline", node_id: ids.taskA });

  assert.equal(task.type, "task");
  assert.equal(task.payload.status, "in_progress");
  assert.equal(task.payload.priority, "high");
  assert.equal(task.payload.blocker, "Verifyrestartpersistence");
  assert.equal(today.type, "today");
  assert.deepEqual(
    today.payload.map(({ node_id, title, position }) => ({ node_id, title, position })),
    [
      { node_id: ids.taskB, title: "Reorder Task", position: 0 },
      { node_id: ids.taskA, title: "Persistence Task", position: 1 },
    ],
  );
  assert.equal(timeline.type, "progress_events");
  assert.ok(
    timeline.payload.some((event) => event.summary === "Created through Work Assistant MCP"),
  );

  console.log(
    JSON.stringify(
      {
        phase: "verify",
        databasePath,
        task: task.payload,
        today: today.payload,
        timeline: timeline.payload,
      },
      null,
      2,
    ),
  );
}

try {
  await initialize();
  if (mode === "seed") await seed();
  else await verify();
} finally {
  mcp.stdin.end();
  const exitCode = await new Promise((resolve) => mcp.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, "", `unexpected MCP stderr: ${stderr}`);
}
