-- 限时答卷接入 Cloudflare Queue：记录投递时间与失败次数，避免 Cron 单份串行处理。
ALTER TABLE timed_drafts ADD COLUMN dispatched_at INTEGER;
ALTER TABLE timed_drafts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_timed_drafts_dispatch
  ON timed_drafts(status, dispatched_at, queued_at);
