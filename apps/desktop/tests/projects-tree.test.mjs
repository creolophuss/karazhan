import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  allExpandableNodeIds,
  appendManualStep,
  buildProjectTaskTree,
  createProjectTask,
  loadProjectNodeDetails,
  loadProjectTimeline,
  loadProjectTaskTree,
  openProjectInZed,
  primaryAvailableWorkspace,
  todayMembershipByNodeId,
  toggleTreeNode,
  updateProjectTreeItem,
} from "../src/features/projects.ts";

const item = (id, parent_id, kind, position, title = id) => ({
  id,
  parent_id,
  kind,
  key: id,
  title,
  status: "planned",
  priority: "none",
  blocker: null,
  position,
  revision: 1,
  has_steps: false,
});

test("the Projects page loads the unified shared tree projection", async () => {
  const calls = [];
  const payload = [item("project", "root", "project", 0)];
  const client = {
    async query(query) {
      calls.push(query);
      return { type: "project_task_tree", payload };
    },
  };

  assert.equal(await loadProjectTaskTree(client), payload);
  assert.deepEqual(calls, [{ type: "list_project_task_tree" }]);
});

test("mixed Projects and Tasks form one ordered hierarchy", () => {
  const tree = buildProjectTaskTree([
    item("child-task", "task", "task", 0, "Child Task"),
    item("standalone", "root", "task", 1, "Independent Task"),
    item("task", "project", "task", 1, "Project Task"),
    item("nested", "project", "project", 0, "Nested Project"),
    item("project", "root", "project", 0, "Project"),
  ]);

  assert.deepEqual(
    tree.map((node) => [
      node.item.id,
      node.children.map((child) => [
        child.item.id,
        child.children.map((grandchild) => grandchild.item.id),
      ]),
    ]),
    [
      [
        "project",
        [
          ["nested", []],
          ["task", ["child-task"]],
        ],
      ],
      ["standalone", []],
    ],
  );
  assert.deepEqual(
    tree[0].children[1].children[0].ancestors.map((ancestor) => ancestor.title),
    ["Project", "Project Task"],
  );
});

