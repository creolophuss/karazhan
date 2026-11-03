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
- append the verified MCP result to the Workspace's `agent_log.md`; the primary Medivh maintains its handoff locator.

Medivh must not create Child Projects or Tasks; update fields, status, priority, blocker, Today, or progress; edit, move, discard, or promote existing Backlog items; manage ResourceBinding availability after handoff; or start, assign, monitor, resume, or close a Custodian session. Those operations belong to the owning Custodian or user.

## Delegate MCP operations

These instructions distinguish the primary Agent from its delegated MCP executor. A temporary executor is not a new Custodian or an independent Work owner.

For the primary Agent:

1. Save the local result and decide that registration or user-requested Backlog capture is due. For a Project, persist the intended operation in its existing Workspace log. For Backlog, retain the generated Backlog ID and exact request in the current durable interaction record before delegation; do not create a Workspace just for this record.
2. Use the runtime's subagent capability. For Project registration, supply the Workspace path and Work ID. For Backlog capture, supply the current Medivh Profile/interaction-record locator and Backlog ID; a Workspace and Work ID are not required. In both cases, supply the authorized operation and exact content, evidence locator, role/actor provenance and applicable Skill path. Explicitly identify the task as a delegated MCP executor and prohibit re-delegation. In Codex, use `collaboration.spawn_agent`; other runtimes use their available equivalent.
3. Keep one active MCP executor per Work or Backlog ID. Reuse it for later operations when possible and execute that target's writes serially. Do not launch overlapping writes to the same object or send a second copy of an outstanding request.
4. Continue independent work. Do not immediately wait for ordinary synchronization. Wait only when the next action requires the verified MCP result. Until verification arrives, report synchronization as pending, separately from completed local work.
5. If no executor has the required tools and permissions, record the pending operation and continue unaffected work. Do not silently fall back to blocking primary-Agent MCP writes. Delegation does not grant new tools or permissions.

For the delegated MCP executor:

- Execute the existing operation workflow directly. Do not delegate it again. Include prerequisite queries, fresh revisions, durable request recording, writes, independent verification and failure handling in this one assignment.
- Preserve the delegating role's ownership, allowed operations and actor/ref/channel. Do not infer field changes, acceptance or `done` from the local result.
- Append only exact requests and necessary pending/failure/verification records to the Project log or the existing Backlog interaction record supplied by the primary Medivh. Do not edit business files, requirements or handoff indexes. The primary Agent owns those files and incorporates verified results when appropriate.
- Return verified success, failure, conflict or verification pending, with the event/object ID and log locator. Follow the existing identical-replay and conflict rules; do not add retry loops. A session ending does not guarantee that an in-flight executor survives: retain pending intent for recovery.

## Registration

Before a Project or binding write, finish and validate filesystem provisioning with `workspace-provisioning`. Before a Backlog write, require a clear title; use Root, `idea`, `none`, and no tags when the user does not specify Parent, kind, priority, or tags. Verify any explicitly named non-Root Parent instead of guessing. Read [references/mcp-workflows.md](references/mcp-workflows.md), establish every UUID and idempotency identity before calling MCP, then use the minimum command. Medivh writes use `actor_type: medivh` and `channel: mcp` with the actor ref defined by the selected workflow.

Query after every write. If a local identity already maps to a different Karazhan object, a key conflicts, or an existing binding disagrees, preserve both observations and stop for the user. For a confirmed top-level Project position rejection, follow only the bounded correction in the workflow reference; other position conflicts stop. Never change durable local identity merely to match Karazhan.

If MCP is unavailable during Workspace registration, record registration as pending and report the Workspace path. If an explicit Backlog capture fails, report that it was not verified and retain the generated identity in the current durable interaction record when available. Retry later only with exactly the same ID and idempotency key.
