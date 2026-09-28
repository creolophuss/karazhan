import {
  karazhanClient,
  type KarazhanClient,
  type MutationCommand,
  type Priority,
  type ProgressEvent,
  type ProjectTaskItem,
  type TextUpdate,
  type TodayItem,
  type WorkStatus,
} from "../lib/karazhan-client.ts";

type TodayReader = Pick<KarazhanClient, "query">;
type TodayWriter = Pick<KarazhanClient, "execute">;
type TodayIdentity = Pick<TodayItem, "node_id">;
type TodayPosition = Pick<TodayItem, "node_id" | "position">;
type OperationIdFactory = () => string;

const newOperationId: OperationIdFactory = () => globalThis.crypto.randomUUID();

function uiContext(operationId: string) {
  return {
    idempotency_key: operationId,
    actor_type: "user" as const,
    actor_ref: null,
    channel: "ui" as const,
  };
}

export async function addTodayMembership(
  client: TodayWriter,
  nodeId: string,
  position: number,
  createId: OperationIdFactory = newOperationId,
): Promise<number> {
  const operationId = createId();
  const result = await client.execute({
    type: "add_today",
    payload: {
      node_id: nodeId,
      position,
      event_id: operationId,
      context: uiContext(operationId),
    },
  });
  return result.payload.revision;
}

export async function createQuickItem(
  client: TodayWriter,
  description: string,
  createId: OperationIdFactory = newOperationId,
): Promise<number> {
  const nodeId = createId();
  const eventId = createId();
  const result = await client.execute({
    type: "create_quick_item",
    payload: {
      id: nodeId,
      description: description.trim(),
      event_id: eventId,
      context: uiContext(`create-quick-item:${nodeId}`),
    },
  });
  return result.payload.revision;
}

export async function deleteQuickItem(
  client: TodayWriter,
  nodeId: string,
  expectedRevision: number,
  createId: OperationIdFactory = newOperationId,
): Promise<number> {
  const operationId = createId();
  const result = await client.execute({
    type: "delete_quick_item",
    payload: {
      node_id: nodeId,
      expected_revision: expectedRevision,
      context: uiContext(operationId),
    },
  });
  return result.payload.revision;
}

export async function removeTodayMembership(
  client: TodayWriter,
  nodeId: string,
  expectedRevision: number,
  createId: OperationIdFactory = newOperationId,
): Promise<number> {
  const operationId = createId();
  const result = await client.execute({
    type: "remove_today",
    payload: {
      node_id: nodeId,
      expected_revision: expectedRevision,
      event_id: operationId,
      context: uiContext(operationId),
    },
  });
  return result.payload.revision;
}

export async function reorderTodayMembership(
  client: TodayWriter,
  nodeId: string,
  targetPosition: number,
  expectedRevision: number,
  createId: OperationIdFactory = newOperationId,
): Promise<number> {
  const operationId = createId();
  const result = await client.execute({
    type: "reorder_today",
    payload: {
      node_id: nodeId,
      target_position: targetPosition,
      expected_revision: expectedRevision,
      event_id: operationId,
      context: uiContext(operationId),
    },
  });
  return result.payload.revision;
}

export function moveTodayItem<T extends TodayPosition>(
  items: readonly T[],
  nodeId: string,
  targetPosition: number,
): T[] {
  const sourceIndex = items.findIndex((item) => item.node_id === nodeId);
  if (
    sourceIndex < 0 ||
    targetPosition < 0 ||
    targetPosition >= items.length
  ) {
    throw new Error("invalid Today drag target");
  }
  const next = [...items];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetPosition, 0, moved);
  return next.map((item, position) => ({ ...item, position }));
}

export interface WorkItemFieldInput {
  nodeId: string;
  expectedRevision: number;
  title?: string;
  summary?: string;
  goal?: string;
  acceptance?: string;
  status: WorkStatus;
  priority: Priority;
  blocker: string;
}

function optionalTextUpdate(value: string | undefined): TextUpdate | null {
  if (value === undefined) return null;
  return value.trim().length === 0
    ? { action: "clear" }
    : { action: "set", value };
}

export type SaveFeedback =
  | { status: "idle"; message: "" }
  | { status: "saving"; message: "Saving…" }
  | { status: "success"; message: "Saved." }
  | { status: "conflict" | "error"; message: string };

