---
name: medivh-karazhan-registration
description: Register or verify a Medivh-provisioned top-level Project Workspace and capture user-requested Backlog items through Karazhan MCP. Use for the initial top-level Project handoff or explicit Backlog capture, not Child work or ongoing project management.
---

# Medivh Karazhan Registration

## Boundary

Use this Skill for the top-level Project Workspace Medivh has just created or repaired, or when the user makes an explicit request to add a Backlog item. A Workspace remains usable when Karazhan is unavailable, and a Backlog item does not require a speculative Workspace.

Medivh may:

- query the Work Tree to choose a valid Root position;
- create or query that top-level Project using the existing local `work.id`;
- register or query one primary Workspace ResourceBinding for that Project;
- create or query a new Backlog item under Root or a user-selected Project/Task Parent;
- append the verified MCP result to the Workspace's `agent_log.md` and update its handoff locator.

Medivh must not create Child Projects or Tasks; update fields, status, priority, blocker, Today, or progress; edit, move, discard, or promote existing Backlog items; manage ResourceBinding availability after handoff; or start, assign, monitor, resume, or close a Custodian session. Those operations belong to the owning Custodian or user.

## Registration

Before a Project or binding write, finish and validate filesystem provisioning with `workspace-provisioning`. Before a Backlog write, require a clear title; use Root, `idea`, `none`, and no tags when the user does not specify Parent, kind, priority, or tags. Verify any explicitly named non-Root Parent instead of guessing. Read [references/mcp-workflows.md](references/mcp-workflows.md), establish every UUID and idempotency identity before calling MCP, then use the minimum command. Medivh writes use `actor_type: medivh` and `channel: mcp` with the actor ref defined by the selected workflow.

Query after every write. If a local identity already maps to a different Karazhan object, a key conflicts, or an existing binding disagrees, preserve both observations and stop for the user. For a confirmed top-level Project position rejection, follow only the bounded correction in the workflow reference; other position conflicts stop. Never change durable local identity merely to match Karazhan.

If MCP is unavailable during Workspace registration, record registration as pending and report the Workspace path. If an explicit Backlog capture fails, report that it was not verified and retain the generated identity in the current durable interaction record when available. Retry later only with exactly the same ID and idempotency key.
