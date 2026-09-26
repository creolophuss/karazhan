# Project and Task Workspace contract

## Purpose

A Workspace lets a Custodian continue working without Karazhan, Medivh, or a live Parent session. It contains stable identity, instructions, navigable Context, durable progress, artifacts, and optional repository worktrees.

## Layout

```text
<task-workspace>/
├─ AGENTS.md
├─ CLAUDE.md -> AGENTS.md
├─ agent_log.md
├─ .workbench/
│  └─ task.yaml
├─ context/
│  ├─ index.md
│  ├─ requirements.md
│  └─ coordination/
│     ├─ overview.md
│     └─ decisions.md
├─ children/
└─ repos/
```

`coordination/` is needed only when the work owns direct Children. `repos/` is needed only for development work. Do not create empty structure merely for symmetry.

## Stable manifest

Create `.workbench/task.yaml` from [`../assets/task.yaml`](../assets/task.yaml). It records local Project/Task identity and optional repository worktrees without contacting Karazhan. The stable `work.id` is later used unchanged by the owning Custodian when it creates the corresponding Karazhan node. The manifest does not contain current status, priority, blocker, Today order, credentials, narrative progress, or Agent Run state.

Never change a work ID after creation. Existing paths and differing instruction files are conflicts, not permission to overwrite.

Keep the existing `goal` and `acceptance_criteria` fields for compatibility, but label them with their requirements source/version in YAML comments. They are initialization summaries, not independently maintained current requirements. No schema or Karazhan wire-contract change is implied.

## Requirements authority

For every new independent Custodian Workspace, create a short `context/requirements.md` from [`../assets/requirements.md`](../assets/requirements.md). It owns the local goal, scope, and acceptance criteria. Record its version and applicable upstream owner/version references. Local requirements may refine upstream constraints but cannot relax them or expand permissions.

`AGENTS.md` owns working rules and safety boundaries; its goal/acceptance sections refer to requirements or explicitly label source-version summaries. `context/index.md` owns navigation and adopted-input references. Reading order is not override precedence. Report inconsistencies to the relevant owner and pause only affected work; do not silently resolve conflicting instructions by choosing the last file read.

Retain recoverable versions of requirements when they become shared inputs, following [context-and-coordination.md](context-and-coordination.md). Ordinary drafts need no release infrastructure. Existing Workspaces remain under their original contracts; no automatic field removal, history rewrite, or migration is authorized.

## Instructions and log

Compose `AGENTS.md` using [`../assets/custodian-AGENTS.md`](../assets/custodian-AGENTS.md) as shared instruction material plus references to requirements and the specific repositories, validation procedure, and safety boundaries. It is not an immutable file to copy over existing instructions. `CLAUDE.md` may be a symlink to the resulting file when required by the local convention.

`agent_log.md` is append-only. Each milestone records what changed, the result, evidence, next step, and blocker. It is the durable handoff between independent sessions and the input to later Karazhan synchronization.

At milestones and deliberate handoffs, append a complete handoff with a stable record ID: adopted requirement/constraint versions, applied decisions, artifact releases and confirmations, unresolved issues, pending proposals, next action, and evidence. Update only the locator in the index. Ordinary progress entries need not repeat this snapshot.

On recovery, read the latest complete handoff plus all later entries, check upstream changes, and verify actual artifacts and unfinished operations. If the pointer is missing or stale, find the latest complete record in this Workspace's log; if none exists, reconstruct from available local evidence and record uncertainty. A crash may leave changed files without a corresponding log entry; do not infer completion or blindly repeat side effects. See [context-and-coordination.md](context-and-coordination.md) for record examples.

Assume one primary writer per Workspace. A Parent owns the initial Child skeleton only until handover; its writable area excludes Child-owned nested Workspaces. The protocol supplies no concurrent-writer protection or independent current-status file.

## Repository worktrees

Before creating a worktree, inspect the source repository, branch/worktree list, dirty state, exact base revision, and destination. Network fetches, branch changes, remote pushes, merges, and destructive cleanup require their own authority.

Record source, worktree path, branch, and full base revision in the manifest. A non-development Task can use a normal directory and must not receive a meaningless Git repository.

## User-controlled startup

Provisioning stops after filesystem verification. It does not start a Custodian. When the user later starts the Project/Task Custodian, the working directory should be the Workspace rather than a nested repository so local instructions and Context are discoverable.

- stable local work ID;
- authoritative goal and acceptance in `context/requirements.md`;
- Context entry point and Parent constraints;
- allowed repositories/resources;
- verification expectations;
- the file-first reporting and append-only log rules.

Karazhan availability is not a Workspace-creation or Custodian-startup prerequisite.
