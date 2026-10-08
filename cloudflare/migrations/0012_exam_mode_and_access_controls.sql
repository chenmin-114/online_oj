-- 全局考试模式与套卷准入撤销。
CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_access_policies (
  exam_id TEXT PRIMARY KEY,
  managed_default_allowed INTEGER NOT NULL DEFAULT 1
    CHECK (managed_default_allowed IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_access_revocations (
  exam_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (exam_id, username)
);

CREATE INDEX IF NOT EXISTS idx_exam_access_revocations_username
  ON exam_access_revocations(username, exam_id);
