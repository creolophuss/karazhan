CREATE TABLE work_nodes (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  kind TEXT NOT NULL CHECK(kind IN ('root', 'project', 'task', 'backlog')),
  parent_id TEXT REFERENCES work_nodes(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  key TEXT NOT NULL CHECK(length(trim(key)) > 0 AND instr(key, '/') = 0),
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  summary TEXT,
  goal TEXT,
  acceptance_markdown TEXT,
  work_status TEXT CHECK(work_status IN (
    'planned', 'ready', 'in_progress', 'pending', 'review', 'done', 'cancelled'
  )),
  priority TEXT CHECK(priority IN ('urgent', 'high', 'medium', 'low', 'none')),
  blocker TEXT,
  position INTEGER NOT NULL CHECK(position >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_actor TEXT NOT NULL,
  updated_actor TEXT NOT NULL,
  write_source TEXT NOT NULL CHECK(write_source IN ('ui', 'api', 'mcp', 'import', 'system')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  CHECK(
    (kind IN ('project', 'task') AND work_status IS NOT NULL AND priority IS NOT NULL)
    OR (kind = 'backlog' AND work_status IS NULL AND priority IS NOT NULL)
    OR (kind = 'root' AND work_status IS NULL AND priority IS NULL)
  ),
  CHECK(kind IN ('project', 'task') OR (goal IS NULL AND acceptance_markdown IS NULL AND blocker IS NULL)),
  CHECK(kind <> 'root' OR (parent_id IS NULL AND key = 'root')),
  CHECK(kind = 'root' OR parent_id IS NOT NULL),
  UNIQUE(parent_id, key),
  UNIQUE(parent_id, position)
) STRICT;

CREATE UNIQUE INDEX one_system_root ON work_nodes(kind) WHERE kind = 'root';
CREATE INDEX work_nodes_parent_position ON work_nodes(parent_id, position);
CREATE INDEX work_nodes_kind_status ON work_nodes(kind, work_status);

CREATE TRIGGER work_nodes_root_insert_guard
BEFORE INSERT ON work_nodes
WHEN NEW.kind = 'root' AND EXISTS(SELECT 1 FROM work_nodes WHERE kind = 'root')
BEGIN
  SELECT RAISE(ABORT, 'one_system_root');
END;

CREATE TRIGGER work_nodes_kind_immutable
BEFORE UPDATE OF kind ON work_nodes
WHEN NEW.kind <> OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'node_kind_immutable');
END;

CREATE TRIGGER work_nodes_root_update_guard
BEFORE UPDATE ON work_nodes
WHEN OLD.kind = 'root'
BEGIN
  SELECT RAISE(ABORT, 'system_root_immutable');
END;

CREATE TRIGGER work_nodes_root_delete_guard
BEFORE DELETE ON work_nodes
WHEN OLD.kind = 'root'
BEGIN
  SELECT RAISE(ABORT, 'system_root_immutable');
END;

CREATE TRIGGER work_nodes_parent_kind_insert_guard
BEFORE INSERT ON work_nodes
WHEN NEW.kind <> 'root' AND NOT EXISTS (
  SELECT 1 FROM work_nodes p
  WHERE p.id = NEW.parent_id
    AND (
      (p.kind = 'root' AND NEW.kind IN ('project', 'task', 'backlog'))
      OR (p.kind = 'project' AND NEW.kind IN ('project', 'task', 'backlog'))
      OR (p.kind = 'task' AND NEW.kind IN ('task', 'backlog'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_parent_kind');
END;

CREATE TRIGGER work_nodes_parent_kind_update_guard
BEFORE UPDATE OF parent_id ON work_nodes
WHEN NEW.kind <> 'root' AND NOT EXISTS (
  SELECT 1 FROM work_nodes p
  WHERE p.id = NEW.parent_id
    AND (
      (p.kind = 'root' AND NEW.kind IN ('project', 'task', 'backlog'))
      OR (p.kind = 'project' AND NEW.kind IN ('project', 'task', 'backlog'))
      OR (p.kind = 'task' AND NEW.kind IN ('task', 'backlog'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_parent_kind');
END;

CREATE TRIGGER work_nodes_cycle_guard
BEFORE UPDATE OF parent_id ON work_nodes
WHEN NEW.parent_id <> OLD.parent_id
BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT n.parent_id
      FROM work_nodes n
      JOIN ancestors a ON n.id = a.id
      WHERE n.parent_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'work_tree_cycle') END;
END;

CREATE TABLE projects (
  node_id TEXT PRIMARY KEY REFERENCES work_nodes(id) ON DELETE CASCADE,
  slug TEXT UNIQUE CHECK(slug IS NULL OR length(trim(slug)) > 0),
  context_path TEXT CHECK(context_path IS NULL OR length(trim(context_path)) > 0)
) STRICT;

CREATE TABLE tasks (
  node_id TEXT PRIMARY KEY REFERENCES work_nodes(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE backlog_items (
  node_id TEXT PRIMARY KEY REFERENCES work_nodes(id) ON DELETE CASCADE,
  backlog_kind TEXT NOT NULL CHECK(backlog_kind IN ('idea', 'problem', 'request', 'research')),
  backlog_status TEXT NOT NULL CHECK(backlog_status IN (
    'captured', 'considering', 'ready', 'promoted', 'discarded'
  )),
  notes TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json) = 'array'),
  source TEXT,
  promoted_node_id TEXT REFERENCES work_nodes(id) ON DELETE RESTRICT,
  CHECK(promoted_node_id IS NULL OR promoted_node_id <> node_id),
  CHECK((backlog_status = 'promoted') = (promoted_node_id IS NOT NULL))
) STRICT;

CREATE TRIGGER projects_kind_guard
BEFORE INSERT ON projects
WHEN NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.node_id AND kind = 'project')
BEGIN
  SELECT RAISE(ABORT, 'project_extension_kind_mismatch');
END;

CREATE TRIGGER tasks_kind_guard
BEFORE INSERT ON tasks
WHEN NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.node_id AND kind = 'task')
BEGIN
  SELECT RAISE(ABORT, 'task_extension_kind_mismatch');
END;

CREATE TRIGGER backlog_items_kind_guard
BEFORE INSERT ON backlog_items
WHEN NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.node_id AND kind = 'backlog')
BEGIN
  SELECT RAISE(ABORT, 'backlog_extension_kind_mismatch');
END;

CREATE TRIGGER backlog_promoted_target_insert_guard
BEFORE INSERT ON backlog_items
WHEN NEW.promoted_node_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.promoted_node_id AND kind IN ('project', 'task'))
BEGIN
  SELECT RAISE(ABORT, 'invalid_promoted_target_kind');
END;

CREATE TRIGGER backlog_promoted_target_update_guard
BEFORE UPDATE OF promoted_node_id ON backlog_items
WHEN NEW.promoted_node_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.promoted_node_id AND kind IN ('project', 'task'))
BEGIN
  SELECT RAISE(ABORT, 'invalid_promoted_target_kind');
END;

CREATE TABLE resource_bindings (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  node_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (
    'workspace', 'manifest', 'agent_log', 'repository', 'external_session', 'url', 'file', 'directory'
  )),
  locator TEXT NOT NULL CHECK(length(trim(locator)) > 0),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0, 1)),
  availability TEXT NOT NULL CHECK(availability IN ('available', 'missing', 'unreadable', 'unknown')),
  source TEXT NOT NULL,
  UNIQUE(node_id, kind, locator)
) STRICT;

CREATE UNIQUE INDEX one_primary_resource_per_kind
ON resource_bindings(node_id, kind)
WHERE is_primary = 1;

CREATE INDEX resource_bindings_locator ON resource_bindings(kind, locator);

CREATE TRIGGER resource_binding_target_kind_guard
BEFORE INSERT ON resource_bindings
WHEN NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.node_id AND kind IN ('project', 'task'))
BEGIN
  SELECT RAISE(ABORT, 'resource_binding_target_kind_mismatch');
