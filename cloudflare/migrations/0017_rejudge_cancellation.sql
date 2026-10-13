ALTER TABLE rejudge_queue ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rejudge_queue ADD COLUMN cancelled_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_rejudge_queue_active
ON rejudge_queue(cancel_requested, status, requested_at, id);

CREATE INDEX IF NOT EXISTS idx_rejudge_queue_submission
ON rejudge_queue(submission_kind, submission_id, problem_id, requested_at);
