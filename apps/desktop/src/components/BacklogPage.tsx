import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  backlogParentOptions,
  createBacklog,
  discardBacklog,
  loadBacklog,
  moveBacklog,
  promoteBacklog,
  reorderBacklog,
  updateBacklog,
  type BacklogEditInput,
} from "../features/backlog.ts";
import { loadProjectTaskTree } from "../features/projects.ts";
import {
  karazhanClient,
  type BacklogFilter,
  type BacklogItem,
  type BacklogKind,
  type BacklogPromotionTarget,
  type Priority,
  type ProjectTaskItem,
} from "../lib/karazhan-client.ts";
import { describeClientError } from "../features/today.ts";

const SYSTEM_ROOT_ID = "00000000-0000-0000-0000-000000000001";
const kinds: BacklogKind[] = ["idea", "problem", "request", "research"];
const priorities: Priority[] = ["urgent", "high", "medium", "low", "none"];

type PageState =
  | { status: "loading" }
  | { status: "ready"; items: BacklogItem[]; tree: ProjectTaskItem[] }
  | { status: "error"; message: string };
type Feedback = { status: "idle" | "saving" | "success" | "error"; message: string };
type PromotionDraft = {
  source: BacklogItem;
  targetType: "project" | "task";
  targetId: string;
  idempotencyKey: string;
};
type ContextMenuState = { item: BacklogItem; x: number; y: number };

function draftFrom(item: BacklogItem): BacklogEditInput {
  return {
    title: item.title,
    notes: item.notes ?? "",
    kind: item.backlog_kind,
    priority: item.priority,
    tags: item.tags,
  };
}

function keyFor(title: string, id: string) {
  const prefix = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "promoted";
  return `${prefix}-${id.slice(0, 8)}`;
}

