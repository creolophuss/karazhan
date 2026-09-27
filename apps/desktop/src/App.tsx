import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent } from "react";

import ProjectsPage from "./components/ProjectsPage";
import ArchivePage from "./components/ArchivePage";
import BacklogPage from "./components/BacklogPage";
import TodayOpenInZed from "./components/TodayOpenInZed";
import TodayRecentSteps from "./components/TodayRecentSteps";
import WorkItemQuickControls from "./components/WorkItemQuickControls";
import AddStepModal, { type AddStepTarget } from "./components/AddStepModal";
import { appendManualStep } from "./features/projects";
import {
  allTodayNodeIds,
  createQuickItem,
  deleteQuickItem,
  describeClientError,
  directChildTaskRows,
  isTodayItemExpandable,
  loadToday,
  moveTodayItem,
  removeTodayMembership,
  reorderTodayMembership,
  setAllTodayRowsExpanded,
  toggleTodayRow,
  todayPath,
} from "./features/today";
import { karazhanClient, type TodayItem, type WorkStatus } from "./lib/karazhan-client";

type TodayState =
  | { status: "loading" }
  | { status: "ready"; items: TodayItem[] }
  | { status: "error"; message: string };

type MembershipFeedback = {
  status: "idle" | "saving" | "error";
  message: string;
};

type StepMenuState = AddStepTarget & { x: number; y: number };

const PAGE_REFRESH_INTERVAL_MS = 1_000;

