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
