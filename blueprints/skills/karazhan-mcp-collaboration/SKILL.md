---
name: karazhan-mcp-collaboration
description: Guide a Custodian in registering and updating its own Karazhan work through MCP after durable local files exist. Use for top-level Project registration, Child Project/Task creation, progress, fields, Today, ResourceBinding queries, revisions, idempotency, and conflict handling. Never use this skill for Medivh.
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
- append its own durable progress and evidence;
- explicitly update supported current fields;
- create a Child Project or Child Task with a pre-generated stable local ID;
- query existing Context and ResourceBindings;
- maintain its own `context/index.md` and `context/coordination/` from verified local and Karazhan facts.

Do not create or manage Custodian sessions. Creating a Karazhan node does not create a Custodian.

The current shared MCP contract can query ResourceBindings but cannot create or update them. Do not claim that a Workspace binding was registered through MCP. Project creation may set `context_path` to the Project's local `context/` directory; Workspace ResourceBinding writes remain a product gap.

## Safety

Use stable idempotency keys, expected revisions, and minimum explicit commands. Query after writes. On conflict, preserve both observations and surface them; never rewrite local evidence merely to match the UI. Never send credentials or raw sensitive Context through MCP.