export async function saveWorkItemFields(
  client: TodayWriter,
  input: WorkItemFieldInput,
  report: (feedback: SaveFeedback) => void,
  createOperationId: OperationIdFactory = newOperationId,
): Promise<number> {
  const operationId = createOperationId();
  const blocker = input.blocker.trim();
  const command: MutationCommand = {
    type: "update_work_item",
    payload: {
      node_id: input.nodeId,
      title: input.title === undefined ? null : input.title.trim(),
      summary: optionalTextUpdate(input.summary),
      goal: optionalTextUpdate(input.goal),
      acceptance: optionalTextUpdate(input.acceptance),
      status: input.status,
      priority: input.priority,
      blocker:
        blocker.length === 0
          ? { action: "clear" }
          : { action: "set", value: blocker },
      expected_revision: input.expectedRevision,
      event_id: operationId,
      context: uiContext(operationId),
    },
  };

  report({ status: "saving", message: "Saving…" });
  try {
    const result = await client.execute(command);
    report({ status: "success", message: "Saved." });
    return result.payload.revision;
  } catch (error) {
    const structuredConflict =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "revision_conflict";
    report({
      status: structuredConflict ? "conflict" : "error",
      message: describeClientError(error),
    });
    throw error;
  }
}

export interface TodayChildRow {
  id: string;
  parent_id: string;
  kind: ProjectTaskItem["kind"];
  title: string;
  summary: string | null;
  revision: number;
  status: ProjectTaskItem["status"];
  priority: ProjectTaskItem["priority"];
  blocker: string | null;
  has_steps: boolean;
}

export function childItemRows(item: TodayItem): TodayChildRow[] {
  return item.child_items.map((child) => ({
    id: child.id,
    parent_id: child.parent_id,
    kind: child.kind,
    title: child.title,
    summary: child.summary,
    revision: child.revision,
    status: child.status,
    priority: child.priority,
    blocker: child.blocker,
    has_steps: child.has_steps,
  }));
}

export function childItemPath(item: TodayItem, child: TodayChildRow): string {
  const childrenById = new Map(item.child_items.map((candidate) => [candidate.id, candidate]));
  const childTitles = [child.title];
  let parent = childrenById.get(child.parent_id);
  while (parent) {
    childTitles.unshift(parent.title);
    parent = childrenById.get(parent.parent_id);
  }
  return [...item.path_titles, ...childTitles].join(" › ");
}

export function todayPath(item: Pick<TodayItem, "path_titles">): string {
  return item.path_titles.join(" › ");
}

export function isTodayItemExpandable(
  item: Pick<TodayItem, "kind" | "child_items" | "has_steps" | "is_quick_item">,
): boolean {
  return (
    !item.is_quick_item &&
    (item.kind === "project" || item.child_items.length > 0 || item.has_steps)
  );
}

export function checkboxStatus(checked: boolean): WorkStatus {
  return checked ? "done" : "ready";
}

export function isBusinessStep(event: Pick<ProgressEvent, "event_type" | "summary">): boolean {
  return (
    (event.event_type === "progress" || event.event_type === "delivery") &&
    event.summary !== "work item fields updated"
  );
}

export async function loadRecentSteps(
  client: TodayReader,
  nodeId: string,
  includeDescendants = false,
): Promise<ProgressEvent[]> {
  const result = await client.query({
    type: includeDescendants ? "recent_subtree_progress" : "recent_progress",
    node_id: nodeId,
    limit: 3,
  });
  if (result.type !== "progress_events") {
    throw new Error(`expected progress_events query result, received ${result.type}`);
  }
  return result.payload.filter(isBusinessStep);
}

export async function loadAllSteps(
  client: TodayReader,
  nodeId: string,
  includeDescendants = false,
): Promise<ProgressEvent[]> {
  const result = await client.query({
    type: includeDescendants ? "subtree_progress_timeline" : "progress_timeline",
    node_id: nodeId,
  });
  if (result.type !== "progress_events") {
    throw new Error(`expected progress_events query result, received ${result.type}`);
  }
  return result.payload.filter(isBusinessStep);
}

export function allTodayNodeIds(
  items: readonly TodayIdentity[],
): ReadonlySet<string> {
  return new Set(items.map((item) => item.node_id));
}

export function toggleTodayRow(
  expandedNodeIds: ReadonlySet<string>,
  nodeId: string,
): ReadonlySet<string> {
  const next = new Set(expandedNodeIds);
  if (next.has(nodeId)) {
    next.delete(nodeId);
  } else {
    next.add(nodeId);
  }
  return next;
}

export function setAllTodayRowsExpanded(
  items: readonly TodayIdentity[],
  expanded: boolean,
): ReadonlySet<string> {
  return expanded ? allTodayNodeIds(items) : new Set();
}

export async function loadToday(
  client: TodayReader = karazhanClient,
): Promise<TodayItem[]> {
  const result = await client.query({ type: "list_today" });
  if (result.type !== "today") {
    throw new Error(`expected today query result, received ${result.type}`);
  }
  return result.payload;
}

export function describeClientError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unable to load Today.";
}
