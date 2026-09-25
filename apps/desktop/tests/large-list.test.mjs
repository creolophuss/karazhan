import assert from "node:assert/strict";
import test from "node:test";

import {
  allExpandableNodeIds,
  buildProjectTaskTree,
} from "../src/features/projects.ts";
import {
  moveTodayItem,
  setAllTodayRowsExpanded,
} from "../src/features/today.ts";

function projectItem(index) {
  const id = `project-${index}`;
  return {
    id,
    parent_id: "root",
    kind: "project",
    key: id,
    title: `Project ${index + 1}`,
    status: "ready",
    priority: "none",
    blocker: null,
    position: index,
    revision: 1,
  };
}

function taskItem(index) {
  const id = `task-${index}`;
  return {
    id,
    parent_id: `project-${Math.floor(index / 9)}`,
    kind: "task",
    key: id,
    title: `Task ${index + 1}`,
    status: "ready",
    priority: "none",
    blocker: null,
    position: index % 9,
    revision: 1,
  };
}

function flattenTree(nodes) {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

test("100 Projects/Tasks rows remain complete through expand and collapse", () => {
  const items = [
    ...Array.from({ length: 10 }, (_, index) => projectItem(index)),
    ...Array.from({ length: 90 }, (_, index) => taskItem(index)),
  ];
  const tree = buildProjectTaskTree(items);
  const expanded = allExpandableNodeIds(tree);

  assert.equal(tree.length, 10);
  assert.equal(flattenTree(tree).length, 100);
  assert.deepEqual(tree.map((node) => node.children.length), Array(10).fill(9));
  assert.equal(expanded.size, 10);
  const collapsed = new Set();
  assert.equal(collapsed.size, 0, "Collapse all leaves no expanded branches");
  assert.deepEqual(allExpandableNodeIds(tree), expanded, "Expand all restores every branch");
});

test("100 Today rows preserve identity and positions through both drag directions", () => {
  const original = Array.from({ length: 100 }, (_, position) => ({
    node_id: `node-${position}`,
    position,
  }));

  assert.equal(setAllTodayRowsExpanded(original, true).size, 100);
  assert.equal(setAllTodayRowsExpanded(original, false).size, 0);

  const movedDown = moveTodayItem(original, "node-0", 99);
  assert.equal(movedDown[99].node_id, "node-0");
  assert.deepEqual(movedDown.map((item) => item.position), [...original.keys()]);
  assert.equal(new Set(movedDown.map((item) => item.node_id)).size, 100);

  const movedBackUp = moveTodayItem(movedDown, "node-0", 0);
  assert.deepEqual(movedBackUp, original);
  assert.deepEqual(original.map((item) => item.node_id), [
    ...Array.from({ length: 100 }, (_, index) => `node-${index}`),
  ]);
});
