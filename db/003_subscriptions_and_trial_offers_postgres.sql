-- Migration 003: subscriptions and trial offers (PostgreSQL)
-- Tracks subscription state and trial offer workflows.

CREATE TABLE IF NOT EXISTS trial_offers (
  id             TEXT PRIMARY KEY,
  scout_wallet   TEXT    NOT NULL,
  player_id      TEXT    NOT NULL,
  state          TEXT    NOT NULL,  -- pending, accepted, rejected, expired
  created_at     BIGINT  NOT NULL,
  responded_at   BIGINT,
  expires_at     BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_offers_scout ON trial_offers (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_trial_offers_player ON trial_offers (player_id);
CREATE INDEX IF NOT EXISTS idx_trial_offers_state ON trial_offers (state);
