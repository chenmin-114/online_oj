CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  passed_tests INTEGER NOT NULL,
  total_tests INTEGER NOT NULL,
  total_time REAL NOT NULL,
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(username, problem_id, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_submissions_username_time
  ON submissions(username, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_submissions_problem_time
  ON submissions(problem_id, timestamp DESC);
