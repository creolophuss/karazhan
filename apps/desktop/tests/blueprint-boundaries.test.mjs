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
    "skills/workspace-provisioning/assets/requirements.md",
    "skills/workspace-provisioning/assets/task.yaml",
    "skills/karazhan-mcp-collaboration/SKILL.md",
    "skills/karazhan-mcp-collaboration/agents/openai.yaml",
    "skills/karazhan-mcp-collaboration/references/mcp-workflows.md",
    "skills/medivh-karazhan-registration/SKILL.md",
    "skills/medivh-karazhan-registration/agents/openai.yaml",
    "skills/medivh-karazhan-registration/references/mcp-workflows.md",
    "skills/answer-me-with-html/SKILL.md",
    "skills/answer-me-with-html/scripts/am.mjs",
    "skills/answer-me-with-html/references/settings.md",
    "skills/answer-me-with-html/references/video.md",
    "skills/answer-me-with-html/licenses/OFL-Bangers.txt",
    "skills/answer-me-with-html/LICENSE",
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
    medivhMcpSkill,
    medivhMcpWorkflows,
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
      new URL("skills/medivh-karazhan-registration/SKILL.md", blueprintUrl),
      "utf8",
    ),
    readFile(
      new URL(
        "skills/medivh-karazhan-registration/references/mcp-workflows.md",
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
    assert.match(document, /Karazhan MCP/i);
    assert.match(document, /top-level Project/i);
    assert.match(document, /ResourceBinding|Workspace binding/i);
  }
  assert.match(medivhReadme, /top-level Project Workspace/);
  assert.match(medivhReadme, /Custodian/);
  assert.match(workspaceSkill, /filesystem-only skill/);
  assert.match(workspaceSkill, /never calls MCP/);
  assert.match(workspaceSkill, /\.agents\/skills/);
  assert.match(workspaceSkill, /custodian-startup-kit/);
  assert.match(workspaceSkill, /<parent-workspace>\/children\/<child>/);
  for (const document of [workspaceSkill, workspaceContract, contextContract]) {
    assert.doesNotMatch(document, /\]\(\.\.\/\.\.\//);
  }
  assert.match(mcpSkill, /Medivh must not use it/);
  assert.match(mcpSkill, /Custodian/);
  assert.match(mcpSkill, /actor_type: task_agent/);
  assert.match(medivhMcpSkill, /top-level Project Workspace/);
  assert.match(medivhMcpSkill, /user.*explicit request/i);
  assert.match(medivhMcpSkill, /Backlog/);
  assert.match(medivhMcpSkill, /actor_type: medivh/);
  assert.match(medivhMcpSkill, /must not|do not/i);
  assert.match(
    medivhMcpSkill,
    /Child|Backlog|Today|progress|status|Custodian session/i,
  );
  assert.match(medivhMcpWorkflows, /"type": "create_project"/);
  assert.match(medivhMcpWorkflows, /"type": "create_backlog"/);
  assert.match(medivhMcpWorkflows, /"type": "add_resource_binding"/);
  assert.match(medivhMcpWorkflows, /"actor_type": "medivh"/);
  assert.doesNotMatch(
    medivhMcpWorkflows,
    /"type": "(?:update_backlog|move_backlog|discard_backlog|promote_backlog)"/,
  );
  assert.match(mcpWorkflows, /"type": "add_resource_binding"/);
  assert.match(mcpWorkflows, /"type": "update_resource_availability"/);
  assert.match(mcpWorkflows, /"details": "<optional-verbose-action-details>"/);
  assert.match(mcpWorkflows, /---/);
  assert.match(mcpWorkflows, /do not read, scan, upload, or copy|without asking Karazhan to read/i);
  for (const document of [
    medivhReadme,
    medivhSoul,
    medivhAgents,
    workspaceSkill,
    workspaceContract,
    contextContract,
    mcpSkill,
    mcpWorkflows,
    medivhMcpSkill,
    medivhMcpWorkflows,
    custodianInstructions,
  ]) {
    assert.doesNotMatch(document, /\b(?:Project|Task) Agent\b|\b(?:Parent|Child) Agent\b/);
  }
  assert.match(manifest, /kind: ""/);
  assert.doesNotMatch(manifest, /agent_runs|karazhan:/);
  assert.match(client, /\| "task_agent"/);
  assert.match(client, /\| "medivh"/);
  assert.doesNotMatch(client, /"work_assistant"/);
});
