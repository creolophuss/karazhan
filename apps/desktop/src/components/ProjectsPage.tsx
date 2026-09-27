import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";

import {
  allExpandableNodeIds,
  appendManualStep,
  archiveProjectTask,
  buildProjectTaskTree,
  createProjectTask,
  loadProjectTaskTree,
  todayMembershipByNodeId,
  toggleTreeNode,
  updateProjectTreeItem,
  type ProjectTaskTreeNode,
} from "../features/projects.ts";
import { addTodayMembership, describeClientError, loadToday } from "../features/today.ts";
import { karazhanClient, type TodayItem, type WorkStatus } from "../lib/karazhan-client.ts";
import WorkItemQuickControls from "./WorkItemQuickControls.tsx";
import AddStepModal, { type AddStepTarget } from "./AddStepModal.tsx";
import TodayRecentSteps from "./TodayRecentSteps.tsx";

const SYSTEM_ROOT_ID = "00000000-0000-0000-0000-000000000001";
const PAGE_REFRESH_INTERVAL_MS = 1_000;

type ProjectsState =
  | { status: "loading" }
  | { status: "ready"; roots: ProjectTaskTreeNode[]; todayItems: TodayItem[] }
  | { status: "error"; message: string };
type PageFeedback = { status: "idle" | "saving" | "success" | "error"; message: string };
type CreateTarget = { kind: "project" | "task"; parentId: string; parentTitle: string };
interface ProjectsPageProps { onTodayChanged: (items: TodayItem[]) => void }
interface ContextMenuState { node: ProjectTaskTreeNode; x: number; y: number }

interface TreeBranchProps {
  nodes: ProjectTaskTreeNode[];
  nested?: boolean;
  expandedNodeIds: ReadonlySet<string>;
  todayNodeIds: ReadonlySet<string>;
  busyNodeId: string | null;
  stepsVersion: number;
  onToggleBranch: (nodeId: string) => void;
  onMoveToToday: (nodeId: string, title: string) => void;
  onContextMenu: (event: MouseEvent, node: ProjectTaskTreeNode) => void;
  onFieldsSaved: (
    nodeId: string,
    fields: { status: ProjectTaskTreeNode["item"]["status"]; priority: ProjectTaskTreeNode["item"]["priority"]; revision: number },
  ) => void;
}

function descendantCount(node: ProjectTaskTreeNode): number {
  return node.children.reduce((count, child) => count + 1 + descendantCount(child), 0);
}

