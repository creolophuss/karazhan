import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const databasePath = process.env.KARAZHAN_LARGE_LIST_DATABASE_PATH;
const mode = process.argv[2];

if (
  !databasePath ||
  !["seed", "inspect", "create-conflict", "verify-conflict"].includes(mode)
) {
  console.error(
    "usage: KARAZHAN_LARGE_LIST_DATABASE_PATH=/path/karazhan.sqlite3 " +
      "node scripts/large-list-acceptance.mjs " +
      "<seed|inspect|create-conflict|verify-conflict>",
  );
  process.exit(2);
}

const rootId = "00000000-0000-0000-0000-000000000001";
const projectId = (index) =>
  `11000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`;
const taskId = (index) =>
  `22000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`;
const eventId = (index) =>
  `33000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, "0")}`;

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
  const result = await exchange("tools/call", { name, arguments: { request } });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

function context(key) {
  return {
    idempotency_key: `large-list:${key}`,
    actor_type: "work_assistant",
    actor_ref: "work-assistant:large-list-acceptance",
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
    clientInfo: { name: "karazhan-large-list-acceptance", version: "0.1.0" },
  });
  mcp.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
}

async function inspect() {
  const tree = await query({ type: "list_project_task_tree" });
  const today = await query({ type: "list_today" });
  assert.equal(tree.type, "project_task_tree");
  assert.equal(today.type, "today");
  assert.equal(tree.payload.length, 100);
  assert.equal(today.payload.length, 100);
  assert.deepEqual(today.payload.map((item) => item.position), [...today.payload.keys()]);
  assert.equal(new Set(today.payload.map((item) => item.node_id)).size, 100);
  return {
    databasePath,
    treeCount: tree.payload.length,
    todayCount: today.payload.length,
    todayFirst: today.payload.slice(0, 5).map((item) => item.title),
    todayLast: today.payload.slice(-5).map((item) => item.title),
  };
}

async function seed() {
  for (let index = 0; index < 10; index += 1) {
    await command("create_project", {
      id: projectId(index),
      parent_id: rootId,
      key: `large-project-${index + 1}`,
      title: `Large Project ${String(index + 1).padStart(2, "0")}`,
      position: index,
      slug: null,
      context_path: null,
      context: context(`create-project-${index + 1}`),
    });
  }
  for (let index = 0; index < 90; index += 1) {
    await command("create_task", {
      id: taskId(index),
      parent_id: projectId(Math.floor(index / 9)),
      key: `large-task-${index + 1}`,
      title: `Large Task ${String(index + 1).padStart(3, "0")}`,
      position: index % 9,
      context: context(`create-task-${index + 1}`),
    });
  }
  const nodeIds = [
    ...Array.from({ length: 10 }, (_, index) => projectId(index)),
    ...Array.from({ length: 90 }, (_, index) => taskId(index)),
  ];
  for (const [position, nodeId] of nodeIds.entries()) {
    await command("add_today", {
      node_id: nodeId,
      position,
      event_id: eventId(position),
      context: context(`add-today-${position + 1}`),
    });
  }
  return inspect();
}

async function createConflict() {
  const before = await query({ type: "get_project", id: projectId(0) });
  assert.equal(before.type, "project");
  assert.equal(before.payload.status, "planned");
  assert.equal(before.payload.revision, 1);
  await command("update_work_item", {
    node_id: projectId(0),
    title: null,
    summary: null,
    goal: null,
    acceptance: null,
    status: "ready",
    priority: "none",
    blocker: { action: "clear" },
    expected_revision: 1,
    event_id: "44000000-0000-0000-0000-000000000001",
    context: context("external-project-1-ready"),
  });
  const after = await query({ type: "get_project", id: projectId(0) });
  assert.equal(after.type, "project");
  assert.equal(after.payload.status, "ready");
  assert.equal(after.payload.revision, 2);
  return {
    databasePath,
    nodeId: projectId(0),
    before: { status: before.payload.status, revision: before.payload.revision },
    after: { status: after.payload.status, revision: after.payload.revision },
  };
}

async function verifyConflict() {
  const project = await query({ type: "get_project", id: projectId(0) });
  const timeline = await query({
    type: "progress_timeline",
    node_id: projectId(0),
  });
  assert.equal(project.type, "project");
  assert.equal(project.payload.status, "ready");
  assert.equal(project.payload.revision, 2);
  assert.equal(timeline.type, "progress_events");
  return {
    databasePath,
    nodeId: projectId(0),
    status: project.payload.status,
    revision: project.payload.revision,
    timelineCount: timeline.payload.length,
    timeline: timeline.payload.map((event) => ({
      event_kind: event.event_kind,
      summary: event.summary,
      actor_type: event.actor_type,
      channel: event.channel,
    })),
  };
}

try {
  await initialize();
  const result =
    mode === "seed"
      ? await seed()
      : mode === "create-conflict"
        ? await createConflict()
        : mode === "verify-conflict"
          ? await verifyConflict()
        : await inspect();
  console.log(JSON.stringify({ phase: mode, ...result }, null, 2));
} finally {
  mcp.stdin.end();
  const exitCode = await new Promise((resolve) => mcp.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, "", `unexpected MCP stderr: ${stderr}`);
}