END;

CREATE TRIGGER resource_binding_identity_immutable
BEFORE UPDATE OF node_id, kind, locator ON resource_bindings
WHEN NEW.node_id <> OLD.node_id OR NEW.kind <> OLD.kind OR NEW.locator <> OLD.locator
BEGIN
  SELECT RAISE(ABORT, 'resource_binding_identity_immutable');
END;

CREATE TABLE today_items (
  node_id TEXT PRIMARY KEY REFERENCES work_nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL UNIQUE CHECK(position >= 0),
  added_at TEXT NOT NULL,
  added_actor TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
) STRICT;

CREATE TRIGGER today_node_kind_guard
BEFORE INSERT ON today_items
WHEN NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.node_id AND kind IN ('project', 'task'))
BEGIN
  SELECT RAISE(ABORT, 'today_target_kind_mismatch');
END;

CREATE TRIGGER today_node_kind_update_guard
BEFORE UPDATE OF node_id ON today_items
WHEN NOT EXISTS(SELECT 1 FROM work_nodes WHERE id = NEW.node_id AND kind IN ('project', 'task'))
BEGIN
  SELECT RAISE(ABORT, 'today_target_kind_mismatch');
END;

CREATE TABLE progress_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  subject_node_id TEXT NOT NULL REFERENCES work_nodes(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'progress', 'delivery', 'status_changed', 'priority_changed', 'parent_changed',
    'blocker_changed', 'today_added', 'today_removed', 'today_reordered', 'imported'
  )),
  summary TEXT NOT NULL,
  blocker TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json) AND json_type(evidence_json) = 'array'),
  actor_type TEXT NOT NULL CHECK(actor_type IN (
    'user', 'work_assistant', 'task_agent', 'system', 'unknown'
  )),
  actor_ref TEXT,
  channel TEXT NOT NULL CHECK(channel IN (
    'ui', 'api', 'mcp', 'legacy_log', 'legacy_coordination', 'import'
  )),
  source_binding_id TEXT REFERENCES resource_bindings(id) ON DELETE RESTRICT,
  source_item_key TEXT,
  source_digest TEXT,
  CHECK(
    (source_item_key IS NULL AND source_digest IS NULL)
    OR (source_binding_id IS NOT NULL AND source_item_key IS NOT NULL AND source_digest IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX progress_event_source_identity
ON progress_events(source_binding_id, source_item_key)
WHERE source_binding_id IS NOT NULL AND source_item_key IS NOT NULL;

CREATE INDEX progress_events_subject_occurred
ON progress_events(subject_node_id, occurred_at);

CREATE TABLE command_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK(length(trim(idempotency_key)) > 0),
  command_kind TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_revision INTEGER NOT NULL CHECK(result_revision >= 1),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  mode TEXT NOT NULL CHECK(mode IN ('dry_run', 'apply', 'log_sync')),
  source_root TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND json_type(scope_json) = 'object'),
  ruleset_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'partial_failure', 'failed')),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json) AND json_type(summary_json) = 'object'),
  report_digest TEXT
) STRICT;

