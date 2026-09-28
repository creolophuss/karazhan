use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};

use crate::{
    ActorType, BacklogFilter, BacklogItem, BacklogKind, BacklogPatch, Channel, CommandMetadata,
    Database, DomainError, LegacyApplyResult, LegacyDryRunReport, LegacyDryRunScope,
    MutationResult, NewBacklog, NewProgressEvent, NewProject, NewResourceBinding, NewTask,
    Priority, ProgressEvent, ProgressEventKind, Project, ProjectTaskItem, PromotionResult,
    PromotionTarget, ResourceAvailability, ResourceKind, Task, TextChange, TodayItem,
    WorkItemPatch, WorkStatus, dry_run_legacy_source,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandContext {
    pub idempotency_key: String,
    pub actor_type: ActorType,
    pub actor_ref: Option<String>,
    pub channel: Channel,
}

impl CommandContext {
    fn metadata(&self) -> CommandMetadata<'_> {
        CommandMetadata {
            idempotency_key: &self.idempotency_key,
            actor_type: self.actor_type,
            actor_ref: self.actor_ref.as_deref(),
            channel: self.channel,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateProjectCommand {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub position: i64,
    pub slug: Option<String>,
    pub context_path: Option<String>,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateTaskCommand {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub position: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateBacklogCommand {
    pub id: String,
    pub parent_id: String,
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub kind: BacklogKind,
    pub priority: Priority,
    #[serde(default)]
    pub tags: Vec<String>,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateQuickItemCommand {
    pub id: String,
    pub description: String,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteQuickItemCommand {
    pub node_id: String,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddResourceBindingCommand {
    pub id: String,
    pub node_id: String,
    pub kind: ResourceKind,
    pub locator: String,
    pub is_primary: bool,
    pub availability: ResourceAvailability,
    pub source: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateResourceAvailabilityCommand {
    pub binding_id: String,
    pub availability: ResourceAvailability,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "snake_case")]
pub enum TextUpdate {
    Set(String),
    Clear,
}

impl TextUpdate {
    fn as_change(&self) -> TextChange<'_> {
        match self {
            Self::Set(value) => TextChange::Set(value),
            Self::Clear => TextChange::Clear,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateWorkItemCommand {
    pub node_id: String,
    pub title: Option<String>,
    pub summary: Option<TextUpdate>,
    pub goal: Option<TextUpdate>,
    pub acceptance: Option<TextUpdate>,
    pub status: Option<WorkStatus>,
    pub priority: Option<Priority>,
    pub blocker: Option<TextUpdate>,
    pub expected_revision: i64,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddTodayCommand {
    pub node_id: String,
    pub position: i64,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoveTodayCommand {
    pub node_id: String,
    pub expected_revision: i64,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReorderTodayCommand {
    pub node_id: String,
    pub target_position: usize,
    pub expected_revision: i64,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppendProgressCommand {
    pub node_id: String,
    pub event_id: String,
    pub event_kind: ProgressEventKind,
    pub summary: String,
    #[serde(default)]
    pub step_status: Option<WorkStatus>,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveSubtreeCommand {
    pub node_id: String,
    pub expected_revision: i64,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReopenArchivedSubtreeCommand {
    pub node_id: String,
    pub expected_revision: i64,
    pub event_id: String,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermanentlyDeleteArchivedSubtreeCommand {
    pub node_id: String,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateBacklogCommand {
    pub node_id: String,
    pub title: Option<String>,
    pub notes: Option<TextUpdate>,
    pub kind: Option<BacklogKind>,
    pub priority: Option<Priority>,
    pub tags: Option<Vec<String>>,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscardBacklogCommand {
    pub node_id: String,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveBacklogCommand {
    pub node_id: String,
    pub parent_id: String,
    #[serde(default)]
    pub target_position: Option<usize>,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReorderNodeCommand {
    pub node_id: String,
    pub target_position: usize,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BacklogPromotionTarget {
    Project {
        id: String,
        parent_id: String,
        key: String,
        title: String,
        #[serde(default)]
        position: Option<i64>,
        slug: Option<String>,
        context_path: Option<String>,
    },
    Task {
        id: String,
        parent_id: String,
        key: String,
        title: String,
        #[serde(default)]
        position: Option<i64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromoteBacklogCommand {
    pub backlog_id: String,
    pub target: BacklogPromotionTarget,
    pub expected_revision: i64,
    pub context: CommandContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyApplyCommand {
    pub report: Box<LegacyDryRunReport>,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum Command {
    CreateProject(CreateProjectCommand),
    CreateTask(CreateTaskCommand),
    CreateBacklog(CreateBacklogCommand),
    CreateQuickItem(CreateQuickItemCommand),
    DeleteQuickItem(DeleteQuickItemCommand),
    AddResourceBinding(AddResourceBindingCommand),
    UpdateResourceAvailability(UpdateResourceAvailabilityCommand),
    UpdateWorkItem(UpdateWorkItemCommand),
    AddToday(AddTodayCommand),
    RemoveToday(RemoveTodayCommand),
    ReorderToday(ReorderTodayCommand),
    AppendProgress(AppendProgressCommand),
    UpdateBacklog(UpdateBacklogCommand),
    DiscardBacklog(DiscardBacklogCommand),
    MoveBacklog(MoveBacklogCommand),
    ReorderNode(ReorderNodeCommand),
    PromoteBacklog(PromoteBacklogCommand),
    ArchiveSubtree(ArchiveSubtreeCommand),
    ReopenArchivedSubtree(ReopenArchivedSubtreeCommand),
    PermanentlyDeleteArchivedSubtree(PermanentlyDeleteArchivedSubtreeCommand),
    LegacyApply(LegacyApplyCommand),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum CommandResult {
    Mutation(MutationResult),
    Promotion(PromotionResult),
    LegacyApply(Box<LegacyApplyResult>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Query {
    GetProject {
        id: String,
    },
    ListProjects,
    GetTask {
        id: String,
    },
    ListTasks,
    ListProjectTaskTree,
    ListArchivedProjectTaskTree,
    ListBacklog {
        #[serde(default)]
        filter: BacklogFilter,
    },
    ListToday,
    RecentProgress {
        node_id: String,
        limit: usize,
    },
    RecentSubtreeProgress {
        node_id: String,
        limit: usize,
    },
    ProgressTimeline {
        node_id: String,
    },
    SubtreeProgressTimeline {
        node_id: String,
    },
    ProjectContextPath {
        node_id: String,
    },
    ListResourceBindings {
        node_id: String,
    },
    LegacyDryRun {
        source_root: String,
        scope: LegacyDryRunScope,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum QueryResult {
    Project(Project),
    Projects(Vec<Project>),
    Task(Task),
    Tasks(Vec<Task>),
    ProjectTaskTree(Vec<ProjectTaskItem>),
    Backlog(Vec<BacklogItem>),
    Today(Vec<TodayItem>),
    ProgressEvents(Vec<ProgressEvent>),
    ContextPath(Option<String>),
    ResourceBindings(Vec<crate::ResourceBinding>),
    LegacyDryRun(Box<LegacyDryRunReport>),
}

pub struct Application {
    database: Database,
}

pub type SharedApplication = Arc<Mutex<Application>>;

pub fn share_application(application: Application) -> SharedApplication {
    Arc::new(Mutex::new(application))
}

impl Application {
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, DomainError> {
        Ok(Self::new(Database::open(path)?))
    }

    pub fn execute(&mut self, command: Command) -> Result<CommandResult, DomainError> {
        let result = match command {
            Command::CreateProject(command) => self.database.create_project_with_summary(
                NewProject {
                    id: &command.id,
                    parent_id: &command.parent_id,
                    key: &command.key,
                    title: &command.title,
                    position: command.position,
                    slug: command.slug.as_deref(),
                    context_path: command.context_path.as_deref(),
                },
                command.summary.as_deref(),
                command.context.metadata(),
            )?,
            Command::CreateTask(command) => self.database.create_task_with_summary(
                NewTask {
                    id: &command.id,
                    parent_id: &command.parent_id,
                    key: &command.key,
                    title: &command.title,
                    position: command.position,
                },
                command.summary.as_deref(),
                command.context.metadata(),
            )?,
            Command::CreateBacklog(command) => {
                let tags_json = serde_json::to_string(&command.tags)?;
                self.database.create_backlog(
                    NewBacklog {
                        id: &command.id,
                        parent_id: &command.parent_id,
                        key: &command.key,
                        title: &command.title,
                        notes: command.description.as_deref(),
                        kind: command.kind,
                        priority: command.priority,
                        tags_json: &tags_json,
                    },
                    command.context.metadata(),
                )?
            }
            Command::CreateQuickItem(command) => self.database.create_quick_item(
                &command.id,
                &command.description,
                &command.event_id,
                command.context.metadata(),
            )?,
            Command::DeleteQuickItem(command) => self.database.delete_quick_item(
                &command.node_id,
                command.expected_revision,
                command.context.metadata(),
            )?,
            Command::AddResourceBinding(command) => self.database.add_resource_binding(
                NewResourceBinding {
                    id: &command.id,
                    node_id: &command.node_id,
                    kind: command.kind,
                    locator: &command.locator,
                    is_primary: command.is_primary,
                    availability: command.availability,
                    source: &command.source,
                },
                command.context.metadata(),
            )?,
            Command::UpdateResourceAvailability(command) => {
                self.database.update_resource_availability(
                    &command.binding_id,
                    command.availability,
                    command.expected_revision,
                    command.context.metadata(),
                )?
            }
            Command::UpdateWorkItem(command) => {
                let patch = WorkItemPatch {
                    title: command.title.as_deref(),
                    summary: command
                        .summary
                        .as_ref()
                        .map_or(TextChange::Keep, TextUpdate::as_change),
                    goal: command
                        .goal
                        .as_ref()
                        .map_or(TextChange::Keep, TextUpdate::as_change),
                    acceptance: command
                        .acceptance
                        .as_ref()
                        .map_or(TextChange::Keep, TextUpdate::as_change),
                    status: command.status,
                    priority: command.priority,
                    blocker: command
                        .blocker
                        .as_ref()
                        .map_or(TextChange::Keep, TextUpdate::as_change),
                };
                self.database.update_work_item(
                    &command.node_id,
                    patch,
                    command.expected_revision,
                    &command.event_id,
                    command.context.metadata(),
                )?
            }
            Command::AddToday(command) => self.database.add_to_today(
                &command.node_id,
                command.position,
                &command.event_id,
                command.context.metadata(),
            )?,
            Command::RemoveToday(command) => self.database.remove_from_today(
                &command.node_id,
                command.expected_revision,
                &command.event_id,
                command.context.metadata(),
            )?,
            Command::ReorderToday(command) => self.database.reorder_today_item(
                &command.node_id,
                command.target_position,
                command.expected_revision,
                &command.event_id,
                command.context.metadata(),
            )?,
            Command::AppendProgress(command) => self.database.append_progress_event(
                &command.node_id,
                NewProgressEvent {
                    id: &command.event_id,
                    kind: command.event_kind,
                    summary: &command.summary,
                    step_status: command.step_status,
                },
                command.expected_revision,
                command.context.metadata(),
            )?,
            Command::UpdateBacklog(command) => {
                let tags_json = command
                    .tags
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?;
                self.database.update_backlog(
                    &command.node_id,
                    BacklogPatch {
                        title: command.title.as_deref(),
                        notes: command
                            .notes
                            .as_ref()
                            .map_or(TextChange::Keep, TextUpdate::as_change),
                        kind: command.kind,
                        priority: command.priority,
                        tags_json: tags_json.as_deref(),
                    },
                    command.expected_revision,
                    command.context.metadata(),
                )?
            }
            Command::DiscardBacklog(command) => self.database.discard_backlog(
                &command.node_id,
                command.expected_revision,
                command.context.metadata(),
            )?,
            Command::MoveBacklog(command) => self.database.move_backlog(
                &command.node_id,
                &command.parent_id,
                command.target_position,
                command.expected_revision,
                command.context.metadata(),
            )?,
            Command::ReorderNode(command) => self.database.reorder_node(
                &command.node_id,
                command.target_position,
                command.expected_revision,
                command.context.metadata(),
            )?,
            Command::PromoteBacklog(command) => {
                let target = match &command.target {
                    BacklogPromotionTarget::Project {
                        id,
                        parent_id,
                        key,
                        title,
                        position,
                        slug,
                        context_path,
                    } => {
                        let project = NewProject {
                            id,
                            parent_id,
                            key,
                            title,
                            position: position.unwrap_or_default(),
                            slug: slug.as_deref(),
                            context_path: context_path.as_deref(),
                        };
                        if position.is_some() {
                            PromotionTarget::Project(project)
                        } else {
                            PromotionTarget::ProjectAtEnd(project)
                        }
                    }
                    BacklogPromotionTarget::Task {
                        id,
                        parent_id,
                        key,
                        title,
                        position,
                    } => {
                        let task = NewTask {
                            id,
                            parent_id,
                            key,
                            title,
                            position: position.unwrap_or_default(),
                        };
                        if position.is_some() {
                            PromotionTarget::Task(task)
                        } else {
                            PromotionTarget::TaskAtEnd(task)
                        }
                    }
                };
                return Ok(CommandResult::Promotion(self.database.promote_backlog(
                    &command.backlog_id,
                    target,
                    command.expected_revision,
                    command.context.metadata(),
                )?));
            }
            Command::ArchiveSubtree(command) => self.database.archive_subtree(
                &command.node_id,
                command.expected_revision,
                &command.event_id,
                command.context.metadata(),
            )?,
            Command::ReopenArchivedSubtree(command) => self.database.reopen_archived_subtree(
                &command.node_id,
                command.expected_revision,
                &command.event_id,
                command.context.metadata(),
            )?,
            Command::PermanentlyDeleteArchivedSubtree(command) => {
                self.database.permanently_delete_archived_subtree(
                    &command.node_id,
                    command.expected_revision,
                    command.context.metadata(),
                )?
            }
            Command::LegacyApply(command) => {
                return Ok(CommandResult::LegacyApply(Box::new(
                    self.database
                        .apply_legacy_report(&command.report, &command.idempotency_key)?,
                )));
            }
        };
        Ok(CommandResult::Mutation(result))
    }

    pub fn query(&self, query: Query) -> Result<QueryResult, DomainError> {
        match query {
            Query::GetProject { id } => Ok(QueryResult::Project(self.database.get_project(&id)?)),
            Query::ListProjects => Ok(QueryResult::Projects(self.database.list_projects()?)),
            Query::GetTask { id } => Ok(QueryResult::Task(self.database.get_task(&id)?)),
            Query::ListTasks => Ok(QueryResult::Tasks(self.database.list_tasks()?)),
            Query::ListProjectTaskTree => Ok(QueryResult::ProjectTaskTree(
                self.database.list_project_task_tree()?,
            )),
            Query::ListArchivedProjectTaskTree => Ok(QueryResult::ProjectTaskTree(
                self.database.list_archived_project_task_tree()?,
            )),
            Query::ListBacklog { filter } => {
                Ok(QueryResult::Backlog(self.database.list_backlog(&filter)?))
            }
            Query::ListToday => Ok(QueryResult::Today(self.database.list_today()?)),
            Query::RecentProgress { node_id, limit } => Ok(QueryResult::ProgressEvents(
                self.database.recent_progress_events(&node_id, limit)?,
            )),
            Query::RecentSubtreeProgress { node_id, limit } => Ok(QueryResult::ProgressEvents(
                self.database
                    .recent_subtree_progress_events(&node_id, limit)?,
            )),
            Query::ProgressTimeline { node_id } => Ok(QueryResult::ProgressEvents(
                self.database.progress_timeline(&node_id)?,
            )),
            Query::SubtreeProgressTimeline { node_id } => Ok(QueryResult::ProgressEvents(
                self.database.subtree_progress_timeline(&node_id)?,
            )),
            Query::ProjectContextPath { node_id } => Ok(QueryResult::ContextPath(
                self.database.project_context_path(&node_id)?,
            )),
            Query::ListResourceBindings { node_id } => Ok(QueryResult::ResourceBindings(
                self.database.list_resource_bindings(&node_id)?,
            )),
            Query::LegacyDryRun { source_root, scope } => Ok(QueryResult::LegacyDryRun(Box::new(
                dry_run_legacy_source(source_root, &scope)?,
            ))),
        }
    }
}
