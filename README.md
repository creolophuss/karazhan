# Karazhan

Karazhan is the production codebase for the local-first Agent Workbench desktop application.

The current foundation contains a shared Rust core, the complete SQLite storage structure, a serializable application contract, thin Tauri IPC, authenticated loopback HTTP, and stdio MCP adapters, plus the formal React/TypeScript and Tauri 2 desktop shell. The repository also contains the canonical Medivh filesystem blueprint and shared Custodian skills, so the local Workspace and visual product can evolve as one solution without coupling their runtimes.

## Prerequisites

- Rust 1.98.1 with `rustfmt` and `clippy`
- Node.js 26 and npm 11
- SQLite 3.45 or newer for manual database inspection

## Develop and operate

[`docs/product-requirements.md`](docs/product-requirements.md) is the repository-owned, authoritative product requirement. Revise and review that document before implementing a new or changed product requirement; historical delivery documents and requirement deltas do not override it.

The complete instructions for desktop startup, verification, database locations, safe backup/restore boundaries, MCP host configuration, and HTTP bearer-token semantics are in [`docs/development-and-operations.md`](docs/development-and-operations.md).

The acceptance matrix in [`docs/acceptance-traceability.md`](docs/acceptance-traceability.md) records the delivery-time evidence. Search, Settings/Import, and real Stage 2.5 cutover were subsequently deferred by the user and are not current MVP work.

The complete Backlog workflow is delivered. Release/distribution remains optional future work; the older proposed-Child list in [`docs/deferred-work-handoff.md`](docs/deferred-work-handoff.md) is retained as delivery-time history rather than current scheduling authority.

## Medivh

[`blueprints/medivh/`](blueprints/medivh/) is the current Hermes blueprint for the filesystem-only Medivh role. Medivh:

- creates safe top-level Project Workspace files;
- does not connect to Karazhan;
- does not create or start Agents;
- hands control back after filesystem verification.

Custodians use the separate [`karazhan-mcp-collaboration`](blueprints/skills/karazhan-mcp-collaboration/SKILL.md) skill to register and synchronize their own work. Both Medivh and authorized Parent Custodians can use [`workspace-provisioning`](blueprints/skills/workspace-provisioning/SKILL.md) for filesystem structure. Read the [role boundary](blueprints/medivh/README.md) before updating a live profile.

The complete review package and reviewer checklist are in [`docs/delivery-summary.md`](docs/delivery-summary.md).

The two most common commands are:

```sh
npm run desktop:dev
npm run check
```

For a user-local build plus installation of Karazhan, the MCP companion, and the Medivh profile, run from the repository root:

```sh
./install.sh
```

The script installs `Karazhan.app` under `~/Applications`, installs `karazhan-mcp` and the `medivh` launcher under `~/.local/bin`, and creates or safely updates `~/.hermes/profiles/medivh`. If the pinned Rust toolchain is unavailable, it first installs rustup and Rust under the standard `~/.cargo` and `~/.rustup` locations through the configured proxy. It explicitly fetches the locked Cargo dependencies through that proxy before switching the Rust builds to offline mode. The managed-component version is derived automatically as `<Tauri major>.<Tauri minor>.<reachable Git commit count>` and is injected into the app build without rewriting tracked files; each committed change therefore receives the next install version on the linear `main` history. A higher version updates components, the same version is a no-op, and a downgrade is rejected; each target records its version, source commit, and content baseline under `~/.local/share/karazhan-installer`. Installation requires complete Git history and no tracked uncommitted changes. Existing unversioned managed targets are backed up before initial adoption. `memories/USER.md`, all other memories, sessions, and non-managed Skills remain user-owned and are never replaced or removed. Set `KARAZHAN_INSTALL_SKIP_APP=1` to build/install the MCP and Medivh package without requiring or changing the app bundle. The installer never runs `git pull`. The `medivh` command checks for an active Medivh profile process and a launcher lock before starting `hermes -p medivh chat`.

Read the operations guide before using the product database. In particular, do not copy an active WAL database; explicit backup/restore currently exists only as validated Rust core APIs, and the stock desktop does not expose its per-launch HTTP token to external processes.

## Verify

```sh
npm run check
```

