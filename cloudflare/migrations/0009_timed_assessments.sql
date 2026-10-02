-- 定时答题草稿与截止提交队列。服务端时间是唯一权限依据。
CREATE TABLE IF NOT EXISTS timed_drafts (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('problem', 'exam')),
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'queued', 'submitted', 'failed')),
  updated_at INTEGER NOT NULL,
  queued_at INTEGER,
  submitted_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (resource_type, group_name, resource_id, resource_version, username, window_start)
);

CREATE INDEX IF NOT EXISTS idx_timed_drafts_due
  ON timed_drafts(status, window_end, updated_at);

