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

-- 匿名访问统计：visitor_hash 是登录用户名的不可逆摘要，
-- 不保存 IP 或明文用户名。
CREATE TABLE IF NOT EXISTS analytics_site_daily (
  day TEXT NOT NULL,
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  visitor_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (day, group_name, visitor_hash)
);

CREATE INDEX IF NOT EXISTS idx_analytics_site_day
  ON analytics_site_daily(group_name, day);

CREATE TABLE IF NOT EXISTS analytics_problem_visitors (
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  problem_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (group_name, problem_id, visitor_hash)
);

CREATE INDEX IF NOT EXISTS idx_analytics_problem_group
  ON analytics_problem_visitors(group_name, problem_id);

-- 管理员短期会话：数据库只保存随机令牌的 SHA-256 摘要，
-- 浏览器中的原始令牌通过 HttpOnly Cookie 保存。
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions(expires_at);

-- 学生账号保持轻量：用户名唯一，密码只保存带盐 PBKDF2 摘要。
-- password_hash 为空表示该学生选择了无密码方式。
CREATE TABLE IF NOT EXISTS student_accounts (
  username TEXT PRIMARY KEY,
  password_salt TEXT,
  password_hash TEXT,
  password_iterations INTEGER,
  auth_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (password_salt IS NULL AND password_hash IS NULL AND password_iterations IS NULL)
    OR
    (password_salt IS NOT NULL AND password_hash IS NOT NULL AND password_iterations IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS student_sessions (
  session_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_student_sessions_username
  ON student_sessions(username);

CREATE INDEX IF NOT EXISTS idx_student_sessions_expires
  ON student_sessions(expires_at);
