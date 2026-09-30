CREATE TABLE IF NOT EXISTS rejudge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_kind TEXT NOT NULL CHECK (submission_kind IN ('problem', 'exam')),
  submission_id INTEGER NOT NULL,
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  problem_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(submission_kind, submission_id, problem_id)
);

CREATE INDEX IF NOT EXISTS idx_rejudge_queue_status
  ON rejudge_queue(status, requested_at, id);
