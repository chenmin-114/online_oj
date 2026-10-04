CREATE TABLE IF NOT EXISTS admin_impersonation_sessions (
  session_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonation_expires
  ON admin_impersonation_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_impersonation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonation_audit_user
  ON admin_impersonation_audit(username, created_at DESC);
