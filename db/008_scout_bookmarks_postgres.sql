-- Migration 008: scout bookmarks (PostgreSQL)
-- Stores bookmarked players per scout.

CREATE TABLE IF NOT EXISTS scout_bookmarks (
  id            SERIAL PRIMARY KEY,
  scout_wallet  TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  UNIQUE(scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_scout ON scout_bookmarks (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_player ON scout_bookmarks (player_id);
