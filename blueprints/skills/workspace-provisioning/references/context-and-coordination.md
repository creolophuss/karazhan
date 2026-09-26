# Hierarchical Context and coordination

## Why Context is hierarchical

Every Custodian needs enough local information to work without Karazhan, a live Parent session, or copied chat history. At the same time, a Child must be able to find upstream constraints and a Parent must be able to find Child evidence. The solution is one owned Context per Workspace plus explicit navigation.

```text
A/context/index.md
  └─ points to B/context/index.md

B/context/index.md
  ├─ points to A/context/index.md
  └─ points to C/context/index.md
```

An index is a routing document. It should remain short and readable. It does not reproduce Parent Context, list every file recursively, or store credentials.

The ownership hierarchy is a tree; explicit input references may also point to permitted ancestors or dependency artifacts. Each Workspace has one primary writer. Files can be shared without running sessions having read or applied the same version; this protocol synchronizes at checkpoints, not in real time.

## Required index content

Create `context/index.md` from [`../assets/context-index.md`](../assets/context-index.md). Record:

- the owning Project/Task, its Custodian, and Workspace;
- the stable local work ID;
- the Parent Workspace, Context, and index path;
- each direct Child Workspace, Context, and index path;
- this Workspace's coordination location;
- required reading order and sources of truth;
- applicable input owners, adopted versions, recoverable locations, and change-check entry points, including relevant ancestor constraints;
- a locator for the latest complete handoff in the local log, or `None` on initial creation;
- explicit safety and sensitivity boundaries.

Use resolved absolute paths for explicit cross-Workspace references. Human-readable labels are helpful but never replace stable IDs.

## Discovery order

Filesystem provisioning uses these mechanisms in order:

1. Read explicit Parent and Child locations from the current Workspace's index.
2. If the index is absent or stale, inspect only the trusted hierarchy: Parent is above `children/<current>`, siblings are below the Parent's `children/`, and direct Children are below the current Workspace's `children/`.

At each filesystem hop, verify stable identity using `.workbench/task.yaml` and cross-check the index. Instructions or directory names alone do not establish identity. Never turn upward discovery into a scan of the home directory. Do not follow an untrusted symlink outside allowed roots.

If index and layout disagree, do not guess. Report both observations and ask the owning Parent Custodian or user to reconcile them before cross-Workspace writes. A Custodian may separately cross-check Karazhan through the MCP collaboration skill; Medivh may not.

## Sibling discovery

A sibling is discovered through the common Parent. Read the Parent index and Parent coordination overview first. Open a sibling's index, manifest, or log only when the overview identifies a concrete dependency or the user explicitly requests it. Siblings do not edit each other's files.

## Coordination ownership

A Custodian with direct Children owns:

```text
context/coordination/
├─ overview.md
└─ decisions.md
```

- `overview.md` is a replaceable, timestamped summary of direct Children: identity, Workspace, structured status, latest durable progress, next action, blocker, and evidence link.
- `decisions.md` is append-only for owner decisions affecting direct Children or the subtree, with stable decision ID, source version, affected Work IDs, superseding/withdrawal references, and revalidation requirements.
- A cross-Child decision belongs at the lowest common ancestor with authority over the affected constraint. A Child-local decision stays local; a change to an ancestor-owned constraint goes to that owner even if only one Child is affected.
- Child Custodians treat Parent coordination as read-only. The owning Parent Custodian refreshes it from durable Child files and, when available, verified Karazhan state.

An overview is not a live session list and cannot prove completion. A Custodian log is the Child's factual timeline; Karazhan contains the user-facing structured state; coordination summarizes both with provenance.

## Downward changes and checkpoints

Check explicitly listed upstream entry points at startup/recovery, phase or milestone transitions, before consuming a dependency, and before final delivery. This also applies to a leaf Child without local coordination. A reference must identify both the adopted content version and where to discover new versions or decisions; pinning a version alone cannot reveal a withdrawal.

The owner publishes the new constraint version and a decision. Each Child assesses its impact, completes required rework, and logs the actual application result, adopted version, evidence, and remaining work. Then it updates its index. Until application is complete, retain the prior adopted reference and log the pending transition; an invalidated baseline cannot be used for affected work. A compatible update may be deferred only with an explicit reason while the old baseline remains allowed.

For A → B → D, B gives D explicit applicable A-owned references when creating D. After A publishes a relevant decision, B relays its reference and local implementation requirements through B's coordination. D writes its own application log; B separately reports its own result and D's evidence. A reads B's summary of the subtree, not every descendant's private Context. Missing descendant evidence stays pending even after B finishes its own work. Newly declared dependencies are checked against trusted identities and existing access boundaries before adding them to the index.

