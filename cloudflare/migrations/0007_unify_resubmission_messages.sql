ALTER TABLE system_messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'message';
ALTER TABLE system_messages ADD COLUMN group_name TEXT;
ALTER TABLE system_messages ADD COLUMN problem_id TEXT;
ALTER TABLE system_messages ADD COLUMN resubmission_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_messages_resubmission
  ON system_messages(resubmission_key);

INSERT INTO system_messages (
  audience, username, title, content, created_at,
  message_type, group_name, problem_id, resubmission_key
)
SELECT
  'user', username, '需要重新提交：' || problem_id,
  '管理员要求你重新提交题目 ' || problem_id || '。请修改代码后重新提交判题。',
  requested_at, 'resubmission', group_name, problem_id,
  group_name || ':' || problem_id || ':' || username
FROM resubmission_requests
WHERE 1 = 1
ON CONFLICT(resubmission_key) DO NOTHING;
