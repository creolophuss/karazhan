# AGENTS.md

This Workspace is owned by one Custodian responsible for a Project or Task. Work independently from local files; Karazhan is a structured projection, not the runtime.

## Goal and acceptance

Use `context/requirements.md` as the authority for the local goal, scope, and acceptance criteria. Any manifest or instruction summary identifies its source/version and does not override requirements. Local requirements cannot relax applicable upstream constraints or expand permissions. Report conflicts to the relevant owner and pause affected work; reading order is not override precedence.

## Startup and recovery

1. Read `.workbench/task.yaml` for stable identity and resource locations.
2. Read `context/index.md` for adopted input versions, change-check entry points, and the complete handoff pointer.
3. Read the most recent complete handoff and every later log entry. If the pointer is absent/stale, find the latest complete record in this Workspace's log; if none exists, reconstruct from available evidence and record uncertainty.
4. Read `context/requirements.md` and the explicitly applicable Parent/ancestor versions and decisions, even for a leaf with no local coordination. Read local `context/coordination/` only when this Workspace owns Children. Verify current artifacts and unfinished operations; a crash can leave unlogged changes.
5. Use `karazhan-mcp-collaboration` for registration, queries, progress, field updates, or Child creation.
6. Use `workspace-provisioning` only when authorized to create a Child Workspace.

## Context checkpoints

At startup/recovery, phase or milestone transitions, dependency consumption, and final delivery, check only the upstream entry points listed in the index. Record each applicable decision's owner/ID, adopted version, actual result, evidence, and remaining rework/blocker in your own log, then update adopted-input references. Reading is not application. For a pending change, preserve the prior adopted reference and record the transition; do not continue affected work on an incompatible or withdrawn baseline.

When owning Children, expose relevant changes through local coordination with references to the original owner/version. Provide applicable ancestor references when creating a Child. Track each direct Child's application evidence separately from your own and from descendant evidence; missing evidence means pending confirmation. New dependencies discovered through the declared Parent entry point still require identity and access-boundary checks.

Checkpoint synchronization does not provide immediate notification. A Parent may be offline while you continue confirmed, readable, unaffected work. Record proposals or dependencies needing new confirmation as pending and pause only dependent work. Do not infer approval from silence.

## Findings and versioned delivery

Log important findings with a stable ID, evidence, confidence, affected constraints/tasks, and a proposed action. When reviewing direct Child progress, phase handoffs, or cross-Task decisions, explicitly adopt, reject, or defer their findings with reasons. If another ancestor owns the constraint, relay the proposal with provenance. Only the authorized owner publishes changed common requirements and the corresponding decision; user-controlled changes still need user authorization.

Publish shared artifacts as retained versions: either a readable repository/full commit/file path or versioned files preserved by the owner. A release record lists all required files and their versions, validation, input baseline, and risks. Publish only when the whole set is ready; later edits create a new release. A mutable path, timestamp, or hash without retained content is insufficient.

Before consuming a release, check its files, current validity, and the Parent's durable confirmation tied to that version. Log the consumed release and confirmation IDs. Missing, changed, withdrawn, mixed, or unconfirmed versions are not usable dependencies. A new release cannot inherit an earlier release's confirmation. Parent confirmation of intermediate use is not user acceptance of final delivery.

## Working rule

Write code, documents, status, validation, and evidence to this Workspace first. Append milestone facts to `agent_log.md`. Only then synchronize the user-facing subset through Karazhan MCP with revisions and stable idempotency keys. The current wire contract uses `actor_type: task_agent` for Custodian writes; that identifier does not define another Agent role.

At milestones and deliberate handoffs, append a complete record with a stable ID, adopted baselines, applied decisions, release/confirmation references, unresolved issues, pending proposals, next action, and evidence. Update only the handoff locator in the index; ordinary progress entries need not repeat this full record. Do not overwrite old log entries or create an independent current-status file.

If this Custodian owns an unregistered top-level Project, create it in Karazhan using the existing local `work.id`. When a Parent Custodian creates a Child Project or Task, generate and persist the Child's local identity and Workspace before the corresponding idempotent MCP creation. Creating a node never starts a Child Custodian; the user controls Custodian startup.

Do not edit sibling Workspaces, infer completion from session state, expose secrets, or silently overwrite a conflict between local files and Karazhan.

Use one primary writer per Workspace. Your own writable area excludes nested Workspaces already handed to Child Custodians; do not write their application or handoff records. Preserve existing legacy contracts unless a separate migration is authorized.
