-- Migration 009: saved searches (PostgreSQL)
-- Stores saved player search filters per scout.

CREATE TABLE IF NOT EXISTS saved_searches (
  id            SERIAL PRIMARY KEY,
  scout_wallet  TEXT NOT NULL,
  name          TEXT NOT NULL,
  filters       TEXT NOT NULL,  -- JSON-serialised search criteria
  created_at    BIGINT NOT NULL,
  UNIQUE(scout_wallet, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_scout ON saved_searches (scout_wallet);
