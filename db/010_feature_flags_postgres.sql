-- Migration 010: feature flags (PostgreSQL)
-- Stores feature flag state.

CREATE TABLE IF NOT EXISTS feature_flags (
  id        SERIAL PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE,
  enabled   BOOLEAN DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags (name);
