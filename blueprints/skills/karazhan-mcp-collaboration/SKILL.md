---
name: karazhan-mcp-collaboration
description: Guide a Custodian in registering and updating its own Karazhan work through MCP after durable local files exist. Use for top-level Project registration, Child Project/Task creation, progress, fields, Today, ResourceBinding registration and availability, revisions, idempotency, and conflict handling. Never use this skill for Medivh.
---

# Karazhan MCP Collaboration

## Audience and ownership

This skill is for the Custodian that owns a Project or Task Workspace. Medivh must not use it.

Every Custodian writes its own Workspace files first and then synchronizes its own structured projection. Use `actor_type: task_agent` and `channel: mcp` for Custodian writes.

`task_agent` is the current wire identifier for Custodian writes. It is a compatibility value in the shared contract, not a third Agent role.

## First registration

A top-level Project Custodian starts from a provisioned Workspace whose `.workbench/task.yaml` already contains a stable `work.id` and `kind: project`. It uses that same ID in an idempotent `CreateProject` command, queries the result, and records the verified registration in its append-only log. Karazhan availability is not a prerequisite for local execution; a failed registration is retried later with the same identity.

## Ongoing work

For ordinary progress, use the workflow below. Read the applicable sections of [references/mcp-workflows.md](references/mcp-workflows.md) for registration, Child creation, fields, Today, ResourceBindings, verbose Action log authoring, or conflict recovery. A Custodian may:

- query its Project/Task, current revision, Children, Today membership, and progress;
- append its own durable Action log entry with a concise summary and optional verbose details;
- explicitly update supported current fields;
- create a Child Project or Child Task with a pre-generated stable local ID;
- register and query ResourceBindings for its own Project/Task, and update binding availability;
- maintain its own `context/index.md` and `context/coordination/` from verified local and Karazhan facts.

Do not create or manage Custodian sessions. Creating a Karazhan node does not create a Custodian.

ResourceBinding writes register locators only; they do not read, scan, upload, or copy the referenced resource. Binding identity (`id`, node, kind, locator) is immutable after creation. Use an availability update to record `available`, `missing`, `unreadable`, or `unknown`, and query the binding after each write.

## Ordinary progress

Synchronize a reviewable delivery, major milestone, or a blocker/condition change that affects execution or needs user attention. Merge ordinary steps into that update. Reading, individual tests, small fixes, and conversational replies stay local; there is no timed-update obligation.

1. Reuse the durable local conclusion and stable `work.id`. Query `get_project` or `get_task` for the current revision.
2. Before sending, retain enough information in the same `agent_log.md` to reconstruct the exact request: node, stable event ID/key, event kind, original expected revision, exact summary/details, step status, and actor/ref/channel. Reuse already recorded text; a compact metadata entry is sufficient. No separate command JSON is required.
3. Send a structured `{ "request": ... }` object through `karazhan_command` with `type: append_progress`, `actor_type: task_agent`, and `channel: mcp`. Use the short local conclusion as `summary`; default `details` and `step_status` to null. Add details only for useful evidence locators, material limits, or decisions needed.
4. Independently query `{ "request": { "type": "recent_progress", "node_id": "<work.id>", "limit": 10 } }`. Match the event ID, node, kind, summary/details, step status, and provenance. If absent, query `progress_timeline` for that node. Filter tool output to the verification result rather than printing history. If still absent or mismatched, record verification pending/conflict rather than success.
5. Append one short local confirmation with event ID and verified outcome; include the returned revision/replay result when available. No separate verification JSON is required.

Ordinary synchronization does not trigger a report, hash manifest, full handoff, index edit, upstream reread, or repeated repository/evidence check. Reports and hashes require a user request, a concrete consumer, or an applicable delivery/verification contract. Keep required validation, release/consumption, and installation protection checks at their actual boundaries. Child Workspace creation still requires an authorized independent owner, acceptance, recovery, or explicit parallel boundary.

On failure, retain the pending request and continue unaffected work; retry at a later meaningful checkpoint without a retry loop. A lost response requires event verification before replay. A successful write whose verification failed needs a later verification, not another newly identified write. Identical replay retains every original field, including expected revision, which participates in idempotency. Do not regenerate the body or substitute a fresh revision under the same key; preserve conflicts and follow the conflict workflow when reconciliation is needed.

## Safety

Use stable idempotency keys, expected revisions, and minimum explicit commands. Query after writes. On conflict, preserve both observations and surface them; never rewrite local evidence merely to match the UI. Never send credentials or raw sensitive Context through MCP.
