use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};

use crate::{
    ActorType, Channel, CommandMetadata, Database, DomainError, LegacyApplyResult,
    LegacyDryRunReport, LegacyDryRunScope, MutationResult, NewProgressEvent, NewProject, NewTask,
    Priority, ProgressEvent, ProgressEventKind, Project, ProjectTaskItem, Task, TextChange,
    TodayItem, WorkItemPatch, WorkStatus, dry_run_legacy_source,
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
pub struct PermanentlyDeleteArchivedSubtreeCommand {
    pub node_id: String,
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
    UpdateWorkItem(UpdateWorkItemCommand),
    AddToday(AddTodayCommand),
    RemoveToday(RemoveTodayCommand),
    ReorderToday(ReorderTodayCommand),
    AppendProgress(AppendProgressCommand),
    ArchiveSubtree(ArchiveSubtreeCommand),
    PermanentlyDeleteArchivedSubtree(PermanentlyDeleteArchivedSubtreeCommand),
    LegacyApply(LegacyApplyCommand),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum CommandResult {
    Mutation(MutationResult),
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
    ListToday,
    RecentProgress {
        node_id: String,
        limit: usize,
    },
    ProgressTimeline {
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
            Command::ArchiveSubtree(command) => self.database.archive_subtree(
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
            Query::ListToday => Ok(QueryResult::Today(self.database.list_today()?)),
            Query::RecentProgress { node_id, limit } => Ok(QueryResult::ProgressEvents(
                self.database.recent_progress_events(&node_id, limit)?,
            )),
            Query::ProgressTimeline { node_id } => Ok(QueryResult::ProgressEvents(
                self.database.progress_timeline(&node_id)?,
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
