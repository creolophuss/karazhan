# Coordination Decisions

> Append-only owner decisions affecting direct Children or this subtree. A local Child decision stays local unless it changes a constraint owned here.

## YYYY-MM-DD HH:MM — Decision title

- Decision:
- Decision ID: unique within this Workspace (for example `DEC-002`); cross-Workspace references include the owner Work ID.
- Source version: owner Work ID, version, and recoverable file/commit location.
- Supersedes/withdraws: previous decision/version and scope, or `None`; state whether the old baseline remains usable.
- Affected Tasks: Work IDs and scope; identify the direct Child responsible for relaying to affected descendants.
- Revalidation: required rework/evidence and any affected work that must pause.
- Reason:
- Evidence:
- Authority: existing owner authority or required user approval record.
- Recorded by:

Each affected Child writes its own application record with the adopted version, result, evidence, and outstanding work. Reading this decision is not application. Track those references in overview; Parent application never substitutes for descendant evidence.
