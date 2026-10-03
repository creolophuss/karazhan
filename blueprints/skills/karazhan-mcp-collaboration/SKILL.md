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

Read [references/mcp-workflows.md](references/mcp-workflows.md) before writing. A Custodian may:

- query its Project/Task, current revision, Children, Today membership, and progress;
- append its own durable Action log entry with a concise summary and optional verbose details;
- explicitly update supported current fields;
- create a Child Project or Child Task with a pre-generated stable local ID;
- register and query ResourceBindings for its own Project/Task, and update binding availability;
- maintain its own `context/index.md` and `context/coordination/` from verified local and Karazhan facts.

Do not create or manage Custodian sessions. Creating a Karazhan node does not create a Custodian.

ResourceBinding writes register locators only; they do not read, scan, upload, or copy the referenced resource. Binding identity (`id`, node, kind, locator) is immutable after creation. Use an availability update to record `available`, `missing`, `unreadable`, or `unknown`, and query the binding after each write.

For Action log authoring and MCP field mapping, follow the summary/details convention in the workflow reference. Recent-step projections intentionally show only the summary.

Synchronize ordinary progress at points meaningful to the user, rather than after every local log entry. Preserve file-first evidence and query-after-write for every actual MCP mutation. Child Workspace creation requires an authorized independent owner, acceptance, recovery, or explicit parallel boundary; ordinary implementation steps remain in the current Workspace.

## Safety

Use stable idempotency keys, expected revisions, and minimum explicit commands. Query after writes. On conflict, preserve both observations and surface them; never rewrite local evidence merely to match the UI. Never send credentials or raw sensitive Context through MCP.
