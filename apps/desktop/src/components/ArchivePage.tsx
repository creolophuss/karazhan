import { useCallback, useEffect, useState } from "react";

import {
  allExpandableNodeIds,
  buildProjectTaskTree,
  loadArchivedProjectTaskTree,
  permanentlyDeleteArchivedProjectTask,
  projectTreePath,
  reopenArchivedProjectTask,
  toggleTreeNode,
  type ProjectTaskTreeNode,
} from "../features/projects.ts";
import { describeClientError } from "../features/today.ts";
import { karazhanClient } from "../lib/karazhan-client.ts";

type ArchiveState =
  | { status: "loading" }
  | { status: "ready"; roots: ProjectTaskTreeNode[] }
  | { status: "error"; message: string };

function descendantCount(node: ProjectTaskTreeNode): number {
  return node.children.reduce((count, child) => count + 1 + descendantCount(child), 0);
}

function ArchivedBranch({
  nodes,
  expanded,
  onToggle,
  onReopen,
  onDelete,
  nested = false,
}: {
  nodes: ProjectTaskTreeNode[];
  expanded: ReadonlySet<string>;
  onToggle: (nodeId: string) => void;
  onReopen: (node: ProjectTaskTreeNode) => void;
  onDelete: (node: ProjectTaskTreeNode) => void;
  nested?: boolean;
}) {
  return (
    <ul className={nested ? "project-tree nested" : "project-tree"} role={nested ? "group" : "tree"}>
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isExpanded = expanded.has(node.item.id);
        return (
          <li role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined} key={node.item.id}>
            <div className="project-tree-row archive-row">
              {hasChildren ? (
                <button className="tree-disclosure" type="button" aria-expanded={isExpanded} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.item.title}`} onClick={() => onToggle(node.item.id)}>
                  <span aria-hidden="true">{isExpanded ? "⌄" : "›"}</span>
                </button>
              ) : <span className="tree-disclosure-spacer" />}
              <span className={`tree-kind ${node.item.kind}`} aria-hidden="true" />
              <span className="tree-row-copy"><span className="tree-path">{projectTreePath(node)}</span></span>
              <span className="tree-kind-label">{node.item.kind}</span>
              <button className="tree-action" type="button" onClick={() => onReopen(node)}>Reopen</button>
              <button className="tree-action permanent-delete-action" type="button" onClick={() => onDelete(node)}>Permanently delete</button>
            </div>
            {hasChildren && isExpanded && <ArchivedBranch nodes={node.children} nested expanded={expanded} onToggle={onToggle} onReopen={onReopen} onDelete={onDelete} />}
          </li>
        );
      })}
    </ul>
  );
}

export default function ArchivePage() {
  const [state, setState] = useState<ArchiveState>({ status: "loading" });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ProjectTaskTreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const roots = buildProjectTaskTree(await loadArchivedProjectTaskTree());
    setState({ status: "ready", roots });
    setExpanded(allExpandableNodeIds(roots));
  }, []);

  useEffect(() => {
    let active = true;
    loadArchivedProjectTaskTree().then(
      (items) => {
        if (!active) return;
        const roots = buildProjectTaskTree(items);
        setState({ status: "ready", roots });
        setExpanded(allExpandableNodeIds(roots));
      },
      (loadError: unknown) => { if (active) setState({ status: "error", message: describeClientError(loadError) }); },
    );
    return () => { active = false; };
  }, []);

  async function handlePermanentDelete() {
    if (deleteTarget === null) return;
    try {
      await permanentlyDeleteArchivedProjectTask(karazhanClient, deleteTarget.item.id, deleteTarget.item.revision);
      setDeleteTarget(null);
      setError(null);
      await refresh();
    } catch (deleteError) { setError(describeClientError(deleteError)); }
  }

  async function handleReopen(node: ProjectTaskTreeNode) {
    try {
      await reopenArchivedProjectTask(karazhanClient, node.item.id, node.item.revision);
      setError(null);
      await refresh();
    } catch (reopenError) { setError(describeClientError(reopenError)); }
  }

  return (
    <>
      <header className="page-header"><h1>Archive</h1></header>
      {error && <p className="membership-feedback error" role="alert">{error}</p>}
      <section className="projects-panel" aria-label="Archived Projects and Tasks">
        {state.status === "loading" && <p className="state-message" role="status">Loading Archive…</p>}
        {state.status === "error" && <div className="state-message error" role="alert"><strong>Archive could not be loaded.</strong><span>{state.message}</span></div>}
        {state.status === "ready" && state.roots.length === 0 && <div className="state-message empty"><strong>Archive is empty.</strong></div>}
        {state.status === "ready" && state.roots.length > 0 && <ArchivedBranch nodes={state.roots} expanded={expanded} onToggle={(nodeId) => setExpanded((current) => toggleTreeNode(current, nodeId))} onReopen={(node) => void handleReopen(node)} onDelete={setDeleteTarget} />}
      </section>

      {deleteTarget && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card danger-card" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">Permanently delete {deleteTarget.item.title}?</h2>
            <p>This cannot be undone. {descendantCount(deleteTarget) > 0 ? `${descendantCount(deleteTarget)} descendant${descendantCount(deleteTarget) === 1 ? "" : "s"} will also be permanently deleted.` : "Its saved history will also be deleted."}</p>
            <div className="modal-actions"><button type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="danger-action" type="button" onClick={() => void handlePermanentDelete()}>Permanently delete</button></div>
          </div>
        </div>
      )}
    </>
  );
}
