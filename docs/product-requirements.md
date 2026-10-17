# Product and integration reference

This is the repository's product requirement authority. It combines the product model, current capabilities, Agent collaboration rules, and advanced integration notes. Confirm changed requirements here before implementation. See [the English README](../README.md) or [中文 README](../README.zh-CN.md) for installation and basic use.

## Purpose and scope

Karazhan helps one user track work across local Agents, Projects, and Tasks on macOS. The desktop presents structured state and progress. Agents work from durable local Workspace files and synchronize selected structured information through MCP. Karazhan is not their runtime or a prerequisite for local work.

The current desktop provides Today, Projects & Tasks, Backlog, and Archive. Search, Settings/Import, legacy cutover, cloud sync, multiple users, an embedded Assistant, and Agent lifecycle orchestration are outside current scope. There is no Context index, automatic document summary, vector store, or file-content mirror in the database. Existing legacy import APIs are available for isolated integration tests; they are not a supported production migration procedure.

## Work model

Project, Task, and Backlog form one Work Tree under an immutable system Root. The UI hides Root.

| Parent | Allowed direct children |
| --- | --- |
| Root | Project, Task, Backlog |
| Project | Project, Task, Backlog |
| Task | Task, Backlog |
| Backlog | None |

Each non-Root node has a stable UUID, one Parent, a sibling-unique key, and an explicit sibling position. Moves must preserve parent-type rules and prevent cycles. A node's kind does not change in place. An optional Project slug is unique across Projects. A Project can exist before its Workspace or Context path is known.

A Child Task is an ordinary Task whose Parent is another Task. There is no separate TodoItem or unique next-action field. Use Child Tasks and their order to express multiple actions.

Project and Task status values are `planned`, `ready`, `in_progress`, `pending`, `review`, `done`, and `cancelled`. Completion requires user acceptance or an explicitly authorized reviewer. Natural-language logs do not change status. Blocker text is independent of status. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Backlog kinds are `idea`, `problem`, `request`, and `research`. Lifecycle values are `captured`, `considering`, `ready`, `promoted`, and `discarded`. Promotion atomically creates a new Project or Task, marks the source promoted, and retains the source-to-target link. Discard preserves the original record.

## Desktop behavior

### Today

Today is an explicitly selected, manually ordered projection of Projects and Tasks. Membership and ordering do not change Work Tree positions, priority, or status. Backlog cannot enter Today. Removing a normal item from Today does not delete its Work Tree node.

A Project card includes recursive Child Projects and Tasks that do not have their own Today card. An independently selected descendant and its subtree stop appearing in the ancestor card. Project progress aggregates only the descendants still represented by that card and identifies the source.

Recent steps shows business progress, deliveries, and manual Steps. Field audits and Today membership/order events remain in the complete timeline without filling Recent steps. Compact views show short summaries. The full Action log also shows optional details. Quick items are ordinary Tasks with a quick-item flag, shown in Today and omitted from Projects & Tasks; their checkbox changes the same Task status.

### Projects & Tasks

Support recursive display, expand/collapse, legal moves, sibling ordering, status and priority changes, manual Steps, Today membership, and recursive archive. Projects can contain Child Projects and Tasks; Tasks can contain Child Tasks. The central client must prevent older asynchronous responses from replacing newer filter results. Visible Today and Projects & Tasks refresh after external changes and on window focus/visibility, without overlapping requests or resetting expansion state.

### Backlog and Archive

Backlog supports capture, inline Edit with Save/Cancel, Move, Promote, Discard, Parent/kind/priority/tag filters, and ordered drag operations. Parent selectors and labels show the hierarchy. Cross-Parent drag updates Parent and position atomically. Promoted and discarded entries are hidden from the active view; lifecycle status remains in the domain model.

Archive recursively archives a Project or Task subtree and removes its Today membership. Reopen restores the selected subtree and required archived ancestors, without recreating old Today membership. Permanent deletion requires an already archived subtree and explicit confirmation. Root cannot be archived or deleted. Archived Parents cannot receive new children.

### External resources

