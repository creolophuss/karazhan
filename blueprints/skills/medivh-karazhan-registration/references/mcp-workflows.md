# Medivh Project registration and Backlog capture

The stdio server exposes `karazhan_query` and `karazhan_command`; each tool takes `{ "request": ... }`. The Hermes host supplies the product database path.

## Prepare durable identities

Read the validated Workspace's `.workbench/task.yaml`, `context/requirements.md`, and `context/index.md`. The manifest must identify a top-level `project` and have no Karazhan Parent other than the fixed system Root `00000000-0000-0000-0000-000000000001`.

Before writing, append a pending registration record to `agent_log.md` containing:

- the existing `work.id` and stable sibling key;
- a newly generated ResourceBinding UUID;
- `project:<work.id>:create` and `binding:<binding-id>:create` idempotency keys;
- the exact absolute Workspace locator.

Do not send Context contents, credentials, or other file contents through MCP.

## Query and create the Project

First query the stable ID:

```json
{"request":{"type":"get_project","id":"<work.id>"}}
```

If it does not exist, query the current root children. Project and Task positions come from:

```json
{"request":{"type":"list_project_task_tree"}}
```

Root Backlog positions come from:

```json
{"request":{"type":"list_backlog","filter":{"parent_id":"00000000-0000-0000-0000-000000000001"}}}
```

Choose an unused non-negative Root position and submit:

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
        "actor_type": "medivh",
        "actor_ref": "medivh:<work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

Replace `position` with the queried free position. Query `get_project` again and verify ID, Parent, kind, key, title, context path, and revision. Do not update an existing Project to force a match.

## Query and create the Workspace binding

Query bindings:

```json
{"request":{"type":"list_resource_bindings","node_id":"<work.id>"}}
```

If the pending binding is absent and no conflicting primary Workspace binding exists, submit:

```json
{
  "request": {
    "type": "add_resource_binding",
    "payload": {
      "id": "<binding-id>",
      "node_id": "<work.id>",
      "kind": "workspace",
      "locator": "<absolute-workspace-path>",
      "is_primary": true,
      "availability": "available",
      "source": "medivh_manifest",
      "context": {
        "idempotency_key": "binding:<binding-id>:create",
        "actor_type": "medivh",
        "actor_ref": "medivh:<work.id>",
        "channel": "mcp"
      }
    }
  }
}
```

Query bindings again and verify the binding ID, node, kind, exact locator, primary flag, availability, source, and revision. Append the verified result to `agent_log.md`; update only the latest-handoff locator in `context/index.md`.

## Capture a user-requested Backlog item

Backlog capture is a user planning decision whose structured source is Karazhan. Do not create a Workspace merely to hold it. Require a clear title; description is optional. When omitted, use the same safe defaults as the desktop form: system Root Parent, kind `idea`, priority `none`, and no tags. Never guess a Project or Task association; verify any non-Root Parent explicitly named by the user.

If the user selects a non-Root Parent, query `list_project_task_tree` and verify the exact Project/Task ID and title before writing. Query existing Project/Task children and `list_backlog` for that Parent so the new key is unused across all sibling kinds; Backlog creation appends at the next sibling position. Generate a new stable UUID before the call and use `backlog:<backlog-id>:create` for identical retries.

Submit:

```json
{
  "request": {
    "type": "create_backlog",
    "payload": {
      "id": "<backlog-id>",
      "parent_id": "<confirmed-parent-id-or-system-root>",
      "key": "<stable-sibling-key>",
      "title": "<user-requested-title>",
      "description": "<optional-description>",
      "kind": "idea",
      "priority": "none",
      "tags": [],
      "context": {
        "idempotency_key": "backlog:<backlog-id>:create",
        "actor_type": "medivh",
        "actor_ref": "medivh:backlog:<backlog-id>",
        "channel": "mcp"
      }
    }
  }
}
```

Valid kinds are `idea`, `problem`, `request`, and `research`; valid priorities are `urgent`, `high`, `medium`, `low`, and `none`. Replace the example values only from the confirmed request. Query `list_backlog` for the Parent after the write and verify the exact ID, Parent, key, title, description, kind, priority, tags, position, and revision. Do not issue update, move, discard, or promote commands from Medivh.

## Pitfall: Hermes MCP harness failures

Local observation (2026-09-30): Hermes tool calls failed with `'bool' object has no attribute 'get'`. This host error alone does not establish server health. Verify the configured Karazhan stdio companion with a read-only query before retrying writes. Use the command and `KARAZHAN_DATABASE_PATH` from the existing Profile configuration, not a guessed binary or database path; do not print credentials or configuration contents.

If the host harness fails but the same query succeeds through that companion, use stdio JSON-RPC: `initialize` → `notifications/initialized` → `tools/call`. Tool arguments remain `{ "request": ... }` with a structured request object, not a JSON string. Preserve Medivh's permitted operations, actor provenance, durable identities, file-first evidence, and query-after-write. If a write response was lost, query the stable ID and replay only an identical command; changing the transport does not authorize changing its content.

## Pitfall: sibling position conflicts invisible to queries

Local observation (2026-10-02): Root positions 0 and 3 conflicted despite being absent from `list_project_task_tree` and default `list_backlog` results. Those projections exclude Quick items, archived work, and some Backlog states, so a position missing from them is not proof that it is free.

For a top-level `create_project` returning the explicit domain error `sibling_position_conflict`, query the stable Project ID and refresh the Root sibling projections. If the ID is confirmed absent and position was not explicitly chosen by the user, record the rejected and proposed positions, then retry once with only position changed to `max(rejected position, maximum visible Root sibling position) + 1`. Keep the same ID, sibling key, other content, and idempotency key. The current core rolls back this rejected create before persisting a receipt; this exception applies only to a confirmed rejected create, never a lost/ambiguous response or a successful command.

Query after success. If the ID exists, identity/key differs, the user specified the position, the retry conflicts, or the outcome is uncertain, stop and report the observations. Do not reorder or modify existing nodes, allocate a replacement identity, or keep probing positions. Backlog creation assigns its position in the core and does not use this exception.

## Failure and replay

- Local provisioning succeeds and MCP fails: retain the pending record and retry the same identities later.
- A response is lost: query before replay; replay only an identical command.
- An ID, key, or binding conflicts: stop and report both local and Karazhan facts. A confirmed top-level Project position rejection permits only the single correction described above; other position conflicts stop.
- The Project exists but differs: do not issue field or lifecycle updates from Medivh.
- Backlog creation fails or its response is lost: query the confirmed Parent before retrying; replay only the identical ID, content, and idempotency key.
