CREATE TABLE IF NOT EXISTS resubmission_requests (
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  problem_id TEXT NOT NULL,
  username TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (group_name, problem_id, username)
);

CREATE INDEX IF NOT EXISTS idx_resubmission_requests_user
  ON resubmission_requests(username, group_name, requested_at DESC);