ResourceBinding stores locators for Project/Task Workspaces, repositories, manifests, logs, sessions, URLs, files, or directories. Root and Backlog cannot own bindings. Shared paths do not merge nodes. Missing paths change availability rather than deleting work. Binding identity fields remain fixed after creation; availability updates use revisions.

The product stores an optional Context directory path on a Project. A Task resolves the nearest ancestor Project's Context path. An independent Task has no implicit product Context. A Task Workspace can still own a local `context/` directory under the filesystem contract. Karazhan does not scan, index, copy, or reconstruct its contents.

Open in Zed accepts a node ID. Rust resolves an available primary Workspace binding, checks the canonical directory against allowed roots, and invokes fixed macOS Launch Services arguments. The frontend cannot submit an arbitrary path or shell command. A valid directory in the user's home must open. Show complete errors without covering adjacent controls. Zed's optional CLI is not required.

## Architecture and data contract

React/TypeScript uses the central client to invoke thin Tauri IPC. Tauri, loopback HTTP, and stdio MCP dispatch to the same Rust application/domain core and SQLite database. No adapter duplicates business rules. React does not access the filesystem, shell, or database directly.

Commands preserve stable IDs, optimistic revisions, command-specific idempotency keys, actor/channel provenance, timestamps, and structured error codes. Related field changes and ProgressEvents commit in one transaction. Clients must handle conflicts by code, inspect current state, and retry only according to the shared contract. Do not interpret a log line as an authoritative state update.

ProgressEvent is separate from the Work Tree. It stores a short summary, optional verbose details, evidence and provenance. Old summary-only events remain valid. Manual Steps do not change the parent work's status or revision. Current state comes from explicit fields; event history does not infer it.

The application contract is in [application.rs](../crates/karazhan-core/src/application.rs). Adapter implementations are in [crates](../crates/) and [the Tauri shell](../apps/desktop/src-tauri/). Use the tagged Command/Query structures rather than inventing payload fields.

## Agent collaboration

