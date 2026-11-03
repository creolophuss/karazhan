# Update existing Agent scaffolds

Use Node.js 26 and a current Karazhan checkout. This workflow updates instruction and Skill files. It does not build Rust, install the App or MCP binary, call a model, or start an Agent. Run it outside active Agent writes to the selected targets.

## Prepare a private preview

```sh
node scripts/update-scaffolds.mjs prepare --out /absolute/private/update-preview
```

Without target flags, prepare queries Project and Task primary Workspace bindings through the configured stdio MCP companion. It also finds the current Workspace, its known `children/` Workspaces, and explicit Workspace navigation in Context indexes. It does not scan repositories, artifacts, legacy directories, or the whole home directory. It discovers Medivh from installer metadata, the installed launcher, `KARAZHAN_MEDIVH_PROFILE_DIR`, and the default Profile location. Canonical duplicate paths are combined. Directory aliases in ancestors are resolved; a target that is itself a symlink is rejected. Conflicting Work identities are reported.

MCP discovery uses `KARAZHAN_DATABASE_PATH` or the database configured through Hermes. It requires an existing regular database file at an absolute path before starting MCP. The command defaults to `~/.local/bin/karazhan-mcp`; `KARAZHAN_MCP_COMMAND` can select another installed command. The client sends only `karazhan_query` requests. It does not open SQLite itself or guess a database path. The MCP companion may perform its normal database startup checks. Discovery warnings identify unavailable Karazhan, unbound nodes, and missing directories. Prepare can succeed with a partial target list. Review the complete report before applying; this does not mean every Agent was found.

Use explicit paths to select only those targets. A single target flag disables automatic target discovery for both categories:

```sh
node scripts/update-scaffolds.mjs prepare \
  --workspace /absolute/project-workspace \
  --workspace /absolute/task-workspace \
  --medivh-profile /absolute/medivh-profile \
  --out /absolute/private/update-preview
```

The output directory must be new and outside the public repository. Prepare does not change targets. It stores source snapshots, original managed files, requirement/index references, target checksums, conflicts, and one candidate per target. Treat this directory as private project data.

## Choose which targets to skip

The executing Agent presents `TARGETS.md` and waits for the user to finish choosing. Check the Projects, Tasks, or Medivh Profiles that should not update. Leave the others unchecked. Each row is independent: skipping a Project does not skip its descendants. Change only the checkboxes, preserving the target labels and paths. Then tell the Agent to continue.

The Agent composes and reviews only the remaining candidates. Apply reads the saved checklist directly. It does not validate, back up, or change skipped targets; their conflicts or later file changes do not block selected targets. If every target is checked, apply reports that nothing changed. New previews require a complete, valid checklist. Older previews without a checklist retain their original target behavior; prepare again to add the checklist.

## Compose and review instructions

After the user finishes choosing, the executing LLM reads `REVIEW.md`, `plan.json`, and each selected `targets/<number>/` directory. The initial `AGENTS.candidate.md` contains the existing instructions. It is not an approved template replacement. Compose it using the current instructions, `AGENTS.new-template.md`, local requirements, and applicable business constraints. Preserve business restrictions and ASD-STE100 principles, including Chinese. Remove the retired presentation Skill rule. HTML remains available through direct, content-specific generation.

When the old package has a valid recorded digest, its embedded template can provide a three-way merge base. Later updates use the retained template baseline. `AGENTS.merge-advisory.md`, when present, is advisory. Missing or changed baselines require an explicit LLM merge; they never justify overwriting project rules. Modified or unverified managed Skills are conflicts: preserve them, resolve their ownership/content separately, then prepare again.

After checking the diff and business rules, the executing LLM sets each `review.json`:

```json
{
  "reviewed": true,
  "agentsSha256": "SHA-256 of AGENTS.candidate.md",
  "notes": "Reviewed business constraints, role boundaries, ASD-STE100, and the instruction diff."
}
```

Use `shasum -a 256 <candidate-path>` to obtain the checksum. This marker records the executing Agent's review. It does not require a second user approval. The script does not assess whether the LLM preserved the meaning of business rules.

### Resolve local managed Skill changes

Preserve the conflict records. For each changed Skill, the executing Agent reads the original and current scaffold, composes a merged directory at `targets/<number>/managed-candidates/<managed-relative-path>`, and records its review in `review.json.managed`. Each key must be a prepared managed path. For a replacement, record `action: "replace"`, `beforeSha256` from the prepared target baseline, `candidateSha256` for the merged directory, and non-empty `notes` explaining preserved changes. The target review must also have `reviewed: true`.

To remove an unverified old presentation Skill, first review its contents and provenance. Record its exact prepared path with `action: "retire"`, the prepared `beforeSha256`, and review notes. Only the retired Skill path can use this action. Unreviewed conflicts still stop apply. The script checks paths and content checksums, keeps the old content in the private backup, and records these reviews in installed scaffold state. Review checksums do not prove semantic correctness.

Review package evidence too. Retain provenance for unrelated custom Skills. If a reviewed Skill variant changes the managed package content, prepare and review its `PACKAGE.md` with a matching content digest. Distinguish previous installation records from the new package baseline. Do not discard local provenance when replacing generic package metadata.

## Apply the prepared update

```sh
node scripts/update-scaffolds.mjs apply --plan /absolute/private/update-preview
```

Apply checks source snapshots, selected target baselines, Work identities, review checksums, and prepared write paths before it changes a target. A conflict or stale baseline in a selected target stops the operation. Skip that target or prepare again after resolving the change. Symlink targets and symlinks in managed paths are rejected.

Each target gets a retained backup. If a target fails during replacement, the script restores its managed files. Targets completed before that failure stay updated. The report identifies them. Reapplying a completed plan is a no-op. Keep the preview and backups until you accept the update.

The updater preserves identity, Context, logs, repositories, Hooks, sessions, user memories, and unrelated Skills. It removes an installed `answer-me-with-html` copy only when the existing package or installer baseline verifies that copy. A modified or uncertain copy is a conflict. Generated HTML and historical backups remain user data.

Existing Medivh scaffolds are preserved by `install.sh`, which reports their update as pending while maintaining App/MCP components. New installations receive the current two-Skill Custodian package. After applying a scaffold update, reload the affected Agent instructions through the runtime's normal reload or restart procedure. The updater does not restart sessions.


## MCP delegation in updated instructions

Current Medivh and Custodian instructions delegate MCP registration and synchronization through the runtime's subagent tool. This does not delegate the scaffold update commands themselves. One executor handles a Work's prerequisite queries, writes and verification serially; the primary Agent continues independent work and waits only for dependencies. Only selected targets consume these instructions. Existing Agents elsewhere keep their installed rules until explicitly updated.
