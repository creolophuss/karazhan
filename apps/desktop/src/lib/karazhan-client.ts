import { invoke } from "@tauri-apps/api/core";

export type ActorType =
  | "user"
  | "task_agent"
  | "medivh"
  | "system"
  | "unknown";

export type Channel = "ui" | "api" | "mcp" | "import";
export type WorkStatus =
  | "planned"
  | "ready"
  | "in_progress"
  | "pending"
  | "review"
  | "done"
  | "cancelled";
export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type ProgressEventKind = "progress" | "delivery";
export type BacklogKind = "idea" | "problem" | "request" | "research";
export type BacklogStatus =
  | "captured"
  | "considering"
  | "ready"
  | "promoted"
  | "discarded";
export type ResourceKind =
  | "workspace"
  | "manifest"
  | "agent_log"
  | "repository"
  | "external_session"
  | "url"
  | "file"
  | "directory";
export type ResourceAvailability =
  | "available"
  | "missing"
  | "unreadable"
  | "unknown";

export interface CommandContext {
  idempotency_key: string;
  actor_type: ActorType;
  actor_ref: string | null;
  channel: Channel;
}

export type TextUpdate =
  | { action: "set"; value: string }
  | { action: "clear" };

export interface CreateProjectCommand {
  id: string;
  parent_id: string;
  key: string;
  title: string;
  summary: string | null;
  position: number;
  slug: string | null;
  context_path: string | null;
  context: CommandContext;
}

export interface CreateTaskCommand {
  id: string;
  parent_id: string;
  key: string;
  title: string;
  summary: string | null;
  position: number;
  context: CommandContext;
}

export interface CreateBacklogCommand {
  id: string;
  parent_id: string;
  key: string;
  title: string;
  description: string | null;
  kind: BacklogKind;
  priority: Priority;
  tags: string[];
  context: CommandContext;
}

export interface CreateQuickItemCommand {
  id: string;
  description: string;
  event_id: string;
  context: CommandContext;
}

export interface DeleteQuickItemCommand {
  node_id: string;
  expected_revision: number;
  context: CommandContext;
}

export interface AddResourceBindingCommand {
  id: string;
  node_id: string;
  kind: ResourceKind;
  locator: string;
  is_primary: boolean;
  availability: ResourceAvailability;
  source: string;
  context: CommandContext;
}

export interface UpdateResourceAvailabilityCommand {
  binding_id: string;
  availability: ResourceAvailability;
  expected_revision: number;
  context: CommandContext;
}

export interface UpdateWorkItemCommand {
  node_id: string;
  title: string | null;
  summary: TextUpdate | null;
  goal: TextUpdate | null;
  acceptance: TextUpdate | null;
  status: WorkStatus | null;
  priority: Priority | null;
  blocker: TextUpdate | null;
  expected_revision: number;
  event_id: string;
  context: CommandContext;
}

export interface AddTodayCommand {
  node_id: string;
  position: number;
  event_id: string;
  context: CommandContext;
}

export interface RemoveTodayCommand {
  node_id: string;
  expected_revision: number;
  event_id: string;
  context: CommandContext;
}

export interface ReorderTodayCommand {
  node_id: string;
  target_position: number;
  expected_revision: number;
  event_id: string;
  context: CommandContext;
}

export interface AppendProgressCommand {
  node_id: string;
  event_id: string;
  event_kind: ProgressEventKind;
  summary: string;
  details?: string | null;
  step_status: WorkStatus | null;
  expected_revision: number;
  context: CommandContext;
}

export interface ArchiveSubtreeCommand {
  node_id: string;
  expected_revision: number;
  event_id: string;
  context: CommandContext;
}

export interface ReopenArchivedSubtreeCommand {
  node_id: string;
  expected_revision: number;
  event_id: string;
  context: CommandContext;
}

export interface PermanentlyDeleteArchivedSubtreeCommand {
  node_id: string;
  expected_revision: number;
  context: CommandContext;
}

