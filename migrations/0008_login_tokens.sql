-- One-time login tokens for post-signup redirect
-- These tokens allow cross-domain authentication after signup

CREATE TABLE IF NOT EXISTS login_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_hash ON login_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id);

-- Cleanup old tokens (run periodically)
-- DELETE FROM login_tokens WHERE expires_at < datetime('now', '-1 day');
