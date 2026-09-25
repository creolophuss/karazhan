import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addTodayMembership,
  createQuickItem,
  deleteQuickItem,
  moveTodayItem,
  removeTodayMembership,
  reorderTodayMembership,
} from "../src/features/today.ts";

test("Today quick items use dedicated shared-core commands", async () => {
  const commands = [];
  const client = {
    async execute(command) {
      commands.push(command);
      return { type: "mutation", payload: { revision: 1, replayed: false } };
    },
  };

  await createQuickItem(client, "Reply to review", () => "quick-1");
  await deleteQuickItem(client, "quick-1", 1, () => "delete-1");

  assert.deepEqual(commands.map((command) => command.type), [
    "create_quick_item",
    "delete_quick_item",
  ]);
  assert.equal(commands[0].payload.description, "Reply to review");
});

test("Today membership actions map to the shared commands", async () => {
  const commands = [];
  const client = {
    async execute(command) {
      commands.push(command);
      return { type: "mutation", payload: { revision: 2, replayed: false } };
    },
  };
  const ids = ["add-operation", "remove-operation", "reorder-operation"];
  const createId = () => ids.shift();

  await addTodayMembership(client, "project-1", 3, createId);
  await removeTodayMembership(client, "project-1", 4, createId);
  await reorderTodayMembership(client, "task-1", 0, 7, createId);

  assert.deepEqual(commands, [
    {
      type: "add_today",
      payload: {
        node_id: "project-1",
        position: 3,
        event_id: "add-operation",
        context: {
          idempotency_key: "add-operation",
          actor_type: "user",
          actor_ref: null,
          channel: "ui",
        },
      },
    },
    {
      type: "remove_today",
      payload: {
        node_id: "project-1",
        expected_revision: 4,
        event_id: "remove-operation",
        context: {
          idempotency_key: "remove-operation",
          actor_type: "user",
          actor_ref: null,
          channel: "ui",
        },
      },
    },
    {
      type: "reorder_today",
      payload: {
        node_id: "task-1",
        target_position: 0,
        expected_revision: 7,
        event_id: "reorder-operation",
        context: {
          idempotency_key: "reorder-operation",
          actor_type: "user",
          actor_ref: null,
          channel: "ui",
        },
      },
    },
  ]);
});

test("drag projection moves only the selected Today item", () => {
  const items = [
    { node_id: "project-1", position: 0 },
    { node_id: "task-1", position: 1 },
    { node_id: "task-2", position: 2 },
  ];

  const moved = moveTodayItem(items, "task-2", 0);
  assert.deepEqual(moved.map((item) => item.node_id), [
    "task-2",
    "project-1",
    "task-1",
  ]);
  assert.deepEqual(moved.map((item) => item.position), [0, 1, 2]);
  assert.deepEqual(items.map((item) => item.node_id), [
    "project-1",
    "task-1",
    "task-2",
  ]);
});

test("Today uses WKWebView-safe pointer drag events instead of native HTML drag", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /onPointerDown=/);
  assert.match(source, /onPointerEnter=/);
  assert.match(source, /onPointerUp=/);
  assert.doesNotMatch(source, /draggable=|onDragStart=|onDragOver=|onDrop=|onDragEnd=/);
});

