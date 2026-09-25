import {
  karazhanClient,
  type BacklogFilter,
  type BacklogItem,
  type BacklogKind,
  type BacklogPromotionTarget,
  type KarazhanClient,
  type Priority,
} from "../lib/karazhan-client.ts";

type BacklogReader = Pick<KarazhanClient, "query">;

function uiContext(idempotencyKey: string = crypto.randomUUID()) {
  return {
    idempotency_key: idempotencyKey,
    actor_type: "user" as const,
    actor_ref: "desktop-user",
    channel: "ui" as const,
  };
}

export async function loadBacklog(
  client: BacklogReader = karazhanClient,
  filter: BacklogFilter = {},
): Promise<BacklogItem[]> {
  const result = await client.query({ type: "list_backlog", filter });
  if (result.type !== "backlog") {
    throw new Error(`expected backlog query result, received ${result.type}`);
  }
  return result.payload;
}

export interface BacklogEditInput {
  title: string;
  notes: string;
  kind: BacklogKind;
  priority: Priority;
  tags: string[];
}

export interface BacklogCreateInput {
  parentId: string;
  title: string;
  description: string;
  kind: BacklogKind;
  priority: Priority;
  tags: string[];
}

export async function createBacklog(
  client: KarazhanClient,
  input: BacklogCreateInput,
  createId: () => string = () => crypto.randomUUID(),
) {
  const id = createId();
  return client.execute({
    type: "create_backlog",
    payload: {
      id,
      parent_id: input.parentId,
      key: `backlog-${id}`,
      title: input.title.trim(),
      description: input.description.trim() || null,
      kind: input.kind,
      priority: input.priority,
      tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
      context: uiContext(`create-backlog:${id}`),
    },
  });
}

export async function updateBacklog(
  client: KarazhanClient,
  nodeId: string,
  expectedRevision: number,
  input: BacklogEditInput,
) {
  return client.execute({
    type: "update_backlog",
    payload: {
      node_id: nodeId,
      title: input.title.trim(),
      notes: input.notes.trim()
        ? { action: "set", value: input.notes.trim() }
        : { action: "clear" },
      kind: input.kind,
      priority: input.priority,
      tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
      expected_revision: expectedRevision,
      context: uiContext(),
    },
  });
}

export async function discardBacklog(
  client: KarazhanClient,
  nodeId: string,
  expectedRevision: number,
) {
  return client.execute({
    type: "discard_backlog",
    payload: {
      node_id: nodeId,
      expected_revision: expectedRevision,
      context: uiContext(),
    },
  });
}

export async function moveBacklog(
  client: KarazhanClient,
  nodeId: string,
  parentId: string,
  expectedRevision: number,
  targetPosition?: number,
) {
  return client.execute({
    type: "move_backlog",
    payload: {
      node_id: nodeId,
      parent_id: parentId,
      target_position: targetPosition ?? null,
      expected_revision: expectedRevision,
      context: uiContext(),
    },
  });
}

export async function reorderBacklog(
  client: KarazhanClient,
  nodeId: string,
  targetPosition: number,
  expectedRevision: number,
) {
  return client.execute({
    type: "reorder_node",
    payload: {
      node_id: nodeId,
      target_position: targetPosition,
      expected_revision: expectedRevision,
      context: uiContext(),
    },
  });
}

export async function promoteBacklog(
  client: KarazhanClient,
  backlogId: string,
  expectedRevision: number,
  target: BacklogPromotionTarget,
  idempotencyKey: string,
) {
  return client.execute({
    type: "promote_backlog",
    payload: {
      backlog_id: backlogId,
      target,
      expected_revision: expectedRevision,
      context: uiContext(idempotencyKey),
    },
  });
}
