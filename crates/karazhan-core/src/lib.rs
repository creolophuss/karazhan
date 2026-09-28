use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension as _, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const SYSTEM_ROOT_ID: &str = "00000000-0000-0000-0000-000000000001";
const CORE_MIGRATION_1: &str = include_str!("../migrations/0001_core.sql");
const CORE_MIGRATION_2: &str = include_str!("../migrations/0002_resource_binding_audit.sql");
const CORE_MIGRATION_3: &str = include_str!("../migrations/0003_archive.sql");
const CORE_MIGRATION_4: &str = include_str!("../migrations/0004_progress_step_status.sql");
const CORE_MIGRATION_5: &str = include_str!("../migrations/0005_quick_items.sql");
const IMPORT_RUN_NAMESPACE: &str = "74285973-cf02-5e66-9165-a636fb71d94e";

pub mod application;
mod legacy_import;

pub use legacy_import::{
    LEGACY_RULESET_VERSION, LegacyBacklogMapping, LegacyConflict, LegacyDryRunReport,
    LegacyDryRunScope, LegacyDryRunSummary, LegacyNextActionTaskMapping,
    LegacyProgressEventMapping, LegacyProjectContextSnapshot, LegacyProjectMapping,
    LegacyResourceBindingMapping, LegacySourceFileSnapshot, LegacySourceKind, LegacyTaskMapping,
    LegacyTodayItemMapping, dry_run_legacy_source,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Root,
    Project,
    Task,
    Backlog,
}

impl NodeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Root => "root",
            Self::Project => "project",
            Self::Task => "task",
            Self::Backlog => "backlog",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Planned,
    Ready,
    InProgress,
    Pending,
    Review,
    Done,
    Cancelled,
}

impl WorkStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Planned => "planned",
            Self::Ready => "ready",
            Self::InProgress => "in_progress",
            Self::Pending => "pending",
            Self::Review => "review",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Urgent,
    High,
    Medium,
    Low,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressEventKind {
    Progress,
    Delivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Workspace,
    Manifest,
    AgentLog,
    Repository,
    ExternalSession,
    Url,
    File,
    Directory,
}

impl ResourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Manifest => "manifest",
            Self::AgentLog => "agent_log",
            Self::Repository => "repository",
            Self::ExternalSession => "external_session",
            Self::Url => "url",
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceAvailability {
    Available,
    Missing,
    Unreadable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BacklogKind {
    Idea,
    Problem,
    Request,
    Research,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BacklogStatus {
    Captured,
    Considering,
    Ready,
    Promoted,
    Discarded,
}

impl BacklogStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Captured => "captured",
            Self::Considering => "considering",
            Self::Ready => "ready",
            Self::Promoted => "promoted",
            Self::Discarded => "discarded",
        }
    }
}

impl BacklogKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idea => "idea",
            Self::Problem => "problem",
            Self::Request => "request",
            Self::Research => "research",
        }
    }
}

impl ResourceAvailability {
    fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Missing => "missing",
            Self::Unreadable => "unreadable",
            Self::Unknown => "unknown",
        }
    }
}

impl ProgressEventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Progress => "progress",
            Self::Delivery => "delivery",
        }
    }
}

