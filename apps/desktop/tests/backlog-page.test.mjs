import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createBacklog,
  discardBacklog,
  loadBacklog,
  moveBacklog,
  promoteBacklog,
  reorderBacklog,
  updateBacklog,
} from "../src/features/backlog.ts";

test("Backlog feature uses the shared query and command contract", async () => {
  const queries = [];
  const commands = [];
  const client = {
    async query(query) {
      queries.push(query);
      return { type: "backlog", payload: [{ id: "idea-1" }] };
    },
    async execute(command) {
      commands.push(command);
      return command.type === "promote_backlog"
        ? { type: "promotion", payload: { target_node_id: "task-1", source_revision: 3, replayed: false } }
        : { type: "mutation", payload: { revision: 2, replayed: false } };
    },
  };

  assert.deepEqual(await loadBacklog(client, { parent_id: "project-1", tag: "rust" }), [{ id: "idea-1" }]);
  await createBacklog(client, {
    parentId: "project-1",
    title: "New idea",
    description: "Description",
    kind: "idea",
    priority: "none",
    tags: ["capture"],
  }, () => "new-backlog-1");
  await updateBacklog(client, "idea-1", 1, {
    title: "Edited",
    notes: "Notes",
    kind: "research",
    priority: "high",
    tags: ["rust"],
  });
  await discardBacklog(client, "idea-1", 2);
  await moveBacklog(client, "idea-1", "task-2", 2);
  await reorderBacklog(client, "idea-1", 0, 2);
  await promoteBacklog(client, "idea-1", 2, {
    type: "task",
    id: "task-1",
    parent_id: "project-1",
    key: "task-1",
    title: "Task",
    position: 2,
  }, "promotion-request-1");

  assert.deepEqual(queries, [{ type: "list_backlog", filter: { parent_id: "project-1", tag: "rust" } }]);
  assert.deepEqual(commands.map((command) => command.type), [
    "create_backlog",
    "update_backlog",
    "discard_backlog",
    "move_backlog",
    "reorder_node",
    "promote_backlog",
  ]);
  assert.equal(commands[0].payload.title, "New idea");
  assert.deepEqual(commands[1].payload.tags, ["rust"]);
  assert.equal(commands[3].payload.target_position, null);
  assert.equal(commands[5].payload.context.idempotency_key, "promotion-request-1");
});

test("Backlog page exposes filters, right-click actions, creation, and cross-Parent drag", async () => {
  const source = await readFile(
    new URL("../src/components/BacklogPage.tsx", import.meta.url),
    "utf8",
  );
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  for (const field of ["parent", "kind", "priority", "tag"]) {
    assert.match(source, new RegExp(`name=["']${field}["']`));
  }
  assert.doesNotMatch(source, /name=["']status["']/);
  assert.match(source, />Edit</);
  assert.match(source, />Save</);
  assert.match(source, />Cancel</);
  assert.match(source, />Discard</);
  assert.match(source, />Move</);
  assert.match(source, />Promote</);
  assert.match(source, /New Backlog/);
  assert.match(source, /projects-add/);
  assert.match(source, /onContextMenu=/);
  assert.match(source, /action-menu context-menu/);
  assert.match(source, /parent_breadcrumb/);
  assert.match(source, /item\.notes && <small className="backlog-description">\{item\.notes\}<\/small>/);
  assert.doesNotMatch(source, /<small>\{breadcrumb\(item\)\}<\/small>/);
  assert.match(source, /drag-handle/);
  assert.match(source, /const targetPosition = item\.position \+ \(sourceIndex >= 0 && sourceIndex < targetIndex \? 1 : 0\)/);
  assert.match(source, /moveBacklog\(karazhanClient, dragged\.id, item\.parent_id, dragged\.revision, targetPosition\)/);
  assert.match(source, /onPointerDown=/);
  assert.match(source, /onPointerEnter=/);
  assert.match(source, /onPointerUp=/);
  assert.match(source, /if \(item\.id === dragged\.id\) \{\s*setDragged\(null\);\s*setDropTargetId\(null\);\s*return;/);
  assert.match(source, /window\.addEventListener\("pointerup", clearDrag\)/);
  assert.match(source, /window\.addEventListener\("pointercancel", clearDrag\)/);
  assert.doesNotMatch(source, /draggable=|onDragStart=|onDragOver=|onDrop=|onDragEnd=/);
  assert.doesNotMatch(source, /const statuses|BacklogStatus/);
  assert.doesNotMatch(source, /\{item\.backlog_status\}/);
  assert.doesNotMatch(source, />Notes</);
  assert.match(source, />Description</);
  assert.ok(source.indexOf(">Tags<") < source.indexOf(">Description<"));
  assert.match(app, /<BacklogPage/);
  assert.match(app, /Backlog\s*<\/button>/);
  assert.doesNotMatch(source, /className="tree-action"[^>]*>Edit|className="tree-action"[^>]*>Move|className="tree-action"[^>]*>Promote/);
  assert.match(styles, /\.backlog-editor \.inline-actions\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  assert.match(styles, /\.action-menu button\s*\{[\s\S]*?border:\s*0/);
  assert.match(styles, /\.backlog-editor \.inline-actions button[\s\S]*?font-size:\s*0\.7rem/);
  assert.match(styles, /\.backlog-meta\s*\{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.backlog-row-main\s*\{[\s\S]*?grid-template-columns:\s*auto minmax\(12rem, 1fr\) 5rem 4rem 7rem/);
  assert.match(styles, /\.backlog-filters select\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.backlog-filters input\s*\{[\s\S]*?border:\s*1px solid #d9d1c5/);
  assert.match(styles, /#today h1,[\s\S]*?#backlog h1\s*\{[\s\S]*?font-size:\s*3\.25rem/);
  assert.match(styles, /\.tree-path,\s*\n\.today-path,\s*\n\.backlog-copy strong\s*\{[\s\S]*?color:\s*#6f685e;[\s\S]*?font-size:\s*0\.9rem;[\s\S]*?font-weight:\s*520/);
});