The same gate is available directly as `./scripts/check.sh`. It runs Rust formatting, strict Clippy,
all Rust tests, SQLite integrity/foreign-key/domain-invariant checks, frontend tests, strict TypeScript
typechecking, and the Vite production build. Tests use only in-memory databases or temporary
directories. Run `npm install` once before the first check.

Start the desktop development application from the repository root with `npm run desktop:dev`. The product name is `Karazhan` and its bundle identifier is `com.jiayi.karazhan`. On macOS, Tauri resolves its application data directory to `~/Library/Application Support/com.jiayi.karazhan`; the product database is stored there as `karazhan.sqlite3`.

## Current slice

- numbered migration with checksum verification;
- complete v1 storage for Work Tree, typed nodes, Today, ProgressEvent, ResourceBinding, import records, and command receipts;
- typed Project/Task create, read, and ordered list commands, including path-free Project creation;
- revision-checked title, summary, goal, acceptance, status, priority, and blocker updates with an atomic ProgressEvent;
- fixed immutable system Root;
- Project, Task, and Backlog Work Tree constraints;
- sibling key and position uniqueness;
- cycle prevention;
- revision-checked, idempotent Work Tree moves with atomic parent-change events and conflict rollback;
- revision-checked, idempotent sibling reordering with full transactional rollback on failure;
- Project/Task-only Today membership;
- atomic, idempotent Today add/remove/reorder commands and their ProgressEvents, isolated from Work Tree fields;
- Today projection with shared-core ancestor title paths and Task summaries, direct-child-only expansion, and explicit-membership duplicate suppression;
- idempotent progress/delivery event append plus recent-event and full-timeline queries that never mutate current fields;
- typed ResourceBinding add/list/availability commands, including shared locators and non-destructive missing-path handling;
- nearest-ancestor Project Context path lookup that never reads or scans Context contents;
- Backlog projection with Root-hidden Parent breadcrumbs, stable sibling order, and Parent/kind/status/priority/tag filtering;
- Backlog `+` creation plus right-click Edit/Move/Promote/Discard, compact row-local Save/Cancel editing, and atomic drag ordering across Parents;
- atomic idempotent Backlog promotion to a Project or Task, retaining the source and exposing target navigation;
- Today `+` creation of one-line checkbox Quick items, backed by the shared Task model and excluded from Projects & Tasks;
- recursive Archive Reopen that restores the selected subtree and required ancestors without recreating Today membership;
- revision, idempotency, actor/channel, timestamp, and structured-error coverage across shared-core writes;
- explicit actor/channel metadata and idempotent create/update commands;
- WAL, bounded busy timeout, restart persistence, and migration rollback evidence.
- cross-process migration locking with structured `migration_busy`, plus checksum gates for every applied migration.
- pre-upgrade WAL checkpoint and verified SQLite online backup, with transactional migration fault rollback.
- validated temporary restore with integrity/FK/invariant/count gates, atomic replacement, and retained failure diagnostics.
- serde-tagged `Command`/`Query` contracts and one shared `Application` dispatcher for every future adapter;
- stable structured domain error codes, including revision and idempotency conflicts.
- two Tauri IPC commands backed by shared application state, with a reusable handler registration function and `{ code, message }` transport errors.
- `/v1/command` and `/v1/query` HTTP routes that bind only explicit loopback addresses, require a 256-bit random bearer token, validate Host and optional Origin, and preserve structured domain errors.
- one shared `Application` handle for desktop and HTTP adapters, with an exact-address bind failure that leaves desktop queries available and never falls back to another port.
- an on-demand `karazhan-mcp` binary using the official Rust MCP SDK, with generic shared-contract command/query tools and protocol-only stdout.
- cross-transport contract evidence that Tauri, HTTP, and MCP return identical domain results, error codes, and error messages for the same command.
- a real MCP Custodian workflow covering Project, parent Task, Child Task, progress, Today add/reorder/remove, and typed summary queries.
- a node-ID-only Open in Zed Tauri command that resolves primary Workspace bindings, canonicalizes trusted roots and targets, and invokes fixed-path macOS Launch Services without a shell.
- a complete Open in Zed security matrix for missing paths, non-directories, direct and symlink escapes, forged node IDs, Launch Services failures, and zero business-state mutation.
- a formal React/TypeScript + Tauri 2 desktop shell whose startup opens the shared SQLite application and wires the same core into Tauri IPC and the loopback HTTP adapter.
- one typed TypeScript client that owns all Tauri IPC command names and payload mapping, plus an architecture test that rejects direct native API access elsewhere in the React source tree.
- a compact default Today page in a 1280×860 window with the reviewed warm-gray/coral sidebar, reading persisted mixed Project/Task membership once through the shared query contract, rendering Root-hidden `Project › Task` paths and optional Task descriptions, preserving stored order, and presenting explicit loading, empty, and structured-error states.
- accessible Today chevrons only for Projects and Tasks with direct children, with independent row toggles and complete Expand all / Collapse all actions.
- leaf Task and direct Child Task checkboxes that persist `done` / `ready` immediately, while relying on the shared core to exclude deeper descendants, Child Projects, and explicit Today-member duplicates.
- compact click-to-edit Today status badges with immediate revision-safe saves; blocker text and the three latest ProgressEvents appear together under Recent steps without a separate blocker form or Save button.
- formal Today add/remove/reorder actions, a right-edge left-swipe that reveals Delete, and WKWebView-safe pointer ordering that refreshes database-assigned positions and revisions after every mutation.
- a unified Projects & Tasks tree page that preserves mixed sibling positions and renders nested Projects, Tasks, Child Tasks, and independent Tasks from one shared-core projection.
- Projects & Tasks branch and all-tree disclosure controls, indentation-only hierarchy, inline status/priority editing, and persisted Move to Today / In Today state; repeated ancestor paths, internal sibling keys, and the former large details panels are intentionally hidden after user review.
- Projects & Tasks creation from the top-level round `+` and type-aware right-click menus, with Name/Description and optional Project Path; recursive Archive semantics; and a dedicated Archive page whose confirmed permanent delete is unavailable to active nodes.
- shared-core queries for recent/full progress, nearest Project Context, ResourceBinding availability, and revision-safe field updates remain available to adapters even though the simplified Projects page no longer renders those panels.
- an Open in Zed action in Today for nodes with an available primary Workspace binding; the UI submits only the node ID and presents structured native-boundary failures.
- a fixed sidebar and independently scrolling right workspace, verified in the [user-review UI evidence](evidence/ui-review-20260924/REPORT.md).
- a recorded real-desktop vertical acceptance run covering Custodian MCP creation, Projects ingestion, Today membership, field edits, WKWebView-safe pointer reordering, normal exit, restart persistence, and independent MCP/SQLite verification.
- a read-only legacy dry-run boundary exposed through the shared query contract, requiring an explicit source root and typed relative scope, rejecting absolute/parent/symlink escapes, and producing deterministic source/report digests without writing SQLite.
- a protected-content gate that accepts only the fixed registry names, `.workbench/task.yaml`, `agent_log.md`, and Context directory locators; Context and coordination files—including in-root symlink targets—are rejected before reads and their contents never enter reports or errors.
- deterministic legacy identity planning from YAML: Project slug UUIDv5 under the frozen namespace, unchanged legacy Task UUIDs and parent chains, Root Tasks attached below their Project, and one ordinary `planned` / `none` Child Task for each non-empty `next_action`.
- deterministic conflict planning that keeps separate bindings for shared locators, creates manifest-only Task candidates, reports missing/behind log cursors, maps `waiting` to `pending` while preserving the raw value, retains promoted Backlog links, and resolves sibling key collisions with a stable UUID suffix.
- deterministic log-section identity and digest planning, replay-safe ProgressEvent sync, frozen `34 / 39 / 157 / 0` fixture coverage, atomic legacy apply with source/report preconditions, and a file-database backup/migration-fault/restore rehearsal.

The relevant pre-import legacy Python/SQLite P0 intent is mapped to native Rust evidence in `docs/prototype-p0-rust-traceability.md`; Karazhan has no Python build or runtime dependency. The real Stage 2.5 tree remains read-only and no real apply or cutover was performed; the exact boundary and deferred operations are recorded in `docs/legacy-stage-25-safety-boundary.md`.
