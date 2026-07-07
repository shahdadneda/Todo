PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initials TEXT NOT NULL UNIQUE CHECK (length(initials) = 2),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS planner_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL CHECK (section_key IN ('weekend-goals', 'ess-planner')),
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  sort_key INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_planner_entries_section_sort
ON planner_entries (section_key, sort_key DESC, id DESC);

CREATE TABLE IF NOT EXISTS planner_state (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL CHECK (section_key IN ('weekend-goals', 'ess-planner')),
  active_entry_id INTEGER REFERENCES planner_entries(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, section_key)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL CHECK (section_key IN ('general', 'weekend-goals', 'ess-planner')),
  planner_entry_id INTEGER,
  text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (planner_entry_id) REFERENCES planner_entries(id) ON DELETE CASCADE,
  CHECK (
    (section_key = 'general' AND planner_entry_id IS NULL)
    OR
    (section_key IN ('weekend-goals', 'ess-planner') AND planner_entry_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tasks_section_position
ON tasks (section_key, position, id);

CREATE INDEX IF NOT EXISTS idx_tasks_entry_position
ON tasks (planner_entry_id, position, id);
