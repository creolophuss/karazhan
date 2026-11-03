import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");

test("primary instructions delegate MCP work without making subagents new Custodians", async () => {
  for (const name of ["AGENTS.md", "blueprints/medivh/AGENTS.md", "blueprints/skills/workspace-provisioning/assets/custodian-AGENTS.md"]) {
    const text = await read(name);
    assert.match(text, /primary Agent delegates authorized MCP registration and synchronization/);
    assert.match(text, /Continue independent work without immediately waiting/);
    assert.match(text, /wait only when the next action depends on the verified result/);
    assert.match(text, /executor performs the workflow directly and must not delegate it again/);
    assert.match(text, /does not start another Custodian or create a Child Workspace/);
    assert.match(text, /retain synchronization as pending instead of performing a blocking MCP write/);
  }
});

test("both role-specific Skills keep one executor, log ownership, verification and recovery", async () => {
  for (const skill of ["karazhan-mcp-collaboration", "medivh-karazhan-registration"]) {
    const text = await read(`blueprints/skills/${skill}/SKILL.md`);
    assert.match(text, /Save the local result/);
    assert.match(text, /collaboration\.spawn_agent/);
    assert.match(text, /one active MCP executor per Work/);
    assert.match(text, /writes serially/);
    assert.match(text, /Do not immediately wait for ordinary synchronization/);
    assert.match(text, /Do not delegate it again/);
    assert.match(text, /fresh revisions, durable request recording, writes, independent verification/);
    assert.match(text, /Do not edit business files, requirements or handoff indexes/);
    assert.match(text, /verified success, failure, conflict or verification pending/);
    assert.match(text, /identical-replay and conflict rules; do not add retry loops/);
    assert.match(text, /retain pending intent for recovery/);
    const workflow = await read(`blueprints/skills/${skill}/references/mcp-workflows.md`);
    assert.match(workflow, /delegated executor performs the sequences below directly/);
    assert.match(workflow, /primary Agent retains business-file and handoff-index ownership/);
  }
});

test("delegation preserves Custodian and Medivh role limits and wire provenance", async () => {
  const custodian = await read("blueprints/skills/karazhan-mcp-collaboration/SKILL.md");
  const medivh = await read("blueprints/skills/medivh-karazhan-registration/SKILL.md");
  assert.match(custodian, /actor_type: task_agent/);
  assert.match(custodian, /Medivh must not use it/);
  assert.match(custodian, /Match the event ID, node, kind, summary\/details, step status, and provenance/);
  assert.match(medivh, /actor_type: medivh/);
  assert.match(medivh, /must not create Child Projects or Tasks; update fields, status, priority, blocker, Today, or progress/);
  assert.match(medivh, /Query after every write/);
  assert.match(medivh, /Backlog ID; a Workspace and Work ID are not required/);
  assert.match(medivh, /do not create a Workspace just for this record/);
  assert.match(medivh, /one active MCP executor per Work or Backlog ID/);
  const workflow = await read("blueprints/skills/medivh-karazhan-registration/references/mcp-workflows.md");
  assert.match(workflow, /primary Medivh updates the latest-handoff locator/);
});
