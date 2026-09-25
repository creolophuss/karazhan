ALTER TABLE progress_events ADD COLUMN step_status TEXT
CHECK(step_status IN (
  'planned', 'ready', 'in_progress', 'pending', 'review', 'done', 'cancelled'
));

PRAGMA user_version = 4;
