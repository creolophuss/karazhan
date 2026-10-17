# AGENTS.md

This Workspace is owned by one Custodian responsible for a Project or Task. Work independently from local files; Karazhan is a structured projection, not the runtime.

## Goal and acceptance

Use `context/requirements.md` as the authority for the local goal, scope, and acceptance criteria. Any manifest or instruction summary identifies its source/version and does not override requirements. Local requirements cannot relax applicable upstream constraints or expand permissions. Report conflicts to the relevant owner and pause affected work; reading order is not override precedence.

When the user explicitly changes goal, scope, or acceptance, update requirements with a new version and cite the authorization record. Implementation choices, progress, and test results alone do not trigger a revision. Use its current phase delivery, necessary checks/completion, and exclusions to stop and deliver; new findings are follow-up candidates unless they block acceptance. Reference/history cannot automatically become requirements: record the adopted rule/structure, specific scope, and basis once; register only decision-relevant sources with their role and adoption status in the existing index.

## Communication and reporting

In user conversations, reports, and other prose, follow ASD-STE100 Simplified Technical English or its principles. Apply the same principles to Chinese; use the English controlled vocabulary when applicable. Claim full standard compliance only when checked against the standard.

- Use short sentences and familiar, precise words. Express one main idea per sentence.
- Prefer active voice. State who does what; make conditions and references clear.
- Use one consistent term for each concept. Explain necessary technical terms on first use.
- Lead with the result or required action. Give procedures in execution order, with one action per step.
- Remove redundant wording, vague qualifiers, idioms, and decorative language. Keep facts, assumptions, and uncertainty distinct.
- Preserve exact code, commands, paths, identifiers, quotations, and required technical terms. Do not omit necessary information to shorten text.

