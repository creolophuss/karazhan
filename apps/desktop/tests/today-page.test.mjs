import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  checkboxStatus,
  describeClientError,
  directChildTaskRows,
  isBusinessStep,
  isTodayItemExpandable,
  loadRecentSteps,
  loadAllSteps,
  loadToday,
  todayPath,
} from "../src/features/today.ts";

test("Today reads the persisted membership order with one shared query", async () => {
  const calls = [];
  const items = [
    {
      node_id: "project-1",
      kind: "project",
      title: "Karazhan",
      position: 4,
      revision: 3,
      direct_child_tasks: [],
    },
    {
      node_id: "task-1",
      kind: "task",
      title: "Ship the desktop shell",
      position: 9,
      revision: 2,
      direct_child_tasks: [],
    },
  ];
  const client = {
    async query(query) {
      calls.push(query);
      return { type: "today", payload: items };
    },
  };

  assert.deepEqual(await loadToday(client), items);
  assert.deepEqual(calls, [{ type: "list_today" }]);
});

test("Today rejects an unexpected shared-contract response", async () => {
  const client = {
    async query() {
      return { type: "projects", payload: [] };
    },
  };

  await assert.rejects(loadToday(client), /expected today query result/);
});

test("Today presents structured failures without discarding their code", () => {
  assert.equal(
    describeClientError({ code: "adapter_unavailable", message: "try again" }),
    "adapter_unavailable: try again",
  );
  assert.equal(describeClientError(new Error("offline")), "offline");
  assert.equal(describeClientError("unknown"), "Unable to load Today.");
});

test("expanded rows present only the ordered Child Tasks supplied by shared core", () => {
  const parent = {
    node_id: "project-1",
    kind: "project",
    title: "Karazhan",
    position: 0,
    revision: 1,
    direct_child_tasks: [
      {
        id: "task-visible",
        parent_id: "project-1",
        key: "visible",
        title: "Visible direct task",
        summary: null,
        goal: null,
        acceptance: null,
        status: "in_progress",
        priority: "high",
        blocker: "Waiting for review",
        revision: 2,
        has_steps: true,
      },
    ],
  };

  assert.deepEqual(directChildTaskRows(parent), [
    {
      id: "task-visible",
      title: "Visible direct task",
      summary: null,
      revision: 2,
      status: "in_progress",
      priority: "high",
      blocker: "Waiting for review",
      has_steps: true,
    },
  ]);
});

test("Today displays the shared Work Tree path and expands only containers", () => {
  const project = {
    node_id: "project-1",
    kind: "project",
    path_titles: ["Karazhan"],
    direct_child_tasks: [],
    has_steps: false,
    is_quick_item: false,
  };
  const parentTask = {
    node_id: "task-1",
    kind: "task",
    path_titles: ["Karazhan", "Desktop", "Polish Today"],
    direct_child_tasks: [{ id: "child-1" }],
    has_steps: false,
    is_quick_item: false,
  };
  const leafTask = {
    node_id: "task-2",
    kind: "task",
    path_titles: ["Karazhan", "Ship build"],
    direct_child_tasks: [],
    has_steps: false,
    is_quick_item: false,
  };
  const quickItem = {
    node_id: "quick-1",
    kind: "task",
    path_titles: ["Call supplier"],
    direct_child_tasks: [],
    has_steps: true,
    is_quick_item: true,
  };

  assert.equal(todayPath(parentTask), "Karazhan › Desktop › Polish Today");
  assert.equal(isTodayItemExpandable(project), true);
  assert.equal(isTodayItemExpandable(parentTask), true);
  assert.equal(isTodayItemExpandable(leafTask), false);
  assert.equal(isTodayItemExpandable(quickItem), false);
});

test("leaf Task checkbox maps directly to done and ready", () => {
  assert.equal(checkboxStatus(true), "done");
  assert.equal(checkboxStatus(false), "ready");
});

test("Recent steps uses the shared recent-progress query", async () => {
  const calls = [];
  const payload = [{ id: "event-1", event_type: "progress", summary: "Resolved the blocker" }];
  const client = {
    async query(query) {
      calls.push(query);
      return { type: "progress_events", payload };
    },
  };

  assert.deepEqual(await loadRecentSteps(client, "project-1"), payload);
  assert.deepEqual(calls, [
    { type: "recent_progress", node_id: "project-1", limit: 3 },
  ]);
});

test("all Steps uses the shared progress timeline query", async () => {
  const calls = [];
  const payload = [
    { id: "audit-1", event_type: "today_reordered", summary: "Today order changed" },
    { id: "audit-2", event_type: "progress", summary: "work item fields updated" },
    { id: "event-1", event_type: "progress", summary: "First step" },
  ];
  const client = {
    async query(query) {
      calls.push(query);
      return { type: "progress_events", payload };
    },
  };

  assert.deepEqual(await loadAllSteps(client, "task-1"), [payload[2]]);
  assert.deepEqual(calls, [{ type: "progress_timeline", node_id: "task-1" }]);
});

test("Today Steps exclude structural and generic field audit events", () => {
  assert.equal(isBusinessStep({ event_type: "today_added", summary: "added to Today" }), false);
  assert.equal(isBusinessStep({ event_type: "today_reordered", summary: "Today order changed" }), false);
  assert.equal(isBusinessStep({ event_type: "progress", summary: "work item fields updated" }), false);
  assert.equal(isBusinessStep({ event_type: "progress", summary: "Implemented filters" }), true);
  assert.equal(isBusinessStep({ event_type: "delivery", summary: "Ready for review" }), true);
});

test("Recent steps colors status labels and pending step text", async () => {
  const source = await readFile(
    new URL("../src/components/TodayRecentSteps.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /event\.step_status/);
  assert.match(source, /step-status/);
  assert.match(source, /pending-step/);
  assert.match(source, /Show all steps/);
  assert.match(source, /Show recent/);
  for (const status of ["planned", "ready", "in-progress", "pending", "review", "done", "cancelled"]) {
    assert.match(styles, new RegExp(`\\.step-status\\.${status}`));
  }
  assert.match(styles, /\.pending-step\s*\{[\s\S]*?color:/);
});
