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

Each independent Today row, including a quick item, offers **Move to top** and **Move to bottom** in its context menu. These actions save the same order as pointer dragging. Disable an action when the row is already at that end, and disable both while a membership operation is saving. Preserve Add step on normal rows. Embedded descendants keep their hierarchy order and do not gain Today membership from opening the menu.

A Project card includes recursive Child Projects and Tasks that do not have their own Today card. An independently selected descendant and its subtree stop appearing in the ancestor card. Project progress aggregates only the descendants still represented by that card and identifies the source.

Recent steps shows business progress, deliveries, and manual Steps. Field audits and Today membership/order events remain in the complete timeline without filling Recent steps. Compact views show short summaries. The full Action log also shows optional details. Quick items are ordinary Tasks with a quick-item flag, shown in Today and omitted from Projects & Tasks; their checkbox changes the same Task status.

### Projects & Tasks

Support recursive display, expand/collapse, legal moves, sibling ordering, status and priority changes, manual Steps, Today membership, and recursive archive. Projects can contain Child Projects and Tasks; Tasks can contain Child Tasks. The central client must prevent older asynchronous responses from replacing newer filter results. Visible Today and Projects & Tasks refresh after external changes and on window focus/visibility, without overlapping requests or resetting expansion state.

Today and Projects & Tasks show each Project or Task's own primary Workspace locator under its title, including descendants and quick Tasks. Show the registered path even when unavailable, with ellipsis and a full-path tooltip. Show “未绑定工作目录” when absent. Do not use Context or Parent paths. Shared read projections add nullable `workspace_path`. Archive presentation and Open in Zed safety checks remain unchanged.

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

The startup package contains [workspace-provisioning](../blueprints/skills/workspace-provisioning/SKILL.md) and [karazhan-mcp-collaboration](../blueprints/skills/karazhan-mcp-collaboration/SKILL.md). Agents may choose HTML when the content benefits. Generate pages directly with structure and interactions suited to the material. Do not require a presentation Skill, renderer, or fixed template. Preserve substantive explanations and evidence. Use ASD-STE100 principles in English and Chinese. Historical generated artifacts remain user data. See [HTML practices and prompt examples](html-output-practices.md) for optional reference material.

### Scheduled Codex progress

