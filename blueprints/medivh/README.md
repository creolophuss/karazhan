# Medivh filesystem blueprint

Medivh is the user's top-level Workspace steward. It turns an agreed goal into a safe, self-contained top-level Project Workspace that a Custodian can later enter and run independently.

After Medivh makes the Workspace durable and validates it, Medivh uses Karazhan MCP to create or verify the matching top-level Project and its primary Workspace binding. At the user's explicit request, it can also capture a new Backlog item under Root or a verified Project/Task Parent. It does not create Child work, query or update ongoing status, synchronize progress, manage existing Backlog lifecycle, create or start a Custodian, or manage a Custodian session. After this narrow handoff, the user starts the Project Custodian, which owns all ongoing Project/Task updates.

```text
User goal
   │
   ▼
Medivh ── filesystem ──> Project Workspace
   │                          │
   └── MCP: top-level Project/binding + requested Backlog capture
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

Medivh installs the complete [`workspace-provisioning`](../skills/workspace-provisioning/SKILL.md) directory, the narrow [`medivh-karazhan-registration`](../skills/medivh-karazhan-registration/SKILL.md) Skill, and the complete [`answer-me-with-html`](../skills/answer-me-with-html/SKILL.md) presentation Skill. The local installer also places a versioned Custodian startup package at `$HERMES_HOME/packages/custodian-startup-kit`; this non-Skill package contains all three complete Custodian Skills for copying into a new Workspace's `.agents/skills/`. Custodians use the separate [`karazhan-mcp-collaboration`](../skills/karazhan-mcp-collaboration/SKILL.md) Skill from their Workspace. That broader Skill remains outside Medivh's discoverable `skills/`.

This repository is the canonical blueprint, not an instruction to overwrite an entire live Hermes profile. The installer versions only its named targets. A live `memories/USER.md`, every other memory, `sessions/`, and unrelated Skills are user-owned and must never be replaced or deleted by installation; the checked-in `USER.md` is a reference for the expected role context, not an installer source. Existing Workspaces are likewise outside installation scope.