function TreeBranch({
  nodes, nested = false, expandedNodeIds, todayNodeIds, busyNodeId, stepsVersion,
  onToggleBranch, onMoveToToday, onContextMenu, onFieldsSaved,
}: TreeBranchProps) {
  return (
    <ul className={nested ? "project-tree nested" : "project-tree"} role={nested ? "group" : "tree"}>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const expandable = hasChildren || node.item.has_steps;
        const branchExpanded = expandedNodeIds.has(node.item.id);
        const childrenId = `project-children-${node.item.id}`;
        const inToday = todayNodeIds.has(node.item.id);
        return (
          <li role="treeitem" aria-expanded={expandable ? branchExpanded : undefined} key={node.item.id}>
            <div className="project-tree-row" data-node-id={node.item.id} onContextMenu={(event) => { event.stopPropagation(); onContextMenu(event, node); }}>
              {expandable ? (
                <button className="tree-disclosure" type="button" aria-controls={childrenId} aria-expanded={branchExpanded} aria-label={`${branchExpanded ? "Collapse" : "Expand"} ${node.item.title}`} onClick={() => onToggleBranch(node.item.id)}>
                  <span aria-hidden="true">{branchExpanded ? "⌄" : "›"}</span>
                </button>
              ) : <span className="tree-disclosure-spacer" />}
              <span className={`tree-kind ${node.item.kind}`} aria-hidden="true" />
              <span className="tree-row-copy">
                <span className="tree-path">{node.item.title}</span>
                {node.item.summary && <span className="today-description">{node.item.summary}</span>}
              </span>
              <span className="tree-kind-label">{node.item.kind}</span>
              <WorkItemQuickControls
                nodeId={node.item.id}
                revision={node.item.revision}
                status={node.item.status}
                priority={node.item.priority}
                blocker={node.item.blocker}
                label={node.item.title}
                onSaved={(fields) => onFieldsSaved(node.item.id, fields)}
              />
              <button className="tree-action today-action" type="button" disabled={inToday || busyNodeId !== null} onClick={() => onMoveToToday(node.item.id, node.item.title)}>
                {inToday ? "In Today" : busyNodeId === node.item.id ? "Moving…" : "Move to Today"}
              </button>
              {node.item.blocker && <span className="tree-blocker">Blocked: {node.item.blocker}</span>}
            </div>
            {expandable && (
              <div className="project-tree-expanded" id={childrenId} hidden={!branchExpanded}>
                <div className="today-row-details project-tree-details" onContextMenu={(event) => { event.stopPropagation(); onContextMenu(event, node); }}>
                  <TodayRecentSteps nodeId={node.item.id} blocker={node.item.blocker} enabled={branchExpanded} refreshToken={stepsVersion} />
                  {hasChildren && <section className="today-todo project-tree-children"><TreeBranch nodes={node.children} nested expandedNodeIds={expandedNodeIds} todayNodeIds={todayNodeIds} busyNodeId={busyNodeId} stepsVersion={stepsVersion} onToggleBranch={onToggleBranch} onMoveToToday={onMoveToToday} onContextMenu={onContextMenu} onFieldsSaved={onFieldsSaved} /></section>}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function ProjectsPage({ onTodayChanged }: ProjectsPageProps) {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(new Set());
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<PageFeedback>({ status: "idle", message: "" });
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ProjectTaskTreeNode | null>(null);
  const [stepTarget, setStepTarget] = useState<AddStepTarget | null>(null);
  const [stepsVersion, setStepsVersion] = useState(0);
  const projectsLoaded = useRef(false);
  const projectsSnapshot = useRef<string | null>(null);

  const acceptLoadedState = useCallback((
    items: Awaited<ReturnType<typeof loadProjectTaskTree>>,
    todayItems: TodayItem[],
    resetExpansion: boolean,
  ) => {
    const snapshot = JSON.stringify([items, todayItems]);
    if (snapshot === projectsSnapshot.current) return;
    projectsSnapshot.current = snapshot;
    projectsLoaded.current = true;
    const roots = buildProjectTaskTree(items);
    const expandableIds = allExpandableNodeIds(roots);
    setState({ status: "ready", roots, todayItems });
    setExpandedNodeIds((current) => resetExpansion
      ? expandableIds
      : new Set([...current].filter((nodeId) => expandableIds.has(nodeId))));
    onTodayChanged(todayItems);
  }, [onTodayChanged]);

  const refresh = useCallback(async () => {
    const [items, todayItems] = await Promise.all([loadProjectTaskTree(), loadToday()]);
    acceptLoadedState(items, todayItems, true);
  }, [acceptLoadedState]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refreshVisiblePage = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [items, todayItems] = await Promise.all([loadProjectTaskTree(), loadToday()]);
        if (active) acceptLoadedState(items, todayItems, !projectsLoaded.current);
      } catch (error) {
        if (active && !projectsLoaded.current) {
          setState({ status: "error", message: describeClientError(error) });
        }
      } finally {
        refreshing = false;
      }
    };
    const refreshOnFocus = () => { void refreshVisiblePage(); };
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") void refreshVisiblePage();
    };
    void refreshVisiblePage();
    const interval = window.setInterval(
      () => { void refreshVisiblePage(); },
      PAGE_REFRESH_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [acceptLoadedState]);

  const todayMemberships = state.status === "ready" ? todayMembershipByNodeId(state.todayItems) : new Map();
  const todayNodeIds = new Set(todayMemberships.keys());

  async function handleMoveToToday(nodeId: string, title: string) {
    if (state.status !== "ready" || todayMemberships.has(nodeId)) return;
    const nextPosition = state.todayItems.reduce((maximum, item) => Math.max(maximum, item.position), -1) + 1;
    setBusyNodeId(nodeId);
    setFeedback({ status: "saving", message: `Moving ${title} to Today…` });
    try {
      await addTodayMembership(karazhanClient, nodeId, nextPosition);
      const todayItems = await loadToday();
      setState((current) => current.status === "ready" ? { ...current, todayItems } : current);
      onTodayChanged(todayItems);
      setFeedback({ status: "success", message: `${title} is now in Today.` });
    } catch (error) {
      setFeedback({ status: "error", message: describeClientError(error) });
    } finally { setBusyNodeId(null); }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createTarget === null) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const contextPath = createTarget.kind === "project"
      ? String(form.get("path") ?? "").trim() || null
      : null;
    if (!title) return;
    setFeedback({ status: "saving", message: `Creating ${createTarget.kind}…` });
    try {
      await createProjectTask(
        karazhanClient,
        createTarget.kind,
        createTarget.parentId,
        title,
        description,
        contextPath,
        Date.now(),
      );
      setCreateTarget(null);
      await refresh();
      setFeedback({ status: "success", message: `${title} created.` });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  async function handleArchive() {
    if (archiveTarget === null) return;
    setFeedback({ status: "saving", message: `Archiving ${archiveTarget.item.title}…` });
    try {
      await archiveProjectTask(karazhanClient, archiveTarget.item.id, archiveTarget.item.revision);
      setArchiveTarget(null);
      await refresh();
      setFeedback({ status: "success", message: "Moved to Archive." });
    } catch (error) { setFeedback({ status: "error", message: describeClientError(error) }); }
  }

  async function handleAddStep(summary: string, stepStatus: WorkStatus) {
    if (stepTarget === null) return;
    const nodeId = stepTarget.id;
    setFeedback({ status: "saving", message: `Adding step to ${stepTarget.title}…` });
    try {
      await appendManualStep(
        karazhanClient,
        stepTarget.id,
        stepTarget.revision,
        summary,
        stepStatus,
      );
      setStepTarget(null);
      setStepsVersion((current) => current + 1);
      setFeedback({ status: "success", message: "Step added." });
      await refresh();
      setExpandedNodeIds((current) => new Set(current).add(nodeId));
    } catch (error) {
      setFeedback({ status: "error", message: describeClientError(error) });
    }
  }

  function beginCreate(kind: "project" | "task", parentId = SYSTEM_ROOT_ID, parentTitle = "top level") {
    setCreateMenuOpen(false);
    setContextMenu(null);
    setCreateTarget({ kind, parentId, parentTitle });
  }

  function handleFieldsSaved(
    nodeId: string,
    fields: { status: ProjectTaskTreeNode["item"]["status"]; priority: ProjectTaskTreeNode["item"]["priority"]; revision: number },
  ) {
    setState((current) => current.status === "ready"
      ? { ...current, roots: updateProjectTreeItem(current.roots, nodeId, fields) }
      : current);
    void loadToday().then((todayItems) => {
      setState((current) => current.status === "ready" ? { ...current, todayItems } : current);
      onTodayChanged(todayItems);
    });
  }

  return (
    <>
      <header className="page-header projects-header">
        <div className="projects-heading">
          <div className="projects-add-wrap">
            <button className="projects-add" type="button" aria-label="Create top-level Project or Task" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((open) => !open)}><span aria-hidden="true">+</span></button>
            {createMenuOpen && <div className="action-menu top-create-menu" role="menu"><button type="button" role="menuitem" onClick={() => beginCreate("project")}>New Project</button><button type="button" role="menuitem" onClick={() => beginCreate("task")}>New Task</button></div>}
          </div>
          <h1>Projects &amp; Tasks</h1>
        </div>
        {state.status === "ready" && state.roots.length > 0 && <div className="tree-toolbar" aria-label="Project tree display controls"><button type="button" onClick={() => setExpandedNodeIds(allExpandableNodeIds(state.roots))}>Expand all</button><button type="button" onClick={() => setExpandedNodeIds(new Set())}>Collapse all</button></div>}
      </header>

      {feedback.status !== "idle" && <p className={`membership-feedback ${feedback.status}`} role={feedback.status === "error" ? "alert" : "status"}>{feedback.message}</p>}
      <section className="projects-panel" aria-label="Projects and Tasks" aria-live="polite">
        {state.status === "loading" && <p className="state-message" role="status">Loading Projects &amp; Tasks…</p>}
        {state.status === "error" && <div className="state-message error" role="alert"><strong>Projects &amp; Tasks could not be loaded.</strong><span>{state.message}</span></div>}
        {state.status === "ready" && state.roots.length === 0 && <div className="state-message empty"><strong>No Projects or Tasks yet.</strong></div>}
        {state.status === "ready" && state.roots.length > 0 && <TreeBranch nodes={state.roots} expandedNodeIds={expandedNodeIds} todayNodeIds={todayNodeIds} busyNodeId={busyNodeId} stepsVersion={stepsVersion} onToggleBranch={(nodeId) => setExpandedNodeIds((current) => toggleTreeNode(current, nodeId))} onMoveToToday={(nodeId, title) => void handleMoveToToday(nodeId, title)} onContextMenu={(event, node) => { event.preventDefault(); setCreateMenuOpen(false); setContextMenu({ node, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 160) }); }} onFieldsSaved={handleFieldsSaved} />}
      </section>

      {contextMenu && <><button className="menu-dismiss" type="button" aria-label="Close menu" onClick={() => setContextMenu(null)} /><div className="action-menu context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>{contextMenu.node.item.kind === "project" && <button type="button" role="menuitem" onClick={() => beginCreate("project", contextMenu.node.item.id, contextMenu.node.item.title)}>New Project</button>}<button type="button" role="menuitem" onClick={() => beginCreate("task", contextMenu.node.item.id, contextMenu.node.item.title)}>New Task</button><button type="button" role="menuitem" onClick={() => { setStepTarget({ id: contextMenu.node.item.id, title: contextMenu.node.item.title, revision: contextMenu.node.item.revision }); setContextMenu(null); }}>Add step</button><button className="archive-menu-item" type="button" role="menuitem" onClick={() => { setArchiveTarget(contextMenu.node); setContextMenu(null); }}>Archive</button></div></>}

      {createTarget && <div className="modal-backdrop" role="presentation"><form className="modal-card" onSubmit={(event) => void handleCreate(event)}><h2>New {createTarget.kind === "project" ? "Project" : "Task"}</h2><p>Under {createTarget.parentTitle}</p><label>Name<input name="title" autoFocus required /></label><label>Description<textarea name="description" rows={3} /></label>{createTarget.kind === "project" && <label>Path <span className="optional-label">(optional)</span><input name="path" placeholder="/path/to/project" /></label>}<div className="modal-actions"><button type="button" onClick={() => setCreateTarget(null)}>Cancel</button><button className="primary-action" type="submit">Create</button></div></form></div>}
      {stepTarget && <AddStepModal target={stepTarget} onCancel={() => setStepTarget(null)} onSubmit={(summary, status) => void handleAddStep(summary, status)} />}
      {archiveTarget && <div className="modal-backdrop" role="presentation"><div className="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="archive-title"><h2 id="archive-title">Archive {archiveTarget.item.title}?</h2><p>It will move out of Projects &amp; Tasks{descendantCount(archiveTarget) > 0 ? ` with ${descendantCount(archiveTarget)} descendant${descendantCount(archiveTarget) === 1 ? "" : "s"}` : ""}.</p><div className="modal-actions"><button type="button" onClick={() => setArchiveTarget(null)}>Cancel</button><button className="primary-action" type="button" onClick={() => void handleArchive()}>Archive</button></div></div></div>}
    </>
  );
}
