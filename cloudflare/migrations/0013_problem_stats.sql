-- 题目列表是高频学生接口，不能在每次加载时重新扫描全部提交记录。
-- 该表在提交与重判时增量维护；首次迁移从现有记录一次性回填。
CREATE TABLE IF NOT EXISTS problem_stats (
  problem_id TEXT PRIMARY KEY,
  total_submissions INTEGER NOT NULL DEFAULT 0,
  accepted_submissions INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK (total_submissions >= 0),
  CHECK (accepted_submissions >= 0 AND accepted_submissions <= total_submissions)
);

INSERT INTO problem_stats (
  problem_id, total_submissions, accepted_submissions, updated_at
)
SELECT
  problem_id,
  COUNT(*),
  SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM submissions
GROUP BY problem_id
ON CONFLICT(problem_id) DO UPDATE SET
  total_submissions = excluded.total_submissions,
  accepted_submissions = excluded.accepted_submissions,
  updated_at = excluded.updated_at;

-- 管理端按题目统计独立提交用户时可直接使用覆盖索引。
CREATE INDEX IF NOT EXISTS idx_submissions_problem_username
  ON submissions(problem_id, username);
