---
name: karazhan-mcp-collaboration
description: Guide a Custodian in registering and updating its own Karazhan work through MCP after durable local files exist. Use for top-level Project registration, Child Project/Task creation, progress, fields, Today, ResourceBinding registration and availability, revisions, idempotency, and conflict handling. Never use this skill for Medivh.
---

# Karazhan MCP Collaboration

## Audience and ownership

This skill is for the Custodian that owns a Project or Task Workspace. Medivh must not use it.

Every Custodian writes its own Workspace files first and then synchronizes its own structured projection. Use `actor_type: task_agent` and `channel: mcp` for Custodian writes.

`task_agent` is the current wire identifier for Custodian writes. It is a compatibility value in the shared contract, not a third Agent role.

## Delegate MCP operations

These instructions distinguish the primary Agent from its delegated MCP executor. A temporary executor is not a new Custodian or an independent Work owner.

For the primary Agent:

1. Save the local result and decide that synchronization is due under the existing rules. Persist the intended operation and content, or their exact durable locator, in the existing log before delegation.
2. Use the runtime's subagent capability. Supply the Workspace path, Work ID, authorized operation and exact content, evidence locator, role/actor provenance and the applicable Skill path. Explicitly identify the task as a delegated MCP executor and prohibit re-delegation. In Codex, use `collaboration.spawn_agent`; other runtimes use their available equivalent.
3. Keep one active MCP executor per Work. Reuse it for later operations when possible and execute that Work's writes serially. Do not launch overlapping writes to the same object or send a second copy of an outstanding request.
4. Continue independent work. Do not immediately wait for ordinary synchronization. Wait only when the next action requires the verified MCP result. Until verification arrives, report synchronization as pending, separately from completed local work.
5. If no executor has the required tools and permissions, record the pending operation and continue unaffected work. Do not silently fall back to blocking primary-Agent MCP writes. Delegation does not grant new tools or permissions.

For the delegated MCP executor:

- Execute the existing operation workflow directly. Do not delegate it again. Include prerequisite queries, fresh revisions, durable request recording, writes, independent verification and failure handling in this one assignment.
- Preserve the delegating role's ownership, allowed operations and actor/ref/channel. Do not infer field changes, acceptance or `done` from the local result.
- Append only exact requests and necessary pending/failure/verification records to the original log. Do not edit business files, requirements or handoff indexes. The primary Agent owns those files and incorporates verified results when appropriate.
- Return verified success, failure, conflict or verification pending, with the event/object ID and log locator. Follow the existing identical-replay and conflict rules; do not add retry loops. A session ending does not guarantee that an in-flight executor survives: retain pending intent for recovery.

## First registration

A top-level Project Custodian starts from a provisioned Workspace whose `.workbench/task.yaml` already contains a stable `work.id` and `kind: project`. It uses that same ID in an idempotent `CreateProject` command, queries the result, and records the verified registration in its append-only log. Karazhan availability is not a prerequisite for local execution; a failed registration is retried later with the same identity.

## Ongoing work

Reuse local context for analysis, edits, and validation without querying Karazhan. Query only for an actual registration, progress, field, Today, Child, or ResourceBinding operation, an explicit user query, or conflict/pending-write recovery. Local recovery alone does not require a remote query. Keep the revision and verification queries required by the applicable operation.

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

The Codex progress timer starts by default in a prepared Workspace. When its active binding matches the current main thread, the timer is the delegated executor for ordinary conversation progress. It records important facts locally, appends the event and verifies it. Leave these events to the timer. The primary Agent owns authoritative files, handoffs and explicit field changes. Check the timer's pending count and error when recovering an uncertain write.

Synchronize the first complete result that meets the current explicit delivery conditions, actual phase deliveries, major milestones, and blocker/condition changes that affect execution or need user attention. A draft, ordinary revision, wording change, or repeat display does not qualify as a new delivery. A reply ending does not end a phase. Merge ordinary steps into the next meaningful update; there is no timed-update obligation.

Decide whether synchronization is due before entering the steps below. Reuse the durable local conclusion; do not reread the task records just to prepare a reply. Merge ordinary analysis, edits, small fixes, and test results into the local log at actual delivery or a deliberate stop that needs recovery. Preserve critical authorization, execution-affecting decisions, blockers, and pending external operations promptly; reference existing authoritative content and evidence without repeating it.

The primary Agent delegates this sequence; the delegated MCP executor performs steps 1–5 directly.

1. Reuse the durable local conclusion and known stable `work.id`. Query `get_project` or `get_task` for the current revision only for this actual synchronization. Do not substitute a cached revision.
2. Before sending, retain enough information in the same `agent_log.md` to reconstruct the exact request: node, stable event ID/key, event kind, original expected revision, exact summary/details, step status, and actor/ref/channel. Reuse already recorded text; a compact metadata entry is sufficient. No separate command JSON is required.
3. Send a structured `{ "request": ... }` object through `karazhan_command` with `type: append_progress`, `actor_type: task_agent`, and `channel: mcp`. Use the short local conclusion as `summary`; default `details` and `step_status` to null. Add details only for useful evidence locators, material limits, or decisions needed.
4. Independently query `{ "request": { "type": "recent_progress", "node_id": "<work.id>", "limit": 10 } }`. Match the event ID, node, kind, summary/details, step status, and provenance. If absent, query `progress_timeline` for that node. Filter tool output to the verification result rather than printing history. If still absent or mismatched, record verification pending/conflict rather than success.
5. Append one short local confirmation with event ID and verified outcome; include the returned revision/replay result when available. No separate verification JSON is required.

Ordinary synchronization does not trigger a report, hash manifest, full handoff, index edit, upstream reread, or repeated repository/evidence check. Reports and hashes require a user request, a concrete consumer, or an applicable delivery/verification contract. Keep required validation, release/consumption, and installation protection checks at their actual boundaries. Child Workspace creation still requires an authorized independent owner, acceptance, recovery, or explicit parallel boundary.

On failure, retain the pending request and continue unaffected work; retry at a later meaningful checkpoint without a retry loop. A lost response requires event verification before replay. A successful write whose verification failed needs a later verification, not another newly identified write. Identical replay retains every original field, including expected revision, which participates in idempotency. Do not regenerate the body or substitute a fresh revision under the same key; preserve conflicts and follow the conflict workflow when reconciliation is needed.

## Safety

Use stable idempotency keys, expected revisions, and minimum explicit commands. Query after writes. On conflict, preserve both observations and surface them; never rewrite local evidence merely to match the UI. Never send credentials or raw sensitive Context through MCP.