export interface UpdateBacklogCommand {
  node_id: string;
  title: string | null;
  notes: TextUpdate | null;
  kind: BacklogKind | null;
  priority: Priority | null;
  tags: string[] | null;
  expected_revision: number;
  context: CommandContext;
}

export interface DiscardBacklogCommand {
  node_id: string;
  expected_revision: number;
  context: CommandContext;
}

export interface MoveBacklogCommand {
  node_id: string;
  parent_id: string;
  target_position: number | null;
  expected_revision: number;
  context: CommandContext;
}

export interface ReorderNodeCommand {
  node_id: string;
  target_position: number;
  expected_revision: number;
  context: CommandContext;
}

export type BacklogPromotionTarget =
  | {
      type: "project";
      id: string;
      parent_id: string;
      key: string;
      title: string;
      position?: number;
      slug: string | null;
      context_path: string | null;
    }
  | {
      type: "task";
      id: string;
      parent_id: string;
      key: string;
      title: string;
      position?: number;
    };

export interface PromoteBacklogCommand {
  backlog_id: string;
  target: BacklogPromotionTarget;
  expected_revision: number;
  context: CommandContext;
}

export interface LegacyApplyCommand {
  report: LegacyDryRunReport;
  idempotency_key: string;
}

export type MutationCommand =
  | { type: "create_project"; payload: CreateProjectCommand }
  | { type: "create_task"; payload: CreateTaskCommand }
  | { type: "create_backlog"; payload: CreateBacklogCommand }
  | { type: "create_quick_item"; payload: CreateQuickItemCommand }
  | { type: "delete_quick_item"; payload: DeleteQuickItemCommand }
  | { type: "add_resource_binding"; payload: AddResourceBindingCommand }
  | {
      type: "update_resource_availability";
      payload: UpdateResourceAvailabilityCommand;
    }
  | { type: "update_work_item"; payload: UpdateWorkItemCommand }
  | { type: "add_today"; payload: AddTodayCommand }
  | { type: "remove_today"; payload: RemoveTodayCommand }
  | { type: "reorder_today"; payload: ReorderTodayCommand }
  | { type: "append_progress"; payload: AppendProgressCommand }
  | { type: "update_backlog"; payload: UpdateBacklogCommand }
  | { type: "discard_backlog"; payload: DiscardBacklogCommand }
  | { type: "move_backlog"; payload: MoveBacklogCommand }
  | { type: "reorder_node"; payload: ReorderNodeCommand }
  | { type: "archive_subtree"; payload: ArchiveSubtreeCommand }
  | { type: "reopen_archived_subtree"; payload: ReopenArchivedSubtreeCommand }
  | {
      type: "permanently_delete_archived_subtree";
      payload: PermanentlyDeleteArchivedSubtreeCommand;
    };

export type LegacyApplyWireCommand = {
  type: "legacy_apply";
  payload: LegacyApplyCommand;
};

export type PromoteBacklogWireCommand = {
  type: "promote_backlog";
  payload: PromoteBacklogCommand;
};

export type Command = MutationCommand | PromoteBacklogWireCommand | LegacyApplyWireCommand;

export type Query =
  | { type: "get_project"; id: string }
  | { type: "list_projects" }
  | { type: "get_task"; id: string }
  | { type: "list_tasks" }
  | { type: "list_project_task_tree" }
  | { type: "list_archived_project_task_tree" }
  | { type: "list_backlog"; filter: BacklogFilter }
  | { type: "list_today" }
  | { type: "recent_progress"; node_id: string; limit: number }
  | { type: "recent_subtree_progress"; node_id: string; limit: number }
  | { type: "progress_timeline"; node_id: string }
  | { type: "subtree_progress_timeline"; node_id: string }
  | { type: "project_context_path"; node_id: string }
  | { type: "list_resource_bindings"; node_id: string }
  | { type: "legacy_dry_run"; source_root: string; scope: LegacyDryRunScope };

export interface LegacyDryRunScope {
  tasks_registry: string;
  backlog_registry: string;
  task_manifests: string[];
  agent_logs: string[];
  project_contexts: string[];
}

