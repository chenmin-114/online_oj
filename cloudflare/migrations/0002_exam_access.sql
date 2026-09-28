ALTER TABLE student_accounts
  ADD COLUMN is_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_managed IN (0, 1));

-- 旧版批量注册一定会生成密码；迁移时保留这些既有学生的全部套卷权限。
UPDATE student_accounts SET is_managed = 1 WHERE password_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS exam_roster (
  exam_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (exam_id, username)
);

CREATE INDEX IF NOT EXISTS idx_exam_roster_username
  ON exam_roster(username, exam_id);
