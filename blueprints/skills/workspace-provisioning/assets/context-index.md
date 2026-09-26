# Context Index

Resolve relative file paths from this `context/` directory unless explicitly labeled Workspace-relative. Cross-Workspace references use explicit absolute paths plus stable Work IDs.

## Owner

- Work:
- Kind:
- Work ID:
- Workspace:
- Context:

## Purpose

Describe what this Context helps the owning Custodian accomplish.

## Parent

- Work:
- Work ID:
- Workspace:
- Context:
- Index:
- Coordination:

Use `None` for a top-level Workspace.

## Direct Children

| Project/Task | Work ID | Workspace | Context | Index |
| --- | --- | --- | --- | --- |

## Local coordination

- Overview: `coordination/overview.md`
- Decisions: `coordination/decisions.md`

Remove this section when the Project or Task has no direct Children.

## Read first

1. `requirements.md` for the authoritative local goal, scope, and acceptance.
2. List the smallest set of applicable upstream versions and change-check entry points below, including decisions even when this Workspace is a leaf.

## Applicable inputs

| Owner Work ID | Purpose | Adopted version and recoverable location | Change-check entry point |
| --- | --- | --- | --- |

For example: owner UUID, product scope, `r2` at an absolute retained-file path, and that owner's explicitly permitted decisions path. A Git reference needs a readable repository, full commit, and file path. Include applicable ancestor constraints explicitly; do not traverse all ancestors or copy their text. Use `Pending` for unavailable/unconfirmed inputs, not an adopted version.

Record adoption/application evidence in `agent_log.md`, then update this table. While application is incomplete, retain the last adopted reference and record the transition in the log; do not keep using an invalidated baseline. The table is navigation, not a second execution history.

## Latest complete handoff

- Record: `None` until a complete handoff exists; later use `../agent_log.md`, record ID, and date (for example `H-003`).

Read that record and every later entry on recovery; a later complete record supersedes the recovery starting point. If the pointer is missing/stale, search only this Workspace's log. Verify upstream changes and actual artifacts before continuing; the latest ordinary progress entry is not a complete handoff.

## Sources of truth

- Goal, scope, acceptance: `requirements.md`.
- Working rules and safety boundaries: `../AGENTS.md`.
- Shared constraints: owners and versions explicitly listed above.
- Execution, application, publication, consumption, and handoff evidence: `../agent_log.md`.
- Intermediate dependency confirmation: identify the Parent's durable record tied to the release; overview is only a summary.
- Structured planning: identify the Karazhan projection when used; local work does not require its availability.

## Boundaries

- Do not recursively scan unlisted directories.
- Do not copy credentials or sensitive Context into logs, prompts, or Karazhan.