export interface BacklogFilter {
  parent_id?: string;
  kind?: BacklogKind;
  status?: BacklogStatus;
  priority?: Priority;
  tag?: string;
}

export interface LegacySourceFileSnapshot {
  source_kind: "tasks_registry" | "backlog_registry" | "task_manifest" | "agent_log";
  locator: string;
  byte_length: number;
  sha256: string;
}

export interface LegacyProjectContextSnapshot {
  locator: string;
  exists: boolean;
}

export interface LegacyDryRunReport {
  ruleset_version: string;
  source_root: string;
  scope: LegacyDryRunScope;
  source_files: LegacySourceFileSnapshot[];
  project_contexts: LegacyProjectContextSnapshot[];
  summary: {
    legacy_projects: number;
    legacy_tasks: number;
    next_action_tasks: number;
    legacy_backlog_items: number;
    work_nodes: number;
    resource_bindings: number;
    progress_events: number;
    today_items: number;
  };
  project_mappings: LegacyProjectMapping[];
  legacy_task_mappings: LegacyTaskMapping[];
  legacy_next_action_task_mappings: LegacyNextActionTaskMapping[];
  backlog_mappings: LegacyBacklogMapping[];
  resource_binding_mappings: LegacyResourceBindingMapping[];
  progress_event_mappings: LegacyProgressEventMapping[];
  today_item_mappings: LegacyTodayItemMapping[];
  conflicts: LegacyConflict[];
  source_snapshot_digest: string;
  report_digest: string;
  apply_eligible: boolean;
}

export interface LegacyProjectMapping {
  source_slug: string;
  target_id: string;
  parent_id: string;
  key: string;
  title: string;
  position: number;
  context_path: string | null;
}

export interface LegacyTaskMapping {
  source_id: string;
  target_id: string;
  parent_id: string;
  key: string;
  title: string;
  position: number;
  work_status: string;
  priority: string;
  raw_status: string | null;
}

export interface LegacyBacklogMapping {
  source_id: string;
  target_id: string;
  parent_id: string;
  key: string;
  title: string;
  position: number;
  backlog_kind: string;
  backlog_status: string;
  promoted_node_id: string | null;
}

export interface LegacyResourceBindingMapping {
  id: string;
  node_id: string;
  kind: "workspace" | "manifest" | "agent_log";
  locator: string;
}

export interface LegacyProgressEventMapping {
  id: string;
  subject_node_id: string;
  source_binding_id: string;
  source_item_key: string;
  source_digest: string;
  summary: string;
}

export interface LegacyTodayItemMapping {
  node_id: string;
  position: number;
}

export interface LegacyConflict {
  code: string;
  severity: "info" | "warning" | "blocker";
  count: number;
  evidence: string[];
  safe_default: string;
  requires_confirmation: boolean;
}

export interface LegacyNextActionTaskMapping {
  source_task_id: string;
  target_id: string;
  parent_id: string;
  key: string;
  title: string;
  position: number;
  work_status: "planned";
  priority: "none";
}

export interface MutationResult {
  revision: number;
  replayed: boolean;
}

export interface LegacyApplyResult {
  run_id: string;
  status: string;
  report_digest: string;
  counts: {
    work_nodes: number;
    projects: number;
    tasks: number;
    backlog_items: number;
    today_items: number;
    progress_events: number;
    resource_bindings: number;
  };
  replayed: boolean;
}

export type MutationCommandResult = { type: "mutation"; payload: MutationResult };
export type LegacyApplyCommandResult = {
  type: "legacy_apply";
  payload: LegacyApplyResult;
};
export type CommandResult = MutationCommandResult | LegacyApplyCommandResult;
export interface PromotionResult {
  target_node_id: string;
  source_revision: number;
  replayed: boolean;
}
export type PromotionCommandResult = { type: "promotion"; payload: PromotionResult };

export interface Project {
  id: string;
  parent_id: string;
  key: string;
  title: string;
  summary: string | null;
  goal: string | null;
  acceptance: string | null;
  status: WorkStatus;
  priority: Priority;
  blocker: string | null;
  slug: string | null;
  context_path: string | null;
  revision: number;
}

