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
├─ SOUL.md                  # installer-managed
├─ AGENTS.md                # installer-managed
└─ memories/
   └─ USER.md               # reference only; live file is user-owned
```

Medivh installs the complete [`workspace-provisioning`](../skills/workspace-provisioning/SKILL.md) directory, including its `references/` and `assets/`. The local installer also places a versioned Custodian startup package at `$HERMES_HOME/packages/custodian-startup-kit`; this non-Skill package contains both complete Skills for copying into a new Workspace's `.agents/skills/`. Custodians use the separate [`karazhan-mcp-collaboration`](../skills/karazhan-mcp-collaboration/SKILL.md) skill from their Workspace. That Skill remains outside Medivh's discoverable `skills/`, so Medivh never invokes it for itself.

This repository is the canonical blueprint, not an instruction to overwrite an entire live Hermes profile. The installer versions only its named targets. A live `memories/USER.md`, every other memory, `sessions/`, and unrelated Skills are user-owned and must never be replaced or deleted by installation; the checked-in `USER.md` is a reference for the expected role context, not an installer source. Existing Workspaces are likewise outside installation scope.
