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

CREATE TABLE IF NOT EXISTS analytics_exam_visitors (
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  exam_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (group_name, exam_id, visitor_hash)
);

CREATE INDEX IF NOT EXISTS idx_analytics_exam_group
  ON analytics_exam_visitors(group_name, exam_id);

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
  is_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_managed IN (0, 1)),
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

-- 套卷结构只保存一份 JSON；编程小题引用现有题号，不复制隐藏测试点。
CREATE TABLE IF NOT EXISTS exam_papers (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  result_policy TEXT NOT NULL CHECK (result_policy IN ('immediate', 'after_graded', 'manual')),
  total_score REAL NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exam_papers_group_status
  ON exam_papers(group_name, status, updated_at DESC);

-- 单张套卷可额外准入账号；全局批量注册账号不需要写入此表。
CREATE TABLE IF NOT EXISTS exam_roster (
  exam_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (exam_id, username)
);

CREATE INDEX IF NOT EXISTS idx_exam_roster_username
  ON exam_roster(username, exam_id);

-- 试卷每次修改只新增一个共享版本，历史提交按版本读取，
-- 不需要在每个学生的提交中重复保存整张题面。
CREATE TABLE IF NOT EXISTS exam_versions (
  exam_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  structure_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (exam_id, version)
);

-- 每次整卷提交集中保存答案和评分，避免为每个小题创建多行造成空间膨胀。
-- is_final=1 的记录才参与学生最终成绩；旧版本只用于追溯。
CREATE TABLE IF NOT EXISTS exam_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id TEXT NOT NULL,
  exam_version INTEGER NOT NULL,
  username TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  answers_json TEXT NOT NULL,
  grading_json TEXT NOT NULL,
  auto_score REAL NOT NULL DEFAULT 0,
  manual_score REAL NOT NULL DEFAULT 0,
  total_score REAL NOT NULL DEFAULT 0,
  graded_count INTEGER NOT NULL DEFAULT 0,
  total_parts INTEGER NOT NULL DEFAULT 0,
  grading_status TEXT NOT NULL CHECK (grading_status IN ('pending', 'completed')),
  released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
  -- 管理员使用学生端原界面试做时保留提交，但不计入正式统计。
  is_preview INTEGER NOT NULL DEFAULT 0 CHECK (is_preview IN (0, 1)),
  is_final INTEGER NOT NULL DEFAULT 1 CHECK (is_final IN (0, 1)),
  submitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(exam_id, username, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_submissions_one_final
  ON exam_submissions(exam_id, username, is_preview) WHERE is_final = 1;

CREATE INDEX IF NOT EXISTS idx_exam_submissions_exam_final
  ON exam_submissions(exam_id, is_final, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_exam_submissions_user_final
  ON exam_submissions(username, is_final, submitted_at DESC);

-- 定时答题只保存每个账号在每个开放时段中的最新草稿，避免按键级历史占用空间。
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

-- 测试点变化后的后台重判队列。成功任务会立即删除，只保留待处理或失败任务。
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

CREATE TABLE IF NOT EXISTS resubmission_requests (
  group_name TEXT NOT NULL CHECK (group_name IN ('control', 'vision')),
  problem_id TEXT NOT NULL,
  username TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (group_name, problem_id, username)
);

CREATE INDEX IF NOT EXISTS idx_resubmission_requests_user
  ON resubmission_requests(username, group_name, requested_at DESC);

CREATE TABLE IF NOT EXISTS system_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL CHECK (audience IN ('all', 'user')),
  username TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'message',
  group_name TEXT,
  problem_id TEXT,
  resubmission_key TEXT,
  popup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (popup_enabled IN (0, 1)),
  CHECK ((audience = 'all' AND username IS NULL) OR (audience = 'user' AND username IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_system_messages_created
  ON system_messages(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_system_messages_user
  ON system_messages(username, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_messages_resubmission
  ON system_messages(resubmission_key);

CREATE TABLE IF NOT EXISTS system_message_reads (
  message_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, username)
);

CREATE INDEX IF NOT EXISTS idx_system_message_reads_user
  ON system_message_reads(username, message_id);