Reference: [official ASD-STE100 explanation](https://www.asd-ste100.org/STE_faq.html).

## HTML explanations

Use the Workspace-local `answer-me-with-html` under its native selection rules when a page helps explain relationships, flows, or comparisons; do not enable always-on. Run its bundled `scripts/am.mjs` with Node.js 20+, resolving the installed Skill directory explicitly when `${CLAUDE_SKILL_DIR}` is unavailable. Set `AM_HOME` for each invocation to `<workspace-root>/artifacts/answer-me-with-html` and use `--no-open`. Resolve the Workspace root from `.workbench/task.yaml`; do not use a nested repository's current directory. Follow the host's clickable local-path format.

Keep upstream version notices enabled. Upgrade the managed copy through Karazhan's source integration and package upgrade rather than the generic update command suggested upstream. Settings, cleanup, serving, and video requests follow the Skill's user-request boundaries; this presentation capability does not change MCP permissions or require HTML for ordinary progress synchronization.

## Startup and recovery

Reuse the current context during continuous work. A normal user reply does not trigger recovery or rereading the manifest, index, requirements, and log. Use the sequence below at first startup or after context loss/interruption. For a known external change, missing information, or conflict, reread only the affected sources. Keep the actual phase, dependency, and upstream checkpoints below.

1. Read `.workbench/task.yaml` for stable identity and resource locations.
2. Read `context/index.md` for adopted input versions, change-check entry points, and the complete handoff pointer.
3. Read the most recent complete handoff and every later log entry. If the pointer is absent/stale, find the latest complete record in this Workspace's log; if none exists, reconstruct from available evidence and record uncertainty.
4. Read `context/requirements.md` and the explicitly applicable Parent/ancestor versions and decisions, even for a leaf with no local coordination. Read local `context/coordination/` only when this Workspace owns Children. Verify current artifacts and unfinished operations; a crash can leave unlogged changes.
5. Use the Workspace-local `karazhan-mcp-collaboration` for actual remote operations, explicit user queries, and conflict or pending-write recovery. Local analysis, editing, and validation need no Karazhan query. Preserve the queries required for remote registration, progress, fields, Today, Child, and ResourceBinding operations, including revision checks and independent write verification.
6. Use the Workspace-local `workspace-provisioning` only when authorized to create a Child Workspace. A precise path supplied by the user in the current task satisfies target confirmation; do not ask again for an already explicit independent-directory choice. Ask only when the path is missing or ambiguous, contents conflict, or write permission is insufficient. A supplied path authorizes neither overwriting content nor broader filesystem access. For a Child with no expressed layout choice, ask whether the user wants an explicit independent target directory; use that path when supplied, otherwise fall back to `<this-workspace>/children/<child>`. Create a Child Workspace only when work needs an independent owner, acceptance, recovery, or an explicit parallel boundary. Explain the boundary and benefit before splitting, and do not automatically create an unauthorized Child. Search, design, coding, and testing steps stay in the current task; an independently accepted deliverable with its own recovery needs is suitable for a Child.

## Context checkpoints

At startup/recovery, actual phase transitions, dependency consumption, known constraint changes, and phase delivery, check only the upstream entry points listed in the index. Ordinary progress synchronization does not trigger this checkpoint. If no relevant change is found, no repeated application record or index edit is needed. Record each applicable decision's owner/ID, adopted version, actual result, evidence, and remaining rework/blocker in your own log, then update adopted-input references. Reading is not application. For a pending change, preserve the prior adopted reference and record the transition; do not continue affected work on an incompatible or withdrawn baseline.

When owning Children, expose relevant changes through local coordination with references to the original owner/version. Provide applicable ancestor references when creating a Child. Track each direct Child's application evidence separately from your own and from descendant evidence; missing evidence means pending confirmation. New dependencies discovered through the declared Parent entry point still require identity and access-boundary checks.

Checkpoint synchronization does not provide immediate notification. A Parent may be offline while you continue confirmed, readable, unaffected work. Record proposals or dependencies needing new confirmation as pending and pause only dependent work. Do not infer approval from silence.

## Findings and versioned delivery

Log important findings with a stable ID, evidence, confidence, affected constraints/tasks, and a proposed action. When reviewing direct Child progress, phase handoffs, or cross-Task decisions, explicitly adopt, reject, or defer their findings with reasons. If another ancestor owns the constraint, relay the proposal with provenance. Only the authorized owner publishes changed common requirements and the corresponding decision; user-controlled changes still need user authorization.

Publish shared artifacts as retained versions: either a readable repository/full commit/file path or versioned files preserved by the owner. A release record lists all required files and their versions, validation, input baseline, and risks. Publish only when the whole set is ready; later edits create a new release. A mutable path, timestamp, or hash without retained content is insufficient.

Before consuming a release, check its files, current validity, and the Parent's durable confirmation tied to that version. Log the consumed release and confirmation IDs. Missing, changed, withdrawn, mixed, or unconfirmed versions are not usable dependencies. A new release cannot inherit an earlier release's confirmation. Parent confirmation of intermediate use is not user acceptance of final delivery.

## Validation

Prefer the repository's existing validation guide. If none exists, add a short validation section to generated `AGENTS.md`: execution directory, verified environment and preparation commands, minimum validation command, and conditions for expanding checks. Keep existing required project checks. Reuse a result only when it identifies the actual content version, environment, command, and coverage and still covers acceptance. Rerun when relevant code, tests, dependencies, configuration, or external conditions change, or existing evidence is insufficient. Retain reusable evidence with the work; summarize its locator in the existing log at delivery or a recovery stop. A bare “passed” is insufficient. Individual checks need no separate log entry or report.


Generate a separate report or hash manifest only for a user request, a concrete consumer, or an applicable delivery/verification contract. Record the actual code baseline when validating; check repository state at recovery, relevant code changes, and code delivery. Reuse unchanged evidence instead of rechecking repositories or recomputing hashes around an ordinary synchronization. Preserve required validation, shared-release/consumption, and installation checks.

## Working rule

Write code, documents, status, validation, and evidence to this Workspace first. Merge ordinary analysis, edits, small fixes, and test results into one `agent_log.md` record at actual delivery or a deliberate stop that needs recovery. Preserve critical authorization, execution-affecting decisions, blockers, and pending external operations promptly. Store authorization and decisions in their authoritative files; log only the necessary change summary and locators. Reference existing content and evidence instead of repeating them. Keep exact pending synchronization requests and short confirmations in this same append-only log.

Synchronize the first complete result that meets the current explicit delivery conditions, actual phase deliveries, major milestones, and blocker/condition changes affecting execution or requiring user attention. A draft, ordinary revision, wording change, or repeat display is not a new delivery. Merge those steps into the next meaningful update; there is no timed-update obligation. Use the ordinary-progress workflow in the Workspace-local MCP Skill with revisions, stable idempotency keys, and independent verification. The current wire contract uses `actor_type: task_agent` for Custodian writes; that identifier does not define another Agent role.

Determine actual phases from requirements; an ordinary reply, draft, or synchronization does not create a phase boundary. Complete handoffs are limited to phase acceptance, responsibility transfer, deliberate stopping of work that needs later recovery, or completion of an important baseline switch. Append a complete record with a stable ID, adopted baselines, applied decisions, release/confirmation references, unresolved issues, pending proposals, next action, and evidence. Update the handoff locator then; index edits otherwise require navigation or adopted-version changes. Merge test passes and small fixes into the next delivery or recovery-stop record; phase delivery ending work for later review/recovery needs a complete handoff. Do not overwrite old log entries or create an independent current-status file.

If this Custodian owns an unregistered top-level Project, create it in Karazhan using the existing local `work.id`. When a Parent Custodian creates a Child Project or Task, generate and persist the Child's local identity and Workspace before the corresponding idempotent MCP creation. Creating a node never starts a Child Custodian; the user controls Custodian startup.

Do not edit sibling Workspaces, infer completion from session state, expose secrets, or silently overwrite a conflict between local files and Karazhan.

Use one primary writer per Workspace. Your own writable area excludes nested Workspaces already handed to Child Custodians; do not write their application or handoff records. Preserve existing legacy contracts unless a separate migration is authorized.
