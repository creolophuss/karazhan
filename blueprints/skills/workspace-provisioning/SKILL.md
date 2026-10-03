---
name: workspace-provisioning
description: Create or repair a local Project or Task Workspace using the Karazhan solution's filesystem contract. Use for stable identity, AGENTS.md, append-only logs, hierarchical Context, coordination files, Child directories, and optional repository worktrees. This skill never calls Karazhan or starts a Custodian.
---

# Workspace Provisioning

## Boundary

This is a filesystem-only skill. It may be used by Medivh to prepare a top-level Project or by an authorized Parent Custodian to prepare a Child Project/Task. It never calls MCP and never starts, assigns, monitors, or closes a Custodian.

## Child creation gate

Create a Child Workspace only when work needs an independent owner, acceptance, recovery, or an explicit parallel boundary. Explain the boundary and benefit before splitting, and do not automatically create an unauthorized Child. Search, design, coding, and testing steps stay in the current task; an independently accepted deliverable with its own recovery needs is suitable for a Child.

## Before writing

Establish the kind (`project` or `task`), title, goal, acceptance criteria, stable UUID, Parent identity when applicable, Context requirements, and repository requirements. A precise path supplied by the user in the current task satisfies target confirmation; do not ask again for an already explicit independent-directory choice. Ask only when the path is missing or ambiguous, contents conflict, or write permission is insufficient. A supplied path authorizes neither overwriting content nor broader filesystem access. For a Child with no expressed layout choice, ask whether the user wants an explicit independent target directory; use that path when supplied, otherwise fall back to `<parent-workspace>/children/<child>`. A logical Parent/Child relationship does not require physical nesting and does not grant write access to an external target.

For applicable upstream inputs, identify the owner, adopted version, recoverable content location, and change-check entry point. Inspect the exact target, its filesystem Parent, the logical Parent Workspace when applicable, existing instruction files, symlinks, repositories, branches, worktrees, and dirty state.

Stop on identity or content conflicts. An existing path is not permission to overwrite it.

## Provision

Read the minimum required sections; the full local package remains installed:

- Always: [workspace contract](references/workspace-contract.md#purpose) — Purpose, Layout, Child creation gate, Target placement, Custodian Skill package, Stable manifest, Requirements authority, Instructions and log, User-controlled startup; [Context contract](references/context-and-coordination.md#required-index-content) — Why Context is hierarchical, Required index content, Discovery order, Complete handoff and recovery. These retain identity, paths, permissions, conflict protection, file contracts, and recovery even for a standalone leaf.
- Applicable upstream constraints: [Downward changes and checkpoints](references/context-and-coordination.md#downward-changes-and-checkpoints) and [Upward findings and adoption](references/context-and-coordination.md#upward-findings-and-adoption).
- Shared delivery or dependency: [Releases and consumption](references/context-and-coordination.md#releases-and-consumption).
- Direct Children: [Sibling discovery](references/context-and-coordination.md#sibling-discovery), [Coordination ownership](references/context-and-coordination.md#coordination-ownership), and Downward changes and checkpoints (including propagation).
- Legacy Workspace: [Phase 2.5 compatibility](references/context-and-coordination.md#phase-25-compatibility).
- Repository/worktree work: [Repository worktrees](references/workspace-contract.md#repository-worktrees).

Use the files in [`assets/`](assets/) as starting material for generated Workspace files:

- fill [`assets/requirements.md`](assets/requirements.md) with the authoritative local goal, scope, acceptance, version, and applicable upstream constraints;
- read [`assets/custodian-AGENTS.md`](assets/custodian-AGENTS.md), then compose the target `AGENTS.md` with references to requirements plus the repositories, validation procedure, and safety boundaries; any goal/acceptance summary must identify its source version; do not blindly replace existing instructions;
- fill [`assets/task.yaml`](assets/task.yaml) and [`assets/context-index.md`](assets/context-index.md) with stable local values;
- use [`assets/coordination-overview.md`](assets/coordination-overview.md) and [`assets/coordination-decisions.md`](assets/coordination-decisions.md) only when direct Children make coordination necessary.

Prefer the repository's existing validation guide. If none exists, add a short validation section to generated `AGENTS.md`: execution directory, verified environment and preparation commands, minimum validation command, and conditions for expanding checks. Keep existing required project checks. Reuse a result only when it identifies the actual content version, environment, command, and coverage and still covers acceptance. Rerun when relevant code, tests, dependencies, configuration, or external conditions change, or existing evidence is insufficient. A log saying only “passed” is insufficient; record evidence in the existing log, without a separate report for each check.

Install the complete Custodian startup package into the target Workspace's `.agents/skills/`. A Medivh installation copies from `$HERMES_HOME/packages/custodian-startup-kit/.agents/skills/`; an authorized Parent Custodian copies from its own Workspace `.agents/skills/`. The source must contain complete `workspace-provisioning` and `karazhan-mcp-collaboration` directories plus `PACKAGE.md` with recoverable version evidence. Stop if the source is missing, incomplete, locally conflicted, or not tied to a recorded version; do not fall back to user-global Skills or an undocumented repository-relative path.

Create only what the work needs:

1. `.agents/skills/` with complete `workspace-provisioning` and `karazhan-mcp-collaboration` directories plus `PACKAGE.md` package-version evidence;
2. `.workbench/task.yaml` with stable local identity;
3. `AGENTS.md` appropriate to the owning Custodian;
4. `CLAUDE.md -> AGENTS.md` only when the local convention requires it;
5. an append-only `agent_log.md`;
6. `context/requirements.md` for each new independent Custodian Workspace, including top-level Projects;
7. `context/index.md` with explicit absolute Workspace paths, stable Work IDs, Parent and direct-Child navigation, applicable ancestor constraints, adopted versions, change-check entry points, and a latest complete handoff pointer (`None` until one exists);
8. `children/` only when nested Child fallback or local organization requires it;
9. `context/coordination/` only after direct Children exist;
10. `repos/` only for real development work with an inspected repository baseline.

Even a leaf Child must check explicitly referenced upstream decisions. Do not create local coordination merely to read the Parent's decisions. Only inputs actually shared need retained versions; do not version every draft or create empty release directories. Preserve legacy Workspaces under their existing contracts rather than migrating fields, links, or logs during provisioning/repair.

The local `work.id` is generated before any MCP call and is intended to become the same Karazhan node ID when the responsible Custodian registers the work.

## Finish

Verify the user-confirmed target path, installed Skill package completeness/version, identity, links, YAML syntax, the single requirements authority, source/version labels on summaries, recoverable input versions, upstream decision entry points, and the handoff pointer. For a non-nested Child, verify both the Child's Parent entry and the Parent's direct-Child entry use the same Work IDs and explicit paths. An unavailable or unconfirmed input must be identified as pending, not adopted or ready to consume. Verify that no existing content changed unexpectedly. Report the Workspace path and files created. Do not start a Custodian or perform Karazhan registration as a side effect.
