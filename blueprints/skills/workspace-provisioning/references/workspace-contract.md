# Project and Task Workspace contract

## Purpose

A Workspace lets a Custodian continue working without Karazhan, Medivh, or a live Parent session. It contains stable identity, instructions, navigable Context, durable progress, artifacts, and optional repository worktrees.

## Layout

```text
<task-workspace>/
├─ .agents/
│  └─ skills/
│     ├─ PACKAGE.md
│     ├─ workspace-provisioning/
│     └─ karazhan-mcp-collaboration/
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

## Child creation gate

Create a Child Workspace only when work needs an independent owner, acceptance, recovery, or an explicit parallel boundary. Explain the boundary and benefit before splitting, and do not automatically create an unauthorized Child. Search, design, coding, and testing steps stay in the current task; an independently accepted deliverable with its own recovery needs is suitable for a Child.

## Target placement

A precise path supplied by the user in the current task satisfies target confirmation; do not ask again for an already explicit independent-directory choice. Ask only when the path is missing or ambiguous, contents conflict, or write permission is insufficient. A supplied path authorizes neither overwriting content nor broader filesystem access. For a Child with no expressed layout choice, ask whether the user wants an explicit independent target directory; use that path when supplied, otherwise fall back to `<parent-workspace>/children/<child>`. For a non-nested Child, record explicit absolute Workspace, Context, and index paths in both sides' `context/index.md`.

Logical Parent/Child relationships are defined by stable Work IDs and the two indexes, not by physical nesting. A logical relationship never grants write access to an external target. Inspect the target and its filesystem Parent separately from the logical Parent Workspace, and stop on existing identity, ownership, content, or symlink conflicts.

## Custodian Skill package

Every new independent Custodian Workspace contains complete project-local `.agents/skills/workspace-provisioning/` and `.agents/skills/karazhan-mcp-collaboration/` directories. Copy the whole versioned package, including each Skill's `SKILL.md`, `agents/`, `references/`, and `assets/` where present, plus `.agents/skills/PACKAGE.md` evidence that identifies the source repository, full commit, source state, and content digest.

Medivh obtains the package from `$HERMES_HOME/packages/custodian-startup-kit/.agents/skills/`, which is deliberately outside its discoverable `skills/` directory. An authorized Parent Custodian uses its own Workspace-local `.agents/skills/` as the source for a Child. Never substitute a user-global Skill installation, a mutable symlink, or an undocumented source checkout path. Existing Workspace packages are updated only through a separately reviewed operation; provisioning does not silently replace them.

## Stable manifest

Create `.workbench/task.yaml` from [`../assets/task.yaml`](../assets/task.yaml). It records local Project/Task identity and optional repository worktrees without contacting Karazhan. The stable `work.id` is later used unchanged by the owning Custodian when it creates the corresponding Karazhan node. The manifest does not contain current status, priority, blocker, Today order, credentials, narrative progress, or Agent Run state.

Never change a work ID after creation. Existing paths and differing instruction files are conflicts, not permission to overwrite.

Keep the existing `goal` and `acceptance_criteria` fields for compatibility, but label them with their requirements source/version in YAML comments. They are initialization summaries, not independently maintained current requirements. No schema or Karazhan wire-contract change is implied.

## Requirements authority

For every new independent Custodian Workspace, create a short `context/requirements.md` from [`../assets/requirements.md`](../assets/requirements.md). It owns the local goal, scope, and acceptance criteria. Record its version and applicable upstream owner/version references. Local requirements may refine upstream constraints but cannot relax them or expand permissions.

`AGENTS.md` owns working rules and safety boundaries; its goal/acceptance sections refer to requirements or explicitly label source-version summaries. `context/index.md` owns navigation and adopted-input references. Reading order is not override precedence. Report inconsistencies to the relevant owner and pause only affected work; do not silently resolve conflicting instructions by choosing the last file read.

Describe the current phase in requirements: delivery, necessary verification/completion, and excluded work. When the user explicitly changes goal, scope, or acceptance, issue a new requirements version with its authorization record; ordinary implementation choices, progress, and test results do not trigger a revision. Deliver once phase conditions are met; new findings remain follow-up candidates unless they block acceptance.

Retain recoverable versions of requirements when they become shared inputs, following [context-and-coordination.md](context-and-coordination.md). Ordinary drafts need no release infrastructure. Existing Workspaces remain under their original contracts; no automatic field removal, history rewrite, or migration is authorized.

## Instructions and log

Compose `AGENTS.md` using [`../assets/custodian-AGENTS.md`](../assets/custodian-AGENTS.md) as shared instruction material plus references to requirements and the specific repositories, validation procedure, and safety boundaries. It is not an immutable file to copy over existing instructions. `CLAUDE.md` may be a symlink to the resulting file when required by the local convention.

Prefer the repository's existing validation guide. If none exists, add a short validation section to generated `AGENTS.md`: execution directory, verified environment and preparation commands, minimum validation command, and conditions for expanding checks. Keep existing required project checks. Reuse a result only when it identifies the actual content version, environment, command, and coverage and still covers acceptance. Rerun when relevant code, tests, dependencies, configuration, or external conditions change, or existing evidence is insufficient. A log saying only “passed” is insufficient; record evidence in the existing log, without a separate report for each check.

`agent_log.md` is append-only. Each milestone records what changed, the result, evidence, next step, and blocker. It is the durable handoff between independent sessions and the input to later Karazhan synchronization.

Complete handoffs are limited to phase acceptance, responsibility transfer, deliberate stopping of work that needs later recovery, or completion of an important baseline switch. Append a complete handoff with a stable record ID: adopted requirement/constraint versions, applied decisions, artifact releases and confirmations, unresolved issues, pending proposals, next action, and evidence. Update the handoff locator then; otherwise update the index only for navigation or adopted-version changes. Passing a test or completing a small fix is ordinary progress: append only new facts, without a full snapshot. Phase delivery that ends work for later review/recovery requires a complete handoff. Synchronize MCP at progress points meaningful to the user, not after every log entry.

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
