import {
  karazhanClient,
  type KarazhanClient,
  type ProgressEvent,
  type ProjectTaskItem,
  type ResourceBinding,
  type TodayItem,
  type WorkStatus,
} from "../lib/karazhan-client.ts";

type ProjectTreeReader = Pick<KarazhanClient, "query">;
type ZedOpener = Pick<KarazhanClient, "openInZed">;

export interface ProjectNodeDetails {
  recentProgress: ProgressEvent[];
  contextPath: string | null;
  resourceBindings: ResourceBinding[];
}

export interface ProjectTaskTreeNode {
  item: ProjectTaskItem;
  ancestors: ProjectTaskItem[];
  children: ProjectTaskTreeNode[];
}

export function projectTreePath(node: ProjectTaskTreeNode): string {
  return [...node.ancestors.map((ancestor) => ancestor.title), node.item.title].join(" › ");
}

export type ProjectTaskItemPatch = Partial<
  Pick<
    ProjectTaskItem,
    | "title"
    | "summary"
    | "goal"
    | "acceptance"
    | "status"
    | "priority"
    | "blocker"
    | "revision"
  >
>;

function compareNodes(left: ProjectTaskTreeNode, right: ProjectTaskTreeNode) {
  return left.item.position - right.item.position || left.item.id.localeCompare(right.item.id);
}

function sortBranch(nodes: ProjectTaskTreeNode[]) {
  nodes.sort(compareNodes);
  for (const node of nodes) sortBranch(node.children);
}

function assignAncestors(
  nodes: ProjectTaskTreeNode[],
  ancestors: ProjectTaskItem[] = [],
) {
  for (const node of nodes) {
    node.ancestors = ancestors;
    assignAncestors(node.children, [...ancestors, node.item]);
  }
}

