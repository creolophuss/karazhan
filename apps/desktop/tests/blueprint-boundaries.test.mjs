import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const blueprintUrl = new URL("../../../blueprints/", import.meta.url);
const clientUrl = new URL("../src/lib/karazhan-client.ts", import.meta.url);

test("Medivh is top-level and Custodians own Project and Task work", async () => {
  const required = [
    "medivh/README.md",
    "medivh/SOUL.md",
    "medivh/AGENTS.md",
    "medivh/memories/USER.md",
    "skills/workspace-provisioning/SKILL.md",
    "skills/workspace-provisioning/agents/openai.yaml",
    "skills/workspace-provisioning/references/context-and-coordination.md",
    "skills/workspace-provisioning/references/workspace-contract.md",
    "skills/workspace-provisioning/assets/custodian-AGENTS.md",
    "skills/workspace-provisioning/assets/context-index.md",
    "skills/workspace-provisioning/assets/coordination-overview.md",
    "skills/workspace-provisioning/assets/coordination-decisions.md",
    "skills/workspace-provisioning/assets/task.yaml",
    "skills/karazhan-mcp-collaboration/SKILL.md",
    "skills/karazhan-mcp-collaboration/agents/openai.yaml",
    "skills/karazhan-mcp-collaboration/references/mcp-workflows.md",
  ];

  await Promise.all(required.map((file) => access(new URL(file, blueprintUrl))));

  const [
    medivhReadme,
    medivhSoul,
    medivhAgents,
    workspaceSkill,
    workspaceContract,
    contextContract,
    mcpSkill,
    mcpWorkflows,
    custodianInstructions,
    manifest,
    client,
  ] = await Promise.all([
    readFile(new URL("medivh/README.md", blueprintUrl), "utf8"),
    readFile(new URL("medivh/SOUL.md", blueprintUrl), "utf8"),
    readFile(new URL("medivh/AGENTS.md", blueprintUrl), "utf8"),
    readFile(new URL("skills/workspace-provisioning/SKILL.md", blueprintUrl), "utf8"),
    readFile(
      new URL(
        "skills/workspace-provisioning/references/workspace-contract.md",
        blueprintUrl,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "skills/workspace-provisioning/references/context-and-coordination.md",
        blueprintUrl,
      ),
      "utf8",
    ),
    readFile(
      new URL("skills/karazhan-mcp-collaboration/SKILL.md", blueprintUrl),
      "utf8",
    ),
    readFile(
      new URL(
        "skills/karazhan-mcp-collaboration/references/mcp-workflows.md",
        blueprintUrl,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "skills/workspace-provisioning/assets/custodian-AGENTS.md",
        blueprintUrl,
      ),
      "utf8",
    ),
    readFile(
      new URL("skills/workspace-provisioning/assets/task.yaml", blueprintUrl),
      "utf8",
    ),
    readFile(clientUrl, "utf8"),
  ]);

  for (const document of [medivhReadme, medivhSoul, medivhAgents]) {
    assert.match(
      document,
      /does not connect to Karazhan|do not connect to Karazhan|never connects to Karazhan|no Karazhan/i,
    );
  }
  assert.match(medivhReadme, /top-level Project Workspace/);
  assert.match(medivhReadme, /Custodian/);
  assert.match(workspaceSkill, /filesystem-only skill/);
  assert.match(workspaceSkill, /never calls MCP/);
  for (const document of [workspaceSkill, workspaceContract, contextContract]) {
    assert.doesNotMatch(document, /\]\(\.\.\/\.\.\//);
  }
  assert.match(mcpSkill, /Medivh must not use it/);
  assert.match(mcpSkill, /Custodian/);
  assert.match(mcpSkill, /actor_type: task_agent/);
  assert.match(mcpWorkflows, /"type": "add_resource_binding"/);
  assert.match(mcpWorkflows, /"type": "update_resource_availability"/);
  assert.match(mcpWorkflows, /do not read, scan, upload, or copy|without asking Karazhan to read/i);
  assert.match(custodianInstructions, /user controls Custodian startup/);
  for (const document of [
    medivhReadme,
    medivhSoul,
    medivhAgents,
    workspaceSkill,
    workspaceContract,
    contextContract,
    mcpSkill,
    mcpWorkflows,
    custodianInstructions,
  ]) {
    assert.doesNotMatch(document, /\b(?:Project|Task) Agent\b|\b(?:Parent|Child) Agent\b/);
  }
  assert.match(manifest, /kind: ""/);
  assert.doesNotMatch(manifest, /agent_runs|karazhan:/);
  assert.match(client, /\| "task_agent"/);
  assert.doesNotMatch(client, /"medivh"|"work_assistant"/);
});
