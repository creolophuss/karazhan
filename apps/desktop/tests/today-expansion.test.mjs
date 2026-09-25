import assert from "node:assert/strict";
import test from "node:test";

import {
  allTodayNodeIds,
  setAllTodayRowsExpanded,
  toggleTodayRow,
} from "../src/features/today.ts";

const items = [
  { node_id: "project-1" },
  { node_id: "task-1" },
  { node_id: "task-2" },
];

test("Today rows are all expanded on first load", () => {
  assert.deepEqual([...allTodayNodeIds(items)], ["project-1", "task-1", "task-2"]);
});

test("one Today row toggles without changing the others", () => {
  const expanded = allTodayNodeIds(items);
  const collapsedOne = toggleTodayRow(expanded, "task-1");

  assert.deepEqual([...collapsedOne], ["project-1", "task-2"]);
  assert.deepEqual([...expanded], ["project-1", "task-1", "task-2"]);
  assert.deepEqual([...toggleTodayRow(collapsedOne, "task-1")], [
    "project-1",
    "task-2",
    "task-1",
  ]);
});

test("Expand all and Collapse all replace the complete expansion state", () => {
  assert.deepEqual([...setAllTodayRowsExpanded(items, false)], []);
  assert.deepEqual([...setAllTodayRowsExpanded(items, true)], [
    "project-1",
    "task-1",
    "task-2",
  ]);
});
