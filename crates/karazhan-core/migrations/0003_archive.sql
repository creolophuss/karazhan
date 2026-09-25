ALTER TABLE work_nodes ADD COLUMN archived_at TEXT;

CREATE INDEX work_nodes_archive_parent_position
ON work_nodes(archived_at, parent_id, position);

CREATE TRIGGER work_nodes_archived_parent_insert_guard
BEFORE INSERT ON work_nodes
WHEN NEW.kind <> 'root' AND EXISTS (
  SELECT 1 FROM work_nodes p WHERE p.id = NEW.parent_id AND p.archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived_parent');
END;

CREATE TRIGGER work_nodes_archived_parent_update_guard
BEFORE UPDATE OF parent_id ON work_nodes
WHEN EXISTS (
  SELECT 1 FROM work_nodes p WHERE p.id = NEW.parent_id AND p.archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived_parent');
END;

CREATE TRIGGER today_archived_node_guard
BEFORE INSERT ON today_items
WHEN EXISTS (
  SELECT 1 FROM work_nodes n WHERE n.id = NEW.node_id AND n.archived_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'archived_node');
END;
