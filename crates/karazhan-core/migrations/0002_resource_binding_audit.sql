ALTER TABLE resource_bindings ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z';
ALTER TABLE resource_bindings ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00Z';
ALTER TABLE resource_bindings ADD COLUMN created_actor TEXT NOT NULL DEFAULT 'system';
ALTER TABLE resource_bindings ADD COLUMN updated_actor TEXT NOT NULL DEFAULT 'system';
ALTER TABLE resource_bindings ADD COLUMN write_source TEXT NOT NULL DEFAULT 'import'
  CHECK(write_source IN ('ui', 'api', 'mcp', 'import', 'system'));
ALTER TABLE resource_bindings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
