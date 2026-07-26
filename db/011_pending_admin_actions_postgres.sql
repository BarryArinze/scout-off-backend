-- Migration 011: pending admin actions (PostgreSQL)
-- Tracks pending multi-signature admin actions.

CREATE TABLE IF NOT EXISTS pending_admin_actions (
  id            TEXT PRIMARY KEY,
  action_type   TEXT NOT NULL,
  payload       TEXT NOT NULL,  -- JSON-serialised action data
  status        TEXT NOT NULL,  -- pending, approved, executed
  required_sigs INTEGER NOT NULL,
  collected_sigs INTEGER DEFAULT 0,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_admin_actions_status ON pending_admin_actions (status);
CREATE INDEX IF NOT EXISTS idx_pending_admin_actions_expires ON pending_admin_actions (expires_at);
