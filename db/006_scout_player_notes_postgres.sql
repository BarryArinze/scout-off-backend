-- Migration 006: scout player notes (PostgreSQL)
-- Stores per-scout notes about players.

CREATE TABLE IF NOT EXISTS scout_player_notes (
  id            SERIAL PRIMARY KEY,
  scout_wallet  TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  note          TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE(scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_player_notes_scout ON scout_player_notes (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_player_notes_player ON scout_player_notes (player_id);
