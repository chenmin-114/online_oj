CREATE TABLE IF NOT EXISTS system_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL CHECK (audience IN ('all', 'user')),
  username TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((audience = 'all' AND username IS NULL) OR (audience = 'user' AND username IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_system_messages_created
  ON system_messages(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_system_messages_user
  ON system_messages(username, created_at DESC);

CREATE TABLE IF NOT EXISTS system_message_reads (
  message_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, username)
);

CREATE INDEX IF NOT EXISTS idx_system_message_reads_user
  ON system_message_reads(username, message_id);
