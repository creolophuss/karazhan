ALTER TABLE tasks ADD COLUMN is_quick_item INTEGER NOT NULL DEFAULT 0
CHECK(is_quick_item IN (0, 1));

CREATE INDEX tasks_quick_item ON tasks(is_quick_item, node_id);

PRAGMA user_version = 5;
