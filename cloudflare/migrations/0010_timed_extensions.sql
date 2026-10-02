-- 管理员按学生授予的临时补时。每个学生、资源只保留当前一条授权，避免无用历史增长。
CREATE TABLE IF NOT EXISTS timed_extensions (
  resource_type TEXT NOT NULL CHECK (resource_type IN ('problem', 'exam')),
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  resource_id TEXT NOT NULL,
  username TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (resource_type, group_name, resource_id, username)
);

CREATE INDEX IF NOT EXISTS idx_timed_extensions_lookup
  ON timed_extensions(group_name, username, ends_at);
