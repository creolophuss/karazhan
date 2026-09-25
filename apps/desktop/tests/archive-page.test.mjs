import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  archiveProjectTask,
  loadArchivedProjectTaskTree,
  permanentlyDeleteArchivedProjectTask,
} from "../src/features/projects.ts";

test("archive actions use the shared command/query contract", async () => {
  const commands = [];
  const client = {
    async execute(command) {
      commands.push(command);
      return { type: "mutation", payload: { revision: 2, replayed: false } };
    },
    async query(query) {
      assert.deepEqual(query, { type: "list_archived_project_task_tree" });
      return { type: "project_task_tree", payload: [{ id: "archived" }] };
    },
  };

  assert.deepEqual(await loadArchivedProjectTaskTree(client), [{ id: "archived" }]);
  await archiveProjectTask(client, "node-1", 4);
  await permanentlyDeleteArchivedProjectTask(client, "node-1", 5);
  assert.equal(commands[0].type, "archive_subtree");
  assert.equal(commands[0].payload.node_id, "node-1");
  assert.equal(commands[0].payload.expected_revision, 4);
  assert.equal(commands[1].type, "permanently_delete_archived_subtree");
  assert.equal(commands[1].payload.expected_revision, 5);
});

test("Archive is a dedicated navigation page with confirmed permanent deletion", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const page = await readFile(
    new URL("../src/components/ArchivePage.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(app, />\s*Archive\s*</);
  assert.match(page, /Permanently delete/);
  assert.match(page, /cannot be undone/);
  assert.match(page, /descendant/);
  assert.match(styles, /\.workspace > \.context-menu\s*\{[\s\S]*?width:\s*max-content/);
});