export function buildProjectTaskTree(
  items: readonly ProjectTaskItem[],
): ProjectTaskTreeNode[] {
  const nodes = new Map(
    items.map((item) => [
      item.id,
      { item, ancestors: [] as ProjectTaskItem[], children: [] as ProjectTaskTreeNode[] },
    ]),
  );
  const roots: ProjectTaskTreeNode[] = [];

  for (const node of nodes.values()) {
    const parent = nodes.get(node.item.parent_id);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  sortBranch(roots);
  assignAncestors(roots);
  return roots;
}

export function allExpandableNodeIds(
  roots: readonly ProjectTaskTreeNode[],
): ReadonlySet<string> {
  const expanded = new Set<string>();
  const visit = (nodes: readonly ProjectTaskTreeNode[]) => {
    for (const node of nodes) {
      if (node.children.length > 0 || node.item.has_steps) expanded.add(node.item.id);
      visit(node.children);
    }
  };
  visit(roots);
  return expanded;
}

export function toggleTreeNode(
  expandedNodeIds: ReadonlySet<string>,
  nodeId: string,
): ReadonlySet<string> {
  const next = new Set(expandedNodeIds);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  return next;
}

export function todayMembershipByNodeId<T extends Pick<TodayItem, "node_id">>(
  memberships: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(memberships.map((membership) => [membership.node_id, membership]));
}

export function updateProjectTreeItem(
  nodes: readonly ProjectTaskTreeNode[],
  nodeId: string,
  patch: ProjectTaskItemPatch,
): ProjectTaskTreeNode[] {
  return nodes.map((node) => {
    const children = updateProjectTreeItem(node.children, nodeId, patch);
    if (node.item.id === nodeId) {
      return { ...node, item: { ...node.item, ...patch }, children };
    }
    if (children.some((child, index) => child !== node.children[index])) {
      return { ...node, children };
    }
    return node;
  });
}

export async function loadProjectTaskTree(
  client: ProjectTreeReader = karazhanClient,
): Promise<ProjectTaskItem[]> {
  const result = await client.query({ type: "list_project_task_tree" });
  if (result.type !== "project_task_tree") {
    throw new Error(`expected project_task_tree query result, received ${result.type}`);
  }
  return result.payload;
}

export async function loadArchivedProjectTaskTree(
  client: ProjectTreeReader = karazhanClient,
): Promise<ProjectTaskItem[]> {
  const result = await client.query({ type: "list_archived_project_task_tree" });
  if (result.type !== "project_task_tree") {
    throw new Error(`expected project_task_tree query result, received ${result.type}`);
  }
  return result.payload;
}

function uiContext(prefix: string) {
  const operationId = crypto.randomUUID();
  return {
    operationId,
    context: {
      idempotency_key: `${prefix}:${operationId}`,
      actor_type: "user" as const,
      actor_ref: "desktop-user",
      channel: "ui" as const,
    },
  };
}

export async function archiveProjectTask(
  client: KarazhanClient,
  nodeId: string,
  expectedRevision: number,
) {
  const { operationId, context } = uiContext("archive");
  return client.execute({
    type: "archive_subtree",
    payload: {
      node_id: nodeId,
      expected_revision: expectedRevision,
      event_id: operationId,
      context,
    },
  });
}

export async function permanentlyDeleteArchivedProjectTask(
  client: KarazhanClient,
  nodeId: string,
  expectedRevision: number,
) {
  const { context } = uiContext("permanently-delete");
  return client.execute({
    type: "permanently_delete_archived_subtree",
    payload: { node_id: nodeId, expected_revision: expectedRevision, context },
  });
}

export async function createProjectTask(
  client: KarazhanClient,
  kind: "project" | "task",
  parentId: string,
  title: string,
  description: string,
  contextPath: string | null,
  position: number,
) {
  const id = crypto.randomUUID();
  const { context } = uiContext(`create-${kind}`);
  const common = {
    id,
    parent_id: parentId,
    key: `${title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || kind}-${id.slice(0, 8)}`,
    title: title.trim(),
    summary: description.trim().length === 0 ? null : description.trim(),
    position,
    context,
  };
  return kind === "project"
    ? client.execute({
        type: "create_project",
        payload: {
          ...common,
          slug: null,
          context_path: contextPath?.trim() || null,
        },
      })
    : client.execute({ type: "create_task", payload: common });
}

export async function appendManualStep(
  client: KarazhanClient,
  nodeId: string,
  expectedRevision: number,
  summary: string,
  stepStatus: WorkStatus,
) {
  const { operationId, context } = uiContext("add-step");
  return client.execute({
    type: "append_progress",
    payload: {
      node_id: nodeId,
      event_id: operationId,
      event_kind: "progress",
      summary: summary.trim(),
      step_status: stepStatus,
      expected_revision: expectedRevision,
      context,
    },
  });
}

export async function loadProjectNodeDetails(
  client: ProjectTreeReader,
  nodeId: string,
): Promise<ProjectNodeDetails> {
  const [progressResult, contextResult, resourcesResult] = await Promise.all([
    client.query({ type: "recent_progress", node_id: nodeId, limit: 3 }),
    client.query({ type: "project_context_path", node_id: nodeId }),
    client.query({ type: "list_resource_bindings", node_id: nodeId }),
  ]);
  if (progressResult.type !== "progress_events") {
    throw new Error(`expected progress_events query result, received ${progressResult.type}`);
  }
  if (contextResult.type !== "context_path") {
    throw new Error(`expected context_path query result, received ${contextResult.type}`);
  }
  if (resourcesResult.type !== "resource_bindings") {
    throw new Error(`expected resource_bindings query result, received ${resourcesResult.type}`);
  }
  return {
    recentProgress: progressResult.payload,
    contextPath: contextResult.payload,
    resourceBindings: resourcesResult.payload,
  };
}

export async function loadProjectTimeline(
  client: ProjectTreeReader,
  nodeId: string,
): Promise<ProgressEvent[]> {
  const result = await client.query({ type: "progress_timeline", node_id: nodeId });
  if (result.type !== "progress_events") {
    throw new Error(`expected progress_events query result, received ${result.type}`);
  }
  return result.payload;
}

export function primaryAvailableWorkspace<
  T extends Pick<ResourceBinding, "kind" | "is_primary" | "availability">,
>(bindings: readonly T[]): T | null {
  return (
    bindings.find(
      (binding) =>
        binding.kind === "workspace" &&
        binding.is_primary &&
        binding.availability === "available",
    ) ?? null
  );
}

export function openProjectInZed(client: ZedOpener, nodeId: string): Promise<void> {
  return client.openInZed(nodeId);
}
