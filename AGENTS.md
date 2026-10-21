# Contributor guidance

Karazhan is a local-first macOS workbench with a shared Rust core, a React/TypeScript desktop UI, and thin Tauri, HTTP, and MCP adapters.

## Sources and scope

Read [README.md](README.md) and [docs/product-requirements.md](docs/product-requirements.md) for setup, product rules, current capabilities, and integration limits. Confirm new or changed requirements in the product reference before implementing them. Historical plans and local Agent records do not expand scope.

Reuse available context during continuous work. Read relevant files again after context loss, known external changes, or a conflict. Keep changes small and tied to the requested outcome. Do not add deferred features or unrelated refactors.

## Communication and reporting

In user conversations, reports, and other prose, follow ASD-STE100 Simplified Technical English or its principles. Apply the same principles to Chinese; use the English controlled vocabulary when applicable. Claim full standard compliance only when checked against the standard.

- Use short sentences and familiar, precise words. Express one main idea per sentence.
- Prefer active voice. State who does what; make conditions and references clear.
- Use one consistent term for each concept. Explain necessary technical terms on first use.
- Lead with the result or required action. Give procedures in execution order, with one action per step.
- Remove redundant wording, vague qualifiers, idioms, and decorative language. Keep facts, assumptions, and uncertainty distinct.
- Preserve exact code, commands, paths, identifiers, quotations, and required technical terms. Do not omit necessary information to shorten text.

Reference: [official ASD-STE100 explanation](https://www.asd-ste100.org/STE_faq.html).

## Engineering boundaries

- React uses the central TypeScript client. It does not access SQLite, files, or a shell directly.
- Tauri IPC, HTTP, and MCP share the Rust application/domain core. Keep business rules there.
- Preserve revisions, idempotency, actor/channel provenance, structured errors, and atomic field/event writes.
- Use in-memory databases, temporary directories, or explicit isolated development data in tests. Do not use personal Workspaces or the product database as fixtures.
- Do not change live Agent profiles, Hooks, session state, or other Workspaces without explicit user authority.
- Keep credentials, private Context, local execution logs, evidence, and generated artifacts outside tracked source. A local `agent_log.md` is optional and ignored.
- Keep third-party source and license notices intact. Update managed Skill copies through the source integration and package workflow.

## Verification

For behavior changes, add a focused regression that demonstrates the problem. Run relevant tests, then `npm run check` for product changes. The gate runs formatting, strict Clippy, Rust and frontend tests, TypeScript checks, and the frontend build. For documentation changes, check links and agreement with implemented behavior.

Report what changed, what passed, and any remaining limits. Keep prose short and precise. Distinguish verified results from assumptions. User acceptance controls completion; do not infer it from a test pass or a log entry.
