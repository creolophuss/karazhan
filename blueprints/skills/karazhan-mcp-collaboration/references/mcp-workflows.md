# File-first Karazhan collaboration

## The invariant

For Custodian-produced facts, local durable files are written first and MCP synchronization happens second.

```text
work → artifact/log/status file → verify durable → MCP command → query result
```

Never use a successful MCP write to compensate for a missing local result. Never make an MCP outage block specialist execution.

## Fact ownership

| Fact | First-hand source |
| --- | --- |
| Code, document, experiment, command output, validation evidence | Custodian Workspace |
| Custodian-reported progress, blocker, delivery, proposed status | append-only Custodian log and referenced artifacts |
| Today membership/order, explicit user priority, Archive/Reopen, accepted `done` | Karazhan user action |
| Project/Task/Backlog identity and Work Tree relationship | Karazhan, cross-referenced by local manifest |
| Workspace and Context location | local manifest/index plus Karazhan ResourceBinding |

This is not a license to keep two silently divergent current states. When sources disagree, preserve both observations, show provenance, and ask for reconciliation.

Ordinary progress uses the self-contained workflow in [SKILL.md](../SKILL.md#ordinary-progress). Registration and other mutations use the applicable sections below. Child Workspace creation requires an authorized independent owner, acceptance, recovery, or explicit parallel boundary; ordinary implementation steps remain in the current Workspace.

## Read before write

Enter this sequence only for an actual synchronization under the delivery rules in [SKILL.md](../SKILL.md#ordinary-progress), or use the applicable workflow for another authorized remote operation. Ordinary analysis, edits, validation, and replies use local context without querying Karazhan.

Before synchronizing:

1. identify the durable local fact being projected; reuse evidence already read and verified unless its content, inputs, or required coverage changed;
2. reuse the stable node ID already resolved from `.workbench/task.yaml`;
3. query the node and its current revision through `karazhan_query`;
4. determine whether the source is a factual progress event, a Custodian proposal, or an explicit user decision;
5. choose the minimum command rather than rewriting an entire object.

For relationship discovery, use the known local index and trusted Workspace paths. Query Karazhan only for the relationship needed by an actual remote operation, an explicit user query, or conflict/pending-write recovery; local discovery does not require a routine remote cross-check. If sources disagree, preserve and report the discrepancy instead of guessing.

## Write safely

Use `karazhan_command` with the shared contract. Supply the command's expected revision, `actor_type: task_agent`, `channel: mcp`, event ID, and idempotency key. Prefer a deterministic key based on stable node ID plus the local log section identity or artifact identity.

The wire value `task_agent` represents the Custodian. It does not imply separate Agent roles for Project and Task work.

After a successful write, independently query the affected result and append a short confirmation to the existing log. For progress, query `recent_progress` with limit 10 and match the event ID and sent fields; fall back to `progress_timeline` if absent. Return only the verification result to the model. Separate command/verification JSON files are optional when an actual consumer requires them. Do not place bearer tokens or secrets in logs or Context.

## Status semantics

- A progress log does not automatically change status.
- A Custodian saying “complete” represents delivery evidence, not user acceptance.
- A Custodian may explicitly move its work to `review` when the workflow and authorization permit it.
- `done` requires an explicit user or authorized control-plane decision.
- Blocker text and status remain separate.

## Failure and replay

- Local write succeeds, MCP fails: retain the durable fact and exact pending request in the existing log; retry later without an automatic retry loop.
- MCP succeeds, response is lost: query before retrying; identical replay must return the existing result.
- Revision conflict: reread both sides, report the newer structured value and local source, and request reconciliation when intent is ambiguous.
- Local write fails: do not publish a completion or evidence claim only to Karazhan.

An identical retry includes the original expected revision, body, event ID, key, and provenance. Expected revision participates in the request digest; replacing it with a newly queried revision can cause IdempotencyConflict even when the text is unchanged. A known successful write with a failed verification remains verification-pending; verify it later instead of creating another event.

There is no assumed offline queue. Retry is an explicit Custodian action based on durable files.

## Current MCP shape

The on-demand stdio companion exposes:

- `karazhan_query` with `{ "request": <shared Query> }`;
- `karazhan_command` with `{ "request": <shared Command> }`.

The host supplies `KARAZHAN_DATABASE_PATH`. stdout is reserved for protocol frames. Use stable structured error codes; do not branch on message text.

## Concrete requests

The tool argument is `{ "request": ... }`. A top-level Project Custodian creates its Project below the fixed system Root with the UUID already stored as `work.id`:

```json
{
  "request": {
    "type": "create_project",
    "payload": {
      "id": "<work.id>",
      "parent_id": "00000000-0000-0000-0000-000000000001",
      "key": "<stable-sibling-key>",
      "title": "<project-title>",
      "summary": "<optional-summary>",
      "position": 0,
      "slug": null,
      "context_path": "<absolute-workspace>/context",
      "context": {
        "idempotency_key": "project:<work.id>:create",
        "actor_type": "task_agent",
        "actor_ref": "custodian:<work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

A Parent Custodian creates a Child Task with the Child's already-persisted local UUID:

```json
{
  "request": {
    "type": "create_task",
    "payload": {
      "id": "<child-work.id>",
      "parent_id": "<parent-work.id>",
      "key": "<stable-sibling-key>",
      "title": "<task-title>",
      "summary": "<optional-summary>",
      "position": 0,
      "context": {
        "idempotency_key": "task:<child-work.id>:create",
        "actor_type": "task_agent",
        "actor_ref": "custodian:<parent-work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

Use `create_project` instead when the Child is a Project. Use its Parent Project/Task ID as `parent_id`; Karazhan enforces the legal parent matrix. Positions are sibling-local and must be chosen from a current Parent query rather than assumed when siblings already exist.

After durable progress is appended locally, write each Action log entry in two parts when verbose evidence is useful:

```text
<one-line summary>
---
<verbose details, evidence, verification, unresolved facts, and next action>
```

The `---` line is an authoring delimiter, not stored content. Map the text before it to `summary` and the text after it to `details`. Keep `summary` short enough for Recent steps. Omit the delimiter and send `details: null` when the summary is sufficient. Never put credentials or raw sensitive Context in either field.

For verbose progress only, query the current node revision, retain the exact request information in the existing log, and submit:

```json
{
  "request": {
    "type": "append_progress",
    "payload": {
      "node_id": "<work.id>",
      "event_id": "<stable-event-uuid>",
      "event_kind": "progress",
      "summary": "<durable-fact-summary>",
      "details": "<optional-verbose-action-details>",
      "step_status": null,
      "expected_revision": 3,
      "context": {
        "idempotency_key": "progress:<work.id>:<local-entry-id>",
        "actor_type": "task_agent",
        "actor_ref": "custodian:<work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

Query the affected result after every command. Ordinary progress defaults to `details: null` and uses the recent-10 verification described in SKILL.md. Reuse the same event ID and idempotency key only for an identical retry.

A Custodian registers its already-persisted Workspace locator without asking Karazhan to read the directory:

```json
{
  "request": {
    "type": "add_resource_binding",
    "payload": {
      "id": "<stable-binding-uuid>",
      "node_id": "<work.id>",
      "kind": "workspace",
      "locator": "<absolute-workspace-path>",
      "is_primary": true,
      "availability": "available",
      "source": "custodian_manifest",
      "context": {
        "idempotency_key": "binding:<stable-binding-uuid>:create",
        "actor_type": "task_agent",
        "actor_ref": "custodian:<work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

Query `list_resource_bindings` for the node and use the returned binding revision when its availability changes:

```json
{
  "request": {
    "type": "update_resource_availability",
    "payload": {
      "binding_id": "<stable-binding-uuid>",
      "availability": "missing",
      "expected_revision": 1,
      "context": {
        "idempotency_key": "binding:<stable-binding-uuid>:availability:missing:r1",
        "actor_type": "task_agent",
        "actor_ref": "custodian:<work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

Allowed availability values are `available`, `missing`, `unreadable`, and `unknown`. Do not use availability to delete a Project/Task or rewrite binding identity. Register only locators within the Custodian's authorization boundary; never place credentials or sensitive file contents in a locator or source field.