export default function App() {
  const [activePage, setActivePage] = useState<"today" | "projects" | "backlog" | "archive">("today");
  const [today, setToday] = useState<TodayState>({ status: "loading" });
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dropTargetNodeId, setDropTargetNodeId] = useState<string | null>(null);
  const [revealedDeleteNodeId, setRevealedDeleteNodeId] = useState<string | null>(null);
  const swipeGesture = useRef<{
    nodeId: string;
    pointerId: number;
    startX: number;
  } | null>(null);
  const suppressSwipeClick = useRef(false);
  const [membershipFeedback, setMembershipFeedback] =
    useState<MembershipFeedback>({ status: "idle", message: "" });
  const [stepMenu, setStepMenu] = useState<StepMenuState | null>(null);
  const [stepTarget, setStepTarget] = useState<AddStepTarget | null>(null);
  const [quickItemOpen, setQuickItemOpen] = useState(false);
  const [stepsVersion, setStepsVersion] = useState(0);
  const todayLoaded = useRef(false);
  const todaySnapshot = useRef<string | null>(null);

  const acceptRefreshedToday = useCallback((items: TodayItem[]) => {
    const snapshot = JSON.stringify(items);
    if (snapshot === todaySnapshot.current) return;
    todaySnapshot.current = snapshot;
    const firstLoad = !todayLoaded.current;
    todayLoaded.current = true;
    setToday({ status: "ready", items });
    if (firstLoad) {
      setExpandedNodeIds(allTodayNodeIds(items.filter(isTodayItemExpandable)));
      return;
    }
    const currentIds = new Set(items.map((item) => item.node_id));
    setExpandedNodeIds(
      (current) => new Set([...current].filter((nodeId) => currentIds.has(nodeId))),
    );
  }, []);

  useEffect(() => {
    if (activePage !== "today") return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const items = await loadToday();
        if (active) acceptRefreshedToday(items);
      } catch (error) {
        if (active && !todayLoaded.current) {
          setToday({ status: "error", message: describeClientError(error) });
        }
      } finally {
        refreshing = false;
      }
    };
    const refreshOnFocus = () => { void refresh(); };
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, PAGE_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, [activePage, acceptRefreshedToday]);

  const expandableItems =
    today.status === "ready" ? today.items.filter(isTodayItemExpandable) : [];
  const allRowsExpanded =
    today.status === "ready" &&
    expandableItems.length > 0 &&
    expandableItems.every((item) => expandedNodeIds.has(item.node_id));
  const allRowsCollapsed = expandedNodeIds.size === 0;
  const membershipBusy = membershipFeedback.status === "saving";

  async function handleRemove(item: TodayItem) {
    setMembershipFeedback({ status: "saving", message: "Removing…" });
    try {
      await removeTodayMembership(karazhanClient, item.node_id, item.revision);
      acceptRefreshedToday(await loadToday());
      setRevealedDeleteNodeId(null);
      setMembershipFeedback({ status: "idle", message: "" });
    } catch (error) {
      setMembershipFeedback({
        status: "error",
        message: describeClientError(error),
      });
    }
  }

  function refreshAfterWorkItemSave() {
    void loadToday().then(acceptRefreshedToday, (error: unknown) => {
      setMembershipFeedback({ status: "error", message: describeClientError(error) });
    });
  }

  function openStepMenu(event: MouseEvent, target: AddStepTarget) {
    event.preventDefault();
    event.stopPropagation();
    setStepMenu({
      ...target,
      x: Math.min(event.clientX, window.innerWidth - 150),
      y: Math.min(event.clientY, window.innerHeight - 90),
    });
  }

  async function handleAddStep(summary: string, status: WorkStatus) {
    if (stepTarget === null) return;
    const nodeId = stepTarget.id;
    setMembershipFeedback({ status: "saving", message: `Adding step to ${stepTarget.title}…` });
    try {
      await appendManualStep(karazhanClient, nodeId, stepTarget.revision, summary, status);
      acceptRefreshedToday(await loadToday());
      setExpandedNodeIds((current) => new Set(current).add(nodeId));
      setStepsVersion((current) => current + 1);
      setStepTarget(null);
      setMembershipFeedback({ status: "idle", message: "" });
    } catch (error) {
      setMembershipFeedback({ status: "error", message: describeClientError(error) });
    }
  }

  async function handleCreateQuickItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const description = String(new FormData(event.currentTarget).get("description") ?? "").trim();
    if (!description) return;
    setMembershipFeedback({ status: "saving", message: "Adding quick item…" });
    try {
      await createQuickItem(karazhanClient, description);
      acceptRefreshedToday(await loadToday());
      setQuickItemOpen(false);
      setMembershipFeedback({ status: "idle", message: "" });
    } catch (error) {
      setMembershipFeedback({ status: "error", message: describeClientError(error) });
    }
  }

  async function handleDeleteQuickItem(item: TodayItem) {
    setMembershipFeedback({ status: "saving", message: "Deleting quick item…" });
    try {
      await deleteQuickItem(karazhanClient, item.node_id, item.work_revision);
      acceptRefreshedToday(await loadToday());
      setMembershipFeedback({ status: "idle", message: "" });
    } catch (error) {
      setMembershipFeedback({ status: "error", message: describeClientError(error) });
    }
  }

  async function handleDrop(targetPosition: number) {
    if (today.status !== "ready" || draggedNodeId === null) return;
    const sourceIndex = today.items.findIndex((item) => item.node_id === draggedNodeId);
    const source = today.items[sourceIndex];
    if (source === undefined || sourceIndex === targetPosition) {
      setDraggedNodeId(null);
      setDropTargetNodeId(null);
      return;
    }

    const previous = today.items;
    setRevealedDeleteNodeId(null);
    const optimistic = moveTodayItem(previous, source.node_id, targetPosition);
    setToday({ status: "ready", items: optimistic });
    setMembershipFeedback({ status: "saving", message: "Saving Today order…" });
    setDraggedNodeId(null);
    setDropTargetNodeId(null);
    try {
      await reorderTodayMembership(
        karazhanClient,
        source.node_id,
        targetPosition,
        source.revision,
      );
      acceptRefreshedToday(await loadToday());
      setMembershipFeedback({ status: "idle", message: "" });
    } catch (error) {
      setToday({ status: "ready", items: previous });
      setMembershipFeedback({
        status: "error",
        message: describeClientError(error),
      });
    }
  }

  function beginSwipe(
    event: PointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) {
    if (membershipBusy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    swipeGesture.current = {
      nodeId,
      pointerId: event.pointerId,
      startX: event.clientX,
    };
    suppressSwipeClick.current = false;
    if (revealedDeleteNodeId !== nodeId) setRevealedDeleteNodeId(null);
  }

  function continueSwipe(
    event: PointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) {
    const gesture = swipeGesture.current;
    if (
      gesture === null ||
      gesture.nodeId !== nodeId ||
      gesture.pointerId !== event.pointerId
    ) return;
    const distance = event.clientX - gesture.startX;
    if (distance <= -32) {
      suppressSwipeClick.current = true;
      setRevealedDeleteNodeId(nodeId);
    } else if (distance >= 24 && revealedDeleteNodeId === nodeId) {
      suppressSwipeClick.current = true;
      setRevealedDeleteNodeId(null);
    }
  }

  function endSwipe(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    swipeGesture.current = null;
  }

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">K</span>
          <span>Karazhan</span>
        </div>
        <nav aria-label="Primary navigation">
          <button
            className={`nav-item${activePage === "today" ? " active" : ""}`}
            type="button"
            aria-current={activePage === "today" ? "page" : undefined}
            onClick={() => setActivePage("today")}
          >
            Today
          </button>
          <button
            className={`nav-item${activePage === "projects" ? " active" : ""}`}
            type="button"
            aria-current={activePage === "projects" ? "page" : undefined}
            onClick={() => setActivePage("projects")}
          >
            Projects &amp; Tasks
          </button>
          <button
            className={`nav-item${activePage === "backlog" ? " active" : ""}`}
            type="button"
            aria-current={activePage === "backlog" ? "page" : undefined}
            onClick={() => setActivePage("backlog")}
          >
            Backlog
          </button>
          <button
            className={`nav-item${activePage === "archive" ? " active" : ""}`}
            type="button"
            aria-current={activePage === "archive" ? "page" : undefined}
            onClick={() => setActivePage("archive")}
          >
            Archive
          </button>
        </nav>
      </aside>

      <main className="workspace" id={activePage}>
        {activePage === "projects" ? (
          <ProjectsPage onTodayChanged={acceptRefreshedToday} />
        ) : activePage === "backlog" ? (
          <BacklogPage />
        ) : activePage === "archive" ? (
          <ArchivePage />
        ) : (
          <>
        <header className="page-header projects-header"><div className="projects-heading"><div className="projects-add-wrap"><button className="projects-add" type="button" aria-label="Create quick item" onClick={() => setQuickItemOpen(true)}><span aria-hidden="true">+</span></button></div><h1>Today</h1></div></header>

        {today.status === "ready" && expandableItems.length > 0 && (
          <div className="today-toolbar" aria-label="Today display controls">
            <button
              type="button"
              disabled={allRowsExpanded}
              onClick={() =>
                setExpandedNodeIds(setAllTodayRowsExpanded(expandableItems, true))
              }
            >
              Expand all
            </button>
            <button
              type="button"
              disabled={allRowsCollapsed}
              onClick={() =>
                setExpandedNodeIds(setAllTodayRowsExpanded(expandableItems, false))
              }
            >
              Collapse all
            </button>
          </div>
        )}

        {membershipFeedback.status !== "idle" && (
          <p
            className={`membership-feedback ${membershipFeedback.status}`}
            role={membershipFeedback.status === "error" ? "alert" : "status"}
          >
            {membershipFeedback.message}
          </p>
        )}

        <section className="today-panel" aria-label="Today items" aria-live="polite">
          {today.status === "loading" && (
            <p className="state-message" role="status">Loading Today…</p>
          )}

          {today.status === "error" && (
            <div className="state-message error" role="alert">
              <strong>Today could not be loaded.</strong>
              <span>{today.message}</span>
            </div>
          )}

          {today.status === "ready" && today.items.length === 0 && (
            <div className="state-message empty">
              <strong>Nothing in Today yet.</strong>
              <span>Items added to Today will appear here in your chosen order.</span>
            </div>
          )}

          {today.status === "ready" && today.items.length > 0 && (
            <ol className="today-list">
              {today.items.map((item, targetPosition) => {
                const expanded = expandedNodeIds.has(item.node_id);
                const detailsId = `today-details-${item.node_id}`;
                const childTasks = directChildTaskRows(item);
                const expandable = isTodayItemExpandable(item);
                const leafTask = item.kind === "task" && childTasks.length === 0;
                const deleteRevealed = revealedDeleteNodeId === item.node_id;
                if (item.is_quick_item) return (
                  <li className={`today-row quick-item-row${draggedNodeId === item.node_id ? " dragging" : ""}${dropTargetNodeId === item.node_id ? " drop-target" : ""}`} data-node-id={item.node_id} data-position={item.position} key={item.node_id} onPointerEnter={() => { if (draggedNodeId !== null && draggedNodeId !== item.node_id) setDropTargetNodeId(item.node_id); }} onPointerUp={() => { if (draggedNodeId !== null) void handleDrop(targetPosition); }} onPointerCancel={() => { setDraggedNodeId(null); setDropTargetNodeId(null); }}>
                    <div className="quick-item-content">
                      <button className="drag-handle" type="button" disabled={membershipBusy} aria-label={`Drag ${item.title}`} onPointerDown={(event) => { event.preventDefault(); setDraggedNodeId(item.node_id); setDropTargetNodeId(null); }}><span aria-hidden="true">⠿</span></button>
                      <WorkItemQuickControls nodeId={item.node_id} revision={item.work_revision} status={item.status} priority={item.priority} blocker={item.blocker} label={item.title} checkbox minimal onSaved={refreshAfterWorkItemSave} />
                      <span className="quick-item-description">{item.title}</span>
                      <button className="quick-item-delete" type="button" disabled={membershipBusy} onClick={() => void handleDeleteQuickItem(item)}>Delete</button>
                    </div>
                  </li>
                );
                return (
                  <li
                    className={`today-row${draggedNodeId === item.node_id ? " dragging" : ""}${dropTargetNodeId === item.node_id ? " drop-target" : ""}`}
                    data-node-id={item.node_id}
                    data-position={item.position}
                    key={item.node_id}
                    onContextMenu={(event) => openStepMenu(event, { id: item.node_id, title: item.title, revision: item.work_revision })}
                    onPointerEnter={() => {
                      if (draggedNodeId !== null && draggedNodeId !== item.node_id) {
                        setDropTargetNodeId(item.node_id);
                      }
                    }}
                    onPointerUp={() => {
                      if (draggedNodeId !== null) void handleDrop(targetPosition);
                    }}
                    onPointerCancel={() => {
                      setDraggedNodeId(null);
                      setDropTargetNodeId(null);
                    }}
                  >
                    <button
                      className="delete-action"
                      type="button"
                      disabled={membershipBusy}
                      tabIndex={deleteRevealed ? 0 : -1}
                      aria-hidden={!deleteRevealed}
                      onClick={() => void handleRemove(item)}
                    >
                      Delete
                    </button>
                    <div className={`today-row-header${deleteRevealed ? " delete-revealed" : ""}`}>
                      <button
                        className="drag-handle"
                        type="button"
                        disabled={membershipBusy}
                        aria-label={`Drag ${item.title}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          setDraggedNodeId(item.node_id);
                          setDropTargetNodeId(null);
                        }}
                      >
                        <span aria-hidden="true">⠿</span>
                      </button>
                      {leafTask ? (
                        <WorkItemQuickControls
                          nodeId={item.node_id}
                          revision={item.work_revision}
                          status={item.status}
                          priority={item.priority}
                          blocker={item.blocker}
                          label={item.title}
                          checkbox
                          onSaved={refreshAfterWorkItemSave}
                        />
                      ) : (
                        <span className={`kind-marker ${item.kind}`} aria-hidden="true" />
                      )}
                      <div className="today-row-copy">
                        <span className="today-path">{todayPath(item)}</span>
                        {item.kind === "task" && item.summary && (
                          <span className="today-description">{item.summary}</span>
                        )}
                      </div>
                      {item.has_available_workspace && (
                        <TodayOpenInZed nodeId={item.node_id} />
                      )}
                      {!leafTask && (
                        <WorkItemQuickControls
                          nodeId={item.node_id}
                          revision={item.work_revision}
                          status={item.status}
                          priority={item.priority}
                          blocker={item.blocker}
                          label={item.title}
                          onSaved={refreshAfterWorkItemSave}
                        />
                      )}
                      {expandable && (
                        <button
                          className="today-chevron"
                          type="button"
                          aria-controls={detailsId}
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${item.title}`}
                          onClick={() =>
                            setExpandedNodeIds((current) =>
                              toggleTodayRow(current, item.node_id),
                            )
                          }
                        >
                          <span aria-hidden="true">›</span>
                        </button>
                      )}
                      <button
                        className="swipe-edge"
                        type="button"
                        disabled={membershipBusy}
                        aria-label={`${deleteRevealed ? "Hide" : "Reveal"} remove action for ${item.title}`}
                        onPointerDown={(event) => beginSwipe(event, item.node_id)}
                        onPointerMove={(event) => continueSwipe(event, item.node_id)}
                        onPointerUp={endSwipe}
                        onPointerCancel={endSwipe}
                        onClick={() => {
                          if (suppressSwipeClick.current) {
                            suppressSwipeClick.current = false;
                            return;
                          }
                          setRevealedDeleteNodeId((current) =>
                            current === item.node_id ? null : item.node_id,
                          );
                        }}
                      />
                    </div>
                    {expandable && (
                      <div className="today-row-details" id={detailsId} hidden={!expanded}>
                        <TodayRecentSteps
                          nodeId={item.node_id}
                          blocker={item.blocker}
                          enabled={expanded}
                          refreshToken={stepsVersion}
                        />
                        {childTasks.length > 0 && (
                          <section className="today-todo" aria-labelledby={`today-todo-${item.node_id}`}>
                            <h3 id={`today-todo-${item.node_id}`}>To-do</h3>
                          <ul
                            className="child-task-list"
                            aria-label={`Direct child tasks of ${item.title}`}
                          >
                            {childTasks.map((child) => (
                              <li className="child-task" data-task-id={child.id} key={child.id} onContextMenu={(event) => openStepMenu(event, { id: child.id, title: child.title, revision: child.revision })}>
                                <span className="child-drag-handle" aria-hidden="true">⠿</span>
                                <WorkItemQuickControls
                                  nodeId={child.id}
                                  revision={child.revision}
                                  status={child.status}
                                  priority={child.priority}
                                  blocker={child.blocker}
                                  label={child.title}
                                  checkbox
                                  onSaved={refreshAfterWorkItemSave}
                                />
                                <span className="child-task-copy">
                                  <span className="child-task-title">
                                    {todayPath(item)} › {child.title}
                                  </span>
                                  {child.summary && (
                                    <span className="today-description">{child.summary}</span>
                                  )}
                                </span>
                                {child.has_steps && <button className="child-step-chevron" type="button" aria-expanded={expandedNodeIds.has(child.id)} aria-label={`${expandedNodeIds.has(child.id) ? "Collapse" : "Expand"} ${child.title} steps`} onClick={() => setExpandedNodeIds((current) => toggleTodayRow(current, child.id))}><span aria-hidden="true">›</span></button>}
                                {child.has_steps && <div className="child-task-steps" hidden={!expandedNodeIds.has(child.id)}><TodayRecentSteps nodeId={child.id} blocker={child.blocker} enabled={expandedNodeIds.has(child.id)} refreshToken={stepsVersion} /></div>}
                              </li>
                            ))}
                          </ul>
                          </section>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {stepMenu && <><button className="menu-dismiss" type="button" aria-label="Close menu" onClick={() => setStepMenu(null)} /><div className="action-menu context-menu" role="menu" style={{ left: stepMenu.x, top: stepMenu.y }}><button type="button" role="menuitem" onClick={() => { setStepTarget({ id: stepMenu.id, title: stepMenu.title, revision: stepMenu.revision }); setStepMenu(null); }}>Add step</button></div></>}
        {stepTarget && <AddStepModal target={stepTarget} onCancel={() => setStepTarget(null)} onSubmit={(summary, status) => void handleAddStep(summary, status)} />}
        {quickItemOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card quick-item-modal" aria-label="New Quick item" onSubmit={(event) => void handleCreateQuickItem(event)}><h2>New Quick item</h2><label>Description<input name="description" autoFocus required /></label><div className="modal-actions"><button type="button" onClick={() => setQuickItemOpen(false)}>Cancel</button><button className="primary-action" type="submit">Add</button></div></form></div>}
          </>
        )}
      </main>
    </div>
  );
}
