-- Migration 004: token revocation list (PostgreSQL)
-- Tracks revoked authentication tokens to prevent reuse.

CREATE TABLE IF NOT EXISTS revoked_tokens (
  token_hash    TEXT PRIMARY KEY,
  revoked_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);
