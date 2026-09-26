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