The macOS progress timer is on by default. Provisioning installs a Workspace-local Codex hook. Starting or resuming the first eligible main thread binds the Project or Task Workspace and starts its hourly schedule. An existing binding keeps its thread, interval and checkpoint. A Workspace with an explicit opt-out stays off across starts and resumes. A checkpoint identifies new user and assistant messages, including messages recorded during an active turn. The timer verifies the thread ID and owning Workspace on each read. [Codex thread history API](https://developers.openai.com/codex/app-server/#read-a-stored-thread-without-resuming)

When eligible messages arrive, the timer uses `codex exec fork --ephemeral <THREAD_ID>` on the bound main thread. The fork can use earlier discussion to interpret a new decision such as “go with the second option.” Only changes established by the selected messages are eligible for a new progress event. The input filter covers those candidates. Codex supplies the inherited thread history separately and that history can include tool output and private turns. Starting a turn with “keep this local” or “请勿同步” excludes it from progress reporting. The classifier must omit private material from summaries. Idle checks skip the model call and can still synchronize pending events.

The timer records a reviewable delivery, a material decision or a blocker change in `agent_log.md` first. It then appends and independently verifies the corresponding Karazhan Action log entry. Routine discussion and repeated results are skipped. On a successful start or resume the hook tells the bound thread to leave ordinary progress reporting to the timer. The primary Custodian continues to save evidence and formal handoffs and owns explicit field changes. Existing Custodians can adopt the packaged timer through the scaffold update workflow. [Scaffold update workflow](scaffold-updates.md)

Use Python 3.9 or later, a signed-in Codex CLI with `thread/turns/list` and `exec fork --ephemeral --output-schema`, and the installed `karazhan-mcp`. The timer reads the database path from `KARAZHAN_DATABASE_PATH` or the configured Codex `karazhan` stdio MCP server. The commands below run from the owning Workspace.

```sh
python3 /absolute/path/to/karazhan/scripts/codex_progress.py status
python3 /absolute/path/to/karazhan/scripts/codex_progress.py disable
python3 /absolute/path/to/karazhan/scripts/codex_progress.py enable --interval 7200
```

`status` shows the default or saved preference in `auto_start` and activation in `enabled`. `disable` also works before the first session. `enable` clears the opt-out and can use `CODEX_THREAD_ID` or an explicit `--thread`. Use `--database` for an explicit database path and `--workspace` for a specific Workspace. To change an active interval or switch main threads, disable the job and enable it with the new settings.

Provisioning uses the timer bundled in `.agents/skills/workspace-provisioning/scripts/`. In an older Workspace, run the timer's `install-hook` command once to merge its hooks with existing Codex settings. Review the hooks in Codex when prompted. For an already running session, `startup` applies the default immediately and honors a saved opt-out. A new binding starts at the current end of the conversation. If Codex first makes the history available at the end of a turn, the hook includes that turn. [Codex hook events and trust](https://developers.openai.com/codex/hooks/)

The per-Work LaunchAgent runs while the macOS user is logged in, including when the Karazhan window is closed. The job reads its paths from the private `.workbench/codex-progress.json`. A Workspace lock serializes timer and manual `run` invocations. If Karazhan is offline, the timer keeps recording local facts. The next run checks uncertain events before replaying an identical request. After an explicit revision rejection it checks for the event, obtains the current revision and records a new request with a separate key. A confirmed write awaiting verification only needs another query. `status` reports the pending count and last error. Disable removes the LaunchAgent and retains local recovery records.

## Installation and updates

The [README](../README.md#install-from-source) describes supported source installation. The installer builds the current clean, complete checkout. Managed versions use Tauri's major/minor and the reachable commit count as patch. Record the source commit and content baseline per target. Higher versions update, equal versions are a no-op, missing targets can be restored, and downgrades are rejected. Locally changed managed files and conflicting existing MCP configuration stop installation. Back up unversioned targets before adoption.

Install the App under `~/Applications`, binaries under `~/.local/bin`, and selected Medivh files under `~/.hermes/profiles/medivh`. Only the two required MCP configuration leaves are filled when missing; unrelated settings remain user-owned. Memories, sessions, and other Skills are not replaced or baselined. `memories/USER.md` in the repository is only a reference template. `KARAZHAN_INSTALL_SKIP_APP=1` skips the App and continues with MCP and Medivh. The installer does not pull source or configure model credentials.

Check cmux and Zed before build/download work. Find the CLI on `PATH` or the App in `/Applications` or `~/Applications`. For cmux, distinguish an App without a reachable CLI and explain that Claude notifications need the CLI and a running cmux session. For Zed, an App is sufficient; its CLI is optional. Missing dependencies produce a warning with affected functionality and official installation instructions. Continue installation. Do not install either dependency, launch them, or edit `PATH` automatically.

Network commands inherit standard proxy environment variables. `KARAZHAN_INSTALL_PROXY` is an optional override for installer network subprocesses. No fixed loopback proxy is the default, and no global proxy configuration changes.

Normal release builds avoid a repository-local launchable `.app`. Installation bundles in a temporary target and retains one installed App, avoiding duplicate bundle IDs. The `medivh` launcher checks its profile process and PID lock before starting `hermes -p medivh chat`. It refuses duplicate active launches and clears only its own stale lock.

### Existing Agent scaffold updates

See [the scaffold update workflow](scaffold-updates.md) for commands, private preview files, candidate review, and failure handling.

The scaffold-only Node updater prepares a private preview without building, installing, calling a model API, or restarting Agents. `prepare --out <private-directory>` discovers Project and Task Workspace bindings through read-only Karazhan queries, verifies local manifests, and follows known Workspace children and explicit index paths to find unregistered local work. Discover Medivh from installation information and the default Profile location. Optional `--workspace` and `--medivh-profile` select explicit targets. Report missing or conflicting targets. Do not create absent Workspaces or scan the whole home directory. Deduplicate canonical paths and stable identities.

Prepare stores source snapshots, target baselines, requirement references, and proposed changes. The executing LLM composes AGENTS.md candidates from existing instructions, new source material, and business requirements, then reviews the diff. Automatic merge output is advisory. The script does not call a model. `apply --plan <private-directory>` handles only prepared targets and reviewed candidates. Recheck identity and source/target baselines, back up managed files, and restore a failed target on error. Reapplying the same update is a no-op. Retain source and installed baselines for later updates.

After prepare, present a target checklist and wait for the user to finish selecting before LLM composition. Each checkbox means skip that Project, Task, or Medivh Workspace only; it does not implicitly exclude descendants. Apply consumes the saved checklist. Do not review, validate, back up, or write skipped targets. Their conflicts do not block selected targets. All skipped is a successful no-op. A missing or malformed checklist on a new preview stops apply; legacy previews remain supported.

When a selected managed Skill has local changes, the executing Agent can explicitly review and merge it into a per-target candidate. Record the original checksum, candidate checksum, action, and review notes. Apply accepts that resolution only for prepared managed paths and unchanged target content. Retiring an unverified old presentation Skill needs an explicit reviewed removal tied to its current checksum. Preserve the old content in the private backup. Do not clear conflict records to bypass ownership checks; unreviewed conflicts still stop apply.

Preserve identity, Context, logs, repositories, Hooks, custom Skills, and Medivh memories, sessions, and unrelated configuration. Retire only verified unmodified managed answer-me-with-html copies. Modified or uncertain copies are conflicts. Preserve generated HTML and historical backups. Existing generated AGENTS.md files use the LLM workflow; the installer preserves them and reports pending scaffold updates while maintaining App/MCP. Fresh installations use canonical scaffolds. This delivery develops and tests the capability without updating live Profiles or Workspaces.

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


## Local HTML notes extension

The independent `extensions/local-html-notes` component edits UTF-8 local HTML. On macOS Edge, Save uses an installed Native Messaging helper to overwrite the current report without a file picker, including the first save. Install the helper once for the exact extension ID. It runs for one request and exits, with no Agent, model, server or open network port. The background worker derives the target from the sending top-level file tab, obtains a session-bound snapshot, and sends only that URL, its expected SHA-256 and the serialized HTML. The host accepts only existing regular UTF-8 `.html` files, refuses symlinks, detects external changes, serializes writes with a temporary lock and replaces through a temporary file. Preserve file permissions, clean temporary files on ordinary failure, and keep unsaved annotations after failure. A missing helper gives an installation message rather than opening a picker or silently downloading a copy. Browsers without Native Messaging retain the previous explicit file-authorization flow. Existing conversation data and the report scripts stay compatible. See the component [README](../extensions/local-html-notes/README.md).

The HTML notes editor also saves with Ctrl+S or Cmd+S, suppressing the browser Save As action. Every 30 seconds, save only when submitted annotations have unsaved changes and no write is running. Unsubmitted comment drafts stay in the input box. Reuse the same conflict checks and file writer. After a failure, pause automatic saves until a successful manual save or page reload. Never open an authorization tab from the timer. Background-tab timers can be delayed by the browser.


## Delegated MCP registration and synchronization

For ordinary Codex conversation progress, an enabled timer acts as the delegated executor for its pinned thread. The following workflow covers other authorized operations and Workspaces that use foreground delegation.

After durable local work exists, the primary Medivh or Custodian delegates an authorized MCP operation, its prerequisite queries and independent verification to one subagent. The runtime's native subagent tool starts this work; a Skill provides instructions, not an event listener or scheduler. The primary Agent continues independent work and waits only for a result needed by the next action. Same-Work writes run serially, and the executor does not delegate again. Preserve role permissions, provenance, revision/idempotency checks, durable pending requests and verified-result reporting. The executor only appends request/result records to the existing log; the primary Agent owns business files and handoff indexes. If no capable executor is available, retain pending work without a blocking primary-Agent write. This rule does not delegate software installation or upgrades, add an API/service, or upgrade existing Agent installations automatically.
