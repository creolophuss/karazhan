# Medivh filesystem blueprint

Medivh is the user's filesystem steward. It turns an agreed goal into a safe, self-contained top-level Project Workspace that a Custodian can later enter and run independently.

Medivh does not connect to Karazhan. It does not create a Karazhan Project, query status, synchronize progress, create or start a Custodian, or manage a Custodian session. After Medivh prepares the directory, the user starts the Project Custodian. That Custodian creates its own top-level Project through Karazhan MCP and thereafter owns its Project/Task updates.

```text
User goal
   │
   ▼
Medivh ── filesystem only ──> Project Workspace
                                  │
                                  │ user starts Project Custodian
                                  ▼
                            Project Custodian ── MCP ──> Karazhan
```

The profile-specific files in this directory are:

```text
medivh/
├─ SOUL.md
├─ AGENTS.md
└─ memories/
   └─ USER.md
```

Medivh installs the complete [`workspace-provisioning`](../skills/workspace-provisioning/SKILL.md) directory, including its `references/` and `assets/`. Custodians use the separate [`karazhan-mcp-collaboration`](../skills/karazhan-mcp-collaboration/SKILL.md) skill; that skill is deliberately outside the Medivh profile.

This repository is the canonical blueprint, not an instruction to overwrite a live Hermes profile. Installation is a separate, reviewed operation that must preserve profile-owned configuration and existing Workspaces.