impl Priority {
    fn as_str(self) -> &'static str {
        match self {
            Self::Urgent => "urgent",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TextChange<'a> {
    #[default]
    Keep,
    Set(&'a str),
    Clear,
}

impl<'a> TextChange<'a> {
    fn sql_parts(self) -> (i64, Option<&'a str>) {
        match self {
            Self::Keep => (0, None),
            Self::Set(value) => (1, Some(value)),
            Self::Clear => (1, None),
        }
    }

    fn digest_value(self) -> &'a str {
        match self {
            Self::Keep => "<keep>",
            Self::Set(value) => value,
            Self::Clear => "<clear>",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WorkItemPatch<'a> {
    pub title: Option<&'a str>,
    pub summary: TextChange<'a>,
    pub goal: TextChange<'a>,
    pub acceptance: TextChange<'a>,
    pub status: Option<WorkStatus>,
    pub priority: Option<Priority>,
    pub blocker: TextChange<'a>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorType {
    User,
    #[serde(rename = "task_agent")]
    Custodian,
    Medivh,
    System,
    Unknown,
}

impl ActorType {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Custodian => "task_agent",
            Self::Medivh => "medivh",
            Self::System => "system",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Ui,
    Api,
    Mcp,
    Import,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Api => "api",
            Self::Mcp => "mcp",
            Self::Import => "import",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandMetadata<'a> {
    pub idempotency_key: &'a str,
    pub actor_type: ActorType,
    pub actor_ref: Option<&'a str>,
    pub channel: Channel,
}

impl<'a> CommandMetadata<'a> {
    fn actor_label(self) -> &'a str {
        self.actor_ref.unwrap_or_else(|| self.actor_type.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MutationResult {
    pub revision: i64,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegacyLogSyncResult {
    pub event_id: String,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegacyApplyResult {
    pub run_id: String,
    pub status: String,
    pub report_digest: String,
    pub counts: CoreCounts,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewNode<'a> {
    pub id: &'a str,
    pub kind: NodeKind,
    pub parent_id: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProject<'a> {
    pub id: &'a str,
    pub parent_id: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub position: i64,
    pub slug: Option<&'a str>,
    pub context_path: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTask<'a> {
    pub id: &'a str,
    pub parent_id: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewBacklog<'a> {
    pub id: &'a str,
    pub parent_id: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub notes: Option<&'a str>,
    pub kind: BacklogKind,
    pub priority: Priority,
    pub tags_json: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProgressEvent<'a> {
    pub id: &'a str,
    pub kind: ProgressEventKind,
    pub summary: &'a str,
    pub step_status: Option<WorkStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewResourceBinding<'a> {
    pub id: &'a str,
    pub node_id: &'a str,
    pub kind: ResourceKind,
    pub locator: &'a str,
    pub is_primary: bool,
    pub availability: ResourceAvailability,
    pub source: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BacklogPatch<'a> {
    pub title: Option<&'a str>,
    pub notes: TextChange<'a>,
    pub kind: Option<BacklogKind>,
    pub priority: Option<Priority>,
    pub tags_json: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromotionTarget<'a> {
    Project(NewProject<'a>),
    ProjectAtEnd(NewProject<'a>),
    Task(NewTask<'a>),
    TaskAtEnd(NewTask<'a>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromotionResult {
    pub target_node_id: String,
    pub source_revision: i64,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Project {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub summary: Option<String>,
    pub goal: Option<String>,
    pub acceptance: Option<String>,
    pub status: String,
    pub priority: String,
    pub blocker: Option<String>,
    pub slug: Option<String>,
    pub context_path: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Task {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub summary: Option<String>,
    pub goal: Option<String>,
    pub acceptance: Option<String>,
    pub status: String,
    pub priority: String,
    pub blocker: Option<String>,
    pub revision: i64,
    pub has_steps: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectTaskItem {
    pub id: String,
    pub parent_id: String,
    pub kind: String,
    pub key: String,
    pub title: String,
    pub summary: Option<String>,
    pub goal: Option<String>,
    pub acceptance: Option<String>,
    pub status: String,
    pub priority: String,
    pub blocker: Option<String>,
    pub position: i64,
    pub revision: i64,
    pub has_steps: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TodayItem {
    pub node_id: String,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub path_titles: Vec<String>,
    pub position: i64,
    /// Revision of the Today membership, used by remove and reorder commands.
    pub revision: i64,
    /// Revision of the underlying WorkNode, used by field update commands.
    pub work_revision: i64,
    pub status: String,
    pub priority: String,
    pub blocker: Option<String>,
    pub has_steps: bool,
    pub has_available_workspace: bool,
    pub direct_child_tasks: Vec<Task>,
    pub is_quick_item: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProgressEvent {
    pub id: String,
    pub subject_node_id: String,
    pub occurred_at: String,
    pub recorded_at: String,
    pub event_type: String,
    pub summary: String,
    pub step_status: Option<String>,
    pub blocker: Option<String>,
    pub actor_type: String,
    pub actor_ref: Option<String>,
    pub channel: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ResourceBinding {
    pub id: String,
    pub node_id: String,
    pub kind: String,
    pub locator: String,
    pub is_primary: bool,
    pub availability: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_actor: String,
    pub updated_actor: String,
    pub write_source: String,
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backlog {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    pub priority: String,
    pub position: i64,
    pub revision: i64,
    pub backlog_kind: String,
    pub backlog_status: String,
    pub notes: Option<String>,
    pub tags_json: String,
    pub source: Option<String>,
    pub promoted_node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct BacklogFilter {
    pub parent_id: Option<String>,
    pub kind: Option<BacklogKind>,
    pub status: Option<BacklogStatus>,
    pub priority: Option<Priority>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BacklogItem {
    pub id: String,
    pub parent_id: String,
    pub parent_breadcrumb: Vec<String>,
    pub key: String,
    pub title: String,
    pub priority: String,
    pub position: i64,
    pub revision: i64,
    pub backlog_kind: String,
    pub backlog_status: String,
    pub notes: Option<String>,
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub promoted_node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegrityReport {
    pub integrity: String,
    pub foreign_key_violations: usize,
    pub invariant_violations: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CoreCounts {
    pub work_nodes: i64,
    pub projects: i64,
    pub tasks: i64,
    pub backlog_items: i64,
    pub today_items: i64,
    pub progress_events: i64,
    pub resource_bindings: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub counts: CoreCounts,
}

#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("invalid parent kind")]
    InvalidParentKind,
    #[error("work tree cycle")]
    WorkTreeCycle,
    #[error("sibling key already exists under target parent")]
    SiblingKeyConflict,
    #[error("sibling position already exists under target parent")]
    SiblingPositionConflict,
    #[error("target position is outside the sibling list")]
    InvalidPosition,
    #[error("backlog state does not allow this operation")]
    InvalidBacklogState,
    #[error("requested object was not found")]
    NotFound,
    #[error("work item is already archived")]
    AlreadyArchived,
    #[error("work item must be archived before it can be permanently deleted")]
    NotArchived,
    #[error("archived work items cannot accept new children or Today membership")]
    ArchivedNode,
    #[error("a primary resource of this kind already exists for the node")]
    PrimaryResourceConflict,
    #[error("the resource binding already exists")]
    ResourceBindingConflict,
    #[error("JSON value does not match the required structure")]
    InvalidJson,
    #[error("object already exists")]
    AlreadyExists,
    #[error("constraint violation: {0}")]
    ConstraintViolation(String),
    #[error("today accepts only projects and tasks")]
    InvalidTodayTarget,
    #[error("operation accepts only Today quick items")]
    InvalidQuickItem,
    #[error("revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
    #[error("migration {version} checksum mismatch")]
    MigrationChecksum { version: i64 },
    #[error("migration is already running in another process")]
    MigrationBusy,
    #[error("WAL checkpoint could not finish before backup")]
    BackupBusy,
    #[error("backup failed integrity verification")]
    BackupIntegrity,
    #[error("backup destination already exists")]
    BackupDestinationExists,
    #[error(
        "restore validation failed; diagnostic database retained at {diagnostic_path}: {reason}"
    )]
    RestoreValidation {
        diagnostic_path: PathBuf,
        reason: String,
    },
    #[error("idempotency key was already used with a different request")]
    IdempotencyConflict,
    #[error("update patch does not change any field")]
    EmptyPatch,
    #[error("legacy source record changed after it was imported")]
    SourceRecordMutated,
    #[error("legacy apply ruleset does not match the current ruleset")]
    ImportRulesetMismatch,
    #[error("legacy apply report digest does not match the current dry-run")]
    ImportReportDigestMismatch,
    #[error("legacy source snapshot changed after dry-run")]
    ImportSourceSnapshotChanged,
    #[error("legacy dry-run contains blocking conflicts")]
    ImportNotEligible,
    #[error("legacy source root is missing or is not a directory: {source_root}")]
    ImportSourceRootInvalid { source_root: String },
    #[error("legacy scope locator must be relative: {locator}")]
    ImportScopeMustBeRelative { locator: String },
    #[error("legacy scope locator escapes the trusted source root: {locator}")]
    ImportScopeOutsideRoot { locator: String },
    #[error("legacy scope contains a duplicate locator: {locator}")]
    ImportScopeDuplicate { locator: String },
    #[error("legacy source file is missing: {locator}")]
    ImportSourceMissing { locator: String },
    #[error("legacy source locator is not a file: {locator}")]
    ImportSourceNotFile { locator: String },
    #[error("legacy source locator does not match its declared source kind: {locator}")]
    ImportSourceKindMismatch { locator: String },
    #[error("legacy source is malformed: {locator}")]
    ImportSourceMalformed { locator: String },
    #[error("legacy source locator targets protected Context or coordination content: {locator}")]
    ImportProtectedSource { locator: String },
    #[error("legacy Context locator is not a directory: {locator}")]
    ImportContextNotDirectory { locator: String },
    #[error("JSON serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("storage error: {0}")]
    Storage(rusqlite::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

impl From<rusqlite::Error> for DomainError {
    fn from(error: rusqlite::Error) -> Self {
        map_storage_error(error)
    }
}

impl DomainError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidParentKind => "invalid_parent_kind",
            Self::WorkTreeCycle => "work_tree_cycle",
            Self::SiblingKeyConflict => "sibling_key_conflict",
            Self::SiblingPositionConflict => "sibling_position_conflict",
            Self::InvalidPosition => "invalid_position",
            Self::InvalidBacklogState => "invalid_backlog_state",
            Self::NotFound => "not_found",
            Self::AlreadyArchived => "already_archived",
            Self::NotArchived => "not_archived",
            Self::ArchivedNode => "archived_node",
            Self::PrimaryResourceConflict => "primary_resource_conflict",
            Self::ResourceBindingConflict => "resource_binding_conflict",
            Self::InvalidJson => "invalid_json",
            Self::AlreadyExists => "already_exists",
            Self::ConstraintViolation(_) => "constraint_violation",
            Self::InvalidTodayTarget => "invalid_today_target",
            Self::InvalidQuickItem => "invalid_quick_item",
            Self::RevisionConflict { .. } => "revision_conflict",
            Self::MigrationChecksum { .. } => "migration_checksum",
            Self::MigrationBusy => "migration_busy",
            Self::BackupBusy => "backup_busy",
            Self::BackupIntegrity => "backup_integrity",
            Self::BackupDestinationExists => "backup_destination_exists",
            Self::RestoreValidation { .. } => "restore_validation",
            Self::IdempotencyConflict => "idempotency_conflict",
            Self::EmptyPatch => "empty_patch",
            Self::SourceRecordMutated => "source_record_mutated",
            Self::ImportRulesetMismatch => "ruleset_mismatch",
            Self::ImportReportDigestMismatch => "report_digest_mismatch",
            Self::ImportSourceSnapshotChanged => "source_snapshot_changed",
            Self::ImportNotEligible => "import_not_eligible",
            Self::ImportSourceRootInvalid { .. } => "import_source_root_invalid",
            Self::ImportScopeMustBeRelative { .. } => "import_scope_must_be_relative",
            Self::ImportScopeOutsideRoot { .. } => "import_scope_outside_root",
            Self::ImportScopeDuplicate { .. } => "import_scope_duplicate",
            Self::ImportSourceMissing { .. } => "import_source_missing",
            Self::ImportSourceNotFile { .. } => "import_source_not_file",
            Self::ImportSourceKindMismatch { .. } => "import_source_kind_mismatch",
            Self::ImportSourceMalformed { .. } => "import_source_malformed",
            Self::ImportProtectedSource { .. } => "import_protected_source",
            Self::ImportContextNotDirectory { .. } => "import_context_not_directory",
            Self::Json(_) => "json_error",
            Self::Storage(_) => "storage_error",
            Self::Io(_) => "io_error",
        }
    }
}

pub struct Database {
    connection: Connection,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DomainError> {
        let path = path.as_ref();
        let migration_lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(migration_lock_path(path))?;
        if let Err(error) = migration_lock.try_lock() {
            let error: std::io::Error = error.into();
            return if error.kind() == ErrorKind::WouldBlock {
                Err(DomainError::MigrationBusy)
            } else {
                Err(DomainError::Io(error))
            };
        }
        Self::initialize(Connection::open(path)?, Some(path))
    }

    pub fn open_in_memory() -> Result<Self, DomainError> {
        Self::initialize(Connection::open_in_memory()?, None)
    }

    fn initialize(
        mut connection: Connection,
        database_path: Option<&Path>,
    ) -> Result<Self, DomainError> {
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY,
               checksum TEXT NOT NULL,
               applied_at TEXT NOT NULL
             ) STRICT;",
        )?;
        let applied_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })?;
        let mut backed_up = false;
        for (version, sql) in [
            (1, CORE_MIGRATION_1),
            (2, CORE_MIGRATION_2),
            (3, CORE_MIGRATION_3),
            (4, CORE_MIGRATION_4),
            (5, CORE_MIGRATION_5),
        ] {
            let applied = connection
                .query_row(
                    "SELECT 1 FROM schema_migrations WHERE version = ?1",
                    [version],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !applied && applied_count > 0 && !backed_up {
                let path = database_path.ok_or(DomainError::BackupIntegrity)?;
                create_pre_migration_backup(&connection, path, version)?;
                backed_up = true;
            }
            apply_migration(&mut connection, version, sql)?;
        }
        Ok(Self { connection })
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<CoreCounts, DomainError> {
        let destination = destination.as_ref();
        if destination.exists() {
            return Err(DomainError::BackupDestinationExists);
        }
        checkpoint_wal(&self.connection)?;
        self.connection
            .backup(rusqlite::MAIN_DB, destination, None)?;
        finalize_and_validate_backup(destination)
    }

    pub fn restore_from(
        target_path: impl AsRef<Path>,
        backup_path: impl AsRef<Path>,
    ) -> Result<RestoreReport, DomainError> {
        let target_path = target_path.as_ref();
        let backup_path = backup_path.as_ref();
        let migration_lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(migration_lock_path(target_path))?;
        if let Err(error) = migration_lock.try_lock() {
            let error: std::io::Error = error.into();
            return if error.kind() == ErrorKind::WouldBlock {
                Err(DomainError::MigrationBusy)
            } else {
                Err(DomainError::Io(error))
            };
        }

        let temporary_path = restore_temporary_path(target_path)?;
        let restored = (|| -> Result<CoreCounts, DomainError> {
            let source = Connection::open_with_flags(
                backup_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            source.backup(rusqlite::MAIN_DB, &temporary_path, None)?;
            finalize_and_validate_backup(&temporary_path)
        })();
        let counts = match restored {
            Ok(counts) => counts,
            Err(error) => {
                let diagnostic_path = if temporary_path.exists() {
                    temporary_path
                } else {
                    backup_path.to_path_buf()
                };
                return Err(DomainError::RestoreValidation {
                    diagnostic_path,
                    reason: error.to_string(),
                });
            }
        };

        if target_path.exists() {
            let target = Connection::open(target_path)?;
            checkpoint_wal(&target)?;
            target.pragma_update(None, "journal_mode", "DELETE")?;
        }
        std::fs::rename(&temporary_path, target_path)?;
        Ok(RestoreReport { counts })
    }

    pub fn create_project(
        &mut self,
        project: NewProject<'_>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        self.create_project_with_summary(project, None, metadata)
    }

    pub fn create_project_with_summary(
        &mut self,
        project: NewProject<'_>,
        summary: Option<&str>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        self.create_node_with_project_fields(
            NewNode {
                id: project.id,
                kind: NodeKind::Project,
                parent_id: project.parent_id,
                key: project.key,
                title: project.title,
                position: project.position,
            },
            summary,
            project.slug,
            project.context_path,
            metadata,
        )
    }

    pub fn create_task(
        &mut self,
        task: NewTask<'_>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        self.create_task_with_summary(task, None, metadata)
    }

    pub fn create_task_with_summary(
        &mut self,
        task: NewTask<'_>,
        summary: Option<&str>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        self.create_node_with_summary(
            NewNode {
                id: task.id,
                kind: NodeKind::Task,
                parent_id: task.parent_id,
                key: task.key,
                title: task.title,
                position: task.position,
            },
            summary,
            metadata,
        )
    }

    pub fn create_backlog(
        &mut self,
        backlog: NewBacklog<'_>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request_digest = digest_fields(&[
            "create_backlog",
            backlog.id,
            backlog.parent_id,
            backlog.key,
            backlog.title,
            backlog.notes.unwrap_or(""),
            backlog.kind.as_str(),
            backlog.priority.as_str(),
            backlog.tags_json,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM work_nodes WHERE parent_id = ?1",
            [backlog.parent_id],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO work_nodes (
               id, kind, parent_id, key, title, priority, position,
               created_at, updated_at, created_actor, updated_actor, write_source, revision
             ) VALUES (
               ?1, 'backlog', ?2, ?3, ?4, ?5, ?6,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?7, ?7, ?8, 1
             )",
            params![
                backlog.id,
                backlog.parent_id,
                backlog.key,
                backlog.title,
                backlog.priority.as_str(),
                position,
                metadata.actor_label(),
                metadata.channel.as_str(),
            ],
        )
        .map_err(map_storage_error)?;
        tx.execute(
            "INSERT INTO backlog_items (
               node_id, backlog_kind, backlog_status, notes, tags_json
             ) VALUES (?1, ?2, 'captured', ?3, ?4)",
            params![
                backlog.id,
                backlog.kind.as_str(),
                backlog.notes,
                backlog.tags_json,
            ],
        )?;
        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "create_backlog",
            &request_digest,
            1,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: 1,
            replayed: false,
        })
    }

    pub fn create_quick_item(
        &mut self,
        node_id: &str,
        description: &str,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let request_digest = digest_fields(&[
            "create_quick_item",
            node_id,
            description,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let tree_position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM work_nodes WHERE parent_id = ?1",
            [SYSTEM_ROOT_ID],
            |row| row.get(0),
        )?;
        let today_position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM today_items",
            [],
            |row| row.get(0),
        )?;
        let key = format!("quick-{node_id}");
        tx.execute(
            "INSERT INTO work_nodes (
               id, kind, parent_id, key, title, work_status, priority, position,
               created_at, updated_at, created_actor, updated_actor, write_source, revision
             ) VALUES (
               ?1, 'task', ?2, ?3, ?4, 'planned', 'none', ?5,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?6, ?6, ?7, 1
             )",
            params![
                node_id,
                SYSTEM_ROOT_ID,
                key,
                description,
                tree_position,
                metadata.actor_label(),
                metadata.channel.as_str(),
            ],
        )
        .map_err(map_storage_error)?;
        tx.execute(
            "INSERT INTO tasks (node_id, is_quick_item) VALUES (?1, 1)",
            [node_id],
        )?;
        tx.execute(
            "INSERT INTO today_items (node_id, position, added_at, added_actor, revision)
             VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?3, 1)",
            params![node_id, today_position, metadata.actor_label()],
        )?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'today_added', 'added quick item to Today', ?3, ?4, ?5
             )",
            params![
                event_id,
                node_id,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "create_quick_item",
            &request_digest,
            1,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: 1,
            replayed: false,
        })
    }

    pub fn delete_quick_item(
        &mut self,
        node_id: &str,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "delete_quick_item",
            node_id,
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let (actual_revision, is_quick_item): (i64, bool) = tx.query_row(
            "SELECT n.revision, t.is_quick_item
             FROM work_nodes n JOIN tasks t ON t.node_id = n.id
             WHERE n.id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if !is_quick_item {
            return Err(DomainError::InvalidQuickItem);
        }
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        tx.execute(
            "DELETE FROM progress_events WHERE subject_node_id = ?1",
            [node_id],
        )?;
        tx.execute("DELETE FROM work_nodes WHERE id = ?1", [node_id])?;
        let result_revision = actual_revision + 1;
        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "delete_quick_item",
            &request_digest,
            result_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: result_revision,
            replayed: false,
        })
    }

    pub fn get_project(&self, id: &str) -> Result<Project, DomainError> {
        Ok(self.connection.query_row(
            "SELECT n.id, n.parent_id, n.key, n.title, n.summary, n.goal,
                    n.acceptance_markdown, n.work_status, n.priority, n.blocker,
                    p.slug, p.context_path, n.revision
             FROM work_nodes n JOIN projects p ON p.node_id = n.id
             WHERE n.id = ?1",
            [id],
            project_from_row,
        )?)
    }

    pub fn list_projects(&self) -> Result<Vec<Project>, DomainError> {
        let mut statement = self.connection.prepare(
            "SELECT n.id, n.parent_id, n.key, n.title, n.summary, n.goal,
                    n.acceptance_markdown, n.work_status, n.priority, n.blocker,
                    p.slug, p.context_path, n.revision
             FROM work_nodes n JOIN projects p ON p.node_id = n.id
             ORDER BY n.parent_id, n.position, n.id",
        )?;
        Ok(statement
            .query_map([], project_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_task(&self, id: &str) -> Result<Task, DomainError> {
        Ok(self.connection.query_row(
            "SELECT n.id, n.parent_id, n.key, n.title, n.summary, n.goal,
                    n.acceptance_markdown, n.work_status, n.priority, n.blocker, n.revision,
                    EXISTS (SELECT 1 FROM progress_events pe
                            WHERE pe.subject_node_id = n.id
                              AND pe.event_type IN ('progress', 'delivery')
                              AND pe.summary <> 'work item fields updated')
             FROM work_nodes n JOIN tasks t ON t.node_id = n.id
             WHERE n.id = ?1",
            [id],
            task_from_row,
        )?)
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>, DomainError> {
        let mut statement = self.connection.prepare(
            "SELECT n.id, n.parent_id, n.key, n.title, n.summary, n.goal,
                    n.acceptance_markdown, n.work_status, n.priority, n.blocker, n.revision,
                    EXISTS (SELECT 1 FROM progress_events pe
                            WHERE pe.subject_node_id = n.id
                              AND pe.event_type IN ('progress', 'delivery')
                              AND pe.summary <> 'work item fields updated')
             FROM work_nodes n JOIN tasks t ON t.node_id = n.id
             ORDER BY n.parent_id, n.position, n.id",
        )?;
        Ok(statement
            .query_map([], task_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_project_task_tree(&self) -> Result<Vec<ProjectTaskItem>, DomainError> {
        self.list_project_task_tree_by_archive_state(false)
    }

    pub fn list_archived_project_task_tree(&self) -> Result<Vec<ProjectTaskItem>, DomainError> {
        self.list_project_task_tree_by_archive_state(true)
    }

    fn list_project_task_tree_by_archive_state(
        &self,
        archived: bool,
    ) -> Result<Vec<ProjectTaskItem>, DomainError> {
        let mut statement = self.connection.prepare(
            "SELECT n.id, n.parent_id, n.kind, n.key, n.title, n.summary, n.goal,
                    n.acceptance_markdown, n.work_status, n.priority, n.blocker, n.position,
                    n.revision,
                    EXISTS (SELECT 1 FROM progress_events pe
                            WHERE pe.subject_node_id = n.id
                              AND pe.event_type IN ('progress', 'delivery')
                              AND pe.summary <> 'work item fields updated')
             FROM work_nodes n
             WHERE n.kind IN ('project', 'task')
               AND NOT EXISTS (
                 SELECT 1 FROM tasks quick
                 WHERE quick.node_id = n.id AND quick.is_quick_item = 1
               )
               AND ((?1 = 1 AND n.archived_at IS NOT NULL)
                 OR (?1 = 0 AND n.archived_at IS NULL))
             ORDER BY n.parent_id, n.position, n.id",
        )?;
        Ok(statement
            .query_map([archived], |row| {
                Ok(ProjectTaskItem {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    kind: row.get(2)?,
                    key: row.get(3)?,
                    title: row.get(4)?,
                    summary: row.get(5)?,
                    goal: row.get(6)?,
                    acceptance: row.get(7)?,
                    status: row.get(8)?,
                    priority: row.get(9)?,
                    blocker: row.get(10)?,
                    position: row.get(11)?,
                    revision: row.get(12)?,
                    has_steps: row.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn archive_subtree(
        &mut self,
        node_id: &str,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "archive_subtree",
            node_id,
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let (kind, actual_revision, archived): (String, i64, bool) = tx.query_row(
            "SELECT kind, revision, archived_at IS NOT NULL FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if kind != "project" && kind != "task" {
            return Err(DomainError::InvalidParentKind);
        }
        if archived {
            return Err(DomainError::AlreadyArchived);
        }
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        tx.execute(
            "WITH RECURSIVE subtree(id) AS (
               SELECT ?1
               UNION ALL
               SELECT n.id FROM work_nodes n JOIN subtree s ON n.parent_id = s.id
             )
             UPDATE work_nodes
             SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?2,
                 write_source = ?3,
                 revision = revision + 1
             WHERE id IN (SELECT id FROM subtree)",
            params![node_id, metadata.actor_label(), metadata.channel.as_str()],
        )?;
        tx.execute(
            "WITH RECURSIVE subtree(id) AS (
               SELECT ?1
               UNION ALL
               SELECT n.id FROM work_nodes n JOIN subtree s ON n.parent_id = s.id
             )
             DELETE FROM today_items WHERE node_id IN (SELECT id FROM subtree)",
            [node_id],
        )?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'progress', 'archived with descendants', ?3, ?4, ?5
             )",
            params![
                event_id,
                node_id,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        let result_revision = actual_revision + 1;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "archive_subtree",
            &request_digest,
            result_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: result_revision,
            replayed: false,
        })
    }

    pub fn reopen_archived_subtree(
        &mut self,
        node_id: &str,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "reopen_archived_subtree",
            node_id,
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let (kind, actual_revision, archived): (String, i64, bool) = tx.query_row(
            "SELECT kind, revision, archived_at IS NOT NULL FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if kind != "project" && kind != "task" {
            return Err(DomainError::InvalidParentKind);
        }
        if !archived {
            return Err(DomainError::NotArchived);
        }
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        tx.execute(
            "WITH RECURSIVE
               subtree(id) AS (
                 SELECT ?1
                 UNION ALL
                 SELECT n.id FROM work_nodes n JOIN subtree s ON n.parent_id = s.id
               ),
               ancestors(id, parent_id) AS (
                 SELECT id, parent_id FROM work_nodes WHERE id = ?1
                 UNION ALL
                 SELECT n.id, n.parent_id FROM work_nodes n JOIN ancestors a ON n.id = a.parent_id
               ),
               reopened(id) AS (
                 SELECT id FROM subtree
                 UNION
                 SELECT id FROM ancestors WHERE id <> ?2
               )
             UPDATE work_nodes
             SET archived_at = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?3,
                 write_source = ?4,
                 revision = revision + 1
             WHERE id IN (SELECT id FROM reopened) AND archived_at IS NOT NULL",
            params![
                node_id,
                SYSTEM_ROOT_ID,
                metadata.actor_label(),
                metadata.channel.as_str(),
            ],
        )?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'progress', 'reopened from Archive', ?3, ?4, ?5
             )",
            params![
                event_id,
                node_id,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        ensure_no_invariant_violations(&tx)?;
        let result_revision = actual_revision + 1;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "reopen_archived_subtree",
            &request_digest,
            result_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: result_revision,
            replayed: false,
        })
    }

    pub fn permanently_delete_archived_subtree(
        &mut self,
        node_id: &str,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "permanently_delete_archived_subtree",
            node_id,
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let (kind, actual_revision, archived): (String, i64, bool) = tx.query_row(
            "SELECT kind, revision, archived_at IS NOT NULL FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if kind != "project" && kind != "task" {
            return Err(DomainError::InvalidParentKind);
        }
        if !archived {
            return Err(DomainError::NotArchived);
        }
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        let nodes = {
            let mut statement = tx.prepare(
                "WITH RECURSIVE subtree(id, depth) AS (
                   SELECT ?1, 0
                   UNION ALL
                   SELECT n.id, s.depth + 1
                   FROM work_nodes n JOIN subtree s ON n.parent_id = s.id
                 )
                 SELECT id FROM subtree ORDER BY depth DESC",
            )?;
            statement
                .query_map([node_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &nodes {
            tx.execute(
                "DELETE FROM progress_events WHERE subject_node_id = ?1",
                [id],
            )?;
            tx.execute("DELETE FROM work_nodes WHERE id = ?1", [id])?;
        }
        let result_revision = actual_revision + 1;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "permanently_delete_archived_subtree",
            &request_digest,
            result_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: result_revision,
            replayed: false,
        })
    }

    pub fn list_today(&self) -> Result<Vec<TodayItem>, DomainError> {
        let explicit_items = {
            let mut statement = self.connection.prepare(
                "SELECT n.id, n.kind, n.title, n.summary, ti.position, ti.revision,
                        n.revision, n.work_status, n.priority, n.blocker,
                        EXISTS (SELECT 1 FROM progress_events pe
                                WHERE pe.subject_node_id = n.id
                                  AND pe.event_type IN ('progress', 'delivery')
                                  AND pe.summary <> 'work item fields updated'),
                        COALESCE((SELECT is_quick_item FROM tasks WHERE node_id = n.id), 0)
                 FROM today_items ti
                 JOIN work_nodes n ON n.id = ti.node_id
                 WHERE n.archived_at IS NULL
                 ORDER BY ti.position, n.id",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, bool>(10)?,
                        row.get::<_, bool>(11)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut result = Vec::with_capacity(explicit_items.len());
        for (
            node_id,
            kind,
            title,
            summary,
            position,
            revision,
            work_revision,
            status,
            priority,
            blocker,
            has_steps,
            is_quick_item,
        ) in explicit_items
        {
            let has_available_workspace = self.connection.query_row(
                "SELECT EXISTS (
                   SELECT 1 FROM resource_bindings
                   WHERE node_id = ?1
                     AND kind = 'workspace'
                     AND is_primary = 1
                     AND availability = 'available'
                 )",
                [&node_id],
                |row| row.get::<_, bool>(0),
            )?;
            let path_titles = {
                let mut statement = self.connection.prepare(
                    "WITH RECURSIVE path(id, parent_id, title, depth) AS (
                       SELECT id, parent_id, title, 0 FROM work_nodes WHERE id = ?1
                       UNION ALL
                       SELECT parent.id, parent.parent_id, parent.title, path.depth + 1
                       FROM work_nodes parent JOIN path ON parent.id = path.parent_id
                     )
                     SELECT title FROM path
                     WHERE id <> ?2
                     ORDER BY depth DESC",
                )?;
                statement
                    .query_map(params![&node_id, SYSTEM_ROOT_ID], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?
            };
            let direct_child_tasks = {
                let mut statement = self.connection.prepare(
                    "SELECT n.id, n.parent_id, n.key, n.title, n.summary, n.goal,
                            n.acceptance_markdown, n.work_status, n.priority, n.blocker,
                            n.revision,
                            EXISTS (SELECT 1 FROM progress_events pe
                                    WHERE pe.subject_node_id = n.id
                                      AND pe.event_type IN ('progress', 'delivery')
                                      AND pe.summary <> 'work item fields updated')
                     FROM work_nodes n JOIN tasks t ON t.node_id = n.id
                     WHERE n.parent_id = ?1
                       AND n.archived_at IS NULL
                       AND NOT EXISTS (
                         SELECT 1 FROM today_items ti WHERE ti.node_id = n.id
                       )
                     ORDER BY n.position, n.id",
                )?;
                statement
                    .query_map([&node_id], task_from_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            result.push(TodayItem {
                node_id,
                kind,
                title,
                summary,
                path_titles,
                position,
                revision,
                work_revision,
                status,
                priority,
                blocker,
                has_steps,
                has_available_workspace,
                direct_child_tasks,
                is_quick_item,
            });
        }
        Ok(result)
    }

    pub fn recent_progress_events(
        &self,
        node_id: &str,
        limit: usize,
    ) -> Result<Vec<ProgressEvent>, DomainError> {
        let mut statement = self.connection.prepare(
            "SELECT id, subject_node_id, occurred_at, recorded_at, event_type,
                    summary, step_status, blocker, actor_type, actor_ref, channel
             FROM progress_events
             WHERE subject_node_id = ?1
               AND event_type IN ('progress', 'delivery')
               AND summary <> 'work item fields updated'
             ORDER BY occurred_at DESC, recorded_at DESC, id DESC
             LIMIT ?2",
        )?;
        Ok(statement
            .query_map(params![node_id, limit as i64], progress_event_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn progress_timeline(&self, node_id: &str) -> Result<Vec<ProgressEvent>, DomainError> {
        let mut statement = self.connection.prepare(
            "SELECT id, subject_node_id, occurred_at, recorded_at, event_type,
                    summary, step_status, blocker, actor_type, actor_ref, channel
             FROM progress_events
             WHERE subject_node_id = ?1
             ORDER BY occurred_at, recorded_at, id",
        )?;
        Ok(statement
            .query_map([node_id], progress_event_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_resource_bindings(
        &self,
        node_id: &str,
    ) -> Result<Vec<ResourceBinding>, DomainError> {
        let mut statement = self.connection.prepare(
            "SELECT id, node_id, kind, locator, is_primary, availability, source,
                    created_at, updated_at, created_actor, updated_actor, write_source, revision
             FROM resource_bindings
             WHERE node_id = ?1
             ORDER BY kind, is_primary DESC, locator, id",
        )?;
        Ok(statement
            .query_map([node_id], resource_binding_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn project_context_path(&self, node_id: &str) -> Result<Option<String>, DomainError> {
        Ok(self
            .connection
            .query_row(
                "WITH RECURSIVE ancestors(id, parent_id, kind, depth) AS (
                   SELECT id, parent_id, kind, 0 FROM work_nodes WHERE id = ?1
                   UNION ALL
                   SELECT parent.id, parent.parent_id, parent.kind, child.depth + 1
                   FROM work_nodes parent
                   JOIN ancestors child ON parent.id = child.parent_id
                 )
                 SELECT projects.context_path
                 FROM ancestors
                 JOIN projects ON projects.node_id = ancestors.id
                 ORDER BY ancestors.depth
                 LIMIT 1",
                [node_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn get_backlog(&self, node_id: &str) -> Result<Backlog, DomainError> {
        Ok(self.connection.query_row(
            "SELECT n.id, n.parent_id, n.key, n.title, n.priority, n.position, n.revision,
                    b.backlog_kind, b.backlog_status, b.notes, b.tags_json, b.source,
                    b.promoted_node_id
             FROM work_nodes n
             JOIN backlog_items b ON b.node_id = n.id
             WHERE n.id = ?1",
            [node_id],
            backlog_from_row,
        )?)
    }

    pub fn list_backlog(&self, filter: &BacklogFilter) -> Result<Vec<BacklogItem>, DomainError> {
        let kind = filter.kind.map(BacklogKind::as_str);
        let status = filter.status.map(BacklogStatus::as_str);
        let priority = filter.priority.map(Priority::as_str);
        let mut statement = self.connection.prepare(
            "SELECT n.id, n.parent_id, n.key, n.title, n.priority, n.position, n.revision,
                    b.backlog_kind, b.backlog_status, b.notes, b.tags_json, b.source,
                    b.promoted_node_id
             FROM work_nodes n
             JOIN backlog_items b ON b.node_id = n.id
             WHERE n.archived_at IS NULL
               AND (?1 IS NULL OR n.parent_id = ?1)
               AND (?2 IS NULL OR b.backlog_kind = ?2)
               AND ((?3 IS NULL AND b.backlog_status NOT IN ('discarded', 'promoted')) OR b.backlog_status = ?3)
               AND (?4 IS NULL OR n.priority = ?4)
               AND (?5 IS NULL OR EXISTS (
                 SELECT 1 FROM json_each(b.tags_json) WHERE value = ?5
               ))
             ORDER BY n.parent_id, n.position, n.id",
        )?;
        let backlog = statement
            .query_map(
                params![
                    filter.parent_id.as_deref(),
                    kind,
                    status,
                    priority,
                    filter.tag.as_deref()
                ],
                backlog_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut result = Vec::with_capacity(backlog.len());
        for item in backlog {
            let parent_breadcrumb = {
                let mut statement = self.connection.prepare(
                    "WITH RECURSIVE path(id, parent_id, title, depth) AS (
                       SELECT id, parent_id, title, 0 FROM work_nodes WHERE id = ?1
                       UNION ALL
                       SELECT parent.id, parent.parent_id, parent.title, path.depth + 1
                       FROM work_nodes parent JOIN path ON parent.id = path.parent_id
                     )
                     SELECT title FROM path
                     WHERE id <> ?2
                     ORDER BY depth DESC",
                )?;
                statement
                    .query_map(params![&item.parent_id, SYSTEM_ROOT_ID], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?
            };
            result.push(BacklogItem {
                id: item.id,
                parent_id: item.parent_id,
                parent_breadcrumb,
                key: item.key,
                title: item.title,
                priority: item.priority,
                position: item.position,
                revision: item.revision,
                backlog_kind: item.backlog_kind,
                backlog_status: item.backlog_status,
                notes: item.notes,
                tags: serde_json::from_str(&item.tags_json)?,
                source: item.source,
                promoted_node_id: item.promoted_node_id,
            });
        }
        Ok(result)
    }

    pub fn move_backlog(
        &mut self,
        node_id: &str,
        parent_id: &str,
        target_position: Option<usize>,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let target_position_text = target_position.map(|value| value.to_string());
        let request_digest = digest_fields(&[
            "move_backlog",
            node_id,
            parent_id,
            target_position_text.as_deref().unwrap_or(""),
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }

        let (actual_revision, status): (i64, String) = tx.query_row(
            "SELECT n.revision, b.backlog_status
             FROM work_nodes n JOIN backlog_items b ON b.node_id = n.id
             WHERE n.id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        if !matches!(status.as_str(), "captured" | "considering" | "ready") {
            return Err(DomainError::InvalidBacklogState);
        }

        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE work_nodes
             SET parent_id = ?1,
                 position = (
                   SELECT COALESCE(MAX(position), -1) + 1
                   FROM work_nodes
                   WHERE parent_id = ?1
                 ),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?2,
                 write_source = ?3,
                 revision = ?4
             WHERE id = ?5",
            params![
                parent_id,
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                node_id,
            ],
        )
        .map_err(map_storage_error)?;

        if let Some(target_position) = target_position {
            let mut siblings = {
                let mut statement = tx.prepare(
                    "SELECT id, position FROM work_nodes
                     WHERE parent_id = ?1 ORDER BY position, id",
                )?;
                statement
                    .query_map([parent_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            if target_position >= siblings.len() {
                return Err(DomainError::InvalidPosition);
            }
            let current_index = siblings
                .iter()
                .position(|(id, _)| id == node_id)
                .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            let subject = siblings.remove(current_index);
            siblings.insert(target_position, subject);

            let max_position = siblings
                .iter()
                .map(|(_, position)| *position)
                .max()
                .unwrap_or(0);
            let temporary_base = max_position + siblings.len() as i64 + 1;
            for (offset, (id, _)) in siblings.iter().enumerate() {
                tx.execute(
                    "UPDATE work_nodes SET position = ?1 WHERE id = ?2",
                    params![temporary_base + offset as i64, id],
                )?;
            }
            for (position, (id, old_position)) in siblings.iter().enumerate() {
                if id == node_id || *old_position == position as i64 {
                    tx.execute(
                        "UPDATE work_nodes SET position = ?1 WHERE id = ?2",
                        params![position as i64, id],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE work_nodes
                         SET position = ?1,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                             updated_actor = ?2,
                             write_source = ?3,
                             revision = revision + 1
                         WHERE id = ?4",
                        params![
                            position as i64,
                            metadata.actor_label(),
                            metadata.channel.as_str(),
                            id,
                        ],
                    )?;
                }
            }
        }
        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "move_backlog",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn update_backlog(
        &mut self,
        node_id: &str,
        patch: BacklogPatch<'_>,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        if patch.title.is_none()
            && patch.notes == TextChange::Keep
            && patch.kind.is_none()
            && patch.priority.is_none()
            && patch.tags_json.is_none()
        {
            return Err(DomainError::EmptyPatch);
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "update_backlog",
            node_id,
            patch.title.unwrap_or("<keep>"),
            patch.notes.digest_value(),
            patch.kind.map(BacklogKind::as_str).unwrap_or("<keep>"),
            patch.priority.map(Priority::as_str).unwrap_or("<keep>"),
            patch.tags_json.unwrap_or("<keep>"),
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let actual_revision: i64 = tx.query_row(
            "SELECT revision FROM work_nodes WHERE id = ?1 AND kind = 'backlog'",
            [node_id],
            |row| row.get(0),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE work_nodes
             SET title = COALESCE(?1, title),
                 priority = COALESCE(?2, priority),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?3,
                 write_source = ?4,
                 revision = ?5
             WHERE id = ?6",
            params![
                patch.title,
                patch.priority.map(Priority::as_str),
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                node_id,
            ],
        )?;
        let (notes_action, notes) = patch.notes.sql_parts();
        tx.execute(
            "UPDATE backlog_items
             SET notes = CASE WHEN ?1 = 0 THEN notes ELSE ?2 END,
                 backlog_kind = COALESCE(?3, backlog_kind),
                 tags_json = COALESCE(?4, tags_json)
             WHERE node_id = ?5",
            params![
                notes_action,
                notes,
                patch.kind.map(BacklogKind::as_str),
                patch.tags_json,
                node_id,
            ],
        )?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "update_backlog",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn discard_backlog(
        &mut self,
        node_id: &str,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "discard_backlog",
            node_id,
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let (actual_revision, status): (i64, String) = tx.query_row(
            "SELECT n.revision, b.backlog_status
             FROM work_nodes n JOIN backlog_items b ON b.node_id = n.id
             WHERE n.id = ?1",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        if status == "promoted" {
            return Err(DomainError::InvalidBacklogState);
        }
        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE backlog_items SET backlog_status = 'discarded' WHERE node_id = ?1",
            [node_id],
        )?;
        tx.execute(
            "UPDATE work_nodes
             SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?1, write_source = ?2, revision = ?3
             WHERE id = ?4",
            params![
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                node_id,
            ],
        )?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "discard_backlog",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn promote_backlog(
        &mut self,
        backlog_id: &str,
        target: PromotionTarget<'_>,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<PromotionResult, DomainError> {
        let (target_id, target_kind, parent_id, key, title, requested_position, slug, context_path) =
            match &target {
                PromotionTarget::Project(project) => (
                    project.id,
                    NodeKind::Project,
                    project.parent_id,
                    project.key,
                    project.title,
                    Some(project.position),
                    project.slug,
                    project.context_path,
                ),
                PromotionTarget::ProjectAtEnd(project) => (
                    project.id,
                    NodeKind::Project,
                    project.parent_id,
                    project.key,
                    project.title,
                    None,
                    project.slug,
                    project.context_path,
                ),
                PromotionTarget::Task(task) => (
                    task.id,
                    NodeKind::Task,
                    task.parent_id,
                    task.key,
                    task.title,
                    Some(task.position),
                    None,
                    None,
                ),
                PromotionTarget::TaskAtEnd(task) => (
                    task.id,
                    NodeKind::Task,
                    task.parent_id,
                    task.key,
                    task.title,
                    None,
                    None,
                    None,
                ),
            };
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let position_text =
            requested_position.map_or_else(|| "append".into(), |value| value.to_string());
        let request_digest = digest_fields(&[
            "promote_backlog",
            backlog_id,
            target_id,
            target_kind.as_str(),
            parent_id,
            key,
            title,
            &position_text,
            slug.unwrap_or(""),
            context_path.unwrap_or(""),
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            let promoted_node_id: String = tx.query_row(
                "SELECT promoted_node_id FROM backlog_items WHERE node_id = ?1",
                [backlog_id],
                |row| row.get(0),
            )?;
            return Ok(PromotionResult {
                target_node_id: promoted_node_id,
                source_revision: result.revision,
                replayed: true,
            });
        }
        let (actual_revision, status): (i64, String) = tx.query_row(
            "SELECT n.revision, b.backlog_status
             FROM work_nodes n JOIN backlog_items b ON b.node_id = n.id
             WHERE n.id = ?1",
            [backlog_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        if !matches!(status.as_str(), "captured" | "considering" | "ready") {
            return Err(DomainError::InvalidBacklogState);
        }

        let position = requested_position.map_or_else(
            || {
                tx.query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM work_nodes WHERE parent_id = ?1",
                    [parent_id],
                    |row| row.get(0),
                )
            },
            Ok,
        )?;

        tx.execute(
            "INSERT INTO work_nodes (
               id, kind, parent_id, key, title, work_status, priority, position,
               created_at, updated_at, created_actor, updated_actor, write_source, revision
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, 'planned', 'none', ?6,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?7, ?7, ?8, 1
             )",
            params![
                target_id,
                target_kind.as_str(),
                parent_id,
                key,
                title,
                position,
                metadata.actor_label(),
                metadata.channel.as_str(),
            ],
        )
        .map_err(map_storage_error)?;
        match &target {
            PromotionTarget::Project(_) | PromotionTarget::ProjectAtEnd(_) => {
                tx.execute(
                    "INSERT INTO projects (node_id, slug, context_path) VALUES (?1, ?2, ?3)",
                    params![target_id, slug, context_path],
                )?;
            }
            PromotionTarget::Task(_) | PromotionTarget::TaskAtEnd(_) => {
                tx.execute("INSERT INTO tasks (node_id) VALUES (?1)", [target_id])?;
            }
        }
        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE backlog_items
             SET backlog_status = 'promoted', promoted_node_id = ?1
             WHERE node_id = ?2",
            params![target_id, backlog_id],
        )?;
        tx.execute(
            "UPDATE work_nodes
             SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?1, write_source = ?2, revision = ?3
             WHERE id = ?4",
            params![
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                backlog_id,
            ],
        )?;
        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "promote_backlog",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(PromotionResult {
            target_node_id: target_id.to_owned(),
            source_revision: next_revision,
            replayed: false,
        })
    }

    pub fn add_resource_binding(
        &mut self,
        binding: NewResourceBinding<'_>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let is_primary = if binding.is_primary { "1" } else { "0" };
        let request_digest = digest_fields(&[
            "add_resource_binding",
            binding.id,
            binding.node_id,
            binding.kind.as_str(),
            binding.locator,
            is_primary,
            binding.availability.as_str(),
            binding.source,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        tx.execute(
            "INSERT INTO resource_bindings (
               id, node_id, kind, locator, is_primary, availability, source,
               created_at, updated_at, created_actor, updated_actor, write_source, revision
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?8, ?8, ?9, 1
             )",
            params![
                binding.id,
                binding.node_id,
                binding.kind.as_str(),
                binding.locator,
                binding.is_primary,
                binding.availability.as_str(),
                binding.source,
                metadata.actor_label(),
                metadata.channel.as_str(),
            ],
        )
        .map_err(map_storage_error)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "add_resource_binding",
            &request_digest,
            1,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: 1,
            replayed: false,
        })
    }

    pub fn update_resource_availability(
        &mut self,
        binding_id: &str,
        availability: ResourceAvailability,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "update_resource_availability",
            binding_id,
            availability.as_str(),
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let actual_revision: i64 = tx.query_row(
            "SELECT revision FROM resource_bindings WHERE id = ?1",
            [binding_id],
            |row| row.get(0),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        let next_revision = actual_revision + 1;
        let changed = tx.execute(
            "UPDATE resource_bindings
             SET availability = ?1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?2,
                 write_source = ?3,
                 revision = ?4
             WHERE id = ?5",
            params![
                availability.as_str(),
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                binding_id,
            ],
        )?;
        if changed == 0 {
            return Err(DomainError::NotFound);
        }
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "update_resource_availability",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn create_node(
        &mut self,
        node: NewNode<'_>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        self.create_node_with_summary(node, None, metadata)
    }

    fn create_node_with_summary(
        &mut self,
        node: NewNode<'_>,
        summary: Option<&str>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        self.create_node_with_project_fields(node, summary, None, None, metadata)
    }

    fn create_node_with_project_fields(
        &mut self,
        node: NewNode<'_>,
        summary: Option<&str>,
        slug: Option<&str>,
        context_path: Option<&str>,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let position = node.position.to_string();
        let request_digest = digest_fields(&[
            "create_node",
            node.id,
            node.kind.as_str(),
            node.parent_id,
            node.key,
            node.title,
            summary.unwrap_or(""),
            &position,
            slug.unwrap_or(""),
            context_path.unwrap_or(""),
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let (work_status, priority) = match node.kind {
            NodeKind::Project | NodeKind::Task => (Some("planned"), Some("none")),
            NodeKind::Backlog => (None, Some("none")),
            NodeKind::Root => (None, None),
        };
        tx.execute(
            "INSERT INTO work_nodes (
               id, kind, parent_id, key, title, summary, work_status, priority, position,
               created_at, updated_at, created_actor, updated_actor, write_source, revision
             ) VALUES (
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?10, ?10, ?11, 1
             )",
            params![
                node.id,
                node.kind.as_str(),
                node.parent_id,
                node.key,
                node.title,
                summary,
                work_status,
                priority,
                node.position,
                metadata.actor_label(),
                metadata.channel.as_str()
            ],
        )
        .map_err(map_storage_error)?;

        match node.kind {
            NodeKind::Project => {
                tx.execute(
                    "INSERT INTO projects (node_id, slug, context_path) VALUES (?1, ?2, ?3)",
                    params![node.id, slug, context_path],
                )?;
            }
            NodeKind::Task => {
                tx.execute("INSERT INTO tasks (node_id) VALUES (?1)", [node.id])?;
            }
            NodeKind::Backlog => {
                tx.execute(
                    "INSERT INTO backlog_items (node_id, backlog_kind, backlog_status)
                     VALUES (?1, 'idea', 'captured')",
                    [node.id],
                )?;
            }
            NodeKind::Root => {}
        }

        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "create_node",
            &request_digest,
            1,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: 1,
            replayed: false,
        })
    }

    pub fn move_node(
        &mut self,
        node_id: &str,
        parent_id: &str,
        position: i64,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let position_text = position.to_string();
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "move_node",
            node_id,
            parent_id,
            &position_text,
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }

        let (old_parent_id, actual_revision): (String, i64) = tx.query_row(
            "SELECT parent_id, revision FROM work_nodes
             WHERE id = ?1 AND kind <> 'root'",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }

        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE work_nodes
             SET parent_id = ?1,
                 position = ?2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?3,
                 write_source = ?4,
                 revision = ?5
             WHERE id = ?6",
            params![
                parent_id,
                position,
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                node_id,
            ],
        )
        .map_err(map_storage_error)?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, evidence_json, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'parent_changed', 'parent changed',
               json_array(json_object(
                 'old_parent_id', ?3, 'new_parent_id', ?4, 'new_position', ?5
               )),
               ?6, ?7, ?8
             )",
            params![
                event_id,
                node_id,
                old_parent_id,
                parent_id,
                position,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        ensure_no_invariant_violations(&tx)?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "move_node",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn add_to_today(
        &mut self,
        node_id: &str,
        position: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let position_text = position.to_string();
        let request_digest = digest_fields(&[
            "add_to_today",
            node_id,
            &position_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        tx.execute(
            "INSERT INTO today_items (node_id, position, added_at, added_actor, revision)
             VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?3, 1)",
            params![node_id, position, metadata.actor_label()],
        )
        .map_err(map_storage_error)?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'today_added', 'added to Today', ?3, ?4, ?5
             )",
            params![
                event_id,
                node_id,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "add_to_today",
            &request_digest,
            1,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: 1,
            replayed: false,
        })
    }

    pub fn remove_from_today(
        &mut self,
        node_id: &str,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "remove_from_today",
            node_id,
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let actual_revision: i64 = tx.query_row(
            "SELECT revision FROM today_items WHERE node_id = ?1",
            [node_id],
            |row| row.get(0),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        tx.execute("DELETE FROM today_items WHERE node_id = ?1", [node_id])?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'today_removed', 'removed from Today', ?3, ?4, ?5
             )",
            params![
                event_id,
                node_id,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        let result_revision = actual_revision + 1;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "remove_from_today",
            &request_digest,
            result_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: result_revision,
            replayed: false,
        })
    }

    pub fn reorder_today_item(
        &mut self,
        node_id: &str,
        target_position: usize,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let target_position_text = target_position.to_string();
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "reorder_today_item",
            node_id,
            &target_position_text,
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let actual_revision: i64 = tx.query_row(
            "SELECT revision FROM today_items WHERE node_id = ?1",
            [node_id],
            |row| row.get(0),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
        let mut items = {
            let mut statement =
                tx.prepare("SELECT node_id, position FROM today_items ORDER BY position, node_id")?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if target_position >= items.len() {
            return Err(DomainError::InvalidPosition);
        }
        let current_index = items
            .iter()
            .position(|(id, _)| id == node_id)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if current_index == target_position {
            return Err(DomainError::EmptyPatch);
        }
        let subject = items.remove(current_index);
        items.insert(target_position, subject);

        let max_position = items
            .iter()
            .map(|(_, position)| *position)
            .max()
            .unwrap_or(0);
        let temporary_base = max_position + items.len() as i64 + 1;
        for (offset, (id, _)) in items.iter().enumerate() {
            tx.execute(
                "UPDATE today_items SET position = ?1 WHERE node_id = ?2",
                params![temporary_base + offset as i64, id],
            )?;
        }
        for (position, (id, old_position)) in items.iter().enumerate() {
            if *old_position == position as i64 {
                tx.execute(
                    "UPDATE today_items SET position = ?1 WHERE node_id = ?2",
                    params![position as i64, id],
                )?;
            } else {
                tx.execute(
                    "UPDATE today_items
                     SET position = ?1, revision = revision + 1
                     WHERE node_id = ?2",
                    params![position as i64, id],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'today_reordered', 'Today order changed', ?3, ?4, ?5
             )",
            params![
                event_id,
                node_id,
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        let result_revision = actual_revision + 1;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "reorder_today_item",
            &request_digest,
            result_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: result_revision,
            replayed: false,
        })
    }

    pub fn reorder_node(
        &mut self,
        node_id: &str,
        target_position: usize,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let target_position_text = target_position.to_string();
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "reorder_node",
            node_id,
            &target_position_text,
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }

        let (parent_id, actual_revision): (String, i64) = tx.query_row(
            "SELECT parent_id, revision FROM work_nodes
             WHERE id = ?1 AND kind <> 'root'",
            [node_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }

        let mut siblings = {
            let mut statement = tx.prepare(
                "SELECT id, position, revision FROM work_nodes
                 WHERE parent_id = ?1 ORDER BY position, id",
            )?;
            statement
                .query_map([&parent_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if target_position >= siblings.len() {
            return Err(DomainError::InvalidPosition);
        }
        let current_index = siblings
            .iter()
            .position(|(id, _, _)| id == node_id)
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if current_index != target_position {
            let subject = siblings.remove(current_index);
            siblings.insert(target_position, subject);
        }

        let subject_revision = if current_index == target_position {
            actual_revision
        } else {
            actual_revision + 1
        };
        if current_index != target_position {
            let max_position = siblings
                .iter()
                .map(|(_, position, _)| *position)
                .max()
                .unwrap_or(0);
            let temporary_base = max_position + siblings.len() as i64 + 1;
            for (offset, (id, _, _)) in siblings.iter().enumerate() {
                tx.execute(
                    "UPDATE work_nodes SET position = ?1 WHERE id = ?2",
                    params![temporary_base + offset as i64, id],
                )?;
            }
            for (position, (id, old_position, _)) in siblings.iter().enumerate() {
                if *old_position == position as i64 {
                    tx.execute(
                        "UPDATE work_nodes SET position = ?1 WHERE id = ?2",
                        params![position as i64, id],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE work_nodes
                         SET position = ?1,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                             updated_actor = ?2,
                             write_source = ?3,
                             revision = revision + 1
                         WHERE id = ?4",
                        params![
                            position as i64,
                            metadata.actor_label(),
                            metadata.channel.as_str(),
                            id,
                        ],
                    )?;
                }
            }
            ensure_no_invariant_violations(&tx)?;
        }

        record_receipt(
            &tx,
            metadata.idempotency_key,
            "reorder_node",
            &request_digest,
            subject_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: subject_revision,
            replayed: false,
        })
    }

    pub fn update_status(
        &mut self,
        node_id: &str,
        status: WorkStatus,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "update_status",
            node_id,
            status.as_str(),
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let actual_revision: i64 = tx.query_row(
            "SELECT revision FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| row.get(0),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }

        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE work_nodes
             SET work_status = ?1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?3,
                 write_source = ?4,
                 revision = ?2
             WHERE id = ?5",
            params![
                status.as_str(),
                next_revision,
                metadata.actor_label(),
                metadata.channel.as_str(),
                node_id
            ],
        )?;
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'status_changed', ?3, ?4, ?5, ?6
             )",
            params![
                event_id,
                node_id,
                format!("status changed to {}", status.as_str()),
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str()
            ],
        )?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "update_status",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn append_progress_event(
        &mut self,
        node_id: &str,
        event: NewProgressEvent<'_>,
        expected_revision: i64,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "append_progress_event",
            node_id,
            event.id,
            event.kind.as_str(),
            event.summary,
            event.step_status.map_or("", WorkStatus::as_str),
            &expected_revision_text,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }
        let current_revision: i64 = tx.query_row(
            "SELECT revision FROM work_nodes
             WHERE id = ?1 AND kind IN ('project', 'task')",
            [node_id],
            |row| row.get(0),
        )?;
        if current_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: current_revision,
            });
        }
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, step_status, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?3, ?4, ?5, ?6, ?7, ?8
             )",
            params![
                event.id,
                node_id,
                event.kind.as_str(),
                event.summary,
                event.step_status.map(WorkStatus::as_str),
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "append_progress_event",
            &request_digest,
            current_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: current_revision,
            replayed: false,
        })
    }

    pub fn sync_legacy_log_event(
        &mut self,
        event: &LegacyProgressEventMapping,
    ) -> Result<LegacyLogSyncResult, DomainError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT id, source_digest
                 FROM progress_events
                 WHERE source_binding_id = ?1 AND source_item_key = ?2",
                params![event.source_binding_id, event.source_item_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((event_id, source_digest)) = existing {
            if source_digest != event.source_digest {
                return Err(DomainError::SourceRecordMutated);
            }
            tx.commit()?;
            return Ok(LegacyLogSyncResult {
                event_id,
                replayed: true,
            });
        }
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, actor_type, channel,
               source_binding_id, source_item_key, source_digest
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'imported', ?3, 'system', 'legacy_log', ?4, ?5, ?6
             )",
            params![
                event.id,
                event.subject_node_id,
                event.summary,
                event.source_binding_id,
                event.source_item_key,
                event.source_digest,
            ],
        )?;
        tx.commit()?;
        Ok(LegacyLogSyncResult {
            event_id: event.id.clone(),
            replayed: false,
        })
    }

    pub fn apply_legacy_report(
        &mut self,
        report: &LegacyDryRunReport,
        idempotency_key: &str,
    ) -> Result<LegacyApplyResult, DomainError> {
        let request_digest = digest_fields(&[
            "legacy_apply",
            &report.ruleset_version,
            &report.source_snapshot_digest,
            &report.report_digest,
        ]);
        let run_id = Uuid::new_v5(
            &Uuid::parse_str(IMPORT_RUN_NAMESPACE).expect("valid import namespace"),
            idempotency_key.as_bytes(),
        )
        .to_string();
        let existing = self
            .connection
            .query_row(
                "SELECT request_digest FROM command_receipts WHERE idempotency_key = ?1",
                [idempotency_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(stored_digest) = existing {
            if stored_digest != request_digest {
                return Err(DomainError::IdempotencyConflict);
            }
            return Ok(LegacyApplyResult {
                run_id,
                status: "succeeded".into(),
                report_digest: report.report_digest.clone(),
                counts: validate_database(&self.connection)?,
                replayed: true,
            });
        }
        if report.ruleset_version != LEGACY_RULESET_VERSION {
            return Err(DomainError::ImportRulesetMismatch);
        }
        if !report.apply_eligible {
            return Err(DomainError::ImportNotEligible);
        }
        let current = dry_run_legacy_source(&report.source_root, &report.scope)?;
        if current.source_snapshot_digest != report.source_snapshot_digest {
            return Err(DomainError::ImportSourceSnapshotChanged);
        }
        if current.report_digest != report.report_digest {
            return Err(DomainError::ImportReportDigestMismatch);
        }

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let scope_json = serde_json::to_string(&report.scope)?;
        let summary_json = serde_json::to_string(&report.summary)?;
        tx.execute(
            "INSERT INTO import_runs (
               id, mode, source_root, scope_json, ruleset_version, started_at,
               status, summary_json, report_digest
             ) VALUES (
               ?1, 'apply', ?2, ?3, ?4,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               'running', ?5, ?6
             )",
            params![
                run_id,
                report.source_root,
                scope_json,
                report.ruleset_version,
                summary_json,
                report.report_digest,
            ],
        )?;

        for project in &report.project_mappings {
            insert_imported_work_node(
                &tx,
                &project.target_id,
                "project",
                &project.parent_id,
                &project.key,
                &project.title,
                Some("planned"),
                Some("none"),
                project.position,
            )?;
            tx.execute(
                "INSERT INTO projects (node_id, slug, context_path) VALUES (?1, ?2, ?3)",
                params![project.target_id, project.source_slug, project.context_path],
            )?;
        }
        insert_legacy_tasks(&tx, &report.legacy_task_mappings)?;
        for task in &report.legacy_next_action_task_mappings {
            insert_imported_work_node(
                &tx,
                &task.target_id,
                "task",
                &task.parent_id,
                &task.key,
                &task.title,
                Some(&task.work_status),
                Some(&task.priority),
                task.position,
            )?;
            tx.execute("INSERT INTO tasks (node_id) VALUES (?1)", [&task.target_id])?;
        }
        for backlog in &report.backlog_mappings {
            insert_imported_work_node(
                &tx,
                &backlog.target_id,
                "backlog",
                &backlog.parent_id,
                &backlog.key,
                &backlog.title,
                None,
                Some("none"),
                backlog.position,
            )?;
            tx.execute(
                "INSERT INTO backlog_items (
                   node_id, backlog_kind, backlog_status, promoted_node_id
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    backlog.target_id,
                    backlog.backlog_kind,
                    backlog.backlog_status,
                    backlog.promoted_node_id,
                ],
            )?;
        }
        for binding in &report.resource_binding_mappings {
            tx.execute(
                "INSERT INTO resource_bindings (
                   id, node_id, kind, locator, is_primary, availability, source,
                   created_at, updated_at, created_actor, updated_actor, write_source, revision
                 ) VALUES (
                   ?1, ?2, ?3, ?4, 1, 'unknown', 'legacy_import',
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   'system', 'system', 'import', 1
                 )",
                params![binding.id, binding.node_id, binding.kind, binding.locator],
            )?;
        }
        for event in &report.progress_event_mappings {
            insert_imported_progress_event(&tx, event)?;
        }
        for item in &report.today_item_mappings {
            tx.execute(
                "INSERT INTO today_items (node_id, position, added_at, added_actor, revision)
                 VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 1)",
                params![item.node_id, item.position],
            )?;
        }
        record_import_source_files(&tx, &run_id, &report.source_files)?;
        ensure_no_invariant_violations(&tx)?;
        tx.execute(
            "UPDATE import_runs
             SET status = 'succeeded', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            [&run_id],
        )?;
        record_receipt(&tx, idempotency_key, "legacy_apply", &request_digest, 1)?;
        tx.commit()?;

        Ok(LegacyApplyResult {
            run_id,
            status: "succeeded".into(),
            report_digest: report.report_digest.clone(),
            counts: validate_database(&self.connection)?,
            replayed: false,
        })
    }

    pub fn update_work_item(
        &mut self,
        node_id: &str,
        patch: WorkItemPatch<'_>,
        expected_revision: i64,
        event_id: &str,
        metadata: CommandMetadata<'_>,
    ) -> Result<MutationResult, DomainError> {
        if patch.title.is_none()
            && patch.summary == TextChange::Keep
            && patch.goal == TextChange::Keep
            && patch.acceptance == TextChange::Keep
            && patch.status.is_none()
            && patch.priority.is_none()
            && patch.blocker == TextChange::Keep
        {
            return Err(DomainError::EmptyPatch);
        }

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expected_revision_text = expected_revision.to_string();
        let request_digest = digest_fields(&[
            "update_work_item",
            node_id,
            patch.title.unwrap_or("<keep>"),
            patch.summary.digest_value(),
            patch.goal.digest_value(),
            patch.acceptance.digest_value(),
            patch.status.map(WorkStatus::as_str).unwrap_or("<keep>"),
            patch.priority.map(Priority::as_str).unwrap_or("<keep>"),
            patch.blocker.digest_value(),
            &expected_revision_text,
            event_id,
            metadata.actor_type.as_str(),
            metadata.actor_ref.unwrap_or(""),
            metadata.channel.as_str(),
        ]);
        if let Some(result) = existing_receipt(&tx, metadata.idempotency_key, &request_digest)? {
            return Ok(result);
        }

        let actual_revision: i64 = tx.query_row(
            "SELECT revision FROM work_nodes
             WHERE id = ?1 AND kind IN ('project', 'task')",
            [node_id],
            |row| row.get(0),
        )?;
        if actual_revision != expected_revision {
            return Err(DomainError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }

        let (summary_action, summary) = patch.summary.sql_parts();
        let (goal_action, goal) = patch.goal.sql_parts();
        let (acceptance_action, acceptance) = patch.acceptance.sql_parts();
        let (blocker_action, blocker) = patch.blocker.sql_parts();
        let next_revision = actual_revision + 1;
        tx.execute(
            "UPDATE work_nodes
             SET title = COALESCE(?1, title),
                 summary = CASE WHEN ?2 = 0 THEN summary ELSE ?3 END,
                 goal = CASE WHEN ?4 = 0 THEN goal ELSE ?5 END,
                 acceptance_markdown = CASE WHEN ?6 = 0 THEN acceptance_markdown ELSE ?7 END,
                 work_status = COALESCE(?8, work_status),
                 priority = COALESCE(?9, priority),
                 blocker = CASE WHEN ?10 = 0 THEN blocker ELSE ?11 END,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 updated_actor = ?12,
                 write_source = ?13,
                 revision = ?14
             WHERE id = ?15",
            params![
                patch.title,
                summary_action,
                summary,
                goal_action,
                goal,
                acceptance_action,
                acceptance,
                patch.status.map(WorkStatus::as_str),
                patch.priority.map(Priority::as_str),
                blocker_action,
                blocker,
                metadata.actor_label(),
                metadata.channel.as_str(),
                next_revision,
                node_id,
            ],
        )?;

        let event_type = match (
            patch.status.is_some(),
            patch.priority.is_some(),
            patch.blocker != TextChange::Keep,
            patch.title.is_some()
                || patch.summary != TextChange::Keep
                || patch.goal != TextChange::Keep
                || patch.acceptance != TextChange::Keep,
        ) {
            (true, false, false, false) => "status_changed",
            (false, true, false, false) => "priority_changed",
            (false, false, true, false) => "blocker_changed",
            _ => "progress",
        };
        tx.execute(
            "INSERT INTO progress_events (
               id, subject_node_id, occurred_at, recorded_at, event_type,
               summary, blocker, actor_type, actor_ref, channel
             ) VALUES (
               ?1, ?2,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               ?3, 'work item fields updated', ?4, ?5, ?6, ?7
             )",
            params![
                event_id,
                node_id,
                event_type,
                if blocker_action == 0 { None } else { blocker },
                metadata.actor_type.as_str(),
                metadata.actor_ref,
                metadata.channel.as_str(),
            ],
        )?;
        record_receipt(
            &tx,
            metadata.idempotency_key,
            "update_work_item",
            &request_digest,
            next_revision,
        )?;
        tx.commit()?;
        Ok(MutationResult {
            revision: next_revision,
            replayed: false,
        })
    }

    pub fn node_count(&self, kind: NodeKind) -> Result<i64, DomainError> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM work_nodes WHERE kind = ?1",
            [kind.as_str()],
            |row| row.get(0),
        )?)
    }

    pub fn node_revision(&self, node_id: &str) -> Result<i64, DomainError> {
        Ok(self.connection.query_row(
            "SELECT revision FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| row.get(0),
        )?)
    }

    pub fn node_status(&self, node_id: &str) -> Result<String, DomainError> {
        Ok(self.connection.query_row(
            "SELECT work_status FROM work_nodes WHERE id = ?1",
            [node_id],
            |row| row.get(0),
        )?)
    }

    pub fn progress_event_count(&self, node_id: &str) -> Result<i64, DomainError> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM progress_events WHERE subject_node_id = ?1",
            [node_id],
            |row| row.get(0),
        )?)
    }

    pub fn integrity_report(&self) -> Result<IntegrityReport, DomainError> {
        let foreign_key_violations: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
            [],
            |row| row.get(0),
        )?;
        let invariant_violations: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM schema_invariant_violations",
            [],
            |row| row.get(0),
        )?;
        Ok(IntegrityReport {
            integrity: self
                .connection
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))?,
            foreign_key_violations: foreign_key_violations as usize,
            invariant_violations: invariant_violations as usize,
        })
    }
}

fn migration_lock_path(database_path: &Path) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(".migration.lock");
    PathBuf::from(path)
}

fn create_pre_migration_backup(
    connection: &Connection,
    database_path: &Path,
    next_version: i64,
) -> Result<PathBuf, DomainError> {
    checkpoint_wal(connection)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DomainError::BackupIntegrity)?
        .as_nanos();
    let mut backup_name = database_path.as_os_str().to_os_string();
    backup_name.push(format!(
        ".pre-migration-v{next_version}-{timestamp}.sqlite3"
    ));
    let backup_path = PathBuf::from(backup_name);
    connection.backup(rusqlite::MAIN_DB, &backup_path, None)?;
    finalize_and_validate_backup(&backup_path)?;
    Ok(backup_path)
}

fn checkpoint_wal(connection: &Connection) -> Result<(), DomainError> {
    let (busy, _, _): (i64, i64, i64) =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy == 0 {
        Ok(())
    } else {
        Err(DomainError::BackupBusy)
    }
}

fn restore_temporary_path(target_path: &Path) -> Result<PathBuf, DomainError> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DomainError::BackupIntegrity)?
        .as_nanos();
    let mut name = target_path.as_os_str().to_os_string();
    name.push(format!(".restore-{timestamp}.sqlite3"));
    Ok(PathBuf::from(name))
}

fn finalize_and_validate_backup(path: &Path) -> Result<CoreCounts, DomainError> {
    let connection = Connection::open(path)?;
    checkpoint_wal(&connection)?;
    connection.pragma_update(None, "journal_mode", "DELETE")?;
    validate_database(&connection)
}

fn validate_database(connection: &Connection) -> Result<CoreCounts, DomainError> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(DomainError::BackupIntegrity);
    }
    let foreign_key_violations: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    let invariant_violations: i64 = connection.query_row(
        "SELECT COUNT(*) FROM schema_invariant_violations",
        [],
        |row| row.get(0),
    )?;
    if foreign_key_violations != 0 || invariant_violations != 0 {
        return Err(DomainError::BackupIntegrity);
    }
    Ok(CoreCounts {
        work_nodes: table_count(connection, "work_nodes")?,
        projects: table_count(connection, "projects")?,
        tasks: table_count(connection, "tasks")?,
        backlog_items: table_count(connection, "backlog_items")?,
        today_items: table_count(connection, "today_items")?,
        progress_events: table_count(connection, "progress_events")?,
        resource_bindings: table_count(connection, "resource_bindings")?,
    })
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, DomainError> {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    Ok(connection.query_row(&sql, [], |row| row.get(0))?)
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        key: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        goal: row.get(5)?,
        acceptance: row.get(6)?,
        status: row.get(7)?,
        priority: row.get(8)?,
        blocker: row.get(9)?,
        slug: row.get(10)?,
        context_path: row.get(11)?,
        revision: row.get(12)?,
    })
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        key: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        goal: row.get(5)?,
        acceptance: row.get(6)?,
        status: row.get(7)?,
        priority: row.get(8)?,
        blocker: row.get(9)?,
        revision: row.get(10)?,
        has_steps: row.get(11)?,
    })
}

fn progress_event_from_row(row: &Row<'_>) -> rusqlite::Result<ProgressEvent> {
    Ok(ProgressEvent {
        id: row.get(0)?,
        subject_node_id: row.get(1)?,
        occurred_at: row.get(2)?,
        recorded_at: row.get(3)?,
        event_type: row.get(4)?,
        summary: row.get(5)?,
        step_status: row.get(6)?,
        blocker: row.get(7)?,
        actor_type: row.get(8)?,
        actor_ref: row.get(9)?,
        channel: row.get(10)?,
    })
}

fn resource_binding_from_row(row: &Row<'_>) -> rusqlite::Result<ResourceBinding> {
    Ok(ResourceBinding {
        id: row.get(0)?,
        node_id: row.get(1)?,
        kind: row.get(2)?,
        locator: row.get(3)?,
        is_primary: row.get(4)?,
        availability: row.get(5)?,
        source: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        created_actor: row.get(9)?,
        updated_actor: row.get(10)?,
        write_source: row.get(11)?,
        revision: row.get(12)?,
    })
}

fn backlog_from_row(row: &Row<'_>) -> rusqlite::Result<Backlog> {
    Ok(Backlog {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        key: row.get(2)?,
        title: row.get(3)?,
        priority: row.get(4)?,
        position: row.get(5)?,
        revision: row.get(6)?,
        backlog_kind: row.get(7)?,
        backlog_status: row.get(8)?,
        notes: row.get(9)?,
        tags_json: row.get(10)?,
        source: row.get(11)?,
        promoted_node_id: row.get(12)?,
    })
}

fn apply_migration(
    connection: &mut Connection,
    version: i64,
    sql: &str,
) -> Result<(), DomainError> {
    let checksum = format!("{:x}", Sha256::digest(sql.as_bytes()));
    let applied_checksum = connection
        .query_row(
            "SELECT checksum FROM schema_migrations WHERE version = ?1",
            [version],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if let Some(applied_checksum) = applied_checksum {
        return if applied_checksum == checksum {
            Ok(())
        } else {
            Err(DomainError::MigrationChecksum { version })
        };
    }

    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(sql)?;
    tx.execute(
        "INSERT INTO schema_migrations (version, checksum, applied_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![version, checksum],
    )?;
    tx.pragma_update(None, "user_version", version)?;
    tx.commit()?;
    Ok(())
}

fn ensure_no_invariant_violations(tx: &Transaction<'_>) -> Result<(), DomainError> {
    let violations: i64 = tx.query_row(
        "SELECT COUNT(*) FROM schema_invariant_violations",
        [],
        |row| row.get(0),
    )?;
    if violations == 0 {
        Ok(())
    } else {
        Err(DomainError::Storage(rusqlite::Error::InvalidQuery))
    }
}

fn digest_fields(fields: &[&str]) -> String {
    let mut digest = Sha256::new();
    for field in fields {
        digest.update(field.len().to_be_bytes());
        digest.update(field.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

#[allow(clippy::too_many_arguments)]
fn insert_imported_work_node(
    tx: &Transaction<'_>,
    id: &str,
    kind: &str,
    parent_id: &str,
    key: &str,
    title: &str,
    work_status: Option<&str>,
    priority: Option<&str>,
    position: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO work_nodes (
           id, kind, parent_id, key, title, work_status, priority, position,
           created_at, updated_at, created_actor, updated_actor, write_source, revision
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           'system', 'system', 'import', 1
         )",
        params![
            id,
            kind,
            parent_id,
            key,
            title,
            work_status,
            priority,
            position
        ],
    )?;
    Ok(())
}

fn insert_legacy_tasks(
    tx: &Transaction<'_>,
    mappings: &[LegacyTaskMapping],
) -> Result<(), DomainError> {
    let mut pending = mappings.iter().collect::<Vec<_>>();
    while !pending.is_empty() {
        let pending_count = pending.len();
        let mut deferred = Vec::new();
        for task in pending {
            let parent_exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM work_nodes WHERE id = ?1)",
                [&task.parent_id],
                |row| row.get(0),
            )?;
            if !parent_exists {
                deferred.push(task);
                continue;
            }
            insert_imported_work_node(
                tx,
                &task.target_id,
                "task",
                &task.parent_id,
                &task.key,
                &task.title,
                Some(&task.work_status),
                Some(&task.priority),
                task.position,
            )?;
            tx.execute("INSERT INTO tasks (node_id) VALUES (?1)", [&task.target_id])?;
        }
        if deferred.len() == pending_count {
            return Err(DomainError::InvalidParentKind);
        }
        pending = deferred;
    }
    Ok(())
}

fn insert_imported_progress_event(
    tx: &Transaction<'_>,
    event: &LegacyProgressEventMapping,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO progress_events (
           id, subject_node_id, occurred_at, recorded_at, event_type,
           summary, actor_type, channel,
           source_binding_id, source_item_key, source_digest
         ) VALUES (
           ?1, ?2,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           'imported', ?3, 'unknown', 'legacy_log', ?4, ?5, ?6
         )",
        params![
            event.id,
            event.subject_node_id,
            event.summary,
            event.source_binding_id,
            event.source_item_key,
            event.source_digest,
        ],
    )?;
    Ok(())
}

fn record_import_source_files(
    tx: &Transaction<'_>,
    run_id: &str,
    files: &[LegacySourceFileSnapshot],
) -> Result<(), DomainError> {
    let run_namespace = Uuid::parse_str(run_id).expect("generated import run UUID");
    for file in files {
        let source_kind = file.source_kind.as_str();
        let record_id = Uuid::new_v5(
            &run_namespace,
            format!("{source_kind}:{}:file", file.locator).as_bytes(),
        )
        .to_string();
        tx.execute(
            "INSERT INTO import_records (
               id, run_id, source_kind, source_locator, source_item_key,
               source_digest, target_type, target_id, action, result,
               observed_at
             ) VALUES (
               ?1, ?2, ?3, ?4, 'file', ?5, 'source_file', NULL,
               'create', 'applied', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )",
            params![record_id, run_id, source_kind, file.locator, file.sha256],
        )?;
        tx.execute(
            "INSERT INTO import_source_records (
               source_kind, source_locator, source_item_key, source_digest,
               target_type, target_id, last_import_run_id, imported_at
             ) VALUES (
               ?1, ?2, 'file', ?3, 'source_file', NULL, ?4,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )",
            params![source_kind, file.locator, file.sha256, run_id],
        )?;
    }
    Ok(())
}

fn existing_receipt(
    tx: &Transaction<'_>,
    idempotency_key: &str,
    request_digest: &str,
) -> Result<Option<MutationResult>, DomainError> {
    let receipt = tx
        .query_row(
            "SELECT request_digest, result_revision
             FROM command_receipts WHERE idempotency_key = ?1",
            [idempotency_key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    match receipt {
        None => Ok(None),
        Some((stored_digest, revision)) if stored_digest == request_digest => {
            Ok(Some(MutationResult {
                revision,
                replayed: true,
            }))
        }
        Some(_) => Err(DomainError::IdempotencyConflict),
    }
}

fn record_receipt(
    tx: &Transaction<'_>,
    idempotency_key: &str,
    command_kind: &str,
    request_digest: &str,
    result_revision: i64,
) -> Result<(), DomainError> {
    tx.execute(
        "INSERT INTO command_receipts (
           idempotency_key, command_kind, request_digest, result_revision, created_at
         ) VALUES (
           ?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         )",
        params![
            idempotency_key,
            command_kind,
            request_digest,
            result_revision
        ],
    )?;
    Ok(())
}

fn map_storage_error(error: rusqlite::Error) -> DomainError {
    let message = error.to_string();
    if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        DomainError::NotFound
    } else if message.contains("invalid_parent_kind") {
        DomainError::InvalidParentKind
    } else if message.contains("work_tree_cycle") {
        DomainError::WorkTreeCycle
    } else if message.contains("work_nodes.parent_id, work_nodes.key") {
        DomainError::SiblingKeyConflict
    } else if message.contains("work_nodes.parent_id, work_nodes.position") {
        DomainError::SiblingPositionConflict
    } else if message.contains("today_target_kind_mismatch") {
        DomainError::InvalidTodayTarget
    } else if message.contains("archived_parent") || message.contains("archived_node") {
        DomainError::ArchivedNode
    } else if message
        .contains("resource_bindings.node_id, resource_bindings.kind, resource_bindings.locator")
    {
        DomainError::ResourceBindingConflict
    } else if message.contains("resource_bindings.node_id, resource_bindings.kind") {
        DomainError::PrimaryResourceConflict
    } else if message.contains("tags_json")
        || message.contains("evidence_json")
        || message.contains("scope_json")
        || message.contains("report_json")
    {
        DomainError::InvalidJson
    } else if message.contains("UNIQUE constraint failed") {
        DomainError::AlreadyExists
    } else if message.contains("constraint failed") {
        DomainError::ConstraintViolation(message)
    } else {
        DomainError::Storage(error)
    }
}

#[cfg(test)]
mod tests;