test("Today uses leaf checkboxes, editable status and priority, and no Save form", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const control = await readFile(
    new URL("../src/components/WorkItemQuickControls.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /isTodayItemExpandable\(item\)/);
  assert.match(app, /className="today-chevron"/);
  assert.match(app, /<WorkItemQuickControls/);
  assert.match(app, /checkbox/);
  assert.match(app, /<WorkItemQuickControls/);
  assert.match(app, /<TodayRecentSteps/);
  assert.doesNotMatch(app, /InlineWorkItemFields|blocker-field|Current fields/);
  assert.match(control, /type="checkbox"/);
  assert.match(control, /Priority/);
  assert.doesNotMatch(control, />Save<|type="submit"|Blocker/);
});

test("Today adds Steps from Project, Task, and direct Child Task context menus", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const modal = await readFile(
    new URL("../src/components/AddStepModal.tsx", import.meta.url),
    "utf8",
  );

  assert.match(app, /onContextMenu=\{\(event\) => openStepMenu/);
  assert.match(app, /child\.id[\s\S]*?onContextMenu=\{\(event\) => openStepMenu/);
  assert.match(app, /<AddStepModal/);
  assert.match(modal, /name="step-summary"/);
  assert.match(modal, /name="step-status"/);
});

test("Today reveals Delete by swiping left from the right edge", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(app, /className="swipe-edge"/);
  assert.match(app, /setPointerCapture/);
  assert.match(app, /onPointerMove=/);
  assert.match(app, />\s*Delete\s*</);
  assert.match(app, /tabIndex=\{deleteRevealed \? 0 : -1\}/);
  assert.doesNotMatch(app, /className="remove-today"|aria-hidden="true">×/);
  assert.match(styles, /\.today-row-header\.delete-revealed/);
  assert.match(styles, /transform:\s*translateX\(-4\.75rem\)/);
});

test("Today uses compact breadcrumb names, Task descriptions, and a fixed sidebar", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const config = JSON.parse(
    await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(app, /Your working set|Projects and tasks you chose|Today order saved\./);
  assert.match(app, /item\.kind === "task" && item\.summary/);
  assert.match(app, /className="today-description"/);
  assert.match(app, /\{todayPath\(item\)\} › \{child\.title\}/);
  assert.match(styles, /\.workspace\s*\{[\s\S]*?padding:\s*1\.75rem/);
  assert.match(styles, /body\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.app-frame\s*\{[\s\S]*?height:\s*100%[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.sidebar\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(styles, /\.workspace\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /#today h1,[\s\S]*?#backlog h1\s*\{[\s\S]*?font-size:\s*3\.25rem/);
  assert.match(app, /New Quick item/);
  assert.match(app, /item\.is_quick_item/);
  assert.match(app, /checkbox minimal/);
  assert.match(app, /quick-item-delete/);
  assert.match(styles, /\.today-row-header\s*\{[\s\S]*?min-height:\s*4rem/);
  assert.match(styles, /\.today-row-header > \.quick-controls > input\[type="checkbox"\][\s\S]*?grid-row:\s*1/);
  assert.match(styles, /\.today-row-copy\s*\{[\s\S]*?grid-row:\s*1/);
  assert.match(styles, /\.today-row-header > \.quick-controls > \.quick-select\.status[\s\S]*?grid-row:\s*1/);
  assert.match(styles, /\.quick-status,\s*\n\.quick-priority\s*\{[\s\S]*?height:\s*1\.75rem/);
  assert.match(styles, /\.today-row-header > \.quick-controls > \.quick-select\.priority[\s\S]*?margin-left:\s*0\.4rem/);
  assert.equal(config.app.windows[0].width, 1280);
  assert.equal(config.app.windows[0].height, 860);
});

test("Today restores the Spike sidebar palette and conditionally opens Zed by node ID", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const zed = await readFile(
    new URL("../src/components/TodayOpenInZed.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.sidebar\s*\{[\s\S]*?background:\s*#f2eee8/);
  assert.match(styles, /\.nav-item\.active\s*\{[\s\S]*?color:\s*#cf5b45[\s\S]*?background:\s*#f8e6e0/);
  assert.match(styles, /\.brand-mark\s*\{[\s\S]*?background:\s*#cf5b45/);
  assert.match(app, /item\.has_available_workspace &&/);
  assert.match(app, /<TodayOpenInZed nodeId=\{item\.node_id\}/);
  assert.match(zed, /karazhanClient\.openInZed\(nodeId\)/);
  assert.doesNotMatch(zed, /locator|workspacePath|shell/);
});