export default function BacklogPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [filter, setFilter] = useState<BacklogFilter>({});
  const [drafts, setDrafts] = useState<Record<string, BacklogEditInput>>({});
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(new Set());
  const [discardId, setDiscardId] = useState<string | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<PromotionDraft | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragged, setDragged] = useState<BacklogItem | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({ status: "idle", message: "" });
  const requestSequence = useRef(0);

  const refresh = useCallback(async (nextFilter: BacklogFilter) => {
    const requestId = ++requestSequence.current;
    try {
      const [items, tree] = await Promise.all([loadBacklog(karazhanClient, nextFilter), loadProjectTaskTree()]);
      if (requestId !== requestSequence.current) return;
      setState({ status: "ready", items, tree });
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      setState({ status: "error", message: describeClientError(error) });
      throw error;
    }
  }, []);

  useEffect(() => {
    void refresh({}).catch(() => undefined);
    return () => { requestSequence.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (dragged === null) return;
    const clearDrag = () => {
      setDragged(null);
      setDropTargetId(null);
    };
    window.addEventListener("pointerup", clearDrag);
    window.addEventListener("pointercancel", clearDrag);
    return () => {
      window.removeEventListener("pointerup", clearDrag);
      window.removeEventListener("pointercancel", clearDrag);
    };
  }, [dragged]);

  const parentOptions = useMemo(() => {
    return state.status === "ready"
      ? backlogParentOptions(state.tree)
      : [[SYSTEM_ROOT_ID, "Top level"] as [string, string]];
  }, [state]);

  function changeFilter(name: keyof BacklogFilter, value: string) {
    const next = { ...filter };
    if (value) Object.assign(next, { [name]: value });
    else delete next[name];
    setFilter(next);
    void refresh(next).catch(() => undefined);
  }

  async function save(item: BacklogItem) {
    const draft = drafts[item.id];
    if (!draft?.title.trim()) return;
    setFeedback({ status: "saving", message: `Saving ${item.title}…` });
    try {
      await updateBacklog(karazhanClient, item.id, item.revision, draft);
      setEditingIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
      await refresh(filter);
      setFeedback({ status: "success", message: "Backlog item saved." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  async function confirmDiscard(item: BacklogItem) {
    setFeedback({ status: "saving", message: `Discarding ${item.title}…` });
    try {
      await discardBacklog(karazhanClient, item.id, item.revision);
      setDiscardId(null);
      await refresh(filter);
      setFeedback({ status: "success", message: "Backlog item discarded; its history is retained." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  async function submitMove(event: FormEvent<HTMLFormElement>, item: BacklogItem) {
    event.preventDefault();
    const parentId = String(new FormData(event.currentTarget).get("move-parent") ?? "");
    if (!parentId || parentId === item.parent_id) return;
    setFeedback({ status: "saving", message: `Moving ${item.title}…` });
    try {
      await moveBacklog(karazhanClient, item.id, parentId, item.revision);
      setMoveId(null);
      await refresh(filter);
      setFeedback({ status: "success", message: "Backlog item moved." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  async function dropOn(item: BacklogItem) {
    if (dragged === null) return;
    if (item.id === dragged.id) {
      setDragged(null);
      setDropTargetId(null);
      return;
    }
    setFeedback({ status: "saving", message: "Saving sibling order…" });
    try {
      if (item.parent_id === dragged.parent_id) {
        await reorderBacklog(karazhanClient, dragged.id, item.position, dragged.revision);
      } else {
        const items = state.status === "ready" ? state.items : [];
        const sourceIndex = items.findIndex((candidate) => candidate.id === dragged.id);
        const targetIndex = items.findIndex((candidate) => candidate.id === item.id);
        const targetPosition = item.position + (sourceIndex >= 0 && sourceIndex < targetIndex ? 1 : 0);
        await moveBacklog(karazhanClient, dragged.id, item.parent_id, dragged.revision, targetPosition);
      }
      await refresh(filter);
      setFeedback({ status: "success", message: "Backlog order saved." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
    finally { setDragged(null); setDropTargetId(null); }
  }

  async function submitPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (promotion === null || state.status !== "ready") return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("promotion-title") ?? "").trim();
    const parentId = String(form.get("promotion-parent") ?? SYSTEM_ROOT_ID);
    if (!title) return;
    const common = {
      id: promotion.targetId,
      parent_id: parentId,
      key: keyFor(title, promotion.targetId),
      title,
    };
    const target: BacklogPromotionTarget = promotion.targetType === "project"
      ? { type: "project", ...common, slug: null, context_path: null }
      : { type: "task", ...common };
    setFeedback({ status: "saving", message: `Promoting ${promotion.source.title}…` });
    try {
      await promoteBacklog(karazhanClient, promotion.source.id, promotion.source.revision, target, promotion.idempotencyKey);
      setPromotion(null);
      await refresh(filter);
      setFeedback({ status: "success", message: "Backlog item promoted." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("create-title") ?? "").trim();
    if (!title) return;
    setFeedback({ status: "saving", message: `Creating ${title}…` });
    try {
      await createBacklog(karazhanClient, {
        parentId: String(form.get("create-parent") ?? SYSTEM_ROOT_ID),
        title,
        description: String(form.get("create-description") ?? ""),
        kind: String(form.get("create-kind") ?? "idea") as BacklogKind,
        priority: String(form.get("create-priority") ?? "none") as Priority,
        tags: String(form.get("create-tags") ?? "").split(","),
      });
      setCreateOpen(false);
      await refresh(filter);
      setFeedback({ status: "success", message: "Backlog item created." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  const promotionParents = state.status === "ready" && promotion
    ? backlogParentOptions(
        state.tree.filter((item) => promotion.targetType === "task" || item.kind === "project"),
      )
    : [];

  return <>
    <header className="page-header projects-header"><div className="projects-heading"><div className="projects-add-wrap"><button className="projects-add" type="button" aria-label="Create Backlog" onClick={() => setCreateOpen(true)}><span aria-hidden="true">+</span></button></div><h1>Backlog</h1></div></header>
    <form className="backlog-filters" aria-label="Backlog filters" onSubmit={(event) => event.preventDefault()}>
      <label>Parent<select name="parent" value={filter.parent_id ?? ""} onChange={(event) => changeFilter("parent_id", event.target.value)}><option value="">All parents</option>{parentOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Kind<select name="kind" value={filter.kind ?? ""} onChange={(event) => changeFilter("kind", event.target.value)}><option value="">All kinds</option>{kinds.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Priority<select name="priority" value={filter.priority ?? ""} onChange={(event) => changeFilter("priority", event.target.value)}><option value="">All priorities</option>{priorities.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Tag<input name="tag" value={filter.tag ?? ""} placeholder="Exact tag" onChange={(event) => changeFilter("tag", event.target.value.trim())} /></label>
    </form>
    {feedback.status !== "idle" && <p className={`membership-feedback ${feedback.status}`} role={feedback.status === "error" ? "alert" : "status"}>{feedback.message}</p>}
    <section className="backlog-panel" aria-label="Backlog items" aria-live="polite">
      {state.status === "loading" && <p className="state-message" role="status">Loading Backlog…</p>}
      {state.status === "error" && <div className="state-message error" role="alert"><strong>Backlog could not be loaded.</strong><span>{state.message}</span></div>}
      {state.status === "ready" && state.items.length === 0 && <div className="state-message empty"><strong>No matching Backlog items.</strong></div>}
      {state.status === "ready" && <ol className="backlog-list">{state.items.map((item) => {
        const editing = editingIds.has(item.id);
        const draft = drafts[item.id] ?? draftFrom(item);
        const actionable = item.backlog_status !== "promoted" && item.backlog_status !== "discarded";
        return <li className={`backlog-row${dragged?.id === item.id ? " dragging" : ""}${dropTargetId === item.id ? " drop-target" : ""}`} key={item.id} data-node-id={item.id} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ item, x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 180) }); }} onPointerEnter={() => { if (dragged && item.id !== dragged.id) setDropTargetId(item.id); }} onPointerUp={() => { if (dragged) void dropOn(item); }} onPointerCancel={() => { setDragged(null); setDropTargetId(null); }}>
          <div className="backlog-row-main">
            <button className="drag-handle" type="button" aria-label={`Drag ${item.title}`} disabled={!actionable} onPointerDown={(event) => { event.preventDefault(); setDragged(item); setDropTargetId(null); }}>⠿</button>
            <span className="backlog-copy"><strong>{item.title}</strong>{item.notes && <small className="backlog-description">{item.notes}</small>}</span>
            <span className="backlog-meta">{item.backlog_kind}</span><span className="backlog-meta">{item.priority}</span>
            <span className="backlog-tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</span>
          </div>
          {editing && <form className="backlog-editor" onSubmit={(event) => { event.preventDefault(); void save(item); }}>
            <label className="backlog-edit-title">Title<input name="title" required value={draft.title} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, title: event.target.value } }))} /></label>
            <label>Kind<select name="edit-kind" value={draft.kind} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, kind: event.target.value as BacklogKind } }))}>{kinds.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Priority<select name="edit-priority" value={draft.priority} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, priority: event.target.value as Priority } }))}>{priorities.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label className="backlog-edit-tags">Tags<input name="tags" value={draft.tags.join(", ")} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, tags: event.target.value.split(",") } }))} /></label>
            <label className="backlog-edit-description">Description<textarea name="notes" value={draft.notes} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, notes: event.target.value } }))} /></label>
            <div className="inline-actions"><button type="submit">Save</button><button type="button" onClick={() => { setEditingIds((current) => { const next = new Set(current); next.delete(item.id); return next; }); setDrafts((current) => ({ ...current, [item.id]: draftFrom(item) })); }}>Cancel</button></div>
          </form>}
          {discardId === item.id && <div className="inline-confirm" role="alert"><span>Discard this item? It will remain available through the discarded status filter.</span><button type="button" onClick={() => void confirmDiscard(item)}>Confirm discard</button><button type="button" onClick={() => setDiscardId(null)}>Cancel</button></div>}
          {moveId === item.id && <form className="inline-confirm" aria-label={`Move ${item.title}`} onSubmit={(event) => void submitMove(event, item)}><label>New Parent <select name="move-parent" defaultValue=""> <option value="" disabled>Select Parent</option>{parentOptions.filter(([id]) => id !== item.parent_id).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><button type="submit">Move</button><button type="button" onClick={() => setMoveId(null)}>Cancel</button></form>}
        </li>;
      })}</ol>}
    </section>
    {contextMenu && <><button className="menu-dismiss" type="button" aria-label="Close menu" onClick={() => setContextMenu(null)} /><div className="action-menu context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}><button type="button" role="menuitem" onClick={() => { const item = contextMenu.item; setDrafts((current) => ({ ...current, [item.id]: draftFrom(item) })); setEditingIds((current) => new Set(current).add(item.id)); setContextMenu(null); }}>Edit</button><button type="button" role="menuitem" onClick={() => { setMoveId(contextMenu.item.id); setContextMenu(null); }}>Move</button><button type="button" role="menuitem" onClick={() => { setPromotion({ source: contextMenu.item, targetType: "task", targetId: crypto.randomUUID(), idempotencyKey: `promote:${crypto.randomUUID()}` }); setContextMenu(null); }}>Promote</button><button className="archive-menu-item" type="button" role="menuitem" onClick={() => { setDiscardId(contextMenu.item.id); setContextMenu(null); }}>Discard</button></div></>}
    {createOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card" aria-label="New Backlog" onSubmit={(event) => void submitCreate(event)}><h2>New Backlog</h2><label>Title<input name="create-title" autoFocus required /></label><label>Description<textarea name="create-description" rows={3} /></label><label>Parent<select name="create-parent" defaultValue={SYSTEM_ROOT_ID}>{parentOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>Kind<select name="create-kind" defaultValue="idea">{kinds.map((value) => <option key={value}>{value}</option>)}</select></label><label>Priority<select name="create-priority" defaultValue="none">{priorities.map((value) => <option key={value}>{value}</option>)}</select></label><label>Tags<input name="create-tags" placeholder="Comma separated" /></label><div className="modal-actions"><button type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="primary-action" type="submit">Create</button></div></form></div>}
    {promotion && <div className="modal-backdrop" role="presentation"><form className="modal-card" aria-label={`Promote ${promotion.source.title}`} onSubmit={(event) => void submitPromotion(event)}><h2>Promote Backlog</h2><label>Target type<select name="promotion-type" value={promotion.targetType} onChange={(event) => setPromotion({ ...promotion, targetType: event.target.value as "project" | "task" })}><option value="task">Task</option><option value="project">Project</option></select></label><label>Title<input name="promotion-title" defaultValue={promotion.source.title} required /></label><label>Parent<select name="promotion-parent" defaultValue={promotion.targetType === "task" ? promotion.source.parent_id : SYSTEM_ROOT_ID}>{promotionParents.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><p className="promotion-preview">Creates a new {promotion.targetType} and retains the source Backlog.</p><div className="modal-actions"><button type="button" onClick={() => setPromotion(null)}>Cancel</button><button type="submit">Promote</button></div></form></div>}
  </>;
}
