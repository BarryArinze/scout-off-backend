-- Migration 003: pending_pins table (PostgreSQL)
-- Tracks pending IPFS pins with attempt counts.

CREATE TABLE IF NOT EXISTS pending_pins (
  id        SERIAL PRIMARY KEY,
  hash      TEXT    NOT NULL UNIQUE,
  uri       TEXT    NOT NULL,
  attempts  INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_pins_hash ON pending_pins (hash);