export interface Task {
  id: string;
  parent_id: string;
  key: string;
  title: string;
  summary: string | null;
  goal: string | null;
  acceptance: string | null;
  status: WorkStatus;
  priority: Priority;
  blocker: string | null;
  revision: number;
  has_steps: boolean;
}

export interface TodayItem {
  node_id: string;
  kind: "project" | "task";
  title: string;
  summary: string | null;
  path_titles: string[];
  position: number;
  revision: number;
  work_revision: number;
  status: WorkStatus;
  priority: Priority;
  blocker: string | null;
  has_steps: boolean;
  has_available_workspace: boolean;
  child_items: ProjectTaskItem[];
  is_quick_item: boolean;
}

export interface ProjectTaskItem {
  id: string;
  parent_id: string;
  kind: "project" | "task";
  key: string;
  title: string;
  summary: string | null;
  goal: string | null;
  acceptance: string | null;
  status: WorkStatus;
  priority: Priority;
  blocker: string | null;
  position: number;
  revision: number;
  has_steps: boolean;
}

export interface BacklogItem {
  id: string;
  parent_id: string;
  parent_breadcrumb: string[];
  key: string;
  title: string;
  priority: Priority;
  position: number;
  revision: number;
  backlog_kind: BacklogKind;
  backlog_status: BacklogStatus;
  notes: string | null;
  tags: string[];
  source: string | null;
  promoted_node_id: string | null;
}

export interface ProgressEvent {
  id: string;
  subject_node_id: string;
  subject_title: string;
  occurred_at: string;
  recorded_at: string;
  event_type: string;
  summary: string;
  details: string | null;
  step_status: WorkStatus | null;
  blocker: string | null;
  actor_type: ActorType;
  actor_ref: string | null;
  channel: Channel;
}

export interface ResourceBinding {
  id: string;
  node_id: string;
  kind: ResourceKind;
  locator: string;
  is_primary: boolean;
  availability: ResourceAvailability;
  source: string;
  created_at: string;
  updated_at: string;
  created_actor: string;
  updated_actor: string;
  write_source: string;
  revision: number;
}

export type QueryResult =
  | { type: "project"; payload: Project }
  | { type: "projects"; payload: Project[] }
  | { type: "task"; payload: Task }
  | { type: "tasks"; payload: Task[] }
  | { type: "project_task_tree"; payload: ProjectTaskItem[] }
  | { type: "backlog"; payload: BacklogItem[] }
  | { type: "today"; payload: TodayItem[] }
  | { type: "progress_events"; payload: ProgressEvent[] }
  | { type: "context_path"; payload: string | null }
  | { type: "resource_bindings"; payload: ResourceBinding[] }
  | { type: "legacy_dry_run"; payload: LegacyDryRunReport };

export interface KarazhanError {
  code: string;
  message: string;
}

export type NativeInvoke = <T>(
  command: string,
  arguments_?: Record<string, unknown>,
) => Promise<T>;

export interface KarazhanClient {
  execute(command: MutationCommand): Promise<MutationCommandResult>;
  execute(command: PromoteBacklogWireCommand): Promise<PromotionCommandResult>;
  execute(command: LegacyApplyWireCommand): Promise<LegacyApplyCommandResult>;
  query(query: Query): Promise<QueryResult>;
  openInZed(nodeId: string): Promise<void>;
}

export function createKarazhanClient(
  nativeInvoke: NativeInvoke = invoke,
): KarazhanClient {
  const execute = (command: Command) =>
    nativeInvoke<CommandResult | PromotionCommandResult>("execute_command", { command });
  return {
    execute: execute as KarazhanClient["execute"],
    query(query) {
      return nativeInvoke<QueryResult>("run_query", { query });
    },
    openInZed(nodeId) {
      return nativeInvoke<void>("open_in_zed", { nodeId });
    },
  };
}

export const karazhanClient = createKarazhanClient();
