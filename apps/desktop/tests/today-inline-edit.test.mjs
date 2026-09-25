import assert from "node:assert/strict";
import test from "node:test";

import { saveWorkItemFields } from "../src/features/today.ts";

test("inline save uses the WorkNode revision and reports saving then success", async () => {
  const calls = [];
  const feedback = [];
  const client = {
    async execute(command) {
      calls.push(command);
      return { type: "mutation", payload: { revision: 8, replayed: false } };
    },
  };

  const revision = await saveWorkItemFields(
    client,
    {
      nodeId: "project-1",
      expectedRevision: 7,
      status: "in_progress",
      priority: "high",
      blocker: "Waiting for review",
    },
    (state) => feedback.push(state),
    () => "operation-1",
  );

  assert.equal(revision, 8);
  assert.deepEqual(feedback, [
    { status: "saving", message: "Saving…" },
    { status: "success", message: "Saved." },
  ]);
  assert.deepEqual(calls, [
    {
      type: "update_work_item",
      payload: {
        node_id: "project-1",
        title: null,
        summary: null,
        goal: null,
        acceptance: null,
        status: "in_progress",
        priority: "high",
        blocker: { action: "set", value: "Waiting for review" },
        expected_revision: 7,
        event_id: "operation-1",
        context: {
          idempotency_key: "operation-1",
          actor_type: "user",
          actor_ref: null,
          channel: "ui",
        },
      },
    },
  ]);
});

test("an empty blocker is sent as an explicit clear", async () => {
  const calls = [];
  const client = {
    async execute(command) {
      calls.push(command);
      return { type: "mutation", payload: { revision: 2, replayed: false } };
    },
  };

  await saveWorkItemFields(
    client,
    {
      nodeId: "task-1",
      expectedRevision: 1,
      status: "ready",
      priority: "none",
      blocker: "   ",
    },
    () => {},
    () => "operation-2",
  );

  assert.deepEqual(calls[0].payload.blocker, { action: "clear" });
});

test("Projects field save includes title and clearable rich text fields", async () => {
  const calls = [];
  const client = {
    async execute(command) {
      calls.push(command);
      return { type: "mutation", payload: { revision: 5, replayed: false } };
    },
  };

  await saveWorkItemFields(
    client,
    {
      nodeId: "project-1",
      expectedRevision: 4,
      title: "  Renamed Project  ",
      summary: "Summary",
      goal: "   ",
      acceptance: "Acceptance criteria",
      status: "ready",
      priority: "medium",
      blocker: "",
    },
    () => {},
    () => "operation-details",
  );

  assert.equal(calls[0].payload.title, "Renamed Project");
  assert.deepEqual(calls[0].payload.summary, {
    action: "set",
    value: "Summary",
  });
  assert.deepEqual(calls[0].payload.goal, { action: "clear" });
  assert.deepEqual(calls[0].payload.acceptance, {
    action: "set",
    value: "Acceptance criteria",
  });
});

test("revision conflicts and general failures produce distinct feedback", async () => {
  const input = {
    nodeId: "task-1",
    expectedRevision: 1,
    status: "ready",
    priority: "medium",
    blocker: "",
  };
  const conflictFeedback = [];
  const conflict = { code: "revision_conflict", message: "stale revision" };

  await assert.rejects(
    saveWorkItemFields(
      { execute: async () => { throw conflict; } },
      input,
      (state) => conflictFeedback.push(state),
      () => "operation-3",
    ),
    (error) => error === conflict,
  );
  assert.deepEqual(conflictFeedback.at(-1), {
    status: "conflict",
    message: "revision_conflict: stale revision",
  });

  const failureFeedback = [];
  await assert.rejects(
    saveWorkItemFields(
      { execute: async () => { throw new Error("offline"); } },
      input,
      (state) => failureFeedback.push(state),
      () => "operation-4",
    ),
    /offline/,
  );
  assert.deepEqual(failureFeedback.at(-1), {
    status: "error",
    message: "offline",
  });
});