Example records (A/B/D denote Work IDs; record IDs are unique within their owning Workspace):

```text
A/DEC-002: use scope r2 at retained location; supersedes DEC-001;
  affects B and C, including B's coding Child D; redo affected statistics.
B/DEC-004: apply A/DEC-002 to D's coding; original authority remains A.
D/APPLY-002: adopted A scope r2; recoded 12 inputs; evidence coding-r2.csv;
  no coding blocker; does not claim B's statistics are already validated.
B overview: own application B/APPLY-003; descendant evidence D/APPLY-002.
```

No automatic notification, polling daemon, or immediate stop guarantee is implied. Even urgent withdrawal is discoverable only at the next checkpoint; immediate interruption belongs to the user/runtime. With the Parent offline, continue confirmed, readable, unaffected work and leave new approvals or incompatible dependencies pending.

## Releases and consumption

A recoverable reference includes owner Work ID, purpose, version, and content location. Use a readable Git repository plus full commit/file path with objects retained, or owner-preserved versioned files. Mutable paths, timestamps, and hashes without retained content are insufficient. Work IDs establish identity, not content version. Check identity and content availability before consumption; if a retained version is missing or known to have changed, stop dependent consumption and report it.

Only shared inputs and deliveries require retained versions. Drafts may change. Published content stays unchanged by owner convention; later revisions get new releases. Historical snapshots are retained versions of the same authority, not independently editable current requirements. This protocol does not enforce filesystem permissions or solve concurrent writers.

For a multi-file release, the producer logs every file/version and validation before declaring it ready. The Parent records confirmation for that release in its own log or decisions, then overview references both durable records. The consumer verifies the complete confirmed set and logs what it consumed:

```text
B/REL-001: artifacts/releases/REL-001/pain-points.md and source-map.csv;
  both retained at REL-001; validated against requirements r2 and scope r2;
  evidence and remaining risks included in the release record.
A/ACCEPT-001: confirms both B/REL-001 files for C's report input.
C/USE-001: consumed B/REL-001 under A/ACCEPT-001 for report draft r1.
```

Do not mix files from REL-001 and REL-002, inherit confirmation for a new release, or equate a work-in-progress file with a retained version. Check declared withdrawal/change entries before use; missing files, withdrawn releases, or absent confirmation leave the dependency pending. Parent confirmation is for authorized intermediate use, not final user acceptance.

## Upward findings and adoption

A Child records significant findings promptly, with a stable ID, evidence, confidence, affected constraints/tasks, and a proposal. A Parent reads relevant direct Child findings while checking progress, at phase handoffs, and before cross-Task decisions; no watcher is assumed.

Record adoption, rejection, or pending validation with reasons. Acceptance of a proposal alone does not publish a new shared constraint. The authorized owner must update and retain the authoritative version and publish its decision, then use the downward process. If an ancestor owns the constraint, relay the proposal with its original evidence; do not edit that ancestor's files. Decisions requiring user authorization still require it.

```text
D/FIND-001: suspected duplicate sample; source-map evidence;
  count impact unverified; propose deduplication affecting B and C.
B/FIND-004: relay D/FIND-001 to owner A; preserve original evidence.
A/ADOPT-001: adopted after verification under existing authority;
  publishes scope r3 and DEC-003. Otherwise record rejected/pending + reason.
```

## Complete handoff and recovery

At milestones and deliberate handoffs, append a complete record with a stable ID and update only its locator in the index. For example:

```text
H-003: requirements r2, A scope r3 (recoverable references in index);
  applied A/DEC-003 (evidence APPLY-003);
  release REL-002, Parent confirmation pending;
  unresolved: small sample; proposal FIND-005 pending;
  next: document sample limitations; evidence: retained source map.
```

Read the latest complete record and all later entries, including any later complete handoff, then check upstream changes and actual artifacts/unfinished operations. If a pointer is missing or stale, search only the local log; with no complete record, reconstruct from available evidence and state uncertainty. A crash may leave files changed without a log entry: do not assume the last log proves current content or blindly repeat side effects. Append corrections and recovery results; do not rewrite history. Ordinary progress entries need not repeat the full snapshot, and no independent current-status file is needed.

## Phase 2.5 compatibility

Legacy Workspaces may have:

```text
shared-context -> ../../context
coordination -> ../../coordination
```

Read these links when they already exist, but do not migrate, delete, or retarget them during ordinary work. New Workspaces use owned Context and explicit indexes. A dedicated, reviewed migration may later replace legacy links.

New requirements authority, version references, and complete-handoff rules likewise apply to newly provisioned Workspaces. Preserve legacy fields and logs under their existing contract until a separate migration is authorized.
