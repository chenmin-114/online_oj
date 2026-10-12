-- 可信本地判题节点。节点只持有自身凭证，不持有管理员、GitHub 或 Cloudflare 密钥。
CREATE TABLE IF NOT EXISTS judge_node_pairings (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  requested_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  node_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_judge_node_pairings_expiry
  ON judge_node_pairings(expires_at, used_at);

CREATE TABLE IF NOT EXISTS judge_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT '',
  agent_version TEXT NOT NULL DEFAULT '',
  judge_version TEXT NOT NULL DEFAULT '',
  endpoint_url TEXT NOT NULL DEFAULT '',
  max_slots INTEGER NOT NULL DEFAULT 1,
  busy_slots INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'installing'
    CHECK (status IN ('installing', 'ready', 'paused', 'error', 'revoked')),
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_judge_nodes_active
  ON judge_nodes(status, revoked_at, last_seen_at DESC);