CREATE TABLE import_records (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_item_key TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('create', 'update', 'no_op', 'skip', 'blocked')),
  result TEXT NOT NULL CHECK(result IN ('planned', 'applied', 'skipped', 'failed')),
  conflicts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conflicts_json) AND json_type(conflicts_json) = 'array'),
  extension_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(extension_json) AND json_type(extension_json) = 'object'),
  observed_at TEXT NOT NULL,
  UNIQUE(run_id, source_kind, source_locator, source_item_key)
) STRICT;

CREATE TABLE import_source_records (
  source_kind TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_item_key TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  last_import_run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE RESTRICT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_kind, source_locator, source_item_key)
) STRICT;

CREATE TRIGGER progress_event_subject_kind_guard
BEFORE INSERT ON progress_events
WHEN NOT EXISTS(
  SELECT 1 FROM work_nodes WHERE id = NEW.subject_node_id AND kind IN ('project', 'task')
)
BEGIN
  SELECT RAISE(ABORT, 'progress_event_subject_kind_mismatch');
END;

CREATE TRIGGER progress_event_subject_kind_update_guard
BEFORE UPDATE OF subject_node_id ON progress_events
WHEN NOT EXISTS(
  SELECT 1 FROM work_nodes WHERE id = NEW.subject_node_id AND kind IN ('project', 'task')
)
BEGIN
  SELECT RAISE(ABORT, 'progress_event_subject_kind_mismatch');
END;

CREATE TRIGGER progress_event_source_binding_guard
BEFORE INSERT ON progress_events
WHEN NEW.source_binding_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resource_bindings b
  WHERE b.id = NEW.source_binding_id AND b.node_id = NEW.subject_node_id
)
BEGIN
  SELECT RAISE(ABORT, 'progress_event_source_binding_mismatch');
END;

CREATE TRIGGER progress_event_source_binding_update_guard
BEFORE UPDATE OF subject_node_id, source_binding_id ON progress_events
WHEN NEW.source_binding_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM resource_bindings b
  WHERE b.id = NEW.source_binding_id AND b.node_id = NEW.subject_node_id
)
BEGIN
  SELECT RAISE(ABORT, 'progress_event_source_binding_mismatch');
END;

CREATE VIEW schema_invariant_violations AS
SELECT 'missing_project_extension' AS code, n.id AS node_id
FROM work_nodes n LEFT JOIN projects p ON p.node_id = n.id
WHERE n.kind = 'project' AND p.node_id IS NULL
UNION ALL
SELECT 'missing_task_extension', n.id
FROM work_nodes n LEFT JOIN tasks t ON t.node_id = n.id
WHERE n.kind = 'task' AND t.node_id IS NULL
UNION ALL
SELECT 'missing_backlog_extension', n.id
FROM work_nodes n LEFT JOIN backlog_items b ON b.node_id = n.id
WHERE n.kind = 'backlog' AND b.node_id IS NULL;

INSERT INTO work_nodes (
  id, kind, parent_id, key, title, work_status, priority, position,
  created_at, updated_at, created_actor, updated_actor, write_source, revision
) VALUES (
  '00000000-0000-0000-0000-000000000001', 'root', NULL, 'root', 'Work Root', NULL, NULL, 0,
  '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z', 'system', 'system', 'system', 1
);
