-- Migration 008: scout_bookmarks table (#487)
-- Per-scout player bookmark list. Unique on (scout_wallet, player_id) to prevent duplicates.

CREATE TABLE IF NOT EXISTS scout_bookmarks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_scout  ON scout_bookmarks (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_player ON scout_bookmarks (player_id);