Medivh prepares and validates top-level Project Workspaces. It may then register the matching top-level Project and primary Workspace binding through MCP. It may also capture Backlog explicitly requested by the user, under Root by default or a queried, user-specified Parent. It cannot manage Custodian sessions, create Child work, update ongoing fields/Today/progress, or edit existing Backlog. See [Medivh's role boundary](../blueprints/medivh/README.md).

The user starts a Custodian in the prepared Workspace. Each Custodian owns its local requirements, Context, instructions, logs, and results. Parent/sibling Context is referenced; it is not copied wholesale or edited by another owner. Create Child Workspaces only when actual work needs them. A precise user-supplied path confirms the target, but does not authorize overwriting conflicts or broader access.

Write durable local files before structured synchronization. Local requirements own goal/scope/acceptance. Reuse context during continuous work; recover only the necessary records after context loss or relevant external changes. Synchronize reviewable deliveries, major milestones, and changes that affect execution or need user attention. Ordinary discussion, reading, and individual tests do not require a remote query or a separate progress event.

Retain enough local information to recover an uncertain write, including its exact request. Use stable idempotency and expected revisions. Independently query after a write; for progress, check recent events first and use the full timeline if needed. Complete handoffs belong at phase acceptance, ownership transfer, deliberate stopping for recovery, or a major baseline switch. Append history; do not maintain conflicting status copies. User acceptance controls `done`.

The startup package contains [workspace-provisioning](../blueprints/skills/workspace-provisioning/SKILL.md), [karazhan-mcp-collaboration](../blueprints/skills/karazhan-mcp-collaboration/SKILL.md), and [answer-me-with-html](../blueprints/skills/answer-me-with-html/SKILL.md). HTML explanations use the Skill's native selection rules, a Workspace-local artifact directory, and `--no-open`; do not enable it for every reply. Preserve upstream notices and license files. Upgrade managed copies through the source/package workflow.

## Installation and updates

The [README](../README.md#install-from-source) describes supported source installation. The installer builds the current clean, complete checkout. Managed versions use Tauri's major/minor and the reachable commit count as patch. Record the source commit and content baseline per target. Higher versions update, equal versions are a no-op, missing targets can be restored, and downgrades are rejected. Locally changed managed files and conflicting existing MCP configuration stop installation. Back up unversioned targets before adoption.

Install the App under `~/Applications`, binaries under `~/.local/bin`, and selected Medivh files under `~/.hermes/profiles/medivh`. Only the two required MCP configuration leaves are filled when missing; unrelated settings remain user-owned. Memories, sessions, and other Skills are not replaced or baselined. `memories/USER.md` in the repository is only a reference template. `KARAZHAN_INSTALL_SKIP_APP=1` skips the App and continues with MCP and Medivh. The installer does not pull source or configure model credentials.

Check cmux and Zed before build/download work. Find the CLI on `PATH` or the App in `/Applications` or `~/Applications`. For cmux, distinguish an App without a reachable CLI and explain that Claude notifications need the CLI and a running cmux session. For Zed, an App is sufficient; its CLI is optional. Missing dependencies produce a warning with affected functionality and official installation instructions. Continue installation. Do not install either dependency, launch them, or edit `PATH` automatically.

Network commands inherit standard proxy environment variables. `KARAZHAN_INSTALL_PROXY` is an optional override for installer network subprocesses. No fixed loopback proxy is the default, and no global proxy configuration changes.

Normal release builds avoid a repository-local launchable `.app`. Installation bundles in a temporary target and retains one installed App, avoiding duplicate bundle IDs. The `medivh` launcher checks its profile process and PID lock before starting `hermes -p medivh chat`. It refuses duplicate active launches and clears only its own stale lock.

## MCP configuration

The MCP host starts `karazhan-mcp` on demand. Set the required `KARAZHAN_DATABASE_PATH` to the intended database. The default desktop path on macOS is:

```text
~/Library/Application Support/com.jiayi.karazhan/karazhan.sqlite3
```

Example host configuration; replace both absolute paths:

```json
{
  "mcpServers": {
    "karazhan": {
      "command": "/absolute/path/to/karazhan-mcp",
      "env": {
        "KARAZHAN_DATABASE_PATH": "/absolute/path/to/karazhan.sqlite3"
      }
    }
  }
}
```

`karazhan_command` accepts `{ "request": <Command> }`; `karazhan_query` accepts `{ "request": <Query> }`. Commands carry their defined revisions, idempotency, event IDs and actor/channel context. MCP stdout contains protocol frames only; diagnostics go to stderr. Missing database configuration exits with an error. MCP does not provide arbitrary shell execution, file reading, or Agent lifecycle control.

## Local HTTP

While the desktop runs, HTTP attempts to bind exactly `127.0.0.1:47831`. It never falls back to another port or a LAN address. Bind failure leaves the desktop core available and reports Agent API unavailable. Exit releases the port.

Routes are `POST /v1/command` and `POST /v1/query`. Requests require the per-launch random bearer token and the expected Host. An optional Origin must match the local endpoint. Structured errors include `unauthorized`, `invalid_host`, and `invalid_origin`. Never log tokens, commit them, place them in URLs, or reuse them across launches.

The stock desktop has no supported token handoff to external clients. It does not publish its token in a file, UI, environment, stdout, or discovery endpoint. Use MCP for external automation. The HTTP adapter remains a tested internal integration surface, without a desktop copy-and-paste token workflow.

## Context notifications

The on-demand [Node adapter](../scripts/context-notify.mjs) uses native Codex queue or Claude/cmux. It has no resident service, database, processing receipt, automatic retry, or sent-message history. Hermes reception is not enabled. It does not call Karazhan or manage Agent lifecycles.

For user-requested Context updates, ask which text to update and which destinations to use: only the owner's local files, its Context, Parent, Sibling, Child, and a separate optional Karazhan update. At a major decision, the Agent can propose selected paragraphs and destinations. Use the host's structured choice UI when available. Confirm the exact content and destinations before sending. Local saving does not imply a Karazhan write. Receivers assess the message and update only their own files.

Run these commands from the intended Workspace, using an absolute script path:

```sh
node /absolute/path/to/karazhan/scripts/context-notify.mjs --help
node /absolute/path/to/karazhan/scripts/context-notify.mjs self-register --agent codex
node /absolute/path/to/karazhan/scripts/context-notify.mjs self-register --agent claude
node /absolute/path/to/karazhan/scripts/context-notify.mjs install-hooks
node /absolute/path/to/karazhan/scripts/context-notify.mjs list
```

Self-registration finds `work.id` in the nearest `.workbench/task.yaml`. Codex uses Hook `session_id` or, outside a Hook, `CODEX_THREAD_ID`. Claude uses `CMUX_SURFACE_ID`; a Claude session UUID or workspace title is not a substitute. A Hook verifies its working directory belongs to the Workspace. Startup/resume/clear/fork can register; compaction does not replace a route.

`install-hooks` merges Workspace-local `.codex/hooks.json` and `.claude/settings.local.json`, preserving existing handlers and settings. Repeated installation does not duplicate handlers. This command does not grant native trust. Review non-managed Codex Hooks in `/hooks` when prompted and trust the project configuration through the runtime. Claude's project trust controls also apply. Already running sessions do not necessarily reload new configuration; use self-registration immediately or restart/resume normally. Moving the script requires installing the local Hook again.

Routes live at `$XDG_STATE_HOME/karazhan/context-notify/sessions.json`, or `~/.local/state/karazhan/context-notify/sessions.json`. `--registry` or `KARAZHAN_CONTEXT_REGISTRY` can override this. Concurrent registration uses a bounded lock and atomic replacement. One Work has one current route; the latest successful self-registration replaces it. Registration does not prove the session is online or owned by the intended user. Check `list` and verify the destination. Exited sessions are not automatically removed.

Explicit registration and removal require precise UUIDs. Use `register --work UUID --workspace /absolute/path --agent codex|claude --address UUID`, adding `--replace` to change an existing route. Use `unregister --work UUID --address UUID` to remove that exact address.

Send selected text from a file:

```sh
node /absolute/path/to/karazhan/scripts/context-notify.mjs send --source SOURCE_WORK_UUID --to TARGET_WORK_UUID --file /absolute/path/to/selected-text.txt
```

This previews without sending. After the user approves that content and those targets, repeat with `--confirm`. Multiple `--to` arguments are supported. `--confirm` records the caller's assertion of approval; it is not an independent approval UI. Re-preview after content or routes change. Keep selected files outside tracked source. Do not include credentials or unselected private Context.

Native acceptance means the send command succeeded, not that the receiver read or adopted the text. Failures are visible per target; a timeout can leave acceptance unknown. There is no automatic resend. Codex queue and cmux behavior depend on the installed runtime and session state. Claude/cmux can wake an idle supported session; cmux alone must not be assumed to wake idle Codex. Offline addresses do not guarantee immediate handling. Use trusted CLI commands on `PATH`.

## Database safety

SQLite uses foreign keys, WAL, a bounded busy timeout, numbered checksum-verified migrations, and a cross-process migration lock. A migration competitor gets `migration_busy`; checksum mismatch stops writes. Business transactions preserve type, tree, sibling, Today, binding, and event invariants.

Before an upgrade migration, checkpoint WAL and use SQLite Online Backup. Validate the backup and run migrations transactionally. Do not copy an active WAL database with a raw file copy. Stop desktop and MCP writers before read-only diagnosis or an approved operational restore. Database backup does not include Workspace or Context content.

Explicit backup and restore are tested Rust core APIs. They have no end-user desktop, MCP, HTTP, or administrative CLI entry point. Restore validates a temporary database's integrity, foreign keys, invariants, and object counts before atomic replacement. Keep failed-restore diagnostic files. Do not substitute manual database edits or a raw copy for these APIs. Destructive down migrations are not supported.

## Verification and boundaries

Use `npm ci`, then `npm run check`. The gate runs Rust formatting, strict Clippy, Rust tests, frontend tests, TypeScript checks, and a production frontend build. Tests use synthetic data, memory databases, and temporary directories. Preserve behavioral coverage for migrations, revisions, idempotency, atomic rollback, adapter contracts, safe paths, installer ownership, and notification confirmation/routing.

Keep credentials, personal Context, local Agent configuration, execution logs, reports, screenshots, and database files outside tracked source. Tests must not read personal data or migrate real Workspaces. The App stores data locally and offers no remote multi-user access or cloud sync.
