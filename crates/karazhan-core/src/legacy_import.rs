use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{DomainError, SYSTEM_ROOT_ID};

pub const LEGACY_RULESET_VERSION: &str = "stage-3-legacy-import-v1";
const PROJECT_NAMESPACE: &str = "3f6f4b4a-8d21-5f8c-9a83-43c779ea9c01";
const ACTION_NAMESPACE: &str = "4d3ce4fb-1d29-5fa8-8ca6-2adf94511f02";
const BINDING_NAMESPACE: &str = "11b08f14-45ef-5df3-8f4a-4fb0aef29803";
const EVENT_NAMESPACE: &str = "d93259ad-6dbb-5bd1-b538-bafd92009ceb";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyDryRunScope {
    pub tasks_registry: String,
    pub backlog_registry: String,
    #[serde(default)]
    pub task_manifests: Vec<String>,
    #[serde(default)]
    pub agent_logs: Vec<String>,
    #[serde(default)]
    pub project_contexts: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacySourceKind {
    AgentLog,
    BacklogRegistry,
    TaskManifest,
    TasksRegistry,
}

impl LegacySourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgentLog => "agent_log",
            Self::BacklogRegistry => "backlog_registry",
            Self::TaskManifest => "task_manifest",
            Self::TasksRegistry => "tasks_registry",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacySourceFileSnapshot {
    pub source_kind: LegacySourceKind,
    pub locator: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyProjectContextSnapshot {
    pub locator: String,
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyDryRunSummary {
    pub legacy_projects: usize,
    pub legacy_tasks: usize,
    pub next_action_tasks: usize,
    pub legacy_backlog_items: usize,
    pub work_nodes: usize,
    pub resource_bindings: usize,
    pub progress_events: usize,
    pub today_items: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyProjectMapping {
    pub source_slug: String,
    pub target_id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub position: i64,
    pub context_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyTaskMapping {
    pub source_id: String,
    pub target_id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub position: i64,
    pub work_status: String,
    pub priority: String,
    pub raw_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyNextActionTaskMapping {
    pub source_task_id: String,
    pub target_id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub position: i64,
    pub work_status: String,
    pub priority: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyBacklogMapping {
    pub source_id: String,
    pub target_id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub position: i64,
    pub backlog_kind: String,
    pub backlog_status: String,
    pub promoted_node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyResourceBindingMapping {
    pub id: String,
    pub node_id: String,
    pub kind: String,
    pub locator: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyProgressEventMapping {
    pub id: String,
    pub subject_node_id: String,
    pub source_binding_id: String,
    pub source_item_key: String,
    pub source_digest: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyTodayItemMapping {
    pub node_id: String,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyConflict {
    pub code: String,
    pub severity: String,
    pub count: usize,
    pub evidence: Vec<String>,
    pub safe_default: String,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyDryRunReport {
    pub ruleset_version: String,
    pub source_root: String,
    pub scope: LegacyDryRunScope,
    pub source_files: Vec<LegacySourceFileSnapshot>,
    pub project_contexts: Vec<LegacyProjectContextSnapshot>,
    pub summary: LegacyDryRunSummary,
    pub project_mappings: Vec<LegacyProjectMapping>,
    pub legacy_task_mappings: Vec<LegacyTaskMapping>,
    pub legacy_next_action_task_mappings: Vec<LegacyNextActionTaskMapping>,
    pub backlog_mappings: Vec<LegacyBacklogMapping>,
    pub resource_binding_mappings: Vec<LegacyResourceBindingMapping>,
    pub progress_event_mappings: Vec<LegacyProgressEventMapping>,
    pub today_item_mappings: Vec<LegacyTodayItemMapping>,
    pub conflicts: Vec<LegacyConflict>,
    pub source_snapshot_digest: String,
    pub report_digest: String,
    pub apply_eligible: bool,
}

#[derive(Serialize)]
struct SourceSnapshotPayload<'a> {
    source_files: &'a [LegacySourceFileSnapshot],
    project_contexts: &'a [LegacyProjectContextSnapshot],
}

#[derive(Serialize)]
struct ReportDigestPayload<'a> {
    ruleset_version: &'a str,
    source_root: &'a str,
    scope: &'a LegacyDryRunScope,
    source_files: &'a [LegacySourceFileSnapshot],
    project_contexts: &'a [LegacyProjectContextSnapshot],
    summary: &'a LegacyDryRunSummary,
    project_mappings: &'a [LegacyProjectMapping],
    legacy_task_mappings: &'a [LegacyTaskMapping],
    legacy_next_action_task_mappings: &'a [LegacyNextActionTaskMapping],
    backlog_mappings: &'a [LegacyBacklogMapping],
    resource_binding_mappings: &'a [LegacyResourceBindingMapping],
    progress_event_mappings: &'a [LegacyProgressEventMapping],
    today_item_mappings: &'a [LegacyTodayItemMapping],
    conflicts: &'a [LegacyConflict],
    source_snapshot_digest: &'a str,
    apply_eligible: bool,
}

struct ScopedSourceFile {
    snapshot: LegacySourceFileSnapshot,
    bytes: Vec<u8>,
}

struct LegacyIdentityMappings {
    projects: Vec<LegacyProjectMapping>,
    tasks: Vec<LegacyTaskMapping>,
    next_actions: Vec<LegacyNextActionTaskMapping>,
    sources: Vec<LegacyTaskSource>,
    next_positions: BTreeMap<String, i64>,
    occupied_keys: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Deserialize)]
struct LegacyTaskRegistry {
    #[serde(default)]
    projects: Vec<LegacyProjectSource>,
    #[serde(default)]
    tasks: Vec<LegacyTaskSource>,
}

#[derive(Clone, Deserialize)]
struct LegacyProjectSource {
    slug: String,
    title: Option<String>,
    context_path: Option<String>,
}

#[derive(Clone, Deserialize)]
struct LegacyTaskSource {
    id: String,
    project_slug: Option<String>,
    parent_id: Option<String>,
    key: Option<String>,
    title: Option<String>,
    next_action: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    workspace: Option<String>,
    manifest: Option<String>,
    agent_log: Option<String>,
    cursor: Option<serde_yaml_ng::Value>,
    #[serde(default)]
    today: bool,
}

#[derive(Deserialize)]
struct LegacyBacklogRegistry {
    #[serde(default)]
    items: Vec<LegacyBacklogSource>,
}

#[derive(Deserialize)]
struct LegacyBacklogSource {
    id: String,
    project_slug: Option<String>,
    project_id: Option<String>,
    key: Option<String>,
    title: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    promoted_node_id: Option<String>,
}

#[derive(Default)]
struct ConflictAccumulator(BTreeMap<String, ConflictEntry>);

struct ConflictEntry {
    severity: &'static str,
    evidence: BTreeSet<String>,
    safe_default: &'static str,
    requires_confirmation: bool,
}

pub fn dry_run_legacy_source(
    source_root: impl AsRef<Path>,
    scope: &LegacyDryRunScope,
) -> Result<LegacyDryRunReport, DomainError> {
    let requested_root = source_root.as_ref();
    let canonical_root =
        fs::canonicalize(requested_root).map_err(|_| DomainError::ImportSourceRootInvalid {
            source_root: requested_root.display().to_string(),
        })?;
    if !canonical_root.is_dir() {
        return Err(DomainError::ImportSourceRootInvalid {
            source_root: requested_root.display().to_string(),
        });
    }

    let tasks_source = read_source_file(
        &canonical_root,
        LegacySourceKind::TasksRegistry,
        &scope.tasks_registry,
    )?;
    let mut task_registry: LegacyTaskRegistry = serde_yaml_ng::from_slice(&tasks_source.bytes)
        .map_err(|_| DomainError::ImportSourceMalformed {
            locator: scope.tasks_registry.clone(),
        })?;
    let backlog_source = read_source_file(
        &canonical_root,
        LegacySourceKind::BacklogRegistry,
        &scope.backlog_registry,
    )?;
    let backlog_registry: LegacyBacklogRegistry = serde_yaml_ng::from_slice(&backlog_source.bytes)
        .map_err(|_| DomainError::ImportSourceMalformed {
            locator: scope.backlog_registry.clone(),
        })?;
    let mut scoped_files = vec![tasks_source, backlog_source];
    let mut manifest_documents = Vec::new();
    for locator in &scope.task_manifests {
        let source = read_source_file(&canonical_root, LegacySourceKind::TaskManifest, locator)?;
        let manifest = serde_yaml_ng::from_slice(&source.bytes).map_err(|_| {
            DomainError::ImportSourceMalformed {
                locator: locator.clone(),
            }
        })?;
        manifest_documents.push((locator.clone(), manifest));
        scoped_files.push(source);
    }
    let mut log_sources = BTreeMap::new();
    for locator in &scope.agent_logs {
        let source = read_source_file(&canonical_root, LegacySourceKind::AgentLog, locator)?;
        log_sources.insert(locator.clone(), source.bytes.clone());
        scoped_files.push(source);
    }
    scoped_files.sort_by(|left, right| {
        (left.snapshot.source_kind, left.snapshot.locator.as_str())
            .cmp(&(right.snapshot.source_kind, right.snapshot.locator.as_str()))
    });
    let files = scoped_files
        .into_iter()
        .map(|source| source.snapshot)
        .collect::<Vec<_>>();
    reject_duplicate_files(&files)?;

    let mut contexts = scope
        .project_contexts
        .iter()
        .map(|locator| snapshot_context(&canonical_root, locator))
        .collect::<Result<Vec<_>, _>>()?;
    contexts.sort_by(|left, right| left.locator.cmp(&right.locator));
    reject_duplicate_contexts(&contexts)?;

    let mut conflict_accumulator = ConflictAccumulator::default();
    merge_manifest_tasks(
        &mut task_registry,
        manifest_documents,
        &mut conflict_accumulator,
    )?;
    let mut mappings = map_task_registry(
        task_registry,
        &scope.tasks_registry,
        &mut conflict_accumulator,
    )?;
    let backlog_mappings = map_backlog_registry(
        backlog_registry,
        &scope.backlog_registry,
        &mappings.projects,
        &mappings.tasks,
        &mut mappings.next_positions,
        &mut mappings.occupied_keys,
        &mut conflict_accumulator,
    )?;
    let resource_binding_mappings =
        map_resource_bindings(&mappings.sources, &mut conflict_accumulator);
    let progress_event_mappings =
        map_progress_events(&mappings.sources, &log_sources, &resource_binding_mappings);
    let today_item_mappings = mappings
        .sources
        .iter()
        .filter(|task| task.today)
        .enumerate()
        .map(|(position, task)| LegacyTodayItemMapping {
            node_id: task.id.clone(),
            position: position as i64,
        })
        .collect::<Vec<_>>();
    plan_log_cursor_conflicts(&mappings.sources, &log_sources, &mut conflict_accumulator);
    let conflicts = conflict_accumulator.finish();
    let summary = LegacyDryRunSummary {
        legacy_projects: mappings.projects.len(),
        legacy_tasks: mappings.tasks.len(),
        next_action_tasks: mappings.next_actions.len(),
        legacy_backlog_items: backlog_mappings.len(),
        work_nodes: 1
            + mappings.projects.len()
            + mappings.tasks.len()
            + mappings.next_actions.len()
            + backlog_mappings.len(),
        resource_bindings: resource_binding_mappings.len(),
        progress_events: progress_event_mappings.len(),
        today_items: today_item_mappings.len(),
    };

    let source_snapshot_digest = digest_json(&SourceSnapshotPayload {
        source_files: &files,
        project_contexts: &contexts,
    })?;
    let canonical_root = canonical_root.display().to_string();
    let apply_eligible = !conflicts
        .iter()
        .any(|conflict| conflict.severity == "blocker");
    let report_digest = digest_json(&ReportDigestPayload {
        ruleset_version: LEGACY_RULESET_VERSION,
        source_root: &canonical_root,
        scope,
        source_files: &files,
        project_contexts: &contexts,
        summary: &summary,
        project_mappings: &mappings.projects,
        legacy_task_mappings: &mappings.tasks,
        legacy_next_action_task_mappings: &mappings.next_actions,
        backlog_mappings: &backlog_mappings,
        resource_binding_mappings: &resource_binding_mappings,
        progress_event_mappings: &progress_event_mappings,
        today_item_mappings: &today_item_mappings,
        conflicts: &conflicts,
        source_snapshot_digest: &source_snapshot_digest,
        apply_eligible,
    })?;

    Ok(LegacyDryRunReport {
        ruleset_version: LEGACY_RULESET_VERSION.into(),
        source_root: canonical_root,
        scope: scope.clone(),
        source_files: files,
        project_contexts: contexts,
        summary,
        project_mappings: mappings.projects,
        legacy_task_mappings: mappings.tasks,
        legacy_next_action_task_mappings: mappings.next_actions,
        backlog_mappings,
        resource_binding_mappings,
        progress_event_mappings,
        today_item_mappings,
        conflicts,
        source_snapshot_digest,
        report_digest,
        apply_eligible,
    })
}

fn read_source_file(
    root: &Path,
    source_kind: LegacySourceKind,
    locator: &str,
) -> Result<ScopedSourceFile, DomainError> {
    let relative = validate_relative(locator)?;
    validate_source_kind(source_kind, &relative, locator)?;
    reject_protected_file_path(&relative, locator)?;
    let candidate = root.join(&relative);
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DomainError::ImportSourceMissing {
                locator: locator.into(),
            }
        } else {
            DomainError::Io(error)
        }
    })?;
    ensure_below_root(root, &canonical, locator)?;
    let canonical_relative =
        canonical
            .strip_prefix(root)
            .map_err(|_| DomainError::ImportScopeOutsideRoot {
                locator: locator.into(),
            })?;
    reject_protected_file_path(canonical_relative, locator)?;
    if !canonical.is_file() {
        return Err(DomainError::ImportSourceNotFile {
            locator: locator.into(),
        });
    }
    let bytes = fs::read(canonical)?;
    Ok(ScopedSourceFile {
        snapshot: LegacySourceFileSnapshot {
            source_kind,
            locator: locator.into(),
            byte_length: bytes.len() as u64,
            sha256: hex_digest(&bytes),
        },
        bytes,
    })
}

fn map_task_registry(
    registry: LegacyTaskRegistry,
    source_locator: &str,
    conflicts: &mut ConflictAccumulator,
) -> Result<LegacyIdentityMappings, DomainError> {
    let project_namespace = frozen_namespace(PROJECT_NAMESPACE);
    let action_namespace = frozen_namespace(ACTION_NAMESPACE);
    let mut project_sources = registry.projects;
    let mut project_slugs = project_sources
        .iter()
        .map(|project| project.slug.clone())
        .collect::<BTreeSet<_>>();
    if project_slugs.len() != project_sources.len()
        || project_slugs.iter().any(|slug| slug.trim().is_empty())
    {
        return Err(malformed(source_locator));
    }
    for task in &registry.tasks {
        if let Some(slug) = task
            .project_slug
            .as_ref()
            .filter(|slug| !slug.trim().is_empty())
            && project_slugs.insert(slug.clone())
        {
            project_sources.push(LegacyProjectSource {
                slug: slug.clone(),
                title: None,
                context_path: None,
            });
        }
    }

    let project_mappings = project_sources
        .iter()
        .enumerate()
        .map(|(position, project)| LegacyProjectMapping {
            source_slug: project.slug.clone(),
            target_id: Uuid::new_v5(&project_namespace, project.slug.as_bytes()).to_string(),
            parent_id: SYSTEM_ROOT_ID.into(),
            key: project.slug.clone(),
            title: project
                .title
                .clone()
                .unwrap_or_else(|| project.slug.clone()),
            position: position as i64,
            context_path: project.context_path.clone(),
        })
        .collect::<Vec<_>>();
    let project_ids = project_mappings
        .iter()
        .map(|mapping| (mapping.source_slug.as_str(), mapping.target_id.as_str()))
        .collect::<BTreeMap<_, _>>();

    let mut task_ids = BTreeSet::new();
    let mut next_positions = BTreeMap::<String, i64>::new();
    let mut occupied_keys = BTreeMap::<String, BTreeSet<String>>::new();
    occupied_keys.insert(
        SYSTEM_ROOT_ID.into(),
        project_mappings
            .iter()
            .map(|mapping| mapping.key.clone())
            .collect(),
    );
    let mut legacy_task_mappings = Vec::with_capacity(registry.tasks.len());
    for task in &registry.tasks {
        if Uuid::parse_str(&task.id).is_err() || !task_ids.insert(task.id.clone()) {
            return Err(malformed(source_locator));
        }
        let parent_id = match task
            .parent_id
            .as_deref()
            .filter(|parent| !parent.trim().is_empty())
        {
            Some(parent_id) => {
                if Uuid::parse_str(parent_id).is_err() {
                    return Err(malformed(source_locator));
                }
                parent_id.to_owned()
            }
            None => {
                let slug = task
                    .project_slug
                    .as_deref()
                    .filter(|slug| !slug.trim().is_empty())
                    .ok_or_else(|| malformed(source_locator))?;
                project_ids
                    .get(slug)
                    .ok_or_else(|| malformed(source_locator))?
                    .to_string()
            }
        };
        let position = *next_positions.entry(parent_id.clone()).or_default();
        *next_positions.get_mut(&parent_id).expect("position exists") += 1;
        let desired_key = task
            .key
            .clone()
            .filter(|key| !key.trim().is_empty())
            .unwrap_or_else(|| {
                format!(
                    "task-{}",
                    task.id.replace('-', "").chars().take(8).collect::<String>()
                )
            });
        let key = safe_sibling_key(
            occupied_keys.entry(parent_id.clone()).or_default(),
            &desired_key,
            &task.id,
        );
        if key != desired_key {
            conflicts.add(
                "sibling_key_collision",
                "warning",
                format!("task:{}", task.id),
                "append source UUID suffix deterministically",
                false,
            );
        }
        let source_status = task.status.as_deref().unwrap_or("planned");
        let (work_status, raw_status) = if source_status == "waiting" {
            conflicts.add(
                "legacy_status_mapped",
                "info",
                format!("task:{}", task.id),
                "map waiting to pending and preserve the raw value",
                false,
            );
            ("pending".to_owned(), Some("waiting".to_owned()))
        } else {
            (source_status.to_owned(), None)
        };
        legacy_task_mappings.push(LegacyTaskMapping {
            source_id: task.id.clone(),
            target_id: task.id.clone(),
            parent_id,
            title: task.title.clone().unwrap_or_else(|| key.clone()),
            key,
            position,
            work_status,
            priority: task.priority.clone().unwrap_or_else(|| "none".into()),
            raw_status,
        });
    }

    let mut legacy_next_action_task_mappings = Vec::new();
    for task in &registry.tasks {
        let Some(title) = task
            .next_action
            .as_ref()
            .filter(|action| !action.trim().is_empty())
        else {
            continue;
        };
        let position = *next_positions.entry(task.id.clone()).or_default();
        *next_positions.get_mut(&task.id).expect("position exists") += 1;
        let desired_key = "next-action";
        let key = safe_sibling_key(
            occupied_keys.entry(task.id.clone()).or_default(),
            desired_key,
            &task.id,
        );
        if key != desired_key {
            conflicts.add(
                "sibling_key_collision",
                "warning",
                format!("next_action:{}", task.id),
                "append source UUID suffix deterministically",
                false,
            );
        }
        legacy_next_action_task_mappings.push(LegacyNextActionTaskMapping {
            source_task_id: task.id.clone(),
            target_id: Uuid::new_v5(
                &action_namespace,
                format!("{}:next_action:v1", task.id).as_bytes(),
            )
            .to_string(),
            parent_id: task.id.clone(),
            key,
            title: title.clone(),
            position,
            work_status: "planned".into(),
            priority: "none".into(),
        });
    }

    Ok(LegacyIdentityMappings {
        projects: project_mappings,
        tasks: legacy_task_mappings,
        next_actions: legacy_next_action_task_mappings,
        sources: registry.tasks,
        next_positions,
        occupied_keys,
    })
}

fn merge_manifest_tasks(
    registry: &mut LegacyTaskRegistry,
    manifests: Vec<(String, LegacyTaskSource)>,
    conflicts: &mut ConflictAccumulator,
) -> Result<(), DomainError> {
    for (locator, mut manifest) in manifests {
        if Uuid::parse_str(&manifest.id).is_err() {
            return Err(malformed(&locator));
        }
        if let Some(existing) = registry
            .tasks
            .iter_mut()
            .find(|task| task.id == manifest.id)
        {
            if let Some(declared) = existing.manifest.as_deref()
                && declared != locator
            {
                conflicts.add(
                    "manifest_identity_mismatch",
                    "warning",
                    format!("task:{}", existing.id),
                    "keep both task identities and bind each declared source separately",
                    false,
                );
            } else {
                existing.manifest = Some(locator);
            }
            continue;
        }
        manifest.manifest = Some(locator.clone());
        conflicts.add(
            "manifest_without_registry",
            "warning",
            format!("manifest:{locator}"),
            "create a Task candidate without discarding the manifest",
            false,
        );
        registry.tasks.push(manifest);
    }
    Ok(())
}

fn map_backlog_registry(
    registry: LegacyBacklogRegistry,
    source_locator: &str,
    projects: &[LegacyProjectMapping],
    tasks: &[LegacyTaskMapping],
    next_positions: &mut BTreeMap<String, i64>,
    occupied_keys: &mut BTreeMap<String, BTreeSet<String>>,
    conflicts: &mut ConflictAccumulator,
) -> Result<Vec<LegacyBacklogMapping>, DomainError> {
    let project_ids = projects
        .iter()
        .map(|project| (project.source_slug.as_str(), project.target_id.as_str()))
        .collect::<BTreeMap<_, _>>();
    let target_ids = tasks
        .iter()
        .map(|task| task.target_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut seen_ids = BTreeSet::new();
    let mut mappings = Vec::with_capacity(registry.items.len());
    for item in registry.items {
        if Uuid::parse_str(&item.id).is_err() || !seen_ids.insert(item.id.clone()) {
            return Err(malformed(source_locator));
        }
        let project_reference = item.project_slug.as_deref().or(item.project_id.as_deref());
        let parent_id = project_reference
            .and_then(|value| {
                project_ids.get(value).copied().or_else(|| {
                    projects
                        .iter()
                        .find(|project| project.target_id == value)
                        .map(|p| p.target_id.as_str())
                })
            })
            .unwrap_or(SYSTEM_ROOT_ID)
            .to_owned();
        let position = *next_positions.entry(parent_id.clone()).or_default();
        *next_positions.get_mut(&parent_id).expect("position exists") += 1;
        let desired_key = item
            .key
            .filter(|key| !key.trim().is_empty())
            .unwrap_or_else(|| {
                format!(
                    "backlog-{}",
                    item.id.replace('-', "").chars().take(8).collect::<String>()
                )
            });
        let key = safe_sibling_key(
            occupied_keys.entry(parent_id.clone()).or_default(),
            &desired_key,
            &item.id,
        );
        if key != desired_key {
            conflicts.add(
                "sibling_key_collision",
                "warning",
                format!("backlog:{}", item.id),
                "append source UUID suffix deterministically",
                false,
            );
        }
        if let Some(target) = item.promoted_node_id.as_deref()
            && target_ids.contains(target)
        {
            conflicts.add(
                "promotion_link_verified",
                "info",
                format!("backlog:{}", item.id),
                "retain the source Backlog and link the existing target",
                false,
            );
        }
        mappings.push(LegacyBacklogMapping {
            source_id: item.id.clone(),
            target_id: item.id,
            parent_id,
            key: key.clone(),
            title: item.title.unwrap_or(key),
            position,
            backlog_kind: item.kind.unwrap_or_else(|| "idea".into()),
            backlog_status: item.status.unwrap_or_else(|| "captured".into()),
            promoted_node_id: item.promoted_node_id,
        });
    }
    Ok(mappings)
}

fn map_resource_bindings(
    tasks: &[LegacyTaskSource],
    conflicts: &mut ConflictAccumulator,
) -> Vec<LegacyResourceBindingMapping> {
    let namespace = frozen_namespace(BINDING_NAMESPACE);
    let mut mappings = Vec::new();
    let mut shared = BTreeMap::<(String, String), Vec<String>>::new();
    for task in tasks {
        for (kind, locator) in [
            ("workspace", task.workspace.as_deref()),
            ("manifest", task.manifest.as_deref()),
            ("agent_log", task.agent_log.as_deref()),
        ] {
            let Some(locator) = locator.filter(|value| !value.trim().is_empty()) else {
                continue;
            };
            mappings.push(LegacyResourceBindingMapping {
                id: Uuid::new_v5(
                    &namespace,
                    format!("{}:{kind}:{locator}", task.id).as_bytes(),
                )
                .to_string(),
                node_id: task.id.clone(),
                kind: kind.into(),
                locator: locator.into(),
            });
            shared
                .entry((kind.into(), locator.into()))
                .or_default()
                .push(task.id.clone());
        }
    }
    for ((kind, locator), node_ids) in shared {
        if node_ids.len() > 1 {
            conflicts.add(
                "shared_resource_locator",
                "warning",
                format!("{kind}:{locator}:{}", node_ids.join(",")),
                "keep every Task identity and create separate bindings",
                false,
            );
        }
    }
    mappings
}

fn map_progress_events(
    tasks: &[LegacyTaskSource],
    logs: &BTreeMap<String, Vec<u8>>,
    bindings: &[LegacyResourceBindingMapping],
) -> Vec<LegacyProgressEventMapping> {
    let namespace = frozen_namespace(EVENT_NAMESPACE);
    let mut events = Vec::new();
    for task in tasks {
        let Some(locator) = task.agent_log.as_deref() else {
            continue;
        };
        if task.status.as_deref() == Some("cancelled")
            && tasks.iter().any(|candidate| {
                candidate.id != task.id
                    && candidate.agent_log.as_deref() == Some(locator)
                    && candidate.status.as_deref() != Some("cancelled")
            })
        {
            continue;
        }
        let Some(bytes) = logs.get(locator) else {
            continue;
        };
        let Some(binding) = bindings.iter().find(|binding| {
            binding.node_id == task.id && binding.kind == "agent_log" && binding.locator == locator
        }) else {
            continue;
        };
        for (index, section) in parse_log_sections(bytes).into_iter().enumerate() {
            let source_item_key = format!("section:{index}");
            events.push(LegacyProgressEventMapping {
                id: Uuid::new_v5(
                    &namespace,
                    format!("{}:{source_item_key}", binding.id).as_bytes(),
                )
                .to_string(),
                subject_node_id: task.id.clone(),
                source_binding_id: binding.id.clone(),
                source_item_key,
                source_digest: sha256_hex(section.canonical.as_bytes()),
                summary: section.heading,
            });
        }
    }
    events
}

struct LegacyLogSection {
    heading: String,
    canonical: String,
}

fn parse_log_sections(bytes: &[u8]) -> Vec<LegacyLogSection> {
    let mut sections = Vec::new();
    let mut heading: Option<String> = None;
    let mut body = Vec::new();
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("## ") {
            if let Some(previous) = heading.replace(value.trim().to_owned()) {
                sections.push(log_section(previous, &body));
                body.clear();
            }
        } else if heading.is_some() {
            body.push(line);
        }
    }
    if let Some(last) = heading {
        sections.push(log_section(last, &body));
    }
    sections
}

fn log_section(heading: String, body: &[&str]) -> LegacyLogSection {
    let body = body.join("\n");
    LegacyLogSection {
        canonical: format!("{heading}\n{}", body.trim_end()),
        heading,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn plan_log_cursor_conflicts(
    tasks: &[LegacyTaskSource],
    logs: &BTreeMap<String, Vec<u8>>,
    conflicts: &mut ConflictAccumulator,
) {
    for task in tasks {
        let Some(locator) = task.agent_log.as_deref() else {
            continue;
        };
        let Some(bytes) = logs.get(locator) else {
            continue;
        };
        let section_count = String::from_utf8_lossy(bytes)
            .lines()
            .filter(|line| line.starts_with("## "))
            .count();
        if section_count == 0 {
            continue;
        }
        let cursor = task.cursor.as_ref();
        let missing = cursor.is_none_or(|value| {
            value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
        });
        if missing {
            conflicts.add(
                "log_cursor_missing",
                "warning",
                format!("task:{}:{locator}", task.id),
                "scan explicit log sections from the beginning and deduplicate by source identity",
                false,
            );
        } else if cursor
            .and_then(serde_yaml_ng::Value::as_u64)
            .is_some_and(|position| position < section_count as u64)
        {
            conflicts.add(
                "log_cursor_behind",
                "warning",
                format!("task:{}:{locator}", task.id),
                "plan unseen events without changing current status",
                false,
            );
        }
    }
}

fn safe_sibling_key(existing: &mut BTreeSet<String>, desired: &str, source_id: &str) -> String {
    if existing.insert(desired.into()) {
        return desired.into();
    }
    let compact_id = source_id.replace('-', "");
    for length in [8, 12, compact_id.len()] {
        let suffix = compact_id.chars().take(length).collect::<String>();
        let candidate = format!("{desired}-{suffix}");
        if existing.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!("source UUID must yield a unique deterministic sibling key")
}

impl ConflictAccumulator {
    fn add(
        &mut self,
        code: &str,
        severity: &'static str,
        evidence: String,
        safe_default: &'static str,
        requires_confirmation: bool,
    ) {
        let entry = self.0.entry(code.into()).or_insert_with(|| ConflictEntry {
            severity,
            evidence: BTreeSet::new(),
            safe_default,
            requires_confirmation,
        });
        entry.evidence.insert(evidence);
    }

    fn finish(self) -> Vec<LegacyConflict> {
        self.0
            .into_iter()
            .map(|(code, entry)| LegacyConflict {
                code,
                severity: entry.severity.into(),
                count: entry.evidence.len(),
                evidence: entry.evidence.into_iter().collect(),
                safe_default: entry.safe_default.into(),
                requires_confirmation: entry.requires_confirmation,
            })
            .collect()
    }
}

fn frozen_namespace(value: &str) -> Uuid {
    Uuid::parse_str(value).expect("frozen namespace UUID must be valid")
}

fn malformed(locator: &str) -> DomainError {
    DomainError::ImportSourceMalformed {
        locator: locator.into(),
    }
}

fn snapshot_context(
    root: &Path,
    locator: &str,
) -> Result<LegacyProjectContextSnapshot, DomainError> {
    let relative = validate_relative(locator)?;
    validate_context_locator(&relative, locator)?;
    let candidate = root.join(&relative);
    let exists = match fs::symlink_metadata(&candidate) {
        Ok(_) => {
            let canonical = fs::canonicalize(&candidate)?;
            ensure_below_root(root, &canonical, locator)?;
            let canonical_relative =
                canonical
                    .strip_prefix(root)
                    .map_err(|_| DomainError::ImportScopeOutsideRoot {
                        locator: locator.into(),
                    })?;
            if contains_component(canonical_relative, "coordination") {
                return Err(DomainError::ImportProtectedSource {
                    locator: locator.into(),
                });
            }
            if !canonical.is_dir() {
                return Err(DomainError::ImportContextNotDirectory {
                    locator: locator.into(),
                });
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(DomainError::Io(error)),
    };
    Ok(LegacyProjectContextSnapshot {
        locator: locator.into(),
        exists,
    })
}

fn validate_relative(locator: &str) -> Result<PathBuf, DomainError> {
    let relative = Path::new(locator);
    if relative.is_absolute() {
        return Err(DomainError::ImportScopeMustBeRelative {
            locator: locator.into(),
        });
    }
    if locator.is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(DomainError::ImportScopeOutsideRoot {
            locator: locator.into(),
        });
    }
    Ok(relative.to_path_buf())
}

fn ensure_below_root(root: &Path, candidate: &Path, locator: &str) -> Result<(), DomainError> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(DomainError::ImportScopeOutsideRoot {
            locator: locator.into(),
        })
    }
}

fn validate_source_kind(
    source_kind: LegacySourceKind,
    relative: &Path,
    locator: &str,
) -> Result<(), DomainError> {
    let matches = match source_kind {
        LegacySourceKind::TasksRegistry => relative == Path::new("registry/tasks.yaml"),
        LegacySourceKind::BacklogRegistry => relative == Path::new("registry/backlog.yaml"),
        LegacySourceKind::TaskManifest => relative.ends_with(Path::new(".workbench/task.yaml")),
        LegacySourceKind::AgentLog => relative
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("agent_log.md")),
    };
    if matches {
        Ok(())
    } else {
        Err(DomainError::ImportSourceKindMismatch {
            locator: locator.into(),
        })
    }
}

fn validate_context_locator(relative: &Path, locator: &str) -> Result<(), DomainError> {
    if contains_component(relative, "coordination") {
        return Err(DomainError::ImportProtectedSource {
            locator: locator.into(),
        });
    }
    if relative
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("context"))
    {
        Ok(())
    } else {
        Err(DomainError::ImportSourceKindMismatch {
            locator: locator.into(),
        })
    }
}

fn reject_protected_file_path(relative: &Path, locator: &str) -> Result<(), DomainError> {
    if contains_component(relative, "context") || contains_component(relative, "coordination") {
        Err(DomainError::ImportProtectedSource {
            locator: locator.into(),
        })
    } else {
        Ok(())
    }
}

fn contains_component(path: &Path, expected: &str) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value.eq_ignore_ascii_case(expected),
        _ => false,
    })
}

fn reject_duplicate_files(files: &[LegacySourceFileSnapshot]) -> Result<(), DomainError> {
    for pair in files.windows(2) {
        if pair[0].source_kind == pair[1].source_kind && pair[0].locator == pair[1].locator {
            return Err(DomainError::ImportScopeDuplicate {
                locator: pair[0].locator.clone(),
            });
        }
    }
    Ok(())
}

fn reject_duplicate_contexts(contexts: &[LegacyProjectContextSnapshot]) -> Result<(), DomainError> {
    for pair in contexts.windows(2) {
        if pair[0].locator == pair[1].locator {
            return Err(DomainError::ImportScopeDuplicate {
                locator: pair[0].locator.clone(),
            });
        }
    }
    Ok(())
}

fn digest_json(value: &impl Serialize) -> Result<String, DomainError> {
    Ok(hex_digest(&serde_json::to_vec(value)?))
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
