-- 拉取式多节点调度：max_slots 是节点实际容量，configured_slots 是管理员限制。
ALTER TABLE judge_nodes ADD COLUMN configured_slots INTEGER;
ALTER TABLE judge_nodes ADD COLUMN accepting_jobs INTEGER NOT NULL DEFAULT 1 CHECK (accepting_jobs IN (0, 1));
