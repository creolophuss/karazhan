# Coordination Overview

> Replaceable snapshot maintained by the owning Parent Custodian.

## Parent Project/Task

- Work ID:
- Goal and acceptance: refer to `../requirements.md`; label any summary with its source version.
- Structured status:
- Updated at:

## Direct Children

| Task | Node ID | Workspace | Status | Latest durable progress | Next action | Blocker | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Dependencies

| Consumer Work ID | Producer Work ID / release ID | Retained file versions | Parent confirmation record | Consumption evidence / pending reason |
| --- | --- | --- | --- | --- |

For example: C consumes B/REL-001's two retained files, confirmed by A/ACCEPT-001 and recorded by C/USE-001. Empty or unconfirmed entries are pending, not available. A new release needs its own confirmation; multiple files must belong to the same confirmed release.

## Decision application

| Decision owner / ID | Direct Child Work ID | Child application record / pending reason | Relevant descendant evidence reported by Child |
| --- | --- | --- | --- |

Keep direct Child application separate from descendant application. With no evidence, report `Pending confirmation`; do not infer application from reading, directory existence, or session activity.

## Findings awaiting disposition

- Reference important Child findings and the owner's adoption/rejection/pending record. An accepted proposal is not a published constraint until its owner publishes the corresponding version and decision.

## Freshness

This is a timestamped summary, not a live session list or the sole acceptance record. Before cross-Task decisions, reread relevant durable Child evidence and check listed upstream decisions. When Karazhan is available, cross-check its structured state; its absence does not prevent file-based work. Parent confirmation authorizes only the specified intermediate use within existing authority; the user accepts final delivery.