test("Projects uses indentation instead of repeating ancestor paths", async () => {
  const source = await readFile(
    new URL("../src/components/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /\{node\.item\.title\}/);
  assert.doesNotMatch(source, /projectTreePath\(node\)/);
  assert.match(source, /node\.item\.summary/);
  assert.match(source, /onContextMenu/);
  assert.match(source, />Archive</);
  assert.match(source, /New Project/);
  assert.match(source, /New Task/);
  assert.match(source, /className="projects-add"/);
  assert.match(source, /branchExpanded \? "⌄" : "›"/);
  assert.doesNotMatch(source, /tree-key|Details|Hide details/);
  assert.doesNotMatch(source, /InlineWorkItemFields|ProjectNodeInsights|project-node-details/);
});

test("Project and Task creation carries Description and Project Path", async () => {
  const commands = [];
  const client = {
    async execute(command) {
      commands.push(command);
      return { type: "mutation", payload: { revision: 1, replayed: false } };
    },
  };

  await createProjectTask(client, "project", "root", "Project", "Description", "/work/project", 1);
  await createProjectTask(client, "task", "project", "Task", "Task details", null, 2);

  assert.equal(commands[0].payload.summary, "Description");
  assert.equal(commands[0].payload.context_path, "/work/project");
  assert.equal(commands[1].payload.summary, "Task details");
  assert.equal("context_path" in commands[1].payload, false);
});

test("Projects exposes compact status and priority editors", async () => {
  const source = await readFile(
    new URL("../src/components/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /<WorkItemQuickControls/);
  assert.match(source, /onSaved=/);
  assert.doesNotMatch(source, /<span className="tree-status">/);
  assert.doesNotMatch(source, /<span className="tree-priority">/);
  assert.match(
    styles,
    /\.project-tree-row :is\(\.tree-kind-label, \.quick-status, \.quick-priority, \.tree-action\)\s*\{[\s\S]*?height:\s*1\.75rem/,
  );
  assert.match(styles, /\.quick-status,\s*\n\.quick-priority\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.project-tree-row \.tree-kind-label\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(styles, /\.tree-action\s*\{[\s\S]*?border:\s*1px solid/);
});

test("Projects can append a status-bearing manual step from the context menu", async () => {
  const commands = [];
  const client = {
    async execute(command) {
      commands.push(command);
      return { type: "mutation", payload: { revision: 3, replayed: false } };
    },
  };

  await appendManualStep(client, "task-1", 3, "Waiting for approval", "pending");

  assert.equal(commands[0].type, "append_progress");
  assert.equal(commands[0].payload.node_id, "task-1");
  assert.equal(commands[0].payload.summary, "Waiting for approval");
  assert.equal(commands[0].payload.step_status, "pending");
  const source = await readFile(
    new URL("../src/components/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );
  const modal = await readFile(
    new URL("../src/components/AddStepModal.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, />Add step</);
  assert.match(modal, /name="step-status"/);
});

test("tree hierarchy starts visible and each branch toggles independently", () => {
  const tree = buildProjectTaskTree([
    item("project", "root", "project", 0),
    item("task", "project", "task", 0),
    item("child", "task", "task", 0),
  ]);
  const expanded = allExpandableNodeIds(tree);

  assert.deepEqual([...expanded], ["project", "task"]);
  const collapsedProject = toggleTreeNode(expanded, "project");
  assert.deepEqual([...collapsedProject], ["task"]);
  assert.deepEqual([...expanded], ["project", "task"]);
});

test("Projects expands Step-bearing leaves and renders Steps before descendants", async () => {
  const leaf = { ...item("leaf", "root", "task", 0), has_steps: true };
  const tree = buildProjectTaskTree([leaf]);
  assert.deepEqual([...allExpandableNodeIds(tree)], ["leaf"]);

  const source = await readFile(
    new URL("../src/components/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<TodayRecentSteps[\s\S]*?<TreeBranch/);
  assert.match(source, /refreshToken=\{stepsVersion\}/);
  assert.match(source, /<div className="today-row-details project-tree-details" onContextMenu=/);
  assert.match(source, /<TodayRecentSteps[\s\S]*?<section className="today-todo project-tree-children">/);
  assert.doesNotMatch(source, /<h3>Children<\/h3>/);
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.today-row-details\s*\{[^}]*font-size:\s*0\.78rem/);
  assert.doesNotMatch(styles, /\.project-tree-steps\s*\{/);
  assert.match(styles, /#projects \.project-tree-details,[\s\S]*?#projects \.project-tree-children \.project-tree-row\s*\{[^}]*background:\s*#fbf9f4/);
  assert.match(
    styles,
    /#projects \.project-tree-details\s*\{[^}]*margin-right:\s*1rem/,
  );
  assert.match(
    styles,
    /#projects \.project-tree-children\s*\{[^}]*margin-right:\s*-1\.15rem;[^}]*margin-left:\s*-1\.15rem;[^}]*\}/,
  );
  assert.doesNotMatch(
    styles,
    /#projects \.project-tree-children\s*\{[^}]*padding-(?:right|left):/,
  );
  assert.match(
    styles,
    /#projects \.project-tree-children \.project-tree-row\s*\{[^}]*padding-right:\s*2rem;[^}]*padding-left:\s*2rem/,
  );
  assert.match(
    styles,
    /#projects \.project-tree-children \.project-tree-details\s*\{[^}]*margin-right:\s*2rem;[^}]*margin-left:\s*5\.35rem/,
  );
});

test("Today membership lookup powers Move to Today and In Today", () => {
  const memberships = todayMembershipByNodeId([
    { node_id: "task", position: 0, revision: 3 },
  ]);

  assert.equal(memberships.get("task").revision, 3);
  assert.equal(memberships.has("project"), false);
});

test("a saved field edit updates one tree row without mutating the tree", () => {
  const tree = buildProjectTaskTree([
    item("project", "root", "project", 0),
    item("task", "project", "task", 0),
  ]);
  const updated = updateProjectTreeItem(tree, "task", {
    status: "done",
    priority: "high",
    blocker: null,
    revision: 2,
  });

  assert.equal(updated[0].children[0].item.status, "done");
  assert.equal(updated[0].children[0].item.revision, 2);
  assert.equal(tree[0].children[0].item.status, "planned");
  assert.equal(updated[0].item, tree[0].item);
});

test("an unexpected tree response is rejected", async () => {
  await assert.rejects(
    loadProjectTaskTree({
      query: async () => ({ type: "projects", payload: [] }),
    }),
    /expected project_task_tree query result/,
  );
});

test("node details read recent progress, resolved Context path, and bindings only", async () => {
  const calls = [];
  const recentProgress = [{ id: "event-1", summary: "Implemented the editor" }];
  const resourceBindings = [
    { id: "binding-1", kind: "workspace", locator: "/work/project", availability: "available" },
  ];
  const client = {
    async query(query) {
      calls.push(query);
      if (query.type === "recent_progress") {
        return { type: "progress_events", payload: recentProgress };
      }
      if (query.type === "project_context_path") {
        return { type: "context_path", payload: "/work/project/context" };
      }
      return { type: "resource_bindings", payload: resourceBindings };
    },
  };

  assert.deepEqual(await loadProjectNodeDetails(client, "task-1"), {
    recentProgress,
    contextPath: "/work/project/context",
    resourceBindings,
  });
  assert.deepEqual(calls, [
    { type: "recent_progress", node_id: "task-1", limit: 3 },
    { type: "project_context_path", node_id: "task-1" },
    { type: "list_resource_bindings", node_id: "task-1" },
  ]);
});

test("the full timeline is requested only when selected", async () => {
  const calls = [];
  const payload = [{ id: "event-1", summary: "Created the task" }];
  const client = {
    async query(query) {
      calls.push(query);
      return { type: "progress_events", payload };
    },
  };

  assert.equal(await loadProjectTimeline(client, "task-1"), payload);
  assert.deepEqual(calls, [{ type: "progress_timeline", node_id: "task-1" }]);
});

test("Open in Zed is offered only for an available primary Workspace", () => {
  const bindings = [
    { id: "repository", kind: "repository", is_primary: true, availability: "available" },
    { id: "secondary", kind: "workspace", is_primary: false, availability: "available" },
    { id: "missing", kind: "workspace", is_primary: true, availability: "missing" },
  ];

  assert.equal(primaryAvailableWorkspace(bindings), null);
  const available = {
    id: "workspace",
    kind: "workspace",
    is_primary: true,
    availability: "available",
  };
  assert.equal(primaryAvailableWorkspace([...bindings, available]), available);
});

test("Open in Zed sends only the selected node ID and preserves structured failures", async () => {
  const calls = [];
  const error = { code: "untrusted_workspace", message: "outside every trusted root" };
  const client = {
    async openInZed(nodeId) {
      calls.push(nodeId);
      throw error;
    },
  };

  await assert.rejects(openProjectInZed(client, "task-1"), (received) => received === error);
  assert.deepEqual(calls, ["task-1"]);
});
